import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expireLocalBlobEntry,
  planLocalBlobHistoryBudget,
  restoreLocalBlobSong,
} from '../src/lib/blobLifecycle.js';

const MiB = 1024 * 1024;
const localEntry = (id, createdAt, bytes = 50 * MiB, src = `blob:${id}`, phase = 'completed') => ({
  entryId: id,
  phase,
  completionReason: phase === 'completed' ? 'natural' : null,
  createdAt,
  song: {
    type: 'local',
    src,
    title: id,
    artist: '',
    tags: [],
    source: 'local',
    mediaType: 'audio',
    ...(bytes == null ? {} : { localBlobBytes: bytes }),
  },
});

test('history budget retains only the newest five unprotected Blob sources', () => {
  const history = Array.from({ length: 7 }, (_, index) => localEntry(`file-${index}`, index, MiB));
  const snapshot = structuredClone(history);
  const plan = planLocalBlobHistoryBudget({ history, queue: [], currentEntry: null });

  assert.equal(plan.changed, true);
  assert.deepEqual(plan.revokeSrcs.sort(), ['blob:file-0', 'blob:file-1']);
  assert.equal(plan.expiredEntryCount, 2);
  assert.equal(plan.history[0].song.localSourceExpired, true);
  assert.equal(plan.history[0].song.src, '');
  assert.equal(plan.history[2].song.src, 'blob:file-2');
  assert.deepEqual(history, snapshot, 'the planner must not mutate live state');
});

test('byte budget expires older sources even below the count limit', () => {
  const history = [
    localEntry('old', 1, 100 * MiB),
    localEntry('middle', 2, 100 * MiB),
    localEntry('new', 3, 100 * MiB),
  ];
  const plan = planLocalBlobHistoryBudget({ history }, { maxSources: 5, maxBytes: 256 * MiB });

  assert.deepEqual(plan.revokeSrcs, ['blob:old']);
  assert.equal(plan.retainedSources, 2);
  assert.equal(plan.retainedBytes, 200 * MiB);
});

test('current and queued sources are protected even when completed history is over budget', () => {
  const protectedCurrent = localEntry('current', 0, 200 * MiB, 'blob:current', 'playing');
  const protectedQueue = localEntry('queued', 0, 200 * MiB, 'blob:queued', 'queued');
  const history = [
    localEntry('old-current-copy', 1, 200 * MiB, 'blob:current'),
    localEntry('old-queue-copy', 2, 200 * MiB, 'blob:queued'),
    localEntry('history-only', 3, 200 * MiB, 'blob:history-only'),
  ];
  const plan = planLocalBlobHistoryBudget({
    history,
    queue: [protectedQueue],
    currentEntry: protectedCurrent,
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.revokeSrcs, []);
  assert.equal(plan.protectedSources, 2);
  assert.equal(plan.retainedSources, 1);
});

test('every history entry sharing one Blob source expires atomically', () => {
  const history = [
    localEntry('shared-old', 1, 150 * MiB, 'blob:shared'),
    localEntry('newer', 3, 150 * MiB, 'blob:newer'),
    localEntry('shared-replay', 2, 150 * MiB, 'blob:shared'),
  ];
  const plan = planLocalBlobHistoryBudget({ history }, { maxSources: 5, maxBytes: 200 * MiB });

  assert.deepEqual(plan.revokeSrcs, ['blob:shared']);
  assert.equal(plan.expiredEntryCount, 2);
  assert.equal(plan.history[0].song.localSourceExpired, true);
  assert.equal(plan.history[2].song.localSourceExpired, true);
  assert.equal(plan.history[1].song.src, 'blob:newer');
});

test('an unknown legacy size consumes the whole byte budget instead of counting as zero', () => {
  const history = [
    localEntry('unknown-new', 2, null),
    localEntry('known-old', 1, MiB),
  ];
  const plan = planLocalBlobHistoryBudget({ history });

  assert.deepEqual(plan.revokeSrcs, ['blob:known-old']);
  assert.equal(plan.retainedBytes, 256 * MiB);
});

test('zero source or byte budgets cannot retain an unknown-size Blob', () => {
  const history = [localEntry('unknown-zero-budget', 1, null, 'blob:unknown-zero-budget')];

  const noSources = planLocalBlobHistoryBudget({ history }, { maxSources: 0, maxBytes: 256 * MiB });
  const noBytes = planLocalBlobHistoryBudget({ history }, { maxSources: 5, maxBytes: 0 });

  assert.equal(noSources.history[0].song.localSourceExpired, true);
  assert.equal(noBytes.history[0].song.localSourceExpired, true);
  assert.deepEqual(noSources.revokeSrcs, ['blob:unknown-zero-budget']);
  assert.deepEqual(noBytes.revokeSrcs, ['blob:unknown-zero-budget']);
});

test('a zero-byte budget or individually oversized source expires known-size Blobs', () => {
  const known = [localEntry('known-zero-budget', 1, MiB)];
  const oversized = [localEntry('oversized', 1, 300 * MiB)];

  const noBytes = planLocalBlobHistoryBudget({ history: known }, { maxSources: 5, maxBytes: 0 });
  const aboveLimit = planLocalBlobHistoryBudget({ history: oversized }, {
    maxSources: 5,
    maxBytes: 256 * MiB,
  });

  assert.equal(noBytes.history[0].song.localSourceExpired, true);
  assert.equal(aboveLimit.history[0].song.localSourceExpired, true);
  assert.deepEqual(aboveLimit.revokeSrcs, ['blob:oversized']);
});

test('expiration and explicit restoration preserve metadata while changing source availability', () => {
  const entry = localEntry('restore-me', 1, 10 * MiB);
  const expired = expireLocalBlobEntry(entry);
  const restored = restoreLocalBlobSong(expired.song, {
    src: 'blob:replacement',
    bytes: 12 * MiB,
    mediaType: 'audio',
  });

  assert.equal(expired.entryId, entry.entryId);
  assert.equal(expired.song.title, entry.song.title);
  assert.equal(expired.song.src, '');
  assert.equal(restored.title, entry.song.title);
  assert.equal(restored.src, 'blob:replacement');
  assert.equal(restored.localBlobBytes, 12 * MiB);
  assert.equal(restored.localSourceExpired, undefined);
});
