import React, { useState } from 'react';
import { AlertOctagon, Check, Copy, ListMusic, MonitorUp, Pause, Play, Radio, Repeat, Settings, SkipForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';

export default function PlaybackPanel({
  room,
  publicKeyB64,
  currentSong,
  isPlaying,
  onTogglePlay,
  onSkip,
  volume,
  onVolumeChange,
  currentTime,
  duration,
  onSeek,
  setSharedState,
  showToast,
  onAirPlayerUrl,
  onAirStatus,
  onEndBroadcastSession,
  onPrepareOnAir
}) {
  const [panicArmed, setPanicArmed] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(100);
  const [isObsSetupOpen, setIsObsSetupOpen] = useState(false);
  const [isPreparingPlayer, setIsPreparingPlayer] = useState(false);
  const [preparedPlayerUrl, setPreparedPlayerUrl] = useState('');
  const widgetUrl = `${window.location.origin}${window.location.pathname}#/widget?room=${room}&key=${encodeURIComponent(publicKeyB64 || '')}`;
  const isMuted = volume === 0;
  const playerUrl = onAirPlayerUrl || preparedPlayerUrl;

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
      showToast?.('위젯 주소를 복사하지 못했습니다.', 'error');
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
      showToast?.(error.message || 'On-Air 플레이어를 준비하지 못했습니다.', 'error');
      return '';
    } finally {
      setIsPreparingPlayer(false);
    }
  };

  const copyPlayerUrl = async () => {
    const url = await preparePlayer();
    if (url) copyUrl(url, 'OBS On-Air 플레이어 주소를 복사했습니다.');
  };

  const toggleMute = () => {
    if (isMuted) onVolumeChange(previousVolume || 50);
    else {
      setPreviousVolume(volume);
      onVolumeChange(0);
    }
  };

  const handlePanic = () => {
    if (!panicArmed) {
      setPanicArmed(true);
      showToast?.('한 번 더 누르면 현재 곡과 대기열을 모두 멈춥니다.', 'error');
      window.setTimeout(() => setPanicArmed(false), 3000);
      return;
    }
    setSharedState((previous) => ({ ...previous, currentSong: null, queue: [] }));
    setPanicArmed(false);
    showToast?.('현재 곡과 대기열을 모두 멈췄습니다.', 'error');
  };

  return (
    <section className="panel playback-panel glass-card" aria-label="현재 재생 제어">
      <div className="playback-panel-header">
        <div className="playback-heading"><ListMusic size={17} /> 현재 재생</div>
        <div className="playback-header-actions">
          {currentSong && <span className={`on-air-badge ${isPlaying ? '' : 'is-paused'}`}>{isPlaying ? '● ON AIR' : 'Ⅱ 일시정지'}</span>}
          <button type="button" onClick={() => setIsObsSetupOpen(true)} className="btn-icon" title="OBS 연결 설정" aria-label="OBS 연결 설정">
            <Settings size={16} />
          </button>
          <button type="button" onClick={handlePanic} className={`btn-icon btn-icon-danger ${panicArmed ? 'panic-warn' : ''}`} title="두 번 누르면 현재 곡과 대기열을 정지합니다">
            <AlertOctagon size={16} />
          </button>
        </div>
      </div>

      {currentSong ? (
        <div className="playback-now">
          <div className="playback-title-row">
            <strong>{currentSong.title}</strong>
            <div className="visualizer-container" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((bar) => <i key={bar} className={isPlaying ? 'playing' : ''} />)}
            </div>
          </div>
          <div className="playback-controls">
            <button type="button" onClick={onTogglePlay} className="btn-icon playback-primary" title={isPlaying ? '일시정지' : '재생'}>
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button type="button" onClick={toggleMute} className="btn-icon" title={isMuted ? '음소거 해제' : '음소거'}>
              {isMuted ? <VolumeX size={16} /> : volume < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            <input aria-label="볼륨" type="range" min="0" max="100" value={volume} onChange={(event) => onVolumeChange(Number(event.target.value))} className="volume-slider" />
            <button type="button" onClick={onSkip} className="btn-icon" title="다음 곡으로 스킵"><SkipForward size={17} /></button>
            <button
              type="button"
              onClick={() => {
                const replay = { ...currentSong, id: Date.now().toString() };
                setSharedState((previous) => ({ ...previous, queue: [...(previous.queue || []), replay] }));
                showToast?.('현재 곡을 대기열 끝에 다시 예약했습니다.', 'success');
              }}
              className="btn-icon"
              title="현재 곡 다시 예약"
            ><Repeat size={16} /></button>
          </div>
          <div className="playback-progress">
            <span>{formatTime(currentTime)}</span>
            <input aria-label="재생 위치" type="range" min="0" max={duration || 100} value={currentTime} onChange={(event) => onSeek(Number(event.target.value))} className="progress-slider" />
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      ) : (
        <div className="playback-idle"><Play size={17} /> 재생 중인 곡이 없습니다. 아래에서 곡을 추가하세요.</div>
      )}

      {isObsSetupOpen && (
        <div className="obs-setup-backdrop" role="presentation" onMouseDown={() => setIsObsSetupOpen(false)}>
          <section className="obs-setup-dialog" role="dialog" aria-modal="true" aria-label="OBS 연결 설정" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="obs-setup-eyebrow">처음 한 번 · 다시 설정할 때만</span>
                <h2>OBS 연결 설정</h2>
              </div>
              <button type="button" className="btn-icon" onClick={() => setIsObsSetupOpen(false)} aria-label="닫기"><X size={18} /></button>
            </header>

            <p className="obs-setup-intro">방송 중에는 이 창을 열 필요가 없습니다. 화면 표시는 무음 위젯으로, 노래 소리는 On-Air 플레이어 하나로만 OBS에 넣습니다.</p>

            <ol className="obs-setup-steps">
              <li>
                <span className="obs-setup-step-icon"><MonitorUp size={18} /></span>
                <div>
                  <strong>화면 정보 위젯</strong>
                  <p>OBS 브라우저 소스로 추가하고, 오디오는 끕니다.</p>
                  <button type="button" onClick={() => copyUrl(widgetUrl, 'OBS 화면 위젯 주소를 복사했습니다.')} className="btn-copy"><Copy size={14} /> 주소 복사</button>
                </div>
              </li>
              <li>
                <span className="obs-setup-step-icon"><Radio size={18} /></span>
                <div>
                  <strong>On-Air 플레이어</strong>
                  <p>별도 브라우저 소스로 추가하고, 이 소스만 OBS 오디오 믹서에 남깁니다.</p>
                  <button type="button" onClick={copyPlayerUrl} className="btn-copy" disabled={isPreparingPlayer || onAirStatus === 'unconfigured'}>
                    {isPreparingPlayer ? '준비 중…' : <><Copy size={14} /> {playerUrl ? '주소 복사' : '플레이어 준비 후 주소 복사'}</>}
                  </button>
                  <span className={`obs-player-status is-${onAirStatus || 'unconfigured'}`}><Check size={13} /> {onAirStatus === 'connected' ? 'OBS 플레이어 연결됨' : onAirStatus === 'connecting' ? '플레이어 연결 중' : onAirStatus === 'unconfigured' ? 'On-Air 서버를 연결하면 주소를 준비할 수 있습니다' : '주소를 OBS에 넣으면 연결됩니다'}</span>
                </div>
              </li>
            </ol>

            {onEndBroadcastSession && (
              <div className="obs-session-actions">
                <p>방송을 완전히 마치면 세션을 종료해 현재 곡·대기열·다시 부르기 목록과 임시 로컬 파일을 함께 정리합니다.</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    if (window.confirm('방송 세션을 종료할까요? 현재 재생·대기열·이전 재생 목록과 임시 로컬 파일이 정리됩니다.')) {
                      onEndBroadcastSession();
                      setIsObsSetupOpen(false);
                    }
                  }}
                >방송 세션 종료</button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
