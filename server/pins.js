'use strict';
// Crowdsourced hazard + place pins. Anonymous (no account needed): a random per-install device id is only used (hashed) to limit votes/pins and stop double voting.
// Pins: pothole, puncture shop, mechanic, dhaba, fuel. Hazards expire fast unless re-confirmed; places last long. Community "gone" votes remove, reports hide, admin can remove.
// Stored: type, rounded position, short note, counts, expiry. NOT stored: IP, name, raw device id.
const crypto = require('crypto');
class PinError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const DAY = 864e5;
const TYPES = { pothole: { label: 'Pothole / bad road', hazard: true, ttl: 14 * DAY, confirmAdd: 7 * DAY, maxLife: 60 * DAY },
  puncture: { label: 'Puncture shop', hazard: false, ttl: 180 * DAY, confirmAdd: 90 * DAY, maxLife: 730 * DAY },
  mechanic: { label: 'Mechanic', hazard: false, ttl: 180 * DAY, confirmAdd: 90 * DAY, maxLife: 730 * DAY },
  dhaba: { label: 'Dhaba / food', hazard: false, ttl: 180 * DAY, confirmAdd: 90 * DAY, maxLife: 730 * DAY },
  fuel: { label: 'Fuel station', hazard: false, ttl: 180 * DAY, confirmAdd: 90 * DAY, maxLife: 730 * DAY } };
const O = { maxPins: 20000, perDevice: 40, dupMeters: 40, goneVotes: 3, hideReports: 3, maxBbox: 3, maxResults: 300, noteMax: 80 };
const rad = d => d * Math.PI / 180;
const dist = (a, b) => { const R = 6371000, dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng), h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const cleanNote = s => String(s ?? '').replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\+?\d[\d\s-]{8,}\d/g, '').replace(/\s+/g, ' ').trim().slice(0, O.noteMax); // no links, no phone numbers (spam/privacy)
const did = (raw, salt) => { const s = String(raw || ''); if (!/^[a-f0-9]{16,64}$/.test(s)) throw new PinError(400, 'invalid device id'); return crypto.createHash('sha256').update(salt + s).digest('hex').slice(0, 16); };

class PinStore {
  constructor({ kv, now = () => Date.now(), opts } = {}) { this.kv = kv; this.now = now; this.o = Object.assign({}, O, opts); this.m = new Map(); this.loaded = null; this.salt = null; this.boot = now(); }
  async load() { if (this.loaded) return this.loaded; return (this.loaded = (async () => { this.salt = (await this.kv.get('pinmeta', 'salt')) || (() => { const s = crypto.randomBytes(16).toString('hex'); this.kv.set('pinmeta', 'salt', s); return s; })();
    for (const [id, p] of await this.kv.scan('pin')) this.m.set(id, p); })()); }
  _save(p) { this.m.set(p.id, p); return this.kv.set('pin', p.id, p, p.expiresAt + DAY); }
  _drop(p) { this.m.delete(p.id); return this.kv.del('pin', p.id); }
  live(p) { return p.expiresAt > this.now() && !p.removed; }
  pub(p) { return { id: p.id, type: p.type, lat: p.lat, lng: p.lng, note: p.note, up: p.up, down: p.down, at: p.createdAt, exp: p.expiresAt, seen: p.lastConfirm }; }
  async add(b, rawDid) { await this.load(); const d = did(rawDid, this.salt); const T = TYPES[b && b.type]; if (!T) throw new PinError(400, 'unknown pin type');
    const lat = +b.lat, lng = +b.lng; if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180)) throw new PinError(400, 'invalid position');
    const pos = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 }, now = this.now();
    for (const p of this.m.values()) if (p.type === b.type && this.live(p) && !p.hidden && dist(p, pos) <= this.o.dupMeters) { const r = await this.vote(p.id, 'up', rawDid); return { pin: r.pin, merged: true }; } // same thing nearby: counts as a confirmation
    let mine = 0; for (const p of this.m.values()) if (p.by === d && this.live(p)) mine++; if (mine >= this.o.perDevice) throw new PinError(429, 'you have too many active pins, wait for some to expire');
    if (this.m.size >= this.o.maxPins) { this.sweepSync(); if (this.m.size >= this.o.maxPins) throw new PinError(503, 'pin store is full, try later'); }
    const p = { id: crypto.randomBytes(5).toString('hex'), type: b.type, ...pos, note: cleanNote(b.note), by: d, createdAt: now, lastConfirm: now, expiresAt: now + T.ttl, up: 1, down: 0, voters: { [d]: 1 }, reporters: [], hidden: false, removed: false };
    await this._save(p); return { pin: this.pub(p), merged: false };
  }
  async vote(id, dir, rawDid) { await this.load(); const d = did(rawDid, this.salt), p = this.m.get(id); if (!p || !this.live(p)) throw new PinError(404, 'pin not found or expired'); if (dir !== 'up' && dir !== 'down') throw new PinError(400, 'vote must be up or down');
    const prev = p.voters[d]; const val = dir === 'up' ? 1 : -1; if (prev === val) return { pin: this.pub(p), changed: false };
    if (prev === 1) p.up--; if (prev === -1) p.down--; if (val === 1) p.up++; else p.down++; p.voters[d] = val;
    if (Object.keys(p.voters).length > 400) delete p.voters[Object.keys(p.voters)[0]];
    const T = TYPES[p.type], now = this.now();
    if (val === 1 && prev !== 1) { p.lastConfirm = now; p.expiresAt = Math.min(Math.max(p.expiresAt, now) + T.confirmAdd, p.createdAt + T.maxLife); } // "still there" extends life, capped
    if (p.down - p.up >= this.o.goneVotes) { await this._drop(p); return { pin: null, removed: true }; } // community says it is gone
    await this._save(p); return { pin: this.pub(p), changed: true };
  }
  async report(id, rawDid, reason) { await this.load(); const d = did(rawDid, this.salt), p = this.m.get(id); if (!p || !this.live(p)) throw new PinError(404, 'pin not found or expired');
    if (!p.reporters.includes(d)) p.reporters.push(d); p.reasons = (p.reasons || []).concat(cleanNote(reason).slice(0, 40)).slice(-5); if (p.reporters.length >= this.o.hideReports) p.hidden = true; // hidden from the map until an admin restores or removes it
    await this._save(p); return { ok: true, hidden: p.hidden }; }
  async query(bb, types) { await this.load(); const [s, w, n, e] = bb; if (![s, w, n, e].every(Number.isFinite) || n < s || e < w) throw new PinError(400, 'bad bounding box'); if (n - s > this.o.maxBbox || e - w > this.o.maxBbox) throw new PinError(400, 'area too large, zoom in');
    const ts = types && types.length ? new Set(types) : null, out = []; for (const p of this.m.values()) { if (!this.live(p) || p.hidden || p.lat < s || p.lat > n || p.lng < w || p.lng > e || (ts && !ts.has(p.type))) continue; out.push(p); }
    out.sort((a, b) => (b.up - b.down) - (a.up - a.down) || b.lastConfirm - a.lastConfirm); return out.slice(0, this.o.maxResults).map(p => this.pub(p)); }
  async adminList() { await this.load(); return [...this.m.values()].filter(p => (p.hidden || p.reporters.length) && !p.removed).map(p => ({ ...this.pub(p), reports: p.reporters.length, reasons: p.reasons || [], hidden: p.hidden })); }
  async adminAct(id, act) { await this.load(); const p = this.m.get(id); if (!p) throw new PinError(404, 'pin not found'); if (act === 'remove') { await this._drop(p); return { ok: true }; } if (act === 'restore') { p.hidden = false; p.reporters = []; p.reasons = []; await this._save(p); return { ok: true }; } throw new PinError(400, 'act must be remove or restore'); }
  sweepSync() { const now = this.now(); for (const p of [...this.m.values()]) if (p.expiresAt <= now) { this.m.delete(p.id); this.kv.del('pin', p.id); } }
  async sweep() { await this.load(); this.sweepSync(); }
}
module.exports = { PinStore, PinError, TYPES, cleanNote, dist };
