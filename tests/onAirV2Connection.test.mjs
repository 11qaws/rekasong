import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_V2_CONNECTION_CODES,
  ON_AIR_V2_CONNECTION_STATES,
  ON_AIR_V2_OBS_HEARTBEAT_INTERVAL_MS,
  ON_AIR_V2_SPEAKER_HEARTBEAT_INTERVAL_MS,
  OnAirV2Connection,
} from '../src/lib/onAirV2Connection.js';
import { ON_AIR_CLIENT_STATE_CODES } from '../src/lib/onAirClientState.js';
import {
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  PLAYER_CLIENT_KINDS,
  SERVER_MESSAGE_TYPES,
  TEST_EVENT_TYPES,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from '../src/lib/onAirProtocol.js';

test('production player heartbeats are diagnostics, not a per-second audio clock', () => {
  assert.equal(ON_AIR_V2_OBS_HEARTBEAT_INTERVAL_MS, 10_000);
  assert.equal(ON_AIR_V2_SPEAKER_HEARTBEAT_INTERVAL_MS, 30_000);
});

class FakeSocket {
  readyState = 0;
  sent = [];
  failSends = false;
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(value) {
    if (this.readyState !== 1) throw new Error('socket_not_open');
    if (this.failSends) throw new Error('fixture_send_failed');
    this.sent.push(value);
  }

  open() {
    this.readyState = 1;
    this.#emit('open', {});
  }

  receive(frame) {
    this.receiveRaw(JSON.stringify(frame));
  }

  receiveRaw(data) {
    this.#emit('message', { data });
  }

  serverClose({ code = 1006, wasClean = false } = {}) {
    this.readyState = 3;
    this.#emit('close', { code, wasClean });
  }

  close(code = 1000) {
    this.serverClose({ code, wasClean: true });
  }

  messages() {
    return this.sent.map((value) => JSON.parse(value));
  }

  #emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

class FakeClock {
  time = 0;
  #nextId = 1;
  #intervals = new Map();

  now = () => this.time;

  setInterval = (callback, period) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#intervals.set(id, { callback, period, next: this.time + period });
    return id;
  };

  clearInterval = (id) => {
    this.#intervals.delete(id);
  };

  advance(duration) {
    const end = this.time + duration;
    while (true) {
      const next = [...this.#intervals.entries()]
        .filter(([, interval]) => interval.next <= end)
        .sort((left, right) => left[1].next - right[1].next || left[0] - right[0])[0];
      if (!next) break;
      const [id, interval] = next;
      this.time = interval.next;
      if (this.#intervals.has(id)) interval.next += interval.period;
      interval.callback();
    }
    this.time = end;
  }
}

function createHarness(role, overrides = {}) {
  const sockets = [];
  const diagnostics = [];
  const clock = overrides.clock ?? new FakeClock();
  const scopeCounts = new Map();
  const idFactory = overrides.idFactory ?? ((scope) => {
    const count = (scopeCounts.get(scope) ?? 0) + 1;
    scopeCounts.set(scope, count);
    return `${scope}-${count}`;
  });
  const connection = new OnAirV2Connection({
    role,
    url: 'wss://example.invalid/session?protocol=2',
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: clock.now,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    idFactory,
    buildId: 'build-test',
    capabilities: {},
    clientKind: role === 'player' ? PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE : null,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
    clock: undefined,
  });
  return { connection, sockets, diagnostics, clock };
}

function controlWelcome(connection, connectionId = 'control-connection-1', overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.CONTROL_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId,
    controlInstanceId: connection.identity.controlInstanceId,
    writable: true,
    controlEpoch: 3,
    writableControlInstanceId: connection.identity.controlInstanceId,
    code: 'control_registered',
    ...overrides,
  };
}

function playerWelcome(connection, connectionId = 'player-connection-1', overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.PLAYER_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId,
    playerInstanceId: connection.identity.playerInstanceId,
    leaseEpoch: 1,
    leaseTarget: connection.identity.playerInstanceId,
    leaseStatus: 'active',
    ...overrides,
  };
}

function heartbeatAck(connection, connectionId, sequence, overrides = {}) {
  return {
    type: SERVER_MESSAGE_TYPES.HEARTBEAT_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    playerInstanceId: connection.identity.playerInstanceId,
    connectionId,
    leaseEpoch: connection.snapshot().leaseEpoch,
    sequence,
    ...overrides,
  };
}

function readyControl(harness, connectionId = 'control-connection-1') {
  harness.connection.connect();
  const socket = harness.sockets.at(-1);
  socket.open();
  socket.receive(controlWelcome(harness.connection, connectionId));
  return socket;
}

function readyPlayer(harness, connectionId = 'player-connection-1', overrides = {}) {
  harness.connection.connect();
  const socket = harness.sockets.at(-1);
  socket.open();
  socket.receive(playerWelcome(harness.connection, connectionId, overrides));
  return socket;
}

function displayCommand(overrides = {}) {
  return {
    type: 'display_state',
    controlEpoch: 3,
    payload: { display: { title: 'test' } },
    ...overrides,
  };
}

function playCommand(connection, targetConnectionId, overrides = {}) {
  return {
    type: 'play',
    commandId: 'command-play-1',
    entryId: 'entry-1',
    runId: 'run-1',
    leaseEpoch: 1,
    targetPlayerInstanceId: connection.identity.playerInstanceId,
    targetConnectionId,
    controlEpoch: 3,
    ...overrides,
  };
}

function activateOutputCommand(connection, targetConnectionId, overrides = {}) {
  return {
    type: 'activate_output',
    commandId: 'command-activate-1',
    switchId: 'switch-1',
    leaseEpoch: 2,
    targetPlayerInstanceId: connection.identity.playerInstanceId,
    targetConnectionId,
    controlEpoch: 3,
    payload: { outputMode: 'obs' },
    ...overrides,
  };
}

function emergencyStopCommand(targetConnectionId, overrides = {}) {
  return {
    type: 'emergency_stop',
    commandId: 'emergency-stop-command-1',
    sessionId: 'session-1',
    authenticatedControlInstanceId: 'control-1',
    targetConnectionId,
    ...overrides,
  };
}

function playingEvent(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT,
    event: 'playing',
    entryId: 'entry-1',
    runId: 'run-1',
    leaseEpoch: 1,
    monotonicTimeMs: 10,
    mediaTime: 0,
    paused: false,
    ...overrides,
  };
}

function emergencyAck(overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    commandId: 'emergency-command-1',
    sessionId: 'session-1',
    monotonicTimeMs: 12,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
    ...overrides,
  };
}

function testMarkerEvent(markerIndex = 0, overrides = {}) {
  return {
    type: ON_AIR_MESSAGE_TYPES.TEST_EVENT,
    event: TEST_EVENT_TYPES.TEST_MARKER,
    checkId: 'check-1',
    leaseEpoch: 1,
    monotonicTimeMs: 12,
    markerIndex,
    markerTimeMs: (markerIndex + 1) * 250,
    ...overrides,
  };
}

test('control negotiates with hello and settles duplicate terminal ACKs idempotently', () => {
  const commandResults = [];
  const harness = createHarness('control', {
    onCommandResult: (result) => commandResults.push(result),
  });
  harness.connection.connect();
  const socket = harness.sockets[0];
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.CONNECTING);

  socket.open();
  const hello = socket.messages()[0];
  assert.equal(hello.type, ON_AIR_MESSAGE_TYPES.CONTROL_HELLO);
  assert.equal(hello.protocolVersion, 2);
  assert.equal(hello.controlInstanceId, harness.connection.identity.controlInstanceId);
  assert.equal(validateOnAirMessage(hello).ok, true);

  socket.receive({
    type: SERVER_MESSAGE_TYPES.PRESENCE,
    protocolVersion: 2,
    role: 'control',
    connected: true,
  });
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.FRAME_BEFORE_NEGOTIATION);

  socket.receive(controlWelcome(harness.connection));
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);
  const requested = harness.connection.requestCommand(displayCommand());
  assert.equal(requested.status, 'created');
  assert.equal(socket.messages().at(-1).commandId, requested.entry.commandId);

  const ack = {
    type: SERVER_MESSAGE_TYPES.COMMAND_ACK,
    protocolVersion: 2,
    commandId: requested.entry.commandId,
    code: 'accepted',
    controlEpoch: 3,
  };
  socket.receive(ack);
  socket.receive(ack);
  assert.deepEqual(commandResults.map((result) => result.status), [
    'acknowledged',
    'duplicate_terminal',
  ]);
  assert.equal(harness.connection.commandLedger.get(requested.entry.commandId).state, 'acknowledged');

  socket.receive({
    type: SERVER_MESSAGE_TYPES.COMMAND_REJECTED,
    protocolVersion: 2,
    commandId: requested.entry.commandId,
    code: 'late_conflict',
    detail: {},
  });
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.COMMAND_RESULT_IGNORED);
  assert.equal(harness.diagnostics.at(-1).detail.errorCode, 'command_terminal_conflict');
});

test('control reconnect marks unresolved commands outcome_unknown and never auto-resends', () => {
  const commandResults = [];
  const harness = createHarness('control', {
    onCommandResult: (result) => commandResults.push(result),
  });
  const firstSocket = readyControl(harness, 'control-connection-old');
  const requested = harness.connection.requestCommand(displayCommand());
  assert.equal(firstSocket.messages().length, 2);

  firstSocket.serverClose();
  assert.equal(harness.connection.commandLedger.get(requested.entry.commandId).state, 'outcome_unknown');
  assert.equal(commandResults.at(-1).status, 'outcome_unknown');

  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  secondSocket.receive(controlWelcome(harness.connection, 'control-connection-new'));
  assert.deepEqual(secondSocket.messages().map((message) => message.type), ['control_hello']);

  const terminalRetry = harness.connection.requestCommand(requested.entry.command);
  assert.equal(terminalRetry.status, 'terminal');
  assert.equal(terminalRetry.retryAllowed, false);
  assert.equal(secondSocket.messages().length, 1);
});

test('invalid commands fail before the command ledger is mutated', () => {
  const harness = createHarness('control');
  readyControl(harness);
  const before = harness.connection.commandLedger.snapshot();

  assert.throws(
    () => harness.connection.requestCommand({ type: 'display_state', payload: {} }),
    (error) => error.code === ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME,
  );
  assert.deepEqual(harness.connection.commandLedger.snapshot(), before);
});

test('command send failure returns the final outcome_unknown ledger truth', () => {
  const commandResults = [];
  const harness = createHarness('control', {
    onCommandResult: (result) => commandResults.push(result),
  });
  const socket = readyControl(harness);
  socket.failSends = true;

  const result = harness.connection.requestCommand(displayCommand());
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.retryAllowed, false);
  assert.equal(result.entry.state, 'outcome_unknown');
  assert.equal(harness.connection.commandLedger.get(result.entry.commandId), result.entry);
  assert.equal(commandResults.at(-1).status, 'outcome_unknown');
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.DISCONNECTED);
});

test('connection forwards command pending capacity and fails closed without another send', () => {
  const harness = createHarness('control', { commandPendingCapacity: 1 });
  const socket = readyControl(harness);
  harness.connection.requestCommand(displayCommand(), { commandId: 'pending-capacity-1' });
  const sentBefore = socket.messages().length;

  assert.throws(
    () => harness.connection.requestCommand(displayCommand(), { commandId: 'pending-capacity-2' }),
    (error) => error.code === ON_AIR_CLIENT_STATE_CODES.COMMAND_PENDING_CAPACITY_EXCEEDED,
  );
  assert.equal(socket.messages().length, sentBefore);
  assert.deepEqual(
    harness.connection.commandLedger.pending().map((entry) => entry.commandId),
    ['pending-capacity-1'],
  );
});

test('player validates target fencing and ignores invalid and late old-socket commands', () => {
  const commands = [];
  const harness = createHarness('player', {
    onPlayerCommand: (command) => commands.push(command),
  });
  const firstSocket = readyPlayer(harness, 'player-connection-old');

  const foreignConnection = playCommand(harness.connection, 'player-connection-foreign');
  assert.equal(validateOnAirPlayerCommand(foreignConnection).ok, true);
  firstSocket.receive(foreignConnection);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.FOREIGN_TARGET_CONNECTION);

  firstSocket.receive(playCommand(harness.connection, 'player-connection-old', {
    commandId: 'command-foreign-player',
    targetPlayerInstanceId: 'another-player',
  }));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.FOREIGN_TARGET_PLAYER);

  const invalid = playCommand(harness.connection, 'player-connection-old');
  delete invalid.runId;
  firstSocket.receive(invalid);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_PROTOCOL_FRAME);
  assert.equal(commands.length, 0);

  firstSocket.receive(playCommand(harness.connection, 'player-connection-old'));
  assert.equal(commands.length, 1);

  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  firstSocket.receive(playCommand(harness.connection, 'player-connection-old', {
    commandId: 'command-too-late',
  }));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME);
  assert.equal(commands.length, 1);

  secondSocket.open();
  secondSocket.receive(playerWelcome(harness.connection, 'player-connection-new', { leaseEpoch: 2 }));
  secondSocket.receive(playCommand(harness.connection, 'player-connection-new', {
    commandId: 'command-current',
    leaseEpoch: 2,
  }));
  assert.equal(commands.length, 2);
  assert.equal(commands.at(-1).commandId, 'command-current');
});

test('player rejects lease rollback, deduplicates receipts, and permits only activate_output to advance an epoch', () => {
  const commands = [];
  const harness = createHarness('player', {
    onPlayerCommand: (command) => commands.push(command),
  });
  const socket = readyPlayer(harness, 'lease-connection', { leaseEpoch: 5 });
  assert.equal(harness.connection.snapshot().leaseEpoch, 5);

  socket.receive(playCommand(harness.connection, 'lease-connection', {
    commandId: 'stale-lease-command',
    leaseEpoch: 4,
  }));
  assert.equal(commands.length, 0);
  assert.equal(harness.connection.snapshot().leaseEpoch, 5);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_PLAYER_LEASE_EPOCH);

  const current = playCommand(harness.connection, 'lease-connection', {
    commandId: 'deduplicated-command',
    leaseEpoch: 5,
  });
  socket.receive(current);
  socket.receive(current);
  assert.equal(commands.length, 1);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_DUPLICATE);

  socket.receive({ ...current, runId: 'conflicting-run' });
  assert.equal(commands.length, 1);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_ID_CONFLICT);

  socket.receive(playCommand(harness.connection, 'lease-connection', {
    commandId: 'ordinary-cannot-advance',
    leaseEpoch: 6,
  }));
  assert.equal(commands.length, 1);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_PLAYER_LEASE_ADVANCE);

  const activate = activateOutputCommand(harness.connection, 'lease-connection', {
    commandId: 'activate-advances-one',
    leaseEpoch: 6,
  });
  socket.receive(activate);
  socket.receive(activate);
  assert.equal(commands.length, 2);
  assert.equal(harness.connection.snapshot().leaseEpoch, 6);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_DUPLICATE);
});

test('activate_output can recover a missed monotonic lease jump without accepting replay or rollback', () => {
  const commands = [];
  const harness = createHarness('player', {
    onPlayerCommand: (command) => commands.push(command),
  });
  const socket = readyPlayer(harness, 'lease-jump-connection', { leaseEpoch: 1 });
  const jump = activateOutputCommand(harness.connection, 'lease-jump-connection', {
    commandId: 'activate-monotonic-jump',
    switchId: 'switch-monotonic-jump',
    leaseEpoch: 5,
  });

  socket.receive(jump);
  socket.receive(jump);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].leaseEpoch, 5);
  assert.equal(harness.connection.snapshot().leaseEpoch, 5);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_DUPLICATE);

  socket.receive({
    ...jump,
    commandId: 'activate-same-epoch-new-id',
    switchId: 'switch-same-epoch-new-id',
  });
  assert.equal(commands.length, 1);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_PLAYER_LEASE_ADVANCE);

  socket.receive({
    ...jump,
    commandId: 'activate-rollback-new-id',
    switchId: 'switch-rollback-new-id',
    leaseEpoch: 4,
  });
  assert.equal(commands.length, 1);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_PLAYER_LEASE_EPOCH);
});

test('ordinary player commands deduplicate page-wide while emergency stop executes once per connection', () => {
  const commands = [];
  const harness = createHarness('player', {
    onPlayerCommand: (command) => commands.push(command),
  });
  const firstSocket = readyPlayer(harness, 'dedupe-old', { leaseEpoch: 1 });
  const ordinary = playCommand(harness.connection, 'dedupe-old', {
    commandId: 'page-command',
    leaseEpoch: 1,
  });
  const emergencyOld = emergencyStopCommand('dedupe-old');
  firstSocket.receive(ordinary);
  firstSocket.receive(emergencyOld);
  firstSocket.receive(emergencyOld);
  assert.deepEqual(commands.map((command) => command.type), ['play', 'emergency_stop']);

  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  secondSocket.receive(playerWelcome(harness.connection, 'dedupe-new', { leaseEpoch: 1 }));
  secondSocket.receive({ ...ordinary, targetConnectionId: 'dedupe-new' });
  secondSocket.receive(emergencyStopCommand('dedupe-new'));

  assert.deepEqual(commands.map((command) => command.type), [
    'play',
    'emergency_stop',
    'emergency_stop',
  ]);
  assert.equal(harness.connection.playerCommandLedger.snapshot().entries.length, 3);
});

test('saturated critical command tombstones repeat emergency stop safely and disconnect on other new commands', () => {
  const commands = [];
  const harness = createHarness('player', {
    playerCommandHistoryLimit: 1,
    onPlayerCommand: (command) => commands.push(command),
  });
  const socket = readyPlayer(harness, 'critical-capacity', { leaseEpoch: 1 });
  socket.receive(activateOutputCommand(harness.connection, 'critical-capacity', { leaseEpoch: 2 }));
  assert.deepEqual(commands.map((command) => command.type), ['activate_output']);

  const emergency = emergencyStopCommand('critical-capacity');
  socket.receive(emergency);
  socket.receive(emergency);
  assert.deepEqual(commands.map((command) => command.type), [
    'activate_output',
    'emergency_stop',
    'emergency_stop',
  ]);
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);
  assert.equal(
    harness.diagnostics.filter((diagnostic) => (
      diagnostic.code === ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_HISTORY_EXHAUSTED
    )).length,
    2,
  );

  socket.receive({
    type: 'deactivate_output',
    commandId: 'deactivate-while-history-full',
    switchId: 'switch-1',
    leaseEpoch: 2,
    targetPlayerInstanceId: harness.connection.identity.playerInstanceId,
    targetConnectionId: 'critical-capacity',
    controlEpoch: 3,
  });
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.DISCONNECTED);
  assert.equal(commands.length, 3);
});

test('sync and async player command failures are consumed and disconnect the exact current generation', async () => {
  for (const onPlayerCommand of [
    () => { throw new Error('sync_engine_failure'); },
    async () => { throw new Error('async_engine_failure'); },
  ]) {
    const harness = createHarness('player', { onPlayerCommand });
    const socket = readyPlayer(harness);
    socket.receive(playCommand(harness.connection, 'player-connection-1'));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.DISCONNECTED);
    assert.equal(
      harness.diagnostics.some((diagnostic) => (
        diagnostic.code === ON_AIR_V2_CONNECTION_CODES.CALLBACK_FAILED
        && diagnostic.detail.callback === 'onPlayerCommand'
      )),
      true,
    );
    assert.equal(harness.connection.playerCommandLedger.snapshot().entries.length, 1);
  }
});

test('rejected observer callbacks are consumed while durable client state remains inspectable', async () => {
  const harness = createHarness('control', {
    onFrame: async () => { throw new Error('observer_failure'); },
  });
  const socket = readyControl(harness);
  socket.receive({
    type: SERVER_MESSAGE_TYPES.PRESENCE,
    protocolVersion: 2,
    role: 'control',
    connected: true,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.CALLBACK_FAILED);
  assert.equal(harness.diagnostics.at(-1).detail.callback, 'onFrame');
});

test('player reconnect rebinds and retransmits ordinary events but retires emergency ACK', () => {
  const eventResults = [];
  const harness = createHarness('player', {
    onEventResult: (result) => eventResults.push(result),
  });
  const firstSocket = readyPlayer(harness, 'player-connection-old');
  const ordinary = harness.connection.emitEvent(playingEvent());
  const emergency = harness.connection.emitEvent(emergencyAck());
  assert.equal(firstSocket.messages().length, 3);
  assert.equal(ordinary.entry.message.connectionId, 'player-connection-old');
  assert.equal(emergency.entry.message.connectionId, 'player-connection-old');

  firstSocket.serverClose();
  assert.equal(harness.connection.eventOutbox.get(ordinary.entry.eventId).state, 'pending');
  assert.equal(harness.connection.eventOutbox.get(emergency.entry.eventId).state, 'outcome_unknown');
  assert.equal(eventResults.length, 1);
  assert.equal(eventResults[0].status, 'outcome_unknown');
  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  secondSocket.receive(playerWelcome(harness.connection, 'player-connection-new'));

  const secondMessages = secondSocket.messages();
  assert.deepEqual(secondMessages.map((message) => message.type), [
    ON_AIR_MESSAGE_TYPES.PLAYER_HELLO,
    ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT,
  ]);
  const rebound = secondMessages[1];
  assert.equal(rebound.eventId, ordinary.entry.eventId);
  assert.equal(rebound.sequence, ordinary.entry.sequence);
  assert.equal(rebound.connectionId, 'player-connection-new');
  assert.equal(harness.connection.eventOutbox.get(emergency.entry.eventId).state, 'outcome_unknown');
  assert.equal(eventResults.length, 1);

  const ack = {
    type: SERVER_MESSAGE_TYPES.EVENT_ACK,
    protocolVersion: 2,
    eventId: rebound.eventId,
    playerInstanceId: harness.connection.identity.playerInstanceId,
    sequence: rebound.sequence,
    status: 'applied',
  };
  secondSocket.receive(ack);
  secondSocket.receive(ack);
  assert.deepEqual(eventResults.slice(-2).map((result) => result.status), [
    'acknowledged',
    'duplicate_terminal',
  ]);
});

test('player abandons only exact event IDs while disconnected and never retransmits their tombstones', () => {
  const harness = createHarness('player');
  const firstSocket = readyPlayer(harness, 'player-connection-abandon-old');
  const ordinary = harness.connection.emitEvent(playingEvent()).entry;
  const firstMarker = harness.connection.emitEvent(testMarkerEvent()).entry;
  const secondMarker = harness.connection.emitEvent(testMarkerEvent(1)).entry;

  firstSocket.serverClose();
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.DISCONNECTED);
  const result = harness.connection.abandonEvents(
    [firstMarker.eventId],
    { code: 'test_terminalized' },
  );
  assert.deepEqual(result.abandoned.map((entry) => entry.eventId), [firstMarker.eventId]);
  assert.equal(harness.connection.eventOutbox.get(firstMarker.eventId).state, 'abandoned');
  assert.equal(harness.connection.eventOutbox.get(ordinary.eventId).state, 'pending');
  assert.equal(harness.connection.eventOutbox.get(secondMarker.eventId).state, 'pending');

  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  secondSocket.receive(playerWelcome(harness.connection, 'player-connection-abandon-new'));
  const retransmitted = secondSocket.messages().slice(1);
  assert.deepEqual(retransmitted.map((message) => message.eventId), [
    ordinary.eventId,
    secondMarker.eventId,
  ]);
  assert.equal(retransmitted.some((message) => message.eventId === firstMarker.eventId), false);

  const controlHarness = createHarness('control');
  assert.throws(
    () => controlHarness.connection.abandonEvents([firstMarker.eventId]),
    (error) => error.code === ON_AIR_V2_CONNECTION_CODES.INVALID_STATE
      && error.detail.operation === 'abandonEvents',
  );
});

test('replacement, explicit close, superseded, and send failure retire emergency proof exactly once', () => {
  const scenarios = [
    {
      name: 'replacement',
      trigger: ({ harness }) => harness.connection.connect(),
    },
    {
      name: 'explicit_close',
      trigger: ({ harness }) => harness.connection.close(1000, 'fixture_close'),
    },
    {
      name: 'superseded',
      trigger: ({ socket }) => socket.receive({
        type: SERVER_MESSAGE_TYPES.CONNECTION_SUPERSEDED,
        protocolVersion: 2,
        code: 'fixture_superseded',
      }),
    },
  ];

  for (const scenario of scenarios) {
    const eventResults = [];
    const harness = createHarness('player', {
      onEventResult: (result) => eventResults.push(result),
    });
    const socket = readyPlayer(harness, `connection-${scenario.name}`);
    const ordinary = harness.connection.emitEvent(playingEvent()).entry;
    const emergency = harness.connection.emitEvent(emergencyAck()).entry;
    scenario.trigger({ harness, socket });

    assert.equal(harness.connection.eventOutbox.get(ordinary.eventId).state, 'pending');
    assert.equal(harness.connection.eventOutbox.get(emergency.eventId).state, 'outcome_unknown');
    assert.deepEqual(eventResults.map((result) => result.status), ['outcome_unknown']);
  }

  const failedResults = [];
  const failedHarness = createHarness('player', {
    onEventResult: (result) => failedResults.push(result),
  });
  const failedSocket = readyPlayer(failedHarness, 'connection-send-failure');
  failedSocket.failSends = true;
  const failed = failedHarness.connection.emitEvent(emergencyAck());
  assert.equal(failed.status, 'outcome_unknown');
  assert.equal(failed.entry.state, 'outcome_unknown');
  assert.deepEqual(failedResults.map((result) => result.status), ['outcome_unknown']);
});

test('250ms heartbeat hook and exact 500ms/2s liveness thresholds are deterministic', () => {
  const commands = [];
  const harness = createHarness('player', {
    heartbeatPayload: ({ now }) => ({ runtime: { sampleAt: now } }),
    onPlayerCommand: (command) => commands.push(command),
  });
  const socket = readyPlayer(harness);
  assert.equal(harness.connection.livenessSnapshot().state, 'healthy');

  harness.clock.advance(250);
  let heartbeats = socket.messages().filter((message) => message.type === 'player_heartbeat');
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].sequence, 0);
  assert.equal(heartbeats[0].monotonicTimeMs, 250);
  assert.equal(heartbeats[0].runtime.sampleAt, 250);
  assert.equal(validateOnAirMessage(heartbeats[0]).ok, true);

  harness.clock.advance(249);
  assert.equal(harness.connection.livenessSnapshot().state, 'healthy');
  harness.clock.advance(1);
  assert.deepEqual(harness.connection.livenessSnapshot(), {
    state: 'warning',
    warning: true,
    unknown: false,
    ageMs: 500,
    code: 'liveness_warning',
  });
  harness.clock.advance(1_500);
  assert.deepEqual(harness.connection.livenessSnapshot(), {
    state: 'unknown',
    warning: false,
    unknown: true,
    ageMs: 2_000,
    code: 'liveness_unknown',
  });

  heartbeats = socket.messages().filter((message) => message.type === 'player_heartbeat');
  assert.equal(heartbeats.length, 8);
  socket.receive(playCommand(harness.connection, 'player-connection-1', {
    commandId: 'foreign-command-must-not-refresh-liveness',
    targetPlayerInstanceId: 'another-player',
  }));
  assert.equal(commands.length, 0);
  assert.equal(harness.connection.livenessSnapshot().state, 'unknown');

  socket.receive({
    type: 'activate_output',
    commandId: 'command-refresh-liveness',
    switchId: 'switch-refresh-liveness',
    leaseEpoch: 2,
    targetPlayerInstanceId: harness.connection.identity.playerInstanceId,
    targetConnectionId: 'player-connection-1',
    controlEpoch: 3,
    payload: { outputMode: 'obs' },
  });
  assert.equal(commands.length, 1);
  assert.equal(harness.connection.livenessSnapshot().state, 'healthy');
  harness.clock.advance(250);
  heartbeats = socket.messages().filter((message) => message.type === 'player_heartbeat');
  assert.equal(heartbeats.at(-1).leaseEpoch, 2);
  assert.equal(heartbeats.at(-1).sequence, 8);
});

test('heartbeat ACK is concrete round-trip evidence and exposes only bounded transport truth', () => {
  const harness = createHarness('player');
  const socket = readyPlayer(harness, 'heartbeat-proof-connection', { leaseEpoch: 1 });

  harness.clock.advance(500);
  let heartbeats = socket.messages().filter((message) => message.type === 'player_heartbeat');
  assert.deepEqual(heartbeats.map((message) => message.sequence), [0, 1]);
  assert.equal(harness.connection.livenessSnapshot().state, 'warning');
  assert.deepEqual(harness.connection.snapshot().heartbeatRoundTrip, {
    lastSentSequence: 1,
    lastAckSequence: null,
    lastAckAt: null,
  });

  socket.receive(heartbeatAck(harness.connection, 'heartbeat-proof-connection', 0));
  assert.equal(harness.connection.livenessSnapshot().state, 'healthy');
  assert.deepEqual(harness.connection.snapshot().heartbeatRoundTrip, {
    lastSentSequence: 1,
    lastAckSequence: 0,
    lastAckAt: 500,
  });

  harness.clock.advance(250);
  socket.receive(heartbeatAck(harness.connection, 'heartbeat-proof-connection', 2));
  harness.clock.advance(500);
  heartbeats = socket.messages().filter((message) => message.type === 'player_heartbeat');
  assert.equal(heartbeats.at(-1).sequence, 4);
  assert.equal(harness.connection.livenessSnapshot().state, 'warning');

  const rejected = [
    [heartbeatAck(harness.connection, 'heartbeat-proof-connection', 2), ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_DUPLICATE],
    [heartbeatAck(harness.connection, 'heartbeat-proof-connection', 1), ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_OUT_OF_ORDER],
    [heartbeatAck(harness.connection, 'heartbeat-proof-connection', 99), ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FUTURE_SEQUENCE],
    [heartbeatAck(harness.connection, 'heartbeat-proof-connection', 4, {
      playerInstanceId: 'foreign-player',
    }), ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FOREIGN_PLAYER],
    [heartbeatAck(harness.connection, 'foreign-connection', 4), ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FOREIGN_CONNECTION],
  ];
  for (const [frame, code] of rejected) {
    socket.receive(frame);
    assert.equal(harness.diagnostics.at(-1).code, code);
    assert.equal(harness.connection.livenessSnapshot().state, 'warning');
    assert.equal(harness.connection.snapshot().heartbeatRoundTrip.lastAckSequence, 2);
  }

  socket.receive(heartbeatAck(harness.connection, 'heartbeat-proof-connection', 4, {
    leaseEpoch: 0,
  }));
  assert.equal(harness.connection.livenessSnapshot().state, 'healthy');
  assert.equal(harness.connection.snapshot().leaseEpoch, 1);

  harness.clock.advance(250);
  socket.receive(heartbeatAck(harness.connection, 'heartbeat-proof-connection', 5, {
    leaseEpoch: 5,
  }));
  const snapshot = harness.connection.snapshot();
  assert.equal(snapshot.leaseEpoch, 5);
  assert.deepEqual(snapshot.heartbeatRoundTrip, {
    lastSentSequence: 5,
    lastAckSequence: 5,
    lastAckAt: 1_500,
  });
  assert.equal(Object.isFrozen(snapshot.heartbeatRoundTrip), true);
  assert.deepEqual(Object.keys(snapshot.heartbeatRoundTrip), [
    'lastSentSequence',
    'lastAckSequence',
    'lastAckAt',
  ]);
});

test('heartbeat ACK binding resets on replacement and old socket proof is fenced', () => {
  const harness = createHarness('player');
  const oldSocket = readyPlayer(harness, 'heartbeat-old-connection');
  harness.clock.advance(250);
  assert.equal(harness.connection.snapshot().heartbeatRoundTrip.lastSentSequence, 0);

  harness.connection.connect();
  assert.deepEqual(harness.connection.snapshot().heartbeatRoundTrip, {
    lastSentSequence: null,
    lastAckSequence: null,
    lastAckAt: null,
  });
  oldSocket.receive(heartbeatAck(harness.connection, 'heartbeat-old-connection', 0));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME);

  const newSocket = harness.sockets.at(-1);
  newSocket.open();
  newSocket.receive(playerWelcome(harness.connection, 'heartbeat-new-connection', { leaseEpoch: 1 }));
  harness.clock.advance(250);
  const newHeartbeat = newSocket.messages().find((message) => message.type === 'player_heartbeat');
  assert.equal(newHeartbeat.sequence, 1);
  assert.equal(harness.connection.snapshot().heartbeatRoundTrip.lastAckSequence, null);

  oldSocket.receive(heartbeatAck(harness.connection, 'heartbeat-old-connection', 0));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME);
  newSocket.receive(heartbeatAck(harness.connection, 'heartbeat-new-connection', 1));
  assert.equal(harness.connection.snapshot().heartbeatRoundTrip.lastAckSequence, 1);
});

test('control role diagnoses heartbeat ACK without using it as liveness evidence', () => {
  const harness = createHarness('control');
  const socket = readyControl(harness, 'control-heartbeat-connection');
  harness.clock.advance(500);
  assert.equal(harness.connection.livenessSnapshot().state, 'warning');
  socket.receive({
    type: SERVER_MESSAGE_TYPES.HEARTBEAT_ACK,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    playerInstanceId: 'player-a',
    connectionId: 'player-connection-a',
    leaseEpoch: 0,
    sequence: 0,
  });
  assert.equal(
    harness.diagnostics.at(-1).code,
    ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_UNEXPECTED_ROLE,
  );
  assert.equal(harness.connection.livenessSnapshot().state, 'warning');
  assert.deepEqual(harness.connection.snapshot().heartbeatRoundTrip, {
    lastSentSequence: null,
    lastAckSequence: null,
    lastAckAt: null,
  });
});

test('injected wall-clock regression cannot lower monotonic evidence or create negative liveness age', () => {
  const clock = new FakeClock();
  clock.time = 1_000;
  const harness = createHarness('player', { clock });
  readyPlayer(harness);
  assert.equal(harness.connection.livenessSnapshot().ageMs, 0);

  clock.time = 100;
  assert.deepEqual(harness.connection.livenessSnapshot(), {
    state: 'healthy',
    warning: false,
    unknown: false,
    ageMs: 0,
    code: 'liveness_healthy',
  });

  clock.time = 1_500;
  assert.equal(harness.connection.livenessSnapshot().state, 'warning');
  assert.equal(harness.connection.livenessSnapshot().ageMs, 500);
});

test('invalid encodings, malformed JSON, bad shared frames, and foreign welcomes are ignored', () => {
  const frames = [];
  const harness = createHarness('control', {
    onFrame: (frame) => frames.push(frame),
  });
  harness.connection.connect();
  const socket = harness.sockets[0];
  socket.open();

  socket.receiveRaw(new Uint8Array([1, 2, 3]));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_FRAME_ENCODING);
  socket.receiveRaw('{');
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_FRAME_JSON);
  socket.receive({ type: 'not_a_protocol_type' });
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.INVALID_PROTOCOL_FRAME);

  socket.receive(controlWelcome(harness.connection, 'foreign-connection', {
    controlInstanceId: 'another-control',
    writableControlInstanceId: 'another-control',
  }));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.FOREIGN_WELCOME_IDENTITY);
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.NEGOTIATING);

  socket.receive(controlWelcome(harness.connection));
  socket.receive(controlWelcome(harness.connection));
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.UNEXPECTED_WELCOME);
  assert.equal(frames.length, 0);
});

test('socket generation race cannot bind a late welcome from the replaced socket', () => {
  const harness = createHarness('control');
  harness.connection.connect();
  const firstSocket = harness.sockets[0];
  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  assert.equal(firstSocket.readyState, 3);

  firstSocket.open();
  firstSocket.receive(controlWelcome(harness.connection, 'stale-connection'));
  assert.equal(harness.connection.connectionId, null);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME);

  secondSocket.open();
  secondSocket.receive(controlWelcome(harness.connection, 'current-connection'));
  assert.equal(harness.connection.connectionId, 'current-connection');
  assert.equal(harness.connection.snapshot().generation, 2);
});

test('a stale negotiation completion closure cannot complete a replacement generation', () => {
  const completions = [];
  const harness = createHarness('control', {
    onNegotiationExtension: ({ complete }) => {
      completions.push(complete);
      return { defer: true };
    },
  });

  harness.connection.connect();
  const firstSocket = harness.sockets[0];
  firstSocket.open();
  firstSocket.receive(controlWelcome(harness.connection, 'negotiation-old'));
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION);

  harness.connection.connect();
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  secondSocket.receive(controlWelcome(harness.connection, 'negotiation-new'));
  assert.equal(completions.length, 2);
  assert.equal(completions[0](), false);
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION);
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.STALE_NEGOTIATION_COMPLETION);

  assert.equal(completions[1](), true);
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);
  assert.equal(harness.connection.connectionId, 'negotiation-new');
});

test('connection_superseded fences all later frames and future resume is hook-only', () => {
  let deferNegotiation = true;
  const harness = createHarness('control', {
    onNegotiationExtension: () => ({ defer: deferNegotiation }),
  });
  harness.connection.connect();
  const socket = harness.sockets[0];
  socket.open();
  const hello = socket.messages()[0];
  assert.equal('resumeToken' in hello, false);
  assert.equal('reconcile' in hello, false);

  socket.receive(controlWelcome(harness.connection));
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION);
  deferNegotiation = false;
  harness.connection.completeNegotiation();
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);

  const requested = harness.connection.requestCommand(displayCommand());
  socket.receive({
    type: SERVER_MESSAGE_TYPES.CONNECTION_SUPERSEDED,
    protocolVersion: 2,
    code: 'newer_connection',
  });
  assert.equal(harness.connection.state, ON_AIR_V2_CONNECTION_STATES.SUPERSEDED);
  assert.equal(harness.connection.commandLedger.get(requested.entry.commandId).state, 'outcome_unknown');
  assert.equal(harness.connection.livenessSnapshot().state, 'unknown');

  socket.receive({
    type: SERVER_MESSAGE_TYPES.COMMAND_ACK,
    protocolVersion: 2,
    commandId: requested.entry.commandId,
  });
  assert.equal(harness.diagnostics.at(-1).code, ON_AIR_V2_CONNECTION_CODES.SUPERSEDED_SOCKET_FRAME);
  assert.equal(harness.connection.commandLedger.get(requested.entry.commandId).state, 'outcome_unknown');
});
