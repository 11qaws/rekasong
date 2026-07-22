export const REMOTE_PLAYBACK_PROGRESS_TICK_MS = 1_000;

const finiteNonNegative = (value) => (
  Number.isFinite(value) ? Math.max(0, value) : null
);

const observedAt = (value) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

/**
 * Project a remote player's last absolute position without touching its media.
 * Timer throttling cannot accumulate error because every projection is derived
 * from one monotonic anchor instead of incrementing a counter.
 */
export function projectRemotePlaybackPosition(anchor, nowMs) {
  if (!anchor || !Number.isFinite(anchor.position)) return null;
  const elapsedSeconds = anchor.status === 'playing'
    ? Math.max(0, observedAt(nowMs) - observedAt(anchor.observedAtMs)) / 1_000
    : 0;
  const projected = Math.max(0, anchor.position + elapsedSeconds);
  return Number.isFinite(anchor.duration) && anchor.duration > 0
    ? Math.min(projected, anchor.duration)
    : projected;
}

/**
 * Re-anchor the dashboard clock from authoritative remote evidence. Missing
 * fields preserve/project the previous run; a new run starts from zero unless
 * the player explicitly supplies another position.
 */
export function reanchorRemotePlaybackProgress(previous, observation = {}, nowMs = 0) {
  const runId = typeof observation.runId === 'string' && observation.runId
    ? observation.runId
    : null;
  const sameRun = Boolean(previous && runId && previous.runId === runId);
  const explicitPosition = finiteNonNegative(observation.position);
  const projectedPrevious = sameRun
    ? projectRemotePlaybackPosition(previous, nowMs)
    : 0;
  const position = explicitPosition ?? projectedPrevious ?? 0;
  const explicitDuration = finiteNonNegative(observation.duration);
  const duration = explicitDuration ?? (sameRun ? previous.duration : 0);
  const status = typeof observation.status === 'string' && observation.status
    ? observation.status
    : sameRun ? previous.status : 'idle';

  return Object.freeze({
    runId,
    position: duration > 0 ? Math.min(position, duration) : position,
    duration,
    status,
    observedAtMs: observedAt(nowMs),
  });
}
