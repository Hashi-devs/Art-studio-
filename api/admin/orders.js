// PATCH /api/admin/orders?ref=... {onWall} — show or hide someone on the Thank-yous wall.
const { send, fail, only, handle, readJson } = require('../../lib/http');
const { db, adminUser } = require('../../lib/supabase');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'PATCH')) return;
  await adminUser(req);
  const ref = String((req.query && req.query.ref) || new URL(req.url, 'http://x').searchParams.get('ref') || '');
  if (!/^[a-z]{2}_[a-z0-9_]{6,40}$/i.test(ref)) return fail(res, 400, 'Unknown order');
  const want = !!(await readJson(req)).onWall;
  const [order] = await db.select('orders', `reference=eq.${encodeURIComponent(ref)}&select=wall_ok`);
  if (!order) return fail(res, 404, 'Order not found');
  // Only people who chose to be on the wall can be shown. Anyone can be hidden.
  if (want && !order.wall_ok) return fail(res, 403, 'They chose to stay private');
  const [row] = await db.update('orders', `reference=eq.${encodeURIComponent(ref)}`, { on_wall: want });
  send(res, 200, { ok: true, on_wall: row.on_wall });
});
