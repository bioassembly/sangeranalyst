# AGENTS.md

Astro static site for SangerAnalyst — single page (`src/pages/index.astro`), vanilla CSS (`src/styles/global.css`), client scripts `src/scripts/app.js` (main) + `src/scripts/traceviewer.js` (chromatogram viewer, imported by app.js). No Tailwind, no MDX, no tests.

## Commands

```bash
npm ci            # install
npm run dev       # dev server (http://localhost:4321/sangeranalyst/)
npm run build     # build to dist/
npm run preview   # serve dist/
```

CI (`.github/workflows/ci.yml`) gates pushes to `main` and all PRs on `npm run build` + `npx html-validate dist/index.html` (config: `.htmlvalidate.json`; inline styles are intentionally allowed). Run both locally before pushing — note `html-validate` is not a devDependency, so `npx` downloads it on first run.

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
Response JSON: `data.outputs.consensus_strict`, `data.outputs.consensus_full`, optional `data.outputs.primer_trim`.

## Coupling points & gotchas

- Element IDs are the coupling point between `index.astro` and `app.js` (`fileF`, `fileR`, `mottCutoff`, `qPhred`, `secPeak`, `primerF-file`/`primerF-text`, `primerR-*`, result `<pre>`s `strict`/`full`/`primerTrim`, `loadDemoBtn`, trace viewer: `traceSection`/`traceCanvasF`/`traceCanvasR`/`traceMeta`/`traceZoomIn`/`traceZoomOut`/`traceReset`/`traceAmp`). Renaming one side breaks the other silently.
- The chromatogram viewer (`traceviewer.js`) parses AB1 **client-side** — directory entries are 28 bytes with type/size at +8/+10, count at +12, dataSize at +16, dataOffset at +20; decode numerics by `elemSize` (type codes are unreliable across instruments); `dataSize <= 4` means data is inline in the entry's handle field. Quality comes from `PCON2`/`PCON1` (not PQUAL). When reverse-complementing for display, the DATA channels must be complement-swapped (A↔T, G↔C) WITHOUT reversing sample order — reversing ploc alone leaves peaks colored by the wrong base (this bug shipped once). Forward/reverse traces are stacked in shared coordinates via a client-side semi-global Needleman-Wunsch (`alignColumns`: free end gaps, traceback from the best bottom/right edge cell — the reads' 3′ overhangs mean the corner is usually NOT the optimal endpoint). Y-axis uses a 99.5th-percentile full-trace scale; the `traceAmp` slider is the volume control. Initial view shows the first ~40 columns; the ruler is 1-based with adaptive tick steps; Q numbers appear above quality bars when column spacing ≥14px.
- Consensus outputs are rendered via `renderSeq` (innerHTML) which wraps IUPAC ambiguity codes in `<span class="amb">` on non-`#`/non-`>` lines. Copy/download use `innerText`, so spans don't leak into copied text.
- File inputs pre-validate on change: ABIF magic bytes + 5 MB size, inline error `<div class="file-err">` inserted after the input (`fileFErr`/`fileRErr`). Backend errors are mapped: 400 shows the backend's JSON message, 413/500 get friendly overrides.
- Client enforces 5 MB max per file and 5M characters per pasted primer; keep that limit when touching validation.
- Pasted primers are validated by `cleanAndValidateDNA(seq, 10)` — IUPAC ambiguity codes accepted, minimum 10 bases; alert text must stay in sync with that behavior. Primer *files* get the same validation via `validatePrimerFile`.
- A valid pasted primer overrides a selected primer file (`pF = pF_t`) — after that, `pF` is a string, not a File. Any code touching `pF` must guard with `instanceof File` (this exact bug shipped once).
- "Try demo data" button fetches from `public/demo/` using the base path — keep those files in sync if demo assets move.
- Settings (`mottCutoff`, `qPhred`, `secPeak`) persist in localStorage under key `sangeranalyst-settings`; values are clamped to input min/max on load.
