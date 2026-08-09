import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlaybackLyricsPackage } from '../src/lib/lyrics/lyricsPackage.js';
import {
  LYRICS_SESSION_ASSET_MAX_BYTES,
  lyricsAssetKey,
  readLyricsAssetRequest,
  validateLyricsAssetValue,
} from '../workers/rekasong-session/src/lyricsAssetContract.js';

const packageInput = () => ({
  packageId: 'lyrics-package:asset',
  songWorkId: 'song-work:asset',
  trackVersionId: 'track-version:asset',
  cueSheetRevisionId: 'cue-sheet:asset:r1',
  translationRevisionId: 'translation:asset:r1',
  durationMs: 1_000,
  timingMode: 'fixed_ms_fallback',
  ppq: 960,
  tempoSegments: [],
  cues: [{ cueId: 'C1', kind: 'lyric', anchorMs: 500, anchorTick: null, originalLines: ['alpha'], translationLinesKo: ['beta'], romanizationLines: [] }],
});

test('lyrics session assets use a separate namespace and require exact JSON hash', async () => {
  const playbackPackage = await createPlaybackLyricsPackage(packageInput());
  const body = JSON.stringify(playbackPackage);
  const request = new Request('https://worker.invalid/lyrics-assets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rekasong-Size': String(new TextEncoder().encode(body).byteLength),
      'X-Rekasong-Hash': playbackPackage.packageHash,
    },
    body,
  });
  const result = await readLyricsAssetRequest(request);
  assert.equal(result.ok, true);
  assert.equal(result.value.packageId, playbackPackage.packageId);
  assert.equal(lyricsAssetKey('room', 'asset'), 'sessions/room/lyrics/asset');
});

test('wrong MIME, declared size, schema, and hash fail before storage', async () => {
  const playbackPackage = await createPlaybackLyricsPackage(packageInput());
  assert.equal((await validateLyricsAssetValue({ ...playbackPackage, schemaVersion: 2 })).ok, false);
  assert.equal((await validateLyricsAssetValue({ ...playbackPackage, durationMs: 2_000 })).ok, false);

  const wrongType = await readLyricsAssetRequest(new Request('https://worker.invalid', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Rekasong-Size': '2' },
    body: '{}',
  }));
  assert.equal(wrongType.code, 'lyrics_content_type_unsupported');
  const tooLarge = await readLyricsAssetRequest(new Request('https://worker.invalid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rekasong-Size': String(LYRICS_SESSION_ASSET_MAX_BYTES + 1) },
    body: '{}',
  }));
  assert.equal(tooLarge.code, 'lyrics_size_unsupported');
});
