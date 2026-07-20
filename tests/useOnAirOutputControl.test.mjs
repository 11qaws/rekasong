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

  emergencyStop() {
    this.calls.push(['emergencyStop']);
    return {
      status: 'created',
      operation: 'emergencyStop',
      command: { commandId: 'fake-emergency-command' },
    };
  }

  waitForCommandResult(commandId) {
    this.calls.push(['waitForCommandResult', commandId]);
    return Promise.resolve({ commandId, status: 'acknowledged' });
  }

  startTest(options) {
    this.calls.push(['startTest', options]);
    return { status: 'created', operation: 'startTest' };
  }

  stopTest() {
    this.calls.push(['stopTest']);
    return { status: 'created', operation: 'stopTest' };
  }

  takeOverControl() {
    this.calls.push(['takeOverControl']);
    return { status: 'created', operation: 'takeOverControl' };
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
    ...(overrides.controllerOptions ?? {}),
  });
  controller.connect();
  return { controller, coordinators, transportOptions };
}

function createTimerHarness() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutFn(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { callback, delayMs });
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, 'expected a pending watchdog');
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
      return timer.delayMs;
    },
    get size() {
      return pending.size;
    },
  };
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

test('explicit authority takeover delegates once without replaying route or playback commands', () => {
  const { controller, coordinators } = createHarness();

  const result = controller.takeOverControl();

  assert.deepEqual(result, { status: 'created', operation: 'takeOverControl' });
  assert.deepEqual(coordinators[0].calls, [['takeOverControl']]);
  assert.equal(
    coordinators[0].calls.some(([name]) => ['activateOutput', 'load', 'play'].includes(name)),
    false,
  );
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
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

test('activation and deactivation watchdogs fail closed without assuming a route change', async (t) => {
  const fixtures = [
    {
      name: 'activation evidence never arrives',
      snapshot: coordinatorSnapshot(playerSnapshot()),
      target: 'obs',
      expectedCall: ['activateOutput', 'obs'],
      expectedPhase: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
    },
    {
      name: 'deactivation evidence never arrives',
      snapshot: coordinatorSnapshot(readyRoute('speaker')),
      target: 'obs',
      expectedCall: ['deactivateOutput'],
      expectedPhase: ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING,
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const timers = createTimerHarness();
      const { controller, coordinators } = createHarness(fixture.snapshot, {
        controllerOptions: {
          setTimeoutFn: timers.setTimeoutFn,
          clearTimeoutFn: timers.clearTimeoutFn,
          switchTimeoutMs: 25,
        },
      });

      controller.selectOutputMode(fixture.target);
      assert.equal(controller.getState().outputSwitchState.status, fixture.expectedPhase);
      assert.equal(timers.size, 1);
      assert.equal(timers.runNext(), 25);

      assert.deepEqual(controller.getState().outputSwitchState, {
        status: ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED,
        targetMode: fixture.target,
        reasonCode: ON_AIR_OUTPUT_CONTROL_CODES.SWITCH_TIMEOUT,
      });
      assert.deepEqual(coordinators[0].calls, [fixture.expectedCall]);
      assert.equal(
        coordinators[0].calls.some(([name]) => ['load', 'play'].includes(name)),
        false,
      );

      controller.retryConnection();
      assert.equal(coordinators.length, 2, 'manual recovery obtains fresh authority evidence');
      assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
      controller.dispose();
    });
  }
});

test('a first-click speaker selection waits for the page-owned lazy candidate and activates once', () => {
  const timers = createTimerHarness();
  const { controller, coordinators } = createHarness(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: [] },
  })), {
    controllerOptions: {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      candidateWaitMs: 30,
      switchTimeoutMs: 60,
      dashboardSpeakerPlayerInstanceId: 'speaker-player',
    },
  });
  const coordinator = coordinators[0];

  assert.deepEqual(controller.selectOutputMode('speaker'), {
    status: 'waiting_for_candidate',
    mode: 'speaker',
  });
  assert.deepEqual(coordinator.calls, []);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
  assert.equal(timers.size, 1);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['speaker-player'] },
  })));
  assert.deepEqual(coordinator.calls, [['activateOutput', 'speaker']]);
  assert.equal(timers.size, 1, 'candidate wait is replaced by the activation watchdog');

  coordinator.emit(coordinatorSnapshot(readyRoute('speaker')));
  assert.equal(controller.getState().actualOutputMode, 'speaker');
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
  assert.equal(timers.size, 0);
});

test('a missing page-owned speaker candidate times out visibly without sending a route command', () => {
  const timers = createTimerHarness();
  const { controller, coordinators } = createHarness(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: [] },
  })), {
    controllerOptions: {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      candidateWaitMs: 25,
      dashboardSpeakerPlayerInstanceId: 'speaker-player',
    },
  });

  controller.selectOutputMode('speaker');
  assert.equal(timers.runNext(), 25);
  assert.deepEqual(controller.getState().outputSwitchState, {
    status: ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED,
    targetMode: 'speaker',
    reasonCode: ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT,
  });
  assert.deepEqual(coordinators[0].calls, []);

  coordinators[0].emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['speaker-player'] },
  })));
  assert.deepEqual(
    coordinators[0].calls,
    [],
    'a candidate arriving after the explicit timeout cannot silently revive an expired click',
  );
});

test('multiple speaker candidates do not block the first-click intent while the owned player is joining', () => {
  const timers = createTimerHarness();
  const { controller, coordinators } = createHarness(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: [] },
  })), {
    controllerOptions: {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      candidateWaitMs: 25,
      dashboardSpeakerPlayerInstanceId: 'speaker-player',
    },
  });

  controller.selectOutputMode('speaker');
  coordinators[0].emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['speaker-a', 'speaker-b'] },
  })));

  assert.deepEqual(controller.getState().outputSwitchState, {
    status: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
    targetMode: 'speaker',
    reasonCode: null,
  });
  assert.deepEqual(coordinators[0].calls, []);
  assert.equal(timers.size, 1);
});

test('speaker activation requires the exact Dashboard-owned player identity', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['foreign-speaker'] },
  })), {
    controllerOptions: {
      dashboardSpeakerPlayerInstanceId: 'owned-speaker',
    },
  });

  assertControlError(
    () => controller.selectOutputMode('speaker'),
    ON_AIR_OUTPUT_CONTROL_CODES.TARGET_IDENTITY_MISMATCH,
  );
  assert.deepEqual(coordinators[0].calls, []);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED);
});

test('first-click wait ignores a sole foreign speaker and activates only the owned identity', () => {
  const timers = createTimerHarness();
  const { controller, coordinators } = createHarness(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: [] },
  })), {
    controllerOptions: {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      candidateWaitMs: 50,
      dashboardSpeakerPlayerInstanceId: 'owned-speaker',
    },
  });

  controller.selectOutputMode('speaker');
  coordinators[0].emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['foreign-speaker'] },
  })));
  assert.deepEqual(coordinators[0].calls, []);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);

  coordinators[0].emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['owned-speaker'] },
  })));
  assert.deepEqual(coordinators[0].calls, [['activateOutput', 'speaker']]);
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

test('full output reset stops every output before rebuilding control', async () => {
  const { controller, coordinators } = createHarness(readyRoute('obs'));
  const oldCoordinator = coordinators[0];

  await controller.resetOutputControl();

  assert.deepEqual(oldCoordinator.calls, [
    ['emergencyStop'],
    ['waitForCommandResult', 'fake-emergency-command'],
    ['dispose'],
  ]);
  assert.equal(coordinators.length, 2);
  assert.equal(coordinators[1].connectCalls, 1);
});

test('speaker route button retries deactivation when a disconnected speaker route is unknown', () => {
  const unknownProtocol = readyRoute('speaker', {
    lease: {
      status: 'unknown',
      leaseTarget: 'speaker-player',
      clientKind: 'dashboard-speaker',
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'target_disconnected' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(unknownProtocol, {
    routeUnknown: true,
  }), {
    controllerOptions: { dashboardSpeakerPlayerInstanceId: 'speaker-player' },
  });
  const coordinator = coordinators[0];

  controller.selectOutputMode('speaker');
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING);
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  // The server can publish the same unknown lease while the returning
  // speaker is processing the deactivation. That interim snapshot must not
  // erase the user-initiated recovery intent.
  coordinator.emit(coordinatorSnapshot(unknownProtocol, { routeUnknown: true }));
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING);

  assert.deepEqual(controller.emergencyStop(), {
    status: 'created',
    operation: 'emergencyStop',
    command: { commandId: 'fake-emergency-command' },
  });
  assert.deepEqual(coordinator.calls, [['deactivateOutput'], ['emergencyStop']]);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    selectedOutputMode: 'speaker',
    lease: { epoch: 5, status: 'inactive' },
    confirmedPlayback: { status: 'unknown', reasonCode: 'output_inactive' },
  })));
  controller.selectOutputMode('speaker');
  assert.deepEqual(coordinator.calls, [['deactivateOutput'], ['emergencyStop'], ['activateOutput', 'speaker']]);
});

test('speaker recovery waits for the replacement page-owned candidate after deactivation', () => {
  const unknownProtocol = readyRoute('speaker', {
    eligibleCandidates: { speaker: [] },
    lease: {
      status: 'unknown',
      leaseTarget: 'speaker-player',
      clientKind: 'dashboard-speaker',
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'target_disconnected' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(unknownProtocol, {
    routeUnknown: true,
  }), {
    controllerOptions: { dashboardSpeakerPlayerInstanceId: 'speaker-player' },
  });
  const coordinator = coordinators[0];

  controller.selectOutputMode('speaker');
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  // Deactivation is terminal, but the replacement player has not registered
  // yet. Keep the user's intent pending instead of blocking the route.
  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: [] },
    lease: { epoch: 5, status: 'inactive' },
  })));
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['speaker-player'] },
    lease: { epoch: 5, status: 'inactive' },
  })));
  assert.deepEqual(coordinator.calls, [['deactivateOutput'], ['activateOutput', 'speaker']]);
});

test('speaker recovery ignores one stale foreign candidate until the page-owned player returns', () => {
  const unknownProtocol = readyRoute('speaker', {
    eligibleCandidates: { speaker: ['old-speaker-player'] },
    lease: {
      status: 'unknown',
      leaseTarget: 'old-speaker-player',
      clientKind: 'dashboard-speaker',
    },
    confirmedPlayback: { status: 'unknown', reasonCode: 'target_disconnected' },
  });
  const { controller, coordinators } = createHarness(coordinatorSnapshot(unknownProtocol, {
    routeUnknown: true,
  }), {
    controllerOptions: { dashboardSpeakerPlayerInstanceId: 'speaker-player' },
  });
  const coordinator = coordinators[0];

  controller.selectOutputMode('speaker');
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['old-speaker-player'] },
    lease: { epoch: 5, status: 'inactive' },
  })));
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
  assert.deepEqual(coordinator.calls, [['deactivateOutput']]);

  coordinator.emit(coordinatorSnapshot(playerSnapshot({
    eligibleCandidates: { speaker: ['speaker-player'] },
    lease: { epoch: 5, status: 'inactive' },
  })));
  assert.deepEqual(coordinator.calls, [['deactivateOutput'], ['activateOutput', 'speaker']]);
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

test('wires OBS audio check start and safe stop directly to the owned coordinator', () => {
  const { controller, coordinators } = createHarness(coordinatorSnapshot(readyRoute('obs')));
  const coordinator = coordinators[0];

  assert.deepEqual(
    controller.startTest({ fixtureId: 'pcm-pulse-v1', durationMs: 8_000 }),
    { status: 'created', operation: 'startTest' },
  );
  assert.deepEqual(controller.stopTest(), { status: 'created', operation: 'stopTest' });
  assert.deepEqual(coordinator.calls, [
    ['startTest', { fixtureId: 'pcm-pulse-v1', durationMs: 8_000 }],
    ['stopTest'],
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
      assert.equal(
        coordinator.calls.filter(([name]) => name === 'play').length,
        0,
      );
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
      const expectedTransition = fixture.name === 'route loss'
        ? {
          status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
          entryId: 'entry-b',
          runId: 'run-b',
          reasonCode: null,
        }
        : {
          status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
          entryId: 'entry-b',
          runId: 'run-b',
          reasonCode: fixture.reasonCode,
        };
      assert.deepEqual(controller.getState().playbackTransitionState, expectedTransition);
      coordinator.emit(cancellation);
      coordinator.emit(loadedReadySnapshot());
      assert.deepEqual(controller.getState().playbackTransitionState, expectedTransition);
      assert.equal(
        coordinator.calls.filter(([name]) => name === 'play').length,
        fixture.name === 'route loss' ? 1 : 0,
      );
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

test('keeps a queued next LOAD when an additional speaker candidate appears', () => {
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
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.STOPPING,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: null,
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

  assert.deepEqual(coordinator.calls.map(([name]) => name), ['stop', 'load']);
  assert.deepEqual(controller.getState().playbackTransitionState, {
    status: ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
    entryId: 'entry-b',
    runId: 'run-b',
    reasonCode: null,
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
  const { controller, coordinators, transportOptions } = createHarness(initial, {
    snapshotFactory: () => initial,
  });
  controller.selectOutputMode('speaker');
  initial = coordinatorSnapshot();

  controller.retryConnection();

  assert.equal(coordinators.length, 2);
  assert.equal(coordinators[0].disposed, true);
  assert.equal(coordinators[1].connectCalls, 1);
  assert.match(transportOptions[0].transport.identity.controlInstanceId, /^control-/);
  assert.equal(
    transportOptions[1].transport.identity.controlInstanceId,
    transportOptions[0].transport.identity.controlInstanceId,
    'a socket rebuild keeps the page-lifetime control identity',
  );
  assert.equal(coordinators[1].calls.some(([name]) => ['activateOutput', 'load', 'play'].includes(name)), false);
  assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
});

test('starting and owner-released connections become manually recoverable after a bounded wait', async (t) => {
  const ownerReleasedProtocol = playerSnapshot({
    controlLease: {
      controlEpoch: 4,
      writableControlInstanceId: null,
      writableConnected: false,
    },
  });
  const fixtures = [
    {
      name: 'connection negotiation never settles',
      snapshot: coordinatorSnapshot(playerSnapshot(), {
        state: 'negotiating',
        ready: false,
        writable: false,
        unknown: true,
        authorityUnknown: true,
      }),
    },
    {
      name: 'released owner never renegotiates',
      snapshot: coordinatorSnapshot(ownerReleasedProtocol, {
        writable: false,
      }),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const timers = createTimerHarness();
      const { controller, coordinators } = createHarness(fixture.snapshot, {
        snapshotFactory: () => fixture.snapshot,
        controllerOptions: {
          setTimeoutFn: timers.setTimeoutFn,
          clearTimeoutFn: timers.clearTimeoutFn,
          connectionTimeoutMs: 40,
        },
      });

      assert.equal(timers.size, 1);
      assert.equal(timers.runNext(), 40);
      assert.deepEqual(controller.getState().outputSwitchState, {
        status: ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED,
        targetMode: null,
        reasonCode: ON_AIR_OUTPUT_CONTROL_CODES.CONNECTION_TIMEOUT,
      });
      assert.deepEqual(coordinators[0].calls, [], 'watchdog never routes or starts audio');
      coordinators[0].emit(fixture.snapshot);
      assert.equal(timers.size, 0, 'a blocked connection never spins another watchdog');

      controller.retryConnection();
      assert.equal(coordinators[0].disposed, true);
      assert.equal(coordinators.length, 2);
      assert.equal(controller.getState().outputSwitchState.status, ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE);
      controller.dispose();
    });
  }
});
