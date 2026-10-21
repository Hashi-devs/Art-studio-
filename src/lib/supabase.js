// Minimal Supabase client over its REST APIs (database, storage, auth), using the secret
// (service role) key. Server-side only: this key never reaches a browser.
import { need, err } from './http.js';

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

export function supabase(env) {
  const base = need(env, 'SUPABASE_URL').replace(/\/+$/, '');
  const key = need(env, 'SUPABASE_SERVICE_ROLE_KEY');
  // New secret keys (sb_secret_…) go only in the apikey header; older service_role keys also go in Authorization.
  const headers = (extra = {}) => ({ apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), ...extra });

  async function call(path, opts = {}) {
    const r = await fetch(base + path, { ...opts, headers: headers(opts.headers) });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    if (!r.ok) { console.error('Supabase', r.status, path, data); throw err(502, (data && (data.message || data.error)) || `Supabase ${r.status}`); }
    return data;
  }
  const JSONH = { 'Content-Type': 'application/json' };

  const db = {
    select: (table, query = '') => call(`/rest/v1/${table}?${query}`),
    insert: (table, row) => call(`/rest/v1/${table}`, { method: 'POST', headers: { ...JSONH, Prefer: 'return=representation' }, body: JSON.stringify(row) }).then(r => r[0]),
    update: (table, query, patch) => call(`/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { ...JSONH, Prefer: 'return=representation' }, body: JSON.stringify(patch) }),
    remove: (table, query) => call(`/rest/v1/${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } }),
  };

  const storage = {
    publicUrl: (bucket, path) => `${base}/storage/v1/object/public/${bucket}/${encodePath(path)}`,
    // Short-lived link to a private file.
    async signedUrl(bucket, path, seconds = 3600) {
      const r = await call(`/storage/v1/object/sign/${bucket}/${encodePath(path)}`, { method: 'POST', headers: JSONH, body: JSON.stringify({ expiresIn: seconds }) });
      return `${base}/storage/v1${r.signedURL || r.signedUrl}`;
    },
    // Lets the admin page upload one file straight to storage.
    async signedUploadUrl(bucket, path) {
      const r = await call(`/storage/v1/object/upload/sign/${bucket}/${encodePath(path)}`, { method: 'POST', headers: JSONH, body: '{}' });
      return `${base}/storage/v1${r.url}`;
    },
    remove: (bucket, paths) => call(`/storage/v1/object/${bucket}`, { method: 'DELETE', headers: JSONH, body: JSON.stringify({ prefixes: paths }) }),
  };

  // Checks the login token from the admin page; only ADMIN_EMAIL gets through.
  async function adminUser(request) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw err(401, 'Please log in');
    const r = await fetch(base + '/auth/v1/user', { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw err(401, 'Your login has expired. Log in again.');
    const user = await r.json();
    if ((user.email || '').toLowerCase() !== need(env, 'ADMIN_EMAIL').toLowerCase()) throw err(403, 'This account is not the admin');
    return user;
  }

  return { db, storage, adminUser, base };
}
