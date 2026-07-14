import React, { useState } from 'react';
import { Search, Music, UploadCloud, Loader2 } from 'lucide-react';

export default function SearchPanel({ onSelectResult, onQuickPlay, onLocalFileDrop }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    // Phase 6: 유튜브 URL 다이렉트 패스 (Bypass Search)
    const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = query.match(ytRegex);
    if (match) {
      const videoId = match[1];
      onSelectResult({
        id: videoId,
        title: 'URL 직접 입력 영상 (분석 중...)',
        channelTitle: '알 수 없음'
      });
      setQuery('');
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Network error');
      const data = await response.json();
      setResults(data);
      setError(false);
    } catch (error) {
      console.error(error);
      setError(true);
    } finally {
      setIsSearching(false);
    }
  };

  // Local File Drag & Drop
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (!file.type.startsWith('audio/')) {
        alert('오류: 오디오 파일(MP3 등)만 지원됩니다.');
        return;
      }
      onLocalFileDrop(file);
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      if (!file.type.startsWith('audio/')) {
        alert('오류: 오디오 파일(MP3 등)만 지원됩니다.');
        return;
      }
      onLocalFileDrop(file);
    }
  };

  return (
    <div className="panel search-panel glass-card">
      <h2 className="panel-title"><Search size={18}/> 노래 검색</h2>
      
      <form onSubmit={handleSearch} className="search-form">
        <div className="search-input-wrapper">
          <Search className="search-icon" size={18} />
          <input 
            type="text" 
            placeholder="가수명, 곡명 또는 유튜브 URL을 입력하세요"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="glass-input search-input"
            disabled={isSearching}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={isSearching || !query.trim()}>
          {isSearching ? <><Loader2 className="spinner" size={18} /> 검색중</> : '검색'}
        </button>
      </form>

      <div className="search-results">
        {results.map((v) => (
          <div key={v.id} className="result-item" style={{position:'relative'}}>
            <div style={{display:'flex', width:'100%', cursor:'pointer'}} onClick={() => onSelectResult(v)}>
              <img src={v.thumbnail} alt="thumbnail" className="result-thumb" />
              <div className="result-info">
                <div className="result-title">{v.title}</div>
                <div className="result-meta">{v.channelTitle} • {v.durationText}</div>
              </div>
            </div>
            <button 
              className="btn-quick-play" 
              onClick={(e) => { e.stopPropagation(); onQuickPlay(v); }}
              title="검토 없이 바로 재생 (또는 대기열 예약)"
            >
              ⚡
            </button>
          </div>
        ))}
        {results.length === 0 && !isSearching && query === '' && (
          <div className="empty-state" style={{padding:'2rem 1rem'}}>
            <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem'}}>☝️</span>
            위 검색창에 부르고 싶은 곡을 입력하세요.<br/>
            (유튜브 URL을 직접 붙여넣거나 로컬 MR 파일을 드래그하세요!)
          </div>
        )}
        {results.length === 0 && !isSearching && query !== '' && !error && (
          <div className="empty-state" style={{padding:'2rem 1rem', color:'var(--accent-red)'}}>
            <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem'}}>🤷‍♂️</span>
            검색 결과가 없습니다.<br/>
            (정확한 유튜브 URL을 직접 붙여넣어 보세요)
          </div>
        )}
        {error && (
          <div className="empty-state" style={{padding:'2rem 1rem', color:'var(--accent-red)'}}>
            <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem'}}>⚠️</span>
            검색 서버와 통신할 수 없습니다.<br/>
            잠시 후 다시 시도해주세요.
          </div>
        )}
      </div>

      <div className="divider">또는 로컬 파일</div>

      <div 
        className="drop-zone-placeholder"
        onClick={() => document.querySelector('.hidden-file-input').click()}
        style={{ cursor: 'pointer' }}
        title="클릭하여 파일 선택"
      >
        <UploadCloud size={32} />
        <p>MR 파일 (MP3)을 여기에 드래그하거나<br/>클릭해서 추가하세요</p>
        <input type="file" accept="audio/*" onChange={handleFileSelect} className="hidden-file-input" />
      </div>
    </div>
  );
}
