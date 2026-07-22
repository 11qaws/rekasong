import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDED_COMMAND_QUEUE_CODES,
  BoundedCommandQueueError,
  createBoundedCommandQueue,
  dispatchDeferredTransportCommand,
  reconcileDeferredTransportState,
} from '../src/lib/boundedCommandQueue.js';

function fakeClock() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback, timeoutMs) {
      const id = ++nextId;
      timers.set(id, { callback, timeoutMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      const active = [...timers.values()];
      timers.clear();
      for (const timer of active) timer.callback();
    },
    snapshot: () => [...timers.values()].map(({ timeoutMs }) => timeoutMs),
  };
}

function queueWith(clock) {
  return createBoundedCommandQueue({
    timeoutMs: 12_000,
    timeoutError: () => new Error('local_speaker_not_ready'),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
}

test('a local command readiness wait is bounded and leaves the next retry open', async () => {
  const clock = fakeClock();
  const queue = queueWith(clock);
  const first = queue.enqueue({ type: 'load' });
  assert.equal(queue.size(), 1);
  assert.deepEqual(clock.snapshot(), [12_000]);

  clock.fireAll();
  await assert.rejects(first, /local_speaker_not_ready/);
  assert.equal(queue.size(), 0);

  const retry = queue.enqueue({ type: 'load', runId: 'retry' });
  assert.equal(queue.size(), 1);
  await queue.drain((command) => command.runId);
  assert.equal(await retry, 'retry');
});

test('drain clears readiness timers before serial command execution begins', async () => {
  const clock = fakeClock();
  const queue = queueWith(clock);
  const order = [];
  const first = queue.enqueue({ type: 'load' });
  const second = queue.enqueue({ type: 'play' });

  const drained = queue.drain(async (command) => {
    order.push(command.type);
    clock.fireAll();
    return `${command.type}-done`;
  });
  assert.deepEqual(clock.snapshot(), []);
  await drained;
  assert.deepEqual(order, ['load', 'play']);
  assert.equal(await first, 'load-done');
  assert.equal(await second, 'play-done');
});

test('rejectAll settles every waiting command and invalid input fails clearly', async () => {
  const clock = fakeClock();
  const queue = queueWith(clock);
  const first = queue.enqueue({ type: 'load' });
  const second = queue.enqueue({ type: 'play' });
  const failure = new Error('session_create_failed');

  assert.equal(queue.rejectAll(failure), 2);
  await assert.rejects(first, /session_create_failed/);
  await assert.rejects(second, /session_create_failed/);
  assert.equal(queue.size(), 0);
  assert.throws(
    () => queue.enqueue(null),
    (error) => error instanceof BoundedCommandQueueError
      && error.code === BOUNDED_COMMAND_QUEUE_CODES.INVALID_COMMAND,
  );
});

test('a stale ready label queues until the remounted physical transport reports ready again', async () => {
  const clock = fakeClock();
  const queue = queueWith(clock);
  const unavailableError = () => new Error('local_speaker_not_ready');
  const pending = dispatchDeferredTransportCommand({
    transport: null,
    state: 'ready',
    queue,
    command: { type: 'load', runId: 'speaker-switch' },
    unavailableError,
  });
  assert.equal(queue.size(), 1);

  const received = [];
  const transport = {
    sendCommand(command) {
      received.push(command);
      return `${command.runId}-loaded`;
    },
  };
  assert.equal(reconcileDeferredTransportState({
    transport,
    state: 'ready',
    queue,
    unavailableError,
  }), true);
  assert.equal(await pending, 'speaker-switch-loaded');
  assert.deepEqual(received, [{ type: 'load', runId: 'speaker-switch' }]);
});

test('the physical transport wins over a stale initializing label and terminal failures stay bounded', async () => {
  const clock = fakeClock();
  const queue = queueWith(clock);
  const unavailableError = () => new Error('local_speaker_not_ready');
  const transport = { sendCommand: (command) => command.runId };
  assert.equal(dispatchDeferredTransportCommand({
    transport,
    state: 'initializing',
    queue,
    command: { type: 'play', runId: 'already-ready' },
    unavailableError,
  }), 'already-ready');
  assert.equal(queue.size(), 0);
  assert.throws(() => dispatchDeferredTransportCommand({
    transport: null,
    state: 'failed',
    queue,
    command: { type: 'play', runId: 'failed' },
    unavailableError,
  }), /local_speaker_not_ready/);
});
