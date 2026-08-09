import test from 'node:test';
import assert from 'node:assert/strict';

import { compileLyricsTimeline, resolveLyricsTimeline } from '../src/lib/lyrics/lyricsCueTimeline.js';
import { msToTick } from '../src/lib/lyrics/lyricsTempoMap.js';

const tempoMap = {
  ppq: 960,
  segments: [{ startTick: 0, startMs: 0, bpm: 130, numerator: 4, denominator: 4, downbeatTick: 0 }],
};

const cue = (cueId, kind, anchorMs) => ({
  cueId,
  kind,
  anchorMs,
  anchorTick: msToTick(tempoMap, anchorMs),
  originalLines: kind === 'lyric' ? [`<HAMELN synthetic original ${cueId}>`] : [],
  translationLinesKo: kind === 'lyric' ? [`<HAMELN synthetic ko ${cueId}>`] : [],
  romanizationLines: [],
});

test('synthetic HAMELN 130 BPM lyric, blank, and return cues use exact shared boundaries', () => {
  const timeline = compileLyricsTimeline({
    timingMode: 'tempo_map',
    ppq: tempoMap.ppq,
    tempoSegments: tempoMap.segments,
    transitionRule: { fadeStartTicksBeforeAnchor: 960, fadeEndTicksBeforeAnchor: 480 },
    cues: [cue('C001', 'lyric', 60_000), cue('B001', 'blank', 90_000), cue('C002', 'lyric', 105_000)],
  });
  const quarter = 60_000 / 130;
  for (const [index, anchor] of [[0, 60_000], [1, 90_000], [2, 105_000]]) {
    assert.ok(Math.abs(timeline[index].fadeStartMs - (anchor - quarter)) < 0.001);
    assert.ok(Math.abs(timeline[index].fadeEndMs - (anchor - quarter / 2)) < 0.001);
  }
  assert.equal(resolveLyricsTimeline(timeline, 90_000).phase, 'blank');
  assert.equal(resolveLyricsTimeline(timeline, 90_000).visualCue, null);
  const returnState = resolveLyricsTimeline(timeline, 105_000 - quarter / 2);
  assert.equal(returnState.destinationCue.cueId, 'C002');
  assert.equal(returnState.destinationOpacity, 1);
  assert.equal(returnState.wordHighlightActive, false);
  assert.equal(resolveLyricsTimeline(timeline, 105_000).wordHighlightActive, true);
});
