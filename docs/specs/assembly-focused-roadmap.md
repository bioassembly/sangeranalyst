# SangerAnalyst: Assembly-Focused Improvement Plan

**Status:** Core implementation completed locally; see [implementation results](assembly-implementation.md) for validation limits.
**Prepared:** 2026-11-09.
**Scope:** The `sangeranalyst/` frontend and `sangeranalyst-api/` backend.
**Source baseline:** Frontend `a669f74`; backend `fff5905`. Both working trees were clean when inspected.

## 1. Product direction and decisions

Keep SangerAnalyst focused on assembling a forward/reverse chromatogram pair into usable nucleotide sequences. The interface should put reads, traces, warnings, and outputs first.

**Requested decisions:**

- Remove the ORF finder and protein FASTA action. A future organism-aware ORF/motif tool is a separate project, not an additional mode in this application.
- Remove the entire **Assembly Summary & Inspector** panel, including metric tiles, conflict/peak pills, and its decorative status messages.
- Exclude changes to deletion/retention wording, as requested in the follow-up.
- Implementation was authorized in the follow-up. Deployment and creation of another project remain outside this change.

**Recommended assumptions for implementation:**

- Preserve the chromatogram viewer, quality bars, trim shading, secondary-peak markers, zoom/pan controls, and assembly warnings.
- Preserve strict consensus, full merge, optional primer-trimmed output, nucleotide FASTA exports, and full text reports.
- Keep non-ORF structured API metadata for compatibility and testing. Removing a visual summary does not require deleting useful machine-readable analysis data.
- Retain BLAST access as a modest action attached to a specific output, independent of the deleted panel.

## 2. What the source establishes

These are source observations, not newly reproduced runtime defects. No application tests or browser sessions were run for this planning task. Paths below are relative to the workspace root.

| Observation | Evidence | Planning consequence |
| --- | --- | --- |
| ORF detection exists twice and uses the standard genetic code. It selects the longest stop-free segment and records whether an ATG occurs inside it. | `sangeranalyst/src/scripts/sequtils.js:127`; `sangeranalyst-api/sangeranalyst.py:1030` | Remove both implementations; merely hiding the protein strip leaves unnecessary computation and maintenance. |
| Summary rendering also owns BLAST and trace-jump buttons. | `sangeranalyst/src/pages/index.astro:160`; `sangeranalyst/src/scripts/app.js:398` | Handle surviving actions explicitly before deleting shared state and helpers. |
| Input changes refresh traces without invalidating completed results; download filenames read the current forward-file input. Only Analyze and Demo are disabled during processing. | `sangeranalyst/src/scripts/app.js`: `validateAb1Field`, `setBusyState`, `getSampleSlug` | Results can become detached from the visible inputs or export name. Reproduce and fix this before adding more workflow features. |
| Mott defaults differ: UI `0.1`, API `0.01`, pipeline `0.05`. Pipeline Phred also differs from UI/API. | `sangeranalyst/src/pages/index.astro:70`; `sangeranalyst-api/app.py:301`; `sangeranalyst-api/sangeranalyst.py:1094` | Establish one documented policy and test omitted versus explicit defaults. |
| Primer routes normalize differently; multiple FASTA records can be joined. Dropped files without clear direction cues fall back to alphabetical pairing. | `sangeranalyst-api/app.py`: `validate_dna_sequence`, `save_primer`; `sangeranalyst/src/scripts/app.js`: `cleanAndValidateDNA`; `sangeranalyst/src/scripts/sequtils.js`: `classifyAb1Pair` | Make ambiguous or invalid inputs explicit rather than silently inventing a primer or pair. |
| Frontend CI covers unit tests, build, and HTML validation. Backend has pytest and a public cohort benchmark, but no workflow; the benchmark has no ground truth. | `sangeranalyst/.github/workflows/ci.yml`; `sangeranalyst-api/tests/`; `sangeranalyst-api/benchmarks/benchmark_cohort.py` | Add targeted browser coverage and backend CI; use synthetic truth tests for accuracy. |

The separate ORF project should let users specify organism context and genomic compartment as well as a translation table. Genetic-code assignments can differ between nuclear and organellar sequences; see [NCBI's genetic-code reference](https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi). That future project also needs explicit rules for partial coding sequences, start codons, ambiguity, strand coordinates, and motif evidence. None of those choices belongs in this removal pass.

## 3. First change: remove the two features completely

### Frontend work

1. Delete the summary/ORF/inspector markup in `src/pages/index.astro` and its CSS, including responsive rules in `src/styles/global.css`. Keep ordinary FAQ `<summary>` elements and social-card metadata.
2. Remove `currentSummary`, `renderSummaryDashboard`, protein-copy handling, inspector jump handlers, and the summary render/reset calls from `src/scripts/app.js`.
3. Remove `findLongestOrf`, its codon table, `buildSummaryFromOutputs`, and summary-only parsing/GC helpers from `src/scripts/sequtils.js` once all callers are gone. Remove corresponding imports and dedicated tests. Preserve `extractCleanFasta`, `renderReportHtml`, file-pairing logic, and any helpers they still use.
4. Remove the inspector focus badge and callback. Remove `focusBase`/highlight plumbing in `traceviewer.js` only after confirming it has no remaining production caller; preserve ordinary trace navigation and its tests.
5. Place a small BLAST action beside each nonempty nucleotide output. Its source must be that output's clean sequence, not an automatically selected “primary” result. Never silently truncate a query: if a complete prefilled handoff cannot be supported, offer Copy FASTA and an external BLAST link.
6. Update frontend README claims and examples. Update relevant feature-specific contributor documentation when implementing, without rewriting unrelated guidance.

### Backend work and API compatibility

- Delete `find_longest_orf` and its invocation in `sangeranalyst.py`; retain consensus generation and non-ORF `summary` fields.
- For frontend-compatible retirement, return `summary.longest_orf: null` without computing a translation. The inspected frontend tolerates this; consumers expecting an object may not. Check known consumers before backend rollout and document the object-to-null contract change. Remove the key only in a later announced API contract change.
- Update the API README, pipeline overview, and ORF-specific assertions. Preserve the assertions for lengths, orientation, trim coordinates, conflicts, and secondary peaks.
- Do not alter the overlap significance gate, quality-based consensus rules, primer anchoring, or coordinate conventions as part of this removal.

### Resulting interface

```text
Read files → optional primers and analysis settings
Chromatogram preview and existing navigation
Analyze → relevant warnings
Consensus outputs → copy/download FASTA, full report, BLAST
```

No replacement metric dashboard, scores, or inspector chips. Use the existing result blocks and ordinary text explanations. Further changes to how sequences and reports are presented are a separate improvement below.

### Acceptance criteria

- Demo analysis, with and without primers, completes without missing-element or missing-import errors.
- No ORF computation, protein export, summary panel, inspector pills, or orphaned focus badge remains in the application.
- Strict/full/primer-trimmed sequence content and report contents match the baseline for identical explicit settings.
- Failed overlap, zero-quality reads, and other server warnings remain visible; an empty strict consensus is never replaced with a fabricated sequence.
- FASTA exports remain clean; reports retain conflict and secondary-peak information.
- New frontend works with responses containing the old summary, a null ORF, or no summary. Check the old frontend with the transitional API response before rollout.

## 4. Other improvements, in priority order

Effort is relative: **S** = a narrow change; **M** = coordinated state/API/test work; **L** = a new workflow. These are recommendations for later implementation, not additional completed work.

### A. Bind every result to its completed analysis — P1, M

**Why:** File replacement, swaps, primer edits, and threshold changes currently leave prior results visible. Export naming reads live form state.

**Plan:** Keep an immutable request/result snapshot with filenames, settings, primers, and outputs. Mark results stale when any analysis input changes and disable their export/BLAST actions until rerun. Serialize analysis and demo loading; lock input-changing controls while either is active. Guard late responses with a request identifier. A Cancel action may abort the browser request, but must not claim to stop server computation. Keep the existing 60-second timeout.

**Acceptance:** Analyze sample A, select B, and verify A cannot be downloaded under B's name. Repeat for swaps, primers, settings, and demo loads. A cancelled or obsolete response cannot replace newer results. Failure and timeout always restore usable controls.

### B. Make inputs and defaults consistent — P1, M

**Why:** Entry points currently accept different primer text and use different defaults; filename heuristics can assign uncertain read pairs.

**Plan:** Preserve the established UI defaults (`0.1`, `20`, `33`) as the proposed common policy, subject to a focused comparison on synthetic and public fixtures. Centralize Python constants and enforce the frontend contract with fixtures. Treat changed API/library defaults as a documented behavior change. Accept raw primer DNA or exactly one FASTA record; consistently normalize case/whitespace, preserve IUPAC, and reject digits, malformed encoding, and multiple records with field-specific messages. Use the existing ten-base minimum; decide a shared upper bound explicitly rather than confusing the paste field's 100-character cap with the upload byte limit. Reject drops containing more than two reads in single-pair mode; ask for explicit slot assignment when filename pairing is uncertain.

**Acceptance:** Paste, file upload, and API inputs normalize identically. Cover empty optional primers, 9/10-base boundaries, the chosen upper bound, lowercase, IUPAC, digits, multi-record FASTA, and encoding errors. Omitted defaults equal explicit defaults. Duplicate direction hints or extra files cannot silently select an arbitrary pair.

### C. Make result reading and errors more direct — P1, S–M

**Why:** Each output currently displays a combined sequence/report with four action buttons. Clipboard failures are logged only to the console; several input errors use alerts.

**Plan:** Show the nucleotide sequence first, with Copy FASTA and Download FASTA as primary actions; put the unchanged full report behind a plainly labeled disclosure only after important outcomes are visible outside it. Primer anchoring can currently return a fallback sequence with an explanation inside report text: expose a per-primer outcome (omitted, matched, or unmatched/fallback) as ordinary text beside the result first. Explain strict consensus as the validated overlapping region and full merge as including single-read ends. Render a specific empty-result explanation and disable unavailable sequence actions. Replace blocking alerts with errors beside the relevant inputs; provide visible clipboard failure feedback and a download fallback. Use ordinary text for QC explanations, describing peak-supported ambiguity without overstating biological interpretation.

**Acceptance:** Empty strict results, one or both unmatched primers, a reverse anchor before the accepted forward boundary, missing quality, clipboard denial, offline errors, 400/413/500 responses, and timeout each have a clear next action. Primer fallback remains visible with the report collapsed. All controls work by keyboard, focus reaches the first invalid input, and a narrow mobile viewport can reach all outputs without clipping. Keep report formatting and FASTA contents intact.

### D. Include reproducible analysis details in downloads — P2, M

**Why:** Existing reports do not fully record effective thresholds, software/dependency versions, and input identity; archive metadata exists only for low-confidence cases.

**Plan:** Add an `analysis.json` download containing a schema version, effective parameters, normalized primers, input hashes, output hashes, warnings, tool revision, and relevant runtime versions. Derive it from the completed request snapshot in A. Keep this in exports; it does not require another summary panel. Keep clean FASTA separate from provenance and full reports. Mark unavailable provenance explicitly when using an older API.

**Acceptance:** Changing form settings after a run cannot change that run's metadata. Exported sequence hashes match the exported sequences; deterministic metadata agrees across identical reruns, excluding timestamp/request ID. A saved run can be recreated from the same original files and recorded environment. Keep private inputs out of repository fixtures.

### E. Strengthen checks around the real workflow — P1–P2, M

**Plan:** Add backend CI for the existing pytest suite and a reproducible dependency environment. Add a small browser suite for demo loading, analysis results, exports, stale state, and failures using deterministic API fixtures, plus one local integration smoke test. Add cross-language fixtures for Mott windows and orientation behavior: the browser currently considers raw/reverse-complement traces while the backend can also choose complement/reverse. Label preview limitations until that discrepancy is resolved. Give the cohort benchmark machine-readable output and a failing status for execution failures or missing fixtures; review baseline changes explicitly.

**Acceptance:** Intentional API failure and a missing expected fixture fail the relevant check. Synthetic truth and overlap-rejection tests remain the accuracy gate. “All pairs merged” is not treated as proof of accuracy, and intentionally empty consensuses remain valid expected outcomes. Do not add a large testing framework solely to test deleted UI.

## 5. Later feature worth considering

**Batch assembly — P3, L:** Once A, B, D, and the necessary checks in E are stable, support a folder of read pairs with an editable sample-pair table, bounded sequential requests, per-pair status, retry of failed pairs, and an export bundle. Retain the existing single-pair API initially. Verify duplicate names, unmatched reads, partial failure, cancellation, and hosting capacity before offering parallel execution. This adds practical assembly value without expanding into annotation.

Defer reference mapping, manual base editing, and organism/motif interpretation until there is a separate scope and validation plan. Do not extract a shared ORF package now; record the current commit references and design that future tool around its own biological requirements.

## 6. Delivery order, validation, and rollout

1. **Removal PRs:** Capture baseline outputs for fixed explicit parameters; implement section 3 in the two repositories; update feature documentation and relevant tests together.
2. **Reliability work:** Implement A and B, with focused checks from E.
3. **Usability and reproducibility:** Implement C, then D once request snapshots are available. Complete CI/benchmark work in E.
4. **Optional expansion:** Reassess demand for batch assembly after the core workflow is stable.

Deploy the frontend removal first, then the transitional backend after checking known API consumers; keep deployment independently reversible. Capture compatibility fixtures before changing the API. For the removal release, compare sequences and reports at identical explicit settings; for any later default change, compare omitted inputs with the newly documented policy instead of incorrectly requiring old default outputs.

**Checks to run during implementation, not results claimed by this plan:**

```bash
# In sangeranalyst/
npm ci
npm test
npm run build
npx --yes html-validate dist/index.html

# In sangeranalyst-api/, inside an isolated Python environment
pip install -r requirements-dev.txt
python3 -m pytest tests/ -q
python3 benchmarks/benchmark_cohort.py
```

Browser validation should use local services and bundled/public fixtures, at desktop and mobile widths. Cover demo data, no primers, optional primer failures, low-quality/no-overlap data, reverse-only preview, swapped reads, invalid inputs, exports, and network failures. No production uploads are needed.

## 7. Remaining decisions and boundaries

- **Recommended scope interpretation:** Remove summary/inspector presentation while retaining non-ORF API metadata and the underlying trace viewer.
- **API dependency to check:** External consumers of `summary.longest_orf` are unknown. A null field avoids continuing computation but changes the value type; both that transition and eventual field removal need documented contract decisions.
- **Default-policy gate:** Compare omitted-parameter behavior before changing defaults; preserve explicit user settings and saved preferences.
- **Input-policy gate:** Choose and document the primer upper bound before implementing B.
- **Optional features:** BLAST placement, the sequence/report disclosure, provenance export, and batch assembly are proposed product choices. They are not prerequisites for writing this plan.

The implementation should begin with the requested removals and a small set of demonstrable reliability improvements, then expand only when each new feature has a clear assembly use case.
