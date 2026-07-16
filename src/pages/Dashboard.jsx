import React, { useState, useRef, useEffect, useMemo } from 'react';
import YouTube from 'react-youtube';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import { useAiTitleExtraction } from '../hooks/useAiTitleExtraction';
import { useOnAirSession } from '../hooks/useOnAirSession';
import { createQueueEntry, newId, toLegacySong, toQueueEntry } from '../lib/queueEntry';
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

// On-Air transport status → 생애주기 phase (§2-1) 근사 매핑.
const onAirStatusToPhase = (status) => {
  if (status === 'playing') return 'playing';
  if (status === 'paused') return 'paused';
  if (status === 'buffering') return 'buffering';
  return 'starting';
};

export default function Dashboard() {
  useEffect(() => {
    document.body.classList.add('dashboard-page');
    return () => document.body.classList.remove('dashboard-page');
  }, []);

  const [state, setSharedState, syncLoadNotice] = useSyncState();
  const currentEntry = state?.currentEntry || null;
  const active = state?.active || null;
  const history = useMemo(() => Array.isArray(state?.history) ? state.history : [], [state?.history]);
  // 하위호환 투영: 위젯·On-Air display·기존 패널 표시는 평면 곡을 소비한다.
  const currentSong = useMemo(() => (currentEntry ? toLegacySong(currentEntry) : null), [currentEntry]);
  const legacyHistory = useMemo(() => history.map(toLegacySong).filter(Boolean), [history]);
  const legacyQueue = useMemo(() => (Array.isArray(state?.queue) ? state.queue : []).map(toLegacySong).filter(Boolean), [state?.queue]);

  const onAirEventHandlerRef = useRef(null);
  const onAir = useOnAirSession((payload) => onAirEventHandlerRef.current?.(payload));
  const useOnAirPlayer = onAir.configured;
  const onAirDisplayToken = onAir.session?.displayToken;
  const onAirConnectionState = onAir.connectionState;
  const sendOnAirCommand = onAir.sendCommand;

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
  const reportedMediaIssueRef = useRef(null);
  const reportedDelayRef = useRef(null);

  // 이벤트 핸들러가 마운트 시 캡처한 {entryId, runId}를 최신 active와 대조하기
  // 위한 거울 ref (구 activeSongIdRef 가드를 entryId+runId 검증으로 교체).
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeRef = useRef(active);
  activeRef.current = active;

  const isCurrentRun = (marker) => Boolean(
    marker && activeRef.current &&
    activeRef.current.entryId === marker.entryId &&
    activeRef.current.runId === marker.runId
  );

  // Sync volume to players
  useEffect(() => {
    if (!useOnAirPlayer) {
      if (ytPlayerRef.current && ytPlayerRef.current.setVolume) ytPlayerRef.current.setVolume(volume);
      if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
      if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    }
    localStorage.setItem('rekasong_volume', volume);
  }, [volume, useOnAirPlayer]);

  // key={runId} 리마운트로 새 요소가 만들어질 때 볼륨을 즉시 적용한다.
  const bindMediaElement = (ref) => (element) => {
    ref.current = element;
    if (element) element.volume = Math.max(0, Math.min(1, volume / 100));
  };

  const activeRunId = active?.runId || null;
  // run 세대 전환: 지연/오류 1회 보고 가드를 초기화하고, 이전 run의 YouTube
  // 플레이어 참조를 반드시 끊는다(D-11). run이 없어지면 재생 표시도 정리한다.
  useEffect(() => {
    reportedMediaIssueRef.current = null;
    reportedDelayRef.current = null;
    if (!activeRunId) {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
    }
    return () => {
      ytPlayerRef.current = null;
    };
  }, [activeRunId]);

  // Clean up ObjectURLs to prevent memory leaks.
  // 같은 blob을 연속 재생(다시 예약)할 때는 src가 같아 revoke되지 않는다.
  const currentLocalBlobSrc = !useOnAirPlayer && currentEntry?.song?.type === 'local' && currentEntry.song.src.startsWith('blob:')
    ? currentEntry.song.src
    : null;
  useEffect(() => {
    if (!currentLocalBlobSrc) return undefined;
    return () => {
      URL.revokeObjectURL(currentLocalBlobSrc);
    };
  }, [currentLocalBlobSrc]);

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
  }, [isPlaying, activeRunId, useOnAirPlayer]);

  const handleSeek = (time) => {
    if (useOnAirPlayer) {
      try {
        onAir.sendCommand({ type: 'seek', sessionId: currentEntry?.entryId, position: time });
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

  // D-04: 새로고침으로 재생 불가가 된 로컬(blob) 곡을 조용히 지우지 않고 안내.
  const localDropNoticeShownRef = useRef(false);
  useEffect(() => {
    if (localDropNoticeShownRef.current) return;
    if (syncLoadNotice?.droppedLocalSongs > 0) {
      localDropNoticeShownRef.current = true;
      showToast(
        `내 파일 곡 ${syncLoadNotice.droppedLocalSongs}곡은 새로고침 뒤에는 다시 재생할 수 없어 목록에서 정리했습니다. 필요하면 파일을 다시 추가해 주세요.`,
        'info'
      );
    }
    // eslint 참고: showToast는 setToasts만 사용하는 안정적 로직이다.
  }, [syncLoadNotice]);

  const [room] = useState(() => getOrCreateRoom());
  const [signingKeys, setSigningKeys] = useState(null);

  useEffect(() => {
    if (!signingKeys) {
      getOrCreateSigningKeys().then(setSigningKeys).catch(() => {});
    }
  }, [signingKeys]);

  // Update remote widget when state changes.
  // 위젯(room&key 구독)은 평면 currentSong/history를 소비하므로 발행 시점에
  // v2 QueueEntry를 구 스키마 모양으로 투영해 하위호환을 유지한다.
  useEffect(() => {
    if (room && signingKeys) {
      const payload = {
        state: { ...state, currentSong, queue: legacyQueue, history: legacyHistory },
        timestamp: Date.now()
      };
      publishSync(payload, room, signingKeys.privateKey);
    }
  }, [state, currentSong, legacyQueue, legacyHistory, room, signingKeys]);

  useEffect(() => {
    if (!useOnAirPlayer || !onAirDisplayToken || onAirConnectionState !== 'connected') return;
    try {
      sendOnAirCommand({ type: 'display_state', display: toDisplayState({ currentSong, history: legacyHistory }) });
    } catch {
      // The player/session reconnect path will publish the latest display state.
    }
  }, [currentSong, legacyHistory, onAirDisplayToken, onAirConnectionState, sendOnAirCommand, useOnAirPlayer]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      // Ignore if typing in an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (stateRef.current?.currentEntry) {
          togglePlaybackRef.current?.();
        }
      } else if (e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault();
        // D-25: 전이가 실제로 시작됐을 때만 성공 토스트를 보여 준다.
        if (handlePlayNextRef.current?.()) {
          showToast('다음 곡으로 스킵', 'info');
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

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

  // 새 PlaybackRun 시작 (§1: runId는 재생 시도마다 발급).
  // setState updater 밖에서만 호출한다(D-10) — On-Air 명령 송신 같은 I/O가 있다.
  // 직접 재생 모드의 실제 시작은 숨김 플레이어의 key={runId} 리마운트 + autoPlay가
  // 담당하므로 여기서는 run 기술자만 만든다(D-06 구조 해소).
  const beginPlaybackRun = (entry) => {
    const runId = newId();
    setCurrentTime(0);
    setDuration(0);
    if (useOnAirPlayer) {
      onAir.sendCommand({
        type: 'load',
        sessionId: entry.entryId, // On-Air 프로토콜의 sessionId = entryId 매핑
        song: toLegacySong(entry),
        position: 0,
        volume
      });
    }
    return { entryId: entry.entryId, runId, phase: 'starting' };
  };

  // 재생 출력 정지(다음 곡 없음). On-Air 명령 실패는 호출자가 처리한다.
  const stopPlaybackOutput = ({ stoppingEntryId } = {}) => {
    if (useOnAirPlayer) {
      onAir.sendCommand({ type: 'stop', sessionId: stoppingEntryId || currentEntry?.entryId });
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  // active.phase 확정 — 반드시 실제 Player 확인 이벤트 뒤에만 호출된다(INV-5).
  const commitActivePhase = (marker, phase) => {
    setSharedState((previous) => {
      const act = previous.active;
      if (!act || act.entryId !== marker.entryId || act.runId !== marker.runId || act.phase === phase) return previous;
      return { ...previous, active: { ...act, phase } };
    });
  };

  const handleConfirmedPlaying = (marker) => {
    if (!isCurrentRun(marker)) return;
    setIsPlaying(true);
    commitActivePhase(marker, 'playing');
  };

  const handleConfirmedPaused = (marker) => {
    if (!isCurrentRun(marker)) return;
    setIsPlaying(false);
    commitActivePhase(marker, 'paused');
  };

  // 실제 ended 확인 → completed 확정 → (autoPlayNext) 다음 곡 승격.
  // history 편입과 자동 다음 곡은 이 completed 전이 하나에서만 일어난다(INV-2/3/4).
  const handleConfirmedEnded = (marker, completionReason = 'natural') => {
    if (!isCurrentRun(marker)) return;
    const snapshot = stateRef.current || {};
    if (snapshot.currentEntry?.entryId !== marker.entryId) return;

    const queue = snapshot.queue || [];
    let promoted = snapshot.autoPlayNext && queue.length > 0 ? queue[0] : null;
    let nextActive = null;
    if (promoted) {
      try {
        nextActive = beginPlaybackRun(promoted);
      } catch (error) {
        showToast(error.message || '다음 곡을 재생하지 못했습니다.', 'error');
        promoted = null;
      }
    }
    if (!promoted) {
      try {
        stopPlaybackOutput({ stoppingEntryId: marker.entryId });
      } catch {
        // 이미 끝난 곡이다 — 정지 명령 실패가 완료 처리를 막지 않는다.
        setIsPlaying(false);
      }
    }

    const finishedEntry = { ...snapshot.currentEntry, phase: 'completed', completionReason };
    setSharedState((previous) => {
      if (previous.currentEntry?.entryId !== marker.entryId) return previous;
      if (previous.active && previous.active.runId !== marker.runId) return previous;
      const nextHistory = [...(previous.history || []), finishedEntry];
      if (!promoted) return { ...previous, currentEntry: null, active: null, history: nextHistory };
      const q = previous.queue || [];
      const promotedIndex = q.findIndex((item) => item.entryId === promoted.entryId);
      return {
        ...previous,
        currentEntry: promoted,
        active: nextActive,
        queue: promotedIndex >= 0 ? [...q.slice(0, promotedIndex), ...q.slice(promotedIndex + 1)] : q,
        history: nextHistory
      };
    });
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

    // 단일 팩토리 사용(D-09): 모든 신규 곡은 entryId를 가진 QueueEntry로 태어난다.
    const entry = createQueueEntry({
      type: stagedItem.type,
      title: stagedItem.title,
      artist: stagedItem.artist,
      src: useOnAirPlayer && stagedItem.type === 'local' ? stagedItem.assetId : stagedItem.src,
      assetId: useOnAirPlayer && stagedItem.type === 'local' ? stagedItem.assetId : undefined,
      mediaType: stagedItem.mediaType || 'audio',
      tags: stagedItem.tags || [],
      source: stagedItem.source || 'youtube',
      songbookId: stagedItem.songbookId || null
    });
    const newSong = entry.song;

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

    // D-10: 재생 I/O와 토스트를 setState updater 밖에서 수행한다.
    const willPlayImmediately = !stateRef.current?.currentEntry;
    let nextActive = null;
    if (willPlayImmediately) {
      try {
        nextActive = beginPlaybackRun(entry);
      } catch (error) {
        showToast(error.message || '재생을 시작하지 못했습니다.', 'error');
        return;
      }
    }

    setSharedState(prev => {
      const songbookMrCache = confirmedSongbookMr
        ? { ...(prev.songbookMrCache || {}), ...confirmedSongbookMr }
        : prev.songbookMrCache;
      // If nothing is playing, play immediately
      if (willPlayImmediately && !prev.currentEntry && nextActive) {
        return { ...prev, songbookMrCache, currentEntry: entry, active: nextActive };
      }
      // Otherwise add to queue
      const q = prev.queue || [];
      return {
        ...prev,
        songbookMrCache,
        queue: insertAtTop ? [entry, ...q] : [...q, entry]
      };
    });

    showToast(
      willPlayImmediately
        ? '새 곡의 재생을 시작합니다.'
        : insertAtTop ? '대기열 최상단에 곡이 예약되었습니다.' : '대기열 끝에 곡이 예약되었습니다.',
      willPlayImmediately ? 'success' : 'info'
    );

    cancelAiExtraction();
    setStagedItem((previous) => {
      if (useOnAirPlayer && previous?.type === 'local' && previous.src?.startsWith('blob:')) URL.revokeObjectURL(previous.src);
      return null;
    });
  };

  // 스킵/다음 곡. 성공적으로 전이를 시작하면 true를 돌려준다(D-25 토스트 근거).
  // NOTE(Stage 3 예정): 규범 §4-3의 스킵은 finishing → 실제 ended 확인 → completed
  // 전이다. Stage 2에서는 버튼 배선을 고쳐 스킵이 실제로 동작하게 하고(D-01),
  // 기존 '다음 곡 직접 로드' 의미를 유지한다.
  const handlePlayNext = (expectedMarker = null) => {
    const snapshot = stateRef.current || {};
    const current = snapshot.currentEntry;
    if (!current) return false;
    // 늦게 도착한 이벤트/중복 호출 가드: 마커가 있으면 현재 run과 일치해야 한다.
    if (expectedMarker && !isCurrentRun(expectedMarker)) return false;

    const queue = snapshot.queue || [];
    const nextEntry = queue[0] || null;

    let nextActive = null;
    try {
      // Keep player I/O outside React's state updater. A failed WebSocket
      // command must not leave the UI looking as if it skipped successfully.
      if (nextEntry) nextActive = beginPlaybackRun(nextEntry);
      else stopPlaybackOutput({ stoppingEntryId: current.entryId });
    } catch (error) {
      showToast(error.message || '다음 곡으로 넘기지 못했습니다.', 'error');
      return false;
    }

    const finishedEntry = { ...current, phase: 'completed', completionReason: 'skipped' };
    setSharedState((previous) => {
      // Ignore duplicate clicks or a stale end event after the current song
      // has already changed.
      if (previous.currentEntry?.entryId !== current.entryId) return previous;

      const q = previous.queue || [];
      const nextHistory = [...(previous.history || []), finishedEntry];
      if (!nextEntry) return { ...previous, currentEntry: null, active: null, history: nextHistory };
      const nextIndex = q.findIndex((item) => item.entryId === nextEntry.entryId);
      return {
        ...previous,
        currentEntry: nextEntry,
        active: nextActive,
        queue: nextIndex >= 0 ? [...q.slice(0, nextIndex), ...q.slice(nextIndex + 1)] : q,
        history: nextHistory
      };
    });
    return true;
  };

  const handlePlayQueuedSong = (entryId) => {
    const snapshot = stateRef.current || {};
    const selectedEntry = (snapshot.queue || []).find((item) => item.entryId === entryId);
    if (!selectedEntry) return;

    let nextActive = null;
    try {
      nextActive = beginPlaybackRun(selectedEntry);
    } catch (error) {
      showToast(error.message || '선택한 대기열 곡을 재생하지 못했습니다.', 'error');
      return;
    }

    setSharedState((previous) => {
      const q = previous.queue || [];
      const selectedIndex = q.findIndex((item) => item.entryId === entryId);
      if (selectedIndex < 0) return previous;

      const finished = previous.currentEntry
        ? [{ ...previous.currentEntry, phase: 'completed', completionReason: 'skipped' }]
        : [];
      return {
        ...previous,
        currentEntry: q[selectedIndex],
        active: nextActive,
        queue: q.filter((item) => item.entryId !== entryId),
        history: [...(previous.history || []), ...finished]
      };
    });
  };

  handlePlayNextRef.current = handlePlayNext;

  // 현재 곡 '다시 예약' — 기존 항목 복제가 아니라 새 entryId의 새 QueueEntry(§1).
  const handleRequeueCurrent = () => {
    const entry = stateRef.current?.currentEntry;
    if (!entry) return;
    const replay = createQueueEntry(entry.song);
    setSharedState((previous) => ({ ...previous, queue: [...(previous.queue || []), replay] }));
    showToast('현재 곡을 대기열 끝에 다시 예약했습니다.', 'success');
  };

  const handleTogglePlayback = () => {
    const entry = stateRef.current?.currentEntry;
    if (!entry) return;
    if (useOnAirPlayer) {
      try {
        onAir.sendCommand({ type: isPlaying ? 'pause' : 'play', sessionId: entry.entryId });
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }
    // 직접 재생: 명령은 미디어에 직접 보내고, isPlaying/phase 확정은
    // 실제 playing/paused 이벤트에서만 한다(INV-5).
    try {
      if (isPlaying) {
        ytPlayerRef.current?.pauseVideo?.();
        audioRef.current?.pause();
        videoRef.current?.pause();
      } else {
        ytPlayerRef.current?.playVideo?.();
        audioRef.current?.play().catch(() => console.log('Play interrupted'));
        videoRef.current?.play().catch(() => console.log('Play interrupted'));
      }
    } catch {
      // 파괴된 YouTube 플레이어 참조 등 — 다음 확인 이벤트가 상태를 바로잡는다.
    }
  };

  const handleVolumeChange = (nextVolume) => {
    const clamped = Math.max(0, Math.min(100, Number(nextVolume) || 0));
    setVolume(clamped);
    if (useOnAirPlayer && currentEntry) {
      try {
        onAir.sendCommand({ type: 'volume', sessionId: currentEntry.entryId, volume: clamped });
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
  };

  const handleEndBroadcastSession = () => {
    if (!useOnAirPlayer) {
      setSharedState((previous) => ({ ...previous, currentEntry: null, active: null, queue: [], history: [] }));
      setIsPlaying(false);
      return;
    }
    try {
      onAir.sendCommand({ type: 'end_session' });
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  const handlePlaybackDelay = (marker, source) => {
    if (!isCurrentRun(marker) || reportedDelayRef.current === marker.runId) return;
    reportedDelayRef.current = marker.runId;
    showToast(source + ' 재생이 지연되고 있습니다. 잠시 기다리거나 스킵으로 다음 곡을 재생하세요.', 'info');
  };

  const handleMediaFailure = (marker, source, detail = '') => {
    if (!isCurrentRun(marker) || reportedMediaIssueRef.current === marker.runId) return;
    reportedMediaIssueRef.current = marker.runId;
    const reason = detail ? ' (' + detail + ')' : '';
    showToast(source + '을(를) 재생할 수 없습니다' + reason + '. 현재 곡만 건너뜁니다.', 'error');
    // NOTE(Stage 3 예정): failed phase + 재시도/버리기 제시로 교체될 자동 스킵.
    setTimeout(() => handlePlayNextRef.current?.(marker), 400);
  };

  const handleRemoveFromQueue = (entryId) => {
    const queue = stateRef.current?.queue || [];
    const removedIndex = queue.findIndex((item) => item.entryId === entryId);
    const removedEntry = queue[removedIndex];

    if (!removedEntry) return;

    setSharedState(prev => ({
      ...prev,
      queue: (prev.queue || []).filter((item) => item.entryId !== entryId)
    }));

    showToast('“' + removedEntry.song.title + '”을 대기열에서 제거했습니다.', 'info', {
      label: '되돌리기',
      onClick: () => {
        setSharedState(prev => {
          const currentQueue = prev.queue || [];
          if (currentQueue.some((item) => item.entryId === removedEntry.entryId)) return prev;

          const restoredQueue = [...currentQueue];
          restoredQueue.splice(Math.min(removedIndex, restoredQueue.length), 0, removedEntry);
          return { ...prev, queue: restoredQueue };
        });
      }
    });
  };

  const onLivePlayerReady = (event, marker) => {
    if (!isCurrentRun(marker)) return;
    ytPlayerRef.current = event.target;
    event.target.setVolume(volume);
    // starting 단계면 재생 시작을 시도한다. playing 확정은 onStateChange(1)에서.
    if (activeRef.current?.phase !== 'paused') event.target.playVideo();
  };

  togglePlaybackRef.current = handleTogglePlayback;
  onAirEventHandlerRef.current = (payload) => {
    if (payload.type === 'snapshot' || payload.type === 'transport') {
      const remoteTransport = payload.transport || {};
      const remoteSong = remoteTransport.song;
      if (remoteSong?.id) {
        // Worker transport 스냅숏 복원: load 시 내보낸 평면 곡(id=entryId)을
        // QueueEntry로 되감아 currentEntry/active를 재구성한다.
        const restored = toQueueEntry(remoteSong, 'starting');
        if (restored) {
          const restoredActive = {
            entryId: restored.entryId,
            runId: newId(),
            phase: onAirStatusToPhase(remoteTransport.status)
          };
          setSharedState((previous) => {
            if (previous.currentEntry?.entryId === restored.entryId) return previous;
            return { ...previous, currentEntry: restored, active: restoredActive };
          });
        }
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
      // On-Air 프로토콜은 runId를 나르지 않으므로(이번 단계에서는 프로토콜 불변)
      // sessionId(=entryId)가 현재 active와 일치할 때만 현재 run으로 인정한다.
      const act = activeRef.current;
      const marker = act && event.sessionId && act.entryId === String(event.sessionId)
        ? { entryId: act.entryId, runId: act.runId }
        : null;
      if (!marker) return;
      if (event.type === 'playing') handleConfirmedPlaying(marker);
      if (event.type === 'paused') handleConfirmedPaused(marker);
      if (event.type === 'buffering') handlePlaybackDelay(marker, 'On-Air 위젯');
      if (event.type === 'ended') handleConfirmedEnded(marker, 'natural');
      if (event.type === 'error') {
        setIsPlaying(false);
        handleMediaFailure(marker, 'On-Air 위젯', event.message || '재생 오류');
      }
    }
    if (payload.type === 'session_ended') {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setSharedState((previous) => ({ ...previous, currentEntry: null, active: null, queue: [], history: [] }));
      showToast('방송 세션을 종료하고 임시 파일 정리를 예약했습니다.', 'info');
    }
  };

  // 숨김 플레이어는 (currentEntry, active)에서 파생되고 key=runId로 리마운트된다.
  // 마운트 시점의 runMarker가 모든 이벤트 핸들러에 클로저로 캡처되어 전달된다.
  const runMarker = active ? { entryId: active.entryId, runId: active.runId } : null;
  const liveSong = !useOnAirPlayer && runMarker && currentEntry && currentEntry.entryId === active.entryId
    ? currentEntry.song
    : null;

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
            currentSong={currentSong}
            onSkip={handlePlayNext}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlayback}
            volume={volume}
            onVolumeChange={handleVolumeChange}
            currentTime={currentTime}
            duration={duration}
            onSeek={handleSeek}
            onRequeueCurrent={handleRequeueCurrent}
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
                hasCurrentSong: Boolean(currentEntry),
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

      {/* Hidden Live Players — key={runId}: 같은 src 연속 재생도 리마운트+autoPlay */}
      <div className="live-players-hidden">
        {liveSong?.type === 'youtube' && (
          <YouTube
            key={runMarker.runId}
            videoId={liveSong.src}
            opts={{ width: '200', height: '112', playerVars: { autoplay: 1 } }}
            onReady={(event) => onLivePlayerReady(event, runMarker)}
            onEnd={() => handleConfirmedEnded(runMarker, 'natural')}
            onStateChange={(event) => {
              if (event.data === 1) handleConfirmedPlaying(runMarker);
              else if (event.data === 2) handleConfirmedPaused(runMarker);
              else if (event.data === 3) handlePlaybackDelay(runMarker, 'YouTube');
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
              handleMediaFailure(runMarker, 'YouTube', details[e.data] || '알 수 없는 재생 오류');
            }}
          />
        )}
        {liveSong?.type === 'local' && liveSong.mediaType === 'video' && (
          <video
            key={runMarker.runId}
            ref={bindMediaElement(videoRef)}
            src={liveSong.src}
            autoPlay
            playsInline
            onPlaying={() => handleConfirmedPlaying(runMarker)}
            onPause={() => handleConfirmedPaused(runMarker)}
            onEnded={() => handleConfirmedEnded(runMarker, 'natural')}
            onWaiting={() => handlePlaybackDelay(runMarker, '로컬 영상')}
            onError={() => handleMediaFailure(runMarker, '로컬 영상', 'MP4 재생 오류')}
          />
        )}
        {liveSong?.type === 'local' && liveSong.mediaType !== 'video' && (
          <audio
            key={runMarker.runId}
            ref={bindMediaElement(audioRef)}
            src={liveSong.src}
            autoPlay
            onPlaying={() => handleConfirmedPlaying(runMarker)}
            onPause={() => handleConfirmedPaused(runMarker)}
            onEnded={() => handleConfirmedEnded(runMarker, 'natural')}
            onWaiting={() => handlePlaybackDelay(runMarker, '로컬 음원')}
            onError={() => {
              const errorCode = audioRef.current?.error?.code;
              const details = {
                1: '가져오기가 중단됨',
                2: '파일을 읽을 수 없음',
                3: '음원 형식이 손상되었거나 지원되지 않음',
                4: '브라우저가 이 형식을 지원하지 않음'
              };
              handleMediaFailure(runMarker, '로컬 음원', details[errorCode] || '읽기 오류');
            }}
          />
        )}
      </div>
    </div>
  );
}
