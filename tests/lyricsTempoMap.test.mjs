import test from 'node:test';
import assert from 'node:assert/strict';

import {
  msToTick,
  musicalPositionAtTick,
  tickToMs,
  transitionBoundaryMs,
  validateTempoMap,
} from '../src/lib/lyrics/lyricsTempoMap.js';

const map = (bpm, overrides = {}) => ({
  ppq: 960,
  segments: [{
    startTick: 0,
    startMs: 0,
    bpm,
    numerator: 4,
    denominator: 4,
    downbeatTick: 0,
    ...overrides,
  }],
});

test('100 and 130 BPM boundaries are one quarter and one eighth before the anchor', () => {
  const at100 = transitionBoundaryMs({ anchorMs: 60_000, anchorTick: 96_000, tempoMap: map(100) });
  assert.equal(at100.fadeStartMs, 59_400);
  assert.equal(at100.fadeEndMs, 59_700);

  const anchorTick130 = msToTick(map(130), 60_000);
  const at130 = transitionBoundaryMs({ anchorMs: 60_000, anchorTick: anchorTick130, tempoMap: map(130) });
  assert.ok(Math.abs(at130.fadeStartMs - 59_538.461538) < 0.001);
  assert.ok(Math.abs(at130.fadeEndMs - 59_769.230769) < 0.001);
});

test('tick conversion integrates across tempo boundaries instead of subtracting one anchor BPM', () => {
  const changing = {
    ppq: 960,
    segments: [
      { startTick: 0, startMs: 0, bpm: 120, numerator: 4, denominator: 4, downbeatTick: 0 },
      { startTick: 1_920, startMs: 1_000, bpm: 60, numerator: 3, denominator: 4, downbeatTick: 1_920 },
    ],
  };
  assert.equal(tickToMs(changing, 2_880), 2_000);
  assert.equal(msToTick(changing, 2_000), 2_880);
  const boundary = transitionBoundaryMs({ anchorTick: 2_400, anchorMs: 1_500, tempoMap: changing });
  assert.equal(boundary.fadeStartMs, 750);
  assert.equal(boundary.fadeEndMs, 1_000);
});

test('time signatures change bar and beat projection without changing quarter-note PPQ', () => {
  const threeFour = map(100, { numerator: 3, denominator: 4 });
  assert.deepEqual(musicalPositionAtTick(threeFour, 2_880), { bar: 2, beat: 1, tickInBeat: 0 });
  const sixEight = map(100, { numerator: 6, denominator: 8 });
  assert.deepEqual(musicalPositionAtTick(sixEight, 2_880), { bar: 2, beat: 1, tickInBeat: 0 });
  assert.equal(validateTempoMap({ ppq: 960, segments: [] }).ok, false);
  assert.equal(tickToMs(map(100), -100), 0);
});
