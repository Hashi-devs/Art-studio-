// GET /api/config — public values the admin page needs to log in. The anon key is
// designed to be public; the service role key never leaves the server.
const { send, only, handle, env } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'GET')) return;
  send(res, 200, { ok: true, supabaseUrl: env('SUPABASE_URL').replace(/\/+$/, ''), anonKey: env('SUPABASE_ANON_KEY') });
});
