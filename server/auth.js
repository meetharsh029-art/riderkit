'use strict';
// Optional rider accounts. Guests keep working: nothing in the group/ride APIs requires an account.
// Storage: KV (see kv.js). Namespaces: user(id), email(addr->id), phone(e164->id), sess(sha256(token)), pend(email|phone+purpose), meta(secret).
const crypto = require('crypto'), { promisify } = require('util');
const { HttpError, Limiter } = require('./groups');
const scrypt = promisify(crypto.scrypt);
const P = { N: 1 << 15, r: 8, p: 3 }; // OWASP-recommended scrypt parameter set (32 MiB x p=3 work); stored with each hash so it can be raised later
const MAXMEM = 256 * 1024 * 1024;
const OPTS = { codeTtlMs: 10 * 60e3, codeAttempts: 5, resendMs: 60e3, sessionTtlMs: 30 * 24 * 3600e3, pwMin: 10, pwMax: 128 };
const L0 = { ip: [60, 10 * 60e3], register: [5, 3600e3], verifyIp: [30, 10 * 60e3], loginEmailIp: [5, 15 * 60e3], loginEmail: [15, 15 * 60e3], loginIp: [30, 15 * 60e3], forgotIp: [5, 3600e3], forgotEmail: [3, 3600e3], delete: [5, 3600e3], smsIp: [5, 3600e3], smsPhone: [3, 10 * 60e3], smsDay: [50, 24 * 3600e3] };
const COMMON = new Set(['password', 'password1', 'password12', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'iloveyou123', 'letmein1234', 'welcome1234', 'admin12345', 'riderkit123', 'abcdefghij', '0123456789', 'passw0rd123']);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => { e = String(e ?? '').trim().toLowerCase(); if (e.length > 254 || !/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[a-z0-9-]{2,}$/i.test(e)) throw new HttpError(400, 'enter a valid email address'); return e; };
const normPhone = p => { p = String(p ?? '').replace(/[\s()-]/g, ''); if (!/^\+[1-9]\d{7,14}$/.test(p)) throw new HttpError(400, 'enter the phone number in international format, e.g. +919876543210'); return p; };
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pubUser = u => ({ id: u.id, email: u.email || null, phone: u.phone || null, createdAt: u.createdAt });

class Accounts {
  constructor({ kv, mailer, sms, now = () => Date.now(), opts = {}, limits = {} }) { this.kv = kv; this.mailer = mailer; this.sms = sms; this.now = now; this.o = Object.assign({}, OPTS, opts); this.L = Object.assign({}, L0, limits); this.lim = new Limiter(now); this.P = Object.assign({}, P, opts.scrypt); this.secretP = null; this.dummy = null; }
  get emailEnabled() { return !!this.mailer && this.mailer.enabled; }
  get phoneEnabled() { return !!this.sms && this.sms.enabled; }
  config() { return { email: this.emailEnabled, phone: this.phoneEnabled, pwMin: this.o.pwMin }; }
  need(ok, msg) { if (!ok) throw new HttpError(503, msg); }
  limit(key, [max, win], msg = 'too many attempts, try again later') { if (!this.lim.hit(key, max, win)) throw new HttpError(429, msg); }
  async secret() { return this.secretP || (this.secretP = (async () => { const m = await this.kv.get('meta', 'secret'); if (m) return Buffer.from(m, 'hex'); const s = crypto.randomBytes(32); if (!await this.kv.add('meta', 'secret', s.toString('hex'))) return Buffer.from(await this.kv.get('meta', 'secret'), 'hex'); return s; })()); }
  async mac(...parts) { return crypto.createHmac('sha256', await this.secret()).update(parts.join('\0')).digest('hex'); }
  // ---- passwords
  checkPassword(pw, email) { pw = String(pw ?? ''); if (pw.length < this.o.pwMin) throw new HttpError(400, 'password must be at least ' + this.o.pwMin + ' characters'); if (pw.length > this.o.pwMax) throw new HttpError(400, 'password is too long');
    if (COMMON.has(pw.toLowerCase()) || (email && pw.toLowerCase() === email) || /^(.)\1+$/.test(pw)) throw new HttpError(400, 'that password is too easy to guess, choose another'); }
  async hash(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw.normalize('NFKC'), salt, 32, { N: this.P.N, r: this.P.r, p: this.P.p, maxmem: MAXMEM }); return ['scrypt', this.P.N, this.P.r, this.P.p, salt.toString('base64'), h.toString('base64')].join('$'); }
  async verifyHash(pw, stored) { const [alg, N, r, p, salt, hash] = String(stored).split('$'); if (alg !== 'scrypt') return false; const want = Buffer.from(hash, 'base64');
    const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM }); return crypto.timingSafeEqual(got, want); }
  // ---- one-time codes (email or SMS). Stored as HMAC, expire, limited attempts, single use.
  async issueCode(kind, key, extra = {}) { const pk = kind + ':' + key; const cur = await this.kv.get('pend', pk); if (cur && this.now() - cur.at < this.o.resendMs) return null; // resend cooldown
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); await this.kv.set('pend', pk, Object.assign({ mac: await this.mac(pk, code), at: this.now(), tries: 0 }, extra), this.now() + this.o.codeTtlMs); return code; }
  async checkCode(kind, key, code) { const pk = kind + ':' + key; const rec = await this.kv.get('pend', pk); code = String(code ?? '').trim(); if (!rec) throw new HttpError(400, 'that code is wrong or expired');
    if (rec.tries >= this.o.codeAttempts) { await this.kv.del('pend', pk); throw new HttpError(400, 'that code is wrong or expired'); }
    if (!/^\d{6}$/.test(code) || !eq(await this.mac(pk, code), rec.mac)) { rec.tries++; if (rec.tries >= this.o.codeAttempts) await this.kv.del('pend', pk); else await this.kv.set('pend', pk, rec, rec.at + this.o.codeTtlMs); throw new HttpError(400, 'that code is wrong or expired'); }
    await this.kv.del('pend', pk); return rec; }
  async sendMail(to, subject, text) { try { await this.mailer.send(to, subject, text); } catch (e) { console.error('mail failed:', e.message); throw new HttpError(503, 'could not send the email right now, try again later'); } }
  // ---- sessions: opaque random token, only its hash is stored; sliding 30-day expiry
  async newSession(userId, ua) { const token = crypto.randomBytes(32).toString('base64url'); await this.kv.set('sess', sha(token), { userId, at: this.now(), ua: String(ua || '').slice(0, 80) }, this.now() + this.o.sessionTtlMs); return token; }
  async session(token) { if (!token || String(token).length > 100) return null; const h = sha(String(token)); const s = await this.kv.get('sess', h); if (!s) return null; const u = await this.kv.get('user', s.userId); if (!u) { await this.kv.del('sess', h); return null; }
    if (this.now() - s.at > 24 * 3600e3) { s.at = this.now(); await this.kv.set('sess', h, s, this.now() + this.o.sessionTtlMs); } return u; }
  async logout(token) { await this.kv.del('sess', sha(String(token || ''))); }
  async logoutAll(userId) { for (const [h, s] of await this.kv.scan('sess')) if (s.userId === userId) await this.kv.del('sess', h); }
  async login_ok(u, ua) { return { token: await this.newSession(u.id, ua), user: pubUser(u) }; }
  // ---- email sign-up (user is only created after the emailed code is confirmed)
  async register(ip, emailIn, pw) {
    this.need(this.emailEnabled, 'sign-up is not available yet'); this.limit('ip:' + ip, this.L.ip); this.limit('reg:' + ip, this.L.register, 'too many sign-ups from here, try later');
    const email = normEmail(emailIn); this.checkPassword(pw, email); const generic = { ok: true, verify: true };
    if (await this.kv.get('email', email)) { await this.sendMail(email, 'RiderKit sign-up', 'Someone tried to create a RiderKit account with this email address, but one already exists. If it was you, sign in or use "Forgot password". If not, ignore this message.'); return generic; }
    const pwHash = await this.hash(pw); const code = await this.issueCode('signup', email, { pwHash }); if (code === null) return generic;
    await this.sendMail(email, 'Your RiderKit verification code', 'Your RiderKit verification code is ' + code + '. It expires in 10 minutes. If you did not request it, ignore this email.'); return generic; }
  async verifyEmail(ip, emailIn, code, ua) {
    this.need(this.emailEnabled, 'sign-up is not available yet'); this.limit('ip:' + ip, this.L.ip); this.limit('ver:' + ip, this.L.verifyIp); const email = normEmail(emailIn); const rec = await this.checkCode('signup', email, code);
    const u = { id: crypto.randomBytes(12).toString('hex'), email, phone: null, pwHash: rec.pwHash, createdAt: this.now() };
    if (!await this.kv.add('email', email, u.id)) throw new HttpError(409, 'an account with this email already exists, please sign in'); await this.kv.set('user', u.id, u); return this.login_ok(u, ua); }
  // ---- login with brute-force protection: per email+IP, per email, per IP; failures only; constant work for unknown emails
  async login(ip, emailIn, pw, ua) {
    this.limit('ip:' + ip, this.L.ip); let email; try { email = normEmail(emailIn); } catch { throw new HttpError(401, 'wrong email or password'); } const k1 = 'lf:' + email + '|' + ip, k2 = 'lfe:' + email, k3 = 'lfi:' + ip;
    const lock = (k, [max, win]) => this.lim.count(k, win) >= max; if (lock(k1, this.L.loginEmailIp) || lock(k2, this.L.loginEmail) || lock(k3, this.L.loginIp)) throw new HttpError(429, 'too many failed attempts, try again in 15 minutes');
    const id = await this.kv.get('email', email); const u = id && await this.kv.get('user', id); const stored = u && u.pwHash || (this.dummy || (this.dummy = await this.hash('dummy-password-for-timing')));
    const good = typeof pw === 'string' && pw.length <= this.o.pwMax && await this.verifyHash(pw, stored).catch(() => false);
    if (!u || !u.pwHash || !good) { this.lim.hit(k1, ...this.L.loginEmailIp); this.lim.hit(k2, ...this.L.loginEmail); this.lim.hit(k3, ...this.L.loginIp); throw new HttpError(401, 'wrong email or password'); }
    this.lim.h.delete(k1); return this.login_ok(u, ua); }
  clearLocks(email) { for (const k of [...this.lim.h.keys()]) if (k === 'lfe:' + email || k.startsWith('lf:' + email + '|')) this.lim.h.delete(k); } // a successful emailed-code reset proves ownership: lift login lockouts for that address
  // ---- password reset
  async forgot(ip, emailIn) {
    this.need(this.emailEnabled, 'password reset is not available yet'); this.limit('ip:' + ip, this.L.ip); this.limit('fgi:' + ip, this.L.forgotIp); const email = normEmail(emailIn); this.limit('fge:' + email, this.L.forgotEmail, 'too many reset requests for this address, try later');
    const id = await this.kv.get('email', email); if (id) { const code = await this.issueCode('reset', email); if (code !== null) await this.sendMail(email, 'RiderKit password reset code', 'Your RiderKit password reset code is ' + code + '. It expires in 10 minutes. If you did not ask to reset your password, ignore this email; your password has not changed.'); }
    return { ok: true }; }
  async reset(ip, emailIn, code, newPw, ua) {
    this.need(this.emailEnabled, 'password reset is not available yet'); this.limit('ip:' + ip, this.L.ip); this.limit('ver:' + ip, this.L.verifyIp); const email = normEmail(emailIn); this.checkPassword(newPw, email);
    const id = await this.kv.get('email', email); if (!id) { await this.checkCode('reset', email, code).catch(() => {}); throw new HttpError(400, 'that code is wrong or expired'); }
    await this.checkCode('reset', email, code); const u = await this.kv.get('user', id); u.pwHash = await this.hash(newPw); await this.kv.set('user', id, u); await this.logoutAll(id); this.clearLocks(email); return this.login_ok(u, ua); }
  async changePassword(ip, user, oldPw, newPw, keepToken) { this.limit('ip:' + ip, this.L.ip); this.limit('cp:' + user.id, this.L.delete); if (!user.pwHash || !await this.verifyHash(String(oldPw ?? ''), user.pwHash).catch(() => false)) throw new HttpError(401, 'wrong password'); this.checkPassword(newPw, user.email);
    user.pwHash = await this.hash(newPw); await this.kv.set('user', user.id, user); await this.logoutAll(user.id); return this.login_ok(user); }
  // ---- account deletion: removes the user record, both indexes, every session and any pending codes (nothing else is stored about accounts)
  async deleteAccount(ip, user, { password, code } = {}) {
    this.limit('ip:' + ip, this.L.ip); this.limit('del:' + user.id, this.L.delete);
    if (user.pwHash) { if (!await this.verifyHash(String(password ?? ''), user.pwHash).catch(() => false)) throw new HttpError(401, 'wrong password'); }
    else { if (!user.phone) throw new HttpError(400, 'cannot confirm this account'); await this.checkCode('delete', user.phone, code); }
    await this.logoutAll(user.id); if (user.email) { await this.kv.del('email', user.email); await this.kv.del('pend', 'signup:' + user.email); await this.kv.del('pend', 'reset:' + user.email); }
    if (user.phone) { await this.kv.del('phone', user.phone); await this.kv.del('pend', 'phone:' + user.phone); await this.kv.del('pend', 'delete:' + user.phone); } await this.kv.del('user', user.id); return { ok: true, deleted: true }; }
  // ---- phone OTP (disabled unless an SMS provider is configured)
  async phoneStart(ip, phoneIn, purpose = 'phone') {
    this.need(this.phoneEnabled, 'phone login is not enabled'); this.limit('ip:' + ip, this.L.ip); this.limit('smi:' + ip, this.L.smsIp, 'too many SMS requests, try later'); const phone = normPhone(phoneIn); this.limit('smp:' + phone, this.L.smsPhone, 'too many SMS requests for this number, try later'); this.limit('smd', this.L.smsDay, 'SMS limit reached for today');
    const code = await this.issueCode(purpose, phone); if (code !== null) { try { await this.sms.send(phone, 'RiderKit code: ' + code + ' (valid 10 min)'); } catch (e) { console.error('sms failed:', e.message); throw new HttpError(503, 'could not send the SMS right now'); } } return { ok: true }; }
  async phoneVerify(ip, phoneIn, code, ua) {
    this.need(this.phoneEnabled, 'phone login is not enabled'); this.limit('ip:' + ip, this.L.ip); this.limit('ver:' + ip, this.L.verifyIp); const phone = normPhone(phoneIn); await this.checkCode('phone', phone, code);
    let id = await this.kv.get('phone', phone), u = id && await this.kv.get('user', id);
    if (!u) { u = { id: crypto.randomBytes(12).toString('hex'), email: null, phone, pwHash: null, createdAt: this.now() }; if (!await this.kv.add('phone', phone, u.id)) { id = await this.kv.get('phone', phone); u = await this.kv.get('user', id); } else await this.kv.set('user', u.id, u); }
    return this.login_ok(u, ua); }
  async sweep() { return this.kv.purge(); }
}
module.exports = { Accounts, normEmail, normPhone };
