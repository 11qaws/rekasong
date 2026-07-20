import { useCallback, useEffect, useRef, useState } from 'react';

import {
  OnAirControlCoordinator,
} from '../lib/onAirControlCoordinator.js';
import { createControlPageIdentity } from '../lib/onAirClientState.js';
import {
  ON_AIR_OUTPUT_MODES,
  deriveOnAirOutputView,
} from '../lib/onAirOutputView.js';
import { ON_AIR_V2_CONNECTION_STATES } from '../lib/onAirV2Connection.js';

const BUILD_ID = String(import.meta.env?.VITE_APP_BUILD_ID || 'rekasong-web-v2');
const OUTPUT_MODE_SET = new Set(Object.values(ON_AIR_OUTPUT_MODES));
const ACTIVE_LEASE_STATES = new Set(['ready', 'audible']);
const UNKNOWN_LEASE_STATES = new Set(['unknown', 'failed', 'emergency_stopping']);

export const ON_AIR_OUTPUT_CONNECTION_TIMEOUT_MS = 10_000;
export const ON_AIR_OUTPUT_SWITCH_TIMEOUT_MS = 12_000;
export const ON_AIR_OUTPUT_CANDIDATE_WAIT_MS = 12_000;

export const ON_AIR_OUTPUT_CONTROL_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'output_control_invalid_configuration',
  INVALID_ARGUMENT: 'output_control_invalid_argument',
  DISABLED: 'output_control_disabled',
  DISPOSED: 'output_control_disposed',
  NOT_READY: 'output_control_not_ready',
  NOT_WRITABLE: 'output_control_not_writable',
  STATE_UNKNOWN: 'output_control_state_unknown',
  CANDIDATE_COUNT: 'output_control_candidate_count',
  ACTIVE_WORK: 'output_control_active_work',
  SWITCH_PENDING: 'output_control_switch_pending',
  LEASE_NOT_SWITCHABLE: 'output_control_lease_not_switchable',
  TARGET_IDENTITY_MISMATCH: 'output_control_target_identity_mismatch',
  COMMAND_UNSUPPORTED: 'output_control_command_unsupported',
  RUN_IDENTITY_REQUIRED: 'output_control_run_identity_required',
  RUN_IDENTITY_MISMATCH: 'output_control_run_identity_mismatch',
  UNOWNED_ACTIVE_RUN: 'output_control_unowned_active_run',
  PLAYBACK_TRANSITION_PENDING: 'output_control_playback_transition_pending',
  CONNECTION_TIMEOUT: 'output_control_connection_timeout',
  SWITCH_TIMEOUT: 'output_control_switch_timeout',
});

export const ON_AIR_OUTPUT_SWITCH_STATUSES = Object.freeze({
  IDLE: 'idle',
  DEACTIVATING: 'deactivating',
  ACTIVATING: 'activating',
  BLOCKED: 'blocked',
});

export const ON_AIR_PLAYBACK_TRANSITION_STATUSES = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  STOPPING: 'stopping',
  FAILED: 'failed',
});

export const ON_AIR_PLAYBACK_TRANSITION_REASONS = Object.freeze({
  CONNECTION_LOST: 'connection_lost',
  AUTHORITY_UNKNOWN: 'authority_unknown',
  OUTPUT_ROUTE_LOST: 'output_route_lost',
  RUN_IDENTITY_MISMATCH: 'run_identity_mismatch',
  LOAD_REJECTED: 'load_rejected',
  LOAD_DISPATCH_FAILED: 'load_dispatch_failed',
  STOP_DISPATCH_FAILED: 'stop_dispatch_failed',
  STOP_PROOF_MISSING: 'stop_proof_missing',
  LOAD_ERROR: 'load_error',
  LOAD_ENDED: 'load_ended',
  LOAD_STOPPED: 'load_stopped',
  PLAY_DISPATCH_FAILED: 'play_dispatch_failed',
});

export class OnAirOutputControlError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirOutputControlError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim();
}

function outputSwitchState(status = ON_AIR_OUTPUT_SWITCH_STATUSES.IDLE, targetMode = null, reasonCode = null) {
  return Object.freeze({ status, targetMode, reasonCode });
}

function playbackTransitionState(
  status = ON_AIR_PLAYBACK_TRANSITION_STATUSES.IDLE,
  entryId = null,
  runId = null,
  reasonCode = null,
) {
  return Object.freeze({ status, entryId, runId, reasonCode });
}

function controlError(code, detail) {
  return new OnAirOutputControlError(code, detail);
}

function scheduleWatchdog(callback, delayMs) {
  const timer = globalThis.setTimeout(callback, delayMs);
  // Node's test runner should not be kept alive by a production watchdog.
  timer?.unref?.();
  return timer;
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim();
  if (!value) throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'baseUrl' });
  let url;
  try {
    url = new URL(value);
  } catch {
    throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'baseUrl' });
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, {
      field: 'baseUrl',
      protocol: url.protocol,
    });
  }
  return url.toString().replace(/\/$/, '');
}

function validateSession(session) {
  if (!isRecord(session) || !isIdentifier(session.room) || !isIdentifier(session.controlToken)) {
    throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'session' });
  }
  return session;
}

export function buildOnAirControlSocketUrl(baseUrl, session) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const validSession = validateSession(session);
  const url = new URL(`/v1/sessions/${encodeURIComponent(validSession.room)}/ws`, normalizedBaseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.searchParams.set('role', 'control');
  url.searchParams.set('token', validSession.controlToken);
  url.searchParams.set('protocol', '2');
  return url.toString();
}

function modeForClientKind(clientKind) {
  if (clientKind === 'dashboard-speaker') return ON_AIR_OUTPUT_MODES.SPEAKER;
  if (clientKind === 'obs-browser-source') return ON_AIR_OUTPUT_MODES.OBS;
  return null;
}

function confirmedOutputMode(snapshot) {
  const lease = snapshot?.playerSnapshot?.lease;
  return ACTIVE_LEASE_STATES.has(lease?.status) ? modeForClientKind(lease.clientKind) : null;
}

function selectedOutputMode(snapshot) {
  const selected = snapshot?.playerSnapshot?.selectedOutputMode;
  return OUTPUT_MODE_SET.has(selected) ? selected : null;
}

function isStrongStoppedPlayback(snapshot) {
  const confirmed = snapshot?.confirmedPlayback ?? snapshot?.playerSnapshot?.confirmedPlayback;
  return snapshot?.activeRun === null
    && snapshot?.playerSnapshot?.activeFamily === null
    && confirmed?.status === 'stopped'
    && confirmed.paused === true
    && confirmed.sourceDetached === true
    && confirmed.autoplayCancelled === true
    && confirmed.audible === false;
}

function deriveView(snapshot) {
  return deriveOnAirOutputView({ protocolSnapshot: snapshot?.playerSnapshot ?? null });
}

function publicState(snapshot, switchState, transitionState) {
  return Object.freeze({
    connectionState: snapshot?.state ?? ON_AIR_V2_CONNECTION_STATES.IDLE,
    snapshot: snapshot ?? null,
    requestedOutputMode: selectedOutputMode(snapshot),
    actualOutputMode: confirmedOutputMode(snapshot),
    outputSwitchState: switchState,
    playbackTransitionState: transitionState,
    outputView: deriveView(snapshot),
  });
}

function createCoordinator({
  session,
  baseUrl,
  buildId,
  webSocketFactory,
  coordinatorFactory,
  controlIdentity,
}) {
  return coordinatorFactory({
    transport: {
      url: buildOnAirControlSocketUrl(baseUrl, session),
      sessionId: session.room,
      webSocketFactory,
      buildId,
      capabilities: {},
      identity: controlIdentity,
    },
  });
}

/**
 * Pure, React-independent owner for one Protocol v2 control coordinator.
 * It intentionally never resumes playback while changing output routes.
 */
export class OnAirOutputController {
  #session;
  #baseUrl;
  #buildId;
  #webSocketFactory;
  #coordinatorFactory;
  #controlIdentity;
  #dashboardSpeakerPlayerInstanceId;
  #coordinator = null;
  #coordinatorUnsubscribe = null;
  #snapshot = null;
  #switchState = outputSwitchState();
  #playbackTransitionState = playbackTransitionState();
  #switchIntent = null;
  #pendingLoadAfterStop = null;
  #pendingPlayAfterLoad = null;
  #stopRequested = false;
  #subscribers = new Set();
  #connected = false;
  #disposed = false;
  #setTimeoutFn;
  #clearTimeoutFn;
  #connectionTimeoutMs;
  #switchTimeoutMs;
  #candidateWaitMs;
  #connectionWatchdogTimer = null;
  #switchWatchdogTimer = null;

  constructor({
    session,
    baseUrl,
    buildId = BUILD_ID,
    webSocketFactory = (url) => new WebSocket(url),
    coordinatorFactory = (options) => new OnAirControlCoordinator(options),
    setTimeoutFn = scheduleWatchdog,
    clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
    connectionTimeoutMs = ON_AIR_OUTPUT_CONNECTION_TIMEOUT_MS,
    switchTimeoutMs = ON_AIR_OUTPUT_SWITCH_TIMEOUT_MS,
    candidateWaitMs = ON_AIR_OUTPUT_CANDIDATE_WAIT_MS,
    dashboardSpeakerPlayerInstanceId = null,
  } = {}) {
    this.#session = validateSession(session);
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (!isIdentifier(buildId)) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'buildId' });
    }
    if (dashboardSpeakerPlayerInstanceId !== null
      && !isIdentifier(dashboardSpeakerPlayerInstanceId)) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, {
        field: 'dashboardSpeakerPlayerInstanceId',
      });
    }
    if (typeof webSocketFactory !== 'function' || typeof coordinatorFactory !== 'function') {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'factory' });
    }
    if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function'
      || !Number.isFinite(connectionTimeoutMs) || connectionTimeoutMs <= 0
      || !Number.isFinite(switchTimeoutMs) || switchTimeoutMs <= 0
      || !Number.isFinite(candidateWaitMs) || candidateWaitMs <= 0) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'watchdog' });
    }
    this.#buildId = buildId;
    this.#webSocketFactory = webSocketFactory;
    this.#coordinatorFactory = coordinatorFactory;
    this.#setTimeoutFn = setTimeoutFn;
    this.#clearTimeoutFn = clearTimeoutFn;
    this.#connectionTimeoutMs = connectionTimeoutMs;
    this.#switchTimeoutMs = switchTimeoutMs;
    this.#candidateWaitMs = candidateWaitMs;
    this.#dashboardSpeakerPlayerInstanceId = dashboardSpeakerPlayerInstanceId;
    // One browser page is one control participant. Keep its identity stable
    // when the socket/coordinator is rebuilt so a reconnect cannot look like a
    // surprise second tab to the Worker.
    this.#controlIdentity = createControlPageIdentity();
    this.#replaceCoordinator();
  }

  connect() {
    this.#assertUsable();
    if (this.#connected) return this.#coordinator.snapshot();
    this.#connected = true;
    try {
      const result = this.#coordinator.connect();
      this.#reconcileConnectionWatchdog();
      return result;
    } catch (error) {
      this.#connected = false;
      this.#clearConnectionWatchdog();
      throw error;
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connected = false;
    this.#clearConnectionWatchdog();
    this.#clearSwitchWatchdog();
    this.#switchIntent = null;
    this.#pendingLoadAfterStop = null;
    this.#pendingPlayAfterLoad = null;
    this.#stopRequested = false;
    this.#coordinatorUnsubscribe?.();
    this.#coordinatorUnsubscribe = null;
    this.#coordinator?.dispose();
    this.#subscribers.clear();
  }

  subscribe(listener) {
    this.#assertUsable();
    if (typeof listener !== 'function') {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_ARGUMENT, { field: 'listener' });
    }
    this.#subscribers.add(listener);
    listener(this.getState());
    return () => this.#subscribers.delete(listener);
  }

  getState() {
    return publicState(this.#snapshot, this.#switchState, this.#playbackTransitionState);
  }

  retryConnection() {
    this.#assertUsable();
    this.#clearConnectionWatchdog();
    this.#clearSwitchWatchdog();
    this.#switchIntent = null;
    if (this.#hasActivePlaybackTransition()) {
      this.#failPlaybackTransition(ON_AIR_PLAYBACK_TRANSITION_REASONS.CONNECTION_LOST);
    } else {
      this.#pendingLoadAfterStop = null;
      this.#pendingPlayAfterLoad = null;
      this.#stopRequested = false;
    }
    this.#switchState = outputSwitchState();
    this.#coordinatorUnsubscribe?.();
    this.#coordinatorUnsubscribe = null;
    this.#coordinator?.dispose();
    this.#connected = false;
    this.#replaceCoordinator();
    this.#publish();
    return this.connect();
  }

  emergencyStop() {
    this.#assertUsable();
    const result = this.#coordinator.emergencyStop();
    this.#switchIntent = null;
    this.#clearSwitchWatchdog();
    this.#switchState = outputSwitchState();
    this.#publish();
    return result;
  }

  takeOverControl() {
    this.#assertUsable();
    const result = this.#coordinator.takeOverControl();
    this.#switchIntent = null;
    this.#clearSwitchWatchdog();
    this.#switchState = outputSwitchState();
    this.#publish();
    return result;
  }

  startTest(options) {
    this.#assertUsable();
    return this.#coordinator.startTest(options);
  }

  stopTest() {
    this.#assertUsable();
    return this.#coordinator.stopTest();
  }

  selectOutputMode(mode) {
    this.#assertUsable();
    if (!OUTPUT_MODE_SET.has(mode)) {
      return this.#blockAndThrow(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_ARGUMENT, { field: 'mode', mode });
    }

    try {
      const observedLease = this.#snapshot?.playerSnapshot?.lease;
      const speakerRecovery = mode === ON_AIR_OUTPUT_MODES.SPEAKER
        && observedLease?.clientKind === 'dashboard-speaker'
        && UNKNOWN_LEASE_STATES.has(observedLease?.status)
        && isIdentifier(observedLease?.leaseTarget);
      this.#assertControlReady({ allowSpeakerRecovery: speakerRecovery });
      if (this.#switchIntent || this.#snapshot.pendingSwitch) {
        throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.SWITCH_PENDING, {});
      }
      const lease = this.#snapshot.playerSnapshot.lease;
      const leaseMode = modeForClientKind(lease.clientKind);
      if (speakerRecovery) {
        this.#assertNoActiveWork({ allowSpeakerRecovery: true });
        this.#switchIntent = { targetMode: mode, phase: ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING };
        this.#switchState = outputSwitchState(ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING, mode);
        this.#armSwitchWatchdog(mode, ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING);
        this.#publish();
        try {
          return this.#coordinator.deactivateOutput();
        } catch (error) {
          this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.STATE_UNKNOWN);
          throw error;
        }
      }
      if (ACTIVE_LEASE_STATES.has(lease.status) && leaseMode === mode) {
        this.#switchIntent = null;
        this.#clearSwitchWatchdog();
        this.#switchState = outputSwitchState();
        this.#publish();
        return Object.freeze({ status: 'already_active', mode });
      }
      this.#assertNoActiveWork();
      const candidates = this.#snapshot?.playerSnapshot?.eligibleCandidates?.[mode];
      // The dashboard speaker is owned by this page, but its lazy player can
      // register one snapshot after the route buttons become interactive. A
      // click in that short window is a valid intent, not a configuration
      // error. Wait only for this page-owned speaker and keep OBS fail-closed:
      // a missing external OBS source must still be reported immediately.
      if (mode === ON_AIR_OUTPUT_MODES.SPEAKER
        && lease.status === 'inactive'
        && this.#dashboardSpeakerPlayerInstanceId !== null
        && Array.isArray(candidates)
        && candidates.length === 0) {
        return this.#waitForDashboardSpeakerCandidate(mode);
      }
      this.#assertSingleCandidate(mode);
      if (lease.status === 'inactive') {
        return this.#activate(mode);
      }
      if (!ACTIVE_LEASE_STATES.has(lease.status) || leaseMode === null) {
        return this.#blockAndThrow(ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE, {
          status: lease.status,
          leaseMode,
        });
      }

      this.#switchIntent = { targetMode: mode, phase: ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING };
      this.#switchState = outputSwitchState(ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING, mode);
      this.#armSwitchWatchdog(mode, ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING);
      this.#publish();
      try {
        return this.#coordinator.deactivateOutput();
      } catch (error) {
        this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
        throw error;
      }
    } catch (error) {
      if (error instanceof OnAirOutputControlError && this.#switchState.status !== ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED) {
        this.#setBlocked(error.code, mode);
      }
      throw error;
    }
  }

  sendCommand(command) {
    this.#assertUsable();
    this.#assertControlReady();
    if (!isRecord(command) || typeof command.type !== 'string') {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_ARGUMENT, { field: 'command' });
    }

    switch (command.type) {
      case 'load': {
        return this.#sendLoad(command);
      }
      case 'play':
        this.#assertLegacyRunTarget(command);
        {
          const result = this.#coordinator.play();
          this.#pendingPlayAfterLoad = null;
          return result;
        }
      case 'pause':
        this.#assertLegacyRunTarget(command);
        this.#pendingPlayAfterLoad = null;
        return this.#coordinator.pause();
      case 'seek':
        this.#assertLegacyRunTarget(command);
        return this.#coordinator.seek(command.position);
      case 'volume':
        this.#assertLegacyRunTarget(command);
        return this.#coordinator.setVolume(command.volume);
      case 'stop':
        this.#assertLegacyRunTarget(command);
        this.#pendingPlayAfterLoad = null;
        if (this.#stopRequested) {
          return Object.freeze({ status: 'already_stopping' });
        }
        {
          const result = this.#coordinator.stop();
          this.#stopRequested = true;
          return result;
        }
      case 'prefetch':
        return this.#coordinator.prefetch(command.videoIds);
      case 'display_state':
        return this.#coordinator.publishDisplayState(command.display);
      case 'end_session':
        this.#pendingLoadAfterStop = null;
        this.#pendingPlayAfterLoad = null;
        return this.#coordinator.endSession();
      default:
        throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.COMMAND_UNSUPPORTED, { type: command.type });
    }
  }

  #replaceCoordinator() {
    const coordinator = createCoordinator({
      session: this.#session,
      baseUrl: this.#baseUrl,
      buildId: this.#buildId,
      webSocketFactory: this.#webSocketFactory,
      coordinatorFactory: this.#coordinatorFactory,
      controlIdentity: this.#controlIdentity,
    });
    for (const method of [
      'connect',
      'dispose',
      'subscribe',
      'snapshot',
      'activateOutput',
      'deactivateOutput',
      'emergencyStop',
      'takeOverControl',
    ]) {
      if (typeof coordinator?.[method] !== 'function') {
        throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, {
          field: `coordinator.${method}`,
        });
      }
    }
    this.#coordinator = coordinator;
    this.#snapshot = coordinator.snapshot();
    this.#coordinatorUnsubscribe = coordinator.subscribe((snapshot) => {
      if (this.#disposed || coordinator !== this.#coordinator) return;
      this.#snapshot = snapshot;
      this.#reconcileConnectionWatchdog();
      this.#reconcileSwitchIntent();
      this.#reconcilePlaybackTransition();
      this.#reconcilePendingPlay();
      this.#reconcilePendingLoad();
      this.#publish();
    });
  }

  #assertUsable() {
    if (this.#disposed) throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.DISPOSED, {});
  }

  #connectionNeedsWatchdog() {
    const snapshot = this.#snapshot;
    if (!snapshot || ['disconnected', 'superseded', 'closed'].includes(snapshot.state)) return false;
    if (snapshot.ready !== true) return true;
    if (snapshot.authorityUnknown || snapshot.unknownLock) return false;
    if (snapshot.writable === true) return false;

    // A connected foreign owner is a settled, explainable conflict. An
    // ownerless read-only lease is not: it is the released-owner race that must
    // be bounded and re-negotiated instead of looking like endless startup.
    const self = snapshot.welcome?.controlInstanceId ?? null;
    const controlLease = snapshot.playerSnapshot?.controlLease;
    const owner = controlLease?.writableControlInstanceId ?? null;
    const foreignOwnerConnected = Boolean(
      owner && owner !== self && controlLease?.writableConnected === true,
    );
    if (foreignOwnerConnected) return false;
    return owner === null && controlLease?.writableConnected === false;
  }

  #reconcileConnectionWatchdog() {
    if (!this.#connected || this.#disposed) return;
    if (!this.#connectionNeedsWatchdog()) {
      this.#clearConnectionWatchdog();
      if (this.#switchState.reasonCode === ON_AIR_OUTPUT_CONTROL_CODES.CONNECTION_TIMEOUT
        && !this.#switchIntent) {
        this.#switchState = outputSwitchState();
      }
      return;
    }
    if (this.#switchState.reasonCode === ON_AIR_OUTPUT_CONTROL_CODES.CONNECTION_TIMEOUT) return;
    if (this.#connectionWatchdogTimer !== null) return;
    this.#connectionWatchdogTimer = this.#setTimeoutFn(() => {
      this.#connectionWatchdogTimer = null;
      if (!this.#connected || this.#disposed || !this.#connectionNeedsWatchdog()) return;
      this.#setBlocked(ON_AIR_OUTPUT_CONTROL_CODES.CONNECTION_TIMEOUT, null);
    }, this.#connectionTimeoutMs);
  }

  #clearConnectionWatchdog() {
    if (this.#connectionWatchdogTimer === null) return;
    this.#clearTimeoutFn(this.#connectionWatchdogTimer);
    this.#connectionWatchdogTimer = null;
  }

  #armSwitchWatchdog(targetMode, phase) {
    this.#clearSwitchWatchdog();
    this.#switchWatchdogTimer = this.#setTimeoutFn(() => {
      this.#switchWatchdogTimer = null;
      const intent = this.#switchIntent;
      if (this.#disposed || !intent
        || intent.targetMode !== targetMode || intent.phase !== phase) return;
      // Missing terminal evidence is never interpreted as success. Keep the
      // target diagnostic only, block further routing, and require a fresh
      // authoritative connection (or emergency stop when the route is unknown).
      let reasonCode = ON_AIR_OUTPUT_CONTROL_CODES.SWITCH_TIMEOUT;
      if (intent.awaitingCandidate === true) {
        const candidates = this.#snapshot?.playerSnapshot?.eligibleCandidates?.[intent.targetMode];
        reasonCode = Array.isArray(candidates)
          && candidates.length === 1
          && this.#dashboardSpeakerPlayerInstanceId !== null
          && candidates[0] !== this.#dashboardSpeakerPlayerInstanceId
          ? ON_AIR_OUTPUT_CONTROL_CODES.TARGET_IDENTITY_MISMATCH
          : ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT;
      }
      this.#failSwitch(reasonCode);
    }, this.#switchIntent?.awaitingCandidate === true
      ? this.#candidateWaitMs
      : this.#switchTimeoutMs);
  }

  #clearSwitchWatchdog() {
    if (this.#switchWatchdogTimer === null) return;
    this.#clearTimeoutFn(this.#switchWatchdogTimer);
    this.#switchWatchdogTimer = null;
  }

  #assertControlReady({ allowSpeakerRecovery = false } = {}) {
    const snapshot = this.#snapshot;
    if (!snapshot?.ready) throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.NOT_READY, {});
    if (!snapshot.writable) throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.NOT_WRITABLE, {});
    const lease = snapshot.playerSnapshot?.lease;
    const speakerRecovery = allowSpeakerRecovery
      && lease?.clientKind === 'dashboard-speaker'
      && UNKNOWN_LEASE_STATES.has(lease?.status)
      && isIdentifier(lease?.leaseTarget);
    if (snapshot.authorityUnknown || (!speakerRecovery
      && (snapshot.routeUnknown || UNKNOWN_LEASE_STATES.has(lease?.status)))) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.STATE_UNKNOWN, {});
    }
  }

  #assertNoActiveWork({ allowSpeakerRecovery = false } = {}) {
    const protocol = this.#snapshot?.playerSnapshot;
    if (allowSpeakerRecovery
      && protocol?.lease?.clientKind === 'dashboard-speaker'
      && UNKNOWN_LEASE_STATES.has(protocol.lease.status)) return;
    if (this.#snapshot?.activeRun || this.#snapshot?.pendingTest || this.#pendingLoadAfterStop
      || this.#pendingPlayAfterLoad
      || protocol?.activeFamily !== null || protocol?.activeCheckId !== null) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.ACTIVE_WORK, {});
    }
  }

  #assertSingleCandidate(mode) {
    const candidates = this.#snapshot?.playerSnapshot?.eligibleCandidates?.[mode];
    if (!Array.isArray(candidates) || candidates.length !== 1) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT, {
        mode,
        count: Array.isArray(candidates) ? candidates.length : null,
      });
    }
    if (mode === ON_AIR_OUTPUT_MODES.SPEAKER
      && this.#dashboardSpeakerPlayerInstanceId !== null
      && candidates[0] !== this.#dashboardSpeakerPlayerInstanceId) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.TARGET_IDENTITY_MISMATCH, {
        mode,
        expectedPlayerInstanceId: this.#dashboardSpeakerPlayerInstanceId,
        actualPlayerInstanceId: candidates[0],
      });
    }
    return candidates[0];
  }

  #assertLegacyRunTarget(command) {
    const activeRun = this.#snapshot?.activeRun ?? this.#pendingPlayAfterLoad;
    const suppliedEntryId = command.entryId ?? command.sessionId;
    if (command.entryId !== undefined && command.sessionId !== undefined
      && command.entryId !== command.sessionId) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH, {});
    }
    if (suppliedEntryId !== undefined && suppliedEntryId !== activeRun?.entryId) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH, {
        expectedEntryId: activeRun?.entryId ?? null,
        actualEntryId: suppliedEntryId,
      });
    }
    if (command.runId !== undefined && command.runId !== activeRun?.runId) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH, {
        expectedRunId: activeRun?.runId ?? null,
        actualRunId: command.runId,
      });
    }
  }

  #normalizeLoadCommand(command) {
    const entryId = command.entryId ?? command.sessionId;
    if (!isIdentifier(entryId) || !isIdentifier(command.runId)) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_REQUIRED, {});
    }
    if (command.entryId !== undefined && command.sessionId !== undefined
      && command.entryId !== command.sessionId) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.RUN_IDENTITY_MISMATCH, {
        entryId: command.entryId,
        sessionId: command.sessionId,
      });
    }
    return Object.freeze({
      entryId,
      runId: command.runId,
      song: command.song,
      position: command.position ?? 0,
      ...(command.volume === undefined ? {} : { volume: command.volume }),
    });
  }

  #sendLoad(command) {
    const load = this.#normalizeLoadCommand(command);
    if (this.#pendingLoadAfterStop || this.#pendingPlayAfterLoad) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.PLAYBACK_TRANSITION_PENDING, {});
    }
    const activeRun = this.#snapshot?.activeRun;
    const activeFamily = this.#snapshot?.playerSnapshot?.activeFamily;
    if (!activeRun && !activeFamily) {
      this.#stopRequested = false;
      return this.#dispatchLoad(load);
    }
    if (!activeRun) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.UNOWNED_ACTIVE_RUN, {});
    }
    this.#pendingLoadAfterStop = load;
    this.#beginPlaybackTransition(ON_AIR_PLAYBACK_TRANSITION_STATUSES.STOPPING, load);
    this.#publish();
    let stopResult = null;
    if (!this.#stopRequested) {
      try {
        stopResult = this.#coordinator.stop();
        this.#stopRequested = true;
      } catch (error) {
        this.#failPlaybackTransition(
          ON_AIR_PLAYBACK_TRANSITION_REASONS.STOP_DISPATCH_FAILED,
          load,
        );
        this.#publish();
        throw error;
      }
    }
    return Object.freeze({
      status: 'queued_after_stop',
      entryId: load.entryId,
      runId: load.runId,
      stopResult,
    });
  }

  #dispatchLoad(load) {
    this.#beginPlaybackTransition(ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING, load);
    const pendingPlay = {
      entryId: load.entryId,
      runId: load.runId,
      sawOwnedRun: false,
    };
    this.#pendingPlayAfterLoad = Object.freeze(pendingPlay);
    this.#publish();
    try {
      return this.#coordinator.load(load);
    } catch (error) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_DISPATCH_FAILED,
        load,
      );
      this.#publish();
      throw error;
    }
  }

  #hasActivePlaybackTransition() {
    return [
      ON_AIR_PLAYBACK_TRANSITION_STATUSES.LOADING,
      ON_AIR_PLAYBACK_TRANSITION_STATUSES.STOPPING,
    ].includes(this.#playbackTransitionState.status);
  }

  #beginPlaybackTransition(status, target) {
    this.#playbackTransitionState = playbackTransitionState(
      status,
      target.entryId,
      target.runId,
    );
  }

  #failPlaybackTransition(reasonCode, target = this.#playbackTransitionState) {
    this.#pendingLoadAfterStop = null;
    this.#pendingPlayAfterLoad = null;
    this.#stopRequested = false;
    this.#playbackTransitionState = playbackTransitionState(
      ON_AIR_PLAYBACK_TRANSITION_STATUSES.FAILED,
      target?.entryId ?? null,
      target?.runId ?? null,
      reasonCode,
    );
  }

  #completePlaybackTransition() {
    this.#pendingLoadAfterStop = null;
    this.#pendingPlayAfterLoad = null;
    this.#stopRequested = false;
    this.#playbackTransitionState = playbackTransitionState();
  }

  #snapshotTransitionFailureReason() {
    const snapshot = this.#snapshot;
    const leaseStatus = snapshot?.playerSnapshot?.lease?.status;
    if (snapshot?.state !== ON_AIR_V2_CONNECTION_STATES.READY) {
      return ON_AIR_PLAYBACK_TRANSITION_REASONS.CONNECTION_LOST;
    }
    if (snapshot.authorityUnknown || leaseStatus === 'unknown') {
      return ON_AIR_PLAYBACK_TRANSITION_REASONS.AUTHORITY_UNKNOWN;
    }
    if (snapshot.routeUnknown || ['failed', 'emergency_stopping'].includes(leaseStatus)) {
      return ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST;
    }
    if (!snapshot.ready || !snapshot.writable) {
      return ON_AIR_PLAYBACK_TRANSITION_REASONS.CONNECTION_LOST;
    }
    if (!ACTIVE_LEASE_STATES.has(leaseStatus) || !this.#currentRouteCandidateStable()) {
      return ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST;
    }
    return null;
  }

  #confirmedPlaybackIdentityMatches(target) {
    const snapshot = this.#snapshot;
    const protocol = snapshot?.playerSnapshot;
    const lease = protocol?.lease;
    const confirmed = snapshot?.confirmedPlayback ?? protocol?.confirmedPlayback;
    return confirmed?.entryId === target.entryId
      && confirmed.runId === target.runId
      && confirmed.playerInstanceId === lease?.leaseTarget
      && confirmed.leaseEpoch === lease?.epoch;
  }

  #isExactTargetPlaying(target) {
    const snapshot = this.#snapshot;
    const protocol = snapshot?.playerSnapshot;
    const lease = protocol?.lease;
    const activeRun = snapshot?.activeRun;
    const activeFamily = protocol?.activeFamily;
    const confirmed = snapshot?.confirmedPlayback ?? protocol?.confirmedPlayback;
    return this.#snapshotTransitionFailureReason() === null
      && activeRun?.entryId === target.entryId
      && activeRun.runId === target.runId
      && activeRun.targetPlayerInstanceId === lease.leaseTarget
      && activeRun.leaseEpoch === lease.epoch
      && activeFamily?.entryId === target.entryId
      && activeFamily.runId === target.runId
      && this.#confirmedPlaybackIdentityMatches(target)
      && confirmed?.status === 'playing';
  }

  #reconcilePlaybackTransition() {
    const transition = this.#playbackTransitionState;
    if (transition.status === ON_AIR_PLAYBACK_TRANSITION_STATUSES.IDLE) return;
    if (this.#isExactTargetPlaying(transition)) this.#completePlaybackTransition();
  }

  #currentRouteReadyForLoad() {
    const protocol = this.#snapshot?.playerSnapshot;
    const lease = protocol?.lease;
    const mode = modeForClientKind(lease?.clientKind);
    const candidates = mode ? protocol?.eligibleCandidates?.[mode] : null;
    return lease?.status === 'ready'
      && mode !== null
      && Array.isArray(candidates)
      && candidates.length === 1
      && candidates[0] === lease.leaseTarget;
  }

  #currentRouteCandidateStable() {
    const protocol = this.#snapshot?.playerSnapshot;
    const lease = protocol?.lease;
    const mode = modeForClientKind(lease?.clientKind);
    const candidates = mode ? protocol?.eligibleCandidates?.[mode] : null;
    return mode !== null
      && Array.isArray(candidates)
      && candidates.length === 1
      && candidates[0] === lease.leaseTarget;
  }

  #reconcilePendingLoad() {
    if (isStrongStoppedPlayback(this.#snapshot)) this.#stopRequested = false;
    const pendingLoad = this.#pendingLoadAfterStop;
    if (!pendingLoad) return;

    const snapshotFailure = this.#snapshotTransitionFailureReason();
    if (snapshotFailure) {
      this.#failPlaybackTransition(snapshotFailure, pendingLoad);
      return;
    }
    if (this.#snapshot.activeRun === null && this.#snapshot.playerSnapshot.activeFamily === null
      && !isStrongStoppedPlayback(this.#snapshot)) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.STOP_PROOF_MISSING,
        pendingLoad,
      );
      return;
    }
    if (!isStrongStoppedPlayback(this.#snapshot)) return;
    if (!this.#currentRouteReadyForLoad()) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.OUTPUT_ROUTE_LOST,
        pendingLoad,
      );
      return;
    }

    this.#pendingLoadAfterStop = null;
    try {
      this.#dispatchLoad(pendingLoad);
    } catch {
      // The authoritative barrier was consumed, but LOAD was not accepted.
      // Fail closed: a later snapshot must never retry or start playback.
    }
  }

  #reconcilePendingPlay() {
    let pendingPlay = this.#pendingPlayAfterLoad;
    if (!pendingPlay) return;
    const snapshot = this.#snapshot;
    const protocol = snapshot?.playerSnapshot;
    const lease = protocol?.lease;

    const snapshotFailure = this.#snapshotTransitionFailureReason();
    if (snapshotFailure) {
      this.#failPlaybackTransition(snapshotFailure, pendingPlay);
      return;
    }

    const confirmed = snapshot.confirmedPlayback ?? protocol.confirmedPlayback;
    const confirmedIdentityMatches = this.#confirmedPlaybackIdentityMatches(pendingPlay);
    if (confirmedIdentityMatches && ['error', 'ended', 'stopped'].includes(confirmed.status)) {
      const reasonByStatus = {
        error: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_ERROR,
        ended: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_ENDED,
        stopped: ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_STOPPED,
      };
      this.#failPlaybackTransition(reasonByStatus[confirmed.status], pendingPlay);
      return;
    }

    const activeRun = snapshot.activeRun;
    const activeFamily = protocol.activeFamily;
    if (activeRun && (activeRun.entryId !== pendingPlay.entryId || activeRun.runId !== pendingPlay.runId)) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.RUN_IDENTITY_MISMATCH,
        pendingPlay,
      );
      return;
    }
    if (activeRun && activeRun.entryId === pendingPlay.entryId && activeRun.runId === pendingPlay.runId
      && !pendingPlay.sawOwnedRun) {
      pendingPlay = Object.freeze({ ...pendingPlay, sawOwnedRun: true });
      this.#pendingPlayAfterLoad = pendingPlay;
    }
    if (activeFamily
      && (activeFamily.entryId !== pendingPlay.entryId || activeFamily.runId !== pendingPlay.runId)) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.RUN_IDENTITY_MISMATCH,
        pendingPlay,
      );
      return;
    }
    if (!activeRun && !activeFamily && pendingPlay.sawOwnedRun) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.LOAD_REJECTED,
        pendingPlay,
      );
      return;
    }
    if (!activeRun || !activeFamily) return;
    if (activeRun.targetPlayerInstanceId !== lease.leaseTarget || activeRun.leaseEpoch !== lease.epoch) {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.RUN_IDENTITY_MISMATCH,
        pendingPlay,
      );
      return;
    }

    if (!confirmedIdentityMatches) {
      if (['ready', 'paused', 'playing'].includes(confirmed?.status)) {
        this.#failPlaybackTransition(
          ON_AIR_PLAYBACK_TRANSITION_REASONS.RUN_IDENTITY_MISMATCH,
          pendingPlay,
        );
      }
      return;
    }
    if (confirmed.status === 'playing') {
      this.#completePlaybackTransition();
      return;
    }
    if (!['ready', 'paused'].includes(confirmed.status)) return;

    this.#pendingPlayAfterLoad = null;
    try {
      this.#coordinator.play();
    } catch {
      this.#failPlaybackTransition(
        ON_AIR_PLAYBACK_TRANSITION_REASONS.PLAY_DISPATCH_FAILED,
        pendingPlay,
      );
    }
  }

  #activate(mode) {
    this.#switchIntent = { targetMode: mode, phase: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING };
    this.#switchState = outputSwitchState(ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING, mode);
    this.#armSwitchWatchdog(mode, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
    this.#publish();
    try {
      return this.#coordinator.activateOutput(mode);
    } catch (error) {
      this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
      throw error;
    }
  }

  #waitForDashboardSpeakerCandidate(mode) {
    this.#switchIntent = {
      targetMode: mode,
      phase: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
      awaitingCandidate: true,
    };
    this.#switchState = outputSwitchState(ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING, mode);
    this.#armSwitchWatchdog(mode, ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING);
    this.#publish();
    return Object.freeze({ status: 'waiting_for_candidate', mode });
  }

  #reconcileSwitchIntent() {
    const intent = this.#switchIntent;
    if (!intent) return;
    try {
      // A disconnected dashboard speaker is the one recoverable unknown
      // route: the user explicitly pressed the same speaker route again and
      // the Worker can still accept a strong deactivation on the returning
      // player. Do not let the interim unknown snapshot turn that recovery
      // command into a blocked state before its terminal route proof arrives.
      const observedLease = this.#snapshot?.playerSnapshot?.lease;
      const allowSpeakerRecovery = intent.targetMode === ON_AIR_OUTPUT_MODES.SPEAKER
        && intent.phase === ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING
        && observedLease?.clientKind === 'dashboard-speaker'
        && UNKNOWN_LEASE_STATES.has(observedLease?.status)
        && isIdentifier(observedLease?.leaseTarget);
      this.#assertControlReady({ allowSpeakerRecovery });
      const lease = this.#snapshot.playerSnapshot.lease;
      if (intent.phase === ON_AIR_OUTPUT_SWITCH_STATUSES.DEACTIVATING) {
        if (UNKNOWN_LEASE_STATES.has(lease.status)) {
          if (allowSpeakerRecovery) return;
          this.#failSwitch(ON_AIR_OUTPUT_CONTROL_CODES.STATE_UNKNOWN);
          return;
        }
        if (lease.status === 'inactive') {
          this.#assertNoActiveWork();
          const candidates = this.#snapshot?.playerSnapshot?.eligibleCandidates?.[intent.targetMode];
          // Recovery from a disconnected speaker lease can reach `inactive`
          // before this page's replacement player has finished registering.
          // An older page can also remain as one foreign candidate for a short
          // time. Treat both transient shapes as a pending speaker intent,
          // just like a first-click activation. Failing closed here strands
          // the session even though the page-owned player is reconnecting.
          if (intent.targetMode === ON_AIR_OUTPUT_MODES.SPEAKER
            && this.#dashboardSpeakerPlayerInstanceId !== null
            && Array.isArray(candidates)
            && candidates.length <= 1
            && !candidates.includes(this.#dashboardSpeakerPlayerInstanceId)) {
            this.#waitForDashboardSpeakerCandidate(intent.targetMode);
            return;
          }
          this.#assertSingleCandidate(intent.targetMode);
          this.#switchIntent = {
            targetMode: intent.targetMode,
            phase: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
          };
          this.#switchState = outputSwitchState(
            ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
            intent.targetMode,
          );
          this.#armSwitchWatchdog(
            intent.targetMode,
            ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
          );
          try {
            this.#coordinator.activateOutput(intent.targetMode);
          } catch (error) {
            this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
          }
        } else if (ACTIVE_LEASE_STATES.has(lease.status) && !this.#snapshot.pendingSwitch) {
          this.#failSwitch(ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
        }
        return;
      }

      const leaseMode = modeForClientKind(lease.clientKind);
      if (intent.awaitingCandidate === true) {
        if (ACTIVE_LEASE_STATES.has(lease.status) && leaseMode === intent.targetMode) {
          this.#switchIntent = null;
          this.#clearSwitchWatchdog();
          this.#switchState = outputSwitchState();
          return;
        }
        if (lease.status !== 'inactive') {
          this.#failSwitch(ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
          return;
        }
        this.#assertNoActiveWork();
        const candidates = this.#snapshot?.playerSnapshot?.eligibleCandidates?.[intent.targetMode];
        if (!Array.isArray(candidates) || candidates.length > 1) {
          this.#failSwitch(ON_AIR_OUTPUT_CONTROL_CODES.CANDIDATE_COUNT);
          return;
        }
        if (candidates.length === 0) return;
        // A sole speaker from an older/reconnecting tab is not this page's
        // lazy player. Keep the original click pending so the old owner can
        // retire; never activate a foreign candidate just because it arrived
        // first. If both remain, the duplicate branch above fails closed.
        if (candidates[0] !== this.#dashboardSpeakerPlayerInstanceId) return;

        this.#switchIntent = {
          targetMode: intent.targetMode,
          phase: ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
          awaitingCandidate: false,
        };
        this.#armSwitchWatchdog(
          intent.targetMode,
          ON_AIR_OUTPUT_SWITCH_STATUSES.ACTIVATING,
        );
        try {
          this.#coordinator.activateOutput(intent.targetMode);
        } catch (error) {
          this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
        }
        return;
      }
      if (ACTIVE_LEASE_STATES.has(lease.status) && leaseMode === intent.targetMode) {
        this.#switchIntent = null;
        this.#clearSwitchWatchdog();
        this.#switchState = outputSwitchState();
      } else if ((lease.status === 'inactive' && !this.#snapshot.pendingSwitch)
        || UNKNOWN_LEASE_STATES.has(lease.status)) {
        this.#failSwitch(ON_AIR_OUTPUT_CONTROL_CODES.LEASE_NOT_SWITCHABLE);
      }
    } catch (error) {
      this.#failSwitch(error?.code || ON_AIR_OUTPUT_CONTROL_CODES.STATE_UNKNOWN);
    }
  }

  #blockAndThrow(code, detail) {
    this.#setBlocked(code, detail?.mode ?? null);
    throw controlError(code, detail);
  }

  #setBlocked(code, targetMode = null) {
    this.#switchIntent = null;
    this.#clearSwitchWatchdog();
    this.#switchState = outputSwitchState(ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED, targetMode, code);
    this.#publish();
  }

  #failSwitch(code) {
    const targetMode = this.#switchIntent?.targetMode ?? this.#switchState.targetMode;
    this.#setBlocked(code, targetMode);
  }

  #publish() {
    const state = this.getState();
    for (const subscriber of this.#subscribers) subscriber(state);
  }
}

export function createOnAirOutputController(options) {
  return new OnAirOutputController(options);
}

function sharedKeys(baseUrl, session, dashboardSpeakerPlayerInstanceId = null) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const validSession = validateSession(session);
  const ownerKey = `${normalizedBaseUrl}\u0000${validSession.room}`;
  return {
    ownerKey,
    controllerKey: `${ownerKey}\u0000${validSession.controlToken}\u0000${dashboardSpeakerPlayerInstanceId ?? ''}`,
  };
}

/**
 * Reference-counted page owner. Deferred zero-reference disposal lets React
 * StrictMode's synthetic cleanup/setup reuse the same control identity.
 */
export function createOnAirOutputControllerRegistry({
  controllerFactory = createOnAirOutputController,
  scheduleDisposal = (callback) => queueMicrotask(callback),
} = {}) {
  if (typeof controllerFactory !== 'function' || typeof scheduleDisposal !== 'function') {
    throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION, { field: 'registryFactory' });
  }
  const controllers = new Map();
  const sessionOwners = new Map();

  const retire = (entry) => {
    if (!entry || entry.retired) return;
    entry.retired = true;
    entry.controller.dispose();
    controllers.delete(entry.controllerKey);
    if (sessionOwners.get(entry.ownerKey) === entry) sessionOwners.delete(entry.ownerKey);
  };

  return Object.freeze({
    acquire(options, listener) {
      if (typeof listener !== 'function') {
        throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.INVALID_ARGUMENT, { field: 'listener' });
      }
      const keys = sharedKeys(
        options.baseUrl,
        options.session,
        options.dashboardSpeakerPlayerInstanceId ?? null,
      );
      const priorOwner = sessionOwners.get(keys.ownerKey);
      if (priorOwner && priorOwner.controllerKey !== keys.controllerKey) retire(priorOwner);

      let entry = controllers.get(keys.controllerKey);
      if (!entry || entry.retired) {
        entry = {
          ...keys,
          controller: controllerFactory(options),
          references: 0,
          releaseGeneration: 0,
          retired: false,
        };
        controllers.set(keys.controllerKey, entry);
        sessionOwners.set(keys.ownerKey, entry);
        entry.controller.connect();
      }

      entry.references += 1;
      entry.releaseGeneration += 1;
      const unsubscribe = entry.controller.subscribe(listener);
      let released = false;
      return Object.freeze({
        controller: entry.controller,
        release() {
          if (released) return;
          released = true;
          unsubscribe();
          entry.references = Math.max(0, entry.references - 1);
          const generation = ++entry.releaseGeneration;
          scheduleDisposal(() => {
            if (entry.references === 0 && entry.releaseGeneration === generation) retire(entry);
          });
        },
      });
    },
  });
}

const sharedControllerRegistry = createOnAirOutputControllerRegistry();

const EMPTY_STATE = publicState(null, outputSwitchState(), playbackTransitionState());

export function useOnAirOutputControl({
  session,
  baseUrl,
  enabled = true,
  dashboardSpeakerPlayerInstanceId = null,
} = {}) {
  const [ownedState, setOwnedState] = useState(() => ({ key: null, value: EMPTY_STATE }));
  const controllerRef = useRef(null);
  const sessionRoom = session?.room;
  const sessionControlToken = session?.controlToken;
  const configurationKey = enabled && baseUrl && sessionRoom && sessionControlToken
    ? `${String(baseUrl)}\u0000${sessionRoom}\u0000${sessionControlToken}\u0000${dashboardSpeakerPlayerInstanceId ?? ''}`
    : null;
  const configurationKeyRef = useRef(configurationKey);
  configurationKeyRef.current = configurationKey;
  const state = ownedState.key === configurationKey ? ownedState.value : EMPTY_STATE;

  useEffect(() => {
    if (!enabled || !sessionRoom || !sessionControlToken || !baseUrl) {
      controllerRef.current = null;
      setOwnedState({ key: null, value: EMPTY_STATE });
      return undefined;
    }

    let lease;
    try {
      lease = sharedControllerRegistry.acquire({
        session: { room: sessionRoom, controlToken: sessionControlToken },
        baseUrl,
        dashboardSpeakerPlayerInstanceId,
      }, (value) => setOwnedState({ key: configurationKey, value }));
    } catch (error) {
      setOwnedState({
        key: configurationKey,
        value: Object.freeze({
          ...EMPTY_STATE,
          outputSwitchState: outputSwitchState(
            ON_AIR_OUTPUT_SWITCH_STATUSES.BLOCKED,
            null,
            error?.code || ON_AIR_OUTPUT_CONTROL_CODES.INVALID_CONFIGURATION,
          ),
        }),
      });
      return undefined;
    }
    controllerRef.current = { key: configurationKey, controller: lease.controller };
    return () => {
      if (controllerRef.current?.controller === lease.controller) controllerRef.current = null;
      lease.release();
    };
  }, [
    baseUrl,
    configurationKey,
    dashboardSpeakerPlayerInstanceId,
    enabled,
    sessionControlToken,
    sessionRoom,
  ]);

  const requireController = useCallback(() => {
    const owner = controllerRef.current;
    if (!owner || owner.key !== configurationKeyRef.current) {
      throw controlError(ON_AIR_OUTPUT_CONTROL_CODES.DISABLED, {});
    }
    return owner.controller;
  }, []);

  const selectOutputMode = useCallback(
    (mode) => requireController().selectOutputMode(mode),
    [requireController],
  );
  const sendCommand = useCallback(
    (command) => requireController().sendCommand(command),
    [requireController],
  );
  const retryConnection = useCallback(
    () => requireController().retryConnection(),
    [requireController],
  );
  const emergencyStop = useCallback(
    () => requireController().emergencyStop(),
    [requireController],
  );
  const takeOverControl = useCallback(
    () => requireController().takeOverControl(),
    [requireController],
  );
  const startTest = useCallback(
    (options) => requireController().startTest(options),
    [requireController],
  );
  const stopTest = useCallback(
    () => requireController().stopTest(),
    [requireController],
  );

  return {
    ...state,
    selectOutputMode,
    sendCommand,
    retryConnection,
    emergencyStop,
    takeOverControl,
    startTest,
    stopTest,
  };
}
