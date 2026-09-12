// worker.js
// Deploy this as a Cloudflare Worker bound to your R2 bucket.
// Set AUTH_TOKEN as a secret: wrangler secret put AUTH_TOKEN
//
// STORAGE MODEL:
// - Actual files live permanently at media/<soundtrackId>/<filename> and never move.
// - A single "_library.json" file holds all organization: names, categories, order, pins.
// - Moving a soundtrack to a different category, renaming, reordering, and pinning are
//   all just edits to _library.json - no file copying, so they're instant regardless of file size.

const LIBRARY_KEY = "_library.json";

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "soundtrack";
}

function generateId(name) {
  const suffix = crypto.randomUUID().split("-")[0]; // short random hex chunk
  return `${slugify(name)}-${suffix}`;
}

async function getIgdbToken(env) {
  // reuse a cached token (stored in R2) until it's close to expiring, to avoid re-authenticating on every search
  const cached = await env.MUSIC_BUCKET.get("_igdb_token.json");
  if (cached) {
    const data = JSON.parse(await cached.text());
    if (data.expires_at > Date.now()) return data.access_token;
  }

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${env.IGDB_CLIENT_ID}&client_secret=${env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
  });
  const tokenData = await res.json();
  if (!tokenData.access_token) throw new Error("IGDB auth failed: " + JSON.stringify(tokenData));

  const expires_at = Date.now() + (tokenData.expires_in - 300) * 1000; // refresh 5 min early
  await env.MUSIC_BUCKET.put("_igdb_token.json", JSON.stringify({ access_token: tokenData.access_token, expires_at }));
  return tokenData.access_token;
}

async function getLibrary(env) {
  const object = await env.MUSIC_BUCKET.get(LIBRARY_KEY);
  if (!object) {
    return { soundtracks: {}, categories: [], order: {} };
  }
  return JSON.parse(await object.text());
}

async function saveLibrary(env, library) {
  await env.MUSIC_BUCKET.put(LIBRARY_KEY, JSON.stringify(library));
}

function isCoverFile(filename) {
  return /\.(jpg|jpeg|png|webp)$/i.test(filename);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Filename",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const token = request.headers.get("X-Auth-Token") || url.searchParams.get("token");
    if (token !== env.AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const json = (data, status) => new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

    // POST /api/upgrade-ids -> ONE-TIME USE: finds soundtracks still using the old raw-UUID folder format
    // and moves their files to a new slugified folder, updating all references. Safe to call multiple times.
    if (path === "/api/upgrade-ids" && request.method === "POST") {
      const library = await getLibrary(env);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let upgradedCount = 0;

      for (const oldId of Object.keys(library.soundtracks)) {
        if (!uuidPattern.test(oldId)) continue; // already slugified, skip

        const entry = library.soundtracks[oldId];
        const newId = generateId(entry.name);

        const listed = await env.MUSIC_BUCKET.list({ prefix: `media/${oldId}/` });
        for (const obj of listed.objects) {
          const filename = obj.key.split("/").pop();
          const newKey = `media/${newId}/${filename}`;
          const object = await env.MUSIC_BUCKET.get(obj.key);
          if (!object) continue;
          await env.MUSIC_BUCKET.put(newKey, object.body, { httpMetadata: object.httpMetadata });
          await env.MUSIC_BUCKET.delete(obj.key);

          if (entry.cover === obj.key) entry.cover = newKey;
          const track = entry.tracks.find((t) => t.key === obj.key);
          if (track) track.key = newKey;
        }

        entry.id = newId;
        library.soundtracks[newId] = entry;
        delete library.soundtracks[oldId];

        // update any order lists (top-level, within categories, and pinned) that reference the old id
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].map((k) => (k === oldId ? newId : k));
        }

        upgradedCount++;
      }

      await saveLibrary(env, library);
      return json({ success: true, upgraded: upgradedCount });
    }

    // POST /api/migrate-legacy -> ONE-TIME USE: scans old-style folders (Folder/track.mp3 or Category/Folder/track.mp3)
    // and imports them into the new manifest system, moving each file once. Safe to call multiple times - already
    // migrated soundtracks are skipped.
    if (path === "/api/migrate-legacy" && request.method === "POST") {
      const library = await getLibrary(env);
      const listed = await env.MUSIC_BUCKET.list();
      const legacyFolders = {}; // "folder" or "category/folder" -> [{key, filename}]

      for (const obj of listed.objects) {
        if (obj.key === LIBRARY_KEY) continue;
        if (obj.key.startsWith("media/")) continue; // already migrated
        const parts = obj.key.split("/");
        const filename = parts[parts.length - 1];
        if (filename === ".category" || filename === "_order.json") continue;

        if (parts.length === 2) {
          const folderKey = parts[0];
          if (!legacyFolders[folderKey]) legacyFolders[folderKey] = { category: null, name: parts[0], files: [] };
          legacyFolders[folderKey].files.push({ key: obj.key, filename });
        } else if (parts.length === 3) {
          const folderKey = `${parts[0]}/${parts[1]}`;
          if (!legacyFolders[folderKey]) legacyFolders[folderKey] = { category: parts[0], name: parts[1], files: [] };
          legacyFolders[folderKey].files.push({ key: obj.key, filename });
        }
      }

      let migratedCount = 0;
      for (const folderKey of Object.keys(legacyFolders)) {
        const { category, name, files } = legacyFolders[folderKey];
        const id = generateId(name);
        const entry = { id, name, category, cover: null, tracks: [] };

        for (const f of files) {
          const object = await env.MUSIC_BUCKET.get(f.key);
          if (!object) continue;
          const newKey = `media/${id}/${f.filename}`;
          await env.MUSIC_BUCKET.put(newKey, object.body, { httpMetadata: object.httpMetadata });
          await env.MUSIC_BUCKET.delete(f.key);

          if (isCoverFile(f.filename)) entry.cover = newKey;
          else entry.tracks.push({ key: newKey, name: f.filename });
        }

        library.soundtracks[id] = entry;
        if (category && !library.categories.includes(category)) library.categories.push(category);
        migratedCount++;
      }

      await saveLibrary(env, library);
      return json({ success: true, migrated: migratedCount });
    }

    // GET /api/library -> the entire manifest: soundtracks, categories, order/pins
    if (path === "/api/library" && request.method === "GET") {
      return json(await getLibrary(env));
    }

    // POST /api/rename-track { id, key, name } -> updates just the display name of one track
    if (path === "/api/rename-track" && request.method === "POST") {
      const { id, key, name } = await request.json();
      if (!id || !key || !name) return new Response("Missing id, key, or name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      const track = library.soundtracks[id].tracks.find((t) => t.key === key);
      if (!track) return new Response("Unknown track", { status: 404, headers: corsHeaders });
      track.name = name;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/delete-track { id, key } -> removes one track's file and its manifest entry
    if (path === "/api/delete-track" && request.method === "POST") {
      const { id, key } = await request.json();
      if (!id || !key) return new Response("Missing id or key", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      await env.MUSIC_BUCKET.delete(key);
      library.soundtracks[id].tracks = library.soundtracks[id].tracks.filter((t) => t.key !== key);
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/reorder-tracks { id, order } -> order is an array of track keys in the desired sequence
    if (path === "/api/reorder-tracks" && request.method === "POST") {
      const { id, order } = await request.json();
      if (!id || !order) return new Response("Missing id or order", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });

      const byKey = {};
      library.soundtracks[id].tracks.forEach((t) => { byKey[t.key] = t; });
      const reordered = order.filter((k) => byKey[k]).map((k) => byKey[k]);
      // include any tracks not mentioned in "order" (shouldn't normally happen) at the end
      const remaining = library.soundtracks[id].tracks.filter((t) => !order.includes(t.key));
      library.soundtracks[id].tracks = [...reordered, ...remaining];

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/igdb-search { query } -> searches IGDB for games, returning name/year/cover art
    if (path === "/api/igdb-search" && request.method === "POST") {
      const { query } = await request.json();
      if (!query) return new Response("Missing query", { status: 400, headers: corsHeaders });

      try {
        const token = await getIgdbToken(env);
        const igdbRes = await fetch("https://api.igdb.com/v4/games", {
          method: "POST",
          headers: {
            "Client-ID": env.IGDB_CLIENT_ID,
            "Authorization": `Bearer ${token}`,
            "Content-Type": "text/plain",
          },
          body: `search "${query.replace(/"/g, '\\"')}"; fields name,cover.url,first_release_date; limit 6;`,
        });
        const games = await igdbRes.json();
        if (!Array.isArray(games)) throw new Error(JSON.stringify(games));

        const results = games.map((g) => ({
          name: g.name,
          year: g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear().toString() : null,
          coverUrl: g.cover && g.cover.url ? "https:" + g.cover.url.replace("t_thumb", "t_cover_big") : null,
        }));
        return json(results);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // POST /api/update-metadata { id, artist, year, description } -> merges any provided fields onto the soundtrack
    if (path === "/api/update-metadata" && request.method === "POST") {
      const { id, artist, year, description } = await request.json();
      if (!id) return new Response("Missing id", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });

      if (artist !== undefined) library.soundtracks[id].artist = artist;
      if (year !== undefined) library.soundtracks[id].year = year;
      if (description !== undefined) library.soundtracks[id].description = description;

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/rename-soundtrack { id, name } -> just updates the display name, no file changes
    if (path === "/api/rename-soundtrack" && request.method === "POST") {
      const { id, name } = await request.json();
      if (!id || !name) return new Response("Missing id or name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      library.soundtracks[id].name = name;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/rename-category { oldName, newName } -> updates the category name everywhere it's referenced
    if (path === "/api/rename-category" && request.method === "POST") {
      const { oldName, newName } = await request.json();
      if (!oldName || !newName) return new Response("Missing oldName or newName", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.categories.includes(oldName)) return new Response("Unknown category", { status: 404, headers: corsHeaders });

      library.categories = library.categories.map((c) => (c === oldName ? newName : c));
      for (const s of Object.values(library.soundtracks)) {
        if (s.category === oldName) s.category = newName;
      }
      if (library.order[oldName]) {
        library.order[newName] = library.order[oldName];
        delete library.order[oldName];
      }
      for (const key of Object.keys(library.order)) {
        library.order[key] = library.order[key].map((k) => (k === oldName ? newName : k));
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/create-category { name }
    if (path === "/api/create-category" && request.method === "POST") {
      const { name } = await request.json();
      if (!name) return new Response("Missing name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.categories.includes(name)) library.categories.push(name);
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/create-soundtrack { name, category } -> creates an empty soundtrack entry, returns its id
    if (path === "/api/create-soundtrack" && request.method === "POST") {
      const { name, category } = await request.json();
      if (!name) return new Response("Missing name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const id = generateId(name);
      library.soundtracks[id] = { id, name, category: category || null, cover: null, tracks: [] };
      await saveLibrary(env, library);
      return json({ success: true, id });
    }

    // POST /api/upload?id=<soundtrackId> -> body is the raw file; stored at media/<id>/<filename>
    // filename comes via the X-Filename header (query params mangle special characters less predictably)
    if (path === "/api/upload" && request.method === "POST") {
      const id = url.searchParams.get("id");
      const filename = request.headers.get("X-Filename");
      if (!id || !filename) return new Response("Missing id or filename", { status: 400, headers: corsHeaders });

      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });

      const key = `media/${id}/${filename}`;
      const body = await request.arrayBuffer();
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      await env.MUSIC_BUCKET.put(key, body, { httpMetadata: { contentType } });

      if (isCoverFile(filename)) {
        library.soundtracks[id].cover = key;
      } else {
        library.soundtracks[id].tracks.push({ key, name: filename });
      }
      await saveLibrary(env, library);
      return json({ success: true, key });
    }

    // POST /api/move { id, category } -> just updates which category the soundtrack belongs to. Instant, no file copying.
    if (path === "/api/move" && request.method === "POST") {
      const { id, category } = await request.json();
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      library.soundtracks[id].category = category || null;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/delete { type: "soundtrack", id } or { type: "category", name }
    if (path === "/api/delete" && request.method === "POST") {
      const { type, id, name } = await request.json();
      const library = await getLibrary(env);

      async function deleteSoundtrack(sid) {
        const listed = await env.MUSIC_BUCKET.list({ prefix: `media/${sid}/` });
        for (const obj of listed.objects) {
          await env.MUSIC_BUCKET.delete(obj.key);
        }
        delete library.soundtracks[sid];
        // remove from any order lists / pins
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => k !== sid);
        }
      }

      if (type === "soundtrack" && id) {
        await deleteSoundtrack(id);
      } else if (type === "category" && name) {
        const idsInCategory = Object.values(library.soundtracks).filter((s) => s.category === name).map((s) => s.id);
        for (const sid of idsInCategory) {
          await deleteSoundtrack(sid);
        }
        library.categories = library.categories.filter((c) => c !== name);
        delete library.order[name];
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => k !== name);
        }
      } else {
        return new Response("Invalid delete request", { status: 400, headers: corsHeaders });
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/order { parentPath, order } -> parentPath "" = top level, a category name = within that category,
    // "_pinned" = the pinned list. Just saves the given array of keys (ids or category names) in that slot.
    if (path === "/api/order" && request.method === "POST") {
      const { parentPath, order } = await request.json();
      const library = await getLibrary(env);
      library.order[parentPath] = order;
      await saveLibrary(env, library);
      return json({ success: true });
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
