// /api/admin/pieces — list (GET), add (POST), edit or hide (PATCH ?id=), delete (DELETE ?id=).
const { send, fail, only, handle, readJson } = require('../../lib/http');
const { db, storage, adminUser } = require('../../lib/supabase');

const CATS = ['arts', 'illustrations', 'stories', 'photos'];
const TAGS = ['people', 'things', 'anime', 'random'];
const KINDS = ['drawing', 'photo'];
const idOf = req => String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
const validId = id => /^[0-9a-f-]{36}$/i.test(id);
const validPath = p => typeof p === 'string' && /^[a-z0-9][a-z0-9._/-]{3,200}$/i.test(p) && !p.includes('..');

// Keeps only the fields the admin may set, checking each.
function clean(body, partial) {
  const out = {};
  if (!partial || 'name' in body) { const n = String(body.name || '').trim().slice(0, 80); if (!n) throw Object.assign(new Error('Give the piece a name'), { status: 400 }); out.name = n; }
  if ('cat' in body || !partial) { if (!CATS.includes(body.cat)) throw Object.assign(new Error('Pick a section'), { status: 400 }); out.cat = body.cat; }
  if ('tag' in body || !partial) { out.tag = TAGS.includes(body.tag) ? body.tag : 'random'; }
  if ('kind' in body || !partial) { out.kind = KINDS.includes(body.kind) ? body.kind : 'drawing'; }
  if ('price' in body || !partial) { const p = Math.round(Number(body.price ?? 1000)); if (!(p >= 100 && p <= 1000000)) throw Object.assign(new Error('Price must be from ₦100'), { status: 400 }); out.price = p; }
  if ('published' in body) out.published = !!body.published;
  if (!partial) {
    if (!validPath(body.preview_path) || !validPath(body.original_path)) throw Object.assign(new Error('Upload the image first'), { status: 400 });
    out.preview_path = body.preview_path; out.original_path = body.original_path;
  }
  return out;
}

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return;
  await adminUser(req);

  if (req.method === 'GET') {
    const rows = await db.select('pieces', 'select=*&order=created_at.desc');
    const sold = await db.select('orders', 'status=eq.paid&type=eq.piece&select=piece_id');
    const n = {}; sold.forEach(o => { n[o.piece_id] = (n[o.piece_id] || 0) + 1; });
    return send(res, 200, { ok: true, pieces: rows.map(p => ({ ...p, img: storage.publicUrl('previews', p.preview_path), sold: n[p.id] || 0 })) });
  }
  if (req.method === 'POST') {
    const row = await db.insert('pieces', clean(await readJson(req), false));
    return send(res, 201, { ok: true, piece: row });
  }
  const id = idOf(req);
  if (!validId(id)) return fail(res, 400, 'Missing piece id');
  if (req.method === 'PATCH') {
    const [row] = await db.update('pieces', `id=eq.${id}`, clean(await readJson(req), true));
    if (!row) return fail(res, 404, 'Piece not found');
    return send(res, 200, { ok: true, piece: row });
  }
  // DELETE: remove the row, then its files. Past orders keep the piece name.
  const [row] = await db.remove('pieces', `id=eq.${id}`);
  if (!row) return fail(res, 404, 'Piece not found');
  await Promise.allSettled([storage.remove('previews', [row.preview_path]), storage.remove('originals', [row.original_path])]);
  send(res, 200, { ok: true });
});
