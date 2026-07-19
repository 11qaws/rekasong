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

import { getOutputMessage } from '../copy/outputMessages.js';

const configuredBase = String(import.meta.env?.VITE_ON_AIR_BASE_URL || '')
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

export const PREPARE_REQUEST_ERROR_CODES = Object.freeze({
  SESSION_INVALID: 'session_invalid',
  SESSION_ENDED: 'session_ended',
  NETWORK_ERROR: 'network_error',
  SERVER_ERROR: 'server_error'
});

// Error.message도 표시 문장이 아니라 안정적인 코드다. UI 경계에서 현재 locale의
// 문구로 바꾸므로 네트워크 계층에 한국어/영어 문장을 굳히지 않는다.
export class PrepareRequestError extends Error {
  constructor(code, { httpStatus = null, cause = null } = {}) {
    super(code);
    this.name = 'PrepareRequestError';
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    if (cause) this.cause = cause;
  }
}

const responseErrorCode = (status) => {
  if (status === 401 || status === 403) return PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID;
  if (status === 410) return PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED;
  return PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR;
};

const fetchPrepareJson = async (url, init, fetchImpl) => {
  if (typeof fetchImpl !== 'function') {
    throw new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR);
  }

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR, { cause });
  }

  if (!response.ok) {
    throw new PrepareRequestError(responseErrorCode(response.status), {
      httpStatus: response.status
    });
  }

  try {
    return normalizePrepareInfo(await response.json());
  } catch (cause) {
    throw new PrepareRequestError(PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR, {
      httpStatus: response.status,
      cause
    });
  }
};

// room이나 playerToken 중 하나만 바뀌어도 이전 prepare 요청은 다른 인증 수명에
// 속한다. 원문 토큰은 UI/로그에 노출하지 않고 메모리 안의 동일성 비교에만 쓴다.
export const prepareSessionIdentity = (session) => {
  const room = String(session?.room || '');
  const playerToken = String(session?.playerToken || '');
  return room && playerToken ? `${room}\u0000${playerToken}` : '';
};

// Worker의 prepare 게이트는 종료 세션도 현재 401로 수렴할 수 있다. 이미 별도
// session status 검증이 종료/무효를 판별했다면 그 더 강한 증거를 우선한다.
export const prepareFailureInfo = (error, { sessionState = '' } = {}) => {
  if (sessionState === 'ended') {
    return { status: 'session_ended', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED };
  }
  if (sessionState === 'invalid') {
    return { status: 'session_invalid', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID };
  }

  if (error?.code === PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED) {
    return { status: 'session_ended', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_ENDED };
  }
  if (error?.code === PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID) {
    return { status: 'session_invalid', failureKind: PREPARE_REQUEST_ERROR_CODES.SESSION_INVALID };
  }
  if (error?.code === PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR) {
    return { status: 'temporarily_unavailable', failureKind: PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR };
  }
  return { status: 'temporarily_unavailable', failureKind: PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR };
};

// 준비 요청(멱등, §3) — 스테이징 시점에 호출해 방송까지의 시간을 전부 준비에 쓴다.
// force: 사용자의 명시적 '다시 시도'. unavailable(영구 실패)은 자동 재시도가
// 없으므로(죽은 영상 반복 조회는 봇월을 부른다) 이 문이 유일한 부활 경로다 —
// 비공개→공개 전환·오분류가 실제로 있다.
export const requestPrepare = async (
  videoId,
  auth,
  { force = false, fetchImpl = globalThis.fetch } = {}
) => fetchPrepareJson(`${configuredBase}/v1/prepare?${authQuery(auth)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: String(videoId || ''), ...(force ? { force: true } : {}) })
  }, fetchImpl);

export const fetchPrepareStatus = async (
  videoId,
  auth,
  { fetchImpl = globalThis.fetch } = {}
) => fetchPrepareJson(
  `${configuredBase}/v1/prepare/${encodeURIComponent(String(videoId || ''))}?${authQuery(auth)}`,
  undefined,
  fetchImpl
);

// 준비된 오디오의 <audio src>(§3). OnAirPlayer는 위젯 URL의 api 파라미터가
// 베이스이므로 base를 명시적으로 받는다 — URL 형태의 정의는 여기 한 곳뿐이다.
export const prepareAudioUrl = (baseUrl, videoId, auth) =>
  `${String(baseUrl || '').replace(/\/$/, '')}/v1/audio/${encodeURIComponent(String(videoId || ''))}?${authQuery(auth)}`;

// 소스 불문 일관 판정: 로컬 파일(및 On-Air 세션 자산)은 준비 절차가 없으므로
// 항상 'ready' — UI가 소스별로 다른 어휘를 쓰지 않게 하는 단일 지점이다.
// kind는 기존 StagingPanel 계약을 위해 연결 계열을 'unreachable'로 유지하고,
// connectionKind가 무효/종료/네트워크/서버를 구분한다.
export const prepareInfoState = (info) => {
  if (!info) return { kind: 'preparing', reason: '' };
  if (info.status === 'ready') return { kind: 'ready', reason: '' };
  if (info.status === 'failed') {
    return info.failureKind === 'unavailable'
      ? { kind: 'unavailable', reason: info.reason || '' }
      : { kind: 'failed', reason: info.reason || '' };
  }
  if (info.status === 'session_invalid') {
    return { kind: 'unreachable', connectionKind: 'session_invalid', reason: '' };
  }
  if (info.status === 'session_ended') {
    return { kind: 'unreachable', connectionKind: 'session_ended', reason: '' };
  }
  if (info.status === 'temporarily_unavailable') {
    const connectionKind = info.failureKind === PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR
      ? PREPARE_REQUEST_ERROR_CODES.NETWORK_ERROR
      : PREPARE_REQUEST_ERROR_CODES.SERVER_ERROR;
    return { kind: 'unreachable', connectionKind, reason: '' };
  }
  // 이전 탭에서 이미 기록된 상태가 남아 있어도 새 중립 문구로 안전하게 흡수한다.
  if (info.status === 'unreachable') {
    return { kind: 'unreachable', connectionKind: 'temporarily_unavailable', reason: '' };
  }
  return { kind: 'preparing', reason: '' }; // absent/queued/preparing/unknown
};

export const songPrepareState = (song, prepareStates) => {
  if (!song || song.type !== 'youtube') return { kind: 'ready', reason: '' };
  if (!isPrepareConfigured()) return { kind: 'blocked', reason: '' };
  return prepareInfoState(prepareStates?.[song.src]);
};

const PREPARE_BLOCK_MESSAGE_KEYS = Object.freeze({
  unavailable: 'prepare.block.unavailable',
  failed: 'prepare.block.failed',
  session_invalid: 'prepare.block.sessionInvalid',
  session_ended: 'prepare.block.sessionEnded',
  network_error: 'prepare.block.networkError',
  server_error: 'prepare.block.serverError',
  temporarily_unavailable: 'prepare.block.temporarilyUnavailable',
  unreachable: 'prepare.block.temporarilyUnavailable',
  blocked: 'prepare.block.blocked',
  preparing: 'prepare.block.preparing'
});

export const prepareBlockMessageKey = (stateOrKind) => {
  const kind = typeof stateOrKind === 'object'
    ? stateOrKind?.connectionKind || stateOrKind?.kind
    : stateOrKind;
  return PREPARE_BLOCK_MESSAGE_KEYS[kind] || PREPARE_BLOCK_MESSAGE_KEYS.preparing;
};

// 기존 비-React 소비자와의 호환 facade. 번역 원문은 catalog 한 곳에만 둔다.
export const prepareBlockMessage = (stateOrKind, locale) =>
  getOutputMessage(prepareBlockMessageKey(stateOrKind), {}, locale);
