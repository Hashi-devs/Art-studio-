// Small helpers shared by the API functions. No dependencies.

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function fail(res, status, message) {
  send(res, status, { ok: false, error: message });
}

// Reads the raw request body as a string (needed for webhook signatures).
function readRaw(req) {
  if (typeof req.rawBody === 'string') return Promise.resolve(req.rawBody);
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding && req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Parsed JSON body, whether or not the platform already parsed it.
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

function only(req, res, ...methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  fail(res, 405, 'Method not allowed');
  return false;
}

function env(name) {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`Missing setting ${name}`), { status: 503 });
  return v;
}

// Wraps a handler so thrown errors become clean JSON responses.
function handle(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      fail(res, status, status === 500 ? 'Something went wrong' : e.message);
    }
  };
}

const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

module.exports = { send, fail, readRaw, readJson, only, env, handle, isEmail };
