// Paystack over its REST API. Amounts sent to Paystack are in kobo (naira × 100).
const crypto = require('crypto');
const { env } = require('./http');

async function call(path, opts = {}) {
  const r = await fetch('https://api.paystack.co' + path, {
    ...opts,
    headers: { Authorization: `Bearer ${env('PAYSTACK_SECRET_KEY')}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.status === false) throw Object.assign(new Error(data.message || `Paystack ${r.status}`), { status: 502 });
  return data.data;
}

const newReference = prefix => `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;

// Starts a payment and returns the Paystack page the buyer should be sent to.
const CHANNELS = { card: ['card'], transfer: ['bank_transfer'], ussd: ['ussd'] };
const initialize = ({ email, naira, reference, callbackUrl, metadata, method }) =>
  call('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: Math.round(naira * 100), currency: 'NGN', reference, callback_url: callbackUrl, metadata, ...(CHANNELS[method] ? { channels: CHANNELS[method] } : {}) }) });

// Asks Paystack for the final state of a payment.
const verify = reference => call(`/transaction/verify/${encodeURIComponent(reference)}`);

// Paystack signs every webhook with HMAC-SHA512 of the raw body using your secret key.
function validSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', env('PAYSTACK_SECRET_KEY')).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initialize, verify, validSignature, newReference };
