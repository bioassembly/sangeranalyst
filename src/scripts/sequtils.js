// Pure FASTA, report-rendering, primer, and file-pairing utilities for
// SangerAnalyst. Kept DOM-free so Node's built-in test runner can verify them.

const IUPAC_AMB_RE = /([RYKMSWBDHV])/g;
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

const FWD_HINT_RE = /(?:(?:^|[._\-\s])(fwd|forward|f|1|f1|sense)(?:[._\-\s]|$)|(?:m13|\d+)f(?:[._\-\s]|$))/i;
const REV_HINT_RE = /(?:(?:^|[._\-\s])(rev|reverse|r|2|r1|antisense)(?:[._\-\s]|$)|(?:m13|\d+)r(?:[._\-\s]|$))/i;

// Classifies dropped .ab1 files into Forward and Reverse slots by filename cues.
export function classifyAb1Pair(fileList) {
  const ab1s = [...(fileList || [])].filter(f => f && /\.ab1$/i.test(f.name));
  if (ab1s.length === 0) return { fileF: null, fileR: null };
  if (ab1s.length === 1) {
    const stem = ab1s[0].name.replace(/\.ab1$/i, '');
    const forward = FWD_HINT_RE.test(stem), reverse = REV_HINT_RE.test(stem);
    if (forward === reverse) return { fileF: null, fileR: null, ambiguous: true };
    return reverse ? { fileF: null, fileR: ab1s[0] } : { fileF: ab1s[0], fileR: null };
  }

  const ambiguous = { fileF: null, fileR: null, ambiguous: true };
  if (ab1s.length !== 2) return ambiguous;
  const direction = f => {
    const stem = f.name.replace(/\.ab1$/i, '');
    const forward = FWD_HINT_RE.test(stem), reverse = REV_HINT_RE.test(stem);
    return forward === reverse ? null : forward ? 'F' : 'R';
  };
  const directions = ab1s.map(direction);
  if (!directions[0] || !directions[1] || directions[0] === directions[1]) return ambiguous;
  return { fileF: ab1s[directions.indexOf('F')], fileR: ab1s[directions.indexOf('R')] };
}

// Match the API primer contract: raw DNA or exactly one FASTA record.
export function normalizePrimer(value, minLength = 10) {
  const input = String(value || '');
  if (new TextEncoder().encode(input).length > 5_000_000) throw new Error('Primer input exceeds the 5 MB limit.');
  const raw = input.trim();
  if (!raw) throw new Error('Primer sequence is empty.');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headers = lines.filter(line => line.startsWith('>'));
  if (headers.length > 1 || (headers.length === 1 && !lines[0].startsWith('>'))) {
    throw new Error('Provide exactly one FASTA record per primer.');
  }
  const seq = (headers.length ? lines.slice(1) : lines).join('').replace(/\s+/g, '').toUpperCase();
  if (!/^[ATGCNRYKMSWBDHV]+$/.test(seq)) throw new Error('Use DNA bases and IUPAC ambiguity codes only.');
  if (seq.length < minLength) throw new Error(`Primer must contain at least ${minLength} bases.`);
  if (seq.length > 5_000_000) throw new Error('Primer exceeds the 5M-base limit.');
  return seq;
}
