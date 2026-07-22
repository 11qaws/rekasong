import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEAKER_SOURCE_RESOLVER_CODES,
  createSpeakerSourceResolver,
  createSpeakerSourcePipeline,
} from '../src/lib/speakerSourceResolver.js';

const session = (room = 'room-1', playerToken = 'player-1') => ({ room, playerToken });

test('page-owned local Blob playback never acquires a media session', async () => {
  let ensureCalls = 0;
  let factoryCalls = 0;
  const resolveSource = createSpeakerSourceResolver({
    baseUrl: 'https://worker.example',
    ensureSession: async () => {
      ensureCalls += 1;
      return session();
    },
    resolverFactory: () => {
      factoryCalls += 1;
      return async () => ({ kind: 'blob', blob: new Blob([]) });
    },
  });

  const result = await resolveSource({
    song: { type: 'local', src: 'blob:https://app.example/local-file' },
  });

  assert.deepEqual(result, {
    kind: 'url',
    url: 'blob:https://app.example/local-file',
  });
  assert.equal(ensureCalls, 0);
  assert.equal(factoryCalls, 0);
  assert.equal(Object.isFrozen(result), true);
});

test('prepared and session-asset media acquire credentials lazily and reuse one resolver', async () => {
  let ensureCalls = 0;
  const factoryOptions = [];
  const contexts = [];
  const resolveSource = createSpeakerSourceResolver({
    baseUrl: 'https://worker.example',
    ensureSession: async () => {
      ensureCalls += 1;
      return session();
    },
    resolverFactory: (options) => {
      factoryOptions.push(options);
      return async (context) => {
        contexts.push(context);
        return { kind: 'blob', blob: new Blob([context.song.type]) };
      };
    },
    maxBytes: 1234,
  });

  await resolveSource({ song: { type: 'youtube', src: 'cv7zqJhKoVE' } });
  await resolveSource({ song: { type: 'local', src: 'legacy-asset', assetId: 'asset-1' } });

  assert.equal(ensureCalls, 2, 'each demand rechecks the canonical session without creating it twice');
  assert.equal(factoryOptions.length, 1);
  assert.deepEqual(factoryOptions[0], {
    baseUrl: 'https://worker.example',
    room: 'room-1',
    token: 'player-1',
    maxBytes: 1234,
  });
  assert.equal(contexts.length, 2);
});

test('a rotated media session replaces the credential-bound resolver', async () => {
  const sessions = [session(), session('room-2', 'player-2')];
  const factoryOptions = [];
  const resolveSource = createSpeakerSourceResolver({
    baseUrl: 'https://worker.example',
    ensureSession: async () => sessions.shift(),
    resolverFactory: (options) => {
      factoryOptions.push(options);
      return async () => ({ kind: 'blob', blob: new Blob([]) });
    },
  });

  await resolveSource({ song: { type: 'youtube', src: 'cv7zqJhKoVE' } });
  await resolveSource({ song: { type: 'youtube', src: 'cv7zqJhKoVE' } });

  assert.deepEqual(factoryOptions.map(({ room, token }) => ({ room, token })), [
    { room: 'room-1', token: 'player-1' },
    { room: 'room-2', token: 'player-2' },
  ]);
});

test('remote media fails explicitly when credentials cannot be established', async () => {
  const resolveSource = createSpeakerSourceResolver({
    baseUrl: 'https://worker.example',
    ensureSession: async () => null,
  });

  await assert.rejects(
    resolveSource({ song: { type: 'youtube', src: 'cv7zqJhKoVE' } }),
    (error) => error.code === SPEAKER_SOURCE_RESOLVER_CODES.INVALID_MEDIA_SESSION,
  );
});

test('the Speaker pipeline keeps remote cache code dormant for idle and local playback', async () => {
  let loaderCalls = 0;
  let ensureCalls = 0;
  const pipeline = createSpeakerSourcePipeline({
    baseUrl: 'https://worker.example',
    ensureSession: async () => {
      ensureCalls += 1;
      return session();
    },
    prefetchCacheLoader: async () => {
      loaderCalls += 1;
      return {
        createOnAirPrefetchCache: () => ({
          resolveSource: async () => ({ kind: 'blob', blob: new Blob([]) }),
          prefetch: async () => ({ status: 'prefetched' }),
          dispose() {},
        }),
      };
    },
  });

  await pipeline.prefetch([]);
  const local = await pipeline.resolveSource({
    song: { type: 'local', src: 'blob:https://app.example/local-file' },
  });

  assert.equal(local.kind, 'url');
  assert.equal(loaderCalls, 0);
  assert.equal(ensureCalls, 0);

  await pipeline.prefetch(['cv7zqJhKoVE']);
  assert.equal(loaderCalls, 1);
  pipeline.dispose();
});
