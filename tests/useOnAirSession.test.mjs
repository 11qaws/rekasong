import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LEGACY_CONTROL_DISABLED_ERROR_CODE,
  ON_AIR_SESSION_VALIDATION_STATES,
  buildOnAirDisplayUrl,
  buildOnAirPlayerUrl,
  createLegacyControlSocketManager,
  resolveLegacyControlEnabled,
  resolveLegacyControlObserveOnly,
  validateOnAirSession
} from '../src/hooks/useOnAirSession.js';

const SESSION = Object.freeze({
  room: 'room-a',
  controlToken: 'control-a',
  playerToken: 'player-a'
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

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

const createHarness = ({
  validation = { status: ON_AIR_SESSION_VALIDATION_STATES.ACTIVE },
  maxReconnectAttempts = 8
} = {}) => {
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
  let sessionInvalidCount = 0;
  const validationCalls = [];

  const manager = createLegacyControlSocketManager({
    baseUrl: 'https://worker.example',
    validateSession: async (request) => {
      validationCalls.push(request);
      return typeof validation === 'function'
        ? validation(request, validationCalls.length)
        : validation;
    },
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url, harness);
      sockets.push(socket);
      maxLiveSockets = Math.max(maxLiveSockets, sockets.filter((item) => item.readyState !== 3).length);
      return socket;
    },
    schedule: (callback, delay) => {
      const id = ++nextTimerId;
      const timer = { id, callback: null, delay, canceled: false };
      timer.callback = () => {
        timers.delete(id);
        callback();
      };
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
    onSessionInvalid: () => { sessionInvalidCount += 1; },
    onEvent: (event) => events.push(event),
    commandIdFactory: () => 'generated-command-id',
    maxReconnectAttempts
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
    get sessionInvalidCount() { return sessionInvalidCount; },
    get validationCalls() { return validationCalls; },
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

test('legacy observe-only mode accepts both explicit option names and never enables implicitly', () => {
  assert.equal(resolveLegacyControlObserveOnly(), false);
  assert.equal(resolveLegacyControlObserveOnly({}), false);
  assert.equal(resolveLegacyControlObserveOnly({ observeOnly: true }), true);
  assert.equal(resolveLegacyControlObserveOnly({ readOnly: true }), true);
  assert.equal(resolveLegacyControlObserveOnly({ observeOnly: false, readOnly: false }), false);
  assert.equal(resolveLegacyControlObserveOnly({ observeOnly: 1 }), false);
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

test('default activation validates first and preserves the legacy URL, messages, and command behavior', async () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  assert.equal(harness.sockets.length, 0, 'validation precedes WebSocket construction');
  await settle();

  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.validationCalls.length, 1);
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

test('observeOnly and readOnly activations keep validation, socket observations, and events but reject sends', async () => {
  for (const optionName of ['observeOnly', 'readOnly']) {
    const harness = createHarness();
    harness.manager.activate({ session: SESSION, [optionName]: true });
    await settle();

    assert.equal(harness.validationCalls.length, 1, `${optionName} still validates`);
    assert.equal(harness.sockets.length, 1, `${optionName} still opens the observation socket`);
    const socket = harness.sockets[0];
    socket.open();
    socket.receive({
      type: 'snapshot',
      transport: { status: 'playing', song: { title: optionName }, position: 7, volume: 55 },
      presence: { player: true, display: false }
    });

    assert.equal(harness.connectionStates.at(-1), 'connected');
    assert.equal(harness.transport.status, 'playing');
    assert.deepEqual(harness.presence, { player: true, display: false });
    assert.equal(harness.events.length, 1);
    assert.throws(
      () => harness.manager.send({ type: 'pause' }),
      (error) => error.code === LEGACY_CONTROL_DISABLED_ERROR_CODE
    );
    assert.equal(socket.sent.length, 0, `${optionName} cannot write to the legacy socket`);
  }
});

test('player URLs opt into protocol 2 while display URLs remain protocol-neutral', () => {
  const location = { origin: 'http://127.0.0.1:5000', pathname: '/app/' };
  const session = { ...SESSION, displayToken: 'display-a' };
  const baseUrl = 'https://worker.example/';
  const playerUrl = buildOnAirPlayerUrl({ ...location, baseUrl, session });
  const displayUrl = buildOnAirDisplayUrl({ ...location, baseUrl, session });
  const playerParams = new URLSearchParams(playerUrl.slice(playerUrl.indexOf('?') + 1));
  const displayParams = new URLSearchParams(displayUrl.slice(displayUrl.indexOf('?') + 1));

  assert.equal(playerParams.get('mode'), 'player');
  assert.equal(playerParams.get('session'), SESSION.room);
  assert.equal(playerParams.get('token'), SESSION.playerToken);
  assert.equal(playerParams.get('api'), 'https://worker.example');
  assert.equal(playerParams.get('protocol'), '2');
  assert.equal(displayParams.get('mode'), 'display');
  assert.equal(displayParams.get('session'), SESSION.room);
  assert.equal(displayParams.get('token'), 'display-a');
  assert.equal(displayParams.get('api'), 'https://worker.example');
  assert.equal(displayParams.has('protocol'), false);
});

test('PlaybackPanel retries the selected output when it is not the actual active output', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /mode === selectedOutputMode\s*&& mode === confirmedOutputMode/,
    'same-choice suppression must require both selected and actual output to match'
  );
});

test('ordinary legacy reconnect preserves transport while invalidating widget presence', async () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  await settle();
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

test('a server-ended session stays ended when the hook reactivates with no session', async () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  await settle();
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

test('true to false transition clears truth, blocks stale events, and cancels reconnect', async () => {
  const harness = createHarness();
  const release = harness.manager.activate({ enabled: true, session: SESSION });
  await settle();
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

test('disabling cancels a scheduled reconnect and stale timer callbacks cannot reconnect', async () => {
  const harness = createHarness();
  const release = harness.manager.activate({ enabled: true, session: SESSION });
  await settle();
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

test('false to true transition reconnects once and restores command authority only after OPEN', async () => {
  const harness = createHarness();
  const releaseDisabled = harness.manager.activate({ enabled: false, session: SESSION });
  releaseDisabled();
  harness.manager.activate({ enabled: true, session: SESSION });
  await settle();

  assert.equal(harness.sockets.length, 1);
  assert.throws(
    () => harness.manager.send({ type: 'play' }),
    (error) => error.code === 'ON_AIR_LEGACY_CONTROL_NOT_CONNECTED'
  );
  harness.sockets[0].open();
  assert.equal(harness.manager.send({ type: 'pause', commandId: 'caller-id' }), 'caller-id');
  assert.equal(harness.sockets[0].sent.length, 1);
});

test('StrictMode cleanup and setup serialize sockets until the previous close completes', async () => {
  const harness = createHarness();

  const releaseFirstMount = harness.manager.activate({ enabled: true, session: SESSION });
  await settle();
  const firstSocket = harness.sockets[0];
  releaseFirstMount();
  const releaseSecondMount = harness.manager.activate({ enabled: true, session: SESSION });

  assert.equal(firstSocket.readyState, 2);
  assert.equal(firstSocket.closeCalls, 1);
  assert.equal(harness.sockets.length, 1, 'replacement waits for the closing socket');
  assert.equal(harness.maxLiveSockets, 1);

  firstSocket.finishClose(1000);
  await settle();
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets[1].readyState, 0);
  assert.equal(harness.maxLiveSockets, 1, 'only one non-closed socket exists at any point');

  releaseSecondMount();
  harness.sockets[1].finishClose(1000);
  assert.equal(harness.timers.size, 0);
});

test('rapid session replacement waits for close and connects only the newest lease', async () => {
  const harness = createHarness();
  harness.manager.activate({ enabled: true, session: SESSION });
  await settle();
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
  await settle();
  assert.equal(harness.sockets.length, 2);
  const url = new URL(harness.sockets[1].url);
  assert.equal(url.pathname, '/v1/sessions/room-c/ws');
  assert.equal(url.searchParams.get('token'), 'control-c');
  assert.equal(harness.maxLiveSockets, 1);
});

test('session validator sends an authenticated read-only request and classifies exact statuses', async () => {
  const requests = [];
  const session = { ...SESSION, workerOrigin: 'https://worker.example/' };
  const responses = [200, 401, 410, 429];
  const expected = ['active', 'invalid', 'ended', 'retryable'];

  for (let index = 0; index < responses.length; index += 1) {
    const result = await validateOnAirSession({
      baseUrl: 'https://worker.example',
      session,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { status: responses[index] };
      }
    });
    assert.equal(result.status, expected[index]);
  }

  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, 'https://worker.example/v1/sessions/room-a/status');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer control-a');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('session validator rejects an explicit Worker origin mismatch without network access', async () => {
  let fetchCalls = 0;
  const result = await validateOnAirSession({
    baseUrl: 'https://production.example',
    session: { ...SESSION, workerOrigin: 'https://staging.example' },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { status: 200 };
    }
  });

  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'worker_origin_mismatch');
  assert.equal(fetchCalls, 0);
});

test('session validator treats network and non-authoritative HTTP failures as retryable', async () => {
  const network = await validateOnAirSession({
    baseUrl: 'https://worker.example',
    session: SESSION,
    fetchImpl: async () => { throw new Error('offline'); }
  });
  const unavailable = await validateOnAirSession({
    baseUrl: 'https://worker.example',
    session: SESSION,
    fetchImpl: async () => ({ status: 503 })
  });

  assert.equal(network.status, 'retryable');
  assert.equal(network.reason, 'network_error');
  assert.equal(unavailable.status, 'retryable');
  assert.equal(unavailable.httpStatus, 503);
});

test('invalid validation stops without a socket or timer and preserves explicit recovery authority', async () => {
  const harness = createHarness({ validation: { status: 'invalid', reason: 'credential_invalid' } });
  harness.manager.activate({ session: SESSION });
  await settle();

  assert.equal(harness.connectionStates.at(-1), 'invalid');
  assert.equal(harness.sessionInvalidCount, 1);
  assert.equal(harness.sessionEndedCount, 0);
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.throws(
    () => harness.manager.send({ type: 'play' }),
    (error) => error.code === LEGACY_CONTROL_DISABLED_ERROR_CODE
  );
});

test('ended validation reports terminal session state without opening a socket', async () => {
  const harness = createHarness({ validation: { status: 'ended', reason: 'session_ended' } });
  harness.manager.activate({ session: SESSION });
  await settle();

  assert.equal(harness.connectionStates.at(-1), 'ended');
  assert.equal(harness.sessionEndedCount, 1);
  assert.equal(harness.sessionInvalidCount, 0);
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.timers.size, 0);
});

test('retryable validation uses a bounded backoff and eventually becomes unavailable', async () => {
  const harness = createHarness({
    validation: { status: 'retryable', reason: 'network_error' },
    maxReconnectAttempts: 2
  });
  harness.manager.activate({ session: SESSION });
  await settle();

  assert.equal(harness.connectionStates.at(-1), 'reconnecting');
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.allTimers[0].delay, 1500);

  harness.allTimers[0].callback();
  await settle();
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.allTimers[1].delay, 2250);

  harness.allTimers[1].callback();
  await settle();
  assert.equal(harness.connectionStates.at(-1), 'unavailable');
  assert.equal(harness.validationCalls.length, 3);
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.timers.size, 0);
});

test('1011 never ends a session and reconnects only after another active validation', async () => {
  const harness = createHarness();
  harness.manager.activate({ session: SESSION });
  await settle();
  const firstSocket = harness.sockets[0];
  firstSocket.open();

  firstSocket.finishClose(1011);
  assert.equal(harness.sessionEndedCount, 0);
  assert.equal(harness.connectionStates.at(-1), 'reconnecting');
  assert.equal(harness.sockets.length, 1);

  harness.allTimers[0].callback();
  assert.equal(harness.sockets.length, 1, 'the retry validates before constructing a replacement');
  await settle();
  assert.equal(harness.validationCalls.length, 2);
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sessionEndedCount, 0);
});

test('late validation from a superseded lease cannot open a stale session socket', async () => {
  let resolveFirst;
  const harness = createHarness({
    validation: (_request, callNumber) => callNumber === 1
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : { status: 'active' }
  });

  harness.manager.activate({ session: SESSION });
  assert.equal(harness.validationCalls.length, 1);
  const firstSignal = harness.validationCalls[0].signal;
  harness.manager.activate({
    session: { ...SESSION, room: 'room-new', controlToken: 'control-new' }
  });
  await settle();

  assert.equal(firstSignal.aborted, true);
  assert.equal(harness.sockets.length, 1);
  assert.equal(new URL(harness.sockets[0].url).pathname, '/v1/sessions/room-new/ws');

  resolveFirst({ status: 'active' });
  await settle();
  assert.equal(harness.sockets.length, 1, 'superseded validation cannot create a second socket');
});
