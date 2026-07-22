import { PLAYER_CLIENT_KINDS } from './onAirProtocol.js';

/**
 * Locale-neutral output-path readiness used during explicit route activation.
 * Dashboard speaker playback owns a normal DOM audio element and therefore
 * has no OBS source attestation. OBS must prove its runtime binding, while an
 * explicit inactive callback blocks activation. The OBS API has no initial
 * active-state getter, so a still-unobserved value cannot be treated as false.
 */
export function evaluateOnAirPlayerOutputPath({
  clientKind,
  audio,
  engine,
  signal,
  obsAttestation = null,
} = {}) {
  const safeStandby = signal?.aborted === false
    && audio?.isConnected === true
    && engine?.mediaPaused === true
    && engine?.sourceAttached === false;

  if (clientKind === PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER) {
    return Object.freeze({ ready: safeStandby });
  }

  return Object.freeze({
    ready: safeStandby
      && obsAttestation?.detected === true
      && obsAttestation?.sourceActive !== false,
  });
}
