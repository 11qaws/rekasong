import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observePlaybackCadenceFrame,
  summarizePlaybackCadence,
} from '../scripts/obs-v2-playback-cadence.mjs';

const playbackFrame = (event, mediaTime, extra = {}) => JSON.stringify({
  type: 'playback_event',
  event,
  runId: 'run-1',
  entryId: 'entry-1',
  mediaTime,
  duration: 300,
  token: 'must-not-survive',
  song: { title: 'must-not-survive' },
  ...extra,
});

test('cadence observer keeps only bounded non-sensitive playback evidence', () => {
  assert.equal(observePlaybackCadenceFrame('{broken'), null);
  assert.equal(observePlaybackCadenceFrame(JSON.stringify({ type: 'player_snapshot' })), null);

  const record = observePlaybackCadenceFrame(playbackFrame('position', 30), 31_000);
  assert.deepEqual(record, {
    event: 'position',
    runId: 'run-1',
    entryId: 'entry-1',
    mediaTime: 30,
    duration: 300,
    receivedAt: 31_000,
  });
  assert.equal('token' in record, false);
  assert.equal('song' in record, false);
});

test('five-minute uninterrupted playback accepts nine 30-second observations', () => {
  const records = [
    observePlaybackCadenceFrame(playbackFrame('playing', 0), 1_000),
    ...Array.from({ length: 9 }, (_, index) => observePlaybackCadenceFrame(
      playbackFrame('position', (index + 1) * 30),
      31_000 + (index * 30_000),
    )),
    observePlaybackCadenceFrame(playbackFrame('ended', 300), 301_000),
  ];
  const summary = summarizePlaybackCadence(records, {
    runId: 'run-1',
    durationMs: 300_000,
    intervalMs: 30_000,
  });

  assert.equal(summary.positionCount, 9);
  assert.equal(summary.expectedMinimumPositionCount, 9);
  assert.equal(summary.expectedMaximumPositionCount, 10);
  assert.equal(summary.positionCountWithinExpectedRange, true);
  assert.equal(summary.positionsStrictlyIncrease, true);
  assert.equal(summary.positionGapWithinTolerance, true);
  assert.equal(summary.eventCounts.playing, 1);
  assert.equal(summary.eventCounts.ended, 1);
});

test('cadence summary rejects rapid duplicates, backward time, and extra observations', () => {
  const records = [
    observePlaybackCadenceFrame(playbackFrame('position', 30), 30_000),
    observePlaybackCadenceFrame(playbackFrame('position', 60), 31_000),
    observePlaybackCadenceFrame(playbackFrame('position', 59), 60_000),
    ...Array.from({ length: 8 }, (_, index) => observePlaybackCadenceFrame(
      playbackFrame('position', 90 + (index * 30)),
      90_000 + (index * 30_000),
    )),
  ];
  const summary = summarizePlaybackCadence(records, {
    runId: 'run-1',
    durationMs: 300_000,
    intervalMs: 30_000,
  });

  assert.equal(summary.positionCount, 11);
  assert.equal(summary.positionCountWithinExpectedRange, false);
  assert.equal(summary.positionsStrictlyIncrease, false);
  assert.equal(summary.minimumReceivedGapMs, 1_000);
  assert.equal(summary.positionGapWithinTolerance, false);
});
