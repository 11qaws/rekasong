// The UI always calls coordinator.startTest() without overrides, whose public
// fixture contract is eight seconds. Keep this helper dependency-light so the
// dashboard does not import the fixture renderer solely to draw progress.
export const OBS_AUDIO_CHECK_DURATION_MS = 8_000;
export const OBS_AUDIO_CHECK_CANCELLED_CODE = 'playback_adapter_test_cancelled';
export const OBS_AUDIO_CHECK_STREAMING_ACTIVE_CODE = 'playback_adapter_test_streaming_active';

export const OBS_AUDIO_CHECK_STAGES = Object.freeze({
  BLOCKED: 'blocked',
  READY: 'ready',
  REQUESTED: 'requested',
  PLAYING: 'playing',
  PROGRESS: 'progress',
  STOPPING: 'stopping',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

const ACTIVE_LEASE_STATES = new Set(['ready', 'audible']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCheckId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function normalizedSwitchStatus(value) {
  return typeof value === 'string'
    ? value
    : typeof value?.status === 'string' ? value.status : 'idle';
}

function normalizedTransitionStatus(value) {
  return typeof value === 'string'
    ? value
    : typeof value?.status === 'string' ? value.status : 'idle';
}

function currentPlayerConnectionIds(protocol) {
  const leaseTarget = protocol?.lease?.leaseTarget;
  if (!validCheckId(leaseTarget) || !Array.isArray(protocol?.players)) return [];
  return [...new Set(protocol.players
    .filter((player) => isRecord(player)
      && player.playerInstanceId === leaseTarget
      && validCheckId(player.connectionId))
    .map((player) => player.connectionId))];
}

function currentObsRuntime(protocol) {
  const leaseTarget = protocol?.lease?.leaseTarget;
  if (!validCheckId(leaseTarget) || !Array.isArray(protocol?.players)) return null;
  const matches = protocol.players.filter((player) => isRecord(player)
    && player.playerInstanceId === leaseTarget
    && player.clientKind === 'obs-browser-source'
    && isRecord(player.runtime));
  return matches.length === 1 ? matches[0].runtime : null;
}

function eventMatchesCurrentRoute(event, protocol, actualOutputMode, connectionIds) {
  const lease = protocol?.lease;
  if (!isRecord(event)
    || actualOutputMode !== 'obs'
    || protocol?.selectedOutputMode !== 'obs'
    || lease?.clientKind !== 'obs-browser-source'
    || !validCheckId(lease?.leaseTarget)
    || !Number.isSafeInteger(lease?.epoch)
    || event.playerInstanceId !== lease.leaseTarget
    || event.leaseEpoch !== lease.epoch) {
    return false;
  }
  return connectionIds.length === 1 && connectionIds[0] === event.connectionId;
}

function terminalSequenceIsCurrent(terminal, evidence) {
  return terminal?.sequenceNamespace === 'test'
    && Number.isSafeInteger(terminal.sequence)
    && evidence?.lastSequences?.test === terminal.sequence;
}

function startedSequenceIsCurrent(started, evidence) {
  return started?.sequenceNamespace === 'test'
    && Number.isSafeInteger(started.sequence)
    && evidence?.lastSequences?.test === started.sequence;
}

function blockedMessageKey({
  snapshot,
  protocol,
  actualOutputMode,
  outputRouteStable,
  obsCandidates,
  exactObsTarget,
  obsSourceInactive,
  streamingActive,
  streamingStatusObserved,
  switchStatus,
  transitionStatus,
}) {
  if (!snapshot?.ready || !snapshot?.writable) {
    return snapshot?.ready
      ? 'obs.audioCheck.block.otherController'
      : 'obs.audioCheck.block.connection';
  }
  if (obsSourceInactive) return 'obs.audioCheck.block.sourceInactive';
  if (obsCandidates.length === 0) return 'obs.audioCheck.block.candidateNone';
  if (obsCandidates.length !== 1) return 'obs.audioCheck.block.candidateDuplicate';
  if (actualOutputMode !== 'obs') return 'obs.audioCheck.block.mode';
  if (switchStatus !== 'idle' || snapshot?.pendingSwitch) {
    return 'obs.audioCheck.block.switching';
  }
  if (snapshot.activeRun !== null
    || protocol?.activeFamily !== null
    || transitionStatus !== 'idle') {
    return 'obs.audioCheck.block.activeWork';
  }
  if (!outputRouteStable || !exactObsTarget || protocol?.lease?.status !== 'ready') {
    return 'obs.audioCheck.block.route';
  }
  if (streamingActive) return 'obs.audioCheck.block.streamingActive';
  if (!streamingStatusObserved) return 'obs.audioCheck.block.streamingUnknown';
  return 'obs.audioCheck.block.unavailable';
}

/**
 * Turns the coordinator's authoritative test evidence into a locale-neutral UI view.
 * Deliberately excludes RMS/peak fields: browser-player evidence is not OBS mixer evidence.
 */
export function deriveObsAudioCheckView({
  snapshot = null,
  actualOutputMode = null,
  outputRouteStable = false,
  obsSourceInactive = false,
  outputSwitchState = 'idle',
  playbackTransitionState = 'idle',
} = {}) {
  const protocol = isRecord(snapshot?.playerSnapshot) ? snapshot.playerSnapshot : null;
  const evidence = isRecord(snapshot?.testEvidence) ? snapshot.testEvidence : {};
  const requested = isRecord(evidence.requested) ? evidence.requested : {};
  const pendingTest = isRecord(snapshot?.pendingTest) ? snapshot.pendingTest : null;
  const started = isRecord(evidence.started) ? evidence.started : null;
  const terminal = isRecord(evidence.lastTerminal) ? evidence.lastTerminal : null;
  const allMarkers = Array.isArray(evidence.markers) ? evidence.markers : [];
  const connectionIds = currentPlayerConnectionIds(protocol);
  const obsRuntime = currentObsRuntime(protocol);
  const streamingActive = obsRuntime?.streaming === true;
  const streamingStatusObserved = obsRuntime?.streamingStatusObserved === true;
  const pendingCheckId = validCheckId(pendingTest?.checkId) ? pendingTest.checkId : null;
  const startedCheckId = validCheckId(started?.checkId) ? started.checkId : null;
  const rawActiveCheckId = validCheckId(protocol?.activeCheckId) ? protocol.activeCheckId : null;
  const effectiveActiveCheckId = Object.hasOwn(requested, 'effectiveActiveCheckId')
    ? validCheckId(requested.effectiveActiveCheckId) ? requested.effectiveActiveCheckId : null
    : rawActiveCheckId;
  const activeAttemptCheckId = pendingCheckId ?? effectiveActiveCheckId ?? startedCheckId;
  const startedCurrent = started?.event === 'test_started'
    && eventMatchesCurrentRoute(started, protocol, actualOutputMode, connectionIds)
    && startedSequenceIsCurrent(started, evidence)
    && (activeAttemptCheckId === null || started.checkId === activeAttemptCheckId);
  const terminalEventKnown = ['test_complete', 'test_failed'].includes(terminal?.event);
  const terminalCompetesWithActiveAttempt = activeAttemptCheckId !== null
    && terminal?.checkId !== activeAttemptCheckId;
  const terminalCurrent = terminalEventKnown
    && !terminalCompetesWithActiveAttempt
    && eventMatchesCurrentRoute(terminal, protocol, actualOutputMode, connectionIds)
    && terminalSequenceIsCurrent(terminal, evidence);
  const terminalStartedObserved = terminalCurrent && terminal.startedObserved === true;
  const evidenceCheckId = activeAttemptCheckId ?? (terminalCurrent ? terminal.checkId : null);
  const markers = evidenceCheckId === null
    ? []
    : allMarkers.filter((marker) => marker?.event === 'test_marker'
      && marker.checkId === evidenceCheckId
      && eventMatchesCurrentRoute(marker, protocol, actualOutputMode, connectionIds));
  const latestMarker = markers.length > 0 && isRecord(markers.at(-1)) ? markers.at(-1) : null;
  const markerTimeMs = Number.isFinite(latestMarker?.markerTimeMs)
    ? Math.max(0, latestMarker.markerTimeMs)
    : 0;
  const progressPercent = Math.min(
    100,
    Math.round((markerTimeMs / OBS_AUDIO_CHECK_DURATION_MS) * 100),
  );
  const obsCandidates = Array.isArray(protocol?.eligibleCandidates?.obs)
    ? protocol.eligibleCandidates.obs.filter(validCheckId)
    : [];
  const exactObsTarget = obsCandidates.length === 1
    && obsCandidates[0] === protocol?.lease?.leaseTarget
    && protocol?.lease?.clientKind === 'obs-browser-source';
  const switchStatus = normalizedSwitchStatus(outputSwitchState);
  const transitionStatus = normalizedTransitionStatus(playbackTransitionState);
  const explicitUnknown = Boolean(
    snapshot && (snapshot.authorityUnknown === true || snapshot.routeUnknown === true),
  );
  const connectionUnavailable = !snapshot || snapshot.ready !== true || !protocol;
  const commandAuthority = !explicitUnknown
    && !connectionUnavailable
    && snapshot.writable === true;
  const pendingOperation = pendingTest?.operation === 'start' || pendingTest?.operation === 'stop'
    ? pendingTest.operation
    : null;
  const activeTest = Boolean(pendingTest || startedCurrent || effectiveActiveCheckId);
  const routeSupportsStop = commandAuthority
    && actualOutputMode === 'obs'
    && ACTIVE_LEASE_STATES.has(protocol?.lease?.status)
    && protocol?.lease?.clientKind === 'obs-browser-source'
    && validCheckId(protocol?.lease?.leaseTarget)
    && switchStatus === 'idle'
    && snapshot.pendingSwitch === null;
  const canStop = routeSupportsStop
    && pendingTest === null
    && Boolean(startedCurrent || effectiveActiveCheckId);
  const canStart = commandAuthority
    && actualOutputMode === 'obs'
    && outputRouteStable === true
    && protocol?.lease?.status === 'ready'
    && exactObsTarget
    && switchStatus === 'idle'
    && transitionStatus === 'idle'
    && snapshot.activeRun === null
    && protocol.activeFamily === null
    && effectiveActiveCheckId === null
    && snapshot.pendingSwitch === null
    && snapshot.pendingTest === null
    && streamingStatusObserved
    && !streamingActive;

  let stage = OBS_AUDIO_CHECK_STAGES.BLOCKED;
  let messageKey;
  if (explicitUnknown) {
    stage = OBS_AUDIO_CHECK_STAGES.UNKNOWN;
    messageKey = 'obs.audioCheck.stage.unknown';
  } else if (connectionUnavailable) {
    messageKey = 'obs.audioCheck.block.connection';
  } else if (pendingOperation === 'stop') {
    stage = OBS_AUDIO_CHECK_STAGES.STOPPING;
    messageKey = 'obs.audioCheck.stage.stopping';
  } else if (startedCurrent) {
    stage = markers.length > 0
      ? OBS_AUDIO_CHECK_STAGES.PROGRESS
      : OBS_AUDIO_CHECK_STAGES.PLAYING;
    messageKey = markers.length > 0
      ? 'obs.audioCheck.stage.progress'
      : 'obs.audioCheck.stage.playing';
  } else if (pendingOperation === 'start') {
    stage = OBS_AUDIO_CHECK_STAGES.REQUESTED;
    messageKey = 'obs.audioCheck.stage.requested';
  } else if (started && !startedCurrent) {
    messageKey = 'obs.audioCheck.block.staleEvidence';
  } else if (terminal && !terminalCurrent) {
    messageKey = 'obs.audioCheck.block.staleEvidence';
  } else if (terminalCurrent && terminal.event === 'test_complete') {
    stage = OBS_AUDIO_CHECK_STAGES.COMPLETED;
    messageKey = 'obs.audioCheck.stage.completed';
  } else if (terminalCurrent && terminal.event === 'test_failed'
    && terminal.code === OBS_AUDIO_CHECK_CANCELLED_CODE) {
    stage = OBS_AUDIO_CHECK_STAGES.CANCELLED;
    messageKey = 'obs.audioCheck.stage.cancelled';
  } else if (terminalCurrent && terminal.event === 'test_failed') {
    stage = OBS_AUDIO_CHECK_STAGES.FAILED;
    messageKey = terminal.code === OBS_AUDIO_CHECK_STREAMING_ACTIVE_CODE
      ? 'obs.audioCheck.stage.streamingSafetyStopped'
      : 'obs.audioCheck.stage.failed';
  } else if (effectiveActiveCheckId) {
    stage = OBS_AUDIO_CHECK_STAGES.REQUESTED;
    messageKey = 'obs.audioCheck.stage.awaitingPlaying';
  } else if (canStart) {
    stage = OBS_AUDIO_CHECK_STAGES.READY;
    messageKey = 'obs.audioCheck.stage.ready';
  } else {
    messageKey = blockedMessageKey({
      snapshot,
      protocol,
      actualOutputMode,
      outputRouteStable,
      obsCandidates,
      exactObsTarget,
      obsSourceInactive,
      streamingActive,
      streamingStatusObserved,
      switchStatus,
      transitionStatus,
    });
  }

  return Object.freeze({
    stage,
    messageKey,
    canStart,
    canStop,
    active: activeTest,
    pendingOperation,
    checkId: evidenceCheckId,
    markerCount: markers.length,
    markerTimeMs,
    durationMs: OBS_AUDIO_CHECK_DURATION_MS,
    progressPercent,
    requestObserved: Boolean(
      pendingCheckId || startedCurrent || effectiveActiveCheckId || terminalCurrent
    ),
    actualPlayingObserved: Boolean(startedCurrent || markers.length > 0 || terminalStartedObserved),
    terminalEvent: terminalCurrent ? terminal.event : null,
    staleEvidence: Boolean((started && !startedCurrent) || (terminal && !terminalCurrent)),
    completed: stage === OBS_AUDIO_CHECK_STAGES.COMPLETED,
    cancelled: stage === OBS_AUDIO_CHECK_STAGES.CANCELLED,
    failed: stage === OBS_AUDIO_CHECK_STAGES.FAILED,
    unknown: stage === OBS_AUDIO_CHECK_STAGES.UNKNOWN,
    streamingActive,
    streamingStatusObserved,
  });
}
