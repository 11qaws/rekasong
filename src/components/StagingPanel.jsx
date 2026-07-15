import React, { useEffect, useState } from 'react';
import { Play, Loader2, Sparkles, X, ListPlus, Music, User, CheckCircle2 } from 'lucide-react';
import YouTube from 'react-youtube';

export default function StagingPanel({ stagedItem, onAliasChange, onGoLive, onClearStaged, hasCurrentSong, isAiLoading, aiStatusMessage, onRetryAiExtraction }) {
  const [isConfirmed, setIsConfirmed] = useState(false);

  useEffect(() => {
    setIsConfirmed(false);
  }, [stagedItem?.src, stagedItem?.type]);

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
  const hasPlayableMr = type === 'local' ? Boolean(src) : type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(src || '');
  const analysisPhase = (() => {
    if (!isAiLoading) return 0;
    if (/한국어|번역|매칭/.test(aiStatusMessage)) return 3;
    if (/원본|기본 규칙|음원과 메타데이터/.test(aiStatusMessage)) return 2;
    return 1;
  })();
  const analysisSteps = type === 'local'
    ? ['파일 확인', '원곡 분리', '이름 매칭']
    : ['영상 확인', '원곡 분리', '이름 매칭'];

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

      <div className="preview-player preview-player-priority">
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
        {type === 'local' && stagedItem.mediaType === 'video' && (
          <video controls src={src} className="local-video-preview" style={{width:'100%', maxHeight:'320px'}} />
        )}
        {type === 'local' && stagedItem.mediaType !== 'video' && (
          <audio controls src={src} className="local-audio-preview" style={{width:'100%'}}/>
        )}
      </div>

      <div className="ai-title-card">
        <div className="ai-title-icon"><Sparkles size={18} /></div>
        <div className="ai-title-copy">
          <strong>AI 곡명 정리</strong>
          <span>{isAiLoading ? (aiStatusMessage || '영상 정보에서 부를 곡명을 찾고 있어요.') : (aiStatusMessage || '선택한 영상에서 부를 곡명을 자동으로 찾아 정리합니다.')}</span>
          {isAiLoading && (
            <div className="ai-phase-track" aria-label={`AI 분석 ${analysisPhase}단계 진행 중`}>
              {analysisSteps.map((step, index) => {
                const phase = index + 1;
                const state = phase < analysisPhase ? 'done' : phase === analysisPhase ? 'active' : '';
                return <span key={step} className={state}><b>{phase}</b>{step}</span>;
              })}
            </div>
          )}
        </div>
        {isAiLoading && (
          <div className="ai-analysis-badge" role="status" aria-label="AI 곡명 분석 중">
            <Loader2 size={13} className="spinner" />
            <span>분석 중</span>
            <i aria-hidden="true" />
            <i aria-hidden="true" />
            <i aria-hidden="true" />
          </div>
        )}
        {!isAiLoading && onRetryAiExtraction && (
          <button type="button" className="ai-retry-button" onClick={onRetryAiExtraction}>다시 분석</button>
        )}
      </div>
      
      <div className="staging-form">
        <label style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          표시될 곡명
          {!isAiLoading && aiStatusMessage ? (
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
            className="glass-input search-input"
            placeholder="가수명을 입력하세요"
          />
        </div>

      </div>

      <div className="staging-actions">
        {hasPlayableMr ? (
          <button
            type="button"
            className={`mr-confirm-button ${isConfirmed ? 'is-confirmed' : ''}`}
            onClick={() => setIsConfirmed((confirmed) => !confirmed)}
            aria-pressed={isConfirmed}
          >
            <CheckCircle2 size={18} />
            {isConfirmed ? 'MR 확인 완료 · 다시 확인하려면 누르세요' : '미리보기 재생 후 MR 확인 완료'}
          </button>
        ) : (
          <p className="mr-unavailable">재생 가능한 MR을 선택하거나 로컬 파일을 추가한 뒤 대기열에 넣을 수 있습니다.</p>
        )}

        <div className="staging-action-buttons">
          <button
            className="btn-primary go-live-btn"
            onClick={() => onGoLive(false)}
            disabled={!title.trim() || !hasPlayableMr || !isConfirmed}
          >
            {hasCurrentSong ? <><ListPlus size={20} /> 대기열에 추가</> : <><Play size={20} /> 즉시 재생 (방송 송출)</>}
          </button>
          {hasCurrentSong && (
            <button
              className="btn-primary go-live-btn go-live-next"
              onClick={() => onGoLive(true)}
              title="대기열 1순위로 새치기"
              disabled={!title.trim() || !hasPlayableMr || !isConfirmed}
            >
              <><Play size={20} /> 바로 다음 곡으로</>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
