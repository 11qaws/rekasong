import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileLyricsTimeline,
  resolveLyricsTimeline,
} from '../src/lib/lyrics/lyricsCueTimeline.js';

const fixture = {
  timingMode: 'fixed_ms_fallback',
  ppq: 960,
  transitionRule: {
    fallbackFadeStartMsBeforeAnchor: 600,
    fallbackFadeEndMsBeforeAnchor: 300,
  },
  tempoSegments: [],
  cues: [
    { cueId: 'C1', kind: 'lyric', anchorMs: 1_000, originalLines: ['one'], translationLinesKo: ['하나'] },
    { cueId: 'C2', kind: 'lyric', anchorMs: 2_000, originalLines: ['two'], translationLinesKo: ['둘'] },
    { cueId: 'B1', kind: 'blank', anchorMs: 3_000, originalLines: [], translationLinesKo: [] },
    { cueId: 'B2', kind: 'blank', anchorMs: 4_000, originalLines: [], translationLinesKo: [] },
    { cueId: 'C3', kind: 'lyric', anchorMs: 5_000, originalLines: ['three'], translationLinesKo: ['셋'] },
  ],
};

test('lyric, blank, and return transitions use one deterministic destination-anchor rule', () => {
  const timeline = compileLyricsTimeline(fixture);
  assert.deepEqual(timeline.map(({ fadeStartMs, fadeEndMs }) => [fadeStartMs, fadeEndMs]), [
    [400, 700],
    [1_400, 1_700],
    [2_400, 2_700],
    [3_400, 3_700],
    [4_400, 4_700],
  ]);

  const lyricFade = resolveLyricsTimeline(timeline, 1_550);
  assert.equal(lyricFade.previousCue.cueId, 'C1');
  assert.equal(lyricFade.destinationCue.cueId, 'C2');
  assert.ok(lyricFade.previousOpacity > 0 && lyricFade.destinationOpacity > 0);
  assert.equal(lyricFade.wordHighlightActive, false);

  const blankFade = resolveLyricsTimeline(timeline, 2_550);
  assert.equal(blankFade.previousCue.cueId, 'C2');
  assert.equal(blankFade.destinationCue, null);
  assert.equal(blankFade.destinationOpacity, 0);
  assert.equal(resolveLyricsTimeline(timeline, 3_800).visualCue, null);

  const returnFade = resolveLyricsTimeline(timeline, 4_550);
  assert.equal(returnFade.previousCue, null);
  assert.equal(returnFade.destinationCue.cueId, 'C3');
  assert.equal(resolveLyricsTimeline(timeline, 5_001).wordHighlightActive, true);
});

test('seek, backward seek, pause, and playback rate are absolute media-time lookups', () => {
  const timeline = compileLyricsTimeline(fixture);
  const first = resolveLyricsTimeline(timeline, 4_550);
  const repeated = resolveLyricsTimeline(timeline, 4_550);
  assert.deepEqual(first, repeated);
  assert.equal(resolveLyricsTimeline(timeline, 2_100).visualCue.cueId, 'C2');
  assert.equal(resolveLyricsTimeline(timeline, 1_100).visualCue.cueId, 'C1');
});

test('first cue clamps at zero and close cues report a visible collision', () => {
  const timeline = compileLyricsTimeline({
    ...fixture,
    cues: [
      { ...fixture.cues[0], anchorMs: 200 },
      { ...fixture.cues[1], anchorMs: 300 },
    ],
  });
  assert.equal(timeline[0].fadeStartMs, 0);
  assert.equal(timeline[1].fadeStartMs, 200);
  assert.equal(timeline[1].collision, true);
});

test('cue overrides replace computed fade boundaries without changing the anchor', () => {
  const timeline = compileLyricsTimeline({
    ...fixture,
    cues: [{ ...fixture.cues[0], transitionOverride: { fadeStartMs: 100, fadeEndMs: 180 } }],
  });
  assert.equal(timeline[0].fadeStartMs, 100);
  assert.equal(timeline[0].fadeEndMs, 180);
  assert.equal(timeline[0].anchorMs, 1_000);
});
