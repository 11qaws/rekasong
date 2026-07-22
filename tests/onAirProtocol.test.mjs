import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  BoundedCommandIdCache,
  CONTROL_COMMAND_TYPES,
  MonotonicSequenceTracker,
  ON_AIR_MESSAGE_FAMILIES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ON_AIR_SEQUENCE_NAMESPACES,
  PLAYER_CLIENT_KINDS,
  ROUTE_COMMAND_TYPES,
  ROUTE_EVENT_TYPES,
  RUN_COMMAND_TYPES,
  RUN_EVENT_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_COMMAND_TYPES,
  TEST_EVENT_TYPES,
  assertOnAirMessage,
  evaluateOnAirIdentity,
  evaluateOnAirPlayerCommandIdentity,
  getOnAirMessageFamily,
  getOnAirSequenceNamespace,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from '../src/lib/onAirProtocol.js';

const identity = Object.freeze({
  commandId: 'command-1',
  entryId: 'entry-1',
  runId: 'run-1',
  switchId: 'switch-1',
  checkId: 'check-1',
  playerInstanceId: 'player-1',
  targetPlayerInstanceId: 'player-1',
  connectionId: 'connection-1',
  controlInstanceId: 'control-1',
  authenticatedControlInstanceId: 'control-1',
  sessionId: 'session-1',
  leaseEpoch: 12,
  controlEpoch: 4,
});

function runCommand(type = RUN_COMMAND_TYPES.PLAY, overrides = {}) {
  const payloadByType = {
    [RUN_COMMAND_TYPES.LOAD]: {
      song: { id: 'song-1', title: 'Fixture song', type: 'youtube' },
      position: 0,
      volume: 100,
    },
    [RUN_COMMAND_TYPES.SEEK]: { position: 12.5 },
    [RUN_COMMAND_TYPES.VOLUME]: { volume: 80 },
  };
  return {
    type,
    commandId: identity.commandId,
    entryId: identity.entryId,
    runId: identity.runId,
    leaseEpoch: identity.leaseEpoch,
    targetPlayerInstanceId: identity.targetPlayerInstanceId,
    controlEpoch: identity.controlEpoch,
    payload: payloadByType[type] ?? {},
    ...overrides,
  };
}

function routeCommand(type = ROUTE_COMMAND_TYPES.ACTIVATE, overrides = {}) {
  return {
    type,
    commandId: identity.commandId,
    switchId: identity.switchId,
    leaseEpoch: identity.leaseEpoch,
    targetPlayerInstanceId: identity.targetPlayerInstanceId,
    controlEpoch: identity.controlEpoch,
    payload: type === ROUTE_COMMAND_TYPES.ACTIVATE ? { outputMode: 'obs' } : {},
    ...overrides,
  };
}

function testCommand(type = TEST_COMMAND_TYPES.START, overrides = {}) {
  return {
    type,
    commandId: identity.commandId,
    checkId: identity.checkId,
    leaseEpoch: identity.leaseEpoch,
    targetPlayerInstanceId: identity.targetPlayerInstanceId,
    controlEpoch: identity.controlEpoch,
    payload: type === TEST_COMMAND_TYPES.START
      ? { fixtureId: 'pcm-pulse-v1', durationMs: 8_000 }
      : {},
    ...overrides,
  };
}

function runEvent(event = RUN_EVENT_TYPES.PLAYING, overrides = {}) {
  const paused = [
    RUN_EVENT_TYPES.READY,
    RUN_EVENT_TYPES.PAUSED,
    RUN_EVENT_TYPES.ENDED,
  ].includes(event);
  return {
    type: ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT,
    eventId: 'event-1',
    event,
    sequence: 8,
    entryId: identity.entryId,
    runId: identity.runId,
    leaseEpoch: identity.leaseEpoch,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    commandId: identity.commandId,
    code: 'fixture_error',
    mediaTime: 12.25,
    duration: 180,
    paused: false,
    seeking: false,
    readyState: event === RUN_EVENT_TYPES.BUFFERING ? 1 : 4,
    rmsDbfs: -18,
    peakDbfs: -10,
    monotonicTimeMs: 2_000,
    postcondition: { status: event },
    ...(paused ? { paused: true } : {}),
    ...overrides,
  };
}

function routeEvent(event = ROUTE_EVENT_TYPES.OUTPUT_READY, overrides = {}) {
  const postcondition = event === ROUTE_EVENT_TYPES.OUTPUT_READY
    ? {
        mediaPaused: true,
        sourceDetached: true,
        autoplayCancelled: true,
        outputPathReady: true,
        audible: false,
      }
    : event === ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED
      ? { mediaPaused: true, sourceDetached: true, autoplayCancelled: true }
      : event === ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED
        ? { mediaPaused: false, sourceDetached: false, autoplayCancelled: false, audible: true }
        : null;
  return {
    type: ON_AIR_MESSAGE_TYPES.ROUTE_EVENT,
    eventId: 'event-1',
    event,
    sequence: 8,
    switchId: identity.switchId,
    leaseEpoch: identity.leaseEpoch,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    monotonicTimeMs: 2_000,
    code: 'fixture_route_error',
    ...(postcondition ? { postcondition } : {}),
    ...overrides,
  };
}

function outputTestEvent(event = TEST_EVENT_TYPES.TEST_STARTED, overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.TEST_EVENT,
    eventId: 'event-1',
    event,
    sequence: 8,
    checkId: identity.checkId,
    leaseEpoch: identity.leaseEpoch,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    monotonicTimeMs: 2_000,
    markerIndex: 0,
    markerTimeMs: 250,
    markerCount: 3,
    code: 'fixture_test_error',
    postcondition: { stopped: true },
    ...overrides,
  };
}

function assertValid(message, family) {
  const result = validateOnAirMessage(message);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.family, family);
  assert.deepEqual(result.errors, []);
}

function errorCodes(message) {
  return validateOnAirMessage(message).errors.map(({ path, code }) => `${path}:${code}`);
}

function playerHello(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HELLO,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    playerInstanceId: identity.playerInstanceId,
    clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
    buildId: 'build-123',
    capabilities: { analyser: true, obsRuntime: true },
    ...overrides,
  };
}

function controlHello(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.CONTROL_HELLO,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    controlInstanceId: identity.controlInstanceId,
    buildId: 'build-123',
    ...overrides,
  };
}

function controlTakeover(overrides = {}) {
  return {
    type: CONTROL_COMMAND_TYPES.TAKEOVER,
    commandId: identity.commandId,
    controlInstanceId: identity.controlInstanceId,
    expectedControlEpoch: identity.controlEpoch,
    ...overrides,
  };
}

function auxiliaryControlCommand(
  type = AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION,
  overrides = {},
) {
  const payloadByType = {
    [AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION]: {},
    [AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE]: {
      display: { currentSong: null, history: [] },
    },
    [AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH]: {
      videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'],
    },
  };
  return {
    type,
    commandId: identity.commandId,
    controlEpoch: identity.controlEpoch,
    payload: payloadByType[type],
    ...overrides,
  };
}

function emergencyAck(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    eventId: 'emergency-event-1',
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    sequence: 10,
    monotonicTimeMs: 2_100,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
    ...overrides,
  };
}

function playerSnapshot(overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    selectedOutputMode: 'obs',
    players: [{
      playerInstanceId: identity.playerInstanceId,
      connectionId: identity.connectionId,
      clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
      state: 'ready',
      lastSeenAt: 1_000,
      heartbeatStale: false,
      buildId: 'build-123',
      capabilities: { obsRuntime: true },
      runtime: { sourceActive: true },
    }],
    eligibleCandidates: { speaker: [], obs: [identity.playerInstanceId] },
    lease: {
      epoch: identity.leaseEpoch,
      leaseTarget: identity.playerInstanceId,
      clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
      status: 'ready',
      switchId: identity.switchId,
    },
    controlLease: {
      controlEpoch: identity.controlEpoch,
      writableControlInstanceId: identity.controlInstanceId,
      writableConnected: true,
    },
    activeFamily: null,
    activeCheckId: null,
    desiredTransport: { status: 'paused' },
    confirmedPlayback: { status: 'ready' },
    ...overrides,
  };
}

test('player and control hello have separate, validated identities', () => {
  assertValid(
    {
      type: ON_AIR_MESSAGE_TYPES.PLAYER_HELLO,
      protocolVersion: ON_AIR_PROTOCOL_VERSION,
      playerInstanceId: identity.playerInstanceId,
      clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
      buildId: 'build-123',
      capabilities: {
        audioWorklet: true,
        analyser: true,
        sinkSelection: false,
        obsRuntime: true,
        obsStudioBinding: true,
        futureCapability: 'allowed',
      },
    },
    ON_AIR_MESSAGE_FAMILIES.PLAYER_HELLO,
  );

  assertValid(
    {
      type: ON_AIR_MESSAGE_TYPES.CONTROL_HELLO,
      protocolVersion: ON_AIR_PROTOCOL_VERSION,
      controlInstanceId: identity.controlInstanceId,
      buildId: 'build-123',
    },
    ON_AIR_MESSAGE_FAMILIES.CONTROL_HELLO,
  );

  assert.deepEqual(errorCodes({
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HELLO,
    protocolVersion: 1,
    playerInstanceId: identity.playerInstanceId,
    clientKind: 'pretend-obs',
    buildId: 'build-123',
    capabilities: { analyser: 'yes', obsStudioBinding: 'yes' },
  }), [
    'protocolVersion:unsupported_protocol_version',
    'clientKind:invalid_client_kind',
    'capabilities.analyser:invalid_boolean',
    'capabilities.obsStudioBinding:invalid_boolean',
  ]);
});

test('protocol identifiers are canonical and cannot change during Worker normalization', () => {
  assert.deepEqual(errorCodes(playerHello({ playerInstanceId: ' player-1 ' })), [
    'playerInstanceId:invalid_identifier',
  ]);
  assert.deepEqual(errorCodes(playerHello({ playerInstanceId: 'player\u0000one' })), [
    'playerInstanceId:invalid_identifier',
  ]);
});

test('all run commands require the full run, output lease, target, and control identity', () => {
  for (const type of Object.values(RUN_COMMAND_TYPES)) {
    assertValid(runCommand(type), ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND);
    assert.equal(getOnAirMessageFamily(runCommand(type)), ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND);
  }

  for (const field of [
    'commandId',
    'entryId',
    'runId',
    'leaseEpoch',
    'targetPlayerInstanceId',
    'controlEpoch',
  ]) {
    const message = runCommand();
    delete message[field];
    assert.equal(validateOnAirMessage(message).ok, false, `${field} must be required`);
  }
});

test('route and test commands use their own IDs without fabricated run identity', () => {
  for (const type of Object.values(ROUTE_COMMAND_TYPES)) {
    assertValid(routeCommand(type), ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND);
  }
  for (const type of Object.values(TEST_COMMAND_TYPES)) {
    assertValid(testCommand(type), ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND);
  }

  assert.deepEqual(errorCodes(routeCommand(undefined, { entryId: 'fake', runId: 'fake' })), [
    'entryId:foreign_identity_field',
    'runId:foreign_identity_field',
  ]);
  assert.deepEqual(errorCodes(testCommand(undefined, { entryId: 'fake', runId: 'fake' })), [
    'entryId:foreign_identity_field',
    'runId:foreign_identity_field',
  ]);
  for (const command of [
    runCommand(undefined, { targetConnectionId: identity.connectionId }),
    routeCommand(undefined, { targetConnectionId: identity.connectionId }),
    testCommand(undefined, { targetConnectionId: identity.connectionId }),
  ]) {
    assert.ok(errorCodes(command).includes('targetConnectionId:foreign_identity_field'));
  }
});

test('Worker-targeted player commands use a separate connection-fenced schema', () => {
  const emergency = {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    authenticatedControlInstanceId: identity.authenticatedControlInstanceId,
  };
  const commands = [
    { ...runCommand(), protocolVersion: ON_AIR_PROTOCOL_VERSION },
    { ...routeCommand(), protocolVersion: ON_AIR_PROTOCOL_VERSION },
    { ...testCommand(), protocolVersion: ON_AIR_PROTOCOL_VERSION },
    emergency,
  ];

  for (const command of commands) {
    const targeted = { ...command, targetConnectionId: identity.connectionId };
    assert.equal(validateOnAirMessage(targeted).ok, false, 'control input must not choose a connection');
    assert.deepEqual(validateOnAirPlayerCommand(targeted), {
      ok: true,
      family: getOnAirMessageFamily(command),
      errors: [],
    });
    assert.equal(
      evaluateOnAirPlayerCommandIdentity(targeted, identity).accepted,
      true,
      command.type,
    );
    assert.equal(
      evaluateOnAirPlayerCommandIdentity(
        { ...targeted, targetConnectionId: 'old-connection' },
        identity,
      ).reason,
      'foreign_connection',
      command.type,
    );
    assert.equal(
      validateOnAirPlayerCommand(command).errors.some(({ path }) => path === 'targetConnectionId'),
      true,
      command.type,
    );
  }

  assert.equal(validateOnAirPlayerCommand({ type: SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT }).ok, false);
});

test('heartbeat is run-independent and validates its live connection identity', () => {
  const heartbeat = {
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    leaseEpoch: identity.leaseEpoch,
    sequence: 9,
    monotonicTimeMs: 124.5,
  };
  assertValid(heartbeat, ON_AIR_MESSAGE_FAMILIES.HEARTBEAT);
  assert.deepEqual(errorCodes({ ...heartbeat, entryId: 'fake', runId: 'fake' }), [
    'entryId:foreign_identity_field',
    'runId:foreign_identity_field',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeat, monotonicTimeMs: -1 }), [
    'monotonicTimeMs:number_out_of_range',
  ]);
});

test('control heartbeat is a minimal transport-only frame', () => {
  const heartbeat = {
    type: ON_AIR_MESSAGE_TYPES.CONTROL_HEARTBEAT,
    controlInstanceId: identity.controlInstanceId,
    connectionId: identity.connectionId,
    sequence: 3,
    monotonicTimeMs: 30_000,
  };
  assertValid(heartbeat, ON_AIR_MESSAGE_FAMILIES.CONTROL_HEARTBEAT);
  assert.equal(
    getOnAirSequenceNamespace(heartbeat),
    ON_AIR_SEQUENCE_NAMESPACES.CONTROL_HEARTBEAT,
  );
  assert.deepEqual(errorCodes({ ...heartbeat, commandId: identity.commandId }), [
    'commandId:unexpected_field',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeat, sequence: -1 }), [
    'sequence:required_non_negative_integer',
  ]);
});

test('player-originated frames cannot inject the server-owned target connection', () => {
  const heartbeat = {
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    leaseEpoch: identity.leaseEpoch,
    sequence: 9,
  };
  for (const message of [
    heartbeat,
    runEvent(),
    routeEvent(),
    outputTestEvent(),
    emergencyAck(),
  ]) {
    assert.ok(errorCodes({
      ...message,
      targetConnectionId: identity.connectionId,
    }).includes('targetConnectionId:foreign_identity_field'), message.type);
  }
});

test('emergency stop is the only authenticated session broadcast and has no lease/run epochs', () => {
  const emergency = {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    authenticatedControlInstanceId: identity.authenticatedControlInstanceId,
  };
  assertValid(emergency, ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND);

  assert.deepEqual(errorCodes({ ...emergency, runId: 'fake', leaseEpoch: 99, controlEpoch: 99 }), [
    'runId:foreign_identity_field',
    'leaseEpoch:foreign_identity_field',
    'controlEpoch:foreign_identity_field',
  ]);

  assertValid({
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    eventId: 'emergency-event-2',
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    sequence: 10,
    monotonicTimeMs: 2_100,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
  }, ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT);
});

test('run, route, and test event unions accept every declared event kind', () => {
  for (const event of Object.values(RUN_EVENT_TYPES)) {
    assertValid(runEvent(event), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  }
  for (const event of Object.values(ROUTE_EVENT_TYPES)) {
    assertValid(routeEvent(event), ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT);
  }
  for (const event of Object.values(TEST_EVENT_TYPES)) {
    assertValid(outputTestEvent(event), ON_AIR_MESSAGE_FAMILIES.TEST_EVENT);
  }

  assert.deepEqual(errorCodes(runEvent('invented_event')), ['event:invalid_run_event']);
  assert.deepEqual(errorCodes(routeEvent(undefined, { runId: 'fake' })), ['runId:foreign_identity_field']);
  assert.deepEqual(errorCodes(outputTestEvent(undefined, { runId: 'fake' })), ['runId:foreign_identity_field']);

  for (const factory of [runEvent, routeEvent, outputTestEvent]) {
    const missingConnection = factory();
    delete missingConnection.connectionId;
    assert.ok(errorCodes(missingConnection).includes('connectionId:required_identifier'));
  }
});

test('sequence namespace policy isolates run samples, test markers, lifecycle events, and emergency proof', () => {
  assert.equal(
    getOnAirSequenceNamespace(runEvent(RUN_EVENT_TYPES.POSITION)),
    ON_AIR_SEQUENCE_NAMESPACES.RUN_TELEMETRY,
  );
  assert.equal(
    getOnAirSequenceNamespace(runEvent(RUN_EVENT_TYPES.LEVEL)),
    ON_AIR_SEQUENCE_NAMESPACES.RUN_TELEMETRY,
  );
  assert.equal(
    getOnAirSequenceNamespace(runEvent(RUN_EVENT_TYPES.COMMAND_RECEIVED)),
    ON_AIR_SEQUENCE_NAMESPACES.RUN_RECEIPT,
  );
  assert.equal(
    getOnAirSequenceNamespace(runEvent(RUN_EVENT_TYPES.READY)),
    ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE,
  );
  assert.equal(getOnAirSequenceNamespace(routeEvent()), ON_AIR_SEQUENCE_NAMESPACES.ROUTE);
  assert.equal(
    getOnAirSequenceNamespace(outputTestEvent(TEST_EVENT_TYPES.TEST_STARTED)),
    ON_AIR_SEQUENCE_NAMESPACES.TEST,
  );
  assert.equal(
    getOnAirSequenceNamespace(outputTestEvent(TEST_EVENT_TYPES.TEST_MARKER)),
    ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY,
  );
  assert.equal(
    getOnAirSequenceNamespace(outputTestEvent(TEST_EVENT_TYPES.TEST_COMPLETE)),
    ON_AIR_SEQUENCE_NAMESPACES.TEST,
  );
  assert.equal(
    getOnAirSequenceNamespace(outputTestEvent(TEST_EVENT_TYPES.TEST_FAILED)),
    ON_AIR_SEQUENCE_NAMESPACES.TEST,
  );
  assert.equal(getOnAirSequenceNamespace(emergencyAck()), ON_AIR_SEQUENCE_NAMESPACES.EMERGENCY);
  assert.equal(getOnAirSequenceNamespace(runCommand()), null);
});

test('validator failures expose stable codes and paths, not localized prose', () => {
  assert.deepEqual(validateOnAirMessage(null), {
    ok: false,
    family: ON_AIR_MESSAGE_FAMILIES.UNKNOWN,
    errors: [{ path: '$', code: 'expected_object' }],
  });
  assert.deepEqual(validateOnAirMessage({ type: 'unknown' }), {
    ok: false,
    family: ON_AIR_MESSAGE_FAMILIES.UNKNOWN,
    errors: [{ path: 'type', code: 'unknown_message_type' }],
  });
  assert.equal(Object.hasOwn(validateOnAirMessage(null).errors[0], 'message'), false);

  assert.throws(
    () => assertOnAirMessage({ type: 'unknown' }),
    (error) => error instanceof TypeError
      && error.validation.errors[0].code === 'unknown_message_type',
  );
});

test('identity evaluator accepts only the current run and target identities', () => {
  const expected = { ...identity };
  assert.deepEqual(evaluateOnAirIdentity(runCommand(), expected), {
    accepted: true,
    reason: 'accepted',
    family: ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND,
  });

  assert.equal(
    evaluateOnAirIdentity(runCommand(undefined, { targetPlayerInstanceId: 'other' }), expected).reason,
    'foreign_target_player',
  );
  assert.equal(
    evaluateOnAirIdentity(runCommand(undefined, { leaseEpoch: 11 }), expected).reason,
    'stale_lease_epoch',
  );
  assert.equal(
    evaluateOnAirIdentity(runCommand(undefined, { leaseEpoch: 13 }), expected).reason,
    'future_lease_epoch',
  );
  assert.equal(
    evaluateOnAirIdentity(runCommand(undefined, { controlEpoch: 3 }), expected).reason,
    'stale_control_epoch',
  );
  assert.equal(
    evaluateOnAirIdentity(runCommand(undefined, { runId: 'old-run' }), expected).reason,
    'foreign_run',
  );
  assert.equal(
    evaluateOnAirIdentity(runEvent(undefined, { playerInstanceId: 'other' }), expected).reason,
    'foreign_player_instance',
  );
});

test('identity evaluator applies family-specific switch, check, and connection IDs', () => {
  const expected = { ...identity };
  assert.equal(evaluateOnAirIdentity(routeCommand(), expected).accepted, true);
  assert.equal(
    evaluateOnAirIdentity(routeCommand(undefined, { switchId: 'old-switch' }), expected).reason,
    'foreign_switch',
  );
  assert.equal(evaluateOnAirIdentity(testCommand(), expected).accepted, true);
  assert.equal(
    evaluateOnAirIdentity(testCommand(undefined, { checkId: 'old-check' }), expected).reason,
    'foreign_check',
  );

  const heartbeat = {
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    leaseEpoch: identity.leaseEpoch,
    sequence: 1,
  };
  assert.equal(evaluateOnAirIdentity(heartbeat, expected).accepted, true);
  assert.equal(
    evaluateOnAirIdentity({ ...heartbeat, connectionId: 'old-connection' }, expected).reason,
    'foreign_connection',
  );
});

test('emergency identity ignores run/lease expectations but remains session-auth bound', () => {
  const emergency = {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    authenticatedControlInstanceId: identity.authenticatedControlInstanceId,
  };
  assert.equal(evaluateOnAirIdentity(emergency, {
    ...identity,
    runId: 'different',
    leaseEpoch: 999,
    controlEpoch: 999,
  }).accepted, true);
  assert.equal(
    evaluateOnAirIdentity(emergency, { ...identity, sessionId: 'other-session' }).reason,
    'foreign_session',
  );
  assert.equal(
    evaluateOnAirIdentity(emergency, { ...identity, authenticatedControlInstanceId: 'other-control' }).reason,
    'foreign_authenticated_control',
  );
});

test('identity evaluation fails closed when a family-specific expected identity is absent', () => {
  const heartbeat = {
    type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    leaseEpoch: identity.leaseEpoch,
    sequence: 1,
  };
  const emergency = {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: identity.commandId,
    sessionId: identity.sessionId,
    authenticatedControlInstanceId: identity.authenticatedControlInstanceId,
  };
  const playerWelcome = {
    type: SERVER_MESSAGE_TYPES.PLAYER_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId: identity.connectionId,
    playerInstanceId: identity.playerInstanceId,
    leaseEpoch: identity.leaseEpoch,
    leaseTarget: identity.playerInstanceId,
    leaseStatus: 'ready',
  };
  const commandAck = {
    type: SERVER_MESSAGE_TYPES.COMMAND_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId: identity.commandId,
  };

  for (const message of [
    playerHello(),
    controlHello(),
    runCommand(),
    routeCommand(),
    testCommand(),
    controlTakeover(),
    auxiliaryControlCommand(),
    heartbeat,
    emergency,
    emergencyAck(),
    runEvent(),
    routeEvent(),
    outputTestEvent(),
    playerWelcome,
    playerSnapshot(),
    commandAck,
  ]) {
    const result = evaluateOnAirIdentity(message, {});
    assert.equal(result.accepted, false, message.type);
    assert.equal(result.reason, 'missing_expected_identity', message.type);
  }
});

test('control takeover is a separate CAS command and hello cannot request takeover', () => {
  assertValid(controlTakeover(), ON_AIR_MESSAGE_FAMILIES.CONTROL_COMMAND);
  assert.deepEqual(errorCodes(controlHello({ takeover: true })), [
    'takeover:foreign_identity_field',
  ]);
  assert.deepEqual(errorCodes(controlHello({ expectedControlEpoch: identity.controlEpoch })), [
    'expectedControlEpoch:foreign_identity_field',
  ]);
  assert.deepEqual(errorCodes(controlTakeover({ controlEpoch: identity.controlEpoch })), [
    'controlEpoch:foreign_identity_field',
  ]);

  assert.equal(evaluateOnAirIdentity(controlTakeover(), identity).accepted, true);
  assert.equal(
    evaluateOnAirIdentity(controlTakeover({ expectedControlEpoch: 3 }), identity).reason,
    'stale_control_epoch',
  );
  assert.equal(
    evaluateOnAirIdentity(controlTakeover({ controlInstanceId: 'other-control' }), identity).reason,
    'foreign_control_instance',
  );
});

test('auxiliary control commands are direct, epoch-guarded protocol families', () => {
  for (const type of Object.values(AUXILIARY_CONTROL_COMMAND_TYPES)) {
    const command = auxiliaryControlCommand(type);
    assertValid(command, ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND);
    assert.equal(
      getOnAirMessageFamily(command),
      ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND,
    );
  }

  const endWithoutPayload = auxiliaryControlCommand(AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION);
  delete endWithoutPayload.payload;
  assertValid(endWithoutPayload, ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND);
  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION,
    { payload: { reason: 'not-client-owned' } },
  )), ['payload:payload_not_empty']);

  for (const field of ['commandId', 'controlEpoch']) {
    const command = auxiliaryControlCommand();
    delete command[field];
    assert.equal(validateOnAirMessage(command).ok, false, field);
  }

  assert.equal(evaluateOnAirIdentity(auxiliaryControlCommand(), identity).accepted, true);
  assert.equal(evaluateOnAirIdentity(auxiliaryControlCommand(), {}).reason, 'missing_expected_identity');
  assert.equal(evaluateOnAirIdentity(auxiliaryControlCommand(undefined, {
    controlEpoch: identity.controlEpoch - 1,
  }), identity).reason, 'stale_control_epoch');
  assert.equal(evaluateOnAirIdentity(auxiliaryControlCommand(undefined, {
    controlEpoch: identity.controlEpoch + 1,
  }), identity).reason, 'future_control_epoch');
});

test('display_state and prefetch validate canonical nested payloads', () => {
  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: {} },
  )), ['payload.display:required_record']);
  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: { display: [] } },
  )), ['payload.display:required_record']);

  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
    { payload: {} },
  )), ['payload.videoIds:required_array']);
  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
    { payload: { videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0', 'J---aiyznGQ'] } },
  )), ['payload.videoIds:array_too_long']);
  assert.deepEqual(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
    { payload: { videoIds: ['too-short', 'invalid!!!!'] } },
  )), [
    'payload.videoIds[0]:invalid_youtube_video_id',
    'payload.videoIds[1]:invalid_youtube_video_id',
  ]);

  const topLevelFallback = auxiliaryControlCommand(AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH, {
    payload: {},
    videoIds: ['dQw4w9WgXcQ'],
  });
  assert.deepEqual(errorCodes(topLevelFallback), ['payload.videoIds:required_array']);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.ok(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: { display: cyclic } },
  )).includes('payload.display.self:json_cycle'));
  assert.ok(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: { display: { value: 1n } } },
  )).includes('payload.display.value:invalid_json_value'));
  assert.ok(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: { display: { text: 'x'.repeat(50 * 1_024) } } },
  )).includes('payload.display:json_too_large'));
  assert.ok(errorCodes(auxiliaryControlCommand(
    AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
    { payload: { display: {}, extra: true } },
  )).includes('payload.extra:unexpected_field'));
});

test('run command payload schemas reject silent coercion and unsafe ranges', () => {
  assert.deepEqual(errorCodes(runCommand(RUN_COMMAND_TYPES.LOAD, { payload: {} })), [
    'payload.song:required_record',
  ]);
  assert.deepEqual(errorCodes(runCommand(RUN_COMMAND_TYPES.LOAD, {
    payload: { song: { id: 'song-1' }, position: -1, volume: 101 },
  })), [
    'payload.position:number_out_of_range',
    'payload.volume:number_out_of_range',
  ]);
  assert.deepEqual(errorCodes(runCommand(RUN_COMMAND_TYPES.SEEK, { payload: {} })), [
    'payload.position:required_finite_number',
  ]);
  assert.deepEqual(errorCodes(runCommand(RUN_COMMAND_TYPES.SEEK, { payload: { position: -0.1 } })), [
    'payload.position:number_out_of_range',
  ]);
  assert.deepEqual(errorCodes(runCommand(RUN_COMMAND_TYPES.VOLUME, { payload: { volume: 101 } })), [
    'payload.volume:number_out_of_range',
  ]);

  const playWithoutPayload = runCommand(RUN_COMMAND_TYPES.PLAY);
  delete playWithoutPayload.payload;
  assertValid(playWithoutPayload, ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND);
});

test('route and test command payloads carry explicit mode and bounded fixture duration', () => {
  assert.deepEqual(errorCodes(routeCommand(ROUTE_COMMAND_TYPES.ACTIVATE, { payload: {} })), [
    'payload.outputMode:invalid_output_mode',
  ]);
  assert.deepEqual(errorCodes(routeCommand(ROUTE_COMMAND_TYPES.ACTIVATE, {
    payload: { outputMode: 'both' },
  })), ['payload.outputMode:invalid_output_mode']);
  assert.deepEqual(errorCodes(testCommand(TEST_COMMAND_TYPES.START, { payload: {} })), [
    'payload.fixtureId:required_identifier',
    'payload.durationMs:required_finite_number',
  ]);
  assert.deepEqual(errorCodes(testCommand(TEST_COMMAND_TYPES.START, {
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 999 },
  })), ['payload.durationMs:number_out_of_range']);
  assert.deepEqual(errorCodes(testCommand(TEST_COMMAND_TYPES.START, {
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1_000.5 },
  })), ['payload.durationMs:required_safe_integer']);
  assert.deepEqual(errorCodes(testCommand(TEST_COMMAND_TYPES.START, {
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 10_001 },
  })), ['payload.durationMs:number_out_of_range']);
});

test('playback event kinds require their own evidence and postconditions', () => {
  assert.ok(Object.values(RUN_EVENT_TYPES).includes('ready'));
  assertValid(runEvent(RUN_EVENT_TYPES.READY), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);

  const position = runEvent(RUN_EVENT_TYPES.POSITION);
  for (const field of ['mediaTime', 'duration', 'readyState', 'paused', 'seeking', 'monotonicTimeMs']) {
    const invalid = { ...position };
    delete invalid[field];
    assert.equal(validateOnAirMessage(invalid).ok, false, `position.${field}`);
  }

  assert.deepEqual(errorCodes(runEvent(RUN_EVENT_TYPES.LEVEL, { rmsDbfs: -10, peakDbfs: -20 })), [
    'peakDbfs:peak_below_rms',
  ]);
  const missingLevel = runEvent(RUN_EVENT_TYPES.LEVEL);
  delete missingLevel.rmsDbfs;
  assert.ok(errorCodes(missingLevel).includes('rmsDbfs:required_finite_number'));

  const failed = runEvent(RUN_EVENT_TYPES.COMMAND_FAILED);
  delete failed.commandId;
  delete failed.code;
  assert.ok(errorCodes(failed).includes('commandId:required_identifier'));
  assert.ok(errorCodes(failed).includes('code:required_identifier'));

  assert.deepEqual(errorCodes(runEvent(RUN_EVENT_TYPES.PLAYING, { paused: true })), [
    'paused:invalid_postcondition',
  ]);
  assert.deepEqual(errorCodes(runEvent(RUN_EVENT_TYPES.PAUSED, { paused: false })), [
    'paused:invalid_postcondition',
  ]);

  const strongStopped = {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  };
  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'STOP',
    postcondition: strongStopped,
  }), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    postcondition: { status: 'loading' },
  }), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'SEEK',
    postcondition: { status: 'playing', position: 42.25 },
  }), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'VOLUME',
    postcondition: { status: 'paused', volume: 37.5 },
  }), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    postcondition: strongStopped,
  })).includes('commandType:invalid_stop_command_type'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: RUN_COMMAND_TYPES.STOP,
    postcondition: strongStopped,
  })).includes('commandType:invalid_stop_command_type'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'STOP',
    postcondition: { ...strongStopped, sourceDetached: false },
  })).includes('postcondition.sourceDetached:invalid_postcondition'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'STOP',
    postcondition: { ...strongStopped, optimistic: true },
  })).includes('optimistic:unexpected_field'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    postcondition: { status: 'playing', position: 12 },
  })).includes('commandType:invalid_seek_command_type'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    postcondition: { status: 'playing', volume: 12 },
  })).includes('commandType:invalid_volume_command_type'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'seek',
    postcondition: { status: 'playing', position: 12 },
  })).includes('commandType:invalid_applied_command_type'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'SEEK',
    postcondition: { status: 'playing', volume: 12 },
  })).includes('postcondition.position:required_finite_number'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'SEEK',
    postcondition: { status: 'playing', position: -0.01 },
  })).includes('postcondition.position:number_out_of_range'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'VOLUME',
    postcondition: { status: 'playing', volume: 100.01 },
  })).includes('postcondition.volume:number_out_of_range'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, {
    commandType: 'VOLUME',
    postcondition: { status: 'playing', volume: 50, optimistic: true },
  })).includes('optimistic:unexpected_field'));

  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_FAILED, {
    safetyPostcondition: strongStopped,
  }), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assertValid(runEvent(RUN_EVENT_TYPES.COMMAND_FAILED), ON_AIR_MESSAGE_FAMILIES.RUN_EVENT);
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.COMMAND_FAILED, {
    safetyPostcondition: { ...strongStopped, audible: true },
  })).includes('safetyPostcondition.audible:invalid_postcondition'));
  assert.ok(errorCodes(runEvent(RUN_EVENT_TYPES.PLAYING, {
    safetyPostcondition: strongStopped,
  })).includes('safetyPostcondition:unexpected_field'));
});

test('route, test, and emergency acknowledgements prove safe postconditions', () => {
  const strongStopped = {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  };
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED, {
    postcondition: { mediaPaused: true, sourceDetached: false, autoplayCancelled: true },
  })), ['postcondition.sourceDetached:invalid_postcondition']);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED, {
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: false },
  })), ['postcondition.autoplayCancelled:invalid_postcondition']);
  const legacyReady = routeEvent(ROUTE_EVENT_TYPES.OUTPUT_READY, {
    postcondition: { mediaPaused: true, sourceAttached: true, audible: false },
  });
  assert.deepEqual(errorCodes(legacyReady), [
    'postcondition.sourceDetached:invalid_postcondition',
    'postcondition.autoplayCancelled:invalid_postcondition',
    'postcondition.outputPathReady:invalid_postcondition',
    'sourceAttached:unexpected_field',
  ]);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_READY, {
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: false,
      audible: true,
    },
  })), [
    'postcondition.outputPathReady:invalid_postcondition',
    'postcondition.audible:invalid_postcondition',
  ]);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_READY, {
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: true,
      audible: false,
      sourceAttached: false,
    },
  })), ['sourceAttached:unexpected_field']);

  const routeFailure = routeEvent(ROUTE_EVENT_TYPES.OUTPUT_ACTIVATION_FAILED);
  delete routeFailure.code;
  assert.deepEqual(errorCodes(routeFailure), ['code:required_identifier']);

  assert.ok(Object.values(ROUTE_EVENT_TYPES).includes('output_deactivation_failed'));
  assertValid(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED, {
    code: 'detach_postcondition_failed',
    detail: { action: 'detach', physical: { mediaPaused: false } },
    postcondition: { mediaPaused: false, sourceDetached: false, audible: true },
  }), ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT);
  const deactivationFailure = routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED);
  delete deactivationFailure.code;
  assert.deepEqual(errorCodes(deactivationFailure), ['code:required_identifier']);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED, {
    postcondition: [],
  })), ['postcondition:invalid_record']);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED, {
    postcondition: { mediaPaused: false, outputPathReady: false },
  })), ['outputPathReady:unexpected_field']);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED, {
    postcondition: { sourceDetached: 'unknown' },
  })), ['postcondition.sourceDetached:invalid_boolean']);
  assert.deepEqual(errorCodes(routeEvent(ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED, {
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  })), ['postcondition:contradictory_failure_postcondition']);

  const marker = outputTestEvent(TEST_EVENT_TYPES.TEST_MARKER);
  delete marker.markerIndex;
  assert.deepEqual(errorCodes(marker), ['markerIndex:required_non_negative_integer']);
  assert.deepEqual(errorCodes(outputTestEvent(TEST_EVENT_TYPES.TEST_COMPLETE, {
    postcondition: { stopped: false },
  })), ['postcondition.stopped:invalid_postcondition']);
  assertValid(outputTestEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    safetyPostcondition: strongStopped,
  }), ON_AIR_MESSAGE_FAMILIES.TEST_EVENT);
  assert.ok(errorCodes(outputTestEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    safetyPostcondition: { ...strongStopped, sourceDetached: false },
  })).includes('safetyPostcondition.sourceDetached:invalid_postcondition'));
  assert.ok(errorCodes(outputTestEvent(TEST_EVENT_TYPES.TEST_FAILED, {
    safetyPostcondition: { ...strongStopped, optimistic: true },
  })).includes('optimistic:unexpected_field'));
  assert.ok(errorCodes(outputTestEvent(TEST_EVENT_TYPES.TEST_STARTED, {
    safetyPostcondition: strongStopped,
  })).includes('safetyPostcondition:unexpected_field'));

  assert.deepEqual(errorCodes(emergencyAck({
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: false,
    },
  })), ['postcondition.autoplayCancelled:invalid_postcondition']);
});

test('server-to-client welcome and snapshot wire messages are validated', () => {
  const playerWelcome = {
    type: SERVER_MESSAGE_TYPES.PLAYER_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId: identity.connectionId,
    playerInstanceId: identity.playerInstanceId,
    leaseEpoch: identity.leaseEpoch,
    leaseTarget: identity.playerInstanceId,
    leaseStatus: 'ready',
  };
  const controlWelcome = {
    type: SERVER_MESSAGE_TYPES.CONTROL_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId: identity.connectionId,
    controlInstanceId: identity.controlInstanceId,
    writable: true,
    controlEpoch: identity.controlEpoch,
    writableControlInstanceId: identity.controlInstanceId,
    code: 'control_lease_granted',
  };
  assertValid(playerWelcome, ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME);
  assertValid(controlWelcome, ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME);
  assertValid(playerSnapshot(), ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT);
  assertValid(playerSnapshot({
    activeFamily: { entryId: identity.entryId, runId: identity.runId },
  }), ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT);
  assertValid(playerSnapshot({
    activeCheckId: identity.checkId,
  }), ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT);

  assert.equal(evaluateOnAirIdentity(playerWelcome, {
    playerInstanceId: identity.playerInstanceId,
  }).accepted, true);
  assert.equal(evaluateOnAirIdentity(controlWelcome, {
    controlInstanceId: identity.controlInstanceId,
  }).accepted, true);
  assert.equal(evaluateOnAirIdentity(playerSnapshot(), { trustedConnection: true }).accepted, true);
  assert.equal(evaluateOnAirIdentity(playerSnapshot(), { trustedConnection: false }).reason, 'untrusted_connection');

  assert.deepEqual(errorCodes({
    ...controlWelcome,
    writableControlInstanceId: 'other-control',
  }), ['writableControlInstanceId:writable_owner_mismatch']);
  const { activeFamily: _activeFamily, ...missingActiveFamily } = playerSnapshot();
  const { activeCheckId: _activeCheckId, ...missingActiveCheckId } = playerSnapshot();
  assert.deepEqual(errorCodes(missingActiveFamily), ['activeFamily:required_record']);
  assert.deepEqual(errorCodes(missingActiveCheckId), ['activeCheckId:required_identifier']);
  assert.deepEqual(errorCodes(playerSnapshot({
    activeFamily: { entryId: identity.entryId, runId: identity.runId, guessed: true },
  })), ['guessed:unexpected_field']);
  assert.deepEqual(errorCodes(playerSnapshot({
    activeFamily: { entryId: identity.entryId, runId: identity.runId },
    activeCheckId: identity.checkId,
  })), ['activeCheckId:active_family_conflict']);
});

test('heartbeat_ack has one exact versioned server schema with canonical transport identity', () => {
  const heartbeatAck = {
    type: SERVER_MESSAGE_TYPES.HEARTBEAT_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
    leaseEpoch: identity.leaseEpoch,
    sequence: 8,
  };
  assertValid(heartbeatAck, ON_AIR_MESSAGE_FAMILIES.SERVER_HEARTBEAT_ACK);
  assert.equal(evaluateOnAirIdentity(heartbeatAck, {
    trustedConnection: true,
    playerInstanceId: identity.playerInstanceId,
    connectionId: identity.connectionId,
  }).accepted, true);
  assert.equal(evaluateOnAirIdentity(heartbeatAck, {
    trustedConnection: true,
    playerInstanceId: identity.playerInstanceId,
    connectionId: 'other-connection',
  }).reason, 'foreign_connection');

  for (const field of [
    'protocolVersion',
    'playerInstanceId',
    'connectionId',
    'leaseEpoch',
    'sequence',
  ]) {
    const missing = { ...heartbeatAck };
    delete missing[field];
    assert.equal(validateOnAirMessage(missing).ok, false, field);
  }
  assert.deepEqual(errorCodes({ ...heartbeatAck, playerInstanceId: ' player-1' }), [
    'playerInstanceId:invalid_identifier',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, connectionId: 'connection-1\n' }), [
    'connectionId:invalid_identifier',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, leaseEpoch: -1 }), [
    'leaseEpoch:required_non_negative_integer',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, sequence: Number.MAX_SAFE_INTEGER + 1 }), [
    'sequence:required_non_negative_integer',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, protocolVersion: 1 }), [
    'protocolVersion:unsupported_protocol_version',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, eventId: 'not-an-event' }), [
    'eventId:unexpected_field',
  ]);
  assert.deepEqual(errorCodes({ ...heartbeatAck, detail: { audible: true } }), [
    'detail:unexpected_field',
  ]);
});

test('server command results, protocol errors, supersession and state frames are validated', () => {
  const commandAck = {
    type: SERVER_MESSAGE_TYPES.COMMAND_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId: identity.commandId,
    code: 'control_lease_granted',
    controlEpoch: 5,
    writableControlInstanceId: identity.controlInstanceId,
  };
  const commandRejected = {
    type: SERVER_MESSAGE_TYPES.COMMAND_REJECTED,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId: identity.commandId,
    code: 'stale_control_epoch',
    detail: { expected: 5, actual: 4 },
  };
  const eventAck = {
    type: SERVER_MESSAGE_TYPES.EVENT_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    eventId: 'event-ack-1',
    playerInstanceId: identity.playerInstanceId,
    sequence: 8,
    status: 'applied',
  };
  const protocolError = {
    type: SERVER_MESSAGE_TYPES.PROTOCOL_ERROR,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    code: 'invalid_playback_event',
    detail: {},
  };
  const superseded = {
    type: SERVER_MESSAGE_TYPES.CONNECTION_SUPERSEDED,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    code: 'newer_connection_registered',
  };
  const desired = {
    type: SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    desiredTransport: { status: 'playing' },
  };
  const presence = {
    type: SERVER_MESSAGE_TYPES.PRESENCE,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    role: 'player',
    connected: true,
    playerInstanceId: identity.playerInstanceId,
    clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
  };

  assertValid(commandAck, ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT);
  assertValid(commandRejected, ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT);
  assertValid(eventAck, ON_AIR_MESSAGE_FAMILIES.SERVER_EVENT_RESULT);
  assertValid(protocolError, ON_AIR_MESSAGE_FAMILIES.SERVER_ERROR);
  assertValid(superseded, ON_AIR_MESSAGE_FAMILIES.SERVER_CONNECTION);
  assertValid(desired, ON_AIR_MESSAGE_FAMILIES.SERVER_STATE);
  assertValid(presence, ON_AIR_MESSAGE_FAMILIES.SERVER_STATE);

  assert.equal(evaluateOnAirIdentity(commandAck, {
    trustedConnection: true,
    commandId: identity.commandId,
  }).accepted, true);
  assert.equal(evaluateOnAirIdentity(commandAck, {
    trustedConnection: true,
    commandId: 'other-command',
  }).reason, 'foreign_command');
  assert.deepEqual(errorCodes({ ...commandRejected, commandId: null }), [
    'commandId:required_identifier',
  ]);
  assert.equal(evaluateOnAirIdentity(eventAck, {
    trustedConnection: true,
    eventId: eventAck.eventId,
    playerInstanceId: identity.playerInstanceId,
  }).accepted, true);
  assert.deepEqual(errorCodes({ ...eventAck, status: 'invented' }), [
    'status:invalid_event_ack_status',
  ]);
});

test('session_ended is a versioned server lifecycle frame with stable cleanup metadata', () => {
  const message = {
    type: SERVER_MESSAGE_TYPES.SESSION_ENDED,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    reasonCode: 'explicit_end_session',
    cleanupAt: 1_753_000_000_000,
  };
  assertValid(message, ON_AIR_MESSAGE_FAMILIES.SERVER_LIFECYCLE);
  assert.equal(evaluateOnAirIdentity(message, { trustedConnection: true }).accepted, true);
  assert.equal(evaluateOnAirIdentity(message, {}).reason, 'missing_expected_identity');
  assert.deepEqual(errorCodes({ ...message, reasonCode: '' }), ['reasonCode:required_identifier']);
  assert.deepEqual(errorCodes({ ...message, cleanupAt: -1 }), ['cleanupAt:number_out_of_range']);
  assert.deepEqual(errorCodes({ ...message, cleanupAt: Number.NaN }), [
    'cleanupAt:required_finite_number',
  ]);
});

test('bounded command cache rejects duplicates and evicts least-recently-used IDs', () => {
  const cache = new BoundedCommandIdCache(2);
  assert.deepEqual(cache.accept('a'), { accepted: true, duplicate: false, evictedCommandId: null });
  assert.deepEqual(cache.accept('b'), { accepted: true, duplicate: false, evictedCommandId: null });
  assert.deepEqual(cache.accept('a'), { accepted: false, duplicate: true, evictedCommandId: null });
  assert.deepEqual(cache.accept('c'), { accepted: true, duplicate: false, evictedCommandId: 'b' });
  assert.deepEqual(cache.snapshot(), ['a', 'c']);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('b'), false);
  assert.throws(() => cache.accept(''), TypeError);
  assert.throws(() => new BoundedCommandIdCache(0), RangeError);
});

test('monotonic tracker measures gaps and rejects duplicates/out-of-order events', () => {
  const tracker = new MonotonicSequenceTracker();
  assert.equal(tracker.observe('run_event', 'player-1', 7).status, 'first');
  assert.equal(tracker.observe('run_event', 'player-1', 8).status, 'next');

  const gap = tracker.observe('run_event', 'player-1', 11);
  assert.equal(gap.accepted, true);
  assert.equal(gap.status, 'gap');
  assert.equal(gap.missing, 2);

  assert.equal(tracker.observe('run_event', 'player-1', 11).status, 'duplicate');
  assert.equal(tracker.observe('run_event', 'player-1', 9).status, 'out_of_order');
  assert.equal(tracker.getHighWaterMark('run_event', 'player-1'), 11);

  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.stats, {
    observations: 5,
    accepted: 3,
    rejected: 2,
    first: 1,
    next: 1,
    gap: 1,
    missing: 2,
    duplicate: 1,
    outOfOrder: 1,
    evictions: 0,
  });
});

test('monotonic streams are isolated by family and player and are bounded', () => {
  const tracker = new MonotonicSequenceTracker({ maxStreams: 2 });
  tracker.observe('run_event', 'player-1', 5);
  tracker.observe('route_event', 'player-1', 5);
  assert.equal(tracker.observe('run_event', 'player-1', 6).status, 'next');
  tracker.observe('run_event', 'player-2', 1);

  assert.equal(tracker.size, 2);
  assert.equal(tracker.getHighWaterMark('route_event', 'player-1'), null);
  assert.equal(tracker.snapshot().stats.evictions, 1);
});

test('observeMessage derives sequence namespace and instance from validated messages', () => {
  const tracker = new MonotonicSequenceTracker();
  const first = tracker.observeMessage(runEvent(undefined, { sequence: 20 }));
  assert.equal(first.family, ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE);
  assert.equal(first.instanceId, identity.playerInstanceId);
  assert.equal(tracker.observeMessage(routeEvent(undefined, { sequence: 3 })).status, 'first');
  assert.equal(
    tracker.observeMessage(outputTestEvent(TEST_EVENT_TYPES.TEST_STARTED, { sequence: 0 })).family,
    ON_AIR_SEQUENCE_NAMESPACES.TEST,
  );
  assert.equal(
    tracker.observeMessage(outputTestEvent(TEST_EVENT_TYPES.TEST_MARKER, { sequence: 0 })).family,
    ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY,
  );

  assert.throws(
    () => tracker.observeMessage(runCommand()),
    /does not carry a sequence/,
  );
  assert.throws(
    () => tracker.observeMessage(runEvent('not-real')),
    (error) => error.validation.errors[0].code === 'invalid_run_event',
  );
});
