# AGENTS.md

Astro static site for SangerAnalyst — single page (`src/pages/index.astro`), vanilla CSS (`src/styles/global.css`), client scripts `src/scripts/app.js` (main) + `src/scripts/results.js` (final-alignment presentation) + `src/scripts/traceviewer.js` (ABIF parser and trace utilities) + `src/scripts/sequtils.js` (pure FASTA/primer/report-rendering/file-pairing helpers), unit tests in `tests/*.test.mjs`. No Tailwind, no MDX.

## Commands

```bash
npm ci            # install
npm test          # run Node unit tests (ABIF parser, Mott trim, primer, FASTA/report helpers)
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
Response JSON: `data.outputs.consensus_strict`, `data.outputs.consensus_full`, optional `data.outputs.primer_trim`, and `data.warnings[]` rendered using textContent. Optional `data.analysis` supplies primer outcomes; failed matches/fallbacks stay visible. There is no analysis JSON download. Non-ORF `data.summary` remains available to API clients but is not rendered. No ORF or inspector dashboard is maintained.

## Coupling points & gotchas

- Element IDs are the coupling point between `index.astro` and `app.js` (`fileF`, `fileR`, `swapReadsBtn`, `mottCutoff`, `qPhred`, `secPeak`, `primerF-file`/`primerF-text`/`primerF-label`, `primerR-*`, result `<pre>`s `strict`/`full`/`primerTrim` and their `Report` counterparts, `loadDemoBtn`). Update both sides together.
- Preserve the original blue theme, page width, header, and form layout. Results use a Quarto-style output tabset (High confidence, Full merge, optional Primer trimmed) with native ARIA tab keyboard navigation. Input chromatograms load client-side as soon as reads are selected or the demo is loaded; the analysis API is not needed to display traces. Final sequences and read alignments come from the API. `results.js` extracts paired-read alignment blocks from reports without changing coordinates or spacing. Primer-trimmed output crops the existing server alignment to the retained consensus span, preserving oriented-read positions and recalculating identity/gap metrics for that span.
- `traceviewer.js` provides `parseABIF` and the input chromatogram viewer, including zoom, pan, orientation, and quality overlays. Keep its canvas/control IDs in sync with `app.js` and `index.astro`. Demo, drop, and swap operations must refresh both traces after updating the read files. Keep ABIF parsing and quality tests when changing presentation.
- Balanced peak scaling uses one linear scale per visible read and explicitly marks tall peaks that exceed the plot; Fit all peaks displays the full signal. Scaling is visual only: secondary-peak ratios always come from the original traces. The marker picker uses original .ab1 positions and labels bases in the displayed orientation. Secondary peaks are screened only on the server. Its response includes original-read candidates down to 1% across the full read, so the viewer can filter changed Mott windows and thresholds without re-screening. The consensus uses only candidates inside its request Mott window and threshold. Changing files clears the cache; settings changes retain it. On-canvas calls use separate primary and secondary letter rows.
- Consensus outputs are rendered via `renderSeq` (`sequtils.js:renderReportHtml`) which wraps IUPAC ambiguity codes in `<span class="amb">` strictly on FASTA sequence lines (between `>` and the first blank/`#` line). Clean FASTA exports (`extractCleanFasta`) strip all `#` report and alignment lines.
- File inputs pre-validate on change: ABIF magic bytes + 5 MB size, inline error `<div class="file-err">` inserted after the input (`fileFErr`/`fileRErr`). Backend errors are mapped: 400 shows the backend's JSON message, 413/500 get friendly overrides.
- Client enforces 5 MB max per file and 5M characters per pasted primer; keep that limit when touching validation.
- Pasted primers are validated by `cleanAndValidateDNA(seq, 10)` — IUPAC ambiguity codes accepted, minimum 10 bases; validation messages must stay in sync with that behavior. Primer *files* get the same validation via `validatePrimerFile`.
- Active primer mode (`isPrimerFileMode`) determines whether the file input or text input is read (`pF` may be a `File` or string — guard file checks with `instanceof File`).
- "Try demo data" button fetches from `public/demo/` using the base path — keep those files in sync if demo assets move.
- Settings (`mottCutoff`, `qPhred`, `secPeak`) persist in localStorage under key `sangeranalyst-settings`; values are clamped to input min/max on load.

## Result state and validation

`runstate.js` binds immutable request snapshots to completed outputs. Any analysis input change makes exports stale until rerun. Input controls are locked during async validation, analysis, and demo loading. Keep raw reports separate from displayed FASTA so exports remain unchanged. Primer normalization in `sequtils.js` matches the API: exactly one FASTA record or raw IUPAC DNA, 10–5M bases, no digits. Ambiguous dropped pairs require explicit slot assignment. Browser regression checks run with `npm run test:browser`; local API smoke uses `SANGER_INTEGRATION=1`.

Primer trimmed results show full read coverage and separate labelled primer-binding rows on one full-merge axis, with a Primer colour key, the retained consensus, and gapped primer alignments. The cropped read alignment reflows into 60-column blocks while retaining oriented-read coordinates and genuine single-read terminal gaps. Reverse primer alignment uses its reverse complement; alignment bases come from the server's unmasked assembly. Routine trimming commentary stays in text reports. Failed matches, fallback trimming (including an omitted end when one primer is supplied), and scientific warnings stay visible.

Secondary-peak detection is shared outside the output tabs and follows the selected output report, explicitly labelled with that output’s consensus coordinates. Explicit no-peak messages differ from missing report data. Conflict links use each output's report coordinates; primer-trimmed links use verified primer boundaries or a unique exact segment in the full merge and align to the cropped display columns. Read-coverage maps in Full merge and High confidence use full-merge coordinates and a solid total-length dimension. All maps mark the selected consensus span with red boundaries and grey excluded regions, and label the retained row Consensus. Bars annotate server-alignment mismatches, consensus IUPAC mixed bases, internal gaps, and uncalled bases. White gaps appear only on the read containing the gap, not on its partner or the consensus; excluded regions use a light transparent grey overlay. Single-read overhangs are not internal-gap markers. Rejected overlap never receives retained markers. Use the API summary orientation for reverse trace navigation: legacy report labels always say reverse complement, including raw-oriented reads. Keep input chromatograms and secondary-peak markers available.
