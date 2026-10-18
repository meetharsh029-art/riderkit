'use strict';
// HTTP routes for /api/community/*. Auth = the same Bearer session token as /api/auth. Everything is JSON except image upload (raw bytes) and chat streams (SSE).
const { HttpError } = require('./groups');
function makeCommunityApi({ community, body, rawBody, json }) {
  const bearer = req => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  return async function handle(req, res, url, parts, ip) {
    const C = await community(); if (!C) return json(res, 200, { enabled: false });
    if (C.disabledReason) { if (parts[0] === 'config') return json(res, 200, { enabled: false, reason: C.disabledReason }); throw new HttpError(503, 'community is not enabled on this server'); }
    const [a, b, c, d] = parts, q = url.searchParams, GET = req.method === 'GET', POST = req.method === 'POST';
    if (GET && a === 'config') return json(res, 200, C.config());
    // ---- admin (token only, no user session)
    if (a === 'admin') { C.adminAuth(req, ip);
      if (GET && b === 'reports') return json(res, 200, await C.adminReports(q.get('state') || 'open', Math.min(+q.get('limit') || 50, 200)));
      if (GET && b === 'stats') return json(res, 200, await C.adminStats());
      if (GET && b === 'user') return json(res, 200, await C.adminUser(q.get('handle')));
      if (POST && b === 'action') return json(res, 200, await C.adminAction(await body(req, 2048), ip));
      if (GET && b === 'img' && C.adminImage) return C.adminImage(res, c);
      throw new HttpError(404, 'not found'); }
    if (GET && a === 'img' && C.serveImage) return C.serveImage(req, res, b, q.get('e'), q.get('s')); // signed URL, no bearer (needed by <img>)
    const user = await C.user(bearer(req)); C.rl('read', user.id, ip, null);
    if (GET && a === 'me') return json(res, 200, await C.me(user));
    if (POST && a === 'join') return json(res, 200, await C.join(user, await body(req, 1024), ip));
    const { prof } = await C.member(bearer(req));
    const mm = { user, prof, ip, token: bearer(req) };
    if (POST && a === 'profile' && !b) return json(res, 200, await C.updateProfile(user, prof, await body(req, 2048), ip));
    if (GET && a === 'profile' && b) return json(res, 200, await C.profileView(user, b));
    if (POST && a === 'report') { C.canWrite(prof); return json(res, 200, await C.report(user, await body(req, 1024), ip)); }
    if (POST && a === 'block') { const x = await body(req, 512); return json(res, 200, await C.block(prof, x.handle, ip, user)); }
    if (POST && a === 'unblock') { const x = await body(req, 512); return json(res, 200, await C.unblock(prof, x.handle)); }
    if (GET && a === 'blocks') return json(res, 200, await C.blockList(prof));
    if (GET && a === 'export') return json(res, 200, await C.exportUser(user.id));
    for (const ext of C.routes) { const r = await ext(req, res, url, parts, mm, { body, rawBody, json }); if (r !== undefined) return r; }
    throw new HttpError(404, 'not found');
  };
}
module.exports = { makeCommunityApi };
