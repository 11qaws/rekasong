import assert from 'node:assert/strict';

import { createPlaybackLyricsPackage } from '../src/lib/lyrics/lyricsPackage.js';

const baseUrl = String(
  process.env.REKASONG_SESSION_BASE_URL || 'https://rekasong-session.11qaws.workers.dev',
).replace(/\/$/u, '');
const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, { method: 'POST' });
assert.equal(sessionResponse.status, 200);
const session = await sessionResponse.json();

const playbackPackage = await createPlaybackLyricsPackage({
  packageId: `lyrics-package:deploy-${Date.now()}`,
  songWorkId: 'song-work:deploy-smoke',
  trackVersionId: 'track-version:deploy-smoke',
  cueSheetRevisionId: 'cue-sheet:deploy-smoke:r1',
  translationRevisionId: 'translation:deploy-smoke:r1',
  durationMs: 120_000,
  timingMode: 'tempo_map',
  ppq: 960,
  tempoSegments: [{
    startTick: 0,
    startMs: 0,
    bpm: 130,
    numerator: 4,
    denominator: 4,
    downbeatTick: 0,
  }],
  cues: [
    {
      cueId: 'C1',
      kind: 'lyric',
      anchorMs: 60_000,
      anchorTick: 124_800,
      originalLines: ['Synthetic original'],
      translationLinesKo: ['합성 번역'],
      romanizationLines: [],
    },
    {
      cueId: 'B1',
      kind: 'blank',
      anchorMs: 90_000,
      anchorTick: 187_200,
      originalLines: [],
      translationLinesKo: [],
      romanizationLines: [],
    },
  ],
});
const body = JSON.stringify(playbackPackage);
const uploadResponse = await fetch(
  `${baseUrl}/v1/sessions/${encodeURIComponent(session.room)}/lyrics-assets`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.controlToken}`,
      'Content-Type': 'application/json',
      'X-Rekasong-Size': String(new TextEncoder().encode(body).byteLength),
      'X-Rekasong-Hash': playbackPackage.packageHash,
      'X-Rekasong-Package': playbackPackage.packageId,
    },
    body,
  },
);
assert.equal(uploadResponse.status, 200);
const uploaded = await uploadResponse.json();

const readResponse = await fetch(
  `${baseUrl}/v1/sessions/${encodeURIComponent(session.room)}/lyrics/${encodeURIComponent(uploaded.assetId)}?token=${encodeURIComponent(session.playerToken)}`,
);
assert.equal(readResponse.status, 200);
assert.match(readResponse.headers.get('content-type') || '', /^application\/json\b/u);
const received = await readResponse.json();
assert.equal(received.packageHash, playbackPackage.packageHash);
assert.deepEqual(received.cues, playbackPackage.cues);

console.log(JSON.stringify({
  target: baseUrl,
  sessionCreated: true,
  uploadStatus: uploadResponse.status,
  readStatus: readResponse.status,
  contentType: readResponse.headers.get('content-type'),
  schemaVersion: received.schemaVersion,
  cueCount: received.cues.length,
  hashMatch: received.packageHash === playbackPackage.packageHash,
}, null, 2));
