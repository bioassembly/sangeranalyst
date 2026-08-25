// Client-side ABIF parser + interactive chromatogram viewer.
// Parses the same tags the backend pipeline uses (DATA9-12, PLOC2, PBAS2,
// FWO_1) so the preview matches the analysis input exactly.

const CHANNEL_COLORS = { A: '#16a34a', C: '#2563eb', G: '#111827', T: '#dc2626' };

function parseABIF(buffer) {
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
    const elemType = view.getUint16(p + 8);
    const elemSize = view.getUint16(p + 10);
    const numElems = view.getUint32(p + 12);
    const dataSize = view.getUint32(p + 16);
    const dataOffset = view.getUint32(p + 20);
    entries.set(tag + number, { elemType, elemSize, numElems, dataSize, dataOffset });
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
          case 1: out.push(view.getInt8(p)); break;
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
  const qual = readValues('PQUAL', 2) || readValues('PQUAL', 1) || null;

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

function createViewer(canvas, metaEl) {
  let trace = null;
  let scale = 1;        // samples per pixel (1 = fit)
  let offset = 0;       // first visible sample
  let dpr = 1;

  function setData(data, name) {
    trace = data;
    resetView();
    if (metaEl) {
      const meanQ = data.qual && data.qual.length
        ? Math.round(data.qual.reduce((a, b) => a + b, 0) / data.qual.length)
        : null;
      metaEl.textContent = `${name} — ${data.bases.length} bases` + (meanQ !== null ? `, mean Q${meanQ}` : '');
    }
    draw();
  }

  function resetView() {
    scale = 1;
    offset = 0;
    draw();
  }

  function zoom(factor, centerRatio = 0.5) {
    const w = canvas.clientWidth;
    const visible = w * scale;
    const newScale = Math.min(trace.channels.A.length / w, Math.max(scale / factor, 0.02));
    const center = offset + centerRatio * visible;
    offset = Math.max(0, Math.min(center - centerRatio * w * newScale, trace.channels.A.length - w * newScale));
    scale = newScale;
    draw();
  }

  function draw() {
    if (!trace) return;
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padBottom = 18, padTop = 8;
    const plotH = h - padBottom - padTop;

    // Robust y-scale: 99.5th percentile of the visible window, so injection
    // spikes and single outliers don't flatten the rest of the trace.
    const from = Math.floor(offset);
    const to = Math.min(Math.ceil(offset + w * scale), trace.channels.A.length);
    const stride = Math.max(1, Math.floor((to - from) / 4000));
    const pool = [];
    for (const values of Object.values(trace.channels)) {
      for (let i = from; i < to; i += stride) {
        const v = values[i];
        if (v > 0) pool.push(v);
      }
    }
    pool.sort((a, b) => a - b);
    const maxVal = Math.max(pool.length ? pool[Math.floor(pool.length * 0.995)] : 1, 10);

    const visible = w * scale;
    const showLabels = scale < 3;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';

    for (const [base, values] of Object.entries(trace.channels)) {
      ctx.strokeStyle = CHANNEL_COLORS[base] || '#888';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let px = 0; px <= w; px++) {
        const s = Math.floor(offset + px * scale);
        if (s >= values.length) break;
        const y = padTop + plotH - (values[s] / maxVal) * plotH;
        if (!started) { ctx.moveTo(px, y); started = true; } else { ctx.lineTo(px, y); }
      }
      ctx.stroke();
    }

    if (showLabels) {
      ctx.fillStyle = '#374151';
      for (let i = 0; i < trace.ploc.length; i++) {
        const s = trace.ploc[i];
        if (s < offset || s > offset + visible) continue;
        const px = (s - offset) / scale;
        ctx.fillText(trace.bases[i], px, h - 4);
      }
    }

    ctx.fillStyle = '#9aa3b2';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(offset)} / ${trace.channels.A.length} samples`, 6, 12);
  }

  // --- interactions ---
  let dragging = false, lastX = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !trace) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    const maxOffset = trace.channels.A.length - canvas.clientWidth * scale;
    offset = Math.max(0, Math.min(offset - dx * scale, maxOffset));
    draw();
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    if (!trace) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - rect.left) / rect.width);
  }, { passive: false });

  let pinchDist = 0;
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !trace) return;
    e.preventDefault();
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (pinchDist) zoom(d / pinchDist, 0.5);
    pinchDist = d;
  }, { passive: false });
  canvas.addEventListener('touchend', () => { pinchDist = 0; });

  window.addEventListener('resize', draw);

  return { setData, zoom, resetView, draw };
}

export function attachTraceViewer({ canvas, metaEl, zoomInBtn, zoomOutBtn, resetBtn }) {
  const viewer = createViewer(canvas, metaEl);
  zoomInBtn?.addEventListener('click', () => viewer.zoom(1.4, 0.5));
  zoomOutBtn?.addEventListener('click', () => viewer.zoom(0.72, 0.5));
  resetBtn?.addEventListener('click', () => viewer.resetView());

  return {
    async load(file, name) {
      const buf = await file.arrayBuffer();
      const data = parseABIF(buf);
      viewer.setData(data, name || file.name);
      return data;
    },
    clear() {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (metaEl) metaEl.textContent = '';
    },
  };
}
