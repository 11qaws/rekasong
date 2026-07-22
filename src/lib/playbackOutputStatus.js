const VALID_OUTPUT_MODES = new Set(['speaker', 'obs']);
const VALID_SWITCH_STATES = new Set(['idle', 'connecting', 'conflict', 'switching', 'blocked']);

export function deriveObsSetupWaitReason({
  requestedMode = null,
  controllerReady = false,
  candidateState = null,
  sourceInactive = false,
} = {}) {
  if (requestedMode !== 'obs' || controllerReady !== true) return null;
  if (sourceInactive === true) return 'source_inactive';
  if (candidateState === 'none') return 'candidate_none';
  if (candidateState === 'duplicate') return 'candidate_duplicate';
  return null;
}

export function derivePlaybackOutputNextAction({
  statusKey,
  targetMode = null,
  confirmedOutputMode = null,
  controlRecoveryRequired = false,
} = {}) {
  const mode = targetMode === 'speaker' || targetMode === 'obs'
    ? targetMode
    : confirmedOutputMode === 'speaker' || confirmedOutputMode === 'obs'
      ? confirmedOutputMode
      : null;
  if (controlRecoveryRequired) return 'onair.output.nextAction.control';
  if (statusKey === 'onair.output.header.active.speaker') return 'onair.output.nextAction.speaker.active';
  if (statusKey === 'onair.output.header.active.obs') return 'onair.output.nextAction.obs.active';
  if (statusKey === 'onair.output.header.active.obs.sourceInactive') {
    return 'onair.output.nextAction.obs.sourceInactiveConnected';
  }
  if (statusKey === 'onair.output.header.connecting.speaker') return 'onair.output.nextAction.speaker.connecting';
  if (statusKey === 'onair.output.header.connecting.obs') return 'onair.output.nextAction.obs.connecting';
  if (statusKey === 'onair.output.header.setup.obs.none') {
    return 'onair.output.nextAction.obs.candidateNone';
  }
  if (statusKey === 'onair.output.header.setup.obs.duplicate') {
    return 'onair.output.nextAction.obs.candidateDuplicate';
  }
  if (statusKey === 'onair.output.header.setup.obs.sourceInactive') {
    return 'onair.output.nextAction.obs.sourceInactiveConnected';
  }
  if (statusKey === 'onair.output.header.blocked.obs.sourceInactive') {
    return 'onair.output.nextAction.obs.sourceInactive';
  }
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
  targetSourceInactive = false,
  activeSourceInactive = false,
  reasonCode = null,
} = {}) {
  const mode = VALID_OUTPUT_MODES.has(confirmedOutputMode) ? confirmedOutputMode : null;
  const normalizedTargetMode = VALID_OUTPUT_MODES.has(targetMode) ? targetMode : null;
  const switchState = VALID_SWITCH_STATES.has(outputSwitchState) ? outputSwitchState : 'blocked';

  // Speaker is a browser-local listening choice, not a server route.  Old
  // Worker lease/conflict/candidate state can still arrive while the user is
  // selecting Speaker, but it must never turn the local player into a
  // connecting, duplicate, foreign-owner, or blocked state.  OBS transitions
  // still take precedence when OBS is the explicit target.
  if (normalizedTargetMode === 'speaker'
    || (normalizedTargetMode === null && mode === 'speaker')) {
    return { key: 'onair.output.header.active.speaker', tone: 'speaker', mode: 'speaker' };
  }

  if (isSessionInvalid) {
    return { key: 'onair.output.header.active.attention', tone: 'attention', mode: null };
  }
  if (switchState === 'connecting') {
    if (normalizedTargetMode === 'speaker') {
      return { key: 'onair.output.header.connecting.speaker', tone: 'pending', mode: null };
    }
    if (normalizedTargetMode === 'obs') {
      if (targetSourceInactive === true) {
        return {
          key: 'onair.output.header.setup.obs.sourceInactive',
          tone: 'notice',
          mode: null,
        };
      }
      if (targetCandidateState === 'none') {
        return { key: 'onair.output.header.setup.obs.none', tone: 'notice', mode: null };
      }
      if (targetCandidateState === 'duplicate') {
        return { key: 'onair.output.header.setup.obs.duplicate', tone: 'notice', mode: null };
      }
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
    if (normalizedTargetMode === 'obs' && targetSourceInactive === true) {
      return {
        key: 'onair.output.header.blocked.obs.sourceInactive',
        tone: 'attention',
        mode: null,
      };
    }
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

  if (mode === 'obs' && activeSourceInactive === true) {
    return {
      key: 'onair.output.header.active.obs.sourceInactive',
      tone: 'attention',
      mode,
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
