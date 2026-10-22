// Every /api route. Each handler gets { request, env, url, sb, ps, ord } and returns a Response.
import { json, fail, err, readJson, need, isEmail, randomHex } from './lib/http.js';

const REF = /^[a-z]{2}_[a-z0-9_]{6,40}$/i;
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_DOWNLOADS = 10;
const CATS = ['arts', 'sketches', 'illustrations', 'stories', 'photos', 'games', 'tools'];
// Games and tools aren't bought at a fixed price: people send their interest instead.
const TALK = ['games', 'tools'];

/* A preview path starting with / is a file on the site itself (used for Sketch Studio's card). */
const previewUrl = (sb, path) => String(path || '').startsWith('/') ? path : sb.storage.publicUrl('previews', path);
const cleanLink = v => { const u = String(v || '').trim().slice(0, 300); if (!u) return null; if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(u)) throw err(400, 'The preview link should start with https://'); return u; };
const KINDS = ['drawing', 'colour', 'photo'];
// Filter tags are whatever the admin types: lower case, letters, numbers, spaces, & ' -
const cleanTag = v => String(v || '').toLowerCase().replace(/[^a-z0-9 &'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
const validPath = p => typeof p === 'string' && /^[a-z0-9][a-z0-9._/-]{3,200}$/i.test(p) && !p.includes('..');
const siteUrl = env => need(env, 'SITE_URL').replace(/\/+$/, '');
const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=120' };

const bgOut = sb => b => ({ id: b.id, name: b.name, type: b.type, area: b.area || null, img: previewUrl(sb, b.path), sort: b.sort });
// A mockup's art area: fractions of the image, inside it, not too small.
function cleanArea(a) {
  const v = ['x', 'y', 'w', 'h'].map(k => Number(a && a[k]));
  if (v.some(n => !Number.isFinite(n))) throw err(400, 'Mark where the drawing goes on the mockup');
  let [x, y, w, h] = v.map(n => Math.max(0, Math.min(1, n)));
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  if (w < .05 || h < .05) throw err(400, 'Make the drawing area a bit bigger');
  const r = n => Math.round(n * 1000) / 1000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/* ---------- public ---------- */

// Everything the public page needs: listed pieces, goal and total raised.
async function site({ sb, ord }) {
  const [rows, t, bgs] = await Promise.all([
    sb.db.select('pieces', 'published=eq.true&select=id,name,cat,tag,kind,price,description,link,preview_path,created_at&order=created_at.desc'),
    ord.totals(),
    sb.db.select('backgrounds', 'select=id,name,type,path,area&order=sort.asc,created_at.asc').catch(() => null),
  ]);
  const pieces = rows.map(p => ({ id: p.id, name: p.name, cat: p.cat, tag: p.tag, kind: p.kind, price: p.price, description: p.description || '', link: p.link || null, talk: TALK.includes(p.cat), date: p.created_at, img: previewUrl(sb, p.preview_path) }));
  return json(200, { ok: true, pieces, goal: t.goal, raised: t.raised, sold: t.sold, backgrounds: bgs && bgs.map(bgOut(sb)) }, PUBLIC_CACHE);
}

// Public values the admin page needs to log in. The publishable (anon) key is meant to be public.
async function config({ env }) {
  return json(200, { ok: true, supabaseUrl: need(env, 'SUPABASE_URL').replace(/\/+$/, ''), anonKey: need(env, 'SUPABASE_ANON_KEY') });
}

// Starts a Paystack payment for one piece. The price always comes from the database.
async function checkout({ request, env, sb, ps }) {
  const { pieceId, email, note, method, name, extra, onWall } = await readJson(request);
  const who = String(name || '').trim().slice(0, 60);
  const add = Math.round(Number(extra) || 0);
  if (!who) return fail(400, 'Enter your name');
  if (!(add >= 0 && add <= 1000000)) return fail(400, 'Enter an extra amount from ₦0');
  if (!isEmail(email)) return fail(400, 'Enter a valid email');
  if (!UUID.test(String(pieceId || ''))) return fail(400, 'Pick a piece first');
  const [piece] = await sb.db.select('pieces', `id=eq.${pieceId}&published=eq.true&select=id,name,price,cat`);
  if (!piece) return fail(404, 'That piece is no longer available');
  if (TALK.includes(piece.cat)) return fail(400, 'This one is by arrangement. Send your interest instead');
  const reference = ps.newReference('ar'), wall = onWall !== false;
  await sb.db.insert('orders', { reference, type: 'piece', piece_id: piece.id, piece_name: piece.name, email: email.trim(), note: String(note || '').trim().slice(0, 600) || null, buyer_name: who, extra: add, on_wall: wall, wall_ok: wall, amount: piece.price + add });
  const tx = await ps.initialize({ email: email.trim(), naira: piece.price + add, reference, callbackUrl: `${siteUrl(env)}/?ref=${reference}`, metadata: { type: 'piece', piece: piece.name }, method });
  return json(200, { ok: true, url: tx.authorization_url, reference });
}

// Starts a Paystack payment for a donation. A name is optional; without one, nobody shows on the wall.
async function donate({ request, env, sb, ps }) {
  const { amount, email, note, method, name, onWall } = await readJson(request);
  const who = String(name || '').trim().slice(0, 60) || null;
  const naira = Math.round(Number(amount));
  if (!Number.isFinite(naira) || naira < 100 || naira > 5000000) return fail(400, 'Enter an amount from ₦100');
  if (!isEmail(email)) return fail(400, 'Enter a valid email');
  const reference = ps.newReference('dn'), wall = !!who && onWall !== false;
  await sb.db.insert('orders', { reference, type: 'donation', email: email.trim(), note: String(note || '').trim().slice(0, 600) || null, buyer_name: who, on_wall: wall, wall_ok: wall, amount: naira });
  const tx = await ps.initialize({ email: email.trim(), naira, reference, callbackUrl: `${siteUrl(env)}/?ref=${reference}`, metadata: { type: 'donation' }, method });
  return json(200, { ok: true, url: tx.authorization_url, reference });
}

// Called when the buyer returns from Paystack. Confirms the payment and, for a piece,
// hands back a 30-minute link to the full-quality original.
async function verify({ url, sb, ord }) {
  const ref = url.searchParams.get('ref') || '';
  if (!REF.test(ref)) return fail(400, 'Unknown payment reference');
  const order = await ord.confirm(ref);
  if (order.status !== 'paid') return json(200, { ok: true, status: order.status, type: order.type });
  if (order.type === 'donation') return json(200, { ok: true, status: 'paid', type: 'donation', amount: order.amount });
  if (order.downloads >= MAX_DOWNLOADS) return fail(410, 'This download link has been used too many times. Reply to your receipt email for help.');
  const [piece] = order.piece_id ? await sb.db.select('pieces', `id=eq.${order.piece_id}&select=id,name,kind,original_path`) : [];
  if (!piece) return fail(404, 'This piece was removed. Reply to your receipt email for help.');
  const link = await sb.storage.signedUrl('originals', piece.original_path, 60 * 30);
  await sb.db.update('orders', `id=eq.${order.id}`, { downloads: order.downloads + 1 });
  return json(200, { ok: true, status: 'paid', type: 'piece', piece: { id: piece.id, name: piece.name, kind: piece.kind }, url: link });
}

// Paystack calls this when a payment completes, even if the buyer closed the tab.
async function webhook({ request, ps, ord }) {
  const raw = await request.text();
  if (!(await ps.validSignature(raw, request.headers.get('x-paystack-signature')))) return fail(401, 'Bad signature');
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { return fail(400, 'Bad body'); }
  const ref = event.data && event.data.reference;
  if (event.event === 'charge.success' && ref && REF.test(ref) && (await ord.find(ref))) await ord.confirm(ref);
  return json(200, { ok: true });
}

// The Thank-yous wall: names and messages of people who chose to be shown. Never emails or amounts.
async function thanks({ sb }) {
  const rows = await sb.db.select('orders', 'status=eq.paid&on_wall=eq.true&buyer_name=not.is.null&select=reference,buyer_name,note,type,piece_id,piece_name,paid_at&order=paid_at.desc&limit=500');
  const ids = [...new Set(rows.map(r => r.piece_id).filter(Boolean))];
  const pieces = ids.length ? await sb.db.select('pieces', `id=in.(${ids.join(',')})&select=id,kind,preview_path`) : [];
  const byId = Object.fromEntries(pieces.map(p => [p.id, p]));
  const people = rows.map(r => {
    const p = byId[r.piece_id];
    return { id: r.reference.slice(-10), name: r.buyer_name, message: r.note || '', type: r.type, date: r.paid_at,
      piece: r.type === 'piece' ? { name: r.piece_name, kind: p ? p.kind : 'drawing', img: p ? previewUrl(sb, p.preview_path) : null } : null };
  });
  return json(200, { ok: true, people }, PUBLIC_CACHE);
}

// Someone interested in a game or tool. Saved for the admin page, and emailed to you when email is set up.
async function enquire({ request, env, ctx, sb }) {
  const { pieceId, name, email, message, budget } = await readJson(request);
  const who = String(name || '').trim().slice(0, 60), text = String(message || '').trim().slice(0, 1500), bud = String(budget || '').trim().slice(0, 80) || null;
  if (!who) return fail(400, 'Enter your name');
  if (!isEmail(email)) return fail(400, 'Enter a valid email');
  if (text.length < 5) return fail(400, 'Tell me a little about what you have in mind');
  if (!UUID.test(String(pieceId || ''))) return fail(400, 'Pick a game or tool first');
  const [piece] = await sb.db.select('pieces', `id=eq.${pieceId}&published=eq.true&select=id,name,cat`);
  if (!piece || !TALK.includes(piece.cat)) return fail(404, 'That one is no longer available');
  const row = await sb.db.insert('enquiries', { piece_id: piece.id, piece_name: piece.name, name: who, email: email.trim(), message: text, budget: bud });
  const send = notify(env, {
    subject: `New interest in ${piece.name} from ${who}`,
    replyTo: email.trim(),
    text: `${who} (${email.trim()}) is interested in ${piece.name}.\n\n${text}\n\n${bud ? 'Budget: ' + bud + '\n\n' : ''}Reply to this email to answer them, or see it in your admin page under Messages.`,
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
  return json(201, { ok: true, id: row.id });
}

// Emails you through Resend, if RESEND_API_KEY and NOTIFY_EMAIL are set. Never stops the request if it fails.
async function notify(env, { subject, text, replyTo }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.NOTIFY_FROM || 'AR Studios <onboarding@resend.dev>', to: [String(env.NOTIFY_EMAIL).trim()], reply_to: replyTo, subject, text }),
    });
    if (!r.ok) console.warn('Email not sent', r.status, await r.text());
  } catch (e) { console.warn('Email not sent', e.message); }
}

/* ---------- admin (every handler checks the login first) ---------- */

// Messages about games and tools: list (GET) or mark as replied / closed (PATCH ?id=).
async function enquiries({ request, url, sb }) {
  await sb.adminUser(request);
  if (request.method === 'GET') return json(200, { ok: true, enquiries: await sb.db.select('enquiries', 'select=*&order=created_at.desc&limit=100') });
  const id = url.searchParams.get('id') || '';
  if (!UUID.test(id)) return fail(400, 'Missing message id');
  const status = (await readJson(request)).status;
  if (!['new', 'replied', 'closed'].includes(status)) return fail(400, 'Unknown status');
  const [row] = await sb.db.update('enquiries', `id=eq.${id}`, { status });
  return row ? json(200, { ok: true, enquiry: row }) : fail(404, 'Message not found');
}


async function stats({ request, sb, ord }) {
  await sb.adminUser(request);
  const [t, recent, pieces, paidPieces, fresh] = await Promise.all([
    ord.totals(),
    sb.db.select('orders', 'select=reference,type,piece_name,buyer_name,extra,on_wall,wall_ok,email,note,amount,status,downloads,created_at,paid_at&order=created_at.desc&limit=50'),
    sb.db.select('pieces', 'select=id,published'),
    sb.db.select('orders', 'status=eq.paid&type=eq.piece&select=piece_name'),
    sb.db.select('enquiries', 'status=eq.new&select=id').catch(() => []),
  ]);
  const counts = {};
  paidPieces.forEach(o => { const k = o.piece_name || 'Removed piece'; counts[k] = (counts[k] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, sold]) => ({ name, sold }));
  return json(200, {
    ok: true, ...t,
    pieces: pieces.length, live: pieces.filter(p => p.published).length,
    donations: recent.filter(o => o.type === 'donation' && o.status === 'paid').length,
    pending: recent.filter(o => o.status === 'pending').length,
    top, recent, newMessages: fresh.length,
  });
}

// Keeps only the fields the admin may set, checking each.
function cleanPiece(body, partial) {
  const out = {};
  if (!partial || 'name' in body) { const n = String(body.name || '').trim().slice(0, 80); if (!n) throw err(400, 'Give the piece a name'); out.name = n; }
  if (!partial || 'cat' in body) { if (!CATS.includes(body.cat)) throw err(400, 'Pick a section'); out.cat = body.cat; }
  if (!partial || 'tag' in body) out.tag = cleanTag(body.tag) || 'random';
  if (!partial || 'kind' in body) out.kind = KINDS.includes(body.kind) ? body.kind : 'drawing';
  if (!partial || 'price' in body) { const p = Math.round(Number(body.price ?? 1000)); if (!(p >= 100 && p <= 1000000)) throw err(400, 'Price must be from ₦100'); out.price = p; }
  if (!partial || 'link' in body) out.link = cleanLink(body.link);
  if (!partial || 'description' in body) out.description = String(body.description || '').trim().slice(0, 600) || null;
  if ('published' in body) out.published = !!body.published;
  if (!partial) {
    if (!validPath(body.preview_path) || !validPath(body.original_path)) throw err(400, 'Upload the image first');
    out.preview_path = body.preview_path; out.original_path = body.original_path;
  }
  return out;
}

// List (GET), add (POST), edit / delist (PATCH ?id=), delete (DELETE ?id=).
async function pieces({ request, url, sb }) {
  await sb.adminUser(request);
  const m = request.method;
  if (m === 'GET') {
    const [rows, sold] = await Promise.all([sb.db.select('pieces', 'select=*&order=created_at.desc'), sb.db.select('orders', 'status=eq.paid&type=eq.piece&select=piece_id')]);
    const n = {}; sold.forEach(o => { n[o.piece_id] = (n[o.piece_id] || 0) + 1; });
    return json(200, { ok: true, pieces: rows.map(p => ({ ...p, img: previewUrl(sb, p.preview_path), sold: n[p.id] || 0 })) });
  }
  if (m === 'POST') return json(201, { ok: true, piece: await sb.db.insert('pieces', cleanPiece(await readJson(request), false)) });
  const id = url.searchParams.get('id') || '';
  if (!UUID.test(id)) return fail(400, 'Missing piece id');
  if (m === 'PATCH') {
    const [row] = await sb.db.update('pieces', `id=eq.${id}`, cleanPiece(await readJson(request), true));
    return row ? json(200, { ok: true, piece: row }) : fail(404, 'Piece not found');
  }
  // DELETE: remove the row, then its files. Past orders keep the piece name.
  const [row] = await sb.db.remove('pieces', `id=eq.${id}`);
  if (!row) return fail(404, 'Piece not found');
  await Promise.allSettled([sb.storage.remove('previews', [row.preview_path]), sb.storage.remove('originals', [row.original_path])]);
  return json(200, { ok: true });
}

// Two one-time upload links: the public preview and the private original.
async function uploadUrl({ request, sb }) {
  await sb.adminUser(request);
  const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };
  const body = await readJson(request);
  const ext = EXT[String(body.ext || 'png').toLowerCase()] || 'png';
  const prevExt = EXT[String(body.previewExt || 'webp').toLowerCase()] || 'webp';
  const stem = `${new Date().toISOString().slice(0, 7)}/${randomHex(8)}`;
  const preview_path = `${stem}.${prevExt}`, original_path = `${stem}.${ext}`;
  const [previewUrl, originalUrl] = await Promise.all([sb.storage.signedUploadUrl('previews', preview_path), sb.storage.signedUploadUrl('originals', original_path)]);
  return json(200, { ok: true, preview: { path: preview_path, url: previewUrl }, original: { path: original_path, url: originalUrl } });
}

// Download backgrounds and mockups: list (GET), add (POST), rename / move / re-mark (PATCH ?id=), remove (DELETE ?id=).
async function backgrounds({ request, url, sb }) {
  await sb.adminUser(request);
  const m = request.method;
  if (m === 'GET') return json(200, { ok: true, backgrounds: (await sb.db.select('backgrounds', 'select=*&order=sort.asc,created_at.asc')).map(bgOut(sb)) });
  if (m === 'POST') {
    const b = await readJson(request), name = String(b.name || '').trim().slice(0, 40), type = b.type === 'mockup' ? 'mockup' : 'paper';
    if (!name) return fail(400, 'Give it a name');
    if (!validPath(b.path) || !String(b.path).startsWith('bg/')) return fail(400, 'Upload the image first');
    const all = await sb.db.select('backgrounds', 'select=sort&order=sort.desc&limit=1');
    const row = await sb.db.insert('backgrounds', { name, type, path: b.path, area: type === 'mockup' ? cleanArea(b.area) : null, sort: (all[0] ? all[0].sort : 0) + 1 });
    return json(201, { ok: true, background: bgOut(sb)(row) });
  }
  const id = url.searchParams.get('id') || '';
  if (!UUID.test(id)) return fail(400, 'Missing background id');
  if (m === 'PATCH') {
    const b = await readJson(request), patch = {};
    if ('name' in b) { const n = String(b.name || '').trim().slice(0, 40); if (!n) return fail(400, 'Give it a name'); patch.name = n; }
    if ('area' in b) patch.area = cleanArea(b.area);
    if ('sort' in b) { const s = Math.round(Number(b.sort)); if (!Number.isFinite(s)) return fail(400, 'Bad position'); patch.sort = s; }
    const [row] = await sb.db.update('backgrounds', `id=eq.${id}`, patch);
    return row ? json(200, { ok: true, background: bgOut(sb)(row) }) : fail(404, 'Background not found');
  }
  const [row] = await sb.db.remove('backgrounds', `id=eq.${id}`);
  if (!row) return fail(404, 'Background not found');
  if (!String(row.path).startsWith('/')) await Promise.allSettled([sb.storage.remove('previews', [row.path])]);
  return json(200, { ok: true });
}

// One upload link for a new background image (public, in the previews bucket under bg/).
async function bgUploadUrl({ request, sb }) {
  await sb.adminUser(request);
  const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };
  const ext = EXT[String((await readJson(request)).ext || 'jpg').toLowerCase()] || 'jpg';
  const path = `bg/${randomHex(8)}.${ext}`;
  return json(200, { ok: true, path, url: await sb.storage.signedUploadUrl('previews', path) });
}

// Read (GET) or change (PATCH {goal}) the laptop goal.
async function settings({ request, sb }) {
  await sb.adminUser(request);
  if (request.method === 'GET') { const [s] = await sb.db.select('settings', 'id=eq.1&select=goal'); return json(200, { ok: true, goal: s ? s.goal : 500000 }); }
  const goal = Math.round(Number((await readJson(request)).goal));
  if (!(goal >= 1000 && goal <= 100000000)) return fail(400, 'Enter a goal from ₦1,000');
  const [s] = await sb.db.update('settings', 'id=eq.1', { goal, updated_at: new Date().toISOString() });
  return json(200, { ok: true, goal: s ? s.goal : goal });
}

// Show or hide someone on the Thank-yous wall. People who chose to stay private can't be shown.
async function adminOrders({ request, url, sb }) {
  await sb.adminUser(request);
  const ref = url.searchParams.get('ref') || '';
  if (!REF.test(ref)) return fail(400, 'Unknown order');
  const want = !!(await readJson(request)).onWall;
  const [order] = await sb.db.select('orders', `reference=eq.${encodeURIComponent(ref)}&select=wall_ok`);
  if (!order) return fail(404, 'Order not found');
  if (want && !order.wall_ok) return fail(403, 'They chose to stay private');
  const [row] = await sb.db.update('orders', `reference=eq.${encodeURIComponent(ref)}`, { on_wall: want });
  return json(200, { ok: true, on_wall: row.on_wall });
}

// Which settings the Worker can see (names only, never values), to help with setup.
async function health({ env }) {
  const want = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYSTACK_SECRET_KEY', 'ADMIN_EMAIL', 'SITE_URL'];
  const settings = Object.fromEntries(want.map(k => [k, env[k] ? 'found' : 'MISSING']));
  const near = Object.keys(env).filter(k => k !== 'ASSETS' && !want.includes(k)); // misspelled names show up here
  return json(200, { ok: want.every(k => env[k]), settings, otherNames: near });
}

// path → { METHOD: handler }
export const routes = {
  '/api/health': { GET: health },
  '/api/site': { GET: site },
  '/api/config': { GET: config },
  '/api/checkout': { POST: checkout },
  '/api/donate': { POST: donate },
  '/api/verify': { GET: verify },
  '/api/paystack-webhook': { POST: webhook },
  '/api/thanks': { GET: thanks },
  '/api/enquire': { POST: enquire },
  '/api/admin/enquiries': { GET: enquiries, PATCH: enquiries },
  '/api/admin/stats': { GET: stats },
  '/api/admin/pieces': { GET: pieces, POST: pieces, PATCH: pieces, DELETE: pieces },
  '/api/admin/upload-url': { POST: uploadUrl },
  '/api/admin/settings': { GET: settings, PATCH: settings },
  '/api/admin/backgrounds': { GET: backgrounds, POST: backgrounds, PATCH: backgrounds, DELETE: backgrounds },
  '/api/admin/bg-upload-url': { POST: bgUploadUrl },
  '/api/admin/orders': { PATCH: adminOrders },
};
