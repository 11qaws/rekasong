import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SPEAKER_OUTPUT_DEVICE,
  SPEAKER_OUTPUT_DEVICE_STORAGE_KEY,
  applySpeakerOutputDevice,
  loadSpeakerOutputDevice,
  normalizeSpeakerOutputDevice,
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
