# 곡 준비(prepare) 파이프라인 — 계약

Stage 6c. `SONG_LIFECYCLE.md`의 `preparing → ready`를 **증거 기반**으로 만들고,
`outputSafety`를 설정 플래그가 아니라 **실제로 존재하는 바이트**로 판정한다.

## 0. 왜 이 구조인가 (설계 근거)

기존 스트리밍 프록시는 yt-dlp의 모든 불확실성(봇월·URL 만료·스로틀)이 **곡이
방송에 나가는 순간**에 판가름 났다. 곡 중간에 끊기거나 재생이 실패할 수 있고,
그 시점엔 손쓸 방법이 없다.

준비 파이프라인은 그 실패를 **전부 대기열 이전 단계로 옮긴다.** 준비에 실패한
곡은 `ready`에 도달하지 못하고, `ready`가 아니면 방송에 나갈 수 없다. 이건
프론트엔드의 검사가 아니라 **구조적 불변식**이다 — 우회할 코드 경로가 없다.

> 광고 차단 성능은 기존과 동일하다. 둘 다 같은 yt-dlp/googlevideo 오디오
> 스트림이고 광고는 플레이어가 주입한다. 이 변경의 이득은 **실패 시점**이지
> 광고가 아니다.

부수 효과:
- **Cloudflare Tunnel 불필요.** VPS가 Worker의 작업을 *폴링*하므로 인바운드
  HTTPS·공개 노출·방화벽 변경이 전혀 없다.
- **VPS가 방송 경로에서 빠진다.** 재생은 Cloudflare 엣지(R2)에서. 방송 중
  VPS가 죽어도 준비된 곡은 계속 나간다.
- **봇월 압력이 구조적으로 감소.** R2 영구 캐시라 고유 영상당 평생 1회만
  resolve한다. 노래방은 곡이 반복되므로 레퍼토리가 쌓일수록 0에 수렴한다.

## 1. R2 네임스페이스 — 세션 자산과 반드시 분리

기존 `assetKey(room, assetId)` 경로는 **세션 종속**이며 `deleteAssets()`가
세션 종료 시 삭제한다(로컬 파일용으로 올바른 동작).

준비 캐시는 **정반대**가 필요하다:

| 용도 | R2 키 | 수명 | 범위 |
|---|---|---|---|
| 세션 로컬파일 (기존) | `sessions/{room}/{assetId}` | 세션 종료 시 삭제 | 방 전용 |
| **준비 오디오 (신규)** | `audio/{videoId}` | **영구** (수동/TTL 정리) | **전역 공유** |

준비 캐시를 세션 자산으로 구현하면 방송마다 캐시가 날아가 봇월로 되돌아간다.
**절대 `session.assets`에 넣지 말 것.**

## 2. 상태 모델

준비 상태는 전역 DO 싱글턴 `PrepareQueue`(`idFromName('global')`)가 보유한다.
방 단위가 아니다 — 캐시는 모든 방이 공유한다.

```
absent      아직 요청된 적 없음
queued      작업 등록됨, 워커가 아직 안 집어감
preparing   워커가 처리 중 (claimedAt, leaseUntil)
ready       R2에 완성된 바이트 존재 (size, contentType, preparedAt)
failed      실패 (reason, failureKind, attempts, nextRetryAt)
```

`failureKind`: `botwall` | `unavailable` | `network` | `upload` | `unknown`
→ 봇월 발생률 계측이 쿠키 투입 여부를 결정하는 근거다(§6).

**리스(lease):** `preparing`은 `leaseUntil`(기본 +120초)을 갖는다. 만료되면
`queued`로 되돌린다 — 워커가 죽어도 작업이 영원히 잠기지 않는다.

**재시도:** `failed`는 지수 백오프(`nextRetryAt`). `botwall`은 더 길게(5분→
30분). `unavailable`(삭제/비공개 영상)은 **재시도하지 않는다** — 영구 실패.

## 3. HTTP 계약

### 대시보드 → Worker
```
POST /v1/prepare            {videoId}     → {status, ...}   준비 요청(스테이징 시점)
GET  /v1/prepare/{videoId}                → {status, ...}   폴링
GET  /v1/audio/{videoId}?token=...        → 오디오 바이트   <audio src> (Range/206)
```

`POST /v1/prepare`는 **멱등**이다. 이미 `ready`면 즉시 `ready`를 반환하고 작업을
만들지 않는다(캐시 히트 = YouTube 미접촉).

### VPS 워커 → Worker (`Authorization: Bearer $PREPARE_TOKEN`)
```
POST /v1/prepare/claim                    → {videoId, leaseUntil} | 204   작업 집어가기
PUT  /v1/prepare/{videoId}/bytes          → {ok}    본문=오디오 바이트, R2에 저장 후 ready
POST /v1/prepare/{videoId}/fail           {failureKind, reason} → {ok}
POST /v1/prepare/{videoId}/heartbeat      → {leaseUntil}   긴 다운로드용 리스 연장
GET  /v1/prepare/stats                    → 큐/실패율 계측 (§6)
```

`PREPARE_TOKEN`은 `wrangler secret put`으로 넣는다. 절대 프론트에 노출 금지.

### 인증 — 오픈 프록시 금지
`GET /v1/audio/{videoId}`를 무인증으로 열면 **누구나 쓰는 YouTube→오디오 변환
공개 프록시**가 된다. 반드시 게이트할 것:
- On-Air(운영): 기존 `streamAsset`과 동일한 player/display 토큰 검증 재사용.
- 직접 재생(개발): 세션이 없으므로 별도 처리. **무인증 전역 공개는 안 된다.**

## 4. VPS 워커 (인바운드 없음)

```
loop:
  job = POST /v1/prepare/claim
  if not job: sleep(5s); continue
  audio = yt-dlp(job.videoId)        # bestaudio, android_vr 우선, 파일로 저장
  if ok:   PUT /v1/prepare/{id}/bytes   (파일 스트리밍 업로드)
  else:    POST /v1/prepare/{id}/fail   (failureKind 분류)
  로컬 임시파일 삭제
```

- **아웃바운드 전용.** 열린 포트 없음, 터널 없음.
- yt-dlp 오류 문자열 → `failureKind` 분류:
  - `Sign in to confirm you're not a bot` → `botwall`
  - `Video unavailable` / `Private video` / `removed` → `unavailable` (재시도 금지)
  - 그 외 네트워크 → `network`
- 기존 `server.py`의 `_CLIENT_ATTEMPTS`(android_vr → web → mweb → ios) 재사용.
- 쿠키 파일이 존재하면 `--cookies`를 붙이고, 없으면 **붙이지 않는다**(§6).
- **이 워커는 위치 독립적이다.** VPS든 사용자 PC든 같은 코드가 돈다. 사용자
  PC(가정용 IP)에서 돌리면 봇월·쿠키 문제가 아예 존재하지 않는다. 둘을 동시에
  돌려도 되며, claim이 원자적이라 먼저 잡는 쪽이 처리한다.

## 5. 프론트엔드 게이팅

**불변식:** `ready`가 아닌 YouTube 곡은 방송 출력에 절대 올라가지 않는다.

- **스테이징 시점에 `POST /v1/prepare`** — 방송까지 시간 여유를 최대로 확보한다.
  대기열에 넣을 때쯤이면 대개 이미 `ready`.
- 대기열 항목은 준비 상태를 표시한다(준비 중 / 준비됨 / 실패). 실패한 곡은
  방송 전에 눈에 띄어야 한다 — **그게 이 설계의 존재 이유다.**
- `getYoutubeOutputSafety(entry)`가 **곡별 증거 기반**이 된다:
  `ready` → `'safe'`, 그 외 전부 `'blocked'`. 설정 플래그 판정을 폐기한다.
- 재생 시 `<audio src>` = `/v1/audio/{videoId}`. Stage 6에서 만든 미디어 이벤트
  배선(playing/ended/error/timeout)은 그대로 유지된다 — src만 바뀐다.
- 실패 문구는 광고가 아니라 준비 실패로 말해야 한다:
  "이 곡을 준비하지 못했습니다. 다시 시도하거나 다른 곡을 선택하세요."

### On-Air (Stage 6b)
`OnAirPlayer.jsx`의 YouTube iframe을 **완전히 제거**하고 `/v1/audio/{videoId}`
`<audio>`로 교체한다. 이게 실제 방송 광고 제거의 완결 지점이다(운영 환경은
`.env.production`의 `VITE_ON_AIR_BASE_URL` 때문에 항상 On-Air 모드다).
Stage 6은 직접 재생 경로만 고쳤으므로, **6b 이전까지 운영 방송엔 여전히 광고가
나간다.**

## 6. 쿠키 — 계측 후 결정

**1단계(현재): 쿠키 없이 시작.** `android_vr` + R2 영구 캐시 + 스테이징 시점
준비 + 백오프. 요청량이 "고유 영상당 평생 1회"라 봇월 압력이 근본적으로 낮다.

**계측:** `failureKind: 'botwall'` 비율을 `/v1/prepare/stats`에 노출한다. 감이
아니라 데이터로 판단한다.

**2단계(벽에 부딪히면): 쿠키 투입.** `sync-cookies.ps1`이 이미 StreamSaver의
`cookie.txt`를 30분마다 VPS로 동기화한다. 사용자가 할 일은 **버리는 서브
계정으로 한 번 로그인**하는 것뿐. 워커는 쿠키 파일이 있으면 자동으로 쓴다.

리스크: 쿠키는 만료된다(수일~수주). 계정 밴 위험이 0은 아니므로 반드시 서브
계정. 집 IP와 데이터센터 IP에서 같은 쿠키가 동시에 쓰이는 것 자체가 의심
신호다 — 그래서 쿠키는 마지막 수단이다.

**3단계(탈출구): 워커를 사용자 PC에서.** 가정용 IP → 봇월·쿠키 문제 소멸(§4).

## 7. 하위 호환

- 기존 `VITE_AUDIO_PROXY_BASE_URL`(Stage 6 스트리밍 프록시) 경로는 준비
  파이프라인이 붙으면 **제거한다.** 두 경로를 동시에 두면 "준비 안 된 곡이
  스트리밍으로 새어나가는" 우회로가 생겨 §5 불변식이 깨진다.
- 로컬 파일·대기열·이력·On-Air 세션 프로토콜은 변경 없다.
- 지원 범위: 준비되지 않은 YouTube 곡의 재생은 **지원하지 않는다**(의도된 단절).
