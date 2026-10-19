'use strict';
// Group extras: shared expenses (amounts in paise, integer) and request/planned stops. Mixed into GroupStore; in memory with the group (vanishes when the group is deleted).
// Money: Malhiva only RECORDS who paid what and computes who owes whom. It never moves money.
const crypto = require('crypto');
const STOP_TYPES = { fuel: 'Fuel', food: 'Food / tea', rest: 'Rest', washroom: 'Washroom', photo: 'Photo stop', other: 'Other' };
const T = { maxExpenses: 100, maxPaise: 10000000, maxStops: 20, stopTtlMs: 12 * 3600e3 };
module.exports = function mix(GroupStore, { HttpError, cleanName, num }) {
  const P = GroupStore.prototype, snap0 = P.snapshot;
  const label = s => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  P.snapshot = function (g) { const s = snap0.call(this, g); this.purgeStops(g); s.stops = (g.stops || []).map(x => ({ id: x.id, type: x.type, note: x.note, lat: x.lat, lng: x.lng, by: x.byName, byId: x.byId, status: x.status, plus: x.voters.length, at: x.at })); s.expRev = g.expRev || 0; s.expN = (g.expenses || []).length; return s; };
  P.purgeStops = function (g) { if (!g.stops) return; const t = this.now(); const n = g.stops.length; g.stops = g.stops.filter(x => t - x.at < T.stopTtlMs && x.status !== 'done'); if (g.stops.length !== n) g.dirty = true; };
  // ---- expenses
  P.listExpenses = function (code, token) { const { g } = this.auth(code, token); return { rev: g.expRev || 0, expenses: (g.expenses || []).map(e => ({ ...e })), names: { ...(g.names || {}) } }; };
  P.addExpense = function (code, token, b) {
    const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended'); const ex = g.expenses || (g.expenses = []); g.names = g.names || {};
    if (ex.length >= T.maxExpenses) throw new HttpError(409, 'this group has reached the 100 expense limit');
    const amount = b.amount; if (!Number.isInteger(amount) || amount < 1 || amount > T.maxPaise) throw new HttpError(400, 'amount must be between 1 paise and 1,00,000 rupees');
    const lbl = label(b.label); if (!lbl) throw new HttpError(400, 'what was it for? add a short label');
    const paidBy = b.paidBy == null ? m.id : String(b.paidBy); if (!g.members.has(paidBy)) throw new HttpError(404, 'payer is not in this group');
    let withIds = b.with == null ? [...g.members.values()].filter(x => !x.ended).map(x => x.id) : b.with; if (!Array.isArray(withIds) || !withIds.length || withIds.length > 30) throw new HttpError(400, 'choose who shares this expense');
    withIds = [...new Set(withIds.map(String))]; for (const id of withIds) if (!g.members.has(id)) throw new HttpError(404, 'a rider in the split is not in this group');
    for (const id of new Set([...withIds, paidBy, m.id])) g.names[id] = g.members.get(id).name;
    const e = { id: crypto.randomBytes(4).toString('hex'), amount, label: lbl, paidBy, with: withIds, by: m.id, at: this.now() }; ex.push(e); g.expRev = (g.expRev || 0) + 1; m.lastSeen = this.now(); this.touch(g); return { g, expense: e };
  };
  P.delExpense = function (code, token, id) { const { g, m } = this.auth(code, token); const ex = g.expenses || [], i = ex.findIndex(e => e.id === String(id)); if (i < 0) throw new HttpError(404, 'expense not found');
    if (ex[i].by !== m.id && g.adminId !== m.id) throw new HttpError(403, 'only who added it or the admin can delete it'); ex.splice(i, 1); g.expRev = (g.expRev || 0) + 1; this.touch(g); return g; };
  // ---- stops
  P.requestStop = function (code, token, b) {
    const { g, m } = this.auth(code, token); if (m.ended) throw new HttpError(409, 'trip ended'); this.purgeStops(g); const type = String(b.type ?? ''); if (!Object.prototype.hasOwnProperty.call(STOP_TYPES, type)) throw new HttpError(400, 'invalid stop type');
    const st = g.stops || (g.stops = []); if (st.length >= T.maxStops) throw new HttpError(409, 'too many open stops, finish or dismiss some first');
    if (st.filter(x => x.byId === m.id).length >= 3) throw new HttpError(409, 'you already have 3 open stop requests');
    let pos = m.pos; if (b.lat != null || b.lng != null) pos = { lat: num(b.lat, -90, 90), lng: num(b.lng, -180, 180) };
    const s = { id: crypto.randomBytes(4).toString('hex'), type, note: label(b.note), lat: pos ? Math.round(pos.lat * 1e5) / 1e5 : null, lng: pos ? Math.round(pos.lng * 1e5) / 1e5 : null, byId: m.id, byName: m.name, status: g.adminId === m.id ? 'planned' : 'requested', voters: [m.id], at: this.now() };
    st.push(s); m.lastSeen = this.now(); this.touch(g); return { g, stop: s };
  };
  P.stopAct = function (code, token, id, act) {
    const { g, m } = this.auth(code, token); this.purgeStops(g); const st = g.stops || [], s = st.find(x => x.id === String(id)); if (!s) throw new HttpError(404, 'stop not found'); const admin = g.adminId === m.id;
    if (act === 'plus') { if (m.ended) throw new HttpError(409, 'trip ended'); if (!s.voters.includes(m.id)) s.voters.push(m.id); }
    else if (act === 'approve') { if (!admin) throw new HttpError(403, 'only the admin can plan a stop'); s.status = 'planned'; }
    else if (act === 'done') { if (!admin) throw new HttpError(403, 'only the admin can mark a stop done'); s.status = 'done'; }
    else if (act === 'cancel') { if (!admin && s.byId !== m.id) throw new HttpError(403, 'only who asked or the admin can remove it'); g.stops = st.filter(x => x !== s); }
    else throw new HttpError(400, 'invalid action'); this.purgeStops(g); this.touch(g); return g;
  };
};
module.exports.STOP_TYPES = STOP_TYPES; module.exports.LIMITS = T;
