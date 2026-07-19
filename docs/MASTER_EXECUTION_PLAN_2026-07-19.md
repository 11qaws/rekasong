# Rekasong 현재 상태와 마스터 실행 설계

> 기준 시각: 2026-07-19 KST
> 작업 기준 폴더: `D:\Agents\rekasong\Codex\workspace`, `D:\Agents\rekasong\Codex\backend`
> 원칙: Claude/Gemini/Opencode 폴더는 읽기 전용 참고 자료다. 모든 신규 수정·커밋·테스트 산출물은 Codex 폴더에만 만든다.

## 1. 한 줄 결론

현재 배포는 준비된 오디오를 Chromium player까지 재생하는 기본 경로는 동작하지만, `player 연결`을 `OBS 송출 정상`으로 과장하고 있으며 실제 OBS 최종 출력과 마이크↔MR 싱크는 아직 증명하지 못했다. 다음 구현은 기능 추가보다 **출력 진실성, 단일 player, run 세대, 완전 다운로드, 실제 OBS 녹화 증거**를 먼저 세워야 한다.

## 2. 폴더와 에이전트별 상태

### 2.1 Claude

- frontend/Worker HEAD: `9b7f98e`, GitHub `origin/master`와 일치.
- backend HEAD: `f7959d9`, clean, remote 없음.
- 마지막 완료 작업:
  - ready 다음 곡 최대 2개 blob prefetch.
  - blob 선택이 streaming으로 덮이던 결함 수정.
  - position/seek DO 고빈도 쓰기 제거.
  - control/player 재접속 지수 백오프.
  - player/display presence와 기본 OBS 설정 UI.
- 마지막 중단점:
  - `docs/OBS_TEST_PLAN.md` 작성.
  - 생성 톤과 가창 싱크 요구 확정.
  - 톤/level meter 구현 에이전트 시작 실패.
  - 자동 회귀 Task #17 pending 상태에서 사용 한도 도달.
- 이후 새 소스 수정·커밋 없음. Claude 프로세스도 현재 없음.

### 2.2 Gemini / Antigravity

- HEAD: `cb4c80d`, 부모 `3698fea`; 최신 Claude/Codex HEAD보다 뒤에 갈라져 있음.
- 안전하게 선별돼 최신 코드에 들어온 기여:
  - position DO 쓰기 제거와 인메모리 session cache.
  - client 재접속 지수 백오프.
- 최신 코드에 넣지 않은 기여:
  - 쓰기 실패 뒤 소켓을 성공처럼 유지하는 Worker 처리. 영속 실패를 숨기고 복구를 막을 수 있음.
  - A/B Hot Standby 실험. reset/stash 상태이고 검증된 활성 설계가 아님.
- 미커밋 i18n 자동 변환:
  - 20개 파일, 약 `+3657/-2488`, locale 4개.
  - 자동 formatter 노이즈, 동적 번역 키, 잘못된 스크립트 경로, package에 없는 Babel 의존성, stale dist가 있음.
  - 현재 OBS 과제와 무관하며 그대로 병합하지 않는다.
- 위험: Gemini `origin`이 GitHub가 아니라 `D:\Agents\rekasong\Claude\workspace`다. Gemini에서 push/fetch/merge하지 않는다.

### 2.3 Codex

- 기준 HEAD는 Claude와 같은 `9b7f98e`이며, 이 문서 시점의 변경은 `D:\Agents\rekasong\Codex\workspace` working tree에만 있고 커밋·배포하지 않았다.
- Protocol v2, Worker lease/identity/fence, 공통 PlaybackEngine, source resolver, deterministic fixture, coordinator, v2 OBS player, bounded prefetch와 route split을 구현했다.
- production Worker 경로와 staging 경로를 env로 다시 분리했고 production 산출물에 staging URL이 섞이지 않는지 검사했다.
- 최신 검증 결과:
  - 전체 자동 테스트 `358/358` PASS.
  - lint PASS, 기존 무관 warning 6.
  - production build PASS, 500KiB chunk/CSS import warning 0.
  - OBS v2 선택 artifact raw `376,933B`, gzip `112,695B`, budget PASS.
  - v2 브라우저 cold-route 전송 `115,317B`, 초기 DOM 15개, 외부 font 요청 0.
  - 4Hz heartbeat 10초 동안 DOM mutation 0, React-facing coordinator publish 0.
- 과거 staging smoke 11/11과 10초 blob 재생은 초기 인수 증거로 보존하되 현재 Protocol v2/실제 OBS 증거로 승격하지 않는다.
- 실제 OBS 녹화, stream artifact, CEF 장시간 memory, 마이크↔MR drift는 미검증이다.

### 2.4 Opencode 및 Gemini artifacts

- `Opencode`는 빈 폴더다.
- Gemini artifacts는 7월 14~15일의 UX 문서·스크린샷 중심이며 현재 On-Air 구조보다 오래됐다.
- “완성형”, “완벽 검증” 같은 과거 문구는 현재 상태 근거로 사용하지 않는다.

### 2.5 현재 코드 아키텍처

```text
GitHub Pages React dashboard
  ├─ rekasong.pages.dev Functions: 검색·제목·Meloming·Setlink·sync
  └─ Session Worker
       ├─ SessionRoom DO: control/player/display WebSocket + transport
       ├─ PrepareQueue DO: YouTube 준비 job
       └─ R2
            ├─ audio/{videoId}: 전역 준비 오디오
            └─ sessions/{room}/...: 임시 local media

VPS prepare worker
  └─ yt-dlp → WARP → R2 upload

OBS
  ├─ display browser source: 화면 정보
  └─ player browser source: <audio>/<video> 출력
```

- frontend는 React 19 + Vite 8이며 production API와 Session Worker가 서로 다른 Cloudflare 배포다.
- `Dashboard.jsx` 약 70KB가 코디네이터·상태·입력·재생을 함께 들고 있고, Worker `index.js`도 약 38KB 단일 파일이다.
- production은 On-Air Worker 경로를 사용한다. direct mode는 개발/호환 경로로 남아 있다.
- YouTube 방송 출력에는 iframe을 쓰지 않고 준비된 R2 audio만 사용한다. iframe은 staging 미리듣기에만 남아 있다.
- backend prepare worker는 재인코딩 없이 `bestaudio` 파일을 저장하므로 실제 sample rate/codec은 원본에 따라 달라질 수 있다.

## 3. 현재 실행·배포 상태

| 대상 | 현재 상태 | 판정 |
|---|---|---|
| `127.0.0.1:5000` | listener 없음 | Claude staging frontend 내려감 |
| `127.0.0.1:5001`, `:5100` | listener 없음 | Codex dev/production preview 검증 후 종료됨 |
| OBS | 프로세스 없음, 4455 listener 없음 | 실제 OBS 재검증 불가 상태 |
| GitHub Pages | HEAD `9b7f98e` 배포 workflow 성공, HTTP 200 | prod frontend 배포됨 |
| `rekasong.pages.dev` | root/search HTTP 200 | production API 도달 가능 |
| prod/staging Worker | root 404, 보호 audio 401 | edge 도달 가능; DO session 건강은 미검증 |
| VPS prepare service | active | **현재 target=staging** |

가장 먼저 다룰 운영 위험은 VPS가 staging만 폴링한다는 점이다. 기존 prod R2 캐시는 재생되지만 새 prod prepare job은 소비되지 않을 수 있다. 테스트 때마다 단일 서비스의 target을 뒤집는 방식은 중단 사고를 반복하므로 prod/staging 서비스를 분리해야 한다.

## 4. 무엇이 검증됐고 무엇이 아닌가

### 검증됨

- ready YouTube cold load가 Worker streaming URL로 실제 재생됨.
- prefetch 완료곡이 `blob:`으로 실제 재생됨.
- prefetch 미스 ready 곡이 streaming fallback으로 실제 재생됨.
- pause와 player `playing/position` 이벤트 왕복.
- player/display presence와 dashboard reload snapshot 복원.
- 일반 브라우저 autoplay 차단 시 player가 paused로 남고 dashboard가 실패를 인식함.

참고(현재 인수 증거에서 제외): 과거 실제 OBS에서 `Local file` 해제, `Control audio via OBS` 체크, unmuted `Rekasong` mixer signal을 한 번 눈으로 관찰했다. `checkId`·fixture·Codex session 귀속·녹화 artifact가 없어 G3 합격으로 사용하지 않는다.

### 검증되지 않음

- 해당 OBS source가 Codex test session과 정확히 페어링됐는지.
- OBS program/recording track에 테스트 PCM이 실제 들어갔는지.
- 마이크와 MR의 고정 offset 및 10분 drift.
- player 중복 연결, run retry 늦은 이벤트, socket 순단 재동기화.
- 첫 곡/로컬 자산 streaming 중 네트워크 단절.
- 실제 OBS CEF의 seek, source refresh, scene 전환, OBS 재시작.
- 모든 입력원(검색 URL/Meloming/Setlink/local audio/local video)의 동일 회귀.
- prod DO가 일일 한도 리셋 뒤 실제 session을 정상 생성하는지.

## 5. 상태 모델을 네 층으로 분리한다

현재의 가장 큰 문제는 서로 다른 증거를 한 상태로 부르는 것이다. 목표 모델은 다음과 같다.

| 상태 | 예시 | 권위 |
|---|---|---|
| `desiredTransport` | play/pause/seek 요청 | control 명령 |
| `confirmedPlayback` | loading/playing/paused/ended/error | 활성 player 실제 이벤트 |
| `playerPresence` | 연결/미연결/중복/미확인 | Worker lease |
| `outputVerification` | widget PCM/OBS meter/녹화/마이크 싱크 | 각 검증 단계의 별도 증거 |

명령을 보냈다는 이유로 `confirmedPlayback=playing`으로 바꾸지 않는다. player presence만으로 `outputVerification=passed`가 되지 않는다.

## 6. P0 — 즉시 처리할 작업

### P0-01. Codex 작업 기준점과 push 충돌 방지

- 목표: Claude가 계속 작업해도 Codex 변경이 충돌하거나 원본을 덮지 않게 한다.
- 방법:
  1. Codex에서 `codex/obs-output-verification` 전용 브랜치를 만든다.
  2. Codex는 master에 직접 push하지 않는다.
  3. 매 작업 시작 시 GitHub master를 fetch한 뒤 Codex 브랜치에서 충돌을 확인한다.
  4. 실제 prod push 담당은 한 시점에 한 agent만 맡는다.
- 완료 기준: Codex branch/upstream 명시, Claude/Gemini 경로를 향한 remote 없음, dirty baseline 커밋 분리.
- 작업 폴더: `Codex/workspace`만.

### P0-02. prod/staging prepare worker 분리

- 목표: staging 시험 때문에 prod 신규 곡 준비가 멈추지 않게 한다.
- 방법:
  1. `rekasong-prepare-prod.service`를 항상 켠다.
  2. `rekasong-prepare-staging.service`는 별도 env/token/base URL로 만들고 시험 중에만 켠다.
  3. 두 서비스는 WARP를 공유하되 concurrency와 poll interval을 제한한다.
  4. 서비스 로그 첫 줄과 health 출력에 `environment=prod|staging`을 강제로 기록한다.
  5. dashboard 또는 runbook에서 현재 target을 확인할 수 있게 한다.
- 완료 기준: 두 환경의 job을 각각 큐잉했을 때 서로 다른 서비스가 claim하고, prod 서비스가 staging 시험 중에도 계속 active.
- 작업 폴더: `Codex/backend`; 실제 VPS 반영은 별도 승인 단계.

### P0-03. 연결 문구의 진실성

- 목표: 일반 브라우저 연결을 OBS 송출 성공으로 오인하지 않게 한다.
- 방법:
  - `OBS 플레이어 연결됨` → `플레이어 클라이언트 연결됨`.
  - 설명: “재생 명령을 받을 페이지가 열렸습니다. OBS 오디오 입력은 아래 점검에서 별도 확인합니다.”
  - output check 전에는 `OBS 송출 확인 완료`를 절대 표시하지 않는다.
- 완료 기준: 일반 player 탭으로 presence를 만들었을 때 UI가 OBS 성공을 주장하지 않음.
- 작업 폴더: `Codex/workspace`.

### P0-04. On-Air protocol v2 — run 세대와 단일 player

- 목표: 늦은 이벤트와 중복 player echo를 구조적으로 차단한다.
- 명령 계약:

```text
commandId + entryId + runId + leaseEpoch + targetPlayerInstanceId
```

- player event 계약:

```text
eventId + entryId + runId + leaseEpoch + playerInstanceId
+ type + mediaTime + monotonicTime + readyState
```

- 방법:
  1. player 시작 시 영속적인 `playerInstanceId`를 생성한다.
  2. Worker가 단일 active player lease와 `leaseEpoch`를 발급한다.
  3. standby player는 명령을 받지 않고 소리를 내지 않는다.
  4. Worker는 active lease·현재 run과 모두 일치하는 event만 반영한다.
  5. `eventId`를 짧은 window에서 dedupe한다.
  6. protocol v1/v2를 한 배포 동안 함께 받아 rollout 순서를 안전하게 만든다.
- 완료 기준: OBS+일반 탭을 동시에 열어도 한 player만 재생; 같은 entry retry의 이전 ended/error가 새 run에 영향 0.

### P0-05. 명령 상태와 확정 상태 분리

- 목표: load/play 명령 직후 거짓 `재생 중` 표시를 없앤다.
- 방법:
  - Worker transport에 `requestedStatus`와 `confirmedStatus`를 분리한다.
  - load/play 뒤 UI는 `재생 시작 요청` 또는 `starting`.
  - 활성 player `playing` event 후에만 `playing` 확정.
- 완료 기준: player autoplay 실패 시 UI가 한 순간도 확정 `재생 중`을 표시하지 않음.

### P0-06. WebSocket 순단 재동기화 정책

- 목표: 제어 연결만 끊겼을 때 MR을 갑자기 멈춰 가창 싱크를 깨지 않으면서 상태도 거짓으로 만들지 않는다.
- 정책:
  - 같은 player 페이지의 socket만 끊김: media는 계속 재생, Worker/UI는 `output unknown`으로 표시.
  - 재접속: player가 실제 run/currentTime/paused를 `resume_hello`로 보내고 Worker가 이를 채택.
  - player instance 자체가 교체됨(OBS source refresh/crash): 이전 run을 자동으로 대충 seek해 이어붙이지 않는다. `player replaced`로 실패 확정 후 사용자가 재시작/버리기를 고른다.
  - Worker는 socket close만으로 `paused`를 확정하지 않는다.
- 완료 기준: 네트워크 5초 순단 중 media clock 연속, 재접속 뒤 dashboard가 실제 값으로 수렴; source refresh는 조용한 이중 재생 없이 명시적 복구 UI.

### P0-07. finish/discard 확인 프로토콜

- 목표: skip/discard가 player 확인 전에 완료되는 과도기 폴백을 제거한다.
- 방법:
  - `finish` → player가 끝으로 진행 → 실제 `ended` → `completed`.
  - `discard` → player pause/unload → `discarded` → 이력 없이 제거.
  - timeout 시 `failed`로 두고 재시도/버리기 선택; 자동 완료 금지.
- 완료 기준: 늦은 ended, timeout, 중복 command에서도 이력과 auto-next가 정확히 한 번만 변함.

### P0-08. 방송 안전 모드 — 현재 곡 완전 수신 관문

- 목표: 노래 방송에서 곡 중간 network stall 가능성을 제거한다.
- 방법:
  1. `prepare`와 `play`를 분리한다.
  2. audio는 Worker/R2 response body가 전부 끝나 `blob:`이 된 뒤 `cached`로 확정한다.
  3. 방송 안전 모드에서는 `cached` 전 play를 차단한다.
  4. 현재곡 1 + 다음곡 cache 1의 byte 합계와 in-flight를 계측한다. 다음곡 cache는 64MiB, 동시 materialize는 1개로 제한한다.
  5. 큰 local video는 별도 정책으로 분리한다. 완전 수신 불가능하면 `streaming — 싱크 보장 안 됨`을 명시하고 audio 인증 대상에서 제외한다.
- 완료 기준: 첫 곡과 local audio도 network 차단 후 끝까지 진행; UI가 cached/streaming을 정확히 표시.

### P0-09. OBS 전용 페이지 경량화와 soak

- 목표: 방송 내내 유지되는 CEF renderer가 Dashboard·display 기능 때문에 느려지거나 메모리 압박으로 중단되지 않게 한다.
- 진행 상태:
  1. [x] App route, Widget mode, v2 player를 각각 lazy boundary로 분리한다.
  2. [x] v2 graph에서 Dashboard/Firebase/framer-motion/react-youtube/legacy player와 외부 font를 제외한다.
  3. [x] production cold-route artifact 예산을 raw 450KiB, gzip 130KiB로 자동 검사한다. 현재 raw 376,933B/gzip 112,695B다.
  4. [x] heartbeat 4Hz가 React render를 만들지 않는지 회귀 테스트한다.
  5. [ ] idle 10분, post-GC heap 30분, 곡 전환 100회, 실제 OBS CEF 60분을 release 환경에서 측정한다.
  6. [x] OBS direct LOAD와 prefetch를 각각 64MiB로 제한하고 retained 128MiB 상한을 둔다. 실제 transient/CEF process memory 계측과 disk-backed 초과 경로는 남아 있다.
- 완료 기준: artifact 예산, 외부 장식 요청 0, idle long task 0, 평균 CPU 1% 미만, heap warm baseline 대비 16MiB 이내, CEF crash/dropout 0.

## 7. P0 — OBS 출력 점검 기능 설계

### 7.1 결정적 테스트 PCM

- 별도 oscillator만 울리지 않는다.
- 48kHz deterministic WAV를 코드로 생성한다.
- 실제 곡과 같은 media element 및 Web Audio destination을 사용한다.
- 예시 패턴: 짧은 880Hz click 3회 + 긴 440Hz tone 1회. 패턴 version을 고정한다.
- active 방송 run 중에는 실행 금지. 설정 화면의 무곡 상태에서만 시작한다.

### 7.2 진단 프로토콜

```text
audio_check_start {checkId, patternVersion, runId}
audio_check_state {loaded|playing|ended|error}
audio_check_level {checkId, sequence, rms, peak, mediaTime}
audio_check_cancel {checkId}
```

- level event는 고빈도 DO storage에 쓰지 않고 control로만 relay한다.
- media element source node는 요소당 한 번만 만들고 analyser와 destination에 연결한다.
- 내부 meter는 widget PCM까지만 증명한다고 UI에 명시한다.

### 7.3 설정 wizard

1. `Local file` 해제 확인.
2. `Control audio via OBS` 체크 확인.
3. app meter 움직임 확인.
4. OBS의 정확한 source mixer meter 움직임 확인.
5. 10초 OBS 녹화에서 패턴 존재 확인.
6. 결과를 다음으로 구분:
   - `player connected`
   - `widget PCM passed`
   - `OBS mixer user-confirmed`
   - `OBS recording verified`

`들려요` 버튼 하나로 전체를 기술적으로 통과 처리하지 않는다. 장치·OBS profile·sample rate가 바뀌면 다시 확인하도록 로컬 certification metadata를 만료한다.

### 7.4 선택적 obs-websocket

- 1차 MVP는 수동 OBS meter/녹화 확인.
- 2차로 obs-websocket을 선택 연결해 source 설정, mute/track, input meter, 녹화 start/stop, 결과 경로를 자동 수집한다.
- 비밀번호를 앱 서버나 로그에 보내지 않고 localhost 연결에만 사용한다.

## 8. P0 — 마이크↔MR 싱크 인증 설계

### 8.1 기준 fixture

- 10분 PCM track.
- 시작·중간·끝을 구분하는 서로 다른 marker sequence.
- 1초 click train과 구간 ID를 포함.
- 일반 노래가 아니라 generated fixture라 재현성과 권리 문제가 없다.

### 8.2 실제 장비 경로

- player fixture를 OBS browser source로 재생.
- 같은 reference를 실제 mic chain에 virtual cable, hardware loopback 또는 스피커→마이크로 입력.
- OBS에서 MR과 mic를 가능하면 별도 track에 녹화.
- 실제 방송과 같은 sample rate, filters, monitoring, audio device를 사용.

### 8.3 분석기

- `ffmpeg`로 OBS container의 각 track을 PCM WAV로 추출.
- marker detection + cross-correlation으로 start/middle/end offset 계산.
- JSON/Markdown report에 다음을 기록:
  - 누락/중복 marker.
  - 고정 offset.
  - start→end drift.
  - click interval p95.
  - dropout 구간.

초기 합격선:

- marker 누락·중복 및 청취 가능한 dropout 0.
- 보정 후 mic↔MR fixed offset `±20ms` 이내.
- 10분 상대 drift `10ms` 이내.
- click interval error p95 `5ms` 이내.

첫 실제 가창 청취 뒤 기준을 더 엄격하게 조정한다. OBS `Sync Offset`을 바꾼 뒤 반드시 재녹화한다.

## 9. 테스트 체계 설계

### T-01. 단위 테스트

- QueueEntry/PlaybackRun 전이.
- run/lease event guard.
- display projection whitelist.
- prepare state normalization.
- blob lifecycle와 byte budget.
- test PCM generator의 sample 수·marker 위치.

### T-02. 격리 Worker 통합 테스트

- local Wrangler/Miniflare + 임시 DO/R2 state.
- session/presence/lease/snapshot/finish/discard/end_session.
- duplicate player와 late event.
- DO write count assertion.
- HTTP Range/401/CORS/size cap.

### T-03. browser E2E

- deterministic WAV fixture 사용.
- autoplay 허용 성공 경로와 일반 browser autoplay 차단 경로 둘 다 실행.
- play/pause/seek/ended/error.
- full blob 후 network offline 완주.
- WS 5초 차단 후 same-instance resume.
- source refresh/new-instance failure.
- media clock 100ms sample, waiting/stalled/dropout 수집.

### T-04. source matrix

- YouTube 검색.
- YouTube URL 직접 입력.
- Meloming.
- Setlink.
- local audio.
- local video.

각 입력원은 `stage → prepare → queue → play → seek → finish/discard → history` 동일 계약을 통과해야 한다.

### T-05. 실제 OBS matrix

- OBS CEF codec.
- mute/monitor/track routing.
- scene hide/show/switch.
- source refresh와 OBS restart.
- duplicate source.
- seek와 곡 전환의 click/gap.
- 10초 output recording.
- 10분 mic↔MR certification.

### T-06. CI

- `npm ci` → lint → unit → local integration → build 순서.
- 실패 시 GitHub Pages deploy 금지.
- Playwright trace, console log, protocol log, test report를 artifact로 저장.
- 공유 staging smoke는 수동/예약 실행만 하고 부하 테스트는 금지.
- backend Python syntax만이 아니라 queue/claim/download/upload/failure classification 테스트를 저장소에 보존.

## 10. P1 — 운영·보안·비용

### P1-01. DO/R2 남용 방지

- public session creation과 prepare 요청에 per-IP/session rate limit.
- session 수, outstanding prepare 수, upload bytes cap.
- reconnect storm과 duplicate player metric.
- DO writes/test budget을 dashboard 또는 log에서 관측.

### P1-02. WARP/prepare monitoring

- systemd active, WARP status, last successful claim, queue oldest age, botwallRate를 주기 확인.
- 경계 초과 시 알림.
- staging과 prod 지표를 분리.
- WARP 차단 시 residential proxy fallback은 문서화만 하고 자동 전환은 별도 검증 뒤 시행.

### P1-03. R2 lifecycle와 권리 검토

- `audio/{videoId}`가 현재 영구 캐시이므로 저장량, 미사용 eviction, 삭제/비공개/takedown 절차를 정의.
- 서비스 이용 정책·저작권·방송 사용 권한을 제품 운영 전에 별도 검토.
- test는 상업곡 대신 generated fixture를 기본으로 전환.

### P1-04. token과 로그

- player/control token을 test output, trace, screenshot, 문서에 남기지 않는다.
- OBS URL은 민감 정보로 취급.
- staging/prod env와 account/token을 분리하고 template만 버전 관리.
- session 종료와 token 만료를 명시적으로 검증.

### P1-05. 배포와 rollback

- Worker protocol 변경은 staging에서 `v1+v2` 호환 배포 → frontend staging → prod Worker → prod frontend 순서.
- 각 단계 smoke와 rollback SHA를 기록.
- stable staging frontend를 만든다. 권한이 준비되기 전에는 Codex local `:5100`만 사용.
- GitHub Actions는 `npm install` 대신 lockfile 기준 `npm ci` 사용.

### P1-06. backend 정리

- 준비 파이프라인 전환이 확정되면 구 streaming `server.py` 제거.
- `README.md`, `HANDOFF.md`, `FIELD_GUIDE.md`의 쿠키/Tunnel/Claude 경로 충돌 정리.
- 과거 테스트 결과만 있고 코드가 없는 backend 검증을 실제 test 파일로 복원.

## 11. P1/P2 — 기능·품질·문서

### P1-07. display projection 수정

- On-Air projection과 Widget 소비 필드를 하나의 schema로 공유.
- `artist/source/phase/isPlaying/completionReason`을 whitelist에 맞춰 보존.
- schema version과 backward compatibility test 추가.

### P1-08. 장애 복구 UX

- `control disconnected`, `player disconnected`, `output unknown`, `player replaced`, `OBS check expired`를 서로 다른 문구와 행동으로 표시.
- 실패 곡은 자동 완료/자동 스킵하지 않고 재시작·버리기 제공.
- local file reload 소실, queue undo, large file 거절을 명시.

### P1-09. Dashboard 장시간 세션 예산

- history는 최근 100~200행만 활성 state/DOM에 두거나 virtualization하고 오래된 기록은 IndexedDB로 archive한다.
- 로컬 감상 Blob은 최근 3~5개 또는 합계 256MiB 같은 count·byte 상한을 두고 object URL 생성·회수 수를 계측한다.
- 1,000곡 fixture에서 실제 렌더 row 100 이하, 조작 p95 100ms 이하, localStorage payload 1MiB 이하를 합격 기준으로 둔다.
- speaker↔OBS 500회 전환에서 control socket 1개, audible player 1개, stale fetch 0을 확인한다.
- 숨긴 queue/history도 전체 `.map()`으로 DOM을 유지하지 않게 한다.

### P2-01. 문서 진실원 정리

- `PROJECT_STATUS.md`는 7월 16일 상태라 이미 구현된 항목을 미구현으로 적는다.
- `ONAIR_CONNECTION.md`의 presence=OBS 표현을 낮춘다.
- 개발 로그의 “라이브 미검증” 뒤에 실제 staging 검증 링크를 연결한다.
- 이 문서를 현재 master status index로 삼고 완료될 때마다 evidence 링크를 갱신한다.

### P2-02. 코드 부채

- `Dashboard.jsx` 약 70KB, Worker 약 38KB를 state machine/protocol/media/cache/UI 모듈로 분리.
- unused `LivePanel`, Firebase dependency, 오래된 assets와 scratch script를 실제 참조 확인 뒤 정리.
- 기존 lint warning 6건 제거.
- 완료: route/dynamic import 분리로 OBS v2 경로에서 heavy module을 제외했고 production build의 500KiB chunk warning을 제거했다. Dashboard/Worker 자체 모듈 분리는 계속 진행한다.

### P0-X / P2-03. i18n — 지금부터 적용할 교차 규칙, 전체 이관은 후속 작업

OBS/프로토콜 검증과 번역 품질 검증은 서로 다른 게이트로 유지한다. 다만 **지금부터 새로 만들거나 수정하는 사용자 노출 텍스트는 번역 가능한 구조로 작성**한다.

- Gemini dirty diff를 통째로 옮기지 않는다. 자동 AST wrapping과 원문 전체를 key로 쓰는 방식도 재사용하지 않는다.
- `output.obs.player_connected` 같은 의미 기반 semantic key를 사용한다. 한국어 문장 자체를 key로 쓰지 않는다.
- JSX text뿐 아니라 `title`, `aria-label`, toast, confirm, empty/error/loading/status, wizard, notification을 모두 catalog 대상으로 본다.
- 동적 값은 문자열 결합 대신 named interpolation을 사용한다. 곡 수·시간·날짜·숫자는 pluralization과 `Intl` formatter를 사용한다.
- 상태와 저장 데이터에는 번역문을 넣지 않는다. `statusCode`, `errorCode`, structured detail을 저장하고 최종 UI 경계에서 번역한다.
- Worker/API의 신규 v2 응답은 한국어 오류 문장 대신 안정적인 code와 구조화 detail을 보낸다.
- 기본·fallback locale은 한국어다. 번역이 없는 언어를 selector에 노출하지 않는다.
- 한국어/영어/일본어/레카어는 key completeness, placeholder parity, layout, 원어민/제품 톤 QA 뒤 각각 활성화한다.
- pseudo-locale로 잘림, 버튼 폭, modal overflow, 빠진 key를 자동 점검한다.
- catalog 누락, locale별 placeholder 불일치, orphan key, 신규 hardcoded UI 문자열을 CI에서 검사한다.
- 현재 OBS Phase 0 copy를 첫 정식 vertical slice로 이관하고, 이후 화면별로 Search → Staging → Queue → Playback → Widget → 오류/백엔드 순서로 옮긴다.

## 12. 실행 순서

### 단계 A — 기준점과 운영 복구

1. Codex 전용 브랜치.
2. 현재 OBS docs/smoke를 독립 커밋.
3. VPS prod/staging service 분리 설계·검증.
4. stale 문서와 Claude 경로 정리.

### 단계 B — 회귀를 먼저 고정

1. deterministic fixture.
2. unit/local Worker/browser test 기반.
3. 현재 알려진 late-event/duplicate/disconnect 실패 테스트를 먼저 작성.
4. semantic message catalog와 translator facade를 만들고 이후 신규 UI copy에 의무 적용.

### 단계 C — protocol v2

1. runId/playerInstanceId/lease.
2. requested vs confirmed state.
3. reconnect resume.
4. finish/discard acknowledgement.
5. display schema.

### 단계 D — 방송 안전 media

1. prepare/play 분리.
2. 현재곡 완전 blob 관문.
3. byte budget과 local media 정책.
4. network-offline 완주 test.

### 단계 E — OBS 점검 제품화

1. deterministic WAV + analyser.
2. dashboard wizard와 정확한 문구.
3. actual OBS mixer/10초 recording.
4. 결과 기록과 만료 조건.

### 단계 F — 카라오케 싱크 인증

1. 10분 fixture.
2. mic loopback/OBS separate tracks.
3. 파형 분석기.
4. offset 보정 및 재시험.

### 단계 G — 확장 회귀와 운영

1. source matrix.
2. CI gating과 artifacts.
3. monitoring/rate limit/R2 lifecycle.
4. 기존 화면 전체 i18n vertical migration, pseudo-locale, 번역 QA.
5. code split과 UI polish.

## 13. 지금 하지 않을 것

- Gemini dirty i18n을 통째로 병합하지 않는다.
- 검증되지 않은 Hot Standby stash를 살리지 않는다.
- player presence를 OBS 인증으로 포장하지 않는다.
- 삐 소리가 들렸다는 것만으로 mic↔MR 장시간 싱크를 통과시키지 않는다.
- 공유 staging에서 장시간/부하 테스트로 DO 무료 한도를 다시 소진하지 않는다.
- Claude/Gemini 폴더의 파일, branch, remote, process를 수정하지 않는다.
- 검증 없이 prod Worker/frontend를 배포하지 않는다.

## 14. 첫 번째 완료 묶음의 정의

첫 구현 묶음은 다음을 모두 만족할 때 완료다.

1. Codex 전용 branch와 테스트 기준점이 있다.
2. UI가 player 연결과 OBS 송출 확인을 구분한다.
3. protocol v2가 late event와 duplicate player를 차단한다.
4. 첫 audio도 완전 blob 뒤에만 play된다.
5. app meter → OBS mixer → 10초 recording의 설정 관문이 실행된다.
6. 실제 장비의 10분 mic↔MR report가 합격선을 만족한다.
7. 모든 결과에 재실행 가능한 test command와 raw artifact가 남는다.

이 묶음 전에는 “OBS 송출과 싱크가 보장됐다”고 릴리스 노트에 쓰지 않는다.
