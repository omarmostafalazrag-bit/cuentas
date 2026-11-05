// Cuentas claras: offline support. Bump VERSION on every release so phones pick up the update.
const VERSION = "cuentas-v3";
const CORE = ["./", "index.html", "app.css", "app.js", "util.js", "vault.js", "model.js", "advisor.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Network first for the app's own files so updates arrive; the cache answers when offline.
    const key = req.mode === "navigate" ? "index.html" : req;
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key, { ignoreSearch: true })));
    return;
  }
  if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })));
  }
});
