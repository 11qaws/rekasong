import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LYRICS_RUNTIME_STATUS,
  createLyricsRuntimeState,
} from '../src/lib/lyrics/lyricsRuntimeState.js';

const marker = (overrides = {}) => ({
  entryId: 'entry-1',
  runId: 'run-1',
  playerInstanceId: 'player-1',
  packageHash: 'sha256:one',
  ...overrides,
});

test('late package loads from an old run or player reconnect are discarded', () => {
  const runtime = createLyricsRuntimeState();
  const oldTicket = runtime.begin(marker());
  const currentTicket = runtime.begin(marker({ runId: 'run-2' }));
  assert.equal(runtime.complete(oldTicket, { timingMode: 'tempo_map' }), false);
  assert.equal(runtime.complete(currentTicket, { timingMode: 'tempo_map' }), true);
  assert.equal(runtime.snapshot().status, LYRICS_RUNTIME_STATUS.READY);

  const oldPlayer = runtime.begin(marker({ playerInstanceId: 'player-old' }));
  runtime.begin(marker({ playerInstanceId: 'player-new' }));
  assert.equal(runtime.fail(oldPlayer, 'late_error'), false);
});

test('fixed fallback is degraded and optional failure never mutates audio lifecycle state', () => {
  const runtime = createLyricsRuntimeState();
  const fallback = runtime.begin(marker());
  runtime.complete(fallback, { timingMode: 'fixed_ms_fallback' });
  assert.equal(runtime.snapshot().status, LYRICS_RUNTIME_STATUS.DEGRADED);
  const failed = runtime.begin(marker({ packageHash: 'sha256:two' }));
  assert.equal(runtime.fail(failed, 'lyrics_package_hash_mismatch'), true);
  assert.equal(runtime.snapshot().status, LYRICS_RUNTIME_STATUS.ERROR);
  runtime.clear();
  assert.equal(runtime.snapshot().status, LYRICS_RUNTIME_STATUS.DISABLED);
});
