import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCleanFasta,
  renderReportHtml,
  findLongestOrf,
  buildSummaryFromOutputs,
  classifyAb1Pair,
} from '../src/scripts/sequtils.js';

const SAMPLE_REPORT = `>Sample_A_Consensus_Strict
ACGTACGTACGTACGTACGTRYACGTACGTACGTACGTACGTACGTACGTACGTACGTAC
GTACGTACGT

#=======================================
# Aligned_sequences: 2
# Identity: 68/70 (97.1%)
#=======================================

forward          1 ACGTACGT 8
                   ||||||||
reverse_rc       1 ACGTACGT 8

# ==== Conflicts:
# Note: R.ab1_pos refers to the Reverse Complement of Reverse .ab1 read position
#
# F.ab1_pos    R.ab1_pos    Position  F_read F_phred  R_read R_phred  Using
# 31           28           21        A      42       G      40       'R'
# inbetween 40-41 38        30        -      -        C      35       'C'
#
#=======================================

# ==== Significant secondary peaks in Forward Chromatogram:
#
# F.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 31           21        A             G         41
#
#=======================================

# ==== Significant secondary peaks in Reverse Chromatogram:
# Note: R.ab1_pos refers to the Reverse Complement of Reverse .ab1 read position
#
# R.ab1_pos    Position  Primary_base  Sec_base  Peak_size(%)
# 28           21        G             A         37
#
#=======================================
`;

test('extractCleanFasta strips comments and alignment blocks into strict FASTA', () => {
  const res = extractCleanFasta(SAMPLE_REPORT);
  assert.equal(res.header, 'Sample_A_Consensus_Strict');
  assert.equal(res.seq.length, 70);
  assert.ok(res.fasta.startsWith('>Sample_A_Consensus_Strict\n'));
  assert.ok(!res.fasta.includes('#'));
  assert.ok(!res.fasta.includes('forward'));

  assert.equal(extractCleanFasta('—').fasta, '');
  assert.equal(extractCleanFasta('>Empty_Consensus\n\n# WARNING: no overlap').fasta, '');
});

test('renderReportHtml highlights IUPAC codes ONLY on FASTA sequence lines', () => {
  const html = renderReportHtml(SAMPLE_REPORT);
  const lines = html.split('\n');
  // Header is escaped and has no <span class="amb">
  assert.equal(lines[0], '&gt;Sample_A_Consensus_Strict');
  // Sequence line wraps R and Y in <span class="amb">
  assert.ok(lines[1].includes('<span class="amb">R</span><span class="amb">Y</span>'));
  // Alignment line 'forward' and 'reverse_rc' must NOT wrap 'r', 'd', 'v', etc.
  const fwdLine = lines.find(l => l.startsWith('forward'));
  assert.ok(fwdLine && !fwdLine.includes('<span class="amb">'));
});

test('findLongestOrf detects longest 6-frame ORF and ATG presence', () => {
  // Frame +1: ATG CTA(L) TCA(S) TTA(L) GCT(A) TTC(F) AAA(K) GCT(A) GAC(D) TAA(*) -> MLSLFKAD? (9 aa)
  const orf = findLongestOrf('ATGCTATCATTAGCTTTCAAAGCTGACTAA');
  assert.ok(orf);
  assert.equal(orf.frame, '+1');
  assert.equal(orf.aa_seq, 'MLSLAFKAD');
  assert.equal(orf.aa_len, 9);
  assert.equal(orf.has_atg, true);
});

test('buildSummaryFromOutputs parses legacy text reports when server summary is absent', () => {
  const summary = buildSummaryFromOutputs({
    consensus_strict: SAMPLE_REPORT,
    consensus_full: SAMPLE_REPORT,
  }, null);

  assert.equal(summary.strict_len, 70);
  assert.equal(summary.overlap_len, 70);
  assert.equal(summary.overlap_passed, true);
  assert.equal(summary.conflict_count, 2);
  assert.equal(summary.ambiguous_count, 2); // R and Y
  assert.equal(summary.conflicts[0].F_ab1pos, 31);
  assert.equal(summary.conflicts[0].R_ab1pos, 28);
  assert.equal(summary.conflicts[1].F_ab1pos, 'inbetween 40-41');
  assert.equal(summary.secondary_peaks.fwd.length, 1);
  assert.equal(summary.secondary_peaks.fwd[0].position, 31);
  assert.equal(summary.secondary_peaks.fwd[0].percentage, 41);
  assert.equal(summary.secondary_peaks.rev.length, 1);
  assert.equal(summary.secondary_peaks.rev[0].position, 28);
  assert.equal(summary.secondary_peaks.rev[0].primary_base, 'G');
});

test('classifyAb1Pair auto-assigns Forward and Reverse files by naming convention', () => {
  const paired16s = classifyAb1Pair([
    { name: 'Sample01_1492R.ab1' },
    { name: 'Sample01_27F.ab1' },
  ]);
  assert.equal(paired16s.fileF.name, 'Sample01_27F.ab1');
  assert.equal(paired16s.fileR.name, 'Sample01_1492R.ab1');

  const paired = classifyAb1Pair([
    { name: 'cloneA_R.ab1' },
    { name: 'cloneA_F.ab1' },
  ]);
  assert.equal(paired.fileF.name, 'cloneA_F.ab1');
  assert.equal(paired.fileR.name, 'cloneA_R.ab1');

  const soloRev = classifyAb1Pair([{ name: 'amplicon_rev.ab1' }]);
  assert.equal(soloRev.fileF, null);
  assert.equal(soloRev.fileR.name, 'amplicon_rev.ab1');
});
