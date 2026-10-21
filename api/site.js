// GET /api/site — everything the public page needs: published pieces, goal, raised.
const { send, only, handle } = require('../lib/http');
const { db, storage } = require('../lib/supabase');
const { totals } = require('../lib/orders');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET')) return;
  const [rows, t] = await Promise.all([
    db.select('pieces', 'published=eq.true&select=id,name,cat,tag,kind,price,preview_path,created_at&order=created_at.desc'),
    totals(),
  ]);
  const pieces = rows.map(p => ({ id: p.id, name: p.name, cat: p.cat, tag: p.tag, kind: p.kind, price: p.price, img: storage.publicUrl('previews', p.preview_path) }));
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, pieces, goal: t.goal, raised: t.raised, sold: t.sold }));
});
