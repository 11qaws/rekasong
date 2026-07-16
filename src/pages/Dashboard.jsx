import React, { useState, useRef, useEffect, useMemo } from 'react';
import YouTube from 'react-youtube';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import { useAiTitleExtraction } from '../hooks/useAiTitleExtraction';
import { useOnAirSession } from '../hooks/useOnAirSession';
import { apiUrl } from '../lib/api';
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js';

import PlaybackPanel from '../components/PlaybackPanel';
import QueuePanel from '../components/QueuePanel';
import SongComposer from '../components/SongComposer';
import ErrorBoundary from '../components/ErrorBoundary';
import './Dashboard.css';

const songbookCacheKey = (source, songbookId) => `${source}:${songbookId}`;

const toDisplaySong = (song) => {
  if (!song?.id || !song?.title) return null;
  const type = song.type === 'youtube' ? 'youtube' : 'local';
  return {
    id: String(song.id),
    title: String(song.title),
    type,
    src: type === 'youtube' ? String(song.src || '') : '',
    tags: Array.isArray(song.tags) ? song.tags : []
  };
};

const toDisplayState = (state) => ({
  currentSong: toDisplaySong(state?.currentSong),
  history: Array.isArray(state?.history) ? state.history.map(toDisplaySong).filter(Boolean).slice(-100) : []
});

export default function Dashboard() {
  useEffect(() => {
    document.body.classList.add('dashboard-page');
    return () => document.body.classList.remove('dashboard-page');
  }, []);

  const [state, setSharedState] = useSyncState();
  const currentSong = state?.currentSong;
  const history = useMemo(() => Array.isArray(state?.history) ? state.history : [], [state?.history]);
  const onAirEventHandlerRef = useRef(null);
  const onAir = useOnAirSession((payload) => onAirEventHandlerRef.current?.(payload));
  const useOnAirPlayer = onAir.configured;
  const onAirDisplayToken = onAir.session?.displayToken;
  const onAirConnectionState = onAir.connectionState;
  const sendOnAirCommand = onAir.sendCommand;
  
  const [activeVideoId, setActiveVideoId] = useState('');
  const [localAudioSrc, setLocalAudioSrc] = useState(null);
  
  // Audio Controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('rekasong_volume');
    const parsed = parseInt(saved, 10);
    return !isNaN(parsed) ? parsed : 100;
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const ytPlayerRef = useRef(null);
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  const handlePlayNextRef = useRef(null);
  const togglePlaybackRef = useRef(null);
  const activeSongIdRef = useRef(null);
  const reportedMediaIssueRef = useRef(null);
  const reportedDelayRef = useRef(null);

  // Sync volume to players
  useEffect(() => {
    if (!useOnAirPlayer) {
      if (ytPlayerRef.current && ytPlayerRef.current.setVolume) ytPlayerRef.current.setVolume(volume);
      if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
      if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    }
    localStorage.setItem('rekasong_volume', volume);
  }, [volume, useOnAirPlayer]);

  // Sync play/pause to players
  useEffect(() => {
    if (useOnAirPlayer) return;
    if (isPlaying) {
      if (ytPlayerRef.current && ytPlayerRef.current.playVideo) ytPlayerRef.current.playVideo();
      if (audioRef.current) audioRef.current.play().catch(()=>console.log("Play interrupted"));
      if (videoRef.current) videoRef.current.play().catch(()=>console.log("Play interrupted"));
    } else {
      if (ytPlayerRef.current && ytPlayerRef.current.pauseVideo) ytPlayerRef.current.pauseVideo();
      if (audioRef.current) audioRef.current.pause();
      if (videoRef.current) videoRef.current.pause();
    }
  }, [isPlaying, useOnAirPlayer]);

  useEffect(() => {
    activeSongIdRef.current = currentSong?.id || null;
    reportedMediaIssueRef.current = null;
    reportedDelayRef.current = null;

    if (useOnAirPlayer) return;
    if (!currentSong) {
      setIsPlaying(false);
      setActiveVideoId('');
      setLocalAudioSrc(null);
    } else if (currentSong.type === 'youtube') {
      setActiveVideoId(currentSong.src);
      setLocalAudioSrc(null);
    } else if (currentSong.type === 'local') {
      setActiveVideoId('');
      setLocalAudioSrc(currentSong.src);
    }
  }, [currentSong, useOnAirPlayer]);

  // Clean up ObjectURLs to prevent memory leaks
  useEffect(() => {
    if (useOnAirPlayer) return undefined;
    return () => {
      if (localAudioSrc && localAudioSrc.startsWith('blob:')) {
        URL.revokeObjectURL(localAudioSrc);
      }
    };
  }, [localAudioSrc, useOnAirPlayer]);

  useEffect(() => {
    if (useOnAirPlayer) return undefined;
    let interval;
    if (isPlaying) {
      interval = setInterval(() => {
        if (ytPlayerRef.current && ytPlayerRef.current.getCurrentTime) {
          const ct = ytPlayerRef.current.getCurrentTime();
          const dur = ytPlayerRef.current.getDuration();
          if (ct) setCurrentTime(ct);
          if (dur) setDuration(dur);
        }
        if (audioRef.current) {
          setCurrentTime(audioRef.current.currentTime);
          setDuration(audioRef.current.duration || 0);
        }
        if (videoRef.current) {
          setCurrentTime(videoRef.current.currentTime);
          setDuration(videoRef.current.duration || 0);
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isPlaying, activeVideoId, localAudioSrc, useOnAirPlayer]);

  const handleSeek = (time) => {
    if (useOnAirPlayer) {
      try {
        onAir.sendCommand({ type: 'seek', sessionId: currentSong?.id, position: time });
        setCurrentTime(time);
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }
    if (ytPlayerRef.current && ytPlayerRef.current.seekTo) {
      ytPlayerRef.current.seekTo(time, true);
    }
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  const [stagedItem, setStagedItem] = useState(null);
  const {
    aiStatusMessage,
    cancelAiExtraction,
    isAiLoading,
    runAiExtractionStream,
    setAiStatus
  } = useAiTitleExtraction(setStagedItem);
  
  // Toast notifications
  const [toasts, setToasts] = useState([]);
  const dismissToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  const showToast = (message, type = 'info', action = null) => {
    const id = Date.now().toString() + '-' + Math.random().toString(36).slice(2, 7);
    setToasts(prev => [...prev, { id, message, type, action }]);
    setTimeout(() => dismissToast(id), action ? 5000 : 3000);
  };
  
  const [room] = useState(() => getOrCreateRoom());
  const [signingKeys, setSigningKeys] = useState(null);

  useEffect(() => {
    if (!signingKeys) {
      getOrCreateSigningKeys().then(setSigningKeys).catch(() => {});
    }
  }, [signingKeys]);

  // Update remote widget when state changes
  useEffect(() => {
    if (room && signingKeys) {
      const payload = { state, timestamp: Date.now() };
      publishSync(payload, room, signingKeys.privateKey);
    }
  }, [state, room, signingKeys]);

  useEffect(() => {
    if (!useOnAirPlayer || !onAirDisplayToken || onAirConnectionState !== 'connected') return;
    try {
      sendOnAirCommand({ type: 'display_state', display: toDisplayState({ currentSong, history }) });
    } catch {
      // The player/session reconnect path will publish the latest display state.
    }
  }, [currentSong, history, onAirDisplayToken, onAirConnectionState, sendOnAirCommand, useOnAirPlayer]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      // Ignore if typing in an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (currentSong) {
          togglePlaybackRef.current?.();
        }
      } else if (e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault();
        handlePlayNextRef.current?.();
        showToast('다음 곡으로 스킵', 'info');
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [currentSong, isPlaying]);

  const handleSelectSearchResult = (video) => {
    const replacedStagedItem = Boolean(stagedItem);
    cancelAiExtraction();
    const stagingId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStagedItem({
      stagingId,
      type: 'youtube',
      src: video.id,
      title: video.title,
      artist: video.channelTitle,
      tags: video.tags || [],
      source: video.source || 'youtube',
      songbookId: video.songbookId || null,
      skipAiTitleExtraction: Boolean(video.skipAiTitleExtraction),
      mrVerified: Boolean(video.mrVerified)
    });
    showToast(
      replacedStagedItem ? '선택한 곡으로 바꾸었습니다. 2단계에서 정보를 확인하세요.' : '2단계에서 곡 정보와 재생 대상을 확인하세요.',
      'info'
    );
    if (video.skipAiTitleExtraction) {
      setAiStatus('노래책에 등록된 곡명을 그대로 사용합니다.');
    } else if (video.id) {
      runAiExtractionStream(apiUrl(`/api/extract-title?id=${video.id}`), {}, stagingId);
    }
  };

  const handleRetryAiExtraction = () => {
    if (!stagedItem?.stagingId) return;
    if (stagedItem.type === 'youtube' && stagedItem.src) {
      runAiExtractionStream(apiUrl(`/api/extract-title?id=${stagedItem.src}&refresh=1`), {}, stagedItem.stagingId, { overwriteTitle: true });
      return;
    }
    if (stagedItem.type === 'local' && stagedItem.file) {
      runAiExtractionStream(apiUrl('/api/extract-local'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: stagedItem.file.name, metadata: {}, cacheKey: stagedItem.localCacheKey || '', forceRefresh: true })
      }, stagedItem.stagingId, { overwriteTitle: true });
    }
  };

  const handleLocalFileDrop = (file, songbookContext = null) => {
    cancelAiExtraction();
    const url = URL.createObjectURL(file);
    const stagingId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStagedItem({
      stagingId,
      type: 'local',
      src: url,
      mediaType: file.type === 'video/mp4' ? 'video' : 'audio',
      title: songbookContext?.title || file.name,
      artist: songbookContext?.artist || '',
      tags: songbookContext?.tags || [],
      source: songbookContext?.source || 'local',
      songbookId: songbookContext?.songbookId || null,
      skipAiTitleExtraction: Boolean(songbookContext),
      file: file,
      localCacheKey: `${file.name}:${file.size}:${file.lastModified}`,
      assetStatus: useOnAirPlayer ? 'uploading' : 'local',
      assetProgress: useOnAirPlayer ? 0 : null,
      assetId: null
    });
    showToast('로컬 파일을 불러왔습니다. 2단계에서 정보를 확인하세요.', 'info');

    if (useOnAirPlayer) {
      onAir.uploadAsset(file, (assetProgress) => {
        setStagedItem((previous) => previous?.stagingId === stagingId ? { ...previous, assetProgress } : previous);
      }).then((asset) => {
        setStagedItem((previous) => previous?.stagingId === stagingId
          ? { ...previous, assetId: asset.assetId, assetStatus: 'ready', assetProgress: 100 }
          : previous);
      }).catch((error) => {
        setStagedItem((previous) => previous?.stagingId === stagingId
          ? { ...previous, assetStatus: 'error', assetError: error.message }
          : previous);
        showToast(error.message || '방송용 로컬 파일을 준비하지 못했습니다.', 'error');
      });
    }

    let metadata = {};
    // Try parsing tags for better alias
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title && !songbookContext) {
          metadata = tag.tags;
          setStagedItem(prev => {
            if (!prev || prev.stagingId !== stagingId) return prev;
            return {
              ...prev,
              title: prev.isTitleEdited ? prev.title : tag.tags.title,
              artist: prev.isArtistEdited ? prev.artist : (tag.tags.artist || '')
            };
          });
        }
        
        if (songbookContext) {
          setAiStatus('노래책에 등록된 곡명을 그대로 사용합니다.');
          return;
        }
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata, cacheKey: `${file.name}:${file.size}:${file.lastModified}` })
        }, stagingId);
      },
      onError: (error) => {
        console.log('No ID3 tags found:', error.type);
        if (songbookContext) {
          setAiStatus('노래책에 등록된 곡명을 그대로 사용합니다.');
          return;
        }
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata, cacheKey: `${file.name}:${file.size}:${file.lastModified}` })
        }, stagingId);
      }
    });
  };

  const handleAliasChange = (field, value) => {
    setStagedItem(prev => prev ? ({
      ...prev,
      [field]: value,
      ...(field === 'title' ? { isTitleEdited: true } : {}),
      ...(field === 'artist' ? { isArtistEdited: true } : {})
    }) : prev);
  };

  const handleClearStaged = () => {
    cancelAiExtraction();
    setAiStatus('');
    setStagedItem((previous) => {
      if (previous?.type === 'local' && previous.src?.startsWith('blob:')) URL.revokeObjectURL(previous.src);
      return null;
    });
    showToast('선택한 곡을 취소했습니다.', 'info');
  };

  const playAudioForSong = (song, { stoppingSongId } = {}) => {
    setCurrentTime(0);
    setDuration(0);
    if (useOnAirPlayer) {
      if (!song) {
        onAir.sendCommand({ type: 'stop', sessionId: stoppingSongId || currentSong?.id });
        setIsPlaying(false);
        return;
      }
      onAir.sendCommand({
        type: 'load',
        sessionId: song.id,
        song,
        position: 0,
        volume
      });
      return;
    }

    if (!song) {
      setIsPlaying(false);
      setActiveVideoId('');
      setLocalAudioSrc(null);
      return;
    }
    setIsPlaying(true); // 항상 새 곡은 재생 상태로 시작
    if (song.type === 'youtube') {
      setActiveVideoId(song.src);
      setLocalAudioSrc(null);
    } else if (song.type === 'local') {
      setActiveVideoId('');
      setLocalAudioSrc(song.src);
    }
  };

  const handleGoLive = (insertAtTop = false) => {
    if (!stagedItem) return;
    if (useOnAirPlayer && onAir.connectionState !== 'connected') {
      showToast('OBS On-Air 위젯이 연결된 뒤 방송 재생을 시작할 수 있습니다.', 'error');
      return;
    }
    if (useOnAirPlayer && stagedItem.type === 'local' && !stagedItem.assetId) {
      showToast(stagedItem.assetError || '방송용 로컬 파일을 준비 중입니다.', 'info');
      return;
    }

    const newSong = {
      id: Date.now().toString(),
      type: stagedItem.type,
      title: stagedItem.title,
      artist: stagedItem.artist,
      src: useOnAirPlayer && stagedItem.type === 'local' ? stagedItem.assetId : stagedItem.src,
      assetId: useOnAirPlayer && stagedItem.type === 'local' ? stagedItem.assetId : undefined,
      mediaType: stagedItem.mediaType || 'audio',
      tags: stagedItem.tags || [],
      source: stagedItem.source || 'youtube',
      songbookId: stagedItem.songbookId || null
    };

    const cacheEntries = [];
    if (newSong.type === 'youtube' && newSong.src) cacheEntries.push({ kind: 'youtube', id: newSong.src, mrId: newSong.src });
    if (newSong.source !== 'youtube' && newSong.songbookId && newSong.type === 'youtube' && newSong.src) {
      cacheEntries.push({
        kind: `songbook:${newSong.source}`,
        id: newSong.songbookId,
        songbookId: newSong.songbookId,
        mrId: newSong.src,
        mrKind: 'youtube',
        persistent: true
      });
    }
    if (newSong.type === 'local' && stagedItem.localCacheKey) cacheEntries.push({ kind: 'local', id: stagedItem.localCacheKey });
    if (cacheEntries.length) {
      fetch(apiUrl('/api/title-cache'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newSong.title, entries: cacheEntries })
      }).catch(() => {});
    }

    const confirmedSongbookMr = newSong.type === 'youtube' && newSong.source !== 'youtube' && newSong.songbookId
      ? {
          [songbookCacheKey(newSong.source, newSong.songbookId)]: {
            title: newSong.title,
            mrId: newSong.src,
            mrKind: 'youtube',
            updatedAt: Date.now(),
            verifiedAt: Date.now(),
            source: 'streamer-confirmed'
          }
        }
      : null;

    setSharedState(prev => {
      const songbookMrCache = confirmedSongbookMr
        ? { ...(prev.songbookMrCache || {}), ...confirmedSongbookMr }
        : prev.songbookMrCache;
      // If nothing is playing, play immediately
      if (!prev.currentSong) {
        playAudioForSong(newSong);
        showToast('새 곡의 재생을 시작합니다.', 'success');
        return { ...prev, songbookMrCache, currentSong: newSong };
      }
      // Otherwise add to queue
      const q = prev.queue || [];
      showToast(insertAtTop ? '대기열 최상단에 곡이 예약되었습니다.' : '대기열 끝에 곡이 예약되었습니다.', 'info');
      return {
        ...prev,
        songbookMrCache,
        queue: insertAtTop ? [newSong, ...q] : [...q, newSong]
      };
    });

    cancelAiExtraction();
    setStagedItem((previous) => {
      if (useOnAirPlayer && previous?.type === 'local' && previous.src?.startsWith('blob:')) URL.revokeObjectURL(previous.src);
      return null;
    });
  };

  const handlePlayNext = (expectedSongId = null) => {
    const current = state?.currentSong;
    if (!current || (expectedSongId && current.id !== expectedSongId)) return;

    const queuedSongs = state?.queue || [];
    const nextSong = queuedSongs[0] || null;

    try {
      // Keep player I/O outside React's state updater. A failed WebSocket
      // command must not leave the UI looking as if it skipped successfully.
      playAudioForSong(nextSong, { stoppingSongId: current.id });
    } catch (error) {
      showToast(error.message || '다음 곡으로 넘기지 못했습니다.', 'error');
      return;
    }

    setSharedState((previous) => {
      // Ignore duplicate clicks or a stale end event after the current song
      // has already changed.
      if (previous.currentSong?.id !== current.id) return previous;

      const queue = previous.queue || [];
      const actualNextSong = queue[0] || null;
      const history = [...(previous.history || []), current];
      return {
        ...previous,
        currentSong: actualNextSong,
        queue: actualNextSong ? queue.slice(1) : queue,
        history
      };
    });
  };

  const handlePlayQueuedSong = (songId) => {
    const selectedSong = (state?.queue || []).find((song) => song.id === songId);
    if (!selectedSong) return;

    const current = state?.currentSong || null;
    try {
      playAudioForSong(selectedSong, { stoppingSongId: current?.id });
    } catch (error) {
      showToast(error.message || '선택한 대기열 곡을 재생하지 못했습니다.', 'error');
      return;
    }

    setSharedState((previous) => {
      const queue = previous.queue || [];
      const selectedIndex = queue.findIndex((song) => song.id === songId);
      if (selectedIndex < 0) return previous;

      const nextCurrent = queue[selectedIndex];
      return {
        ...previous,
        currentSong: nextCurrent,
        queue: queue.filter((song) => song.id !== songId),
        history: previous.currentSong ? [...(previous.history || []), previous.currentSong] : (previous.history || [])
      };
    });
  };

  handlePlayNextRef.current = handlePlayNext;

  const handleTogglePlayback = () => {
    if (!currentSong) return;
    if (useOnAirPlayer) {
      try {
        onAir.sendCommand({ type: isPlaying ? 'pause' : 'play', sessionId: currentSong.id });
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }
    setIsPlaying((previous) => !previous);
  };

  const handleVolumeChange = (nextVolume) => {
    const clamped = Math.max(0, Math.min(100, Number(nextVolume) || 0));
    setVolume(clamped);
    if (useOnAirPlayer && currentSong) {
      try {
        onAir.sendCommand({ type: 'volume', sessionId: currentSong.id, volume: clamped });
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
  };

  const handleEndBroadcastSession = () => {
    if (!useOnAirPlayer) {
      setSharedState((previous) => ({ ...previous, currentSong: null, queue: [], history: [] }));
      setIsPlaying(false);
      return;
    }
    try {
      onAir.sendCommand({ type: 'end_session' });
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  const handlePlaybackDelay = (songId, source) => {
    if (!songId || activeSongIdRef.current !== songId || reportedDelayRef.current === songId) return;
    reportedDelayRef.current = songId;
    showToast(source + ' 재생이 지연되고 있습니다. 잠시 기다리거나 스킵으로 다음 곡을 재생하세요.', 'info');
  };

  const handleMediaFailure = (songId, source, detail = '') => {
    if (!songId || activeSongIdRef.current !== songId || reportedMediaIssueRef.current === songId) return;
    reportedMediaIssueRef.current = songId;
    const reason = detail ? ' (' + detail + ')' : '';
    showToast(source + '을(를) 재생할 수 없습니다' + reason + '. 현재 곡만 건너뜁니다.', 'error');
    setTimeout(() => handlePlayNextRef.current?.(songId), 400);
  };

  const handleRemoveFromQueue = (songId) => {
    const queue = state?.queue || [];
    const removedIndex = queue.findIndex(song => song.id === songId);
    const removedSong = queue[removedIndex];

    if (!removedSong) return;

    setSharedState(prev => ({
      ...prev,
      queue: (prev.queue || []).filter(song => song.id !== songId)
    }));

    showToast('“' + removedSong.title + '”을 대기열에서 제거했습니다.', 'info', {
      label: '되돌리기',
      onClick: () => {
        setSharedState(prev => {
          const currentQueue = prev.queue || [];
          if (currentQueue.some(song => song.id === removedSong.id)) return prev;

          const restoredQueue = [...currentQueue];
          restoredQueue.splice(Math.min(removedIndex, restoredQueue.length), 0, removedSong);
          return { ...prev, queue: restoredQueue };
        });
      }
    });
  };

  const onLivePlayerReady = (event) => {
    ytPlayerRef.current = event.target;
    event.target.setVolume(volume);
    if (isPlaying) event.target.playVideo();
  };

  const onLivePlayerEnd = (expectedSongId) => {
    if (!expectedSongId || activeSongIdRef.current !== expectedSongId) return;

    setSharedState(prev => {
      if (prev.currentSong?.id !== expectedSongId) return prev;

      const current = prev.currentSong;
      const history = current ? [...(prev.history || []), current] : prev.history || [];
      const queue = prev.queue || [];

      if (prev.autoPlayNext && queue.length > 0) {
        const nextSong = queue[0];
        playAudioForSong(nextSong);
        return { ...prev, currentSong: nextSong, queue: queue.slice(1), history };
      }

      setIsPlaying(false);
      playAudioForSong(null);
      return { ...prev, currentSong: null, history };
    });
  };

  togglePlaybackRef.current = handleTogglePlayback;
  onAirEventHandlerRef.current = (payload) => {
    if (payload.type === 'snapshot' || payload.type === 'transport') {
      const remoteTransport = payload.transport || {};
      if (remoteTransport.song?.id) {
        setSharedState((previous) => {
          if (previous.currentSong?.id === remoteTransport.song.id) return previous;
          return { ...previous, currentSong: remoteTransport.song };
        });
      }
      if (Number.isFinite(remoteTransport.position)) setCurrentTime(remoteTransport.position);
      if (Number.isFinite(remoteTransport.duration)) setDuration(remoteTransport.duration);
      setIsPlaying(remoteTransport.status === 'playing' || remoteTransport.status === 'buffering' || remoteTransport.status === 'loading');
    }
    if (payload.type === 'player_event') {
      const event = payload.event || {};
      const remoteTransport = payload.transport || {};
      if (Number.isFinite(remoteTransport.position)) setCurrentTime(remoteTransport.position);
      if (Number.isFinite(event.duration)) setDuration(event.duration);
      if (event.type === 'playing') setIsPlaying(true);
      if (event.type === 'paused' || event.type === 'ended' || event.type === 'error') setIsPlaying(false);
      if (event.type === 'buffering') handlePlaybackDelay(event.sessionId, 'On-Air 위젯');
      if (event.type === 'ended') onLivePlayerEnd(event.sessionId);
      if (event.type === 'error') handleMediaFailure(event.sessionId, 'On-Air 위젯', event.message || '재생 오류');
    }
    if (payload.type === 'session_ended') {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setSharedState((previous) => ({ ...previous, currentSong: null, queue: [], history: [] }));
      showToast('방송 세션을 종료하고 임시 파일 정리를 예약했습니다.', 'info');
    }
  };

  return (
    <div className={`dashboard-container ${stagedItem ? 'staging-active' : ''}`}>
      <header className="dashboard-header">
        <h1 className="logo">Rekasong</h1>
        <p className="subtitle">방송용 노래 검색 · 재생 · OBS 위젯 제어</p>
      </header>

      <div className="dashboard-grid">
        <div className="playback-area">
        <ErrorBoundary>
          <PlaybackPanel
            room={room}
            publicKeyB64={signingKeys?.publicKeyB64}
            currentSong={state?.currentSong}
            onSkip={handlePlayNext}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlayback}
            volume={volume}
            onVolumeChange={handleVolumeChange}
            currentTime={currentTime}
            duration={duration}
            onSeek={handleSeek}
            setSharedState={setSharedState}
            showToast={showToast}
            onAirPlayerUrl={onAir.playerUrl}
            onAirDisplayUrl={onAir.displayUrl}
            onAirStatus={onAir.connectionState}
            onPrepareOnAir={onAir.preparePlayer}
            onPrepareOnAirDisplay={onAir.prepareDisplay}
            onEndBroadcastSession={handleEndBroadcastSession}
          />
        </ErrorBoundary>
        </div>
        <div className="queue-area">
          <ErrorBoundary>
            <QueuePanel
              queue={state?.queue || []}
              history={state?.history || []}
              onPlayQueueItem={handlePlayQueuedSong}
              onRemoveFromQueue={handleRemoveFromQueue}
              autoPlayNext={Boolean(state?.autoPlayNext)}
              setSharedState={setSharedState}
            />
          </ErrorBoundary>
        </div>
        <div className="composer-area">
          <ErrorBoundary>
            <SongComposer
              stagedItem={stagedItem}
              searchProps={{
                onSelectResult: handleSelectSearchResult,
                onLocalFileDrop: handleLocalFileDrop,
                sharedState: state || {},
                setSharedState,
                showToast
              }}
              stagingProps={{
                onAliasChange: handleAliasChange,
                onGoLive: handleGoLive,
                onClearStaged: handleClearStaged,
                hasCurrentSong: Boolean(state?.currentSong),
                isAiLoading,
                aiStatusMessage,
                onRetryAiExtraction: handleRetryAiExtraction,
                showToast
              }}
            />
          </ErrorBoundary>
        </div>
      </div>

      {/* Toast Notifications Container */}
      <div className="toast-container" aria-live="polite" aria-atomic="false">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action.onClick();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Hidden Live Players */}
      <div className="live-players-hidden">
        {activeVideoId && (
          <YouTube 
            key={activeVideoId + '-' + (currentSong?.id || '')}
            videoId={activeVideoId} 
            opts={{ width: '200', height: '112', playerVars: { autoplay: 1 } }} 
            onReady={onLivePlayerReady}
            onEnd={() => onLivePlayerEnd(currentSong?.id)}
            onStateChange={(event) => {
              if (event.data === 3) handlePlaybackDelay(currentSong?.id, 'YouTube');
            }}
            onError={(e) => {
              console.error("YouTube Player Error:", e.data);
              const details = {
                2: '영상 주소가 올바르지 않음',
                5: '브라우저 재생을 지원하지 않음',
                100: '영상이 삭제되었거나 비공개임',
                101: '외부 재생이 허용되지 않음',
                150: '외부 재생이 허용되지 않음'
              };
              handleMediaFailure(currentSong?.id, 'YouTube', details[e.data] || '알 수 없는 재생 오류');
            }}
          />
        )}
        {localAudioSrc && currentSong?.mediaType === 'video' && (
          <video
            ref={videoRef}
            src={localAudioSrc}
            autoPlay
            playsInline
            onEnded={() => onLivePlayerEnd(currentSong?.id)}
            onWaiting={() => handlePlaybackDelay(currentSong?.id, '로컬 영상')}
            onError={() => handleMediaFailure(currentSong?.id, '로컬 영상', 'MP4 재생 오류')}
          />
        )}
        {localAudioSrc && currentSong?.mediaType !== 'video' && (
          <audio
            ref={audioRef}
            src={localAudioSrc}
            autoPlay
            onEnded={() => onLivePlayerEnd(currentSong?.id)}
            onWaiting={() => handlePlaybackDelay(currentSong?.id, '로컬 음원')}
            onError={() => {
              const errorCode = audioRef.current?.error?.code;
              const details = {
                1: '가져오기가 중단됨',
                2: '파일을 읽을 수 없음',
                3: '음원 형식이 손상되었거나 지원되지 않음',
                4: '브라우저가 이 형식을 지원하지 않음'
              };
              handleMediaFailure(currentSong?.id, '로컬 음원', details[errorCode] || '읽기 오류');
            }}
          />
        )}
      </div>
    </div>
  );
}
