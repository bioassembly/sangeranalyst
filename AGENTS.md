# AGENTS.md

Astro static site for SangerAnalyst — single page (`src/pages/index.astro`), vanilla CSS (`src/styles/global.css`), client scripts `src/scripts/app.js` (main) + `src/scripts/traceviewer.js` (chromatogram viewer) + `src/scripts/sequtils.js` (pure FASTA/ORF/report-parsing/file-pairing helpers), unit tests in `tests/*.test.mjs`. No Tailwind, no MDX.

## Commands

```bash
npm ci            # install
npm test          # run Node unit tests (ABIF parser, Mott trim, ORF, FASTA/report helpers)
npm run dev       # dev server (http://localhost:4321/sangeranalyst/)
npm run build     # build to dist/
npm run preview   # serve dist/
```

CI (`.github/workflows/ci.yml`) gates pushes to `main` and all PRs on `npm test` + `npm run build` + `npx html-validate dist/index.html` (config: `.htmlvalidate.json`; inline styles are intentionally allowed). Run all three locally before pushing — note `html-validate` is not a devDependency, so `npx` downloads it on first run.

## Deploy — GitHub Pages via Actions

- Push to `main` → workflow builds `dist/` and deploys via `actions/deploy-pages`. Live at https://bioassembly.github.io/sangeranalyst
- One-time manual switch required: repo **Settings → Pages → Source must be "GitHub Actions"** (was legacy branch deploy before the Astro migration).
- Site is served under `/sangeranalyst/`. Base path is baked into URLs at build time (`astro.config.mjs`, overridable via `SITE_URL`/`BASE_PATH` env). In templates use `import.meta.env.BASE_URL`; in client code use `document.documentElement.dataset.base`. Never hardcode root-absolute asset paths like `/assets/...`.

## Backend is external — not in this repo

- Analysis runs on a remote API: `https://shiddharta.pythonanywhere.com/process`. Nothing about trimming/alignment logic can be changed here; this repo is UI only.
- `BACKEND_URL` (top of `src/scripts/app.js`) auto-switches: pages served from `localhost`/`127.0.0.1` target a local backend at `http://127.0.0.1:8000/process`; everything else hits production.
- Feedback form posts to a Formspree endpoint (`FORMSPREE_ENDPOINT` in `app.js`).

## API contract (frontend ↔ backend)

POST multipart FormData with fields: `fileF`, `fileR` (.ab1), optional `primerF`/`primerR` (uploaded file or pasted sequence), `mottCutoff`, `minPhred`, `secondary_peak_threshold`.
Response JSON: `data.outputs.consensus_strict`, `data.outputs.consensus_full`, optional `data.outputs.primer_trim`, `data.warnings[]` (server-side analysis warnings rendered as a `#server-warn` banner above results — textContent only, never innerHTML), and optional `data.summary` (overlap/GC/ORF/conflicts/secondary_peaks metadata; `sequtils.js:buildSummaryFromOutputs` parses legacy text outputs when `data.summary` is absent so frontend/backend can deploy independently).

## Coupling points & gotchas

- Element IDs are the coupling point between `index.astro` and `app.js` (`fileF`, `fileR`, `swapReadsBtn`, `mottCutoff`, `qPhred`, `secPeak`, `primerF-file`/`primerF-text`/`primerF-label`, `primerR-*`, result `<pre>`s `strict`/`full`/`primerTrim`, `summaryCard`/`summaryMetrics`/`orfStrip`/`inspectorStrip`, `loadDemoBtn`, trace viewer: `traceSection`/`traceCanvasF`/`traceCanvasR`/`traceMeta`/`traceFocusPill`/`traceZoomIn`/`traceZoomOut`/`traceReset`/`traceAmp`/`traceScrollBar`). Renaming one side breaks the other silently.
- The chromatogram viewer (`traceviewer.js`) parses AB1 **client-side** — directory entries are 28 bytes with type/size at +8/+10, count at +12, dataSize at +16, dataOffset at +20; `dataSize <= 4` means data is inline at `entryOffset + 20` (e.g. `FWO_1`); text (`readText`) and numeric (`readNumbers`) readers are strictly separated so `PCON2` quality scores >=32 are never misread as ASCII. Quality comes from `PCON2`/`PCON1`. When reverse-complementing for display, the DATA channels must be complement-swapped (A↔T, G↔C) WITHOUT reversing sample order. Forward/reverse traces are stacked in shared coordinates via a client-side semi-global Needleman-Wunsch (`alignColumns`). `focusBase({ fPos, rPos })` jumps using raw 1-based read coordinates mapped through `colOf` — never post-trim consensus coordinates directly.
- Consensus outputs are rendered via `renderSeq` (`sequtils.js:renderReportHtml`) which wraps IUPAC ambiguity codes in `<span class="amb">` strictly on FASTA sequence lines (between `>` and the first blank/`#` line). Clean FASTA exports (`extractCleanFasta`) strip all `#` report and alignment lines.
- File inputs pre-validate on change: ABIF magic bytes + 5 MB size, inline error `<div class="file-err">` inserted after the input (`fileFErr`/`fileRErr`). Backend errors are mapped: 400 shows the backend's JSON message, 413/500 get friendly overrides.
- Client enforces 5 MB max per file and 5M characters per pasted primer; keep that limit when touching validation.
- Pasted primers are validated by `cleanAndValidateDNA(seq, 10)` — IUPAC ambiguity codes accepted, minimum 10 bases; alert text must stay in sync with that behavior. Primer *files* get the same validation via `validatePrimerFile`.
- Active primer mode (`isPrimerFileMode`) determines whether the file input or text input is read (`pF` may be a `File` or string — guard file checks with `instanceof File`).
- "Try demo data" button fetches from `public/demo/` using the base path — keep those files in sync if demo assets move.
- Settings (`mottCutoff`, `qPhred`, `secPeak`) persist in localStorage under key `sangeranalyst-settings`; values are clamped to input min/max on load.
