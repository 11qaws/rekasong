import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBS_KARAOKE_SYNC_FIXTURE,
  renderObsKaraokeSyncFixture,
} from '../scripts/obs-karaoke-sync-fixture.mjs';

const HEADER_BYTES = 44;

test('karaoke fixture directly covers both marker endpoints and keeps 30-second checks observational', () => {
  const rendered = renderObsKaraokeSyncFixture({ markerCycles: 4 });

  assert.equal(rendered.markerCycles, 4);
  assert.equal(rendered.markerIntervals, 3);
  assert.equal(rendered.measuredMarkerSpanMs, 30_000);
  assert.equal(rendered.observationPairCount, 1);
  assert.equal(rendered.durationMs, 32_500);
  assert.equal(rendered.markers.length, 16);
  assert.equal(rendered.markers[0].startMs, 1_050);
  assert.equal(rendered.markers[3].endMs, 1_900);
  assert.equal(rendered.markers.at(-4).startMs, 31_050);
  assert.equal(rendered.markers.at(-1).endMs, 31_900);
  assert.equal(
    OBS_KARAOKE_SYNC_FIXTURE.periodicObservationPolicy,
    'observe_only_no_seek_restart_or_rate_change',
  );
  assert.equal(
    OBS_KARAOKE_SYNC_FIXTURE.songBoundaryPolicy,
    'reanchor_next_song_at_zero_keep_route',
  );
});

test('karaoke fixture is deterministic 48 kHz mono PCM with exact silence outside markers', () => {
  const first = renderObsKaraokeSyncFixture({ markerCycles: 2 });
  const second = renderObsKaraokeSyncFixture({ markerCycles: 2 });
  const view = new DataView(first.bytes.buffer);

  assert.equal(first.byteLength, HEADER_BYTES + first.durationMs * 48_000 * 2 / 1_000);
  assert.equal(new TextDecoder().decode(first.bytes.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(first.bytes.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(first.bytes, second.bytes);

  const firstMarker = first.markers[0];
  const lastMarker = first.markers.at(-1);
  const pcm = new Int16Array(first.bytes.buffer, HEADER_BYTES);
  assert.equal(pcm.slice(0, firstMarker.startSample).every((sample) => sample === 0), true);
  assert.equal(
    pcm.slice(lastMarker.endSample).every((sample) => sample === 0),
    true,
  );
  assert.equal(
    pcm.slice(firstMarker.startSample, firstMarker.endSample)
      .some((sample) => Math.abs(sample) > 1_000),
    true,
  );
  assert.equal(pcm[firstMarker.startSample], 0);
  assert.equal(pcm[firstMarker.endSample - 1], 0);
});

test('five-minute and stress fixture envelopes are bounded before allocation', () => {
  assert.equal(OBS_KARAOKE_SYNC_FIXTURE.fiveMinuteCycles, 31);
  assert.equal(OBS_KARAOKE_SYNC_FIXTURE.tenMinuteStressCycles, 61);
  assert.equal(OBS_KARAOKE_SYNC_FIXTURE.maximumCycles, 61);
  for (const markerCycles of [1, 62, 2.5, Number.NaN]) {
    assert.throws(
      () => renderObsKaraokeSyncFixture({ markerCycles }),
      RangeError,
    );
  }
});
