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

/**
 * Revalidates the selected Speaker sink only when the operating system reports
 * that its audio-device list changed. A missing sink falls back to the system
 * default without issuing a media transport command. Overlapping devicechange
 * events are coalesced so a noisy USB/Bluetooth transition cannot race several
 * setSinkId operations against each other.
 */
export function observeSpeakerOutputDeviceChanges({
  mediaDevices,
  getSelectedDeviceId,
  applyDevice,
  onUnavailable = null,
} = {}) {
  let disposed = false;
  let checking = false;
  let checkAgain = false;

  const unavailable = typeof onUnavailable === 'function' ? onUnavailable : null;

  const check = async () => {
    if (disposed) return Object.freeze({ status: 'disposed' });
    if (checking) {
      checkAgain = true;
      return Object.freeze({ status: 'coalesced' });
    }

    let deviceId = '';
    try {
      deviceId = boundedString(getSelectedDeviceId?.(), DEVICE_ID_MAX_LENGTH);
    } catch {
      return Object.freeze({ status: 'idle' });
    }
    if (!deviceId) return Object.freeze({ status: 'idle' });

    checking = true;
    let result;
    try {
      const applied = await applyDevice(deviceId);
      result = Object.freeze({
        status: applied?.status === 'pending' ? 'pending' : 'available',
        deviceId,
      });
    } catch (error) {
      let fallbackAllowed = true;
      if (!disposed && unavailable) {
        try {
          // Let the owner synchronously reject an obsolete result before a
          // default-sink operation can overwrite a newer user selection.
          fallbackAllowed = unavailable(Object.freeze({ deviceId, error })) !== false;
        } catch {
          // An observer failure cannot take ownership of the media element.
        }
      }
      let fallbackStatus = 'failed';
      if (!disposed && fallbackAllowed) {
        try {
          const fallback = await applyDevice('');
          fallbackStatus = fallback?.status === 'pending' ? 'pending' : 'default';
        } catch {
          // The browser may already have moved the element to its default sink.
          // Failure here is advisory and must never alter playback lifecycle.
        }
      } else {
        fallbackStatus = 'superseded';
      }
      result = Object.freeze({ status: 'unavailable', deviceId, fallbackStatus });
    } finally {
      checking = false;
      if (!disposed && checkAgain) {
        checkAgain = false;
        Promise.resolve().then(check).catch(() => {});
      }
    }
    return result;
  };

  const handleDeviceChange = () => {
    Promise.resolve(check()).catch(() => {});
  };

  let listening = false;
  if (mediaDevices && typeof mediaDevices.addEventListener === 'function'
    && typeof mediaDevices.removeEventListener === 'function'
    && typeof getSelectedDeviceId === 'function'
    && typeof applyDevice === 'function') {
    try {
      mediaDevices.addEventListener('devicechange', handleDeviceChange);
      listening = true;
    } catch {
      listening = false;
    }
  }

  return Object.freeze({
    check,
    snapshot() {
      return Object.freeze({ disposed, listening, checking, checkAgain });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      checkAgain = false;
      if (listening) {
        try {
          mediaDevices.removeEventListener('devicechange', handleDeviceChange);
        } catch {
          // A disappearing mediaDevices implementation needs no further cleanup.
        }
      }
      listening = false;
    },
  });
}
