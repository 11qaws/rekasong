import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlaybackLyricsPackage,
  validatePlaybackLyricsPackage,
  verifyPlaybackLyricsPackage,
} from '../src/lib/lyrics/lyricsPackage.js';

const input = () => ({
  packageId: 'lyrics-package:fixture',
  songWorkId: 'song-work:fixture',
  trackVersionId: 'track-version:fixture',
  cueSheetRevisionId: 'cue-sheet:fixture:r1',
  translationRevisionId: 'translation:fixture:r1',
  durationMs: 120_000,
  timingMode: 'tempo_map',
  ppq: 960,
  tempoSegments: [{ startTick: 0, startMs: 0, bpm: 130, numerator: 4, denominator: 4, downbeatTick: 0 }],
  cues: [
    { cueId: 'C1', kind: 'lyric', anchorMs: 60_000, anchorTick: 124_800, originalLines: ['<original-1>'], translationLinesKo: ['<translation-1>'], romanizationLines: [] },
    { cueId: 'B1', kind: 'blank', anchorMs: 90_000, anchorTick: 187_200, originalLines: [], translationLinesKo: [], romanizationLines: [] },
  ],
});

test('package creation hashes the immutable OBS projection and verifies it', async () => {
  const playbackPackage = await createPlaybackLyricsPackage(input());
  assert.match(playbackPackage.packageHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal((await verifyPlaybackLyricsPackage(playbackPackage, playbackPackage.packageHash)).ok, true);
  assert.equal(validatePlaybackLyricsPackage(playbackPackage).ok, true);
});

test('hash, schema, ordering, IDs, numbers, blank text, and raw projections fail closed', async () => {
  const valid = await createPlaybackLyricsPackage(input());
  const tampered = { ...valid, durationMs: 999 };
  assert.deepEqual((await verifyPlaybackLyricsPackage(tampered)).errors, ['packageHash:mismatch']);
  assert.ok(validatePlaybackLyricsPackage({ ...valid, schemaVersion: 2 }).errors.includes('schemaVersion:unsupported'));
  assert.ok(validatePlaybackLyricsPackage({
    ...valid,
    cues: [{ ...valid.cues[0], cueId: 'same', anchorMs: 2 }, { ...valid.cues[0], cueId: 'same', anchorMs: 1 }],
  }).errors.some((error) => error.includes('duplicate') || error.includes('unordered')));
  assert.ok(validatePlaybackLyricsPackage({ ...valid, durationMs: Number.NaN }).errors.includes('durationMs:invalid_number'));
  assert.ok(validatePlaybackLyricsPackage({
    ...valid,
    cues: [{ ...valid.cues[1], originalLines: ['not blank'] }],
  }).errors.includes('cues[0]:blank_has_text'));
  assert.ok(validatePlaybackLyricsPackage({ ...valid, rawLyrics: 'forbidden' }).errors.includes('rawLyrics:forbidden_projection'));
});

test('cue and string caps bound session assets', async () => {
  const valid = await createPlaybackLyricsPackage(input());
  assert.ok(validatePlaybackLyricsPackage({
    ...valid,
    cues: [{ ...valid.cues[0], originalLines: ['x'.repeat(501)] }],
  }).errors.includes('cues[0].originalLines[0]:invalid_string'));
  assert.ok(validatePlaybackLyricsPackage({
    ...valid,
    cues: Array.from({ length: 2_001 }, (_, index) => ({ ...valid.cues[0], cueId: `C${index}` })),
  }).errors.includes('cues:too_many'));
});

test('OBS display settings are a bounded immutable projection', async () => {
  const playbackPackage = await createPlaybackLyricsPackage({
    ...input(),
    displayDefaults: { positionPreset: 'center', originalFontSize: 72 },
  });
  assert.equal(playbackPackage.displayDefaults.positionPreset, 'center');
  assert.equal(playbackPackage.displayDefaults.originalFontSize, 72);
  assert.equal(validatePlaybackLyricsPackage({
    ...playbackPackage,
    displayDefaults: { ...playbackPackage.displayDefaults, areaWidth: 20_000 },
  }).ok, false);
});
