// POST /api/admin/upload-url {ext} — gives the admin page two one-time upload links:
// one for the public preview and one for the private original.
const crypto = require('crypto');
const { send, only, handle, readJson } = require('../../lib/http');
const { storage, adminUser } = require('../../lib/supabase');

const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };

module.exports = handle(async (req, res) => {
  if (!only(req, res, 'POST')) return;
  await adminUser(req);
  const body = await readJson(req);
  const ext = EXT[String(body.ext || 'png').toLowerCase()] || 'png';
  const prevExt = EXT[String(body.previewExt || 'webp').toLowerCase()] || 'webp';
  const stem = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(8).toString('hex')}`;
  const preview_path = `${stem}.${prevExt}`, original_path = `${stem}.${ext}`;
  const [previewUrl, originalUrl] = await Promise.all([
    storage.signedUploadUrl('previews', preview_path),
    storage.signedUploadUrl('originals', original_path),
  ]);
  send(res, 200, { ok: true, preview: { path: preview_path, url: previewUrl }, original: { path: original_path, url: originalUrl } });
});
