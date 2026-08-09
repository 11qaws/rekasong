export const LYRICS_RUNTIME_STATUS = Object.freeze({
  DISABLED: 'disabled',
  LOADING: 'loading',
  READY: 'ready',
  RENDERING: 'rendering',
  DEGRADED: 'degraded',
  ERROR: 'error',
});

const sameMarker = (a, b) => Boolean(
  a && b
  && a.entryId === b.entryId
  && a.runId === b.runId
  && a.playerInstanceId === b.playerInstanceId
  && a.packageHash === b.packageHash,
);

export function createLyricsRuntimeState() {
  let generation = 0;
  let marker = null;
  let status = LYRICS_RUNTIME_STATUS.DISABLED;
  let playbackPackage = null;
  let errorCode = null;

  return Object.freeze({
    begin(nextMarker) {
      generation += 1;
      marker = Object.freeze({ ...nextMarker });
      status = LYRICS_RUNTIME_STATUS.LOADING;
      playbackPackage = null;
      errorCode = null;
      return Object.freeze({ generation, marker });
    },
    complete(ticket, nextPackage) {
      if (ticket?.generation !== generation || !sameMarker(ticket?.marker, marker)) return false;
      playbackPackage = nextPackage;
      status = nextPackage?.timingMode === 'tempo_map'
        ? LYRICS_RUNTIME_STATUS.READY
        : LYRICS_RUNTIME_STATUS.DEGRADED;
      return true;
    },
    fail(ticket, code) {
      if (ticket?.generation !== generation || !sameMarker(ticket?.marker, marker)) return false;
      status = LYRICS_RUNTIME_STATUS.ERROR;
      errorCode = String(code || 'lyrics_runtime_error');
      playbackPackage = null;
      return true;
    },
    clear() {
      generation += 1;
      marker = null;
      status = LYRICS_RUNTIME_STATUS.DISABLED;
      playbackPackage = null;
      errorCode = null;
    },
    snapshot() {
      return Object.freeze({ generation, marker, status, playbackPackage, errorCode });
    },
  });
}
