# Assembly-Focused Implementation Results

Implemented the core roadmap across the frontend and API. Batch assembly, reference mapping, manual editing, and the separate ORF/motif project remain deferred. Validation was performed locally before committing; deployment verification remains pending.

## Changes

- Removed both ORF implementations, protein export, Assembly Summary & Inspector markup/styles, and unused trace-focus plumbing. The transitional API returns `summary.longest_orf: null`; non-ORF metadata remains available.
- Show clean nucleotide FASTA first; retain full reports in disclosures, visible warnings and per-primer outcomes, and per-output BLAST links using an explicit copy/paste workflow.
- Bind results, filenames, exports, settings, and primers to request snapshots. Input edits invalidate exports. Processing and demo loading lock changing controls; stale responses cannot replace current results. Demo loading has a 60-second timeout and validates all payloads before replacing inputs.
- Align defaults at Mott 0.1, Phred 20, secondary peaks 33. Accept one UTF-8 FASTA record or raw IUPAC primer DNA, 10–5M bases and 5 MB input. Reject digits, multiple records, malformed encoding, and uncertain automatic read pairing.
- Export analysis.json with request settings, normalized primers, SHA-256 input/sequence hashes, warnings, and available server software provenance. Legacy APIs explicitly lack server provenance.
- Add backend CI/pinned requirements, a declared benchmark manifest/reviewed baseline, shared Python/JavaScript trim fixtures, browser workflow tests, and frontend CI browser checks.
- Preserve deletion/retention wording and behavior.

## Validation

| Command | Result |
| --- | --- |
| Frontend `npm test` / `node --test tests/*.test.mjs` | All four unit-test files pass, including shared trim fixtures, primer validation, and snapshot/export tests. |
| API `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /tmp/sanger-api-venv/bin/python -m pytest tests/ -q` | 255 passed. |
| API `python benchmarks/benchmark_cohort.py --json --check-baseline` | Exit 0; all 9 declared public pairs match the baseline. |
| Demo reports at explicit 0.1/20/33 settings | Strict, full merge, and primer-trimmed reports match the pre-edit baseline byte-for-byte. |
| `git diff --check` in each repository | Pass. |

The full Astro 6 production build and browser assertions could not be verified in this sandbox. Registry access failed with DNS errors; the available cached Astro installation is version 4 and is not a substitute for the declared version. Local server binding failed with EPERM, and Chromium launch was also denied by sandbox restrictions. Browser tests and CI wiring are included, but no browser assertion or visual screenshot check is claimed to have passed. A fresh installation of the pinned Python CI environment was also not performed; the tests used the existing isolated Python 3.12/Biopython 1.84 environment.

## Release notes

- Deploy frontend changes before the API transition and check consumers expecting a non-null ORF object.
- Direct API/library callers omitting parameters now use the UI defaults; explicit parameters retain prior behavior.
- On an unrestricted development machine, run `npm ci`, `npm run build`, HTML validation, and the browser suite before release. The optional local integration smoke needs the sibling Flask API on port 8000.
