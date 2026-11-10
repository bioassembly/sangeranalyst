import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCleanFasta,
  renderReportHtml,
  normalizePrimer,
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


test('uncertain pairs and extra files require explicit slot assignment', () => {
  for (const names of [['unknown.ab1'], ['both_F_R.ab1'], ['a.ab1', 'b.ab1'], ['a_F.ab1', 'b_F.ab1'], ['a_F.ab1', 'b_R.ab1', 'c_R.ab1']]) {
    assert.deepEqual(classifyAb1Pair(names.map(name => ({ name }))), { fileF: null, fileR: null, ambiguous: true });
  }
});

test('primer normalization accepts one DNA record and rejects unintended concatenation', () => {
  assert.equal(normalizePrimer('>primer\nacgtnrykms\n'), 'ACGTNRYKMS');
  assert.equal(normalizePrimer(' acgt nrykms '), 'ACGTNRYKMS');
  for (const text of ['', 'ACGTNRYKM', 'ACGT123ACGT', '>one\nACGTACGTAC\n>two\nACGTACGTAC', 'ACGTACGTAC\n>late\nACGT']) {
    assert.throws(() => normalizePrimer(text));
  }
  assert.throws(() => normalizePrimer('A'.repeat(5_000_001)));
});


test('primer byte limit includes FASTA headers and whitespace', () => {
  assert.throws(() => normalizePrimer('>' + 'é'.repeat(2_500_000) + '\nACGTACGTAC'));
});
