// POST /api/paystack-webhook — Paystack calls this when a payment completes, even if the
// buyer closes the tab before coming back. Set this URL in Paystack → Settings → API Keys & Webhooks.
const { send, fail, handle, readRaw } = require('../lib/http');
const paystack = require('../lib/paystack');
const { findOrder, confirm } = require('../lib/orders');

module.exports = handle(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const raw = await readRaw(req);
  if (!paystack.validSignature(raw, req.headers['x-paystack-signature'])) return fail(res, 401, 'Bad signature');
  const event = JSON.parse(raw || '{}');
  const ref = event.data && event.data.reference;
  if (event.event === 'charge.success' && ref && (await findOrder(ref))) await confirm(ref);
  send(res, 200, { ok: true });
});

// Paystack's signature covers the exact bytes it sent, so the body must not be pre-parsed.
module.exports.config = { api: { bodyParser: false } };
