'use strict';
// RiderKit server: static app + group-ride API on one port. No dependencies.
// Env: PORT (8080), TRUST_PROXY=1|0 (defaults to 1 when NODE_ENV=production; use X-Forwarded-For for rate limiting, only behind a trusted tunnel/proxy).
const http = require('http'), fs = require('fs'), path = require('path');
const { GroupStore, Limiter, HttpError } = require('./groups');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const STATIC_BLOCK = /^\/(server|tests|capacitor|node_modules)(\/|$)|^\/store(\/(?!privacy-policy\.html$)|$)|^\/\.|\.md$/i;

function createServer(opts = {}) {
  const store = new GroupStore(opts.store || { emptyTtlMs: +process.env.GROUP_EMPTY_TTL_MS || undefined, abandonedTtlMs: +process.env.GROUP_ABANDONED_MS || undefined }, opts.clock); // opts.clock: test-only fake clock for the group store
  const lim = new Limiter(opts.now);
  const trust = opts.trustProxy ?? (process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === '1' : process.env.NODE_ENV === 'production'); // default ON in production (behind Render's proxy)
  const L = Object.assign({ global: [300, 60e3], create: [10, 60e3], join: [30, 60e3], joinFail: [10, 600e3], loc: [1, 900], sse: [20, 60e3], alert: [3, 60e3], alertGroup: [20, 600e3], alertCancel: [6, 60e3], lifecycle: [10, 60e3] }, opts.limits);
  const ipOf = req => (trust && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const json = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
  const body = req => new Promise((ok, bad) => { let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n <= 4096) ch.push(c); });
    req.on('end', () => { if (n > 4096) return bad(new HttpError(413, 'body too large')); if (!ch.length) return ok({}); try { const o = JSON.parse(Buffer.concat(ch)); ok(o && typeof o === 'object' ? o : {}); } catch { bad(new HttpError(400, 'bad json')); } });
    req.on('error', bad); });
  const limit = (ok, msg = 'rate limit exceeded') => { if (!ok) throw new HttpError(429, msg); };

  async function api(req, res, url) {
    const ip = ipOf(req);
    limit(lim.hit('g:' + ip, ...L.global));
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
    const q = url.searchParams;
    if (req.method === 'GET' && parts[0] === 'health') return json(res, 200, { ok: true, groups: store.groups.size });
    if (parts[0] !== 'groups') throw new HttpError(404, 'not found');
    if (parts.length === 1 && req.method === 'POST') {
      limit(lim.hit('c:' + ip, ...L.create), 'too many groups created, slow down');
      const b = await body(req); const { g, m } = store.create(b.rider);
      return json(res, 201, { code: g.code, link: '?join=' + g.code, memberId: m.id, token: m.token, state: store.snapshot(g) });
    }
    const code = parts[1], act = parts[2];
    if (act === 'join' && req.method === 'POST') {
      limit(lim.hit('j:' + ip, ...L.join));
      limit(lim.count('jf:' + ip, L.joinFail[1]) < L.joinFail[0], 'too many wrong codes, wait a few minutes');
      const b = await body(req); let r;
      try { r = store.join(code, b.rider); } catch (e) { if (e.status === 404) limit(lim.hit('jf:' + ip, ...L.joinFail), 'too many wrong codes, wait a few minutes'); throw e; }
      if (r.rejoined) store.flushNow(r.g); return json(res, 200, { code: r.g.code, memberId: r.m.id, token: r.m.token, rejoined: !!r.rejoined, state: store.snapshot(r.g) });
    }
    const token = q.get('token') || '';
    if (act === 'events' && req.method === 'GET') {
      limit(lim.hit('s:' + ip, ...L.sse)); const { g } = store.auth(code, token);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = s => { if (s === null) return res.end(); res.write('event: state\ndata: ' + JSON.stringify(s) + '\n\n'); };
      res.write('retry: 3000\n\n'); send(store.snapshot(g));
      const un = store.subscribe(g.code, send); const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { un(); clearInterval(ka); }); return;
    }
    if (!act && req.method === 'GET') { const { g, m } = store.auth(code, token); m.lastSeen = store.now(); return json(res, 200, store.snapshot(g)); }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const b = await body(req); const tk = b.token || token;
    if (act === 'location') { limit(lim.hit('l:' + tk, ...L.loc), 'too frequent'); store.location(code, tk, b); return json(res, 200, { ok: true }); }
    if (act === 'destination') { limit(lim.hit('d:' + tk, 10, 10e3)); b.lat === null ? store.clearDest(code, tk) : store.setDest(code, tk, b); return json(res, 200, { ok: true }); }
    if (act === 'alert' && parts[3] === 'cancel') { limit(lim.hit('ac:' + tk, ...L.alertCancel), 'too many cancels, slow down'); const r = store.cancelAlert(code, tk); store.flushNow(r.g); return json(res, 200, { ok: true, cancelled: r.had }); }
    if (act === 'alert' && !parts[3]) { store.auth(code, tk); limit(lim.hit('a:' + tk, ...L.alert), 'too many alerts, wait a minute'); limit(lim.hit('ag:' + store.normCode(code), ...L.alertGroup), 'too many alerts in this group');
      const g = store.raiseAlert(code, tk, b); store.flushNow(g); return json(res, 200, { ok: true }); }
    if (act === 'leave') { limit(lim.hit('lv:' + tk, ...L.lifecycle)); const r = store.leave(code, tk); if (!r.closed) store.flushNow(r.g); return json(res, 200, { ok: true, closed: r.closed }); }
    if (act === 'endtrip') { limit(lim.hit('lv:' + tk, ...L.lifecycle)); const r = store.endTrip(code, tk); if (!r.closed) store.flushNow(r.g); return json(res, 200, { ok: true, closed: r.closed ? 'finished' : null }); }
    if (act === 'cancel') { limit(lim.hit('lv:' + tk, ...L.lifecycle)); store.cancelGroup(code, tk); return json(res, 200, { ok: true, closed: 'cancelled' }); }
    if (act === 'transfer') { limit(lim.hit('lv:' + tk, ...L.lifecycle)); const g = store.transferAdmin(code, tk, b.to); store.flushNow(g); return json(res, 200, { ok: true }); }
    if (act === 'claim') { limit(lim.hit('lv:' + tk, ...L.lifecycle)); const g = store.claimAdmin(code, tk); store.flushNow(g); return json(res, 200, { ok: true }); }
    throw new HttpError(404, 'not found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';
    if (p.includes('\0') || STATIC_BLOCK.test(p)) { res.writeHead(404); return res.end('not found'); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(f, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': p === '/sw.js' || p.endsWith('.html') ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') return res.end(); fs.createReadStream(f).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : 'ok'); }
    try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url); }
    catch (e) { if (res.headersSent) return res.end(); const s = e.status || 500; if (s === 500) console.error(e); json(res, s, { error: s === 500 ? 'server error' : e.message }); }
  });
  const timers = [setInterval(() => store.flush(), opts.flushMs || 1000), setInterval(() => { store.sweep(); lim.gc(); }, opts.sweepMs || 60e3)];
  timers.forEach(t => t.unref());
  server.on('close', () => timers.forEach(clearInterval));
  server.store = store; return server;
}
if (require.main === module) { const port = +process.env.PORT || 8080; createServer().listen(port, '0.0.0.0', () => console.log('RiderKit server on :' + port)); }
module.exports = { createServer };
