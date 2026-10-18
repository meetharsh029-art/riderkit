'use strict';
// Stage 6: direct messages. A conversation is the sorted pair of user ids (cv = a~b).
// cdm:<cv>:<akey> {id,cv,from,text,at,state}; cdmu:<uid>:<cv>:<akey> author index; cconv:<cv> {a,b,n,sent:{uid:count},msgN};
// cdmc:<uid>:<peer> per-user index {cv,peer,last:{text,at,from},unread,muted,cleared} (also what the conversation list reads).
// Who may START a conversation: the recipient's setting prof.dm = none | followers (sender follows them, accepted) | everyone.
// Once the recipient has sent anything, they and the sender may always write to each other (until blocked). A cold sender gets 3 unanswered messages.
const { HttpError } = require('./groups');
const { Community, cleanText, needsHold } = require('./community');
const P = Community.prototype; const COLD_MAX = 3;
const cvOf = (a, b) => [a, b].sort().join('~');
P.dmConv = async function (a, b) { return this.kv.get('cconv', cvOf(a, b)); };
P.dmAllowedQuiet = async function (viewerId, t) { if (!t || t.state === 'suspended' || t.id === viewerId) return false; const cv = await this.dmConv(viewerId, t.id); if (cv && (cv.sent[t.id] || 0) > 0) return true; return this.policyAllows(viewerId, t); };
P.dmPeer = async function (me, handle) { const t = await this.profByHandle(handle); if (!t || t.id === me.id || await this.isBlocked(me.id, t.id)) throw new HttpError(404, 'rider not found'); return t; };
P.dmIsRequest = async function (me, peer, idx) { if (idx && idx.accepted) return false; const c = await this.kv.get('cconv', cvOf(me, peer)); if (!c || !(c.sent[peer] || 0) || (c.sent[me] || 0)) return false; const f = await this.kv.get('cfollow', me + ':' + peer); return !(f && f.state === 'ok'); };
P.dmView = async function (viewerId, m) { const a = await this.author(m.from); return { id: m.id, rid: m.cv + ':' + m.id, text: m.text, at: m.at, mine: m.from === viewerId, from: a.handle }; };
P.sendDm = async function (user, prof, handle, b, ip) {
  this.canWrite(prof); const t = await this.dmPeer(prof, handle); if (t.state === 'suspended') throw new HttpError(404, 'rider not found'); const text = cleanText(b.text, 400, { required: true, label: 'the message' }); if (needsHold(text)) throw new HttpError(400, 'that message is not allowed');
  const key = cvOf(user.id, t.id); const existing = await this.kv.get('cconv', key), theySent = existing ? (existing.sent[t.id] || 0) > 0 : false, mySent = existing ? (existing.sent[user.id] || 0) : 0;
  if (!theySent && !await this.policyAllows(user.id, t)) throw new HttpError(403, t.dm === 'none' || !t.dm ? 'this rider is not accepting messages' : 'this rider only accepts messages from riders they know'); if (!theySent && mySent >= COLD_MAX) throw new HttpError(429, 'wait for a reply before sending more messages');
  if (!existing) this.rl('dmNew', user.id, ip, user); this.rl('dm', user.id, ip, user); const id = this.akey(), m = { id, cv: key, from: user.id, text, at: this.now(), state: 'ok' };
  const prune = await this.lock('dm:' + key, async () => { const c = (await this.kv.get('cconv', key)) || { a: user.id, b: t.id, sent: {}, msgN: 0 }; c.sent[user.id] = (c.sent[user.id] || 0) + 1; c.msgN++; const over = c.msgN > this.o.dmCap + 50; if (over) c.msgN = this.o.dmCap; await this.kv.set('cconv', key, c); await this.kv.set('cdm', key + ':' + id, m); await this.kv.set('cdmu', user.id + ':' + key + ':' + id, 1); return over; });
  if (prune) for (const [k, x] of await this.kv.range('cdm', { prefix: key + ':', limit: 50 })) { await this.kv.del('cdm', k); await this.kv.del('cdmu', x.from + ':' + k); }
  const last = { text: text.slice(0, 80), at: m.at, from: user.id };
  await this.lock('dmi:' + user.id + ':' + t.id, async () => { const i = (await this.kv.get('cdmc', user.id + ':' + t.id)) || { cv: key, peer: t.id, unread: 0, muted: false, cleared: null }; i.last = last; await this.kv.set('cdmc', user.id + ':' + t.id, i); });
  await this.lock('dmi:' + t.id + ':' + user.id, async () => { const i = (await this.kv.get('cdmc', t.id + ':' + user.id)) || { cv: key, peer: user.id, unread: 0, muted: false, cleared: null }; i.last = last; i.unread = Math.min(999, (i.unread || 0) + 1); await this.kv.set('cdmc', t.id + ':' + user.id, i); });
  const me = await this.author(user.id); await this.pushDm(user.id, { peer: t.handle, message: await this.dmView(user.id, m) }); await this.pushDm(t.id, { peer: me.handle, message: await this.dmView(t.id, m) }, user.id); return { message: await this.dmView(user.id, m) }; };
P.dmHistory = async function (user, handle, since, limit = 50) { const t = await this.dmPeer(user, handle); limit = Math.min(Math.max(+limit || 50, 1), 100); const key = cvOf(user.id, t.id), idx = await this.kv.get('cdmc', user.id + ':' + t.id); const floor = idx && idx.cleared; let rows;
  if (since) rows = await this.kv.range('cdm', { prefix: key + ':', after: key + ':' + (floor && floor > since ? floor : since), limit }); else rows = (await this.kv.range('cdm', { prefix: key + ':', desc: true, limit })).reverse(); const out = [];
  for (const [, m] of rows) { if (floor && m.id <= floor) continue; if (m.state !== 'ok' && m.from !== user.id) continue; out.push(await this.dmView(user.id, m)); } const rel = await this.dmAllowedQuiet(user.id, t);
  return { messages: out, last: rows.length ? rows[rows.length - 1][1].id : since || null, peer: { handle: t.handle, name: t.name, avatar: t.avatar, canMessage: rel, muted: !!(idx && idx.muted), request: await this.dmIsRequest(user.id, t.id, idx) } }; };
P.dmList = async function (user) { const out = []; let unread = 0; const rows = await this.kv.range('cdmc', { prefix: user.id + ':', limit: 200 }); const blocked = await this.blockedSet(user.id);
  for (const [k, i] of rows) { if (blocked.has(i.peer)) continue; const p = await this.prof(i.peer); if (!p) continue; if (i.cleared) { const probe = await this.kv.range('cdm', { prefix: i.cv + ':', after: i.cv + ':' + i.cleared, limit: 1 }); if (!probe.length) continue; }
    const cvv = await this.kv.get('cconv', i.cv), fol = await this.kv.get('cfollow', user.id + ':' + i.peer), request = !i.accepted && !!cvv && (cvv.sent[i.peer] || 0) > 0 && !(cvv.sent[user.id] || 0) && !(fol && fol.state === 'ok');
    if (!i.muted) unread += i.unread || 0; out.push({ request, handle: p.handle, name: p.name, avatar: p.avatar, last: i.last ? { text: i.last.text, at: i.last.at, mine: i.last.from === user.id } : null, unread: i.unread || 0, muted: !!i.muted }); }
  out.sort((x, y) => (y.last ? y.last.at : 0) - (x.last ? x.last.at : 0)); return { conversations: out, unread, requests: out.filter(x => x.request).length }; };
P.dmUnread = async function (user) { const r = await this.dmList(user); return { unread: r.unread, conversations: r.conversations.filter(c => c.unread && !c.muted).length }; };
P.dmMark = async function (user, handle, act, v) { const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'rider not found'); const key = user.id + ':' + t.id;
  return this.lock('dmi:' + key, async () => { const i = await this.kv.get('cdmc', key); if (!i) { if (act === 'mute') { await this.kv.set('cdmc', key, { cv: cvOf(user.id, t.id), peer: t.id, unread: 0, muted: v === true, cleared: null, last: null }); } return { ok: true }; }
    if (act === 'read') i.unread = 0; else if (act === 'accept') i.accepted = true; else if (act === 'mute') i.muted = v === true; else if (act === 'clear') { const rows = await this.kv.range('cdm', { prefix: i.cv + ':', desc: true, limit: 1 }); i.cleared = rows.length ? rows[0][1].id : i.cleared; i.unread = 0; } await this.kv.set('cdmc', key, i); return { ok: true }; }); };
P.dmDelete = async function (user, handle, mid) { const t = await this.profByHandle(handle); if (!t) throw new HttpError(404, 'message not found'); const key = cvOf(user.id, t.id), m = await this.kv.get('cdm', key + ':' + String(mid)); if (!m || m.from !== user.id) throw new HttpError(404, 'message not found');
  await this.kv.del('cdm', key + ':' + m.id); await this.kv.del('cdmu', user.id + ':' + key + ':' + m.id); await this.dropDmReports(key + ':' + m.id); return { ok: true }; };
P.dropDmReports = async function (key) { for (const [, rid] of await this.kv.range('crept', { prefix: 'dm:' + key + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { if (r.state === 'open') { r.state = 'actioned'; r.action = 'removed'; } r.snap = null; r.note = ''; await this.kv.set('crep', rid, r); } } };
// ---- live: one SSE stream per user for all conversations (+ unread badge updates); polling via GET dm/list or dm/with/:h?since
P.dmSubs = null;
P.sseOpen = (old => function () { let n = old.call(this); if (this.dmSubs) for (const s of this.dmSubs.values()) n += s.size; return n; })(P.sseOpen);
P.dmStream = async function (req, res, user, prof) { this.canWrite(prof); if (!this.dmSubs) this.dmSubs = new Map(); let set = this.dmSubs.get(user.id); if (set && set.size >= 2) throw new HttpError(429, 'too many open message connections'); if (this.sseOpen() >= (this.o.sseMax || 200)) throw new HttpError(429, 'too many open connections');
  if (!set) this.dmSubs.set(user.id, set = new Set()); const sub = { res, uid: user.id }; set.add(sub); res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' }); res.write('retry: 3000\n\n: ready\n\n');
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000); hb.unref && hb.unref(); res.on('close', () => { clearInterval(hb); set.delete(sub); if (!set.size) this.dmSubs.delete(user.id); }); return true; };
P.pushDm = async function (uid, data, from) { const set = this.dmSubs && this.dmSubs.get(uid); if (!set) return; if (from && await this.isBlocked(from, uid)) return; for (const s of [...set]) { try { s.res.write('id: ' + data.message.id + '\nevent: dm\ndata: ' + JSON.stringify(data) + '\n\n'); } catch {} } };
// ---- reports: only a participant can report a DM / only a member can report a club message; evidence = the message plus up to 3 before it
const baseGuard = P.reportGuard; P.reportGuard = async function (user, kind, id) {
  if (kind === 'dm') { const cv = id.split(':')[0]; if (!cv.split('~').includes(user.id)) throw new HttpError(404, 'that content no longer exists'); }
  if (kind === 'message') { const m = await this.kv.get('cmsg', id); if (m && !await this.clubMember(user.id, m.club)) throw new HttpError(404, 'that content no longer exists'); }
  if (baseGuard) await baseGuard.call(this, user, kind, id); };
const baseInfo = P.contentInfo; P.contentInfo = async function (kind, id) {
  if (kind === 'dm') { const m = await this.kv.get('cdm', id); if (!m) return null; const au = await this.prof(m.from); const prev = (await this.kv.range('cdm', { prefix: m.cv + ':', after: id, desc: true, limit: 3 })).reverse().map(r => ({ by: r[1].from === m.from ? (au && au.handle) : 'other', text: r[1].text }));
    const [x, y] = m.cv.split('~'), to = m.from === x ? y : x; return { id, key: id, owner: m.from, state: m.state, newAcct: false, hasImages: false, images: [], snap: { text: m.text, by: au && au.handle, to: (await this.author(to)).handle, before: prev } }; }
  return baseInfo ? baseInfo.call(this, kind, id) : null; };
const baseSet = P.setState; P.setState = async function (kind, key, state, why) { if (kind === 'dm') { const m = await this.kv.get('cdm', key); if (!m) return; m.state = state; await this.kv.set('cdm', key, m); return; } return baseSet ? baseSet.call(this, kind, key, state, why) : undefined; };
const baseRm = P.removeContent; P.removeContent = async function (kind, key) { if (kind === 'dm') { const m = await this.kv.get('cdm', key); if (m) { await this.kv.del('cdm', key); await this.kv.del('cdmu', m.from + ':' + key); await this.dropDmReports(key); } return; } return baseRm ? baseRm.call(this, kind, key) : undefined; };
// ---- deletion: the whole conversation goes (both sides), nothing of the deleted user remains
P._init = (old => function () { old && old.call(this);
  this.cascades.push(async uid => { for (const [k] of await this.kv.range('cdmc', { prefix: uid + ':', limit: 5000 })) { const peer = k.split(':')[1], cv = cvOf(uid, peer);
      for (const [mk, m] of await this.kv.range('cdm', { prefix: cv + ':', limit: 5000 })) { await this.kv.del('cdm', mk); await this.kv.del('cdmu', m.from + ':' + mk); } await this.kv.del('cconv', cv); await this.kv.del('cdmc', k); await this.kv.del('cdmc', peer + ':' + uid); }
    for (const [k] of await this.kv.range('cdmu', { prefix: uid + ':', limit: 5000 })) await this.kv.del('cdmu', k); const set = this.dmSubs && this.dmSubs.get(uid); if (set) for (const s of [...set]) { try { s.res.end(); } catch {} } });
  this.routes.push((req, res, url, parts, mm, io) => this.dmRoutes(req, res, url, parts, mm, io)); })(P._init);
const baseExport = P.exportParts; P.exportParts = async function (uid) { const base = baseExport ? await baseExport.call(this, uid) : {}; const dms = []; for (const [k] of await this.kv.range('cdmu', { prefix: uid + ':', limit: 5000 })) { const m = await this.kv.get('cdm', k.slice(uid.length + 1)); if (m) { const [x, y] = m.cv.split('~'); dms.push({ to: (await this.author(m.from === x ? y : x)).handle, text: m.text, at: m.at }); } } return Object.assign(base, { directMessages: dms }); };
P.dmRoutes = async function (req, res, url, parts, mm, { body, json }) {
  const [a, b, c, d, e] = parts; if (a !== 'dm') return undefined; const q = url.searchParams, GET = req.method === 'GET', POST = req.method === 'POST', { user, prof, ip } = mm;
  if (GET && !b) return json(res, 200, await this.dmList(user)); if (GET && b === 'unread') return json(res, 200, await this.dmUnread(user)); if (GET && b === 'stream') return this.dmStream(req, res, user, prof);
  if (b !== 'with' || !c) return undefined;
  if (GET && !d) return json(res, 200, await this.dmHistory(user, c, q.get('since'), q.get('limit')));
  if (POST && !d) return json(res, 201, await this.sendDm(user, prof, c, await body(req, 2048), ip));
  if (POST && d === 'read') return json(res, 200, await this.dmMark(user, c, 'read')); if (POST && d === 'mute') return json(res, 200, await this.dmMark(user, c, 'mute', (await body(req, 128)).on === true)); if (POST && d === 'accept') return json(res, 200, await this.dmMark(user, c, 'accept')); if (POST && d === 'clear') return json(res, 200, await this.dmMark(user, c, 'clear'));
  if (POST && d === 'delete') return json(res, 200, await this.dmDelete(user, c, (await body(req, 256)).id)); return undefined; };
