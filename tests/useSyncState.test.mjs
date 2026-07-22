import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPersistedSyncState,
  mergeCrossTabSyncState,
} from '../src/hooks/useSyncState.js';

const song = (id, title = id) => ({
  id,
  type: 'youtube',
  src: 'abcdefghijk',
  title,
});

const entry = (entryId, title = entryId) => ({
  entryId,
  phase: 'starting',
  song: song(entryId, title),
});

const localBlobEntry = (entryId, phase = 'queued') => ({
  entryId,
  phase,
  completionReason: phase === 'completed' ? 'natural' : null,
  createdAt: 100,
  song: {
    type: 'local',
    src: `blob:${entryId}`,
    title: entryId,
    source: 'local',
    mediaType: 'audio',
    localBlobBytes: 1024,
  },
});

test('cross-tab sync preserves each tab\'s current Speaker run', () => {
  const localEntry = entry('local-entry', 'Local song');
  const incomingEntry = entry('incoming-entry', 'Other tab song');
  const local = {
    currentEntry: localEntry,
    active: {
      entryId: localEntry.entryId,
      runId: 'local-run',
      phase: 'playing',
      outputMode: 'speaker',
    },
    queue: [],
    history: [],
    setlinkCatalog: [],
  };
  const incoming = {
    currentEntry: incomingEntry,
    active: {
      entryId: incomingEntry.entryId,
      runId: 'incoming-run',
      phase: 'playing',
      outputMode: 'speaker',
    },
    queue: [entry('shared-queue-entry')],
    history: [],
    setlinkCatalog: [{ title: 'Shared songbook row' }],
  };

  const merged = mergeCrossTabSyncState(local, incoming);

  assert.equal(merged.currentEntry.entryId, 'local-entry');
  assert.equal(merged.active.runId, 'local-run');
  assert.equal(merged.active.outputMode, 'speaker');
  assert.equal(merged.queue[0].entryId, 'shared-queue-entry');
  assert.deepEqual(merged.setlinkCatalog, incoming.setlinkCatalog);
});

test('another tab cannot create a phantom current song in an idle Speaker tab', () => {
  const incomingEntry = entry('incoming-entry');
  const merged = mergeCrossTabSyncState(
    { currentEntry: null, active: null, queue: [], history: [] },
    {
      currentEntry: incomingEntry,
      active: {
        entryId: incomingEntry.entryId,
        runId: 'incoming-run',
        phase: 'playing',
        outputMode: 'speaker',
      },
      queue: [],
      history: [],
    },
  );

  assert.equal(merged.currentEntry, null);
  assert.equal(merged.active, null);
});

test('localStorage payload never publishes tab-owned playback runtime', () => {
  const currentEntry = entry('local-entry');
  const persisted = createPersistedSyncState({
    currentEntry,
    active: {
      entryId: currentEntry.entryId,
      runId: 'local-run',
      phase: 'playing',
      outputMode: 'speaker',
    },
    queue: [entry('queued-entry')],
    history: [],
  });

  assert.equal(persisted.currentEntry, null);
  assert.equal(persisted.active, null);
  assert.equal(persisted.queue[0].entryId, 'queued-entry');
});

test('persisted queue and history keep local metadata but never publish Blob URLs', () => {
  const persisted = createPersistedSyncState({
    currentEntry: null,
    active: null,
    queue: [localBlobEntry('queued-local')],
    history: [localBlobEntry('history-local', 'completed')],
  });

  assert.equal(persisted.queue[0].song.src, '');
  assert.equal(persisted.queue[0].song.localSourceExpired, true);
  assert.equal(persisted.queue[0].song.localBlobBytes, 1024);
  assert.equal(persisted.history[0].song.src, '');
  assert.equal(JSON.stringify(persisted).includes('blob:'), false);
});

test('legacy stored Blob entries become restorable placeholders instead of disappearing', () => {
  const incoming = {
    currentEntry: null,
    active: null,
    queue: [localBlobEntry('legacy-queue')],
    history: [localBlobEntry('legacy-history', 'completed')],
  };
  const merged = mergeCrossTabSyncState(
    { currentEntry: null, active: null, queue: [], history: [] },
    incoming,
  );

  assert.equal(merged.queue.length, 1);
  assert.equal(merged.queue[0].song.localSourceExpired, true);
  assert.equal(merged.queue[0].song.src, '');
  assert.equal(merged.history.length, 1);
  assert.equal(merged.history[0].song.localSourceExpired, true);
});

test('another tab cannot erase or downgrade this tab\'s live local queue and history', () => {
  const localQueue = localBlobEntry('local-queue');
  const localHistory = localBlobEntry('local-history', 'completed');
  const incoming = createPersistedSyncState({
    currentEntry: null,
    active: null,
    queue: [entry('shared-queue'), localQueue],
    history: [entry('shared-history'), localHistory],
    autoPlayNext: true,
  });
  // Simulate a later write that omitted the tab-owned history item entirely.
  incoming.history = incoming.history.filter((item) => item.entryId !== localHistory.entryId);

  const merged = mergeCrossTabSyncState({
    currentEntry: null,
    active: null,
    queue: [localQueue],
    history: [localHistory],
    autoPlayNext: false,
  }, incoming);

  assert.equal(merged.autoPlayNext, true, 'shared preferences still converge');
  assert.equal(merged.queue.find((item) => item.entryId === 'local-queue').song.src, 'blob:local-queue');
  assert.equal(merged.history.find((item) => item.entryId === 'local-history').song.src, 'blob:local-history');
  assert.equal(merged.queue.some((item) => item.entryId === 'shared-queue'), true);
  assert.equal(merged.history.some((item) => item.entryId === 'shared-history'), true);
});
