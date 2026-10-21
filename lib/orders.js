// Shared order logic: marking a payment as paid (used by both the webhook and the
// return-from-Paystack check, so whichever arrives first wins and the other is a no-op).
const { db } = require('./supabase');
const paystack = require('./paystack');

async function findOrder(reference) {
  const rows = await db.select('orders', `reference=eq.${encodeURIComponent(reference)}&select=*`);
  return rows[0] || null;
}

// Confirms with Paystack and records the result. Returns the up-to-date order.
async function confirm(reference) {
  const order = await findOrder(reference);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (order.status === 'paid') return order;
  const tx = await paystack.verify(reference);
  const paidKobo = Number(tx.amount || 0), wantKobo = order.amount * 100;
  if (tx.status === 'success' && paidKobo >= wantKobo && (tx.currency || 'NGN') === 'NGN') {
    const rows = await db.update('orders', `reference=eq.${encodeURIComponent(reference)}&status=neq.paid`, { status: 'paid', paid_at: new Date().toISOString() });
    return rows[0] || (await findOrder(reference));
  }
  if (tx.status === 'failed' || tx.status === 'abandoned') {
    await db.update('orders', `reference=eq.${encodeURIComponent(reference)}&status=eq.pending`, { status: 'failed' });
    return { ...order, status: 'failed' };
  }
  return order; // still pending
}

// Total raised and pieces sold, from paid orders.
async function totals() {
  const paid = await db.select('orders', 'status=eq.paid&select=amount,type');
  const raised = paid.reduce((s, o) => s + o.amount, 0);
  const sold = paid.filter(o => o.type === 'piece').length;
  const donated = paid.filter(o => o.type === 'donation').reduce((s, o) => s + o.amount, 0);
  const [settings] = await db.select('settings', 'id=eq.1&select=goal');
  return { raised, sold, donated, goal: settings ? settings.goal : 500000 };
}

module.exports = { findOrder, confirm, totals };
