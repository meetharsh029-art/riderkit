'use strict';
// RiderKit server: static app + group-ride API on one port. No dependencies.
// Env: PORT (8080), TRUST_PROXY=1|0 (defaults to 1 when NODE_ENV=production; use X-Forwarded-For for rate limiting, only behind a trusted tunnel/proxy).
const http = require('http'), fs = require('fs'), path = require('path');
const { GroupStore, Limiter, HttpError } = require('./groups');
const { sanitize, FeedbackStore, safeEq } = require('./feedback');
const { PushService } = require('./push'), { PinStore, PinError, TYPES: PIN_TYPES } = require('./pins'), { LiveStore, LiveError } = require('./live');
const { Community } = require('./community'); require('./community-posts'); require('./community-social'); require('./community-comments'); const { makeCommunityApi } = require('./community-api');
const { Accounts } = require('./auth'), { openKV } = require('./kv'), { makeMailer } = require('./mailer'), { makeSms } = require('./sms');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const STATIC_BLOCK = /^\/(server|tests|capacitor|node_modules)(\/|$)|^\/store(\/(?!privacy-policy\.html$)|$)|^\/\.|^\/data(\/|$)|\.md$/i;

const CORS_ORIGINS = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost', ...String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);
function createServer(opts = {}) {
  const store = new GroupStore(opts.store || { emptyTtlMs: +process.env.GROUP_EMPTY_TTL_MS || undefined, abandonedTtlMs: +process.env.GROUP_ABANDONED_MS || undefined }, opts.clock); // opts.clock: test-only fake clock for the group store
  const lim = new Limiter(opts.now);
  let _kv = opts.kv || null; const getKV = () => _kv || (_kv = openKV(process.env)); // ONE kv instance shared by accounts, push and pins (FileKV must not be opened twice)
  let acc = opts.accounts || null; const accounts = () => acc || (acc = new Accounts({ kv: getKV(), mailer: makeMailer(process.env), sms: makeSms(process.env), limits: opts.authLimits, onDelete: uid => deleteHook(uid) }));
  // Community (profiles, feed, clubs, chat). Needs durable storage in production: the JSON file on Render free is wiped on every restart, so it refuses to start there unless COMMUNITY_ALLOW_EPHEMERAL=1.
  let _comm; const communityOn = () => opts.community !== undefined ? !!opts.community : process.env.COMMUNITY === '1' || (process.env.NODE_ENV !== 'production' && process.env.COMMUNITY !== '0');
  const community = async () => { if (_comm !== undefined) return _comm; if (!communityOn()) return (_comm = null); const A = accounts(), kv = getKV();
    _comm = new Community({ kv, accounts: A, now: opts.now, adminToken, images: null, opts: opts.communityOpts, limits: opts.communityLimits });
    if (_comm.attachImages) _comm.attachImages(opts.images, process.env);
    if (process.env.NODE_ENV === 'production' && kv.kind !== 'postgres' && process.env.COMMUNITY_ALLOW_EPHEMERAL !== '1') _comm.disabledReason = 'community needs DATABASE_URL (Postgres) in production; the JSON file is lost on every restart (set COMMUNITY_ALLOW_EPHEMERAL=1 to override for a throwaway test)';
    return _comm; };
  const deleteHook = async uid => { const C = await community(); if (C) await C.deleteUser(uid); }; if (acc && !acc.onDelete) acc.onDelete = deleteHook;
  const communityApi = makeCommunityApi({ community, body: (r, m) => body(r, m), rawBody: (r, m) => rawBody(r, m), json: (r, s, o) => json(r, s, o) });
  const trust = opts.trustProxy ?? (process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === '1' : process.env.NODE_ENV === 'production'); // default ON in production (behind Render's proxy)
  const L = Object.assign({ feedback: [5, 600e3], global: [300, 60e3], create: [10, 60e3], join: [30, 60e3], joinFail: [10, 600e3], loc: [1, 900], sse: [20, 60e3], alert: [3, 60e3], alertGroup: [20, 600e3], alertCancel: [6, 60e3], say: [8, 10e3], sayGroup: [60, 60e3], voice: [5, 30e3], voiceGroup: [30, 10 * 60e3], clipGet: [60, 60e3], lifecycle: [10, 60e3], expense: [10, 60e3], stopReq: [6, 60e3], stopAct: [30, 60e3], liveCreate: [6, 3600e3], liveUpdate: [1, 2000], liveRead: [40, 60e3], pinAdd: [5, 3600e3], pinAddIp: [12, 3600e3], pinVote: [60, 3600e3], pinReport: [10, 3600e3], pinRead: [60, 60e3], pushSync: [12, 60e3], pushTest: [3, 3600e3] }, opts.limits);
  let _pins = opts.pins || null; const pins = () => _pins || (_pins = new PinStore({ kv: getKV() }));
  const live = opts.live || new LiveStore({ now: opts.now });
  let _push = opts.push || null; const push = () => _push || (_push = new PushService({ kv: getKV() }));
  const fb = new FeedbackStore(opts.feedbackFile, opts.feedbackMaxBytes);
  const adminToken = () => opts.adminToken !== undefined ? opts.adminToken : process.env.ADMIN_TOKEN || '';
  const ipOf = req => (trust && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const json = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
  const rawBody = (req, max) => new Promise((ok, bad) => { const cl = +req.headers['content-length']; if (cl > max) { req.resume(); return bad(new HttpError(413, 'clip too large')); }
    let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n <= max) ch.push(c); }); req.on('end', () => n > max ? bad(new HttpError(413, 'clip too large')) : ok(Buffer.concat(ch))); req.on('error', bad); });
  const AUDIO_RE = /^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a)(;.*)?$/i;
  const body = (req, max = 4096) => new Promise((ok, bad) => { let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n <= max) ch.push(c); });
    req.on('end', () => { if (n > max) return bad(new HttpError(413, 'body too large')); if (!ch.length) return ok({}); try { const o = JSON.parse(Buffer.concat(ch)); ok(o && typeof o === 'object' ? o : {}); } catch { bad(new HttpError(400, 'bad json')); } });
    req.on('error', bad); });
  const limit = (ok, msg = 'rate limit exceeded') => { if (!ok) throw new HttpError(429, msg); };

  // Optional accounts. Guests are unaffected: no group/ride endpoint requires these. Auth is a Bearer session token (hash stored server-side).
  async function authApi(req, res, p, ip) {
    const A = accounts(), ua = req.headers['user-agent'], bearer = () => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7) : ''; };
    const me = async () => { const u = await A.session(bearer()); if (!u) throw new HttpError(401, 'not signed in'); return u; };
    const act = p.join('/');
    if (req.method === 'GET' && act === 'config') return json(res, 200, A.config());
    if (req.method === 'GET' && act === 'me') { const u = await me(); return json(res, 200, { user: { id: u.id, email: u.email, phone: u.phone, createdAt: u.createdAt } }); }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const b = await body(req, 2048);
    switch (act) {
      case 'register': return json(res, 200, await A.register(ip, b.email, b.password));
      case 'verify': return json(res, 200, await A.verifyEmail(ip, b.email, b.code, ua));
      case 'login': return json(res, 200, await A.login(ip, b.email, b.password, ua));
      case 'forgot': return json(res, 200, await A.forgot(ip, b.email));
      case 'reset': return json(res, 200, await A.reset(ip, b.email, b.code, b.password, ua));
      case 'logout': await A.logout(bearer()); return json(res, 200, { ok: true });
      case 'logout-all': { const u = await me(); await A.logoutAll(u.id); return json(res, 200, { ok: true }); }
      case 'change-password': { const u = await me(); return json(res, 200, await A.changePassword(ip, u, b.oldPassword, b.newPassword)); }
      case 'delete': { const u = await me(); return json(res, 200, await A.deleteAccount(ip, u, b)); }
      case 'phone/start': return json(res, 200, await A.phoneStart(ip, b.phone));
      case 'phone/verify': return json(res, 200, await A.phoneVerify(ip, b.phone, b.code, ua));
      case 'phone/delete-code': { const u = await me(); if (!u.phone) throw new HttpError(400, 'no phone on this account'); return json(res, 200, await A.phoneStart(ip, u.phone, 'delete')); }
    }
    throw new HttpError(404, 'not found');
  }

  async function api(req, res, url) {
    const ip = ipOf(req);
    limit(lim.hit('g:' + ip, ...L.global));
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
    const q = url.searchParams;
    if (req.method === 'GET' && parts[0] === 'health') return json(res, 200, { ok: true, groups: store.groups.size });
    if (parts[0] === 'feedback') {
      if (req.method === 'POST') {
        limit(lim.hit('fb:' + ip, ...L.feedback), 'too many reports, try again later');
        const r = sanitize(await body(req, 8192)); if (r.error) throw new HttpError(400, r.error);
        const rec = fb.add(r.value); if (!rec) throw new HttpError(507, 'feedback inbox is full');
        return json(res, 201, { ok: true, id: rec.id });
      }
      if (req.method === 'GET') {
        const tok = adminToken(); if (!tok) throw new HttpError(404, 'not found'); // disabled unless ADMIN_TOKEN is set
        limit(lim.count('fba:' + ip, 600e3) < 10, 'too many attempts');
        const h = String(req.headers.authorization || ''); const given = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-admin-token'] || '');
        if (!given || !safeEq(given, tok)) { lim.hit('fba:' + ip, 10, 600e3); throw new HttpError(401, 'unauthorized'); }
        const items = fb.list(Math.min(+q.get('limit') || 200, 1000)); return json(res, 200, { count: items.length, items });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (parts[0] === 'community') return communityApi(req, res, url, parts.slice(1), ip);
    if (parts[0] === 'live') { const wrap = fn => { try { return fn(); } catch (e) { throw e instanceof LiveError ? new HttpError(e.status, e.message) : e; } }, id = parts[1], act = parts[2];
      if (req.method === 'GET' && id) { limit(lim.hit('lr:' + ip + id, ...L.liveRead), 'polling too fast'); return json(res, 200, wrap(() => live.view(id))); }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (!id) { limit(lim.hit('lc:' + ip, ...L.liveCreate), 'too many live links created, try later'); const b = await body(req); return json(res, 201, wrap(() => live.create(b))); }
      const b = await body(req);
      if (act === 'update') { limit(lim.hit('lu:' + id, ...L.liveUpdate), 'too frequent'); return json(res, 200, wrap(() => live.update(id, b.key, b))); }
      if (act === 'stop') return json(res, 200, wrap(() => live.stop(id, b.key)));
      throw new HttpError(404, 'not found'); }
    if (parts[0] === 'pins') { const P = pins(), act = parts[1], dev = String(req.headers['x-device-id'] || '');
      const wrap = fn => fn().catch(e => { throw e instanceof PinError ? new HttpError(e.status, e.message) : e; });
      if (req.method === 'GET' && !act) { limit(lim.hit('pr:' + ip, ...L.pinRead), 'too many map requests, slow down'); const bb = String(q.get('bbox') || '').split(',').map(Number); const types = String(q.get('types') || '').split(',').filter(x => PIN_TYPES[x]);
        return json(res, 200, { pins: await wrap(() => P.query(bb, types)), types: Object.fromEntries(Object.entries(PIN_TYPES).map(([k, v]) => [k, { label: v.label, hazard: v.hazard }])) }); }
      if (act === 'admin') { const tok = adminToken(); if (!tok) throw new HttpError(404, 'not found'); limit(lim.count('pa:' + ip, 600e3) < 10, 'too many attempts');
        const h = String(req.headers.authorization || ''); const given = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-admin-token'] || ''); if (!given || !safeEq(given, tok)) { lim.hit('pa:' + ip, 10, 600e3); throw new HttpError(401, 'unauthorized'); }
        if (req.method === 'GET') return json(res, 200, { items: await P.adminList() }); const b = await body(req); return json(res, 200, await wrap(() => P.adminAct(String(b.id || ''), b.act))); }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      if (!act) { limit(lim.hit('pa:' + ip, ...L.pinAddIp), 'too many pins from this network, try later'); limit(lim.hit('pd:' + dev, ...L.pinAdd), 'you can add 5 pins per hour'); const b = await body(req); return json(res, 201, await wrap(() => P.add(b, dev))); }
      if (act === 'vote') { limit(lim.hit('pv:' + dev, ...L.pinVote), 'too many votes, slow down'); const b = await body(req); return json(res, 200, await wrap(() => P.vote(String(b.id || ''), b.dir, dev))); }
      if (act === 'report') { limit(lim.hit('pp:' + dev, ...L.pinReport), 'too many reports, slow down'); limit(lim.hit('ppi:' + ip, 30, 3600e3), 'too many reports from this network'); const b = await body(req); return json(res, 200, await wrap(() => P.report(String(b.id || ''), dev, b.reason))); }
      throw new HttpError(404, 'not found'); }
    if (parts[0] === 'push') { const act = parts[1], P = push();
      if (req.method === 'GET' && act === 'key') return json(res, 200, { key: await P.publicKey() });
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      limit(lim.hit('ps:' + ip, ...L.pushSync), 'too many requests, slow down'); const b = await body(req, 16384);
      if (act === 'sync') return json(res, 200, await P.sync(b));
      if (act === 'unsubscribe') return json(res, 200, { ok: true, removed: await P.remove(b.endpoint) });
      if (act === 'test') { limit(lim.hit('pt:' + P.id(String(b.endpoint || '')), ...L.pushTest), 'test notification limit reached, try later'); return json(res, 200, await P.test(b.endpoint)); }
      throw new HttpError(404, 'not found'); }
    if (parts[0] === 'auth') return authApi(req, res, parts.slice(1), ip);
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
      res.write('retry: 3000\n\n'); send(store.snapshot(g)); const lg = store.recentLog(g); if (lg.length) res.write('event: log\ndata: ' + JSON.stringify(lg) + '\n\n');
      const unm = store.subscribeMsg(g.code, mg => res.write('event: msg\ndata: ' + JSON.stringify(mg) + '\n\n'));
      const un0 = store.subscribe(g.code, send); const un = () => { un0(); unm(); }; const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { un(); clearInterval(ka); }); return;
    }
    if (act === 'clip' && req.method === 'GET') { limit(lim.hit('cg:' + token, ...L.clipGet)); const c = store.getClip(code, token, parts[3]);
      res.writeHead(200, { 'content-type': c.mime, 'content-length': c.buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(c.buf); }
    if (act === 'voice' && req.method === 'POST') { const tk = token; store.auth(code, tk);
      if (!AUDIO_RE.test(String(req.headers['content-type'] || ''))) { req.resume(); throw new HttpError(415, 'unsupported audio type'); }
      limit(lim.hit('v:' + tk, ...L.voice), 'sending voice too often, wait a few seconds'); limit(lim.hit('vg:' + store.normCode(code), ...L.voiceGroup), 'too many voice clips in this group');
      const buf = await rawBody(req, store.o.maxClipBytes); const mime = String(req.headers['content-type']).split(';')[0].toLowerCase();
      const msg = store.addClip(code, tk, buf, mime, q.get('dur')); return json(res, 201, { ok: true, id: msg.id, expiresAt: msg.expiresAt }); }
    if (act === 'expenses' && req.method === 'GET') { limit(lim.hit('xg:' + token, 30, 60e3), 'too many requests'); return json(res, 200, store.listExpenses(code, token)); }
    if (!act && req.method === 'GET') { const { g, m } = store.auth(code, token); m.lastSeen = store.now(); return json(res, 200, store.snapshot(g)); }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const b = await body(req); const tk = b.token || token;
    if (act === 'location') { limit(lim.hit('l:' + tk, ...L.loc), 'too frequent'); store.location(code, tk, b); return json(res, 200, { ok: true }); }
    if (act === 'destination') { limit(lim.hit('d:' + tk, 10, 10e3)); b.lat === null ? store.clearDest(code, tk) : store.setDest(code, tk, b); return json(res, 200, { ok: true }); }
    if (act === 'alert' && parts[3] === 'cancel') { limit(lim.hit('ac:' + tk, ...L.alertCancel), 'too many cancels, slow down'); const r = store.cancelAlert(code, tk); store.flushNow(r.g); return json(res, 200, { ok: true, cancelled: r.had }); }
    if (act === 'alert' && !parts[3]) { store.auth(code, tk); limit(lim.hit('a:' + tk, ...L.alert), 'too many alerts, wait a minute'); limit(lim.hit('ag:' + store.normCode(code), ...L.alertGroup), 'too many alerts in this group');
      const g = store.raiseAlert(code, tk, b); store.flushNow(g); return json(res, 200, { ok: true }); }
    if (act === 'say') { store.auth(code, tk); limit(lim.hit('sy:' + tk, ...L.say), 'sending too fast, slow down'); limit(lim.hit('syg:' + store.normCode(code), ...L.sayGroup), 'too many messages in this group');
      const mg = store.say(code, tk, b.type); return json(res, 200, { ok: true, id: mg.id }); }
    if (act === 'expense' && !parts[3]) { store.auth(code, tk); limit(lim.hit('x:' + tk, ...L.expense), 'adding expenses too fast'); const r = store.addExpense(code, tk, b); store.flushNow(r.g); return json(res, 201, { ok: true, expense: r.expense }); }
    if (act === 'expense' && parts[3] === 'delete') { store.auth(code, tk); limit(lim.hit('x:' + tk, ...L.expense), 'too fast'); const g = store.delExpense(code, tk, b.id); store.flushNow(g); return json(res, 200, { ok: true }); }
    if (act === 'stop' && !parts[3]) { store.auth(code, tk); limit(lim.hit('st:' + tk, ...L.stopReq), 'requesting stops too fast'); const r = store.requestStop(code, tk, b); store.flushNow(r.g); return json(res, 201, { ok: true, stop: { id: r.stop.id } }); }
    if (act === 'stop' && parts[3] === 'act') { store.auth(code, tk); limit(lim.hit('sa:' + tk, ...L.stopAct), 'too fast'); const g = store.stopAct(code, tk, b.id, b.act); store.flushNow(g); return json(res, 200, { ok: true }); }
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
    if (url.pathname.startsWith('/api/')) { // CORS for the Capacitor app (no cookies/credentials used, so an origin allow-list is enough)
      const o = req.headers.origin;
      if (o && CORS_ORIGINS.has(o)) { res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-device-id', 'access-control-max-age': '86400' }); return res.end(); }
    }
    try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url); }
    catch (e) { if (res.headersSent) return res.end(); const s = e.status || 500; if (s === 500) console.error(e); json(res, s, { error: s === 500 ? 'server error' : e.message }); }
  });
  const timers = [setInterval(() => store.flush(), opts.flushMs || 1000), setInterval(() => { store.sweep(); lim.gc(); if (acc) acc.sweep().catch(() => {}); }, opts.sweepMs || 60e3), setInterval(() => { push().sweep().catch(e => console.error('push sweep', e.message)); pins().sweep().catch(() => {}); }, opts.pushSweepMs || 30 * 60e3), setInterval(() => live.sweep(), 60e3)];
  timers.forEach(t => t.unref());
  server.on('close', () => timers.forEach(clearInterval));
  server.communityInstance = () => _comm; server.store = store; server.live = live; server.push = () => push(); return server;
}
if (require.main === module) { const port = +process.env.PORT || 8080; createServer().listen(port, '0.0.0.0', () => console.log('RiderKit server on :' + port)); }
module.exports = { createServer };
