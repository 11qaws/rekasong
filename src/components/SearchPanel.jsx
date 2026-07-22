import React, { useEffect, useRef, useState } from 'react';
import { Search, Music, UploadCloud, Loader2, RefreshCw, AlertCircle, Link, FileUp, ChevronRight, ListVideo, GripVertical } from 'lucide-react';
import { useMeloming } from '../hooks/useMeloming';
import { useSetlink } from '../hooks/useSetlink';
import { useYoutubePlaylist } from '../hooks/useYoutubePlaylist';
import { apiUrl } from '../lib/api';
import { readTitleEventStream } from '../lib/titleStream';
import { normalizeSongDragCandidate, SONG_DRAG_DATA_TYPE } from '../lib/songDragAction';
import { getAppMessage as t } from '../copy/appMessages';

const songbookCacheKey = (platform, songId) => `${platform}:${songId}`;

async function readYoutubeTitle(videoId, signal) {
  const title = await readTitleEventStream(apiUrl(`/api/extract-title?id=${encodeURIComponent(videoId)}`), {}, { signal });
  if (!title) throw new Error('AI title was not returned');
  return title;
}

export default function SearchPanel({
  onSelectResult,
  onLocalFileDrop,
  onSongDragStart,
  onSongDragEnd,
  sharedState,
  setSharedState,
}) {
  const { melomingChannelId, setlinkCatalog = [], setlinkSourceUrl = '', setlinkCatalogMeta = null, youtubePlaylistCatalog = [], youtubePlaylistSourceUrl = '', songbookMrCache = {}, activeIntegrationTab } = sharedState;
  
  // YouTube search and imported playlists share one top-level source.  Keep the
  // legacy persisted tab values so existing sessions reopen the same inner
  // view without exposing two competing YouTube labels in the main nav.
  const initialTab = ['youtube', 'youtube-playlist', 'setlink', 'meloming'].includes(activeIntegrationTab)
    ? activeIntegrationTab
    : 'youtube';
  const [activeTab, setActiveTab] = useState(initialTab);
  const lastYoutubeTabRef = useRef(['youtube', 'youtube-playlist'].includes(initialTab)
    ? initialTab
    : 'youtube');
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
  const [openingSongbookKey, setOpeningSongbookKey] = useState(null);

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
    if (tab === 'youtube' || tab === 'youtube-playlist') lastYoutubeTabRef.current = tab;
    setActiveTab(tab);
    setSharedState(prev => ({ ...prev, activeIntegrationTab: tab }));
  };

  const openYoutubeSource = () => handleTabChange(lastYoutubeTabRef.current);

  const runYoutubeSearch = async (searchQuery) => {
    if (!searchQuery.trim()) return;

    const ytRegex = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;
    const match = searchQuery.match(ytRegex);
    if (match) {
      const videoId = match[1];
      onSelectResult({
        id: videoId,
        title: t('search.youtube.directTitle'),
        channelTitle: t('search.youtube.unknownChannel')
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
      window.alert(t('search.file.invalidType'));
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      window.alert(t('search.file.tooLarge'));
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

  const youtubeSelectionPayload = (video) => (
    pendingSongbookMatch
      ? {
        ...video,
        title: pendingSongbookMatch.title || video.title,
        source: pendingSongbookMatch.source,
        songbookId: pendingSongbookMatch.songbookId,
        tags: pendingSongbookMatch.tags || [],
        skipAiTitleExtraction: true
      }
      : video
  );

  const selectYoutubeResult = (video) => {
    onSelectResult(youtubeSelectionPayload(video));
    if (pendingSongbookMatch) setPendingSongbookMatch(null);
  };

  const beginSongDrag = (event, value) => {
    const candidate = normalizeSongDragCandidate(value);
    if (!candidate || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(SONG_DRAG_DATA_TYPE, candidate.id);
    onSongDragStart?.(candidate);
  };

  const endSongDrag = (event, clearPendingMatch = false) => {
    if (clearPendingMatch && event.dataTransfer?.dropEffect !== 'none') {
      setPendingSongbookMatch(null);
    }
    onSongDragEnd?.();
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
    const selectionKey = songbookCacheKey(platform, song.id);
    if (openingSongbookKey === selectionKey) return;
    setOpeningSongbookKey(selectionKey);
    if (cachedMr?.mrId) {
      setOpeningSongbookKey(null);
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
        setOpeningSongbookKey(null);
        stageSongbookMr(song, platform, cacheEntry.mrId, true, cacheEntry.title);
        return;
      }
    } catch {
      // A cache miss must fall through to the normal MR selection flow.
    }

    if (youtubeId) {
      setOpeningSongbookKey(null);
      stageSongbookMr(song, platform, youtubeId, platform === 'youtube-playlist' || Boolean(song.mrVerified));
      return;
    }
    setOpeningSongbookKey(null);
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
      if (!response.ok) throw new Error(t('search.import.error.setlinkFetch'));
      if (!Array.isArray(data.songs) || data.songs.length === 0) {
        throw new Error(t('search.import.error.setlinkEmpty'));
      }
      setSharedState((previous) => ({
        ...previous,
        setlinkSourceUrl: sourceUrl,
        setlinkCatalog: data.songs,
        setlinkCatalogMeta: data.source || null,
      }));
      setTempSetlinkUrl(sourceUrl);
    } catch (importError) {
      setCatalogImportError(importError.message || t('search.import.error.setlinkFetch'));
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
      if (!response.ok) throw new Error(t('search.import.error.youtubeFetch'));
      if (!Array.isArray(data.songs) || data.songs.length === 0) throw new Error(t('search.import.error.youtubeEmpty'));
      setSharedState((previous) => ({
        ...previous,
        youtubePlaylistSourceUrl: sourceUrl,
        youtubePlaylistCatalog: data.songs.map((song) => ({ ...song, rawTitle: song.title, title: '', titleStatus: 'pending' })),
        youtubePlaylistCatalogMeta: data.source || null
      }));
      setTempPlaylistUrl(sourceUrl);
      setPlaylistImportRun((run) => run + 1);
    } catch (importError) {
      setPlaylistImportError(importError.message || t('search.import.error.youtubeFetch'));
    } finally {
      setIsPlaylistLoading(false);
    }
  };

  const handleIntegrationDisconnect = (platform) => {
    if(window.confirm(t('search.import.disconnectConfirm'))) {
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
          <div
            key={v.id}
            className="result-item song-drag-source"
            style={{position:'relative'}}
            draggable
            data-song-drag-source={v.id}
            title={t('songDrag.sourceHint')}
            onDragStart={(event) => beginSongDrag(event, youtubeSelectionPayload(v))}
            onDragEnd={(event) => endSongDrag(event, Boolean(pendingSongbookMatch))}
          >
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
              <span className="song-drag-grip" title={t('songDrag.sourceHint')} aria-hidden="true">
                <GripVertical size={16} />
              </span>
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

      <div className="divider composer-import-divider">{t('search.file.divider')}</div>

      <div
        className="composer-file-import"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleFileDrop}
        title={t('search.file.selectTitle')}
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
        <span className="composer-file-import-label">{t('search.file.label')}</span>
        <span className="composer-file-import-help">{t('search.file.help')}</span>
        <span className="composer-file-import-action" aria-hidden="true">{t('search.file.action')}</span>
      </div>
    </>
  );

  const renderSongbook = (platform, hookData, localSearch, setLocalSearch, isConnected, idValue, setIdValue, emptyMessage) => {
    if (!isConnected) {
      const isMeloming = platform === 'meloming';
      const isPlaylist = platform === 'youtube-playlist';
      const inputValue = isMeloming ? idValue : isPlaylist ? tempPlaylistUrl : tempSetlinkUrl;
      const inputPlaceholder = isMeloming
        ? t('search.import.placeholder.meloming')
        : isPlaylist
          ? t('search.import.placeholder.youtubePlaylist')
          : t('search.import.placeholder.setlink');
      const submitImport = isMeloming ? () => handleIntegrationConnect('meloming', idValue) : isPlaylist ? () => handlePlaylistImport(tempPlaylistUrl) : () => handleSetlinkImport(tempSetlinkUrl);
      const sourceError = isPlaylist ? playlistImportError : catalogImportError;
      const isImporting = isPlaylist ? isPlaylistLoading : !isMeloming && isSetlinkLoading;
      const handleInputChange = isMeloming ? setIdValue : isPlaylist ? setTempPlaylistUrl : setTempSetlinkUrl;
      const sourceName = t(isMeloming
        ? 'search.import.source.meloming'
        : isPlaylist
          ? 'search.import.source.youtubePlaylist'
          : 'search.import.source.setlink');
      const sourceHelp = t(isMeloming
        ? 'search.import.help.meloming'
        : isPlaylist
          ? 'search.import.help.youtubePlaylist'
          : 'search.import.help.setlink');
      return (
        <section className="songbook-connect">
          {isMeloming ? <Music className="songbook-connect-icon" size={32} color="var(--eureka-emerald)" /> : <Link className="songbook-connect-icon" size={32} color="var(--eureka-azure)" />}
          <h3 className="songbook-connect-title">{t('search.import.addTitle', { source: sourceName })}</h3>
          <p className="songbook-connect-description">
            {t('search.import.description.attach')}<br/>
            {t('search.import.description.refresh')}
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
              {isImporting ? <><Loader2 className="spinner" size={16} /> {t('search.import.loading')}</> : t('search.import.action')}
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
    const storedSetlinkName = String(setlinkCatalogMeta?.name || '').trim();
    const setlinkUsesDefaultName = Boolean(setlinkCatalogMeta?.defaultName)
      || !storedSetlinkName
      || storedSetlinkName === 'Setlink 공개 목록'
      || storedSetlinkName === 'Setlink public list';
    const catalogName = platform === 'setlink'
      ? (setlinkUsesDefaultName ? t('search.import.source.setlink') : storedSetlinkName)
      : platform === 'youtube-playlist'
        ? t('search.import.source.youtubePlaylist')
        : (hookData.source?.name || t('search.import.source.meloming'));

    return (
      <section className="songbook-list" aria-label={t('search.songbook.listLabel')}>
        <div className="songbook-toolbar">
          <div className="songbook-summary" data-source={platform}>
            ✅ {t('search.songbook.summary', { name: catalogName, count: songs.length })}
            {platform === 'youtube-playlist' && playlistTitleProgress.total > 0 && (
              <span style={{marginLeft:'0.5rem', color: playlistTitleProgress.active ? 'var(--eureka-azure)' : 'var(--eureka-emerald)'}}>
                · {t('search.songbook.aiProgress', { completed: playlistTitleProgress.completed, total: playlistTitleProgress.total })}
              </span>
            )}
          </div>
          <div className="songbook-toolbar-actions">
            {platform === 'setlink' && setlinkSourceUrl && <button onClick={() => handleSetlinkImport(setlinkSourceUrl)} className="btn-icon" title={t('search.songbook.refresh.setlink')}><RefreshCw size={14} className={isSetlinkLoading ? 'spinner' : ''} /></button>}
            {platform === 'youtube-playlist' && youtubePlaylistSourceUrl && <button onClick={() => handlePlaylistImport(youtubePlaylistSourceUrl)} className="btn-icon" title={t('search.songbook.refresh.youtube')}><RefreshCw size={14} className={isPlaylistLoading ? 'spinner' : ''} /></button>}
            {platform !== 'setlink' && platform !== 'youtube-playlist' && <button onClick={refresh} className="btn-icon" title={t('search.songbook.refresh.general')}>
              <RefreshCw size={14} className={isLoading ? 'spinner' : ''} />
            </button>}
            <button onClick={() => handleIntegrationDisconnect(platform)} className="btn-icon btn-icon-danger" style={{fontSize:'0.75rem'}}>{t('search.songbook.disconnect')}</button>
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
            placeholder={t('search.songbook.filterPlaceholder')}
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
              {t('search.songbook.noMatch')}
            </div>
          )}
          {displaySongs.map(song => {
            const youtubeId = getYouTubeId(song.youtubeUrl);
            const cacheKey = songbookCacheKey(platform, song.id);
            const cachedMr = songbookMrCache[cacheKey];
            const isCheckingCache = cacheLookupKeys[cacheKey];
            const isOpening = openingSongbookKey === cacheKey;
            const hasLinkedMr = Boolean(cachedMr?.mrId || youtubeId);
            const hasSongbookMr = Boolean(youtubeId);
            const hasMrCandidate = hasLinkedMr || hasSongbookMr;
            const isTitleReady = platform !== 'youtube-playlist' || song.titleStatus === 'ready';
            const isTitleRetrying = retryingPlaylistTitleIds.has(song.sourceId || song.id);
            const canRetryTitle = platform === 'youtube-playlist' && song.titleStatus === 'error';
            const displayTitle = isTitleReady ? song.title : t(song.titleStatus === 'error'
              ? 'search.songbook.titleFailed'
              : 'search.songbook.titlePending');
            const pendingActionLabel = t(song.titleStatus === 'error'
              ? 'search.songbook.action.titleFailed'
              : 'search.songbook.action.titlePending');
            const primaryActionLabel = t(hasMrCandidate
              ? 'search.songbook.action.checkMr'
              : 'search.songbook.action.findMr');
            const mrStateLabel = hasLinkedMr
              ? t('search.songbook.mr.linked')
              : isCheckingCache
                ? t('search.songbook.mr.checking')
                : t('search.songbook.mr.missing');
            const songbookDragCandidate = isTitleReady && hasMrCandidate
              ? normalizeSongDragCandidate({
                  id: cachedMr?.mrId || youtubeId,
                  title: cachedMr?.title || song.title,
                  channelTitle: song.artist,
                  tags: song.tags,
                  source: platform,
                  songbookId: song.id,
                  skipAiTitleExtraction: true,
                  mrVerified: Boolean(cachedMr?.mrId || platform === 'youtube-playlist' || song.mrVerified),
                })
              : null;
            return (
            <div
              key={song.id}
              className={`result-item songbook-item${songbookDragCandidate ? ' song-drag-source' : ''}`}
              draggable={Boolean(songbookDragCandidate)}
              data-song-drag-source={songbookDragCandidate?.id || undefined}
              title={songbookDragCandidate ? t('songDrag.sourceHint') : undefined}
              onDragStart={songbookDragCandidate
                ? (event) => beginSongDrag(event, songbookDragCandidate)
                : undefined}
              onDragEnd={songbookDragCandidate ? (event) => endSongDrag(event) : undefined}
            >
              <button
                type="button"
                className="songbook-copy"
                onClick={() => selectSongbookSong(song, platform, youtubeId, cachedMr)}
                disabled={!isTitleReady || isOpening}
                aria-busy={isOpening || undefined}
                aria-label={t('search.songbook.select', { title: displayTitle })}
              >
                <div className={`songbook-title ${isTitleReady ? '' : 'is-pending'}`}>{displayTitle}</div>
                <div className="songbook-artist">{song.artist}</div>
                {song.tags && song.tags.length > 0 && (
                  <div className="songbook-tags">
                    {song.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
                <div className={`songbook-mr-state ${hasLinkedMr ? 'is-linked' : ''}`}>
                  {mrStateLabel}
                </div>
                {isTitleReady && (
                  <span className="songbook-select-hint">
                    {isOpening
                      ? <><Loader2 size={13} className="spinner" aria-hidden="true" /> {t('search.songbook.opening')}</>
                      : <>{t('search.songbook.selectHint')} <ChevronRight size={14} aria-hidden="true" /></>}
                  </span>
                )}
              </button>
              {songbookDragCandidate && (
                <span className="song-drag-grip songbook-drag-grip" title={t('songDrag.sourceHint')} aria-hidden="true">
                  <GripVertical size={16} />
                </span>
              )}
              <div className="songbook-actions">
                {canRetryTitle ? (
                  <button
                    className="songbook-retry-action"
                    onClick={() => retryPlaylistTitle(song)}
                    disabled={isTitleRetrying}
                    title={t('search.songbook.action.retryTitleTitle')}
                  >
                    <RefreshCw size={13} className={isTitleRetrying ? 'spinner' : ''} /> {t('search.songbook.action.retryTitle')}
                  </button>
                ) : (
                  <button
                    className="btn-primary songbook-action-primary"
                    onClick={() => selectSongbookSong(song, platform, youtubeId, cachedMr)}
                    disabled={!isTitleReady || isOpening}
                  >
                    {isOpening
                      ? <><Loader2 className="spinner" size={14}/>{t('search.songbook.opening')}</>
                      : isTitleReady
                        ? (hasMrCandidate ? <><Music size={14}/>{primaryActionLabel}</> : <><Search size={14}/>{primaryActionLabel}</>)
                        : pendingActionLabel}
                  </button>
                )}
                {hasMrCandidate && isTitleReady && (
                  <button
                    className="btn-secondary songbook-action-secondary"
                    onClick={() => startSongbookMrSearch(song, platform)}
                  >
                    {t('search.songbook.action.findAnotherMr')}
                  </button>
                )}
                {platform !== 'youtube-playlist' && (
                  <button
                    className="songbook-file-action"
                    onClick={() => chooseSongbookUpload(song, platform)}
                    title={t('search.songbook.action.localFileTitle')}
                  >
                    <FileUp size={14} /> {t('search.songbook.action.localFile')}
                  </button>
                )}
              </div>
            </div>
            );
          })}
          {filteredSongs.length > 100 && (
             <div style={{textAlign:'center', fontSize:'0.8rem', color:'var(--text-muted)', padding:'1rem 0'}}>
               {t('search.songbook.limit')}
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
          aria-label={t('search.source.label')}
          data-source-tab-count="3"
        >
          <button
            type="button"
            className={`tab-btn source-tab ${['youtube', 'youtube-playlist'].includes(activeTab) ? 'active' : ''}`}
            data-source="youtube"
            aria-pressed={['youtube', 'youtube-playlist'].includes(activeTab)}
            title={t('search.tab.youtube')}
            onClick={openYoutubeSource}
          >
            <Search size={14} aria-hidden="true" />
            <span className="source-tab-label">{t('search.tab.youtube')}</span>
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
        {['youtube', 'youtube-playlist'].includes(activeTab) && (
          <section className="youtube-source-workspace" aria-label={t('search.tab.youtube')}>
            <div className="youtube-mode-switch" role="tablist" aria-label={t('search.youtube.mode.label')}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'youtube'}
                className={activeTab === 'youtube' ? 'is-active' : ''}
                onClick={() => handleTabChange('youtube')}
              >
                <Search size={14} aria-hidden="true" /> {t('search.youtube.mode.search')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'youtube-playlist'}
                className={activeTab === 'youtube-playlist' ? 'is-active' : ''}
                onClick={() => handleTabChange('youtube-playlist')}
              >
                <ListVideo size={14} aria-hidden="true" /> {t('search.youtube.mode.playlist')}
              </button>
            </div>
            {activeTab === 'youtube' ? renderYoutubeTab() : renderSongbook(
              'youtube-playlist',
              { ...playlist, isLoading: isPlaylistLoading, error: playlistImportError || playlist.error, refresh: () => handlePlaylistImport(youtubePlaylistSourceUrl) },
              playlistSearch,
              setPlaylistSearch,
              youtubePlaylistCatalog.length > 0,
              '',
              () => {},
              t('search.songbook.empty.youtubePlaylist')
            )}
          </section>
        )}
        {activeTab === 'meloming' && renderSongbook(
          'meloming', 
          melo, 
          meloSearch, 
          setMeloSearch, 
          melomingChannelId, 
          tempMeloId, 
          setTempMeloId, 
          t('search.songbook.empty.meloming')
        )}
        {activeTab === 'setlink' && renderSongbook(
          'setlink', 
          { ...setlink, isLoading: isSetlinkLoading, error: catalogImportError || setlink.error, refresh: () => handleSetlinkImport(setlinkSourceUrl) },
          setlinkSearch, 
          setSetlinkSearch, 
          setlinkCatalog.length > 0,
          '',
          () => {},
          t('search.songbook.empty.setlink')
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
