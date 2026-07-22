import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  PLAYER_CLIENT_KINDS,
  ROUTE_COMMAND_TYPES,
  ROUTE_EVENT_TYPES,
  RUN_COMMAND_TYPES,
  RUN_EVENT_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_COMMAND_TYPES,
  TEST_EVENT_TYPES,
} from './onAirProtocol.js';
import {
  ON_AIR_V2_CONNECTION_STATES,
  OnAirV2Connection,
} from './onAirV2Connection.js';
import {
  PLAYBACK_COMMAND_TYPES,
  PLAYBACK_EVIDENCE_TYPES,
  PlaybackEngine,
} from './playbackEngine.js';
import {
  createOnAirTestFixtureSource,
  ON_AIR_TEST_FIXTURE_MARKERS,
  ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
} from './onAirTestFixture.js';

/**
 * Common player-side composition used by both dashboard-speaker and
 * obs-browser-source pages.
 *
 * This adapter proves only browser-local media postconditions and protocol
 * delivery. It never treats a WebSocket, an OBS runtime hint, or a local level
 * sample as proof that the final OBS mixer/recording path is audible.
 */

export const ON_AIR_PLAYBACK_ADAPTER_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'playback_adapter_invalid_configuration',
  SOURCE_RESOLVER_UNAVAILABLE: 'playback_adapter_source_resolver_unavailable',
  OUTPUT_PATH_UNAVAILABLE: 'playback_adapter_output_path_unavailable',
  TEST_FIXTURE_UNAVAILABLE: 'playback_adapter_test_fixture_unavailable',
  TEST_INVALID_CONFIGURATION: 'playback_adapter_test_invalid_configuration',
  TEST_NOT_ACTIVE: 'playback_adapter_test_not_active',
  TEST_ROUTE_NOT_READY: 'playback_adapter_test_route_not_ready',
  TEST_CONFLICT: 'playback_adapter_test_conflict',
  TEST_INCOMPLETE: 'playback_adapter_test_incomplete',
  TEST_CANCELLED: 'playback_adapter_test_cancelled',
  TEST_IDENTITY_MISMATCH: 'playback_adapter_test_identity_mismatch',
  TEST_MARKER_DELIVERY_FAILED: 'playback_adapter_test_marker_delivery_failed',
  TEST_TIMEOUT: 'playback_adapter_test_timeout',
  SESSION_ENDED: 'playback_adapter_session_ended',
  EVENT_DELIVERY_UNKNOWN: 'playback_adapter_event_delivery_unknown',
  ENGINE_COMMAND_FAILED: 'playback_adapter_engine_command_failed',
  ENGINE_POSTCONDITION_FAILED: 'playback_adapter_engine_postcondition_failed',
  RUNTIME_SOURCE_LOST: 'playback_adapter_runtime_source_lost',
  LOCAL_SAFETY_STOP_FAILED: 'playback_adapter_local_safety_stop_failed',
});

export const ON_AIR_PLAYBACK_SAFETY_PROFILES = Object.freeze({
  STRICT: 'strict',
  SPEAKER: 'speaker',
});

const RUNTIME_BOOLEAN_FIELDS = new Set([
  'sourceActive',
  'sourceVisible',
  'streaming',
  'recording',
]);
const RUNTIME_STRING_FIELDS = new Set(['obsPluginVersion', 'obsControlLevel']);
const TELEMETRY_EVIDENCE = new Set([
  PLAYBACK_EVIDENCE_TYPES.POSITION,
]);
const IDENTIFIER_MAX_LENGTH = 256;
const TEST_FIXTURE_CYCLE_MS = 2_000;
const TEST_COMPLETION_TOLERANCE_MS = 50;

export const ON_AIR_PLAYBACK_TEST_WATCHDOG_MS = Object.freeze({
  ready: 5_000,
  playing: 3_000,
  progress: 1_500,
  completionGrace: 2_000,
  markerAck: 2_000,
  stop: 2_000,
  emergencyStop: 2_000,
});

const TEST_FIXTURE_CYCLE_MARKERS = Object.freeze(
  ON_AIR_TEST_FIXTURE_MARKERS
    .filter((marker) => marker.startMs < TEST_FIXTURE_CYCLE_MS)
    .map((marker) => Object.freeze({
      startMs: marker.startMs,
      endMs: marker.endMs,
    })),
);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedClone(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 96 || depth > 4) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (state.seen.has(value)) return null;
    state.seen.add(value);
    return value.slice(0, 12).map((entry) => boundedClone(entry, state, depth + 1));
  }
  if (!isRecord(value) || state.seen.has(value)) return null;
  state.seen.add(value);
  const clone = {};
  for (const [key, entry] of Object.entries(value).slice(0, 24)) {
    clone[String(key).slice(0, 128)] = boundedClone(entry, state, depth + 1);
  }
  return clone;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value) {
  return deepFreeze(boundedClone(value));
}

function safeErrorDetail(error) {
  const detail = isRecord(error?.detail) ? error.detail : {};
  return immutableJson({
    errorName: typeof error?.name === 'string' ? error.name : 'Error',
    errorCode: stableCode(error?.code, null),
    detail,
  });
}

function stableCode(value, fallback) {
  const valid = typeof value === 'string'
    && value.length > 0
    && value.length <= IDENTIFIER_MAX_LENGTH
    && value === value.trim()
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
  return valid ? value : fallback;
}

function requireConfiguration(condition, field, kind) {
  if (condition) return;
  throw new OnAirPlaybackAdapterError(
    ON_AIR_PLAYBACK_ADAPTER_CODES.INVALID_CONFIGURATION,
    { field, kind },
  );
}

function sanitizedRuntime(value) {
  if (!isRecord(value)) return {};
  const runtime = {};
  for (const [field, entry] of Object.entries(value)) {
    if (RUNTIME_BOOLEAN_FIELDS.has(field) && typeof entry === 'boolean') runtime[field] = entry;
    if (RUNTIME_STRING_FIELDS.has(field) && typeof entry === 'string' && entry) runtime[field] = entry;
  }
  return runtime;
}

function finiteField(target, field, value) {
  if (Number.isFinite(value)) target[field] = value;
}

function stoppedPhysicalPostcondition(value) {
  if (!isRecord(value)
    || value.mediaPaused !== true
    || value.sourceDetached !== true
    || value.autoplayCancelled !== true) return null;
  return Object.freeze({
    status: 'stopped',
    mediaPaused: true,
    sourceDetached: true,
    autoplayCancelled: true,
    audible: false,
  });
}

function sameReadyConnection(before, after) {
  return before?.state === ON_AIR_V2_CONNECTION_STATES.READY
    && after?.state === ON_AIR_V2_CONNECTION_STATES.READY
    && typeof before.connectionId === 'string'
    && before.connectionId.length > 0
    && after.connectionId === before.connectionId;
}

function safeNotify(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(payload);
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  } catch {
    // Observability callbacks cannot change playback safety.
  }
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function operationAbortError() {
  const error = new Error('operation_aborted');
  error.name = 'AbortError';
  return error;
}

function testMarkerSchedule(durationMs) {
  const schedule = [];
  for (let cycleStartMs = 0; cycleStartMs < durationMs; cycleStartMs += TEST_FIXTURE_CYCLE_MS) {
    for (const marker of TEST_FIXTURE_CYCLE_MARKERS) {
      const markerTimeMs = cycleStartMs + marker.startMs;
      const markerEndMs = cycleStartMs + marker.endMs;
      if (markerEndMs > durationMs) continue;
      schedule.push(Object.freeze({
        markerIndex: schedule.length,
        markerTimeMs,
      }));
    }
  }
  return Object.freeze(schedule);
}

export class OnAirPlaybackAdapterError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirPlaybackAdapterError';
    this.code = code;
    this.detail = immutableJson(detail);
  }
}

export class OnAirPlaybackAdapter {
  #safetyProfile = ON_AIR_PLAYBACK_SAFETY_PROFILES.STRICT;
  #connectionRecovering = false;
  #runtimeReportScheduled = false;
  #sourceResolver;
  #prefetchSources;
  #testFixtureFactory;
  #outputPathProbe;
  #runtimeProbe;
  #requiresRuntimeSourceAttestation = false;
  #onSnapshot;
  #now;
  #defer;
  #setTimeoutFn;
  #clearTimeoutFn;
  #normalTail = Promise.resolve();
  #normalEpoch = 0;
  #currentNormalController = null;
  #localCommandSequence = 0;
  #lastObservedNow = 0;
  #routeState = 'standby';
  #confirmation = 'unknown';
  #lastError = null;
  #activeEntryId = null;
  #activeRunId = null;
  #activeLeaseEpoch = 0;
  #safetyLocked = true;
  #sourceActiveReported = false;
  #disposed = false;
  #sessionEnded = false;
  #emergencyLocalIds = new Map();
  #activeTest = null;
  #lastTestOutcome = null;

  constructor({
    connectionOptions = {},
    engineOptions = {},
    connectionFactory = (options) => new OnAirV2Connection(options),
    engineFactory = (options) => new PlaybackEngine(options),
    sourceResolver = null,
    prefetchSources = null,
    testFixtureFactory = createOnAirTestFixtureSource,
    outputPathProbe,
    runtimeProbe,
    now = defaultNow,
    defer = (callback) => Promise.resolve().then(callback),
    setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeoutFn = (handle) => globalThis.clearTimeout(handle),
    onSnapshot = null,
    safetyProfile = ON_AIR_PLAYBACK_SAFETY_PROFILES.STRICT,
  } = {}) {
    requireConfiguration(isRecord(connectionOptions), 'connectionOptions', 'record');
    requireConfiguration(isRecord(engineOptions), 'engineOptions', 'record');
    requireConfiguration(typeof connectionFactory === 'function', 'connectionFactory', 'function');
    requireConfiguration(typeof engineFactory === 'function', 'engineFactory', 'function');
    requireConfiguration(sourceResolver === null || typeof sourceResolver === 'function', 'sourceResolver', 'function_or_null');
    requireConfiguration(prefetchSources === null || typeof prefetchSources === 'function', 'prefetchSources', 'function_or_null');
    requireConfiguration(typeof testFixtureFactory === 'function', 'testFixtureFactory', 'function');
    requireConfiguration(typeof outputPathProbe === 'function', 'outputPathProbe', 'function');
    requireConfiguration(typeof runtimeProbe === 'function', 'runtimeProbe', 'function');
    requireConfiguration(typeof now === 'function', 'now', 'function');
    requireConfiguration(typeof defer === 'function', 'defer', 'function');
    requireConfiguration(typeof setTimeoutFn === 'function', 'setTimeoutFn', 'function');
    requireConfiguration(typeof clearTimeoutFn === 'function', 'clearTimeoutFn', 'function');
    requireConfiguration(onSnapshot === null || typeof onSnapshot === 'function', 'onSnapshot', 'function_or_null');
    requireConfiguration(
      Object.values(ON_AIR_PLAYBACK_SAFETY_PROFILES).includes(safetyProfile),
      'safetyProfile',
      'supported_profile',
    );

    this.#safetyProfile = safetyProfile;
    this.#sourceResolver = sourceResolver;
    this.#prefetchSources = prefetchSources;
    this.#testFixtureFactory = testFixtureFactory;
    this.#outputPathProbe = outputPathProbe;
    this.#runtimeProbe = runtimeProbe;
    this.#onSnapshot = onSnapshot;
    this.#now = now;
    this.#defer = defer;
    this.#setTimeoutFn = setTimeoutFn;
    this.#clearTimeoutFn = clearTimeoutFn;

    const userEvidence = engineOptions.onEvidence;
    this.engine = engineFactory({
      ...engineOptions,
      onEvidence: (evidence) => {
        this.#handleEvidence(evidence);
        safeNotify(userEvidence, evidence);
      },
    });
    requireConfiguration(this.engine && typeof this.engine.execute === 'function', 'engineFactory', 'playback_engine');
    requireConfiguration(typeof this.engine.snapshot === 'function', 'engineFactory', 'snapshot_capable');

    const userStateChange = connectionOptions.onStateChange;
    const userEventResult = connectionOptions.onEventResult;
    const userPlayerCommand = connectionOptions.onPlayerCommand;
    const userFrame = connectionOptions.onFrame;
    const userHeartbeatPayload = connectionOptions.heartbeatPayload;
    const configuredRuntime = sanitizedRuntime(connectionOptions.runtime);
    const runtimeMetadata = Object.fromEntries(Object.entries(configuredRuntime)
      .filter(([field]) => RUNTIME_STRING_FIELDS.has(field)));
    const requiresSourceActiveAttestation = connectionOptions.clientKind
      === PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE;
    this.#requiresRuntimeSourceAttestation = requiresSourceActiveAttestation;
    const initialRuntime = {
      ...runtimeMetadata,
      ...sanitizedRuntime(this.#runtimeProbe({ phase: 'hello' })),
    };
    this.#sourceActiveReported = typeof initialRuntime.sourceActive === 'boolean';
    this.connection = connectionFactory({
      ...connectionOptions,
      role: 'player',
      runtime: initialRuntime,
      heartbeatPayload: (context) => {
        const userExtension = typeof userHeartbeatPayload === 'function'
          ? userHeartbeatPayload(context)
          : {};
        // sourceActive is an OBS/page runtime attestation. It must never be
        // derived from PlaybackEngine.sourceAttached: output_ready is safely
        // source-detached by design and would otherwise make LOAD impossible.
        const currentRuntime = {
          ...sanitizedRuntime(userExtension?.runtime),
          ...sanitizedRuntime(this.#runtimeProbe({ ...context, phase: 'heartbeat' })),
        };
        if (typeof currentRuntime.sourceActive === 'boolean') {
          this.#sourceActiveReported = true;
        } else if (this.#sourceActiveReported) {
          // Never keep replaying a stale `true` attestation. Worker runtime is
          // merge-only, so a probe that loses previously observed evidence
          // must fail closed explicitly. Initial unobserved state stays absent.
          currentRuntime.sourceActive = false;
        }
        // OBS source callbacks are bridged directly by OnAirPlayerV2 and the
        // heartbeat carries the same observation to the dashboard. These are
        // scene/visibility signals, not proof that the media graph stopped.
        this.handleRuntimeAttestation(currentRuntime, { phase: 'heartbeat' });
        const runtime = { ...runtimeMetadata, ...currentRuntime };
        return Object.keys(runtime).length > 0 ? { runtime } : {};
      },
      onPlayerCommand: (command) => {
        const result = this.#handlePlayerCommand(command);
        safeNotify(userPlayerCommand, command);
        return result;
      },
      onStateChange: (change) => {
        this.#handleConnectionState(change);
        safeNotify(userStateChange, change);
      },
      onEventResult: (result) => {
        const testResultHandled = this.#handleTestEventResult(result);
        if (!testResultHandled && result?.status === 'outcome_unknown') {
          const continuityPlayback = result.entry?.message?.type
            === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT;
          if (continuityPlayback) {
            if (!this.#connectionRecovering) {
              this.#recordContinuityDeliveryUnknown(result.entry?.message, 'event_outcome_unknown', {
                eventId: result.entry?.eventId ?? null,
              });
            }
          } else if (!this.#connectionRecovering) {
            this.#markUnknown(
              ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
              { eventId: result.entry?.eventId ?? null },
            );
          }
        }
        safeNotify(userEventResult, result);
      },
      onFrame: (frame) => {
        this.#handleServerFrame(frame);
        safeNotify(userFrame, frame);
      },
    });
    requireConfiguration(this.connection && typeof this.connection.emitEvent === 'function', 'connectionFactory', 'player_connection');
    requireConfiguration(typeof this.connection.snapshot === 'function', 'connectionFactory', 'snapshot_capable');
    requireConfiguration(typeof this.connection.abandonEvents === 'function', 'connectionFactory', 'event_abandon_capable');
  }

  connect() {
    requireConfiguration(!this.#disposed, 'adapter', 'not_disposed');
    if (this.#sessionEnded) {
      throw new OnAirPlaybackAdapterError(
        ON_AIR_PLAYBACK_ADAPTER_CODES.SESSION_ENDED,
        { operation: 'connect' },
      );
    }
    return this.connection.connect();
  }

  close(code, reason) {
    this.#preemptForSafety('adapter_close');
    return this.connection.close(code, reason);
  }

  /**
   * Observe OBS scene state without using it as a playback kill switch.
   *
   * `obsSourceActiveChanged(false)` and `obsSourceVisibleChanged(false)` are
   * normal during scene changes. With "Shutdown source when not visible"
   * disabled, the page, WebSocket, audio element, and mixer path can all remain
   * alive. The connected socket is therefore the continuity boundary: an
   * actual page teardown closes it, while visibility telemetry only informs
   * the dashboard. Explicit STOP, deactivate, emergency stop, dispose, and a
   * terminal session event remain authoritative local-stop paths.
   */
  handleRuntimeAttestation(value, { phase = 'runtime_callback' } = {}) {
    if (this.#disposed || !this.#requiresRuntimeSourceAttestation) return Promise.resolve(false);
    sanitizedRuntime(value);
    // Runtime callbacks are observational: promptly mirror them to the
    // dashboard but never turn them into a local stop. Active/visible events
    // often arrive as a pair, so one microtask coalesces them into one
    // storage-free heartbeat. The periodic heartbeat path must not recurse.
    if (phase !== 'heartbeat' && !this.#runtimeReportScheduled) {
      this.#runtimeReportScheduled = true;
      this.#defer(() => {
        this.#runtimeReportScheduled = false;
        if (this.#disposed) return;
        try {
          this.connection.sendHeartbeatNow?.();
        } catch {
          // A callback racing a socket gap is telemetry loss, not proof that
          // the established audio graph stopped.
        }
      });
    }
    return Promise.resolve(false);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#preemptForSafety('adapter_dispose');
    try {
      this.connection.close(1000, 'adapter_dispose');
    } catch {
      // The local engine is still disposed below.
    }
    try {
      this.engine.dispose?.();
    } catch (error) {
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        safeErrorDetail(error),
      );
    }
  }

  snapshot() {
    return Object.freeze({
      routeState: this.#routeState,
      confirmation: this.#confirmation,
      safetyLocked: this.#safetyLocked,
      safetyProfile: this.#safetyProfile,
      connectionRecovering: this.#connectionRecovering,
      autoResumeAllowed: false,
      activeEntryId: this.#activeEntryId,
      activeRunId: this.#activeRunId,
      activeLeaseEpoch: this.#activeLeaseEpoch,
      activeTest: this.#activeTest
        ? Object.freeze({
          checkId: this.#activeTest.checkId,
          phase: this.#activeTest.phase,
          markerCount: this.#activeTest.nextMarkerIndex,
          queuedMarkerCount: this.#activeTest.nextMarkerIndex,
          acknowledgedMarkerCount: this.#activeTest.acknowledgedMarkerCount,
        })
        : null,
      lastTestOutcome: this.#lastTestOutcome,
      lastError: this.#lastError,
      connection: this.connection?.snapshot?.() ?? null,
      engine: this.engine?.snapshot?.() ?? null,
      disposed: this.#disposed,
    });
  }

  #clockNow() {
    try {
      const value = this.#now();
      if (Number.isFinite(value) && value >= 0) {
        this.#lastObservedNow = Math.max(this.#lastObservedNow, value);
      }
    } catch {
      // Preserve the last valid monotonic value.
    }
    return this.#lastObservedNow;
  }

  #nextLocalCommandId(prefix) {
    this.#localCommandSequence += 1;
    return `${prefix}-${this.#localCommandSequence}`;
  }

  #emitSnapshot() {
    safeNotify(this.#onSnapshot, this.snapshot());
  }

  #setLocalState(routeState, confirmation = this.#confirmation) {
    this.#routeState = routeState;
    this.#confirmation = confirmation;
    this.#emitSnapshot();
  }

  #isActiveTest(test) {
    return !this.#disposed && this.#activeTest === test;
  }

  #clearActiveTest(test = null) {
    if (test && this.#activeTest !== test) return false;
    if (!this.#activeTest) return false;
    const activeTest = this.#activeTest;
    this.#clearAllTestTimers(activeTest);
    this.#settleMarkerAckBarrier(activeTest, false);
    const pendingMarkerEventIds = [...activeTest.pendingMarkerEvents.keys()];
    if (pendingMarkerEventIds.length > 0) {
      try {
        this.connection.abandonEvents(pendingMarkerEventIds, { code: 'test_terminalized' });
        activeTest.pendingMarkerEvents.clear();
      } catch (error) {
        this.#safetyLocked = true;
        this.#markUnknown(
          ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
          { phase: 'marker_abandon', ...safeErrorDetail(error) },
        );
      }
    }
    this.#activeTest = null;
    return true;
  }

  #clearTestTimer(test, name) {
    if (!test?.timers?.has(name)) return false;
    const timer = test.timers.get(name);
    test.timers.delete(name);
    try {
      this.#clearTimeoutFn(timer.handle);
    } catch {
      // Phase and object fencing still make a late callback inert.
    }
    return true;
  }

  #clearAllTestTimers(test) {
    if (!test?.timers) return;
    for (const name of [...test.timers.keys()]) this.#clearTestTimer(test, name);
  }

  #settleMarkerAckBarrier(test, value, error = null) {
    const barrier = test?.markerAckBarrier;
    if (!barrier) return false;
    test.markerAckBarrier = null;
    if (error) barrier.reject(error);
    else barrier.resolve(value);
    return true;
  }

  #setLastTestOutcome(test, status, extra = {}) {
    this.#lastTestOutcome = immutableJson({
      checkId: test.checkId,
      status,
      queuedMarkerCount: test.nextMarkerIndex,
      acknowledgedMarkerCount: test.acknowledgedMarkerCount,
      observedAtMs: this.#clockNow(),
      ...extra,
    });
  }

  #armTestWatchdog(
    test,
    name,
    timeoutMs,
    allowedPhases,
    phase = name,
    code = ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT,
  ) {
    if (!this.#isActiveTest(test)) return false;
    this.#clearTestTimer(test, name);
    const timer = { handle: null };
    let handle;
    try {
      handle = this.#setTimeoutFn(() => {
        if (!this.#isActiveTest(test) || test.timers.get(name) !== timer) return;
        test.timers.delete(name);
        if (!allowedPhases.includes(test.phase)) return;
        this.#queueTestFailure(test, new OnAirPlaybackAdapterError(
          code,
          { phase, timeoutMs, observedAtMs: this.#clockNow() },
        ));
      }, timeoutMs);
      timer.handle = handle;
      handle?.unref?.();
      test.timers.set(name, timer);
      return true;
    } catch (error) {
      this.#queueTestFailure(test, new OnAirPlaybackAdapterError(
        code,
        {
          phase: `${phase}_watchdog_schedule`,
          timeoutMs,
          schedulingFailure: safeErrorDetail(error),
        },
      ));
      return false;
    }
  }

  #queueTestFailure(test, error) {
    if (!this.#isActiveTest(test) || test.phase === 'failing') return false;
    if (!test.pendingFailure) test.pendingFailure = error;
    this.#clearAllTestTimers(test);
    const terminalOwnsFailure = Boolean(test.terminalPromise);
    test.phase = 'failure_pending';
    this.#settleMarkerAckBarrier(test, false, test.pendingFailure);
    this.#emitSnapshot();
    if (!terminalOwnsFailure) {
      this.#deferTestTask(test, () => this.#failActiveTest(test, test.pendingFailure));
    }
    return true;
  }

  #noteTestProgress(test, mediaTime) {
    if (!this.#isActiveTest(test) || test.phase !== 'started'
      || !Number.isFinite(mediaTime) || mediaTime < 0) return false;
    const mediaTimeMs = mediaTime * 1_000;
    if (mediaTimeMs <= test.lastProgressMediaTimeMs) return false;
    test.lastProgressMediaTimeMs = mediaTimeMs;
    return this.#armTestWatchdog(
      test,
      'progress',
      ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.progress,
      ['started'],
      'progress',
    );
  }

  #executeTestSafetyCommand(test, command, timeoutMs, phase) {
    let handle = null;
    const timeout = new Promise((_, reject) => {
      try {
        handle = this.#setTimeoutFn(() => {
          reject(new OnAirPlaybackAdapterError(
            ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT,
            { phase, timeoutMs },
          ));
        }, timeoutMs);
      } catch (error) {
        reject(new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_TIMEOUT,
          { phase: `${phase}_watchdog_schedule`, ...safeErrorDetail(error) },
        ));
      }
    });
    let execution;
    try {
      execution = this.#isActiveTest(test)
        ? Promise.resolve(this.engine.execute(command))
        : Promise.resolve({ status: 'superseded' });
    } catch (error) {
      execution = Promise.reject(error);
    }
    return Promise.race([execution, timeout]).finally(() => {
      if (handle !== null) this.#clearTimeoutFn(handle);
    });
  }

  #sendTestEvent(test, event, extra = {}, commandId = test.commandId) {
    return this.#sendEvent({
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.TEST_EVENT, test.leaseEpoch),
      event,
      commandId,
      checkId: test.checkId,
      ...extra,
    });
  }

  #testMarkerDeliveryError(phase, detail = {}) {
    return new OnAirPlaybackAdapterError(
      ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED,
      { phase, ...detail },
    );
  }

  #sendTestMarker(test, marker) {
    const draft = {
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.TEST_EVENT, test.leaseEpoch),
      event: TEST_EVENT_TYPES.TEST_MARKER,
      commandId: test.commandId,
      checkId: test.checkId,
      ...marker,
    };
    let result;
    let before;
    test.markerSendInFlight = {
      markerIndex: marker.markerIndex,
      markerTimeMs: marker.markerTimeMs,
      earlyResult: null,
    };
    try {
      before = this.connection.snapshot();
      result = this.connection.emitEvent(draft);
    } catch (error) {
      test.markerSendInFlight = null;
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
        { event: TEST_EVENT_TYPES.TEST_MARKER, ...safeErrorDetail(error) },
      );
      this.#queueTestFailure(test, this.#testMarkerDeliveryError(
        'marker_enqueue_exception',
        { markerIndex: marker.markerIndex, failure: safeErrorDetail(error) },
      ));
      return false;
    }

    const after = this.connection.snapshot();
    const inFlight = test.markerSendInFlight;
    test.markerSendInFlight = null;
    if (!this.#isActiveTest(test)) return false;
    if (!sameReadyConnection(before, after)) {
      if (this.#routeState !== 'unknown') {
        this.#markUnknown(
          ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
          { event: TEST_EVENT_TYPES.TEST_MARKER, reason: 'connection_changed_during_send' },
        );
      }
      if (!this.#safetyLocked) this.#defer(() => this.#preemptForSafety('event_delivery_unknown'));
      this.#queueTestFailure(test, this.#testMarkerDeliveryError(
        'marker_connection_changed',
        { markerIndex: marker.markerIndex },
      ));
      return false;
    }

    const entry = result?.entry;
    const message = entry?.message;
    const eventId = stableCode(entry?.eventId, null);
    const acceptedStatus = ['created', 'retry'].includes(result?.status);
    const coalesced = result?.coalescedEventId !== null
      && result?.coalescedEventId !== undefined;
    const exactEntry = eventId !== null
      && isRecord(message)
      && message.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT
      && message.event === TEST_EVENT_TYPES.TEST_MARKER
      && message.commandId === test.commandId
      && message.checkId === test.checkId
      && message.leaseEpoch === test.leaseEpoch
      && message.markerIndex === marker.markerIndex
      && message.markerTimeMs === marker.markerTimeMs;

    if (!acceptedStatus || coalesced || !exactEntry) {
      if (result?.status === 'outcome_unknown') {
        this.#markUnknown(
          ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
          { event: TEST_EVENT_TYPES.TEST_MARKER, eventId },
        );
      }
      this.#queueTestFailure(test, this.#testMarkerDeliveryError(
        'marker_enqueue',
        {
          markerIndex: marker.markerIndex,
          status: typeof result?.status === 'string' ? result.status : null,
          eventId,
          coalescedEventId: stableCode(result?.coalescedEventId, null),
          exactEntry,
        },
      ));
      return false;
    }

    test.pendingMarkerEvents.set(eventId, Object.freeze({
      markerIndex: marker.markerIndex,
      markerTimeMs: marker.markerTimeMs,
    }));
    if (inFlight?.earlyResult) {
      const earlyEventId = stableCode(inFlight.earlyResult?.entry?.eventId, null);
      if (earlyEventId !== eventId) {
        this.#queueTestFailure(test, this.#testMarkerDeliveryError(
          'marker_early_ack_identity',
          { expectedEventId: eventId, actualEventId: earlyEventId },
        ));
        return false;
      }
      this.#handleTestEventResult(inFlight.earlyResult);
    }
    return true;
  }

  #handleTestEventResult(result) {
    const entry = result?.entry;
    const message = entry?.message;
    if (message?.type !== ON_AIR_MESSAGE_TYPES.TEST_EVENT
      || message.event !== TEST_EVENT_TYPES.TEST_MARKER) return false;

    const test = this.#activeTest;
    if (!test || message.checkId !== test.checkId) {
      return result?.status !== 'outcome_unknown';
    }

    const eventId = stableCode(entry?.eventId, null);
    const pending = eventId ? test.pendingMarkerEvents.get(eventId) : null;
    if (result?.status === 'acknowledged' && result?.ackStatus === 'relayed') {
      if (!eventId) {
        this.#queueTestFailure(test, this.#testMarkerDeliveryError(
          'marker_ack_identity',
          { eventId: null, markerIndex: message.markerIndex ?? null },
        ));
        return true;
      }
      if (!pending) {
        const inFlight = test.markerSendInFlight;
        if (inFlight
          && message.markerIndex === inFlight.markerIndex
          && message.markerTimeMs === inFlight.markerTimeMs) {
          inFlight.earlyResult = result;
        }
        return true;
      }
      if (message.markerIndex !== pending.markerIndex
        || message.markerTimeMs !== pending.markerTimeMs) {
        this.#queueTestFailure(test, this.#testMarkerDeliveryError(
          'marker_ack_identity',
          { eventId, markerIndex: message.markerIndex },
        ));
        return true;
      }
      test.pendingMarkerEvents.delete(eventId);
      test.acknowledgedMarkerCount += 1;
      if (test.pendingMarkerEvents.size === 0 && test.markerAckBarrier) {
        this.#clearTestTimer(test, 'marker_ack');
        this.#settleMarkerAckBarrier(test, true);
      }
      this.#emitSnapshot();
      return true;
    }

    if (!pending && result?.status === 'duplicate_terminal') return true;
    if (result?.status === 'outcome_unknown') {
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
        { event: TEST_EVENT_TYPES.TEST_MARKER, eventId },
      );
    }
    this.#queueTestFailure(test, this.#testMarkerDeliveryError(
      'marker_ack',
      {
        eventId,
        markerIndex: pending?.markerIndex ?? message.markerIndex ?? null,
        status: typeof result?.status === 'string' ? result.status : null,
        ackStatus: typeof result?.ackStatus === 'string' ? result.ackStatus : null,
      },
    ));
    return true;
  }

  #sendTestCommandFailure(command, code, detail = {}) {
    return this.#sendEvent({
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.TEST_EVENT, command.leaseEpoch),
      event: TEST_EVENT_TYPES.TEST_FAILED,
      commandId: command.commandId,
      checkId: command.checkId,
      code,
      detail: immutableJson(detail),
    });
  }

  #deferTestTask(test, task) {
    let scheduled;
    try {
      scheduled = this.#defer(async () => {
        if (!this.#isActiveTest(test)) return;
        await task();
      });
    } catch (error) {
      scheduled = Promise.reject(error);
    }
    Promise.resolve(scheduled).catch((error) => {
      if (!this.#isActiveTest(test)) return;
      Promise.resolve().then(() => this.#failActiveTest(test, error)).catch(() => {});
    });
  }

  #markUnknown(code, detail = {}) {
    this.#routeState = 'unknown';
    this.#confirmation = 'unknown';
    this.#lastError = immutableJson({ code, detail });
    this.#emitSnapshot();
  }

  #recordContinuityDeliveryUnknown(draft, reason, detail = {}) {
    this.#lastError = immutableJson({
      code: ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
      detail: {
        type: draft?.type ?? null,
        event: draft?.event ?? null,
        reason,
        ...detail,
      },
    });
    this.#emitSnapshot();
  }

  #reassertSurvivingPlaybackAfterReconnect() {
    if (this.#disposed || this.#sessionEnded || this.#activeTest
      || !this.#activeEntryId || !this.#activeRunId) return false;

    let engine;
    try {
      engine = this.engine.snapshot();
    } catch {
      return false;
    }
    if (engine?.runId !== this.#activeRunId || engine.sourceAttached !== true
      || !Number.isFinite(engine.position) || engine.position < 0) return false;

    const draft = {
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT, this.#activeLeaseEpoch),
      entryId: this.#activeEntryId,
      runId: this.#activeRunId,
      mediaTime: engine.position,
    };
    if (engine.status === RUN_EVENT_TYPES.PLAYING && engine.mediaPaused === false) {
      draft.event = RUN_EVENT_TYPES.PLAYING;
      draft.paused = false;
    } else if (engine.status === RUN_EVENT_TYPES.PAUSED && engine.mediaPaused === true) {
      draft.event = RUN_EVENT_TYPES.PAUSED;
      draft.paused = true;
    } else if (engine.status === RUN_EVENT_TYPES.BUFFERING && engine.mediaPaused === false
      && Number.isSafeInteger(engine.readyState) && engine.readyState >= 0 && engine.readyState <= 3) {
      draft.event = RUN_EVENT_TYPES.BUFFERING;
      draft.readyState = engine.readyState;
    } else if (engine.status === RUN_EVENT_TYPES.READY && engine.mediaPaused === true
      && Number.isFinite(engine.duration) && engine.duration >= 0
      && Number.isSafeInteger(engine.readyState) && engine.readyState >= 2 && engine.readyState <= 4) {
      draft.event = RUN_EVENT_TYPES.READY;
      draft.duration = engine.duration;
      draft.readyState = engine.readyState;
      draft.paused = true;
    } else if (engine.status === RUN_EVENT_TYPES.ENDED && engine.mediaPaused === true
      && Number.isFinite(engine.duration) && engine.duration >= 0) {
      draft.event = RUN_EVENT_TYPES.ENDED;
      draft.duration = engine.duration;
      draft.paused = true;
    } else {
      return false;
    }

    return this.#sendEvent(draft, { continuity: true });
  }

  #handleConnectionState(change) {
    if (this.#sessionEnded
      && change?.state !== ON_AIR_V2_CONNECTION_STATES.READY) {
      this.#emitSnapshot();
      return;
    }
    if (change?.previous === ON_AIR_V2_CONNECTION_STATES.READY
      && change.state !== ON_AIR_V2_CONNECTION_STATES.READY) {
      if (this.#activeTest && this.#safetyProfile === ON_AIR_PLAYBACK_SAFETY_PROFILES.STRICT) {
        // A verification fixture cannot produce trustworthy markers across a
        // transport gap. Abort the fixture and prove a local stop, while the
        // normal song graph remains connection-first below.
        this.#preemptForSafety(`connection_${change.state}`);
        this.#markUnknown('playback_adapter_connection_lost', {
          state: change.state,
          reason: change.detail?.reason ?? null,
          testAborted: true,
        });
        return;
      }
      // A transient transport gap or OBS scene change is not proof that the
      // media graph stopped. Keep local playback alive while the socket
      // reconnects; explicit stop/deactivate/emergency commands and terminal
      // page/session teardown remain the physical safety boundaries.
      this.#connectionRecovering = true;
      this.#lastError = immutableJson({
        code: 'playback_adapter_connection_reconnecting',
        detail: {
          state: change.state,
          reason: change.detail?.reason ?? null,
          autoResumeAllowed: false,
        },
      });
      this.#emitSnapshot();
      return;
    }
    if (change?.state === ON_AIR_V2_CONNECTION_STATES.READY) {
      const recovered = this.#connectionRecovering;
      this.#connectionRecovering = false;
      this.#lastError = null;
      if (recovered) this.#reassertSurvivingPlaybackAfterReconnect();
    }
    this.#emitSnapshot();
  }

  #handleServerFrame(frame) {
    if (frame?.type === AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH) {
      if (!this.#prefetchSources) return;
      try {
        // PREFETCH is a bounded, best-effort hint. It cannot change route,
        // playback authority, or safety state even when the fetch fails.
        Promise.resolve(this.#prefetchSources(frame.payload.videoIds)).catch(() => {});
      } catch {
        // A synchronous resolver failure has the same best-effort semantics.
      }
      return;
    }
    if (frame?.type !== SERVER_MESSAGE_TYPES.SESSION_ENDED || this.#sessionEnded) return;
    this.#sessionEnded = true;
    this.#preemptForSafety('session_ended');
    this.#markUnknown(ON_AIR_PLAYBACK_ADAPTER_CODES.SESSION_ENDED, {
      reasonCode: typeof frame.reasonCode === 'string' ? frame.reasonCode : null,
      cleanupAt: Number.isFinite(frame.cleanupAt) ? frame.cleanupAt : null,
    });
    try {
      this.connection.close(1000, 'session_ended');
    } catch {
      // Local safety preemption and the terminal fence remain authoritative.
    }
  }

  #preemptForSafety(reason) {
    const testWasActive = Boolean(this.#activeTest);
    this.#normalEpoch += 1;
    this.#abortCurrentNormal();
    this.#safetyLocked = true;
    this.#activeEntryId = null;
    this.#activeRunId = null;
    this.#clearActiveTest();
    const localCommandId = this.#nextLocalCommandId('safety');
    let result;
    try {
      result = this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
        commandId: localCommandId,
      });
    } catch (error) {
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        { reason, ...safeErrorDetail(error) },
      );
      if (testWasActive) {
        try {
          this.connection.close(4003, 'test_safety_stop_failed');
        } catch {
          // The adapter remains locally safety-locked and unknown.
        }
      }
      return;
    }
    Promise.resolve(result).catch((error) => {
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        { reason, ...safeErrorDetail(error) },
      );
      if (testWasActive) {
        try {
          this.connection.close(4003, 'test_safety_stop_failed');
        } catch {
          // The adapter remains locally safety-locked and unknown.
        }
      }
    });
  }

  #rejectMismatchedTestStop(command, test) {
    const detail = {
      requestedType: TEST_COMMAND_TYPES.STOP,
      expectedCheckId: test.checkId,
      actualCheckId: command?.checkId ?? null,
    };
    this.#lastError = immutableJson({
      code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_IDENTITY_MISMATCH,
      detail,
    });
    this.#emitSnapshot();
    return false;
  }

  #handlePlayerCommand(command) {
    if (command?.type === ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP) {
      return this.#handleEmergency(command);
    }
    if (command?.type === TEST_COMMAND_TYPES.STOP && this.#activeTest) {
      const test = this.#activeTest;
      if (command.checkId !== test.checkId) {
        return this.#rejectMismatchedTestStop(command, test);
      }
      this.#normalEpoch += 1;
      this.#abortCurrentNormal();
      return this.#completeActiveTest(test, {
        commandId: command.commandId,
        reason: 'explicit_stop',
      });
    }
    const epoch = this.#normalEpoch;
    const operation = this.#normalTail
      .catch(() => {})
      .then(async () => {
        if (this.#disposed || epoch !== this.#normalEpoch) return;
        const controller = new AbortController();
        this.#currentNormalController = controller;
        try {
          return await this.#applyNormalCommand(command, epoch, controller.signal);
        } finally {
          if (this.#currentNormalController === controller) this.#currentNormalController = null;
        }
      });
    this.#normalTail = operation.catch(() => {});
    return operation;
  }

  async #applyNormalCommand(command, epoch, signal) {
    if (this.#disposed || epoch !== this.#normalEpoch) return;
    if (Object.values(RUN_COMMAND_TYPES).includes(command.type)) {
      if (this.#activeTest) {
        this.#sendRunEvent(RUN_EVENT_TYPES.COMMAND_FAILED, command, {
          commandId: command.commandId,
          code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CONFLICT,
          detail: { activeCheckId: this.#activeTest.checkId },
        });
        return;
      }
      await this.#applyRunCommand(command, epoch);
      return;
    }
    if (Object.values(ROUTE_COMMAND_TYPES).includes(command.type)) {
      if (this.#activeTest) {
        const stopped = await this.#completeActiveTest(this.#activeTest, {
          commandId: command.commandId,
          reason: 'route_command',
        });
        if (!stopped || epoch !== this.#normalEpoch) return;
      }
      await this.#applyRouteCommand(command, epoch, signal);
      return;
    }
    if (Object.values(TEST_COMMAND_TYPES).includes(command.type)) {
      if (command.type === TEST_COMMAND_TYPES.START && this.#activeTest) {
        const stopped = await this.#completeActiveTest(this.#activeTest, {
          commandId: command.commandId,
          reason: 'test_replaced',
        });
        if (!stopped || epoch !== this.#normalEpoch) return;
      }
      await this.#applyTestCommand(command, epoch);
    }
  }

  #abortCurrentNormal() {
    const controller = this.#currentNormalController;
    this.#currentNormalController = null;
    if (!controller || controller.signal.aborted) return;
    try {
      controller.abort();
    } catch {
      // Epoch fencing remains authoritative if an adapter cannot abort.
    }
  }

  async #awaitAbortable(value, signal) {
    if (signal.aborted) throw operationAbortError();
    let removeAbortListener = () => {};
    const aborted = new Promise((_, reject) => {
      const rejectAbort = () => reject(operationAbortError());
      signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
    });
    try {
      return await Promise.race([Promise.resolve(value), aborted]);
    } finally {
      removeAbortListener();
    }
  }

  #eventBase(type, leaseEpoch) {
    return {
      type,
      protocolVersion: ON_AIR_PROTOCOL_VERSION,
      leaseEpoch,
      monotonicTimeMs: this.#clockNow(),
    };
  }

  #sendEvent(draft, { telemetry = false, continuity = false } = {}) {
    try {
      const preservesPlaybackContinuity = continuity
        || draft?.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT;
      const before = this.connection.snapshot();
      const result = this.connection.emitEvent(draft);
      const after = this.connection.snapshot();
      if (!sameReadyConnection(before, after)) {
        if (this.#connectionRecovering || preservesPlaybackContinuity) {
          if (this.#safetyProfile === ON_AIR_PLAYBACK_SAFETY_PROFILES.STRICT
            && draft.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT) {
            this.#markUnknown(
              ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
              { type: draft.type, event: draft.event ?? null, reason: 'connection_reconnecting' },
            );
          }
          this.#recordContinuityDeliveryUnknown(
            draft,
            this.#connectionRecovering
              ? 'connection_reconnecting'
              : 'connection_changed_during_send',
          );
          return false;
        }
        if (this.#routeState !== 'unknown') {
          this.#markUnknown(
            ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
            { type: draft.type, event: draft.event ?? null, reason: 'connection_changed_during_send' },
          );
        }
        if (!this.#safetyLocked) this.#defer(() => this.#preemptForSafety('event_delivery_unknown'));
        return false;
      }
      if (result?.status === 'outcome_unknown') {
        if (this.#connectionRecovering || preservesPlaybackContinuity) {
          this.#recordContinuityDeliveryUnknown(
            draft,
            this.#connectionRecovering ? 'connection_reconnecting' : 'event_outcome_unknown',
          );
          return false;
        }
        this.#markUnknown(
          ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
          { type: draft.type, event: draft.event ?? null },
        );
        this.#defer(() => this.#preemptForSafety('event_delivery_unknown'));
        return false;
      }
      if (result?.status === 'dropped') return telemetry;
      return true;
    } catch (error) {
      const preservesPlaybackContinuity = continuity
        || draft?.type === ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT;
      if (this.#connectionRecovering || preservesPlaybackContinuity) {
        this.#recordContinuityDeliveryUnknown(draft, 'event_send_failed', safeErrorDetail(error));
        return false;
      }
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.EVENT_DELIVERY_UNKNOWN,
        safeErrorDetail(error),
      );
      this.#defer(() => this.#preemptForSafety('event_delivery_failed'));
      return false;
    }
  }

  #sendRunEvent(event, command, extra = {}) {
    return this.#sendEvent({
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT, command.leaseEpoch),
      event,
      entryId: command.entryId,
      runId: command.runId,
      ...extra,
    }, { telemetry: TELEMETRY_EVIDENCE.has(event) });
  }

  async #stopAfterRunFailure(command, epoch) {
    this.#safetyLocked = true;
    this.#routeState = 'unknown';
    this.#confirmation = 'unknown';
    this.#activeEntryId = null;
    this.#activeRunId = null;
    try {
      const result = await this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
        commandId: this.#nextLocalCommandId(`run-${command.type}-failure-safety`),
      });
      if (epoch !== this.#normalEpoch) return { superseded: true };
      const postcondition = stoppedPhysicalPostcondition(result?.postcondition);
      if (!postcondition) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
          result?.postcondition,
        );
      }
      return { superseded: false, stopped: true, postcondition };
    } catch (error) {
      if (epoch !== this.#normalEpoch) return { superseded: true };
      return {
        superseded: false,
        stopped: false,
        error: safeErrorDetail(error),
      };
    }
  }

  #appliedRunContract(command, result, status) {
    if (command.type === RUN_COMMAND_TYPES.STOP) {
      const postcondition = stoppedPhysicalPostcondition(result?.postcondition);
      if (!postcondition) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_POSTCONDITION_FAILED,
          { commandType: command.type, postcondition: result?.postcondition },
        );
      }
      return { commandType: 'STOP', postcondition };
    }
    if (command.type === RUN_COMMAND_TYPES.SEEK) {
      const position = result?.postcondition?.position;
      if (!Number.isFinite(position) || position < 0) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_POSTCONDITION_FAILED,
          { commandType: command.type, field: 'position' },
        );
      }
      return {
        commandType: 'SEEK',
        postcondition: { status, position },
      };
    }
    if (command.type === RUN_COMMAND_TYPES.VOLUME) {
      const engineVolume = result?.postcondition?.volume;
      if (!Number.isFinite(engineVolume) || engineVolume < 0 || engineVolume > 1) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_POSTCONDITION_FAILED,
          { commandType: command.type, field: 'volume' },
        );
      }
      return {
        commandType: 'VOLUME',
        postcondition: {
          status,
          volume: Math.round(engineVolume * 100 * 1_000_000) / 1_000_000,
        },
      };
    }
    return { commandType: null, postcondition: { status } };
  }

  async #applyRunCommand(command, epoch) {
    if (this.#safetyLocked || this.#routeState !== 'ready_event_sent') {
      this.#sendRunEvent(RUN_EVENT_TYPES.COMMAND_FAILED, command, {
        commandId: command.commandId,
        code: 'playback_adapter_safety_locked',
        detail: { autoResumeAllowed: false },
      });
      return;
    }
    if (!this.#sendRunEvent(RUN_EVENT_TYPES.COMMAND_RECEIVED, command, {
      commandId: command.commandId,
    })) return;
    if (epoch !== this.#normalEpoch) return;

    if (command.type === RUN_COMMAND_TYPES.LOAD) {
      this.#activeEntryId = command.entryId;
      this.#activeRunId = command.runId;
      this.#activeLeaseEpoch = command.leaseEpoch;
    }

    let engineCommand;
    try {
      engineCommand = this.#toEngineCommand(command);
      const result = await this.engine.execute(engineCommand);
      if (epoch !== this.#normalEpoch || result?.status === 'superseded') return;
      const status = this.engine.snapshot().status || result?.status || 'applied';
      const applied = this.#appliedRunContract(command, result, status);
      if (!this.#sendRunEvent(RUN_EVENT_TYPES.COMMAND_APPLIED, command, {
        commandId: command.commandId,
        ...(applied.commandType ? { commandType: applied.commandType } : {}),
        postcondition: applied.postcondition,
      })) return;
      if (command.type === RUN_COMMAND_TYPES.STOP) {
        this.#activeEntryId = null;
        this.#activeRunId = null;
      }
      this.#confirmation = 'local_event_sent';
      this.#lastError = null;
      this.#emitSnapshot();
    } catch (error) {
      if (epoch !== this.#normalEpoch) return;
      const code = stableCode(
        error?.code,
        ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
      );
      const safety = await this.#stopAfterRunFailure(command, epoch);
      if (safety.superseded) return;
      this.#lastError = immutableJson({
        code: safety.stopped ? code : ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        commandCode: code,
        detail: safeErrorDetail(error),
        safetyStopped: safety.stopped,
        ...(safety.error ? { safety: safety.error } : {}),
      });
      this.#sendRunEvent(RUN_EVENT_TYPES.COMMAND_FAILED, command, {
        commandId: command.commandId,
        code,
        detail: {
          ...safeErrorDetail(error),
          safetyStopped: safety.stopped,
          ...(safety.error ? { safety: safety.error } : {}),
        },
        ...(safety.stopped ? { safetyPostcondition: safety.postcondition } : {}),
      });
      if (!safety.stopped) {
        try {
          this.connection.close(4003, 'run_failure_safety_stop_failed');
        } catch {
          // Local safety lock remains authoritative if transport close fails.
        }
      }
      this.#emitSnapshot();
    }
  }

  #toEngineCommand(command) {
    const payload = isRecord(command.payload) ? command.payload : {};
    const mapped = {
      type: command.type,
      commandId: command.commandId,
      runId: command.runId,
    };
    if (command.type === RUN_COMMAND_TYPES.LOAD) {
      if (!this.#sourceResolver) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.SOURCE_RESOLVER_UNAVAILABLE,
          { type: command.type },
        );
      }
      mapped.position = Number.isFinite(payload.position) ? payload.position : 0;
      if (Number.isFinite(payload.volume)) mapped.volume = payload.volume;
      mapped.sourceFactory = ({ signal, generation }) => this.#sourceResolver({
        song: payload.song,
        payload,
        entryId: command.entryId,
        runId: command.runId,
        leaseEpoch: command.leaseEpoch,
        generation,
        signal,
      });
    } else if (command.type === RUN_COMMAND_TYPES.SEEK) {
      mapped.position = payload.position;
    } else if (command.type === RUN_COMMAND_TYPES.VOLUME) {
      mapped.volume = payload.volume;
    }
    return mapped;
  }

  async #applyRouteCommand(command, epoch, signal) {
    if (command.type === ROUTE_COMMAND_TYPES.ACTIVATE) {
      this.#setLocalState('activating', 'local_only');
      try {
        const result = await this.engine.execute({
          type: PLAYBACK_COMMAND_TYPES.DETACH,
          commandId: this.#nextLocalCommandId('route-activate'),
        });
        if (epoch !== this.#normalEpoch) return;
        const engineSnapshot = this.engine.snapshot();
        const probe = await this.#awaitAbortable(this.#outputPathProbe({
          command,
          engine: engineSnapshot,
          connection: this.connection.snapshot(),
          signal,
        }), signal);
        if (epoch !== this.#normalEpoch || signal.aborted) return;
        const outputPathReady = probe === true || (isRecord(probe) && probe.ready === true);
        const postcondition = result?.postcondition || {};
        if (!outputPathReady || !postcondition.mediaPaused || !postcondition.sourceDetached
          || !postcondition.autoplayCancelled) {
          throw new OnAirPlaybackAdapterError(
            ON_AIR_PLAYBACK_ADAPTER_CODES.OUTPUT_PATH_UNAVAILABLE,
            {
              outputPathReady,
              mediaPaused: Boolean(postcondition.mediaPaused),
              sourceDetached: Boolean(postcondition.sourceDetached),
              autoplayCancelled: Boolean(postcondition.autoplayCancelled),
            },
          );
        }
        const sent = this.#sendEvent({
          ...this.#eventBase(ON_AIR_MESSAGE_TYPES.ROUTE_EVENT, command.leaseEpoch),
          event: ROUTE_EVENT_TYPES.OUTPUT_READY,
          switchId: command.switchId,
          postcondition: {
            mediaPaused: true,
            sourceDetached: true,
            autoplayCancelled: true,
            outputPathReady: true,
            audible: false,
          },
        });
        if (!sent) return;
        this.#activeLeaseEpoch = command.leaseEpoch;
        this.#safetyLocked = false;
        this.#lastError = null;
        this.#setLocalState('ready_event_sent', 'local_event_sent');
      } catch (error) {
        if (epoch !== this.#normalEpoch) return;
        this.#sendEvent({
          ...this.#eventBase(ON_AIR_MESSAGE_TYPES.ROUTE_EVENT, command.leaseEpoch),
          event: ROUTE_EVENT_TYPES.OUTPUT_ACTIVATION_FAILED,
          switchId: command.switchId,
          code: stableCode(
            error?.code,
            ON_AIR_PLAYBACK_ADAPTER_CODES.OUTPUT_PATH_UNAVAILABLE,
          ),
          detail: safeErrorDetail(error),
        });
        this.#markUnknown(
          stableCode(error?.code, ON_AIR_PLAYBACK_ADAPTER_CODES.OUTPUT_PATH_UNAVAILABLE),
          safeErrorDetail(error),
        );
      }
      return;
    }

    this.#safetyLocked = true;
    this.#setLocalState('deactivating', 'local_only');
    try {
      const result = await this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.DETACH,
        commandId: this.#nextLocalCommandId('route-deactivate'),
      });
      if (epoch !== this.#normalEpoch) return;
      const postcondition = result?.postcondition || {};
      if (!postcondition.mediaPaused || !postcondition.sourceDetached
        || !postcondition.autoplayCancelled) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
          postcondition,
        );
      }
      if (!this.#sendEvent({
        ...this.#eventBase(ON_AIR_MESSAGE_TYPES.ROUTE_EVENT, command.leaseEpoch),
        event: ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED,
        switchId: command.switchId,
        postcondition: {
          mediaPaused: true,
          sourceDetached: true,
          autoplayCancelled: true,
        },
      })) return;
      this.#activeEntryId = null;
      this.#activeRunId = null;
      this.#lastError = null;
      this.#setLocalState('standby_event_sent', 'local_event_sent');
    } catch (error) {
      if (epoch !== this.#normalEpoch) return;
      const actual = isRecord(error?.detail) ? error.detail : {};
      const postcondition = {};
      for (const field of ['mediaPaused', 'sourceDetached', 'autoplayCancelled', 'audible']) {
        if (typeof actual[field] === 'boolean') postcondition[field] = actual[field];
      }
      const failure = {
        ...this.#eventBase(ON_AIR_MESSAGE_TYPES.ROUTE_EVENT, command.leaseEpoch),
        event: ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED,
        switchId: command.switchId,
        code: stableCode(
          error?.code,
          ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        ),
        detail: safeErrorDetail(error),
      };
      const completeSuccess = postcondition.mediaPaused === true
        && postcondition.sourceDetached === true
        && postcondition.autoplayCancelled === true
        && postcondition.audible === false;
      if (Object.keys(postcondition).length > 0 && !completeSuccess) {
        failure.postcondition = postcondition;
      }
      this.#sendEvent(failure);
      this.#markUnknown(
        stableCode(error?.code, ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED),
        safeErrorDetail(error),
      );
    }
  }

  async #applyTestCommand(command, epoch) {
    if (command.type === TEST_COMMAND_TYPES.STOP) {
      if (this.#activeTest) {
        if (command.checkId !== this.#activeTest.checkId) {
          this.#rejectMismatchedTestStop(command, this.#activeTest);
          return;
        }
        await this.#completeActiveTest(this.#activeTest, {
          commandId: command.commandId,
          reason: 'explicit_stop',
        });
        return;
      }
      this.#sendTestCommandFailure(
        command,
        ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_NOT_ACTIVE,
        { requestedType: command.type },
      );
      return;
    }
    if (this.#safetyLocked || this.#routeState !== 'ready_event_sent') {
      this.#sendTestCommandFailure(
        command,
        ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_ROUTE_NOT_READY,
        { autoResumeAllowed: false },
      );
      return;
    }
    if (this.#activeEntryId || this.#activeRunId) {
      this.#sendTestCommandFailure(
        command,
        ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CONFLICT,
        { activeRun: true },
      );
      return;
    }

    const payload = isRecord(command.payload) ? command.payload : {};
    const test = {
      commandId: command.commandId,
      checkId: command.checkId,
      leaseEpoch: command.leaseEpoch,
      fixtureId: payload.fixtureId,
      durationMs: payload.durationMs,
      runId: this.#nextLocalCommandId('test-run'),
      markers: Object.freeze([]),
      nextMarkerIndex: 0,
      acknowledgedMarkerCount: 0,
      pendingMarkerEvents: new Map(),
      markerSendInFlight: null,
      lastMediaTimeMs: 0,
      lastProgressMediaTimeMs: -1,
      phase: 'loading',
      timers: new Map(),
      markerAckBarrier: null,
      pendingFailure: null,
      cancellationRequest: null,
      terminalPromise: null,
    };
    this.#activeTest = test;
    this.#emitSnapshot();

    if (!Number.isSafeInteger(test.durationMs)
      || test.durationMs < ON_AIR_TEST_FIXTURE_MIN_DURATION_MS
      || test.durationMs > 10_000) {
      await this.#failActiveTest(
        test,
        new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_INVALID_CONFIGURATION,
          {
            field: 'payload.durationMs',
            minimumMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
            maximumMs: 10_000,
          },
        ),
      );
      return;
    }
    test.markers = testMarkerSchedule(test.durationMs);

    try {
      test.phase = 'awaiting_ready';
      if (!this.#armTestWatchdog(
        test,
        'ready',
        ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.ready,
        ['awaiting_ready'],
        'ready',
      )) return;
      const result = await this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.LOAD,
        commandId: this.#nextLocalCommandId('test-load'),
        runId: test.runId,
        position: 0,
        volume: 100,
        sourceFactory: ({ signal, generation }) => this.#testFixtureFactory({
          fixtureId: test.fixtureId,
          durationMs: test.durationMs,
          checkId: test.checkId,
          generation,
          signal,
        }),
      });
      if (!this.#isActiveTest(test) || epoch !== this.#normalEpoch) return;
      if (['superseded', 'cancelled'].includes(result?.status)) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
          { phase: 'test_load', status: result?.status ?? null },
        );
      }
      this.#emitSnapshot();
    } catch (error) {
      if (!this.#isActiveTest(test) || epoch !== this.#normalEpoch) return;
      await this.#failActiveTest(test, error);
    }
  }

  async #beginTestPlayback(test) {
    if (!this.#isActiveTest(test) || test.phase !== 'awaiting_ready') return;
    test.phase = 'play_pending';
    if (!this.#armTestWatchdog(
      test,
      'playing',
      ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.playing,
      ['play_pending'],
      'playing',
    )) return;
    this.#emitSnapshot();
    try {
      const result = await this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.PLAY,
        commandId: this.#nextLocalCommandId('test-play'),
        runId: test.runId,
      });
      if (!this.#isActiveTest(test)) return;
      if (['superseded', 'cancelled'].includes(result?.status)) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
          { phase: 'test_play', status: result?.status ?? null },
        );
      }
      this.#emitSnapshot();
    } catch (error) {
      if (!this.#isActiveTest(test)) return;
      await this.#failActiveTest(test, error);
    }
  }

  #emitDueTestMarkers(test, mediaTime) {
    if (!this.#isActiveTest(test) || test.phase !== 'started'
      || !Number.isFinite(mediaTime) || mediaTime < 0) return;
    test.lastMediaTimeMs = Math.max(test.lastMediaTimeMs, mediaTime * 1_000);
    while (test.nextMarkerIndex < test.markers.length) {
      const marker = test.markers[test.nextMarkerIndex];
      if (marker.markerTimeMs > test.lastMediaTimeMs) break;
      const sent = this.#sendTestMarker(test, marker);
      if (!sent) return;
      test.nextMarkerIndex += 1;
    }
    this.#emitSnapshot();
  }

  #awaitMarkerAcks(test) {
    if (!this.#isActiveTest(test)) return Promise.resolve(false);
    if (test.pendingMarkerEvents.size === 0) return Promise.resolve(true);
    if (test.markerAckBarrier) return test.markerAckBarrier.promise;

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    test.markerAckBarrier = { promise, resolve, reject };
    test.phase = 'awaiting_marker_acks';
    this.#emitSnapshot();
    this.#armTestWatchdog(
      test,
      'marker_ack',
      ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.markerAck,
      ['awaiting_marker_acks'],
      'marker_ack_timeout',
      ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_MARKER_DELIVERY_FAILED,
    );
    return promise;
  }

  #requestTestCancellation(test, commandId, reason) {
    if (!test.cancellationRequest) {
      test.cancellationRequest = Object.freeze({ commandId, reason });
    }
    this.#clearTestTimer(test, 'marker_ack');
    this.#settleMarkerAckBarrier(test, true);
    test.phase = 'cancellation_pending';
    this.#emitSnapshot();
  }

  #finalizeCancelledTest(test, cancellation, safetyPostcondition) {
    const detail = immutableJson({
      reason: cancellation.reason,
      safetyStopped: true,
      queuedMarkerCount: test.nextMarkerIndex,
      acknowledgedMarkerCount: test.acknowledgedMarkerCount,
    });
    this.#clearActiveTest(test);
    const sent = this.#sendTestEvent(test, TEST_EVENT_TYPES.TEST_FAILED, {
      code: ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_CANCELLED,
      detail,
      safetyPostcondition,
    }, cancellation.commandId);
    if (!sent) {
      this.#preemptForSafety('test_cancelled_delivery_failed');
      return false;
    }
    this.#setLastTestOutcome(test, 'cancelled', {
      reason: cancellation.reason,
      safetyStopped: true,
    });
    this.#lastError = null;
    this.#confirmation = 'local_event_sent';
    this.#emitSnapshot();
    return true;
  }

  #completeActiveTest(test, {
    commandId = test.commandId,
    reason = 'test_complete',
  } = {}) {
    if (!this.#isActiveTest(test)) return Promise.resolve(false);
    if (test.pendingFailure) {
      return this.#failActiveTest(test, test.pendingFailure, { commandId });
    }
    if (reason !== 'natural_end') this.#requestTestCancellation(test, commandId, reason);
    if (test.terminalPromise) return test.terminalPromise;
    this.#clearAllTestTimers(test);
    test.phase = 'stopping';
    this.#emitSnapshot();
    let resolveTerminal;
    let rejectTerminal;
    const terminalPromise = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    test.terminalPromise = terminalPromise;
    (async () => {
      try {
        const result = await this.#executeTestSafetyCommand(
          test,
          {
            type: PLAYBACK_COMMAND_TYPES.STOP,
            commandId: this.#nextLocalCommandId(`test-${reason}`),
            runId: test.runId,
          },
          ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.stop,
          `${reason}_stop`,
        );
        if (!this.#isActiveTest(test)) return false;
        const postcondition = stoppedPhysicalPostcondition(result?.postcondition);
        if (!postcondition) {
          throw new OnAirPlaybackAdapterError(
            ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_POSTCONDITION_FAILED,
            { phase: reason, postcondition: result?.postcondition },
          );
        }
        if (test.pendingFailure) throw test.pendingFailure;
        if (test.cancellationRequest) {
          return this.#finalizeCancelledTest(test, test.cancellationRequest, postcondition);
        }

        if (reason === 'natural_end') {
          const acknowledged = await this.#awaitMarkerAcks(test);
          if (!this.#isActiveTest(test) || !acknowledged) return false;
          if (test.pendingFailure) throw test.pendingFailure;
          if (test.cancellationRequest) {
            return this.#finalizeCancelledTest(test, test.cancellationRequest, postcondition);
          }
          const allMarkersAcknowledged = test.nextMarkerIndex === test.markers.length
            && test.acknowledgedMarkerCount === test.markers.length
            && test.pendingMarkerEvents.size === 0;
          if (!allMarkersAcknowledged) {
            throw this.#testMarkerDeliveryError('completion_barrier', {
              expectedMarkerCount: test.markers.length,
              queuedMarkerCount: test.nextMarkerIndex,
              acknowledgedMarkerCount: test.acknowledgedMarkerCount,
              pendingMarkerCount: test.pendingMarkerEvents.size,
            });
          }
          this.#clearActiveTest(test);
          const sent = this.#sendTestEvent(test, TEST_EVENT_TYPES.TEST_COMPLETE, {
            markerCount: test.acknowledgedMarkerCount,
            postcondition: { stopped: true },
          }, commandId);
          if (!sent) {
            this.#preemptForSafety('test_complete_delivery_failed');
            return false;
          }
          this.#setLastTestOutcome(test, 'local_media_completed', {
            reason,
            safetyStopped: true,
          });
          this.#lastError = null;
          this.#confirmation = 'local_event_sent';
          this.#emitSnapshot();
          return true;
        }
        return this.#finalizeCancelledTest(test, { commandId, reason }, postcondition);
      } catch (error) {
        if (!this.#isActiveTest(test)) return false;
        await this.#failActiveTest(test, error, { commandId });
        return false;
      }
    })().then(resolveTerminal, rejectTerminal);
    return terminalPromise;
  }

  async #failActiveTest(test, error, { commandId = test.commandId } = {}) {
    if (!this.#isActiveTest(test)) return false;
    if (test.phase === 'failing') return false;
    this.#clearAllTestTimers(test);
    this.#settleMarkerAckBarrier(test, false);
    test.phase = 'failing';
    const commandCode = stableCode(
      error?.code,
      ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_FIXTURE_UNAVAILABLE,
    );
    let safety;
    try {
      const result = await this.#executeTestSafetyCommand(
        test,
        {
          type: PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
          commandId: this.#nextLocalCommandId('test-failure-safety'),
        },
        ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.emergencyStop,
        'test_failure_emergency_stop',
      );
      if (!this.#isActiveTest(test)) return false;
      const postcondition = stoppedPhysicalPostcondition(result?.postcondition);
      if (!postcondition) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
          result?.postcondition,
        );
      }
      safety = { stopped: true, postcondition };
    } catch (safetyError) {
      if (!this.#isActiveTest(test)) return false;
      safety = { stopped: false, error: safetyError };
    }

    const failureCode = safety.stopped
      ? commandCode
      : ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED;
    const detail = {
      commandCode,
      failure: safeErrorDetail(error),
      safetyStopped: safety.stopped,
      queuedMarkerCount: test.nextMarkerIndex,
      acknowledgedMarkerCount: test.acknowledgedMarkerCount,
      ...(safety.error ? { safety: safeErrorDetail(safety.error) } : {}),
    };
    this.#setLastTestOutcome(test, 'failed', {
      code: failureCode,
      safetyStopped: safety.stopped,
    });
    this.#clearActiveTest(test);
    const sent = this.#sendTestEvent(test, TEST_EVENT_TYPES.TEST_FAILED, {
      code: failureCode,
      detail,
      ...(safety.stopped ? { safetyPostcondition: safety.postcondition } : {}),
    }, commandId);

    if (safety.stopped) {
      if (!sent) {
        this.#preemptForSafety('test_failed_delivery_failed');
        return false;
      }
      this.#lastError = immutableJson({ code: commandCode, detail });
      this.#confirmation = 'local_event_sent';
      this.#emitSnapshot();
      return true;
    }

    this.#safetyLocked = true;
    this.#markUnknown(
      ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
      detail,
    );
    try {
      this.connection.close(4003, 'test_safety_stop_failed');
    } catch {
      // The adapter remains locally safety-locked and unknown.
    }
    return false;
  }

  #handleTestEvidence(test, evidence) {
    if (!this.#isActiveTest(test) || evidence?.runId !== test.runId) return;
    if (evidence.type === PLAYBACK_EVIDENCE_TYPES.ERROR) {
      if (test.phase === 'failing') return;
      const error = new OnAirPlaybackAdapterError(
        stableCode(evidence.code, ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED),
        isRecord(evidence.detail) ? evidence.detail : {},
      );
      this.#queueTestFailure(test, error);
      return;
    }
    if (evidence.type === PLAYBACK_EVIDENCE_TYPES.READY
      && test.phase === 'awaiting_ready') {
      this.#clearTestTimer(test, 'ready');
      this.#deferTestTask(test, () => this.#beginTestPlayback(test));
      return;
    }
    if (evidence.type === PLAYBACK_EVIDENCE_TYPES.PLAYING
      && test.phase === 'play_pending') {
      this.#clearTestTimer(test, 'playing');
      test.phase = 'started';
      const sent = this.#sendTestEvent(test, TEST_EVENT_TYPES.TEST_STARTED);
      if (!sent) {
        this.#preemptForSafety('test_started_delivery_failed');
        return;
      }
      this.#armTestWatchdog(
        test,
        'progress',
        ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.progress,
        ['started'],
        'progress',
      );
      this.#armTestWatchdog(
        test,
        'hard_end',
        test.durationMs + ON_AIR_PLAYBACK_TEST_WATCHDOG_MS.completionGrace,
        ['started'],
        'hard_end',
      );
      this.#noteTestProgress(test, evidence.mediaTime);
      this.#emitDueTestMarkers(test, evidence.mediaTime);
      return;
    }
    if (evidence.type === PLAYBACK_EVIDENCE_TYPES.POSITION) {
      this.#noteTestProgress(test, evidence.mediaTime);
      this.#emitDueTestMarkers(test, evidence.mediaTime);
      return;
    }
    if (evidence.type === PLAYBACK_EVIDENCE_TYPES.ENDED) {
      if (test.phase !== 'started') {
        const error = new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
          { phase: 'test_ended_before_playing' },
        );
        this.#queueTestFailure(test, error);
        return;
      }
      this.#clearTestTimer(test, 'progress');
      this.#clearTestTimer(test, 'hard_end');
      this.#emitDueTestMarkers(test, evidence.mediaTime);
      if (!this.#isActiveTest(test) || test.phase !== 'started') return;
      const mediaTimeMs = Number.isFinite(evidence.mediaTime)
        ? evidence.mediaTime * 1_000
        : null;
      const durationMs = Number.isFinite(evidence.duration)
        ? evidence.duration * 1_000
        : null;
      const fixtureReachedEnd = mediaTimeMs !== null
        && durationMs !== null
        && Math.abs(mediaTimeMs - test.durationMs) <= TEST_COMPLETION_TOLERANCE_MS
        && Math.abs(durationMs - test.durationMs) <= TEST_COMPLETION_TOLERANCE_MS
        && Math.abs(mediaTimeMs - durationMs) <= TEST_COMPLETION_TOLERANCE_MS;
      const allMarkersQueued = test.nextMarkerIndex === test.markers.length;
      if (!fixtureReachedEnd || !allMarkersQueued) {
        const error = new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.TEST_INCOMPLETE,
          {
            expectedDurationMs: test.durationMs,
            mediaTimeMs,
            durationMs,
            expectedMarkerCount: test.markers.length,
            queuedMarkerCount: test.nextMarkerIndex,
          },
        );
        this.#queueTestFailure(test, error);
        return;
      }
      test.phase = 'completion_pending';
      this.#deferTestTask(test, () => this.#completeActiveTest(test, {
        reason: 'natural_end',
      }));
    }
  }

  async #handleEmergency(command) {
    this.#normalEpoch += 1;
    this.#abortCurrentNormal();
    this.#safetyLocked = true;
    this.#clearActiveTest();
    this.#setLocalState('emergency_stopping', 'local_only');
    const emergencyKey = `${command.commandId}\u0000${command.targetConnectionId}`;
    let localCommandId = this.#emergencyLocalIds.get(emergencyKey);
    if (!localCommandId) {
      localCommandId = this.#nextLocalCommandId('wire-emergency');
      this.#emergencyLocalIds.set(emergencyKey, localCommandId);
    }
    try {
      const result = await this.engine.execute({
        type: PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
        commandId: localCommandId,
      });
      const postcondition = result?.postcondition || {};
      if (!postcondition.mediaPaused || !postcondition.sourceDetached
        || !postcondition.autoplayCancelled) {
        throw new OnAirPlaybackAdapterError(
          ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
          postcondition,
        );
      }
      this.#activeEntryId = null;
      this.#activeRunId = null;
      const sent = this.#sendEvent({
        type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
        protocolVersion: ON_AIR_PROTOCOL_VERSION,
        commandId: command.commandId,
        sessionId: command.sessionId,
        monotonicTimeMs: this.#clockNow(),
        postcondition: {
          mediaPaused: true,
          sourceDetached: true,
          autoplayCancelled: true,
        },
      });
      if (sent) {
        this.#lastError = null;
        this.#setLocalState('emergency_stopped_event_sent', 'local_event_sent');
      }
    } catch (error) {
      this.#markUnknown(
        ON_AIR_PLAYBACK_ADAPTER_CODES.LOCAL_SAFETY_STOP_FAILED,
        safeErrorDetail(error),
      );
    }
  }

  #handleEvidence(evidence) {
    if (this.#disposed) return;
    if (this.#activeTest && evidence?.runId === this.#activeTest.runId) {
      this.#handleTestEvidence(this.#activeTest, evidence);
      return;
    }
    if (!this.#activeEntryId || !this.#activeRunId) return;
    if (evidence?.runId !== this.#activeRunId) return;
    const event = evidence.type;
    if (!Object.values(RUN_EVENT_TYPES).includes(event)) return;
    const draft = {
      ...this.#eventBase(ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT, this.#activeLeaseEpoch),
      event,
      entryId: this.#activeEntryId,
      runId: this.#activeRunId,
    };
    finiteField(draft, 'mediaTime', evidence.mediaTime);
    finiteField(draft, 'duration', evidence.duration);
    finiteField(draft, 'readyState', evidence.readyState);
    if (typeof evidence.paused === 'boolean') draft.paused = evidence.paused;
    if (typeof evidence.seeking === 'boolean') draft.seeking = evidence.seeking;
    if (event === RUN_EVENT_TYPES.ERROR) {
      draft.code = stableCode(
        evidence.code,
        ON_AIR_PLAYBACK_ADAPTER_CODES.ENGINE_COMMAND_FAILED,
      );
      if (isRecord(evidence.detail)) draft.detail = evidence.detail;
    }

    const requiredEvidenceMissing = (
      [RUN_EVENT_TYPES.READY, RUN_EVENT_TYPES.POSITION, RUN_EVENT_TYPES.ENDED].includes(event)
      && (!Number.isFinite(draft.mediaTime) || !Number.isFinite(draft.duration))
    ) || (
      [RUN_EVENT_TYPES.PLAYING, RUN_EVENT_TYPES.PAUSED, RUN_EVENT_TYPES.BUFFERING].includes(event)
      && !Number.isFinite(draft.mediaTime)
    );
    if (requiredEvidenceMissing) return;
    this.#sendEvent(draft, { telemetry: TELEMETRY_EVIDENCE.has(event) });
  }
}
