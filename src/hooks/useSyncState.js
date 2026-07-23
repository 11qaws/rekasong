import { useMemo, useRef, useState, useEffect } from 'react';
import { isPlayableSongDef, toQueueEntry } from '../lib/queueEntry.js';
import { expireLocalBlobEntry, isLocalBlobSong } from '../lib/blobLifecycle.js';
import {
  LEGACY_SYNC_STORAGE_KEY,
  SHARED_SYNC_STORAGE_KEY,
  TAB_SYNC_STORAGE_KEY,
} from '../lib/syncStorageKeys.js';

export {
  LEGACY_SYNC_STORAGE_KEY,
  SHARED_SYNC_STORAGE_KEY,
  TAB_SYNC_STORAGE_KEY,
};
const DEV_HISTORY_FIXTURE_QUERY = '__rekasong_history_fixture';
const DEV_HISTORY_FIXTURE_MAX = 2000;

// v2 스키마 (SONG_LIFECYCLE §1, PHASE_08 §4-1):
//  - queue / history 는 QueueEntry[] (history는 completed 항목만 담는다, INV-3)
//  - currentEntry 는 지금 활성인 QueueEntry (구 스키마의 currentSong 대체)
//  - active 는 재생 런타임 { entryId, runId, phase } — 한 세션 최대 1개(INV-1)
// 수명은 별도다: history/노래책/환경설정은 공유 localStorage, queue/auto-next는
// 탭 sessionStorage, currentEntry/active/실제 Blob URL은 탭 메모리에만 둔다.
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

const normaliseState = (candidate, { fromStorage = false, resetCurrentSong = false, onExpiredLocalSong } = {}) => {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  // A blob URL belongs to the page that created it. A stored or cross-tab copy
  // retains metadata as an explicit reselectable placeholder instead of either
  // pretending the URL works or silently deleting the track.
  const expireStoredBlob = (entry) => {
    if (!entry || !fromStorage || !isLocalBlobSong(entry.song)) return entry;
    onExpiredLocalSong?.(entry);
    return expireLocalBlobEntry(entry);
  };
  const normaliseList = (list, fallbackPhase) => (Array.isArray(list) ? list : [])
    .map((item) => toQueueEntry(item, fallbackPhase))
    .filter(Boolean)
    .map(expireStoredBlob);

  const queue = normaliseList(source.queue, 'queued');
  const history = normaliseList(source.history, 'completed');

  // Media playback cannot be safely resumed after a page reload. Keeping the
  // old item here creates a phantom "Now Playing" state with no active player.
  // 구 스키마 하위호환: source.currentSong(평면) → currentEntry 승격.
  let currentEntry = null;
  if (!resetCurrentSong) {
    const candidateEntry = toQueueEntry(source.currentEntry ?? source.currentSong ?? null, 'starting');
    // Restorable placeholders belong only in queue/history. They must never
    // create a phantom current player with no media bytes.
    currentEntry = candidateEntry && isPlayableSongDef(candidateEntry.song)
      ? candidateEntry
      : null;
  }
  // active(재생 런타임)는 현재 항목과 정확히 일치할 때만 신뢰한다.
  const active = currentEntry &&
    source.active && typeof source.active === 'object' &&
    source.active.entryId === currentEntry.entryId &&
    typeof source.active.runId === 'string'
    ? {
        entryId: source.active.entryId,
        runId: source.active.runId,
        phase: typeof source.active.phase === 'string' && source.active.phase ? source.active.phase : 'starting',
        ...(source.active.outputMode === 'speaker' || source.active.outputMode === 'obs'
          ? { outputMode: source.active.outputMode }
          : {}),
        // Stage 3 런타임 부속 정보 — finishing의 예정 완료 사유(§4-3),
        // 스킵/바로 재생이 예약한 다음 전환 대상(§4-6), failed의 실패 사유(§4-5).
        ...(typeof source.active.pendingCompletionReason === 'string' && source.active.pendingCompletionReason
          ? { pendingCompletionReason: source.active.pendingCompletionReason }
          : {}),
        ...(typeof source.active.pendingNextEntryId === 'string' && source.active.pendingNextEntryId
          ? { pendingNextEntryId: source.active.pendingNextEntryId }
          : {}),
        ...(typeof source.active.failureDetail === 'string' && source.active.failureDetail
          ? { failureDetail: source.active.failureDetail }
          : {}),
        // OBS discard is a two-evidence transition: the local user intent and
        // the exact strong-stop snapshot may arrive in either order. Keep the
        // intent in tab runtime state until that snapshot finalizes the run;
        // dropping it here leaves an already silent player stuck forever in
        // the discarding phase.
        ...(source.active.discardRequested === true
          ? { discardRequested: true }
          : {})
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

// Repeatable browser performance fixture. Vite replaces DEV with false and
// removes this branch from production builds; it never reads or writes the
// user's persisted state. Keeping the fixture at the state boundary exercises
// the real Dashboard/QueuePanel projection without test-only UI controls.
const readDevelopmentHistoryFixture = () => {
  if (import.meta.env?.DEV !== true || typeof window === 'undefined') return null;
  const rawCount = new URLSearchParams(window.location.search).get(DEV_HISTORY_FIXTURE_QUERY);
  if (!/^\d+$/.test(rawCount || '')) return null;
  const count = Math.min(Number(rawCount), DEV_HISTORY_FIXTURE_MAX);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const createdAt = 1700000000000;
  return {
    ...defaultState,
    history: Array.from({ length: count }, (_, index) => ({
      entryId: `history-performance-fixture-${index}`,
      song: {
        type: 'local',
        src: '',
        title: `Performance history track ${String(index + 1).padStart(4, '0')}`,
        artist: 'Rekasong fixture',
        tags: [],
        source: 'manual',
        mediaType: 'audio',
        manual: true,
      },
      phase: 'completed',
      completionReason: null,
      createdAt: createdAt + index,
    })),
  };
};

const readStorageRecord = (storage, key, label) => {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return { candidate: null, raw: null, valid: false };
    return { candidate: JSON.parse(raw), raw, valid: true };
  } catch (error) {
    console.warn(`Error reading ${label}`, error);
    return { candidate: null, raw: null, valid: false };
  }
};

/**
 * Rebuild one tab from the durable library plus its own playback session.
 *
 * A missing tab record is the one-time legacy migration path: the old shared
 * queue is adopted by the first load of each already-open tab. Once a tab
 * record exists, even an intentionally empty queue is authoritative and an
 * old/shared queue can no longer leak back into it.
 */
export const mergeStoredSyncState = (
  sharedCandidate,
  tabCandidate,
  { onExpiredLocalSong } = {},
) => {
  const hasTabRecord = Boolean(
    tabCandidate && typeof tabCandidate === 'object' && !Array.isArray(tabCandidate),
  );
  const sharedSource = hasTabRecord
    ? { ...(sharedCandidate || {}), queue: [] }
    : sharedCandidate;
  const shared = normaliseState(sharedSource, {
    fromStorage: true,
    resetCurrentSong: true,
    onExpiredLocalSong,
  });
  if (!hasTabRecord) return shared;

  const tab = normaliseState({
    queue: Array.isArray(tabCandidate.queue) ? tabCandidate.queue : [],
    autoPlayNext: Boolean(tabCandidate.autoPlayNext),
  }, {
    fromStorage: true,
    resetCurrentSong: true,
    onExpiredLocalSong,
  });
  return normaliseState({
    ...shared,
    queue: tab.queue,
    currentEntry: null,
    active: null,
    autoPlayNext: tab.autoPlayNext,
  });
};

const readStoredState = () => {
  let localFilesNeedReselection = 0;
  const developmentFixture = readDevelopmentHistoryFixture();
  if (developmentFixture) {
    return {
      state: normaliseState(developmentFixture),
      localFilesNeedReselection,
      storageEnabled: false,
      sharedRaw: null,
      tabRaw: null,
    };
  }

  const sharedRecord = readStorageRecord(
    window.localStorage,
    SHARED_SYNC_STORAGE_KEY,
    'shared localStorage state',
  );
  const legacyRecord = sharedRecord.valid
    ? { candidate: null, raw: null, valid: false }
    : readStorageRecord(
        window.localStorage,
        LEGACY_SYNC_STORAGE_KEY,
        'legacy localStorage state',
      );
  const tabRecord = readStorageRecord(
    window.sessionStorage,
    TAB_SYNC_STORAGE_KEY,
    'tab sessionStorage state',
  );
  const selectedSharedRecord = sharedRecord.valid ? sharedRecord : legacyRecord;
  const state = mergeStoredSyncState(
    selectedSharedRecord.candidate,
    tabRecord.valid ? tabRecord.candidate : null,
    { onExpiredLocalSong: () => { localFilesNeedReselection += 1; } },
  );
  return {
    state,
    localFilesNeedReselection,
    storageEnabled: true,
    sharedRaw: sharedRecord.valid ? sharedRecord.raw : null,
    tabRaw: tabRecord.valid ? tabRecord.raw : null,
  };
};

/**
 * Persist only durable/shared library state. A playing song belongs to the
 * browser tab that owns its HTMLMediaElement; publishing currentEntry/active
 * through localStorage makes another tab display a phantom player and lets its
 * controls invalidate the real tab's run identity.
 */
export const createPersistedSyncState = (candidate) => {
  const normalized = normaliseState(candidate);
  const durableEntry = (entry) => isLocalBlobSong(entry?.song)
    ? expireLocalBlobEntry(entry)
    : entry;
  return {
    ...normalized,
    // Playback order belongs to one browser tab. The shared library keeps
    // history/songbooks/preferences only; publishing a queue recreates the
    // same track in unrelated Speaker tabs with different preparation state.
    queue: [],
    history: normalized.history.map(durableEntry),
    currentEntry: null,
    active: null,
    autoPlayNext: false,
  };
};

export const createPersistedTabState = (candidate) => {
  const normalized = normaliseState(candidate);
  const durableEntry = (entry) => isLocalBlobSong(entry?.song)
    ? expireLocalBlobEntry(entry)
    : entry;
  return {
    version: 1,
    queue: normalized.queue.map(durableEntry),
    autoPlayNext: normalized.autoPlayNext,
  };
};

// Incoming durable order is the base, but another tab cannot delete or replace
// this tab's live Blob entries. A matching expired placeholder is replaced by
// the local playable entry; a missing one is reinserted near its local index.
const mergeTabOwnedBlobEntries = (localList, incomingList) => {
  const next = [...incomingList];
  (Array.isArray(localList) ? localList : []).forEach((localEntry, localIndex) => {
    if (!isLocalBlobSong(localEntry?.song)) return;
    const incomingIndex = next.findIndex((entry) => entry.entryId === localEntry.entryId);
    if (incomingIndex >= 0) {
      next[incomingIndex] = localEntry;
      return;
    }
    next.splice(Math.min(localIndex, next.length), 0, localEntry);
  });
  return next;
};

/**
 * Apply durable library changes from another tab without importing that tab's
 * player runtime or playback order. History and songbooks remain shared; each
 * Speaker tab keeps its own queue, auto-next choice, current song and run.
 */
export const mergeCrossTabSyncState = (localState, incomingState) => {
  const shared = normaliseState(incomingState, {
    fromStorage: true,
    resetCurrentSong: true,
  });
  const localRuntime = normaliseState(localState);
  return normaliseState({
    ...shared,
    queue: localRuntime.queue,
    history: mergeTabOwnedBlobEntries(localRuntime.history, shared.history),
    currentEntry: localRuntime.currentEntry,
    active: localRuntime.active,
    autoPlayNext: localRuntime.autoPlayNext,
  });
};

export function useSyncState() {
  const [initial] = useState(readStoredState);
  const [state, setState] = useState(initial.state);
  const lastSharedPayloadRef = useRef(initial.sharedRaw);
  const lastTabPayloadRef = useRef(initial.tabRaw);

  const persistState = (nextState) => {
    if (!initial.storageEnabled) return;
    const sharedPayload = JSON.stringify(createPersistedSyncState(nextState));
    const tabPayload = JSON.stringify(createPersistedTabState(nextState));
    if (sharedPayload !== lastSharedPayloadRef.current) {
      try {
        window.localStorage.setItem(SHARED_SYNC_STORAGE_KEY, sharedPayload);
        lastSharedPayloadRef.current = sharedPayload;
      } catch (error) {
        console.warn('Error writing shared localStorage state', error);
      }
    }
    if (tabPayload !== lastTabPayloadRef.current) {
      try {
        window.sessionStorage.setItem(TAB_SYNC_STORAGE_KEY, tabPayload);
        lastTabPayloadRef.current = tabPayload;
      } catch (error) {
        console.warn('Error writing tab sessionStorage state', error);
      }
    }
  };

  // Materialize the split schema immediately. This copies a legacy queue into
  // this tab's session record without modifying the legacy key, so an older
  // already-open app version cannot have its queue erased during deployment.
  useEffect(() => {
    persistState(initial.state);
    // The initializer is immutable for this hook lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync from other tabs
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === SHARED_SYNC_STORAGE_KEY && e.newValue) {
        try {
          const incoming = JSON.parse(e.newValue);
          lastSharedPayloadRef.current = e.newValue;
          setState((localState) => mergeCrossTabSyncState(localState, incoming));
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
      persistState(nextState);
      return nextState;
    });
  };

  // Legacy payloads may still contain page-owned Blob URLs. They are preserved
  // as reselectable metadata and Dashboard announces that action once.
  const loadNotice = useMemo(
    () => ({ localFilesNeedReselection: initial.localFilesNeedReselection }),
    [initial.localFilesNeedReselection]
  );

  return [state, setSharedState, loadNotice];
}
