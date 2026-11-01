// --- CONFIG ---
// Local dev (page served from localhost/127.0.0.1) targets a local backend on :8000;
// anything else (including GitHub Pages) uses the production PythonAnywhere API.
const BACKEND_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://127.0.0.1:8000/process'
  : 'https://shiddharta.pythonanywhere.com/process';

import { attachTraceViewer, parseABIF } from './traceviewer.js';
import {
  extractCleanFasta,
  renderReportHtml,
  buildSummaryFromOutputs,
  classifyAb1Pair,
  wrapFastaSeq,
} from './sequtils.js';

const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mldawblv';
const BASE = document.documentElement.dataset.base || '/';
const AB1_RE = /\.ab1$/i;
const MAX_INPUT_BYTES = 5_000_000;

// ==================== SETTINGS PERSISTENCE ===================
const SETTINGS_KEY = 'sangeranalyst-settings';
const mottInput = document.getElementById('mottCutoff');
const qPhredInput = document.getElementById('qPhred');
const secPeakInput = document.getElementById('secPeak');
const settingInputs = [mottInput, qPhredInput, secPeakInput];

function clampNumericInput(input, fallback) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const v = parseFloat(input.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, min), max);
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const input of settingInputs) {
      const v = saved[input.id];
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      input.value = Math.min(Math.max(v, parseFloat(input.min)), parseFloat(input.max));
    }
  } catch { /* corrupted or unavailable storage — keep defaults */ }
}

function saveSettings() {
  try {
    const data = {};
    for (const input of settingInputs) {
      const val = parseFloat(input.value);
      if (Number.isFinite(val)) data[input.id] = val;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch { /* storage unavailable */ }
}

loadSettings();
settingInputs.forEach(input => input.addEventListener('change', saveSettings));

// ==================== TOGGLE UPLOAD / PASTE PRIMER MODE ===================
function setPrimerMode(target, mode) {
  const fileInput = document.getElementById(`primer${target}-file`);
  const textInput = document.getElementById(`primer${target}-text`);
  const label = document.getElementById(`primer${target}-label`);
  const btn = document.querySelector(`.toggle-btn[data-target="${target}"]`);
  if (!fileInput || !textInput) return;

  if (mode === 'text') {
    fileInput.style.display = 'none';
    textInput.style.display = 'block';
    fileInput.value = '';
    if (label) label.htmlFor = `primer${target}-text`;
    if (btn) btn.textContent = '📁';
  } else {
    fileInput.style.display = 'block';
    textInput.style.display = 'none';
    textInput.value = '';
    if (label) label.htmlFor = `primer${target}-file`;
    if (btn) btn.textContent = '✍';
  }
}

function isPrimerFileMode(target) {
  const fileInput = document.getElementById(`primer${target}-file`);
  return Boolean(fileInput && fileInput.style.display !== 'none');
}

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    setPrimerMode(target, isPrimerFileMode(target) ? 'text' : 'file');
  });
});

document.querySelectorAll('.reset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    document.getElementById(`primer${target}-file`).value = '';
    document.getElementById(`primer${target}-text`).value = '';
  });
});

// ==================== STATUS HELPERS ===================
const statusEl = document.getElementById('status');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#b91c1c' : '';
  statusEl.style.fontWeight = isError ? '600' : '';
}

// ==================== TOOLTIP HANDLER (TOGGLE) ===================
const tooltipPairs = [
  [document.getElementById('mottInfoBtn'), document.getElementById('m_tooltip')],
  [document.getElementById('qPhredInfoBtn'), document.getElementById('q_tooltip')],
  [document.getElementById('secPeakInfoBtn'), document.getElementById('sec_tooltip')],
];

function hideTooltips() {
  for (const [btn, tip] of tooltipPairs) {
    tip.style.display = 'none';
    tip.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
  }
}

function toggleTooltip(btn, tip) {
  const isVisible = tip.style.display === 'block';
  hideTooltips();
  if (!isVisible) {
    const rect = btn.getBoundingClientRect();
    tip.style.display = 'block';
    tip.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    const tooltipWidth = tip.offsetWidth || tip.clientWidth || 220;
    const rawLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - tooltipWidth - 8));
    tip.style.left = `${clampedLeft + window.scrollX}px`;
    tip.style.top = `${rect.bottom + 8 + window.scrollY}px`;
  }
}

for (const [btn, tip] of tooltipPairs) {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleTooltip(btn, tip);
  });
  tip.addEventListener('click', (ev) => ev.stopPropagation());
}

document.addEventListener('click', hideTooltips);
window.addEventListener('scroll', hideTooltips, { passive: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltips(); });

// ==================== SEQUENCE VALIDATION ====================
function cleanAndValidateDNA(seq, minLen = 3) {
  if (!seq) return null;
  const cleaned = seq
    .replace(/^>.*$/gm, '')
    .replace(/[\s0-9]/g, '')
    .toUpperCase();
  if (!/^[ATGCNRYKMSWBDHV]+$/.test(cleaned)) return null;
  if (cleaned.length < minLen) return null;
  return cleaned;
}

// ==================== CHROMATOGRAM TRACE VIEWER ===================
const traceSection = document.getElementById('traceSection');
const traceMeta = document.getElementById('traceMeta');
const traceFocusPill = document.getElementById('traceFocusPill');

const traceViewer = attachTraceViewer({
  canvasF: document.getElementById('traceCanvasF'),
  canvasR: document.getElementById('traceCanvasR'),
  metaEl: traceMeta,
  zoomInBtn: document.getElementById('traceZoomIn'),
  zoomOutBtn: document.getElementById('traceZoomOut'),
  resetBtn: document.getElementById('traceReset'),
  ampSlider: document.getElementById('traceAmp'),
  scrollBar: document.getElementById('traceScrollBar'),
  onFocusChange(focus) {
    if (!traceFocusPill) return;
    if (!focus || !focus.label) {
      traceFocusPill.style.display = 'none';
      traceFocusPill.textContent = '';
    } else {
      traceFocusPill.textContent = `Inspecting: ${focus.label}`;
      traceFocusPill.style.display = 'inline-flex';
    }
  },
});

// Sync initial and live Mott / Secondary-peak parameters with the trace preview
traceViewer.setMottCutoff(clampNumericInput(mottInput, 0.1));
traceViewer.setSecPeakThreshold(clampNumericInput(secPeakInput, 33));

mottInput.addEventListener('input', () => {
  const v = parseFloat(mottInput.value);
  if (Number.isFinite(v) && v >= 0.001 && v <= 1) traceViewer.setMottCutoff(v);
});
secPeakInput.addEventListener('input', () => {
  const v = parseFloat(secPeakInput.value);
  if (Number.isFinite(v) && v >= 1 && v <= 100) traceViewer.setSecPeakThreshold(v);
});

const traceFiles = { F: null, R: null };
let traceRefreshGen = 0;

function setInlineError(inputId, msg) {
  let el = document.getElementById(inputId + 'Err');
  if (!msg) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = inputId + 'Err';
    el.className = 'file-err';
    el.setAttribute('role', 'alert');
    document.getElementById(inputId).after(el);
  }
  el.textContent = msg;
}

async function refreshTraces() {
  const myGen = ++traceRefreshGen;
  const f = traceFiles.F, r = traceFiles.R;
  if (!f && !r) {
    traceViewer.clear();
    traceSection.style.display = 'none';
    return;
  }

  let fwd = null, rev = null;
  const notes = [];
  if (f) {
    try { fwd = parseABIF(await f.arrayBuffer()); }
    catch { notes.push(`"${f.name}" is not a valid ABIF chromatogram`); }
  }
  if (r) {
    try { rev = parseABIF(await r.arrayBuffer()); }
    catch { notes.push(`"${r.name}" is not a valid ABIF chromatogram`); }
  }
  if (myGen !== traceRefreshGen) return;

  traceSection.style.display = 'block';
  const overlapStats = traceViewer.setData(fwd, rev, f?.name ?? '', r?.name ?? '');

  const labelR = document.getElementById('traceLabelR');
  if (rev && overlapStats?.revComplemented) {
    labelR.textContent = 'Reverse (reverse-complemented)';
  } else if (rev && overlapStats?.orientation === 'raw') {
    labelR.textContent = 'Reverse (already in forward orientation)';
  } else {
    labelR.textContent = 'Reverse';
  }

  const warn = document.getElementById('traceWarn');
  if (overlapStats && typeof overlapStats.identity === 'number' && overlapStats.identity < 0.7) {
    warn.textContent = 'Low identity — these reads may not be from the same template.';
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
  if (notes.length) {
    traceMeta.textContent = (traceMeta.textContent ? traceMeta.textContent + ' · ' : '') + notes.join(' · ');
  }
}

async function validateAb1Field(inputId, which, triggerRefresh = true) {
  const file = document.getElementById(inputId).files[0];
  traceFiles[which] = file || null;
  setInlineError(inputId, null);
  if (file) {
    if (file.size > MAX_INPUT_BYTES) {
      setInlineError(inputId, 'File is larger than 5 MB.');
    } else {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const magic = String.fromCharCode(...head);
      if (magic !== 'ABIF') {
        setInlineError(inputId, 'This does not look like an ABIF chromatogram (missing ABIF signature).');
      }
    }
  }
  if (triggerRefresh) await refreshTraces();
}

function setInputFile(input, file) {
  const dt = new DataTransfer();
  if (file) dt.items.add(file);
  input.files = dt.files;
}

document.getElementById('fileF').addEventListener('change', () => validateAb1Field('fileF', 'F'));
document.getElementById('fileR').addEventListener('change', () => validateAb1Field('fileR', 'R'));

// ==================== SWAP READS & DRAG-AND-DROP PAIRING ===================
const swapReadsBtn = document.getElementById('swapReadsBtn');
swapReadsBtn?.addEventListener('click', async () => {
  const inputF = document.getElementById('fileF');
  const inputR = document.getElementById('fileR');
  const curF = inputF.files[0] || null;
  const curR = inputR.files[0] || null;
  if (!curF && !curR) return;
  setInputFile(inputF, curR);
  setInputFile(inputR, curF);
  await validateAb1Field('fileF', 'F', false);
  await validateAb1Field('fileR', 'R', false);
  await refreshTraces();
  setStatus('Swapped Forward and Reverse reads.');
});

const uploadSection = document.getElementById('uploadSection');
let dragDepth = 0;

uploadSection?.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  uploadSection.classList.add('drag-active');
});
uploadSection?.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
});
uploadSection?.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) uploadSection.classList.remove('drag-active');
});
uploadSection?.addEventListener('drop', async (e) => {
  dragDepth = 0;
  uploadSection.classList.remove('drag-active');
  const dropped = [...(e.dataTransfer?.files || [])];
  if (!dropped.length) return;

  const ab1Files = dropped.filter(f => AB1_RE.test(f.name));
  if (!ab1Files.length) return; // allow native drop if not .ab1
  e.preventDefault();

  const targetZoneR = e.target.closest?.('#dropZoneR');
  const targetZoneF = e.target.closest?.('#dropZoneF');
  const inputF = document.getElementById('fileF');
  const inputR = document.getElementById('fileR');

  if (ab1Files.length === 1) {
    const single = ab1Files[0];
    if (targetZoneR) {
      setInputFile(inputR, single);
    } else if (targetZoneF) {
      setInputFile(inputF, single);
    } else {
      const guessed = classifyAb1Pair(ab1Files);
      if (guessed.fileR && !inputR.files[0]) setInputFile(inputR, single);
      else if (!inputF.files[0]) setInputFile(inputF, single);
      else setInputFile(inputR, single);
    }
  } else {
    const { fileF, fileR } = classifyAb1Pair(ab1Files);
    if (fileF) setInputFile(inputF, fileF);
    if (fileR) setInputFile(inputR, fileR);
  }

  await validateAb1Field('fileF', 'F', false);
  await validateAb1Field('fileR', 'R', false);
  await refreshTraces();
  setStatus(ab1Files.length >= 2
    ? `Paired "${inputF.files[0]?.name || ''}" (F) and "${inputR.files[0]?.name || ''}" (R).`
    : `Loaded "${ab1Files[0].name}".`);
});

// ==================== SEQUENCE & SUMMARY RENDERING ===================
function renderSeq(el, text) {
  if (!text || text === '—' || text === '-') {
    el.textContent = '—';
    return;
  }
  el.innerHTML = renderReportHtml(text);
}

let currentSummary = null;
const summaryCard = document.getElementById('summaryCard');
const summaryMetricsEl = document.getElementById('summaryMetrics');
const orfStripEl = document.getElementById('orfStrip');
const orfMetaEl = document.getElementById('orfMeta');
const orfSeqPreviewEl = document.getElementById('orfSeqPreview');
const inspectorStripEl = document.getElementById('inspectorStrip');

function jumpToTracePosition(spec) {
  if (traceSection.style.display === 'none') return;
  const ok = traceViewer.focusBase(spec);
  if (ok) {
    traceSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderSummaryDashboard(summary) {
  currentSummary = summary;
  if (!summaryCard || !summary) {
    if (summaryCard) summaryCard.style.display = 'none';
    return;
  }

  summaryMetricsEl.innerHTML = '';
  const addMetric = (label, value, sub = '', tone = '') => {
    const tile = document.createElement('div');
    tile.className = `summary-tile${tone ? ' ' + tone : ''}`;
    const lbl = document.createElement('div');
    lbl.className = 'summary-tile-label';
    lbl.textContent = label;
    const val = document.createElement('div');
    val.className = 'summary-tile-val';
    val.textContent = value;
    tile.append(lbl, val);
    if (sub) {
      const subEl = document.createElement('div');
      subEl.className = 'summary-tile-sub';
      subEl.textContent = sub;
      tile.append(subEl);
    }
    summaryMetricsEl.append(tile);
  };

  if (summary.overlap_passed && summary.overlap_len > 0) {
    const pct = (summary.overlap_identity * 100).toFixed(1);
    addMetric('Validated Overlap', `${summary.overlap_len} bp`, `${pct}% identity`, 'tile-ok');
  } else {
    addMetric('Validated Overlap', 'None', 'Failed significance gate', 'tile-warn');
  }

  const lenSub = summary.primer_trim_len !== null && summary.primer_trim_len !== undefined
    ? `Full ${summary.full_len} bp · Trimmed ${summary.primer_trim_len} bp`
    : `Full Merge ${summary.full_len} bp`;
  addMetric('High-Conf Length', `${summary.strict_len} bp`, lenSub);

  addMetric('GC Content', `${summary.gc_percent}%`, `${summary.primary_label} sequence`);

  const nCount = summary.strict_len > 0 ? summary.strict_n_count : summary.full_n_count;
  const qualTone = summary.ambiguous_count > 0 ? 'tile-iupac' : '';
  addMetric(
    'Variant & Quality Calls',
    `${summary.conflict_count} conflict${summary.conflict_count === 1 ? '' : 's'}`,
    `${summary.ambiguous_count} IUPAC · ${nCount} N`,
    qualTone
  );

  // Longest ORF strip
  const orf = summary.longest_orf;
  if (orf && orf.aa_len >= 10) {
    const preview = orf.aa_seq.length > 38 ? `${orf.aa_seq.slice(0, 38)}…` : orf.aa_seq;
    const atgNote = orf.has_atg ? ' · contains ATG' : '';
    orfMetaEl.textContent = `Longest frame ${orf.frame}: ${orf.aa_len} aa (${orf.start}–${orf.end} nt${atgNote})`;
    orfSeqPreviewEl.textContent = preview;
    orfStripEl.style.display = 'flex';
  } else {
    orfStripEl.style.display = 'none';
  }

  // Interactive Conflict & Secondary Peak Inspector
  inspectorStripEl.innerHTML = '';
  const conflicts = Array.isArray(summary.conflicts) ? summary.conflicts : [];
  const spFwd = summary.secondary_peaks?.fwd || [];
  const spRev = summary.secondary_peaks?.rev || [];

  if (conflicts.length === 0 && spFwd.length === 0 && spRev.length === 0) {
    const clean = document.createElement('div');
    clean.className = 'inspector-clean';
    clean.textContent = summary.overlap_passed
      ? '✓ Clean overlap — 0 conflicts and 0 secondary peaks in the high-confidence region.'
      : 'No high-confidence overlap sites to inspect.';
    inspectorStripEl.append(clean);
  } else {
    const caption = document.createElement('div');
    caption.className = 'inspector-caption';
    caption.textContent = 'Click any site below to jump to its exact peak on the chromatogram preview:';
    const pillWrap = document.createElement('div');
    pillWrap.className = 'inspector-pills';

    const iupacCodes = new Set(['R', 'Y', 'K', 'M', 'S', 'W', 'B', 'D', 'H', 'V']);
    for (const c of conflicts.slice(0, 40)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isHet = iupacCodes.has(c.using_seq);
      btn.className = `inspector-pill ${isHet ? 'pill-het' : 'pill-conflict'}`;
      const label = `Pos ${c.position}: ${c.F_seq}/${c.R_seq} → ${c.using_seq}`;
      btn.textContent = label;
      btn.title = `Forward pos: ${c.F_ab1pos} (Q=${c.F_phred}) · Reverse RC pos: ${c.R_ab1pos} (Q=${c.R_phred})`;
      btn.addEventListener('click', () => {
        jumpToTracePosition({ fPos: c.F_ab1pos, rPos: c.R_ab1pos, label });
      });
      pillWrap.append(btn);
    }

    for (const p of spFwd.slice(0, 20)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inspector-pill pill-peak';
      const label = `F:${p.position} 2° ${p.primary_base}/${p.secondary_base} (${Math.round(p.percentage)}%)`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        jumpToTracePosition({ fPos: p.position, label });
      });
      pillWrap.append(btn);
    }

    for (const p of spRev.slice(0, 20)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inspector-pill pill-peak';
      const label = `R:${p.position} 2° ${p.primary_base}/${p.secondary_base} (${Math.round(p.percentage)}%)`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        jumpToTracePosition({ rPos: p.position, label });
      });
      pillWrap.append(btn);
    }

    inspectorStripEl.append(caption, pillWrap);
  }

  const blastBtn = document.getElementById('blastConsensusBtn');
  if (blastBtn) {
    blastBtn.disabled = !summary.primary_seq;
  }
  summaryCard.style.display = 'block';
}

document.getElementById('copyOrfBtn')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const orf = currentSummary?.longest_orf;
  if (!orf?.aa_seq) return;
  const sample = getSampleSlug();
  const fasta = `>${sample}_ORF_frame${orf.frame}_${orf.aa_len}aa\n${wrapFastaSeq(orf.aa_seq, 60)}\n`;
  flashCopied(btn, fasta);
});

document.getElementById('blastConsensusBtn')?.addEventListener('click', () => {
  const seq = currentSummary?.primary_seq;
  if (!seq) return;
  const sample = getSampleSlug();
  const query = `>${sample}_${currentSummary.primary_label.replace(/\s+/g, '_')}\n${seq.slice(0, 6500)}`;
  const url = `https://blast.ncbi.nlm.nih.gov/Blast.cgi?PROGRAM=blastn&PAGE_TYPE=BlastSearch&LINK_LOC=blasthome&QUERY=${encodeURIComponent(query)}`;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ==================== ANALYZE HANDLER ===================
const analyzeBtn = document.getElementById('analyzeBtn');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const resultsBox = document.getElementById('results');
const strictEl = document.getElementById('strict');
const fullEl = document.getElementById('full');
const primerEl = document.getElementById('primerTrim');
const primerBlock = document.getElementById('primerResultBlock');

async function validatePrimerFile(file, label) {
  if (file.size > MAX_INPUT_BYTES) {
    setStatus(`Input too large (${label} primer > 5 MB).`, true);
    alert(`The ${label} primer file "${file.name}" exceeds the 5 MB limit.`);
    return false;
  }
  const text = await file.text();
  if (!cleanAndValidateDNA(text, 10)) {
    setStatus(`Invalid ${label} primer file.`, true);
    alert(`Invalid ${label} primer file "${file.name}": use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).`);
    return false;
  }
  return true;
}

function setBusyState(busy) {
  analyzeBtn.disabled = busy;
  if (loadDemoBtn) loadDemoBtn.disabled = busy;
}

analyzeBtn.addEventListener('click', async () => {
  setBusyState(true);
  setStatus('');
  const fF = document.getElementById('fileF').files[0];
  const fR = document.getElementById('fileR').files[0];
  const loading = document.getElementById('loading');

  // Respect active primer input mode so hidden text never overrides a chosen file
  let pF = null, pR = null;
  if (isPrimerFileMode('F')) {
    pF = document.getElementById('primerF-file').files[0] || null;
  } else {
    const rawF = document.getElementById('primerF-text').value;
    if (rawF.length > MAX_INPUT_BYTES) {
      setStatus('Input too large.', true);
      alert('Files or input text are too large, max 5 MB (or 5M characters) per input.');
      setBusyState(false);
      return;
    }
    if (rawF.trim() !== '') {
      const cleaned = cleanAndValidateDNA(rawF, 10);
      if (!cleaned) {
        setStatus('Invalid forward primer sequence.', true);
        alert('Invalid Forward primer: use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).');
        setBusyState(false);
        return;
      }
      pF = cleaned;
      document.getElementById('primerF-text').value = cleaned;
    }
  }

  if (isPrimerFileMode('R')) {
    pR = document.getElementById('primerR-file').files[0] || null;
  } else {
    const rawR = document.getElementById('primerR-text').value;
    if (rawR.length > MAX_INPUT_BYTES) {
      setStatus('Input too large.', true);
      alert('Files or input text are too large, max 5 MB (or 5M characters) per input.');
      setBusyState(false);
      return;
    }
    if (rawR.trim() !== '') {
      const cleaned = cleanAndValidateDNA(rawR, 10);
      if (!cleaned) {
        setStatus('Invalid reverse primer sequence.', true);
        alert('Invalid Reverse primer: use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).');
        setBusyState(false);
        return;
      }
      pR = cleaned;
      document.getElementById('primerR-text').value = cleaned;
    }
  }

  if (!fF || !fR) {
    setStatus('Please provide both .ab1 files.', true);
    alert('Please upload both forward and reverse .ab1 files.');
    setBusyState(false);
    return;
  }
  if (!AB1_RE.test(fF.name) || !AB1_RE.test(fR.name)) {
    setStatus('Reads must be .ab1 chromatogram files.', true);
    alert('Both reads must be .ab1 files (check you did not swap in another format).');
    setBusyState(false);
    return;
  }
  if (fF.size > MAX_INPUT_BYTES || fR.size > MAX_INPUT_BYTES) {
    setStatus('Input too large.', true);
    alert('Files or input text are too large, max 5 MB (or 5M characters) per input.');
    setBusyState(false);
    return;
  }
  if (pF instanceof File && !(await validatePrimerFile(pF, 'forward'))) {
    setBusyState(false);
    return;
  }
  if (pR instanceof File && !(await validatePrimerFile(pR, 'reverse'))) {
    setBusyState(false);
    return;
  }

  const mott = clampNumericInput(mottInput, 0.1);
  const mphred = Math.round(clampNumericInput(qPhredInput, 20));
  const secPeak = Math.round(clampNumericInput(secPeakInput, 33));
  mottInput.value = mott;
  qPhredInput.value = mphred;
  secPeakInput.value = secPeak;
  saveSettings();

  loading.style.display = 'block';
  primerEl.scrollTop = 0;
  strictEl.scrollTop = 0;
  fullEl.scrollTop = 0;
  primerBlock.style.display = 'none';
  resultsBox.style.display = 'none';
  if (summaryCard) summaryCard.style.display = 'none';
  document.getElementById('server-warn')?.remove();
  primerEl.textContent = '—';
  strictEl.textContent = '—';
  fullEl.textContent = '—';
  setStatus('Analyzing…');

  const form = new FormData();
  form.append('fileF', fF);
  form.append('fileR', fR);
  if (pF) form.append('primerF', pF);
  if (pR) form.append('primerR', pR);
  form.append('mottCutoff', String(mott));
  form.append('minPhred', String(mphred));
  form.append('secondary_peak_threshold', String(secPeak));

  let timeoutId;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(BACKEND_URL, { method: 'POST', body: form, signal: controller.signal });
    if (!resp.ok) {
      let msg = 'Server returned ' + resp.status;
      try {
        const errBody = await resp.json();
        if (errBody && errBody.error) msg = errBody.error;
      } catch { /* non-JSON error page */ }
      if (resp.status === 413) msg = 'Upload too large — the server accepts at most 20 MB per request.';
      if (resp.status === 500) msg = 'Analysis failed on the server. Double-check your chromatogram files and try again.';
      const e = new Error(msg);
      e.displayMessage = msg;
      throw e;
    }
    const data = await resp.json();
    const outputs = data.outputs || {};

    if (Array.isArray(data.warnings) && data.warnings.length) {
      const banner = document.createElement('div');
      banner.id = 'server-warn';
      banner.className = 'server-warn';
      banner.setAttribute('role', 'alert');
      banner.textContent = data.warnings.join('\n');
      resultsBox.prepend(banner);
    }

    renderSeq(strictEl, outputs.consensus_strict || '—');
    renderSeq(fullEl, outputs.consensus_full || '—');
    if (outputs.primer_trim) {
      renderSeq(primerEl, outputs.primer_trim);
      primerBlock.style.display = 'block';
    } else {
      primerBlock.style.display = 'none';
      primerEl.textContent = '—';
    }

    const summary = buildSummaryFromOutputs(outputs, data.summary || null);
    renderSummaryDashboard(summary);

    resultsBox.style.display = 'block';
    setStatus('Analysis complete.');
  } catch (err) {
    console.error(err);
    resultsBox.style.display = 'none';
    if (err.name === 'AbortError') {
      setStatus('Error: the server took longer than 60 s to respond. Try again shortly.', true);
    } else if (err instanceof TypeError) {
      setStatus('Error: could not reach the analysis server. Check your connection or try again later.', true);
    } else {
      setStatus('Error: ' + (err.displayMessage || err.message || err), true);
    }
  } finally {
    clearTimeout(timeoutId);
    loading.style.display = 'none';
    setBusyState(false);
  }
});

// ==================== DEMO DATA LOADER ===================
loadDemoBtn?.addEventListener('click', async () => {
  setBusyState(true);
  try {
    const [fwdResp, revResp, pFwdResp, pRevResp] = await Promise.all([
      fetch(`${BASE}demo/fwd_control.ab1`),
      fetch(`${BASE}demo/rev_control.ab1`),
      fetch(`${BASE}demo/primer_fwd.fasta`),
      fetch(`${BASE}demo/primer_rev.fasta`),
    ]);
    if (!fwdResp.ok || !revResp.ok || !pFwdResp.ok || !pRevResp.ok) {
      throw new Error('Demo assets returned non-200 status');
    }
    const [fwd, rev, pFwd, pRev] = await Promise.all([
      fwdResp.blob(),
      revResp.blob(),
      pFwdResp.text(),
      pRevResp.text(),
    ]);

    setInputFile(document.getElementById('fileF'), new File([fwd], 'fwd_control.ab1', { type: 'application/octet-stream' }));
    setInputFile(document.getElementById('fileR'), new File([rev], 'rev_control.ab1', { type: 'application/octet-stream' }));
    await validateAb1Field('fileF', 'F', false);
    await validateAb1Field('fileR', 'R', false);
    await refreshTraces();

    // Ensure primer inputs are in text mode before populating demo primers
    setPrimerMode('F', 'text');
    setPrimerMode('R', 'text');
    const pFwdClean = cleanAndValidateDNA(pFwd, 10);
    const pRevClean = cleanAndValidateDNA(pRev, 10);
    if (pFwdClean) document.getElementById('primerF-text').value = pFwdClean;
    if (pRevClean) document.getElementById('primerR-text').value = pRevClean;

    setStatus('Demo dataset loaded (cane toad tyrosinase control). Press Analyze.');
  } catch (err) {
    console.error(err);
    setStatus('Could not load demo files.', true);
  } finally {
    setBusyState(false);
  }
});

// ==================== COPY & DOWNLOAD CONTROLS ===================
const RESULT_LABELS = {
  strict: 'high-confidence-consensus',
  full: 'full-merge',
  primerTrim: 'primer-trimmed-consensus',
};

function getSampleSlug() {
  return (document.getElementById('fileF').files[0]?.name || 'sample')
    .replace(/\.ab1$/i, '')
    .replace(/[^\w.-]+/g, '_');
}

function flashCopied(btn, textToCopy) {
  const originalHTML = btn.dataset.origHtml || btn.innerHTML;
  btn.dataset.origHtml = originalHTML;
  navigator.clipboard.writeText(textToCopy).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = originalHTML; }, 1200);
  }).catch((err) => {
    console.error('Failed to copy: ', err);
  });
}

function triggerTextDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Clean FASTA Copy / Download (strict >Header + sequence only — BLAST/SnapGene ready)
document.querySelectorAll('.copy-fasta-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const raw = document.getElementById(id)?.innerText.trim() || '';
    const { fasta } = extractCleanFasta(raw, `${getSampleSlug()}_${RESULT_LABELS[id] ?? id}`);
    if (!fasta) {
      setStatus('No sequence available in this block to copy as FASTA.', true);
      return;
    }
    flashCopied(btn, fasta);
  });
});

document.querySelectorAll('.download-fasta-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const raw = document.getElementById(id)?.innerText.trim() || '';
    const sample = getSampleSlug();
    const { fasta } = extractCleanFasta(raw, `${sample}_${RESULT_LABELS[id] ?? id}`);
    if (!fasta) {
      setStatus('No sequence available in this block to download as FASTA.', true);
      return;
    }
    triggerTextDownload(fasta, `SangerAnalyst-${sample}-${RESULT_LABELS[id] ?? id}.fasta`);
  });
});

// Full Report Copy / Download (.txt)
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const text = document.getElementById(id)?.innerText.trim() || '';
    if (!text || text === '—' || text === '-') return;
    flashCopied(btn, text);
  });
});

document.querySelectorAll('.download-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const content = document.getElementById(id)?.innerText.trim() || '';
    if (!content || content === '—' || content === '-') return;
    const sample = getSampleSlug();
    triggerTextDownload(content, `SangerAnalyst-${sample}-${RESULT_LABELS[id] ?? id}.txt`);
  });
});

// ==================== MODALS (FEEDBACK, SUPPORT, DANA QR) ===================
const reportLink = document.getElementById('reportLink');
const overlay = document.getElementById('overlay');
const backdrop = document.getElementById('backdrop');
const modalBox = document.getElementById('modalBox');
const modalClose = document.getElementById('modalClose');
const sendBtn = document.getElementById('sendFeedbackBtn');
const fbForm = document.getElementById('feedbackForm');

function openModal() {
  overlay.classList.add('show');
  backdrop.classList.add('show');
  modalBox.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  modalClose.focus();
}
function closeModal() {
  modalBox.classList.remove('show');
  backdrop.classList.remove('show');
  setTimeout(() => { overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true'); }, 220);
}

reportLink.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
backdrop.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) closeModal(); });

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';

  const name = document.getElementById('fb_name').value || '';
  const email = document.getElementById('fb_email').value || '';
  const message = document.getElementById('fb_message').value || '';

  if (!message.trim()) {
    alert('Please enter a message.');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    return;
  }

  try {
    const payload = new FormData();
    payload.append('name', name);
    payload.append('email', email);
    payload.append('message', message);

    const resp = await fetch(FORMSPREE_ENDPOINT, { method: 'POST', body: payload, headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('Failed to send feedback.');
    await resp.json();
    closeModal();
    showSentPopup();
    fbForm.reset();
  } catch (err) {
    console.error(err);
    alert('Failed to send feedback.');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
});

const sentPopup = document.getElementById('sentPopup');
const sentClose = document.getElementById('sentClose');
let hideTimeout;

function showSentPopup() {
  sentPopup.setAttribute('aria-hidden', 'false');
  sentPopup.classList.add('show');
  hideTimeout = setTimeout(hideSentPopup, 3000);
  sentClose.onclick = () => {
    clearTimeout(hideTimeout);
    hideSentPopup();
  };
}
function hideSentPopup() {
  sentPopup.classList.remove('show');
  sentPopup.setAttribute('aria-hidden', 'true');
}

const supportLink = document.getElementById('supportLink');
const supportOverlay = document.getElementById('supportOverlay');
const supportBackdrop = document.getElementById('supportBackdrop');
const supportModalBox = document.getElementById('supportModalBox');
const supportClose = document.getElementById('supportClose');

function openSupportModal() {
  supportOverlay.classList.add('show');
  supportBackdrop.classList.add('show');
  supportModalBox.classList.add('show');
  supportOverlay.setAttribute('aria-hidden', 'false');
  supportClose.focus();
}

function closeSupportModal() {
  supportModalBox.classList.remove('show');
  supportBackdrop.classList.remove('show');
  setTimeout(() => {
    supportOverlay.classList.remove('show');
    supportOverlay.setAttribute('aria-hidden', 'true');
  }, 220);
}

supportLink.addEventListener('click', openSupportModal);
supportClose.addEventListener('click', closeSupportModal);
supportBackdrop.addEventListener('click', closeSupportModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && supportOverlay.classList.contains('show')) closeSupportModal();
});

const openDanaQR = document.getElementById('openDanaQR');
const danaOverlay = document.getElementById('danaOverlay');
const danaBackdrop = document.getElementById('danaBackdrop');
const danaModalBox = document.getElementById('danaModalBox');
const danaClose = document.getElementById('danaClose');

function openDanaModal() {
  if (supportOverlay.classList.contains('show')) {
    supportModalBox.classList.remove('show');
    supportBackdrop.classList.remove('show');
    supportOverlay.classList.remove('show');
    supportOverlay.setAttribute('aria-hidden', 'true');
  }
  danaOverlay.classList.add('show');
  danaBackdrop.classList.add('show');
  danaModalBox.classList.add('show');
  danaOverlay.setAttribute('aria-hidden', 'false');
  danaClose?.focus();
}

function closeDanaModal() {
  danaModalBox.classList.remove('show');
  danaBackdrop.classList.remove('show');
  setTimeout(() => {
    danaOverlay.classList.remove('show');
    danaOverlay.setAttribute('aria-hidden', 'true');
    supportLink?.focus();
  }, 220);
}

openDanaQR?.addEventListener('click', (e) => {
  e.preventDefault();
  openDanaModal();
});
danaClose?.addEventListener('click', closeDanaModal);
danaBackdrop?.addEventListener('click', closeDanaModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && danaOverlay?.classList.contains('show')) closeDanaModal();
});

const modalContainers = [modalBox, supportModalBox, danaModalBox];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const open = modalContainers.find(m => m?.classList.contains('show'));
  if (!open) return;
  const focusables = open.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

window.addEventListener('resize', hideTooltips);

overlay.addEventListener('transitionend', () => {
  if (!overlay.classList.contains('show')) reportLink.focus();
});

supportOverlay.addEventListener('transitionend', () => {
  if (!supportOverlay.classList.contains('show') && !danaOverlay?.classList.contains('show')) {
    supportLink.focus();
  }
});
