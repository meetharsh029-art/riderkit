'use strict';
// Stage 5: clubs (public, discoverable), group chats (invite-only, <=30) and their chat (SSE + polling).
// Keys: cclub:<id> club record; cclubn:<nameKey> unique club names; cclubm:<club>:<uid> {role,at}; cclubu:<uid>:<club>; cclubreq:<club>:<uid> + cclubrequ:<uid>:<club>;
// cclubinv:<uid>:<club> {by,at} + cclubinvc:<club>:<uid>; cclubban:<club>:<uid>; cclubread:<uid>:<club> last-seen msg id;
// cmsg:<club>:<akey> {id,club,author,text,at,state}; cmsgu:<uid>:<club>:<akey>. Posts to a club use cclubpost:<club>:<post> (stage 2).
const { HttpError } = require('./groups');
const { Community, cleanText, needsHold, BAD_RE } = require('./community');
const P = Community.prototype; const MAX_MY = 30, MAX_PENDING_INV = 50, MAX_REQ = 200;
const nameKey = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
P.cleanClubName = function (s) { const n = cleanText(s, 30, { required: true, label: 'the name' }); if (n.length < 3) throw new HttpError(400, 'the name must be at least 3 characters'); if (BAD_RE.test(n)) throw new HttpError(400, 'that name is not allowed'); if (nameKey(n).length < 3) throw new HttpError(400, 'the name needs letters or numbers'); return n; };
P.getClub = async function (id) { return this.kv.get('cclub', String(id)); };
P.clubMember = async function (uid, club) { return this.kv.get('cclubm', club + ':' + uid); };
P.isClubMember = async function (uid, club) { if (!club) return false; const c = await this.getClub(club); return !!c && c.state === 'ok' && !!await this.clubMember(uid, club); };
P.isBanned = async function (uid, club) { return !!await this.kv.get('cclubban', club + ':' + uid); };
P.policyAllows = async function (senderId, rec) { if (!rec || rec.state === 'suspended') return false; if (rec.dm === 'everyone') return true; if (rec.dm === 'followers') { const f = await this.kv.get('cfollow', senderId + ':' + rec.id); return !!f && f.state === 'ok'; } return false; };
P.clubCap = function (c) { return c.kind === 'group' ? this.o.groupMax : this.o.clubMax; };
P.clubView = async function (uid, c) {
  const m = await this.clubMember(uid, c.id); let state = m ? 'member' : 'none'; if (!m) { if (await this.kv.get('cclubreq', c.id + ':' + uid)) state = 'requested'; else if (await this.kv.get('cclubinv', uid + ':' + c.id)) state = 'invited'; }
  const o = await this.author(c.owner); return { id: c.id, kind: c.kind, name: c.name, about: c.about, join: c.join, members: c.members, cap: this.clubCap(c), owner: o.handle, role: m ? m.role : null, state, at: c.at, hidden: c.state !== 'ok' ? true : undefined }; };
P.visibleClub = async function (uid, id) { const c = await this.getClub(id); if (!c) throw new HttpError(404, 'club not found'); const m = await this.clubMember(uid, c.id);
  if (m) return { c, m }; if (c.state !== 'ok' || await this.isBanned(uid, c.id)) throw new HttpError(404, 'club not found'); if (c.kind === 'group' && !await this.kv.get('cclubinv', uid + ':' + c.id)) throw new HttpError(404, 'club not found'); return { c, m: null }; };
P.needMember = async function (uid, id) { const c = await this.getClub(id), m = c && await this.clubMember(uid, c.id); if (!c || !m || c.state !== 'ok') throw new HttpError(404, 'club not found'); return { c, m }; };
P.needMod = async function (uid, id) { const r = await this.needMember(uid, id); if (!['owner', 'mod'].includes(r.m.role)) throw new HttpError(403, 'only the owner or a moderator can do that'); return r; };
P.createClub = async function (user, prof, b, ip) {
  this.canWrite(prof); const kind = b.kind === 'group' ? 'group' : 'club', name = this.cleanClubName(b.name), about = cleanText(b.about || '', 200, { multiline: true, label: 'the description' }); if (BAD_RE.test(about) || needsHold(about)) throw new HttpError(400, 'that description is not allowed');
  const join = kind === 'group' ? 'invite' : (b.join === undefined ? 'open' : b.join); if (!['open', 'request', 'invite'].includes(join)) throw new HttpError(400, 'join must be open, request or invite');
  if ((await this.kv.range('cclubu', { prefix: user.id + ':', limit: MAX_MY + 1 })).length >= MAX_MY) throw new HttpError(400, 'you are in the maximum number of clubs and groups');
  this.rl('clubCreate', user.id, ip, user); const id = this.tkey(); if (kind === 'club' && !await this.kv.add('cclubn', nameKey(name), id)) throw new HttpError(409, 'a club with that name already exists');
  const c = { id, kind, name, nk: kind === 'club' ? nameKey(name) : null, about, join, owner: user.id, members: 0, msgN: 0, at: this.now(), state: 'ok' }; await this.kv.set('cclub', id, c); await this.addMember(c, user.id, 'owner'); return { club: await this.clubView(user.id, await this.getClub(id)) }; };
P.addMember = async function (c, uid, role = 'member') { return this.lock('club:' + c.id, async () => { const cur = await this.getClub(c.id); if (!cur) throw new HttpError(404, 'club not found'); if (cur.members >= this.clubCap(cur)) throw new HttpError(400, cur.kind === 'group' ? 'this group is full' : 'this club is full');
  if ((await this.kv.range('cclubu', { prefix: uid + ':', limit: MAX_MY + 1 })).length >= MAX_MY) throw new HttpError(400, 'you are in the maximum number of clubs and groups');
  if (!await this.kv.add('cclubm', cur.id + ':' + uid, { role, at: this.now() })) return false; await this.kv.set('cclubu', uid + ':' + cur.id, 1); cur.members++; await this.kv.set('cclub', cur.id, cur);
  await this.kv.del('cclubreq', cur.id + ':' + uid); await this.kv.del('cclubrequ', uid + ':' + cur.id); await this.kv.del('cclubinv', uid + ':' + cur.id); await this.kv.del('cclubinvc', cur.id + ':' + uid); return true; }); };
P.removeMember = async function (clubId, uid, why) { const had = await this.lock('club:' + clubId, async () => { const c = await this.getClub(clubId), m = await this.kv.get('cclubm', clubId + ':' + uid); if (!c || !m) return null; await this.kv.del('cclubm', clubId + ':' + uid); await this.kv.del('cclubu', uid + ':' + clubId); await this.kv.del('cclubread', uid + ':' + clubId); c.members = Math.max(0, c.members - 1);
    let delClub = false; if (m.role === 'owner') { const rows = await this.kv.range('cclubm', { prefix: clubId + ':', limit: 1000 }); const pick = rows.filter(r => r[1].role === 'mod').sort((x, y) => x[1].at - y[1].at)[0] || rows.sort((x, y) => x[1].at - y[1].at)[0]; if (pick) { pick[1].role = 'owner'; await this.kv.set('cclubm', pick[0], pick[1]); c.owner = pick[0].split(':')[1]; } else delClub = true; }
    if (delClub) return { delClub: true }; await this.kv.set('cclub', clubId, c); return { m }; }); this.kickStreams(clubId, uid, why || 'left'); if (had && had.delClub) await this.deleteClub(clubId); return !!had; };
P.deleteClub = async function (id) { const c = await this.getClub(id); if (!c) return false;
  for (const [k] of await this.kv.range('cclubm', { prefix: id + ':', limit: 5000 })) { const uid = k.split(':')[1]; await this.kv.del('cclubm', k); await this.kv.del('cclubu', uid + ':' + id); await this.kv.del('cclubread', uid + ':' + id); }
  for (const [k] of await this.kv.range('cclubreq', { prefix: id + ':', limit: 5000 })) { await this.kv.del('cclubreq', k); await this.kv.del('cclubrequ', k.split(':')[1] + ':' + id); }
  for (const [k] of await this.kv.range('cclubinvc', { prefix: id + ':', limit: 5000 })) { await this.kv.del('cclubinvc', k); await this.kv.del('cclubinv', k.split(':')[1] + ':' + id); } for (const [k] of await this.kv.range('cclubban', { prefix: id + ':', limit: 5000 })) await this.kv.del('cclubban', k);
  for (const [k, m] of await this.kv.range('cmsg', { prefix: id + ':', limit: 5000 })) { await this.kv.del('cmsg', k); await this.kv.del('cmsgu', m.author + ':' + k); }
  for (const [k] of await this.kv.range('cclubpost', { prefix: id + ':', limit: 5000 })) { const p = await this.kv.get('cpost', k.split(':')[1]); if (p) await this.deletePost(p); await this.kv.del('cclubpost', k); }
  if (c.nk) await this.kv.del('cclubn', c.nk); await this.kv.del('cclub', id);
  for (const key of [id]) for (const [, rid] of await this.kv.range('crept', { prefix: 'club:' + key + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { if (r.state === 'open') { r.state = 'actioned'; r.action = 'removed'; } r.snap = null; r.note = ''; await this.kv.set('crep', rid, r); } }
  this.closeClubStreams(id); return true; };
P.joinClub = async function (user, prof, id, ip) {
  this.canWrite(prof); this.rl('clubAct', user.id, ip, user); const { c, m } = await this.visibleClub(user.id, id); if (m) return { state: 'member' }; const invited = await this.kv.get('cclubinv', user.id + ':' + c.id);
  if (invited || c.join === 'open') { await this.addMember(c, user.id); return { state: 'member' }; }
  if (c.join === 'request') { if (await this.kv.get('cclubreq', c.id + ':' + user.id)) return { state: 'requested' }; if ((await this.kv.range('cclubreq', { prefix: c.id + ':', limit: MAX_REQ + 1 })).length >= MAX_REQ) throw new HttpError(400, 'this club has too many pending requests');
    await this.kv.set('cclubreq', c.id + ':' + user.id, { at: this.now() }); await this.kv.set('cclubrequ', user.id + ':' + c.id, 1); return { state: 'requested' }; }
  throw new HttpError(403, 'this club is invite only'); };
P.leaveClub = async function (user, id) { const c = await this.getClub(id); if (c) { await this.kv.del('cclubreq', c.id + ':' + user.id); await this.kv.del('cclubrequ', user.id + ':' + c.id); } if (!await this.removeMember(String(id), user.id)) { if (!c) throw new HttpError(404, 'club not found'); } return { ok: true }; };
P.clubRequests = async function (user, id) { const { c } = await this.needMod(user.id, id); const out = []; for (const [k, v] of await this.kv.range('cclubreq', { prefix: c.id + ':', limit: MAX_REQ })) { const a = await this.author(k.split(':')[1]); out.push({ handle: a.handle, name: a.name, avatar: a.avatar, at: v.at }); } return { requests: out }; };
P.respondRequest = async function (user, id, handle, accept) { const { c } = await this.needMod(user.id, id), t = await this.profByHandle(handle); if (!t || !await this.kv.get('cclubreq', c.id + ':' + t.id)) throw new HttpError(404, 'no such request');
  if (accept === true && !await this.isBlocked(user.id, t.id) && !await this.isBanned(t.id, c.id)) { await this.addMember(c, t.id); return { state: 'member' }; } await this.kv.del('cclubreq', c.id + ':' + t.id); await this.kv.del('cclubrequ', t.id + ':' + c.id); return { state: 'declined' }; };
P.inviteToClub = async function (user, prof, id, handle, ip) {
  this.canWrite(prof); const { c, m } = await this.needMember(user.id, id); if (c.kind === 'club' && !['owner', 'mod'].includes(m.role)) throw new HttpError(403, 'only the owner or a moderator can invite to a club'); this.rl('clubAct', user.id, ip, user);
  const t = await this.profByHandle(handle); if (!t || t.id === user.id || await this.isBlocked(user.id, t.id)) throw new HttpError(404, 'rider not found'); if (await this.clubMember(t.id, c.id)) return { state: 'member' };
  if (await this.isBanned(t.id, c.id) || !await this.policyAllows(user.id, t)) throw new HttpError(400, 'this rider cannot be invited'); if (await this.kv.get('cclubinv', t.id + ':' + c.id)) return { state: 'invited' };
  if ((await this.kv.range('cclubinv', { prefix: t.id + ':', limit: MAX_PENDING_INV + 1 })).length >= MAX_PENDING_INV) throw new HttpError(400, 'this rider cannot be invited');
  await this.kv.set('cclubinv', t.id + ':' + c.id, { by: user.id, at: this.now() }); await this.kv.set('cclubinvc', c.id + ':' + t.id, 1); return { state: 'invited' }; };
P.respondInvite = async function (user, prof, id, accept) { this.canWrite(prof); const c = await this.getClub(id), inv = c && await this.kv.get('cclubinv', user.id + ':' + c.id); if (!c || !inv || c.state !== 'ok') throw new HttpError(404, 'invite not found');
  if (accept === true && !await this.isBanned(user.id, c.id) && !await this.isBlocked(user.id, inv.by)) { await this.addMember(c, user.id); return { state: 'member' }; } await this.kv.del('cclubinv', user.id + ':' + c.id); await this.kv.del('cclubinvc', c.id + ':' + user.id); return { state: 'declined' }; };
P.modAct = async function (user, id, handle, act, ip) {
  const { c, m } = await this.needMod(user.id, id); this.rl('clubAct', user.id, ip, user); const t = await this.profByHandle(handle); if (!t || t.id === user.id) throw new HttpError(404, 'rider not found'); const tm = await this.clubMember(t.id, c.id);
  if (act === 'unban') { await this.kv.del('cclubban', c.id + ':' + t.id); return { ok: true }; }
  if (tm && (tm.role === 'owner' || (tm.role === 'mod' && m.role !== 'owner'))) throw new HttpError(403, 'you cannot remove that member');
  if (act === 'ban') await this.kv.set('cclubban', c.id + ':' + t.id, { at: this.now() }); if (tm) await this.removeMember(c.id, t.id, act === 'ban' ? 'banned' : 'removed');
  if (act === 'ban') { await this.kv.del('cclubreq', c.id + ':' + t.id); await this.kv.del('cclubrequ', t.id + ':' + c.id); await this.kv.del('cclubinv', t.id + ':' + c.id); await this.kv.del('cclubinvc', c.id + ':' + t.id); } return { ok: true }; };
P.setRole = async function (user, id, handle, role) { const { c, m } = await this.needMember(user.id, id); if (m.role !== 'owner') throw new HttpError(403, 'only the owner can change roles'); if (!['mod', 'member'].includes(role)) throw new HttpError(400, 'role must be mod or member');
  const t = await this.profByHandle(handle), tm = t && t.id !== user.id && await this.clubMember(t.id, c.id); if (!tm) throw new HttpError(404, 'member not found'); tm.role = role; await this.kv.set('cclubm', c.id + ':' + t.id, tm); return { ok: true }; };
P.updateClub = async function (user, id, b) { const { c, m } = await this.needMember(user.id, id); if (m.role !== 'owner') throw new HttpError(403, 'only the owner can edit the club');
  if (b.about !== undefined) { const a = cleanText(b.about, 200, { multiline: true, label: 'the description' }); if (BAD_RE.test(a) || needsHold(a)) throw new HttpError(400, 'that description is not allowed'); c.about = a; }
  if (b.join !== undefined) { if (c.kind === 'group' || !['open', 'request', 'invite'].includes(b.join)) throw new HttpError(400, 'invalid join setting'); c.join = b.join; } await this.kv.set('cclub', c.id, c); return { club: await this.clubView(user.id, c) }; };
P.deleteOwnClub = async function (user, id) { const { c, m } = await this.needMember(user.id, id); if (m.role !== 'owner') throw new HttpError(403, 'only the owner can delete the club'); await this.deleteClub(c.id); return { ok: true }; };
P.discoverClubs = async function (user, q, cursor, limit = 20) { const out = []; let after = cursor || null, scanned = 0, next = null; limit = Math.min(Math.max(+limit || 20, 1), 50); const qq = String(q || '').toLowerCase().trim();
  while (out.length < limit && scanned < 400) { const rows = await this.kv.range('cclub', { after, limit: 100 }); if (!rows.length) break; for (const [k, c] of rows) { after = k; scanned++; if (c.kind !== 'club' || c.state !== 'ok' || (qq && !c.name.toLowerCase().includes(qq))) continue; if (await this.isBanned(user.id, c.id)) continue; out.push(await this.clubView(user.id, c)); if (out.length >= limit) break; } if (rows.length < 100) { after = null; break; } }
  next = out.length >= limit || scanned >= 400 ? after : null; return { clubs: out, next }; };
P.myClubs = async function (user) { const out = [], inv = []; for (const [k] of await this.kv.range('cclubu', { prefix: user.id + ':', limit: MAX_MY })) { const c = await this.getClub(k.split(':')[1]); if (!c) continue; const v = await this.clubView(user.id, c); const ptr = await this.kv.get('cclubread', user.id + ':' + c.id) || '';
    const rows = await this.kv.range('cmsg', { prefix: c.id + ':', after: c.id + ':' + ptr, limit: 100 }); v.unread = rows.filter(r => r[1].author !== user.id && r[1].state === 'ok').length; out.push(v); }
  for (const [k, v] of await this.kv.range('cclubinv', { prefix: user.id + ':', limit: MAX_PENDING_INV })) { const c = await this.getClub(k.split(':')[1]); if (!c || c.state !== 'ok') continue; const by = await this.author(v.by); inv.push({ id: c.id, name: c.name, kind: c.kind, by: by.handle, members: c.members }); } return { clubs: out, invites: inv, unread: out.reduce((n, c) => n + c.unread, 0) }; };
P.clubMembers = async function (user, id, cursor, limit = 50) { await this.needMember(user.id, id); const blocked = await this.blockedSet(user.id), out = []; limit = Math.min(Math.max(+limit || 50, 1), 100); const rows = await this.kv.range('cclubm', { prefix: id + ':', after: cursor ? id + ':' + cursor : null, limit: limit + 1 });
  for (const [k, m] of rows.slice(0, limit)) { const uid = k.split(':')[1]; if (blocked.has(uid)) continue; const a = await this.author(uid); out.push({ handle: a.handle, name: a.name, avatar: a.avatar, role: m.role, uid: undefined, key: uid }); } return { members: out.map(x => ({ handle: x.handle, name: x.name, avatar: x.avatar, role: x.role })), next: rows.length > limit ? rows[limit - 1][0].split(':')[1] : null }; };
// ---- chat
P.msgView = async function (viewerId, m, role) { const a = await this.author(m.author); const v = { id: m.id, text: m.text, at: m.at, author: { handle: a.handle, name: a.name, avatar: a.avatar }, mine: m.author === viewerId }; v.canDelete = v.mine || role === 'owner' || role === 'mod'; return v; };
P.sendChat = async function (user, prof, id, b, ip) {
  this.canWrite(prof); const { c } = await this.needMember(user.id, id); const text = cleanText(b.text, 400, { required: true, label: 'the message' }); if (needsHold(text)) throw new HttpError(400, 'that message is not allowed in chat');
  this.rl('chat', user.id, ip, user); const mid = this.akey(), m = { id: mid, club: c.id, author: user.id, text, at: this.now(), state: 'ok' }; await this.kv.set('cmsg', c.id + ':' + mid, m); await this.kv.set('cmsgu', user.id + ':' + c.id + ':' + mid, 1);
  const prune = await this.lock('club:' + c.id, async () => { const cur = await this.getClub(c.id); if (!cur) return false; cur.msgN = (cur.msgN || 0) + 1; const over = cur.msgN > this.o.clubCap + 50; if (over) cur.msgN = this.o.clubCap; await this.kv.set('cclub', c.id, cur); return over; });
  if (prune) { const rows = await this.kv.range('cmsg', { prefix: c.id + ':', limit: 50 }); for (const [k, x] of rows) { await this.kv.del('cmsg', k); await this.kv.del('cmsgu', x.author + ':' + k); } }
  await this.publish(c.id, m); return { message: await this.msgView(user.id, m, 'member') }; };
P.chatHistory = async function (user, id, since, limit = 50) { const { c, m } = await this.needMember(user.id, id), blocked = await this.blockedSet(user.id); limit = Math.min(Math.max(+limit || 50, 1), 100); let rows;
  if (since) rows = await this.kv.range('cmsg', { prefix: c.id + ':', after: c.id + ':' + since, limit }); else rows = (await this.kv.range('cmsg', { prefix: c.id + ':', desc: true, limit })).reverse(); const out = [];
  for (const [, x] of rows) { if (x.state !== 'ok' && x.author !== user.id) continue; if (blocked.has(x.author) && x.author !== user.id) continue; out.push(await this.msgView(user.id, x, m.role)); } return { messages: out, last: rows.length ? rows[rows.length - 1][1].id : since || null }; };
P.markRead = async function (user, id, upTo) { const { c } = await this.needMember(user.id, id); if (typeof upTo === 'string' && /^\d{17,20}[0-9a-f]{0,8}$/.test(upTo)) await this.kv.set('cclubread', user.id + ':' + c.id, upTo); return { ok: true }; };
P.deleteChat = async function (user, id, mid) { const { c, m } = await this.needMember(user.id, id), x = await this.kv.get('cmsg', c.id + ':' + String(mid)); if (!x || !(x.author === user.id || ['owner', 'mod'].includes(m.role))) throw new HttpError(404, 'message not found');
  await this.kv.del('cmsg', c.id + ':' + x.id); await this.kv.del('cmsgu', x.author + ':' + c.id + ':' + x.id); await this.publish(c.id, x, 'del'); return { ok: true }; };
// ---- live delivery: Server-Sent Events over a fetch stream (Bearer header), single process
P.subs = null;
P.sseOpen = function () { return this.subs ? [...this.subs.values()].reduce((n, s) => n + s.size, 0) : 0; };
P.stream = async function (req, res, user, prof, id, since) {
  const { c } = await this.needMember(user.id, id); this.canWrite(prof); if (!this.subs) this.subs = new Map(); const mine = [...this.subs.values()].reduce((n, s) => n + [...s].filter(x => x.uid === user.id).length, 0);
  if (mine >= 3 || this.sseOpen() >= (this.o.sseMax || 200)) throw new HttpError(429, 'too many open chat connections'); const sub = { res, uid: user.id }; let set = this.subs.get(c.id); if (!set) this.subs.set(c.id, set = new Set()); set.add(sub);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' }); res.write('retry: 3000\n\n');
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000); hb.unref && hb.unref(); const done = () => { clearInterval(hb); const s = this.subs.get(c.id); if (s) { s.delete(sub); if (!s.size) this.subs.delete(c.id); } }; res.on('close', done); sub.close = why => { try { res.write('event: kicked\ndata: ' + JSON.stringify({ why }) + '\n\n'); res.end(); } catch {} done(); };
  if (since) { const h = await this.chatHistory(user, c.id, since, 100); for (const m of h.messages) res.write('id: ' + m.id + '\nevent: msg\ndata: ' + JSON.stringify(m) + '\n\n'); } else res.write(': ready\n\n'); return true; };
P.publish = async function (clubId, m, ev = 'msg') { const set = this.subs && this.subs.get(clubId); if (!set) return; for (const sub of [...set]) { try { if (sub.uid !== m.author && await this.isBlocked(m.author, sub.uid)) continue; const mem = await this.clubMember(sub.uid, clubId); if (!mem) continue;
    if (ev === 'del') sub.res.write('event: del\ndata: ' + JSON.stringify({ id: m.id }) + '\n\n'); else sub.res.write('id: ' + m.id + '\nevent: msg\ndata: ' + JSON.stringify(await this.msgView(sub.uid, m, mem.role)) + '\n\n'); } catch {} } };
P.kickStreams = function (clubId, uid, why) { const set = this.subs && this.subs.get(clubId); if (set) for (const s of [...set]) if (s.uid === uid) s.close(why); };
P.closeClubStreams = function (clubId) { const set = this.subs && this.subs.get(clubId); if (set) for (const s of [...set]) s.close('deleted'); };
// ---- reports / admin hooks
const baseInfo = P.contentInfo; P.contentInfo = async function (kind, id) {
  if (kind === 'club') { const c = await this.getClub(id); if (!c) return null; return { id, key: id, owner: c.owner, state: c.state, newAcct: false, hasImages: false, images: [], snap: { name: c.name, about: c.about, kind: c.kind, members: c.members } }; }
  if (kind === 'message') { const m = await this.kv.get('cmsg', id); if (!m) return null; const club = await this.getClub(m.club), au = await this.prof(m.author); const prev = (await this.kv.range('cmsg', { prefix: m.club + ':', after: id, desc: true, limit: 3 })).reverse().map(r => ({ by: r[1].author === m.author ? (au && au.handle) : 'other', text: r[1].text }));
    return { id, key: id, owner: m.author, state: m.state, newAcct: false, hasImages: false, images: [], snap: { text: m.text, by: au && au.handle, club: club && club.name, before: prev } }; }
  return baseInfo ? baseInfo.call(this, kind, id) : null; };
const baseSet = P.setState; P.setState = async function (kind, key, state, why) {
  if (kind === 'club') { const c = await this.getClub(key); if (!c) return; c.state = state === 'ok' ? 'ok' : 'hidden'; await this.kv.set('cclub', key, c); if (c.state !== 'ok') this.closeClubStreams(key); return; }
  if (kind === 'message') { const m = await this.kv.get('cmsg', key); if (!m) return; m.state = state; await this.kv.set('cmsg', key, m); if (state !== 'ok') await this.publish(m.club, m, 'del'); return; }
  return baseSet ? baseSet.call(this, kind, key, state, why) : undefined; };
const baseRm = P.removeContent; P.removeContent = async function (kind, key) { if (kind === 'club') { await this.deleteClub(key); return; }
  if (kind === 'message') { const m = await this.kv.get('cmsg', key); if (m) { await this.kv.del('cmsg', key); await this.kv.del('cmsgu', m.author + ':' + key); await this.publish(m.club, m, 'del'); for (const [, rid] of await this.kv.range('crept', { prefix: 'message:' + key + ':', limit: 200 })) { const r = await this.kv.get('crep', rid); if (r) { r.snap = null; r.note = ''; await this.kv.set('crep', rid, r); } } } return; }
  return baseRm ? baseRm.call(this, kind, key) : undefined; };
// blocking someone ends shared live delivery lazily (publish checks isBlocked); deleting an account leaves every club (ownership transfers) and removes their messages
P._init = (old => function () { old && old.call(this);
  this.cascades.push(async uid => { for (const [k, m] of await this.kv.range('cmsgu', { prefix: uid + ':', limit: 50000 })) { await this.kv.del('cmsgu', k); const key = k.slice(uid.length + 1); await this.kv.del('cmsg', key); }
    for (const [k] of await this.kv.range('cclubu', { prefix: uid + ':', limit: 1000 })) await this.removeMember(k.split(':')[1], uid, 'deleted');
    for (const [k] of await this.kv.range('cclubrequ', { prefix: uid + ':', limit: 1000 })) { const cid = k.split(':')[1]; await this.kv.del('cclubrequ', k); await this.kv.del('cclubreq', cid + ':' + uid); }
    for (const [k] of await this.kv.range('cclubinv', { prefix: uid + ':', limit: 1000 })) { const cid = k.split(':')[1]; await this.kv.del('cclubinv', k); await this.kv.del('cclubinvc', cid + ':' + uid); } });
  this.routes.push((req, res, url, parts, mm, io) => this.clubRoutes(req, res, url, parts, mm, io)); })(P._init);
const baseExport = P.exportParts; P.exportParts = async function (uid) { const base = baseExport ? await baseExport.call(this, uid) : {}; const clubs = []; for (const [k] of await this.kv.range('cclubu', { prefix: uid + ':', limit: 1000 })) { const c = await this.getClub(k.split(':')[1]), m = c && await this.clubMember(uid, c.id); if (c) clubs.push({ name: c.name, kind: c.kind, role: m && m.role }); }
  const msgs = []; for (const [k] of await this.kv.range('cmsgu', { prefix: uid + ':', limit: 5000 })) { const m = await this.kv.get('cmsg', k.slice(uid.length + 1)); if (m) msgs.push({ text: m.text, at: m.at }); } return Object.assign(base, { clubs, clubMessages: msgs }); };
P.clubRoutes = async function (req, res, url, parts, mm, { body, json }) {
  const [a, b, c, d, e] = parts; if (a !== 'clubs') return undefined; const q = url.searchParams, GET = req.method === 'GET', POST = req.method === 'POST', { user, prof, ip } = mm;
  if (GET && !b) return json(res, 200, await this.discoverClubs(user, q.get('q'), q.get('before'), q.get('limit')));
  if (POST && !b) return json(res, 201, await this.createClub(user, prof, await body(req, 2048), ip));
  if (GET && b === 'mine') return json(res, 200, await this.myClubs(user));
  if (POST && b === 'invites' && c === 'respond') { const x = await body(req, 512); return json(res, 200, await this.respondInvite(user, prof, x.club, x.accept === true)); }
  if (!b) return undefined; if (GET && !c) return json(res, 200, { club: await this.clubView(user.id, (await this.visibleClub(user.id, b)).c) });
  if (POST && c === 'join') return json(res, 200, await this.joinClub(user, prof, b, ip)); if (POST && c === 'leave') return json(res, 200, await this.leaveClub(user, b));
  if (GET && c === 'members') return json(res, 200, await this.clubMembers(user, b, q.get('before'), q.get('limit'))); if (GET && c === 'requests') return json(res, 200, await this.clubRequests(user, b));
  if (POST && c === 'respond') { const x = await body(req, 512); return json(res, 200, await this.respondRequest(user, b, x.handle, x.accept === true)); }
  if (POST && c === 'invite') return json(res, 200, await this.inviteToClub(user, prof, b, (await body(req, 512)).handle, ip));
  if (POST && (c === 'kick' || c === 'ban' || c === 'unban')) return json(res, 200, await this.modAct(user, b, (await body(req, 512)).handle, c, ip));
  if (POST && c === 'role') { const x = await body(req, 512); return json(res, 200, await this.setRole(user, b, x.handle, x.role)); }
  if (POST && c === 'update') return json(res, 200, await this.updateClub(user, b, await body(req, 2048))); if (POST && c === 'delete') return json(res, 200, await this.deleteOwnClub(user, b));
  if (POST && c === 'read') return json(res, 200, await this.markRead(user, b, (await body(req, 256)).upTo));
  if (POST && c === 'chat' && !d) return json(res, 201, await this.sendChat(user, prof, b, await body(req, 2048), ip));
  if (POST && c === 'chat' && d && e === 'delete') return json(res, 200, await this.deleteChat(user, b, d));
  if (GET && c === 'chat') return json(res, 200, await this.chatHistory(user, b, q.get('since'), q.get('limit')));
  if (GET && c === 'stream') return this.stream(req, res, user, prof, b, req.headers['last-event-id'] || q.get('since'));
  return undefined; };
