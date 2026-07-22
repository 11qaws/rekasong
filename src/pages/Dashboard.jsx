import React, { lazy, Suspense, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import { useAiTitleExtraction } from '../hooks/useAiTitleExtraction';
import { useOnAirSession } from '../hooks/useOnAirSession';
import {
  ON_AIR_OUTPUT_CONTROL_CODES,
  useOnAirOutputControl,
} from '../hooks/useOnAirOutputControl';
import {
  createQueueEntry,
  isExpiredLocalSongDef,
  newId,
  sanitizeSongDef,
  toLegacySong,
  toQueueEntry,
} from '../lib/queueEntry';
import {
  collectBlobSrcs,
  isBlobReferenced,
  isLocalBlobSong,
  planLocalBlobHistoryBudget,
  restoreLocalBlobSong,
  revokeBlobSrcs,
} from '../lib/blobLifecycle';
import { createBoundedCommandQueue } from '../lib/boundedCommandQueue';
import { apiUrl } from '../lib/api';
import {
  isConfirmedDiscardSnapshot,
  isConfirmedDiscardStop,
} from '../lib/dashboardPlaybackSafety';
import { onAirSessionRecoveryGate } from '../lib/onAirSessionRecoveryGate';
import {
  OUTPUT_CONTROL_AUTHORITY_STATES,
  deriveOutputControlAuthority,
  isSafeOutputControlTakeover,
} from '../lib/outputControlAuthority';
import { deriveObsAudioCheckView } from '../lib/obsAudioCheckView';
import {
  loadOutputVolumeProfiles,
  outputVolumeForMode,
  saveOutputVolumeProfiles,
  updateOutputVolumeProfile,
} from '../lib/outputVolumeProfiles';
import {
  DEFAULT_SPEAKER_OUTPUT_DEVICE,
  applySpeakerOutputDevice,
  loadSpeakerOutputDevice,
  requestSpeakerOutputDevice,
  saveSpeakerOutputDevice,
  supportsSpeakerOutputDeviceSelection,
} from '../lib/speakerOutputDevice';
import { createSpeakerMediaSessionController } from '../lib/speakerMediaSession';
import {
  OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS,
  createObsRemoteControlFeedback,
  obsRemoteControlFeedbackMatchesRun,
  reconcileObsRemoteControlFeedback,
} from '../lib/obsRemoteControlFeedback';
import {
  OBS_MIXER_VERIFICATION_OUTCOMES,
  createObsMixerVerification,
  deriveObsMixerVerificationView,
  loadObsMixerVerification,
  saveObsMixerVerification,
} from '../lib/obsMixerVerification';
import {
  outputSwitchFailureMessageKey,
} from '../copy/outputMessages';
import { getAppMessage as t } from '../copy/appMessages';
import { useAppLocale } from '../hooks/useAppLocale';
import {
  YOUTUBE_ID_PATTERN,
  fetchPrepareStatus,
  isPrepareConfigured,
  prepareBlockMessage,
  prepareFailureInfo,
  prepareSessionIdentity,
  requestPrepare,
  songPrepareState
} from '../lib/preparePipeline';
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js';
import PlaybackPanel from '../components/PlaybackPanel';
import QueuePanel from '../components/QueuePanel';
import SongComposer from '../components/SongComposer';
import SongDropTray from '../components/SongDropTray';
import ErrorBoundary from '../components/ErrorBoundary';
import {
  SONG_DROP_ACTIONS,
  planSongDropAction,
  stagedItemFromSongDragCandidate,
} from '../lib/songDragAction';
import './Dashboard.css';

const OUTPUT_INTENT_WAIT_TIMEOUT_MS = 8_000;
const LOCAL_SPEAKER_COMMAND_WAIT_TIMEOUT_MS = 12_000;
const LOCAL_FILE_MAX_BYTES = 200 * 1024 * 1024;

const DashboardLocalSpeaker = lazy(() => import('../components/DashboardLocalSpeaker'));

const songbookCacheKey = (source, songbookId) => `${source}:${songbookId}`;
const EMPTY_PREPARE_STATES = Object.freeze({});

const toDisplaySong = (song) => {
  if (!song?.id || !song?.title) return null;
  const type = song.type === 'youtube' ? 'youtube' : 'local';
  return {
    id: String(song.id),
    title: String(song.title),
    type,
    src: type === 'youtube' ? String(song.src || '') : '',
    tags: Array.isArray(song.tags) ? song.tags : []
  };
};

const toDisplayState = (state) => ({
  currentSong: toDisplaySong(state?.currentSong),
  history: Array.isArray(state?.history) ? state.history.map(toDisplaySong).filter(Boolean).slice(-100) : []
});

// Stage 5 (N-08/D-14): 원격 위젯 발행 projection.
// 공개 ntfy 토픽(rekasong-{room})은 서명으로 위변조만 막을 뿐 열람은 못 막으므로
// (PHASE_08 §3-1), payload 자체가 '시청자에게 보여도 되는 것'만 담아야 한다.
// 위젯이 실제 표시하는 필드만 화이트리스트로 내보낸다 — 대기열(시청자 비공개
// 설계, Widget.jsx 주석)·노래책 카탈로그·멜로밍 채널 ID·MR 캐시·설정은 어떤
// 발행 경로(BroadcastChannel/localStorage/dev API/ntfy)에도 싣지 않는다.
const WIDGET_HISTORY_LIMIT = 50; // D-29/D-14: 발행 history 상한 — payload 비대 방지

const toWidgetSong = (entry, extra = {}) => {
  const song = entry?.song;
  if (!entry?.entryId || !song?.title) return null;
  const type = song.type === 'youtube' ? 'youtube' : 'local';
  return {
    // 구버전 위젯 하위호환: entryId를 구 스키마의 id 자리에 넣는다(toLegacySong 규약).
    id: String(entry.entryId),
    title: String(song.title),
    artist: typeof song.artist === 'string' ? song.artist : '',
    type,
    // 로컬 src(blob:/세션 자산 id)는 위젯에서 재생 불가·정보 노출만 된다 — youtube id만.
    src: type === 'youtube' ? String(song.src || '') : '',
    tags: Array.isArray(song.tags) ? song.tags : [],
    source: typeof song.source === 'string' && song.source ? song.source : type,
    completionReason: entry.completionReason || null,
    ...extra
  };
};

// On-Air transport status → 생애주기 phase (§2-1) 근사 매핑.
const onAirStatusToPhase = (status) => {
  if (status === 'playing') return 'playing';
  if (status === 'paused') return 'paused';
  if (status === 'buffering') return 'buffering';
  return 'starting';
};

export default function Dashboard() {
  const { locale, setLocale } = useAppLocale();
  useEffect(() => {
    document.body.classList.add('dashboard-page');
    return () => document.body.classList.remove('dashboard-page');
  }, []);

  const [state, setSharedState, syncLoadNotice] = useSyncState();
  const [queuedOutputIntent, setQueuedOutputIntent] = useState(null);
  const [outputControlRecoveryRequired, setOutputControlRecoveryRequired] = useState(false);
  const [outputControllerEverReady, setOutputControllerEverReady] = useState(false);
  // Every dashboard tab starts as an ordinary local music player. OBS is an
  // explicit opt-in for this visit; a stale browser preference must never make
  // a returning listener wait for a broadcast route.
  const [outputModePreference, setOutputModePreference] = useState('speaker');
  const [localSpeakerState, setLocalSpeakerState] = useState('initializing');
  const [obsMixerVerificationRecord, setObsMixerVerificationRecord] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      return loadObsMixerVerification(window.localStorage);
    } catch {
      return null;
    }
  });
  const outputIntentSequenceRef = useRef(0);
  const claimedOutputIntentRef = useRef(null);
  const localSpeakerRef = useRef(null);
  const localSpeakerCommandQueueRef = useRef(null);
  if (!localSpeakerCommandQueueRef.current) {
    localSpeakerCommandQueueRef.current = createBoundedCommandQueue({
      timeoutMs: LOCAL_SPEAKER_COMMAND_WAIT_TIMEOUT_MS,
      timeoutError: () => new Error(t('playback.localSpeaker.notReady')),
    });
  }
  const beginPlaybackRunRef = useRef(null);
  const currentEntry = state?.currentEntry || null;
  const active = state?.active || null;
  const history = useMemo(() => Array.isArray(state?.history) ? state.history : [], [state?.history]);
  // 하위호환 투영: 위젯·On-Air display·기존 패널 표시는 평면 곡을 소비한다.
  const currentSong = useMemo(() => (currentEntry ? toLegacySong(currentEntry) : null), [currentEntry]);
  const legacyHistory = useMemo(() => history.map(toLegacySong).filter(Boolean), [history]);
  // (Stage 5) 큐의 평면 투영은 더 이상 만들지 않는다 — 대기열은 시청자 비공개
  // 설계라 원격 발행 payload에 절대 싣지 않는다(N-08).

  const onAirEventHandlerRef = useRef(null);
  const onAir = useOnAirSession(
    (payload) => onAirEventHandlerRef.current?.(payload),
    { observeOnly: true }
  );
  const useOnAirPlayer = onAir.configured;
  const onAirSession = onAir.session;
  const onAirSessionState = onAir.connectionState;
  const onAirDisplayToken = onAirSession?.displayToken;
  const createFreshOnAirSession = onAir.createFreshSession;
  const ensureOnAirSession = onAir.ensureSession;
  const retryLocalSpeakerSession = useCallback(() => {
    if (!useOnAirPlayer) return Promise.resolve(null);
    if (onAirSession) return Promise.resolve(onAirSession);
    setLocalSpeakerState('initializing');
    return Promise.resolve(ensureOnAirSession()).catch((error) => {
      setLocalSpeakerState('failed');
      localSpeakerCommandQueueRef.current.rejectAll(error);
      throw error;
    });
  }, [ensureOnAirSession, onAirSession, useOnAirPlayer]);
  const outputControl = useOnAirOutputControl({
    session: onAirSession,
    baseUrl: onAir.baseUrl,
    // Protocol v2 owns its control lease. A transient legacy observer reconnect
    // must not dispose that owner in the middle of a run.
    enabled: onAir.configured
      && Boolean(onAirSession)
      && !['invalid', 'ended'].includes(onAirSessionState)
  });
  const sendOnAirCommand = outputControl.sendCommand;
  const selectOnAirOutputMode = outputControl.selectOutputMode;
  const retryOnAirOutputControl = outputControl.retryConnection;
  const playbackTransitionState = outputControl.playbackTransitionState;
  const outputControlAuthority = deriveOutputControlAuthority(outputControl.snapshot);
  const outputConnectionState = outputControl.snapshot?.state ?? 'idle';
  const outputControllerReady = outputControlAuthority.writable;
  const outputControlTakeoverPending = outputControl.snapshot?.pendingTakeover?.status === 'pending';
  const outputControlConfirmedReason = outputControl.snapshot?.confirmedPlayback?.reasonCode
    ?? outputControl.snapshot?.playerSnapshot?.confirmedPlayback?.reasonCode
    ?? null;
  const outputControlRecoveryReason = outputControl.outputSwitchState?.reasonCode
    === ON_AIR_OUTPUT_CONTROL_CODES.CONNECTION_TIMEOUT
    ? 'connection_timeout'
    : outputControl.outputSwitchState?.reasonCode === ON_AIR_OUTPUT_CONTROL_CODES.SWITCH_TIMEOUT
      || outputControlConfirmedReason === 'route_transition_timeout'
      ? 'switch_timeout'
      : null;
  const outputControlConflict = outputControlTakeoverPending
    || outputControlAuthority.state === OUTPUT_CONTROL_AUTHORITY_STATES.OTHER_OWNER;
  const outputControlUnavailable = !outputControlTakeoverPending
    && (outputControlAuthority.state === OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE
      || Boolean(outputControlRecoveryReason));
  const outputControlSafeToTakeOver = isSafeOutputControlTakeover(outputControl.snapshot);
  const outputBootstrapSelectionAvailable = Boolean(
    !outputControllerEverReady
    && !outputControllerReady
    && !outputControlConflict
    && !outputControlUnavailable
    && !outputControlRecoveryReason
    && !['invalid', 'ended'].includes(onAirSessionState),
  );

  useEffect(() => {
    if (outputControllerReady) setOutputControllerEverReady(true);
  }, [outputControllerReady]);

  // A route click may arrive before the control socket has produced an
  // authoritative writable observation. Keep the intent bounded: without a
  // watchdog it remains queued forever and every subsequent click is a
  // no-op. Reconnect once and surface the concrete recovery action instead.
  useEffect(() => {
    if (outputControllerReady) {
      setOutputControlRecoveryRequired(false);
      return undefined;
    }
    if (!queuedOutputIntent) return undefined;
    const intentId = queuedOutputIntent.id;
    const timer = window.setTimeout(() => {
      setQueuedOutputIntent((current) => (current?.id === intentId ? null : current));
      setOutputControlRecoveryRequired(true);
      try {
        retryOnAirOutputControl();
      } catch {
        // The settings panel remains the explicit manual recovery path.
      }
    }, OUTPUT_INTENT_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [outputControllerReady, queuedOutputIntent, retryOnAirOutputControl]);

  const outputControlSessionKey = onAirSession?.room && onAirSession?.controlToken
    ? `${onAirSession.room}:${onAirSession.controlToken}`
    : null;
  const actualOutputMode = outputControl.actualOutputMode;
  const outputSwitchStatus = outputControl.outputSwitchState?.status || 'idle';
  const outputSwitchTargetMode = ['speaker', 'obs'].includes(
    outputControl.outputSwitchState?.targetMode,
  )
    ? outputControl.outputSwitchState.targetMode
    : null;
  // Speaker is a browser-local listening choice, not a Worker lease. Keep the
  // user's local choice authoritative even when a previously prepared OBS
  // route remains connected and silent in the background. This lets any
  // number of tabs listen locally without contending for one output owner.
  const selectedOutputMode = outputModePreference;
  const speakerPlayerMode = selectedOutputMode === 'speaker';
  const failedOutputMode = outputSwitchStatus === 'blocked'
    ? outputSwitchTargetMode
    : null;
  const activeOutputLease = outputControl.snapshot?.playerSnapshot?.lease;
  const activeOutputPlayer = outputControl.snapshot?.playerSnapshot?.players?.find((player) => (
    player?.playerInstanceId === activeOutputLease?.leaseTarget
  )) ?? null;
  const establishedObsRouteConnected = Boolean(
    outputControllerReady
    && actualOutputMode === 'obs'
    && outputControl.requestedOutputMode === actualOutputMode
    && outputSwitchStatus === 'idle'
    && ['ready', 'audible'].includes(activeOutputLease?.status)
    && activeOutputPlayer?.clientKind === 'obs-browser-source'
  );
  // Speaker is the selected local output even when an HTTP media-session
  // bootstrap or lazy chunk fails. Those are retryable per-play media errors,
  // never evidence that the user's Speaker route needs verification.
  const outputRouteStable = speakerPlayerMode ? true : establishedObsRouteConnected;
  const outputSwitchUiState = speakerPlayerMode
    ? 'idle'
    : outputControlConflict
      ? 'conflict'
      : outputControlUnavailable
        ? 'blocked'
        : !outputControllerReady
          ? 'connecting'
    : outputSwitchStatus === 'deactivating' || outputSwitchStatus === 'activating'
      ? 'switching'
      : outputSwitchStatus === 'blocked' ? 'blocked' : 'idle';
  const obsSourceTemporarilyInactive = establishedObsRouteConnected && Boolean(
    activeOutputPlayer?.runtime?.sourceActive === false
    || activeOutputPlayer?.runtime?.sourceVisible === false
  );
  const playbackOutputView = speakerPlayerMode
    ? {
      ...outputControl.outputView,
      statusCode: 'speaker_local',
      messageKey: 'onair.output.status.speaker.localReady',
    }
    : obsSourceTemporarilyInactive
      ? {
        ...outputControl.outputView,
        statusCode: 'obs_scene_inactive',
        messageKey: 'onair.output.status.obs.sceneInactive',
      }
      : establishedObsRouteConnected && activeOutputPlayer?.heartbeatStale
      ? {
        ...outputControl.outputView,
        statusCode: 'obs_heartbeat_delayed',
        messageKey: 'onair.output.status.obs.heartbeatDelayed',
      }
      : outputControl.outputView;
  const obsPlayerCandidate = outputControl.outputView?.candidates?.obs ?? null;
  const connectedObsPlayers = outputControl.snapshot?.playerSnapshot?.players?.filter((player) => (
    player?.clientKind === 'obs-browser-source'
  )) ?? [];
  // A connected Browser Source that explicitly reports inactive/hidden is a
  // concrete OBS setup state, not an unknown route that needs destructive
  // reset. Initial unobserved runtime remains valid; only callback-proven false
  // reaches this branch.
  const obsSourceInactive = connectedObsPlayers.length === 1 && Boolean(
    connectedObsPlayers[0]?.runtime?.sourceActive === false
    || connectedObsPlayers[0]?.runtime?.sourceVisible === false
  );
  const obsAudioCheck = deriveObsAudioCheckView({
    snapshot: outputControl.snapshot,
    actualOutputMode,
    outputRouteStable,
    obsSourceInactive,
    outputSwitchState: outputControl.outputSwitchState,
    playbackTransitionState,
  });
  const obsMixerPlayerInstanceId = activeOutputLease?.clientKind === 'obs-browser-source'
    ? activeOutputLease.leaseTarget
    : null;
  const obsMixerVerification = deriveObsMixerVerificationView({
    record: obsMixerVerificationRecord,
    room: onAirSession?.room ?? null,
    playerInstanceId: obsMixerPlayerInstanceId,
    obsAudioCheck,
  });
  const canEndBroadcastSession = !useOnAirPlayer || Boolean(
    outputControllerReady
    && !currentEntry
    && outputControl.snapshot?.activeRun === null
    && outputControl.snapshot?.playerSnapshot?.activeFamily === null
    && outputControl.snapshot?.playerSnapshot?.activeCheckId === null
    && outputControl.snapshot?.pendingSwitch === null
    && outputControl.snapshot?.pendingTest === null
    && ['inactive', 'ready'].includes(activeOutputLease?.status)
  );

  // A follower can receive a read-only welcome just before the old owner closes.
  // The Worker then publishes owner=null, but the welcome cannot promote itself.
  // Re-negotiate exactly once per released-owner epoch; no playback command is
  // replayed, and a still-connected foreign owner never triggers this path.
  const releasedOwnerRetryRef = useRef(null);
  useEffect(() => {
    if (!outputControlAuthority.shouldRetryReleasedOwner || !onAirSession?.room) return undefined;
    const retryKey = `${onAirSession.room}:${outputControlAuthority.controlEpoch ?? 'unknown'}`;
    if (releasedOwnerRetryRef.current === retryKey) return undefined;
    releasedOwnerRetryRef.current = retryKey;
    const timer = window.setTimeout(() => {
      try {
        retryOnAirOutputControl();
      } catch {
        // The explicit unavailable state remains visible; never spin retries.
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [
    onAirSession?.room,
    retryOnAirOutputControl,
    outputControlAuthority.controlEpoch,
    outputControlAuthority.shouldRetryReleasedOwner,
  ]);

  // A transport drop is different from another-tab ownership. Rebuild the
  // coordinator a few times with bounded delays, preserving the page identity
  // and never replaying an unresolved playback/output command.
  const reconnectPolicyRef = useRef({ sessionKey: null, attempts: 0 });
  useEffect(() => {
    const sessionKey = onAirSession?.room && onAirSession?.controlToken
      ? `${onAirSession.room}:${onAirSession.controlToken}`
      : null;
    if (reconnectPolicyRef.current.sessionKey !== sessionKey) {
      reconnectPolicyRef.current = { sessionKey, attempts: 0 };
    }
    if (outputControl.snapshot?.ready === true) {
      // Do not replenish the budget on a connection that flaps READY→closed.
      // Only a genuinely stable interval starts a fresh recovery window.
      const stableTimer = window.setTimeout(() => {
        if (reconnectPolicyRef.current.sessionKey === sessionKey) {
          reconnectPolicyRef.current.attempts = 0;
        }
      }, 10_000);
      return () => window.clearTimeout(stableTimer);
    }
    if (!sessionKey || !['disconnected', 'superseded', 'closed'].includes(outputConnectionState)) {
      return undefined;
    }
    const delays = [350, 1_200, 3_000];
    const attempt = reconnectPolicyRef.current.attempts;
    if (attempt >= delays.length) return undefined;
    reconnectPolicyRef.current.attempts += 1;
    const timer = window.setTimeout(() => {
      try {
        retryOnAirOutputControl();
      } catch {
        // The settings panel keeps the exact disconnected state and a manual
        // retry action visible after bounded automatic recovery is exhausted.
      }
    }, delays[attempt]);
    return () => window.clearTimeout(timer);
  }, [
    onAirSession?.controlToken,
    onAirSession?.room,
    outputConnectionState,
    retryOnAirOutputControl,
    outputControl.snapshot?.ready,
  ]);

  const retryOutputControlNow = useCallback(() => {
    reconnectPolicyRef.current.attempts = 0;
    return retryOnAirOutputControl();
  }, [retryOnAirOutputControl]);

  // Audio Controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [volumeProfiles, setVolumeProfiles] = useState(() => (
    loadOutputVolumeProfiles(typeof window === 'undefined' ? null : window.localStorage)
  ));
  const volumeProfilesRef = useRef(volumeProfiles);
  volumeProfilesRef.current = volumeProfiles;
  // A running PlaybackRun owns the volume target. With no run, the user's
  // selected output decides which durable profile the control previews.
  const volumeOutputMode = active?.outputMode === 'obs'
    ? 'obs'
    : active?.outputMode === 'speaker'
      ? 'speaker'
      : selectedOutputMode === 'obs' ? 'obs' : 'speaker';
  const volume = outputVolumeForMode(volumeProfiles, volumeOutputMode);
  const speakerVolume = outputVolumeForMode(volumeProfiles, 'speaker');
  const speakerOutputDeviceSupported = useMemo(() => (
    supportsSpeakerOutputDeviceSelection({
      mediaDevices: typeof navigator === 'undefined' ? null : navigator.mediaDevices,
      mediaElementPrototype: typeof HTMLMediaElement === 'undefined'
        ? null
        : HTMLMediaElement.prototype,
    })
  ), []);
  const [speakerOutputDevice, setSpeakerOutputDevice] = useState(() => {
    const preference = loadSpeakerOutputDevice(
      typeof window === 'undefined' ? null : window.localStorage,
    );
    return {
      supported: supportsSpeakerOutputDeviceSelection({
        mediaDevices: typeof navigator === 'undefined' ? null : navigator.mediaDevices,
        mediaElementPrototype: typeof HTMLMediaElement === 'undefined'
          ? null
          : HTMLMediaElement.prototype,
      }),
      phase: preference.deviceId ? 'selected' : 'default',
      ...preference,
    };
  });
  const speakerOutputDeviceRef = useRef(speakerOutputDevice);
  speakerOutputDeviceRef.current = speakerOutputDevice;
  const speakerMediaSessionController = useMemo(() => (
    createSpeakerMediaSessionController({
      mediaSession: typeof navigator === 'undefined' ? null : navigator.mediaSession,
      MediaMetadataClass: typeof MediaMetadata === 'undefined' ? null : MediaMetadata,
    })
  ), []);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [obsRemoteControlFeedback, setObsRemoteControlFeedback] = useState(null);
  // Stage 6c 불변식: 방송 출력은 광고가 나올 수 있는 어떤 경로(YouTube iframe
  // 등)도 절대 사용하지 않는다. YouTube 곡은 준비 파이프라인이 `ready`로 확정한
  // R2 오디오로만 재생한다 — On-Air 위젯(OnAirPlayer)이 담당하고, 세션 없는
  // 직접 재생 모드는 YouTube를 지원하지 않는다(계약 §7, 의도된 단절). 이 숨김
  // 플레이어는 직접 재생 모드의 로컬 파일 전용이다.
  // 사적 미리듣기(StagingPanel의 iframe, autoplay 0)는 방송 출력과 무관하므로 예외.
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  const handleSkipRef = useRef(null);
  const togglePlaybackRef = useRef(null);
  const handleMediaFailureRef = useRef(null);
  const finalizeDiscardRef = useRef(null);
  const commitActivePhaseRef = useRef(null);
  const explicitSessionEndRequestedRef = useRef(false);
  const reportedMediaIssueRef = useRef(null);
  const reportedDelayRef = useRef(null);
  // §4-4: 버린 곡의 entryId — 늦은 On-Air transport 스냅숏이 되살리지 못하게 한다.
  const lastDiscardedEntryIdRef = useRef(null);

  // 이벤트 핸들러가 마운트 시 캡처한 {entryId, runId}를 최신 active와 대조하기
  // 위한 거울 ref (구 activeSongIdRef 가드를 entryId+runId 검증으로 교체).
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pageOwnedBlobSrcsRef = useRef(new Set());
  const createPageBlobSrc = useCallback((file) => {
    const src = URL.createObjectURL(file);
    pageOwnedBlobSrcsRef.current.add(src);
    return src;
  }, []);
  const revokePageBlobSrcs = useCallback((srcs) => {
    const candidates = [...srcs];
    revokeBlobSrcs(candidates);
    candidates.forEach((src) => pageOwnedBlobSrcsRef.current.delete(src));
  }, []);

  // Completed local-file history is a bounded convenience cache, never
  // playback authority. Apply the pure plan first; revoke only on a later
  // committed render after the latest state proves the src is unreferenced.
  const pendingBlobRevocationsRef = useRef(new Set());
  useEffect(() => {
    const plan = planLocalBlobHistoryBudget(state);
    if (!plan.changed) return;
    plan.revokeSrcs.forEach((src) => pendingBlobRevocationsRef.current.add(src));
    setSharedState((previous) => {
      if (previous.history !== state?.history
        || previous.queue !== state?.queue
        || previous.currentEntry !== state?.currentEntry) return previous;
      return { ...previous, history: plan.history };
    });
  }, [setSharedState, state, state?.currentEntry, state?.history, state?.queue]);

  useEffect(() => {
    if (pendingBlobRevocationsRef.current.size === 0) return;
    const latest = stateRef.current;
    const stillPlanned = new Set(planLocalBlobHistoryBudget(latest).revokeSrcs);
    for (const src of [...pendingBlobRevocationsRef.current]) {
      if (!isBlobReferenced(src, latest)) {
        revokePageBlobSrcs([src]);
        pendingBlobRevocationsRef.current.delete(src);
      } else if (!stillPlanned.has(src)) {
        // The user re-queued the source before cleanup committed. Protection
        // wins over the older cleanup intent.
        pendingBlobRevocationsRef.current.delete(src);
      }
    }
  }, [revokePageBlobSrcs, state?.currentEntry, state?.history, state?.queue]);

  const trackObsRemoteControlRequest = (action, dispatchResult) => {
    if (activeRef.current?.outputMode !== 'obs') return;
    const feedback = createObsRemoteControlFeedback({ action, dispatchResult });
    if (feedback) setObsRemoteControlFeedback(feedback);
  };

  const confirmedObsPlayback = outputControl.snapshot?.confirmedPlayback
    ?? outputControl.snapshot?.playerSnapshot?.confirmedPlayback
    ?? null;

  useEffect(() => {
    setObsRemoteControlFeedback((previous) => {
      if (!previous) return previous;
      return obsRemoteControlFeedbackMatchesRun(previous, activeRef.current)
        ? previous
        : null;
    });
  }, [active?.entryId, active?.outputMode, active?.runId]);

  useEffect(() => {
    setObsRemoteControlFeedback((previous) => (
      reconcileObsRemoteControlFeedback(previous, confirmedObsPlayback)
    ));
  }, [confirmedObsPlayback]);

  useEffect(() => {
    if (obsRemoteControlFeedback?.phase !== 'waiting') return undefined;
    const remaining = Math.max(
      0,
      obsRemoteControlFeedback.requestedAt
        + OBS_REMOTE_CONTROL_FEEDBACK_DELAY_MS
        - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setObsRemoteControlFeedback((previous) => (
        reconcileObsRemoteControlFeedback(previous, confirmedObsPlayback, Date.now())
      ));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [
    confirmedObsPlayback,
    obsRemoteControlFeedback?.commandId,
    obsRemoteControlFeedback?.phase,
    obsRemoteControlFeedback?.requestedAt,
  ]);

  const playbackModeForRun = () => activeRef.current?.outputMode === 'obs'
    ? 'obs'
    : 'speaker';

  const queueLocalSpeakerCommand = (command) => (
    localSpeakerCommandQueueRef.current.enqueue(command)
  );

  const dispatchPlaybackCommand = (command, outputMode = playbackModeForRun()) => {
    if (outputMode === 'obs') return sendOnAirCommand(command);
    const localSpeaker = localSpeakerRef.current;
    if (!localSpeaker) {
      if (useOnAirPlayer && !onAirSession) {
        const pending = queueLocalSpeakerCommand(command);
        retryLocalSpeakerSession().catch(() => {});
        return pending;
      }
      if (localSpeakerState === 'initializing') return queueLocalSpeakerCommand(command);
      throw new Error(t('playback.localSpeaker.notReady'));
    }
    if (localSpeakerState === 'initializing') return queueLocalSpeakerCommand(command);
    if (localSpeakerState !== 'ready') {
      throw new Error(t('playback.localSpeaker.notReady'));
    }
    return localSpeaker.sendCommand(command);
  };

  useEffect(() => {
    if (localSpeakerState === 'ready' && localSpeakerRef.current) {
      localSpeakerCommandQueueRef.current.drain(
        (command) => localSpeakerRef.current?.sendCommand(command),
      );
      return undefined;
    }
    if (!['failed', 'invalid_configuration'].includes(localSpeakerState)) return undefined;
    const error = new Error(t('playback.localSpeaker.notReady'));
    localSpeakerCommandQueueRef.current.rejectAll(error);
    return undefined;
  }, [localSpeakerState]);

  useEffect(() => () => {
    const error = new Error(t('playback.localSpeaker.notReady'));
    localSpeakerCommandQueueRef.current.rejectAll(error);
  }, []);

  const isCurrentRun = (marker) => Boolean(
    marker && activeRef.current &&
    activeRef.current.entryId === marker.entryId &&
    activeRef.current.runId === marker.runId
  );

  // Sync the local profile only to direct-mode media. DashboardLocalSpeaker
  // receives the same value through its LOAD/VOLUME command boundary.
  useEffect(() => {
    if (!useOnAirPlayer) {
      if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, speakerVolume / 100));
      if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, speakerVolume / 100));
    }
    saveOutputVolumeProfiles(typeof window === 'undefined' ? null : window.localStorage, volumeProfiles);
  }, [speakerVolume, useOnAirPlayer, volumeProfiles]);

  const handleSpeakerSinkRestoreFailure = useCallback(() => {
    saveSpeakerOutputDevice(
      typeof window === 'undefined' ? null : window.localStorage,
      DEFAULT_SPEAKER_OUTPUT_DEVICE,
    );
    setSpeakerOutputDevice({
      supported: speakerOutputDeviceSupported,
      phase: 'failed',
      ...DEFAULT_SPEAKER_OUTPUT_DEVICE,
    });
  }, [speakerOutputDeviceSupported]);

  // key={runId} 리마운트로 새 요소가 만들어질 때 볼륨과 선택한 Speaker sink를
  // 즉시 적용한다. sink 실패는 playback lifecycle과 무관하며 기본 출력으로
  // 계속 재생한다.
  const bindSpeakerMediaElement = useCallback((ref, element) => {
    ref.current = element;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, speakerVolume / 100));
    const deviceId = speakerOutputDeviceRef.current.deviceId;
    if (deviceId && typeof element.setSinkId === 'function') {
      applySpeakerOutputDevice(element, deviceId).catch(handleSpeakerSinkRestoreFailure);
    }
  }, [handleSpeakerSinkRestoreFailure, speakerVolume]);
  const bindAudioElement = useCallback(
    (element) => bindSpeakerMediaElement(audioRef, element),
    [bindSpeakerMediaElement],
  );
  const bindVideoElement = useCallback(
    (element) => bindSpeakerMediaElement(videoRef, element),
    [bindSpeakerMediaElement],
  );

  const activeRunId = active?.runId || null;
  // run 세대 전환: 지연/오류 1회 보고 가드를 초기화한다(D-11의 참조 단절은
  // key={runId} 리마운트 + bindMediaElement의 null 바인딩이 담당한다).
  // run이 없어지면 재생 표시도 정리한다.
  useEffect(() => {
    reportedMediaIssueRef.current = null;
    reportedDelayRef.current = null;
    if (!activeRunId) {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
    }
  }, [activeRunId]);

  // Clean up ObjectURLs to prevent memory leaks.
  // 같은 blob을 연속 재생(다시 예약)할 때는 src가 같아 revoke되지 않는다.
  const currentLocalBlobSrc = !useOnAirPlayer && isLocalBlobSong(currentEntry?.song)
    ? currentEntry.song.src
    : null;
  useEffect(() => {
    if (!currentLocalBlobSrc) return undefined;
    return () => {
      // Stage 4 (D-02): 곡 전환·discard로 현재 곡에서 내려가도, 같은 blob src를
      // 다른 entry(다시 예약된 대기열 항목, 이력의 완료 항목)가 아직 참조하면
      // revoke하지 않는다. cleanup 시점의 stateRef.current는 전환이 반영된 최신
      // 상태다(이력 편입·큐 승격 포함). 마지막 참조가 사라졌을 때만 회수한다.
      if (isBlobReferenced(currentLocalBlobSrc, stateRef.current)) return;
      revokePageBlobSrcs([currentLocalBlobSrc]);
    };
  }, [currentLocalBlobSrc, revokePageBlobSrcs]);

  useEffect(() => {
    if (useOnAirPlayer) return undefined;
    let interval;
    if (isPlaying) {
      interval = setInterval(() => {
        if (audioRef.current) {
          setCurrentTime(audioRef.current.currentTime);
          setDuration(audioRef.current.duration || 0);
        }
        if (videoRef.current) {
          setCurrentTime(videoRef.current.currentTime);
          setDuration(videoRef.current.duration || 0);
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isPlaying, activeRunId, useOnAirPlayer]);

  const handleSeek = (time) => {
    // finishing/discarding/failed 중 일반 탐색은 의미가 없거나 전이를 방해한다.
    if (['finishing', 'discarding', 'failed'].includes(activeRef.current?.phase)) return;
    if (useOnAirPlayer) {
      try {
        const dispatchResult = dispatchPlaybackCommand({
          type: 'seek',
          sessionId: currentEntry?.entryId,
          runId: activeRef.current?.runId,
          position: time
        });
        trackObsRemoteControlRequest('seek', dispatchResult);
        Promise.resolve(dispatchResult).catch((error) => showToast(error.message, 'error'));
        setCurrentTime(time);
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  const [stagedItem, setStagedItem] = useState(null);
  const [songDragCandidate, setSongDragCandidate] = useState(null);
  // pagehide 리스너(마운트 시 1회 등록)가 최신 스테이징 blob을 보게 하는 거울 ref.
  const stagedItemRef = useRef(null);
  stagedItemRef.current = stagedItem;

  // Stage 6c (계약 §5): videoId별 준비 상태 — Worker 전역 캐시의 로컬 거울.
  // 게이팅의 근거이므로 연결 실패는 원인별 상태로 기록하되, 어떤 경로로도 실제
  // 응답 없이 'ready'가 되지 않는다(INV-6).
  const [storedPrepareStates, setPrepareStates] = useState({});
  // POST /v1/prepare는 멱등이지만, 같은 곡에 대한 반복 요청 소음을 억제한다.
  const prepareRequestedRef = useRef(new Set());
  const prepareSessionKey = prepareSessionIdentity(onAirSession);
  const prepareSessionKeyRef = useRef(prepareSessionKey);
  // room/token이 바뀐 첫 render부터 이전 세션의 ready 증거를 숨긴다. effect가
  // 상태를 비우기 전 한 프레임도 오래된 준비 결과로 재생을 열지 않는다.
  const prepareStates = prepareSessionKeyRef.current === prepareSessionKey
    ? storedPrepareStates
    : EMPTY_PREPARE_STATES;
  const prepareStatesRef = useRef(prepareStates);
  prepareStatesRef.current = prepareStates;
  const renderedPrepareSessionKeyRef = useRef(prepareSessionKey);
  renderedPrepareSessionKeyRef.current = prepareSessionKey;
  const prepareGenerationRef = useRef(0);
  const onAirSessionStateRef = useRef(onAirSessionState);
  onAirSessionStateRef.current = onAirSessionState;
  // 폴링 interval(watchedVideoIds 의존)이 세션 갱신마다 재설치되지 않게 하는 거울.
  const ensureSessionRef = useRef(onAir.ensureSession);
  ensureSessionRef.current = onAir.ensureSession;

  // 인증 수명이 바뀌면 이전 세션의 요청 표식과 화면 상태를 함께 폐기한다. 세대가
  // 다른 비동기 응답은 아래 notePrepare에서 무시해 새 세션을 덮어쓰지 못한다.
  const resetPrepareSession = useCallback((nextSessionKey) => {
    if (prepareSessionKeyRef.current === nextSessionKey) return prepareGenerationRef.current;
    prepareSessionKeyRef.current = nextSessionKey;
    prepareGenerationRef.current += 1;
    prepareRequestedRef.current.clear();
    prepareStatesRef.current = {};
    setPrepareStates({});
    return prepareGenerationRef.current;
  }, []);

  useEffect(() => {
    resetPrepareSession(prepareSessionKey);
  }, [prepareSessionKey, resetPrepareSession]);

  const prepareConnectionStateForCurrentAuth = useCallback(() => (
    prepareSessionKeyRef.current === renderedPrepareSessionKeyRef.current
      ? onAirSessionStateRef.current
      : ''
  ), []);

  const notePrepare = useCallback((videoId, info, generation = prepareGenerationRef.current) => {
    if (generation !== prepareGenerationRef.current) return;
    const nextInfo = { ...info, checkedAt: Date.now() };
    prepareStatesRef.current = {
      ...prepareStatesRef.current,
      [videoId]: nextInfo
    };
    setPrepareStates((previous) => ({
      ...previous,
      [videoId]: nextInfo
    }));
  }, []);

  // prepare API는 room+playerToken 게이트다(무인증이면 아무나 VPS에 다운로드를
  // 큐잉해 봇월 압력이 폭증한다). 세션이 아직 없으면 여기서 만든다 — 스테이징
  // 시점에 세션을 확보하는 것이 준비 파이프라인의 전제다.
  const getPrepareAuth = useCallback(async () => {
    const activeSession = await ensureSessionRef.current();
    const sessionKey = prepareSessionIdentity(activeSession);
    if (prepareSessionKeyRef.current && sessionKey !== prepareSessionKeyRef.current) {
      return {
        auth: { room: activeSession.room, token: activeSession.playerToken },
        generation: prepareGenerationRef.current,
        sessionKey,
        stale: true
      };
    }
    const generation = resetPrepareSession(sessionKey);
    return {
      auth: { room: activeSession.room, token: activeSession.playerToken },
      generation,
      sessionKey,
      stale: false
    };
  }, [resetPrepareSession]);

  const ensurePrepareRequested = useCallback((videoId, { force = false } = {}) => {
    if (!isPrepareConfigured() || !videoId || prepareRequestedRef.current.has(videoId)) return;
    let requestGeneration = prepareGenerationRef.current;
    prepareRequestedRef.current.add(videoId);
    getPrepareAuth()
      .then(async ({ auth, generation, sessionKey, stale }) => {
        if (stale) {
          if (requestGeneration === prepareGenerationRef.current) {
            prepareRequestedRef.current.delete(videoId);
          }
          return;
        }
        requestGeneration = generation;
        if (generation !== prepareGenerationRef.current
          || sessionKey !== prepareSessionKeyRef.current) return;
        // getPrepareAuth가 새 세션을 채택하며 집합을 비웠을 수 있다.
        prepareRequestedRef.current.add(videoId);
        const info = await requestPrepare(videoId, auth, { force });
        notePrepare(videoId, info, generation);
      })
      .catch((error) => {
        if (requestGeneration !== prepareGenerationRef.current) return;
        // 다음 폴링 틱이 다시 요청할 수 있게 예약을 되돌린다.
        prepareRequestedRef.current.delete(videoId);
        notePrepare(videoId, prepareFailureInfo(error, {
          sessionState: prepareConnectionStateForCurrentAuth()
        }), requestGeneration);
      });
  }, [getPrepareAuth, notePrepare, prepareConnectionStateForCurrentAuth]);

  // 준비를 지켜볼 YouTube 곡: 스테이징(준비 시작 시점) + 대기열 + 현재 곡.
  // 문자열로 합쳐 effect 의존성을 안정화한다(순서·중복 무관).
  const watchedVideoIds = useMemo(() => {
    const ids = new Set();
    const collect = (song) => {
      if (song?.type === 'youtube' && YOUTUBE_ID_PATTERN.test(song.src || '')) ids.add(song.src);
    };
    if (stagedItem?.type === 'youtube') collect(stagedItem);
    (state?.queue || []).forEach((entry) => collect(entry.song));
    collect(currentEntry?.song);
    return [...ids].sort().join(' ');
  }, [stagedItem, state?.queue, currentEntry]);

  // prepare 게이트의 401 하나만으로는 무효/종료를 구분할 수 없으므로, 별도 세션
  // status 검증이 확정한 결과를 기존 비-ready 항목에 즉시 반영한다.
  useEffect(() => {
    if (!['invalid', 'ended'].includes(onAirSessionState)) return;
    const replacement = prepareFailureInfo(null, { sessionState: onAirSessionState });
    setPrepareStates((previous) => {
      let changed = false;
      const next = Object.fromEntries(Object.entries(previous).map(([videoId, info]) => {
        if (info?.status === 'ready' || info?.status === 'failed') return [videoId, info];
        changed = true;
        return [videoId, { ...replacement, checkedAt: Date.now() }];
      }));
      if (!changed) return previous;
      prepareStatesRef.current = next;
      return next;
    });
  }, [onAirSessionState, prepareSessionKey]);

  // 스테이징 시점에 준비를 시작하고(§5 — 방송까지의 시간을 전부 준비에 쓴다),
  // ready·영구 실패 전까지 폴링한다. failed도 계속 본다 — Worker가 백오프로
  // 재시도해 ready가 될 수 있다(§2). 일시 실패는 느린 주기로 다시 확인한다.
  useEffect(() => {
    if (!isPrepareConfigured() || !watchedVideoIds) return undefined;
    const ids = watchedVideoIds.split(' ');
    ids.forEach((videoId) => ensurePrepareRequested(videoId));

    const pollPrepareStatus = async (videoId) => {
      let pollGeneration = prepareGenerationRef.current;
      try {
        const { auth, generation, sessionKey, stale } = await getPrepareAuth();
        pollGeneration = generation;
        if (stale
          || generation !== prepareGenerationRef.current
          || sessionKey !== prepareSessionKeyRef.current) return;
        const next = await fetchPrepareStatus(videoId, auth);
        if (generation !== prepareGenerationRef.current) return;
        // Worker의 작업 레코드가 정리돼 absent가 되면 GET만 반복해서는 영원히
        // '준비 중'에 갇힌다 — 예약을 지워 다음 틱이 다시 큐잉하게 한다.
        if (next.status === 'absent') prepareRequestedRef.current.delete(videoId);
        notePrepare(videoId, next, generation);
      } catch (error) {
        if (pollGeneration !== prepareGenerationRef.current) return;
        notePrepare(videoId, prepareFailureInfo(error, {
          sessionState: prepareConnectionStateForCurrentAuth()
        }), pollGeneration);
      }
    };

    const interval = setInterval(() => {
      ids.forEach((videoId) => {
        const info = prepareStatesRef.current[videoId];
        if (info?.status === 'ready') return;
        if (info?.failureKind === 'unavailable') return; // 영구 실패 — 재폴링 무의미(§2)
        // 무효/종료 인증은 같은 토큰으로 재요청하지 않는다. 새 room/token이 오면
        // prepareSessionKey effect가 즉시 비우고 다시 시작한다.
        if (info?.status === 'session_invalid' || info?.status === 'session_ended') return;
        // 일시 장애는 폴링 주기를 늘려(15초) 실패 요청 소음을 줄인다.
        if (info?.status === 'temporarily_unavailable'
          && Date.now() - (info.checkedAt || 0) < 15000) return;
        if (!prepareRequestedRef.current.has(videoId)) {
          ensurePrepareRequested(videoId);
          return;
        }
        void pollPrepareStatus(videoId);
      });
    }, 5000);
    return () => clearInterval(interval);
    // eslint 참고: ensurePrepareRequested/notePrepare는 ref·setState만 쓰는 안정적 로직.
  }, [
    ensurePrepareRequested,
    getPrepareAuth,
    notePrepare,
    prepareConnectionStateForCurrentAuth,
    prepareSessionKey,
    watchedVideoIds,
  ]);

  // 준비 실패 곡의 명시적 '다시 시도' — force:true로 백오프·영구 실패(unavailable)를
  // 넘어 즉시 재큐잉한다. 사용자가 의도한 1회 행동에만 열리는 문이다.
  const recoverOnAirConnection = useCallback(async () => {
    // Retire only runtime ownership before rotating proven-invalid credentials.
    // The interrupted song is recoverable at the queue front; history and the
    // rest of the setlist remain untouched even if session creation fails.
    explicitSessionEndRequestedRef.current = false;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSharedState((previous) => {
      const interrupted = previous.currentEntry;
      const queue = previous.queue || [];
      const nextQueue = interrupted && !queue.some((item) => item.entryId === interrupted.entryId)
        ? [interrupted, ...queue]
        : queue;
      return { ...previous, currentEntry: null, active: null, queue: nextQueue };
    });
    return createFreshOnAirSession();
  }, [createFreshOnAirSession, setSharedState]);

  const handleRetryPrepare = async (videoId) => {
    if (!videoId) return;
    const prepareStatus = prepareStatesRef.current[videoId]?.status;
    const prepareAuthNeedsRefresh = prepareStatus === 'session_invalid'
      || prepareStatus === 'session_ended';
    if (prepareAuthNeedsRefresh
      || onAirSessionState === 'invalid'
      || onAirSessionState === 'ended') {
      try {
        const freshSession = await recoverOnAirConnection();
        resetPrepareSession(prepareSessionIdentity(freshSession));
      } catch (error) {
        showToast(error?.message || t('obs.setup.recovery.failed'), 'error');
        return;
      }
    }
    prepareRequestedRef.current.delete(videoId);
    setPrepareStates((previous) => {
      const next = { ...previous };
      delete next[videoId];
      prepareStatesRef.current = next;
      return next;
    });
    ensurePrepareRequested(videoId, { force: true });
    showToast(t('prepare.action.retry.notice'), 'info');
  };

  // ── 프리버퍼(pre-buffer) 힌트 ──────────────────────────────────────────
  // 대기열의 다가오는 곡 중 준비 완료(ready)된 YouTube 곡을 순서대로 최대 2개
  // 골라 On-Air 위젯에 prefetch 명령으로 알린다. Worker는 이 명령을 위젯으로
  // 릴레이만 하고(DO storage 쓰기 0) 위젯이 오디오를 미리 통째로 받아 두므로,
  // 곡 전환이 즉시 되고 프리페치가 실패해도 기존 스트리밍 재생으로 무손실
  // 폴백된다. ready가 아닌 곡은 넣지 않는다 — R2에 바이트가 없어 받을 수 없다.
  // 문자열로 합쳐 폴링 틱(checkedAt 갱신)마다 effect가 재발화하지 않게 한다.
  const prefetchTargetIds = useMemo(() => {
    const ids = [];
    for (const entry of state?.queue || []) {
      const song = entry?.song;
      if (song?.type !== 'youtube' || !YOUTUBE_ID_PATTERN.test(song.src || '')) continue;
      if (prepareStates[song.src]?.status !== 'ready') continue;
      if (!ids.includes(song.src)) ids.push(song.src);
      if (ids.length >= 2) break;
    }
    return ids.join(' ');
  }, [state?.queue, prepareStates]);

  // 같은 목록의 연발 전송 억제 — prefetch는 DO에 쓰지 않지만 소음은 줄인다.
  const lastPrefetchSentRef = useRef('');
  useEffect(() => {
    if (!useOnAirPlayer) return;
    if (speakerPlayerMode && localSpeakerState === 'ready') {
      if (lastPrefetchSentRef.current === `speaker:${prefetchTargetIds}`) return;
      lastPrefetchSentRef.current = `speaker:${prefetchTargetIds}`;
      Promise.resolve(localSpeakerRef.current?.sendCommand({
        type: 'prefetch',
        videoIds: prefetchTargetIds ? prefetchTargetIds.split(' ') : [],
      })).catch(() => {});
      return;
    }
    if (!outputControllerReady) {
      // 위젯이 새로 붙으면(OBS 재시작 포함) 캐시가 비어 있으므로,
      // 재연결 시 같은 목록이라도 다시 보내도록 기억을 지운다.
      lastPrefetchSentRef.current = '';
      return;
    }
    if (lastPrefetchSentRef.current === `obs:${prefetchTargetIds}`) return;
    try {
      // 빈 목록도 보낸다 — 위젯이 더는 필요 없는 blob을 회수하는 신호다.
      sendOnAirCommand({ type: 'prefetch', videoIds: prefetchTargetIds ? prefetchTargetIds.split(' ') : [] });
      lastPrefetchSentRef.current = `obs:${prefetchTargetIds}`;
    } catch {
      // 소켓 미연결 등 — 프리페치는 최적화일 뿐이라 다음 상태 변화에서 다시 시도한다.
    }
  }, [
    localSpeakerState,
    outputControllerReady,
    prefetchTargetIds,
    sendOnAirCommand,
    speakerPlayerMode,
    useOnAirPlayer,
  ]);

  // Stage 4 (INV-8, D-31): 창 닫힘 시 참조 중인 blob을 revoke해 메모리 누수를
  // 막는다. 상태는 localStorage에 남으므로 다음 로드에서 Stage 1의 로컬 곡
  // 소실 안내(D-04)로 이어진다 — revoke는 멱등이라 이중 정리에도 안전하다.
  // bfcache 보존(event.persisted)일 때는 페이지가 되살아날 수 있어 회수하지 않는다.
  useEffect(() => {
    const ownedBlobSrcs = pageOwnedBlobSrcsRef.current;
    const handlePageHide = (event) => {
      if (event.persisted) return;
      const srcs = collectBlobSrcs(stateRef.current);
      const staged = stagedItemRef.current;
      if (staged?.type === 'local' && staged.src?.startsWith('blob:')) srcs.add(staged.src);
      ownedBlobSrcs.forEach((src) => srcs.add(src));
      revokePageBlobSrcs(srcs);
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      // Client-side route changes do not fire pagehide. Once Dashboard and its
      // media elements unmount, none of its page-owned Blob URLs remain valid.
      revokePageBlobSrcs(ownedBlobSrcs);
    };
  }, [revokePageBlobSrcs]);

  const {
    aiStatusMessage,
    aiStatusPhase,
    cancelAiExtraction,
    isAiLoading,
    runAiExtractionStream,
    setAiStatus
  } = useAiTitleExtraction(setStagedItem, t);

  // Store a semantic status key so changing language re-renders the current
  // AI state instead of leaving a stale sentence from the previous locale.
  useEffect(() => {
    if (stagedItem?.skipAiTitleExtraction) {
      setAiStatus('dashboard.stage.songbookTitle', {}, 3);
    }
  }, [setAiStatus, stagedItem?.skipAiTitleExtraction, stagedItem?.stagingId]);

  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const showToast = useCallback((message, type = 'info', action = null) => {
    const id = Date.now().toString() + '-' + Math.random().toString(36).slice(2, 7);
    setToasts(prev => [...prev, { id, message, type, action }]);
    setTimeout(() => dismissToast(id), action ? 5000 : 3000);
  }, [dismissToast]);

  const applySpeakerSinkToCurrentMedia = useCallback(async (deviceId) => {
    const target = useOnAirPlayer
      ? localSpeakerRef.current
      : audioRef.current || videoRef.current;
    if (!target) return Object.freeze({ status: 'pending', deviceId });
    return applySpeakerOutputDevice(target, deviceId);
  }, [useOnAirPlayer]);

  const handleChooseSpeakerOutputDevice = useCallback(async () => {
    if (!speakerOutputDeviceSupported
      || typeof navigator === 'undefined'
      || !navigator.mediaDevices) return;
    const previous = speakerOutputDeviceRef.current;
    setSpeakerOutputDevice({ ...previous, phase: 'choosing' });
    try {
      const selectedDevice = await requestSpeakerOutputDevice(navigator.mediaDevices);
      await applySpeakerSinkToCurrentMedia(selectedDevice.deviceId);
      const persisted = saveSpeakerOutputDevice(window.localStorage, selectedDevice);
      setSpeakerOutputDevice({
        supported: true,
        phase: 'selected',
        ...selectedDevice,
      });
      showToast(t('settings.speakerDevice.selected'), 'success');
      if (!persisted) showToast(t('settings.speakerDevice.saveFailed'), 'info');
    } catch {
      setSpeakerOutputDevice({ ...previous, phase: 'failed' });
      showToast(t('settings.speakerDevice.failed'), 'info');
    }
  }, [applySpeakerSinkToCurrentMedia, showToast, speakerOutputDeviceSupported]);

  const handleResetSpeakerOutputDevice = useCallback(async () => {
    if (!speakerOutputDeviceSupported) return;
    const previous = speakerOutputDeviceRef.current;
    setSpeakerOutputDevice({ ...previous, phase: 'choosing' });
    try {
      await applySpeakerSinkToCurrentMedia('');
      const persisted = saveSpeakerOutputDevice(
        typeof window === 'undefined' ? null : window.localStorage,
        DEFAULT_SPEAKER_OUTPUT_DEVICE,
      );
      setSpeakerOutputDevice({
        supported: true,
        phase: 'default',
        ...DEFAULT_SPEAKER_OUTPUT_DEVICE,
      });
      showToast(t('settings.speakerDevice.resetDone'), 'success');
      if (!persisted) showToast(t('settings.speakerDevice.saveFailed'), 'info');
    } catch {
      setSpeakerOutputDevice({ ...previous, phase: 'failed' });
      showToast(t('settings.speakerDevice.failed'), 'info');
    }
  }, [applySpeakerSinkToCurrentMedia, showToast, speakerOutputDeviceSupported]);

  const recordObsMixerVerification = useCallback((outcome) => {
    if (!obsMixerVerification.canConfirm
      || !onAirSession?.room
      || !obsMixerPlayerInstanceId
      || !obsAudioCheck?.checkId) {
      showToast(t('obs.audioCheck.mixerVerification.unavailable'), 'info');
      return;
    }
    let record;
    try {
      record = createObsMixerVerification({
        outcome,
        room: onAirSession.room,
        playerInstanceId: obsMixerPlayerInstanceId,
        checkId: obsAudioCheck.checkId,
      });
    } catch {
      showToast(t('obs.audioCheck.mixerVerification.saveFailed'), 'error');
      return;
    }
    setObsMixerVerificationRecord(record);
    let persisted = false;
    try {
      persisted = saveObsMixerVerification(window.localStorage, record);
    } catch {
      persisted = false;
    }
    if (!persisted) {
      showToast(t('obs.audioCheck.mixerVerification.saveFailed'), 'info');
      return;
    }
    showToast(t(outcome === OBS_MIXER_VERIFICATION_OUTCOMES.PASSED
      ? 'obs.audioCheck.mixerVerification.savedPassed'
      : 'obs.audioCheck.mixerVerification.savedFailed'),
    outcome === OBS_MIXER_VERIFICATION_OUTCOMES.PASSED ? 'success' : 'info');
  }, [
    obsAudioCheck?.checkId,
    obsMixerPlayerInstanceId,
    obsMixerVerification.canConfirm,
    onAirSession?.room,
    showToast,
  ]);

  const handleConfirmObsMixerSignal = useCallback(() => {
    recordObsMixerVerification(OBS_MIXER_VERIFICATION_OUTCOMES.PASSED);
  }, [recordObsMixerVerification]);

  const handleReportMissingObsMixerSignal = useCallback(() => {
    recordObsMixerVerification(OBS_MIXER_VERIFICATION_OUTCOMES.FAILED);
  }, [recordObsMixerVerification]);

  // The local speaker downloads prepared media through a media session, but
  // that HTTP credential is not an output route. Bootstrap it quietly once;
  // a failure never changes the selected Speaker route, and the next explicit
  // play command retries instead of waiting forever.
  const sessionBootstrapAttemptedRef = useRef(false);
  useEffect(() => {
    if (!useOnAirPlayer) return;

    const recoverableInvalidSession = onAirSessionState === 'invalid' && onAirSession?.room;
    const recoverableEndedSession = onAirSessionState === 'ended'
      && !explicitSessionEndRequestedRef.current;
    if (recoverableInvalidSession || recoverableEndedSession) {
      // Session rotation replaces media credentials and therefore remounts the
      // local resolver. Never let that maintenance stop an already-buffered
      // speaker track; starting/failed attempts are safe to retire and requeue.
      if (activeRef.current?.outputMode === 'speaker'
        && ['playing', 'paused', 'buffering'].includes(activeRef.current?.phase)) return;
      // One automatic rotation per page lifetime prevents the replacement
      // session from being rotated again during the invalid→connecting render gap.
      if (!onAirSessionRecoveryGate.claim()) return;
      recoverOnAirConnection()
        .then(() => showToast(t('onair.connection.recovery.created'), 'success'))
        .catch((error) => showToast(
          error?.message || t('onair.connection.recovery.failed'),
          'error'
        ));
      return;
    }

    if (!onAirSession && onAirSessionState === 'connecting'
      && !sessionBootstrapAttemptedRef.current) {
      sessionBootstrapAttemptedRef.current = true;
      retryLocalSpeakerSession().catch(() => {});
    }
  }, [
    onAirSession,
    onAirSessionState,
    recoverOnAirConnection,
    retryLocalSpeakerSession,
    showToast,
    active?.outputMode,
    useOnAirPlayer,
  ]);

  const dispatchOutputModeSelection = useCallback((mode) => {
    const reportFailure = (error) => showToast(
      t(outputSwitchFailureMessageKey(error)),
      'error',
    );
    try {
      Promise.resolve(selectOnAirOutputMode(mode)).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  }, [selectOnAirOutputMode, showToast]);

  const handleSelectOutputMode = useCallback((mode) => {
    if (!['speaker', 'obs'].includes(mode)) return;
    if (mode === 'speaker') {
      setOutputModePreference('speaker');
      setQueuedOutputIntent(null);
      setOutputControlRecoveryRequired(false);
      // Local listening never waits for control ownership, an OBS stop proof,
      // another tab, or a server route transition. Keep a prepared OBS source
      // connected for fast return; new playback commands now go only to this
      // tab's audio element. An already-running OBS song is migrated below by
      // the playback-run ref once it is available.
      const activeRun = activeRef.current;
      const activeEntry = stateRef.current?.currentEntry;
      if (activeRun?.outputMode === 'obs' && activeEntry) {
        const resumePosition = Number.isFinite(currentTime) ? currentTime : 0;
        try {
          Promise.resolve(sendOnAirCommand({
            type: 'stop',
            sessionId: activeEntry.entryId,
            runId: activeRun.runId,
          })).catch(() => {
            showToast(t('onair.output.localSpeaker.obsCleanupFailed'), 'info');
          });
        } catch {
          showToast(t('onair.output.localSpeaker.obsCleanupFailed'), 'info');
        }
        window.setTimeout(() => {
          try {
            const nextActive = beginPlaybackRunRef.current?.(activeEntry, {
              outputMode: 'speaker',
              position: resumePosition,
            });
            if (!nextActive) return;
            setSharedState((previous) => (
              previous.currentEntry?.entryId === activeEntry.entryId
                ? { ...previous, active: nextActive }
                : previous
            ));
          } catch (error) {
            showToast(error?.message || t('playback.localSpeaker.loadFailed'), 'error');
          }
        }, 0);
      }
      return;
    } else {
      if (activeRef.current?.outputMode === 'speaker') {
        showToast(t('onair.output.obs.finishLocalTrackFirst'), 'info');
        return;
      }
      if (outputControlRecoveryRequired || outputControlConflict
        || outputControlUnavailable
        || (!outputControllerReady && !outputBootstrapSelectionAvailable)) {
        showToast(t('onair.output.selector.locked.unavailable'), 'info');
        return;
      }
      setOutputModePreference('obs');
    }
    outputIntentSequenceRef.current += 1;
    // Accept the user's route choice during the first session/control
    // bootstrap. It stays a visibly pending intent, never an aria-checked
    // output fact, until this exact session has writable authority.
    setQueuedOutputIntent({
      id: outputIntentSequenceRef.current,
      mode,
      sessionKey: outputControlSessionKey,
    });
  }, [
    currentTime,
    outputBootstrapSelectionAvailable,
    outputControlConflict,
    outputControlRecoveryRequired,
    outputControlSessionKey,
    outputControlUnavailable,
    outputControllerReady,
    sendOnAirCommand,
    setSharedState,
    showToast,
  ]);

  useEffect(() => {
    if (!queuedOutputIntent) return;
    if (outputControlConflict
      || outputControlUnavailable
      || outputControlRecoveryReason
      || ['invalid', 'ended'].includes(onAirSessionState)) {
      setQueuedOutputIntent(null);
      return;
    }
    if (queuedOutputIntent.sessionKey !== null
      && queuedOutputIntent.sessionKey !== outputControlSessionKey) {
      setQueuedOutputIntent(null);
      return;
    }
    if (!outputControllerReady) return;
    if (claimedOutputIntentRef.current === queuedOutputIntent.id) return;

    claimedOutputIntentRef.current = queuedOutputIntent.id;
    setQueuedOutputIntent(null);
    dispatchOutputModeSelection(queuedOutputIntent.mode);
  }, [
    dispatchOutputModeSelection,
    onAirSessionState,
    outputControlConflict,
    outputControllerReady,
    outputControlRecoveryReason,
    outputControlUnavailable,
    outputControlSessionKey,
    queuedOutputIntent,
  ]);

  // Legacy stored Blob URLs become actionable placeholders rather than being
  // silently deleted. Announce the migration once; each row carries recovery.
  const localDropNoticeShownRef = useRef(false);
  useEffect(() => {
    if (localDropNoticeShownRef.current) return;
    if (syncLoadNotice?.localFilesNeedReselection > 0) {
      localDropNoticeShownRef.current = true;
      showToast(
        t('dashboard.localFile.reselectionAfterRefresh', {
          count: syncLoadNotice.localFilesNeedReselection,
        }),
        'info'
      );
    }
    // eslint 참고: showToast는 setToasts만 사용하는 안정적 로직이다.
  }, [showToast, syncLoadNotice]);

  const [room] = useState(() => getOrCreateRoom());
  const [signingKeys, setSigningKeys] = useState(null);

  useEffect(() => {
    if (!signingKeys) {
      getOrCreateSigningKeys().then(setSigningKeys).catch(() => {});
    }
  }, [signingKeys]);

  // Stage 5 위젯 projection (INV-9): 확정 상태만, 위젯이 쓰는 필드만 발행한다.
  // 위젯(room&key 구독)은 평면 currentSong/history를 소비하므로 v2 QueueEntry를
  // 구 스키마 모양으로 투영해 하위호환을 유지한다.
  // D-18 잔존 해소: isPlaying과 currentSong.phase를 포함해 위젯이 일시정지·
  // 스킵 중·재생 실패를 추측 없이(§5-1) 표시할 수 있게 한다.
  const widgetProjection = useMemo(() => ({
    currentSong: currentEntry ? toWidgetSong(currentEntry, { phase: active?.phase || null }) : null,
    history: history.slice(-WIDGET_HISTORY_LIMIT).map((entry) => toWidgetSong(entry)).filter(Boolean),
    isPlaying
  }), [currentEntry, active?.phase, history, isPlaying]);

  useEffect(() => {
    if (room && signingKeys) {
      // D-12(늦게 연 위젯의 빈 화면 — ntfy since= 재생/접속 스냅숏)는 이번 단계
      // 미포함, Stage 5 후속으로 남긴다. 지금은 다음 상태 변경 시 채워진다.
      publishSync({ state: widgetProjection, timestamp: Date.now() }, room, signingKeys.privateKey);
    }
  }, [widgetProjection, room, signingKeys]);

  useEffect(() => {
    if (!useOnAirPlayer || !onAirDisplayToken || !outputControllerReady) return;
    try {
      sendOnAirCommand({ type: 'display_state', display: toDisplayState({ currentSong, history: legacyHistory }) });
    } catch {
      // The player/session reconnect path will publish the latest display state.
    }
  }, [currentSong, legacyHistory, onAirDisplayToken, outputControllerReady, sendOnAirCommand, useOnAirPlayer]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      // Ignore if typing in an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (stateRef.current?.currentEntry) {
          togglePlaybackRef.current?.();
        }
      } else if (e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault();
        // D-25: 전이가 실제로 시작됐을 때만 성공 토스트를 보여 준다.
        if (handleSkipRef.current?.()) {
          showToast(t('dashboard.toast.skipCurrent'), 'info');
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showToast]);

  const handleSelectSearchResult = (video) => {
    const replacedStagedItem = Boolean(stagedItem);
    cancelAiExtraction();
    const stagingId = newId();
    const nextStagedItem = stagedItemFromSongDragCandidate(video, stagingId);
    if (!nextStagedItem) return;
    setStagedItem(nextStagedItem);
    showToast(
      t(replacedStagedItem ? 'dashboard.stage.replaced' : 'dashboard.stage.selected'),
      'info'
    );
    if (nextStagedItem.skipAiTitleExtraction) {
      setAiStatus('dashboard.stage.songbookTitle', {}, 3);
    } else if (nextStagedItem.src) {
      runAiExtractionStream(apiUrl(`/api/extract-title?id=${nextStagedItem.src}`), {}, stagingId);
    }
  };

  const handleRetryAiExtraction = () => {
    if (!stagedItem?.stagingId) return;
    if (stagedItem.type === 'youtube' && stagedItem.src) {
      runAiExtractionStream(apiUrl(`/api/extract-title?id=${stagedItem.src}&refresh=1`), {}, stagedItem.stagingId, { overwriteTitle: true });
      return;
    }
    if (stagedItem.type === 'local' && stagedItem.file) {
      runAiExtractionStream(apiUrl('/api/extract-local'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: stagedItem.file.name, metadata: {}, cacheKey: stagedItem.localCacheKey || '', forceRefresh: true })
      }, stagedItem.stagingId, { overwriteTitle: true });
    }
  };

  const handleLocalFileDrop = (file, songbookContext = null) => {
    cancelAiExtraction();
    const url = createPageBlobSrc(file);
    const stagingId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStagedItem({
      stagingId,
      type: 'local',
      src: url,
      mediaType: file.type === 'video/mp4' ? 'video' : 'audio',
      title: songbookContext?.title || file.name,
      artist: songbookContext?.artist || '',
      tags: songbookContext?.tags || [],
      source: songbookContext?.source || 'local',
      songbookId: songbookContext?.songbookId || null,
      skipAiTitleExtraction: Boolean(songbookContext),
      file: file,
      localCacheKey: `${file.name}:${file.size}:${file.lastModified}`,
      assetStatus: useOnAirPlayer ? 'uploading' : 'local',
      assetProgress: useOnAirPlayer ? 0 : null,
      assetId: null
    });
    showToast(t('dashboard.localFile.loaded'), 'info');

    if (useOnAirPlayer) {
      onAir.uploadAsset(file, (assetProgress) => {
        setStagedItem((previous) => previous?.stagingId === stagingId ? { ...previous, assetProgress } : previous);
      }).then((asset) => {
        setStagedItem((previous) => previous?.stagingId === stagingId
          ? { ...previous, assetId: asset.assetId, assetStatus: 'ready', assetProgress: 100 }
          : previous);
      }).catch((error) => {
        setStagedItem((previous) => previous?.stagingId === stagingId
          ? { ...previous, assetStatus: 'error', assetError: error.message }
          : previous);
        showToast(error.message || t('dashboard.localFile.prepareFailed'), 'error');
      });
    }

    let metadata = {};
    // Try parsing tags for better alias
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title && !songbookContext) {
          metadata = tag.tags;
          setStagedItem(prev => {
            if (!prev || prev.stagingId !== stagingId) return prev;
            return {
              ...prev,
              title: prev.isTitleEdited ? prev.title : tag.tags.title,
              artist: prev.isArtistEdited ? prev.artist : (tag.tags.artist || '')
            };
          });
        }

        if (songbookContext) {
          setAiStatus('dashboard.stage.songbookTitle', {}, 3);
          return;
        }
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata, cacheKey: `${file.name}:${file.size}:${file.lastModified}` })
        }, stagingId);
      },
      onError: (error) => {
        console.log('No ID3 tags found:', error.type);
        if (songbookContext) {
          setAiStatus('dashboard.stage.songbookTitle', {}, 3);
          return;
        }
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata, cacheKey: `${file.name}:${file.size}:${file.lastModified}` })
        }, stagingId);
      }
    });
  };

  const handleAliasChange = (field, value) => {
    setStagedItem(prev => prev ? ({
      ...prev,
      [field]: value,
      ...(field === 'title' ? { isTitleEdited: true } : {}),
      ...(field === 'artist' ? { isArtistEdited: true } : {})
    }) : prev);
  };

  const handleClearStaged = () => {
    cancelAiExtraction();
    setAiStatus('');
    setStagedItem((previous) => {
      // Stage 4 (D-02 동일 규칙): 대기열/현재 곡/이력이 같은 blob src를 쓰고
      // 있으면 유지한다. (스테이징 blob은 파일 드롭마다 새로 만들어져 실제로
      // 겹칠 일이 없지만, 참조 검사 하나로 규칙을 통일한다.)
      if (previous?.type === 'local' && previous.src?.startsWith('blob:') &&
        !isBlobReferenced(previous.src, stateRef.current)) {
        revokePageBlobSrcs([previous.src]);
      }
      return null;
    });
    showToast(t('dashboard.stage.cleared'), 'info');
  };

  // §2-4 outputSafety, Stage 6c 확정(계약 §5): 곡별 증거 기반 판정.
  // R2에 준비된 바이트가 확인된(`ready`) YouTube 곡만 'safe', 그 외 전부
  // 'blocked' — 준비 중·실패·서버 미응답·미설정을 구분하지 않고 전부 재생 불가다.
  // "프록시가 설정돼 있으면 safe"라는 설정 플래그 판정은 폐기했다(INV-6).
  const getYoutubeOutputSafety = (entry) => {
    const song = entry?.song;
    if (song?.type !== 'youtube') return 'safe';
    if (!isPrepareConfigured()) return 'blocked';
    return prepareStatesRef.current[song.src]?.status === 'ready' ? 'safe' : 'blocked';
  };

  // 새 PlaybackRun 시작 (§1: runId는 재생 시도마다 발급).
  // setState updater 밖에서만 호출한다(D-10) — On-Air 명령 송신 같은 I/O가 있다.
  // 직접 재생 모드의 실제 시작은 숨김 플레이어의 key={runId} 리마운트 + autoPlay가
  // 담당하므로 여기서는 run 기술자만 만든다(D-06 구조 해소).
  //
  // Stage 6c 불변식(계약 §5): `ready`가 아닌 YouTube 곡은 방송 출력에 절대
  // 올라가지 않는다 — 모드(직접/On-Air) 불문. run을 만들지 않고 던지며, 모든
  // 호출자가 catch→토스트로 처리한다(재생이 안 되는 편이 광고보다 낫다).
  const beginPlaybackRun = (entry, { outputMode = null, position = 0 } = {}) => {
    if (entry.song?.type === 'youtube' && getYoutubeOutputSafety(entry) !== 'safe') {
      throw new Error(prepareBlockMessage(songPrepareState(entry.song, prepareStatesRef.current)));
    }
    // 진실성 게이트(모든 재생 시작 경로 공통 — 대기열 바로 재생·재시도·자동 다음
    // 곡 포함): player 위젯이 실제로 연결돼 있지 않으면 run 을 만들지 않는다.
    // 모든 호출자가 catch→토스트로 처리한다.
    const runOutputMode = outputMode === 'obs' || outputMode === 'speaker'
      ? outputMode
      : outputModePreference === 'obs' ? 'obs' : 'speaker';
    const initialPosition = Number.isFinite(position) && position >= 0 ? position : 0;
    if (useOnAirPlayer && runOutputMode === 'obs' && !outputRouteStable) {
      throw new Error(t('onair.output.playback.routeNotConfirmed'));
    }
    const runId = newId();
    setCurrentTime(initialPosition);
    setDuration(0);
    if (useOnAirPlayer) {
      // OnAirPlayer가 song.src(videoId)로 준비된 오디오 URL을 스스로 구성하므로
      // (자기 player 토큰 사용) load 명령의 프로토콜은 변경 없다.
      const command = {
        type: 'load',
        sessionId: entry.entryId, // On-Air 프로토콜의 sessionId = entryId 매핑
        entryId: entry.entryId,
        runId,
        song: toLegacySong(entry),
        position: initialPosition,
        volume: outputVolumeForMode(volumeProfilesRef.current, runOutputMode)
      };
      const dispatchLoad = () => {
        // A local cached source can become ready in the same task. Wait until
        // React has committed this run marker so its first PLAYING evidence
        // cannot arrive before the dashboard knows which run owns it.
        if (runOutputMode === 'speaker' && activeRef.current?.runId !== runId) return;
        let operation;
        try {
          operation = dispatchPlaybackCommand(command, runOutputMode);
        } catch (error) {
          operation = Promise.reject(error);
        }
        Promise.resolve(operation).catch((error) => {
          window.setTimeout(() => {
            handleMediaFailureRef.current?.(
              { entryId: entry.entryId, runId },
              runOutputMode === 'obs'
                ? t('onair.output.playback.source')
                : t('playback.localSpeaker.source'),
              error?.message || t('playback.localSpeaker.loadFailed'),
            );
          }, 0);
        });
      };
      if (runOutputMode === 'speaker') window.setTimeout(dispatchLoad, 0);
      else dispatchLoad();
    }
    return { entryId: entry.entryId, runId, phase: 'starting', outputMode: runOutputMode };
  };
  beginPlaybackRunRef.current = beginPlaybackRun;

  // 재생 출력 정지(다음 곡 없음). On-Air 명령 실패는 호출자가 처리한다.
  const stopPlaybackOutput = ({ stoppingEntryId, stoppingRunId } = {}) => {
    if (useOnAirPlayer) {
      const operation = dispatchPlaybackCommand({
        type: 'stop',
        sessionId: stoppingEntryId || currentEntry?.entryId,
        runId: stoppingRunId || activeRef.current?.runId
      });
      Promise.resolve(operation).catch((error) => showToast(error.message, 'error'));
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  // active.phase 확정 — 반드시 실제 Player 확인 이벤트 뒤에만 호출된다(INV-5).
  // extra: failed의 failureDetail 같은 phase 부속 정보를 함께 기록한다.
  const commitActivePhase = (marker, phase, extra = {}) => {
    setSharedState((previous) => {
      const act = previous.active;
      if (!act || act.entryId !== marker.entryId || act.runId !== marker.runId) return previous;
      if (act.phase === phase && !Object.keys(extra).length) return previous;
      return { ...previous, active: { ...act, phase, ...extra } };
    });
  };
  commitActivePhaseRef.current = commitActivePhase;

  // finishing/discarding/failed는 의도가 확정된 상태라 일반 playing/paused
  // 확인이 이를 되돌리지 못한다(§4-3 finishing 중 조작 제한, §4-4 discard 우선).
  const isPhaseLocked = () =>
    ['finishing', 'discarding', 'failed'].includes(activeRef.current?.phase);

  const handleConfirmedPlaying = (marker) => {
    if (!isCurrentRun(marker) || isPhaseLocked()) return;
    setIsPlaying(true);
    commitActivePhase(marker, 'playing');
  };

  const handleConfirmedPaused = (marker) => {
    if (!isCurrentRun(marker) || isPhaseLocked()) return;
    setIsPlaying(false);
    commitActivePhase(marker, 'paused');
  };

  // 실제 ended 확인 → completed 확정 → 다음 곡 승격.
  // history 편입과 자동 다음 곡은 이 completed 전이 하나에서만 일어난다(INV-2/3/4).
  // 승격 우선순위: 스킵/바로 재생이 예약한 pendingNextEntryId(§4-6 복합 명령)
  // → autoPlayNext 설정 시 큐 첫 곡. finishing 중 ended는 예정 사유(skipped)로 완료.
  const handleConfirmedEnded = (marker, completionReason = 'natural') => {
    if (!isCurrentRun(marker)) return;
    const act = activeRef.current;
    // failed는 정상 종료가 아니다(§4-5) — 실패 확정 뒤 늦은 ended는 이력을 만들지 않는다.
    if (act?.phase === 'failed') return;
    const confirmedReason = act?.phase === 'finishing'
      ? (act.pendingCompletionReason || 'skipped')
      : completionReason;
    const snapshot = stateRef.current || {};
    if (snapshot.currentEntry?.entryId !== marker.entryId) return;

    const queue = snapshot.queue || [];
    const pendingNext = act?.pendingNextEntryId
      ? queue.find((item) => item.entryId === act.pendingNextEntryId) || null
      : null;
    let promoted = pendingNext || (snapshot.autoPlayNext && queue.length > 0 ? queue[0] : null);
    let nextActive = null;
    if (promoted) {
      try {
        nextActive = beginPlaybackRun(promoted);
      } catch (error) {
        showToast(error.message || t('dashboard.playback.nextFailed'), 'error');
        promoted = null;
      }
    }
    if (!promoted) {
      try {
        stopPlaybackOutput({ stoppingEntryId: marker.entryId, stoppingRunId: marker.runId });
      } catch {
        // 이미 끝난 곡이다 — 정지 명령 실패가 완료 처리를 막지 않는다.
        setIsPlaying(false);
      }
    }

    const finishedEntry = { ...snapshot.currentEntry, phase: 'completed', completionReason: confirmedReason };
    setSharedState((previous) => {
      if (previous.currentEntry?.entryId !== marker.entryId) return previous;
      if (previous.active && previous.active.runId !== marker.runId) return previous;
      const nextHistory = [...(previous.history || []), finishedEntry];
      if (!promoted) return { ...previous, currentEntry: null, active: null, history: nextHistory };
      const q = previous.queue || [];
      const promotedIndex = q.findIndex((item) => item.entryId === promoted.entryId);
      return {
        ...previous,
        currentEntry: promoted,
        active: nextActive,
        queue: promotedIndex >= 0 ? [...q.slice(0, promotedIndex), ...q.slice(promotedIndex + 1)] : q,
        history: nextHistory
      };
    });
  };

  const commitStagedItem = (sourceItem, {
    insertAtTop = false,
    forceQueue = false,
    clearStagedItem = false,
  } = {}) => {
    if (!sourceItem) return false;
    // 진실성 게이트는 beginPlaybackRun 안에 있다(player 위젯 실제 연결 여부) —
    // 여기서 함수 전체를 막지 않는 이유: 이 함수는 '대기열에 추가'도 담당하므로,
    // OBS를 아직 안 연 상태에서도 setlist 예약은 허용해야 한다(송출만 막는다).
    // 예전의 control 연결 게이트는 대시보드 자신의 서버 연결만 봐서 위젯 없이도
    // 통과시키는 거짓 게이트였다.
    if (useOnAirPlayer && sourceItem.type === 'local' && !sourceItem.assetId) {
      showToast(sourceItem.assetError || t('dashboard.localFile.preparing'), 'info');
      return false;
    }
    // Stage 6c 게이팅(계약 §5): `ready`가 아닌 YouTube 곡은 방송 출력에 올리지
    // 않는다. 영구 실패(unavailable)·서버 미설정(blocked)은 대기열에 넣어도
    // 소용이 없으므로 가장 이른 지점에서 막는다. 준비 중·일시 실패는 대기열
    // 예약을 허용한다 — 준비는 백그라운드로 계속되고, 실패가 방송 전에
    // 대기열에서 눈에 띄는 것이 이 설계의 존재 이유다. iframe 재생은 없다.
    const stagedPrepare = sourceItem.type === 'youtube'
      ? songPrepareState({ type: 'youtube', src: sourceItem.src }, prepareStates)
      : { kind: 'ready' };
    if (stagedPrepare.kind === 'blocked' || stagedPrepare.kind === 'unavailable') {
      showToast(prepareBlockMessage(stagedPrepare), 'error');
      return false;
    }

    // 단일 팩토리 사용(D-09): 모든 신규 곡은 entryId를 가진 QueueEntry로 태어난다.
    const entry = createQueueEntry({
      type: sourceItem.type,
      title: sourceItem.title,
      artist: sourceItem.artist,
      src: useOnAirPlayer && sourceItem.type === 'local' ? sourceItem.assetId : sourceItem.src,
      assetId: useOnAirPlayer && sourceItem.type === 'local' ? sourceItem.assetId : undefined,
      mediaType: sourceItem.mediaType || 'audio',
      tags: sourceItem.tags || [],
      source: sourceItem.source || 'youtube',
      songbookId: sourceItem.songbookId || null,
      ...(sourceItem.type === 'local' && sourceItem.file
        ? { localBlobBytes: sourceItem.file.size }
        : {}),
    });
    const newSong = entry.song;

    const cacheEntries = [];
    if (newSong.type === 'youtube' && newSong.src) cacheEntries.push({ kind: 'youtube', id: newSong.src, mrId: newSong.src });
    if (newSong.source !== 'youtube' && newSong.songbookId && newSong.type === 'youtube' && newSong.src) {
      cacheEntries.push({
        kind: `songbook:${newSong.source}`,
        id: newSong.songbookId,
        songbookId: newSong.songbookId,
        mrId: newSong.src,
        mrKind: 'youtube',
        persistent: true
      });
    }
    if (newSong.type === 'local' && sourceItem.localCacheKey) cacheEntries.push({ kind: 'local', id: sourceItem.localCacheKey });
    if (cacheEntries.length) {
      fetch(apiUrl('/api/title-cache'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newSong.title, entries: cacheEntries })
      }).catch(() => {});
    }

    const confirmedSongbookMr = newSong.type === 'youtube' && newSong.source !== 'youtube' && newSong.songbookId
      ? {
          [songbookCacheKey(newSong.source, newSong.songbookId)]: {
            title: newSong.title,
            mrId: newSong.src,
            mrKind: 'youtube',
            updatedAt: Date.now(),
            verifiedAt: Date.now(),
            source: 'streamer-confirmed'
          }
        }
      : null;

    // D-10: 재생 I/O와 토스트를 setState updater 밖에서 수행한다.
    // 준비가 안 끝난 곡은 즉시 재생 대신 대기열로 예약한다 — StagingPanel 버튼
    // 라벨이 같은 조건으로 '대기열에 추가 (준비 중)'을 표시하므로 사용자가 누른
    // 것과 일어나는 일이 일치하고, 아래 토스트가 다음 행동을 안내한다.
    const hadCurrentEntry = Boolean(stateRef.current?.currentEntry);
    const deferredByPrepare = !hadCurrentEntry && stagedPrepare.kind !== 'ready';
    const willPlayImmediately = !forceQueue && !hadCurrentEntry && !deferredByPrepare;
    let nextActive = null;
    if (willPlayImmediately) {
      try {
        nextActive = beginPlaybackRun(entry);
      } catch (error) {
        showToast(error.message || t('dashboard.playback.startFailed'), 'error');
        return false;
      }
    }

    setSharedState(prev => {
      const songbookMrCache = confirmedSongbookMr
        ? { ...(prev.songbookMrCache || {}), ...confirmedSongbookMr }
        : prev.songbookMrCache;
      // If nothing is playing, play immediately
      if (willPlayImmediately && !prev.currentEntry && nextActive) {
        return { ...prev, songbookMrCache, currentEntry: entry, active: nextActive };
      }
      // Otherwise add to queue
      const q = prev.queue || [];
      return {
        ...prev,
        songbookMrCache,
        queue: insertAtTop ? [entry, ...q] : [...q, entry]
      };
    });

    showToast(
      willPlayImmediately
        ? t('dashboard.queue.playing')
        : deferredByPrepare
          ? (stagedPrepare.kind === 'failed'
            ? t('dashboard.queue.prepareFailed')
            : t('dashboard.queue.preparing'))
          : t(insertAtTop ? 'dashboard.queue.addedTop' : 'dashboard.queue.addedEnd'),
      willPlayImmediately ? 'success' : 'info'
    );

    if (clearStagedItem) {
      cancelAiExtraction();
      setStagedItem((previous) => {
        // On-Air 송출 항목은 assetId(R2 자산)를 참조하므로 미리보기 blob은 여기서
        // 회수한다. 직접 재생 모드는 entry가 이 blob src 자체를 쓰므로 유지된다.
        if (useOnAirPlayer && previous?.type === 'local' && previous.src?.startsWith('blob:') &&
          !isBlobReferenced(previous.src, stateRef.current)) {
          revokePageBlobSrcs([previous.src]);
        }
        return null;
      });
    }
    return true;
  };

  const handleGoLive = (insertAtTop = false) => commitStagedItem(stagedItem, {
    insertAtTop,
    clearStagedItem: true,
  });

  const addDraggedSongToHistory = (sourceItem) => {
    const entry = createQueueEntry({
      type: 'youtube',
      title: sourceItem.title,
      artist: sourceItem.artist,
      src: sourceItem.src,
      mediaType: 'audio',
      tags: sourceItem.tags || [],
      source: sourceItem.source || 'youtube',
      songbookId: sourceItem.songbookId || null,
    });
    const completedEntry = { ...entry, phase: 'completed', completionReason: null };
    const confirmedSongbookMr = entry.song.source !== 'youtube' && entry.song.songbookId
      ? {
          [songbookCacheKey(entry.song.source, entry.song.songbookId)]: {
            title: entry.song.title,
            mrId: entry.song.src,
            mrKind: 'youtube',
            updatedAt: Date.now(),
            verifiedAt: Date.now(),
            source: 'streamer-confirmed',
          },
        }
      : null;

    setSharedState((previous) => ({
      ...previous,
      history: [...(previous.history || []), completedEntry],
      songbookMrCache: confirmedSongbookMr
        ? { ...(previous.songbookMrCache || {}), ...confirmedSongbookMr }
        : previous.songbookMrCache,
    }));
    showToast(t('dashboard.drag.historyAdded', { title: entry.song.title }), 'success');
  };

  const handleSongDrop = (destination) => {
    const candidate = songDragCandidate;
    setSongDragCandidate(null);
    const sourceItem = stagedItemFromSongDragCandidate(candidate, newId());
    if (!sourceItem) return;

    const prepareKind = songPrepareState(
      { type: 'youtube', src: sourceItem.src },
      prepareStates,
    ).kind;
    const action = planSongDropAction({
      destination,
      hasCurrentSong: Boolean(stateRef.current?.currentEntry),
      prepareKind,
    });

    if (action === SONG_DROP_ACTIONS.HISTORY) {
      addDraggedSongToHistory(sourceItem);
      return;
    }
    if (action === SONG_DROP_ACTIONS.PLAY_NOW) {
      commitStagedItem(sourceItem);
      return;
    }
    if (action === SONG_DROP_ACTIONS.QUEUE_FRONT) {
      commitStagedItem(sourceItem, { insertAtTop: true, forceQueue: true });
      return;
    }
    if (action === SONG_DROP_ACTIONS.QUEUE_END) {
      commitStagedItem(sourceItem, { forceQueue: true });
    }
  };

  // [과도기 폴백] 다음 곡 직접 로드 + 현재 곡 즉시 completed(skipped) 처리.
  // 규범 §4-3의 finishing 전이를 열 수 없는 경우에만 쓴다:
  //  - On-Air: 프로토콜에 finish 명령이 아직 없다(Stage 7 예정) → stop/load 폴백.
  //  - 미디어(로컬·프록시 오디오)의 duration을 아직 모르는(starting) 경우.
  // (Stage 6 이후 YouTube 직접 재생은 프록시 <audio>라 로컬과 같은 규범 경로를
  //  쓴다 — iframe이라서 폴백하던 사유는 소멸했다.)
  // 성공적으로 전이를 시작하면 true를 돌려준다(D-25 토스트 근거).
  const handlePlayNext = (expectedMarker = null) => {
    const snapshot = stateRef.current || {};
    const current = snapshot.currentEntry;
    if (!current) return false;
    // 늦게 도착한 이벤트/중복 호출 가드: 마커가 있으면 현재 run과 일치해야 한다.
    if (expectedMarker && !isCurrentRun(expectedMarker)) return false;
    // failed 곡은 완료(이력 편입) 대상이 아니다(§4-5) — 재시도/버리기로만 벗어난다.
    if (activeRef.current?.entryId === current.entryId && activeRef.current.phase === 'failed') return false;

    const queue = snapshot.queue || [];
    const nextEntry = queue[0] || null;

    let nextActive = null;
    try {
      // Keep player I/O outside React's state updater. A failed WebSocket
      // command must not leave the UI looking as if it skipped successfully.
      if (nextEntry) nextActive = beginPlaybackRun(nextEntry);
      else stopPlaybackOutput({
        stoppingEntryId: current.entryId,
        stoppingRunId: activeRef.current?.runId
      });
    } catch (error) {
      showToast(error.message || t('dashboard.playback.skipFailed'), 'error');
      return false;
    }

    const finishedEntry = { ...current, phase: 'completed', completionReason: 'skipped' };
    setSharedState((previous) => {
      // Ignore duplicate clicks or a stale end event after the current song
      // has already changed.
      if (previous.currentEntry?.entryId !== current.entryId) return previous;

      const q = previous.queue || [];
      const nextHistory = [...(previous.history || []), finishedEntry];
      if (!nextEntry) return { ...previous, currentEntry: null, active: null, history: nextHistory };
      const nextIndex = q.findIndex((item) => item.entryId === nextEntry.entryId);
      return {
        ...previous,
        currentEntry: nextEntry,
        active: nextActive,
        queue: nextIndex >= 0 ? [...q.slice(0, nextIndex), ...q.slice(nextIndex + 1)] : q,
        history: nextHistory
      };
    });
    return true;
  };

  // §4-3 스킵의 1단계: 플레이어를 실제 끝으로 보내고 finishing으로 전이한다.
  // 성공 시 true — 이후 동일 runId의 실제 ended(handleConfirmedEnded)에서만
  // completed+승격이 일어난다. 길이를 모르면 열지 않는다(호출자가 폴백 판단).
  // pendingNextEntryId: completed 뒤 승격할 곡 예약(스킵 버튼=큐 첫 곡, 바로 재생=선택 곡).
  const tryBeginFinishing = (pendingNextEntryId = null) => {
    const act = activeRef.current;
    const current = stateRef.current?.currentEntry;
    if (!act || !current || act.entryId !== current.entryId) return false;

    // 이미 finishing이면 전환 대상 예약만 갱신한다(바로 재생 재클릭 등).
    if (act.phase === 'finishing') {
      if (pendingNextEntryId) {
        setSharedState((previous) => {
          const prevAct = previous.active;
          if (!prevAct || prevAct.runId !== act.runId) return previous;
          return { ...previous, active: { ...prevAct, pendingNextEntryId } };
        });
      }
      return true;
    }
    // finishing은 실제 재생이 확인된 상태에서만 연다(§3 그래프: playing/paused/buffering).
    if (!['playing', 'paused', 'buffering'].includes(act.phase)) return false;
    // On-Air 프로토콜에는 아직 finish 명령이 없다(Stage 7) → 폴백.
    if (useOnAirPlayer) return false;

    const marker = { entryId: act.entryId, runId: act.runId };
    const song = current.song;

    // §4-3 안전장치: YouTube 곡은 출력 안전성이 'safe'(=준비된 오디오)일 때만
    // 완료 처리 경로를 연다. 이 조건은 재생 존재 자체와 동치지만(blocked면
    // run이 시작되지 않음), 규범 게이트로 명시해 둔다.
    if (song.type === 'youtube' && getYoutubeOutputSafety(current) !== 'safe') return false;

    // 준비된 YouTube 오디오도 로컬 음원과 같은 <audio> 요소로 재생되므로
    // 단일 규범 경로다 — el.currentTime=duration → 결정적 ended → completed
    // (PHASE_07 §4 재생 엔진 통일).
    const el = song.type === 'local' && song.mediaType === 'video' ? videoRef.current : audioRef.current;
    const mediaDuration = el?.duration;
    if (!el || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return false;
    const sendToEnd = () => {
      // 일시정지 상태에서 끝으로 seek만 하면 ended가 발화하지 않는 브라우저가
      // 있어, 재생을 재개한 뒤 끝으로 보낸다(끝 지점이라 즉시 ended).
      if (el.paused) el.play().catch(() => {});
      el.currentTime = mediaDuration;
    };

    // 전이 중 상태를 숨기지 않는다(§5-2): 먼저 finishing을 표시하고 끝으로 보낸다.
    setSharedState((previous) => {
      const prevAct = previous.active;
      if (!prevAct || prevAct.entryId !== marker.entryId || prevAct.runId !== marker.runId) return previous;
      return {
        ...previous,
        active: {
          ...prevAct,
          phase: 'finishing',
          pendingCompletionReason: 'skipped',
          ...(pendingNextEntryId ? { pendingNextEntryId } : {})
        }
      };
    });
    try {
      sendToEnd();
    } catch {
      // 끝 이동 실패 시 finishing에 머문다 — ended가 오지 않으면 쓰레기통(§4-3
      // finishing 중 유일 허용 행동)으로 회수할 수 있고, 화면은 '스킵 중'을 유지한다.
    }
    return true;
  };

  // 스킵(§4-3): finishing → 실제 ended → completed. finishing을 열 수 없으면
  // 과도기 폴백(다음 곡 직접 로드, completionReason='skipped')을 쓴다.
  // 스킵 버튼의 의도는 '다음 곡으로'이므로 자동 다음 곡 설정과 무관하게
  // 큐 첫 곡을 전환 대상으로 예약한다(Before 동작 보존).
  const handleSkipCurrent = () => {
    const snapshot = stateRef.current || {};
    if (!snapshot.currentEntry) return false;
    const act = activeRef.current;
    if (act && act.entryId === snapshot.currentEntry.entryId) {
      if (act.phase === 'finishing' || act.phase === 'discarding') return false; // 중복 스킵 방지
      if (act.phase === 'failed') {
        showToast(t('dashboard.playback.failedActionRequired'), 'info');
        return false;
      }
    }
    const nextQueuedId = (snapshot.queue || [])[0]?.entryId || null;
    if (tryBeginFinishing(nextQueuedId)) return true;
    return handlePlayNext();
  };

  // 현재 곡 쓰레기통(§4-4): discarding → discarded. 이력에 남기지 않고
  // 자동 다음 곡을 시작하지 않는다(INV-3). 늦은 ended는 runId 불일치로 폐기된다.
  const finalizeConfirmedDiscard = (marker) => {
    const current = stateRef.current?.currentEntry;
    if (!current || !isCurrentRun(marker) || current.entryId !== marker.entryId) return;
    // 늦은 transport 스냅숏이 버린 곡을 currentEntry로 되살리지 못하게 기억한다.
    lastDiscardedEntryIdRef.current = current.entryId;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSharedState((previous) => {
      if (previous.currentEntry?.entryId !== marker.entryId
        || previous.active?.runId !== marker.runId) return previous;
      return { ...previous, currentEntry: null, active: null };
    });
    showToast(t('playback.discard.confirmed'), 'info');
  };
  finalizeDiscardRef.current = finalizeConfirmedDiscard;

  const handleDiscardCurrent = () => {
    const current = stateRef.current?.currentEntry;
    if (!current) return;
    const act = activeRef.current;
    if (act && act.entryId === current.entryId && act.phase === 'discarding') return;

    if (useOnAirPlayer && playbackModeForRun() === 'obs') {
      // Keep the song visible until the exact v2 strong-stop event proves that
      // audio is paused, detached, autoplay-cancelled, and non-audible.
      try {
        sendOnAirCommand({
          type: 'stop',
          sessionId: current.entryId,
          runId: act?.runId
        });
      } catch {
        showToast(t('playback.discard.stopRequestFailed'), 'error');
        return;
      }
      commitActivePhase(
        { entryId: current.entryId, runId: act?.runId },
        'discarding',
        { discardRequested: true }
      );
      return;
    } else if (useOnAirPlayer) {
      commitActivePhase(
        { entryId: current.entryId, runId: act?.runId },
        'discarding',
        { discardRequested: true },
      );
      try {
        Promise.resolve(dispatchPlaybackCommand({
          type: 'stop',
          sessionId: current.entryId,
          runId: act?.runId,
        }, 'speaker')).then(() => {
          finalizeDiscardRef.current?.({ entryId: current.entryId, runId: act?.runId });
        }).catch(() => {
          commitActivePhaseRef.current?.(
            { entryId: current.entryId, runId: act?.runId },
            'failed',
            { failureDetail: t('playback.discard.stopRequestFailed') },
          );
        });
      } catch {
        commitActivePhaseRef.current?.(
          { entryId: current.entryId, runId: act?.runId },
          'failed',
          { failureDetail: t('playback.discard.stopRequestFailed') },
        );
      }
      return;
    } else {
      // 직접 재생(로컬·프록시 오디오): 같은 페이지의 요소라 정지를 동기로 확정할
      // 수 있다. 언마운트만으로는 재생이 즉시 멎지 않을 수 있어 명시 정지.
      try {
        audioRef.current?.pause();
        videoRef.current?.pause();
      } catch {
        // 파괴된 미디어 요소 참조 — 언마운트가 마저 정리한다.
      }
    }
    finalizeConfirmedDiscard({ entryId: current.entryId, runId: act?.runId });
  };

  useEffect(() => {
    if (active?.phase !== 'discarding' || !active.discardRequested) return undefined;
    const marker = { entryId: active.entryId, runId: active.runId };
    const timeout = window.setTimeout(() => {
      const latest = activeRef.current;
      if (!latest || latest.runId !== marker.runId || !latest.discardRequested
        || latest.phase !== 'discarding') return;
      commitActivePhaseRef.current?.(marker, 'failed', {
        discardRequested: true,
        failureDetail: t('playback.discard.confirmationTimeout')
      });
      showToast(t('playback.discard.confirmationTimeout'), 'error');
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [active?.discardRequested, active?.entryId, active?.phase, active?.runId, showToast]);

  useEffect(() => {
    const latest = activeRef.current;
    if (!isConfirmedDiscardSnapshot({
      confirmedPlayback: outputControl.snapshot?.confirmedPlayback,
      active: latest,
      currentEntry: stateRef.current?.currentEntry
    })) return;
    finalizeDiscardRef.current?.({ entryId: latest.entryId, runId: latest.runId });
  }, [outputControl.snapshot?.confirmedPlayback]);

  // failed 재시도(§4-5): 같은 entry를 새 runId로 다시 재생한다.
  const handleRetryCurrent = () => {
    const current = stateRef.current?.currentEntry;
    const act = activeRef.current;
    if (!current || !act || act.entryId !== current.entryId || act.phase !== 'failed') return;

    let nextActive = null;
    try {
      nextActive = beginPlaybackRun(current);
    } catch (error) {
      showToast(error.message || t('dashboard.playback.retryFailed'), 'error');
      return;
    }
    setSharedState((previous) => {
      if (previous.currentEntry?.entryId !== current.entryId) return previous;
      return { ...previous, active: nextActive };
    });
    showToast(t('dashboard.playback.retryStarted'), 'info');
  };

  // 대기열 곡 바로 재생(§4-6). 현재 곡이 실제 재생 중이면 '선택 곡을 다음 전환
  // 대상으로 예약 + 현재 곡 스킵 요청'(finishing 경로)으로, finishing을 열 수
  // 없으면 과도기 폴백(직접 전환)으로 처리한다. failed 곡은 완료가 아니라
  // 폐기 대상이므로 '버리기 + 선택 곡 시작' 복합 명령이 된다(INV-3).
  const handlePlayQueuedSong = (entryId) => {
    const snapshot = stateRef.current || {};
    const selectedEntry = (snapshot.queue || []).find((item) => item.entryId === entryId);
    if (!selectedEntry) return;

    const act = activeRef.current;
    const currentIsFailed = Boolean(
      snapshot.currentEntry && act &&
      act.entryId === snapshot.currentEntry.entryId && act.phase === 'failed'
    );
    if (snapshot.currentEntry && !currentIsFailed && tryBeginFinishing(entryId)) {
      showToast(t('dashboard.queue.playAfterCurrent'), 'info');
      return;
    }

    let nextActive = null;
    try {
      nextActive = beginPlaybackRun(selectedEntry);
    } catch (error) {
      showToast(error.message || t('dashboard.queue.playSelectedFailed'), 'error');
      return;
    }

    if (currentIsFailed && snapshot.currentEntry) {
      showToast(t('dashboard.queue.replaceFailedCurrent'), 'info');
    }
    setSharedState((previous) => {
      const q = previous.queue || [];
      const selectedIndex = q.findIndex((item) => item.entryId === entryId);
      if (selectedIndex < 0) return previous;

      // failed 곡은 discarded로 끝난다 — 이력·자동 다음 곡 없음(§4-5, INV-3).
      const finished = previous.currentEntry && !currentIsFailed
        ? [{ ...previous.currentEntry, phase: 'completed', completionReason: 'skipped' }]
        : [];
      return {
        ...previous,
        currentEntry: q[selectedIndex],
        active: nextActive,
        queue: q.filter((item) => item.entryId !== entryId),
        history: [...(previous.history || []), ...finished]
      };
    });
  };

  handleSkipRef.current = handleSkipCurrent;

  // 현재 곡 '다시 예약' — 기존 항목 복제가 아니라 새 entryId의 새 QueueEntry(§1).
  const handleRequeueCurrent = () => {
    const entry = stateRef.current?.currentEntry;
    if (!entry) return;
    const replay = createQueueEntry(entry.song);
    setSharedState((previous) => ({ ...previous, queue: [...(previous.queue || []), replay] }));
    showToast(t('dashboard.queue.requeuedCurrent'), 'success');
  };

  const handleTogglePlayback = () => {
    const entry = stateRef.current?.currentEntry;
    if (!entry) return;
    // §4-3/§4-5: finishing·discarding·failed 중에는 일반 재생/일시정지를 막는다
    // (버튼 비활성 외에 Space 단축키 경로도 함께 차단).
    if (activeRef.current?.phase === 'starting' || isPhaseLocked()) return;
    if (useOnAirPlayer) {
      try {
        const action = isPlaying ? 'pause' : 'play';
        const dispatchResult = dispatchPlaybackCommand({
          type: action,
          sessionId: entry.entryId,
          runId: activeRef.current?.runId
        });
        trackObsRemoteControlRequest(action, dispatchResult);
        Promise.resolve(dispatchResult).catch((error) => showToast(error.message, 'error'));
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }
    // 직접 재생: 명령은 미디어에 직접 보내고, isPlaying/phase 확정은
    // 실제 playing/paused 이벤트에서만 한다(INV-5).
    try {
      if (isPlaying) {
        audioRef.current?.pause();
        videoRef.current?.pause();
      } else {
        audioRef.current?.play().catch(() => console.log('Play interrupted'));
        videoRef.current?.play().catch(() => console.log('Play interrupted'));
      }
    } catch {
      // 파괴된 미디어 요소 참조 등 — 다음 확인 이벤트가 상태를 바로잡는다.
    }
  };

  const handleVolumeChange = (nextVolume) => {
    const clamped = Math.max(0, Math.min(100, Number(nextVolume) || 0));
    const targetMode = activeRef.current?.outputMode === 'obs'
      ? 'obs'
      : activeRef.current?.outputMode === 'speaker'
        ? 'speaker'
        : outputModePreference === 'obs' ? 'obs' : 'speaker';
    setVolumeProfiles((previous) => updateOutputVolumeProfile(previous, targetMode, clamped));
    if (useOnAirPlayer && currentEntry) {
      try {
        const dispatchResult = dispatchPlaybackCommand({
          type: 'volume',
          sessionId: currentEntry.entryId,
          runId: activeRef.current?.runId,
          volume: clamped
        });
        trackObsRemoteControlRequest('volume', dispatchResult);
        Promise.resolve(dispatchResult).catch((error) => showToast(error.message, 'error'));
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
  };

  // OS lock-screen, notification, and headset controls are a Speaker-only
  // alternate input surface. The active run (not the selected preference) is
  // authoritative so an OBS run can never receive a Media Session command.
  useEffect(() => {
    const activeRun = activeRef.current;
    speakerMediaSessionController.update({
      active: Boolean(currentSong && activeRun?.outputMode === 'speaker'),
      song: currentSong,
      isPlaying,
      currentTime,
      mediaDuration: duration,
      callbacks: {
        onPlay: () => {
          if (activeRef.current?.phase === 'failed') {
            handleRetryCurrent();
            return;
          }
          if (!isPlaying) handleTogglePlayback();
        },
        onPause: () => {
          if (isPlaying) handleTogglePlayback();
        },
        onNext: () => handleSkipRef.current?.(),
        onSeek: (position) => handleSeek(position),
      },
    });
  });

  useEffect(() => () => {
    speakerMediaSessionController.dispose();
  }, [speakerMediaSessionController]);

  const handleEndBroadcastSession = () => {
    if (!useOnAirPlayer) {
      // §4-7/INV-8: 세션 종료 확정 — 재생을 먼저 멈추고, 현재 곡·대기열·이력이
      // 참조하는 임시 blob을 일괄 revoke한 뒤 목록을 정리한다(abandoned).
      // 이후 currentEntry cleanup effect가 같은 src를 다시 만나도 revoke는
      // 멱등이라 이중 정리가 안전하다.
      try {
        audioRef.current?.pause();
        videoRef.current?.pause();
      } catch {
        // 파괴된 미디어 요소 참조 — 언마운트가 마저 정리한다.
      }
      revokePageBlobSrcs(collectBlobSrcs(stateRef.current));
      setSharedState((previous) => ({ ...previous, currentEntry: null, active: null, queue: [], history: [] }));
      setIsPlaying(false);
      return;
    }
    try {
      explicitSessionEndRequestedRef.current = true;
      sendOnAirCommand({ type: 'end_session' });
    } catch (error) {
      explicitSessionEndRequestedRef.current = false;
      showToast(error.message, 'error');
    }
  };

  const handlePlaybackDelay = (marker, source) => {
    // finishing(끝으로 seek 직후 buffering이 흔함)·discarding·failed 중에는 지연
    // 안내가 소음이다 — 전이 상태 표시가 우선한다.
    if (!isCurrentRun(marker) || isPhaseLocked() || reportedDelayRef.current === marker.runId) return;
    reportedDelayRef.current = marker.runId;
    showToast(t('dashboard.playback.delayed', { source }), 'info');
  };

  // 재생 오류 → failed 확정(§4-5). 자동 스킵하지 않는다 — 실패 곡을 몰래
  // 건너뛰거나 완료 이력에 넣지 않고(INV-3), 재시도/버리기를 제시한다.
  const handleMediaFailure = (marker, source, detail = '') => {
    if (!isCurrentRun(marker) || reportedMediaIssueRef.current === marker.runId) return;
    reportedMediaIssueRef.current = marker.runId;
    const failureDetail = detail
      ? t('dashboard.playback.failureDetail', { source, detail })
      : t('dashboard.playback.failure', { source });
    setIsPlaying(false);
    commitActivePhase(marker, 'failed', { failureDetail });
    showToast(t('dashboard.playback.failureAction', { detail: failureDetail }), 'error');
  };
  handleMediaFailureRef.current = handleMediaFailure;

  const handleLocalSpeakerEvidence = (evidence) => {
    const act = activeRef.current;
    if (!act || act.outputMode !== 'speaker' || act.runId !== evidence?.runId) return;
    const marker = { entryId: act.entryId, runId: act.runId };
    if (Number.isFinite(evidence.mediaTime)) setCurrentTime(evidence.mediaTime);
    if (Number.isFinite(evidence.duration)) setDuration(evidence.duration);
    if (evidence.type === 'playing') handleConfirmedPlaying(marker);
    if (evidence.type === 'paused') handleConfirmedPaused(marker);
    if (evidence.type === 'buffering') {
      handlePlaybackDelay(marker, t('playback.localSpeaker.source'));
    }
    if (evidence.type === 'ended') handleConfirmedEnded(marker, 'natural');
    if (evidence.type === 'error') {
      const actionMessageKey = evidence.code === 'play_rejected'
        ? 'playback.localSpeaker.autoplayBlocked'
        : evidence.code === 'media_postcondition_failed'
          ? 'playback.localSpeaker.startFailed'
          : 'playback.localSpeaker.loadFailed';
      handleMediaFailure(
        marker,
        t('playback.localSpeaker.source'),
        t(actionMessageKey),
      );
    }
  };

  // A v2 LOAD transition is fail-closed. If its authoritative route proof is
  // lost while the UI is still waiting for the first PLAY confirmation, make
  // the run explicitly retryable instead of leaving it stuck on “preparing”.
  useEffect(() => {
    const act = activeRef.current;
    if (!useOnAirPlayer || act?.outputMode !== 'obs'
      || act?.phase !== 'starting' || outputRouteStable) return;
    handleMediaFailureRef.current?.(
      { entryId: act.entryId, runId: act.runId },
      t('onair.output.playback.source'),
      t('onair.output.playback.routeLostDuringStart')
    );
  }, [outputRouteStable, useOnAirPlayer]);

  useEffect(() => {
    const act = activeRef.current;
    if (playbackTransitionState?.status !== 'failed'
      || act?.outputMode !== 'obs'
      || act?.phase !== 'starting'
      || playbackTransitionState.entryId !== act.entryId
      || playbackTransitionState.runId !== act.runId) return;
    handleMediaFailureRef.current?.(
      { entryId: act.entryId, runId: act.runId },
      t('onair.output.playback.source'),
      t('onair.output.playback.transitionFailed')
    );
  }, [
    playbackTransitionState?.entryId,
    playbackTransitionState?.runId,
    playbackTransitionState?.status
  ]);

  // (Stage 6의 프록시 시작 타임아웃·프리페치는 준비 파이프라인으로 대체됐다.
  //  On-Air 경로의 시작 타임아웃은 OnAirPlayer가 자체 보유하고, 대기열 곡의
  //  사전 준비는 스테이징 시점 prepare + 폴링이 담당한다.)

  const handleRemoveFromQueue = (entryId) => {
    const queue = stateRef.current?.queue || [];
    const removedIndex = queue.findIndex((item) => item.entryId === entryId);
    const removedEntry = queue[removedIndex];

    if (!removedEntry) return;

    setSharedState(prev => ({
      ...prev,
      queue: (prev.queue || []).filter((item) => item.entryId !== entryId)
    }));

    // Stage 4 (D-02 동일 규칙): 제거로 마지막 참조가 사라진 blob은 회수한다.
    // 단, 아래 되돌리기 토스트(5초)가 항목을 복구할 수 있으므로 즉시 회수하면
    // 복구된 곡이 조용히 재생 불가가 된다(D-02의 변종). 토스트 수명보다 긴
    // 유예 뒤, 그 시점의 최신 상태에서 여전히 미참조일 때만 회수한다.
    if (isLocalBlobSong(removedEntry.song)) {
      const removedSrc = removedEntry.song.src;
      setTimeout(() => {
        if (!isBlobReferenced(removedSrc, stateRef.current)) revokePageBlobSrcs([removedSrc]);
      }, 6000);
    }

    showToast(t('dashboard.queue.removed', { title: removedEntry.song.title }), 'info', {
      label: t('dashboard.queue.undo'),
      onClick: () => {
        setSharedState(prev => {
          const currentQueue = prev.queue || [];
          if (currentQueue.some((item) => item.entryId === removedEntry.entryId)) return prev;

          const restoredQueue = [...currentQueue];
          restoredQueue.splice(Math.min(removedIndex, restoredQueue.length), 0, removedEntry);
          return { ...prev, queue: restoredQueue };
        });
      }
    });
  };

  const scheduleBlobRevocation = (srcs, delayMs = 0) => {
    const candidates = [...srcs];
    if (candidates.length === 0) return;
    window.setTimeout(() => {
      candidates.forEach((src) => {
        if (!isBlobReferenced(src, stateRef.current)) revokePageBlobSrcs([src]);
      });
    }, delayMs);
  };

  const handleClearQueue = () => {
    const queue = stateRef.current?.queue || [];
    const srcs = collectBlobSrcs({ queue, history: [], currentEntry: null });
    setSharedState((previous) => ({ ...previous, queue: [] }));
    scheduleBlobRevocation(srcs);
  };

  const handleRemoveHistoryItem = (entryId) => {
    const history = stateRef.current?.history || [];
    const removed = history.find((entry) => entry.entryId === entryId);
    if (!removed) return;
    const srcs = collectBlobSrcs({ queue: [], history: [removed], currentEntry: null });
    setSharedState((previous) => ({
      ...previous,
      history: (previous.history || []).filter((entry) => entry.entryId !== entryId),
    }));
    scheduleBlobRevocation(srcs);
  };

  const handleRestoreLocalFile = async ({ entryId, location }, file) => {
    const list = location === 'history'
      ? (stateRef.current?.history || [])
      : (stateRef.current?.queue || []);
    const sourceEntry = list.find((entry) => entry.entryId === entryId);
    if (!sourceEntry || !isExpiredLocalSongDef(sourceEntry.song)) {
      showToast(t('queue.localFile.restoreMissing'), 'error');
      return false;
    }
    const supported = file
      && (file.type?.startsWith('audio/') || file.type === 'video/mp4');
    if (!supported) {
      showToast(t('search.file.invalidType'), 'error');
      return false;
    }
    if (file.size > LOCAL_FILE_MAX_BYTES) {
      showToast(t('search.file.tooLarge'), 'error');
      return false;
    }

    const mediaType = file.type === 'video/mp4' ? 'video' : 'audio';
    let restoredSong;
    let blobSrc = null;
    if (useOnAirPlayer) {
      showToast(t('dashboard.localFile.preparing'), 'info');
      try {
        const asset = await onAir.uploadAsset(file);
        restoredSong = sanitizeSongDef({
          ...sourceEntry.song,
          src: asset.assetId,
          assetId: asset.assetId,
          localSourceExpired: false,
          localBlobBytes: file.size,
          mediaType,
        });
      } catch {
        showToast(t('queue.localFile.restoreFailed'), 'error');
        return false;
      }
    } else {
      try {
        blobSrc = createPageBlobSrc(file);
      } catch {
        showToast(t('queue.localFile.restoreFailed'), 'error');
        return false;
      }
      restoredSong = restoreLocalBlobSong(sourceEntry.song, {
        src: blobSrc,
        bytes: file.size,
        mediaType,
      });
    }
    if (!restoredSong) {
      if (blobSrc) revokePageBlobSrcs([blobSrc]);
      showToast(t('queue.localFile.restoreMissing'), 'error');
      return false;
    }

    const latestList = location === 'history'
      ? (stateRef.current?.history || [])
      : (stateRef.current?.queue || []);
    const latestSourceEntry = latestList.find((entry) => entry.entryId === entryId);
    if (!latestSourceEntry || !isExpiredLocalSongDef(latestSourceEntry.song)) {
      if (blobSrc) revokePageBlobSrcs([blobSrc]);
      showToast(t('queue.localFile.restoreMissing'), 'error');
      return false;
    }

    if (location === 'history') {
      const replay = createQueueEntry(restoredSong);
      setSharedState((previous) => {
        if (!(previous.history || []).some((entry) => entry.entryId === entryId)) return previous;
        return { ...previous, queue: [replay, ...(previous.queue || [])] };
      });
      showToast(t('queue.localFile.restoredHistory', { title: sourceEntry.song.title }), 'success');
    } else {
      setSharedState((previous) => {
        if (!(previous.queue || []).some((entry) => entry.entryId === entryId)) return previous;
        return {
          ...previous,
          queue: (previous.queue || []).map((entry) => entry.entryId === entryId
            ? { ...entry, song: restoredSong, phase: 'queued', completionReason: null }
            : entry),
        };
      });
      showToast(t('queue.localFile.restoredQueue', { title: sourceEntry.song.title }), 'success');
    }
    return true;
  };

  togglePlaybackRef.current = handleTogglePlayback;
  onAirEventHandlerRef.current = (payload) => {
    if (payload.type === 'snapshot' || payload.type === 'transport') {
      // Legacy observer snapshots describe the Worker/OBS transport. A local
      // speaker run owns its own timeline and must never be paused, restored,
      // or relabelled by a late remote snapshot.
      if (actualOutputMode !== 'obs' && activeRef.current?.outputMode !== 'obs') return;
      const remoteTransport = payload.transport || {};
      const remoteSong = remoteTransport.song;
      if (remoteSong?.id && remoteSong.id !== lastDiscardedEntryIdRef.current) {
        // Worker transport 스냅숏 복원: load 시 내보낸 평면 곡(id=entryId)을
        // QueueEntry로 되감아 currentEntry/active를 재구성한다.
        // 방금 버린 entryId는 되살리지 않는다 — discard 의도가 우선한다(§4-4).
        const restored = toQueueEntry(remoteSong, 'starting');
        if (restored) {
          const restoredActive = {
            entryId: restored.entryId,
            runId: newId(),
            phase: onAirStatusToPhase(remoteTransport.status)
          };
          setSharedState((previous) => {
            if (previous.currentEntry?.entryId === restored.entryId) return previous;
            return { ...previous, currentEntry: restored, active: restoredActive };
          });
        }
      }
      if (Number.isFinite(remoteTransport.position)) setCurrentTime(remoteTransport.position);
      if (Number.isFinite(remoteTransport.duration)) setDuration(remoteTransport.duration);
      setIsPlaying(remoteTransport.status === 'playing' || remoteTransport.status === 'buffering' || remoteTransport.status === 'loading');
    }
    if (payload.type === 'player_event') {
      const event = payload.event || {};
      const remoteTransport = payload.transport || {};
      if (Number.isFinite(remoteTransport.position)) setCurrentTime(remoteTransport.position);
      if (Number.isFinite(event.duration)) setDuration(event.duration);
      // Protocol v2 reports the runId; the legacy observer reports entryId.
      // Never let a late event from the previous run mutate the current song.
      const act = activeRef.current;
      if (act?.outputMode !== 'obs') return;
      const eventIdentityMatches = payload.protocolVersion === 2
        ? act?.runId === String(event.sessionId || '')
        : act?.entryId === String(event.sessionId || '');
      const marker = act && eventIdentityMatches
        ? { entryId: act.entryId, runId: act.runId }
        : null;
      if (!marker) return;
      if (event.type === 'playing') handleConfirmedPlaying(marker);
      if (event.type === 'paused') handleConfirmedPaused(marker);
      if (event.type === 'buffering') {
        handlePlaybackDelay(marker, t('dashboard.playback.source.onAirPlayer'));
      }
      if (isConfirmedDiscardStop({
        protocolVersion: payload.protocolVersion,
        event,
        active: act,
        currentEntry: stateRef.current?.currentEntry
      })) finalizeConfirmedDiscard(marker);
      if (event.type === 'ended') handleConfirmedEnded(marker, 'natural');
      if (event.type === 'error') {
        setIsPlaying(false);
        handleMediaFailure(
          marker,
          t('dashboard.playback.source.onAirPlayer'),
          t('dashboard.playback.error.generic'),
        );
      }
    }
    if (payload.type === 'session_ended') {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      const reason = payload.reasonCode || payload.reason || '';
      if (reason === 'explicit') {
        // Destructive list cleanup is reserved for the user's explicit
        // "end broadcast" action. A player timeout or OBS restart must never
        // erase a setlist.
        revokePageBlobSrcs(collectBlobSrcs(stateRef.current));
        setSharedState((previous) => ({ ...previous, currentEntry: null, active: null, queue: [], history: [] }));
        showToast(t('onair.session.ended.explicit'), 'info');
        return;
      }

      if (activeRef.current?.outputMode === 'speaker') {
        showToast(t('onair.session.ended.localSpeakerContinues'), 'info');
        return;
      }

      // Unexpected expiry/disconnect only retires runtime state. Put the
      // interrupted song back at the front so its metadata and ordering stay
      // recoverable after the user creates a new On-Air connection.
      setSharedState((previous) => {
        const interrupted = previous.currentEntry;
        const queue = previous.queue || [];
        const nextQueue = interrupted && !queue.some((item) => item.entryId === interrupted.entryId)
          ? [interrupted, ...queue]
          : queue;
        return { ...previous, currentEntry: null, active: null, queue: nextQueue };
      });
      showToast(t('onair.session.ended.unexpected'), 'error');
    }
  };

  // 숨김 플레이어는 (currentEntry, active)에서 파생되고 key=runId로 리마운트된다.
  // 마운트 시점의 runMarker가 모든 이벤트 핸들러에 클로저로 캡처되어 전달된다.
  const runMarker = active ? { entryId: active.entryId, runId: active.runId } : null;
  const liveSong = !useOnAirPlayer && runMarker && currentEntry && currentEntry.entryId === active.entryId
    ? currentEntry.song
    : null;

  // 스테이징 곡의 준비 상태(YouTube만 해당) — StagingPanel의 안내문·버튼 라벨 근거.
  const stagedPrepareState = stagedItem?.type === 'youtube'
    ? songPrepareState({ type: 'youtube', src: stagedItem.src }, prepareStates)
    : null;

  return (
    <div className={`dashboard-container ${stagedItem ? 'staging-active' : ''}`}>
      <header className="dashboard-header">
        <div className="dashboard-branding">
          <h1 className="logo">Rekasong</h1>
        </div>
        <div id="dashboard-output-route-bar" className="dashboard-output-route-bar" aria-label={t('onair.output.region.label')}>
          <span className="dashboard-brand-hairline" aria-hidden="true" />
        </div>
      </header>

      <div className="dashboard-grid">
        <div className="playback-area">
        <ErrorBoundary>
          <PlaybackPanel
            room={room}
            publicKeyB64={signingKeys?.publicKeyB64}
            currentSong={currentSong}
            activePhase={active?.phase || null}
            failureDetail={active?.failureDetail || ''}
            onSkip={handleSkipCurrent}
            onDiscardCurrent={handleDiscardCurrent}
            onRetryCurrent={handleRetryCurrent}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlayback}
            volume={volume}
            volumeOutputMode={volumeOutputMode}
            onVolumeChange={handleVolumeChange}
            speakerOutputDevice={speakerOutputDevice}
            onChooseSpeakerOutputDevice={handleChooseSpeakerOutputDevice}
            onResetSpeakerOutputDevice={handleResetSpeakerOutputDevice}
            currentTime={currentTime}
            duration={duration}
            onSeek={handleSeek}
            onRequeueCurrent={handleRequeueCurrent}
            showToast={showToast}
            onAirPlayerUrl={onAir.playerUrl}
            onAirDisplayUrl={onAir.displayUrl}
            onAirStatus={onAirSessionState}
            onAirPlayerCandidate={obsPlayerCandidate}
            obsSourceInactive={obsSourceInactive}
            onAirDisplayConnected={onAir.displayConnected}
            onPrepareOnAir={onAir.preparePlayer}
            onPrepareOnAirDisplay={onAir.prepareDisplay}
            onRecoverOnAir={recoverOnAirConnection}
            onEndBroadcastSession={handleEndBroadcastSession}
            canEndBroadcastSession={canEndBroadcastSession}
            outputMode={selectedOutputMode}
            pendingOutputMode={queuedOutputIntent?.mode ?? null}
            actualOutputMode={speakerPlayerMode ? 'speaker' : actualOutputMode}
            failedOutputMode={failedOutputMode}
            outputView={playbackOutputView}
            outputControlConflict={speakerPlayerMode ? false : outputControlConflict}
            outputControlUnavailable={speakerPlayerMode ? false : outputControlUnavailable}
            outputControlRecoveryReason={speakerPlayerMode ? null : outputControlRecoveryReason}
            outputControlSafeToTakeOver={outputControlSafeToTakeOver}
            outputControlTakeover={outputControl.snapshot?.pendingTakeover ?? null}
            outputControlRecoveryRequired={speakerPlayerMode ? false : outputControlRecoveryRequired}
            outputRouteStable={outputRouteStable}
            outputSwitchState={outputSwitchUiState}
            outputSwitchReasonCode={outputControl.outputSwitchState?.reasonCode ?? null}
            obsAudioCheck={obsAudioCheck}
            obsMixerVerification={obsMixerVerification}
            obsRemoteControlFeedback={obsRemoteControlFeedback}
            allowOutputSelectionWhileConnecting={speakerPlayerMode || outputBootstrapSelectionAvailable}
            onSelectOutputMode={handleSelectOutputMode}
            onStartObsAudioCheck={outputControl.startTest}
            onStopObsAudioCheck={outputControl.stopTest}
            onConfirmObsMixerSignal={handleConfirmObsMixerSignal}
            onReportMissingObsMixerSignal={handleReportMissingObsMixerSignal}
            onEmergencyStopOutput={outputControl.emergencyStop}
            onResetOutputControl={outputControl.resetOutputControl}
            onTakeOverOutputControl={outputControl.takeOverControl}
            onRetryOutputControl={retryOutputControlNow}
            locale={locale}
            onLocaleChange={setLocale}
          />
        </ErrorBoundary>
        </div>
        <div className="queue-area">
          <ErrorBoundary>
            <QueuePanel
              queue={state?.queue || []}
              history={state?.history || []}
              onPlayQueueItem={handlePlayQueuedSong}
              onRemoveFromQueue={handleRemoveFromQueue}
              onClearQueue={handleClearQueue}
              onRemoveHistoryItem={handleRemoveHistoryItem}
              onRestoreLocalFile={handleRestoreLocalFile}
              autoPlayNext={Boolean(state?.autoPlayNext)}
              setSharedState={setSharedState}
              prepareStates={prepareStates}
              onRetryPrepare={handleRetryPrepare}
            />
          </ErrorBoundary>
        </div>
        <div className="composer-area">
          <ErrorBoundary>
            <SongComposer
              stagedItem={stagedItem}
              searchProps={{
                onSelectResult: handleSelectSearchResult,
                onLocalFileDrop: handleLocalFileDrop,
                onSongDragStart: setSongDragCandidate,
                onSongDragEnd: () => setSongDragCandidate(null),
                sharedState: state || {},
                setSharedState,
                showToast
              }}
              stagingProps={{
                onAliasChange: handleAliasChange,
                onGoLive: handleGoLive,
                onClearStaged: handleClearStaged,
                hasCurrentSong: Boolean(currentEntry),
                isAiLoading,
                aiStatusMessage,
                aiStatusPhase,
                onRetryAiExtraction: handleRetryAiExtraction,
                prepareState: stagedPrepareState,
                onRetryPrepare: handleRetryPrepare,
                showToast
              }}
            />
          </ErrorBoundary>
        </div>
      </div>

      <SongDropTray
        candidate={songDragCandidate}
        hasCurrentSong={Boolean(currentEntry)}
        onDrop={handleSongDrop}
      />

      {/* Toast Notifications Container */}
      <div className="toast-container" aria-live="polite" aria-atomic="false">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action.onClick();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Hidden Live Players — key={runId}: 같은 src 연속 재생도 리마운트+autoPlay.
          Stage 6c 불변식: YouTube 곡은 여기서 절대 재생되지 않는다 — 준비된
          오디오는 On-Air 위젯(OnAirPlayer)이 재생하고, 세션 없는 직접 재생
          모드에서는 beginPlaybackRun이 YouTube run 생성 자체를 막는다(blocked).
          iframe 등 광고가 나갈 수 있는 폴백 경로는 존재하지 않는다. */}
      <div className="live-players-hidden">
        {useOnAirPlayer && onAirSession?.room && onAirSession?.playerToken && (
          <Suspense fallback={null}>
            <DashboardLocalSpeaker
              ref={localSpeakerRef}
              apiBaseUrl={onAir.baseUrl}
              room={onAirSession.room}
              token={onAirSession.playerToken}
              sinkId={speakerOutputDevice.deviceId}
              onEvidence={handleLocalSpeakerEvidence}
              onSinkError={handleSpeakerSinkRestoreFailure}
              onStateChange={setLocalSpeakerState}
            />
          </Suspense>
        )}
        {liveSong?.type === 'local' && liveSong.mediaType === 'video' && (
          <video
            key={runMarker.runId}
            ref={bindVideoElement}
            src={liveSong.src}
            autoPlay
            playsInline
            onPlaying={() => handleConfirmedPlaying(runMarker)}
            onPause={() => handleConfirmedPaused(runMarker)}
            onEnded={() => handleConfirmedEnded(runMarker, 'natural')}
            onWaiting={() => handlePlaybackDelay(runMarker, t('dashboard.playback.source.localVideo'))}
            onError={() => handleMediaFailure(
              runMarker,
              t('dashboard.playback.source.localVideo'),
              t('dashboard.playback.error.mp4'),
            )}
          />
        )}
        {liveSong?.type === 'local' && liveSong.mediaType !== 'video' && (
          <audio
            key={runMarker.runId}
            ref={bindAudioElement}
            src={liveSong.src}
            autoPlay
            onPlaying={() => handleConfirmedPlaying(runMarker)}
            onPause={() => handleConfirmedPaused(runMarker)}
            onEnded={() => handleConfirmedEnded(runMarker, 'natural')}
            onWaiting={() => handlePlaybackDelay(runMarker, t('dashboard.playback.source.localAudio'))}
            onError={() => {
              const errorCode = audioRef.current?.error?.code;
              const details = {
                1: t('dashboard.playback.error.aborted'),
                2: t('dashboard.playback.error.network'),
                3: t('dashboard.playback.error.decode'),
                4: t('dashboard.playback.error.unsupported'),
              };
              handleMediaFailure(
                runMarker,
                t('dashboard.playback.source.localAudio'),
                details[errorCode] || t('dashboard.playback.error.read'),
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
