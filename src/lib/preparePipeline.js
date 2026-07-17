// Stage 6c: 곡 준비(prepare) 파이프라인 클라이언트 (docs/PREPARE_PIPELINE.md §3·§5).
//
// 불변식: `ready`가 아닌 YouTube 곡은 방송 출력에 절대 올라가지 않는다.
// 준비 상태는 설정 플래그가 아니라 R2에 실제로 존재하는 바이트의 증거다(INV-6).
// 네트워크 실패·미설정·미확인은 전부 재생 불가(blocked)로 수렴한다 — 광고가
// 나갈 수 있는 폴백 경로는 어떤 조건에서도 존재하지 않는다.
//
// 인증(계약 정정): prepare 3종 엔드포인트는 전부 room + playerToken 게이트다.
// 무인증이면 아무나 VPS에 다운로드를 큐잉해 봇월 압력이 폭증하기 때문 —
// "재생할 수 없으면 큐잉도 할 수 없다". 세션이 없는 직접 재생(개발) 모드는
// YouTube 준비/재생을 지원하지 않는다(의도된 단절, §7). iframe 폴백은 없다.
//
// Stage 6의 스트리밍 프록시(VITE_AUDIO_PROXY_BASE_URL) 경로는 제거했다(계약 §7).
// 두 경로가 공존하면 "준비 안 된 곡이 스트리밍으로 새어나가는" 우회로가 생긴다.
//
// 베이스 URL: 준비 API는 On-Air 세션과 같은 Worker이므로 VITE_ON_AIR_BASE_URL을
// 재사용한다(새 env 없음). 운영 배포는 항상 이 값이 설정돼 있다.

const configuredBase = String(import.meta.env.VITE_ON_AIR_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');

export const isPrepareConfigured = () => Boolean(configuredBase);

export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const authQuery = (auth) =>
  `room=${encodeURIComponent(String(auth?.room || ''))}&token=${encodeURIComponent(String(auth?.token || ''))}`;

// Worker 응답 화이트리스트 정규화 — 알 수 없는 status는 'unknown'으로 두어
// 절대 ready로 오인되지 않게 한다.
const normalizePrepareInfo = (data) => ({
  status: typeof data?.status === 'string' && data.status ? data.status : 'unknown',
  failureKind: typeof data?.failureKind === 'string' ? data.failureKind : null,
  reason: typeof data?.reason === 'string' ? data.reason : ''
});

// 준비 요청(멱등, §3) — 스테이징 시점에 호출해 방송까지의 시간을 전부 준비에 쓴다.
// force: 사용자의 명시적 '다시 시도'. unavailable(영구 실패)은 자동 재시도가
// 없으므로(죽은 영상 반복 조회는 봇월을 부른다) 이 문이 유일한 부활 경로다 —
// 비공개→공개 전환·오분류가 실제로 있다.
export const requestPrepare = async (videoId, auth, { force = false } = {}) => {
  const response = await fetch(`${configuredBase}/v1/prepare?${authQuery(auth)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: String(videoId || ''), ...(force ? { force: true } : {}) })
  });
  if (!response.ok) throw new Error(`prepare 요청 실패 (${response.status})`);
  return normalizePrepareInfo(await response.json());
};

export const fetchPrepareStatus = async (videoId, auth) => {
  const response = await fetch(
    `${configuredBase}/v1/prepare/${encodeURIComponent(String(videoId || ''))}?${authQuery(auth)}`
  );
  if (!response.ok) throw new Error(`prepare 상태 조회 실패 (${response.status})`);
  return normalizePrepareInfo(await response.json());
};

// 준비된 오디오의 <audio src>(§3). OnAirPlayer는 위젯 URL의 api 파라미터가
// 베이스이므로 base를 명시적으로 받는다 — URL 형태의 정의는 여기 한 곳뿐이다.
export const prepareAudioUrl = (baseUrl, videoId, auth) =>
  `${String(baseUrl || '').replace(/\/$/, '')}/v1/audio/${encodeURIComponent(String(videoId || ''))}?${authQuery(auth)}`;

// 소스 불문 일관 판정: 로컬 파일(및 On-Air 세션 자산)은 준비 절차가 없으므로
// 항상 'ready' — UI가 소스별로 다른 어휘를 쓰지 않게 하는 단일 지점이다.
// kind: 'ready' | 'preparing' | 'failed' | 'unavailable' | 'unreachable' | 'blocked'
export const songPrepareState = (song, prepareStates) => {
  if (!song || song.type !== 'youtube') return { kind: 'ready', reason: '' };
  if (!isPrepareConfigured()) return { kind: 'blocked', reason: '' };
  const info = prepareStates?.[song.src];
  if (!info) return { kind: 'preparing', reason: '' };
  if (info.status === 'ready') return { kind: 'ready', reason: '' };
  if (info.status === 'failed') {
    return info.failureKind === 'unavailable'
      ? { kind: 'unavailable', reason: info.reason || '' }
      : { kind: 'failed', reason: info.reason || '' };
  }
  if (info.status === 'unreachable') return { kind: 'unreachable', reason: '' };
  return { kind: 'preparing', reason: '' }; // absent/queued/preparing/unknown
};

// 재생 불가 사유 문구 — 광고가 아니라 '준비'의 언어로 말한다(계약 §5).
export const prepareBlockMessage = (kind) => {
  if (kind === 'unavailable') return '재생할 수 없는 영상입니다(삭제·비공개 등). 다른 곡을 선택해 주세요.';
  if (kind === 'failed') return '이 곡을 준비하지 못했습니다. 다시 시도하거나 다른 곡을 선택하세요.';
  if (kind === 'unreachable') return '곡 준비 서버에 연결할 수 없습니다. 연결이 복구되면 자동으로 다시 확인합니다.';
  if (kind === 'blocked') return '방송 출력 서버가 설정되지 않아 YouTube 곡을 재생할 수 없습니다. (로컬 파일은 계속 사용할 수 있어요.)';
  return '곡을 준비하는 중입니다. 준비가 끝나면 재생할 수 있습니다.';
};
