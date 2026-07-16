import { useMemo, useState, useEffect } from 'react';
import { toQueueEntry } from '../lib/queueEntry';

const STORAGE_KEY = 'karaoke_app_state';

// v2 스키마 (SONG_LIFECYCLE §1, PHASE_08 §4-1):
//  - queue / history 는 QueueEntry[] (history는 completed 항목만 담는다, INV-3)
//  - currentEntry 는 지금 활성인 QueueEntry (구 스키마의 currentSong 대체)
//  - active 는 재생 런타임 { entryId, runId, phase } — 한 세션 최대 1개(INV-1)
// 구(v1) localStorage의 평면 song 객체는 로드 시 QueueEntry로 승격 래핑한다.
const defaultState = {
  queue: [],
  history: [],
  currentEntry: null,
  active: null,
  volume: 100,
  isMuted: false,
  melomingChannelId: '',
  setlinkCatalog: [],
  setlinkSourceUrl: '',
  setlinkCatalogMeta: null,
  youtubePlaylistCatalog: [],
  youtubePlaylistSourceUrl: '',
  youtubePlaylistCatalogMeta: null,
  // Streamer-confirmed songbook → MR mappings.  This mirrors the durable
  // cache so the songbook can immediately show which songs are ready to use.
  songbookMrCache: {},
  activeIntegrationTab: 'youtube',
  autoPlayNext: false
};

const normaliseState = (candidate, { fromStorage = false, resetCurrentSong = false, onDroppedLocalSong } = {}) => {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  // Legacy local entries point at a page-scoped blob URL and cannot survive a
  // reload. Session-uploaded local media uses an asset id instead, so keep it
  // with the queue/history while the broadcast session is alive.
  const keepEntry = (entry) => {
    if (!entry) return false;
    if (fromStorage && entry.song.type === 'local' && entry.song.src.startsWith('blob:')) {
      // D-04: 조용히 지우지 않는다 — 소실 항목을 집계해 호출자가 안내한다.
      onDroppedLocalSong?.(entry);
      return false;
    }
    return true;
  };
  const normaliseList = (list, fallbackPhase) => (Array.isArray(list) ? list : [])
    .map((item) => toQueueEntry(item, fallbackPhase))
    .filter(keepEntry);

  const queue = normaliseList(source.queue, 'queued');
  const history = normaliseList(source.history, 'completed');

  // Media playback cannot be safely resumed after a page reload. Keeping the
  // old item here creates a phantom "Now Playing" state with no active player.
  // 구 스키마 하위호환: source.currentSong(평면) → currentEntry 승격.
  let currentEntry = null;
  if (!resetCurrentSong) {
    const candidateEntry = toQueueEntry(source.currentEntry ?? source.currentSong ?? null, 'starting');
    currentEntry = candidateEntry && keepEntry(candidateEntry) ? candidateEntry : null;
  }
  // active(재생 런타임)는 현재 항목과 정확히 일치할 때만 신뢰한다.
  const active = currentEntry &&
    source.active && typeof source.active === 'object' &&
    source.active.entryId === currentEntry.entryId &&
    typeof source.active.runId === 'string'
    ? {
        entryId: source.active.entryId,
        runId: source.active.runId,
        phase: typeof source.active.phase === 'string' && source.active.phase ? source.active.phase : 'starting'
      }
    : null;

  const volume = Number(source.volume);

  const next = {
    ...defaultState,
    ...source,
    queue,
    history,
    currentEntry,
    active,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : defaultState.volume,
    isMuted: Boolean(source.isMuted),
    melomingChannelId: typeof source.melomingChannelId === 'string' ? source.melomingChannelId : '',
    setlinkCatalog: Array.isArray(source.setlinkCatalog) ? source.setlinkCatalog : [],
    setlinkSourceUrl: typeof source.setlinkSourceUrl === 'string' ? source.setlinkSourceUrl : '',
    setlinkCatalogMeta: source.setlinkCatalogMeta && typeof source.setlinkCatalogMeta === 'object' ? source.setlinkCatalogMeta : null,
    youtubePlaylistCatalog: Array.isArray(source.youtubePlaylistCatalog) ? source.youtubePlaylistCatalog : [],
    youtubePlaylistSourceUrl: typeof source.youtubePlaylistSourceUrl === 'string' ? source.youtubePlaylistSourceUrl : '',
    youtubePlaylistCatalogMeta: source.youtubePlaylistCatalogMeta && typeof source.youtubePlaylistCatalogMeta === 'object' ? source.youtubePlaylistCatalogMeta : null,
    songbookMrCache: source.songbookMrCache && typeof source.songbookMrCache === 'object' && !Array.isArray(source.songbookMrCache)
      ? source.songbookMrCache
      : {},
    activeIntegrationTab: ['youtube', 'meloming', 'setlink', 'youtube-playlist'].includes(source.activeIntegrationTab)
      ? source.activeIntegrationTab
      : defaultState.activeIntegrationTab,
    autoPlayNext: Boolean(source.autoPlayNext)
  };
  // v1 잔재가 상태에 남아 다시 저장·발행되지 않게 제거한다.
  delete next.currentSong;
  return next;
};

const readStoredState = () => {
  let droppedLocalSongs = 0;
  try {
    const item = window.localStorage.getItem(STORAGE_KEY);
    if (!item) return { state: defaultState, droppedLocalSongs };
    const state = normaliseState(JSON.parse(item), {
      fromStorage: true,
      resetCurrentSong: true,
      onDroppedLocalSong: () => { droppedLocalSongs += 1; }
    });
    return { state, droppedLocalSongs };
  } catch (error) {
    console.warn('Error reading localStorage', error);
    return { state: defaultState, droppedLocalSongs };
  }
};

export function useSyncState() {
  const [initial] = useState(readStoredState);
  const [state, setState] = useState(initial.state);

  // Sync from other tabs
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          setState(normaliseState(JSON.parse(e.newValue), { fromStorage: true }));
        } catch (error) {
          console.warn('Error reading synced localStorage state', error);
        }
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Set and sync to other tabs
  const setSharedState = (newStateOrUpdater) => {
    setState((prevState) => {
      const candidate = typeof newStateOrUpdater === 'function' ? newStateOrUpdater(prevState) : newStateOrUpdater;
      const nextState = normaliseState(candidate);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      return nextState;
    });
  };

  // D-04: 로드 시 정리된 로컬(blob) 곡 수 — Dashboard가 1회 안내 토스트로 소비.
  const loadNotice = useMemo(
    () => ({ droppedLocalSongs: initial.droppedLocalSongs }),
    [initial.droppedLocalSongs]
  );

  return [state, setSharedState, loadNotice];
}
