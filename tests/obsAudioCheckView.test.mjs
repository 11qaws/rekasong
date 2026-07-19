import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OBS_AUDIO_CHECK_CANCELLED_CODE,
  OBS_AUDIO_CHECK_DURATION_MS,
  OBS_AUDIO_CHECK_STAGES,
  deriveObsAudioCheckView,
} from '../src/lib/obsAudioCheckView.js';
import { ON_AIR_PLAYBACK_ADAPTER_CODES } from '../src/lib/onAirPlaybackAdapter.js';
import { ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS } from '../src/lib/onAirTestFixture.js';

const CURRENT_ROUTE = Object.freeze({
  playerInstanceId: 'obs-player',
  connectionId: 'obs-connection',
  leaseEpoch: 4,
});

function protocolSnapshot(overrides = {}) {
  const base = {
    selectedOutputMode: 'obs',
    players: [{
      playerInstanceId: CURRENT_ROUTE.playerInstanceId,
      connectionId: CURRENT_ROUTE.connectionId,
      clientKind: 'obs-browser-source',
      state: 'ready',
      lastSeenAt: 1_000,
      heartbeatStale: false,
    }],
    eligibleCandidates: { speaker: ['speaker-player'], obs: [CURRENT_ROUTE.playerInstanceId] },
    lease: {
      epoch: CURRENT_ROUTE.leaseEpoch,
      leaseTarget: CURRENT_ROUTE.playerInstanceId,
      clientKind: 'obs-browser-source',
      status: 'ready',
      switchId: 'switch-obs',
    },
    activeFamily: null,
    activeCheckId: null,
  };
  return {
    ...base,
    ...overrides,
    players: overrides.players ?? base.players,
    eligibleCandidates: {
      ...base.eligibleCandidates,
      ...(overrides.eligibleCandidates ?? {}),
    },
    lease: { ...base.lease, ...(overrides.lease ?? {}) },
  };
}

function coordinatorSnapshot(overrides = {}) {
  const base = {
    ready: true,
    writable: true,
    authorityUnknown: false,
    routeUnknown: false,
    playerSnapshot: protocolSnapshot(),
    activeRun: null,
    pendingSwitch: null,
    pendingTest: null,
    testEvidence: {
      generation: 1,
      requested: { activeCheckId: null, pendingOperation: null, pendingCheckId: null },
      started: null,
      markers: [],
      lastTerminal: null,
      lastSequences: { test: null, test_telemetry: null },
    },
  };
  return {
    ...base,
    ...overrides,
    playerSnapshot: Object.hasOwn(overrides, 'playerSnapshot')
      ? overrides.playerSnapshot
      : base.playerSnapshot,
    testEvidence: {
      ...base.testEvidence,
      ...(overrides.testEvidence ?? {}),
      lastSequences: {
        ...base.testEvidence.lastSequences,
        ...(overrides.testEvidence?.lastSequences ?? {}),
      },
    },
  };
}

function testEvent(event, overrides = {}) {
  const sequenceNamespace = event === 'test_marker' ? 'test_telemetry' : 'test';
  const defaultSequence = event === 'test_started' ? 10 : event === 'test_marker' ? 20 : 11;
  const base = {
    event,
    eventId: `event-${event}-${overrides.checkId ?? 'check-a'}`,
    sequence: defaultSequence,
    sequenceNamespace,
    checkId: 'check-a',
    playerInstanceId: CURRENT_ROUTE.playerInstanceId,
    connectionId: CURRENT_ROUTE.connectionId,
    leaseEpoch: CURRENT_ROUTE.leaseEpoch,
    monotonicTimeMs: 1_000,
  };
  if (event === 'test_marker') {
    base.markerIndex = 0;
    base.markerTimeMs = 2_250;
  } else if (event === 'test_complete') {
    base.markerCount = 1;
    base.postcondition = { stopped: true };
  } else if (event === 'test_failed') {
    base.code = 'fixture_error';
    base.detail = { phase: 'fixture' };
  }
  return { ...base, ...overrides };
}

function activeEvidence(checkId = 'check-a', { markers = [], startedOverrides = {} } = {}) {
  const started = testEvent('test_started', { checkId, ...startedOverrides });
  return {
    started,
    markers,
    lastSequences: {
      test: started.sequence,
      test_telemetry: markers.at(-1)?.sequence ?? null,
    },
  };
}

function terminalEvidence(event, {
  checkId = 'check-a',
  markers = [],
  terminalOverrides = {},
} = {}) {
  const terminal = testEvent(event, { checkId, ...terminalOverrides });
  return {
    started: null,
    markers,
    lastTerminal: terminal,
    lastSequences: {
      test: terminal.sequence,
      test_telemetry: markers.at(-1)?.sequence ?? null,
    },
  };
}

function derive(overrides = {}) {
  return deriveObsAudioCheckView({
    snapshot: coordinatorSnapshot(),
    actualOutputMode: 'obs',
    outputRouteStable: true,
    outputSwitchState: { status: 'idle' },
    playbackTransitionState: { status: 'idle' },
    ...overrides,
  });
}

test('lightweight UI duration stays aligned with the fixture contract', () => {
  assert.equal(OBS_AUDIO_CHECK_DURATION_MS, ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS);
  assert.equal(OBS_AUDIO_CHECK_CANCELLED_CODE, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED);
});

test('OBS audio check starts only from one exact authoritative idle OBS route', () => {
  const ready = derive();
  assert.equal(ready.stage, OBS_AUDIO_CHECK_STAGES.READY);
  assert.equal(ready.canStart, true);
  assert.equal(ready.canStop, false);

  const blocked = [
    derive({ actualOutputMode: 'speaker' }),
    derive({ outputRouteStable: false }),
    derive({ outputSwitchState: { status: 'activating' } }),
    derive({ playbackTransitionState: { status: 'loading' } }),
    derive({ snapshot: coordinatorSnapshot({ activeRun: { entryId: 'entry-a', runId: 'run-a' } }) }),
    derive({ snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' } }),
    }) }),
    derive({ snapshot: coordinatorSnapshot({ pendingSwitch: { operation: 'activate' } }) }),
    derive({ snapshot: coordinatorSnapshot({ pendingTest: { operation: 'start', checkId: 'check-a' } }) }),
    derive({ snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ eligibleCandidates: { obs: [] } }),
    }) }),
    derive({ snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ eligibleCandidates: { obs: ['obs-player', 'obs-copy'] } }),
    }) }),
    derive({ snapshot: coordinatorSnapshot({ writable: false }) }),
  ];
  assert.equal(blocked.every((view) => view.canStart === false), true);
  assert.equal(blocked.at(-2).messageKey, 'obs.audioCheck.block.candidateDuplicate');
  assert.equal(blocked.at(-1).messageKey, 'obs.audioCheck.block.otherController');

  const duplicateBeforeRouteActivation = derive({
    actualOutputMode: 'speaker',
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ eligibleCandidates: { obs: ['obs-player', 'obs-copy'] } }),
    }),
  });
  assert.equal(
    duplicateBeforeRouteActivation.messageKey,
    'obs.audioCheck.block.candidateDuplicate',
    'the actionable duplicate cause must win over a generic inactive-OBS message',
  );
});

test('missing connection state is actionable while explicit authority or route uncertainty stays unknown', () => {
  for (const snapshot of [
    null,
    coordinatorSnapshot({ ready: false }),
    coordinatorSnapshot({ playerSnapshot: null }),
  ]) {
    const disconnected = derive({ snapshot });
    assert.equal(disconnected.stage, OBS_AUDIO_CHECK_STAGES.BLOCKED);
    assert.equal(disconnected.messageKey, 'obs.audioCheck.block.connection');
    assert.equal(disconnected.unknown, false);
    assert.equal(disconnected.canStart, false);
    assert.equal(disconnected.canStop, false);
  }

  for (const snapshot of [
    coordinatorSnapshot({ authorityUnknown: true }),
    coordinatorSnapshot({ routeUnknown: true }),
  ]) {
    const unknown = derive({ snapshot });
    assert.equal(unknown.stage, OBS_AUDIO_CHECK_STAGES.UNKNOWN);
    assert.equal(unknown.messageKey, 'obs.audioCheck.stage.unknown');
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.completed, false);
    assert.equal(unknown.cancelled, false);
    assert.equal(unknown.failed, false);
  }
});

test('request, TEST_STARTED, and matching markers are exposed as distinct evidence', () => {
  const requested = derive({
    snapshot: coordinatorSnapshot({
      pendingTest: { operation: 'start', checkId: 'check-a', commandId: 'command-a' },
    }),
  });
  assert.equal(requested.stage, OBS_AUDIO_CHECK_STAGES.REQUESTED);
  assert.equal(requested.requestObserved, true);
  assert.equal(requested.actualPlayingObserved, false);
  assert.equal(requested.canStart, false);

  const started = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
      testEvidence: activeEvidence(),
    }),
  });
  assert.equal(started.stage, OBS_AUDIO_CHECK_STAGES.PLAYING);
  assert.equal(started.actualPlayingObserved, true);
  assert.equal(started.markerCount, 0);
  assert.equal(started.canStop, true);

  const marker = testEvent('test_marker');
  const progress = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
      testEvidence: activeEvidence('check-a', { markers: [marker] }),
    }),
  });
  assert.equal(progress.stage, OBS_AUDIO_CHECK_STAGES.PROGRESS);
  assert.equal(progress.actualPlayingObserved, true);
  assert.equal(progress.markerCount, 1);
  assert.equal(progress.markerTimeMs, 2_250);
  assert.equal(progress.progressPercent, 28);
  assert.equal(Object.hasOwn(progress, 'rmsDbfs'), false);
  assert.equal(Object.hasOwn(progress, 'peakDbfs'), false);
  assert.equal(progress.canStop, true);
});

test('current-route terminal evidence distinguishes completed, cancelled, and failed without inventing PLAYING', () => {
  const marker = testEvent('test_marker');
  const completed = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: terminalEvidence('test_complete', { markers: [marker] }),
    }),
  });
  assert.equal(completed.stage, OBS_AUDIO_CHECK_STAGES.COMPLETED);
  assert.equal(completed.completed, true);
  assert.equal(completed.actualPlayingObserved, true, 'a retained matching marker proves the attempt started');
  assert.equal(completed.terminalEvent, 'test_complete');
  assert.equal(completed.canStart, true);

  const failedAfterStarted = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: terminalEvidence('test_failed', {
        checkId: 'check-b',
        terminalOverrides: { startedObserved: true },
      }),
    }),
  });
  assert.equal(failedAfterStarted.stage, OBS_AUDIO_CHECK_STAGES.FAILED);
  assert.equal(failedAfterStarted.failed, true);
  assert.equal(failedAfterStarted.completed, false);
  assert.equal(
    failedAfterStarted.actualPlayingObserved,
    true,
    'the accepted terminal may preserve that TEST_STARTED was observed',
  );

  const failedBeforeStart = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: terminalEvidence('test_failed', {
        checkId: 'check-before-start',
        terminalOverrides: { startedObserved: false },
      }),
    }),
  });
  assert.equal(failedBeforeStart.stage, OBS_AUDIO_CHECK_STAGES.FAILED);
  assert.equal(
    failedBeforeStart.actualPlayingObserved,
    false,
    'a terminal accepted before TEST_STARTED must never invent PLAYING evidence',
  );

  const cancelled = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: terminalEvidence('test_failed', {
        checkId: 'check-c',
        terminalOverrides: {
          code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED,
          startedObserved: false,
        },
      }),
    }),
  });
  assert.equal(cancelled.stage, OBS_AUDIO_CHECK_STAGES.CANCELLED);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.completed, false);
  assert.equal(cancelled.failed, false);
  assert.equal(cancelled.actualPlayingObserved, false);
  assert.equal(cancelled.active, false);
  assert.equal(cancelled.canStart, true);
});

test('terminal evidence becomes stale after a speaker switch or OBS player identity change', () => {
  const oldTerminal = terminalEvidence('test_complete', { markers: [testEvent('test_marker')] });
  const scenarios = [
    {
      name: 'speaker route',
      input: { actualOutputMode: 'speaker' },
    },
    {
      name: 'new player instance',
      input: {
        snapshot: coordinatorSnapshot({
          playerSnapshot: protocolSnapshot({
            players: [{ playerInstanceId: 'obs-player-new', connectionId: 'obs-connection-new' }],
            eligibleCandidates: { obs: ['obs-player-new'] },
            lease: { leaseTarget: 'obs-player-new', epoch: 1 },
          }),
          testEvidence: oldTerminal,
        }),
      },
    },
    {
      name: 'new lease epoch',
      input: {
        snapshot: coordinatorSnapshot({
          playerSnapshot: protocolSnapshot({ lease: { epoch: CURRENT_ROUTE.leaseEpoch + 1 } }),
          testEvidence: oldTerminal,
        }),
      },
    },
    {
      name: 'new connection for the same player',
      input: {
        snapshot: coordinatorSnapshot({
          playerSnapshot: protocolSnapshot({
            players: [{
              playerInstanceId: CURRENT_ROUTE.playerInstanceId,
              connectionId: 'obs-connection-new',
            }],
          }),
          testEvidence: oldTerminal,
        }),
      },
    },
    {
      name: 'leased player has no current connection record',
      input: {
        snapshot: coordinatorSnapshot({
          playerSnapshot: protocolSnapshot({ players: [] }),
          testEvidence: oldTerminal,
        }),
      },
    },
    {
      name: 'ambiguous current connections for the same player',
      input: {
        snapshot: coordinatorSnapshot({
          playerSnapshot: protocolSnapshot({
            players: [
              {
                playerInstanceId: CURRENT_ROUTE.playerInstanceId,
                connectionId: CURRENT_ROUTE.connectionId,
              },
              {
                playerInstanceId: CURRENT_ROUTE.playerInstanceId,
                connectionId: 'obs-connection-new',
              },
            ],
          }),
          testEvidence: oldTerminal,
        }),
      },
    },
    {
      name: 'new lifecycle sequence',
      input: {
        snapshot: coordinatorSnapshot({
          testEvidence: { ...oldTerminal, lastSequences: { test: 12, test_telemetry: 20 } },
        }),
      },
    },
  ];

  for (const { name, input } of scenarios) {
    const view = derive({
      snapshot: coordinatorSnapshot({ testEvidence: oldTerminal }),
      ...input,
    });
    assert.equal(view.stage, OBS_AUDIO_CHECK_STAGES.BLOCKED, name);
    assert.equal(view.messageKey, 'obs.audioCheck.block.staleEvidence', name);
    assert.equal(view.staleEvidence, true, name);
    assert.equal(view.completed, false, name);
    assert.equal(view.cancelled, false, name);
    assert.equal(view.failed, false, name);
    assert.equal(view.terminalEvent, null, name);
    assert.equal(view.actualPlayingObserved, false, name);
  }
});

test('public effective check identity closes terminal-before-snapshot transients safely', () => {
  const scenarios = [
    {
      name: 'complete',
      evidence: terminalEvidence('test_complete', { markers: [testEvent('test_marker')] }),
      stage: OBS_AUDIO_CHECK_STAGES.COMPLETED,
    },
    {
      name: 'cancelled',
      evidence: terminalEvidence('test_failed', {
        terminalOverrides: {
          code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED,
          startedObserved: true,
        },
      }),
      stage: OBS_AUDIO_CHECK_STAGES.CANCELLED,
    },
    {
      name: 'strong-stop failure',
      evidence: terminalEvidence('test_failed', {
        terminalOverrides: { startedObserved: true },
      }),
      stage: OBS_AUDIO_CHECK_STAGES.FAILED,
    },
  ];

  for (const scenario of scenarios) {
    const view = derive({
      snapshot: coordinatorSnapshot({
        playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
        testEvidence: {
          ...scenario.evidence,
          requested: {
            activeCheckId: 'check-a',
            effectiveActiveCheckId: null,
            pendingOperation: null,
            pendingCheckId: null,
          },
        },
      }),
    });
    assert.equal(view.stage, scenario.stage, scenario.name);
    assert.equal(view.active, false, scenario.name);
    assert.equal(view.canStop, false, scenario.name);
    assert.equal(view.canStart, true, scenario.name);
    assert.equal(view.terminalEvent, scenario.evidence.lastTerminal.event, scenario.name);
  }
});

test('an unproven failure preserves active recovery while a proven terminal does not reopen Stop', () => {
  const unsafeFailure = terminalEvidence('test_failed', {
    terminalOverrides: { startedObserved: true },
  });
  const view = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
      testEvidence: {
        ...unsafeFailure,
        requested: {
          activeCheckId: 'check-a',
          effectiveActiveCheckId: 'check-a',
          pendingOperation: null,
          pendingCheckId: null,
        },
      },
    }),
  });

  assert.equal(view.stage, OBS_AUDIO_CHECK_STAGES.FAILED);
  assert.equal(view.failed, true);
  assert.equal(view.active, true);
  assert.equal(view.canStop, true);
  assert.equal(view.canStart, false);
});

test('a new attempt never resurfaces the previous success or its marker evidence', () => {
  const oldMarker = testEvent('test_marker', { checkId: 'check-old' });
  const oldTerminal = testEvent('test_complete', { checkId: 'check-old' });
  const previousSuccess = {
    markers: [oldMarker],
    lastTerminal: oldTerminal,
    lastSequences: { test: oldTerminal.sequence, test_telemetry: oldMarker.sequence },
  };
  const pendingNewAttempt = derive({
    snapshot: coordinatorSnapshot({
      pendingTest: { operation: 'start', checkId: 'check-new', commandId: 'command-new' },
      testEvidence: previousSuccess,
    }),
  });
  assert.equal(pendingNewAttempt.stage, OBS_AUDIO_CHECK_STAGES.REQUESTED);
  assert.equal(pendingNewAttempt.checkId, 'check-new');
  assert.equal(pendingNewAttempt.markerCount, 0);
  assert.equal(pendingNewAttempt.actualPlayingObserved, false);
  assert.equal(pendingNewAttempt.completed, false);
  assert.equal(pendingNewAttempt.terminalEvent, null);

  const staleStartedDuringNewAttempt = derive({
    snapshot: coordinatorSnapshot({
      pendingTest: { operation: 'start', checkId: 'check-new', commandId: 'command-new' },
      testEvidence: activeEvidence('check-old', { markers: [oldMarker] }),
    }),
  });
  assert.equal(staleStartedDuringNewAttempt.stage, OBS_AUDIO_CHECK_STAGES.REQUESTED);
  assert.equal(staleStartedDuringNewAttempt.checkId, 'check-new');
  assert.equal(staleStartedDuringNewAttempt.markerCount, 0);
  assert.equal(staleStartedDuringNewAttempt.actualPlayingObserved, false);

  const newerSequenceWithoutTerminal = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: {
        ...previousSuccess,
        lastSequences: { test: oldTerminal.sequence + 1, test_telemetry: oldMarker.sequence },
      },
    }),
  });
  assert.equal(newerSequenceWithoutTerminal.messageKey, 'obs.audioCheck.block.staleEvidence');
  assert.equal(newerSequenceWithoutTerminal.completed, false);
  assert.equal(newerSequenceWithoutTerminal.actualPlayingObserved, false);

  const immediatelyCancelledNewAttempt = derive({
    snapshot: coordinatorSnapshot({
      testEvidence: terminalEvidence('test_failed', {
        checkId: 'check-new',
        terminalOverrides: {
          sequence: oldTerminal.sequence + 1,
          code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED,
          startedObserved: false,
        },
      }),
    }),
  });
  assert.equal(immediatelyCancelledNewAttempt.stage, OBS_AUDIO_CHECK_STAGES.CANCELLED);
  assert.equal(immediatelyCancelledNewAttempt.cancelled, true);
  assert.equal(immediatelyCancelledNewAttempt.completed, false);
  assert.equal(immediatelyCancelledNewAttempt.actualPlayingObserved, false);
  assert.equal(immediatelyCancelledNewAttempt.markerCount, 0);
});

test('active checks expose safe stop while stale starts cannot operate the current route', () => {
  const awaitingPlaying = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
    }),
  });
  assert.equal(awaitingPlaying.stage, OBS_AUDIO_CHECK_STAGES.REQUESTED);
  assert.equal(awaitingPlaying.canStop, true);

  const duplicateArrivedDuringCheck = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({
        activeCheckId: 'check-a',
        eligibleCandidates: { obs: ['obs-player', 'obs-copy'] },
      }),
    }),
  });
  assert.equal(
    duplicateArrivedDuringCheck.canStop,
    true,
    'candidate changes must not remove the exact leased test stop recovery',
  );

  const stopping = derive({
    snapshot: coordinatorSnapshot({
      playerSnapshot: protocolSnapshot({ activeCheckId: 'check-a' }),
      pendingTest: { operation: 'stop', checkId: 'check-a', commandId: 'command-stop' },
    }),
  });
  assert.equal(stopping.stage, OBS_AUDIO_CHECK_STAGES.STOPPING);
  assert.equal(stopping.canStop, false);

  const staleStarted = activeEvidence('check-a', {
    startedOverrides: { leaseEpoch: CURRENT_ROUTE.leaseEpoch - 1 },
  });
  const stale = derive({ snapshot: coordinatorSnapshot({ testEvidence: staleStarted }) });
  assert.equal(stale.messageKey, 'obs.audioCheck.block.staleEvidence');
  assert.equal(stale.canStop, false);
  assert.equal(stale.active, false);
  assert.equal(stale.actualPlayingObserved, false);
});
