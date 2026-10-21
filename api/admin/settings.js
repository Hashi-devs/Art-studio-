// /api/admin/settings — read (GET) or change (PATCH {goal}) the laptop goal.
const { send, fail, only, handle, readJson } = require('../../lib/http');
const { db, adminUser } = require('../../lib/supabase');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET', 'PATCH')) return;
  await adminUser(req);
  if (req.method === 'GET') {
    const [s] = await db.select('settings', 'id=eq.1&select=goal');
    return send(res, 200, { ok: true, goal: s ? s.goal : 500000 });
  }
  const goal = Math.round(Number((await readJson(req)).goal));
  if (!(goal >= 1000 && goal <= 100000000)) return fail(res, 400, 'Enter a goal from ₦1,000');
  const [s] = await db.update('settings', 'id=eq.1', { goal, updated_at: new Date().toISOString() });
  send(res, 200, { ok: true, goal: s ? s.goal : goal });
});
