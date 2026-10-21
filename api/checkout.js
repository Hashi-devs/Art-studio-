// POST /api/checkout {pieceId, email, note} — starts a Paystack payment for one piece.
const { send, fail, only, handle, readJson, env, isEmail } = require('../lib/http');
const { db } = require('../lib/supabase');
const paystack = require('../lib/paystack');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'POST')) return;
  const { pieceId, email, note, method } = await readJson(req);
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email');
  if (!/^[0-9a-f-]{36}$/i.test(String(pieceId || ''))) return fail(res, 400, 'Pick a piece first');
  const [piece] = await db.select('pieces', `id=eq.${pieceId}&published=eq.true&select=id,name,price`);
  if (!piece) return fail(res, 404, 'That piece is no longer available');
  const reference = paystack.newReference('ar');
  await db.insert('orders', { reference, type: 'piece', piece_id: piece.id, piece_name: piece.name, email: email.trim(), note: String(note || '').slice(0, 500) || null, amount: piece.price });
  const site = env('SITE_URL').replace(/\/+$/, '');
  const tx = await paystack.initialize({ email: email.trim(), naira: piece.price, reference, callbackUrl: `${site}/?ref=${reference}`, metadata: { type: 'piece', piece: piece.name }, method });
  send(res, 200, { ok: true, url: tx.authorization_url, reference });
});
