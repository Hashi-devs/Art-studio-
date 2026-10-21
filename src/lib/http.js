// Small helpers shared by the server code. Standard web Request/Response only, no packages.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const err = (status, message) => new HttpError(status, message);

export const json = (status, data, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

export const fail = (status, message) => json(status, { ok: false, error: message });

export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw err(400, 'That request could not be read'); }
}

// A required setting from Cloudflare → Settings → Variables and Secrets.
export function need(env, name) {
  const v = env[name];
  if (!v) throw err(503, `Missing setting ${name}`);
  return String(v).trim();
}

export const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
