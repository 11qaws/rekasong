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
