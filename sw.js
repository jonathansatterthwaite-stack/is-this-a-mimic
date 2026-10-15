// Offline support: serve the app shell from cache, refresh it in the background.
// Bump VERSION when shipping changes so clients pick them up.
const VERSION = "mimic-v2";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/vendor/qrcode.min.js", "js/vendor/marked.min.js", "js/vendor/purify.min.js", "js/vendor/jsQR.js", "js/vendor/svg-lay-tool.js", "js/vendor/svg-lay-fonts.js", "js/parts-library.js", "js/documents.js", "js/shops.js", "js/files.js", "js/panels.js", "js/triggers.js", "js/rule-blocks.js",
  "js/srd-data.js", "js/systems/dnd5e.js", "js/systems/dnd5e-panels.js", "js/systems/slot-delve.js", "js/templates.js", "js/system.js", "js/icons-data.js", "js/icons.js", "js/store.js", "js/party.js", "js/party-ui.js", "js/gm-controls.js", "js/control-panels.js", "js/treasure.js", "js/clockwork.js", "js/clockwork-ui.js", "js/starter-drawings.js", "js/showcase.js", "js/app.js", "js/radial.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates show up immediately; fall back to cache offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never cache party-server API calls (including the live event stream).
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
