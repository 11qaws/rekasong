import {
  AUXILIARY_CONTROL_COMMAND_TYPES,
  CONTROL_COMMAND_TYPES,
  ON_AIR_MESSAGE_FAMILIES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_SEQUENCE_NAMESPACES,
  ROUTE_COMMAND_TYPES,
  RUN_COMMAND_TYPES,
  SERVER_MESSAGE_TYPES,
  TEST_COMMAND_TYPES,
  TEST_EVENT_TYPES,
  canonicalizeOnAirDisplayState,
  getOnAirSequenceNamespace,
  validateOnAirMessage,
} from './onAirProtocol.js';
import { isSafeOutputControlTakeover } from './outputControlAuthority.js';
import {
  ON_AIR_V2_CONNECTION_CODES,
  ON_AIR_V2_CONNECTION_STATES,
  OnAirV2Connection,
} from './onAirV2Connection.js';
import {
  ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
  ON_AIR_TEST_FIXTURE_ID,
  ON_AIR_TEST_FIXTURE_MAX_DURATION_MS,
  ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
} from './onAirTestFixture.js';

export const ON_AIR_CONTROL_COORDINATOR_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'control_coordinator_invalid_configuration',
  INVALID_ARGUMENT: 'control_coordinator_invalid_argument',
  DISPOSED: 'control_coordinator_disposed',
  CONNECT_ALREADY_ACTIVE: 'control_coordinator_connect_already_active',
  NOT_READY: 'control_coordinator_not_ready',
  NOT_WRITABLE: 'control_coordinator_not_writable',
  SNAPSHOT_UNAVAILABLE: 'control_coordinator_snapshot_unavailable',
  SNAPSHOT_INVALID: 'control_coordinator_snapshot_invalid',
  CONNECTION_LOST: 'control_coordinator_connection_lost',
  OUTCOME_UNKNOWN: 'control_coordinator_outcome_unknown',
  COMMAND_REQUEST_FAILED: 'control_coordinator_command_request_failed',
  OUTGOING_INVALID: 'control_coordinator_outgoing_invalid',
  INVALID_OUTPUT_MODE: 'control_coordinator_invalid_output_mode',
  OUTPUT_CANDIDATE_COUNT: 'control_coordinator_output_candidate_count',
  OUTPUT_LEASE_NOT_INACTIVE: 'control_coordinator_output_lease_not_inactive',
  OUTPUT_NOT_ACTIVE: 'control_coordinator_output_not_active',
  OUTPUT_SWITCH_PENDING: 'control_coordinator_output_switch_pending',
  OUTPUT_NOT_READY: 'control_coordinator_output_not_ready',
  ACTIVE_WORK_PRESENT: 'control_coordinator_active_work_present',
  LOAD_ALREADY_ACTIVE: 'control_coordinator_load_already_active',
  RUN_IDENTITY_REQUIRED: 'control_coordinator_run_identity_required',
  RUN_IDENTITY_UNCONFIRMED: 'control_coordinator_run_identity_unconfirmed',
  RUN_IDENTITY_MISMATCH: 'control_coordinator_run_identity_mismatch',
  UNOWNED_ACTIVE_RUN: 'control_coordinator_unowned_active_run',
  ACTIVE_TEST: 'control_coordinator_active_test',
  TEST_ALREADY_ACTIVE: 'control_coordinator_test_already_active',
  TEST_NOT_ACTIVE: 'control_coordinator_test_not_active',
  TEST_COMMAND_PENDING: 'control_coordinator_test_command_pending',
  TEST_IDENTITY_MISMATCH: 'control_coordinator_test_identity_mismatch',
  TEST_EVENT_INVALID: 'control_coordinator_test_event_invalid',
  TEST_EVENT_STALE: 'control_coordinator_test_event_stale',
  TEST_EVENT_WITHOUT_START: 'control_coordinator_test_event_without_start',
  TEST_EVIDENCE_INTEGRITY: 'control_coordinator_test_evidence_integrity',
  CONTROL_TAKEOVER_PENDING: 'control_coordinator_takeover_pending',
  SESSION_ENDED: 'control_coordinator_session_ended',
  EPOCH_REGRESSION: 'control_coordinator_epoch_regression',
});

const OUTPUT_MODES = new Set(['speaker', 'obs']);
const READY_LEASE_STATES = new Set(['ready', 'audible']);
const CONFIRMED_RUN_STATES = new Set(['ready', 'playing', 'paused', 'buffering', 'ended']);
const ACTIVE_DESIRED_STATES = new Set(['loading', 'playing', 'paused']);
const SESSION_END_ACTIVE_STATES = new Set(['loading', 'playing', 'paused', 'buffering']);
const RUN_TYPES = new Set(Object.values(RUN_COMMAND_TYPES));
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_DIAGNOSTICS = 32;
const MAX_DETAIL_KEYS = 16;
const MAX_DETAIL_ARRAY = 16;
const MAX_DETAIL_STRING = 160;
const MAX_TEST_MARKERS = 64;

function sessionIdFromTransportUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const sessionsIndex = segments.indexOf('sessions');
    if (sessionsIndex < 0 || segments[sessionsIndex + 2] !== 'ws') return null;
    return decodeURIComponent(segments[sessionsIndex + 1]);
  } catch {
    return null;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
}

function boundedValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_DETAIL_STRING);
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ARRAY).map((entry) => boundedValue(entry, depth + 1));
  }
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value)
    .slice(0, MAX_DETAIL_KEYS)
    .map(([key, entry]) => [key.slice(0, 64), boundedValue(entry, depth + 1)]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutable(value) {
  if (value === null || value === undefined) return value ?? null;
  return deepFreeze(structuredClone(value));
}

function stableDetail(value = {}) {
  return deepFreeze(boundedValue(isRecord(value) ? value : {}));
}

function defaultIdFactory(scope) {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new OnAirControlCoordinatorError(
      ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
      { field: 'idFactory', kind: 'secure_identifier_factory' },
    );
  }
  return `${scope}-${globalThis.crypto.randomUUID()}`;
}

function requireConfiguration(condition, field, kind) {
  if (!condition) {
    throw new OnAirControlCoordinatorError(
      ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
      { field, kind },
    );
  }
}

function validationDetail(validation) {
  return {
    family: validation.family,
    errors: validation.errors.slice(0, MAX_DETAIL_ARRAY)
      .map(({ path, code }) => ({ path, code })),
  };
}

function isDesiredTransportObservation(value) {
  if (!isRecord(value) || !isIdentifier(value.status)) return false;
  const entryId = value.entryId ?? null;
  const runId = value.runId ?? null;
  if ((entryId !== null && !isIdentifier(entryId)) || (runId !== null && !isIdentifier(runId))) {
    return false;
  }
  if ((entryId === null) !== (runId === null)) return false;
  if (ACTIVE_DESIRED_STATES.has(value.status) && entryId === null) return false;
  if (value.position !== undefined && (!Number.isFinite(value.position) || value.position < 0)) {
    return false;
  }
  return value.volume === undefined
    || (Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 100);
}

function emptyTestEvidence(generation) {
  return {
    generation,
    started: null,
    markers: [],
    lastTerminal: null,
    lastSequences: {
      [ON_AIR_SEQUENCE_NAMESPACES.TEST]: null,
      [ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY]: null,
    },
  };
}

function isExactStrongStopPostcondition(value) {
  if (!isRecord(value)) return false;
  const fields = Object.keys(value).sort();
  const expected = ['audible', 'autoplayCancelled', 'mediaPaused', 'sourceDetached', 'status'];
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index])
    && value.status === 'stopped'
    && value.mediaPaused === true
    && value.sourceDetached === true
    && value.autoplayCancelled === true
    && value.audible === false;
}

function normalizedTestEvent(frame) {
  const event = {
    event: frame.event,
    eventId: frame.eventId,
    sequence: frame.sequence,
    checkId: frame.checkId,
    leaseEpoch: frame.leaseEpoch,
    playerInstanceId: frame.playerInstanceId,
    connectionId: frame.connectionId,
    monotonicTimeMs: frame.monotonicTimeMs,
    sequenceNamespace: getOnAirSequenceNamespace(frame),
    ...(isIdentifier(frame.commandId) ? { commandId: frame.commandId } : {}),
    ...(Number.isFinite(frame.rmsDbfs) ? { rmsDbfs: frame.rmsDbfs } : {}),
    ...(Number.isFinite(frame.peakDbfs) ? { peakDbfs: frame.peakDbfs } : {}),
  };
  if (frame.event === TEST_EVENT_TYPES.TEST_MARKER) {
    event.markerIndex = frame.markerIndex;
    event.markerTimeMs = frame.markerTimeMs;
  } else if (frame.event === TEST_EVENT_TYPES.TEST_COMPLETE) {
    event.markerCount = frame.markerCount;
    event.postcondition = { stopped: true };
  } else if (frame.event === TEST_EVENT_TYPES.TEST_FAILED) {
    event.code = frame.code;
    if (isRecord(frame.detail)) event.detail = stableDetail(frame.detail);
    if (isRecord(frame.safetyPostcondition)) {
      event.safetyPostcondition = stableDetail(frame.safetyPostcondition);
    }
  }
  return immutable(event);
}

export class OnAirControlCoordinatorError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirControlCoordinatorError';
    this.code = code;
    this.detail = stableDetail(detail);
  }
}

export class OnAirControlCoordinator {
  #connection;
  #sessionId;
  #idFactory;
  #callbacks;
  #subscribers = new Set();
  #connectionState = ON_AIR_V2_CONNECTION_STATES.IDLE;
  #welcome = null;
  #playerSnapshot = null;
  #desiredTransport = null;
  #confirmedPlayback = null;
  #activeRun = null;
  #pendingSwitch = null;
  #pendingTest = null;
  #pendingTakeover = null;
  #connectionGeneration = 0;
  #testEvidence = emptyTestEvidence(0);
  #pendingCommands = new Map();
  #unknownLock = null;
  #snapshotTrusted = false;
  #maxLeaseEpoch = null;
  #maxControlEpoch = null;
  #diagnostics = [];
  #disposed = false;

  constructor({
    transport,
    idFactory = defaultIdFactory,
    connectionFactory = (options) => new OnAirV2Connection(options),
    now,
    setIntervalFn,
    clearIntervalFn,
    callbacks = {},
  } = {}) {
    requireConfiguration(isRecord(transport), 'transport', 'record');
    requireConfiguration(typeof transport.url === 'string' && transport.url.trim().length > 0,
      'transport.url', 'non_empty_string');
    requireConfiguration(typeof transport.webSocketFactory === 'function',
      'transport.webSocketFactory', 'function');
    requireConfiguration(isIdentifier(transport.sessionId), 'transport.sessionId', 'identifier');
    requireConfiguration(isIdentifier(transport.buildId), 'transport.buildId', 'identifier');
    requireConfiguration(transport.capabilities === undefined || isRecord(transport.capabilities),
      'transport.capabilities', 'record');
    requireConfiguration(typeof idFactory === 'function', 'idFactory', 'function');
    requireConfiguration(typeof connectionFactory === 'function', 'connectionFactory', 'function');
    requireConfiguration(isRecord(callbacks), 'callbacks', 'record');
    const urlSessionId = sessionIdFromTransportUrl(transport.url);
    requireConfiguration(urlSessionId === null || urlSessionId === transport.sessionId,
      'transport.sessionId', 'url_session_match');
    for (const name of ['onDiagnostic', 'onCommandResult', 'onStateChange', 'onSnapshot', 'onTestEvent']) {
      requireConfiguration(callbacks[name] === undefined || typeof callbacks[name] === 'function',
        `callbacks.${name}`, 'function');
    }

    this.#sessionId = transport.sessionId;
    this.#idFactory = idFactory;
    this.#callbacks = callbacks;
    let connection;
    try {
      connection = connectionFactory({
        role: 'control',
        url: transport.url,
        webSocketFactory: transport.webSocketFactory,
        buildId: transport.buildId,
        capabilities: transport.capabilities ?? {},
        identity: transport.identity,
        idFactory,
        now,
        setIntervalFn,
        clearIntervalFn,
        onNegotiated: (snapshot) => this.#handleNegotiated(snapshot),
        onFrame: (frame) => this.#handleFrame(frame),
        onCommandResult: (result) => this.#handleCommandResult(result),
        onDiagnostic: (diagnostic) => this.#handleConnectionDiagnostic(diagnostic),
        onStateChange: (change) => this.#handleConnectionState(change),
      });
    } catch (error) {
      if (error instanceof OnAirControlCoordinatorError) throw error;
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
        {
          field: 'connectionFactory',
          causeCode: typeof error?.code === 'string' ? error.code : null,
          causeName: typeof error?.name === 'string' ? error.name : 'Error',
        },
      );
    }
    requireConfiguration(connection && typeof connection === 'object',
      'connectionFactory', 'connection_object');
    for (const method of ['connect', 'close', 'requestCommand', 'snapshot']) {
      requireConfiguration(typeof connection[method] === 'function', `connection.${method}`, 'function');
    }
    requireConfiguration(isRecord(connection.identity)
      && isIdentifier(connection.identity.controlInstanceId),
    'connection.identity', 'control_identity');
    this.#connection = connection;
  }

  get connection() {
    return this.#connection;
  }

  connect() {
    this.#assertUsable();
    if (this.#unknownLock?.code === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
        { operation: 'connect' },
      );
    }
    if (![ON_AIR_V2_CONNECTION_STATES.IDLE, ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
      ON_AIR_V2_CONNECTION_STATES.CLOSED].includes(this.#connectionState)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.CONNECT_ALREADY_ACTIVE,
        { state: this.#connectionState },
      );
    }
    this.#welcome = null;
    this.#playerSnapshot = null;
    this.#desiredTransport = null;
    this.#confirmedPlayback = null;
    this.#snapshotTrusted = false;
    this.#pendingSwitch = null;
    this.#pendingTest = null;
    this.#pendingTakeover = null;
    this.#connectionGeneration += 1;
    this.#testEvidence = emptyTestEvidence(this.#connectionGeneration);
    this.#connectionState = ON_AIR_V2_CONNECTION_STATES.CONNECTING;
    this.#publish();
    return this.#connection.connect();
  }

  close(code, reason) {
    if (this.#disposed) return;
    this.#connection.close(code, reason);
    if (!this.#unknownLock) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST, {
        state: ON_AIR_V2_CONNECTION_STATES.CLOSED,
      });
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.close(1000, 'control_coordinator_disposed');
    this.#disposed = true;
    this.#connectionState = ON_AIR_V2_CONNECTION_STATES.CLOSED;
    this.#publish();
    this.#subscribers.clear();
  }

  subscribe(listener) {
    this.#assertUsable();
    if (typeof listener !== 'function') {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'listener', kind: 'function' },
      );
    }
    this.#subscribers.add(listener);
    listener(this.snapshot());
    return () => this.#subscribers.delete(listener);
  }

  snapshot() {
    const authoritativeReady = this.#connectionState === ON_AIR_V2_CONNECTION_STATES.READY
      && this.#welcome !== null
      && this.#playerSnapshot !== null;
    const writable = authoritativeReady && this.#isWritableObservation();
    const authorityUnknown = Boolean(this.#unknownLock) || !authoritativeReady;
    const routeUnknown = !this.#playerSnapshot
      || ['unknown', 'failed'].includes(this.#playerSnapshot.lease?.status)
      || this.#desiredTransport?.status === 'unknown';
    return immutable({
      state: this.#connectionState,
      disposed: this.#disposed,
      ready: authoritativeReady,
      writable,
      unknown: authorityUnknown,
      authorityUnknown,
      routeUnknown,
      unknownLock: this.#unknownLock,
      welcome: this.#welcome,
      playerSnapshot: this.#playerSnapshot,
      desiredTransport: this.#desiredTransport,
      confirmedPlayback: this.#confirmedPlayback,
      activeRun: this.#activeRun,
      pendingSwitch: this.#pendingSwitch,
      pendingTest: this.#pendingTest,
      pendingTakeover: this.#pendingTakeover,
      testEvidence: this.#testEvidenceSnapshot(),
      pendingCommandIds: [...this.#pendingCommands.keys()].slice(0, 64),
      diagnostics: this.#diagnostics,
      limitation: {
        code: 'snapshot_revision_unavailable',
        orderingGuard: 'lease_and_control_epoch_regression',
      },
    });
  }

  #testEvidenceSnapshot() {
    return {
      generation: this.#testEvidence.generation,
      requested: {
        activeCheckId: this.#playerSnapshot?.activeCheckId ?? null,
        pendingOperation: this.#pendingTest?.operation ?? null,
        pendingCheckId: this.#pendingTest?.checkId ?? null,
      },
      started: this.#testEvidence.started,
      markers: this.#testEvidence.markers,
      lastTerminal: this.#testEvidence.lastTerminal,
      lastSequences: this.#testEvidence.lastSequences,
    };
  }

  #terminalOverridesSnapshotCheck(checkId) {
    const terminal = this.#testEvidence.lastTerminal;
    const lease = this.#playerSnapshot?.lease;
    const stopped = terminal?.event === TEST_EVENT_TYPES.TEST_COMPLETE
      ? terminal.postcondition?.stopped === true
      : terminal?.event === TEST_EVENT_TYPES.TEST_FAILED
        && isExactStrongStopPostcondition(terminal.safetyPostcondition);
    return isIdentifier(checkId)
      && stopped
      && terminal?.checkId === checkId
      && terminal.playerInstanceId === lease?.leaseTarget
      && terminal.leaseEpoch === lease?.epoch;
  }

  #effectiveActiveCheckId() {
    if (this.#testEvidence.started) return this.#testEvidence.started.checkId;
    const activeCheckId = this.#playerSnapshot?.activeCheckId ?? null;
    return this.#terminalOverridesSnapshotCheck(activeCheckId) ? null : activeCheckId;
  }

  #hasActiveTestWork() {
    return Boolean(this.#pendingTest || this.#testEvidence.started || this.#effectiveActiveCheckId());
  }

  activateOutput(mode) {
    this.#assertCommandable();
    if (!OUTPUT_MODES.has(mode)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_OUTPUT_MODE,
        { mode },
      );
    }
    if (this.#pendingSwitch) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
        { switchId: this.#pendingSwitch.switchId, operation: this.#pendingSwitch.operation },
      );
    }
    if (this.#activeRun || this.#playerSnapshot.activeFamily || this.#hasActiveTestWork()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
        {
          activeFamily: this.#playerSnapshot.activeFamily,
          activeCheckId: this.#effectiveActiveCheckId(),
          localRunPresent: Boolean(this.#activeRun),
          pendingTest: this.#pendingTest?.operation ?? null,
        },
      );
    }
    const lease = this.#playerSnapshot.lease;
    if (lease.status !== 'inactive' || lease.leaseTarget !== null) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_LEASE_NOT_INACTIVE,
        { status: lease.status, leaseTarget: lease.leaseTarget },
      );
    }
    const candidates = this.#playerSnapshot.eligibleCandidates[mode];
    if (candidates.length !== 1) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_CANDIDATE_COUNT,
        { mode, count: candidates.length, candidates: candidates.slice(0, 8) },
      );
    }
    const switchId = this.#newId('output-switch');
    const command = {
      type: ROUTE_COMMAND_TYPES.ACTIVATE,
      commandId: this.#newId('control-command'),
      switchId,
      leaseEpoch: lease.epoch,
      targetPlayerInstanceId: candidates[0],
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload: { outputMode: mode },
    };
    this.#pendingSwitch = immutable({
      operation: 'activate',
      switchId,
      commandId: command.commandId,
      mode,
      targetPlayerInstanceId: candidates[0],
    });
    try {
      return this.#request(command, { kind: 'activate', switchId });
    } catch (error) {
      if (!this.#unknownLock) this.#pendingSwitch = null;
      throw error;
    }
  }

  deactivateOutput() {
    this.#assertSafetyCommandable();
    const lease = this.#playerSnapshot.lease;
    const pendingActivationCanBeSuperseded = this.#pendingSwitch?.operation === 'activate'
      && lease.leaseTarget === this.#pendingSwitch.targetPlayerInstanceId
      && lease.switchId === this.#pendingSwitch.switchId
      && ['activating', 'ready', 'audible', 'unknown', 'failed'].includes(lease.status);
    if (this.#pendingSwitch && !pendingActivationCanBeSuperseded) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
        { switchId: this.#pendingSwitch.switchId, operation: this.#pendingSwitch.operation },
      );
    }
    if (!lease.leaseTarget || !isIdentifier(lease.switchId)
      || !['activating', 'ready', 'audible', 'deactivating', 'unknown', 'failed']
        .includes(lease.status)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_NOT_ACTIVE,
        { status: lease.status, leaseTarget: lease.leaseTarget, switchId: lease.switchId },
      );
    }
    const switchId = this.#newId('output-switch');
    const command = {
      type: ROUTE_COMMAND_TYPES.DEACTIVATE,
      commandId: this.#newId('control-command'),
      switchId,
      leaseEpoch: lease.epoch,
      targetPlayerInstanceId: lease.leaseTarget,
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload: {},
    };
    this.#pendingSwitch = immutable({
      operation: 'deactivate',
      switchId,
      commandId: command.commandId,
      targetPlayerInstanceId: lease.leaseTarget,
    });
    try {
      return this.#request(command, { kind: 'deactivate', switchId });
    } catch (error) {
      if (!this.#unknownLock) this.#pendingSwitch = null;
      throw error;
    }
  }

  load({ entryId: suppliedEntryId, runId: suppliedRunId, song, position = 0, volume } = {}) {
    this.#assertRunLeaseReady();
    if (this.#hasActiveTestWork()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
        {
          activeCheckId: this.#effectiveActiveCheckId(),
          pendingOperation: this.#pendingTest?.operation ?? null,
          startedCheckId: this.#testEvidence.started?.checkId ?? null,
        },
      );
    }
    if (this.#playerSnapshot.activeFamily || this.#activeRun) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.LOAD_ALREADY_ACTIVE,
        {
          activeFamily: this.#playerSnapshot.activeFamily,
          localRunPresent: Boolean(this.#activeRun),
        },
      );
    }
    const callerIdentityPresent = suppliedEntryId !== undefined || suppliedRunId !== undefined;
    if (callerIdentityPresent
      && (!isIdentifier(suppliedEntryId) || !isIdentifier(suppliedRunId))) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        {
          field: 'load.identity',
          kind: 'paired_identifiers',
          entryIdPresent: suppliedEntryId !== undefined,
          runIdPresent: suppliedRunId !== undefined,
        },
      );
    }
    if (!isRecord(song) || !Number.isFinite(position) || position < 0
      || (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 100))) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'load', kind: 'song_position_volume' },
      );
    }
    const entryId = callerIdentityPresent ? suppliedEntryId : this.#newId('entry');
    const runId = callerIdentityPresent ? suppliedRunId : this.#newId('run');
    const lease = this.#playerSnapshot.lease;
    const command = {
      type: RUN_COMMAND_TYPES.LOAD,
      commandId: this.#newId('control-command'),
      entryId,
      runId,
      leaseEpoch: lease.epoch,
      targetPlayerInstanceId: lease.leaseTarget,
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload: {
        song: immutable(song),
        position,
        ...(volume === undefined ? {} : { volume }),
      },
    };
    this.#activeRun = immutable({
      entryId,
      runId,
      targetPlayerInstanceId: lease.leaseTarget,
      leaseEpoch: lease.epoch,
      loadCommandId: command.commandId,
      acknowledged: false,
      observed: false,
    });
    try {
      return this.#request(command, { kind: 'load', entryId, runId });
    } catch (error) {
      if (!this.#unknownLock) this.#activeRun = null;
      throw error;
    }
  }

  play() {
    return this.#runCommand(RUN_COMMAND_TYPES.PLAY, {});
  }

  pause() {
    return this.#runCommand(RUN_COMMAND_TYPES.PAUSE, {});
  }

  seek(position) {
    if (!Number.isFinite(position) || position < 0) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'position', min: 0 },
      );
    }
    return this.#runCommand(RUN_COMMAND_TYPES.SEEK, { position });
  }

  setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'volume', min: 0, max: 100 },
      );
    }
    return this.#runCommand(RUN_COMMAND_TYPES.VOLUME, { volume });
  }

  stop() {
    return this.#runCommand(RUN_COMMAND_TYPES.STOP, {}, { allowUnconfirmed: true });
  }

  startTest({
    fixtureId = ON_AIR_TEST_FIXTURE_ID,
    durationMs = ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
  } = {}) {
    this.#assertRunLeaseReady({ allowActiveCheck: true });
    if (!isIdentifier(fixtureId) || !Number.isSafeInteger(durationMs)
      || durationMs < ON_AIR_TEST_FIXTURE_MIN_DURATION_MS
      || durationMs > ON_AIR_TEST_FIXTURE_MAX_DURATION_MS) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        {
          field: 'test',
          kind: 'fixture_duration',
          minDurationMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
          maxDurationMs: ON_AIR_TEST_FIXTURE_MAX_DURATION_MS,
        },
      );
    }
    if (this.#pendingTest) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_COMMAND_PENDING,
        { operation: this.#pendingTest.operation, checkId: this.#pendingTest.checkId },
      );
    }
    const activeCheckId = this.#effectiveActiveCheckId();
    if (activeCheckId) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_ALREADY_ACTIVE,
        { activeCheckId },
      );
    }
    if (this.#playerSnapshot.activeFamily || this.#activeRun) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
        {
          activeFamily: this.#playerSnapshot.activeFamily,
          localRunPresent: Boolean(this.#activeRun),
        },
      );
    }
    const lease = this.#playerSnapshot.lease;
    const checkId = this.#newId('check');
    const command = {
      type: TEST_COMMAND_TYPES.START,
      commandId: this.#newId('control-command'),
      checkId,
      leaseEpoch: lease.epoch,
      targetPlayerInstanceId: lease.leaseTarget,
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload: { fixtureId, durationMs },
    };
    this.#pendingTest = immutable({ operation: 'start', checkId, commandId: command.commandId });
    try {
      return this.#request(command, { kind: 'startTest', checkId });
    } catch (error) {
      if (!this.#unknownLock) this.#pendingTest = null;
      throw error;
    }
  }

  stopTest() {
    this.#assertRunLeaseReady({ allowActiveCheck: true });
    if (this.#pendingTest) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_COMMAND_PENDING,
        { operation: this.#pendingTest.operation, checkId: this.#pendingTest.checkId },
      );
    }
    const checkId = this.#effectiveActiveCheckId();
    if (!isIdentifier(checkId)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_NOT_ACTIVE,
        {},
      );
    }
    const lease = this.#playerSnapshot.lease;
    const command = {
      type: TEST_COMMAND_TYPES.STOP,
      commandId: this.#newId('control-command'),
      checkId,
      leaseEpoch: lease.epoch,
      targetPlayerInstanceId: lease.leaseTarget,
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload: {},
    };
    this.#pendingTest = immutable({ operation: 'stop', checkId, commandId: command.commandId });
    try {
      return this.#request(command, { kind: 'stopTest', checkId });
    } catch (error) {
      if (!this.#unknownLock) this.#pendingTest = null;
      throw error;
    }
  }

  emergencyStop() {
    this.#assertEmergencyCommandable();
    const command = {
      type: ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP,
      commandId: this.#newId('control-command'),
      sessionId: this.#sessionId,
      authenticatedControlInstanceId: this.#connection.identity.controlInstanceId,
    };
    return this.#request(command, { kind: 'emergencyStop' });
  }

  takeOverControl() {
    this.#assertUsable();
    if (this.#connectionState !== ON_AIR_V2_CONNECTION_STATES.READY
      || !this.#welcome || !this.#playerSnapshot || !this.#snapshotTrusted) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_READY,
        { state: this.#connectionState, snapshotTrusted: this.#snapshotTrusted },
      );
    }
    if (this.#isWritableObservation()) {
      return immutable({ status: 'already_owner' });
    }
    if (this.#unknownLock) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
        { lockCode: this.#unknownLock.code },
      );
    }
    if (this.#pendingTakeover?.status === 'pending') {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.CONTROL_TAKEOVER_PENDING,
        { commandId: this.#pendingTakeover.commandId },
      );
    }

    const lease = this.#playerSnapshot.lease;
    const desiredStatus = this.#desiredTransport?.status ?? null;
    const safeToTransfer = isSafeOutputControlTakeover(this.snapshot());
    if (!safeToTransfer) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
        {
          operation: CONTROL_COMMAND_TYPES.TAKEOVER,
          leaseStatus: lease?.status ?? null,
          desiredStatus,
          activeRun: Boolean(this.#activeRun || this.#playerSnapshot.activeFamily),
          activeTest: Boolean(this.#pendingTest || this.#playerSnapshot.activeCheckId),
        },
      );
    }

    const controlInstanceId = this.#connection.identity.controlInstanceId;
    const command = {
      type: CONTROL_COMMAND_TYPES.TAKEOVER,
      commandId: this.#newId('control-command'),
      controlInstanceId,
      expectedControlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
    };
    this.#pendingTakeover = immutable({
      status: 'pending',
      commandId: command.commandId,
      expectedControlEpoch: command.expectedControlEpoch,
      reasonCode: null,
    });
    try {
      return this.#request(command, { kind: 'takeover' });
    } catch (error) {
      this.#pendingTakeover = immutable({
        status: 'failed',
        commandId: command.commandId,
        expectedControlEpoch: command.expectedControlEpoch,
        reasonCode: error?.code || ON_AIR_CONTROL_COORDINATOR_CODES.COMMAND_REQUEST_FAILED,
      });
      this.#publish();
      throw error;
    }
  }

  endSession(options) {
    if (options !== undefined) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'endSession', kind: 'no_arguments' },
      );
    }
    this.#assertCommandable();
    const leaseStatus = this.#playerSnapshot.lease.status;
    const desiredStatus = this.#desiredTransport?.status ?? null;
    const confirmedStatus = this.#confirmedPlayback?.status ?? null;
    if (this.#pendingSwitch || this.#activeRun || this.#playerSnapshot.activeFamily
      || this.#hasActiveTestWork()
      || !['inactive', 'ready'].includes(leaseStatus)
      || SESSION_END_ACTIVE_STATES.has(desiredStatus)
      || SESSION_END_ACTIVE_STATES.has(confirmedStatus)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_WORK_PRESENT,
        {
          operation: AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION,
          leaseStatus,
          desiredStatus,
          confirmedStatus,
          pendingSwitch: Boolean(this.#pendingSwitch),
          activeRun: Boolean(this.#activeRun || this.#playerSnapshot.activeFamily),
          activeTest: this.#hasActiveTestWork(),
        },
      );
    }
    return this.#auxiliaryCommand(AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION, {});
  }

  publishDisplayState(display) {
    const canonical = canonicalizeOnAirDisplayState(display);
    if (!canonical.ok) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        {
          field: 'display',
          kind: 'bounded_json_record',
          errors: canonical.errors,
          bytes: canonical.bytes,
        },
      );
    }
    return this.#auxiliaryCommand(
      AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE,
      { display: canonical.value },
    );
  }

  prefetch(videoIds) {
    if (!Array.isArray(videoIds) || videoIds.length > 2
      || videoIds.some((videoId) => typeof videoId !== 'string'
        || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId))) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'videoIds', kind: 'youtube_video_id_array', maxItems: 2 },
      );
    }
    return this.#auxiliaryCommand(
      AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH,
      { videoIds: [...videoIds] },
    );
  }

  #auxiliaryCommand(type, payload) {
    this.#assertCommandable();
    const command = {
      type,
      commandId: this.#newId('control-command'),
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload,
    };
    return this.#request(command, { kind: 'auxiliary', type });
  }

  #runCommand(type, payload, { allowUnconfirmed = false } = {}) {
    this.#assertRunLeaseReady();
    if (this.#hasActiveTestWork()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
        {
          activeCheckId: this.#effectiveActiveCheckId(),
          pendingOperation: this.#pendingTest?.operation ?? null,
          startedCheckId: this.#testEvidence.started?.checkId ?? null,
        },
      );
    }
    if (!RUN_TYPES.has(type) || type === RUN_COMMAND_TYPES.LOAD) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_ARGUMENT,
        { field: 'type', type },
      );
    }
    const run = this.#activeRun;
    if (!run) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_REQUIRED,
        {},
      );
    }
    const lease = this.#playerSnapshot.lease;
    const familyMatches = this.#playerSnapshot.activeFamily?.entryId === run.entryId
      && this.#playerSnapshot.activeFamily?.runId === run.runId;
    const confirmedMatches = this.#confirmedPlayback?.entryId === run.entryId
      && this.#confirmedPlayback?.runId === run.runId
      && this.#confirmedPlayback?.playerInstanceId === run.targetPlayerInstanceId
      && this.#confirmedPlayback?.leaseEpoch === run.leaseEpoch
      && CONFIRMED_RUN_STATES.has(this.#confirmedPlayback?.status);
    if (!familyMatches || (!allowUnconfirmed && !confirmedMatches)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_UNCONFIRMED,
        {
          familyMatches,
          confirmedMatches,
          desiredStatus: this.#desiredTransport?.status ?? null,
          confirmedStatus: this.#confirmedPlayback?.status ?? null,
        },
      );
    }
    if (lease.leaseTarget !== run.targetPlayerInstanceId || lease.epoch !== run.leaseEpoch) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_MISMATCH,
        {
          expectedTarget: run.targetPlayerInstanceId,
          actualTarget: lease.leaseTarget,
          expectedEpoch: run.leaseEpoch,
          actualEpoch: lease.epoch,
        },
      );
    }
    const command = {
      type,
      commandId: this.#newId('control-command'),
      entryId: run.entryId,
      runId: run.runId,
      leaseEpoch: run.leaseEpoch,
      targetPlayerInstanceId: run.targetPlayerInstanceId,
      controlEpoch: this.#playerSnapshot.controlLease.controlEpoch,
      payload,
    };
    return this.#request(command, { kind: 'run', type, entryId: run.entryId, runId: run.runId });
  }

  #assertUsable() {
    if (this.#disposed) {
      throw new OnAirControlCoordinatorError(ON_AIR_CONTROL_COORDINATOR_CODES.DISPOSED, {});
    }
  }

  #assertCommandable() {
    this.#assertUsable();
    if (this.#unknownLock) {
      if (this.#unknownLock.code === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED) {
        throw new OnAirControlCoordinatorError(
          ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
          { operation: 'command' },
        );
      }
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
        { lockCode: this.#unknownLock.code },
      );
    }
    if (this.#connectionState !== ON_AIR_V2_CONNECTION_STATES.READY
      || !this.#welcome || !this.#playerSnapshot) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_READY,
        { state: this.#connectionState },
      );
    }
    if (!this.#isWritableObservation()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_WRITABLE,
        {
          welcomeWritable: this.#welcome.writable,
          observedOwner: this.#playerSnapshot.controlLease.writableControlInstanceId,
        },
      );
    }
  }

  #assertSafetyCommandable() {
    this.#assertUsable();
    if (this.#connectionState !== ON_AIR_V2_CONNECTION_STATES.READY
      || !this.#welcome || !this.#playerSnapshot || !this.#snapshotTrusted) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_READY,
        { state: this.#connectionState, snapshotTrusted: this.#snapshotTrusted },
      );
    }
    if (!this.#isWritableObservation()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_WRITABLE,
        {
          welcomeWritable: this.#welcome.writable,
          observedOwner: this.#playerSnapshot.controlLease.writableControlInstanceId,
        },
      );
    }
  }

  #assertEmergencyCommandable() {
    this.#assertUsable();
    const controlInstanceId = this.#connection.identity.controlInstanceId;
    if (this.#connectionState !== ON_AIR_V2_CONNECTION_STATES.READY
      || !this.#welcome || this.#welcome.controlInstanceId !== controlInstanceId) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.NOT_READY,
        { state: this.#connectionState, selfWelcome: this.#welcome?.controlInstanceId === controlInstanceId },
      );
    }
  }

  #assertRunLeaseReady({ allowActiveCheck = false } = {}) {
    this.#assertCommandable();
    if (this.#pendingSwitch) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_SWITCH_PENDING,
        { switchId: this.#pendingSwitch.switchId, operation: this.#pendingSwitch.operation },
      );
    }
    if (!allowActiveCheck && this.#hasActiveTestWork()) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.ACTIVE_TEST,
        {
          activeCheckId: this.#effectiveActiveCheckId(),
          pendingOperation: this.#pendingTest?.operation ?? null,
          startedCheckId: this.#testEvidence.started?.checkId ?? null,
        },
      );
    }
    const lease = this.#playerSnapshot.lease;
    if (!READY_LEASE_STATES.has(lease.status) || !isIdentifier(lease.leaseTarget)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_NOT_READY,
        { status: lease.status, leaseTarget: lease.leaseTarget },
      );
    }
  }

  #isWritableObservation() {
    const controlInstanceId = this.#connection.identity.controlInstanceId;
    const lease = this.#playerSnapshot?.controlLease;
    return this.#welcome?.writable === true
      && this.#welcome.controlInstanceId === controlInstanceId
      && this.#welcome.writableControlInstanceId === controlInstanceId
      && lease?.writableControlInstanceId === controlInstanceId
      && lease?.writableConnected === true
      && lease?.controlEpoch === this.#welcome.controlEpoch;
  }

  #newId(scope) {
    let value;
    try {
      value = this.#idFactory(scope);
    } catch (error) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
        {
          field: 'idFactory',
          causeCode: typeof error?.code === 'string' ? error.code : null,
          causeName: typeof error?.name === 'string' ? error.name : 'Error',
        },
      );
    }
    if (!isIdentifier(value)) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.INVALID_CONFIGURATION,
        { field: 'idFactory', scope, kind: 'identifier' },
      );
    }
    return value;
  }

  #request(command, metadata) {
    const validation = validateOnAirMessage(command);
    if (!validation.ok) {
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.OUTGOING_INVALID,
        validationDetail(validation),
      );
    }
    this.#pendingCommands.set(command.commandId, immutable(metadata));
    let result;
    try {
      result = this.#connection.requestCommand(command);
    } catch (error) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.COMMAND_REQUEST_FAILED, {
        commandId: command.commandId,
        causeCode: typeof error?.code === 'string' ? error.code : null,
        causeName: typeof error?.name === 'string' ? error.name : 'Error',
      });
      throw new OnAirControlCoordinatorError(
        ON_AIR_CONTROL_COORDINATOR_CODES.COMMAND_REQUEST_FAILED,
        { commandId: command.commandId },
      );
    }
    if (result?.status === 'outcome_unknown' || result?.entry?.state === 'outcome_unknown') {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN, {
        commandId: command.commandId,
      });
    }
    this.#publish();
    return immutable({ command, result });
  }

  #handleNegotiated(connectionSnapshot) {
    const welcome = connectionSnapshot?.welcome;
    const validation = validateOnAirMessage(welcome);
    if (!validation.ok || validation.family !== ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME) {
      this.#lockUnknown(
        ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID,
        validationDetail(validation),
      );
      return;
    }
    if (welcome.controlInstanceId !== this.#connection.identity.controlInstanceId) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID, {
        field: 'controlInstanceId', code: 'identity_mismatch',
      });
      return;
    }
    if (this.#maxControlEpoch !== null && welcome.controlEpoch < this.#maxControlEpoch) {
      this.#snapshotTrusted = false;
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.EPOCH_REGRESSION, {
        field: 'welcome.controlEpoch',
        previous: this.#maxControlEpoch,
        actual: welcome.controlEpoch,
      });
      return;
    }
    this.#maxControlEpoch = Math.max(this.#maxControlEpoch ?? 0, welcome.controlEpoch);
    this.#welcome = immutable(welcome);
    this.#connectionState = ON_AIR_V2_CONNECTION_STATES.READY;
    this.#publish();
  }

  #rejectTestEvent(code, frame, detail = {}, {
    lockUnknown = false,
    lockCode = ON_AIR_CONTROL_COORDINATOR_CODES.TEST_IDENTITY_MISMATCH,
  } = {}) {
    const diagnosticDetail = {
      event: typeof frame?.event === 'string' ? frame.event : null,
      eventId: typeof frame?.eventId === 'string' ? frame.eventId : null,
      checkId: typeof frame?.checkId === 'string' ? frame.checkId : null,
      sequence: Number.isSafeInteger(frame?.sequence) ? frame.sequence : null,
      ...detail,
    };
    if (lockUnknown) {
      this.#lockUnknown(lockCode, diagnosticDetail);
      return;
    }
    this.#recordDiagnostic(code, diagnosticDetail);
    this.#publish();
  }

  #handleTestEvent(frame) {
    if (!this.#snapshotTrusted || !this.#playerSnapshot
      || this.#connectionState !== ON_AIR_V2_CONNECTION_STATES.READY) {
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        { reason: 'untrusted_snapshot_fence', generation: this.#connectionGeneration },
      );
      return;
    }

    const lease = this.#playerSnapshot.lease;
    const pendingCheckId = this.#pendingTest?.checkId ?? null;
    const snapshotCheckId = this.#effectiveActiveCheckId();
    const started = this.#testEvidence.started;
    const expectedCheckIds = new Set(
      [pendingCheckId, snapshotCheckId, started?.checkId].filter(isIdentifier),
    );
    if (expectedCheckIds.size === 0) {
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        { reason: 'no_requested_test' },
      );
      return;
    }
    if (!expectedCheckIds.has(frame.checkId)) {
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        { reason: 'foreign_check', expectedCheckIds: [...expectedCheckIds] },
        { lockUnknown: true },
      );
      return;
    }
    if (frame.playerInstanceId !== lease.leaseTarget || frame.leaseEpoch !== lease.epoch) {
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        {
          reason: 'foreign_lease_target',
          expectedPlayerInstanceId: lease.leaseTarget,
          actualPlayerInstanceId: frame.playerInstanceId,
          expectedLeaseEpoch: lease.epoch,
          actualLeaseEpoch: frame.leaseEpoch,
        },
        { lockUnknown: true },
      );
      return;
    }
    const currentPlayerRecords = this.#playerSnapshot.players
      .filter((player) => player.playerInstanceId === frame.playerInstanceId);
    if (currentPlayerRecords.length > 0
      && !currentPlayerRecords.some((player) => player.connectionId === frame.connectionId)) {
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        { reason: 'foreign_player_connection' },
        { lockUnknown: true },
      );
      return;
    }
    const sequenceNamespace = getOnAirSequenceNamespace(frame);
    const startsNewCheck = frame.event === TEST_EVENT_TYPES.TEST_STARTED && !started;
    const previousSequence = startsNewCheck
      ? null
      : this.#testEvidence.lastSequences[sequenceNamespace];
    if (previousSequence !== null && frame.sequence !== previousSequence + 1) {
      const sequenceGap = frame.sequence > previousSequence + 1;
      this.#rejectTestEvent(
        ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
        frame,
        {
          reason: sequenceGap
            ? 'sequence_gap'
            : frame.sequence === previousSequence
              ? 'duplicate_sequence'
              : 'out_of_order_sequence',
          sequenceNamespace,
          previousSequence,
          expectedSequence: previousSequence + 1,
        },
        sequenceGap
          ? {
              lockUnknown: true,
              lockCode: ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVIDENCE_INTEGRITY,
            }
          : undefined,
      );
      return;
    }

    const normalized = normalizedTestEvent(frame);
    if (frame.event === TEST_EVENT_TYPES.TEST_STARTED) {
      if (started) {
        this.#rejectTestEvent(
          ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
          frame,
          { reason: 'duplicate_started_transition', startedCheckId: started.checkId },
          { lockUnknown: true },
        );
        return;
      }
      this.#testEvidence = {
        ...this.#testEvidence,
        started: normalized,
        markers: [],
        lastSequences: {
          [ON_AIR_SEQUENCE_NAMESPACES.TEST]: frame.sequence,
          [ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY]: null,
        },
      };
      if (this.#pendingTest?.operation === 'start'
        && this.#pendingTest.checkId === frame.checkId) this.#pendingTest = null;
    } else {
      if (!started) {
        this.#rejectTestEvent(
          ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_WITHOUT_START,
          frame,
          { reason: 'actual_start_not_observed' },
        );
        return;
      }
      const sameStartedIdentity = started.checkId === frame.checkId
        && started.playerInstanceId === frame.playerInstanceId
        && started.connectionId === frame.connectionId
        && started.leaseEpoch === frame.leaseEpoch;
      if (!sameStartedIdentity) {
        this.#rejectTestEvent(
          ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
          frame,
          { reason: 'started_identity_mismatch' },
          { lockUnknown: true },
        );
        return;
      }
      if (frame.event === TEST_EVENT_TYPES.TEST_MARKER) {
        const previousMarker = this.#testEvidence.markers.at(-1);
        const expectedMarkerIndex = previousMarker ? previousMarker.markerIndex + 1 : 0;
        if (frame.markerIndex !== expectedMarkerIndex
          || (previousMarker && frame.markerTimeMs < previousMarker.markerTimeMs)) {
          const markerGap = frame.markerIndex > expectedMarkerIndex;
          this.#rejectTestEvent(
            ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
            frame,
            {
              reason: markerGap ? 'marker_gap' : 'out_of_order_marker',
              expectedMarkerIndex,
              previousMarkerIndex: previousMarker?.markerIndex ?? null,
              previousMarkerTimeMs: previousMarker?.markerTimeMs ?? null,
            },
            markerGap
              ? {
                  lockUnknown: true,
                  lockCode: ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVIDENCE_INTEGRITY,
                }
              : undefined,
          );
          return;
        }
        this.#testEvidence = {
          ...this.#testEvidence,
          markers: [...this.#testEvidence.markers, normalized].slice(-MAX_TEST_MARKERS),
          lastSequences: {
            ...this.#testEvidence.lastSequences,
            [sequenceNamespace]: frame.sequence,
          },
        };
      } else {
        if (frame.event === TEST_EVENT_TYPES.TEST_COMPLETE
          && (this.#testEvidence.markers.length === 0
            || frame.markerCount !== this.#testEvidence.markers.length)) {
          this.#rejectTestEvent(
            ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_STALE,
            frame,
            {
              reason: 'marker_count_mismatch',
              expectedMarkerCount: this.#testEvidence.markers.length,
              actualMarkerCount: frame.markerCount,
            },
            {
              lockUnknown: true,
              lockCode: ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVIDENCE_INTEGRITY,
            },
          );
          return;
        }
        this.#testEvidence = {
          ...this.#testEvidence,
          started: null,
          lastTerminal: normalized,
          lastSequences: {
            ...this.#testEvidence.lastSequences,
            [sequenceNamespace]: frame.sequence,
          },
        };
        if (this.#pendingTest?.checkId === frame.checkId) this.#pendingTest = null;
      }
    }

    const callbackPayload = immutable({
      event: normalized,
      testEvidence: this.#testEvidenceSnapshot(),
    });
    this.#call('onTestEvent', callbackPayload);
    this.#publish();
  }

  #handleFrame(frame) {
    const validation = validateOnAirMessage(frame);
    if (!validation.ok) {
      if (frame?.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT) {
        this.#rejectTestEvent(
          ON_AIR_CONTROL_COORDINATOR_CODES.TEST_EVENT_INVALID,
          frame,
          validationDetail(validation),
        );
        return;
      }
      if (frame?.type === SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT
        || frame?.type === SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT) {
        if (frame?.type === SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT) this.#snapshotTrusted = false;
        this.#lockUnknown(
          ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID,
          { sourceType: frame?.type ?? null, ...validationDetail(validation) },
        );
      }
      return;
    }
    if (frame.type === ON_AIR_MESSAGE_TYPES.TEST_EVENT) {
      this.#handleTestEvent(frame);
      return;
    }
    if (frame.type === SERVER_MESSAGE_TYPES.SESSION_ENDED) {
      this.#snapshotTrusted = false;
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED, {
        reasonCode: frame.reasonCode,
        cleanupAt: frame.cleanupAt,
      });
      this.#connection.close(1000, 'session_ended');
      return;
    }
    if (frame.type === SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT) {
      if (!isDesiredTransportObservation(frame.desiredTransport)) {
        this.#snapshotTrusted = false;
        this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID, {
          sourceType: frame.type,
          field: 'desiredTransport',
          code: 'invalid_desired_transport',
        });
        return;
      }
      const regressedLease = this.#maxLeaseEpoch !== null
        && frame.lease.epoch < this.#maxLeaseEpoch;
      const regressedControl = this.#maxControlEpoch !== null
        && frame.controlLease.controlEpoch < this.#maxControlEpoch;
      if (regressedLease || regressedControl) {
        this.#snapshotTrusted = false;
        this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.EPOCH_REGRESSION, {
          field: regressedLease ? 'lease.epoch' : 'controlLease.controlEpoch',
          previous: regressedLease ? this.#maxLeaseEpoch : this.#maxControlEpoch,
          actual: regressedLease ? frame.lease.epoch : frame.controlLease.controlEpoch,
        });
        return;
      }
      this.#maxLeaseEpoch = Math.max(this.#maxLeaseEpoch ?? 0, frame.lease.epoch);
      this.#maxControlEpoch = Math.max(
        this.#maxControlEpoch ?? 0,
        frame.controlLease.controlEpoch,
      );
      this.#playerSnapshot = immutable(frame);
      this.#desiredTransport = immutable(frame.desiredTransport);
      this.#confirmedPlayback = immutable(frame.confirmedPlayback);
      this.#snapshotTrusted = true;
      this.#reconcileAuthoritativeState();
      this.#publish();
      return;
    }
    if (frame.type === SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT) {
      if (!isDesiredTransportObservation(frame.desiredTransport)) {
        this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID, {
          sourceType: frame.type,
          field: 'desiredTransport',
          code: 'invalid_desired_transport',
        });
        return;
      }
      this.#desiredTransport = immutable(frame.desiredTransport);
      this.#reconcileAuthoritativeState();
      this.#publish();
    }
  }

  #reconcileAuthoritativeState() {
    const lease = this.#playerSnapshot?.lease;
    if (!lease) return;
    if (this.#pendingSwitch?.operation === 'activate'
      && lease.switchId === this.#pendingSwitch.switchId
      && lease.leaseTarget === this.#pendingSwitch.targetPlayerInstanceId
      && ['ready', 'audible', 'failed', 'unknown'].includes(lease.status)) {
      this.#pendingSwitch = null;
    } else if (this.#pendingSwitch?.operation === 'deactivate') {
      const matchingDeactivation = lease.switchId === this.#pendingSwitch.switchId
        && lease.leaseTarget === this.#pendingSwitch.targetPlayerInstanceId;
      if ((lease.status === 'inactive' && lease.leaseTarget === null && lease.switchId === null)
        || (matchingDeactivation && ['unknown', 'failed'].includes(lease.status))) {
        this.#pendingSwitch = null;
      }
    }

    const activeFamily = this.#playerSnapshot.activeFamily;
    if (!this.#activeRun && activeFamily) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.UNOWNED_ACTIVE_RUN, {
        entryId: activeFamily.entryId,
        runId: activeFamily.runId,
      });
      return;
    }
    if (this.#activeRun && activeFamily
      && (activeFamily.entryId !== this.#activeRun.entryId
        || activeFamily.runId !== this.#activeRun.runId
        || lease.leaseTarget !== this.#activeRun.targetPlayerInstanceId
        || lease.epoch !== this.#activeRun.leaseEpoch)) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.RUN_IDENTITY_MISMATCH, {
        expectedEntryId: this.#activeRun.entryId,
        expectedRunId: this.#activeRun.runId,
        actualEntryId: activeFamily.entryId,
        actualRunId: activeFamily.runId,
        expectedTarget: this.#activeRun.targetPlayerInstanceId,
        actualTarget: lease.leaseTarget,
        expectedEpoch: this.#activeRun.leaseEpoch,
        actualEpoch: lease.epoch,
      });
      return;
    }
    if (this.#activeRun && activeFamily && !this.#activeRun.observed) {
      this.#activeRun = immutable({ ...this.#activeRun, observed: true });
    }
    if (this.#activeRun && activeFamily === null
      && (lease.status === 'inactive' || this.#isStrongStoppedObservation(this.#activeRun))) {
      this.#activeRun = null;
    }

    const rawActiveCheckId = this.#playerSnapshot.activeCheckId;
    if (this.#testEvidence.started && rawActiveCheckId !== null
      && rawActiveCheckId !== this.#testEvidence.started.checkId) {
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.TEST_IDENTITY_MISMATCH, {
        expectedCheckId: this.#testEvidence.started.checkId,
        actualCheckId: rawActiveCheckId,
        source: 'player_snapshot',
      });
      return;
    }
    const activeCheckId = this.#effectiveActiveCheckId();
    if (this.#pendingTest?.operation === 'start') {
      if (activeCheckId === this.#pendingTest.checkId) {
        this.#pendingTest = null;
      } else if (activeCheckId !== null || activeFamily !== null) {
        this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.TEST_IDENTITY_MISMATCH, {
          expectedCheckId: this.#pendingTest.checkId,
          actualCheckId: activeCheckId,
          activeFamily,
        });
      }
    } else if (this.#pendingTest?.operation === 'stop') {
      if (activeCheckId === null) {
        this.#pendingTest = null;
      } else if (activeCheckId !== this.#pendingTest.checkId) {
        this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.TEST_IDENTITY_MISMATCH, {
          expectedCheckId: this.#pendingTest.checkId,
          actualCheckId: activeCheckId,
        });
      }
    }
  }

  #isStrongStoppedObservation(run) {
    const confirmed = this.#confirmedPlayback;
    return confirmed?.status === 'stopped'
      && confirmed.entryId === run.entryId
      && confirmed.runId === run.runId
      && confirmed.playerInstanceId === run.targetPlayerInstanceId
      && confirmed.leaseEpoch === run.leaseEpoch
      && confirmed.paused === true
      && confirmed.sourceDetached === true
      && confirmed.autoplayCancelled === true
      && confirmed.audible === false;
  }

  #handleCommandResult(result) {
    const commandId = result?.entry?.commandId;
    const metadata = isIdentifier(commandId) ? this.#pendingCommands.get(commandId) : null;
    if (result?.status === 'outcome_unknown' || result?.entry?.state === 'outcome_unknown') {
      if (metadata?.kind === 'takeover' && this.#pendingTakeover?.commandId === commandId) {
        this.#pendingTakeover = immutable({
          ...this.#pendingTakeover,
          status: 'failed',
          reasonCode: ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN,
        });
      }
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.OUTCOME_UNKNOWN, {
        commandId: commandId ?? null,
      });
    } else if (result?.status === 'acknowledged') {
      if (metadata?.kind === 'takeover' && this.#pendingTakeover?.commandId === commandId) {
        const acknowledgement = result?.entry?.result;
        const controlInstanceId = this.#connection.identity.controlInstanceId;
        const controlEpoch = acknowledgement?.controlEpoch;
        const validAcknowledgement = acknowledgement?.code === 'control_lease_granted'
          && acknowledgement?.writableControlInstanceId === controlInstanceId
          && Number.isSafeInteger(controlEpoch)
          && controlEpoch >= 0;
        if (!validAcknowledgement) {
          this.#pendingTakeover = immutable({
            ...this.#pendingTakeover,
            status: 'failed',
            reasonCode: 'control_takeover_ack_invalid',
          });
          this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID, {
            field: 'control_takeover_ack',
            code: 'invalid_authority_proof',
          });
        } else {
          this.#maxControlEpoch = Math.max(this.#maxControlEpoch ?? 0, controlEpoch);
          this.#welcome = immutable({
            ...this.#welcome,
            writable: true,
            controlEpoch,
            writableControlInstanceId: controlInstanceId,
            code: 'control_lease_granted',
          });
          this.#pendingTakeover = null;
        }
      }
      if (metadata?.kind === 'load' && this.#activeRun?.loadCommandId === commandId) {
        this.#activeRun = immutable({ ...this.#activeRun, acknowledged: true });
      }
      if (commandId) this.#pendingCommands.delete(commandId);
    } else if (result?.status === 'rejected') {
      if (metadata?.kind === 'takeover' && this.#pendingTakeover?.commandId === commandId) {
        this.#pendingTakeover = immutable({
          ...this.#pendingTakeover,
          status: 'failed',
          reasonCode: result?.entry?.result?.code || 'control_takeover_rejected',
        });
      }
      if (metadata?.kind === 'load' && this.#activeRun?.loadCommandId === commandId) {
        this.#activeRun = null;
      }
      if ((metadata?.kind === 'activate' || metadata?.kind === 'deactivate')
        && this.#pendingSwitch?.commandId === commandId) {
        this.#pendingSwitch = null;
      }
      if ((metadata?.kind === 'startTest' || metadata?.kind === 'stopTest')
        && this.#pendingTest?.commandId === commandId) {
        this.#pendingTest = null;
      }
      if (commandId) this.#pendingCommands.delete(commandId);
    }
    this.#call('onCommandResult', result);
    this.#publish();
  }

  #handleConnectionDiagnostic(diagnostic) {
    this.#recordDiagnostic(
      typeof diagnostic?.code === 'string' ? diagnostic.code : 'connection_diagnostic',
      diagnostic?.detail ?? {},
    );
    if (diagnostic?.code === ON_AIR_V2_CONNECTION_CODES.INVALID_PROTOCOL_FRAME
      && [ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT, ON_AIR_MESSAGE_FAMILIES.SERVER_STATE]
        .includes(diagnostic?.detail?.family)) {
      if (diagnostic?.detail?.family === ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT) {
        this.#snapshotTrusted = false;
      }
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.SNAPSHOT_INVALID, diagnostic.detail);
    }
  }

  #handleConnectionState(change) {
    const nextState = change?.state;
    if (typeof nextState === 'string') this.#connectionState = nextState;
    if ([
      ON_AIR_V2_CONNECTION_STATES.DISCONNECTED,
      ON_AIR_V2_CONNECTION_STATES.SUPERSEDED,
      ON_AIR_V2_CONNECTION_STATES.CLOSED,
    ].includes(nextState)) {
      this.#snapshotTrusted = false;
      this.#testEvidence = emptyTestEvidence(this.#connectionGeneration);
      this.#lockUnknown(ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST, {
        state: nextState,
        reason: change?.detail?.reason ?? null,
      });
    }
    this.#call('onStateChange', change);
    this.#publish();
  }

  #lockUnknown(code, detail) {
    if (!this.#unknownLock) {
      this.#unknownLock = immutable({ code, detail: stableDetail(detail) });
      this.#recordDiagnostic(code, detail);
    }
    this.#publish();
  }

  #recordDiagnostic(code, detail) {
    this.#diagnostics.push(immutable({ code, detail: stableDetail(detail) }));
    while (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
    this.#call('onDiagnostic', this.#diagnostics.at(-1));
  }

  #publish() {
    const snapshot = this.snapshot();
    this.#call('onSnapshot', snapshot);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // Subscriber failures cannot change coordinator safety state.
      }
    }
  }

  #call(name, payload) {
    const callback = this.#callbacks[name];
    if (typeof callback !== 'function') return;
    try {
      const result = callback(payload);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch {
      // Observer callbacks are never part of the command authority boundary.
    }
  }
}

export function createOnAirControlCoordinator(options) {
  return new OnAirControlCoordinator(options);
}
