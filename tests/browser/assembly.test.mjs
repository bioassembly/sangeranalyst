import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4321';
const api = 'http://127.0.0.1:8000/process';
const sequence = 'ACGTACGTRYSWACGTACGT';
const alignment = 'forward          1 ACGTACGTACGTACGTACGT    20\n                  ||||||||....||||||||\nreverse_rc       1 ACGTACGTGTCAACGTACGT    20';
const report = `>demo_consensus\n${sequence}\n\n# Identity: 16/20 (80.0%)\n# Gaps: 0/20 (0.0%)\n${alignment}\n\n# Conflict report\n`;
const fullReport = report.replace('demo_consensus', 'demo_full');
const fixture = {
  outputs: { consensus_strict: report, consensus_full: fullReport },
  warnings: ['Review mixed bases before use.'],
  analysis: { schema_version: 1, tool: { revision: 'fixture-revision' } },
  summary: { secondary_peak_candidates: {schema_version:1,minimum_threshold:1,forward:[],reverse:[
    {position:5,primary_base:'A',secondary_base:'G',percentage:46.43},
    {position:6,primary_base:'A',secondary_base:'G',percentage:59.05},
    {position:8,primary_base:'A',secondary_base:'C',percentage:50.68},
  ]}},
};
let server, browser;

before(async () => {
  try { await fetch(`${origin}/sangeranalyst/`, { signal: AbortSignal.timeout(1000) }); }
  catch {
    const astroDirectory = fileURLToPath(new URL('../../node_modules/astro/', import.meta.url));
    const astroPackage = JSON.parse(await readFile(join(astroDirectory, 'package.json'), 'utf8'));
    server = spawn(process.execPath, [join(astroDirectory, astroPackage.bin.astro), 'dev', '--host', '127.0.0.1'], { stdio: 'pipe', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
    let output = '';
    server.stderr.on('data', chunk => { output += chunk; });
    server.stdout.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (server.exitCode !== null) throw new Error(`Astro exited: ${output}`);
      try { if ((await fetch(`${origin}/sangeranalyst/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(`${origin}/sangeranalyst/`, { signal: AbortSignal.timeout(1000) })).status, 200);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}) });
  console.log(`Browser: Chromium ${browser.version()}`);
});
after(async () => { await browser?.close(); server?.kill('SIGTERM'); });

async function withPage(fn, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try { await fn(page); assert.deepEqual(errors, []); }
  finally { await context.close(); }
}
async function status(page, text) { await page.waitForFunction(text => document.querySelector('#status')?.textContent.includes(text), text); }
async function demo(page) {
  await page.goto(`${origin}/sangeranalyst/`);
  await page.getByRole('button', { name: 'Try demo data' }).click();
  await status(page, 'Demo dataset loaded');
}
async function assemble(page, body = fixture) {
  await page.route(api, route => route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } }));
  await demo(page);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
}
async function download(page, locator) {
  const event = page.waitForEvent('download');
  await locator.click();
  const file = await event;
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), 'utf8') };
}

test('demo loads both chromatograms without needing the analysis API', () => withPage(async page => {
  let analysisCalls = 0;
  await page.route(api, route => { analysisCalls++; return route.abort(); });
  await demo(page);
  assert.equal(await page.locator('#fileF').evaluate(input => input.files[0]?.name), 'fwd_control.ab1');
  assert.equal(await page.locator('#fileR').evaluate(input => input.files[0]?.name), 'rev_control.ab1');
  assert.equal(await page.locator('#traceSection').count(), 1);
  assert.equal(await page.locator('#traceSection').isVisible(), true);
  await page.waitForFunction(() => ['traceCanvasF', 'traceCanvasR'].every(id => {
    const canvas = document.getElementById(id);
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] && (
        (pixels[i] > pixels[i + 1] * 1.5 && pixels[i] > pixels[i + 2] * 1.5) ||
        (pixels[i + 1] > pixels[i] * 1.5 && pixels[i + 1] > pixels[i + 2] * 1.2) ||
        (pixels[i + 2] > pixels[i] * 1.5 && pixels[i + 2] > pixels[i + 1] * 1.2)
      )) colored++;
    }
    return colored > 20;
  }));
  assert.equal(analysisCalls, 0);
  assert.equal(await page.locator('#results').isVisible(), false);
  await page.locator('#traceSection').screenshot({ path: '/tmp/sanger-demo-chromatograms.png' });
}));

test('balanced scaling flags tall peaks and fit-all mode reveals their full height', () => withPage(async page => {
  await demo(page);
  await page.locator('#traceAmp').fill('4');
  assert.equal(await page.locator('#traceScaleNote').isVisible(), true);
  assert.match(await page.locator('#traceScaleNote').textContent(), /Fit all peaks/);
  await page.locator('#traceScrollBar').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.equal(await page.locator('#traceScaleNote').isVisible(), true);
  await page.getByLabel('Peak scaling').selectOption('all');
  assert.equal(await page.locator('#traceScaleNote').isVisible(), true);
  await page.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await page.getByLabel('Peak scaling').inputValue(), 'balanced');
  assert.equal(await page.locator('#traceAmp').inputValue(), '1');
}));

test('a synthetic outlier does not flatten neighboring peaks in balanced mode', () => withPage(async page => {
  await page.goto(`${origin}/sangeranalyst/`);
  const result = await page.evaluate(async () => {
    const { attachTraceViewer } = await import('/sangeranalyst/src/scripts/traceviewer.js');
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.style.width = '600px';
    canvas.style.height = '190px';
    inner.append(canvas); outer.append(inner); document.body.append(outer);
    const select = document.createElement('select');
    select.add(new Option('Balanced', 'balanced'));
    select.add(new Option('Fit all', 'all'));
    const note = document.createElement('p');
    const positions = Array.from({ length: 20 }, (_, i) => i * 20 + 10);
    const signal = new Array(420).fill(0);
    for (const [i, position] of positions.entries()) {
      const height = i === 10 ? 10000 : 100;
      signal[position - 1] = height / 2;
      signal[position] = height;
      signal[position + 1] = height / 2;
    }
    const zeros = new Array(420).fill(0);
    const read = { bases: 'A'.repeat(20), ploc: positions, qual: new Array(20).fill(40), channels: { A: signal, C: zeros, G: zeros, T: zeros } };
    const viewer = attachTraceViewer({ canvasF: canvas, scaleSelect: select, scaleNote: note });
    viewer.setData(read, null, 'synthetic', '');
    const peakY = index => {
      const x = Math.round((index + 1) * canvas.clientWidth / 22);
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(x - 4, 48, 9, 124).data;
      for (let y = 0; y < 124; y++) for (let dx = 0; dx < 9; dx++) {
        const i = (y * 9 + dx) * 4;
        if (pixels[i + 3] > 50 && pixels[i + 1] > pixels[i] * 1.3 && pixels[i + 1] > pixels[i + 2] * 1.1) return y + 48;
      }
      return null;
    };
    const balanced = { normal: peakY(5), noticeVisible: !note.hidden };
    select.value = 'all'; select.dispatchEvent(new Event('change'));
    return { balanced, all: { normal: peakY(5), outlier: peakY(10), noticeVisible: !note.hidden } };
  });
  assert.equal(result.balanced.noticeVisible, true);
  assert.ok(result.balanced.normal < 130, `Normal peak should be visible: ${JSON.stringify(result)}`);
  assert.equal(result.all.noticeVisible, true);
  assert.ok(result.all.normal > 145, `All-peaks mode should use the outlier height: ${JSON.stringify(result)}`);
  assert.ok(result.all.outlier > 48 && result.all.outlier < 65, `The outlier should fit: ${JSON.stringify(result)}`);
}));

test('secondary peak calls are readable and selecting a marker opens the matching read base', () => withPage(async page => {
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const move = CanvasRenderingContext2D.prototype.moveTo;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'traceCanvasR') window.peakMarkers = [];
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      if (this.canvas.id === 'traceCanvasR' && this.fillStyle === '#d97706' && y === 38.5) window.peakMarkers.push({ x, y: y + 3.5 });
      return move.call(this, x, y);
    };
  });
  await assemble(page);
  assert.equal(await page.locator('#tracePeakInspector').isVisible(), true);
  await page.getByLabel('Choose a peak').selectOption({ label: 'Reverse read 8: T / G' });
  assert.match(await page.locator('#tracePeakPosition').textContent(), /Reverse read, base 8/);
  assert.equal(await page.locator('#tracePrimaryBase').textContent(), 'T');
  assert.equal(await page.locator('#traceSecondaryBase').textContent(), 'G');
  assert.equal(await page.locator('#tracePeakSelect option').count(), 2);
  assert.match(await page.locator('#tracePeakRatio').textContent(), /50.68%/);
  assert.match(await page.locator('#traceCanvasR').getAttribute('aria-label'), /original read base 8/);
  const markers = await page.evaluate(() => window.peakMarkers);
  assert.ok(markers.length >= 1);
  await page.locator('#traceCanvasR').scrollIntoViewIfNeeded();
  const box = await page.locator('#traceCanvasR').boundingBox();
  await page.mouse.click(box.x + markers[0].x, box.y + markers[0].y);
  assert.match(await page.locator('#tracePeakPosition').textContent(), /Reverse read, base 8/);
  assert.match(await page.locator('#tracePeakRatio').textContent(), /50.68%/);
  await page.locator('#traceSection').screenshot({ path: '/tmp/sanger-peak-inspector.png', style: 'astro-dev-toolbar { display: none; }' });
  await page.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await page.getByLabel('Choose a peak').inputValue(), '');
  assert.equal(await page.locator('#tracePeakDetail').isVisible(), false);
}));

test('chromatogram peaks stay out of the position and base labels at high peak height', () => withPage(async page => {
  await demo(page);
  const canvases = page.locator('#traceCanvasF, #traceCanvasR');
  await canvases.evaluateAll(items => {
    window.traceAnnotationBands = items.map(canvas => {
      const ctx = canvas.getContext('2d');
      const ratio = window.devicePixelRatio;
      return [
        ctx.getImageData(0, 0, canvas.width, Math.floor(36 * ratio)).data,
        ctx.getImageData(0, Math.ceil((canvas.clientHeight - 17) * ratio), canvas.width, Math.floor(17 * ratio)).data,
      ];
    });
  });
  await page.locator('#traceAmp').fill('4');
  const changed = await canvases.evaluateAll(items => items.reduce((total, canvas, i) => {
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio;
    const regions = [
      ctx.getImageData(0, 0, canvas.width, Math.floor(36 * ratio)).data,
      ctx.getImageData(0, Math.ceil((canvas.clientHeight - 17) * ratio), canvas.width, Math.floor(17 * ratio)).data,
    ];
    return total + regions.reduce((sum, region, j) => sum + region.reduce((count, value, k) =>
      count + (value !== window.traceAnnotationBands[i][j][k] ? 1 : 0), 0), 0);
  }, 0));
  assert.equal(changed, 0, 'Changing peak height must keep traces away from the position, quality and base labels.');
  await page.locator('#traceSection').screenshot({ path: '/tmp/sanger-viewer-boundaries.png' });
  await page.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await page.locator('#traceAmp').inputValue(), '1');
}));

test('chromatogram scrollbar reaches the end of the read when zoomed in', () => withPage(async page => {
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const drawText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'traceCanvasR') window.traceStartTick = null;
      if (this.canvas.id === 'traceCanvasF') window.traceTicks = [];
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (value, x, y, ...rest) {
      if (this.canvas.id === 'traceCanvasF' && y === 11 && /^\d+$/.test(value)) window.traceTicks.push(Number(value));
      if (this.canvas.id === 'traceCanvasR' && y === 11 && String(value) === '1') window.traceStartTick = x;
      return drawText.call(this, value, x, y, ...rest);
    };
  });
  await demo(page);
  assert.ok(await page.evaluate(() => window.traceStartTick > 8), 'The first base needs room inside the viewport.');
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.locator('#traceScrollBar').evaluate(el => new Promise(resolve => {
    el.addEventListener('scroll', () => requestAnimationFrame(resolve), { once: true });
    el.scrollLeft = el.scrollWidth;
  }));
  const ticks = await page.evaluate(() => window.traceTicks);
  assert.ok(ticks.some(value => value >= 425), `Expected the end of the 430-column demo alignment; visible ticks: ${ticks}`);
}));

test('mobile chromatograms fit the screen and show readable quality scores', () => withPage(async page => {
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (['traceCanvasF', 'traceCanvasR'].includes(this.canvas.id)) {
        (window.clippedTraceLabels ||= {})[this.canvas.id] = [];
      }
      return clearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (value, x, y, ...rest) {
      if (['traceCanvasF', 'traceCanvasR'].includes(this.canvas.id) && y === 22 && /^\d+$/.test(value)) {
        (window.qualityScoresDrawn ||= {})[this.canvas.id] = true;
      }
      if (['traceCanvasF', 'traceCanvasR'].includes(this.canvas.id) && [11, 22, this.canvas.clientHeight - 5].includes(y)) {
        const half = this.measureText(String(value)).width / 2;
        if (x - half < 0 || x + half > this.canvas.clientWidth) window.clippedTraceLabels[this.canvas.id].push(String(value));
      }
      return fillText.call(this, value, x, y, ...rest);
    };
  });
  await demo(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => window.qualityScoresDrawn?.traceCanvasF && window.qualityScoresDrawn?.traceCanvasR), true);
  assert.deepEqual(await page.evaluate(() => window.clippedTraceLabels), { traceCanvasF: [], traceCanvasR: [] });
  await page.locator('#traceSection').screenshot({ path: '/tmp/sanger-viewer-mobile.png' });
  const scrollbar = page.locator('#traceScrollBar');
  assert.ok(await scrollbar.evaluate(el => el.scrollLeft > 0), 'Both reads should be visible at their overlap.');
  await scrollbar.evaluate(el => { el.scrollLeft = 0; });
  assert.equal(await scrollbar.evaluate(el => el.scrollLeft), 0, 'The earlier read end remains accessible.');
}, { width: 390, height: 844 }));

test('final FASTA and server alignment are immediately visible, with clean exports and no JSON', () => withPage(async page => {
  await assemble(page);
  assert.equal(await page.locator('#downloadAnalysisBtn, #summaryCard, #orfStrip, #inspectorStrip').count(), 0);
  assert.equal(await page.locator('#pageTitle').textContent(), 'SangerAnalyst');
  assert.equal(await page.locator('#strictReport').isVisible(), true);
  assert.equal(await page.locator('#strictReport').textContent(), alignment);
  assert.equal(await page.locator('#strictReport .aln-mismatch').count(), 12);
  assert.match(await page.locator('#strict').textContent(), new RegExp(sequence));
  assert.doesNotMatch(await page.locator('#strict').textContent(), /Identity/);
  assert.match(await page.locator('#strictAlignmentStats').textContent(), /Identity80.0%16 \/ 20 alignment columns/);
  assert.match(await page.locator('#server-warn').textContent(), /mixed bases/);
  const fasta = await download(page, page.locator('.download-fasta-btn[data-target="strict"]'));
  assert.match(fasta.name, /fwd_control-high-confidence-consensus.fasta/);
  assert.equal(fasta.text, `>demo_consensus\n${sequence}\n`);
  const raw = await download(page, page.locator('.download-btn[data-target="strict"]'));
  assert.equal(raw.text, report);
  assert.equal(await page.locator('#strict').isVisible(), true);
  assert.equal(await page.locator('#fullReport').isVisible(), false);
  await page.getByRole('tab', { name: 'Full merge', exact: true }).click();
  assert.equal(await page.locator('#strictReport').isVisible(), false);
  assert.equal(await page.locator('#fullReport').isVisible(), true);
  const merged = await download(page, page.locator('.download-fasta-btn[data-target="full"]'));
  assert.equal(merged.text, `>demo_full\n${sequence}\n`);
  await page.screenshot({ path: '/tmp/sanger-desktop-results.png', fullPage: true, style: 'astro-dev-toolbar { display: none; }' });
}));

test('settings and file edits invalidate exports and BLAST', () => withPage(async page => {
  await assemble(page);
  await page.locator('#mottCutoff').fill('0.2');
  assert.equal(await page.locator('#staleResultNotice').isVisible(), true);
  assert.equal(await page.locator('.download-btn[data-target="strict"]').isDisabled(), true);
  assert.equal(await page.locator('.download-fasta-btn[data-target="strict"]').isDisabled(), true);
  assert.equal(await page.locator('.blast-btn[data-target="strict"]').isDisabled(), true);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  await page.locator('#fileF').setInputFiles({ name: 'sample_B_F.ab1', mimeType: 'application/octet-stream', buffer: Buffer.from('ABIFinvalid-trace') });
  assert.equal(await page.locator('#staleResultNotice').isVisible(), true);
  assert.equal(await page.locator('.download-fasta-btn[data-target="strict"]').isDisabled(), true);
}));

test('busy requests lock controls and restore them after API failure', () => withPage(async page => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(api, async route => { await gate; await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, json: { error: 'Choose another pair.' } }); });
  await demo(page);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#mottCutoff').disabled);
  assert.equal(await page.locator('#fileF').isDisabled(), true);
  assert.equal(await page.locator('#swapReadsBtn').isDisabled(), true);
  release();
  await status(page, 'Choose another pair');
  assert.equal(await page.locator('#fileF').isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Analyze', exact: true }).isEnabled(), true);
}));

test('empty consensus and clipboard failure are explained visibly', () => withPage(async page => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
  const warning = 'WARNING: No statistically significant overlap found between Forward and Reverse reads (candidate overlap 15 bp, 8 matches) — High Confidence Consensus is empty; verify both files come from the same amplicon.';
  await assemble(page, { outputs: { consensus_strict: `>empty\n\n# ${warning}\n`, consensus_full: report }, warnings: [warning, 'Review mixed bases.'] });
  assert.equal(await page.locator('#strict').isVisible(), true);
  assert.equal(await page.locator('#strict').textContent(), 'No high-confidence consensus sequence could be made.');
  assert.equal(await page.locator('#server-warn').textContent(), 'WARNING: No high-confidence consensus sequence could be made. Please verify both reads are from the same amplicon.\nReview mixed bases.');
  const raw = await download(page, page.locator('.download-btn[data-target="strict"]'));
  assert.match(raw.text, /candidate overlap 15 bp/);
  assert.equal(await page.locator('.copy-fasta-btn[data-target="strict"]').isDisabled(), true);
  await page.getByRole('tab', { name: 'Full merge', exact: true }).click();
  await page.locator('.copy-fasta-btn[data-target="full"]').click();
  await status(page, 'Could not copy');
  assert.match(await page.locator('#status').textContent(), /Download/);
}));

test('mobile result actions fit the viewport', () => withPage(async page => {
  await assemble(page);
  await page.getByRole('tab', { name: 'Full merge', exact: true }).click();
  await page.locator('.download-fasta-btn[data-target="full"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#fullReport').evaluate(el => getComputedStyle(el).whiteSpace), 'pre');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/sanger-mobile-results.png', fullPage: true, style: 'astro-dev-toolbar { display: none; }' });
}, { width: 390, height: 844 }));

test('local Flask smoke: bundled chromatograms assemble and export', { skip: !process.env.SANGER_INTEGRATION }, () => withPage(async page => {
  await demo(page);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  assert.equal(await page.locator('#primerOutcome').isVisible(), false);
  await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).click();
  assert.match(await page.locator('#primerTrimReport').textContent(), /forward\s+1/);
  assert.doesNotMatch(await page.locator('#results').textContent(), /anchored span/);
  const fasta = await download(page, page.locator('.download-fasta-btn[data-target="primerTrim"]'));
  assert.match(fasta.text.split('\n').slice(1).join(''), /^[ACGTNRYKMSWBDHV]+$/);
  await page.screenshot({ path: '/tmp/sanger-demo-final-results.png', fullPage: true, style: 'astro-dev-toolbar { display: none; }' });
  assert.match(await page.locator('#strictReport').textContent(), /forward\s+1/);
  assert.equal(await page.locator('#fullReport').textContent(), await page.locator('#primerTrimReport').textContent());
  await page.getByLabel('Choose a peak').selectOption({ label: 'Reverse read 8: T / G' });
  for (const [tab, id, position] of [['High confidence', 'strict', 16], ['Full merge', 'full', 44], ['Primer trimmed', 'primerTrim', 19]]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.locator(`#${id} .conflict-base[data-conflict-index="1"]`).click();
    assert.match(await page.locator('#traceReviewLabel').textContent(), new RegExp(`consensus base ${position}\\.`));
    assert.match(await page.locator('#traceCanvasF').getAttribute('aria-label'), /original read base 15/);
    assert.match(await page.locator('#traceCanvasR').getAttribute('aria-label'), /original read base 354/);
    assert.equal(await page.locator('#tracePeakDetail').isVisible(), false);
    await page.locator('#traceSection').screenshot({ path: '/tmp/sanger-conflict-traces.png' });
    await page.getByRole('button', { name: 'Back to result' }).click();
    assert.equal(await page.locator(`#${id} .conflict-base[data-conflict-index="1"]`).evaluate(el => el === document.activeElement), true);
  }
  await page.locator('#primerTrim .conflict-base[data-conflict-index="1"]').click();
  await page.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await page.locator('#traceReview').isVisible(), false);
  assert.equal(await page.locator('#traceCanvasF').getAttribute('aria-label'), 'Forward chromatogram');
  await page.locator('#mottCutoff').fill('0.2');
  assert.equal(await page.locator('#traceReview').isVisible(), false);
  assert.equal(await page.locator('#primerTrim .conflict-base').first().isDisabled(), true);
}));

test('BLAST button copies the selected FASTA, opens NCBI and explains clipboard failure', () => withPage(async page => {
  await page.addInitScript(() => {
    window.blastOpened = [];
    window.open = (...args) => { window.blastOpened.push(args); return null; };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedFasta = text; } } });
  });
  await assemble(page);
  const button = page.locator('.blast-btn[data-target="strict"]');
  assert.equal(await button.evaluate(el => el.previousElementSibling.classList.contains('download-fasta-btn')), true);
  await button.click();
  assert.equal(await page.evaluate(() => window.copiedFasta), `>demo_consensus\n${sequence}\n`);
  assert.match(await page.locator('#strictBlastStatus').textContent(), /FASTA copied/);
  assert.match(await page.evaluate(() => window.blastOpened[0][0]), /^https:\/\/blast.ncbi.nlm.nih.gov/);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await button.click();
  await page.waitForFunction(() => document.getElementById('strictBlastStatus').textContent.includes('Clipboard access was unavailable'));
}));


test('stalled demo requests time out and unlock the form', () => withPage(async page => {
  await page.clock.install();
  await page.route('**/demo/fwd_control.ab1', () => {});
  await page.goto(`${origin}/sangeranalyst/`);
  await page.getByRole('button', { name: 'Try demo data' }).click();
  assert.equal(await page.locator('#fileF').isDisabled(), true);
  await page.clock.fastForward(61000);
  await status(page, 'Demo files took longer than 60 seconds');
  assert.equal(await page.locator('#fileF').isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Try demo data' }).isEnabled(), true);
}));

test('malformed demo primer preserves the current files and fresh results', () => withPage(async page => {
  await assemble(page);
  await page.locator('#fileF').setInputFiles({
    name: 'original_F.ab1', mimeType: 'application/octet-stream',
    buffer: await readFile(new URL('../../public/demo/fwd_control.ab1', import.meta.url)),
  });
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  const currentSequence = await page.locator('#strict').textContent();
  const traces = await page.locator('#traceMeta').textContent();
  await page.route('**/demo/primer_rev.fasta', route => route.fulfill({ body: '>bad\nATGC1\n' }));
  await page.getByRole('button', { name: 'Try demo data' }).click();
  await status(page, 'Could not load demo files');
  assert.equal(await page.locator('#fileF').evaluate(input => input.files[0].name), 'original_F.ab1');
  assert.equal(await page.locator('#strict').textContent(), currentSequence);
  assert.equal(await page.locator('#traceMeta').textContent(), traces);
  assert.equal(await page.locator('#staleResultNotice').isVisible(), false);
  assert.equal(await page.locator('.download-fasta-btn[data-target="strict"]').isEnabled(), true);
}));

test('primer fallback is visible beside the final sequence while successful coordinates stay out of view', () => withPage(async page => {
  await assemble(page, {
    ...fixture,
    outputs: { ...fixture.outputs, primer_trim: report + '# Forward primer not found; using fallback.\n' },
    analysis: { primer_outcomes: {
      forward: { status: 'fallback', message: 'No forward primer anchor; full sequence retained.' },
      reverse: { status: 'matched', message: 'Reverse primer matched.' },
    } },
  });
  assert.match(await page.locator('#primerOutcome').textContent(), /No forward primer anchor/);
  assert.doesNotMatch(await page.locator('#primerOutcome').textContent(), /Reverse primer matched/);
  await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).click();
  assert.equal(await page.locator('#primerTrimReport').isVisible(), true);
}));

test('repeated copy restores its original label', () => withPage(async page => {
  await page.clock.install();
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
  await assemble(page);
  const button = page.locator('.copy-fasta-btn[data-target="strict"]');
  await button.click();
  await page.waitForFunction(() => document.querySelector('.copy-fasta-btn[data-target="strict"]').textContent === 'Copied!');
  await button.click();
  await page.clock.fastForward(1300);
  assert.match(await button.textContent(), /Copy FASTA/);
  assert.doesNotMatch(await button.textContent(), /Copied!/);
}));


test('primer-trimmed FASTA retains the explicitly labelled full read alignment', () => withPage(async page => {
  const primerReport = ">trimmed\nACGTRYSWACGT\n\n# Forward primer anchored span [2 - 25], trimmed 5' ---> [25].\n# Reverse primer anchored span [408 - 428], trimmed [408] ---> 3' side.\n\nconsensus        1 ACGT 4\n                  ||||\nprimer_f         1 ACGT 4";
  await assemble(page, {
    ...fixture, warnings: [], outputs: { ...fixture.outputs, primer_trim: primerReport },
    analysis: { primer_outcomes: {
      forward: { status: 'matched', message: 'Forward primer anchored span [2 - 25], trimmed 5′.' },
      reverse: { status: 'matched', message: 'Reverse primer anchored span [408 - 428].' },
    } },
  });
  await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).click();
  assert.equal(await page.locator('#primerTrim').isVisible(), true);
  assert.equal(await page.locator('#primerOutcome').isVisible(), false);
  assert.doesNotMatch(await page.locator('#results').textContent(), /anchored span/);
  assert.equal(await page.locator('#primerTrimReport').textContent(), alignment);
  assert.match(await page.locator('#primerResultBlock .coordinate-note').textContent(), /not the primer-trimmed FASTA/);
  const fasta = await download(page, page.locator('.download-fasta-btn[data-target="primerTrim"]'));
  assert.equal(fasta.text, '>trimmed\nACGTRYSWACGT\n');
  const raw = await download(page, page.locator('.download-btn[data-target="primerTrim"]'));
  assert.equal(raw.text, primerReport);
}));

test('missing server alignment is explained without inventing a local preview', () => withPage(async page => {
  await assemble(page, { outputs: { consensus_strict: `>sequence\n${sequence}\n`, consensus_full: '' }, warnings: [] });
  assert.match(await page.locator('#strictReport').textContent(), /No read alignment was returned/);
  assert.equal(await page.locator('#strictAlignmentStats').textContent(), '');
  assert.equal(await page.locator('#traceSection').isVisible(), true);
}));

test('invalid primer stays visible and receives focus after validation', () => withPage(async page => {
  await demo(page);
  await page.locator('#primerF-text').fill('ACGT1');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Forward primer:');
  assert.equal(await page.locator('#primerF-text').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('#analyzeBtn').isEnabled(), true);
}));


test('a missing primer at one end keeps its fallback trimming warning visible', () => withPage(async page => {
  const singlePrimer = {
    ...fixture,
    outputs: { ...fixture.outputs, primer_trim: '>trimmed\nACGTACGTACGT\n\n# Forward primer anchored span [2 - 25].\n# No reverse primer file / empty, falling back to consensus strict trim.\n' },
    analysis: { primer_outcomes: {
      forward: { status: 'matched', message: 'Forward primer anchored span [2 - 25].' },
      reverse: { status: 'omitted', message: 'Reverse primer not supplied.' },
    } },
  };
  await page.route(api, route => route.fulfill({ json: singlePrimer, headers: { 'access-control-allow-origin': '*' } }));
  await demo(page);
  await page.getByRole('button', { name: 'Clear Reverse primer', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  assert.equal(await page.locator('#primerOutcome').isVisible(), true);
  assert.match(await page.locator('#primerOutcome').textContent(), /falling back/);
  assert.doesNotMatch(await page.locator('#results').textContent(), /anchored span/);
}));


test('output tabs isolate panels, support keyboard navigation and hide unavailable primer results', () => withPage(async page => {
  await assemble(page);
  const strict = page.getByRole('tab', { name: 'High confidence', exact: true });
  const full = page.getByRole('tab', { name: 'Full merge', exact: true });
  assert.equal(await strict.getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  assert.equal(await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).count(), 0);
  await strict.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await full.getAttribute('aria-selected'), 'true');
  assert.equal(await full.evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('#full').isVisible(), true);
  assert.equal(await page.locator('#strict').isVisible(), false);
  await page.keyboard.press('ArrowRight');
  assert.equal(await strict.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await full.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await strict.getAttribute('aria-selected'), 'true');
  await page.locator('#secPeak').fill('50');
  assert.equal(await page.locator('#staleResultNotice').isVisible(), true);
  await full.click();
  assert.equal(await page.locator('.download-fasta-btn[data-target="full"]').isDisabled(), true);
}));

const secondaryReport = `
# ==== Significant secondary peaks in Forward Chromatogram:
#
# F.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 31           9         A             G         41
#
#=======================================

# ==== Significant secondary peaks in Reverse Chromatogram:
# Note: R.ab1_pos refers to the Reverse Complement of Reverse .ab1 read position
#
# R.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 28           9         G             A         37
#
#=======================================
`;

test('secondary-peak table follows each output consensus coordinate system', () => withPage(async page => {
  await assemble(page, {
    outputs: {
      consensus_strict: report + secondaryReport,
      consensus_full: fullReport + secondaryReport.replaceAll('9         ', '29        '),
      primer_trim: '>trimmed\nACGTRYSWACGT\n' + secondaryReport.replaceAll('9         ', '5         '),
    }, warnings: [],
  });
  assert.equal(await page.locator('#sharedPeaks tbody tr').count(), 2);
  assert.match(await page.locator('#sharedPeaks').textContent(), /41%/);
  assert.equal(await page.locator('[role="tabpanel"] .peak-section').count(), 0);
  assert.equal(await page.locator('.shared-peaks').count(), 1);
  assert.equal(await page.locator('#sharedPeaks tbody tr').first().locator('td').nth(1).textContent(), '9');
  assert.match(await page.locator('#peakThreshold').textContent(), /33%/);
  await page.getByRole('tab', { name: 'Full merge', exact: true }).click();
  assert.equal(await page.locator('#sharedPeaks tbody tr').first().locator('td').nth(1).textContent(), '29');
  await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).click();
  assert.equal(await page.locator('#sharedPeaks tbody tr').first().locator('td').nth(1).textContent(), '5');
  assert.equal(await page.locator('#sharedPeaks tbody tr').first().locator('td').first().textContent(), '31');
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  const raw = await download(page, page.locator('.download-btn[data-target="primerTrim"]'));
  assert.match(raw.text, /Significant secondary peaks/);
  assert.equal(await page.locator('#sharedPeaks .peak-table-wrap').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('#results').screenshot({ path: '/tmp/sanger-tabbed-results.png', style: 'astro-dev-toolbar { display: none; }' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Primer trimmed', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.locator('#sharedPeaks tbody tr').count(), 2);
  assert.equal(await page.locator('.result-tabs').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('#results').screenshot({ path: '/tmp/sanger-tabbed-mobile.png', style: 'astro-dev-toolbar { display: none; }' });
}));

test('empty and missing secondary-peak reports are explained separately', () => withPage(async page => {
  await assemble(page, {
    outputs: { consensus_strict: report + '# No significant secondary peak in "Forward Chromatogram"\n# No significant secondary peak in "Reverse Chromatogram"', consensus_full: fullReport },
    warnings: [],
  });
  assert.match(await page.locator('#sharedPeaks').textContent(), /Forward: no significant/);
  assert.match(await page.locator('#sharedPeaks').textContent(), /Reverse: no significant/);
  await page.getByRole('tab', { name: 'Full merge', exact: true }).click();
  assert.match(await page.locator('#sharedPeaks').textContent(), /were not included/);
  await assemble(page);
  assert.match(await page.locator('#sharedPeaks').textContent(), /were not included/);
}));


test('IUPAC information opens beside the input settings and result highlights have no underlines', () => withPage(async page => {
  await assemble(page);
  assert.equal(await page.locator('#results .base-code-key').count(), 0);
  assert.equal(await page.locator('#peakHeading').textContent(), 'Secondary-peak detection');
  const button = page.getByRole('button', { name: 'IUPAC ambiguity codes', exact: true });
  await button.click();
  assert.equal(await button.textContent(), 'IUPAC ambiguity codes');
  assert.equal(await button.evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#iupac_tooltip').isVisible(), true);
  assert.match(await page.locator('#iupac_tooltip').textContent(), /A \/ G/);
  await button.focus();
  await button.press('Enter');
  assert.equal(await page.locator('#iupac_tooltip').isVisible(), false);
  const decorations = await page.locator('#strictReport .aln-mismatch, #strict .amb').evaluateAll(items => items.map(el => getComputedStyle(el).textDecorationLine));
  assert.ok(decorations.length > 0);
  assert.ok(decorations.every(value => value === 'none'));
  await page.locator('#results').screenshot({ path: '/tmp/sanger-column-highlights.png', style: 'astro-dev-toolbar { display: none; }' });
  await page.setViewportSize({ width: 390, height: 844 });
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await button.click();
  const popup = await page.locator('#iupac_tooltip').boundingBox();
  assert.ok(popup.x >= 0 && popup.x + popup.width <= 390);
  assert.ok(popup.y >= 0 && popup.y + popup.height <= 844);
}));

test('server peak candidates remain cached and refilter when settings change', () => withPage(async page => {
  let calls = 0;
  await page.route(api, route => { calls++; return route.fulfill({json: fixture, headers:{'access-control-allow-origin':'*'}}); });
  await demo(page);
  assert.equal(await page.locator('#tracePeakInspector').isVisible(), false);
  await page.getByRole('button', {name:'Analyze',exact:true}).click();
  await status(page, 'Analysis complete.');
  assert.equal(await page.locator('#tracePeakSelect option').count(), 2);
  await page.locator('#secPeak').fill('100');
  assert.equal(await page.locator('#tracePeakInspector').isVisible(), false);
  await page.locator('#secPeak').fill('33');
  assert.equal(await page.locator('#tracePeakSelect option').count(), 2);
  await page.locator('#mottCutoff').fill('1');
  assert.equal(await page.locator('#tracePeakSelect option').count(), 4);
  assert.equal(calls, 1);
  assert.equal(await page.locator('#staleResultNotice').isVisible(), true);
  await page.locator('#fileR').setInputFiles([]);
  assert.equal(await page.locator('#tracePeakInspector').isVisible(), false);
}));
