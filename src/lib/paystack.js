// Paystack over its REST API. Amounts sent to Paystack are in kobo (naira × 100).
import { need, err, hex, randomHex } from './http.js';

const CHANNELS = { card: ['card'], bank: ['bank'], transfer: ['bank_transfer'], ussd: ['ussd'] };

export function paystack(env) {
  const secret = () => need(env, 'PAYSTACK_SECRET_KEY');

  async function call(path, opts = {}) {
    const r = await fetch('https://api.paystack.co' + path, { ...opts, headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.status === false) throw err(502, data.message || `Paystack ${r.status}`);
    return data.data;
  }

  return {
    newReference: prefix => `${prefix}_${Date.now().toString(36)}_${randomHex(5)}`,
    // Starts a payment and returns the Paystack page the buyer should be sent to.
    // If the chosen method isn't switched on for your Paystack account yet, it opens Paystack with every method instead.
    async initialize({ email, naira, reference, callbackUrl, metadata, method }) {
      const base = { email, amount: Math.round(naira * 100), currency: 'NGN', reference, callback_url: callbackUrl, metadata };
      if (CHANNELS[method]) {
        try { return await call('/transaction/initialize', { method: 'POST', body: JSON.stringify({ ...base, channels: CHANNELS[method] }) }); }
        catch (e) { console.warn('Paystack refused channel', method, e.message); }
      }
      return call('/transaction/initialize', { method: 'POST', body: JSON.stringify(base) });
    },
    // Asks Paystack for the final state of a payment.
    verify: reference => call(`/transaction/verify/${encodeURIComponent(reference)}`),
    // Paystack signs every webhook with HMAC-SHA512 of the raw body, using your secret key.
    async validSignature(rawBody, signature) {
      if (!signature) return false;
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret()), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
      const expected = hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(rawBody)));
      const got = String(signature).toLowerCase();
      if (got.length !== expected.length) return false;
      let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
      return diff === 0;
    },
  };
}
