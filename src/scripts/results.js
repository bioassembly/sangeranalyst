import { extractCleanFasta } from './sequtils.js';

const READ_ROW = /^(forward|reverse(?:_rc)?)(\s+\d+\s+)([ACGTNRYKMSWBDHV-]+)(\s+\d+\s*)$/i;
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function displayAnalysisWarnings(warnings) {
  return warnings.map(warning => /^\s*(?:WARNING:\s*)?No statistically significant overlap found between Forward and Reverse reads\b/i.test(warning)
    ? 'WARNING: No high-confidence consensus sequence could be made. Please verify both reads are from the same amplicon.'
    : warning);
}

// Preserve the server's labels, positions, gaps, spacing and match markers.
// Secondary-peak tables, primer matches and report commentary are excluded.
export function extractReadAlignment(report) {
  const lines = String(report || '').split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const forward = lines[i].match(READ_ROW);
    const reverse = lines[i + 2].match(READ_ROW);
    if (forward?.[1].toLowerCase() !== 'forward' || !reverse || !/^reverse/i.test(reverse[1])) continue;
    if (forward[3].length !== reverse[3].length || !/^[\s|.:]*$/.test(lines[i + 1])) continue;
    blocks.push(lines.slice(i, i + 3).join('\n'));
    i += 2;
  }
  const text = blocks.join('\n\n');
  const metric = label => text ? lines.find(line => line.startsWith(`# ${label}:`))?.replace(/^# [^:]+:\s*/, '').trim() || '' : '';
  return { text, identity: metric('Identity'), gaps: metric('Gaps') };
}

export function renderAlignmentHtml(text, sites = []) {
  const lines = String(text || '').split('\n');
  const byColumn = new Map(sites.map((site, index) => [site.alignmentPosition, { site, index }]));
  let offset = 0;
  const columnClass = (base, opposite) => base === '-' || opposite === '-' ? 'aln-gap'
    : base === 'N' || opposite === 'N' ? 'uncalled' : base !== opposite ? 'aln-mismatch'
    : /[RYKMSWBDHV]/i.test(base) ? 'amb' : '';
  return lines.map((line, i) => {
    const row = line.match(READ_ROW);
    if (!row) {
      const forward = lines[i - 1]?.match(READ_ROW);
      const reverse = lines[i + 1]?.match(READ_ROW);
      if (forward?.[1].toLowerCase() !== 'forward' || !reverse || !/^reverse/i.test(reverse[1])) return escapeHtml(line);
      const start = forward[1].length + forward[2].length;
      return [...line].map((marker, index) => {
        const column = index - start;
        if (column < 0 || column >= forward[3].length) return escapeHtml(marker);
        const className = columnClass(forward[3][column], reverse[3][column]);
        const conflict = byColumn.get(offset + column + 1);
        return className ? `<span class="${className}${conflict ? ' alignment-marker' : ''}"${conflict ? ` data-conflict-index="${conflict.index}"` : ''}>${escapeHtml(marker)}</span>` : escapeHtml(marker);
      }).join('');
    }
    const other = lines[i + (row[1].toLowerCase() === 'forward' ? 2 : -2)]?.match(READ_ROW);
    if (!other || row[3].length !== other[3].length) return escapeHtml(line);
    const bases = [...row[3]].map((base, column) => {
      const opposite = other[3][column];
      const className = columnClass(base, opposite);
      const markup = className ? `<span class="${className}">${base}</span>` : base;
      const conflict = byColumn.get(offset + column + 1);
      return conflict ? conflictButton(markup, conflict.site, conflict.index) : markup;
    }).join('');
    if (/^reverse/i.test(row[1])) offset += row[3].length;
    return escapeHtml(row[1] + row[2]) + bases + escapeHtml(row[4]);
  }).join('\n');
}

export function renderAlignmentStats(alignment) {
  return [['Identity', alignment.identity], ['Gaps', alignment.gaps]].filter(([, value]) => value).map(([label, value]) => {
    const metric = value.match(/^(\d+)\/(\d+)\s+\((\d+(?:\.\d+)?%)\)$/);
    const body = metric
      ? `<strong>${metric[3]}</strong><span>${metric[1]} / ${metric[2]} alignment columns</span>`
      : `<span>${escapeHtml(value)}</span>`;
    return `<div class="alignment-stat"><dt>${label}</dt><dd>${body}</dd></div>`;
  }).join('');
}

function conflictButton(markup, site, index) {
  return `<button type="button" class="conflict-base" data-conflict-index="${index}" title="Inspect consensus base ${site.position} in chromatograms" aria-label="Inspect consensus base ${site.position}: forward ${site.forwardBase}, reverse ${site.reverseBase}">${markup}</button>`;
}

// Add navigation only to sites reported by the server; FASTA exports still use
// the original report. Wrappers never add spaces or change sequence text.
export function renderConsensusHtml(fasta, sites = []) {
  const byPosition = new Map(sites.map((site, index) => [site.position, { site, index }]));
  let position = 0;
  return String(fasta || '').split('\n').map(line => {
    if (!/^[ACGTNRYKMSWBDHV]+$/i.test(line)) return escapeHtml(line);
    return [...line].map(base => {
      const className = base === 'N' ? 'uncalled' : /[RYKMSWBDHV]/.test(base) ? 'amb' : '';
      const conflict = byPosition.get(++position);
      const markup = className ? `<span class="${className}">${base}</span>`
        : conflict ? `<span class="aln-mismatch">${base}</span>` : base;
      return conflict ? conflictButton(markup, conflict.site, conflict.index) : markup;
    }).join('');
  }).join('\n');
}

// "Position" in a conflict table is one-based in that report's consensus.
// The read positions are already adjusted for Mott trimming by the API.
export function extractConflictSites(report) {
  const source = String(report || '');
  const alignment = extractReadAlignment(source).text;
  const readRows = alignment.split('\n').map(line => line.match(READ_ROW)).filter(Boolean);
  const forward = readRows.filter(row => /^forward$/i.test(row[1])).map(row => row[3]).join('');
  const reverse = readRows.filter(row => /^reverse/i.test(row[1])).map(row => row[3]).join('');
  const shared = [...forward].flatMap((base, index) => base !== '-' && reverse[index] && reverse[index] !== '-' ? [index + 1] : []);
  const reverseComplemented = /R\.ab1_pos refers to the Reverse Complement/i.test(source) || /reverse_rc\s+\d/i.test(alignment)
    ? true : /reverse\s+\d/i.test(alignment) ? false : null;
  const rows = [];
  let active = false;
  let available = /#\s*No conflicts\b/i.test(source);
  for (const line of source.split(/\r?\n/)) {
    if (/^#\s*==== Conflicts:/i.test(line)) { active = true; available = true; continue; }
    if (!active) continue;
    if (!line.startsWith('#') || /^#\s*={3,}/.test(line)) { active = false; continue; }
    const row = line.match(/^#\s+(\d+|inbetween\s+\d+-\d+)\s+(\d+|inbetween\s+\d+-\d+)\s+(\d+)\s+([ACGTNRYKMSWBDHV-])\s+(\d+|-)\s+([ACGTNRYKMSWBDHV-])\s+(\d+|-)\s+'?([ACGTNRYKMSWBDHV])'?\s*$/i);
    if (!row) continue;
    const position = Number(row[3]);
    // Single-read overhangs remain shaded as gaps but aren't conflicts to review.
    if (shared.length && (position < shared[0] || position > shared.at(-1))) continue;
    if (row[4] === row[6]) continue;
    rows.push({ position, alignmentPosition: position,
      forwardPosition: /^\d+$/.test(row[1]) ? Number(row[1]) : null,
      reversePosition: /^\d+$/.test(row[2]) ? Number(row[2]) : null,
      forwardBase: row[4], reverseBase: row[6], consensusBase: row[8], reverseComplemented });
  }
  return { available, rows };
}

export function outputConflictSites(report, fullReport, primerTrimmed = false) {
  if (!primerTrimmed) return extractConflictSites(report);
  const source = extractConflictSites(fullReport);
  const full = extractCleanFasta(fullReport).seq;
  const trimmed = extractCleanFasta(report).seq;
  const offset = trimmed ? full.indexOf(trimmed) : -1;
  // Do not guess a coordinate offset for repeated/absent sequence fragments.
  if (!source.available || offset < 0 || full.indexOf(trimmed, offset + 1) !== -1) return { available: false, rows: [] };
  return { available: true, rows: source.rows.filter(row => row.position > offset && row.position <= offset + trimmed.length)
    .map(row => ({ ...row, position: row.position - offset })) };
}

// Routine successful primer coordinates stay in downloadable reports. Fallbacks
// and failed matches remain visible, including responses from older APIs.
export function primerWarnings(result) {
  if (!result.request.primers.forward && !result.request.primers.reverse) return [];
  const failures = Object.entries(result.analysis?.primer_outcomes || {})
    .filter(([, outcome]) => outcome && !['matched', 'omitted'].includes(outcome.status));
  const reportNotes = String(result.outputs.primer_trim || '').split(/\r?\n/)
    .filter(line => /^#/.test(line) && /warning|fallback|falling back|not found|not detected|not match|upstream/i.test(line))
    .map(line => line.replace(/^#\s*/, ''));
  // Structured "omitted" outcomes do not describe the fallback trimming at that
  // end. Keep report explanations for those ends, without duplicating failures
  // already explained by structured metadata for the same primer direction.
  const additionalNotes = reportNotes.filter(note => !failures.some(([direction]) => note.toLowerCase().includes(direction.toLowerCase())));
  return [...new Set([
    ...failures.map(([, outcome]) => outcome.message || 'A primer did not anchor confidently. Review the report before using the sequence.'),
    ...additionalNotes,
  ])];
}


// Read each output's own report: primer-trimmed peak positions are already
// remapped by the API and must not be borrowed from the full-merge summary.
export function extractSecondaryPeaks(report) {
  const results = {
    forward: { status: 'unavailable', rows: [], note: '' },
    reverse: { status: 'unavailable', rows: [], note: '' },
  };
  let active = null;
  for (const line of String(report || '').split(/\r?\n/)) {
    const heading = line.match(/^#\s*==== Significant secondary peaks in (Forward|Reverse) Chromatogram:/i);
    const empty = line.match(/^#\s*No significant secondary peak in "(Forward|Reverse) Chromatogram"/i);
    if (heading || empty) {
      active = (heading || empty)[1].toLowerCase();
      results[active].status = heading ? 'detected' : 'none';
      if (empty) active = null;
      continue;
    }
    if (!active) continue;
    if (/^#\s*(?:={3,}|====)/.test(line) || !line.startsWith('#')) {
      active = null;
      continue;
    }
    if (/^#\s*Note:/.test(line)) {
      results[active].note = line.replace(/^#\s*Note:\s*/, '');
      continue;
    }
    const row = line.match(/^#\s+(\d+)\s+(\d+)\s+([ACGTNRYKMSWBDHV])\s+([ACGTNRYKMSWBDHV])\s+(\d+(?:\.\d+)?)\s*$/i);
    if (row) results[active].rows.push({ tracePosition: row[1], position: row[2], primary: row[3], secondary: row[4], percentage: row[5] });
  }
  for (const section of Object.values(results)) {
    if (section.status === 'detected' && section.rows.length === 0) section.status = 'unavailable';
  }
  return results;
}

export function renderSecondaryPeaksHtml(report) {
  const sections = extractSecondaryPeaks(report);
  const rows = Object.entries(sections).flatMap(([direction, section]) => section.rows.map(row =>
    `<tr><th scope="row">${direction === 'forward' ? 'Forward' : 'Reverse'}</th><td>${row.tracePosition}</td><td>${row.position}</td><td>${row.primary}</td><td class="peak-base">${row.secondary}</td><td>${row.percentage}%</td></tr>`));
  const table = rows.length ? `<div class="peak-table-wrap" tabindex="0" aria-label="Secondary peak results"><table class="peak-table"><caption>Detected secondary peaks</caption><thead><tr><th scope="col">Read</th><th scope="col">Trace position</th><th scope="col">Consensus position</th><th scope="col">Primary base</th><th scope="col">Secondary base</th><th scope="col">Peak ratio</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '';
  const notices = Object.entries(sections).filter(([, section]) => section.status !== 'detected').map(([direction, section]) =>
    `<p class="small peak-status">${direction === 'forward' ? 'Forward' : 'Reverse'}: ${section.status === 'none' ? 'no significant secondary peaks detected.' : 'secondary-peak results were not included in this report.'}</p>`).join('');
  const note = sections.reverse.note ? `<p class="small peak-status">${escapeHtml(sections.reverse.note)}</p>` : '';
  const hint = rows.length ? '<p class="small peak-scroll-hint">Scroll the table sideways for bases and peak ratios →</p>' : '';
  return table + hint + notices + note;
}
