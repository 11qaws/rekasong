import React, { useEffect, useRef, useState } from 'react';
import { Search, Music, UploadCloud, Loader2, RefreshCw, AlertCircle, Link } from 'lucide-react';
import { useMeloming } from '../hooks/useMeloming';
import { useSetlink } from '../hooks/useSetlink';
import { useYoutubePlaylist } from '../hooks/useYoutubePlaylist';
import { apiUrl } from '../lib/api';

const songbookCacheKey = (platform, songId) => `${platform}:${songId}`;

export default function SearchPanel({ onSelectResult, onLocalFileDrop, sharedState, setSharedState }) {
  const { melomingChannelId, setlinkCatalog = [], setlinkSourceUrl = '', setlinkCatalogMeta = null, youtubePlaylistCatalog = [], youtubePlaylistSourceUrl = '', youtubePlaylistCatalogMeta = null, songbookMrCache = {}, activeIntegrationTab } = sharedState;
  
  // Tabs: 'youtube', 'meloming', 'setlink'
  const [activeTab, setActiveTab] = useState(activeIntegrationTab || 'youtube'); 
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(false);
  const [pendingSongbookMatch, setPendingSongbookMatch] = useState(null);
  const [songbookUploadContext, setSongbookUploadContext] = useState(null);
  const [cacheLookupKeys, setCacheLookupKeys] = useState({});
  const checkedSongbookCacheKeys = useRef(new Set());
  const setSharedStateRef = useRef(setSharedState);
  setSharedStateRef.current = setSharedState;
  
  // Integration Onboarding States
  const [tempMeloId, setTempMeloId] = useState('');
  const [tempSetlinkUrl, setTempSetlinkUrl] = useState(setlinkSourceUrl);
  const [tempPlaylistUrl, setTempPlaylistUrl] = useState(youtubePlaylistSourceUrl);
  const [catalogImportError, setCatalogImportError] = useState('');
  const [isSetlinkLoading, setIsSetlinkLoading] = useState(false);
  const [playlistImportError, setPlaylistImportError] = useState('');
  const [isPlaylistLoading, setIsPlaylistLoading] = useState(false);

  // Local search queries for songbooks
  const [meloSearch, setMeloSearch] = useState('');
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [setlinkSearch, setSetlinkSearch] = useState('');
  const fileInputRef = useRef(null);
  
  const melo = useMeloming(melomingChannelId);
  const setlink = useSetlink(setlinkCatalog);
  const playlist = useYoutubePlaylist(youtubePlaylistCatalog);

  useEffect(() => {
    const activeSongbook = activeTab === 'meloming'
      ? { platform: 'meloming', songs: melo.songs, connected: Boolean(melomingChannelId) }
      : activeTab === 'setlink'
        ? { platform: 'setlink', songs: setlink.songs, connected: setlinkCatalog.length > 0 }
        : activeTab === 'youtube-playlist'
          ? { platform: 'youtube-playlist', songs: playlist.songs, connected: youtubePlaylistCatalog.length > 0 }
          : null;
    if (!activeSongbook?.connected || !Array.isArray(activeSongbook.songs) || activeSongbook.songs.length === 0) return;

    const songsToCheck = activeSongbook.songs.slice(0, 100).filter((song) => {
      const key = songbookCacheKey(activeSongbook.platform, song.id);
      if (checkedSongbookCacheKeys.current.has(key)) return false;
      checkedSongbookCacheKeys.current.add(key);
      return true;
    });
    if (songsToCheck.length === 0) return;

    const pendingKeys = songsToCheck.map((song) => songbookCacheKey(activeSongbook.platform, song.id));
    setCacheLookupKeys((previous) => ({ ...previous, ...Object.fromEntries(pendingKeys.map((key) => [key, true])) }));
    const parameters = new URLSearchParams({ kind: `songbook:${activeSongbook.platform}` });
    songsToCheck.forEach((song) => parameters.append('id', song.id));
    let cancelled = false;

    fetch(apiUrl(`/api/title-cache?${parameters.toString()}`))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Cache lookup failed')))
      .then((data) => {
        if (cancelled || !data.entries) return;
        const resolved = Object.fromEntries(Object.entries(data.entries)
          .filter(([, cached]) => cached?.mrId)
          .map(([songId, cached]) => [songbookCacheKey(activeSongbook.platform, songId), cached]));
        if (Object.keys(resolved).length) {
          setSharedStateRef.current((previous) => ({
            ...previous,
            songbookMrCache: { ...(previous.songbookMrCache || {}), ...resolved }
          }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setCacheLookupKeys((previous) => ({ ...previous, ...Object.fromEntries(pendingKeys.map((key) => [key, false])) }));
        }
      });

    return () => { cancelled = true; };
  }, [activeTab, melomingChannelId, melo.songs, setlink.songs, setlinkCatalog.length, playlist.songs, youtubePlaylistCatalog.length]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSharedState(prev => ({ ...prev, activeIntegrationTab: tab }));
  };

  const runYoutubeSearch = async (searchQuery) => {
    if (!searchQuery.trim()) return;

    const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = searchQuery.match(ytRegex);
    if (match) {
      const videoId = match[1];
      onSelectResult({
        id: videoId,
        title: 'URL 직접 입력 영상 (분석 중...)',
        channelTitle: '알 수 없음'
      });
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(searchQuery)}`));
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

  const handleFileSelect = (e, songbookContext = null) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
    const isSupportedMedia = file.type.startsWith('audio/') || file.type === 'video/mp4';
    if (!isSupportedMedia) {
      alert('오류: 오디오 파일 또는 MP4 영상만 지원됩니다.');
        return;
      }
    if (file.size > 200 * 1024 * 1024) {
      alert('오류: 200MB 이하의 오디오/MP4 파일만 업로드할 수 있습니다.');
        return;
      }
      onLocalFileDrop(file, songbookContext);
    }
  };

  const handleFileDrop = (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFileSelect({ target: { files: [file] } });
  };

  const handleSearch = (e) => {
    e.preventDefault();
    runYoutubeSearch(query);
  };

  const selectYoutubeResult = (video) => {
    if (pendingSongbookMatch) {
      onSelectResult({
        ...video,
        title: pendingSongbookMatch.title || video.title,
        source: pendingSongbookMatch.source,
        songbookId: pendingSongbookMatch.songbookId,
        tags: pendingSongbookMatch.tags || [],
        skipAiTitleExtraction: true
      });
      setPendingSongbookMatch(null);
      return;
    }
    onSelectResult(video);
  };

  const stageSongbookMr = (song, platform, mrId, mrVerified = false) => {
    onSelectResult({
      id: mrId,
      title: song.title,
      channelTitle: song.artist,
      src: mrId,
      tags: song.tags,
      source: platform,
      songbookId: song.id,
      mrVerified,
      skipAiTitleExtraction: true
    });
  };

  const startSongbookMrSearch = (song, platform) => {
    const tagQuery = Array.isArray(song.tags) ? song.tags.filter(Boolean).join(' ') : '';
    const searchQuery = [song.artist, song.title, tagQuery].filter(Boolean).join(' ').trim();
    setPendingSongbookMatch({ title: song.title, source: platform, songbookId: song.id, tags: song.tags || [] });
    setQuery(searchQuery);
    setResults([]);
    handleTabChange('youtube');
    runYoutubeSearch(searchQuery);
  };

  const chooseSongbookUpload = (song, platform) => {
    setSongbookUploadContext({
      title: song.title,
      artist: song.artist || '',
      tags: song.tags || [],
      source: platform,
      songbookId: song.id
    });
    fileInputRef.current?.click();
  };

  const selectSongbookSong = async (song, platform, youtubeId, cachedMr) => {
    if (cachedMr?.mrId) {
      stageSongbookMr(song, platform, cachedMr.mrId, true);
      return;
    }

    // A quick row click can beat the list's batch cache request.  Resolve that
    // race here so a confirmed MR is never hidden behind a fresh search.
    try {
      const response = await fetch(apiUrl(`/api/title-cache?kind=${encodeURIComponent(`songbook:${platform}`)}&id=${encodeURIComponent(song.id)}`));
      const data = await response.json();
      if (data.cached?.mrId) {
        const cacheEntry = data.cached;
        setSharedState((previous) => ({
          ...previous,
          songbookMrCache: {
            ...(previous.songbookMrCache || {}),
            [songbookCacheKey(platform, song.id)]: cacheEntry
          }
        }));
        stageSongbookMr(song, platform, cacheEntry.mrId, true);
        return;
      }
    } catch {
      // A cache miss must fall through to the normal MR selection flow.
    }

    if (youtubeId) {
      stageSongbookMr(song, platform, youtubeId, Boolean(song.mrVerified));
      return;
    }
    startSongbookMrSearch(song, platform);
  };

  const handleIntegrationConnect = (platform, id) => {
    if (!id.trim()) return;
    if (platform === 'meloming') {
      setSharedState(prev => ({ ...prev, melomingChannelId: id.trim() }));
    }
  };

  const handleSetlinkImport = async (value = tempSetlinkUrl) => {
    const sourceUrl = value.trim();
    if (!sourceUrl) return;
    setIsSetlinkLoading(true);
    setCatalogImportError('');
    try {
      const response = await fetch(apiUrl(`/api/setlink?url=${encodeURIComponent(sourceUrl)}`));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Setlink 공개 목록을 가져오지 못했습니다.');
      if (!Array.isArray(data.songs) || data.songs.length === 0) {
        throw new Error('공개 목록에 표시할 곡이 없습니다.');
      }
      setSharedState((previous) => ({
        ...previous,
        setlinkSourceUrl: sourceUrl,
        setlinkCatalog: data.songs,
        setlinkCatalogMeta: data.source || null,
      }));
      setTempSetlinkUrl(sourceUrl);
    } catch (importError) {
      setCatalogImportError(importError.message || 'Setlink 공개 목록을 가져오지 못했습니다.');
    } finally {
      setIsSetlinkLoading(false);
    }
  };

  const handlePlaylistImport = async (value = tempPlaylistUrl) => {
    const sourceUrl = value.trim();
    if (!sourceUrl) return;
    setIsPlaylistLoading(true);
    setPlaylistImportError('');
    try {
      const response = await fetch(apiUrl(`/api/youtube-playlist?url=${encodeURIComponent(sourceUrl)}`));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'YouTube 플레이리스트를 가져오지 못했습니다.');
      if (!Array.isArray(data.songs) || data.songs.length === 0) throw new Error('플레이리스트에 가져올 영상이 없습니다.');
      setSharedState((previous) => ({ ...previous, youtubePlaylistSourceUrl: sourceUrl, youtubePlaylistCatalog: data.songs, youtubePlaylistCatalogMeta: data.source || null }));
      setTempPlaylistUrl(sourceUrl);
    } catch (importError) {
      setPlaylistImportError(importError.message || 'YouTube 플레이리스트를 가져오지 못했습니다.');
    } finally {
      setIsPlaylistLoading(false);
    }
  };

  const handleIntegrationDisconnect = (platform) => {
    if(window.confirm('연동을 해제하시겠습니까?')) {
      if (platform === 'meloming') {
        setSharedState(prev => ({ ...prev, melomingChannelId: '' }));
      } else {
        setSharedState(prev => platform === 'youtube-playlist'
          ? ({ ...prev, youtubePlaylistSourceUrl: '', youtubePlaylistCatalog: [], youtubePlaylistCatalogMeta: null })
          : ({ ...prev, setlinkSourceUrl: '', setlinkCatalog: [], setlinkCatalogMeta: null }));
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
            <div style={{display:'flex', width:'100%', cursor:'pointer'}} onClick={() => selectYoutubeResult(v)}>
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
          <div className="composer-search-hint">
            곡명 또는 YouTube URL을 입력하세요. 로컬 MR은 아래에서 바로 추가할 수 있어요.
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
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleFileDrop}
        style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}
        title="클릭하여 파일 선택"
      >
        <UploadCloud size={32} style={{ color: 'var(--eureka-emerald)', marginBottom: '10px' }} />
        <p style={{ margin: 0, fontWeight: 500 }}>로컬 MR 파일(오디오/MP4) 추가하기</p>
        <p style={{ margin: '5px 0 15px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>드래그 앤 드롭 또는 클릭하세요</p>
        <button className="btn-secondary" style={{ pointerEvents: 'none' }}>파일 선택</button>
      </div>
    </>
  );

  const renderSongbook = (platform, hookData, localSearch, setLocalSearch, isConnected, idValue, setIdValue, emptyMessage) => {
    if (!isConnected) {
      const isMeloming = platform === 'meloming';
      const isPlaylist = platform === 'youtube-playlist';
      const inputValue = isMeloming ? idValue : isPlaylist ? tempPlaylistUrl : tempSetlinkUrl;
      const inputPlaceholder = isMeloming ? '예: 12345 (멜로밍 채널 ID)' : isPlaylist ? 'https://www.youtube.com/playlist?list=...' : 'https://setlink.jp/public/...';
      const submitImport = isMeloming ? () => handleIntegrationConnect('meloming', idValue) : isPlaylist ? () => handlePlaylistImport(tempPlaylistUrl) : () => handleSetlinkImport(tempSetlinkUrl);
      const sourceError = isPlaylist ? playlistImportError : catalogImportError;
      return (
        <div className="onboarding" style={{textAlign:'center', marginTop:'2rem', padding:'2rem', background:'rgba(0,0,0,0.1)', borderRadius:'12px', border:'1px solid var(--glass-border)'}}>
          {isMeloming ? <Music size={48} color="var(--eureka-emerald)" style={{margin:'0 auto 1rem'}} /> : <Link size={48} color="var(--eureka-azure)" style={{margin:'0 auto 1rem'}} />}
          <h3 style={{marginBottom:'0.5rem', fontSize:'1.2rem', color:'var(--text-main)'}}>공개 노래책 추가</h3>
          <p style={{fontSize:'0.9rem', color:'var(--text-muted)', marginBottom:'1.5rem', lineHeight:'1.5'}}>
            공개 노래책을 한 번 가져와 카탈로그에 첨부합니다.<br/>
            목록은 자동 갱신되지 않으며, 업데이트 시 새로고침할 수 있습니다.
          </p>
          <form onSubmit={(event) => { event.preventDefault(); submitImport(); }} style={{display:'flex', gap:'0.5rem', flexDirection:'column', maxWidth:'520px', margin:'0 auto'}}>
            <input 
              type={isMeloming ? 'text' : 'url'}
              placeholder={inputPlaceholder}
              className="glass-input"
              value={inputValue}
              onChange={(event) => isMeloming ? setIdValue(event.target.value) : setTempSetlinkUrl(event.target.value)}
              style={{textAlign:'center'}}
            />
            <button type="submit" className="btn-primary" style={{padding:'0.8rem'}} disabled={isSetlinkLoading || !inputValue.trim()}>
              {(isSetlinkLoading || isPlaylistLoading) && !isMeloming ? <><Loader2 className="spinner" size={16} /> 가져오는 중</> : '목록 가져오기'}
            </button>
            <div style={{fontSize:'0.75rem', color:'var(--text-muted)', marginTop:'0.5rem'}}>
              {isMeloming ? '멜로밍 개발자 문서의 공개 채널 ID를 사용합니다.' : 'Setlink 공개 페이지의 주소를 붙여넣으세요.'}
            </div>
          </form>
          {sourceError && <p style={{fontSize:'0.8rem', color:'var(--accent-red)'}}>{sourceError}</p>}
        </div>
      );
    }

    const { songs, isLoading, error, refresh } = hookData;
    
    // 로컬 필터링
    const filteredSongs = songs.filter(s => 
      s.title.toLowerCase().includes(localSearch.toLowerCase()) || 
      (s.artist && s.artist.toLowerCase().includes(localSearch.toLowerCase())) ||
      (s.tags && s.tags.join(' ').toLowerCase().includes(localSearch.toLowerCase()))
    );

    const getYouTubeId = (value = '') => {
      const trimmed = value.trim();
      if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
      const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/i);
      return match ? match[1] : '';
    };

    // 100개까지만 표시하여 성능 보장
    const displaySongs = filteredSongs.slice(0, 100);

    return (
      <div className="songbook-list" style={{display:'flex', flexDirection:'column', flex:1}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:'0.5rem', borderBottom:'1px solid var(--glass-border)', marginBottom:'1rem'}}>
          <div style={{fontSize:'0.85rem', color: platform === 'meloming' ? 'var(--eureka-emerald)' : 'var(--eureka-azure)'}}>
            ✅ <strong>{platform === 'setlink' ? (setlinkCatalogMeta?.name || 'Setlink') : platform === 'youtube-playlist' ? (youtubePlaylistCatalogMeta?.name || 'YouTube 플레이리스트') : (hookData.source?.name || `멜로밍 ${isConnected}`)}</strong> 가져옴 ({songs.length}곡)
          </div>
          <div style={{display:'flex', gap:'0.5rem'}}>
            {platform === 'setlink' && setlinkSourceUrl && <button onClick={() => handleSetlinkImport(setlinkSourceUrl)} className="btn-icon" title="공개 목록 새로고침"><RefreshCw size={14} className={isSetlinkLoading ? 'spinner' : ''} /></button>}
            {platform === 'youtube-playlist' && youtubePlaylistSourceUrl && <button onClick={() => handlePlaylistImport(youtubePlaylistSourceUrl)} className="btn-icon" title="플레이리스트 새로고침"><RefreshCw size={14} className={isPlaylistLoading ? 'spinner' : ''} /></button>}
            {platform !== 'setlink' && platform !== 'youtube-playlist' && <button onClick={refresh} className="btn-icon" title="새로고침">
              <RefreshCw size={14} className={isLoading ? 'spinner' : ''} />
            </button>}
            <button onClick={() => handleIntegrationDisconnect(platform)} className="btn-icon btn-icon-danger" style={{fontSize:'0.75rem'}}>해제</button>
          </div>
        </div>

        {error && (
          <div className="empty-state" style={{color:'var(--accent-red)', padding:'1rem'}}>
            <AlertCircle size={24} style={{margin:'0 auto 0.5rem'}}/>
            {error}
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
          {displaySongs.map(song => {
            const youtubeId = getYouTubeId(song.youtubeUrl);
            const cacheKey = songbookCacheKey(platform, song.id);
            const cachedMr = songbookMrCache[cacheKey];
            const isCheckingCache = cacheLookupKeys[cacheKey];
            const primaryActionLabel = cachedMr?.mrId
              ? '저장된 MR 검토'
              : youtubeId
                ? '노래책 MR 검토'
                : 'MR 찾기';
            return (
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
                <div style={{fontSize:'0.7rem', color: cachedMr?.mrId ? 'var(--eureka-emerald)' : 'var(--text-muted)', marginTop:'0.35rem'}}>
                  {cachedMr?.mrId ? '저장된 MR 있음' : isCheckingCache ? '저장된 MR 확인 중' : youtubeId ? '노래책 MR 확인 필요' : '저장된 MR 없음'}
                </div>
                {youtubeId && (
                  <span style={{fontSize:'0.65rem', color: song.mrVerified ? 'var(--eureka-emerald)' : 'var(--text-muted)'}}>
                    {song.mrVerified ? 'MR 검증됨' : 'MR 재생 확인 필요'}
                  </span>
                )}
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: '0.3rem'}}>
                <button 
                  className="btn-primary" 
                  style={{padding:'0.5rem 1rem', fontSize:'0.85rem', display:'flex', alignItems:'center', gap:'0.4rem', flexShrink: 0}}
                  onClick={() => selectSongbookSong(song, platform, youtubeId, cachedMr)}
                >
                  {cachedMr?.mrId || youtubeId ? <><Music size={14}/>{primaryActionLabel}</> : <><Search size={14}/>{primaryActionLabel}</>}
                </button>
                {(cachedMr?.mrId || youtubeId) && (
                  <button
                    className="btn-secondary"
                    style={{padding:'0.4rem 0.7rem', fontSize:'0.75rem'}}
                    onClick={() => startSongbookMrSearch(song, platform)}
                  >
                    다른 MR 찾기
                  </button>
                )}
                <button
                  className="btn-secondary"
                  style={{padding:'0.4rem 0.7rem', fontSize:'0.75rem'}}
                  onClick={() => chooseSongbookUpload(song, platform)}
                >
                  MR 업로드
                </button>
              </div>
            </div>
            );
          })}
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
            className={`tab-btn ${activeTab === 'youtube-playlist' ? 'active' : ''}`}
            onClick={() => handleTabChange('youtube-playlist')}
          >
            <Link size={14}/> YouTube 목록
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
          '노래책에 등록된 곡이 없습니다.'
        )}
          {activeTab === 'youtube-playlist' && renderSongbook(
          'youtube-playlist',
          { ...playlist, isLoading: isPlaylistLoading, error: playlistImportError || playlist.error, refresh: () => handlePlaylistImport(youtubePlaylistSourceUrl) },
          playlistSearch,
          setPlaylistSearch,
          youtubePlaylistCatalog.length > 0,
          '',
          () => {},
          '가져온 플레이리스트에 영상이 없습니다.'
        )}
        {activeTab === 'setlink' && renderSongbook(
          'setlink', 
          { ...setlink, isLoading: isSetlinkLoading, error: catalogImportError || setlink.error, refresh: () => handleSetlinkImport(setlinkSourceUrl) },
          setlinkSearch, 
          setSetlinkSearch, 
          setlinkCatalog.length > 0,
          '',
          () => {},
          '가져온 공개 목록에 곡이 없습니다.'
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/mp4"
        onChange={(event) => {
          handleFileSelect(event, songbookUploadContext);
          setSongbookUploadContext(null);
          event.target.value = '';
        }}
        className="hidden-file-input"
      />
    </div>
  );
}
