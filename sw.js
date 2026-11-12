// Hunt Map service worker
// Bump VERSION on every release: phones see the changed file, install it, and offer a reload.
const VERSION = '2.1.0';
const APP = 'hm-app-' + VERSION;
const TILES = 'hm-tiles';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/suncalc.js', 'vendor/togeojson.umd.js', 'vendor/shp.js'];

self.addEventListener('install', e => {
  // cache: 'reload' bypasses the browser HTTP cache so a new release gets fresh files
  e.waitUntil(caches.open(APP)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hm-app-') && k !== APP).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => {
  if (e.data === 'version' && e.source) e.source.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // USGS map tiles: cache first (these never change), network on a miss
  if (url.hostname === 'basemap.nationalmap.gov') {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      let res;
      try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); }
      catch (_) { res = await fetch(req); }
      if (res && (res.ok || res.type === 'opaque')) cache.put(req.url, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  // App files: this release's cached copy (fast, works with no signal).
  // New releases arrive through a new sw.js, which the browser checks on its own.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(APP);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (_) { return (await cache.match('index.html')) || Response.error(); }
    })());
  }
});
