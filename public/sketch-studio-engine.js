/* Sketch Studio engine: no UI, no dependencies, runs in any modern browser.

   import {digitise, mockup} from './sketch-studio-engine.js';

   // In your admin upload form:
   const {kind, canvas} = await digitise(fileInput.files[0]);
   //   kind 'drawing': canvas is transparent line art, cropped to the paper
   //   kind 'photo':   canvas is the photo, gently colour-corrected
   const shown = mockup(canvas, {layout:'frame', paper:paperImg, blend: kind === 'photo' ? 'normal' : 'multiply'});
   shown.toBlob(b => fetch('/api/artworks', {method:'POST', body:b}), 'image/jpeg', .92);

   paper = a loaded <img>/canvas of your paper texture, or a CSS colour string.
   Pass {force:'drawing'} or {force:'photo'} to digitise() to skip the automatic check. */

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const shade = (h, a) => 'rgb(' + hex(h).map(v => Math.max(0, Math.min(255, v + a))).join(',') + ')';

/* Blank-paper colour, per channel, at every pixel (so shadows and uneven light divide out).
   Each block's brightest pixel is its paper; blocks that are clearly not paper (a big coloured fill, a shadow)
   are filled in from the paper around them instead. */
function paperMaps(d, w, h, B) {
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B), n = gw * gh, M = [0, 1, 2].map(() => new Float32Array(n)), L = new Float32Array(n);
  for (let y = 0; y < h; y++) { const r = ((y / B) | 0) * gw; for (let x = 0; x < w; x++) { const k = r + ((x / B) | 0), i = (y * w + x) * 4, l = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
    if (l > L[k]) { L[k] = l; M[0][k] = d[i]; M[1][k] = d[i + 1]; M[2][k] = d[i + 2]; } } }
  const ls = [...L].sort((a, b) => a - b), top = ls[Math.floor(n * .85)] || 255;
  // the paper's own tint, from the brightest blocks; paper elsewhere is the same tint, just darker or lighter
  let pr = 0, pg = 0, pb = 0, pc = 0;
  for (let k = 0; k < n; k++) if (L[k] >= top * .95) { pr += M[0][k] / L[k]; pg += M[1][k] / L[k]; pb += M[2][k] / L[k]; pc++; }
  pr /= pc || 1; pg /= pc || 1; pb /= pc || 1;
  const ok = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const l = Math.max(L[k], 1), dt = Math.abs(M[0][k] / l - pr) + Math.abs(M[1][k] / l - pg) + Math.abs(M[2][k] / l - pb); ok[k] = L[k] >= top * .62 && dt < .14 ? 1 : 0; }
  const okN = ok.reduce((a, b) => a + b, 0);
  if (okN > n * .05) {
    // grow the paper estimate into non-paper blocks, ring by ring
    let known = ok.slice();
    for (let pass = 0; pass < gw + gh; pass++) { let changed = 0; const nk = known.slice();
      for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) { const k = by * gw + bx; if (known[k]) continue;
        let s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (let j = Math.max(0, by - 1); j <= Math.min(gh - 1, by + 1); j++) for (let i = Math.max(0, bx - 1); i <= Math.min(gw - 1, bx + 1); i++) { const q = j * gw + i; if (known[q]) { s0 += M[0][q]; s1 += M[1][q]; s2 += M[2][q]; c++; } }
        if (c) { M[0][k] = s0 / c; M[1][k] = s1 / c; M[2][k] = s2 / c; nk[k] = 1; changed++; } }
      known = nk; if (!changed) break; }
  }
  return M.map(g0 => {
    let g = g0;
    for (let p = 0; p < 2; p++) { const nn = new Float32Array(g.length);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, c = 0;
        for (let j = Math.max(0, y - 2); j <= Math.min(gh - 1, y + 2); j++) for (let i = Math.max(0, x - 2); i <= Math.min(gw - 1, x + 2); i++) { s += g[j * gw + i]; c++; }
        nn[y * gw + x] = s / c; }
      g = nn; }
    const axis = (m, gm) => { const i = new Int32Array(m), f = new Float32Array(m); for (let x = 0; x < m; x++) { const t = Math.min(gm - 1, Math.max(0, (x + .5) / B - .5)), a = Math.min(gm - 1, t | 0); i[x] = a; f[x] = t - a; } return [i, f]; };
    const [xi, xf] = axis(w, gw), [yi, yf] = axis(h, gh), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) { const r0 = yi[y] * gw, r1 = Math.min(gh - 1, yi[y] + 1) * gw, fy = yf[y];
      for (let x = 0; x < w; x++) { const a = xi[x], b = Math.min(gw - 1, a + 1), fx = xf[x]; o[y * w + x] = (g[r0 + a] * (1 - fx) + g[r0 + b] * fx) * (1 - fy) + (g[r1 + a] * (1 - fx) + g[r1 + b] * fx) * fy; } }
    return o; });
}
const paperMap = (d, w, h, ch, B) => paperMaps(d, w, h, B)[ch];

/* Find the sheet of paper on a block grid: bright, low-colour blocks, largest connected patch, holes filled.
   Returns {mask (per block), gw, gh, area (0-1)}. When nothing darker surrounds the paper, the whole frame counts. */
function findPaper(d, w, h, B) {
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B), n = gw * gh, L = new Float32Array(n), Sa = new Float32Array(n);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    let mx = 0, r = 0, g = 0, b = 0;
    for (let y = by * B; y < Math.min(h, by * B + B); y += 2) for (let x = bx * B; x < Math.min(w, bx * B + B); x += 2) {
      const i = (y * w + x) * 4, l = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
      if (l > mx) { mx = l; r = d[i]; g = d[i + 1]; b = d[i + 2]; }
    }
    L[by * gw + bx] = mx; Sa[by * gw + bx] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const hist = new Float64Array(256); for (const v of L) hist[Math.min(255, v | 0)]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let w0 = 0, s0 = 0, best = -1, t = 128;
  for (let i = 0; i < 256; i++) { w0 += hist[i]; if (!w0 || w0 === n) continue; s0 += i * hist[i]; const m0 = s0 / w0, m1 = (sum - s0) / (n - w0), v = w0 * (n - w0) * (m0 - m1) ** 2; if (v > best) { best = v; t = i; } }
  let c0 = 0, c1 = 0, k0 = 0, k1 = 0; for (const v of L) { if (v <= t) { c0 += v; k0++; } else { c1 += v; k1++; } }
  const m0 = k0 ? c0 / k0 : 0, m1 = k1 ? c1 / k1 : 255;
  const full = { mask: new Uint8Array(n).fill(1), gw, gh, area: 1 };
  if (!(m1 - m0 > 60 && m0 < 135 && k0 > n * .04)) return full;
  const cut = m0 + .4 * (m1 - m0), p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = L[i] >= cut && Sa[i] < 80 ? 1 : 0;
  const lab = new Int32Array(n), q = new Int32Array(n); let bestL = 0, bestN = 0, id = 0;
  for (let s = 0; s < n; s++) if (p[s] && !lab[s]) {
    id++; let hd = 0, tl = 0, cnt = 0; q[tl++] = s; lab[s] = id;
    while (hd < tl) { const i = q[hd++], x = i % gw, y = (i / gw) | 0; cnt++;
      for (const j of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1]) if (j >= 0 && p[j] && !lab[j]) { lab[j] = id; q[tl++] = j; } }
    if (cnt > bestN) { bestN = cnt; bestL = id; }
  }
  if (bestN < n * .15) return full;
  let m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = lab[i] === bestL ? 1 : 0;
  const out = new Uint8Array(n); let hd = 0, tl = 0;
  for (let i = 0; i < n; i++) { const x = i % gw, y = (i / gw) | 0; if (!m[i] && (x === 0 || y === 0 || x === gw - 1 || y === gh - 1)) { out[i] = 1; q[tl++] = i; } }
  while (hd < tl) { const i = q[hd++], x = i % gw, y = (i / gw) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1]) if (j >= 0 && !m[j] && !out[j]) { out[j] = 1; q[tl++] = j; } }
  for (let i = 0; i < n; i++) m[i] = out[i] ? 0 : 1;
  for (let e = 0; e < 2; e++) { const nm = m.slice(); for (let i = 0; i < n; i++) if (m[i]) { const x = i % gw, y = (i / gw) | 0;
    if ((x > 0 && !m[i - 1]) || (x < gw - 1 && !m[i + 1]) || (y > 0 && !m[i - gw]) || (y < gh - 1 && !m[i + gw])) nm[i] = 0; } m = nm; }
  let a = 0; for (const v of m) a += v;
  return { mask: m, gw, gh, area: a / n };
}

async function readImage(source, maxSize) {
  const bmp = await createImageBitmap(source), s = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * s), H = Math.round(bmp.height * s), c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(bmp, 0, 0, W, H); bmp.close && bmp.close();
  return c;
}

/* Gentle colour correction for photos: stretch each channel between its 0.5% and 99.5% points. */
function polishPhoto(c) {
  const x = c.getContext('2d'), im = x.getImageData(0, 0, c.width, c.height), d = im.data, n = d.length / 4;
  const lo = [], hi = [];
  for (let ch = 0; ch < 3; ch++) {
    const h = new Uint32Array(256); for (let i = ch; i < d.length; i += 4) h[d[i]]++;
    let a = 0, l = 0, u = 255; for (let v = 0; v < 256; v++) { a += h[v]; if (a >= n * .005) { l = v; break; } }
    a = 0; for (let v = 255; v >= 0; v--) { a += h[v]; if (a >= n * .005) { u = v; break; } }
    lo[ch] = l; hi[ch] = Math.max(l + 40, u);
  }
  for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 3; ch++) d[i + ch] = (d[i + ch] - lo[ch]) * 255 / (hi[ch] - lo[ch]);
  x.putImageData(im, 0, 0);
  return c;
}

/* A second, finer paper map: small blocks, ignoring pixels already known to be ink, so page curl and
   binding shadows divide out too. Blocks that are all ink borrow the coarse map. */
function paperMapFine(d, w, h, ch, B, ink, coarse) {
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  let g = new Float32Array(gw * gh); const cnt = new Uint16Array(gw * gh);
  for (let y = 0; y < h; y++) { const r = ((y / B) | 0) * gw; for (let x = 0; x < w; x++) { const i = y * w + x; if (ink[i]) continue; const k = r + ((x / B) | 0), v = d[i * 4 + ch]; cnt[k]++; if (v > g[k]) g[k] = v; } }
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) { const k = by * gw + bx;
    if (cnt[k] < B) g[k] = coarse[Math.min(h - 1, by * B + (B >> 1)) * w + Math.min(w - 1, bx * B + (B >> 1))]; }
  const n = new Float32Array(g.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, c = 0;
    for (let j = Math.max(0, y - 1); j <= Math.min(gh - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(gw - 1, x + 1); i++) { s += g[j * gw + i]; c++; }
    n[y * gw + x] = s / c; }
  g = n;
  const axis = (m, gm) => { const i = new Int32Array(m), f = new Float32Array(m); for (let x = 0; x < m; x++) { const t = Math.min(gm - 1, Math.max(0, (x + .5) / B - .5)), a = Math.min(gm - 1, t | 0); i[x] = a; f[x] = t - a; } return [i, f]; };
  const [xi, xf] = axis(w, gw), [yi, yf] = axis(h, gh), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const r0 = yi[y] * gw, r1 = Math.min(gh - 1, yi[y] + 1) * gw, fy = yf[y];
    for (let x = 0; x < w; x++) { const a = xi[x], b = Math.min(gw - 1, a + 1), fx = xf[x];
      o[y * w + x] = Math.max(coarse[y * w + x] * .55, (g[r0 + a] * (1 - fx) + g[r0 + b] * fx) * (1 - fy) + (g[r1 + a] * (1 - fx) + g[r1 + b] * fx) * fy); } }
  return o;
}

function dilate(m, W, H, r) {
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (m[y * W + x]) run = x; if (x - run <= r) t[y * W + x] = 1; }
    run = 1e9; for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) run = x; if (run - x <= r) t[y * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let run = -1e9; for (let y = 0; y < H; y++) { if (t[y * W + x]) run = y; if (y - run <= r) o[y * W + x] = 1; }
    run = 1e9; for (let y = H - 1; y >= 0; y--) { if (t[y * W + x]) run = y; if (run - y <= r) o[y * W + x] = 1; } }
  return o;
}

/* source: File, Blob, <img>, or canvas. Works out whether it's a drawing on paper or a photo.
   Drawing -> {kind:'drawing', colour, canvas: transparent art cropped to the drawing}
   Photo   -> {kind:'photo',   canvas: the colour-corrected photo}
   cleanup 0-40 removes paper noise; darkness 0-100 makes strokes solid; boost 0-100 lifts faint lines;
   mode 'auto' = colour when the drawing is coloured, 'ink' = one colour, 'color' = keep original colours;
   force 'drawing' | 'photo' skips the check; rules false keeps notebook lines (and margin lines). */
export async function digitise(source, { maxSize = 2800, cleanup = 8, darkness = 50, boost = 30, mode = 'auto', ink = '#16181d', force, rules = true } = {}) {
  const c = await readImage(source, maxSize), W = c.width, H = c.height, N = W * H, x = c.getContext('2d', { willReadFrequently: true });
  const d = x.getImageData(0, 0, W, H).data, B = Math.max(8, Math.round(Math.max(W, H) / 90));
  const P = findPaper(d, W, H, B);
  let bg = paperMaps(d, W, H, B);
  const inMask = i => P.mask[((((i / W) | 0) / B) | 0) * P.gw + (((i % W) / B) | 0)];
  let kind = force;
  if (!kind) {
    let tot = 0, dark = 0, white = 0;
    for (let i = 0; i < N; i += 3) if (inMask(i)) {
      tot++; const j = i * 4, l = .299 * d[j] + .587 * d[j + 1] + .114 * d[j + 2], b = .299 * bg[0][i] + .587 * bg[1][i] + .114 * bg[2][i];
      const r = l / Math.max(b, 1); if (r < .72) dark++;
      if (r > .9 && Math.max(d[j], d[j + 1], d[j + 2]) - Math.min(d[j], d[j + 1], d[j + 2]) < 40) white++;
    }
    const dk = tot ? dark / tot : 1, wh = tot ? white / tot : 0;
    kind = P.area >= .18 && tot && (dk < .28 || (dk < .7 && wh > .3)) ? 'drawing' : 'photo';
  }
  if (kind === 'photo') return { kind, canvas: polishPhoto(c) };

  // 1. a first look at where the ink is, then a finer paper map that ignores it
  const lum0 = i => { const j = i * 4; return 1 - (.299 * d[j] / Math.max(bg[0][i], 1) + .587 * d[j + 1] / Math.max(bg[1][i], 1) + .114 * d[j + 2] / Math.max(bg[2][i], 1)); };
  const inkM = new Uint8Array(N); for (let i = 0; i < N; i++) inkM[i] = lum0(i) > .12 ? 1 : 0;
  const Bf = Math.max(6, Math.round(B * .5)), inkD = dilate(inkM, W, H, Math.max(2, Math.round(Bf * .4)));
  bg = bg.map((cm, ch) => paperMapFine(d, W, H, ch, Bf, inkD, cm));

  // 2. paper-relative colour of every pixel (255 = paper)
  const R = new Uint8ClampedArray(N), G = new Uint8ClampedArray(N), Bl = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) { const j = i * 4; R[i] = d[j] / Math.max(bg[0][i], 1) * 255; G[i] = d[j + 1] / Math.max(bg[1][i], 1) * 255; Bl[i] = d[j + 2] / Math.max(bg[2][i], 1) * 255; }

  const lo = cleanup / 100, hi = Math.max(lo + .05, .9 - .65 * darkness / 100), g = 1 - .5 * boost / 100, lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) { let a = (1 - v / 255 - lo) / (hi - lo); a = a < 0 ? 0 : a > 1 ? 1 : a; lut[v] = Math.round(Math.pow(a, g) * 255); }
  const A = new Uint8Array(N);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) {
    if (!inMask(i)) continue;
    const px = i % W, py = (i / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    A[i] = lut[Math.round(.299 * R[i] + .587 * G[i] + .114 * Bl[i])];
  }
  if (x1 <= x0 || y1 <= y0) return { kind, colour: false, canvas: c };

  // 3. notebook lines and margin lines
  let lines = { tracks: [], ruled: false };
  if (rules) {
    lines = removeRules(A, W, H);
    removeMargin(A, W, H, R, G, Bl);
  }

  // 4. coloured or one-colour ink?
  let col = mode === 'color';
  if (mode === 'auto') {
    let inked = 0, colourful = 0;
    for (let i = 0; i < N; i += 2) if (A[i] > 90) { inked++; const mx = Math.max(R[i], G[i], Bl[i]), mn = Math.min(R[i], G[i], Bl[i]); if (mx - mn > 34 && mx > 115) colourful++; }
    col = inked > 200 && colourful / inked > .12;
  }
  const im = x.createImageData(W, H), o = im.data, rgb = hex(ink);
  for (let i = 0; i < N; i++) {
    if (!A[i] && !col) continue;
    const j = i * 4;
    if (col) {
      const m = Math.min(R[i], G[i], Bl[i]), den = 255 - m, base = den / 255;
      const lc = lo * .5; let a = base <= lc ? 0 : Math.round(255 * Math.min(1, (base - lc) / Math.max(.05, 1 - lc) * (1 + darkness / 200)));
      if (!A[i] && lines.ruled) a = 0; // erased notebook lines stay erased
      if (den > 1) { o[j] = (R[i] - m) / den * 255; o[j + 1] = (G[i] - m) / den * 255; o[j + 2] = (Bl[i] - m) / den * 255; }
      o[j + 3] = inMask(i) ? a : 0; A[i] = o[j + 3];
    } else { o[j] = rgb[0]; o[j + 1] = rgb[1]; o[j + 2] = rgb[2]; o[j + 3] = A[i]; }
  }
  if (col && rules && lines.ruled) { removeRules(A, W, H); removeMargin(A, W, H, R, G, Bl); }
  // 5. the page itself: when ruled lines show where the sheet is, drop what's beside it (spiral, the next page)
  // (only marks wholly beside the sheet go; anything reaching onto it stays)
  if (lines.ruled && lines.span) { const [s0, s1] = lines.span, lab = new Uint8Array(N), q = new Int32Array(N);
    for (let s = 0; s < N; s++) { const sx = s % W; if (A[s] <= 60 || lab[s] || (sx >= s0 && sx <= s1)) continue;
      let hd = 0, tl = 0, inside = false; q[tl++] = s; lab[s] = 1;
      while (hd < tl) { const i = q[hd++], xx = i % W, y = (i / W) | 0; if (xx >= s0 && xx <= s1) inside = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xx + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = Y * W + X; if (A[j] > 60 && !lab[j]) { lab[j] = 1; q[tl++] = j; } } }
      if (!inside) for (let k = 0; k < tl; k++) A[q[k]] = 0; }
    // faint marks beside the sheet go too, unless they edge a stroke that was kept
    const keep = new Uint8Array(N); for (let i = 0; i < N; i++) if (A[i] > 60) keep[i] = 1;
    const near = dilate(keep, W, H, 3);
    for (let i = 0; i < N; i++) { const xx = i % W; if ((xx < s0 || xx > s1) && A[i] <= 60 && !near[i]) A[i] = 0; } }
  despeckle(A, W, H);
  dropEdgeShade(A, W, H);
  /* Crop to the drawing itself (not the whole sheet), with a small margin. */
  let a0 = W, b0 = H, a1 = -1, b1 = -1;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) if (A[y * W + xx] > 50) { if (xx < a0) a0 = xx; if (xx > a1) a1 = xx; if (y < b0) b0 = y; if (y > b1) b1 = y; }
  for (let i = 0; i < N; i++) o[i * 4 + 3] = A[i];
  x.putImageData(im, 0, 0);
  if (a1 < a0) { a0 = x0; a1 = x1; b0 = y0; b1 = y1; }
  else { const mg = Math.round(Math.max(a1 - a0, b1 - b0) * .04); a0 = Math.max(x0, a0 - mg); b0 = Math.max(y0, b0 - mg); a1 = Math.min(x1, a1 + mg); b1 = Math.min(y1, b1 + mg); }
  const out = document.createElement('canvas'); out.width = a1 - a0 + 1; out.height = b1 - b0 + 1;
  out.getContext('2d').drawImage(c, a0, b0, out.width, out.height, 0, 0, out.width, out.height);
  return { kind, colour: col, canvas: out };
}

/* Near-level straight lines through the ink signal S (Hough), strongest first. */
function houghLines(S, W, H, thr, lim) {
  const angs = []; for (let deg = -6; deg <= 6.001; deg += .25) angs.push(Math.tan(deg * Math.PI / 180));
  const off = Math.ceil(Math.tan(6 * Math.PI / 180) * W) + 2, nb = H + 2 * off, acc = angs.map(() => new Float32Array(nb));
  for (let y = 0; y < H; y += 2) for (let xx = 0; xx < W; xx += 2) if (S[y * W + xx] > thr)
    for (let k = 0; k < angs.length; k++) acc[k][Math.round(y - xx * angs[k]) + off]++;
  const cands = [];
  for (let k = 0; k < angs.length; k++) { const a = acc[k]; for (let i = 1; i < nb - 1; i++) if (a[i] >= lim && a[i] >= a[i - 1] && a[i] >= a[i + 1]) cands.push({ t: angs[k], b: i - off, v: a[i] }); }
  cands.sort((p, q) => q.v - p.v);
  const out = [];
  for (const c of cands) { const yc = c.b + W / 2 * c.t; if (out.some(l => Math.abs(l.yc - yc) < 6)) continue; out.push({ t: c.t, b: c.b, yc }); if (out.length > 120) break; }
  return out;
}

/* Follows one ruled line across the page (pages curve and photos tilt): returns y for every x, and its thickness. */
function follow(A, W, H, yOf, R) {
  const SEG = Math.max(30, Math.round(W / 16)), cx = [], cy = [];
  for (let s0 = 0; s0 < W; s0 += SEG) { const s1 = Math.min(W, s0 + SEG); let best = 0, bs = -1;
    for (let dy = -R; dy <= R; dy++) { let sum = 0; for (let xx = s0; xx < s1; xx += 2) { const y = Math.round(yOf(xx) + dy); if (y >= 0 && y < H) sum += Math.min(A[y * W + xx], 160); }
      if (sum > bs) { bs = sum; best = dy; } }
    cx.push((s0 + s1) / 2); cy.push(best); }
  // smooth the offsets (a median of three) so one busy segment can't drag the line onto a stroke
  const sm = cy.map((v, i) => { const a = [cy[Math.max(0, i - 1)], v, cy[Math.min(cy.length - 1, i + 1)]].sort((p, q) => p - q); return a[1]; });
  const coarse = xx => { let j = 0; while (j < cx.length - 2 && xx > cx[j + 1]) j++; if (cx.length < 2) return yOf(xx) + sm[0];
    const k = Math.max(0, Math.min(1, (xx - cx[j]) / (cx[j + 1] - cx[j]))); return yOf(xx) + sm[j] * (1 - k) + sm[j + 1] * k; };
  const sx = [], sy = [], sw = [];
  for (let xx = 0; xx < W; xx += 3) { const e = coarse(xx); let bestY = -1, bestD = 1e9, bestW = 0;
    for (let y = Math.max(1, Math.round(e - 4)); y <= Math.min(H - 2, Math.round(e + 4)); y++) {
      if (A[y * W + xx] <= 40 || A[(y - 1) * W + xx] > 40) continue;
      let y2 = y; while (y2 < H - 1 && A[(y2 + 1) * W + xx] > 40) y2++;
      if (y2 - y + 1 > 14) { y = y2; continue; }
      const c = (y + y2) / 2, dd = Math.abs(c - e); if (dd < bestD) { bestD = dd; bestY = c; bestW = y2 - y + 1; } y = y2; }
    if (bestY >= 0) { sx.push(xx); sy.push(bestY); sw.push(bestW); } }
  let th = 2; if (sw.length) { const ws = [...sw].sort((a, b) => a - b); th = Math.max(1, ws[ws.length >> 1]); }
  let fit = null;
  if (sx.length > 12) { let keep = sx.map(() => true);
    for (let it = 0; it < 3; it++) { let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
      for (let i = 0; i < sx.length; i++) if (keep[i]) { const u = sx[i] / W, y = sy[i]; let p = 1; for (let k = 0; k < 5; k++) { S[k] += p; p *= u; } T[0] += y; T[1] += y * u; T[2] += y * u * u; }
      const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(M); if (Math.abs(D) < 1e-12) break;
      const colm = j => M.map((r, i) => r.map((v, k) => k === j ? T[i] : v)), f = [det(colm(0)) / D, det(colm(1)) / D, det(colm(2)) / D];
      fit = xx => { const u = xx / W; return f[0] + f[1] * u + f[2] * u * u; };
      for (let i = 0; i < sx.length; i++) keep[i] = Math.abs(sy[i] - fit(sx[i])) < 2.5; } }
  const yArr = new Float32Array(W);
  for (let xx = 0; xx < W; xx++) { const e = fit ? fit(xx) : coarse(xx); let bd = 0, bsum = -1;
    for (let dd = -1; dd <= 1; dd++) { let sum = 0; for (let q = -1; q <= 1; q++) { const y = Math.round(e + dd + q); if (y >= 0 && y < H) sum += A[y * W + xx]; } if (sum > bsum) { bsum = sum; bd = dd; } }
    yArr[xx] = e + bd; }
  // how much of the width the line really covers (longest stretch, small gaps allowed)
  let best = [0, -1], run0 = -1, last = -1e9; const gapMax = Math.max(16, W * .03);
  for (let xx = 0; xx < W; xx += 2) { const y = Math.round(yArr[xx]); let on = false;
    for (let q = -1 - (th >> 1); q <= 1 + (th >> 1); q++) { const yy = y + q; if (yy >= 0 && yy < H && A[yy * W + xx] > 40) { on = true; break; } }
    if (on) { if (xx - last > gapMax) run0 = xx; last = xx; if (last - run0 > best[1] - best[0]) best = [run0, last]; } }
  return { yArr, th, ym: yArr[W >> 1], x0: best[0], x1: best[1], cover: (best[1] - best[0]) / W };
}

function support(A, W, H, yArr) { let on = 0, n = 0;
  for (let xx = 0; xx < W; xx += 3) { n++; const y = Math.round(yArr[xx]); for (let q = -2; q <= 2; q++) { const yy = y + q; if (yy >= 0 && yy < H && A[yy * W + xx] > 35) { on++; break; } } }
  return on / n; }

/* Notebook ruling: find the long, nearly level lines, fill in the faint ones from the page's line spacing,
   follow each one across the page, and erase it, keeping any drawn stroke that crosses a line.
   Returns the lines found and, when the page is clearly ruled, the left and right edges of the sheet. */
function removeRules(A, W, H) {
  const seeds = houghLines(A, W, H, 40, W * .085);
  let tr = [];
  for (const s of seeds) { const t = follow(A, W, H, xx => s.b + xx * s.t, 6); if (t.cover > .35 && !tr.some(o => Math.abs(o.ym - t.ym) < 5)) tr.push(t); }
  // a printed line is a thin, clean stroke with paper either side for most of its length; texture isn't
  const clean = t => { const gap = Math.ceil(t.th / 2) + 4; let on = 0, n = 0;
    for (let xx = 0; xx < W; xx += 3) { const y = Math.round(t.yArr[xx]); if (y - gap < 0 || y + gap >= H) continue; n++;
      let c = false; for (let q = -1 - (t.th >> 1); q <= 1 + (t.th >> 1); q++) if (A[(y + q) * W + xx] > 40) { c = true; break; }
      if (c && A[(y - gap) * W + xx] < 40 && A[(y + gap) * W + xx] < 40) on++; }
    return n ? on / n : 0; };
  tr = tr.filter(t => clean(t) > .4);
  if (tr.length < 3) return { tracks: [], ruled: false };
  tr.sort((a, b) => a.ym - b.ym);
  // the line spacing, from the gaps between found lines
  const gaps = []; for (let i = 1; i < tr.length; i++) gaps.push(tr[i].ym - tr[i - 1].ym);
  const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  let sp = med(gaps); sp = med(gaps.map(g => g / Math.max(1, Math.round(g / sp))));
  const regular = gaps.filter(g => Math.abs(g / sp - Math.round(g / sp)) < .3).length / gaps.length;
  // a ruled page has several long lines, evenly spaced; texture in a coloured drawing doesn't
  if (!(tr.length >= 4 && tr.filter(t => t.cover > .5).length >= 3 && sp >= 8 && regular > .6)) return { tracks: [], ruled: false };
  {
    const th0 = med(tr.map(t => t.th)), add = [];
    const mk = (fn, from) => { const yArr = new Float32Array(W); for (let xx = 0; xx < W; xx++) yArr[xx] = fn(xx); return follow(A, W, H, xx => yArr[xx], Math.max(2, Math.round(sp * .15))); };
    for (let i = 1; i < tr.length; i++) { const a = tr[i - 1], b = tr[i], k = Math.round((b.ym - a.ym) / sp);
      if (k >= 2 && k < 12) for (let j = 1; j < k; j++) { const f = j / k, t = mk(xx => a.yArr[xx] * (1 - f) + b.yArr[xx] * f); if (support(A, W, H, t.yArr) > .2) add.push(t); } }
    // beyond the first and last found lines, keep stepping while there is still a faint line there
    for (const [end, nb, dir] of [[tr[0], tr[1], -1], [tr[tr.length - 1], tr[tr.length - 2], 1]]) {
      let prev = end, prev2 = nb, miss = 0;
      for (let n = 0; n < 60 && miss < 2; n++) {
        const t = mk(xx => prev.yArr[xx] + (prev.yArr[xx] - prev2.yArr[xx]) * (sp / Math.max(1, Math.abs(prev.ym - prev2.ym))));
        if (t.ym < 2 || t.ym > H - 3) break;
        if (support(A, W, H, t.yArr) > .2) { add.push(t); miss = 0; } else miss++;
        prev2 = prev; prev = t; }
    }
    for (const t of add) { if (!tr.some(o => Math.abs(o.ym - t.ym) < sp * .35)) { t.th = Math.max(t.th, 1); tr.push(t); } }
    tr.sort((a, b) => a.ym - b.ym);
    tr.forEach(t => { if (t.th > th0 * 2.5) t.th = th0; });
  }
  const A0 = A.slice();
  // erase each line, keeping strokes that cross it
  let lineA = []; tr.forEach(t => { for (let xx = 0; xx < W; xx += 17) { const y = Math.round(t.yArr[xx]); if (y >= 0 && y < H) lineA.push(A[y * W + xx]); } });
  lineA.sort((a, b) => a - b); const la = lineA[lineA.length >> 1] || 120, keepA = la < 150 ? Math.min(250, la * 1.9) : 999;
  for (const t of tr) {
    const pad = Math.max(2, Math.round(t.th * .45) + 1);
    for (let xx = 0; xx < W; xx++) { const yc = t.yArr[xx];
      const ya = Math.max(0, Math.floor(yc - t.th / 2) - pad), yb = Math.min(H - 1, Math.ceil(yc + t.th / 2) + pad); if (ya > yb) continue;
      let up = ya, dn = yb; while (up > 0 && A[(up - 1) * W + xx] > 60) up--; while (dn < H - 1 && A[(dn + 1) * W + xx] > 60) dn++;
      if (dn - up + 1 > yb - ya + 1 + 6) continue; // a stroke crosses the line here: keep it
      for (let y = ya; y <= yb; y++) if (A[y * W + xx] < keepA) A[y * W + xx] = 0; } }
  // sweep thin, flat leftovers that sit on a line
  const n = W * H, lab = new Uint8Array(n), q = new Int32Array(n);
  for (let s = 0; s < n; s++) if (A[s] > 30 && !lab[s]) {
    let hd = 0, tl = 0, X0 = W, X1 = 0, Y0 = H, Y1 = 0; q[tl++] = s; lab[s] = 1;
    while (hd < tl) { const i = q[hd++], xx = i % W, y = (i / W) | 0; if (xx < X0) X0 = xx; if (xx > X1) X1 = xx; if (y < Y0) Y0 = y; if (y > Y1) Y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xx + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = Y * W + X; if (A[j] > 30 && !lab[j]) { lab[j] = 1; q[tl++] = j; } } }
    const h = Y1 - Y0 + 1, w = X1 - X0 + 1, xm = (X0 + X1) >> 1, ym = (Y0 + Y1) / 2;
    if (w < h * 3 || h > 14) continue;
    if (tr.some(t => Math.abs(t.yArr[xm] - ym) <= t.th / 2 + 5)) for (let k = 0; k < tl; k++) A[q[k]] = 0;
  }
  // the sheet's edges: where most lines start and end
  let span = null;
  if (tr.length >= 6) {
    // for every column, how many lines pass through it: the sheet is where most of them do
    // a column counts for a line when the line is there as a thin, clean stroke (a spiral or a page edge isn't)
    const prof = new Float32Array(W);
    for (const t of tr) { const gap = Math.ceil(t.th / 2) + 4;
      for (let xx = 0; xx < W; xx++) { const y = Math.round(t.yArr[xx]); if (y - gap < 0 || y + gap >= H) continue;
        let on = false; for (let q = -1 - (t.th >> 1); q <= 1 + (t.th >> 1); q++) if (A0[(y + q) * W + xx] > 40) { on = true; break; }
        if (on && A0[(y - gap) * W + xx] < 40 && A0[(y + gap) * W + xx] < 40) prof[xx]++; } }
    // smooth over small gaps (strokes crossing the lines)
    const sm = new Float32Array(W), rr = Math.max(4, Math.round(W * .01));
    for (let xx = 0; xx < W; xx++) { let s = 0, c = 0; for (let k = Math.max(0, xx - rr); k <= Math.min(W - 1, xx + rr); k++) { s += prof[k]; c++; } sm[xx] = s / c; }
    prof.set(sm);
    let s0 = 0, s1 = W - 1; const need = tr.length * .35;
    while (s0 < W - 1 && prof[s0] < need) s0++; while (s1 > 0 && prof[s1] < need) s1--;
    const m = Math.round(W * .012);
    if (s1 > s0 && s0 < W * .3 && s1 > W * .7) span = [Math.max(0, s0 - m), Math.min(W - 1, s1 + m)]; }
  return { tracks: tr, ruled: true, span };
}

/* The coloured margin line down the side of many exercise books (usually pink or red). */
function removeMargin(A, W, H, R, G, Bl) {
  const T = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) T[xx * H + y] = A[y * W + xx];
  const seeds = houghLines(T, H, W, 40, H * .2).slice(0, 8);
  for (const s of seeds) {
    const t = follow(T, H, W, yy => s.b + yy * s.t, 5);
    if (t.cover < .5) continue;
    // must be coloured (pink / red / purple), not a pencil stroke
    let pk = 0, nn = 0; for (let yy = 0; yy < H; yy += 4) { const xx = Math.round(t.yArr[yy]); if (xx < 0 || xx >= W) continue; const i = yy * W + xx; if (T[xx * H + yy] < 40) continue; nn++; if (R[i] - G[i] > 18 && R[i] > Bl[i] - 30) pk++; }
    if (!nn || pk / nn < .6) continue;
    const pad = Math.max(2, Math.round(t.th * .45) + 1);
    for (let yy = 0; yy < H; yy++) { const xc = t.yArr[yy], xa = Math.max(0, Math.floor(xc - t.th / 2) - pad), xb = Math.min(W - 1, Math.ceil(xc + t.th / 2) + pad);
      let lf = xa, rt = xb; while (lf > 0 && A[yy * W + lf - 1] > 60) lf--; while (rt < W - 1 && A[yy * W + rt + 1] > 60) rt++;
      if (rt - lf + 1 > xb - xa + 1 + 6) continue;
      for (let xx = xa; xx <= xb; xx++) { const i = yy * W + xx; if (R[i] - G[i] > 6 || A[i] < 90) A[i] = 0; } }
  }
}

/* Soft grey patches touching the edge of the photo (page curl, the desk, a shadow) aren't the drawing. */
function dropEdgeShade(A, W, H) {
  const n = W * H, lab = new Uint8Array(n), q = new Int32Array(n);
  const seed = []; for (let xx = 0; xx < W; xx++) seed.push(xx, (H - 1) * W + xx); for (let y = 0; y < H; y++) seed.push(y * W, y * W + W - 1);
  for (const s of seed) if (A[s] > 20 && !lab[s]) {
    let hd = 0, tl = 0, sum = 0, strong = 0; q[tl++] = s; lab[s] = 1;
    while (hd < tl) { const i = q[hd++], xx = i % W, y = (i / W) | 0; sum += A[i]; if (A[i] > 170) strong++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xx + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = Y * W + X; if (A[j] > 20 && !lab[j]) { lab[j] = 1; q[tl++] = j; } } }
    if (sum / tl < 85 && strong / tl < .08) for (let k = 0; k < tl; k++) A[q[k]] = 0;
  }
}

/* Drop dust and tiny specks that aren't part of the drawing. */
function despeckle(A, W, H) {
  const n = W * H, min = Math.max(6, n * 4e-6), lab = new Int32Array(n), q = new Int32Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) if (A[s] > 60 && !lab[s]) {
    id++; let hd = 0, tl = 0; q[tl++] = s; lab[s] = id;
    while (hd < tl) { const i = q[hd++], xx = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = xx + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X; if (A[j] > 60 && !lab[j]) { lab[j] = id; q[tl++] = j; } } }
    if (tl < min) for (let k = 0; k < tl; k++) A[q[k]] = 0;
  }
}

/* Older name, kept so existing code still works: always treats the image as a drawing. */
export async function cleanSketch(source, opts = {}) { return (await digitise(source, { ...opts, force: 'drawing' })).canvas; }

/* art: canvas from digitise(). layout 'frame' | 'flat' | 'clear'.
   paper: loaded image/canvas or CSS colour. blend 'multiply' (drawings) or 'normal' (photos). Returns a new canvas. */
export function mockup(art, { layout = 'frame', paper = '#ffffff', frame = '#1f1c1a', mat = true, blend = 'multiply' } = {}) {
  const W = art.width, H = art.height, c = document.createElement('canvas'), x = c.getContext('2d');
  if (layout === 'clear') { c.width = W; c.height = H; x.drawImage(art, 0, 0); return c; }
  const p = Math.round(W * (blend === 'normal' ? .08 : .05)), pw = W + 2 * p, ph = H + 2 * p, fr = layout === 'frame';
  const m = fr && mat ? Math.round(pw * .09) : 0, f = fr ? Math.round(pw * .04) : 0, wl = fr ? Math.round(pw * .14) : 0;
  c.width = pw + 2 * (m + f + wl); c.height = ph + 2 * (m + f + wl);
  const X = wl, Y = wl, FW = pw + 2 * (m + f), FH = ph + 2 * (m + f);
  if (fr) {
    const g = x.createRadialGradient(c.width / 2, c.height * .4, 0, c.width / 2, c.height / 2, Math.max(c.width, c.height) * .75);
    g.addColorStop(0, '#e8e9ea'); g.addColorStop(1, '#c4c6c9'); x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    x.save(); x.shadowColor = 'rgba(0,0,0,.38)'; x.shadowBlur = f * 1.8; x.shadowOffsetY = f * .6; x.fillStyle = '#000'; x.fillRect(X, Y, FW, FH); x.restore();
    const P = (a, col) => { x.fillStyle = col; x.beginPath(); a.forEach((q, i) => i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])); x.fill(); };
    P([[X, Y], [X + FW, Y], [X + FW - f, Y + f], [X + f, Y + f]], shade(frame, 22));
    P([[X, Y], [X + f, Y + f], [X + f, Y + FH - f], [X, Y + FH]], shade(frame, 6));
    P([[X + FW, Y], [X + FW, Y + FH], [X + FW - f, Y + FH - f], [X + FW - f, Y + f]], shade(frame, -12));
    P([[X, Y + FH], [X + f, Y + FH - f], [X + FW - f, Y + FH - f], [X + FW, Y + FH]], shade(frame, -26));
    if (m) { x.fillStyle = '#f8f7f4'; x.fillRect(X + f, Y + f, FW - 2 * f, FH - 2 * f); }
  }
  const px = X + f + m, py = Y + f + m;
  if (typeof paper === 'string') { x.fillStyle = paper; x.fillRect(px, py, pw, ph); }
  else {
    const a = paper.naturalWidth || paper.width, b = paper.naturalHeight || paper.height, r = (pw > ph) !== (a > b), k = Math.max(pw / (r ? b : a), ph / (r ? a : b));
    x.save(); x.beginPath(); x.rect(px, py, pw, ph); x.clip(); x.translate(px + pw / 2, py + ph / 2); if (r) x.rotate(Math.PI / 2);
    x.drawImage(paper, -a * k / 2, -b * k / 2, a * k, b * k); x.restore();
  }
  if (fr) { x.strokeStyle = 'rgba(0,0,0,.28)'; x.lineWidth = Math.max(2, W * .0025); x.strokeRect(px, py, pw, ph); }
  if (blend === 'normal') {
    x.save(); x.shadowColor = 'rgba(0,0,0,.3)'; x.shadowBlur = W * .015; x.shadowOffsetY = W * .006; x.drawImage(art, px + p, py + p); x.restore();
    return c;
  }
  const dark = typeof paper === 'string' && /^#[0-9a-f]{6}$/i.test(paper) && (.299 * hex(paper)[0] + .587 * hex(paper)[1] + .114 * hex(paper)[2]) < 110;
  x.globalCompositeOperation = dark ? 'source-over' : 'multiply'; x.drawImage(art, px + p, py + p); x.globalCompositeOperation = 'source-over';
  return c;
}

export const toBlob = (canvas, type = 'image/png', q = .92) => new Promise(r => canvas.toBlob(r, type, q));
