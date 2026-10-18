'use strict';
// Feedback reports: validation/sanitising + append-only JSONL storage. No IP address, no location is stored.
// NOTE: on Render's free plan the disk is ephemeral (wiped on every deploy/restart/spin-down). Read reports with GET /api/feedback + ADMIN_TOKEN regularly, or point FEEDBACK_FILE at a persistent disk.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const TYPES = ['bug', 'idea', 'other'];
const MAX = { message: 2000, contact: 200, ver: 24, short: 60, ua: 300 };
const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '').replace(/[<>]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '';
// Only whitelisted fields are kept; anything else (e.g. lat/lng) is dropped.
function sanitize(b) {
  if (!b || typeof b !== 'object') return { error: 'invalid body' };
  const type = clean(b.type, 10).toLowerCase(); if (!TYPES.includes(type)) return { error: 'type must be bug, idea or other' };
  const message = clean(b.message, MAX.message).replace(/\n{3,}/g, '\n\n'); // note: clean() keeps \n (0x0a)
  if (message.length < 5) return { error: 'message too short (min 5 characters)' };
  const m = b.meta && typeof b.meta === 'object' ? b.meta : {};
  const meta = { ver: clean(m.ver, MAX.ver), ua: clean(m.ua, MAX.ua), platform: clean(m.platform, MAX.short), lang: clean(m.lang, 20), screen: clean(m.screen, 24), standalone: m.standalone === true, online: m.online === true };
  return { value: { type, message, contact: clean(b.contact, MAX.contact), meta } };
}
class FeedbackStore {
  constructor(file, maxBytes = 5e6, now = () => Date.now()) { this.file = file || process.env.FEEDBACK_FILE || path.join(os.tmpdir(), 'riderkit-feedback.jsonl'); this.maxBytes = maxBytes; this.now = now; }
  add(v) {
    let size = 0; try { size = fs.statSync(this.file).size; } catch {}
    if (size >= this.maxBytes) return false;
    const rec = Object.assign({ id: crypto.randomBytes(5).toString('hex'), at: new Date(this.now()).toISOString() }, v);
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); return rec;
  }
  list(limit = 200) { let t; try { t = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    return t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse(); }
}
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
module.exports = { sanitize, FeedbackStore, safeEq, TYPES, MAX };
