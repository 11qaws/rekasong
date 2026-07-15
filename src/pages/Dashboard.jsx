import React, { useState, useRef, useEffect } from 'react';
import YouTube from 'react-youtube';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import { useAiTitleExtraction } from '../hooks/useAiTitleExtraction';
import { apiUrl } from '../lib/api';
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js';

import PlaybackPanel from '../components/PlaybackPanel';
import QueuePanel from '../components/QueuePanel';
import SongComposer from '../components/SongComposer';
import ErrorBoundary from '../components/ErrorBoundary';
import './Dashboard.css';

export default function Dashboard() {
  const [state, setSharedState] = useSyncState();
  const currentSong = state?.currentSong;
  
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
  const activeSongIdRef = useRef(null);
  const reportedMediaIssueRef = useRef(null);
  const reportedDelayRef = useRef(null);

  // Sync volume to players
  useEffect(() => {
    if (ytPlayerRef.current && ytPlayerRef.current.setVolume) ytPlayerRef.current.setVolume(volume);
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    localStorage.setItem('rekasong_volume', volume);
  }, [volume]);

  // Sync play/pause to players
  useEffect(() => {
    if (isPlaying) {
      if (ytPlayerRef.current && ytPlayerRef.current.playVideo) ytPlayerRef.current.playVideo();
      if (audioRef.current) audioRef.current.play().catch(()=>console.log("Play interrupted"));
      if (videoRef.current) videoRef.current.play().catch(()=>console.log("Play interrupted"));
    } else {
      if (ytPlayerRef.current && ytPlayerRef.current.pauseVideo) ytPlayerRef.current.pauseVideo();
      if (audioRef.current) audioRef.current.pause();
      if (videoRef.current) videoRef.current.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    activeSongIdRef.current = currentSong?.id || null;
    reportedMediaIssueRef.current = null;
    reportedDelayRef.current = null;

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
  }, [currentSong]);

  // Clean up ObjectURLs to prevent memory leaks
  useEffect(() => {
    return () => {
      if (localAudioSrc && localAudioSrc.startsWith('blob:')) {
        URL.revokeObjectURL(localAudioSrc);
      }
    };
  }, [localAudioSrc]);

  useEffect(() => {
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
  }, [isPlaying, activeVideoId, localAudioSrc]);

  const handleSeek = (time) => {
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
    runAiExtractionStream
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

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      // Ignore if typing in an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (currentSong) {
          setIsPlaying(prev => !prev);
          showToast(isPlaying ? '일시정지' : '재생', 'info');
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
      mrVerified: Boolean(video.mrVerified)
    });
    showToast(
      replacedStagedItem ? '선택한 곡으로 바꾸었습니다. 2단계에서 정보를 확인하세요.' : '2단계에서 곡 정보와 재생 대상을 확인하세요.',
      'info'
    );
    if (video.id) runAiExtractionStream(apiUrl(`/api/extract-title?id=${video.id}`), {}, stagingId);
  };

  const handleRetryAiExtraction = () => {
    if (!stagedItem?.stagingId) return;
    if (stagedItem.type === 'youtube' && stagedItem.src) {
      runAiExtractionStream(apiUrl(`/api/extract-title?id=${stagedItem.src}`), {}, stagedItem.stagingId);
      return;
    }
    if (stagedItem.type === 'local' && stagedItem.file) {
      runAiExtractionStream(apiUrl('/api/extract-local'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: stagedItem.file.name, metadata: {} })
      }, stagedItem.stagingId);
    }
  };

  const handleLocalFileDrop = (file) => {
    cancelAiExtraction();
    const url = URL.createObjectURL(file);
    const stagingId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStagedItem({
      stagingId,
      type: 'local',
      src: url,
      mediaType: file.type === 'video/mp4' ? 'video' : 'audio',
      title: file.name,
      artist: '',
      file: file
    });
    showToast('로컬 파일을 불러왔습니다. 2단계에서 정보를 확인하세요.', 'info');

    let metadata = {};
    // Try parsing tags for better alias
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title) {
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
        
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata })
        }, stagingId);
      },
      onError: (error) => {
        console.log('No ID3 tags found:', error.type);
        runAiExtractionStream(apiUrl('/api/extract-local'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata })
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
    setStagedItem(null);
    showToast('선택한 곡을 취소했습니다.', 'info');
  };

  const playAudioForSong = (song) => {
    setIsPlaying(true); // 항상 새 곡은 재생 상태로 시작
    setCurrentTime(0);
    setDuration(0);
    if (!song) {
      setActiveVideoId('');
      setLocalAudioSrc(null);
      return;
    }
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

    const newSong = {
      id: Date.now().toString(),
      type: stagedItem.type,
      title: stagedItem.title,
      artist: stagedItem.artist,
      src: stagedItem.src,
      mediaType: stagedItem.mediaType || 'audio',
      tags: stagedItem.tags || [],
      source: stagedItem.source || 'youtube'
    };

    setSharedState(prev => {
      // If nothing is playing, play immediately
      if (!prev.currentSong) {
        playAudioForSong(newSong);
        showToast('새 곡의 재생을 시작합니다.', 'success');
        return { ...prev, currentSong: newSong };
      }
      // Otherwise add to queue
      const q = prev.queue || [];
      showToast(insertAtTop ? '대기열 최상단에 곡이 예약되었습니다.' : '대기열 끝에 곡이 예약되었습니다.', 'info');
      return {
        ...prev,
        queue: insertAtTop ? [newSong, ...q] : [...q, newSong]
      };
    });

    cancelAiExtraction();
    setStagedItem(null);
  };

  const handlePlayNext = (expectedSongId = null) => {
    setSharedState(prev => {
      if (expectedSongId && prev.currentSong?.id !== expectedSongId) {
        return prev;
      }

      const current = prev.currentSong;
      const history = current ? [...(prev.history || []), current] : prev.history || [];
      const queue = prev.queue || [];
      
      if (queue.length > 0) {
        const nextSong = queue[0];
        playAudioForSong(nextSong);
        return {
          ...prev,
          currentSong: nextSong,
          queue: queue.slice(1),
          history
        };
      } else {
        playAudioForSong(null);
        return {
          ...prev,
          currentSong: null,
          history
        };
      }
    });
  };

  handlePlayNextRef.current = handlePlayNext;

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
            onTogglePlay={() => setIsPlaying(!isPlaying)}
            volume={volume}
            onVolumeChange={setVolume}
            currentTime={currentTime}
            duration={duration}
            onSeek={handleSeek}
            setSharedState={setSharedState}
            showToast={showToast}
          />
        </ErrorBoundary>
        </div>
        <div className="queue-area">
          <ErrorBoundary>
            <QueuePanel
              queue={state?.queue || []}
              history={state?.history || []}
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
