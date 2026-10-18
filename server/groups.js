'use strict';
// In-memory group store. No I/O, injectable clock -> unit-testable.
const crypto = require('crypto');
const COLORS = ['#ff7a1a', '#3aa0ff', '#5ccf7a', '#e84a8a', '#b07cff', '#ffd23a', '#2ed3c6', '#ff5a4a', '#9bd13a', '#c98a5a'];
const ALERT_TYPES = ['bike', 'car', 'puncture', 'accident', 'sos'];
// Lifecycle: a group is NEVER expired while it has members who have not ended their trip. It closes only when the admin cancels it or every present rider has ended their trip.
// Cleanup (memory only): a group with zero members and no activity for emptyTtlMs (7 days) is dropped. abandonedTtlMs (0 = off) optionally drops groups whose members have all been unseen that long.
const OPTS = { alertTtlMs: 6 * 3600e3, emptyTtlMs: 7 * 24 * 3600e3, abandonedTtlMs: 0, reclaimStaleMs: 5 * 60e3, adminStaleMs: 10 * 60e3, tombstoneMs: 3600e3, maxGroups: 1000, maxMembers: 30, moveMeters: 25 };
const QUICK = { stop: 'Stop', fuel: 'Fuel', tea: 'Tea break', slow: 'Slow down', wait: 'Wait for me', turn: 'Turn ahead', help: 'Need help' };
// Voice clips: raw audio bytes held in server memory ONLY (never written to disk), expire after clipTtlMs, capped per group by count and bytes.
const VOICE = { clipTtlMs: 3 * 60e3, maxClipBytes: 96 * 1024, maxClipsPerGroup: 8, maxBytesPerGroup: 512 * 1024, maxClipMs: 16000, logMax: 50 };
const CLOSE_MSG = { cancelled: 'The admin cancelled the group.', finished: 'Every rider has ended their trip, so the group is finished.' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const rad = d => d * Math.PI / 180;
function dist(a, b) { const R = 6371000, dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const cleanName = (s, max = 24) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const num = (v, lo, hi) => { const n = typeof v === 'number' ? v : NaN; if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'invalid number'); return n; };
const optNum = (v, lo, hi) => (v == null ? null : (Number.isFinite(v) && v >= lo && v <= hi ? v : null));

class GroupStore {
  constructor(opts = {}, now = () => Date.now()) { this.o = Object.assign({}, OPTS, VOICE, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined))); this.now = now; this.groups = new Map(); this.listeners = new Map(); this.msgListeners = new Map(); this.tombs = new Map(); }
  newCode() { for (let i = 0; i < 50; i++) { const c = 'RIDE-' + (1000 + crypto.randomInt(9000)); if (!this.groups.has(c) && !this.tombs.has(c)) return c; } throw new HttpError(503, 'no free codes, try later'); }
  normCode(c) { c = String(c ?? '').toUpperCase().replace(/\s/g, ''); if (/^\d{4}$/.test(c)) c = 'RIDE-' + c; return c.replace(/^RIDE(\d{4})$/, 'RIDE-$1'); }
  get(code) { const c = this.normCode(code), g = this.groups.get(c); if (g) return g;
    const tb = this.tombs.get(c); if (tb) { const e = new HttpError(410, CLOSE_MSG[tb.reason] || 'This group has ended.'); e.reason = tb.reason; throw e; } throw new HttpError(404, 'group not found'); }
  addMember(g, name) {
    if (g.members.size >= this.o.maxMembers) throw new HttpError(409, 'group is full');
    const nm = cleanName(name); if (!nm) throw new HttpError(400, 'rider name required');
    const used = new Set([...g.members.values()].map(m => m.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[g.members.size % COLORS.length];
    const m = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name: nm, color, joinedAt: this.now(), lastSeen: this.now(), pos: null, speed: null, acc: null, movedAt: null, anchor: null, ended: false, endedAt: null, alert: null };
    g.members.set(m.id, m); return m;
  }
  create(name) {
    if (this.groups.size >= this.o.maxGroups) throw new HttpError(503, 'server busy');
    const g = { code: this.newCode(), createdAt: this.now(), lastActivity: this.now(), members: new Map(), dest: null, dirty: true, adminId: null };
    const m = this.addMember(g, name); g.adminId = m.id; this.groups.set(g.code, g); return { g, m };
  }
  // Join / REJOIN by code. A rider whose trip ended, or who has been unseen for reclaimStaleMs, can come back under the same name: they get their old rider entry back with a NEW token (the old token stops working).
  // The admin entry is never reclaimed by name (that would let anyone with the code take over); use claimAdmin instead. A group with no members is revived by its next joiner, who becomes admin.
  join(code, name) {
    const g = this.get(code); const nm = cleanName(name); const t = this.now(); let m = null, rejoined = false;
    if (nm) m = [...g.members.values()].find(x => x.id !== g.adminId && x.name.toLowerCase() === nm.toLowerCase() && (x.ended || t - x.lastSeen > this.o.reclaimStaleMs)) || null;
    if (m) { m.token = crypto.randomBytes(16).toString('hex'); m.ended = false; m.endedAt = null; m.lastSeen = t; rejoined = true; } else m = this.addMember(g, name);
    if (!g.adminId || !g.members.has(g.adminId)) g.adminId = m.id; this.touch(g); return { g, m, rejoined };
  }
  auth(code, token) { const g = this.get(code); for (const m of g.members.values()) if (token && m.token === token) return { g, m }; throw new HttpError(403, 'not a member'); }
  touch(g) { g.lastActivity = this.now(); g.dirty = true; }
  setDest(code, token, d) {
    const { g, m } = this.auth(code, token);
    g.dest = { lat: num(d.lat, -90, 90), lng: num(d.lng, -180, 180), name: cleanName(d.name, 120) || 'Destination', by: m.name, at: this.now() };
    m.lastSeen = this.now(); this.touch(g); return g;
  }
  clearDest(code, token) { const { g } = this.auth(code, token); g.dest = null; this.touch(g); return g; }
  location(code, token, p) {
    const { g, m } = this.auth(code, token); const t = this.now();
    const pos = { lat: num(p.lat, -90, 90), lng: num(p.lng, -180, 180) };
    m.pos = pos; m.acc = optNum(p.acc, 0, 1e5); m.speed = optNum(p.speed, 0, 200); m.lastSeen = t; m.posAt = t;
    if (m.ended) throw new HttpError(409, 'trip ended');
    if (m.alert) { m.alert.lat = pos.lat; m.alert.lng = pos.lng; }
    if (!m.anchor || dist(m.anchor, pos) >= this.o.moveMeters) { m.anchor = pos; m.movedAt = t; }
    this.touch(g); return g;
  }
  // Breakdown / SOS alert for one member. Position: given lat/lng, else the member's last fix, else none. Updated as the rider's position updates.
  raiseAlert(code, token, p) {
    const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended'); const type = String(p.type ?? '');
    if (!ALERT_TYPES.includes(type)) throw new HttpError(400, 'invalid alert type');
    let pos = m.pos; if (p.lat != null || p.lng != null) pos = { lat: num(p.lat, -90, 90), lng: num(p.lng, -180, 180) };
    m.alert = { type, at: this.now(), lat: pos ? pos.lat : null, lng: pos ? pos.lng : null }; m.lastSeen = this.now(); this.touch(g); return g;
  }
  cancelAlert(code, token) { const { g, m } = this.auth(code, token); const had = !!m.alert; m.alert = null; this.touch(g); return { g, had }; }
  alertOf(m) { if (m.alert && this.now() - m.alert.at > this.o.alertTtlMs) m.alert = null; return m.alert ? { type: m.alert.type, at: m.alert.at, lat: m.alert.lat, lng: m.alert.lng } : null; }
  flushNow(g) { g.dirty = false; const snap = this.snapshot(g); for (const f of this.listeners.get(g.code) || []) f(snap); }
  // Pick the next admin: earliest-joined rider who has not ended their trip.
  nextAdmin(g) { return [...g.members.values()].filter(x => !x.ended).sort((a, b) => a.joinedAt - b.joinedAt)[0] || null; }
  close(g, reason) {
    const snap = Object.assign(this.snapshot(g), { closed: reason }); this.groups.delete(g.code); this.tombs.set(g.code, { reason, at: this.now() });
    for (const f of this.listeners.get(g.code) || []) f(snap); this.closeAll(g.code);
  }
  // After any change that removed or ended a member: hand over admin, and close if everyone present has ended their trip.
  settle(g) {
    if (g.members.size && ![...g.members.values()].some(x => !x.ended)) { this.close(g, 'finished'); return true; }
    const a = g.members.get(g.adminId); if (!a || a.ended) { const n = this.nextAdmin(g); g.adminId = n ? n.id : null; }
    this.touch(g); return false;
  }
  // Leave = disappear from the group (others carry on). An emptied group stays (until emptyTtlMs) so anyone can rejoin by code.
  leave(code, token) { const { g, m } = this.auth(code, token); g.members.delete(m.id); const closed = this.settle(g); return { g, closed }; }
  // End my trip: I stay listed as "trip ended" (no position, no alerts); the group closes when every present rider has ended theirs.
  endTrip(code, token) { const { g, m } = this.auth(code, token); if (!m.ended) { m.ended = true; m.endedAt = this.now(); m.alert = null; } const closed = this.settle(g); return { g, closed }; }
  cancelGroup(code, token) { const { g, m } = this.auth(code, token); if (g.adminId !== m.id) throw new HttpError(403, 'only the admin can cancel the group'); this.close(g, 'cancelled'); return g; }
  transferAdmin(code, token, toId) { const { g, m } = this.auth(code, token); if (g.adminId !== m.id) throw new HttpError(403, 'only the admin can transfer admin');
    const to = g.members.get(String(toId ?? '')); if (!to) throw new HttpError(404, 'rider not found'); if (to.ended) throw new HttpError(409, 'that rider has ended their trip'); g.adminId = to.id; this.touch(g); return g; }
  // Take over admin when the admin is gone (ended their trip, removed, or unseen for adminStaleMs).
  claimAdmin(code, token) { const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended'); const a = g.members.get(g.adminId);
    if (a && a.id === m.id) return g; if (a && !a.ended && this.now() - a.lastSeen <= this.o.adminStaleMs) throw new HttpError(409, 'the admin is still active'); g.adminId = m.id; this.touch(g); return g; }
  // ---- group messages (quick messages + voice clips). Relayed over SSE as 'msg' events; not part of the state snapshot.
  pushMsg(g, msg) { (g.log || (g.log = [])).push(msg); if (g.log.length > this.o.logMax) g.log.shift(); this.touch(g); for (const f of this.msgListeners.get(g.code) || []) f(msg); return msg; }
  say(code, token, type) {
    const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended'); type = String(type ?? '');
    if (!Object.prototype.hasOwnProperty.call(QUICK, type)) throw new HttpError(400, 'invalid message type');
    m.lastSeen = this.now(); return this.pushMsg(g, { id: crypto.randomBytes(5).toString('hex'), kind: 'quick', type, text: QUICK[type], from: m.name, fromId: m.id, at: this.now() });
  }
  purgeClips(g) { if (!g.clips) return; const t = this.now(); for (const [id, c] of g.clips) if (t - c.at > this.o.clipTtlMs) g.clips.delete(id); }
  addClip(code, token, buf, mime, durMs) {
    const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended');
    if (!buf || !buf.length) throw new HttpError(400, 'empty clip'); if (buf.length > this.o.maxClipBytes) throw new HttpError(413, 'clip too large');
    if (!g.clips) g.clips = new Map(); this.purgeClips(g);
    let bytes = 0; for (const c of g.clips.values()) bytes += c.buf.length;
    if (g.clips.size >= this.o.maxClipsPerGroup || bytes + buf.length > this.o.maxBytesPerGroup) throw new HttpError(429, 'too many voice clips in this group right now, try again in a minute');
    const id = crypto.randomBytes(8).toString('hex'); const dur = Math.max(0, Math.min(this.o.maxClipMs, Math.round(Number(durMs) || 0)));
    g.clips.set(id, { buf, mime, at: this.now(), fromId: m.id }); m.lastSeen = this.now();
    return this.pushMsg(g, { id, kind: 'voice', clipId: id, mime, size: buf.length, dur, from: m.name, fromId: m.id, at: this.now(), expiresAt: this.now() + this.o.clipTtlMs });
  }
  getClip(code, token, id) { const { g } = this.auth(code, token); this.purgeClips(g); const c = g.clips && g.clips.get(String(id)); if (!c) throw new HttpError(404, 'clip expired or not found'); return c; }
  recentLog(g) { this.purgeClips(g); return (g.log || []).slice(-20).map(x => x.kind === 'voice' && !(g.clips && g.clips.has(x.clipId)) ? Object.assign({}, x, { expired: true }) : x); }
  subscribeMsg(code, f) { let s = this.msgListeners.get(code); if (!s) this.msgListeners.set(code, s = new Set()); s.add(f); return () => s.delete(f); }
  snapshot(g) {
    const t = this.now();
    return { code: g.code, now: t, dest: g.dest, adminId: g.adminId, members: [...g.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color, isAdmin: m.id === g.adminId, ended: !!m.ended, lat: m.ended ? null : (m.pos?.lat ?? null), lng: m.ended ? null : (m.pos?.lng ?? null), acc: m.acc, speed: m.speed, lastSeen: m.lastSeen, posAt: m.posAt ?? null, movedAt: m.movedAt, alert: this.alertOf(m) })) };
  }
  sweep() { const t = this.now(); let n = 0;
    for (const [c, g] of this.groups) { const empty = g.members.size === 0 && t - g.lastActivity > this.o.emptyTtlMs;
      const abandoned = this.o.abandonedTtlMs > 0 && g.members.size > 0 && [...g.members.values()].every(m => t - m.lastSeen > this.o.abandonedTtlMs);
      if (empty || abandoned) { this.groups.delete(c); n++; this.closeAll(c); } }
    for (const g of this.groups.values()) this.purgeClips(g);
    for (const [c, tb] of this.tombs) if (t - tb.at > this.o.tombstoneMs) this.tombs.delete(c);
    return n; }
  closeAll(code) { this.msgListeners.delete(code); for (const f of this.listeners.get(code) || []) f(null); this.listeners.delete(code); }
  subscribe(code, f) { let s = this.listeners.get(code); if (!s) this.listeners.set(code, s = new Set()); s.add(f); return () => s.delete(f); }
  flush() { for (const g of this.groups.values()) if (g.dirty) { g.dirty = false; const snap = this.snapshot(g); for (const f of this.listeners.get(g.code) || []) f(snap); } }
}
// Minimal sliding-window limiter keyed by string.
class Limiter {
  constructor(now = () => Date.now()) { this.now = now; this.h = new Map(); }
  hit(key, max, windowMs) { const t = this.now(); const a = (this.h.get(key) || []).filter(x => t - x < windowMs);
    if (a.length >= max) { this.h.set(key, a); return false; } a.push(t); this.h.set(key, a); return true; }
  count(key, windowMs) { const t = this.now(); return (this.h.get(key) || []).filter(x => t - x < windowMs).length; }
  gc(maxAge = 3600e3) { const t = this.now(); for (const [k, a] of this.h) if (!a.length || t - a[a.length - 1] > maxAge) this.h.delete(k); }
}
module.exports = { QUICK, VOICE, ALERT_TYPES, GroupStore, Limiter, HttpError, dist, COLORS };
