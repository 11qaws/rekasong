import React, { useEffect, useRef, useState } from 'react';
import { Search, Music, UploadCloud, Loader2, RefreshCw, AlertCircle, Link } from 'lucide-react';
import { useMeloming } from '../hooks/useMeloming';
import { useSetlink } from '../hooks/useSetlink';

export default function SearchPanel({ onSelectResult, onQuickPlay, onLocalFileDrop, sharedState, setSharedState }) {
  const { melomingChannelId, setlinkPublicId, activeIntegrationTab } = sharedState;
  
  // Tabs: 'youtube', 'meloming', 'setlink'
  const [activeTab, setActiveTab] = useState(activeIntegrationTab || 'youtube'); 
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef(null);
  const searchAbortRef = useRef(null);
  
  // Integration Onboarding States
  const [tempMeloId, setTempMeloId] = useState('');
  const [tempSetlinkId, setTempSetlinkId] = useState('');

  // Local search queries for songbooks
  const [meloSearch, setMeloSearch] = useState('');
  const [setlinkSearch, setSetlinkSearch] = useState('');
  
  const melo = useMeloming(melomingChannelId);
  const setlink = useSetlink(setlinkPublicId);

  useEffect(() => () => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  }, []);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSharedState(prev => ({ ...prev, activeIntegrationTab: tab }));
  };

  const extractYoutubeId = (value) => {
    const ytRegex = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;
    const match = value.match(ytRegex);
    return match?.[1] || (/^[\w-]{11}$/.test(value) ? value : null);
  };

  const searchYoutube = async (rawQuery, songMeta = {}) => {
    const searchQuery = rawQuery.trim();
    if (!searchQuery) return;

    const videoId = extractYoutubeId(searchQuery);
    if (videoId) {
      onSelectResult({
        id: videoId,
        title: songMeta.title || 'URL 직접 입력 영상 (분석 중...)',
        channelTitle: songMeta.artist || '알 수 없음',
        tags: songMeta.tags || [],
        source: songMeta.source || 'youtube'
      });
      setQuery('');
      return;
    }

    setIsSearching(true);
    setError('');
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/search?q=' + encodeURIComponent(searchQuery), { signal: controller.signal });
      if (!response.ok) throw new Error('Network error');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid search response');
      setResults(data);
    } catch (error) {
      console.error(error);
      setError(
        error.name === 'AbortError'
          ? '검색 응답이 늦습니다. 잠시 후 다시 시도하거나 YouTube URL을 직접 붙여넣으세요.'
          : '검색 서버와 통신할 수 없습니다. 잠시 후 다시 시도하거나 YouTube URL을 직접 붙여넣으세요.'
      );
    } finally {
      clearTimeout(timeoutId);
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
        setIsSearching(false);
      }
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    searchYoutube(query);
  };

  const handleSongbookSearch = (song, platform) => {
    const searchQuery = song.youtubeUrl || `${song.artist || ''} ${song.title}`.trim();
    setQuery(searchQuery);
    handleTabChange('youtube');
    searchYoutube(searchQuery, { ...song, source: platform });
  };

  const addLocalFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      alert('오류: 오디오 파일(MP3 등)만 지원됩니다.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      alert('오류: 50MB 이하의 오디오 파일만 업로드할 수 있습니다.');
      return;
    }
    onLocalFileDrop(file);
  };

  const handleFileSelect = (e) => {
    addLocalFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const handleIntegrationConnect = (platform, id) => {
    if (!id.trim()) return;
    if (platform === 'meloming') {
      setSharedState(prev => ({ ...prev, melomingChannelId: id.trim() }));
    } else {
      // Extract ID from URL if user pastes the full URL
      let finalId = id.trim();
      const urlMatch = finalId.match(/setlink\.jp\/public\/([^/?#]+)/);
      if (urlMatch) finalId = urlMatch[1];
      setSharedState(prev => ({ ...prev, setlinkPublicId: finalId }));
    }
  };

  const handleIntegrationDisconnect = (platform) => {
    if(window.confirm('연동을 해제하시겠습니까?')) {
      if (platform === 'meloming') {
        setSharedState(prev => ({ ...prev, melomingChannelId: '' }));
      } else {
        setSharedState(prev => ({ ...prev, setlinkPublicId: '' }));
      }
    }
  };

  const renderYoutubeTab = () => (
    <>
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
              <img 
                src={v.thumbnail || 'https://via.placeholder.com/120x68/333/fff?text=No+Image'} 
                alt="thumbnail" 
                className="result-thumb" 
                onError={(e) => { e.target.onerror = null; e.target.src = 'https://via.placeholder.com/120x68/333/fff?text=No+Image'; }}
              />
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
        {isSearching && results.length === 0 && (
          <div className="skeleton-container" style={{padding:'1rem', display:'flex', flexDirection:'column', gap:'0.8rem'}}>
             <div style={{height:'60px', borderRadius:'8px', background:'rgba(255,255,255,0.05)', animation:'pulse 1.5s infinite'}}></div>
             <div style={{height:'60px', borderRadius:'8px', background:'rgba(255,255,255,0.05)', animation:'pulse 1.5s infinite', animationDelay:'0.2s'}}></div>
             <div style={{height:'60px', borderRadius:'8px', background:'rgba(255,255,255,0.05)', animation:'pulse 1.5s infinite', animationDelay:'0.4s'}}></div>
          </div>
        )}
        {!isSearching && results.length === 0 && query === '' && (
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
            {error}
          </div>
        )}
      </div>

      <div className="divider">또는 로컬 파일</div>

      <div 
        className={`drop-zone-placeholder ${isDraggingFile ? 'drag-over' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDraggingFile(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDraggingFile(false);
          addLocalFile(e.dataTransfer.files?.[0]);
        }}
        style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}
        title="클릭하거나 파일을 끌어 놓으세요"
      >
        <UploadCloud size={32} style={{ color: 'var(--eureka-emerald)', marginBottom: '10px' }} />
        <p style={{ margin: 0, fontWeight: 500 }}>로컬 파일(MP3) 추가하기</p>
        <p style={{ margin: '5px 0 15px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>드래그 앤 드롭 또는 클릭하세요</p>
        <button className="btn-secondary" style={{ pointerEvents: 'none' }}>파일 선택</button>
        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileSelect} onClick={(e) => e.stopPropagation()} className="hidden-file-input" />
      </div>
    </>
  );

  const renderSongbook = (platform, hookData, localSearch, setLocalSearch, isConnected, idValue, setIdValue, emptyMessage, helpText) => {
    if (!isConnected) {
      return (
        <div className="onboarding" style={{textAlign:'center', marginTop:'2rem', padding:'2rem', background:'rgba(0,0,0,0.1)', borderRadius:'12px', border:'1px solid var(--glass-border)'}}>
          {platform === 'meloming' ? <Music size={48} color="var(--eureka-emerald)" style={{margin:'0 auto 1rem'}} /> : <Link size={48} color="var(--eureka-azure)" style={{margin:'0 auto 1rem'}} />}
          <h3 style={{marginBottom:'0.5rem', fontSize:'1.2rem', color:'var(--text-main)'}}>{platform === 'meloming' ? '멜로밍 노래책 연동' : 'Setlink 노래책 연동'}</h3>
          <p style={{fontSize:'0.9rem', color:'var(--text-muted)', marginBottom:'1.5rem', lineHeight:'1.5'}} dangerouslySetInnerHTML={{__html: helpText}} />
          <form onSubmit={(e) => { e.preventDefault(); handleIntegrationConnect(platform, idValue); }} style={{display:'flex', gap:'0.5rem', flexDirection:'column', maxWidth:'300px', margin:'0 auto'}}>
            <input 
              type="text" 
              placeholder={platform === 'meloming' ? "예: meloming_channel_id" : "예: https://setlink.jp/public/... 또는 ID"}
              className="glass-input"
              value={idValue}
              onChange={e => setIdValue(e.target.value)}
              style={{textAlign:'center'}}
            />
            <button type="submit" className="btn-primary" style={{padding:'0.8rem'}}>내 노래책 불러오기</button>
            <div style={{fontSize:'0.75rem', color:'var(--text-muted)', marginTop:'0.5rem'}}>
              {platform === 'meloming' ? '채널 설정에서 제공하는 고유 ID를 입력하세요.' : 'Setlink에서 공유 버튼을 눌러 복사한 URL을 붙여넣으세요.'}
            </div>
          </form>
        </div>
      );
    }

    const { songs, isLoading, error, refresh, isDemo } = hookData;
    
    // 로컬 필터링
    const filteredSongs = songs.filter(s => 
      s.title.toLowerCase().includes(localSearch.toLowerCase()) || 
      (s.artist && s.artist.toLowerCase().includes(localSearch.toLowerCase())) ||
      (s.tags && s.tags.join(' ').toLowerCase().includes(localSearch.toLowerCase()))
    );

    // 100개까지만 표시하여 성능 보장
    const displaySongs = filteredSongs.slice(0, 100);

    return (
      <div className="songbook-list" style={{display:'flex', flexDirection:'column', flex:1}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:'0.5rem', borderBottom:'1px solid var(--glass-border)', marginBottom:'1rem'}}>
          <div style={{fontSize:'0.85rem', color: platform === 'meloming' ? 'var(--eureka-emerald)' : 'var(--eureka-azure)'}}>
            {isDemo ? '🧪 데모 데이터 (실제 연동 전)' : <>✅ <strong>{isConnected}</strong> 연동됨 ({songs.length}곡)</>}
          </div>
          <div style={{display:'flex', gap:'0.5rem'}}>
            <button onClick={refresh} className="btn-icon" title="새로고침">
              <RefreshCw size={14} className={isLoading ? 'spinner' : ''} />
            </button>
            <button onClick={() => handleIntegrationDisconnect(platform)} className="btn-icon btn-icon-danger" style={{fontSize:'0.75rem'}}>해제</button>
          </div>
        </div>

        {error && (
          <div className="empty-state" style={{color:'var(--accent-red)', padding:'1rem'}}>
            <AlertCircle size={24} style={{margin:'0 auto 0.5rem'}}/>
            {error}
          </div>
        )}

        {isDemo && (
          <div className="empty-state" style={{padding:'0.75rem 1rem', marginBottom:'1rem', border:'1px solid rgba(245, 158, 11, 0.45)', color:'#fbbf24'}}>
            실제 {platform === 'meloming' ? '멜로밍' : 'Setlink'} 계정이나 신청곡을 불러오지 않습니다. 현재는 화면 흐름을 확인하는 데모 목록입니다.
          </div>
        )}

        {/* 내 노래책 내에서 검색 */}
        <div className="search-input-wrapper" style={{marginBottom: '1rem'}}>
          <Search className="search-icon" size={16} />
          <input 
            type="text" 
            placeholder="노래책 내에서 곡명, 가수 검색..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="glass-input search-input"
            style={{padding: '0.8rem 1rem 0.8rem 2.2rem'}}
          />
        </div>

        <div className="search-results">
          {isLoading && songs.length === 0 && (
             <div className="skeleton-container" style={{padding:'1rem', display:'flex', flexDirection:'column', gap:'0.8rem'}}>
                <div style={{height:'50px', borderRadius:'8px', background:'rgba(255,255,255,0.05)', animation:'pulse 1.5s infinite'}}></div>
                <div style={{height:'50px', borderRadius:'8px', background:'rgba(255,255,255,0.05)', animation:'pulse 1.5s infinite', animationDelay:'0.2s'}}></div>
             </div>
          )}
          {!isLoading && songs.length === 0 && !error && (
            <div className="empty-state">{emptyMessage}</div>
          )}
          {!isLoading && songs.length > 0 && filteredSongs.length === 0 && (
            <div className="empty-state" style={{padding:'2rem 1rem'}}>
              일치하는 곡이 없습니다.
            </div>
          )}
          {displaySongs.map(song => (
            <div key={song.id} className="result-item songbook-item" style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0.8rem', gap:'1rem'}}>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontSize:'1rem', fontWeight:'bold', color:'var(--text-main)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{song.title}</div>
                <div style={{fontSize:'0.85rem', color:'var(--text-muted)', marginBottom:'0.3rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{song.artist}</div>
                {song.tags && song.tags.length > 0 && (
                  <div style={{display:'flex', gap:'0.3rem', flexWrap:'wrap', marginTop:'0.2rem'}}>
                    {song.tags.map(t => (
                      <span key={t} style={{fontSize:'0.65rem', padding:'0.1rem 0.5rem', background:'var(--chr-hat)', color:'#fff', borderRadius:'10px'}}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: '0.3rem'}}>
                <button 
                  className="btn-primary" 
                  style={{padding:'0.5rem 1rem', fontSize:'0.85rem', display:'flex', alignItems:'center', gap:'0.4rem', flexShrink: 0}}
                  onClick={() => handleSongbookSearch(song, platform)}
                >
                  {song.youtubeUrl ? <><Music size={14}/>준비</> : <><Search size={14}/>MR 찾기</>}
                </button>
              </div>
            </div>
          ))}
          {filteredSongs.length > 100 && (
             <div style={{textAlign:'center', fontSize:'0.8rem', color:'var(--text-muted)', padding:'1rem 0'}}>
               100곡 이상 검색되었습니다. 검색어를 더 상세히 입력해주세요.
             </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="panel search-panel glass-card" style={{display:'flex', flexDirection:'column'}}>
      <div className="panel-title" style={{paddingBottom: 0}}>
        <h2 className="panel-heading"><span className="step-number">1</span> 노래 찾기</h2>
        <div className="tabs" style={{display:'flex', gap:'0.5rem', borderBottom:'1px solid var(--glass-border)'}}>
          <button 
            className={`tab-btn ${activeTab === 'youtube' ? 'active' : ''}`}
            onClick={() => handleTabChange('youtube')}
          >
            <Search size={14}/> 유튜브 검색
          </button>
          <button 
            className={`tab-btn ${activeTab === 'meloming' ? 'active' : ''}`}
            onClick={() => handleTabChange('meloming')}
          >
            <Music size={14}/> 멜로밍
          </button>
          <button 
            className={`tab-btn ${activeTab === 'setlink' ? 'active' : ''}`}
            onClick={() => handleTabChange('setlink')}
          >
            <Link size={14}/> Setlink
          </button>
        </div>
      </div>
      
      <div className="tab-content" style={{marginTop:'1rem', display:'flex', flexDirection:'column', flex:1, overflowY:'auto'}}>
        {activeTab === 'youtube' && renderYoutubeTab()}
        {activeTab === 'meloming' && renderSongbook(
          'meloming', 
          melo, 
          meloSearch, 
          setMeloSearch, 
          melomingChannelId, 
          tempMeloId, 
          setTempMeloId, 
          '노래책에 등록된 곡이 없습니다.',
          '시청자들이 멜로밍으로 신청한 곡을<br/>여기서 바로 확인하고 재생하세요!'
        )}
        {activeTab === 'setlink' && renderSongbook(
          'setlink', 
          setlink, 
          setlinkSearch, 
          setSetlinkSearch, 
          setlinkPublicId, 
          tempSetlinkId, 
          setTempSetlinkId, 
          '공개 리스트에 등록된 곡이 없습니다.',
          'Setlink에 등록해둔 나의 노래책을 불러와<br/>원클릭으로 무대에 올려보세요!'
        )}
      </div>
    </div>
  );
}
