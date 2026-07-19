import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ON_AIR_TEST_FIXTURE_CODES,
  ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
  ON_AIR_TEST_FIXTURE_FORMAT,
  ON_AIR_TEST_FIXTURE_ID,
  ON_AIR_TEST_FIXTURE_MARKERS,
  ON_AIR_TEST_FIXTURE_MAX_BYTES,
  OnAirTestFixtureError,
  createOnAirTestFixtureSource,
  renderOnAirTestFixture,
} from '../src/lib/onAirTestFixture.js';

const HEADER_BYTES = 44;

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function pcmSamples(arrayBuffer) {
  const view = new DataView(arrayBuffer, HEADER_BYTES);
  return Array.from(
    { length: view.byteLength / 2 },
    (_, index) => view.getInt16(index * 2, true),
  );
}

function assertFixtureError(error, code, detail) {
  assert.ok(error instanceof OnAirTestFixtureError);
  assert.equal(error.message, code);
  assert.equal(error.code, code);
  if (detail) assert.deepEqual(error.detail, detail);
  assert.equal(Object.isFrozen(error.detail), true);
  return true;
}

function positiveCrossingFrequency(samples, marker) {
  const fadeSamples = ON_AIR_TEST_FIXTURE_FORMAT.fadeDurationMs
    * (ON_AIR_TEST_FIXTURE_FORMAT.sampleRate / 1_000);
  const start = marker.startSample + fadeSamples;
  const end = marker.endSample - fadeSamples;
  let crossings = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (samples[index - 1] <= 0 && samples[index] > 0) crossings += 1;
  }
  return crossings / ((end - start) / ON_AIR_TEST_FIXTURE_FORMAT.sampleRate);
}

test('renders a canonical little-endian mono 48 kHz PCM WAV header', async () => {
  const rendered = await renderOnAirTestFixture();
  const bytes = new Uint8Array(rendered.arrayBuffer);
  const view = new DataView(rendered.arrayBuffer);
  const expectedSamples = ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS * 48;
  const expectedDataBytes = expectedSamples * 2;

  assert.equal(rendered.fixtureId, ON_AIR_TEST_FIXTURE_ID);
  assert.equal(rendered.mimeType, 'audio/wav');
  assert.equal(rendered.durationMs, 8_000);
  assert.equal(rendered.byteLength, HEADER_BYTES + expectedDataBytes);
  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + expectedDataBytes);
  assert.notEqual(view.getUint32(4, false), 36 + expectedDataBytes);
  assert.equal(ascii(bytes, 8, 4), 'WAVE');
  assert.equal(ascii(bytes, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(28, true), 96_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(bytes, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), expectedDataBytes);
});

test('exports a repeated eight-second marker schedule with exact sample and time indexes', () => {
  assert.equal(Object.isFrozen(ON_AIR_TEST_FIXTURE_MARKERS), true);
  assert.equal(ON_AIR_TEST_FIXTURE_MARKERS.length, 16);
  assert.deepEqual(
    ON_AIR_TEST_FIXTURE_MARKERS.slice(0, 4).map((marker) => ({
      index: marker.index,
      markerId: marker.markerId,
      kind: marker.kind,
      frequencyHz: marker.frequencyHz,
      startMs: marker.startMs,
      endMs: marker.endMs,
      startSample: marker.startSample,
      endSample: marker.endSample,
    })),
    [
      { index: 0, markerId: 'pulse-1-cycle-1', kind: 'pulse', frequencyHz: 880, startMs: 50, endMs: 130, startSample: 2_400, endSample: 6_240 },
      { index: 1, markerId: 'pulse-2-cycle-1', kind: 'pulse', frequencyHz: 880, startMs: 200, endMs: 280, startSample: 9_600, endSample: 13_440 },
      { index: 2, markerId: 'pulse-3-cycle-1', kind: 'pulse', frequencyHz: 880, startMs: 350, endMs: 430, startSample: 16_800, endSample: 20_640 },
      { index: 3, markerId: 'long-tone-1-cycle-1', kind: 'long_tone', frequencyHz: 440, startMs: 500, endMs: 900, startSample: 24_000, endSample: 43_200 },
    ],
  );
  assert.equal(ON_AIR_TEST_FIXTURE_MARKERS.at(-1).markerId, 'long-tone-1-cycle-4');
  assert.equal(ON_AIR_TEST_FIXTURE_MARKERS.at(-1).endMs, 6_900);
  for (const marker of ON_AIR_TEST_FIXTURE_MARKERS) {
    assert.equal(marker.startSample / 48_000, marker.startTimeSeconds);
    assert.equal(marker.endSample / 48_000, marker.endTimeSeconds);
    assert.equal(marker.endMs - marker.startMs, marker.durationMs);
  }
});

test('marker regions contain the declared frequencies and stay below clipping amplitude', async () => {
  const rendered = await renderOnAirTestFixture();
  const samples = pcmSamples(rendered.arrayBuffer);
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, Math.abs(sample));

  assert.ok(maximum > 8_000);
  assert.ok(maximum <= Math.ceil(32_767 * ON_AIR_TEST_FIXTURE_FORMAT.peakAmplitude));
  assert.ok(maximum < 32_767);
  for (const marker of ON_AIR_TEST_FIXTURE_MARKERS) {
    const region = samples.slice(marker.startSample, marker.endSample);
    assert.ok(region.some((sample) => sample > 1_000));
    assert.ok(region.some((sample) => sample < -1_000));
    assert.equal(region[0], 0);
    assert.equal(region.at(-1), 0);
    assert.ok(Math.abs(positiveCrossingFrequency(samples, marker) - marker.frequencyHz) < 20);
  }
});

test('lead, inter-marker, and tail intervals are exact digital silence', async () => {
  const rendered = await renderOnAirTestFixture();
  const samples = pcmSamples(rendered.arrayBuffer);
  const silenceRanges = [];
  let previousEnd = 0;
  for (const marker of rendered.markers) {
    silenceRanges.push([previousEnd, marker.startSample]);
    previousEnd = marker.endSample;
  }
  silenceRanges.push([previousEnd, samples.length]);

  for (const [start, end] of silenceRanges) {
    assert.equal(samples.slice(start, end).every((sample) => sample === 0), true);
  }
});

test('the same inputs produce byte-for-byte identical fresh buffers', async () => {
  const first = await renderOnAirTestFixture({ durationMs: 1_250 });
  const second = await renderOnAirTestFixture({ durationMs: 1_250 });

  assert.notEqual(first.arrayBuffer, second.arrayBuffer);
  assert.equal(
    Buffer.compare(Buffer.from(first.arrayBuffer), Buffer.from(second.arrayBuffer)),
    0,
  );
  assert.equal(
    pcmSamples(first.arrayBuffer).slice(48_000).every((sample) => sample === 0),
    true,
  );
});

test('source factory returns only the normal PlaybackEngine Blob source shape', async () => {
  const source = await createOnAirTestFixtureSource();
  const rendered = await renderOnAirTestFixture();

  assert.deepEqual(Object.keys(source).sort(), ['blob', 'kind']);
  assert.equal(source.kind, 'blob');
  assert.ok(source.blob instanceof Blob);
  assert.equal(source.blob.type, 'audio/wav');
  assert.equal(source.blob.size, rendered.byteLength);
  assert.equal(
    Buffer.compare(
      Buffer.from(await source.blob.arrayBuffer()),
      Buffer.from(rendered.arrayBuffer),
    ),
    0,
  );
});

test('pre-abort and in-flight abort use stable locale-neutral error data', async () => {
  const preAborted = new AbortController();
  preAborted.abort(new Error('한국어 사용자 이유가 노출되면 안 됨'));
  await assert.rejects(
    renderOnAirTestFixture({ signal: preAborted.signal }),
    (error) => {
      assertFixtureError(error, ON_AIR_TEST_FIXTURE_CODES.ABORTED, {
        phase: 'before_allocation',
      });
      assert.equal(error.name, 'AbortError');
      assert.doesNotMatch(JSON.stringify(error.detail), /한국어/);
      return true;
    },
  );

  const duringRender = new AbortController();
  const pending = renderOnAirTestFixture({
    durationMs: 10_000,
    signal: duringRender.signal,
  });
  setTimeout(() => duringRender.abort(new Error('localized reason')), 0);
  await assert.rejects(
    pending,
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.ABORTED,
      { phase: 'render_samples' },
    ),
  );
});

test('duration and byte ceilings fail before allocating unbounded output', async () => {
  await assert.rejects(
    renderOnAirTestFixture({ durationMs: 10_001 }),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.DURATION_LIMIT_EXCEEDED,
      { durationMs: 10_001, limitMs: 10_000 },
    ),
  );
  await assert.rejects(
    renderOnAirTestFixture({ durationMs: 1_000, maxBytes: 96_043 }),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.BYTE_LIMIT_EXCEEDED,
      { byteLength: 96_044, limitBytes: 96_043 },
    ),
  );
  assert.equal(ON_AIR_TEST_FIXTURE_MAX_BYTES, 960_044);
});

test('invalid configuration and unsupported IDs expose bounded stable details', async () => {
  await assert.rejects(
    renderOnAirTestFixture(null),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.INVALID_CONFIGURATION,
      { field: 'options', kind: 'record' },
    ),
  );
  await assert.rejects(
    renderOnAirTestFixture({ durationMs: 999 }),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.INVALID_CONFIGURATION,
      { field: 'durationMs', kind: 'minimum_fixture_duration', minimumMs: 1_000 },
    ),
  );
  await assert.rejects(
    renderOnAirTestFixture({ signal: {} }),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.INVALID_CONFIGURATION,
      { field: 'signal', kind: 'abort_signal' },
    ),
  );
  const untrustedId = `future-${'x'.repeat(500)}`;
  await assert.rejects(
    renderOnAirTestFixture({ fixtureId: untrustedId }),
    (error) => {
      assertFixtureError(error, ON_AIR_TEST_FIXTURE_CODES.UNSUPPORTED_FIXTURE);
      assert.ok(error.detail.fixtureId.length <= 160);
      return true;
    },
  );
});

test('Blob construction failures are normalized without leaking dependency messages', async () => {
  class BrokenBlob {
    constructor() {
      throw Object.assign(new Error('localized dependency detail'), { name: 'FixtureBlobError' });
    }
  }

  await assert.rejects(
    createOnAirTestFixtureSource({ blobCtor: BrokenBlob }),
    (error) => assertFixtureError(
      error,
      ON_AIR_TEST_FIXTURE_CODES.BLOB_CREATION_FAILED,
      { errorName: 'FixtureBlobError' },
    ),
  );
});
