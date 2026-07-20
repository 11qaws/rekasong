const VALID_OUTPUT_MODES = new Set(['speaker', 'obs']);
const VALID_SWITCH_STATES = new Set(['idle', 'connecting', 'conflict', 'switching', 'blocked']);

export function derivePlaybackOutputNextAction({
  statusKey,
  targetMode = null,
  confirmedOutputMode = null,
} = {}) {
  const mode = targetMode === 'speaker' || targetMode === 'obs'
    ? targetMode
    : confirmedOutputMode === 'speaker' || confirmedOutputMode === 'obs'
      ? confirmedOutputMode
      : null;
  if (statusKey === 'onair.output.header.active.speaker') return 'onair.output.nextAction.speaker.active';
  if (statusKey === 'onair.output.header.active.obs') return 'onair.output.nextAction.obs.active';
  if (statusKey === 'onair.output.header.connecting.speaker') return 'onair.output.nextAction.speaker.connecting';
  if (statusKey === 'onair.output.header.connecting.obs') return 'onair.output.nextAction.obs.connecting';
  if (statusKey === 'onair.output.header.control.otherTab') return 'onair.output.nextAction.control';
  if (statusKey === 'onair.output.header.active.switching') return 'onair.output.nextAction.switching';
  if (statusKey === 'onair.output.header.blocked.speaker.none'
    || statusKey === 'onair.output.header.blocked.speaker.duplicate'
    || statusKey === 'onair.output.header.blocked.speaker.foreign') {
    return 'onair.output.nextAction.speaker.recover';
  }
  if (statusKey === 'onair.output.header.blocked.obs.none'
    || statusKey === 'onair.output.header.blocked.obs.duplicate') {
    return 'onair.output.nextAction.obs.candidate';
  }
  if (statusKey === 'onair.output.header.active.attention') {
    return mode === 'obs'
      ? 'onair.output.nextAction.obs.recover'
      : 'onair.output.nextAction.speaker.recover';
  }
  if (statusKey === 'onair.output.header.active.inactive') {
    return 'onair.output.nextAction.select';
  }
  return 'onair.output.nextAction.general';
}

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
    if (normalizedTargetMode === 'speaker') {
      return { key: 'onair.output.header.connecting.speaker', tone: 'pending', mode: null };
    }
    if (normalizedTargetMode === 'obs') {
      return { key: 'onair.output.header.connecting.obs', tone: 'pending', mode: null };
    }
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
