import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_PLAYBACK_PROGRESS_TICK_MS,
  projectRemotePlaybackPosition,
  reanchorRemotePlaybackProgress,
} from '../src/lib/remotePlaybackProgress.js';

test('remote playback progress projects from one absolute anchor without timer accumulation', () => {
  const anchor = reanchorRemotePlaybackProgress(null, {
    runId: 'run-a',
    position: 12,
    duration: 180,
    status: 'playing',
  }, 1_000);

  assert.equal(REMOTE_PLAYBACK_PROGRESS_TICK_MS, 1_000);
  assert.equal(projectRemotePlaybackPosition(anchor, 31_000), 42);
  assert.equal(projectRemotePlaybackPosition(anchor, 61_000), 72);
  assert.equal(projectRemotePlaybackPosition(anchor, 500), 12);
});

test('paused and buffering anchors freeze while playing anchors cap at duration', () => {
  const paused = reanchorRemotePlaybackProgress(null, {
    runId: 'run-a', position: 40, duration: 60, status: 'paused',
  }, 2_000);
  const buffering = reanchorRemotePlaybackProgress(paused, {
    runId: 'run-a', status: 'buffering',
  }, 12_000);
  const playing = reanchorRemotePlaybackProgress(buffering, {
    runId: 'run-a', status: 'playing',
  }, 22_000);

  assert.equal(projectRemotePlaybackPosition(paused, 52_000), 40);
  assert.equal(buffering.position, 40);
  assert.equal(projectRemotePlaybackPosition(buffering, 52_000), 40);
  assert.equal(projectRemotePlaybackPosition(playing, 52_000), 60);
});

test('fresh observations re-anchor display only and a new run never inherits old time', () => {
  const first = reanchorRemotePlaybackProgress(null, {
    runId: 'run-a', position: 0, duration: 300, status: 'playing',
  }, 0);
  const observed = reanchorRemotePlaybackProgress(first, {
    runId: 'run-a', position: 29.8, status: 'playing',
  }, 30_000);
  const nextRun = reanchorRemotePlaybackProgress(observed, {
    runId: 'run-b', duration: 240, status: 'loading',
  }, 31_000);

  assert.equal(observed.position, 29.8);
  assert.equal(projectRemotePlaybackPosition(observed, 35_000), 34.8);
  assert.equal(nextRun.position, 0);
  assert.equal(projectRemotePlaybackPosition(nextRun, 120_000), 0);
});
