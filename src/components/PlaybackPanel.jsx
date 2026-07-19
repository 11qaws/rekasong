import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ListMusic, MonitorUp, Pause, Play, Radio, Repeat, RotateCcw, Settings, SkipForward, Trash2, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { getOutputMessage as t } from '../copy/outputMessages';

// 위젯 연결 칩 — 서버가 중계하는 **일반 브라우저 페이지 presence**에만 근거한다.
// 이 값만으로 OBS CEF, 오디오 믹서, 녹화/송출 경로를 확인했다고 말하면 안 된다.
function WidgetStatusChip({ connected, connectedLabel, waitingLabel }) {
  return (
    <span className={`obs-player-status ${connected ? 'is-on' : 'is-waiting'}`} role="status">
      {connected ? <Check size={13} /> : <span className="obs-status-dot" aria-hidden="true" />}
      {connected ? connectedLabel : waitingLabel}
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
  onAirPlayerConnected,
  onAirDisplayConnected,
  onEndBroadcastSession,
  onPrepareOnAir,
  onPrepareOnAirDisplay
}) {
  const [previousVolume, setPreviousVolume] = useState(100);
  // 드래그 커밋: range 슬라이더의 onChange 는 드래그 중 연발한다. 이동 중엔
  // 미리보기(로컬 상태)만 갱신하고 놓을 때 한 번만 실제 명령을 보낸다 — On-Air
  // seek/volume 명령 연발이 DO 쓰기 폭풍(무료 티어 한도)과 재생 재요청을 일으키던
  // 것을 뿌리에서 없앤다. (Worker 는 seek 을 이미 영속하지 않는다.)
  const [seekDraft, setSeekDraft] = useState(null);
  const [volumeDraft, setVolumeDraft] = useState(null);
  const commitSeek = () => { if (seekDraft !== null) { onSeek(seekDraft); setSeekDraft(null); } };
  const commitVolume = () => { if (volumeDraft !== null) { onVolumeChange(volumeDraft); setVolumeDraft(null); } };
  const [isObsSetupOpen, setIsObsSetupOpen] = useState(false);
  const [isPreparingPlayer, setIsPreparingPlayer] = useState(false);
  const [preparedPlayerUrl, setPreparedPlayerUrl] = useState('');
  const [isPreparingDisplay, setIsPreparingDisplay] = useState(false);
  const [preparedDisplayUrl, setPreparedDisplayUrl] = useState('');
  const obsSetupTriggerRef = useRef(null);
  const obsDialogRef = useRef(null);
  const obsDialogTitleRef = useRef(null);
  const isMuted = volume === 0;
  const playerUrl = onAirPlayerUrl || preparedPlayerUrl;
  const displayUrl = onAirDisplayUrl || preparedDisplayUrl;
  // N-01 (Stage 5): 직접 재생 모드(On-Air 미설정)의 화면 정보 위젯 주소.
  // 구버전 room&key 위젯과 동일한 형식이라 예전에 복사해 둔 주소도 계속 동작하며,
  // 이 주소가 구독하는 발행 payload는 축소 projection(N-08)뿐이다.
  const isDirectMode = onAirStatus === 'unconfigured';
  const directWidgetUrl = room && publicKeyB64
    ? `${window.location.origin}${window.location.pathname}#/widget?room=${encodeURIComponent(room)}&key=${encodeURIComponent(publicKeyB64)}`
    : '';

  // 생애주기 전이 중/실패 상태(§2-1) — 일반 재생 조작을 잠그고 상태를 드러낸다.
  // finishing: 쓰레기통만 허용(§4-3) · discarding: 중복 조작 방지(§4-4)
  // failed: 재시도·버리기만 제시(§4-5).
  const isFinishing = activePhase === 'finishing';
  const isDiscarding = activePhase === 'discarding';
  const isFailed = activePhase === 'failed';
  const controlsLocked = isFinishing || isDiscarding || isFailed;
  const phaseBadgeText = isFinishing ? t('playback.phase.skipping')
    : isDiscarding ? t('playback.phase.discarding')
    : isFailed ? t('playback.phase.failed')
    : isPlaying ? t('playback.phase.onAir') : t('playback.phase.paused');

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
    const url = await preparePlayer();
    if (url) copyUrl(url, t('obs.setup.player.urlCopied'));
  };

  const prepareDisplay = async () => {
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
    const url = await prepareDisplay();
    if (url) copyUrl(url, t('obs.setup.display.urlCopied'));
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
          {currentSong && <span className={`on-air-badge ${isPlaying && !controlsLocked ? '' : 'is-paused'}`}>{phaseBadgeText}</span>}
          <button
            ref={obsSetupTriggerRef}
            type="button"
            onClick={() => setIsObsSetupOpen(true)}
            className="btn-icon"
            title={t('obs.setup.openLabel')}
            aria-label={t('obs.setup.openLabel')}
            aria-haspopup="dialog"
            aria-expanded={isObsSetupOpen}
            aria-controls="obs-setup-dialog"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {currentSong ? (
        <div className="playback-now">
          <div className="playback-title-row">
            <strong>{currentSong.title}</strong>
          </div>
          <div className="playback-controls">
            {/* finishing/discarding/failed 중 일반 재생 조작 잠금(§4-3, §4-5). */}
            <button type="button" onClick={onTogglePlay} className="btn-icon playback-primary" disabled={controlsLocked} title={controlsLocked ? t('playback.control.locked') : isPlaying ? t('playback.control.pause') : t('playback.control.play')}>
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button type="button" onClick={toggleMute} className="btn-icon" title={isMuted ? t('playback.control.unmute') : t('playback.control.mute')}>
              {isMuted ? <VolumeX size={16} /> : volume < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            <input aria-label={t('playback.control.volume')} type="range" min="0" max="100" value={volumeDraft ?? volume} onChange={(event) => setVolumeDraft(Number(event.target.value))} onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} className="volume-slider" />
            {/* D-01: 클릭 이벤트 객체가 expectedMarker 인자로 넘어가지 않게 인자 없이 호출한다. */}
            <button type="button" onClick={() => onSkip()} className="btn-icon" disabled={controlsLocked} title={isFinishing ? t('playback.control.skipFinishing') : isFailed ? t('playback.control.skipFailed') : t('playback.control.skip')}><SkipForward size={17} /></button>
            {isFailed && (
              // §4-5 재시도: 같은 곡을 새 시도(runId)로 다시 재생한다.
              <button type="button" onClick={() => onRetryCurrent?.()} className="btn-icon" title={t('playback.control.retry')}><RotateCcw size={16} /></button>
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
              disabled={isDiscarding}
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
              <input aria-label={t('playback.control.seek')} type="range" min="0" max={duration || 100} value={seekDraft ?? currentTime} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} className="progress-slider" disabled={controlsLocked} />
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

            {!isDirectMode && (
              <p className="obs-session-url-note" role="note">
                {t('obs.setup.sessionUrl')}
              </p>
            )}

            {/* 대시보드↔서버(control) 상태 — 아래 위젯 연결 칩과는 별개의 정보라
                무채색 한 줄로 구분한다. "서버 준비"를 위젯 연결로 오해하지 않게. */}
            {!isDirectMode && (
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
                  <button type="button" onClick={copyPlayerUrl} className="btn-copy" disabled={isPreparingPlayer || onAirStatus === 'unconfigured'}>
                    {isPreparingPlayer ? t('obs.setup.player.preparing') : <><Copy size={14} /> {playerUrl ? t('obs.setup.player.copyUrl') : t('obs.setup.player.prepareAndCopy')}</>}
                  </button>
                  {isDirectMode ? (
                    <span className="obs-player-status is-waiting">
                      <span className="obs-status-dot" aria-hidden="true" /> {t('obs.setup.player.serverRequired')}
                    </span>
                  ) : (
                    // 이 presence는 일반 player 페이지 연결만 뜻한다. OBS CEF 또는
                    // 최종 방송 오디오가 확인됐다는 의미로 사용하지 않는다.
                    <WidgetStatusChip
                      connected={Boolean(onAirPlayerConnected)}
                      connectedLabel={t('obs.setup.player.connected')}
                      waitingLabel={t('obs.setup.player.waiting')}
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
                      <button type="button" onClick={copyDisplayUrl} className="btn-copy" disabled={isPreparingDisplay}>
                        {isPreparingDisplay ? t('obs.setup.player.preparing') : <><Copy size={14} /> {displayUrl ? t('obs.setup.display.copyUrl') : t('obs.setup.display.prepareAndCopy')}</>}
                      </button>
                      <WidgetStatusChip
                        connected={Boolean(onAirDisplayConnected)}
                        connectedLabel={t('obs.setup.display.connected')}
                        waitingLabel={t('obs.setup.display.waiting')}
                      />
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
                <button
                  type="button"
                  className="btn-secondary"
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
