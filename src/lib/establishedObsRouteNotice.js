const ACTIVE_NOTICE_STATES = new Set(['none', 'duplicate']);

/**
 * Candidate cardinality is strict while selecting a new OBS route, but it is
 * advisory after an exact leased player has been established. This keeps the
 * primary OBS status truthful while telling the user what to clean up without
 * implying that playback was disconnected.
 */
export function deriveEstablishedObsRouteNotice({
  confirmedOutputMode = null,
  isRouteStable = false,
  candidateState = null,
  sourceInactive = false,
} = {}) {
  if (confirmedOutputMode !== 'obs'
    || isRouteStable !== true
    || sourceInactive === true
    || !ACTIVE_NOTICE_STATES.has(candidateState)) return null;

  const segment = candidateState === 'duplicate' ? 'duplicate' : 'missing';
  return Object.freeze({
    code: `established_obs_${segment}`,
    messageKey: `onair.output.status.obs.${segment}Connected`,
    nextActionKey: `onair.output.nextAction.obs.${segment}Connected`,
  });
}
