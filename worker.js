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

    // GET /api/soundtracks -> list top-level folders (each = one soundtrack) with their cover image
    if (path === "/api/soundtracks") {
      const listed = await env.MUSIC_BUCKET.list();
      const folderMap = {};

      for (const obj of listed.objects) {
        const parts = obj.key.split("/");
        if (parts.length < 2) continue; // skip files not inside a folder
        const folder = parts[0];
        const filename = parts[parts.length - 1];

        if (!folderMap[folder]) folderMap[folder] = { name: folder, cover: null };
        if (/\.(jpg|jpeg|png|webp)$/i.test(filename)) {
          folderMap[folder].cover = obj.key;
        }
      }

      return new Response(JSON.stringify(Object.values(folderMap)), {
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
