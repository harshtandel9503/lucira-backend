/**
 * Checkout and Payment Routes (Fastify)
 * Handles Razorpay and checkout webhooks
 */

const crypto = require('crypto');
const { shopifyAdminFetch, shopifyAdminRestFetch } = require('../lib/shopify');
const { repriceItems } = require('../lib/cartPricing');

function toSubunits(amount) {
  const numericAmount = Number(amount || 0);
  return Math.round(numericAmount * 100);
}

function buildPaymentMethod(body = {}, draftTotal = 0) {
  const method = body?.paymentMethod || {};
  const requestedType = method?.type === "partial_cod" ? "partial_cod" : "razorpay";
  const grandTotal = Number(draftTotal || 0);

  // Fallback to full payment if total is invalid
  if (grandTotal <= 0) {
    return { type: "razorpay", prepaidAmount: 0, codAmount: 0, grandTotal: 0 };
  }

  // BUSINESS RULE: Partial COD is only allowed if Grand Total <= ₹50,000.
  // Split: 20% Advance (Prepaid), 80% COD.
  const MAX_PARTIAL_COD_TOTAL = 50000;

  if (requestedType !== "partial_cod" || grandTotal > MAX_PARTIAL_COD_TOTAL) {
    return {
      type: "razorpay",
      prepaidAmount: grandTotal,
      codAmount: 0,
      grandTotal,
    };
  }

  const prepaidAmount = Math.round(grandTotal * 0.2);
  const codAmount = grandTotal - prepaidAmount;

  return {
    type: "partial_cod",
    prepaidAmount,
    codAmount,
    grandTotal,
  };
}

function normalizeVariantId(variantId = "") {
  const value = String(variantId || "").trim();
  if (!value) return "";
  return value.includes("gid://shopify/ProductVariant/")
    ? value
    : `gid://shopify/ProductVariant/${value}`;
}

function getNumericShopifyId(gid = "") {
  return String(gid || "").match(/\d+$/)?.[0] || "";
}

function asMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function normalizePhone(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return value.startsWith("+") ? value : `+${digits}`;
}

function formatCompanyWithGstin(company = "", gstin = "") {
  const trimmedCompany = String(company || "").trim();
  const trimmedGstin = String(gstin || "").trim().toUpperCase();

  if (trimmedCompany && trimmedGstin) {
    return `${trimmedCompany} | GSTIN: ${trimmedGstin}`;
  }

  if (trimmedGstin) {
    return `GSTIN: ${trimmedGstin}`;
  }

  return trimmedCompany;
}

function buildMailingAddress(address = null) {
  if (!address) return null;

  return {
    firstName: address.firstName || "",
    lastName: address.lastName || "",
    company: formatCompanyWithGstin(address.company, address.gstin),
    address1: address.address1 || "",
    address2: address.address2 || "",
    city: address.city || "",
    province: address.province || "",
    zip: address.zip || "",
    country: address.country || "",
    phone: normalizePhone(address.phone || ""),
  };
}

function buildRestMailingAddress(address = null) {
  if (!address) return null;

  return {
    first_name: address.firstName || "",
    last_name: address.lastName || "",
    company: formatCompanyWithGstin(address.company, address.gstin),
    address1: address.address1 || "",
    address2: address.address2 || "",
    city: address.city || "",
    province: address.province || "",
    zip: String(address.zip || ""),
    country: address.country || "",
    phone: normalizePhone(address.phone || ""),
  };
}

function buildLineItemProperties(item = {}) {
  const pairs = [
    ["EngravingText", item.engravingText || item.engraving || ""],
    ["EngravingFont", item.engravingFont || ""],
    ["GiftText", item.giftText || ""],
    ["_Shipping Date", item.shippingDate || ""],
    ["_Gold Price Per Gram", item.goldPricePerGram],
    ["_Gold Weight", item.goldWeight],
    ["_Gold Price", item.goldPrice],
    ["_Making Charges", item.makingCharges],
    ["_Diamond Charges", item.diamondCharges],
    ["_GST", item.gst],
    ["_Final Price", item.finalPrice || item.price],
    ["_Diamond Total Pcs", item.diamondTotalPcs],
    ["_Diamond Total Carat", item.diamondCarat],
    ["Color", item.color || ""],
    ["Karat", item.karat || ""],
    ["Size", item.size || ""],
    ["Variant Title", item.variantTitle || ""],
    ["_gclid", item.gclid || ""],
  ];

  if (item.properties && typeof item.properties === 'object') {
    for (const [k, v] of Object.entries(item.properties)) {
      pairs.push([k, v]);
    }
  }

  return pairs
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => ({
      key,
      value: String(value),
    }));
}

function buildRestLineItemProperties(item = {}) {
  return buildLineItemProperties(item).map(({ key, value }) => ({
    name: key,
    value,
  }));
}

// The full set of UTM params captured off the landing URL. Whitelisted rather
// than spread, so a crafted link can't write arbitrary keys onto a real order.
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

function normalizeUtms(raw) {
  if (!raw || typeof raw !== "object") return {};
  const utms = {};
  for (const key of UTM_KEYS) {
    const value = String(raw[key] ?? "").trim();
    if (value) utms[key] = value;
  }
  return utms;
}

function buildOrderCustomAttributes({
  shippingAddress,
  billingAddress,
  razorpayOrderId,
  razorpayPaymentId,
  appliedCoupon,
  nectorPoints,
  paymentMethod,
  gclid,
  utm,
}) {
  const utms = normalizeUtms(utm);

  const pairs = [
    ["payment_gateway", paymentMethod?.type === "partial_cod" ? "Partial COD" : "Razorpay"],
    ["razorpay_order_id", razorpayOrderId],
    ["razorpay_payment_id", razorpayPaymentId],
    ["gclid", gclid || ""],
    ...UTM_KEYS.map((key) => [key, utms[key] || ""]),
    ["partial_cod_prepaid_amount", paymentMethod?.type === "partial_cod" ? paymentMethod.prepaidAmount : ""],
    ["partial_cod_cod_amount", paymentMethod?.type === "partial_cod" ? paymentMethod.codAmount : ""],
    ["partial_cod_grand_total", paymentMethod?.type === "partial_cod" ? paymentMethod.grandTotal : ""],
    ["shipping_address_id", shippingAddress?.id || ""],
    ["billing_address_id", billingAddress?.id || ""],
    ["shipping_gstin", shippingAddress?.gstin || ""],
    ["billing_gstin", billingAddress?.gstin || ""],
    ["NECTOR_USED_AMOUNT", nectorPoints?.coin_value ? String(nectorPoints.coin_value) : ""],
    ["nector_points_used", nectorPoints?.coin_value ? String(nectorPoints.coin_value) : ""],
    [
      "shipping_method",
      (shippingAddress?.country || "").trim().toLowerCase() === "india"
        ? "Shipping Rate - FREE"
        : "Shipping - Calculated outside Shopify checkout",
    ],
  ];

  return pairs
    .filter(([, value]) => String(value || "").trim() !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

function buildRestNoteAttributes({
  shippingAddress,
  billingAddress,
  razorpayOrderId,
  razorpayPaymentId,
  appliedCoupon,
  nectorPoints,
  paymentMethod,
  gclid,
  utm,
}) {
  return buildOrderCustomAttributes({
    shippingAddress,
    billingAddress,
    razorpayOrderId,
    razorpayPaymentId,
    nectorPoints,
    paymentMethod,
    gclid,
    utm,
  }).map(({ key, value }) => ({
    name: key,
    value,
  }));
}

function buildOrderNote({ shippingAddress, billingAddress, paymentMethod }) {
  return [
    "Order created via custom Razorpay checkout.",
    paymentMethod?.type === "partial_cod"
      ? `Partial COD: prepaid ${asMoney(paymentMethod.prepaidAmount)}, COD ${asMoney(paymentMethod.codAmount)}.`
      : "",
    shippingAddress?.gstin ? `Shipping GSTIN: ${shippingAddress.gstin}` : "",
    billingAddress?.gstin ? `Billing GSTIN: ${billingAddress.gstin}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret }) {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  return expectedSignature === razorpaySignature;
}

async function callNectorPerform({ userId, orderId, amount }) {
  try {
    const webhookKey = process.env.NECTOR_WEBHOOK_KEY || "1b00001c-26f4-4b62-a601-4f874e63f108";
    const numericId = String(userId || "").match(/\d+/)?.[0] || userId;
    const customerId = `shopify-${numericId}`;
    const numericOrderId = String(orderId || "").match(/\d+/)?.[0] || orderId;

    console.log("Calling Nector Perform Server-Side:", { customerId, orderId: numericOrderId, amount });

    const response = await fetch(`https://platform.nector.io/api/open/integrations/customcheckoutwebhook/${webhookKey}`, {
      method: "POST",
      headers: {
        "x-source": "web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer_id: customerId,
        action: "perform",
        amount: Number(amount),
        reference_order_id: numericOrderId,
        wallet_type: "coins"
      }),
    });

    const data = await response.json();
    console.log("Nector Perform Response:", data);
    return data;
  } catch (error) {
    console.error("Nector Perform Server-Side Error:", error);
    return null;
  }
}

async function recordPartialCodPayment({ orderId, amount, razorpayPaymentId }) {
  const paymentAmount = Number(amount || 0);
  if (!orderId || !paymentAmount) return null;

  try {
    const manualPaymentData = await shopifyAdminFetch(`
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
            totalOutstandingSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            netPaymentSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      id: orderId,
      amount: {
        amount: asMoney(paymentAmount),
        currencyCode: "INR",
      },
      paymentMethodName: razorpayPaymentId ? `Razorpay ${razorpayPaymentId}` : "Razorpay",
      processedAt: new Date().toISOString(),
    }, "2026-01");

    const payload = manualPaymentData.orderCreateManualPayment;
    if (payload?.userErrors?.length) {
      throw new Error(payload.userErrors[0].message);
    }

    return payload?.order || null;
  } catch (error) {
    console.error("GraphQL partial payment record failed, trying REST transaction:", error.message);
  }

  const numericOrderId = getNumericShopifyId(orderId);
  if (!numericOrderId) return null;

  const { data } = await shopifyAdminRestFetch(
    `orders/${numericOrderId}/transactions.json`,
    {},
    {
      method: "POST",
      body: {
        transaction: {
          kind: "sale",
          status: "success",
          amount: asMoney(paymentAmount),
          currency: "INR",
          gateway: "Razorpay",
          authorization: razorpayPaymentId || undefined,
          source_name: "external",
          message: "Partial COD prepaid amount captured via Razorpay",
        },
      },
    }
  );

  return data?.transaction || null;
}

async function createPartialCodOrder({
  cart,
  customer,
  shippingAddress,
  billingAddress,
  razorpayOrderId,
  razorpayPaymentId,
  appliedCoupon,
  nectorPoints,
  paymentMethod,
  gclid,
  utm,
}) {
  const lineItems = (cart?.items || []).map((item) => {
    const isGoldCoin = String(item.variantId || "").includes("47753346973914") || String(item.variantId || "").includes("47661824082138");
    const isFreeGift = isGoldCoin;
    const numericVariantId = isGoldCoin ? null : getNumericShopifyId(item.variantId);
    const price = isFreeGift ? 0 : Number(item.price || 0);
    const lineItem = {
      quantity: Number(item.quantity || 1),
      price: asMoney(price),
      properties: buildRestLineItemProperties({ ...item, gclid }),
    };

    if (numericVariantId) {
      lineItem.variant_id = Number(numericVariantId);
    } else if (isGoldCoin) {
      lineItem.title = item.title || "Free Gold Coin";
    } else {
      lineItem.title = item.title || "Custom item";
    }

    return lineItem;
  });

  const subtotalBeforeDiscount = (cart?.items || []).reduce(
    (acc, item) => acc + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)),
    0
  );
  
  const secureCoupon = cart?.secureCoupon;
  const secureNector = cart?.secureNector;

  const couponDetails = typeof secureCoupon === "object" ? secureCoupon : { code: secureCoupon, value: 0, valueType: "FIXED_AMOUNT" };
  let couponDiscountAmount = 0;
  if (secureCoupon) {
    if (couponDetails.valueType === "FIXED_AMOUNT") {
      couponDiscountAmount = Number(couponDetails.value || 0);
    } else if (couponDetails.valueType === "PERCENTAGE") {
      couponDiscountAmount = (subtotalBeforeDiscount * Number(couponDetails.value || 0)) / 100;
    }
  }
  const nectorValue = Number(secureNector?.fiat_value || 0);
  const nectorPointsUsed = Number(secureNector?.coin_value || 0);

  const discountCodes = [
    couponDiscountAmount > 0
      ? {
          code: couponDetails.code || "Coupon Discount",
          amount: asMoney(couponDiscountAmount),
          type: "fixed_amount",
        }
      : null,
    nectorValue > 0
      ? {
          code: secureNector?.id || "Nector Discount",
          amount: asMoney(Math.min(nectorValue, subtotalBeforeDiscount)),
          type: "fixed_amount",
        }
      : null,
  ].filter(Boolean);
  const tags = ["Razorpay", "Partial COD"];
  if (nectorPointsUsed > 0) tags.push("nector_redeem");

  const { data } = await shopifyAdminRestFetch(
    "orders.json",
    {},
    {
      method: "POST",
      body: {
        order: {
          email: customer?.email || "",
          phone: normalizePhone(customer?.phone || ""),
          send_receipt: false,
          send_fulfillment_receipt: false,
          inventory_behaviour: "decrement_obeying_policy",
          financial_status: "partially_paid",
          currency: "INR",
          tags: tags.join(", "),
          note: buildOrderNote({ shippingAddress, billingAddress, paymentMethod }),
          note_attributes: buildRestNoteAttributes({
            shippingAddress,
            billingAddress,
            razorpayOrderId,
            razorpayPaymentId,
            nectorPoints: secureNector,
            paymentMethod,
            gclid,
            utm,
          }),
          line_items: lineItems,
          shipping_address: buildRestMailingAddress(shippingAddress),
          billing_address: buildRestMailingAddress(billingAddress || shippingAddress),
          shipping_lines: [
            {
              title: "Shipping Rate - FREE",
              code: "FREE",
              price: "0.00",
            },
          ],
          discount_codes: discountCodes,
          transactions: [
            {
              kind: "sale",
              status: "success",
              amount: asMoney(paymentMethod.prepaidAmount),
              currency: "INR",
              gateway: "Razorpay",
              authorization: razorpayPaymentId || razorpayOrderId,
            },
          ],
        },
      },
    }
  );

  return data?.order || null;
}

async function routes(fastify, options) {
  
  // POST /api/payment/razorpay/order
  fastify.post('/payment/razorpay/order', async (request, reply) => {
    try {
      const body = request.body || {};
      const userId = body?.userId ? String(body.userId) : null;
      const sessionId = body?.sessionId || null;
      const context = body?.context || "storefront";
      const gclid = body?.gclid || "";
      const utm = normalizeUtms(body?.utm);

      if (!userId && !sessionId) {
        return reply.code(400).send({ error: "UserId or SessionId is required" });
      }

      const keyId = process.env.RAZORPAY_KEY_ID || "";
      const keySecret = process.env.RAZORPAY_KEY_SECRET || "";

      if (!keyId || !keySecret) {
        return reply.code(500).send({ error: "Razorpay credentials not configured on backend" });
      }

      const db = fastify.mongo.db;
      
      // Supported Free Gift Variant IDs for security and display
      const GOLDCOIN_100MG = "gid://shopify/ProductVariant/47661824082138";
      const GOLDCOIN_500MG = "gid://shopify/ProductVariant/47753346973914";
      const INSURANCE_VARIANT_ID = "gid://shopify/ProductVariant/47709366026458";

      const AUTHORIZED_GOLDCOINS = [GOLDCOIN_100MG];

      // Robust cart lookup matching exactly how cart.js fetches carts
      const contextCondition = { $in: [context, null, ""] };
      const lookupConditions = [];
      if (userId) {
        const rawId = String(userId).trim();
        const userConditions = [
          { userId: rawId, context: contextCondition },
          { userId: `gid://shopify/Customer/${rawId.replace("gid://shopify/Customer/", "")}`, context: contextCondition },
          { userId: rawId.replace("gid://shopify/Customer/", ""), context: contextCondition }
        ];
        lookupConditions.push({ $or: userConditions });
      }
      if (sessionId) {
        lookupConditions.push({ sessionId, context: contextCondition });
      }
      const cartLookup = lookupConditions.length === 1 ? lookupConditions[0] : { $or: lookupConditions };
      let cart = await db.collection("carts").findOne(cartLookup);

      // Helper to normalize variantId for comparison
      const normalizeVid = (id) => String(id || "").replace(/.*ProductVariant\//i, "").trim();

      // Build the canonical items list:
      // Always prefer body.items if it has MORE items than the DB cart,
      // OR if DB cart items have zero/missing prices (stale data).
      // This fixes: (a) only 1 item showing in draft order after login-merge,
      // (b) Razorpay showing ₹1 because DB cart had price=0.
      const dbItems = cart?.items || [];
      const bodyItems = (body?.items || []);

      const dbHasValidPrices = dbItems.length > 0 && dbItems.every(i => Number(i.price || 0) > 0);
      const bodyHasMoreItems = bodyItems.length > dbItems.length;
      const shouldPreferBodyItems = bodyItems.length > 0 && (dbItems.length === 0 || bodyHasMoreItems || !dbHasValidPrices);

      if (shouldPreferBodyItems) {
        console.log(`[checkout.js] Preferring body.items (${bodyItems.length}) over DB cart items (${dbItems.length}). DB prices valid: ${dbHasValidPrices}`);
        const itemsToSave = bodyItems.map(incomingItem => {
          // IMPORTANT: For dynamic jewelry pricing, finalPrice is the real computed price.
          // item.price from Shopify storefront is the Shopify-stored variant price (may be stale/inflated).
          // Always prefer finalPrice over price to get the correct checkout amount.
          const resolvedPrice = Number(incomingItem.finalPrice || incomingItem.price || 0);
          return {
            variantId: incomingItem.variantId,
            productId: incomingItem.productId || incomingItem.id,
            quantity: Number(incomingItem.quantity || 1),
            price: resolvedPrice,
            variantTitle: incomingItem.variantTitle || "",
            title: incomingItem.title || "",
            sku: incomingItem.sku || "",
            image: incomingItem.image || "",
            handle: incomingItem.handle || "",
            goldWeight: incomingItem.goldWeight || 0,
            goldPrice: incomingItem.goldPrice || 0,
            goldPricePerGram: incomingItem.goldPricePerGram || 0,
            makingCharges: incomingItem.makingCharges || 0,
            diamondCharges: incomingItem.diamondCharges || 0,
            gst: incomingItem.gst || 0,
            finalPrice: resolvedPrice,
            diamondTotalPcs: incomingItem.diamondTotalPcs || 0,
            engraving: incomingItem.engraving || "",
            engravingText: incomingItem.engravingText || "",
            engravingFont: incomingItem.engravingFont || "",
            giftText: incomingItem.giftText || "",
            shippingDate: incomingItem.shippingDate || "",
            color: incomingItem.color || "",
            karat: incomingItem.karat || "",
            size: incomingItem.size || "",
            properties: incomingItem.properties || {},
          };
        });

        cart = {
          ...(cart || {}),
          userId: userId ? String(userId) : cart?.userId,
          sessionId: sessionId || cart?.sessionId,
          items: itemsToSave,
          totalAmount: itemsToSave.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0),
          totalQuantity: itemsToSave.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
          updatedAt: new Date(),
        };

        const { _id, ...cartWithoutId } = cart;

        // Persist the enriched cart so future lookups are correct
        const targetQuery = userId ? { userId: String(userId) } : { sessionId };
        await db.collection("carts").updateOne(targetQuery, { $set: cartWithoutId }, { upsert: true });
      } else if (dbItems.length > 0 && bodyItems.length > 0) {
        // DB cart has items, but enrich with prices from body.items where DB price is 0
        let enriched = false;
        cart.items = dbItems.map(dbItem => {
          const match = bodyItems.find(bi => normalizeVid(bi.variantId) === normalizeVid(dbItem.variantId));
          if (match) {
            let updatedItem = dbItem;
            
            if (match.shippingDate && dbItem.shippingDate !== match.shippingDate) {
              updatedItem = { ...updatedItem, shippingDate: match.shippingDate };
              enriched = true;
            }

            const dbPrice = Number(dbItem.price || 0);
            const bodyFinalPrice = Number(match.finalPrice || 0);
            const bodyPrice = Number(match.finalPrice || match.price || 0);
            if (dbPrice === 0 && bodyPrice > 0) {
              enriched = true;
              const resolvedPrice = Number(match.finalPrice || match.price || 0);
              updatedItem = { ...updatedItem, price: resolvedPrice, finalPrice: resolvedPrice };
            }
            
            return updatedItem;
          }
          return dbItem;
        });
        if (enriched) {
          cart.totalAmount = cart.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
          const targetQuery = userId ? { userId: String(userId) } : { sessionId };
          await db.collection("carts").updateOne(targetQuery, { $set: { items: cart.items, totalAmount: cart.totalAmount } });
        }
      } else if (!cart?.items?.length) {
        return reply.code(400).send({ error: "Your cart is empty" });
      }

      const shippingAddress = body?.shippingAddress;
      const billingAddress = body?.billingAddress;
      const customer = body?.customer;
      const appliedCoupon = body?.appliedCoupon;
      const nectorPoints = body?.nectorPoints;

      let secureCouponDetails = null;
      let secureCouponDiscountAmount = 0;

      // --- SECURITY: RE-CALCULATE PRICES SERVER-SIDE ---
      try {
        console.log(`[checkout.js] Starting price validation for ${cart.items.length} items...`);

        // Same helper the cart routes use, so the total the customer saw and the
        // amount this draft order bills are produced by one code path. Do not
        // inline a second pricing pass here — that divergence is what made the
        // Razorpay sheet disagree with the cart.
        const { items: repricedItems, diamondTotal } = await repriceItems(cart.items, { dropInvalid: true });
        cart.items = repricedItems;

        // Fetch Gold Coin settings for validation
        const goldCoinSettings = await db.collection('settings').findOne({ key: 'gold_coin_offer' });
        const isGoldCoinEnabled = goldCoinSettings?.enabled ?? false;
        const goldCoinThreshold = Number(goldCoinSettings?.threshold) || 20000;

        // Supported Gold Coin Variant IDs
        const AUTHORIZED_GOLDCOINS = [
            "gid://shopify/ProductVariant/47661824082138"  // 100mg
        ];

        // Gold coin and silver pendant eligibility share the same base: diamond
        // lines only, insurance excluded.
        const diamondTotalForGoldCoin = diamondTotal;
        const eligibleGoldCoinQty = isGoldCoinEnabled ? Math.floor(diamondTotalForGoldCoin / goldCoinThreshold) : 0;

        console.log(`[Security Check] Eligibility: Gold Coin(Qty=${eligibleGoldCoinQty}), DiamondTotal=${diamondTotalForGoldCoin}`);

        // Second pass: Validate Gift items
        cart.items = cart.items.map(item => {
          const vId = normalizeVariantId(item.variantId);
          const isGoldCoin = AUTHORIZED_GOLDCOINS.some(id => String(vId).includes(id.replace("gid://shopify/ProductVariant/", "")));

          if (isGoldCoin) {
            if (!isGoldCoinEnabled || eligibleGoldCoinQty <= 0) {
              console.warn(`[Security] Removing unauthorized Gold Coin from cart.`);
              return null;
            }
            const validatedQty = Math.min(Number(item.quantity || 1), eligibleGoldCoinQty);
            return { ...item, price: 0, finalPrice: 0, quantity: validatedQty, isFreeGift: true };
          }

          return item;
        }).filter(Boolean);

      } catch (validationError) {
        console.error("CRITICAL: Price validation failed during checkout:", validationError.message);
        // If critical validation fails, we should NOT proceed with potential ₹0 prices
        return reply.code(400).send({ error: "Price validation failed. Please refresh your cart and try again." });
      }
      // --- END SECURITY CHECK ---

      // --- SECURITY: VALIDATE COUPON SERVER-SIDE (After Price Re-calculation) ---
      if (appliedCoupon) {
        const couponCode = typeof appliedCoupon === "string" ? appliedCoupon : appliedCoupon.code;
        if (couponCode) {
          try {
            console.log(`[checkout.js] Validating coupon: ${couponCode}`);
            const discountData = await shopifyAdminFetch(`
              query getDiscount($code: String!) {
                codeDiscountNodeByCode(code: $code) {
                  id
                  codeDiscount {
                    ... on DiscountCodeBasic {
                      __typename
                      status
                      minimumRequirement {
                        ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                        ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
                      }
                      customerGets {
                        value {
                          ... on DiscountAmount { amount { amount } }
                          ... on DiscountPercentage { percentage }
                        }
                      }
                    }
                  }
                }
              }
            `, { code: couponCode });

            const discountInfo = discountData?.codeDiscountNodeByCode?.codeDiscount;
            if (discountInfo && discountInfo.status === "ACTIVE") {
              const subtotalForCoupon = cart.items.reduce((acc, item) => {
                const vId = normalizeVariantId(item.variantId);
                const isGoldCoin = AUTHORIZED_GOLDCOINS.some(id => String(vId).includes(id.replace("gid://shopify/ProductVariant/", "")));
                if (vId === INSURANCE_VARIANT_ID || (isGoldCoin && item.isFreeGift)) {
                  return acc;
                }
                return acc + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1));
              }, 0);

              // Check minimum requirement
              let meetsRequirement = true;
              const minReq = discountInfo.minimumRequirement;
              if (minReq?.greaterThanOrEqualToSubtotal?.amount) {
                if (subtotalForCoupon < Number(minReq.greaterThanOrEqualToSubtotal.amount.amount)) {
                  meetsRequirement = false;
                  console.warn(`[Security] Coupon ${couponCode} minimum subtotal not met: ${subtotalForCoupon} < ${minReq.greaterThanOrEqualToSubtotal.amount.amount}`);
                }
              }

              if (meetsRequirement) {
                if (discountInfo.customerGets?.value?.amount) {
                  secureCouponDiscountAmount = Number(discountInfo.customerGets.value.amount.amount);
                  secureCouponDetails = { code: couponCode, value: secureCouponDiscountAmount, valueType: "FIXED_AMOUNT" };
                } else if (discountInfo.customerGets?.value?.percentage !== undefined) {
                  const percentage = Number(discountInfo.customerGets.value.percentage) * 100;
                  
                  let targetSubtotalForCoupon = subtotalForCoupon;
                  const couponObj = typeof appliedCoupon === "object" ? appliedCoupon : {};
                  const applicableItemIds = couponObj.applicableItemIds || [];
                  const isRestricted = couponObj.restricted ?? applicableItemIds.length > 0;

                  if (isRestricted && applicableItemIds.length > 0) {
                    targetSubtotalForCoupon = cart.items.reduce((acc, item) => {
                      const vId = normalizeVariantId(item.variantId);
                      const isGoldCoin = AUTHORIZED_GOLDCOINS.some(id => String(vId).includes(id.replace("gid://shopify/ProductVariant/", "")));
                      if (vId === INSURANCE_VARIANT_ID || (isGoldCoin && item.isFreeGift)) {
                        return acc;
                      }
                      const rawId = item.shopifyId || item.productId || item.id;
                      const gid = (rawId && String(rawId).includes("gid://")) ? rawId : `gid://shopify/Product/${rawId}`;
                      if (applicableItemIds.includes(gid)) {
                        return acc + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1));
                      }
                      return acc;
                    }, 0);
                  }

                  secureCouponDiscountAmount = (targetSubtotalForCoupon * percentage) / 100;
                  // Store as FIXED_AMOUNT so downstream methods (like partial COD creation) don't recalculate it incorrectly on the whole cart
                  secureCouponDetails = { code: couponCode, value: secureCouponDiscountAmount, valueType: "FIXED_AMOUNT" };
                }
                console.log(`[Security Check] Coupon ${couponCode} validated. Amount: ${secureCouponDiscountAmount}`);
              }
            } else {
              console.warn(`[Security] Invalid or inactive coupon provided: ${couponCode}`);
            }
          } catch (e) {
            console.error(`[Security] Coupon validation failed: ${e.message}`);
          }
        }
      }

      let secureNectorValue = 0;
      let secureNectorPointsUsed = 0;

      // --- SECURITY: VALIDATE NECTOR POINTS SERVER-SIDE ---
      if (nectorPoints?.coin_value) {
        try {
          const numericId = String(userId || "").match(/\d+/)?.[0] || userId;
          const customerId = `shopify-${numericId}`;
          const webhookKey = process.env.NECTOR_WEBHOOK_KEY || "1b00001c-26f4-4b62-a601-4f874e63f108";
          
          const subtotalForNector = cart.items.reduce((acc, item) => 
            acc + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);

          console.log(`[checkout.js] Validating Nector points for customer: ${customerId}`);
          const nectorRes = await fetch(`https://platform.nector.io/api/open/integrations/customcheckoutwebhook/${webhookKey}`, {
            method: "POST",
            headers: { "x-source": "web", "Content-Type": "application/json" },
            body: JSON.stringify({
              customer_id: customerId,
              action: "list",
              amount: Math.max(subtotalForNector, 1)
            }),
          });

          const nectorData = await nectorRes.json();
          const promotions = nectorData?.data?.promotions || nectorData?.promotions || [];
          
          // Match by coin_value or id
          const matchedPromotion = promotions.find(p => 
            String(p.coin_value) === String(nectorPoints.coin_value) || p.id === nectorPoints.id
          );

          if (matchedPromotion) {
            secureNectorValue = Number(matchedPromotion.fiat_value);
            secureNectorPointsUsed = Number(matchedPromotion.coin_value);
            console.log(`[Security Check] Nector validated. Coins: ${secureNectorPointsUsed}, Fiat: ${secureNectorValue}`);
          } else {
            console.warn(`[Security] Nector promotion not found for customer: ${customerId}, requested coins: ${nectorPoints.coin_value}`);
          }
        } catch (e) {
          console.error(`[Security] Nector validation failed: ${e.message}`);
        }
      }

      const couponValue = secureCouponDiscountAmount;
      const nectorValue = secureNectorValue;

      // Use finalPrice preferentially for subtotal (it's the real computed price for dynamic jewelry pricing)
      const subtotalBeforeDiscount = cart.items.reduce((acc, item) => {
        const effectivePrice = Number(item.finalPrice || item.price || 0);
        return acc + (effectivePrice * Number(item.quantity || 1));
      }, 0);
      const finalTotal = Math.max(0, subtotalBeforeDiscount - nectorValue - couponValue);

      // --- SECURITY: LOCK THE SECURED DATA IN DB ---
      try {
        const targetQuery = userId ? { userId: String(userId) } : { sessionId };
        await db.collection("carts").updateOne(targetQuery, { 
          $set: { 
            items: cart.items, 
            totalAmount: subtotalBeforeDiscount,
            secureCoupon: secureCouponDetails,
            secureNector: {
              coin_value: secureNectorPointsUsed,
              fiat_value: secureNectorValue,
              id: nectorPoints?.id
            },
            checkoutLockedAt: new Date()
          } 
        });
        console.log(`[checkout.js] Secured checkout data locked in DB for ${userId || sessionId}`);
      } catch (lockError) {
        console.error("Failed to lock secure checkout data:", lockError.message);
      }
      // --- END LOCK ---
      // Prepare line items
      const lineItems = cart.items.map(item => {
        const vId = normalizeVariantId(item.variantId);
        const isGoldCoin = AUTHORIZED_GOLDCOINS.some(id => String(vId).includes(id.replace("gid://shopify/ProductVariant/", "")));
        
        const finalPriceValue = Number(item.finalPrice || 0);
        const storefrontPrice = Number(item.price || 0);
        const price = isGoldCoin ? 0 : (finalPriceValue > 0 ? finalPriceValue : storefrontPrice);
        
        const originalValue = Number(item.originalPrice || item.comparePrice || 0);
        const unitPrice = (price === 0 && originalValue > 0) ? originalValue : price;

        const staticAttributes = [
          { key: "_Gold Weight", value: String(item.goldWeight || "") },
          { key: "_Gold Price", value: String(item.goldPrice || "") },
          { key: "_Gold Price Per Gram", value: String(item.goldPricePerGram || "") },
          { key: "_Making Charges", value: String(item.makingCharges || "") },
          { key: "_Diamond Charges", value: String(item.diamondCharges || "") },
          { key: "_Diamond Total Pcs", value: String(item.diamondTotalPcs || "") },
          { key: "_GST", value: String(item.gst || "") },
          { key: "_Final Price", value: String(item.finalPrice || item.price || "") },
          { key: "_Shipping Date", value: String(item.shippingDate || "") },
          { key: "Variant Title", value: price === 0 ? "Free Gift" : String(item.variantTitle || "") },
          { key: "Color", value: String(item.color || "") },
          { key: "Karat", value: String(item.karat || "") },
          { key: "Size", value: String(item.size || "") },
          { key: "EngravingText", value: String(item.engravingText || item.engraving || "") },
          { key: "EngravingFont", value: String(item.engravingFont || "") },
          { key: "GiftText", value: String(item.giftText || "") },
          { key: "_gclid", value: String(gclid || "") },
        ];

        const dynamicAttributes = [];
        if (item.properties) {
          for (const [key, val] of Object.entries(item.properties)) {
            if (val && typeof val === 'string' && !key.startsWith('_byj_preview') && !key.startsWith('_byj_charms_json')) {
              dynamicAttributes.push({ key, value: String(val) });
            }
          }
        }

        const customAttributes = [...staticAttributes, ...dynamicAttributes]
          .filter(attr => attr.value !== "" && attr.value !== "0" && attr.value !== "undefined");

        const lineItem = {
          quantity: Number(item.quantity || 1),
          originalUnitPrice: isGoldCoin ? 0 : unitPrice,
          customAttributes: [
            { key: "_Gold Weight", value: String(item.goldWeight || "") },
            { key: "_Gold Price", value: String(item.goldPrice || "") },
            { key: "_Gold Price Per Gram", value: String(item.goldPricePerGram || "") },
            { key: "_Making Charges", value: String(item.makingCharges || "") },
            { key: "_Diamond Charges", value: String(item.diamondCharges || "") },
            { key: "_Diamond Total Pcs", value: String(item.diamondTotalPcs || "") },
            { key: "_Diamond Total Carat", value: String(item.diamondCarat || "") },
            { key: "_GST", value: String(item.gst || "") },
            { key: "_Final Price", value: String(item.finalPrice || item.price || "") },
            { key: "_Shipping Date", value: String(item.shippingDate || "") },
            { key: "Variant Title", value: price === 0 ? "Free Gift" : String(item.variantTitle || "") },
            { key: "Color", value: String(item.color || "") },
            { key: "Karat", value: String(item.karat || "") },
            { key: "Size", value: String(item.size || "") },
            { key: "EngravingText", value: String(item.engravingText || item.engraving || "") },
            { key: "EngravingFont", value: String(item.engravingFont || "") },
            { key: "GiftText", value: String(item.giftText || "") },
            { key: "_gclid", value: String(gclid || "") },
          ].filter(attr => attr.value !== "" && attr.value !== "0" && attr.value !== "undefined")
        };

        if (isGoldCoin) {
          lineItem.title = item.title || "Free Gold Coin";
        } else {
          lineItem.variantId = normalizeVariantId(item.variantId);
        }

        // Only apply 100% discount if it's an authorized free gift
        if (price === 0 && isGoldCoin) {
          lineItem.appliedDiscount = {
            title: "Free Gift",
            value: 100,
            valueType: "PERCENTAGE"
          };
        }
        return lineItem;
      });

      // Combine Nector Points and Coupon into a single order-level discount
      // so it appears in the bottom summary box in Shopify Admin.
      let finalDiscount = undefined;
      let totalDiscountAmount = 0;
      let discountTitles = [];

      if (couponValue > 0) {
        totalDiscountAmount += couponValue;
        discountTitles.push(secureCouponDetails?.code || "Coupon Discount");
      }

      if (nectorValue > 0) {
        totalDiscountAmount += nectorValue;
        discountTitles.push(nectorPoints?.id || "Nector Discount");
      }

      if (totalDiscountAmount > 0) {
        finalDiscount = {
          title: discountTitles.join(" + "),
          value: totalDiscountAmount,
          valueType: "FIXED_AMOUNT"
        };
      }

      // STEP 1: Create Shopify Draft Order
      const customAttributes = [];
      const tags = ["Razorpay"];
      const requestedPaymentMethod = body?.paymentMethod?.type === "partial_cod" ? "partial_cod" : "razorpay";
      if (requestedPaymentMethod === "partial_cod") {
        tags.push("Partial COD");
      }
      if (secureNectorPointsUsed > 0) {
        customAttributes.push({ key: "NECTOR_USED_AMOUNT", value: String(secureNectorPointsUsed) });
        customAttributes.push({ key: "nector_points_used", value: String(secureNectorPointsUsed) });
        tags.push("nector_redeem");
      }

      if (gclid) {
        customAttributes.push({ key: "gclid", value: String(gclid) });
      }

      for (const [key, value] of Object.entries(utm)) {
        customAttributes.push({ key, value });
      }

      const draftOrderInput = {
        lineItems,
        appliedDiscount: finalDiscount,
        useCustomerDefaultAddress: false,
        taxExempt: true,
        shippingAddress: buildMailingAddress(shippingAddress),
        billingAddress: buildMailingAddress(billingAddress || shippingAddress),
        customAttributes: customAttributes.length > 0 ? customAttributes : undefined,
        tags: tags
      };

      if (customer?.email) {
        draftOrderInput.email = customer.email;
      }

      const shopifyDraftData = await shopifyAdminFetch(`
        mutation draftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id
              totalPrice
            }
            userErrors {
              field
              message
            }
          }
        }
      `, { input: draftOrderInput });

      if (!shopifyDraftData?.draftOrderCreate) {
        console.error("Shopify Draft Order Creation failed - No response from Shopify");
        return reply.code(500).send({ error: "Failed to communicate with Shopify" });
      }

      const draftOrder = shopifyDraftData.draftOrderCreate.draftOrder;
      const userErrors = shopifyDraftData.draftOrderCreate.userErrors;

      if (userErrors?.length) {
        console.error("Shopify Draft Order UserErrors:", userErrors);
        return reply.code(400).send({ error: userErrors[0].message });
      }

      if (!draftOrder?.id) {
        console.error("Shopify Draft Order created but no ID returned", shopifyDraftData);
        return reply.code(500).send({ error: "Invalid response from Shopify" });
      }

      const paymentMethod = buildPaymentMethod(body, draftOrder.totalPrice);
      if (requestedPaymentMethod === "partial_cod" && paymentMethod.type !== "partial_cod") {
        return reply.code(400).send({ error: "Partial COD is available only below ₹50,000" });
      }

      // STEP 2: Create Razorpay Order using Draft Order Total, or prepaid amount for Partial COD.
      const amountInSubunits = toSubunits(paymentMethod.prepaidAmount);
      console.log(`Creating Razorpay Order for amount: ${amountInSubunits} subunits (Draft: ${draftOrder.id})`);
      
      const razorpayResponse = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: "INR",
          receipt: draftOrder.id,
        }),
      });

      if (!razorpayResponse.ok) {
        const errorData = await razorpayResponse.json();
        console.error("Razorpay API Error:", errorData);
        return reply.code(500).send({ error: "Payment gateway error", message: errorData?.error?.description || "Razorpay initialization failed" });
      }

      const razorpayOrder = await razorpayResponse.json();

      return {
        key: keyId,
        amount: amountInSubunits,
        currency: "INR",
        orderId: razorpayOrder.id,
        draftId: draftOrder.id,
        customer: body?.customer,
        shippingAddress: body?.shippingAddress,
        billingAddress: body?.billingAddress,
        paymentMethod,
        // What this order actually bills, broken down. The storefront compares it
        // against the summary it rendered and refuses to open the Razorpay sheet
        // on a mismatch, so a customer is never charged a total they never saw.
        pricing: {
          subtotal: subtotalBeforeDiscount,
          couponDiscount: couponValue,
          pointsDiscount: nectorValue,
          grandTotal: Number(draftOrder.totalPrice),
        },
      };
    } catch (error) {
      console.error("DRAFT ORDER FLOW ERROR:", error);
      return reply.code(500).send({ error: "Failed to initialize checkout", message: error.stack || String(error) });
    }
  });

  // POST /api/payment/razorpay/complete
  fastify.post('/payment/razorpay/complete', async (request, reply) => {
    try {
      const body = request.body || {};
      const userId = body?.userId ? String(body.userId) : null;
      const sessionId = body?.sessionId || null;
      const razorpayOrderId = String(body?.razorpayOrderId || "").trim();
      const razorpayPaymentId = String(body?.razorpayPaymentId || "").trim();
      const razorpaySignature = String(body?.razorpaySignature || "").trim();
      const draftId = body?.draftId;
      const gclid = body?.gclid || "";
      const utm = normalizeUtms(body?.utm);

      const nectorPoints = body?.nectorPoints;

      console.log("COMPLETE ORDER REQUEST:", { userId, sessionId, razorpayOrderId, razorpayPaymentId, draftId });

      if (!userId && !sessionId) {
        return reply.code(400).send({ error: "UserId or SessionId is required" });
      }

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !draftId) {
        return reply.code(400).send({ error: "Payment details are incomplete" });
      }

      const secret = process.env.RAZORPAY_KEY_SECRET || "";
      if (!verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret })) {
        console.error("Razorpay signature verification failed");
        return reply.code(400).send({ error: "Invalid payment signature" });
      }

      const db = fastify.mongo.db;
      const cartCollection = db.collection("carts");
      const paymentCollection = db.collection("shopify_order_payments");
      const ordersCollection = db.collection("orders");

      const cartConditions = [];
      if (userId) {
        const rawId = String(userId).trim();
        cartConditions.push({ userId: rawId });
        const match = rawId.match(/\d+/);
        if (match) {
          cartConditions.push({ userId: match[0] }); // String
          cartConditions.push({ userId: Number(match[0]) }); // Number
          cartConditions.push({ userId: `gid://shopify/Customer/${match[0]}` });
        }
      }
      if (sessionId) {
        cartConditions.push({ sessionId });
      }

      const cartLookup = cartConditions.length > 0 ? { $or: cartConditions } : { _id: "impossible" };
      let cart = await cartCollection.findOne(cartLookup);
      
      if (!cart || !cart.items || cart.items.length === 0) {
        console.error("Cart not found or empty during completion! Lookup:", JSON.stringify(cartLookup));
        // Fallback: try to find any cart with this session
        if (sessionId) {
          cart = await cartCollection.findOne({ sessionId });
        }
        
        // Final fallback: use items passed from the frontend Redux state directly!
        if ((!cart || !cart.items || cart.items.length === 0) && body?.cartItems?.length > 0) {
          console.log("Using body.cartItems fallback because DB cart is empty or missing.");
          cart = { items: body.cartItems, userId, sessionId };
        }
        
        if (!cart || !cart.items || cart.items.length === 0) {
           return reply.code(400).send({ error: "Cart is empty or expired. Please add items again." });
        }
      }

      // --- SECURITY: RE-VERIFY PAYMENT METHOD ---
      // Re-calculate grand total based on DB cart (locked items) and secure discounts
      const subtotal = cart.items.reduce((acc, item) => 
        acc + (Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1)), 0);
      
      const secureCoupon = cart.secureCoupon;
      let couponValue = 0;
      if (secureCoupon) {
        const couponDetails = typeof secureCoupon === "object" ? secureCoupon : { value: 0, valueType: "FIXED_AMOUNT" };
        if (couponDetails.valueType === "FIXED_AMOUNT") couponValue = Number(couponDetails.value);
        else if (couponDetails.valueType === "PERCENTAGE") couponValue = (subtotal * Number(couponDetails.value)) / 100;
      }
      const nectorValue = Number(cart.secureNector?.fiat_value || 0);
      const grandTotal = Math.max(0, subtotal - couponValue - nectorValue);

      // FORCE re-calculate paymentMethod on server. DO NOT trust body.paymentMethod
      const paymentMethod = buildPaymentMethod(body, grandTotal);
      console.log(`[Security Check] Final Payment Verification: Type=${paymentMethod.type}, Prepaid=${paymentMethod.prepaidAmount}, COD=${paymentMethod.codAmount}, Total=${paymentMethod.grandTotal}`);

      const secureNector = cart?.secureNector || nectorPoints;

      if (paymentMethod.type === "partial_cod") {
        const partialOrder = await createPartialCodOrder({
          cart,
          customer: body?.customer,
          shippingAddress: body?.shippingAddress,
          billingAddress: body?.billingAddress || body?.shippingAddress,
          razorpayOrderId,
          razorpayPaymentId,
          appliedCoupon: cart?.secureCoupon || body?.appliedCoupon,
          nectorPoints: secureNector,
          paymentMethod,
          gclid,
          utm,
        });

        if (!partialOrder?.id) {
          return reply.code(500).send({ error: "Failed to create Partial COD order" });
        }

        try {
          await shopifyAdminFetch(`
            mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
              draftOrderDelete(input: $input) {
                deletedId
                userErrors { field message }
              }
            }
          `, { input: { id: draftId } });
        } catch (deleteDraftError) {
          console.error("Unable to delete unused Partial COD draft:", deleteDraftError);
        }

        const shopifyOrderId = partialOrder.admin_graphql_api_id || `gid://shopify/Order/${partialOrder.id}`;
        if (secureNector?.coin_value) {
          const cartTotalAmount = cart?.items?.reduce((acc, item) =>
            acc + (Number(item.price || 0) * Number(item.quantity || 1)), 0) || 0;

          await callNectorPerform({
            userId,
            orderId: shopifyOrderId,
            amount: Math.max(cartTotalAmount, 1)
          });
        }

        const orderRecord = {
          shopifyOrderId,
          shopifyOrderName: partialOrder.name,
          razorpayOrderId,
          razorpayPaymentId,
          userId: userId || null,
          sessionId: sessionId || null,
          totalAmount: Number(partialOrder.total_price || paymentMethod.grandTotal || 0),
          customer: body?.customer,
          shippingAddress: body?.shippingAddress,
          billingAddress: body?.billingAddress,
          paymentMethod,
          partialCodPaymentRecorded: true,
          status: "PARTIAL_COD",
          createdAt: new Date(),
        };

        // await ordersCollection.insertOne(orderRecord);
        // await paymentCollection.insertOne({
        //   ...orderRecord,
        //   razorpaySignature,
        //   updatedAt: new Date()
        // });
        if (cart?._id) {
          await cartCollection.updateOne({ _id: cart._id }, { $set: { items: [], updatedAt: new Date() } });
        } else {
          await cartCollection.updateOne(cartLookup, { $set: { items: [], updatedAt: new Date() } });
        }

        return {
          success: true,
          shopifyOrderId,
          shopifyOrderName: partialOrder.name,
        };
      }

      // STEP 1: Update Draft Order with final details (Address, Properties, etc.)
      const tags = ["Razorpay"];
      if (paymentMethod.type === "partial_cod") {
        tags.push("Partial COD");
      }
      if (secureNector?.coin_value) {
        tags.push("nector_redeem");
      }

      await shopifyAdminFetch(`
        mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder { id }
            userErrors { field message }
          }
        }
      `, {
        id: draftId,
        input: {
          shippingAddress: buildMailingAddress(body?.shippingAddress),
          billingAddress: buildMailingAddress(body?.billingAddress || body?.shippingAddress),
          note: buildOrderNote({
            shippingAddress: body?.shippingAddress,
            billingAddress: body?.billingAddress,
            paymentMethod,
          }),
          tags: tags,
          customAttributes: buildOrderCustomAttributes({
            shippingAddress: body?.shippingAddress,
            billingAddress: body?.billingAddress,
            razorpayOrderId,
            razorpayPaymentId,
            nectorPoints: secureNector,
            paymentMethod,
            gclid,
            utm,
          })
        }
      });

      // STEP 2: Complete Shopify Draft Order
      console.log("Completing draft order:", draftId);
      const shopifyData = await shopifyAdminFetch(`
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
      `, { id: draftId, paymentPending: paymentMethod.type === "partial_cod" });

      const payload = shopifyData.draftOrderComplete;
      
      if (!payload) {
        throw new Error("Invalid response from draftOrderComplete: payload is null");
      }

      if (payload?.userErrors?.some(e => e.message.toLowerCase().includes("already completed") || e.message.toLowerCase().includes("not open"))) {
        console.log("Draft order already completed or not open:", draftId);
        await cartCollection.updateOne(cartLookup, { $set: { items: [], updatedAt: new Date() } });
        return {
          success: true,
          message: "Order already completed"
        };
      }

      if (payload?.userErrors?.length) {
        console.error("DraftOrderComplete UserErrors:", payload.userErrors);
        return reply.code(400).send({ error: payload.userErrors[0].message });
      }

      if (!payload.draftOrder) {
        throw new Error("DraftOrder is null in completion response");
      }

      const order = payload.draftOrder.order;
      
      if (!order) {
        throw new Error("Order was not created from Draft Order");
      }
      
      console.log("Order completed successfully:", order.name);

      let partialCodPaymentRecorded = false;
      if (paymentMethod.type === "partial_cod") {
        try {
          const recordedPaymentOrder = await recordPartialCodPayment({
            orderId: order.id,
            amount: paymentMethod.prepaidAmount,
            razorpayPaymentId,
          });

          partialCodPaymentRecorded = Boolean(recordedPaymentOrder);
          console.log("Partial COD payment record result:", recordedPaymentOrder);
        } catch (paymentRecordError) {
          console.error("Partial COD payment could not be recorded in Shopify:", paymentRecordError);
        }
      }

      // STEP 3: Nector Point Redemption (Server-Side)
      if (secureNector?.coin_value) {
        const cartTotalAmount = cart?.items?.reduce((acc, item) => 
          acc + (Number(item.price || 0) * Number(item.quantity || 1)), 0) || 0;

        await callNectorPerform({
          userId,
          orderId: order.id,
          amount: Math.max(cartTotalAmount, 1)
        });
      }

      // STEP 4: Save to Local MongoDB
      const orderRecord = {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        razorpayOrderId,
        razorpayPaymentId,
        userId: userId || null,
        sessionId: sessionId || null,
        totalAmount: Number(order.totalPriceSet.shopMoney.amount),
        customer: body?.customer,
        shippingAddress: body?.shippingAddress,
        billingAddress: body?.billingAddress,
        paymentMethod,
        partialCodPaymentRecorded,
        status: paymentMethod.type === "partial_cod" ? "PARTIAL_COD" : "PAID",
        createdAt: new Date(),
      };

      // await ordersCollection.insertOne(orderRecord);
      // await paymentCollection.insertOne({
      //   ...orderRecord,
      //   razorpaySignature,
      //   updatedAt: new Date()
      // });

      // STEP 5: Clear Cart
      console.log("Clearing cart for user:", userId || sessionId);
      if (cart?._id) {
        await cartCollection.updateOne({ _id: cart._id }, { $set: { items: [], updatedAt: new Date() } });
      } else {
        await cartCollection.updateOne(cartLookup, { $set: { items: [], updatedAt: new Date() } });
      }

      return {
        success: true,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
      };
    } catch (error) {
      console.error("COMPLETE ORDER ERROR:", error);
      return reply.code(500).send({ 
        error: "Backend Error: " + (error.message || String(error)),
        details: error.stack
      });
    }
  });

  // Helper to extract access token from authorization header
  const getAccessToken = (request) => {
    const authHeader = request.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  };

  // GET /api/checkout/address-selection
  fastify.get('/checkout/address-selection', async (request, reply) => {
    const db = fastify.mongo.db;
    const accessToken = getAccessToken(request);
    const sessionId = request.headers['x-session-id'] || request.query.sessionId || "";

    const query = {};
    if (accessToken) {
      query.accessToken = accessToken;
    } else if (sessionId) {
      query.sessionId = sessionId;
    } else {
      return { billingAddressMode: "same", billingAddressId: "" };
    }

    try {
      const selection = await db.collection('checkout_address_selections').findOne(query);
      if (selection) {
        return {
          billingAddressMode: selection.billingAddressMode || "same",
          billingAddressId: selection.billingAddressId || ""
        };
      }
    } catch (error) {
      fastify.log.error("Error reading address selection:", error);
    }

    return { billingAddressMode: "same", billingAddressId: "" };
  });

  // PATCH /api/checkout/address-selection
  fastify.patch('/checkout/address-selection', async (request, reply) => {
    const db = fastify.mongo.db;
    const body = request.body || {};
    const accessToken = getAccessToken(request);
    const sessionId = request.headers['x-session-id'] || request.query.sessionId || body.sessionId || "";

    const billingAddressMode = body.billingAddressMode === "different" ? "different" : "same";
    const billingAddressId = billingAddressMode === "different" ? String(body.billingAddressId || "").trim() : "";

    const query = {};
    if (accessToken) {
      query.accessToken = accessToken;
    } else if (sessionId) {
      query.sessionId = sessionId;
    } else {
      return { success: true, billingAddressMode, billingAddressId };
    }

    try {
      await db.collection('checkout_address_selections').updateOne(
        query,
        {
          $set: {
            billingAddressMode,
            billingAddressId,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    } catch (error) {
      fastify.log.error("Error saving address selection:", error);
      return reply.code(500).send({ error: "Failed to save address selection", message: error.message });
    }

    return { success: true, billingAddressMode, billingAddressId };
  });


  // GET /api/sync-status
  fastify.get('/sync-status', async (request, reply) => {
    return { status: 'idle', lastSync: new Date() };
  });

  // POST /api/webhooks/shopify
  // fastify.post('/webhooks/shopify', async (request, reply) => {
  //   fastify.log.info('Received Shopify webhook in backend');
  //   return { success: true };
  // });

  // POST /api/nector/checkout
  fastify.post('/nector/checkout', async (request, reply) => {
    try {
      const payload = request.body;
      const webhookKey = process.env.NECTOR_WEBHOOK_KEY || "1b00001c-26f4-4b62-a601-4f874e63f108";
      
      const response = await fetch(`https://platform.nector.io/api/open/integrations/customcheckoutwebhook/${webhookKey}`, {
        method: 'POST',
        headers: { 
          'x-source': 'web',
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Nector API Proxy Error:", error);
      return reply.code(500).send({ error: "Failed to communicate with Nector", message: error.message });
    }
  });
}

module.exports = routes;
