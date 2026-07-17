// Stage 6: 광고 없는 오디오 프록시 (SONG_LIFECYCLE §2-4 outputSafety 실현).
//
// 불변식: 방송 출력은 광고가 나올 수 있는 어떤 경로(YouTube iframe/플레이어)도
// 절대 사용하지 않는다. 광고 없는 오디오를 확정할 수 없으면 재생하지 않는다
// (fail-safe — 방송 중 통제 불가 광고는 완전한 실패이며, 재생이 안 되는 편이 낫다).
//
// 별도 백엔드가 videoId를 광고 없는 오디오 스트림으로 프록시하면 <audio>의
// 결정적 media 이벤트(playing/ended/timeupdate)를 얻어 규범적 스킵
// (finishing→ended→completed)이 YouTube 곡에도 열린다.
//
// 규약 (백엔드 확정):
//   GET {base}/audio?v=<11자 videoId> → 오디오 바이트 스트림
//       (Range/206, Accept-Ranges: bytes, CORS *, Content-Type audio/mp4|webm)
//   GET {base}/prefetch?v=<id>        → 다음 곡 사전 해석(202)
//   GET {base}/health                 → 상태 JSON
//   GET {base}/resolve?v=<id>         → 디버그
//
// 하위호환·배포 주의:
//  - VITE_AUDIO_PROXY_BASE_URL 미설정 시 YouTube 곡의 방송 재생은 불가로
//    안내된다(fail-safe). 로컬 파일 재생·대기열·이력 등 나머지 기능은 그대로다.
//    구버전(iframe 재생) 대비 의도된 호환성 단절 — 광고 없는 출력을 확정할 수
//    없는 재생 경로는 지원 범위 밖이다.
//  - GitHub Pages는 https 오리진이므로 프록시도 반드시 https여야 한다
//    (http 프록시는 Mixed Content로 브라우저가 차단).
//  - <audio> 단순 재생은 CORS가 필요 없어 crossOrigin 속성을 설정하지 않는다
//    (설정하면 오히려 CORS 협상이 강제되어 실패 표면이 넓어진다).

const configuredProxyBase = String(import.meta.env.VITE_AUDIO_PROXY_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');

export const AUDIO_PROXY_BASE_URL = configuredProxyBase;

export const isAudioProxyConfigured = () => Boolean(configuredProxyBase);

// 프록시 스트림 URL. 호출 전 isAudioProxyConfigured() 확인은 호출자 책임.
export const audioProxyStreamUrl = (videoId) =>
  `${configuredProxyBase}/audio?v=${encodeURIComponent(String(videoId || ''))}`;

// 다음 곡 사전 해석(백그라운드, 실패 무시) — 곡 전환 지연 완화용.
export const prefetchAudioProxy = (videoId) => {
  if (!configuredProxyBase || !videoId) return;
  fetch(`${configuredProxyBase}/prefetch?v=${encodeURIComponent(String(videoId))}`)
    .catch(() => {});
};
