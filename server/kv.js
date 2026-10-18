'use strict';
// Swappable key-value storage for accounts: MemoryKV (tests), FileKV (default, one JSON file), PgKV (Postgres, e.g. Neon; needs the optional `pg` package).
// Interface (all async): get(ns,k) set(ns,k,v,expiresAtMs?) add(ns,k,v,expiresAtMs?)->bool (only if absent) del(ns,k) scan(ns)->[[k,v]] purge()
const fs = require('fs'), path = require('path');
class MemoryKV {
  constructor(now = () => Date.now()) { this.now = now; this.m = new Map(); this.kind = 'memory'; }
  _live(e) { return e && (!e.exp || e.exp > this.now()); }
  async get(ns, k) { const e = this.m.get(ns + '\0' + k); if (!this._live(e)) { if (e) { this.m.delete(ns + '\0' + k); this._changed(); } return null; } return JSON.parse(e.v); }
  async set(ns, k, v, exp) { this.m.set(ns + '\0' + k, { v: JSON.stringify(v), exp: exp || 0 }); this._changed(); }
  async add(ns, k, v, exp) { if (this._live(this.m.get(ns + '\0' + k))) return false; this.m.set(ns + '\0' + k, { v: JSON.stringify(v), exp: exp || 0 }); this._changed(); return true; } // synchronous check+set: atomic within the event loop
  async del(ns, k) { const had = this.m.delete(ns + '\0' + k); if (had) this._changed(); return had; }
  async scan(ns) { const out = []; for (const [key, e] of this.m) if (key.startsWith(ns + '\0') && this._live(e)) out.push([key.slice(ns.length + 1), JSON.parse(e.v)]); return out; }
  async purge() { let n = 0; for (const [key, e] of this.m) if (!this._live(e)) { this.m.delete(key); n++; } if (n) this._changed(); return n; }
  _changed() {}
  async close() {}
}
class FileKV extends MemoryKV {
  constructor(file, now) { super(now); this.kind = 'file'; this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); for (const [k, e] of Object.entries(o)) this.m.set(k, e); } catch (e) { if (e.code !== 'ENOENT') throw new Error('account store unreadable: ' + file + ' (' + e.message + ')'); }
    this.purge(); }
  _changed() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.m)), { mode: 0o600 }); fs.renameSync(tmp, this.file); } // atomic replace
}
class PgKV {
  constructor(url, now = () => Date.now()) { this.kind = 'postgres'; this.now = now; let pg; try { pg = require('pg'); } catch { throw new Error('DATABASE_URL is set but the "pg" package is not installed (run npm install pg)'); }
    this.pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 }); this.ready = this.pool.query('CREATE TABLE IF NOT EXISTS rk_kv (ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL, exp bigint NOT NULL DEFAULT 0, PRIMARY KEY (ns, k))'); }
  async q(sql, args) { await this.ready; return this.pool.query(sql, args); }
  async get(ns, k) { const r = await this.q('SELECT v FROM rk_kv WHERE ns=$1 AND k=$2 AND (exp=0 OR exp>$3)', [ns, k, this.now()]); return r.rows[0] ? r.rows[0].v : null; }
  async set(ns, k, v, exp) { await this.q('INSERT INTO rk_kv(ns,k,v,exp) VALUES($1,$2,$3,$4) ON CONFLICT (ns,k) DO UPDATE SET v=EXCLUDED.v, exp=EXCLUDED.exp', [ns, k, JSON.stringify(v), exp || 0]); }
  async add(ns, k, v, exp) { await this.q('DELETE FROM rk_kv WHERE ns=$1 AND k=$2 AND exp>0 AND exp<=$3', [ns, k, this.now()]); const r = await this.q('INSERT INTO rk_kv(ns,k,v,exp) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ns, k, JSON.stringify(v), exp || 0]); return r.rowCount === 1; }
  async del(ns, k) { const r = await this.q('DELETE FROM rk_kv WHERE ns=$1 AND k=$2', [ns, k]); return r.rowCount > 0; }
  async scan(ns) { const r = await this.q('SELECT k,v FROM rk_kv WHERE ns=$1 AND (exp=0 OR exp>$2)', [ns, this.now()]); return r.rows.map(x => [x.k, x.v]); }
  async purge() { const r = await this.q('DELETE FROM rk_kv WHERE exp>0 AND exp<=$1', [this.now()]); return r.rowCount; }
  async close() { await this.pool.end(); }
}
function openKV(env = process.env, now) {
  if (env.DATABASE_URL) return new PgKV(env.DATABASE_URL, now);
  return new FileKV(env.ACCOUNTS_FILE || path.join(env.DATA_DIR || path.resolve(__dirname, '..', 'data'), 'accounts.json'), now);
}
module.exports = { MemoryKV, FileKV, PgKV, openKV };
