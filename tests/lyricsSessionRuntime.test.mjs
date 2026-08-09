import test from 'node:test';
import assert from 'node:assert/strict';

import { createLyricsPlaybackController } from '../src/lib/lyrics/lyricsSessionAsset.js';

const marker = {
  entryId: 'entry-1',
  runId: 'run-1',
  lyrics: {
    assetId: 'asset-1',
    packageHash: `sha256:${'a'.repeat(64)}`,
    requireLyrics: false,
  },
};

test('a stale lyrics fetch cannot replace the exact current run package', async () => {
  const pending = [];
  const snapshots = [];
  const controller = createLyricsPlaybackController({
    baseUrl: 'https://worker.invalid',
    room: 'room',
    token: 'token',
    playerInstanceId: 'player-1',
    fetchPackage: ({ assetId }) => new Promise((resolve) => pending.push({ assetId, resolve })),
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  const first = controller.prepare(marker);
  const second = controller.prepare({
    ...marker,
    runId: 'run-2',
    lyrics: { ...marker.lyrics, assetId: 'asset-2', packageHash: `sha256:${'b'.repeat(64)}` },
  });
  pending[0].resolve({ packageHash: marker.lyrics.packageHash, timingMode: 'tempo_map' });
  pending[1].resolve({ packageHash: `sha256:${'b'.repeat(64)}`, timingMode: 'tempo_map' });
  await Promise.all([first, second]);
  assert.equal(controller.snapshot().marker.runId, 'run-2');
  assert.equal(controller.snapshot().playbackPackage.packageHash, `sha256:${'b'.repeat(64)}`);
  assert.equal(snapshots.at(-1).status, 'ready');
});

test('optional lyrics degrade alone while required lyrics reject media preparation', async () => {
  const controller = createLyricsPlaybackController({
    baseUrl: 'https://worker.invalid', room: 'room', token: 'token', playerInstanceId: 'player-1',
    fetchPackage: async () => { throw new Error('lyrics_missing'); },
  });
  assert.equal(await controller.prepare(marker), null);
  assert.equal(controller.snapshot().status, 'error');
  await assert.rejects(
    controller.prepare({ ...marker, lyrics: { ...marker.lyrics, requireLyrics: true } }),
    /lyrics_missing/,
  );
});
