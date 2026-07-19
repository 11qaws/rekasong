import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRoom } from '../workers/rekasong-session/src/index.js';
import {
  evaluateOnAirPlayerCommandIdentity,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from '../src/lib/onAirProtocol.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
    this.puts = [];
    this.failNextPut = null;
    this.pauseNextPut = null;
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    if (this.failNextPut) {
      const error = this.failNextPut;
      this.failNextPut = null;
      throw error;
    }
    if (this.pauseNextPut) {
      const pause = this.pauseNextPut;
      this.pauseNextPut = null;
      pause.markEntered();
      await pause.waitForRelease;
    }
    const copy = structuredClone(value);
    this.values.set(key, copy);
    this.puts.push({ key, value: copy });
  }

  async setAlarm(value) {
    this.alarm = value;
  }

  async deleteAlarm() {
    this.alarm = null;
  }

  async deleteAll() {
    this.values.clear();
  }
}

function pauseNextStoragePut(storage) {
  let markEntered;
  let release;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  storage.pauseNextPut = { markEntered, waitForRelease };
  return { entered, release };
}

class MockSocket {
  constructor(context, role) {
    this.context = context;
    this.attachment = {
      role,
      protocolVersion: 1,
      connectionId: crypto.randomUUID(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.messages = [];
    this.closed = false;
    this.failNextSend = null;
    this.failNextSerialize = null;
  }

  deserializeAttachment() {
    return this.attachment;
  }

  serializeAttachment(value) {
    if (this.failNextSerialize) {
      const error = this.failNextSerialize;
      this.failNextSerialize = null;
      throw error;
    }
    this.attachment = structuredClone(value);
  }

  send(rawMessage) {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = null;
      throw error;
    }
    this.messages.push(JSON.parse(rawMessage));
  }

  close() {
    this.closed = true;
    this.context.sockets = this.context.sockets.filter((socket) => socket !== this);
  }
}

function createHarness() {
  const storage = new MemoryStorage();
  const context = {
    storage,
    sockets: [],
    getWebSockets() {
      return this.sockets;
    },
  };
  const session = {
    room: 'protocol-v2-room',
    status: 'active',
    assets: {},
    transport: { status: 'idle', song: null, sessionId: null, position: 0, volume: 100 },
    display: { currentSong: null, history: [] },
  };
  const room = new SessionRoom(context, {});
  room.sessionState = session;

  const socket = (role) => {
    const result = new MockSocket(context, role);
    context.sockets.push(result);
    return result;
  };
  const send = (target, message) => room.webSocketMessage(target, JSON.stringify(message));
  return { storage, context, session, room, socket, send };
}

const findMessage = (socket, predicate) => socket.messages.find(predicate);
const messagesOfType = (socket, type) => socket.messages.filter((message) => message.type === type);
const terminalResults = (socket, commandId) => socket.messages.filter((message) => (
  (message.type === 'command_ack' || message.type === 'command_rejected')
  && message.commandId === commandId
));
const hasCachedCommand = (socket, commandId) => Boolean(
  socket.deserializeAttachment().commandResultCache?.some((entry) => entry.i === commandId),
);
const assertValidOutboundPlayerCommand = (message) => {
  const validation = validateOnAirPlayerCommand(message);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const expected = Object.fromEntries(Object.entries({
    targetPlayerInstanceId: message.targetPlayerInstanceId,
    leaseEpoch: message.leaseEpoch,
    controlEpoch: message.controlEpoch,
    switchId: message.switchId,
    checkId: message.checkId,
    entryId: message.entryId,
    runId: message.runId,
    sessionId: message.sessionId,
    authenticatedControlInstanceId: message.authenticatedControlInstanceId,
    connectionId: message.targetConnectionId,
  }).filter(([, value]) => value !== undefined));
  const identity = evaluateOnAirPlayerCommandIdentity(message, expected);
  assert.equal(identity.accepted, true, JSON.stringify(identity));
};
const optIntoProtocolV2 = (socket) => {
  socket.serializeAttachment({
    ...socket.deserializeAttachment(),
    protocolVersion: 2,
    negotiationState: 'unnegotiated',
  });
};

async function registerControl(harness, socket, controlInstanceId = 'control-a') {
  optIntoProtocolV2(socket);
  await harness.send(socket, {
    type: 'control_hello',
    protocolVersion: 2,
    controlInstanceId,
    buildId: 'test-build',
    capabilities: {},
  });
  return findMessage(socket, (message) => message.type === 'control_welcome');
}

async function registerPlayer(harness, socket, {
  playerInstanceId = 'player-a',
  clientKind = 'obs-browser-source',
  capabilities = { obsRuntime: true, analyser: true },
  runtime = null,
} = {}) {
  optIntoProtocolV2(socket);
  const resolvedRuntime = runtime ?? (
    clientKind === 'obs-browser-source' ? { sourceActive: true } : {}
  );
  await harness.send(socket, {
    type: 'player_hello',
    protocolVersion: 2,
    playerInstanceId,
    clientKind,
    buildId: 'test-build',
    capabilities,
    runtime: resolvedRuntime,
  });
  return findMessage(socket, (message) => message.type === 'player_welcome');
}

async function activateOutput(harness, control, playerInstanceId = 'player-a', outputMode = 'obs') {
  const protocol = harness.session.protocolV2;
  await harness.send(control, {
    type: 'activate_output',
    commandId: `activate-${playerInstanceId}`,
    switchId: `switch-${playerInstanceId}`,
    leaseEpoch: protocol.leaseEpoch,
    targetPlayerInstanceId: playerInstanceId,
    controlEpoch: protocol.controlEpoch,
    payload: { outputMode },
  });
  return harness.session.protocolV2.leaseEpoch;
}

function outputReadyEvent(player, playerInstanceId, leaseEpoch, sequence = 0, overrides = {}) {
  return {
    type: 'route_event',
    event: 'output_ready',
    eventId: `route-ready-${sequence}`,
    sequence,
    playerInstanceId,
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: `switch-${playerInstanceId}`,
    monotonicTimeMs: sequence + 1,
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

async function confirmOutputReady(harness, player, playerInstanceId, leaseEpoch, sequence = 0) {
  await harness.send(player, outputReadyEvent(player, playerInstanceId, leaseEpoch, sequence));
}

async function prepareActiveOutputTest(checkId) {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const connectionId = player.deserializeAttachment().connectionId;

  await harness.send(control, {
    type: 'start_test',
    commandId: `start-${checkId}`,
    checkId,
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  await harness.send(player, {
    type: 'test_event',
    event: 'test_started',
    eventId: `started-${checkId}`,
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId,
    monotonicTimeMs: 1,
  });

  return { harness, control, player, leaseEpoch, connectionId, checkId };
}

async function loadRun(harness, control, leaseEpoch, {
  entryId = 'entry-a',
  runId = 'run-a',
  commandId = 'load-run-a',
} = {}) {
  await harness.send(control, {
    type: 'load',
    commandId,
    entryId,
    runId,
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'song-a', type: 'local' }, position: 0, volume: 80 },
  });
  return { entryId, runId, commandId };
}

async function stopRun(harness, control, leaseEpoch, {
  entryId = 'entry-a',
  runId = 'run-a',
  commandId = 'stop-run-a',
} = {}) {
  await harness.send(control, {
    type: 'stop',
    commandId,
    entryId,
    runId,
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
}

test('legacy command/event contract remains compatible before any v2 control lease exists', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');

  await harness.send(control, {
    type: 'command',
    command: {
      type: 'load',
      commandId: 'legacy-load',
      sessionId: 'legacy-run',
      song: { id: 'song-a', title: 'fixture', type: 'local' },
      position: 0,
      volume: 72,
    },
  });

  assert.ok(findMessage(control, (message) => message.type === 'command_ack' && message.commandId === 'legacy-load'));
  assert.ok(findMessage(player, (message) => message.type === 'command' && message.command.type === 'load'));

  await harness.send(player, {
    type: 'event',
    event: { type: 'playing', sessionId: 'legacy-run', position: 1.25, duration: 10 },
  });
  assert.equal(harness.session.transport.status, 'playing');
  assert.equal(harness.session.transport.position, 1.25);
});

test('legacy audible commands require exactly one player instead of broadcasting double audio', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const firstPlayer = harness.socket('player');
  const secondPlayer = harness.socket('player');

  await harness.send(control, {
    type: 'command',
    command: {
      type: 'load',
      commandId: 'legacy-duplicate-load',
      sessionId: 'legacy-duplicate-run',
      song: { id: 'song-a', title: 'fixture', type: 'local' },
    },
  });

  const rejection = findMessage(control, (message) => message.code === 'legacy_player_count');
  assert.deepEqual(rejection.detail, { expected: 1, actual: 2 });
  assert.equal(messagesOfType(firstPlayer, 'command').length, 0);
  assert.equal(messagesOfType(secondPlayer, 'command').length, 0);
  assert.equal(harness.session.transport.status, 'idle');
});

test('protocol=2 opt-in sockets cannot receive legacy commands or emit legacy events before hello', async () => {
  const harness = createHarness();
  const legacyControl = harness.socket('control');
  const legacyPlayer = harness.socket('player');
  const pendingPlayer = harness.socket('player');
  optIntoProtocolV2(pendingPlayer);

  await harness.send(legacyControl, {
    type: 'command',
    command: {
      type: 'load',
      commandId: 'legacy-race-load',
      sessionId: 'legacy-race-run',
      song: { id: 'song-race', title: 'fixture', type: 'local' },
      position: 0,
      volume: 100,
    },
  });
  assert.ok(findMessage(legacyPlayer, (message) => message.type === 'command'));
  assert.equal(messagesOfType(pendingPlayer, 'command').length, 0);

  harness.session.transport.status = 'playing';
  await harness.send(pendingPlayer, {
    type: 'event',
    event: { type: 'paused', sessionId: 'legacy-race-run', position: 0 },
  });
  assert.equal(harness.session.transport.status, 'playing');
  assert.equal(findMessage(pendingPlayer, (message) => message.code === 'unknown_message_type').type, 'protocol_error');

  const querylessUpgrade = harness.socket('player');
  await harness.send(querylessUpgrade, {
    type: 'player_hello',
    protocolVersion: 2,
    playerInstanceId: 'invalid-upgrade',
    clientKind: 'generic-browser',
    buildId: 'test-build',
    capabilities: {},
  });
  assert.equal(findMessage(querylessUpgrade, (message) => message.code === 'protocol_opt_in_required').type, 'protocol_error');
  assert.equal(querylessUpgrade.closed, true);
});

test('control hello is non-stealing and takeover uses an explicit epoch CAS', async () => {
  const harness = createHarness();
  const first = harness.socket('control');
  const second = harness.socket('control');

  const firstWelcome = await registerControl(harness, first, 'control-a');
  const secondWelcome = await registerControl(harness, second, 'control-b');
  assert.equal(firstWelcome.writable, true);
  assert.equal(firstWelcome.controlEpoch, 1);
  assert.equal(secondWelcome.writable, false);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, 'control-a');

  await harness.send(second, {
    type: 'control_takeover',
    commandId: 'takeover-stale',
    controlInstanceId: 'control-b',
    expectedControlEpoch: 0,
  });
  assert.equal(findMessage(second, (message) => message.commandId === 'takeover-stale').code, 'stale_control_epoch');
  assert.equal(harness.session.protocolV2.controlEpoch, 1);

  await harness.send(second, {
    type: 'control_takeover',
    commandId: 'takeover-current',
    controlInstanceId: 'control-b',
    expectedControlEpoch: 1,
  });
  assert.equal(harness.session.protocolV2.controlEpoch, 2);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, 'control-b');

  await harness.send(first, {
    type: 'pause',
    commandId: 'old-owner-command',
    entryId: 'entry-a',
    runId: 'run-a',
    leaseEpoch: 0,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: 1,
  });
  assert.equal(findMessage(first, (message) => message.commandId === 'old-owner-command').code, 'control_lease_read_only');
});

test('a persisted control owner without a live negotiated socket expires on the next hello', async () => {
  const harness = createHarness();
  const first = harness.socket('control');
  await registerControl(harness, first, 'control-a');
  assert.equal(harness.session.protocolV2.controlEpoch, 1);

  harness.context.sockets = harness.context.sockets.filter((socket) => socket !== first);
  const replacement = harness.socket('control');
  const welcome = await registerControl(harness, replacement, 'control-b');
  assert.equal(welcome.writable, true);
  assert.equal(welcome.controlEpoch, 2);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, 'control-b');
});

test('closing the writable v2 control releases its stored owner for safe legacy rollback', async () => {
  const harness = createHarness();
  const v2Control = harness.socket('control');
  const legacyControl = harness.socket('control');
  const legacyPlayer = harness.socket('player');
  await registerControl(harness, v2Control, 'control-a');

  await harness.room.webSocketClose(v2Control);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, null);
  assert.equal(harness.session.protocolV2.controlEpoch, 2);

  await harness.send(legacyControl, {
    type: 'command',
    command: {
      type: 'load',
      commandId: 'legacy-after-v2-close',
      sessionId: 'legacy-after-v2-close-run',
      song: { id: 'song-a', type: 'local' },
    },
  });
  assert.ok(findMessage(legacyControl, (message) => message.commandId === 'legacy-after-v2-close'));
  assert.ok(findMessage(legacyPlayer, (message) => message.type === 'command'));
});

test('single output lease targets only the eligible player and rejects stale run identity', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const obsPlayer = harness.socket('player');
  const speakerPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, obsPlayer);
  await registerPlayer(harness, speakerPlayer, {
    playerInstanceId: 'speaker-a',
    clientKind: 'dashboard-speaker',
    capabilities: { analyser: true },
  });

  const leaseEpoch = await activateOutput(harness, control);
  assert.equal(leaseEpoch, 1);
  assert.equal(harness.session.protocolV2.leaseTarget, 'player-a');
  assert.ok(findMessage(obsPlayer, (message) => message.type === 'activate_output' && message.leaseEpoch === 1));
  assert.equal(messagesOfType(speakerPlayer, 'activate_output').length, 0);

  await confirmOutputReady(harness, obsPlayer, 'player-a', leaseEpoch);
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');

  await harness.send(control, {
    type: 'load',
    commandId: 'load-run-a',
    entryId: 'entry-a',
    runId: 'run-a',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: 1,
    payload: { song: { id: 'song-a', type: 'local' }, position: 0, volume: 80 },
  });
  assert.ok(findMessage(obsPlayer, (message) => message.type === 'load' && message.runId === 'run-a'));
  assert.equal(messagesOfType(speakerPlayer, 'load').length, 0);

  await harness.send(obsPlayer, {
    type: 'playback_event',
    event: 'ready',
    eventId: 'ready-a',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: obsPlayer.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'entry-a',
    runId: 'wrong-run',
    monotonicTimeMs: 2,
    mediaTime: 0,
    duration: 30,
    readyState: 4,
    paused: true,
  });
  assert.equal(findMessage(obsPlayer, (message) => message.code === 'stale_run_identity').type, 'protocol_error');
  assert.notEqual(harness.session.transport.status, 'ready');

  await harness.send(obsPlayer, {
    type: 'playback_event',
    event: 'ready',
    eventId: 'ready-b',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: obsPlayer.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'entry-a',
    runId: 'run-a',
    monotonicTimeMs: 3,
    mediaTime: 0,
    duration: 30,
    readyState: 4,
    paused: true,
  });
  assert.equal(harness.session.transport.status, 'ready');

  await harness.send(obsPlayer, {
    type: 'playback_event',
    event: 'command_failed',
    eventId: 'command-failed-a',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: obsPlayer.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'entry-a',
    runId: 'run-a',
    commandId: 'load-run-a',
    monotonicTimeMs: 4,
    code: 'media_apply_failed',
    detail: { phase: 'load' },
  });
  assert.equal(harness.session.protocolV2.confirmedPlayback.event, 'command_failed');
});

test('duplicate eligible OBS candidates block activation instead of picking one implicitly', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const firstPlayer = harness.socket('player');
  const secondPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, firstPlayer, { playerInstanceId: 'obs-a' });
  await registerPlayer(harness, secondPlayer, { playerInstanceId: 'obs-b' });

  await harness.send(control, {
    type: 'activate_output',
    commandId: 'ambiguous-output',
    switchId: 'ambiguous-switch',
    leaseEpoch: 0,
    targetPlayerInstanceId: 'obs-a',
    controlEpoch: 1,
    payload: { outputMode: 'obs' },
  });
  const rejection = findMessage(control, (message) => message.commandId === 'ambiguous-output');
  assert.equal(rejection.type, 'command_rejected');
  assert.equal(rejection.code, 'output_candidate_count');
  assert.equal(rejection.detail.count, 2);
  assert.equal(harness.session.protocolV2.leaseTarget, null);
});

test('route acknowledgement proves a paused, detached, ready and non-audible output path', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);

  await harness.send(player, {
    type: 'route_event',
    event: 'output_ready',
    eventId: 'legacy-ready-shape',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'switch-player-a',
    monotonicTimeMs: 1,
    postcondition: { mediaPaused: true, sourceAttached: true, audible: false },
  });
  assert.equal(findMessage(player, (message) => message.code === 'invalid_route_event').type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');

  await harness.send(player, {
    type: 'route_event',
    event: 'output_ready',
    eventId: 'unsafe-ready',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'switch-player-a',
    monotonicTimeMs: 1,
    postcondition: {
      mediaPaused: false,
      sourceDetached: false,
      autoplayCancelled: false,
      outputPathReady: false,
      audible: true,
    },
  });
  assert.equal(messagesOfType(player, 'protocol_error').length, 2);
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');

  await harness.send(player, outputReadyEvent(player, 'player-a', leaseEpoch, 0, {
    eventId: 'ready-with-unexpected-proof',
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: true,
      audible: false,
      sourceAttached: false,
    },
  }));
  assert.equal(messagesOfType(player, 'protocol_error').length, 3);
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');

  await confirmOutputReady(harness, player, 'player-a', leaseEpoch, 0);
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.deepEqual(harness.session.protocolV2.confirmedPlayback, {
    status: 'unknown',
    reasonCode: 'output_ready_no_playback',
  });
  assert.equal(player.deserializeAttachment().state, 'ready');
});

test('only authoritative playback evidence moves a ready lease into and out of audible', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'audible-entry',
    runId: 'audible-run',
    commandId: 'audible-load',
  });
  const base = {
    type: 'playback_event',
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'audible-entry',
    runId: 'audible-run',
  };

  await harness.send(player, {
    ...base,
    event: 'command_applied',
    eventId: 'audible-command-applied',
    sequence: 0,
    monotonicTimeMs: 1,
    commandId: 'audible-load',
    postcondition: { status: 'loading' },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');

  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'audible-playing',
    sequence: 1,
    monotonicTimeMs: 2,
    mediaTime: 0,
    paused: false,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');
  assert.equal(messagesOfType(control, 'player_snapshot').at(-1).lease.status, 'audible');

  await harness.send(player, {
    ...base,
    event: 'paused',
    eventId: 'audible-paused',
    sequence: 2,
    monotonicTimeMs: 3,
    mediaTime: 1,
    paused: true,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(messagesOfType(control, 'player_snapshot').at(-1).lease.status, 'ready');

  await harness.send(player, {
    ...base,
    event: 'position',
    eventId: 'audible-position-is-not-proof',
    sequence: 0,
    monotonicTimeMs: 4,
    mediaTime: 1.25,
    duration: 30,
    readyState: 4,
    paused: false,
    seeking: false,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');

  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'audible-playing-again',
    sequence: 3,
    monotonicTimeMs: 5,
    mediaTime: 1.25,
    paused: false,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');

  await harness.send(player, {
    ...base,
    event: 'buffering',
    eventId: 'audible-buffering',
    sequence: 4,
    monotonicTimeMs: 6,
    mediaTime: 1.5,
    readyState: 1,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');

  await harness.send(player, {
    ...base,
    event: 'error',
    eventId: 'audible-error',
    sequence: 5,
    monotonicTimeMs: 7,
    code: 'media_decode_failed',
    detail: { phase: 'decode' },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'error');
});

test('strong STOP proof atomically confirms stopped, clears the run, survives retry, and never remains audible', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'stop-entry',
    runId: 'stop-run',
    commandId: 'stop-load',
  });
  const base = {
    type: 'playback_event',
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'stop-entry',
    runId: 'stop-run',
  };
  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'stop-playing',
    sequence: 0,
    monotonicTimeMs: 1,
    mediaTime: 9,
    paused: false,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');

  await stopRun(harness, control, leaseEpoch, {
    entryId: 'stop-entry',
    runId: 'stop-run',
    commandId: 'strong-stop-command',
  });
  assert.equal(harness.session.protocolV2.desiredTransport.status, 'stopped');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');

  const strongPostcondition = {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  };
  const malformedStop = {
    ...base,
    event: 'command_applied',
    eventId: 'stop-missing-command-type',
    sequence: 1,
    monotonicTimeMs: 2,
    commandId: 'strong-stop-command',
    postcondition: strongPostcondition,
  };
  await harness.send(player, malformedStop);
  assert.equal(findMessage(player, (message) => (
    message.type === 'protocol_error' && message.code === 'invalid_playback_event'
  )).type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'stop-entry',
    runId: 'stop-run',
  });

  await harness.send(player, {
    ...malformedStop,
    eventId: 'stop-lowercase-command-type',
    commandType: 'stop',
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'invalid_playback_event'
  )).length, 2);

  await harness.send(player, {
    ...base,
    event: 'command_failed',
    eventId: 'stop-false-safety-proof',
    sequence: 1,
    monotonicTimeMs: 3,
    commandId: 'failed-stop-command',
    code: 'pause_failed',
    safetyPostcondition: { ...strongPostcondition, audible: true },
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'invalid_playback_event'
  )).length, 3);
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');

  const stopEvent = {
    ...malformedStop,
    eventId: 'strong-stop-proof',
    commandType: 'STOP',
  };
  const sessionBeforeFailure = structuredClone(harness.session);
  const acknowledgementsBefore = messagesOfType(player, 'event_ack').length;
  harness.storage.failNextPut = new Error('strong_stop_storage_failure');
  await assert.rejects(harness.send(player, stopEvent), /strong_stop_storage_failure/);
  assert.deepEqual(harness.session, sessionBeforeFailure);
  assert.equal(player.deserializeAttachment().sequenceHighWater.runAuthoritative, 0);
  assert.equal(messagesOfType(player, 'event_ack').length, acknowledgementsBefore);
  assert.equal(Boolean(player.deserializeAttachment().eventResultCache?.some((entry) => (
    entry.i === stopEvent.eventId
  ))), false);

  await harness.send(player, structuredClone(stopEvent));
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(harness.session.protocolV2.activeFamily, null);
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'stopped');
  assert.equal(harness.session.protocolV2.confirmedPlayback.event, 'command_applied');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'stop_command_applied');
  assert.equal(harness.session.protocolV2.confirmedPlayback.audible, false);
  assert.equal(harness.session.transport.status, 'stopped');
  assert.equal(harness.session.transport.position, 0);
  assert.equal(messagesOfType(control, 'player_snapshot').at(-1).lease.status, 'ready');

  await harness.send(player, structuredClone(stopEvent));
  const stopAcks = messagesOfType(player, 'event_ack').filter((message) => (
    message.eventId === stopEvent.eventId
  ));
  assert.deepEqual(stopAcks.map((message) => message.status), ['applied', 'duplicate']);
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'stopped');

  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'stale-playing-after-stop',
    sequence: 2,
    monotonicTimeMs: 4,
    mediaTime: 10,
    paused: false,
  });
  assert.equal(findMessage(player, (message) => (
    message.type === 'protocol_error' && message.code === 'stale_run_identity'
      && message.detail?.actual?.runId === 'stop-run'
  )).type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'stopped');
  assert.equal(messagesOfType(player, 'event_ack').some((message) => (
    message.eventId === 'stale-playing-after-stop'
  )), false);
});

test('command failure changes confirmed truth to stopped only with an exact safety proof', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'failed-command-entry',
    runId: 'failed-command-run',
    commandId: 'failed-command-load',
  });
  const base = {
    type: 'playback_event',
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'failed-command-entry',
    runId: 'failed-command-run',
  };
  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'failed-command-playing',
    sequence: 0,
    monotonicTimeMs: 1,
    mediaTime: 3,
    paused: false,
  });

  await harness.send(player, {
    ...base,
    event: 'command_failed',
    eventId: 'failed-command-without-proof',
    sequence: 1,
    monotonicTimeMs: 2,
    commandId: 'pause-without-proof',
    code: 'pause_failed',
  });
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');
  assert.equal(harness.session.protocolV2.confirmedPlayback.event, 'command_failed');
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.equal(harness.session.transport.status, 'playing');
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'failed-command-entry',
    runId: 'failed-command-run',
  });

  await harness.send(player, {
    ...base,
    event: 'command_failed',
    eventId: 'failed-command-with-proof',
    sequence: 2,
    monotonicTimeMs: 3,
    commandId: 'pause-with-proof',
    code: 'media_postcondition_failed',
    detail: { action: 'pause' },
    safetyPostcondition: {
      status: 'stopped',
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  });
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'stopped');
  assert.equal(harness.session.protocolV2.confirmedPlayback.event, 'command_failed');
  assert.equal(
    harness.session.protocolV2.confirmedPlayback.reasonCode,
    'command_failed_after_safety_stop',
  );
  assert.equal(harness.session.protocolV2.confirmedPlayback.failureCode, 'media_postcondition_failed');
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.activeFamily, null);
  assert.equal(harness.session.transport.status, 'stopped');

  const deliveredLoadsBeforeRecovery = messagesOfType(player, 'load').length;
  await harness.send(control, {
    type: 'load',
    commandId: 'load-after-failed-command-safety-stop',
    entryId: 'unsafe-reload-entry',
    runId: 'unsafe-reload-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'must-not-dispatch', type: 'local' } },
  });
  assert.equal(
    terminalResults(control, 'load-after-failed-command-safety-stop')[0].code,
    'output_not_ready',
  );
  assert.equal(messagesOfType(player, 'load').length, deliveredLoadsBeforeRecovery);
});

test('SEEK and VOLUME applied proofs commit exact physical values without changing status or lease', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'applied-values-entry',
    runId: 'applied-values-run',
    commandId: 'applied-values-load',
  });
  const base = {
    type: 'playback_event',
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'applied-values-entry',
    runId: 'applied-values-run',
  };
  await harness.send(player, {
    ...base,
    event: 'playing',
    eventId: 'applied-values-playing',
    sequence: 0,
    monotonicTimeMs: 1,
    mediaTime: 3,
    paused: false,
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');

  await harness.send(control, {
    type: 'seek',
    commandId: 'physical-seek-command',
    entryId: 'applied-values-entry',
    runId: 'applied-values-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { position: 42.5 },
  });
  assert.equal(harness.session.protocolV2.desiredTransport.position, 42.5);

  const seekProof = {
    ...base,
    event: 'command_applied',
    eventId: 'physical-seek-proof',
    sequence: 1,
    monotonicTimeMs: 2,
    commandId: 'physical-seek-command',
    commandType: 'SEEK',
    postcondition: { status: 'playing', position: 41.75 },
  };
  await harness.send(player, {
    ...seekProof,
    eventId: 'seek-proof-missing-type',
    commandType: undefined,
  });
  await harness.send(player, {
    ...seekProof,
    eventId: 'seek-proof-type-mismatch',
    commandType: 'VOLUME',
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'invalid_playback_event'
  )).length, 2);
  assert.equal(harness.session.protocolV2.confirmedPlayback.position, 3);
  assert.equal(player.deserializeAttachment().sequenceHighWater.runAuthoritative, 0);

  const sessionBeforeFailure = structuredClone(harness.session);
  const acknowledgementsBeforeFailure = messagesOfType(player, 'event_ack').length;
  harness.storage.failNextPut = new Error('applied_seek_storage_failure');
  await assert.rejects(harness.send(player, seekProof), /applied_seek_storage_failure/);
  assert.deepEqual(harness.session, sessionBeforeFailure);
  assert.equal(player.deserializeAttachment().sequenceHighWater.runAuthoritative, 0);
  assert.equal(messagesOfType(player, 'event_ack').length, acknowledgementsBeforeFailure);
  assert.equal(Boolean(player.deserializeAttachment().eventResultCache?.some((entry) => (
    entry.i === seekProof.eventId
  ))), false);

  await harness.send(player, structuredClone(seekProof));
  assert.equal(harness.session.protocolV2.confirmedPlayback.position, 41.75);
  assert.equal(harness.session.transport.position, 41.75);
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');
  assert.equal(harness.session.transport.status, 'playing');
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'applied-values-entry',
    runId: 'applied-values-run',
  });
  assert.equal(harness.storage.values.get('session').transport.position, 41.75);

  await harness.send(player, structuredClone(seekProof));
  assert.deepEqual(messagesOfType(player, 'event_ack').filter((message) => (
    message.eventId === seekProof.eventId
  )).map((message) => message.status), ['applied', 'duplicate']);

  await harness.send(control, {
    type: 'volume',
    commandId: 'physical-volume-command',
    entryId: 'applied-values-entry',
    runId: 'applied-values-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { volume: 12.5 },
  });
  assert.equal(harness.session.protocolV2.desiredTransport.volume, 12.5);

  const volumeProof = {
    ...base,
    event: 'command_applied',
    eventId: 'physical-volume-proof',
    sequence: 2,
    monotonicTimeMs: 3,
    commandId: 'physical-volume-command',
    commandType: 'VOLUME',
    postcondition: { status: 'playing', volume: 12.25 },
  };
  await harness.send(player, {
    ...volumeProof,
    eventId: 'volume-proof-out-of-range',
    postcondition: { status: 'playing', volume: 101 },
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'invalid_playback_event'
  )).length, 3);
  await harness.send(player, volumeProof);
  assert.equal(harness.session.protocolV2.confirmedPlayback.volume, 12.25);
  assert.equal(harness.session.transport.volume, 12.25);
  assert.equal(harness.session.protocolV2.confirmedPlayback.position, 41.75);
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'playing');
  assert.equal(harness.session.transport.status, 'playing');
  assert.equal(harness.session.protocolV2.leaseStatus, 'audible');
  assert.equal(harness.storage.values.get('session').transport.volume, 12.25);
});

test('deactivation failure commits atomically, keeps the lease, blocks activation, and permits explicit retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch, 0);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'deactivation-entry',
    runId: 'deactivation-run',
    commandId: 'deactivation-load',
  });

  const activeFamily = structuredClone(harness.session.protocolV2.activeFamily);
  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'deactivation-attempt',
    switchId: 'deactivation-failure-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');

  const contradictoryFailure = {
    type: 'route_event',
    event: 'output_deactivation_failed',
    eventId: 'contradictory-deactivation-failure',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'deactivation-failure-switch',
    monotonicTimeMs: 9,
    code: 'reported_failure_after_success',
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  };
  await harness.send(player, contradictoryFailure);
  await harness.send(player, {
    ...contradictoryFailure,
    eventId: 'unknown-deactivation-proof-field',
    postcondition: { mediaPaused: false, outputPathReady: false },
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'invalid_route_event'
  )).length, 2);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');

  const failureEvent = {
    type: 'route_event',
    event: 'output_deactivation_failed',
    eventId: 'deactivation-failure-event',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'deactivation-failure-switch',
    monotonicTimeMs: 10,
    code: 'detach_postcondition_failed',
    detail: { phase: 'detach', evidence: 'x'.repeat(3_000) },
    postcondition: {
      mediaPaused: false,
      sourceDetached: false,
      autoplayCancelled: false,
      audible: true,
    },
  };
  const putsBeforeFailure = harness.storage.puts.length;
  harness.storage.failNextPut = new Error('deactivation_event_storage_failure');

  await assert.rejects(harness.send(player, failureEvent), /deactivation_event_storage_failure/);
  assert.equal(harness.storage.puts.length, putsBeforeFailure);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.deepEqual(harness.session.protocolV2.activeFamily, activeFamily);
  assert.equal(messagesOfType(player, 'event_ack').some((message) => (
    message.eventId === failureEvent.eventId
  )), false);

  const routeBroadcastsBefore = messagesOfType(control, 'route_event').length;
  await harness.send(player, structuredClone(failureEvent));
  assert.equal(harness.storage.puts.length, putsBeforeFailure + 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.leaseTarget, 'player-a');
  assert.equal(harness.session.protocolV2.switchId, 'deactivation-failure-switch');
  assert.deepEqual(harness.session.protocolV2.activeFamily, activeFamily);
  assert.equal(harness.session.transport.status, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'output_deactivation_failed');
  assert.equal(harness.session.protocolV2.confirmedPlayback.code, 'detach_postcondition_failed');
  assert.equal(harness.session.protocolV2.confirmedPlayback.detail.truncated, true);
  assert.ok(harness.session.protocolV2.confirmedPlayback.detail.originalBytes > 2 * 1024);
  assert.equal(player.deserializeAttachment().state, 'unknown');
  assert.equal(messagesOfType(control, 'route_event').length, routeBroadcastsBefore + 1);
  assert.equal(findMessage(player, (message) => (
    message.type === 'event_ack' && message.eventId === failureEvent.eventId
  )).status, 'applied');

  const putsAfterApply = harness.storage.puts.length;
  await harness.send(player, structuredClone(failureEvent));
  assert.equal(harness.storage.puts.length, putsAfterApply);
  assert.equal(messagesOfType(control, 'route_event').length, routeBroadcastsBefore + 1);
  assert.deepEqual(
    messagesOfType(player, 'event_ack')
      .filter((message) => message.eventId === failureEvent.eventId)
      .map((message) => message.status),
    ['applied', 'duplicate'],
  );

  await harness.send(player, { ...failureEvent, code: 'different_failure' });
  assert.equal(findMessage(player, (message) => message.code === 'event_id_conflict').type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');

  await harness.send(control, {
    type: 'activate_output',
    commandId: 'activation-blocked-after-deactivation-failure',
    switchId: 'deactivation-failure-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { outputMode: 'obs' },
  });
  const blockedActivation = findMessage(control, (message) => (
    message.commandId === 'activation-blocked-after-deactivation-failure'
  ));
  assert.equal(blockedActivation.type, 'command_rejected');
  assert.equal(blockedActivation.code, 'output_deactivation_required');
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');

  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'deactivation-explicit-retry',
    switchId: 'deactivation-retry-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.equal(messagesOfType(player, 'deactivate_output').length, 2);

  await harness.send(player, structuredClone(failureEvent));
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.equal(harness.session.protocolV2.switchId, 'deactivation-retry-switch');
  assert.equal(messagesOfType(player, 'event_ack').filter((message) => (
    message.eventId === failureEvent.eventId && message.status === 'duplicate'
  )).length, 2);

  await harness.send(player, {
    ...failureEvent,
    eventId: 'late-old-switch-deactivation-failure',
    sequence: 2,
    detail: { phase: 'late_old_switch' },
  });
  assert.equal(findMessage(player, (message) => (
    message.code === 'stale_switch_identity'
      && message.detail?.actual === 'deactivation-failure-switch'
  )).type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.equal(harness.session.protocolV2.switchId, 'deactivation-retry-switch');

  await harness.send(player, {
    type: 'route_event',
    event: 'output_deactivated',
    eventId: 'deactivation-retry-complete',
    sequence: 2,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'deactivation-retry-switch',
    monotonicTimeMs: 20,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'inactive');
  assert.equal(harness.session.protocolV2.leaseTarget, null);
  assert.equal(harness.session.protocolV2.activeFamily, null);
  assert.equal(player.deserializeAttachment().state, 'standby');
});

test('deactivation failure and retry command share one durable mutation order', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'route-race-entry',
    runId: 'route-race-run',
    commandId: 'route-race-load',
  });
  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'route-race-deactivate',
    switchId: 'route-race-old-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });

  const failure = {
    type: 'route_event',
    event: 'output_deactivation_failed',
    eventId: 'route-race-failure',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'route-race-old-switch',
    monotonicTimeMs: 10,
    code: 'source_detach_failed',
    detail: { phase: 'detach' },
    postcondition: { sourceDetached: false, audible: true },
  };
  const retry = {
    type: 'deactivate_output',
    commandId: 'route-race-retry',
    switchId: 'route-race-new-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  };
  const putsBeforeRace = harness.storage.puts.length;
  const pause = pauseNextStoragePut(harness.storage);
  const failurePromise = harness.send(player, failure);
  await pause.entered;
  const retryPromise = harness.send(control, retry);

  assert.equal(messagesOfType(player, 'deactivate_output').length, 1);
  assert.equal(harness.session.protocolV2.switchId, 'route-race-old-switch');
  pause.release();
  await Promise.all([failurePromise, retryPromise]);

  assert.equal(harness.storage.puts.length, putsBeforeRace + 2);
  assert.equal(findMessage(player, (message) => (
    message.type === 'event_ack' && message.eventId === failure.eventId
  )).status, 'applied');
  assert.equal(terminalResults(control, retry.commandId)[0].type, 'command_ack');
  assert.equal(messagesOfType(player, 'deactivate_output').length, 2);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.equal(harness.session.protocolV2.switchId, 'route-race-new-switch');
  assert.equal(harness.session.protocolV2.leaseTarget, 'player-a');
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'route-race-entry',
    runId: 'route-race-run',
  });

  const putsAfterRace = harness.storage.puts.length;
  await harness.send(player, structuredClone(failure));
  assert.equal(harness.storage.puts.length, putsAfterRace);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  assert.equal(harness.session.protocolV2.switchId, 'route-race-new-switch');
  assert.equal(messagesOfType(player, 'event_ack').filter((message) => (
    message.eventId === failure.eventId && message.status === 'duplicate'
  )).length, 1);
});

test('start_test accepts only fixture-renderable safe-integer durations', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const putsBefore = harness.storage.puts.length;

  for (const durationMs of [999, 1_000.5, 10_001]) {
    const suffix = String(durationMs).replace('.', '-');
    await harness.send(control, {
      type: 'start_test',
      commandId: `invalid-duration-${suffix}`,
      checkId: `invalid-duration-check-${suffix}`,
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: { fixtureId: 'pcm-pulse-v1', durationMs },
    });
    assert.equal(terminalResults(control, `invalid-duration-${suffix}`)[0].code, 'invalid_test_identity');
  }

  assert.equal(harness.storage.puts.length, putsBefore);
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(messagesOfType(player, 'start_test').length, 0);
});

test('start_test is mutually exclusive, writes once, and admits a new check after a terminal event', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);

  const starts = [
    {
      type: 'start_test',
      commandId: 'exclusive-start-a',
      checkId: 'exclusive-check-a',
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
    },
    {
      type: 'start_test',
      commandId: 'exclusive-start-b',
      checkId: 'exclusive-check-b',
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
    },
  ];
  const putsBeforeStarts = harness.storage.puts.length;
  await Promise.all(starts.map((command) => harness.send(control, structuredClone(command))));

  const results = starts.map((command) => terminalResults(control, command.commandId)[0]);
  assert.equal(results.filter((result) => result.type === 'command_ack').length, 1);
  assert.deepEqual(
    results.filter((result) => result.type === 'command_rejected').map((result) => result.code),
    ['test_already_active'],
  );
  assert.equal(harness.storage.puts.length, putsBeforeStarts + 1);
  assert.equal(messagesOfType(player, 'start_test').length, 1);

  const acceptedIndex = results.findIndex((result) => result.type === 'command_ack');
  const rejectedIndex = acceptedIndex === 0 ? 1 : 0;
  const activeStart = starts[acceptedIndex];
  const rejectedStart = starts[rejectedIndex];
  assert.equal(harness.session.protocolV2.activeCheckId, activeStart.checkId);
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId: activeStart.checkId,
    started: false,
    markerCount: 0,
  });
  assert.deepEqual(
    harness.storage.values.get('session').protocolV2.activeCheckProgress,
    harness.session.protocolV2.activeCheckProgress,
  );

  const putsAfterOverlap = harness.storage.puts.length;
  await harness.send(control, structuredClone(rejectedStart));
  assert.equal(harness.storage.puts.length, putsAfterOverlap);
  assert.equal(messagesOfType(player, 'start_test').length, 1);
  assert.deepEqual(
    terminalResults(control, rejectedStart.commandId)[0],
    terminalResults(control, rejectedStart.commandId)[1],
  );

  const putsBeforeRunDuringTest = harness.storage.puts.length;
  await harness.send(control, {
    type: 'load',
    commandId: 'load-while-test-active',
    entryId: 'forbidden-test-entry',
    runId: 'forbidden-test-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'forbidden-song', type: 'local' } },
  });
  assert.equal(terminalResults(control, 'load-while-test-active')[0].code, 'test_active');
  assert.equal(harness.storage.puts.length, putsBeforeRunDuringTest);
  assert.equal(messagesOfType(player, 'load').length, 0);
  assert.equal(harness.session.protocolV2.activeFamily, null);

  await harness.send(player, {
    type: 'test_event',
    event: 'test_failed',
    eventId: 'exclusive-test-failed',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    checkId: activeStart.checkId,
    monotonicTimeMs: 1000,
    code: 'test_cancelled',
    safetyPostcondition: {
      status: 'stopped',
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  });
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.activeCheckProgress, null);

  await harness.send(control, {
    ...activeStart,
    commandId: 'exclusive-start-after-terminal',
    checkId: 'exclusive-check-after-terminal',
  });
  assert.equal(harness.session.protocolV2.activeCheckId, 'exclusive-check-after-terminal');
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId: 'exclusive-check-after-terminal',
    started: false,
    markerCount: 0,
  });
  assert.equal(messagesOfType(player, 'start_test').length, 2);
});

test('start_test rejects an active song even after desired stop until a proven route reset', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch, {
    entryId: 'idle-gate-entry',
    runId: 'idle-gate-run',
    commandId: 'idle-gate-load',
  });
  assert.equal(harness.session.protocolV2.desiredTransport.status, 'loading');

  const blocked = {
    type: 'start_test',
    commandId: 'idle-gate-blocked-start',
    checkId: 'idle-gate-blocked-check',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  };
  const putsBeforeBlockedStart = harness.storage.puts.length;
  await harness.send(control, blocked);
  const rejection = terminalResults(control, blocked.commandId)[0];
  assert.equal(rejection.type, 'command_rejected');
  assert.equal(rejection.code, 'test_requires_idle');
  assert.equal(harness.storage.puts.length, putsBeforeBlockedStart);
  assert.equal(messagesOfType(player, 'start_test').length, 0);
  assert.equal(harness.session.protocolV2.activeCheckId, null);

  await stopRun(harness, control, leaseEpoch, {
    entryId: 'idle-gate-entry',
    runId: 'idle-gate-run',
    commandId: 'idle-gate-stop',
  });
  assert.equal(harness.session.protocolV2.desiredTransport.status, 'stopped');
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'idle-gate-entry',
    runId: 'idle-gate-run',
  });

  await harness.send(control, {
    ...blocked,
    commandId: 'idle-gate-still-blocked-after-stop',
    checkId: 'idle-gate-still-blocked-check',
  });
  assert.equal(
    terminalResults(control, 'idle-gate-still-blocked-after-stop')[0].code,
    'test_requires_idle',
  );
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(messagesOfType(player, 'start_test').length, 0);

  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'idle-gate-deactivate',
    switchId: 'idle-gate-deactivate-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  await harness.send(player, {
    type: 'route_event',
    event: 'output_deactivated',
    eventId: 'idle-gate-deactivated',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    switchId: 'idle-gate-deactivate-switch',
    monotonicTimeMs: 10,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
    },
  });
  assert.equal(harness.session.protocolV2.activeFamily, null);

  await harness.send(control, {
    type: 'activate_output',
    commandId: 'idle-gate-reactivate',
    switchId: 'idle-gate-reactivate-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { outputMode: 'obs' },
  });
  const reactivatedLeaseEpoch = harness.session.protocolV2.leaseEpoch;
  await harness.send(player, outputReadyEvent(player, 'player-a', reactivatedLeaseEpoch, 2, {
    eventId: 'idle-gate-reactivated-ready',
    switchId: 'idle-gate-reactivate-switch',
  }));

  await harness.send(control, {
    ...blocked,
    commandId: 'idle-gate-allowed-after-route-reset',
    checkId: 'idle-gate-allowed-check',
    leaseEpoch: reactivatedLeaseEpoch,
  });
  assert.equal(terminalResults(control, 'idle-gate-allowed-after-route-reset')[0].type, 'command_ack');
  assert.equal(harness.session.protocolV2.activeCheckId, 'idle-gate-allowed-check');
  assert.equal(messagesOfType(player, 'start_test').length, 1);
});

test('concurrent START and LOAD serialize so a song family and test check can never coexist', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);

  const start = {
    type: 'start_test',
    commandId: 'start-load-race-test',
    checkId: 'start-load-race-check',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  };
  const load = {
    type: 'load',
    commandId: 'start-load-race-load',
    entryId: 'start-load-race-entry',
    runId: 'start-load-race-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'start-load-race-song', type: 'local' } },
  };
  const putsBefore = harness.storage.puts.length;
  await Promise.all([
    harness.send(control, structuredClone(start)),
    harness.send(control, structuredClone(load)),
  ]);

  const results = [
    terminalResults(control, start.commandId)[0],
    terminalResults(control, load.commandId)[0],
  ];
  assert.equal(results.filter((result) => result.type === 'command_ack').length, 1);
  assert.equal(results.filter((result) => result.type === 'command_rejected').length, 1);
  assert.ok(['test_active', 'test_requires_idle'].includes(
    results.find((result) => result.type === 'command_rejected').code,
  ));
  assert.equal(harness.storage.puts.length, putsBefore + 1);
  assert.equal(
    messagesOfType(player, 'start_test').length + messagesOfType(player, 'load').length,
    1,
  );
  assert.notEqual(Boolean(harness.session.protocolV2.activeCheckId), Boolean(harness.session.protocolV2.activeFamily));
});

test('emergency durable state cannot be overwritten by an in-flight run mutation', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);

  const load = {
    type: 'load',
    commandId: 'emergency-race-load',
    entryId: 'emergency-race-entry',
    runId: 'emergency-race-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'emergency-race-song', type: 'local' } },
  };
  const emergency = {
    type: 'emergency_stop',
    commandId: 'emergency-race-stop',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  };
  const pause = pauseNextStoragePut(harness.storage);
  const loadPromise = harness.send(control, load);
  await pause.entered;
  const emergencyPromise = harness.send(control, emergency);

  assert.equal(messagesOfType(player, 'emergency_stop').length, 0);
  pause.release();
  await Promise.all([loadPromise, emergencyPromise]);

  assert.equal(terminalResults(control, load.commandId)[0].type, 'command_ack');
  assert.equal(terminalResults(control, emergency.commandId)[0].type, 'command_ack');
  assert.equal(messagesOfType(player, 'load').length, 1);
  assert.equal(messagesOfType(player, 'emergency_stop').length, 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');
  assert.equal(harness.session.protocolV2.leaseTarget, null);
  assert.equal(harness.session.protocolV2.activeFamily, null);
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.pendingEmergencyCommandId, emergency.commandId);
  assert.equal(harness.session.protocolV2.desiredTransport.status, 'stopped');
  assert.equal(harness.session.transport.status, 'unknown');
  assert.equal(harness.session.protocolV2.leaseEpoch, leaseEpoch + 1);
});

test('direct v2 auxiliary commands use payload-only shapes and emit a typed lifecycle frame', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  const display = harness.socket('display');
  await registerControl(harness, control);
  await registerPlayer(harness, player);

  await harness.send(control, {
    type: 'display_state',
    commandId: 'display-a',
    controlEpoch: 1,
    payload: { display: { currentSong: null, history: [] } },
  });
  assert.ok(findMessage(display, (message) => message.type === 'display_state'));

  await harness.send(control, {
    type: 'prefetch',
    commandId: 'prefetch-a',
    controlEpoch: 1,
    payload: { videoIds: ['JGwWNGJdvx8'] },
  });
  assert.ok(findMessage(player, (message) => message.type === 'prefetch' && message.payload.videoIds.length === 1));

  await harness.send(control, {
    type: 'end_session',
    commandId: 'end-with-foreign-identity',
    controlEpoch: 1,
    controlInstanceId: 'control-a',
    payload: {},
  });
  assert.equal(
    findMessage(control, (message) => message.commandId === 'end-with-foreign-identity').code,
    'invalid_aux_identity',
  );

  await harness.send(control, {
    type: 'end_session',
    commandId: 'end-with-nonempty-payload',
    controlEpoch: 1,
    payload: { reason: 'client_prose_is_not_allowed' },
  });
  assert.equal(
    findMessage(control, (message) => message.commandId === 'end-with-nonempty-payload').code,
    'invalid_aux_payload',
  );

  const endCommand = {
    type: 'end_session',
    commandId: 'end-a',
    controlEpoch: 1,
    payload: {},
  };
  await harness.send(control, endCommand);
  const ended = findMessage(control, (message) => message.type === 'session_ended');
  assert.deepEqual(
    { protocolVersion: ended.protocolVersion, reasonCode: ended.reasonCode },
    { protocolVersion: 2, reasonCode: 'explicit' },
  );
  assert.equal(validateOnAirMessage(ended).ok, true);

  await harness.send(control, structuredClone(endCommand));
  const endResults = terminalResults(control, endCommand.commandId);
  assert.equal(endResults.length, 2);
  assert.equal(JSON.stringify(endResults[0]), JSON.stringify(endResults[1]));
  assert.equal(messagesOfType(control, 'session_ended').length, 1);
});

test('end_session is allowed for a ready idle output and emits one terminal lifecycle frame', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);

  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(harness.session.protocolV2.activeFamily, null);
  assert.equal(harness.session.protocolV2.activeCheckId, null);

  const command = {
    type: 'end_session',
    commandId: 'end-ready-idle',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  };
  await harness.send(control, command);

  assert.equal(terminalResults(control, command.commandId)[0].type, 'command_ack');
  assert.equal(harness.session.status, 'ended');
  assert.equal(messagesOfType(control, 'session_ended').length, 1);
  assert.equal(messagesOfType(player, 'session_ended').length, 1);
});

test('end_session rejects active v2 song and test families without ending or notifying', async () => {
  const runHarness = createHarness();
  const runControl = runHarness.socket('control');
  const runPlayer = runHarness.socket('player');
  await registerControl(runHarness, runControl);
  await registerPlayer(runHarness, runPlayer);
  const runLeaseEpoch = await activateOutput(runHarness, runControl);
  await confirmOutputReady(runHarness, runPlayer, 'player-a', runLeaseEpoch);
  await loadRun(runHarness, runControl, runLeaseEpoch, {
    entryId: 'end-blocked-entry',
    runId: 'end-blocked-run',
    commandId: 'end-blocked-load',
  });

  const runEnd = {
    type: 'end_session',
    commandId: 'end-blocked-by-run',
    controlEpoch: runHarness.session.protocolV2.controlEpoch,
    payload: {},
  };
  await runHarness.send(runControl, runEnd);
  const runRejection = terminalResults(runControl, runEnd.commandId)[0];
  assert.equal(runRejection.type, 'command_rejected');
  assert.equal(runRejection.code, 'session_end_requires_idle');
  assert.equal(runRejection.detail.activeFamily, true);
  assert.equal(runHarness.session.status, 'active');
  assert.deepEqual(runHarness.session.protocolV2.activeFamily, {
    entryId: 'end-blocked-entry',
    runId: 'end-blocked-run',
  });
  assert.equal(messagesOfType(runControl, 'session_ended').length, 0);
  assert.equal(messagesOfType(runPlayer, 'session_ended').length, 0);

  const {
    harness: testHarness,
    control: testControl,
    player: testPlayer,
    checkId,
  } = await prepareActiveOutputTest('end-blocked-check');
  const testEnd = {
    type: 'end_session',
    commandId: 'end-blocked-by-test',
    controlEpoch: testHarness.session.protocolV2.controlEpoch,
    payload: {},
  };
  await testHarness.send(testControl, testEnd);
  const testRejection = terminalResults(testControl, testEnd.commandId)[0];
  assert.equal(testRejection.type, 'command_rejected');
  assert.equal(testRejection.code, 'session_end_requires_idle');
  assert.equal(testRejection.detail.activeCheck, true);
  assert.equal(testHarness.session.status, 'active');
  assert.equal(testHarness.session.protocolV2.activeCheckId, checkId);
  assert.equal(messagesOfType(testControl, 'session_ended').length, 0);
  assert.equal(messagesOfType(testPlayer, 'session_ended').length, 0);
});

test('LOAD and end_session serialize with no ended session ever receiving a LOAD', async () => {
  const loadFirst = createHarness();
  const loadFirstControl = loadFirst.socket('control');
  const loadFirstPlayer = loadFirst.socket('player');
  await registerControl(loadFirst, loadFirstControl);
  await registerPlayer(loadFirst, loadFirstPlayer);
  const loadFirstLeaseEpoch = await activateOutput(loadFirst, loadFirstControl);
  await confirmOutputReady(loadFirst, loadFirstPlayer, 'player-a', loadFirstLeaseEpoch);

  const loadCommand = {
    type: 'load',
    commandId: 'load-end-race-load-first',
    entryId: 'load-end-race-entry',
    runId: 'load-end-race-run',
    leaseEpoch: loadFirstLeaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: loadFirst.session.protocolV2.controlEpoch,
    payload: { song: { id: 'load-end-race-song', type: 'local' } },
  };
  const loadFirstEnd = {
    type: 'end_session',
    commandId: 'load-end-race-end-second',
    controlEpoch: loadFirst.session.protocolV2.controlEpoch,
    payload: {},
  };
  const loadPause = pauseNextStoragePut(loadFirst.storage);
  const loadPromise = loadFirst.send(loadFirstControl, loadCommand);
  await loadPause.entered;
  const queuedEndPromise = loadFirst.send(loadFirstControl, loadFirstEnd);
  assert.equal(terminalResults(loadFirstControl, loadFirstEnd.commandId).length, 0);
  assert.equal(messagesOfType(loadFirstPlayer, 'load').length, 0);
  loadPause.release();
  await Promise.all([loadPromise, queuedEndPromise]);

  assert.equal(terminalResults(loadFirstControl, loadCommand.commandId)[0].type, 'command_ack');
  assert.equal(terminalResults(loadFirstControl, loadFirstEnd.commandId)[0].code, 'session_end_requires_idle');
  assert.equal(loadFirst.session.status, 'active');
  assert.equal(messagesOfType(loadFirstPlayer, 'load').length, 1);
  assert.equal(messagesOfType(loadFirstControl, 'session_ended').length, 0);

  const endFirst = createHarness();
  const endFirstControl = endFirst.socket('control');
  const endFirstPlayer = endFirst.socket('player');
  await registerControl(endFirst, endFirstControl);
  await registerPlayer(endFirst, endFirstPlayer);
  const endFirstLeaseEpoch = await activateOutput(endFirst, endFirstControl);
  await confirmOutputReady(endFirst, endFirstPlayer, 'player-a', endFirstLeaseEpoch);

  const endCommand = {
    type: 'end_session',
    commandId: 'load-end-race-end-first',
    controlEpoch: endFirst.session.protocolV2.controlEpoch,
    payload: {},
  };
  const queuedLoadCommand = {
    type: 'load',
    commandId: 'load-end-race-load-second',
    entryId: 'load-end-race-late-entry',
    runId: 'load-end-race-late-run',
    leaseEpoch: endFirstLeaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: endFirst.session.protocolV2.controlEpoch,
    payload: { song: { id: 'load-end-race-late-song', type: 'local' } },
  };
  const endPause = pauseNextStoragePut(endFirst.storage);
  const endPromise = endFirst.send(endFirstControl, endCommand);
  await endPause.entered;
  const queuedLoadPromise = endFirst.send(endFirstControl, queuedLoadCommand);
  assert.equal(messagesOfType(endFirstPlayer, 'load').length, 0);
  endPause.release();
  await Promise.all([endPromise, queuedLoadPromise]);

  assert.equal(terminalResults(endFirstControl, endCommand.commandId)[0].type, 'command_ack');
  assert.equal(terminalResults(endFirstControl, queuedLoadCommand.commandId)[0].code, 'session_inactive');
  assert.equal(endFirst.session.status, 'ended');
  assert.equal(messagesOfType(endFirstPlayer, 'load').length, 0);
  assert.equal(messagesOfType(endFirstControl, 'session_ended').length, 1);
});

test('legacy end_session rejects a playing transport without changing or ending it', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');

  await harness.send(control, {
    type: 'command',
    command: {
      type: 'load',
      commandId: 'legacy-end-guard-load',
      sessionId: 'legacy-end-guard-run',
      song: { id: 'legacy-end-guard-song', type: 'local' },
    },
  });
  await harness.send(player, {
    type: 'event',
    event: {
      type: 'playing',
      sessionId: 'legacy-end-guard-run',
      position: 2,
      duration: 30,
    },
  });

  await harness.send(control, {
    type: 'command',
    command: { type: 'end_session', commandId: 'legacy-end-guard' },
  });

  const rejection = findMessage(control, (message) => message.commandId === 'legacy-end-guard');
  assert.equal(rejection.type, 'error');
  assert.equal(rejection.code, 'session_end_requires_idle');
  assert.equal(rejection.detail.transportStatus, 'playing');
  assert.equal(harness.session.status, 'active');
  assert.equal(harness.session.transport.status, 'playing');
  assert.equal(messagesOfType(control, 'session_ended').length, 0);
  assert.equal(messagesOfType(player, 'session_ended').length, 0);
});

test('emergency reconnect rotates the pending connection proof and redelivers without mutating the command result', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const originalPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, originalPlayer);

  const command = {
    type: 'emergency_stop',
    commandId: 'emergency-connection-bound',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  };
  await harness.send(control, command);
  const originalConnectionId = originalPlayer.deserializeAttachment().connectionId;
  const originalLeaseEpoch = harness.session.protocolV2.leaseEpoch;
  const firstResult = terminalResults(control, command.commandId)[0];

  const replacementPlayer = harness.socket('player');
  await registerPlayer(harness, replacementPlayer, { playerInstanceId: 'player-a' });
  const replacementConnectionId = replacementPlayer.deserializeAttachment().connectionId;
  assert.notEqual(replacementConnectionId, originalConnectionId);
  assert.equal(originalPlayer.closed, true);
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargets, [replacementConnectionId]);
  assert.deepEqual(
    harness.session.protocolV2.pendingEmergencyTargetInstances,
    { [replacementConnectionId]: 'player-a' },
  );
  const welcomeIndex = replacementPlayer.messages.findIndex((message) => message.type === 'player_welcome');
  const emergencyIndex = replacementPlayer.messages.findIndex((message) => (
    message.type === 'emergency_stop' && message.commandId === command.commandId
  ));
  assert.ok(welcomeIndex >= 0 && emergencyIndex > welcomeIndex);
  const redeliveredEmergency = replacementPlayer.messages[emergencyIndex];
  assert.equal(redeliveredEmergency.targetConnectionId, replacementConnectionId);
  assertValidOutboundPlayerCommand(redeliveredEmergency);

  await harness.send(originalPlayer, {
    type: 'emergency_stop_ack',
    eventId: 'superseded-emergency-event',
    commandId: 'emergency-connection-bound',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: originalConnectionId,
    sequence: 0,
    monotonicTimeMs: 10,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.ok(findMessage(originalPlayer, (message) => message.code === 'invalid_emergency_ack_identity'));
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');

  await harness.send(replacementPlayer, {
    type: 'emergency_stop_ack',
    eventId: 'replacement-emergency-event',
    commandId: 'emergency-connection-bound',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: replacementConnectionId,
    sequence: 0,
    monotonicTimeMs: 11,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.equal(findMessage(replacementPlayer, (message) => (
    message.type === 'event_ack' && message.eventId === 'replacement-emergency-event'
  )).status, 'applied');
  assert.equal(harness.session.protocolV2.leaseStatus, 'inactive');
  assert.equal(harness.session.protocolV2.pendingEmergencyCommandId, null);
  assert.equal(harness.session.protocolV2.pendingEmergencyControlInstanceId, null);
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargets, []);
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargetInstances, {});

  await harness.send(control, structuredClone(command));
  assert.equal(harness.session.protocolV2.leaseEpoch, originalLeaseEpoch);
  assert.equal(messagesOfType(replacementPlayer, 'emergency_stop').length, 1);
  const replayedResults = terminalResults(control, command.commandId);
  assert.equal(replayedResults.length, 2);
  assert.equal(JSON.stringify(replayedResults[0]), JSON.stringify(firstResult));
  assert.equal(JSON.stringify(replayedResults[1]), JSON.stringify(firstResult));
});

test('emergency reconnect storage failure preserves the old transport and can retry cleanly', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const originalPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, originalPlayer);
  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'emergency-rebind-storage-failure',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  const originalConnectionId = originalPlayer.deserializeAttachment().connectionId;

  const replacementPlayer = harness.socket('player');
  optIntoProtocolV2(replacementPlayer);
  const hello = {
    type: 'player_hello',
    protocolVersion: 2,
    playerInstanceId: 'player-a',
    clientKind: 'obs-browser-source',
    buildId: 'test-build',
    capabilities: { obsRuntime: true, analyser: true },
  };
  harness.storage.failNextPut = new Error('fixture_emergency_rebind_storage_failure');
  await assert.rejects(
    harness.send(replacementPlayer, hello),
    /fixture_emergency_rebind_storage_failure/,
  );

  assert.equal(originalPlayer.closed, false);
  assert.equal(originalPlayer.deserializeAttachment().negotiationState, 'negotiated');
  assert.equal(replacementPlayer.deserializeAttachment().negotiationState, 'unnegotiated');
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargets, [originalConnectionId]);
  assert.equal(messagesOfType(replacementPlayer, 'player_welcome').length, 0);
  assert.equal(messagesOfType(replacementPlayer, 'emergency_stop').length, 0);
  assert.equal(messagesOfType(originalPlayer, 'connection_superseded').length, 0);

  await harness.send(replacementPlayer, structuredClone(hello));
  const replacementConnectionId = replacementPlayer.deserializeAttachment().connectionId;
  assert.equal(originalPlayer.closed, true);
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargets, [replacementConnectionId]);
  assert.equal(messagesOfType(replacementPlayer, 'emergency_stop').length, 1);
});

test('a fully closed emergency target is durably identified and rebound on reconnect', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const originalPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, originalPlayer);
  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'emergency-fully-closed-reconnect',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  const originalConnectionId = originalPlayer.deserializeAttachment().connectionId;
  assert.equal(
    harness.session.protocolV2.pendingEmergencyTargetInstances[originalConnectionId],
    'player-a',
  );

  originalPlayer.close();
  await harness.room.webSocketClose(originalPlayer);
  assert.equal(harness.context.sockets.includes(originalPlayer), false);

  const replacementPlayer = harness.socket('player');
  await registerPlayer(harness, replacementPlayer, { playerInstanceId: 'player-a' });
  const replacementConnectionId = replacementPlayer.deserializeAttachment().connectionId;
  assert.deepEqual(harness.session.protocolV2.pendingEmergencyTargets, [replacementConnectionId]);
  assert.deepEqual(
    harness.session.protocolV2.pendingEmergencyTargetInstances,
    { [replacementConnectionId]: 'player-a' },
  );
  const redelivered = findMessage(replacementPlayer, (message) => (
    message.type === 'emergency_stop' && message.commandId === 'emergency-fully-closed-reconnect'
  ));
  assert.equal(redelivered.targetConnectionId, replacementConnectionId);
  assertValidOutboundPlayerCommand(redelivered);
});

test('an acknowledged player reconnect must prove the new transport while other emergency targets remain', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const playerA = harness.socket('player');
  const playerB = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, playerA, { playerInstanceId: 'player-a' });
  await registerPlayer(harness, playerB, { playerInstanceId: 'player-b' });
  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'emergency-multi-reconnect',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  const oldAConnectionId = playerA.deserializeAttachment().connectionId;
  const playerBConnectionId = playerB.deserializeAttachment().connectionId;

  await harness.send(playerA, {
    type: 'emergency_stop_ack',
    eventId: 'emergency-multi-a-old',
    commandId: 'emergency-multi-reconnect',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: oldAConnectionId,
    sequence: 0,
    monotonicTimeMs: 1,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');
  assert.deepEqual(harness.session.protocolV2.emergencyAcknowledgedTargets, [oldAConnectionId]);

  const replacementA = harness.socket('player');
  await registerPlayer(harness, replacementA, { playerInstanceId: 'player-a' });
  const newAConnectionId = replacementA.deserializeAttachment().connectionId;
  assert.deepEqual(
    new Set(harness.session.protocolV2.pendingEmergencyTargets),
    new Set([playerBConnectionId, newAConnectionId]),
  );
  assert.equal(harness.session.protocolV2.emergencyAcknowledgedTargets.includes(oldAConnectionId), false);

  await harness.send(replacementA, {
    type: 'emergency_stop_ack',
    eventId: 'emergency-multi-a-stale-sequence',
    commandId: 'emergency-multi-reconnect',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: newAConnectionId,
    sequence: 0,
    monotonicTimeMs: 2,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.ok(findMessage(replacementA, (message) => message.code === 'duplicate_sequence'));

  await harness.send(replacementA, {
    type: 'emergency_stop_ack',
    eventId: 'emergency-multi-a-new',
    commandId: 'emergency-multi-reconnect',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: newAConnectionId,
    sequence: 1,
    monotonicTimeMs: 3,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');

  await harness.send(playerB, {
    type: 'emergency_stop_ack',
    eventId: 'emergency-multi-b',
    commandId: 'emergency-multi-reconnect',
    sessionId: harness.session.room,
    playerInstanceId: 'player-b',
    connectionId: playerBConnectionId,
    sequence: 0,
    monotonicTimeMs: 4,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'inactive');
});

test('emergency stop ignores normal leases, reaches every live player, and invalidates stale events', async () => {
  const harness = createHarness();
  const owner = harness.socket('control');
  const readOnlyControl = harness.socket('control');
  const v2Player = harness.socket('player');
  await registerControl(harness, owner, 'control-owner');
  await registerControl(harness, readOnlyControl, 'control-observer');
  await registerPlayer(harness, v2Player);
  const leaseEpoch = await activateOutput(harness, owner);
  await confirmOutputReady(harness, v2Player, 'player-a', leaseEpoch);

  // A legacy connection can only receive the fallback stop; it cannot be an
  // activation candidate and is added after the v2 route is already active.
  const legacyPlayer = harness.socket('player');
  await harness.send(readOnlyControl, {
    type: 'emergency_stop',
    commandId: 'emergency-a',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-observer',
  });

  const emergency = findMessage(v2Player, (message) => (
    message.type === 'emergency_stop'
    && message.commandId === 'emergency-a'
    && message.targetConnectionId === v2Player.deserializeAttachment().connectionId
  ));
  assert.ok(emergency);
  assertValidOutboundPlayerCommand(emergency);
  assert.ok(findMessage(legacyPlayer, (message) => message.type === 'command' && message.command.type === 'stop'));
  assert.equal(harness.session.protocolV2.leaseTarget, null);
  assert.equal(harness.session.protocolV2.leaseEpoch, leaseEpoch + 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');
  assert.equal(harness.session.transport.status, 'unknown');

  await harness.send(v2Player, {
    type: 'emergency_stop_ack',
    eventId: 'emergency-event-a',
    commandId: 'emergency-a',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: v2Player.deserializeAttachment().connectionId,
    sequence: 0,
    monotonicTimeMs: 10,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.ok(findMessage(owner, (message) => message.type === 'emergency_stop_ack'));
});

test('closing the active target reports unknown and never manufactures paused confirmation', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const activePlayer = harness.socket('player');
  const standbyPlayer = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, activePlayer);
  await registerPlayer(harness, standbyPlayer, {
    playerInstanceId: 'speaker-a',
    clientKind: 'dashboard-speaker',
    capabilities: { analyser: true },
  });
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, activePlayer, 'player-a', leaseEpoch);
  harness.session.transport.status = 'playing';

  await harness.room.webSocketClose(activePlayer);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_disconnected');
  assert.equal(harness.session.transport.status, 'unknown');
  assert.notEqual(harness.session.transport.status, 'paused');
});

test('live registry stays in socket attachments and server v2 frames satisfy the shared schema', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);

  const stored = harness.storage.puts.at(-1)?.value;
  assert.ok(stored);
  assert.equal(Object.hasOwn(stored.protocolV2, 'players'), false);
  assert.equal(Object.hasOwn(stored.protocolV2, 'connected'), false);

  const snapshot = messagesOfType(control, 'player_snapshot').at(-1);
  assert.equal(Object.hasOwn(snapshot, 'activeFamily'), true);
  assert.equal(Object.hasOwn(snapshot, 'activeCheckId'), true);
  assert.equal(snapshot.activeFamily, null);
  assert.equal(snapshot.activeCheckId, null);

  const knownServerFrames = [...control.messages, ...player.messages].filter((message) => [
    'player_welcome',
    'control_welcome',
    'player_snapshot',
    'command_ack',
    'command_rejected',
    'protocol_error',
    'connection_superseded',
    'desired_transport',
  ].includes(message.type));
  assert.ok(knownServerFrames.length >= 4);
  for (const frame of knownServerFrames) {
    const validation = validateOnAirMessage(frame);
    assert.equal(validation.ok, true, `${frame.type}: ${JSON.stringify(validation.errors)}`);
  }
});

test('lost activate/load ACK retries replay exactly once, including an in-flight duplicate', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);

  const activate = {
    type: 'activate_output',
    commandId: 'dedupe-activate',
    switchId: 'dedupe-switch',
    leaseEpoch: 0,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: 1,
    payload: { outputMode: 'obs' },
  };
  await Promise.all([
    harness.send(control, activate),
    harness.send(control, structuredClone(activate)),
  ]);

  assert.equal(harness.session.protocolV2.leaseEpoch, 1);
  assert.equal(messagesOfType(player, 'activate_output').length, 1);
  const activateResults = terminalResults(control, activate.commandId);
  assert.equal(activateResults.length, 2);
  assert.equal(JSON.stringify(activateResults[0]), JSON.stringify(activateResults[1]));

  await harness.send(player, {
    type: 'route_event',
    event: 'output_ready',
    eventId: 'dedupe-output-ready',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch: 1,
    switchId: 'dedupe-switch',
    monotonicTimeMs: 1,
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: true,
      audible: false,
    },
  });

  const load = {
    type: 'load',
    commandId: 'dedupe-load',
    entryId: 'entry-dedupe',
    runId: 'run-dedupe',
    leaseEpoch: 1,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: 1,
    payload: { song: { id: 'song-dedupe', type: 'local' }, position: 0, volume: 85 },
  };
  await harness.send(control, load);
  await harness.send(control, structuredClone(load));

  assert.equal(messagesOfType(player, 'load').length, 1);
  assert.deepEqual(harness.session.protocolV2.activeFamily, {
    entryId: 'entry-dedupe',
    runId: 'run-dedupe',
  });
  const loadResults = terminalResults(control, load.commandId);
  assert.equal(loadResults.length, 2);
  assert.equal(JSON.stringify(loadResults[0]), JSON.stringify(loadResults[1]));

  // A hibernated Durable Object loses class fields but keeps each healthy
  // WebSocket's serialized attachment. The terminal result must still replay.
  const rehydratedRoom = new SessionRoom(harness.context, {});
  rehydratedRoom.sessionState = harness.session;
  await rehydratedRoom.webSocketMessage(control, JSON.stringify(load));
  assert.equal(messagesOfType(player, 'load').length, 1);
  const rehydratedResults = terminalResults(control, load.commandId);
  assert.equal(rehydratedResults.length, 3);
  assert.equal(JSON.stringify(rehydratedResults[0]), JSON.stringify(rehydratedResults[2]));
});

test('lost takeover and emergency ACK retries do not advance epochs or rebroadcast', async () => {
  const harness = createHarness();
  const firstControl = harness.socket('control');
  const secondControl = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, firstControl, 'control-a');
  await registerControl(harness, secondControl, 'control-b');
  await registerPlayer(harness, player);

  const takeover = {
    type: 'control_takeover',
    commandId: 'dedupe-takeover',
    controlInstanceId: 'control-b',
    expectedControlEpoch: 1,
  };
  await harness.send(secondControl, takeover);
  await harness.send(secondControl, structuredClone(takeover));
  assert.equal(harness.session.protocolV2.controlEpoch, 2);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, 'control-b');
  const takeoverResults = terminalResults(secondControl, takeover.commandId);
  assert.equal(takeoverResults.length, 2);
  assert.equal(JSON.stringify(takeoverResults[0]), JSON.stringify(takeoverResults[1]));

  const emergency = {
    type: 'emergency_stop',
    commandId: 'dedupe-emergency',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  };
  const epochBeforeEmergency = harness.session.protocolV2.leaseEpoch;
  await harness.send(firstControl, emergency);
  await harness.send(firstControl, structuredClone(emergency));

  assert.equal(harness.session.protocolV2.leaseEpoch, epochBeforeEmergency + 1);
  assert.equal(messagesOfType(player, 'emergency_stop').length, 1);
  const emergencyResults = terminalResults(firstControl, emergency.commandId);
  assert.equal(emergencyResults.length, 2);
  assert.equal(JSON.stringify(emergencyResults[0]), JSON.stringify(emergencyResults[1]));
});

test('rejected command retries replay the first result and command ID conflicts never replace it', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  await registerControl(harness, control);

  const rejected = {
    type: 'play',
    commandId: 'dedupe-rejected',
    entryId: 'entry-rejected',
    runId: 'run-rejected',
    leaseEpoch: 0,
    targetPlayerInstanceId: 'missing-player',
    controlEpoch: 99,
    payload: {},
  };
  await harness.send(control, rejected);
  await harness.send(control, structuredClone(rejected));
  let results = terminalResults(control, rejected.commandId);
  assert.equal(results.length, 2);
  assert.equal(results[0].code, 'stale_control_epoch');
  assert.equal(JSON.stringify(results[0]), JSON.stringify(results[1]));

  await harness.send(control, { ...rejected, payload: { retryMode: 'changed' } });
  await harness.send(control, { ...rejected, type: 'pause' });
  results = terminalResults(control, rejected.commandId);
  assert.equal(results.at(-2).code, 'command_id_conflict');
  assert.equal(results.at(-1).code, 'command_id_conflict');

  await harness.send(control, structuredClone(rejected));
  results = terminalResults(control, rejected.commandId);
  assert.equal(results.at(-1).code, 'stale_control_epoch');
  assert.equal(JSON.stringify(results[0]), JSON.stringify(results.at(-1)));
});

test('terminal cache is attachment-persisted, entry-bounded, and below the Cloudflare size limit', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const display = harness.socket('display');
  await registerControl(harness, control);

  for (let index = 0; index < 40; index += 1) {
    await harness.send(control, {
      type: 'prefetch',
      commandId: `bounded-rejection-${index}`,
      controlEpoch: 1,
      payload: { videoIds: ['invalid'] },
    });
  }
  const largeTitle = 'x'.repeat(8_000);
  await harness.send(control, {
    type: 'display_state',
    commandId: 'large-display-command',
    controlEpoch: 1,
    payload: {
      display: {
        currentSong: { id: 'large-song', title: largeTitle, type: 'local' },
        history: [],
      },
    },
  });
  assert.ok(findMessage(display, (message) => message.type === 'display_state'));

  const attachment = control.deserializeAttachment();
  const cache = attachment.commandResultCache;
  const serialized = JSON.stringify(attachment);
  const serializedBytes = new TextEncoder().encode(serialized).byteLength;
  assert.ok(Array.isArray(cache));
  assert.ok(cache.length <= 32);
  assert.ok(serializedBytes <= 15 * 1024, `attachment is ${serializedBytes} bytes`);
  assert.equal(serialized.includes(largeTitle), false);
});

test('player events require the current connection and outbound commands fence the target transport', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const connectionId = player.deserializeAttachment().connectionId;
  const leaseEpoch = await activateOutput(harness, control);

  const activation = findMessage(player, (message) => message.type === 'activate_output');
  assert.equal(activation.targetConnectionId, connectionId);
  assertValidOutboundPlayerCommand(activation);

  const missingConnection = outputReadyEvent(player, 'player-a', leaseEpoch);
  delete missingConnection.connectionId;
  await harness.send(player, missingConnection);
  assert.equal(findMessage(player, (message) => message.code === 'invalid_route_event').type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');

  await harness.send(player, outputReadyEvent(player, 'player-a', leaseEpoch, 0, {
    eventId: 'old-connection-ready',
    connectionId: 'old-connection',
  }));
  assert.equal(findMessage(player, (message) => message.code === 'foreign_connection').type, 'protocol_error');
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');

  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'injected-target-connection',
    switchId: 'injected-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    targetConnectionId: 'attacker-selected-connection',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  assert.equal(
    findMessage(control, (message) => message.commandId === 'injected-target-connection').code,
    'invalid_route_identity',
  );

  const injectedCommands = [
    {
      type: 'play',
      commandId: 'injected-run-connection',
      entryId: 'entry-a',
      runId: 'run-a',
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      targetConnectionId: connectionId,
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: {},
      expectedCode: 'invalid_run_identity',
    },
    {
      type: 'start_test',
      commandId: 'injected-test-connection',
      checkId: 'check-a',
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      targetConnectionId: connectionId,
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
      expectedCode: 'invalid_test_identity',
    },
    {
      type: 'display_state',
      commandId: 'injected-aux-connection',
      targetConnectionId: connectionId,
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload: { display: { currentSong: null, history: [] } },
      expectedCode: 'invalid_aux_identity',
    },
    {
      type: 'emergency_stop',
      commandId: 'injected-emergency-connection',
      sessionId: harness.session.room,
      authenticatedControlInstanceId: 'control-a',
      targetConnectionId: connectionId,
      expectedCode: 'invalid_emergency_identity',
    },
  ];
  for (const { expectedCode, ...command } of injectedCommands) {
    await harness.send(control, command);
    assert.equal(
      findMessage(control, (message) => message.commandId === command.commandId).code,
      expectedCode,
    );
  }

  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'fenced-deactivate',
    switchId: 'deactivate-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  const deactivation = findMessage(player, (message) => message.type === 'deactivate_output');
  assert.equal(deactivation.targetConnectionId, connectionId);
  assertValidOutboundPlayerCommand(deactivation);
});

test('event namespaces are isolated and initial events receive typed applied or relayed ACKs', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const connectionId = player.deserializeAttachment().connectionId;
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch, 0);
  await loadRun(harness, control, leaseEpoch);
  const load = findMessage(player, (message) => message.type === 'load');
  assert.equal(load.targetConnectionId, connectionId);
  assertValidOutboundPlayerCommand(load);
  await harness.send(control, {
    type: 'play',
    commandId: 'schema-play',
    entryId: 'entry-a',
    runId: 'run-a',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  const play = findMessage(player, (message) => message.type === 'play');
  assertValidOutboundPlayerCommand(play);

  const base = {
    type: 'playback_event',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    entryId: 'entry-a',
    runId: 'run-a',
    monotonicTimeMs: 10,
  };
  await harness.send(player, {
    ...base,
    event: 'ready',
    eventId: 'namespace-authoritative',
    sequence: 0,
    mediaTime: 0,
    duration: 30,
    readyState: 4,
    paused: true,
  });
  const putsBeforeTelemetry = harness.storage.puts.length;
  await harness.send(player, {
    ...base,
    event: 'position',
    eventId: 'namespace-telemetry',
    sequence: 0,
    monotonicTimeMs: 11,
    mediaTime: 1,
    duration: 30,
    readyState: 4,
    paused: false,
    seeking: false,
  });
  await harness.send(player, {
    ...base,
    event: 'command_received',
    eventId: 'namespace-receipt',
    sequence: 0,
    monotonicTimeMs: 12,
    commandId: 'load-run-a',
  });

  const hwm = player.deserializeAttachment().sequenceHighWater;
  assert.deepEqual(hwm, {
    route: 0,
    runAuthoritative: 0,
    runTelemetry: 0,
    runReceipt: 0,
  });
  assert.equal(harness.storage.puts.length, putsBeforeTelemetry);
  assert.equal(findMessage(player, (message) => message.eventId === 'namespace-authoritative').status, 'applied');
  assert.equal(findMessage(player, (message) => message.eventId === 'namespace-telemetry').status, 'relayed');
  assert.equal(findMessage(player, (message) => message.eventId === 'namespace-receipt').status, 'relayed');
  const checkpointEventIds = harness.session.protocolV2.playerEventCheckpoints
    .flatMap((checkpoint) => checkpoint.e.map((entry) => entry.i));
  assert.ok(checkpointEventIds.includes('namespace-authoritative'));
  assert.equal(checkpointEventIds.includes('namespace-telemetry'), false);
  assert.equal(checkpointEventIds.includes('namespace-receipt'), false);

  const putsBeforeHeartbeat = harness.storage.puts.length;
  await harness.send(player, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 13,
  });
  assert.equal(harness.storage.puts.length, putsBeforeHeartbeat);

  // A song family is retained until a physically proven route reset. Exercise
  // the independent test sequence namespace on a fresh ready output instead.
  const testHarness = createHarness();
  const testControl = testHarness.socket('control');
  const testPlayer = testHarness.socket('player');
  await registerControl(testHarness, testControl);
  await registerPlayer(testHarness, testPlayer);
  const testLeaseEpoch = await activateOutput(testHarness, testControl);
  await confirmOutputReady(testHarness, testPlayer, 'player-a', testLeaseEpoch, 0);
  const testConnectionId = testPlayer.deserializeAttachment().connectionId;

  await testHarness.send(testControl, {
    type: 'start_test',
    commandId: 'namespace-start-test',
    checkId: 'namespace-check',
    leaseEpoch: testLeaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: testHarness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  const startTest = findMessage(testPlayer, (message) => message.type === 'start_test');
  assert.equal(startTest.targetConnectionId, testConnectionId);
  assertValidOutboundPlayerCommand(startTest);
  const putsBeforeTestEvent = testHarness.storage.puts.length;
  await testHarness.send(testPlayer, {
    type: 'test_event',
    event: 'test_started',
    eventId: 'namespace-test',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: testConnectionId,
    leaseEpoch: testLeaseEpoch,
    checkId: 'namespace-check',
    monotonicTimeMs: 14,
  });
  assert.equal(testHarness.storage.puts.length, putsBeforeTestEvent + 1);
  assert.ok(testHarness.session.protocolV2.playerEventCheckpoints.some((checkpoint) => (
    checkpoint.e.some((entry) => entry.i === 'namespace-test' && entry.n === 'test')
  )));
});

test('test markers are ACKed in a non-durable namespace and retain wire order across live reconnect', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const original = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, original);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, original, 'player-a', leaseEpoch, 0);

  await harness.send(control, {
    type: 'start_test',
    commandId: 'marker-start-test',
    checkId: 'marker-check',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId: 'marker-check',
    started: false,
    markerCount: 0,
  });
  const originalConnectionId = original.deserializeAttachment().connectionId;
  await harness.send(original, {
    type: 'test_event',
    event: 'test_started',
    eventId: 'marker-test-started',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: originalConnectionId,
    leaseEpoch,
    checkId: 'marker-check',
    monotonicTimeMs: 10,
  });
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId: 'marker-check',
    started: true,
    markerCount: 0,
  });
  assert.deepEqual(
    harness.storage.values.get('session').protocolV2.activeCheckProgress,
    harness.session.protocolV2.activeCheckProgress,
  );

  const firstMarker = {
    type: 'test_event',
    event: 'test_marker',
    eventId: 'marker-sample-0',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: originalConnectionId,
    leaseEpoch,
    checkId: 'marker-check',
    monotonicTimeMs: 250,
    markerIndex: 0,
    markerTimeMs: 250,
  };
  const putsBeforeMarkers = harness.storage.puts.length;
  await harness.send(original, firstMarker);

  assert.equal(harness.storage.puts.length, putsBeforeMarkers);
  assert.equal(harness.session.protocolV2.activeCheckProgress.markerCount, 1);
  assert.equal(harness.storage.values.get('session').protocolV2.activeCheckProgress.markerCount, 0);
  assert.equal(original.deserializeAttachment().sequenceHighWater.test, 0);
  assert.equal(original.deserializeAttachment().sequenceHighWater.testTelemetry, 0);
  assert.equal(findMessage(original, (message) => message.eventId === firstMarker.eventId).status, 'relayed');
  assert.equal(harness.session.protocolV2.playerEventCheckpoints.some((checkpoint) => (
    checkpoint.e.some((entry) => entry.i === firstMarker.eventId)
  )), false);

  const replacement = harness.socket('player');
  await registerPlayer(harness, replacement, { playerInstanceId: 'player-a' });
  const replacementConnectionId = replacement.deserializeAttachment().connectionId;
  assert.notEqual(replacementConnectionId, originalConnectionId);
  assert.equal(replacement.deserializeAttachment().sequenceHighWater.testTelemetry, 0);
  assert.ok(replacement.deserializeAttachment().eventResultCache.some((entry) => (
    entry.i === firstMarker.eventId && entry.n === 'testTelemetry'
  )));

  await harness.send(replacement, { ...firstMarker, connectionId: replacementConnectionId });
  assert.equal(findMessage(replacement, (message) => message.eventId === firstMarker.eventId).status, 'duplicate');
  assert.equal(harness.storage.puts.length, putsBeforeMarkers);
  assert.equal(messagesOfType(control, 'test_event').filter((message) => (
    message.eventId === firstMarker.eventId
  )).length, 1);

  const secondMarker = {
    ...firstMarker,
    eventId: 'marker-sample-1',
    sequence: 1,
    connectionId: replacementConnectionId,
    monotonicTimeMs: 500,
    markerIndex: 1,
    markerTimeMs: 500,
  };
  const complete = {
    type: 'test_event',
    event: 'test_complete',
    eventId: 'marker-test-complete',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: replacementConnectionId,
    leaseEpoch,
    checkId: 'marker-check',
    monotonicTimeMs: 1000,
    markerCount: 2,
    postcondition: { stopped: true },
  };
  await Promise.all([
    harness.send(replacement, secondMarker),
    harness.send(replacement, complete),
  ]);

  assert.equal(harness.storage.puts.length, putsBeforeMarkers + 1);
  assert.equal(replacement.deserializeAttachment().sequenceHighWater.testTelemetry, 1);
  assert.equal(replacement.deserializeAttachment().sequenceHighWater.test, 1);
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.activeCheckProgress, null);
  assert.equal(harness.storage.values.get('session').protocolV2.activeCheckProgress, null);
  assert.deepEqual(
    messagesOfType(control, 'test_event')
      .filter((message) => message.checkId === 'marker-check')
      .map((message) => message.event),
    ['test_started', 'test_marker', 'test_marker', 'test_complete'],
  );
  const checkpointEntries = harness.session.protocolV2.playerEventCheckpoints
    .flatMap((checkpoint) => checkpoint.e);
  assert.equal(harness.session.protocolV2.playerEventCheckpoints.some((checkpoint) => (
    checkpoint.h.testTelemetry !== undefined
  )), false);
  assert.equal(checkpointEntries.some((entry) => entry.i === firstMarker.eventId), false);
  assert.equal(checkpointEntries.some((entry) => entry.i === secondMarker.eventId), false);
  assert.ok(checkpointEntries.some((entry) => (
    entry.i === 'marker-test-started' && entry.n === 'test'
  )));
  assert.ok(checkpointEntries.some((entry) => (
    entry.i === complete.eventId && entry.n === 'test'
  )));
});

test('test lifecycle integrity rejects duplicate starts, marker gaps, and false completion without clearing the check', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const connectionId = player.deserializeAttachment().connectionId;
  const checkId = 'integrity-check';

  await harness.send(control, {
    type: 'start_test',
    commandId: 'integrity-start',
    checkId,
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });

  const base = {
    type: 'test_event',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId,
  };
  const rejectProgress = async (message, reason) => {
    const errorsBefore = messagesOfType(player, 'protocol_error').length;
    await harness.send(player, message);
    const errors = messagesOfType(player, 'protocol_error');
    assert.equal(errors.length, errorsBefore + 1);
    assert.equal(errors.at(-1).code, 'invalid_test_progress');
    assert.equal(errors.at(-1).detail.reason, reason);
    assert.equal(findMessage(player, (entry) => (
      entry.type === 'event_ack' && entry.eventId === message.eventId
    )), undefined);
    assert.equal(harness.session.protocolV2.activeCheckId, checkId);
  };

  await rejectProgress({
    ...base,
    event: 'test_marker',
    eventId: 'integrity-marker-before-start',
    sequence: 0,
    monotonicTimeMs: 100,
    markerIndex: 0,
    markerTimeMs: 100,
  }, 'test_not_started');

  await harness.send(player, {
    ...base,
    event: 'test_started',
    eventId: 'integrity-started',
    sequence: 0,
    monotonicTimeMs: 1,
  });
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId,
    started: true,
    markerCount: 0,
  });

  await rejectProgress({
    ...base,
    event: 'test_started',
    eventId: 'integrity-started-again',
    sequence: 1,
    monotonicTimeMs: 2,
  }, 'test_already_started');
  await rejectProgress({
    ...base,
    event: 'test_marker',
    eventId: 'integrity-first-marker-wrong-index',
    sequence: 0,
    monotonicTimeMs: 250,
    markerIndex: 1,
    markerTimeMs: 250,
  }, 'marker_index_mismatch');

  await harness.send(player, {
    ...base,
    event: 'test_marker',
    eventId: 'integrity-marker-0',
    sequence: 0,
    monotonicTimeMs: 250,
    markerIndex: 0,
    markerTimeMs: 250,
  });
  assert.equal(harness.session.protocolV2.activeCheckProgress.markerCount, 1);

  await rejectProgress({
    ...base,
    event: 'test_marker',
    eventId: 'integrity-marker-gap',
    sequence: 1,
    monotonicTimeMs: 500,
    markerIndex: 2,
    markerTimeMs: 500,
  }, 'marker_index_mismatch');
  await harness.send(player, {
    ...base,
    event: 'test_marker',
    eventId: 'integrity-marker-1',
    sequence: 1,
    monotonicTimeMs: 500,
    markerIndex: 1,
    markerTimeMs: 500,
  });
  assert.equal(harness.session.protocolV2.activeCheckProgress.markerCount, 2);

  const putsBeforeBadComplete = harness.storage.puts.length;
  await rejectProgress({
    ...base,
    event: 'test_complete',
    eventId: 'integrity-complete-wrong-count',
    sequence: 1,
    monotonicTimeMs: 1000,
    markerCount: 3,
    postcondition: { stopped: true },
  }, 'marker_count_mismatch');
  assert.equal(harness.storage.puts.length, putsBeforeBadComplete);
  assert.deepEqual(harness.session.protocolV2.activeCheckProgress, {
    checkId,
    started: true,
    markerCount: 2,
  });

  await harness.send(player, {
    ...base,
    event: 'test_complete',
    eventId: 'integrity-complete',
    sequence: 1,
    monotonicTimeMs: 1000,
    markerCount: 2,
    postcondition: { stopped: true },
  });
  assert.equal(findMessage(player, (message) => message.eventId === 'integrity-complete').status, 'applied');
  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.activeCheckProgress, null);
});

test('test completion requires at least one observed marker while test_failed remains terminal before start', async () => {
  const incomplete = createHarness();
  const incompleteControl = incomplete.socket('control');
  const incompletePlayer = incomplete.socket('player');
  await registerControl(incomplete, incompleteControl);
  await registerPlayer(incomplete, incompletePlayer);
  const incompleteLease = await activateOutput(incomplete, incompleteControl);
  await confirmOutputReady(incomplete, incompletePlayer, 'player-a', incompleteLease);
  const incompleteConnection = incompletePlayer.deserializeAttachment().connectionId;
  await incomplete.send(incompleteControl, {
    type: 'start_test',
    commandId: 'empty-completion-start',
    checkId: 'empty-completion-check',
    leaseEpoch: incompleteLease,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: incomplete.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  await incomplete.send(incompletePlayer, {
    type: 'test_event',
    event: 'test_started',
    eventId: 'empty-completion-started',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: incompleteConnection,
    leaseEpoch: incompleteLease,
    checkId: 'empty-completion-check',
    monotonicTimeMs: 1,
  });
  await incomplete.send(incompletePlayer, {
    type: 'test_event',
    event: 'test_complete',
    eventId: 'empty-completion',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId: incompleteConnection,
    leaseEpoch: incompleteLease,
    checkId: 'empty-completion-check',
    monotonicTimeMs: 1000,
    markerCount: 0,
    postcondition: { stopped: true },
  });
  const emptyError = messagesOfType(incompletePlayer, 'protocol_error').at(-1);
  assert.equal(emptyError.code, 'invalid_test_progress');
  assert.equal(emptyError.detail.reason, 'markers_required');
  assert.equal(incomplete.session.protocolV2.activeCheckId, 'empty-completion-check');

  const failed = createHarness();
  const failedControl = failed.socket('control');
  const failedPlayer = failed.socket('player');
  await registerControl(failed, failedControl);
  await registerPlayer(failed, failedPlayer);
  const failedLease = await activateOutput(failed, failedControl);
  await confirmOutputReady(failed, failedPlayer, 'player-a', failedLease);
  const failedConnection = failedPlayer.deserializeAttachment().connectionId;
  await failed.send(failedControl, {
    type: 'start_test',
    commandId: 'pre-start-failure-start',
    checkId: 'pre-start-failure-check',
    leaseEpoch: failedLease,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: failed.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  await failed.send(failedPlayer, {
    type: 'test_event',
    event: 'test_failed',
    eventId: 'pre-start-failure',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: failedConnection,
    leaseEpoch: failedLease,
    checkId: 'pre-start-failure-check',
    monotonicTimeMs: 1,
    code: 'test_cancelled',
    safetyPostcondition: {
      status: 'stopped',
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  });
  assert.equal(findMessage(failedPlayer, (message) => message.eventId === 'pre-start-failure').status, 'applied');
  assert.equal(failed.session.protocolV2.activeCheckId, null);
  assert.equal(failed.session.protocolV2.activeCheckProgress, null);
  assert.equal(failed.storage.values.get('session').protocolV2.activeCheckProgress, null);
});

test('a marker attachment write failure does not advance the in-memory integrity counter', async () => {
  const checkId = 'marker-serialize-retry';
  const { harness, player, leaseEpoch, connectionId } = await prepareActiveOutputTest(checkId);
  const marker = {
    type: 'test_event',
    event: 'test_marker',
    eventId: 'marker-serialize-event',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId,
    monotonicTimeMs: 250,
    markerIndex: 0,
    markerTimeMs: 250,
  };

  player.failNextSerialize = new Error('attachment unavailable');
  await assert.rejects(harness.send(player, marker), /attachment unavailable/);
  assert.equal(harness.session.protocolV2.activeCheckProgress.markerCount, 0);
  assert.equal(findMessage(player, (message) => message.eventId === marker.eventId), undefined);

  await harness.send(player, structuredClone(marker));
  assert.equal(harness.session.protocolV2.activeCheckProgress.markerCount, 1);
  assert.equal(findMessage(player, (message) => message.eventId === marker.eventId).status, 'relayed');
});

test('an unproven test failure atomically makes the route and transport unknown', async () => {
  for (const [name, detail] of [
    ['false', { safetyStopped: false, failure: 'detach_timeout' }],
    ['missing', { failure: 'unexpected_adapter_exit' }],
    ['legacy-boolean-only', { safetyStopped: true, failure: 'legacy_untyped_proof' }],
  ]) {
    const checkId = `unsafe-test-${name}`;
    const { harness, control, player, leaseEpoch, connectionId } = await prepareActiveOutputTest(checkId);
    const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;

    await harness.send(player, {
      type: 'test_event',
      event: 'test_failed',
      eventId: `failed-${checkId}`,
      sequence: 1,
      playerInstanceId: 'player-a',
      connectionId,
      leaseEpoch,
      checkId,
      monotonicTimeMs: 20,
      code: 'test_fixture_failed',
      detail,
    });

    assert.equal(harness.session.protocolV2.activeCheckId, null);
    assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
    assert.equal(harness.session.protocolV2.confirmedPlayback.status, 'unknown');
    assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'test_safety_stop_failed');
    assert.equal(harness.session.protocolV2.confirmedPlayback.code, 'test_fixture_failed');
    assert.deepEqual(harness.session.protocolV2.confirmedPlayback.detail, detail);
    assert.equal(harness.session.transport.status, 'unknown');
    assert.equal(player.deserializeAttachment().state, 'unknown');
    assert.equal(messagesOfType(control, 'player_snapshot').length, snapshotsBefore + 1);
    const snapshot = messagesOfType(control, 'player_snapshot').at(-1);
    assert.equal(snapshot.activeCheckId, null);
    assert.equal(snapshot.lease.status, 'unknown');
    assert.equal(snapshot.confirmedPlayback.reasonCode, 'test_safety_stop_failed');
  }
});

test('a test failure with proven safety stop clears only the active check', async () => {
  const checkId = 'safe-test-failure';
  const { harness, control, player, leaseEpoch, connectionId } = await prepareActiveOutputTest(checkId);
  const routeBefore = structuredClone(harness.session.protocolV2.confirmedPlayback);
  const transportBefore = structuredClone(harness.session.transport);
  const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;

  await harness.send(player, {
    type: 'test_event',
    event: 'test_failed',
    eventId: 'failed-safe-test',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId,
    monotonicTimeMs: 20,
    code: 'test_incomplete',
    detail: { safetyStopped: true, failure: 'early_end' },
    safetyPostcondition: {
      status: 'stopped',
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  });

  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.deepEqual(harness.session.protocolV2.confirmedPlayback, routeBefore);
  assert.deepEqual(harness.session.transport, transportBefore);
  assert.equal(player.deserializeAttachment().state, 'ready');
  assert.equal(messagesOfType(control, 'player_snapshot').length, snapshotsBefore + 1);
  const snapshot = messagesOfType(control, 'player_snapshot').at(-1);
  assert.equal(snapshot.activeCheckId, null);
  assert.equal(snapshot.lease.status, 'ready');
});

test('test completion broadcasts a snapshot with the active check cleared', async () => {
  const checkId = 'completed-test';
  const { harness, control, player, leaseEpoch, connectionId } = await prepareActiveOutputTest(checkId);
  const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;

  for (let markerIndex = 0; markerIndex < 3; markerIndex += 1) {
    await harness.send(player, {
      type: 'test_event',
      event: 'test_marker',
      eventId: `complete-marker-${markerIndex}`,
      sequence: markerIndex,
      playerInstanceId: 'player-a',
      connectionId,
      leaseEpoch,
      checkId,
      monotonicTimeMs: 250 * (markerIndex + 1),
      markerIndex,
      markerTimeMs: 250 * (markerIndex + 1),
    });
  }

  await harness.send(player, {
    type: 'test_event',
    event: 'test_complete',
    eventId: 'complete-active-test',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId,
    monotonicTimeMs: 1000,
    markerCount: 3,
    postcondition: { stopped: true },
  });

  assert.equal(harness.session.protocolV2.activeCheckId, null);
  assert.equal(harness.session.protocolV2.activeCheckProgress, null);
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(messagesOfType(control, 'player_snapshot').length, snapshotsBefore + 1);
  const snapshot = messagesOfType(control, 'player_snapshot').at(-1);
  assert.equal(snapshot.activeCheckId, null);
  assert.equal(snapshot.lease.status, 'ready');
});

test('event ID replay is exactly once, conflicts are fenced, and attachment cache survives hibernation', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  const event = outputReadyEvent(player, 'player-a', leaseEpoch, 0, { eventId: 'once-route-ready' });
  const putsBefore = harness.storage.puts.length;
  await harness.send(player, event);

  const rehydratedRoom = new SessionRoom(harness.context, {});
  rehydratedRoom.sessionState = harness.session;
  await rehydratedRoom.webSocketMessage(player, JSON.stringify(structuredClone(event)));
  assert.equal(harness.storage.puts.length, putsBefore + 1);
  assert.deepEqual(
    messagesOfType(player, 'event_ack').filter((message) => message.eventId === event.eventId)
      .map((message) => message.status),
    ['applied', 'duplicate'],
  );
  assert.equal(messagesOfType(control, 'route_event').filter((message) => message.eventId === event.eventId).length, 1);

  await harness.send(player, { ...event, monotonicTimeMs: event.monotonicTimeMs + 1 });
  assert.equal(findMessage(player, (message) => message.code === 'event_id_conflict').type, 'protocol_error');
  assert.equal(harness.storage.puts.length, putsBefore + 1);

  await harness.send(player, { ...event, sequence: event.sequence + 1 });
  await harness.send(player, {
    type: 'playback_event',
    event: 'ready',
    eventId: event.eventId,
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    entryId: 'foreign-entry',
    runId: 'foreign-run',
    monotonicTimeMs: 2,
    mediaTime: 0,
    duration: 30,
    readyState: 4,
    paused: true,
  });
  assert.equal(messagesOfType(player, 'protocol_error').filter((message) => (
    message.code === 'event_id_conflict'
  )).length, 3);
  assert.equal(harness.storage.puts.length, putsBefore + 1);

  await harness.send(player, { ...event, eventId: 'same-sequence-other-event' });
  assert.equal(findMessage(player, (message) => message.code === 'duplicate_sequence').type, 'protocol_error');
  assert.equal(harness.storage.puts.length, putsBefore + 1);
});

test('live reconnect inherits event cache and sequence floors while the superseded socket is fenced', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const original = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, original);
  const leaseEpoch = await activateOutput(harness, control);
  const applied = outputReadyEvent(original, 'player-a', leaseEpoch, 4, { eventId: 'reconnect-route-event' });
  await harness.send(original, applied);
  const putsAfterApply = harness.storage.puts.length;
  const originalConnectionId = original.deserializeAttachment().connectionId;

  const replacement = harness.socket('player');
  await registerPlayer(harness, replacement, { playerInstanceId: 'player-a' });
  const replacementConnectionId = replacement.deserializeAttachment().connectionId;
  assert.notEqual(replacementConnectionId, originalConnectionId);
  assert.equal(replacement.deserializeAttachment().sequenceHighWater.route, 4);
  assert.ok(replacement.deserializeAttachment().eventResultCache.some((entry) => entry.i === applied.eventId));

  await harness.send(replacement, { ...applied, connectionId: replacementConnectionId });
  assert.equal(findMessage(replacement, (message) => (
    message.type === 'event_ack' && message.eventId === applied.eventId
  )).status, 'duplicate');
  assert.equal(harness.storage.puts.length, putsAfterApply);

  await harness.send(replacement, {
    ...applied,
    connectionId: replacementConnectionId,
    eventId: 'below-reconnect-floor',
    sequence: 3,
  });
  assert.equal(findMessage(replacement, (message) => message.code === 'out_of_order_sequence').type, 'protocol_error');

  await harness.send(original, {
    ...applied,
    eventId: 'late-old-transport',
    sequence: 5,
  });
  assert.ok(findMessage(original, (message) => (
    message.code === 'player_hello_required' || message.code === 'foreign_connection'
  )));
  assert.equal(harness.storage.puts.length, putsAfterApply);
});

test('a queued newer hello supersedes before a late old event can begin applying', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const original = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, original);
  const leaseEpoch = await activateOutput(harness, control);
  const oldEvent = outputReadyEvent(original, 'player-a', leaseEpoch, 0, { eventId: 'queued-old-event' });
  const putsBefore = harness.storage.puts.length;

  const release = await harness.room.acquireV2PlayerQueue('player-a');
  const replacement = harness.socket('player');
  const helloPromise = registerPlayer(harness, replacement, { playerInstanceId: 'player-a' });
  const oldEventPromise = harness.send(original, oldEvent);
  release();
  await helloPromise;
  await oldEventPromise;

  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');
  assert.equal(harness.storage.puts.length, putsBefore);
  assert.equal(original.deserializeAttachment().negotiationState, 'superseded');
  assert.equal(replacement.deserializeAttachment().sequenceHighWater?.route, undefined);
});

test('event cache is count and full-attachment byte bounded without persisting telemetry samples', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch);
  const putsBefore = harness.storage.puts.length;
  const connectionId = player.deserializeAttachment().connectionId;

  for (let sequence = 0; sequence < 40; sequence += 1) {
    await harness.send(player, {
      type: 'playback_event',
      event: 'position',
      eventId: `telemetry-${sequence}-${'x'.repeat(180)}`,
      sequence,
      playerInstanceId: 'player-a',
      connectionId,
      leaseEpoch,
      entryId: 'entry-a',
      runId: 'run-a',
      monotonicTimeMs: sequence + 1,
      mediaTime: sequence,
      duration: 100,
      readyState: 4,
      paused: false,
      seeking: false,
    });
  }
  const attachment = player.deserializeAttachment();
  const attachmentBytes = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
  assert.ok(attachment.eventResultCache.length <= 32);
  assert.ok(attachment.eventResultCache.every((entry) => /^[a-f0-9]{64}$/.test(entry.f)));
  assert.ok(attachmentBytes <= 15 * 1024, `attachment is ${attachmentBytes} bytes`);
  assert.equal(harness.storage.puts.length, putsBefore);
  assert.equal(messagesOfType(player, 'event_ack').filter((message) => message.status === 'relayed').length, 40);
});

test('authoritative storage failure leaves session, sequence, cache, and ACK uncommitted for retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  const event = outputReadyEvent(player, 'player-a', leaseEpoch, 0, { eventId: 'retry-after-storage-failure' });
  harness.storage.failNextPut = new Error('fixture_storage_failure');

  await assert.rejects(harness.send(player, event), /fixture_storage_failure/);
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');
  assert.equal(player.deserializeAttachment().sequenceHighWater?.route, undefined);
  assert.equal(Boolean(
    player.deserializeAttachment().eventResultCache?.some((entry) => entry.i === event.eventId)
  ), false);
  assert.equal(harness.session.protocolV2.playerEventCheckpoints.some((checkpoint) => (
    checkpoint.e.some((entry) => entry.i === event.eventId)
  )), false);
  assert.equal(messagesOfType(player, 'event_ack').some((message) => message.eventId === event.eventId), false);

  await harness.send(player, structuredClone(event));
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(findMessage(player, (message) => message.eventId === event.eventId).status, 'applied');
});

test('authoritative state and checkpoint commit atomically before attachment recovery and ACK', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  const event = outputReadyEvent(player, 'player-a', leaseEpoch, 0, {
    eventId: 'checkpoint-before-attachment',
  });
  const putsBefore = harness.storage.puts.length;
  const broadcastsBefore = messagesOfType(control, 'route_event').length;
  player.failNextSerialize = new Error('fixture_attachment_failure');

  await assert.rejects(harness.send(player, event), /fixture_attachment_failure/);

  assert.equal(harness.storage.puts.length, putsBefore + 1);
  const committed = harness.storage.puts.at(-1).value;
  assert.equal(committed.protocolV2.leaseStatus, 'ready');
  assert.equal(committed.protocolV2.confirmedPlayback.reasonCode, 'output_ready_no_playback');
  const checkpoint = committed.protocolV2.playerEventCheckpoints
    .find((entry) => entry.p === 'player-a');
  assert.equal(checkpoint.h.route, 0);
  assert.deepEqual(
    checkpoint.e.find((entry) => entry.i === event.eventId)?.r,
    { s: 'applied', q: 0 },
  );
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(player.deserializeAttachment().sequenceHighWater?.route, undefined);
  assert.equal(Boolean(player.deserializeAttachment().eventResultCache?.some((entry) => (
    entry.i === event.eventId
  ))), false);
  assert.equal(messagesOfType(player, 'event_ack').some((message) => (
    message.eventId === event.eventId
  )), false);
  assert.equal(messagesOfType(control, 'route_event').length, broadcastsBefore + 1);

  await harness.send(player, structuredClone(event));
  assert.equal(harness.storage.puts.length, putsBefore + 1);
  assert.equal(messagesOfType(control, 'route_event').length, broadcastsBefore + 1);
  assert.equal(findMessage(player, (message) => (
    message.type === 'event_ack' && message.eventId === event.eventId
  )).status, 'duplicate');
  assert.equal(player.deserializeAttachment().sequenceHighWater.route, 0);
  assert.equal(player.deserializeAttachment().state, 'ready');
  assert.ok(player.deserializeAttachment().eventResultCache.some((entry) => entry.i === event.eventId));
});

test('fully closed player and new SessionRoom recover durable duplicate and conflict results', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const original = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, original);
  const leaseEpoch = await activateOutput(harness, control);
  const event = outputReadyEvent(original, 'player-a', leaseEpoch, 0, {
    eventId: 'fully-closed-route-retry',
  });
  await harness.send(original, event);
  const putsAfterApply = harness.storage.puts.length;

  const reconnect = async () => {
    harness.context.sockets = [];
    const room = new SessionRoom(harness.context, {});
    const player = new MockSocket(harness.context, 'player');
    harness.context.sockets.push(player);
    const bridge = {
      send: (target, message) => room.webSocketMessage(target, JSON.stringify(message)),
    };
    await registerPlayer(bridge, player, { playerInstanceId: 'player-a' });
    return { room, player, send: bridge.send };
  };

  const recovered = await reconnect();
  await recovered.send(recovered.player, {
    ...event,
    connectionId: recovered.player.deserializeAttachment().connectionId,
  });
  assert.equal(findMessage(recovered.player, (message) => (
    message.type === 'event_ack' && message.eventId === event.eventId
  )).status, 'duplicate');
  assert.equal(harness.storage.puts.length, putsAfterApply);
  assert.equal(recovered.room.sessionState.protocolV2.leaseStatus, 'ready');
  assert.equal(findMessage(recovered.player, (message) => (
    message.code === 'invalid_route_transition'
  )), undefined);

  const conflicted = await reconnect();
  await conflicted.send(conflicted.player, {
    ...event,
    connectionId: conflicted.player.deserializeAttachment().connectionId,
    monotonicTimeMs: event.monotonicTimeMs + 1,
  });
  assert.equal(findMessage(conflicted.player, (message) => (
    message.code === 'event_id_conflict'
  )).type, 'protocol_error');
  assert.equal(harness.storage.puts.length, putsAfterApply);
});

test('durable high-water rejects an evicted authoritative result after a fully closed reconnect', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const original = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, original);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, original, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch);
  const connectionId = original.deserializeAttachment().connectionId;
  const events = [];
  for (let sequence = 0; sequence < 40; sequence += 1) {
    const event = {
      type: 'playback_event',
      event: 'command_applied',
      eventId: `durable-authoritative-${sequence}`,
      sequence,
      playerInstanceId: 'player-a',
      connectionId,
      leaseEpoch,
      entryId: 'entry-a',
      runId: 'run-a',
      monotonicTimeMs: sequence + 1,
      commandId: `durable-command-${sequence}`,
      postcondition: { status: 'applied' },
    };
    events.push(event);
    await harness.send(original, event);
  }
  const checkpoint = harness.session.protocolV2.playerEventCheckpoints
    .find((entry) => entry.p === 'player-a');
  assert.equal(checkpoint.h.runAuthoritative, 39);
  assert.equal(checkpoint.e.length, 32);
  assert.equal(checkpoint.e.some((entry) => entry.i === events[0].eventId), false);
  const putsAfterEvents = harness.storage.puts.length;

  harness.context.sockets = [];
  const rehydratedRoom = new SessionRoom(harness.context, {});
  const replacement = new MockSocket(harness.context, 'player');
  harness.context.sockets.push(replacement);
  const send = (target, message) => rehydratedRoom.webSocketMessage(target, JSON.stringify(message));
  await registerPlayer({ send }, replacement, { playerInstanceId: 'player-a' });
  await send(replacement, {
    ...events[0],
    connectionId: replacement.deserializeAttachment().connectionId,
  });

  const rejection = findMessage(replacement, (message) => message.code === 'event_before_checkpoint');
  assert.deepEqual(rejection.detail, {
    family: 'runAuthoritative', checkpoint: 39, actual: 0,
  });
  assert.equal(harness.storage.puts.length, putsAfterEvents);
  assert.equal(messagesOfType(replacement, 'event_ack').some((message) => (
    message.eventId === events[0].eventId
  )), false);
});

test('durable player checkpoints are bounded by player count, result count, and UTF-8 bytes', () => {
  const harness = createHarness();
  const candidate = structuredClone(harness.session);
  for (let player = 0; player < 5; player += 1) {
    for (let sequence = 0; sequence < 40; sequence += 1) {
      harness.room.appendV2DurableEventCheckpoint(
        candidate,
        {
          playerInstanceId: `bounded-player-${player}`,
          eventId: `bounded-event-${player}-${sequence}-${'x'.repeat(180)}`,
          sequence,
        },
        'runAuthoritative',
        'f'.repeat(64),
        'applied',
      );
    }
  }
  const checkpoints = candidate.protocolV2.playerEventCheckpoints;
  assert.equal(checkpoints.length, 4);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.p),
    ['bounded-player-1', 'bounded-player-2', 'bounded-player-3', 'bounded-player-4'],
  );
  assert.ok(checkpoints.every((checkpoint) => checkpoint.e.length <= 32));
  assert.ok(checkpoints.every((checkpoint) => checkpoint.h.runAuthoritative === 39));

  const oversized = Array.from({ length: 4 }, (_, player) => ({
    p: `oversized-player-${player}-`.padEnd(256, 'p'),
    h: { runAuthoritative: 39 },
    e: Array.from({ length: 32 }, (_, sequence) => ({
      i: `p${player}-e${sequence}-`.padEnd(256, 'x'),
      f: 'f'.repeat(128),
      n: 'runAuthoritative',
      r: { s: 's'.repeat(64), q: sequence },
    })),
  }));
  const byteBounded = harness.room.normalizedV2DurableEventCheckpoints(oversized);
  const checkpointBytes = new TextEncoder().encode(JSON.stringify({
    playerEventCheckpoints: byteBounded,
  })).byteLength;
  assert.ok(checkpointBytes <= 64 * 1024, `checkpoint is ${checkpointBytes} bytes`);
  assert.ok(byteBounded.reduce((sum, checkpoint) => sum + checkpoint.e.length, 0) < 4 * 32);
  assert.ok(byteBounded.every((checkpoint) => checkpoint.h.runAuthoritative === 39));
});

test('emergency ACK requires an event ID and its proof cannot migrate to a replacement connection', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'event-id-emergency',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  const ack = {
    type: 'emergency_stop_ack',
    eventId: 'emergency-proof-event',
    commandId: 'event-id-emergency',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    sequence: 0,
    monotonicTimeMs: 1,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  };
  const missingEventId = { ...ack };
  delete missingEventId.eventId;
  await harness.send(player, missingEventId);
  assert.equal(findMessage(player, (message) => message.code === 'invalid_emergency_ack_identity').type, 'protocol_error');

  await harness.send(player, ack);
  await harness.send(player, structuredClone(ack));
  assert.deepEqual(
    messagesOfType(player, 'event_ack').map((message) => message.status),
    ['applied', 'duplicate'],
  );
  assert.ok(harness.session.protocolV2.playerEventCheckpoints.some((checkpoint) => (
    checkpoint.e.some((entry) => entry.i === ack.eventId && entry.n === 'emergency')
  )));

  const replacement = harness.socket('player');
  await registerPlayer(harness, replacement, { playerInstanceId: 'player-a' });
  await harness.send(replacement, {
    ...ack,
    connectionId: replacement.deserializeAttachment().connectionId,
  });
  assert.equal(findMessage(replacement, (message) => message.code === 'event_id_conflict').type, 'protocol_error');
});

test('WebSocket parsing rejects non-records and bounds every v2 extension by UTF-8 bytes, depth, and nodes', async () => {
  const harness = createHarness();
  const legacy = harness.socket('control');
  for (const raw of ['null', '[]', '1', 'true', '"primitive"']) {
    await harness.room.webSocketMessage(legacy, raw);
  }
  assert.equal(messagesOfType(legacy, 'error').filter((message) => message.code === 'invalid_message').length, 5);

  const largeLegacyDisplay = JSON.stringify({
    type: 'command',
    command: {
      type: 'display_state',
      commandId: 'legacy-large-under-own-limit',
      display: { currentSong: { id: 'legacy-song', title: 'l'.repeat(70_000) }, history: [] },
    },
  });
  assert.ok(new TextEncoder().encode(largeLegacyDisplay).byteLength > 64 * 1024);
  await harness.room.webSocketMessage(legacy, largeLegacyDisplay);
  assert.ok(findMessage(legacy, (message) => message.commandId === 'legacy-large-under-own-limit'));

  const control = harness.socket('control');
  await registerControl(harness, control);
  control.messages.length = 0;
  for (const raw of ['null', '[]', '0', 'false', '"primitive"']) {
    await harness.room.webSocketMessage(control, raw);
  }

  let nested = 'leaf';
  for (let depth = 0; depth < 34; depth += 1) nested = { next: nested };
  await harness.send(control, { type: 'future_extension', extension: nested });
  await harness.send(control, {
    type: 'future_extension',
    extension: Array.from({ length: 4100 }, () => 0),
  });

  const oversized = JSON.stringify({ type: 'future_extension', extension: '🙂'.repeat(20_000) });
  assert.ok(oversized.length < 64 * 1024);
  assert.ok(new TextEncoder().encode(oversized).byteLength > 64 * 1024);
  await harness.room.webSocketMessage(control, oversized);
  await harness.room.webSocketMessage(control, new TextEncoder().encode(oversized));

  assert.equal(
    messagesOfType(control, 'protocol_error').filter((message) => message.code === 'invalid_message').length,
    9,
  );

  await harness.send(control, {
    type: 'display_state',
    commandId: 'bounded-display-state',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {
      display: {
        currentSong: { id: 'display-song', title: 'd'.repeat(8000), type: 'local', tags: [] },
        history: [],
      },
    },
  });
  assert.equal(terminalResults(control, 'bounded-display-state')[0].type, 'command_ack');

  await harness.send(control, { type: 'future_extension', extension: { bounded: true } });
  assert.equal(
    findMessage(control, (message) => message.code === 'unknown_message_type').type,
    'protocol_error',
  );
});

test('a digest failure releases in-flight waiters and the same command ID can execute on retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  await registerControl(harness, control);
  const originalHash = harness.room.hashV2CommandFingerprint.bind(harness.room);
  let rejectDigest;
  let hashCalls = 0;
  harness.room.hashV2CommandFingerprint = (canonical) => {
    hashCalls += 1;
    if (hashCalls === 1) {
      return new Promise((resolve, reject) => {
        rejectDigest = reject;
      });
    }
    return originalHash(canonical);
  };
  const command = {
    type: 'prefetch',
    commandId: 'digest-retry',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { videoIds: [] },
  };

  const first = harness.send(control, command);
  while (!rejectDigest) await Promise.resolve();
  const waiter = harness.send(control, structuredClone(command));
  await Promise.resolve();
  rejectDigest(new Error('fixture_digest_failure'));
  const results = await Promise.race([
    Promise.allSettled([first, waiter]),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('digest retry hung')), 1000)),
  ]);

  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /fixture_digest_failure/);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(harness.room.pendingV2Commands.size, 0);
  assert.equal(terminalResults(control, command.commandId).length, 1);
  assert.equal(terminalResults(control, command.commandId)[0].type, 'command_ack');
  assert.equal(hasCachedCommand(control, command.commandId), true);
  assert.equal(hashCalls, 2);
});

test('an unknown v2 type conflicts with a cached command ID without replacing its first result', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  await registerControl(harness, control);
  const original = {
    type: 'prefetch',
    commandId: 'cached-then-unknown',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { videoIds: ['invalid'] },
  };
  await harness.send(control, original);
  const first = terminalResults(control, original.commandId)[0];
  assert.equal(first.code, 'invalid_aux_payload');
  const cacheBefore = structuredClone(control.deserializeAttachment().commandResultCache);

  await harness.send(control, {
    type: 'future_command',
    commandId: original.commandId,
    payload: { changed: true },
  });
  const conflict = terminalResults(control, original.commandId).at(-1);
  assert.equal(conflict.code, 'command_id_conflict');
  assert.deepEqual(control.deserializeAttachment().commandResultCache, cacheBefore);

  await harness.send(control, structuredClone(original));
  assert.deepEqual(terminalResults(control, original.commandId).at(-1), first);
  await harness.send(control, { type: 'future_command', commandId: 'uncached-future-command' });
  assert.equal(
    findMessage(control, (message) => message.code === 'unknown_message_type').type,
    'protocol_error',
  );
});

test('takeover storage failure leaves the owner and epoch untouched, then the same ID succeeds once', async () => {
  const harness = createHarness();
  const first = harness.socket('control');
  const second = harness.socket('control');
  await registerControl(harness, first, 'atomic-owner');
  await registerControl(harness, second, 'atomic-taker');
  const before = structuredClone(harness.session.protocolV2);
  const command = {
    type: 'control_takeover',
    commandId: 'atomic-takeover',
    controlInstanceId: 'atomic-taker',
    expectedControlEpoch: before.controlEpoch,
  };
  harness.storage.failNextPut = new Error('takeover_storage_failure');

  await assert.rejects(harness.send(second, command), /takeover_storage_failure/);
  assert.deepEqual(harness.session.protocolV2, before);
  assert.equal(terminalResults(second, command.commandId).length, 0);
  assert.equal(hasCachedCommand(second, command.commandId), false);
  assert.equal(harness.room.pendingV2Commands.size, 0);

  await harness.send(second, structuredClone(command));
  assert.equal(harness.session.protocolV2.controlEpoch, before.controlEpoch + 1);
  assert.equal(harness.session.protocolV2.writableControlInstanceId, 'atomic-taker');
  assert.equal(terminalResults(second, command.commandId).length, 1);
  assert.equal(hasCachedCommand(second, command.commandId), true);
});

test('activate and deactivate storage failures do not advance route state or dispatch before retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const activate = {
    type: 'activate_output',
    commandId: 'atomic-activate',
    switchId: 'switch-player-a',
    leaseEpoch: harness.session.protocolV2.leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { outputMode: 'obs' },
  };
  const beforeActivate = structuredClone(harness.session.protocolV2);
  harness.storage.failNextPut = new Error('activate_storage_failure');

  await assert.rejects(harness.send(control, activate), /activate_storage_failure/);
  assert.deepEqual(harness.session.protocolV2, beforeActivate);
  assert.equal(messagesOfType(player, 'activate_output').length, 0);
  assert.equal(player.deserializeAttachment().state, 'standby');
  assert.equal(terminalResults(control, activate.commandId).length, 0);
  assert.equal(hasCachedCommand(control, activate.commandId), false);

  await harness.send(control, structuredClone(activate));
  assert.equal(messagesOfType(player, 'activate_output').length, 1);
  assert.equal(harness.session.protocolV2.leaseEpoch, beforeActivate.leaseEpoch + 1);
  await confirmOutputReady(harness, player, 'player-a', harness.session.protocolV2.leaseEpoch);

  const deactivate = {
    type: 'deactivate_output',
    commandId: 'atomic-deactivate',
    switchId: 'atomic-deactivate-switch',
    leaseEpoch: harness.session.protocolV2.leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  };
  const beforeDeactivate = structuredClone(harness.session.protocolV2);
  harness.storage.failNextPut = new Error('deactivate_storage_failure');
  await assert.rejects(harness.send(control, deactivate), /deactivate_storage_failure/);
  assert.deepEqual(harness.session.protocolV2, beforeDeactivate);
  assert.equal(messagesOfType(player, 'deactivate_output').length, 0);
  assert.equal(terminalResults(control, deactivate.commandId).length, 0);
  assert.equal(hasCachedCommand(control, deactivate.commandId), false);

  await harness.send(control, structuredClone(deactivate));
  assert.equal(messagesOfType(player, 'deactivate_output').length, 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
});

test('load, test, and emergency storage failures leave state, dispatch, cache, and ACK empty until retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);

  const load = {
    type: 'load',
    commandId: 'atomic-load',
    entryId: 'atomic-entry',
    runId: 'atomic-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'atomic-song', title: 'Atomic song' }, position: 0, volume: 80 },
  };
  const beforeLoad = structuredClone(harness.session.protocolV2);
  harness.storage.failNextPut = new Error('load_storage_failure');
  await assert.rejects(harness.send(control, load), /load_storage_failure/);
  assert.deepEqual(harness.session.protocolV2, beforeLoad);
  assert.equal(messagesOfType(player, 'load').length, 0);
  assert.equal(terminalResults(control, load.commandId).length, 0);
  assert.equal(hasCachedCommand(control, load.commandId), false);
  await harness.send(control, structuredClone(load));
  assert.equal(messagesOfType(player, 'load').length, 1);
  assert.deepEqual(harness.session.protocolV2.activeFamily, { entryId: 'atomic-entry', runId: 'atomic-run' });

  const testHarness = createHarness();
  const testControl = testHarness.socket('control');
  const testPlayer = testHarness.socket('player');
  await registerControl(testHarness, testControl);
  await registerPlayer(testHarness, testPlayer);
  const testLeaseEpoch = await activateOutput(testHarness, testControl);
  await confirmOutputReady(testHarness, testPlayer, 'player-a', testLeaseEpoch);

  const startTest = {
    type: 'start_test',
    commandId: 'atomic-start-test',
    checkId: 'atomic-check',
    leaseEpoch: testLeaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: testHarness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  };
  const beforeTest = structuredClone(testHarness.session.protocolV2);
  testHarness.storage.failNextPut = new Error('test_storage_failure');
  await assert.rejects(testHarness.send(testControl, startTest), /test_storage_failure/);
  assert.deepEqual(testHarness.session.protocolV2, beforeTest);
  assert.equal(messagesOfType(testPlayer, 'start_test').length, 0);
  assert.equal(terminalResults(testControl, startTest.commandId).length, 0);
  assert.equal(hasCachedCommand(testControl, startTest.commandId), false);
  await testHarness.send(testControl, structuredClone(startTest));
  assert.equal(messagesOfType(testPlayer, 'start_test').length, 1);
  assert.equal(testHarness.session.protocolV2.activeCheckId, 'atomic-check');

  const emergency = {
    type: 'emergency_stop',
    commandId: 'atomic-emergency',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  };
  const beforeEmergency = structuredClone(harness.session.protocolV2);
  harness.storage.failNextPut = new Error('emergency_storage_failure');
  await assert.rejects(harness.send(control, emergency), /emergency_storage_failure/);
  assert.deepEqual(harness.session.protocolV2, beforeEmergency);
  assert.equal(messagesOfType(player, 'emergency_stop').length, 0);
  assert.equal(terminalResults(control, emergency.commandId).length, 0);
  assert.equal(hasCachedCommand(control, emergency.commandId), false);
  await harness.send(control, structuredClone(emergency));
  assert.equal(messagesOfType(player, 'emergency_stop').length, 1);
  assert.equal(harness.session.protocolV2.leaseEpoch, beforeEmergency.leaseEpoch + 1);
  assert.equal(terminalResults(control, emergency.commandId).length, 1);
});

test('end_session storage failure stays active and retry commits, notifies, and caches exactly once', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  await registerControl(harness, control);
  const command = {
    type: 'end_session',
    commandId: 'atomic-end-session',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  };
  harness.storage.failNextPut = new Error('end_session_storage_failure');
  await assert.rejects(harness.send(control, command), /end_session_storage_failure/);
  assert.equal(harness.session.status, 'active');
  assert.equal(harness.session.endedAt, undefined);
  assert.equal(messagesOfType(control, 'session_ended').length, 0);
  assert.equal(terminalResults(control, command.commandId).length, 0);
  assert.equal(hasCachedCommand(control, command.commandId), false);

  await harness.send(control, structuredClone(command));
  assert.equal(harness.session.status, 'ended');
  assert.equal(messagesOfType(control, 'session_ended').length, 1);
  assert.equal(terminalResults(control, command.commandId).length, 1);
  assert.equal(hasCachedCommand(control, command.commandId), true);
  assert.equal(harness.storage.alarm, harness.session.cleanupAt);

  await harness.send(control, structuredClone(command));
  assert.equal(messagesOfType(control, 'session_ended').length, 1);
  assert.equal(terminalResults(control, command.commandId).length, 2);
  assert.deepEqual(terminalResults(control, command.commandId)[0], terminalResults(control, command.commandId)[1]);
});

test('send failures count as zero delivery and never leave nonpersistent or staged command ghosts', async () => {
  const activationHarness = createHarness();
  const activationControl = activationHarness.socket('control');
  const activationPlayer = activationHarness.socket('player');
  await registerControl(activationHarness, activationControl);
  await registerPlayer(activationHarness, activationPlayer);
  activationPlayer.failNextSend = new Error('activation_socket_closed');
  await activationHarness.send(activationControl, {
    type: 'activate_output',
    commandId: 'failed-send-activation',
    switchId: 'failed-send-switch',
    leaseEpoch: activationHarness.session.protocolV2.leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: activationHarness.session.protocolV2.controlEpoch,
    payload: { outputMode: 'obs' },
  });
  assert.equal(messagesOfType(activationPlayer, 'activate_output').length, 0);
  assert.equal(activationHarness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(terminalResults(activationControl, 'failed-send-activation')[0].code, 'target_not_connected');

  const runHarness = createHarness();
  const runControl = runHarness.socket('control');
  const runPlayer = runHarness.socket('player');
  await registerControl(runHarness, runControl);
  await registerPlayer(runHarness, runPlayer);
  const leaseEpoch = await activateOutput(runHarness, runControl);
  await confirmOutputReady(runHarness, runPlayer, 'player-a', leaseEpoch);
  await loadRun(runHarness, runControl, leaseEpoch);

  const desiredBeforeVolume = structuredClone(runHarness.session.protocolV2.desiredTransport);
  const putsBeforeVolume = runHarness.storage.puts.length;
  runPlayer.failNextSend = new Error('volume_socket_closed');
  await runHarness.send(runControl, {
    type: 'volume',
    commandId: 'failed-send-volume',
    entryId: 'entry-a',
    runId: 'run-a',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: runHarness.session.protocolV2.controlEpoch,
    payload: { volume: 17 },
  });
  assert.deepEqual(runHarness.session.protocolV2.desiredTransport, desiredBeforeVolume);
  assert.equal(runHarness.storage.puts.length, putsBeforeVolume);
  assert.equal(messagesOfType(runPlayer, 'volume').length, 0);
  assert.equal(terminalResults(runControl, 'failed-send-volume')[0].code, 'target_not_connected');

  const stateBeforeLoad = {
    activeFamily: structuredClone(runHarness.session.protocolV2.activeFamily),
    desiredTransport: structuredClone(runHarness.session.protocolV2.desiredTransport),
    confirmedPlayback: structuredClone(runHarness.session.protocolV2.confirmedPlayback),
  };
  runPlayer.failNextSend = new Error('load_socket_closed');
  await runHarness.send(runControl, {
    type: 'load',
    commandId: 'failed-send-load',
    entryId: 'entry-b',
    runId: 'run-b',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: runHarness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'song-b', title: 'Song B' } },
  });
  assert.deepEqual({
    activeFamily: runHarness.session.protocolV2.activeFamily,
    desiredTransport: runHarness.session.protocolV2.desiredTransport,
    confirmedPlayback: runHarness.session.protocolV2.confirmedPlayback,
  }, stateBeforeLoad);
  assert.equal(messagesOfType(runPlayer, 'load').filter((message) => message.commandId === 'failed-send-load').length, 0);
  assert.equal(terminalResults(runControl, 'failed-send-load')[0].code, 'target_not_connected');

  const testHarness = createHarness();
  const testControl = testHarness.socket('control');
  const testPlayer = testHarness.socket('player');
  await registerControl(testHarness, testControl);
  await registerPlayer(testHarness, testPlayer);
  const testLeaseEpoch = await activateOutput(testHarness, testControl);
  await confirmOutputReady(testHarness, testPlayer, 'player-a', testLeaseEpoch);
  testPlayer.failNextSend = new Error('test_socket_closed');
  await testHarness.send(testControl, {
    type: 'start_test',
    commandId: 'failed-send-start-test',
    checkId: 'failed-send-check',
    leaseEpoch: testLeaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: testHarness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  assert.equal(testHarness.session.protocolV2.activeCheckId, null);
  assert.equal(messagesOfType(testPlayer, 'start_test').length, 0);
  assert.equal(terminalResults(testControl, 'failed-send-start-test')[0].code, 'target_not_connected');

  const emergencyHarness = createHarness();
  const emergencyControl = emergencyHarness.socket('control');
  const emergencyPlayer = emergencyHarness.socket('player');
  const emergencyLegacyPlayer = emergencyHarness.socket('player');
  await registerControl(emergencyHarness, emergencyControl);
  await registerPlayer(emergencyHarness, emergencyPlayer);
  emergencyPlayer.failNextSend = new Error('emergency_v2_socket_closed');
  emergencyLegacyPlayer.failNextSend = new Error('emergency_legacy_socket_closed');
  await emergencyHarness.send(emergencyControl, {
    type: 'emergency_stop',
    commandId: 'failed-send-emergency',
    sessionId: emergencyHarness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  const emergencyAck = terminalResults(emergencyControl, 'failed-send-emergency')[0];
  assert.deepEqual(emergencyAck.delivered, { protocolV2: 0, legacy: 0 });
  assert.equal(messagesOfType(emergencyPlayer, 'emergency_stop').length, 0);
  assert.equal(messagesOfType(emergencyLegacyPlayer, 'command').length, 0);
  assert.equal(emergencyHarness.session.protocolV2.confirmedPlayback.status, 'unknown');
});

test('heartbeat warning and stale thresholds use exact 499/500/1999/2000ms boundaries', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const fixedNow = Date.now() + 10_000;
  const expected = [
    [499, false, false],
    [500, true, false],
    [1999, true, false],
    [2000, true, true],
  ];
  for (const [age, warning, stale] of expected) {
    const health = harness.room.playerHeartbeatHealth({ lastSeenAt: fixedNow - age }, fixedNow);
    assert.deepEqual(
      [health.heartbeatAgeMs, health.heartbeatWarning, health.heartbeatStale],
      [age, warning, stale],
    );
  }
  assert.deepEqual(
    harness.room.playerHeartbeatHealth({ lastSeenAt: fixedNow + 1 }, fixedNow),
    {
      lastSeenAt: fixedNow + 1,
      heartbeatAgeMs: 0,
      heartbeatWarning: false,
      heartbeatStale: false,
    },
  );

  const originalNow = Date.now;
  const putsBeforeSnapshot = harness.storage.puts.length;
  try {
    Date.now = () => fixedNow;
    player.serializeAttachment({
      ...player.deserializeAttachment(),
      lastSeenAt: fixedNow - 500,
      runtime: { sourceActive: true },
    });
    const snapshot = harness.room.protocolV2Snapshot(harness.session);
    const snapshotPlayer = snapshot.players.find((entry) => entry.playerInstanceId === 'player-a');
    assert.deepEqual(
      {
        heartbeatAgeMs: snapshotPlayer.heartbeatAgeMs,
        heartbeatWarning: snapshotPlayer.heartbeatWarning,
        heartbeatStale: snapshotPlayer.heartbeatStale,
      },
      { heartbeatAgeMs: 500, heartbeatWarning: true, heartbeatStale: false },
    );
    assert.equal(snapshot.eligibleCandidates.obs.includes('player-a'), true);

    player.serializeAttachment({ ...player.deserializeAttachment(), lastSeenAt: fixedNow - 1999 });
    assert.equal(harness.room.eligiblePlayerRecords('obs').length, 1);
    player.serializeAttachment({ ...player.deserializeAttachment(), lastSeenAt: fixedNow - 2000 });
    assert.equal(harness.room.eligiblePlayerRecords('obs').length, 0);
    player.serializeAttachment({
      ...player.deserializeAttachment(),
      lastSeenAt: fixedNow,
      runtime: { sourceActive: false },
    });
    assert.equal(harness.room.eligiblePlayerRecords('obs').length, 0);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
  assert.equal(harness.storage.puts.length, putsBeforeSnapshot);
});

test('healthy heartbeat is relayed and ACKed without storage, while invalid or duplicate input is not ACKed', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const connectionId = player.deserializeAttachment().connectionId;
  const heartbeat = {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch: 0,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: true },
  };
  const putsBefore = harness.storage.puts.length;
  const relaysBefore = messagesOfType(control, 'player_heartbeat').length;

  await harness.send(player, heartbeat);

  assert.equal(harness.storage.puts.length, putsBefore);
  assert.equal(messagesOfType(control, 'player_heartbeat').length, relaysBefore + 1);
  const ack = messagesOfType(player, 'heartbeat_ack').at(-1);
  assert.deepEqual(ack, {
    type: 'heartbeat_ack',
    protocolVersion: 2,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch: 0,
    sequence: 0,
  });
  assert.equal(validateOnAirMessage(ack).ok, true);
  assert.equal(player.deserializeAttachment().sequenceHighWater.heartbeat, 0);

  await harness.send(player, structuredClone(heartbeat));
  await harness.send(player, { ...heartbeat, sequence: 1, connectionId: 'foreign-connection' });
  await harness.send(player, { ...heartbeat, sequence: 1, leaseEpoch: 1 });
  assert.equal(messagesOfType(player, 'heartbeat_ack').length, 1);
  assert.equal(messagesOfType(control, 'player_heartbeat').length, relaysBefore + 1);
  assert.equal(harness.storage.puts.length, putsBefore);
  assert.ok(findMessage(player, (message) => message.code === 'duplicate_sequence'));
  assert.ok(findMessage(player, (message) => message.code === 'foreign_connection'));
  assert.ok(findMessage(player, (message) => message.code === 'future_lease_epoch'));
});

test('heartbeat ACK follows durable liveness commit, attachment serialization, and control relay', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const connectionId = player.deserializeAttachment().connectionId;
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: true },
  });

  const order = [];
  const originalPut = harness.storage.put.bind(harness.storage);
  harness.storage.put = async (...args) => {
    await originalPut(...args);
    order.push('storage_committed');
  };
  const originalSerialize = player.serializeAttachment.bind(player);
  player.serializeAttachment = (attachment) => {
    originalSerialize(attachment);
    if (attachment.sequenceHighWater?.heartbeat === 0) order.push('attachment_serialized');
  };
  const originalControlSend = control.send.bind(control);
  control.send = (rawMessage) => {
    const message = JSON.parse(rawMessage);
    originalControlSend(rawMessage);
    if (message.type === 'player_heartbeat') order.push('control_relayed');
  };
  const originalPlayerSend = player.send.bind(player);
  player.send = (rawMessage) => {
    const message = JSON.parse(rawMessage);
    if (message.type === 'heartbeat_ack') {
      assert.equal(player.deserializeAttachment().sequenceHighWater.heartbeat, 0);
      assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
      order.push('ack_sent');
    }
    originalPlayerSend(rawMessage);
  };

  await harness.send(player, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: true },
  });

  assert.deepEqual(order, [
    'storage_committed',
    'attachment_serialized',
    'control_relayed',
    'ack_sent',
  ]);
  const ack = messagesOfType(player, 'heartbeat_ack').at(-1);
  assert.deepEqual(Object.keys(ack), [
    'type',
    'protocolVersion',
    'playerInstanceId',
    'connectionId',
    'leaseEpoch',
    'sequence',
  ]);
  assert.equal(ack.leaseEpoch, harness.session.protocolV2.leaseEpoch);
});

test('standby heartbeat can lag the global lease and receives the current epoch for later activation', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const playerA = harness.socket('player');
  const playerB = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, playerA);
  await registerPlayer(harness, playerB, {
    playerInstanceId: 'player-b',
    clientKind: 'dashboard-speaker',
    capabilities: { sinkSelection: true, analyser: true },
  });

  const playerAEpoch = await activateOutput(harness, control, 'player-a', 'obs');
  assert.equal(playerAEpoch, 1);
  await confirmOutputReady(harness, playerA, 'player-a', playerAEpoch);
  await harness.send(playerB, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-b',
    connectionId: playerB.deserializeAttachment().connectionId,
    leaseEpoch: 0,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: true },
  });
  const standbyAck = messagesOfType(playerB, 'heartbeat_ack').at(-1);
  assert.equal(standbyAck.leaseEpoch, 1);
  assert.equal(standbyAck.sequence, 0);

  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'deactivate-player-a-for-b',
    switchId: 'switch-deactivate-player-a-for-b',
    leaseEpoch: playerAEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  await harness.send(playerA, outputReadyEvent(playerA, 'player-a', playerAEpoch, 1, {
    type: 'route_event',
    event: 'output_deactivated',
    eventId: 'player-a-deactivated-for-b',
    switchId: 'switch-deactivate-player-a-for-b',
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  }));
  assert.equal(harness.session.protocolV2.leaseTarget, null);

  const playerBEpoch = await activateOutput(harness, control, 'player-b', 'speaker');
  assert.equal(playerBEpoch, 2);
  const activation = messagesOfType(playerB, 'activate_output').at(-1);
  assert.equal(activation.leaseEpoch, 2);
  assert.equal(activation.targetPlayerInstanceId, 'player-b');
});

test('stale or disconnected active output durably refuses every run and test command without delivery', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: true },
  });
  const putsBefore = harness.storage.puts.length;
  const runCommands = [
    ['load', { song: { id: 'stale-song', title: 'Stale song' } }],
    ['play', {}],
    ['pause', {}],
    ['seek', { position: 5 }],
    ['volume', { volume: 50 }],
    ['stop', {}],
  ];
  for (const [type, payload] of runCommands) {
    const commandId = `stale-${type}`;
    await harness.send(control, {
      type,
      commandId,
      entryId: 'stale-entry',
      runId: 'stale-run',
      leaseEpoch,
      targetPlayerInstanceId: 'player-a',
      controlEpoch: harness.session.protocolV2.controlEpoch,
      payload,
    });
    const rejection = terminalResults(control, commandId)[0];
    assert.equal(rejection.code, 'active_output_unavailable');
    assert.equal(rejection.detail.reasonCode, 'target_heartbeat_stale');
    assert.equal(messagesOfType(player, type).some((message) => message.commandId === commandId), false);
  }
  await harness.send(control, {
    type: 'start_test',
    commandId: 'stale-start-test',
    checkId: 'stale-check',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });
  assert.equal(terminalResults(control, 'stale-start-test')[0].code, 'active_output_unavailable');
  assert.equal(messagesOfType(player, 'start_test').length, 0);
  assert.equal(harness.storage.puts.length, putsBefore + 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_heartbeat_stale');
  assert.equal(harness.session.transport.status, 'unknown');

  const disconnected = createHarness();
  const disconnectedControl = disconnected.socket('control');
  const disconnectedPlayer = disconnected.socket('player');
  await registerControl(disconnected, disconnectedControl);
  await registerPlayer(disconnected, disconnectedPlayer);
  const disconnectedLease = await activateOutput(disconnected, disconnectedControl);
  await confirmOutputReady(disconnected, disconnectedPlayer, 'player-a', disconnectedLease);
  disconnected.context.sockets = [disconnectedControl];
  await disconnected.send(disconnectedControl, {
    type: 'load',
    commandId: 'disconnected-load',
    entryId: 'disconnected-entry',
    runId: 'disconnected-run',
    leaseEpoch: disconnectedLease,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: disconnected.session.protocolV2.controlEpoch,
    payload: { song: { id: 'disconnected-song', title: 'Disconnected song' } },
  });
  assert.equal(
    terminalResults(disconnectedControl, 'disconnected-load')[0].detail.reasonCode,
    'target_disconnected',
  );
  assert.equal(disconnected.session.protocolV2.leaseStatus, 'unknown');
});

test('a late active heartbeat latches unknown and only deactivate then reactivate restores readiness', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const connectionId = player.deserializeAttachment().connectionId;
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: true },
  });
  const heartbeat = {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: true },
  };
  const putsBefore = harness.storage.puts.length;
  await harness.send(player, heartbeat);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_heartbeat_stale');
  assert.equal(harness.session.transport.status, 'unknown');
  assert.equal(player.deserializeAttachment().sequenceHighWater.heartbeat, 0);
  assert.equal(player.deserializeAttachment().runtime.sourceActive, true);
  assert.ok(findMessage(control, (message) => message.type === 'player_heartbeat'));

  await harness.send(player, { ...heartbeat, sequence: 1, monotonicTimeMs: 2 });
  assert.equal(harness.storage.puts.length, putsBefore + 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_heartbeat_stale');
  assert.equal(player.deserializeAttachment().sequenceHighWater.heartbeat, 1);

  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'late-heartbeat-deactivate',
    switchId: 'late-heartbeat-deactivate-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');
  await harness.send(player, {
    type: 'route_event',
    event: 'output_deactivated',
    eventId: 'late-heartbeat-deactivated',
    sequence: 1,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    switchId: 'late-heartbeat-deactivate-switch',
    monotonicTimeMs: 3,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'inactive');

  await harness.send(control, {
    type: 'activate_output',
    commandId: 'late-heartbeat-reactivate',
    switchId: 'late-heartbeat-reactivate-switch',
    leaseEpoch: harness.session.protocolV2.leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { outputMode: 'obs' },
  });
  const reactivatedLease = harness.session.protocolV2.leaseEpoch;
  assert.equal(harness.session.protocolV2.leaseStatus, 'activating');
  await harness.send(player, outputReadyEvent(player, 'player-a', reactivatedLease, 2, {
    eventId: 'late-heartbeat-ready-again',
    switchId: 'late-heartbeat-reactivate-switch',
  }));
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');
});

test('OBS eligibility requires sourceActive true while speaker eligibility keeps its prior missing-runtime behavior', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const missing = harness.socket('player');
  const inactive = harness.socket('player');
  const active = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, missing, {
    playerInstanceId: 'obs-runtime-missing',
    runtime: {},
  });
  await registerPlayer(harness, inactive, {
    playerInstanceId: 'obs-runtime-false',
    runtime: { sourceActive: false },
  });
  await registerPlayer(harness, active, {
    playerInstanceId: 'obs-runtime-true',
    runtime: { sourceActive: true },
  });

  const obsSnapshot = harness.room.protocolV2Snapshot(harness.session);
  assert.deepEqual(obsSnapshot.eligibleCandidates.obs, ['obs-runtime-true']);
  await activateOutput(harness, control, 'obs-runtime-true');
  assert.equal(messagesOfType(missing, 'activate_output').length, 0);
  assert.equal(messagesOfType(inactive, 'activate_output').length, 0);
  assert.equal(messagesOfType(active, 'activate_output').length, 1);

  const speakerHarness = createHarness();
  const speakerControl = speakerHarness.socket('control');
  const speaker = speakerHarness.socket('player');
  await registerControl(speakerHarness, speakerControl);
  await registerPlayer(speakerHarness, speaker, {
    playerInstanceId: 'speaker-runtime-missing',
    clientKind: 'dashboard-speaker',
    capabilities: { sinkSelection: true, analyser: true },
    runtime: {},
  });
  assert.deepEqual(
    speakerHarness.room.protocolV2Snapshot(speakerHarness.session).eligibleCandidates.speaker,
    ['speaker-runtime-missing'],
  );
  await activateOutput(speakerHarness, speakerControl, 'speaker-runtime-missing', 'speaker');
  assert.equal(messagesOfType(speaker, 'activate_output').length, 1);
});

test('sourceActive true-to-false latches only the active target and excludes standby activation candidates', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const active = harness.socket('player');
  const standby = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, active);
  await registerPlayer(harness, standby, {
    playerInstanceId: 'player-b',
    clientKind: 'dashboard-speaker',
    capabilities: { sinkSelection: true, analyser: true },
  });
  assert.equal(active.deserializeAttachment().runtime.sourceActive, true);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, active, 'player-a', leaseEpoch);
  const putsBeforeStandby = harness.storage.puts.length;
  await harness.send(standby, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-b',
    connectionId: standby.deserializeAttachment().connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: false },
  });
  assert.equal(harness.storage.puts.length, putsBeforeStandby);
  assert.equal(harness.session.protocolV2.leaseStatus, 'ready');

  await harness.send(active, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId: active.deserializeAttachment().connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 2,
    runtime: { sourceActive: false },
  });
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_source_inactive');

  const inactiveCandidate = createHarness();
  const candidateControl = inactiveCandidate.socket('control');
  const candidatePlayer = inactiveCandidate.socket('player');
  await registerControl(inactiveCandidate, candidateControl);
  await registerPlayer(inactiveCandidate, candidatePlayer);
  await inactiveCandidate.send(candidatePlayer, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId: candidatePlayer.deserializeAttachment().connectionId,
    leaseEpoch: 0,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: false },
  });
  await activateOutput(inactiveCandidate, candidateControl);
  assert.equal(terminalResults(candidateControl, 'activate-player-a')[0].code, 'output_candidate_count');
  assert.equal(messagesOfType(candidatePlayer, 'activate_output').length, 0);
});

test('stale or source-inactive targets still receive deactivate and emergency recovery commands', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: false },
  });
  await harness.send(control, {
    type: 'deactivate_output',
    commandId: 'stale-recovery-deactivate',
    switchId: 'stale-recovery-switch',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: {},
  });
  assert.equal(messagesOfType(player, 'deactivate_output').length, 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'deactivating');

  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: false },
  });
  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'stale-recovery-emergency',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  assert.equal(messagesOfType(player, 'emergency_stop').length, 1);
  assert.equal(harness.session.protocolV2.leaseStatus, 'emergency_stopping');
});

test('heartbeat liveness storage failure leaves attachment and relays untouched, then retries cleanly', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: true },
  });
  const heartbeat = {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId: player.deserializeAttachment().connectionId,
    leaseEpoch,
    sequence: 0,
    monotonicTimeMs: 1,
    runtime: { sourceActive: true },
  };
  const sessionBefore = structuredClone(harness.session);
  const attachmentBefore = structuredClone(player.deserializeAttachment());
  const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;
  const relaysBefore = messagesOfType(control, 'player_heartbeat').length;
  const acknowledgementsBefore = messagesOfType(player, 'heartbeat_ack').length;
  harness.storage.failNextPut = new Error('heartbeat_liveness_storage_failure');

  await assert.rejects(harness.send(player, heartbeat), /heartbeat_liveness_storage_failure/);
  assert.deepEqual(harness.session, sessionBefore);
  assert.deepEqual(player.deserializeAttachment(), attachmentBefore);
  assert.equal(messagesOfType(control, 'player_snapshot').length, snapshotsBefore);
  assert.equal(messagesOfType(control, 'player_heartbeat').length, relaysBefore);
  assert.equal(messagesOfType(player, 'heartbeat_ack').length, acknowledgementsBefore);

  await harness.send(player, structuredClone(heartbeat));
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_heartbeat_stale');
  assert.equal(player.deserializeAttachment().sequenceHighWater.heartbeat, 0);
  assert.equal(messagesOfType(control, 'player_heartbeat').length, relaysBefore + 1);
  const retryAck = messagesOfType(player, 'heartbeat_ack').at(-1);
  assert.equal(messagesOfType(player, 'heartbeat_ack').length, acknowledgementsBefore + 1);
  assert.deepEqual(retryAck, {
    type: 'heartbeat_ack',
    protocolVersion: 2,
    playerInstanceId: 'player-a',
    connectionId: heartbeat.connectionId,
    leaseEpoch,
    sequence: 0,
  });
});

test('run liveness storage failure does not reject, cache, snapshot, or dispatch before retry', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  player.serializeAttachment({
    ...player.deserializeAttachment(),
    lastSeenAt: Date.now() - 2000,
    runtime: { sourceActive: true },
  });
  const command = {
    type: 'load',
    commandId: 'liveness-storage-retry',
    entryId: 'liveness-entry',
    runId: 'liveness-run',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { song: { id: 'liveness-song', title: 'Liveness song' } },
  };
  const sessionBefore = structuredClone(harness.session);
  const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;
  harness.storage.failNextPut = new Error('run_liveness_storage_failure');

  await assert.rejects(harness.send(control, command), /run_liveness_storage_failure/);
  assert.deepEqual(harness.session, sessionBefore);
  assert.equal(messagesOfType(player, 'load').length, 0);
  assert.equal(terminalResults(control, command.commandId).length, 0);
  assert.equal(hasCachedCommand(control, command.commandId), false);
  assert.equal(messagesOfType(control, 'player_snapshot').length, snapshotsBefore);

  await harness.send(control, structuredClone(command));
  assert.equal(terminalResults(control, command.commandId)[0].code, 'active_output_unavailable');
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(messagesOfType(player, 'load').length, 0);
});

test('active socket close latches unknown only after its durable write succeeds', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  const sessionBefore = structuredClone(harness.session);
  const controlMessagesBefore = structuredClone(control.messages);
  const snapshotsBefore = messagesOfType(control, 'player_snapshot').length;
  harness.storage.failNextPut = new Error('close_liveness_storage_failure');

  await assert.rejects(harness.room.webSocketClose(player), /close_liveness_storage_failure/);
  assert.deepEqual(harness.session, sessionBefore);
  assert.deepEqual(control.messages, controlMessagesBefore);

  await harness.room.webSocketClose(player);
  assert.equal(harness.session.protocolV2.leaseStatus, 'unknown');
  assert.equal(harness.session.protocolV2.confirmedPlayback.reasonCode, 'target_disconnected');
  assert.ok(messagesOfType(control, 'player_snapshot').length > snapshotsBefore);
});

test('player-origin protocol families reject a server-owned targetConnectionId before event guards', async () => {
  const harness = createHarness();
  const control = harness.socket('control');
  const player = harness.socket('player');
  await registerControl(harness, control);
  await registerPlayer(harness, player);
  const connectionId = player.deserializeAttachment().connectionId;
  const leaseEpoch = await activateOutput(harness, control);
  await confirmOutputReady(harness, player, 'player-a', leaseEpoch);
  await loadRun(harness, control, leaseEpoch);
  await harness.send(control, {
    type: 'start_test',
    commandId: 'foreign-field-start-test',
    checkId: 'foreign-field-check',
    leaseEpoch,
    targetPlayerInstanceId: 'player-a',
    controlEpoch: harness.session.protocolV2.controlEpoch,
    payload: { fixtureId: 'pcm-pulse-v1', durationMs: 1000 },
  });

  await harness.send(player, {
    type: 'player_heartbeat',
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    sequence: 0,
    targetConnectionId: connectionId,
  });
  await harness.send(player, {
    type: 'playback_event',
    event: 'ready',
    eventId: 'foreign-target-playback',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    entryId: 'entry-a',
    runId: 'run-a',
    monotonicTimeMs: 1,
    mediaTime: 0,
    duration: 30,
    readyState: 4,
    paused: true,
    targetConnectionId: connectionId,
  });
  await harness.send(player, outputReadyEvent(player, 'player-a', leaseEpoch, 1, {
    eventId: 'foreign-target-route',
    targetConnectionId: connectionId,
  }));
  await harness.send(player, {
    type: 'test_event',
    event: 'test_started',
    eventId: 'foreign-target-test',
    sequence: 0,
    playerInstanceId: 'player-a',
    connectionId,
    leaseEpoch,
    checkId: 'foreign-field-check',
    monotonicTimeMs: 2,
    targetConnectionId: connectionId,
  });

  assert.ok(findMessage(player, (message) => message.code === 'invalid_heartbeat_identity'));
  assert.ok(findMessage(player, (message) => message.code === 'invalid_playback_event'));
  assert.ok(findMessage(player, (message) => message.code === 'invalid_route_event'));
  assert.ok(findMessage(player, (message) => message.code === 'invalid_test_event'));
  const beforeEmergencyHwm = structuredClone(player.deserializeAttachment().sequenceHighWater);

  await harness.send(control, {
    type: 'emergency_stop',
    commandId: 'foreign-target-emergency',
    sessionId: harness.session.room,
    authenticatedControlInstanceId: 'control-a',
  });
  await harness.send(player, {
    type: 'emergency_stop_ack',
    eventId: 'foreign-target-emergency-event',
    commandId: 'foreign-target-emergency',
    sessionId: harness.session.room,
    playerInstanceId: 'player-a',
    connectionId,
    sequence: 0,
    monotonicTimeMs: 3,
    postcondition: { mediaPaused: true, sourceDetached: true, autoplayCancelled: true },
    targetConnectionId: connectionId,
  });
  assert.ok(findMessage(player, (message) => message.code === 'invalid_emergency_ack_identity'));
  assert.deepEqual(player.deserializeAttachment().sequenceHighWater, beforeEmergencyHwm);
  for (const eventId of [
    'foreign-target-playback', 'foreign-target-route', 'foreign-target-test', 'foreign-target-emergency-event',
  ]) {
    assert.equal(player.deserializeAttachment().eventResultCache?.some((entry) => entry.i === eventId), false);
  }
});
