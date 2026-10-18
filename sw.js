const V = 'riderkit-v11';
const ASSETS = ['./','index.html','styles.css','app.js','lib-core.js','manifest.webmanifest','vendor/leaflet.js','vendor/leaflet.css',
  'vendor/images/marker-icon.png','vendor/images/marker-icon-2x.png','vendor/images/marker-shadow.png','vendor/images/layers.png','fonts/inter.woff2','icons/icon.svg','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('riderkit-') && k !== V && k !== 'riderkit-tiles').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('tile.openstreetmap.org')) { // runtime cache of viewed tiles
    e.respondWith(caches.open('riderkit-tiles').then(async c => { const m = await c.match(e.request); if (m) return m;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch { return Response.error(); } }));
    return;
  }
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(m => m || fetch(e.request)));
});
