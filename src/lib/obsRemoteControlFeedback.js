export const OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS = 5_000;

export const OBS_REMOTE_CONTROL_ACTIONS = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  SEEK: 'seek',
  VOLUME: 'volume',
});

export const OBS_REMOTE_CONTROL_PHASES = Object.freeze({
  WAITING: 'waiting',
  CONFIRMED: 'confirmed',
  DELAYED: 'delayed',
  FAILED: 'failed',
});

const ACTION_SET = new Set(Object.values(OBS_REMOTE_CONTROL_ACTIONS));
const VALUE_ACTIONS = new Set([
  OBS_REMOTE_CONTROL_ACTIONS.SEEK,
  OBS_REMOTE_CONTROL_ACTIONS.VOLUME,
]);

function identifier(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function freeze(record) {
  return record ? Object.freeze({ ...record }) : null;
}

function requestedValueFor(command, action) {
  if (!VALUE_ACTIONS.has(action)) return null;
  const value = action === OBS_REMOTE_CONTROL_ACTIONS.SEEK
    ? command?.payload?.position
    : command?.payload?.volume;
  if (!Number.isFinite(value)) return null;
  if (action === OBS_REMOTE_CONTROL_ACTIONS.SEEK && value < 0) return null;
  if (action === OBS_REMOTE_CONTROL_ACTIONS.VOLUME && (value < 0 || value > 100)) return null;
  return value;
}

export function createObsRemoteControlFeedback({
  action,
  dispatchResult,
  requestedAt = Date.now(),
} = {}) {
  const command = dispatchResult?.command;
  if (!ACTION_SET.has(action) || command?.type !== action) return null;
  const commandId = identifier(command.commandId);
  const entryId = identifier(command.entryId);
  const runId = identifier(command.runId);
  if (!commandId || !entryId || !runId || !Number.isFinite(requestedAt)) return null;
  const requestedValue = requestedValueFor(command, action);
  if (VALUE_ACTIONS.has(action) && requestedValue === null) return null;
  const outcomeUnknown = dispatchResult?.result?.status === 'outcome_unknown'
    || dispatchResult?.result?.entry?.state === 'outcome_unknown';

  return freeze({
    commandId,
    entryId,
    runId,
    action,
    requestedValue,
    confirmedValue: null,
    phase: outcomeUnknown
      ? OBS_REMOTE_CONTROL_PHASES.DELAYED
      : OBS_REMOTE_CONTROL_PHASES.WAITING,
    requestedAt,
    observedAt: outcomeUnknown ? requestedAt : null,
    reasonCode: outcomeUnknown ? 'outcome_unknown' : null,
  });
}

function sameRun(feedback, confirmedPlayback) {
  return confirmedPlayback?.entryId === feedback.entryId
    && confirmedPlayback?.runId === feedback.runId;
}

function closeEnough(actual, expected, tolerance) {
  return Number.isFinite(actual)
    && Number.isFinite(expected)
    && Math.abs(actual - expected) <= tolerance;
}

function confirmationValue(feedback, confirmedPlayback) {
  if (feedback.action === OBS_REMOTE_CONTROL_ACTIONS.SEEK) {
    return confirmedPlayback?.commandType === 'SEEK'
      && closeEnough(confirmedPlayback.position, feedback.requestedValue, 0.05)
      ? confirmedPlayback.position
      : null;
  }
  if (feedback.action === OBS_REMOTE_CONTROL_ACTIONS.VOLUME) {
    return confirmedPlayback?.commandType === 'VOLUME'
      && closeEnough(confirmedPlayback.volume, feedback.requestedValue, 0.001)
      ? confirmedPlayback.volume
      : null;
  }
  if (feedback.action === OBS_REMOTE_CONTROL_ACTIONS.PLAY) {
    return confirmedPlayback?.status === 'playing' ? true : null;
  }
  if (feedback.action === OBS_REMOTE_CONTROL_ACTIONS.PAUSE) {
    return confirmedPlayback?.status === 'paused' ? true : null;
  }
  return null;
}

export function reconcileObsRemoteControlFeedback(
  feedback,
  confirmedPlayback,
  now = Date.now(),
) {
  if (!feedback) return null;
  if (![OBS_REMOTE_CONTROL_PHASES.WAITING, OBS_REMOTE_CONTROL_PHASES.DELAYED]
    .includes(feedback.phase)) return feedback;

  if (sameRun(feedback, confirmedPlayback)
    && confirmedPlayback?.commandId === feedback.commandId) {
    if (confirmedPlayback.event === 'command_failed') {
      return freeze({
        ...feedback,
        phase: OBS_REMOTE_CONTROL_PHASES.FAILED,
        observedAt: finite(confirmedPlayback.lastSeenAt) ?? now,
        reasonCode: identifier(confirmedPlayback.failureCode) ?? 'command_failed',
      });
    }
    const confirmedValue = confirmationValue(feedback, confirmedPlayback);
    if (confirmedValue !== null) {
      return freeze({
        ...feedback,
        phase: OBS_REMOTE_CONTROL_PHASES.CONFIRMED,
        confirmedValue: VALUE_ACTIONS.has(feedback.action) ? confirmedValue : null,
        observedAt: finite(confirmedPlayback.lastSeenAt) ?? now,
        reasonCode: null,
      });
    }
  }

  if (feedback.phase === OBS_REMOTE_CONTROL_PHASES.WAITING
    && Number.isFinite(now)
    && now - feedback.requestedAt >= OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS) {
    return freeze({
      ...feedback,
      phase: OBS_REMOTE_CONTROL_PHASES.DELAYED,
      observedAt: now,
      reasonCode: 'confirmation_delayed',
    });
  }
  return feedback;
}

export function obsRemoteControlFeedbackMatchesRun(feedback, activeRun) {
  return Boolean(feedback
    && activeRun?.outputMode === 'obs'
    && feedback.entryId === activeRun.entryId
    && feedback.runId === activeRun.runId);
}
