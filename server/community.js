'use strict';
// Malhiva community: safety foundation + profiles (stages 0 and 1). Storage = the KV interface in kv.js (memory / file / Postgres), no extra dependency.
// Later stages extend Community.prototype from community-posts.js / community-social.js / community-chat.js.
// Key design rule: one key per entity plus explicit prefix indexes, read with kv.range (never kv.scan on a big namespace during a request).
const crypto = require('crypto');
const { HttpError, Limiter } = require('./groups');
const { safeEq } = require('./feedback');

const RULES_VERSION = 1;
const REASONS = ['spam', 'harassment', 'nudity', 'violence', 'dangerous_riding', 'personal_info', 'other'];
const KINDS = ['post', 'comment', 'profile', 'club', 'message', 'dm'];
const AVATARS = ['helmet', 'bike', 'scooter', 'car', 'mountain', 'road', 'flag', 'bolt', 'compass', 'wrench', 'sun', 'moon'];
const RESERVED = new Set(['admin', 'administrator', 'riderkit', 'malhiva', 'support', 'moderator', 'mod', 'staff', 'official', 'help', 'system', 'root', 'null', 'undefined', 'deleted', 'everyone', 'me']);
// Words that are never allowed in handles / names / club names, and that put posts + comments on hold (author-only, in the admin queue) instead of publishing.
const BAD_RE = /\b(fuck\w*|bitch\w*|bastard|madarchod|bhenchod|chutiy\w*|nigger\w*|faggot|whore|slut|rapist)\b/i;
const SPAM_RE = /\b(telegram|whatsapp\s*group|join\s+(my|our)\s+group|click\s+here|free\s+money|crypto|forex|investment\s+plan|earn\s+\$?\d+)\b/i;
const LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|in|net|org|io|me|co|app|ly|gl|to|xyz|info|link|site|online|shop|ru|cc)\b|\bt\.me\b|\bwa\.me\b|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/;
const L0 = { // [max, windowMs] per user; the per-IP allowance is 3x (shared mobile NAT). Accounts younger than newAccountMs get half.
  post: [5, 864e5], comment: [30, 36e5], like: [120, 36e5], follow: [60, 36e5], followDay: [200, 864e5], report: [20, 864e5], clubCreate: [2, 864e5], upload: [10, 36e5],
  profileEdit: [10, 36e5], join: [5, 36e5], chat: [20, 6e4], dm: [30, 6e5], dmNew: [10, 864e5], block: [30, 36e5], clubAct: [30, 36e5], read: [240, 6e4], delete: [30, 36e5] };
const LABEL = { post: 'posts today', comment: 'comments this hour', like: 'likes this hour', follow: 'follows this hour', followDay: 'follows today', report: 'reports today', clubCreate: 'new clubs today', upload: 'photo uploads this hour', profileEdit: 'profile edits this hour', join: 'sign-ups', chat: 'chat messages this minute', dm: 'direct messages', dmNew: 'new conversations today', block: 'blocks this hour', clubAct: 'club actions this hour', read: 'requests this minute', delete: 'deletions this hour' };

// ---- text rules
function cleanText(s, max, { multiline = false, required = false, label = 'text', links = false } = {}) {
  s = String(s ?? '').normalize('NFKC').replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f<>]/g : /[\u0000-\u001f\u007f<>]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, label + ' is required');
  if (s.length > max) throw new HttpError(400, label + ' is too long (max ' + max + ' characters)');
  if (!links && (LINK_RE.test(s) || PHONE_RE.test(s))) throw new HttpError(400, 'links, e-mail addresses and phone numbers are not allowed in ' + label + ' (they are used for spam and scams)');
  return s;
}
const needsHold = s => BAD_RE.test(s) || SPAM_RE.test(s);
const normHandle = h => { h = String(h ?? '').trim().toLowerCase().replace(/^@/, ''); if (!/^[a-z0-9_]{3,20}$/.test(h)) throw new HttpError(400, 'handle must be 3-20 letters, numbers or underscores'); if (RESERVED.has(h) || BAD_RE.test(h.replace(/_/g, ' ')) || BAD_RE.test(h)) throw new HttpError(400, 'that handle is not available'); return h; };
const MAXT = 9999999999999;

class Community {
  constructor({ kv, accounts, images = null, now = () => Date.now(), adminToken = () => '', opts = {}, limits = {} }) {
    this.kv = kv; this.accounts = accounts; this.images = images; this.now = now; this.adminToken = adminToken;
    this.o = Object.assign({ newAccountMs: (process.env.COMMUNITY_NEW_ACCOUNT_HOURS !== undefined && process.env.COMMUNITY_NEW_ACCOUNT_HOURS !== '' ? +process.env.COMMUNITY_NEW_ACCOUNT_HOURS : 24) * 36e5, reportHide: 3, newAcctDays: 7, maxBlocks: 500, maxFollowing: 2000, quotaBytes: 50e6, maxPostPhotos: 3, imgUrlTtlMs: 6 * 36e5, uploadTtlMs: 864e5, clubCap: 600, dmCap: 1000, groupMax: 30, clubMax: 500 }, opts);
    this.L = Object.assign({}, L0, limits); this.lim = new Limiter(now); this.locks = new Map(); this.cascades = []; this.routes = []; this.seq = 0; this._init();
  }
  _init() {}
  // ---- ids and keys. tkey(): newest-first ordering when scanned ascending; akey(): oldest-first.
  rand(n = 4) { return crypto.randomBytes(n).toString('hex'); }
  tkey() { return String(MAXT - this.now()).padStart(13, '0') + this.rand(4); }
  akey() { return String(this.now()).padStart(13, '0') + String(this.seq++ % 10000).padStart(4, '0') + this.rand(2); }
  async lock(key, fn) { const prev = this.locks.get(key) || Promise.resolve(); let done; const cur = new Promise(r => done = r); const chain = prev.then(() => cur); this.locks.set(key, chain);
    await prev; try { return await fn(); } finally { done(); if (this.locks.get(key) === chain) this.locks.delete(key); } }
  // ---- rate limits: per user and per IP
  rl(name, uid, ip, user) {
    const [max, win] = this.L[name], young = user && this.now() - (user.createdAt || 0) < this.o.newAccountMs, m = young ? Math.max(1, Math.ceil(max / 2)) : max;
    if (!this.lim.hit('c:' + name + ':u:' + uid, m, win)) throw new HttpError(429, 'slow down: you have reached the limit for ' + LABEL[name] + (young ? ' (new accounts have lower limits for the first day)' : ''));
    if (ip && !this.lim.hit('c:' + name + ':i:' + ip, max * 3, win)) throw new HttpError(429, 'too many requests from this network for ' + LABEL[name] + ', try later');
  }
  // ---- actors
  async user(token) { const u = await this.accounts.session(token); if (!u) throw new HttpError(401, 'sign in first'); return u; }
  async prof(uid) { return this.kv.get('cprof', uid); }
  async member(token) { const user = await this.user(token), prof = await this.prof(user.id); if (!prof) throw new HttpError(403, 'join the community first (18+ and rules)'); return { user, prof }; }
  canWrite(prof) { if (prof.state === 'suspended') throw new HttpError(403, 'your community access is suspended; contact support'); }
  async uidByHandle(h) { return this.kv.get('chandle', normHandleLoose(h)); }
  async profByHandle(h) { const id = await this.uidByHandle(h); return id ? this.prof(id) : null; }
  async author(uid) { const p = await this.prof(uid); return p ? { id: uid, handle: p.handle, name: p.name || p.handle, avatar: p.avatar } : { id: uid, handle: 'deleted', name: 'Deleted rider', avatar: 'helmet' }; }
  // ---- blocks: hidden both ways, and the blocked person is never told (they just cannot find you)
  async isBlocked(a, b) { return !!(await this.kv.get('cblock', a + ':' + b)) || !!(await this.kv.get('cblock', b + ':' + a)); }
  async blockedSet(uid) { const s = new Set(); for (const [k] of await this.kv.range('cblock', { prefix: uid + ':', limit: 1000 })) s.add(k.split(':')[1]); for (const [k] of await this.kv.range('cblockby', { prefix: uid + ':', limit: 1000 })) s.add(k.split(':')[1]); return s; }
  async block(me, targetHandle, ip, user) {
    this.rl('block', me.id, ip, user); const t = await this.profByHandle(targetHandle); if (!t || t.id === me.id) throw new HttpError(404, 'rider not found');
    if ((await this.kv.range('cblock', { prefix: me.id + ':', limit: this.o.maxBlocks + 1 })).length >= this.o.maxBlocks) throw new HttpError(400, 'block list is full');
    await this.kv.set('cblock', me.id + ':' + t.id, { at: this.now() }); await this.kv.set('cblockby', t.id + ':' + me.id, 1);
    if (this.removeFollowEdges) { await this.removeFollowEdges(me.id, t.id); await this.removeFollowEdges(t.id, me.id); } if (this.onBlock) await this.onBlock(me.id, t.id);
    return { ok: true, blocked: t.handle }; }
  async unblock(me, targetHandle) { const t = await this.profByHandle(targetHandle); if (!t) throw new HttpError(404, 'rider not found'); await this.kv.del('cblock', me.id + ':' + t.id); await this.kv.del('cblockby', t.id + ':' + me.id); return { ok: true }; }
  async blockList(me) { const out = []; for (const [k] of await this.kv.range('cblock', { prefix: me.id + ':', limit: 1000 })) out.push(await this.author(k.split(':')[1])); return { blocked: out.map(a => ({ handle: a.handle, name: a.name, avatar: a.avatar })) }; }
  // ---- sign-up to the community: 18+ and rules consent, unique handle, PRIVATE by default
  config() { return { enabled: true, rulesVersion: RULES_VERSION, reasons: REASONS, avatars: AVATARS, images: this.images ? { store: this.images.kind, max: this.imgMax || 1e6, maxPhotos: this.o.maxPostPhotos } : null, limits: { caption: 500, comment: 300, chat: 400, bio: 160 } }; }
  async join(user, b, ip) {
    if ((await this.prof(user.id))) throw new HttpError(409, 'you are already in the community');
    if (b.age18 !== true || b.rules !== true) throw new HttpError(400, 'you must confirm that you are 18 or older and that you accept the community rules');
    const handle = normHandle(b.handle); this.rl('join', user.id, ip); const name = b.name ? cleanText(b.name, 30, { label: 'name' }) : handle;
    if (BAD_RE.test(name)) throw new HttpError(400, 'that name is not allowed');
    if (!await this.kv.add('chandle', handle, user.id)) throw new HttpError(409, 'that handle is taken');
    const p = { id: user.id, handle, name, bio: '', vehicle: '', avatar: AVATARS.includes(b.avatar) ? b.avatar : 'helmet', visibility: 'private', dm: 'none', showStats: false, stats: null, state: 'ok', createdAt: this.now(), handleAt: this.now(),
      consent: { at: this.now(), rules: RULES_VERSION, age18: true }, counts: { posts: 0, followers: 0, following: 0 }, bytes: 0 };
    await this.kv.set('cprof', user.id, p); return { profile: this.selfView(p) }; }
  selfView(p) { return { id: p.id, handle: p.handle, name: p.name, bio: p.bio, vehicle: p.vehicle, avatar: p.avatar, visibility: p.visibility, dm: p.dm, showStats: p.showStats, stats: p.stats, state: p.state, counts: p.counts, createdAt: p.createdAt, consent: p.consent, handleChangedAt: p.handleAt }; }
  async me(user) { const p = await this.prof(user.id); return { user: { id: user.id }, joined: !!p, profile: p ? this.selfView(p) : null, rulesVersion: RULES_VERSION, mustReconsent: !!p && p.consent.rules < RULES_VERSION }; }
  async updateProfile(user, p, b, ip) {
    this.canWrite(p); this.rl('profileEdit', user.id, ip, user); const n = Object.assign({}, p);
    if (b.handle !== undefined && normHandle(b.handle) !== p.handle) { const h = normHandle(b.handle); if (p.handleChanged && this.now() - p.handleAt < 30 * 864e5) throw new HttpError(400, 'you can change your handle once every 30 days');
      if (!await this.kv.add('chandle', h, user.id)) throw new HttpError(409, 'that handle is taken'); await this.kv.del('chandle', p.handle); n.handle = h; n.handleAt = this.now(); n.handleChanged = true; }
    if (b.name !== undefined) { n.name = cleanText(b.name, 30, { required: true, label: 'name' }); if (BAD_RE.test(n.name)) throw new HttpError(400, 'that name is not allowed'); }
    if (b.bio !== undefined) { n.bio = cleanText(b.bio, 160, { label: 'bio' }); if (BAD_RE.test(n.bio)) throw new HttpError(400, 'that bio is not allowed'); }
    if (b.vehicle !== undefined) n.vehicle = cleanText(b.vehicle, 40, { label: 'vehicle' });
    if (b.avatar !== undefined) { if (!AVATARS.includes(b.avatar)) throw new HttpError(400, 'unknown avatar'); n.avatar = b.avatar; }
    if (b.visibility !== undefined) { if (!['private', 'public'].includes(b.visibility)) throw new HttpError(400, 'visibility must be private or public'); n.visibility = b.visibility; }
    if (b.dm !== undefined) { if (!['none', 'followers', 'everyone'].includes(b.dm)) throw new HttpError(400, 'dm must be none, followers or everyone'); n.dm = b.dm; }
    if (b.showStats !== undefined) n.showStats = b.showStats === true;
    if (b.stats !== undefined) { const s = b.stats || {}; n.stats = b.stats === null ? null : { km: Math.max(0, Math.min(9e6, Math.round(+s.km || 0))), rides: Math.max(0, Math.min(1e6, Math.round(+s.rides || 0))) }; }
    await this.kv.set('cprof', user.id, n);
    if (p.visibility === 'private' && n.visibility === 'public' && this.acceptAllPending) await this.acceptAllPending(user.id); // going public: pending follow requests become followers
    return { profile: this.selfView(n) }; }
  async relation(viewerId, target) {
    const out = { self: viewerId === target.id, following: 'none', followedBy: false };
    if (out.self) return out; const f = await this.kv.get('cfollow', viewerId + ':' + target.id); if (f) out.following = f.state; const g = await this.kv.get('cfollow', target.id + ':' + viewerId); out.followedBy = !!g && g.state === 'ok'; return out; }
  // Profile as seen by `viewer`. Private profiles show handle, name and avatar only until a follow is accepted. Blocked either way = 404 (indistinguishable from "no such rider").
  async profileView(viewer, handle) {
    const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'rider not found'); if (viewer.id !== t.id && await this.isBlocked(viewer.id, t.id)) throw new HttpError(404, 'rider not found');
    const rel = await this.relation(viewer.id, t), full = rel.self || t.visibility === 'public' || rel.following === 'ok';
    const v = { handle: t.handle, name: t.name, avatar: t.avatar, visibility: t.visibility, relation: rel, dm: t.dm, canDm: rel.self ? false : await this.dmAllowedQuiet(viewer.id, t), joinedAt: t.createdAt, state: t.state === 'suspended' ? 'suspended' : 'ok' };
    if (full) { v.bio = t.bio; v.vehicle = t.vehicle; v.counts = t.counts; if (t.showStats && t.stats) v.stats = t.stats; } return { profile: v }; }
  async dmAllowedQuiet() { return false; }
  // ---- reports
  async targetInfo(kind, id) { // returns {owner, snap, state, newAcct} of reportable content, or null
    if (kind === 'profile') { const p = await this.profByHandle(id) || await this.prof(id); return p ? { id: p.id, owner: p.id, snap: { handle: p.handle, name: p.name, bio: p.bio }, key: p.id } : null; }
    return this.contentInfo ? this.contentInfo(kind, id) : null; }
  async report(user, b, ip) {
    const kind = String(b.kind || ''), reason = String(b.reason || ''); if (!KINDS.includes(kind)) throw new HttpError(400, 'unknown report kind'); if (!REASONS.includes(reason)) throw new HttpError(400, 'choose a reason'); this.rl('report', user.id, ip, user);
    const note = cleanText(b.note || '', 200, { label: 'note', links: true }); if (this.reportGuard) await this.reportGuard(user, kind, String(b.id || '')); const t = await this.targetInfo(kind, String(b.id || '')); if (!t) throw new HttpError(404, 'that content no longer exists');
    if (t.owner === user.id) throw new HttpError(400, 'you cannot report yourself; delete the content instead');
    const dedupe = kind + ':' + t.key + ':' + user.id; const id = this.tkey();
    if (!await this.kv.add('crept', dedupe, id)) return { ok: true, duplicate: true };
    await this.kv.set('crep', id, { id, kind, target: t.key, owner: t.owner, reporter: user.id, reason, note, snap: t.snap || null, at: this.now(), state: 'open' });
    await this.kv.set('creprr', user.id + ':' + id, 1); await this.kv.set('crepown', t.owner + ':' + id, 1);
    const n = (await this.kv.range('crept', { prefix: kind + ':' + t.key + ':', limit: 50 })).length, young = t.newAcct && t.hasImages;
    if (kind !== 'profile' && (n >= this.o.reportHide || (young && n >= 1)) && this.setState) await this.setState(kind, t.key, 'hidden', 'auto: ' + n + ' report(s)');
    return { ok: true, reports: undefined }; }
  // ---- admin (ADMIN_TOKEN). Disabled (404) unless the token is configured.
  adminAuth(req, ip) {
    const tok = this.adminToken(); if (!tok) throw new HttpError(404, 'not found'); if (this.lim.count('c:adminfail:' + ip, 600e3) >= 10) throw new HttpError(429, 'too many attempts');
    const h = String(req.headers.authorization || ''), given = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-admin-token'] || '');
    if (!given || !safeEq(given, tok)) { this.lim.hit('c:adminfail:' + ip, 10, 600e3); throw new HttpError(401, 'unauthorized'); } return true; }
  async adminReports(state = 'open', limit = 50) {
    const out = []; let after = null; while (out.length < limit) { const rows = await this.kv.range('crep', { limit: 100, after }); if (!rows.length) break; after = rows[rows.length - 1][0];
      for (const [id, r] of rows) { if (state !== 'all' && r.state !== state) continue; const cur = await this.targetInfo(r.kind, r.target).catch(() => null); const ow = await this.author(r.owner), rp = await this.author(r.reporter);
        out.push({ id, kind: r.kind, target: r.target, reason: r.reason, note: r.note, state: r.state, at: r.at, owner: ow.handle, ownerId: r.owner, reporter: rp.handle, content: cur ? cur.snap : r.snap, contentState: cur && cur.state, images: cur && cur.images || [], gone: !cur }); if (out.length >= limit) break; } }
    return { reports: out, open: undefined }; }
  async adminAction(b, ip) {
    const act = String(b.action || ''), kind = String(b.kind || ''), id = String(b.id || ''); let result = 'ok';
    if (act === 'suspend' || act === 'unsuspend') { const p = await this.profByHandle(id) || await this.prof(id); if (!p) throw new HttpError(404, 'rider not found'); p.state = act === 'suspend' ? 'suspended' : 'ok'; p.suspendReason = act === 'suspend' ? cleanText(b.reason || '', 100, { links: true }) : undefined; await this.kv.set('cprof', p.id, p); await this.modlog(act, 'profile', p.id); return { ok: true, handle: p.handle, state: p.state }; }
    if (!KINDS.includes(kind)) throw new HttpError(400, 'unknown kind'); const t = await this.targetInfo(kind, id);
    if (act === 'hide' || act === 'restore') { if (!t || !this.setState) throw new HttpError(404, 'not found'); await this.setState(kind, t.key, act === 'hide' ? 'hidden' : 'ok', 'admin'); }
    else if (act === 'remove') { if (t && this.removeContent) await this.removeContent(kind, t.key); }
    else if (act !== 'dismiss') throw new HttpError(400, 'unknown action');
    for (const [k, rid] of await this.kv.range('crept', { prefix: kind + ':' + (t ? t.key : id) + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { if (r.state === 'open') { r.state = act === 'dismiss' ? 'dismissed' : 'actioned'; r.action = act; } if (act === 'remove') { r.snap = null; r.note = ''; } await this.kv.set('crep', rid, r); } }
    await this.modlog(act, kind, t ? t.key : id); return { ok: true, result }; }
  async modlog(action, kind, target) { const d = new Date(this.now()); await this.kv.set('cmodlog', d.toISOString().slice(0, 7) + ':' + this.tkey(), { at: this.now(), action, kind, target }); }
  async adminUser(handle) { const p = await this.profByHandle(handle); if (!p) throw new HttpError(404, 'rider not found'); return { id: p.id, handle: p.handle, state: p.state, counts: p.counts, createdAt: p.createdAt, visibility: p.visibility, reportsAgainst: (await this.kv.range('crepown', { prefix: p.id + ':', limit: 200 })).length }; }
  async adminStats() { const n = async ns => (await this.kv.count(ns)); return { profiles: await n('cprof'), posts: await n('cpost'), comments: await n('ccmt'), clubs: await n('cclub'), openReports: (await this.adminReports('open', 1000)).reports.length }; }
  // ---- deletion cascade: everything this person created or holds, leaving only minimal report records
  async deleteUser(uid) {
    for (const f of this.cascades) await f(uid);
    for (const [k] of await this.kv.range('cblock', { prefix: uid + ':', limit: 5000 })) { await this.kv.del('cblock', k); await this.kv.del('cblockby', k.split(':')[1] + ':' + uid); }
    for (const [k] of await this.kv.range('cblockby', { prefix: uid + ':', limit: 5000 })) { await this.kv.del('cblockby', k); await this.kv.del('cblock', k.split(':')[1] + ':' + uid); }
    for (const [k] of await this.kv.range('creprr', { prefix: uid + ':', limit: 5000 })) { const rid = k.split(':')[1], r = await this.kv.get('crep', rid); if (r) await this.kv.del('crept', r.kind + ':' + r.target + ':' + uid); await this.kv.del('crep', rid); await this.kv.del('creprr', k); }
    for (const [k] of await this.kv.range('crepown', { prefix: uid + ':', limit: 5000 })) { const rid = k.split(':')[1], r = await this.kv.get('crep', rid); if (r) { r.snap = null; r.note = ''; r.owner = 'deleted'; r.ownerDeleted = true; await this.kv.set('crep', rid, r); } await this.kv.del('crepown', k); }
    const p = await this.prof(uid); if (p) { await this.kv.del('chandle', p.handle); await this.kv.del('cprof', uid); } return { ok: true }; }
  async exportUser(uid) { const p = await this.prof(uid); if (!p) return { profile: null }; const out = { profile: this.selfView(p), blocked: (await this.blockList({ id: uid })).blocked };
    if (this.exportParts) Object.assign(out, await this.exportParts(uid)); return out; }
}
function normHandleLoose(h) { return String(h ?? '').trim().toLowerCase().replace(/^@/, '').slice(0, 30); }
module.exports = { Community, cleanText, needsHold, normHandle, RULES_VERSION, REASONS, KINDS, AVATARS, L0, BAD_RE };
