import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = CHANNEL_COUNT * (BITS_PER_SAMPLE / 8);
const BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN;
const LEAD_IN_MS = 1_000;
const CYCLE_INTERVAL_MS = 10_000;
const OBSERVATION_CADENCE_MS = 30_000;
const TAIL_AFTER_LAST_CYCLE_MS = 1_500;
const FIVE_MINUTE_CYCLES = 31;
const TEN_MINUTE_STRESS_CYCLES = 61;
const MINIMUM_CYCLES = 2;
const MAXIMUM_CYCLES = TEN_MINUTE_STRESS_CYCLES;
const PEAK_AMPLITUDE = 0.18;
const FADE_DURATION_MS = 5;

const MARKER_TEMPLATES = Object.freeze([
  Object.freeze({ kind: 'pulse', frequencyHz: 880, startMs: 50, endMs: 130 }),
  Object.freeze({ kind: 'pulse', frequencyHz: 880, startMs: 200, endMs: 280 }),
  Object.freeze({ kind: 'pulse', frequencyHz: 880, startMs: 350, endMs: 430 }),
  Object.freeze({ kind: 'long_tone', frequencyHz: 440, startMs: 500, endMs: 900 }),
]);

export const OBS_KARAOKE_SYNC_FIXTURE = Object.freeze({
  fixtureId: 'rekasong-obs-karaoke-sync-v1',
  mimeType: 'audio/wav',
  filename: 'rekasong-obs-karaoke-5m-v1.wav',
  stressFilename: 'rekasong-obs-karaoke-10m-stress-v1.wav',
  sampleRate: SAMPLE_RATE,
  channelCount: CHANNEL_COUNT,
  bitsPerSample: BITS_PER_SAMPLE,
  leadInMs: LEAD_IN_MS,
  cycleIntervalMs: CYCLE_INTERVAL_MS,
  observationCadenceMs: OBSERVATION_CADENCE_MS,
  tailAfterLastCycleMs: TAIL_AFTER_LAST_CYCLE_MS,
  fiveMinuteCycles: FIVE_MINUTE_CYCLES,
  tenMinuteStressCycles: TEN_MINUTE_STRESS_CYCLES,
  minimumCycles: MINIMUM_CYCLES,
  maximumCycles: MAXIMUM_CYCLES,
  periodicObservationPolicy: 'observe_only_no_seek_restart_or_rate_change',
  songBoundaryPolicy: 'reanchor_next_song_at_zero_keep_route',
});

function requireMarkerCycles(markerCycles) {
  if (!Number.isSafeInteger(markerCycles)
    || markerCycles < MINIMUM_CYCLES
    || markerCycles > MAXIMUM_CYCLES) {
    throw new RangeError(
      `markerCycles must be an integer from ${MINIMUM_CYCLES} to ${MAXIMUM_CYCLES}`,
    );
  }
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function writeWavHeader(view, sampleCount) {
  const dataBytes = sampleCount * BLOCK_ALIGN;
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNEL_COUNT, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
}

function envelopeGain(offset, markerSamples, fadeSamples) {
  const fadeIn = Math.min(1, offset / fadeSamples);
  const fadeOut = Math.min(1, (markerSamples - 1 - offset) / fadeSamples);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

function markerSchedule(markerCycles) {
  const markers = [];
  for (let cycleIndex = 0; cycleIndex < markerCycles; cycleIndex += 1) {
    const cycleStartMs = LEAD_IN_MS + cycleIndex * CYCLE_INTERVAL_MS;
    for (const [templateIndex, template] of MARKER_TEMPLATES.entries()) {
      const startMs = cycleStartMs + template.startMs;
      const endMs = cycleStartMs + template.endMs;
      markers.push(Object.freeze({
        index: markers.length,
        cycleIndex,
        markerIndex: templateIndex,
        kind: template.kind,
        frequencyHz: template.frequencyHz,
        startMs,
        endMs,
        startSample: startMs * (SAMPLE_RATE / 1_000),
        endSample: endMs * (SAMPLE_RATE / 1_000),
      }));
    }
  }
  return Object.freeze(markers);
}

/**
 * Render an offline-only split-track analysis fixture. The first and last
 * cycles are both real markers, so 31 cycles directly cover 0..300 seconds.
 * The 30-second cadence is metadata for observation only; this renderer does
 * not encode or request any seek, restart, or playback-rate correction.
 */
export function renderObsKaraokeSyncFixture({ markerCycles = FIVE_MINUTE_CYCLES } = {}) {
  requireMarkerCycles(markerCycles);
  const measuredMarkerSpanMs = (markerCycles - 1) * CYCLE_INTERVAL_MS;
  const durationMs = LEAD_IN_MS + measuredMarkerSpanMs + TAIL_AFTER_LAST_CYCLE_MS;
  const sampleCount = durationMs * (SAMPLE_RATE / 1_000);
  const bytes = new Uint8Array(WAV_HEADER_BYTES + sampleCount * BLOCK_ALIGN);
  const view = new DataView(bytes.buffer);
  writeWavHeader(view, sampleCount);

  const markers = markerSchedule(markerCycles);
  const fadeSamples = FADE_DURATION_MS * (SAMPLE_RATE / 1_000);
  const pcmPeak = 32_767 * PEAK_AMPLITUDE;
  for (const marker of markers) {
    const markerSamples = marker.endSample - marker.startSample;
    for (let offset = 0; offset < markerSamples; offset += 1) {
      const phase = (2 * Math.PI * marker.frequencyHz * offset) / SAMPLE_RATE;
      const gain = envelopeGain(offset, markerSamples, fadeSamples);
      view.setInt16(
        WAV_HEADER_BYTES + (marker.startSample + offset) * BLOCK_ALIGN,
        Math.round(Math.sin(phase) * pcmPeak * gain),
        true,
      );
    }
  }

  return Object.freeze({
    fixtureId: OBS_KARAOKE_SYNC_FIXTURE.fixtureId,
    bytes,
    byteLength: bytes.byteLength,
    durationMs,
    measuredMarkerSpanMs,
    markerCycles,
    markerIntervals: markerCycles - 1,
    observationPairCount: Math.max(
      0,
      markerCycles - (OBSERVATION_CADENCE_MS / CYCLE_INTERVAL_MS),
    ),
    mimeType: OBS_KARAOKE_SYNC_FIXTURE.mimeType,
    markers,
  });
}

function parseCliArguments(arguments_) {
  const unknownFlag = arguments_.find((value) => value.startsWith('-') && value !== '--stress');
  if (unknownFlag) throw new Error(`unknown option: ${unknownFlag}`);
  const outputPaths = arguments_.filter((value) => !value.startsWith('-'));
  if (outputPaths.length !== 1) {
    throw new Error('usage: node scripts/obs-karaoke-sync-fixture.mjs <output.wav> [--stress]');
  }
  return {
    outputPath: resolve(outputPaths[0]),
    markerCycles: arguments_.includes('--stress')
      ? TEN_MINUTE_STRESS_CYCLES
      : FIVE_MINUTE_CYCLES,
  };
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const rendered = renderObsKaraokeSyncFixture({ markerCycles: options.markerCycles });
  await writeFile(options.outputPath, rendered.bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(rendered.bytes).digest('hex').toUpperCase();
  console.log(JSON.stringify({
    outputPath: options.outputPath,
    fixtureId: rendered.fixtureId,
    byteLength: rendered.byteLength,
    durationMs: rendered.durationMs,
    measuredMarkerSpanMs: rendered.measuredMarkerSpanMs,
    markerCycles: rendered.markerCycles,
    markerIntervals: rendered.markerIntervals,
    observationCadenceMs: OBSERVATION_CADENCE_MS,
    observationPolicy: OBS_KARAOKE_SYNC_FIXTURE.periodicObservationPolicy,
    sha256,
  }, null, 2));
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
