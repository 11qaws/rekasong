import test from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePlaybackOutputNextAction,
  derivePlaybackOutputStatus,
} from '../src/lib/playbackOutputStatus.js';

test('output status always maps to a concrete next action', () => {
  assert.equal(
    derivePlaybackOutputNextAction({ statusKey: 'onair.output.header.active.speaker' }),
    'onair.output.nextAction.speaker.active',
  );
  assert.equal(
    derivePlaybackOutputNextAction({
      statusKey: 'onair.output.header.blocked.obs.none',
      targetMode: 'obs',
    }),
    'onair.output.nextAction.obs.candidate',
  );
  assert.equal(
    derivePlaybackOutputNextAction({
      statusKey: 'onair.output.header.active.attention',
      targetMode: 'obs',
    }),
    'onair.output.nextAction.obs.recover',
  );
  assert.equal(
    derivePlaybackOutputNextAction({
      statusKey: 'onair.output.header.active.attention',
      targetMode: 'speaker',
      controlRecoveryRequired: true,
    }),
    'onair.output.nextAction.control',
  );
});

test('stable routes identify the selected output path even while no song is playing', () => {
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
    'onair.output.header.active.speaker',
  );
});

test('Speaker ignores server startup, candidate, ownership, and route failures', () => {
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'connecting',
      targetMode: 'speaker',
    }),
    { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'connecting',
      targetMode: 'obs',
    }),
    { key: 'onair.output.header.connecting.obs', tone: 'pending', mode: null },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'switching',
      targetMode: 'speaker',
      targetCandidateState: 'none',
    }),
    { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'blocked',
      targetMode: 'obs',
      targetCandidateState: 'none',
    }),
    { key: 'onair.output.header.blocked.obs.none', tone: 'attention', mode: null },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'blocked',
      targetMode: 'obs',
      targetCandidateState: 'duplicate',
    }),
    { key: 'onair.output.header.blocked.obs.duplicate', tone: 'attention', mode: null },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      outputSwitchState: 'blocked',
      targetMode: 'speaker',
      targetCandidateState: 'single',
      reasonCode: 'output_control_target_identity_mismatch',
    }),
    { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' },
  );
  assert.deepEqual(
    derivePlaybackOutputStatus({
      confirmedOutputMode: 'speaker',
      outputSwitchState: 'conflict',
      isSessionInvalid: true,
      isRouteStable: false,
    }),
    { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' },
  );
});

test('transition and terminal states take precedence over cached actual routes', () => {
  const cases = [
    [{ isSessionInvalid: true }, 'onair.output.header.active.attention', 'attention'],
    [{ outputSwitchState: 'connecting' }, 'onair.output.header.active.connecting', 'pending'],
    [{ outputSwitchState: 'conflict' }, 'onair.output.header.control.otherTab', 'notice'],
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
