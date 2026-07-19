import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';
import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ON_AIR_SEQUENCE_NAMESPACES,
  SERVER_MESSAGE_TYPES,
  TEST_EVENT_TYPES,
  validateOnAirMessage,
} from '../src/lib/onAirProtocol.js';
import { ON_AIR_TEST_FIXTURE_MIN_DURATION_MS } from '../src/lib/onAirTestFixture.js';
import { ON_AIR_V2_CONNECTION_STATES } from '../src/lib/onAirV2Connection.js';

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
  assert.equal(connection.commands.length, 1);
});

test('connection loss creates a sticky unknown lock and reconnect does not resume commands', () => {
  const { coordinator, connection } = createHarness({ snapshot: readyOutputSnapshot() });
  connection.lose();
  assert.equal(coordinator.snapshot().unknownLock.code, ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST);

  coordinator.connect();
  connection.negotiate(controlWelcome({ connectionId: 'control-connection-b' }));
  connection.frame(readyOutputSnapshot());
  assert.equal(coordinator.snapshot().unknown, true);
  assertCoordinatorError(
    () => coordinator.load({ song: { id: 'song-a', type: 'local' } }),
    ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
  );
  assert.equal(connection.commands.length, 0);
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

  connection.frame(readyOutputSnapshot({ activeCheckId: null }));
  assert.equal(coordinator.snapshot().pendingTest, null);
  const restarted = coordinator.startTest({ fixtureId: 'custom-pulse', durationMs: 1000 });
  assert.equal(restarted.command.payload.fixtureId, 'custom-pulse');
  assert.notEqual(restarted.command.checkId, start.command.checkId);
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
