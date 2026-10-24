/**
 * Settings Routes (Fastify)
 */

const { normalizeStorePages, matchLocationToStore, toHandle } = require('../lib/storePages');

const SHOPIFY_CDN = 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files';

// A Product Discounts rule can be tagged as a birthday or anniversary coupon
// (lib/occasionCoupons.js). Staff only ever set `occasion`; the rest is the
// scheduler's bookkeeping — the entitled customer ids above all — and has to
// ride across every save path, or a plain rebuild of the rule would drop the
// entitlement of everyone currently inside a window.
const OCCASION_KINDS = ['birthday', 'anniversary'];

function occasionFields(body, previous) {
  const requested =
    body && Object.prototype.hasOwnProperty.call(body, 'occasion') ? body.occasion : previous?.occasion;
  return {
    occasion: OCCASION_KINDS.includes(requested) ? requested : null,
    occasionCustomerIds: Array.isArray(previous?.occasionCustomerIds) ? previous.occasionCustomerIds : [],
    // Who those ids are — name, email, date — for the dashboard's list.
    occasionCustomers: Array.isArray(previous?.occasionCustomers) ? previous.occasionCustomers : [],
    occasionAutoPaused: previous?.occasionAutoPaused === true,
    occasionSyncedAt: previous?.occasionSyncedAt || null,
    occasionEligibleCount: previous?.occasionEligibleCount || 0,
  };
}

// Defaults for GET /api/settings/plp-banners — copied verbatim from the
// constants that used to live in the storefront's CollectionPageClient.js
// (CUSTOM_COLLECTION_BANNERS, PLAIN_GOLD_HANDLES/PLAIN_GOLD_BANNER_IMAGE, the
// heroBannerSrc handle-ternary, and INPAGE_BANNERS). Until the `plp_banners`
// doc is saved once from the dashboard, the PLP renders exactly as before.
const PLP_BANNER_DEFAULTS = {
  topBanner: {
    default: {
      desktopImage: `${SHOPIFY_CDN}/Offer-Mobile1.jpg?v=1787998995`,
      mobileImage: `${SHOPIFY_CDN}/Offer-Mobile1.jpg?v=1787998995`,
      alt: 'Offers',
    },
    plainGold: {
      desktopImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/gold_ring_plp.jpg?v=1792042102&width=1920',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/gold_ring_plp.jpg?v=1792042102&width=1920',
      alt: 'Plain Gold Jewellery Offers',
      handles: [
        'plain-gold-rings', 'plain-gold-earrings', 'plain-gold-chains', 'plain-gold-necklaces', 'plain-gold-coins', 'plain-gold-nose-rings',
        'gold-jewelry', 'gold-rings', 'gold-chains', 'gold-earrings', 'gold-bracelets', 'gold-necklaces', 'gold-coins',
        '1-gram-gold-jewellery', '10-gram-gold-jewellery', '14k-gold-jewellery', '18k-gold-jewellery', '22k-gold-jewellery'
      ],
    },
    overrides: [
      // Full-width creatives that replace the default pink layout.
      { id: 'ov_eterna', handles: ['eterna'], layout: 'fullwidth', alt: 'Embrace',
        desktopImage: `${SHOPIFY_CDN}/Embrace_Banner_Desktop_PLP_jpg.jpg?v=1783673522`,
        mobileImage: `${SHOPIFY_CDN}/Embrace_Banner_Mobile_PLP_jpg.jpg?v=1783673523` },
      { id: 'ov_hexa', handles: ['hexa'], layout: 'fullwidth', alt: 'Hexa',
        desktopImage: `${SHOPIFY_CDN}/Hexa-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/Hexa-Mobile.jpg?v=1783767788` },
      { id: 'ov_cotton_candy', handles: ['cotton-candy'], layout: 'fullwidth', alt: 'Cotton Candy',
        desktopImage: `${SHOPIFY_CDN}/CC-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/CC-Mobile.jpg?v=1783767788` },
      { id: 'ov_sports', handles: ['sports-collection'], layout: 'fullwidth', alt: 'On The Move',
        desktopImage: `${SHOPIFY_CDN}/OTM-Desktop.jpg?v=1783767788`,
        mobileImage: `${SHOPIFY_CDN}/OTM-Mobile.jpg?v=1783767788` },
      // Plain-gold sub-collections share one strip creative.
      { id: 'ov_plain_gold', layout: 'strip', alt: 'Gold Jewellery Offer',
        handles: ['gold-jewelry', 'gold-rings', 'gold-chains', 'gold-earrings', 'gold-bracelets', 'gold-necklaces', 'gold-coins'],
        desktopImage: `${SHOPIFY_CDN}/Offer-Gold_jpg_44047036-a66f-4e34-8332-f226a6d24073.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Gold_jpg_44047036-a66f-4e34-8332-f226a6d24073.jpg` },
      { id: 'ov_earrings', handles: ['earrings'], layout: 'strip', alt: 'Earrings Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product-3_f6e49a5f-f9a3-4af7-9fca-c9bce18aa4c4.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product-3_f6e49a5f-f9a3-4af7-9fca-c9bce18aa4c4.jpg` },
      { id: 'ov_all_earrings', handles: ['all-earrings'], layout: 'strip', alt: 'Earrings Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product1_jpg.jpg?v=1787210650`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product1_jpg.jpg?v=1787210650` },
      { id: 'ov_bestsellers', handles: ['bestsellers'], layout: 'strip', alt: 'Bestsellers Offer',
        desktopImage: `${SHOPIFY_CDN}/Offer-Mobile-Product_8ddc9bb5-09ff-46f1-bf24-e3b1b5172a80.jpg`,
        mobileImage: `${SHOPIFY_CDN}/Offer-Mobile-Product_8ddc9bb5-09ff-46f1-bf24-e3b1b5172a80.jpg` },
      { id: 'ov_diamond_rings', handles: ['50-making-discount'], layout: 'strip', alt: '50% Making Discount',
        desktopImage: `${SHOPIFY_CDN}/diamond_ring_PLP.jpg?v=1792042102`,
        mobileImage: `${SHOPIFY_CDN}/diamond_ring_PLP.jpg?v=1792042102` },
      { id: 'ov_studs', handles: ['100-making-discount'], layout: 'strip', alt: '100% Making Discount',
        desktopImage: `${SHOPIFY_CDN}/studs_plp.jpg?v=1792042102`,
        mobileImage: `${SHOPIFY_CDN}/studs_plp.jpg?v=1792042102` },
      { id: 'ov_gold_rings', handles: ['20-making-discount'], layout: 'strip', alt: '20% Making Discount',
        desktopImage: `${SHOPIFY_CDN}/gold_ring_plp.jpg?v=1792042102`,
        mobileImage: `${SHOPIFY_CDN}/gold_ring_plp.jpg?v=1792042102` },
    ],
  },
  // Cards injected into the product grid (after the 6th product, then every 10),
  // shown in order, cycling. Creative B is still the TODO(banner) placeholder.
  inpageBanners: [
    { id: 'ip_a', src: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, mobileSrc: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, alt: 'Promo', href: '/collections/rakhi' },
    { id: 'ip_b', src: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, mobileSrc: `${SHOPIFY_CDN}/Desktop-Inpage_3_eaa604a9-de30-4c5c-be84-ab17a0812a15.jpg`, alt: 'Promo', href: '/collections/rakhi' },
  ],
};

const OFFERS_PAGE_DEFAULTS = {
  heroBanner: {
    enabled: true,
    title: 'Something Special Awaits',
    subtitle: '',
    desktopImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/offer-banner.png?v=1792042018',
    mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Offer-Mobile_ded4c971-bc21-412a-bf4a-7f0ac3c045a3.jpg?v=1792042015',
    link: '/collections/all',
    alt: 'Something Special Awaits - Lucira Offers',
  },
  offerCards: [
    {
      id: 'offer_1',
      title: '100% Making Charges + 30% Diamond Discount',
      image: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/diamond_studs.jpg?v=1792042017',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/diamond_studs.jpg?v=1792042017',
      link: '/collections/100-making-discount',
      buttonText: 'SHOP NOW',
      buttonTheme: 'dark',
      alt: '100% + 30% Making Charges & Diamond Discount',
      enabled: true,
    },
    {
      id: 'offer_2',
      title: '50% Making Charges + 20% Diamond Discount',
      image: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/diamond_ring_2.jpg?v=1792043272',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/diamond_ring_2.jpg?v=1792043272',
      link: '/collections/50-making-discount',
      buttonText: 'SHOP NOW',
      buttonTheme: 'light',
      alt: '50% + 20% Making Charges & Diamond Discount',
      enabled: true,
    },
    {
      id: 'offer_3',
      title: '50% Making Charges on Pendants',
      image: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Pendant_2.jpg?v=1792043272',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Pendant_2.jpg?v=1792043272',
      link: '/collections/50-making-discount',
      buttonText: 'SHOP NOW',
      buttonTheme: 'dark',
      alt: '50% Making Charges on Pendants',
      enabled: true,
    },
    {
      id: 'offer_4',
      title: '20% Making Discount - Spin & Win',
      image: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/spinthewheel.png?v=1792042017',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/spinthewheel.png?v=1792042017',
      link: '/collections/20-making-discount',
      buttonText: '',
      buttonTheme: 'dark',
      alt: '20% Making Discount - Register & Unlock Rewards',
      enabled: true,
    },
    {
      id: 'offer_5',
      title: '20% Making on Gold Products',
      image: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/gold_jewelry.jpg?v=1792042017',
      mobileImage: 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files/gold_jewelry.jpg?v=1792042017',
      link: '/collections/gold-jewelry',
      buttonText: 'SHOP NOW',
      buttonTheme: 'light',
      alt: '20% Making on Gold Products',
      enabled: true,
    },
  ],
  trustBadges: {
    enabled: true,
    items: [
      { id: 'tb_1', text: 'Free and secure shipping', icon: 'shipping' },
      { id: 'tb_2', text: 'Lifetime return or exchange', icon: 'exchange' },
      { id: 'tb_3', text: '100% diamond value guarantee', icon: 'diamond' },
      { id: 'tb_4', text: '15-day money back guarantee', icon: 'return' },
    ],
  },
  seo: {
    title: 'Exclusive Offers & Deals | Lucira Jewelry',
    description: 'Explore exclusive jewellery offers, diamond discounts, and making charge waivers at Lucira Jewelry.',
  },
};


async function routes(fastify, options) {
  const collection = fastify.mongo.db.collection('settings');

  // Fire-and-forget ISR revalidation after a PLP-banner save, so edits show up
  // on the storefront within seconds instead of waiting out the 24h `revalidate`
  // window. Fires the wildcard `collections` call (covers the shared default
  // banner, which affects every collection page) plus a per-handle call for
  // each overridden collection (reliable even where the wildcard form isn't).
  // Never throws.
  const revalidateCollections = async (value) => {
    const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const endpoint = `${frontendUrl}/api/revalidate`;
    const post = (body) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});

    const handles = [...new Set([
      ...(value?.topBanner?.plainGold?.handles || []),
      ...(value?.topBanner?.overrides || []).flatMap((o) => o.handles || []),
      ...(value?.inpageBanners || []).flatMap((b) => b.handles || []),
    ])];
    try {
      await Promise.all([
        post({ type: 'collections' }),
        ...handles.map((h) => post({ type: 'collection', handle: h })),
      ]);
      fastify.log.info(`[PLP Banners] Triggered revalidation (all collections + ${handles.length} handles)`);
    } catch (err) {
      fastify.log.error('[PLP Banners] Revalidation ping failed: ' + err.message);
    }
  };

  // GET /api/settings/gold-coin
  fastify.get('/gold-coin', async (request, reply) => {
    const { shopifyAdminFetch } = require('../lib/shopify');
    const settings = await collection.findOne({ key: 'gold_coin_offer' });

    let shopifyProduct = null;
    const variantId = "gid://shopify/ProductVariant/47661824082138"; // 100mg Gold Coin

    try {
      const query = `
        query getVariant($id: ID!) {
          node(id: $id) {
            ... on ProductVariant {
              id
              title
              price
              image {
                url
              }
              product {
                id
                title
                featuredImage {
                  url
                }
              }
            }
          }
        }
      `;
      const data = await shopifyAdminFetch(query, { id: variantId });
      if (data?.node) {
        shopifyProduct = {
          title: data.node.product.title,
          variantTitle: data.node.title,
          price: data.node.price,
          image: data.node.image?.url || data.node.product.featuredImage?.url
        };
      }
    } catch (err) {
      fastify.log.error('Error fetching gold coin from Shopify: ' + err.message);
    }

    return {
      enabled: settings?.enabled ?? false,
      threshold: settings?.threshold ?? 20000,
      message: settings?.message || "Complimentary Gold Coin available",
      shopifyProduct
    };
  });

  // POST /api/settings/gold-coin
  fastify.post('/gold-coin', async (request, reply) => {
    const { enabled, threshold, message } = request.body;
    await collection.updateOne(
      { key: 'gold_coin_offer' },
      { $set: { enabled, threshold: parseInt(threshold), message, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/silver-bracelet
  // Mirrors /gold-coin so the cart's free-gift widget (FreeGiftReward) and the
  // checkout-time validation read one admin-tunable doc instead of a constant.
  // Shape is a list of spend tiers (min value -> gift), not a single threshold,
  // so staff can add more gifts beyond the one Diamond Bracelet offer without a
  // deploy. getFreeGiftOffer (shared with checkout.js/cartPricing.js) owns the
  // doc-absent default, so this route and the security checks can never disagree
  // about what the "no doc written yet" state actually is.
  fastify.get('/silver-bracelet', async (request, reply) => {
    const { getFreeGiftOffer } = require('../lib/cartPricing');
    return getFreeGiftOffer(fastify.mongo.db);
  });

  // POST /api/settings/silver-bracelet
  fastify.post('/silver-bracelet', async (request, reply) => {
    const { enabled, tiers } = request.body;
    if (!Array.isArray(tiers)) {
      return reply.code(400).send({ error: 'tiers must be an array' });
    }
    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    const cleanTiers = tiers.map((t) => ({
      id: t.id || `tier_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(t.title || '').trim(),
      enabled: t.enabled !== false,
      // "amount" (spend >= min) or "quantity" (item count >= minQuantity) —
      // see tierTriggerMet in lib/cartPricing.js for how checkout enforces this.
      triggerType: t.triggerType === 'quantity' ? 'quantity' : 'amount',
      min: parseInt(t.min) || 0,
      minQuantity: parseInt(t.minQuantity) || 0,
      // "free" (100% off), "percentage", or "amount_off" — see
      // giftLineDiscount in lib/cartPricing.js for how checkout applies this.
      rewardType: ['percentage', 'amount_off'].includes(t.rewardType) ? t.rewardType : 'free',
      rewardPercentage: Math.min(100, Math.max(0, parseFloat(t.rewardPercentage) || 0)),
      rewardAmountOff: Math.max(0, parseInt(t.rewardAmountOff) || 0),
      giftVariantId: String(t.giftVariantId || '').trim(),
      giftProductId: String(t.giftProductId || '').trim(),
      giftTitle: String(t.giftTitle || '').trim(),
      giftWorthValue: parseInt(t.giftWorthValue) || 0,
      giftImage: String(t.giftImage || '').trim(),
      bannerImage: String(t.bannerImage || '').trim(),
      bannerText: String(t.bannerText || '').trim(),
      scaleQuantityWithSpend: Boolean(t.scaleQuantityWithSpend),
      allocationLimit: t.allocationLimit ? parseInt(t.allocationLimit) : null,
      // Off means claiming this gift clears any redeemed Lucira coins,
      // which is how the gift offer has always behaved.
      coinsApplicable: Boolean(t.coinsApplicable),
      // Off means claiming this gift removes an applied coupon (and applying
      // a coupon removes this gift) — the long-standing exclusive behavior.
      combineCoupons: Boolean(t.combineCoupons),
      startsAt: cleanDate(t.startsAt),
      endsAt: cleanDate(t.endsAt),
    }));
    await collection.updateOne(
      { key: 'silver_bracelet_offer' },
      { $set: { enabled: !!enabled, tiers: cleanTiers, updatedAt: new Date() } },
      { upsert: true }
    );
    // Without this, a staff save wouldn't be reflected in the cart/checkout
    // for up to a minute (getFreeGiftOffer's cache TTL) — bad "did it save?"
    // experience for a form whose entire point is instant, code-free updates.
    const { invalidateFreeGiftOfferCache } = require('../lib/cartPricing');
    invalidateFreeGiftOfferCache();
    return { success: true };
  });

  // GET /api/settings/announcements
  fastify.get('/announcements', async () => {
    const settings = await fastify.mongo.db.collection('announcements').findOne({ key: 'global_settings' });
    return {
      announcements: settings?.announcements || [],
      isVisible: settings?.isVisible ?? true
    };
  });

  // POST /api/settings/announcements
  fastify.post('/announcements', async (request, reply) => {
    const { announcements, isVisible } = request.body;
    await fastify.mongo.db.collection('announcements').updateOne(
      { key: 'global_settings' },
      { $set: { announcements, isVisible, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/hero-banners
  fastify.get('/hero-banners', async () => {
    const settings = await collection.findOne({ key: 'hero_banners' });
    // Provide some default banners if none exist so the frontend doesn't break
    const defaultBanners = [
      { id: "1", type: "image", name: "Baarish", alt: "Baarish", url: "/collections/jewelry", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Baarish-Mobile.jpg" },
      { id: "2", type: "image", name: "9KT", alt: "9KT Collection", url: "/collections/9kt-collection", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-9KT-Mobile.jpg" },
      { id: "3", type: "image", name: "Solitaire", alt: "Solitaire Twist Ring", url: "/products/round-diamond-solitaire-twist-ring", desktopImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Desktop.jpg", mobileImage: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Homepage_homeSlider-Solitaire-Mobile.jpg" }
    ];

    const rawBanners = settings?.banners || defaultBanners;
    const videoSlideDelay = settings?.videoSlideDelay !== undefined ? Number(settings.videoSlideDelay) : 8;
    const imageSlideDelay = settings?.imageSlideDelay !== undefined ? Number(settings.imageSlideDelay) : 6;

    // Attach exact duration (seconds) and delay (ms) to every slide: 8s for video, 6s for image
    const banners = rawBanners.map((b) => {
      const isVideo =
        b.type === 'video' ||
        Boolean(b.desktopVideo && !b.desktopImage) ||
        (typeof b.desktopImage === 'string' &&
          (b.desktopImage.endsWith('.mp4') ||
            b.desktopImage.endsWith('.webm') ||
            b.desktopImage.includes('/video/')));

      const duration = b.duration ? Number(b.duration) : (isVideo ? videoSlideDelay : imageSlideDelay);
      return {
        ...b,
        duration,
        delay: duration * 1000,
      };
    });

    return {
      banners,
      videoSlideDelay,
      imageSlideDelay,
    };
  });

  // POST /api/settings/hero-banners
  fastify.post('/hero-banners', async (request, reply) => {
    const { banners, videoSlideDelay, imageSlideDelay } = request.body || {};
    if (!Array.isArray(banners)) {
      return reply.code(400).send({ error: 'banners must be an array' });
    }

    const vDelay = videoSlideDelay !== undefined ? Number(videoSlideDelay) : 8;
    const iDelay = imageSlideDelay !== undefined ? Number(imageSlideDelay) : 6;

    // Enrich each banner with its duration and delay before saving
    const sanitizedBanners = banners.map((b) => {
      const isVideo =
        b.type === 'video' ||
        Boolean(b.desktopVideo && !b.desktopImage) ||
        (typeof b.desktopImage === 'string' &&
          (b.desktopImage.endsWith('.mp4') ||
            b.desktopImage.endsWith('.webm') ||
            b.desktopImage.includes('/video/')));

      const duration = b.duration ? Number(b.duration) : (isVideo ? vDelay : iDelay);
      return {
        ...b,
        duration,
        delay: duration * 1000,
      };
    });

    await collection.updateOne(
      { key: 'hero_banners' },
      {
        $set: {
          banners: sanitizedBanners,
          videoSlideDelay: vDelay,
          imageSlideDelay: iDelay,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    return { success: true };
  });

  // GET /api/settings/plp-banners
  // Drives the collection/PLP top banner (global default + per-collection
  // overrides) and the in-grid promo banners. Falls back to PLP_BANNER_DEFAULTS
  // so the storefront renders identically before the first save.
  fastify.get('/plp-banners', async () => {
    const settings = await collection.findOne({ key: 'plp_banners' });
    const stored = settings?.value;
    return {
      topBanner: {
        default: stored?.topBanner?.default || PLP_BANNER_DEFAULTS.topBanner.default,
        plainGold: stored?.topBanner?.plainGold || PLP_BANNER_DEFAULTS.topBanner.plainGold,
        overrides: Array.isArray(stored?.topBanner?.overrides)
          ? stored.topBanner.overrides
          : PLP_BANNER_DEFAULTS.topBanner.overrides,
      },
      inpageBanners: Array.isArray(stored?.inpageBanners)
        ? stored.inpageBanners
        : PLP_BANNER_DEFAULTS.inpageBanners,
    };
  });

  // POST /api/settings/plp-banners
  fastify.post('/plp-banners', async (request, reply) => {
    const { topBanner, inpageBanners } = request.body || {};
    if (!topBanner || typeof topBanner !== 'object' || Array.isArray(topBanner)) {
      return reply.code(400).send({ error: 'topBanner must be an object' });
    }
    if (!Array.isArray(topBanner.overrides)) {
      return reply.code(400).send({ error: 'topBanner.overrides must be an array' });
    }
    if (!Array.isArray(inpageBanners)) {
      return reply.code(400).send({ error: 'inpageBanners must be an array' });
    }

    const str = (v) => String(v || '').trim();
    const value = {
      topBanner: {
        default: {
          desktopImage: str(topBanner.default?.desktopImage),
          mobileImage: str(topBanner.default?.mobileImage),
          alt: str(topBanner.default?.alt),
        },
        plainGold: {
          desktopImage: str(topBanner.plainGold?.desktopImage || PLP_BANNER_DEFAULTS.topBanner.plainGold.desktopImage),
          mobileImage: str(topBanner.plainGold?.mobileImage || PLP_BANNER_DEFAULTS.topBanner.plainGold.mobileImage),
          alt: str(topBanner.plainGold?.alt || 'Plain Gold Jewellery Offers'),
          handles: Array.isArray(topBanner.plainGold?.handles)
            ? topBanner.plainGold.handles.map(str).filter(Boolean)
            : PLP_BANNER_DEFAULTS.topBanner.plainGold.handles,
        },
        overrides: topBanner.overrides.map((o, i) => ({
          id: str(o.id) || `ov_${Date.now()}_${i}`,
          handles: Array.isArray(o.handles) ? o.handles.map(str).filter(Boolean) : [],
          layout: o.layout === 'fullwidth' ? 'fullwidth' : 'strip',
          desktopImage: str(o.desktopImage),
          mobileImage: str(o.mobileImage),
          alt: str(o.alt),
        })),
      },
      inpageBanners: inpageBanners.map((b, i) => ({
        id: str(b.id) || `ip_${Date.now()}_${i}`,
        src: str(b.src),
        mobileSrc: str(b.mobileSrc),
        alt: str(b.alt) || 'Promo',
        href: str(b.href) || '/',
        // Optional targeting: only on these collection handles, and after this many
        // products (0 = first). Empty handles = the global 6/16 cadence, as before.
        // 'wide' = 2 columns x 2 rows, 'double' = 2 columns x 1 row (packaging); anything else = single tile.
        size: b.size === 'wide' || b.size === 'double' ? b.size : 'tile',
        handles: Array.isArray(b.handles) ? b.handles.map(str).filter(Boolean) : [],
        after: b.after === '' || b.after == null || !Number.isFinite(Number(b.after)) ? null : Math.max(0, Math.floor(Number(b.after))),
      })),
    };

    await collection.updateOne(
      { key: 'plp_banners' },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true }
    );

    revalidateCollections(value); // fire-and-forget
    return { success: true };
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STORE PAGES
  //
  // One document drives every store surface on the storefront: the
  // /collections/<handle> hero, the "Visit Lucira Store Near You" section on the
  // homepage and the PDP, the /pages/store-locator cards, and the "Visit our
  // stores" footer links. Adding a store is a dashboard edit, not a deploy.
  // ───────────────────────────────────────────────────────────────────────────

  // A store edit changes the footer links, which live in the root layout and so
  // appear on every page — hence the layout-wide `all` revalidation. Store edits
  // are rare (a handful a year), so the extra background renders are cheap. The
  // per-handle calls on top of it make the store collection pages reliable.
  const revalidateStoreSurfaces = async (stores) => {
    const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const endpoint = `${frontendUrl}/api/revalidate`;
    const post = (body) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});

    const handles = [...new Set((stores || []).map((s) => s.handle).filter(Boolean))];
    try {
      await Promise.all([
        post({ type: 'all' }),
        post({ type: 'path', path: '/pages/store-locator' }),
        ...handles.map((h) => post({ type: 'collection', handle: h })),
      ]);
      fastify.log.info(`[Store Pages] Triggered revalidation (layout + locator + ${handles.length} store collections)`);
    } catch (err) {
      fastify.log.error('[Store Pages] Revalidation ping failed: ' + err.message);
    }
  };

  // GET /api/settings/store-pages
  fastify.get('/store-pages', async () => {
    const settings = await collection.findOne({ key: 'store_pages' });
    return normalizeStorePages(settings?.value);
  });

  // POST /api/settings/store-pages
  fastify.post('/store-pages', async (request, reply) => {
    const { stores, serviceCatalog, facilitySuggestions } = request.body || {};
    if (!Array.isArray(stores)) {
      return reply.code(400).send({ error: 'stores must be an array' });
    }

    // Two stores pointing at one collection handle would make the PLP hero
    // ambiguous, so reject it here rather than picking a winner at render time.
    const handles = stores.map((s) => toHandle(s?.handle)).filter(Boolean);
    if (handles.length !== stores.length) {
      return reply.code(400).send({ error: 'Every store needs a collection handle' });
    }
    const duplicate = handles.find((h, i) => handles.indexOf(h) !== i);
    if (duplicate) {
      return reply.code(400).send({ error: `Two stores share the collection handle "${duplicate}"` });
    }

    const value = normalizeStorePages({ stores, serviceCatalog, facilitySuggestions });

    await collection.updateOne(
      { key: 'store_pages' },
      { $set: { value, updatedAt: new Date() } },
      { upsert: true }
    );

    revalidateStoreSurfaces(value.stores); // fire-and-forget
    return { success: true, count: value.stores.length };
  });

  // GET /api/settings/store-pages/shopify-locations
  // The Shopify locations already synced into the `stores` collection by
  // POST /api/stores/sync-shopify, annotated with whether a store page is
  // already wired to them. Drives the dashboard's "import from Shopify" list.
  fastify.get('/store-pages/shopify-locations', async () => {
    const [settings, locations] = await Promise.all([
      collection.findOne({ key: 'store_pages' }),
      fastify.mongo.db.collection('stores').find({}).toArray(),
    ]);

    const pages = normalizeStorePages(settings?.value).stores;
    const byId = new Map(pages.filter((s) => s.shopifyLocationId).map((s) => [s.shopifyLocationId, s]));

    return {
      locations: locations.map((loc) => {
        // The explicit link wins; the alias/name matcher covers the locations
        // that pre-date it, so an existing store never looks importable.
        const match = byId.get(loc.shopifyId) || matchLocationToStore(loc.name, pages);
        return {
          shopifyId: loc.shopifyId,
          name: loc.name,
          isActive: loc.isActive !== false,
          address: loc.address || '',
          zip: loc.zip || '',
          phone: loc.phone || '',
          latitude: loc.latitude || null,
          longitude: loc.longitude || null,
          mapLink: loc.mapLink || '',
          image: loc.image || '',
          linked: !!match,
          linkedHandle: match ? match.handle : '',
        };
      }),
    };
  });

  // GET /api/settings/scheme-offer
  fastify.get('/scheme-offer', async (request, reply) => {
    const settings = await collection.findOne({ key: 'scheme_offer' });
    return {
      enabled: settings?.enabled ?? true,
      intervals: settings?.intervals || [
        { min: 3000, max: 4500, giftValue: 5000, label: "Free Gift Worth 5k" },
        { min: 5000, max: 19000, giftValue: 10000, label: "Free Gift Worth 10k" }
      ]
    };
  });

  // POST /api/settings/scheme-offer
  fastify.post('/scheme-offer', async (request, reply) => {
    const { enabled, intervals } = request.body;
    await collection.updateOne(
      { key: 'scheme_offer' },
      { $set: { enabled, intervals, updatedAt: new Date() } },
      { upsert: true }
    );
    return { success: true };
  });
  // GET /api/settings/product-discounts
  fastify.get('/product-discounts', async (request, reply) => {
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    return {
      discounts: settings?.discounts || []
    };
  });

  // POST /api/settings/product-discounts
  fastify.post('/product-discounts', async (request, reply) => {
    const { discounts } = request.body;
    if (!Array.isArray(discounts)) {
      return reply.code(400).send({ error: 'discounts must be an array' });
    }

    // Clean and validate the data
    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };

    const cleanDiscounts = discounts.map(d => ({
      id: d.id || `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(d.title || '').trim(),
      method: ['code', 'automatic'].includes(d.method) ? d.method : 'automatic',
      discountType: ['percentage', 'fixed_amount'].includes(d.discountType) ? d.discountType : 'percentage',
      discountValue: Math.max(0, parseFloat(d.discountValue) || 0),
      appliesTo: ['specific_collections', 'specific_products'].includes(d.appliesTo) ? d.appliesTo : 'specific_collections',
      selectedCollections: Array.isArray(d.selectedCollections) ? d.selectedCollections : [],
      selectedProducts: Array.isArray(d.selectedProducts) ? d.selectedProducts : [],
      // Carve-outs from the selection above. Shopify's discount model can't
      // express an exclusion, so this never round-trips through Shopify —
      // cartPricing/coupon-validate are what honour it.
      excludedCollections: Array.isArray(d.excludedCollections) ? d.excludedCollections : [],
      minRequirement: ['none', 'amount', 'quantity'].includes(d.minRequirement) ? d.minRequirement : 'none',
      minRequirementValue: Math.max(0, parseFloat(d.minRequirementValue) || 0),
      startsAt: cleanDate(d.startsAt),
      endsAt: cleanDate(d.endsAt),
      showInDrawer: Boolean(d.showInDrawer),
      isFeatured: Boolean(d.isFeatured),
      offerLabel: d.offerLabel === 'discount' ? 'discount' : 'bank_offer',
      active: d.active !== false,
      editable: d.editable !== false,
      origin: d.origin || 'dashboard',
      // Birthday / anniversary coupon (lib/occasionCoupons.js). The entitled
      // customer ids and the scheduler's bookkeeping ride along unchanged —
      // rebuilding the rule without them would drop everyone's entitlement.
      ...occasionFields(d, d),
    }));

    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: cleanDiscounts, updatedAt: new Date() } },
      { upsert: true }
    );

    // Invalidate the cache in cartPricing if we decide to cache this
    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    return { success: true };
  });

  // POST /api/settings/product-discounts/:id
  // Dashboard "Save & sync" — upserts one rule locally AND pushes it to
  // Shopify via lib/shopifyDiscounts.js, so a rule created/edited here always
  // has a real Shopify discount (code) or automatic promotion backing it.
  // cart.js/checkout.js validate coupon codes straight against Shopify, and
  // the storefront's "Saving Zone" drawer only lists rules that made it here.
  fastify.post('/product-discounts/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};

    const cleanDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };

    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const previousRule = existingDiscounts.find((d) => d.id === id) || null;

    const rule = {
      id,
      title: String(body.title || '').trim(),
      // Falls back to 'code', not 'automatic': the dashboard no longer offers a
      // method picker, so a request arriving without one is a code discount.
      // Defaulting to automatic here would mint rules the UI cannot represent.
      method: ['code', 'automatic'].includes(body.method) ? body.method : 'code',
      discountType: ['percentage', 'fixed_amount'].includes(body.discountType) ? body.discountType : 'percentage',
      discountValue: Math.max(0, parseFloat(body.discountValue) || 0),
      appliesTo: ['specific_collections', 'specific_products'].includes(body.appliesTo) ? body.appliesTo : 'specific_collections',
      selectedCollections: Array.isArray(body.selectedCollections) ? body.selectedCollections : [],
      selectedProducts: Array.isArray(body.selectedProducts) ? body.selectedProducts : [],
      // Carve-outs from the selection above. Shopify has no exclusion field,
      // so this stays local: keep whatever the rule already had when a save
      // arrives without it (e.g. an older dashboard build).
      excludedCollections: Array.isArray(body.excludedCollections)
        ? body.excludedCollections
        : (previousRule?.excludedCollections || []),
      minRequirement: ['none', 'amount', 'quantity'].includes(body.minRequirement) ? body.minRequirement : 'none',
      minRequirementValue: Math.max(0, parseFloat(body.minRequirementValue) || 0),
      startsAt: cleanDate(body.startsAt),
      endsAt: cleanDate(body.endsAt),
      showInDrawer: Boolean(body.showInDrawer),
      isFeatured: Boolean(body.isFeatured),
      // Which label the drawer/banner ticket's spine shows for this rule.
      offerLabel: body.offerLabel === 'discount' ? 'discount' : (previousRule?.offerLabel === 'discount' ? 'discount' : 'bank_offer'),
      // Staff-controlled stacking rules. Off means today's behaviour:
      // applying this discount clears any redeemed Lucira coins, and
      // Shopify refuses to combine it with another discount.
      coinsApplicable: Boolean(body.coinsApplicable),
      combineCoupons: Boolean(body.combineCoupons),
      shopifyDiscountId: previousRule?.shopifyDiscountId || null,
      ...occasionFields(body, previousRule),
    };

    const { createOrUpdateCodeDiscount, createOrUpdateAutomaticDiscount } = require('../lib/shopifyDiscounts');
    const pushToShopify = (targetRule, targetPrevious) =>
      targetRule.method === 'code'
        ? createOrUpdateCodeDiscount(targetRule, targetPrevious)
        : createOrUpdateAutomaticDiscount(targetRule, targetPrevious);

    let shopifyResult;
    try {
      shopifyResult = await pushToShopify(rule, previousRule);
    } catch (err) {
      // A stored shopifyDiscountId can go stale (the discount was deleted
      // directly in Shopify admin, or — for automatic discounts — expired
      // and got garbage-collected) — Shopify then rejects the update with
      // "Discount does not exist" rather than a typed not-found error. Retry
      // once as a fresh create instead of surfacing a dead end to the dashboard.
      const isStale = rule.shopifyDiscountId && /does not exist/i.test(err.message || '');
      if (isStale) {
        fastify.log.warn(`Stale shopifyDiscountId ${rule.shopifyDiscountId} for "${rule.title}" — recreating in Shopify`);
        rule.shopifyDiscountId = null;
        try {
          shopifyResult = await pushToShopify(rule, null);
        } catch (retryErr) {
          fastify.log.error('Shopify discount sync failed (retry): ' + retryErr.message);
          return reply.code(502).send({ error: 'Failed to sync discount to Shopify', message: retryErr.message });
        }
      } else {
        fastify.log.error('Shopify discount sync failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to sync discount to Shopify', message: err.message });
      }
    }

    const savedDiscount = {
      ...rule,
      shopifyDiscountId: shopifyResult.shopifyDiscountId,
      active: shopifyResult.status === 'ACTIVE',
      editable: true,
      origin: 'dashboard',
      lastSyncedAt: new Date().toISOString(),
      resolvedCollectionsCount: shopifyResult.resolvedCollections.length,
      resolvedProductsCount: shopifyResult.resolvedProducts.length,
    };

    // A code discount is created open to ALL customers — for an occasion
    // coupon that would hand everyone a birthday code until the first sync
    // narrows it down. So a rule that has no entitled customers yet is parked
    // deactivated, and the sync below switches it back on once it has added
    // the customers whose window is open.
    const isNewOccasionRule =
      savedDiscount.occasion && !(previousRule?.occasionCustomerIds || []).length;
    if (isNewOccasionRule && savedDiscount.active) {
      try {
        const { deactivateShopifyDiscount } = require('../lib/shopifyDiscounts');
        const result = await deactivateShopifyDiscount(savedDiscount.shopifyDiscountId, 'code');
        savedDiscount.active = false;
        savedDiscount.occasionAutoPaused = true;
        savedDiscount.endsAt = result.endsAt ?? savedDiscount.endsAt ?? null;
      } catch (err) {
        fastify.log.error('Failed to park the new occasion coupon: ' + err.message);
        return reply.code(502).send({
          error: 'Saved to Shopify, but the coupon could not be restricted to occasion customers',
          message: err.message,
        });
      }
    }

    const nextDiscounts = previousRule
      ? existingDiscounts.map((d) => (d.id === id ? savedDiscount : d))
      : [savedDiscount, ...existingDiscounts];

    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } },
      { upsert: true }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    // Detached: the sweep reads every customer's dates off Shopify and can run
    // for a minute — nobody should sit on a spinner for it. Staff can force it
    // from the dashboard's "Sync customers" button, which does wait.
    if (savedDiscount.occasion) {
      const { syncOccasionCoupons } = require('../lib/occasionCoupons');
      syncOccasionCoupons(fastify.mongo.db, { ruleId: id }).catch((err) =>
        fastify.log.error('Occasion coupon sync failed: ' + err.message)
      );
    }

    return { discount: savedDiscount };
  });

  // DELETE /api/settings/product-discounts/:id
  // "Deactivate" — pauses the discount in Shopify (discountCodeDeactivate /
  // discountAutomaticDeactivate) so it stops applying immediately, but keeps
  // the local rule around (edit + reactivate later) rather than deleting it.
  fastify.delete('/product-discounts/:id', async (request, reply) => {
    const { id } = request.params;
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const rule = existingDiscounts.find((d) => d.id === id);
    if (!rule) return reply.code(404).send({ error: 'Discount not found' });

    let shopifyEndsAt = rule.endsAt;
    if (rule.shopifyDiscountId) {
      const { deactivateShopifyDiscount } = require('../lib/shopifyDiscounts');
      try {
        const result = await deactivateShopifyDiscount(rule.shopifyDiscountId, rule.method);
        // Shopify implements deactivate by setting its own endsAt to "now" —
        // mirror that locally so the record doesn't quietly disagree with
        // Shopify about why this rule is inactive.
        shopifyEndsAt = result.endsAt ?? shopifyEndsAt;
      } catch (err) {
        fastify.log.error('Shopify discount deactivate failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to deactivate discount in Shopify', message: err.message });
      }
    }

    const updatedRule = { ...rule, active: false, endsAt: shopifyEndsAt };
    const nextDiscounts = existingDiscounts.map((d) => (d.id === id ? updatedRule : d));
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    // Returning the updated record (not just {success:true}) so the
    // dashboard's local state picks up the corrected endsAt too — otherwise
    // it keeps whatever stale endsAt it had in memory and resends that on
    // the next Save & Sync, undoing this.
    return { success: true, discount: updatedRule };
  });

  // POST /api/settings/product-discounts/:id/reactivate
  fastify.post('/product-discounts/:id/reactivate', async (request, reply) => {
    const { id } = request.params;
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    const rule = existingDiscounts.find((d) => d.id === id);
    if (!rule) return reply.code(404).send({ error: 'Discount not found' });

    let shopifyEndsAt = rule.endsAt;
    if (rule.shopifyDiscountId) {
      const { activateShopifyDiscount } = require('../lib/shopifyDiscounts');
      try {
        const result = await activateShopifyDiscount(rule.shopifyDiscountId, rule.method);
        // Activating clears Shopify's own endsAt back to null — without
        // mirroring that here, the next "Save & Sync" would resend whatever
        // stale (now-past) endsAt this record still had locally and
        // immediately re-expire the discount it was just reactivated.
        shopifyEndsAt = result.endsAt ?? null;
      } catch (err) {
        fastify.log.error('Shopify discount activate failed: ' + err.message);
        return reply.code(502).send({ error: 'Failed to reactivate discount in Shopify', message: err.message });
      }
    }

    const updatedRule = { ...rule, active: true, endsAt: shopifyEndsAt };
    const nextDiscounts = existingDiscounts.map((d) => (d.id === id ? updatedRule : d));
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    // Returning the updated record (not just {success:true}) so the
    // dashboard's local state picks up the corrected endsAt too — otherwise
    // it keeps whatever stale endsAt it had in memory and resends that on
    // the next Save & Sync, undoing this exact reactivation.
    return { success: true, discount: updatedRule };
  });

  // PATCH /api/settings/product-discounts/:id/drawer
  // Dashboard-only flag — controls whether this rule appears in the
  // storefront's "Saving Zone" drawer (see cart.js: GET /coupons/active).
  // No Shopify call: the discount already exists there either way.
  fastify.patch('/product-discounts/:id/drawer', async (request, reply) => {
    const { id } = request.params;
    const { showInDrawer, isFeatured, coinsApplicable, combineCoupons, offerLabel } = request.body || {};
    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const existingDiscounts = settings?.discounts || [];
    if (!existingDiscounts.some((d) => d.id === id)) {
      return reply.code(404).send({ error: 'Discount not found' });
    }

    const nextDiscounts = existingDiscounts.map((d) => {
      if (d.id === id) {
        const update = { ...d };
        if (showInDrawer !== undefined) update.showInDrawer = Boolean(showInDrawer);
        if (isFeatured !== undefined) update.isFeatured = Boolean(isFeatured);
        if (coinsApplicable !== undefined) update.coinsApplicable = Boolean(coinsApplicable);
        if (combineCoupons !== undefined) update.combineCoupons = Boolean(combineCoupons);
        // Which label the drawer/banner ticket's spine shows — "BANK OFFER"
        // (the metal-split additional-% rules) or a plain "DISCOUNT". Purely
        // cosmetic, same as the flags above: no Shopify call needed.
        if (offerLabel !== undefined) update.offerLabel = offerLabel === 'discount' ? 'discount' : 'bank_offer';
        return update;
      }
      return d;
    });
    
    await collection.updateOne(
      { key: 'product_discounts_rules' },
      { $set: { discounts: nextDiscounts, updatedAt: new Date() } }
    );

    const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
    invalidateProductDiscountsCache();

    return { success: true };
  });

  // POST /api/settings/product-discounts/:id/occasion-sync
  // Dashboard "Sync customers" — opens/closes today's birthday or anniversary
  // windows for one rule immediately instead of waiting for 03:15 IST. Waits
  // for the sweep (it reads every customer's dates from Shopify), then returns
  // the refreshed rule.
  fastify.post('/product-discounts/:id/occasion-sync', async (request, reply) => {
    const { id } = request.params;
    const { syncOccasionCoupons } = require('../lib/occasionCoupons');

    const settings = await collection.findOne({ key: 'product_discounts_rules' });
    const rule = (settings?.discounts || []).find((d) => d.id === id);
    if (!rule) return reply.code(404).send({ error: 'Discount not found' });
    if (!rule.occasion) return reply.code(400).send({ error: 'This discount is not an occasion coupon' });

    try {
      await syncOccasionCoupons(fastify.mongo.db, { ruleId: id });
    } catch (err) {
      fastify.log.error('Occasion coupon sync failed: ' + err.message);
      return reply.code(502).send({ error: 'Failed to sync occasion customers', message: err.message });
    }

    const refreshed = await collection.findOne({ key: 'product_discounts_rules' });
    return { success: true, discount: (refreshed?.discounts || []).find((d) => d.id === id) };
  });

  // POST /api/settings/product-discounts/sync
  // Pulls every code/automatic discount from Shopify (lib/shopifyDiscounts.js)
  // and merges it into the local rules list, matched by shopifyDiscountId. A
  // rule this dashboard already owns (origin: 'dashboard') keeps its own
  // editable/showInDrawer state on re-sync — only genuinely Shopify-native
  // discounts (created directly in Shopify admin) land as read-only.
  fastify.post('/product-discounts/sync', async (request, reply) => {
    const { fetchAllShopifyDiscounts } = require('../lib/shopifyDiscounts');

    try {
      const shopifyDiscounts = await fetchAllShopifyDiscounts();
      const settings = await collection.findOne({ key: 'product_discounts_rules' });
      const existingDiscounts = settings?.discounts || [];
      const nextDiscounts = [...existingDiscounts];

      let created = 0;
      let updated = 0;

      for (const sd of shopifyDiscounts) {
        // Bxgy / free-shipping discounts aren't representable in our rule
        // shape (no discountType/discountValue/appliesTo) — skip them, same
        // as the dashboard only ever creates Basic code/automatic discounts.
        if (!sd.editable) continue;

        const existingIndex = nextDiscounts.findIndex((d) => d.shopifyDiscountId === sd.shopifyDiscountId);
        const existing = existingIndex >= 0 ? nextDiscounts[existingIndex] : null;
        const isDashboardOwned = existing?.origin === 'dashboard';

        const merged = {
          id: existing?.id || `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          shopifyDiscountId: sd.shopifyDiscountId,
          title: sd.title,
          method: sd.method,
          discountType: sd.discountType,
          discountValue: sd.discountValue,
          appliesTo: sd.appliesTo,
          selectedCollections: sd.selectedCollections,
          selectedProducts: sd.selectedProducts,
          // Local-only, like the stacking flags below — Shopify can't store an
          // exclusion, so a re-sync must carry it across or every rule's
          // carve-outs would silently reset to none.
          excludedCollections: existing?.excludedCollections || [],
          minRequirement: sd.minRequirement,
          minRequirementValue: sd.minRequirementValue,
          startsAt: sd.startsAt,
          endsAt: sd.endsAt,
          active: sd.shopifyStatus === 'ACTIVE',
          showInDrawer: existing?.showInDrawer || false,
          isFeatured: existing?.isFeatured || false,
          // Dashboard-only stacking flags. Shopify knows nothing about them, so
          // like the two above they have to be carried across a re-sync — a
          // plain rebuild from `sd` would silently reset every rule's
          // "Lucira Coins applicable" / "Combine coupons" to off.
          coinsApplicable: existing?.coinsApplicable || false,
          combineCoupons: existing?.combineCoupons || false,
          offerLabel: existing?.offerLabel === 'discount' ? 'discount' : 'bank_offer',
          // Editability is a structural property of the Shopify discount type
          // (DiscountCodeBasic/DiscountAutomaticBasic — the only types our
          // mutations support), not of who happened to create it. The loop
          // above already skipped anything sd.editable is false for, so
          // everything reaching here genuinely can be edited from here —
          // gating this on origin instead made every Shopify-native discount
          // (the vast majority of the catalog) permanently read-only.
          editable: true,
          origin: isDashboardOwned ? 'dashboard' : 'shopify',
          lastSyncedAt: new Date().toISOString(),
          // selectedCollections/selectedProducts just above came straight from
          // Shopify's own live customerGets.items, so right after a sync they
          // ARE what's resolved by construction — leaving these two off (as
          // this object used to) meant the dashboard's "0 products resolved"
          // warning fired on every re-synced rule regardless of its real state.
          resolvedCollectionsCount: sd.selectedCollections?.length || 0,
          resolvedProductsCount: sd.selectedProducts?.length || 0,
          // Local-only again: Shopify has no notion of "this is the birthday
          // coupon", so a re-sync has to carry the tag and the entitled
          // customer ids across or the scheduler would re-add every open
          // window from scratch and the rule would lose its occasion.
          ...occasionFields(existing || {}, existing),
        };

        if (existingIndex >= 0) {
          nextDiscounts[existingIndex] = merged;
          updated++;
        } else {
          nextDiscounts.push(merged);
          created++;
        }
      }

      // A discount deleted directly in Shopify admin (not just deactivated —
      // deactivated ones still come back from fetchAllShopifyDiscounts with
      // shopifyStatus !== 'ACTIVE') stops appearing in the fetched list
      // entirely. Drop any local record that's still pointing at a
      // shopifyDiscountId no longer live, so the dashboard can't keep
      // showing/managing a discount that no longer exists to sync against.
      // Built from the full unfiltered list (not just sd.editable ones) so a
      // Bxgy/FreeShipping discount — which we never store locally anyway —
      // can't be mistaken for "deleted" here.
      const liveShopifyIds = new Set(shopifyDiscounts.map((sd) => sd.shopifyDiscountId));
      const beforeDelete = nextDiscounts.length;
      const survivingDiscounts = nextDiscounts.filter(
        (d) => !d.shopifyDiscountId || liveShopifyIds.has(d.shopifyDiscountId)
      );
      const removed = beforeDelete - survivingDiscounts.length;

      await collection.updateOne(
        { key: 'product_discounts_rules' },
        { $set: { discounts: survivingDiscounts, updatedAt: new Date() } },
        { upsert: true }
      );

      const { invalidateProductDiscountsCache } = require('../lib/cartPricing');
      invalidateProductDiscountsCache();

      return reply.send({ success: true, created, updated, removed });
    } catch (err) {
      fastify.log.error('Product discount sync failed: ' + err.message);
      return reply.code(500).send({ error: 'Sync failed', message: err.message });
    }
  });

  // Default categories for Explore Our Range
  const EXPLORE_RANGE_DEFAULTS = [
    { id: "1", name: "Rings", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Rings_cdcd476d-83ad-4bc8-9463-0a13217a051c.jpg?v=1788436552", href: "/collections/rings" },
    { id: "2", name: "Earrings", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Earrings_15f534ee-2965-489d-bb83-f5293775d792.jpg?v=1788436551", href: "/collections/earrings" },
    { id: "3", name: "Bracelets", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Tennis-Bracelet.jpg?v=1788436552", href: "/collections/bracelets" },
    { id: "4", name: "Necklaces", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Necklaces_c3067ae6-14cc-45c4-9d7b-6a66ae6d5f69.jpg?v=1788436552", href: "/collections/necklaces" },
    { id: "5", name: "Nosepins", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Nosepins.jpg?v=1788436551", href: "/collections/nosepins" },
    { id: "6", name: "Mangalsutra", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Mangalsutras.jpg?v=1788436552", href: "/collections/mangalsutra" },
    { id: "7", name: "Men's Ring", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Men_27s-Ring.jpg?v=1788436552", href: "/collections/mens-rings" },
    { id: "8", name: "Men's Stud", image: "https://cdn.shopify.com/s/files/1/0739/8516/3482/files/Men_27s-Stud.jpg?v=1788436552", href: "/collections/mens-stud" },
  ];

  // GET /api/settings/explore-range
  fastify.get('/explore-range', async () => {
    const settings = await collection.findOne({ key: 'explore_range' });
    const categories = Array.isArray(settings?.categories) && settings.categories.length > 0
      ? settings.categories
      : EXPLORE_RANGE_DEFAULTS;

    return {
      title: settings?.title || 'Explore Our Range',
      subtitle: settings?.subtitle || 'Find diamond jewelry pieces that match your style.',
      categories,
    };
  });

  // POST /api/settings/explore-range
  fastify.post('/explore-range', async (request, reply) => {
    const { categories, title, subtitle } = request.body || {};
    if (!Array.isArray(categories)) {
      return reply.code(400).send({ error: 'categories must be an array' });
    }

    const sanitizedCategories = categories.map((c, i) => ({
      id: String(c.id || `cat_${Date.now()}_${i}`),
      name: String(c.name || '').trim(),
      image: String(c.image || '').trim(),
      href: String(c.href || '').trim(),
    }));

    await collection.updateOne(
      { key: 'explore_range' },
      {
        $set: {
          title: String(title || 'Explore Our Range').trim(),
          subtitle: String(subtitle || 'Find diamond jewelry pieces that match your style.').trim(),
          categories: sanitizedCategories,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Fire-and-forget homepage ISR revalidation
    try {
      const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      fetch(`${frontendUrl}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/' }),
      }).catch(() => {});
    } catch (_) {}

    return { success: true };
  });

  // Defaults for /api/settings/jewellery-on-emi
  const JEWELLERY_ON_EMI_DEFAULTS = {
    hero: {
      enabled: true,
      lead: "You can buy jewelry on EMI at Lucira where eligible, with 0-cost EMI and tenures of 3, 6, 9 and 12 months.",
      scope: {
        enabled: true,
        title: "EMI applies only to the eligible diamond component of a piece. We do not finance the gold component.",
        subtitle: "The gold component is paid as a down payment.",
      },
      description: "Get your jewelry without waiting for the final EMI. Once the required approval, KYC and order formalities are completed, eligible ready-to-ship (RTS) and made-to-order (MTO) orders can be handed over while the remaining EMIs continue as scheduled.",
      showDescription: true,
      buttons: [
        { id: "btn_1", label: "See how EMI works", href: "#how-it-works", variant: "primary", enabled: true },
        { id: "btn_2", label: "Visit an Experience Centre", href: "#experience-centres", variant: "secondary", enabled: true },
      ],
      trustText: "Certified lab-grown diamonds · Experience Centres in Mumbai, Pune, Noida and Delhi",
      showTrustText: true,
    },
    facts: [
      { id: "fact_1", title: "3, 6, 9, 12", subtitle: "month EMI tenures", enabled: true },
      { id: "fact_2", title: "0-cost EMI", subtitle: "on the eligible diamond component", enabled: true },
      { id: "fact_3", title: "₹0", subtitle: "processing fee", enabled: true },
      { id: "fact_4", title: "No extra cost", subtitle: "charged to you for EMI", enabled: true },
    ],
    productsIntro: {
      enabled: true,
      title: "Diamond jewelry from ₹50,000",
      subtitle: "EMI is available where eligible and applies to the diamond component of each piece.",
    },
    calculator: {
      title: "Jewelry EMI Calculator",
      subtitle: "Real-time monthly installment estimate",
      interestBadge: "0% Interest",
      minValue: 50000,
      maxValue: 300000,
      stepValue: 5000,
      defaultValue: 75000,
      presetAmounts: [50000, 75000, 100000, 150000, 200000],
      downPaymentOptions: [
        { percent: 0, label: "0% (Diamond)" },
        { percent: 20, label: "20% Gold" },
        { percent: 30, label: "30% Gold" },
        { percent: 40, label: "40% Gold" },
      ],
      defaultDownPaymentPercent: 20,
      tenures: [3, 6, 9, 12],
      defaultTenure: 6,
      allowCustomTenure: true,
      minCustomTenure: 1,
      maxCustomTenure: 36,
      disclaimer: "*Illustration only. Subject to partner approval & KYC verification.",
      ctaText: "Explore Eligible Jewelry",
      ctaTarget: "products",
    },
  };

  // GET /api/settings/jewellery-on-emi
  fastify.get('/jewellery-on-emi', async () => {
    const settings = await collection.findOne({ key: 'jewellery_on_emi' });
    if (!settings) {
      return JEWELLERY_ON_EMI_DEFAULTS;
    }
    return {
      hero: {
        ...JEWELLERY_ON_EMI_DEFAULTS.hero,
        ...(settings.hero || {}),
        scope: {
          ...JEWELLERY_ON_EMI_DEFAULTS.hero.scope,
          ...(settings.hero?.scope || {}),
        },
        buttons: Array.isArray(settings.hero?.buttons)
          ? settings.hero.buttons
          : JEWELLERY_ON_EMI_DEFAULTS.hero.buttons,
      },
      facts: Array.isArray(settings.facts)
        ? settings.facts
        : JEWELLERY_ON_EMI_DEFAULTS.facts,
      productsIntro: {
        ...JEWELLERY_ON_EMI_DEFAULTS.productsIntro,
        ...(settings.productsIntro || {}),
      },
      calculator: {
        ...JEWELLERY_ON_EMI_DEFAULTS.calculator,
        ...(settings.calculator || {}),
        presetAmounts: Array.isArray(settings.calculator?.presetAmounts)
          ? settings.calculator.presetAmounts
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.presetAmounts,
        downPaymentOptions: Array.isArray(settings.calculator?.downPaymentOptions)
          ? settings.calculator.downPaymentOptions
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.downPaymentOptions,
        tenures: Array.isArray(settings.calculator?.tenures)
          ? settings.calculator.tenures
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.tenures,
      },
    };
  });

  // POST /api/settings/jewellery-on-emi
  fastify.post('/jewellery-on-emi', async (request, reply) => {
    const body = request.body || {};
    const hero = body.hero || {};
    const facts = Array.isArray(body.facts) ? body.facts : JEWELLERY_ON_EMI_DEFAULTS.facts;
    const calculator = body.calculator || {};
    const productsIntro = body.productsIntro || {};

    const sanitizedData = {
      productsIntro: {
        enabled: productsIntro.enabled !== false,
        title: String(productsIntro.title ?? JEWELLERY_ON_EMI_DEFAULTS.productsIntro.title).trim(),
        subtitle: String(productsIntro.subtitle ?? JEWELLERY_ON_EMI_DEFAULTS.productsIntro.subtitle).trim(),
      },
      hero: {
        enabled: hero.enabled !== false,
        lead: String(hero.lead || JEWELLERY_ON_EMI_DEFAULTS.hero.lead).trim(),
        scope: {
          enabled: hero.scope?.enabled !== false,
          title: String(hero.scope?.title || '').trim(),
          subtitle: String(hero.scope?.subtitle || '').trim(),
        },
        description: String(hero.description || '').trim(),
        showDescription: hero.showDescription !== false,
        buttons: Array.isArray(hero.buttons) ? hero.buttons.map((b, idx) => ({
          id: String(b.id || `btn_${idx + 1}`),
          label: String(b.label || '').trim(),
          href: String(b.href || '').trim(),
          variant: b.variant === 'secondary' ? 'secondary' : 'primary',
          enabled: b.enabled !== false,
        })) : JEWELLERY_ON_EMI_DEFAULTS.hero.buttons,
        trustText: String(hero.trustText || '').trim(),
        showTrustText: hero.showTrustText !== false,
      },
      facts: facts.map((f, idx) => ({
        id: String(f.id || `fact_${idx + 1}`),
        title: String(f.title || '').trim(),
        subtitle: String(f.subtitle || '').trim(),
        enabled: f.enabled !== false,
      })),
      calculator: {
        title: String(calculator.title || JEWELLERY_ON_EMI_DEFAULTS.calculator.title).trim(),
        subtitle: String(calculator.subtitle || JEWELLERY_ON_EMI_DEFAULTS.calculator.subtitle).trim(),
        interestBadge: String(calculator.interestBadge || JEWELLERY_ON_EMI_DEFAULTS.calculator.interestBadge).trim(),
        minValue: Number(calculator.minValue) || JEWELLERY_ON_EMI_DEFAULTS.calculator.minValue,
        maxValue: Number(calculator.maxValue) || JEWELLERY_ON_EMI_DEFAULTS.calculator.maxValue,
        stepValue: Number(calculator.stepValue) || JEWELLERY_ON_EMI_DEFAULTS.calculator.stepValue,
        defaultValue: Number(calculator.defaultValue) || JEWELLERY_ON_EMI_DEFAULTS.calculator.defaultValue,
        presetAmounts: Array.isArray(calculator.presetAmounts)
          ? calculator.presetAmounts.map(Number).filter(n => !isNaN(n) && n > 0)
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.presetAmounts,
        downPaymentOptions: Array.isArray(calculator.downPaymentOptions)
          ? calculator.downPaymentOptions.map((dp) => ({
              percent: Number(dp.percent) || 0,
              label: String(dp.label || `${dp.percent}%`).trim(),
            }))
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.downPaymentOptions,
        defaultDownPaymentPercent: Number(calculator.defaultDownPaymentPercent) ?? 20,
        tenures: Array.isArray(calculator.tenures)
          ? calculator.tenures.map(Number).filter(n => !isNaN(n) && n > 0)
          : JEWELLERY_ON_EMI_DEFAULTS.calculator.tenures,
        defaultTenure: Number(calculator.defaultTenure) || 6,
        allowCustomTenure: calculator.allowCustomTenure !== false,
        minCustomTenure: Number(calculator.minCustomTenure) || 1,
        maxCustomTenure: Number(calculator.maxCustomTenure) || 36,
        disclaimer: String(calculator.disclaimer || JEWELLERY_ON_EMI_DEFAULTS.calculator.disclaimer).trim(),
        ctaText: String(calculator.ctaText || JEWELLERY_ON_EMI_DEFAULTS.calculator.ctaText).trim(),
        ctaTarget: String(calculator.ctaTarget || 'products').trim(),
      },
    };

    await collection.updateOne(
      { key: 'jewellery_on_emi' },
      {
        $set: {
          ...sanitizedData,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Fire-and-forget collection page revalidation
    try {
      const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      fetch(`${frontendUrl}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'collection', handle: 'jewellery-on-emi' }),
      }).catch(() => {});
    } catch (_) {}

    return { success: true };
  });

  // GET /api/settings/offers-page
  fastify.get('/offers-page', async () => {
    const settings = await collection.findOne({ key: 'offers_page' });
    if (!settings) {
      return OFFERS_PAGE_DEFAULTS;
    }
    return {
      heroBanner: settings.heroBanner || OFFERS_PAGE_DEFAULTS.heroBanner,
      offerCards: Array.isArray(settings.offerCards) && settings.offerCards.length > 0
        ? settings.offerCards
        : OFFERS_PAGE_DEFAULTS.offerCards,
      trustBadges: settings.trustBadges || OFFERS_PAGE_DEFAULTS.trustBadges,
      seo: settings.seo || OFFERS_PAGE_DEFAULTS.seo,
      updatedAt: settings.updatedAt || null,
    };
  });

  // POST /api/settings/offers-page
  fastify.post('/offers-page', async (request, reply) => {
    const body = request.body || {};
    const heroBanner = body.heroBanner || {};
    const offerCards = Array.isArray(body.offerCards) ? body.offerCards : [];
    const trustBadges = body.trustBadges || {};
    const seo = body.seo || {};

    const sanitizedData = {
      heroBanner: {
        enabled: heroBanner.enabled !== false,
        title: String(heroBanner.title !== undefined ? heroBanner.title : OFFERS_PAGE_DEFAULTS.heroBanner.title).trim(),
        subtitle: String(heroBanner.subtitle || '').trim(),
        desktopImage: String(heroBanner.desktopImage || OFFERS_PAGE_DEFAULTS.heroBanner.desktopImage).trim(),
        mobileImage: String(heroBanner.mobileImage || heroBanner.desktopImage || OFFERS_PAGE_DEFAULTS.heroBanner.mobileImage).trim(),
        link: String(heroBanner.link || '').trim(),
        alt: String(heroBanner.alt || 'Something Special Awaits').trim(),
      },
      offerCards: offerCards.map((c, idx) => ({
        id: String(c.id || `offer_${Date.now()}_${idx}`),
        title: String(c.title || '').trim(),
        image: String(c.image || '').trim(),
        mobileImage: String(c.mobileImage || c.image || '').trim(),
        link: String(c.link || '').trim(),
        buttonText: String(c.buttonText !== undefined ? c.buttonText : '').trim(),
        buttonTheme: String(c.buttonTheme || 'dark').trim(),
        alt: String(c.alt || c.title || 'Special Offer').trim(),
        enabled: c.enabled !== false,
      })),
      trustBadges: {
        enabled: trustBadges.enabled !== false,
        items: Array.isArray(trustBadges.items) ? trustBadges.items.map((b, idx) => ({
          id: String(b.id || `tb_${idx + 1}`),
          text: String(b.text || '').trim(),
          icon: String(b.icon || 'shipping').trim(),
        })) : OFFERS_PAGE_DEFAULTS.trustBadges.items,
      },
      seo: {
        title: String(seo.title || OFFERS_PAGE_DEFAULTS.seo.title).trim(),
        description: String(seo.description || OFFERS_PAGE_DEFAULTS.seo.description).trim(),
      },
    };

    await collection.updateOne(
      { key: 'offers_page' },
      {
        $set: {
          ...sanitizedData,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Fire-and-forget ISR revalidation
    try {
      const frontendUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      fetch(`${frontendUrl}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'path', path: '/offers' }),
      }).catch(() => {});
      fetch(`${frontendUrl}/api/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'path', path: '/pages/offers' }),
      }).catch(() => {});
    } catch (_) {}

    return { success: true, settings: sanitizedData };
  });
}

module.exports = routes;

