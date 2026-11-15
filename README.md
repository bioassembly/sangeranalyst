# SangerAnalyst

A free web app for assembling paired Sanger chromatograms into consensus sequences, with quality trimming, primer trimming, and interactive trace review.

**[Open SangerAnalyst](https://bioassembly.github.io/sangeranalyst/)** | **[Analysis API repository](https://github.com/bioassembly/sangeranalyst-api)**

Upload forward and reverse `.ab1` files, optionally add primers, and select **Analyze**. Each result combines its final FASTA, read-coverage map, read alignment, and exports in one tab.

## Features

- **Chromatogram viewer:** reads load immediately, including the bundled demo. Zoom, pan, inspect quality scores, and review Mott-trimmed regions. Balanced peak scaling keeps typical peaks readable; **Fit all peaks** shows the full signal height.
- **Quality-aware assembly:** Mott trimming, automatic read orientation, statistically validated overlap, and Phred-guided conflict resolution.
- **Result maps:** forward and reverse coverage share a full-merge coordinate axis. Red boundaries mark the region used for each consensus; excluded regions are shaded. Colours distinguish mismatches, mixed bases, and uncalled bases (`NNNN`); white gaps appear only on the affected read.
- **Primer review:** binding sites appear beside their corresponding template reads, with gapped primer alignments and a read alignment cropped to the sequence retained after primer trimming.
- **Trace navigation:** select a highlighted conflict or secondary-peak result to inspect its original chromatogram bases, then return to the result.
- **Exports:** copy or download clean FASTA and complete text reports. **NCBI BLASTn** opens the search page and copies the chosen FASTA for pasting.
- **Input handling:** drag-and-drop read pairing, Forward/Reverse swap, and uploaded or pasted primers. Processing settings are remembered in your browser.

## Analyze a sample

1. Open the app and upload the forward and reverse `.ab1` files, or select **Try demo data**.
2. Optionally supply one or both primers as raw DNA or a single FASTA record. Use IUPAC DNA codes and at least 10 bases. The interface limits each input file to 5 MB.
3. Review the chromatograms and adjust the settings if needed.
4. Select **Analyze**. Uploaded data is deleted immediately after processing.
5. Review the result tabs, warnings, and highlighted bases before exporting a sequence.

| Setting | Default | Effect |
| --- | --- | --- |
| Mott trim cutoff | `0.1` | Sets the error-probability cutoff used to select the retained read window. |
| Minimum base Phred quality | `20` | Controls which base calls can support consensus decisions; positions without sufficient support become `N`. |
| Secondary-peak threshold | `33%` | Minimum secondary-signal height relative to the primary signal for a candidate peak. |

### Choose the appropriate output

| Result tab | Sequence included | What to review |
| --- | --- | --- |
| **High confidence** | The statistically validated overlap between the reads. | Conflicts, gaps, and quality within the shared region. If the overlap fails validation, no high-confidence consensus is produced. |
| **Full merge** | The entire aligned read span, including single-read ends. | Bases outside the overlap have support from only one read. |
| **Primer trimmed** | The full merge after primer-boundary trimming; shown when primers are supplied. | Binding alignments and any fallback warnings. Primer trimming does not make single-read regions high confidence. |

The primer-trimmed read alignment shows only the retained columns and preserves the quality-trimmed, oriented read positions. Its binding map and primer-alignment coordinates refer to **Full merge**. Reverse-primer alignments use the reverse complement of the supplied primer.

### Secondary peaks and mixed bases

Secondary-peak screening runs on the **server**, once per original read during analysis. The browser receives a candidate cache and filters it when the Mott cutoff or peak threshold changes. It does not run a second peak-detection engine. Markers therefore appear after analysis and exclude Mott-trimmed regions.

The secondary-peak table is shared across the result tabs. Its consensus positions follow the selected output; original `.ab1` positions identify the same trace bases throughout.

A secondary peak alone does not change the consensus to an IUPAC ambiguity code. Both read calls must meet the quality threshold and disagree, with a secondary peak supporting that base pair on at least one read. Otherwise, the quality-based consensus rules apply. The demo can contain a secondary peak without producing an IUPAC mixed-base call.

Changing reads, primers, or processing settings marks the previous analysis as stale and disables exports until **Analyze** runs again. Cached trace markers can still be filtered while reviewing changed settings.

## Run locally

The frontend and API are separate repositories. **Both servers are needed for local analysis.** Chromatogram viewing works before the API is started.

Use Node.js 22, as in frontend CI, and Python 3.12 for the API's validated CI environment.

```bash
git clone https://github.com/bioassembly/sangeranalyst.git
git clone https://github.com/bioassembly/sangeranalyst-api.git
```

Start the API in one terminal:

```bash
cd sangeranalyst-api
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python app.py
```

Start the frontend in another terminal:

```bash
cd sangeranalyst
npm ci
npm run dev
```

Open **http://localhost:4321/sangeranalyst/**. Pages served from `localhost` or `127.0.0.1` automatically use `http://127.0.0.1:8000/process`; the hosted site uses the PythonAnywhere API.

If **Analyze** reports that the server cannot be reached, check **http://127.0.0.1:8000/health** and confirm the API terminal is running. A working frontend alone does not confirm API connectivity. The default API CORS allowlist includes the frontend's development port `4321`.

## Development checks

Run these from the frontend repository:

```bash
npm test
npm run build
npx --yes html-validate dist/index.html
```

Browser regression tests use Playwright Core:

```bash
node node_modules/playwright-core/cli.js install chromium
npm run test:browser
```

To use an existing Chrome installation, set `PLAYWRIGHT_CHROME_PATH` to its executable. To include the real local API smoke test, start the API and run:

```bash
SANGER_INTEGRATION=1 npm run test:browser
```

The browser suite starts an Astro development server if one is not already running. Without `SANGER_INTEGRATION=1`, analysis responses are mocked for interface checks.

### Repository layout

| Path | Purpose |
| --- | --- |
| `src/pages/index.astro` | Upload form, chromatograms, and result tabs. |
| `src/scripts/app.js` | Input handling, API requests, and result interactions. |
| `src/scripts/results.js` | Report parsing, coverage maps, and alignment presentation. |
| `src/scripts/traceviewer.js` | ABIF parsing and chromatogram viewer. |
| `src/scripts/sequtils.js` | Sequence, FASTA, primer, and file-pairing helpers. |
| `src/scripts/runstate.js` | Completed-analysis snapshots and stale-result handling. |
| `src/styles/global.css` | Interface styles. |
| `public/demo/` | Bundled read pair and primers. |
| `tests/` | Unit tests and browser regression checks. |

### Deployment

Pushes to `main` run the checks and deploy the built `dist/` directory to GitHub Pages. Repository **Settings → Pages → Source** must be **GitHub Actions**.

The default base path is `/sangeranalyst/`. `SITE_URL` and `BASE_PATH` can override the Astro deployment configuration. Assets must respect the base path. The analysis API is deployed separately; see its [README](https://github.com/bioassembly/sangeranalyst-api#readme) for PythonAnywhere setup.

## Demo data

**Try demo data** loads these files from [`public/demo/`](public/demo/):

- `fwd_control.ab1`
- `rev_control.ab1`
- `primer_fwd.fasta`
- `primer_rev.fasta`

Source: publicly available control reads from *Raw Sanger sequencing data for CRISPR-Cas9 edited cane toad tyrosinase gene*, [DOI: 10.1101/2025.05.15.654396](https://doi.org/10.1101/2025.05.15.654396). Provenance is recorded in [`source.txt`](public/demo/source.txt).

## Further improvements

Proposals and review notes are tracked in the [UI improvement plan](docs/UI_IMPROVEMENT_PLAN.md). Larger potential additions include reference-sequence comparison and batch processing.

SangerAnalyst uses [Biopython](https://biopython.org/) for chromatogram parsing and core sequence analysis, with an Astro frontend and Flask API.
