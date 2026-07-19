/**
 * Runtime schema helpers for On-Air Protocol v2.
 *
 * This module intentionally has no browser, React, Worker, or storage dependency.
 * It is shared policy infrastructure: transports may parse JSON however they like,
 * then validate the resulting value here before applying it.
 */

export const ON_AIR_PROTOCOL_VERSION = 2;

export const PLAYER_CLIENT_KINDS = Object.freeze({
  DASHBOARD_SPEAKER: 'dashboard-speaker',
  OBS_BROWSER_SOURCE: 'obs-browser-source',
  GENERIC_BROWSER: 'generic-browser',
});

export const ON_AIR_MESSAGE_TYPES = Object.freeze({
  PLAYER_HELLO: 'player_hello',
  CONTROL_HELLO: 'control_hello',
  PLAYER_HEARTBEAT: 'player_heartbeat',
  PLAYBACK_EVENT: 'playback_event',
  ROUTE_EVENT: 'route_event',
  TEST_EVENT: 'test_event',
  EMERGENCY_STOP: 'emergency_stop',
  EMERGENCY_STOP_ACK: 'emergency_stop_ack',
});

export const SERVER_MESSAGE_TYPES = Object.freeze({
  PLAYER_WELCOME: 'player_welcome',
  CONTROL_WELCOME: 'control_welcome',
  HEARTBEAT_ACK: 'heartbeat_ack',
  PLAYER_SNAPSHOT: 'player_snapshot',
  COMMAND_ACK: 'command_ack',
  COMMAND_REJECTED: 'command_rejected',
  EVENT_ACK: 'event_ack',
  PROTOCOL_ERROR: 'protocol_error',
  CONNECTION_SUPERSEDED: 'connection_superseded',
  DESIRED_TRANSPORT: 'desired_transport',
  PRESENCE: 'presence',
  SESSION_ENDED: 'session_ended',
});

export const RUN_COMMAND_TYPES = Object.freeze({
  LOAD: 'load',
  PLAY: 'play',
  PAUSE: 'pause',
  SEEK: 'seek',
  VOLUME: 'volume',
  STOP: 'stop',
});

export const ROUTE_COMMAND_TYPES = Object.freeze({
  ACTIVATE: 'activate_output',
  DEACTIVATE: 'deactivate_output',
});

export const TEST_COMMAND_TYPES = Object.freeze({
  START: 'start_test',
  STOP: 'stop_test',
});

export const CONTROL_COMMAND_TYPES = Object.freeze({
  TAKEOVER: 'control_takeover',
});

export const AUXILIARY_CONTROL_COMMAND_TYPES = Object.freeze({
  END_SESSION: 'end_session',
  DISPLAY_STATE: 'display_state',
  PREFETCH: 'prefetch',
});

export const RUN_EVENT_TYPES = Object.freeze({
  COMMAND_RECEIVED: 'command_received',
  COMMAND_APPLIED: 'command_applied',
  COMMAND_FAILED: 'command_failed',
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
  POSITION: 'position',
  ENDED: 'ended',
  ERROR: 'error',
  LEVEL: 'level',
});

export const ROUTE_EVENT_TYPES = Object.freeze({
  OUTPUT_DEACTIVATED: 'output_deactivated',
  OUTPUT_READY: 'output_ready',
  OUTPUT_ACTIVATION_FAILED: 'output_activation_failed',
  OUTPUT_DEACTIVATION_FAILED: 'output_deactivation_failed',
});

export const TEST_EVENT_TYPES = Object.freeze({
  TEST_STARTED: 'test_started',
  TEST_MARKER: 'test_marker',
  TEST_COMPLETE: 'test_complete',
  TEST_FAILED: 'test_failed',
});

export const ON_AIR_MESSAGE_FAMILIES = Object.freeze({
  PLAYER_HELLO: 'player_hello',
  CONTROL_HELLO: 'control_hello',
  RUN_COMMAND: 'run_command',
  ROUTE_COMMAND: 'route_command',
  TEST_COMMAND: 'test_command',
  CONTROL_COMMAND: 'control_command',
  AUXILIARY_CONTROL_COMMAND: 'auxiliary_control_command',
  HEARTBEAT: 'heartbeat',
  EMERGENCY_COMMAND: 'emergency_command',
  EMERGENCY_EVENT: 'emergency_event',
  RUN_EVENT: 'run_event',
  ROUTE_EVENT: 'route_event',
  TEST_EVENT: 'test_event',
  PLAYER_WELCOME: 'player_welcome',
  CONTROL_WELCOME: 'control_welcome',
  SERVER_HEARTBEAT_ACK: 'server_heartbeat_ack',
  SERVER_SNAPSHOT: 'server_snapshot',
  SERVER_COMMAND_RESULT: 'server_command_result',
  SERVER_EVENT_RESULT: 'server_event_result',
  SERVER_ERROR: 'server_error',
  SERVER_CONNECTION: 'server_connection',
  SERVER_STATE: 'server_state',
  SERVER_LIFECYCLE: 'server_lifecycle',
  UNKNOWN: 'unknown',
});

/**
 * Independent sequence streams carried by player-originated v2 messages.
 *
 * Receipt and sample telemetry cannot consume an authoritative lifecycle
 * stream: doing so would make a missing meter/position/test marker look like a
 * missing state transition. Test markers therefore have their own ACKed stream
 * while started/complete/failed stay in `test`. The string values are
 * wire/storage policy and therefore intentionally stable.
 */
export const ON_AIR_SEQUENCE_NAMESPACES = Object.freeze({
  HEARTBEAT: 'heartbeat',
  RUN_TELEMETRY: 'runTelemetry',
  RUN_RECEIPT: 'runReceipt',
  RUN_AUTHORITATIVE: 'runAuthoritative',
  ROUTE: 'route',
  TEST: 'test',
  TEST_TELEMETRY: 'testTelemetry',
  EMERGENCY: 'emergency',
});

const RUN_COMMAND_SET = new Set(Object.values(RUN_COMMAND_TYPES));
const ROUTE_COMMAND_SET = new Set(Object.values(ROUTE_COMMAND_TYPES));
const TEST_COMMAND_SET = new Set(Object.values(TEST_COMMAND_TYPES));
const CONTROL_COMMAND_SET = new Set(Object.values(CONTROL_COMMAND_TYPES));
const AUXILIARY_CONTROL_COMMAND_SET = new Set(Object.values(AUXILIARY_CONTROL_COMMAND_TYPES));
const RUN_EVENT_SET = new Set(Object.values(RUN_EVENT_TYPES));
const ROUTE_EVENT_SET = new Set(Object.values(ROUTE_EVENT_TYPES));
const TEST_EVENT_SET = new Set(Object.values(TEST_EVENT_TYPES));
const PLAYER_CLIENT_KIND_SET = new Set(Object.values(PLAYER_CLIENT_KINDS));

const ID_MAX_LENGTH = 256;
const OUTPUT_MODE_SET = new Set(['speaker', 'obs']);
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const ON_AIR_DISPLAY_STATE_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 1_024,
  maxBytes: 48 * 1_024,
});
const KNOWN_PLAYER_CAPABILITIES = Object.freeze([
  'audioWorklet',
  'analyser',
  'sinkSelection',
  'obsRuntime',
  'obsStudioBinding',
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors, path, code) {
  errors.push({ path, code });
}

function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

function inspectJsonValue(value, path, errors, state, depth, ancestors) {
  state.nodes += 1;
  if (state.nodes > ON_AIR_DISPLAY_STATE_LIMITS.maxNodes) {
    if (!state.tooComplex) addError(errors, path, 'json_too_complex');
    state.tooComplex = true;
    return;
  }
  if (depth > ON_AIR_DISPLAY_STATE_LIMITS.maxDepth) {
    addError(errors, path, 'json_too_deep');
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) addError(errors, path, 'invalid_json_number');
    return;
  }
  if (typeof value !== 'object') {
    addError(errors, path, 'invalid_json_value');
    return;
  }
  if (ancestors.has(value)) {
    addError(errors, path, 'json_cycle');
    return;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    addError(errors, path, 'invalid_json_record');
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      inspectJsonValue(value[index], `${path}[${index}]`, errors, state, depth + 1, ancestors);
    }
  } else {
    for (const [field, child] of Object.entries(value)) {
      inspectJsonValue(child, `${path}.${field}`, errors, state, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalizeOnAirDisplayState(display) {
  const errors = [];
  if (!isRecord(display)) {
    addError(errors, 'display', 'required_record');
    return { ok: false, value: null, bytes: null, errors };
  }
  inspectJsonValue(display, 'display', errors, { nodes: 0, tooComplex: false }, 0, new WeakSet());
  if (errors.length > 0) return { ok: false, value: null, bytes: null, errors };
  let serialized;
  try {
    serialized = JSON.stringify(display);
  } catch {
    addError(errors, 'display', 'invalid_json_value');
    return { ok: false, value: null, bytes: null, errors };
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > ON_AIR_DISPLAY_STATE_LIMITS.maxBytes) {
    addError(errors, 'display', 'json_too_large');
    return { ok: false, value: null, bytes, errors };
  }
  return { ok: true, value: freezeJson(JSON.parse(serialized)), bytes, errors };
}

function identifierErrorCode(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'required_identifier';
  if (value !== value.trim()) return 'invalid_identifier';
  if ([...value].some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127)) {
    return 'invalid_identifier';
  }
  if (value.length > ID_MAX_LENGTH) return 'identifier_too_long';
  return null;
}

function requireIdentifier(message, field, errors) {
  const value = message[field];
  const code = identifierErrorCode(value);
  if (code) addError(errors, field, code);
}

function requireNonNegativeInteger(message, field, errors) {
  const value = message[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    addError(errors, field, 'required_non_negative_integer', `${field} must be a non-negative safe integer`);
  }
}

function requireProtocolVersion(message, errors) {
  if (message.protocolVersion !== ON_AIR_PROTOCOL_VERSION) {
    addError(
      errors,
      'protocolVersion',
      'unsupported_protocol_version',
      `protocolVersion must equal ${ON_AIR_PROTOCOL_VERSION}`,
    );
  }
}

function optionalRecord(message, field, errors) {
  if (hasOwn(message, field) && !isRecord(message[field])) {
    addError(errors, field, 'invalid_record', `${field} must be an object when present`);
  }
}

function optionalFiniteNumber(message, field, errors) {
  if (hasOwn(message, field) && !Number.isFinite(message[field])) {
    addError(errors, field, 'invalid_finite_number', `${field} must be a finite number when present`);
  }
}

function optionalBoolean(message, field, errors) {
  if (hasOwn(message, field) && typeof message[field] !== 'boolean') {
    addError(errors, field, 'invalid_boolean', `${field} must be a boolean when present`);
  }
}

function requireRecord(message, field, errors) {
  if (!isRecord(message[field])) {
    addError(errors, field, 'required_record');
    return null;
  }
  return message[field];
}

function requireIdentifierAt(record, field, path, errors) {
  const value = record?.[field];
  const code = identifierErrorCode(value);
  if (code) addError(errors, path, code);
}

function requireFiniteNumberAt(record, field, path, errors, { min = -Infinity, max = Infinity } = {}) {
  const value = record?.[field];
  if (!Number.isFinite(value)) {
    addError(errors, path, 'required_finite_number');
    return;
  }
  if (value < min || value > max) addError(errors, path, 'number_out_of_range');
}

function optionalFiniteNumberAt(record, field, path, errors, { min = -Infinity, max = Infinity } = {}) {
  if (!isRecord(record) || !hasOwn(record, field)) return;
  const value = record[field];
  if (!Number.isFinite(value)) {
    addError(errors, path, 'invalid_finite_number');
    return;
  }
  if (value < min || value > max) addError(errors, path, 'number_out_of_range');
}

function requireNonNegativeIntegerAt(record, field, path, errors) {
  const value = record?.[field];
  if (!Number.isSafeInteger(value) || value < 0) addError(errors, path, 'required_non_negative_integer');
}

function requireBooleanValueAt(record, field, expected, path, errors) {
  if (record?.[field] !== expected) addError(errors, path, 'invalid_postcondition');
}

function requireErrorCode(message, errors) {
  requireIdentifier(message, 'code', errors);
}

function forbidFields(message, fields, errors, family) {
  for (const field of fields) {
    if (hasOwn(message, field)) {
      addError(
        errors,
        field,
        'foreign_identity_field',
        `${field} does not belong to the ${family} identity`,
      );
    }
  }
}

function forbidUnexpectedFields(message, allowedFields, errors) {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(message)) {
    if (!allowed.has(field)) addError(errors, field, 'unexpected_field');
  }
}

function validatePlayerHello(message, errors) {
  requireProtocolVersion(message, errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireIdentifier(message, 'buildId', errors);

  if (!PLAYER_CLIENT_KIND_SET.has(message.clientKind)) {
    addError(errors, 'clientKind', 'invalid_client_kind', 'clientKind is not a supported player kind');
  }

  if (!isRecord(message.capabilities)) {
    addError(errors, 'capabilities', 'required_record', 'capabilities must be an object');
    return;
  }

  for (const capability of KNOWN_PLAYER_CAPABILITIES) {
    if (hasOwn(message.capabilities, capability) && typeof message.capabilities[capability] !== 'boolean') {
      addError(
        errors,
        `capabilities.${capability}`,
        'invalid_boolean',
        `capabilities.${capability} must be a boolean when present`,
      );
    }
  }
}

function validateControlHello(message, errors) {
  requireProtocolVersion(message, errors);
  requireIdentifier(message, 'controlInstanceId', errors);
  requireIdentifier(message, 'buildId', errors);
  optionalRecord(message, 'capabilities', errors);
  // Registration/reconnect is never an implicit request to steal the control lease.
  forbidFields(
    message,
    ['commandId', 'controlEpoch', 'expectedControlEpoch', 'takeover', 'requestTakeover'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.CONTROL_HELLO,
  );
}

function validateRunCommandPayload(message, errors) {
  if (message.type === RUN_COMMAND_TYPES.LOAD) {
    const payload = requireRecord(message, 'payload', errors);
    if (!payload) return;
    if (!isRecord(payload.song)) addError(errors, 'payload.song', 'required_record');
    optionalFiniteNumberAt(payload, 'position', 'payload.position', errors, { min: 0 });
    optionalFiniteNumberAt(payload, 'volume', 'payload.volume', errors, { min: 0, max: 100 });
    return;
  }

  if (message.type === RUN_COMMAND_TYPES.SEEK) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload) requireFiniteNumberAt(payload, 'position', 'payload.position', errors, { min: 0 });
    return;
  }

  if (message.type === RUN_COMMAND_TYPES.VOLUME) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload) requireFiniteNumberAt(payload, 'volume', 'payload.volume', errors, { min: 0, max: 100 });
    return;
  }

  optionalRecord(message, 'payload', errors);
}

function validateRunCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'entryId', errors);
  requireIdentifier(message, 'runId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  requireIdentifier(message, 'targetPlayerInstanceId', errors);
  requireNonNegativeInteger(message, 'controlEpoch', errors);
  validateRunCommandPayload(message, errors);
  forbidFields(message, ['switchId', 'checkId', 'targetConnectionId'], errors, ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND);
}

function validateRouteCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'switchId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  requireIdentifier(message, 'targetPlayerInstanceId', errors);
  requireNonNegativeInteger(message, 'controlEpoch', errors);
  if (message.type === ROUTE_COMMAND_TYPES.ACTIVATE) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload && !OUTPUT_MODE_SET.has(payload.outputMode)) {
      addError(errors, 'payload.outputMode', 'invalid_output_mode');
    }
  } else {
    optionalRecord(message, 'payload', errors);
  }
  forbidFields(
    message,
    ['entryId', 'runId', 'checkId', 'targetConnectionId'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND,
  );
}

function validateTestCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'checkId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  requireIdentifier(message, 'targetPlayerInstanceId', errors);
  requireNonNegativeInteger(message, 'controlEpoch', errors);
  if (message.type === TEST_COMMAND_TYPES.START) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload) {
      requireIdentifierAt(payload, 'fixtureId', 'payload.fixtureId', errors);
      requireFiniteNumberAt(payload, 'durationMs', 'payload.durationMs', errors, { min: 1_000, max: 10_000 });
      if (Number.isFinite(payload.durationMs)
        && payload.durationMs >= 1_000 && payload.durationMs <= 10_000
        && !Number.isSafeInteger(payload.durationMs)) {
        addError(errors, 'payload.durationMs', 'required_safe_integer');
      }
    }
  } else {
    optionalRecord(message, 'payload', errors);
  }
  forbidFields(
    message,
    ['entryId', 'runId', 'switchId', 'targetConnectionId'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND,
  );
}

function validateControlCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'controlInstanceId', errors);
  requireNonNegativeInteger(message, 'expectedControlEpoch', errors);
  optionalRecord(message, 'payload', errors);
  forbidFields(
    message,
    [
      'entryId',
      'runId',
      'switchId',
      'checkId',
      'leaseEpoch',
      'controlEpoch',
      'targetPlayerInstanceId',
      'targetConnectionId',
    ],
    errors,
    ON_AIR_MESSAGE_FAMILIES.CONTROL_COMMAND,
  );
}

function validateAuxiliaryControlCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireNonNegativeInteger(message, 'controlEpoch', errors);

  if (message.type === AUXILIARY_CONTROL_COMMAND_TYPES.END_SESSION) {
    if (hasOwn(message, 'payload')) {
      const payload = requireRecord(message, 'payload', errors);
      if (payload && Object.keys(payload).length > 0) addError(errors, 'payload', 'payload_not_empty');
    }
  } else if (message.type === AUXILIARY_CONTROL_COMMAND_TYPES.DISPLAY_STATE) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload) {
      if (!isRecord(payload.display)) {
        addError(errors, 'payload.display', 'required_record');
      } else {
        const displayValidation = canonicalizeOnAirDisplayState(payload.display);
        for (const error of displayValidation.errors) {
          addError(errors, `payload.${error.path}`, error.code);
        }
      }
      for (const field of Object.keys(payload)) {
        if (field !== 'display') addError(errors, `payload.${field}`, 'unexpected_field');
      }
    }
  } else if (message.type === AUXILIARY_CONTROL_COMMAND_TYPES.PREFETCH) {
    const payload = requireRecord(message, 'payload', errors);
    if (payload) {
      if (!Array.isArray(payload.videoIds)) {
        addError(errors, 'payload.videoIds', 'required_array');
      } else {
        if (payload.videoIds.length > 2) addError(errors, 'payload.videoIds', 'array_too_long');
        for (let index = 0; index < payload.videoIds.length; index += 1) {
          if (typeof payload.videoIds[index] !== 'string'
            || !YOUTUBE_VIDEO_ID_PATTERN.test(payload.videoIds[index])) {
            addError(errors, `payload.videoIds[${index}]`, 'invalid_youtube_video_id');
          }
        }
      }
      for (const field of Object.keys(payload)) {
        if (field !== 'videoIds') addError(errors, `payload.${field}`, 'unexpected_field');
      }
    }
  }

  forbidFields(
    message,
    [
      'entryId',
      'runId',
      'switchId',
      'checkId',
      'leaseEpoch',
      'targetPlayerInstanceId',
      'targetConnectionId',
      'controlInstanceId',
      'expectedControlEpoch',
    ],
    errors,
    ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND,
  );
}

function validateHeartbeat(message, errors) {
  requireIdentifier(message, 'playerInstanceId', errors);
  requireIdentifier(message, 'connectionId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  requireNonNegativeInteger(message, 'sequence', errors);
  optionalFiniteNumber(message, 'monotonicTimeMs', errors);
  if (Number.isFinite(message.monotonicTimeMs) && message.monotonicTimeMs < 0) {
    addError(errors, 'monotonicTimeMs', 'number_out_of_range');
  }
  forbidFields(
    message,
    [
      'entryId', 'runId', 'switchId', 'checkId', 'controlEpoch',
      'targetPlayerInstanceId', 'targetConnectionId',
    ],
    errors,
    ON_AIR_MESSAGE_FAMILIES.HEARTBEAT,
  );
}

function validateEmergencyCommand(message, errors) {
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'sessionId', errors);
  requireIdentifier(message, 'authenticatedControlInstanceId', errors);
  optionalRecord(message, 'payload', errors);
  forbidFields(
    message,
    [
      'entryId',
      'runId',
      'switchId',
      'checkId',
      'leaseEpoch',
      'controlEpoch',
      'targetPlayerInstanceId',
      'targetConnectionId',
    ],
    errors,
    ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND,
  );
}

function validateEmergencyEvent(message, errors) {
  requireIdentifier(message, 'eventId', errors);
  requireIdentifier(message, 'commandId', errors);
  requireIdentifier(message, 'sessionId', errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireIdentifier(message, 'connectionId', errors);
  requireNonNegativeInteger(message, 'sequence', errors);
  requireFiniteNumberAt(message, 'monotonicTimeMs', 'monotonicTimeMs', errors, { min: 0 });
  const postcondition = requireRecord(message, 'postcondition', errors);
  if (postcondition) {
    requireBooleanValueAt(postcondition, 'mediaPaused', true, 'postcondition.mediaPaused', errors);
    requireBooleanValueAt(postcondition, 'sourceDetached', true, 'postcondition.sourceDetached', errors);
    requireBooleanValueAt(postcondition, 'autoplayCancelled', true, 'postcondition.autoplayCancelled', errors);
  }
  forbidFields(
    message,
    [
      'entryId', 'runId', 'switchId', 'checkId', 'leaseEpoch', 'controlEpoch',
      'targetPlayerInstanceId', 'targetConnectionId',
    ],
    errors,
    ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT,
  );
}

function validateEventBase(message, errors) {
  requireIdentifier(message, 'eventId', errors);
  requireNonNegativeInteger(message, 'sequence', errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireIdentifier(message, 'connectionId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  optionalIdentifier(message, 'commandId', errors);
  requireFiniteNumberAt(message, 'monotonicTimeMs', 'monotonicTimeMs', errors, { min: 0 });
}

function optionalIdentifier(message, field, errors) {
  if (!hasOwn(message, field)) return;
  requireIdentifier(message, field, errors);
}

function validatePlaybackTelemetry(message, errors) {
  for (const field of ['mediaTime', 'duration', 'bufferedEnd', 'rmsDbfs', 'peakDbfs']) {
    optionalFiniteNumber(message, field, errors);
  }
  for (const field of ['paused', 'seeking']) optionalBoolean(message, field, errors);

  if (
    hasOwn(message, 'readyState')
    && (!Number.isInteger(message.readyState) || message.readyState < 0 || message.readyState > 4)
  ) {
    addError(errors, 'readyState', 'invalid_ready_state', 'readyState must be an integer from 0 through 4');
  }
}

function requirePlaybackTime(message, errors) {
  requireFiniteNumberAt(message, 'mediaTime', 'mediaTime', errors, { min: 0 });
}

const STRONG_STOP_POSTCONDITION_FIELDS = Object.freeze([
  'status',
  'mediaPaused',
  'sourceDetached',
  'autoplayCancelled',
  'audible',
]);
const APPLIED_SEEK_POSTCONDITION_FIELDS = Object.freeze(['status', 'position']);
const APPLIED_VOLUME_POSTCONDITION_FIELDS = Object.freeze(['status', 'volume']);

function validateStrongStopPostcondition(postcondition, path, errors) {
  requireIdentifierAt(postcondition, 'status', `${path}.status`, errors);
  if (postcondition?.status !== 'stopped') {
    addError(errors, `${path}.status`, 'invalid_postcondition');
  }
  requireBooleanValueAt(postcondition, 'mediaPaused', true, `${path}.mediaPaused`, errors);
  requireBooleanValueAt(postcondition, 'sourceDetached', true, `${path}.sourceDetached`, errors);
  requireBooleanValueAt(
    postcondition,
    'autoplayCancelled',
    true,
    `${path}.autoplayCancelled`,
    errors,
  );
  requireBooleanValueAt(postcondition, 'audible', false, `${path}.audible`, errors);
  if (isRecord(postcondition)) {
    forbidUnexpectedFields(postcondition, STRONG_STOP_POSTCONDITION_FIELDS, errors);
  }
}

function validateAppliedSeekPostcondition(postcondition, path, errors) {
  requireIdentifierAt(postcondition, 'status', `${path}.status`, errors);
  requireFiniteNumberAt(postcondition, 'position', `${path}.position`, errors, { min: 0 });
  if (isRecord(postcondition)) {
    forbidUnexpectedFields(postcondition, APPLIED_SEEK_POSTCONDITION_FIELDS, errors);
  }
}

function validateAppliedVolumePostcondition(postcondition, path, errors) {
  requireIdentifierAt(postcondition, 'status', `${path}.status`, errors);
  requireFiniteNumberAt(postcondition, 'volume', `${path}.volume`, errors, { min: 0, max: 100 });
  if (isRecord(postcondition)) {
    forbidUnexpectedFields(postcondition, APPLIED_VOLUME_POSTCONDITION_FIELDS, errors);
  }
}

function validateRunEventPostcondition(message, errors) {
  switch (message.event) {
    case RUN_EVENT_TYPES.COMMAND_RECEIVED:
      requireIdentifier(message, 'commandId', errors);
      break;
    case RUN_EVENT_TYPES.COMMAND_APPLIED: {
      requireIdentifier(message, 'commandId', errors);
      const postcondition = requireRecord(message, 'postcondition', errors);
      if (postcondition) {
        requireIdentifierAt(postcondition, 'status', 'postcondition.status', errors);
        const claimsStopped = postcondition.status === 'stopped';
        const claimsPosition = hasOwn(postcondition, 'position');
        const claimsVolume = hasOwn(postcondition, 'volume');
        if (claimsStopped) {
          if (message.commandType !== 'STOP') {
            addError(errors, 'commandType', 'invalid_stop_command_type');
          }
          validateStrongStopPostcondition(postcondition, 'postcondition', errors);
        } else if (hasOwn(message, 'commandType')) {
          if (message.commandType === 'SEEK') {
            validateAppliedSeekPostcondition(postcondition, 'postcondition', errors);
          } else if (message.commandType === 'VOLUME') {
            validateAppliedVolumePostcondition(postcondition, 'postcondition', errors);
          } else if (message.commandType === 'STOP') {
            validateStrongStopPostcondition(postcondition, 'postcondition', errors);
          } else {
            addError(errors, 'commandType', 'invalid_applied_command_type');
          }
        } else if (claimsPosition) {
          addError(errors, 'commandType', 'invalid_seek_command_type');
          validateAppliedSeekPostcondition(postcondition, 'postcondition', errors);
        } else if (claimsVolume) {
          addError(errors, 'commandType', 'invalid_volume_command_type');
          validateAppliedVolumePostcondition(postcondition, 'postcondition', errors);
        }
      }
      break;
    }
    case RUN_EVENT_TYPES.COMMAND_FAILED:
      requireIdentifier(message, 'commandId', errors);
      requireErrorCode(message, errors);
      optionalRecord(message, 'detail', errors);
      optionalRecord(message, 'safetyPostcondition', errors);
      if (isRecord(message.safetyPostcondition)) {
        validateStrongStopPostcondition(
          message.safetyPostcondition,
          'safetyPostcondition',
          errors,
        );
      }
      break;
    case RUN_EVENT_TYPES.READY:
      requirePlaybackTime(message, errors);
      requireFiniteNumberAt(message, 'duration', 'duration', errors, { min: 0 });
      if (!Number.isInteger(message.readyState) || message.readyState < 2 || message.readyState > 4) {
        addError(errors, 'readyState', 'ready_state_not_playable');
      }
      requireBooleanValueAt(message, 'paused', true, 'paused', errors);
      break;
    case RUN_EVENT_TYPES.PLAYING:
      requirePlaybackTime(message, errors);
      requireBooleanValueAt(message, 'paused', false, 'paused', errors);
      break;
    case RUN_EVENT_TYPES.PAUSED:
      requirePlaybackTime(message, errors);
      requireBooleanValueAt(message, 'paused', true, 'paused', errors);
      break;
    case RUN_EVENT_TYPES.BUFFERING:
      requirePlaybackTime(message, errors);
      if (!Number.isInteger(message.readyState) || message.readyState < 0 || message.readyState > 3) {
        addError(errors, 'readyState', 'ready_state_not_buffering');
      }
      break;
    case RUN_EVENT_TYPES.POSITION:
      requirePlaybackTime(message, errors);
      requireFiniteNumberAt(message, 'duration', 'duration', errors, { min: 0 });
      if (!Number.isInteger(message.readyState) || message.readyState < 0 || message.readyState > 4) {
        addError(errors, 'readyState', 'invalid_ready_state');
      }
      if (typeof message.paused !== 'boolean') addError(errors, 'paused', 'required_boolean');
      if (typeof message.seeking !== 'boolean') addError(errors, 'seeking', 'required_boolean');
      break;
    case RUN_EVENT_TYPES.ENDED:
      requirePlaybackTime(message, errors);
      requireFiniteNumberAt(message, 'duration', 'duration', errors, { min: 0 });
      requireBooleanValueAt(message, 'paused', true, 'paused', errors);
      break;
    case RUN_EVENT_TYPES.ERROR:
      requireErrorCode(message, errors);
      optionalRecord(message, 'detail', errors);
      break;
    case RUN_EVENT_TYPES.LEVEL:
      requireFiniteNumberAt(message, 'rmsDbfs', 'rmsDbfs', errors);
      requireFiniteNumberAt(message, 'peakDbfs', 'peakDbfs', errors);
      if (Number.isFinite(message.rmsDbfs)
        && Number.isFinite(message.peakDbfs)
        && message.peakDbfs < message.rmsDbfs) {
        addError(errors, 'peakDbfs', 'peak_below_rms');
      }
      break;
    default:
      break;
  }
}

function validateRunEvent(message, errors) {
  validateEventBase(message, errors);
  requireIdentifier(message, 'entryId', errors);
  requireIdentifier(message, 'runId', errors);
  if (!RUN_EVENT_SET.has(message.event)) {
    addError(errors, 'event', 'invalid_run_event', 'event is not a supported run event');
  }
  validatePlaybackTelemetry(message, errors);
  validateRunEventPostcondition(message, errors);
  if (hasOwn(message, 'commandType') && message.event !== RUN_EVENT_TYPES.COMMAND_APPLIED) {
    addError(errors, 'commandType', 'unexpected_field');
  }
  if (hasOwn(message, 'safetyPostcondition')
    && message.event !== RUN_EVENT_TYPES.COMMAND_FAILED) {
    addError(errors, 'safetyPostcondition', 'unexpected_field');
  }
  forbidFields(
    message,
    ['switchId', 'checkId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.RUN_EVENT,
  );
}

function validateRouteEvent(message, errors) {
  validateEventBase(message, errors);
  requireIdentifier(message, 'switchId', errors);
  if (!ROUTE_EVENT_SET.has(message.event)) {
    addError(errors, 'event', 'invalid_route_event', 'event is not a supported route event');
  }
  if (message.event === ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATED) {
    const postcondition = requireRecord(message, 'postcondition', errors);
    if (postcondition) {
      requireBooleanValueAt(postcondition, 'mediaPaused', true, 'postcondition.mediaPaused', errors);
      requireBooleanValueAt(postcondition, 'sourceDetached', true, 'postcondition.sourceDetached', errors);
      requireBooleanValueAt(postcondition, 'autoplayCancelled', true, 'postcondition.autoplayCancelled', errors);
    }
  } else if (message.event === ROUTE_EVENT_TYPES.OUTPUT_READY) {
    const postcondition = requireRecord(message, 'postcondition', errors);
    if (postcondition) {
      requireBooleanValueAt(postcondition, 'mediaPaused', true, 'postcondition.mediaPaused', errors);
      requireBooleanValueAt(postcondition, 'sourceDetached', true, 'postcondition.sourceDetached', errors);
      requireBooleanValueAt(postcondition, 'autoplayCancelled', true, 'postcondition.autoplayCancelled', errors);
      requireBooleanValueAt(postcondition, 'outputPathReady', true, 'postcondition.outputPathReady', errors);
      requireBooleanValueAt(postcondition, 'audible', false, 'postcondition.audible', errors);
      forbidUnexpectedFields(postcondition, [
        'mediaPaused',
        'sourceDetached',
        'autoplayCancelled',
        'outputPathReady',
        'audible',
      ], errors);
    }
  } else if ([
    ROUTE_EVENT_TYPES.OUTPUT_ACTIVATION_FAILED,
    ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED,
  ].includes(message.event)) {
    requireErrorCode(message, errors);
    optionalRecord(message, 'detail', errors);
    if (message.event === ROUTE_EVENT_TYPES.OUTPUT_DEACTIVATION_FAILED) {
      optionalRecord(message, 'postcondition', errors);
      const postcondition = isRecord(message.postcondition) ? message.postcondition : null;
      if (postcondition) {
        const allowedFields = ['mediaPaused', 'sourceDetached', 'autoplayCancelled', 'audible'];
        for (const field of allowedFields) {
          if (hasOwn(postcondition, field) && typeof postcondition[field] !== 'boolean') {
            addError(errors, `postcondition.${field}`, 'invalid_boolean');
          }
        }
        forbidUnexpectedFields(postcondition, allowedFields, errors);
        if (postcondition.mediaPaused === true
          && postcondition.sourceDetached === true
          && postcondition.autoplayCancelled === true
          && postcondition.audible === false) {
          addError(
            errors,
            'postcondition',
            'contradictory_failure_postcondition',
            'output_deactivation_failed cannot report the complete successful deactivation postcondition',
          );
        }
      }
    }
  }
  forbidFields(
    message,
    ['entryId', 'runId', 'checkId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT,
  );
}

function validateTestEvent(message, errors) {
  validateEventBase(message, errors);
  requireIdentifier(message, 'checkId', errors);
  if (!TEST_EVENT_SET.has(message.event)) {
    addError(errors, 'event', 'invalid_test_event', 'event is not a supported test event');
  }
  if (message.event === TEST_EVENT_TYPES.TEST_MARKER) {
    requireNonNegativeInteger(message, 'markerIndex', errors);
    requireFiniteNumberAt(message, 'markerTimeMs', 'markerTimeMs', errors, { min: 0 });
  } else if (message.event === TEST_EVENT_TYPES.TEST_COMPLETE) {
    requireNonNegativeInteger(message, 'markerCount', errors);
    const postcondition = requireRecord(message, 'postcondition', errors);
    if (postcondition) requireBooleanValueAt(postcondition, 'stopped', true, 'postcondition.stopped', errors);
  } else if (message.event === TEST_EVENT_TYPES.TEST_FAILED) {
    requireErrorCode(message, errors);
    optionalRecord(message, 'detail', errors);
    optionalRecord(message, 'safetyPostcondition', errors);
    if (isRecord(message.safetyPostcondition)) {
      validateStrongStopPostcondition(
        message.safetyPostcondition,
        'safetyPostcondition',
        errors,
      );
    }
  }
  optionalFiniteNumber(message, 'markerTimeMs', errors);
  optionalFiniteNumber(message, 'rmsDbfs', errors);
  optionalFiniteNumber(message, 'peakDbfs', errors);
  forbidFields(
    message,
    ['entryId', 'runId', 'switchId', 'controlEpoch', 'targetPlayerInstanceId', 'targetConnectionId'],
    errors,
    ON_AIR_MESSAGE_FAMILIES.TEST_EVENT,
  );
  if (hasOwn(message, 'safetyPostcondition')
    && message.event !== TEST_EVENT_TYPES.TEST_FAILED) {
    addError(errors, 'safetyPostcondition', 'unexpected_field');
  }
}

function validateNullableIdentifierAt(record, field, path, errors) {
  if (record?.[field] === null) return;
  requireIdentifierAt(record, field, path, errors);
}

function validateServerBase(message, errors) {
  requireProtocolVersion(message, errors);
}

function validatePlayerWelcome(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'connectionId', errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  validateNullableIdentifierAt(message, 'leaseTarget', 'leaseTarget', errors);
  requireIdentifier(message, 'leaseStatus', errors);
}

function validateControlWelcome(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'connectionId', errors);
  requireIdentifier(message, 'controlInstanceId', errors);
  if (typeof message.writable !== 'boolean') addError(errors, 'writable', 'required_boolean');
  requireNonNegativeInteger(message, 'controlEpoch', errors);
  validateNullableIdentifierAt(
    message,
    'writableControlInstanceId',
    'writableControlInstanceId',
    errors,
  );
  requireIdentifier(message, 'code', errors);
  if (message.writable === true && message.writableControlInstanceId !== message.controlInstanceId) {
    addError(errors, 'writableControlInstanceId', 'writable_owner_mismatch');
  }
}

function validateServerHeartbeatAck(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireIdentifier(message, 'connectionId', errors);
  requireNonNegativeInteger(message, 'leaseEpoch', errors);
  requireNonNegativeInteger(message, 'sequence', errors);
  forbidUnexpectedFields(message, [
    'type',
    'protocolVersion',
    'playerInstanceId',
    'connectionId',
    'leaseEpoch',
    'sequence',
  ], errors);
}

function validateIdentifierArray(record, field, path, errors) {
  const values = record?.[field];
  if (!Array.isArray(values)) {
    addError(errors, path, 'required_array');
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    requireIdentifierAt({ value: values[index] }, 'value', `${path}[${index}]`, errors);
  }
}

function validateSnapshotPlayer(player, index, errors) {
  const path = `players[${index}]`;
  if (!isRecord(player)) {
    addError(errors, path, 'required_record');
    return;
  }
  requireIdentifierAt(player, 'playerInstanceId', `${path}.playerInstanceId`, errors);
  requireIdentifierAt(player, 'connectionId', `${path}.connectionId`, errors);
  if (!PLAYER_CLIENT_KIND_SET.has(player.clientKind)) addError(errors, `${path}.clientKind`, 'invalid_client_kind');
  requireIdentifierAt(player, 'state', `${path}.state`, errors);
  requireFiniteNumberAt(player, 'lastSeenAt', `${path}.lastSeenAt`, errors, { min: 0 });
  if (typeof player.heartbeatStale !== 'boolean') addError(errors, `${path}.heartbeatStale`, 'required_boolean');
  requireIdentifierAt(player, 'buildId', `${path}.buildId`, errors);
  if (!isRecord(player.capabilities)) addError(errors, `${path}.capabilities`, 'required_record');
  if (!isRecord(player.runtime)) addError(errors, `${path}.runtime`, 'required_record');
}

function validateServerSnapshot(message, errors) {
  validateServerBase(message, errors);
  if (message.selectedOutputMode !== null && !OUTPUT_MODE_SET.has(message.selectedOutputMode)) {
    addError(errors, 'selectedOutputMode', 'invalid_output_mode');
  }

  if (!Array.isArray(message.players)) {
    addError(errors, 'players', 'required_array');
  } else {
    message.players.forEach((player, index) => validateSnapshotPlayer(player, index, errors));
  }

  const candidates = requireRecord(message, 'eligibleCandidates', errors);
  if (candidates) {
    validateIdentifierArray(candidates, 'speaker', 'eligibleCandidates.speaker', errors);
    validateIdentifierArray(candidates, 'obs', 'eligibleCandidates.obs', errors);
  }

  const lease = requireRecord(message, 'lease', errors);
  if (lease) {
    requireNonNegativeIntegerAt(lease, 'epoch', 'lease.epoch', errors);
    validateNullableIdentifierAt(lease, 'leaseTarget', 'lease.leaseTarget', errors);
    if (lease.clientKind !== null && !PLAYER_CLIENT_KIND_SET.has(lease.clientKind)) {
      addError(errors, 'lease.clientKind', 'invalid_client_kind');
    }
    requireIdentifierAt(lease, 'status', 'lease.status', errors);
    validateNullableIdentifierAt(lease, 'switchId', 'lease.switchId', errors);
  }

  const controlLease = requireRecord(message, 'controlLease', errors);
  if (controlLease) {
    requireNonNegativeIntegerAt(controlLease, 'controlEpoch', 'controlLease.controlEpoch', errors);
    validateNullableIdentifierAt(
      controlLease,
      'writableControlInstanceId',
      'controlLease.writableControlInstanceId',
      errors,
    );
    if (typeof controlLease.writableConnected !== 'boolean') {
      addError(errors, 'controlLease.writableConnected', 'required_boolean');
    }
  }

  if (message.activeFamily !== null) {
    const activeFamily = requireRecord(message, 'activeFamily', errors);
    if (activeFamily) {
      requireIdentifierAt(activeFamily, 'entryId', 'activeFamily.entryId', errors);
      requireIdentifierAt(activeFamily, 'runId', 'activeFamily.runId', errors);
      forbidUnexpectedFields(activeFamily, ['entryId', 'runId'], errors);
    }
  }
  validateNullableIdentifierAt(message, 'activeCheckId', 'activeCheckId', errors);
  if (isRecord(message.activeFamily) && message.activeCheckId !== null) {
    addError(errors, 'activeCheckId', 'active_family_conflict');
  }

  if (!isRecord(message.desiredTransport)) addError(errors, 'desiredTransport', 'required_record');
  if (!isRecord(message.confirmedPlayback)) addError(errors, 'confirmedPlayback', 'required_record');
}

function validateServerCommandResult(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'commandId', errors);
  if (message.type === SERVER_MESSAGE_TYPES.COMMAND_REJECTED) {
    requireIdentifier(message, 'code', errors);
    if (!isRecord(message.detail)) addError(errors, 'detail', 'required_record');
  } else {
    optionalIdentifier(message, 'code', errors);
    if (hasOwn(message, 'controlEpoch')) requireNonNegativeInteger(message, 'controlEpoch', errors);
    if (hasOwn(message, 'leaseEpoch')) requireNonNegativeInteger(message, 'leaseEpoch', errors);
    optionalIdentifier(message, 'writableControlInstanceId', errors);
  }
}

function validateServerEventResult(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'eventId', errors);
  requireIdentifier(message, 'playerInstanceId', errors);
  requireNonNegativeInteger(message, 'sequence', errors);
  if (!['applied', 'relayed', 'duplicate'].includes(message.status)) {
    addError(errors, 'status', 'invalid_event_ack_status');
  }
}

function validateServerError(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'code', errors);
  if (!isRecord(message.detail)) addError(errors, 'detail', 'required_record');
}

function validateServerConnection(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'code', errors);
}

function validateServerState(message, errors) {
  validateServerBase(message, errors);
  if (message.type === SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT) {
    if (!isRecord(message.desiredTransport)) addError(errors, 'desiredTransport', 'required_record');
    return;
  }

  if (!['player', 'control', 'display'].includes(message.role)) addError(errors, 'role', 'invalid_role');
  if (typeof message.connected !== 'boolean') addError(errors, 'connected', 'required_boolean');
  if (message.role === 'player') {
    requireIdentifier(message, 'playerInstanceId', errors);
    if (!PLAYER_CLIENT_KIND_SET.has(message.clientKind)) addError(errors, 'clientKind', 'invalid_client_kind');
  }
}

function validateServerLifecycle(message, errors) {
  validateServerBase(message, errors);
  requireIdentifier(message, 'reasonCode', errors);
  requireFiniteNumberAt(message, 'cleanupAt', 'cleanupAt', errors, { min: 0 });
}

/** Return the discriminated protocol family without validating the remaining fields. */
export function getOnAirMessageFamily(message) {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return ON_AIR_MESSAGE_FAMILIES.UNKNOWN;
  }

  if (RUN_COMMAND_SET.has(message.type)) return ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND;
  if (ROUTE_COMMAND_SET.has(message.type)) return ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND;
  if (TEST_COMMAND_SET.has(message.type)) return ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND;
  if (CONTROL_COMMAND_SET.has(message.type)) return ON_AIR_MESSAGE_FAMILIES.CONTROL_COMMAND;
  if (AUXILIARY_CONTROL_COMMAND_SET.has(message.type)) {
    return ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND;
  }

  switch (message.type) {
    case ON_AIR_MESSAGE_TYPES.PLAYER_HELLO:
      return ON_AIR_MESSAGE_FAMILIES.PLAYER_HELLO;
    case ON_AIR_MESSAGE_TYPES.CONTROL_HELLO:
      return ON_AIR_MESSAGE_FAMILIES.CONTROL_HELLO;
    case ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT:
      return ON_AIR_MESSAGE_FAMILIES.HEARTBEAT;
    case ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP:
      return ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND;
    case ON_AIR_MESSAGE_TYPES.EMERGENCY_STOP_ACK:
      return ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT;
    case ON_AIR_MESSAGE_TYPES.PLAYBACK_EVENT:
      return ON_AIR_MESSAGE_FAMILIES.RUN_EVENT;
    case ON_AIR_MESSAGE_TYPES.ROUTE_EVENT:
      return ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT;
    case ON_AIR_MESSAGE_TYPES.TEST_EVENT:
      return ON_AIR_MESSAGE_FAMILIES.TEST_EVENT;
    case SERVER_MESSAGE_TYPES.PLAYER_WELCOME:
      return ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME;
    case SERVER_MESSAGE_TYPES.CONTROL_WELCOME:
      return ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME;
    case SERVER_MESSAGE_TYPES.HEARTBEAT_ACK:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_HEARTBEAT_ACK;
    case SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT;
    case SERVER_MESSAGE_TYPES.COMMAND_ACK:
    case SERVER_MESSAGE_TYPES.COMMAND_REJECTED:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT;
    case SERVER_MESSAGE_TYPES.EVENT_ACK:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_EVENT_RESULT;
    case SERVER_MESSAGE_TYPES.PROTOCOL_ERROR:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_ERROR;
    case SERVER_MESSAGE_TYPES.CONNECTION_SUPERSEDED:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_CONNECTION;
    case SERVER_MESSAGE_TYPES.DESIRED_TRANSPORT:
    case SERVER_MESSAGE_TYPES.PRESENCE:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_STATE;
    case SERVER_MESSAGE_TYPES.SESSION_ENDED:
      return ON_AIR_MESSAGE_FAMILIES.SERVER_LIFECYCLE;
    default:
      return ON_AIR_MESSAGE_FAMILIES.UNKNOWN;
  }
}

/**
 * Return the monotonic sequence namespace for a player-originated message.
 * This helper is deliberately pure and does not validate the rest of the
 * message; callers should validate before applying a sequence observation.
 */
export function getOnAirSequenceNamespace(message) {
  const family = getOnAirMessageFamily(message);
  if (family === ON_AIR_MESSAGE_FAMILIES.HEARTBEAT) {
    return ON_AIR_SEQUENCE_NAMESPACES.HEARTBEAT;
  }
  if (family === ON_AIR_MESSAGE_FAMILIES.RUN_EVENT) {
    if ([RUN_EVENT_TYPES.POSITION, RUN_EVENT_TYPES.LEVEL].includes(message.event)) {
      return ON_AIR_SEQUENCE_NAMESPACES.RUN_TELEMETRY;
    }
    if (message.event === RUN_EVENT_TYPES.COMMAND_RECEIVED) {
      return ON_AIR_SEQUENCE_NAMESPACES.RUN_RECEIPT;
    }
    return ON_AIR_SEQUENCE_NAMESPACES.RUN_AUTHORITATIVE;
  }
  if (family === ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT) {
    return ON_AIR_SEQUENCE_NAMESPACES.ROUTE;
  }
  if (family === ON_AIR_MESSAGE_FAMILIES.TEST_EVENT) {
    return message.event === TEST_EVENT_TYPES.TEST_MARKER
      ? ON_AIR_SEQUENCE_NAMESPACES.TEST_TELEMETRY
      : ON_AIR_SEQUENCE_NAMESPACES.TEST;
  }
  if (family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT) {
    return ON_AIR_SEQUENCE_NAMESPACES.EMERGENCY;
  }
  return null;
}

/**
 * Validate an already-parsed protocol value.
 *
 * Unknown extension fields are allowed, but identity fields from a different
 * family are rejected. This keeps idle route/test/heartbeat messages free from
 * fabricated entryId/runId values while preserving forward-compatible payloads.
 */
export function validateOnAirMessage(message) {
  const errors = [];
  const family = getOnAirMessageFamily(message);

  if (!isRecord(message)) {
    addError(errors, '$', 'expected_object', 'message must be an object');
    return { ok: false, family, errors };
  }

  if (typeof message.type !== 'string' || message.type.length === 0) {
    addError(errors, 'type', 'required_type', 'type must be a non-empty string');
    return { ok: false, family, errors };
  }

  switch (family) {
    case ON_AIR_MESSAGE_FAMILIES.PLAYER_HELLO:
      validatePlayerHello(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.CONTROL_HELLO:
      validateControlHello(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND:
      validateRunCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND:
      validateRouteCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND:
      validateTestCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.CONTROL_COMMAND:
      validateControlCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND:
      validateAuxiliaryControlCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.HEARTBEAT:
      validateHeartbeat(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND:
      validateEmergencyCommand(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT:
      validateEmergencyEvent(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.RUN_EVENT:
      validateRunEvent(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT:
      validateRouteEvent(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.TEST_EVENT:
      validateTestEvent(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME:
      validatePlayerWelcome(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME:
      validateControlWelcome(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_HEARTBEAT_ACK:
      validateServerHeartbeatAck(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT:
      validateServerSnapshot(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT:
      validateServerCommandResult(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_EVENT_RESULT:
      validateServerEventResult(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_ERROR:
      validateServerError(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_CONNECTION:
      validateServerConnection(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_STATE:
      validateServerState(message, errors);
      break;
    case ON_AIR_MESSAGE_FAMILIES.SERVER_LIFECYCLE:
      validateServerLifecycle(message, errors);
      break;
    default:
      addError(errors, 'type', 'unknown_message_type', `unknown On-Air message type: ${message.type}`);
  }

  return { ok: errors.length === 0, family, errors };
}

const PLAYER_TARGETED_COMMAND_FAMILIES = new Set([
  ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND,
]);

/**
 * Validate a command after the Worker has fenced it to one concrete player
 * WebSocket. Control clients are not allowed to provide targetConnectionId,
 * so this is deliberately separate from validateOnAirMessage().
 */
export function validateOnAirPlayerCommand(message) {
  const family = getOnAirMessageFamily(message);
  if (!isRecord(message)) return validateOnAirMessage(message);

  if (!PLAYER_TARGETED_COMMAND_FAMILIES.has(family)) {
    return {
      ok: false,
      family,
      errors: [{ path: 'type', code: 'invalid_player_command' }],
    };
  }

  const controlShape = { ...message };
  delete controlShape.targetConnectionId;
  const validation = validateOnAirMessage(controlShape);
  const errors = [...validation.errors];
  const connectionError = identifierErrorCode(message.targetConnectionId);
  if (connectionError) addError(errors, 'targetConnectionId', connectionError);
  return { ok: errors.length === 0, family, errors };
}

export function assertOnAirMessage(message) {
  const validation = validateOnAirMessage(message);
  if (!validation.ok) {
    const summary = validation.errors.map((error) => `${error.path}:${error.code}`).join('; ');
    const exception = new TypeError(`Invalid On-Air Protocol v2 message (${validation.family}): ${summary}`);
    exception.validation = validation;
    throw exception;
  }
  return message;
}

function acceptedIdentity(family) {
  return { accepted: true, reason: 'accepted', family };
}

function rejectedIdentity(family, reason, field, expected, actual, validation) {
  return {
    accepted: false,
    reason,
    family,
    field,
    expected,
    actual,
    ...(validation ? { validation } : {}),
  };
}

function compareExact(family, field, actual, expected, reason) {
  if (expected === undefined || actual === expected) return null;
  return rejectedIdentity(family, reason, field, expected, actual);
}

function compareEpoch(family, field, actual, expected) {
  if (expected === undefined || actual === expected) return null;
  const direction = actual < expected ? 'stale' : 'future';
  const codeField = field === 'leaseEpoch'
    ? 'lease_epoch'
    : field === 'controlEpoch' ? 'control_epoch' : field;
  return rejectedIdentity(family, `${direction}_${codeField}`, field, expected, actual);
}

function readExpected(expected, fields) {
  for (const field of fields) {
    if (!hasOwn(expected, field)) continue;
    const value = expected[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) continue;
    return { present: true, value, field };
  }
  return { present: false, value: undefined, field: fields[0] };
}

function requireExpected(family, expected, field, aliases = [field]) {
  const result = readExpected(expected, aliases);
  if (result.present) return null;
  return rejectedIdentity(family, 'missing_expected_identity', field, 'required', undefined);
}

function requireTrustedServerConnection(family, expected) {
  const missing = requireExpected(family, expected, 'trustedConnection');
  if (missing) return missing;
  if (expected.trustedConnection !== true) {
    return rejectedIdentity(family, 'untrusted_connection', 'trustedConnection', true, expected.trustedConnection);
  }
  return null;
}

/**
 * Evaluate whether a valid message belongs to the caller's current identity.
 *
 * Only identities relevant to the message family are compared. In particular,
 * emergency_stop is deliberately independent from run, lease, target and
 * control epochs; it is bound only to its authenticated session/control identity.
 */
export function evaluateOnAirIdentity(message, expected = {}) {
  const validation = validateOnAirMessage(message);
  const { family } = validation;
  if (!validation.ok) {
    return rejectedIdentity(family, 'invalid_message', '$', undefined, undefined, validation);
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME) {
    const missing = requireExpected(family, expected, 'playerInstanceId');
    if (missing) return missing;
    return compareExact(
      family,
      'playerInstanceId',
      message.playerInstanceId,
      expected.playerInstanceId,
      'foreign_player_instance',
    ) || acceptedIdentity(family);
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME) {
    const missing = requireExpected(family, expected, 'controlInstanceId');
    if (missing) return missing;
    return compareExact(
      family,
      'controlInstanceId',
      message.controlInstanceId,
      expected.controlInstanceId,
      'foreign_control_instance',
    ) || acceptedIdentity(family);
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.SERVER_HEARTBEAT_ACK) {
    const missing = (
      requireTrustedServerConnection(family, expected)
      || requireExpected(family, expected, 'playerInstanceId')
      || requireExpected(family, expected, 'connectionId')
    );
    if (missing) return missing;
    return (
      compareExact(
        family,
        'playerInstanceId',
        message.playerInstanceId,
        expected.playerInstanceId,
        'foreign_player_instance',
      )
      || compareExact(
        family,
        'connectionId',
        message.connectionId,
        expected.connectionId,
        'foreign_connection',
      )
      || acceptedIdentity(family)
    );
  }

  if (
    family === ON_AIR_MESSAGE_FAMILIES.SERVER_SNAPSHOT
    || family === ON_AIR_MESSAGE_FAMILIES.SERVER_ERROR
    || family === ON_AIR_MESSAGE_FAMILIES.SERVER_CONNECTION
    || family === ON_AIR_MESSAGE_FAMILIES.SERVER_STATE
    || family === ON_AIR_MESSAGE_FAMILIES.SERVER_LIFECYCLE
  ) {
    return requireTrustedServerConnection(family, expected) || acceptedIdentity(family);
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.SERVER_EVENT_RESULT) {
    const missing = (
      requireTrustedServerConnection(family, expected)
      || requireExpected(family, expected, 'eventId')
      || requireExpected(family, expected, 'playerInstanceId')
    );
    if (missing) return missing;
    return (
      compareExact(family, 'eventId', message.eventId, expected.eventId, 'foreign_event')
      || compareExact(
        family,
        'playerInstanceId',
        message.playerInstanceId,
        expected.playerInstanceId,
        'foreign_player_instance',
      )
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT) {
    const missing = (
      requireTrustedServerConnection(family, expected)
      || requireExpected(family, expected, 'commandId')
    );
    if (missing) return missing;
    return compareExact(
      family,
      'commandId',
      message.commandId,
      expected.commandId,
      'foreign_command',
    ) || acceptedIdentity(family);
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND) {
    const missing = (
      requireExpected(family, expected, 'sessionId')
      || requireExpected(family, expected, 'authenticatedControlInstanceId')
    );
    if (missing) return missing;
    return (
      compareExact(family, 'sessionId', message.sessionId, expected.sessionId, 'foreign_session')
      || compareExact(
        family,
        'authenticatedControlInstanceId',
        message.authenticatedControlInstanceId,
        expected.authenticatedControlInstanceId,
        'foreign_authenticated_control',
      )
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT) {
    const missing = (
      requireExpected(family, expected, 'sessionId')
      || requireExpected(family, expected, 'commandId')
      || requireExpected(family, expected, 'playerInstanceId', ['playerInstanceId', 'targetPlayerInstanceId'])
      || requireExpected(family, expected, 'connectionId')
    );
    if (missing) return missing;
    return (
      compareExact(family, 'sessionId', message.sessionId, expected.sessionId, 'foreign_session')
      || compareExact(family, 'commandId', message.commandId, expected.commandId, 'foreign_command')
      || compareExact(
        family,
        'playerInstanceId',
        message.playerInstanceId,
        expected.playerInstanceId ?? expected.targetPlayerInstanceId,
        'foreign_player_instance',
      )
      || compareExact(family, 'connectionId', message.connectionId, expected.connectionId, 'foreign_connection')
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.PLAYER_HELLO) {
    const missing = requireExpected(family, expected, 'playerInstanceId');
    if (missing) return missing;
    return (
      compareExact(
        family,
        'playerInstanceId',
        message.playerInstanceId,
        expected.playerInstanceId,
        'foreign_player_instance',
      ) || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.CONTROL_HELLO) {
    const missing = requireExpected(family, expected, 'controlInstanceId');
    if (missing) return missing;
    return (
      compareExact(
        family,
        'controlInstanceId',
        message.controlInstanceId,
        expected.controlInstanceId,
        'foreign_control_instance',
      ) || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.CONTROL_COMMAND) {
    const missing = (
      requireExpected(family, expected, 'controlInstanceId')
      || requireExpected(family, expected, 'controlEpoch')
    );
    if (missing) return missing;
    return (
      compareExact(
        family,
        'controlInstanceId',
        message.controlInstanceId,
        expected.controlInstanceId,
        'foreign_control_instance',
      )
      || compareEpoch(
        family,
        'controlEpoch',
        message.expectedControlEpoch,
        expected.controlEpoch,
      )
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.AUXILIARY_CONTROL_COMMAND) {
    const missing = requireExpected(family, expected, 'controlEpoch');
    if (missing) return missing;
    return compareEpoch(
      family,
      'controlEpoch',
      message.controlEpoch,
      expected.controlEpoch,
    ) || acceptedIdentity(family);
  }

  const expectsTarget = hasOwn(message, 'targetPlayerInstanceId');
  const isPlayerEvent = family === ON_AIR_MESSAGE_FAMILIES.RUN_EVENT
    || family === ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT
    || family === ON_AIR_MESSAGE_FAMILIES.TEST_EVENT;
  const missingCommon = (
    requireExpected(
      family,
      expected,
      expectsTarget ? 'targetPlayerInstanceId' : 'playerInstanceId',
      expectsTarget
        ? ['targetPlayerInstanceId', 'playerInstanceId']
        : ['playerInstanceId', 'targetPlayerInstanceId'],
    )
    || requireExpected(family, expected, 'leaseEpoch')
    || (hasOwn(message, 'controlEpoch') ? requireExpected(family, expected, 'controlEpoch') : null)
    || (isPlayerEvent ? requireExpected(family, expected, 'connectionId') : null)
  );
  if (missingCommon) return missingCommon;

  if (family === ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.RUN_EVENT) {
    const missing = (
      requireExpected(family, expected, 'entryId')
      || requireExpected(family, expected, 'runId')
    );
    if (missing) return missing;
  } else if (family === ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT) {
    const missing = requireExpected(family, expected, 'switchId');
    if (missing) return missing;
  } else if (family === ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.TEST_EVENT) {
    const missing = requireExpected(family, expected, 'checkId');
    if (missing) return missing;
  } else if (family === ON_AIR_MESSAGE_FAMILIES.HEARTBEAT) {
    const missing = requireExpected(family, expected, 'connectionId');
    if (missing) return missing;
  }

  const messagePlayerId = hasOwn(message, 'targetPlayerInstanceId')
    ? message.targetPlayerInstanceId
    : message.playerInstanceId;
  const expectedPlayerId = hasOwn(message, 'targetPlayerInstanceId')
    ? (expected.targetPlayerInstanceId ?? expected.playerInstanceId)
    : (expected.playerInstanceId ?? expected.targetPlayerInstanceId);
  const playerReason = hasOwn(message, 'targetPlayerInstanceId')
    ? 'foreign_target_player'
    : 'foreign_player_instance';

  const commonRejection = (
    compareExact(
      family,
      hasOwn(message, 'targetPlayerInstanceId') ? 'targetPlayerInstanceId' : 'playerInstanceId',
      messagePlayerId,
      expectedPlayerId,
      playerReason,
    )
    || compareEpoch(family, 'leaseEpoch', message.leaseEpoch, expected.leaseEpoch)
    || (hasOwn(message, 'controlEpoch')
      ? compareEpoch(family, 'controlEpoch', message.controlEpoch, expected.controlEpoch)
      : null)
    || (isPlayerEvent
      ? compareExact(
        family,
        'connectionId',
        message.connectionId,
        expected.connectionId,
        'foreign_connection',
      )
      : null)
  );
  if (commonRejection) return commonRejection;

  if (family === ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.RUN_EVENT) {
    return (
      compareExact(family, 'entryId', message.entryId, expected.entryId, 'foreign_entry')
      || compareExact(family, 'runId', message.runId, expected.runId, 'foreign_run')
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT) {
    return (
      compareExact(family, 'switchId', message.switchId, expected.switchId, 'foreign_switch')
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND || family === ON_AIR_MESSAGE_FAMILIES.TEST_EVENT) {
    return (
      compareExact(family, 'checkId', message.checkId, expected.checkId, 'foreign_check')
      || acceptedIdentity(family)
    );
  }

  if (family === ON_AIR_MESSAGE_FAMILIES.HEARTBEAT) {
    return (
      compareExact(family, 'connectionId', message.connectionId, expected.connectionId, 'foreign_connection')
      || acceptedIdentity(family)
    );
  }

  return acceptedIdentity(family);
}

/**
 * Evaluate a Worker-to-player targeted command. The ordinary identity
 * evaluator intentionally models control-to-Worker input and therefore does
 * not accept the server-owned targetConnectionId field.
 */
export function evaluateOnAirPlayerCommandIdentity(message, expected = {}) {
  const validation = validateOnAirPlayerCommand(message);
  const { family } = validation;
  if (!validation.ok) {
    return rejectedIdentity(family, 'invalid_message', '$', undefined, undefined, validation);
  }

  const controlShape = { ...message };
  delete controlShape.targetConnectionId;
  const baseIdentity = evaluateOnAirIdentity(controlShape, expected);
  if (!baseIdentity.accepted) return baseIdentity;

  const missing = requireExpected(
    family,
    expected,
    'connectionId',
    ['connectionId', 'targetConnectionId'],
  );
  if (missing) return missing;
  return compareExact(
    family,
    'targetConnectionId',
    message.targetConnectionId,
    expected.connectionId ?? expected.targetConnectionId,
    'foreign_connection',
  ) || acceptedIdentity(family);
}

function requirePositiveLimit(limit, name) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireCacheIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/** A deterministic, bounded LRU set for idempotent command application. */
export class BoundedCommandIdCache {
  #limit;
  #entries = new Map();

  constructor(limit = 512) {
    requirePositiveLimit(limit, 'limit');
    this.#limit = limit;
  }

  get limit() {
    return this.#limit;
  }

  get size() {
    return this.#entries.size;
  }

  has(commandId) {
    requireCacheIdentifier(commandId, 'commandId');
    return this.#entries.has(commandId);
  }

  /**
   * Remember a command ID and report whether it is safe to apply.
   * A duplicate refreshes its LRU position but remains rejected.
   */
  accept(commandId) {
    requireCacheIdentifier(commandId, 'commandId');

    if (this.#entries.has(commandId)) {
      this.#entries.delete(commandId);
      this.#entries.set(commandId, true);
      return { accepted: false, duplicate: true, evictedCommandId: null };
    }

    this.#entries.set(commandId, true);
    let evictedCommandId = null;
    if (this.#entries.size > this.#limit) {
      evictedCommandId = this.#entries.keys().next().value;
      this.#entries.delete(evictedCommandId);
    }

    return { accepted: true, duplicate: false, evictedCommandId };
  }

  clear() {
    this.#entries.clear();
  }

  snapshot() {
    return [...this.#entries.keys()];
  }
}

function requireSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError('sequence must be a non-negative safe integer');
  }
}

function sequenceInstanceId(message, family) {
  if (family === ON_AIR_MESSAGE_FAMILIES.HEARTBEAT) return message.playerInstanceId;
  if (
    family === ON_AIR_MESSAGE_FAMILIES.RUN_EVENT
    || family === ON_AIR_MESSAGE_FAMILIES.ROUTE_EVENT
    || family === ON_AIR_MESSAGE_FAMILIES.TEST_EVENT
    || family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_EVENT
  ) {
    return message.playerInstanceId;
  }
  return null;
}

function emptySequenceStats() {
  return {
    observations: 0,
    accepted: 0,
    rejected: 0,
    first: 0,
    next: 0,
    gap: 0,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    evictions: 0,
  };
}

/**
 * Tracks monotonic sequence numbers per namespace and player instance.
 *
 * Gaps are accepted and measured. Duplicates and out-of-order observations are
 * rejected without moving the high-water mark. Stream keys are LRU-bounded.
 */
export class MonotonicSequenceTracker {
  #maxStreams;
  #streams = new Map();
  #stats = emptySequenceStats();

  constructor({ maxStreams = 128 } = {}) {
    requirePositiveLimit(maxStreams, 'maxStreams');
    this.#maxStreams = maxStreams;
  }

  get size() {
    return this.#streams.size;
  }

  observe(family, instanceId, sequence) {
    // `family` is retained as the public result/property name for backwards
    // compatibility; observeMessage supplies the finer sequence namespace.
    requireCacheIdentifier(family, 'family');
    requireCacheIdentifier(instanceId, 'instanceId');
    requireSequence(sequence);

    const key = `${family}\u0000${instanceId}`;
    const priorState = this.#streams.get(key);
    this.#stats.observations += 1;

    if (!priorState) {
      const state = { family, instanceId, highWaterMark: sequence };
      this.#streams.set(key, state);
      this.#stats.accepted += 1;
      this.#stats.first += 1;
      this.#evictIfNeeded();
      return {
        accepted: true,
        status: 'first',
        family,
        instanceId,
        sequence,
        previous: null,
        missing: 0,
      };
    }

    this.#streams.delete(key);
    this.#streams.set(key, priorState);
    const previous = priorState.highWaterMark;

    if (sequence === previous) {
      this.#stats.rejected += 1;
      this.#stats.duplicate += 1;
      return {
        accepted: false,
        status: 'duplicate',
        family,
        instanceId,
        sequence,
        previous,
        missing: 0,
      };
    }

    if (sequence < previous) {
      this.#stats.rejected += 1;
      this.#stats.outOfOrder += 1;
      return {
        accepted: false,
        status: 'out_of_order',
        family,
        instanceId,
        sequence,
        previous,
        missing: 0,
      };
    }

    priorState.highWaterMark = sequence;
    this.#stats.accepted += 1;
    if (sequence === previous + 1) {
      this.#stats.next += 1;
      return {
        accepted: true,
        status: 'next',
        family,
        instanceId,
        sequence,
        previous,
        missing: 0,
      };
    }

    const missing = sequence - previous - 1;
    this.#stats.gap += 1;
    this.#stats.missing += missing;
    return {
      accepted: true,
      status: 'gap',
      family,
      instanceId,
      sequence,
      previous,
      missing,
    };
  }

  observeMessage(message) {
    const validation = validateOnAirMessage(message);
    if (!validation.ok) {
      const error = new TypeError('Cannot track sequence for an invalid On-Air message');
      error.validation = validation;
      throw error;
    }
    if (!hasOwn(message, 'sequence')) {
      throw new TypeError(`The ${validation.family} family does not carry a sequence`);
    }

    const instanceId = sequenceInstanceId(message, validation.family);
    if (!instanceId) {
      throw new TypeError(`The ${validation.family} family has no sequence identity`);
    }
    const namespace = getOnAirSequenceNamespace(message);
    if (!namespace) {
      throw new TypeError(`The ${validation.family} family has no sequence namespace`);
    }
    return this.observe(namespace, instanceId, message.sequence);
  }

  getHighWaterMark(family, instanceId) {
    requireCacheIdentifier(family, 'family');
    requireCacheIdentifier(instanceId, 'instanceId');
    return this.#streams.get(`${family}\u0000${instanceId}`)?.highWaterMark ?? null;
  }

  reset() {
    this.#streams.clear();
    this.#stats = emptySequenceStats();
  }

  snapshot() {
    return {
      maxStreams: this.#maxStreams,
      streamCount: this.#streams.size,
      stats: { ...this.#stats },
      streams: [...this.#streams.values()].map((stream) => ({ ...stream })),
    };
  }

  #evictIfNeeded() {
    if (this.#streams.size <= this.#maxStreams) return;
    const oldestKey = this.#streams.keys().next().value;
    this.#streams.delete(oldestKey);
    this.#stats.evictions += 1;
  }
}
