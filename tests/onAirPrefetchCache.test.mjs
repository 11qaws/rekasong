import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ON_AIR_PREFETCH_CACHE_CODES,
  ON_AIR_PREFETCH_DEFAULT_LOAD_MAX_BYTES,
  ON_AIR_PREFETCH_MAX_CACHED_BYTES,
  OnAirPrefetchCacheError,
  createOnAirPrefetchCache,
} from '../src/lib/onAirPrefetchCache.js';

const VIDEO_A = 'A_-12345678';
const VIDEO_B = 'B_-12345678';
const VIDEO_C = 'C_-12345678';

const loadContext = (videoId, overrides = {}) => ({
  song: { type: 'youtube', src: videoId },
  payload: { song: { type: 'youtube', src: videoId } },
  entryId: 'entry-1',
  runId: 'run-1',
  leaseEpoch: 1,
  generation: 1,
  signal: new AbortController().signal,
  ...overrides,
});

const blobSource = (size = 3, fill = 1) => ({
  kind: 'blob',
  blob: new Blob([new Uint8Array(size).fill(fill)], { type: 'audio/webm' }),
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCache({ loadResolver, prefetchResolver, ...options } = {}) {
  return createOnAirPrefetchCache({
    loadResolver: loadResolver ?? (async () => blobSource()),
    prefetchResolver: prefetchResolver ?? (async () => blobSource()),
    maxCachedBytes: 64,
    ...options,
  });
}

test('configuration requires distinct LOAD/PREFETCH resolvers and bounded limits', () => {
  const resolver = async () => blobSource();
  assert.throws(
    () => createOnAirPrefetchCache({ loadResolver: resolver, prefetchResolver: resolver }),
    (error) => error instanceof OnAirPrefetchCacheError
      && error.code === ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
  );
  assert.throws(
    () => createOnAirPrefetchCache({
      loadResolver: async () => blobSource(),
      prefetchResolver: async () => blobSource(),
      maxCachedBytes: (64 * 1024 * 1024) + 1,
    }),
    (error) => error.code === ON_AIR_PREFETCH_CACHE_CODES.INVALID_CONFIGURATION,
  );
});

test('snapshot exposes the default 200 MiB LOAD plus 64 MiB PREFETCH worst case', () => {
  const cache = createOnAirPrefetchCache({
    loadResolver: async () => blobSource(),
    prefetchResolver: async () => blobSource(),
  });
  const snapshot = cache.snapshot();

  assert.equal(snapshot.maxCachedItems, 1);
  assert.equal(snapshot.maxCachedBytes, ON_AIR_PREFETCH_MAX_CACHED_BYTES);
  assert.equal(snapshot.loadResolverMaxBytes, ON_AIR_PREFETCH_DEFAULT_LOAD_MAX_BYTES);
  assert.equal(
    snapshot.worstCaseLoadPlusPrefetchBytes,
    ON_AIR_PREFETCH_DEFAULT_LOAD_MAX_BYTES + ON_AIR_PREFETCH_MAX_CACHED_BYTES,
  );
});

test('PREFETCH accepts at most two canonical IDs and deduplicates repeats', async () => {
  let calls = 0;
  const cache = createCache({
    prefetchResolver: async () => {
      calls += 1;
      return blobSource();
    },
  });

  await assert.rejects(
    async () => cache.prefetch([VIDEO_A, VIDEO_B, VIDEO_C]),
    (error) => error.code === ON_AIR_PREFETCH_CACHE_CODES.INVALID_VIDEO_IDS,
  );
  await assert.rejects(
    async () => cache.prefetch(['https://example.test/audio']),
    (error) => error.code === ON_AIR_PREFETCH_CACHE_CODES.INVALID_VIDEO_IDS,
  );

  const result = await cache.prefetch([VIDEO_A, VIDEO_A]);
  assert.equal(calls, 1);
  assert.deepEqual(result.wantedVideoIds, [VIDEO_A]);
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_A]);
});

test('duplicate PREFETCH calls share one in-flight materialization', async () => {
  const pending = deferred();
  let calls = 0;
  const cache = createCache({
    prefetchResolver: () => {
      calls += 1;
      return pending.promise;
    },
  });

  const first = cache.prefetch([VIDEO_A]);
  const second = cache.prefetch([VIDEO_A]);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(blobSource());

  assert.equal((await first).outcomes[0].status, 'cached');
  assert.equal((await second).outcomes[0].status, 'cached');
});

test('two hints materialize serially and the default cache retains only one Blob', async () => {
  const requests = [];
  const cache = createCache({
    prefetchResolver: ({ song, signal }) => {
      const pending = deferred();
      requests.push({ videoId: song.src, signal, ...pending });
      return pending.promise;
    },
  });

  const cycle = cache.prefetch([VIDEO_A, VIDEO_B]);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].videoId, VIDEO_A);
  requests[0].resolve(blobSource(4, 1));
  await cycle;

  assert.equal(requests.length, 1);
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_A]);
  assert.equal(cache.snapshot().cachedBytes, 4);

  const loaded = await cache.resolveSource(loadContext(VIDEO_A));
  assert.equal(loaded.blob.size, 4);
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].videoId, VIDEO_B);
});

test('a replaced wanted list aborts the current materialization and starts only its latest ID', async () => {
  const requests = new Map();
  const cache = createCache({
    prefetchResolver: ({ song, signal }) => {
      const pending = deferred();
      requests.set(song.src, { signal, ...pending });
      return pending.promise;
    },
  });

  const first = cache.prefetch([VIDEO_A, VIDEO_B]);
  await Promise.resolve();
  const second = cache.prefetch([VIDEO_C]);
  await Promise.resolve();

  assert.equal(requests.get(VIDEO_A).signal.aborted, true);
  assert.equal(requests.has(VIDEO_B), false);
  assert.equal(requests.get(VIDEO_C).signal.aborted, false);
  requests.get(VIDEO_A).reject(requests.get(VIDEO_A).signal.reason);
  requests.get(VIDEO_C).resolve(blobSource());
  assert.equal((await first).outcomes[0].status, 'superseded');
  await second;
  assert.deepEqual(cache.snapshot().wantedVideoIds, [VIDEO_C]);
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_C]);
});

test('a new primary wanted ID evicts a previously cached Blob before replacement starts', async () => {
  const pending = deferred();
  const cache = createCache({
    prefetchResolver: async ({ song }) => (
      song.src === VIDEO_A ? blobSource(9) : pending.promise
    ),
  });

  await cache.prefetch([VIDEO_A]);
  assert.equal(cache.snapshot().cachedBytes, 9);
  const replacement = cache.prefetch([VIDEO_B, VIDEO_A]);
  await Promise.resolve();

  assert.deepEqual(cache.snapshot().cachedVideoIds, []);
  assert.equal(cache.snapshot().cachedBytes, 0);
  assert.equal(cache.snapshot().activePrefetchVideoId, VIDEO_B);
  pending.resolve(blobSource(4));
  await replacement;
});

test('LOAD takes and deletes a cached Blob before scheduling the next hint', async () => {
  const sources = new Map([
    [VIDEO_A, blobSource(5, 1)],
    [VIDEO_B, blobSource(6, 2)],
  ]);
  let loadCalls = 0;
  const cache = createCache({
    loadResolver: async () => {
      loadCalls += 1;
      return blobSource();
    },
    prefetchResolver: async ({ song }) => sources.get(song.src),
  });

  await cache.prefetch([VIDEO_A, VIDEO_B]);
  const loaded = await cache.resolveSource(loadContext(VIDEO_A));
  assert.equal(loaded.blob, sources.get(VIDEO_A).blob);
  assert.equal(loadCalls, 0);
  assert.equal(cache.snapshot().cachedVideoIds.includes(VIDEO_A), false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_B]);
  assert.equal(cache.snapshot().cachedBytes, 6);
});

test('LOAD joining an in-flight first hint still refills the second hint afterward', async () => {
  const requests = [];
  const cache = createCache({
    prefetchResolver: ({ song }) => {
      const pending = deferred();
      requests.push({ videoId: song.src, ...pending });
      return pending.promise;
    },
  });

  const cycle = cache.prefetch([VIDEO_A, VIDEO_B]);
  await Promise.resolve();
  const loaded = cache.resolveSource(loadContext(VIDEO_A));
  requests[0].resolve(blobSource(5));
  assert.equal((await loaded).blob.size, 5);
  await cycle;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 2);
  assert.equal(requests[1].videoId, VIDEO_B);
  requests[1].resolve(blobSource(6));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_B]);
});

test('oversized PREFETCH is discarded and falls through to the next serial hint', async () => {
  const calls = [];
  const cache = createCache({
    prefetchResolver: async ({ song }) => {
      calls.push(song.src);
      return song.src === VIDEO_A ? blobSource(65) : blobSource(7);
    },
  });

  const result = await cache.prefetch([VIDEO_A, VIDEO_B]);
  assert.deepEqual(calls, [VIDEO_A, VIDEO_B]);
  assert.equal(result.outcomes[0].status, 'failed');
  assert.equal(result.outcomes[0].code, ON_AIR_PREFETCH_CACHE_CODES.SOURCE_EXCEEDS_BUDGET);
  assert.equal(result.outcomes[1].status, 'cached');
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_B]);
  assert.equal(cache.snapshot().cachedBytes, 7);
});

test('aggregate Blob bytes never exceed the configured budget with two cache slots', async () => {
  const cache = createCache({
    maxCachedItems: 2,
    prefetchResolver: async ({ song }) => (
      song.src === VIDEO_A ? blobSource(40) : blobSource(30)
    ),
  });

  const result = await cache.prefetch([VIDEO_A, VIDEO_B]);
  assert.equal(result.outcomes[0].status, 'cached');
  assert.equal(result.outcomes[1].status, 'failed');
  assert.equal(result.outcomes[1].code, ON_AIR_PREFETCH_CACHE_CODES.SOURCE_EXCEEDS_BUDGET);
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_A]);
  assert.equal(cache.snapshot().cachedBytes, 40);
});

test('an in-flight PREFETCH failure is best-effort and LOAD falls back to its resolver', async () => {
  const pending = deferred();
  const loadedSource = blobSource(8);
  let loadCalls = 0;
  const cache = createCache({
    loadResolver: async () => {
      loadCalls += 1;
      return loadedSource;
    },
    prefetchResolver: () => pending.promise,
  });

  const prefetched = cache.prefetch([VIDEO_A]);
  await Promise.resolve();
  const loaded = cache.resolveSource(loadContext(VIDEO_A));
  pending.reject(new Error('fixture_prefetch_failure'));

  assert.equal((await prefetched).outcomes[0].status, 'failed');
  assert.equal(await loaded, loadedSource);
  assert.equal(loadCalls, 1);
  assert.deepEqual(cache.snapshot().cachedVideoIds, []);
});

test('non-YouTube LOAD delegates directly without touching the prefetch cache', async () => {
  const context = {
    song: { type: 'local', assetId: 'asset-1' },
    signal: new AbortController().signal,
  };
  const source = blobSource();
  let received;
  const cache = createCache({
    loadResolver: async (value) => {
      received = value;
      return source;
    },
  });

  const loaded = await cache.resolveSource(context);
  assert.equal(received, context);
  assert.equal(loaded, source);
  assert.deepEqual(cache.snapshot().cachedVideoIds, []);
});

test('dispose aborts materialization, releases bytes, and permanently rejects later use', async () => {
  const requests = [];
  const cache = createCache({
    maxCachedItems: 2,
    prefetchResolver: ({ song, signal }) => {
      const pending = deferred();
      requests.push({ videoId: song.src, signal, ...pending });
      return pending.promise;
    },
  });

  const prefetch = cache.prefetch([VIDEO_A, VIDEO_B]);
  await Promise.resolve();
  requests[0].resolve(blobSource(8));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cache.snapshot().cachedVideoIds, [VIDEO_A]);
  assert.equal(cache.snapshot().cachedBytes, 8);
  assert.equal(requests[1].videoId, VIDEO_B);

  cache.dispose();
  assert.equal(requests[1].signal.aborted, true);
  assert.deepEqual(cache.snapshot().wantedVideoIds, []);
  assert.deepEqual(cache.snapshot().cachedVideoIds, []);
  assert.equal(cache.snapshot().cachedBytes, 0);

  requests[1].reject(requests[1].signal.reason);
  assert.equal((await prefetch).outcomes.at(-1).status, 'superseded');
  assert.throws(
    () => cache.prefetch([VIDEO_A]),
    (error) => error.code === ON_AIR_PREFETCH_CACHE_CODES.DISPOSED,
  );
  await assert.rejects(
    cache.resolveSource(loadContext(VIDEO_A)),
    (error) => error.code === ON_AIR_PREFETCH_CACHE_CODES.DISPOSED,
  );
});
