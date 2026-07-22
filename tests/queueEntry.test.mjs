import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isExpiredLocalSongDef,
  isPlayableSongDef,
  sanitizeSongDef,
  toQueueEntry,
} from '../src/lib/queueEntry.js';

test('expired local definitions retain bounded metadata without remaining playable', () => {
  const song = sanitizeSongDef({
    type: 'local',
    src: 'blob:dead-page-url',
    title: 'Local backing track',
    artist: 'Singer',
    localBlobBytes: 1234,
    localSourceExpired: true,
  });

  assert.equal(song.src, '');
  assert.equal(song.localSourceExpired, true);
  assert.equal(song.localBlobBytes, 1234);
  assert.equal(isExpiredLocalSongDef(song), true);
  assert.equal(isPlayableSongDef(song), false);
});

test('expired local placeholders survive only queued and completed projections', () => {
  const base = {
    entryId: 'local-placeholder',
    song: {
      type: 'local',
      src: '',
      title: 'Needs file',
      localSourceExpired: true,
    },
    completionReason: null,
    createdAt: 100,
  };

  assert.equal(toQueueEntry({ ...base, phase: 'queued' })?.entryId, 'local-placeholder');
  assert.equal(toQueueEntry({ ...base, phase: 'completed' })?.entryId, 'local-placeholder');
  assert.equal(toQueueEntry({ ...base, phase: 'starting' }), null);
});

test('malformed local byte metadata is discarded instead of inflating persisted state', () => {
  assert.equal(sanitizeSongDef({
    type: 'local',
    src: 'blob:one',
    title: 'One',
    localBlobBytes: -1,
  }).localBlobBytes, undefined);
  assert.equal(sanitizeSongDef({
    type: 'local',
    src: 'blob:two',
    title: 'Two',
    localBlobBytes: Number.MAX_VALUE,
  }).localBlobBytes, undefined);
  assert.equal(sanitizeSongDef({
    type: 'local',
    src: 'blob:three',
    title: 'Three',
    localBlobBytes: '1024',
  }).localBlobBytes, undefined);
});
