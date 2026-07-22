const OUTPUT_MODES = new Set(['speaker', 'obs']);

const boundedId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

const validActiveRun = (active) => Boolean(
  active
  && boundedId(active.entryId)
  && boundedId(active.runId)
  && OUTPUT_MODES.has(active.outputMode)
);

/**
 * Describe one exact playback ownership transfer without changing the song.
 * The source run remains useful only as an identity fence for late events;
 * the target run becomes the sole playback authority once committed.
 */
export function createPlaybackOutputTransfer({
  entry,
  active,
  targetActive,
  resumePosition = 0,
} = {}) {
  if (!boundedId(entry?.entryId)
    || !validActiveRun(active)
    || !validActiveRun(targetActive)
    || entry.entryId !== active.entryId
    || entry.entryId !== targetActive.entryId
    || active.outputMode !== 'obs'
    || targetActive.outputMode !== 'speaker'
    || active.runId === targetActive.runId) {
    throw new TypeError('invalid_playback_output_transfer');
  }

  return Object.freeze({
    entryId: entry.entryId,
    sourceRunId: active.runId,
    sourceOutputMode: active.outputMode,
    targetRunId: targetActive.runId,
    targetOutputMode: targetActive.outputMode,
    targetActive: Object.freeze({ ...targetActive }),
    resumePosition: Number.isFinite(resumePosition) && resumePosition >= 0
      ? resumePosition
      : 0,
  });
}

/**
 * Commit only if the shared state still owns the exact OBS run that initiated
 * the transfer. A stale callback can therefore never replace a newer run.
 */
export function commitPlaybackOutputTransfer(state, transfer) {
  if (!state || !transfer) return state;
  if (state.currentEntry?.entryId !== transfer.entryId
    || state.active?.entryId !== transfer.entryId
    || state.active?.runId !== transfer.sourceRunId
    || state.active?.outputMode !== transfer.sourceOutputMode) return state;

  return {
    ...state,
    active: { ...transfer.targetActive },
  };
}

export function isPlaybackOutputTransferCommitted(transfer, active) {
  return Boolean(
    transfer
    && active?.entryId === transfer.entryId
    && active?.runId === transfer.targetRunId
    && active?.outputMode === transfer.targetOutputMode
  );
}

/**
 * Once Speaker ownership is requested, remote OBS snapshots and terminal
 * events are cleanup evidence only. They must not rewrite the local timeline.
 */
export function shouldIgnoreRemotePlayback({ active, transfer } = {}) {
  return active?.outputMode === 'speaker' || transfer?.targetOutputMode === 'speaker';
}

/**
 * Keep Speaker LOAD commands inert until React has committed their run marker.
 * claim() removes before dispatch, so StrictMode/effect retries cannot send the
 * same LOAD twice. The small bound also caps abandoned pre-commit attempts.
 */
export function createPreparedSpeakerLoadQueue({ limit = 8 } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('invalid_prepared_speaker_load_limit');
  }

  const pending = new Map();

  const enqueue = (prepared) => {
    if (!boundedId(prepared?.entryId)
      || !boundedId(prepared?.runId)
      || prepared?.outputMode !== 'speaker'
      || !prepared.command
      || typeof prepared.command !== 'object'
      || Array.isArray(prepared.command)) {
      throw new TypeError('invalid_prepared_speaker_load');
    }
    const frozen = Object.freeze({ ...prepared });
    pending.delete(frozen.runId);
    pending.set(frozen.runId, frozen);
    while (pending.size > limit) {
      pending.delete(pending.keys().next().value);
    }
    return frozen;
  };

  const claim = (active) => {
    if (!validActiveRun(active) || active.outputMode !== 'speaker') return null;
    const prepared = pending.get(active.runId) || null;
    if (!prepared) return null;
    // Once one run commits, every other pre-commit attempt is stale. Clearing
    // the batch also releases any abandoned Blob command references promptly.
    pending.clear();
    return prepared.entryId === active.entryId ? prepared : null;
  };

  const discard = (runId) => pending.delete(runId);
  const clear = () => pending.clear();

  return Object.freeze({
    enqueue,
    claim,
    discard,
    clear,
    size: () => pending.size,
  });
}
