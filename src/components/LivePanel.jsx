import React, { useState } from 'react';
import { ListMusic, SkipForward, X, Play, Pause, Volume2, Volume1, VolumeX, Settings, Trash2, ArrowUpCircle, OctagonAlert, Repeat } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export default function LivePanel({ 
  room, publicKeyB64, history, queue, currentSong, 
  onSkip, onRemoveFromQueue, isPlaying, onTogglePlay, 
  volume, onVolumeChange, currentTime, duration, onSeek, autoPlayNext, setSharedState, showToast
}) {
  const widgetUrl = `${window.location.origin}${window.location.pathname}#/widget?room=${room}&key=${encodeURIComponent(publicKeyB64)}`;

  const copyText = async (text) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Some OBS and embedded browsers reject the Clipboard API but allow the legacy fallback.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const didCopy = document.execCommand('copy');
    textarea.remove();
    if (!didCopy) throw new Error('Copy command was rejected');
  };

  const copyWidgetUrl = async (type) => {
    let url = widgetUrl;
    if (type) url += `&type=${type}`;
    try {
      await copyText(url);
      showToast?.('위젯 주소를 복사했습니다. OBS 브라우저 소스에 붙여넣으세요.', 'success');
    } catch (error) {
      console.error(error);
      showToast?.('주소를 복사하지 못했습니다. 브라우저 권한을 확인한 뒤 다시 시도하세요.', 'error');
    }
  };

  // 대기열 Drag & Drop
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, index) => {
    e.dataTransfer.setData('queueIndex', index);
  };
  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (dragOverIndex !== index) setDragOverIndex(index);
  };
  const handleDragLeave = () => {
    setDragOverIndex(null);
  };
  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    setDragOverIndex(null);
    const dragIndex = parseInt(e.dataTransfer.getData('queueIndex'), 10);
    if (dragIndex === dropIndex || isNaN(dragIndex)) return;
    
    setSharedState(prev => {
      const newQueue = [...(prev.queue || [])];
      const [draggedItem] = newQueue.splice(dragIndex, 1);
      newQueue.splice(dropIndex, 0, draggedItem);
      return { ...prev, queue: newQueue };
    });
  };

  // 히스토리 제어
  const handleDeleteHistory = (songId) => {
    if (window.confirm("정말 위젯 기록에서 삭제하시겠습니까?")) {
      setSharedState(prev => ({
        ...prev,
        history: (prev.history || []).filter(s => s.id !== songId)
      }));
    }
  };

  const handleRequeueHistory = (song) => {
    setSharedState(prev => {
      const newSong = { ...song, id: Date.now().toString() };
      return {
        ...prev,
        queue: [newSong, ...(prev.queue || [])]
      };
    });
  };

  const [prevVolume, setPrevVolume] = useState(100);
  const isMuted = volume === 0;

  const toggleMute = () => {
    if (isMuted) {
      onVolumeChange(prevVolume || 50);
    } else {
      setPrevVolume(volume);
      onVolumeChange(0);
    }
  };

  const formatTime = (sec) => {
    if (!sec || isNaN(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const [panicState, setPanicState] = useState(0);

  const handlePanic = () => {
    if (panicState === 0) {
      setPanicState(1);
      showToast?.('한 번 더 누르면 현재 곡과 대기열을 모두 멈춥니다.', 'error');
      setTimeout(() => setPanicState(0), 3000); // 3초 지나면 평상시로 리셋
    } else {
      setSharedState(prev => ({
        ...prev,
        currentSong: null,
        queue: []
      }));
      setPanicState(0);
      showToast?.('현재 곡과 대기열을 모두 멈췄습니다.', 'error');
    }
  };

  return (
    <div className="panel live-panel glass-card">
      <h2 className="panel-title" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <span><span className="step-number">3</span> 방송 제어</span>
        <div style={{display:'flex', gap:'0.5rem', alignItems:'center'}}>
          {isPlaying && currentSong && (
            <span className="on-air-badge">🔴 ON AIR</span>
          )}
          {currentSong && (
            <button onClick={onTogglePlay} className={`btn-play-pause ${isPlaying ? 'playing' : ''}`} title={isPlaying ? "일시 정지" : "재생"}>
              {isPlaying ? '⏸️' : '▶️'}
            </button>
          )}
          <button 
            onClick={handlePanic} 
            className={`btn-icon btn-icon-danger ${panicState === 1 ? 'panic-warn' : ''}`}
            title={panicState === 1 ? '현재 곡과 대기열을 모두 멈춥니다' : '실수 방지를 위해 한 번 더 눌러야 합니다'}
          >
            <OctagonAlert size={16} /> {panicState === 1 ? '현재 곡·대기열 모두 정지' : '비상 정지'}
          </button>
        </div>
      </h2>
      
      <details className="widget-settings-accordion">
        <summary><Settings size={16} /> OBS 위젯 설정 (처음 한 번만)</summary>
        <div className="widget-settings-content">
          <div className="widget-links">
            <button onClick={() => copyWidgetUrl()} className="btn-copy">통합 위젯 복사</button>
            <button onClick={() => copyWidgetUrl('current')} className="btn-copy secondary">현재곡 복사</button>
            <button onClick={() => copyWidgetUrl('setlist')} className="btn-copy secondary">셋리스트 복사</button>
          </div>
          <div style={{fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '1rem'}}>
            💡 OBS <strong>[브라우저 소스]</strong>를 추가하고 복사한 주소를 URL에 붙여넣으세요.<br/>
            (권장 해상도: 너비 400, 높이 600)
          </div>
          <div className="widget-preview-wrapper">
            <div className="preview-label">위젯 미리보기</div>
            <iframe 
              src={`${widgetUrl}&preview=true`} 
              className="widget-iframe" 
              title="Widget Preview"
            />
          </div>
        </div>
      </details>

      <div className="history-section">
        <h3 className="section-title" style={{margin:0, marginBottom:'0.5rem', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <span><ListMusic size={16}/> 현재 재생 중 (Now Playing)</span>
          <span style={{fontSize:'0.7rem', color:'var(--text-muted)', fontWeight:'normal'}}>단축키: 스페이스바(재생/일시정지), Ctrl+오른쪽방향키(다음곡)</span>
        </h3>
        <div>
          {currentSong ? (
            <div className="history-item active">
              <span className="history-title">{currentSong.title}</span>
              
              <div className="visualizer-container">
                <div className={`visualizer-bar ${isPlaying ? 'playing' : ''}`}></div>
                <div className={`visualizer-bar ${isPlaying ? 'playing' : ''}`}></div>
                <div className={`visualizer-bar ${isPlaying ? 'playing' : ''}`}></div>
                <div className={`visualizer-bar ${isPlaying ? 'playing' : ''}`}></div>
                <div className={`visualizer-bar ${isPlaying ? 'playing' : ''}`}></div>
              </div>
              
              <div className="audio-controls" style={{marginTop:'10px'}}>
                <button onClick={onTogglePlay} className="btn-icon" title={isPlaying ? "일시정지" : "재생"}>
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <div className="volume-control" style={{display:'flex', alignItems:'center', gap:'0.5rem'}}>
                  <button onClick={toggleMute} className="btn-icon" style={{padding: '0.2rem'}} title={isMuted ? "음소거 해제" : "음소거"}>
                    {isMuted ? <VolumeX size={16} /> : (volume < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />)}
                  </button>
                  <input 
                    type="range" 
                    min="0" max="100" 
                    value={volume} 
                    onChange={(e) => onVolumeChange(Number(e.target.value))}
                    className="volume-slider"
                  />
                </div>
                <button onClick={onSkip} className="btn-icon btn-icon-skip" title="다음 곡으로 스킵">
                  <SkipForward size={16} /> 스킵
                </button>
                <button 
                  onClick={() => {
                    const reqSong = { ...currentSong, id: Date.now().toString() };
                    setSharedState(prev => ({
                      ...prev,
                      queue: [...(prev.queue || []), reqSong]
                    }));
                    if (showToast) showToast('현재 곡이 대기열 끝에 다시 예약되었습니다.', 'success');
                  }} 
                  className="btn-icon" 
                  title="현재 곡을 대기열 끝에 다시 추가"
                >
                  <Repeat size={16} /> 다시 예약
                </button>
              </div>

              {/* Progress Bar (Seeker) */}
              <div className="progress-container" style={{display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.5rem'}}>
                <span style={{fontSize:'0.75rem', color:'var(--text-muted)', width:'30px', textAlign:'right'}}>{formatTime(currentTime)}</span>
                <input 
                  type="range" 
                  min="0" 
                  max={duration || 100} 
                  value={currentTime} 
                  onChange={(e) => onSeek(Number(e.target.value))}
                  className="progress-slider"
                  style={{flex: 1}}
                />
                <span style={{fontSize:'0.75rem', color:'var(--text-muted)', width:'30px'}}>{formatTime(duration)}</span>
              </div>
            </div>
          ) : (
            <div className="empty-state" style={{padding:'3rem 1rem'}}>
              <span style={{fontSize:'2rem', display:'block', marginBottom:'1rem', opacity: 0.5}}>🎵</span>
              <strong>재생 중인 곡이 없습니다.</strong>
              <p style={{margin:'0.6rem 0 0', fontSize:'0.85rem', color:'var(--text-muted)'}}>1단계에서 노래를 찾고, 2단계에서 재생을 시작하세요.</p>
            </div>
          )}
        </div>

        <div className="history-header" style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.5rem', marginTop:'1rem'}}>
          <h3 className="section-title" style={{margin:0}}>
            <ListMusic size={16}/> 다음 곡 대기열 <span style={{fontSize:'0.8rem', color:'var(--text-muted)'}}>({queue.length}곡)</span>
          </h3>
          <div style={{display:'flex', gap:'0.8rem', alignItems:'center'}}>
            {queue.length > 0 && (
              <button 
                onClick={() => {
                  if (window.confirm("대기열을 모두 비우시겠습니까?")) {
                    setSharedState(prev => ({...prev, queue: []}));
                  }
                }} 
                className="btn-icon btn-icon-danger" 
                style={{fontSize:'0.75rem'}}
              >
                <Trash2 size={14}/> 전체 비우기
              </button>
            )}
          </div>

        </div>
        <details className="playback-options">
          <summary>재생 옵션 · 자동 다음 곡 {autoPlayNext ? '켜짐' : '꺼짐'}</summary>
          <label>
            <input
              type="checkbox"
              checked={autoPlayNext}
              onChange={(e) => {
                setSharedState(prev => ({...prev, autoPlayNext: e.target.checked}));
              }}
            />
            <span>
              <strong>현재 곡이 끝나면 다음 곡 재생</strong>
              <small>대기열이 비어 있으면 재생을 멈춥니다.</small>
            </span>
          </label>
        </details>
        <div className="history-list">
          {queue.length === 0 && (
            <div className="empty-state" style={{padding:'2rem 1rem'}}>
              <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem', opacity: 0.5}}>🎤</span>
              <span style={{opacity: 0.7}}>대기 중인 곡이 없습니다.</span>
            </div>
          )}
          <AnimatePresence>
            {queue.map((song, i) => (
              <motion.div 
                key={song.id || i}
                layout
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, x: 20 }}
                transition={{ duration: 0.2 }}
                className={`history-item queue-item draggable ${dragOverIndex === i ? 'drag-over' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, i)}
                title="드래그해서 순서를 변경하세요"
              >
                <span className="queue-index" style={{cursor: 'grab'}}>☰ {i + 1}.</span>
                {song.source === 'meloming' && <span style={{fontSize:'10px', background:'var(--eureka-emerald)', color:'#fff', padding:'1px 5px', borderRadius:'6px', marginRight:'6px'}}>Meloming</span>}
                {song.source === 'setlink' && <span style={{fontSize:'10px', background:'var(--eureka-azure)', color:'#fff', padding:'1px 5px', borderRadius:'6px', marginRight:'6px'}}>Setlink</span>}
                <span className="history-title">{song.title}</span>
                {song.tags && song.tags.length > 0 && (
                  <span style={{fontSize:'10px', color:'var(--eureka-emerald)', marginLeft:'6px'}}>#{song.tags[0]}</span>
                )}
                <button onClick={() => onRemoveFromQueue(song.id)} className="btn-icon btn-icon-danger" title="대기열에서 제거" style={{marginLeft: 'auto'}}>
                  <X size={16} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <h3 className="section-title" style={{marginTop: '1rem'}}>
          <ListMusic size={16}/> 이전 재생 곡 <span style={{fontSize:'0.8rem', color:'var(--text-muted)'}}>({history.length}곡)</span>
        </h3>
        <div className="history-list">
          {history.length === 0 && (
            <div className="empty-state" style={{padding:'2rem 1rem'}}>
              <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem', opacity: 0.5}}>💿</span>
              <span style={{opacity: 0.7}}>아직 재생된 곡이 없습니다.</span>
            </div>
          )}
          {history.map((song, i) => (
            <div key={song.id || i} className="history-item history-played">
              {song.source === 'meloming' && <span style={{fontSize:'10px', background:'var(--eureka-emerald)', color:'#fff', padding:'1px 5px', borderRadius:'6px', marginRight:'6px'}}>Meloming</span>}
              {song.source === 'setlink' && <span style={{fontSize:'10px', background:'var(--eureka-azure)', color:'#fff', padding:'1px 5px', borderRadius:'6px', marginRight:'6px'}}>Setlink</span>}
              <span className="history-title">{song.title}</span>
              {song.tags && song.tags.length > 0 && (
                <span style={{fontSize:'10px', color:'var(--eureka-emerald)', marginLeft:'6px'}}>#{song.tags[0]}</span>
              )}
              
              <div style={{marginLeft: 'auto', display: 'flex', gap: '4px'}}>
                <button onClick={() => handleRequeueHistory(song)} className="btn-icon" title="대기열 맨 위로 다시 부르기">
                  <ArrowUpCircle size={16} />
                </button>
                <button onClick={() => handleDeleteHistory(song.id)} className="btn-icon btn-icon-danger" title="위젯 기록에서 삭제">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
