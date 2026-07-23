export const OBS_PENDING_STOP_ACTIONS = Object.freeze({
  COMPLETE: 'complete',
  DISCARD: 'discard',
});

const PENDING_STOP_ACTIONS = new Set(Object.values(OBS_PENDING_STOP_ACTIONS));

export function pendingObsStopAction(active) {
  if (PENDING_STOP_ACTIONS.has(active?.pendingStopAction)) {
    return active.pendingStopAction;
  }
  // Compatibility for an in-memory v0.2.35 discard that survives a hot
  // refresh while the new bundle loads.
  return active?.discardRequested === true ? OBS_PENDING_STOP_ACTIONS.DISCARD : null;
}

function pendingStopIdentityMatches(active, currentEntry) {
  return pendingObsStopAction(active) !== null
    && typeof active?.runId === 'string'
    && active.runId.length > 0
    && active.entryId === currentEntry?.entryId;
}

/**
 * An OBS transition becomes final only after Protocol v2 relays the exact
 * strong-stop event for the still-current run. A timeout, ACK, pause, natural
 * end, or a stopped event from an older run never advances the Dashboard.
 */
export function isConfirmedPendingObsStop({
  protocolVersion,
  event,
  active,
  currentEntry,
} = {}) {
  return protocolVersion === 2
    && event?.type === 'stopped'
    && typeof event.sessionId === 'string'
    && pendingStopIdentityMatches(active, currentEntry)
    && event.sessionId === active.runId;
}

export function isConfirmedPendingObsStopSnapshot({
  confirmedPlayback,
  active,
  currentEntry,
} = {}) {
  return confirmedPlayback?.status === 'stopped'
    && confirmedPlayback.entryId === active?.entryId
    && confirmedPlayback.runId === active?.runId
    && pendingStopIdentityMatches(active, currentEntry)
    && confirmedPlayback.paused === true
    && confirmedPlayback.sourceDetached === true
    && confirmedPlayback.autoplayCancelled === true
    && confirmedPlayback.audible === false;
}

export function isConfirmedDiscardStop(input = {}) {
  return pendingObsStopAction(input.active) === OBS_PENDING_STOP_ACTIONS.DISCARD
    && isConfirmedPendingObsStop(input);
}

export function isConfirmedDiscardSnapshot(input = {}) {
  return pendingObsStopAction(input.active) === OBS_PENDING_STOP_ACTIONS.DISCARD
    && isConfirmedPendingObsStopSnapshot(input);
}
