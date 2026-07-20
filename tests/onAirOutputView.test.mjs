import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_OUTPUT_ACTIONS,
  ON_AIR_OUTPUT_CANDIDATE_STATES,
  ON_AIR_OUTPUT_GATE_CODES,
  ON_AIR_OUTPUT_LEASE_STATES,
  ON_AIR_OUTPUT_VERIFICATION_SCOPES,
  ON_AIR_OUTPUT_VERIFICATION_STATUSES,
  deriveOnAirOutputView,
} from '../src/lib/onAirOutputView.js';
import { validateOnAirMessage } from '../src/lib/onAirProtocol.js';

const SEMANTIC_KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

function makeSnapshot({
  mode = 'obs',
  speakerCandidates = ['player-speaker'],
  obsCandidates = ['player-obs'],
  leaseStatus = 'ready',
  leaseTarget,
  leaseClientKind,
  desiredTransport = { status: 'paused' },
  confirmedPlayback = { status: 'ready' },
  activeFamily = null,
  activeCheckId = null,
  extra = {},
} = {}) {
  const inactive = leaseStatus === 'inactive' || leaseStatus === 'emergency_stopping'
    || leaseStatus === 'emergency';
  const defaultClientKind = mode === 'speaker' ? 'dashboard-speaker' : 'obs-browser-source';
  const defaultTarget = mode === 'speaker' ? 'player-speaker' : 'player-obs';
  return {
    type: 'player_snapshot',
    protocolVersion: 2,
    selectedOutputMode: mode,
    players: [],
    eligibleCandidates: {
      speaker: speakerCandidates,
      obs: obsCandidates,
    },
    lease: {
      epoch: 7,
      leaseTarget: leaseTarget === undefined ? (inactive ? null : defaultTarget) : leaseTarget,
      clientKind: leaseClientKind === undefined ? (inactive ? null : defaultClientKind) : leaseClientKind,
      status: leaseStatus,
      switchId: inactive ? null : 'switch-7',
    },
    activeFamily,
    activeCheckId,
    controlLease: {
      controlEpoch: 3,
      writableControlInstanceId: 'control-1',
      writableConnected: true,
    },
    desiredTransport,
    confirmedPlayback,
    ...extra,
  };
}

function strongStopped(overrides = {}) {
  return {
    status: 'stopped',
    paused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
    ...overrides,
  };
}

function adapterSnapshot(overrides = {}) {
  return {
    routeState: 'ready_event_sent',
    confirmation: 'local_event_sent',
    safetyLocked: false,
    autoResumeAllowed: false,
    activeEntryId: null,
    activeRunId: null,
    disposed: false,
    ...overrides,
  };
}

function derive(snapshot, overrides = {}) {
  return deriveOnAirOutputView({
    protocolSnapshot: snapshot,
    ...overrides,
  });
}

test('fixture follows the shared required player_snapshot contract', () => {
  const validation = validateOnAirMessage(makeSnapshot());
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test('OBS audible is only player-playing truth and never promotes final-path verification', () => {
  const snapshot = makeSnapshot({
    leaseStatus: 'audible',
    desiredTransport: { status: 'playing' },
    confirmedPlayback: { status: 'playing', position: 12.5 },
    extra: {
      players: [{
        playerInstanceId: 'player-obs',
        runtime: { sourceActive: true, recording: true, streaming: true },
      }],
    },
  });

  const view = derive(snapshot, { adapterSnapshot: adapterSnapshot() });

  assert.equal(view.statusCode, 'player_playing_confirmed');
  assert.equal(view.messageKey, 'onair.output.status.obs.playerPlaying');
  assert.equal(view.lease.status, ON_AIR_OUTPUT_LEASE_STATES.AUDIBLE);
  assert.equal(view.lease.proofScope, 'player_route');
  assert.equal(view.lease.routeEventConfirmed, true);
  assert.equal(view.lease.playerPlayingConfirmed, true);
  assert.equal(view.mode.confirmed, 'obs');
  assert.equal(view.verification.status, ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN);
  assert.equal(view.verification.messageKey, 'onair.output.verification.unknown');
  assert.equal(Object.hasOwn(view, 'obsVerified'), false);
  assert.equal(Object.hasOwn(view, 'finalOutputVerified'), false);
});

test('speaker and OBS candidates are counted per selected mode, not as duplicates together', () => {
  const speaker = derive(makeSnapshot({
    mode: 'speaker',
    leaseClientKind: 'dashboard-speaker',
    leaseTarget: 'player-speaker',
  }));

  assert.equal(speaker.candidate.state, ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE);
  assert.equal(speaker.candidate.count, 1);
  assert.equal(speaker.mode.desired, 'speaker');
  assert.equal(speaker.mode.confirmed, 'speaker');
  assert.equal(speaker.statusCode, 'route_ready');
  assert.equal(speaker.messageKey, 'onair.output.status.speaker.routeReady');
  assert.equal(speaker.candidates.speaker.count, 1);
  assert.equal(speaker.candidates.obs.count, 1);
  assert.equal(speaker.switchTarget.mode, 'obs');
  assert.equal(speaker.switchTarget.candidate.playerInstanceId, 'player-obs');
});

test('output switching validates the destination candidate rather than the current player', () => {
  const base = {
    mode: 'speaker',
    leaseClientKind: 'dashboard-speaker',
    leaseTarget: 'player-speaker',
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
  };
  const readyDestination = derive(makeSnapshot(base));
  const missingDestination = derive(makeSnapshot({ ...base, obsCandidates: [] }));
  const duplicateDestination = derive(makeSnapshot({
    ...base,
    obsCandidates: ['player-obs-a', 'player-obs-b'],
  }));

  assert.equal(readyDestination.candidate.state, ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE);
  assert.equal(readyDestination.actions.switchOutput.allowed, true);
  assert.equal(readyDestination.targets.obs.operation, ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT);
  assert.equal(readyDestination.targets.obs.action.allowed, true);
  assert.equal(readyDestination.targets.speaker.operation, null);
  assert.equal(readyDestination.targets.speaker.action.allowed, false);
  assert.equal(missingDestination.candidate.state, ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE);
  assert.equal(missingDestination.actions.switchOutput.allowed, false);
  assert.equal(missingDestination.targets.obs.action.allowed, false);
  assert.equal(
    missingDestination.actions.switchOutput.reasonCode,
    ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE,
  );
  assert.equal(duplicateDestination.actions.switchOutput.allowed, false);
  assert.equal(
    duplicateDestination.actions.switchOutput.reasonCode,
    ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE,
  );

  const unstableCurrentRoute = derive(makeSnapshot({
    ...base,
    speakerCandidates: ['player-speaker', 'player-speaker-duplicate'],
  }));
  assert.equal(unstableCurrentRoute.targets.obs.candidate.state, 'single');
  assert.equal(unstableCurrentRoute.targets.obs.action.allowed, true);
});

test('zero and multiple eligible candidates are explicit and block activation or switching', () => {
  const missing = derive(makeSnapshot({ obsCandidates: [] }));
  const duplicate = derive(makeSnapshot({ obsCandidates: ['player-obs-a', 'player-obs-b'] }));

  assert.equal(missing.statusCode, 'candidate_missing');
  assert.deepEqual(
    { state: missing.candidate.state, count: missing.candidate.count },
    { state: ON_AIR_OUTPUT_CANDIDATE_STATES.NONE, count: 0 },
  );
  assert.equal(missing.actions.activate.allowed, false);
  assert.equal(missing.actions.switchOutput.allowed, false);
  assert.equal(missing.actions.retry.allowed, true);

  assert.equal(duplicate.statusCode, 'candidate_duplicate');

  const speakerDuplicate = derive(makeSnapshot({
    mode: 'speaker',
    speakerCandidates: ['player-speaker', 'player-speaker-copy'],
    leaseClientKind: 'dashboard-speaker',
    leaseTarget: 'player-speaker',
  }));
  assert.equal(speakerDuplicate.statusCode, 'route_ready');
  assert.equal(speakerDuplicate.actions.activate.allowed, false);
  assert.deepEqual(
    { state: duplicate.candidate.state, count: duplicate.candidate.count },
    { state: ON_AIR_OUTPUT_CANDIDATE_STATES.DUPLICATE, count: 2 },
  );
  assert.equal(duplicate.actions.activate.allowed, false);
  assert.equal(duplicate.actions.switchOutput.allowed, false);
});

test('all lease phases derive stable locale-neutral states without inventing route proof', () => {
  const cases = [
    ['activating', { status: 'unknown', reasonCode: 'output_activating' }, 'output_activating'],
    ['ready', { status: 'ready' }, 'route_ready'],
    ['audible', { status: 'playing' }, 'player_playing_confirmed'],
    ['unknown', { status: 'unknown', reasonCode: 'target_disconnected' }, 'state_unknown'],
    ['deactivating', { status: 'unknown', reasonCode: 'output_deactivating' }, 'output_deactivating'],
    ['inactive', { status: 'unknown', reasonCode: 'output_inactive' }, 'output_inactive'],
    ['emergency_stopping', { status: 'unknown', reasonCode: 'emergency_stop_unconfirmed' }, 'emergency_stopping'],
    ['failed', { status: 'unknown', reasonCode: 'output_activation_failed' }, 'activation_failed'],
  ];

  for (const [leaseStatus, confirmedPlayback, expectedStatusCode] of cases) {
    const view = derive(makeSnapshot({ leaseStatus, confirmedPlayback }));
    assert.equal(view.statusCode, expectedStatusCode, leaseStatus);
    assert.match(view.messageKey, SEMANTIC_KEY, leaseStatus);
  }
});

test('desired and confirmed playback remain separate and dangerous divergence is visible', () => {
  const view = derive(makeSnapshot({
    leaseStatus: 'audible',
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: { status: 'playing' },
    activeFamily: { entryId: 'entry-1', runId: 'run-1' },
  }));

  assert.equal(view.playback.desiredStatus, 'stopped');
  assert.equal(view.playback.confirmedStatus, 'playing');
  assert.equal(view.playback.relationship, 'conflict');
  assert.equal(view.playback.messageKey, 'onair.output.playback.conflict');
  assert.equal(view.actions.switchOutput.allowed, false);
  assert.equal(view.actions.switchOutput.reasonCode, ON_AIR_OUTPUT_GATE_CODES.ACTIVE_PLAYBACK);
});

test('output switch is enabled only with exact strong-stop proof and authoritative no-run state', () => {
  const safe = derive(makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
  }));
  assert.equal(safe.playback.strongStopProven, true);
  assert.equal(safe.playback.activeFamily.known, true);
  assert.equal(safe.playback.activeFamily.present, false);
  assert.equal(safe.actions.switchOutput.allowed, true);
  assert.equal(safe.actions.startTest.allowed, true);

  const weakStop = derive(makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped({ autoplayCancelled: false }),
  }));
  assert.equal(weakStop.playback.strongStopProven, false);
  assert.equal(weakStop.actions.switchOutput.allowed, false);
  assert.equal(weakStop.actions.switchOutput.reasonCode, ON_AIR_OUTPUT_GATE_CODES.STOP_NOT_PROVEN);

  const missingFamilySnapshot = makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
  });
  delete missingFamilySnapshot.activeFamily;
  const familyUnknown = deriveOnAirOutputView({ protocolSnapshot: missingFamilySnapshot });
  assert.equal(familyUnknown.playback.activeFamily.known, false);
  assert.equal(familyUnknown.inputValid, false);
  assert.equal(familyUnknown.actions.switchOutput.allowed, false);
});

test('a known active family or local adapter run always blocks an output switch', () => {
  const snapshot = makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
  });
  const authoritativeRun = derive(makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
    activeFamily: { entryId: 'entry-1', runId: 'run-1' },
  }));
  const localRun = derive(snapshot, {
    adapterSnapshot: adapterSnapshot({
      activeEntryId: 'entry-2',
      activeRunId: 'run-2',
    }),
  });

  assert.equal(authoritativeRun.actions.switchOutput.allowed, false);
  assert.equal(localRun.actions.switchOutput.allowed, false);
});

test('snapshot activeFamily is authoritative and a root override cannot hide an active run', () => {
  const view = deriveOnAirOutputView({
    protocolSnapshot: makeSnapshot({
      desiredTransport: { status: 'stopped' },
      confirmedPlayback: strongStopped(),
      activeFamily: { entryId: 'entry-authoritative', runId: 'run-authoritative' },
    }),
    activeFamily: null,
  });

  assert.equal(view.playback.activeFamily.present, true);
  assert.equal(view.playback.activeFamily.entryId, 'entry-authoritative');
  assert.equal(view.actions.switchOutput.allowed, false);
});

test('active output test blocks switching and new tests while preserving explicit stop-test recovery', () => {
  const view = derive(makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
    activeCheckId: 'check-1',
  }));

  assert.equal(view.test.known, true);
  assert.equal(view.test.active, true);
  assert.equal(view.test.checkId, 'check-1');
  assert.equal(view.actions.switchOutput.allowed, false);
  assert.equal(view.actions.startTest.allowed, false);
  assert.equal(view.actions.startTest.reasonCode, ON_AIR_OUTPUT_GATE_CODES.TEST_ACTIVE);
  assert.equal(view.actions.stopTest.allowed, true);
  assert.ok(view.availableActions.includes(ON_AIR_OUTPUT_ACTIONS.STOP_TEST));
});

test('cold idle can explicitly activate once but cannot masquerade as a proven stopped switch', () => {
  const view = derive(makeSnapshot({
    leaseStatus: 'inactive',
    desiredTransport: { status: 'idle' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'not_confirmed' },
  }), {
    adapterSnapshot: adapterSnapshot({
      routeState: 'standby',
      confirmation: 'unknown',
      safetyLocked: true,
    }),
  });

  assert.equal(view.statusCode, 'output_inactive');
  assert.equal(view.actions.activate.allowed, true);
  assert.equal(view.actions.switchOutput.allowed, false);
  assert.equal(view.playback.strongStopProven, false);
});

test('an unselected cold session exposes target-specific activation gates', () => {
  const view = derive(makeSnapshot({
    mode: null,
    leaseStatus: 'inactive',
    desiredTransport: { status: 'idle' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'not_confirmed' },
  }), {
    adapterSnapshot: adapterSnapshot({
      routeState: 'standby',
      confirmation: 'unknown',
      safetyLocked: true,
    }),
  });

  assert.equal(view.actions.activate.allowed, false, 'a generic activation cannot choose a mode');
  assert.equal(view.targets.speaker.operation, ON_AIR_OUTPUT_ACTIONS.ACTIVATE);
  assert.equal(view.targets.obs.operation, ON_AIR_OUTPUT_ACTIONS.ACTIVATE);
  assert.equal(view.targets.speaker.action.allowed, true);
  assert.equal(view.targets.obs.action.allowed, true);
  assert.equal(view.targets.speaker.candidate.playerInstanceId, 'player-speaker');
  assert.equal(view.targets.obs.candidate.playerInstanceId, 'player-obs');
});

test('unknown state exposes only bounded recovery actions and forbids resume/fallback automation', () => {
  const view = derive(makeSnapshot({
    leaseStatus: 'unknown',
    confirmedPlayback: { status: 'unknown', reasonCode: 'target_heartbeat_stale' },
  }));

  assert.equal(view.statusCode, 'state_unknown');
  assert.deepEqual(view.availableActions, [
    ON_AIR_OUTPUT_ACTIONS.DEACTIVATE,
    ON_AIR_OUTPUT_ACTIONS.RETRY,
    ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP,
  ]);
  assert.equal(view.actions.resume.allowed, false);
  assert.equal(view.actions.autoResume.allowed, false);
  assert.equal(view.actions.autoFallback.allowed, false);
  assert.equal(view.actions.autoResume.reasonCode, ON_AIR_OUTPUT_GATE_CODES.POLICY_MANUAL_ONLY);
  assert.equal(view.actions.autoFallback.reasonCode, ON_AIR_OUTPUT_GATE_CODES.POLICY_MANUAL_ONLY);
});

test('adapter unknown dominates local confidence but local event delivery never becomes OBS verification', () => {
  const healthy = derive(makeSnapshot(), { adapterSnapshot: adapterSnapshot() });
  assert.equal(healthy.adapter.confirmation, 'local_event_sent');
  assert.equal(healthy.statusCode, 'route_ready');
  assert.equal(healthy.verification.status, 'unknown');

  const unknown = derive(makeSnapshot(), {
    adapterSnapshot: adapterSnapshot({
      routeState: 'unknown',
      confirmation: 'unknown',
      safetyLocked: true,
    }),
  });
  assert.equal(unknown.statusCode, 'state_unknown');
  assert.deepEqual(unknown.availableActions, [
    ON_AIR_OUTPUT_ACTIONS.DEACTIVATE,
    ON_AIR_OUTPUT_ACTIONS.RETRY,
    ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP,
  ]);
});

test('selected and leased output modes cannot silently disagree', () => {
  const view = derive(makeSnapshot({
    mode: 'obs',
    leaseTarget: 'player-speaker',
    leaseClientKind: 'dashboard-speaker',
  }));

  assert.equal(view.mode.desired, 'obs');
  assert.equal(view.mode.lease, 'speaker');
  assert.equal(view.mode.confirmed, 'speaker');
  assert.equal(view.mode.relationship, 'mismatch');
  assert.equal(view.statusCode, 'state_unknown');
  assert.equal(view.actions.switchOutput.allowed, false);
});

test('active lease target must match the sole eligible candidate and retain a selected mode', () => {
  const targetMismatch = derive(makeSnapshot({
    obsCandidates: ['player-obs-new'],
    leaseTarget: 'player-obs-old',
  }));
  const modeMissing = derive(makeSnapshot({
    mode: null,
    leaseTarget: 'player-obs',
    leaseClientKind: 'obs-browser-source',
  }));

  assert.equal(targetMismatch.statusCode, 'state_unknown');
  assert.deepEqual(targetMismatch.availableActions, [
    ON_AIR_OUTPUT_ACTIONS.DEACTIVATE,
    ON_AIR_OUTPUT_ACTIONS.RETRY,
    ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP,
  ]);
  assert.equal(modeMissing.statusCode, 'state_unknown');
  assert.equal(modeMissing.mode.relationship, 'mismatch');
});

test('adapter route, confirmation, and safety-lock claims must form one valid local contract', () => {
  const view = derive(makeSnapshot(), {
    adapterSnapshot: adapterSnapshot({
      confirmation: 'local_only',
      safetyLocked: false,
    }),
  });

  assert.equal(view.inputValid, false);
  assert.equal(view.statusCode, 'invalid_input');
  assert.equal(view.adapter.valid, false);
  assert.equal(view.adapter.proofScope, 'browser_local');
  assert.ok(view.diagnostics.includes('invalid_adapter_snapshot'));
});

test('verification accepts only explicit scoped evidence and becomes stale across mode changes', () => {
  const snapshot = makeSnapshot({
    leaseStatus: 'audible',
    desiredTransport: { status: 'playing' },
    confirmedPlayback: { status: 'playing' },
  });
  const passed = derive(snapshot, {
    verification: {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.PASSED,
      scope: ON_AIR_OUTPUT_VERIFICATION_SCOPES.OBS_MIXER,
      outputMode: 'obs',
      checkedAt: 1_000,
    },
  });
  const stale = derive(snapshot, {
    verification: {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.PASSED,
      scope: ON_AIR_OUTPUT_VERIFICATION_SCOPES.SPEAKER_PLAYBACK,
      outputMode: 'speaker',
      checkedAt: 1_000,
    },
  });
  const malformed = derive(snapshot, { verification: { status: 'passed' } });
  const scopeMismatch = derive(snapshot, {
    verification: {
      status: 'passed',
      scope: 'speaker_playback',
      outputMode: 'obs',
      checkedAt: 1_000,
    },
  });

  assert.equal(passed.verification.status, 'passed');
  assert.equal(passed.verification.scope, 'obs_mixer');
  assert.equal(passed.verification.messageKey, 'onair.output.verification.obsMixer.passed');
  assert.equal(passed.statusCode, 'player_playing_confirmed');
  assert.equal(stale.verification.status, 'stale');
  assert.equal(stale.verification.messageKey, 'onair.output.verification.speakerPlayback.stale');
  assert.deepEqual(stale.verification.reasonCodes, ['output_mode_changed']);
  assert.equal(malformed.verification.status, 'unknown');
  assert.equal(malformed.inputValid, true, 'verification validity must not rewrite route truth');
  assert.ok(malformed.diagnostics.includes('invalid_verification'));
  assert.equal(scopeMismatch.verification.status, 'unknown');
  assert.ok(scopeMismatch.diagnostics.includes('invalid_verification'));
});

test('verification records remain independent by scope instead of overwriting earlier evidence', () => {
  const view = deriveOnAirOutputView({
    protocolSnapshot: makeSnapshot({
      leaseStatus: 'audible',
      desiredTransport: { status: 'playing' },
      confirmedPlayback: { status: 'playing' },
    }),
    verificationByScope: {
      obs_mixer: {
        status: 'passed',
        scope: 'obs_mixer',
        outputMode: 'obs',
        checkedAt: 100,
      },
      obs_recording: {
        status: 'stale',
        scope: 'obs_recording',
        outputMode: 'obs',
        checkedAt: 90,
        reasonCodes: ['track_changed'],
      },
    },
  });

  assert.equal(view.verificationByScope.obs_mixer.status, 'passed');
  assert.equal(view.verificationByScope.obs_recording.status, 'stale');
  assert.deepEqual(
    view.verificationByScope.obs_recording.reasonCodes,
    ['track_changed'],
  );
  assert.equal(view.verificationByScope.obs_stream_artifact.status, 'unknown');
  assert.equal(view.verificationByScope.karaoke_sync.status, 'unknown');
  assert.equal(view.verification.status, 'unknown', 'legacy summary must not invent a highest proof');
});

test('a malformed scoped verification degrades only the verification layer', () => {
  const view = deriveOnAirOutputView({
    protocolSnapshot: makeSnapshot(),
    verificationByScope: {
      obs_mixer: {
        status: 'passed',
        scope: 'obs_recording',
        outputMode: 'obs',
        checkedAt: 100,
      },
    },
  });

  assert.equal(view.inputValid, true);
  assert.equal(view.statusCode, 'route_ready');
  assert.equal(view.verificationByScope.obs_mixer.status, 'unknown');
  assert.ok(view.diagnostics.includes('invalid_verification_obs_mixer'));
});

test('malformed critical inputs fail closed without throwing', () => {
  const valid = makeSnapshot();
  const missingActiveFamily = { ...valid };
  const missingActiveCheckId = { ...valid };
  delete missingActiveFamily.activeFamily;
  delete missingActiveCheckId.activeCheckId;
  const cases = [
    null,
    {},
    { protocolSnapshot: null },
    { protocolSnapshot: { ...valid, protocolVersion: 1 } },
    { protocolSnapshot: { ...valid, selectedOutputMode: 'both' } },
    { protocolSnapshot: missingActiveFamily },
    { protocolSnapshot: missingActiveCheckId },
    {
      protocolSnapshot: {
        ...valid,
        eligibleCandidates: { speaker: [], obs: 'player-obs' },
      },
    },
    {
      protocolSnapshot: {
        ...valid,
        eligibleCandidates: { speaker: 'player-speaker', obs: ['player-obs'] },
      },
    },
    {
      protocolSnapshot: { ...valid, lease: { ...valid.lease, status: 'invented' } },
    },
    {
      protocolSnapshot: { ...valid, desiredTransport: { status: 'invented' } },
    },
    {
      protocolSnapshot: { ...valid, confirmedPlayback: { status: 'invented' } },
    },
    { protocolSnapshot: { ...valid, activeFamily: { entryId: 'entry-only' } } },
    { protocolSnapshot: { ...valid, activeCheckId: ' check-1' } },
    { protocolSnapshot: valid, adapterSnapshot: { routeState: 'ready' } },
  ];

  for (const input of cases) {
    let view;
    assert.doesNotThrow(() => {
      view = deriveOnAirOutputView(input);
    });
    assert.equal(view.inputValid, false);
    assert.equal(view.statusCode, 'invalid_input');
    assert.equal(view.actions.switchOutput.allowed, false);
    assert.equal(view.actions.activate.allowed, false);
    assert.equal(view.actions.resume.allowed, false);
    assert.equal(view.actions.autoResume.allowed, false);
    assert.equal(view.actions.autoFallback.allowed, false);
    assert.equal(view.actions.emergencyStop.allowed, true);
  }
});

test('derivation is deterministic, immutable, and does not mutate input', () => {
  const input = {
    protocolSnapshot: makeSnapshot({
      desiredTransport: { status: 'stopped' },
      confirmedPlayback: strongStopped(),
    }),
    adapterSnapshot: adapterSnapshot(),
    verification: {
      status: 'stale',
      scope: 'obs_recording',
      outputMode: 'obs',
      checkedAt: 99,
      reasonCodes: ['scene_changed'],
    },
  };
  const before = structuredClone(input);
  const first = deriveOnAirOutputView(input);
  const second = deriveOnAirOutputView(input);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.actions));
  assert.ok(Object.isFrozen(first.actions.switchOutput));
  assert.ok(Object.isFrozen(first.verification.reasonCodes));
  assert.throws(() => {
    first.statusCode = 'changed';
  }, TypeError);
  assert.throws(() => {
    first.availableActions.push('unsafe');
  }, TypeError);
});

test('all user-facing references are semantic keys rather than source prose', () => {
  const view = derive(makeSnapshot({
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: strongStopped(),
  }), {
    verification: {
      status: 'stale',
      scope: 'obs_stream_artifact',
      outputMode: 'obs',
      checkedAt: 12,
      reasonCodes: ['profile_changed'],
    },
  });
  const keys = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [field, child] of Object.entries(value)) {
      if (field.endsWith('Key')) keys.push(child);
      visit(child);
    }
  };
  visit(view);

  assert.ok(keys.length >= 15);
  for (const key of keys) assert.match(key, SEMANTIC_KEY, key);
  assert.equal(JSON.stringify(view).includes('OBS mixer verified'), false);
  assert.equal(JSON.stringify(view).includes('송출 확인'), false);
});
