'use strict';
// In-memory group store. No I/O, injectable clock -> unit-testable.
const crypto = require('crypto');
const COLORS = ['#ff7a1a', '#3aa0ff', '#5ccf7a', '#e84a8a', '#b07cff', '#ffd23a', '#2ed3c6', '#ff5a4a', '#9bd13a', '#c98a5a'];
const OPTS = { ttlMs: 24 * 3600e3, maxGroups: 1000, maxMembers: 30, moveMeters: 25 };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const rad = d => d * Math.PI / 180;
function dist(a, b) { const R = 6371000, dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const cleanName = (s, max = 24) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const num = (v, lo, hi) => { const n = typeof v === 'number' ? v : NaN; if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'invalid number'); return n; };
const optNum = (v, lo, hi) => (v == null ? null : (Number.isFinite(v) && v >= lo && v <= hi ? v : null));

class GroupStore {
  constructor(opts = {}, now = () => Date.now()) { this.o = Object.assign({}, OPTS, opts); this.now = now; this.groups = new Map(); this.listeners = new Map(); }
  newCode() { for (let i = 0; i < 50; i++) { const c = 'RIDE-' + (1000 + crypto.randomInt(9000)); if (!this.groups.has(c)) return c; } throw new HttpError(503, 'no free codes, try later'); }
  normCode(c) { c = String(c ?? '').toUpperCase().replace(/\s/g, ''); if (/^\d{4}$/.test(c)) c = 'RIDE-' + c; return c.replace(/^RIDE(\d{4})$/, 'RIDE-$1'); }
  get(code) { const g = this.groups.get(this.normCode(code)); if (!g) throw new HttpError(404, 'group not found or expired'); return g; }
  addMember(g, name) {
    if (g.members.size >= this.o.maxMembers) throw new HttpError(409, 'group is full');
    const nm = cleanName(name); if (!nm) throw new HttpError(400, 'rider name required');
    const used = new Set([...g.members.values()].map(m => m.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[g.members.size % COLORS.length];
    const m = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name: nm, color, joinedAt: this.now(), lastSeen: this.now(), pos: null, speed: null, acc: null, movedAt: null, anchor: null };
    g.members.set(m.id, m); return m;
  }
  create(name) {
    if (this.groups.size >= this.o.maxGroups) throw new HttpError(503, 'server busy');
    const g = { code: this.newCode(), createdAt: this.now(), lastActivity: this.now(), members: new Map(), dest: null, dirty: true };
    const m = this.addMember(g, name); this.groups.set(g.code, g); return { g, m };
  }
  join(code, name) { const g = this.get(code); const m = this.addMember(g, name); this.touch(g); return { g, m }; }
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
    if (!m.anchor || dist(m.anchor, pos) >= this.o.moveMeters) { m.anchor = pos; m.movedAt = t; }
    this.touch(g); return g;
  }
  leave(code, token) { const { g, m } = this.auth(code, token); g.members.delete(m.id); if (!g.members.size) this.groups.delete(g.code); else this.touch(g); return g; }
  snapshot(g) {
    const t = this.now();
    return { code: g.code, now: t, dest: g.dest, members: [...g.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color, lat: m.pos?.lat ?? null, lng: m.pos?.lng ?? null, acc: m.acc, speed: m.speed, lastSeen: m.lastSeen, posAt: m.posAt ?? null, movedAt: m.movedAt })) };
  }
  sweep() { const t = this.now(); let n = 0; for (const [c, g] of this.groups) if (t - g.lastActivity > this.o.ttlMs) { this.groups.delete(c); n++; this.closeAll(c); } return n; }
  closeAll(code) { for (const f of this.listeners.get(code) || []) f(null); this.listeners.delete(code); }
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
module.exports = { GroupStore, Limiter, HttpError, dist, COLORS };
