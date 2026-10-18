'use strict';
// Stage 4: flat comments. ccmt:<post>:<akey> = {id, post, author, text, at, state}; ccmtu:<uid>:<post>:<akey> = 1 (author index for the deletion cascade).
// post.comments counts only state 'ok' comments. States: ok | held (spam words; author + admin only) | hidden (3 reports or admin).
const { HttpError } = require('./groups');
const { Community, cleanText, needsHold } = require('./community');
const P = Community.prototype; const CAP = 200;
P.cmtKey = function (postId, id) { return postId + ':' + id; };
P.bumpComments = async function (postId, d) { await this.lock('post:' + postId, async () => { const p = await this.kv.get('cpost', postId); if (p) { p.comments = Math.max(0, (p.comments || 0) + d); await this.kv.set('cpost', postId, p); } }); };
P.addComment = async function (user, prof, postId, b, ip) {
  this.canWrite(prof); const post = await this.getPost(user.id, postId); const text = cleanText(b.text, 300, { required: true, label: 'the comment' });
  if ((post.comments || 0) >= CAP) throw new HttpError(400, 'this post has reached its comment limit');
  this.rl('comment', user.id, ip, user); const id = this.akey(), held = needsHold(text), c = { id, post: post.id, author: user.id, text, at: this.now(), state: held ? 'held' : 'ok' }, key = post.id + ':' + id;
  await this.kv.set('ccmt', key, c); await this.kv.set('ccmtu', user.id + ':' + key, 1); if (held) await this.autoFlag('comment', key, user.id, 'held for review: spam/abuse words', { text }); else await this.bumpComments(post.id, 1);
  return { comment: await this.commentView(user.id, post, c), held }; };
P.commentView = async function (viewerId, post, c, cache = {}) { const a = await this.author(c.author); const v = { id: c.id, text: c.text, at: c.at, author: { handle: a.handle, name: a.name, avatar: a.avatar }, mine: c.author === viewerId, canDelete: c.author === viewerId || post.author === viewerId }; if (c.author === viewerId && c.state !== 'ok') v.state = c.state; return v; };
P.listComments = async function (user, postId, after, limit) {
  const post = await this.getPost(user.id, postId), blocked = await this.blockedSet(user.id), lim = Math.min(Math.max(+limit || 50, 1), 100), out = []; let cur = after ? String(after) : null, next = null;
  while (out.length < lim) { const rows = await this.kv.range('ccmt', { prefix: post.id + ':', after: cur ? post.id + ':' + cur : null, limit: 100 }); if (!rows.length) break;
    for (const [k, c] of rows) { cur = c.id; if (blocked.has(c.author) && c.author !== user.id) continue; if (c.state !== 'ok' && c.author !== user.id) continue; if (out.length >= lim) { next = out[out.length - 1].id; break; } out.push(await this.commentView(user.id, post, c)); }
    if (next || rows.length < 100) break; }
  if (!next && out.length >= lim) { const more = await this.kv.range('ccmt', { prefix: post.id + ':', after: post.id + ':' + out[out.length - 1].id, limit: 1 }); if (more.length) next = out[out.length - 1].id; }
  return { comments: out, next }; };
P.dropComment = async function (key) { const c = await this.kv.get('ccmt', key); if (!c) return false; await this.kv.del('ccmt', key); await this.kv.del('ccmtu', c.author + ':' + key); if (c.state === 'ok') await this.bumpComments(c.post, -1);
  for (const [, rid] of await this.kv.range('crept', { prefix: 'comment:' + key + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { if (r.state === 'open') { r.state = 'actioned'; r.action = 'removed'; } r.snap = null; r.note = ''; await this.kv.set('crep', rid, r); } } return true; };
P.deleteComment = async function (user, postId, id) { const post = await this.kv.get('cpost', String(postId)), key = String(postId) + ':' + String(id), c = await this.kv.get('ccmt', key);
  if (!post || !c || !(c.author === user.id || post.author === user.id)) throw new HttpError(404, 'comment not found'); if (c.author !== user.id && !await this.canView(user.id, post)) throw new HttpError(404, 'comment not found'); await this.dropComment(key); return { ok: true }; };
const baseInfo = P.contentInfo; P.contentInfo = async function (kind, id) {
  if (kind === 'comment') { const c = await this.kv.get('ccmt', id); if (!c) return null; const au = await this.prof(c.author); return { id, key: id, owner: c.author, state: c.state, newAcct: false, hasImages: false, images: [], snap: { text: c.text, by: au && au.handle, post: c.post } }; }
  return baseInfo ? baseInfo.call(this, kind, id) : null; };
const baseSet = P.setState; P.setState = async function (kind, key, state, why) {
  if (kind === 'comment') { const c = await this.kv.get('ccmt', key); if (!c) return; const was = c.state === 'ok', now = state === 'ok'; c.state = state; c.stateWhy = why; await this.kv.set('ccmt', key, c); if (was !== now) await this.bumpComments(c.post, now ? 1 : -1); return; }
  return baseSet ? baseSet.call(this, kind, key, state, why) : undefined; };
const baseRm = P.removeContent; P.removeContent = async function (kind, key) { if (kind === 'comment') { await this.dropComment(key); return; } return baseRm ? baseRm.call(this, kind, key) : undefined; };
P._init = (old => function () { old && old.call(this);
  this.cascades.push(async uid => { for (const [k] of await this.kv.range('ccmtu', { prefix: uid + ':', limit: 50000 })) { const key = k.slice(uid.length + 1); if (!await this.dropComment(key)) await this.kv.del('ccmtu', k); } });
  this.routes.push(async (req, res, url, parts, mm, { body, json }) => { const [a, b, c] = parts, q = url.searchParams, { user, prof, ip } = mm;
    if (a === 'posts' && b && c === 'comments') { if (req.method === 'GET') return json(res, 200, await this.listComments(user, b, q.get('after'), q.get('limit'))); if (req.method === 'POST') { const r = await this.addComment(user, prof, b, await body(req, 2048), ip); return json(res, 201, r); } }
    if (req.method === 'POST' && a === 'comments' && b && c === 'delete') return json(res, 200, await this.deleteComment(user, (await body(req, 512)).post, b));
    return undefined; }); })(P._init);
const baseExport = P.exportParts; P.exportParts = async function (uid) { const base = baseExport ? await baseExport.call(this, uid) : {}; const cs = []; for (const [k] of await this.kv.range('ccmtu', { prefix: uid + ':', limit: 5000 })) { const c = await this.kv.get('ccmt', k.slice(uid.length + 1)); if (c) cs.push({ text: c.text, at: c.at, state: c.state }); } return Object.assign(base, { comments: cs }); };
