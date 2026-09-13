// sw.js
// Caches only the app shell (this page + the React/Babel CDN scripts it loads),
// so the app itself installs and reloads instantly. It does NOT touch your Worker
// API calls or audio streams - those still go straight to the network, and your
// existing per-soundtrack "Download for offline" feature (Cache Storage API in
// index.html) handles audio caching separately.

const CACHE_NAME = "app-shell-v2";

const SHELL_FILES = [
  "./",
  "./index.html",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const isShellFile = SHELL_FILES.some(
    (f) => event.request.url.endsWith(f.replace("./", "")) || event.request.url === f
  );
  if (!isShellFile) return; // let everything else (API calls, audio streams) go straight to network as usual

  // network-first: always try to get the latest version; only fall back to the cached
  // copy if the network is unavailable (e.g. offline). This keeps updates from ever
  // going stale, since we're no longer relying on the cache unless we have to.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
