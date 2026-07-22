import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SONG_DROP_ACTIONS,
  SONG_DROP_DESTINATIONS,
  normalizeSongDragCandidate,
  planSongDropAction,
  stagedItemFromSongDragCandidate,
} from '../src/lib/songDragAction.js';

test('song drag candidates keep only a playable YouTube source and songbook identity', () => {
  const candidate = normalizeSongDragCandidate({
    id: 'abcdefghijk',
    title: '  Fixture track  ',
    channelTitle: ' Singer ',
    tags: ['karaoke', null, 'live'],
    source: 'setlink',
    songbookId: 'book-7',
    skipAiTitleExtraction: true,
    mrVerified: true,
    ignored: 'never copied',
  });

  assert.deepEqual(candidate, {
    id: 'abcdefghijk',
    title: 'Fixture track',
    channelTitle: 'Singer',
    tags: ['karaoke', 'live'],
    source: 'setlink',
    songbookId: 'book-7',
    skipAiTitleExtraction: true,
    mrVerified: true,
  });
  assert.equal(normalizeSongDragCandidate({ id: 'too-short', title: 'No' }), null);
  assert.equal(normalizeSongDragCandidate({ id: 'abcdefghijk', title: '   ' }), null);
});

test('a drag candidate becomes the same reviewable staged song shape used by clicks', () => {
  const staged = stagedItemFromSongDragCandidate({
    id: 'abcdefghijk',
    title: 'Fixture track',
    channelTitle: 'Singer',
    source: 'youtube',
  }, 'stage-1');

  assert.equal(staged.stagingId, 'stage-1');
  assert.equal(staged.type, 'youtube');
  assert.equal(staged.src, 'abcdefghijk');
  assert.equal(staged.title, 'Fixture track');
  assert.equal(staged.artist, 'Singer');
});

test('drop planning never cuts a current song and keeps explicit destinations distinct', () => {
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.PLAY,
    hasCurrentSong: false,
    prepareKind: 'ready',
  }), SONG_DROP_ACTIONS.PLAY_NOW);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.PLAY,
    hasCurrentSong: true,
    prepareKind: 'ready',
  }), SONG_DROP_ACTIONS.QUEUE_FRONT);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.PLAY,
    hasCurrentSong: false,
    prepareKind: 'preparing',
  }), SONG_DROP_ACTIONS.QUEUE_FRONT);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.QUEUE,
    hasCurrentSong: false,
    prepareKind: 'ready',
  }), SONG_DROP_ACTIONS.QUEUE_END);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.HISTORY,
    hasCurrentSong: true,
    prepareKind: 'blocked',
  }), SONG_DROP_ACTIONS.HISTORY);
  assert.equal(planSongDropAction({ destination: 'unknown' }), null);
});
