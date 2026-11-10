import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4321';
const api = 'http://127.0.0.1:8000/process';
const sequence = 'ACGTACGTRYSWACGTACGT';
const report = `>demo_consensus\n${sequence}\n\n# Identity: 19/20 (95%)\n# Conflict report\n`;
const fixture = {
  outputs: { consensus_strict: report, consensus_full: report },
  warnings: ['Review mixed bases before use.'],
  analysis: { schema_version: 1, tool: { revision: 'fixture-revision' } },
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

test('clean FASTA, report disclosure, removed dashboard, and request-bound metadata', () => withPage(async page => {
  await assemble(page);
  assert.equal(await page.locator('#summaryCard, #orfStrip, #inspectorStrip, #traceFocusPill').count(), 0);
  assert.match(await page.locator('#strict').textContent(), new RegExp(sequence));
  assert.doesNotMatch(await page.locator('#strict').textContent(), /Identity/);
  assert.equal(await page.locator('#strictReport').isVisible(), false);
  await page.locator('.result-block').first().getByText('Full report', { exact: true }).click();
  assert.match(await page.locator('#strictReport').textContent(), /# Identity/);
  assert.match(await page.locator('#server-warn').textContent(), /mixed bases/);
  const fasta = await download(page, page.locator('.download-fasta-btn[data-target="strict"]'));
  assert.match(fasta.name, /fwd_control-high-confidence-consensus.fasta/);
  assert.equal(fasta.text, `>demo_consensus\n${sequence}\n`);
  const metadata = JSON.parse((await download(page, page.locator('#downloadAnalysisBtn'))).text);
  assert.equal(metadata.inputs.forward.filename, 'fwd_control.ab1');
  assert.deepEqual(metadata.parameters, { mottCutoff: 0.1, minPhred: 20, secondary_peak_threshold: 33 });
  assert.equal(metadata.outputs.consensus_strict.sequence_sha256, createHash('sha256').update(sequence).digest('hex'));
  assert.equal(metadata.server_provenance.tool.revision, 'fixture-revision');
}));

test('settings and file edits invalidate exports and BLAST', () => withPage(async page => {
  await assemble(page);
  await page.locator('#mottCutoff').fill('0.2');
  assert.equal(await page.locator('#staleResultNotice').isVisible(), true);
  assert.equal(await page.locator('#downloadAnalysisBtn').isDisabled(), true);
  assert.equal(await page.locator('.download-fasta-btn[data-target="strict"]').isDisabled(), true);
  assert.equal(await page.locator('.blast-link[data-target="strict"]').isVisible(), false);
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
  await assemble(page, { outputs: { consensus_strict: '>empty\n\n# WARNING: no overlap\n', consensus_full: report }, warnings: ['No statistically validated overlap.'] });
  assert.equal(await page.locator('#strictEmpty').isVisible(), true);
  assert.equal(await page.locator('.copy-fasta-btn[data-target="strict"]').isDisabled(), true);
  await page.locator('.copy-fasta-btn[data-target="full"]').click();
  await status(page, 'Could not copy');
  assert.match(await page.locator('#status').textContent(), /Download/);
}));

test('mobile result actions fit the viewport', () => withPage(async page => {
  await assemble(page);
  await page.locator('.download-fasta-btn[data-target="full"]').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/sanger-mobile-results.png', fullPage: true });
}, { width: 390, height: 844 }));

test('local Flask smoke: bundled chromatograms assemble and export', { skip: !process.env.SANGER_INTEGRATION }, () => withPage(async page => {
  await demo(page);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  const fasta = await download(page, page.locator('.download-fasta-btn[data-target="strict"]'));
  assert.match(fasta.text.split('\n').slice(1).join(''), /^[ACGTNRYKMSWBDHV]+$/);
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

test('malformed demo primer preserves the current files, traces, and fresh results', () => withPage(async page => {
  await assemble(page);
  await page.locator('#fileF').setInputFiles({
    name: 'original_F.ab1', mimeType: 'application/octet-stream',
    buffer: await readFile(new URL('../../public/demo/fwd_control.ab1', import.meta.url)),
  });
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await status(page, 'Analysis complete.');
  const traces = await page.locator('#traceMeta').textContent();
  await page.route('**/demo/primer_rev.fasta', route => route.fulfill({ body: '>bad\nATGC1\n' }));
  await page.getByRole('button', { name: 'Try demo data' }).click();
  await status(page, 'Could not load demo files');
  assert.equal(await page.locator('#fileF').evaluate(input => input.files[0].name), 'original_F.ab1');
  assert.equal(await page.locator('#traceMeta').textContent(), traces);
  assert.equal(await page.locator('#staleResultNotice').isVisible(), false);
  assert.equal(await page.locator('.download-fasta-btn[data-target="strict"]').isEnabled(), true);
}));

test('primer fallback is visible while reports are collapsed', () => withPage(async page => {
  await assemble(page, {
    ...fixture,
    outputs: { ...fixture.outputs, primer_trim: report + '# Forward primer not found; using fallback.\n' },
    analysis: { primer_outcomes: {
      forward: { status: 'fallback', message: 'No forward primer anchor; full sequence retained.' },
      reverse: { status: 'matched', message: 'Reverse primer matched.' },
    } },
  });
  assert.match(await page.locator('#primerOutcome').textContent(), /No forward primer anchor/);
  assert.match(await page.locator('#primerOutcome').textContent(), /Reverse primer matched/);
  assert.equal(await page.locator('#primerTrimReport').isVisible(), false);
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
