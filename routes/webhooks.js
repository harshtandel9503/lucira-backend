/**
 * Webhooks Route (Fastify)
 */
const { clearAllCache } = require('../lib/cache');
const { warmStoreProductIds, warmCollectionIdOrders } = require('../lib/storeAvailability');
const { noteProductChanged, noteInventoryItemChanged } = require('../lib/discountIndex');
const crypto = require('crypto');
const returnsLib = require('../lib/returns');

async function routes(fastify, options) {

  const verifyShopifyHmac = (request) => {
    const hmacHeader = request.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) return true; // not configured -> skip (dev)
    if (!hmacHeader || !request.rawBody) return false;
    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(request.rawBody, 'utf8')
      .digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
    } catch (_) {
      return false;
    }
  };

  // Custom parser to save raw body for HMAC verification
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
    try {
      req.rawBody = body; // Save raw body for HMAC
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // POST /api/webhooks/checkout-crm
  fastify.post('/checkout-crm', async (request, reply) => {
    try {
      const { type, payload } = request.body || {};

      const webhookUrl = type === "add_payment_info"
        ? "https://payment-info-webhook-385594025448.asia-south1.run.app/webhookb7n1p132p4"
        : "https://checkout-crm-webhook-385594025448.us-central1.run.app/webhookb6n1p8s2z3";

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.text();

      if (!response.ok) {
        console.error(`[Webhook Error] ${webhookUrl} responded with status ${response.status}:`, data);
        return reply.code(response.status).send({ error: "Webhook failed", details: data });
      }

      return reply.code(200).send({ success: true, message: "Webhook sent successfully" });
    } catch (error) {
      console.error("[Webhook Exception]:", error);
      return reply.code(500).send({ error: "Internal Server Error", details: error.message });
    }
  });

  // POST /api/webhooks/headless
  fastify.post('/headless', async (request, reply) => {
    try {
      const { type, payload } = request.body || {};

      const webhookUrl = type === "ProductView"
        ? "https://productview-headless-webhook-385594025448.asia-south1.run.app/webhookb1n6q4h1b8"
        : "https://atc-headless-webhook-385594025448.asia-south1.run.app/webhookbe2p6x9n4r8";

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.text();

      if (!response.ok) {
        console.error(`[Webhook Error] ${webhookUrl} responded with status ${response.status}:`, data);
        return reply.code(response.status).send({ error: "Webhook failed", details: data });
      }

      return reply.code(200).send({ success: true, message: "Webhook sent successfully" });
    } catch (error) {
      console.error("[Webhook Exception]:", error);
      return reply.code(500).send({ error: "Internal Server Error", details: error.message });
    }
  });

  // POST /api/webhooks/shopify/products
  fastify.post('/shopify/products', async (request, reply) => {
    // 1. Verify Shopify HMAC Signature
    const hmacHeader = request.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (secret && hmacHeader && request.rawBody) {
      const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(request.rawBody, 'utf8')
        .digest('base64');

      if (generatedHash !== hmacHeader) {
        console.warn(`[Webhook] Invalid HMAC signature! Expected ${hmacHeader}, got ${generatedHash}`);
        return reply.code(401).send({ error: 'Unauthorized webhook' });
      }
    } else if (secret && !hmacHeader) {
      console.warn(`[Webhook] Missing HMAC header in request.`);
      return reply.code(401).send({ error: 'Missing signature' });
    }

    // 2. Acknowledge Shopify Webhook immediately
    reply.code(200).send({ success: true, message: "Webhook received" });

    const payload = request.body || {};
    const handle = payload.handle || null;

    console.log(`[Webhook] Product created/updated: ${handle || "unknown"}`);

    try {
      // 3. Clear all backend memory caches — rate-limited, see scheduleCacheClear.
      scheduleCacheClear(handle || "unknown");

      // "Discount: High to Low" index — debounced, batched re-read of just this
      // product (a large burst becomes one full rebuild). See lib/discountIndex.js.
      noteProductChanged(payload.admin_graphql_api_id || payload.id);

      // 4. Debounced Frontend Revalidation
      // ---------------------------------------------------------------------------
      // PROBLEM: During a daily bulk price update, Shopify fires 2,500 webhooks in 
      // quick succession. Without debouncing, each webhook would call Vercel's 
      // /api/revalidate separately, resulting in 2,500 Vercel serverless function 
      // invocations and 5,000 ISR writes per day — consuming 75% of the free monthly limit!
      //
      // SOLUTION: We use a debounce timer. Every webhook resets a 10-second timer.
      // Once all 2,500 webhooks arrive and the last one fires, we wait 10 seconds of
      // silence and then call Vercel ONCE — resulting in just 1 function invocation 
      // and 1 ISR write (for the homepage) per daily bulk price update.
      //
      // For a single product edit (not a bulk update), the debounce resolves after
      // 10 seconds and still calls Vercel once with the specific product handle,
      // revalidating exactly 2 pages (homepage + that product).
      // ---------------------------------------------------------------------------
      scheduleRevalidation(handle);

    } catch (err) {
      console.error("[Webhook] Error during webhook processing:", err);
    }
  });

  // POST /api/webhooks/shopify/returns
  // Register these topics in Shopify for production status sync:
  //   returns/request, returns/approve, returns/decline, returns/close,
  //   returns/cancel, returns/update, returns/process
  // On localhost the storefront falls back to live-fetching status on load,
  // so this route is only required in production (needs a public URL).
  fastify.post('/shopify/returns', async (request, reply) => {
    if (!verifyShopifyHmac(request)) {
      console.warn('[Webhook returns] Invalid or missing HMAC signature.');
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    // Acknowledge immediately (Shopify requires a fast 200).
    reply.code(200).send({ success: true });

    try {
      const payload = request.body || {};
      const topic = request.headers['x-shopify-topic'] || 'returns/update';
      const returnGid = payload.admin_graphql_api_id
        || (payload.id ? `gid://shopify/Return/${payload.id}` : null);
      if (!returnGid) return;

      const db = fastify.mongo.db;
      const returnsCollection = db.collection('returns');

      // Prefer authoritative status straight from Shopify; fall back to the topic.
      let status = null;
      try {
        const view = await returnsLib.getReturnDetail(returnGid);
        status = view?.status || null;
      } catch (_) { /* fall through to topic mapping */ }

      if (!status) {
        const TOPIC_STATUS = {
          'returns/request': 'REQUESTED',
          'returns/approve': 'OPEN',
          'returns/decline': 'DECLINED',
          'returns/cancel': 'CANCELED',
          'returns/close': 'CLOSED',
        };
        status = TOPIC_STATUS[topic] || payload.status || 'REQUESTED';
      }

      await returnsCollection.updateOne(
        { returnId: returnGid },
        { $set: { status, updatedAt: new Date(), lastWebhookTopic: topic } }
      );
      console.log(`[Webhook returns] ${topic} -> ${returnGid} = ${status}`);
    } catch (err) {
      console.error('[Webhook returns] processing error:', err);
    }
  });

  // ---------------------------------------------------------------------------
  // Shopify Inventory Webhooks
  // Handles:
  //   - inventory_items/create
  //   - inventory_items/update
  //   - inventory_items/delete
  //   - inventory_levels/connect
  //   - inventory_levels/update
  //   - inventory_levels/disconnect
  // ---------------------------------------------------------------------------
  const handleShopifyInventory = async (request, reply) => {
    // 1. Verify Shopify HMAC Signature
    if (!verifyShopifyHmac(request)) {
      console.warn('[Webhook inventory] Invalid or missing HMAC signature.');
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    // 2. Acknowledge Shopify Webhook immediately (Shopify requires 200 within 5 seconds)
    reply.code(200).send({ success: true, message: "Inventory webhook received" });

    const topic = request.headers['x-shopify-topic'] || 'inventory_levels/update';
    const payload = request.body || {};
    const itemId = payload.inventory_item_id || payload.id || null;
    const locationId = payload.location_id || null;
    const available = payload.available !== undefined ? payload.available : null;

    console.log(`[Webhook] Inventory event received [${topic}]: Item ID ${itemId || 'unknown'}, Location: ${locationId || 'N/A'}, Available: ${available !== null ? available : 'N/A'}`);

    try {
      // 3. Clear backend memory caches with rate-limiting & cooldown (store-availability, collection sorting, counts)
      scheduleCacheClear(`inventory:${topic}`);

      // Stock decides which variant the card prices, so it can move the discount.
      noteInventoryItemChanged(itemId);

      // 4. Debounced Frontend ISR Revalidation (homepage and store availability)
      scheduleRevalidation(null);
    } catch (err) {
      console.error('[Webhook inventory] Processing error:', err);
    }
  };

  // POST /api/webhooks/shopify/inventory (Unified endpoint for all 6 inventory events)
  fastify.post('/shopify/inventory', handleShopifyInventory);

  // Dedicated topic endpoints (in case configured individually in Shopify)
  fastify.post('/shopify/inventory-items', handleShopifyInventory);
  fastify.post('/shopify/inventory-levels', handleShopifyInventory);

  // ---------------------------------------------------------------------------
  // Order Status Webhook (ERP / WebEngage sync)
  // Handles incoming ERP / manufacturing milestone status updates
  // POST /api/webhooks/order-status
  // ---------------------------------------------------------------------------
  fastify.post('/order-status', async (request, reply) => {
    try {
      const payload = request.body || {};

      // Flexible extraction from nested or flat payload:
      // Case 1: Webhook forwarder format: { data: { document_no, reason_status_description, ... }, customer, lead }
      // Case 2: WebEngage event format: { eventData: { document_no, reason_status_description, ... }, userId }
      // Case 3: Direct payload format: { document_no, reason_status_description, ... }
      const data = payload.data || payload.eventData || payload;
      const customer = payload.customer || payload.lead || {};

      const rawDocNo = data.document_no || data.documentNo || data.order_number || data.orderNumber || payload.document_no || "";
      const statusDescription = (data.reason_status_description || data.status || data.order_status || payload.reason_status_description || "").trim();
      const documentDate = data.document_date || data.event_time || payload.event_time || payload.timestamp || new Date().toISOString();
      const mobile = data.mobile || data["Phone Number"] || customer.phone || payload.userId || "";
      const itemName = data.item_name || data.itemName || "";
      const itemCode = data.item_code || data.itemCode || "";
      const weight = Number(data.weight) || 0;
      const netWeight = Number(data.net_weight) || 0;
      const image = data.image || "";
      const partyName = data.party_name || customer.name || "";
      const waybill = data.waybill || data.awb || data.tracking_number || data.tracking_no || data.clickpost_waybill || payload.waybill || "";
      const courierPartnerId = data.courier_partner_id || data.cp_id || payload.courier_partner_id || null;
      const trackingUrl = data.tracking_url || data.tracking_link || data.clickpost_url || payload.tracking_url || "";
      const courierName = data.courier_name || data.courier || payload.courier_name || "";

      if (!rawDocNo) {
        return reply.code(400).send({
          success: false,
          error: "document_no is required"
        });
      }

      const docNoStr = String(rawDocNo).trim();
      // Clean order number: e.g. "#2905" -> "2905", "SO-2905" -> "2905"
      const cleanOrderNumber = docNoStr.replace(/^[#\s]+/, '').trim();
      const digitsOnly = docNoStr.replace(/\D/g, '');

      const db = fastify.mongo.db;
      const orderStatusesCol = db.collection('order_statuses');

      const normDesc = statusDescription.toLowerCase().replace(/[^a-z0-9]/g, '');
      let mappedStatus = statusDescription;
      let mappedStage = statusDescription;

      if (normDesc === 'pogenerated' || normDesc === 'inprogress') {
        mappedStatus = 'Processing';
        mappedStage = 'PO Generated';
      } else if (normDesc.includes('readytoinvoice') || normDesc.includes('readytoship')) {
        mappedStatus = 'Dispatch';
        mappedStage = 'Ready to Invoice';
      } else if (normDesc.includes('outfordelivery') || normDesc.includes('outfordeliver')) {
        mappedStatus = 'Out For Delivery';
        mappedStage = 'Out For Delivery';
      } else if (normDesc.includes('intransit') || normDesc === 'transit') {
        mappedStatus = 'In Transit';
        mappedStage = 'In Transit';
      } else if (normDesc.includes('delivered')) {
        mappedStatus = 'Delivered';
        mappedStage = 'Delivered';
      } else if (normDesc.includes('orderplaced') || normDesc.includes('pickuppending') || normDesc.includes('onlineshipmentbooked')) {
        mappedStatus = 'Order Placed';
        mappedStage = 'Pickup Pending';
      }

      const statusUpdate = {
        status: mappedStatus,
        stage: mappedStage,
        originalStatus: statusDescription,
        date: documentDate,
        timestamp: new Date()
      };

      const queryCriteria = [
        { orderNumber: cleanOrderNumber },
        { documentNo: docNoStr },
        { documentNo: `#${cleanOrderNumber}` }
      ];
      if (digitsOnly && digitsOnly !== cleanOrderNumber) {
        queryCriteria.push({ orderNumber: digitsOnly });
      }

      const setFields = {
        orderNumber: cleanOrderNumber,
        documentNo: docNoStr,
        status: statusDescription,
        reason_status_description: statusDescription,
        documentDate: documentDate,
        mobile: mobile,
        itemName: itemName,
        itemCode: itemCode,
        weight: weight,
        netWeight: netWeight,
        image: image,
        partyName: partyName,
        updatedAt: new Date()
      };

      if (waybill) {
        setFields.waybill = waybill;
        setFields.clickpost_waybill = waybill;
      }
      if (courierPartnerId) {
        setFields.clickpost_courier_partner_id = courierPartnerId;
      }
      if (trackingUrl) {
        setFields.tracking_url = trackingUrl;
      }
      if (courierName) {
        setFields.courier_name = courierName;
      }

      await orderStatusesCol.updateOne(
        { $or: queryCriteria },
        {
          $set: {
            ...setFields,
            orderNumber: cleanOrderNumber,
            documentNo: docNoStr,
            status: mappedStatus,
            stage: mappedStage,
            reason_status_description: statusDescription,
            documentDate: documentDate,
            mobile: mobile,
            itemName: itemName,
            itemCode: itemCode,
            weight: weight,
            netWeight: netWeight,
            image: image,
            partyName: partyName,
            updatedAt: new Date()
          },
          $push: {
            history: statusUpdate
          }
        },
        { upsert: true }
      );

      console.log(`[Webhook Order Status] Synced Order #${cleanOrderNumber} (${docNoStr}) -> "${statusDescription}" at ${documentDate}`);

      // Forward to GCP WebEngage Order Status Webhook Cloud Function
      const gcpWebhookUrl = process.env.GCP_ORDER_STATUS_WEBHOOK_URL || 'https://clickpost-order-status-webhook-385594025448.asia-south1.run.app';
      if (gcpWebhookUrl) {
        const gcpPayload = {
          order_id: cleanOrderNumber,
          order_number: cleanOrderNumber,
          document_no: docNoStr,
          status: mappedStatus,
          stage: mappedStage,
          status_description: statusDescription,
          document_date: documentDate,
          mobile: mobile,
          customer_name: partyName,
          item_name: itemName,
          item_code: itemCode,
          weight: weight,
          net_weight: netWeight,
          image: image,
          waybill: waybill,
          courier_name: courierName,
          tracking_url: trackingUrl,
          source: 'lucira-backend-order-status'
        };

        fetch(gcpWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gcpPayload),
        }).catch((gcpErr) => {
          console.warn('[Webhook Order Status] Forward to GCP failed (non-fatal):', gcpErr.message);
        });
      }

      return reply.code(200).send({
        success: true,
        message: "Order status synchronized successfully",
        orderNumber: cleanOrderNumber,
        status: statusDescription,
        date: documentDate
      });
    } catch (err) {
      console.error("[Webhook Order Status] Error:", err);
      return reply.code(500).send({
        success: false,
        error: "Internal Server Error",
        details: err.message
      });
    }
  });

  // GET /api/webhooks/order-status/:id
  fastify.get('/order-status/:id', async (request, reply) => {
    try {
      const id = String(request.params.id || "").trim();
      const cleanId = id.replace(/^[#\s]+/, '');
      const db = fastify.mongo.db;
      const status = await db.collection('order_statuses').findOne({
        $or: [
          { orderNumber: cleanId },
          { documentNo: id },
          { documentNo: `#${cleanId}` }
        ]
      });
      if (!status) return reply.code(404).send({ error: "Order status not found" });
      return { success: true, status };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Debounce State (lives in Fastify server memory on EC2)
// ---------------------------------------------------------------------------
let revalidateTimer = null;        // The active debounce timer
let pendingHandles = new Set();    // Collects all product handles received during the window
let pendingGeneralRevalidate = false; // Tracks if an inventory or general change occurred
const DEBOUNCE_MS = 20000;         // 20 seconds quiet window before calling Vercel

// ---------------------------------------------------------------------------
// Backend cache invalidation — rate-limited
// ---------------------------------------------------------------------------
// PROBLEM: this used to call clearAllCache() on EVERY product webhook. During the
// daily bulk price update Shopify fires ~2,500 of them, so the entire cache was
// wiped 2,500 times in a row. The expensive derived entries never survived long
// enough to be used — collection-id-order (6h TTL) and store-product-ids (15m
// TTL), the two full-catalogue scans behind store-proximity ordering, were gone
// before the next request arrived. Every collection page paid the cold cost.
//
// SOLUTION: leading edge + cooldown + trailing edge.
//   • leading  — a wipe outside the cooldown happens IMMEDIATELY, so a single
//                product edit is reflected exactly as fast as it was before.
//   • cooldown — further wipes inside the window are suppressed, so a 2,500
//                webhook burst wipes once instead of 2,500 times and the caches
//                can actually serve traffic while the burst is in flight.
//   • trailing — one final wipe once the burst goes quiet, so whatever changed
//                during the cooldown is never left stale behind it.
// ---------------------------------------------------------------------------
let cacheClearTimer = null;
let lastCacheClearAt = 0;
let suppressedClears = 0;
const CACHE_CLEAR_COOLDOWN_MS = 30000;   // min gap between wipes during a burst
const CACHE_CLEAR_TRAILING_MS = 20000;   // quiet window before the final wipe

function scheduleCacheClear(reason) {
  const now = Date.now();

  if (now - lastCacheClearAt > CACHE_CLEAR_COOLDOWN_MS) {
    lastCacheClearAt = now;
    clearAllCache();
    console.log(`[Webhook] Backend caches cleared (${reason})`);
    // A wipe also throws away the per-store stock sets behind store-proximity
    // ordering. Rebuild them right away, off the request path, so the next
    // pincoded shopper gets a warm ordering instead of paying for the scans.
    warmStoreProductIds();
    warmCollectionIdOrders();
  } else {
    suppressedClears += 1;
  }

  if (cacheClearTimer) clearTimeout(cacheClearTimer);
  cacheClearTimer = setTimeout(() => {
    cacheClearTimer = null;
    lastCacheClearAt = Date.now();
    clearAllCache();
    console.log(
      `[Webhook] Backend caches cleared (trailing; ${suppressedClears} redundant wipes suppressed during burst)`
    );
    suppressedClears = 0;
    warmStoreProductIds();
    warmCollectionIdOrders();
  }, CACHE_CLEAR_TRAILING_MS);
}

function scheduleRevalidation(handle) {
  // Track this handle. If it's a bulk update, this Set will grow to 2,500+ items.
  if (handle) {
    pendingHandles.add(handle);
  } else {
    pendingGeneralRevalidate = true;
  }

  // Reset the timer every time a new webhook arrives
  if (revalidateTimer) {
    clearTimeout(revalidateTimer);
  }

  revalidateTimer = setTimeout(async () => {
    const handles = [...pendingHandles];
    const needGeneral = pendingGeneralRevalidate;
    const isBulkUpdate = handles.length > 5; // If >5 products updated, treat as bulk

    // Reset state for next batch
    revalidateTimer = null;
    pendingHandles.clear();
    pendingGeneralRevalidate = false;

    const frontendUrl = (process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const revalidateEndpoint = `${frontendUrl}/api/revalidate`;

    if (isBulkUpdate || (handles.length === 0 && needGeneral)) {
      // BULK or GENERAL INVENTORY UPDATE: Only revalidate the homepage/general cache ONCE.
      // The Fastify pricing engine handles real-time prices for all 2,500 product pages 
      // dynamically on the client side — so we don't need to rebuild each product page!
      console.log(`[Webhook] Bulk/general update detected (${handles.length} products, general=${needGeneral}). Revalidating homepage only.`);
      try {
        await fetch(revalidateEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: null }) // null = homepage only
        });
        console.log(`[Webhook] Bulk revalidation complete. Vercel called ONCE.`);
      } catch (err) {
        console.error('[Webhook] Bulk revalidation failed:', err);
      }
    } else {
      // SINGLE / FEW PRODUCT UPDATE: Revalidate homepage + each specific product page.
      console.log(`[Webhook] Single/few product update (${handles.length} products). Revalidating specifically.`);
      for (const h of handles) {
        try {
          await fetch(revalidateEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: h })
          });
          console.log(`[Webhook] Revalidated product: ${h}`);
        } catch (err) {
          console.error(`[Webhook] Failed to revalidate product ${h}:`, err);
        }
      }
      if (needGeneral) {
        try {
          await fetch(revalidateEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: null })
          });
        } catch (err) {
          console.error('[Webhook] General revalidation failed:', err);
        }
      }
    }
  }, DEBOUNCE_MS);
}

module.exports = routes;