const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_PREFETCH_MAX_BYTES = 64 * 1024 * 1024;

const loadOnAirSourceResolver = async (options) => {
  const { createOnAirSourceResolver } = await import('./onAirSourceResolver.js');
  return createOnAirSourceResolver(options);
};

const loadOnAirPrefetchCache = async () => import('./onAirPrefetchCache.js');

export const SPEAKER_SOURCE_RESOLVER_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'speaker_source_resolver_invalid_configuration',
  INVALID_CONTEXT: 'speaker_source_resolver_invalid_context',
  INVALID_MEDIA_SESSION: 'speaker_source_resolver_invalid_media_session',
});

export class SpeakerSourceResolverError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'SpeakerSourceResolverError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

const isPageBlobSong = (song) => (
  song?.type === 'local'
  && typeof song.src === 'string'
  && song.src.startsWith('blob:')
);

/**
 * Speaker playback has two media sources but no output lease:
 * - a page-owned local Blob URL is already complete and must never wake the Worker;
 * - prepared YouTube bytes and legacy session assets acquire media credentials on demand.
 *
 * The returned resolver caches only the credential-bound resolver function. It does not
 * cache media bytes; the caller's bounded prefetch cache continues to own that policy.
 */
export function createSpeakerSourceResolver({
  baseUrl,
  ensureSession,
  resolverFactory = loadOnAirSourceResolver,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl
    || typeof ensureSession !== 'function'
    || typeof resolverFactory !== 'function') {
    throw new SpeakerSourceResolverError(
      SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
      { field: 'resolver_options' },
    );
  }

  let cachedIdentity = null;
  let cachedResolverPromise = null;

  return async function resolveSpeakerSource(context) {
    const song = context?.song;
    if (!song || typeof song !== 'object') {
      throw new SpeakerSourceResolverError(
        SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONTEXT,
        { field: 'song' },
      );
    }
    if (isPageBlobSong(song)) {
      return Object.freeze({ kind: 'url', url: song.src });
    }

    const session = await ensureSession();
    if (!session || typeof session.room !== 'string' || !session.room
      || typeof session.playerToken !== 'string' || !session.playerToken) {
      throw new SpeakerSourceResolverError(
        SPEAKER_SOURCE_RESOLVER_CODES.INVALID_MEDIA_SESSION,
        { field: 'session' },
      );
    }

    const identity = `${session.room}\u0000${session.playerToken}`;
    if (!cachedResolverPromise || cachedIdentity !== identity) {
      cachedIdentity = identity;
      const requestedIdentity = identity;
      cachedResolverPromise = Promise.resolve(resolverFactory({
        baseUrl,
        room: session.room,
        token: session.playerToken,
        maxBytes,
      })).then((resolver) => {
        if (typeof resolver !== 'function') {
          throw new SpeakerSourceResolverError(
            SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
            { field: 'resolverFactory' },
          );
        }
        return resolver;
      }).catch((error) => {
        if (cachedIdentity === requestedIdentity) {
          cachedIdentity = null;
          cachedResolverPromise = null;
        }
        throw error;
      });
    }
    const resolver = await cachedResolverPromise;
    return resolver(context);
  };
}

/**
 * Lazily materialize the remote prefetch graph. An idle page and local Blob
 * playback keep both the resolver and prefetch modules outside the initial
 * network/parse path, while prepared YouTube media retains the existing bounded
 * cache once it is actually requested.
 */
export function createSpeakerSourcePipeline({
  baseUrl,
  ensureSession,
  prefetchCacheLoader = loadOnAirPrefetchCache,
  loadMaxBytes = DEFAULT_MAX_BYTES,
  prefetchMaxBytes = DEFAULT_PREFETCH_MAX_BYTES,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl
    || typeof ensureSession !== 'function'
    || typeof prefetchCacheLoader !== 'function') {
    throw new SpeakerSourceResolverError(
      SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
      { field: 'pipeline_options' },
    );
  }

  let disposed = false;
  let pipeline = null;
  let pipelinePromise = null;

  const ensurePipeline = () => {
    if (disposed) {
      return Promise.reject(new SpeakerSourceResolverError(
        SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
        { field: 'pipeline_disposed' },
      ));
    }
    if (pipeline) return Promise.resolve(pipeline);
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = Promise.resolve(prefetchCacheLoader()).then((module) => {
      if (typeof module?.createOnAirPrefetchCache !== 'function') {
        throw new SpeakerSourceResolverError(
          SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
          { field: 'prefetchCacheLoader' },
        );
      }
      const loadResolver = createSpeakerSourceResolver({
        baseUrl,
        ensureSession,
        maxBytes: loadMaxBytes,
      });
      const prefetchResolver = createSpeakerSourceResolver({
        baseUrl,
        ensureSession,
        maxBytes: prefetchMaxBytes,
      });
      const created = module.createOnAirPrefetchCache({
        loadResolver,
        prefetchResolver,
        maxCachedBytes: prefetchMaxBytes,
        loadResolverMaxBytes: loadMaxBytes,
      });
      if (disposed) {
        created?.dispose?.();
        throw new SpeakerSourceResolverError(
          SPEAKER_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
          { field: 'pipeline_disposed' },
        );
      }
      pipeline = created;
      return created;
    }).catch((error) => {
      pipelinePromise = null;
      throw error;
    });
    return pipelinePromise;
  };

  return Object.freeze({
    resolveSource(context) {
      if (isPageBlobSong(context?.song)) {
        return Promise.resolve(Object.freeze({ kind: 'url', url: context.song.src }));
      }
      return ensurePipeline().then((active) => active.resolveSource(context));
    },
    prefetch(videoIds) {
      if (Array.isArray(videoIds) && videoIds.length === 0 && !pipeline && !pipelinePromise) {
        return Promise.resolve(Object.freeze({
          revision: 0,
          wantedVideoIds: Object.freeze([]),
          outcomes: Object.freeze([]),
        }));
      }
      return ensurePipeline().then((active) => active.prefetch(videoIds));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pipeline?.dispose?.();
      pipeline = null;
    },
  });
}
