import React from 'react';
import { Copy, ListMusic } from 'lucide-react';

export default function LivePanel({ room, publicKeyB64, history, currentSong }) {
  const widgetUrl = `${window.location.origin}${window.location.pathname}#/widget?room=${room}&key=${encodeURIComponent(publicKeyB64)}`;

  const copyWidgetUrl = (type) => {
    let url = widgetUrl;
    if (type) url += `&type=${type}`;
    navigator.clipboard.writeText(url);
    alert('위젯 주소가 복사되었습니다! OBS 브라우저 소스에 붙여넣으세요.');
  };

  return (
    <div className="panel live-panel glass-card">
      <h2 className="panel-title">실시간 송출 (Live)</h2>
      
      <div className="widget-links">
        <button onClick={() => copyWidgetUrl()} className="btn-copy">통합 위젯 복사</button>
        <button onClick={() => copyWidgetUrl('current')} className="btn-copy secondary">현재곡 복사</button>
        <button onClick={() => copyWidgetUrl('setlist')} className="btn-copy secondary">셋리스트 복사</button>
      </div>

      <div className="widget-preview-wrapper">
        <div className="preview-label">위젯 미리보기</div>
        <iframe 
          src={`${widgetUrl}&preview=true`} 
          className="widget-iframe" 
          title="Widget Preview"
        />
      </div>

      <div className="history-section">
        <h3 className="section-title"><ListMusic size={16}/> 셋리스트 (History)</h3>
        <div className="history-list">
          {history.length === 0 && <div className="empty-state">아직 추가된 곡이 없습니다.</div>}
          {history.map((song, i) => (
            <div key={i} className={`history-item ${currentSong?.id === song.id ? 'active' : ''}`}>
              <span className="history-title">{song.title}</span>
              {song.artist && <span className="history-artist"> - {song.artist}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
