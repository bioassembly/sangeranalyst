import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeMottTrimWindow } from '../src/scripts/traceviewer.js';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/mott.json', import.meta.url)));
for (const { name, quality, cutoff, window } of fixtures) {
  test(`shared preview/pipeline Mott fixture: ${name}`, () => {
    assert.deepEqual(computeMottTrimWindow(quality, cutoff), window);
  });
}
