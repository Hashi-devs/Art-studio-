// AR Studio on Cloudflare Workers. Pages and images in /public are served directly by
// Cloudflare; anything under /api comes here.
import { routes } from './api.js';
import { supabase } from './lib/supabase.js';
import { paystack } from './lib/paystack.js';
import { orders } from './lib/orders.js';
import { fail } from './lib/http.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const route = routes[url.pathname.replace(/\/+$/, '')];
    if (!route) return fail(404, 'Not found');
    const handler = route[request.method];
    if (!handler) {
      const r = fail(405, 'Method not allowed');
      r.headers.set('Allow', Object.keys(route).join(', '));
      return r;
    }
    try {
      // Built per request from your settings, so a missing setting gives a clear message.
      const sb = url.pathname === '/api/config' ? null : supabase(env);
      const ps = paystack(env);
      return await handler({ request, env, ctx, url, sb, ps, ord: sb && orders(sb, ps) });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e && e.stack || e);
      return fail(status, status === 500 ? 'Something went wrong' : e.message);
    }
  },
};
