# WEB ↔ OBS 남은 검증 실행 계획

> 기준일: 2026-07-20 KST
>
> 원칙: 앱 플레이어가 소리를 재생했다는 증거와 OBS 믹서·녹화·최종 방송에 소리가 들어갔다는 증거를 섞지 않는다.
> 자동 검증이 통과해도 실제 OBS가 필요한 G3~G6은 완료로 표시하지 않는다.

## 0. 2026-07-22 기준선 변경

- **Speaker**는 일반 웹 플레이어다. 각 탭이 독립적으로 재생하고, Worker player 후보·단일 lease·heartbeat·다른 탭 control 상태 때문에 버튼이나 transport를 잠그지 않는다.
- **OBS**만 서버가 관리하는 단일 출력 경로다. 정확히 한 OBS Browser Source, runtime sourceActive, 출력 lease, 실제 playback/stop 증거를 요구한다.
- Speaker→OBS는 현재 로컬 곡을 끝내거나 버린 뒤에만 허용한다. OBS→Speaker는 즉시 로컬 선택으로 바꾸고, 기존 OBS run에는 STOP을 best-effort로 보내되 그 결과로 Speaker를 잠그지 않는다. 준비된 OBS 연결은 silent-ready로 유지할 수 있다.
- OBS 제어 소켓이 일시적으로 끊기거나 장면 전환으로 sourceActive/sourceVisible이 false가 되어도 재생 중인 media graph를 멈추지 않는다. 실제 Browser Source 종료는 socket close, 명령 전달 실패, terminal teardown으로 판별한다.
- OBS heartbeat는 10초 간격의 관측 정보다. warning/stale 표시는 가능하지만 established route의 해제·재생 차단·durable watchdog 근거로 쓰지 않는다.

사용자 관점에서 현재 확정된 것:

- 앱을 열면 복잡한 서버 경로 선택 없이 `스피커 송출 중`으로 시작한다.
- Speaker는 여러 탭·창에서 각각 재생할 수 있고 한 탭의 충돌/복구 상태가 다른 탭을 잠그지 않는다.
- OBS 제어권이 읽기 전용·재연결·unknown이어도 Speaker 버튼과 로컬 재생·일시정지·탐색·볼륨은 잠기지 않는다.
- 헤더에는 현재 출력과 설정만 남고, 경로 선택·OBS 점검·복구는 설정 안에 있다.
- YouTube/Search/List/Setlink/Meloming 탭과 곡 목록은 키보드와 클릭으로 조작할 수 있다.

아직 확정하지 않은 것:

- OBS 믹서, 실제 녹화 트랙, 비공개 방송, 라이브 마이크↔MR 장시간 싱크는 실제 OBS 증거가 필요하다(G3~G6).
- 모바일 OS별 백그라운드 정책이 로컬 Speaker의 실제 오디오를 얼마나 오래 유지하는지는 기기 수동 검증이 필요하다.
- 전체 화면 번역, locale 선택기, pseudo-locale은 기반만 적용했고 전체 이관 전이다.

## 1. 이번 단계에서 자동으로 확정한 범위

### 출력 경로 UI와 첫 연결 (2026-07-22 이전 서버 Speaker 방식 — 이력)

- 첫 화면의 `스피커`와 `OBS 방송` 버튼은 세션 준비 중에도 잠기지 않는다.
- 첫 준비 과정에서 누른 최신 선택을 한 건만 기억하고, 이 탭의 쓰기 제어권이 확인된 뒤 한 번만 실행한다.
- 실제 경로가 확인되기 전에는 선택 버튼을 활성 체크하지 않는다. 대신 `aria-busy`와 `스피커 연결 중` 또는 `OBS 연결 중`으로 요청 접수 상태를 구분한다.
- 첫 연결이 끝난 적이 있는 탭의 재연결, 다른 탭 제어, 알 수 없는 상태, 연결 시간 초과에서는 선택을 예약하지 않는다. 이 경우 기존 fail-closed 잠금을 유지한다.
- 예약은 당시 세션 신원에 묶인다. 세션이 교체되거나 종료·무효화되면 자동 실행하지 않고 폐기한다.
- OBS 플레이어가 없으면 `OBS 플레이어 없음`, 중복이면 중복 상태를 표시하며 이후 후보가 생겨도 자동 활성화하지 않는다.

실제 Chrome 재현 결과:

- 세션 생성 POST를 인위적으로 4.5초 지연해도 첫 화면에서 두 버튼 모두 `aria-disabled=false`.
- 스피커 클릭 접수 피드백 429ms, 이때 `aria-checked=false`, `aria-busy=true`.
- 정확한 제어권과 현재 페이지 소유 스피커 신원 확인 뒤 7,892ms에 `스피커 송출 중`, `aria-checked=true`.
- 준비 중 스피커를 누른 뒤 OBS로 바꾼 경우 OBS 선택만 남았고, 준비 완료 후 `OBS 플레이어 없음`으로 종료. 스피커 자동 활성화 0건.
- 위 시나리오의 page error, console error, HTTP 4xx/5xx, failed request는 모두 0건.

### 로컬 프리뷰 연결

- Vite 개발 서버뿐 아니라 `vite preview`에도 `/api/sync` 미들웨어를 연결했다.
- 로컬 프로덕션 프리뷰에서 POST→GET 왕복과 브라우저 폴링을 확인했다.
- 기존 `http://127.0.0.1:5000/api/sync` 404와 이에 따른 콘솔 오류를 제거했다.
- GitHub Pages에서는 로컬 전용 `/api/sync`를 호출하지 않으며 기존 원격 동기화 경로를 유지한다.

### 이미 완료된 방송 안전 검증

- 단일 출력 lease, deactivate-before-activate, 중복 후보 차단, 다른 탭 제어권 분리.
- OBS는 정확한 단일 `playerInstanceId`만 연결 대상으로 허용. Dashboard Speaker는 더 이상 player 후보로 등록하지 않음.
- OBS source active/visible 상실 즉시 실제 media pause·detach, 자동 재생 금지, 명시적 강한 정지 증거 뒤에만 안전 복구.
- Protocol v2 실제 Chrome에서 8초 PCM fixture 재생, 16개 marker, waiting/stalled/error/backwards 0.
- 10분 READY idle에서 long task 0, DOM mutation 0, 평균 main-thread CPU 0.199267%.
- OBS 정적 경로 번들(2026-07-22): raw 380,775B, gzip 115,807B, brotli 101,470B. 예산 raw 450KiB, gzip 130KiB 이내.

## 2. 실제 OBS 없이는 끝낼 수 없는 필수 관문

| 관문 | 확인할 결과 | 필요한 증거 | 완료 조건 |
|---|---|---|---|
| G3 정확한 OBS 믹서 입력 | 연결한 On-Air Browser Source가 실제 믹서에 들어옴 | 소스 이름, `Control audio via OBS`, mute·monitor·scene별 meter 영상/기록 | 정확한 소스 meter와 최종 output meter가 시험 박자대로 움직임 |
| G4 녹화 파일 | 앱 신호가 최종 녹화 트랙에 존재 | 10초 녹화 원본과 PCM/파형 분석 | clipping 0, 20ms 초과 dropout 0, marker 누락·중복 0 |
| G5 비공개 방송/VOD | 인코더·ingest 이후에도 신호가 남음 | 비공개 스트림 또는 VOD 원본 | 최종 방송 오디오 트랙에서 시험 신호 검출 |
| G6 보컬↔MR 싱크 | 라이브 마이크와 반주가 장시간 맞음 | 10분 분리 트랙과 상호상관 분석 | 보정 후 offset ±20ms, 시작↔끝 drift 10ms 이내, jitter p95 5ms 이내 |

G3에서 반드시 바꿔 보아야 할 항목:

- `Control audio via OBS` 체크 전·후.
- 소스 mute, 모니터링 끔, 모니터만, 모니터 및 출력.
- 소스 hide/show, scene 전환, source refresh, OBS 재시작.
- pause, seek, 곡 전환 때 click·gap·중복 재생 여부.
- 같은 플레이어 URL이 다른 Browser Source나 scene에 중복 등록된 경우의 명시적 차단 안내.

## 3. 남은 자동·반자동 검증

### P0 — 배포 환경의 안전성

1. 별도 staging 계정 자격을 준비해 최신 Protocol v2 smoke와 safety smoke를 원격 Worker에서 재실행한다.
2. 실제 Cloudflare Durable Object eviction/rehydration과 alarm 자동 delivery·retry 뒤 R2 정리까지 확인한다. 현재는 handler 시뮬레이션 증거만 있다.
3. 배포 직후 공개 Pages에서 새 프로필의 즉시 Speaker 상태, 다중 탭 독립 재생, OBS 미연결 실패, OBS 연결 후 전환/복귀를 다시 확인한다.

### P1 — 장애·장시간·부하

1. offline/online, WebSocket 1011, PC sleep/resume, background throttle를 실제 브라우저에 주입한다.
2. 일반 Chrome 30분과 OBS CEF 60분 soak에서 crash, dropout, 중복 player, post-GC heap, working set을 기록한다.
3. hint 교체와 곡 전환 100회: stale fetch 0, retained Blob 1개, aggregate Blob 예산 준수.
4. Speaker↔OBS 전환 500회: OBS 전환 중 local/OBS 동시 audible 0, OBS control socket 1개, 자동 fallback 0. 여러 Speaker 탭의 독립 재생은 허용한다.
5. history 1,000곡: 실제 render row 100 이하 또는 virtualization, 조작 p95 100ms 이하, localStorage 1MiB 이하.

### P1 — 리모컨 사용성

1. 요청한 seek/volume과 플레이어가 마지막으로 확인한 실제 값을 분리해서 보여 준다.
2. 스피커 출력 장치 선택(`setSinkId`)과 autoplay 해제 안내를 설계한다.
3. 스피커 감상 볼륨과 OBS player gain을 분리한다.
4. 세션마다 바뀌는 OBS URL을 stable pairing/revoke/rotate 방식으로 바꿀지 결정한다.
5. G3 사용자 확인 기록에 app build, fixture, OBS profile, sample rate, 연결 소스 fingerprint를 저장하고 구성 변경 시 stale 처리한다.

### P2 — 번역과 운영

1. 남은 하드코딩 사용자 텍스트를 semantic message catalog로 이동한다.
2. locale runtime, 언어 선택기, pseudo-locale, 긴 문자열·RTL·좁은 화면 overflow를 검증한다.
3. 하드코딩 사용자 텍스트 회귀 검사를 CI에 추가한다.
4. public session/prepare rate limit과 token·trace 자동 redaction을 검토한다.
5. v1/v2 통합 smoke와 rollback rehearsal을 정식 배포 절차에 넣는다.

## 4. 다음 실행 순서

1. 현재 UI/프리뷰 보완을 전체 테스트·lint·Worker syntax·production build·OBS bundle gate로 다시 검증한다.
2. GitHub Pages에 배포하고 공개 URL에서 캐시를 우회한 새 프로필 브라우저 검증을 반복한다.
3. 실제 OBS에서 G3를 수행한다. 실패 위치에 따라 앱 플레이어, Browser Source 설정, OBS mixer/track 문제를 분리한다.
4. G3가 통과하면 G4 10초 녹화 분석기를 붙이고, 이어서 G5 비공개 방송을 확인한다.
5. 마지막으로 G6 10분 마이크↔MR 상호상관 검증을 수행한다.
6. G3~G6 증거가 모두 남기 전에는 UI나 문서에서 `OBS 송출 검증 완료` 또는 `싱크 검증 완료`라고 표시하지 않는다.

## 5. 완료 판정에 사용할 명령

```powershell
npm ci
npm test
npm run lint
node --check workers/rekasong-session/src/index.js
npm run build
npm run check:obs:bundle
git diff --check
```

실제 OBS 관문은 `OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md`에 source 이름, OBS 버전/profile, sample rate, 녹화/VOD 파일, offset·drift 수치를 기록한다.
