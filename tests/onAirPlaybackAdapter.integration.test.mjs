import test from 'node:test';
import assert from 'node:assert/strict';

import { OnAirPlaybackAdapter } from '../src/lib/onAirPlaybackAdapter.js';
import {
  OnAirV2Connection,
  ON_AIR_V2_CONNECTION_STATES,
} from '../src/lib/onAirV2Connection.js';
import { PlaybackEngine } from '../src/lib/playbackEngine.js';
import {
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  PLAYER_CLIENT_KINDS,
  ROUTE_EVENT_TYPES,
  RUN_EVENT_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_COMMAND_TYPES,
  TEST_EVENT_TYPES,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from '../src/lib/onAirProtocol.js';
import { ON_AIR_TEST_FIXTURE_ID } from '../src/lib/onAirTestFixture.js';

class BrowserSocketDouble {
  readyState = 0;
  sent = [];
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(value) {
    if (this.readyState !== 1) throw new Error('socket_not_open');
    this.sent.push(value);
  }

  open() {
    this.readyState = 1;
    this.#emit('open', {});
  }

  receive(frame) {
    this.#emit('message', { data: JSON.stringify(frame) });
  }

  close(code = 1000) {
    this.readyState = 3;
    this.#emit('close', { code, wasClean: true });
  }

  messages() {
    return this.sent.map((value) => JSON.parse(value));
  }

  #emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

class BrowserAudioDouble {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.srcObject = null;
    this.autoplay = true;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 180;
    this.volume = 1;
    this.readyState = 4;
    this.networkState = 0;
    this.seeking = false;
    this.ended = false;
    this.error = null;
    this.currentSrcValue = '';
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.loadCalls = 0;
  }

  get src() {
    return this.attributes.get('src') ?? '';
  }

  set src(value) {
    this.attributes.set('src', String(value));
  }

  get currentSrc() {
    return this.currentSrcValue;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector() {
    return null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    const event = { type, target: this, currentTarget: this };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  load() {
    this.loadCalls += 1;
    this.paused = true;
    if (this.attributes.has('src')) {
      this.currentSrcValue = this.attributes.get('src');
      this.networkState = 2;
    } else {
      // Chromium can retain currentSrc as history after NETWORK_EMPTY.
      this.networkState = 0;
    }
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatch('pause');
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatch('playing');
    return Promise.resolve();
  }
}

function createClock() {
  let value = 0;
  return {
    now() {
      value += 1;
      return value;
    },
  };
}

function assertValidWireFrame(frame) {
  const validation = validateOnAirMessage(frame);
  assert.equal(validation.ok, true, JSON.stringify({ frame, errors: validation.errors }));
}

function receivePlayerCommand(socket, command) {
  const validation = validateOnAirPlayerCommand(command);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  socket.receive(command);
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('default adapter composes the real connection and engine from route activation through emergency detach', async (t) => {
  const socket = new BrowserSocketDouble();
  const audio = new BrowserAudioDouble();
  const clock = createClock();
  const idCounts = new Map();
  const idFactory = (scope) => {
    const count = (idCounts.get(scope) ?? 0) + 1;
    idCounts.set(scope, count);
    return `${scope}-integration-${count}`;
  };
  const adapter = new OnAirPlaybackAdapter({
    connectionOptions: {
      url: 'wss://example.invalid/session?protocol=2',
      webSocketFactory: () => socket,
      now: () => clock.now(),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      idFactory,
      buildId: 'integration-build',
      capabilities: { obsRuntime: true },
      clientKind: PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
    },
    engineOptions: {
      audio,
      clock,
      urlApi: {
        createObjectURL: () => 'blob:integration-source',
        revokeObjectURL: () => {},
      },
    },
    sourceResolver: async () => ({
      kind: 'url',
      url: 'https://media.example/integration.mp3',
    }),
    outputPathProbe: ({ engine, signal }) => ({
      ready: signal.aborted === false
        && engine.mediaPaused === true
        && engine.sourceAttached === false,
    }),
    runtimeProbe: () => ({ sourceActive: true, sourceVisible: true }),
    now: () => clock.now(),
  });
  t.after(() => adapter.dispose());

  assert.equal(adapter.connection instanceof OnAirV2Connection, true);
  assert.equal(adapter.engine instanceof PlaybackEngine, true);

  adapter.connect();
  socket.open();
  const playerInstanceId = adapter.connection.identity.playerInstanceId;
  const connectionId = 'player-connection-integration';
  const welcome = {
    type: SERVER_MESSAGE_TYPES.PLAYER_WELCOME,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    connectionId,
    playerInstanceId,
    leaseEpoch: 1,
    leaseTarget: playerInstanceId,
    leaseStatus: 'active',
  };
  assertValidWireFrame(welcome);
  socket.receive(welcome);
  assert.equal(adapter.connection.state, ON_AIR_V2_CONNECTION_STATES.READY);

  receivePlayerCommand(socket, {
    type: 'activate_output',
    commandId: 'activate-integration',
    switchId: 'switch-integration',
    leaseEpoch: 2,
    targetPlayerInstanceId: playerInstanceId,
    targetConnectionId: connectionId,
    controlEpoch: 7,
    payload: { outputMode: 'obs' },
  });
  const outputReady = await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.ROUTE_EVENT
        && frame.event === ROUTE_EVENT_TYPES.OUTPUT_READY
    )),
    'output_ready',
  );
  assert.deepEqual(outputReady.postcondition, {
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    outputPathReady: true,
    audible: false,
  });
  assert.equal(adapter.snapshot().safetyLocked, false);

  receivePlayerCommand(socket, {
    type: TEST_COMMAND_TYPES.START,
    commandId: 'start-test-integration',
    checkId: 'check-integration',
    leaseEpoch: 2,
    targetPlayerInstanceId: playerInstanceId,
    targetConnectionId: connectionId,
    controlEpoch: 7,
    payload: {
      fixtureId: ON_AIR_TEST_FIXTURE_ID,
      durationMs: 1_000,
    },
  });
  const fixtureOutcome = await waitFor(() => (
    audio.getAttribute('src') === 'blob:integration-source'
      ? { attached: true }
      : socket.messages().find((frame) => (
        frame.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT
          && frame.event === TEST_EVENT_TYPES.TEST_FAILED
      ))
  ), 'fixture Blob attachment');
  assert.deepEqual(fixtureOutcome, { attached: true });
  assert.equal(adapter.engine.snapshot().sourceKind, 'blob');
  assert.equal(audio.paused, true);

  audio.duration = 1;
  audio.dispatch('canplay');
  await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT
        && frame.event === TEST_EVENT_TYPES.TEST_STARTED
    )),
    'test_started after real playing evidence',
  );
  assert.equal(audio.playCalls, 1);

  audio.currentTime = 0.6;
  audio.dispatch('timeupdate');
  const testMarkers = await waitFor(() => {
    const markers = socket.messages().filter((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT
        && frame.event === TEST_EVENT_TYPES.TEST_MARKER
    ));
    return markers.length === 4 ? markers : null;
  }, 'four media-time test markers');
  assert.deepEqual(testMarkers.map((frame) => frame.markerTimeMs), [50, 200, 350, 500]);
  assert.equal(testMarkers.some((frame) => (
    Object.hasOwn(frame, 'rmsDbfs') || Object.hasOwn(frame, 'peakDbfs')
  )), false);
  for (const marker of testMarkers) {
    const ack = {
      type: SERVER_MESSAGE_TYPES.EVENT_ACK,
      protocolVersion: ON_AIR_PROTOCOL_VERSION,
      eventId: marker.eventId,
      playerInstanceId,
      sequence: marker.sequence,
      status: 'relayed',
    };
    assertValidWireFrame(ack);
    socket.receive(ack);
  }
  await waitFor(
    () => adapter.snapshot().activeTest?.acknowledgedMarkerCount === 4,
    'four exact relayed marker ACKs',
  );

  audio.currentTime = 1;
  audio.paused = true;
  audio.ended = true;
  audio.dispatch('ended');
  const testComplete = await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT
        && frame.event === TEST_EVENT_TYPES.TEST_COMPLETE
    )),
    'test_complete after physical detach',
  );
  assert.equal(testComplete.markerCount, 4);
  assert.deepEqual(testComplete.postcondition, { stopped: true });
  assert.equal(audio.getAttribute('src'), null);
  assert.equal(adapter.engine.snapshot().sourceAttached, false);

  audio.currentTime = 0;
  audio.duration = 180;
  audio.ended = false;

  const runIdentity = {
    entryId: 'entry-integration',
    runId: 'run-integration',
    leaseEpoch: 2,
    targetPlayerInstanceId: playerInstanceId,
    targetConnectionId: connectionId,
    controlEpoch: 7,
  };
  receivePlayerCommand(socket, {
    type: 'load',
    commandId: 'load-integration',
    ...runIdentity,
    payload: {
      song: { type: 'youtube', src: 'dQw4w9WgXcQ' },
      position: 0,
      volume: 72,
    },
  });
  await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT
        && frame.event === RUN_EVENT_TYPES.COMMAND_APPLIED
        && frame.commandId === 'load-integration'
    )),
    'load command_applied',
  );
  assert.equal(audio.getAttribute('src'), 'https://media.example/integration.mp3');
  assert.equal(adapter.engine.snapshot().sourceAttached, true);
  assert.equal(audio.paused, true);

  audio.dispatch('canplay');
  await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT
        && frame.event === RUN_EVENT_TYPES.READY
    )),
    'ready evidence',
  );

  receivePlayerCommand(socket, {
    type: 'play',
    commandId: 'play-integration',
    ...runIdentity,
  });
  await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT
        && frame.event === RUN_EVENT_TYPES.PLAYING
    )),
    'playing evidence',
  );
  await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT
        && frame.event === RUN_EVENT_TYPES.COMMAND_APPLIED
        && frame.commandId === 'play-integration'
    )),
    'play command_applied',
  );
  assert.equal(audio.paused, false);
  assert.equal(audio.playCalls, 2);

  receivePlayerCommand(socket, {
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: 'emergency-integration',
    sessionId: 'session-integration',
    authenticatedControlInstanceId: 'control-integration',
    targetConnectionId: connectionId,
  });
  const emergencyAck = await waitFor(
    () => socket.messages().find((frame) => (
      frame.type === ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK
        && frame.commandId === 'emergency-integration'
    )),
    'emergency_stop_ack',
  );
  assert.deepEqual(emergencyAck.postcondition, {
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
  });
  assert.equal(audio.paused, true);
  assert.equal(audio.getAttribute('src'), null);
  assert.equal(audio.networkState, 0);
  assert.equal(adapter.engine.snapshot().sourceAttached, false);
  assert.equal(adapter.snapshot().safetyLocked, true);
  assert.equal(adapter.snapshot().routeState, 'emergency_stopped_event_sent');

  for (const frame of socket.messages()) assertValidWireFrame(frame);
});
