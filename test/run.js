// API tests against the fake Supabase + Paystack in dev-server.js.   npm test
const assert = require('assert');
const crypto = require('crypto');
const { server, DB, TX, ORIGIN, PORT } = require('./dev-server');

const call = async (path, opts = {}) => {
  const r = await fetch(ORIGIN + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (email, password) => (await (await fetch(`${ORIGIN}/sb/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: 'anon-key' }, body: JSON.stringify({ email, password }) })).json()).access_token;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let admin, other, piece;
const A = () => ({ Authorization: 'Bearer ' + admin });

test('site works with an empty shop', async () => {
  const r = await call('/api/site');
  assert.equal(r.status, 200); assert.deepEqual(r.body.pieces, []); assert.equal(r.body.raised, 0); assert.equal(r.body.goal, 500000);
});
test('config only exposes the public anon key', async () => {
  const r = await call('/api/config');
  assert.equal(r.body.anonKey, 'anon-key'); assert(!JSON.stringify(r.body).includes('service-key'));
});
test('admin routes reject missing, bad and non-admin logins', async () => {
  admin = await login('admin@test.dev', 'testpass'); other = await login('other@test.dev', 'otherpass');
  assert.equal((await call('/api/admin/stats')).status, 401);
  assert.equal((await call('/api/admin/stats', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await call('/api/admin/stats', { headers: { Authorization: 'Bearer ' + other } })).status, 403);
  assert.equal((await call('/api/admin/stats', { headers: A() })).status, 200);
});
test('admin uploads a piece through signed URLs', async () => {
  const up = await call('/api/admin/upload-url', { method: 'POST', headers: A(), body: JSON.stringify({ ext: 'png', previewExt: 'webp' }) });
  assert.equal(up.status, 200);
  for (const [k, type] of [['preview', 'image/webp'], ['original', 'image/png']]) {
    const fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', new Blob([Buffer.from(k + '-bytes')], { type }));
    const r = await fetch(up.body[k].url, { method: 'PUT', body: fd }); assert.equal(r.status, 200, k);
  }
  const bad = await call('/api/admin/pieces', { method: 'POST', headers: A(), body: JSON.stringify({ name: '', cat: 'arts', preview_path: up.body.preview.path, original_path: up.body.original.path }) });
  assert.equal(bad.status, 400);
  const r = await call('/api/admin/pieces', { method: 'POST', headers: A(), body: JSON.stringify({ name: 'Ewuro', description: 'A portrait in pen.', cat: 'arts', tag: 'people', kind: 'drawing', price: 1500, published: true, preview_path: up.body.preview.path, original_path: up.body.original.path }) });
  assert.equal(r.status, 201); piece = r.body.piece;
  const site = await call('/api/site');
  assert.equal(site.body.pieces.length, 1); assert.equal(site.body.pieces[0].price, 1500); assert.equal(site.body.pieces[0].description, 'A portrait in pen.'); assert(site.body.pieces[0].date);
  assert(!JSON.stringify(site.body).includes('original'), 'site must not reveal the original file');
  assert.equal(await (await fetch(site.body.pieces[0].img)).text(), 'preview-bytes');
});
test('private originals are not public', async () => {
  const r = await fetch(`${ORIGIN}/sb/storage/v1/object/public/originals/${piece.original_path}`); assert.equal(r.status, 404);
});
test('checkout validates input', async () => {
  assert.equal((await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'a@b.co' }) })).status, 400, 'name required');
  assert.equal((await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'a@b.co', name: 'A', extra: -5 }) })).status, 400, 'no negative extra');
  assert.equal((await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'bad' }) })).status, 400);
  assert.equal((await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: crypto.randomUUID(), email: 'a@b.co', name: 'A' }) })).status, 404);
  assert.equal((await call('/api/checkout', { method: 'GET' })).status, 405);
});
let ref;
test('checkout uses the database price, not the browser', async () => {
  const r = await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'buyer@x.com', name: 'Tolu A.', note: 'For Tolu', method: 'transfer', price: 1 }) });
  assert.equal(r.status, 200); ref = r.body.reference;
  assert.equal(TX[ref].amount, 150000); assert.deepEqual(TX[ref].channels, ['bank_transfer']);
  assert.equal(TX[ref].callback_url, `${ORIGIN}/?ref=${ref}`);
});
test('no download before payment', async () => {
  const r = await call('/api/verify?ref=' + ref); assert.equal(r.body.status, 'pending'); assert(!r.body.url);
});
test('underpaid transactions are not accepted', async () => {
  TX[ref].status = 'success'; TX[ref].amount = 100;
  const r = await call('/api/verify?ref=' + ref); assert.notEqual(r.body.status, 'paid'); TX[ref].amount = 150000; TX[ref].status = 'ongoing';
});
test('webhook rejects bad signatures and accepts good ones', async () => {
  TX[ref].status = 'success';
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: ref } });
  assert.equal((await call('/api/paystack-webhook', { method: 'POST', body: raw, headers: { 'x-paystack-signature': 'abc' } })).status, 401);
  const sig = crypto.createHmac('sha512', 'sk_test_fake').update(raw).digest('hex');
  assert.equal((await call('/api/paystack-webhook', { method: 'POST', body: raw, headers: { 'x-paystack-signature': sig } })).status, 200);
  assert.equal(DB.orders.find(o => o.reference === ref).status, 'paid');
});
test('verify after payment returns a signed link to the original', async () => {
  const r = await call('/api/verify?ref=' + ref);
  assert.equal(r.body.status, 'paid'); assert.equal(r.body.piece.name, 'Ewuro');
  assert.equal(await (await fetch(r.body.url)).text(), 'original-bytes');
  assert.equal((await call('/api/site')).body.raised, 1500);
});
test('download count is capped', async () => {
  for (let i = 0; i < 9; i++) await call('/api/verify?ref=' + ref);
  assert.equal((await call('/api/verify?ref=' + ref)).status, 410);
});
test('donations count towards the total', async () => {
  assert.equal((await call('/api/donate', { method: 'POST', body: JSON.stringify({ amount: 50, email: 'a@b.co' }) })).status, 400);
  const r = await call('/api/donate', { method: 'POST', body: JSON.stringify({ amount: 2000, email: 'kind@x.com' }) });
  TX[r.body.reference].status = 'success';
  const v = await call('/api/verify?ref=' + r.body.reference);
  assert.equal(v.body.type, 'donation'); assert.equal(v.body.amount, 2000);
  const s = await call('/api/admin/stats', { headers: A() });
  assert.equal(s.body.raised, 3500); assert.equal(s.body.donated, 2000); assert.equal(s.body.sold, 1); assert.equal(s.body.top[0].name, 'Ewuro');
});
test('failed payments are marked failed', async () => {
  const r = await call('/api/donate', { method: 'POST', body: JSON.stringify({ amount: 500, email: 'k@x.com' }) });
  TX[r.body.reference].status = 'failed';
  assert.equal((await call('/api/verify?ref=' + r.body.reference)).body.status, 'failed');
});
test('extra amounts are added to the price', async () => {
  const r = await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'x@y.co', name: 'Shy One', note: 'secret', extra: 500, onWall: false }) });
  assert.equal(TX[r.body.reference].amount, 200000);
  TX[r.body.reference].status = 'success';
  assert.equal((await call('/api/verify?ref=' + r.body.reference)).body.status, 'paid');
});
test('Thank-yous wall shows only people who chose it, with no emails or amounts', async () => {
  const w = await call('/api/thanks');
  const names = w.body.people.map(p => p.name);
  assert(names.includes('Tolu A.')); assert(!names.includes('Shy One'));
  const tolu = w.body.people.find(p => p.name === 'Tolu A.');
  assert.equal(tolu.message, 'For Tolu'); assert.equal(tolu.piece.name, 'Ewuro'); assert(tolu.piece.img);
  const raw = JSON.stringify(w.body); assert(!raw.includes('@')); assert(!raw.includes('amount'));
  assert(!names.includes(null), 'nameless donations stay off the wall');
});
test('admin can hide someone from the wall', async () => {
  assert.equal((await call('/api/admin/orders?ref=' + ref, { method: 'PATCH', body: JSON.stringify({ onWall: false }) })).status, 401);
  await call('/api/admin/orders?ref=' + ref, { method: 'PATCH', headers: A(), body: JSON.stringify({ onWall: false }) });
  assert(!(await call('/api/thanks')).body.people.some(p => p.name === 'Tolu A.'));
  await call('/api/admin/orders?ref=' + ref, { method: 'PATCH', headers: A(), body: JSON.stringify({ onWall: true }) });
});
test('admin cannot show someone who chose to stay private', async () => {
  const o = DB.orders.find(o => o.buyer_name === 'Shy One');
  assert.equal((await call('/api/admin/orders?ref=' + o.reference, { method: 'PATCH', headers: A(), body: JSON.stringify({ onWall: true }) })).status, 403);
  assert(!(await call('/api/thanks')).body.people.some(p => p.name === 'Shy One'));
});
test('admin sets the goal', async () => {
  assert.equal((await call('/api/admin/settings', { method: 'PATCH', headers: A(), body: JSON.stringify({ goal: 5 }) })).status, 400);
  await call('/api/admin/settings', { method: 'PATCH', headers: A(), body: JSON.stringify({ goal: 650000 }) });
  assert.equal((await call('/api/site')).body.goal, 650000);
});
test('filter tags can be anything the admin types', async () => {
  await call('/api/admin/pieces?id=' + piece.id, { method: 'PATCH', headers: A(), body: JSON.stringify({ tag: '  Lagos  Nights!! ' }) });
  assert.equal((await call('/api/site')).body.pieces[0].tag, 'lagos nights');
  await call('/api/admin/pieces?id=' + piece.id, { method: 'PATCH', headers: A(), body: JSON.stringify({ tag: '' }) });
  assert.equal((await call('/api/site')).body.pieces[0].tag, 'random');
});
test('admin hides, edits and deletes a piece', async () => {
  await call('/api/admin/pieces?id=' + piece.id, { method: 'PATCH', headers: A(), body: JSON.stringify({ published: false, price: 2000, preview_path: 'hack' }) });
  assert.equal((await call('/api/site')).body.pieces.length, 0);
  const list = await call('/api/admin/pieces', { headers: A() });
  assert.equal(list.body.pieces[0].price, 2000); assert.equal(list.body.pieces[0].preview_path, piece.preview_path); assert.equal(list.body.pieces[0].sold, 2);
  assert.equal((await call('/api/checkout', { method: 'POST', body: JSON.stringify({ pieceId: piece.id, email: 'a@b.co', name: 'A' }) })).status, 404, 'hidden pieces cannot be bought');
  assert.equal((await call('/api/admin/pieces?id=' + piece.id, { method: 'DELETE', headers: A() })).status, 200);
  assert.equal(DB.pieces.length, 0); assert.equal(DB.orders.find(o => o.reference === ref).piece_name, 'Ewuro');
});

server.listen(PORT, async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
  }
  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} passed`);
  server.close(); process.exit(failed ? 1 : 0);
});
