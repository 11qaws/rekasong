import React from 'react';
import YouTube from 'react-youtube';
import { Play } from 'lucide-react';

export default function StagingPanel({ stagedItem, onAliasChange, onGoLive }) {
  if (!stagedItem) {
    return (
      <div className="panel staging-panel glass-card empty">
        <div className="empty-state">
          왼쪽에서 곡을 검색하거나 파일을 드롭하여<br/>미리듣기 및 곡명을 확인하세요.
        </div>
      </div>
    );
  }

  const { type, src, title, artist } = stagedItem;

  return (
    <div className="panel staging-panel glass-card">
      <h2 className="panel-title">사전 검토 (Preview)</h2>
      
      <div className="preview-player">
        {type === 'youtube' && (
          <div className="youtube-preview-wrapper">
            <YouTube 
              videoId={src} 
              opts={{ 
                width: '100%', 
                height: '180', 
                playerVars: { autoplay: 1, controls: 1 } 
              }} 
            />
          </div>
        )}
        {type === 'local' && (
          <audio controls src={src} className="local-audio-preview" autoPlay />
        )}
      </div>

      <div className="staging-form">
        <label>곡명 (위젯에 표시될 이름)</label>
        <input 
          type="text" 
          value={title} 
          onChange={(e) => onAliasChange('title', e.target.value)} 
          className="glass-input"
          placeholder="곡명을 입력하세요"
        />

        <label>아티스트 (선택)</label>
        <input 
          type="text" 
          value={artist} 
          onChange={(e) => onAliasChange('artist', e.target.value)} 
          className="glass-input"
          placeholder="가수명을 입력하세요"
        />

        <button className="btn-primary go-live-btn" onClick={onGoLive}>
          <Play size={18} /> 방송 송출 (위젯 적용)
        </button>
      </div>
    </div>
  );
}
