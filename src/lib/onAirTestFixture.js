/**
 * Deterministic PCM fixture for one-time WEB -> OBS output verification.
 *
 * This module deliberately has no AudioContext or HTMLMediaElement dependency.
 * The WAV bytes can be inspected in Node, while createOnAirTestFixtureSource()
 * wraps the same bytes for PlaybackEngine's normal Blob source path.
 */

export const ON_AIR_TEST_FIXTURE_ID = 'pcm-pulse-v1';
export const ON_AIR_TEST_FIXTURE_MIME_TYPE = 'audio/wav';
export const ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS = 8_000;
export const ON_AIR_TEST_FIXTURE_MIN_DURATION_MS = 1_000;
export const ON_AIR_TEST_FIXTURE_MAX_DURATION_MS = 10_000;

const WAV_HEADER_BYTES = 44;
const MAX_DETAIL_STRING_LENGTH = 160;
const MAX_DETAIL_DEPTH = 3;
const MAX_DETAIL_NODES = 32;
const GENERATION_YIELD_SAMPLES = 4_096;

export const ON_AIR_TEST_FIXTURE_FORMAT = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 48_000,
  channelCount: 1,
  bitsPerSample: 16,
  blockAlign: 2,
  byteRate: 96_000,
  peakAmplitude: 0.25,
  fadeDurationMs: 5,
});

export const ON_AIR_TEST_FIXTURE_MAX_BYTES = WAV_HEADER_BYTES
  + (ON_AIR_TEST_FIXTURE_MAX_DURATION_MS
    * ON_AIR_TEST_FIXTURE_FORMAT.sampleRate
    * ON_AIR_TEST_FIXTURE_FORMAT.blockAlign) / 1_000;

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

const FIXTURE_CYCLE_MS = 2_000;
const MARKER_TEMPLATES = freezeTree([
  {
    markerId: 'pulse-1',
    kind: 'pulse',
    frequencyHz: 880,
    startMs: 50,
    endMs: 130,
    durationMs: 80,
  },
  {
    markerId: 'pulse-2',
    kind: 'pulse',
    frequencyHz: 880,
    startMs: 200,
    endMs: 280,
    durationMs: 80,
  },
  {
    markerId: 'pulse-3',
    kind: 'pulse',
    frequencyHz: 880,
    startMs: 350,
    endMs: 430,
    durationMs: 80,
  },
  {
    markerId: 'long-tone-1',
    kind: 'long_tone',
    frequencyHz: 440,
    startMs: 500,
    endMs: 900,
    durationMs: 400,
  },
]);

function markersForDuration(durationMs) {
  const markers = [];
  for (let cycleStartMs = 0; cycleStartMs < durationMs; cycleStartMs += FIXTURE_CYCLE_MS) {
    const cycleIndex = cycleStartMs / FIXTURE_CYCLE_MS;
    for (const template of MARKER_TEMPLATES) {
      const startMs = cycleStartMs + template.startMs;
      const endMs = cycleStartMs + template.endMs;
      if (endMs > durationMs) continue;
      markers.push({
        index: markers.length,
        markerId: `${template.markerId}-cycle-${cycleIndex + 1}`,
        kind: template.kind,
        frequencyHz: template.frequencyHz,
        startMs,
        endMs,
        durationMs: template.durationMs,
        startTimeSeconds: startMs / 1_000,
        endTimeSeconds: endMs / 1_000,
        startSample: startMs * (ON_AIR_TEST_FIXTURE_FORMAT.sampleRate / 1_000),
        endSample: endMs * (ON_AIR_TEST_FIXTURE_FORMAT.sampleRate / 1_000),
      });
    }
  }
  return freezeTree(markers);
}

/**
 * Marker end samples are exclusive. The canonical eight-second fixture repeats
 * the audible pattern every two seconds, leaving an explicit silence interval
 * after each long tone so gaps and unintended looping are easy to hear.
 */
export const ON_AIR_TEST_FIXTURE_MARKERS = markersForDuration(
  ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
);

export const ON_AIR_TEST_FIXTURE_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'test_fixture_invalid_configuration',
  UNSUPPORTED_FIXTURE: 'test_fixture_unsupported_fixture',
  DURATION_LIMIT_EXCEEDED: 'test_fixture_duration_limit_exceeded',
  BYTE_LIMIT_EXCEEDED: 'test_fixture_byte_limit_exceeded',
  ABORTED: 'test_fixture_aborted',
  BLOB_UNAVAILABLE: 'test_fixture_blob_unavailable',
  BLOB_CREATION_FAILED: 'test_fixture_blob_creation_failed',
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedDetail(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (depth > MAX_DETAIL_DEPTH || state.nodes >= MAX_DETAIL_NODES) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_DETAIL_STRING_LENGTH);
  if (typeof value !== 'object') return null;
  if (state.seen.has(value)) return null;
  state.seen.add(value);
  state.nodes += 1;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => boundedDetail(entry, state, depth + 1));
  }
  if (!isRecord(value)) return null;
  const detail = {};
  for (const [key, entry] of Object.entries(value).slice(0, 12)) {
    detail[String(key).slice(0, 64)] = boundedDetail(entry, state, depth + 1);
  }
  return detail;
}

function safeErrorName(error) {
  return typeof error?.name === 'string' && error.name
    ? error.name.slice(0, MAX_DETAIL_STRING_LENGTH)
    : 'Error';
}

export class OnAirTestFixtureError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = code === ON_AIR_TEST_FIXTURE_CODES.ABORTED
      ? 'AbortError'
      : 'OnAirTestFixtureError';
    this.code = code;
    this.detail = freezeTree(boundedDetail(detail));
  }
}

function invalidConfiguration(field, kind, detail = {}) {
  throw new OnAirTestFixtureError(
    ON_AIR_TEST_FIXTURE_CODES.INVALID_CONFIGURATION,
    { field, kind, ...detail },
  );
}

function validateSignal(signal) {
  if (signal === undefined) return;
  if (!signal
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    invalidConfiguration('signal', 'abort_signal');
  }
}

function throwIfAborted(signal, phase) {
  if (signal?.aborted) {
    throw new OnAirTestFixtureError(ON_AIR_TEST_FIXTURE_CODES.ABORTED, { phase });
  }
}

function yieldForCancellation(signal, phase) {
  if (!signal) return Promise.resolve();
  throwIfAborted(signal, phase);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      new OnAirTestFixtureError(ON_AIR_TEST_FIXTURE_CODES.ABORTED, { phase }),
    ));
    const timer = setTimeout(() => finish(resolve), 0);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function normalizeOptions(options) {
  if (!isRecord(options)) invalidConfiguration('options', 'record');
  const fixtureId = options.fixtureId ?? ON_AIR_TEST_FIXTURE_ID;
  if (typeof fixtureId !== 'string') invalidConfiguration('fixtureId', 'string');
  if (fixtureId !== ON_AIR_TEST_FIXTURE_ID) {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.UNSUPPORTED_FIXTURE,
      { fixtureId },
    );
  }

  const durationMs = options.durationMs ?? ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS;
  if (!Number.isSafeInteger(durationMs)) {
    invalidConfiguration('durationMs', 'integer_milliseconds');
  }
  if (durationMs < ON_AIR_TEST_FIXTURE_MIN_DURATION_MS) {
    invalidConfiguration('durationMs', 'minimum_fixture_duration', {
      minimumMs: ON_AIR_TEST_FIXTURE_MIN_DURATION_MS,
    });
  }
  if (durationMs > ON_AIR_TEST_FIXTURE_MAX_DURATION_MS) {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.DURATION_LIMIT_EXCEEDED,
      { durationMs, limitMs: ON_AIR_TEST_FIXTURE_MAX_DURATION_MS },
    );
  }

  const maxBytes = options.maxBytes ?? ON_AIR_TEST_FIXTURE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || maxBytes > ON_AIR_TEST_FIXTURE_MAX_BYTES) {
    invalidConfiguration('maxBytes', 'positive_bounded_safe_integer', {
      maximumBytes: ON_AIR_TEST_FIXTURE_MAX_BYTES,
    });
  }
  validateSignal(options.signal);

  const sampleCount = durationMs * (ON_AIR_TEST_FIXTURE_FORMAT.sampleRate / 1_000);
  const byteLength = WAV_HEADER_BYTES
    + sampleCount * ON_AIR_TEST_FIXTURE_FORMAT.blockAlign;
  if (byteLength > maxBytes) {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.BYTE_LIMIT_EXCEEDED,
      { byteLength, limitBytes: maxBytes },
    );
  }

  return {
    fixtureId,
    durationMs,
    maxBytes,
    signal: options.signal,
    sampleCount,
    byteLength,
  };
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function writeWavHeader(view, sampleCount) {
  const { sampleRate, channelCount, bitsPerSample, blockAlign, byteRate } = ON_AIR_TEST_FIXTURE_FORMAT;
  const dataBytes = sampleCount * blockAlign;
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
}

function envelopeGain(offset, markerSamples, fadeSamples) {
  if (offset < fadeSamples) return offset / (fadeSamples - 1);
  const remaining = markerSamples - 1 - offset;
  if (remaining < fadeSamples) return remaining / (fadeSamples - 1);
  return 1;
}

/**
 * Render a fresh deterministic RIFF/WAVE ArrayBuffer and its immutable timing
 * metadata. durationMs may only extend the fixture with trailing silence.
 */
export async function renderOnAirTestFixture(options = {}) {
  const config = normalizeOptions(options);
  throwIfAborted(config.signal, 'before_allocation');

  const arrayBuffer = new ArrayBuffer(config.byteLength);
  const view = new DataView(arrayBuffer);
  writeWavHeader(view, config.sampleCount);

  const { sampleRate, peakAmplitude, fadeDurationMs } = ON_AIR_TEST_FIXTURE_FORMAT;
  const fadeSamples = fadeDurationMs * (sampleRate / 1_000);
  const pcmPeak = 32_767 * peakAmplitude;
  let generatedSamples = 0;
  const markers = markersForDuration(config.durationMs);

  for (const marker of markers) {
    const markerSamples = marker.endSample - marker.startSample;
    for (let offset = 0; offset < markerSamples; offset += 1) {
      if (generatedSamples % GENERATION_YIELD_SAMPLES === 0) {
        await yieldForCancellation(config.signal, 'render_samples');
      }
      const phase = (2 * Math.PI * marker.frequencyHz * offset) / sampleRate;
      const gain = envelopeGain(offset, markerSamples, fadeSamples);
      const sample = Math.round(Math.sin(phase) * pcmPeak * gain);
      view.setInt16(
        WAV_HEADER_BYTES + (marker.startSample + offset) * 2,
        sample,
        true,
      );
      generatedSamples += 1;
    }
  }

  throwIfAborted(config.signal, 'after_render');
  return {
    fixtureId: config.fixtureId,
    mimeType: ON_AIR_TEST_FIXTURE_MIME_TYPE,
    durationMs: config.durationMs,
    byteLength: config.byteLength,
    format: ON_AIR_TEST_FIXTURE_FORMAT,
    markers,
    arrayBuffer,
  };
}

/**
 * PlaybackEngine-compatible source factory. It uses the same rendered bytes as
 * renderOnAirTestFixture(), so test playback follows the normal object-URL and
 * HTMLMediaElement graph instead of a separate oscillator path.
 */
export async function createOnAirTestFixtureSource(options = {}) {
  const rendered = await renderOnAirTestFixture(options);
  throwIfAborted(options.signal, 'before_blob');
  const BlobCtor = options.blobCtor ?? globalThis.Blob;
  if (typeof BlobCtor !== 'function') {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.BLOB_UNAVAILABLE,
      { field: 'blobCtor' },
    );
  }

  let blob;
  try {
    blob = new BlobCtor([rendered.arrayBuffer], { type: rendered.mimeType });
  } catch (error) {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.BLOB_CREATION_FAILED,
      { errorName: safeErrorName(error) },
    );
  }
  throwIfAborted(options.signal, 'after_blob');
  if (!blob || blob.size !== rendered.byteLength) {
    throw new OnAirTestFixtureError(
      ON_AIR_TEST_FIXTURE_CODES.BLOB_CREATION_FAILED,
      { errorName: 'InvalidBlobResult' },
    );
  }
  return { kind: 'blob', blob };
}
