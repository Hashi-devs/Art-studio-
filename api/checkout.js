// POST /api/checkout {pieceId, email, note} — starts a Paystack payment for one piece.
const { send, fail, only, handle, readJson, env, isEmail } = require('../lib/http');
const { db } = require('../lib/supabase');
const paystack = require('../lib/paystack');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'POST')) return;
  const { pieceId, email, note, method, name, extra, onWall } = await readJson(req);
  const who = String(name || '').trim().slice(0, 60);
  const add = Math.round(Number(extra) || 0);
  if (!who) return fail(res, 400, 'Enter your name');
  if (!(add >= 0 && add <= 1000000)) return fail(res, 400, 'Enter an extra amount from ₦0');
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email');
  if (!/^[0-9a-f-]{36}$/i.test(String(pieceId || ''))) return fail(res, 400, 'Pick a piece first');
  const [piece] = await db.select('pieces', `id=eq.${pieceId}&published=eq.true&select=id,name,price`);
  if (!piece) return fail(res, 404, 'That piece is no longer available');
  const reference = paystack.newReference('ar');
  await db.insert('orders', { reference, type: 'piece', piece_id: piece.id, piece_name: piece.name, email: email.trim(), note: String(note || '').trim().slice(0, 600) || null, buyer_name: who, extra: add, on_wall: onWall !== false, wall_ok: onWall !== false, amount: piece.price + add });
  const site = env('SITE_URL').replace(/\/+$/, '');
  const tx = await paystack.initialize({ email: email.trim(), naira: piece.price + add, reference, callbackUrl: `${site}/?ref=${reference}`, metadata: { type: 'piece', piece: piece.name }, method });
  send(res, 200, { ok: true, url: tx.authorization_url, reference });
});
