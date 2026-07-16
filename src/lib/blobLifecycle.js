// 로컬 blob URL 수명 관리 (SONG_LIFECYCLE §7 INV-7/8, PHASE_08 §6 Stage 4).
//
// blob: URL은 이 페이지가 살아 있는 동안만 유효한 임시 자원이다. 같은 파일을
// '다시 예약'하거나 이력에서 '다시 부르기'하면 같은 blob src를 참조하는
// QueueEntry가 여러 개 생기므로, revoke는 항상 "이 src를 참조하는 entry가
// 상태(queue/history/currentEntry) 어디에도 없을 때"만 수행한다(D-02).
//
// On-Air 로컬 곡은 blob이 아니라 세션 R2 자산 id(assetId)를 src로 참조하므로
// revoke 대상이 아니다 — 모든 판정이 `blob:` 접두 검사를 거쳐 자연히 걸러진다.

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
