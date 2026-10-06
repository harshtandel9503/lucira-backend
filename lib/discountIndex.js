/**
 * Card discount index — powers "Discount: High to Low" on collection pages.
 *
 * WHY AN INDEX
 * ------------
 * Shopify has no discount sort key, and the discount a shopper sees is not a
 * product field: it is the % off on the ONE variant the card prices. Working
 * that out at request time means reading every variant of every product in the
 * collection — measured 29 Sep 2026 at 15s for earrings and 76s for
 * lucira-express. So it is computed ahead of time, off the request path, and a
 * page request only does a Map lookup per product id (sub-millisecond).
 *
 * WHAT IS STORED
 * --------------
 * product GID -> { d, d9 }: the rounded discount % exactly as the card shows it
 * (`d`), plus the value in 9kt-collection (`d9`, only where it differs) because
 * the card picks the 9KT variant there. Rounded on purpose: the sort follows
 * the badge the shopper reads, and equal badges fall back to Featured order
 * (see routes/collection.js) so merchandising still decides within a tie.
 *
 * WHICH VARIANT, WHICH PRICE — mirrors lucira-frontend ProductCard.jsx
 * --------------------------------------------------------------------
 * Variant: getPrioritizedVariant() — 9KT first in 9kt-collection (in-stock,
 * else first 9KT), else the first in-stock variant (an in-stock Yellow Gold one
 * first for any productType containing "ring", "earrings" included, as the card
 * does), else the first variant. routes/collection.js trims variants before the
 * card sees them, but the trim keeps every variant those rules can land on, so
 * running them on the full list gives the same pick.
 * Price: the card's live Storefront variant price. Compare price: the live
 * compareAtPrice, but Shopify stores "0.0" on some variants (66 of 2,789
 * products, all charms, when measured) and 0 is falsy, so the card falls back
 * to the listing payload's compare price — the DI-GoldPrice breakup's
 * original_total — for its own variant, then for the route's selectedVariant.
 * Those few are resolved with the same calculatePriceBreakup the route uses.
 *
 * DATA SOURCE: one Storefront walk of the whole store — 2,789 products / ~99k
 * variants / 28 requests / ~45s. Storefront, not Admin, so it never touches the
 * Admin cost bucket that cart and checkout share, and it sees exactly what the
 * card sees (variant-level publishing, variants(first: 100)).
 *
 * FRESHNESS
 *   - product / inventory webhooks mark products dirty; a debounced flush
 *     re-reads just those products. A burst above FULL_REBUILD_THRESHOLD (the
 *     daily bulk price update is ~2,500 webhooks) becomes one full rebuild.
 *   - a full rebuild whenever the copy is older than TTL_MS (checked hourly).
 *   - persisted in Mongo (`product_discount_index`) and read back on boot, so a
 *     restart costs zero Shopify requests; any worker that sees the stored
 *     version move reloads, so every worker serves the same order.
 */

const { shopifyStorefrontFetch, shopifyAdminFetch, getShopPricingData } = require('./shopify');
const { calculatePriceBreakup } = require('./priceEngine');

const COLLECTION = 'product_discount_index';
const LEASE_KEY = 'discount_index_lease';
const NINE_KT_HANDLE = '9kt-collection';

const PAGE_SIZE = 100;                     // products per Storefront page (~0.9MB, ~1.6s)
const MAX_PAGES = 200;                     // 20k products ceiling
const REFRESH_CHUNK = 50;                  // products per incremental Storefront read
const TTL_MS = Number(process.env.DISCOUNT_INDEX_TTL_MS) || 24 * 60 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const STALE_CHECK_MS = 60 * 60 * 1000;     // hourly: rebuild once past TTL_MS
const SYNC_MS = 2 * 60 * 1000;             // pick up other workers' writes
const FLUSH_QUIET_MS = 30 * 1000;          // webhook debounce
const FLUSH_MAX_WAIT_MS = 5 * 60 * 1000;   // ...but never hold changes longer than this
const BURST_MAX_WAIT_MS = 30 * 60 * 1000;  // a burst rebuilds once it goes quiet, or after this
const FULL_REBUILD_THRESHOLD =Number(process.env.DISCOUNT_INDEX_FULL_REBUILD_THRESHOLD) || 150;

const VARIANT_FIELDS = `
  id title price { amount } compareAtPrice { amount }
  availableForSale currentlyNotInStock selectedOptions { name value }
`;
const PRODUCT_FIELDS = `id productType variants(first: 100) { nodes { ${VARIANT_FIELDS} } }`;

const PRODUCTS_PAGE_QUERY = `
  query DiscountIndexPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;
const PRODUCTS_BY_IDS_QUERY = `
  query DiscountIndexProducts($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } }
  }
`;
const VARIANT_CONFIG_QUERY = `
  query DiscountIndexVariantConfigs($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } }
    }
  }
`;
const INVENTORY_ITEM_PRODUCTS_QUERY = `
  query DiscountIndexInventoryItems($ids: [ID!]!) {
    nodes(ids: $ids) { ... on InventoryItem { variant { product { id } } } }
  }
`;

// ---------------------------------------------------------------------------
// The card's own variant choice and discount
// ---------------------------------------------------------------------------

/** Storefront variant -> the fields the card reads (see routes/collection.js). */
function toCardVariant(v) {
  const options = {};
  (v.selectedOptions || []).forEach((o) => { options[String(o.name || '').toLowerCase()] = o.value; });
  const color = ['color', 'metal', 'metal color'].map((k) => options[k]).find((x) => x !== undefined) ?? null;
  const cmp = v.compareAtPrice ? Number(v.compareAtPrice.amount) : null;
  return {
    id: v.id,
    label: String(color || v.title || ''),
    inStock: v.availableForSale === true && v.currentlyNotInStock === false,
    price: Number(v.price?.amount || 0),
    compare: cmp,
  };
}

/** ProductCard.jsx getPrioritizedVariant(), on the card-shaped variants. */
function pickCardVariant(productType, variants, nineKt) {
  if (!variants.length) return null;
  const inStock = variants.filter((v) => v.inStock);
  if (nineKt) {
    const nine = variants.filter((v) => v.label.includes('9KT'));
    if (nine.length) return nine.find((v) => v.inStock) || nine[0];
  }
  if (inStock.length) {
    if (String(productType || '').toLowerCase().includes('ring')) {
      const yg = inStock.find((v) => v.label.includes('Yellow Gold'));
      if (yg) return yg;
    }
    return inStock[0];
  }
  return variants[0];
}

const percentOff = (price, compare) =>
  compare && compare > price ? Math.round(((compare - price) / compare) * 100) : 0;

/**
 * Both discounts for one Storefront product. `needsPayload` lists the variants
 * whose live compare price is 0/null — the card then reads the listing
 * payload's compare price, which only the price engine can produce.
 */
function evaluateProduct(node) {
  const variants = (node.variants?.nodes || []).map(toCardVariant);
  if (!variants.length) return null;
  // routes/collection.js: selectedVariant = first in stock, else first. The card
  // uses its compare price as the last fallback.
  const selected = variants.find((v) => v.inStock) || variants[0];
  const out = {};
  for (const [key, nineKt] of [['d', false], ['d9', true]]) {
    const pick = pickCardVariant(node.productType, variants, nineKt);
    out[key] = { pick, selected };
  }
  return out;
}

/** Resolve an evaluation to the two numbers, using payload compare prices where needed. */
function resolveDiscounts(evaluation, payloadCompare) {
  const value = ({ pick, selected }) => {
    if (!pick) return 0;
    const compare = pick.compare || payloadCompare.get(pick.id) || payloadCompare.get(selected.id) || null;
    return percentOff(pick.price, compare);
  };
  const d = value(evaluation.d);
  const d9 = value(evaluation.d9);
  return d9 === d ? { d } : { d, d9 };
}

/**
 * routes/collection.js payload compare price for these variant ids:
 * breakup.original_total when above total, else the variant's own
 * compareAtPrice (0 here, which the card treats as absent).
 */
async function payloadComparePrices(variantIds) {
  const out = new Map();
  if (!variantIds.length) return out;
  const { metalRates, stonePricingDB } = await getShopPricingData();
  for (let i = 0; i < variantIds.length; i += 100) {
    const data = await shopifyStorefrontFetch(VARIANT_CONFIG_QUERY, { ids: variantIds.slice(i, i + 100) });
    for (const n of data?.nodes || []) {
      if (!n?.config?.value) continue;
      try {
        const breakup = calculatePriceBreakup(JSON.parse(n.config.value), metalRates, stonePricingDB);
        if (breakup.original_total > breakup.total) out.set(n.id, breakup.original_total);
      } catch (e) { /* unpriceable config: no payload compare, same as the route */ }
    }
  }
  return out;
}

/** Storefront product nodes -> Map(gid -> {d, d9?}). */
async function discountsFor(nodes) {
  const evaluations = [];
  const missing = new Set();
  for (const node of nodes) {
    if (!node?.id) continue;
    const ev = evaluateProduct(node);
    if (!ev) continue;
    evaluations.push([node.id, ev]);
    for (const { pick, selected } of [ev.d, ev.d9]) {
      if (pick && !pick.compare) { missing.add(pick.id); missing.add(selected.id); }
    }
  }
  const payloadCompare = await payloadComparePrices([...missing]);
  const map = new Map();
  for (const [id, ev] of evaluations) map.set(id, resolveDiscounts(ev, payloadCompare));
  return map;
}

// ---------------------------------------------------------------------------
// In-memory state + Mongo persistence
// ---------------------------------------------------------------------------
let _db = null;
let _mem = { map: null, builtAt: 0, version: 0, building: null };
let _timers = [];

async function loadFromMongo(db) {
  const col = db.collection(COLLECTION);
  const meta = await col.findOne({ _id: 'meta' });
  if (!meta?.builtAt) return null;
  const docs = await col.find({ _id: { $ne: 'meta' } }, { projection: { d: 1, d9: 1 } }).toArray();
  const map = new Map();
  for (const doc of docs) map.set(doc._id, doc.d9 === undefined ? { d: doc.d } : { d: doc.d, d9: doc.d9 });
  return { map, builtAt: new Date(meta.builtAt).getTime(), version: meta.version || 0 };
}

/** Bump the shared version so other workers reload; returns the new version. */
async function bumpVersion(db, fields = {}) {
  const res = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: 'meta' },
    { $inc: { version: 1 }, $set: { updatedAt: new Date(), ...fields } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = res?.value !== undefined ? res.value : res; // driver v5 vs v6 return shape
  return doc?.version || 0;
}

async function writeEntries(db, entries, removedIds = []) {
  const col = db.collection(COLLECTION);
  const now = new Date();
  const ops = [];
  for (const [id, v] of entries) {
    ops.push({ replaceOne: { filter: { _id: id }, replacement: { ...v, at: now }, upsert: true } });
  }
  for (const id of removedIds) ops.push({ deleteOne: { filter: { _id: id } } });
  for (let i = 0; i < ops.length; i += 1000) await col.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
}

// Same atomic lease as lib/skuIndex.js — one worker walks the store at a time.
async function acquireLease(db) {
  const now = new Date();
  try {
    await db.collection('settings').findOneAndUpdate(
      { key: LEASE_KEY, $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $lte: now } }] },
      { $set: { expiresAt: new Date(now.getTime() + LEASE_MS), pid: process.pid, updatedAt: now } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}
const releaseLease = (db) =>
  db.collection('settings').updateOne({ key: LEASE_KEY }, { $set: { expiresAt: new Date(0) } }).catch(() => {});

async function ensureDiscountIndexIndexes(db) {
  await db.collection('settings').createIndex(
    { key: 1 },
    { unique: true, partialFilterExpression: { key: LEASE_KEY }, name: 'discount_index_lease_unique' }
  );
}

// ---------------------------------------------------------------------------
// Full rebuild
// ---------------------------------------------------------------------------
async function walkStore() {
  const map = new Map();
  let after = null;
  let pages = 0;
  const startedAt = Date.now();
  do {
    const data = await shopifyStorefrontFetch(PRODUCTS_PAGE_QUERY, { first: PAGE_SIZE, after });
    const conn = data?.products;
    if (!conn) throw new Error('products connection returned nothing');
    const page = await discountsFor(conn.nodes || []);
    page.forEach((v, k) => map.set(k, v));
    pages += 1;
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    if (after && pages >= MAX_PAGES) throw new Error(`walk hit the ${MAX_PAGES}-page ceiling`);
  } while (after);
  console.log(`[DiscountIndex] built: ${map.size} products (${pages} pages, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
  return map;
}

async function rebuild(reason) {
  if (_mem.building) return _mem.building;
  _mem.building = (async () => {
    const db = _db;
    if (db && !(await acquireLease(db).catch(() => true))) {
      console.log('[DiscountIndex] another worker is rebuilding — skipping');
      return;
    }
    try {
      console.log(`[DiscountIndex] rebuilding (${reason})`);
      const map = await walkStore();
      if (!map.size) return;
      const previous = _mem.map;
      _mem = { ..._mem, map, builtAt: Date.now() };
      if (db) {
        const removed = previous ? [...previous.keys()].filter((id) => !map.has(id)) : [];
        await writeEntries(db, map, removed);
        // A product removed before this worker ever loaded it is caught here.
        await db.collection(COLLECTION).deleteMany({ _id: { $ne: 'meta' }, at: { $lt: new Date(_mem.builtAt - 60000) } });
        _mem.version = await bumpVersion(db, { builtAt: new Date(_mem.builtAt), size: map.size });
      }
    } catch (err) {
      console.error('[DiscountIndex] rebuild failed (serving the previous copy):', err.message);
    } finally {
      if (db) await releaseLease(db);
    }
  })().finally(() => { _mem.building = null; });
  return _mem.building;
}

// ---------------------------------------------------------------------------
// Incremental refresh from webhooks
// ---------------------------------------------------------------------------
const dirty = { products: new Set(), inventoryItems: new Set(), timer: null, firstAt: 0 };

async function productIdsForInventoryItems(itemIds) {
  const ids = new Set();
  for (let i = 0; i < itemIds.length; i += 100) {
    const gids = itemIds.slice(i, i + 100).map((id) => (String(id).startsWith('gid://') ? id : `gid://shopify/InventoryItem/${id}`));
    const data = await shopifyAdminFetch(INVENTORY_ITEM_PRODUCTS_QUERY, { ids: gids }, { priority: 'background' });
    for (const n of data?.nodes || []) if (n?.variant?.product?.id) ids.add(n.variant.product.id);
  }
  return [...ids];
}

async function refreshProducts(productIds) {
  const updated = new Map();
  const removed = [];
  for (let i = 0; i < productIds.length; i += REFRESH_CHUNK) {
    const chunk = productIds.slice(i, i + REFRESH_CHUNK);
    const data = await shopifyStorefrontFetch(PRODUCTS_BY_IDS_QUERY, { ids: chunk });
    const nodes = data?.nodes || [];
    const got = await discountsFor(nodes.filter(Boolean));
    // nodes(ids:) answers in order; null = deleted or unpublished from the storefront.
    chunk.forEach((id, k) => { if (!nodes[k]) removed.push(id); });
    got.forEach((v, k) => updated.set(k, v));
  }
  if (_mem.map) {
    updated.forEach((v, k) => _mem.map.set(k, v));
    removed.forEach((id) => _mem.map.delete(id));
  }
  if (_db && (updated.size || removed.length)) {
    await writeEntries(_db, updated, removed);
    _mem.version = await bumpVersion(_db);
  }
  console.log(`[DiscountIndex] refreshed ${updated.size} product(s), removed ${removed.length}`);
}

async function flushDirty() {
  dirty.timer = null;
  const products = [...dirty.products];
  const items = [...dirty.inventoryItems];
  dirty.products.clear();
  dirty.inventoryItems.clear();
  dirty.firstAt = 0;
  try {
    if (products.length + items.length > FULL_REBUILD_THRESHOLD || !_mem.map) {
      await rebuild(`${products.length} product + ${items.length} inventory change(s)`);
      return;
    }
    const fromInventory = items.length ? await productIdsForInventoryItems(items) : [];
    const ids = [...new Set([...products, ...fromInventory])];
    if (ids.length) await refreshProducts(ids);
  } catch (err) {
    console.error('[DiscountIndex] incremental refresh failed (next rebuild will catch it):', err.message);
  }
}

function scheduleFlush() {
  const now = Date.now();
  if (!dirty.firstAt) dirty.firstAt = now;
  if (dirty.timer) clearTimeout(dirty.timer);
  // A burst big enough to become a full rebuild (the daily bulk price update is
  // ~2,500 webhooks over many minutes) waits for the burst to go quiet, so it
  // rebuilds ONCE at the end instead of every FLUSH_MAX_WAIT_MS while it runs.
  // BURST_MAX_WAIT_MS still bounds it if the webhooks never stop.
  const isBurst = dirty.products.size + dirty.inventoryItems.size > FULL_REBUILD_THRESHOLD;
  const maxWait = isBurst ? BURST_MAX_WAIT_MS : FLUSH_MAX_WAIT_MS;
  const wait = Math.max(0, Math.min(FLUSH_QUIET_MS, dirty.firstAt + maxWait - now));
  dirty.timer = setTimeout(() => { flushDirty(); }, wait);
}

/** products/* webhook. Accepts a product GID or numeric id. */
function noteProductChanged(id) {
  if (!id) return;
  dirty.products.add(String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`);
  scheduleFlush();
}

/** inventory_* webhooks carry an inventory item id, not a product id. */
function noteInventoryItemChanged(itemId) {
  if (!itemId) return;
  dirty.inventoryItems.add(String(itemId));
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Boot + request-path API
// ---------------------------------------------------------------------------
async function syncFromMongo() {
  if (!_db || _mem.building) return;
  try {
    const meta = await _db.collection(COLLECTION).findOne({ _id: 'meta' }, { projection: { version: 1 } });
    if (!meta || (meta.version || 0) === _mem.version) return;
    const loaded = await loadFromMongo(_db);
    if (loaded?.map?.size) _mem = { ..._mem, map: loaded.map, builtAt: loaded.builtAt, version: loaded.version };
  } catch (err) {
    console.error('[DiscountIndex] sync from Mongo failed:', err.message);
  }
}

/**
 * Call once at boot, after Mongo is up. Never throws; never blocks on Shopify.
 */
async function startDiscountIndex(db) {
  _db = db || null;
  if (_db) {
    try {
      await ensureDiscountIndexIndexes(_db);
      const loaded = await loadFromMongo(_db);
      if (loaded?.map?.size) {
        _mem = { ..._mem, map: loaded.map, builtAt: loaded.builtAt, version: loaded.version };
        console.log(`[DiscountIndex] loaded ${loaded.map.size} products from Mongo (${Math.round((Date.now() - loaded.builtAt) / 60000)}m old) — 0 Shopify requests`);
      }
    } catch (err) {
      console.error('[DiscountIndex] Mongo unavailable, index will be memory-only:', err.message);
    }
  }
  if (!_mem.map || Date.now() - _mem.builtAt >= TTL_MS) rebuild(_mem.map ? 'stale at boot' : 'no stored copy');

  _timers.forEach(clearInterval);
  _timers = [
    setInterval(() => { if (Date.now() - _mem.builtAt >= TTL_MS) rebuild('daily refresh'); }, STALE_CHECK_MS),
    setInterval(syncFromMongo, SYNC_MS),
  ];
  _timers.forEach((t) => t.unref?.());
}

/**
 * Synchronous lookup for the request path. Returns null until the first copy
 * is loaded — the caller then serves Featured order instead of a fake sort.
 */
function getDiscountLookup(collectionHandle) {
  const map = _mem.map;
  if (!map || !map.size) return null;
  const nineKt = collectionHandle === NINE_KT_HANDLE;
  return (productId) => {
    const e = map.get(productId);
    if (!e) return 0; // not indexed yet (brand-new product): sorts with the undiscounted
    return nineKt && e.d9 !== undefined ? e.d9 : e.d;
  };
}

function discountIndexStatus() {
  return {
    loaded: !!_mem.map,
    size: _mem.map ? _mem.map.size : 0,
    builtAt: _mem.builtAt ? new Date(_mem.builtAt).toISOString() : null,
    ageMinutes: _mem.builtAt ? Math.round((Date.now() - _mem.builtAt) / 60000) : null,
    version: _mem.version,
    rebuilding: !!_mem.building,
    pendingChanges: dirty.products.size + dirty.inventoryItems.size,
  };
}

module.exports = {
  startDiscountIndex,
  getDiscountLookup,
  noteProductChanged,
  noteInventoryItemChanged,
  discountIndexStatus,
  rebuildDiscountIndex: rebuild,
  // exported for the parity test
  _test: { evaluateProduct, resolveDiscounts, pickCardVariant, toCardVariant },
};
