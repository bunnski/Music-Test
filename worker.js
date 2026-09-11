// worker.js
// Deploy this as a Cloudflare Worker bound to your R2 bucket.
// Set AUTH_TOKEN as a secret: wrangler secret put AUTH_TOKEN

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // simple CORS so your static site can call this worker from any host
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // check auth token, either header (for /api/tracks) or query param (for streaming, since <audio> can't send headers)
    const token = request.headers.get("X-Auth-Token") || url.searchParams.get("token");
    if (token !== env.AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    // POST /api/upload?key=<object key> -> write the request body as a file at that key (creates folders implicitly)
    if (path === "/api/upload" && request.method === "POST") {
      const key = url.searchParams.get("key");
      if (!key) {
        return new Response("Missing key", { status: 400, headers: corsHeaders });
      }
      const body = await request.arrayBuffer();
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      await env.MUSIC_BUCKET.put(key, body, { httpMetadata: { contentType } });
      return new Response(JSON.stringify({ success: true, key }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/order -> return saved order map: { "<parentPath>": ["name1","name2",...] }, "" = top level
    if (path === "/api/order" && request.method === "GET") {
      const object = await env.MUSIC_BUCKET.get("_order.json");
      const order = object ? JSON.parse(await object.text()) : {};
      return new Response(JSON.stringify(order), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /api/order -> body: { parentPath: string, order: [names] }. Merges into the saved order map.
    if (path === "/api/order" && request.method === "POST") {
      const { parentPath, order } = await request.json();
      const object = await env.MUSIC_BUCKET.get("_order.json");
      const fullOrder = object ? JSON.parse(await object.text()) : {};
      fullOrder[parentPath] = order;
      await env.MUSIC_BUCKET.put("_order.json", JSON.stringify(fullOrder));
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/soundtracks -> tree of { categories: [{name, soundtracks:[{name,cover,path}]}], soundtracks: [{name,cover,path}] }
    // A file 2 levels deep (Folder/track.mp3) is a top-level soundtrack.
    // A file 3 levels deep (Category/Folder/track.mp3) is a soundtrack nested inside a category.
    if (path === "/api/soundtracks") {
      const listed = await env.MUSIC_BUCKET.list();
      const directMap = {};   // folder name -> {name, cover, path}
      const categoryMap = {}; // category name -> { folder name -> {name, cover, path} }

      for (const obj of listed.objects) {
        const parts = obj.key.split("/");
        const filename = parts[parts.length - 1];
        const isCover = /\.(jpg|jpeg|png|webp)$/i.test(filename);

        if (parts.length === 2) {
          const folder = parts[0];
          if (!directMap[folder]) directMap[folder] = { name: folder, cover: null, path: folder };
          if (isCover) directMap[folder].cover = obj.key;
        } else if (parts.length === 3) {
          const category = parts[0];
          const folder = parts[1];
          if (!categoryMap[category]) categoryMap[category] = {};
          if (!categoryMap[category][folder]) {
            categoryMap[category][folder] = { name: folder, cover: null, path: `${category}/${folder}` };
          }
          if (isCover) categoryMap[category][folder].cover = obj.key;
        }
        // files deeper than 3 levels, or at the root (parts.length === 1, e.g. _order.json), are ignored
      }

      const tree = {
        soundtracks: Object.values(directMap),
        categories: Object.entries(categoryMap).map(([name, folders]) => ({
          name,
          soundtracks: Object.values(folders),
        })),
      };

      return new Response(JSON.stringify(tree), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/soundtracks/<folder> -> list files inside one folder, split into cover image + tracks
    if (path.startsWith("/api/soundtracks/")) {
      const folder = decodeURIComponent(path.replace("/api/soundtracks/", ""));
      const listed = await env.MUSIC_BUCKET.list({ prefix: folder + "/" });

      let cover = null;
      const tracks = [];

      for (const obj of listed.objects) {
        const filename = obj.key.split("/").pop();
        if (/\.(jpg|jpeg|png|webp)$/i.test(filename)) {
          cover = obj.key;
        } else if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(filename)) {
          tracks.push({ key: obj.key, name: filename, size: obj.size });
        }
      }

      return new Response(JSON.stringify({ cover, tracks }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/stream/<key> -> stream the actual file
    if (path.startsWith("/api/stream/")) {
      const key = decodeURIComponent(path.replace("/api/stream/", ""));
      const object = await env.MUSIC_BUCKET.get(key);

      if (!object) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }

      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");

      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
