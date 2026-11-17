/* Offline support: app shell cache-first, data network-first (falls back to last copy). */
const SHELL = "koyo-shell-v8";
const DATA = "koyo-data";
const ASSETS = ["./", "index.html", "style.css", "app.js", "planner.js", "diversity.js", "user.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/data/latest.json")) {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(DATA).then(c => c.put(new URL("data/latest.json", self.registration.scope).href, copy));
      return r;
    }).catch(() => caches.open(DATA).then(c => c.match(new URL("data/latest.json", self.registration.scope).href))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
