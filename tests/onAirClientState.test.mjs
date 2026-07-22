import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ON_AIR_SEQUENCE_NAMESPACES,
  ROUTE_EVENT_TYPES,
  RUN_EVENT_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_EVENT_TYPES,
} from '../src/lib/onAirProtocol.js';
import {
  ON_AIR_CLIENT_STATE_CODES,
  OnAirClientStateError,
  OnAirCommandLedger,
  OnAirPlayerCommandLedger,
  OnAirPlayerEventOutbox,
  OnAirSequenceCounters,
  canonicalOnAirFingerprint,
  createControlPageIdentity,
  createPlayerPageIdentity,
} from '../src/lib/onAirClientState.js';

function deterministicIds(prefix = 'fixture') {
  let next = 0;
  return (scope) => `${prefix}-${scope}-${next++}`;
}

function assertStateError(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof OnAirClientStateError
      && error.code === code
      && typeof error.detail === 'object',
  );
}

function commandAck(commandId, overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.COMMAND_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId,
    ...overrides,
  };
}

function commandRejected(commandId, overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.COMMAND_REJECTED,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    commandId,
    code: 'fixture_rejected',
    detail: { source: 'test' },
    ...overrides,
  };
}

function playbackDraft(event = RUN_EVENT_TYPES.PLAYING, overrides = {}) {
  const eventFields = {
    [RUN_EVENT_TYPES.PLAYING]: { mediaTime: 12, paused: false },
    [RUN_EVENT_TYPES.PAUSED]: { mediaTime: 12, paused: true },
    [RUN_EVENT_TYPES.POSITION]: {
      mediaTime: 12,
      duration: 180,
      readyState: 4,
      paused: false,
      seeking: false,
    },
    [RUN_EVENT_TYPES.LEVEL]: { rmsDbfs: -18, peakDbfs: -10 },
  };
  return {
    type: ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT,
    event,
    entryId: 'entry-1',
    runId: 'run-1',
    leaseEpoch: 4,
    playerInstanceId: 'player-1',
    connectionId: 'connection-1',
    monotonicTimeMs: 2_000,
    ...eventFields[event],
    ...overrides,
  };
}

function routeDraft(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.ROUTE_EVENT,
    event: ROUTE_EVENT_TYPES.OUTPUT_READY,
    switchId: 'switch-1',
    leaseEpoch: 4,
    playerInstanceId: 'player-1',
    connectionId: 'connection-1',
    monotonicTimeMs: 2_000,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: true,
      audible: false,
    },
    ...overrides,
  };
}

function testEventDraft(event = TEST_EVENT_TYPES.TEST_STARTED, overrides = {}) {
  const eventFields = {
    [TEST_EVENT_TYPES.TEST_MARKER]: { markerIndex: 0, markerTimeMs: 250 },
    [TEST_EVENT_TYPES.TEST_COMPLETE]: {
      markerCount: 1,
      postcondition: { stopped: true },
    },
    [TEST_EVENT_TYPES.TEST_FAILED]: { code: 'fixture_test_failed' },
  };
  return {
    type: ON_AIR_MESSAGE_TYPES.TEST_EVENT,
    event,
    checkId: 'check-1',
    leaseEpoch: 4,
    playerInstanceId: 'player-1',
    connectionId: 'connection-1',
    monotonicTimeMs: 2_000,
    ...eventFields[event],
    ...overrides,
  };
}

function emergencyAckDraft(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    commandId: 'emergency-command-1',
    sessionId: 'session-1',
    playerInstanceId: 'player-1',
    connectionId: 'connection-1',
    monotonicTimeMs: 2_000,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
    ...overrides,
  };
}

function eventAck(record, status = 'applied', overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.EVENT_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    eventId: record.eventId,
    playerInstanceId: record.message.playerInstanceId,
    sequence: record.sequence,
    status,
    ...overrides,
  };
}

function targetedPlayCommand(overrides = {}) {
  return {
    type: 'play',
    commandId: 'player-command-1',
    entryId: 'entry-1',
    runId: 'run-1',
    leaseEpoch: 4,
    targetPlayerInstanceId: 'player-1',
    targetConnectionId: 'connection-1',
    controlEpoch: 2,
    ...overrides,
  };
}

function targetedRouteCommand(commandId, overrides = {}) {
  return {
    type: 'activate_output',
    commandId,
    switchId: `switch-${commandId}`,
    leaseEpoch: 4,
    targetPlayerInstanceId: 'player-1',
    targetConnectionId: 'connection-1',
    controlEpoch: 2,
    payload: { outputMode: 'obs' },
    ...overrides,
  };
}

function targetedEmergencyCommand(overrides = {}) {
  return {
    type: 'emergency_stop',
    commandId: 'emergency-command-1',
    sessionId: 'session-1',
    authenticatedControlInstanceId: 'control-1',
    targetConnectionId: 'connection-1',
    ...overrides,
  };
}

test('page identities are injected, immutable, stable for reconnect, and fresh per lifecycle', () => {
  const scopes = [];
  let serial = 0;
  const idFactory = (scope) => {
    scopes.push(scope);
    return `${scope}-page-${serial++}`;
  };

  const playerLifecycle = createPlayerPageIdentity({ idFactory });
  const reconnectReference = playerLifecycle;
  const controlLifecycle = createControlPageIdentity({ idFactory });
  const nextPlayerLifecycle = createPlayerPageIdentity({ idFactory });

  assert.equal(reconnectReference.playerInstanceId, playerLifecycle.playerInstanceId);
  assert.notEqual(nextPlayerLifecycle.playerInstanceId, playerLifecycle.playerInstanceId);
  assert.equal(controlLifecycle.controlInstanceId, 'control-page-1');
  assert.deepEqual(scopes, ['player', 'control', 'player']);
  assert.equal(Object.isFrozen(playerLifecycle), true);
  assertStateError(
    () => createPlayerPageIdentity({ idFactory: () => '' }),
    ON_AIR_CLIENT_STATE_CODES.INVALID_ID_FACTORY_RESULT,
  );
  for (const invalidId of [` ${'a'}`, `a\u0000b`, `a\u007fb`, 'a'.repeat(257)]) {
    assertStateError(
      () => createControlPageIdentity({ idFactory: () => invalidId }),
      ON_AIR_CLIENT_STATE_CODES.INVALID_ID_FACTORY_RESULT,
    );
  }
});

test('canonical fingerprints ignore object key order but preserve semantic differences', () => {
  assert.equal(
    canonicalOnAirFingerprint({ b: 2, a: { y: 2, x: 1 } }),
    canonicalOnAirFingerprint({ a: { x: 1, y: 2 }, b: 2 }),
  );
  assert.notEqual(
    canonicalOnAirFingerprint({ value: 1 }),
    canonicalOnAirFingerprint({ value: 2 }),
  );
  assertStateError(
    () => canonicalOnAirFingerprint({ value: Number.NaN }),
    ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE,
  );
});

test('nine sequence streams start at zero, remain isolated, and merge HWM floors upward only', () => {
  const counters = new OnAirSequenceCounters();
  const namespaces = Object.values(ON_AIR_SEQUENCE_NAMESPACES);
  assert.equal(namespaces.length, 9);
  for (const namespace of namespaces) assert.equal(counters.peek(namespace), 0);

  assert.equal(counters.next(ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE), 0);
  assert.equal(counters.next(ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE), 1);
  assert.equal(counters.next(ON_AIR_SEQUENCE_NAMESPACES.ROUTE), 0);
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.TEST), 0);

  counters.mergeHighWaterMarks({
    [ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE]: 10,
    [ON_AIR_SEQUENCE_NAMESPACES.ROUTE]: 4,
    [ON_AIR_SEQUENCE_NAMESPACES.TEST]: null,
  });
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE), 11);
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.ROUTE), 5);
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY), 0);
  counters.mergeHighWaterMarks({ [ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE]: 3 });
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE), 11);

  const snapshot = counters.snapshot();
  assert.equal(snapshot.highWaterMarks.runAuthoritative, 10);
  assert.equal(snapshot.nextValues.route, 5);
  assert.equal(snapshot.highWaterMarks.heartbeat, null);
  assert.equal(snapshot.highWaterMarks.controlHeartbeat, null);
});

test('test marker sequence exhaustion is isolated from durable test lifecycle events', () => {
  const counters = new OnAirSequenceCounters({
    highWaterMarks: {
      [ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY]: Number.MAX_SAFE_INTEGER - 2,
    },
  });

  assert.equal(
    counters.next(ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY),
    Number.MAX_SAFE_INTEGER - 1,
  );
  assertStateError(
    () => counters.next(ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY),
    ON_AIR_CLIENT_STATE_CODES.SEQUENCE_EXHAUSTED,
  );
  assert.equal(counters.next(ON_AIR_SEQUENCE_NAMESPACES.TEST), 0);
});

test('HWM merge is fail-closed and cannot partially raise counters', () => {
  const counters = new OnAirSequenceCounters();
  assertStateError(
    () => counters.mergeHighWaterMarks({ heartbeat: 8, invented: 2 }),
    ON_AIR_CLIENT_STATE_CODES.UNKNOWN_SEQUENCE_NAMESPACE,
  );
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.HEARTBEAT), 0);
  assertStateError(
    () => counters.mergeHighWaterMarks({ heartbeat: -1 }),
    ON_AIR_CLIENT_STATE_CODES.INVALID_SEQUENCE_HIGH_WATER_MARK,
  );
});

test('command ledger reuses one ID only for the same canonical requested command', () => {
  const ledger = new OnAirCommandLedger({ idFactory: deterministicIds('control') });
  const created = ledger.request({
    type: 'play',
    runId: 'run-1',
    payload: { b: 2, a: 1 },
  });
  const commandId = created.entry.commandId;
  const retry = ledger.request({
    payload: { a: 1, b: 2 },
    commandId,
    runId: 'run-1',
    type: 'play',
  });

  assert.equal(created.status, 'created');
  assert.equal(retry.status, 'retry');
  assert.equal(retry.retryAllowed, true);
  assert.equal(retry.entry.attempts, 2);
  assertStateError(
    () => ledger.request({ type: 'pause', runId: 'run-1', payload: {}, commandId }),
    ON_AIR_CLIENT_STATE_CODES.COMMAND_ID_CONFLICT,
  );
  assert.equal(ledger.pending().length, 1);
});

test('ACK loss plus reconnect becomes outcome_unknown and never exposes an automatic retry', () => {
  const ledger = new OnAirCommandLedger({ idFactory: deterministicIds('lost') });
  const created = ledger.request({ type: 'load', payload: { songId: 'song-1' } });
  const changed = ledger.markReconnectOutcomeUnknown();

  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'outcome_unknown');
  assert.equal(ledger.pending().length, 0);
  assert.equal(ledger.terminalLookup(created.entry.commandId).state, 'outcome_unknown');

  const attemptedRetry = ledger.request(created.entry.command);
  assert.equal(attemptedRetry.status, 'terminal');
  assert.equal(attemptedRetry.retryAllowed, false);
  assertStateError(
    () => ledger.handleServerFrame(commandAck(created.entry.commandId)),
    ON_AIR_CLIENT_STATE_CODES.COMMAND_TERMINAL_CONFLICT,
  );
});

test('command results are validated, settled, and retained in bounded terminal history', () => {
  const ledger = new OnAirCommandLedger({ historyLimit: 2 });
  for (const commandId of ['command-1', 'command-2', 'command-3']) {
    ledger.request({ type: 'volume', payload: { volume: 50 }, commandId });
  }

  assert.equal(ledger.handleServerFrame(commandAck('command-1')).entry.state, 'acknowledged');
  assert.equal(ledger.handleServerFrame(commandRejected('command-2')).entry.state, 'rejected');
  assert.equal(ledger.handleServerFrame(commandAck('command-3')).entry.state, 'acknowledged');
  assert.equal(ledger.handleServerFrame(commandAck('command-3')).status, 'duplicate_terminal');
  assertStateError(
    () => ledger.handleServerFrame(commandAck('command-3', { code: 'different_result' })),
    ON_AIR_CLIENT_STATE_CODES.COMMAND_TERMINAL_CONFLICT,
  );
  assert.equal(ledger.terminalLookup('command-1'), null);
  assert.equal(ledger.terminalLookup('command-2').result.code, 'fixture_rejected');
  assert.equal(ledger.terminalLookup('command-3').state, 'acknowledged');
  assert.equal(ledger.snapshot().terminal.length, 2);
});

test('command ledger fails closed at its pending capacity without evicting requests', () => {
  const ledger = new OnAirCommandLedger({ pendingCapacity: 1 });
  const first = ledger.request({ type: 'pause', commandId: 'pending-command-1', payload: {} });

  assertStateError(
    () => ledger.request({ type: 'pause', commandId: 'pending-command-2', payload: {} }),
    ON_AIR_CLIENT_STATE_CODES.COMMAND_PENDING_CAPACITY_EXCEEDED,
  );
  assert.deepEqual(ledger.pending().map((entry) => entry.commandId), [first.entry.commandId]);
  assert.equal(ledger.snapshot().pendingCapacity, 1);

  ledger.handleServerFrame(commandAck(first.entry.commandId));
  assert.equal(
    ledger.request({ type: 'pause', commandId: 'pending-command-2', payload: {} }).status,
    'created',
  );
});

test('player command ledger deduplicates ordinary commands across connections and binds emergency to one connection', () => {
  const ledger = new OnAirPlayerCommandLedger();
  const ordinary = targetedPlayCommand();
  assert.equal(ledger.observe(ordinary).status, 'accepted');
  assert.equal(ledger.observe(ordinary).status, 'duplicate');
  assert.equal(ledger.observe({ ...ordinary, targetConnectionId: 'connection-2' }).status, 'duplicate');
  assertStateError(
    () => ledger.observe({ ...ordinary, runId: 'run-conflict' }),
    ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_ID_CONFLICT,
  );

  const emergency = targetedEmergencyCommand();
  assert.equal(ledger.observe(emergency).status, 'accepted');
  assert.equal(ledger.observe(emergency).status, 'duplicate');
  assert.equal(
    ledger.observe({ ...emergency, targetConnectionId: 'connection-2' }).status,
    'accepted',
  );
  assert.equal(ledger.get(emergency.commandId, { targetConnectionId: 'connection-1' }).critical, true);
  assert.equal(ledger.get(emergency.commandId, { targetConnectionId: 'connection-2' }).critical, true);
});

test('player command history evicts oldest noncritical receipts but never critical tombstones', () => {
  const ledger = new OnAirPlayerCommandLedger({ historyLimit: 2 });
  ledger.observe(targetedRouteCommand('route-critical-1'));
  ledger.observe(targetedPlayCommand({ commandId: 'run-evictable-1' }));
  ledger.observe(targetedRouteCommand('route-critical-2', { switchId: 'switch-critical-2' }));

  assert.equal(ledger.get('route-critical-1').critical, true);
  assert.equal(ledger.get('route-critical-2').critical, true);
  assert.equal(ledger.get('run-evictable-1'), null);
  assertStateError(
    () => ledger.observe(targetedPlayCommand({ commandId: 'run-blocked' })),
    ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_HISTORY_CAPACITY_EXCEEDED,
  );
  assert.deepEqual(
    ledger.snapshot().entries.map((entry) => entry.commandId),
    ['route-critical-1', 'route-critical-2'],
  );
});

test('event outbox fixes event ID, namespace, and sequence through retry and ACK terminalization', () => {
  const outbox = new OnAirPlayerEventOutbox({ idFactory: deterministicIds('event') });
  const created = outbox.enqueue(playbackDraft());
  const retry = outbox.enqueue(created.entry.message);

  assert.equal(created.entry.namespace, ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE);
  assert.equal(created.entry.sequence, 0);
  assert.equal(retry.status, 'retry');
  assert.equal(retry.entry.eventId, created.entry.eventId);
  assertStateError(
    () => outbox.enqueue({ ...created.entry.message, mediaTime: 13 }),
    ON_AIR_CLIENT_STATE_CODES.EVENT_ID_CONFLICT,
  );

  const settled = outbox.applyServerAck(eventAck(created.entry, 'relayed'));
  assert.equal(settled.status, 'acknowledged');
  assert.equal(settled.ackStatus, 'relayed');
  assert.equal(outbox.size, 0);
  assert.equal(outbox.terminalLookup(created.entry.eventId).result.ackStatus, 'relayed');
  assert.equal(outbox.applyServerAck(eventAck(created.entry, 'relayed')).status, 'duplicate_terminal');
  assertStateError(
    () => outbox.applyServerAck(eventAck(created.entry, 'duplicate')),
    ON_AIR_CLIENT_STATE_CODES.EVENT_TERMINAL_CONFLICT,
  );
  assertStateError(
    () => outbox.applyServerAck(eventAck(created.entry, 'relayed', { playerInstanceId: 'player-spoofed' })),
    ON_AIR_CLIENT_STATE_CODES.EVENT_ACK_IDENTITY_MISMATCH,
  );
  assertStateError(
    () => outbox.applyServerAck(eventAck(created.entry, 'relayed', { sequence: created.entry.sequence + 1 })),
    ON_AIR_CLIENT_STATE_CODES.EVENT_ACK_IDENTITY_MISMATCH,
  );
});

test('ordinary pending events rebind only connectionId while emergency ACK becomes outcome_unknown', () => {
  const outbox = new OnAirPlayerEventOutbox({ idFactory: deterministicIds('rebind') });
  const ordinary = outbox.enqueue(playbackDraft()).entry;
  const emergency = outbox.enqueue(emergencyAckDraft()).entry;
  const rebound = outbox.rebindConnection('connection-2');

  assert.equal(rebound.rebound.length, 1);
  assert.equal(rebound.rebound[0].eventId, ordinary.eventId);
  assert.equal(rebound.rebound[0].sequence, ordinary.sequence);
  assert.equal(rebound.rebound[0].message.connectionId, 'connection-2');
  assert.equal(rebound.outcomeUnknown.length, 1);
  assert.equal(rebound.outcomeUnknown[0].eventId, emergency.eventId);
  assert.equal(rebound.outcomeUnknown[0].state, 'outcome_unknown');
  assert.equal(rebound.outcomeUnknown[0].message.connectionId, 'connection-1');
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.terminalLookup(emergency.eventId).state, 'outcome_unknown');
});

test('connection loss immediately retires only connection-bound emergency proofs', () => {
  const outbox = new OnAirPlayerEventOutbox({ idFactory: deterministicIds('lost-connection') });
  const ordinary = outbox.enqueue(playbackDraft()).entry;
  const emergency = outbox.enqueue(emergencyAckDraft()).entry;

  const lost = outbox.markConnectionLost('connection-1');
  assert.deepEqual(lost.map((entry) => entry.eventId), [emergency.eventId]);
  assert.equal(outbox.get(emergency.eventId).state, 'outcome_unknown');
  assert.equal(outbox.get(ordinary.eventId).state, 'pending');
  assert.deepEqual(outbox.markConnectionLost('connection-1'), []);

  const rebound = outbox.rebindConnection('connection-2');
  assert.deepEqual(rebound.outcomeUnknown, []);
  assert.equal(rebound.rebound.length, 1);
  assert.equal(rebound.rebound[0].eventId, ordinary.eventId);
  assert.equal(rebound.rebound[0].message.connectionId, 'connection-2');
});

test('position and level telemetry coalesce to their latest samples without reusing sequence', () => {
  const outbox = new OnAirPlayerEventOutbox({
    idFactory: deterministicIds('telemetry'),
    capacity: 2,
  });
  const positionOne = outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.POSITION, { mediaTime: 1 })).entry;
  const positionTwo = outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.POSITION, { mediaTime: 2 })).entry;
  const levelOne = outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.LEVEL, {
    rmsDbfs: -20,
    peakDbfs: -12,
  })).entry;
  const levelTwo = outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.LEVEL, {
    rmsDbfs: -16,
    peakDbfs: -8,
  })).entry;

  assert.equal(positionOne.sequence, 0);
  assert.equal(positionTwo.sequence, 1);
  assert.equal(levelOne.sequence, 2);
  assert.equal(levelTwo.sequence, 3);
  assert.equal(outbox.size, 2);
  assert.equal(outbox.terminalLookup(positionOne.eventId).state, 'coalesced');
  assert.equal(outbox.terminalLookup(levelOne.eventId).state, 'coalesced');
  const pending = outbox.pending().map((record) => record.message);
  assert.equal(pending.find((message) => message.event === RUN_EVENT_TYPES.POSITION).mediaTime, 2);
  assert.equal(pending.find((message) => message.event === RUN_EVENT_TYPES.LEVEL).rmsDbfs, -16);
});

test('test markers use an isolated sequence and remain reliable pending events without coalescing', () => {
  const counters = new OnAirSequenceCounters();
  const outbox = new OnAirPlayerEventOutbox({
    idFactory: deterministicIds('marker'),
    sequenceCounters: counters,
    capacity: 2,
  });
  const started = outbox.enqueue(testEventDraft()).entry;
  const firstMarker = outbox.enqueue(testEventDraft(TEST_EVENT_TYPES.TEST_MARKER)).entry;

  assert.equal(started.namespace, ON_AIR_SEQUENCE_NAMESPACES.TEST);
  assert.equal(started.sequence, 0);
  assert.equal(firstMarker.namespace, ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY);
  assert.equal(firstMarker.sequence, 0);
  assert.equal(firstMarker.telemetry, false);
  assert.equal(outbox.size, 2);
  assertStateError(
    () => outbox.enqueue(testEventDraft(TEST_EVENT_TYPES.TEST_MARKER, {
      markerIndex: 1,
      markerTimeMs: 500,
    })),
    ON_AIR_CLIENT_STATE_CODES.EVENT_OUTBOX_CAPACITY_EXCEEDED,
  );
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY), 1);
  assert.equal(outbox.terminalLookup(firstMarker.eventId), null);
  const rebound = outbox.rebindConnection('connection-2');
  const reboundMarker = rebound.rebound.find((entry) => entry.eventId === firstMarker.eventId);
  assert.equal(reboundMarker.namespace, ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY);
  assert.equal(reboundMarker.sequence, 0);
  assert.equal(reboundMarker.message.connectionId, 'connection-2');
  assert.equal(outbox.enqueue(reboundMarker.message).status, 'retry');
});

test('explicit event abandonment validates atomically and tombstones only exact pending IDs', () => {
  const outbox = new OnAirPlayerEventOutbox({ idFactory: deterministicIds('abandon') });
  const ordinary = outbox.enqueue(playbackDraft()).entry;
  const firstMarker = outbox.enqueue(testEventDraft(TEST_EVENT_TYPES.TEST_MARKER)).entry;
  const secondMarker = outbox.enqueue(testEventDraft(TEST_EVENT_TYPES.TEST_MARKER, {
    markerIndex: 1,
    markerTimeMs: 500,
  })).entry;
  const acknowledged = outbox.applyServerAck(eventAck(secondMarker, 'relayed')).entry;

  assertStateError(
    () => outbox.abandonEvents([firstMarker.eventId, ' invalid-event-id']),
    ON_AIR_CLIENT_STATE_CODES.INVALID_IDENTIFIER,
  );
  assert.equal(outbox.get(firstMarker.eventId).state, 'pending');
  assert.equal(outbox.get(ordinary.eventId).state, 'pending');

  const result = outbox.abandonEvents([
    firstMarker.eventId,
    firstMarker.eventId,
    secondMarker.eventId,
    'event-missing',
  ], { code: 'test_terminalized' });
  assert.equal(result.status, 'abandoned');
  assert.deepEqual(result.abandoned.map((entry) => entry.eventId), [firstMarker.eventId]);
  assert.equal(result.abandoned[0].state, 'abandoned');
  assert.equal(result.abandoned[0].result.code, 'test_terminalized');
  assert.deepEqual(result.alreadyTerminal.map((entry) => entry.eventId), [secondMarker.eventId]);
  assert.equal(result.alreadyTerminal[0], acknowledged);
  assert.deepEqual(result.notFound, ['event-missing']);
  assert.equal(outbox.terminalLookup('event-missing'), null);
  assert.equal(outbox.get(ordinary.eventId).state, 'pending');
  assert.deepEqual(outbox.pending().map((entry) => entry.eventId), [ordinary.eventId]);
  assertStateError(
    () => outbox.applyServerAck(eventAck(firstMarker, 'relayed')),
    ON_AIR_CLIENT_STATE_CODES.EVENT_TERMINAL_CONFLICT,
  );

  const repeated = outbox.abandonEvents([firstMarker.eventId], { code: 'test_terminalized' });
  assert.deepEqual(repeated.abandoned, []);
  assert.equal(repeated.alreadyTerminal[0], result.abandoned[0]);
});

test('a reliable test marker may evict run telemetry but is never itself dropped', () => {
  const outbox = new OnAirPlayerEventOutbox({
    idFactory: deterministicIds('marker-priority'),
    capacity: 1,
  });
  const position = outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.POSITION)).entry;
  const marker = outbox.enqueue(testEventDraft(TEST_EVENT_TYPES.TEST_MARKER)).entry;

  assert.equal(marker.namespace, ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY);
  assert.equal(marker.telemetry, false);
  assert.equal(outbox.pending()[0].eventId, marker.eventId);
  assert.equal(outbox.terminalLookup(position.eventId).state, 'coalesced');
  assert.equal(outbox.terminalLookup(position.eventId).result.code, 'critical_event_priority');
});

test('critical events are never dropped when a critical-only outbox reaches capacity', () => {
  const counters = new OnAirSequenceCounters();
  const outbox = new OnAirPlayerEventOutbox({
    idFactory: deterministicIds('critical'),
    sequenceCounters: counters,
    capacity: 1,
  });
  const playing = outbox.enqueue(playbackDraft()).entry;

  assertStateError(
    () => outbox.enqueue(routeDraft()),
    ON_AIR_CLIENT_STATE_CODES.EVENT_OUTBOX_CAPACITY_EXCEEDED,
  );
  assert.equal(outbox.size, 1);
  assert.equal(outbox.pending()[0].eventId, playing.eventId);
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.ROUTE), 0);
});

test('invalid protocol frames fail closed without mutating ledgers, counters, or outbox', () => {
  const counters = new OnAirSequenceCounters();
  const outbox = new OnAirPlayerEventOutbox({
    idFactory: deterministicIds('invalid'),
    sequenceCounters: counters,
  });
  assertStateError(
    () => outbox.enqueue(playbackDraft(RUN_EVENT_TYPES.PLAYING, { paused: undefined })),
    ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE,
  );
  assert.equal(counters.peek(ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE), 0);
  assert.equal(outbox.size, 0);

  const created = outbox.enqueue(playbackDraft()).entry;
  const invalidAck = { ...eventAck(created) };
  delete invalidAck.protocolVersion;
  assertStateError(
    () => outbox.applyServerAck(invalidAck),
    ON_AIR_CLIENT_STATE_CODES.INVALID_PROTOCOL_FRAME,
  );
  assert.equal(outbox.size, 1);
  assertStateError(
    () => outbox.applyServerAck(eventAck(created, 'applied', { sequence: created.sequence + 1 })),
    ON_AIR_CLIENT_STATE_CODES.EVENT_ACK_IDENTITY_MISMATCH,
  );
  assert.equal(outbox.size, 1);

  const ledger = new OnAirCommandLedger();
  ledger.request({ type: 'pause', commandId: 'command-invalid-frame', payload: {} });
  const invalidCommandAck = commandAck('command-invalid-frame');
  delete invalidCommandAck.protocolVersion;
  assertStateError(
    () => ledger.handleServerFrame(invalidCommandAck),
    ON_AIR_CLIENT_STATE_CODES.INVALID_PROTOCOL_FRAME,
  );
  assert.equal(ledger.get('command-invalid-frame').state, 'requested');
});
