import {
  ON_AIR_PROTOCOL_VERSION,
  PLAYER_CLIENT_KINDS,
  SERVER_MESSAGE_TYPES,
} from './onAirProtocol.js';

/**
 * Locale-neutral, fail-closed view derivation for the output selector.
 *
 * This module deliberately keeps four truths separate:
 * - selected mode: what the control asked for;
 * - lease/playback: what the active player last proved to the Worker;
 * - adapter state: browser-local safety and event-delivery progress;
 * - verification: an explicit, separately supplied OBS/artifact result.
 *
 * Player presence, route readiness, `window.obsstudio`, and a `playing` event
 * never promote the verification layer. In particular, lease `audible` means
 * only that the authoritative player reported an HTMLMediaElement `playing`
 * event; it does not prove the OBS mixer, recording track, or stream output.
 */

export const ON_AIR_OUTPUT_MODES = Object.freeze({
  SPEAKER: 'speaker',
  OBS: 'obs',
});

export const ON_AIR_OUTPUT_LEASE_STATES = Object.freeze({
  ACTIVATING: 'activating',
  READY: 'ready',
  AUDIBLE: 'audible',
  UNKNOWN: 'unknown',
  DEACTIVATING: 'deactivating',
  INACTIVE: 'inactive',
  EMERGENCY: 'emergency',
});

export const ON_AIR_OUTPUT_CANDIDATE_STATES = Object.freeze({
  NONE: 'none',
  SINGLE: 'single',
  DUPLICATE: 'duplicate',
  UNKNOWN: 'unknown',
});

export const ON_AIR_OUTPUT_VERIFICATION_STATUSES = Object.freeze({
  UNKNOWN: 'unknown',
  PASSED: 'passed',
  STALE: 'stale',
});

export const ON_AIR_OUTPUT_VERIFICATION_SCOPES = Object.freeze({
  SPEAKER_PLAYBACK: 'speaker_playback',
  OBS_MIXER: 'obs_mixer',
  OBS_RECORDING: 'obs_recording',
  OBS_STREAM_ARTIFACT: 'obs_stream_artifact',
  KARAOKE_SYNC: 'karaoke_sync',
});

export const ON_AIR_OUTPUT_ACTIONS = Object.freeze({
  SWITCH_OUTPUT: 'switchOutput',
  ACTIVATE: 'activate',
  DEACTIVATE: 'deactivate',
  RETRY: 'retry',
  RESUME: 'resume',
  START_TEST: 'startTest',
  STOP_TEST: 'stopTest',
  EMERGENCY_STOP: 'emergencyStop',
  AUTO_RESUME: 'autoResume',
  AUTO_FALLBACK: 'autoFallback',
});

export const ON_AIR_OUTPUT_GATE_CODES = Object.freeze({
  ALLOWED: 'allowed',
  INVALID_INPUT: 'invalid_input',
  STATE_UNKNOWN: 'state_unknown',
  ACTIVE_PLAYBACK: 'active_playback',
  STOP_NOT_PROVEN: 'stop_not_proven',
  CANDIDATE_NOT_SINGLE: 'candidate_not_single',
  LEASE_NOT_INACTIVE: 'lease_not_inactive',
  LEASE_NOT_READY: 'lease_not_ready',
  NO_LEASE_TARGET: 'no_lease_target',
  ADAPTER_NOT_SAFE: 'adapter_not_safe',
  MODE_NOT_OBS: 'mode_not_obs',
  TEST_ACTIVE: 'test_active',
  NO_ACTIVE_TEST: 'no_active_test',
  NOT_PAUSED: 'not_paused',
  POLICY_MANUAL_ONLY: 'policy_manual_only',
  NOT_NEEDED: 'not_needed',
});

const OUTPUT_MODE_SET = new Set(Object.values(ON_AIR_OUTPUT_MODES));
const CANDIDATE_MESSAGE_KEYS = Object.freeze({
  none: 'onair.output.candidate.none',
  single: 'onair.output.candidate.single',
  duplicate: 'onair.output.candidate.duplicate',
  unknown: 'onair.output.candidate.unknown',
});
const RAW_LEASE_STATES = new Set([
  'activating',
  'ready',
  'audible',
  'unknown',
  'deactivating',
  'inactive',
  'emergency',
  'emergency_stopping',
  'failed',
]);
const ACTIVE_LEASE_STATES = new Set([
  'activating',
  'ready',
  'audible',
  'unknown',
  'deactivating',
  'failed',
]);
const DESIRED_PLAYBACK_STATES = new Set([
  'idle',
  'empty',
  'loading',
  'cached',
  'ready',
  'playing',
  'paused',
  'buffering',
  'stopped',
  'ended',
  'error',
  'unknown',
]);
const CONFIRMED_PLAYBACK_STATES = new Set([
  'idle',
  'empty',
  'loading',
  'ready',
  'playing',
  'paused',
  'buffering',
  'stopped',
  'ended',
  'error',
  'unknown',
]);
const CONFIRMED_ACTIVE_STATES = new Set([
  'loading',
  'ready',
  'playing',
  'paused',
  'buffering',
]);
const DESIRED_QUIET_STATES = new Set(['idle', 'empty', 'stopped']);
const ADAPTER_ROUTE_STATES = new Set([
  'standby',
  'activating',
  'ready_event_sent',
  'deactivating',
  'standby_event_sent',
  'unknown',
  'emergency_stopping',
  'emergency_stopped_event_sent',
]);
const ADAPTER_CONFIRMATIONS = new Set(['unknown', 'local_only', 'local_event_sent']);
const ADAPTER_CONFIRMATION_BY_ROUTE = Object.freeze({
  standby: 'unknown',
  activating: 'local_only',
  ready_event_sent: 'local_event_sent',
  deactivating: 'local_only',
  standby_event_sent: 'local_event_sent',
  unknown: 'unknown',
  emergency_stopping: 'local_only',
  emergency_stopped_event_sent: 'local_event_sent',
});
const ADAPTER_ACTIVATION_STATES = new Set([
  'standby',
  'standby_event_sent',
  'emergency_stopped_event_sent',
]);
const ADAPTER_ACTIVE_STATES = new Set(['ready_event_sent']);
const VERIFICATION_STATUS_SET = new Set(Object.values(ON_AIR_OUTPUT_VERIFICATION_STATUSES));
const VERIFICATION_SCOPE_SET = new Set(Object.values(ON_AIR_OUTPUT_VERIFICATION_SCOPES));
const VERIFICATION_SCOPE_KEY_SEGMENTS = Object.freeze({
  speaker_playback: 'speakerPlayback',
  obs_mixer: 'obsMixer',
  obs_recording: 'obsRecording',
  obs_stream_artifact: 'obsStreamArtifact',
  karaoke_sync: 'karaokeSync',
});
const AVAILABLE_ACTION_ORDER = Object.freeze([
  ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT,
  ON_AIR_OUTPUT_ACTIONS.ACTIVATE,
  ON_AIR_OUTPUT_ACTIONS.RESUME,
  ON_AIR_OUTPUT_ACTIONS.START_TEST,
  ON_AIR_OUTPUT_ACTIONS.STOP_TEST,
  ON_AIR_OUTPUT_ACTIONS.DEACTIVATE,
  ON_AIR_OUTPUT_ACTIONS.RETRY,
  ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP,
]);
const IDENTIFIER_MAX_LENGTH = 256;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, field) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function isIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH) {
    return false;
  }
  if (value !== value.trim()) return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function addCode(target, code) {
  if (!target.includes(code)) target.push(code);
}

function normalizeLeaseStatus(rawStatus) {
  if (rawStatus === 'emergency' || rawStatus === 'emergency_stopping') {
    return ON_AIR_OUTPUT_LEASE_STATES.EMERGENCY;
  }
  if (rawStatus === 'failed') return ON_AIR_OUTPUT_LEASE_STATES.UNKNOWN;
  if (Object.values(ON_AIR_OUTPUT_LEASE_STATES).includes(rawStatus)) return rawStatus;
  return ON_AIR_OUTPUT_LEASE_STATES.UNKNOWN;
}

function modeForClientKind(clientKind) {
  if (clientKind === PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER) return ON_AIR_OUTPUT_MODES.SPEAKER;
  if (clientKind === PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE) return ON_AIR_OUTPUT_MODES.OBS;
  return null;
}

function normalizeCandidateList(value, field, diagnostics) {
  if (!Array.isArray(value)) {
    addCode(diagnostics, `invalid_${field}_candidates`);
    return null;
  }
  if (value.length > 32 || value.some((entry) => !isIdentifier(entry))) {
    addCode(diagnostics, `invalid_${field}_candidates`);
    return null;
  }
  return [...value];
}

function candidateView(mode, eligibleCandidates) {
  if (mode === null) {
    return {
      state: ON_AIR_OUTPUT_CANDIDATE_STATES.NONE,
      count: 0,
      playerInstanceId: null,
      messageKey: CANDIDATE_MESSAGE_KEYS.none,
    };
  }
  const list = eligibleCandidates[mode];
  if (list === null) {
    return {
      state: ON_AIR_OUTPUT_CANDIDATE_STATES.UNKNOWN,
      count: null,
      playerInstanceId: null,
      messageKey: CANDIDATE_MESSAGE_KEYS.unknown,
    };
  }
  const state = list.length === 0
    ? ON_AIR_OUTPUT_CANDIDATE_STATES.NONE
    : list.length === 1
      ? ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE
      : ON_AIR_OUTPUT_CANDIDATE_STATES.DUPLICATE;
  return {
    state,
    count: list.length,
    playerInstanceId: state === ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE ? list[0] : null,
    messageKey: CANDIDATE_MESSAGE_KEYS[state],
  };
}

function parseActiveFamily(protocolSnapshot, diagnostics) {
  if (!hasOwn(protocolSnapshot, 'activeFamily')) {
    addCode(diagnostics, 'missing_active_family');
    return { known: false, present: null, entryId: null, runId: null };
  }
  const value = protocolSnapshot.activeFamily;
  if (value === null) return { known: true, present: false, entryId: null, runId: null };
  if (!isRecord(value) || !isIdentifier(value.entryId) || !isIdentifier(value.runId)) {
    addCode(diagnostics, 'invalid_active_family');
    return { known: false, present: null, entryId: null, runId: null };
  }
  return { known: true, present: true, entryId: value.entryId, runId: value.runId };
}

function parseActiveCheckId(protocolSnapshot, diagnostics) {
  if (!hasOwn(protocolSnapshot, 'activeCheckId')) {
    addCode(diagnostics, 'missing_active_check_id');
    return { known: false, active: null, checkId: null };
  }
  if (protocolSnapshot.activeCheckId === null) {
    return { known: true, active: false, checkId: null };
  }
  if (!isIdentifier(protocolSnapshot.activeCheckId)) {
    addCode(diagnostics, 'invalid_active_check_id');
    return { known: false, active: null, checkId: null };
  }
  return { known: true, active: true, checkId: protocolSnapshot.activeCheckId };
}

function parseAdapterSnapshot(value, diagnostics) {
  if (value === null || value === undefined) {
    return {
      available: false,
      valid: true,
      routeState: 'unknown',
      confirmation: 'unknown',
      safetyLocked: true,
      disposed: false,
      activeRunPresent: false,
      proofScope: null,
      messageKey: 'onair.output.adapter.unavailable',
    };
  }
  if (!isRecord(value)
    || !ADAPTER_ROUTE_STATES.has(value.routeState)
    || !ADAPTER_CONFIRMATIONS.has(value.confirmation)
    || typeof value.safetyLocked !== 'boolean'
    || value.autoResumeAllowed !== false
    || typeof value.disposed !== 'boolean') {
    addCode(diagnostics, 'invalid_adapter_snapshot');
    return {
      available: true,
      valid: false,
      routeState: 'unknown',
      confirmation: 'unknown',
      safetyLocked: true,
      disposed: false,
      activeRunPresent: true,
      proofScope: 'browser_local',
      messageKey: 'onair.output.adapter.invalid',
    };
  }
  const activeEntryId = value.activeEntryId;
  const activeRunId = value.activeRunId;
  const activeIdsValid = (activeEntryId === null || isIdentifier(activeEntryId))
    && (activeRunId === null || isIdentifier(activeRunId))
    && ((activeEntryId === null) === (activeRunId === null));
  const routeContractValid = ADAPTER_CONFIRMATION_BY_ROUTE[value.routeState] === value.confirmation
    && (value.routeState === 'unknown'
      || value.safetyLocked === (value.routeState !== 'ready_event_sent'));
  if (!activeIdsValid || !routeContractValid) {
    addCode(diagnostics, 'invalid_adapter_snapshot');
  }
  const valid = activeIdsValid && routeContractValid;
  const disposed = value.disposed;
  const messageKey = !valid
    ? 'onair.output.adapter.invalid'
    : value.routeState === 'unknown'
      ? 'onair.output.adapter.unknown'
      : value.confirmation === 'local_event_sent'
        ? 'onair.output.adapter.localEventSent'
        : value.confirmation === 'local_only'
          ? 'onair.output.adapter.localOnly'
          : 'onair.output.adapter.standby';
  return {
    available: true,
    valid,
    routeState: valid ? value.routeState : 'unknown',
    confirmation: valid ? value.confirmation : 'unknown',
    safetyLocked: valid ? value.safetyLocked : true,
    disposed,
    activeRunPresent: valid ? activeRunId !== null : true,
    proofScope: 'browser_local',
    messageKey,
  };
}

function parseVerification(value, selectedOutputMode, diagnostics, expectedScope = null) {
  if (value === null || value === undefined) {
    return {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN,
      scope: expectedScope,
      outputMode: null,
      checkedAt: null,
      reasonCodes: [],
      messageKey: 'onair.output.verification.unknown',
    };
  }
  if (!isRecord(value) || !VERIFICATION_STATUS_SET.has(value.status)) {
    addCode(diagnostics, 'invalid_verification');
    return {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN,
      scope: null,
      outputMode: null,
      checkedAt: null,
      reasonCodes: ['invalid_verification'],
      messageKey: 'onair.output.verification.unknown',
    };
  }

  const checkedAt = Number.isFinite(value.checkedAt) && value.checkedAt >= 0 ? value.checkedAt : null;
  const scope = VERIFICATION_SCOPE_SET.has(value.scope) ? value.scope : null;
  const outputMode = OUTPUT_MODE_SET.has(value.outputMode) ? value.outputMode : null;
  const suppliedReasons = Array.isArray(value.reasonCodes)
    && value.reasonCodes.length <= 16
    && value.reasonCodes.every(isIdentifier)
    ? [...value.reasonCodes]
    : [];
  const scopeMode = scope === ON_AIR_OUTPUT_VERIFICATION_SCOPES.SPEAKER_PLAYBACK
    ? ON_AIR_OUTPUT_MODES.SPEAKER
    : scope === null ? null : ON_AIR_OUTPUT_MODES.OBS;

  if (expectedScope !== null && scope !== expectedScope) {
    addCode(diagnostics, `invalid_verification_${expectedScope}`);
    return {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN,
      scope: expectedScope,
      outputMode: null,
      checkedAt: null,
      reasonCodes: ['invalid_verification'],
      messageKey: 'onair.output.verification.unknown',
    };
  }

  if (value.status === ON_AIR_OUTPUT_VERIFICATION_STATUSES.PASSED) {
    if (checkedAt === null || scope === null || outputMode === null || scopeMode !== outputMode) {
      addCode(diagnostics, 'invalid_verification');
      return {
        status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN,
        scope: null,
        outputMode: null,
        checkedAt: null,
        reasonCodes: ['invalid_verification'],
        messageKey: 'onair.output.verification.unknown',
      };
    }
    if (outputMode !== selectedOutputMode) {
      return {
        status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.STALE,
        scope,
        outputMode,
        checkedAt,
        reasonCodes: ['output_mode_changed'],
        messageKey: `onair.output.verification.${VERIFICATION_SCOPE_KEY_SEGMENTS[scope]}.stale`,
      };
    }
    return {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.PASSED,
      scope,
      outputMode,
      checkedAt,
      reasonCodes: [],
      messageKey: `onair.output.verification.${VERIFICATION_SCOPE_KEY_SEGMENTS[scope]}.passed`,
    };
  }

  if (value.status === ON_AIR_OUTPUT_VERIFICATION_STATUSES.STALE) {
    return {
      status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.STALE,
      scope,
      outputMode,
      checkedAt,
      reasonCodes: suppliedReasons,
      messageKey: scope === null
        ? 'onair.output.verification.stale'
        : `onair.output.verification.${VERIFICATION_SCOPE_KEY_SEGMENTS[scope]}.stale`,
    };
  }

  return {
    status: ON_AIR_OUTPUT_VERIFICATION_STATUSES.UNKNOWN,
    scope,
    outputMode,
    checkedAt,
    reasonCodes: suppliedReasons,
    messageKey: 'onair.output.verification.unknown',
  };
}

function parseVerificationByScope(value, selectedOutputMode, diagnostics) {
  let source = {};
  if (value !== null && value !== undefined) {
    if (!isRecord(value)) {
      addCode(diagnostics, 'invalid_verification_by_scope');
    } else {
      source = value;
      for (const field of Object.keys(value)) {
        if (!VERIFICATION_SCOPE_SET.has(field)) {
          addCode(diagnostics, 'invalid_verification_by_scope');
          source = {};
          break;
        }
      }
    }
  }

  return Object.fromEntries(Object.values(ON_AIR_OUTPUT_VERIFICATION_SCOPES).map((scope) => [
    scope,
    parseVerification(source[scope], selectedOutputMode, diagnostics, scope),
  ]));
}

function strongStopProven(confirmedPlayback) {
  return confirmedPlayback.status === 'stopped'
    && confirmedPlayback.paused === true
    && confirmedPlayback.sourceDetached === true
    && confirmedPlayback.autoplayCancelled === true
    && confirmedPlayback.audible === false;
}

function playbackRelationship(desiredStatus, confirmedStatus) {
  if (desiredStatus === 'unknown' || confirmedStatus === 'unknown') return 'unknown';
  if (desiredStatus === confirmedStatus) return 'matched';
  if ((DESIRED_QUIET_STATES.has(desiredStatus) && CONFIRMED_ACTIVE_STATES.has(confirmedStatus))
    || confirmedStatus === 'error') {
    return 'conflict';
  }
  return 'pending';
}

function gate(action, allowed, reasonCode) {
  const semanticReason = allowed ? ON_AIR_OUTPUT_GATE_CODES.ALLOWED : reasonCode;
  const keyReason = semanticReason.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
  return {
    allowed,
    reasonCode: semanticReason,
    labelKey: `onair.output.action.${action}.label`,
    messageKey: `onair.output.gate.${keyReason}`,
  };
}

function blockedReason({ inputValid, unknownState, activePlayback, stopProven, adapterSafe }) {
  if (!inputValid) return ON_AIR_OUTPUT_GATE_CODES.INVALID_INPUT;
  if (unknownState) return ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN;
  if (activePlayback) return ON_AIR_OUTPUT_GATE_CODES.ACTIVE_PLAYBACK;
  if (!stopProven) return ON_AIR_OUTPUT_GATE_CODES.STOP_NOT_PROVEN;
  if (!adapterSafe) return ON_AIR_OUTPUT_GATE_CODES.ADAPTER_NOT_SAFE;
  return ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE;
}

function statusMessageKey(statusCode, mode) {
  if (statusCode === 'route_ready' || statusCode === 'player_playing_confirmed') {
    const modeSegment = mode ?? 'unselected';
    const statusSegment = statusCode === 'route_ready' ? 'routeReady' : 'playerPlaying';
    return `onair.output.status.${modeSegment}.${statusSegment}`;
  }
  const segments = Object.freeze({
    invalid_input: 'invalidInput',
    state_unknown: 'stateUnknown',
    activation_failed: 'activationFailed',
    emergency_stopping: 'emergencyStopping',
    output_deactivating: 'deactivating',
    output_activating: 'activating',
    candidate_missing: 'candidateMissing',
    candidate_duplicate: 'candidateDuplicate',
    output_inactive: 'inactive',
  });
  return `onair.output.status.${segments[statusCode] ?? 'stateUnknown'}`;
}

/**
 * @param {object} input
 * @param {object} input.protocolSnapshot trusted Protocol v2 player_snapshot body
 * @param {object|null} [input.adapterSnapshot] browser-local OnAirPlaybackAdapter snapshot
 * @param {object|null} [input.verification] explicit persisted verification result
 * @param {object|null} [input.verificationByScope] independently persisted verification records
 */
export function deriveOnAirOutputView(input = {}) {
  const criticalDiagnostics = [];
  const verificationDiagnostics = [];
  const root = isRecord(input) ? input : {};
  if (!isRecord(input)) addCode(criticalDiagnostics, 'invalid_input');

  const protocol = isRecord(root.protocolSnapshot) ? root.protocolSnapshot : {};
  if (!isRecord(root.protocolSnapshot)) addCode(criticalDiagnostics, 'invalid_protocol_snapshot');
  if (protocol.protocolVersion !== ON_AIR_PROTOCOL_VERSION) {
    addCode(criticalDiagnostics, 'unsupported_protocol_version');
  }
  if (hasOwn(protocol, 'type') && protocol.type !== SERVER_MESSAGE_TYPES.PLAYER_SNAPSHOT) {
    addCode(criticalDiagnostics, 'invalid_snapshot_type');
  }

  const selectedOutputMode = protocol.selectedOutputMode === null
    ? null
    : OUTPUT_MODE_SET.has(protocol.selectedOutputMode) ? protocol.selectedOutputMode : null;
  if (protocol.selectedOutputMode !== null && !OUTPUT_MODE_SET.has(protocol.selectedOutputMode)) {
    addCode(criticalDiagnostics, 'invalid_selected_output_mode');
  }
  if (!isRecord(protocol.eligibleCandidates)) addCode(criticalDiagnostics, 'invalid_eligible_candidates');
  const eligibleCandidates = {
    speaker: normalizeCandidateList(
      protocol.eligibleCandidates?.speaker,
      ON_AIR_OUTPUT_MODES.SPEAKER,
      criticalDiagnostics,
    ),
    obs: normalizeCandidateList(
      protocol.eligibleCandidates?.obs,
      ON_AIR_OUTPUT_MODES.OBS,
      criticalDiagnostics,
    ),
  };
  const candidates = {
    [ON_AIR_OUTPUT_MODES.SPEAKER]: candidateView(
      ON_AIR_OUTPUT_MODES.SPEAKER,
      eligibleCandidates,
    ),
    [ON_AIR_OUTPUT_MODES.OBS]: candidateView(
      ON_AIR_OUTPUT_MODES.OBS,
      eligibleCandidates,
    ),
  };
  const candidate = selectedOutputMode === null
    ? candidateView(null, eligibleCandidates)
    : candidates[selectedOutputMode];

  const lease = isRecord(protocol.lease) ? protocol.lease : {};
  if (!isRecord(protocol.lease)) addCode(criticalDiagnostics, 'invalid_lease');
  const rawLeaseStatus = RAW_LEASE_STATES.has(lease.status) ? lease.status : 'unknown';
  if (!RAW_LEASE_STATES.has(lease.status)) addCode(criticalDiagnostics, 'invalid_lease_status');
  if (!Number.isSafeInteger(lease.epoch) || lease.epoch < 0) addCode(criticalDiagnostics, 'invalid_lease_epoch');
  const leaseTarget = lease.leaseTarget === null
    ? null
    : isIdentifier(lease.leaseTarget) ? lease.leaseTarget : null;
  if (lease.leaseTarget !== null && !isIdentifier(lease.leaseTarget)) {
    addCode(criticalDiagnostics, 'invalid_lease_target');
  }
  const leaseClientKind = lease.clientKind === null
    ? null
    : Object.values(PLAYER_CLIENT_KINDS).includes(lease.clientKind) ? lease.clientKind : null;
  if (lease.clientKind !== null && !Object.values(PLAYER_CLIENT_KINDS).includes(lease.clientKind)) {
    addCode(criticalDiagnostics, 'invalid_lease_client_kind');
  }
  if (lease.switchId !== null && !isIdentifier(lease.switchId)) {
    addCode(criticalDiagnostics, 'invalid_switch_id');
  }
  const leaseStatus = normalizeLeaseStatus(rawLeaseStatus);
  const leaseMode = modeForClientKind(leaseClientKind);
  if (ACTIVE_LEASE_STATES.has(rawLeaseStatus) && (leaseTarget === null || leaseMode === null)) {
    addCode(criticalDiagnostics, 'invalid_active_lease_identity');
  }
  if (rawLeaseStatus === 'inactive' && (leaseTarget !== null || leaseClientKind !== null)) {
    addCode(criticalDiagnostics, 'invalid_inactive_lease_identity');
  }

  const desiredTransport = isRecord(protocol.desiredTransport) ? protocol.desiredTransport : {};
  const confirmedPlayback = isRecord(protocol.confirmedPlayback) ? protocol.confirmedPlayback : {};
  if (!isRecord(protocol.desiredTransport)) addCode(criticalDiagnostics, 'invalid_desired_transport');
  if (!isRecord(protocol.confirmedPlayback)) addCode(criticalDiagnostics, 'invalid_confirmed_playback');
  const desiredStatus = DESIRED_PLAYBACK_STATES.has(desiredTransport.status)
    ? desiredTransport.status
    : 'unknown';
  const confirmedStatus = CONFIRMED_PLAYBACK_STATES.has(confirmedPlayback.status)
    ? confirmedPlayback.status
    : 'unknown';
  if (!DESIRED_PLAYBACK_STATES.has(desiredTransport.status)) {
    addCode(criticalDiagnostics, 'invalid_desired_status');
  }
  if (!CONFIRMED_PLAYBACK_STATES.has(confirmedPlayback.status)) {
    addCode(criticalDiagnostics, 'invalid_confirmed_status');
  }

  const activeFamily = parseActiveFamily(protocol, criticalDiagnostics);
  const activeCheck = parseActiveCheckId(protocol, criticalDiagnostics);
  const adapter = parseAdapterSnapshot(root.adapterSnapshot, criticalDiagnostics);
  const verification = parseVerification(
    root.verification,
    selectedOutputMode,
    verificationDiagnostics,
  );
  const verificationByScope = parseVerificationByScope(
    root.verificationByScope,
    selectedOutputMode,
    verificationDiagnostics,
  );
  const inputValid = criticalDiagnostics.length === 0;
  const confirmedOutputMode = ['ready', 'audible'].includes(rawLeaseStatus) ? leaseMode : null;
  const modeMismatch = leaseMode !== null
    && ACTIVE_LEASE_STATES.has(rawLeaseStatus)
    && leaseMode !== selectedOutputMode;
  const candidateTargetMismatch = ['activating', 'ready', 'audible'].includes(rawLeaseStatus)
    && candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE
    && candidate.playerInstanceId !== leaseTarget;
  const playbackInconsistent = (rawLeaseStatus === 'audible' && confirmedStatus !== 'playing')
    || (confirmedStatus === 'playing' && rawLeaseStatus !== 'audible');
  const adapterInconsistent = adapter.available && (
    adapter.routeState === 'unknown'
    || adapter.disposed
    || (['ready', 'audible'].includes(rawLeaseStatus)
      && (adapter.safetyLocked || !ADAPTER_ACTIVE_STATES.has(adapter.routeState)))
  );

  let statusCode;
  if (!inputValid) statusCode = 'invalid_input';
  else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.EMERGENCY) statusCode = 'emergency_stopping';
  else if (rawLeaseStatus === 'failed') statusCode = 'activation_failed';
  else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.UNKNOWN
    || modeMismatch || candidateTargetMismatch || playbackInconsistent || adapterInconsistent) {
    statusCode = 'state_unknown';
  } else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.DEACTIVATING) {
    statusCode = 'output_deactivating';
  } else if (candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.NONE && selectedOutputMode !== null) {
    statusCode = 'candidate_missing';
  } else if (candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.DUPLICATE) {
    statusCode = 'candidate_duplicate';
  } else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.ACTIVATING) {
    statusCode = 'output_activating';
  } else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE) {
    statusCode = 'output_inactive';
  } else if (leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.AUDIBLE) {
    statusCode = 'player_playing_confirmed';
  } else statusCode = 'route_ready';

  const relationship = playbackRelationship(desiredStatus, confirmedStatus);
  const stopProven = strongStopProven(confirmedPlayback);
  const activePlayback = activeFamily.present !== false
    || activeCheck.active !== false
    || adapter.activeRunPresent
    || CONFIRMED_ACTIVE_STATES.has(confirmedStatus);
  const noActiveRunProven = activeFamily.known
    && activeFamily.present === false
    && !adapter.activeRunPresent;
  const noActiveTestProven = activeCheck.known && activeCheck.active === false;
  const adapterSafeForActivation = !adapter.available || (
    adapter.valid
    && adapter.safetyLocked
    && ADAPTER_ACTIVATION_STATES.has(adapter.routeState)
    && !adapter.disposed
  );
  const adapterSafeForActiveCommands = !adapter.available || (
    adapter.valid
    && !adapter.safetyLocked
    && ADAPTER_ACTIVE_STATES.has(adapter.routeState)
    && !adapter.disposed
  );
  const unknownState = [
    'invalid_input',
    'state_unknown',
    'activation_failed',
    'emergency_stopping',
  ].includes(statusCode);
  const candidateSingle = candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE;
  const currentRouteStable = leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
    || (candidateSingle && !modeMismatch && !candidateTargetMismatch);
  const alternateOutputMode = selectedOutputMode === ON_AIR_OUTPUT_MODES.SPEAKER
    ? ON_AIR_OUTPUT_MODES.OBS
    : selectedOutputMode === ON_AIR_OUTPUT_MODES.OBS
      ? ON_AIR_OUTPUT_MODES.SPEAKER
      : null;
  const switchCandidate = alternateOutputMode === null ? null : candidates[alternateOutputMode];
  const switchCandidateSingle = switchCandidate?.state === ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE;
  const stableLease = ['ready', 'inactive'].includes(leaseStatus);
  const safeStopped = inputValid
    && !unknownState
    && noActiveRunProven
    && noActiveTestProven
    && DESIRED_QUIET_STATES.has(desiredStatus)
    && stopProven;
  const coldIdle = inputValid
    && leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
    && noActiveRunProven
    && noActiveTestProven
    && DESIRED_QUIET_STATES.has(desiredStatus)
    && confirmedStatus === 'unknown'
    && ['not_confirmed', 'output_inactive'].includes(confirmedPlayback.reasonCode);

  const switchAllowed = safeStopped
    && stableLease
    && currentRouteStable
    && alternateOutputMode !== null
    && switchCandidateSingle
    && (adapterSafeForActiveCommands || leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE);
  const activateAllowed = !unknownState
    && leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
    && candidateSingle
    && noActiveRunProven
    && (safeStopped || coldIdle)
    && adapterSafeForActivation;
  const deactivateAllowed = leaseTarget !== null
    && leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
    && leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.EMERGENCY;
  const retryAllowed = unknownState
    || candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.NONE
    || candidate.state === ON_AIR_OUTPUT_CANDIDATE_STATES.DUPLICATE;
  const resumeAllowed = !unknownState
    && leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.READY
    && candidateSingle
    && activeFamily.present === true
    && activeCheck.active === false
    && confirmedStatus === 'paused'
    && adapterSafeForActiveCommands;
  const startTestAllowed = !unknownState
    && selectedOutputMode === ON_AIR_OUTPUT_MODES.OBS
    && leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.READY
    && candidateSingle
    && activeCheck.active === false
    && safeStopped
    && adapterSafeForActiveCommands;
  const stopTestAllowed = !unknownState
    && ['ready', 'audible'].includes(leaseStatus)
    && candidateSingle
    && activeCheck.active === true
    && adapterSafeForActiveCommands;

  const generalBlock = blockedReason({
    inputValid,
    unknownState,
    activePlayback,
    stopProven,
    adapterSafe: adapterSafeForActiveCommands || adapterSafeForActivation,
  });

  const targets = Object.fromEntries(Object.values(ON_AIR_OUTPUT_MODES).map((mode) => {
    const targetCandidate = candidates[mode];
    const targetCandidateSingle = targetCandidate.state
      === ON_AIR_OUTPUT_CANDIDATE_STATES.SINGLE;
    const targetActivateAllowed = !unknownState
      && leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
      && targetCandidateSingle
      && noActiveRunProven
      && (safeStopped || coldIdle)
      && adapterSafeForActivation;
    const targetSwitchAllowed = mode !== selectedOutputMode
      && safeStopped
      && stableLease
      && currentRouteStable
      && targetCandidateSingle
      && (adapterSafeForActiveCommands || leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE);
    const operation = leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
      ? ON_AIR_OUTPUT_ACTIONS.ACTIVATE
      : mode === selectedOutputMode
        ? null
        : ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT;
    const allowed = operation === ON_AIR_OUTPUT_ACTIONS.ACTIVATE
      ? targetActivateAllowed
      : operation === ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT && targetSwitchAllowed;
    const reasonCode = operation === null
      ? ON_AIR_OUTPUT_GATE_CODES.NOT_NEEDED
      : unknownState || !currentRouteStable
        ? ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN
        : !targetCandidateSingle
          ? ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE
          : operation === ON_AIR_OUTPUT_ACTIONS.ACTIVATE
            && leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
            ? ON_AIR_OUTPUT_GATE_CODES.LEASE_NOT_INACTIVE
            : generalBlock;
    return [mode, {
      mode,
      selected: mode === selectedOutputMode,
      candidate: targetCandidate,
      operation,
      action: gate(operation ?? ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT, allowed, reasonCode),
      messageKey: `onair.output.mode.${mode}`,
    }];
  }));

  const actions = {
    [ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT]: gate(
      ON_AIR_OUTPUT_ACTIONS.SWITCH_OUTPUT,
      switchAllowed,
      !currentRouteStable
        ? ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN
        : !switchCandidateSingle
          ? ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE
          : generalBlock,
    ),
    [ON_AIR_OUTPUT_ACTIONS.ACTIVATE]: gate(
      ON_AIR_OUTPUT_ACTIONS.ACTIVATE,
      activateAllowed,
      unknownState
        ? ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN
        : !candidateSingle
          ? ON_AIR_OUTPUT_GATE_CODES.CANDIDATE_NOT_SINGLE
          : leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.INACTIVE
            ? ON_AIR_OUTPUT_GATE_CODES.LEASE_NOT_INACTIVE
            : !adapterSafeForActivation
              ? ON_AIR_OUTPUT_GATE_CODES.ADAPTER_NOT_SAFE
              : generalBlock,
    ),
    [ON_AIR_OUTPUT_ACTIONS.DEACTIVATE]: gate(
      ON_AIR_OUTPUT_ACTIONS.DEACTIVATE,
      deactivateAllowed,
      leaseTarget === null
        ? ON_AIR_OUTPUT_GATE_CODES.NO_LEASE_TARGET
        : ON_AIR_OUTPUT_GATE_CODES.NOT_NEEDED,
    ),
    [ON_AIR_OUTPUT_ACTIONS.RETRY]: gate(
      ON_AIR_OUTPUT_ACTIONS.RETRY,
      retryAllowed,
      ON_AIR_OUTPUT_GATE_CODES.NOT_NEEDED,
    ),
    [ON_AIR_OUTPUT_ACTIONS.RESUME]: gate(
      ON_AIR_OUTPUT_ACTIONS.RESUME,
      resumeAllowed,
      unknownState
        ? ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN
        : confirmedStatus !== 'paused'
          ? ON_AIR_OUTPUT_GATE_CODES.NOT_PAUSED
          : leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.READY
            ? ON_AIR_OUTPUT_GATE_CODES.LEASE_NOT_READY
            : generalBlock,
    ),
    [ON_AIR_OUTPUT_ACTIONS.START_TEST]: gate(
      ON_AIR_OUTPUT_ACTIONS.START_TEST,
      startTestAllowed,
      activeCheck.active === true
        ? ON_AIR_OUTPUT_GATE_CODES.TEST_ACTIVE
        : selectedOutputMode !== ON_AIR_OUTPUT_MODES.OBS
          ? ON_AIR_OUTPUT_GATE_CODES.MODE_NOT_OBS
          : leaseStatus !== ON_AIR_OUTPUT_LEASE_STATES.READY
            ? ON_AIR_OUTPUT_GATE_CODES.LEASE_NOT_READY
            : generalBlock,
    ),
    [ON_AIR_OUTPUT_ACTIONS.STOP_TEST]: gate(
      ON_AIR_OUTPUT_ACTIONS.STOP_TEST,
      stopTestAllowed,
      unknownState
        ? ON_AIR_OUTPUT_GATE_CODES.STATE_UNKNOWN
        : activeCheck.active !== true
          ? ON_AIR_OUTPUT_GATE_CODES.NO_ACTIVE_TEST
          : !['ready', 'audible'].includes(leaseStatus)
            ? ON_AIR_OUTPUT_GATE_CODES.LEASE_NOT_READY
            : generalBlock,
    ),
    [ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP]: gate(
      ON_AIR_OUTPUT_ACTIONS.EMERGENCY_STOP,
      true,
      ON_AIR_OUTPUT_GATE_CODES.ALLOWED,
    ),
    [ON_AIR_OUTPUT_ACTIONS.AUTO_RESUME]: gate(
      ON_AIR_OUTPUT_ACTIONS.AUTO_RESUME,
      false,
      ON_AIR_OUTPUT_GATE_CODES.POLICY_MANUAL_ONLY,
    ),
    [ON_AIR_OUTPUT_ACTIONS.AUTO_FALLBACK]: gate(
      ON_AIR_OUTPUT_ACTIONS.AUTO_FALLBACK,
      false,
      ON_AIR_OUTPUT_GATE_CODES.POLICY_MANUAL_ONLY,
    ),
  };
  const availableActions = AVAILABLE_ACTION_ORDER.filter((action) => actions[action].allowed);

  return deepFreeze({
    statusCode,
    messageKey: statusMessageKey(statusCode, selectedOutputMode),
    inputValid,
    diagnostics: [...criticalDiagnostics, ...verificationDiagnostics],
    mode: {
      desired: selectedOutputMode,
      lease: leaseMode,
      confirmed: confirmedOutputMode,
      relationship: modeMismatch
        ? 'mismatch'
        : selectedOutputMode === confirmedOutputMode
          ? 'matched'
          : leaseStatus === ON_AIR_OUTPUT_LEASE_STATES.ACTIVATING
            ? 'pending'
            : 'unknown',
      messageKey: `onair.output.mode.${selectedOutputMode ?? 'unselected'}`,
    },
    candidate,
    candidates,
    targets,
    switchTarget: {
      mode: alternateOutputMode,
      candidate: switchCandidate,
      messageKey: `onair.output.mode.${alternateOutputMode ?? 'unselected'}`,
    },
    lease: {
      status: leaseStatus,
      targetPlayerInstanceId: leaseTarget,
      clientKind: leaseClientKind,
      proofScope: 'player_route',
      routeEventConfirmed: ['ready', 'audible'].includes(rawLeaseStatus),
      playerPlayingConfirmed: rawLeaseStatus === 'audible' && confirmedStatus === 'playing',
      messageKey: `onair.output.lease.${leaseStatus}`,
    },
    playback: {
      desiredStatus,
      confirmedStatus,
      relationship,
      strongStopProven: stopProven,
      activeFamily,
      messageKey: `onair.output.playback.${relationship}`,
    },
    test: {
      ...activeCheck,
      messageKey: `onair.output.test.${activeCheck.active === true
        ? 'active'
        : activeCheck.active === false ? 'inactive' : 'unknown'}`,
    },
    adapter,
    verification,
    verificationByScope,
    actions,
    availableActions,
  });
}
