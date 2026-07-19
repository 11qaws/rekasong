import { PLAYER_CLIENT_KINDS } from './onAirProtocol.js';

/**
 * Locale-neutral output-path readiness used during explicit route activation.
 * Dashboard speaker playback owns a normal DOM audio element and therefore
 * has no OBS source attestation. OBS/generic behavior retains the existing
 * binding + active-source requirements.
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
      && obsAttestation?.sourceActive === true,
  });
}
