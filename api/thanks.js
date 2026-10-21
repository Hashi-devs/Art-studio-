// GET /api/thanks — the Thank-yous wall: names and messages of people who chose to be shown.
// Never includes emails or amounts.
const { only, handle } = require('../lib/http');
const { db, storage } = require('../lib/supabase');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET')) return;
  const rows = await db.select('orders', 'status=eq.paid&on_wall=eq.true&buyer_name=not.is.null&select=reference,buyer_name,note,type,piece_id,piece_name,paid_at&order=paid_at.desc&limit=500');
  const ids = [...new Set(rows.map(r => r.piece_id).filter(Boolean))];
  const pieces = ids.length ? await db.select('pieces', `id=in.(${ids.join(',')})&select=id,kind,preview_path`) : [];
  const byId = Object.fromEntries(pieces.map(p => [p.id, p]));
  const people = rows.map(r => {
    const p = byId[r.piece_id];
    return { id: r.reference.slice(-10), name: r.buyer_name, message: r.note || '', type: r.type, date: r.paid_at,
      piece: r.type === 'piece' ? { name: r.piece_name, kind: p ? p.kind : 'drawing', img: p ? storage.publicUrl('previews', p.preview_path) : null } : null };
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  res.end(JSON.stringify({ ok: true, people }));
});
