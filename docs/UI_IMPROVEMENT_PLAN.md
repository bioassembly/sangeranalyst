# Results interface improvement plan

## Implemented in this revision

- Separate identity and gap summaries, with percentages and original alignment-column counts.
- Distinct highlighting for mismatches, IUPAC mixed bases, uncalled N bases and gaps; a full expandable IUPAC code key.
- Conflict navigation from each output's sequence and alignment into the input chromatograms, with highlighted read bases and a return-to-result control.
- Primer-trimmed conflict coordinates mapped only when the trimmed sequence occurs uniquely in the full merge.
- One shared secondary-peak section using full-merge consensus coordinates, including peaks excluded by trimming.
- NCBI BLAST button beside Download .fasta. It copies the chosen FASTA and opens NCBI for pasting.
- Removed middle-dot separators from the interface.

## Suggested next improvements

These are follow-up proposals, not additional changes made to the interface.

| Priority | Improvement | Purpose | Acceptance check |
| --- | --- | --- | --- |
| 1 | Structured coordinate maps from the API | Replace report parsing and support repeated primer-trimmed sequences with exact mappings | Round-trip each output position to original forward/reverse read coordinates across trimming, gaps and all orientations |
| 1 | Quality values in the conflict inspector | Show both Phred scores and the reported consensus decision alongside the selected traces | Values match the analysis request and raw report, including masked bases and gaps |
| 2 | Direct navigation from secondary-peak rows | Inspect a detected peak from the shared table | Forward and reverse positions resolve correctly in every supported orientation |
| 2 | Coverage strip for each consensus | Make single-read ends and shared overlap apparent before export | Coverage boundaries match server alignment columns and trimmed output coordinates |
| 2 | Compact sequence summary | Show sequence length, mixed-base count and N count | Counts match the exact exported FASTA for each tab |
| 3 | Export a selected trace image | Provide a labelled image for laboratory notes | Export includes read names, positions, orientation and threshold settings |
| 3 | Reviewed-site markers | Let scientists track conflicts inspected during a session | Markers remain associated with one completed analysis and reset when inputs change |

## Validation

Run unit tests, frontend build, generated HTML validation and browser tests. Exercise real demo analysis, each output tab, conflict jumps and return navigation, clipboard failure, stale-input disabling and mobile layout. Preserve the original blue theme and input form.
