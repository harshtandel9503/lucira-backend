const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { clearAllCache } = require('./lib/cache');
const { warmStoreProductIds, warmCollectionIdOrders } = require('./lib/storeAvailability');
const { startDiscountIndex, discountIndexStatus } = require('./lib/discountIndex');
const { startRecoScheduler } = require('./lib/recoScheduler');
const { startSmartSortScheduler } = require('./lib/smartSortScheduler');
const { startDiamondShapeScheduler } = require('./lib/diamondShapeScheduler');
const { startGemstoneScheduler } = require('./lib/gemstoneScheduler');
const { startOccasionCouponScheduler } = require('./lib/occasionCouponScheduler');
const { getSkuIndex, attachSkuIndexStore, ensureSkuIndexIndexes, skuIndexStatus } = require('./lib/skuIndex');
const { governorStats } = require('./lib/shopify');

const fastify = require('fastify')({
  ignoreTrailingSlash: true,
  pluginTimeout: 30000,
  logger: true,
  bodyLimit: 10485760, // 10MB
  trustProxy: true
});

// ======================
// Plugins
// ======================

fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']
});

const mongoUri = process.env.NODE_ENV === 'development' 
  ? (process.env.LOCAL_MONGODB_URI || process.env.MONGODB_URI) 
  : process.env.MONGODB_URI;

fastify.register(require('@fastify/mongodb'), {
  url: mongoUri,
  // @fastify/mongodb defaults this to 7500ms, which is tight for an Atlas
  // replica set: the driver has to reach a seed, do TLS, learn the topology and
  // find a primary — several round trips. On a slow link that overran the
  // budget and startup died with ReplicaSetNoPrimary (all nodes "Unknown",
  // commonWireVersion 0) even though the cluster was healthy. 30s is the
  // MongoDB driver's own default and costs nothing when the network is fine.
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000)
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 5242880 // 5MB
  }
});

// ======================
// Health Check
// ======================

fastify.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    // Live Shopify cost-bucket level, queue depths and learned per-operation
    // costs. Here so a throttle can be diagnosed from the outside without
    // adding logging or attaching to the process.
    shopify: governorStats(),
    skuIndex: skuIndexStatus(),
    discountIndex: discountIndexStatus()
  };
});

// ======================
// Request Logger
// ======================

fastify.addHook('onRequest', async (request) => {
  console.log(`▶ [${process.pid}] ${request.method} ${request.url}`);
});

// ======================
// Routes
// ======================

fastify.register(require('./routes/cart'), { prefix: '/api/cart' });
fastify.register(require('./routes/wishlist'), { prefix: '/api/wishlist' });
fastify.register(require('./routes/pincodes'), { prefix: '/api/pincodes' });
fastify.register(require('./routes/settings'), { prefix: '/api/settings' });
fastify.register(require('./routes/stores'), { prefix: '/api/stores' });
fastify.register(require('./routes/shopify'), { prefix: '/api/shopify' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });
fastify.register(require('./routes/collection'), { prefix: '/api/collection' });
fastify.register(require('./routes/products'), { prefix: '/api/products' });
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/customer'), { prefix: '/api/customer' });
fastify.register(require('./routes/schemes'), { prefix: '/api/customer/schemes' });
fastify.register(require('./routes/schemes-payment'), { prefix: '/api/schemes' });
fastify.register(require('./routes/reviews'), { prefix: '/api/reviews' });
fastify.register(require('./routes/webhooks'), { prefix: '/api/webhooks' });
fastify.register(require('./routes/pincodeLookup'), { prefix: '/api/pincode' });
fastify.register(require('./routes/nitro'), { prefix: '/api/nitro' });
fastify.register(require('./routes/searchAnalytics'), { prefix: '/api/analytics/search' });
fastify.register(require('./routes/recommendations'), { prefix: '/api/recommendations' });
fastify.register(require('./routes/smartCollections'), { prefix: '/api/smart-collections' });
fastify.register(require('./routes/diamondShape'), { prefix: '/api/diamond-shape' });
fastify.register(require('./routes/gemstone'), { prefix: '/api/gemstone' });
fastify.register(require('./routes/productEvents'), { prefix: '/api/products' });
fastify.register(require('./routes/tracking'), { prefix: '/api/track' });
fastify.register(require('./routes/clickpost'), { prefix: '/api/clickpost' });
fastify.register(require('./routes/dgrp'), { prefix: '/api/dgrp' });

// Global /api routes
fastify.register(async (instance) => {
  instance.register(require('./routes/promotions'));
  instance.register(require('./routes/rates'));
  instance.register(require('./routes/social'));
  instance.register(require('./routes/checkout'));
}, { prefix: '/api' });

// ======================
// Cache Clear API
// ======================

fastify.get('/api/clear-cache', async () => {
  clearAllCache();
  // Rebuild the per-store stock sets off the request path (see webhooks.js).
  warmStoreProductIds();

  console.log('🧹 Fastify cache cleared');

  return {
    success: true,
    message: 'Backend cache cleared'
  };
});

// ======================
// Graceful Shutdown
// ======================

const closeGracefully = async (signal) => {
  console.log(`⚠️ Received ${signal}. Closing server gracefully...`);

  try {
    await fastify.close();
    console.log('✅ Fastify closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error while closing Fastify:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => closeGracefully('SIGINT'));
process.on('SIGTERM', () => closeGracefully('SIGTERM'));

// Node 24 terminates the process on an unhandled rejection. That is the wrong
// trade for this server: a detached background job (SKU index warm-up, a
// scheduler tick, a scan) failing on a transient Shopify error must not take
// down live checkout traffic. A real case: one `Throttled` response inside the
// boot warm-up killed the whole backend.
//
// Logged loudly rather than swallowed — every one of these is a missing
// .catch() somewhere and should be fixed at the source.
process.on('unhandledRejection', (reason) => {
  console.error('🔥 UNHANDLED REJECTION (server kept alive — fix the missing .catch):',
    reason instanceof Error ? reason.stack : reason);
});

// ======================
// Start Server
// ======================

const start = async () => {
  try {
    const port = process.env.PORT || 8080;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({
      port,
      host,
      exclusive: false
    });

    console.log(
      `🚀 Lucira Backend running at http://${host}:${port} | PID: ${process.pid}`
    );

    await startRecoScheduler(fastify);

    // Store-proximity ordering needs one id set per store. Warm them now so the
    // first pincoded shopper after a deploy is not the one who pays for the
    // scans. Seven small Storefront reads, detached, and allSettled inside so
    // it can never reject — no relation to the Admin cost bucket that the SKU
    // warm-up below has to be careful about.
    warmStoreProductIds();
    // Featured id orders of the big collections: read by the pincode ordering
    // and by "Discount: High to Low". Detached, never rejects.
    warmCollectionIdOrders();
    // The discount index: one Mongo read on a normal boot; a background
    // Storefront walk (~45s) only when there is no fresh stored copy.
    startDiscountIndex(fastify.mongo.db).catch((err) =>
      console.error('[DiscountIndex] start failed (Discount sort will serve Featured order):', err.message));

    // Warm the variant-SKU index: GA4 item ids are mostly variant SKUs, and
    // everything that reads GA (previews, stats refreshes) is blind to them
    // until it is loaded.
    //
    // It is persisted in Mongo now, so on a normal restart this is a single
    // Mongo read and ZERO Shopify requests — it used to be a ~398-page Admin
    // scan per worker per boot, which is what saturated the shop's cost bucket
    // and threw `Throttled`. A rebuild only happens once the copy ages past
    // its TTL, runs under a cross-worker lease, and is queued in the governor's
    // background lane so it always yields to shopper traffic.
    //
    // The lease index is AWAITED for the same reason the schedulers await
    // theirs: without it the upsert never trips 11000, every worker "wins",
    // and the guard silently degrades to no guard.
    try {
      await ensureSkuIndexIndexes(fastify.mongo.db);
      attachSkuIndexStore(fastify.mongo.db);
      // Detached on purpose — nobody waits on the warm-up. The .catch is what
      // keeps a Shopify hiccup from becoming an unhandled rejection that kills
      // the process (Node 24 exits on unhandled rejections by default).
      getSkuIndex({ wait: false }).catch((err) =>
        console.error('[SkuIndex] warm-up failed (non-fatal):', err.message));
    } catch (err) {
      console.error('[SkuIndex] store not attached — the index will be memory-only ' +
        'and rebuilt per worker:', err.message);
    }

    await startSmartSortScheduler(fastify);

    // Diamond and Gemstone filters: optional daily/weekly "Sync all", configured
    // on their dashboard pages (off until someone turns it on there).
    await startDiamondShapeScheduler(fastify);
    await startGemstoneScheduler(fastify);
    await startOccasionCouponScheduler(fastify);

  } catch (err) {
    console.error('❌ STARTUP ERROR');
    console.error(err);

    fastify.log.error(err);

    process.exit(1);
  }
};

start();