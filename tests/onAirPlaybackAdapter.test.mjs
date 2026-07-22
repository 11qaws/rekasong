import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ON_AIR_PLAYBACK_ADAPTER_CODES,
  ON_AIR_PLAYBACK_TEST_WATCHDOG_MS,
  ON_AIR_PLAYBACK_SAFETY_PROFILES,
  OnAirPlaybackAdapter,
} from '../src/lib/onAirPlaybackAdapter.js';
import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ROUTE_COMMAND_TYPES,
  ROUTE_EVENT_TYPES,
  RUN_COMMAND_TYPES,
  RUN_EVENT_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_COMMAND_TYPES,
  TEST_EVENT_TYPES,
  validateOnAirMessage,
} from '../src/lib/onAirProtocol.js';
import { ON_AIR_V2_CONNECTION_STATES } from '../src/lib/onAirV2Connection.js';
import { PLAYBACK_COMMAND_TYPES } from '../src/lib/playbackEngine.js';
import {
  ON_AIR_TEST_FIXTURE_ID,
} from '../src/lib/onAirTestFixture.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function routeCommand(type, overrides = {}) {
  return {
    type,
    commandId: `${type}-command`,
    switchId: `${type}-switch`,
    leaseEpoch: 1,
    targetPlayerInstanceId: 'player-1',
    controlEpoch: 1,
    ...(type === ROUTE_COMMAND_TYPES.ACTIVATE ? { payload: { outputMode: 'obs' } } : {}),
    ...overrides,
  };
}

function runCommand(type, overrides = {}) {
  const payload = type === RUN_COMMAND_TYPES.LOAD
    ? { song: { type: 'youtube', src: 'video-1' }, position: 0, volume: 72 }
    : type === RUN_COMMAND_TYPES.SEEK
      ? { position: 12 }
      : type === RUN_COMMAND_TYPES.VOLUME ? { volume: 55 } : {};
  return {
    type,
    commandId: `${type}-command`,
    entryId: 'entry-1',
    runId: 'run-1',
    leaseEpoch: 1,
    targetPlayerInstanceId: 'player-1',
    controlEpoch: 1,
    payload,
    ...overrides,
  };
}

function testCommand(type = TEST_COMMAND_TYPES.START, overrides = {}) {
  return {
    type,
    commandId: `${type}-command`,
    checkId: 'check-1',
    leaseEpoch: 1,
    targetPlayerInstanceId: 'player-1',
    controlEpoch: 1,
    ...(type === TEST_COMMAND_TYPES.START
      ? { payload: { fixtureId: ON_AIR_TEST_FIXTURE_ID, durationMs: 1_000 } }
      : {}),
    ...overrides,
  };
}

function createHarness({
  execute,
  emitEvent,
  runtimeProbe = () => ({}),
  sourceResolver = () => ({ kind: 'url', url: 'https://example.test/audio.mp3' }),
  prefetchSources = null,
  testFixtureFactory = () => ({ kind: 'blob', blob: new Blob(['fixture']) }),
  outputPathProbe = () => true,
  clientKind = 'obs-browser-source',
  safetyProfile,
  onSnapshot = null,
  onFrame = null,
  autoAcknowledgeTestMarkers = true,
  setTimeoutFn,
  clearTimeoutFn,
} = {}) {
  const events = [];
  const eventRecords = [];
  const abandonedEvents = [];
  const commands = [];
  let immediateHeartbeatCount = 0;
  let eventSequence = 0;
  let connectionCallbacks;
  let engineCallbacks;
  const engineState = {
    status: 'idle',
    sourceAttached: false,
    mediaPaused: true,
    runId: null,
    position: 0,
    duration: 30,
    readyState: 4,
    seeking: false,
    volume: 1,
  };
  const engine = {
    async execute(command) {
      commands.push(command);
      if (execute) return execute(command, { engineState, engineCallbacks, commands });
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        const source = await command.sourceFactory({
          signal: new AbortController().signal,
          generation: commands.length,
        });
        assert.ok(source);
        engineState.status = 'loading';
        engineState.sourceAttached = true;
        engineState.mediaPaused = true;
        engineState.runId = command.runId;
        return {
          status: 'applied',
          postcondition: { sourceAttached: true, autoplayStarted: false, mediaPaused: true },
        };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.PLAY) {
        engineState.status = 'playing';
        engineState.mediaPaused = false;
        return { status: 'applied', postcondition: { mediaPaused: false } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.PAUSE) {
        engineState.status = 'paused';
        engineState.mediaPaused = true;
        return { status: 'applied', postcondition: { mediaPaused: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.SEEK) {
        engineState.position = command.position;
        return { status: 'applied', postcondition: { position: engineState.position } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.VOLUME) {
        engineState.volume = command.volume / 100;
        return { status: 'applied', postcondition: { volume: engineState.volume } };
      }
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.STOP,
        PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP].includes(command.type)) {
        engineState.status = command.type === PLAYBACK_COMMAND_TYPES.DETACH ? 'detached' : 'stopped';
        engineState.sourceAttached = false;
        engineState.mediaPaused = true;
        engineState.runId = null;
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
    snapshot() {
      return { ...engineState };
    },
    dispose() {},
  };
  const connectionState = {
    state: ON_AIR_V2_CONNECTION_STATES.READY,
    leaseEpoch: 1,
    connectionId: 'connection-1',
  };
  const connection = {
    emitEvent(draft) {
      const wire = {
        ...draft,
        eventId: `event-${eventSequence}`,
        sequence: eventSequence,
        playerInstanceId: 'player-1',
        connectionId: 'connection-1',
      };
      eventSequence += 1;
      const validation = validateOnAirMessage(wire);
      assert.deepEqual(validation.errors, []);
      events.push(structuredClone(draft));
      const defaultResult = {
        status: 'created',
        entry: {
          eventId: wire.eventId,
          sequence: wire.sequence,
          state: 'pending',
          message: wire,
        },
        retryAllowed: true,
        coalescedEventId: null,
      };
      const override = emitEvent
        ? emitEvent(draft, events, defaultResult, { connectionCallbacks, connectionState })
        : null;
      const result = override ? { ...defaultResult, ...override } : defaultResult;
      const record = { draft: structuredClone(draft), result };
      eventRecords.push(record);
      if (autoAcknowledgeTestMarkers
        && draft.event === TEST_EVENT_TYPES.TEST_MARKER
        && ['created', 'retry'].includes(result.status)
        && result.entry?.eventId
        && result.coalescedEventId == null) {
        Promise.resolve().then(() => connectionCallbacks.onEventResult({
          status: 'acknowledged',
          ackStatus: 'relayed',
          entry: result.entry,
          retryAllowed: false,
        }));
      }
      return result;
    },
    snapshot() {
      return { ...connectionState };
    },
    connect() {
      return 1;
    },
    sendHeartbeatNow() {
      immediateHeartbeatCount += 1;
      return true;
    },
    close() {
      connectionState.state = ON_AIR_V2_CONNECTION_STATES.CLOSED;
    },
    abandonEvents(eventIds, options) {
      abandonedEvents.push({ eventIds: [...eventIds], options: { ...options } });
      return {
        status: eventIds.length > 0 ? 'abandoned' : 'unchanged',
        abandoned: eventIds.map((eventId) => ({ eventId, state: 'abandoned' })),
        alreadyTerminal: [],
        notFound: [],
      };
    },
  };

  const adapter = new OnAirPlaybackAdapter({
    connectionOptions: {
      url: 'wss://example.test/player',
      buildId: 'test-build',
      clientKind,
      webSocketFactory: () => ({}),
      onFrame,
    },
    engineOptions: { audio: {} },
    connectionFactory(options) {
      connectionCallbacks = options;
      return connection;
    },
    engineFactory(options) {
      engineCallbacks = options;
      return engine;
    },
    sourceResolver,
    prefetchSources,
    testFixtureFactory,
    outputPathProbe,
    runtimeProbe,
    now: (() => {
      let value = 10;
      return () => value++;
    })(),
    ...(setTimeoutFn ? { setTimeoutFn } : {}),
    ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
    ...(safetyProfile ? { safetyProfile } : {}),
    onSnapshot,
  });

  return {
    adapter,
    abandonedEvents,
    commands,
    connection,
    connectionCallbacks,
    connectionState,
    engine,
    engineCallbacks,
    engineState,
    eventRecords,
    events,
    get immediateHeartbeatCount() {
      return immediateHeartbeatCount;
    },
  };
}

test('PREFETCH is a best-effort hint and cannot mutate playback authority', async () => {
  const received = [];
  const harness = createHarness({
    prefetchSources(videoIds) {
      received.push([...videoIds]);
      return Promise.reject(new Error('fixture_prefetch_failure'));
    },
  });
  const before = harness.adapter.snapshot();

  harness.connectionCallbacks.onFrame({
    type: AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
    commandId: 'prefetch-command',
    controlEpoch: 1,
    payload: { videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'] },
  });
  await flushMicrotasks();

  assert.deepEqual(received, [['dQw4w9WgXcQ', '9bZkp7q19f0']]);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.events.length, 0);
  const after = harness.adapter.snapshot();
  assert.equal(after.routeState, before.routeState);
  assert.equal(after.confirmation, before.confirmation);
  assert.equal(after.safetyLocked, before.safetyLocked);
  assert.equal(after.lastError, before.lastError);
});

async function activate(harness, overrides = {}) {
  await harness.connectionCallbacks.onPlayerCommand(
    routeCommand(ROUTE_COMMAND_TYPES.ACTIVATE, overrides),
  );
}

async function flushMicrotasks(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  const history = new Map();
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId;
      nextId += 1;
      const task = { callback, delay };
      pending.set(id, task);
      history.set(id, task);
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    find(delay) {
      return [...pending].find(([, task]) => task.delay === delay)?.[0] ?? null;
    },
    fire(id) {
      const task = pending.get(id);
      if (!task) return false;
      pending.delete(id);
      task.callback();
      return true;
    },
    fireStale(id) {
      const task = history.get(id);
      if (!task) return false;
      task.callback();
      return true;
    },
    delays() {
      return [...pending.values()].map((task) => task.delay).sort((a, b) => a - b);
    },
  };
}

async function startTestThroughPlaying(harness, mediaTime = 0) {
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const testRunId = harness.commands.find(
    (command) => command.type === PLAYBACK_COMMAND_TYPES.LOAD,
  ).runId;
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: testRunId,
    mediaTime: 0,
    duration: 1,
  });
  await flushMicrotasks();
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: testRunId,
    mediaTime,
  });
  await flushMicrotasks();
  return testRunId;
}

function acknowledgeMarker(harness, record, ackStatus = 'relayed') {
  harness.connectionCallbacks.onEventResult({
    status: 'acknowledged',
    ackStatus,
    entry: record.result.entry,
    retryAllowed: false,
  });
}

test('output path proof is an explicit dependency, never an optimistic default', () => {
  assert.throws(
    () => new OnAirPlaybackAdapter({ connectionOptions: {}, engineOptions: {} }),
    (error) => error.code === ON_AIR_PLAYBACK_ADAPTER_CODES.INVALID_CONFIGURATION
      && error.detail.field === 'outputPathProbe',
  );
});

test('activation proves a detached, paused, non-audible output path before LOAD', async () => {
  const harness = createHarness({
    runtimeProbe: () => ({ sourceActive: true, sourceVisible: true }),
  });

  await activate(harness);

  assert.equal(harness.commands[0].type, PLAYBACK_COMMAND_TYPES.DETACH);
  assert.deepEqual(harness.events.at(-1), {
    type: ON_AIR_MESSAGE_TYPES.ROUTE_EVENT,
    protocolVersion: ON_AIR_PROTOCOL_VERSION,
    leaseEpoch: 1,
    monotonicTimeMs: 10,
    event: ROUTE_EVENT_TYPES.OUTPUT_READY,
    switchId: 'activate_output-switch',
    postcondition: {
      mediaPaused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      outputPathReady: true,
      audible: false,
    },
  });
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().confirmation, 'local_event_sent');

  const heartbeat = harness.connectionCallbacks.heartbeatPayload({ now: 20 });
  assert.deepEqual(heartbeat.runtime, { sourceActive: true, sourceVisible: true });
});

test('OBS heartbeat never derives sourceActive from media attachment or invents initial inactivity', async () => {
  const harness = createHarness();
  harness.engineState.sourceAttached = true;

  const heartbeat = harness.connectionCallbacks.heartbeatPayload({ now: 20 });

  assert.equal(Object.hasOwn(harness.connectionCallbacks.runtime, 'sourceActive'), false);
  assert.equal(Object.hasOwn(heartbeat, 'runtime'), false);
});

test('speaker heartbeat does not invent an OBS sourceActive attestation', () => {
  const harness = createHarness({ clientKind: 'dashboard-speaker' });

  const heartbeat = harness.connectionCallbacks.heartbeatPayload({ now: 20 });

  assert.equal(Object.hasOwn(harness.connectionCallbacks.runtime, 'sourceActive'), false);
  assert.equal(Object.hasOwn(heartbeat, 'runtime'), false);
});

test('a previously true runtime source attestation fails closed when the live probe loses it', () => {
  let probeCalls = 0;
  const harness = createHarness({
    runtimeProbe: () => {
      probeCalls += 1;
      return probeCalls === 1 ? { sourceActive: true } : {};
    },
  });

  const heartbeat = harness.connectionCallbacks.heartbeatPayload({ now: 20 });

  assert.equal(heartbeat.runtime.sourceActive, false);
});

test('OBS scene active and visibility changes never tear down an established media graph', async (t) => {
  for (const changedField of ['sourceActive', 'sourceVisible']) {
    await t.test(changedField, async () => {
      const runtime = { sourceActive: true, sourceVisible: true };
      const harness = createHarness({ runtimeProbe: () => ({ ...runtime }) });
      await activate(harness);
      await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
      await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PLAY, {
        commandId: `play-${changedField}`,
      }));
      harness.commands.length = 0;
      harness.events.length = 0;

      runtime[changedField] = false;
      const stopped = await harness.adapter.handleRuntimeAttestation(runtime, {
        phase: 'obs_callback',
      });
      await flushMicrotasks();

      assert.equal(stopped, false);
      assert.deepEqual(harness.commands, []);
      assert.equal(harness.engineState.status, 'playing');
      assert.equal(harness.engineState.mediaPaused, false);
      assert.equal(harness.engineState.sourceAttached, true);
      assert.equal(harness.events.length, 0);
      assert.equal(harness.immediateHeartbeatCount, 1);
      const snapshot = harness.adapter.snapshot();
      assert.equal(snapshot.routeState, 'ready_event_sent');
      assert.equal(snapshot.safetyLocked, false);
      assert.equal(snapshot.activeEntryId, 'entry-1');
      assert.equal(snapshot.activeRunId, 'run-1');
      assert.equal(snapshot.lastError, null);
    });
  }
});

test('scene telemetry cannot latch the route or block later transport commands', async () => {
  const runtime = { sourceActive: true, sourceVisible: true };
  const harness = createHarness({ runtimeProbe: () => ({ ...runtime }) });
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PLAY));
  harness.commands.length = 0;
  harness.events.length = 0;

  runtime.sourceActive = false;
  runtime.sourceVisible = false;
  assert.equal(await harness.adapter.handleRuntimeAttestation(runtime), false);
  await flushMicrotasks();
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PAUSE, {
    commandId: 'pause-while-scene-hidden',
  }));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.PAUSE,
  ]);
  assert.equal(harness.engineState.status, 'paused');
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.immediateHeartbeatCount, 1);
});

test('run frames cannot bypass local route readiness before activation', async () => {
  const harness = createHarness();

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));

  assert.equal(
    harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.LOAD),
    false,
  );
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(harness.events[0].code, 'playback_adapter_safety_locked');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
});

test('run commands emit receipt and applied events and resolve LOAD through one source resolver', async () => {
  const resolutions = [];
  const harness = createHarness({
    sourceResolver: (context) => {
      resolutions.push(context);
      return { kind: 'url', url: 'https://example.test/prepared.mp3' };
    },
  });
  await activate(harness);
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));

  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].entryId, 'entry-1');
  assert.equal(resolutions[0].runId, 'run-1');
  assert.equal(resolutions[0].song.src, 'video-1');
  assert.ok(resolutions[0].signal instanceof AbortSignal);
  assert.deepEqual(harness.events.map((event) => event.event), [
    RUN_EVENT_TYPES.COMMAND_RECEIVED,
    RUN_EVENT_TYPES.COMMAND_APPLIED,
  ]);
  assert.equal(harness.events[1].postcondition.status, 'loading');

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: 'run-1',
    mediaTime: 0,
    duration: 180,
    paused: true,
    readyState: 4,
    seeking: false,
  });
  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.READY);
  assert.equal(harness.events.at(-1).entryId, 'entry-1');
  assert.equal(harness.events.at(-1).duration, 180);
});

test('a successful STOP sends one exact physical proof before clearing the local run', async () => {
  const harness = createHarness();
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.STOP));

  assert.deepEqual(harness.events.map((event) => event.event), [
    RUN_EVENT_TYPES.COMMAND_RECEIVED,
    RUN_EVENT_TYPES.COMMAND_APPLIED,
  ]);
  assert.equal(harness.events.at(-1).commandType, 'STOP');
  assert.deepEqual(harness.events.at(-1).postcondition, {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  });
  assert.equal(harness.adapter.snapshot().activeEntryId, null);
  assert.equal(harness.adapter.snapshot().activeRunId, null);
});

test('SEEK and VOLUME applied events preserve the media element actual values', async () => {
  const harness = createHarness();
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.SEEK));
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.VOLUME));

  const applied = harness.events.filter((event) => (
    event.event === RUN_EVENT_TYPES.COMMAND_APPLIED
  ));
  assert.deepEqual(applied.map((event) => ({
    commandType: event.commandType,
    postcondition: event.postcondition,
  })), [
    {
      commandType: 'SEEK',
      postcondition: { status: 'loading', position: 12 },
    },
    {
      commandType: 'VOLUME',
      postcondition: { status: 'loading', volume: 55 },
    },
  ]);
});

test('PAUSE failure proves a fallback emergency stop and locks out further run commands', async () => {
  const harness = createHarness({
    async execute(command, { engineState }) {
      if (command.type === PLAYBACK_COMMAND_TYPES.DETACH) {
        engineState.status = 'detached';
        engineState.sourceAttached = false;
        engineState.mediaPaused = true;
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        await command.sourceFactory({
          signal: new AbortController().signal,
          generation: 1,
        });
        engineState.status = 'playing';
        engineState.sourceAttached = true;
        engineState.mediaPaused = false;
        engineState.runId = command.runId;
        return { status: 'applied', postcondition: { sourceAttached: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.PAUSE) {
        const error = new Error('pause postcondition failed');
        error.code = 'media_postcondition_failed';
        throw error;
      }
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP]
        .includes(command.type)) {
        engineState.status = 'stopped';
        engineState.sourceAttached = false;
        engineState.mediaPaused = true;
        engineState.runId = null;
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  harness.events.length = 0;
  harness.commands.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PAUSE));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.PAUSE,
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(harness.events.at(-1).code, 'media_postcondition_failed');
  assert.deepEqual(harness.events.at(-1).safetyPostcondition, {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  });
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(harness.adapter.snapshot().activeRunId, null);
  assert.equal(harness.connectionState.state, ON_AIR_V2_CONNECTION_STATES.READY);
});

test('STOP failure closes the route transport when fallback emergency detach is unproven', async () => {
  const harness = createHarness({
    async execute(command, { engineState }) {
      if (command.type === PLAYBACK_COMMAND_TYPES.DETACH) {
        engineState.status = 'detached';
        engineState.sourceAttached = false;
        engineState.mediaPaused = true;
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        engineState.status = 'playing';
        engineState.sourceAttached = true;
        engineState.mediaPaused = false;
        engineState.runId = command.runId;
        return { status: 'applied', postcondition: { sourceAttached: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.STOP) {
        const error = new Error('stop postcondition failed');
        error.code = 'media_postcondition_failed';
        throw error;
      }
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP]
        .includes(command.type)) {
        throw new Error('emergency detach failed');
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  harness.events.length = 0;
  harness.commands.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.STOP));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.STOP,
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(Object.hasOwn(harness.events.at(-1), 'safetyPostcondition'), false);
  assert.equal(
    harness.adapter.snapshot().lastError.code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
  );
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(harness.connectionState.state, ON_AIR_V2_CONNECTION_STATES.CLOSED);
});

test('LOAD without a resolver silences prior media, reports a stable failure, and clears local run identity', async () => {
  const harness = createHarness({ sourceResolver: null });
  await activate(harness);
  harness.commands.length = 0;
  harness.events.length = 0;
  harness.engineState.sourceAttached = true;
  harness.engineState.mediaPaused = false;
  harness.engineState.status = 'playing';

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));

  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(
    harness.events.at(-1).code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.SOURCE_RESOLVER_UNAVAILABLE,
  );
  assert.equal(
    harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP),
    true,
  );
  assert.equal(harness.adapter.snapshot().activeEntryId, null);
  assert.equal(harness.adapter.snapshot().activeRunId, null);
  assert.equal(harness.engineState.mediaPaused, true);
  assert.equal(harness.engineState.sourceAttached, false);
});

test('invalid dependency error codes are replaced before they reach the wire schema', async () => {
  const harness = createHarness({
    execute(command) {
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        const error = new Error('bad dependency error');
        error.code = ' invalid\ncode ';
        throw error;
      }
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP]
        .includes(command.type)) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));

  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(
    harness.events.at(-1).code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
  );
});

test('wire emergency stop preempts an unresolved normal command and suppresses its late applied event', async () => {
  const pendingLoad = deferred();
  const harness = createHarness({
    execute(command) {
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) return pendingLoad.promise;
      if (command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP
        || command.type === PLAYBACK_COMMAND_TYPES.DETACH) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;

  const loadPromise = harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  for (let attempt = 0; attempt < 4 && harness.events.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.events[0].event, RUN_EVENT_TYPES.COMMAND_RECEIVED);

  await harness.connectionCallbacks.onPlayerCommand({
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: 'emergency-1',
    sessionId: 'session-1',
    authenticatedControlInstanceId: 'control-1',
    targetConnectionId: 'connection-1',
  });
  assert.equal(harness.events.at(-1).type, ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK);

  pendingLoad.resolve({ status: 'applied', postcondition: { sourceAttached: true } });
  await loadPromise;

  assert.equal(
    harness.events.some((event) => event.event === RUN_EVENT_TYPES.COMMAND_APPLIED),
    false,
  );
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(harness.adapter.snapshot().autoResumeAllowed, false);
});

test('emergency aborts a hanging output-path probe so a later explicit activation is not deadlocked', async () => {
  const hangingProbe = deferred();
  let probeCalls = 0;
  const harness = createHarness({
    outputPathProbe({ signal }) {
      probeCalls += 1;
      assert.equal(signal instanceof AbortSignal, true);
      return probeCalls === 1 ? hangingProbe.promise : true;
    },
  });

  const firstActivation = harness.connectionCallbacks.onPlayerCommand(
    routeCommand(ROUTE_COMMAND_TYPES.ACTIVATE),
  );
  for (let attempt = 0; attempt < 6 && probeCalls === 0; attempt += 1) await Promise.resolve();
  assert.equal(probeCalls, 1);

  await harness.connectionCallbacks.onPlayerCommand({
    type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
    commandId: 'emergency-probe',
    sessionId: 'session-1',
    authenticatedControlInstanceId: 'control-1',
    targetConnectionId: 'connection-1',
  });
  await firstActivation;

  await harness.connectionCallbacks.onPlayerCommand(routeCommand(
    ROUTE_COMMAND_TYPES.ACTIVATE,
    {
      commandId: 'activate-after-emergency',
      switchId: 'switch-after-emergency',
      leaseEpoch: 2,
    },
  ));

  assert.equal(probeCalls, 2);
  assert.equal(harness.events.at(-1).event, ROUTE_EVENT_TYPES.OUTPUT_READY);
  assert.equal(harness.events.at(-1).switchId, 'switch-after-emergency');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
});

test('losing a READY connection keeps the local graph alive and waits for reconnect', async () => {
  const harness = createHarness();
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PLAY));
  harness.engineState.position = 12.5;
  harness.commands.length = 0;
  harness.events.length = 0;

  const pendingPlayback = harness.eventRecords.at(-1).result.entry;
  harness.connectionCallbacks.onEventResult({
    status: 'outcome_unknown',
    entry: pendingPlayback,
    retryAllowed: false,
  });
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.deepEqual(harness.commands, []);

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.READY,
    state: ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
    detail: { reason: 'socket_closed' },
  });
  await Promise.resolve();

  assert.deepEqual(harness.commands, []);
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.adapter.snapshot().connectionRecovering, true);
  assert.equal(harness.adapter.snapshot().autoResumeAllowed, false);

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.NEGOTIATING,
    state: ON_AIR_V2_CONNECTION_STATES.READY,
    detail: {},
  });
  const reasserted = harness.events.at(-1);
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.adapter.snapshot().connectionRecovering, false);
  assert.equal(reasserted.type, ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT);
  assert.equal(reasserted.event, RUN_EVENT_TYPES.PLAYING);
  assert.equal(reasserted.entryId, 'entry-1');
  assert.equal(reasserted.runId, 'run-1');
  assert.equal(reasserted.mediaTime, 12.5);
  assert.equal(reasserted.paused, false);
  assert.deepEqual(harness.commands, []);
});

test('reconnect proof ambiguity never stops the surviving playback graph', async () => {
  let failReconnectProof = false;
  const harness = createHarness({
    emitEvent(draft) {
      if (failReconnectProof && draft.event === RUN_EVENT_TYPES.PLAYING) {
        return { status: 'outcome_unknown' };
      }
      return { status: 'created' };
    },
  });
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PLAY));
  harness.commands.length = 0;

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.READY,
    state: ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
    detail: { reason: 'socket_closed' },
  });
  failReconnectProof = true;
  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.NEGOTIATING,
    state: ON_AIR_V2_CONNECTION_STATES.READY,
    detail: {},
  });
  await flushMicrotasks();

  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.adapter.snapshot().connectionRecovering, false);
  assert.equal(
    harness.adapter.snapshot().lastError.code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
  );
  assert.deepEqual(harness.commands, []);
});

test('speaker connection loss is recoverable and does not stop the local media graph', async () => {
  const harness = createHarness({
    clientKind: 'dashboard-speaker',
    safetyProfile: ON_AIR_PLAYBACK_SAFETY_PROFILES.SPEAKER,
  });
  await activate(harness, { payload: { outputMode: 'speaker' } });
  harness.commands.length = 0;

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.READY,
    state: ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
    detail: { reason: 'mobile_background' },
  });
  await Promise.resolve();

  assert.deepEqual(harness.commands, []);
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.adapter.snapshot().safetyProfile, ON_AIR_PLAYBACK_SAFETY_PROFILES.SPEAKER);
  assert.equal(harness.adapter.snapshot().lastError.code, 'playback_adapter_connection_reconnecting');

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.NEGOTIATING,
    state: ON_AIR_V2_CONNECTION_STATES.READY,
    detail: {},
  });
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(harness.adapter.snapshot().lastError, null);
});

test('session_ended is terminal: it emergency-stops local audio, clears test work, and forbids reconnect', async () => {
  const observedFrames = [];
  const harness = createHarness({
    onFrame: (frame) => observedFrames.push(frame),
  });
  await activate(harness);
  harness.commands.length = 0;
  harness.events.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  assert.notEqual(harness.adapter.snapshot().activeTest, null);
  harness.commands.length = 0;

  const ended = {
    type: SERVER_MESSAGE_TYPES.SESSION_ENDED,
    protocolVersion: 2,
    reasonCode: 'explicit_end_session',
    cleanupAt: 1_753_000_000_000,
  };
  harness.connectionCallbacks.onFrame(ended);
  await flushMicrotasks();

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  assert.equal(harness.adapter.snapshot().activeTest, null);
  assert.equal(harness.adapter.snapshot().activeRunId, null);
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.adapter.snapshot().confirmation, 'unknown');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(
    harness.adapter.snapshot().lastError.code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.SESSION_ENDED,
  );
  assert.equal(harness.connectionState.state, ON_AIR_V2_CONNECTION_STATES.CLOSED);
  assert.deepEqual(observedFrames, [ended], 'the application observer still receives lifecycle evidence');
  assert.throws(
    () => harness.adapter.connect(),
    (error) => error?.code === ON_AIR_PLAYBACK_ADAPTER_CODES.SESSION_ENDED,
  );
});

test('deactivation failure reports bounded actual safety booleans without claiming success', async () => {
  let detachCount = 0;
  const harness = createHarness({
    execute(command) {
      if (command.type !== PLAYBACK_COMMAND_TYPES.DETACH) {
        return { status: 'applied', postcondition: {} };
      }
      detachCount += 1;
      if (detachCount === 1) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      const error = new Error('physical detach failed');
      error.code = 'detach_postcondition_failed';
      error.detail = {
        mediaPaused: false,
        sourceDetached: false,
        autoplayCancelled: true,
        internalPath: 'must_not_leak_as_postcondition',
      };
      throw error;
    },
  });
  await activate(harness);
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(
    routeCommand(ROUTE_COMMAND_TYPES.DEACTIVATE),
  );

  const failure = harness.events.at(-1);
  assert.equal(failure.event, ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED);
  assert.equal(failure.code, 'detach_postcondition_failed');
  assert.deepEqual(failure.postcondition, {
    mediaPaused: false,
    sourceDetached: false,
    autoplayCancelled: true,
  });
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
});

test('same-graph test waits for READY and PLAYING, then emits stable media-time markers', async () => {
  const fixtureCalls = [];
  const harness = createHarness({
    testFixtureFactory(context) {
      fixtureCalls.push(context);
      return { kind: 'blob', blob: new Blob(['deterministic-fixture']) };
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
  ]);
  assert.equal(fixtureCalls.length, 1);
  assert.equal(fixtureCalls[0].fixtureId, ON_AIR_TEST_FIXTURE_ID);
  assert.equal(fixtureCalls[0].durationMs, 1_000);
  assert.ok(fixtureCalls[0].signal instanceof AbortSignal);
  assert.equal(harness.events.length, 0);

  const testRunId = harness.commands[0].runId;
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: testRunId,
    mediaTime: 0,
    duration: 1,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.PLAY,
  ]);
  assert.equal(harness.events.length, 0);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: testRunId,
    mediaTime: 0,
  });
  assert.equal(harness.events[0].event, TEST_EVENT_TYPES.TEST_STARTED);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.26,
  });
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.1,
  });
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.6,
  });

  const markers = harness.events.filter((event) => event.event === TEST_EVENT_TYPES.TEST_MARKER);
  assert.deepEqual(markers.map((event) => ({
    markerIndex: event.markerIndex,
    markerTimeMs: event.markerTimeMs,
  })), [
    { markerIndex: 0, markerTimeMs: 50 },
    { markerIndex: 1, markerTimeMs: 200 },
    { markerIndex: 2, markerTimeMs: 350 },
    { markerIndex: 3, markerTimeMs: 500 },
  ]);
  assert.equal(markers.some((event) => (
    Object.hasOwn(event, 'rmsDbfs') || Object.hasOwn(event, 'peakDbfs')
  )), false);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();

  const complete = harness.events.at(-1);
  assert.equal(complete.event, TEST_EVENT_TYPES.TEST_COMPLETE);
  assert.equal(complete.markerCount, 4);
  assert.deepEqual(complete.postcondition, { stopped: true });
  assert.equal(harness.commands.at(-1).type, PLAYBACK_COMMAND_TYPES.STOP);
  assert.equal(harness.adapter.snapshot().activeTest, null);
});

test('natural completion waits for every exact relayed marker ACK after the strong STOP', async () => {
  const harness = createHarness({ autoAcknowledgeTestMarkers: false });
  await activate(harness);
  harness.events.length = 0;
  harness.eventRecords.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.6,
  });
  const markerRecords = harness.eventRecords.filter(
    (record) => record.draft.event === TEST_EVENT_TYPES.TEST_MARKER,
  );
  assert.equal(markerRecords.length, 4);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();

  assert.equal(harness.commands.at(-1).type, PLAYBACK_COMMAND_TYPES.STOP);
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  assert.equal(harness.adapter.snapshot().activeTest.phase, 'awaiting_marker_acks');
  assert.equal(harness.adapter.snapshot().activeTest.acknowledgedMarkerCount, 0);

  for (const record of markerRecords.slice(0, -1)) acknowledgeMarker(harness, record);
  await flushMicrotasks();
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  acknowledgeMarker(harness, markerRecords.at(-1));
  await flushMicrotasks();

  const complete = harness.events.at(-1);
  assert.equal(complete.event, TEST_EVENT_TYPES.TEST_COMPLETE);
  assert.equal(complete.markerCount, 4);
  assert.equal(harness.adapter.snapshot().activeTest, null);
  assert.equal(harness.adapter.snapshot().lastTestOutcome.status, 'local_media_completed');
  assert.equal(harness.adapter.snapshot().lastTestOutcome.acknowledgedMarkerCount, 4);
});

test('a synchronous relayed marker ACK is retained until its exact event ID is registered', async () => {
  let synchronousAckCount = 0;
  const harness = createHarness({
    autoAcknowledgeTestMarkers: false,
    emitEvent(draft, _events, defaultResult, { connectionCallbacks }) {
      if (draft.event === TEST_EVENT_TYPES.TEST_MARKER) {
        synchronousAckCount += 1;
        connectionCallbacks.onEventResult({
          status: 'acknowledged',
          ackStatus: 'relayed',
          entry: defaultResult.entry,
          retryAllowed: false,
        });
      }
      return null;
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.6,
  });
  assert.equal(synchronousAckCount, 4);
  assert.equal(harness.adapter.snapshot().activeTest.acknowledgedMarkerCount, 4);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();
  assert.equal(harness.events.at(-1).event, TEST_EVENT_TYPES.TEST_COMPLETE);
  assert.equal(harness.events.at(-1).markerCount, 4);
});

test('a synchronous disconnect during terminal send cannot be overwritten as local success', async () => {
  const harness = createHarness({
    emitEvent(draft, _events, _defaultResult, { connectionCallbacks, connectionState }) {
      if (draft.event === TEST_EVENT_TYPES.TEST_COMPLETE) {
        const previous = connectionState.state;
        connectionState.state = ON_AIR_V2_CONNECTION_STATES.DISCONNECTED;
        connectionCallbacks.onStateChange({
          previous,
          state: connectionState.state,
          detail: { reason: 'terminal_send_failed' },
        });
      }
      return null;
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness);
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.6,
  });
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();

  const state = harness.adapter.snapshot();
  assert.equal(state.routeState, 'unknown');
  assert.equal(state.confirmation, 'unknown');
  assert.equal(state.safetyLocked, true);
  assert.notEqual(state.lastTestOutcome?.outcome, 'local_media_completed');
});

test('explicit STOP during the marker barrier cancels and can never become verification success', async () => {
  const harness = createHarness({ autoAcknowledgeTestMarkers: false });
  await activate(harness);
  harness.events.length = 0;
  harness.eventRecords.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness, 0.6);
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();
  assert.equal(harness.adapter.snapshot().activeTest.phase, 'awaiting_marker_acks');

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP, {
    commandId: 'barrier-stop-command',
  }));
  await flushMicrotasks();

  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  assert.equal(harness.abandonedEvents.length, 1);
  assert.equal(harness.abandonedEvents[0].eventIds.length, 4);
  assert.deepEqual(harness.abandonedEvents[0].options, { code: 'test_terminalized' });
  const terminal = harness.events.at(-1);
  assert.equal(terminal.event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(terminal.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED);
  assert.equal(terminal.commandId, 'barrier-stop-command');
  assert.equal(terminal.detail.reason, 'explicit_stop');
  assert.equal(harness.adapter.snapshot().lastTestOutcome.status, 'cancelled');
});

test('an applied ACK cannot satisfy the Worker relayed marker contract', async () => {
  const harness = createHarness({ autoAcknowledgeTestMarkers: false });
  await activate(harness);
  harness.events.length = 0;
  harness.eventRecords.length = 0;
  harness.commands.length = 0;
  await startTestThroughPlaying(harness, 0.1);
  const markerRecord = harness.eventRecords.find(
    (record) => record.draft.event === TEST_EVENT_TYPES.TEST_MARKER,
  );

  acknowledgeMarker(harness, markerRecord, 'applied');
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED);
  assert.equal(failure.detail.failure.detail.phase, 'marker_ack');
  assert.equal(failure.detail.safetyStopped, true);
  assert.equal(harness.adapter.snapshot().activeTest, null);
});

for (const scenario of [
  { name: 'outcome-unknown', result: { status: 'outcome_unknown' } },
  { name: 'coalesced', result: { status: 'created', coalescedEventId: 'prior-marker' } },
  { name: 'missing-event-id', result: { status: 'created', entry: null } },
]) {
  test(`a ${scenario.name} marker enqueue fails closed with a stable test result`, async () => {
    const harness = createHarness({
      emitEvent(draft) {
        return draft.event === TEST_EVENT_TYPES.TEST_MARKER ? scenario.result : null;
      },
    });
    await activate(harness);
    harness.events.length = 0;
    harness.commands.length = 0;
    await startTestThroughPlaying(harness, 0.1);
    await flushMicrotasks();

    const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
    assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED);
    assert.equal(failure.detail.safetyStopped, true);
    assert.equal(
      harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP),
      true,
    );
    assert.equal(harness.adapter.snapshot().activeTest, null);
  });
}

test('the marker ACK barrier times out after two seconds and emergency-detaches', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    autoAcknowledgeTestMarkers: false,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness, 0.6);
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 1,
  });
  await flushMicrotasks();

  const ackTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.markerAck);
  assert.notEqual(ackTimer, null);
  timers.fire(ackTimer);
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED);
  assert.equal(failure.detail.failure.detail.phase, 'marker_ack_timeout');
  assert.equal(failure.detail.safetyStopped, true);
  assert.equal(harness.adapter.snapshot().activeTest, null);
});

test('an early fixture ENDED event cannot become a successful test completion', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const testRunId = harness.commands[0].runId;

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: testRunId,
    mediaTime: 0,
    duration: 1,
  });
  await Promise.resolve();
  await Promise.resolve();
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: testRunId,
    mediaTime: 0,
  });
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 0.4,
    duration: 1,
  });
  await flushMicrotasks();

  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_INCOMPLETE);
  assert.equal(failure.detail.safetyStopped, true);
  assert.equal(
    harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP),
    true,
  );
});

test('fixture ENDED duration disagreement cannot pass the completion gate', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.ENDED,
    runId: testRunId,
    mediaTime: 1,
    duration: 0.8,
  });
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_INCOMPLETE);
  assert.equal(failure.detail.failure.detail.durationMs, 800);
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
});

test('a dropped test marker is a safety failure and never counts toward test completion', async () => {
  const harness = createHarness({
    emitEvent(draft) {
      return draft.event === TEST_EVENT_TYPES.TEST_MARKER
        ? { status: 'dropped' }
        : { status: 'created' };
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const testRunId = harness.commands[0].runId;

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: testRunId,
    mediaTime: 0,
    duration: 1,
  });
  await flushMicrotasks();
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: testRunId,
    mediaTime: 0.1,
  });
  await flushMicrotasks();

  assert.equal(harness.adapter.snapshot().activeTest, null);
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  assert.equal(
    harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP),
    true,
  );
  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED);
  assert.equal(failure.detail.safetyStopped, true);
});

test('READY watchdog fails closed after five seconds without READY evidence', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  const timer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.ready);
  assert.notEqual(timer, null);
  timers.fire(timer);
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT);
  assert.equal(failure.detail.failure.detail.phase, 'ready');
  assert.equal(failure.detail.safetyStopped, true);
});

test('PLAYING watchdog fails closed after READY when PLAYING evidence never arrives', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const testRunId = harness.commands[0].runId;
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.READY,
    runId: testRunId,
    mediaTime: 0,
    duration: 1,
  });
  await flushMicrotasks();

  const timer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.playing);
  assert.notEqual(timer, null);
  timers.fire(timer);
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT);
  assert.equal(failure.detail.failure.detail.phase, 'playing');
});

test('progress watchdog rearms only on advancing media time and fences stale callbacks', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  const testRunId = await startTestThroughPlaying(harness);
  const firstProgressTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.progress);
  assert.notEqual(firstProgressTimer, null);

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.POSITION,
    runId: testRunId,
    mediaTime: 0.2,
  });
  const replacementProgressTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.progress);
  assert.notEqual(replacementProgressTimer, firstProgressTimer);
  timers.fireStale(firstProgressTimer);
  await flushMicrotasks();
  assert.equal(harness.adapter.snapshot().activeTest.phase, 'started');

  timers.fire(replacementProgressTimer);
  await flushMicrotasks();
  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT);
  assert.equal(failure.detail.failure.detail.phase, 'progress');
});

test('hard-end watchdog bounds the fixture to duration plus two seconds', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await startTestThroughPlaying(harness);

  const timer = timers.find(1_000 + ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.completionGrace);
  assert.notEqual(timer, null);
  timers.fire(timer);
  await flushMicrotasks();

  const failure = harness.events.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT);
  assert.equal(failure.detail.failure.detail.phase, 'hard_end');
});

test('wrong-check STOP is ignored locally and cannot stop the active fixture', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  const stopped = await harness.connectionCallbacks.onPlayerCommand(
    testCommand(TEST_COMMAND_TYPES.STOP, {
      commandId: 'wrong-stop-command',
      checkId: 'wrong-check',
    }),
  );

  assert.equal(stopped, false);
  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
  ]);
  assert.equal(harness.adapter.snapshot().activeTest.checkId, 'check-1');
  assert.equal(
    harness.adapter.snapshot().lastError.code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_IDENTITY_MISMATCH,
  );
  assert.equal(harness.adapter.snapshot().lastError.detail.actualCheckId, 'wrong-check');
  assert.equal(harness.events.length, 0);

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP));
});

test('immediate START then exact STOP is serialized and terminates as cancellation', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;

  const start = harness.connectionCallbacks.onPlayerCommand(testCommand());
  const stop = harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP, {
    commandId: 'immediate-stop-command',
  }));
  await Promise.all([start, stop]);
  await flushMicrotasks();

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.STOP,
  ]);
  const terminal = harness.events.at(-1);
  assert.equal(terminal.event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(terminal.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED);
  assert.equal(terminal.commandId, 'immediate-stop-command');
  assert.equal(harness.adapter.snapshot().activeTest, null);
});

test('cleared watchdog callback remains inert after an exact explicit STOP', async () => {
  const timers = createManualTimers();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const readyTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.ready);
  assert.notEqual(readyTimer, null);

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP));
  const terminalCount = harness.events.filter(
    (event) => [TEST_EVENT_TYPES.TEST_COMPLETE, TEST_EVENT_TYPES.TEST_FAILED].includes(event.event),
  ).length;
  timers.fireStale(readyTimer);
  await flushMicrotasks();

  assert.equal(harness.events.filter(
    (event) => [TEST_EVENT_TYPES.TEST_COMPLETE, TEST_EVENT_TYPES.TEST_FAILED].includes(event.event),
  ).length, terminalCount);
  assert.equal(harness.adapter.snapshot().lastTestOutcome.status, 'cancelled');
  assert.deepEqual(timers.delays(), []);
});

test('explicit test STOP proves physical stop without inventing a started event', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP, {
    commandId: 'stop-test-command',
  }));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.STOP,
  ]);
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_STARTED),
    false,
  );
  assert.equal(harness.events.at(-1).event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(harness.events.at(-1).code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED);
  assert.deepEqual(harness.events.at(-1).safetyPostcondition, {
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  });
  assert.equal(harness.events.at(-1).commandId, 'stop-test-command');
  assert.equal(harness.events.at(-1).checkId, 'check-1');
  assert.deepEqual(harness.events.at(-1).detail, {
    reason: 'explicit_stop',
    safetyStopped: true,
    queuedMarkerCount: 0,
    acknowledgedMarkerCount: 0,
  });
  assert.equal(harness.adapter.snapshot().lastTestOutcome.status, 'cancelled');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
});

test('test_complete is withheld when STOP proof fails and fallback emergency stop reports test_failed', async () => {
  const harness = createHarness({
    async execute(command, { engineState }) {
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        await command.sourceFactory({
          signal: new AbortController().signal,
          generation: 1,
        });
        engineState.runId = command.runId;
        engineState.sourceAttached = true;
        return { status: 'applied', postcondition: { sourceAttached: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.STOP) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: false,
            sourceDetached: false,
            autoplayCancelled: true,
          },
        };
      }
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP]
        .includes(command.type)) {
        engineState.runId = null;
        engineState.sourceAttached = false;
        engineState.mediaPaused = true;
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.STOP,
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  assert.equal(
    harness.events.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE),
    false,
  );
  assert.equal(harness.events.at(-1).event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(
    harness.events.at(-1).code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_POSTCONDITION_FAILED,
  );
  assert.equal(harness.events.at(-1).detail.safetyStopped, true);
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
});

test('a hanging test STOP times out and falls back to a proven emergency detach', async () => {
  const timers = createManualTimers();
  const hangingStop = deferred();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    async execute(command, { engineState }) {
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        await command.sourceFactory({ signal: new AbortController().signal, generation: 1 });
        engineState.runId = command.runId;
        return { status: 'applied', postcondition: { sourceAttached: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.STOP) return hangingStop.promise;
      if ([PLAYBACK_COMMAND_TYPES.DETACH, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP]
        .includes(command.type)) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  const stopping = harness.connectionCallbacks.onPlayerCommand(
    testCommand(TEST_COMMAND_TYPES.STOP),
  );
  await flushMicrotasks();
  assert.equal(harness.commands.at(-1)?.type, PLAYBACK_COMMAND_TYPES.STOP);
  assert.ok(timers.delays().includes(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.stop));
  const stopTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.stop);
  assert.notEqual(stopTimer, null);
  timers.fire(stopTimer);
  await stopping;

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.STOP,
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  const failure = harness.events.at(-1);
  assert.equal(failure.event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT);
  assert.equal(failure.detail.safetyStopped, true);
  assert.equal(failure.safetyPostcondition.sourceDetached, true);
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
});

test('a hanging emergency fallback is bounded, unknown, and cannot report a safe terminal', async () => {
  const timers = createManualTimers();
  const hangingEmergency = deferred();
  const harness = createHarness({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    async execute(command) {
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        await command.sourceFactory({ signal: new AbortController().signal, generation: 1 });
        return { status: 'applied', postcondition: { sourceAttached: true } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.STOP) {
        return { status: 'applied', postcondition: { sourceDetached: false } };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.DETACH) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP) return hangingEmergency.promise;
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  const stopping = harness.connectionCallbacks.onPlayerCommand(
    testCommand(TEST_COMMAND_TYPES.STOP),
  );
  await flushMicrotasks();
  assert.equal(harness.commands.at(-1)?.type, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP);
  assert.ok(timers.delays().includes(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.emergencyStop));
  const emergencyTimer = timers.find(ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.emergencyStop);
  assert.notEqual(emergencyTimer, null);
  timers.fire(emergencyTimer);
  await stopping;

  const failure = harness.events.at(-1);
  assert.equal(failure.event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(failure.code, ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED);
  assert.equal(failure.detail.safetyStopped, false);
  assert.equal(Object.hasOwn(failure, 'safetyPostcondition'), false);
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(harness.connectionState.state, ON_AIR_V2_CONNECTION_STATES.CLOSED);
});

test('a direct sub-second fixture command fails with a stable code and verified emergency detach', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.START, {
    payload: { fixtureId: ON_AIR_TEST_FIXTURE_ID, durationMs: 999 },
  }));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
  ]);
  assert.equal(harness.events.at(-1).event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(
    harness.events.at(-1).code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_INVALID_CONFIGURATION,
  );
  assert.equal(harness.events.at(-1).detail.safetyStopped, true);
  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
});

test('unproven emergency detach after fixture failure locks safety and closes the route transport', async () => {
  const fixtureError = new Error('fixture failed');
  fixtureError.code = 'test_fixture_broken';
  const harness = createHarness({
    testFixtureFactory() {
      throw fixtureError;
    },
    async execute(command, { engineState }) {
      if (command.type === PLAYBACK_COMMAND_TYPES.DETACH) {
        return {
          status: 'applied',
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
          },
        };
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
        await command.sourceFactory({
          signal: new AbortController().signal,
          generation: 1,
        });
      }
      if (command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP) {
        engineState.mediaPaused = false;
        throw new Error('emergency detach failed');
      }
      return { status: 'applied', postcondition: {} };
    },
  });
  await activate(harness);
  harness.events.length = 0;

  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  assert.equal(harness.events.at(-1).event, TEST_EVENT_TYPES.TEST_FAILED);
  assert.equal(
    harness.events.at(-1).code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
  );
  assert.equal(harness.events.at(-1).detail.commandCode, 'test_fixture_broken');
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.adapter.snapshot().safetyLocked, true);
  assert.equal(harness.connectionState.state, ON_AIR_V2_CONNECTION_STATES.CLOSED);
});

test('run command cannot overlap an active output test', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
  ]);
  assert.equal(harness.events.at(-1).event, RUN_EVENT_TYPES.COMMAND_FAILED);
  assert.equal(harness.events.at(-1).code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CONFLICT);
  assert.equal(harness.adapter.snapshot().activeTest.checkId, 'check-1');

  await harness.connectionCallbacks.onPlayerCommand(testCommand(TEST_COMMAND_TYPES.STOP));
});

test('route deactivation completes and clears an active test before detaching the route', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());

  await harness.connectionCallbacks.onPlayerCommand(
    routeCommand(ROUTE_COMMAND_TYPES.DEACTIVATE),
  );

  assert.deepEqual(harness.commands.map((command) => command.type), [
    PLAYBACK_COMMAND_TYPES.LOAD,
    PLAYBACK_COMMAND_TYPES.STOP,
    PLAYBACK_COMMAND_TYPES.DETACH,
  ]);
  assert.deepEqual(harness.events.map((event) => event.event), [
    TEST_EVENT_TYPES.TEST_FAILED,
    ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED,
  ]);
  assert.equal(harness.events[0].code, ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED);
  assert.equal(harness.events[0].detail.reason, 'route_command');
  assert.equal(harness.adapter.snapshot().activeTest, null);
  assert.equal(harness.adapter.snapshot().routeState, 'standby_event_sent');
});

test('connection loss clears test state and suppresses late test evidence', async () => {
  const harness = createHarness();
  await activate(harness);
  harness.events.length = 0;
  harness.commands.length = 0;
  await harness.connectionCallbacks.onPlayerCommand(testCommand());
  const testRunId = harness.commands[0].runId;

  harness.connectionCallbacks.onStateChange({
    previous: ON_AIR_V2_CONNECTION_STATES.READY,
    state: ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
    detail: { reason: 'socket_closed' },
  });
  await Promise.resolve();
  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: testRunId,
    mediaTime: 0.5,
  });

  assert.equal(harness.adapter.snapshot().activeTest, null);
  assert.equal(harness.adapter.snapshot().routeState, 'unknown');
  assert.equal(harness.events.length, 0);
  assert.equal(harness.commands.at(-1).type, PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP);
});

test('ordinary playback evidence ambiguity preserves an established media graph', async () => {
  let failNext = false;
  const harness = createHarness({
    emitEvent() {
      if (failNext) return { status: 'outcome_unknown' };
      return { status: 'created' };
    },
  });
  await activate(harness);
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.LOAD));
  await harness.connectionCallbacks.onPlayerCommand(runCommand(RUN_COMMAND_TYPES.PLAY));
  harness.commands.length = 0;
  failNext = true;

  harness.engineCallbacks.onEvidence({
    type: RUN_EVENT_TYPES.PLAYING,
    runId: 'run-1',
    mediaTime: 8,
    paused: false,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.adapter.snapshot().routeState, 'ready_event_sent');
  assert.equal(harness.adapter.snapshot().confirmation, 'local_event_sent');
  assert.equal(harness.adapter.snapshot().safetyLocked, false);
  assert.equal(
    harness.adapter.snapshot().lastError.code,
    ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
  );
  assert.equal(
    harness.commands.some((command) => command.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP),
    false,
  );
});
