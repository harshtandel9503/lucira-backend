async function reviewsRoutes(fastify, options) {
  const getHeaders = () => {
    // Read from env, fallback to known keys if env is missing during transition
    const apiKey = process.env.NECTOR_API_KEY || "ak_cc146d9440ff8d3308d2158f23224df524bc6d1461195233af3140ee66740376";
    const workspaceId = process.env.NECTOR_WORKSPACE_ID || "shopify-luciraonline";
    return {
      "x-apikey": apiKey,
      "x-workspaceid": workspaceId,
      "x-source": "web"
    };
  };

  // GET /api/reviews
  fastify.get('/', async (request, reply) => {
    const { productId } = request.query;
    const id = productId ? String(productId).split("/").pop() : null;
    
    let json = {};
    
    // Try cachefront first
    const baseUrl = `https://cachefront.nector.io/api/v2/merchant/reviews`;
    let url = id 
      ? `${baseUrl}?page=1&limit=20&sort=image_count&sort_op=DESC&reference_product_id=${id}&reference_product_source=shopify`
      : `${baseUrl}?page=1&limit=200&sort=created_at&sort_op=DESC`;

    try {
      const res = await fetch(url, { headers: getHeaders() });
      if (res.ok) {
        json = await res.json();
      }
    } catch (err) {
      request.log.error("Nector Cachefront Fetch Error: " + err.message);
    }

    // Fallback to platform API if empty
    if (!json?.data?.items || json.data.items.length === 0) {
      const mainApiUrl = id 
        ? `https://platform.nector.io/api/v2/merchant/reviews?page=1&limit=20&reference_product_id=${id}&reference_product_source=shopify`
        : `https://platform.nector.io/api/v2/merchant/reviews?page=1&limit=100`;

      try {
        const res2 = await fetch(mainApiUrl, { headers: getHeaders() });
        if (res2.ok) {
          const json2 = await res2.json();
          if (json2?.data?.items?.length > 0) {
            json = json2;
          }
        }
      } catch (err) {
        request.log.error("Nector Platform Fetch Error: " + err.message);
      }
    }

    // Process exactly like the frontend used to
    const data = json?.data || {};
    const stats = data.stats || [];
    const count = data.count || (data.items?.length || 0);
    const items = data.items || [];

    let total = 0;
    let ratingCount = 0;

    if (Array.isArray(stats)) {
      stats.forEach(s => {
        total += Number(s.rating) * Number(s.count);
        ratingCount += Number(s.count);
      });
    }

    const reviews = {
      count,
      average: ratingCount ? Number((total / ratingCount).toFixed(1)) : (data.average_rating || 0),
      stats: Array.isArray(stats) ? stats.map(s => ({ rating: Number(s.rating), count: Number(s.count) })) : [],
      items: items.map(r => ({
        id: r._id || r.id,
        name: r.name || "Verified Buyer",
        rating: r.rating,
        text: r.description || r.body || "",
        date: r.posted_at || r.created_at,
        posted_at: r.posted_at,
        created_at: r.created_at,
        is_verified: r.is_verified || r.verified,
        images: r.uploads?.filter(u => u.type === "image" && u.link).map(u => u.link) || [],
        videos: r.uploads?.filter(u => u.type === "video" && u.link).map(u => u.link) || [],
        image_count: r.image_count || 0,
        video_count: r.video_count || 0,
        title: r.title || r.reference_product_name || "",
        uploads: r.uploads,
        reference_product_name: r.reference_product_name,
        reference_product_handle: r.reference_product_handle || r.reference_product_slug,
        reference_product_image: r.reference_product_image
      })),
      isProductView: !!id,
      usedFallback: false
    };

    reviews.list = reviews.items;
    
    return reply.send(reviews);
  });

  // POST /api/reviews
  fastify.post('/', async (request, reply) => {
    try {
      const res = await fetch(`https://platform.nector.io/api/v2/merchant/reviews`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHeaders()
        },
        body: JSON.stringify(request.body),
      });
      const json = await res.json();
      if (!res.ok) {
        const errorMsg = json?.data?.message || json?.meta?.message || json?.message || `HTTP ${res.status}`;
        throw new Error(errorMsg);
      }
      return reply.send(json);
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // POST /api/reviews/uploads
  fastify.post('/uploads', async (request, reply) => {
    try {
      const parts = request.parts();
      let fileBuffer;
      let filename;
      let reviewId;

      for await (const part of parts) {
        if (part.file) {
          fileBuffer = await part.toBuffer();
          filename = part.filename;
        } else {
          if (part.fieldname === 'parent_id') reviewId = part.value;
        }
      }

      if (!fileBuffer || !reviewId) {
        return reply.status(400).send({ error: "Missing file or parent_id" });
      }

      const form = new FormData();
      form.append('file', new Blob([fileBuffer]), filename);
      form.append('parent_type', 'reviews');
      form.append('parent_id', reviewId);

      const res = await fetch(`https://platform.nector.io/api/v2/merchant/uploads`, {
        method: 'POST',
        headers: getHeaders(), // Let native fetch auto-generate the Content-Type boundary
        body: form,
      });

      const json = await res.json();
      if (!res.ok) {
        const errorMsg = json?.data?.message || json?.meta?.message || json?.message || `Upload HTTP ${res.status}`;
        throw new Error(errorMsg);
      }
      return reply.send(json);
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: error.message });
    }
  });
}

module.exports = reviewsRoutes;
