/**
 * DGRP (Daily Gold Rate Protection / "Lock & Key") Routes (Fastify)
 *
 * Implements:
 * 1. Product-specific gold price lock (10% advance).
 * 2. 6 Months EMI for Gold & Diamond, 3 Months EMI for Plain Gold.
 * 3. Shopify Draft Order creation when Razorpay checkout opens.
 * 4. Shopify Order completion (Partially Paid) upon payment verification.
 * 5. Pre-closure discount calculation when gold rate drops.
 * 6. Admin & Customer APIs.
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyAdminRestFetch } = require('../lib/shopify');

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

function normalizeVariantId(variantId = '') {
  const value = String(variantId || '').trim();
  if (!value) return '';
  return value.includes('gid://shopify/ProductVariant/')
    ? value
    : `gid://shopify/ProductVariant/${value}`;
}

function getNumericShopifyId(gid = '') {
  return String(gid || '').match(/\d+$/)?.[0] || '';
}

function asMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function buildDgrpMailingAddress(addr = null) {
  if (!addr) return null;
  const firstName = addr.first_name || addr.firstName || '';
  const lastName = addr.last_name || addr.lastName || '';
  const address1 = addr.address_line || addr.address1 || addr.address || '';
  const address2 = addr.landmark || addr.address2 || '';
  const city = addr.city || '';
  const province = addr.state || addr.province || '';
  const zip = addr.pincode || addr.zip || '';
  const phone = cleanPhone(addr.mobile || addr.phone || '');
  const company = addr.company ? (addr.gstin ? `${addr.company} (GSTIN: ${addr.gstin})` : addr.company) : '';

  return {
    firstName,
    lastName,
    company,
    address1,
    address2,
    city,
    province,
    zip,
    country: 'India',
    phone: phone ? `+91${phone}` : '',
  };
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

  // =========================================================================
  // 1. GET /api/dgrp/config
  // Returns DGRP global settings and current live rates
  // =========================================================================
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

  // =========================================================================
  // 2. POST /api/dgrp/create-advance-order
  // Creates Shopify Draft Order and Razorpay Order for 10% Advance Down Payment
  // =========================================================================
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

      // Determine product type and tenure: 6 months if Gold & Diamond; 3 months if Plain Gold
      const isDiamond = body.is_diamond || product?.is_diamond || false;
      const tenure = isDiamond ? 6 : 3;

      const advancePercent = 10;
      const advanceAmount = Math.round((price * advancePercent) / 100);
      const remainingBalance = price - advanceAmount;
      const monthlyEmi = Math.round(remainingBalance / tenure);
      const effectiveGoldRate = Number(locked_gold_rate) || (await getCurrentGoldRate());

      const amountInSubunits = toSubunits(advanceAmount);
      const receiptId = `dgrp_adv_${Date.now().toString(36)}`;

      // STEP 1: Create Shopify Draft Order with full line item properties & DGRP details
      const lineItemCustomAttributes = [
        { key: "_Shipping Date", value: String(product?.shippingDate || "") },
        { key: "_Gold Price Per Gram", value: String(product?.goldPricePerGram || effectiveGoldRate || "") },
        { key: "_Gold Weight", value: String(product?.goldWeight || product?.metal_weight || "") },
        { key: "_Gold Price", value: String(product?.goldPrice || "") },
        { key: "_Making Charges", value: String(product?.makingCharges || "") },
        { key: "_Diamond Charges", value: String(product?.diamondCharges ?? "0") },
        { key: "_GST", value: String(product?.gst || "") },
        { key: "_Final Price", value: String(price) },
        { key: "_Diamond Total Pcs", value: String(product?.diamondTotalPcs ?? "0") },
        { key: "_Diamond Total Carat", value: String(product?.diamondTotalCarat || product?.diamond_carat || "0") },
        { key: "Color", value: String(product?.color || product?.metal_color || "") },
        { key: "Karat", value: String(product?.karat || product?.metal_purity || "") },
        { key: "Size", value: String(product?.size || "") },
        { key: "Variant Title", value: String(product?.variantTitle || "") },
        { key: "_DGRP Locked Gold Rate", value: `₹${Number(effectiveGoldRate).toLocaleString("en-IN")}/gm` },
        { key: "_DGRP 10% Advance", value: `₹${Number(advanceAmount).toLocaleString("en-IN")}` },
        { key: "_DGRP Monthly Installment", value: `₹${Number(monthlyEmi).toLocaleString("en-IN")} x ${tenure} Months` },
        { key: "_DGRP Tenure", value: `${tenure} Months` },
      ].filter(attr => attr.value !== "" && attr.value !== "undefined");

      const draftLineItem = {
        quantity: 1,
        originalUnitPrice: String(price),
        customAttributes: lineItemCustomAttributes,
      };

      const variantGid = normalizeVariantId(product?.variantId || product?.id);
      if (variantGid && !variantGid.endsWith('/null') && !variantGid.endsWith('/undefined')) {
        draftLineItem.variantId = variantGid;
      } else {
        draftLineItem.title = product?.title || "Jewelry Item";
      }

      // Free Diamond Pendant allocated with DGRP
      const freeGiftLineItem = {
        title: "Free Diamond Pendant (Lock & Key)",
        quantity: 1,
        originalUnitPrice: "0.00",
        appliedDiscount: {
          title: "Free Diamond Pendant (Lock & Key)",
          value: 100,
          valueType: "PERCENTAGE",
        },
        customAttributes: [
          { key: "_DGRP Benefit", value: "Free Diamond Pendant" },
          { key: "Worth", value: "₹15,000" },
        ],
      };

      const mailingAddress = buildDgrpMailingAddress(shipping_address);

      const dgrpTags = ["Razorpay", "DGRP", "Lock & Key", "10% Advance"];
      if (shipping_address?.delivery_method === "pickup") {
        dgrpTags.push("Store Pickup");
      }

      const dgrpCustomAttributes = [
        { key: "payment_gateway", value: "DGRP" },
        { key: "dgrp_plan_type", value: "LOCK_AND_KEY" },
        { key: "dgrp_locked_gold_rate", value: String(effectiveGoldRate) },
        { key: "dgrp_advance_amount", value: String(advanceAmount) },
        { key: "dgrp_monthly_emi", value: String(monthlyEmi) },
        { key: "dgrp_tenure_months", value: String(tenure) },
        { key: "dgrp_total_price", value: String(price) },
        { key: "dgrp_pending_balance", value: String(remainingBalance) },
        { key: "delivery_method", value: shipping_address?.delivery_method || "delivery" },
      ];

      const draftOrderInput = {
        lineItems: [draftLineItem, freeGiftLineItem],
        useCustomerDefaultAddress: false,
        taxExempt: true,
        shippingAddress: mailingAddress,
        billingAddress: mailingAddress,
        customAttributes: dgrpCustomAttributes,
        tags: dgrpTags,
        note: `Order created via Lock & Key (DGRP).\n10% Advance: ₹${Number(advanceAmount).toLocaleString("en-IN")}.\nRemaining Balance: ₹${Number(remainingBalance).toLocaleString("en-IN")} across ${tenure} monthly installments of ₹${Number(monthlyEmi).toLocaleString("en-IN")}.\nLocked 24KT Gold Rate: ₹${Number(effectiveGoldRate).toLocaleString("en-IN")}/gm.`
      };

      const customerEmail = customer?.email || shipping_address?.email;
      if (customerEmail) {
        draftOrderInput.email = customerEmail;
      }

      let draftOrder = null;
      try {
        const shopifyDraftData = await shopifyAdminFetch(`
          mutation draftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder {
                id
                name
                totalPrice
              }
              userErrors {
                field
                message
              }
            }
          }
        `, { input: draftOrderInput });

        if (shopifyDraftData?.draftOrderCreate?.userErrors?.length) {
          request.log.warn('Shopify Draft Order UserErrors in DGRP:', shopifyDraftData.draftOrderCreate.userErrors);
        } else {
          draftOrder = shopifyDraftData?.draftOrderCreate?.draftOrder || null;
          request.log.info(`DGRP Draft Order created: ${draftOrder?.id} (${draftOrder?.name})`);
        }
      } catch (draftErr) {
        request.log.error('Failed to create Shopify Draft Order in DGRP:', draftErr);
      }

      // STEP 2: Create Razorpay Order
      const customerPhone = cleanPhone(customer?.mobile || shipping_address?.mobile || '');
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
            customer_mobile: customerPhone,
            draft_id: draftOrder?.id || '',
            draft_name: draftOrder?.name || '',
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

      // Save pending order session in MongoDB for robust verification
      const db = fastify.mongo?.db;
      if (db) {
        try {
          await db.collection('dgrp_pending_orders').updateOne(
            { razorpay_order_id: razorpayOrder.id },
            {
              $set: {
                receipt_id: receiptId,
                draft_id: draftOrder?.id || null,
                draft_name: draftOrder?.name || null,
                razorpay_order_id: razorpayOrder.id,
                amount_subunits: amountInSubunits,
                advance_amount: advanceAmount,
                product_price: price,
                tenure_months: tenure,
                monthly_installment: monthlyEmi,
                locked_gold_rate: effectiveGoldRate,
                is_diamond: isDiamond,
                customer,
                shipping_address,
                product,
                created_at: new Date()
              }
            },
            { upsert: true }
          );
        } catch (dbErr) {
          request.log.warn('Could not store dgrp_pending_orders record:', dbErr.message);
        }
      }

      return {
        key: keyId,
        orderId: razorpayOrder.id,
        dgrpOrderId: receiptId,
        draftId: draftOrder?.id || null,
        draftOrderName: draftOrder?.name || null,
        amount: amountInSubunits,
        currency: 'INR',
        advance_amount: advanceAmount,
        monthly_installment: monthlyEmi,
        tenure_months: tenure,
        locked_gold_rate: effectiveGoldRate,
        original_price: price,
        receipt: receiptId
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to create advance order' });
    }
  });

  // =========================================================================
  // 3. POST /api/dgrp/verify-advance-payment
  // Verifies signature, completes Shopify Draft Order as Partially Paid, and saves DGRP plan
  // =========================================================================
  fastify.post('/verify-advance-payment', async (request, reply) => {
    try {
      const body = request.body || {};
      const razorpay_order_id = body.razorpay_order_id || body.razorpayOrderId;
      const razorpay_payment_id = body.razorpay_payment_id || body.razorpayPaymentId;
      const razorpay_signature = body.razorpay_signature || body.razorpaySignature;

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

      // Look up pending order from DB if available
      let pendingOrder = null;
      try {
        pendingOrder = await db.collection('dgrp_pending_orders').findOne({ razorpay_order_id });
      } catch (err) {
        request.log.warn('Could not find pending DGRP order:', err.message);
      }

      const planData = body.plan_data || pendingOrder || {};
      const tenure = Number(planData.tenure_months || pendingOrder?.tenure_months || (planData.is_diamond ? 6 : 3) || 3);
      const price = Number(planData.original_price || planData.product_price || pendingOrder?.product_price || 0);
      const advanceAmount = Number(planData.advance_amount || pendingOrder?.advance_amount || Math.round(price * 0.10));
      const monthlyEmi = Number(planData.monthly_installment || pendingOrder?.monthly_installment || Math.round((price - advanceAmount) / tenure));
      const draftId = body.draftId || planData.draftId || pendingOrder?.draft_id || null;

      const planCode = `DGRP-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

      // STEP 1: Complete Shopify Draft Order into a Shopify Order marked Partially Paid
      let shopifyOrder = null;
      if (draftId) {
        try {
          // Update draft order note attributes with verified payment details
          await shopifyAdminFetch(`
            mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
              draftOrderUpdate(id: $id, input: $input) {
                draftOrder {
                  id
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `, {
            id: draftId,
            input: {
              customAttributes: [
                { key: "payment_gateway", value: "DGRP" },
                { key: "razorpay_order_id", value: String(razorpay_order_id) },
                { key: "razorpay_payment_id", value: String(razorpay_payment_id) },
                { key: "dgrp_plan_code", value: planCode },
                { key: "dgrp_advance_amount", value: String(advanceAmount) },
                { key: "dgrp_pending_balance", value: String(price - advanceAmount) },
                { key: "dgrp_monthly_emi", value: String(monthlyEmi) },
                { key: "dgrp_tenure_months", value: String(tenure) },
                { key: "dgrp_locked_gold_rate", value: String(planData.locked_gold_rate || pendingOrder?.locked_gold_rate || "") },
              ]
            }
          });

          // Complete the Draft Order with paymentPending: true so it's created as Partially Paid / Payment Pending
          const completeRes = await shopifyAdminFetch(`
            mutation draftOrderComplete($id: ID!, $paymentPending: Boolean) {
              draftOrderComplete(id: $id, paymentPending: $paymentPending) {
                draftOrder {
                  id
                  order {
                    id
                    name
                    totalPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `, { id: draftId, paymentPending: true });

          const completedOrder = completeRes?.draftOrderComplete?.draftOrder?.order;
          if (completedOrder) {
            shopifyOrder = completedOrder;
            request.log.info(`DGRP Draft Order ${draftId} completed into Order: ${completedOrder.name}`);

            // Record manual payment for the 10% advance so financial status is "Partially paid"
            try {
              await shopifyAdminFetch(`
                mutation orderCreateManualPayment($id: ID!, $amount: MoneyInput, $paymentMethodName: String, $processedAt: DateTime) {
                  orderCreateManualPayment(
                    id: $id,
                    amount: $amount,
                    paymentMethodName: $paymentMethodName,
                    processedAt: $processedAt
                  ) {
                    order {
                      id
                      displayFinancialStatus
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `, {
                id: completedOrder.id,
                amount: {
                  amount: asMoney(advanceAmount),
                  currencyCode: "INR",
                },
                paymentMethodName: `Razorpay DGRP 10% Advance (${razorpay_payment_id})`,
                processedAt: new Date().toISOString(),
              }, "2026-01");
            } catch (manualPayErr) {
              request.log.warn('GraphQL orderCreateManualPayment failed, trying REST:', manualPayErr.message);
              const numericOrderId = getNumericShopifyId(completedOrder.id);
              if (numericOrderId) {
                await shopifyAdminRestFetch(
                  `orders/${numericOrderId}/transactions.json`,
                  {},
                  {
                    method: "POST",
                    body: {
                      transaction: {
                        kind: "sale",
                        status: "success",
                        amount: asMoney(advanceAmount),
                        currency: "INR",
                        gateway: "Razorpay",
                        authorization: razorpay_payment_id,
                        source_name: "external",
                        message: `10% Advance captured via Razorpay (${razorpay_payment_id})`,
                      },
                    },
                  }
                ).catch(e => request.log.warn('REST transaction fallback failed:', e.message));
              }
            }
          }
        } catch (draftErr) {
          request.log.error('Error completing draft order in DGRP:', draftErr);
        }
      }

      // STEP 2: Generate Installments schedule & Save Plan in MongoDB
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

      const shippingAddress = planData.shipping_address || pendingOrder?.shipping_address || {};
      const customerObj = planData.customer || pendingOrder?.customer || {};
      const customerMobile = cleanPhone(
        customerObj.mobile ||
        shippingAddress.mobile ||
        customerObj.phone || ''
      );

      const productObj = planData.product || pendingOrder?.product || {};

      const dgrpDoc = {
        plan_code: planCode,
        shopify_draft_order_id: draftId,
        shopify_order_id: shopifyOrder?.id || null,
        shopify_order_name: shopifyOrder?.name || null,
        customer: {
          user_id: customerObj.user_id || customerObj.id || null,
          email: customerObj.email || shippingAddress.email || '',
          mobile: customerMobile,
          first_name: shippingAddress.first_name || customerObj.first_name || '',
          last_name: shippingAddress.last_name || customerObj.last_name || ''
        },
        shipping_address: {
          delivery_method: shippingAddress.delivery_method || 'delivery',
          is_company: !!shippingAddress.is_company,
          first_name: shippingAddress.first_name || '',
          last_name: shippingAddress.last_name || '',
          address_line: shippingAddress.address_line || shippingAddress.address || '',
          landmark: shippingAddress.landmark || '',
          city: shippingAddress.city || '',
          state: shippingAddress.state || '',
          pincode: shippingAddress.pincode || '',
          country: shippingAddress.country || 'India',
          mobile: customerMobile,
          email: shippingAddress.email || customerObj.email || ''
        },
        product: {
          product_id: productObj.id || productObj.product_id || productObj.shopifyId || '',
          variant_id: productObj.variantId || productObj.variant_id || '',
          title: productObj.title || 'Jewelry Piece',
          image: productObj.image || '',
          sku: productObj.sku || '',
          metal_purity: productObj.karat || productObj.metal_purity || '18KT',
          metal_color: productObj.color || productObj.metal_color || 'Yellow Gold',
          metal_weight: Number(productObj.goldWeight || productObj.metal_weight || 2.5),
          diamond_carat: Number(productObj.diamondTotalCarat || productObj.diamond_carat || 0),
          product_type: (planData.is_diamond || pendingOrder?.is_diamond) ? 'gold_diamond' : 'gold_only'
        },
        financials: {
          locked_gold_rate: Number(planData.locked_gold_rate || pendingOrder?.locked_gold_rate || (await getCurrentGoldRate())),
          original_product_price: price,
          advance_percentage: 10,
          advance_amount: advanceAmount,
          installment_tenure_months: tenure,
          monthly_installment: monthlyEmi,
          total_paid: advanceAmount,
          amount_pending: price - advanceAmount,
          status: 'active'
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
        shopify_order_id: shopifyOrder?.id || null,
        shopify_order_name: shopifyOrder?.name || null,
        message: 'Lock & Key plan successfully enrolled!'
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to verify and save plan' });
    }
  });

  // =========================================================================
  // 4. GET /api/dgrp/user-plans
  // =========================================================================
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
        gold_savings: goldSavings,
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
        gold_savings: goldSavings,
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
