import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalSpeakerController } from '../src/lib/localSpeakerController.js';

function createHarness() {
  const calls = [];
  const resolved = [];
  let emitEvidence = null;
  const engine = {
    execute() {},
    snapshot() {
      return { status: 'ready', position: 0, duration: 0 };
    },
    load(command) {
      calls.push(['load', command]);
      return Promise.resolve({ status: 'loading' });
    },
    play(command) {
      calls.push(['play', command]);
      return Promise.resolve({ status: 'playing' });
    },
    pause(command) { calls.push(['pause', command]); return 'paused'; },
    seek(command) { calls.push(['seek', command]); return 'seeked'; },
    volume(command) { calls.push(['volume', command]); return 'volume'; },
    stop(command) { calls.push(['stop', command]); return 'stopped'; },
    dispose() { calls.push(['dispose']); },
  };
  const controller = createLocalSpeakerController({
    audio: {},
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
  });
  return { calls, controller, emitEvidence: (value) => emitEvidence(value), resolved };
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

test('prefetch remains a media optimization and does not create playback authority', async () => {
  const { calls, controller } = createHarness();
  await controller.sendCommand({ type: 'prefetch', videoIds: ['abcdefghijk'] });
  assert.deepEqual(calls, [['prefetch', ['abcdefghijk']]]);
});
