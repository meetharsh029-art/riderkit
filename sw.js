importScripts('lib-extra.js');
const V = 'riderkit-v20';
const ASSETS = ['./','index.html','styles.css','app.js','lib-core.js','lib-extra.js','app-extra.js','community.js','community.css','manifest.webmanifest','vendor/leaflet.js','vendor/leaflet.css',
  'vendor/images/marker-icon.png','vendor/images/marker-icon-2x.png','vendor/images/marker-shadow.png','vendor/images/layers.png','fonts/inter.woff2','icons/icon.svg','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('riderkit-') && k !== V && k !== 'riderkit-tiles' && k !== 'riderkit-tiles-meta').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'tile.openstreetmap.org') { // viewed-tile cache only: NO prefetch/bulk/"save area" (OSM Tile Usage Policy). Honours max-age (default 7 d), bounded to 600 tiles.
    e.respondWith(tileFetch(e.request)); return;
  }
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(m => m || fetch(e.request)));
});
self.addEventListener('push', e => { let d = {}; try { d = e.data ? e.data.json() : {}; } catch { try { d = { body: e.data.text() }; } catch {} }
  e.waitUntil(self.registration.showNotification(String(d.title || 'RiderKit').slice(0, 80), { body: String(d.body || '').slice(0, 200), tag: d.tag || 'rk', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: typeof d.url === 'string' && d.url.startsWith('./') ? d.url : './' } })); });
self.addEventListener('notificationclick', e => { e.notification.close(); const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { const c = cs.find(x => x.url.startsWith(self.registration.scope)); if (c) { return c.focus().then(() => c.navigate ? c.navigate(url) : null); } return self.clients.openWindow(url); })); });

const TCACHE = 'riderkit-tiles', TMETA = 'riderkit-tiles-meta', IDX = new Request('https://riderkit.invalid/tile-index');
async function tIndex() { try { const c = await caches.open(TMETA), r = await c.match(IDX); return r ? await r.json() : {}; } catch { return {}; } }
let MEM = null, chain = Promise.resolve(); // index kept in memory (loaded once) and persisted in order, so parallel tile requests cannot overwrite each other
const getIdx = async () => MEM || (MEM = await tIndex());
async function tSave(i) { chain = chain.then(async () => { try { await (await caches.open(TMETA)).put(IDX, new Response(JSON.stringify(i))); } catch {} }); return chain; }
async function tileFetch(req) {
  const url = req.url; if (!Extra.isTileUrl(url)) return fetch(req); // anything unexpected from the tile host: pass through untouched, never cached
  const c = await caches.open(TCACHE), cached = await c.match(url), idx = await getIdx(), now = Date.now();
  if (cached && Extra.tileFresh(idx[url], now)) return cached;
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', referrer: req.referrer && req.referrer !== 'about:client' ? req.referrer : undefined, referrerPolicy: 'strict-origin-when-cross-origin' });
    if (r.ok) { await c.put(url, r.clone()); idx[url] = { f: now, ttl: Extra.tileTtl(r.headers.get('cache-control')) }; for (const k of Extra.tileEvict(idx)) { delete idx[k]; await c.delete(k); } await tSave(idx); }
    return r;
  } catch { return cached || Response.error(); } // offline: serve an old tile we already viewed; never invent requests
}
