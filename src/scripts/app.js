// --- CONFIG ---
// Local dev (page served from localhost/127.0.0.1) targets a local backend on :8000;
// anything else (including GitHub Pages) uses the production PythonAnywhere API.
const BACKEND_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://127.0.0.1:8000/process'
  : 'https://shiddharta.pythonanywhere.com/process';

import { attachTraceViewer, parseABIF } from './traceviewer.js';

const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mldawblv';

// Base path of the deployed site (e.g. "/sangeranalyst/" on GitHub Pages)
const BASE = document.documentElement.dataset.base || '/';

const AB1_RE = /\.ab1$/i;
const PRIMER_FILE_RE = /\.(fasta|fa|fna|txt)$/i;

// ==================== SETTINGS PERSISTENCE ===================
const SETTINGS_KEY = 'sangeranalyst-settings';
const settingInputs = ['mottCutoff', 'qPhred', 'secPeak'].map(id => document.getElementById(id));

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
    for (const input of settingInputs) data[input.id] = parseFloat(input.value);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch { /* storage unavailable */ }
}

loadSettings();
settingInputs.forEach(input => input.addEventListener('change', saveSettings));

// ==================== TOGGLE UPLOAD / PASTE MODE ===================
document.querySelectorAll(".toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    const fileInput = document.getElementById("primer" + target + "-file");
    const textInput = document.getElementById("primer" + target + "-text");

    if (fileInput.style.display !== "none") {
      // Switch to TEXT mode
      fileInput.style.display = "none";
      textInput.style.display = "block";
      fileInput.value = "";
      btn.textContent = "📁"; // Icon becomes Folder (click to go to file)
    } else {
      // Switch to FILE mode
      fileInput.style.display = "block";
      textInput.style.display = "none";
      textInput.value = "";
      btn.textContent = "✍"; // Icon becomes Pen (click to go to text)
    }
  });
});

// Reset inputs
document.querySelectorAll(".reset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    const fileInput = document.getElementById("primer" + target + "-file");
    const textInput = document.getElementById("primer" + target + "-text");
    fileInput.value = "";
    textInput.value = "";
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
const mottBtn = document.getElementById("mottInfoBtn");
const mottTip = document.getElementById("m_tooltip");

const qBtn = document.getElementById("qPhredInfoBtn");
const qTip = document.getElementById("q_tooltip");

const secBtn = document.getElementById("secPeakInfoBtn");
const secTip = document.getElementById("sec_tooltip");

const tooltipPairs = [[mottBtn, mottTip], [qBtn, qTip], [secBtn, secTip]];

// Hide all tooltips
function hideTooltips() {
  for (const [, tip] of tooltipPairs) tip.style.display = "none";
  for (const [btn] of tooltipPairs) btn.setAttribute("aria-expanded", "false");
}

// Toggle function
function toggleTooltip(btn, tip) {
  const isVisible = tip.style.display === "block";

  hideTooltips(); // always hide everything first

  if (!isVisible) {
    const rect = btn.getBoundingClientRect();
    tip.style.display = "block";
    btn.setAttribute("aria-expanded", "true");
    const tooltipWidth = tip.clientWidth;
    tip.style.left = (rect.left + window.scrollX + rect.width / 2 - tooltipWidth / 2) + "px";
    tip.style.top = rect.bottom + 8 + window.scrollY + "px";
  }
}

for (const [btn, tip] of tooltipPairs) {
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleTooltip(btn, tip);
  });
  // Prevent clicks inside tooltip from closing it
  tip.addEventListener("click", (ev) => ev.stopPropagation());
}

// Clicking outside closes both
document.addEventListener("click", hideTooltips);

// Scroll closes both
window.addEventListener("scroll", hideTooltips);

// Escape closes tooltips
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTooltips(); });

//==================== SEQUENCE VALIDATION ====================

function cleanAndValidateDNA(seq, minLen = 3) {
  if (!seq) return null;

  // Remove FASTA headers, whitespace, digits, and non-letters
  let cleaned = seq
    .replace(/^>.*$/gm, '')
    .replace(/[\s0-9]/g, '')
    .toUpperCase();

  // Regex supports IUPAC ambiguity codes (R, Y, K, etc.)
  if (!/^[ATGCNRYKMSWBDHV]+$/.test(cleaned)) return null;

  // Ensure reasonable length
  if (cleaned.length < minLen) return null;

  return cleaned;
}

//==================== CHROMATOGRAM TRACE VIEWER ===================

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
});

const traceFiles = { F: null, R: null };

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
  const f = traceFiles.F, r = traceFiles.R;
  if (!f && !r) {
    traceSection.style.display = 'none';
    return;
  }
  traceSection.style.display = 'block';

  let fwd = null, rev = null;
  const notes = [];
  if (f) {
    try { fwd = await parseABIF(await f.arrayBuffer()); }
    catch { notes.push(`"${f.name}" is not a valid ABIF chromatogram`); }
  }
  if (r) {
    try { rev = await parseABIF(await r.arrayBuffer()); }
    catch { notes.push(`"${r.name}" is not a valid ABIF chromatogram`); }
  }
  traceViewer.setData(fwd, rev, f?.name ?? '', r?.name ?? '');
  if (notes.length) {
    traceMeta.textContent = (traceMeta.textContent ? traceMeta.textContent + ' · ' : '') + notes.join(' · ');
  }
}

async function handleReadSelected(inputId, which) {
  const file = document.getElementById(inputId).files[0];
  traceFiles[which] = file || null;
  setInlineError(inputId, null);
  if (!file) {
    refreshTraces();
    return;
  }
  if (file.size > 5_000_000) {
    setInlineError(inputId, 'File is larger than 5 MB.');
  } else {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const magic = String.fromCharCode(...head);
    if (magic !== 'ABIF') {
      setInlineError(inputId, 'This does not look like an ABIF chromatogram (missing ABIF signature).');
    }
  }
  refreshTraces();
}

document.getElementById('fileF').addEventListener('change', () => handleReadSelected('fileF', 'F'));
document.getElementById('fileR').addEventListener('change', () => handleReadSelected('fileR', 'R'));

//==================== SEQUENCE OUTPUT RENDERING ===================

const IUPAC_RE = /([RYKMSWBDHV])/g;

function renderSeq(el, text) {
  if (!text || text === '—') {
    el.textContent = '—';
    return;
  }
  const lines = text.split('\n').map(line => {
    const escaped = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (line.startsWith('#') || line.startsWith('>')) return escaped;
    return escaped.replace(IUPAC_RE, '<span class="amb">$1</span>');
  });
  el.innerHTML = lines.join('\n');
}

//==================== ANALYZE HANDLER ===================

const analyzeBtn = document.getElementById('analyzeBtn');
const resultsBox = document.getElementById('results');
const strictEl = document.getElementById('strict');
const fullEl = document.getElementById('full');
const primerEl = document.getElementById('primerTrim');
const primerBlock = document.getElementById('primerResultBlock');

async function validatePrimerFile(file, label) {
  const text = await file.text();
  if (!cleanAndValidateDNA(text, 10)) {
    alert(`Invalid ${label} primer file "${file.name}": use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).`);
    return false;
  }
  return true;
}

analyzeBtn.addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  setStatus('');
  const fF = document.getElementById('fileF').files[0];
  const fR = document.getElementById('fileR').files[0];
  const loading = document.getElementById("loading");
  let pF = document.getElementById('primerF-file').files[0];
  let pR = document.getElementById('primerR-file').files[0];
  let pF_t = cleanAndValidateDNA(document.getElementById('primerF-text').value, 10);
  let pR_t = cleanAndValidateDNA(document.getElementById('primerR-text').value, 10);
  if(pF_t){
    pF = pF_t
    document.getElementById('primerF-text').value = pF_t;
  }
  if(pR_t){
    pR = pR_t
    document.getElementById('primerR-text').value = pR_t;
  }
  const mott = document.getElementById('mottCutoff').value;
  const mphred = document.getElementById('qPhred').value;
  const secPeak = document.getElementById('secPeak').value;

  if(!fF || !fR){
    setStatus("Please provide both .ab1 files.", true);
    alert('Please upload both forward and reverse .ab1 files.');
    return analyzeBtn.disabled = false;
  }
  if(!AB1_RE.test(fF.name) || !AB1_RE.test(fR.name)){
    setStatus("Reads must be .ab1 chromatogram files.", true);
    alert('Both reads must be .ab1 files (check you did not swap in another format).');
    return analyzeBtn.disabled = false;
  }
  if(pF_t == null && document.getElementById('primerF-text').value.trim() !== '') {
    setStatus("Invalid forward primer sequence.", true);
    alert('Invalid Forward primer: use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).');
    return analyzeBtn.disabled = false;
  }
  if(pR_t == null && document.getElementById('primerR-text').value.trim() !== '') {
    setStatus("Invalid reverse primer sequence.", true);
    alert('Invalid Reverse primer: use only A, T, G, C, N or IUPAC ambiguity codes (min 10 bases).');
    return analyzeBtn.disabled = false;
  }
  if(pF instanceof File && !(await validatePrimerFile(pF, 'forward'))){
    return analyzeBtn.disabled = false;
  }
  if(pR instanceof File && !(await validatePrimerFile(pR, 'reverse'))){
    return analyzeBtn.disabled = false;
  }

  const pF_len = pF_t ? pF_t.length : 0;
  const pR_len = pR_t ? pR_t.length : 0;

  if(fF.size > 5_000_000 || fR.size > 5_000_000 || pF_len > 5_000_000 || pR_len > 5_000_000) {
      setStatus("Input too large.", true);
      alert("Files or input text are too large, max 5 MB (or 5M characters) per input.");
      return analyzeBtn.disabled = false;
  }

  loading.style.display = "block";
  primerEl.scrollTop  = 0;
  strictEl.scrollTop  = 0;
  fullEl.scrollTop  = 0;
  primerBlock.style.display = 'none';
  resultsBox.style.display = 'none';
  primerEl.textContent = '—';
  strictEl.textContent = '—';
  fullEl.textContent = '—';
  setStatus('Analyzing…');

  const form = new FormData();
  form.append('fileF', fF);
  form.append('fileR', fR);
  if(pF) form.append('primerF', pF);
  if(pR) form.append('primerR', pR);
  form.append('mottCutoff', mott);
  form.append('minPhred', mphred);
  form.append('secondary_peak_threshold', secPeak);

  let timeoutId;
  try{
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(BACKEND_URL, { method:'POST', body: form, signal: controller.signal });
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
    const outputs = data.outputs;

    renderSeq(strictEl, outputs.consensus_strict || '—');
    renderSeq(fullEl, outputs.consensus_full || '—');
    if(outputs.primer_trim){
      renderSeq(primerEl, outputs.primer_trim);
      primerBlock.style.display = 'block';
    } else {
      primerBlock.style.display = 'none';
      primerEl.textContent = '—';
    }
    resultsBox.style.display = 'block';
    setStatus('Analysis complete.');

  } catch(err){
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
    loading.style.display = "none";
    analyzeBtn.disabled = false;
  }
});

//==================== DEMO DATA LOADER ===================

const loadDemoBtn = document.getElementById('loadDemoBtn');

function setInputFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
}

loadDemoBtn?.addEventListener('click', async () => {
  loadDemoBtn.disabled = true;
  try {
    const [fwd, rev] = await Promise.all([
      fetch(`${BASE}demo/fwd_control.ab1`).then(r => r.blob()),
      fetch(`${BASE}demo/rev_control.ab1`).then(r => r.blob()),
    ]);
    setInputFile(document.getElementById('fileF'), new File([fwd], 'fwd_control.ab1', { type: 'octet-stream' }));
    setInputFile(document.getElementById('fileR'), new File([rev], 'rev_control.ab1', { type: 'octet-stream' }));
    await handleReadSelected('fileF', 'F');
    await handleReadSelected('fileR', 'R');

    const [pFwd, pRev] = await Promise.all([
      fetch(`${BASE}demo/primer_fwd.fasta`).then(r => r.text()),
      fetch(`${BASE}demo/primer_rev.fasta`).then(r => r.text()),
    ]);
    const pFwdClean = cleanAndValidateDNA(pFwd, 10);
    const pRevClean = cleanAndValidateDNA(pRev, 10);
    if (pFwdClean) document.getElementById('primerF-text').value = pFwdClean;
    if (pRevClean) document.getElementById('primerR-text').value = pRevClean;

    setStatus('Demo dataset loaded (cane toad tyrosinase control). Press Analyze.');
  } catch (err) {
    console.error(err);
    setStatus('Could not load demo files.', true);
  } finally {
    loadDemoBtn.disabled = false;
  }
});

// COPY BUTTON
document.querySelectorAll('.copy-btn').forEach(btn => {
  // Save original HTML content (SVG + text)
  const originalHTML = btn.innerHTML;
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const text = document.getElementById(id).innerText.trim();
    // Copy to clipboard
    navigator.clipboard.writeText(text).then(() => {
      // Show "Copied!" temporarily
      btn.innerText = "Copied!";
      setTimeout(() => {
        // Revert to original SVG + text
        btn.innerHTML = originalHTML;
      }, 1200);
    }).catch(err => {
      console.error("Failed to copy: ", err);
    });
  });
});

// DOWNLOAD BUTTON
const RESULT_LABELS = {
  strict: 'high-confidence-consensus',
  full: 'full-merge',
  primerTrim: 'primer-trimmed-consensus',
};

document.querySelectorAll('.download-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const content = document.getElementById(id).innerText.trim();

    const sample = (document.getElementById('fileF').files[0]?.name || 'sample')
      .replace(/\.ab1$/i, '')
      .replace(/[^\w.-]+/g, '_');

    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `SangerAnalyst-${sample}-${RESULT_LABELS[id] ?? id}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

// --- Modal feedback logic ---
const reportLink = document.getElementById('reportLink');
const overlay = document.getElementById('overlay');
const backdrop = document.getElementById('backdrop');
const modalBox = document.getElementById('modalBox');
const modalClose = document.getElementById('modalClose');
const sendBtn = document.getElementById('sendFeedbackBtn');
const fbForm = document.getElementById('feedbackForm');

function openModal(){
  overlay.classList.add('show');
  backdrop.classList.add('show');
  modalBox.classList.add('show');
  overlay.setAttribute('aria-hidden','false');
  modalClose.focus();
}
function closeModal(){
  modalBox.classList.remove('show');
  backdrop.classList.remove('show');
  setTimeout(()=>{ overlay.classList.remove('show'); overlay.setAttribute('aria-hidden','true'); }, 220);
}

reportLink.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
backdrop.addEventListener('click', closeModal);

// Close modal on Escape
document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape' && overlay.classList.contains('show')) closeModal(); });

// Feedback send (Formspree)
sendBtn.addEventListener('click', async ()=>{
  // disable and show sending
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';

  const name = document.getElementById('fb_name').value || '';
  const email = document.getElementById('fb_email').value || '';
  const message = document.getElementById('fb_message').value || '';

  if(!message.trim()){ alert('Please enter a message.'); sendBtn.disabled = false; sendBtn.textContent = 'Send'; return; }

  try{
    const payload = new FormData();
    payload.append('name', name);
    payload.append('email', email);
    payload.append('message', message);

    const resp = await fetch(FORMSPREE_ENDPOINT, { method: 'POST', body: payload, headers: { 'Accept': 'application/json' }});
    if(!resp.ok){
      throw new Error('Failed to send feedback.');
    }
    const d = await resp.json();
    // success
    closeModal();
    showSentPopup();
    // clear form
    fbForm.reset();
  } catch(err){
    console.error(err);
    alert('Failed to send feedback.');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
});

/// SENT POPUP
const sentPopup = document.getElementById('sentPopup');
const sentClose = document.getElementById('sentClose');
let hideTimeout;

function showSentPopup(){
  sentPopup.setAttribute('aria-hidden','false');
  sentPopup.classList.add('show');
  // auto hide after 3s
  hideTimeout = setTimeout(()=>{
    hideSentPopup();
  }, 3000);

  // click X to hide early
  sentClose.onclick = ()=> {
    clearTimeout(hideTimeout);
    hideSentPopup();
  };
}
function hideSentPopup(){
  sentPopup.classList.remove('show');
  sentPopup.setAttribute('aria-hidden','true');
}

// --- SUPPORT MODAL ---
const supportLink = document.getElementById("supportLink");
const supportOverlay = document.getElementById("supportOverlay");
const supportBackdrop = document.getElementById("supportBackdrop");
const supportModalBox = document.getElementById("supportModalBox");
const supportClose = document.getElementById("supportClose");

function openSupportModal() {
  supportOverlay.classList.add("show");
  supportBackdrop.classList.add("show");
  supportModalBox.classList.add("show");
  supportOverlay.setAttribute("aria-hidden", "false");
  supportClose.focus();
}

function closeSupportModal() {
  supportModalBox.classList.remove("show");
  supportBackdrop.classList.remove("show");

  setTimeout(() => {
    supportOverlay.classList.remove("show");
    supportOverlay.setAttribute("aria-hidden", "true");
  }, 220); // match CSS transition duration
}

supportLink.addEventListener("click", openSupportModal);
supportClose.addEventListener("click", closeSupportModal);
supportBackdrop.addEventListener("click", closeSupportModal);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && supportOverlay.classList.contains("show")) {
    closeSupportModal();
  }
});

// --- DANA QR MODAL ---
const openDanaQR = document.getElementById("openDanaQR");
const danaOverlay = document.getElementById("danaOverlay");
const danaBackdrop = document.getElementById("danaBackdrop");
const danaModalBox = document.getElementById("danaModalBox");
const danaClose = document.getElementById("danaClose");

function openDanaModal() {
  // if support modal is visible, hide it first (keeps a single modal visible)
  if (supportOverlay.classList.contains("show")) {
    supportOverlay.classList.remove("show");
    supportOverlay.setAttribute("aria-hidden", "true");
  }

  danaOverlay.classList.add("show");
  danaBackdrop.classList.add("show");
  danaModalBox.classList.add("show");
  danaOverlay.setAttribute("aria-hidden", "false");
  danaClose?.focus();
}

function closeDanaModal() {
  danaModalBox.classList.remove("show");
  danaBackdrop.classList.remove("show");

  // remove overlay after transition (match 220ms)
  setTimeout(() => {
    danaOverlay.classList.remove("show");
    danaOverlay.setAttribute("aria-hidden", "true");
  }, 220);
}

openDanaQR?.addEventListener("click", (e) => {
  e.preventDefault();
  openDanaModal();
});

danaClose?.addEventListener("click", closeDanaModal);
danaBackdrop?.addEventListener("click", closeDanaModal);

// close with Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && danaOverlay?.classList.contains("show")) {
    closeDanaModal();
  }
});

// --- FOCUS TRAP (keyboard users stay inside an open modal) ---
const modalContainers = [modalBox, supportModalBox, danaModalBox];

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const open = modalContainers.find(m => m.classList.contains("show"));
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

// --- small helpers ---
// Close tooltip/modal when window resizes
window.addEventListener('resize', ()=>{
  hideTooltips();
});

// Accessibility: return focus to trigger when closing modals
overlay.addEventListener('transitionend', ()=>{
  if(!overlay.classList.contains('show')) reportLink.focus();
});

supportOverlay.addEventListener("transitionend", () => {
  if (!supportOverlay.classList.contains("show")) {
    supportLink.focus();
  }
});
