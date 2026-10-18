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

## Stage 2: feed posts + photos + swappable image store (done)
- `server/imgstore.js`: magic-byte sniffing (JPEG/PNG/WebP only; SVG/GIF/PDF/HTML refused, declared Content-Type must agree), SERVER-SIDE metadata stripping (JPEG APP1-15/COM dropped, PNG ancillary chunks dropped + CRC check, WebP EXIF/XMP/ICC dropped, animated refused, trailing bytes after EOI cut), dimension caps (16..4096 px, 16 MP), 1 MB raw cap (`IMAGE_MAX_BYTES`), 50 MB per user quota.
- Adapters: `S3ImageStore` (AWS SigV4 with node:crypto, verified against the two official AWS example signatures, path or virtual-hosted style, works with Backblaze B2 / Supabase Storage S3 / Cloudflare R2 / AWS S3 / MinIO), `LocalImageStore` (dev), `MemoryImageStore` (tests). `makeImageStore(env)`: `IMAGE_S3_*` -> s3; dev -> local disk; production without S3 settings -> NO photo storage (uploads answer 503, text/stats posts still work) unless `COMMUNITY_ALLOW_EPHEMERAL=1`.
- Images are served through the app (`/api/community/img/<id>?e=&s=` HMAC-signed, 6 h, `nosniff`, CSP sandbox, hidden/removed -> 404), so the bucket can stay private and no CORS/CSP changes are needed. Orphan uploads are swept after 24 h.
- Posts (`server/community-posts.js`): recap card (re-encoded to JPEG client-side because the 1080x1350 PNG exceeds 1 MB) + up to 3 photos + caption (<=500, no links/phones) + ride summary (km, minutes, date, vehicle) only; any lat/lng/points/route/location key at any depth is rejected. Audience public/followers (club in stage 5); private profile can only post to followers; going private hides earlier public posts at once; new accounts: pictures followers-only for 24 h. Spam/abuse words -> post HELD (author-only, in admin queue). Reports: 3 distinct reporters or 1 report on a <7 day account's picture post -> hidden (images stop being served). Feed: global / following / user, newest first, cursor paging via kv.range (bounded scan of 500 rows per request).
- Client: composer (downscale to 1600 px, JPEG re-encode = EXIF dropped, magic-byte check, thumbnails, location/plate warning), feed with report/block/delete, "Post to community" button inside the recap dialog.
- Free image store research (checked 19 Oct 2026): Cloudflare R2 needs a payment method on file even for the free tier (10 GB) -> NOT card-free. **Backblaze B2: first 10 GB free, sign-up page says "No credit card required", S3-compatible, bucket stays private** (recommended). Supabase Storage free: 1 GB, 50 MB max file, S3-compatible, no card, but the free project pauses after 1 week of inactivity (also used as DB it would pause the community) -> second choice. 
- Tests: `community.images.test.js` (10), `community.posts.test.js` (11), e2e extended (27 checks). SW cache `riderkit-v21`.

## Stage 3+4 — follow, likes, comments (SW v22)
- Server: `server/community-social.js` (follow graph with requests for private profiles, followers/following lists, idempotent likes with per-post serialized counters, deletion cascade fixing other people's counters, export) and `server/community-comments.js` (flat comments, 300 chars, no links/e-mail/phones, cap 200/post, held-for-review on spam words, 3 reports hide, admin remove/restore, post owner can delete any comment, block filtering both ways, cascade on post and account deletion).
- Client: `community-social.js` (like + comments inline on every post, tap an author for the profile sheet with Follow/Message/Report/Block and their posts, followers/following lists, People tab with follow requests and a badge).
- Tests: `tests/community.social.test.js` (12) on memory/file/pg-mem/real Postgres; e2e.community.js now 37 checks.
- Fixed: `GET posts/:id/comments` was shadowed by the post route.

## Stage 5 — clubs, group chats, live chat (SW v23)
- Server `server/community-clubs.js`: clubs (public, unique names, open / request / invite-only join), group chats (invite-only, max 30, never discoverable), owner/mod roles, kick/ban/unban, owner-leave transfer (last member leaving deletes), club-only post visibility + `feed?scope=club`, invites gated by the invitee's DM setting and blocks, chat text-only 400 chars with spam/link/phone refusal, rate limit, prune to ~600, unread + read pointer, report message/club with 3 preceding messages as evidence, admin hide/remove, deletion cascade.
- Live delivery: SSE over `GET clubs/:id/stream` (fetch stream with Bearer header, `Last-Event-ID` backlog, `event: del`/`kicked`, 20 s heartbeat, max 3 streams per user, 200 total), polling fallback via `chat?since=`. Single-process only.
- Client `community-clubs.js`: Clubs tab (invitations, my clubs, search/discover, create), club sheet with Chat / Posts / Members, SSE with polling fallback, owner/mod actions; composer can post to a club.
- Tests: `tests/community.clubs.test.js` (9) on memory/file/pg-mem/real Postgres; e2e.community.js now 47 checks including a real browser fetch-stream.

## Stage 6 — direct messages (server done; UI follows)
- `server/community-dm.js`: conversation = sorted user pair. Gate: recipient `dm` = none | followers (sender must have an accepted follow of them) | everyone; once the recipient has written, replies are always allowed; cold senders get 3 unanswered messages; block = 404 both ways (history unreachable, conversation hidden); suspended = 404/403; rate limits `dm` and `dmNew`; list with preview + unread, read, mute, clear (delete-for-me), delete own message (both sides), cap ~1000 per conversation, one user-level SSE stream (`dm/stream`, 2 per user), report DM (participants only; evidence = message + 3 before it), admin hide/remove, deletion removes the whole conversation on both sides.
- Reports of club messages now require membership (`reportGuard`).
- Tests: `tests/community.dm.test.js` (7) on all four backends.

## Checkpoint (stage 5 + partial DM client, SW v24)
- Synced/committed stage 5 clubs + early DM client (community-dm.js, unfinished: no message requests/privacy setting yet, untested).

## Stage 6 UI — DMs (SW v25)
- Client `community-dm.js`: Messages tab (conversation list, unread badges, Message requests section), thread sheet (history, send, delete own, mute, delete chat, report message / report rider, block), one live SSE stream for all conversations with 5 s polling fallback, toast for new messages. Privacy control "Who can message me" (none / followers / everyone) in the Profile editor; Message button on profile sheets only when allowed.
- Message requests: server flags a conversation `request` when the peer wrote first, I never replied, I don't follow them and haven't accepted (`POST dm/with/:h/accept`); `/dm` returns `requests` count; thread shows Accept / Delete-and-block banner. Replying or following also clears it.
- Tests: community.dm.test.js 8 (all 4 backends); e2e.community.js extended (DM, request, report, block).
