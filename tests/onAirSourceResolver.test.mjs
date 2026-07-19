import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ON_AIR_SOURCE_RESOLVER_CODES,
  OnAirSourceResolverError,
  createOnAirSourceResolver,
} from '../src/lib/onAirSourceResolver.js';

const baseContext = (song, overrides = {}) => ({
  song,
  payload: { song },
  entryId: 'entry-1',
  runId: 'run-1',
  leaseEpoch: 1,
  generation: 1,
  signal: new AbortController().signal,
  ...overrides,
});

const response = (chunks, {
  status = 200,
  contentType = 'audio/webm',
  contentLength,
  onCancel,
} = {}) => {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunks[index]));
      index += 1;
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
  const headers = new Headers();
  if (contentType !== null) headers.set('Content-Type', contentType);
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  return new Response(body, { status, headers });
};

function asNetworkResponse(value, url) {
  Object.defineProperty(value, 'url', { value: url });
  return value;
}

function resolverWith(fetchImpl, overrides = {}) {
  return createOnAirSourceResolver({
    baseUrl: 'https://session.example.test/root/',
    room: 'room-1',
    token: 'player-token',
    fetchImpl,
    maxBytes: 64,
    ...overrides,
  });
}

async function expectResolverError(promise, code, detail) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OnAirSourceResolverError);
    assert.equal(error.message, code);
    assert.equal(error.code, code);
    if (detail) assert.deepEqual(error.detail, detail);
    return true;
  });
}

test('prepared YouTube media is fully read into a Blob without autoplay side effects', async () => {
  let request;
  const resolveSource = resolverWith(async (url, init) => {
    request = { url, init };
    return response([[1, 2], [3, 4]], {
      contentType: 'Audio/WebM; codecs=opus',
      contentLength: 4,
    });
  });

  const result = await resolveSource(baseContext({ type: 'youtube', src: 'A_-12345678' }));

  assert.equal(result.kind, 'blob');
  assert.ok(result.blob instanceof Blob);
  assert.equal(result.blob.type, 'audio/webm');
  assert.equal(result.blob.size, 4);
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(
    request.url,
    'https://session.example.test/root/v1/audio/A_-12345678?room=room-1&token=player-token',
  );
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'omit');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(result).sort(), ['blob', 'kind']);
});

test('a trusted network Content-Length uses blob materialization without a JS chunk array', async () => {
  let blobCalls = 0;
  const resolveSource = resolverWith(async (url) => {
    const value = asNetworkResponse(response([[1, 2], [3, 4]], {
      contentType: 'Audio/WebM; codecs=opus',
      contentLength: 4,
    }), url);
    const materialize = value.blob.bind(value);
    value.blob = async () => {
      blobCalls += 1;
      return materialize();
    };
    return value;
  });

  const result = await resolveSource(baseContext({ type: 'youtube', src: 'A_-12345678' }));

  assert.equal(blobCalls, 1);
  assert.equal(result.blob.type, 'audio/webm');
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [1, 2, 3, 4]);
});

test('non-success HTTP responses fail before their body is consumed', async () => {
  let readerRequests = 0;
  const resolveSource = resolverWith(async () => ({
    ok: false,
    status: 404,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: {
      getReader() {
        readerRequests += 1;
        throw new Error('body_must_not_be_read');
      },
    },
  }));

  await expectResolverError(
    resolveSource(baseContext({ type: 'youtube', src: 'A_-12345678' })),
    ON_AIR_SOURCE_RESOLVER_CODES.HTTP_FAILED,
    { sourceKind: 'prepared_youtube', status: 404 },
  );
  assert.equal(readerRequests, 0);
});

test('a non-media Content-Type is rejected before reading bytes', async () => {
  const resolveSource = resolverWith(async () => response([[1, 2, 3]], {
    contentType: 'text/html; charset=utf-8',
    contentLength: 3,
  }));

  await expectResolverError(
    resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
    ON_AIR_SOURCE_RESOLVER_CODES.UNSUPPORTED_CONTENT_TYPE,
    { sourceKind: 'session_asset', contentType: 'text/html' },
  );
});

test('a declared size over the configured ceiling is rejected before reading', async () => {
  let cancelled = false;
  const resolveSource = resolverWith(async () => response([[1]], {
    contentType: 'audio/mpeg',
    contentLength: 65,
    onCancel: () => { cancelled = true; },
  }));

  await expectResolverError(
    resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
    ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
    { sourceKind: 'session_asset', declaredBytes: 65, limitBytes: 64 },
  );
  assert.equal(cancelled, true);
});

test('a chunked response without Content-Length cannot cross the byte ceiling', async () => {
  let cancelled = false;
  let blobCalls = 0;
  let index = 0;
  const chunks = [[1, 2, 3], [4, 5, 6]];
  const resolveSource = resolverWith(async () => ({
    ok: true,
    status: 200,
    url: 'https://session.example.test/v1/media/asset-1',
    headers: new Headers({ 'Content-Type': 'audio/ogg' }),
    async blob() {
      blobCalls += 1;
      throw new Error('blob_must_not_run_without_content_length');
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = Uint8Array.from(chunks[index]);
            index += 1;
            return { done: false, value };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  }), { maxBytes: 5 });

  await expectResolverError(
    resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
    ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
    { sourceKind: 'session_asset', actualBytes: 6, limitBytes: 5 },
  );
  assert.equal(cancelled, true);
  assert.equal(blobCalls, 0);
});

test('an encoded response stays on the bounded reader despite Content-Length', async () => {
  let blobCalls = 0;
  const resolveSource = resolverWith(async (url) => {
    const value = asNetworkResponse(response([[1, 2], [3, 4]], {
      contentType: 'audio/ogg',
      contentLength: 4,
    }), url);
    value.headers.set('Content-Encoding', 'gzip');
    const materialize = value.blob.bind(value);
    value.blob = async () => {
      blobCalls += 1;
      return materialize();
    };
    return value;
  });

  const result = await resolveSource(baseContext({ type: 'local', assetId: 'asset-1' }));

  assert.equal(blobCalls, 0);
  assert.equal(result.blob.size, 4);
});

test('a lying Content-Length is rejected after the full response is read', async () => {
  const resolveSource = resolverWith(async () => response([[1, 2], [3, 4]], {
    contentType: 'video/mp4',
    contentLength: 9,
  }));

  await expectResolverError(
    resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
    ON_AIR_SOURCE_RESOLVER_CODES.CONTENT_LENGTH_MISMATCH,
    { sourceKind: 'session_asset', declaredBytes: 9, actualBytes: 4 },
  );
});

test('network blob materialization preserves mismatch and maximum-size errors', async (t) => {
  await t.test('declared length mismatch', async () => {
    const resolveSource = resolverWith(async (url) => asNetworkResponse(response([[1, 2, 3]], {
      contentType: 'audio/webm',
      contentLength: 4,
    }), url));

    await expectResolverError(
      resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
      ON_AIR_SOURCE_RESOLVER_CODES.CONTENT_LENGTH_MISMATCH,
      { sourceKind: 'session_asset', declaredBytes: 4, actualBytes: 3 },
    );
  });

  await t.test('actual bytes over the ceiling', async () => {
    const resolveSource = resolverWith(async (url) => asNetworkResponse(response([
      [1, 2, 3, 4, 5],
    ], {
      contentType: 'audio/webm',
      contentLength: 4,
    }), url), { maxBytes: 4 });

    await expectResolverError(
      resolveSource(baseContext({ type: 'local', assetId: 'asset-1' })),
      ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
      { sourceKind: 'session_asset', actualBytes: 5, limitBytes: 4 },
    );
  });
});

test('abort reason propagates unchanged and the configured fetch is not started', async () => {
  const reason = new DOMException('fixture abort', 'AbortError');
  const controller = new AbortController();
  controller.abort(reason);
  let fetchCalls = 0;
  const resolveSource = resolverWith(async () => {
    fetchCalls += 1;
    return response([[1]], { contentLength: 1 });
  });

  await assert.rejects(
    resolveSource(baseContext(
      { type: 'youtube', src: 'A_-12345678' },
      { signal: controller.signal },
    )),
    (error) => error === reason,
  );
  assert.equal(fetchCalls, 0);
});

test('an abort during a streaming read propagates unchanged and cancels the reader', async () => {
  const reason = new DOMException('stream fixture abort', 'AbortError');
  const controller = new AbortController();
  let readCount = 0;
  let cancelledWith;
  let secondReadStarted;
  const secondRead = new Promise((resolve) => { secondReadStarted = resolve; });
  const resolveSource = resolverWith(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'audio/webm' }),
    body: {
      getReader() {
        return {
          read() {
            readCount += 1;
            if (readCount === 1) {
              return Promise.resolve({ done: false, value: Uint8Array.from([1, 2]) });
            }
            secondReadStarted();
            return new Promise(() => {});
          },
          cancel(value) {
            cancelledWith = value;
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    },
  }));

  const resolution = resolveSource(baseContext(
    { type: 'youtube', src: 'A_-12345678' },
    { signal: controller.signal },
  ));
  await secondRead;
  controller.abort(reason);

  await assert.rejects(resolution, (error) => error === reason);
  assert.equal(cancelledWith, reason);
});

test('an abort during network blob materialization propagates unchanged and attempts cancellation', async () => {
  const reason = new DOMException('blob fixture abort', 'AbortError');
  const controller = new AbortController();
  let blobStarted;
  const started = new Promise((resolve) => { blobStarted = resolve; });
  let cancelledWith;
  const resolveSource = resolverWith(async (url) => {
    const value = asNetworkResponse(response([[1, 2, 3, 4]], {
      contentType: 'audio/webm',
      contentLength: 4,
      onCancel: (reason) => { cancelledWith = reason; },
    }), url);
    value.blob = () => {
      blobStarted();
      return new Promise(() => {});
    };
    return value;
  });

  const resolution = resolveSource(baseContext(
    { type: 'youtube', src: 'A_-12345678' },
    { signal: controller.signal },
  ));
  await started;
  controller.abort(reason);

  await assert.rejects(resolution, (error) => error === reason);
  assert.equal(cancelledWith, reason);
});

test('a network blob read failure retains the typed read-failed contract', async () => {
  const resolveSource = resolverWith(async (url) => {
    const value = asNetworkResponse(response([[1, 2, 3, 4]], {
      contentType: 'audio/webm',
      contentLength: 4,
    }), url);
    value.blob = async () => {
      throw new TypeError('fixture read failure');
    };
    return value;
  });

  await expectResolverError(
    resolveSource(baseContext({ type: 'youtube', src: 'A_-12345678' })),
    ON_AIR_SOURCE_RESOLVER_CODES.READ_FAILED,
    { sourceKind: 'prepared_youtube', errorName: 'TypeError' },
  );
});

test('room, asset identifier, and token stay encoded inside the configured endpoint', async () => {
  let requestedUrl;
  const resolveSource = resolverWith(async (url) => {
    requestedUrl = url;
    return response([[9]], { contentType: 'audio/mp4', contentLength: 1 });
  }, {
    room: 'room/name with space',
    token: 'tok+en/?&=',
  });

  await resolveSource(baseContext({
    type: 'local',
    assetId: 'folder/clip name?#.m4a',
  }));

  assert.equal(
    requestedUrl,
    'https://session.example.test/root/v1/sessions/room%2Fname%20with%20space/media/folder%2Fclip%20name%3F%23.m4a?token=tok%2Ben%2F%3F%26%3D',
  );
  assert.equal(new URL(requestedUrl).origin, 'https://session.example.test');
});

test('command-provided arbitrary URLs are never fetched', async () => {
  let fetchCalls = 0;
  const resolveSource = resolverWith(async () => {
    fetchCalls += 1;
    return response([[1]], { contentLength: 1 });
  });

  await expectResolverError(
    resolveSource(baseContext({
      type: 'youtube',
      src: 'https://evil.example/audio.mp3',
      url: 'https://evil.example/audio.mp3',
    })),
    ON_AIR_SOURCE_RESOLVER_CODES.INVALID_YOUTUBE_ID,
    { field: 'song.src', sourceKind: 'prepared_youtube' },
  );
  await expectResolverError(
    resolveSource(baseContext({
      type: 'remote',
      src: 'https://evil.example/audio.mp3',
    })),
    ON_AIR_SOURCE_RESOLVER_CODES.UNSUPPORTED_SOURCE,
    { field: 'song.type', sourceType: 'remote' },
  );
  assert.equal(fetchCalls, 0);
});
