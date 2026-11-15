import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReadAlignment, renderAlignmentHtml, renderAlignmentStats, renderConsensusHtml, extractConflictSites, outputConflictSites, primerWarnings, extractSecondaryPeaks, renderSecondaryPeaksHtml, displayAnalysisWarnings } from '../src/scripts/results.js';
import { extractCleanFasta, renderReportHtml } from '../src/scripts/sequtils.js';

const alignment = [
  'forward         11 ACGT-NRY 17',
  '                  ||.|  ||',
  'reverse_rc       9 ACTTANRY 16',
  '',
  'forward         18 GCTA 21',
  '                  ||||',
  'reverse_rc      17 GCTA 20',
].join('\n');
const report = `>consensus\nACGTNRYGCTA\n\n# Identity: 9/12 (75.0%)\n# Gaps: 1/12 (8.3%)\n# Forward primer anchored span [2 - 25], trimmed 5' ---> [25].\n${alignment}\n\n# Significant secondary peaks\n# 25 21 G A 45\n`;

test('read alignment preserves server coordinates and spacing while excluding FASTA and commentary', () => {
  assert.deepEqual(extractReadAlignment(report.replace(/\n/g, '\r\n')), {
    text: alignment, identity: '9/12 (75.0%)', gaps: '1/12 (8.3%)',
  });
  assert.equal(extractCleanFasta(report).seq, 'ACGTNRYGCTA');
});

test('missing, malformed, and primer-only alignments are not presented as read alignments', () => {
  for (const value of [undefined, '# No correct alignment possible', '# Identity: 99%\n',
    'forward 1 ACGT 4\n||||\nreverse_rc 1 AC 2',
    'consensus 1 ACGT 4\n||||\nprimer_f 1 ACGT 4',
    'forward 1 ACGT 4\n<script>alert(1)</script>\nreverse_rc 1 ACGT 4']) {
    assert.deepEqual(extractReadAlignment(value), { text: '', identity: '', gaps: '' });
  }
});

test('alignment highlights differences and gaps without shifting columns or marking labels', () => {
  const html = renderAlignmentHtml(alignment);
  assert.equal(html.replace(/<[^>]*>/g, ''), alignment);
  assert.match(html, /<span class="aln-mismatch">G<\/span>/);
  assert.match(html, /<span class="aln-gap">-<\/span>/);
  assert.match(html, /<span class="uncalled">N<\/span>/);
  assert.match(html, /<span class="amb">R<\/span>/);
  assert.ok(html.startsWith('forward         11 '));
  assert.equal(renderAlignmentHtml('<img src=x onerror=alert(1)> &'), '&lt;img src=x onerror=alert(1)&gt; &amp;');
});

const result = {
  request: { primers: { forward: 'ACGTACGTAC', reverse: 'ACGTACGTAC' } },
  outputs: { primer_trim: report },
  analysis: { primer_outcomes: {
    forward: { status: 'matched', message: 'Forward primer anchored span [2 - 25], trimmed 5′.' },
    reverse: { status: 'matched', message: 'Reverse primer anchored span [408 - 428].' },
  } },
};
test('successful primer coordinates are hidden but failures and fallback boundaries remain visible', () => {
  assert.deepEqual(primerWarnings(result), []);
  const fallback = structuredClone(result);
  fallback.analysis.primer_outcomes.reverse = { status: 'fallback', message: 'Reverse primer did not anchor; fallback boundaries used.' };
  assert.deepEqual(primerWarnings(fallback), ['Reverse primer did not anchor; fallback boundaries used.']);
  fallback.request.primers = { forward: null, reverse: null };
  assert.deepEqual(primerWarnings(fallback), []);
});

test('older API primer fallback notes remain visible without routine coordinate messages', () => {
  const legacy = { ...result, analysis: null, outputs: { primer_trim: report + '# Reverse primer is not confidently match, falling back to consensus strict trim.\n' } };
  assert.deepEqual(primerWarnings(legacy), ['Reverse primer is not confidently match, falling back to consensus strict trim.']);
});

test('masked N and IUPAC highlighting does not change the exported FASTA', () => {
  const fasta = extractCleanFasta(report).fasta;
  const html = renderReportHtml(fasta);
  assert.match(html, /<span class="uncalled">N<\/span>/);
  assert.match(html, /<span class="amb">R<\/span>/);
  assert.equal(html.replace(/<[^>]*>/g, '').replace(/&gt;/g, '>'), fasta);
});


test('a single supplied primer retains the omitted-end fallback explanation from the report', () => {
  const single = structuredClone(result);
  single.request.primers.reverse = null;
  single.analysis.primer_outcomes.reverse = { status: 'omitted', message: 'Reverse primer not supplied.' };
  single.outputs.primer_trim += '# No reverse primer file / empty, falling back to consensus strict trim.\n';
  assert.deepEqual(primerWarnings(single), ['No reverse primer file / empty, falling back to consensus strict trim.']);
});

test('structured fallback messages avoid duplicating the same failure in report comments', () => {
  const fallback = structuredClone(result);
  fallback.analysis.primer_outcomes.reverse = { status: 'fallback', message: 'Reverse primer did not anchor confidently.' };
  fallback.outputs.primer_trim += '# Reverse primer is not confidently match, falling back to consensus strict trim.\n';
  assert.deepEqual(primerWarnings(fallback), ['Reverse primer did not anchor confidently.']);
});


const peakReport = `>sample\nACGTRYSWACGT\n\n# ==== Significant secondary peaks in Forward Chromatogram:
#
# F.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 31           5         A             G         41
# 42           7         G             C         55
#
#=======================================

# ==== Significant secondary peaks in Reverse Chromatogram:
# Note: R.ab1_pos refers to the Reverse Complement of Reverse .ab1 read position
#
# R.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 28           5         G             A         37
#
#=======================================

# ==== Conflicts:
# 31 28 5 A 42 G 40 'R'
`;

test("secondary peaks preserve each report's consensus coordinates, trace positions, bases and ratios", () => {
  const parsed = extractSecondaryPeaks(peakReport.replace(/\n/g, '\r\n'));
  assert.equal(parsed.forward.status, 'detected');
  assert.deepEqual(parsed.forward.rows, [
    { tracePosition: '31', position: '5', primary: 'A', secondary: 'G', percentage: '41' },
    { tracePosition: '42', position: '7', primary: 'G', secondary: 'C', percentage: '55' },
  ]);
  assert.deepEqual(parsed.reverse.rows, [{ tracePosition: '28', position: '5', primary: 'G', secondary: 'A', percentage: '37' }]);
  assert.match(parsed.reverse.note, /Reverse Complement/);
  assert.equal(extractReadAlignment(peakReport).text, '');
});

test('explicit no-peak results stay distinct from missing or malformed secondary-peak data', () => {
  const none = '# No significant secondary peak in "Forward Chromatogram"\n\n# No significant secondary peak in "Reverse Chromatogram"';
  assert.equal(extractSecondaryPeaks(none).forward.status, 'none');
  assert.equal(extractSecondaryPeaks(none).reverse.status, 'none');
  assert.equal(extractSecondaryPeaks('').forward.status, 'unavailable');
  const malformed = '# ==== Significant secondary peaks in Forward Chromatogram:\n# invalid row\n#=======================================';
  assert.equal(extractSecondaryPeaks(malformed).forward.status, 'unavailable');
  assert.match(renderSecondaryPeaksHtml(none), /no significant secondary peaks detected/);
  assert.match(renderSecondaryPeaksHtml(''), /were not included/);
});

test('secondary-peak rendering is separate from alignment and safely escapes report notes', () => {
  const html = renderSecondaryPeaksHtml(peakReport + '# <script>alert(1)</script>');
  assert.equal((html.match(/<tr>/g) || []).length, 4);
  assert.match(html, /41%/);
  assert.doesNotMatch(html, /<script>|Conflicts/);
  const maliciousNote = peakReport.replace('R.ab1_pos refers', '<img src=x onerror=alert(1)> refers');
  assert.match(renderSecondaryPeaksHtml(maliciousNote), /&lt;img/);
  assert.doesNotMatch(renderSecondaryPeaksHtml(maliciousNote), /<img/);
});

const conflictReport = `>merged
TTACGTACG

# Identity: 5/9 (55.6%)
# Gaps: 3/9 (33.3%)
forward 1 --ACG-ACG 6
            ||. |||
reverse_rc 1 TTACATACG 9

# ==== Conflicts:
# Note: R.ab1_pos refers to the Reverse Complement of Reverse .ab1 read position
# F.ab1_pos R.ab1_pos Position F_read F_phred R_read R_phred Using
# inbetween 9-10 21 1 - - T 40 'T'
# 12 25 5 G 40 A 30 'G'
# inbetween 12-13 26 6 - - T 40 'T'
#
#=======================================
`;

test('conflict navigation keeps absolute trace positions and excludes single-read ends', () => {
  const { available, rows } = extractConflictSites(conflictReport);
  assert.equal(available, true);
  assert.deepEqual(rows.map(r => [r.position, r.forwardPosition, r.reversePosition]), [[5, 12, 25], [6, null, 26]]);
  assert.equal(rows[0].reverseComplemented, true);
  assert.equal(extractConflictSites(conflictReport.replaceAll('reverse_rc', 'reverse').replace(/# Note:.*\n/, '')).rows[0].reverseComplemented, false);
  assert.equal(extractConflictSites('').available, false);
  assert.deepEqual(extractConflictSites('# No conflicts found.'), { available: true, rows: [] });
});

test('primer-trimmed conflict positions map only through a unique exact full-merge segment', () => {
  const mapped = outputConflictSites('>trimmed\nCGTAC\n', conflictReport, true);
  assert.deepEqual(mapped.rows.map(r => [r.position, r.alignmentPosition, r.forwardPosition, r.reversePosition]), [[2, 5, 12, 25], [3, 6, null, 26]]);
  assert.deepEqual(outputConflictSites('>trimmed\nACG\n', conflictReport, true), { available: false, rows: [] });
  assert.deepEqual(outputConflictSites('>trimmed\nGGGG\n', conflictReport, true), { available: false, rows: [] });
  assert.deepEqual(outputConflictSites('', conflictReport, true), { available: false, rows: [] });
});

test('clickable conflicts preserve FASTA and alignment text including gaps and columns', () => {
  const sites = extractConflictSites(conflictReport).rows;
  const fasta = extractCleanFasta(conflictReport).fasta;
  const markup = renderConsensusHtml(fasta, sites);
  assert.equal(markup.replace(/<[^>]*>/g, '').replaceAll('&gt;', '>'), fasta);
  assert.equal((markup.match(/<button /g) || []).length, 2);
  const readAlignment = extractReadAlignment(conflictReport).text;
  const html = renderAlignmentHtml(readAlignment, sites);
  assert.equal(html.replace(/<[^>]*>/g, ''), readAlignment);
  assert.equal((html.match(/<button /g) || []).length, 4);
  assert.match(html, /consensus base 5/);
  assert.equal(renderConsensusHtml('>x<img>\nNRY\n').includes('<img>'), false);
});

test('alignment metric cards retain report denominators and safely handle legacy values', () => {
  const html = renderAlignmentStats(extractReadAlignment(conflictReport));
  assert.match(html, /55.6%/);
  assert.match(html, /5 \/ 9 alignment columns/);
  assert.match(html, /33.3%/);
  assert.equal(renderAlignmentStats({}), '');
  assert.doesNotMatch(renderAlignmentStats({ identity: '<img src=x>' }), /<img/);
});

test('only the statistical overlap warning is simplified for display', () => {
  const warnings = [
    'WARNING: No statistically significant overlap found between Forward and Reverse reads (candidate overlap 15 bp, 8 matches) — High Confidence Consensus is empty; verify both files come from the same amplicon.',
    'WARNING: Forward and reverse reads do not overlap after quality trimming — High Confidence Consensus is empty, and Full Merge joins non-overlapping reads.',
    'Review mixed bases before use.',
  ];
  assert.deepEqual(displayAnalysisWarnings(warnings), [
    'WARNING: No high-confidence consensus sequence could be made. Please verify both reads are from the same amplicon.',
    warnings[1], warnings[2],
  ]);
  assert.match(warnings[0], /candidate overlap 15 bp/);
});

test('alignment differences use the same highlight across both reads and the marker row', () => {
  const text = 'forward 1 AN-C 3\n          |   \nreverse 1 ACGT 4';
  const html = renderAlignmentHtml(text);
  assert.equal(html.replace(/<[^>]*>/g, ''), text);
  for (const className of ['uncalled', 'aln-gap', 'aln-mismatch']) {
    assert.equal((html.match(new RegExp(`class="${className}"`, 'g')) || []).length, 3);
  }
});
