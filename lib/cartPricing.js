/**
 * Cart Pricing (shared)
 *
 * Cart line prices used to be frozen at add-to-cart time, while the Razorpay
 * amount was rebuilt from live DI-GoldPrice rates when the draft order was
 * created. Any metal-rate update between those two moments surfaced as a gap
 * between the total on screen and the amount actually charged.
 *
 * Both paths now run through repriceItems(), so the cart shows exactly what the
 * draft order will bill. Keep it that way: any pricing rule added here must
 * apply to the cart and the checkout at the same time.
 */

const { shopifyAdminFetch, getShopPricingData } = require('./shopify');
const { calculatePriceBreakup } = require('./priceEngine');
const { getServerCache, stableCacheKey } = require('./cache');

const INSURANCE_VARIANT_ID = "gid://shopify/ProductVariant/47709366026458";
const AUTHORIZED_GOLDCOINS = [
  "gid://shopify/ProductVariant/47661824082138", // 100mg
];

// Variant configs only change when a merchant edits a product, but the cart and
// the checkout have to agree on them to the rupee. Reading one cached snapshot
// keeps two independent Shopify reads from returning different configs mid-flow.
const VARIANT_PRICING_TTL_MS = 5 * 60 * 1000;

function normalizeVariantId(variantId = "") {
  const value = String(variantId || "").trim();
  if (!value) return "";
  return value.includes("gid://shopify/ProductVariant/")
    ? value
    : `gid://shopify/ProductVariant/${value}`;
}

function isGoldCoinVariant(variantId = "") {
  return AUTHORIZED_GOLDCOINS.some((id) =>
    String(variantId).includes(id.replace("gid://shopify/ProductVariant/", ""))
  );
}

function isFreeGiftVariant(variantId = "") {
  return isGoldCoinVariant(variantId);
}

const VARIANT_PRICING_QUERY = `
  query getVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        variant_config: metafield(namespace: "DI-GoldPrice", key: "variant_config") { value }
        price
      }
    }
  }
`;

async function fetchVariantPricing(variantIds = []) {
  const uniqueIds = [...new Set(variantIds.filter(Boolean))].sort();
  if (!uniqueIds.length) return {};

  return getServerCache(
    stableCacheKey(["variant-pricing", uniqueIds]),
    async () => {
      const data = await shopifyAdminFetch(VARIANT_PRICING_QUERY, { ids: uniqueIds });
      const map = {};
      (data?.nodes || []).forEach((variant) => {
        if (variant?.id) map[variant.id] = variant;
      });
      return map;
    },
    { ttlMs: VARIANT_PRICING_TTL_MS, maxEntries: 500 }
  );
}

function calculateCartTotal(items = []) {
  return (items || []).reduce(
    (sum, item) =>
      sum + Number(item.finalPrice || item.price || 0) * Number(item.quantity || 1),
    0
  );
}

function calculateCartQuantity(items = []) {
  return (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

/**
 * Re-prices cart lines against the live metal rates and stone slabs.
 *
 * @param items                 cart lines (Mongo cart shape)
 * @param options.dropInvalid   checkout behaviour: drop lines whose variant no
 *                              longer resolves on Shopify or prices at zero.
 *                              The cart keeps them at their stored price instead,
 *                              so a transient Shopify hiccup can never empty a
 *                              customer's cart on a plain read.
 *
 * @returns items         re-priced lines
 * @returns changed       true when any line's price moved
 * @returns diamondTotal  diamond-line value, for gold-coin/pendant eligibility
 * @returns removed       lines dropped (only when dropInvalid is set)
 */
async function repriceItems(items = [], { dropInvalid = false } = {}) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) {
    return { items: [], changed: false, diamondTotal: 0, removed: [] };
  }

  const { metalRates, stonePricingDB } = await getShopPricingData();
  const variantMap = await fetchVariantPricing(
    source.map((item) => normalizeVariantId(item.variantId))
  );

  let changed = false;
  let diamondTotal = 0;
  const removed = [];

  const repriced = source
    .map((item) => {
      const vId = normalizeVariantId(item.variantId);

      // Free gifts are granted by the offer rules, not the price engine. The
      // checkout's second pass owns their eligibility and quantity.
      if (isFreeGiftVariant(vId)) return item;

      const quantity = Math.max(1, Number(item.quantity || 1));
      const storedPrice = Number(item.finalPrice || item.price || 0);
      const variant = variantMap[vId];

      if (!variant) {
        if (dropInvalid) {
          console.error(`[Security] Rejecting item with invalid variantId: ${vId}`);
          removed.push({ variantId: vId, reason: "variant_not_found" });
          return null;
        }
        return quantity === item.quantity ? item : { ...item, quantity };
      }

      if (variant?.variant_config?.value) {
        try {
          const config = JSON.parse(variant.variant_config.value);
          const breakup = calculatePriceBreakup(config, metalRates, stonePricingDB);
          const isDiamondItem = Number(breakup.diamond?.final || 0) > 0 ||
            String(item.title || "").toLowerCase().includes("diamond") ||
            String(item.type || item.productType || item.product_type || "").toLowerCase().includes("diamond") ||
            String(item.title || "").toLowerCase().includes("solitaire") ||
            String(item.title || "").toLowerCase().includes("gemstone") ||
            !!item.diamondCharges;

          const isBYJ = Boolean(
            item.properties?.['_byj_group_id'] || 
            item.properties?.['_byj_preview'] || 
            item.properties?.['_byj_parent'] || 
            item.properties?.[' _byj_parent'] || 
            item.tags?.includes('BYJ') || 
            String(item.handle || "").toLowerCase().includes('byj') || 
            String(item.title || "").toLowerCase().includes('byj')
          );

          // Insurance rides along with the order and never earns a free gift.
          if (isDiamondItem && vId !== INSURANCE_VARIANT_ID && !isFreeGiftVariant(vId) && !isBYJ) {
            diamondTotal += realPrice * quantity;
          }

          if (realPrice !== storedPrice) changed = true;

          return {
            ...item,
            quantity,
            price: realPrice,
            finalPrice: realPrice,
            goldWeight: breakup.metal.weight,
            goldPrice: breakup.metal.cost,
            goldPricePerGram: breakup.metal.rate_per_gram,
            makingCharges: breakup.making_charges.final,
            diamondCharges: breakup.diamond.final,
            gst: breakup.gst.amount,
          };
        } catch (e) {
          console.error(`Failed to parse config for variant ${vId}:`, e.message);
        }
      }

      // Fixed-price lines (insurance, non-configured variants) follow Shopify.
      const shopifyPrice = Number(variant?.price || 0);
      if (shopifyPrice <= 0) {
        if (dropInvalid) {
          console.error(`[Security] Rejecting item with zero price in Shopify: ${vId}`);
          removed.push({ variantId: vId, reason: "zero_price" });
          return null;
        }
        return quantity === item.quantity ? item : { ...item, quantity };
      }

      if (shopifyPrice !== storedPrice) changed = true;

      const isDiamondItem = Number(item.diamondCharges || 0) > 0 ||
        String(item.title || "").toLowerCase().includes("diamond") ||
        String(item.type || item.productType || item.product_type || "").toLowerCase().includes("diamond") ||
        String(item.title || "").toLowerCase().includes("solitaire") ||
        String(item.title || "").toLowerCase().includes("gemstone") ||
        (Array.isArray(item.customAttributes) && item.customAttributes.some(attr => attr.key === "_Diamond Charges" && attr.value));

      const isBYJ = Boolean(
        item.properties?.['_byj_group_id'] || 
        item.properties?.['_byj_preview'] || 
        item.properties?.['_byj_parent'] || 
        item.properties?.[' _byj_parent'] || 
        item.tags?.includes('BYJ') || 
        String(item.handle || "").toLowerCase().includes('byj') || 
        String(item.title || "").toLowerCase().includes('byj')
      );

      if (isDiamondItem && vId !== INSURANCE_VARIANT_ID && !isFreeGiftVariant(vId) && !isBYJ) {
        diamondTotal += shopifyPrice * quantity;
      }

      return { ...item, quantity, price: shopifyPrice, finalPrice: shopifyPrice };
    })
    .filter(Boolean);

  return { items: repriced, changed, diamondTotal, removed };
}

module.exports = {
  repriceItems,
  calculateCartTotal,
  calculateCartQuantity,
  normalizeVariantId,
  isGoldCoinVariant,
  isFreeGiftVariant,
  INSURANCE_VARIANT_ID,
  AUTHORIZED_GOLDCOINS,
};
