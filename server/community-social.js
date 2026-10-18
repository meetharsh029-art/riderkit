'use strict';
// Stage 3: follow (with requests for private profiles), likes. Stage 4 adds comments in the same file.
const { HttpError } = require('./groups');
const { Community, cleanText, needsHold } = require('./community');
const P = Community.prototype;

// ---- follow graph: cfollow:<a>:<b> = {state, at} (a follows b); cfollowr:<b>:<a> = state (reverse index for follower lists)
P.bump = async function (uid, field, d) { await this.lock('prof:' + uid, async () => { const p = await this.prof(uid); if (!p) return; p.counts[field] = Math.max(0, (p.counts[field] || 0) + d); await this.kv.set('cprof', uid, p); }); };
P.setEdge = async function (a, b, state) { await this.kv.set('cfollow', a + ':' + b, { state, at: this.now() }); await this.kv.set('cfollowr', b + ':' + a, state); };
P.dropEdge = async function (a, b) { const e = await this.kv.get('cfollow', a + ':' + b); if (!e) return false; await this.kv.del('cfollow', a + ':' + b); await this.kv.del('cfollowr', b + ':' + a);
  if (e.state === 'ok') { await this.bump(a, 'following', -1); await this.bump(b, 'followers', -1); } return true; };
P.removeFollowEdges = async function (a, b) { return this.dropEdge(a, b); };
P.follow = async function (me, handle, ip, user) {
  this.canWrite(me); this.rl('follow', me.id, ip, user); this.rl('followDay', me.id, null, user); const t = await this.profByHandle(handle); if (!t || t.id === me.id || await this.isBlocked(me.id, t.id)) throw new HttpError(404, 'rider not found');
  if (t.state === 'suspended') throw new HttpError(404, 'rider not found'); const cur = await this.kv.get('cfollow', me.id + ':' + t.id); if (cur) return { state: cur.state };
  if ((await this.kv.range('cfollow', { prefix: me.id + ':', limit: this.o.maxFollowing + 1 })).length >= this.o.maxFollowing) throw new HttpError(400, 'you are following the maximum number of riders');
  const state = t.visibility === 'public' ? 'ok' : 'pending'; await this.setEdge(me.id, t.id, state); if (state === 'ok') { await this.bump(me.id, 'following', 1); await this.bump(t.id, 'followers', 1); } return { state }; };
P.unfollow = async function (me, handle) { const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'rider not found'); await this.dropEdge(me.id, t.id); return { state: 'none' }; };
P.requests = async function (me) { const out = []; for (const [k, st] of await this.kv.range('cfollowr', { prefix: me.id + ':', limit: 500 })) if (st === 'pending') { const a = await this.author(k.split(':')[1]); out.push({ handle: a.handle, name: a.name, avatar: a.avatar }); } return { requests: out }; };
P.respond = async function (me, handle, accept) { const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'rider not found'); const e = await this.kv.get('cfollow', t.id + ':' + me.id); if (!e || e.state !== 'pending') throw new HttpError(404, 'no such request');
  if (accept === true && !await this.isBlocked(me.id, t.id)) { await this.setEdge(t.id, me.id, 'ok'); await this.bump(t.id, 'following', 1); await this.bump(me.id, 'followers', 1); return { state: 'ok' }; } await this.kv.del('cfollow', t.id + ':' + me.id); await this.kv.del('cfollowr', me.id + ':' + t.id); return { state: 'declined' }; };
P.removeFollower = async function (me, handle) { const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'rider not found'); await this.dropEdge(t.id, me.id); return { ok: true }; };
P.acceptAllPending = async function (uid) { for (const [k, st] of await this.kv.range('cfollowr', { prefix: uid + ':', limit: 5000 })) if (st === 'pending') { const a = k.split(':')[1]; if (await this.isBlocked(a, uid)) continue; await this.setEdge(a, uid, 'ok'); await this.bump(a, 'following', 1); await this.bump(uid, 'followers', 1); } };
P.people = async function (viewer, handle, dir, cursor, limit = 30) {
  const t = await this.profByHandle(handle); if (!t || (t.id !== viewer.id && await this.isBlocked(viewer.id, t.id))) throw new HttpError(404, 'rider not found'); const rel = await this.relation(viewer.id, t);
  if (!(rel.self || t.visibility === 'public' || rel.following === 'ok')) throw new HttpError(403, 'this profile is private'); const ns = dir === 'followers' ? 'cfollowr' : 'cfollow', blocked = await this.blockedSet(viewer.id), out = []; let after = cursor || null, next = null;
  const rows = await this.kv.range(ns, { prefix: t.id + ':', after, limit: Math.min(+limit || 30, 50) + 1 }); const lim = Math.min(+limit || 30, 50);
  for (const [k, v] of rows.slice(0, lim)) { const id = k.split(':')[1], st = ns === 'cfollowr' ? v : v.state; after = k; if (st !== 'ok' || blocked.has(id)) continue; const a = await this.author(id); out.push({ handle: a.handle, name: a.name, avatar: a.avatar }); } if (rows.length > lim) next = after;
  return { people: out, next }; };
// ---- likes (idempotent): clike:<post>:<uid>, reverse clikeu:<uid>:<post>; counter lives on the post and is serialised per post
P.like = async function (user, prof, postId, on, ip) {
  this.canWrite(prof); this.rl('like', user.id, ip, user); const post = await this.getPost(user.id, postId); let changed = false;
  if (on) { changed = await this.kv.add('clike', post.id + ':' + user.id, { at: this.now() }); if (changed) await this.kv.set('clikeu', user.id + ':' + post.id, 1); } else { changed = await this.kv.del('clike', post.id + ':' + user.id); if (changed) await this.kv.del('clikeu', user.id + ':' + post.id); }
  if (changed) await this.lock('post:' + post.id, async () => { const p = await this.kv.get('cpost', post.id); if (p) { p.likes = Math.max(0, (p.likes || 0) + (on ? 1 : -1)); await this.kv.set('cpost', post.id, p); post.likes = p.likes; } });
  else { const p = await this.kv.get('cpost', post.id); post.likes = p ? p.likes : post.likes; } return { liked: !!on, likes: post.likes || 0 }; };
P.recountLikes = async function (postId) { const n = await this.kv.count('clike', postId + ':'); const p = await this.kv.get('cpost', postId); if (p) { p.likes = n; await this.kv.set('cpost', postId, p); } return n; };
// ---- cascade: remove every edge and like of a deleted account, fixing the other side's counters
P._init = (old => function () { old && old.call(this);
  this.cascades.push(async uid => {
    for (const [k] of await this.kv.range('cfollow', { prefix: uid + ':', limit: 50000 })) await this.dropEdge(uid, k.split(':')[1]);
    for (const [k] of await this.kv.range('cfollowr', { prefix: uid + ':', limit: 50000 })) await this.dropEdge(k.split(':')[1], uid);
    for (const [k] of await this.kv.range('clikeu', { prefix: uid + ':', limit: 50000 })) { const pid = k.split(':')[1]; await this.kv.del('clikeu', k); if (await this.kv.del('clike', pid + ':' + uid)) await this.lock('post:' + pid, async () => { const p = await this.kv.get('cpost', pid); if (p) { p.likes = Math.max(0, (p.likes || 0) - 1); await this.kv.set('cpost', pid, p); } }); } });
  this.routes.push((req, res, url, parts, mm, io) => this.socialRoutes(req, res, url, parts, mm, io)); })(P._init);
const baseExport = P.exportParts; P.exportParts = async function (uid) { const base = baseExport ? await baseExport.call(this, uid) : {}; const names = async (ns, uidIdx) => { const o = []; for (const [k] of await this.kv.range(ns, { prefix: uid + ':', limit: 5000 })) o.push((await this.author(k.split(':')[1])).handle); return o; };
  const likes = (await this.kv.range('clikeu', { prefix: uid + ':', limit: 5000 })).length; return Object.assign(base, { following: await names('cfollow'), followers: await names('cfollowr'), likesGiven: likes }); };
P.socialRoutes = async function (req, res, url, parts, mm, { body, json }) {
  const [a, b, c] = parts, q = url.searchParams, GET = req.method === 'GET', POST = req.method === 'POST', { user, prof, ip } = mm;
  if (POST && a === 'follow' && !b) return json(res, 200, await this.follow(prof, (await body(req, 512)).handle, ip, user));
  if (POST && a === 'unfollow') return json(res, 200, await this.unfollow(prof, (await body(req, 512)).handle));
  if (GET && a === 'follow' && b === 'requests') return json(res, 200, await this.requests(prof));
  if (POST && a === 'follow' && b === 'respond') { const x = await body(req, 512); return json(res, 200, await this.respond(prof, x.handle, x.accept === true)); }
  if (POST && a === 'follow' && b === 'remove') return json(res, 200, await this.removeFollower(prof, (await body(req, 512)).handle));
  if (GET && (a === 'followers' || a === 'following')) return json(res, 200, await this.people(user, q.get('handle') || prof.handle, a, q.get('before'), q.get('limit')));
  if (POST && a === 'posts' && b && c === 'like') { const x = await body(req, 256); return json(res, 200, await this.like(user, prof, b, x.on !== false, ip)); }
  return undefined; };
