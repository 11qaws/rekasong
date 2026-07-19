import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_AIR_OUTPUT_CONTROL_CODES,
  ON_AIR_OUTPUT_SWITCH_STATUSES,
  ON_AIR_PLAYBACK_TRANSITION_REASONS,
  ON_AIR_PLAYBACK_TRANSITION_STATUSES,
  buildOnAirControlSocketUrl,
  createOnAirOutputController,
  createOnAirOutputControllerRegistry,
} from '../src/hooks/useOnAirOutputControl.js';

function playerSnapshot(overrides = {}) {
  const base = {
    type: 'player_snapshot',
    protocolVersion: 2,
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

function coordinatorSnapshot(protocol = playerSnapshot(), overrides = {}) {
  return {
    state: 'ready',
    disposed: false,
    ready: true,
    writable: true,
    unknown: false,
    authorityUnknown: false,
    routeUnknown: false,
    unknownLock: null,
    welcome: { writable: true },
    playerSnapshot: protocol,
    desiredTransport: protocol.desiredTransport,
    confirmedPlayback: protocol.confirmedPlayback,
    activeRun: null,
    pendingSwitch: null,
    pendingTest: null,
    pendingCommandIds: [],
    diagnostics: [],
    ...overrides,
  };
}

function readyRoute(mode = 'speaker', overrides = {}) {
  const speaker = mode === 'speaker';
  return playerSnapshot({
    selectedOutputMode: mode,
    lease: {
      epoch: 4,
      leaseTarget: speaker ? 'speaker-player' : 'obs-player',
      clientKind: speaker ? 'dashboard-speaker' : 'obs-browser-source',
      status: 'ready',
      switchId: `${mode}-switch`,
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_ready_no_playback' },
    ...overrides,
  });
}

function loadedReadySnapshot(entryId = 'entry-b', runId = 'run-b', overrides = {}) {
  const protocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId, runId },
    desiredTransport: {
      status: 'loading',
      song: { id: 'song-b' },
      entryId,
      runId,
    },
    confirmedPlayback: {
      status: 'ready',
      entryId,
      runId,
      playerInstanceId: 'speaker-player',
      leaseEpoch: 4,
      paused: true,
    },
    ...(overrides.protocol ?? {}),
  });
  return coordinatorSnapshot(protocol, {
    activeRun: {
      entryId,
      runId,
      targetPlayerInstanceId: 'speaker-player',
      leaseEpoch: 4,
      acknowledged: true,
      observed: true,
    },
    ...(overrides.coordinator ?? {}),
  });
}

function loadedPlayingSnapshot(entryId = 'entry-b', runId = 'run-b') {
  return loadedReadySnapshot(entryId, runId, {
    protocol: {
      desiredTransport: {
        status: 'playing',
        song: { id: 'song-b' },
        entryId,
        runId,
      },
      confirmedPlayback: {
        status: 'playing',
        entryId,
        runId,
        playerInstanceId: 'speaker-player',
        leaseEpoch: 4,
        paused: false,
        audible: true,
      },
    },
  });
}

class FakeCoordinator {
  constructor(initialSnapshot) {
    this.current = structuredClone(initialSnapshot);
    this.subscribers = new Set();
    this.calls = [];
    this.connectCalls = 0;
    this.disposed = false;
    this.loadCalls = 0;
    this.nextLoadError = null;
    this.nextPlayError = null;
  }

  connect() {
    this.connectCalls += 1;
    return this.connectCalls;
  }

  dispose() {
    this.disposed = true;
    this.calls.push(['dispose']);
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => this.subscribers.delete(listener);
  }

  snapshot() {
    return structuredClone(this.current);
  }

  emit(nextSnapshot) {
    this.current = structuredClone(nextSnapshot);
    for (const listener of this.subscribers) listener(this.snapshot());
  }

  activateOutput(mode) {
    this.calls.push(['activateOutput', mode]);
    return { status: 'created', operation: 'activate', mode };
  }

  deactivateOutput() {
    this.calls.push(['deactivateOutput']);
    return { status: 'created', operation: 'deactivate' };
  }

  load(value) {
    this.loadCalls += 1;
    this.calls.push(['load', value]);
    if (this.nextLoadError) {
      const error = this.nextLoadError;
      this.nextLoadError = null;
      throw error;
    }
    return {
      status: 'created',
      entry: { commandId: `load-command-${this.loadCalls}` },
    };
  }
  play() {
    this.calls.push(['play']);
    if (this.nextPlayError) {
      const error = this.nextPlayError;
      this.nextPlayError = null;
      throw error;
    }
    return 'play';
  }
  pause() { this.calls.push(['pause']); return 'pause'; }
  seek(value) { this.calls.push(['seek', value]); return value; }
  setVolume(value) { this.calls.push(['setVolume', value]); return value; }
  stop() { this.calls.push(['stop']); return 'stop'; }
  prefetch(value) { this.calls.push(['prefetch', value]); return value; }
  publishDisplayState(value) { this.calls.push(['publishDisplayState', value]); return value; }
  endSession() { this.calls.push(['endSession']); return 'end'; }
}

function createHarness(initialSnapshot = coordinatorSnapshot(), overrides = {}) {
  const coordinators = [];
  const transportOptions = [];
  const controller = createOnAirOutputController({
    session: { room: 'room / one', controlToken: 'control token' },
    baseUrl: 'https://worker.example/base/',
    buildId: 'test-build',
    webSocketFactory: () => ({}),
    coordinatorFactory(options) {
      transportOptions.push(options);
      const coordinator = new FakeCoordinator(overrides.snapshotFactory?.() ?? initialSnapshot);
      coordinators.push(coordinator);
      return coordinator;
    },
  });
  controller.connect();
  return { controller, coordinators, transportOptions };
}

function assertControlError(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('builds an encoded Protocol v2 control WebSocket URL', () => {
  const raw = buildOnAirControlSocketUrl(
    'https://worker.example/base/',
    { room: 'room / one', controlToken: 'token + value' },
  );
  const url = new URL(raw);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/v1/sessions/room%20%2F%20one/ws');
  assert.equal(url.searchParams.get('role'), 'control');
  assert.equal(url.searchParams.get('token'), 'token + value');
  assert.equal(url.searchParams.get('protocol'), '2');
});

test('owns one coordinator and connect is idempotent until explicit retry', () => {
  const { controller, coordinators, transportOptions } = createHarness();
  controller.connect();
  assert.equal(coordinators.length, 1);
  assert.equal(coordinators[0].connectCalls, 1);
  assert.equal(transportOptions[0].transport.sessionId, 'room / one');
  assert.match(transportOptions[0].transport.url, /protocol=2/);
});

test('registry preserves one session owner across StrictMode cleanup/setup', () => {
  const scheduled = [];
  const created = [];
  const registry = createOnAirOutputControllerRegistry({
    scheduleDisposal: (callback) => scheduled.push(callback),
    controllerFactory() {
      const controller = new FakeCoordinator(coordinatorSnapshot());
      created.push(controller);
      return controller;
    },
  });
  const options = {
    session: { room: 'strict-room', controlToken: 'strict-token' },
    baseUrl: 'https://worker.example',
  };

  const first = registry.acquire(options, () => {});
  first.release();
  const second = registry.acquire(options, () => {});
  scheduled.shift()();

  assert.equal(created.length, 1);
  assert.equal(created[0].connectCalls, 1);
  assert.equal(created[0].disposed, false);

  second.release();
  while (scheduled.length) scheduled.shift()();
  assert.equal(created[0].disposed, true);
});

test('registry retires changed credentials before creating a new owner for the same room', () => {
  const created = [];
  const registry = createOnAirOutputControllerRegistry({
    scheduleDisposal: () => {},
    controllerFactory() {
      const controller = new FakeCoordinator(coordinatorSnapshot());
      created.push(controller);
      return controller;
    },
  });
  registry.acquire({
    session: { room: 'same-room', controlToken: 'old-token' },
    baseUrl: 'https://worker.example',
  }, () => {});
  registry.acquire({
    session: { room: 'same-room', controlToken: 'new-token' },
    baseUrl: 'https://worker.example',
  }, () => {});

  assert.equal(created.length, 2);
  assert.equal(created[0].disposed, true);
  assert.equal(created[1].disposed, false);
});

test('activates when requested mode is unchanged but no route is actually active', () => {
  const protocol = playerSnapshot({ selectedOutputMode: 'speaker' });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(protocol));

  controller.selectOutputMode('speaker');

  assert.deepEqual(coordinators[0].calls, [['activateOutput', 'speaker']]);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
  assert.equal(controller.getState().outputSwitchState.targetMode, 'speaker');
  assert.equal(controller.getState().outputView.targets.speaker.operation, 'activate');
});

test('authoritative deactivation keeps the same requested mode explicitly reactivatable', () => {
  const protocol = playerSnapshot({
    selectedOutputMode: 'speaker',
    desiredTransport: { status: 'stopped' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_inactive' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(protocol));

  const view = controller.getState().outputView;
  assert.equal(view.targets.speaker.operation, 'activate');
  assert.equal(view.targets.speaker.action.allowed, true);
  controller.selectOutputMode('speaker');
  assert.deepEqual(coordinators[0].calls, [['activateOutput', 'speaker']]);
});

test('switches routes only after authoritative inactive and never resumes playback', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];

  controller.selectOutputMode('obs');
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    selectedOutputMode: 'speaker',
    lease: {
      epoch: 4,
      leaseTarget: 'speaker-player',
      clientKind: 'dashboard-speaker',
      status: 'deactivating',
      switchId: 'deactivate-switch',
    },
  }), { pendingSwitch: { operation: 'deactivate' } }));
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    selectedOutputMode: 'speaker',
    lease: { epoch: 5, status: 'inactive' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_inactive' },
  })));
  assert.deepEqual(coordinator.calls, [['deactivateOutput'], ['activateOutput', 'obs']]);

  coordinator.emit(coordinatorSnapshot(readyRoute('obs')));
  assert.equal(controller.getState().actualOutputMode, 'obs');
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
  assert.equal(coordinator.calls.some(([name]) => ['load', 'play'].includes(name)), false);
});

test('reselecting the actual active route clears a blocked alternate intent during playback', () => {
  const protocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(protocol, {
    activeRun: { entryId: 'entry-a', runId: 'run-a' },
  }));

  assertControlError(
    () => controller.selectOutputMode('obs'),
    ON_AIR_OUTPUT_CONTROL_CODES.ACTIVE_WORK,
  );
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED);

  const result = controller.selectOutputMode('speaker');
  assert.deepEqual(result, { status: 'already_active', mode: 'speaker' });
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
  assert.deepEqual(coordinators[0].calls, []);
});

test('rechecks the target candidate after deactivation and blocks if it disappeared', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];
  controller.selectOutputMode('obs');

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    selectedOutputMode: 'speaker',
    eligibleCandidates: { obs: [] },
    lease: { epoch: 5, status: 'inactive' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_inactive' },
  })));

  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED);
  assert.equal(controller.getState().outputSwitchState.reasonCode, ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT);
});

test('blocks zero or duplicate candidates, active work, and unknown authority', async (t) => {
  const cases = [
    {
      name: 'no candidate',
      snapshot: coordinatorSnapshot(playerSnapshot({ eligibleCandidates: { obs: [] } })),
      code: ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT,
    },
    {
      name: 'duplicate candidate',
      snapshot: coordinatorSnapshot(playerSnapshot({ eligibleCandidates: { obs: ['obs-a', 'obs-b'] } })),
      code: ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT,
    },
    {
      name: 'active work',
      snapshot: coordinatorSnapshot(playerSnapshot({
        activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
      })),
      code: ON_AIR_OUTPUT_CONTROL_CODES.ACTIVE_WORK,
    },
    {
      name: 'unknown authority',
      snapshot: coordinatorSnapshot(playerSnapshot(), {
        unknown: true,
        authorityUnknown: true,
      }),
      code: ON_AIR_OUTPUT_CONTROL_CODES.STATE_UNKNOWN,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const { controller, coordinators } = createHarness(fixture.snapshot);
      assertControlError(() => controller.selectOutputMode('obs'), fixture.code);
      assert.equal(coordinators[0].calls.length, 0);
      assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED);
    });
  }
});

test('maps the complete legacy command surface to coordinator APIs', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];
  const song = { id: 'song-a', title: 'Song A', type: 'audio', src: 'asset-a' };
  const display = { currentSong: null, history: [] };

  controller.sendCommand({
    type: 'load',
    sessionId: 'entry-b',
    runId: 'run-b',
    song,
    position: 3,
    volume: 42,
  });
  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    ...readyRoute('speaker'),
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  }), { activeRun }));
  controller.sendCommand({ type: 'play', sessionId: 'entry-a' });
  controller.sendCommand({ type: 'pause', entryId: 'entry-a', runId: 'run-a' });
  controller.sendCommand({ type: 'seek', sessionId: 'entry-a', position: 12 });
  controller.sendCommand({ type: 'volume', sessionId: 'entry-a', volume: 73 });
  controller.sendCommand({ type: 'stop', sessionId: 'entry-a' });
  controller.sendCommand({ type: 'prefetch', videoIds: ['abcdefghijk'] });
  controller.sendCommand({ type: 'display_state', display });
  controller.sendCommand({ type: 'end_session' });

  assert.deepEqual(coordinator.calls, [
    ['load', { entryId: 'entry-b', runId: 'run-b', song, position: 3, volume: 42 }],
    ['play'],
    ['pause'],
    ['seek', 12],
    ['setVolume', 73],
    ['stop'],
    ['prefetch', ['abcdefghijk']],
    ['publishDisplayState', display],
    ['endSession'],
  ]);
});

test('direct LOAD waits for exact ready proof and then sends PLAY exactly once', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];
  const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };

  controller.sendCommand({
    type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
  });
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: null,
  });
  assert.deepEqual(coordinator.calls, [[
    'load',
    { entryId: 'entry-b', runId: 'run-b', song, position: 0 },
  ]]);

  const ready = loadedReadySnapshot();
  coordinator.emit(ready);
  coordinator.emit(ready);

  assert.deepEqual(coordinator.calls, [
    ['load', { entryId: 'entry-b', runId: 'run-b', song, position: 0 }],
    ['play'],
  ]);
  assert.equal(
    controller.getState().playbackTransitionState.status,
    ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
  );

  const playing = loadedPlayingSnapshot();
  coordinator.emit(playing);
  coordinator.emit(playing);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.IDLE,
    entryId: null,
    runId: null,
    reasonCode: null,
  });
  assert.equal(coordinator.calls.filter(([name]) => name === 'play').length, 1);
});

test('premature explicit PLAY rejection preserves the pending initial auto-PLAY', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];
  const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };
  controller.sendCommand({
    type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
  });
  const premature = Object.assign(new Error('not ready'), {
    code: 'control_coordinator_run_identity_unconfirmed',
  });
  coordinator.nextPlayError = premature;

  assert.throws(
    () => controller.sendCommand({ type: 'play', sessionId: 'entry-b', runId: 'run-b' }),
    (error) => error === premature,
  );
  coordinator.emit(loadedReadySnapshot());
  coordinator.emit(loadedReadySnapshot());

  assert.equal(coordinator.calls.filter(([name]) => name === 'play').length, 2);
  assert.deepEqual(coordinator.calls.map(([name]) => name), ['load', 'play', 'play']);
});

test('an asynchronously rejected LOAD releases the transition so a later LOAD can retry', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
  const coordinator = coordinators[0];
  const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };
  controller.sendCommand({
    type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
  });

  coordinator.emit(coordinatorSnapshot(readyRoute('speaker'), {
    activeRun: {
      entryId: 'entry-b',
      runId: 'run-b',
      targetPlayerInstanceId: 'speaker-player',
      leaseEpoch: 4,
    },
    pendingCommandIds: ['load-command-1'],
  }));
  const rejected = coordinatorSnapshot(readyRoute('speaker'), {
    activeRun: null,
    pendingCommandIds: [],
  });
  coordinator.emit(rejected);

  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_REJECTED,
  });
  coordinator.emit(rejected);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_REJECTED,
  });

  assert.doesNotThrow(() => controller.sendCommand({
    type: 'load', sessionId: 'entry-c', runId: 'run-c', song,
  }));
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
    entryId: 'entry-c',
    runId: 'run-c',
    reasonCode: null,
  });
  assert.equal(coordinator.calls.filter(([name]) => name === 'load').length, 2);
});

test('identity-matched terminal LOAD evidence cancels auto-PLAY and permits a stopped retry path', async (t) => {
  for (const status of ['error', 'ended']) {
    await t.test(status, () => {
      const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
      const coordinator = coordinators[0];
      const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };
      controller.sendCommand({
        type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
      });
      const terminal = loadedReadySnapshot('entry-b', 'run-b', {
        protocol: {
          confirmedPlayback: {
            status,
            entryId: 'entry-b',
            runId: 'run-b',
            playerInstanceId: 'speaker-player',
            leaseEpoch: 4,
            paused: true,
          },
        },
      });
      coordinator.emit(terminal);

      assert.deepEqual(controller.getState().playbackTransitionState, {
        status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
        entryId: 'entry-b',
        runId: 'run-b',
        reasonCode: status === 'error'
          ? ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_ERROR
          : ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_ENDED,
      });
      coordinator.emit(terminal);

      const retry = controller.sendCommand({
        type: 'load', sessionId: 'entry-c', runId: 'run-c', song,
      });
      assert.equal(retry.status, 'queued_after_stop');
      assert.deepEqual(controller.getState().playbackTransitionState, {
        status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.STOPPING,
        entryId: 'entry-c',
        runId: 'run-c',
        reasonCode: null,
      });
      assert.equal(coordinator.calls.filter(([name]) => name === 'play').length, 0);
      assert.equal(coordinator.calls.filter(([name]) => name === 'stop').length, 1);
    });
  }
});

test('natural end queues STOP and sends the next LOAD only after exact authoritative stop proof', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const endedProtocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
    desiredTransport: {
      status: 'playing',
      song: { id: 'song-a' },
      entryId: 'entry-a',
      runId: 'run-a',
    },
    confirmedPlayback: {
      status: 'ended',
      entryId: 'entry-a',
      runId: 'run-a',
      playerInstanceId: 'speaker-player',
      leaseEpoch: 4,
    },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(endedProtocol, { activeRun }));
  const coordinator = coordinators[0];
  const nextSong = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };

  const result = controller.sendCommand({
    type: 'load',
    sessionId: 'entry-b',
    runId: 'run-b',
    song: nextSong,
  });
  assert.equal(result.status, 'queued_after_stop');
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.STOPPING,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: null,
  });
  assert.deepEqual(coordinator.calls, [['stop']]);

  coordinator.emit(coordinatorSnapshot(endedProtocol, { activeRun }));
  assert.deepEqual(coordinator.calls, [['stop']]);

  const stoppedProtocol = readyRoute('speaker', {
    activeFamily: null,
    desiredTransport: {
      status: 'stopped',
      song: null,
      entryId: null,
      runId: null,
    },
    confirmedPlayback: {
      status: 'stopped',
      entryId: 'entry-a',
      runId: 'run-a',
      playerInstanceId: 'speaker-player',
      leaseEpoch: 4,
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  });
  coordinator.emit(coordinatorSnapshot(stoppedProtocol));
  coordinator.emit(coordinatorSnapshot(stoppedProtocol));

  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: null,
  });
  assert.deepEqual(coordinator.calls, [
    ['stop'],
    ['load', {
      entryId: 'entry-b',
      runId: 'run-b',
      song: nextSong,
      position: 0,
    }],
  ]);
  assert.equal(coordinator.calls.some(([name]) => name === 'play'), false);

  const nextReady = loadedReadySnapshot();
  coordinator.emit(nextReady);
  coordinator.emit(nextReady);
  assert.deepEqual(coordinator.calls, [
    ['stop'],
    ['load', {
      entryId: 'entry-b',
      runId: 'run-b',
      song: nextSong,
      position: 0,
    }],
    ['play'],
  ]);
  assert.equal(
    controller.getState().playbackTransitionState.status,
    ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
  );

  const playing = loadedPlayingSnapshot();
  coordinator.emit(playing);
  coordinator.emit(playing);
  assert.equal(
    controller.getState().playbackTransitionState.status,
    ON_AIR_PLAYBACK_TRANSITION_STATUSES.IDLE,
  );
});

test('post-stop LOAD dispatch failure is exposed for the exact target and never retried by duplicate proof', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const activeProtocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(activeProtocol, { activeRun }));
  const coordinator = coordinators[0];
  const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };

  controller.sendCommand({
    type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
  });
  coordinator.nextLoadError = new Error('load dispatch failed');
  const stopped = coordinatorSnapshot(readyRoute('speaker', {
    activeFamily: null,
    desiredTransport: {
      status: 'stopped',
      song: null,
      entryId: null,
      runId: null,
    },
    confirmedPlayback: {
      status: 'stopped',
      entryId: 'entry-a',
      runId: 'run-a',
      playerInstanceId: 'speaker-player',
      leaseEpoch: 4,
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  }));

  coordinator.emit(stopped);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_DISPATCH_FAILED,
  });
  coordinator.emit(stopped);
  assert.deepEqual(coordinator.calls.map(([name]) => name), ['stop', 'load']);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_DISPATCH_FAILED,
  });
});

test('pending post-LOAD PLAY is cancelled by unknown, reconnect, identity mismatch, or route loss', async (t) => {
  const fixtures = [
    {
      name: 'unknown authority',
      reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.AUTHORITY_UNKNOWN,
      snapshot: () => coordinatorSnapshot(readyRoute('speaker'), {
        ready: false,
        writable: false,
        unknown: true,
        authorityUnknown: true,
      }),
    },
    {
      name: 'reconnect',
      reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.CONNECTION_LOST,
      snapshot: () => coordinatorSnapshot(readyRoute('speaker'), {
        state: 'connecting',
        ready: false,
        writable: false,
        unknown: true,
        authorityUnknown: true,
      }),
    },
    {
      name: 'identity mismatch',
      reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.RUN_IDENTITY_MISMATCH,
      snapshot: () => loadedReadySnapshot('foreign-entry', 'foreign-run'),
    },
    {
      name: 'route loss',
      reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST,
      snapshot: () => loadedReadySnapshot('entry-b', 'run-b', {
        protocol: { eligibleCandidates: { speaker: ['speaker-player', 'duplicate-player'] } },
      }),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('speaker')));
      const coordinator = coordinators[0];
      controller.sendCommand({
        type: 'load',
        sessionId: 'entry-b',
        runId: 'run-b',
        song: { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' },
      });
      const cancellation = fixture.snapshot();
      coordinator.emit(cancellation);
      assert.deepEqual(controller.getState().playbackTransitionState, {
        status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
        entryId: 'entry-b',
        runId: 'run-b',
        reasonCode: fixture.reasonCode,
      });
      coordinator.emit(cancellation);
      coordinator.emit(loadedReadySnapshot());
      assert.deepEqual(controller.getState().playbackTransitionState, {
        status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
        entryId: 'entry-b',
        runId: 'run-b',
        reasonCode: fixture.reasonCode,
      });
      assert.equal(coordinator.calls.filter(([name]) => name === 'play').length, 0);
    });
  }
});

test('an explicit STOP followed by LOAD reuses the same stop barrier without duplicate STOP', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const activeProtocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(activeProtocol, { activeRun }));
  const coordinator = coordinators[0];
  const song = { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' };

  controller.sendCommand({ type: 'stop', sessionId: 'entry-a' });
  const result = controller.sendCommand({
    type: 'load', sessionId: 'entry-b', runId: 'run-b', song,
  });

  assert.equal(result.status, 'queued_after_stop');
  assert.deepEqual(coordinator.calls, [['stop']]);
  assertControlError(
    () => controller.sendCommand({
      type: 'load', sessionId: 'entry-c', runId: 'run-c', song,
    }),
    ON_AIR_OUTPUT_CONTROL_CODES.PLAYBACK_TRANSITION_PENDING,
  );
});

test('never stops or replaces an unowned active family', () => {
  const protocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(protocol));

  assertControlError(
    () => controller.sendCommand({
      type: 'load',
      sessionId: 'entry-b',
      runId: 'run-b',
      song: { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' },
    }),
    ON_AIR_OUTPUT_CONTROL_CODES.UNOWNED_ACTIVE_RUN,
  );
  assert.deepEqual(coordinators[0].calls, []);
});

test('cancels a queued next LOAD if authority becomes unknown before stop proof', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const activeProtocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(activeProtocol, { activeRun }));
  const coordinator = coordinators[0];
  controller.sendCommand({
    type: 'load',
    sessionId: 'entry-b',
    runId: 'run-b',
    song: { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' },
  });

  coordinator.emit(coordinatorSnapshot(activeProtocol, {
    activeRun,
    unknown: true,
    authorityUnknown: true,
  }));
  coordinator.emit(coordinatorSnapshot(readyRoute('speaker', {
    confirmedPlayback: {
      status: 'stopped',
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  })));

  assert.deepEqual(coordinator.calls, [['stop']]);
});

test('cancels a queued next LOAD if the leased player is no longer the sole candidate', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const activeProtocol = readyRoute('speaker', {
    activeFamily: { family: 'run', entryId: 'entry-a', runId: 'run-a' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(activeProtocol, { activeRun }));
  const coordinator = coordinators[0];
  controller.sendCommand({
    type: 'load',
    sessionId: 'entry-b',
    runId: 'run-b',
    song: { id: 'song-b', title: 'Song B', type: 'audio', src: 'asset-b' },
  });

  const routeLoss = coordinatorSnapshot(playerSnapshot({
    ...activeProtocol,
    eligibleCandidates: { speaker: ['speaker-player', 'speaker-duplicate'] },
  }), { activeRun });
  coordinator.emit(routeLoss);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST,
  });
  coordinator.emit(routeLoss);
  coordinator.emit(coordinatorSnapshot(readyRoute('speaker', {
    confirmedPlayback: {
      status: 'stopped',
      paused: true,
      sourceDetached: true,
      autoplayCancelled: true,
      audible: false,
    },
  })));

  assert.deepEqual(coordinator.calls, [['stop']]);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST,
  });
});

test('requires exact load identity and rejects stale legacy run targeting', () => {
  const activeRun = { entryId: 'entry-a', runId: 'run-a' };
  const { controller } = createHarness(coordinatorSnapshot(readyRoute('speaker'), { activeRun }));
  const song = { id: 'song-a', title: 'Song A', type: 'audio', src: 'asset-a' };

  assertControlError(
    () => controller.sendCommand({ type: 'load', sessionId: 'entry-b', song }),
    ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_REQUIRED,
  );
  assertControlError(
    () => controller.sendCommand({
      type: 'load', entryId: 'entry-b', sessionId: 'entry-c', runId: 'run-b', song,
    }),
    ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH,
  );
  assertControlError(
    () => controller.sendCommand({ type: 'stop', sessionId: 'stale-entry' }),
    ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH,
  );
});

test('explicit retry disposes the old coordinator before creating a fresh owner', () => {
  let initial = coordinatorSnapshot();
  const { controller, coordinators } = createHarness(initial, {
    snapshotFactory: () => initial,
  });
  controller.selectOutputMode('speaker');
  initial = coordinatorSnapshot();

  controller.retryConnection();

  assert.equal(coordinators.length, 2);
  assert.equal(coordinators[0].disposed, true);
  assert.equal(coordinators[1].connectCalls, 1);
  assert.equal(coordinators[1].calls.some(([name]) => ['activateOutput', 'load', 'play'].includes(name)), false);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
});
