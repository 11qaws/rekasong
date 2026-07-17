import React from 'react';
import { Play, Loader2, Sparkles, ArrowLeft, ListPlus, Music } from 'lucide-react';
import YouTube from 'react-youtube';

export default function StagingPanel({ stagedItem, onAliasChange, onGoLive, onClearStaged, hasCurrentSong, isAiLoading, aiStatusMessage, onRetryAiExtraction }) {
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

  const { type, src, title } = stagedItem;
  const hasPlayableMr = type === 'local' ? Boolean(src) : type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(src || '');
  const needsBroadcastAsset = type === 'local' && stagedItem.assetStatus && stagedItem.assetStatus !== 'local';
  const isBroadcastAssetReady = !needsBroadcastAsset || stagedItem.assetStatus === 'ready';
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
      <header className="staging-panel-header panel-title" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <span>
          <span className="step-number">2</span> 곡 정보 확인
          {stagedItem.source === 'meloming' && <span style={{marginLeft:'8px', fontSize:'0.75rem', background:'var(--eureka-emerald)', color:'#fff', padding:'0.1rem 0.5rem', borderRadius:'10px'}}>Meloming</span>}
          {stagedItem.source === 'setlink' && <span style={{marginLeft:'8px', fontSize:'0.75rem', background:'var(--eureka-azure)', color:'#fff', padding:'0.1rem 0.5rem', borderRadius:'10px'}}>Setlink</span>}
        </span>
        <button onClick={onClearStaged} className="btn-icon" title="다른 곡 검색" style={{fontSize:'0.85rem'}}>
          <ArrowLeft size={16} /> 다른 곡 찾기
        </button>
      </header>

      <div className="staging-panel-content">
        <div className="staging-media-info">
          <div className="preview-player preview-player-priority">
          {type === 'youtube' && (
            /* 사적 미리듣기 전용 iframe(autoplay 0) — 스트리머가 방송 전에 확인하는
               용도라 광고가 방송에 나가지 않는다. 방송 출력(currentEntry 재생)은
               Dashboard의 프록시 <audio>만 사용하며 이 요소와 절대 연결되지 않는다. */
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

          <div className="staging-song-info">
          <div className="ai-title-card">
            <div className="ai-title-icon"><Sparkles size={18} /></div>
            <div className="ai-title-copy">
              <strong>{stagedItem.skipAiTitleExtraction ? '노래책 곡명' : 'AI 곡명 정리'}</strong>
              <span>{stagedItem.skipAiTitleExtraction ? '노래책에 등록된 곡명을 그대로 사용합니다.' : (isAiLoading ? (aiStatusMessage || '영상 정보에서 부를 곡명을 찾고 있어요.') : (aiStatusMessage || '선택한 영상에서 부를 곡명을 자동으로 찾아 정리합니다.'))}</span>
              {!stagedItem.skipAiTitleExtraction && isAiLoading && (
                <div className="ai-phase-track" aria-label={`AI 분석 ${analysisPhase}단계 진행 중`}>
                  {analysisSteps.map((step, index) => {
                    const phase = index + 1;
                    const state = phase < analysisPhase ? 'done' : phase === analysisPhase ? 'active' : '';
                    return <span key={step} className={state}><b>{phase}</b>{step}</span>;
                  })}
                </div>
              )}
            </div>
            {!stagedItem.skipAiTitleExtraction && isAiLoading && (
              <div className="ai-analysis-badge" role="status" aria-label="AI 곡명 분석 중">
                <Loader2 size={13} className="spinner" />
                <span>분석 중</span>
                <i aria-hidden="true" />
                <i aria-hidden="true" />
                <i aria-hidden="true" />
              </div>
            )}
            {!stagedItem.skipAiTitleExtraction && !isAiLoading && onRetryAiExtraction && (
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
              />
            </div>
            <p className="staging-title-help">
              방송 화면에 표시될 곡명을 수정하세요.
              {stagedItem.tags && stagedItem.tags.length > 0 && (
                <span>(태그: {stagedItem.tags.join(', ')})</span>
              )}
            </p>
          </div>
          </div>
        </div>
      </div>

      <footer className="staging-panel-footer staging-actions">
        <div className="staging-action-notices">
          {type === 'local' && needsBroadcastAsset && (
            <p className={`staging-asset-status ${stagedItem.assetStatus === 'error' ? 'is-error' : ''}`}>
              {stagedItem.assetStatus === 'uploading'
                ? `방송용 파일 준비 중… ${stagedItem.assetProgress || 0}%`
                : stagedItem.assetError || '방송용 파일을 준비하지 못했습니다.'}
            </p>
          )}
          {!hasPlayableMr ? (
            <p className="mr-unavailable">재생 가능한 MR을 선택하거나 로컬 파일을 추가한 뒤 대기열에 넣을 수 있습니다.</p>
          ) : type === 'local' ? (
            <p className="mr-cache-note">내 파일은 이번 방송에서만 사용하며, 방송이 끝나면 자동으로 정리됩니다.</p>
          ) : stagedItem.source !== 'youtube' && stagedItem.songbookId && !stagedItem.mrVerified ? (
            <p className="mr-cache-note">대기열에 추가하면 이 MR 연결을 노래책에 저장해 다음 방송에도 바로 사용할 수 있습니다.</p>
          ) : null}
        </div>

        <div className="staging-action-buttons">
          <button
            className="btn-primary go-live-btn"
            onClick={() => onGoLive(false)}
            disabled={!title.trim() || !hasPlayableMr || !isBroadcastAssetReady}
          >
            {hasCurrentSong ? <><ListPlus size={20} /> 대기열에 추가</> : <><Play size={20} /> 즉시 재생 (방송 송출)</>}
          </button>
          {hasCurrentSong && (
            <button
              className="btn-primary go-live-btn go-live-next"
              onClick={() => onGoLive(true)}
              title="대기열 1순위로 새치기"
              disabled={!title.trim() || !hasPlayableMr || !isBroadcastAssetReady}
            >
              <><Play size={20} /> 바로 다음 곡으로</>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
