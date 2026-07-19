import test from 'node:test';
import assert from 'node:assert/strict';

import { derivePlaybackOutputStatus } from '../src/lib/playbackOutputStatus.js';

test('stable routes use active labels only while playback is actually running', () => {
  assert.deepEqual(
    derivePlaybackOutputStatus({
      confirmedOutputMode: 'speaker',
      isRouteStable: true,
      isPlaying: true,
    }),
    { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      confirmedOutputMode: 'obs',
      isRouteStable: true,
      isPlaying: true,
    }),
    { key: 'onair.output.header.active.obs', tone: 'obs', mode: 'obs' },
  );
  assert.equal(
    derivePlaybackOutputStatus({
      confirmedOutputMode: 'speaker',
      isRouteStable: true,
      isPlaying: false,
    }).key,
    'onair.output.header.standby.speaker',
  );
});

test('transition and terminal states take precedence over cached actual routes', () => {
  const cases = [
    [{ isSessionInvalid: true }, 'onair.output.header.active.attention', 'attention'],
    [{ outputSwitchState: 'connecting' }, 'onair.output.header.active.connecting', 'pending'],
    [{ outputSwitchState: 'switching' }, 'onair.output.header.active.switching', 'pending'],
    [{ outputSwitchState: 'blocked' }, 'onair.output.header.active.attention', 'attention'],
  ];

  for (const [state, key, tone] of cases) {
    assert.deepEqual(
      derivePlaybackOutputStatus({
        confirmedOutputMode: 'obs',
        isRouteStable: true,
        isPlaying: true,
        ...state,
      }),
      { key, tone, mode: null },
    );
  }
});

test('an unverified cached route never claims to be active', () => {
  assert.deepEqual(
    derivePlaybackOutputStatus({
      confirmedOutputMode: 'obs',
      isRouteStable: false,
      isPlaying: true,
    }),
    { key: 'onair.output.header.active.attention', tone: 'attention', mode: null },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus(),
    { key: 'onair.output.header.active.inactive', tone: 'pending', mode: null },
  );
});
