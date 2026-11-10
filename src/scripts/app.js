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
  classifyAb1Pair,
  normalizePrimer,
} from './sequtils.js';
import { createRunState, sampleSlug, createAnalysisExport } from './runstate.js';

const runState = createRunState();
let busy = false;

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
  invalidateResults();

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
    invalidateResults();
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
// ==================== CHROMATOGRAM TRACE VIEWER ===================
const traceSection = document.getElementById('traceSection');
const traceMeta = document.getElementById('traceMeta');

const traceViewer = attachTraceViewer({
  canvasF: document.getElementById('traceCanvasF'),
  canvasR: document.getElementById('traceCanvasR'),
  metaEl: traceMeta,
  zoomInBtn: document.getElementById('traceZoomIn'),
  zoomOutBtn: document.getElementById('traceZoomOut'),
  resetBtn: document.getElementById('traceReset'),
  ampSlider: document.getElementById('traceAmp'),
  scrollBar: document.getElementById('traceScrollBar'),

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
  invalidateResults();
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
  if (busy) return;
  setBusyState(true);
  try {
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
  } finally { setBusyState(false); setResultActions(runState.isFresh()); }
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
  if (busy) { e.preventDefault(); return; }
  const dropped = [...(e.dataTransfer?.files || [])];
  if (!dropped.length) return;

  const ab1Files = dropped.filter(f => AB1_RE.test(f.name));
  if (!ab1Files.length) return; // allow native drop if not .ab1
  e.preventDefault();
  setBusyState(true);
  try {

    const targetZoneR = e.target.closest?.('#dropZoneR');
    const targetZoneF = e.target.closest?.('#dropZoneF');
    const inputF = document.getElementById('fileF');
    const inputR = document.getElementById('fileR');

    if (ab1Files.length > 2) {
      setStatus('Use one read pair at a time. Select a Forward and Reverse file explicitly.', true);
      return;
    }
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
      const { fileF, fileR, ambiguous } = classifyAb1Pair(ab1Files);
      if (ambiguous) {
        setStatus('Could not determine read directions. Drop each file into its Forward or Reverse slot.', true);
        return;
      }
      if (fileF) setInputFile(inputF, fileF);
      if (fileR) setInputFile(inputR, fileR);
    }

    await validateAb1Field('fileF', 'F', false);
    await validateAb1Field('fileR', 'R', false);
    await refreshTraces();
    setStatus(ab1Files.length >= 2
      ? `Paired "${inputF.files[0]?.name || ''}" (F) and "${inputR.files[0]?.name || ''}" (R).`
      : `Loaded "${ab1Files[0].name}".`);
  } finally { setBusyState(false); setResultActions(runState.isFresh()); }
});

// ==================== ANALYSIS STATE & OUTPUTS ===================
const analyzeBtn = document.getElementById('analyzeBtn');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const resultsBox = document.getElementById('results');
const loading = document.getElementById('loading');
const RESULT_LABELS = {
  strict: 'high-confidence-consensus', full: 'full-merge', primerTrim: 'primer-trimmed-consensus',
};
const OUTPUT_KEYS = { strict: 'consensus_strict', full: 'consensus_full', primerTrim: 'primer_trim' };

function invalidateResults() {
  const hadResult = runState.result !== null;
  runState.invalidate();
  if (hadResult) {
    resultsBox.dataset.stale = 'true';
    document.getElementById('staleResultNotice').hidden = false;
    setResultActions(false);
  }
}

function setResultActions(enabled) {
  resultsBox.querySelectorAll('button').forEach(button => {
    const id = button.dataset.target;
    const report = runState.result?.outputs?.[OUTPUT_KEYS[id]] || '';
    const hasSequence = extractCleanFasta(report).seq.length > 0;
    button.disabled = !enabled || (id ? (button.classList.contains('copy-btn') || button.classList.contains('download-btn') ? !report : !hasSequence) : false);
  });
  resultsBox.querySelectorAll('.blast-link').forEach(link => {
    const enabledForOutput = enabled && extractCleanFasta(runState.result?.outputs?.[OUTPUT_KEYS[link.dataset.target]]).seq.length > 0;
    link.hidden = !enabledForOutput;
  });
}

function setBusyState(next) {
  busy = next;
  document.querySelectorAll('#uploadSection input, #uploadSection button').forEach(el => { el.disabled = next; });
  uploadSection.setAttribute('aria-busy', String(next));
  if (next) setResultActions(false);
}

function fieldError(input, message) {
  setInlineError(input.id, message);
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  setStatus(message, true);
  throw new Error(message);
}

async function readPrimer(target) {
  const input = document.getElementById(`primer${target}-${isPrimerFileMode(target) ? 'file' : 'text'}`);
  const file = isPrimerFileMode(target) ? input.files[0] : null;
  const raw = file ? await (async () => {
    if (file.size > MAX_INPUT_BYTES) fieldError(input, 'Primer files must be no larger than 5 MB.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { fieldError(input, 'Primer file must contain valid UTF-8 text.'); }
  })() : (isPrimerFileMode(target) ? '' : input.value);
  if (!raw.trim()) {
    if (file) fieldError(input, 'Primer file is empty.');
    return null;
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_INPUT_BYTES) fieldError(input, 'Primer input must be no larger than 5 MB.');
  try { return normalizePrimer(raw); }
  catch (error) { fieldError(input, `${target === 'F' ? 'Forward' : 'Reverse'} primer: ${error.message}`); }
}

function renderOutput(id, report) {
  const fasta = extractCleanFasta(report || '');
  document.getElementById(id).innerHTML = fasta.seq ? renderReportHtml(fasta.fasta) : '';
  const empty = document.getElementById(`${id}Empty`);
  empty.hidden = Boolean(fasta.seq);
  document.getElementById(`${id}Report`).innerHTML = renderReportHtml(report || 'No report available.');
}

function renderResults(result) {
  for (const [id, key] of Object.entries(OUTPUT_KEYS)) renderOutput(id, result.outputs[key]);
  document.getElementById('primerResultBlock').style.display = result.outputs.primer_trim ? 'block' : 'none';
  const notices = [...result.warnings];
  const primerReport = result.outputs.primer_trim || '';
  // Older APIs put unmatched-primer and fallback explanations only in report comments.
  const primerNotes = primerReport.split(/\r?\n/).filter(line => /^#/.test(line) && /primer|anchor|fallback|not found|not detected|not match|upstream/i.test(line)).map(line => line.replace(/^#\s*/, ''));
  const primerStatus = document.getElementById('primerOutcome');
  const omitted = !result.request.primers.forward && !result.request.primers.reverse;
  const outcomes = result.analysis?.primer_outcomes;
  const outcomeText = outcomes ? ['forward', 'reverse'].map(direction => {
    const outcome = outcomes[direction];
    return outcome ? `${direction === 'forward' ? 'Forward' : 'Reverse'} primer: ${outcome.message || outcome.status}` : '';
  }).filter(Boolean).join('\n') : '';
  primerStatus.textContent = omitted ? '' : (outcomeText || primerNotes.join('\n') || 'Primers were supplied. See the full report for trimming details.');
  primerStatus.hidden = omitted;
  const banner = document.getElementById('server-warn');
  banner.textContent = notices.join('\n');
  banner.hidden = notices.length === 0;
  document.getElementById('staleResultNotice').hidden = true;
  resultsBox.dataset.stale = 'false';
  resultsBox.style.display = 'block';
  setResultActions(true);
}

// Every analysis input invalidates a completed result, including paste/file mode and reset.
uploadSection.addEventListener('input', event => {
  if (event.target.matches('input')) {
    event.target.removeAttribute('aria-invalid');
    setInlineError(event.target.id, null);
    invalidateResults();
  }
});
uploadSection.addEventListener('change', event => { if (event.target.matches('input')) invalidateResults(); });

analyzeBtn.addEventListener('click', async () => {
  if (busy) return;
  setStatus('');
  setBusyState(true);
  // Lock throughout asynchronous validation; field errors receive focus after unlock.
  const fF = document.getElementById('fileF').files[0];
  const fR = document.getElementById('fileR').files[0];
  let requestId;
  let timeoutId;
  try {
    for (const [id, file] of [['fileF', fF], ['fileR', fR]]) {
      const input = document.getElementById(id);
      if (!file) fieldError(input, 'Please select both Forward and Reverse .ab1 files.');
      if (!AB1_RE.test(file.name)) fieldError(input, 'Reads must be .ab1 chromatogram files.');
      if (file.size > MAX_INPUT_BYTES) fieldError(input, 'Chromatogram files must be no larger than 5 MB.');
      const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
      if (magic !== 'ABIF') fieldError(input, 'The file is missing its ABIF chromatogram signature.');
    }
    const pF = await readPrimer('F');
    const pR = await readPrimer('R');
    const settings = {
      mottCutoff: clampNumericInput(mottInput, 0.1),
      minPhred: Math.round(clampNumericInput(qPhredInput, 20)),
      secondary_peak_threshold: Math.round(clampNumericInput(secPeakInput, 33)),
    };
    mottInput.value = settings.mottCutoff;
    qPhredInput.value = settings.minPhred;
    secPeakInput.value = settings.secondary_peak_threshold;
    saveSettings();
    const request = {
      files: { forward: fF, reverse: fR },
      filenames: { forward: fF.name, reverse: fR.name },
      primers: { forward: pF, reverse: pR },
      settings,
    };
    requestId = runState.begin();
    loading.style.display = 'block';
    resultsBox.style.display = 'none';
    setStatus('Analyzing…');
    const form = new FormData();
    form.append('fileF', fF);
    form.append('fileR', fR);
    if (pF) form.append('primerF', pF);
    if (pR) form.append('primerR', pR);
    for (const [key, value] of Object.entries(settings)) form.append(key, String(value));
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(BACKEND_URL, { method: 'POST', body: form, signal: controller.signal });
    if (!resp.ok) {
      let msg = `Server returned ${resp.status}. Please try again.`;
      try { msg = (await resp.json()).error || msg; } catch { /* non-JSON server response */ }
      if (resp.status === 413) msg = 'Upload too large — the server accepts at most 20 MB per request.';
      if (resp.status === 500) msg = 'Analysis failed on the server. Check your chromatograms and try again.';
      throw new Error(msg);
    }
    const data = await resp.json();
    if (!data.outputs || typeof data.outputs !== 'object') throw new Error('The server returned no analysis outputs. Please try again.');
    if (!runState.complete(requestId, {
      request, outputs: data.outputs, warnings: Array.isArray(data.warnings) ? data.warnings : [],
      analysis: data.analysis || null,
    })) return;
    renderResults(runState.result);
    setStatus('Analysis complete.');
  } catch (error) {
    if (requestId !== undefined && !runState.isCurrent(requestId)) return;
    if (error.name === 'AbortError') setStatus('The server took longer than 60 seconds. Try again shortly.', true);
    else if (error instanceof TypeError) setStatus('Could not reach the analysis server. Check your connection and try again.', true);
    else setStatus(error.message || 'Analysis failed. Please try again.', true);
  } finally {
    clearTimeout(timeoutId);
    loading.style.display = 'none';
    setBusyState(false);
    setResultActions(runState.isFresh());
    const invalid = uploadSection.querySelector('[aria-invalid="true"]');
    invalid?.focus();
  }
});

loadDemoBtn?.addEventListener('click', async () => {
  if (busy) return;
  setBusyState(true);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const responses = await Promise.all(['fwd_control.ab1', 'rev_control.ab1', 'primer_fwd.fasta', 'primer_rev.fasta'].map(name => fetch(`${BASE}demo/${name}`, { signal: controller.signal })));
    if (responses.some(resp => !resp.ok)) throw new Error('Demo files are unavailable.');
    const payloads = await Promise.all(responses.map(response => response.arrayBuffer()));
    if (payloads.some(buffer => buffer.byteLength > MAX_INPUT_BYTES)) throw new Error('Demo input exceeds the 5 MB limit.');
    // Prepare every payload before changing the current files, primer modes or traces.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const pFwd = normalizePrimer(decoder.decode(payloads[2]));
    const pRev = normalizePrimer(decoder.decode(payloads[3]));
    parseABIF(payloads[0]);
    parseABIF(payloads[1]);
    const fwd = new File([payloads[0]], 'fwd_control.ab1', { type: 'application/octet-stream' });
    const rev = new File([payloads[1]], 'rev_control.ab1', { type: 'application/octet-stream' });
    invalidateResults();
    setInputFile(document.getElementById('fileF'), fwd);
    setInputFile(document.getElementById('fileR'), rev);
    setPrimerMode('F', 'text');
    setPrimerMode('R', 'text');
    document.getElementById('primerF-text').value = pFwd;
    document.getElementById('primerR-text').value = pRev;
    await validateAb1Field('fileF', 'F', false);
    await validateAb1Field('fileR', 'R', false);
    await refreshTraces();
    setStatus('Demo dataset loaded (cane toad tyrosinase control). Press Analyze.');
  } catch (error) {
    setStatus(error.name === 'AbortError'
      ? 'Demo files took longer than 60 seconds to load. Try again shortly.'
      : 'Could not load demo files. Check your connection and try again.', true);
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    setBusyState(false);
    setResultActions(runState.isFresh());
  }
});

function getSampleSlug() { return sampleSlug(runState.result?.request.filenames.forward || 'sample'); }

const copyTimers = new WeakMap();

async function flashCopied(btn, text) {
  const original = btn.dataset.origHtml || btn.innerHTML;
  btn.dataset.origHtml = original;
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    clearTimeout(copyTimers.get(btn));
    btn.textContent = 'Copied!';
    copyTimers.set(btn, setTimeout(() => {
      btn.innerHTML = original;
      copyTimers.delete(btn);
    }, 1200));
  } catch { setStatus('Could not copy to the clipboard. Use Download FASTA or Download Report instead.', true); }
}

function triggerTextDownload(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const [selector, clean, download] of [
  ['.copy-fasta-btn', true, false], ['.download-fasta-btn', true, true],
  ['.copy-btn', false, false], ['.download-btn', false, true],
]) {
  document.querySelectorAll(selector).forEach(btn => btn.addEventListener('click', () => {
    if (!runState.isFresh() || busy) return;
    const id = btn.dataset.target;
    const report = runState.result.outputs[OUTPUT_KEYS[id]] || '';
    const content = clean ? extractCleanFasta(report).fasta : report;
    if (!content) return;
    if (download) triggerTextDownload(content, `SangerAnalyst-${getSampleSlug()}-${RESULT_LABELS[id]}.${clean ? 'fasta' : 'txt'}`);
    else flashCopied(btn, content);
  }));
}

document.getElementById('downloadAnalysisBtn').addEventListener('click', async () => {
  if (!runState.isFresh() || busy) return;
  const result = runState.result;
  try {
    const metadata = await createAnalysisExport(result, extractCleanFasta);
    if (runState.result !== result || !runState.isFresh()) return;
    triggerTextDownload(JSON.stringify(metadata, null, 2) + '\n', `SangerAnalyst-${sampleSlug(result.request.filenames.forward)}-analysis.json`);
  } catch { setStatus('Could not create analysis details. Your FASTA and report downloads are still available.', true); }
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
