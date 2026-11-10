import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunState, createAnalysisExport, sampleSlug } from '../src/scripts/runstate.js';

test('changed inputs invalidate exports and obsolete responses cannot replace a completed run', () => {
  const state = createRunState();
  const first = state.begin();
  const snapshot = { request: { filenames: { forward: 'sample A.ab1' }, settings: { mottCutoff: 0.1 } }, outputs: {} };
  assert.equal(state.complete(first, snapshot), true);
  snapshot.request.filenames.forward = 'sample B.ab1';
  assert.equal(sampleSlug(state.result.request.filenames.forward), 'sample_A');
  state.invalidate();
  assert.equal(state.isFresh(), false);
  const second = state.begin();
  assert.equal(state.complete(first, snapshot), false);
  assert.equal(state.complete(second, snapshot), true);
  assert.equal(state.isFresh(), true);
});

test('analysis export records hashes and explicit missing backend provenance', async () => {
  const state = createRunState();
  state.complete(state.begin(), {
    request: { files: { forward: new Blob(['abc']) }, filenames: { forward: 'a.ab1' }, primers: { forward: null }, settings: { minPhred: 20 } },
    outputs: { consensus_strict: 'ACG' }, warnings: [], analysis: null,
  });
  const metadata = await createAnalysisExport(state.result, report => ({ seq: report }));
  assert.equal(metadata.inputs.forward.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(metadata.outputs.consensus_strict.length, 3);
  assert.equal(metadata.server_provenance.available, false);
  assert.deepEqual(metadata.parameters, { minPhred: 20 });
});
