const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export const ON_AIR_SOURCE_MAX_BYTES = DEFAULT_MAX_BYTES;

export const ON_AIR_SOURCE_RESOLVER_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'source_resolver_invalid_configuration',
  INVALID_CONTEXT: 'source_resolver_invalid_context',
  UNSUPPORTED_SOURCE: 'source_resolver_unsupported_source',
  INVALID_YOUTUBE_ID: 'source_resolver_invalid_youtube_id',
  INVALID_ASSET_ID: 'source_resolver_invalid_asset_id',
  FETCH_FAILED: 'source_resolver_fetch_failed',
  HTTP_FAILED: 'source_resolver_http_failed',
  UNSUPPORTED_CONTENT_TYPE: 'source_resolver_unsupported_content_type',
  INVALID_CONTENT_LENGTH: 'source_resolver_invalid_content_length',
  SOURCE_TOO_LARGE: 'source_resolver_source_too_large',
  CONTENT_LENGTH_MISMATCH: 'source_resolver_content_length_mismatch',
  READ_FAILED: 'source_resolver_read_failed',
});

export const ON_AIR_SOURCE_CONTENT_TYPES = Object.freeze([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/vnd.wave',
  'audio/wav',
  'audio/webm',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
]);

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CONTENT_LENGTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_DETAIL_STRING_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TOKEN_LENGTH = 2048;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedDetail(value, depth = 0) {
  if (depth > 3) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_DETAIL_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => boundedDetail(entry, depth + 1));
  }
  if (!isRecord(value)) return null;
  const detail = {};
  for (const [key, entry] of Object.entries(value).slice(0, 16)) {
    detail[String(key).slice(0, 64)] = boundedDetail(entry, depth + 1);
  }
  return detail;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function safeErrorName(error) {
  return typeof error?.name === 'string' && error.name
    ? error.name.slice(0, MAX_DETAIL_STRING_LENGTH)
    : 'Error';
}

function makeAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function abortReason(signal) {
  return signal?.reason === undefined ? makeAbortError() : signal.reason;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError';
}

function requireConfig(condition, field, kind) {
  if (condition) return;
  throw new OnAirSourceResolverError(
    ON_AIR_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
    { field, kind },
  );
}

function normalizeBaseUrl(value) {
  requireConfig(typeof value === 'string' && value.length > 0, 'baseUrl', 'absolute_http_url');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.INVALID_CONFIGURATION,
      { field: 'baseUrl', kind: 'absolute_http_url' },
    );
  }
  requireConfig(parsed.protocol === 'http:' || parsed.protocol === 'https:', 'baseUrl', 'http_protocol');
  requireConfig(!parsed.username && !parsed.password, 'baseUrl', 'credentials_forbidden');
  requireConfig(!parsed.search && !parsed.hash, 'baseUrl', 'query_and_fragment_forbidden');
  return parsed.toString().replace(/\/$/, '');
}

function requireConfiguredIdentifier(value, field, maximum = MAX_IDENTIFIER_LENGTH) {
  requireConfig(
    typeof value === 'string' && value.length > 0 && value.length <= maximum,
    field,
    'bounded_non_empty_string',
  );
  return value;
}

function sourceIdentity(context) {
  if (!isRecord(context)) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.INVALID_CONTEXT,
      { field: 'context', kind: 'record' },
    );
  }
  if (!isRecord(context.song)) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.INVALID_CONTEXT,
      { field: 'song', kind: 'record' },
    );
  }

  if (context.song.type === 'youtube') {
    if (typeof context.song.src !== 'string' || !YOUTUBE_ID_PATTERN.test(context.song.src)) {
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.INVALID_YOUTUBE_ID,
        { field: 'song.src', sourceKind: 'prepared_youtube' },
      );
    }
    return { sourceKind: 'prepared_youtube', identifier: context.song.src };
  }

  if (context.song.type === 'local') {
    const assetId = context.song.assetId;
    if (typeof assetId !== 'string' || assetId.length === 0 || assetId.length > MAX_IDENTIFIER_LENGTH) {
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.INVALID_ASSET_ID,
        { field: 'song.assetId', sourceKind: 'session_asset' },
      );
    }
    return { sourceKind: 'session_asset', identifier: assetId };
  }

  throw new OnAirSourceResolverError(
    ON_AIR_SOURCE_RESOLVER_CODES.UNSUPPORTED_SOURCE,
    {
      field: 'song.type',
      sourceType: typeof context.song.type === 'string' ? context.song.type : null,
    },
  );
}

function normalizeContentType(value) {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0].trim().toLowerCase();
}

async function cancelResponseBody(response, reason) {
  if (typeof response?.body?.cancel !== 'function') return;
  await Promise.resolve(response.body.cancel(reason)).catch(() => {});
}

function declaredLength(headers, sourceKind, maxBytes) {
  const raw = headers.get('content-length');
  if (raw === null) return null;
  const value = raw.trim();
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.INVALID_CONTENT_LENGTH,
      { sourceKind, value },
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
      { sourceKind, declaredBytes: value, limitBytes: maxBytes },
    );
  }
  if (length > maxBytes) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
      { sourceKind, declaredBytes: length, limitBytes: maxBytes },
    );
  }
  return length;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('invalid_response_chunk');
}

async function readWithAbort(reader, signal) {
  throwIfAborted(signal);
  if (!signal || typeof signal.addEventListener !== 'function') return reader.read();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canUseNetworkBlob(response, declaredBytes) {
  if (declaredBytes === null || typeof response?.blob !== 'function') return false;
  if (typeof Response !== 'function' || !(response instanceof Response)) return false;

  // A Response constructed in application code can pair an arbitrary stream
  // with a lying Content-Length. A non-empty HTTP(S) response URL is the
  // portable signal exposed by browser and Node fetch for a network response.
  // Encoded/transformed bodies remain on the bounded reader because their
  // materialized byte length can legitimately exceed the wire length.
  let responseUrl;
  try {
    responseUrl = new URL(response.url);
  } catch {
    return false;
  }
  if (responseUrl.protocol !== 'http:' && responseUrl.protocol !== 'https:') return false;

  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') return false;
  const transferEncoding = response.headers.get('transfer-encoding')?.trim().toLowerCase();
  if (transferEncoding && transferEncoding !== 'identity') return false;
  return true;
}

async function readNetworkBlobWithAbort(response, signal) {
  throwIfAborted(signal);
  if (!signal || typeof signal.addEventListener !== 'function') return response.blob();

  let abortHandled = false;
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    if (abortHandled) return;
    abortHandled = true;
    const reason = abortReason(signal);
    // Fetch receives the same signal, but make a best-effort cancellation for
    // conforming custom fetch implementations as well. A body locked by
    // Response.blob() may reject cancel(); cancelResponseBody contains that.
    cancelResponseBody(response, reason);
    rejectAbort(reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    const blob = await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return response.blob();
      }),
      aborted,
    ]);
    throwIfAborted(signal);
    return blob;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function validateMaterializedBlob(blob, {
  maxBytes,
  declaredBytes,
  sourceKind,
  contentType,
}) {
  const actualBytes = blob?.size;
  if (typeof actualBytes !== 'number' || !Number.isFinite(actualBytes) || actualBytes < 0) {
    throw new TypeError('invalid_response_blob');
  }
  if (actualBytes > maxBytes) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
      { sourceKind, actualBytes, limitBytes: maxBytes },
    );
  }
  if (!Number.isSafeInteger(actualBytes) || typeof blob.slice !== 'function') {
    throw new TypeError('invalid_response_blob');
  }
  if (actualBytes !== declaredBytes) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.CONTENT_LENGTH_MISMATCH,
      { sourceKind, declaredBytes, actualBytes },
    );
  }

  // Response.blob() preserves the full Content-Type header, including codec
  // parameters. Keep the resolver's existing normalized media type contract.
  return blob.type === contentType ? blob : blob.slice(0, actualBytes, contentType);
}

async function readBody(response, {
  signal,
  maxBytes,
  declaredBytes,
  sourceKind,
  contentType,
}) {
  if (canUseNetworkBlob(response, declaredBytes)) {
    const blob = await readNetworkBlobWithAbort(response, signal);
    return validateMaterializedBlob(blob, {
      maxBytes,
      declaredBytes,
      sourceKind,
      contentType,
    });
  }

  const chunks = [];
  let actualBytes = 0;

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, signal);
        if (done) break;
        const chunk = toUint8Array(value);
        actualBytes += chunk.byteLength;
        if (actualBytes > maxBytes) {
          await Promise.resolve(reader.cancel('source_size_limit')).catch(() => {});
          throw new OnAirSourceResolverError(
            ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
            { sourceKind, actualBytes, limitBytes: maxBytes },
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (isAbort(error, signal)) {
        Promise.resolve(reader.cancel(abortReason(signal))).catch(() => {});
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // An aborted pending read owns the lock until cancellation settles.
      }
    }
  } else {
    throwIfAborted(signal);
    const buffer = await response.arrayBuffer();
    throwIfAborted(signal);
    const chunk = new Uint8Array(buffer);
    actualBytes = chunk.byteLength;
    if (actualBytes > maxBytes) {
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.SOURCE_TOO_LARGE,
        { sourceKind, actualBytes, limitBytes: maxBytes },
      );
    }
    chunks.push(chunk);
  }

  if (declaredBytes !== null && actualBytes !== declaredBytes) {
    throw new OnAirSourceResolverError(
      ON_AIR_SOURCE_RESOLVER_CODES.CONTENT_LENGTH_MISMATCH,
      { sourceKind, declaredBytes, actualBytes },
    );
  }
  return new Blob(chunks, { type: contentType });
}

export class OnAirSourceResolverError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirSourceResolverError';
    this.code = code;
    this.detail = deepFreeze(boundedDetail(detail));
  }
}

/**
 * Create the common v2 LOAD source resolver. The configured base URL and
 * room/player token are trusted configuration; command payload URL fields are
 * never consulted. Both supported source identifiers are encoded into fixed
 * Worker paths and the response is fully materialized before it is returned.
 */
export function createOnAirSourceResolver({
  baseUrl,
  room,
  token,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_MAX_BYTES,
  allowedContentTypes = ON_AIR_SOURCE_CONTENT_TYPES,
} = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedRoom = requireConfiguredIdentifier(room, 'room');
  const normalizedToken = requireConfiguredIdentifier(token, 'token', MAX_TOKEN_LENGTH);
  requireConfig(typeof fetchImpl === 'function', 'fetchImpl', 'function');
  requireConfig(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'maxBytes', 'positive_safe_integer');
  requireConfig(
    Array.isArray(allowedContentTypes) || allowedContentTypes instanceof Set,
    'allowedContentTypes',
    'array_or_set',
  );
  const contentTypes = new Set(
    [...allowedContentTypes]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => normalizeContentType(value)),
  );
  requireConfig(contentTypes.size > 0, 'allowedContentTypes', 'non_empty_media_type_set');

  return async function resolveOnAirSource(context) {
    const { sourceKind, identifier } = sourceIdentity(context);
    const signal = context.signal;
    throwIfAborted(signal);

    const url = sourceKind === 'prepared_youtube'
      ? `${normalizedBase}/v1/audio/${encodeURIComponent(identifier)}?room=${encodeURIComponent(normalizedRoom)}&token=${encodeURIComponent(normalizedToken)}`
      : `${normalizedBase}/v1/sessions/${encodeURIComponent(normalizedRoom)}/media/${encodeURIComponent(identifier)}?token=${encodeURIComponent(normalizedToken)}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.FETCH_FAILED,
        { sourceKind, errorName: safeErrorName(error) },
      );
    }
    throwIfAborted(signal);

    if (!response || typeof response.ok !== 'boolean' || !response.headers) {
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.FETCH_FAILED,
        { sourceKind, errorName: 'InvalidResponse' },
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response, 'source_http_failed');
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.HTTP_FAILED,
        { sourceKind, status: Number.isInteger(response.status) ? response.status : null },
      );
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!contentTypes.has(contentType)) {
      await cancelResponseBody(response, 'source_content_type_rejected');
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.UNSUPPORTED_CONTENT_TYPE,
        { sourceKind, contentType: contentType || null },
      );
    }
    let declaredBytes;
    try {
      declaredBytes = declaredLength(response.headers, sourceKind, maxBytes);
    } catch (error) {
      await cancelResponseBody(response, 'source_content_length_rejected');
      throw error;
    }

    let blob;
    try {
      blob = await readBody(response, {
        signal,
        maxBytes,
        declaredBytes,
        sourceKind,
        contentType,
      });
    } catch (error) {
      if (isAbort(error, signal) || error instanceof OnAirSourceResolverError) throw error;
      throw new OnAirSourceResolverError(
        ON_AIR_SOURCE_RESOLVER_CODES.READ_FAILED,
        { sourceKind, errorName: safeErrorName(error) },
      );
    }
    throwIfAborted(signal);

    return {
      kind: 'blob',
      blob,
    };
  };
}
