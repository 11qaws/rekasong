export const OBS_MIXER_VERIFICATION_STORAGE_KEY = 'rekasong.obs-mixer-verification.v1';

export const OBS_MIXER_VERIFICATION_OUTCOMES = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
});

const OUTCOME_SET = new Set(Object.values(OBS_MIXER_VERIFICATION_OUTCOMES));
const CONFIRMABLE_STAGES = new Set(['playing', 'progress', 'completed']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

export function parseObsMixerVerification(value) {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(candidate)
    || candidate.version !== 1
    || candidate.scope !== 'obs_mixer'
    || candidate.evidenceLevel !== 'user_confirmed'
    || !OUTCOME_SET.has(candidate.outcome)
    || !isBoundedIdentity(candidate.room)
    || !isBoundedIdentity(candidate.playerInstanceId)
    || !isBoundedIdentity(candidate.checkId)
    || !Number.isFinite(candidate.checkedAt)
    || candidate.checkedAt < 0) {
    return null;
  }
  return Object.freeze({
    version: 1,
    scope: 'obs_mixer',
    evidenceLevel: 'user_confirmed',
    outcome: candidate.outcome,
    room: candidate.room,
    playerInstanceId: candidate.playerInstanceId,
    checkId: candidate.checkId,
    checkedAt: candidate.checkedAt,
  });
}

export function createObsMixerVerification({
  outcome,
  room,
  playerInstanceId,
  checkId,
  checkedAt = Date.now(),
} = {}) {
  const record = parseObsMixerVerification({
    version: 1,
    scope: 'obs_mixer',
    evidenceLevel: 'user_confirmed',
    outcome,
    room,
    playerInstanceId,
    checkId,
    checkedAt,
  });
  if (!record) throw new TypeError('invalid_obs_mixer_verification');
  return record;
}

export function loadObsMixerVerification(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return parseObsMixerVerification(storage.getItem(OBS_MIXER_VERIFICATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveObsMixerVerification(storage, record) {
  const parsed = parseObsMixerVerification(record);
  if (!parsed || !storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(OBS_MIXER_VERIFICATION_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function deriveObsMixerVerificationView({
  record = null,
  room = null,
  playerInstanceId = null,
  obsAudioCheck = null,
} = {}) {
  const parsed = parseObsMixerVerification(record);
  const routeIdentified = isBoundedIdentity(room) && isBoundedIdentity(playerInstanceId);
  const checkId = isBoundedIdentity(obsAudioCheck?.checkId) ? obsAudioCheck.checkId : null;
  const canConfirm = Boolean(
    routeIdentified
    && checkId
    && obsAudioCheck?.actualPlayingObserved === true
    && obsAudioCheck?.staleEvidence !== true
    && CONFIRMABLE_STAGES.has(obsAudioCheck?.stage),
  );
  const matchesRoute = Boolean(
    parsed
    && routeIdentified
    && parsed.room === room
    && parsed.playerInstanceId === playerInstanceId,
  );

  let status = 'unknown';
  let messageKey = 'obs.audioCheck.mixerVerification.runFirst';
  const currentCheckRecorded = Boolean(matchesRoute && checkId && parsed.checkId === checkId);
  if (currentCheckRecorded && parsed.outcome === OBS_MIXER_VERIFICATION_OUTCOMES.PASSED) {
    status = 'passed';
    messageKey = 'obs.audioCheck.mixerVerification.passed';
  } else if (currentCheckRecorded && parsed.outcome === OBS_MIXER_VERIFICATION_OUTCOMES.FAILED) {
    status = 'failed';
    messageKey = 'obs.audioCheck.mixerVerification.failed';
  } else if (canConfirm) {
    status = 'awaiting_user';
    messageKey = 'obs.audioCheck.mixerVerification.awaiting';
  } else if (matchesRoute && parsed.outcome === OBS_MIXER_VERIFICATION_OUTCOMES.PASSED) {
    status = 'passed';
    messageKey = 'obs.audioCheck.mixerVerification.passed';
  } else if (matchesRoute && parsed.outcome === OBS_MIXER_VERIFICATION_OUTCOMES.FAILED) {
    status = 'failed';
    messageKey = 'obs.audioCheck.mixerVerification.failed';
  } else if (parsed) {
    status = 'stale';
    messageKey = 'obs.audioCheck.mixerVerification.stale';
  }

  return Object.freeze({
    status,
    messageKey,
    canConfirm,
    shouldShow: Boolean(obsAudioCheck?.requestObserved || parsed),
    checkedAt: matchesRoute ? parsed.checkedAt : null,
    evidenceLevel: matchesRoute ? parsed.evidenceLevel : null,
  });
}
