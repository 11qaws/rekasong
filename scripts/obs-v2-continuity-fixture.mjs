const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = CHANNEL_COUNT * (BITS_PER_SAMPLE / 8);
const BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 600_000;
const PULSE_INTERVAL_MS = 1_000;
const PULSE_DURATION_MS = 60;
const PULSE_FREQUENCY_HZ = 660;
const PEAK_AMPLITUDE = 0.18;

export const OBS_V2_CONTINUITY_FIXTURE = Object.freeze({
  mimeType: 'audio/wav',
  filename: 'rekasong-obs-continuity.wav',
  sampleRate: SAMPLE_RATE,
  channelCount: CHANNEL_COUNT,
  bitsPerSample: BITS_PER_SAMPLE,
  minimumDurationMs: MIN_DURATION_MS,
  maximumDurationMs: MAX_DURATION_MS,
});

function requireDuration(durationMs) {
  if (!Number.isSafeInteger(durationMs)
    || durationMs < MIN_DURATION_MS
    || durationMs > MAX_DURATION_MS) {
    throw new RangeError(
      `durationMs must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS}`,
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

/**
 * Produce a bounded normal-song fixture rather than the strict OBS test signal.
 * Sparse pulses make physical mixer/recording checks audible while the fully
 * buffered WAV keeps network transport out of the media timeline after LOAD.
 */
export function renderObsV2ContinuityFixture({ durationMs = 30_000 } = {}) {
  requireDuration(durationMs);
  const sampleCount = durationMs * (SAMPLE_RATE / 1_000);
  const bytes = new Uint8Array(WAV_HEADER_BYTES + sampleCount * BLOCK_ALIGN);
  const view = new DataView(bytes.buffer);
  writeWavHeader(view, sampleCount);

  const pulseSamples = PULSE_DURATION_MS * (SAMPLE_RATE / 1_000);
  const fadeSamples = 5 * (SAMPLE_RATE / 1_000);
  const peak = 32_767 * PEAK_AMPLITUDE;
  for (let startMs = 100; startMs + PULSE_DURATION_MS <= durationMs; startMs += PULSE_INTERVAL_MS) {
    const startSample = startMs * (SAMPLE_RATE / 1_000);
    for (let offset = 0; offset < pulseSamples; offset += 1) {
      const fadeIn = Math.min(1, offset / fadeSamples);
      const fadeOut = Math.min(1, (pulseSamples - 1 - offset) / fadeSamples);
      const gain = Math.max(0, Math.min(fadeIn, fadeOut));
      const phase = (2 * Math.PI * PULSE_FREQUENCY_HZ * offset) / SAMPLE_RATE;
      view.setInt16(
        WAV_HEADER_BYTES + (startSample + offset) * BLOCK_ALIGN,
        Math.round(Math.sin(phase) * peak * gain),
        true,
      );
    }
  }

  return Object.freeze({
    bytes,
    durationMs,
    byteLength: bytes.byteLength,
    mimeType: OBS_V2_CONTINUITY_FIXTURE.mimeType,
    filename: OBS_V2_CONTINUITY_FIXTURE.filename,
  });
}
