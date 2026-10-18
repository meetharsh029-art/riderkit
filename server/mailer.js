'use strict';
// Email delivery behind a tiny interface: { name, enabled, send(to, subject, text) }.
//  - RESEND_API_KEY (+ EMAIL_FROM on a domain verified in Resend) -> Resend HTTPS API (Render free blocks SMTP ports, so no SMTP).
//  - otherwise, only when ACCOUNTS_DEV_LOG=1 or NODE_ENV != production: print the message (incl. the code) to the server log.
//  - otherwise (production without a key): disabled; the accounts API answers 503 rather than silently logging secrets.
function makeMailer(env = process.env, fetchFn = globalThis.fetch) {
  if (env.RESEND_API_KEY) {
    const from = env.EMAIL_FROM; if (!from) return { name: 'resend', enabled: false, reason: 'RESEND_API_KEY set but EMAIL_FROM missing', send: async () => { throw new Error('EMAIL_FROM missing'); } };
    return { name: 'resend', enabled: true, async send(to, subject, text) {
      const r = await fetchFn('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }), signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('email provider error ' + r.status); } };
  }
  if (env.ACCOUNTS_DEV_LOG === '1' || env.NODE_ENV !== 'production') return { name: 'console', enabled: true, dev: true, async send(to, subject, text) { console.log('[dev-mail] to=' + to + ' subject=' + JSON.stringify(subject) + '\n' + text); } };
  return { name: 'none', enabled: false, reason: 'no RESEND_API_KEY', send: async () => { throw new Error('email delivery not configured'); } };
}
module.exports = { makeMailer };
