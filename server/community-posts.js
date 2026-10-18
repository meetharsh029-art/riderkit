'use strict';
// Stage 2: image upload (validated, metadata-stripped, stored via the swappable image store) and feed posts (ride recap card + optional photos).
const crypto = require('crypto');
const { HttpError } = require('./groups');
const { Community, cleanText, needsHold } = require('./community');
const { sanitizeImage, makeImageStore } = require('./imgstore');
const FORBIDDEN_KEY = /^(lat|lng|lon|long|latitude|longitude|points?|coords?|coordinates|location|gps|route|path|polyline|geometry|position|waypoints?|home|address)$/i;
function noLocations(o, depth = 0) { if (depth > 4) throw new HttpError(400, 'post is too deeply nested'); if (Array.isArray(o)) return o.forEach(x => noLocations(x, depth + 1)); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN_KEY.test(k)) throw new HttpError(400, 'posts cannot contain locations or GPS points'); noLocations(v, depth + 1); } }
const P = Community.prototype;

P.attachImages = function (store, env) { this.images = store === undefined ? makeImageStore(env || process.env) : store; this.imgMax = +(env || process.env).IMAGE_MAX_BYTES || 1e6; };
P.needImages = function () { if (!this.images) throw new HttpError(503, 'photo uploads are not available on this server yet'); return this.images; };
P.sign = async function (id, exp) { return crypto.createHmac('sha256', await this.accounts.secret()).update('img\0' + id + '\0' + exp).digest('hex').slice(0, 32); };
P.imgUrl = async function (id) { const e = this.now() + this.o.imgUrlTtlMs; return '/api/community/img/' + id + '?e=' + e + '&s=' + await this.sign(id, e); };
P.serveImage = async function (req, res, id, e, s) {
  const nf = () => { res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('not found'); };
  if (!/^[a-f0-9]{32}$/.test(String(id)) || !/^\d{10,16}$/.test(String(e)) || +e < this.now() || !s || !await this.sign(id, e).then(x => require('./feedback').safeEq(x, String(s)))) return nf();
  return this.sendImage(res, id, 'private, max-age=3600', nf); };
P.sendImage = async function (res, id, cache, nf) {
  const im = await this.kv.get('cimg', id); if (!im || im.state !== 'ok' || !this.images) return nf(); const o = await this.images.get(im.key).catch(e => { console.error('image store:', e.message); return null; }); if (!o) return nf();
  res.writeHead(200, { 'content-type': im.mime, 'content-length': o.buf.length, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'cross-origin', 'referrer-policy': 'no-referrer' }); res.end(o.buf); };
P.adminImage = async function (res, id) { const nf = () => { res.writeHead(404); res.end(); }; if (!/^[a-f0-9]{32}$/.test(String(id))) return nf(); const im = await this.kv.get('cimg', id); if (!im) return nf(); // admins can also see hidden images
  const o = this.images && await this.images.get(im.key).catch(() => null); if (!o) return nf(); res.writeHead(200, { 'content-type': im.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }); res.end(o.buf); };
P.upload = async function (user, prof, buf, declared, kind, ip) {
  this.canWrite(prof); const store = this.needImages(); if (!['photo', 'card'].includes(kind)) throw new HttpError(400, 'kind must be photo or card');
  const im = sanitizeImage(buf, declared, { maxBytes: this.imgMax || 1e6 }); this.rl('upload', user.id, ip, user); const mine = await this.kv.range('cimgu', { prefix: user.id + ':', limit: 1000 });
  const used = mine.reduce((s, [, v]) => s + (v.size || 0), 0); if (used + im.buf.length > this.o.quotaBytes) throw new HttpError(413, 'photo storage limit reached (' + Math.round(this.o.quotaBytes / 1e6) + ' MB); delete some posts first'); if (mine.length >= 400) throw new HttpError(413, 'too many stored images');
  const id = this.rand(16), key = 'i/' + id.slice(0, 2) + '/' + id + '.' + im.ext; try { await store.put(key, im.buf, im.mime); } catch (e) { console.error('image store put failed:', e.message); throw new HttpError(503, 'photo storage is temporarily unavailable, try again later'); }
  const rec = { id, key, owner: user.id, mime: im.mime, size: im.buf.length, w: im.w, h: im.h, kind, at: this.now(), post: null, state: 'ok' };
  await this.kv.set('cimg', id, rec); await this.kv.set('cimgu', user.id + ':' + id, { size: rec.size }); await this.kv.set('cimgp', String(this.now()).padStart(13, '0') + ':' + id, 1); this.sweepSoon();
  return { id, w: im.w, h: im.h, size: rec.size, mime: im.mime, url: await this.imgUrl(id) }; };
P.sweepSoon = function () { if (this._sw) return; this._sw = true; setTimeout(() => { this._sw = false; this.sweepImages().catch(() => {}); }, 0).unref?.(); };
P.dropImage = async function (id) { const im = await this.kv.get('cimg', id); if (!im) return; try { if (this.images) await this.images.del(im.key); } catch (e) { console.error('image delete failed:', e.message); } await this.kv.del('cimg', id); await this.kv.del('cimgu', im.owner + ':' + id); };
P.sweepImages = async function () { const cutoff = String(this.now() - this.o.uploadTtlMs).padStart(13, '0'); let n = 0; for (const [k] of await this.kv.range('cimgp', { limit: 200 })) { if (k.slice(0, 13) > cutoff) break; const id = k.split(':')[1], im = await this.kv.get('cimg', id); if (im && !im.post) { await this.dropImage(id); n++; } if (!im || im.post) { /* attached or gone */ } await this.kv.del('cimgp', k); } return n; };

// ---- posts
P.effVis = function (post, author) { return post.vis === 'public' && author && author.visibility !== 'public' ? 'followers' : post.vis; };
P.canView = async function (viewerId, post, cache = {}) {
  if (post.author === viewerId) return true; if (post.state !== 'ok') return false; if (cache.blocked ? cache.blocked.has(post.author) : await this.isBlocked(viewerId, post.author)) return false;
  const au = (cache.au && cache.au[post.author]) || (await this.prof(post.author)); if (!au || au.state === 'suspended') return false; if (cache.au) cache.au[post.author] = au; const v = this.effVis(post, au);
  if (v === 'public') return true; if (v === 'club') return this.isClubMember ? await this.isClubMember(viewerId, post.club) : false;
  const f = cache.follow ? cache.follow.get(post.author) : (await this.kv.get('cfollow', viewerId + ':' + post.author)); const st = cache.follow ? f : f && f.state; return st === 'ok'; };
P.postView = async function (viewerId, post, cache = {}) {
  const a = await this.author(post.author), imgs = {}; if (post.card) imgs.card = await this.imgUrl(post.card); imgs.photos = []; for (const id of post.photos || []) imgs.photos.push(await this.imgUrl(id));
  const liked = !!(await this.kv.get('clike', post.id + ':' + viewerId)); const v = { id: post.id, author: { handle: a.handle, name: a.name, avatar: a.avatar }, caption: post.caption, stats: post.stats, vis: post.vis, club: post.club || null, images: imgs, likes: post.likes || 0, comments: post.comments || 0, liked, mine: post.author === viewerId, at: post.at };
  if (post.author === viewerId && post.state !== 'ok') v.state = post.state; return v; };
function cleanStats(s) { if (s == null) return null; if (typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'bad ride summary'); const o = {}, km = +s.km, dur = +s.dur;
  if (s.km !== undefined) { if (!(km >= 0 && km < 20000)) throw new HttpError(400, 'bad distance'); o.km = Math.round(km * 10) / 10; } if (s.dur !== undefined) { if (!(dur >= 0 && dur < 24 * 60 * 14)) throw new HttpError(400, 'bad duration'); o.dur = Math.round(dur); }
  if (s.date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) throw new HttpError(400, 'bad date'); o.date = s.date; } if (s.vehicle !== undefined) o.vehicle = cleanText(s.vehicle, 40, { label: 'vehicle' }); return o; }
P.createPost = async function (user, prof, b, ip) {
  this.canWrite(prof); noLocations(b); const caption = cleanText(b.caption || '', 500, { multiline: true, label: 'the caption' }), stats = cleanStats(b.stats);
  const photos = Array.isArray(b.photos) ? b.photos.map(String) : []; if (b.photos !== undefined && !Array.isArray(b.photos)) throw new HttpError(400, 'photos must be a list'); if (photos.length > this.o.maxPostPhotos) throw new HttpError(400, 'up to ' + this.o.maxPostPhotos + ' photos per post'); if (new Set(photos).size !== photos.length) throw new HttpError(400, 'duplicate photo');
  const card = b.card ? String(b.card) : null; if (!card && !photos.length && !caption) throw new HttpError(400, 'add a caption, a ride card or a photo');
  const vis = b.vis || (prof.visibility === 'public' ? 'public' : 'followers'); if (!['public', 'followers', 'club'].includes(vis)) throw new HttpError(400, 'visibility must be public, followers or club');
  if (vis === 'public' && prof.visibility !== 'public') throw new HttpError(400, 'make your profile public first, or post to followers only');
  if (vis === 'public' && (card || photos.length) && this.now() - (user.createdAt || 0) < this.o.newAccountMs) throw new HttpError(403, 'new accounts can post pictures to followers only during their first day');
  let club = null; if (vis === 'club') { club = String(b.club || ''); if (!this.isClubMember || !await this.isClubMember(user.id, club)) throw new HttpError(403, 'you are not a member of that club'); }
  const ims = []; for (const id of [card, ...photos].filter(Boolean)) { const im = await this.kv.get('cimg', id); if (!im || im.owner !== user.id || im.post) throw new HttpError(400, 'unknown or already used image'); if ((id === card) !== (im.kind === 'card')) throw new HttpError(400, 'image is the wrong kind'); ims.push(im); }
  this.rl('post', user.id, ip, user); const id = this.tkey(), held = needsHold(caption), post = { id, author: user.id, caption, stats, vis, club, card, photos, likes: 0, comments: 0, at: this.now(), state: held ? 'held' : 'ok' };
  await this.kv.set('cpost', id, post); await this.kv.set('cupost', user.id + ':' + id, 1); if (club) await this.kv.set('cclubpost', club + ':' + id, 1);
  for (const im of ims) { im.post = id; await this.kv.set('cimg', im.id, im); } await this.lock('prof:' + user.id, async () => { const p = await this.prof(user.id); if (p) { p.counts.posts++; await this.kv.set('cprof', user.id, p); } });
  if (held) await this.autoFlag('post', id, user.id, 'held for review: spam/abuse words', { caption });
  return { post: await this.postView(user.id, post), held }; };
P.autoFlag = async function (kind, key, owner, note, snap) { const id = this.tkey(); await this.kv.set('crep', id, { id, kind, target: key, owner, reporter: 'system', reason: 'other', note, snap, at: this.now(), state: 'open' }); await this.kv.set('crepown', owner + ':' + id, 1); await this.kv.set('crept', kind + ':' + key + ':system', id); };
P.getPost = async function (viewerId, id, any) { const post = await this.kv.get('cpost', String(id)); if (!post || !(any || await this.canView(viewerId, post))) throw new HttpError(404, 'post not found'); return post; };
P.deletePost = async function (post) {
  for (const id of [post.card, ...(post.photos || [])].filter(Boolean)) await this.dropImage(id);
  for (const [k] of await this.kv.range('ccmt', { prefix: post.id + ':', limit: 5000 })) await this.kv.del('ccmt', k); for (const [k] of await this.kv.range('clike', { prefix: post.id + ':', limit: 20000 })) { await this.kv.del('clike', k); await this.kv.del('clikeu', k.split(':')[1] + ':' + post.id); }
  for (const [k, rid] of await this.kv.range('crept', { prefix: 'post:' + post.id + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { if (r.state === 'open') { r.state = 'actioned'; r.action = 'removed'; } r.snap = null; r.note = ''; await this.kv.set('crep', rid, r); } } 
  await this.kv.del('cpost', post.id); await this.kv.del('cupost', post.author + ':' + post.id); if (post.club) await this.kv.del('cclubpost', post.club + ':' + post.id);
  await this.lock('prof:' + post.author, async () => { const p = await this.prof(post.author); if (p && p.counts.posts > 0) { p.counts.posts--; await this.kv.set('cprof', post.author, p); } }); };
P.removeOwnPost = async function (user, id) { const post = await this.kv.get('cpost', String(id)); if (!post || post.author !== user.id) throw new HttpError(404, 'post not found'); await this.deletePost(post); return { ok: true }; };
// feed scopes: global (public posts of public profiles + my own), following (people I follow + me), club, user. Pages by scanning the newest-first index in bounded batches.
P.feed = async function (viewer, { scope = 'global', cursor = null, limit = 20, club = null, handle = null } = {}) {
  limit = Math.max(1, Math.min(50, +limit || 20)); const cache = { blocked: await this.blockedSet(viewer.id), au: {}, follow: new Map() }, out = []; let after = cursor || null, scanned = 0, done = false, prefix = '';
  if (scope === 'following') { for (const [k, v] of await this.kv.range('cfollow', { prefix: viewer.id + ':', limit: this.o.maxFollowing + 1 })) if (v.state === 'ok') cache.follow.set(k.split(':')[1], v.state); }
  let ns = 'cpost', userId = null; if (scope === 'club') { if (!this.isClubMember || !await this.isClubMember(viewer.id, club)) throw new HttpError(403, 'join the club to see its posts'); ns = 'cclubpost'; prefix = club + ':'; }
  if (scope === 'user') { const t = await this.profByHandle(handle); if (!t || (t.id !== viewer.id && cache.blocked.has(t.id))) throw new HttpError(404, 'rider not found'); userId = t.id; ns = 'cupost'; prefix = t.id + ':'; if (t.id !== viewer.id) { const f = await this.kv.get('cfollow', viewer.id + ':' + t.id); cache.follow.set(t.id, f && f.state); } }
  let exhausted = false;
  while (out.length < limit && scanned < 500) {
    const rows = await this.kv.range(ns, { prefix, after, limit: 100 }); if (!rows.length) { exhausted = true; break; } let broke = false;
    for (const [k, val] of rows) { after = k; scanned++; const pid = ns === 'cpost' ? k : k.slice(prefix.length), post = ns === 'cpost' ? val : await this.kv.get('cpost', pid); if (!post) continue;
      if (scope === 'global' && (post.vis === 'club' || post.author !== viewer.id && (post.vis !== 'public' || post.state !== 'ok'))) continue;
      if (scope === 'following' && post.author !== viewer.id && !cache.follow.has(post.author)) continue;
      if (!await this.canView(viewer.id, post, cache)) continue; out.push(await this.postView(viewer.id, post, cache)); if (out.length >= limit) { broke = true; break; } }
    if (!broke && rows.length < 100) { exhausted = true; break; } }
  return { posts: out, next: exhausted ? null : after }; };
// ---- admin / report plumbing for posts
const baseInfo = P.contentInfo;
P.contentInfo = async function (kind, id) {
  if (kind === 'post') { const p = await this.kv.get('cpost', id); if (!p) return null; const au = await this.prof(p.author); const imgs = [p.card, ...(p.photos || [])].filter(Boolean);
    return { id, key: id, owner: p.author, state: p.state, newAcct: !!au && this.now() - au.createdAt < this.o.newAcctDays * 864e5, hasImages: imgs.length > 0, images: imgs, snap: { caption: p.caption, stats: p.stats, vis: p.vis, by: au && au.handle } }; }
  return baseInfo ? baseInfo.call(this, kind, id) : null; };
const baseSet = P.setState; P.setState = async function (kind, key, state, why) {
  if (kind === 'post') { const p = await this.kv.get('cpost', key); if (!p) return; p.state = state; p.stateWhy = why; await this.kv.set('cpost', key, p); for (const id of [p.card, ...(p.photos || [])].filter(Boolean)) { const im = await this.kv.get('cimg', id); if (im) { im.state = state === 'ok' ? 'ok' : 'hidden'; await this.kv.set('cimg', id, im); } } return; }
  return baseSet ? baseSet.call(this, kind, key, state, why) : undefined; };
const baseRm = P.removeContent; P.removeContent = async function (kind, key) { if (kind === 'post') { const p = await this.kv.get('cpost', key); if (p) await this.deletePost(p); return; } return baseRm ? baseRm.call(this, kind, key) : undefined; };
// deletion cascade + export
P._init = (old => function () { old && old.call(this);
  this.cascades.push(async uid => { for (const [k] of await this.kv.range('cupost', { prefix: uid + ':', limit: 50000 })) { const p = await this.kv.get('cpost', k.split(':')[1]); if (p) await this.deletePost(p); await this.kv.del('cupost', k); }
    for (const [k] of await this.kv.range('cimgu', { prefix: uid + ':', limit: 50000 })) await this.dropImage(k.split(':')[1]); });
  this.routes.push((req, res, url, parts, mm, io) => this.postRoutes(req, res, url, parts, mm, io)); })(P._init);
const baseExport = P.exportParts; P.exportParts = async function (uid) { const base = baseExport ? await baseExport.call(this, uid) : {}; const posts = []; for (const [k] of await this.kv.range('cupost', { prefix: uid + ':', limit: 5000 })) { const p = await this.kv.get('cpost', k.split(':')[1]); if (p) posts.push({ id: p.id, caption: p.caption, stats: p.stats, vis: p.vis, at: p.at, likes: p.likes, comments: p.comments, images: [p.card, ...(p.photos || [])].filter(Boolean).length }); } return Object.assign(base, { posts }); };
P.postRoutes = async function (req, res, url, parts, mm, { body, rawBody, json }) {
  const [a, b, c] = parts, q = url.searchParams, GET = req.method === 'GET', POST = req.method === 'POST', { user, prof, ip } = mm;
  if (POST && a === 'upload') { this.canWrite(prof); this.needImages(); const ct = String(req.headers['content-type'] || ''); const buf = await rawBody(req, (this.imgMax || 1e6) + 1024).catch(e => { throw e.status === 413 ? new HttpError(413, 'image too large (max ' + Math.round((this.imgMax || 1e6) / 1000) + ' KB after the app shrinks it)') : e; }); return json(res, 201, await this.upload(user, prof, buf, ct, q.get('kind') || 'photo', ip)); }
  if (POST && a === 'posts' && !b) return json(res, 201, await this.createPost(user, prof, await body(req, 4096), ip));
  if (GET && a === 'posts' && b) return json(res, 200, { post: await this.postView(user.id, await this.getPost(user.id, b)) });
  if (POST && a === 'posts' && b && c === 'delete') { return json(res, 200, await this.removeOwnPost(user, b)); }
  if (GET && a === 'feed') return json(res, 200, await this.feed(user, { scope: q.get('scope') || 'global', cursor: q.get('before'), limit: q.get('limit'), club: q.get('club'), handle: q.get('handle') }));
  return undefined; };
module.exports = { noLocations, cleanStats };
