import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachObsAssetToLocalSong,
  attachObsAssetToPlaybackState,
  collectLocalObsAssetCandidates,
  localSongNeedsObsAsset,
} from '../src/lib/localObsAsset.js';

const localSong = (src, extra = {}) => ({
  type: 'local',
  src,
  title: src,
  ...extra,
});
const entry = (entryId, song) => ({ entryId, song, phase: 'queued' });

test('only a playable page-owned local Blob needs an OBS asset', () => {
  assert.equal(localSongNeedsObsAsset(localSong('blob:file-1')), true);
  assert.equal(localSongNeedsObsAsset(localSong('blob:file-1', { assetId: 'asset-1' })), false);
  assert.equal(localSongNeedsObsAsset(localSong('')), false);
  assert.equal(localSongNeedsObsAsset({ type: 'youtube', src: 'cv7zqJhKoVE' }), false);
});

test('attaching an OBS asset preserves the Speaker Blob source', () => {
  const song = localSong('blob:file-1', { localBlobBytes: 123 });
  const attached = attachObsAssetToLocalSong(song, {
    src: 'blob:file-1',
    assetId: 'asset-1',
  });

  assert.deepEqual(attached, {
    ...song,
    assetId: 'asset-1',
  });
  assert.equal(attached.src, 'blob:file-1');
  assert.equal(attachObsAssetToLocalSong(song, { src: 'blob:other', assetId: 'asset-2' }), song);
});

test('one upload result updates every same-page reference without touching other songs', () => {
  const shared = localSong('blob:shared');
  const other = localSong('blob:other');
  const state = {
    currentEntry: entry('current', shared),
    queue: [entry('queued-shared', shared), entry('queued-other', other)],
    history: [entry('history-shared', shared)],
  };

  const updated = attachObsAssetToPlaybackState(state, {
    src: 'blob:shared',
    assetId: 'asset-shared',
  });

  assert.equal(updated.currentEntry.song.assetId, 'asset-shared');
  assert.equal(updated.queue[0].song.assetId, 'asset-shared');
  assert.equal(updated.history[0].song.assetId, 'asset-shared');
  assert.equal(updated.queue[1], state.queue[1]);
  assert.equal(state.currentEntry.song.assetId, undefined, 'the input state is immutable');
});

test('OBS candidate collection is ordered, unique, and excludes completed history', () => {
  const state = {
    currentEntry: entry('current', localSong('blob:current')),
    queue: [
      entry('current-copy', localSong('blob:current')),
      entry('ready', localSong('blob:ready', { assetId: 'asset-ready' })),
      entry('next', localSong('blob:next')),
    ],
    history: [entry('old', localSong('blob:history'))],
  };

  assert.deepEqual(
    collectLocalObsAssetCandidates(state).map((song) => song.src),
    ['blob:current', 'blob:next'],
  );
});
