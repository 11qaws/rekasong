const MAX_WANTED_YOUTUBE_IDS = 2;
const DEFAULT_MAX_CACHED_ITEMS = 1;
const MAX_CONFIGURED_CACHED_ITEMS = 2;
const DEFAULT_MAX_CACHED_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOAD_RESOLVER_MAX_BYTES = 200 * 1024 * 1024;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const ON_AIR_PREFETCH_MAX_ITEMS = MAX_WANTED_YOUTUBE_IDS;
export const ON_AIR_PREFETCH_DEFAULT_MAX_CACHED_ITEMS = DEFAULT_MAX_CACHED_ITEMS;
export const ON_AIR_PREFETCH_MAX_CACHED_BYTES = DEFAULT_MAX_CACHED_BYTES;
export const ON_AIR_PREFETCH_DEFAULT_LOAD_MAX_BYTES = DEFAULT_LOAD_RESOLVER_MAX_BYTES;

export const ON_AIR_PREFETCH_CACHE_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'prefetch_cache_invalid_configuration',
  INVALID_VIDEO_IDS: 'prefetch_cache_invalid_video_ids',
  INVALID_SOURCE_RESULT: 'prefetch_cache_invalid_source_result',
  SOURCE_EXCEEDS_BUDGET: 'prefetch_cache_source_exceeds_budget',
  DISPOSED: 'prefetch_cache_disposed',
});

function makeAbortError(message) {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function signalReason(signal) {
  return signal?.reason === undefined ? makeAbortError('Aborted') : signal.reason;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalReason(signal);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMaterializedBlobSource(source) {
  return source?.kind === 'blob'
    && typeof Blob === 'function'
    && source.blob instanceof Blob;
}

function immutableSource(source, maxCachedBytes) {
  if (!isMaterializedBlobSource(source)) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_SOURCE_RESULT,
      { expected: 'materialized_blob_source' },
    );
  }
  if (source.blob.size > maxCachedBytes) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.SOURCE_EXCEEDS_BUDGET,
      { sourceBytes: source.blob.size, maxCachedBytes },
    );
  }
  return Object.freeze({ kind: 'blob', blob: source.blob });
}

function normalizeVideoIds(videoIds) {
  if (!Array.isArray(videoIds) || videoIds.length > MAX_WANTED_YOUTUBE_IDS) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_VIDEO_IDS,
      { field: 'videoIds', kind: 'youtube_video_id_array', maxItems: MAX_WANTED_YOUTUBE_IDS },
    );
  }

  const unique = [];
  const seen = new Set();
  for (const videoId of videoIds) {
    if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
      throw new OnAirPrefetchCacheError(
        ON_AIR_PREFETCH_CACHE_CODES.INVALID_VIDEO_IDS,
        { field: 'videoIds', kind: 'canonical_youtube_video_id' },
      );
    }
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    unique.push(videoId);
  }
  return unique;
}

function youtubeVideoId(context) {
  const song = context?.song;
  if (song?.type !== 'youtube' || typeof song.src !== 'string'
    || !YOUTUBE_VIDEO_ID_PATTERN.test(song.src)) return null;
  return song.src;
}

function prefetchContext(videoId, signal) {
  const song = Object.freeze({ type: 'youtube', src: videoId });
  return {
    song,
    payload: Object.freeze({ song }),
    signal,
  };
}

function awaitWithSignal(promise, signal) {
  throwIfAborted(signal);
  if (!signal || typeof signal.addEventListener !== 'function') return promise;

  let removeAbortListener = () => {};
  const aborted = new Promise((resolve, reject) => {
    const onAbort = () => reject(signalReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  return Promise.race([promise, aborted]).finally(removeAbortListener);
}

function freezeOutcome(value) {
  return Object.freeze(value);
}

export class OnAirPrefetchCacheError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirPrefetchCacheError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

/**
 * Memory-bounded, best-effort PREFETCH layer for the Protocol v2 player.
 *
 * loadResolver and prefetchResolver must be separate resolver instances built
 * from the same source-resolver factory/configuration. The PREFETCH instance
 * should use maxBytes <= maxCachedBytes, so an oversized response is stopped
 * while streaming; the Blob.size/aggregate checks here are a second guard.
 *
 * The layer materializes at most one hint at a time. A LOAD cache hit takes and
 * deletes the entry before returning it, leaving the playing engine as the sole
 * long-lived Blob owner. Resolver failures are reported only as best-effort
 * outcomes and never mutate playback, route, lease, or permission state.
 */
export function createOnAirPrefetchCache({
  loadResolver,
  prefetchResolver,
  maxCachedItems = DEFAULT_MAX_CACHED_ITEMS,
  maxCachedBytes = DEFAULT_MAX_CACHED_BYTES,
  loadResolverMaxBytes = DEFAULT_LOAD_RESOLVER_MAX_BYTES,
} = {}) {
  if (typeof loadResolver !== 'function' || typeof prefetchResolver !== 'function'
    || loadResolver === prefetchResolver) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
      { field: 'resolvers', kind: 'distinct_load_and_prefetch_functions' },
    );
  }
  if (!Number.isSafeInteger(maxCachedItems) || maxCachedItems < 1
    || maxCachedItems > MAX_CONFIGURED_CACHED_ITEMS) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
      { field: 'maxCachedItems', kind: 'safe_integer_between_1_and_2' },
    );
  }
  if (!Number.isSafeInteger(maxCachedBytes) || maxCachedBytes < 1
    || maxCachedBytes > DEFAULT_MAX_CACHED_BYTES) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
      { field: 'maxCachedBytes', kind: 'safe_integer_at_most_64_mib' },
    );
  }
  if (!Number.isSafeInteger(loadResolverMaxBytes) || loadResolverMaxBytes < 1
    || loadResolverMaxBytes > DEFAULT_LOAD_RESOLVER_MAX_BYTES) {
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
      { field: 'loadResolverMaxBytes', kind: 'safe_integer_at_most_200_mib' },
    );
  }

  let disposed = false;
  let revision = 0;
  let wantedVideoIds = [];
  let cachedBytes = 0;
  let activeFlight = null;
  let activeCycle = null;
  let cyclePromise = Promise.resolve(null);
  const cache = new Map();
  const attempted = new Set();

  const assertAvailable = (operation) => {
    if (!disposed) return;
    throw new OnAirPrefetchCacheError(
      ON_AIR_PREFETCH_CACHE_CODES.DISPOSED,
      { operation },
    );
  };

  const deleteCached = (videoId) => {
    const source = cache.get(videoId);
    if (!source) return null;
    cache.delete(videoId);
    cachedBytes = Math.max(0, cachedBytes - source.blob.size);
    return source;
  };

  const abortActiveFlight = (reason) => {
    const flight = activeFlight;
    if (!flight) return;
    activeFlight = null;
    if (!flight.controller.signal.aborted) flight.controller.abort(reason);
  };

  const startFlight = (videoId) => {
    if (activeFlight?.videoId === videoId) return activeFlight;
    if (activeFlight) abortActiveFlight(makeAbortError('Prefetch replaced'));

    const controller = new AbortController();
    const flight = {
      videoId,
      controller,
      claimedByLoad: false,
      promise: null,
    };
    flight.promise = Promise.resolve()
      .then(() => prefetchResolver(prefetchContext(videoId, controller.signal)))
      .then((source) => immutableSource(source, maxCachedBytes));
    flight.promise.catch(() => {});
    flight.promise.then(
      () => {
        if (activeFlight === flight) activeFlight = null;
      },
      () => {
        if (activeFlight === flight) activeFlight = null;
      },
    );
    activeFlight = flight;
    return flight;
  };

  const resultFor = (requestedRevision, requestedVideoIds, outcomes) => Object.freeze({
    revision: requestedRevision,
    wantedVideoIds: Object.freeze([...requestedVideoIds]),
    outcomes: Object.freeze(outcomes),
  });

  const runCycle = async (requestedRevision, requestedVideoIds) => {
    const outcomes = [];
    while (!disposed && requestedRevision === revision && cache.size < maxCachedItems) {
      const videoId = wantedVideoIds.find((candidate) => (
        !cache.has(candidate) && !attempted.has(candidate)
      ));
      if (!videoId) break;

      const flight = startFlight(videoId);
      let source;
      try {
        source = await flight.promise;
      } catch (error) {
        if (disposed || requestedRevision !== revision) {
          outcomes.push(freezeOutcome({ videoId, status: 'superseded' }));
          break;
        }
        attempted.add(videoId);
        outcomes.push(freezeOutcome({
          videoId,
          status: 'failed',
          code: error instanceof OnAirPrefetchCacheError ? error.code : null,
        }));
        continue;
      }

      if (disposed || requestedRevision !== revision || !wantedVideoIds.includes(videoId)) {
        outcomes.push(freezeOutcome({ videoId, status: 'superseded' }));
        break;
      }
      attempted.add(videoId);
      if (flight.claimedByLoad) {
        outcomes.push(freezeOutcome({ videoId, status: 'consumed' }));
        continue;
      }
      if (source.blob.size > maxCachedBytes - cachedBytes) {
        outcomes.push(freezeOutcome({
          videoId,
          status: 'failed',
          code: ON_AIR_PREFETCH_CACHE_CODES.SOURCE_EXCEEDS_BUDGET,
        }));
        continue;
      }
      cache.set(videoId, source);
      cachedBytes += source.blob.size;
      outcomes.push(freezeOutcome({ videoId, status: 'cached' }));
    }
    return resultFor(requestedRevision, requestedVideoIds, outcomes);
  };

  const beginCycle = () => {
    if (activeCycle?.revision === revision) return activeCycle.promise;
    const requestedRevision = revision;
    const requestedVideoIds = [...wantedVideoIds];
    const cycle = { revision: requestedRevision, promise: null, refillScheduled: false };
    cycle.promise = runCycle(requestedRevision, requestedVideoIds).finally(() => {
      if (activeCycle === cycle) activeCycle = null;
    });
    activeCycle = cycle;
    cyclePromise = cycle.promise;
    cyclePromise.catch(() => {});
    return cyclePromise;
  };

  const prefetch = (videoIds) => {
    assertAvailable('prefetch');
    const normalized = normalizeVideoIds(videoIds);
    const unchanged = sameValues(normalized, wantedVideoIds);
    if (unchanged && (activeCycle || activeFlight || cache.size >= maxCachedItems)) {
      return cyclePromise;
    }

    revision += 1;
    wantedVideoIds = normalized;
    attempted.clear();

    const retainedIds = new Set(normalized.slice(0, maxCachedItems));
    for (const videoId of [...cache.keys()]) {
      if (!retainedIds.has(videoId)) deleteCached(videoId);
    }

    const nextVideoId = normalized.find((videoId) => !cache.has(videoId)) ?? null;
    if (activeFlight && activeFlight.videoId !== nextVideoId) {
      abortActiveFlight(makeAbortError('Prefetch wanted list replaced'));
    }
    if (normalized.length === 0) {
      for (const videoId of [...cache.keys()]) deleteCached(videoId);
      return beginCycle();
    }
    return beginCycle();
  };

  const scheduleRefill = () => {
    if (disposed || cache.size >= maxCachedItems) return;
    const hasCandidate = wantedVideoIds.some((videoId) => (
      !cache.has(videoId) && !attempted.has(videoId)
    ));
    if (!hasCandidate) return;
    if (activeCycle?.revision === revision) {
      const cycle = activeCycle;
      if (!cycle.refillScheduled) {
        cycle.refillScheduled = true;
        cycle.promise.then(
          () => scheduleRefill(),
          () => scheduleRefill(),
        );
      }
      return;
    }
    beginCycle();
  };

  const takeCached = (videoId) => {
    const source = deleteCached(videoId);
    if (!source) return null;
    attempted.add(videoId);
    scheduleRefill();
    return source;
  };

  const resolveSource = async (context) => {
    assertAvailable('resolveSource');
    const videoId = youtubeVideoId(context);
    if (videoId === null) return loadResolver(context);
    throwIfAborted(context?.signal);

    const cached = takeCached(videoId);
    if (cached) return cached;

    const flight = activeFlight?.videoId === videoId ? activeFlight : null;
    if (!flight) return loadResolver(context);

    try {
      const source = await awaitWithSignal(flight.promise, context?.signal);
      throwIfAborted(context?.signal);
      assertAvailable('resolveSource');
      flight.claimedByLoad = true;
      attempted.add(videoId);
      const taken = takeCached(videoId);
      if (!taken) scheduleRefill();
      return taken ?? source;
    } catch {
      throwIfAborted(context?.signal);
      assertAvailable('resolveSource');
      return loadResolver(context);
    }
  };

  const snapshot = () => Object.freeze({
    disposed,
    revision,
    maxCachedItems,
    maxCachedBytes,
    loadResolverMaxBytes,
    worstCaseLoadPlusPrefetchBytes: loadResolverMaxBytes + maxCachedBytes,
    cachedBytes,
    wantedVideoIds: Object.freeze([...wantedVideoIds]),
    cachedVideoIds: Object.freeze(wantedVideoIds.filter((videoId) => cache.has(videoId))),
    activePrefetchVideoId: activeFlight?.videoId ?? null,
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision += 1;
    wantedVideoIds = [];
    attempted.clear();
    abortActiveFlight(makeAbortError('Prefetch cache disposed'));
    for (const videoId of [...cache.keys()]) deleteCached(videoId);
  };

  return Object.freeze({
    prefetch,
    resolveSource,
    snapshot,
    dispose,
  });
}
