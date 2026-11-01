// Pure sequence, FASTA, ORF, report-parsing, and file-pairing utilities for
// SangerAnalyst. Kept DOM-free so Node's built-in test runner can verify them.

const IUPAC_AMB_RE = /([RYKMSWBDHV])/g;
const COMPLEMENT_MAP = {
  A: 'T', T: 'A', G: 'C', C: 'G',
  R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
  B: 'V', V: 'B', D: 'H', H: 'D', N: 'N',
};

const CODON_TABLE = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
  CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
  GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
  CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
  GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
  CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
  GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
  CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
  GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

export function wrapFastaSeq(seq, width = 60) {
  const clean = String(seq || '').replace(/\s+/g, '').toUpperCase();
  if (!clean) return '';
  const chunks = [];
  for (let i = 0; i < clean.length; i += width) {
    chunks.push(clean.slice(i, i + width));
  }
  return chunks.join('\n');
}

// Extracts strictly valid FASTA (>Header + sequence lines) from a SangerAnalyst
// report string, stripping all '#' report blocks and EMBOSS alignment sections.
export function extractCleanFasta(reportText, fallbackHeader = 'Consensus') {
  if (!reportText || reportText === '—' || reportText === '-') {
    return { header: fallbackHeader, seq: '', fasta: '' };
  }
  const lines = String(reportText).split(/\r?\n/);
  let header = fallbackHeader;
  let inSeq = false;
  const seqParts = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!inSeq) {
      if (line.startsWith('>')) {
        header = line.slice(1).trim() || fallbackHeader;
        inSeq = true;
      }
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith('>')) break;
    if (/^[ATGCNRYKMSWBDHV]+$/i.test(line)) {
      seqParts.push(line.toUpperCase());
    } else {
      break;
    }
  }

  const seq = seqParts.join('');
  if (!seq) return { header, seq: '', fasta: '' };
  return {
    header,
    seq,
    fasta: `>${header}\n${wrapFastaSeq(seq, 60)}\n`,
  };
}

// Escapes HTML and highlights IUPAC ambiguity codes ONLY on pure FASTA sequence
// lines (between '>' and the first blank/'#' line), never inside alignment
// block labels ('forward', 'reverse_rc', 'consensus') or warning banners.
export function renderReportHtml(text) {
  if (!text || text === '—' || text === '-') return '—';
  let inFastaSeq = false;
  return String(text)
    .split('\n')
    .map((line) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const trimmed = line.trim();
      if (trimmed.startsWith('>')) {
        inFastaSeq = true;
        return escaped;
      }
      if (inFastaSeq) {
        if (!trimmed || trimmed.startsWith('#') || !/^[ATGCNRYKMSWBDHV]+$/i.test(trimmed)) {
          inFastaSeq = false;
          return escaped;
        }
        return escaped.replace(IUPAC_AMB_RE, '<span class="amb">$1</span>');
      }
      return escaped;
    })
    .join('\n');
}

function revcompIUPAC(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) {
    const ch = seq[i].toUpperCase();
    out += COMPLEMENT_MAP[ch] || 'N';
  }
  return out;
}

export function gcPercent(seq) {
  let gc = 0, total = 0;
  for (const ch of String(seq || '').toUpperCase()) {
    if (ch === 'G' || ch === 'C') { gc++; total++; }
    else if (ch === 'A' || ch === 'T') { total++; }
  }
  return total > 0 ? Math.round((gc / total) * 1000) / 10 : 0;
}

// 6-frame uninterrupted reading frame finder (NCBI Standard Table 1),
// mirroring backend sangeranalyst.py:find_longest_orf for offline/fallback parity.
export function findLongestOrf(seqStr) {
  const clean = String(seqStr || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (clean.length < 3) return null;

  const L = clean.length;
  let best = null;
  const strands = [
    ['+', clean],
    ['-', revcompIUPAC(clean)],
  ];

  for (const [sign, strandSeq] of strands) {
    for (let offset = 0; offset < 3; offset++) {
      const trimLen = Math.floor((L - offset) / 3) * 3;
      if (trimLen < 3) continue;
      let aa = '';
      for (let i = offset; i < offset + trimLen; i += 3) {
        const codon = strandSeq.slice(i, i + 3);
        aa += CODON_TABLE[codon] || 'X';
      }
      let codonIdx = 0;
      for (const seg of aa.split('*')) {
        const aaLen = seg.length;
        if (aaLen > 0 && (best === null || aaLen > best.aa_len)) {
          const ntStart = offset + codonIdx * 3;
          const ntEnd = ntStart + aaLen * 3;
          const start1 = sign === '+' ? ntStart + 1 : L - ntEnd + 1;
          const end1 = sign === '+' ? ntEnd : L - ntStart;
          const segNt = strandSeq.slice(ntStart, ntEnd);
          let hasAtg = false;
          for (let k = 0; k < segNt.length; k += 3) {
            if (segNt.slice(k, k + 3) === 'ATG') { hasAtg = true; break; }
          }
          best = {
            frame: `${sign}${offset + 1}`,
            start: start1,
            end: end1,
            nt_len: aaLen * 3,
            aa_len: aaLen,
            aa_seq: seg,
            has_atg: hasAtg,
          };
        }
        codonIdx += aaLen + 1;
      }
    }
  }
  return best;
}

function parseConflictsFromReport(reportText) {
  if (!reportText) return [];
  const lines = String(reportText).split(/\r?\n/);
  const conflicts = [];
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('# F.ab1_pos')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (line.trim() === '#' || line.startsWith('#===')) break;
    const m = line.match(
      /^#\s+(inbetween\s+\d+-\d+|\d+)\s+(inbetween\s+\d+-\d+|\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+'([^']+)'/
    );
    if (m) {
      const parsePos = (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : v);
      const parseQ = (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : v);
      conflicts.push({
        F_ab1pos: parsePos(m[1]),
        R_ab1pos: parsePos(m[2]),
        position: parseInt(m[3], 10),
        F_seq: m[4],
        F_phred: parseQ(m[5]),
        R_seq: m[6],
        R_phred: parseQ(m[7]),
        using_seq: m[8],
      });
    }
  }
  return conflicts;
}

function parseSecPeaksFromReport(reportText) {
  const fwd = [];
  const rev = [];
  if (!reportText) return { fwd, rev };
  const lines = String(reportText).split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    // Headers emitted by sangeranalyst.py:make_secp_report
    if (/Significant secondary peaks in Forward Chromatogram:/i.test(line)) { current = fwd; continue; }
    if (/Significant secondary peaks in Reverse Chromatogram:/i.test(line)) { current = rev; continue; }
    if (line.startsWith('#====')) { current = null; continue; }
    if (!current || !line.startsWith('#')) continue;
    const m = line.match(/^#\s+(\d+)\s+(\d+)\s+([A-Z])\s+([A-Z])\s+([\d.]+)%?\s*$/i);
    if (m) {
      current.push({
        position: parseInt(m[1], 10),
        c_pos: parseInt(m[2], 10),
        primary_base: m[3].toUpperCase(),
        secondary_base: m[4].toUpperCase(),
        percentage: parseFloat(m[5]),
      });
    }
  }
  return { fwd, rev };
}

// Builds a unified summary object from backend `data.summary` when available,
// or falls back seamlessly to client-side report parsing when connected to an
// older backend deployment.
export function buildSummaryFromOutputs(outputs = {}, serverSummary = null) {
  const strictFasta = extractCleanFasta(outputs.consensus_strict, 'Consensus_Strict');
  const fullFasta = extractCleanFasta(outputs.consensus_full, 'Consensus');
  const primerFasta = outputs.primer_trim
    ? extractCleanFasta(outputs.primer_trim, 'Primer_Trimmed_Consensus')
    : { header: 'Primer_Trimmed_Consensus', seq: '', fasta: '' };

  const primarySeq = primerFasta.seq || strictFasta.seq || fullFasta.seq;
  const primaryLabel = primerFasta.seq
    ? 'Primer-Trimmed'
    : strictFasta.seq
      ? 'High-Confidence'
      : 'Full Merge';

  if (serverSummary && typeof serverSummary === 'object') {
    return {
      ...serverSummary,
      primary_seq: primarySeq,
      primary_label: primaryLabel,
      fasta_map: {
        strict: strictFasta,
        full: fullFasta,
        primerTrim: primerFasta,
      },
    };
  }

  const strictReport = outputs.consensus_strict || '';
  const fullReport = outputs.consensus_full || '';
  const idMatch = strictReport.match(/^#\s*Identity:\s*(\d+)\/(\d+)/m);
  const overlapMatches = idMatch ? parseInt(idMatch[1], 10) : 0;
  const overlapLen = idMatch ? parseInt(idMatch[2], 10) : strictFasta.seq.length;
  const overlapIdentity = overlapLen > 0 ? Math.round((overlapMatches / overlapLen) * 10000) / 10000 : 0;

  const strictConflicts = parseConflictsFromReport(strictReport);
  const fullConflicts = parseConflictsFromReport(fullReport);
  const activeConflicts = strictFasta.seq.length > 0 ? strictConflicts : fullConflicts;
  const secPeaks = parseSecPeaksFromReport(strictFasta.seq.length > 0 ? strictReport : fullReport);

  const countSet = (s, chars) => [...s].filter(c => chars.has(c)).length;
  const iupacSet = new Set(['R', 'Y', 'K', 'M', 'S', 'W', 'B', 'D', 'H', 'V']);

  return {
    strict_len: strictFasta.seq.length,
    full_len: fullFasta.seq.length,
    primer_trim_len: outputs.primer_trim ? primerFasta.seq.length : null,
    overlap_len: overlapLen,
    overlap_identity: overlapIdentity,
    overlap_passed: strictFasta.seq.length > 0,
    conflict_count: activeConflicts.length,
    full_conflict_count: fullConflicts.length,
    ambiguous_count: countSet(strictFasta.seq || fullFasta.seq, iupacSet),
    strict_n_count: [...strictFasta.seq].filter(c => c === 'N').length,
    full_n_count: [...fullFasta.seq].filter(c => c === 'N').length,
    gc_percent: gcPercent(primarySeq),
    longest_orf: findLongestOrf(primarySeq),
    conflicts: activeConflicts,
    secondary_peaks: secPeaks,
    primary_seq: primarySeq,
    primary_label: primaryLabel,
    fasta_map: {
      strict: strictFasta,
      full: fullFasta,
      primerTrim: primerFasta,
    },
  };
}

const FWD_HINT_RE = /(?:(?:^|[._\-\s])(fwd|forward|f|1|f1|sense)(?:[._\-\s]|$)|(?:m13|\d+)f(?:[._\-\s]|$))/i;
const REV_HINT_RE = /(?:(?:^|[._\-\s])(rev|reverse|r|2|r1|antisense)(?:[._\-\s]|$)|(?:m13|\d+)r(?:[._\-\s]|$))/i;

// Classifies dropped .ab1 files into Forward and Reverse slots by filename cues.
export function classifyAb1Pair(fileList) {
  const ab1s = [...(fileList || [])].filter(f => f && /\.ab1$/i.test(f.name));
  if (ab1s.length === 0) return { fileF: null, fileR: null };
  if (ab1s.length === 1) {
    const stem = ab1s[0].name.replace(/\.ab1$/i, '');
    const isRev = REV_HINT_RE.test(stem) && !FWD_HINT_RE.test(stem);
    return isRev ? { fileF: null, fileR: ab1s[0] } : { fileF: ab1s[0], fileR: null };
  }

  let fIdx = -1, rIdx = -1;
  ab1s.forEach((f, idx) => {
    const stem = f.name.replace(/\.ab1$/i, '');
    const fHit = FWD_HINT_RE.test(stem);
    const rHit = REV_HINT_RE.test(stem);
    if (fHit && !rHit && fIdx === -1) fIdx = idx;
    else if (rHit && !fHit && rIdx === -1) rIdx = idx;
  });

  if (fIdx !== -1 && rIdx !== -1 && fIdx !== rIdx) {
    return { fileF: ab1s[fIdx], fileR: ab1s[rIdx] };
  }
  if (fIdx !== -1) {
    const other = ab1s.find((_, i) => i !== fIdx) || null;
    return { fileF: ab1s[fIdx], fileR: other };
  }
  if (rIdx !== -1) {
    const other = ab1s.find((_, i) => i !== rIdx) || null;
    return { fileF: other, fileR: ab1s[rIdx] };
  }
  const sorted = [...ab1s].sort((a, b) => a.name.localeCompare(b.name));
  return { fileF: sorted[0], fileR: sorted[1] };
}
