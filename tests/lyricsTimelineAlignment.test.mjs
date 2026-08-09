import test from 'node:test';
import assert from 'node:assert/strict';

import { remapCueAnchorsByReferences } from '../src/lib/lyrics/lyricsTimelineAlignment.js';

test('two references align a whole source-caption timeline to an instrumental track', () => {
  const cues = [
    { cueId: 'C1', anchorMs: 10_000 },
    { cueId: 'C2', anchorMs: 60_000 },
    { cueId: 'C3', anchorMs: 110_000 },
  ];
  assert.deepEqual(
    remapCueAnchorsByReferences(cues, {
      sourceStartMs: 10_000,
      targetStartMs: 15_000,
      sourceEndMs: 110_000,
      targetEndMs: 125_000,
    }).map((cue) => cue.anchorMs),
    [15_000, 70_000, 125_000],
  );
  assert.equal(cues[0].anchorMs, 10_000, 'source cues remain immutable');
});

test('unsafe or reversed timing references fail closed', () => {
  assert.throws(
    () => remapCueAnchorsByReferences([], {
      sourceStartMs: 10_000,
      targetStartMs: 5_000,
      sourceEndMs: 10_000,
      targetEndMs: 20_000,
    }),
    /lyrics_timing_references_invalid/,
  );
  assert.throws(
    () => remapCueAnchorsByReferences([], {
      sourceStartMs: 0,
      targetStartMs: 0,
      sourceEndMs: 100_000,
      targetEndMs: 250_000,
    }),
    /lyrics_timing_scale_unsafe/,
  );
});
