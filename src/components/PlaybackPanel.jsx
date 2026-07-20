import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ListMusic, MonitorUp, Pause, Play, Radio, Repeat, RotateCcw, Settings, SkipForward, Trash2, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { getOutputMessage as t } from '../copy/outputMessages';
import {
  derivePlaybackOutputNextAction,
  derivePlaybackOutputStatus,
} from '../lib/playbackOutputStatus';

// 위젯 연결 칩 — 서버가 중계하는 **일반 브라우저 페이지 presence**에만 근거한다.
// 이 값만으로 OBS CEF, 오디오 믹서, 녹화/송출 경로를 확인했다고 말하면 안 된다.
function WidgetStatusChip({
  connected,
  connectedLabel,
  waitingLabel,
  candidateState = null,
  duplicateLabel = '',
  unknownLabel = '',
}) {
  const candidateAware = ['none', 'single', 'duplicate', 'unknown'].includes(candidateState);
  const isHealthy = candidateAware ? candidateState === 'single' : Boolean(connected);
  const isDuplicate = candidateAware && candidateState === 'duplicate';
  const label = isHealthy
    ? connectedLabel
    : isDuplicate
      ? duplicateLabel
      : candidateState === 'unknown'
        ? unknownLabel
        : waitingLabel;
  return (
    <span className={`obs-player-status ${isHealthy ? 'is-on' : isDuplicate ? 'is-error' : 'is-waiting'}`} role="status">
      {isHealthy ? <Check size={13} /> : <span className="obs-status-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

export default function PlaybackPanel({
  room,
  publicKeyB64,
  currentSong,
  activePhase,
  failureDetail,
  isPlaying,
  onTogglePlay,
  onSkip,
  onDiscardCurrent,
  onRetryCurrent,
  volume,
  onVolumeChange,
  currentTime,
  duration,
  onSeek,
  onRequeueCurrent,
  showToast,
  onAirPlayerUrl,
  onAirDisplayUrl,
  onAirStatus,
  onAirPlayerCandidate,
  onAirDisplayConnected,
  onEndBroadcastSession,
  canEndBroadcastSession = false,
  onRecoverOnAir,
  onPrepareOnAir,
  onPrepareOnAirDisplay,
  outputMode,
  pendingOutputMode = null,
  actualOutputMode,
  failedOutputMode = null,
  outputView = null,
  outputControlConflict = false,
  outputControlUnavailable = false,
  outputControlRecoveryReason = null,
  outputControlSafeToTakeOver = false,
  outputControlTakeover = null,
  outputControlRecoveryRequired = false,
  outputRouteStable = false,
  outputSwitchState = 'idle',
  outputSwitchReasonCode = null,
  allowOutputSelectionWhileConnecting = false,
  obsAudioCheck = null,
  onSelectOutputMode,
  onStartObsAudioCheck,
  onStopObsAudioCheck,
  onEmergencyStopOutput,
  onTakeOverOutputControl,
  onRetryOutputControl,
}) {
  const [previousVolume, setPreviousVolume] = useState(100);
  // 드래그 커밋: range 슬라이더의 onChange 는 드래그 중 연발한다. 이동 중엔
  // 미리보기(로컬 상태)만 갱신하고 놓을 때 한 번만 실제 명령을 보낸다 — On-Air
  // seek/volume 명령 연발이 DO 쓰기 폭풍(무료 티어 한도)과 재생 재요청을 일으키던
  // 것을 뿌리에서 없앤다. (Worker 는 seek 을 이미 영속하지 않는다.)
  const [seekDraft, setSeekDraft] = useState(null);
  const [volumeDraft, setVolumeDraft] = useState(null);
  const commitSeek = () => {
    if (transportControlsLocked) {
      setSeekDraft(null);
      return;
    }
    if (seekDraft !== null) { onSeek(seekDraft); setSeekDraft(null); }
  };
  const commitVolume = () => {
    if (transportControlsLocked) {
      setVolumeDraft(null);
      return;
    }
    if (volumeDraft !== null) { onVolumeChange(volumeDraft); setVolumeDraft(null); }
  };
  const [isObsSetupOpen, setIsObsSetupOpen] = useState(false);
  const [isPreparingPlayer, setIsPreparingPlayer] = useState(false);
  const [preparedPlayerUrl, setPreparedPlayerUrl] = useState('');
  const [isPreparingDisplay, setIsPreparingDisplay] = useState(false);
  const [preparedDisplayUrl, setPreparedDisplayUrl] = useState('');
  const [isRecoveringOnAir, setIsRecoveringOnAir] = useState(false);
  const [isEmergencyStoppingOutput, setIsEmergencyStoppingOutput] = useState(false);
  const [controlTransferPhase, setControlTransferPhase] = useState('idle');
  const [isRetryingOutputControl, setIsRetryingOutputControl] = useState(false);
  const obsSetupTriggerRef = useRef(null);
  const obsDialogRef = useRef(null);
  const obsDialogTitleRef = useRef(null);
  const outputOptionRefs = useRef({ speaker: null, obs: null });
  const previousOnAirPlayerUrlRef = useRef(onAirPlayerUrl);
  const previousOnAirDisplayUrlRef = useRef(onAirDisplayUrl);
  const showToastRef = useRef(showToast);
  const retryOutputControlRef = useRef(onRetryOutputControl);
  showToastRef.current = showToast;
  retryOutputControlRef.current = onRetryOutputControl;
  const isMuted = volume === 0;
  const playerUrl = onAirPlayerUrl || preparedPlayerUrl;
  const displayUrl = onAirDisplayUrl || preparedDisplayUrl;
  // N-01 (Stage 5): 직접 재생 모드(On-Air 미설정)의 화면 정보 위젯 주소.
  // 구버전 room&key 위젯과 동일한 형식이라 예전에 복사해 둔 주소도 계속 동작하며,
  // 이 주소가 구독하는 발행 payload는 축소 projection(N-08)뿐이다.
  const isDirectMode = onAirStatus === 'unconfigured';
  const isOnAirInvalid = onAirStatus === 'invalid' || onAirStatus === 'ended';
  const selectedOutputMode = outputMode === 'speaker' || outputMode === 'obs' ? outputMode : null;
  const confirmedOutputMode = actualOutputMode === 'speaker' || actualOutputMode === 'obs'
    ? actualOutputMode
    : null;
  const failedSelectionMode = failedOutputMode === 'speaker' || failedOutputMode === 'obs'
    ? failedOutputMode
    : null;
  const pendingSelectionMode = pendingOutputMode === 'speaker' || pendingOutputMode === 'obs'
    ? pendingOutputMode
    : null;
  const outputRouteStateUnknown = outputView?.statusCode === 'state_unknown';
  const outputLeaseNeedsEmergencyStop = outputRouteStateUnknown
    && ['unknown', 'failed'].includes(outputView?.lease?.status);
  const outputRecoveryNeedsEmergencyStop = outputLeaseNeedsEmergencyStop
    || outputControlRecoveryReason === 'switch_timeout';
  const normalizedOutputSwitchState = ['idle', 'connecting', 'conflict', 'switching', 'blocked'].includes(outputSwitchState)
    ? outputSwitchState
    : 'blocked';
  const outputSelectionLocked = ['conflict', 'switching'].includes(normalizedOutputSwitchState)
    || (normalizedOutputSwitchState === 'connecting' && !allowOutputSelectionWhileConnecting)
    || outputControlRecoveryRequired
    || typeof onSelectOutputMode !== 'function';
  const outputRecoveryTitleMessageKey = outputControlRecoveryReason === 'connection_timeout'
    ? 'onair.control.recovery.connectionTimeout.title'
    : outputControlRecoveryReason === 'switch_timeout'
      ? 'onair.control.recovery.switchTimeout.title'
      : 'onair.control.unavailable.title';
  const outputRecoveryDescriptionMessageKey = outputControlRecoveryReason === 'connection_timeout'
    ? 'onair.control.recovery.connectionTimeout.description'
    : outputControlRecoveryReason === 'switch_timeout'
      ? 'onair.control.recovery.switchTimeout.description'
      : 'onair.control.unavailable.description';
  const outputSelectionLockMessageKey = outputControlRecoveryReason
    ? outputRecoveryDescriptionMessageKey
    : normalizedOutputSwitchState === 'connecting'
    ? 'onair.output.selector.locked.connecting'
    : normalizedOutputSwitchState === 'conflict'
      ? 'onair.output.selector.locked.otherTab'
      : normalizedOutputSwitchState === 'switching'
        ? 'onair.output.selector.locked.switching'
        : 'onair.output.selector.locked.unavailable';
  const directWidgetUrl = room && publicKeyB64
    ? `${window.location.origin}${window.location.pathname}#/widget?room=${encodeURIComponent(room)}&key=${encodeURIComponent(publicKeyB64)}`
    : '';

  // 생애주기 전이 중/실패 상태(§2-1) — 일반 재생 조작을 잠그고 상태를 드러낸다.
  // finishing: 쓰레기통만 허용(§4-3) · discarding: 중복 조작 방지(§4-4)
  // failed: 재시도·버리기만 제시(§4-5).
  const isFinishing = activePhase === 'finishing';
  const isDiscarding = activePhase === 'discarding';
  const isFailed = activePhase === 'failed';
  const isStarting = activePhase === 'starting';
  const controlsLocked = isFinishing || isDiscarding || isFailed;
  const outputAuthorityLocked = normalizedOutputSwitchState === 'connecting'
    || outputControlConflict
    || outputControlUnavailable;
  const transportControlsLocked = isStarting || controlsLocked || outputAuthorityLocked;
  const phaseBadgeText = isStarting ? t('playback.phase.preparing')
    : isFinishing ? t('playback.phase.skipping')
    : isDiscarding ? t('playback.phase.discarding')
    : isFailed ? t('playback.phase.failed')
    : isPlaying ? t('playback.phase.onAir') : t('playback.phase.paused');
  const outputModeLabel = (mode) => mode === 'speaker'
    ? t('onair.output.selector.mode.speaker')
    : mode === 'obs'
      ? t('onair.output.selector.mode.obs')
      : t('onair.output.selector.mode.unknown');
  const transitionTargetMode = normalizedOutputSwitchState === 'connecting'
    ? pendingSelectionMode
    : normalizedOutputSwitchState === 'switching'
      ? selectedOutputMode
      : null;
  const targetCandidateState = failedSelectionMode
    ? outputView?.targets?.[failedSelectionMode]?.candidate?.state ?? null
    : transitionTargetMode
      ? outputView?.targets?.[transitionTargetMode]?.candidate?.state ?? null
      : null;
  const activeOutputStatus = derivePlaybackOutputStatus({
    confirmedOutputMode,
    outputSwitchState: normalizedOutputSwitchState,
    isSessionInvalid: isOnAirInvalid || outputRouteStateUnknown,
    isRouteStable: outputRouteStable,
    targetMode: failedSelectionMode ?? transitionTargetMode,
    targetCandidateState,
    reasonCode: outputSwitchReasonCode,
  });
  const outputNextActionKey = derivePlaybackOutputNextAction({
    statusKey: activeOutputStatus.key,
    targetMode: failedSelectionMode ?? transitionTargetMode ?? selectedOutputMode,
    confirmedOutputMode,
    controlRecoveryRequired: outputControlRecoveryRequired,
  });
  const outputNeedsAttention = isOnAirInvalid
    || outputRouteStateUnknown
    || normalizedOutputSwitchState === 'blocked'
    || outputControlRecoveryRequired;
  const obsAudioCheckStage = obsAudioCheck?.stage ?? 'unknown';
  const obsAudioCheckMarkerSeconds = ((obsAudioCheck?.markerTimeMs ?? 0) / 1_000).toFixed(1);
  const obsAudioCheckDurationSeconds = ((obsAudioCheck?.durationMs ?? 0) / 1_000).toFixed(0);
  const shouldOfferObsAudioCheckStop = Boolean(
    obsAudioCheck?.canStop
    || obsAudioCheck?.pendingOperation === 'stop'
    || (obsAudioCheck?.active && obsAudioCheck?.pendingOperation !== 'start'),
  );

  const selectOutputMode = (mode) => {
    if (outputSelectionLocked) {
      showToast?.(
        t(outputSelectionLockMessageKey),
        ['connecting', 'conflict', 'switching'].includes(normalizedOutputSwitchState)
          ? 'info'
          : 'error',
      );
      return;
    }
    // In a blocked state every route remains actionable: the failed target is
    // a retry, another target is a new attempt, and the actual route clears the
    // stale failure through the controller's authoritative already-active path.
    if (normalizedOutputSwitchState !== 'blocked'
      && mode === selectedOutputMode
      && mode === confirmedOutputMode) return;
    onSelectOutputMode(mode);
  };

  const handleOutputOptionKeyDown = (event, currentMode) => {
    const modes = ['speaker', 'obs'];
    const forwardKeys = ['ArrowRight', 'ArrowDown', 'End'];
    const backwardKeys = ['ArrowLeft', 'ArrowUp', 'Home'];
    if (!forwardKeys.includes(event.key) && !backwardKeys.includes(event.key)) return;

    event.preventDefault();
    const currentIndex = modes.indexOf(currentMode);
    const nextMode = event.key === 'Home'
      ? modes[0]
      : event.key === 'End'
        ? modes[modes.length - 1]
        : forwardKeys.includes(event.key)
          ? modes[(currentIndex + 1) % modes.length]
          : modes[(currentIndex - 1 + modes.length) % modes.length];
    outputOptionRefs.current[nextMode]?.focus();
    selectOutputMode(nextMode);
  };

  // 부모가 세션 URL을 제거했다면 `prepare*`가 임시로 보관한 같은 세션의 URL도
  // 함께 폐기한다. 그렇지 않으면 종료/교체 뒤에도 설정창이 이전 주소를 근거로
  // 계속 "연결 중"이라고 표시하거나 그 주소를 다시 복사할 수 있다.
  useEffect(() => {
    if (previousOnAirPlayerUrlRef.current && !onAirPlayerUrl) setPreparedPlayerUrl('');
    if (previousOnAirDisplayUrlRef.current && !onAirDisplayUrl) setPreparedDisplayUrl('');
    previousOnAirPlayerUrlRef.current = onAirPlayerUrl;
    previousOnAirDisplayUrlRef.current = onAirDisplayUrl;
  }, [onAirDisplayUrl, onAirPlayerUrl]);

  // 유효성을 잃은 세션의 임시 URL은 부모 URL의 소멸보다 먼저 폐기한다. 부모가
  // 아직 낡은 URL을 들고 있어도 아래 copy gate가 복사를 차단한다.
  useEffect(() => {
    if (!isOnAirInvalid) return;
    setPreparedPlayerUrl('');
    setPreparedDisplayUrl('');
  }, [isOnAirInvalid]);

  useEffect(() => {
    if (!outputRouteStateUnknown) setIsEmergencyStoppingOutput(false);
  }, [outputRouteStateUnknown]);

  useEffect(() => {
    if (!isEmergencyStoppingOutput) return undefined;
    const timer = window.setTimeout(() => {
      setIsEmergencyStoppingOutput(false);
      showToastRef.current?.(t('obs.setup.recovery.emergencyTimeout'), 'error');
      // Dispatch acceptance is not stop proof. If the ACK/snapshot never
      // arrives, rebuild the read side only; do not infer stopped or route audio.
      if (typeof retryOutputControlRef.current === 'function') {
        try {
          Promise.resolve(retryOutputControlRef.current()).catch(() => {
            showToastRef.current?.(t('onair.control.unavailable.failed'), 'error');
          });
        } catch {
          showToastRef.current?.(t('onair.control.unavailable.failed'), 'error');
        }
      }
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [isEmergencyStoppingOutput]);

  const requestControlTakeover = useCallback(() => {
    if (typeof onTakeOverOutputControl !== 'function') {
      setControlTransferPhase('failed');
      return;
    }
    setControlTransferPhase('claiming');
    try {
      Promise.resolve(onTakeOverOutputControl()).catch(() => {
        setControlTransferPhase('failed');
        showToast?.(t('onair.control.takeover.failed'), 'error');
      });
    } catch {
      setControlTransferPhase('failed');
      showToast?.(t('onair.control.takeover.failed'), 'error');
    }
  }, [onTakeOverOutputControl, showToast]);

  useEffect(() => {
    if (!outputControlConflict) {
      setControlTransferPhase('idle');
      return;
    }
    if (controlTransferPhase === 'stopping' && outputControlSafeToTakeOver) {
      requestControlTakeover();
      return;
    }
    if (outputControlTakeover?.status === 'failed') setControlTransferPhase('failed');
  }, [
    controlTransferPhase,
    outputControlConflict,
    outputControlTakeover?.status,
    outputControlSafeToTakeOver,
    requestControlTakeover,
  ]);

  useEffect(() => {
    if (!outputControlUnavailable) setIsRetryingOutputControl(false);
  }, [outputControlUnavailable]);

  useEffect(() => {
    if (controlTransferPhase !== 'stopping' && controlTransferPhase !== 'claiming') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setControlTransferPhase('failed');
      showToastRef.current?.(t('onair.control.takeover.timeout'), 'info');
      // A timed-out takeover command has an unknown local outcome. Rebuild the
      // coordinator to obtain fresh authority evidence before the button can
      // issue another CAS takeover; never retry the pending command in place.
      if (typeof retryOutputControlRef.current === 'function') {
        try {
          Promise.resolve(retryOutputControlRef.current()).catch(() => {
            showToastRef.current?.(t('onair.control.unavailable.failed'), 'error');
          });
        } catch {
          showToastRef.current?.(t('onair.control.unavailable.failed'), 'error');
        }
      }
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [controlTransferPhase]);

  // 대화상자를 열면 제목으로 초점을 옮기고, Tab 초점을 내부에 가둔다.
  // 배경 클릭으로는 닫지 않는다. 이후 오디오 점검이 들어와도 실수로 대화상자만
  // 사라지고 테스트가 계속되는 상태를 만들지 않기 위한 안전한 기본값이다.
  useEffect(() => {
    if (!isObsSetupOpen) return undefined;

    const previouslyFocused = document.activeElement;
    const setupTrigger = obsSetupTriggerRef.current;
    const dialog = obsDialogRef.current;
    const focusFrame = window.requestAnimationFrame(() => obsDialogTitleRef.current?.focus());

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsObsSetupOpen(false);
        return;
      }

      if (event.key !== 'Tab' || !dialog) return;

      const focusableElements = Array.from(dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || activeElement === obsDialogTitleRef.current || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      } else {
        setupTrigger?.focus();
      }
    };
  }, [isObsSetupOpen]);

  const formatTime = (seconds) => {
    if (!seconds || Number.isNaN(seconds)) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  };

  const copyUrl = async (url, successMessage) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast?.(successMessage, 'success');
    } catch {
      showToast?.(t('obs.setup.copyFailed'), 'error');
    }
  };

  const preparePlayer = async () => {
    if (isOnAirInvalid) return '';
    if (playerUrl) return playerUrl;
    if (!onPrepareOnAir) return '';
    setIsPreparingPlayer(true);
    try {
      const url = await onPrepareOnAir();
      setPreparedPlayerUrl(url || '');
      return url;
    } catch (error) {
      showToast?.(error.message || t('obs.setup.player.prepareFailed'), 'error');
      return '';
    } finally {
      setIsPreparingPlayer(false);
    }
  };

  const copyPlayerUrl = async () => {
    if (isOnAirInvalid) return;
    const url = await preparePlayer();
    if (url) copyUrl(url, t('obs.setup.player.urlCopied'));
  };

  const prepareDisplay = async () => {
    if (isOnAirInvalid) return '';
    if (displayUrl) return displayUrl;
    if (!onPrepareOnAirDisplay) return '';
    setIsPreparingDisplay(true);
    try {
      const url = await onPrepareOnAirDisplay();
      setPreparedDisplayUrl(url || '');
      return url;
    } catch (error) {
      showToast?.(error.message || t('obs.setup.display.prepareFailed'), 'error');
      return '';
    } finally {
      setIsPreparingDisplay(false);
    }
  };

  const copyDisplayUrl = async () => {
    if (isOnAirInvalid) return;
    const url = await prepareDisplay();
    if (url) copyUrl(url, t('obs.setup.display.urlCopied'));
  };

  const recoverOnAir = async () => {
    if (isRecoveringOnAir || typeof onRecoverOnAir !== 'function') return;
    setIsRecoveringOnAir(true);
    setPreparedPlayerUrl('');
    setPreparedDisplayUrl('');
    try {
      await onRecoverOnAir();
    } catch (error) {
      showToast?.(error?.message || t('obs.setup.recovery.failed'), 'error');
    } finally {
      setIsRecoveringOnAir(false);
    }
  };

  const emergencyStopOutput = () => {
    if (isEmergencyStoppingOutput || typeof onEmergencyStopOutput !== 'function') return;
    if (!window.confirm(t('obs.setup.recovery.emergencyConfirm'))) return;
    setIsEmergencyStoppingOutput(true);
    try {
      Promise.resolve(onEmergencyStopOutput()).catch((error) => {
        setIsEmergencyStoppingOutput(false);
        showToast?.(error?.message || t('obs.setup.recovery.emergencyFailed'), 'error');
      });
    } catch (error) {
      setIsEmergencyStoppingOutput(false);
      showToast?.(error?.message || t('obs.setup.recovery.emergencyFailed'), 'error');
    }
  };

  const transferControlToThisTab = () => {
    if (controlTransferPhase === 'stopping' || controlTransferPhase === 'claiming') return;
    if (controlTransferPhase === 'failed' && outputControlTakeover?.status === 'pending') {
      retryOutputControl();
      return;
    }
    if (outputControlSafeToTakeOver) {
      requestControlTakeover();
      return;
    }
    if (typeof onEmergencyStopOutput !== 'function') {
      setControlTransferPhase('failed');
      return;
    }
    setControlTransferPhase('stopping');
    try {
      Promise.resolve(onEmergencyStopOutput()).catch(() => {
        setControlTransferPhase('failed');
        showToast?.(t('onair.control.takeover.failed'), 'error');
      });
    } catch {
      setControlTransferPhase('failed');
      showToast?.(t('onair.control.takeover.failed'), 'error');
    }
  };

  const retryOutputControl = () => {
    if (isRetryingOutputControl || typeof onRetryOutputControl !== 'function') return;
    setIsRetryingOutputControl(true);
    try {
      Promise.resolve(onRetryOutputControl()).catch(() => {
        setIsRetryingOutputControl(false);
        showToast?.(t('onair.control.unavailable.failed'), 'error');
      });
    } catch {
      setIsRetryingOutputControl(false);
      showToast?.(t('onair.control.unavailable.failed'), 'error');
    }
  };

  const runObsAudioCheckAction = (operation) => {
    const handler = operation === 'stop' ? onStopObsAudioCheck : onStartObsAudioCheck;
    if (typeof handler !== 'function') return;
    try {
      Promise.resolve(handler()).catch(() => {
        showToast?.(t(operation === 'stop'
          ? 'obs.audioCheck.action.stopFailed'
          : 'obs.audioCheck.action.startFailed'), 'error');
      });
    } catch {
      showToast?.(t(operation === 'stop'
        ? 'obs.audioCheck.action.stopFailed'
        : 'obs.audioCheck.action.startFailed'), 'error');
    }
  };

  const toggleMute = () => {
    if (isMuted) onVolumeChange(previousVolume || 50);
    else {
      setPreviousVolume(volume);
      onVolumeChange(0);
    }
  };

  return (
    <section className="panel playback-panel glass-card" aria-label={t('playback.region.label')}>
      <div className="playback-panel-header">
        <div className="playback-heading"><ListMusic size={17} /> {t('playback.heading')}</div>
        <div className="playback-header-actions">
          <div className="playback-live-badges">
            {currentSong && <span className={`on-air-badge ${isPlaying && !controlsLocked ? '' : 'is-paused'}`}>{phaseBadgeText}</span>}
            <span
              id="output-route-live-status"
              className={`output-route-live-status is-${activeOutputStatus.tone}`}
              role="status"
              aria-live="polite"
            >
              {activeOutputStatus.mode === 'speaker' && <Volume2 size={14} aria-hidden="true" />}
              {activeOutputStatus.mode === 'obs' && <Radio size={14} aria-hidden="true" />}
              {!activeOutputStatus.mode && <span className="obs-status-dot" aria-hidden="true" />}
              {t(activeOutputStatus.key)}
            </span>
          </div>
          <div className="output-route-actions">
            <div
              className="output-route-switch"
              role="radiogroup"
              aria-label={t('onair.output.region.label')}
              aria-disabled={outputSelectionLocked}
            >
              {['speaker', 'obs'].map((mode) => {
                const isSelected = selectedOutputMode === mode;
                const isPending = normalizedOutputSwitchState === 'connecting'
                  && pendingSelectionMode === mode;
                const isOptionDisabled = outputSelectionLocked;
                return (
                  <button
                    key={mode}
                    ref={(element) => { outputOptionRefs.current[mode] = element; }}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-busy={isPending || undefined}
                    aria-disabled={isOptionDisabled}
                    aria-describedby="output-route-live-status"
                    title={isOptionDisabled ? t(outputSelectionLockMessageKey) : undefined}
                    tabIndex={isSelected || (!selectedOutputMode && mode === 'speaker') ? 0 : -1}
                    className={`output-route-button${isSelected ? ' is-selected' : ''}${isPending ? ' is-pending' : ''}`}
                    onClick={() => selectOutputMode(mode)}
                    onKeyDown={(event) => handleOutputOptionKeyDown(event, mode)}
                  >
                    {mode === 'speaker'
                      ? <Volume2 size={15} aria-hidden="true" />
                      : <Radio size={15} aria-hidden="true" />}
                    <span>{outputModeLabel(mode)}</span>
                  </button>
                );
              })}
            </div>
            <button
              ref={obsSetupTriggerRef}
              type="button"
              onClick={() => setIsObsSetupOpen(true)}
              className={`btn-icon output-settings-button${outputNeedsAttention ? ' has-attention' : ''}`}
              title={t(outputNeedsAttention
                ? 'obs.setup.openLabelAttention'
                : 'obs.setup.openLabel')}
              aria-label={t(outputNeedsAttention
                ? 'obs.setup.openLabelAttention'
                : 'obs.setup.openLabel')}
              aria-haspopup="dialog"
              aria-expanded={isObsSetupOpen}
              aria-controls="obs-setup-dialog"
            >
              <Settings size={16} />
              {outputNeedsAttention && (
                <span className="output-settings-alert-dot" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="output-route-next-action" role="note">
            <span>{t('onair.output.nextAction.label')}:</span> {t(outputNextActionKey)}
          </p>
        </div>
      </div>

      {currentSong ? (
        <div className="playback-now">
          <div className="playback-title-row">
            <strong>{currentSong.title}</strong>
          </div>
          <div className="playback-controls">
            {/* finishing/discarding/failed 중 일반 재생 조작 잠금(§4-3, §4-5). */}
            <button type="button" onClick={onTogglePlay} className="btn-icon playback-primary" disabled={transportControlsLocked} title={transportControlsLocked ? t('playback.control.locked') : isPlaying ? t('playback.control.pause') : t('playback.control.play')}>
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button type="button" onClick={toggleMute} className="btn-icon" disabled={transportControlsLocked} title={isMuted ? t('playback.control.unmute') : t('playback.control.mute')}>
              {isMuted ? <VolumeX size={16} /> : volume < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            <input aria-label={t('playback.control.volume')} type="range" min="0" max="100" value={volumeDraft ?? volume} onChange={(event) => setVolumeDraft(Number(event.target.value))} onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} className="volume-slider" disabled={transportControlsLocked} />
            {/* D-01: 클릭 이벤트 객체가 expectedMarker 인자로 넘어가지 않게 인자 없이 호출한다. */}
            <button type="button" onClick={() => onSkip()} className="btn-icon" disabled={transportControlsLocked} title={isFinishing ? t('playback.control.skipFinishing') : isFailed ? t('playback.control.skipFailed') : t('playback.control.skip')}><SkipForward size={17} /></button>
            {isFailed && (
              // §4-5 재시도: 같은 곡을 새 시도(runId)로 다시 재생한다.
              <button type="button" onClick={() => onRetryCurrent?.()} className="btn-icon" disabled={outputAuthorityLocked} title={t('playback.control.retry')}><RotateCcw size={16} /></button>
            )}
            {/* 다시 예약은 새 entryId의 새 QueueEntry 생성이다(§1) — 코디네이터가 팩토리로 처리. */}
            <button
              type="button"
              onClick={() => onRequeueCurrent?.()}
              className="btn-icon"
              title={t('playback.control.requeue')}
            ><Repeat size={16} /></button>
            {/* §4-4 현재 곡 쓰레기통 — finishing 중에도 허용되는 유일한 전이(§4-3). */}
            <button
              type="button"
              onClick={() => onDiscardCurrent?.()}
              className="btn-icon btn-icon-danger"
              disabled={isDiscarding || outputAuthorityLocked}
              title={t('playback.control.discard')}
            ><Trash2 size={15} /></button>
          </div>
          {isFailed ? (
            <div className="playback-progress">
              {/* 실패 사유는 진행 바 자리에 보인다(§1-1 "왜 멈췄는가"). 전체 문구는 title로. */}
              <span className="mr-unavailable" title={failureDetail || t('playback.failure.default')}>
                {t('playback.failure.withAction', { detail: (failureDetail || t('playback.failure.default')).slice(0, 48) })}
              </span>
            </div>
          ) : (
            <div className="playback-progress">
              <span>{formatTime(currentTime)}</span>
              <input aria-label={t('playback.control.seek')} type="range" min="0" max={duration || 100} value={seekDraft ?? currentTime} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} className="progress-slider" disabled={transportControlsLocked} />
              <span>{formatTime(duration)}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="playback-idle"><Play size={17} /> {t('playback.idle')}</div>
      )}

      {isObsSetupOpen && (
        <div className="obs-setup-backdrop" role="presentation">
          <section
            id="obs-setup-dialog"
            ref={obsDialogRef}
            className="obs-setup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="obs-setup-title"
            aria-describedby="obs-setup-description"
            tabIndex={-1}
          >
            <header>
              <div>
                <span className="obs-setup-eyebrow">{t('obs.setup.eyebrow')}</span>
                <h2 id="obs-setup-title" ref={obsDialogTitleRef} tabIndex={-1}>{t('obs.setup.title')}</h2>
              </div>
              <button type="button" className="btn-icon" onClick={() => setIsObsSetupOpen(false)} aria-label={t('obs.setup.closeLabel')}><X size={18} /></button>
            </header>

            <p id="obs-setup-description" className="obs-setup-intro">
              {t('obs.setup.intro')}
            </p>

            <section className="output-route-details" aria-labelledby="output-route-details-title">
              <header>
                <div>
                  <h3 id="output-route-details-title">{t('onair.output.details.title')}</h3>
                  <p>{t('onair.output.details.description')}</p>
                </div>
                <span className={`output-route-live-status is-${activeOutputStatus.tone}`}>
                  {activeOutputStatus.mode === 'speaker' && <Volume2 size={14} aria-hidden="true" />}
                  {activeOutputStatus.mode === 'obs' && <Radio size={14} aria-hidden="true" />}
                  {!activeOutputStatus.mode && <span className="obs-status-dot" aria-hidden="true" />}
                  {t(activeOutputStatus.key)}
                </span>
              </header>
              <div className="output-route-details-summary">
                <span>{t('onair.output.selector.status.selected', { mode: outputModeLabel(selectedOutputMode) })}</span>
                <span>{t('onair.output.selector.status.actual', { mode: outputModeLabel(confirmedOutputMode) })}</span>
              </div>
              <div
                className={`output-route-details-status is-${normalizedOutputSwitchState}`}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {normalizedOutputSwitchState === 'switching' && (
                  <strong>{t('onair.output.selector.status.switching')}</strong>
                )}
                {normalizedOutputSwitchState === 'connecting' && (
                  <strong>{t('onair.output.selector.status.connecting')}</strong>
                )}
                {normalizedOutputSwitchState === 'conflict' && (
                  <strong>{t('onair.output.selector.status.otherTab')}</strong>
                )}
                {normalizedOutputSwitchState === 'blocked' && (
                  <strong>{t(
                    failedSelectionMode
                      ? 'onair.output.selector.status.blockedTarget'
                      : 'onair.output.selector.status.blocked',
                    failedSelectionMode
                      ? { mode: outputModeLabel(failedSelectionMode) }
                      : {},
                  )}</strong>
                )}
              </div>
              {outputView?.messageKey && (
                <p className="output-route-authoritative-detail">{t(outputView.messageKey)}</p>
              )}
              {confirmedOutputMode === 'obs' && (
                <p className="output-route-obs-silence-note" role="note">
                  {t('obs.audioCheck.localSpeakerSilent')}
                </p>
              )}
            </section>

            <section className={`obs-audio-check is-${obsAudioCheckStage}`} aria-labelledby="obs-audio-check-title">
              <header>
                <div>
                  <h3 id="obs-audio-check-title">{t('obs.audioCheck.title')}</h3>
                  <p id="obs-audio-check-scope">{t('obs.audioCheck.scope')}</p>
                </div>
                <span
                  id="obs-audio-check-status"
                  className="obs-audio-check-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {t(obsAudioCheck?.messageKey ?? 'obs.audioCheck.stage.unknown', {
                    count: obsAudioCheck?.markerCount ?? 0,
                    seconds: obsAudioCheckMarkerSeconds,
                    duration: obsAudioCheckDurationSeconds,
                  })}
                </span>
              </header>

              {obsAudioCheck?.requestObserved && (
                <div className="obs-audio-check-evidence" role="list" aria-label={t('obs.audioCheck.evidence.label')}>
                  <span className="is-proven" role="listitem">
                    <Check size={12} aria-hidden="true" /> {t('obs.audioCheck.evidence.requested')}
                  </span>
                  <span className={obsAudioCheck.actualPlayingObserved ? 'is-proven' : ''} role="listitem">
                    {obsAudioCheck.actualPlayingObserved && <Check size={12} aria-hidden="true" />}
                    {t(obsAudioCheck.actualPlayingObserved
                      ? 'obs.audioCheck.evidence.playing'
                      : 'obs.audioCheck.evidence.playingPending')}
                  </span>
                  <span className={obsAudioCheck.markerCount > 0 ? 'is-proven' : ''} role="listitem">
                    {obsAudioCheck.markerCount > 0 && <Check size={12} aria-hidden="true" />}
                    {t(obsAudioCheck.markerCount > 0
                      ? 'obs.audioCheck.evidence.markers'
                      : 'obs.audioCheck.evidence.markersPending', {
                      count: obsAudioCheck.markerCount,
                    })}
                  </span>
                </div>
              )}

              {obsAudioCheck?.markerCount > 0 && obsAudioCheck?.active && (
                <progress
                  className="obs-audio-check-progress"
                  max={obsAudioCheck.durationMs}
                  value={Math.min(obsAudioCheck.markerTimeMs, obsAudioCheck.durationMs)}
                  aria-label={t('obs.audioCheck.progressLabel', {
                    seconds: obsAudioCheckMarkerSeconds,
                    duration: obsAudioCheckDurationSeconds,
                  })}
                />
              )}

              <p id="obs-audio-check-prompt" className="obs-audio-check-prompt">
                {t('obs.audioCheck.mixerPrompt')}
              </p>
              <div className="obs-audio-check-actions">
                {shouldOfferObsAudioCheckStop ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => runObsAudioCheckAction('stop')}
                    disabled={!obsAudioCheck?.canStop || typeof onStopObsAudioCheck !== 'function'}
                    aria-describedby="obs-audio-check-scope obs-audio-check-status obs-audio-check-prompt"
                  >
                    {t(obsAudioCheck?.pendingOperation === 'stop'
                      ? 'obs.audioCheck.action.stopping'
                      : 'obs.audioCheck.action.stop')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => runObsAudioCheckAction('start')}
                    disabled={!obsAudioCheck?.canStart || typeof onStartObsAudioCheck !== 'function'}
                    aria-describedby="obs-audio-check-scope obs-audio-check-status obs-audio-check-prompt"
                  >
                    {t(obsAudioCheck?.pendingOperation === 'start'
                      ? 'obs.audioCheck.action.requesting'
                      : obsAudioCheck?.completed || obsAudioCheck?.cancelled || obsAudioCheck?.failed
                        ? 'obs.audioCheck.action.retry'
                        : 'obs.audioCheck.action.start')}
                  </button>
                )}
              </div>
            </section>

            {!isDirectMode && !isOnAirInvalid && (
              <p className="obs-session-url-note" role="note">
                {t('obs.setup.sessionUrl')}
              </p>
            )}

            {isOnAirInvalid && (
              <div className="obs-recovery-alert" role="alert">
                <p>{t(onAirStatus === 'ended'
                  ? 'obs.setup.recovery.ended'
                  : 'obs.setup.recovery.invalid')}</p>
                <button
                  type="button"
                  className="btn-secondary obs-recovery-action"
                  onClick={recoverOnAir}
                  disabled={isRecoveringOnAir || typeof onRecoverOnAir !== 'function'}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {isRecoveringOnAir
                    ? t('obs.setup.recovery.inProgress')
                    : t('obs.setup.recovery.action')}
                </button>
              </div>
            )}

            {outputControlConflict && (
              <div className="obs-control-transfer" role="status">
                <div>
                  <strong>{t('onair.control.otherTab.title')}</strong>
                  <p>{t('onair.control.otherTab.description')}</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary obs-recovery-action"
                  onClick={transferControlToThisTab}
                  disabled={controlTransferPhase === 'stopping'
                    || controlTransferPhase === 'claiming'
                    || typeof onTakeOverOutputControl !== 'function'}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {controlTransferPhase === 'stopping'
                    ? t('onair.control.takeover.stopping')
                    : controlTransferPhase === 'claiming'
                      ? t('onair.control.takeover.claiming')
                      : controlTransferPhase === 'failed'
                        ? t('onair.control.takeover.retry')
                        : outputControlSafeToTakeOver
                          ? t('onair.control.takeover.action')
                          : t('onair.control.takeover.stopAndAction')}
                </button>
              </div>
            )}

            {outputControlUnavailable && !isOnAirInvalid && (
              <div className="obs-control-transfer" role="status">
                <div>
                  <strong>{t(outputRecoveryTitleMessageKey)}</strong>
                  <p>{t(outputRecoveryDescriptionMessageKey)}</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary obs-recovery-action"
                  onClick={retryOutputControl}
                  disabled={isRetryingOutputControl || typeof onRetryOutputControl !== 'function'}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {isRetryingOutputControl
                    ? t('onair.control.unavailable.inProgress')
                    : t('onair.control.unavailable.action')}
                </button>
              </div>
            )}

            {outputRecoveryNeedsEmergencyStop && !outputControlConflict && (
              <div className="obs-recovery-alert" role="alert">
                <p>{t('obs.setup.recovery.routeUnknown')}</p>
                <button
                  type="button"
                  className="btn-secondary obs-recovery-action"
                  onClick={emergencyStopOutput}
                  disabled={isEmergencyStoppingOutput || typeof onEmergencyStopOutput !== 'function'}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {isEmergencyStoppingOutput
                    ? t('obs.setup.recovery.emergencyInProgress')
                    : t('onair.output.action.emergencyStop.label')}
                </button>
              </div>
            )}

            {/* 대시보드↔서버(control) 상태 — 아래 위젯 연결 칩과는 별개의 정보라
                무채색 한 줄로 구분한다. "서버 준비"를 위젯 연결로 오해하지 않게. */}
            {!isDirectMode && !isOnAirInvalid && (
              <p className="obs-server-note">
                <span className={`obs-status-dot ${onAirStatus === 'connected' ? 'is-live' : ''}`} aria-hidden="true" />
                {onAirStatus === 'connected'
                  ? t('obs.setup.server.connected')
                  : (playerUrl || displayUrl)
                    ? t('obs.setup.server.connecting')
                    : t('obs.setup.server.notStarted')}
              </p>
            )}

            <ol className="obs-setup-steps">
              <li>
                <span className="obs-setup-step-icon"><Radio size={18} /></span>
                <div>
                  <strong>{t('obs.setup.player.stepTitle')} <span className="obs-step-requirement is-required">{t('obs.setup.player.requirement')}</span></strong>
                  <p>{t('obs.setup.player.instruction')}</p>
                  <button type="button" onClick={copyPlayerUrl} className="btn-copy" disabled={isPreparingPlayer || isOnAirInvalid || onAirStatus === 'unconfigured'}>
                    {isOnAirInvalid
                      ? t('obs.setup.recovery.copyBlocked')
                      : isPreparingPlayer
                        ? t('obs.setup.player.preparing')
                        : <><Copy size={14} /> {playerUrl ? t('obs.setup.player.copyUrl') : t('obs.setup.player.prepareAndCopy')}</>}
                  </button>
                  {isOnAirInvalid ? null : isDirectMode ? (
                    <span className="obs-player-status is-waiting">
                      <span className="obs-status-dot" aria-hidden="true" /> {t('obs.setup.player.serverRequired')}
                    </span>
                  ) : (
                    // 이 presence는 일반 player 페이지 연결만 뜻한다. OBS CEF 또는
                    // 최종 방송 오디오가 확인됐다는 의미로 사용하지 않는다.
                    <WidgetStatusChip
                      candidateState={onAirPlayerCandidate?.state ?? 'unknown'}
                      connectedLabel={t('obs.setup.player.candidate.single')}
                      waitingLabel={t('obs.setup.player.candidate.none')}
                      duplicateLabel={t('obs.setup.player.candidate.duplicate', {
                        count: onAirPlayerCandidate?.count ?? 0,
                      })}
                      unknownLabel={t('obs.setup.player.candidate.unknown')}
                    />
                  )}
                </div>
              </li>
              <li>
                <span className="obs-setup-step-icon"><MonitorUp size={18} /></span>
                <div>
                  <strong>{t('obs.setup.display.stepTitle')} <span className="obs-step-requirement">{t('obs.setup.display.requirement')}</span></strong>
                  <p>{t('obs.setup.display.instruction')}</p>
                  {isDirectMode ? (
                    // N-01: On-Air 서버가 없는 직접 재생 모드에서는 room&key 구독형
                    // 위젯 주소를 복사한다. 표시 내용은 축소 projection(현재 곡·setlist)뿐이다.
                    <button
                      type="button"
                      onClick={() => copyUrl(directWidgetUrl, t('obs.setup.display.directUrlCopied'))}
                      className="btn-copy"
                      disabled={!directWidgetUrl}
                      title={directWidgetUrl ? t('obs.setup.display.directUrlTitle') : t('obs.setup.display.directUrlPendingTitle')}
                    >
                      <Copy size={14} /> {directWidgetUrl ? t('obs.setup.display.copyUrl') : t('obs.setup.display.keyPreparing')}
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={copyDisplayUrl} className="btn-copy" disabled={isPreparingDisplay || isOnAirInvalid}>
                        {isOnAirInvalid
                          ? t('obs.setup.recovery.copyBlocked')
                          : isPreparingDisplay
                            ? t('obs.setup.player.preparing')
                            : <><Copy size={14} /> {displayUrl ? t('obs.setup.display.copyUrl') : t('obs.setup.display.prepareAndCopy')}</>}
                      </button>
                      {!isOnAirInvalid && (
                        <WidgetStatusChip
                          connected={Boolean(onAirDisplayConnected)}
                          connectedLabel={t('obs.setup.display.connected')}
                          waitingLabel={t('obs.setup.display.waiting')}
                        />
                      )}
                    </>
                  )}
                </div>
              </li>
            </ol>

            <section className="obs-source-settings" aria-labelledby="obs-source-settings-title">
              <h3 id="obs-source-settings-title">{t('obs.setup.lifecycle.title')}</h3>
              <ul>
                <li><strong>{t('obs.setup.lifecycle.shutdownSetting')}</strong>: {t('obs.setup.lifecycle.shutdownGuidance')}</li>
                <li><strong>{t('obs.setup.lifecycle.refreshSetting')}</strong>: {t('obs.setup.lifecycle.refreshGuidance')}</li>
              </ul>
              <p>{t('obs.setup.lifecycle.policyNote')}</p>
            </section>

            {onEndBroadcastSession && (
              <div className="obs-session-actions">
                <p>{t('obs.setup.session.endDescription')}</p>
                {!canEndBroadcastSession && (
                  <p className="obs-session-end-blocked" role="status">
                    {t('obs.setup.session.endBlocked')}
                  </p>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!canEndBroadcastSession}
                  onClick={() => {
                    if (window.confirm(t('obs.setup.session.endConfirm'))) {
                      onEndBroadcastSession();
                      setIsObsSetupOpen(false);
                    }
                  }}
                >{t('obs.setup.session.endButton')}</button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
