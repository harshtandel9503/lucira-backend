// ─────────────────────────────────────────────────────────────────────────────
// Store-page content: normalisation shared by the read and write endpoints.
//
// `normalizeStorePages` is deliberately forgiving — it fills in every field a
// storefront surface reads, so a doc saved by an older version of the dashboard
// (or hand-edited in Mongo) can never render `undefined` on the site. The write
// path runs the same normaliser, which means what we store is always the shape
// we serve.
// ─────────────────────────────────────────────────────────────────────────────

const { STORE_PAGE_DEFAULTS, DEFAULT_SERVICES, FACILITY_SUGGESTIONS } = require('./storePageDefaults');

const STATUSES = ['auto', 'opening_soon', 'temporarily_closed'];

const SURFACE_KEYS = [
  'collectionBanner',
  'homepage',
  'productPage',
  'storeLocator',
  'footerLink',
  // "Lucira's Experience Stores" — the phone/email/address block above the
  // homepage footer copy.
  'experienceStores',
];

const str = (v) => String(v == null ? '' : v).trim();

/** Collection handles only: lowercase, no slashes, no spaces. Accepts a full URL. */
function toHandle(v) {
  const raw = str(v);
  const fromUrl = raw.match(/\/collections\/([^/?#]+)/);
  return (fromUrl ? fromUrl[1] : raw)
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/** "10:30" / "9:5" / garbage → "10:30" / "09:05" / fallback. */
function toTime(v, fallback) {
  const m = str(v).match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return fallback;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toNumberOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStore(input, index) {
  const s = input && typeof input === 'object' ? input : {};
  const handle = toHandle(s.handle);
  const surfacesIn = s.surfaces && typeof s.surfaces === 'object' ? s.surfaces : {};
  const linksIn = s.links && typeof s.links === 'object' ? s.links : {};
  const imagesIn = s.images && typeof s.images === 'object' ? s.images : {};
  const hoursIn = s.hours && typeof s.hours === 'object' ? s.hours : {};
  const geoIn = s.geo && typeof s.geo === 'object' ? s.geo : {};
  const overridesIn = s.sortOverrides && typeof s.sortOverrides === 'object' ? s.sortOverrides : {};

  const surfaces = {};
  // A surface is on unless explicitly switched off, so a store added by an
  // older dashboard build still shows up everywhere it should.
  SURFACE_KEYS.forEach((k) => { surfaces[k] = surfacesIn[k] !== false; });

  const services = Array.isArray(s.services) && s.services.length
    ? s.services
        .map((v) => ({ title: str(v && v.title), icon: str(v && v.icon) }))
        .filter((v) => v.title)
    : DEFAULT_SERVICES.map((v) => ({ ...v }));

  return {
    id: str(s.id) || `st_${handle || 'store'}_${index}`,
    handle,
    city: str(s.city) || str(s.name),
    name: str(s.name) || str(s.city),
    rating: toNumberOrNull(s.rating),
    status: STATUSES.includes(s.status) ? s.status : 'auto',
    published: s.published !== false,

    hours: {
      weekday: {
        open: toTime(hoursIn.weekday && hoursIn.weekday.open, '10:30'),
        close: toTime(hoursIn.weekday && hoursIn.weekday.close, '22:00'),
      },
      weekend: {
        open: toTime(hoursIn.weekend && hoursIn.weekend.open, '10:30'),
        close: toTime(hoursIn.weekend && hoursIn.weekend.close, '22:00'),
      },
    },
    // Free-text escape hatch. Blank means "derive the line from `hours`".
    hoursLabel: str(s.hoursLabel),

    address: str(s.address),
    // Shown in the experience-stores footer block. `phone` is the number as it
    // should READ; `links.call` is what it dials — they differ in spacing today
    // and the block falls back to `links.call` when `phone` is blank.
    email: str(s.email),
    phone: str(s.phone),

    links: {
      map: str(linksIn.map),
      call: str(linksIn.call),
      appointment: str(linksIn.appointment),
      // "View available designs" defaults to the store's own collection page.
      designs: str(linksIn.designs) || (handle ? `/collections/${handle}` : ''),
      whatsapp: str(linksIn.whatsapp),
      directions: str(linksIn.directions) || str(linksIn.map),
    },

    facilities: Array.isArray(s.facilities) ? s.facilities.map(str).filter(Boolean) : [],
    services,

    images: {
      // Carousel on /collections/<handle>.
      collection: Array.isArray(imagesIn.collection) ? imagesIn.collection.map(str).filter(Boolean) : [],
      // Single hero for the homepage + product-page section.
      homepage: str(imagesIn.homepage),
      // Single card image on /pages/store-locator.
      locator: str(imagesIn.locator),
    },

    geo: { lat: toNumberOrNull(geoIn.lat), lng: toNumberOrNull(geoIn.lng) },
    // false = stock-holding location, not a showroom customers walk into.
    visitable: s.visitable !== false,
    shopifyLocationId: str(s.shopifyLocationId),
    locationAliases: Array.isArray(s.locationAliases)
      ? s.locationAliases.map(str).filter(Boolean)
      : (typeof s.locationAliases === 'string'
          ? s.locationAliases.split(',').map(str).filter(Boolean)
          : []),

    surfaces,
    footerLinkLabel: str(s.footerLinkLabel),
    // Heading in the experience-stores block ("Head Office", "Pune Store").
    experienceLabel: str(s.experienceLabel),

    sort: Number.isFinite(Number(s.sort)) ? Number(s.sort) : index,
    // null = "use the global sort on this surface". Only the pre-existing
    // stores set these, to keep today's tab order byte-identical.
    sortOverrides: {
      homepage: toNumberOrNull(overridesIn.homepage),
      storeLocator: toNumberOrNull(overridesIn.storeLocator),
      footerLink: toNumberOrNull(overridesIn.footerLink),
      experienceStores: toNumberOrNull(overridesIn.experienceStores),
    },
  };
}

const SEED_BY_HANDLE = Object.fromEntries(STORE_PAGE_DEFAULTS.stores.map((s) => [s.handle, s]));

// Fields added to the schema after stores were already being saved. A doc
// written by an older dashboard build has no key for them at all.
const LATE_FIELDS = ['email', 'phone', 'experienceLabel', 'shopifyLocationId', 'locationAliases'];

/**
 * Fill in fields a stored record predates, from the seed entry for the same
 * store.
 *
 * Without this, adding a field to the schema silently blanks live content:
 * `str(undefined)` is `''`, so the first render after the deploy would drop
 * every store email — even though nobody edited anything. `undefined` means the
 * field never existed; an empty string means the merchant cleared it on
 * purpose, and is left alone.
 */
function backfillLateFields(input) {
  const s = input && typeof input === 'object' ? input : {};
  const seed = SEED_BY_HANDLE[toHandle(s.handle)];
  if (!seed) return s;

  const out = { ...s };
  LATE_FIELDS.forEach((key) => {
    if (out[key] === undefined) out[key] = seed[key];
  });

  // The per-surface position matters as much as the content: with no value the
  // store falls back to its global sort, which is a different order.
  if (out.sortOverrides && typeof out.sortOverrides === 'object' && out.sortOverrides.experienceStores === undefined) {
    out.sortOverrides = { ...out.sortOverrides, experienceStores: seed.sortOverrides.experienceStores };
  }
  return out;
}

/**
 * Take whatever is stored (or nothing at all) and return the full payload the
 * storefront reads. With no stored doc this is the verbatim pre-dashboard
 * content, so the site renders identically before the first save.
 */
function normalizeStorePages(stored) {
  const hasStored = stored && Array.isArray(stored.stores) && stored.stores.length;
  const source = hasStored ? stored : STORE_PAGE_DEFAULTS;

  const stores = source.stores
    .map((s) => normalizeStore(hasStored ? backfillLateFields(s) : s))
    // Entries with no collection handle can't be addressed by any surface.
    .filter((s) => s.handle)
    .sort((a, b) => a.sort - b.sort);

  const serviceCatalog = Array.isArray(stored && stored.serviceCatalog) && stored.serviceCatalog.length
    ? stored.serviceCatalog.map((v) => ({ title: str(v && v.title), icon: str(v && v.icon) })).filter((v) => v.title)
    : DEFAULT_SERVICES.map((v) => ({ ...v }));

  const facilitySuggestions = Array.isArray(stored && stored.facilitySuggestions) && stored.facilitySuggestions.length
    ? stored.facilitySuggestions.map(str).filter(Boolean)
    : [...FACILITY_SUGGESTIONS];

  return { stores, serviceCatalog, facilitySuggestions };
}

/**
 * Shopify names its locations by internal code (BO1, PS1, NOS18…), which no
 * amount of city-name matching will connect to a store page. This mirrors
 * `_backendNameToHandle` in the storefront's src/data/stores.js so the dashboard
 * can tell "this location already has a page" from "this one is new" — without
 * it, every coded location looks importable and invites a duplicate.
 */
const LOCATION_ALIASES = [
  { match: 'divinecarat', handle: 'malad' },
  { match: 'bo1', handle: 'sky-city-borivali-store' },
  { match: 'borivali', handle: 'sky-city-borivali-store' },
  { match: 'cs1', handle: 'chembur-store' },
  { match: 'chembur', handle: 'chembur-store' },
  { match: 'ps1', handle: 'pune-store' },
  { match: 'pune', handle: 'pune-store' },
  { match: 'nos18', handle: 'noida-store' },
  { match: 'noida', handle: 'noida-store' },
  { match: 'paschim', handle: 'paschim-vihar' },
  { match: 'lajpat', handle: 'lajpat-nagar-store' },
];

/**
 * Which store page (if any) a Shopify location belongs to: the explicit link
 * first, then the alias table, then a plain city/name match so a store added
 * later is recognised without touching the table above.
 */
function matchLocationToStore(locationName, stores) {
  const name = String(locationName || '').toLowerCase().trim();
  if (!name) return null;

  const explicit = stores.find((s) => {
    if (s.shopifyLocationId && name.includes(s.shopifyLocationId.toLowerCase())) return true;
    if (Array.isArray(s.locationAliases)) {
      return s.locationAliases.some((alias) => {
        const a = String(alias).toLowerCase().trim();
        return a && (name.includes(a) || a.includes(name));
      });
    }
    return false;
  });
  if (explicit) return explicit;

  const alias = LOCATION_ALIASES.find((a) => name.includes(a.match));
  if (alias) {
    const hit = stores.find((s) => s.handle === alias.handle);
    if (hit) return hit;
  }

  return stores.find((s) => {
    const needles = [s.city, s.name].map((v) => String(v || '').toLowerCase().trim()).filter(Boolean);
    return needles.some((n) => name.includes(n) || n.includes(name));
  }) || null;
}

module.exports = {
  normalizeStorePages,
  normalizeStore,
  matchLocationToStore,
  LOCATION_ALIASES,
  SURFACE_KEYS,
  STATUSES,
  toHandle,
};
