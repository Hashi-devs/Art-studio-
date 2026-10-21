// GET /api/verify?ref=... — called when the buyer returns from Paystack. Confirms the
// payment and, for a piece, hands back a short-lived link to the full-quality original.
const { send, fail, only, handle } = require('../lib/http');
const { db, storage } = require('../lib/supabase');
const { confirm } = require('../lib/orders');

const MAX_DOWNLOADS = 10;

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET')) return;
  const ref = String((req.query && req.query.ref) || new URL(req.url, 'http://x').searchParams.get('ref') || '');
  if (!/^[a-z]{2}_[a-z0-9_]{6,40}$/i.test(ref)) return fail(res, 400, 'Unknown payment reference');
  const order = await confirm(ref);
  if (order.status !== 'paid') return send(res, 200, { ok: true, status: order.status, type: order.type });
  if (order.type === 'donation') return send(res, 200, { ok: true, status: 'paid', type: 'donation', amount: order.amount });
  if (order.downloads >= MAX_DOWNLOADS) return fail(res, 410, 'This download link has been used too many times. Reply to your receipt email for help.');
  const [piece] = order.piece_id ? await db.select('pieces', `id=eq.${order.piece_id}&select=id,name,kind,original_path`) : [];
  if (!piece) return fail(res, 404, 'This piece was removed. Reply to your receipt email for help.');
  const url = await storage.signedUrl('originals', piece.original_path, 60 * 30);
  await db.update('orders', `id=eq.${order.id}`, { downloads: order.downloads + 1 });
  send(res, 200, { ok: true, status: 'paid', type: 'piece', piece: { id: piece.id, name: piece.name, kind: piece.kind }, url });
});
