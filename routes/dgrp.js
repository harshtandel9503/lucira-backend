/**
 * DGRP (Daily Gold Rate Protection / "Lock & Key") Routes (Fastify)
 *
 * Implements:
 * 1. Product-specific gold price lock (10% advance).
 * 2. 6 Months EMI for Gold & Diamond, 3 Months EMI for Plain Gold.
 * 3. Razorpay payment creation & verification for Advance, Installments, and Pre-closure.
 * 4. Pre-closure discount calculation when gold rate drops.
 * 5. Admin & Customer APIs.
 */

const crypto = require('crypto');

function toSubunits(amount) {
  const numericAmount = Number(amount || 0);
  return Math.round(numericAmount * 100);
}

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

module.exports = async function (fastify) {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

  // Helper: Verify Razorpay Standard Order Signature
  function verifyRazorpaySignature(orderId, paymentId, signature) {
    if (!orderId || !paymentId || !signature) return false;
    const bodyStr = `${orderId}|${paymentId}`;
    const expected = crypto.createHmac('sha256', keySecret).update(bodyStr).digest('hex');
    return expected === signature;
  }

  // Helper: Fetch current 24k gold rate
  async function getCurrentGoldRate() {
    try {
      const db = fastify.mongo?.db;
      if (!db) return 15802;
      const rates = await db.collection('rates').findOne({ _id: 'global-rates' });
      const rate = rates?.gold_price_24k || rates?.gold_price_18k || 15802;
      return Number(rate) || 15802;
    } catch (e) {
      return 15802;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. GET /api/dgrp/config
  // Returns DGRP global settings and current live rates
  // ──────────────────────────────────────────────────────────────────────────
  fastify.get('/config', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      let settings = null;
      if (db) {
        settings = await db.collection('dgrp_settings').findOne({ _id: 'global-dgrp-settings' });
      }

      const currentRate = await getCurrentGoldRate();

      const defaultSettings = {
        enabled: true,
        advance_percentage: 10,
        gold_diamond_tenure_months: 6,
        plain_gold_tenure_months: 3,
        free_gift_title: "Free Diamond Pendant",
        free_gift_value: 15000,
        terms: [
          "Lock 24KT/18KT/14KT gold rate for the selected jewelry with just 10% down payment.",
          "If gold rate increases, you pay only the locked rate.",
          "If gold rate decreases, you can pre-close at the lower gold rate with savings applied directly to pending balance.",
          "No penalty on early pre-closure."
        ]
      };

      return {
        ...defaultSettings,
        ...(settings || {}),
        current_gold_rate_24k: currentRate,
        current_rate_timestamp: new Date().toISOString()
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch DGRP configuration' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. POST /api/dgrp/create-advance-order
  // Creates Razorpay Order for 10% Advance Down Payment
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/create-advance-order', async (request, reply) => {
    try {
      const body = request.body || {};
      const {
        product,
        product_price,
        locked_gold_rate,
        customer,
        shipping_address
      } = body;

      const price = Number(product_price || 0);
      if (!price || price <= 0) {
        return reply.code(400).send({ error: 'Valid product price is required' });
      }

      // Determine product type and tenure
      // 6 months if Gold & Diamond; 3 months if Plain Gold
      const isDiamond = body.is_diamond || product?.is_diamond || false;
      const tenure = isDiamond ? 6 : 3;

      const advancePercent = 10;
      const advanceAmount = Math.round((price * advancePercent) / 100);
      const remainingBalance = price - advanceAmount;
      const monthlyEmi = Math.round(remainingBalance / tenure);

      const amountInSubunits = toSubunits(advanceAmount);

      const receiptId = `dgrp_adv_${Date.now().toString(36)}`;

      // Create Razorpay Order
      const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: 'INR',
          receipt: receiptId,
          notes: {
            plan_type: 'DGRP_ADVANCE',
            product_title: product?.title || 'Jewelry Piece',
            tenure_months: String(tenure),
            customer_mobile: cleanPhone(customer?.mobile || shipping_address?.mobile || '')
          }
        }),
      });

      if (!razorpayRes.ok) {
        const errorData = await razorpayRes.json();
        request.log.error('Razorpay Order Error:', errorData);
        return reply.code(500).send({
          error: 'Payment gateway error',
          message: errorData?.error?.description || 'Failed to initialize payment'
        });
      }

      const razorpayOrder = await razorpayRes.json();

      return {
        key: keyId,
        orderId: razorpayOrder.id,
        amount: amountInSubunits,
        currency: 'INR',
        advance_amount: advanceAmount,
        monthly_installment: monthlyEmi,
        tenure_months: tenure,
        locked_gold_rate: Number(locked_gold_rate) || (await getCurrentGoldRate()),
        original_price: price,
        receipt: receiptId
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to create advance order' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. POST /api/dgrp/verify-advance-payment
  // Verifies signature and creates the DGRP plan in MongoDB
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/verify-advance-payment', async (request, reply) => {
    try {
      const body = request.body || {};
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        plan_data
      } = body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return reply.code(400).send({ error: 'Missing payment signature or details' });
      }

      // Verify Razorpay signature
      const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!isValid) {
        return reply.code(400).send({ error: 'Invalid payment signature' });
      }

      const db = fastify.mongo?.db;
      if (!db) {
        return reply.code(500).send({ error: 'Database connection unavailable' });
      }

      const tenure = Number(plan_data.tenure_months || (plan_data.is_diamond ? 6 : 3));
      const price = Number(plan_data.original_price || 0);
      const advanceAmount = Number(plan_data.advance_amount || Math.round(price * 0.10));
      const monthlyEmi = Number(plan_data.monthly_installment || Math.round((price - advanceAmount) / tenure));

      // Generate Installments schedule
      const now = new Date();
      const installments = [
        {
          installment_number: 0,
          label: '10% Advance',
          due_date: now,
          amount: advanceAmount,
          status: 'paid',
          paid_at: now,
          razorpay_order_id,
          razorpay_payment_id
        }
      ];

      for (let i = 1; i <= tenure; i++) {
        const dueDate = new Date(now);
        dueDate.setMonth(dueDate.getMonth() + i);

        const suffix = (i === 1) ? '1st' : (i === 2) ? '2nd' : (i === 3) ? '3rd' : `${i}th`;
        installments.push({
          installment_number: i,
          label: `${suffix} Installment`,
          due_date: dueDate,
          amount: monthlyEmi,
          status: 'pending',
          paid_at: null,
          razorpay_order_id: null,
          razorpay_payment_id: null
        });
      }

      const planCode = `DGRP-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      const customerMobile = cleanPhone(
        plan_data.customer?.mobile ||
        plan_data.shipping_address?.mobile ||
        plan_data.customer?.phone || ''
      );

      const dgrpDoc = {
        plan_code: planCode,
        customer: {
          user_id: plan_data.customer?.user_id || plan_data.customer?.id || null,
          email: plan_data.customer?.email || plan_data.shipping_address?.email || '',
          mobile: customerMobile,
          first_name: plan_data.shipping_address?.first_name || plan_data.customer?.first_name || '',
          last_name: plan_data.shipping_address?.last_name || plan_data.customer?.last_name || ''
        },
        shipping_address: {
          delivery_method: plan_data.shipping_address?.delivery_method || 'delivery',
          is_company: !!plan_data.shipping_address?.is_company,
          first_name: plan_data.shipping_address?.first_name || '',
          last_name: plan_data.shipping_address?.last_name || '',
          address_line: plan_data.shipping_address?.address_line || plan_data.shipping_address?.address || '',
          landmark: plan_data.shipping_address?.landmark || '',
          city: plan_data.shipping_address?.city || '',
          state: plan_data.shipping_address?.state || '',
          pincode: plan_data.shipping_address?.pincode || '',
          country: plan_data.shipping_address?.country || 'India',
          mobile: customerMobile,
          email: plan_data.shipping_address?.email || plan_data.customer?.email || ''
        },
        product: {
          product_id: plan_data.product?.id || plan_data.product?.shopifyId || '',
          variant_id: plan_data.product?.variantId || plan_data.product?.activeVariantId || '',
          title: plan_data.product?.title || 'Jewelry Piece',
          image: plan_data.product?.image || '',
          sku: plan_data.product?.sku || '',
          metal_purity: plan_data.product?.metal_purity || '18KT',
          metal_color: plan_data.product?.metal_color || 'Yellow Gold',
          metal_weight: Number(plan_data.product?.metal_weight || 2.5),
          diamond_carat: Number(plan_data.product?.diamond_carat || 0),
          product_type: plan_data.is_diamond ? 'gold_diamond' : 'gold_only'
        },
        financials: {
          locked_gold_rate: Number(plan_data.locked_gold_rate || (await getCurrentGoldRate())),
          original_product_price: price,
          advance_percentage: 10,
          advance_amount: advanceAmount,
          installment_tenure_months: tenure,
          monthly_installment: monthlyEmi,
          total_paid: advanceAmount,
          amount_pending: price - advanceAmount,
          status: 'active' // 'active' | 'completed' | 'pre_closed' | 'overdue' | 'cancelled'
        },
        installments,
        pre_closure: {
          is_preclosed: false,
          preclosed_at: null,
          closing_gold_rate: null,
          gold_savings_applied: 0,
          preclose_paid_amount: 0
        },
        free_gift: {
          eligible: true,
          title: 'Free Diamond Pendant',
          value: 15000,
          status: 'allocated'
        },
        created_at: now,
        updated_at: now
      };

      const result = await db.collection('dgrp_plans').insertOne(dgrpDoc);

      return {
        success: true,
        plan_id: result.insertedId,
        plan_code: planCode,
        message: 'Lock & Key plan successfully enrolled!'
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to verify and save plan' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. GET /api/dgrp/user-plans
  // Fetches customer's active and completed plans with live rates comparison
  // ──────────────────────────────────────────────────────────────────────────
  fastify.get('/user-plans', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const { mobile, email, user_id } = request.query;
      const cleanMob = cleanPhone(mobile);

      const filterConditions = [];
      if (cleanMob) filterConditions.push({ 'customer.mobile': cleanMob });
      if (email) filterConditions.push({ 'customer.email': email.toLowerCase().trim() });
      if (user_id) filterConditions.push({ 'customer.user_id': user_id });

      if (filterConditions.length === 0) {
        return reply.code(400).send({ error: 'Customer identifier (mobile/email/user_id) is required' });
      }

      const plans = await db.collection('dgrp_plans')
        .find({ $or: filterConditions })
        .sort({ created_at: -1 })
        .toArray();

      const currentGoldRate = await getCurrentGoldRate();

      // Decorate with live comparisons
      const decorated = plans.map(p => {
        const lockedRate = p.financials.locked_gold_rate || currentGoldRate;
        const rateDiff = currentGoldRate - lockedRate;
        const metalWeight = Number(p.product?.metal_weight || 0);

        // If today rate is LOWER: Customer can save if they pre-close
        // If today rate is HIGHER: Customer has already protected/saved that much!
        const protectedBenefitPerGm = rateDiff > 0 ? rateDiff : 0;
        const potentialSavingsIfPreclosed = rateDiff < 0 ? Math.round(Math.abs(rateDiff) * metalWeight) : 0;

        // Next pending installment
        const nextPending = p.installments?.find(ins => ins.status === 'pending') || null;

        return {
          ...p,
          live_metrics: {
            today_gold_rate: currentGoldRate,
            locked_gold_rate: lockedRate,
            protected_benefit_per_gm: protectedBenefitPerGm,
            rate_difference: rateDiff,
            potential_preclose_savings: potentialSavingsIfPreclosed,
            next_installment: nextPending
          }
        };
      });

      return {
        plans: decorated,
        count: decorated.length,
        current_gold_rate_24k: currentGoldRate
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch customer plans' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. POST /api/dgrp/installment/create-order
  // Creates Razorpay Order for a specific Monthly Installment
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/installment/create-order', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const { plan_id, installment_number } = request.body || {};
      if (!plan_id || installment_number === undefined) {
        return reply.code(400).send({ error: 'plan_id and installment_number are required' });
      }

      const { ObjectId } = require('mongodb');
      const plan = await db.collection('dgrp_plans').findOne({ _id: new ObjectId(String(plan_id)) });

      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const ins = plan.installments?.find(i => Number(i.installment_number) === Number(installment_number));
      if (!ins) return reply.code(404).send({ error: 'Installment not found' });
      if (ins.status === 'paid') return reply.code(400).send({ error: 'Installment is already paid' });

      const amountInSubunits = toSubunits(ins.amount);
      const receiptId = `dgrp_emi_${plan.plan_code}_${installment_number}`;

      const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: 'INR',
          receipt: receiptId,
          notes: {
            plan_code: plan.plan_code,
            installment_number: String(installment_number),
            installment_label: ins.label
          }
        }),
      });

      if (!razorpayRes.ok) {
        const errorData = await razorpayRes.json();
        return reply.code(500).send({ error: 'Failed to create payment order', details: errorData });
      }

      const razorpayOrder = await razorpayRes.json();

      return {
        key: keyId,
        orderId: razorpayOrder.id,
        amount: amountInSubunits,
        currency: 'INR',
        plan_id,
        installment_number,
        amount_in_rupees: ins.amount,
        label: ins.label
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to create installment order' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. POST /api/dgrp/installment/verify
  // Verifies payment of monthly installment and updates schedule
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/installment/verify', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const {
        plan_id,
        installment_number,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      } = request.body || {};

      const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!isValid) return reply.code(400).send({ error: 'Invalid payment signature' });

      const { ObjectId } = require('mongodb');
      const plan = await db.collection('dgrp_plans').findOne({ _id: new ObjectId(String(plan_id)) });
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const updatedInstallments = plan.installments.map(ins => {
        if (Number(ins.installment_number) === Number(installment_number)) {
          return {
            ...ins,
            status: 'paid',
            paid_at: new Date(),
            razorpay_order_id,
            razorpay_payment_id
          };
        }
        return ins;
      });

      const totalPaid = updatedInstallments
        .filter(ins => ins.status === 'paid')
        .reduce((sum, ins) => sum + Number(ins.amount || 0), 0);

      const allPaid = updatedInstallments.every(ins => ins.status === 'paid');
      const newStatus = allPaid ? 'completed' : 'active';
      const pending = Math.max(0, plan.financials.original_product_price - totalPaid);

      await db.collection('dgrp_plans').updateOne(
        { _id: new ObjectId(String(plan_id)) },
        {
          $set: {
            installments: updatedInstallments,
            'financials.total_paid': totalPaid,
            'financials.amount_pending': pending,
            'financials.status': newStatus,
            updated_at: new Date()
          }
        }
      );

      return {
        success: true,
        message: 'Installment payment recorded successfully',
        status: newStatus,
        total_paid: totalPaid,
        amount_pending: pending
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to verify installment' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. POST /api/dgrp/preclose/calculate
  // Calculates dynamic pre-closure discount based on current rate vs locked rate
  // (Directly implements the formula from Image 2 handwritten notes)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/preclose/calculate', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const { plan_id } = request.body || {};
      if (!plan_id) return reply.code(400).send({ error: 'plan_id is required' });

      const { ObjectId } = require('mongodb');
      const plan = await db.collection('dgrp_plans').findOne({ _id: new ObjectId(String(plan_id)) });
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const currentGoldRate = await getCurrentGoldRate();
      const lockedRate = plan.financials.locked_gold_rate || currentGoldRate;
      const metalWeight = Number(plan.product?.metal_weight || 0);
      const originalPrice = Number(plan.financials.original_product_price || 0);
      const totalPaid = Number(plan.financials.total_paid || 0);

      let goldSavings = 0;
      let newPrice = originalPrice;

      // If current gold rate dropped below locked rate:
      if (currentGoldRate < lockedRate) {
        const rateDrop = lockedRate - currentGoldRate;
        goldSavings = Math.round(metalWeight * rateDrop);
        newPrice = Math.max(0, originalPrice - goldSavings);
      }

      const pendingToPay = Math.max(0, newPrice - totalPaid);

      return {
        plan_id,
        plan_code: plan.plan_code,
        locked_gold_rate: lockedRate,
        today_gold_rate: currentGoldRate,
        metal_weight_grams: metalWeight,
        original_price: originalPrice,
        gold_savings,
        adjusted_price: newPrice,
        total_paid_so_far: totalPaid,
        pending_preclose_amount: pendingToPay,
        can_preclose: plan.financials.status === 'active' && pendingToPay > 0
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to calculate pre-closure' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. POST /api/dgrp/preclose/create-order
  // Creates Razorpay Order for pre-closure amount
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/preclose/create-order', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const { plan_id } = request.body || {};
      const { ObjectId } = require('mongodb');
      const plan = await db.collection('dgrp_plans').findOne({ _id: new ObjectId(String(plan_id)) });
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const currentGoldRate = await getCurrentGoldRate();
      const lockedRate = plan.financials.locked_gold_rate || currentGoldRate;
      const metalWeight = Number(plan.product?.metal_weight || 0);
      const originalPrice = Number(plan.financials.original_product_price || 0);
      const totalPaid = Number(plan.financials.total_paid || 0);

      let goldSavings = 0;
      let newPrice = originalPrice;
      if (currentGoldRate < lockedRate) {
        goldSavings = Math.round(metalWeight * (lockedRate - currentGoldRate));
        newPrice = Math.max(0, originalPrice - goldSavings);
      }

      const pendingAmount = Math.max(0, newPrice - totalPaid);
      if (pendingAmount <= 0) {
        return reply.code(400).send({ error: 'Plan is already fully paid' });
      }

      const amountInSubunits = toSubunits(pendingAmount);
      const receiptId = `dgrp_preclose_${plan.plan_code}`;

      const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: 'INR',
          receipt: receiptId,
          notes: {
            plan_code: plan.plan_code,
            action: 'PRE_CLOSURE',
            gold_savings: String(goldSavings)
          }
        }),
      });

      if (!razorpayRes.ok) {
        const errorData = await razorpayRes.json();
        return reply.code(500).send({ error: 'Failed to create preclose order', details: errorData });
      }

      const razorpayOrder = await razorpayRes.json();

      return {
        key: keyId,
        orderId: razorpayOrder.id,
        amount: amountInSubunits,
        currency: 'INR',
        plan_id,
        pending_amount: pendingAmount,
        gold_savings,
        adjusted_price: newPrice
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to create preclose order' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. POST /api/dgrp/preclose/verify
  // Verifies signature, marks plan pre-closed & ready for fulfillment
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/preclose/verify', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const {
        plan_id,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        gold_savings,
        amount_paid
      } = request.body || {};

      const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!isValid) return reply.code(400).send({ error: 'Invalid payment signature' });

      const { ObjectId } = require('mongodb');
      const plan = await db.collection('dgrp_plans').findOne({ _id: new ObjectId(String(plan_id)) });
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const currentGoldRate = await getCurrentGoldRate();

      // Mark all remaining installments as pre_closed
      const updatedInstallments = plan.installments.map(ins => {
        if (ins.status !== 'paid') {
          return {
            ...ins,
            status: 'pre_closed',
            paid_at: new Date()
          };
        }
        return ins;
      });

      const totalPaidFinal = Number(plan.financials.total_paid || 0) + Number(amount_paid || 0);

      await db.collection('dgrp_plans').updateOne(
        { _id: new ObjectId(String(plan_id)) },
        {
          $set: {
            installments: updatedInstallments,
            'financials.total_paid': totalPaidFinal,
            'financials.amount_pending': 0,
            'financials.status': 'pre_closed',
            pre_closure: {
              is_preclosed: true,
              preclosed_at: new Date(),
              closing_gold_rate: currentGoldRate,
              gold_savings_applied: Number(gold_savings || 0),
              preclose_paid_amount: Number(amount_paid || 0),
              razorpay_order_id,
              razorpay_payment_id
            },
            updated_at: new Date()
          }
        }
      );

      return {
        success: true,
        message: 'Plan successfully pre-closed at lowest gold rate!',
        status: 'pre_closed'
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to verify pre-closure' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 10. ADMIN ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  // GET /api/dgrp/admin/stats — Analytics & KPIs for dashboard
  fastify.get('/admin/stats', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const plansCollection = db.collection('dgrp_plans');

      const totalPlans = await plansCollection.countDocuments();
      const activePlans = await plansCollection.countDocuments({ 'financials.status': 'active' });
      const completedPlans = await plansCollection.countDocuments({ 'financials.status': 'completed' });
      const preclosedPlans = await plansCollection.countDocuments({ 'financials.status': 'pre_closed' });

      const aggregation = await plansCollection.aggregate([
        {
          $group: {
            _id: null,
            totalLockedValue: { $sum: '$financials.original_product_price' },
            totalAdvanceCollected: { $sum: '$financials.advance_amount' },
            totalCollected: { $sum: '$financials.total_paid' },
            totalPending: { $sum: '$financials.amount_pending' }
          }
        }
      ]).toArray();

      const stats = aggregation[0] || {
        totalLockedValue: 0,
        totalAdvanceCollected: 0,
        totalCollected: 0,
        totalPending: 0
      };

      return {
        total_plans: totalPlans,
        active_plans: activePlans,
        completed_plans: completedPlans,
        preclosed_plans: preclosedPlans,
        total_locked_value: stats.totalLockedValue,
        total_advance_collected: stats.totalAdvanceCollected,
        total_collected: stats.totalCollected,
        total_pending: stats.totalPending
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // GET /api/dgrp/admin/plans — Filterable, paginated table of plans
  fastify.get('/admin/plans', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const {
        status,
        search,
        page = 1,
        limit = 20
      } = request.query;

      const query = {};

      if (status && status !== 'all') {
        query['financials.status'] = status;
      }

      if (search && search.trim()) {
        const s = search.trim();
        query.$or = [
          { plan_code: { $regex: s, $options: 'i' } },
          { 'customer.mobile': { $regex: s, $options: 'i' } },
          { 'customer.email': { $regex: s, $options: 'i' } },
          { 'customer.first_name': { $regex: s, $options: 'i' } },
          { 'product.title': { $regex: s, $options: 'i' } }
        ];
      }

      const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

      const [plans, total] = await Promise.all([
        db.collection('dgrp_plans')
          .find(query)
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(Number(limit))
          .toArray(),
        db.collection('dgrp_plans').countDocuments(query)
      ]);

      return {
        plans,
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit))
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // PATCH /api/dgrp/admin/plans/:id/status — Update fulfillment / order status
  fastify.patch('/admin/plans/:id/status', async (request, reply) => {
    try {
      const db = fastify.mongo?.db;
      if (!db) return reply.code(500).send({ error: 'Database unavailable' });

      const { id } = request.params;
      const { status, note } = request.body || {};

      const { ObjectId } = require('mongodb');
      await db.collection('dgrp_plans').updateOne(
        { _id: new ObjectId(String(id)) },
        {
          $set: {
            'financials.status': status,
            admin_note: note || '',
            updated_at: new Date()
          }
        }
      );

      return { success: true, message: 'Status updated' };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message });
    }
  });
};
