/**
 * Store-proximity ordering for collection pages.
 *
 * WHY THIS SHAPE
 * --------------
 * The goal is a TRUE global reorder: for a shopper near Borivali, every product
 * that Borivali has in stock comes first across the whole collection, then
 * Chembur's, and so on — not a shuffle of whichever 25 products happen to be on
 * the current page. A page of 25 cannot be reordered into a global sequence, so
 * the ordering has to be decided over the collection's full id list before any
 * page is sliced.
 *
 * WHERE "IN STOCK AT THIS STORE" COMES FROM
 * -----------------------------------------
 * Shopify already maintains it. The per-store smart collections that merchandising
 * created (chembur-store, sky-city-borivali-store, …) are defined as
 *
 *     variant metafield `custom.in_store_available` CONTAINS <store>
 *     AND variant inventory > 0
 *
 * so membership in one of those collections IS the answer, recomputed by Shopify
 * whenever inventory moves. That means:
 *
 *   • No tag, metafield or collection rule is changed — the exact settings
 *     merchandising configured are the source of truth, read-only.
 *   • Availability is live, not a nightly snapshot.
 *   • Reading it is cheap: ids only, 250 per request, ~2 requests per store,
 *     cached and shared across every collection page.
 *
 * This deliberately does NOT read `custom.in_store_available` off variants in the
 * main product query. That metafield says a piece is *assigned* to a store, not
 * that it is still *there* — the smart collection's `inventory > 0` half is what
 * makes it true. Reading the metafield alone would have re-implemented half the
 * rule and drifted from what merchandising sees in Shopify.
 *
 * CACHING
 * -------
 * Uses the app's existing getServerCache only — no new cache layer. Product and
 * collection webhooks already call clearAllCache(), so both caches refresh when
 * catalogue data changes; the TTLs are a safety net, shorter for the
 * inventory-sensitive half.
 */

const { shopifyStorefrontFetch } = require('./shopify');
const { getServerCache, stableCacheKey } = require('./cache');

const PAGE_SIZE = 250;   // Storefront maximum per page
const MAX_PAGES = 40;    // Safety cap: 10,000 products, same as visibleCounts.js
const HIDDEN_TAG = 'hidden';

// Store membership follows inventory, so it is refreshed more eagerly than the
// collection's own ordering. Both are also webhook-invalidated.
const STORE_IDS_TTL_MS = 15 * 60 * 1000;      // 15 minutes
const ID_ORDER_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours

/**
 * The per-store collections themselves. A shopper browsing /collections/chembur-store
 * is already looking at one store's stock, so proximity ordering there would be
 * redundant at best and confusing at worst — these are excluded from reordering.
 */
const STORE_COLLECTION_HANDLES = new Set([
  'malad',
  'sky-city-borivali-store',
  'chembur-store',
  'pune-store',
  'noida-store',
  'paschim-vihar',
  'lajpat-nagar-store',
]);

const STORE_IDS_QUERY = `
  query StoreProductIds($handle: String!, $after: String) {
    collectionByHandle(handle: $handle) {
      products(first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const ID_ORDER_QUERY = `
  query CollectionIdOrder(
    $handle: String!
    $after: String
    $sortKey: ProductCollectionSortKeys
    $reverse: Boolean
    $filters: [ProductFilter!]
  ) {
    collectionByHandle(handle: $handle) {
      products(first: ${PAGE_SIZE}, after: $after, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
        pageInfo { hasNextPage endCursor }
        nodes { id tags }
      }
    }
  }
`;

const isHidden = (tags) =>
  Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === HIDDEN_TAG);

/**
 * Turn a `stores` query param into a clean, ordered list of store collection
 * handles. Order matters — it is the proximity ranking, nearest first — and only
 * known handles are honoured so the param can never be used to make the server
 * scan arbitrary collections.
 *
 * @param {string} raw comma-separated handles, nearest first
 * @returns {string[]}
 */
function parseStoreHandles(raw) {
  if (!raw) return [];
  const seen = new Set();
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((h) => {
      if (!h || seen.has(h) || !STORE_COLLECTION_HANDLES.has(h)) return false;
      seen.add(h);
      return true;
    });
}

/**
 * Every product id currently in a store's collection — i.e. in stock at that store.
 *
 * @param {string} storeHandle
 * @returns {Promise<Set<string>>} Shopify product GIDs
 */
async function getStoreProductIds(storeHandle) {
  if (!STORE_COLLECTION_HANDLES.has(storeHandle)) return new Set();

  return getServerCache(
    stableCacheKey(['store-product-ids', storeHandle]),
    async () => {
      const ids = new Set();
      let after = null;
      let pages = 0;

      do {
        const data = await shopifyStorefrontFetch(STORE_IDS_QUERY, { handle: storeHandle, after });
        const products = data?.collectionByHandle?.products;
        if (!products) break;

        for (const node of products.nodes || []) {
          if (node?.id) ids.add(node.id);
        }

        pages += 1;
        after = products.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
        if (after && pages >= MAX_PAGES) after = null;
      } while (after);

      return ids;
    },
    { ttlMs: STORE_IDS_TTL_MS, maxEntries: 50 }
  );
}

/**
 * The collection's product ids in the order Shopify would serve them for this
 * sort and these filters, with `hidden`-tagged products removed so the ordering
 * matches what the grid actually renders.
 *
 * Cached per (handle, sort, filters) — the same key granularity the route already
 * uses — so the scan runs once and every page of that view reuses it.
 *
 * @returns {Promise<{ ids: string[], capped: boolean }>}
 *   capped — the scan hit MAX_PAGES; the tail of a very large collection is missing
 *            and the caller should fall back to Shopify's own pagination.
 */
async function getCollectionIdOrder(handle, sortConfig, filters = []) {
  if (!handle || handle === 'all') return { ids: [], capped: true };

  return getServerCache(
    stableCacheKey(['collection-id-order', handle, sortConfig, filters]),
    async () => {
      const ids = [];
      let after = null;
      let pages = 0;
      let capped = false;

      do {
        const data = await shopifyStorefrontFetch(ID_ORDER_QUERY, {
          handle,
          after,
          sortKey: sortConfig?.sortKey,
          reverse: !!sortConfig?.reverse,
          filters,
        });
        const products = data?.collectionByHandle?.products;
        if (!products) break;

        for (const node of products.nodes || []) {
          if (node?.id && !isHidden(node.tags)) ids.push(node.id);
        }

        pages += 1;
        after = products.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
        if (after && pages >= MAX_PAGES) {
          capped = true;
          after = null;
        }
      } while (after);

      return { ids, capped };
    },
    { ttlMs: ID_ORDER_TTL_MS, maxEntries: 500 }
  );
}

/**
 * Reorder ids into store-proximity buckets.
 *
 * A product lands in the bucket of the NEAREST store that has it, and only that
 * one. That is what makes duplication structurally impossible rather than
 * something a later de-dupe pass has to catch: `findIndex` returns a single
 * bucket per product, so a piece in stock at three stores is emitted once, under
 * the closest of the three.
 *
 * Products no store has keep their original relative order at the end. The sort
 * is stable (Array#sort is stable in Node 11+), so within every bucket the
 * collection's own curation order survives untouched.
 *
 * @param {string[]} ids            collection order, hidden already removed
 * @param {Array<Set<string>>} sets one Set per store, NEAREST FIRST
 * @returns {string[]}
 */
function orderIdsByStore(ids, sets) {
  if (!Array.isArray(ids) || !ids.length || !Array.isArray(sets) || !sets.length) {
    return Array.isArray(ids) ? ids.slice() : [];
  }

  const noStore = sets.length; // sorts last
  const bucket = new Map();
  for (const id of ids) {
    const idx = sets.findIndex((s) => s && s.has(id));
    bucket.set(id, idx === -1 ? noStore : idx);
  }

  return ids
    .map((id, i) => ({ id, i, b: bucket.get(id) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.id);
}

/**
 * Pre-populate every store's id set so the FIRST store-ordered request after a
 * cache wipe or a boot does not pay for the scans while a shopper stares at
 * skeletons. Seven small Storefront reads (~0.5s in total, ids only), run
 * detached — nobody waits on this, and a failure just means the next request
 * warms the cache itself exactly as it did before.
 *
 * `allSettled` so one store's hiccup never masks the others, and so the
 * returned promise can never reject into an unhandled-rejection crash.
 */
function warmStoreProductIds() {
  return Promise.allSettled([...STORE_COLLECTION_HANDLES].map((h) => getStoreProductIds(h)));
}

/**
 * Pre-populate the unfiltered Featured id order of the collections whose scan
 * is slow cold (more than one 250-product page) or that carry the most traffic.
 * Both the store-proximity path (default sort + pincode) and "Discount: High to
 * Low" read exactly this cache entry, so without it the first shopper after a
 * boot or a webhook cache wipe waits on a multi-page scan — or gets the
 * un-ordered fallback. Ids and tags only, two at a time, detached; never rejects.
 */
const WARM_COLLECTION_HANDLES = (process.env.WARM_COLLECTION_HANDLES ||
  'lucira-express,rings,solitaires,earrings,engagement-rings,9kt-collection,bracelets,bestsellers')
  .split(',').map((h) => h.trim()).filter(Boolean);
const MANUAL_SORT = { sortKey: 'MANUAL', reverse: false }; // must equal SORT_MAP.manual (cache key)

async function warmCollectionIdOrders() {
  const queue = [...WARM_COLLECTION_HANDLES];
  const worker = async () => {
    while (queue.length) {
      const handle = queue.shift();
      await getCollectionIdOrder(handle, MANUAL_SORT, []).catch(() => {});
    }
  };
  await Promise.allSettled([worker(), worker()]);
}

module.exports = {
  STORE_COLLECTION_HANDLES,
  warmCollectionIdOrders,
  parseStoreHandles,
  getStoreProductIds,
  getCollectionIdOrder,
  orderIdsByStore,
  warmStoreProductIds,
};
