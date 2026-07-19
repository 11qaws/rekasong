/**
 * A discard becomes final only after the Worker relays Protocol v2's exact
 * strong-stop event for the still-current run. All other events fail closed.
 */
export function isConfirmedDiscardStop({ protocolVersion, event, active, currentEntry } = {}) {
  return protocolVersion === 2
    && event?.type === 'stopped'
    && typeof event.sessionId === 'string'
    && active?.discardRequested === true
    && typeof active.runId === 'string'
    && event.sessionId === active.runId
    && active.entryId === currentEntry?.entryId;
}

export function isConfirmedDiscardSnapshot({ confirmedPlayback, active, currentEntry } = {}) {
  return confirmedPlayback?.status === 'stopped'
    && confirmedPlayback.entryId === active?.entryId
    && confirmedPlayback.runId === active?.runId
    && active?.discardRequested === true
    && active.entryId === currentEntry?.entryId
    && confirmedPlayback.paused === true
    && confirmedPlayback.sourceDetached === true
    && confirmedPlayback.autoplayCancelled === true
    && confirmedPlayback.audible === false;
}
