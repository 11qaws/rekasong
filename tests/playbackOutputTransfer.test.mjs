import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitPlaybackOutputTransfer,
  createPlaybackOutputTransfer,
  createPreparedSpeakerLoadQueue,
  isPlaybackOutputTransferCommitted,
  shouldIgnoreRemotePlayback,
} from '../src/lib/playbackOutputTransfer.js';

const entry = Object.freeze({
  entryId: 'entry-a',
  song: Object.freeze({ type: 'local', src: 'blob:track-a', title: 'Track A' }),
});
const obsActive = Object.freeze({
  entryId: entry.entryId,
  runId: 'run-obs',
  phase: 'playing',
  outputMode: 'obs',
});
const speakerActive = Object.freeze({
  entryId: entry.entryId,
  runId: 'run-speaker',
  phase: 'starting',
  outputMode: 'speaker',
});

const createFixtureTransfer = () => createPlaybackOutputTransfer({
  entry,
  active: obsActive,
  targetActive: speakerActive,
  resumePosition: 41.25,
});

test('OBS to Speaker transfer atomically replaces only the active run', () => {
  const queue = Object.freeze([{ entryId: 'queued' }]);
  const history = Object.freeze([{ entryId: 'finished' }]);
  const state = Object.freeze({
    currentEntry: entry,
    active: obsActive,
    queue,
    history,
    autoPlayNext: true,
  });
  const transfer = createFixtureTransfer();
  const committed = commitPlaybackOutputTransfer(state, transfer);

  assert.notEqual(committed, state);
  assert.equal(committed.currentEntry, entry);
  assert.equal(committed.queue, queue);
  assert.equal(committed.history, history);
  assert.deepEqual(committed.active, speakerActive);
  assert.equal(transfer.resumePosition, 41.25);
  assert.equal(isPlaybackOutputTransferCommitted(transfer, committed.active), true);
});

test('stale transfer cannot replace or complete a newer run', () => {
  const transfer = createFixtureTransfer();
  const newerState = Object.freeze({
    currentEntry: entry,
    active: { ...obsActive, runId: 'run-newer' },
    history: [],
  });

  assert.equal(commitPlaybackOutputTransfer(newerState, transfer), newerState);
  assert.equal(isPlaybackOutputTransferCommitted(transfer, newerState.active), false);
});

test('remote OBS terminal evidence is fenced before and after Speaker commit', () => {
  const transfer = createFixtureTransfer();

  assert.equal(shouldIgnoreRemotePlayback({ active: obsActive, transfer }), true);
  assert.equal(shouldIgnoreRemotePlayback({ active: speakerActive, transfer: null }), true);
  assert.equal(shouldIgnoreRemotePlayback({ active: obsActive, transfer: null }), false);
});

test('prepared Speaker LOAD is claimed only after its marker commits and only once', () => {
  const preparedLoads = createPreparedSpeakerLoadQueue({ limit: 2 });
  const command = Object.freeze({ type: 'load', runId: speakerActive.runId });
  preparedLoads.enqueue({
    entryId: entry.entryId,
    runId: speakerActive.runId,
    outputMode: 'speaker',
    command,
  });

  assert.equal(preparedLoads.claim(obsActive), null);
  assert.equal(preparedLoads.size(), 1);
  assert.equal(preparedLoads.claim(speakerActive)?.command, command);
  assert.equal(preparedLoads.claim(speakerActive), null);
  assert.equal(preparedLoads.size(), 0);
});

test('prepared Speaker LOAD storage is bounded and can discard a failed transfer', () => {
  const preparedLoads = createPreparedSpeakerLoadQueue({ limit: 2 });
  for (const runId of ['run-1', 'run-2', 'run-3']) {
    preparedLoads.enqueue({
      entryId: entry.entryId,
      runId,
      outputMode: 'speaker',
      command: { type: 'load', runId },
    });
  }

  assert.equal(preparedLoads.size(), 2);
  assert.equal(preparedLoads.claim({ ...speakerActive, runId: 'run-1' }), null);
  assert.equal(preparedLoads.discard('run-2'), true);
  assert.equal(preparedLoads.size(), 1);
});

test('claiming the committed Speaker run releases every abandoned Blob command', () => {
  const preparedLoads = createPreparedSpeakerLoadQueue({ limit: 4 });
  for (const runId of ['run-stale-a', speakerActive.runId, 'run-stale-b']) {
    preparedLoads.enqueue({
      entryId: entry.entryId,
      runId,
      outputMode: 'speaker',
      command: { type: 'load', runId, song: { src: `blob:${runId}` } },
    });
  }

  assert.equal(preparedLoads.claim(speakerActive)?.runId, speakerActive.runId);
  assert.equal(preparedLoads.size(), 0);
});
