import React, { useState } from 'react';
import { AlertOctagon, ListMusic, Pause, Play, Repeat, Settings, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';

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
  showToast
}) {
  const [panicArmed, setPanicArmed] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(100);
  const widgetUrl = `${window.location.origin}${window.location.pathname}#/widget?room=${room}&key=${encodeURIComponent(publicKeyB64 || '')}`;
  const isMuted = volume === 0;

  const formatTime = (seconds) => {
    if (!seconds || Number.isNaN(seconds)) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  };

  const copyWidgetUrl = async () => {
    try {
      await navigator.clipboard.writeText(widgetUrl);
      showToast?.('OBS 위젯 주소를 복사했습니다.', 'success');
    } catch {
      showToast?.('위젯 주소를 복사하지 못했습니다.', 'error');
    }
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

      <details className="widget-settings-accordion playback-settings">
        <summary><Settings size={15} /> OBS 위젯 설정</summary>
        <div className="widget-settings-content">
          <button type="button" onClick={copyWidgetUrl} className="btn-copy">통합 위젯 주소 복사</button>
          <p>OBS에서 브라우저 소스를 추가한 뒤 이 주소를 붙여넣으세요.</p>
        </div>
      </details>
    </section>
  );
}
