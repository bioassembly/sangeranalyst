// --- CONFIG (replace backend & forms endpoint) ---
const BACKEND_URL = 'https://shiddharta.pythonanywhere.com/process';
/*const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'http://127.0.0.1:8000/process'
  : 'https://shiddharta.pythonanywhere.com/process';
*/
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mldawblv'; 

// Toggle Upload / Paste mode
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

// ==================== TOOLTIP HANDLER (TOGGLE) ===================
// Get elements
const mottBtn = document.getElementById("mottInfoBtn");
const mottTip = document.getElementById("m_tooltip");

const qBtn = document.getElementById("qPhredInfoBtn");
const qTip = document.getElementById("q_tooltip");

const secBtn = document.getElementById("secPeakInfoBtn");
const secTip = document.getElementById("sec_tooltip");

// Hide all tooltips
function hideTooltips() {
  mottTip.style.display = "none";
  qTip.style.display = "none";
  secTip.style.display = "none"; // Hide secondary peak tooltip
}

// Toggle function
function toggleTooltip(btn, tip) {
  const isVisible = tip.style.display === "block";

  hideTooltips(); // always hide everything first

  if (!isVisible) {
    // If previously hidden, show it
    const rect = btn.getBoundingClientRect();
    tip.style.display = "block";
    const tooltipWidth = tip.clientWidth;
    tip.style.left = (rect.left + window.scrollX + rect.width / 2 - tooltipWidth / 2) + "px";
    tip.style.top = rect.bottom + 8 + window.scrollY + "px";
  }
}

// --- Mott tooltip ---
mottBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleTooltip(mottBtn, mottTip);
});

// --- Phred tooltip ---
qBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleTooltip(qBtn, qTip);
});

// --- Secondary Peak tooltip ---
secBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleTooltip(secBtn, secTip);
});

// Prevent clicks inside tooltip from closing it
mottTip.addEventListener("click", (ev) => ev.stopPropagation());
qTip.addEventListener("click", (ev) => ev.stopPropagation());
secTip.addEventListener("click", (ev) => ev.stopPropagation());

// Clicking outside closes both
document.addEventListener("click", hideTooltips);

// Scroll closes both
window.addEventListener("scroll", hideTooltips);

//==================== ANALYZE HANDLER ===================

function cleanAndValidateDNA(seq) {
  if (!seq) return null;
  
  // Remove FASTA headers, whitespace, digits, and non-letters
  let cleaned = seq
    .replace(/^>.*$/gm, '') 
    .replace(/[\s0-9]/g, '')
    .toUpperCase();

  // Updated Regex to support IUPAC ambiguity codes (R, Y, K, etc.)
  if (!/^[ATGCNRYKMSWBDHV]+$/.test(cleaned)) return null;

  // Ensure reasonable length
  if (cleaned.length < 3) return null;
  
  return cleaned;
}

// Analyze: upload to backend (expects consensus_strict, consensus, primer_trim fields in JSON)
const analyzeBtn = document.getElementById('analyzeBtn');
const status = document.getElementById('status');
const resultsBox = document.getElementById('results');
const strictEl = document.getElementById('strict');
const fullEl = document.getElementById('full');
const primerEl = document.getElementById('primerTrim');
const primerBlock = document.getElementById('primerResultBlock');

analyzeBtn.addEventListener('click', async ()=>{
  analyzeBtn.disabled = true;
  const fF = document.getElementById('fileF').files[0];
  const fR = document.getElementById('fileR').files[0];
  const loading = document.getElementById("loading");
  let pF = document.getElementById('primerF-file').files[0];
  let pR = document.getElementById('primerR-file').files[0];
  let pF_t = cleanAndValidateDNA(document.getElementById('primerF-text').value);
  let pR_t = cleanAndValidateDNA(document.getElementById('primerR-text').value);
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
    status.textContent = "Please provide both .ab1 files.";
    alert('Please upload both forward and reverse .ab1 files.'); 
    return analyzeBtn.disabled = false; 
  }
  if(document.getElementById('primerF-file').files[0] == null && pF_t == null && document.getElementById('primerF-text').value.trim() !== '') {
    alert('Invalid Forward primer: please use only A, T, G, C, N (min 10 bases).');
    return analyzeBtn.disabled = false;
  }
  if(document.getElementById('primerR-file').files[0] == null && pR_t == null && document.getElementById('primerR-text').value.trim() !== '') {
    alert('Invalid Reverse primer: please use only A, T, G, C, N (min 10 bases).');
    return analyzeBtn.disabled = false;
  }

  const pF_len = pF_t ? pF_t.length : 0;
  const pR_len = pR_t ? pR_t.length : 0;

  if(fF.size > 5_000_000 || fR.size > 5_000_000 || pF_len > 5_000_000 || pR_len > 5_000_000) {
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

  const form = new FormData();
  form.append('fileF', fF);
  form.append('fileR', fR);
  if(pF) form.append('primerF', pF);
  if(pR) form.append('primerR', pR);
  form.append('mottCutoff', mott);
  form.append('minPhred', mphred);
  form.append('secondary_peak_threshold', secPeak);

  try{
    const resp = await fetch(BACKEND_URL, { method:'POST', body: form });
    if(!resp.ok) throw new Error('Server returned ' + resp.status);
    const data = await resp.json();
    const outputs = data.outputs;
        
    strictEl.textContent = outputs.consensus_strict || '—';
    fullEl.textContent = outputs.consensus_full || '—';
    if(outputs.primer_trim){
      primerEl.textContent = outputs.primer_trim;
      primerBlock.style.display = 'block';
    } else {
      primerBlock.style.display = 'none';
      primerEl.textContent = '—';
    }
    resultsBox.style.display = 'block';
    status.textContent = 'Analysis complete.';
        
  } catch(err){
    console.error(err);
    status.textContent = 'Error: ' + (err.message || err);
    alert('Analysis failed — Sorry, the server is error.');
  } finally {
    loading.style.display = "none";
    analyzeBtn.disabled = false;
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
document.querySelectorAll('.download-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    const content = document.getElementById(id).innerText.trim();
    const blob = new Blob([content], { type: "text/plain" });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `SangerAnalyst-consensus-${id}.txt`;
    if(id == "primerTrim"){
      a.download = `SangerAnalyst-consensus-primer-trim.txt`;
    }
    a.click();

    URL.revokeObjectURL(a.href);
  });
});

// --- Modal feedback logic ---
const reportLink = document.getElementById('reportLink');
const overlay = document.getElementById('overlay');
const backdrop = document.getElementById('backdrop');
const modal = document.getElementById('modalBox');
const modalClose = document.getElementById('modalClose');
const sendBtn = document.getElementById('sendFeedbackBtn');
const fbForm = document.getElementById('feedbackForm');

function openModal(){
  overlay.classList.add('show');
  backdrop.classList.add('show');
  modal.classList.add('show');
  overlay.setAttribute('aria-hidden','false');
}
function closeModal(){
  modal.classList.remove('show');
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

// --- small helpers ---
// Close tooltip/modal when window resizes
window.addEventListener('resize', ()=>{
  hideTooltips();
});

// Accessibility: focus trap minimal (returns focus to report link when closing)
overlay.addEventListener('transitionend', ()=>{
  if(!overlay.classList.contains('show')) reportLink.focus();
});

// --- SUPPORT MODAL ---
const supportLink = document.getElementById("supportLink");
const supportOverlay = document.getElementById("supportOverlay");
const supportBackdrop = document.getElementById("supportBackdrop");
const supportModal = document.getElementById("supportModalBox");
const supportClose = document.getElementById("supportClose");

function openSupportModal() {
  supportOverlay.classList.add("show");
  supportBackdrop.classList.add("show");
  supportModal.classList.add("show");
  supportOverlay.setAttribute("aria-hidden", "false");
}

function closeSupportModal() {
  supportModal.classList.remove("show");
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

// return focus when closed (accessibility)
supportOverlay.addEventListener("transitionend", () => {
  if (!supportOverlay.classList.contains("show")) {
    supportLink.focus();
  }
});

// --- DANA QR MODAL ---
const openDanaQR = document.getElementById("openDanaQR");
const danaOverlay = document.getElementById("danaOverlay");
const danaBackdrop = document.getElementById("danaBackdrop");
const danaModal = document.getElementById("danaModalBox");
const danaClose = document.getElementById("danaClose");

// reference to support overlay 
const supportOverlayEl = document.getElementById("supportOverlay");

function openDanaModal() {
  // if support modal is visible, hide it first (keeps a single modal visible)
  if (supportOverlayEl && supportOverlayEl.classList.contains("show")) {
    supportOverlayEl.classList.remove("show");
    supportOverlayEl.setAttribute("aria-hidden", "true");
  }

  if (!danaOverlay) return;
  danaOverlay.classList.add("show");
  if (danaBackdrop) danaBackdrop.classList.add("show");
  if (danaModal) danaModal.classList.add("show");
  danaOverlay.setAttribute("aria-hidden", "false");
  // optionally move focus to close button for accessibility
  danaClose?.focus();
}

function closeDanaModal() {
  if (!danaOverlay) return;
  if (danaModal) danaModal.classList.remove("show");
  if (danaBackdrop) danaBackdrop.classList.remove("show");

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
