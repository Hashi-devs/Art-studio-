// GET /api/admin/stats — numbers and recent orders for the admin page.
const { send, only, handle } = require('../../lib/http');
const { db, adminUser } = require('../../lib/supabase');
const { totals } = require('../../lib/orders');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET')) return;
  await adminUser(req);
  const [t, recent, pieces, paidPieces] = await Promise.all([
    totals(),
    db.select('orders', 'select=reference,type,piece_name,email,note,amount,status,downloads,created_at,paid_at&order=created_at.desc&limit=50'),
    db.select('pieces', 'select=id,published'),
    db.select('orders', 'status=eq.paid&type=eq.piece&select=piece_name'),
  ]);
  const counts = {};
  paidPieces.forEach(o => { const k = o.piece_name || 'Removed piece'; counts[k] = (counts[k] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, sold]) => ({ name, sold }));
  send(res, 200, {
    ok: true, ...t,
    pieces: pieces.length, live: pieces.filter(p => p.published).length,
    donations: recent.filter(o => o.type === 'donation' && o.status === 'paid').length,
    pending: recent.filter(o => o.status === 'pending').length,
    top, recent,
  });
});
