import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createSpeakerMediaSessionController } from '../src/lib/speakerMediaSession.js';

function createHarness({ throwingActions = [] } = {}) {
  const handlers = new Map();
  const positions = [];
  const metadata = [];
  const playbackStates = [];
  const mediaSession = {
    setActionHandler(action, handler) {
      if (throwingActions.includes(action)) throw new Error('unsupported');
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    },
    setPositionState(value) { positions.push(value); },
    set metadata(value) { metadata.push(value); },
    get metadata() { return metadata.at(-1); },
    set playbackState(value) { playbackStates.push(value); },
    get playbackState() { return playbackStates.at(-1); },
  };
  class FakeMediaMetadata {
    constructor(value) { Object.assign(this, value); }
  }
  return {
    handlers,
    mediaSession,
    metadata,
    playbackStates,
    positions,
    controller: createSpeakerMediaSessionController({
      mediaSession,
      MediaMetadataClass: FakeMediaMetadata,
    }),
  };
}

test('Speaker activation installs metadata, actual state, position, and bounded OS controls', () => {
  const harness = createHarness();
  const calls = [];
  harness.controller.update({
    active: true,
    song: { id: 'song-1', title: 'Best Friend', artist: 'Hakos Baelz' },
    isPlaying: true,
    currentTime: 42,
    mediaDuration: 100,
    callbacks: {
      onPlay: () => calls.push(['play']),
      onPause: () => calls.push(['pause']),
      onNext: () => calls.push(['next']),
      onSeek: (value) => calls.push(['seek', value]),
    },
  });

  assert.equal(harness.mediaSession.metadata.title, 'Best Friend');
  assert.equal(harness.mediaSession.metadata.artist, 'Hakos Baelz');
  assert.equal(harness.mediaSession.metadata.album, 'Rekasong');
  assert.equal(harness.mediaSession.playbackState, 'playing');
  assert.deepEqual(harness.positions, [{ duration: 100, playbackRate: 1, position: 42 }]);

  harness.handlers.get('pause')();
  harness.handlers.get('nexttrack')();
  harness.handlers.get('seekbackward')({ seekOffset: 50 });
  harness.handlers.get('seekforward')({ seekOffset: 80 });
  harness.handlers.get('seekto')({ seekTime: 70 });
  assert.deepEqual(calls, [
    ['pause'],
    ['next'],
    ['seek', 0],
    ['seek', 100],
    ['seek', 70],
  ]);
});

test('OBS or idle deactivation clears every installed handler and cannot issue an action', () => {
  const harness = createHarness();
  let playCount = 0;
  harness.controller.update({
    active: true,
    song: { id: 'speaker-song', title: 'Speaker song' },
    callbacks: { onPlay: () => { playCount += 1; } },
  });
  const stalePlayHandler = harness.handlers.get('play');
  harness.controller.update({ active: false });

  assert.equal(harness.handlers.size, 0);
  assert.equal(harness.mediaSession.metadata, null);
  assert.equal(harness.mediaSession.playbackState, 'none');
  stalePlayHandler();
  assert.equal(playCount, 0);
});

test('invalid timing never reaches position state while valid position is clamped', () => {
  const harness = createHarness();
  harness.controller.update({
    active: true,
    song: { id: 'song', title: 'Song' },
    currentTime: Infinity,
    mediaDuration: NaN,
  });
  assert.deepEqual(harness.positions, []);

  harness.controller.update({
    active: true,
    song: { id: 'song', title: 'Song' },
    currentTime: 500,
    mediaDuration: 120,
  });
  assert.deepEqual(harness.positions, [{ duration: 120, playbackRate: 1, position: 120 }]);
});

test('unsupported action and metadata APIs are strictly non-blocking', () => {
  const harness = createHarness({ throwingActions: ['seekto', 'seekbackward'] });
  Object.defineProperty(harness.mediaSession, 'metadata', {
    configurable: true,
    set() { throw new Error('metadata denied'); },
  });
  assert.doesNotThrow(() => harness.controller.update({
    active: true,
    song: { id: 'song', title: 'Song' },
    isPlaying: false,
    mediaDuration: 30,
  }));
  assert.equal(harness.handlers.has('play'), true);
  assert.equal(harness.handlers.has('seekto'), false);
  assert.doesNotThrow(() => harness.controller.dispose());
  assert.doesNotThrow(() => harness.controller.dispose());
});

test('Dashboard enables OS controls from the active Speaker run, never the selected route', async () => {
  const dashboard = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  const updateStart = dashboard.indexOf('speakerMediaSessionController.update({');
  const updateEnd = dashboard.indexOf('useEffect(() => () => {', updateStart);
  const updateBlock = dashboard.slice(updateStart, updateEnd);

  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  assert.match(updateBlock, /activeRun\?\.outputMode === 'speaker'/);
  assert.doesNotMatch(updateBlock, /outputModePreference|selectedOutputMode|sendOnAirCommand/);
  assert.match(updateBlock, /phase === 'failed'[^]*?handleRetryCurrent\(\)/);
  assert.match(updateBlock, /onNext: \(\) => handleSkipRef\.current\?\.\(\)/);
  assert.match(dashboard, /speakerMediaSessionController\.dispose\(\)/);
});
