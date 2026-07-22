import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBS_RUNTIME_ATTESTATION_CODES,
  createObsRuntimeAttestation,
} from '../src/lib/obsRuntimeAttestation.js';

function createWindow(obsstudio) {
  const listeners = new Map();
  return {
    obsstudio,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, detail) {
      for (const listener of listeners.get(type) ?? []) listener({ type, detail });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test('a generic browser never claims OBS runtime or invents source state', () => {
  const runtime = createObsRuntimeAttestation({ windowObject: createWindow(undefined) });

  assert.deepEqual(runtime.capabilities, {
    obsRuntime: false,
    obsStudioBinding: false,
  });
  assert.deepEqual(runtime.runtime(), {
    streaming: false,
    streamingStatusObserved: false,
    recording: false,
  });
  assert.equal(
    runtime.snapshot().lastErrorCode,
    OBS_RUNTIME_ATTESTATION_CODES.BINDING_UNAVAILABLE,
  );
});

test('OBS callbacks and events update only the browser runtime attestation layer', () => {
  const previousActiveCalls = [];
  const obsstudio = {
    pluginVersion: '2.17.0',
    onActiveChange(value) { previousActiveCalls.push(value); },
    onVisibilityChange() {},
    getControlLevel(callback) { callback(1); },
    getStatus(callback) { callback({ streaming: true, recording: false }); },
  };
  const windowObject = createWindow(obsstudio);
  const snapshots = [];
  const runtime = createObsRuntimeAttestation({
    windowObject,
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  assert.deepEqual(runtime.runtime(), {
    streaming: true,
    streamingStatusObserved: true,
    recording: false,
    obsPluginVersion: '2.17.0',
    obsControlLevel: 'read_obs',
  });

  obsstudio.onActiveChange(true);
  windowObject.dispatch('obsSourceVisibleChanged', { visible: true });
  windowObject.dispatch('obsRecordingStarted', {});
  windowObject.dispatch('obsStreamingStopped', {});

  assert.deepEqual(runtime.runtime(), {
    sourceActive: true,
    sourceVisible: true,
    streaming: false,
    streamingStatusObserved: true,
    recording: true,
    obsPluginVersion: '2.17.0',
    obsControlLevel: 'read_obs',
  });
  assert.deepEqual(previousActiveCalls, [true]);
  assert.ok(snapshots.length >= 4);
});

test('an unavailable OBS status stays explicitly unobserved instead of inventing stream safety', () => {
  const obsstudio = {
    getControlLevel() {},
    getStatus(callback) { callback(null); },
  };
  const runtime = createObsRuntimeAttestation({ windowObject: createWindow(obsstudio) });

  assert.equal(runtime.runtime().streaming, false);
  assert.equal(runtime.runtime().streamingStatusObserved, false);
  assert.equal(
    runtime.snapshot().lastErrorCode,
    OBS_RUNTIME_ATTESTATION_CODES.STATUS_UNAVAILABLE,
  );
});

test('malformed source events fail closed instead of replaying stale true', () => {
  const obsstudio = {
    pluginVersion: 'fixture',
    getControlLevel() {},
    getStatus() {},
  };
  const windowObject = createWindow(obsstudio);
  const runtime = createObsRuntimeAttestation({ windowObject });
  obsstudio.onActiveChange(true);
  assert.equal(runtime.runtime().sourceActive, true);

  windowObject.dispatch('obsSourceActiveChanged', { active: 'unknown' });

  assert.equal(runtime.runtime().sourceActive, false);
  assert.equal(
    runtime.snapshot().lastErrorCode,
    OBS_RUNTIME_ATTESTATION_CODES.INVALID_SOURCE_EVENT,
  );
});

test('dispose removes listeners and restores legacy callbacks without late mutation', () => {
  const previousActive = () => {};
  const previousVisible = () => {};
  const obsstudio = {
    onActiveChange: previousActive,
    onVisibilityChange: previousVisible,
    getControlLevel(callback) { this.controlCallback = callback; },
    getStatus(callback) { this.statusCallback = callback; },
  };
  const windowObject = createWindow(obsstudio);
  const runtime = createObsRuntimeAttestation({ windowObject });
  assert.equal(windowObject.listenerCount('obsSourceActiveChanged'), 1);

  runtime.dispose();
  obsstudio.controlCallback(5);
  obsstudio.statusCallback({ streaming: true, recording: true });
  windowObject.dispatch('obsSourceActiveChanged', { active: true });

  assert.equal(windowObject.listenerCount('obsSourceActiveChanged'), 0);
  assert.equal(obsstudio.onActiveChange, previousActive);
  assert.equal(obsstudio.onVisibilityChange, previousVisible);
  assert.equal(Object.hasOwn(runtime.runtime(), 'sourceActive'), false);
  assert.equal(runtime.runtime().streaming, false);
});
