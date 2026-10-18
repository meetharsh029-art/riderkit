# RiderKit community: going live on free tiers (test phase)

Nothing here has been signed up for on your behalf. You create the accounts, then paste the values into Render (Environment tab).

| Need | Free service | Env var(s) on Render |
|---|---|---|
| Database (required) | Neon free Postgres (pick the *pooled* connection string, `sslmode=require`) | `DATABASE_URL` |
| Login e-mails (required for accounts) | Resend free (100/day, 3000/month; needs a domain you own and verify) | `RESEND_API_KEY`, `EMAIL_FROM` |
| Moderation login (required) | none, you choose a long random secret | `ADMIN_TOKEN` |
| Switch on | none | `COMMUNITY=1` |
| Photos (optional; without a store, posts are text only because the ride card is an image too) | Backblaze B2 free (10 GB, no card at sign-up when I checked, verify yourself): private bucket + a bucket-scoped application key | `IMAGE_S3_ENDPOINT` (e.g. `https://s3.us-west-004.backblazeb2.com`), `IMAGE_S3_REGION` (e.g. `us-west-004`), `IMAGE_S3_BUCKET`, `IMAGE_S3_KEY_ID`, `IMAGE_S3_SECRET` |
| Optional | | `COMMUNITY_NEW_ACCOUNT_HOURS` (default 24), `IMAGE_MAX_BYTES`, `IMAGE_S3_PATH_STYLE=1`, `IMAGE_S3_PREFIX`, `COMMUNITY_ALLOW_EPHEMERAL=1` (only to try it WITHOUT Postgres; data is lost on every restart) |

Alternatives for photos: Supabase Storage S3 endpoint (1 GB free, project pauses after a week of inactivity). Cloudflare R2 needs a payment card even on the free plan, so it is not card-free. Any S3-compatible store works with the same five variables. `IMAGE_STORE=local` + `IMAGE_DIR` stores on disk (dev only: Render free disks are ephemeral).

Moderation: open `https://<your-app>/admin.html`, paste `ADMIN_TOKEN`. Reports, held posts/comments, images, hide/remove/dismiss, suspend.

Rotate `ADMIN_TOKEN` if it leaks. Update the placeholders in `terms.html`, `community-rules.html`, `store/privacy-policy.html` (contact e-mail, operator name) and have them legally reviewed before inviting the public.
