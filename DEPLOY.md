# Deploying Malhiva to Render (free web service)

No dependencies, no build step. The server listens on `process.env.PORT` at `0.0.0.0`,
serves the app and the `/api` on one port, and exposes `GET /healthz`.

## 1. Push to GitHub
```bash
cd rider-app-deploy
gh repo create riderkit --private --source=. --push      # needs: gh auth login
# or manually:
git remote add origin https://github.com/<you>/riderkit.git
git branch -M main
git push -u origin main
```

## 2a. Render Blueprint (recommended)
1. https://dashboard.render.com → **New +** → **Blueprint**.
2. Connect GitHub, pick the repo, branch `main`.
3. Render reads `render.yaml` (free plan, node runtime, `node server/server.js`). Click **Apply**.

## 2b. Or Web Service manually
1. **New +** → **Web Service** → pick the repo.
2. Runtime: **Node**; Build Command: `echo ok` (or `npm install`); Start Command: `npm start`.
3. Instance type: **Free**. Advanced → Health Check Path: `/healthz`.
4. Environment: `NODE_ENV=production`, `TRUST_PROXY=1`.

## 3. Verify
```bash
curl https://<service>.onrender.com/healthz      # ok
curl https://<service>.onrender.com/api/health   # {"ok":true,...}
```

## Notes
- Free services sleep after ~15 min idle; first request takes ~30–60 s to wake. Group rides are held in memory and are lost on restart/sleep.
- `TRUST_PROXY` defaults to on when `NODE_ENV=production`; set `TRUST_PROXY=0` to disable. It makes rate limiting use `X-Forwarded-For`.
- Privacy policy is served at `/store/privacy-policy.html`.
- Env (optional): `GROUP_EMPTY_TTL_MS` (default 7 days: memory cleanup of groups with zero members), `GROUP_ABANDONED_MS` (default off: drop groups whose members are all unseen that long). Groups never expire while a rider is still on their trip; they close when the admin cancels or every rider ends their trip.


## Feedback reports
- `POST /api/feedback` (rate limited 5 / 10 min / IP, 8 KB body, 2000 char message, whitelist + sanitising) appends one JSON line per report to `FEEDBACK_FILE` (default: `<os tmpdir>/riderkit-feedback.jsonl`, capped ~5 MB).
- **Render free storage is ephemeral**: the file is wiped on every deploy, restart and spin-down. Read reports regularly, or attach a persistent disk (paid) and set `FEEDBACK_FILE` to it.
- Read them: set the `ADMIN_TOKEN` env var in Render (long random string; render.yaml declares it with `sync: false`), then
  `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://riderkit.onrender.com/api/feedback` (optional `?limit=N`, newest first). Without ADMIN_TOKEN the endpoint returns 404 for GET.
- Collected: type, message, optional contact, app version, user-agent, platform, language, screen size, standalone/online flags. No location, no IP stored.


## Stage 1-7 features and what they need (SW v12-v18)
| Feature | Server needs | Persistence |
|---|---|---|
| Web Push reminders | nothing (VAPID key pair auto-generated; optional `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`) | subscriptions + reminder dates in the KV store (JSON file = lost on Render free restart; `DATABASE_URL` = kept) |
| Hazard / place pins | nothing; optional `ADMIN_TOKEN` for moderation | KV store (same as above) |
| Live-share link (`/live.html#id`) | nothing | memory only |
| Group expenses + stops | nothing | memory only (with the group) |
| Auto re-route / voice prompts / recap card / tile cache | nothing (client side) | on device |

- **Reminders and sleeping servers:** Render free sleeps after ~15 min idle, and a sleeping server cannot send scheduled pushes (the sweep runs every 30 min while awake, only 08:00-21:00 in the rider's time zone). The app therefore also shows due reminders as local notifications whenever it is opened. For dependable push, use a paid always-on instance or an external uptime pinger (user decision; not set up).
- **Moderation of pins:** with `ADMIN_TOKEN` set: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://riderkit.onrender.com/api/pins/admin` lists reported pins; `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"id":"PINID","act":"remove"}' .../api/pins/admin` (or `"restore"`). Pins with 3 reports are hidden automatically.
- **Postgres:** `DATABASE_URL` (Neon/Supabase free) makes accounts, push subscriptions and pins survive restarts. Not set up; needs the user.
