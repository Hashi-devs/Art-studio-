// Marking a payment as paid. Used by both the webhook and the return-from-Paystack check,
// so whichever arrives first wins and the other changes nothing.
import { err } from './http.js';

export function orders({ db }, ps) {
  async function find(reference) {
    const rows = await db.select('orders', `reference=eq.${encodeURIComponent(reference)}&select=*`);
    return rows[0] || null;
  }

  // Confirms with Paystack and records the result. Returns the up-to-date order.
  async function confirm(reference) {
    const order = await find(reference);
    if (!order) throw err(404, 'Order not found');
    if (order.status === 'paid') return order;
    const tx = await ps.verify(reference);
    const paidKobo = Number(tx.amount || 0), wantKobo = order.amount * 100;
    if (tx.status === 'success' && paidKobo >= wantKobo && (tx.currency || 'NGN') === 'NGN') {
      const rows = await db.update('orders', `reference=eq.${encodeURIComponent(reference)}&status=neq.paid`, { status: 'paid', paid_at: new Date().toISOString() });
      return rows[0] || (await find(reference));
    }
    if (tx.status === 'failed' || tx.status === 'abandoned') {
      await db.update('orders', `reference=eq.${encodeURIComponent(reference)}&status=eq.pending`, { status: 'failed' });
      return { ...order, status: 'failed' };
    }
    return order; // still pending
  }

  // Total raised, pieces sold and donations, from paid orders, plus the goal.
  async function totals() {
    const [paid, [settings]] = await Promise.all([db.select('orders', 'status=eq.paid&select=amount,type'), db.select('settings', 'id=eq.1&select=goal')]);
    return {
      raised: paid.reduce((s, o) => s + o.amount, 0),
      sold: paid.filter(o => o.type === 'piece').length,
      donated: paid.filter(o => o.type === 'donation').reduce((s, o) => s + o.amount, 0),
      goal: settings ? settings.goal : 500000,
    };
  }

  return { find, confirm, totals };
}
