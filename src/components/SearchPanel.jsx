import React, { useState } from 'react';
import { Search, Music, UploadCloud } from 'lucide-react';

export default function SearchPanel({ onSelectResult, onLocalFileDrop }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setResults(data);
      }
    } catch (err) {
      console.error(err);
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
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onLocalFileDrop(files[0]);
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onLocalFileDrop(e.target.files[0]);
    }
  };

  return (
    <div className="panel search-panel glass-card">
      <h2 className="panel-title"><Search size={18}/> 노래 검색</h2>
      
      <form onSubmit={handleSearch} className="search-form">
        <input 
          type="text" 
          placeholder="아이돌 TJ, 금영..." 
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="search-input glass-input"
        />
        <button type="submit" className="btn-primary" disabled={isSearching}>
          {isSearching ? '검색중...' : '검색'}
        </button>
      </form>

      <div className="search-results">
        {results.map((v) => (
          <div key={v.id} className="result-item" onClick={() => onSelectResult(v)}>
            <img src={v.thumbnail} alt="thumbnail" className="result-thumb" />
            <div className="result-info">
              <div className="result-title">{v.title}</div>
              <div className="result-meta">{v.channelTitle} • {v.durationText}</div>
            </div>
          </div>
        ))}
        {results.length === 0 && !isSearching && (
          <div className="empty-state">유튜브에서 MR을 검색하세요.</div>
        )}
      </div>

      <div className="divider">또는 로컬 파일</div>

      <div 
        className={`drop-zone ${isDragging ? 'drag-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <UploadCloud size={32} />
        <p>MR 파일 (MP3)을 여기에 드래그하거나<br/>클릭해서 추가하세요</p>
        <input type="file" accept="audio/*" onChange={handleFileSelect} className="hidden-file-input" />
      </div>
    </div>
  );
}
