export const DEFAULT_CADENCE_TOLERANCE_MS = 2_000;

const finiteNonNegative = (value) => (
  Number.isFinite(value) ? Math.max(0, value) : null
);

/**
 * Reduce one raw control WebSocket frame to non-sensitive playback cadence
 * evidence. Credentials, URLs, song metadata, and error details are never
 * retained by this observer.
 */
export function observePlaybackCadenceFrame(rawData, receivedAt = Date.now()) {
  if (typeof rawData !== 'string') return null;
  let frame;
  try {
    frame = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!frame || frame.type !== 'playback_event'
    || typeof frame.event !== 'string'
    || typeof frame.runId !== 'string') return null;

  return Object.freeze({
    event: frame.event,
    runId: frame.runId,
    entryId: typeof frame.entryId === 'string' ? frame.entryId : null,
    mediaTime: finiteNonNegative(frame.mediaTime),
    duration: finiteNonNegative(frame.duration),
    receivedAt: finiteNonNegative(receivedAt) ?? 0,
  });
}

/**
 * Summarize the observations for one uninterrupted run. A duration that lands
 * exactly on a cadence boundary permits both behaviours seen in media engines:
 * the final timeupdate may arrive immediately before ended, or ended may win.
 */
export function summarizePlaybackCadence(records, {
  runId,
  durationMs,
  intervalMs,
  toleranceMs = DEFAULT_CADENCE_TOLERANCE_MS,
} = {}) {
  const safeDurationMs = finiteNonNegative(durationMs) ?? 0;
  const safeIntervalMs = finiteNonNegative(intervalMs) ?? 0;
  const safeToleranceMs = finiteNonNegative(toleranceMs) ?? 0;
  const runRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record?.runId === runId);
  const positions = runRecords.filter((record) => record.event === 'position');
  const eventCounts = {};
  for (const record of runRecords) {
    eventCounts[record.event] = (eventCounts[record.event] || 0) + 1;
  }

  const expectedMinimum = safeIntervalMs > 0
    ? Math.max(0, Math.ceil(safeDurationMs / safeIntervalMs) - 1)
    : 0;
  const expectedMaximum = safeIntervalMs > 0
    ? Math.floor(safeDurationMs / safeIntervalMs)
    : 0;
  const receivedGapsMs = positions.slice(1).map((record, index) => (
    record.receivedAt - positions[index].receivedAt
  ));
  const mediaTimes = positions.map((record) => record.mediaTime);
  const positionsFinite = mediaTimes.every(Number.isFinite);
  const positionsStrictlyIncrease = positionsFinite && mediaTimes.every((value, index) => (
    index === 0 || value > mediaTimes[index - 1]
  ));
  const minimumReceivedGapMs = receivedGapsMs.length > 0
    ? Math.min(...receivedGapsMs)
    : null;
  const minimumAllowedGapMs = Math.max(0, safeIntervalMs - safeToleranceMs);

  return Object.freeze({
    runId,
    eventCounts: Object.freeze({ ...eventCounts }),
    positionCount: positions.length,
    expectedMinimumPositionCount: expectedMinimum,
    expectedMaximumPositionCount: expectedMaximum,
    positionCountWithinExpectedRange: positions.length >= expectedMinimum
      && positions.length <= expectedMaximum,
    positionMediaTimes: Object.freeze([...mediaTimes]),
    positionsStrictlyIncrease,
    receivedGapsMs: Object.freeze([...receivedGapsMs]),
    minimumReceivedGapMs,
    minimumAllowedGapMs,
    positionGapWithinTolerance: minimumReceivedGapMs === null
      || minimumReceivedGapMs >= minimumAllowedGapMs,
  });
}
