export const OBS_RUNTIME_ATTESTATION_CODES = Object.freeze({
  BINDING_UNAVAILABLE: 'obs_runtime_binding_unavailable',
  CONTROL_LEVEL_UNAVAILABLE: 'obs_runtime_control_level_unavailable',
  STATUS_UNAVAILABLE: 'obs_runtime_status_unavailable',
  INVALID_SOURCE_EVENT: 'obs_runtime_invalid_source_event',
});

const CONTROL_LEVELS = Object.freeze([
  'none',
  'read_obs',
  'read_user',
  'basic',
  'advanced',
  'all',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maximum = 128) {
  const normalized = typeof value === 'string'
    ? value
    : Number.isFinite(value) ? String(value) : '';
  if (normalized.length === 0) return null;
  return normalized.slice(0, maximum);
}

function eventBoolean(event, field) {
  if (typeof event?.detail === 'boolean') return event.detail;
  if (!isRecord(event?.detail)) return null;
  if (typeof event.detail[field] === 'boolean') return event.detail[field];
  if (typeof event.detail.value === 'boolean') return event.detail.value;
  return null;
}

function immutableSnapshot(value) {
  return Object.freeze({ ...value });
}

function safeNotify(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch {
    // Observability callbacks never change the attested runtime state.
  }
}

/**
 * Track only facts exposed by the OBS Browser Source JavaScript binding.
 * OBS exposes active/visible changes, but no getter for their initial value.
 * Keep that initial state unobserved instead of inventing an inactive source.
 * An explicit false callback still blocks a new route. None of these signals
 * prove mixer routing, recording tracks, or final stream audio.
 */
export function createObsRuntimeAttestation({
  windowObject = globalThis.window,
  onChange = null,
} = {}) {
  const obsstudio = isRecord(windowObject?.obsstudio) ? windowObject.obsstudio : null;
  const detected = Boolean(obsstudio);
  const state = {
    sourceActive: null,
    sourceVisible: null,
    streaming: false,
    streamingStatusObserved: false,
    recording: false,
    obsPluginVersion: detected ? boundedString(obsstudio.pluginVersion) : null,
    obsControlLevel: null,
    lastErrorCode: detected ? null : OBS_RUNTIME_ATTESTATION_CODES.BINDING_UNAVAILABLE,
  };
  let disposed = false;
  const listeners = [];

  const publish = () => {
    if (!disposed) safeNotify(onChange, api.snapshot());
  };

  const setBoolean = (field, value, invalidCode = null) => {
    const next = typeof value === 'boolean' ? value : false;
    const changed = state[field] !== next || (invalidCode && state.lastErrorCode !== invalidCode);
    state[field] = next;
    if (invalidCode) state.lastErrorCode = invalidCode;
    if (changed) publish();
  };

  const addListener = (type, listener) => {
    if (typeof windowObject?.addEventListener !== 'function') return;
    windowObject.addEventListener(type, listener);
    listeners.push([type, listener]);
  };

  const activeListener = (event) => {
    const value = eventBoolean(event, 'active');
    setBoolean(
      'sourceActive',
      value,
      value === null ? OBS_RUNTIME_ATTESTATION_CODES.INVALID_SOURCE_EVENT : null,
    );
  };
  const visibleListener = (event) => {
    const value = eventBoolean(event, 'visible');
    setBoolean(
      'sourceVisible',
      value,
      value === null ? OBS_RUNTIME_ATTESTATION_CODES.INVALID_SOURCE_EVENT : null,
    );
  };

  const statusEvents = [
    ['obsStreamingStarted', 'streaming', true],
    ['obsStreamingStopped', 'streaming', false],
    ['obsRecordingStarted', 'recording', true],
    ['obsRecordingStopped', 'recording', false],
  ];

  const previousActive = obsstudio?.onActiveChange;
  const previousVisible = obsstudio?.onVisibilityChange;
  let legacyActiveInstalled = false;
  let legacyVisibleInstalled = false;
  const legacyActive = (value) => {
    setBoolean(
      'sourceActive',
      value,
      typeof value === 'boolean' ? null : OBS_RUNTIME_ATTESTATION_CODES.INVALID_SOURCE_EVENT,
    );
    safeNotify(previousActive, value);
  };
  const legacyVisible = (value) => {
    setBoolean(
      'sourceVisible',
      value,
      typeof value === 'boolean' ? null : OBS_RUNTIME_ATTESTATION_CODES.INVALID_SOURCE_EVENT,
    );
    safeNotify(previousVisible, value);
  };

  const refreshControlLevel = () => {
    if (disposed || typeof obsstudio?.getControlLevel !== 'function') {
      if (detected) state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.CONTROL_LEVEL_UNAVAILABLE;
      return false;
    }
    try {
      obsstudio.getControlLevel((level) => {
        if (disposed) return;
        state.obsControlLevel = Number.isInteger(level) && CONTROL_LEVELS[level]
          ? CONTROL_LEVELS[level]
          : null;
        if (state.obsControlLevel === null) {
          state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.CONTROL_LEVEL_UNAVAILABLE;
        }
        publish();
      });
      return true;
    } catch {
      state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.CONTROL_LEVEL_UNAVAILABLE;
      publish();
      return false;
    }
  };

  const refreshStatus = () => {
    if (disposed || typeof obsstudio?.getStatus !== 'function') {
      if (detected) state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.STATUS_UNAVAILABLE;
      return false;
    }
    try {
      obsstudio.getStatus((status) => {
        if (disposed) return;
        if (!isRecord(status)) {
          state.streaming = false;
          state.streamingStatusObserved = false;
          state.recording = false;
          state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.STATUS_UNAVAILABLE;
        } else {
          state.streaming = status.streaming === true;
          state.streamingStatusObserved = true;
          state.recording = status.recording === true;
        }
        publish();
      });
      return true;
    } catch {
      state.streamingStatusObserved = false;
      state.lastErrorCode = OBS_RUNTIME_ATTESTATION_CODES.STATUS_UNAVAILABLE;
      publish();
      return false;
    }
  };

  const api = Object.freeze({
    capabilities: immutableSnapshot({
      obsRuntime: detected,
      obsStudioBinding: detected,
    }),
    runtime() {
      const runtime = {
        streaming: state.streaming === true,
        streamingStatusObserved: state.streamingStatusObserved === true,
        recording: state.recording === true,
      };
      if (typeof state.sourceActive === 'boolean') runtime.sourceActive = state.sourceActive;
      if (typeof state.sourceVisible === 'boolean') runtime.sourceVisible = state.sourceVisible;
      if (state.obsPluginVersion) runtime.obsPluginVersion = state.obsPluginVersion;
      if (state.obsControlLevel) runtime.obsControlLevel = state.obsControlLevel;
      return immutableSnapshot(runtime);
    },
    snapshot() {
      return immutableSnapshot({
        detected,
        ...api.runtime(),
        lastErrorCode: state.lastErrorCode,
      });
    },
    refreshControlLevel,
    refreshStatus,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof windowObject?.removeEventListener === 'function') {
        for (const [type, listener] of listeners) {
          windowObject.removeEventListener(type, listener);
        }
      }
      try {
        if (legacyActiveInstalled && obsstudio?.onActiveChange === legacyActive) {
          obsstudio.onActiveChange = previousActive;
        }
      } catch {
        // Event listeners have still been removed and late callbacks are fenced.
      }
      try {
        if (legacyVisibleInstalled && obsstudio?.onVisibilityChange === legacyVisible) {
          obsstudio.onVisibilityChange = previousVisible;
        }
      } catch {
        // Event listeners have still been removed and late callbacks are fenced.
      }
    },
  });

  if (detected) {
    addListener('obsSourceActiveChanged', activeListener);
    addListener('obsSourceVisibleChanged', visibleListener);
    for (const [type, field, value] of statusEvents) {
      addListener(type, () => {
        const observationChanged = field === 'streaming' && !state.streamingStatusObserved;
        if (field === 'streaming') state.streamingStatusObserved = true;
        const valueChanged = state[field] !== value;
        setBoolean(field, value);
        if (observationChanged && !valueChanged) publish();
      });
    }
    addListener('obsExit', () => {
      state.sourceActive = false;
      state.sourceVisible = false;
      state.streaming = false;
      state.streamingStatusObserved = true;
      state.recording = false;
      publish();
    });
    try {
      obsstudio.onActiveChange = legacyActive;
      legacyActiveInstalled = obsstudio.onActiveChange === legacyActive;
    } catch {
      legacyActiveInstalled = false;
    }
    try {
      obsstudio.onVisibilityChange = legacyVisible;
      legacyVisibleInstalled = obsstudio.onVisibilityChange === legacyVisible;
    } catch {
      legacyVisibleInstalled = false;
    }
    refreshControlLevel();
    refreshStatus();
  }

  return api;
}
