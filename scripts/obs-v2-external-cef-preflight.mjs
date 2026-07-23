export const EXTERNAL_CEF_PREFLIGHT_CODES = Object.freeze({
  STREAMING_STATUS_UNOBSERVED: 'external_cef_streaming_status_unobserved',
  STREAMING_ACTIVE: 'external_cef_streaming_active',
  RECORDING_ACTIVE: 'external_cef_recording_active',
});

/**
 * External OBS acceptance runs must fail closed. A false default is not proof:
 * the OBS binding must have returned a current status object first.
 */
export function inspectExternalCefRuntime(runtime) {
  if (runtime?.streamingStatusObserved !== true) {
    return Object.freeze({
      ok: false,
      code: EXTERNAL_CEF_PREFLIGHT_CODES.STREAMING_STATUS_UNOBSERVED,
    });
  }
  if (runtime.streaming === true) {
    return Object.freeze({
      ok: false,
      code: EXTERNAL_CEF_PREFLIGHT_CODES.STREAMING_ACTIVE,
    });
  }
  if (runtime.recording === true) {
    return Object.freeze({
      ok: false,
      code: EXTERNAL_CEF_PREFLIGHT_CODES.RECORDING_ACTIVE,
    });
  }
  return Object.freeze({ ok: true, code: null });
}
