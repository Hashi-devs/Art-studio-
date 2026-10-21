// Local test server: runs the real Cloudflare Worker (src/worker.js) with the pages in
// /public, and fakes Supabase and Paystack in memory so everything can be tried without accounts.
//   npm run dev   → http://localhost:3999  (admin login: admin@test.dev / testpass)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

export const PORT = +process.env.PORT || 3999;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
export const ORIGIN = `http://localhost:${PORT}`;
// The same settings you add in Cloudflare → Variables and Secrets, with test values.
const ENV = {
  SUPABASE_URL: `${ORIGIN}/sb`, SUPABASE_SERVICE_ROLE_KEY: process.env.TEST_KEY || 'service-key', SUPABASE_ANON_KEY: 'anon-key',
  PAYSTACK_SECRET_KEY: 'sk_test_fake', ADMIN_EMAIL: 'admin@test.dev', SITE_URL: ORIGIN,
};

/* ---------- in-memory database ---------- */
export const DB = { pieces: [], orders: [], settings: [{ id: 1, goal: 500000, updated_at: new Date().toISOString() }] };
export const FILES = {}; // "bucket/path" -> {type, buf}
const USERS = { 'admin@test.dev': 'testpass', 'other@test.dev': 'otherpass' };
const TOKENS = {};
export const TX = {}; // paystack transactions by reference
const DEFAULTS = {
  pieces: () => ({ id: crypto.randomUUID(), description: null, cat: 'arts', tag: 'random', kind: 'drawing', price: 1000, published: true, created_at: new Date().toISOString() }),
  orders: () => ({ id: crypto.randomUUID(), status: 'pending', downloads: 0, note: null, buyer_name: null, extra: 0, on_wall: true, wall_ok: true, piece_id: null, piece_name: null, created_at: new Date().toISOString(), paid_at: null }),
};

function parseQuery(qs) {
  const p = new URLSearchParams(qs), filters = [];
  let select = null, order = null, limit = null;
  for (const [k, v] of p) {
    if (k === 'select') select = v === '*' ? null : v.split(',');
    else if (k === 'order') { const [c, d] = v.split('.'); order = { c, desc: d === 'desc' }; }
    else if (k === 'limit') limit = +v;
    else { const i = v.indexOf('.'); filters.push({ c: k, op: v.slice(0, i), val: v.slice(i + 1) }); }
  }
  return { select, order, limit, filters };
}
const str = v => (v === null || v === undefined ? 'null' : String(v));
const match = (row, fs) => fs.every(f => {
  const v = row[f.c];
  if (f.op === 'eq') return str(v) === f.val;
  if (f.op === 'neq') return str(v) !== f.val;
  if (f.op === 'in') return f.val.replace(/^\(|\)$/g, '').split(',').includes(str(v));
  if (f.op === 'is') return f.val === 'null' ? v == null : str(v) === f.val;
  if (f.op === 'not') return f.val === 'is.null' ? v != null : true;
  return true;
});
function rest(method, table, qs, body) {
  const rows = DB[table]; if (!rows) return [404, { message: 'no table' }];
  const q = parseQuery(qs);
  if (method === 'GET') {
    let out = rows.filter(r => match(r, q.filters));
    if (q.order) out.sort((a, b) => (a[q.order.c] > b[q.order.c] ? 1 : -1) * (q.order.desc ? -1 : 1));
    if (q.limit) out = out.slice(0, q.limit);
    return [200, out.map(r => q.select ? Object.fromEntries(q.select.map(c => [c, r[c]])) : { ...r })];
  }
  if (method === 'POST') {
    if (table === 'orders' && rows.some(r => r.reference === body.reference)) return [409, { message: 'duplicate' }];
    const row = { ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...body };
    rows.push(row); return [201, [row]];
  }
  if (method === 'PATCH') { const hit = rows.filter(r => match(r, q.filters)); hit.forEach(r => Object.assign(r, body)); return [200, hit.map(r => ({ ...r }))]; }
  if (method === 'DELETE') { const hit = rows.filter(r => match(r, q.filters)); DB[table] = rows.filter(r => !hit.includes(r)); return [200, hit]; }
}

/* ---------- helpers ---------- */
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, s, d) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(d)); };
function multipartFile(buf, ctype) {
  const m = /boundary=(.+)$/.exec(ctype || ''); if (!m) return { type: ctype, buf };
  const b = Buffer.from('--' + m[1]); let pos = 0; const parts = [];
  while ((pos = buf.indexOf(b, pos)) !== -1) { const next = buf.indexOf(b, pos + b.length); if (next === -1) break; parts.push(buf.slice(pos + b.length + 2, next - 2)); pos = next; }
  for (const p of parts) { const h = p.indexOf('\r\n\r\n'), head = p.slice(0, h).toString(); if (/filename=/.test(head)) return { type: (/Content-Type: (.+)/i.exec(head) || [])[1] || 'application/octet-stream', buf: p.slice(h + 4) }; }
  return null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain' };

/* ---------- fake Supabase ---------- */
async function supabase(req, res, url) {
  const p = url.pathname.slice(3), body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : null;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
  const svc = req.headers.authorization === 'Bearer service-key' || req.headers.apikey === 'sb_secret_test';
  // auth
  if (p === '/auth/v1/token') {
    const b = JSON.parse(body || '{}'), g = url.searchParams.get('grant_type');
    let email;
    if (g === 'password') { if (USERS[b.email] !== b.password) return json(res, 400, { error_description: 'Invalid login credentials' }); email = b.email; }
    else if (g === 'refresh_token') { const t = Object.values(TOKENS).find(t => t.refresh === b.refresh_token); if (!t) return json(res, 400, { error_description: 'Invalid refresh token' }); email = t.email; }
    const access = crypto.randomBytes(12).toString('hex'), refresh = crypto.randomBytes(12).toString('hex');
    TOKENS[access] = { email, refresh };
    return json(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600, user: { email } });
  }
  if (p === '/auth/v1/user') { const t = TOKENS[(req.headers.authorization || '').slice(7)]; return t ? json(res, 200, { email: t.email }) : json(res, 401, { msg: 'bad jwt' }); }
  // database
  if (p.startsWith('/rest/v1/')) { if (!svc) return json(res, 401, { message: 'RLS' }); const [s, d] = rest(req.method, p.slice(9), url.search.slice(1), body && body.length ? JSON.parse(body) : null); return json(res, s, d); }
  // storage
  let m;
  if ((m = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p))) {
    const key = m[1] + '/' + decodeURIComponent(m[2]);
    if (req.method === 'POST') { if (!svc) return json(res, 401, {}); const tok = crypto.randomBytes(8).toString('hex'); FILES['tok:' + tok] = key; return json(res, 200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=${tok}` }); }
    if (req.method === 'PUT') { if (FILES['tok:' + url.searchParams.get('token')] !== key) return json(res, 403, { message: 'bad token' }); const f = multipartFile(body, req.headers['content-type']); if (!f) return json(res, 400, { message: 'no file' }); FILES[key] = f; return json(res, 200, { Key: key }); }
  }
  if ((m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(p))) {
    const key = m[1] + '/' + decodeURIComponent(m[2]);
    if (req.method === 'POST') { if (!svc) return json(res, 401, {}); if (!FILES[key]) return json(res, 404, { message: 'Object not found' }); const tok = crypto.randomBytes(8).toString('hex'); FILES['dl:' + tok] = key; return json(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${tok}` }); }
    if (req.method === 'GET') { if (FILES['dl:' + url.searchParams.get('token')] !== key) return json(res, 400, { message: 'bad token' }); const f = FILES[key]; res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' }); return res.end(f.buf); }
  }
  if ((m = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/.exec(p))) {
    const key = m[1] + '/' + decodeURIComponent(m[2]), f = FILES[key];
    if (m[1] !== 'previews' || !f) return json(res, 404, { message: 'not found' });
    res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' }); return res.end(f.buf);
  }
  if ((m = /^\/storage\/v1\/object\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { const b = JSON.parse((await readBody(req)) || '{}'); (b.prefixes || []).forEach(k => delete FILES[m[1] + '/' + k]); return json(res, 200, []); }
  json(res, 404, { message: 'fake supabase: unknown ' + req.method + ' ' + p });
}

/* ---------- fake Paystack (the API functions call it with fetch) ---------- */
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts = {}) => {
  const url = new URL(String(u));
  if (url.hostname !== 'api.paystack.co') return realFetch(u, opts);
  if (opts.headers.Authorization !== 'Bearer sk_test_fake') return new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 401 });
  if (url.pathname === '/transaction/initialize') {
    const b = JSON.parse(opts.body);
    if ((b.channels || []).includes('bank_transfer') && process.env.NO_TRANSFER) return new Response(JSON.stringify({ status: false, message: 'No active channel' }), { status: 400 });
    TX[b.reference] = { ...b, status: 'ongoing' };
    return new Response(JSON.stringify({ status: true, data: { authorization_url: `${ORIGIN}/fake-paystack?ref=${b.reference}`, reference: b.reference } }));
  }
  const v = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
  if (v) { const t = TX[decodeURIComponent(v[1])]; if (!t) return new Response(JSON.stringify({ status: false, message: 'Transaction reference not found' }), { status: 400 }); return new Response(JSON.stringify({ status: true, data: { status: t.status, amount: t.amount, currency: 'NGN', reference: t.reference } })); }
  return new Response('{}', { status: 404 });
};
// The pretend Paystack page: ?ok=0 to fail the payment.
function fakePaystack(req, res, url) {
  const t = TX[url.searchParams.get('ref')]; if (!t) { res.writeHead(404); return res.end('no tx'); }
  if (url.searchParams.has('ok')) { t.status = url.searchParams.get('ok') === '1' ? 'success' : 'failed'; res.writeHead(302, { Location: t.callback_url }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px system-ui;padding:30px"><h1>Fake Paystack</h1><p>${t.email} · ₦${t.amount / 100} · ${(t.channels || ['all']).join(',')}</p><a id=pay href="?ref=${t.reference}&ok=1">Pay</a> · <a id=fail href="?ref=${t.reference}&ok=0">Fail</a>`);
}

/* ---------- static files, the way Cloudflare serves /public ---------- */
function asset(url) {
  let f = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (!path.extname(f)) f += '.html';
  const file = path.join(PUBLIC, path.normalize(f));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || path.basename(file).startsWith('_')) {
    return new Response(fs.readFileSync(path.join(PUBLIC, '404.html')), { status: 404, headers: { 'Content-Type': MIME['.html'] } });
  }
  return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' } });
}
const ENV_WITH_ASSETS = { ...ENV, ASSETS: { fetch: req => asset(new URL(req.url)) } };

/* ---------- hand requests to the Worker ---------- */
async function toWorker(req, res, url) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const r = await worker.fetch(request, ENV_WITH_ASSETS, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith('/sb/')) return await supabase(req, res, url);
    if (url.pathname === '/fake-paystack') return fakePaystack(req, res, url);
    if (url.pathname === '/__state') return json(res, 200, { DB, files: Object.keys(FILES).filter(k => !k.includes(':')), TX });
    return await toWorker(req, res, url);
  } catch (e) { console.error(e); json(res, 500, { error: String(e) }); }
});
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) server.listen(PORT, () => console.log('AR Studio test server on ' + ORIGIN));
