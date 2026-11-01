// Client-side ABIF parser + Benchling-style stacked chromatogram viewer.
// Forward and reverse traces are oriented and aligned (semi-global
// Needleman-Wunsch) so both render in a shared column space, with per-base
// Phred quality bars, live Mott trim shading, secondary-peak markers,
// click-to-jump column highlighting, and an amplitude slider — mirroring the
// tags the backend pipeline reads (DATA9-12, PLOC2, PBAS2, FWO_1, PCON2).

const CHANNEL_COLORS = { A: '#16a34a', C: '#2563eb', G: '#111827', T: '#dc2626' };
const QUAL_COLORS = { good: '#16a34a', mid: '#eab308', bad: '#dc2626' };
const COMPLEMENT = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
const MAX_ALIGN_CELLS = 4_000_000;

export function revcomp(s) {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i].toUpperCase();
    out += COMPLEMENT[ch] || 'N';
  }
  return out;
}

export function parseABIF(buffer) {
  if (!buffer || buffer.byteLength < 34) {
    throw new Error('Not an ABIF file (truncated header)');
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );
  if (magic !== 'ABIF') throw new Error('Not an ABIF file');

  const dirCount = view.getUint32(18);
  const dirOffset = view.getUint32(26);

  const entries = new Map();
  for (let i = 0; i < dirCount; i++) {
    const p = dirOffset + i * 28;
    if (p < 0 || p + 28 > buffer.byteLength) break;
    const tag = String.fromCharCode(...new Uint8Array(buffer, p, 4)).replace(/\0/g, '');
    const number = view.getUint32(p + 4);
    entries.set(tag + number, {
      entryOffset: p,
      elemType: view.getUint16(p + 8),
      elemSize: view.getUint16(p + 10),
      numElems: view.getUint32(p + 12),
      dataSize: view.getUint32(p + 16),
      dataOffset: view.getUint32(p + 20),
    });
  }

  function resolveBaseOffset(e) {
    // ABIF spec: payloads <= 4 bytes are stored inline inside the directory
    // entry's 4-byte dataOffset field at entryOffset + 20.
    return e.dataSize <= 4 ? e.entryOffset + 20 : e.dataOffset;
  }

  function readText(tag, number = 1) {
    const e = entries.get(tag + number);
    if (!e || e.elemSize !== 1 || e.numElems === 0) return null;
    const inline = e.dataSize <= 4;
    const base = resolveBaseOffset(e);
    const limit = inline ? Math.min(e.numElems, 4) : e.numElems;
    let startIdx = 0;
    let count = limit;
    // ABIF pString (elemType 18) prefixes length at byte 0
    if (e.elemType === 18 && limit >= 1 && base < buffer.byteLength) {
      const pLen = view.getUint8(base);
      startIdx = 1;
      count = Math.min(limit, 1 + pLen);
    }
    const chars = [];
    for (let i = startIdx; i < count; i++) {
      const p = base + i;
      if (p < 0 || p >= buffer.byteLength) break;
      chars.push(String.fromCharCode(view.getUint8(p)));
    }
    return chars.join('').replace(/\0+$/, '');
  }

  function readNumbers(tag, number = 1) {
    const e = entries.get(tag + number);
    if (!e || e.elemSize <= 0) return null;
    const { elemType, elemSize, numElems, dataSize } = e;
    const inline = dataSize <= 4;
    const base = resolveBaseOffset(e);
    const out = [];
    for (let i = 0; i < numElems; i++) {
      if (inline && (i + 1) * elemSize > 4) break;
      const p = base + i * elemSize;
      if (p < 0 || p + elemSize > buffer.byteLength) break;
      if (elemType === 7 && elemSize === 4) {
        out.push(view.getFloat32(p));
      } else {
        switch (elemSize) {
          case 1: out.push(view.getUint8(p)); break;
          case 2: out.push(elemType === 3 ? view.getUint16(p) : view.getInt16(p)); break;
          case 4: out.push(elemType === 5 ? view.getUint32(p) : view.getInt32(p)); break;
          default: return null;
        }
      }
    }
    return out;
  }

  const bases = (readText('PBAS', 2) || readText('PBAS', 1) || '').toUpperCase();
  const rawFwo = (readText('FWO_', 1) || readText('FWO', 1) || 'GATC')
    .toUpperCase()
    .replace(/[^GATC]/g, '');
  const fwo = (rawFwo.length >= 4 && new Set(rawFwo.slice(0, 4)).size === 4)
    ? rawFwo.slice(0, 4)
    : 'GATC';

  const rawPloc = readNumbers('PLOC', 2) || readNumbers('PLOC', 1) || [];
  const rawQual = readNumbers('PCON', 2) || readNumbers('PCON', 1) || readNumbers('PQU1', 1) || null;

  const rawChannels = {};
  let sampleCount = 0;
  for (let i = 0; i < 4; i++) {
    const data = readNumbers('DATA', 9 + i);
    if (data && data.length > 0) {
      rawChannels[fwo[i]] = data;
      if (data.length > sampleCount) sampleCount = data.length;
    }
  }

  if (!bases.length || sampleCount === 0 || !Object.keys(rawChannels).length) {
    throw new Error('ABIF file is missing base-call or trace data');
  }

  const channels = {};
  for (const b of ['G', 'A', 'T', 'C']) {
    channels[b] = rawChannels[b] || new Array(sampleCount).fill(0);
  }

  // Keep ploc and qual strictly aligned to bases.length so per-base lookups
  // never index out of bounds or produce undefined column anchors.
  const ploc = new Array(bases.length);
  if (rawPloc.length >= bases.length) {
    for (let i = 0; i < bases.length; i++) {
      ploc[i] = Math.max(0, Math.min(rawPloc[i], sampleCount - 1));
    }
  } else if (rawPloc.length > 0) {
    for (let i = 0; i < rawPloc.length; i++) {
      ploc[i] = Math.max(0, Math.min(rawPloc[i], sampleCount - 1));
    }
    const lastSample = ploc[rawPloc.length - 1];
    const rem = bases.length - rawPloc.length;
    for (let k = 0; k < rem; k++) {
      const frac = (k + 1) / (rem + 1);
      ploc[rawPloc.length + k] = Math.round(lastSample + frac * (sampleCount - 1 - lastSample));
    }
  } else {
    for (let i = 0; i < bases.length; i++) {
      ploc[i] = Math.round(((i + 0.5) / bases.length) * (sampleCount - 1));
    }
  }

  let qual = null;
  if (rawQual && rawQual.length > 0) {
    qual = new Array(bases.length);
    for (let i = 0; i < bases.length; i++) {
      qual[i] = i < rawQual.length ? rawQual[i] : 0;
    }
  }

  return { bases, channels, ploc, qual, fwo };
}

// Kadane Mott quality trimming window [start, end) in read coordinates —
// exact match to backend sangeranalyst.py:abi_trim.
export function computeMottTrimWindow(qual, cutoff = 0.1) {
  if (!qual || qual.length === 0) return [0, 0];
  const n = qual.length;
  if (n <= 20) return [0, n];
  const c = Number(cutoff);
  if (!Number.isFinite(c) || c <= 0) return [0, n];

  let bestSum = 0, bestStart = 0, bestEnd = 0;
  let cur = 0, curStart = 0;
  for (let i = 0; i < n; i++) {
    const s = c - Math.pow(10, qual[i] / -10.0);
    cur += s;
    if (cur <= 0) {
      cur = 0;
      curStart = i + 1;
    } else if (cur > bestSum) {
      bestSum = cur;
      bestStart = curStart;
      bestEnd = i + 1;
    }
  }
  if (bestEnd - bestStart < 5) return [0, n];
  return [bestStart, bestEnd];
}

function findLocalMaxInWindow(trace, centerIdx, radius) {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(trace.length - 1, centerIdx + radius);
  if (end - start < 2) return null;

  const searchStart = Math.max(1, start);
  const searchEnd = Math.min(trace.length - 2, end);
  let bestVal = -1;
  let found = false;

  for (let i = searchStart; i <= searchEnd; i++) {
    const val = trace[i];
    const prev = trace[i - 1];
    const next = trace[i + 1];
    if ((val >= prev && val > next) || (val > prev && val >= next)) {
      if (val > bestVal) {
        bestVal = val;
        found = true;
      }
    }
  }
  return found ? bestVal : null;
}

// Client-side secondary peak detector matching sangeranalyst.py:detect_secondary_peaks.
export function detectTraceSecondaryPeaks(rawRead, thresholdPct = 33, complementBases = false, searchWindow = 3) {
  if (!rawRead || !rawRead.bases || !rawRead.ploc || !rawRead.channels) return [];
  const pct = Number(thresholdPct);
  if (!Number.isFinite(pct) || pct <= 0) return [];

  const { bases, ploc, channels } = rawRead;
  const limit = Math.min(ploc.length, bases.length);
  const results = [];

  for (let i = 0; i < limit; i++) {
    const centerLoc = ploc[i];
    const primaryBase = bases[i];
    const primaryTrace = channels[primaryBase];
    if (!primaryTrace || centerLoc < 0 || centerLoc >= primaryTrace.length) continue;

    const primarySignal = primaryTrace[centerLoc];
    if (primarySignal < 1) continue;

    let topPeak = null;
    for (const base of ['G', 'A', 'T', 'C']) {
      if (base === primaryBase) continue;
      const trace = channels[base];
      if (!trace || !trace.length) continue;
      const peakVal = findLocalMaxInWindow(trace, centerLoc, searchWindow);
      if (peakVal !== null) {
        const ratio = (peakVal / primarySignal) * 100.0;
        if (ratio >= pct && (!topPeak || ratio > topPeak.percentage)) {
          topPeak = {
            rawIndex: i,
            position: i + 1,
            primaryBase: complementBases ? (COMPLEMENT[primaryBase] || primaryBase) : primaryBase,
            secondaryBase: complementBases ? (COMPLEMENT[base] || base) : base,
            percentage: Math.round(ratio * 100) / 100,
          };
        }
      }
    }
    if (topPeak) results.push(topPeak);
  }
  return results;
}

// Semi-global (overlap) Needleman-Wunsch: end gaps are free, so the reads
// align by their true overlap regardless of differing start/end offsets —
// same semantics as the backend's PairwiseAligner configuration.
export function alignColumns(a, b) {
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

function computeSharedIdentity(seqA, colOfA, seqB, colOfB) {
  let both = 0, match = 0, i = 0, j = 0;
  while (i < seqA.length && j < seqB.length) {
    const ca = colOfA[i], cb = colOfB[j];
    if (ca === cb) {
      both++;
      if (seqA[i] === seqB[j]) match++;
      i++; j++;
    } else if (ca < cb) i++;
    else j++;
  }
  return { shared: both, matches: match, identity: both > 0 ? match / both : 0 };
}

// Piecewise-linear sample<->column mapping through per-base anchors.
function makeColToSample(ploc, colOf) {
  if (!ploc || ploc.length === 0) return () => 0;
  if (ploc.length === 1) {
    const c0 = colOf[0] ?? 0;
    const s0 = ploc[0] ?? 0;
    return (col) => s0 + (col - c0) * 12;
  }
  const anchors = ploc.map((s, i) => [colOf[i] ?? i, s]);
  return function (col) {
    if (col <= anchors[0][0]) {
      const [c0, s0] = anchors[0], [c1, s1] = anchors[1];
      return s0 + (col - c0) * (s1 - s0) / (c1 - c0 || 1);
    }
    const last = anchors.length - 1;
    if (col >= anchors[last][0]) {
      const [c0, s0] = anchors[last - 1], [c1, s1] = anchors[last];
      return s1 + (col - c1) * (s1 - s0) / (c1 - c0 || 1);
    }
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][0] <= col) lo = mid; else hi = mid;
    }
    const [c0, s0] = anchors[lo], [c1, s1] = anchors[hi];
    return s0 + (col - c0) * (s1 - s0) / (c1 - c0 || 1);
  };
}

function computeScaleMax(channels) {
  const pool = [];
  for (const values of Object.values(channels)) {
    if (!values || !values.length) continue;
    const stride = Math.max(1, Math.floor(values.length / 4000));
    for (let i = 0; i < values.length; i += stride) {
      if (values[i] > 0) pool.push(values[i]);
    }
  }
  pool.sort((a, b) => a - b);
  return Math.max(pool.length ? pool[Math.floor(pool.length * 0.995)] : 1, 10);
}

function qualColor(q) {
  return q >= 40 ? QUAL_COLORS.good : q >= 20 ? QUAL_COLORS.mid : QUAL_COLORS.bad;
}

function createReadRenderer(canvas) {
  let read = null;
  let amp = 1;
  let colOf = null;
  let colToSample = () => 0;
  let sampleCount = 1;
  let scaleMax = 10;

  function setRead(r) {
    read = r;
    if (!r) {
      colOf = null;
      colToSample = () => 0;
      sampleCount = 1;
      scaleMax = 10;
      return;
    }
    colOf = r.colOf || r.ploc.map((_, i) => i);
    colToSample = makeColToSample(r.ploc, colOf);
    const firstChan = r.channels.A || r.channels.C || r.channels.G || r.channels.T || [];
    sampleCount = Math.max(1, firstChan.length);
    scaleMax = computeScaleMax(r.channels);
  }

  function setAmplitude(v) { amp = v; }

  function draw(view, highlight = null) {
    if (!read || !canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sampleAt = (col) => {
      const s = colToSample(col);
      return Math.max(0, Math.min(s, sampleCount - 1));
    };

    const padBottom = 18;
    const qualH = read.qual ? 22 : 0;
    const posH = 12;
    const padTop = posH + qualH + 4;
    const plotH = h - padBottom - padTop;
    const baseline = h - padBottom;
    const spacing = 1 / view.colsPerPx;

    // 1. Highlighted base column (from conflict / secondary-peak click-to-jump)
    if (highlight && Number.isFinite(highlight.col)) {
      const hx = (highlight.col - view.col) / view.colsPerPx;
      const bandW = Math.max(spacing, 8);
      if (hx + bandW >= 0 && hx - bandW <= w) {
        ctx.fillStyle = 'rgba(37, 99, 235, 0.13)';
        ctx.fillRect(hx - bandW / 2, posH, bandW, h - posH);
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(hx - bandW / 2 + 0.5, posH + 0.5, Math.max(1, bandW - 1), h - posH - 1);
      }
    }

    // 2. Live Mott quality-trim curtains (5' and 3' trimmed tails)
    const trimWin = read.trimWindow;
    if (trimWin && read.bases.length > 0) {
      const [tStart, tEnd] = trimWin;
      ctx.save();
      if (tStart > 0 && tStart <= colOf.length) {
        const boundaryCol = (tStart < colOf.length ? colOf[tStart] : colOf[colOf.length - 1] + 1) - 0.5;
        const bx = Math.min(w, (boundaryCol - view.col) / view.colsPerPx);
        if (bx > 0) {
          ctx.fillStyle = 'rgba(100, 116, 139, 0.14)';
          ctx.fillRect(0, posH, bx, h - posH);
          if (bx <= w) {
            ctx.strokeStyle = 'rgba(71, 85, 105, 0.65)';
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(bx, posH);
            ctx.lineTo(bx, h);
            ctx.stroke();
          }
        }
      }
      if (tEnd < read.bases.length && tEnd >= 0) {
        const boundaryCol = (tEnd > 0 ? colOf[tEnd - 1] : colOf[0] - 1) + 0.5;
        const bx = Math.max(0, (boundaryCol - view.col) / view.colsPerPx);
        if (bx < w) {
          ctx.fillStyle = 'rgba(100, 116, 139, 0.14)';
          ctx.fillRect(bx, posH, w - bx, h - posH);
          if (bx >= 0) {
            ctx.strokeStyle = 'rgba(71, 85, 105, 0.65)';
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(bx, posH);
            ctx.lineTo(bx, h);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // 3. Position ruler (1-based: pos 1 sits at col 0, pos 10 at col 9, ...)
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const step = steps.find(s => s * spacing >= 60) || 2000;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const maxVisPos = Math.ceil(view.col + w * view.colsPerPx) + 1;
    const drawTick = (pos1) => {
      const col = pos1 - 1;
      const px = (col - view.col) / view.colsPerPx;
      if (px < -20 || px > w + 20) return;
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(px - 0.5, 0, 1, 4);
      ctx.fillText(String(pos1), px, 11);
    };
    if ((step - 1) * spacing >= 28) drawTick(1);
    const firstMult = Math.max(step, Math.ceil((view.col + 1) / step) * step);
    for (let pos1 = firstMult; pos1 <= maxVisPos; pos1 += step) {
      drawTick(pos1);
    }

    // 4. Quality strip: colored bar per base, Q number when zoomed in, plus
    //    amber secondary-peak diamond markers above the bar.
    if (read.qual) {
      const showQNums = spacing >= 14;
      for (let i = 0; i < read.bases.length; i++) {
        const col = colOf[i];
        const px = (col - view.col) / view.colsPerPx;
        if (px < -4 || px > w + 4) continue;
        const c = qualColor(read.qual[i]);
        ctx.fillStyle = c;
        ctx.fillRect(px - 1.5, posH + 13, 3, 7);
        if (showQNums) {
          ctx.font = '8px monospace';
          ctx.fillText(String(read.qual[i]), px, posH + 10);
        }
      }
    }

    if (read.secPeakByIdx && read.secPeakByIdx.size > 0) {
      for (const [idx, sp] of read.secPeakByIdx.entries()) {
        const col = colOf[idx];
        const px = (col - view.col) / view.colsPerPx;
        if (px < -8 || px > w + 8) continue;
        const dy = posH + (read.qual ? 22 : 6);
        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.moveTo(px, dy - 3.5);
        ctx.lineTo(px + 3.5, dy);
        ctx.lineTo(px, dy + 3.5);
        ctx.lineTo(px - 3.5, dy);
        ctx.closePath();
        ctx.fill();
        if (spacing >= 18) {
          ctx.font = '700 8px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${sp.primaryBase}/${sp.secondaryBase}`, px, dy + 11);
        }
      }
    }

    // 5. Traces
    ctx.lineWidth = 1.4;
    for (const [base, values] of Object.entries(read.channels)) {
      if (!values || !values.length) continue;
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

    // 6. Base labels, colored by base (slightly muted in Mott-trimmed tails)
    if (spacing >= 9) {
      ctx.font = '700 11px monospace';
      ctx.textAlign = 'center';
      const [tStart, tEnd] = read.trimWindow || [0, read.bases.length];
      for (let i = 0; i < read.bases.length; i++) {
        const col = colOf[i];
        const px = (col - view.col) / view.colsPerPx;
        if (px < -4 || px > w + 4) continue;
        const trimmed = i < tStart || i >= tEnd;
        ctx.globalAlpha = trimmed ? 0.42 : 1;
        ctx.fillStyle = CHANNEL_COLORS[read.bases[i]] || '#888';
        ctx.fillText(read.bases[i], px, h - 5);
      }
      ctx.globalAlpha = 1;
    }
  }

  return { draw, setAmplitude, setRead };
}

function cloneRawRead(r) {
  if (!r) return null;
  return {
    bases: r.bases,
    channels: { ...r.channels },
    ploc: [...r.ploc],
    qual: r.qual ? [...r.qual] : null,
    fwo: r.fwo,
  };
}

export function attachTraceViewer({
  canvasF,
  canvasR,
  metaEl,
  zoomInBtn,
  zoomOutBtn,
  resetBtn,
  ampSlider,
  scrollBar,
  onFocusChange,
}) {
  let rawReads = { F: null, R: null };
  let reads = { F: null, R: null };
  let revComplemented = false;
  let mottCutoff = 0.1;
  let secPeakThreshold = 33;
  let highlight = null;
  let totalCols = 0;
  let view = { col: 0, colsPerPx: 1 };
  const PX_PER_COL = 20;

  const renderers = {
    F: createReadRenderer(canvasF),
    R: createReadRenderer(canvasR),
  };

  function activeWidth() {
    const wf = reads.F && canvasF ? canvasF.clientWidth : 0;
    const wr = reads.R && canvasR ? canvasR.clientWidth : 0;
    return Math.max(wf || wr || 600, 100);
  }

  function syncScrollBar() {
    if (!scrollBar) return;
    const spacer = scrollBar.firstElementChild;
    if (spacer) {
      spacer.style.width = `${Math.max(totalCols * PX_PER_COL, scrollBar.clientWidth + 1)}px`;
    }
    const target = Math.round(view.col * PX_PER_COL);
    if (Math.abs(scrollBar.scrollLeft - target) > 1) {
      scrollBar.scrollLeft = target;
    }
  }

  function fitView() {
    const initialCols = Math.min(40, Math.max(totalCols, 1));
    view.colsPerPx = initialCols / activeWidth();
    view.col = 0;
    clampView();
  }

  function clampView() {
    const w = activeWidth();
    const minColsPerPx = 0.02; // max ~50 px per base zoom-in
    const maxColsPerPx = Math.max(totalCols / w, minColsPerPx);
    view.colsPerPx = Math.min(Math.max(view.colsPerPx, minColsPerPx), maxColsPerPx);
    const visible = w * view.colsPerPx;
    view.col = Math.max(0, Math.min(view.col, Math.max(0, totalCols - visible)));
  }

  function draw() {
    renderers.F.draw(view, highlight);
    renderers.R.draw(view, highlight);
    syncScrollBar();
  }

  function recomputeAnnotations() {
    if (reads.F && rawReads.F) {
      reads.F.trimWindow = rawReads.F.qual
        ? computeMottTrimWindow(rawReads.F.qual, mottCutoff)
        : [0, reads.F.bases.length];
      const spF = detectTraceSecondaryPeaks(rawReads.F, secPeakThreshold, false);
      reads.F.secPeakByIdx = new Map(spF.map(p => [p.rawIndex, p]));
    }
    if (reads.R && rawReads.R) {
      const L = rawReads.R.bases.length;
      if (rawReads.R.qual) {
        const [rs, re] = computeMottTrimWindow(rawReads.R.qual, mottCutoff);
        reads.R.trimWindow = revComplemented ? [L - re, L - rs] : [rs, re];
      } else {
        reads.R.trimWindow = [0, L];
      }
      const spR = detectTraceSecondaryPeaks(rawReads.R, secPeakThreshold, revComplemented);
      reads.R.secPeakByIdx = new Map(
        spR.map(p => [revComplemented ? (L - 1 - p.rawIndex) : p.rawIndex, p])
      );
    }
  }

  function zoom(factor, centerRatio = 0.5) {
    const w = activeWidth();
    const ratio = Number.isFinite(centerRatio) ? Math.min(Math.max(centerRatio, 0), 1) : 0.5;
    const visibleBefore = w * view.colsPerPx;
    const center = view.col + ratio * visibleBefore;
    view.colsPerPx /= factor;
    clampView();
    const visibleAfter = w * view.colsPerPx;
    view.col = Math.max(0, center - ratio * visibleAfter);
    clampView();
    draw();
  }

  function setHighlight(next) {
    highlight = next;
    onFocusChange?.(highlight);
  }

  function setData(fwdInput, revInput, nameF, nameR) {
    rawReads = { F: cloneRawRead(fwdInput), R: cloneRawRead(revInput) };
    const fwd = cloneRawRead(fwdInput);
    const rev = cloneRawRead(revInput);
    reads = { F: fwd, R: rev };
    revComplemented = false;
    setHighlight(null);

    const parts = [];
    let stats = null;

    if (fwd && rev) {
      const rcBases = revcomp(rev.bases);
      const alnRc = alignColumns(fwd.bases, rcBases);
      const alnRaw = alignColumns(fwd.bases, rev.bases);

      if (alnRc) {
        const statsRc = computeSharedIdentity(fwd.bases, alnRc.colOfA, rcBases, alnRc.colOfB);
        const statsRaw = alnRaw
          ? computeSharedIdentity(fwd.bases, alnRaw.colOfA, rev.bases, alnRaw.colOfB)
          : { shared: 0, matches: -1, identity: 0 };

        // Mirror backend detect_best_orientation: prefer standard revcomp unless
        // the uploaded reverse read already aligns substantially better raw.
        const useRaw = alnRaw && statsRaw.matches > statsRc.matches && statsRaw.identity >= 0.65;
        if (useRaw) {
          fwd.colOf = alnRaw.colOfA;
          rev.colOf = alnRaw.colOfB;
          totalCols = alnRaw.totalCols;
          revComplemented = false;
          stats = { shared: statsRaw.shared, identity: statsRaw.identity, revComplemented: false, orientation: 'raw' };
          parts.push('traces aligned (reverse already in forward orientation)');
        } else {
          fwd.colOf = alnRc.colOfA;
          rev.colOf = alnRc.colOfB;
          const swapped = {};
          for (const b of Object.keys(rev.channels)) {
            swapped[b] = rev.channels[COMPLEMENT[b]] || rev.channels[b];
          }
          rev.channels = swapped;
          rev.bases = rcBases;
          rev.ploc = [...rev.ploc].reverse();
          if (rev.qual) rev.qual = [...rev.qual].reverse();
          totalCols = alnRc.totalCols;
          revComplemented = true;
          stats = { shared: statsRc.shared, identity: statsRc.identity, revComplemented: true, orientation: 'revcomp' };
          parts.push('traces aligned');
        }
      } else {
        fwd.colOf = null;
        rev.colOf = null;
        totalCols = Math.max(fwd.bases.length, rev.bases.length);
        stats = { shared: 0, identity: null, revComplemented: false, orientation: 'unaligned' };
        parts.push('too long to align — shown from each read start');
      }
    } else if (fwd || rev) {
      const only = fwd || rev;
      only.colOf = null;
      totalCols = only.bases.length;
      stats = { shared: 0, identity: null, revComplemented: false, orientation: 'single' };
    } else {
      totalCols = 0;
    }

    // Update DOM display BEFORE fitView() so activeWidth() reads real layout width
    if (canvasF) {
      canvasF.style.display = reads.F ? '' : 'none';
      if (canvasF.parentElement?.parentElement) {
        canvasF.parentElement.parentElement.style.display = reads.F ? '' : 'none';
      }
    }
    if (canvasR) {
      canvasR.style.display = reads.R ? '' : 'none';
      if (canvasR.parentElement?.parentElement) {
        canvasR.parentElement.parentElement.style.display = reads.R ? '' : 'none';
      }
    }

    recomputeAnnotations();
    renderers.F.setRead(fwd);
    renderers.R.setRead(rev);

    if (fwd) parts.unshift(`${nameF} (${fwd.bases.length} bases)`);
    if (rev) parts.splice(fwd ? 1 : 0, 0, `${nameR} (${rev.bases.length} bases)`);
    if (metaEl) metaEl.textContent = parts.join(' · ');

    fitView();
    draw();
    return stats;
  }

  function parsePosHint(posVal) {
    if (typeof posVal === 'number' && Number.isFinite(posVal)) return Math.round(posVal);
    if (typeof posVal === 'string') {
      const trimmed = posVal.trim();
      if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
      const m = trimmed.match(/inbetween\s+(\d+)-(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // Jump to a base using raw 1-based read coordinates (F_ab1pos on forward,
  // or oriented R_ab1pos on reverse) mapped through colOf to the shared canvas
  // column — never consensus coordinates directly.
  function focusBase({ fPos = null, rPos = null, col = null, label = '' } = {}) {
    if (!reads.F && !reads.R) return false;
    let targetCol = Number.isFinite(col) ? col : null;

    if (targetCol === null) {
      const fIntExact = typeof fPos === 'number' || (typeof fPos === 'string' && /^\d+$/.test(fPos.trim()));
      const rIntExact = typeof rPos === 'number' || (typeof rPos === 'string' && /^\d+$/.test(rPos.trim()));
      const fp = parsePosHint(fPos);
      const rp = parsePosHint(rPos);

      if (fIntExact && fp !== null && reads.F && fp >= 1 && fp <= reads.F.bases.length) {
        targetCol = reads.F.colOf ? reads.F.colOf[fp - 1] : fp - 1;
      } else if (rIntExact && rp !== null && reads.R && rp >= 1 && rp <= reads.R.bases.length) {
        targetCol = reads.R.colOf ? reads.R.colOf[rp - 1] : rp - 1;
      } else if (fp !== null && reads.F && fp >= 1 && fp <= reads.F.bases.length) {
        targetCol = reads.F.colOf ? reads.F.colOf[fp - 1] : fp - 1;
      } else if (rp !== null && reads.R && rp >= 1 && rp <= reads.R.bases.length) {
        targetCol = reads.R.colOf ? reads.R.colOf[rp - 1] : rp - 1;
      }
    }

    if (targetCol === null || !Number.isFinite(targetCol)) return false;

    const w = activeWidth();
    const targetSpanCols = Math.min(28, Math.max(totalCols, 1));
    view.colsPerPx = targetSpanCols / w;
    clampView();
    const visible = w * view.colsPerPx;
    view.col = targetCol - visible / 2;
    clampView();
    setHighlight({ col: targetCol, label });
    draw();
    return true;
  }

  zoomInBtn?.addEventListener('click', () => zoom(1.4, 0.5));
  zoomOutBtn?.addEventListener('click', () => zoom(0.72, 0.5));
  resetBtn?.addEventListener('click', () => {
    setHighlight(null);
    fitView();
    draw();
  });
  ampSlider?.addEventListener('input', () => {
    const amp = parseFloat(ampSlider.value);
    renderers.F.setAmplitude(amp);
    renderers.R.setAmplitude(amp);
    draw();
  });

  scrollBar?.addEventListener('scroll', () => {
    if (!reads.F && !reads.R) return;
    view.col = scrollBar.scrollLeft / PX_PER_COL;
    clampView();
    draw();
  });

  function bindCanvas(canvas) {
    if (!canvas) return;
    const pointers = new Map();
    let pinchDist = 0;

    canvas.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture?.(e.pointerId);
      if (pointers.size === 2) {
        const [p1, p2] = [...pointers.values()];
        pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const curr = { x: e.clientX, y: e.clientY };

      if (pointers.size === 1) {
        const dx = curr.x - prev.x;
        pointers.set(e.pointerId, curr);
        view.col = Math.max(0, view.col - dx * view.colsPerPx);
        clampView();
        draw();
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, curr);
        const [p1, p2] = [...pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (pinchDist > 4 && d > 4) {
          const rect = canvas.getBoundingClientRect();
          const midX = (p1.x + p2.x) / 2;
          const ratio = rect.width > 0 ? (midX - rect.left) / rect.width : 0.5;
          zoom(d / pinchDist, ratio);
        }
        pinchDist = d;
      }
    });

    const releasePointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
    };
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('lostpointercapture', releasePointer);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      zoom(e.deltaY < 0 ? 1.25 : 0.8, ratio);
    }, { passive: false });
  }

  bindCanvas(canvasF);
  bindCanvas(canvasR);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { clampView(); draw(); });
  }

  return {
    setData,
    focusBase,
    clearHighlight() {
      setHighlight(null);
      draw();
    },
    setMottCutoff(val) {
      const num = parseFloat(val);
      if (!Number.isFinite(num) || num <= 0) return;
      mottCutoff = num;
      if (reads.F || reads.R) {
        recomputeAnnotations();
        draw();
      }
    },
    setSecPeakThreshold(val) {
      const num = parseFloat(val);
      if (!Number.isFinite(num) || num <= 0) return;
      secPeakThreshold = num;
      if (reads.F || reads.R) {
        recomputeAnnotations();
        draw();
      }
    },
    clear() {
      rawReads = { F: null, R: null };
      reads = { F: null, R: null };
      setHighlight(null);
      renderers.F.setRead(null);
      renderers.R.setRead(null);
      for (const c of [canvasF, canvasR]) {
        if (!c) continue;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
      }
      if (metaEl) metaEl.textContent = '';
    },
  };
}
