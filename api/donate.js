// POST /api/donate {amount, email, note} — starts a Paystack payment for a donation.
const { send, fail, only, handle, readJson, env, isEmail } = require('../lib/http');
const { db } = require('../lib/supabase');
const paystack = require('../lib/paystack');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'POST')) return;
  const { amount, email, note, method, name, onWall } = await readJson(req);
  const who = String(name || '').trim().slice(0, 60) || null;
  const naira = Math.round(Number(amount));
  if (!Number.isFinite(naira) || naira < 100 || naira > 5000000) return fail(res, 400, 'Enter an amount from ₦100');
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email');
  const reference = paystack.newReference('dn');
  await db.insert('orders', { reference, type: 'donation', email: email.trim(), note: String(note || '').trim().slice(0, 600) || null, buyer_name: who, on_wall: !!who && onWall !== false, wall_ok: !!who && onWall !== false, amount: naira });
  const site = env('SITE_URL').replace(/\/+$/, '');
  const tx = await paystack.initialize({ email: email.trim(), naira, reference, callbackUrl: `${site}/?ref=${reference}`, metadata: { type: 'donation' }, method });
  send(res, 200, { ok: true, url: tx.authorization_url, reference });
});
