// worker.js
// Deploy this as a Cloudflare Worker bound to your R2 bucket.
// Set AUTH_TOKEN as a secret: wrangler secret put AUTH_TOKEN
//
// STORAGE MODEL:
// - Actual files live permanently at media/<soundtrackId>/<filename> and never move.
// - A single "_library.json" file holds all organization: soundtracks, playlists, folders, order, pins.
// - Folders are real nestable objects { id, name, parentId }. Soundtracks and playlists each have a
//   parentId pointing at a folder (or null for top level). Moving something into a different folder,
//   renaming, reordering, and pinning are all just edits to _library.json - no file copying, instant.

const LIBRARY_KEY = "_library.json";

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

async function getLibrary(env) {
  const object = await env.MUSIC_BUCKET.get(LIBRARY_KEY);
  if (!object) {
    return { soundtracks: {}, folders: {}, order: {}, playlists: {} };
  }
  const library = JSON.parse(await object.text());
  // backfill fields for libraries created before they existed
  if (!library.playlists) library.playlists = {};
  if (!library.folders) library.folders = {};
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
    // into real folder objects, and gives playlists a parentId field. Safe to call multiple times.
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

      for (const pl of Object.values(library.playlists)) {
        if (pl.parentId === undefined) pl.parentId = null;
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

    // GET /api/library -> the entire manifest: soundtracks, playlists, folders, order/pins
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

    // POST /api/update-metadata { itemType: "soundtrack"|"playlist", id, name, artist, year, description }
    // merges any provided fields onto the item. itemType defaults to "soundtrack" for backward compatibility.
    if (path === "/api/update-metadata" && request.method === "POST") {
      const { itemType, id, name, artist, year, description } = await request.json();
      if (!id) return new Response("Missing id", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const target = itemType === "playlist" ? library.playlists[id] : library.soundtracks[id];
      if (!target) return new Response("Unknown id", { status: 404, headers: corsHeaders });

      if (name !== undefined && name !== "") target.name = name;
      if (description !== undefined) target.description = description;
      if (itemType !== "playlist") {
        if (artist !== undefined) target.artist = artist;
        if (year !== undefined) target.year = year;
      }

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- tracks ----

    // POST /api/rename-track { id, key, name }
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

    // POST /api/delete-track { id, key }
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

    // POST /api/reorder-tracks { id, order }
    if (path === "/api/reorder-tracks" && request.method === "POST") {
      const { id, order } = await request.json();
      if (!id || !order) return new Response("Missing id or order", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });

      const byKey = {};
      library.soundtracks[id].tracks.forEach((t) => { byKey[t.key] = t; });
      const reordered = order.filter((k) => byKey[k]).map((k) => byKey[k]);
      const remaining = library.soundtracks[id].tracks.filter((t) => !order.includes(t.key));
      library.soundtracks[id].tracks = [...reordered, ...remaining];

      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/upload?id=<id> -> body is the raw file; stored at media/<id>/<filename>.
    // Works for soundtracks (tracks + cover) and playlists (cover image only).
    if (path === "/api/upload" && request.method === "POST") {
      const id = url.searchParams.get("id");
      const filename = request.headers.get("X-Filename");
      if (!id || !filename) return new Response("Missing id or filename", { status: 400, headers: corsHeaders });

      const library = await getLibrary(env);
      const isPlaylist = !!library.playlists[id];
      const target = isPlaylist ? library.playlists[id] : library.soundtracks[id];
      if (!target) return new Response("Unknown id", { status: 404, headers: corsHeaders });
      if (isPlaylist && !isCoverFile(filename)) {
        return new Response("Playlists only accept a cover image, not tracks", { status: 400, headers: corsHeaders });
      }

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

    // ---- playlists ----

    // POST /api/create-playlist { name, parentId }
    if (path === "/api/create-playlist" && request.method === "POST") {
      const { name, parentId } = await request.json();
      if (!name) return new Response("Missing name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      const id = generateId(name);
      library.playlists[id] = { id, name, parentId: parentId || null, tracks: [] }; // tracks: [{ soundtrackId, key }]
      await saveLibrary(env, library);
      return json({ success: true, id });
    }

    // POST /api/rename-playlist { id, name }
    if (path === "/api/rename-playlist" && request.method === "POST") {
      const { id, name } = await request.json();
      if (!id || !name) return new Response("Missing id or name", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.playlists[id]) return new Response("Unknown playlist", { status: 404, headers: corsHeaders });
      library.playlists[id].name = name;
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/add-to-playlist { playlistId, soundtrackId, key }
    if (path === "/api/add-to-playlist" && request.method === "POST") {
      const { playlistId, soundtrackId, key } = await request.json();
      if (!playlistId || !soundtrackId || !key) return new Response("Missing fields", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.playlists[playlistId]) return new Response("Unknown playlist", { status: 404, headers: corsHeaders });
      const already = library.playlists[playlistId].tracks.some((t) => t.soundtrackId === soundtrackId && t.key === key);
      if (!already) library.playlists[playlistId].tracks.push({ soundtrackId, key });
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // POST /api/remove-from-playlist { playlistId, soundtrackId, key }
    if (path === "/api/remove-from-playlist" && request.method === "POST") {
      const { playlistId, soundtrackId, key } = await request.json();
      if (!playlistId) return new Response("Missing playlistId", { status: 400, headers: corsHeaders });
      const library = await getLibrary(env);
      if (!library.playlists[playlistId]) return new Response("Unknown playlist", { status: 404, headers: corsHeaders });
      library.playlists[playlistId].tracks = library.playlists[playlistId].tracks.filter(
        (t) => !(t.soundtrackId === soundtrackId && t.key === key)
      );
      await saveLibrary(env, library);
      return json({ success: true });
    }

    // ---- move / delete / order (shared across soundtracks, playlists, folders) ----

    // POST /api/move { itemType: "soundtrack"|"playlist"|"folder", id, parentId }
    // Just updates which folder something belongs to. Instant - no file copying, ever.
    if (path === "/api/move" && request.method === "POST") {
      const { itemType, id, parentId } = await request.json();
      const library = await getLibrary(env);
      const newParentId = parentId || null;

      if (itemType === "soundtrack") {
        if (!library.soundtracks[id]) return new Response("Unknown soundtrack id", { status: 404, headers: corsHeaders });
        library.soundtracks[id].parentId = newParentId;
      } else if (itemType === "playlist") {
        if (!library.playlists[id]) return new Response("Unknown playlist", { status: 404, headers: corsHeaders });
        library.playlists[id].parentId = newParentId;
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

    // POST /api/delete { type: "soundtrack"|"playlist"|"folder", id }
    if (path === "/api/delete" && request.method === "POST") {
      const { type, id } = await request.json();
      const library = await getLibrary(env);

      async function deleteSoundtrack(sid) {
        const listed = await env.MUSIC_BUCKET.list({ prefix: `media/${sid}/` });
        for (const obj of listed.objects) {
          await env.MUSIC_BUCKET.delete(obj.key);
        }
        delete library.soundtracks[sid];
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => k !== sid);
        }
      }

      function deletePlaylist(pid) {
        delete library.playlists[pid];
        for (const key of Object.keys(library.order)) {
          library.order[key] = library.order[key].filter((k) => k !== pid);
        }
      }

      if (type === "soundtrack" && id) {
        await deleteSoundtrack(id);
      } else if (type === "playlist" && id) {
        deletePlaylist(id);
      } else if (type === "folder" && id) {
        if (!library.folders[id]) return new Response("Unknown folder", { status: 404, headers: corsHeaders });
        const folderIds = getDescendantFolderIds(library, id); // includes id itself

        const soundtracksInside = Object.values(library.soundtracks).filter((s) => folderIds.has(s.parentId));
        for (const s of soundtracksInside) await deleteSoundtrack(s.id);

        const playlistsInside = Object.values(library.playlists).filter((pl) => folderIds.has(pl.parentId));
        for (const pl of playlistsInside) deletePlaylist(pl.id);

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
