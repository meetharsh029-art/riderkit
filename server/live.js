'use strict';
// Solo-ride live-share links (read-only for family). In MEMORY ONLY (never written to disk/DB). Unguessable 128-bit id for viewers, separate secret key for the rider.
// Expires at a rider-chosen time (max 12 h) or when the rider stops; after that the link says "expired/ended" for 1 h, then 404. Keeps only the latest position + a short trail.
const crypto = require('crypto');
class LiveError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const O = { maxActive: 500, trailMax: 60, trailMinMs: 15000, maxHours: 12, defaultHours: 4, tombMs: 3600e3, staleMs: 5 * 60e3 };
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const b64 = n => crypto.randomBytes(n).toString('base64url');
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const optNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
class LiveStore {
  constructor({ now = () => Date.now(), opts } = {}) { this.now = now; this.o = Object.assign({}, O, opts); this.m = new Map(); this.tomb = new Map(); }
  create(b) { this.sweep(); if (this.m.size >= this.o.maxActive) throw new LiveError(503, 'live sharing is busy, try later');
    const hrs = Math.min(this.o.maxHours, Math.max(0.25, +b.hours || this.o.defaultHours)), now = this.now();
    const s = { id: b64(16), key: b64(16), name: clean(b.name, 24), createdAt: now, expiresAt: now + hrs * 3600e3, pos: null, trail: [], updatedAt: null, ended: false };
    this.m.set(s.id, s); return { id: s.id, key: s.key, expiresAt: s.expiresAt }; }
  get(id) { id = String(id || ''); const s = this.m.get(id);
    if (s) { if (s.expiresAt <= this.now()) { this._end(s, 'expired'); } else return s; }
    const t = this.tomb.get(id); if (t && t.until > this.now()) { throw new LiveError(410, t.reason === 'ended' ? 'The rider stopped sharing.' : 'This link has expired.'); } throw new LiveError(404, 'link not found'); }
  _end(s, reason) { this.m.delete(s.id); this.tomb.set(s.id, { reason, until: this.now() + this.o.tombMs }); }
  update(id, key, b) { const s = this.get(id); if (!eq(key, s.key)) throw new LiveError(403, 'not your link');
    const lat = optNum(b.lat, -90, 90), lng = optNum(b.lng, -180, 180); if (lat === null || lng === null) throw new LiveError(400, 'invalid position'); const now = this.now();
    s.pos = { lat, lng, acc: optNum(b.acc, 0, 100000), speed: optNum(b.speed, 0, 100) }; s.updatedAt = now; const last = s.trail[s.trail.length - 1];
    if (!last || now - last.t >= this.o.trailMinMs) { s.trail.push({ lat, lng, t: now }); if (s.trail.length > this.o.trailMax) s.trail.shift(); } return { ok: true, expiresAt: s.expiresAt }; }
  stop(id, key) { const s = this.get(id); if (!eq(key, s.key)) throw new LiveError(403, 'not your link'); this._end(s, 'ended'); return { ok: true }; }
  view(id) { const s = this.get(id), now = this.now(); return { name: s.name, pos: s.pos, trail: s.trail.map(p => [p.lat, p.lng]), updatedAt: s.updatedAt, ageMs: s.updatedAt ? now - s.updatedAt : null, stale: !s.updatedAt || now - s.updatedAt > this.o.staleMs, expiresAt: s.expiresAt, now }; }
  sweep() { const now = this.now(); for (const s of [...this.m.values()]) if (s.expiresAt <= now) this._end(s, 'expired'); for (const [k, t] of this.tomb) if (t.until <= now) this.tomb.delete(k); }
}
module.exports = { LiveStore, LiveError };
