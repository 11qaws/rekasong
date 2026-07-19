import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYBACK_ENGINE_CODES,
  PLAYBACK_EVIDENCE_TYPES,
  PlaybackEngine,
  PlaybackEngineError,
} from '../src/lib/playbackEngine.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.listenerHistory = new Map();
    this.attributes = new Map();
    this.srcObject = null;
    this.sourceChildren = [];
    this._currentSrc = '';
    this.networkState = 0;
    this.autoplay = true;
    this.paused = true;
    this._currentTime = 0;
    this.currentTimeImplementation = null;
    this.duration = 180;
    this.volume = 1;
    this.readyState = 0;
    this.seeking = false;
    this.ended = false;
    this.error = null;
    this.loadCalls = 0;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.playImplementation = null;
    this.pauseImplementation = null;
    this.loadImplementation = null;
  }

  get src() {
    return this.attributes.get('src') ?? '';
  }

  set src(value) {
    this.attributes.set('src', value);
  }

  get currentSrc() {
    return this._currentSrc;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    if (this.currentTimeImplementation) {
      this.currentTimeImplementation(value);
      return;
    }
    this._currentTime = value;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector(selector) {
    if (selector !== 'source') return null;
    return this.sourceChildren[0] ?? null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    if (!this.listenerHistory.has(type)) this.listenerHistory.set(type, []);
    this.listenerHistory.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    const event = { type, target: this, currentTarget: this };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  dispatchHistorical(type, index) {
    const listener = this.listenerHistory.get(type)?.[index];
    assert.equal(typeof listener, 'function');
    listener({ type, target: this, currentTarget: this });
  }

  load() {
    this.loadCalls += 1;
    this.loadImplementation?.();
    this.paused = true;
    if (this.srcObject !== null) {
      this._currentSrc = '';
      this.networkState = 2;
    } else if (this.attributes.has('src')) {
      this._currentSrc = this.attributes.get('src');
      this.networkState = 2;
    } else if (this.sourceChildren[0]?.src) {
      this._currentSrc = this.sourceChildren[0].src;
      this.networkState = 2;
    } else {
      // Chromium may retain currentSrc as a historical URL after the active
      // resource is gone. networkState is the authoritative active-source bit.
      this.networkState = 0;
    }
  }

  pause() {
    this.pauseCalls += 1;
    if (this.pauseImplementation) return this.pauseImplementation();
    this.paused = true;
    this.dispatch('pause');
  }

  play() {
    this.playCalls += 1;
    if (this.playImplementation) return this.playImplementation();
    this.paused = false;
    this.dispatch('playing');
    return Promise.resolve();
  }
}

function createFixture(overrides = {}) {
  const audio = overrides.audio ?? new FakeAudio();
  const evidence = [];
  const created = [];
  const revoked = [];
  const clock = overrides.clock ?? {
    value: 100,
    now() {
      this.value += 5;
      return this.value;
    },
  };
  const urlApi = overrides.urlApi ?? {
    createObjectURL(blob) {
      const url = `blob:fixture-${created.length + 1}`;
      created.push({ blob, url });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  const engine = new PlaybackEngine({
    audio,
    clock,
    urlApi,
    onEvidence: (event) => evidence.push(event),
    instrumentation: overrides.instrumentation,
    onInstrumentationError: overrides.onInstrumentationError,
    commandHistoryLimit: overrides.commandHistoryLimit,
    criticalCommandHistoryLimit: overrides.criticalCommandHistoryLimit,
  });
  return { audio, evidence, created, revoked, engine, clock, urlApi };
}

function assertEngineError(error, code, detail = {}) {
  assert.equal(error instanceof PlaybackEngineError, true);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.deepEqual(error.detail, { ...error.detail, ...detail });
  return true;
}

test('load attaches a URL, applies setup, and never autoplays before or after readiness', async () => {
  const { audio, engine, evidence } = createFixture();
  const result = await engine.load({
    commandId: 'load-1',
    runId: 'run-1',
    source: { kind: 'url', url: 'https://media.example/one.mp3' },
    position: 12.5,
    volume: 75,
  });

  assert.equal(result.status, 'applied');
  assert.deepEqual(result.postcondition, {
    sourceAttached: true,
    autoplayStarted: false,
    mediaPaused: true,
    initialSeekPending: true,
  });
  assert.equal(audio.autoplay, false);
  assert.equal(audio.src, 'https://media.example/one.mp3');
  assert.equal(audio.volume, 0.75);
  assert.equal(audio.loadCalls, 1);
  assert.equal(audio.playCalls, 0);

  audio.dispatch('loadedmetadata');
  audio.readyState = 4;
  audio.dispatch('canplay');
  assert.equal(evidence.length, 0);
  audio.dispatch('seeked');
  audio.dispatch('canplay');
  assert.equal(audio.currentTime, 12.5);
  assert.equal(audio.playCalls, 0);
  assert.deepEqual(evidence.map(({ type }) => type), [
    PLAYBACK_EVIDENCE_TYPES.POSITION,
    PLAYBACK_EVIDENCE_TYPES.READY,
  ]);
  assert.equal(evidence.at(-1).runId, 'run-1');
  assert.equal(evidence.at(-1).generation, 1);
  assert.equal(evidence.at(-1).monotonicTimeMs, 115);
});

test('load fails closed when the media element has srcObject or source children', async () => {
  for (const ownership of ['srcObject', 'sourceChild']) {
    const audio = new FakeAudio();
    if (ownership === 'srcObject') audio.srcObject = { kind: 'foreign-stream' };
    if (ownership === 'sourceChild') audio.sourceChildren.push({ src: 'foreign.mp3' });
    const { engine } = createFixture({ audio });

    await assert.rejects(
      engine.load({
        commandId: `ownership-${ownership}`,
        runId: `run-${ownership}`,
        source: 'https://media.example/owned.mp3',
      }),
      (error) => assertEngineError(
        error,
        PLAYBACK_ENGINE_CODES.MEDIA_OWNERSHIP_CONFLICT,
        ownership === 'srcObject'
          ? { srcObjectPresent: true, sourceChildPresent: false }
          : { srcObjectPresent: false, sourceChildPresent: true },
      ),
    );
    assert.equal(audio.paused, true);
    assert.equal(audio.getAttribute('src'), null);
  }
});

test('emergency stop clears an injected srcObject and rejects unverifiable child-source detach', async () => {
  {
    const { audio, engine } = createFixture();
    await engine.load({
      commandId: 'load-src-object-injection',
      runId: 'run-src-object-injection',
      source: 'https://media.example/owned.mp3',
    });
    audio.srcObject = { kind: 'late-stream' };
    const result = await engine.emergencyStop({ commandId: 'emergency-src-object-injection' });
    assert.equal(audio.srcObject, null);
    assert.equal(audio.networkState, 0);
    assert.equal(result.postcondition.currentSrcDetached, true);
    assert.equal(result.postcondition.sourceDetached, true);
  }

  {
    const { audio, engine } = createFixture();
    await engine.load({
      commandId: 'load-child-injection',
      runId: 'run-child-injection',
      source: 'https://media.example/owned.mp3',
    });
    audio.sourceChildren.push({ src: 'fallback.mp3' });
    await assert.rejects(
      engine.emergencyStop({ commandId: 'emergency-child-injection' }),
      (error) => assertEngineError(
        error,
        PLAYBACK_ENGINE_CODES.DETACH_POSTCONDITION_FAILED,
        {
          action: 'emergency_stop',
          sourceDetached: false,
          sourceChildrenDetached: false,
          currentSrcDetached: false,
        },
      ),
    );
    assert.equal(audio.paused, true);
    assert.equal(audio.currentSrc, 'fallback.mp3');
    assert.equal(engine.snapshot().status, 'error');
  }
});

test('emergency stop rejects when load cannot prove physical detachment', async () => {
  const { audio, engine } = createFixture();
  await engine.load({
    commandId: 'load-detach-failure',
    runId: 'run-detach-failure',
    source: 'https://media.example/detach-failure.mp3',
  });
  audio.loadImplementation = () => {
    throw Object.assign(new Error('fixture'), { name: 'InvalidStateError' });
  };

  await assert.rejects(
    engine.emergencyStop({ commandId: 'emergency-detach-failure' }),
    (error) => assertEngineError(
      error,
      PLAYBACK_ENGINE_CODES.DETACH_POSTCONDITION_FAILED,
      {
        action: 'emergency_stop',
        loadCalled: false,
        currentSrcDetached: false,
      },
    ),
  );
  assert.equal(engine.snapshot().status, 'error');
});

test('initial seek gates play and ready until canplay and seeked are both proven', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-seek-gate',
    runId: 'run-seek-gate',
    source: 'https://media.example/seek-gate.mp3',
    position: 30,
  });
  audio.dispatch('loadedmetadata');
  audio.readyState = 4;
  audio.dispatch('canplay');

  assert.equal(evidence.some(({ type }) => type === PLAYBACK_EVIDENCE_TYPES.READY), false);
  await assert.rejects(
    engine.play({ commandId: 'play-before-initial-seek', runId: 'run-seek-gate' }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.INITIAL_SEEK_PENDING, {
      state: 'waiting_seeked',
    }),
  );

  audio.dispatch('seeked');
  assert.equal(evidence.filter(({ type }) => type === PLAYBACK_EVIDENCE_TYPES.READY).length, 1);
  assert.equal(engine.snapshot().initialSeekState, 'complete');
  assert.equal(
    (await engine.play({ commandId: 'play-after-initial-seek', runId: 'run-seek-gate' })).status,
    'applied',
  );
});

test('initial seek also becomes ready when seeked arrives before canplay', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-seek-first',
    runId: 'run-seek-first',
    source: 'https://media.example/seek-first.mp3',
    position: 12,
  });
  audio.dispatch('loadedmetadata');
  audio.dispatch('seeked');
  assert.equal(evidence.some(({ type }) => type === PLAYBACK_EVIDENCE_TYPES.READY), false);

  audio.readyState = 4;
  audio.dispatch('canplay');
  assert.equal(evidence.filter(({ type }) => type === PLAYBACK_EVIDENCE_TYPES.READY).length, 1);
  assert.equal(engine.snapshot().initialSeekState, 'complete');
});

test('failed initial seek remains failed after canplay and refuses play', async () => {
  const audio = new FakeAudio();
  audio.currentTimeImplementation = () => {
    throw Object.assign(new Error('localized fixture'), { name: 'InvalidStateError' });
  };
  const { engine, evidence } = createFixture({ audio });
  await engine.load({
    commandId: 'load-seek-failure',
    runId: 'run-seek-failure',
    source: 'https://media.example/seek-failure.mp3',
    position: 9,
  });
  audio.dispatch('loadedmetadata');
  audio.readyState = 4;
  audio.dispatch('canplay');

  assert.equal(engine.snapshot().status, 'error');
  assert.equal(engine.snapshot().initialSeekState, 'failed');
  assert.equal(evidence.some(({ type }) => type === PLAYBACK_EVIDENCE_TYPES.READY), false);
  assert.equal(evidence.at(-1).code, PLAYBACK_ENGINE_CODES.INITIAL_SEEK_FAILED);
  assert.deepEqual(evidence.at(-1).detail, {
    reason: 'assignment_failed',
    causeName: 'InvalidStateError',
  });
  await assert.rejects(
    engine.play({ commandId: 'play-after-seek-failure', runId: 'run-seek-failure' }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.INITIAL_SEEK_FAILED),
  );
});

test('all media evidence is physical-event driven and carries stable run identity', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-evidence',
    runId: 'run-evidence',
    source: 'https://media.example/evidence.mp3',
  });

  audio.readyState = 4;
  audio.dispatch('canplay');
  await engine.play({ commandId: 'play-evidence', runId: 'run-evidence' });
  audio.readyState = 1;
  audio.dispatch('waiting');
  await engine.pause({ commandId: 'pause-evidence', runId: 'run-evidence' });
  audio.currentTime = 42;
  audio.dispatch('timeupdate');
  audio.ended = true;
  audio.dispatch('ended');
  audio.error = { code: 3 };
  audio.dispatch('error');

  assert.deepEqual(evidence.map(({ type }) => type), [
    'ready',
    'playing',
    'buffering',
    'paused',
    'position',
    'ended',
    'error',
  ]);
  for (const event of evidence) {
    assert.equal(event.runId, 'run-evidence');
    assert.equal(event.generation, 1);
    assert.equal(typeof event.monotonicTimeMs, 'number');
  }
  assert.equal(evidence.at(-1).code, 'media_error');
  assert.deepEqual(evidence.at(-1).detail, { mediaErrorCode: 3 });
});

test('same command ID is exactly idempotent while a different command conflicts', async () => {
  const { audio, engine } = createFixture();
  let sourceFactoryCalls = 0;
  const sourceFactory = async () => {
    sourceFactoryCalls += 1;
    return 'https://media.example/idempotent.mp3';
  };
  const command = {
    commandId: 'load-idempotent',
    runId: 'run-idempotent',
    sourceFactory,
    position: 0,
    volume: 100,
  };

  const first = engine.load(command);
  const retry = engine.load({ ...command });
  assert.equal(retry, first);
  assert.equal((await retry).status, 'applied');
  assert.equal(sourceFactoryCalls, 1);
  assert.equal(audio.loadCalls, 1);

  assert.throws(
    () => engine.play({ commandId: 'load-idempotent', runId: 'run-idempotent' }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.COMMAND_ID_CONFLICT, {
      previousType: 'load',
      receivedType: 'play',
    }),
  );
});

test('a late cancelled play cannot pause a newer play intent on the same run', async () => {
  const { audio, engine } = createFixture();
  await engine.load({
    commandId: 'load-play-intent',
    runId: 'run-play-intent',
    source: 'https://media.example/play-intent.mp3',
  });
  const firstPlay = deferred();
  let playCalls = 0;
  audio.playImplementation = () => {
    playCalls += 1;
    if (playCalls === 1) return firstPlay.promise;
    audio.paused = false;
    return Promise.resolve();
  };

  const staleResultPromise = engine.play({ commandId: 'play-old', runId: 'run-play-intent' });
  await engine.play({ commandId: 'play-new', runId: 'run-play-intent' });
  const pauseCallsBeforeStaleResolution = audio.pauseCalls;
  firstPlay.resolve();
  const staleResult = await staleResultPromise;

  assert.equal(staleResult.status, 'cancelled');
  assert.equal(audio.paused, false);
  assert.equal(audio.pauseCalls, pauseCallsBeforeStaleResolution);
  assert.equal(engine.snapshot().wantsPlayback, true);
});

test('queued pause, ended, and waiting events cannot overwrite a newer play intent', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-event-intent',
    runId: 'run-event-intent',
    source: 'https://media.example/event-intent.mp3',
  });
  audio.readyState = 4;
  audio.dispatch('canplay');
  await engine.play({ commandId: 'play-before-pause', runId: 'run-event-intent' });
  await engine.pause({ commandId: 'pause-intent', runId: 'run-event-intent' });
  await engine.play({ commandId: 'play-newest', runId: 'run-event-intent' });

  const evidenceCount = evidence.length;
  assert.equal(audio.paused, false);
  audio.dispatch('pause');
  audio.dispatch('ended');
  audio.dispatch('waiting');

  assert.equal(evidence.length, evidenceCount);
  assert.equal(engine.snapshot().status, PLAYBACK_EVIDENCE_TYPES.PLAYING);
  assert.equal(engine.snapshot().wantsPlayback, true);
  assert.equal(audio.paused, false);
});

test('cancelled play settles immediately even when the native play promise never settles', async () => {
  const { audio, engine } = createFixture({ commandHistoryLimit: 2 });
  await engine.load({
    commandId: 'load-never-play',
    runId: 'run-never-play',
    source: 'https://media.example/never-play.mp3',
  });
  audio.playImplementation = () => new Promise(() => {});

  const plays = [];
  for (let index = 0; index < 8; index += 1) {
    plays.push(engine.play({ commandId: `never-play-${index}`, runId: 'run-never-play' }));
  }
  await engine.emergencyStop({ commandId: 'never-play-emergency' });
  const results = await Promise.all(plays);
  assert.equal(results.every(({ status }) => status === 'cancelled'), true);
  await Promise.resolve();
  assert.equal(engine.commandEntries.size <= 2, true);
  assert.equal(engine.snapshot().pendingPlay, false);
  assert.equal(engine.snapshot().sourceAttached, false);
});

test('late rejection from an already-cancelled native play is consumed', async () => {
  const { audio, engine } = createFixture();
  const nativePlay = deferred();
  audio.playImplementation = () => nativePlay.promise;
  await engine.load({
    commandId: 'load-late-play-rejection',
    runId: 'run-late-play-rejection',
    source: 'https://media.example/late-play-rejection.mp3',
  });
  const play = engine.play({
    commandId: 'play-late-rejection',
    runId: 'run-late-play-rejection',
  });
  await engine.pause({ commandId: 'pause-late-rejection', runId: 'run-late-play-rejection' });
  assert.equal((await play).status, 'cancelled');

  nativePlay.reject(Object.assign(new Error('late'), { name: 'AbortError' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(engine.snapshot().status, 'paused');
  assert.equal(engine.snapshot().wantsPlayback, false);
});

test('terminal command history is bounded for long broadcast sessions', async () => {
  const { engine } = createFixture({ commandHistoryLimit: 2 });
  await engine.load({
    commandId: 'bounded-load',
    runId: 'bounded-run',
    source: 'https://media.example/bounded.mp3',
  });
  await engine.volume({ commandId: 'bounded-volume-1', runId: 'bounded-run', volume: 90 });
  await engine.volume({ commandId: 'bounded-volume-2', runId: 'bounded-run', volume: 80 });
  await Promise.resolve();

  assert.equal(engine.commandEntries.size, 2);
  assert.equal(engine.commandEntries.has('bounded-load'), false);
  assert.equal(engine.commandEntries.has('bounded-volume-1'), true);
  assert.equal(engine.commandEntries.has('bounded-volume-2'), true);
});

test('emergency command tombstones survive ordinary LRU eviction and protect later runs', async () => {
  const { engine } = createFixture({
    commandHistoryLimit: 1,
    criticalCommandHistoryLimit: 2,
  });
  await engine.load({ commandId: 'critical-load-1', runId: 'critical-run-1', source: 'one.mp3' });
  const firstEmergency = engine.emergencyStop({ commandId: 'critical-emergency-1' });
  const firstResult = await firstEmergency;
  await engine.load({ commandId: 'critical-load-2', runId: 'critical-run-2', source: 'two.mp3' });

  const retry = engine.emergencyStop({ commandId: 'critical-emergency-1' });
  assert.equal(retry, firstEmergency);
  assert.equal((await retry).runId, firstResult.runId);
  assert.equal(engine.snapshot().runId, 'critical-run-2');

  assert.throws(
    () => engine.emergencyStop({
      commandId: 'critical-emergency-1',
      runId: 'critical-run-2',
    }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.COMMAND_ID_CONFLICT),
  );
  assert.equal(engine.snapshot().runId, 'critical-run-2');

  await engine.emergencyStop({ commandId: 'critical-emergency-2' });
  await engine.load({ commandId: 'critical-load-3', runId: 'critical-run-3', source: 'three.mp3' });
  assert.throws(
    () => engine.emergencyStop({ commandId: 'critical-emergency-over-limit' }),
    (error) => assertEngineError(
      error,
      PLAYBACK_ENGINE_CODES.CRITICAL_COMMAND_LIMIT_REACHED,
      { limit: 2, safetyLocked: true, sourceDetached: true, mediaPaused: true },
    ),
  );
  assert.equal(engine.snapshot().runId, null);
  assert.equal(engine.snapshot().sourceAttached, false);
  assert.equal(engine.snapshot().disposed, true);
  assert.equal(engine.criticalCommandEntries.size, 2);
});

test('a later load fences an unresolved source and does not create a stale object URL', async () => {
  const { audio, engine, created } = createFixture();
  const slowSource = deferred();
  const slowLoad = engine.load({
    commandId: 'load-slow',
    runId: 'run-slow',
    sourceFactory: () => slowSource.promise,
  });
  const fastLoad = engine.load({
    commandId: 'load-fast',
    runId: 'run-fast',
    source: 'https://media.example/fast.mp3',
  });

  assert.equal((await fastLoad).status, 'applied');
  slowSource.resolve({ kind: 'blob', blob: { fixture: 'stale' } });
  assert.equal((await slowLoad).status, 'superseded');
  assert.equal(audio.src, 'https://media.example/fast.mp3');
  assert.equal(created.length, 0);
  assert.equal(audio.playCalls, 0);
});

test('a replacement load aborts sourceFactory and settles the superseded command immediately', async () => {
  const { audio, engine, created } = createFixture();
  const never = new Promise(() => {});
  let signal;
  const slowLoad = engine.load({
    commandId: 'load-abort-slow',
    runId: 'run-abort-slow',
    sourceFactory: (context) => {
      signal = context.signal;
      return never;
    },
  });
  const fastLoad = engine.load({
    commandId: 'load-abort-fast',
    runId: 'run-abort-fast',
    source: 'https://media.example/abort-fast.mp3',
  });

  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, true);
  assert.equal((await slowLoad).status, 'superseded');
  assert.equal((await fastLoad).status, 'applied');
  assert.equal(audio.src, 'https://media.example/abort-fast.mp3');
  assert.equal(created.length, 0);
});

test('stop, emergency, detach, and dispose all abort pending source resolution', async () => {
  for (const terminator of ['stop', 'emergency', 'detach', 'dispose']) {
    const { engine } = createFixture();
    let signal;
    const pendingLoad = engine.load({
      commandId: `load-abort-${terminator}`,
      runId: `run-abort-${terminator}`,
      sourceFactory: (context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });

    if (terminator === 'stop') {
      await engine.stop({ commandId: 'terminate-stop', runId: 'run-abort-stop' });
    } else if (terminator === 'emergency') {
      await engine.emergencyStop({ commandId: 'terminate-emergency' });
    } else if (terminator === 'detach') {
      await engine.detach({ commandId: 'terminate-detach', runId: 'run-abort-detach' });
    } else {
      engine.dispose();
    }

    assert.equal(signal.aborted, true, terminator);
    assert.equal((await pendingLoad).status, 'superseded', terminator);
  }
});

test('historical listeners cannot relabel a new run with late media events', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-old',
    runId: 'run-old',
    source: 'https://media.example/old.mp3',
  });
  await engine.load({
    commandId: 'load-new',
    runId: 'run-new',
    source: 'https://media.example/new.mp3',
  });

  audio.paused = false;
  audio.dispatchHistorical('playing', 0);
  assert.equal(evidence.length, 0);
  audio.dispatch('playing');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].runId, 'run-new');
  assert.equal(evidence[0].generation, 2);
});

test('emergency stop cancels pending play and enforces pause, detach, load, and revoke', async () => {
  const { audio, engine, created, revoked, evidence } = createFixture();
  const blob = { fixture: 'broadcast-audio' };
  await engine.load({
    commandId: 'load-emergency',
    runId: 'run-emergency',
    source: { kind: 'blob', blob },
  });
  assert.equal(created.length, 1);
  assert.equal(audio.src, 'blob:fixture-1');

  const pending = deferred();
  audio.playImplementation = () => pending.promise;
  const playResult = engine.play({
    commandId: 'play-pending',
    runId: 'run-emergency',
  });
  const emergency = engine.emergencyStop({ commandId: 'emergency-1' });
  const emergencyResult = await emergency;

  assert.deepEqual(emergencyResult.postcondition, {
    mediaPaused: true,
    sourceDetached: true,
    srcAttributeDetached: true,
    srcObjectDetached: true,
    sourceChildrenDetached: true,
    currentSrcDetached: true,
    networkDetached: true,
    autoplayCancelled: true,
    pauseCalled: true,
    loadCalled: true,
    objectUrlReleased: true,
  });
  assert.equal(audio.getAttribute('src'), null);
  assert.deepEqual(revoked, ['blob:fixture-1']);
  assert.equal(engine.snapshot().runId, null);

  // Model a hostile late play resolution that flips the element back to playing.
  audio.paused = false;
  pending.resolve();
  const cancelled = await playResult;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.postcondition.mediaPaused, true);
  assert.equal(audio.paused, true);
  assert.equal(evidence.filter(({ type }) => type === 'playing').length, 0);
});

test('stop is idempotent and does not repeat physical teardown for a retry', async () => {
  const { audio, engine } = createFixture();
  await engine.load({
    commandId: 'load-stop',
    runId: 'run-stop',
    source: 'https://media.example/stop.mp3',
  });
  const beforeStopLoads = audio.loadCalls;
  const command = { commandId: 'stop-1', runId: 'run-stop' };
  const first = engine.stop(command);
  const retry = engine.stop({ ...command });

  assert.equal(retry, first);
  assert.equal((await first).postcondition.sourceDetached, true);
  assert.equal(audio.loadCalls, beforeStopLoads + 1);
  assert.equal(audio.getAttribute('src'), null);
});

test('owned object URLs are revoked exactly once on replacement and detach', async () => {
  const { engine, revoked } = createFixture();
  await engine.load({
    commandId: 'load-blob-1',
    runId: 'run-blob-1',
    source: { kind: 'blob', blob: { id: 1 } },
  });
  await engine.load({
    commandId: 'load-blob-2',
    runId: 'run-blob-2',
    source: { kind: 'blob', blob: { id: 2 } },
  });
  assert.deepEqual(revoked, ['blob:fixture-1']);

  const detach = engine.detach({ commandId: 'detach-blob-2', runId: 'run-blob-2' });
  const retry = engine.detach({ commandId: 'detach-blob-2', runId: 'run-blob-2' });
  assert.equal(retry, detach);
  assert.equal((await detach).postcondition.objectUrlReleased, true);
  assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2']);
});

test('a source attachment failure revokes its newly-created object URL', async () => {
  const audio = new FakeAudio();
  audio.loadImplementation = () => {
    throw Object.assign(new Error('fixture'), { name: 'NotSupportedError' });
  };
  const { engine, revoked, evidence } = createFixture({ audio });

  await assert.rejects(
    engine.load({
      commandId: 'load-attach-failure',
      runId: 'run-attach-failure',
      source: { kind: 'blob', blob: { id: 'broken' } },
    }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.SOURCE_ATTACH_FAILED, {
      causeName: 'NotSupportedError',
    }),
  );
  assert.deepEqual(revoked, ['blob:fixture-1']);
  assert.equal(audio.getAttribute('src'), null);
  assert.equal(engine.snapshot().sourceAttached, false);
  assert.equal(evidence.at(-1).code, PLAYBACK_ENGINE_CODES.SOURCE_ATTACH_FAILED);
});

test('play rejection is stable data and never leaks a localized exception message', async () => {
  const { audio, engine, evidence } = createFixture();
  await engine.load({
    commandId: 'load-reject',
    runId: 'run-reject',
    source: 'https://media.example/reject.mp3',
  });
  audio.playImplementation = () => Promise.reject(
    Object.assign(new Error('translated browser text must not escape'), { name: 'NotAllowedError' }),
  );

  await assert.rejects(
    engine.play({ commandId: 'play-reject', runId: 'run-reject' }),
    (error) => {
      assertEngineError(error, PLAYBACK_ENGINE_CODES.PLAY_REJECTED, {
        causeName: 'NotAllowedError',
        mediaErrorCode: null,
      });
      assert.equal(JSON.stringify(error.detail).includes('translated browser text'), false);
      return true;
    },
  );
  assert.equal(evidence.at(-1).type, 'error');
  assert.equal(evidence.at(-1).code, PLAYBACK_ENGINE_CODES.PLAY_REJECTED);
});

test('play and pause reject when their physical postconditions are false', async () => {
  {
    const { audio, engine, evidence } = createFixture();
    await engine.load({
      commandId: 'load-play-postcondition',
      runId: 'run-play-postcondition',
      source: 'https://media.example/play-postcondition.mp3',
    });
    audio.playImplementation = () => Promise.resolve();
    await assert.rejects(
      engine.play({ commandId: 'play-false-postcondition', runId: 'run-play-postcondition' }),
      (error) => assertEngineError(
        error,
        PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
        { action: 'play', mediaPaused: true },
      ),
    );
    assert.equal(evidence.at(-1).code, PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED);
  }

  {
    const { audio, engine, evidence } = createFixture();
    await engine.load({
      commandId: 'load-pause-postcondition',
      runId: 'run-pause-postcondition',
      source: 'https://media.example/pause-postcondition.mp3',
    });
    await engine.play({ commandId: 'play-before-broken-pause', runId: 'run-pause-postcondition' });
    audio.pauseImplementation = () => {};
    await assert.rejects(
      engine.pause({ commandId: 'pause-false-postcondition', runId: 'run-pause-postcondition' }),
      (error) => assertEngineError(
        error,
        PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
        { action: 'pause', mediaPaused: false },
      ),
    );
    assert.equal(evidence.at(-1).code, PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED);
  }
});

test('run identity and numeric ranges fail closed before mutating media', async () => {
  const { audio, engine } = createFixture();
  await engine.load({
    commandId: 'load-validation',
    runId: 'run-validation',
    source: 'https://media.example/validation.mp3',
  });
  const sourceBefore = audio.src;

  assert.throws(
    () => engine.seek({ commandId: 'seek-negative', runId: 'run-validation', position: -1 }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.INVALID_POSITION, { min: 0 }),
  );
  assert.throws(
    () => engine.volume({ commandId: 'volume-high', runId: 'run-validation', volume: 101 }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.INVALID_VOLUME, { min: 0, max: 100 }),
  );
  await assert.rejects(
    engine.pause({ commandId: 'pause-stale', runId: 'run-other' }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.STALE_RUN_IDENTITY, {
      expectedRunId: 'run-validation',
      receivedRunId: 'run-other',
    }),
  );
  assert.equal(audio.src, sourceBefore);
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.volume, 1);
});

test('instrumentation hooks expose source and evidence lifecycle without owning transport', async () => {
  const calls = [];
  const instrumentation = {
    onSourceAttached: ({ runId, generation, sourceKind }) => {
      calls.push(['attached', runId, generation, sourceKind]);
    },
    onEvidence: ({ type, runId }) => calls.push(['evidence', type, runId]),
    onSourceDetached: ({ runId, generation, reason }) => {
      calls.push(['detached', runId, generation, reason]);
    },
  };
  const { audio, engine } = createFixture({ instrumentation });
  await engine.load({
    commandId: 'load-hooks',
    runId: 'run-hooks',
    source: 'https://media.example/hooks.mp3',
  });
  audio.readyState = 4;
  audio.dispatch('canplay');
  await engine.detach({ commandId: 'detach-hooks', runId: 'run-hooks' });

  assert.deepEqual(calls, [
    ['attached', 'run-hooks', 1, 'url'],
    ['evidence', 'ready', 'run-hooks'],
    ['detached', 'run-hooks', 2, 'detach'],
  ]);
});

test('observer failures are reported, async rejections are consumed, and sync re-entry is blocked', async () => {
  const reports = [];
  let engine;
  const instrumentation = {
    onSourceAttached: () => Promise.reject(
      Object.assign(new Error('adapter localized failure'), { name: 'AdapterAsyncError' }),
    ),
    onEvidence: () => {
      engine.emergencyStop({ commandId: 'observer-reentry-emergency' });
    },
  };
  const fixture = createFixture({
    instrumentation,
    onInstrumentationError: (report) => reports.push(report),
  });
  ({ engine } = fixture);
  const result = await engine.load({
    commandId: 'load-observer-errors',
    runId: 'run-observer-errors',
    source: 'https://media.example/observer-errors.mp3',
  });
  fixture.audio.readyState = 4;
  fixture.audio.dispatch('canplay');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(result.status, 'applied');
  assert.equal(engine.snapshot().runId, 'run-observer-errors');
  assert.equal(engine.snapshot().sourceAttached, true);
  const normalizedReports = reports
    .map(({ hook, causeName, callbackCode }) => ({ hook, causeName, callbackCode }))
    .sort((left, right) => left.hook.localeCompare(right.hook));
  assert.deepEqual(
    normalizedReports,
    [
      {
        hook: 'instrumentation.onEvidence',
        causeName: 'PlaybackEngineError',
        callbackCode: PLAYBACK_ENGINE_CODES.OBSERVER_REENTRY,
      },
      {
        hook: 'instrumentation.onSourceAttached',
        causeName: 'AdapterAsyncError',
        callbackCode: null,
      },
    ],
  );
});

test('dispose is repeatable and releases the final source without another command', async () => {
  const { engine, revoked } = createFixture();
  await engine.load({
    commandId: 'load-dispose',
    runId: 'run-dispose',
    source: { kind: 'blob', blob: { id: 'dispose' } },
  });
  const first = engine.dispose();
  const second = engine.dispose();

  assert.equal(first.sourceDetached, true);
  assert.equal(second.sourceDetached, true);
  assert.deepEqual(revoked, ['blob:fixture-1']);
  assert.throws(
    () => engine.emergencyStop({ commandId: 'after-dispose' }),
    (error) => assertEngineError(error, PLAYBACK_ENGINE_CODES.ENGINE_DISPOSED),
  );
});
