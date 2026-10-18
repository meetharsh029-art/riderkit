'use strict';
// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291 aes128gcm) using ONLY node:crypto. No npm dependency, no paid service
// (delivery goes through the browser vendor's free push service: FCM / Mozilla autopush / Apple / WNS).
// Stored per browser subscription: the push endpoint + its keys, a timezone offset and a small list of reminders {id, title, due YYYY-MM-DD, kind}.
// No name, e-mail, location or vehicle details are stored. Entries expire 400 days after the last sync.
const crypto = require('crypto');
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)web\.push\.apple\.com$/];
const LEADS = [30, 7, 1, 0]; // days-before stages; plus one "overdue" stage (-1)
const KINDS = ['doc', 'service', 'tyre'];
const MAXREM = 60, SUB_TTL = 400 * 864e5, MAX_SUBS = 5000;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const dayNum = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s)); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return new Date(t).toISOString().slice(0, 10) === s ? t / 864e5 : null; };

function makeVapid(env = {}) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY, from: 'env' };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pj = publicKey.export({ format: 'jwk' }), sj = privateKey.export({ format: 'jwk' });
  return { pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(pj.x), unb64u(pj.y)])), priv: sj.d, from: 'generated' };
}
function privKey(v) { const pub = unb64u(v.pub); return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: v.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' }); }
function vapidAuth(v, endpoint, sub, nowMs) {
  const aud = new URL(endpoint).origin, h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), c = b64u(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + c), { key: privKey(v), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + h + '.' + c + '.' + b64u(sig) + ', k=' + v.pub;
}
// RFC 8291 aes128gcm, single record. ua = { p256dh, auth } base64url.
function encrypt(payload, ua, opts = {}) {
  const uaPub = unb64u(ua.p256dh), auth = unb64u(ua.auth); if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length !== 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1'); if (opts.asPriv) ecdh.setPrivateKey(opts.asPriv); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPub), salt = opts.salt || crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const pt = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); if (pt.length > 3993) throw new Error('payload too large');
  const ci = crypto.createCipheriv('aes-128-gcm', cek, nonce), ct = Buffer.concat([ci.update(pt), ci.final(), ci.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([65]), asPub, ct]);
}
// Which stage is a reminder at? Returns 30/7/1/0 (days-before windows), -1 overdue (up to 14 days), or null (nothing to send).
function stageFor(daysLeft) { if (daysLeft < 0) return daysLeft >= -14 ? -1 : null; for (const l of [0, 1, 7, 30]) if (daysLeft <= l) return l; return null; }
const stageText = (r, days) => days < 0 ? 'was due ' + (-days) + ' day' + (days === -1 ? '' : 's') + ' ago' : days === 0 ? 'is due today' : days === 1 ? 'is due tomorrow' : 'is due in ' + days + ' days';

function validEndpoint(u, allow) {
  let x; try { x = new URL(u); } catch { return false; } if (x.protocol !== 'https:' || u.length > 600 || x.username || x.password) return false;
  return allow ? allow(x) : HOSTS.some(r => r.test(x.hostname));
}
function sanitizeSub(b, allow) {
  if (!b || typeof b !== 'object') throw Object.assign(new Error('invalid body'), { status: 400 });
  const s = b.subscription || {}, k = s.keys || {}; if (!validEndpoint(s.endpoint, allow)) throw Object.assign(new Error('unsupported push endpoint'), { status: 400 });
  try { const p = unb64u(k.p256dh), a = unb64u(k.auth); if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw 0; } catch { throw Object.assign(new Error('invalid push keys'), { status: 400 }); }
  const tz = Number.isFinite(b.tz) && Math.abs(b.tz) <= 840 ? Math.round(b.tz) : 0; // minutes EAST of UTC (India = 330)
  const seen = new Set(), rem = []; for (const r of Array.isArray(b.reminders) ? b.reminders : []) { if (rem.length >= MAXREM) break; if (!r || typeof r !== 'object') continue;
    const id = clean(r.id, 40), due = String(r.due || ''); if (!id || seen.has(id) || dayNum(due) === null) continue; seen.add(id);
    rem.push({ id, title: clean(r.title, 60) || 'Reminder', due, kind: KINDS.includes(r.kind) ? r.kind : 'doc' }); }
  return { endpoint: s.endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, tz, reminders: rem };
}
class PushService {
  // kv: async KV (see kv.js). fetchImpl: injectable for tests. now: injectable clock.
  constructor({ kv, env = process.env, fetchImpl, now = () => Date.now(), allowEndpoint, subject } = {}) {
    this.kv = kv; this.env = env; this.fetch = fetchImpl || ((...a) => fetch(...a)); this.now = now; this.allow = allowEndpoint; this.subject = subject || env.VAPID_SUBJECT || 'https://riderkit.onrender.com'; this._v = null; this.stats = { sent: 0, failed: 0, gone: 0 }; }
  async vapid() { if (this._v) return this._v; let v = (this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY) ? makeVapid(this.env) : await this.kv.get('push', 'vapid');
    if (!v) { v = makeVapid({}); if (!(await this.kv.add('push', 'vapid', v))) v = await this.kv.get('push', 'vapid'); } return (this._v = v); }
  async publicKey() { return (await this.vapid()).pub; }
  id(endpoint) { return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32); }
  async sync(body) {
    const s = sanitizeSub(body, this.allow), id = this.id(s.endpoint), old = await this.kv.get('pushsub', id);
    if (!old && (await this.kv.scan('pushsub')).length >= MAX_SUBS) throw Object.assign(new Error('push is full, try later'), { status: 503 });
    const sent = {}; if (old) for (const r of s.reminders) { const o = old.reminders.find(x => x.id === r.id); if (o && o.due === r.due && old.sent) for (const k of Object.keys(old.sent)) if (k.startsWith(r.id + '@')) sent[k] = old.sent[k]; } // changed date => reminders restart
    const rec = { ...s, sent, createdAt: old ? old.createdAt : this.now(), syncedAt: this.now() }; await this.kv.set('pushsub', id, rec, this.now() + SUB_TTL); return { ok: true, reminders: s.reminders.length };
  }
  async remove(endpoint) { return this.kv.del('pushsub', this.id(String(endpoint || ''))); }
  async deliver(sub, msg) {
    const v = await this.vapid(); let body; try { body = encrypt(JSON.stringify(msg), sub.keys); } catch { return 'bad'; }
    let r; try { r = await this.fetch(sub.endpoint, { method: 'POST', headers: { authorization: vapidAuth(v, sub.endpoint, this.subject, this.now()), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(msg.ttl || 86400), urgency: 'normal' }, body, signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined }); }
    catch { this.stats.failed++; return 'error'; }
    if (r.status === 404 || r.status === 410) { this.stats.gone++; return 'gone'; } if (r.status >= 200 && r.status < 300) { this.stats.sent++; return 'ok'; } this.stats.failed++; return 'error';
  }
  async test(endpoint) { const id = this.id(String(endpoint || '')), sub = await this.kv.get('pushsub', id); if (!sub) throw Object.assign(new Error('not subscribed'), { status: 404 });
    const r = await this.deliver(sub, { title: 'RiderKit', body: 'Reminders are on. This is a test notification.', tag: 'rk-test', url: './' }); if (r === 'gone') await this.kv.del('pushsub', id); return { ok: r === 'ok', result: r }; }
  // Send due reminders (called from a timer). Local time 08:00-21:00 only; at most 3 notifications per subscription per sweep.
  async sweep() {
    let n = 0; for (const [id, sub] of await this.kv.scan('pushsub')) {
      const local = new Date(this.now() + sub.tz * 60e3), hr = local.getUTCHours(); if (hr < 8 || hr >= 21) continue;
      const today = Math.floor(local.getTime() / 864e5); let c = 0, changed = false;
      for (const r of sub.reminders) { if (c >= 3) break; const days = dayNum(r.due) - today, st = stageFor(days); if (st === null) continue; const key = r.id + '@' + st; if (sub.sent[key]) continue;
        const res = await this.deliver(sub, { title: 'RiderKit: ' + r.title, body: r.title + ' ' + stageText(r, days) + '.', tag: 'rk-' + r.id, url: './#' + (r.kind === 'doc' ? 'docs' : 'service'), ttl: 86400 });
        if (res === 'gone') { await this.kv.del('pushsub', id); changed = false; break; }
        if (res === 'ok') { sub.sent[key] = this.now(); c++; n++; changed = true; } else if (res === 'bad') { await this.kv.del('pushsub', id); changed = false; break; } }
      if (changed) await this.kv.set('pushsub', id, sub, sub.syncedAt + SUB_TTL);
    } return n;
  }
}
module.exports = { PushService, encrypt, vapidAuth, makeVapid, stageFor, sanitizeSub, validEndpoint, dayNum, HOSTS, b64u, unb64u };
