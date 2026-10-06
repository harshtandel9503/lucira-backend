/**
 * Collection Routes (Fastify)
 */

const { shopifyStorefrontFetch, shopifyAdminFetch, shopifyAdminRestFetch } = require('../lib/shopify');
const { calculatePriceBreakup } = require('../lib/priceEngine');
const { getServerCache, stableCacheKey } = require('../lib/cache');
const { getCollectionVisibleStats } = require('../lib/visibleCounts');
const {
  STORE_COLLECTION_HANDLES,
  parseStoreHandles,
  getStoreProductIds,
  getCollectionIdOrder,
  orderIdsByStore,
} = require('../lib/storeAvailability');
const { getDiscountLookup } = require('../lib/discountIndex');

const SORT_MAP = {
  manual: { sortKey: "MANUAL", reverse: false },
  // Shopify has no discount key. Ordered by lib/discountIndex.js over the
  // collection's Featured order (below); MANUAL is what the metadata query and
  // the fallback use, so a fallback is honestly Featured, not a random order.
  discount_desc: { sortKey: "MANUAL", reverse: false },
  best_selling: { sortKey: "BEST_SELLING", reverse: false },
  price_low_high: { sortKey: "PRICE", reverse: false },
  price_high_low: { sortKey: "PRICE", reverse: true },
  created_at_desc: { sortKey: "CREATED", reverse: true },
  created_at_asc: { sortKey: "CREATED", reverse: false },
  az: { sortKey: "TITLE", reverse: false },
};

/**
 * The product selection set, shared by the paginated collection query and the
 * fetch-these-exact-ids query used for store-proximity ordering.
 *
 * Deliberately lean. A page is 25 products but ~2,000 variants, so every
 * per-variant field is multiplied by that: the five ornaverse metafields that
 * used to sit here (gross_weight, top_width, top_height, diamonds, gemstones)
 * and the per-product description/descriptionHtml were never read by the
 * transform below, yet made the page ~2.9MB and ~2.5s from Shopify. Only what
 * the transform actually consumes is requested.
 *
 * `variant_config` (DI-GoldPrice) is the dynamic-pricing input. It is exposed
 * to the Storefront API, so it rides along in this one query instead of a
 * second fan-out of up to ~22 Admin API calls per page (~2.5s, and rate-limited
 * by the shop's cost bucket, so it also competed with cart and checkout).
 *
 * Extracted so the two can never drift: both paths must return an identically
 * shaped product to the same transform below, and duplicating forty lines of
 * selection set is the reliable way to end up with one of them missing a field.
 */
const PRODUCT_NODE_FIELDS = `
  id title handle productType createdAt tags featuredImage { url }
  productMetafields: metafields(identifiers: [
    {namespace: "ornaverse", key: "weight"},
    {namespace: "ornaverse", key: "quality"},
    {namespace: "ornaverse", key: "carat_range"},
    {namespace: "ornaverse", key: "lead_time"},
    {namespace: "ornaverse", key: "components"},
    {namespace: "ornaverse", key: "bestsellers"},
    {namespace: "custom", key: "matching_product"},
    {namespace: "custom", key: "has_virtual_tryon"}
  ]) { key value }
  media(first: 20) {
    edges {
      node {
        mediaContentType
        ... on MediaImage { image { url altText } }
        ... on Video { sources { url mimeType } }
      }
    }
  }
  variants(first: 100) {
    edges {
      node {
        id title sku price { amount } compareAtPrice { amount }
        availableForSale currentlyNotInStock selectedOptions { name value }
        image { url altText }
        metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value }
        components: metafield(namespace: "ornaverse", key: "components") { value }
        variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
      }
    }
  }
`;

/** Fetch a specific, already-ordered page of products by id. */
const PRODUCTS_BY_IDS_QUERY = `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { ${PRODUCT_NODE_FIELDS} }
    }
  }
`;

// How long a request will wait for store-proximity ordering before giving up and
// serving Shopify's own order. Tuned above a warm resolve (~single-digit ms) and
// below the point a shopper reads the grid as broken.
const STORE_ORDER_BUDGET_MS = Number(process.env.STORE_ORDER_BUDGET_MS) || 1500;
// Same idea for "Discount: High to Low". Longer, because the shopper explicitly
// asked for this order and a fallback shows Featured instead; the id scan it
// waits on is pre-warmed for the large collections (warmCollectionIdOrders).
const DISCOUNT_ORDER_BUDGET_MS = Number(process.env.DISCOUNT_ORDER_BUDGET_MS) || 4000;
const DISCOUNT_SORT_ENABLED = process.env.DISCOUNT_SORT_ENABLED !== 'false';

// An ordered view pages with a numeric offset; Shopify's cursors are opaque
// base64. A request carrying a Shopify cursor belongs to a view whose FIRST page
// fell back to Shopify paging, and must keep paging that way — reading it as an
// offset (parseInt -> NaN -> 0) would restart the ordered list from the top and
// mix two orders in one grid.
const isOffsetCursor = (cursor) => cursor == null || cursor === '' || /^\d+$/.test(String(cursor));

const collectionCountCache = new Map();
const SHOP_PRICING_CACHE_TTL = 24 * 60 * 60 * 1000;
const PRODUCT_DATA_CACHE_TTL = 24 * 60 * 60 * 1000;
const VARIANT_CONFIG_CACHE_TTL = 24 * 60 * 60 * 1000;
// Same lifetime as the route's own response cache below — the metadata is a
// slice of exactly that response.
const COLLECTION_META_CACHE_TTL = 10 * 60 * 1000;

async function routes(fastify, options) {
  
  const getShopPricingData = () =>
    getServerCache(
      "shop-pricing-data",
      async () => {
        const shopPricingQuery = `
          query {
            shop {
              metalPrices: metafield(namespace: "DI-GoldPrice", key: "metal_prices") { value }
              stonePricing: metafield(namespace: "DI-GoldPrice", key: "stone_pricing") { value }
            }
          }
        `;
        const shopData = await shopifyAdminFetch(shopPricingQuery);

        return {
          metalRates: shopData?.shop?.metalPrices?.value ? JSON.parse(shopData.shop.metalPrices.value) : {},
          stonePricingDB: shopData?.shop?.stonePricing?.value ? JSON.parse(shopData.shop.stonePricing.value) : [],
        };
      },
      { ttlMs: SHOP_PRICING_CACHE_TTL, maxEntries: 20 }
    );

  const getCollectionTotalCount = async (handle) => {
    const cacheKey = `collection-count:${handle}`;
    if (collectionCountCache.has(cacheKey)) {
      return collectionCountCache.get(cacheKey);
    }

    try {
      const collectionQuery = `query GetCollectionId($handle: String!) { collectionByHandle(handle: $handle) { id } }`;
      const collData = await shopifyAdminFetch(collectionQuery, { handle });
      const gid = collData?.collectionByHandle?.id;
      if (!gid) return 0;

      const collectionId = gid.split("/").pop();
      const countRes = await shopifyAdminRestFetch(`products/count.json`, {
        collection_id: collectionId,
        status: "active",
        published_status: "published"
      });

      const count = countRes?.data?.count ?? 0;
      collectionCountCache.set(cacheKey, count);
      setTimeout(() => collectionCountCache.delete(cacheKey), 24 * 60 * 60 * 1000);
      return count;
    } catch (e) {
      return 0;
    }
  };

  const parseFilters = (rawFilters) => {
    if (!rawFilters) return [];
    try {
      const parsed = typeof rawFilters === "string" ? JSON.parse(rawFilters) : rawFilters;
      if (Array.isArray(parsed)) return parsed;
      const shopifyFilters = [];
      Object.values(parsed).forEach((group) => {
        if (!Array.isArray(group)) return;
        group.forEach((opt) => {
          if (!opt?.input) return;
          shopifyFilters.push(typeof opt.input === "string" ? JSON.parse(opt.input) : opt.input);
        });
      });
      return shopifyFilters;
    } catch { return []; }
  };

  // GET /api/collection/metadata
  // MOVED TO TOP to avoid matching conflicts
  fastify.get('/metadata', async (request, reply) => {
    const { handle } = request.query;
    if (!handle) return reply.code(400).send({ error: 'handle required' });

    try {
      const db = fastify.mongo.db;
      const collection = await db.collection('collections').findOne({ handle });
      
      if (!collection) return { success: false };
      return { success: true, collection };
    } catch (err) {
      console.error("Metadata error:", err);
      return { success: false };
    }
  });

  // GET /api/collection
  fastify.get('/', async (request, reply) => {
    const { handle, sort = 'manual', cursor, limit = 25, filters, stores } = request.query;

    if (!handle) {
      return { products: [], filters: {}, pageInfo: {}, totalProducts: 0 };
    }

    const cacheKey = stableCacheKey(["api_collection", request.url]);

    return getServerCache(cacheKey, async () => {
      const activeFilters = parseFilters(filters);
      const sortConfig = SORT_MAP[sort] || SORT_MAP.manual;

      // Handle filter. prefixes in query string
      const shopifyFilters = [];
      Object.entries(request.query).forEach(([key, value]) => {
        if (key.startsWith("filter.")) {
          if (key === "filter.v.price.gte" || key === "filter.v.price.lte") {
            const existingPrice = shopifyFilters.find(f => f.price);
            if (existingPrice) {
              if (key === "filter.v.price.gte") existingPrice.price.min = parseFloat(value);
              else existingPrice.price.max = parseFloat(value);
            } else {
              shopifyFilters.push({ price: { 
                min: key === "filter.v.price.gte" ? parseFloat(value) : 0,
                max: key === "filter.v.price.lte" ? parseFloat(value) : 1000000 
              }});
            }
          } else {
            try {
              shopifyFilters.push(JSON.parse(value));
            } catch(e) {
              shopifyFilters.push({ [key.replace("filter.", "")]: value });
            }
          }
        }
      });

      const finalFilters = shopifyFilters.length > 0 ? shopifyFilters : activeFilters;

      let metalRates = {};
      let stonePricingDB = [];
      try {
        const pricingData = await getShopPricingData();
        metalRates = pricingData.metalRates;
        stonePricingDB = pricingData.stonePricingDB;
      } catch (e) {}

      const COLLECTION_QUERY = `
        query CollectionProducts(
          $handle: String!
          $first: Int!
          $after: String
          $sortKey: ProductCollectionSortKeys
          $reverse: Boolean
          $filters: [ProductFilter!]
        ) {
          collectionByHandle(handle: $handle) {
            title
            description
            descriptionHtml
            seo { title description }
            image { url altText }
            metafield_seocontent: metafield(namespace: "custom", key: "seocontent") { value }
            metafield_faqanswers: metafield(namespace: "custom", key: "FaqAnswers") { value }
            metafield_faqquestion: metafield(namespace: "custom", key: "FaqQuestion") { value }
            metafield_seo_content_data: metafield(namespace: "custom", key: "Seo_contentData") { value }
            metafield_bestsellers_html: metafield(namespace: "custom", key: "bestsellers_html") { value }
            metafield_bestseller_products: metafield(namespace: "custom", key: "bestseller_products") {
              references(first: 10) {
                edges {
                  node {
                    ... on Product {
                      id title handle featuredImage { url } priceRange { minVariantPrice { amount } }
                    }
                  }
                }
              }
            }
            products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
              pageInfo { hasNextPage endCursor }
              filters { label type values { label count input } }
              edges {
                node { ${PRODUCT_NODE_FIELDS} }
              }
            }
          }
        }
      `;

      const ALL_PRODUCTS_QUERY = `
        query AllProducts($first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean, $query: String) {
          products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: $query) {
            pageInfo { hasNextPage endCursor }
            filters { label type values { label count input } }
            edges {
              node {
                id title handle productType createdAt tags featuredImage { url }
                productMetafields: metafields(identifiers: [
                  {namespace: "ornaverse", key: "weight"},
                  {namespace: "ornaverse", key: "quality"},
                  {namespace: "ornaverse", key: "carat_range"},
                  {namespace: "ornaverse", key: "lead_time"},
                  {namespace: "ornaverse", key: "components"},
                  {namespace: "ornaverse", key: "bestsellers"},
                  {namespace: "custom", key: "matching_product"},
                  {namespace: "custom", key: "has_virtual_tryon"}
                ]) { key value }
                media(first: 20) {
                  edges {
                    node {
                      mediaContentType
                      ... on MediaImage { image { url altText } }
                      ... on Video { sources { url mimeType } }
                    }
                  }
                }
                # Same 100 as PRODUCTS_BY_IDS_QUERY: with 50 here, a ring whose
                # only stock is variant #57 priced differently with and without
                # a store selected. lib/cardPrice.js mirrors this limit.
                variants(first: 100) {
                  edges {
                    node {
                      id title sku price { amount } compareAtPrice { amount }
                      availableForSale currentlyNotInStock selectedOptions { name value }
                      image { url altText }
                      metal_weight: metafield(namespace: "ornaverse", key: "metal_weight") { value }
                      components: metafield(namespace: "ornaverse", key: "components") { value }
                      variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const pageSize = parseInt(limit) || 25;

      // ── Store-proximity ordering ────────────────────────────────────────────
      // Engages only when every one of these holds:
      //   • the shopper sent a resolved store ranking (`stores`, nearest first)
      //   • it is a real collection — "all" uses a different query with no
      //     collection to scan
      //   • the sort is the default. An explicit Price or Newest sort must win
      //     outright, otherwise prices look scrambled and the control reads as
      //     broken.
      //   • the collection is not itself a store page — those are already scoped
      //     to one store, so reordering them would be redundant.
      // Anything else falls through to the untouched original code path.
      const requestedStores = parseStoreHandles(stores);
      let useStoreOrder =
        requestedStores.length > 0 &&
        handle !== "all" &&
        sort === "manual" &&
        !STORE_COLLECTION_HANDLES.has(handle) &&
        isOffsetCursor(cursor);

      // ── Discount ordering ("Discount: High to Low") ─────────────────────────
      // The collection's Featured order (filters applied, hidden removed),
      // stably re-sorted by the card's discount % from lib/discountIndex.js, so
      // equal discounts keep Featured order. Pincode plays no part here by
      // decision: only the default sort is store-ordered. Pages are served by id
      // with an offset cursor, exactly like the store path — the whole
      // collection is ordered, not just each page. Any miss (index not loaded,
      // scan too slow or capped, Shopify cursor) serves plain Featured paging.
      const discountLookup =
        sort === "discount_desc" && handle !== "all" && DISCOUNT_SORT_ENABLED && isOffsetCursor(cursor)
          ? getDiscountLookup(handle)
          : null;
      if (sort === "discount_desc" && DISCOUNT_SORT_ENABLED && handle !== "all" && isOffsetCursor(cursor) && !discountLookup) {
        console.warn(`Discount index not loaded yet, serving Featured order for "${handle}"`);
      }
      let useDiscountOrder = !!discountLookup;

      // Resolved BEFORE the main product fetch on purpose. The reordered page is
      // fetched by id, so this call needs to know up front whether to ask Shopify
      // for a full page or just the collection's metadata — deciding afterwards
      // would leave a failed reorder serving a one-product page.
      let orderedIds = null;
      if (useStoreOrder) {
        try {
          const ordering = Promise.all([
            getCollectionIdOrder(handle, sortConfig, finalFilters),
            ...requestedStores.map((h) => getStoreProductIds(h)),
          ]);
          // Losing the race below must not surface as an unhandled rejection.
          ordering.catch(() => {});

          // Time budget. On a cold instance these are full catalogue scans, and
          // without a ceiling a slow Shopify makes the shopper wait for them with
          // nothing on screen. Past the budget we serve Shopify's own order —
          // which is what an un-pincoded shopper gets anyway, so nothing is
          // broken, just un-personalised.
          //
          // The scans are deliberately NOT cancelled: they keep running and land
          // in getServerCache, so the request that pays the latency is the only
          // one that does and the next request is fast.
          const TIMED_OUT = Symbol("store-order-timeout");
          let budgetTimer;
          const budget = new Promise((resolve) => {
            budgetTimer = setTimeout(() => resolve(TIMED_OUT), STORE_ORDER_BUDGET_MS);
          });

          const raced = await Promise.race([ordering, budget]);
          clearTimeout(budgetTimer);

          if (raced === TIMED_OUT) {
            console.warn(
              `Store ordering exceeded ${STORE_ORDER_BUDGET_MS}ms for "${handle}", serving default order (scan continues into cache)`
            );
            useStoreOrder = false;
          } else {
            const [order, ...storeSets] = raced;
            // A capped scan means the tail of the collection was never seen, so the
            // "no store stocks this" bucket would be wrong for those products.
            // Serving Shopify's own order beats serving a confidently wrong one.
            if (order.capped || !order.ids.length) useStoreOrder = false;
            else orderedIds = orderIdsByStore(order.ids, storeSets);
          }
        } catch (e) {
          console.error("Store ordering unavailable, serving default order:", e?.message);
          useStoreOrder = false;
        }
      }

      if (useDiscountOrder) {
        try {
          const TIMED_OUT = Symbol("discount-order-timeout");
          const scan = getCollectionIdOrder(handle, SORT_MAP.manual, finalFilters);
          scan.catch(() => {}); // losing the race must not become an unhandled rejection
          let budgetTimer;
          const budget = new Promise((resolve) => {
            budgetTimer = setTimeout(() => resolve(TIMED_OUT), DISCOUNT_ORDER_BUDGET_MS);
          });
          const raced = await Promise.race([scan, budget]);
          clearTimeout(budgetTimer);

          if (raced === TIMED_OUT) {
            console.warn(
              `Discount ordering exceeded ${DISCOUNT_ORDER_BUDGET_MS}ms for "${handle}", serving Featured order (scan continues into cache)`
            );
            useDiscountOrder = false;
          } else if (raced.capped || !raced.ids.length) {
            useDiscountOrder = false;
          } else {
            orderedIds = raced.ids
              .map((id, i) => ({ id, i, d: discountLookup(id) }))
              .sort((a, b) => b.d - a.d || a.i - b.i)
              .map((x) => x.id);
          }
        } catch (e) {
          console.error("Discount ordering unavailable, serving Featured order:", e?.message);
          useDiscountOrder = false;
        }
      }

      // Either ordering mode serves pages by id from `orderedIds`.
      const useIdOrder = (useStoreOrder || useDiscountOrder) && !!orderedIds;

      // In id-order mode the cursor is an offset into our own ordered list
      // rather than an opaque Shopify cursor. The frontend only ever echoes back
      // whatever endCursor it was handed, so this round-trips with no client change.
      const storeOffset = useIdOrder ? Math.max(0, parseInt(cursor, 10) || 0) : 0;

      try {
        let storefrontData;
        if (handle === "all") {
          let filterQuery = "";
          if (finalFilters.length > 0) {
              finalFilters.forEach(f => {
                  if (f.productType) filterQuery += ` product_type:${f.productType}`;
                  if (f.tag) filterQuery += ` tag:${f.tag}`;
                  if (f.variantOption) filterQuery += ` variant_option:${f.variantOption.name}:${f.variantOption.value}`;
              });
          }

          let allSortKey = sortConfig.sortKey;
          if (allSortKey === "CREATED") allSortKey = "CREATED_AT";
          if (allSortKey === "MANUAL") allSortKey = "RELEVANCE";

          storefrontData = await shopifyStorefrontFetch(ALL_PRODUCTS_QUERY, {
            first: parseInt(limit),
            after: cursor || null,
            sortKey: allSortKey,
            reverse: sortConfig.reverse,
            query: filterQuery.trim() || null,
          });
        } else if (useIdOrder) {
          // In store-order mode this request is only for the collection's own
          // metadata and its facet list — `filters` on the connection describes
          // the whole filtered set, not the page, which is why one product is
          // enough. The products for the page are fetched by id below, in the
          // reordered sequence.
          //
          // None of that depends on WHICH stores were sent, so it is cached per
          // view (handle + sort + filters) rather than per request URL. Every
          // store-ranking permutation of a view — and every page of it — shares
          // one ~1.5s Shopify round trip instead of each paying it. Cloned on
          // the way out so downstream code can never mutate the cached copy.
          const meta = await getServerCache(
            stableCacheKey(["collection-meta", handle, sortConfig, finalFilters]),
            () => shopifyStorefrontFetch(COLLECTION_QUERY, {
              handle,
              first: 1,
              after: null,
              sortKey: sortConfig.sortKey,
              reverse: sortConfig.reverse,
              filters: finalFilters,
            }),
            { ttlMs: COLLECTION_META_CACHE_TTL }
          );
          storefrontData = structuredClone(meta);
        } else {
          storefrontData = await shopifyStorefrontFetch(COLLECTION_QUERY, {
            handle,
            first: pageSize,
            after: cursor || null,
            sortKey: sortConfig.sortKey,
            reverse: sortConfig.reverse,
            filters: finalFilters,
          });
        }

        const collectionData = storefrontData?.collectionByHandle;
        let productsData = handle === "all" ? storefrontData?.products : collectionData?.products;

        // Swap in the store-ordered page. Everything downstream — variant configs,
        // the product transform, facets, totals — runs on this exactly as it does
        // on a Shopify page, because the shape is identical.
        if (useIdOrder && productsData) {
          const pageIds = orderedIds.slice(storeOffset, storeOffset + pageSize);
          let nodes = [];
          if (pageIds.length) {
            const byIds = await shopifyStorefrontFetch(PRODUCTS_BY_IDS_QUERY, { ids: pageIds });
            // nodes(ids:) answers in the order asked, and returns null for anything
            // unpublished since the scan — drop those rather than render a hole.
            nodes = (byIds?.nodes || []).filter(Boolean);
          }
          productsData = {
            ...productsData,
            edges: nodes.map((node) => ({ node })),
            pageInfo: {
              hasNextPage: storeOffset + pageSize < orderedIds.length,
              endCursor: String(storeOffset + pageSize),
            },
          };
        }

        if (!productsData) {
          return {
            collection: handle === "all" ? { title: "All Products", description: "All of our products" } : (collectionData || {}),
            products: [], filters: {}, pageInfo: {}, totalProducts: 0
          };
        }

        // A product card shows ONE variant, so a ring's ~80 size × colour × purity
        // variants are cut down before anything is priced or sent. Kept: the
        // first variant, plus, per metal colour, the first one in stock (or the
        // first one, where none is). Every rule the card picks its variant by —
        // first in stock, yellow gold for rings, 9KT in the 9KT collection, the
        // colour filter — searches by colour and stock, so each lands on the same
        // variant from this set as from the full list. Mutates the edges in place
        // so the pricing below also skips the variants nobody will see.
        productsData.edges.forEach(({ node }) => {
          const all = node.variants?.edges || [];
          if (all.length <= 1) return;
          const colourOf = (v) => {
            const opt = (v.selectedOptions || []).find((o) => /^(color|metal|metal color)$/i.test(o.name));
            return String(opt?.value || v.title || "").toLowerCase();
          };
          const inStock = (v) => v.availableForSale === true && v.currentlyNotInStock === false;
          const keep = new Set([0]);
          const firstByColour = new Map();
          all.forEach(({ node: v }, i) => {
            const colour = colourOf(v);
            const held = firstByColour.get(colour);
            if (held === undefined) firstByColour.set(colour, i);
            else if (!inStock(all[held].node) && inStock(v)) firstByColour.set(colour, i);
          });
          firstByColour.forEach((i) => keep.add(i));
          node.variants = { ...node.variants, edges: all.filter((_, i) => keep.has(i)) };
        });

        const variantGids = [];
        const variantConfigs = {};
        productsData.edges.forEach(({ node }) => {
          node.variants.edges.forEach(({ node: v }) => {
            variantGids.push(v.id);
            if (v.variant_config?.value) variantConfigs[v.id] = v.variant_config.value;
          });
        });

        // Fallback only. The config now arrives inside the product query above.
        // If NOT ONE variant on the page carried it, the likeliest cause is the
        // metafield definition losing its Storefront access — in which case the
        // old Admin path still produces correct prices, just more slowly. A page
        // where some variants genuinely have no config (nothing to price) does
        // not trip this: those are simply absent from the map, as before.
        if (variantGids.length > 0 && Object.keys(variantConfigs).length === 0) {
          console.warn(
            `No variant_config reached the Storefront query for "${handle}" — falling back to the Admin API. ` +
            `Check that DI-GoldPrice.variant_config still has Storefront access.`
          );
          const variantQuery = `query getVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id metafield(namespace: "DI-GoldPrice", key: "variant_config") { value } } } }`;
          const uniqueGids = [...new Set(variantGids)];
          const CHUNK_SIZE = 100;
          const chunkPromises = [];
          for (let i = 0; i < uniqueGids.length; i += CHUNK_SIZE) {
            const chunk = uniqueGids.slice(i, i + CHUNK_SIZE);
            chunkPromises.push(
              getServerCache(
                stableCacheKey(["collection-variant-configs", chunk]),
                () => shopifyAdminFetch(variantQuery, { ids: chunk }),
                { ttlMs: VARIANT_CONFIG_CACHE_TTL, maxEntries: 2000 }
              )
            );
          }
          const chunkResults = await Promise.all(chunkPromises);
          chunkResults.forEach((adminData) => {
            adminData?.nodes?.forEach(node => {
              if (node?.metafield?.value) variantConfigs[node.id] = node.metafield.value;
            });
          });
        }

        const products = productsData.edges.map(({ node }) => {
          const productMetafields = {};
          node.productMetafields?.forEach(m => { if (m) productMetafields[m.key] = m.value; });

          const variants = node.variants.edges.map(({ node: v }) => {
            const options = {};
            v.selectedOptions.forEach((o) => { options[o.name.toLowerCase()] = o.value; });

            let dynamic = {};
            let diamondDiscount = 0;
            let makingDiscount = 0;
            let configMetalPurity = null;
            let dynamicPrice = null;
            let dynamicComparePrice = null;
            const configValue = variantConfigs[v.id];
            if (configValue) {
              try {
                const config = JSON.parse(configValue);
                const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
                dynamic = { carat: breakup.diamond.carat, clarity: breakup.diamond.clarity, color: breakup.diamond.color, weight: breakup.metal.weight, diamondCharges: breakup.diamond.final };
                diamondDiscount = breakup.diamond.discount_percent || 0;
                makingDiscount = breakup.making_charges.discount_percent || 0;
                configMetalPurity = config.purity;
                dynamicPrice = breakup.total;
                dynamicComparePrice = breakup.original_total > breakup.total ? breakup.original_total : null;
              } catch (e) {}
            }

            const getOpt = (keys) => {
              for (const key of keys) {
                const lowerKey = key.toLowerCase();
                if (options[lowerKey] !== undefined) return options[lowerKey];
              }
              return null;
            };

            const comps = v.components?.value ? JSON.parse(v.components.value) : null;
            const metalComp = comps?.components?.find(c => c.item_group_name === "Gold");
            let metal_color = metalComp?.stone_color_code && metalComp.stone_color_code !== "NA" ? metalComp.stone_color_code : null;
            if (!metal_color) {
              const t = v.title || "";
              if (t.toLowerCase().includes('rose')) metal_color = 'Rose Gold';
              else if (t.toLowerCase().includes('white')) metal_color = 'White Gold';
              else if (t.toLowerCase().includes('yellow')) metal_color = 'Yellow Gold';
            }

            return {
              id: (v.id || "").split("/").pop(),
              shopifyId: v.id, sku: v.sku,
              size: options.size || null,
              color: getOpt(["color", "metal", "metal color"]),
              carat: dynamic.carat ?? getOpt(["carat"]),
              clarity: dynamic.clarity ?? getOpt(["clarity"]),
              diamond_color: dynamic.color ?? getOpt(["diamond color"]),
              weight: dynamic.weight ?? getOpt(["weight"]),
              price: dynamicPrice || Number(v.price?.amount || 0),
              compare_price: dynamicComparePrice || (v.compareAtPrice ? Number(v.compareAtPrice.amount) : null),
              inStock: v.availableForSale === true && v.currentlyNotInStock === false,
              image: v.image?.url || null,
              altText: v.image?.altText || "",
              metafields: { metal_purity: configMetalPurity || getOpt(["purity"]), metal_color, metal_weight: dynamic.weight || v.metal_weight?.value },
              diamondDiscount, makingDiscount
            };
          });

          let selectedVariant = variants.find((v) => v.inStock) || variants[0];
          const images = node.media?.edges?.filter(m => m.node.mediaContentType === "IMAGE").map(m => ({ url: m.node.image.url, alt: m.node.image.altText || "" }));
          const media = node.media?.edges?.map(m => {
            const n = m.node;
            if (n.mediaContentType === "VIDEO") {
              return {
                mediaContentType: "VIDEO",
                sources: n.sources?.map(s => ({ url: s.url, mimeType: s.mimeType })) || []
              };
            }
            return null;
          }).filter(Boolean) || [];

          return {
            id: (node.id || "").split("/").pop(),
            shopifyId: node.id, title: node.title, handle: node.handle,
            type: node.productType,
            tags: node.tags || [],
            isNew: new Date(node.createdAt) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            createdAt: node.createdAt,
            images,
            media,
            price: selectedVariant.price, compare_price: selectedVariant.compare_price,
            image: selectedVariant.image || node.featuredImage?.url,
            variants, productMetafields
          };
        });

        const processedFilters = {};
        productsData.filters.forEach((f) => {
          if (f.type === "PRICE_RANGE") {
              processedFilters["Price"] = {
                  min: 0,
                  max: Math.max(...f.values.map(v => { try { return JSON.parse(v.input).price.max || 1000000; } catch(e) { return 1000000; } }))
              };
              return;
          }
          const values = f.values
            .filter((v) => v.count > 0)
            .map((v) => {
              let value = v.label;
              try {
                  const input = JSON.parse(v.input);
                  if (input.variantOption) value = input.variantOption.value;
                  else if (input.productMetafield) value = input.productMetafield.value;
                  else if (input.productType) value = input.productType;
                  else if (input.tag) value = input.tag;
              } catch(e) {}
  
              return { 
                  label: v.label, 
                  count: v.count, 
                  input: v.input,
                  value: value 
              };
            });

          if (values.length > 0) {
            processedFilters[f.label] = values;
          }
        });

        // Filter products by dynamic price if price filter is present
        let minPrice = request.query["filter.v.price.gte"];
        let maxPrice = request.query["filter.v.price.lte"];
        let priceFilter = finalFilters.find(f => f.price);
        if (!priceFilter && (minPrice || maxPrice)) {
          priceFilter = {
            price: {
              min: minPrice ? parseFloat(minPrice) : 0,
              max: maxPrice ? parseFloat(maxPrice) : 5000000
            }
          };
        }

        let filteredProducts = products;
        if (priceFilter && priceFilter.price) {
          const { min = 0, max = 5000000 } = priceFilter.price;
          filteredProducts = products.filter(p => {
            return p.price >= min && p.price <= max;
          });
        }

        let totalProducts = 0;
        if (handle === "all") {
          totalProducts = await getCollectionTotalCount(handle);
        } else {
          // Count only VISIBLE products. Shopify's counts include `hidden`-tagged
          // products, which the storefront strips out — that mismatch is what made a
          // 34-product "Charms" category display "34 items" while showing just 1.
          // Cached via the existing cache util (24h + webhook-invalidated), so this
          // scan runs once and is reused. Falls back to the raw count on error or if
          // the scan was capped for a very large collection.
          try {
            const stats = await getCollectionVisibleStats(handle, finalFilters);
            totalProducts = stats.capped
              ? await getCollectionTotalCount(handle)
              : stats.total;
          } catch (e) {
            console.error("Error fetching collection visible count:", e);
            totalProducts = await getCollectionTotalCount(handle);
          }
        }

        // Adjust total count if we filtered out products and reached the end
        if (!productsData.pageInfo.hasNextPage && priceFilter) {
          totalProducts = filteredProducts.length;
        }

        // Sort products array dynamically if sorting by price is selected
        if (sort === "price_low_high") {
          filteredProducts.sort((a, b) => a.price - b.price);
        } else if (sort === "price_high_low") {
          filteredProducts.sort((a, b) => b.price - a.price);
        } else if (sort === "created_at_desc") {
          filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (sort === "created_at_asc") {
          filteredProducts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        }

        return {
          collection: { 
            title: collectionData?.title, 
            description: collectionData?.description,
            descriptionHtml: collectionData?.descriptionHtml, 
            seo: collectionData?.seo, 
            image: collectionData?.image,
            metafields: {
              "custom.seocontent": collectionData?.metafield_seocontent?.value,
              "custom.faqanswers": collectionData?.metafield_faqanswers?.value,
              "custom.faqquestion": collectionData?.metafield_faqquestion?.value,
              "custom.seo_content_data": collectionData?.metafield_seo_content_data?.value,
              "custom.bestsellers_html": collectionData?.metafield_bestsellers_html?.value
            },
            bestsellerProducts: collectionData?.metafield_bestseller_products?.references?.edges?.map(e => ({
              id: (e.node.id || "").split("/").pop(),
              title: e.node.title,
              handle: e.node.handle,
              image: e.node.featuredImage?.url,
              price: Number(e.node.priceRange?.minVariantPrice?.amount || 0)
            })) || []
          },
          products: filteredProducts, filters: processedFilters, pageInfo: productsData.pageInfo, totalProducts
        };
      } catch (err) {
        console.error("Collection error:", err);
        return { products: [], filters: {}, pageInfo: {}, totalProducts: 0 };
      }
    }, { ttlMs: 10 * 60 * 1000 }); // Cache for 10 minutes
  });

  // GET /api/collection/filters
  fastify.get('/filters', async (request, reply) => {
    const { handle } = request.query;
    if (!handle) return { filters: {} };

    return getServerCache(`filters:${handle}`, async () => {
      const query = `query CollectionFilters($handle: String!) { collectionByHandle(handle: $handle) { products(first: 1) { filters { id label type values { id label count input } } } } }`;
      const data = await shopifyStorefrontFetch(query, { handle });
      const rawFilters = data?.collectionByHandle?.products?.filters || [];
      const filters = {};
      rawFilters.forEach((f) => {
        if (f.type === "PRICE_RANGE") return;
        const values = f.values.filter((v) => v.count > 0).map((v) => {
            let value = v.label;
            try {
                const input = JSON.parse(v.input);
                if (input.variantOption) value = input.variantOption.value;
                else if (input.productMetafield) value = input.productMetafield.value;
                else if (input.productType) value = input.productType;
                else if (input.tag) value = input.tag;
            } catch(e) {}

            return { 
                label: v.label, 
                count: v.count, 
                input: v.input,
                value: value 
            };
        });
        if (values.length) filters[f.label || f.id] = values;
      });
      return { filters };
    }, { ttlMs: 10 * 60 * 1000 });
  });
}

module.exports = routes;
