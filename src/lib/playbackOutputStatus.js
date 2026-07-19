const VALID_OUTPUT_MODES = new Set(['speaker', 'obs']);
const VALID_SWITCH_STATES = new Set(['idle', 'connecting', 'conflict', 'switching', 'blocked']);

export function derivePlaybackOutputStatus({
  confirmedOutputMode,
  outputSwitchState = 'idle',
  isSessionInvalid = false,
  isRouteStable = false,
  isPlaying = false,
} = {}) {
  const mode = VALID_OUTPUT_MODES.has(confirmedOutputMode) ? confirmedOutputMode : null;
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
    return { key: 'onair.output.header.active.switching', tone: 'pending', mode: null };
  }
  if (switchState === 'blocked') {
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
      key: isPlaying
        ? 'onair.output.header.active.speaker'
        : 'onair.output.header.standby.speaker',
      tone: 'speaker',
      mode,
    };
  }
  return {
    key: isPlaying
      ? 'onair.output.header.active.obs'
      : 'onair.output.header.standby.obs',
    tone: 'obs',
    mode,
  };
}
