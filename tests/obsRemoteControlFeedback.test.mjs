import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS,
  createObsRemoteControlFeedback,
  obsRemoteControlFeedbackMatchesRun,
  reconcileObsRemoteControlFeedback,
} from '../src/lib/obsRemoteControlFeedback.js';

function dispatch(action, value, overrides = {}) {
  const payload = action === 'seek'
    ? { position: value }
    : action === 'volume' ? { volume: value } : {};
  return {
    command: {
      type: action,
      commandId: `command-${action}`,
      entryId: 'entry-1',
      runId: 'run-1',
      payload,
      ...overrides,
    },
    result: { status: 'pending' },
  };
}

test('creates one tab-local waiting record from the exact coordinator command', () => {
  const feedback = createObsRemoteControlFeedback({
    action: 'seek',
    dispatchResult: dispatch('seek', 42.5),
    requestedAt: 100,
  });
  assert.deepEqual(feedback, {
    commandId: 'command-seek',
    entryId: 'entry-1',
    runId: 'run-1',
    action: 'seek',
    requestedValue: 42.5,
    confirmedValue: null,
    phase: 'waiting',
    requestedAt: 100,
    observedAt: null,
    reasonCode: null,
  });
  assert.equal(createObsRemoteControlFeedback({ action: 'seek', dispatchResult: dispatch('volume', 42) }), null);
});

test('seek and volume confirm only from the same command and matching applied value', () => {
  const seek = createObsRemoteControlFeedback({ action: 'seek', dispatchResult: dispatch('seek', 42.5), requestedAt: 100 });
  const wrongCommand = reconcileObsRemoteControlFeedback(seek, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'other', commandType: 'SEEK', position: 42.5,
  }, 200);
  assert.equal(wrongCommand.phase, 'waiting');
  const wrongValue = reconcileObsRemoteControlFeedback(seek, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-seek', commandType: 'SEEK', position: 50,
  }, 200);
  assert.equal(wrongValue.phase, 'waiting');
  const confirmedSeek = reconcileObsRemoteControlFeedback(seek, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-seek', commandType: 'SEEK', position: 42.5, lastSeenAt: 180,
  }, 200);
  assert.equal(confirmedSeek.phase, 'confirmed');
  assert.equal(confirmedSeek.confirmedValue, 42.5);

  const volume = createObsRemoteControlFeedback({ action: 'volume', dispatchResult: dispatch('volume', 34), requestedAt: 300 });
  const confirmedVolume = reconcileObsRemoteControlFeedback(volume, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-volume', commandType: 'VOLUME', volume: 34,
  }, 350);
  assert.equal(confirmedVolume.phase, 'confirmed');
  assert.equal(confirmedVolume.confirmedValue, 34);
});

test('play and pause wait for the matching physical playback state', () => {
  const play = createObsRemoteControlFeedback({ action: 'play', dispatchResult: dispatch('play'), requestedAt: 100 });
  assert.equal(reconcileObsRemoteControlFeedback(play, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-play', event: 'command_applied', status: 'paused',
  }, 150).phase, 'waiting');
  assert.equal(reconcileObsRemoteControlFeedback(play, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-play', event: 'playing', status: 'playing',
  }, 180).phase, 'confirmed');

  const pause = createObsRemoteControlFeedback({ action: 'pause', dispatchResult: dispatch('pause'), requestedAt: 200 });
  assert.equal(reconcileObsRemoteControlFeedback(pause, {
    entryId: 'entry-1', runId: 'run-1', commandId: 'command-pause', event: 'paused', status: 'paused',
  }, 230).phase, 'confirmed');
});

test('command failure and delayed confirmation remain non-destructive distinct outcomes', () => {
  const waiting = createObsRemoteControlFeedback({ action: 'volume', dispatchResult: dispatch('volume', 25), requestedAt: 1_000 });
  const delayed = reconcileObsRemoteControlFeedback(
    waiting,
    null,
    1_000 + OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS,
  );
  assert.equal(delayed.phase, 'delayed');
  assert.equal(delayed.reasonCode, 'confirmation_delayed');

  const failed = reconcileObsRemoteControlFeedback(waiting, {
    entryId: 'entry-1',
    runId: 'run-1',
    commandId: 'command-volume',
    event: 'command_failed',
    failureCode: 'media_postcondition_failed',
  }, 1_200);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.reasonCode, 'media_postcondition_failed');
});

test('run matching is OBS-only and never adopts another tab or Speaker run', () => {
  const feedback = createObsRemoteControlFeedback({ action: 'play', dispatchResult: dispatch('play') });
  assert.equal(obsRemoteControlFeedbackMatchesRun(feedback, {
    outputMode: 'obs', entryId: 'entry-1', runId: 'run-1',
  }), true);
  assert.equal(obsRemoteControlFeedbackMatchesRun(feedback, {
    outputMode: 'speaker', entryId: 'entry-1', runId: 'run-1',
  }), false);
  assert.equal(obsRemoteControlFeedbackMatchesRun(feedback, {
    outputMode: 'obs', entryId: 'entry-1', runId: 'run-2',
  }), false);
});

test('Worker preserves player command identity without adding traffic or changing wire validation', async () => {
  const worker = await readFile(new URL('../workers/rekasong-session/src/index.js', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(worker, /\['command_applied', 'command_failed'\]\.includes\(eventType\)[\s\S]*?confirmed\.commandId = message\.commandId;/);
  assert.match(worker, /confirmed\.commandType = appliedSeek[\s\S]*?'SEEK'[\s\S]*?appliedVolume[\s\S]*?'VOLUME'/);
  assert.doesNotMatch(worker, /obs_remote_control_feedback|remote_control_feedback/);
  assert.match(dashboard, /createObsRemoteControlFeedback/);
  assert.match(dashboard, /reconcileObsRemoteControlFeedback/);
  assert.match(dashboard, /activeRef\.current\?\.outputMode !== 'obs'/);
});
