# Deploying RiderKit to Render (free web service)

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
- Env: `GROUP_TTL_MS` optional.
