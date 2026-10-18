'use strict';
// SMS OTP provider interface: { name, enabled, send(toE164, text) }. DISABLED unless configured. Nothing here signs up for or pays for anything.
//  SMS_PROVIDER=twilio + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM  -> Twilio Programmable Messaging (paid; per-SMS cost; written to the documented REST API, NOT tested against the live service)
//  SMS_PROVIDER=console (dev only, refused in production) -> prints the code to the server log
function makeSms(env = process.env, fetchFn = globalThis.fetch) {
  const p = String(env.SMS_PROVIDER || '').toLowerCase();
  if (p === 'console' && env.NODE_ENV !== 'production') return { name: 'console', enabled: true, dev: true, async send(to, text) { console.log('[dev-sms] to=' + to + ' ' + text); } };
  if (p === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) return { name: 'twilio', enabled: true, async send(to, text) {
    const r = await fetchFn('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(env.TWILIO_ACCOUNT_SID) + '/Messages.json', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('sms provider error ' + r.status); } };
  return { name: 'none', enabled: false, send: async () => { throw new Error('phone login is not enabled'); } };
}
module.exports = { makeSms };
