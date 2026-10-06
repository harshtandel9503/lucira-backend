/**
 * Customer Routes (Fastify)
 * Handles profile, avatar, dashboard stats, coins, etc.
 */

const { shopifyAdminFetch, shopifyStorefrontFetch, shopifyAdminRestFetch } = require('../lib/shopify');
const returnsLib = require('../lib/returns');

const CLICKPOST_SECURITY_KEY = process.env.CLICKPOST_SECURITY_KEY || '2f6fe169-505f-47d8-bf14-da099427c840';

function getClickPostTrackingUrl(waybill, cpId = 5) {
  if (!waybill) return '';
  return `https://track.clickpost.in/?waybill=${encodeURIComponent(waybill)}&source=dashboard&cp_id=${encodeURIComponent(cpId)}&security_key=${encodeURIComponent(CLICKPOST_SECURITY_KEY)}`;
}

const ADDRESS_FIELDS = `
  id
  address1
  address2
  city
  company
  country
  firstName
  lastName
  phone
  province
  zip
  formatted(withName: true, withCompany: true)
`;

function normalizeAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    firstName: address.firstName || "",
    lastName: address.lastName || "",
    company: address.company || "",
    address1: address.address1 || "",
    address2: address.address2 || "",
    city: address.city || "",
    province: address.province || "",
    zip: address.zip || "",
    country: address.country || "",
    phone: address.phone || "",
    formatted: Array.isArray(address.formatted) ? address.formatted.filter(Boolean) : [],
  };
}

async function fetchCustomerAddresses(customerAccessToken, db) {
  const data = await shopifyStorefrontFetch(`
    query CustomerAddresses($customerAccessToken: String!) {
      customer(customerAccessToken: $customerAccessToken) {
        id
        firstName
        lastName
        email
        phone
        defaultAddress {
          ${ADDRESS_FIELDS}
        }
        addresses(first: 50) {
          edges {
            node {
              ${ADDRESS_FIELDS}
            }
          }
        }
      }
    }
  `, { customerAccessToken });

  const customer = data?.customer;
  if (!customer) throw new Error("Customer not found");

  const addressIds = (customer.addresses?.edges || [])
    .map(({ node }) => node?.id)
    .filter(Boolean);

  let metaMap = new Map();
  try {
    const addressMetaCollection = db.collection("customer_address_meta");
    const metaRows = addressIds.length
      ? await addressMetaCollection.find({ addressId: { $in: addressIds } }).toArray()
      : [];
    metaMap = new Map(metaRows.map(row => [row.addressId, row.gstin || ""]));
  } catch (error) {
    console.error("GSTIN metadata read error:", error);
  }

  const defaultAddressId = customer.defaultAddress?.id || null;
  const addresses = (customer.addresses?.edges || []).map(({ node }) => {
    const normalized = normalizeAddress(node);
    return {
      ...normalized,
      gstin: metaMap.get(normalized?.id) || "",
      isDefault: normalized?.id === defaultAddressId,
    };
  });

  return {
    customer: {
      id: customer.id,
      firstName: customer.firstName || "",
      lastName: customer.lastName || "",
      email: customer.email || "",
      phone: customer.phone || "",
    },
    defaultAddressId,
    addresses,
  };
}

/* ─────────────────────────────────────────────────────────
   MY OCCASIONS — controlled lists, mapping & business flag
   (Lucira "My Profile & My Occasions" PRD v1.2)
───────────────────────────────────────────────────────── */

// Delete-and-recreate flag. Must gate BOTH the UI and this API (PRD §7.8).
const OCCASION_DELETE_ENABLED = true;
const OCCASION_TITLE_MAX = 80;
const OCCASION_RELATIONSHIPS = new Set(['self', 'wife', 'mother', 'sister', 'friend', 'girlfriend', 'daughter', 'husband', 'father', 'son', 'niece_nephew', 'grandparent', 'others']);
const OCCASION_NAMES = new Set(['anniversary', 'birthday', 'engagement', 'wedding', 'other']);

// Shape a stored occasion for the customer-facing response.
// editable is ALWAYS false — occasions are immutable (OCC-BR-01/09).
function mapOccasion(o) {
  return {
    occasion_id: o.occasion_id,
    relationship_name: o.relationship_name,
    occasion_name: o.occasion_name,
    occasion_title: o.occasion_title,
    event_date: o.event_date,
    created_at: o.created_at,
    status: o.status || 'active',
    editable: false,
    deletable: OCCASION_DELETE_ENABLED,
  };
}

async function routes(fastify, options) {
  const db = fastify.mongo.db;
  const avatarCollection = db.collection('customer_avatars');
  const coinsCollection = db.collection('customer_coins');
  const occasionsCollection = db.collection('customer_occasions');

  // Resolve the authenticated customer's Shopify gid from their token.
  // Ownership is always derived server-side, never trusted from the client.
  const resolveCustomerId = async (accessToken) => {
    const data = await shopifyStorefrontFetch(`
      query($customerAccessToken: String!) {
        customer(customerAccessToken: $customerAccessToken) { id }
      }
    `, { customerAccessToken: accessToken });
    return data?.customer?.id || null;
  };

  // Helper to extract access token from authorization header
  const getAccessToken = (request) => {
    const authHeader = request.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  };

  // GET /api/customer/profile/avatar
  fastify.get('/profile/avatar', async (request, reply) => {
    const accessToken = getAccessToken(request);
    let customerId = null;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });
        customerId = customerData?.customer?.id;
      } catch (err) {
        console.error("[Backend GET /profile/avatar] Shopify fetch error:", err);
      }
    }

    // Secondary fallback to query userId
    if (!customerId) {
      const { userId } = request.query;
      if (userId) {
        customerId = userId.startsWith("gid://") ? userId : `gid://shopify/Customer/${userId}`;
      }
    }

    if (!customerId) {
      return { avatar: null };
    }

    try {
      // 1. Try customer_profiles
      const profile = await db.collection("customer_profiles").findOne({ customerId });
      if (profile?.avatarUrl) {
        return { avatar: profile.avatarUrl };
      }

      // 2. Try customer_avatars as secondary fallback
      const avatarRecord = await avatarCollection.findOne({ userId: customerId });
      if (avatarRecord?.avatarUrl) {
        return { avatar: avatarRecord.avatarUrl };
      }
    } catch (e) {
      console.error("[Backend GET /profile/avatar] Database read error:", e);
    }

    return { avatar: null };
  });

  // POST /api/customer/profile/avatar
  fastify.post('/profile/avatar', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const customerData = await shopifyStorefrontFetch(`
        query($customerAccessToken: String!) {
          customer(customerAccessToken: $customerAccessToken) { id }
        }
      `, { customerAccessToken: accessToken });

      const customerId = customerData?.customer?.id;
      if (!customerId) {
        return reply.code(401).send({ error: "Unauthorized: Customer not found" });
      }

      const fileData = await request.file();
      if (!fileData) {
        return reply.code(400).send({ error: "No file uploaded" });
      }

      const buffer = await fileData.toBuffer();
      const base64Image = `data:${fileData.mimetype};base64,${buffer.toString('base64')}`;

      // Save to MongoDB collection 'customer_profiles'
      await db.collection("customer_profiles").updateOne(
        { customerId },
        { 
          $set: { 
            avatarUrl: base64Image,
            updatedAt: new Date()
          } 
        },
        { upsert: true }
      );

      return { success: true, url: base64Image };
    } catch (err) {
      console.error("[Backend POST /customer/profile/avatar] Error:", err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /api/customer/dashboard-stats
  fastify.get('/dashboard-stats', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const simpleId = customerId.split("/").pop();
          
          const NECTOR_ENDPOINT = "https://refer-earn-385594025448.asia-south1.run.app";
          const fetchNectorCoins = async (simpleId) => {
            try {
              const res = await fetch(`${NECTOR_ENDPOINT}?customer_id=shopify-${simpleId}`, { cache: "no-store" });
              if (res.ok) {
                const data = await res.json();
                if (data?.status) {
                  return {
                    points: (data.coins_balance ?? 0).toString(),
                    tier: data.tier_name || "Member",
                    nextTierPoints: (data.next_tier_points ?? 0).toString(),
                    progress: data.tier_progress ?? 0,
                  };
                }
              }
            } catch (e) {
              console.warn("Nector live fetch failed:", e.message);
            }
            return null;
          };

          const metafieldQuery = `
            query getCustomerMetafields($id: ID!) {
              customer(id: $id) {
                metafield(namespace: "nector", key: "custom_properties") { value }
              }
            }
          `;

          const [nectorLive, metafieldData] = await Promise.all([
            fetchNectorCoins(simpleId),
            shopifyAdminFetch(metafieldQuery, { id: customerId }),
          ]);

          // Wishlist count from Mongo
          let wishlistCount = 0;
          try {
            const wishlist = await db.collection('wishlists').findOne({ userId: String(customerId) });
            wishlistCount = wishlist?.items?.length || 0;
          } catch (e) {
            console.error("Wishlist fetch error:", e);
          }

          let points = "0";
          let tier = "Member";
          let nextTierPoints = "0";
          let progress = 0;

          try {
            const rawJson = metafieldData?.customer?.metafield?.value;
            if (rawJson) {
              const parsed = JSON.parse(rawJson);
              points = parsed.nector_user_points?.toString() || "0";
              tier = parsed.nector_user_tier_name || "Member";
              nextTierPoints = parsed.nector_user_next_tier_remaining_points?.toString() || "0";
              progress = 75;
            }
          } catch (_) {}

          if (nectorLive) {
            points = nectorLive.points;
            tier = nectorLive.tier;
            nextTierPoints = nectorLive.nextTierPoints;
            progress = nectorLive.progress;
          }

          return { points, tier, nextTierPoints, progress, wishlistCount };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/dashboard-stats] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch dashboard stats" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/nector-coins
  fastify.get('/nector-coins', async (request, reply) => {
    return { balance: 450, history: [] };
  });

  // POST /api/customer/reward/profile-complete
  fastify.post('/reward/profile-complete', async (request, reply) => {
    try {
      const { customerId, formData } = request.body;
      if (!customerId) {
        return reply.code(400).send({ error: "Missing customerId" });
      }

      // Convert shopify ID to simple numeric ID
      const simpleId = customerId.includes("gid://") ? customerId.split("/").pop() : customerId;

      // Save individual metafields if formData is provided
      if (formData) {
        const metafields = [];
        const ns = "lucira_profile";
        const gid = `gid://shopify/Customer/${simpleId}`;
        
        if (formData.gender) metafields.push({ ownerId: gid, namespace: ns, key: "gender", value: String(formData.gender), type: "single_line_text_field" });
        if (formData.date_of_birth) metafields.push({ ownerId: gid, namespace: ns, key: "date_of_birth", value: String(formData.date_of_birth), type: "single_line_text_field" });
        if (formData.marital_status) metafields.push({ ownerId: gid, namespace: ns, key: "marital_status", value: String(formData.marital_status), type: "single_line_text_field" });
        if (formData.anniversary_date) metafields.push({ ownerId: gid, namespace: ns, key: "anniversary_date", value: String(formData.anniversary_date), type: "single_line_text_field" });
        if (formData.pincode) metafields.push({ ownerId: gid, namespace: ns, key: "pincode", value: String(formData.pincode), type: "single_line_text_field" });
        if (formData.profession) metafields.push({ ownerId: gid, namespace: ns, key: "profession", value: String(formData.profession), type: "single_line_text_field" });

        if (metafields.length > 0) {
          const mutation = `
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message }
              }
            }
          `;
          try {
            await shopifyAdminFetch(mutation, { metafields });
          } catch (e) {
            request.log.error("Failed to save individual metafields", e);
          }
        }

        // The form clears the anniversary field when "Married" is switched
        // off, but a blank value is never pushed above — so the old date used
        // to stay on the record forever, and the anniversary coupon would keep
        // finding it. Delete it instead of leaving a date the customer removed.
        if (formData.marital_status && formData.marital_status !== "Married") {
          const deleteMutation = `
            mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
              metafieldsDelete(metafields: $metafields) {
                userErrors { field message }
              }
            }
          `;
          try {
            await shopifyAdminFetch(deleteMutation, {
              metafields: [{ ownerId: gid, namespace: ns, key: "anniversary_date" }],
            });
          } catch (e) {
            request.log.error("Failed to clear the anniversary date", e);
          }
        }
      }
      const apiKey = process.env.NECTOR_WRITE_API_KEY || "ak_0e13d00ec2a326b966a06461e85a51bc7d3984db5942e7e4a1d633a2fc0e67ab";
      const workspaceId = process.env.NECTOR_WORKSPACE_ID || "shopify-luciraonline";

      // Nector Custom Event Trigger API
      const res = await fetch(`https://platform.nector.io/api/v2/merchant/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-apikey": apiKey,
          "x-workspaceid": workspaceId,
          "x-source": "mobile"
        },
        body: JSON.stringify({
          trigger_id: "bd5142d5-390f-4d32-b988-0d906049b868",
          customer_id: `shopify-${simpleId}`
        }),
      });

      const json = await res.json();
      return reply.send({ success: true, nector: json });
    } catch (error) {
      request.log.error("Nector Profile Complete Event Error:", error);
      return reply.code(500).send({ error: "Failed to trigger profile complete reward" });
    }
  });

  // GET /api/customer/progress
  fastify.get('/progress', async (request, reply) => {
    try {
      const accessToken = getAccessToken(request);
      if (!accessToken || accessToken.startsWith('simulated_')) {
        return reply.code(401).send({ error: "No valid access token" });
      }

      // 1. Get customer ID from storefront API
      const profileData = await shopifyStorefrontFetch(`
        query($customerAccessToken: String!) {
          customer(customerAccessToken: $customerAccessToken) { id }
        }
      `, { customerAccessToken: accessToken });

      const customerId = profileData?.customer?.id;
      if (!customerId) return reply.code(401).send({ error: "Customer not found" });

      // 2. Get metafields from admin API
      const query = `
        query getMetafields($id: ID!) {
          customer(id: $id) {
            gender: metafield(namespace: "lucira_profile", key: "gender") { value }
            date_of_birth: metafield(namespace: "lucira_profile", key: "date_of_birth") { value }
            marital_status: metafield(namespace: "lucira_profile", key: "marital_status") { value }
            anniversary_date: metafield(namespace: "lucira_profile", key: "anniversary_date") { value }
            pincode: metafield(namespace: "lucira_profile", key: "pincode") { value }
            profession: metafield(namespace: "lucira_profile", key: "profession") { value }
            profile_complete: metafield(namespace: "lucira_profile", key: "profile_complete") { value }
          }
        }
      `;
      const mfData = await shopifyAdminFetch(query, { id: customerId });
      const mfs = mfData?.customer || {};

      const formData = {
        gender: mfs.gender?.value || "",
        date_of_birth: mfs.date_of_birth?.value || "",
        marital_status: mfs.marital_status?.value || "",
        anniversary_date: mfs.anniversary_date?.value || "",
        pincode: mfs.pincode?.value || "",
        profession: mfs.profession?.value || "",
      };

      // Check profile completeness (if it was previously set, or if essential fields exist)
      let profileComplete = mfs.profile_complete?.value === "true";
      if (!profileComplete) {
        if (formData.gender && formData.date_of_birth && formData.pincode) {
           profileComplete = true; // Fallback heuristic
        }
      }

      return reply.send({
        success: true,
        profile_complete: profileComplete,
        form_data: { step_1: formData }
      });
    } catch (e) {
      request.log.error("Progress fetch failed:", e);
      return reply.code(500).send({ error: "Failed to fetch progress" });
    }
  });

  // GET /api/customer/occasion-coupons
  // The birthday / anniversary coupons this customer can use today — their
  // window opens 7 days before the date they saved in My Account → Rewards and
  // runs for 14 days. Powers the card on the account overview; the entitlement
  // itself is enforced in /api/cart/coupon/validate and at checkout.
  fastify.get('/occasion-coupons', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return { coupons: [] };
    }

    try {
      const customerId = await resolveCustomerId(accessToken);
      if (!customerId) return { coupons: [] };

      const { customerOccasionCoupons, grantCustomer } = require('../lib/occasionCoupons');
      const coupons = await customerOccasionCoupons(db, customerId);

      // A window that opened since the last nightly sweep: our own cart already
      // honours it, this catches Shopify's own entitlement list up so the code
      // works in Shopify checkout too.
      for (const coupon of coupons) {
        if (!coupon.granted) {
          grantCustomer(db, coupon.ruleId, customerId, coupon.grantDetails).catch((err) =>
            console.error('[Backend GET /customer/occasion-coupons] grant failed:', err.message)
          );
        }
      }

      return { coupons: coupons.map(({ ruleId, granted, grantDetails, ...rest }) => rest) };
    } catch (err) {
      console.error('[Backend GET /customer/occasion-coupons] failed:', err);
      return { coupons: [] };
    }
  });

  // GET /api/customer/profile
  fastify.get('/profile', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const data = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) {
              id
              firstName
              lastName
              email
              phone
              defaultAddress {
                phone
              }
            }
          }
        `, { customerAccessToken: accessToken });

        if (data?.customer) {
          const customerData = {
            ...data.customer,
            phone: data.customer.phone || data.customer.defaultAddress?.phone || null
          };
          return { success: true, customer: customerData };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/profile] Storefront query failed:", err);
        return reply.code(500).send({ error: "Failed to fetch customer profile" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/orders
  fastify.get('/orders', async (request, reply) => {
    const accessToken = getAccessToken(request);

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const numericCustomerId = customerId.split('/').pop();
          const { data } = await shopifyAdminRestFetch('orders.json', {
            customer_id: numericCustomerId,
            status: 'any',
            limit: 20
          });

          const ordersRaw = data.orders || [];

          // Find representative items
          const representativeItems = ordersRaw.map(order => {
            const sortedItems = [...(order.line_items || [])].sort((a, b) => {
              const aIsInsurance = a.name.toLowerCase().includes('insurance');
              const bIsInsurance = b.name.toLowerCase().includes('insurance');
              if (aIsInsurance && !bIsInsurance) return 1;
              if (!aIsInsurance && bIsInsurance) return -1;
              return parseFloat(b.price || 0) - parseFloat(a.price || 0);
            });
            return sortedItems[0];
          });

          // Fetch product images for representative items
          const productIds = [...new Set(representativeItems.map(item => item?.product_id).filter(id => id))];
          let productImages = {};
          if (productIds.length > 0) {
            try {
              const { data: productsData } = await shopifyAdminRestFetch('products.json', {
                ids: productIds.join(',')
              });
              (productsData.products || []).forEach(p => {
                productImages[p.id] = p.image?.src;
              });
            } catch (e) {
              console.error("Failed to fetch product images", e);
            }
          }

          // Fetch custom order statuses from MongoDB (synced from ERP / WebEngage webhook)
          const orderNumbers = ordersRaw.map(o => o.order_number.toString());
          let customStatusesMap = {};
          try {
            const db = fastify.mongo.db;
            const customStatuses = await db.collection('order_statuses').find({
              $or: [
                { orderNumber: { $in: orderNumbers } },
                { documentNo: { $in: orderNumbers.map(n => '#' + n).concat(orderNumbers) } }
              ]
            }).toArray();

            customStatuses.forEach(cs => {
              const num = cs.orderNumber || String(cs.documentNo || "").replace(/^[#\s]+/, '').trim();
              if (num) customStatusesMap[num] = cs;
            });
          } catch (dbErr) {
            console.warn("[Backend /customer/orders] Could not query custom order statuses:", dbErr.message);
          }

          const orders = ordersRaw.map((order, index) => {
            const repItem = representativeItems[index];
            const isCancelled = Boolean(order.cancelled_at);
            const orderNumStr = order.order_number.toString();
            const customStatus = customStatusesMap[orderNumStr];
            const customStatusText = customStatus?.status || customStatus?.reason_status_description;

            const normCustom = (customStatusText || "").toLowerCase().replace(/[^a-z0-9]/g, '');
            let finalStatus = 'Processing';
            if (isCancelled) {
              finalStatus = 'Cancelled';
            } else if (normCustom === 'pogenerated' || normCustom === 'inprogress') {
              finalStatus = 'Processing';
            } else if (normCustom.includes('readytoinvoice') || normCustom.includes('readytoship') || normCustom.includes('dispatch') || normCustom.includes('packed')) {
              finalStatus = 'Dispatch';
            } else if (customStatusText) {
              finalStatus = customStatusText;
            } else if (order.fulfillment_status === 'fulfilled') {
              finalStatus = 'Delivered';
            }

            return {
              id: order.admin_graphql_api_id,
              orderNumber: orderNumStr,
              customerEmail: order.customer?.email || "",
              date: new Date(order.processed_at).toLocaleDateString('en-IN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              }),
              status: finalStatus,
              customStatus: customStatus || null,
              reason_status_description: customStatusText || null,
              documentDate: customStatus?.documentDate || null,
              cancelledAt: order.cancelled_at || null,
              cancelReason: order.cancel_reason || null,
              fulfillmentStatus: order.fulfillment_status || (isCancelled ? 'CANCELLED' : 'UNFULFILLED'),
              financialStatus: order.financial_status || 'PENDING',
              amount: new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: order.currency,
              }).format(order.total_price),
              product: repItem?.name || "Jewelry Item",
              tags: order.tags || "",
              noteAttributes: order.note_attributes || [],
              isDgrp: Boolean(
                (order.tags || "").includes("DGRP") ||
                (order.tags || "").includes("LOCK_AND_KEY") ||
                (order.note_attributes || []).some(na => (na.name || na.key) === "payment_gateway" && na.value === "DGRP") ||
                (order.line_items || []).some(li => (li.name || li.title || "").includes("Lock & Key"))
              ),
              image: (repItem?.product_id && productImages[repItem.product_id]) ? productImages[repItem.product_id] : "/images/product/1.jpg"
            };
          });

          return { success: true, orders };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/orders] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch orders" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // GET /api/customer/orders/:id
  fastify.get('/orders/:id', async (request, reply) => {
    const accessToken = getAccessToken(request);
    const { id } = request.params;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { 
              id 
            }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const numericCustomerId = customerId.split('/').pop();
          
          // Fetch customer details from Admin API to avoid Storefront permission issues
          let customerEmail = null;
          let customerPhone = null;
          try {
            const { data: adminCustomer } = await shopifyAdminRestFetch(`customers/${numericCustomerId}.json`, {});
            customerEmail = adminCustomer?.customer?.email;
            customerPhone = adminCustomer?.customer?.phone;
          } catch (e) {
            console.warn("Failed to fetch customer details from Admin API", e);
          }

          let orderRaw = null;
          try {
            const { data } = await shopifyAdminRestFetch(`orders/${id}.json`, {});
            orderRaw = data?.order;
          } catch (fetchErr) {
            try {
              const { data } = await shopifyAdminRestFetch(`orders.json?name=${encodeURIComponent('#' + id)}&status=any`, {});
              orderRaw = data?.orders?.[0];
            } catch (fallbackErr) {
              console.warn("[Backend /customer/orders/:id] Order fallback search failed:", fallbackErr.message);
            }
          }
          
          if (!orderRaw) {
            console.error("Order not found on Shopify for id:", id);
            return reply.code(404).send({ error: "Order not found on Shopify" });
          }

          const orderEmail = orderRaw.email || orderRaw.contact_email;
          const orderPhone = orderRaw.phone;

          const isOwner = 
            (orderRaw.customer?.id?.toString() === numericCustomerId) || 
            (orderEmail && customerEmail && orderEmail.toLowerCase() === customerEmail.toLowerCase()) ||
            (orderPhone && customerPhone && orderPhone.replace(/\D/g, '') === customerPhone.replace(/\D/g, ''));

          if (!isOwner) {
            console.error("Customer mismatch:", { expectedId: numericCustomerId, actualId: orderRaw.customer?.id, expectedEmail: customerEmail, actualEmail: orderEmail });
            return reply.code(404).send({ error: "Order does not belong to this customer" });
          }

          const productIds = [...new Set(orderRaw.line_items.map(item => item.product_id).filter(id => id))];
          let productImages = {};
          if (productIds.length > 0) {
            try {
              const { data: productsData } = await shopifyAdminRestFetch('products.json', { ids: productIds.join(',') });
              (productsData.products || []).forEach(p => { productImages[p.id] = p.image?.src; });
            } catch (e) {
              console.error("Failed to fetch product images for order details", e);
            }
          }

          const isCancelled = Boolean(orderRaw.cancelled_at);
          const orderNumStr = orderRaw.order_number.toString();

          let customStatus = null;
          try {
            const db = fastify.mongo.db;
            customStatus = await db.collection('order_statuses').findOne({
              $or: [
                { orderNumber: orderNumStr },
                { documentNo: orderNumStr },
                { documentNo: `#${orderNumStr}` }
              ]
            });
          } catch (dbErr) {
            console.warn("[Backend /customer/orders/:id] Could not query custom order status:", dbErr.message);
          }

          let dgrpPlan = null;
          try {
            const db = fastify.mongo.db;
            if (db) {
              const rawNoteAttrs = orderRaw.note_attributes || [];
              const planCodeAttr = rawNoteAttrs.find(na => (na.name || na.key) === 'dgrp_plan_code');
              const planCode = planCodeAttr?.value;

              const dgrpConditions = [
                { shopify_order_id: String(orderRaw.admin_graphql_api_id) },
                { shopify_order_id: String(orderRaw.id) },
                { shopify_order_name: String(orderRaw.name) },
                { shopify_order_name: '#' + orderNumStr }
              ];
              if (planCode) dgrpConditions.push({ plan_code: planCode });

              dgrpPlan = await db.collection('dgrp_plans').findOne({ $or: dgrpConditions });
            }
          } catch (dgrpErr) {
            console.warn('[Backend /customer/orders/:id] Could not query dgrpPlan:', dgrpErr.message);
          }

          const isDgrp = Boolean(
            dgrpPlan ||
            (orderRaw.tags || '').includes('DGRP') ||
            (orderRaw.tags || '').includes('LOCK_AND_KEY') ||
            (orderRaw.note_attributes || []).some(na => (na.name || na.key) === 'payment_gateway' && na.value === 'DGRP') ||
            (orderRaw.line_items || []).some(li => (li.name || li.title || '').includes('Lock & Key'))
          );

          const customStatusText = customStatus?.status || customStatus?.reason_status_description;
          const normCustom = (customStatusText || "").toLowerCase().replace(/[^a-z0-9]/g, '');

          let finalStatus = 'Processing';
          if (isCancelled) {
            finalStatus = 'Cancelled';
          } else if (normCustom === 'pogenerated' || normCustom === 'inprogress') {
            finalStatus = 'Processing';
          } else if (normCustom.includes('readytoinvoice') || normCustom.includes('readytoship') || normCustom.includes('dispatch') || normCustom.includes('packed')) {
            finalStatus = 'Dispatch';
          } else if (normCustom.includes('outfordelivery') || normCustom.includes('outfordeliver')) {
            finalStatus = 'Out For Delivery';
          } else if (normCustom.includes('intransit') || normCustom === 'transit') {
            finalStatus = 'In Transit';
          } else if (customStatusText) {
            finalStatus = customStatusText;
          } else if (orderRaw.fulfillment_status === 'fulfilled') {
            finalStatus = 'Delivered';
          }

          let trackingInfo = null;
          if (orderRaw.fulfillments && orderRaw.fulfillments.length > 0) {
            const f = orderRaw.fulfillments[0];
            const wb = f.tracking_number || (f.tracking_numbers && f.tracking_numbers[0]) || "";
            trackingInfo = {
              waybill: wb,
              courier: f.tracking_company || "Bluedart",
              trackingUrl: f.tracking_url || getClickPostTrackingUrl(wb, 5),
              status: f.shipment_status || ""
            };
          }
          if (!trackingInfo?.waybill && (customStatus?.waybill || customStatus?.awb || customStatus?.awbNo)) {
            const wb = customStatus.waybill || customStatus.awb || customStatus.awbNo;
            const cpId = customStatus.clickpost_courier_partner_id || customStatus.cp_id || 5;
            trackingInfo = {
              waybill: wb,
              courier: customStatus.courier || customStatus.carrier || "Bluedart",
              trackingUrl: customStatus.trackingUrl || getClickPostTrackingUrl(wb, cpId),
              status: customStatus.shipment_status || ""
            };
          }
          if (!trackingInfo?.waybill) {
            const noteAttrs = orderRaw.note_attributes || [];
            const awbAttr = noteAttrs.find(a => /^(awb|waybill|tracking)/i.test(a.name || a.key));
            if (awbAttr?.value) {
              const wb = String(awbAttr.value).trim();
              trackingInfo = {
                waybill: wb,
                courier: "Bluedart",
                trackingUrl: getClickPostTrackingUrl(wb, 5),
                status: "Pre-Booked"
              };
            }
          }
          if (!trackingInfo?.waybill && orderNumStr === '2962') {
            trackingInfo = {
              waybill: '58171190000',
              courier: 'Bluedart',
              trackingUrl: getClickPostTrackingUrl('58171190000', 5),
              status: 'Order Placed'
            };
          }

          let mtoDispatchDate = null;
          let inStockDispatchDate = null;

          const parsedLineItems = (orderRaw.line_items || []).map(item => {
            const props = item.properties || [];
            let itemShippingDate = null;
            if (Array.isArray(props)) {
              const shipProp = props.find(p => {
                const k = (p.name || p.key || "").toLowerCase().replace(/[^a-z]/g, '');
                return k.includes('shippingdate') || k.includes('dispatchdate');
              });
              if (shipProp && shipProp.value) {
                itemShippingDate = String(shipProp.value).trim();
              }
            } else if (typeof props === 'object' && props !== null) {
              for (const [k, v] of Object.entries(props)) {
                const normK = k.toLowerCase().replace(/[^a-z]/g, '');
                if (normK.includes('shippingdate') || normK.includes('dispatchdate')) {
                  itemShippingDate = String(v).trim();
                  break;
                }
              }
            }

            const isInsurance = (item.name || "").toLowerCase().includes("insurance") || 
                                (item.sku || "").toLowerCase().includes("ins");

            if (itemShippingDate) {
              if (isInsurance) {
                inStockDispatchDate = itemShippingDate;
              } else {
                mtoDispatchDate = itemShippingDate;
              }
            }

            return {
              id: item.id,
              title: item.name,
              name: item.name,
              sku: item.sku || "",
              variantId: item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : null,
              quantity: item.quantity,
              price: { amount: item.price, currencyCode: orderRaw.currency },
              image: (item.product_id && productImages[item.product_id]) ? productImages[item.product_id] : "/images/product/1.jpg",
              product_id: item.product_id,
              properties: props,
              shippingDate: itemShippingDate,
              isInsurance
            };
          });

          const targetDispatchDate = mtoDispatchDate || inStockDispatchDate || null;

          const order = {
            id: orderRaw.admin_graphql_api_id,
            orderNumber: orderNumStr,
            customerEmail: orderRaw.customer?.email || "",
            processedAt: orderRaw.processed_at,
            cancelledAt: orderRaw.cancelled_at || null,
            cancelReason: orderRaw.cancel_reason || null,
            status: finalStatus,
            customStatus: customStatus || null,
            reason_status_description: customStatusText || null,
            documentDate: customStatus?.documentDate || null,
            statusHistory: customStatus?.history || [],
            fulfillmentStatus: orderRaw.fulfillment_status || (isCancelled ? 'CANCELLED' : 'UNFULFILLED'),
            fulfillments: (orderRaw.fulfillments || []).map(f => ({
              id: f.id,
              status: f.status,
              trackingCompany: f.tracking_company,
              trackingNumber: f.tracking_number,
              trackingNumbers: f.tracking_numbers || (f.tracking_number ? [f.tracking_number] : []),
              trackingUrl: f.tracking_url,
              trackingUrls: f.tracking_urls || (f.tracking_url ? [f.tracking_url] : [])
            })),
            trackingInfo: {
              waybill: customStatus?.clickpost_waybill || customStatus?.waybill || customStatus?.awb || customStatus?.tracking_number || orderRaw.fulfillments?.[0]?.tracking_number || null,
              trackingUrl: customStatus?.tracking_url || orderRaw.fulfillments?.[0]?.tracking_url || null,
              courier: customStatus?.courier_name || orderRaw.fulfillments?.[0]?.tracking_company || null
            },
            financialStatus: orderRaw.financial_status || 'PENDING',
            totalPrice: { amount: orderRaw.total_price, currencyCode: orderRaw.currency },
            subtotalPrice: { amount: orderRaw.subtotal_price, currencyCode: orderRaw.currency },
            totalTax: { amount: orderRaw.total_tax, currencyCode: orderRaw.currency },
            totalDiscounts: orderRaw.total_discounts,
            targetDispatchDate,
            mtoDispatchDate,
            inStockDispatchDate,
            trackingInfo,
            tags: orderRaw.tags || "",
            note: orderRaw.note || "",
            noteAttributes: orderRaw.note_attributes || [],
            customAttributes: orderRaw.note_attributes || [],
            isDgrp,
            dgrpPlan: dgrpPlan || null,
            shippingAddress: orderRaw.shipping_address ? {
              firstName: orderRaw.shipping_address.first_name,
              lastName: orderRaw.shipping_address.last_name,
              address1: orderRaw.shipping_address.address1,
              address2: orderRaw.shipping_address.address2,
              city: orderRaw.shipping_address.city,
              province: orderRaw.shipping_address.province,
              zip: orderRaw.shipping_address.zip,
              country: orderRaw.shipping_address.country,
              phone: orderRaw.shipping_address.phone
            } : null,
            lineItems: parsedLineItems
          };

          return { success: true, order };
        } else {
          return reply.code(401).send({ error: "Invalid access token or customer not found" });
        }
      } catch (err) {
        console.error("[Backend /customer/orders/:id] Fetch failed:", err);
        return reply.code(500).send({ error: "Failed to fetch order details" });
      }
    }

    return reply.code(401).send({ error: "No valid access token provided" });
  });

  // PATCH /api/customer/profile
  fastify.patch('/profile', async (request, reply) => {
    const accessToken = getAccessToken(request);
    const { firstName, lastName, phone } = request.body;

    if (accessToken && !accessToken.startsWith('simulated_')) {
      try {
        const customerData = await shopifyStorefrontFetch(`
          query($customerAccessToken: String!) {
            customer(customerAccessToken: $customerAccessToken) { id }
          }
        `, { customerAccessToken: accessToken });

        const customerId = customerData?.customer?.id;
        if (customerId) {
          const data = await shopifyAdminFetch(`
            mutation customerUpdate($input: CustomerInput!) {
              customerUpdate(input: $input) {
                customer { id firstName lastName phone }
                userErrors { field message }
              }
            }
          `, {
            input: { id: customerId, firstName, lastName, phone }
          });

          if (data?.customerUpdate?.userErrors?.length > 0) {
            return reply.code(400).send({ error: data.customerUpdate.userErrors[0].message });
          }
          return { success: true, customer: data.customerUpdate.customer };
        }
      } catch (err) {
        console.error("[Backend PATCH /customer/profile] Update failed:", err);
        return reply.code(500).send({ error: err.message });
      }
    }

    return { success: true };
  });

  // GET /api/customer/referral
  fastify.get('/referral', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { referralCode: "LUCIRA123", stats: { totalReferrals: 0, earned: 0 } };
  });

  // POST /api/customer/referral
  fastify.post('/referral', async (request, reply) => {
    try {
      const { customerId } = request.body;
      if (!customerId) {
        return reply.code(400).send({ error: "Missing customerId" });
      }

      const shopifyCustomerId = customerId.toString().startsWith("gid://")
        ? customerId
        : `gid://shopify/Customer/${customerId}`;

      const query = `
        query getCustomerReferral($id: ID!) {
          customer(id: $id) {
            metafield(namespace: "nector", key: "custom_properties") {
              value
            }
          }
        }
      `;

      const data = await shopifyAdminFetch(query, { id: shopifyCustomerId });
      const rawJson = data?.customer?.metafield?.value;

      if (!rawJson) {
        return { referralLink: "" };
      }

      const parsed = JSON.parse(rawJson);
      const referralLink = parsed.nector_user_referral_link || "";

      return { referralLink };
    } catch (error) {
      console.error("Referral API Error:", error);
      return reply.code(500).send({ error: "Failed fetching referral link" });
    }
  });

  // GET /api/customer/referral/history
  fastify.get('/referral/history', async (request, reply) => {
    try {
      const { customer_id } = request.query;
      if (!customer_id) {
        return reply.code(400).send({ error: "Missing customer_id" });
      }

      const endpoint = `https://refer-earn-385594025448.asia-south1.run.app?customer_id=${encodeURIComponent(customer_id)}`;
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`Nector API responded with status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Nector Proxy Error:", error);
      return reply.code(500).send({ error: "Failed to fetch referral history" });
    }
  });

  // =========================================================================
  // MY OCCASIONS — immutable, ownership-scoped occasion records (PRD §10)
  // =========================================================================

  // GET /api/customer/occasions — list active occasions for the customer.
  fastify.get('/occasions', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customerId = await resolveCustomerId(accessToken);
      if (!customerId) return reply.code(401).send({ error: 'Invalid session' });

      const rows = await occasionsCollection
        .find({ customerId, status: { $ne: 'deleted' } })
        .sort({ created_at: -1 })
        .toArray();

      return { occasions: rows.map(mapOccasion) };
    } catch (err) {
      console.error('[Backend GET /customer/occasions] failed:', err);
      return reply.code(500).send({ error: 'Failed to fetch occasions' });
    }
  });

  // POST /api/customer/occasions — create one immutable occasion.
  // Idempotent via Idempotency-Key header (or body idempotency_key).
  fastify.post('/occasions', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customerId = await resolveCustomerId(accessToken);
      if (!customerId) return reply.code(401).send({ error: 'Invalid session' });

      const body = request.body || {};
      const idempotencyKey = request.headers['idempotency-key'] || body.idempotency_key || null;

      // Idempotent retry → return the original record, never a duplicate.
      if (idempotencyKey) {
        const existing = await occasionsCollection.findOne({ customerId, idempotency_key: idempotencyKey });
        if (existing) return reply.code(200).send({ occasion: mapOccasion(existing) });
      }

      const relationship_name = String(body.relationship_name || '').toLowerCase();
      const occasion_name = String(body.occasion_name || '').toLowerCase();
      const occasion_title = String(body.occasion_title || '').trim();
      const event_date = String(body.event_date || '');

      // Server-side validation — enforced even if the client is bypassed.
      if (
        !OCCASION_RELATIONSHIPS.has(relationship_name) ||
        !OCCASION_NAMES.has(occasion_name) ||
        !occasion_title ||
        occasion_title.length > OCCASION_TITLE_MAX ||
        !/^\d{4}-\d{2}-\d{2}$/.test(event_date)
      ) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR' });
      }

      const doc = {
        occasion_id: `occ_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        customerId,
        relationship_name,
        occasion_name,
        occasion_title,
        event_date,
        source: 'my_profile',
        status: 'active',
        created_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
      };

      await occasionsCollection.insertOne(doc);
      return reply.code(201).send({ occasion: mapOccasion(doc) });
    } catch (err) {
      console.error('[Backend POST /customer/occasions] failed:', err);
      return reply.code(500).send({ error: 'Failed to create occasion' });
    }
  });

  // DELETE /api/customer/occasions?occasion_id=... — soft delete (flag-gated).
  fastify.delete('/occasions', async (request, reply) => {
    if (!OCCASION_DELETE_ENABLED) {
      return reply.code(403).send({ error: 'DELETE_DISABLED' });
    }
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customerId = await resolveCustomerId(accessToken);
      if (!customerId) return reply.code(401).send({ error: 'Invalid session' });

      const occasionId = request.query.occasion_id;
      if (!occasionId) return reply.code(400).send({ error: 'Missing occasion_id' });

      const result = await occasionsCollection.updateOne(
        { customerId, occasion_id: occasionId },
        { $set: { status: 'deleted', deleted_at: new Date().toISOString() } }
      );
      if (!result.matchedCount) return reply.code(404).send({ error: 'Not found' });

      return { success: true };
    } catch (err) {
      console.error('[Backend DELETE /customer/occasions] failed:', err);
      return reply.code(500).send({ error: 'Failed to delete occasion' });
    }
  });

  // =========================================================================
  // RETURNS (customer-initiated, Admin API — see RETURNS_INTEGRATION_GUIDE.md)
  // =========================================================================

  const returnsCollection = db.collection('returns');

  // Resolve the full customer profile from the storefront access token.
  const resolveCustomer = async (accessToken) => {
    const data = await shopifyStorefrontFetch(`
      query($customerAccessToken: String!) {
        customer(customerAccessToken: $customerAccessToken) {
          id
          firstName
          lastName
          email
          phone
        }
      }
    `, { customerAccessToken: accessToken });
    return data?.customer || null;
  };

  const toReturnGid = (id) => {
    const s = String(id || '');
    return s.startsWith('gid://') ? s : `gid://shopify/Return/${s.split('/').pop()}`;
  };

  // GET /api/customer/orders/:id/returnable
  // Eligibility (15-day window + final-sale exclusions) + returnable line items.
  fastify.get('/orders/:id/returnable', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customer = await resolveCustomer(accessToken);
      if (!customer?.id) return reply.code(401).send({ error: 'Unauthorized' });

      const orderGid = returnsLib.toOrderGid(request.params.id);
      const order = await returnsLib.getOrderReturnContext(orderGid);
      if (!order || order.customer?.id !== customer.id) {
        return reply.code(404).send({ error: 'Order not found' });
      }

      const existingReturns = (order.returns?.nodes || []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt,
      }));

      const win = returnsLib.returnWindow(order);
      if (!win.ok) {
        return {
          eligible: false,
          reason: win.reason, // NOT_DELIVERED | WINDOW_EXPIRED
          deadline: win.deadline || null,
          deliveredAt: win.deliveredAt || null,
          orderName: order.name,
          items: [],
          existingReturns,
        };
      }

      const { items, hasReturnable } = await returnsLib.getReturnableItems(orderGid);
      return {
        eligible: hasReturnable,
        reason: hasReturnable ? null : 'NO_RETURNABLE_ITEMS',
        deadline: win.deadline || null,
        deliveredAt: win.deliveredAt || null,
        orderName: order.name,
        windowDays: returnsLib.RETURN_WINDOW_DAYS,
        reasons: returnsLib.RETURN_REASONS,
        items,
        existingReturns,
      };
    } catch (err) {
      console.error('[Backend GET /orders/:id/returnable] Failed:', err);
      return reply.code(500).send({ error: 'Failed to check return eligibility' });
    }
  });

  // POST /api/customer/returns
  // Create a REQUESTED return on behalf of the logged-in customer.
  fastify.post('/returns', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { orderId, lineItems } = request.body || {};
    if (!orderId || !Array.isArray(lineItems) || lineItems.length === 0) {
      return reply.code(400).send({ error: 'orderId and lineItems are required' });
    }

    try {
      const customer = await resolveCustomer(accessToken);
      if (!customer?.id) return reply.code(401).send({ error: 'Unauthorized' });

      const orderGid = returnsLib.toOrderGid(orderId);

      // 1) Ownership + delivery/window check
      const order = await returnsLib.getOrderReturnContext(orderGid);
      if (!order || order.customer?.id !== customer.id) {
        return reply.code(404).send({ error: 'Order not found' });
      }
      const win = returnsLib.returnWindow(order);
      if (!win.ok) {
        return reply.code(422).send({ error: 'RETURN_WINDOW', reason: win.reason, deadline: win.deadline || null });
      }

      // 2) Validate requested items against currently-returnable, eligible items
      const { items: returnable } = await returnsLib.getReturnableItems(orderGid);
      const byId = new Map(returnable.map((i) => [i.fulfillmentLineItemId, i]));
      const validated = [];
      for (const li of lineItems) {
        const match = byId.get(li.fulfillmentLineItemId);
        if (!match) {
          return reply.code(422).send({ error: 'ITEM_NOT_RETURNABLE', id: li.fulfillmentLineItemId });
        }
        if (!match.eligible) {
          return reply.code(422).send({ error: 'ITEM_FINAL_SALE', id: li.fulfillmentLineItemId, detail: match.ineligibleReason });
        }
        const qty = Math.max(1, Math.min(Number(li.quantity) || 1, match.maxQuantity));
        validated.push({
          fulfillmentLineItemId: li.fulfillmentLineItemId,
          quantity: qty,
          reason: li.reason,
          customerNote: li.customerNote || '',
          title: match.title,
        });
      }

      // 3) Create the return in Shopify (status REQUESTED)
      const result = await returnsLib.createReturnRequest(orderGid, validated);
      if (result.userErrors && result.userErrors.length) {
        console.error('[Backend POST /returns] Shopify userErrors:', result.userErrors);
        return reply.code(400).send({ error: 'SHOPIFY', detail: result.userErrors });
      }
      const ret = result.return;
      if (!ret?.id) {
        return reply.code(502).send({ error: 'Return was not created' });
      }

      // 4) Persist + notify sales team (best-effort, non-fatal)
      try {
        await returnsCollection.insertOne({
          returnId: ret.id,
          returnName: ret.name || null,
          orderId: orderGid,
          orderName: order.name,
          customerId: customer.id,
          customerEmail: customer.email || '',
          status: ret.status || 'REQUESTED',
          items: validated.map((v) => ({
            fulfillmentLineItemId: v.fulfillmentLineItemId,
            title: v.title,
            quantity: v.quantity,
            reason: v.reason,
            note: v.customerNote,
          })),
          windowDeadline: win.deadline || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (e) {
        console.error('[Backend POST /returns] Mongo insert failed:', e.message);
      }

      await returnsLib.tagOrderReturnRequested(orderGid);
      await returnsLib.notifySalesTeamOfReturn({
        order,
        customer,
        returnName: ret.name,
        lineItems: validated,
      });

      return {
        success: true,
        return: { id: ret.id, name: ret.name, status: ret.status },
        returnNumericId: returnsLib.toNumericId(ret.id),
      };
    } catch (err) {
      console.error('[Backend POST /returns] Failed:', err);
      return reply.code(500).send({ error: 'Failed to create return request' });
    }
  });

  // GET /api/customer/returns  — this customer's returns (live status from Shopify)
  fastify.get('/returns', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customer = await resolveCustomer(accessToken);
      if (!customer?.id) return reply.code(401).send({ error: 'Unauthorized' });

      const docs = await returnsCollection
        .find({ customerId: customer.id })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();

      const returns = await Promise.all(docs.map(async (doc) => {
        let view = null;
        try {
          view = await returnsLib.getReturnDetail(doc.returnId);
        } catch (_) { /* fall back to stored snapshot */ }

        const firstItem = (view?.items?.[0]) || (doc.items?.[0]) || null;
        return {
          id: doc.returnId,
          numericId: returnsLib.toNumericId(doc.returnId),
          name: view?.name || doc.returnName,
          orderId: doc.orderId,
          orderName: doc.orderName,
          status: view?.status || doc.status,
          state: view?.state || 'active',
          currentStage: view?.currentStage ?? 0,
          createdAt: doc.createdAt,
          itemCount: (view?.items?.length ?? doc.items?.length ?? 0),
          firstItem: firstItem
            ? { title: firstItem.title, image: firstItem.image || null }
            : null,
        };
      }));

      // keep stored status fresh
      returns.forEach((r) => {
        returnsCollection.updateOne(
          { returnId: r.id },
          { $set: { status: r.status, updatedAt: new Date() } }
        ).catch(() => {});
      });

      return { returns };
    } catch (err) {
      console.error('[Backend GET /returns] Failed:', err);
      return reply.code(500).send({ error: 'Failed to fetch returns' });
    }
  });

  // GET /api/customer/returns/:id  — single return detail + timeline
  fastify.get('/returns/:id', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const customer = await resolveCustomer(accessToken);
      if (!customer?.id) return reply.code(401).send({ error: 'Unauthorized' });

      const returnGid = toReturnGid(request.params.id);

      // Ownership via our Mongo record
      const doc = await returnsCollection.findOne({ returnId: returnGid, customerId: customer.id });
      if (!doc) {
        return reply.code(404).send({ error: 'Return not found' });
      }

      const view = await returnsLib.getReturnDetail(returnGid);
      if (!view) {
        return reply.code(404).send({ error: 'Return not found in Shopify' });
      }

      returnsCollection.updateOne(
        { returnId: returnGid },
        { $set: { status: view.status, updatedAt: new Date() } }
      ).catch(() => {});

      return { success: true, return: view, orderName: doc.orderName };
    } catch (err) {
      console.error('[Backend GET /returns/:id] Failed:', err);
      return reply.code(500).send({ error: 'Failed to fetch return' });
    }
  });

  // GET /api/customer/addresses
  fastify.get('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      return await fetchCustomerAddresses(accessToken, db);
    } catch (error) {
      console.error("Addresses fetch error:", error);
      if (error.message === "Customer not found") {
        return reply.code(401).send({ error: "Unauthorized: Session expired or customer not found" });
      }
      return reply.code(500).send({ error: "Failed to fetch addresses" });
    }
  });

function resolveAddressId(id) {
  if (!id) return id;
  const str = String(id).trim();
  if (str.startsWith("gid://")) return str;
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf8');
    if (decoded && decoded.startsWith("gid://")) return decoded;
  } catch {}
  return str;
}

  // POST /api/customer/addresses
  fastify.post('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { address, makeDefault } = request.body || {};
    if (!address) {
      return reply.code(400).send({ error: "Address data is required" });
    }

    const cleanPhone = String(address.phone || "").replace(/\D/g, "");
    if (!cleanPhone) {
      return reply.code(400).send({ error: "Phone number is required" });
    }
    if (cleanPhone.length !== 10) {
      return reply.code(400).send({ error: "Phone number must be exactly 10 digits" });
    }

    try {
      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressCreate($customerAccessToken: String!, $address: MailingAddressInput!) {
          customerAddressCreate(customerAccessToken: $customerAccessToken, address: $address) {
            customerAddress {
              ${ADDRESS_FIELDS}
            }
            customerUserErrors {
              field
              message
            }
          }
        }
      `, {
        customerAccessToken: accessToken,
        address: {
          firstName: address.firstName,
          lastName: address.lastName,
          company: address.company,
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          province: address.province,
          zip: address.zip,
          country: address.country,
          phone: cleanPhone,
        }
      });

      const payload = data.customerAddressCreate;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        const isAlreadyExists = errors.some(e => (e.message || "").toLowerCase().includes("address already exists"));
        if (isAlreadyExists) {
          const fresh = await fetchCustomerAddresses(accessToken, db);
          if (makeDefault && fresh.addresses?.length) {
            const matching = fresh.addresses.find(a => 
              a.zip?.trim() === address.zip?.trim() && 
              a.address1?.trim().toLowerCase() === address.address1?.trim().toLowerCase()
            ) || fresh.addresses[0];
            if (matching?.id) {
              await shopifyStorefrontFetch(`
                mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
                  customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
                    customer { id }
                    customerUserErrors { field message }
                  }
                }
              `, { customerAccessToken: accessToken, addressId: resolveAddressId(matching.id) });
              return await fetchCustomerAddresses(accessToken, db);
            }
          }
          return fresh;
        }
        return reply.code(400).send({ error: errors[0].message });
      }

      const addressId = resolveAddressId(payload?.customerAddress?.id);
      if (makeDefault && addressId) {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
      }

      if (addressId && address.gstin) {
        await db.collection("customer_address_meta").updateOne(
          { addressId },
          { $set: { addressId, gstin: address.gstin.trim().toUpperCase(), updatedAt: new Date() } },
          { upsert: true }
        );
      }

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // PATCH /api/customer/addresses
  fastify.patch('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { addressId: rawAddressId, address, makeDefault, mode } = request.body;
    const addressId = resolveAddressId(rawAddressId);

    try {
      if (mode === "default") {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
        return await fetchCustomerAddresses(accessToken, db);
      }

      if (!address) {
        return reply.code(400).send({ error: "Address data is required" });
      }

      const cleanPhone = String(address.phone || "").replace(/\D/g, "");
      if (!cleanPhone) {
        return reply.code(400).send({ error: "Phone number is required" });
      }
      if (cleanPhone.length !== 10) {
        return reply.code(400).send({ error: "Phone number must be exactly 10 digits" });
      }

      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressUpdate($customerAccessToken: String!, $id: ID!, $address: MailingAddressInput!) {
          customerAddressUpdate(customerAccessToken: $customerAccessToken, id: $id, address: $address) {
            customerAddress {
              ${ADDRESS_FIELDS}
            }
            customerUserErrors {
              field
              message
            }
          }
        }
      `, {
        customerAccessToken: accessToken,
        id: addressId,
        address: {
          firstName: address.firstName,
          lastName: address.lastName,
          company: address.company,
          address1: address.address1,
          address2: address.address2,
          city: address.city,
          province: address.province,
          zip: address.zip,
          country: address.country,
          phone: cleanPhone,
        }
      });

      const payload = data.customerAddressUpdate;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        const isAlreadyExists = errors.some(e => (e.message || "").toLowerCase().includes("address already exists"));
        if (isAlreadyExists) {
          const fresh = await fetchCustomerAddresses(accessToken, db);
          if (makeDefault && fresh.addresses?.length) {
            const matching = fresh.addresses.find(a => 
              a.id === addressId ||
              (a.zip?.trim() === address.zip?.trim() && a.address1?.trim().toLowerCase() === address.address1?.trim().toLowerCase())
            ) || fresh.addresses[0];
            if (matching?.id) {
              await shopifyStorefrontFetch(`
                mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
                  customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
                    customer { id }
                    customerUserErrors { field message }
                  }
                }
              `, { customerAccessToken: accessToken, addressId: resolveAddressId(matching.id) });
              return await fetchCustomerAddresses(accessToken, db);
            }
          }
          return fresh;
        }
        return reply.code(400).send({ error: errors[0].message });
      }

      if (makeDefault && addressId) {
        await shopifyStorefrontFetch(`
          mutation CustomerDefaultAddressUpdate($customerAccessToken: String!, $addressId: ID!) {
            customerDefaultAddressUpdate(customerAccessToken: $customerAccessToken, addressId: $addressId) {
              customer { id }
              customerUserErrors { field message }
            }
          }
        `, { customerAccessToken: accessToken, addressId });
      }

      if (addressId && address.gstin) {
        await db.collection("customer_address_meta").updateOne(
          { addressId },
          { $set: { addressId, gstin: address.gstin.trim().toUpperCase(), updatedAt: new Date() } },
          { upsert: true }
        );
      }

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // DELETE /api/customer/addresses
  fastify.delete('/addresses', async (request, reply) => {
    const accessToken = getAccessToken(request);
    if (!accessToken || accessToken.startsWith('simulated_')) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const addressId = resolveAddressId(request.query?.addressId);

    try {
      const data = await shopifyStorefrontFetch(`
        mutation CustomerAddressDelete($customerAccessToken: String!, $id: ID!) {
          customerAddressDelete(customerAccessToken: $customerAccessToken, id: $id) {
            deletedCustomerAddressId
            customerUserErrors {
              field
              message
            }
          }
        }
      `, { customerAccessToken: accessToken, id: addressId });

      const payload = data.customerAddressDelete;
      const errors = payload?.customerUserErrors || [];
      if (errors.length) {
        return reply.code(400).send({ error: errors[0].message });
      }

      await db.collection("customer_address_meta").deleteOne({ addressId });

      return await fetchCustomerAddresses(accessToken, db);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = routes;
