import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalSpeakerController } from '../src/lib/localSpeakerController.js';
import { SPEAKER_INTERRUPTION_REASONS } from '../src/lib/speakerInterruption.js';

function createHarness() {
  const calls = [];
  const observed = [];
  const resolved = [];
  let emitEvidence = null;
  let insideEvidenceObserver = false;
  let engineSnapshot = {
    status: 'ready',
    runId: null,
    sourceAttached: false,
    mediaPaused: true,
    wantsPlayback: false,
    position: 0,
    duration: 0,
    readyState: 0,
    seeking: false,
  };
  const engine = {
    execute() {},
    snapshot() {
      return engineSnapshot;
    },
    load(command) {
      calls.push(['load', command]);
      return Promise.resolve({ status: 'loading' });
    },
    play(command) {
      if (insideEvidenceObserver) throw Object.assign(new Error('observer_reentry'), { code: 'observer_reentry' });
      calls.push(['play', command]);
      return Promise.resolve({ status: 'playing' });
    },
    pause(command) { calls.push(['pause', command]); return 'paused'; },
    seek(command) { calls.push(['seek', command]); return 'seeked'; },
    volume(command) { calls.push(['volume', command]); return 'volume'; },
    stop(command) {
      if (insideEvidenceObserver) throw Object.assign(new Error('observer_reentry'), { code: 'observer_reentry' });
      calls.push(['stop', command]);
      engineSnapshot = {
        ...engineSnapshot,
        status: 'stopped',
        runId: null,
        sourceAttached: false,
        mediaPaused: true,
      };
      return 'stopped';
    },
    dispose() { calls.push(['dispose']); },
  };
  const controller = createLocalSpeakerController({
    audio: { ended: false },
    resolveSource(context) {
      resolved.push(context);
      return Promise.resolve({ kind: 'url', url: 'blob:test' });
    },
    prefetchSources(videoIds) {
      calls.push(['prefetch', videoIds]);
      return Promise.resolve({ status: 'ok' });
    },
    engineFactory(options) {
      emitEvidence = options.onEvidence;
      return engine;
    },
    onEvidence(evidence) {
      observed.push(evidence);
    },
  });
  return {
    calls,
    controller,
    emitEvidence(value) {
      insideEvidenceObserver = true;
      try {
        emitEvidence(value);
      } finally {
        insideEvidenceObserver = false;
      }
    },
    observed,
    resolved,
    setEngineSnapshot(next) {
      engineSnapshot = { ...engineSnapshot, ...next };
    },
  };
}

test('local speaker loads and autoplays without any route lease or player candidate', async () => {
  const { calls, controller, emitEvidence, resolved } = createHarness();
  const song = { type: 'youtube', src: 'abcdefghijk' };

  await controller.sendCommand({
    type: 'load',
    runId: 'run-local-1',
    song,
    position: 4,
    volume: 72,
  });

  const loadCommand = calls[0][1];
  assert.equal(calls[0][0], 'load');
  assert.equal(loadCommand.runId, 'run-local-1');
  assert.equal(loadCommand.position, 4);
  assert.equal(loadCommand.volume, 72);
  await loadCommand.sourceFactory({ signal: new AbortController().signal });
  assert.equal(resolved[0].song, song);

  emitEvidence({ type: 'ready', runId: 'run-local-1' });
  await Promise.resolve();
  assert.equal(calls.filter(([name]) => name === 'play').length, 1);
  assert.equal(calls.find(([name]) => name === 'play')[1].runId, 'run-local-1');
});

test('every local speaker controller remains independent and supports normal transport', async () => {
  const first = createHarness();
  const second = createHarness();

  await Promise.all([
    first.controller.sendCommand({
      type: 'load',
      runId: 'run-first',
      song: { type: 'youtube', src: 'abcdefghijk' },
    }),
    second.controller.sendCommand({
      type: 'load',
      runId: 'run-second',
      song: { type: 'youtube', src: 'lmnopqrstuv' },
    }),
  ]);
  first.emitEvidence({ type: 'ready', runId: 'run-first' });
  second.emitEvidence({ type: 'ready', runId: 'run-second' });
  await Promise.resolve();

  assert.equal(first.calls.filter(([name]) => name === 'play').length, 1);
  assert.equal(second.calls.filter(([name]) => name === 'play').length, 1);
  assert.equal(first.calls.some(([name]) => name === 'activateOutput'), false);
  assert.equal(second.calls.some(([name]) => name === 'activateOutput'), false);

  assert.equal(first.controller.sendCommand({ type: 'pause', runId: 'run-first' }), 'paused');
  assert.equal(first.controller.sendCommand({ type: 'seek', runId: 'run-first', position: 30 }), 'seeked');
  assert.equal(first.controller.sendCommand({ type: 'volume', runId: 'run-first', volume: 45 }), 'volume');
  assert.equal(first.controller.sendCommand({ type: 'stop', runId: 'run-first' }), 'stopped');
});

test('a pause between READY and deferred autoplay prevents a stale song from starting', async () => {
  const harness = createHarness();
  await harness.controller.sendCommand({
    type: 'load',
    runId: 'run-cancelled-autoplay',
    song: { type: 'youtube', src: 'abcdefghijk' },
  });

  harness.emitEvidence({ type: 'ready', runId: 'run-cancelled-autoplay' });
  harness.controller.sendCommand({ type: 'pause', runId: 'run-cancelled-autoplay' });
  await Promise.resolve();

  assert.equal(harness.calls.filter(([name]) => name === 'play').length, 0);
  assert.equal(harness.calls.filter(([name]) => name === 'pause').length, 1);
});

test('prefetch remains a media optimization and does not create playback authority', async () => {
  const { calls, controller } = createHarness();
  await controller.sendCommand({ type: 'prefetch', videoIds: ['abcdefghijk'] });
  assert.deepEqual(calls, [['prefetch', ['abcdefghijk']]]);
});

test('natural end releases the completed source only after the evidence observer exits', async () => {
  const harness = createHarness();
  await harness.controller.sendCommand({
    type: 'load',
    runId: 'run-natural-end',
    song: { type: 'youtube', src: 'abcdefghijk' },
  });
  harness.setEngineSnapshot({
    status: 'ended',
    runId: 'run-natural-end',
    sourceAttached: true,
    mediaPaused: true,
    wantsPlayback: false,
    position: 180,
    duration: 180,
  });

  harness.emitEvidence({
    type: 'ended',
    runId: 'run-natural-end',
    mediaTime: 180,
    duration: 180,
  });

  assert.equal(
    harness.calls.filter(([name]) => name === 'stop').length,
    0,
    'source cleanup must not re-enter PlaybackEngine from its evidence observer',
  );
  assert.equal(harness.observed.at(-1).type, 'ended');
  await Promise.resolve();
  assert.equal(harness.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(
    harness.calls.find(([name]) => name === 'stop')[1].runId,
    'run-natural-end',
  );
  await Promise.resolve();
  assert.equal(harness.controller.snapshot().activeSong, null);
});

test('deferred natural-end release cannot stop a replacement run', async () => {
  const harness = createHarness();
  await harness.controller.sendCommand({
    type: 'load',
    runId: 'run-ended',
    song: { type: 'youtube', src: 'abcdefghijk' },
  });
  harness.setEngineSnapshot({
    status: 'ended',
    runId: 'run-ended',
    sourceAttached: true,
    mediaPaused: true,
    wantsPlayback: false,
  });

  harness.emitEvidence({ type: 'ended', runId: 'run-ended' });
  const replacementLoad = harness.controller.sendCommand({
    type: 'load',
    runId: 'run-replacement',
    song: { type: 'youtube', src: 'lmnopqrstuv' },
  });
  harness.setEngineSnapshot({
    status: 'loading',
    runId: 'run-replacement',
    sourceAttached: false,
  });
  await replacementLoad;
  await Promise.resolve();

  assert.equal(harness.calls.filter(([name]) => name === 'stop').length, 0);
  assert.equal(harness.controller.snapshot().activeSong.src, 'lmnopqrstuv');
});

test('page resume observes a system pause without issuing a transport command', () => {
  const harness = createHarness();
  harness.setEngineSnapshot({
    status: 'paused',
    runId: 'run-resume',
    sourceAttached: true,
    mediaPaused: true,
    wantsPlayback: true,
    position: 42.5,
    duration: 180,
    readyState: 4,
  });

  const interrupted = harness.controller.observePhysicalState();
  assert.equal(interrupted.type, 'paused');
  assert.equal(interrupted.runId, 'run-resume');
  assert.equal(interrupted.mediaTime, 42.5);
  assert.equal(
    interrupted.interruptionReason,
    SPEAKER_INTERRUPTION_REASONS.SYSTEM_PAUSE,
  );
  assert.deepEqual(harness.calls, []);

  harness.emitEvidence({
    type: 'paused',
    runId: 'run-resume',
    mediaTime: 42.5,
  });
  const delayedSystemPause = harness.observed.at(-1);
  assert.equal(delayedSystemPause.wantsPlayback, true);
  assert.equal(
    delayedSystemPause.interruptionReason,
    SPEAKER_INTERRUPTION_REASONS.SYSTEM_PAUSE,
    'a delayed native pause event must not erase the required resume action',
  );

  harness.setEngineSnapshot({ wantsPlayback: false });
  const intentionalPause = harness.controller.observePhysicalState();
  assert.equal(intentionalPause.type, 'paused');
  assert.equal(intentionalPause.interruptionReason, null);
  harness.emitEvidence({
    type: 'paused',
    runId: 'run-resume',
    mediaTime: 42.5,
  });
  const delayedIntentionalPause = harness.observed.at(-1);
  assert.equal(delayedIntentionalPause.wantsPlayback, false);
  assert.equal(delayedIntentionalPause.interruptionReason, null);
  assert.deepEqual(harness.calls, []);

  harness.setEngineSnapshot({
    status: 'playing',
    mediaPaused: false,
    wantsPlayback: true,
    position: 43,
  });
  const playing = harness.controller.observePhysicalState();
  assert.equal(playing.type, 'playing');
  assert.equal(playing.interruptionReason, null);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.observed, [
    interrupted,
    delayedSystemPause,
    intentionalPause,
    delayedIntentionalPause,
    playing,
  ]);
});
