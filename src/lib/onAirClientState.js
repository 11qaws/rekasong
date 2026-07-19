import {
  ON_AIR_MESSAGE_FAMILIES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_SEQUENCE_NAMESPACES,
  SERVER_MESSAGE_TYPES,
  getOnAirMessageFamily,
  getOnAirSequenceNamespace,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from './onAirProtocol.js';

/**
 * Pure page-lifetime state for On-Air Protocol v2 clients.
 *
 * This module deliberately has no React, DOM, storage, timer, or transport
 * dependency. A page owns these objects and keeps them across WebSocket
 * reconnects; a full page lifecycle creates fresh objects and identities.
 */

export const ON_AIR_CLIENT_STATE_CODES = Object.freeze({
  INVALID_ARGUMENT: 'client_state_invalid_argument',
  INVALID_IDENTIFIER: 'client_state_invalid_identifier',
  INVALID_ID_FACTORY_RESULT: 'client_state_invalid_id_factory_result',
  INVALID_JSON_VALUE: 'client_state_invalid_json_value',
  UNKNOWN_SEQUENCE_NAMESPACE: 'client_state_unknown_sequence_namespace',
  INVALID_SEQUENCE_HIGH_WATER_MARK: 'client_state_invalid_sequence_high_water_mark',
  SEQUENCE_EXHAUSTED: 'client_state_sequence_exhausted',
  COMMAND_ID_CONFLICT: 'command_id_conflict',
  COMMAND_NOT_FOUND: 'command_not_found',
  COMMAND_TERMINAL_CONFLICT: 'command_terminal_conflict',
  COMMAND_PENDING_CAPACITY_EXCEEDED: 'command_pending_capacity_exceeded',
  INVALID_PROTOCOL_FRAME: 'invalid_protocol_frame',
  UNEXPECTED_PROTOCOL_FRAME: 'unexpected_protocol_frame',
  EVENT_ID_CONFLICT: 'event_id_conflict',
  EVENT_NOT_FOUND: 'event_not_found',
  EVENT_SEQUENCE_MISMATCH: 'event_sequence_mismatch',
  EVENT_ACK_IDENTITY_MISMATCH: 'event_ack_identity_mismatch',
  EVENT_TERMINAL_CONFLICT: 'event_terminal_conflict',
  EVENT_OUTBOX_CAPACITY_EXCEEDED: 'event_outbox_capacity_exceeded',
  EVENT_OUTBOX_TELEMETRY_DROPPED: 'event_outbox_telemetry_dropped',
  UNSUPPORTED_OUTBOX_MESSAGE: 'unsupported_outbox_message',
  PLAYER_COMMAND_ID_CONFLICT: 'player_command_id_conflict',
  PLAYER_COMMAND_HISTORY_CAPACITY_EXCEEDED: 'player_command_history_capacity_exceeded',
});

const COMMAND_STATES = Object.freeze({
  REQUESTED: 'requested',
  ACKNOWLEDGED: 'acknowledged',
  REJECTED: 'rejected',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

const EVENT_STATES = Object.freeze({
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  ABANDONED: 'abandoned',
  COALESCED: 'coalesced',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

const SEQUENCE_NAMESPACES = Object.freeze(Object.values(ON_AIR_SEQUENCE_NAMESPACES));
const SEQUENCE_NAMESPACE_SET = new Set(SEQUENCE_NAMESPACES);
const MAX_EMITTABLE_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;
const ID_MAX_LENGTH = 256;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, active = new WeakSet(), path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE, { path, kind: 'non_finite_number' });
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE, { path, kind: typeof value });
  }
  if (active.has(value)) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE, { path, kind: 'cycle' });
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE, {
      path,
      kind: 'non_plain_object',
    });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_JSON_VALUE, { path, kind: 'symbol_key' });
  }

  active.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalize(item, active, `${path}[${index}]`)).join(',')}]`;
  } else {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], active, `${path}.${key}`)}`);
    result = `{${entries.join(',')}}`;
  }
  active.delete(value);
  return result;
}

/** A collision-free canonical JSON representation used as an in-memory fingerprint. */
export function canonicalOnAirFingerprint(value) {
  return canonicalize(value);
}

function cloneJson(value) {
  return JSON.parse(canonicalOnAirFingerprint(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value) {
  return deepFreeze(cloneJson(value));
}

export class OnAirClientStateError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirClientStateError';
    this.code = code;
    this.detail = immutableJson(detail);
  }
}

function stateError(code, detail) {
  return new OnAirClientStateError(code, detail);
}

function requirePositiveLimit(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, { field, kind: 'positive_safe_integer' });
  }
}

function requireIdentifier(value, field) {
  let reason = null;
  if (typeof value !== 'string' || value.trim().length === 0) reason = 'required_identifier';
  else if (value !== value.trim()) reason = 'invalid_identifier';
  else if ([...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  })) reason = 'invalid_identifier';
  else if (value.length > ID_MAX_LENGTH) reason = 'identifier_too_long';
  if (reason) throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_IDENTIFIER, { field, reason });
  return value;
}

function defaultIdFactory(scope) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `${scope}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    const randomId = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${scope}-${randomId}`;
  }
  throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ID_FACTORY_RESULT, {
    field: 'idFactory',
    scope,
    reason: 'secure_random_unavailable',
  });
}

function generateIdentifier(idFactory, scope, field) {
  if (typeof idFactory !== 'function') {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, { field: 'idFactory', kind: 'function' });
  }
  let value;
  try {
    value = idFactory(scope);
    requireIdentifier(value, field);
  } catch (error) {
    if (
      error instanceof OnAirClientStateError
      && error.code === ON_AIR_CLIENT_STATE_CODES.INVALID_ID_FACTORY_RESULT
    ) {
      throw error;
    }
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ID_FACTORY_RESULT, {
      field,
      scope,
      reason: error instanceof OnAirClientStateError
        ? error.detail.reason ?? 'invalid_identifier'
        : 'factory_threw',
    });
  }
  return value;
}

function createScopedIdentity(scope, field, idFactory) {
  const value = generateIdentifier(idFactory, scope, field);
  return Object.freeze({ [field]: value });
}

/** Create once per player page and retain the returned value across reconnects. */
export function createPlayerPageIdentity({ idFactory = defaultIdFactory } = {}) {
  return createScopedIdentity('player', 'playerInstanceId', idFactory);
}

/** Create once per control page and retain the returned value across reconnects. */
export function createControlPageIdentity({ idFactory = defaultIdFactory } = {}) {
  return createScopedIdentity('control', 'controlInstanceId', idFactory);
}

function requireNamespace(namespace) {
  if (!SEQUENCE_NAMESPACE_SET.has(namespace)) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.UNKNOWN_SEQUENCE_NAMESPACE, { namespace });
  }
}

/** Eight isolated outbound counters. The first emitted value in every stream is zero. */
export class OnAirSequenceCounters {
  #nextValues = new Map(SEQUENCE_NAMESPACES.map((namespace) => [namespace, 0]));

  constructor({ highWaterMarks } = {}) {
    if (highWaterMarks !== undefined) this.mergeHighWaterMarks(highWaterMarks);
  }

  peek(namespace) {
    requireNamespace(namespace);
    return this.#nextValues.get(namespace);
  }

  next(namespace) {
    const value = this.peek(namespace);
    if (value > MAX_EMITTABLE_SEQUENCE) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.SEQUENCE_EXHAUSTED, { namespace });
    }
    this.#nextValues.set(namespace, value + 1);
    return value;
  }

  /** Merge server/welcome high-water marks without ever lowering a local stream. */
  mergeHighWaterMarks(highWaterMarks) {
    if (!isRecord(highWaterMarks)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'highWaterMarks',
        kind: 'record',
      });
    }

    const updates = [];
    for (const [namespace, highWaterMark] of Object.entries(highWaterMarks)) {
      requireNamespace(namespace);
      if (highWaterMark === null) continue;
      if (
        !Number.isSafeInteger(highWaterMark)
        || highWaterMark < 0
        || highWaterMark > MAX_EMITTABLE_SEQUENCE
      ) {
        throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_SEQUENCE_HIGH_WATER_MARK, {
          namespace,
          highWaterMark,
        });
      }
      updates.push([namespace, highWaterMark + 1]);
    }

    for (const [namespace, floor] of updates) {
      this.#nextValues.set(namespace, Math.max(this.#nextValues.get(namespace), floor));
    }
    return this.snapshot();
  }

  snapshot() {
    const nextValues = {};
    const highWaterMarks = {};
    for (const namespace of SEQUENCE_NAMESPACES) {
      const nextValue = this.#nextValues.get(namespace);
      nextValues[namespace] = nextValue;
      highWaterMarks[namespace] = nextValue === 0 ? null : nextValue - 1;
    }
    return immutableJson({ nextValues, highWaterMarks });
  }
}

function commandFingerprint(command) {
  const semanticCommand = { ...command };
  delete semanticCommand.commandId;
  return canonicalOnAirFingerprint(semanticCommand);
}

function publicResult(status, entry, extra = {}) {
  return Object.freeze({ status, entry, ...extra });
}

/**
 * Page-lifetime control command ledger.
 *
 * A reconnect turns every unresolved command into outcome_unknown. It never
 * returns a resend queue: reconciliation must happen from a trusted snapshot.
 */
export class OnAirCommandLedger {
  #idFactory;
  #historyLimit;
  #pendingCapacity;
  #entries = new Map();
  #terminalOrder = new Map();

  constructor({
    idFactory = defaultIdFactory,
    historyLimit = 256,
    pendingCapacity = 256,
  } = {}) {
    if (typeof idFactory !== 'function') {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'idFactory',
        kind: 'function',
      });
    }
    requirePositiveLimit(historyLimit, 'historyLimit');
    requirePositiveLimit(pendingCapacity, 'pendingCapacity');
    this.#idFactory = idFactory;
    this.#historyLimit = historyLimit;
    this.#pendingCapacity = pendingCapacity;
  }

  get size() {
    return this.#entries.size;
  }

  request(command, { commandId: requestedCommandId } = {}) {
    if (!isRecord(command)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, { field: 'command', kind: 'record' });
    }
    if (
      requestedCommandId !== undefined
      && command.commandId !== undefined
      && requestedCommandId !== command.commandId
    ) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.COMMAND_ID_CONFLICT, {
        commandId: requestedCommandId,
        receivedCommandId: command.commandId,
      });
    }

    const commandId = requestedCommandId
      ?? command.commandId
      ?? generateIdentifier(this.#idFactory, 'command', 'commandId');
    requireIdentifier(commandId, 'commandId');
    const normalizedCommand = immutableJson({ ...command, commandId });
    const fingerprint = commandFingerprint(normalizedCommand);
    const existing = this.#entries.get(commandId);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw stateError(ON_AIR_CLIENT_STATE_CODES.COMMAND_ID_CONFLICT, { commandId });
      }
      if (existing.state !== COMMAND_STATES.REQUESTED) {
        return publicResult('terminal', existing, { retryAllowed: false });
      }
      const retried = deepFreeze({ ...existing, attempts: existing.attempts + 1 });
      this.#entries.set(commandId, retried);
      return publicResult('retry', retried, { retryAllowed: true });
    }

    const pendingCount = [...this.#entries.values()]
      .filter((entry) => entry.state === COMMAND_STATES.REQUESTED).length;
    if (pendingCount >= this.#pendingCapacity) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.COMMAND_PENDING_CAPACITY_EXCEEDED, {
        capacity: this.#pendingCapacity,
      });
    }

    const entry = deepFreeze({
      commandId,
      fingerprint,
      command: normalizedCommand,
      state: COMMAND_STATES.REQUESTED,
      attempts: 1,
      result: null,
    });
    this.#entries.set(commandId, entry);
    return publicResult('created', entry, { retryAllowed: true });
  }

  handleServerFrame(frame) {
    const validation = validateFrame(frame);
    if (
      frame.type !== SERVER_MESSAGE_TYPES.COMMAND_ACK
      && frame.type !== SERVER_MESSAGE_TYPES.COMMAND_REJECTED
    ) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.UNEXPECTED_PROTOCOL_FRAME, {
        family: validation.family,
        type: frame.type,
      });
    }

    const entry = this.#entries.get(frame.commandId);
    if (!entry) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.COMMAND_NOT_FOUND, { commandId: frame.commandId });
    }
    const nextState = frame.type === SERVER_MESSAGE_TYPES.COMMAND_ACK
      ? COMMAND_STATES.ACKNOWLEDGED
      : COMMAND_STATES.REJECTED;

    if (entry.state !== COMMAND_STATES.REQUESTED) {
      if (
        entry.state === nextState
        && entry.result?.type === frame.type
        && canonicalOnAirFingerprint(entry.result) === canonicalOnAirFingerprint(frame)
      ) {
        return publicResult('duplicate_terminal', entry, { retryAllowed: false });
      }
      throw stateError(ON_AIR_CLIENT_STATE_CODES.COMMAND_TERMINAL_CONFLICT, {
        commandId: frame.commandId,
        existingState: entry.state,
        receivedState: nextState,
      });
    }

    const settled = deepFreeze({
      ...entry,
      state: nextState,
      result: immutableJson(frame),
    });
    this.#entries.set(entry.commandId, settled);
    this.#rememberTerminal(settled);
    return publicResult(nextState, settled, { retryAllowed: false });
  }

  markReconnectOutcomeUnknown(detail = { code: 'transport_reconnected' }) {
    const safeDetail = immutableJson(detail);
    const changed = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.state !== COMMAND_STATES.REQUESTED) continue;
      const settled = deepFreeze({
        ...entry,
        state: COMMAND_STATES.OUTCOME_UNKNOWN,
        result: safeDetail,
      });
      this.#entries.set(entry.commandId, settled);
      this.#rememberTerminal(settled);
      changed.push(settled);
    }
    return Object.freeze(changed);
  }

  get(commandId) {
    requireIdentifier(commandId, 'commandId');
    return this.#entries.get(commandId) ?? null;
  }

  terminalLookup(commandId) {
    const entry = this.get(commandId);
    return entry && entry.state !== COMMAND_STATES.REQUESTED ? entry : null;
  }

  pending() {
    return Object.freeze(
      [...this.#entries.values()].filter((entry) => entry.state === COMMAND_STATES.REQUESTED),
    );
  }

  snapshot() {
    return Object.freeze({
      pendingCapacity: this.#pendingCapacity,
      pending: this.pending(),
      terminal: Object.freeze([...this.#terminalOrder.values()]),
    });
  }

  #rememberTerminal(entry) {
    this.#terminalOrder.delete(entry.commandId);
    this.#terminalOrder.set(entry.commandId, entry);
    while (this.#terminalOrder.size > this.#historyLimit) {
      const evictedId = this.#terminalOrder.keys().next().value;
      this.#terminalOrder.delete(evictedId);
      this.#entries.delete(evictedId);
    }
  }
}

function playerCommandFingerprint(command, family) {
  const semanticCommand = { ...command };
  if (family !== ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND) {
    delete semanticCommand.targetConnectionId;
  }
  return canonicalOnAirFingerprint(semanticCommand);
}

function playerCommandKey(command, family) {
  return family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND
    ? `${command.commandId}\u0000${command.targetConnectionId}`
    : command.commandId;
}

function isCriticalPlayerCommandFamily(family) {
  return family === ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND
    || family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND;
}

/**
 * Page-lifetime receipt ledger for Worker-to-player commands.
 *
 * Ordinary commands deduplicate by commandId even if a reconnect changes the
 * concrete transport fence. Emergency stop is deliberately connection-bound:
 * the same command must execute again when the Worker proves a replacement
 * connection needs to stop. Route/emergency tombstones are never evicted; if
 * they consume the bounded history the player fails closed instead of making a
 * dangerous replay executable again.
 */
export class OnAirPlayerCommandLedger {
  #historyLimit;
  #receivedOrder = 0;
  #entries = new Map();

  constructor({ historyLimit = 256 } = {}) {
    requirePositiveLimit(historyLimit, 'historyLimit');
    this.#historyLimit = historyLimit;
  }

  get size() {
    return this.#entries.size;
  }

  inspect(command) {
    const validation = validateOnAirPlayerCommand(command);
    if (!validation.ok) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_PROTOCOL_FRAME, {
        family: validation.family,
        errors: protocolErrors(validation),
      });
    }
    const family = getOnAirMessageFamily(command);
    const key = playerCommandKey(command, family);
    const fingerprint = playerCommandFingerprint(command, family);
    const existing = this.#entries.get(key) ?? null;
    if (existing && existing.fingerprint !== fingerprint) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_ID_CONFLICT, {
        commandId: command.commandId,
        targetConnectionId: family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND
          ? command.targetConnectionId
          : null,
      });
    }
    return Object.freeze({
      status: existing ? 'duplicate' : 'new',
      shouldApply: !existing,
      key,
      fingerprint,
      family,
      existing,
    });
  }

  observe(command) {
    const inspection = this.inspect(command);
    if (!inspection.shouldApply) {
      return publicResult('duplicate', inspection.existing, { shouldApply: false });
    }

    if (this.#entries.size >= this.#historyLimit) {
      const evictable = [...this.#entries.values()].find((entry) => !entry.critical) ?? null;
      if (!evictable) {
        throw stateError(
          ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_HISTORY_CAPACITY_EXCEEDED,
          { capacity: this.#historyLimit, commandId: command.commandId },
        );
      }
      this.#entries.delete(evictable.key);
    }

    const entry = deepFreeze({
      key: inspection.key,
      commandId: command.commandId,
      targetConnectionId: command.targetConnectionId,
      family: inspection.family,
      fingerprint: inspection.fingerprint,
      critical: isCriticalPlayerCommandFamily(inspection.family),
      receivedOrder: this.#receivedOrder,
      command: immutableJson(command),
    });
    this.#receivedOrder += 1;
    this.#entries.set(entry.key, entry);
    return publicResult('accepted', entry, { shouldApply: true });
  }

  get(commandId, { targetConnectionId } = {}) {
    requireIdentifier(commandId, 'commandId');
    const key = targetConnectionId === undefined
      ? commandId
      : `${commandId}\u0000${requireIdentifier(targetConnectionId, 'targetConnectionId')}`;
    return this.#entries.get(key) ?? null;
  }

  snapshot() {
    return Object.freeze({
      historyLimit: this.#historyLimit,
      entries: Object.freeze([...this.#entries.values()]),
    });
  }
}

function protocolErrors(validation) {
  return validation.errors.map(({ path, code }) => ({ path, code }));
}

function validateFrame(frame) {
  const validation = validateOnAirMessage(frame);
  if (!validation.ok) {
    throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_PROTOCOL_FRAME, {
      family: validation.family,
      errors: protocolErrors(validation),
    });
  }
  return validation;
}

function eventFingerprint(message) {
  return canonicalOnAirFingerprint(message);
}

function isTelemetryNamespace(namespace) {
  return namespace === ON_AIR_SEQUENCE_NAMESPACES.RUN_TELEMETRY;
}

function telemetryKey(message) {
  return isTelemetryNamespace(getOnAirSequenceNamespace(message))
    ? `${message.playerInstanceId}\u0000${message.event}`
    : null;
}

function eventRecord(message, namespace) {
  return deepFreeze({
    eventId: message.eventId,
    namespace,
    sequence: message.sequence,
    state: EVENT_STATES.PENDING,
    telemetry: isTelemetryNamespace(namespace),
    connectionBound: message.type === ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK,
    fingerprint: eventFingerprint(message),
    message,
    result: null,
  });
}

/** Reliable page-lifetime outbox for ACKed player-originated events. */
export class OnAirPlayerEventOutbox {
  #idFactory;
  #counters;
  #capacity;
  #historyLimit;
  #pending = new Map();
  #terminal = new Map();

  constructor({
    idFactory = defaultIdFactory,
    sequenceCounters = new OnAirSequenceCounters(),
    capacity = 256,
    historyLimit = 256,
  } = {}) {
    if (typeof idFactory !== 'function') {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'idFactory',
        kind: 'function',
      });
    }
    if (
      !sequenceCounters
      || typeof sequenceCounters.peek !== 'function'
      || typeof sequenceCounters.next !== 'function'
    ) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'sequenceCounters',
        kind: 'counter',
      });
    }
    requirePositiveLimit(capacity, 'capacity');
    requirePositiveLimit(historyLimit, 'historyLimit');
    this.#idFactory = idFactory;
    this.#counters = sequenceCounters;
    this.#capacity = capacity;
    this.#historyLimit = historyLimit;
  }

  get size() {
    return this.#pending.size;
  }

  enqueue(draft, { connectionId: requestedConnectionId } = {}) {
    if (!isRecord(draft)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, { field: 'event', kind: 'record' });
    }
    if (
      requestedConnectionId !== undefined
      && draft.connectionId !== undefined
      && requestedConnectionId !== draft.connectionId
    ) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_ID_CONFLICT, {
        eventId: draft.eventId ?? null,
        field: 'connectionId',
      });
    }

    const eventId = draft.eventId ?? generateIdentifier(this.#idFactory, 'event', 'eventId');
    requireIdentifier(eventId, 'eventId');
    const connectionId = requestedConnectionId ?? draft.connectionId;
    const existing = this.#pending.get(eventId) ?? this.#terminal.get(eventId);

    if (existing) {
      const retryMessage = immutableJson({ ...draft, eventId });
      const validation = validateFrame(retryMessage);
      const namespace = getOnAirSequenceNamespace(retryMessage);
      if (
        namespace !== existing.namespace
        || eventFingerprint(retryMessage) !== existing.fingerprint
      ) {
        throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_ID_CONFLICT, { eventId });
      }
      return publicResult(
        existing.state === EVENT_STATES.PENDING ? 'retry' : 'terminal',
        existing,
        { validationFamily: validation.family, retryAllowed: existing.state === EVENT_STATES.PENDING },
      );
    }

    const provisional = { ...draft, eventId };
    if (connectionId !== undefined) provisional.connectionId = connectionId;
    const namespace = getOnAirSequenceNamespace(provisional);
    if (!namespace || namespace === ON_AIR_SEQUENCE_NAMESPACES.HEARTBEAT) {
      const validation = validateOnAirMessage(provisional);
      if (!validation.ok) validateFrame(provisional);
      throw stateError(ON_AIR_CLIENT_STATE_CODES.UNSUPPORTED_OUTBOX_MESSAGE, {
        family: validation.family,
        namespace,
      });
    }

    const expectedSequence = this.#counters.peek(namespace);
    const sequence = draft.sequence ?? expectedSequence;
    if (sequence !== expectedSequence) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_SEQUENCE_MISMATCH, {
        namespace,
        expectedSequence,
        receivedSequence: sequence,
      });
    }

    const message = immutableJson({ ...provisional, sequence });
    validateFrame(message);
    const canonicalNamespace = getOnAirSequenceNamespace(message);
    if (canonicalNamespace !== namespace) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.UNSUPPORTED_OUTBOX_MESSAGE, {
        namespace,
        canonicalNamespace,
      });
    }

    const sampleKey = telemetryKey(message);
    const coalesced = sampleKey
      ? [...this.#pending.values()].find((record) => telemetryKey(record.message) === sampleKey)
      : null;
    let telemetryEviction = null;

    if (!coalesced && this.#pending.size >= this.#capacity) {
      if (sampleKey) {
        return Object.freeze({
          status: 'dropped',
          accepted: false,
          code: ON_AIR_CLIENT_STATE_CODES.EVENT_OUTBOX_TELEMETRY_DROPPED,
          detail: immutableJson({ capacity: this.#capacity, namespace, event: message.event }),
        });
      }
      telemetryEviction = [...this.#pending.values()].find((record) => record.telemetry) ?? null;
      if (!telemetryEviction) {
        throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_OUTBOX_CAPACITY_EXCEEDED, {
          capacity: this.#capacity,
          namespace,
        });
      }
    }

    const committedSequence = this.#counters.next(namespace);
    if (committedSequence !== sequence) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_SEQUENCE_MISMATCH, {
        namespace,
        expectedSequence: sequence,
        receivedSequence: committedSequence,
      });
    }

    const replaced = coalesced ?? telemetryEviction;
    if (replaced) {
      this.#retire(replaced, EVENT_STATES.COALESCED, {
        code: coalesced ? 'newer_telemetry_sample' : 'critical_event_priority',
        replacementEventId: eventId,
      });
    }

    const record = eventRecord(message, namespace);
    this.#pending.set(eventId, record);
    return publicResult('created', record, {
      retryAllowed: true,
      coalescedEventId: replaced?.eventId ?? null,
    });
  }

  applyServerAck(frame) {
    const validation = validateFrame(frame);
    if (frame.type !== SERVER_MESSAGE_TYPES.EVENT_ACK) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.UNEXPECTED_PROTOCOL_FRAME, {
        family: validation.family,
        type: frame.type,
      });
    }

    const record = this.#pending.get(frame.eventId);
    if (!record) {
      const terminal = this.#terminal.get(frame.eventId);
      if (terminal) {
        if (
          frame.playerInstanceId !== terminal.message.playerInstanceId
          || frame.sequence !== terminal.sequence
        ) {
          throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_ACK_IDENTITY_MISMATCH, {
            eventId: frame.eventId,
            expectedPlayerInstanceId: terminal.message.playerInstanceId,
            receivedPlayerInstanceId: frame.playerInstanceId,
            expectedSequence: terminal.sequence,
            receivedSequence: frame.sequence,
          });
        }
        if (
          terminal.state !== EVENT_STATES.ACKNOWLEDGED
          || !terminal.result?.ack
          || canonicalOnAirFingerprint(terminal.result.ack) !== canonicalOnAirFingerprint(frame)
        ) {
          throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_TERMINAL_CONFLICT, {
            eventId: frame.eventId,
            existingState: terminal.state,
            receivedStatus: frame.status,
          });
        }
        return publicResult('duplicate_terminal', terminal, { retryAllowed: false });
      }
      throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_NOT_FOUND, { eventId: frame.eventId });
    }
    if (
      frame.playerInstanceId !== record.message.playerInstanceId
      || frame.sequence !== record.sequence
    ) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.EVENT_ACK_IDENTITY_MISMATCH, {
        eventId: frame.eventId,
        expectedPlayerInstanceId: record.message.playerInstanceId,
        receivedPlayerInstanceId: frame.playerInstanceId,
        expectedSequence: record.sequence,
        receivedSequence: frame.sequence,
      });
    }

    const settled = this.#retire(record, EVENT_STATES.ACKNOWLEDGED, {
      ack: frame,
      ackStatus: frame.status,
    });
    return publicResult('acknowledged', settled, { ackStatus: frame.status, retryAllowed: false });
  }

  /**
   * Rebind ordinary events to a new socket. Emergency stop ACKs describe exact
   * old-connection postconditions and therefore become outcome_unknown.
   */
  rebindConnection(connectionId) {
    requireIdentifier(connectionId, 'connectionId');
    const replacements = [];
    const connectionBound = [];

    for (const record of this.#pending.values()) {
      if (record.connectionBound) {
        connectionBound.push(record);
        continue;
      }
      const message = immutableJson({ ...record.message, connectionId });
      validateFrame(message);
      replacements.push([
        record,
        deepFreeze({ ...record, fingerprint: eventFingerprint(message), message }),
      ]);
    }

    const outcomeUnknown = connectionBound.map((record) => this.#retire(
      record,
      EVENT_STATES.OUTCOME_UNKNOWN,
      { code: 'connection_replaced', connectionId: record.message.connectionId },
    ));
    for (const [prior, replacement] of replacements) {
      if (this.#pending.get(prior.eventId) === prior) {
        this.#pending.set(prior.eventId, replacement);
      }
    }

    return Object.freeze({
      status: 'rebound',
      rebound: Object.freeze(replacements.map(([, replacement]) => replacement)),
      outcomeUnknown: Object.freeze(outcomeUnknown),
    });
  }

  /** Retire only proofs bound to a transport that can no longer ACK them. */
  markConnectionLost(connectionId) {
    requireIdentifier(connectionId, 'connectionId');
    const outcomeUnknown = [];
    for (const record of [...this.#pending.values()]) {
      if (!record.connectionBound || record.message.connectionId !== connectionId) continue;
      outcomeUnknown.push(this.#retire(
        record,
        EVENT_STATES.OUTCOME_UNKNOWN,
        { code: 'connection_lost', connectionId },
      ));
    }
    return Object.freeze(outcomeUnknown);
  }

  /**
   * Tombstone only the exact caller-enumerated pending events. Validation is
   * atomic so an invalid later ID can never partially abandon an earlier one.
   */
  abandonEvents(eventIds, options = {}) {
    if (!Array.isArray(eventIds)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'eventIds',
        kind: 'array',
      });
    }
    if (!isRecord(options)) {
      throw stateError(ON_AIR_CLIENT_STATE_CODES.INVALID_ARGUMENT, {
        field: 'options',
        kind: 'record',
      });
    }
    const code = options.code ?? 'client_abandoned';
    requireIdentifier(code, 'code');

    const uniqueIds = [];
    const seen = new Set();
    for (const [index, eventId] of eventIds.entries()) {
      requireIdentifier(eventId, `eventIds[${index}]`);
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      uniqueIds.push(eventId);
    }

    const abandoned = [];
    const alreadyTerminal = [];
    const notFound = [];
    for (const eventId of uniqueIds) {
      const pending = this.#pending.get(eventId);
      if (pending) {
        abandoned.push(this.#retire(pending, EVENT_STATES.ABANDONED, { code }));
        continue;
      }
      const terminal = this.#terminal.get(eventId);
      if (terminal) {
        alreadyTerminal.push(terminal);
        continue;
      }
      notFound.push(eventId);
    }

    return Object.freeze({
      status: 'abandoned',
      abandoned: Object.freeze(abandoned),
      alreadyTerminal: Object.freeze(alreadyTerminal),
      notFound: Object.freeze(notFound),
    });
  }

  get(eventId) {
    requireIdentifier(eventId, 'eventId');
    return this.#pending.get(eventId) ?? this.#terminal.get(eventId) ?? null;
  }

  terminalLookup(eventId) {
    requireIdentifier(eventId, 'eventId');
    return this.#terminal.get(eventId) ?? null;
  }

  pending() {
    return Object.freeze([...this.#pending.values()]);
  }

  snapshot() {
    return Object.freeze({
      capacity: this.#capacity,
      pending: this.pending(),
      terminal: Object.freeze([...this.#terminal.values()]),
    });
  }

  #retire(record, state, result) {
    this.#pending.delete(record.eventId);
    const settled = deepFreeze({ ...record, state, result: immutableJson(result) });
    this.#terminal.delete(record.eventId);
    this.#terminal.set(record.eventId, settled);
    while (this.#terminal.size > this.#historyLimit) {
      const evictedId = this.#terminal.keys().next().value;
      this.#terminal.delete(evictedId);
    }
    return settled;
  }
}
