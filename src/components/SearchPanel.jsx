import React, { useEffect, useRef, useState } from 'react';
import { Search, Music, UploadCloud, Loader2, RefreshCw, AlertCircle, Link, FileUp, ChevronRight } from 'lucide-react';
import { useMeloming } from '../hooks/useMeloming';
import { useSetlink } from '../hooks/useSetlink';
import { useYoutubePlaylist } from '../hooks/useYoutubePlaylist';
import { apiUrl } from '../lib/api';
import { readTitleEventStream } from '../lib/titleStream';
import { getOutputMessage as t } from '../copy/outputMessages';

const songbookCacheKey = (platform, songId) => `${platform}:${songId}`;

async function readYoutubeTitle(videoId, signal) {
  const title = await readTitleEventStream(apiUrl(`/api/extract-title?id=${encodeURIComponent(videoId)}`), {}, { signal });
  if (!title) throw new Error('AI title was not returned');
  return title;
}

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
  const [playlistTitleProgress, setPlaylistTitleProgress] = useState({ total: 0, completed: 0, active: false });
  const [playlistImportRun, setPlaylistImportRun] = useState(0);
  const [retryingPlaylistTitleIds, setRetryingPlaylistTitleIds] = useState(() => new Set());

  // Local search queries for songbooks
  const [meloSearch, setMeloSearch] = useState('');
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [setlinkSearch, setSetlinkSearch] = useState('');
  const fileInputRef = useRef(null);
  const playlistTitleAbortRef = useRef(null);
  const youtubePlaylistCatalogRef = useRef(youtubePlaylistCatalog);
  youtubePlaylistCatalogRef.current = youtubePlaylistCatalog;
  
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
    let cancelled = false;

    fetch(apiUrl('/api/title-cache'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'lookup',
        kind: `songbook:${activeSongbook.platform}`,
        ids: songsToCheck.map((song) => song.id)
      })
    })
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

  const playlistFingerprint = youtubePlaylistCatalog.map((song) => song.sourceId || song.id).join('|');

  useEffect(() => {
    playlistTitleAbortRef.current?.abort();
    const currentCatalog = youtubePlaylistCatalogRef.current;
    if (!currentCatalog.length) {
      setPlaylistTitleProgress({ total: 0, completed: 0, active: false });
      return undefined;
    }

    const controller = new AbortController();
    playlistTitleAbortRef.current = controller;
    const sourceSongs = currentCatalog.map((song) => ({ ...song }));

    const updatePlaylistSong = (sourceId, patch) => {
      setSharedStateRef.current((previous) => ({
        ...previous,
        youtubePlaylistCatalog: (previous.youtubePlaylistCatalog || []).map((song) => (
          song.sourceId === sourceId ? { ...song, ...patch } : song
        ))
      }));
    };

    const resolveTitles = async () => {
      const pending = sourceSongs.filter((song) => !(song.titleStatus === 'ready' && song.title?.trim()));
      const completedFromState = sourceSongs.length - pending.length;
      setSharedStateRef.current((previous) => ({
        ...previous,
        youtubePlaylistCatalog: (previous.youtubePlaylistCatalog || []).map((song) => {
          if (song.titleStatus === 'ready' && song.title?.trim()) return song;
          return { ...song, rawTitle: song.rawTitle || song.title, title: '', titleStatus: 'pending' };
        })
      }));
      setPlaylistTitleProgress({ total: sourceSongs.length, completed: completedFromState, active: pending.length > 0 });

      let completed = completedFromState;
      let nextIndex = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const song = pending[nextIndex++];
          if (!song) return;
          try {
            const title = await readYoutubeTitle(song.sourceId, controller.signal);
            if (!controller.signal.aborted) updatePlaylistSong(song.sourceId, { title, titleStatus: 'ready' });
          } catch (error) {
            if (error.name !== 'AbortError' && !controller.signal.aborted) {
              updatePlaylistSong(song.sourceId, { title: '', titleStatus: 'error' });
            }
          } finally {
            if (!controller.signal.aborted) {
              completed += 1;
              setPlaylistTitleProgress({ total: sourceSongs.length, completed, active: completed < sourceSongs.length });
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
    };

    resolveTitles().catch(() => {
      if (!controller.signal.aborted) setPlaylistTitleProgress({ total: sourceSongs.length, completed: 0, active: false });
    });

    return () => controller.abort();
  }, [playlistFingerprint, playlistImportRun]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSharedState(prev => ({ ...prev, activeIntegrationTab: tab }));
  };

  const runYoutubeSearch = async (searchQuery) => {
    if (!searchQuery.trim()) return;

    const ytRegex = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;
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

  const retryPlaylistTitle = async (song) => {
    const sourceId = song.sourceId || song.id;
    if (!sourceId || retryingPlaylistTitleIds.has(sourceId)) return;

    setRetryingPlaylistTitleIds((previous) => new Set(previous).add(sourceId));
    setSharedStateRef.current((previous) => ({
      ...previous,
      youtubePlaylistCatalog: (previous.youtubePlaylistCatalog || []).map((catalogSong) => (
        catalogSong.sourceId === sourceId
          ? { ...catalogSong, rawTitle: catalogSong.rawTitle || catalogSong.title, title: '', titleStatus: 'pending' }
          : catalogSong
      ))
    }));

    try {
      const title = await readYoutubeTitle(sourceId);
      setSharedStateRef.current((previous) => ({
        ...previous,
        youtubePlaylistCatalog: (previous.youtubePlaylistCatalog || []).map((catalogSong) => (
          catalogSong.sourceId === sourceId ? { ...catalogSong, title, titleStatus: 'ready' } : catalogSong
        ))
      }));
    } catch {
      setSharedStateRef.current((previous) => ({
        ...previous,
        youtubePlaylistCatalog: (previous.youtubePlaylistCatalog || []).map((catalogSong) => (
          catalogSong.sourceId === sourceId ? { ...catalogSong, title: '', titleStatus: 'error' } : catalogSong
        ))
      }));
    } finally {
      setRetryingPlaylistTitleIds((previous) => {
        const next = new Set(previous);
        next.delete(sourceId);
        return next;
      });
    }
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

  const stageSongbookMr = (song, platform, mrId, mrVerified = false, cachedTitle = '') => {
    onSelectResult({
      id: mrId,
      title: cachedTitle || song.title,
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
      stageSongbookMr(song, platform, cachedMr.mrId, true, cachedMr.title);
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
        stageSongbookMr(song, platform, cacheEntry.mrId, true, cacheEntry.title);
        return;
      }
    } catch {
      // A cache miss must fall through to the normal MR selection flow.
    }

    if (youtubeId) {
      stageSongbookMr(song, platform, youtubeId, platform === 'youtube-playlist' || Boolean(song.mrVerified));
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
      setSharedState((previous) => ({
        ...previous,
        youtubePlaylistSourceUrl: sourceUrl,
        youtubePlaylistCatalog: data.songs.map((song) => ({ ...song, rawTitle: song.title, title: '', titleStatus: 'pending' })),
        youtubePlaylistCatalogMeta: data.source || null
      }));
      setTempPlaylistUrl(sourceUrl);
      setPlaylistImportRun((run) => run + 1);
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
            placeholder={t('search.youtube.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="glass-input search-input"
            disabled={isSearching}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={isSearching || !query.trim()}>
          {isSearching ? <><Loader2 className="spinner" size={18} /> {t('search.youtube.searching')}</> : t('search.youtube.action')}
        </button>
      </form>

      <div className="search-results">
        {results.map((v) => (
          <div key={v.id} className="result-item" style={{position:'relative'}}>
            <button
              type="button"
              className="result-select-button"
              onClick={() => selectYoutubeResult(v)}
              aria-label={t('search.result.select', { title: v.title })}
            >
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
              <ChevronRight size={18} className="result-select-chevron" aria-hidden="true" />
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
          <div className="composer-search-hint">
            {t('search.youtube.emptyHint')}
          </div>
        )}
        {results.length === 0 && !isSearching && query !== '' && !error && (
          <div className="empty-state" style={{padding:'2rem 1rem', color:'var(--accent-red)'}}>
            <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem'}}>🤷‍♂️</span>
            {t('search.youtube.noResults')}<br/>
            ({t('search.youtube.noResultsHint')})
          </div>
        )}
        {error && (
          <div className="empty-state" style={{padding:'2rem 1rem', color:'var(--accent-red)'}}>
            <span style={{fontSize:'1.5rem', display:'block', marginBottom:'0.5rem'}}>⚠️</span>
            {t('search.youtube.serverError')}<br/>
            {t('search.youtube.tryAgain')}
          </div>
        )}
      </div>

      <div className="divider composer-import-divider">또는 로컬 파일</div>

      <div
        className="composer-file-import"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleFileDrop}
        title="클릭하여 파일 선택"
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <UploadCloud size={20} aria-hidden="true" />
        <span className="composer-file-import-label">로컬 MR 파일 추가</span>
        <span className="composer-file-import-help">오디오 또는 MP4 · 드래그하거나 선택</span>
        <span className="composer-file-import-action" aria-hidden="true">파일 선택</span>
      </div>
    </>
  );

  const renderSongbook = (platform, hookData, localSearch, setLocalSearch, isConnected, idValue, setIdValue, emptyMessage) => {
    if (!isConnected) {
      const isMeloming = platform === 'meloming';
      const isPlaylist = platform === 'youtube-playlist';
      const inputValue = isMeloming ? idValue : isPlaylist ? tempPlaylistUrl : tempSetlinkUrl;
      const inputPlaceholder = isMeloming ? 'https://meloming.com/channel/채널경로 또는 ID' : isPlaylist ? 'https://www.youtube.com/playlist?list=...' : 'https://setlink.jp/public/...';
      const submitImport = isMeloming ? () => handleIntegrationConnect('meloming', idValue) : isPlaylist ? () => handlePlaylistImport(tempPlaylistUrl) : () => handleSetlinkImport(tempSetlinkUrl);
      const sourceError = isPlaylist ? playlistImportError : catalogImportError;
      const isImporting = isPlaylist ? isPlaylistLoading : !isMeloming && isSetlinkLoading;
      const handleInputChange = isMeloming ? setIdValue : isPlaylist ? setTempPlaylistUrl : setTempSetlinkUrl;
      const sourceName = isMeloming ? '멜로밍 노래책' : isPlaylist ? 'YouTube 플레이리스트' : 'Setlink 목록';
      const sourceHelp = isMeloming
        ? '멜로밍 채널 주소, 채널 경로(예: amoamoretto), 또는 숫자 ID를 입력하세요. 주소와 경로는 내부 ID로 자동 변환합니다.'
        : isPlaylist
          ? 'YouTube 플레이리스트 주소를 붙여 넣으면 영상 목록을 노래책으로 가져옵니다.'
          : 'Setlink 공개 페이지의 주소를 붙여넣으세요.';
      return (
        <section className="songbook-connect">
          {isMeloming ? <Music className="songbook-connect-icon" size={32} color="var(--eureka-emerald)" /> : <Link className="songbook-connect-icon" size={32} color="var(--eureka-azure)" />}
          <h3 className="songbook-connect-title">{sourceName} 추가</h3>
          <p className="songbook-connect-description">
            목록을 한 번 가져와 카탈로그에 첨부합니다.<br/>
            목록은 자동 갱신되지 않으며, 업데이트 시 새로고침할 수 있습니다.
          </p>
          <form className="source-connect-form" onSubmit={(event) => { event.preventDefault(); submitImport(); }}>
            <input 
              type={isMeloming ? 'text' : 'url'}
              placeholder={inputPlaceholder}
              className="glass-input"
              value={inputValue}
              onChange={(event) => handleInputChange(event.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={isImporting || !inputValue.trim()}>
              {isImporting ? <><Loader2 className="spinner" size={16} /> 가져오는 중</> : '목록 가져오기'}
            </button>
            <div className="source-connect-help">
              {sourceHelp}
            </div>
          </form>
          {sourceError && <p className="source-connect-error">{sourceError}</p>}
        </section>
      );
    }

    const { songs, isLoading, error, refresh } = hookData;
    
    // 로컬 필터링
    const filteredSongs = songs.filter(s =>
      (s.title || s.rawTitle || '').toLowerCase().includes(localSearch.toLowerCase()) ||
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
      <section className="songbook-list" aria-label="노래책 곡 목록">
        <div className="songbook-toolbar">
          <div className="songbook-summary" data-source={platform}>
            ✅ <strong>{platform === 'setlink' ? (setlinkCatalogMeta?.name || 'Setlink') : platform === 'youtube-playlist' ? (youtubePlaylistCatalogMeta?.name || 'YouTube 플레이리스트') : (hookData.source?.name || `멜로밍 ${isConnected}`)}</strong> 가져옴 ({songs.length}곡)
            {platform === 'youtube-playlist' && playlistTitleProgress.total > 0 && (
              <span style={{marginLeft:'0.5rem', color: playlistTitleProgress.active ? 'var(--eureka-azure)' : 'var(--eureka-emerald)'}}>
                · AI 곡명 정리 {playlistTitleProgress.completed}/{playlistTitleProgress.total}
              </span>
            )}
          </div>
          <div className="songbook-toolbar-actions">
            {platform === 'setlink' && setlinkSourceUrl && <button onClick={() => handleSetlinkImport(setlinkSourceUrl)} className="btn-icon" title="공개 목록 새로고침"><RefreshCw size={14} className={isSetlinkLoading ? 'spinner' : ''} /></button>}
            {platform === 'youtube-playlist' && youtubePlaylistSourceUrl && <button onClick={() => handlePlaylistImport(youtubePlaylistSourceUrl)} className="btn-icon" title="플레이리스트 새로고침"><RefreshCw size={14} className={isPlaylistLoading ? 'spinner' : ''} /></button>}
            {platform !== 'setlink' && platform !== 'youtube-playlist' && <button onClick={refresh} className="btn-icon" title="새로고침">
              <RefreshCw size={14} className={isLoading ? 'spinner' : ''} />
            </button>}
            <button onClick={() => handleIntegrationDisconnect(platform)} className="btn-icon btn-icon-danger" style={{fontSize:'0.75rem'}}>해제</button>
          </div>
        </div>

        {error && (
          <div className="empty-state composer-empty-state" style={{color:'var(--accent-red)'}}>
            <AlertCircle size={24} style={{margin:'0 auto 0.5rem'}}/>
            {error}
          </div>
        )}

        {/* 내 노래책 내에서 검색 */}
        <div className="search-input-wrapper songbook-search">
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
            <div className="empty-state composer-empty-state">{emptyMessage}</div>
          )}
          {!isLoading && songs.length > 0 && filteredSongs.length === 0 && (
            <div className="empty-state composer-empty-state">
              일치하는 곡이 없습니다.
            </div>
          )}
          {displaySongs.map(song => {
            const youtubeId = getYouTubeId(song.youtubeUrl);
            const cacheKey = songbookCacheKey(platform, song.id);
            const cachedMr = songbookMrCache[cacheKey];
            const isCheckingCache = cacheLookupKeys[cacheKey];
            const hasLinkedMr = Boolean(cachedMr?.mrId || youtubeId);
            const hasSongbookMr = Boolean(youtubeId);
            const hasMrCandidate = hasLinkedMr || hasSongbookMr;
            const isTitleReady = platform !== 'youtube-playlist' || song.titleStatus === 'ready';
            const isTitleRetrying = retryingPlaylistTitleIds.has(song.sourceId || song.id);
            const canRetryTitle = platform === 'youtube-playlist' && song.titleStatus === 'error';
            const displayTitle = isTitleReady ? song.title : song.titleStatus === 'error' ? 'AI 곡명 정리 실패' : 'AI 곡명 정리 중…';
            const pendingActionLabel = song.titleStatus === 'error' ? '정리 실패' : '곡명 정리 중';
            const primaryActionLabel = hasMrCandidate ? 'MR 확인' : 'MR 찾기';
            const mrStateLabel = hasLinkedMr
              ? '연결된 MR 있음'
              : isCheckingCache
                ? 'MR 연결 확인 중'
                : 'MR 연결 없음';
            return (
            <div key={song.id} className="result-item songbook-item">
              <button
                type="button"
                className="songbook-copy"
                onClick={() => selectSongbookSong(song, platform, youtubeId, cachedMr)}
                disabled={!isTitleReady}
                aria-label={t('search.songbook.select', { title: displayTitle })}
              >
                <div className={`songbook-title ${isTitleReady ? '' : 'is-pending'}`}>{displayTitle}</div>
                <div className="songbook-artist">{song.artist}</div>
                {song.tags && song.tags.length > 0 && (
                  <div className="songbook-tags">
                    {song.tags.map(t => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                )}
                <div className={`songbook-mr-state ${hasLinkedMr ? 'is-linked' : ''}`}>
                  {mrStateLabel}
                </div>
                {isTitleReady && (
                  <span className="songbook-select-hint">
                    {t('search.songbook.selectHint')} <ChevronRight size={14} aria-hidden="true" />
                  </span>
                )}
              </button>
              <div className="songbook-actions">
                {canRetryTitle ? (
                  <button
                    className="songbook-retry-action"
                    onClick={() => retryPlaylistTitle(song)}
                    disabled={isTitleRetrying}
                    title="이 곡만 AI 곡명 정리를 다시 시도합니다"
                  >
                    <RefreshCw size={13} className={isTitleRetrying ? 'spinner' : ''} /> 재분석
                  </button>
                ) : (
                  <button
                    className="btn-primary songbook-action-primary"
                    onClick={() => selectSongbookSong(song, platform, youtubeId, cachedMr)}
                    disabled={!isTitleReady}
                  >
                    {isTitleReady ? (hasMrCandidate ? <><Music size={14}/>{primaryActionLabel}</> : <><Search size={14}/>{primaryActionLabel}</>) : pendingActionLabel}
                  </button>
                )}
                {hasMrCandidate && isTitleReady && (
                  <button
                    className="btn-secondary songbook-action-secondary"
                    onClick={() => startSongbookMrSearch(song, platform)}
                  >
                    다른 MR 찾기
                  </button>
                )}
                {platform !== 'youtube-playlist' && (
                  <button
                    className="songbook-file-action"
                    onClick={() => chooseSongbookUpload(song, platform)}
                    title="파일은 이번 방송에서만 사용합니다"
                  >
                    <FileUp size={14} /> 내 파일
                  </button>
                )}
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
      </section>
    );
  };

  return (
    <section className="panel search-panel">
      <header className="composer-source-nav">
        <div
          className="tabs source-tabs"
          role="group"
          aria-label="곡 추가 방식"
          data-source-tab-count="4"
        >
          <button
            type="button"
            className={`tab-btn source-tab ${activeTab === 'youtube' ? 'active' : ''}`}
            data-source="youtube"
            aria-pressed={activeTab === 'youtube'}
            title={t('search.tab.youtubeSearch')}
            onClick={() => handleTabChange('youtube')}
          >
            <Search size={14} aria-hidden="true" />
            <span className="source-tab-label">{t('search.tab.youtubeSearch')}</span>
          </button>
          <button
            type="button"
            className={`tab-btn source-tab ${activeTab === 'youtube-playlist' ? 'active' : ''}`}
            data-source="youtube-playlist"
            aria-pressed={activeTab === 'youtube-playlist'}
            title={t('search.tab.youtubeList')}
            onClick={() => handleTabChange('youtube-playlist')}
          >
            <Link size={14} aria-hidden="true" />
            <span className="source-tab-label">{t('search.tab.youtubeList')}</span>
          </button>
          <button
            type="button"
            className={`tab-btn source-tab ${activeTab === 'setlink' ? 'active' : ''}`}
            data-source="setlink"
            aria-pressed={activeTab === 'setlink'}
            title={t('search.tab.setlink')}
            onClick={() => handleTabChange('setlink')}
          >
            <Link size={14} aria-hidden="true" />
            <span className="source-tab-label">{t('search.tab.setlink')}</span>
          </button>
          <button
            type="button"
            className={`tab-btn source-tab ${activeTab === 'meloming' ? 'active' : ''}`}
            data-source="meloming"
            aria-pressed={activeTab === 'meloming'}
            title={t('search.tab.meloming')}
            onClick={() => handleTabChange('meloming')}
          >
            <Music size={14} aria-hidden="true" />
            <span className="source-tab-label">{t('search.tab.meloming')}</span>
          </button>
        </div>
      </header>
      
      <main className="composer-content">
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
      </main>
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
    </section>
  );
}
