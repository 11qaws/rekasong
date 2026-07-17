// QueueEntry 단일 팩토리와 스키마 도우미 (SONG_LIFECYCLE §1, PHASE_08 §4-1).
//
// 상태의 단위는 카탈로그의 '곡'이 아니라 "이번 방송에서 한 번 재생하려고
// 대기열에 넣은 곡 인스턴스"다.
//  - entryId : QueueEntry 생성 시 1회 발급, 완료·폐기까지 불변.
//  - runId   : 실제 재생 시도마다 코디네이터(Dashboard)가 발급.
// 모든 곡 생성/복제 경로(송출, 다시 예약, 히스토리 재호출)는 createQueueEntry
// 하나만 사용한다. 같은 곡 다시 부르기 = 새 entryId의 새 QueueEntry(§1).

export const newId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// SongDefinition 화이트리스트. 알 수 없는 필드(구 스키마의 id 등)는 버린다.
export const sanitizeSongDef = (song) => {
  const source = song && typeof song === 'object' ? song : {};
  const type = source.type === 'youtube' ? 'youtube' : 'local';
  return {
    type,
    src: typeof source.src === 'string' ? source.src : '',
    title: typeof source.title === 'string' ? source.title : '',
    artist: typeof source.artist === 'string' ? source.artist : '',
    tags: Array.isArray(source.tags) ? source.tags : [],
    source: typeof source.source === 'string' && source.source
      ? source.source
      : (type === 'youtube' ? 'youtube' : 'local'),
    songbookId: source.songbookId || null,
    mediaType: source.mediaType === 'video' ? 'video' : 'audio',
    // On-Air(원격 플레이어) 로컬 곡은 blob 대신 세션 자산 id를 참조한다.
    ...(source.assetId ? { assetId: source.assetId } : {}),
    // 표시 전용(수동) 항목 마커 — setlist 표기용으로 직접 입력한 곡(재생 src 없음).
    ...(source.manual === true ? { manual: true } : {})
  };
};

// 수동(표시 전용) 항목 판정: 스트리머가 setlist 표기용으로 직접 입력한 곡.
// 재생 src가 없어 isPlayableSongDef는 통과하지 못하지만, 완료 이력에서는
// 제목 표기를 위해 보존해야 한다(재생 경로 진입은 UI·정규화에서 차단).
export const isManualSongDef = (song) =>
  Boolean(
    song && typeof song === 'object' &&
    song.manual === true &&
    typeof song.title === 'string' && song.title.trim().length > 0
  );

export const isPlayableSongDef = (song) =>
  Boolean(
    song && typeof song === 'object' &&
    typeof song.title === 'string' &&
    (song.type === 'youtube' || song.type === 'local') &&
    typeof song.src === 'string' && song.src.length > 0
  );

export const createQueueEntry = (songDef) => ({
  entryId: newId(),
  song: sanitizeSongDef(songDef),
  phase: 'queued',
  completionReason: null, // 'natural' | 'skipped' | null
  createdAt: Date.now()
});

// 표시 전용(수동) 완료 항목 — 잘못 올라간 setlist를 손으로 고치기 위한 직접
// 입력 경로. 재생을 거치지 않으므로 곧바로 completed 이력으로 태어난다.
export const createManualEntry = (title, artist = '') => ({
  entryId: newId(),
  song: sanitizeSongDef({
    type: 'local',
    src: '',
    title: String(title ?? '').trim(),
    artist: String(artist ?? '').trim(),
    source: 'manual',
    manual: true
  }),
  phase: 'completed',
  completionReason: null,
  createdAt: Date.now()
});

// v1(평면 song 객체) → v2(QueueEntry) 승격 겸 무결성 정규화.
// 재생 불가 항목은 null을 돌려 목록에서 정리한다.
// 구 항목의 id는 entryId로 재사용해 반복 정규화에도 정체성이 흔들리지 않게 한다.
export const toQueueEntry = (item, fallbackPhase = 'queued') => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.entryId === 'string' && item.entryId && item.song && typeof item.song === 'object') {
    const phase = typeof item.phase === 'string' && item.phase ? item.phase : fallbackPhase;
    if (!isPlayableSongDef(item.song)) {
      // 수동(표시 전용) 항목은 완료 이력에서만 유효하다. 대기열·현재 곡 등
      // 다른 위치로 흘러들면 재생 불가 유령이 되므로 구조적으로 걸러낸다.
      if (!(isManualSongDef(item.song) && phase === 'completed')) return null;
    }
    return {
      entryId: item.entryId,
      song: sanitizeSongDef(item.song),
      phase,
      completionReason: typeof item.completionReason === 'string' ? item.completionReason : null,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    };
  }
  if (!isPlayableSongDef(item)) return null;
  const legacyCreatedAt = Number(item.id);
  return {
    entryId: typeof item.id === 'string' && item.id ? item.id : newId(),
    song: sanitizeSongDef(item),
    phase: fallbackPhase,
    completionReason: null,
    createdAt: Number.isFinite(legacyCreatedAt) ? legacyCreatedAt : Date.now()
  };
};

// 하위호환 투영: 위젯(room&key 구독)과 On-Air display projection·load 명령은
// 평면 곡 {id, title, type, src, ...}를 소비한다. entryId를 구 스키마의 id
// 자리에 넣어 내보낸다. (On-Air sessionId = entryId 매핑과 동일 규약)
export const toLegacySong = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.song && typeof entry.song === 'object') return { id: entry.entryId, ...entry.song };
  return entry;
};
