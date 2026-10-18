# Community build progress (append-only log)

Env for tests: puppeteer `NODE_PATH=/tmp/pp/node_modules`; pg-mem `/tmp/pgmem/node_modules`; a REAL Postgres 18 (embedded-postgres, `/tmp/epg2`, port 54329) is used via `RK_KV=pg RK_PG_URL=postgres://rk:rk@localhost:54329/rk` (start: `cd /tmp/epg2 && node start.js &`). Same test files run on memory (default), file (`RK_KV=file`), pg-mem (`RK_KV=pgmem`) and real Postgres.
Deploy flow: edit /workspace/rider-app, run /workspace/sync-riderkit.sh (copies to rider-app-deploy), commit + push from rider-app-deploy.

## Stage 0+1: safety foundation + profiles (done)
- `server/community.js` (logic), `server/community-api.js` (routes `/api/community/*`), wired in `server/server.js`. Feature flag: on in dev, `COMMUNITY=1` in production; in production it refuses non-Postgres storage unless `COMMUNITY_ALLOW_EPHEMERAL=1`.
- KV gained `range(ns,{prefix,after,desc,limit})` and `count(ns,prefix)` (memory/file/Postgres, `COLLATE "C"` so ordering is identical everywhere) so feeds/chats page without scanning whole namespaces.
- Consent: join requires `age18:true` and `rules:true`; consent time + rules version stored. Profile private by default, DM policy `none`, stats opt-in, handle unique (case-insens, reserved/abusive words refused, change once per 30 days).
- Text rules (`cleanText`): no links / e-mail / phone numbers, control chars + `<>` stripped, length caps; spam/abuse words put posts/comments on hold (later stages).
- Report (7 reasons, deduped per reporter), block (404 both ways, silent), admin queue via `ADMIN_TOKEN` (`/admin.html`; lockout after 10 failures; actions hide/restore/remove/dismiss/suspend/unsuspend; modlog), rate limits per user AND per IP (3x), half limits for accounts younger than `newAccountMs` (24 h; `COMMUNITY_NEW_ACCOUNT_HOURS`), deletion cascade hook in `Accounts.deleteAccount` (runs before the account is removed), data export.
- Pages: `community-rules.html`, `admin.html`; terms, privacy policy, delete-account wording updated. UI: `community.js/.css` (More > Community): gate, join form, profile editor, blocks, report dialog.
- Tests: `tests/community.test.js` (13), `tests/e2e.community.js`, kv contract extended. SW cache `riderkit-v20`.
