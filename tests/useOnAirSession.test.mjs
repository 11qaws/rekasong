import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_CONTROL_DISABLED_ERROR_CODE,
  createLegacyControlSocketManager,
  resolveLegacyControlEnabled
} from '../src/hooks/useOnAirSession.js';

const SESSION = Object.freeze({
  room: 'room-a',
  controlToken: 'control-a',
  playerToken: 'player-a'
});

class FakeSocket {
  constructor(url, harness) {
    this.url = url;
    this.harness = harness;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState !== 3) this.readyState = 2;
  }

  finishClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const createHarness = () => {
  const sockets = [];
  const timers = new Map();
  const allTimers = [];
  const connectionStates = [];
  const transports = [];
  const presences = [];
  const events = [];
  let nextTimerId = 0;
  let maxLiveSockets = 0;
  let transport = null;
  let presence = null;
  let sessionEndedCount = 0;

  const manager = createLegacyControlSocketManager({
    baseUrl: 'https://worker.example',
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url, harness);
      sockets.push(socket);
      maxLiveSockets = Math.max(maxLiveSockets, sockets.filter((item) => item.readyState !== 3).length);
      return socket;
    },
    schedule: (callback, delay) => {
      const timer = { id: ++nextTimerId, callback, delay, canceled: false };
      timers.set(timer.id, timer);
      allTimers.push(timer);
      return timer.id;
    },
    cancel: (timerId) => {
      const timer = timers.get(timerId);
      if (timer) timer.canceled = true;
      timers.delete(timerId);
    },
    onConnectionState: (state) => connectionStates.push(state),
    onTransport: (value) => {
      transport = typeof value === 'function' ? value(transport) : value;
      transports.push(transport);
    },
    onPresence: (value) => {
      presence = typeof value === 'function' ? value(presence) : value;
      presences.push(presence);
    },
    onSessionEnded: () => { sessionEndedCount += 1; },
    onEvent: (event) => events.push(event),
    commandIdFactory: () => 'generated-command-id'
  });

  const harness = {
    manager,
    sockets,
    timers,
    allTimers,
    connectionStates,
    transports,
    presences,
    events,
    get transport() { return transport; },
    get presence() { return presence; },
    get sessionEndedCount() { return sessionEndedCount; },
    get maxLiveSockets() { return maxLiveSockets; }
  };
  return harness;
};

test('legacy control remains enabled by default and only explicit false disables it', () => {
  assert.equal(resolveLegacyControlEnabled(), true);
  assert.equal(resolveLegacyControlEnabled({}), true);
  assert.equal(resolveLegacyControlEnabled({ enabled: true }), true);
  assert.equal(resolveLegacyControlEnabled({ enabled: false }), false);
  assert.equal(resolveLegacyControlEnabled({ enabled: 0 }), true);
});

test('disabled boundary creates no socket, exposes no optimistic truth, and rejects commands', () => {
  const harness = createHarness();
  harness.manager.activate({ enabled: false, session: SESSION });

  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.connectionStates.at(-1), 'disabled');
  assert.deepEqual(harness.transport, { status: 'idle', song: null, position: 0, volume: 100 });
  assert.deepEqual(harness.presence, { player: false, display: false });
  assert.throws(
    () => harness.manager.send({ type: 'play' }),
    (error) => error.code === LEGACY_CONTROL_DISABLED_ERROR_CODE
  );
  assert.equal(harness.timers.size, 0);
});

test('default activation preserves the legacy URL, messages, and command behavior', () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });

  assert.equal(harness.sockets.length, 1);
  const socket = harness.sockets[0];
  const url = new URL(socket.url);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/v1/sessions/room-a/ws');
  assert.equal(url.searchParams.get('role'), 'control');
  assert.equal(url.searchParams.get('token'), 'control-a');

  socket.open();
  assert.equal(harness.connectionStates.at(-1), 'connected');
  socket.receive({
    type: 'snapshot',
    transport: { status: 'playing', song: { title: 'fixture' }, position: 12, volume: 64 },
    presence: { player: true, display: true }
  });
  assert.equal(harness.transport.status, 'playing');
  assert.deepEqual(harness.presence, { player: true, display: true });
  assert.equal(harness.events.length, 1);

  assert.equal(harness.manager.send({ type: 'play' }), 'generated-command-id');
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'command',
    command: { type: 'play', commandId: 'generated-command-id' }
  });
});

test('ordinary legacy reconnect preserves transport while invalidating widget presence', () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  const socket = harness.sockets[0];
  socket.open();
  socket.receive({
    type: 'snapshot',
    transport: { status: 'playing', song: { title: 'legacy' }, position: 4, volume: 70 },
    presence: { player: true, display: true }
  });

  socket.finishClose(1006);

  assert.equal(harness.transport.status, 'playing');
  assert.deepEqual(harness.presence, { player: false, display: false });
  assert.equal(harness.connectionStates.at(-1), 'reconnecting');
});

test('a server-ended session stays ended when the hook reactivates with no session', () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  const socket = harness.sockets[0];
  socket.open();
  socket.receive({ type: 'session_ended' });

  assert.equal(harness.sessionEndedCount, 1);
  assert.equal(harness.connectionStates.at(-1), 'ended');
  harness.manager.activate({ enabled: true, session: null });
  assert.equal(harness.connectionStates.at(-1), 'ended');
  assert.deepEqual(harness.transport, { status: 'idle', song: null, position: 0, volume: 100 });
  assert.deepEqual(harness.presence, { player: false, display: false });

  socket.finishClose(1000);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.sockets.length, 1);
});

test('true to false transition clears truth, blocks stale events, and cancels reconnect', () => {
  const harness = createHarness();
  const release = harness.manager.activate({ enabled: true, session: SESSION });
  const socket = harness.sockets[0];
  socket.open();
  socket.receive({
    type: 'snapshot',
    transport: { status: 'playing', song: { title: 'stale' }, position: 8, volume: 80 },
    presence: { player: true, display: true }
  });

  release();
  harness.manager.activate({ enabled: false, session: SESSION });
  assert.equal(socket.readyState, 2);
  assert.equal(harness.connectionStates.at(-1), 'disabled');
  assert.deepEqual(harness.transport, { status: 'idle', song: null, position: 0, volume: 100 });
  assert.deepEqual(harness.presence, { player: false, display: false });

  const eventCount = harness.events.length;
  socket.receive({
    type: 'snapshot',
    transport: { status: 'playing', song: { title: 'late' }, position: 99, volume: 99 },
    presence: { player: true, display: true }
  });
  assert.equal(harness.events.length, eventCount);
  assert.equal(harness.transport.status, 'idle');
  assert.deepEqual(harness.presence, { player: false, display: false });

  socket.finishClose(1006);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.sockets.length, 1);
});

test('disabling cancels a scheduled reconnect and stale timer callbacks cannot reconnect', () => {
  const harness = createHarness();
  const release = harness.manager.activate({ enabled: true, session: SESSION });
  const socket = harness.sockets[0];
  socket.open();
  socket.finishClose(1006);
  assert.equal(harness.connectionStates.at(-1), 'reconnecting');
  assert.equal(harness.timers.size, 1);
  const staleTimer = harness.allTimers[0];

  release();
  harness.manager.activate({ enabled: false, session: SESSION });
  assert.equal(staleTimer.canceled, true);
  assert.equal(harness.timers.size, 0);

  staleTimer.callback();
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.connectionStates.at(-1), 'disabled');
});

test('false to true transition reconnects once and restores command authority only after OPEN', () => {
  const harness = createHarness();
  const releaseDisabled = harness.manager.activate({ enabled: false, session: SESSION });
  releaseDisabled();
  harness.manager.activate({ enabled: true, session: SESSION });

  assert.equal(harness.sockets.length, 1);
  assert.throws(
    () => harness.manager.send({ type: 'play' }),
    (error) => error.code === 'ON_AIR_LEGACY_CONTROL_NOT_CONNECTED'
  );
  harness.sockets[0].open();
  assert.equal(harness.manager.send({ type: 'pause', commandId: 'caller-id' }), 'caller-id');
  assert.equal(harness.sockets[0].sent.length, 1);
});

test('StrictMode cleanup and setup serialize sockets until the previous close completes', () => {
  const harness = createHarness();

  const releaseFirstMount = harness.manager.activate({ enabled: true, session: SESSION });
  const firstSocket = harness.sockets[0];
  releaseFirstMount();
  const releaseSecondMount = harness.manager.activate({ enabled: true, session: SESSION });

  assert.equal(firstSocket.readyState, 2);
  assert.equal(firstSocket.closeCalls, 1);
  assert.equal(harness.sockets.length, 1, 'replacement waits for the closing socket');
  assert.equal(harness.maxLiveSockets, 1);

  firstSocket.finishClose(1000);
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets[1].readyState, 0);
  assert.equal(harness.maxLiveSockets, 1, 'only one non-closed socket exists at any point');

  releaseSecondMount();
  harness.sockets[1].finishClose(1000);
  assert.equal(harness.timers.size, 0);
});

test('rapid session replacement waits for close and connects only the newest lease', () => {
  const harness = createHarness();
  harness.manager.activate({ enabled: true, session: SESSION });
  const firstSocket = harness.sockets[0];
  harness.manager.activate({
    enabled: true,
    session: { ...SESSION, room: 'room-b', controlToken: 'control-b' }
  });
  harness.manager.activate({
    enabled: true,
    session: { ...SESSION, room: 'room-c', controlToken: 'control-c' }
  });

  assert.equal(harness.sockets.length, 1);
  firstSocket.finishClose(1000);
  assert.equal(harness.sockets.length, 2);
  const url = new URL(harness.sockets[1].url);
  assert.equal(url.pathname, '/v1/sessions/room-c/ws');
  assert.equal(url.searchParams.get('token'), 'control-c');
  assert.equal(harness.maxLiveSockets, 1);
});
