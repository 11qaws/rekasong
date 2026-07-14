import React, { useState, useRef, useEffect, useMemo } from 'react';
import YouTube from 'react-youtube';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js';

import SearchPanel from '../components/SearchPanel';
import StagingPanel from '../components/StagingPanel';
import LivePanel from '../components/LivePanel';
import './Dashboard.css';

export default function Dashboard() {
  const [state, setSharedState] = useSyncState();
  
  const [activeVideoId, setActiveVideoId] = useState('');
  const [localAudioSrc, setLocalAudioSrc] = useState(null);
  
  // Audio Controls
  const [isPlaying, setIsPlaying] = useState(true);
  const [volume, setVolume] = useState(100);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const ytPlayerRef = useRef(null);
  const audioRef = useRef(null);

  // Sync volume to players
  useEffect(() => {
    if (ytPlayerRef.current && ytPlayerRef.current.setVolume) ytPlayerRef.current.setVolume(volume);
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume]);

  // Sync play/pause to players
  useEffect(() => {
    if (isPlaying) {
      if (ytPlayerRef.current && ytPlayerRef.current.playVideo) ytPlayerRef.current.playVideo();
      if (audioRef.current) audioRef.current.play().catch(()=>console.log("Play interrupted"));
    } else {
      if (ytPlayerRef.current && ytPlayerRef.current.pauseVideo) ytPlayerRef.current.pauseVideo();
      if (audioRef.current) audioRef.current.pause();
    }
  }, [isPlaying]);

  // Track Progress
  useEffect(() => {
    // currentSong이 null이 되면 (비상 정지 등으로 인해) 오디오 재생도 강제 중단
    if (state && !state.currentSong) {
      setIsPlaying(false);
      setActiveVideoId('');
      setLocalAudioSrc(null);
    }
  }, [state?.currentSong]);

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
    setCurrentTime(time);
  };

  const [stagedItem, setStagedItem] = useState(null);
  
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

  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState('');

  const runAiExtractionStream = async (url, options = {}) => {
    setIsAiLoading(true);
    setAiStatusMessage('AI 분석 준비 중...');

    const timeoutId = setTimeout(() => {
      setIsAiLoading(false);
      setAiStatusMessage('AI 응답 지연 (직접 입력 요망)');
    }, 10000);

    try {
      const response = await fetch(url, options);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.status === '완료') {
                setStagedItem(prev => prev ? ({ ...prev, title: data.title, artist: '' }) : prev);
                setIsAiLoading(false);
              } else if (data.status === '에러') {
                console.error(data.error);
                setIsAiLoading(false);
              } else {
                setAiStatusMessage(data.status);
              }
            } catch(e) {}
          }
        }
      }
    } catch (err) {
      console.error(err);
      setIsAiLoading(false);
      setAiStatusMessage('AI 추출 실패');
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleSelectSearchResult = (video) => {
    setStagedItem({
      type: 'youtube',
      src: video.id,
      title: video.title,
      artist: video.channelTitle
    });
    runAiExtractionStream(`/api/extract-title?id=${video.id}`);
  };

  const handleQuickPlay = (video) => {
    const newSong = {
      id: Date.now().toString(),
      type: 'youtube',
      src: video.id,
      title: video.title,
      artist: video.channelTitle
    };
    
    setSharedState(prev => {
      if (!prev.currentSong) {
        playAudioForSong(newSong);
        return { ...prev, currentSong: newSong };
      }
      return { ...prev, queue: [...(prev.queue || []), newSong] };
    });
    // 백그라운드로 AI 돌려서 나중에 큐에 있는 제목 업데이트 하는건 생략 (우선 즉각 반영)
  };

  const handleLocalFileDrop = (file) => {
    const url = URL.createObjectURL(file);
    setStagedItem({
      type: 'local',
      src: url,
      title: file.name,
      artist: '',
      file: file
    });

    let metadata = {};
    // Try parsing tags for better alias
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title) {
          metadata = tag.tags;
          setStagedItem(prev => ({
            ...prev,
            title: tag.tags.title,
            artist: tag.tags.artist || ''
          }));
        }
        
        runAiExtractionStream('/api/extract-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata })
        });
      },
      onError: (error) => {
        console.log('No ID3 tags found:', error.type);
        runAiExtractionStream('/api/extract-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, metadata })
        });
      }
    });
  };

  const handleAliasChange = (field, value) => {
    setStagedItem(prev => ({ ...prev, [field]: value }));
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
      src: stagedItem.src
    };

    setSharedState(prev => {
      // If nothing is playing, play immediately
      if (!prev.currentSong) {
        playAudioForSong(newSong);
        return { ...prev, currentSong: newSong };
      }
      // Otherwise add to queue
      const q = prev.queue || [];
      return {
        ...prev,
        queue: insertAtTop ? [newSong, ...q] : [...q, newSong]
      };
    });

    setStagedItem(null);
  };

  const handlePlayNext = () => {
    setSharedState(prev => {
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

  const handleRemoveFromQueue = (songId) => {
    setSharedState(prev => ({
      ...prev,
      queue: (prev.queue || []).filter(s => s.id !== songId)
    }));
  };

  const onLivePlayerReady = (event) => {
    ytPlayerRef.current = event.target;
    event.target.setVolume(volume);
    if (isPlaying) event.target.playVideo();
  };

  const onLivePlayerEnd = (event) => {
    handlePlayNext();
  };

  return (
    <div className={`dashboard-container ${stagedItem ? 'staging-active' : ''}`}>
      <header className="dashboard-header">
        <h1 className="logo">Rekasong</h1>
        <p className="subtitle">그...그런건 없는데</p>
      </header>

      <div className="dashboard-grid">
        <SearchPanel 
          onSelectResult={handleSelectSearchResult} 
          onQuickPlay={handleQuickPlay}
          onLocalFileDrop={handleLocalFileDrop}
          melomingChannelId={state?.melomingChannelId}
          setSharedState={setSharedState}
        />
        <StagingPanel 
          stagedItem={stagedItem}
          onAliasChange={handleAliasChange}
          onGoLive={handleGoLive}
          onClearStaged={() => setStagedItem(null)}
          hasCurrentSong={!!state?.currentSong}
          isAiLoading={isAiLoading}
          aiStatusMessage={aiStatusMessage}
        />
        <LivePanel 
          room={room}
          publicKeyB64={signingKeys?.publicKeyB64}
          history={state?.history || []}
          queue={state?.queue || []}
          currentSong={state?.currentSong}
          onSkip={handlePlayNext}
          onRemoveFromQueue={handleRemoveFromQueue}
          // 새롭게 추가되는 Audio Control 및 History 제어용 Props
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying(!isPlaying)}
          volume={volume}
          onVolumeChange={setVolume}
          currentTime={currentTime}
          duration={duration}
          onSeek={handleSeek}
          setSharedState={setSharedState}
        />
      </div>

      {/* Hidden Live Players */}
      <div className="live-players-hidden">
        {activeVideoId && (
          <YouTube 
            videoId={activeVideoId} 
            opts={{ width: '200', height: '112', playerVars: { autoplay: 1 } }} 
            onReady={onLivePlayerReady}
            onEnd={onLivePlayerEnd}
          />
        )}
        {localAudioSrc && (
          <audio ref={audioRef} src={localAudioSrc} autoPlay onEnded={onLivePlayerEnd} />
        )}
      </div>
    </div>
  );
}
