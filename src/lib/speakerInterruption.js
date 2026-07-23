export const SPEAKER_INTERRUPTION_REASONS = Object.freeze({
  SYSTEM_PAUSE: 'system_pause',
});

const ACTIVE_SPEAKER_STATUSES = new Set(['playing', 'paused', 'buffering']);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Convert a read-only physical Speaker snapshot into UI evidence after a page
 * lifecycle resume. This never issues a media command. A browser/OS pause is
 * distinguishable from a user pause because PlaybackEngine retains the latest
 * command intent in `wantsPlayback`.
 */
export function observeSpeakerLifecycleSnapshot(snapshot, { mediaEnded = false } = {}) {
  if (!snapshot || typeof snapshot.runId !== 'string' || !snapshot.runId
    || snapshot.sourceAttached !== true) return null;

  if (mediaEnded) {
    return Object.freeze({
      type: 'ended',
      runId: snapshot.runId,
      mediaTime: finiteOrNull(snapshot.position),
      duration: finiteOrNull(snapshot.duration),
      paused: true,
      readyState: Number.isSafeInteger(snapshot.readyState) ? snapshot.readyState : null,
      seeking: Boolean(snapshot.seeking),
      sourceAttached: true,
      wantsPlayback: false,
      interruptionReason: null,
    });
  }

  const wantsPlayback = snapshot.wantsPlayback === true;
  const mediaPaused = snapshot.mediaPaused === true;
  const explicitPause = snapshot.status === 'paused' && mediaPaused && !wantsPlayback;
  if (!wantsPlayback && !explicitPause) return null;
  if (!wantsPlayback && !ACTIVE_SPEAKER_STATUSES.has(snapshot.status)) return null;

  return Object.freeze({
    type: mediaPaused ? 'paused' : 'playing',
    runId: snapshot.runId,
    mediaTime: finiteOrNull(snapshot.position),
    duration: finiteOrNull(snapshot.duration),
    paused: mediaPaused,
    readyState: Number.isSafeInteger(snapshot.readyState) ? snapshot.readyState : null,
    seeking: Boolean(snapshot.seeking),
    sourceAttached: true,
    wantsPlayback,
    interruptionReason: mediaPaused && wantsPlayback
      ? SPEAKER_INTERRUPTION_REASONS.SYSTEM_PAUSE
      : null,
  });
}

export function isSpeakerResumeRequiredEvidence(evidence) {
  return evidence?.type === 'paused'
    && evidence?.wantsPlayback === true
    && evidence?.interruptionReason === SPEAKER_INTERRUPTION_REASONS.SYSTEM_PAUSE;
}

/**
 * Native pause events can be delivered after a lifecycle-resume observation.
 * Carry the same retained command intent on those events so delivery order
 * cannot erase a required user resume action.
 */
export function annotateSpeakerEvidenceWithIntent(
  evidence,
  snapshot,
  { mediaEnded = false } = {},
) {
  if (!evidence || evidence.type !== 'paused') return evidence;
  const observation = observeSpeakerLifecycleSnapshot(snapshot, { mediaEnded });
  if (observation?.type !== 'paused' || observation.runId !== evidence.runId) {
    return evidence;
  }
  return Object.freeze({
    ...evidence,
    wantsPlayback: observation.wantsPlayback,
    interruptionReason: observation.interruptionReason,
  });
}
