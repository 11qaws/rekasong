import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFERRED_SONG_DROP_PLAY_STATES,
  SONG_DROP_ACTIONS,
  SONG_DROP_DESTINATIONS,
  normalizeSongDragCandidate,
  planSongDropAction,
  resolveDeferredSongDropPlay,
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
  }), SONG_DROP_ACTIONS.PLAY_WHEN_READY);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.PLAY,
    hasCurrentSong: false,
    prepareKind: 'ready',
    outputMode: 'obs',
    outputReady: false,
  }), SONG_DROP_ACTIONS.QUEUE_FRONT);
  assert.equal(planSongDropAction({
    destination: SONG_DROP_DESTINATIONS.PLAY,
    hasCurrentSong: false,
    prepareKind: 'preparing',
    outputMode: 'obs',
    outputReady: true,
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

test('deferred Speaker play starts only for the exact first queued entry when it becomes ready', () => {
  const entry = {
    entryId: 'entry-1',
    song: { type: 'youtube', src: 'abcdefghijk', title: 'Fixture track' },
  };
  const intent = {
    entryId: entry.entryId,
    sourceId: entry.song.src,
    outputMode: 'speaker',
  };

  assert.deepEqual(resolveDeferredSongDropPlay({
    intent,
    currentEntry: null,
    queue: [entry],
    prepareKind: 'preparing',
    outputMode: 'speaker',
  }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.WAITING,
    reason: 'source_preparing',
    entry,
  });
  assert.deepEqual(resolveDeferredSongDropPlay({
    intent,
    currentEntry: null,
    queue: [entry],
    prepareKind: 'ready',
    outputMode: 'speaker',
  }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.READY,
    reason: 'source_ready',
    entry,
  });
});

test('deferred Speaker play is cancelled by every user-visible authority change', () => {
  const entry = {
    entryId: 'entry-1',
    song: { type: 'youtube', src: 'abcdefghijk', title: 'Fixture track' },
  };
  const other = {
    entryId: 'entry-2',
    song: { type: 'youtube', src: 'lmnopqrstuv', title: 'Other track' },
  };
  const intent = {
    entryId: entry.entryId,
    sourceId: entry.song.src,
    outputMode: 'speaker',
  };
  const resolve = (overrides = {}) => resolveDeferredSongDropPlay({
    intent,
    currentEntry: null,
    queue: [entry],
    prepareKind: 'preparing',
    outputMode: 'speaker',
    ...overrides,
  });

  assert.deepEqual(resolve({ outputMode: 'obs' }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED,
    reason: 'output_changed',
  });
  assert.deepEqual(resolve({ currentEntry: other }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED,
    reason: 'current_started',
  });
  assert.deepEqual(resolve({ queue: [other, entry] }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED,
    reason: 'queue_changed',
  });
  assert.deepEqual(resolve({ queue: [] }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED,
    reason: 'queue_changed',
  });
  assert.deepEqual(resolve({ prepareKind: 'unavailable' }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED,
    reason: 'source_unavailable',
  });
  assert.deepEqual(resolve({
    intent: { ...intent, outputMode: 'obs' },
    prepareKind: 'ready',
  }), {
    state: DEFERRED_SONG_DROP_PLAY_STATES.NONE,
    reason: 'missing_intent',
  });
});
