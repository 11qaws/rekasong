import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_CEF_PREFLIGHT_CODES,
  inspectExternalCefRuntime,
} from '../scripts/obs-v2-external-cef-preflight.mjs';

test('external CEF preflight requires a current observed OBS status', () => {
  assert.deepEqual(inspectExternalCefRuntime({
    streaming: false,
    streamingStatusObserved: false,
    recording: false,
  }), {
    ok: false,
    code: EXTERNAL_CEF_PREFLIGHT_CODES.STREAMING_STATUS_UNOBSERVED,
  });
  assert.deepEqual(inspectExternalCefRuntime(null), {
    ok: false,
    code: EXTERNAL_CEF_PREFLIGHT_CODES.STREAMING_STATUS_UNOBSERVED,
  });
});

test('external CEF preflight blocks an active stream or foreign recording', () => {
  assert.deepEqual(inspectExternalCefRuntime({
    streaming: true,
    streamingStatusObserved: true,
    recording: false,
  }), {
    ok: false,
    code: EXTERNAL_CEF_PREFLIGHT_CODES.STREAMING_ACTIVE,
  });
  assert.deepEqual(inspectExternalCefRuntime({
    streaming: false,
    streamingStatusObserved: true,
    recording: true,
  }), {
    ok: false,
    code: EXTERNAL_CEF_PREFLIGHT_CODES.RECORDING_ACTIVE,
  });
});

test('external CEF preflight accepts only observed stream-off and record-off', () => {
  assert.deepEqual(inspectExternalCefRuntime({
    streaming: false,
    streamingStatusObserved: true,
    recording: false,
  }), { ok: true, code: null });
});
