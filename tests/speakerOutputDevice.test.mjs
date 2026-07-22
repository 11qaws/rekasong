import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SPEAKER_OUTPUT_DEVICE,
  SPEAKER_OUTPUT_DEVICE_STORAGE_KEY,
  applySpeakerOutputDevice,
  loadSpeakerOutputDevice,
  normalizeSpeakerOutputDevice,
  observeSpeakerOutputDeviceChanges,
  requestSpeakerOutputDevice,
  saveSpeakerOutputDevice,
  supportsSpeakerOutputDeviceSelection,
} from '../src/lib/speakerOutputDevice.js';

function storageHarness(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('device selection is exposed only when chooser and media sink APIs both exist', () => {
  const mediaDevices = { selectAudioOutput() {} };
  const mediaElementPrototype = { setSinkId() {} };
  assert.equal(supportsSpeakerOutputDeviceSelection({ mediaDevices, mediaElementPrototype }), true);
  assert.equal(supportsSpeakerOutputDeviceSelection({ mediaDevices, mediaElementPrototype: {} }), false);
  assert.equal(supportsSpeakerOutputDeviceSelection({ mediaDevices: {}, mediaElementPrototype }), false);
});

test('stored device preference is bounded, local, and damage tolerant', () => {
  const storage = storageHarness();
  const device = normalizeSpeakerOutputDevice({ deviceId: 'headphones-1', label: 'Desk headphones' });
  assert.equal(saveSpeakerOutputDevice(storage, device), true);
  assert.equal(storage.values.has(SPEAKER_OUTPUT_DEVICE_STORAGE_KEY), true);
  assert.deepEqual(loadSpeakerOutputDevice(storage), device);

  storage.values.set(SPEAKER_OUTPUT_DEVICE_STORAGE_KEY, '{broken');
  assert.equal(loadSpeakerOutputDevice(storage), DEFAULT_SPEAKER_OUTPUT_DEVICE);
  assert.equal(saveSpeakerOutputDevice({ setItem() { throw new Error('quota'); } }, device), false);
});

test('browser selection returns stable local data and rejects an empty result', async () => {
  assert.deepEqual(
    await requestSpeakerOutputDevice({
      async selectAudioOutput() { return { deviceId: 'speaker-2', label: 'USB speaker' }; },
    }),
    { deviceId: 'speaker-2', label: 'USB speaker' },
  );
  await assert.rejects(
    requestSpeakerOutputDevice({ async selectAudioOutput() { return { deviceId: '', label: '' }; } }),
    { code: 'speaker_output_device_invalid_selection' },
  );
});

test('applying or resetting a sink never creates transport commands', async () => {
  const calls = [];
  const media = {
    sinkId: '',
    async setSinkId(deviceId) {
      calls.push(['setSinkId', deviceId]);
      this.sinkId = deviceId;
    },
    play() { calls.push(['play']); },
    pause() { calls.push(['pause']); },
  };

  assert.deepEqual(await applySpeakerOutputDevice(media, 'speaker-3'), {
    status: 'selected',
    deviceId: 'speaker-3',
  });
  assert.deepEqual(await applySpeakerOutputDevice(media, ''), {
    status: 'default',
    deviceId: '',
  });
  assert.deepEqual(calls, [
    ['setSinkId', 'speaker-3'],
    ['setSinkId', ''],
  ]);
});

test('sink rejection stays an isolated promise failure and leaves media untouched', async () => {
  const media = {
    paused: false,
    currentTime: 42,
    src: 'blob:playing',
    async setSinkId() { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
  };
  await assert.rejects(applySpeakerOutputDevice(media, 'denied-device'), { name: 'NotAllowedError' });
  assert.equal(media.paused, false);
  assert.equal(media.currentTime, 42);
  assert.equal(media.src, 'blob:playing');
});

function mediaDevicesHarness() {
  const listeners = new Set();
  return {
    addEventListener(type, listener) {
      if (type === 'devicechange') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'devicechange') listeners.delete(listener);
    },
    emitDeviceChange() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount() { return listeners.size; },
  };
}

test('devicechange revalidates a selected sink without transport commands', async () => {
  const mediaDevices = mediaDevicesHarness();
  const calls = [];
  const monitor = observeSpeakerOutputDeviceChanges({
    mediaDevices,
    getSelectedDeviceId: () => 'usb-headphones',
    applyDevice: async (deviceId) => {
      calls.push(['setSinkId', deviceId]);
      return { status: 'selected', deviceId };
    },
  });

  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [['setSinkId', 'usb-headphones']]);
  assert.equal(mediaDevices.listenerCount(), 1);
  monitor.dispose();
  assert.equal(mediaDevices.listenerCount(), 0);
});

test('lost selected sink falls back to default and reports an actionable local failure', async () => {
  const mediaDevices = mediaDevicesHarness();
  const calls = [];
  const unavailable = [];
  const monitor = observeSpeakerOutputDeviceChanges({
    mediaDevices,
    getSelectedDeviceId: () => 'removed-bluetooth-device',
    applyDevice: async (deviceId) => {
      calls.push(['setSinkId', deviceId]);
      if (deviceId) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return { status: 'default', deviceId: '' };
    },
    onUnavailable: (result) => unavailable.push(result),
  });

  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ['setSinkId', 'removed-bluetooth-device'],
    ['setSinkId', ''],
  ]);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].deviceId, 'removed-bluetooth-device');
  monitor.dispose();
});

test('an obsolete sink failure cannot reset a newer user selection', async () => {
  const mediaDevices = mediaDevicesHarness();
  let selectedDeviceId = 'old-speaker';
  let rejectOldApply;
  const calls = [];
  const monitor = observeSpeakerOutputDeviceChanges({
    mediaDevices,
    getSelectedDeviceId: () => selectedDeviceId,
    applyDevice: (deviceId) => {
      calls.push(deviceId);
      if (deviceId === 'old-speaker') {
        return new Promise((_resolve, reject) => { rejectOldApply = reject; });
      }
      return Promise.resolve({ status: deviceId ? 'selected' : 'default', deviceId });
    },
    onUnavailable: ({ deviceId }) => selectedDeviceId === deviceId,
  });

  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));
  selectedDeviceId = 'new-headphones';
  rejectOldApply(new Error('old device removed'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['old-speaker']);
  monitor.dispose();
});

test('devicechange is idle without a selected sink and coalesces noisy transitions', async () => {
  const mediaDevices = mediaDevicesHarness();
  let selectedDeviceId = '';
  let releaseApply;
  const calls = [];
  const monitor = observeSpeakerOutputDeviceChanges({
    mediaDevices,
    getSelectedDeviceId: () => selectedDeviceId,
    applyDevice: (deviceId) => {
      calls.push(deviceId);
      return new Promise((resolve) => { releaseApply = resolve; });
    },
  });

  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);

  selectedDeviceId = 'speaker-4';
  mediaDevices.emitDeviceChange();
  mediaDevices.emitDeviceChange();
  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['speaker-4']);

  releaseApply({ status: 'selected', deviceId: 'speaker-4' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['speaker-4', 'speaker-4']);
  releaseApply({ status: 'selected', deviceId: 'speaker-4' });
  await new Promise((resolve) => setImmediate(resolve));
  monitor.dispose();
});

test('disposing a device monitor suppresses late failure callbacks', async () => {
  const mediaDevices = mediaDevicesHarness();
  let rejectApply;
  let unavailableCount = 0;
  const monitor = observeSpeakerOutputDeviceChanges({
    mediaDevices,
    getSelectedDeviceId: () => 'speaker-5',
    applyDevice: (deviceId) => {
      if (!deviceId) return Promise.resolve({ status: 'default' });
      return new Promise((_resolve, reject) => { rejectApply = reject; });
    },
    onUnavailable: () => { unavailableCount += 1; },
  });

  mediaDevices.emitDeviceChange();
  await new Promise((resolve) => setImmediate(resolve));
  monitor.dispose();
  rejectApply(new Error('late removal'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(unavailableCount, 0);
  assert.equal(mediaDevices.listenerCount(), 0);
});
