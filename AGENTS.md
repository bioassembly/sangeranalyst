# AGENTS.md

Astro static site for SangerAnalyst — single page (`src/pages/index.astro`), vanilla CSS (`src/styles/global.css`), one client script (`src/scripts/app.js`). No Tailwind, no MDX, no tests.

## Commands

```bash
npm ci            # install
npm run dev       # dev server (http://localhost:4321/sangeranalyst/)
npm run build     # build to dist/
npm run preview   # serve dist/
```

CI (`.github/workflows/ci.yml`) gates every push/PR on `npm run build` + `npx html-validate dist/index.html` (config: `.htmlvalidate.json`; inline styles are intentionally allowed). Run both locally before pushing.

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

- Element IDs are the coupling point between `index.astro` and `app.js` (`fileF`, `fileR`, `mottCutoff`, `qPhred`, `secPeak`, `primerF-file`/`primerF-text`, `primerR-*`, result `<pre>`s `strict`/`full`/`primerTrim`, `loadDemoBtn`). Renaming one side breaks the other silently.
- Client enforces 5 MB max per input; keep that limit when touching validation.
- Pasted primers are validated by `cleanAndValidateDNA(seq, 10)` — IUPAC ambiguity codes accepted, minimum 10 bases; alert text must stay in sync with that behavior. Primer *files* get the same validation via `validatePrimerFile`.
- A valid pasted primer overrides a selected primer file (`pF = pF_t`) — after that, `pF` is a string, not a File. Any code touching `pF` must guard with `instanceof File` (this exact bug shipped once).
- "Try demo data" button fetches from `public/demo/` using the base path — keep those files in sync if demo assets move.
- Settings (`mottCutoff`, `qPhred`, `secPeak`) persist in localStorage under key `sangeranalyst-settings`; values are clamped to input min/max on load.
