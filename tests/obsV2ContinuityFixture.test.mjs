import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBS_V2_CONTINUITY_FIXTURE,
  renderObsV2ContinuityFixture,
} from '../scripts/obs-v2-continuity-fixture.mjs';

test('continuity fixture is a deterministic 48 kHz mono PCM WAV with audible pulse data', () => {
  const first = renderObsV2ContinuityFixture({ durationMs: 5_000 });
  const second = renderObsV2ContinuityFixture({ durationMs: 5_000 });

  assert.equal(first.byteLength, 44 + 5_000 * 48_000 * 2 / 1_000);
  assert.equal(new TextDecoder().decode(first.bytes.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(first.bytes.subarray(8, 12)), 'WAVE');
  assert.equal(new DataView(first.bytes.buffer).getUint32(24, true), 48_000);
  assert.equal(new DataView(first.bytes.buffer).getUint16(22, true), 1);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.subarray(44).some((value) => value !== 0), true);
});

test('continuity fixture enforces the bounded ten-minute soak envelope', () => {
  for (const durationMs of [4_999, 600_001, 1.5]) {
    assert.throws(
      () => renderObsV2ContinuityFixture({ durationMs }),
      RangeError,
    );
  }
  assert.equal(OBS_V2_CONTINUITY_FIXTURE.maximumDurationMs, 600_000);
});
