import React from 'react';
import { Play, Loader2, Sparkles, X, ListPlus, Music, User } from 'lucide-react';
import YouTube from 'react-youtube';

export default function StagingPanel({ stagedItem, onAliasChange, onGoLive, onClearStaged, hasCurrentSong, isAiLoading, aiStatusMessage }) {
  if (!stagedItem) {
    return (
      <div className="panel staging-panel glass-card empty">
        <div className="empty-state">
          <span style={{fontSize:'2rem', display:'block', marginBottom:'0.5rem', animation: 'bounceX 2s infinite'}}>👈</span>
          왼쪽에서 노래를 검색하거나 파일을 드롭하세요.
        </div>
      </div>
    );
  }

  const { type, src, title, artist } = stagedItem;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onGoLive(false);
    }
  };

  return (
    <div className="panel staging-panel glass-card">
      <div className="panel-title" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <span>
          <span className="step-number">2</span> 곡 정보 확인
          {stagedItem.source === 'meloming' && <span style={{marginLeft:'8px', fontSize:'0.75rem', background:'var(--eureka-emerald)', color:'#fff', padding:'0.1rem 0.5rem', borderRadius:'10px'}}>Meloming</span>}
          {stagedItem.source === 'setlink' && <span style={{marginLeft:'8px', fontSize:'0.75rem', background:'var(--eureka-azure)', color:'#fff', padding:'0.1rem 0.5rem', borderRadius:'10px'}}>Setlink</span>}
        </span>
        <button onClick={onClearStaged} className="btn-icon btn-icon-danger" title="비우기 (취소)" style={{fontSize:'0.85rem'}}>
          <X size={16} /> 비우기
        </button>
      </div>
      
      <div className="staging-form">
        <label style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          표시될 곡명
          {isAiLoading ? (
            <span className="ai-status" style={{fontSize:'0.75rem', fontWeight:'normal'}}>
              <Loader2 className="spinner" size={12} /> AI 추출 중...
            </span>
          ) : aiStatusMessage ? (
            <span className="ai-status-done" style={{fontSize:'0.75rem', fontWeight:'normal', color:'var(--eureka-emerald)'}}>
              <Sparkles size={12} className="sparkles-anim" /> {aiStatusMessage}
            </span>
          ) : null}
        </label>
        <div className="search-input-wrapper">
          <Music className="search-icon" size={16} style={{top: '12px'}}/>
          <input 
            type="text" 
            value={title} 
            onChange={(e) => onAliasChange('title', e.target.value)} 
            onKeyDown={handleKeyDown}
            className="glass-input search-input"
            placeholder="곡명을 입력하세요"
            autoFocus
          />
        </div>
        <p style={{fontSize:'0.7rem', color:'var(--text-muted)', marginTop:'-0.3rem', marginBottom:'0.5rem'}}>
          방송 화면에 표시될 곡명과 가수명을 수정하세요.
          {stagedItem.tags && stagedItem.tags.length > 0 && (
            <span style={{marginLeft: '8px', color: 'var(--eureka-emerald)'}}>
              (태그: {stagedItem.tags.join(', ')})
            </span>
          )}
        </p>

        <label>가수 (선택)</label>
        <div className="search-input-wrapper">
          <User className="search-icon" size={16} style={{top: '12px'}}/>
          <input 
            type="text" 
            value={artist} 
            onChange={(e) => onAliasChange('artist', e.target.value)} 
            onKeyDown={handleKeyDown}
            className="glass-input search-input"
            placeholder="가수명을 입력하세요"
          />
        </div>

        <div style={{display:'flex', gap:'0.5rem', width: '100%', marginTop:'0.5rem'}}>
          <button 
            className="btn-primary go-live-btn" 
            onClick={() => onGoLive(false)} 
            style={{flex: 1, padding: '1rem', fontSize: '1.1rem', fontWeight: 'bold'}}
            disabled={!title.trim()}
          >
            {hasCurrentSong ? (
              <><ListPlus size={20} /> 대기열에 추가</>
            ) : (
              <><Play size={20} /> 즉시 재생 (방송 송출)</>
            )}
          </button>
          {hasCurrentSong && (
            <button 
              className="btn-primary go-live-btn" 
              onClick={() => onGoLive(true)} 
              style={{flex: 1, backgroundColor: title.trim() ? 'var(--accent-red)' : '#E9ECEF', padding: '1rem', fontSize: '1.1rem', fontWeight: 'bold'}} 
              title="대기열 1순위로 새치기"
              disabled={!title.trim()}
            >
              <><Play size={20} /> 바로 다음 곡으로 (새치기)</>
            </button>
          )}
        </div>
      </div>

      <div className="preview-player" style={{ position: 'relative', marginTop: '1rem' }}>
        {type === 'youtube' && (
          <div className="youtube-preview-wrapper">
            <YouTube 
              videoId={src} 
              opts={{ 
                width: '100%', 
                height: '180', 
                playerVars: { 
                  autoplay: 0, 
                  controls: 1,
                  origin: window.location.origin
                } 
              }} 
            />
          </div>
        )}
        {type === 'local' && (
          <audio controls src={src} className="local-audio-preview" style={{width:'100%'}}/>
        )}
      </div>
    </div>
  );
}
