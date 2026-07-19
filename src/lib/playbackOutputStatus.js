const VALID_OUTPUT_MODES = new Set(['speaker', 'obs']);
const VALID_SWITCH_STATES = new Set(['idle', 'connecting', 'conflict', 'switching', 'blocked']);

export function derivePlaybackOutputStatus({
  confirmedOutputMode,
  outputSwitchState = 'idle',
  isSessionInvalid = false,
  isRouteStable = false,
  targetMode = null,
  targetCandidateState = null,
  reasonCode = null,
} = {}) {
  const mode = VALID_OUTPUT_MODES.has(confirmedOutputMode) ? confirmedOutputMode : null;
  const normalizedTargetMode = VALID_OUTPUT_MODES.has(targetMode) ? targetMode : null;
  const switchState = VALID_SWITCH_STATES.has(outputSwitchState) ? outputSwitchState : 'blocked';

  if (isSessionInvalid) {
    return { key: 'onair.output.header.active.attention', tone: 'attention', mode: null };
  }
  if (switchState === 'connecting') {
    return { key: 'onair.output.header.active.connecting', tone: 'pending', mode: null };
  }
  if (switchState === 'conflict') {
    return { key: 'onair.output.header.control.otherTab', tone: 'notice', mode: null };
  }
  if (switchState === 'switching') {
    if (normalizedTargetMode === 'speaker' && targetCandidateState === 'none') {
      return { key: 'onair.output.header.connecting.speaker', tone: 'pending', mode: null };
    }
    return { key: 'onair.output.header.active.switching', tone: 'pending', mode: null };
  }
  if (switchState === 'blocked') {
    if (normalizedTargetMode === 'speaker'
      && reasonCode === 'output_control_target_identity_mismatch') {
      return {
        key: 'onair.output.header.blocked.speaker.foreign',
        tone: 'attention',
        mode: null,
      };
    }
    if (normalizedTargetMode && ['none', 'duplicate'].includes(targetCandidateState)) {
      return {
        key: `onair.output.header.blocked.${normalizedTargetMode}.${targetCandidateState}`,
        tone: 'attention',
        mode: null,
      };
    }
    return { key: 'onair.output.header.active.attention', tone: 'attention', mode: null };
  }
  if (!isRouteStable || !mode) {
    return {
      key: mode
        ? 'onair.output.header.active.attention'
        : 'onair.output.header.active.inactive',
      tone: mode ? 'attention' : 'pending',
      mode: null,
    };
  }

  if (mode === 'speaker') {
    return {
      key: 'onair.output.header.active.speaker',
      tone: 'speaker',
      mode,
    };
  }
  return {
    key: 'onair.output.header.active.obs',
    tone: 'obs',
    mode,
  };
}
