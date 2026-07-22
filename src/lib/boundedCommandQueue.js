export const BOUNDED_COMMAND_QUEUE_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'bounded_command_queue_invalid_configuration',
  INVALID_COMMAND: 'bounded_command_queue_invalid_command',
});

export class BoundedCommandQueueError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'BoundedCommandQueueError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

const TERMINAL_TRANSPORT_STATES = new Set(['failed', 'invalid_configuration']);

/**
 * Dispatch against the physical transport ref, not a render-time readiness
 * label. A missing ref is a bounded mount/remount wait even when React still
 * exposes the previous `ready` label; a usable ref wins over a stale
 * `initializing` label.
 */
export function dispatchDeferredTransportCommand({
  transport,
  state,
  queue,
  command,
  unavailableError,
} = {}) {
  if (transport && typeof transport.sendCommand === 'function') {
    return transport.sendCommand(command);
  }
  if (TERMINAL_TRANSPORT_STATES.has(state)) throw unavailableError();
  return queue.enqueue(command);
}

/**
 * Reconcile every physical readiness notification. This intentionally runs
 * even for `ready` -> `ready`, because React state effects may elide that
 * transition while a remounted forwarded ref still needs to drain commands.
 */
export function reconcileDeferredTransportState({
  transport,
  state,
  queue,
  error = null,
  unavailableError,
} = {}) {
  if (state === 'ready') {
    if (!transport || typeof transport.sendCommand !== 'function') return false;
    queue.drain((command) => transport.sendCommand(command));
    return true;
  }
  if (!TERMINAL_TRANSPORT_STATES.has(state)) return false;
  queue.rejectAll(error instanceof Error ? error : unavailableError());
  return true;
}

/**
 * Hold commands only while a lazy local transport is being mounted.
 *
 * The timeout covers transport readiness, not the duration of the command
 * itself. Once drain() takes a batch, every readiness timer is cleared before
 * the commands are dispatched in order.
 */
export function createBoundedCommandQueue({
  timeoutMs,
  timeoutError,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || typeof timeoutError !== 'function'
    || typeof setTimeoutFn !== 'function'
    || typeof clearTimeoutFn !== 'function') {
    throw new BoundedCommandQueueError(
      BOUNDED_COMMAND_QUEUE_CODES.INVALID_CONFIGURATION,
      {},
    );
  }

  const pending = [];

  const remove = (item) => {
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
  };

  const enqueue = (command) => {
    if (command === null || typeof command !== 'object' || Array.isArray(command)) {
      throw new BoundedCommandQueueError(
        BOUNDED_COMMAND_QUEUE_CODES.INVALID_COMMAND,
        {},
      );
    }
    let item = null;
    const promise = new Promise((resolve, reject) => {
      const timeoutId = setTimeoutFn(() => {
        remove(item);
        reject(timeoutError());
      }, timeoutMs);
      item = {
        command,
        begin() {
          clearTimeoutFn(timeoutId);
        },
        resolve(value) {
          clearTimeoutFn(timeoutId);
          resolve(value);
        },
        reject(error) {
          clearTimeoutFn(timeoutId);
          reject(error);
        },
      };
      pending.push(item);
    });
    return promise;
  };

  const rejectAll = (error) => {
    const batch = pending.splice(0);
    for (const item of batch) item.reject(error);
    return batch.length;
  };

  const drain = (dispatch) => {
    if (typeof dispatch !== 'function') {
      throw new BoundedCommandQueueError(
        BOUNDED_COMMAND_QUEUE_CODES.INVALID_CONFIGURATION,
        { field: 'dispatch' },
      );
    }
    const batch = pending.splice(0);
    for (const item of batch) item.begin();
    let tail = Promise.resolve();
    for (const item of batch) {
      tail = tail
        .then(() => dispatch(item.command))
        .then(item.resolve, item.reject);
    }
    return tail;
  };

  return Object.freeze({
    enqueue,
    rejectAll,
    drain,
    size: () => pending.length,
  });
}
