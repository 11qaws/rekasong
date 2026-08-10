import test from 'node:test';
import assert from 'node:assert/strict';

import { attachTrustedLyricsTiming, lyricsLineSimilarity } from '../src/lib/lyrics/lyricsTimingMatch.js';

const trusted = {
  schemaVersion: 1,
  videoId: 'abcdefghijk',
  status: 'review_required',
  sourceKind: 'vocaro_verbatim_lyrics',
  discoveryPath: ['vocaro'],
  lines: [
    'first locked lyric line',
    'second locked lyric line',
    'third locked lyric line',
    'fourth locked lyric line',
    'fifth locked lyric line',
  ],
};

test('trusted original lines keep ownership while same-track captions supply anchors', () => {
  const aligned = attachTrustedLyricsTiming(trusted, {
    sourceKind: 'youtube_auto_caption',
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    timingEstimated: false,
    discoveryPath: ['youtube_caption'],
    cues: trusted.lines.map((text, index) => ({ anchorMs: 1_000 + (index * 2_500), text: `${text}!` })),
  });

  assert.deepEqual(aligned.cues.map((cue) => cue.text), trusted.lines);
  assert.deepEqual(aligned.cues.map((cue) => cue.anchorMs), [1_000, 3_500, 6_000, 8_500, 11_000]);
  assert.equal(aligned.timingEstimated, false);
  assert.equal(aligned.timingMatchCount, trusted.lines.length);
  assert.equal(aligned.timingSourceKind, 'youtube_auto_caption');
  assert.ok(aligned.timingAlignmentConfidence >= 0.9);
});

test('low-confidence captions cannot assign timestamps to trusted lyrics', () => {
  const rejected = attachTrustedLyricsTiming(trusted, {
    sourceKind: 'youtube_auto_caption',
    cues: Array.from({ length: 5 }, (_, index) => ({ anchorMs: index * 1_000, text: `unrelated prose ${index}` })),
  });
  assert.equal(rejected, trusted);
});

test('partial trusted anchors interpolate missing lines but remain estimated', () => {
  const partialTrusted = {
    ...trusted,
    lines: [
      'red sunrise melody',
      'blue ocean refrain',
      'green forest cadence',
      'golden moon chorus',
      'silver river verse',
      'violet sky ending',
    ],
  };
  const aligned = attachTrustedLyricsTiming(partialTrusted, {
    sourceKind: 'gemini_playback_audio_timing',
    timingEstimated: true,
    timingAnalysisConfidence: 0.84,
    cues: [0, 1, 3, 4, 5].map((index) => ({
      anchorMs: 1_000 + (index * 2_500),
      text: partialTrusted.lines[index],
    })),
  });

  assert.deepEqual(aligned.cues.map((cue) => cue.text), partialTrusted.lines);
  assert.deepEqual(aligned.cues.map((cue) => cue.anchorMs), [1_000, 3_500, 6_000, 8_500, 11_000, 13_500]);
  assert.equal(aligned.timingEstimated, true);
  assert.equal(aligned.timingMatchCount, 5);
  assert.equal(aligned.timingAnalysisConfidence, 0.84);
});

test('line similarity tolerates punctuation but not unrelated wording', () => {
  assert.ok(lyricsLineSimilarity('気付いたんだ、今は', '気付いたんだ 今は!') > 0.95);
  assert.ok(lyricsLineSimilarity('locked lyric', 'different sentence') < 0.3);
});
