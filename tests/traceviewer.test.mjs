import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseABIF,
  revcomp,
  alignColumns,
  computeMottTrimWindow,
  detectTraceSecondaryPeaks,
  attachTraceViewer,
} from '../src/scripts/traceviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(__dirname, '../public/demo');

// Helper: builds a minimal valid ABIF binary buffer from synthetic tag entries.
function buildSyntheticAbif(tagSpecs) {
  const dirOffset = 64;
  const dirBytes = tagSpecs.length * 28;
  let heapOffset = dirOffset + dirBytes;
  const heapChunks = [];

  const prepared = tagSpecs.map((spec) => {
    const { tag, number, elemType, elemSize, bytes } = spec;
    const dataSize = bytes.length;
    const numElems = Math.floor(dataSize / elemSize);
    let dataOffset = 0;
    if (dataSize > 4) {
      dataOffset = heapOffset;
      heapChunks.push(bytes);
      heapOffset += dataSize;
    }
    return { tag, number, elemType, elemSize, numElems, dataSize, dataOffset, bytes };
  });

  const buf = new ArrayBuffer(heapOffset);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // 'ABIF' magic + version 101 + root tdir header
  u8.set([0x41, 0x42, 0x49, 0x46], 0);
  view.setUint16(4, 101);
  view.setUint32(18, prepared.length);
  view.setUint32(26, dirOffset);

  prepared.forEach((entry, idx) => {
    const p = dirOffset + idx * 28;
    for (let k = 0; k < 4; k++) {
      u8[p + k] = entry.tag.charCodeAt(k) || 0;
    }
    view.setUint32(p + 4, entry.number);
    view.setUint16(p + 8, entry.elemType);
    view.setUint16(p + 10, entry.elemSize);
    view.setUint32(p + 12, entry.numElems);
    view.setUint32(p + 16, entry.dataSize);
    if (entry.dataSize <= 4) {
      for (let k = 0; k < entry.bytes.length; k++) {
        u8[p + 20 + k] = entry.bytes[k];
      }
    } else {
      view.setUint32(p + 20, entry.dataOffset);
      u8.set(entry.bytes, entry.dataOffset);
    }
  });

  return buf;
}

function encodeInt16BE(values) {
  const buf = new ArrayBuffer(values.length * 2);
  const v = new DataView(buf);
  values.forEach((n, i) => v.setInt16(i * 2, n));
  return new Uint8Array(buf);
}

test('parseABIF parses bundled demo .ab1 files with numeric Phred scores', () => {
  const fwdBuf = fs.readFileSync(path.join(DEMO_DIR, 'fwd_control.ab1'));
  const revBuf = fs.readFileSync(path.join(DEMO_DIR, 'rev_control.ab1'));
  const fwd = parseABIF(fwdBuf.buffer.slice(fwdBuf.byteOffset, fwdBuf.byteOffset + fwdBuf.byteLength));
  const rev = parseABIF(revBuf.buffer.slice(revBuf.byteOffset, revBuf.byteOffset + revBuf.byteLength));

  assert.equal(fwd.bases.length, 399);
  assert.equal(rev.bases.length, 397);
  assert.ok(Array.isArray(fwd.qual), 'qual must be a numeric array, not a string');
  assert.equal(fwd.qual.length, 399);
  assert.equal(typeof fwd.qual[20], 'number');
  assert.equal(fwd.ploc.length, 399);
  for (const ch of ['G', 'A', 'T', 'C']) {
    assert.ok(fwd.channels[ch].length > 1000, `channel ${ch} has trace samples`);
  }
});

test('parseABIF decodes inline FWO_1 != GATC and keeps PCON2 >= 32 numeric', () => {
  // Regression test for two critical ABIF bugs:
  // 1) Inline FWO_1 ('CTAG', 4 bytes at entryOffset + 20) must map DATA9->C, DATA10->T, DATA11->A, DATA12->G.
  // 2) PCON2 with all Q=45 (ASCII '-') must stay a number array, never decoded as text.
  const bases = 'ACGTACGT';
  const quals = new Uint8Array(8).fill(45); // ASCII 45 === '-' (printable!)
  const ploc = encodeInt16BE([5, 15, 25, 35, 45, 55, 65, 75]);
  const chC = encodeInt16BE(new Array(90).fill(111));
  const chT = encodeInt16BE(new Array(90).fill(222));
  const chA = encodeInt16BE(new Array(90).fill(333));
  const chG = encodeInt16BE(new Array(90).fill(444));

  const buf = buildSyntheticAbif([
    { tag: 'FWO_', number: 1, elemType: 2, elemSize: 1, bytes: new TextEncoder().encode('CTAG') },
    { tag: 'PBAS', number: 2, elemType: 2, elemSize: 1, bytes: new TextEncoder().encode(bases) },
    { tag: 'PCON', number: 2, elemType: 1, elemSize: 1, bytes: quals },
    { tag: 'PLOC', number: 2, elemType: 4, elemSize: 2, bytes: ploc },
    { tag: 'DATA', number: 9, elemType: 4, elemSize: 2, bytes: chC },
    { tag: 'DATA', number: 10, elemType: 4, elemSize: 2, bytes: chT },
    { tag: 'DATA', number: 11, elemType: 4, elemSize: 2, bytes: chA },
    { tag: 'DATA', number: 12, elemType: 4, elemSize: 2, bytes: chG },
  ]);

  const parsed = parseABIF(buf);
  assert.equal(parsed.fwo, 'CTAG');
  assert.equal(parsed.channels.C[0], 111);
  assert.equal(parsed.channels.T[0], 222);
  assert.equal(parsed.channels.A[0], 333);
  assert.equal(parsed.channels.G[0], 444);
  assert.ok(Array.isArray(parsed.qual));
  assert.deepEqual(parsed.qual, [45, 45, 45, 45, 45, 45, 45, 45]);
});

test('computeMottTrimWindow trims low-quality 5-prime and 3-prime tails identically to backend', () => {
  const quals = [
    ...new Array(8).fill(5),   // P(err) = 0.316 > 0.05 -> trimmed
    ...new Array(30).fill(40), // P(err) = 0.0001 < 0.05 -> kept
    ...new Array(7).fill(4),   // P(err) = 0.398 > 0.05 -> trimmed
  ];
  const [start, end] = computeMottTrimWindow(quals, 0.05);
  assert.equal(start, 8);
  assert.equal(end, 38);

  // All-low-quality safeguard returns full length
  const allBad = new Array(30).fill(2);
  assert.deepEqual(computeMottTrimWindow(allBad, 0.05), [0, 30]);
});

test('detectTraceSecondaryPeaks finds local secondary maxima above threshold', () => {
  const A = new Array(40).fill(10);
  const G = new Array(40).fill(10);
  const C = new Array(40).fill(10);
  const T = new Array(40).fill(10);
  // Primary A peak = 1000 at sample 20; secondary G local max = 420 (42%) at sample 20
  A[19] = 500; A[20] = 1000; A[21] = 500;
  G[19] = 150; G[20] = 420; G[21] = 150;

  const rawRead = {
    bases: 'AAA',
    ploc: [8, 20, 32],
    channels: { A, G, C, T },
  };
  const peaks = detectTraceSecondaryPeaks(rawRead, 33, false);
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].position, 2);
  assert.equal(peaks[0].primaryBase, 'A');
  assert.equal(peaks[0].secondaryBase, 'G');
  assert.equal(peaks[0].percentage, 42);

  const compPeaks = detectTraceSecondaryPeaks(rawRead, 33, true);
  assert.equal(compPeaks[0].primaryBase, 'T');
  assert.equal(compPeaks[0].secondaryBase, 'C');
});

test('alignColumns aligns semi-global overlap and attachTraceViewer handles Reverse-only & focusBase', () => {
  const overlap = 'ACGTACGTACGTACGTACGTACGTACGTACGT';
  const fwdSeq = 'TTTTTT' + overlap;
  const revRcSeq = overlap + 'CCCCCC';
  const aln = alignColumns(fwdSeq, revRcSeq);
  assert.ok(aln);
  // Base 6 of fwdSeq aligns with base 0 of revRcSeq
  assert.equal(aln.colOfA[6], aln.colOfB[0]);

  function makeMockCanvas(width) {
    return {
      clientWidth: width,
      clientHeight: 190,
      width: width,
      height: 190,
      style: {},
      parentElement: { style: {}, parentElement: { style: {} } },
      addEventListener() {},
      getBoundingClientRect: () => ({ left: 0, width }),
      getContext: () => ({
        setTransform() {},
        clearRect() {},
        fillRect() {},
        strokeRect() {},
        fillText() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        fill() {},
        stroke() {},
        save() {},
        restore() {},
        setLineDash() {},
      }),
    };
  }

  // Simulate hidden Forward canvas (clientWidth = 0) with visible Reverse canvas (clientWidth = 640)
  const canvasF = makeMockCanvas(0);
  const canvasR = makeMockCanvas(640);
  const viewer = attachTraceViewer({ canvasF, canvasR });

  const sampleRead = {
    bases: revcomp(revRcSeq),
    ploc: Array.from({ length: revRcSeq.length }, (_, i) => i * 10 + 5),
    qual: new Array(revRcSeq.length).fill(40),
    channels: {
      A: new Array(500).fill(100),
      C: new Array(500).fill(100),
      G: new Array(500).fill(100),
      T: new Array(500).fill(100),
    },
    fwo: 'GATC',
  };

  const origBases = sampleRead.bases;
  const statsSolo = viewer.setData(null, sampleRead, '', 'rev.ab1');
  assert.equal(statsSolo.revComplemented, false);
  // Caller's read object must not be mutated
  assert.equal(sampleRead.bases, origBases);
  assert.equal(viewer.focusBase({ rPos: 5, label: 'Peak 5' }), true);
  assert.equal(viewer.focusBase({ rPos: 'inbetween 4-5', label: 'Gap' }), true);
});
