import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';
import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  CONTROL_COMMAND_TYPES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ON_AIR_SEQUENCE_NAMESPACES,
  SERVER_MESSAGE_TYPES,
  TEST_EVENT_TYPES,
  validateOnAirMessage,
} from '../src/lib/onAirProtocol.js';
import { ON_AIR_TEST_FIXTURE_MIN_DURATION_MS } from '../src/lib/onAirTestFixture.js';
import { ON_AIR_V2_CONNECTION_STATES } from '../src/lib/onAirV2Connection.js';

const strongStoppedTestPostcondition = Object.freeze({
  status: 'stopped',
  mediaPaused: true,
  sourceDetached: true,
  autoplayCancelled: true,
  audible: false,
});

class FakeConnection {
  constructor(options) {
    this.options = options;
    this.identity = Object.freeze({ controlInstanceId: 'control-a' });
    this.state = ON_AIR_V2_CONNECTION_STATES.IDLE;
    this.welcome = null;
    this.commands = [];
    this.nextRequestResult = null;
    this.closed = false;
    this.connectCalls = 0;
  }

  connect() {
    this.connectCalls += 1;
    this.state = ON_AIR_V2_CONNECTION_STATES.CONNECTING;
    this.options.onStateChange?.({
      previous: ON_AIR_V2_CONNECTION_STATES.IDLE,
      state: this.state,
      detail: {},
    });
    return 1;
  }

  close() {
    const previous = this.state;
    this.state = ON_AIR_V2_CONNECTION_STATES.CLOSED;
    this.closed = true;
    this.options.onStateChange?.({ previous, state: this.state, detail: {} });
  }

  requestCommand(command) {
    this.commands.push(structuredClone(command));
    if (typeof this.nextRequestResult === 'function') return this.nextRequestResult(command);
    if (this.nextRequestResult) return this.nextRequestResult;
    return Object.freeze({
      status: 'created',
      retryAllowed: true,
      entry: Object.freeze({
        commandId: command.commandId,
        command: structuredClone(command),
        state: 'requested',
      }),
    });
  }

  snapshot() {
    return Object.freeze({
      role: 'control',
      state: this.state,
      identity: this.identity,
      welcome: this.welcome,
      liveness: Object.freeze({
        state: 'unknown',
        unknown: true,
        ageMs: 20_000,
        code: 'liveness_unknown',
      }),
    });
  }

  negotiate(welcome = controlWelcome()) {
    const previous = this.state;
    this.state = ON_AIR_V2_CONNECTION_STATES.READY;
    this.welcome = structuredClone(welcome);
    this.options.onStateChange?.({ previous, state: this.state, detail: {} });
    this.options.onNegotiated?.(this.snapshot());
  }

  frame(frame) {
    this.options.onFrame?.(structuredClone(frame));
  }

  result(result) {
    this.options.onCommandResult?.(structuredClone(result));
  }

  lose(reason = 'fixture_disconnect') {
    const previous = this.state;
    this.state = ON_AIR_V2_CONNECTION_STATES.DISCONNECTED;
    this.options.onStateChange?.({ previous, state: this.state, detail: { reason } });
  }

  diagnostic(diagnostic) {
    this.options.onDiagnostic?.(structuredClone(diagnostic));
  }
}

function controlWelcome(overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.CONTROL_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId: 'control-connection-a',
    controlInstanceId: 'control-a',
    writable: true,
    controlEpoch: 3,
    writableControlInstanceId: 'control-a',
    code: 'control_registered',
    ...overrides,
  };
}

function playerSnapshot(overrides = {}) {
  const base = {
    type: SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    selectedOutputMode: null,
    players: [],
    eligibleCandidates: {
      speaker: ['speaker-player'],
      obs: ['obs-player'],
    },
    lease: {
      epoch: 0,
      leaseTarget: null,
      clientKind: null,
      status: 'inactive',
      switchId: null,
    },
    controlLease: {
      controlEpoch: 3,
      writableControlInstanceId: 'control-a',
      writableConnected: true,
    },
    activeFamily: null,
    activeCheckId: null,
    desiredTransport: {
      status: 'idle',
      song: null,
      entryId: null,
      runId: null,
      position: 0,
      volume: 100,
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'not_confirmed' },
  };
  return {
    ...base,
    ...overrides,
    eligibleCandidates: {
      ...base.eligibleCandidates,
      ...(overrides.eligibleCandidates ?? {}),
    },
    lease: { ...base.lease, ...(overrides.lease ?? {}) },
    controlLease: { ...base.controlLease, ...(overrides.controlLease ?? {}) },
    desiredTransport: { ...base.desiredTransport, ...(overrides.desiredTransport ?? {}) },
    confirmedPlayback: { ...base.confirmedPlayback, ...(overrides.confirmedPlayback ?? {}) },
  };
}

function readyOutputSnapshot(overrides = {}) {
  return playerSnapshot({
    selectedOutputMode: 'obs',
    players: [{
      playerInstanceId: 'obs-player',
      connectionId: 'obs-connection-a',
      clientKind: 'obs-browser-source',
      state: 'ready',
      lastSeenAt: 1_000,
      heartbeatStale: false,
      buildId: 'coordinator-test-build',
      capabilities: { obsRuntime: true },
      runtime: {
        sourceActive: true,
        streaming: false,
        streamingStatusObserved: true,
      },
    }],
    lease: {
      epoch: 4,
      leaseTarget: 'obs-player',
      clientKind: 'obs-browser-source',
      status: 'ready',
      switchId: 'active-switch',
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_ready_no_playback' },
    ...overrides,
  });
}

function testEvent(event, overrides = {}) {
  const base = {
    type: ON_AIR_MESSAGE_TYPES.TEST_EVENT,
    eventId: `test-event-${event}-${overrides.sequence ?? 1}`,
    event,
    sequence: overrides.sequence ?? 1,
    checkId: 'check-1',
    leaseEpoch: 4,
    playerInstanceId: 'obs-player',
    connectionId: 'obs-connection-a',
    monotonicTimeMs: 1_000,
  };
  if (event === TEST_EVENT_TYPES.TEST_MARKER) {
    base.markerIndex = 0;
    base.markerTimeMs = 250;
  } else if (event === TEST_EVENT_TYPES.TEST_COMPLETE) {
    base.markerCount = 1;
    base.postcondition = { stopped: true };
  } else if (event === TEST_EVENT_TYPES.TEST_FAILED) {
    base.code = 'fixture_test_failed';
    base.detail = { phase: 'fixture' };
  }
  return { ...base, ...overrides };
}

function createHarness({ welcome, snapshot, callbacks, requestResult } = {}) {
  let connection;
  const counts = new Map();
  const idFactory = (scope) => {
    const next = (counts.get(scope) ?? 0) + 1;
    counts.set(scope, next);
    return `${scope}-${next}`;
  };
  const coordinator = new OnAirControlCoordinator({
    transport: {
      url: 'wss://example.invalid/v1/sessions/protocol-v2-room/ws?role=control&protocol=2',
      sessionId: 'protocol-v2-room',
      webSocketFactory: () => ({}),
      buildId: 'coordinator-test-build',
      capabilities: {},
    },
    idFactory,
    callbacks,
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.nextRequestResult = requestResult ?? null;
      return connection;
    },
  });
  coordinator.connect();
  connection.negotiate(welcome ?? controlWelcome());
  if (snapshot !== null) connection.frame(snapshot ?? playerSnapshot());
  return { coordinator, connection };
}

function beginPreStartStop() {
  const harness = createHarness({ snapshot: readyOutputSnapshot() });
  const start = harness.coordinator.startTest();
  harness.connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
  const stop = harness.coordinator.stopTest();
  return { ...harness, start, stop };
}

function exactCancellationEvent(start, stop, overrides = {}) {
  return testEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    checkId: start.command.checkId,
    commandId: stop.command.commandId,
    sequence: 6,
    code: 'playback_adapter_test_cancelled',
    detail: { reason: 'explicit_stop', safetyStopped: true },
    safetyPostcondition: strongStoppedTestPostcondition,
    ...overrides,
  });
}

function beginStartedTest() {
  const harness = createHarness({ snapshot: readyOutputSnapshot() });
  const start = harness.coordinator.startTest();
  harness.connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 10,
  }));
  return { ...harness, start };
}

function emergencyAcknowledgement(command, overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    eventId: 'emergency-event-1',
    commandId: command.commandId,
    sessionId: 'protocol-v2-room',
    playerInstanceId: 'obs-player',
    connectionId: 'obs-connection-a',
    sequence: 0,
    monotonicTimeMs: 2_000,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
    ...overrides,
  };
}

function acknowledgeEmergencyCommand(connection, command, overrides = {}) {
  connection.result({
    status: 'acknowledged',
    entry: {
      commandId: command.commandId,
      command,
      state: 'acknowledged',
      result: {
        code: 'emergency_stop_dispatched',
        leaseEpoch: 5,
        delivered: { protocolV2: 1, legacy: 0 },
        ...overrides,
      },
    },
  });
}

function emergencySnapshot(status = 'inactive', overrides = {}) {
  const stopped = status === 'inactive';
  return readyOutputSnapshot({
    lease: {
      epoch: 5,
      leaseTarget: null,
      clientKind: null,
      status,
      switchId: null,
    },
    activeCheckId: null,
    activeFamily: null,
    desiredTransport: {
      status: 'stopped',
      song: null,
      entryId: null,
      runId: null,
      position: 0,
      volume: 100,
    },
    confirmedPlayback: stopped
      ? {
          status: 'stopped',
          reasonCode: 'emergency_stop_acknowledged',
          position: 0,
          paused: true,
          sourceDetached: true,
          autoplayCancelled: true,
          audible: false,
          lastSeenAt: 2_100,
        }
      : { status: 'unknown', reasonCode: 'emergency_stop_unconfirmed' },
    ...overrides,
  });
}

function assertCoordinatorError(operation, code) {
  assert.throws(operation, (error) => error?.code === code);
}

test('stores validated welcome/snapshot and ignores generic 2s control liveness as authority', () => {
  const snapshots = [];
  const { coordinator, connection } = createHarness();
  const unsubscribe = coordinator.subscribe((snapshot) => snapshots.push(snapshot));
  const state = coordinator.snapshot();

  assert.equal(state.ready, true);
  assert.equal(state.writable, true);
  assert.equal(state.unknown, false);
  assert.equal(state.authorityUnknown, false);
  assert.equal(state.routeUnknown, false);
  assert.equal(connection.snapshot().liveness.state, 'unknown');
  assert.equal(state.welcome.controlInstanceId, 'control-a');
  assert.equal(state.playerSnapshot.lease.status, 'inactive');
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.playerSnapshot.lease), true);
  assert.equal(state.limitation.code, 'snapshot_revision_unavailable');
  assert.ok(snapshots.length >= 1);
  unsubscribe();
});

test('relayed 4Hz player heartbeats do not publish React-facing coordinator snapshots', () => {
  const snapshots = [];
  const { connection } = createHarness({
    callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
  });
  const beforeHeartbeat = snapshots.length;

  connection.frame({
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    playerInstanceId: 'obs-player',
    connectionId: 'obs-connection-a',
    leaseEpoch: 0,
    sequence: 0,
    monotonicTimeMs: 250,
    runtime: { sourceActive: true },
  });

  assert.equal(snapshots.length, beforeHeartbeat);
});

test('requires matching writable welcome and control lease before every command', () => {
  for (const options of [
    { welcome: controlWelcome({ writable: false, writableControlInstanceId: null }) },
    { snapshot: playerSnapshot({ controlLease: { writableControlInstanceId: 'control-b' } }) },
    { snapshot: playerSnapshot({ controlLease: { controlEpoch: 4 } }) },
    { snapshot: playerSnapshot({ controlLease: { writableConnected: false } }) },
  ]) {
    const { coordinator, connection } = createHarness(options);
    assertCoordinatorError(
      () => coordinator.activateOutput('obs'),
      ON_AIR_CONTROL_COORDINATOR_CODES.NOT_WRITABLE,
    );
    assert.equal(connection.commands.length, 0);
  }
});

test('a safe read-only controller takes authority only after its exact ACK and snapshot proof', () => {
  const { coordinator, connection } = createHarness({
    welcome: controlWelcome({
      writable: false,
      writableControlInstanceId: 'control-b',
      code: 'control_lease_read_only',
    }),
    snapshot: playerSnapshot({
      controlLease: {
        controlEpoch: 3,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
    }),
  });

  assert.equal(coordinator.snapshot().writable, false);
  const takeover = coordinator.takeOverControl();
  assert.deepEqual(takeover.command, {
    type: CONTROL_COMMAND_TYPES.TAKEOVER,
    commandId: takeover.command.commandId,
    controlInstanceId: 'control-a',
    expectedControlEpoch: 3,
  });
  assert.equal(validateOnAirMessage(takeover.command).ok, true);
  assert.deepEqual(coordinator.snapshot().pendingTakeover, {
    status: 'pending',
    commandId: takeover.command.commandId,
    expectedControlEpoch: 3,
    reasonCode: null,
  });

  connection.result({
    status: 'acknowledged',
    retryAllowed: false,
    entry: {
      commandId: takeover.command.commandId,
      command: takeover.command,
      state: 'acknowledged',
      result: {
        code: 'control_lease_granted',
        controlEpoch: 4,
        writableControlInstanceId: 'control-a',
      },
    },
  });
  assert.equal(coordinator.snapshot().pendingTakeover, null);
  assert.equal(
    coordinator.snapshot().writable,
    false,
    'the ACK advances the welcome proof but cannot replace the broadcast lease snapshot',
  );

  connection.frame(playerSnapshot({
    controlLease: {
      controlEpoch: 4,
      writableControlInstanceId: 'control-a',
      writableConnected: true,
    },
  }));
  assert.equal(coordinator.snapshot().writable, true);
  assert.equal(coordinator.snapshot().welcome.controlEpoch, 4);
  assert.deepEqual(coordinator.snapshot().pendingCommandIds, []);
  assert.equal(connection.commands.length, 1, 'authority confirmation never replays the takeover');
});

test('takeover also converges when the authoritative snapshot arrives before its ACK', () => {
  const { coordinator, connection } = createHarness({
    welcome: controlWelcome({
      writable: false,
      writableControlInstanceId: 'control-b',
      code: 'control_lease_read_only',
    }),
    snapshot: playerSnapshot({
      controlLease: {
        controlEpoch: 3,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
    }),
  });
  const takeover = coordinator.takeOverControl();

  connection.frame(playerSnapshot({
    controlLease: {
      controlEpoch: 4,
      writableControlInstanceId: 'control-a',
      writableConnected: true,
    },
  }));
  assert.equal(coordinator.snapshot().writable, false, 'a snapshot alone does not settle the command');
  assert.equal(coordinator.snapshot().pendingTakeover.status, 'pending');

  connection.result({
    status: 'acknowledged',
    retryAllowed: false,
    entry: {
      commandId: takeover.command.commandId,
      command: takeover.command,
      state: 'acknowledged',
      result: {
        code: 'control_lease_granted',
        controlEpoch: 4,
        writableControlInstanceId: 'control-a',
      },
    },
  });
  assert.equal(coordinator.snapshot().writable, true);
  assert.equal(coordinator.snapshot().pendingTakeover, null);
  assert.equal(connection.commands.length, 1);
});

test('a read-only controller cannot take authority while an output lease is audible', () => {
  const { coordinator, connection } = createHarness({
    welcome: controlWelcome({
      writable: false,
      writableControlInstanceId: 'control-b',
      code: 'control_lease_read_only',
    }),
    snapshot: readyOutputSnapshot({
      lease: { status: 'audible' },
      controlLease: {
        controlEpoch: 3,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
    }),
  });

  assertCoordinatorError(
    () => coordinator.takeOverControl(),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
  );
  assert.equal(connection.commands.length, 0);
  assert.equal(coordinator.snapshot().pendingTakeover, null);
});

test('an unknown takeover outcome is exposed as failed and permanently fences authority', () => {
  const { coordinator, connection } = createHarness({
    welcome: controlWelcome({
      writable: false,
      writableControlInstanceId: 'control-b',
      code: 'control_lease_read_only',
    }),
    snapshot: playerSnapshot({
      controlLease: {
        controlEpoch: 3,
        writableControlInstanceId: 'control-b',
        writableConnected: true,
      },
    }),
  });
  const takeover = coordinator.takeOverControl();

  connection.result({
    status: 'outcome_unknown',
    retryAllowed: false,
    entry: {
      commandId: takeover.command.commandId,
      command: takeover.command,
      state: 'outcome_unknown',
    },
  });

  assert.deepEqual(coordinator.snapshot().pendingTakeover, {
    status: 'failed',
    commandId: takeover.command.commandId,
    expectedControlEpoch: 3,
    reasonCode: ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  });
  assert.equal(
    coordinator.snapshot().unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assertCoordinatorError(
    () => coordinator.takeOverControl(),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 1, 'an unknown takeover is never retried automatically');
});

test('activation requires one eligible candidate and an inactive null lease', () => {
  const duplicate = createHarness({
    snapshot: playerSnapshot({ eligibleCandidates: { obs: ['obs-a', 'obs-b'] } }),
  });
  assertCoordinatorError(
    () => duplicate.coordinator.activateOutput('obs'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_CANDIDATE_COUNT,
  );
  assert.equal(duplicate.connection.commands.length, 0);

  const repeated = createHarness({
    snapshot: playerSnapshot({ eligibleCandidates: { obs: ['obs-a', 'obs-a'] } }),
  });
  assertCoordinatorError(
    () => repeated.coordinator.activateOutput('obs'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_CANDIDATE_COUNT,
  );
  assert.equal(repeated.connection.commands.length, 0);

  const active = createHarness({ snapshot: readyOutputSnapshot() });
  assertCoordinatorError(
    () => active.coordinator.activateOutput('speaker'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_LEASE_NOT_INACTIVE,
  );
  assert.equal(active.connection.commands.length, 0);
});

test('speaker and OBS switching is explicit deactivate-complete-then-activate with no automatic chain', () => {
  const { coordinator, connection } = createHarness();
  const activation = coordinator.activateOutput('obs');
  assert.equal(connection.commands.length, 1);
  assert.equal(validateOnAirMessage(activation.command).ok, true);
  assert.deepEqual(
    {
      type: activation.command.type,
      target: activation.command.targetPlayerInstanceId,
      leaseEpoch: activation.command.leaseEpoch,
      controlEpoch: activation.command.controlEpoch,
      outputMode: activation.command.payload.outputMode,
    },
    {
      type: 'activate_output',
      target: 'obs-player',
      leaseEpoch: 0,
      controlEpoch: 3,
      outputMode: 'obs',
    },
  );
  assertCoordinatorError(
    () => coordinator.activateOutput('speaker'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
  );
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'must-wait-for-deactivation', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
  );

  connection.frame(readyOutputSnapshot({
    lease: {
      epoch: 1,
      switchId: activation.command.switchId,
      leaseTarget: 'obs-player',
      status: 'ready',
      clientKind: 'obs-browser-source',
    },
  }));
  assert.equal(coordinator.snapshot().pendingSwitch, null);
  assert.equal(connection.commands.length, 1);

  const deactivation = coordinator.deactivateOutput();
  assert.equal(connection.commands.length, 2);
  assert.notEqual(deactivation.command.switchId, activation.command.switchId);
  assert.ok(deactivation.command.switchId.startsWith('output-switch-'));
  assert.equal(deactivation.command.targetPlayerInstanceId, 'obs-player');
  assert.equal(deactivation.command.leaseEpoch, 1);
  assert.equal(validateOnAirMessage(deactivation.command).ok, true);
  assertCoordinatorError(
    () => coordinator.activateOutput('speaker'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
  );

  connection.frame(playerSnapshot({
    lease: { epoch: 1, status: 'inactive', leaseTarget: null, clientKind: null, switchId: null },
  }));
  assert.equal(connection.commands.length, 2);
  const speakerActivation = coordinator.activateOutput('speaker');
  assert.equal(speakerActivation.command.targetPlayerInstanceId, 'speaker-player');
  assert.equal(connection.commands.length, 3);
});

test('LOAD creates a new run identity and subsequent commands require authoritative identity confirmation', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const load = coordinator.load({
    song: { id: 'song-a', type: 'local', title: 'Fixture' },
    position: 12,
    volume: 75,
  });
  assert.equal(validateOnAirMessage(load.command).ok, true);
  assert.equal(load.command.targetPlayerInstanceId, 'obs-player');
  assert.equal(load.command.leaseEpoch, 4);
  assert.equal(load.command.controlEpoch, 3);
  assert.ok(load.command.entryId.startsWith('entry-'));
  assert.ok(load.command.runId.startsWith('run-'));
  assertCoordinatorError(
    () => coordinator.play(),
    ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_UNCONFIRMED,
  );

  connection.frame({
    type: SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    desiredTransport: {
      status: 'loading',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 12,
      volume: 75,
    },
  });
  assertCoordinatorError(
    () => coordinator.play(),
    ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_UNCONFIRMED,
  );

  connection.frame(readyOutputSnapshot({
    activeFamily: {
      entryId: load.command.entryId,
      runId: load.command.runId,
    },
    desiredTransport: {
      status: 'paused',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 12,
      volume: 75,
    },
    confirmedPlayback: {
      status: 'ready',
      entryId: load.command.entryId,
      runId: load.command.runId,
      playerInstanceId: 'foreign-player',
      leaseEpoch: 4,
      paused: true,
    },
  }));
  assertCoordinatorError(
    () => coordinator.play(),
    ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_UNCONFIRMED,
  );

  connection.frame(readyOutputSnapshot({
    activeFamily: {
      entryId: load.command.entryId,
      runId: load.command.runId,
    },
    desiredTransport: {
      status: 'paused',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 12,
      volume: 75,
    },
    confirmedPlayback: {
      status: 'ready',
      entryId: load.command.entryId,
      runId: load.command.runId,
      playerInstanceId: 'obs-player',
      leaseEpoch: 4,
      paused: true,
    },
  }));

  const commands = [
    coordinator.play(),
    coordinator.pause(),
    coordinator.seek(25),
    coordinator.setVolume(55),
    coordinator.stop(),
  ].map((result) => result.command);
  assert.deepEqual(commands.map((command) => command.type), [
    'play', 'pause', 'seek', 'volume', 'stop',
  ]);
  for (const command of commands) {
    assert.equal(validateOnAirMessage(command).ok, true);
    assert.equal(command.entryId, load.command.entryId);
    assert.equal(command.runId, load.command.runId);
    assert.equal(command.targetPlayerInstanceId, 'obs-player');
    assert.equal(command.leaseEpoch, 4);
    assert.equal(command.controlEpoch, 3);
  }
  assert.equal(commands[2].payload.position, 25);
  assert.equal(commands[3].payload.volume, 55);
  assert.equal(connection.commands.length, 6);
});

test('LOAD accepts an exact caller-owned canonical identity pair without rewriting it', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const result = coordinator.load({
    entryId: 'queue-entry-canonical',
    runId: 'playback-run-canonical',
    song: { id: 'song-canonical', type: 'local', title: 'Canonical fixture' },
    position: 7,
    volume: 64,
  });

  assert.equal(result.command.entryId, 'queue-entry-canonical');
  assert.equal(result.command.runId, 'playback-run-canonical');
  assert.equal(result.command.payload.position, 7);
  assert.equal(result.command.payload.volume, 64);
  assert.equal(validateOnAirMessage(result.command).ok, true);
  assert.equal(coordinator.snapshot().activeRun.entryId, 'queue-entry-canonical');
  assert.equal(coordinator.snapshot().activeRun.runId, 'playback-run-canonical');
  assert.equal(connection.commands.length, 1);
});

test('LOAD rejects partial or invalid caller identities before allocating or sending a command', () => {
  for (const identity of [
    { entryId: 'entry-only' },
    { runId: 'run-only' },
    { entryId: '', runId: 'run-valid' },
    { entryId: ' entry-space', runId: 'run-valid' },
    { entryId: 'entry-valid', runId: null },
    { entryId: null, runId: null },
  ]) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    assertCoordinatorError(
      () => coordinator.load({
        ...identity,
        song: { id: 'identity-fixture', type: 'local' },
      }),
      ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
    );
    assert.equal(connection.commands.length, 0);
    assert.equal(coordinator.snapshot().activeRun, null);
  }
});

test('does not adopt an active run that this coordinator did not create', () => {
  const { coordinator, connection } = createHarness({
    snapshot: readyOutputSnapshot({
      activeFamily: {
        entryId: 'external-entry',
        runId: 'external-run',
      },
      desiredTransport: {
        status: 'playing',
        entryId: 'external-entry',
        runId: 'external-run',
      },
      confirmedPlayback: {
        status: 'playing',
        entryId: 'external-entry',
        runId: 'external-run',
      },
    }),
  });
  const state = coordinator.snapshot();
  assert.equal(state.unknown, true);
  assert.equal(state.unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.UNOWNED_ACTIVE_RUN);
  assertCoordinatorError(
    () => coordinator.pause(),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 0);
});

test('outcome_unknown is a sticky local lock and commands are never retried automatically', () => {
  const { coordinator, connection } = createHarness({
    snapshot: readyOutputSnapshot(),
    requestResult: (command) => ({
      status: 'outcome_unknown',
      retryAllowed: false,
      entry: { commandId: command.commandId, command, state: 'outcome_unknown' },
    }),
  });
  const result = coordinator.load({ song: { id: 'song-a', type: 'local' } });
  assert.equal(result.result.status, 'outcome_unknown');
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN);
  assert.equal(connection.commands.length, 1);

  connection.frame(readyOutputSnapshot());
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'song-b', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 1);
});

test('waitForCommandResult resolves only after the matching terminal command result', async () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const request = coordinator.publishDisplayState({ text: 'reset-check' });
  const waiting = coordinator.waitForCommandResult(request.command.commandId, { timeoutMs: 100 });

  let settled = false;
  waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  connection.result({
    status: 'acknowledged',
    entry: { commandId: request.command.commandId, state: 'acknowledged' },
  });
  assert.deepEqual(await waiting, {
    commandId: request.command.commandId,
    status: 'acknowledged',
  });
});

test('waitForCommandResult times out without inventing an acknowledgement', async () => {
  const { coordinator } = createHarness({ snapshot: readyOutputSnapshot() });
  await assert.rejects(
    coordinator.waitForCommandResult('missing-command', { timeoutMs: 1 }),
    (error) => error?.code === ON_AIR_CONTROL_COORDINATOR_CODES.COMMAND_RESULT_TIMEOUT,
  );
});

test('async outcome_unknown callback locks pending work without retry or fallback', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const load = coordinator.load({ song: { id: 'song-a', type: 'local' } });
  connection.result({
    status: 'outcome_unknown',
    retryAllowed: false,
    entry: {
      commandId: load.command.commandId,
      command: load.command,
      state: 'outcome_unknown',
    },
  });
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN);
  assertCoordinatorError(
    () => coordinator.stop(),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  connection.lose();
  coordinator.connect();
  connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
  connection.frame(readyOutputSnapshot());
  assert.equal(
    coordinator.snapshot().unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 1);
});

test('a bare connection loss unlocks after authoritative reconnect without replaying commands', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  connection.lose();
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST);

  coordinator.connect();
  connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
  assert.equal(coordinator.snapshot().unknown, true);
  connection.frame(readyOutputSnapshot());
  assert.equal(coordinator.snapshot().unknown, false);
  assert.equal(coordinator.snapshot().unknownLock, null);
  assert.equal(connection.commands.length, 0);

  coordinator.load({ song: { id: 'song-a', type: 'local' } });
  assert.equal(connection.commands.length, 1, 'only the new explicit user command is sent');
});

test('authoritative reconnect preserves an owned live run and resumes only explicit control', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const load = coordinator.load({ song: { id: 'song-a', type: 'local' } });
  connection.result({
    status: 'acknowledged',
    entry: { commandId: load.command.commandId, command: load.command, state: 'acknowledged' },
  });
  const liveSnapshot = readyOutputSnapshot({
    lease: {
      epoch: 4,
      leaseTarget: 'obs-player',
      clientKind: 'obs-browser-source',
      status: 'audible',
      switchId: 'active-switch',
    },
    activeFamily: { entryId: load.command.entryId, runId: load.command.runId },
    desiredTransport: {
      status: 'playing',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 9,
    },
    confirmedPlayback: {
      status: 'playing',
      playerInstanceId: 'obs-player',
      leaseEpoch: 4,
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 9,
      paused: false,
    },
  });
  connection.frame(liveSnapshot);
  assert.equal(coordinator.snapshot().activeRun.observed, true);

  connection.lose();
  coordinator.connect();
  connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
  connection.frame(liveSnapshot);

  assert.equal(coordinator.snapshot().unknown, false);
  assert.equal(coordinator.snapshot().unknownLock, null);
  assert.equal(coordinator.snapshot().activeRun.runId, load.command.runId);
  assert.equal(connection.commands.length, 1, 'reconnect itself never replays LOAD or PLAY');

  coordinator.pause();
  assert.equal(connection.commands.length, 2);
  assert.equal(connection.commands.at(-1).type, 'pause');
});

test('malformed player snapshot locks unknown and cannot be repaired by a later valid snapshot', () => {
  const { coordinator, connection } = createHarness({ snapshot: null });
  connection.frame({
    ...playerSnapshot(),
    lease: { epoch: -1 },
  });
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID);
  connection.frame(playerSnapshot());
  assertCoordinatorError(
    () => coordinator.activateOutput('obs'),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 0);
});

test('command rejection clears local pending switch or LOAD identity without inventing success', () => {
  const activationHarness = createHarness();
  const activation = activationHarness.coordinator.activateOutput('obs');
  activationHarness.connection.result({
    status: 'rejected',
    entry: { commandId: activation.command.commandId, command: activation.command, state: 'rejected' },
  });
  assert.equal(activationHarness.coordinator.snapshot().pendingSwitch, null);

  const runHarness = createHarness({ snapshot: readyOutputSnapshot() });
  const load = runHarness.coordinator.load({ song: { id: 'song-a', type: 'local' } });
  runHarness.connection.result({
    status: 'rejected',
    entry: { commandId: load.command.commandId, command: load.command, state: 'rejected' },
  });
  assert.equal(runHarness.coordinator.snapshot().activeRun, null);
  assert.equal(runHarness.coordinator.snapshot().unknown, false);
});

test('desired transport identifiers never create or adopt a run without activeFamily', () => {
  const { coordinator, connection } = createHarness({
    snapshot: readyOutputSnapshot({
      desiredTransport: {
        status: 'playing',
        entryId: 'stale-entry',
        runId: 'stale-run',
        position: 20,
        volume: 80,
      },
      confirmedPlayback: {
        status: 'playing',
        entryId: 'stale-entry',
        runId: 'stale-run',
        playerInstanceId: 'obs-player',
        leaseEpoch: 4,
      },
    }),
  });

  assert.equal(coordinator.snapshot().unknown, false);
  assert.equal(coordinator.snapshot().activeRun, null);
  const load = coordinator.load({ song: { id: 'authoritative-new-load', type: 'local' } });
  assert.notEqual(load.command.entryId, 'stale-entry');
  assert.equal(connection.commands.length, 1);
});

test('LOAD cannot be duplicated and STOP clears the local run only after exact strong-stop proof', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const load = coordinator.load({ song: { id: 'stop-proof-song', type: 'local' } });
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'duplicate-song', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.LOAD_ALREADY_ACTIVE,
  );

  connection.frame(readyOutputSnapshot({
    activeFamily: { entryId: load.command.entryId, runId: load.command.runId },
    desiredTransport: {
      status: 'loading',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 0,
      volume: 100,
    },
    confirmedPlayback: {
      status: 'unknown',
      reasonCode: 'load_not_confirmed',
      entryId: load.command.entryId,
      runId: load.command.runId,
      playerInstanceId: 'obs-player',
      leaseEpoch: 4,
    },
  }));
  const stop = coordinator.stop();
  assert.equal(stop.command.type, 'stop');
  assert.equal(stop.command.entryId, load.command.entryId);
  assert.equal(stop.command.runId, load.command.runId);

  connection.frame(readyOutputSnapshot({
    activeFamily: null,
    desiredTransport: {
      status: 'stopped',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 0,
      volume: 100,
    },
    confirmedPlayback: {
      status: 'stopped',
      reasonCode: 'stop_command_applied',
      entryId: load.command.entryId,
      runId: load.command.runId,
      playerInstanceId: 'obs-player',
      leaseEpoch: 4,
      position: 0,
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  }));
  assert.equal(coordinator.snapshot().activeRun, null);
  const nextLoad = coordinator.load({ song: { id: 'next-song', type: 'local' } });
  assert.notEqual(nextLoad.command.runId, load.command.runId);
  assert.equal(connection.commands.length, 3);
});

test('LOAD then deactivation completion clears work before a new output activation', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const load = coordinator.load({ song: { id: 'route-change-song', type: 'local' } });
  connection.frame(readyOutputSnapshot({
    activeFamily: { entryId: load.command.entryId, runId: load.command.runId },
    desiredTransport: {
      status: 'paused',
      entryId: load.command.entryId,
      runId: load.command.runId,
      position: 0,
      volume: 100,
    },
  }));

  const deactivation = coordinator.deactivateOutput();
  assert.equal(deactivation.command.type, 'deactivate_output');
  connection.frame(playerSnapshot({
    selectedOutputMode: null,
    activeFamily: null,
    lease: {
      epoch: 4,
      leaseTarget: null,
      clientKind: null,
      status: 'inactive',
      switchId: null,
    },
  }));
  assert.equal(coordinator.snapshot().activeRun, null);
  assert.equal(coordinator.snapshot().pendingSwitch, null);

  const activation = coordinator.activateOutput('speaker');
  assert.equal(activation.command.targetPlayerInstanceId, 'speaker-player');
  assert.equal(activation.command.leaseEpoch, 4);
  assert.equal(connection.commands.length, 3);
});

test('failed deactivation releases its pending operation and retries explicitly with a new switchId', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const first = coordinator.deactivateOutput();
  connection.result({
    status: 'outcome_unknown',
    retryAllowed: false,
    entry: {
      commandId: first.command.commandId,
      command: first.command,
      state: 'outcome_unknown',
    },
  });
  connection.frame(readyOutputSnapshot({
    lease: {
      epoch: 4,
      leaseTarget: 'obs-player',
      clientKind: 'obs-browser-source',
      status: 'unknown',
      switchId: first.command.switchId,
    },
  }));

  assert.equal(coordinator.snapshot().unknown, true);
  assert.equal(coordinator.snapshot().pendingSwitch, null);
  const retry = coordinator.deactivateOutput();
  assert.equal(validateOnAirMessage(retry.command).ok, true);
  assert.notEqual(retry.command.switchId, first.command.switchId);
  assert.equal(retry.command.targetPlayerInstanceId, first.command.targetPlayerInstanceId);
  assert.equal(retry.command.leaseEpoch, first.command.leaseEpoch);
  assert.equal(connection.commands.length, 2);
});

test('activating and deactivating observations both permit an exact safety deactivation', () => {
  for (const status of ['activating', 'deactivating']) {
    const { coordinator, connection } = createHarness({
      snapshot: readyOutputSnapshot({
        lease: {
          epoch: 4,
          leaseTarget: 'obs-player',
          clientKind: 'obs-browser-source',
          status,
          switchId: `${status}-switch`,
        },
      }),
    });
    const deactivation = coordinator.deactivateOutput();
    assert.equal(deactivation.command.targetPlayerInstanceId, 'obs-player');
    assert.equal(deactivation.command.leaseEpoch, 4);
    assert.notEqual(deactivation.command.switchId, `${status}-switch`);
    assert.equal(connection.commands.length, 1);
  }
});

test('startTest refuses an explicitly active OBS stream before creating a command', () => {
  const snapshot = readyOutputSnapshot();
  snapshot.players[0].runtime.streaming = true;
  const { coordinator, connection } = createHarness({ snapshot });

  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_STREAMING_ACTIVE,
  );
  assert.equal(connection.commands.length, 0);
  assert.equal(coordinator.snapshot().pendingTest, null);
});

test('startTest refuses an unobserved OBS streaming state before creating a command', () => {
  const snapshot = readyOutputSnapshot();
  snapshot.players[0].runtime.streamingStatusObserved = false;
  const { coordinator, connection } = createHarness({ snapshot });

  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_STREAMING_STATUS_UNKNOWN,
  );
  assert.equal(connection.commands.length, 0);
  assert.equal(coordinator.snapshot().pendingTest, null);
});

test('test commands use exact check and lease identities while activeCheck gates ordinary work', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const start = coordinator.startTest();
  assert.equal(validateOnAirMessage(start.command).ok, true);
  assert.equal(start.command.type, 'start_test');
  assert.equal(start.command.payload.fixtureId, 'pcm-pulse-v1');
  assert.equal(start.command.payload.durationMs, 8000);
  assert.equal(start.command.targetPlayerInstanceId, 'obs-player');
  assert.equal(start.command.leaseEpoch, 4);
  assert.equal(start.command.controlEpoch, 3);
  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_COMMAND_PENDING,
  );
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'blocked-by-pending-test', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
  );

  connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
  assert.equal(coordinator.snapshot().pendingTest, null);
  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_ALREADY_ACTIVE,
  );
  assertCoordinatorError(
    () => coordinator.play(),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
  );
  const stop = coordinator.stopTest();
  assert.equal(validateOnAirMessage(stop.command).ok, true);
  assert.equal(stop.command.type, 'stop_test');
  assert.equal(stop.command.checkId, start.command.checkId);
  assert.equal(stop.command.targetPlayerInstanceId, start.command.targetPlayerInstanceId);
  assert.equal(stop.command.leaseEpoch, start.command.leaseEpoch);
  assert.equal(stop.command.controlEpoch, start.command.controlEpoch);

  connection.result({
    status: 'acknowledged',
    entry: { commandId: stop.command.commandId, command: stop.command, state: 'acknowledged' },
  });
  assert.equal(coordinator.snapshot().pendingTest.operation, 'stop');
  connection.frame(readyOutputSnapshot({ activeCheckId: null }));
  assert.equal(coordinator.snapshot().pendingTest.operation, 'stop');
  assert.equal(coordinator.snapshot().testEvidence.requested.pendingOperation, 'stop');
  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_COMMAND_PENDING,
  );
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    checkId: start.command.checkId,
    commandId: stop.command.commandId,
    sequence: 6,
    code: 'playback_adapter_test_cancelled',
    detail: { reason: 'explicit_stop', safetyStopped: true },
    safetyPostcondition: strongStoppedTestPostcondition,
  }));
  assert.equal(coordinator.snapshot().testEvidence.lastTerminal.startedObserved, false);
  assert.equal(coordinator.snapshot().pendingTest, null);
  const restarted = coordinator.startTest({ fixtureId: 'custom-pulse', durationMs: 1000 });
  assert.equal(restarted.command.payload.fixtureId, 'custom-pulse');
  assert.notEqual(restarted.command.checkId, start.command.checkId);
});

test('pre-start cancellation remains authoritative when its event arrives before ACK and snapshot', () => {
  const { coordinator, connection, start, stop } = beginPreStartStop();
  connection.frame(exactCancellationEvent(start, stop));
  const accepted = coordinator.snapshot().testEvidence;
  assert.equal(accepted.started, null);
  assert.equal(accepted.lastTerminal.checkId, start.command.checkId);
  assert.equal(accepted.lastTerminal.commandId, stop.command.commandId);
  assert.equal(accepted.lastTerminal.code, 'playback_adapter_test_cancelled');
  assert.equal(accepted.lastTerminal.startedObserved, false);
  assert.deepEqual(accepted.lastTerminal.safetyPostcondition, strongStoppedTestPostcondition);

  connection.result({
    status: 'acknowledged',
    entry: { commandId: stop.command.commandId, command: stop.command, state: 'acknowledged' },
  });
  connection.frame(readyOutputSnapshot({ activeCheckId: null }));
  assert.deepEqual(coordinator.snapshot().testEvidence.lastTerminal, accepted.lastTerminal);
});

test('pre-start cancellation rejects every mismatched stop identity without promoting a terminal', () => {
  const scenarios = [
    { name: 'checkId', overrides: { checkId: 'foreign-check' } },
    { name: 'commandId', overrides: { commandId: 'foreign-stop-command' } },
    { name: 'playerInstanceId', overrides: { playerInstanceId: 'foreign-player' } },
    { name: 'leaseEpoch', overrides: { leaseEpoch: 5 } },
    { name: 'connectionId', overrides: { connectionId: 'foreign-player-connection' } },
  ];
  for (const scenario of scenarios) {
    const { coordinator, connection, start, stop } = beginPreStartStop();
    connection.frame(exactCancellationEvent(start, stop, scenario.overrides));
    assert.equal(
      coordinator.snapshot().testEvidence.lastTerminal,
      null,
      scenario.name,
    );
  }
});

test('pre-start cancellation requires its exact code and complete strong-stop postcondition', () => {
  const scenarios = [
    { name: 'wrong code', overrides: { code: 'fixture_test_failed' } },
    { name: 'missing safety', overrides: { safetyPostcondition: undefined } },
    {
      name: 'false safety field',
      overrides: {
        safetyPostcondition: { ...strongStoppedTestPostcondition, audible: true },
      },
    },
  ];
  for (const scenario of scenarios) {
    const { coordinator, connection, start, stop } = beginPreStartStop();
    const frame = exactCancellationEvent(start, stop, scenario.overrides);
    if (scenario.overrides.safetyPostcondition === undefined) delete frame.safetyPostcondition;
    connection.frame(frame);
    assert.equal(
      coordinator.snapshot().testEvidence.lastTerminal,
      null,
      scenario.name,
    );
  }
});

test('rejected STOP, reconnect, and route replacement each retire the pre-start stop intent', () => {
  {
    const { coordinator, connection, start, stop } = beginPreStartStop();
    connection.result({
      status: 'rejected',
      entry: { commandId: stop.command.commandId, command: stop.command, state: 'rejected' },
    });
    connection.frame(exactCancellationEvent(start, stop));
    assert.equal(coordinator.snapshot().testEvidence.lastTerminal, null);
    connection.frame(readyOutputSnapshot({ activeCheckId: null }));
    assert.doesNotThrow(() => coordinator.startTest());
  }

  {
    const { coordinator, connection, start, stop } = beginPreStartStop();
    connection.lose('cancel_intent_reconnect');
    coordinator.connect();
    connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
    connection.frame(readyOutputSnapshot());
    connection.frame(exactCancellationEvent(start, stop));
    assert.equal(coordinator.snapshot().testEvidence.lastTerminal, null);
  }

  {
    const { coordinator, connection, start, stop } = beginPreStartStop();
    connection.frame(readyOutputSnapshot({
      players: [{
        playerInstanceId: 'replacement-player',
        connectionId: 'replacement-connection',
        clientKind: 'obs-browser-source',
        state: 'ready',
        lastSeenAt: 2_000,
        heartbeatStale: false,
        buildId: 'replacement-build',
        capabilities: { obsRuntime: true },
        runtime: {
          sourceActive: true,
          streaming: false,
          streamingStatusObserved: true,
        },
      }],
      eligibleCandidates: { obs: ['replacement-player'] },
      lease: {
        epoch: 5,
        leaseTarget: 'replacement-player',
        clientKind: 'obs-browser-source',
        status: 'ready',
        switchId: 'replacement-switch',
      },
      activeCheckId: null,
    }));
    connection.frame(exactCancellationEvent(start, stop));
    assert.equal(coordinator.snapshot().testEvidence.lastTerminal, null);
    assert.doesNotThrow(() => coordinator.startTest());
  }
});

test('accepted pre-start cancellation is one-shot and duplicate replay cannot overwrite it', () => {
  const { coordinator, connection, start, stop } = beginPreStartStop();
  const acceptedFrame = exactCancellationEvent(start, stop);
  connection.frame(acceptedFrame);
  const accepted = coordinator.snapshot().testEvidence.lastTerminal;

  connection.frame(acceptedFrame);
  connection.frame(exactCancellationEvent(start, stop, {
    eventId: 'test-event-replayed-with-different-detail',
    sequence: 7,
    detail: { reason: 'replayed_terminal', safetyStopped: true },
  }));
  const afterReplay = coordinator.snapshot();
  assert.deepEqual(afterReplay.testEvidence.lastTerminal, accepted);
  assert.ok(afterReplay.diagnostics.some((diagnostic) => (
    diagnostic.code === ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE
  )));
});

test('terminal evidence records whether actual playback start was observed', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const start = coordinator.startTest();
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 10,
  }));
  const stop = coordinator.stopTest();
  connection.frame(exactCancellationEvent(start, stop, { sequence: 11 }));
  const terminal = coordinator.snapshot().testEvidence.lastTerminal;
  assert.equal(terminal.startedObserved, true);
  assert.equal(terminal.code, 'playback_adapter_test_cancelled');
  assert.equal(coordinator.snapshot().testEvidence.markers.length, 0);
});

test('a new test clears old success evidence before an immediate pre-start cancellation', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const completedStart = coordinator.startTest();
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: completedStart.command.checkId,
    sequence: 10,
  }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: completedStart.command.checkId,
    sequence: 20,
    markerIndex: 0,
    markerTimeMs: 250,
  }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
    checkId: completedStart.command.checkId,
    sequence: 11,
    markerCount: 1,
  }));
  assert.equal(coordinator.snapshot().testEvidence.lastTerminal.startedObserved, true);

  const nextStart = coordinator.startTest();
  const pending = coordinator.snapshot().testEvidence;
  assert.equal(pending.lastTerminal, null);
  assert.equal(pending.markers.length, 0);
  assert.equal(pending.started, null);
  connection.frame(readyOutputSnapshot({ activeCheckId: nextStart.command.checkId }));
  const nextStop = coordinator.stopTest();
  connection.frame(exactCancellationEvent(nextStart, nextStop, { sequence: 30 }));
  const cancelled = coordinator.snapshot().testEvidence;
  assert.equal(cancelled.lastTerminal.checkId, nextStart.command.checkId);
  assert.equal(cancelled.lastTerminal.startedObserved, false);
  assert.equal(cancelled.lastTerminal.code, 'playback_adapter_test_cancelled');
  assert.equal(cancelled.markers.length, 0);
});

test('test fixture duration rejects sub-fixture values and accepts the exact shared minimum', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  assert.throws(
    () => coordinator.startTest({ durationMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS - 1 }),
    (error) => {
      assert.equal(error?.code, ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT);
      assert.equal(error?.detail?.minDurationMs, ON_AIR_TEST_FIXTURE_MIN_DURATION_MS);
      return true;
    },
  );
  assertCoordinatorError(
    () => coordinator.startTest({ durationMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS + 0.5 }),
    ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
  );
  assert.equal(connection.commands.length, 0);

  const accepted = coordinator.startTest({
    durationMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
  });
  assert.equal(accepted.command.payload.durationMs, ON_AIR_TEST_FIXTURE_MIN_DURATION_MS);
  assert.equal(connection.commands.length, 1);
});

test('test evidence keeps requested state separate from an actually observed start and terminal proof', () => {
  const observed = [];
  const { coordinator, connection } = createHarness({
    snapshot: readyOutputSnapshot(),
    callbacks: {
      onTestEvent(payload) {
        observed.push(payload);
        if (payload.event.event === TEST_EVENT_TYPES.TEST_MARKER) {
          throw new Error('observer failure must stay outside authority');
        }
      },
    },
  });
  const start = coordinator.startTest();
  const requested = coordinator.snapshot().testEvidence;
  assert.equal(requested.requested.activeCheckId, null);
  assert.equal(requested.requested.effectiveActiveCheckId, null);
  assert.equal(requested.requested.pendingOperation, 'start');
  assert.equal(requested.requested.pendingCheckId, start.command.checkId);
  assert.equal(requested.started, null);

  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 10,
  }));
  const started = coordinator.snapshot();
  assert.equal(started.playerSnapshot.activeCheckId, null, 'raw snapshot remains distinct');
  assert.equal(started.pendingTest, null);
  assert.equal(started.testEvidence.requested.activeCheckId, null);
  assert.equal(
    started.testEvidence.requested.effectiveActiveCheckId,
    start.command.checkId,
  );
  assert.equal(started.testEvidence.started.checkId, start.command.checkId);
  assert.equal(started.testEvidence.started.event, TEST_EVENT_TYPES.TEST_STARTED);
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'blocked-by-actual-test', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
  );

  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: start.command.checkId,
    sequence: 20,
    markerIndex: 0,
    markerTimeMs: 250,
    rmsDbfs: -18.5,
    peakDbfs: -4.25,
  }));
  assert.equal(coordinator.snapshot().testEvidence.markers.length, 1);
  assert.equal(coordinator.snapshot().testEvidence.markers[0].rmsDbfs, -18.5);

  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
    checkId: start.command.checkId,
    sequence: 11,
    markerCount: 1,
  }));
  const completed = coordinator.snapshot().testEvidence;
  assert.equal(completed.started, null);
  assert.equal(completed.markers.length, 1);
  assert.equal(completed.lastTerminal.event, TEST_EVENT_TYPES.TEST_COMPLETE);
  assert.equal(completed.lastTerminal.postcondition.stopped, true);
  assert.deepEqual(completed.lastSequences, {
    [ON_AIR_SEQUENCE_NAMESPACES.TEST]: 11,
    [ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY]: 20,
  });
  assert.equal(observed.length, 3);
  assert.ok(observed.every(Object.isFrozen));

  const load = coordinator.load({
    entryId: 'post-test-entry',
    runId: 'post-test-run',
    song: { id: 'post-test-song', type: 'local' },
  });
  assert.equal(load.command.entryId, 'post-test-entry');
});

test('terminal override requires the exact sole current connection for the leased player', () => {
  const routeScenarios = [
    {
      name: 'leased player is absent from players',
      players: [],
    },
    {
      name: 'same player instance has a new connection',
      players: [{
        ...readyOutputSnapshot().players[0],
        connectionId: 'obs-connection-new',
      }],
    },
    {
      name: 'same player instance has ambiguous connections',
      players: [
        readyOutputSnapshot().players[0],
        {
          ...readyOutputSnapshot().players[0],
          connectionId: 'obs-connection-new',
        },
      ],
    },
  ];

  for (const scenario of routeScenarios) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    const start = coordinator.startTest();
    connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
      checkId: start.command.checkId,
      sequence: 10,
    }));
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
      checkId: start.command.checkId,
      sequence: 20,
      markerIndex: 0,
      markerTimeMs: 250,
    }));
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
      checkId: start.command.checkId,
      sequence: 11,
      markerCount: 1,
    }));

    const exactRoute = coordinator.snapshot().testEvidence.requested;
    assert.equal(exactRoute.activeCheckId, start.command.checkId, scenario.name);
    assert.equal(exactRoute.effectiveActiveCheckId, null, scenario.name);

    connection.frame(readyOutputSnapshot({
      activeCheckId: start.command.checkId,
      players: scenario.players,
    }));
    const replacedRoute = coordinator.snapshot().testEvidence.requested;
    assert.equal(replacedRoute.activeCheckId, start.command.checkId, scenario.name);
    assert.equal(
      replacedRoute.effectiveActiveCheckId,
      start.command.checkId,
      scenario.name,
    );
    assertCoordinatorError(
      () => coordinator.startTest(),
      ON_AIR_CONTROL_COORDINATOR_CODES.TEST_ALREADY_ACTIVE,
    );
  }
});

test('test_failed records terminal evidence but only a proven safety stop releases stale activeCheck', () => {
  const strongStopped = {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  };
  for (const scenario of [
    { name: 'explicit false', detail: { phase: 'fixture', safetyStopped: false }, safe: false },
    { name: 'legacy boolean-only true', detail: { phase: 'fixture', safetyStopped: true }, safe: false },
    {
      name: 'typed physical proof',
      detail: { phase: 'fixture', safetyStopped: true },
      safetyPostcondition: strongStopped,
      safe: true,
    },
  ]) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    const start = coordinator.startTest();
    connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
      checkId: start.command.checkId,
      sequence: 4,
    }));
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_FAILED, {
      checkId: start.command.checkId,
      sequence: 5,
      detail: scenario.detail,
      ...(scenario.safetyPostcondition
        ? { safetyPostcondition: scenario.safetyPostcondition }
        : {}),
    }));

    const evidence = coordinator.snapshot().testEvidence;
    assert.equal(evidence.started, null);
    assert.equal(evidence.lastTerminal.event, TEST_EVENT_TYPES.TEST_FAILED);
    assert.equal(evidence.lastTerminal.code, 'fixture_test_failed');
    assert.equal(evidence.lastTerminal.detail.safetyStopped, scenario.detail.safetyStopped);
    assert.equal(evidence.requested.activeCheckId, start.command.checkId);
    assert.equal(
      evidence.requested.effectiveActiveCheckId,
      scenario.safe ? null : start.command.checkId,
    );

    if (!scenario.safe) {
      assertCoordinatorError(
        () => coordinator.load({ song: { id: `unsafe-${scenario.name}`, type: 'local' } }),
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
      );
      assert.equal(connection.commands.length, 1);
    } else {
      assert.deepEqual(evidence.lastTerminal.safetyPostcondition, strongStopped);
      const load = coordinator.load({ song: { id: 'safe-after-failure', type: 'local' } });
      assert.equal(load.command.type, 'load');
      assert.equal(connection.commands.length, 2);
    }
  }
});

test('unsafe test failure reconciles the Worker unknown snapshot and leaves only explicit deactivation', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const start = coordinator.startTest();
  connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 4,
  }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    checkId: start.command.checkId,
    sequence: 5,
    detail: { phase: 'fixture', safetyStopped: false },
  }));
  connection.frame(readyOutputSnapshot({
    activeCheckId: null,
    lease: {
      epoch: 4,
      leaseTarget: 'obs-player',
      clientKind: 'obs-browser-source',
      status: 'unknown',
      switchId: 'active-switch',
    },
    confirmedPlayback: {
      status: 'unknown',
      reasonCode: 'test_safety_stop_failed',
      code: 'fixture_test_failed',
    },
    desiredTransport: { status: 'unknown' },
  }));

  const reconciled = coordinator.snapshot();
  assert.equal(reconciled.playerSnapshot.activeCheckId, null);
  assert.equal(reconciled.playerSnapshot.lease.status, 'unknown');
  assert.equal(reconciled.testEvidence.started, null);
  assert.equal(reconciled.testEvidence.lastTerminal.event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(reconciled.authorityUnknown, false);
  assert.equal(reconciled.routeUnknown, true);
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'blocked-after-unsafe-test', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_NOT_READY,
  );
  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_NOT_READY,
  );
  const deactivation = coordinator.deactivateOutput();
  assert.equal(deactivation.command.type, 'deactivate_output');
  assert.equal(deactivation.command.targetPlayerInstanceId, 'obs-player');
});

test('test markers are bounded and stale sequence or marker order never promotes evidence', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const start = coordinator.startTest();
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 10,
  }));

  for (let markerIndex = 0; markerIndex < 70; markerIndex += 1) {
    connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
      checkId: start.command.checkId,
      sequence: markerIndex,
      markerIndex,
      markerTimeMs: markerIndex * 100,
    }));
  }
  const bounded = coordinator.snapshot().testEvidence;
  assert.equal(bounded.markers.length, 64);
  assert.equal(bounded.markers[0].markerIndex, 6);
  assert.equal(bounded.markers.at(-1).markerIndex, 69);

  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: start.command.checkId,
    sequence: 69,
    markerIndex: 70,
    markerTimeMs: 7_000,
  }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: start.command.checkId,
    sequence: 70,
    markerIndex: 69,
    markerTimeMs: 7_100,
  }));
  const afterStale = coordinator.snapshot();
  assert.equal(afterStale.testEvidence.markers.length, 64);
  assert.equal(afterStale.testEvidence.markers.at(-1).markerIndex, 69);
  assert.deepEqual(afterStale.testEvidence.lastSequences, {
    [ON_AIR_SEQUENCE_NAMESPACES.TEST]: 10,
    [ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY]: 69,
  });
  assert.ok(afterStale.diagnostics.some((diagnostic) => (
    diagnostic.code === ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE
  )));
});

test('test evidence locks inconclusive on sequence gaps, marker gaps, or marker-count disagreement', () => {
  const scenarios = [
    {
      name: 'durable sequence gap',
      frames: (checkId) => [
        testEvent(TEST_EVENT_TYPES.TEST_STARTED, { checkId, sequence: 10 }),
        testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
          checkId,
          sequence: 12,
          markerCount: 0,
        }),
      ],
    },
    {
      name: 'first marker is not zero',
      frames: (checkId) => [
        testEvent(TEST_EVENT_TYPES.TEST_STARTED, { checkId, sequence: 10 }),
        testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
          checkId,
          sequence: 20,
          markerIndex: 1,
          markerTimeMs: 250,
        }),
      ],
    },
    {
      name: 'marker index skips forward',
      frames: (checkId) => [
        testEvent(TEST_EVENT_TYPES.TEST_STARTED, { checkId, sequence: 10 }),
        testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
          checkId,
          sequence: 20,
          markerIndex: 0,
          markerTimeMs: 250,
        }),
        testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
          checkId,
          sequence: 21,
          markerIndex: 2,
          markerTimeMs: 500,
        }),
      ],
    },
    {
      name: 'terminal marker count disagrees',
      frames: (checkId) => [
        testEvent(TEST_EVENT_TYPES.TEST_STARTED, { checkId, sequence: 10 }),
        testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
          checkId,
          sequence: 20,
          markerIndex: 0,
          markerTimeMs: 250,
        }),
        testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
          checkId,
          sequence: 11,
          markerCount: 2,
        }),
      ],
    },
  ];

  for (const scenario of scenarios) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    const start = coordinator.startTest();
    for (const frame of scenario.frames(start.command.checkId)) connection.frame(frame);
    const state = coordinator.snapshot();
    assert.equal(
      state.unknownLock.code,
      ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVIDENCE_INTEGRITY,
      scenario.name,
    );
    assert.equal(state.testEvidence.lastTerminal, null, scenario.name);
    assertCoordinatorError(
      () => coordinator.load({ song: { id: scenario.name, type: 'local' } }),
      ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
    );
  }
});

test('malformed, mismatched, or terminal-without-start test events never become evidence', () => {
  const malformed = createHarness({ snapshot: readyOutputSnapshot() });
  const malformedStart = malformed.coordinator.startTest();
  const invalidMarker = testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: malformedStart.command.checkId,
    sequence: 1,
  });
  delete invalidMarker.markerIndex;
  malformed.connection.frame(invalidMarker);
  assert.equal(malformed.coordinator.snapshot().testEvidence.started, null);
  assert.equal(malformed.coordinator.snapshot().testEvidence.markers.length, 0);
  assert.ok(malformed.coordinator.snapshot().diagnostics.some((diagnostic) => (
    diagnostic.code === ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_INVALID
  )));

  malformed.connection.frame(testEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
    checkId: malformedStart.command.checkId,
    sequence: 2,
  }));
  assert.equal(malformed.coordinator.snapshot().testEvidence.lastTerminal, null);
  assert.ok(malformed.coordinator.snapshot().diagnostics.some((diagnostic) => (
    diagnostic.code === ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_WITHOUT_START
  )));

  const mismatch = createHarness({ snapshot: readyOutputSnapshot() });
  const mismatchStart = mismatch.coordinator.startTest();
  mismatch.connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: mismatchStart.command.checkId,
    sequence: 1,
  }));
  mismatch.connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: 'foreign-check',
    sequence: 2,
  }));
  const mismatchedState = mismatch.coordinator.snapshot();
  assert.equal(
    mismatchedState.unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_IDENTITY_MISMATCH,
  );
  assert.equal(mismatchedState.testEvidence.markers.length, 0);
});

test('reconnect resets and fences test evidence without resuming or replaying a test', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const start = coordinator.startTest();
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    checkId: start.command.checkId,
    sequence: 10,
  }));
  const firstGeneration = coordinator.snapshot().testEvidence.generation;
  assert.equal(coordinator.snapshot().testEvidence.started.checkId, start.command.checkId);

  connection.lose();
  assert.equal(coordinator.snapshot().testEvidence.started, null);
  coordinator.connect();
  connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
  const secondGeneration = coordinator.snapshot().testEvidence.generation;
  assert.ok(secondGeneration > firstGeneration);

  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: start.command.checkId,
    sequence: 11,
  }));
  assert.equal(coordinator.snapshot().testEvidence.markers.length, 0);
  connection.frame(readyOutputSnapshot({ activeCheckId: start.command.checkId }));
  connection.frame(testEvent(TEST_EVENT_TYPES.TEST_MARKER, {
    checkId: start.command.checkId,
    sequence: 12,
  }));
  const state = coordinator.snapshot();
  assert.equal(state.testEvidence.started, null);
  assert.equal(state.testEvidence.markers.length, 0);
  assert.equal(state.unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST);
  assert.equal(connection.commands.length, 1, 'reconnect never resends the start command');
});

test('activeCheck blocks LOAD/new test but never blocks explicit output deactivation', () => {
  const { coordinator, connection } = createHarness({
    snapshot: readyOutputSnapshot({ activeCheckId: 'server-active-check' }),
  });
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'blocked-by-active-check', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
  );
  assertCoordinatorError(
    () => coordinator.startTest(),
    ON_AIR_CONTROL_COORDINATOR_CODES.TEST_ALREADY_ACTIVE,
  );
  const deactivation = coordinator.deactivateOutput();
  assert.equal(deactivation.command.type, 'deactivate_output');
  assert.equal(deactivation.command.targetPlayerInstanceId, 'obs-player');
  assert.equal(connection.commands.length, 1);
});

test('end_session is rejected while run, test, or output transition work can still be audible', () => {
  const activeRun = createHarness({ snapshot: readyOutputSnapshot() });
  activeRun.coordinator.load({
    entryId: 'end-guard-entry',
    runId: 'end-guard-run',
    song: { id: 'end-guard-song', type: 'local' },
  });
  assertCoordinatorError(
    () => activeRun.coordinator.endSession(),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
  );
  assert.equal(activeRun.connection.commands.length, 1, 'only LOAD reached the wire');

  const activeTest = createHarness({
    snapshot: readyOutputSnapshot({ activeCheckId: 'server-active-check' }),
  });
  assertCoordinatorError(
    () => activeTest.coordinator.endSession(),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
  );
  assert.equal(activeTest.connection.commands.length, 0);

  const transition = createHarness({
    snapshot: playerSnapshot({
      selectedOutputMode: 'obs',
      lease: {
        epoch: 4,
        leaseTarget: 'obs-player',
        clientKind: 'obs-browser-source',
        status: 'activating',
        switchId: 'activating-switch',
      },
    }),
  });
  assertCoordinatorError(
    () => transition.coordinator.endSession(),
    ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
  );
  assert.equal(transition.connection.commands.length, 0);
});

test('session_ended is a sticky terminal fence that closes control and blocks later commands', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  connection.frame({
    type: SERVER_MESSAGE_TYPES.SESSION_ENDED,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    reasonCode: 'explicit_end_session',
    cleanupAt: 1_753_000_000_000,
  });

  const state = coordinator.snapshot();
  assert.equal(connection.closed, true);
  assert.equal(state.ready, false);
  assert.equal(state.unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED);
  assertCoordinatorError(
    () => coordinator.prefetch(['dQw4w9WgXcQ']),
    ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
  );
  assertCoordinatorError(
    () => coordinator.connect(),
    ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
  );
  assert.equal(connection.commands.length, 0);
});

test('auxiliary APIs send exact epoch-guarded frames through the shared command ledger', () => {
  const display = { currentSong: null, history: [{ id: 'song-a', title: 'Fixture' }] };
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const ended = coordinator.endSession();
  const published = coordinator.publishDisplayState(display);
  const prefetched = coordinator.prefetch(['dQw4w9WgXcQ', '9bZkp7q19f0']);

  assert.deepEqual(ended.command, {
    type: AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION,
    commandId: ended.command.commandId,
    controlEpoch: 3,
    payload: {},
  });
  assert.deepEqual(published.command, {
    type: AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    commandId: published.command.commandId,
    controlEpoch: 3,
    payload: { display },
  });
  assert.deepEqual(prefetched.command, {
    type: AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
    commandId: prefetched.command.commandId,
    controlEpoch: 3,
    payload: { videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'] },
  });
  for (const command of connection.commands) {
    assert.equal(validateOnAirMessage(command).ok, true, JSON.stringify(command));
    assert.equal(Object.hasOwn(command, 'leaseEpoch'), false);
    assert.equal(Object.hasOwn(command, 'entryId'), false);
    assert.equal(Object.hasOwn(command, 'targetPlayerInstanceId'), false);
  }
  assert.deepEqual(
    coordinator.snapshot().pendingCommandIds,
    connection.commands.map((command) => command.commandId),
  );

  for (const command of connection.commands) {
    connection.result({
      status: 'acknowledged',
      entry: { commandId: command.commandId, command, state: 'acknowledged' },
    });
  }
  assert.deepEqual(coordinator.snapshot().pendingCommandIds, []);
  assert.equal(connection.commands.length, 3, 'acknowledgement never retries an auxiliary command');
});

test('auxiliary APIs reject malformed values without coercion or ledger entries', () => {
  for (const invoke of [
    (coordinator) => coordinator.endSession({ reason: 'client-owned-reason-is-forbidden' }),
    (coordinator) => coordinator.publishDisplayState(null),
    (coordinator) => coordinator.publishDisplayState([]),
    (coordinator) => coordinator.prefetch('dQw4w9WgXcQ'),
    (coordinator) => coordinator.prefetch(['too-short']),
    (coordinator) => coordinator.prefetch([
      'dQw4w9WgXcQ',
      '9bZkp7q19f0',
      'J---aiyznGQ',
    ]),
  ]) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    assertCoordinatorError(
      () => invoke(coordinator),
      ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
    );
    assert.deepEqual(coordinator.snapshot().pendingCommandIds, []);
    assert.equal(connection.commands.length, 0);
  }
});

test('display state rejects non-JSON, cyclic, deep, and oversized values before ledger mutation', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let deep = { leaf: true };
  for (let depth = 0; depth < 14; depth += 1) deep = { child: deep };
  const invalidDisplays = [
    { value: undefined },
    { value: 1n },
    { value: Number.NaN },
    { value: new Date(0) },
    cyclic,
    deep,
    { text: 'x'.repeat(50 * 1_024) },
  ];

  for (const display of invalidDisplays) {
    const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
    assertCoordinatorError(
      () => coordinator.publishDisplayState(display),
      ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
    );
    assert.deepEqual(coordinator.snapshot().pendingCommandIds, []);
    assert.equal(coordinator.snapshot().unknownLock, null);
    assert.equal(connection.commands.length, 0);
  }
});

test('exact emergency proof aborts a source-loss started test without a fake terminal', () => {
  const { coordinator, connection, start } = beginStartedTest();
  connection.frame(readyOutputSnapshot({
    activeCheckId: start.command.checkId,
    lease: {
      epoch: 4,
      leaseTarget: 'obs-player',
      clientKind: 'obs-browser-source',
      status: 'unknown',
      switchId: 'active-switch',
    },
    desiredTransport: { status: 'unknown' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'target_source_inactive' },
  }));
  assert.equal(coordinator.snapshot().routeUnknown, true);
  const emergency = coordinator.emergencyStop();
  acknowledgeEmergencyCommand(connection, emergency.command);
  connection.frame(emergencySnapshot('emergency_stopping'));
  assert.equal(coordinator.snapshot().testEvidence.started.checkId, start.command.checkId);
  assert.equal(coordinator.snapshot().testEvidence.lastAbort, null);

  connection.frame(emergencyAcknowledgement(emergency.command));
  assert.equal(coordinator.snapshot().testEvidence.started.checkId, start.command.checkId);
  connection.frame(emergencySnapshot());

  const evidence = coordinator.snapshot().testEvidence;
  assert.equal(evidence.started, null);
  assert.equal(evidence.lastTerminal, null);
  assert.equal(evidence.lastAbort.outcome, 'aborted');
  assert.equal(evidence.lastAbort.reasonCode, 'emergency_stop_acknowledged');
  assert.equal(evidence.lastAbort.checkId, start.command.checkId);
  assert.equal(evidence.lastAbort.startedObserved, true);
  assert.equal(evidence.lastAbort.emergencyCommandId, emergency.command.commandId);
  assert.equal(evidence.lastAbort.playerInstanceId, 'obs-player');
  assert.equal(evidence.lastAbort.connectionId, 'obs-connection-a');
  assert.equal(evidence.lastAbort.leaseEpoch, 4);
  assert.equal(evidence.lastAbort.emergencyLeaseEpoch, 5);
  assert.deepEqual(evidence.lastAbort.safetyPostcondition, strongStoppedTestPostcondition);

  const ended = coordinator.endSession();
  assert.equal(ended.command.type, 'end_session');
});

test('emergency abort proof converges when final snapshot and player ACK precede command ACK', () => {
  const { coordinator, connection, start } = beginStartedTest();
  const emergency = coordinator.emergencyStop();
  connection.frame(emergencySnapshot());
  connection.frame(emergencyAcknowledgement(emergency.command));
  assert.equal(coordinator.snapshot().testEvidence.started.checkId, start.command.checkId);
  assert.equal(coordinator.snapshot().testEvidence.lastAbort, null);

  acknowledgeEmergencyCommand(connection, emergency.command);
  assert.equal(coordinator.snapshot().testEvidence.started, null);
  assert.equal(coordinator.snapshot().testEvidence.lastTerminal, null);
  assert.equal(coordinator.snapshot().testEvidence.lastAbort.outcome, 'aborted');
});

test('emergency abort remains active when any command, player, lease, or strong-stop proof is absent', () => {
  const scenarios = [
    {
      name: 'missing command ACK',
      apply({ connection, emergency }) {
        connection.frame(emergencyAcknowledgement(emergency.command));
        connection.frame(emergencySnapshot());
      },
    },
    {
      name: 'missing player ACK',
      apply({ connection, emergency }) {
        acknowledgeEmergencyCommand(connection, emergency.command);
        connection.frame(emergencySnapshot());
      },
    },
    {
      name: 'missing final strong-stop snapshot',
      apply({ connection, emergency }) {
        acknowledgeEmergencyCommand(connection, emergency.command);
        connection.frame(emergencyAcknowledgement(emergency.command));
        connection.frame(emergencySnapshot('emergency_stopping'));
      },
    },
    {
      name: 'wrong final lease epoch',
      apply({ connection, emergency }) {
        acknowledgeEmergencyCommand(connection, emergency.command);
        connection.frame(emergencyAcknowledgement(emergency.command));
        connection.frame(emergencySnapshot('inactive', { lease: { epoch: 6 } }));
      },
    },
    {
      name: 'non-strong final playback',
      apply({ connection, emergency }) {
        acknowledgeEmergencyCommand(connection, emergency.command);
        connection.frame(emergencyAcknowledgement(emergency.command));
        connection.frame(emergencySnapshot('inactive', {
          confirmedPlayback: {
            status: 'stopped',
            reasonCode: 'emergency_stop_acknowledged',
            paused: true,
            sourceDetached: true,
            autoplayCancelled: true,
            audible: true,
          },
        }));
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = beginStartedTest();
    const emergency = harness.coordinator.emergencyStop();
    scenario.apply({ ...harness, emergency });
    const evidence = harness.coordinator.snapshot().testEvidence;
    assert.equal(evidence.started.checkId, harness.start.command.checkId, scenario.name);
    assert.equal(evidence.lastAbort, null, scenario.name);
    assert.equal(evidence.lastTerminal, null, scenario.name);
    assertCoordinatorError(
      () => harness.coordinator.endSession(),
      ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
    );
  }
});

test('foreign, malformed, rejected, or terminal-raced emergency evidence cannot invent an abort', () => {
  const eventScenarios = [
    { name: 'commandId', overrides: { commandId: 'foreign-emergency-command' } },
    { name: 'sessionId', overrides: { sessionId: 'foreign-session' } },
    { name: 'playerInstanceId', overrides: { playerInstanceId: 'foreign-player' } },
    { name: 'connectionId', overrides: { connectionId: 'foreign-connection' } },
    {
      name: 'postcondition',
      overrides: {
        postcondition: {
          mediaPaused: true,
          sourceDetached: true,
          autoplayCancelled: false,
        },
      },
    },
  ];
  for (const scenario of eventScenarios) {
    const harness = beginStartedTest();
    const emergency = harness.coordinator.emergencyStop();
    acknowledgeEmergencyCommand(harness.connection, emergency.command);
    harness.connection.frame(emergencyAcknowledgement(emergency.command, scenario.overrides));
    harness.connection.frame(emergencySnapshot());
    assert.equal(harness.coordinator.snapshot().testEvidence.lastAbort, null, scenario.name);
    assert.equal(
      harness.coordinator.snapshot().testEvidence.started.checkId,
      harness.start.command.checkId,
      scenario.name,
    );
  }

  {
    const harness = beginStartedTest();
    const emergency = harness.coordinator.emergencyStop();
    harness.connection.result({
      status: 'rejected',
      entry: {
        commandId: emergency.command.commandId,
        command: emergency.command,
        state: 'rejected',
        result: { code: 'emergency_stop_rejected' },
      },
    });
    harness.connection.frame(emergencyAcknowledgement(emergency.command));
    harness.connection.frame(emergencySnapshot());
    assert.equal(harness.coordinator.snapshot().testEvidence.lastAbort, null);
    assert.equal(
      harness.coordinator.snapshot().testEvidence.started.checkId,
      harness.start.command.checkId,
    );
  }

  {
    const harness = beginStartedTest();
    const emergency = harness.coordinator.emergencyStop();
    harness.connection.frame(testEvent(TEST_EVENT_TYPES.TEST_FAILED, {
      checkId: harness.start.command.checkId,
      sequence: 11,
      code: 'fixture_test_failed',
      detail: { phase: 'emergency_race', safetyStopped: true },
      safetyPostcondition: strongStoppedTestPostcondition,
    }));
    const terminal = harness.coordinator.snapshot().testEvidence.lastTerminal;
    acknowledgeEmergencyCommand(harness.connection, emergency.command);
    harness.connection.frame(emergencyAcknowledgement(emergency.command));
    harness.connection.frame(emergencySnapshot());
    assert.deepEqual(harness.coordinator.snapshot().testEvidence.lastTerminal, terminal);
    assert.equal(harness.coordinator.snapshot().testEvidence.lastAbort, null);
  }
});

test('emergency stop remains single-shot under unknown lock with only session/control identity', () => {
  const { coordinator, connection } = createHarness({
    welcome: controlWelcome({ writable: false, writableControlInstanceId: null }),
    snapshot: readyOutputSnapshot({
      controlLease: {
        controlEpoch: 3,
        writableControlInstanceId: null,
        writableConnected: false,
      },
    }),
  });
  connection.frame({
    type: SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    desiredTransport: {},
  });
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID);

  const emergency = coordinator.emergencyStop();
  assert.equal(validateOnAirMessage(emergency.command).ok, true);
  assert.deepEqual(Object.keys(emergency.command).sort(), [
    'authenticatedControlInstanceId',
    'commandId',
    'sessionId',
    'type',
  ]);
  assert.equal(emergency.command.type, 'emergency_stop');
  assert.equal(emergency.command.sessionId, 'protocol-v2-room');
  assert.equal(emergency.command.authenticatedControlInstanceId, 'control-a');
  assert.equal(connection.commands.length, 1);
});

test('a user-confirmed full reset is explicit in the emergency payload', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const emergency = coordinator.emergencyStop({ forceReset: true });

  assert.equal(validateOnAirMessage(emergency.command).ok, true);
  assert.deepEqual(emergency.command.payload, { forceReset: true });
  assert.equal(connection.commands.length, 1);

  const invalid = createHarness({ snapshot: readyOutputSnapshot() });
  assertCoordinatorError(
    () => invalid.coordinator.emergencyStop({ forceReset: 'yes' }),
    ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
  );
  assert.equal(invalid.connection.commands.length, 0);
});

test('a second connect while READY is rejected without discarding current snapshot authority', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  const before = coordinator.snapshot();
  assertCoordinatorError(
    () => coordinator.connect(),
    ON_AIR_CONTROL_COORDINATOR_CODES.CONNECT_ALREADY_ACTIVE,
  );
  const after = coordinator.snapshot();
  assert.equal(connection.connectCalls, 1);
  assert.equal(after.ready, true);
  assert.deepEqual(after.playerSnapshot, before.playerSnapshot);
});

test('lease/control epoch regression and malformed desired state create sticky unknown locks', () => {
  const leaseRegression = createHarness({ snapshot: readyOutputSnapshot() });
  leaseRegression.connection.frame(readyOutputSnapshot({ lease: { epoch: 3 } }));
  assert.equal(
    leaseRegression.coordinator.snapshot().unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.EPOCH_REGRESSION,
  );

  const controlRegression = createHarness({ snapshot: readyOutputSnapshot() });
  controlRegression.connection.frame(readyOutputSnapshot({
    controlLease: { controlEpoch: 2 },
  }));
  assert.equal(
    controlRegression.coordinator.snapshot().unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.EPOCH_REGRESSION,
  );

  const malformedDesired = createHarness({ snapshot: readyOutputSnapshot() });
  malformedDesired.connection.frame({
    type: SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    desiredTransport: {},
  });
  assert.equal(
    malformedDesired.coordinator.snapshot().unknownLock.code,
    ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID,
  );
});

test('transport sessionId is required and must match a recognizable session websocket URL', () => {
  const baseTransport = {
    url: 'wss://example.invalid/v1/sessions/protocol-v2-room/ws?role=control&protocol=2',
    webSocketFactory: () => ({}),
    buildId: 'coordinator-test-build',
    capabilities: {},
  };
  assertCoordinatorError(
    () => new OnAirControlCoordinator({
      transport: baseTransport,
      connectionFactory: (options) => new FakeConnection(options),
    }),
    ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
  );
  assertCoordinatorError(
    () => new OnAirControlCoordinator({
      transport: { ...baseTransport, sessionId: 'different-room' },
      connectionFactory: (options) => new FakeConnection(options),
    }),
    ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
  );
});

test('dispose is terminal and immutable subscribers never authorize later commands', () => {
  const observed = [];
  const { coordinator, connection } = createHarness();
  coordinator.subscribe((snapshot) => observed.push(snapshot));
  coordinator.dispose();
  assert.equal(connection.closed, true);
  assert.equal(coordinator.snapshot().disposed, true);
  assertCoordinatorError(
    () => coordinator.activateOutput('obs'),
    ON_AIR_CONTROL_COORDINATOR_CODES.DISPOSED,
  );
  assert.ok(observed.every((snapshot) => Object.isFrozen(snapshot)));
});
