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

    // GET /api/tracks -> list all objects in the bucket
    if (path === "/api/tracks") {
      const listed = await env.MUSIC_BUCKET.list();
      const tracks = listed.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
      }));
      return new Response(JSON.stringify(tracks), {
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
