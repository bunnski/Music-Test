// worker.js
// Deploy this as a Cloudflare Worker bound to your R2 bucket.
// Set AUTH_TOKEN as a secret: wrangler secret put AUTH_TOKEN
//
// STORAGE MODEL:
// - Actual files live permanently at media/<soundtrackId>/<filename> and never move.
// - A single "_library.json" file holds all organization: soundtracks, folders, order, pins.
// - Folders are real nestable objects { id, name, parentId }. Soundtracks each have a parentId pointing
//   at a folder (or null for top level). Moving something into a different folder, renaming, reordering,
//   and pinning are all just edits to _library.json - no file copying, instant.
// - Playlists no longer exist as a separate type. A soundtrack's tracks are either OWNED { key, name }
//   (file lives at media/<thisId>/...) or REFERENCED { key, soundtrackId } (file lives in another
//   soundtrack, name is looked up from that owner). Old playlists are migrated into soundtracks
//   automatically the first time the library is loaded (a backup is saved first).

const LIBRARY_KEY = "_library.json";
const PROGRESS_KEY = "_progress.json";
const PROGRESS_MAX = 100; // episodes of saved listening progress kept (oldest dropped first)

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "item";
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

// Soundtracks with sides on (sides: true) keep every "A" track (side missing or "A") before every "B" track.
function partitionSides(tracks) {
  return [...tracks.filter((t) => t.side !== "B"), ...tracks.filter((t) => t.side === "B")];
}

async function getLibrary(env) {
  const object = await env.MUSIC_BUCKET.get(LIBRARY_KEY);
  if (!object) {
    return { soundtracks: {}, folders: {}, order: {} };
  }
  const raw = await object.text();
  const library = JSON.parse(raw);
  // backfill fields for libraries created before they existed
  if (!library.folders) library.folders = {};
  if (!library.order) library.order = {};
  // one-time migration: playlists become soundtracks whose tracks are all references
  if (library.playlists) {
    const old = Object.values(library.playlists);
    if (old.length) {
      await env.MUSIC_BUCKET.put("_library.pre-merge-backup.json", raw);
      for (const pl of old) {
        library.soundtracks[pl.id] = {
          id: pl.id,
          name: pl.name,
          parentId: pl.parentId || null,
          cover: pl.cover || null,
          description: pl.description,
          tracks: (pl.tracks || []).map((t) => ({ key: t.key, soundtrackId: t.soundtrackId })),
        };
      }
    }
    delete library.playlists;
    await saveLibrary(env, library);
  }
  return library;
}

async function saveLibrary(env, library) {
  await env.MUSIC_BUCKET.put(LIBRARY_KEY, JSON.stringify(library));
}

function isCoverFile(filename) {
  return /\.(jpg|jpeg|png|webp)$/i.test(filename);
}

// true if moving `folderId` to become a child of `newParentId` would make a folder its own ancestor
function wouldCreateCycle(library, folderId, newParentId) {
  let cur = newParentId;
  while (cur) {
    if (cur === folderId) return true;
    const f = library.folders[cur];
    cur = f ? f.parentId : null;
  }
  return false;
}

// every folder id nested under (and including) rootId
function getDescendantFolderIds(library, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of Object.values(library.folders)) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        changed = true;
      }
    }
  }
  return ids;
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

    // ---- one-time migration utilities ----

    // POST /api/migrate-folders -> ONE-TIME USE: converts the old flat "category" string on soundtracks
    // into real folder objects. Safe to call multiple times.
    if (path === "/api/migrate-folders" && request.method === "POST") {
      const library = await getLibrary(env);
      const nameToFolderId = {};

      if (library.categories) {
        for (const name of library.categories) {
          const id = generateId(name);
          library.folders[id] = { id, name, parentId: null };
          nameToFolderId[name] = id;
        }
      }

      for (const s of Object.values(library.soundtracks)) {
        if (s.category) {
          s.parentId = nameToFolderId[s.category] || null;
          delete s.category;
        } else if (s.parentId === undefined) {
          s.parentId = null;
        }
      }

      // migrate order map keys from category names to the new folder ids
      const newOrder = {};
      for (const key of Object.keys(library.order)) {
        const newKey = nameToFolderId[key] || key;
        newOrder[newKey] = library.order[key].map((k) => nameToFolderId[k] || k);
      }
      library.order = newOrder;

      delete library.categories;
      await saveLibrary(env, library);
      return json({ success: true, foldersCreated: Object.keys(nameToFolderId).length });
    }

    // POST /api/upgrade-ids -> ONE-TIME USE: finds soundtracks still using the old raw-UUID folder format
    // and moves their files to a new slugified folder, updating all references. Safe to call multiple times.
    if (path === "/api/upgrade-ids" && request.method === "POST") {
      const library = await getLibrary(env);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let upgradedCount = 0;

      for (const oldId of Object.keys(library.soundtracks)) {
        if (!uuidPattern.test(oldId)) continue;

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

        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].map((k) => (k === oldId ? newId : k));
        }

        upgradedCount++;
      }

      await saveLibrary(env, library);
      return json({ success: true, upgraded: upgradedCount });
    }

    // POST /api/migrate-legacy -> ONE-TIME USE: scans old-style folders (Folder/track.mp3 or Category/Folder/track.mp3)
    // and imports them into the manifest system, moving each file once. Safe to call multiple times.
    if (path === "/api/migrate-legacy" && request.method === "POST") {
      const library = await getLibrary(env);
      const listed = await env.MUSIC_BUCKET.list();
      const legacyFolders = {};

      for (const obj of listed.objects) {
        if (obj.key === LIBRARY_KEY) continue;
        if (obj.key.startsWith("media/")) continue;
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
      if (!library.categories) library.categories = []; // temp holding, migrate-folders will convert these later
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

    // ---- library ----

    // GET /api/library -> the entire manifest: soundtracks, folders, order/pins
    if (path === "/api/library" && request.method === "GET") {
      return json(await getLibrary(env));
    }

    // ---- folders ----

    // POST /api/create-folder { name, parentId } -> creates a folder, optionally nested inside another folder
    if (path === "/api/create-folder" && request.method === "POST") {
      const { name, parentId } = await request.json();
      if (!name) return new Response("Missing name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const id = generateId(name);
      library.folders[id] = { id, name, parentId: parentId || null };
      await saveLibrary(env, library);
      return json({ success: true, id });
    }

    // POST /api/rename-folder { id, name }
    if (path === "/api/rename-folder" && request.method === "POST") {
      const { id, name } = await request.json();
      if (!id || !name) return new Response("Missing id or name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.folders[id]) return new Response("Unknown folder", { status: 404, headers: corsHeaders });
      library.folders[id].name = name;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- soundtracks ----

    // POST /api/create-soundtrack { name, parentId } -> creates an empty soundtrack entry, returns its id
    if (path === "/api/create-soundtrack" && request.method === "POST") {
      const { name, parentId } = await request.json();
      if (!name) return new Response("Missing name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const id = generateId(name);
      library.soundtracks[id] = { id, name, parentId: parentId || null, cover: null, tracks: [] };
      await saveLibrary(env, library);
      return json({ success: true, id });
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

    // POST /api/update-metadata { id, name, artist, year, description, sides }
    // merges any provided fields onto the soundtrack.
    if (path === "/api/update-metadata" && request.method === "POST") {
      const { id, name, artist, year, description, sides } = await request.json();
      if (!id) return new Response("Missing id", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const target = library.soundtracks[id];
      if (!target) return new Response("Unknown id", { status: 404, headers: corsHeaders });

      if (name !== undefined && name !== "") target.name = name;
      if (description !== undefined) target.description = description;
      if (artist !== undefined) target.artist = artist;
      if (year !== undefined) target.year = year;
      if (sides !== undefined) {
        target.sides = !!sides;
        if (target.sides) target.tracks = partitionSides(target.tracks || []);
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- podcasts ----

    // GET /api/podcast-feed?url=<rss url> -> passes the feed XML through (browsers can't fetch feeds directly because of CORS).
    // Deliberately light: one fetch, edge-cached for 15 minutes, no parsing (the browser parses it). Audio never touches the Worker.
    if (path === "/api/podcast-feed" && request.method === "GET") {
      let u;
      try { u = new URL(url.searchParams.get("url")); } catch (e) {
        return new Response("Bad url", { status: 400, headers: corsHeaders });
      }
      const host = u.hostname.toLowerCase();
      const blocked =
        !/^https?:$/.test(u.protocol) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
        host.includes(":") || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
      if (blocked) return new Response("Url not allowed", { status: 400, headers: corsHeaders });

      let res;
      try {
        res = await fetch(u.toString(), {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MyMusic/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" },
          cf: { cacheTtl: 900, cacheEverything: true },
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        return new Response("Could not reach feed", { status: 502, headers: corsHeaders });
      }
      if (!res.ok) return new Response("Feed returned " + res.status, { status: 502, headers: corsHeaders });
      if (parseInt(res.headers.get("Content-Length") || "0", 10) > 8000000) {
        return new Response("Feed too large", { status: 413, headers: corsHeaders });
      }
      const text = await res.text();
      if (text.length > 8000000) return new Response("Feed too large", { status: 413, headers: corsHeaders });
      return new Response(text, { headers: { ...corsHeaders, "Content-Type": "text/xml; charset=utf-8" } });
    }

    // POST /api/add-podcast { name, feedUrl, cover, artist, description, parentId }
    // Stores a podcast as a soundtrack with a feedUrl and NO tracks - episodes are read from the feed by the browser each time.
    if (path === "/api/add-podcast" && request.method === "POST") {
      const { name, feedUrl, cover, artist, description, parentId } = await request.json();
      if (!name || !/^https?:\/\//i.test(feedUrl || "")) {
        return new Response("Missing name or feedUrl", { status: 400, headers: corsHeaders });
      }
      const library = await getLibrary(env);
      const existing = Object.values(library.soundtracks).find((s) => s.feedUrl === feedUrl);
      if (existing) return json({ success: true, id: existing.id, existing: true });
      const id = generateId(name);
      library.soundtracks[id] = {
        id, name, parentId: parentId || null,
        cover: /^https?:\/\//i.test(cover || "") ? cover : null,
        tracks: [], feedUrl, artist: artist || "", description: (description || "").slice(0, 1000),
      };
      await saveLibrary(env, library);
      return json({ success: true, id });
    }

    // ---- MusicBrainz (open music database, used to look up official track order) ----
    // GET /api/musicbrainz?search=<text>  or  /api/musicbrainz?release=<mbid>. Pass-through only, cached for a day.
    // MusicBrainz asks for an identifying User-Agent (browsers can't set one) and allows ~1 request/second.
    if (path === "/api/musicbrainz" && request.method === "GET") {
      const q = url.searchParams.get("search");
      const releaseId = url.searchParams.get("release");
      let target;
      if (releaseId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(releaseId)) {
        target = "https://musicbrainz.org/ws/2/release/" + releaseId + "?inc=recordings&fmt=json";
      } else if (q && q.length <= 200) {
        const clean = q.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, " ").replace(/\s+/g, " ").trim();
        target = "https://musicbrainz.org/ws/2/release/?query=" + encodeURIComponent(clean) + "&limit=25&fmt=json";
      } else {
        return new Response("Bad request", { status: 400, headers: corsHeaders });
      }
      try {
        const res = await fetch(target, {
          headers: { "User-Agent": "MyMusicPersonalApp/1.0 (personal use)", "Accept": "application/json" },
          cf: { cacheTtl: 86400, cacheEverything: true },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return new Response("MusicBrainz returned " + res.status, { status: 502, headers: corsHeaders });
        const text = await res.text();
        if (text.length > 2000000) return new Response("Too large", { status: 413, headers: corsHeaders });
        return new Response(text, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response("Could not reach MusicBrainz", { status: 502, headers: corsHeaders });
      }
    }

    // ---- podcast episode download (pass-through) ----
    // GET /api/podcast-audio?url=<episode audio url>. Streams the file straight through to the browser (nothing is stored or
    // buffered here), because podcast hosts usually block cross-site downloads. One request per episode, almost no CPU.
    if (path === "/api/podcast-audio" && request.method === "GET") {
      let u;
      try { u = new URL(url.searchParams.get("url")); } catch (e) {
        return new Response("Bad url", { status: 400, headers: corsHeaders });
      }
      const host = u.hostname.toLowerCase();
      const blocked =
        !/^https?:$/.test(u.protocol) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
        host.includes(":") || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
      if (blocked) return new Response("Url not allowed", { status: 400, headers: corsHeaders });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000); // only limits waiting for the host to start answering
      let res;
      try {
        res = await fetch(u.toString(), {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MyMusic/1.0)", "Accept": "audio/*,*/*" },
          redirect: "follow",
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        return new Response("Could not reach host", { status: 502, headers: corsHeaders });
      }
      clearTimeout(timer);
      if (!res.ok) return new Response("Host returned " + res.status, { status: 502, headers: corsHeaders });
      const len = parseInt(res.headers.get("Content-Length") || "0", 10);
      if (len > 400000000) return new Response("File too large", { status: 413, headers: corsHeaders });
      const headers = { ...corsHeaders, "Content-Type": res.headers.get("Content-Type") || "audio/mpeg" };
      if (len && !res.headers.get("Content-Encoding")) headers["Content-Length"] = String(len);
      return new Response(res.body, { headers });
    }

    // ---- podcast listening progress: Cloudflare is the source of truth ----
    // One small file holds progress for the most recent PROGRESS_MAX episodes; once it is full the least recently
    // listened ones are dropped first (FIFO). GET returns it. POST { updates: [{ key, pos, dur, done }] } overwrites
    // those episodes and stamps them with the SERVER clock, so devices with different clocks can never disagree.
    if (path === "/api/progress" && request.method === "GET") {
      const obj = await env.MUSIC_BUCKET.get(PROGRESS_KEY);
      return json(obj ? JSON.parse(await obj.text()) : { entries: {} });
    }
    if (path === "/api/progress" && request.method === "POST") {
      let body;
      try { body = JSON.parse(await request.text()); } catch (e) {
        return new Response("Bad JSON", { status: 400, headers: corsHeaders });
      }
      const updates = Array.isArray(body.updates) ? body.updates.slice(0, 50) : [];
      const obj = await env.MUSIC_BUCKET.get(PROGRESS_KEY);
      const data = obj ? JSON.parse(await obj.text()) : { entries: {} };
      if (!data.entries) data.entries = {};
      const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, 259200));
      const now = Date.now();
      updates.forEach((u, i) => {
        if (typeof u.key !== "string" || u.key.length > 600 || !/^https?:\/\//i.test(u.key)) return;
        data.entries[u.key] = { pos: clamp(u.pos), dur: clamp(u.dur), done: !!u.done, t: now + i };
      });
      const keys = Object.keys(data.entries).sort((a, b) => data.entries[a].t - data.entries[b].t);
      while (keys.length > PROGRESS_MAX) delete data.entries[keys.shift()]; // oldest first out
      await env.MUSIC_BUCKET.put(PROGRESS_KEY, JSON.stringify(data));
      return json({ success: true, entries: data.entries });
    }

    // ---- tracks ----

    // POST /api/rename-track { id, key, name }
    if (path === "/api/rename-track" && request.method === "POST") {
      const { id, key, name } = await request.json();
      if (!id || !key || !name) return new Response("Missing id, key, or name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      const entry = library.soundtracks[id].tracks.find((t) => t.key === key);
      if (!entry) return new Response("Unknown track", { status: 404, headers: corsHeaders });
      // a referenced track has no name of its own: rename it in the soundtrack that owns the file
      const owner = entry.soundtrackId && library.soundtracks[entry.soundtrackId];
      const track = owner ? owner.tracks.find((t) => t.key === key) : entry;
      if (!track) return new Response("Unknown track", { status: 404, headers: corsHeaders });
      track.name = name;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/delete-track { id, key }
    if (path === "/api/delete-track" && request.method === "POST") {
      const { id, key } = await request.json();
      if (!id || !key) return new Response("Missing id or key", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
      const entry = library.soundtracks[id].tracks.find((t) => t.key === key);
      if (entry && entry.soundtrackId && entry.soundtrackId !== id) {
        // just a reference: unlink it, the file stays with its owner
        library.soundtracks[id].tracks = library.soundtracks[id].tracks.filter((t) => t.key !== key);
      } else {
        // owned: delete the file and drop every reference to it
        await env.MUSIC_BUCKET.delete(key);
        for (const s of Object.values(library.soundtracks)) {
          s.tracks = (s.tracks || []).filter((t) => t.key !== key);
        }
      }
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/reorder-tracks { id, order, sides? } -> sides is an optional { trackKey: "A"|"B" } map
    if (path === "/api/reorder-tracks" && request.method === "POST") {
      const { id, order, sides } = await request.json();
      if (!id || !order) return new Response("Missing id or order", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });

      const byKey = {};
      library.soundtracks[id].tracks.forEach((t) => { byKey[t.key] = t; });
      const reordered = order.filter((k) => byKey[k]).map((k) => byKey[k]);
      const remaining = library.soundtracks[id].tracks.filter((t) => !order.includes(t.key));
      library.soundtracks[id].tracks = [...reordered, ...remaining];
      if (sides) {
        for (const t of library.soundtracks[id].tracks) {
          if (sides[t.key] === "A") delete t.side;
          else if (sides[t.key] === "B") t.side = "B";
        }
      }
      if (library.soundtracks[id].sides) {
        library.soundtracks[id].tracks = partitionSides(library.soundtracks[id].tracks);
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/upload?id=<id> -> body is the raw file; stored at media/<id>/<filename>.
    // Works for any soundtrack (tracks + cover).
    if (path === "/api/upload" && request.method === "POST") {
      const id = url.searchParams.get("id");
      const rawFilename = request.headers.get("X-Filename");
      let filename = rawFilename;
      try { filename = rawFilename ? decodeURIComponent(rawFilename) : rawFilename; } catch (e) {}
      if (!id || !filename) return new Response("Missing id or filename", { status: 400, headers: corsHeaders });

      const library = await getLibrary(env);
      const target = library.soundtracks[id];
      if (!target) return new Response("Unknown id", { status: 404, headers: corsHeaders });

      const key = `media/${id}/${filename}`;
      const body = await request.arrayBuffer();
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      await env.MUSIC_BUCKET.put(key, body, { httpMetadata: { contentType } });

      if (isCoverFile(filename)) {
        target.cover = key;
      } else {
        target.tracks.push({ key, name: filename });
      }
      await saveLibrary(env, library);
      return json({ success: true, key });
    }

    // ---- track references (put a track from one soundtrack into another without copying the file) ----

    // POST /api/add-reference { id, soundtrackId, key } -> adds track <key> (owned by soundtrackId) to soundtrack <id>
    if (path === "/api/add-reference" && request.method === "POST") {
      const { id, soundtrackId, key } = await request.json();
      if (!id || !soundtrackId || !key) return new Response("Missing fields", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const target = library.soundtracks[id];
      const source = library.soundtracks[soundtrackId];
      if (!target || !source) return new Response("Unknown soundtrack", { status: 404, headers: corsHeaders });
      // if the given source is itself a reference, follow it to the real owner
      const srcEntry = source.tracks.find((t) => t.key === key);
      if (!srcEntry) return new Response("Unknown track", { status: 404, headers: corsHeaders });
      const ownerId = srcEntry.soundtrackId && srcEntry.soundtrackId !== soundtrackId ? srcEntry.soundtrackId : soundtrackId;
      if (ownerId === id) return new Response("Track already belongs to this soundtrack", { status: 400, headers: corsHeaders });
      if (!target.tracks.some((t) => t.key === key)) target.tracks.push({ key, soundtrackId: ownerId });
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/remove-reference { id, key } -> unlinks a referenced track from soundtrack <id> (file untouched)
    if (path === "/api/remove-reference" && request.method === "POST") {
      const { id, key } = await request.json();
      if (!id || !key) return new Response("Missing fields", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const target = library.soundtracks[id];
      if (!target) return new Response("Unknown soundtrack", { status: 404, headers: corsHeaders });
      target.tracks = target.tracks.filter((t) => !(t.key === key && t.soundtrackId && t.soundtrackId !== id));
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- move / delete / order (shared across soundtracks and folders) ----

    // POST /api/move { itemType: "soundtrack"|"folder", id, parentId }
    // Just updates which folder something belongs to. Instant - no file copying, ever.
    if (path === "/api/move" && request.method === "POST") {
      const { itemType, id, parentId } = await request.json();
      const library = await getLibrary(env);
      const newParentId = parentId || null;

      if (itemType === "soundtrack") {
        if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
        library.soundtracks[id].parentId = newParentId;
      } else if (itemType === "folder") {
        if (!library.folders[id]) return new Response("Unknown folder", { status: 404, headers: corsHeaders });
        if (wouldCreateCycle(library, id, newParentId)) {
          return new Response("Can't move a folder into its own subfolder", { status: 400, headers: corsHeaders });
        }
        library.folders[id].parentId = newParentId;
      } else {
        return new Response("Invalid itemType", { status: 400, headers: corsHeaders });
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/delete { type: "soundtrack"|"folder", id }
    if (path === "/api/delete" && request.method === "POST") {
      const { type, id } = await request.json();
      const library = await getLibrary(env);

      async function deleteSoundtrack(sid) {
        const listed = await env.MUSIC_BUCKET.list({ prefix: `media/${sid}/` });
        for (const obj of listed.objects) {
          await env.MUSIC_BUCKET.delete(obj.key);
        }
        delete library.soundtracks[sid];
        // drop references to its tracks from every other soundtrack
        for (const other of Object.values(library.soundtracks)) {
          other.tracks = (other.tracks || []).filter((t) => t.soundtrackId !== sid);
        }
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => k !== sid);
        }
      }

      if (type === "soundtrack" && id) {
        await deleteSoundtrack(id);
      } else if (type === "folder" && id) {
        if (!library.folders[id]) return new Response("Unknown folder", { status: 404, headers: corsHeaders });
        const folderIds = getDescendantFolderIds(library, id); // includes id itself

        const soundtracksInside = Object.values(library.soundtracks).filter((s) => folderIds.has(s.parentId));
        for (const s of soundtracksInside) await deleteSoundtrack(s.id);

        for (const fid of folderIds) delete library.folders[fid];
        for (const fid of folderIds) delete library.order[fid];
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => !folderIds.has(k));
        }
      } else {
        return new Response("Invalid delete request", { status: 400, headers: corsHeaders });
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/order { parentPath, order } -> parentPath "" = top level, a folder id = within that folder,
    // "_pinned" = the pinned list. Just saves the given array of keys (ids) in that slot.
    if (path === "/api/order" && request.method === "POST") {
      const { parentPath, order } = await request.json();
      const library = await getLibrary(env);
      library.order[parentPath] = order;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- online metadata lookup ----

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
          body: `search "${query.replace(/"/g, '\\"')}"; fields name,cover.url,first_release_date,summary; limit 6;`,
        });
        const games = await igdbRes.json();
        if (!Array.isArray(games)) throw new Error(JSON.stringify(games));

        const results = games.map((g) => ({
          name: g.name,
          year: g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear().toString() : null,
          coverUrl: g.cover && g.cover.url ? "https:" + g.cover.url.replace("t_thumb", "t_cover_big") : null,
          description: g.summary || null,
        }));
        return json(results);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---- streaming ----

    // GET /api/stream/<key> -> stream the actual file
    if (path.startsWith("/api/stream/")) {
      const key = decodeURIComponent(path.replace("/api/stream/", ""));
      // honor Range requests so the browser can start playing and skip/seek without pulling the whole file
      const hasRange = request.headers.has("Range");
      let object;
      try {
        object = await env.MUSIC_BUCKET.get(key, hasRange ? { range: request.headers } : undefined);
      } catch (e) {
        return new Response("Range not satisfiable", { status: 416, headers: corsHeaders });
      }

      if (!object) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }

      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");

      let status = 200;
      if (hasRange && object.range) {
        const r = object.range;
        const offset = r.suffix !== undefined ? Math.max(0, object.size - r.suffix) : (r.offset || 0);
        const length = r.suffix !== undefined ? Math.min(r.suffix, object.size) : (r.length !== undefined ? r.length : object.size - offset);
        headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set("Content-Length", String(length));
        status = 206;
      }

      return new Response(object.body, { status, headers });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
