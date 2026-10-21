// Minimal Supabase client over its REST APIs (database, storage, auth), using the
// service role key. Server-side only: never send this key to a browser.
const { env } = require('./http');

const base = () => env('SUPABASE_URL').replace(/\/+$/, '');
const key = () => env('SUPABASE_SERVICE_ROLE_KEY');
// New Supabase secret keys (sb_secret_…) go only in the apikey header; older service_role keys also go in Authorization.
const headers = (extra = {}) => ({ apikey: key(), ...(key().startsWith('sb_') ? {} : { Authorization: `Bearer ${key()}` }), ...extra });

async function call(path, opts = {}) {
  const r = await fetch(base() + path, { ...opts, headers: headers(opts.headers) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw Object.assign(new Error((data && (data.message || data.error)) || `Supabase ${r.status}`), { status: 502, detail: data });
  return data;
}

const db = {
  select: (table, query = '') => call(`/rest/v1/${table}?${query}`),
  insert: (table, row) => call(`/rest/v1/${table}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(row) }).then(r => r[0]),
  update: (table, query, patch) => call(`/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(patch) }),
  remove: (table, query) => call(`/rest/v1/${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } }),
};

const storage = {
  publicUrl: (bucket, path) => `${base()}/storage/v1/object/public/${bucket}/${encodePath(path)}`,
  // Short-lived link to a private file.
  async signedUrl(bucket, path, seconds = 3600) {
    const r = await call(`/storage/v1/object/sign/${bucket}/${encodePath(path)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }) });
    return `${base()}/storage/v1${r.signedURL || r.signedUrl}`;
  },
  // Lets the admin browser upload one file straight to storage (skips Vercel's body size limit).
  async signedUploadUrl(bucket, path) {
    const r = await call(`/storage/v1/object/upload/sign/${bucket}/${encodePath(path)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return `${base()}/storage/v1${r.url}`;
  },
  remove: (bucket, paths) => call(`/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) }),
};

// Checks a login token from the admin page and returns the user if it belongs to ADMIN_EMAIL.
async function adminUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw Object.assign(new Error('Please log in'), { status: 401 });
  const r = await fetch(base() + '/auth/v1/user', { headers: { apikey: key(), Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Object.assign(new Error('Your login has expired. Log in again.'), { status: 401 });
  const user = await r.json();
  const admin = env('ADMIN_EMAIL').trim().toLowerCase();
  if ((user.email || '').toLowerCase() !== admin) throw Object.assign(new Error('This account is not the admin'), { status: 403 });
  return user;
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

module.exports = { db, storage, adminUser, base };
