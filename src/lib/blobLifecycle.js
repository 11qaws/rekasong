// 로컬 blob URL 수명 관리 (SONG_LIFECYCLE §7 INV-7/8, PHASE_08 §6 Stage 4).
//
// blob: URL은 이 페이지가 살아 있는 동안만 유효한 임시 자원이다. 같은 파일을
// '다시 예약'하거나 이력에서 '다시 부르기'하면 같은 blob src를 참조하는
// QueueEntry가 여러 개 생기므로, revoke는 항상 "이 src를 참조하는 entry가
// 상태(queue/history/currentEntry) 어디에도 없을 때"만 수행한다(D-02).
//
// Speaker 로컬 곡은 page Blob을 src로 계속 쓰며 OBS를 선택한 경우에만 assetId를
// 옆에 덧붙인다. assetId 존재 여부와 무관하게 Blob의 실제 참조를 기준으로 회수한다.

import { sanitizeSongDef } from './queueEntry.js';

export const LOCAL_BLOB_HISTORY_MAX_SOURCES = 5;
export const LOCAL_BLOB_HISTORY_MAX_BYTES = 256 * 1024 * 1024;

export const isLocalBlobSong = (song) =>
  Boolean(song && song.type === 'local' && typeof song.src === 'string' && song.src.startsWith('blob:'));

// state가 참조하는 모든 blob src의 집합(세션 종료·창 닫힘 일괄 정리용).
// 성능: queue+history 1회 순회(O(n)) — 세션 종료/언로드 시에만 호출된다.
export const collectBlobSrcs = (state) => {
  const srcs = new Set();
  const add = (entry) => {
    if (entry && isLocalBlobSong(entry.song)) srcs.add(entry.song.src);
  };
  if (state && typeof state === 'object') {
    (Array.isArray(state.queue) ? state.queue : []).forEach(add);
    (Array.isArray(state.history) ? state.history : []).forEach(add);
    add(state.currentEntry);
  }
  return srcs;
};

// src를 참조하는 entry가 state에 하나라도 남아 있으면 true — revoke 금지 신호.
export const isBlobReferenced = (src, state) => {
  if (!src || !state || typeof state !== 'object') return false;
  const matches = (entry) => Boolean(entry && isLocalBlobSong(entry.song) && entry.song.src === src);
  return (Array.isArray(state.queue) ? state.queue : []).some(matches) ||
    (Array.isArray(state.history) ? state.history : []).some(matches) ||
    matches(state.currentEntry);
};

// 일괄 revoke — 이미 회수된 URL에 대한 revoke는 무해(멱등)하며, 실패해도 던지지 않는다.
export const revokeBlobSrcs = (srcs) => {
  srcs.forEach((src) => {
    try {
      URL.revokeObjectURL(src);
    } catch {
      // 이미 회수됐거나 URL 구현이 없는 환경 — 정리 실패가 흐름을 막지 않는다.
    }
  });
};

// A stored/reclaimed local item keeps its identity and display metadata but no
// longer advertises a page-scoped URL as playable.
export const expireLocalBlobEntry = (entry) => {
  if (!entry || !isLocalBlobSong(entry.song)) return entry;
  return {
    ...entry,
    song: sanitizeSongDef({
      ...entry.song,
      src: '',
      localSourceExpired: true,
    }),
  };
};

// Reattach an explicitly chosen file to an expired local definition. This does
// not guess a file or start playback; the caller decides whether to replace a
// queued entry or create a new one from history.
export const restoreLocalBlobSong = (song, { src, bytes, mediaType } = {}) => {
  if (!song || song.type !== 'local' || typeof src !== 'string' || !src.startsWith('blob:')) {
    return null;
  }
  return sanitizeSongDef({
    ...song,
    src,
    localSourceExpired: false,
    localBlobBytes: bytes,
    mediaType: mediaType === 'video' ? 'video' : 'audio',
  });
};

const localBlobByteCost = (song, maxBytes) => {
  const bytes = song?.localBlobBytes;
  // Old entries have no size metadata. Counting them as the whole budget is
  // deliberately conservative; treating unknown as zero recreates the leak.
  if (!Number.isSafeInteger(bytes) || bytes < 0) return Math.max(1, maxBytes);
  return bytes;
};

// Pure completed-history budget planner. It never mutates input and never calls
// URL.revokeObjectURL; React applies the returned history first, then performs
// the returned revocations only after the latest state proves no references.
export const planLocalBlobHistoryBudget = (
  state,
  {
    maxSources = LOCAL_BLOB_HISTORY_MAX_SOURCES,
    maxBytes = LOCAL_BLOB_HISTORY_MAX_BYTES,
  } = {},
) => {
  const history = Array.isArray(state?.history) ? state.history : [];
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const sourceLimit = Number.isSafeInteger(maxSources) && maxSources >= 0 ? maxSources : 0;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0;
  const protectedSrcs = new Set();
  const protect = (entry) => {
    if (isLocalBlobSong(entry?.song)) protectedSrcs.add(entry.song.src);
  };
  queue.forEach(protect);
  protect(state?.currentEntry);

  const groups = new Map();
  history.forEach((entry, index) => {
    if (!isLocalBlobSong(entry?.song) || protectedSrcs.has(entry.song.src)) return;
    const src = entry.song.src;
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
    const existing = groups.get(src) || {
      src,
      bytes: 0,
      recency: createdAt,
      latestIndex: index,
      entryCount: 0,
    };
    existing.bytes = Math.max(existing.bytes, localBlobByteCost(entry.song, byteLimit));
    if (createdAt > existing.recency || (createdAt === existing.recency && index > existing.latestIndex)) {
      existing.recency = createdAt;
      existing.latestIndex = index;
    }
    existing.entryCount += 1;
    groups.set(src, existing);
  });

  const newestFirst = [...groups.values()].sort((left, right) => (
    right.recency - left.recency || right.latestIndex - left.latestIndex || left.src.localeCompare(right.src)
  ));
  const expiredSrcs = new Set();
  let retainedSources = 0;
  let retainedBytes = 0;
  for (const group of newestFirst) {
    const fits = retainedSources < sourceLimit && group.bytes <= byteLimit - retainedBytes;
    if (fits) {
      retainedSources += 1;
      retainedBytes += group.bytes;
    } else {
      expiredSrcs.add(group.src);
    }
  }

  if (expiredSrcs.size === 0) {
    return {
      changed: false,
      history,
      revokeSrcs: [],
      expiredEntryCount: 0,
      retainedSources,
      retainedBytes,
      protectedSources: protectedSrcs.size,
    };
  }

  let expiredEntryCount = 0;
  const nextHistory = history.map((entry) => {
    if (!isLocalBlobSong(entry?.song) || !expiredSrcs.has(entry.song.src)) return entry;
    expiredEntryCount += 1;
    return expireLocalBlobEntry(entry);
  });
  return {
    changed: true,
    history: nextHistory,
    revokeSrcs: [...expiredSrcs],
    expiredEntryCount,
    retainedSources,
    retainedBytes,
    protectedSources: protectedSrcs.size,
  };
};
