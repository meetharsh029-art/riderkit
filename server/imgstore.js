'use strict';
// Image handling for the community: validation + metadata stripping (server side, whatever the client did) and swappable storage adapters.
//   IMAGE_STORE=s3     S3-compatible object store over HTTPS with AWS SigV4 (Backblaze B2, Supabase Storage, Cloudflare R2, AWS S3, MinIO ...). Config via IMAGE_S3_* env vars.
//   IMAGE_STORE=local  files under IMAGE_DIR (default <app>/data/images). For development; on Render free the disk is wiped on restart.
//   IMAGE_STORE=memory tests.
// Adapter interface (all async): put(key, buf, mime), get(key) -> {buf, mime} | null, del(key) -> bool, kind.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { HttpError } = require('./groups');

// ---------- magic bytes, dimensions, metadata stripping ----------
const MAX_SIDE = 4096, MAX_PIXELS = 16e6;
function sniff(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length > 20 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const bad = m => new HttpError(400, m);
function stripJpeg(b) {
  const out = [b.subarray(0, 2)]; let i = 2, w = 0, h = 0, sos = false;
  while (i < b.length) {
    if (b[i] !== 0xff) throw bad('damaged JPEG'); while (b[i] === 0xff) i++; const m = b[i++]; if (m === undefined) throw bad('damaged JPEG');
    if (m === 0xd9) break; if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(Buffer.from([0xff, m])); continue; }
    if (i + 2 > b.length) throw bad('damaged JPEG'); const len = b.readUInt16BE(i); if (len < 2 || i + len > b.length) throw bad('damaged JPEG'); const seg = b.subarray(i - 2, i + len);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { if (len < 8) throw bad('damaged JPEG'); h = b.readUInt16BE(i + 3); w = b.readUInt16BE(i + 5); }
    const keep = m === 0xe0 || m === 0xee || !(m >= 0xe1 && m <= 0xef || m === 0xfe); // drop EXIF/XMP/ICC/IPTC (APP1-APP15 except Adobe APP14) and comments
    if (keep) out.push(seg); i += len;
    if (m === 0xda) { sos = true; const end = b.lastIndexOf(Buffer.from([0xff, 0xd9])); if (end < i) throw bad('truncated JPEG'); out.push(b.subarray(i, end + 2)); i = b.length; break; } // scan data copied verbatim; anything after the last EOI marker is dropped
  }
  if (!sos || !w || !h) throw bad('not a valid JPEG'); return { buf: Buffer.concat(out), w, h };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
function stripPng(b) {
  const out = [b.subarray(0, 8)]; let i = 8, w = 0, h = 0, idat = 0, iend = false, first = true; const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
  while (i + 12 <= b.length && !iend) { const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8); if (len > b.length || i + 12 + len > b.length) throw bad('damaged PNG');
    if (b.readUInt32BE(i + 8 + len) !== crc32(b.subarray(i + 4, i + 8 + len))) throw bad('damaged PNG');
    if (first && type !== 'IHDR') throw bad('not a valid PNG'); first = false; if (type === 'IHDR') { if (len !== 13) throw bad('not a valid PNG'); w = b.readUInt32BE(i + 8); h = b.readUInt32BE(i + 12); }
    if (type === 'acTL') throw bad('animated images are not supported'); if (type === 'IDAT') idat++; if (type === 'IEND') iend = true;
    if (KEEP.has(type)) out.push(b.subarray(i, i + 12 + len)); i += 12 + len; }
  if (!w || !h || !idat || !iend) throw bad('not a valid PNG'); return { buf: Buffer.concat(out), w, h };
}
function stripWebp(b) {
  if (b.readUInt32LE(4) + 8 > b.length) throw bad('damaged WebP'); const end = Math.min(b.length, b.readUInt32LE(4) + 8), kept = []; let i = 12, w = 0, h = 0, vp = 0, vp8x = -1;
  while (i + 8 <= end) { const t = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), pad = len & 1, tot = 8 + len + pad; if (i + 8 + len > end) throw bad('damaged WebP');
    if (t === 'ANIM' || t === 'ANMF') throw bad('animated images are not supported'); const d = b.subarray(i + 8, i + 8 + len);
    if (t === 'VP8X') { if (len < 10) throw bad('damaged WebP'); if (d[0] & 2) throw bad('animated images are not supported'); w = 1 + (d[4] | d[5] << 8 | d[6] << 16); h = 1 + (d[7] | d[8] << 8 | d[9] << 16); const nd = Buffer.from(d); nd[0] &= ~(0x20 | 0x08 | 0x04 | 0x02); vp8x = kept.length; kept.push(Buffer.concat([Buffer.from('VP8X'), le32(len), nd, Buffer.alloc(pad)])); }
    else if (t === 'VP8 ' || t === 'VP8L' || t === 'ALPH') { if (t === 'VP8 ') { vp++; if (len < 10 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw bad('damaged WebP'); if (!w) { w = d.readUInt16LE(6) & 0x3fff; h = d.readUInt16LE(8) & 0x3fff; } } if (t === 'VP8L') { vp++; if (len < 5 || d[0] !== 0x2f) throw bad('damaged WebP'); const v = d.readUInt32LE(1); if (!w) { w = (v & 0x3fff) + 1; h = ((v >> 14) & 0x3fff) + 1; } } kept.push(b.subarray(i, i + tot)); } // EXIF, XMP, ICCP and unknown chunks are dropped
    i += tot; }
  if (!vp || !w || !h) throw bad('not a valid WebP'); const body = Buffer.concat([Buffer.from('WEBP'), ...kept]); return { buf: Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]), w, h };
}
const le32 = n => { const x = Buffer.alloc(4); x.writeUInt32LE(n); return x; };
// Validates, strips metadata and returns {buf, mime, w, h, ext}. `declared` = Content-Type sent by the client; it must agree with the real bytes.
function sanitizeImage(raw, declared, { maxBytes = 1e6 } = {}) {
  if (!Buffer.isBuffer(raw) || !raw.length) throw bad('no image received'); if (raw.length > maxBytes) throw new HttpError(413, 'image too large (max ' + Math.round(maxBytes / 1000) + ' KB after the app shrinks it)');
  const mime = sniff(raw); if (!mime) throw new HttpError(415, 'only JPEG, PNG and WebP images are accepted'); const d = String(declared || '').split(';')[0].trim().toLowerCase(); if (d && d !== 'application/octet-stream' && d !== mime) throw new HttpError(415, 'file type does not match its content');
  const r = mime === 'image/jpeg' ? stripJpeg(raw) : mime === 'image/png' ? stripPng(raw) : stripWebp(raw);
  if (r.w < 16 || r.h < 16 || r.w > MAX_SIDE || r.h > MAX_SIDE || r.w * r.h > MAX_PIXELS) throw bad('image dimensions not allowed (16 to ' + MAX_SIDE + ' px)');
  return { buf: r.buf, mime, w: r.w, h: r.h, ext: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] };
}
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ---------- adapters ----------
class MemoryImageStore { constructor() { this.kind = 'memory'; this.m = new Map(); }
  async put(k, buf, mime) { this.m.set(k, { buf: Buffer.from(buf), mime }); } async get(k) { const e = this.m.get(k); return e ? { buf: Buffer.from(e.buf), mime: e.mime } : null; } async del(k) { return this.m.delete(k); } }
class LocalImageStore { constructor(dir) { this.kind = 'local'; this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  file(k) { if (!/^[a-z0-9/_-]+\.(jpg|png|webp)$/.test(k) || k.includes('..')) throw new Error('bad image key'); return path.join(this.dir, k); }
  async put(k, buf) { const f = this.file(k); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); const t = f + '.tmp'; fs.writeFileSync(t, buf, { mode: 0o600 }); fs.renameSync(t, f); }
  async get(k) { try { return { buf: fs.readFileSync(this.file(k)), mime: MIME_BY_EXT[k.split('.').pop()] }; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async del(k) { try { fs.unlinkSync(this.file(k)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } } }

// AWS Signature Version 4 with node:crypto only. `headers` must include host; returns the Authorization header value.
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest(), sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uriEnc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function signV4({ method, pathname, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort(), low = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canon = [method, pathname.split('/').map(seg => uriEnc(decodeURIComponent(seg))).join('/'), query, names.map(n => n + ':' + low[n] + '\n').join(''), names.join(';'), payloadHash].join('\n');
  const day = amzDate.slice(0, 8), scope = day + '/' + region + '/' + service + '/aws4_request', sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canon)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request'), signature = crypto.createHmac('sha256', key).update(sts).digest('hex');
  return { authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature, signature, canonical: canon };
}
class S3ImageStore {
  constructor({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, pathStyle = true, prefix = '', fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 15000 }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 image store needs endpoint, bucket, key id and secret'); this.kind = 's3'; this.o = { endpoint: String(endpoint).replace(/\/+$/, ''), region, bucket, accessKeyId, secretAccessKey, pathStyle, prefix, fetchFn, now, timeoutMs }; }
  url(k) { const u = new URL(this.o.endpoint), key = (this.o.prefix + k).split('/').map(uriEnc).join('/');
    if (this.o.pathStyle) { u.pathname = (u.pathname.replace(/\/+$/, '') + '/' + this.o.bucket + '/' + key).replace(/\/{2,}/g, '/'); } else { u.hostname = this.o.bucket + '.' + u.hostname; u.pathname = (u.pathname.replace(/\/+$/, '') + '/' + key).replace(/\/{2,}/g, '/'); } return u; }
  async call(method, k, body, mime) {
    const u = this.url(k), amzDate = new Date(this.o.now()).toISOString().replace(/[:-]|\.\d{3}/g, ''), ph = sha(body || ''), headers = { host: u.host, 'x-amz-content-sha256': ph, 'x-amz-date': amzDate }; if (mime) headers['content-type'] = mime;
    const sg = signV4({ method, pathname: u.pathname, headers, payloadHash: ph, accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, region: this.o.region, amzDate }); const h = Object.assign({}, headers, { authorization: sg.authorization }); delete h.host;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), this.o.timeoutMs); try { return await this.o.fetchFn(u.href, { method, headers: h, body: body || undefined, signal: ctl.signal }); } finally { clearTimeout(t); } }
  async put(k, buf, mime) { const r = await this.call('PUT', k, buf, mime); if (!r.ok) throw new Error('image store PUT failed: HTTP ' + r.status); }
  async get(k) { const r = await this.call('GET', k); if (r.status === 404 || r.status === 403 && false) return null; if (!r.ok) throw new Error('image store GET failed: HTTP ' + r.status); return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || MIME_BY_EXT[k.split('.').pop()] }; }
  async del(k) { const r = await this.call('DELETE', k); if (r.status === 404) return false; if (!r.ok) throw new Error('image store DELETE failed: HTTP ' + r.status); return true; }
}
// Choose the adapter from the environment. Returns null when photos cannot be stored safely (production without S3 settings), in which case uploads answer 503 and posts are text/stats only.
function makeImageStore(env = process.env) {
  const kind = env.IMAGE_STORE || (env.IMAGE_S3_BUCKET ? 's3' : ((env.NODE_ENV === 'production' && env.COMMUNITY_ALLOW_EPHEMERAL !== '1') ? '' : 'local'));
  if (kind === 's3') return new S3ImageStore({ endpoint: env.IMAGE_S3_ENDPOINT, region: env.IMAGE_S3_REGION || 'auto', bucket: env.IMAGE_S3_BUCKET, accessKeyId: env.IMAGE_S3_KEY_ID, secretAccessKey: env.IMAGE_S3_SECRET, pathStyle: env.IMAGE_S3_PATH_STYLE !== '0', prefix: env.IMAGE_S3_PREFIX || '' });
  if (kind === 'local') return new LocalImageStore(env.IMAGE_DIR || path.resolve(__dirname, '..', 'data', 'images'));
  if (kind === 'memory') return new MemoryImageStore(); return null;
}
module.exports = { sniff, sanitizeImage, stripJpeg, stripPng, stripWebp, signV4, MemoryImageStore, LocalImageStore, S3ImageStore, makeImageStore, MIME_BY_EXT, MAX_SIDE };
