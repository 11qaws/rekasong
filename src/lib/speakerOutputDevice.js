export const SPEAKER_OUTPUT_DEVICE_STORAGE_KEY = 'rekasong.speaker-output-device.v1';

const DEVICE_ID_MAX_LENGTH = 512;
const DEVICE_LABEL_MAX_LENGTH = 256;

export const DEFAULT_SPEAKER_OUTPUT_DEVICE = Object.freeze({
  deviceId: '',
  label: '',
});

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

export function normalizeSpeakerOutputDevice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SPEAKER_OUTPUT_DEVICE;
  }
  const deviceId = boundedString(value.deviceId, DEVICE_ID_MAX_LENGTH);
  if (!deviceId) return DEFAULT_SPEAKER_OUTPUT_DEVICE;
  return Object.freeze({
    deviceId,
    label: boundedString(value.label, DEVICE_LABEL_MAX_LENGTH),
  });
}

export function loadSpeakerOutputDevice(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return DEFAULT_SPEAKER_OUTPUT_DEVICE;
  }
  try {
    const raw = storage.getItem(SPEAKER_OUTPUT_DEVICE_STORAGE_KEY);
    return raw ? normalizeSpeakerOutputDevice(JSON.parse(raw)) : DEFAULT_SPEAKER_OUTPUT_DEVICE;
  } catch {
    return DEFAULT_SPEAKER_OUTPUT_DEVICE;
  }
}

export function saveSpeakerOutputDevice(storage, device) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(
      SPEAKER_OUTPUT_DEVICE_STORAGE_KEY,
      JSON.stringify(normalizeSpeakerOutputDevice(device)),
    );
    return true;
  } catch {
    return false;
  }
}

export function supportsSpeakerOutputDeviceSelection({
  mediaDevices,
  mediaElementPrototype,
} = {}) {
  return Boolean(
    mediaDevices
    && typeof mediaDevices.selectAudioOutput === 'function'
    && mediaElementPrototype
    && typeof mediaElementPrototype.setSinkId === 'function'
  );
}

export async function requestSpeakerOutputDevice(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.selectAudioOutput !== 'function') {
    throw Object.assign(new Error('speaker_output_device_unsupported'), {
      code: 'speaker_output_device_unsupported',
    });
  }
  const selected = await mediaDevices.selectAudioOutput();
  const normalized = normalizeSpeakerOutputDevice(selected);
  if (!normalized.deviceId) {
    throw Object.assign(new Error('speaker_output_device_invalid_selection'), {
      code: 'speaker_output_device_invalid_selection',
    });
  }
  return normalized;
}

export async function applySpeakerOutputDevice(mediaTarget, deviceId = '') {
  if (!mediaTarget || typeof mediaTarget.setSinkId !== 'function') {
    throw Object.assign(new Error('speaker_output_device_unsupported'), {
      code: 'speaker_output_device_unsupported',
    });
  }
  const normalizedDeviceId = boundedString(deviceId, DEVICE_ID_MAX_LENGTH);
  await mediaTarget.setSinkId(normalizedDeviceId);
  if (typeof mediaTarget.sinkId === 'string' && mediaTarget.sinkId !== normalizedDeviceId) {
    throw Object.assign(new Error('speaker_output_device_postcondition_failed'), {
      code: 'speaker_output_device_postcondition_failed',
    });
  }
  return Object.freeze({
    status: normalizedDeviceId ? 'selected' : 'default',
    deviceId: normalizedDeviceId,
  });
}
