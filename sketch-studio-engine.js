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

/* Blank-paper brightness per channel (max-pool, blur, upsample), so shadows and uneven light divide out. */
function paperMap(d, w, h, ch, B) {
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  let g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) { const r = ((y / B) | 0) * gw; for (let x = 0; x < w; x++) { const k = r + ((x / B) | 0), v = d[(y * w + x) * 4 + ch]; if (v > g[k]) g[k] = v; } }
  for (let p = 0; p < 2; p++) {
    const n = new Float32Array(g.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, y - 2); j <= Math.min(gh - 1, y + 2); j++) for (let i = Math.max(0, x - 2); i <= Math.min(gw - 1, x + 2); i++) { s += g[j * gw + i]; c++; }
      n[y * gw + x] = s / c;
    }
    g = n;
  }
  const axis = (n, gn) => { const i = new Int32Array(n), f = new Float32Array(n); for (let x = 0; x < n; x++) { const t = Math.min(gn - 1, Math.max(0, (x + .5) / B - .5)), a = Math.min(gn - 1, t | 0); i[x] = a; f[x] = t - a; } return [i, f]; };
  const [xi, xf] = axis(w, gw), [yi, yf] = axis(h, gh), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = yi[y] * gw, r1 = Math.min(gh - 1, yi[y] + 1) * gw, fy = yf[y];
    for (let x = 0; x < w; x++) { const a = xi[x], b = Math.min(gw - 1, a + 1), fx = xf[x]; o[y * w + x] = (g[r0 + a] * (1 - fx) + g[r0 + b] * fx) * (1 - fy) + (g[r1 + a] * (1 - fx) + g[r1 + b] * fx) * fy; }
  }
  return o;
}

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

/* source: File, Blob, <img>, or canvas. Works out whether it's a drawing on paper or a photo.
   Drawing -> {kind:'drawing', canvas: transparent line art cropped to the paper}
   Photo   -> {kind:'photo',   canvas: the colour-corrected photo}
   cleanup 0-40 removes paper noise; darkness 0-100 makes strokes solid; boost 0-100 lifts faint lines;
   mode 'ink' = one colour, 'color' = keep original colours; force 'drawing' | 'photo' skips the check;
   rules false keeps notebook ruled lines. Drawings are cropped to the drawn area, with dust removed. */
export async function digitise(source, { maxSize = 2800, cleanup = 8, darkness = 50, boost = 30, mode = 'ink', ink = '#16181d', force, rules = true } = {}) {
  const c = await readImage(source, maxSize), W = c.width, H = c.height, x = c.getContext('2d', { willReadFrequently: true });
  const d = x.getImageData(0, 0, W, H).data, B = Math.max(8, Math.round(Math.max(W, H) / 90));
  const P = findPaper(d, W, H, B);
  const bg = [0, 1, 2].map(ch => paperMap(d, W, H, ch, B));
  const inMask = i => P.mask[((((i / W) | 0) / B) | 0) * P.gw + (((i % W) / B) | 0)];
  let kind = force;
  if (!kind) {
    let tot = 0, dark = 0;
    for (let i = 0, n = W * H; i < n; i += 3) if (inMask(i)) {
      tot++; const j = i * 4, l = .299 * d[j] + .587 * d[j + 1] + .114 * d[j + 2], b = .299 * bg[0][i] + .587 * bg[1][i] + .114 * bg[2][i];
      if (l / Math.max(b, 1) < .72) dark++;
    }
    kind = P.area >= .18 && tot && dark / tot < .28 ? 'drawing' : 'photo';
  }
  if (kind === 'photo') return { kind, canvas: polishPhoto(c) };

  const im = x.createImageData(W, H), o = im.data, col = mode === 'color', rgb = hex(ink);
  const lo = cleanup / 100, hi = Math.max(lo + .05, .9 - .65 * darkness / 100), g = 1 - .5 * boost / 100, lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) { let a = (1 - v / 255 - lo) / (hi - lo); a = a < 0 ? 0 : a > 1 ? 1 : a; lut[v] = Math.round(Math.pow(a, g) * 255); }
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0, n = W * H; i < n; i++) {
    if (!inMask(i)) continue;
    const px = i % W, py = (i / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    const j = i * 4, r = Math.min(255, d[j] / Math.max(bg[0][i], 1) * 255), gg = Math.min(255, d[j + 1] / Math.max(bg[1][i], 1) * 255), b = Math.min(255, d[j + 2] / Math.max(bg[2][i], 1) * 255);
    const m = Math.round(col ? Math.min(r, gg, b) : .299 * r + .587 * gg + .114 * b), den = 255 - m;
    if (col) { if (den > 1) { o[j] = (r - m) / den * 255; o[j + 1] = (gg - m) / den * 255; o[j + 2] = (b - m) / den * 255; } }
    else { o[j] = rgb[0]; o[j + 1] = rgb[1]; o[j + 2] = rgb[2]; }
    o[j + 3] = lut[m];
  }
  if (x1 <= x0 || y1 <= y0) { x.putImageData(im, 0, 0); return { kind, canvas: c }; }
  const A = new Uint8Array(W * H); for (let i = 0, n = W * H; i < n; i++) A[i] = o[i * 4 + 3];
  if (rules) removeRules(A, W, H);
  despeckle(A, W, H);
  /* Crop to the drawing itself (not the whole sheet), with a small margin. */
  let a0 = W, b0 = H, a1 = -1, b1 = -1;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) if (A[y * W + xx] > 50) { if (xx < a0) a0 = xx; if (xx > a1) a1 = xx; if (y < b0) b0 = y; if (y > b1) b1 = y; }
  for (let i = 0, n = W * H; i < n; i++) o[i * 4 + 3] = A[i];
  x.putImageData(im, 0, 0);
  if (a1 < a0) { a0 = x0; a1 = x1; b0 = y0; b1 = y1; }
  else { const mg = Math.round(Math.max(a1 - a0, b1 - b0) * .04); a0 = Math.max(x0, a0 - mg); b0 = Math.max(y0, b0 - mg); a1 = Math.min(x1, a1 + mg); b1 = Math.min(y1, b1 + mg); }
  const out = document.createElement('canvas'); out.width = a1 - a0 + 1; out.height = b1 - b0 + 1;
  out.getContext('2d').drawImage(c, a0, b0, out.width, out.height, 0, 0, out.width, out.height);
  return { kind, canvas: out };
}

/* Notebook ruling: find 3+ long, nearly level lines crossing most of the page and erase them, keeping any
   drawn stroke that crosses a rule. Lines are found across the full width; pages curve, so each line is then
   re-aligned in short sections before it is erased. */
function removeRules(A, W, H) {
  const angs = [], lim = W * .45 / 4, cands = [];
  for (let deg = -6; deg <= 6.001; deg += .25) angs.push(Math.tan(deg * Math.PI / 180));
  const off = Math.ceil(Math.tan(6 * Math.PI / 180) * W) + 2, nb = H + 2 * off, acc = angs.map(() => new Float32Array(nb));
  for (let y = 0; y < H; y += 2) for (let xx = 0; xx < W; xx += 2) if (A[y * W + xx] > 90)
    for (let k = 0; k < angs.length; k++) acc[k][Math.round(y - xx * angs[k]) + off]++;
  for (let k = 0; k < angs.length; k++) { const a = acc[k];
    for (let i = 1; i < nb - 1; i++) if (a[i] >= lim && a[i] >= a[i - 1] && a[i] >= a[i + 1]) cands.push({ k, i, v: a[i] }); }
  cands.sort((p, q) => q.v - p.v);
  const lines = [];
  for (const c of cands) {
    const t = angs[c.k], yc = c.i - off + W / 2 * t;
    if (lines.some(l => Math.abs(l.yc - yc) < 8)) continue;
    const a = acc[c.k]; let g0 = c.i, g1 = c.i;
    while (g0 > 0 && a[g0 - 1] >= c.v * .3) g0--; while (g1 < nb - 1 && a[g1 + 1] >= c.v * .3) g1++;
    lines.push({ t, yc, g0: g0 - off, g1: g1 - off });
  }
  if (lines.length < 3) return;
  const gap = lines.length > 1 ? Math.min(...lines.map(l => Math.min(...lines.filter(m => m !== l).map(m => Math.abs(m.yc - l.yc))))) : 40;
  const R = Math.max(3, Math.min(14, Math.round(gap * .25))), SEG = Math.max(40, Math.round(W / 12));
  const tracks = [];
  for (const { t, g0, g1 } of lines) {
    const mid = (g0 + g1) / 2;
    let th = g1 - g0 + 1, pad = 2;
    // 1. coarse offset per segment
    const cx = [], cy = [];
    for (let s0 = 0; s0 < W; s0 += SEG) {
      const s1 = Math.min(W, s0 + SEG); let best = 0, bs = -1;
      for (let dy = -R; dy <= R; dy++) { let sum = 0;
        for (let xx = s0; xx < s1; xx += 2) { const yc = Math.round(xx * t + mid) + dy; if (yc >= 0 && yc < H) sum += A[yc * W + xx]; }
        if (sum > bs) { bs = sum; best = dy; } }
      cx.push((s0 + s1) / 2); cy.push(best);
    }
    const coarse = xx => { let j = 0; while (j < cx.length - 2 && xx > cx[j + 1]) j++;
      if (cx.length < 2) return xx * t + mid + cy[0];
      const k = Math.max(0, Math.min(1, (xx - cx[j]) / (cx[j + 1] - cx[j]))); return xx * t + mid + cy[j] * (1 - k) + cy[j + 1] * k; };
    // 2. sample the line only where it is a clean, thin run (no stroke crossing), then fit a smooth curve
    const sx = [], sy = [], sw = [];
    for (let xx = 0; xx < W; xx += 3) {
      const e = coarse(xx); let bestY = -1, bestD = 1e9, bestW = 0;
      for (let y = Math.max(1, Math.round(e - R)); y <= Math.min(H - 2, Math.round(e + R)); y++) {
        if (A[y * W + xx] <= 60 || A[(y - 1) * W + xx] > 60) continue; // top of a run
        let y2 = y; while (y2 < H - 1 && A[(y2 + 1) * W + xx] > 60) y2++;
        if (y2 - y + 1 > 12) { y = y2; continue; }
        const c = (y + y2) / 2, dd = Math.abs(c - e); if (dd < bestD) { bestD = dd; bestY = c; bestW = y2 - y + 1; } y = y2;
      }
      if (bestY >= 0) { sx.push(xx); sy.push(bestY); sw.push(bestW); }
    }
    // the line's real thickness here (lines nearer the camera look thicker)
    if (sw.length) { const ws = [...sw].sort((a, b) => a - b); th = Math.max(th, ws[ws.length >> 1]); }
    pad = Math.max(2, Math.round(th * .4) + 1);
    const px = [], py = [];
    for (let i = 0; i < sx.length; i++) if (sw[i] <= th + 2) { px.push(sx[i]); py.push(sy[i]); }
    let fit = null;
    if (px.length > 12) {
      let keep = px.map(() => true);
      for (let it = 0; it < 3; it++) {
        // least squares y = a + b u + c u^2, u = x / W
        let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
        for (let i = 0; i < px.length; i++) if (keep[i]) { const u = px[i] / W, y = py[i]; let p = 1;
          for (let k = 0; k < 5; k++) { S[k] += p; p *= u; } T[0] += y; T[1] += y * u; T[2] += y * u * u; }
        const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        const D = det(M); if (Math.abs(D) < 1e-12) break;
        const col = (j) => M.map((r, i) => r.map((v, k) => k === j ? T[i] : v));
        const f = [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
        fit = xx => { const u = xx / W; return f[0] + f[1] * u + f[2] * u * u; };
        for (let i = 0; i < px.length; i++) keep[i] = Math.abs(py[i] - fit(px[i])) < 2.5;
      }
    }
    const yArr = new Float32Array(W);
    for (let xx = 0; xx < W; xx++) {
      const e = fit ? fit(xx) : coarse(xx);
      // tiny local re-centre (±1px) onto the ink
      let bd = 0, bsum = -1;
      for (let d = -1; d <= 1; d++) { let sum = 0; for (let q = -1; q <= 1; q++) { const y = Math.round(e + d + q); if (y >= 0 && y < H) sum += A[y * W + xx]; } if (sum > bsum) { bsum = sum; bd = d; } }
      const yc = e + bd; yArr[xx] = yc;
      const ya = Math.max(0, Math.floor(yc - th / 2) - pad), yb = Math.min(H - 1, Math.ceil(yc + th / 2) + pad);
      if (ya > yb) continue;
      let up = ya, dn = yb;
      while (up > 0 && A[(up - 1) * W + xx] > 60) up--;
      while (dn < H - 1 && A[(dn + 1) * W + xx] > 60) dn++;
      if (dn - up + 1 > yb - ya + 1 + 6) continue; // a stroke crosses the line here: keep it
      for (let y = ya; y <= yb; y++) A[y * W + xx] = 0;
    }
    tracks.push({ yArr, band: th / 2 + pad + 3, th });
  }
  // 3. sweep thin, flat leftovers that sit on a line
  const n = W * H, lab = new Int32Array(n), q = new Int32Array(n);
  for (let s = 0; s < n; s++) if (A[s] > 40 && !lab[s]) {
    let hd = 0, tl = 0, x0 = W, x1 = 0, y0 = H, y1 = 0; q[tl++] = s; lab[s] = 1;
    while (hd < tl) { const i = q[hd++], xx = i % W, y = (i / W) | 0;
      if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xx + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = Y * W + X; if (A[j] > 40 && !lab[j]) { lab[j] = 1; q[tl++] = j; } } }
    const h = y1 - y0 + 1, w = x1 - x0 + 1, xm = (x0 + x1) >> 1, ym = (y0 + y1) / 2;
    if (w < h * 3 || h > 14) continue;
    if (tracks.some(tr => Math.abs(tr.yArr[xm] - ym) <= tr.band && y0 >= tr.yArr[x0] - tr.band - 1 && y1 <= tr.yArr[x1] + tr.band + 1))
      for (let k = 0; k < tl; k++) A[q[k]] = 0;
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
