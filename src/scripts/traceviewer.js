// Client-side ABIF parser + Benchling-style stacked chromatogram viewer.
// Forward and reverse traces are reverse-complemented and aligned
// (Needleman-Wunsch) so both render in a shared column space, with a
// per-base quality strip on top and an amplitude slider, mirroring the
// tags the backend pipeline reads (DATA9-12, PLOC2, PBAS2, FWO_1, PCON2).

const CHANNEL_COLORS = { A: '#16a34a', C: '#2563eb', G: '#111827', T: '#dc2626' };
const QUAL_COLORS = { good: '#16a34a', mid: '#eab308', bad: '#dc2626' };
const MAX_ALIGN_CELLS = 4_000_000;

export function parseABIF(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'ABIF') throw new Error('Not an ABIF file');

  const dirCount = view.getUint32(18);
  const dirOffset = view.getUint32(26);

  const entries = new Map();
  for (let i = 0; i < dirCount; i++) {
    const p = dirOffset + i * 28;
    if (p + 28 > buffer.byteLength) break;
    const tag = String.fromCharCode(...new Uint8Array(buffer, p, 4)).replace(/\0/g, '');
    const number = view.getUint32(p + 4);
    entries.set(tag + number, {
      elemType: view.getUint16(p + 8),
      elemSize: view.getUint16(p + 10),
      numElems: view.getUint32(p + 12),
      dataSize: view.getUint32(p + 16),
      dataOffset: view.getUint32(p + 20),
    });
  }

  function readValues(tag, number = 1) {
    const e = entries.get(tag + number);
    if (!e) return null;
    const { elemType, elemSize, numElems, dataSize, dataOffset } = e;
    const inline = dataSize <= 4;
    const base = inline ? 24 : dataOffset;
    const out = [];
    let asText = (elemType === 4 || elemType === 6) && elemSize === 1;
    if (!asText && elemSize === 1) {
      const probe = [];
      for (let i = 0; i < Math.min(numElems, 32); i++) probe.push(view.getUint8(base + i));
      asText = probe.every(v => v >= 32 && v <= 126);
    }
    for (let i = 0; i < numElems; i++) {
      const p = base + i * elemSize;
      if (!inline && p + elemSize > buffer.byteLength) break;
      if (asText) {
        out.push(String.fromCharCode(view.getUint8(p)));
      } else if (elemType === 1 && elemSize === 4) {
        out.push(view.getFloat32(p));
      } else {
        switch (elemSize) {
          case 1: out.push(view.getUint8(p)); break;
          case 2: out.push(view.getInt16(p)); break;
          case 4: out.push(view.getInt32(p)); break;
          default: return null;
        }
      }
    }
    if (asText) return out.join('').replace(/\0+$/, '');
    return out;
  }

  const bases = readValues('PBAS', 2) || readValues('PBAS', 1) || '';
  const fwo = (readValues('FWO', 1) || 'GATC').replace(/[^GATC]/g, '') || 'GATC';
  const ploc = readValues('PLOC', 2) || readValues('PLOC', 1) || [];
  const qual = readValues('PCON', 2) || readValues('PCON', 1) || readValues('PQUAL', 2) || null;

  const channels = {};
  for (let i = 0; i < fwo.length; i++) {
    const data = readValues('DATA', 9 + i);
    if (data) channels[fwo[i]] = data;
  }

  if (!bases.length || !Object.keys(channels).length) {
    throw new Error('ABIF file is missing base-call or trace data');
  }
  return { bases, channels, ploc, qual };
}

const COMPLEMENT = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
function revcomp(s) {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) out += COMPLEMENT[s[i]] || 'N';
  return out;
}

// Semi-global (overlap) Needleman-Wunsch: end gaps are free, so the reads
// align by their true overlap regardless of differing start/end offsets —
// same semantics as the backend's PairwiseAligner configuration.
function alignColumns(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_ALIGN_CELLS) return null;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const ptr = new Uint8Array((n + 1) * W);
  for (let j = 1; j <= m; j++) { score[j] = 0; ptr[j] = 3; }
  for (let i = 1; i <= n; i++) {
    const row = i * W, prev = row - W;
    score[row] = 0;
    ptr[row] = 2;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const diag = score[prev + j - 1] + (ai === b.charCodeAt(j - 1) ? 3 : -2);
      const up = score[prev + j] - 3;
      const left = score[row + j - 1] - 3;
      let best = diag, p = 1;
      if (up > best) { best = up; p = 2; }
      if (left > best) { best = left; p = 3; }
      score[row + j] = best;
      ptr[row + j] = p;
    }
  }
  // Overlap may end before either sequence's end (e.g. a primer-only 3'
  // overhang), so start the traceback from the best-scoring cell on the
  // bottom row or right column.
  let bi = n, bj = m, bs = score[n * W + m];
  for (let j = 0; j <= m; j++) if (score[n * W + j] > bs) { bs = score[n * W + j]; bi = n; bj = j; }
  for (let i = 0; i <= n; i++) if (score[i * W + m] > bs) { bs = score[i * W + m]; bi = i; bj = m; }

  const colOfA = new Int32Array(n);
  const colOfB = new Int32Array(m);
  let pathLen = 0, ci = bi, cj = bj;
  while (ci > 0 || cj > 0) {
    const p = (ci === 0) ? 3 : (cj === 0) ? 2 : ptr[ci * W + cj];
    if (p === 1) { ci--; cj--; } else if (p === 2) { ci--; } else { cj--; }
    pathLen++;
  }
  const overhangA = n - bi, overhangB = m - bj;
  const totalCols = pathLen + Math.max(overhangA, overhangB);
  let col = pathLen - 1;
  ci = bi; cj = bj;
  while (ci > 0 || cj > 0) {
    const p = (ci === 0) ? 3 : (cj === 0) ? 2 : ptr[ci * W + cj];
    if (p === 1) { colOfA[ci - 1] = col; colOfB[cj - 1] = col; ci--; cj--; }
    else if (p === 2) { colOfA[ci - 1] = col; ci--; }
    else { colOfB[cj - 1] = col; cj--; }
    col--;
  }
  for (let k = 0; k < overhangA; k++) colOfA[bi + k] = pathLen + k;
  for (let k = 0; k < overhangB; k++) colOfB[bj + k] = pathLen + k;
  return { colOfA, colOfB, totalCols };
}

// Piecewise-linear sample<->column mapping through per-base anchors.
function makeColToSample(ploc, colOf) {
  const anchors = ploc.map((s, i) => [colOf[i], s]);
  return function (col) {
    if (col <= anchors[0][0]) {
      const [c0, s0] = anchors[0], [c1, s1] = anchors[1] || [c0 + 1, s0];
      return s0 + (col - c0) * (s1 - s0) / (c1 - c0 || 1);
    }
    const last = anchors.length - 1;
    if (col >= anchors[last][0]) {
      const [c0, s0] = anchors[last - 1], [c1, s1] = anchors[last];
      return s1 + (col - c1) * (s1 - s0) / (c1 - c0 || 1);
    }
    let lo = 0, hi = anchors.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][0] <= col) lo = mid; else hi = mid;
    }
    const [c0, s0] = anchors[lo], [c1, s1] = anchors[hi];
    return s0 + (col - c0) * (s1 - s0) / (c1 - c0 || 1);
  };
}

function qualColor(q) {
  return q >= 40 ? QUAL_COLORS.good : q >= 20 ? QUAL_COLORS.mid : QUAL_COLORS.bad;
}

function createReadRenderer(canvas) {
  // read: {bases, channels, ploc, qual, colOf} — colOf may be null (unaligned)
  let read = null;
  let amp = 1;

  function setRead(r) { read = r; }
  function setAmplitude(v) { amp = v; }

  function draw(view) {
    if (!read) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const colOf = read.colOf || read.ploc.map((_, i) => i);
    const colToSample = makeColToSample(read.ploc, colOf);
    const sampleCount = read.channels.A.length;
    const sampleAt = (col) => {
      const s = colToSample(col);
      return Math.max(0, Math.min(s, sampleCount - 1));
    };

    // Robust full-trace y-scale (99.5th percentile) so spikes don't flatten
    // everything; the amplitude slider provides the "volume" control.
    const pool = [];
    for (const values of Object.values(read.channels)) {
      const stride = Math.max(1, Math.floor(values.length / 4000));
      for (let i = 0; i < values.length; i += stride) {
        if (values[i] > 0) pool.push(values[i]);
      }
    }
    pool.sort((a, b) => a - b);
    const scaleMax = Math.max(pool.length ? pool[Math.floor(pool.length * 0.995)] : 1, 10);

    const padBottom = 18;
    const qualH = read.qual ? 20 : 0;
    const posH = 12;
    const padTop = posH + qualH + 4;
    const plotH = h - padBottom - padTop;
    const baseline = h - padBottom;
    const spacing = 1 / view.colsPerPx;

    // Position ruler (1-based), adaptive tick spacing
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const step = steps.find(s => s * spacing >= 60) || 2000;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const firstTick = Math.max(1, Math.ceil(view.col / step) * step);
    for (let k = firstTick; k < view.col + w * view.colsPerPx; k += step) {
      const px = (k - view.col) / view.colsPerPx;
      if (px < -20 || px > w + 20) continue;
      ctx.fillStyle = '#9aa3b2';
      ctx.fillRect(px - 0.5, 0, 1, 4);
      ctx.fillText(String(k + 1), px, 11);
    }

    // Quality strip: colored bar per base, numeric Q value when zoomed in
    if (read.qual) {
      const showQNums = spacing >= 14;
      for (let i = 0; i < read.bases.length; i++) {
        const col = read.colOf ? read.colOf[i] : i;
        const px = (col - view.col) / view.colsPerPx;
        if (px < -4 || px > w + 4) continue;
        const c = qualColor(read.qual[i]);
        ctx.fillStyle = c;
        ctx.fillRect(px - 1.5, posH + 12, 3, 7);
        if (showQNums) {
          ctx.font = '8px monospace';
          ctx.fillText(String(read.qual[i]), px, posH + 9);
        }
      }
    }

    // Traces
    ctx.lineWidth = 1.4;
    for (const [base, values] of Object.entries(read.channels)) {
      ctx.strokeStyle = CHANNEL_COLORS[base] || '#888';
      ctx.beginPath();
      let started = false;
      for (let px = 0; px <= w; px++) {
        const col = view.col + px * view.colsPerPx;
        const s = sampleAt(col);
        const s0 = Math.floor(s), s1 = Math.min(s0 + 1, sampleCount - 1);
        const v = values[s0] + (values[s1] - values[s0]) * (s - s0);
        const y = baseline - Math.min((v / scaleMax) * plotH * amp, plotH + padTop);
        if (!started) { ctx.moveTo(px, y); started = true; } else { ctx.lineTo(px, y); }
      }
      ctx.stroke();
    }

    // Base labels, colored by base
    if (spacing >= 9) {
      ctx.font = '700 11px monospace';
      ctx.textAlign = 'center';
      for (let i = 0; i < read.bases.length; i++) {
        const col = read.colOf ? read.colOf[i] : i;
        const px = (col - view.col) / view.colsPerPx;
        if (px < -4 || px > w + 4) continue;
        ctx.fillStyle = CHANNEL_COLORS[read.bases[i]] || '#888';
        ctx.fillText(read.bases[i], px, h - 5);
      }
    }
  }

  return { draw, setAmplitude, setRead };
}

export function attachTraceViewer({ canvasF, canvasR, metaEl, zoomInBtn, zoomOutBtn, resetBtn, ampSlider }) {
  let reads = { F: null, R: null };
  let totalCols = 0;
  let view = { col: 0, colsPerPx: 1 };
  const renderers = {
    F: createReadRenderer(canvasF),
    R: createReadRenderer(canvasR),
  };

  function fitView() {
    // Start zoomed into the first ~40 bases (Benchling-style) instead of
    // squashing the whole read into the canvas.
    const initialCols = Math.min(40, Math.max(totalCols, 1));
    view.colsPerPx = initialCols / canvasF.clientWidth;
    view.col = 0;
  }

  function clampView() {
    const w = canvasF.clientWidth;
    const maxColsPerPx = Math.max(totalCols / w, 0.02);
    view.colsPerPx = Math.min(view.colsPerPx, maxColsPerPx);
    const visible = w * view.colsPerPx;
    view.col = Math.max(0, Math.min(view.col, totalCols - visible));
  }

  function draw() {
    renderers.F.draw(view);
    renderers.R.draw(view);
  }

  function zoom(factor, centerRatio = 0.5) {
    const w = canvasF.clientWidth;
    const visibleBefore = w * view.colsPerPx;
    const center = view.col + centerRatio * visibleBefore;
    view.colsPerPx /= factor;
    clampView();
    const visibleAfter = w * view.colsPerPx;
    view.col = Math.max(0, center - centerRatio * visibleAfter);
    clampView();
    draw();
  }

  function setData(fwd, rev, nameF, nameR) {
    reads.F = fwd; reads.R = rev;
    renderers.F.setRead(fwd);
    renderers.R.setRead(rev);
    const parts = [];

    if (fwd && rev) {
      const rcBases = revcomp(rev.bases);
      const aln = alignColumns(fwd.bases, rcBases);
      if (aln) {
        fwd.colOf = aln.colOfA;
        rev.colOf = aln.colOfB;
        // Reverse read is rendered reverse-complemented: flip its base-indexed
        // arrays so base j of the revcomp maps to its original peak sample,
        // and complement-swap the channels (sample order is untouched — base
        // j's peak lives at the ORIGINAL sample of the base it came from,
        // but under the complement base's channel color).
        const comp = { A: 'T', T: 'A', G: 'C', C: 'G' };
        const swapped = {};
        for (const b of Object.keys(rev.channels)) {
          swapped[b] = rev.channels[comp[b]] || rev.channels[b];
        }
        rev.channels = swapped;
        rev.bases = rcBases;
        rev.ploc = [...rev.ploc].reverse();
        if (rev.qual) rev.qual = [...rev.qual].reverse();
        totalCols = aln.totalCols;
        parts.push('traces aligned');
      } else {
        fwd.colOf = null; rev.colOf = null;
        totalCols = Math.max(fwd.bases.length, rev.bases.length);
        parts.push('too long to align — shown from each read start');
      }
    } else {
      const only = fwd || rev;
      only.colOf = null;
      totalCols = only.bases.length;
    }

    if (reads.F) { canvasF.style.display = ''; canvasF.parentElement.style.display = ''; }
    else { canvasF.style.display = 'none'; canvasF.parentElement.style.display = 'none'; }
    if (reads.R) { canvasR.style.display = ''; canvasR.parentElement.style.display = ''; }
    else { canvasR.style.display = 'none'; canvasR.parentElement.style.display = 'none'; }

    if (fwd) parts.unshift(`${nameF} (${fwd.bases.length} bases)`);
    if (rev) parts.splice(fwd ? 1 : 0, 0, `${nameR} (${rev.bases.length} bases, reverse-complemented)`);
    if (metaEl) metaEl.textContent = parts.join(' · ');

    fitView();
    draw();
  }

  zoomInBtn?.addEventListener('click', () => zoom(1.4, 0.5));
  zoomOutBtn?.addEventListener('click', () => zoom(0.72, 0.5));
  resetBtn?.addEventListener('click', () => { fitView(); draw(); });
  ampSlider?.addEventListener('input', () => {
    const amp = parseFloat(ampSlider.value);
    renderers.F.setAmplitude(amp);
    renderers.R.setAmplitude(amp);
    draw();
  });

  function bindCanvas(canvas) {
    let dragging = false, lastX = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      view.col = Math.max(0, view.col - dx * view.colsPerPx);
      clampView();
      draw();
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - rect.left) / rect.width);
    }, { passive: false });

    let pinchDist = 0;
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (pinchDist) zoom(d / pinchDist, 0.5);
      pinchDist = d;
    }, { passive: false });
    canvas.addEventListener('touchend', () => { pinchDist = 0; });
  }
  bindCanvas(canvasF);
  bindCanvas(canvasR);
  window.addEventListener('resize', () => { clampView(); draw(); });

  return {
    setData,
    clear() {
      reads = { F: null, R: null };
      for (const c of [canvasF, canvasR]) {
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
      }
      if (metaEl) metaEl.textContent = '';
    },
  };
}
