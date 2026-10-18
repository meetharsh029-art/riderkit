# Optional rider accounts

Guests keep working: no ride/group endpoint needs an account. Accounts only add email sign-in.

## What exists
- Email + password sign-up with a **6-digit emailed code** (account is created only after the code is confirmed), login, logout, logout-all, change password, **forgot/reset password by emailed code**, and **account deletion** (in the app: SOS & settings > Account; on the web: `/delete-account.html`, which is the URL for Play Console's "Data deletion" field). Terms: `/terms.html`; privacy policy has Accounts + Deleting sections.
- Passwords: **scrypt** (N=2^15, r=8, p=3, 16-byte random salt, parameters stored per hash), Unicode-normalised, 10-128 chars, common-password check. Codes are stored as HMAC (server secret kept in the store), expire in 10 min, 5 tries, single use, 60 s resend cooldown. Sessions: random 256-bit bearer token, only its SHA-256 is stored, 30-day sliding expiry, revoked on password change/reset/delete. The app keeps the token in `localStorage` (see limits).
- Brute force: login failures lock per email+IP (5 / 15 min), per email (15 / 15 min, defeats IP rotation) and per IP (30 / 15 min, defeats spraying); a successful emailed reset lifts the lock. Sign-up 5/h/IP, forgot 5/h/IP + 3/h/address, deletion 5/h, global 60 auth calls/10 min/IP. Responses never reveal whether an email is registered; unknown emails cost the same hashing time.
- **Phone / SMS OTP**: code path exists behind a provider interface (`server/sms.js`) and is **disabled** until `SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` are set. SMS is paid per message; the server caps 3 / 10 min per number, 5/h per IP and 50/day total (override in code). The Twilio call follows their REST docs but was **never run against the live service**. There is no phone UI in the app yet.
- Email delivery (`server/mailer.js`): `RESEND_API_KEY` + `EMAIL_FROM` -> Resend HTTPS API (Render free blocks SMTP ports 25/465/587, so SMTP is not an option). Without a key: in development the code is printed to the server log (`[dev-mail]`); in production the accounts API answers 503 and the app says accounts are unavailable (secrets are never logged in production unless `ACCOUNTS_DEV_LOG=1`).
- Storage (`server/kv.js`, swappable): `DATABASE_URL` -> Postgres (table `rk_kv`, created automatically; driver `pg` is an optionalDependency); otherwise a JSON file at `$ACCOUNTS_FILE` or `$DATA_DIR/accounts.json` (atomic writes, mode 0600, never served over HTTP, git-ignored).

## Free options researched (checked Oct 2026)
| Option | Free? | Catch |
|---|---|---|
| **Render free Postgres** | 1 GB | **Expires 30 days after creation**, deleted after a 14-day grace; no backups. Not suitable. |
| **Neon free Postgres** (recommended) | Permanent: 0.5-1 GB/project, 100 CU-h/month, no card | Compute sleeps after 5 min idle (first query ~1 s slower); hitting monthly compute cap suspends it until next month (data kept). |
| Supabase free | 500 MB | **Pauses after 1 week of inactivity** (manual resume), max 2 active projects. |
| JSON file on the Render free web service | $0 | Free web services have an **ephemeral disk: accounts are lost on every redeploy/restart/spin-down**. Fine for local dev only. |
| Resend (email) | 100 emails/day, 3,000/month, up to 3 verified domains | You must **verify a domain you own** (DNS records) to send to anyone but yourself. No domain = can only email your own address. |

## Exact steps for the owner (nothing was signed up for)
1. **Database (recommended Neon):** create a free account at neon.com, create a project (region near Render's, e.g. Singapore), copy the **pooled connection string** (`postgres://...neon.tech/...?sslmode=require`).
2. **Email:** create a free Resend account; add and verify a domain you own (add the DNS records they show); create an API key. Pick a sender such as `RiderKit <no-reply@yourdomain.com>`. (Without a domain, use only for testing to your own address.)
3. In the Render dashboard for the `riderkit` service > Environment, add: `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM`. Deploy manually (the build now runs `npm install --omit=dev`, which installs `pg`).
4. Check: open the app > SOS & settings > Account: the sign-in form appears (otherwise it says unavailable). Create an account with your email, enter the code, then test sign-out, forgot password, and delete account.
5. Play Console: enter `https://<your-domain>/delete-account.html` as the Data deletion URL; in Data safety declare email (and, if you enable phone, phone number) as collected for account management, optional, with deletion available; fill the `[PLACEHOLDER]`s in the privacy policy and terms (developer name, contact email, date) and have them reviewed.
6. Phone login later (optional, costs money): create a Twilio account + a number/Messaging Service, then set the three `TWILIO_*` vars and `SMS_PROVIDER=twilio`, and add a phone UI.

## Limits / not done
Postgres code is tested only against the pg-mem emulator, not a real Neon database; Twilio/Resend calls are tested with fakes; the app stores the session token in `localStorage` (readable by any script in the page; the Capacitor Android build would ideally use the Keystore via a secure-storage plugin, not installed); no CAPTCHA; no email-change flow; no 2FA; reset codes and verification mails depend on Resend's free quota (100/day).
