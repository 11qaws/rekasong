# WEB ↔ OBS 검증 현황과 잔여 작업

> 기준일: 2026-07-20 KST
> 검증 시작 frontend: `74afc4e0bf0f2a6126abfc079856506382a85cab`
> 현재 검증 후보: 이 문서와 같은 commit의 코드
> production app: `https://11qaws.github.io/rekasong/`
> production Worker: `https://rekasong-session.11qaws.workers.dev`
> 실제 장비 판정 절차: `OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md`
> 최신 실제 장비 실행 기록: [OBS_PHYSICAL_VALIDATION_2026-07-22.md](./OBS_PHYSICAL_VALIDATION_2026-07-22.md)

## 1. 현재 결론

현재 실제 장비 증거는 G4를 통과했고 G6 장시간 stress까지 측정했다. 현재의 온보드 스피커 출력+USB FIFINE 마이크 입력 조합은 시작 offset 기준에 실패했고, 새 제품 관문인 최대 5분 한 곡의 drift는 재판정이 필요하다. 10분 drift는 진단값이며 비공개 방송 결과 G5와 실제 monitoring 장치 조합은 별도 관문이다.

- 앱·Worker의 출력 단일화, 전환 실패 복구, 다중 탭 제어권, stale 명령 차단은 자동 테스트로 강하게 고정돼 있다.
- 최신 Protocol v2는 로컬 Durable Object와 실제 Chrome에서 OBS runtime 후보 1개, `output_ready`, 8초 재생, 16개 marker, 강한 정지, 세션 종료까지 통과했다.
- 새 브라우저의 후보 UI는 불안한 서버 장애 문구 없이 `스피커 송출 중`으로 시작한다. Speaker는 서버 player 등록·lease·heartbeat를 사용하지 않으며 각 탭의 로컬 player가 독립적으로 준비된다.
- OBS 전용 route의 실제 정적 로드는 예산 안이다.
- 실제 OBS 30.2.0/browser plugin 2.23.5에서 `Control audio via OBS`가 켜진 Rekasong Browser Source로 점검 신호를 실행했고, 앱의 `test_started`/G2 완료와 동시에 OBS 믹서 미터가 약 -25 dB까지 움직이는 것을 화면에서 확인했다.
- 실제 녹화 artifact에서 기준 패턴을 검출해 G4를 통과했다. 물리 스피커→마이크 경로의 10분 분리 track도 분석해 장시간 drift를 수치화했지만, 시작 offset이 기준을 넘고 5분 곡 단위 drift 재판정이 남았다. 플랫폼 결과물은 실행하지 않았다. 따라서 현재 상태를 `카라오케 싱크 확인 완료` 또는 `플랫폼 송출 확인 완료`라고 부르면 안 된다.
- 보강 배포 뒤 실제 OBS CEF 60분 재생도 통과했다. 같은 player identity와 단일 route를 끝까지 유지했고 wall/media 오차는 150ms, renderer 메모리는 private 14.8MiB·working set 약 33.5~33.6MiB로 일정했다. 이는 G5/G6를 승격하지 않는 별도 장시간 안정성 증거다.

### 1.0 2026-07-22 실제 OBS 영구 대기 원인과 수정

- OBS Browser Source API는 `obsSourceActiveChanged`와 `obsSourceVisibleChanged` 이벤트를 제공하지만, 페이지가 처음 로드된 순간의 active/visible 값을 조회하는 getter는 제공하지 않는다. `getStatus()`도 방송·녹화·리플레이 버퍼·가상 카메라 상태만 반환한다. 근거: [obs-browser 공식 README](https://github.com/obsproject/obs-browser/blob/master/README.md).
- 기존 코드는 이벤트를 아직 한 번도 받지 않은 초기값을 `false`로 만들었다. 이미 보이는 장면에서 페이지가 로드되면 새 이벤트가 오지 않을 수 있으므로, 실제 OBS가 정상이어도 Worker가 후보를 영구 제외하고 `OBS 플레이어 없음`으로 표시했다.
- 수정 계약은 `미관측(null/필드 없음) ≠ 비활성(false)`이다. OBS binding과 최신 heartbeat가 있으면 초기 미관측 상태의 후보는 허용한다. 이후 OBS가 실제 callback으로 `false`를 보고하면 새 활성화는 계속 차단한다.
- 개발 전용 `tools/obs-runtime-probe.html`로 초기 로드에서 두 이벤트가 0건이고 상태가 unobserved인 것을 확인했다. source visibility를 껐다 켠 뒤에는 두 값이 true로 관측되어 API 동작을 교차 확인했다. 이 도구는 앱 런타임이나 production bundle에 연결하지 않는다.

### 1.1 2026-07-22 연결 유지 복구 보강

- 같은 OBS player identity가 WebSocket을 다시 연결하면 Worker는 첫 `player_hello` 안에서 기존 lease를 `ready/output_reconnected`로 복원한다. 10초 heartbeat까지 기다리는 상태 공백을 제거했다.
- 살아 있던 `<audio>` graph는 재접속 뒤 현재 물리 상태를 권위 있는 playback event로 다시 보고한다. 새 LOAD나 PLAY를 실행하지 않으므로 반주 위치를 건드리지 않는다.
- 일반 곡의 playback event가 소켓 단절과 겹쳐 결과 불명이 되어도 adapter는 route를 낮추거나 emergency stop/detach하지 않는다. 테스트 fixture, 명시적 STOP/deactivate/emergency, terminal teardown은 기존의 엄격한 경계로 남는다.
- 대시보드 control socket의 단순 단절은 새 welcome과 authoritative snapshot이 일치하면 자동으로 제어 가능 상태를 회복한다. 진행 중 명령의 결과 불명이나 test/run identity 문제는 계속 수동 복구 대상으로 남고, 재접속 자체는 LOAD·PLAY를 재전송하지 않는다.
- 자동 회귀 검증은 즉시 hello 복원, active family 보존, 재생 위치 재보고, 비활성 scene telemetry 상태의 복원, 재보고 전달 불명 시 media graph 보존, durable 복원 실패 시 welcome 미발행과 깨끗한 재시도를 포함한다.
- 이 보강 자체는 실제 OBS mixer·녹화·비공개 송출·장시간 마이크↔MR 싱크를 증명하지 않는다. 별도 실제 장비 실행으로 G3 기계 관측과 G4 녹화 artifact까지 확인했다.

### 1.2 2026-07-22 실제 G4 녹화와 source hide/show

- OBS 방송은 끈 상태로 로컬 recording만 시작하고 8초 fixture 전체와 전후 여유 구간을 기록했다. 결과 파일은 `C:\Users\Qumin\Videos\2026-07-22 09-57-46.mp4`다.
- 파일은 33.283초, 5,302,320바이트, H.264 + AAC 48kHz stereo다. 전체 오디오 peak -21.2dB로 clipping이 없었다.
- band-pass frame 분석에서 880Hz 짧은 pulse 12개와 440Hz 긴 tone 4개를 정확히 검출했다. marker 누락·중복 0, AAC frame 해상도에서 20ms 초과 활성 구간 분할 0으로 이 장비·profile·track 구성의 G4를 통과했다.

### 1.3 2026-07-22 실제 CEF 60분 첫 실행과 보강 재실행

- 실제 OBS Browser Source에서 60분 AAC fixture를 실행했고 약 56분까지 player/OBS 후보 1/1, 같은 lease target, `audible`·`playing`을 매분 확인했다. Rekasong CEF renderer private memory는 약 38.1MiB에서 43.5~46MiB 범위로 회수돼 지속 증가가 관측되지 않았다.
- 약 56분에 control WebSocket만 `socket_closed`로 종료됐다. OBS mixer 신호는 fixture 자연 종료까지 계속됐고 자연 종료 뒤 무음으로 바뀌었다. 따라서 연결 우선 정책대로 이미 재생 중인 OBS media graph는 제어 연결 손실에 의해 중단·재시작되지 않았다.
- 직접 원인은 control role이 유휴 중 application frame을 전혀 보내지 않았던 것이다. 30초 간격 최소 control heartbeat를 추가했고 Worker는 reply/storage/attachment/broadcast/lease mutation 없이 소비한다.
- 같은 coordinator와 control identity를 유지하는 bounded reconnect도 추가했다. 복구 과정은 route·LOAD·PLAY·STOP을 재전송하지 않으며 authoritative snapshot이 기존 run/lease와 일치해야 connection-loss lock을 해제한다.
- 이 첫 실행은 harness가 자연 종료·strong STOP·deactivate·HTTP 410까지 관측하지 못했으므로 장시간 soak **실패**다. 수정 배포 뒤 60분 전체 재실행이 필요하다.
- 보강 배포 뒤 같은 실제 OBS 30.2.0 Browser Source에서 60분 전체를 재실행해 **통과**했다. wall/media duration은 각각 3,600,150ms/3,600,000ms로 오차 150ms였고 player/OBS 후보 1/1, 같은 target, `audible`·`playing`이 유지됐다.
- candidate transition, unsafe route, duplicate, unknown lease 및 player identity 교체는 0건이었다. control transport에는 3회의 짧은 disconnect 관측과 2회의 reconnect 시도가 있었지만 최대 gap은 825ms였고 동일 identity로 복구했다. route·LOAD·PLAY·STOP 재전송과 media graph 교체는 없었다.
- 최종 Rekasong CEF renderer의 private memory는 14.8MiB, working set은 약 33.5~33.6MiB로 60분 동안 일정했다. 자연 종료 뒤 session 정리와 HTTP 410 fencing까지 확인했다.
- 이 통과는 실제 OBS CEF 장시간 경로·재생·자원 안정성의 증거다. ingest 결과물은 G5가 필요하고, 마이크↔MR은 별도 G6에서 시작 offset 실패·5분 drift 재판정 상태다.
- 별도 run에서 test fixture 재생 중 source를 약 1.4초 숨겼다가 다시 표시했다. OBS route는 활성 상태를 유지했고 G2가 16/16 marker로 완료됐다. source hide/show만으로 established media graph를 정지하거나 초기화하지 않는 계약을 실제 OBS에서 확인했다.
- production UI는 숨은 단일 source를 일반 `OBS 플레이어 없음`으로 표시하며 완전 초기화를 권했다. 최신 후보는 `OBS 소스를 표시해 주세요`와 눈 아이콘 복구 행동을 표시하고 destructive reset 카드를 숨긴다.

### 1.4 2026-07-22 물리 마이크↔MR 10분 G6

- OBS Browser Source를 track 1·2, FIFINE K670 마이크를 track 1·3으로 분리하고, monitoring device를 실제 온보드 스피커로 명시해 스피커→공기→마이크 경로를 로컬 MKV에 기록했다.
- 짧은 기준선은 4/4 cycle에서 약 `68.5 ms` 지연과 `0.98445–0.98550` correlation을 보였다.
- 600초 fixture는 60/60 marker를 모두 기록했고 MR 직접 신호의 590초 시간축 오차는 `+9.0 ms`, detrended jitter p95는 `1.832 ms`였다. 재생 중 route 교체·restart·seek·강제 정지는 없었다.
- 첫 5 cycle↔마지막 5 cycle 상대 drift가 `15.5 ms`, 선형 회귀 drift가 `17.32 ms/590초`, 중앙 offset이 `43.25 ms`였다. 기존 drift `≤10 ms/10분`과 보정 후 offset `±20 ms` 기준에는 실패했다. 이후 제품 단위를 최대 5분 한 곡으로 바꿨으므로 10분 drift는 stress 진단으로 보존하고 5분 구간은 별도로 재산출한다. 시작 offset은 현재 경로에서 여전히 실패다.
- Browser Source의 `+69 ms` OBS sync offset은 상대 지연을 약 `82–84 ms`로 악화시켰고 drift를 해결하지 못해 `0 ms`로 복원했다.
- 판정은 **G6 장시간 측정 완료·시작 offset 실패·5분 drift 재판정 필요**다. 결과는 route를 차단하거나 재생을 끊는 조건이 아니다. 같은 audio clock 장치 또는 저지연 performer monitoring 경로에서 5분+짧은 반복 fixture로 재검증한다.

## 2. 사용자가 지금 믿어도 되는 부분

| 사용자 행동·상황 | 현재 판정 | 근거 |
|---|---|---|
| 처음 앱을 열면 곧바로 서버 장애처럼 보이지 않음 | 로컬 후보 확인 | 기본 상태가 `스피커 송출 중`이고 스피커 transport가 서버 경로를 기다리지 않음 |
| 스피커로 음악을 감상 | 자동 계약·로컬 UI 확인 | 브라우저 로컬 player가 후보·lease·heartbeat 없이 즉시 명령을 받고 각 탭이 독립적으로 동작 |
| OBS가 없는데 OBS를 잘못 누름 | 확인 | `OBS 플레이어 없음`, OBS 선택이 남지 않고 speaker 선택 유지, 두 버튼 계속 활성 |
| 전환 실패가 영구 잠금으로 남지 않음 | 확인 | production 실제 UI + output-control 회귀 테스트 |
| 여러 스피커 탭이 서로를 막지 않음 | 자동 계약 확인 | 탭별 local controller 독립성과 server Speaker player/heartbeat 부재 테스트 |
| 잠금 화면·알림·헤드셋에서 Speaker 조작 | 자동 계약 확인·실기기 대기 | 실제 Speaker run에서만 Media Session handler 설치, OBS·idle에서 제거하는 테스트 |
| 같은 대시보드 control이 재접속 후 다시 조작 가능 | 자동 계약 확인 | welcome+authoritative snapshot 수렴 시 bare connection lock 해제, 명령 replay 0 테스트 |
| 연결 손실 뒤 곡을 끊거나 자동으로 다시 재생하지 않음 | 자동 계약 확인 | OBS media graph 보존, playback re-attestation, explicit command replay 0 테스트 |
| 최신 v2 플레이어가 실제 PCM 기준 신호를 재생 | Chrome에서 확인 | 실제 `<audio>`의 PLAYING, 8초 fixture, marker 16개, `test_complete` |
| 기준 신호 종료 뒤 실제 재생 자원을 정지·분리 | Chrome에서 확인 | paused, src/srcObject/source child 분리, NETWORK_EMPTY/NO_SOURCE, autoplay false |
| 그 PCM이 실제 OBS mixer로 들어감 | 기계 관측 확인 | 실제 OBS의 Rekasong source meter가 점검 신호 동안 약 -25 dB까지 움직임 |
| 그 PCM이 OBS 녹화 트랙에 기록됨 | 실제 G4 확인 | 33.283초 MP4에서 880Hz 12개 + 440Hz 4개, marker 누락·중복 0, clipping 0 |
| 그 PCM을 사용자가 듣고 방송 결과물에서도 확인 | **미확인** | 사용자 모니터링 확인과 실제 OBS G5 필요 |
| 스트리머 마이크와 반주 싱크가 한 곡 동안 유지 | **시작 offset 실패·5분 drift 재판정 필요** | 60/60 marker·jitter 통과, 10분 stress drift `15.5–17.32 ms`; 현재 물리 경로 offset `43.25 ms` |

## 3. 2026-07-20에 실행한 자동 검증

### 3.1 기본 회귀와 정적 계약

| 검증 | 결과 |
|---|---|
| 전체 테스트 | 최신 후보 634/634 통과 |
| Worker·출력 제어 집중 테스트 | 374건 통과 |
| v2 adapter/protocol/hibernation 집중 테스트 | 105건 통과 |
| lint | exit 0, 기존 warning 2개, 신규 warning 0 |
| production build | 통과 |
| Worker syntax | `node --check` 통과 |
| whitespace | `git diff --check` 통과 |
| production artifact 환경 | production Worker 포함, staging Worker 미포함 |

기존 warning 2개는 `functions/api/gemini.js`의 `no-useless-escape`다. 이번 OBS 변경으로 새 warning은 생기지 않았다.

### 3.2 legacy 실제 미디어 smoke

`scripts/obs-staging-smoke.mjs`를 실제 Chrome과 별도 staging에서 실행해 12/12 통과했다.

- cold Worker stream 재생
- pause
- prefetch HTTP 206 완료
- prefetched Blob 재생
- 10초 media clock: waiting/stalled/error/backwards 0, wall 대비 -1ms
- non-prefetched stream 경로
- 실제 player event 반환
- page error 0

단, 이 스크립트는 legacy protocol 증거다. 최신 speaker↔OBS v2 경로의 합격으로 계산하지 않는다. 이번 작업에서 command rejection/error를 ACK로 오판하지 않게 했고, 마지막 STOP의 실제 media 반영 뒤에만 세션을 종료하도록 보강했다.

### 3.3 최신 Protocol v2 실제 Chrome smoke

로컬 Worker `127.0.0.1:8787`과 최신 앱 `127.0.0.1:5110`을 격리해 `npm run test:obs:v2`를 실행했다. 전체 lifecycle 약 23.3초, exit 0이었다. 8초 fixture의 실제 재생 구간은 8,170ms였고 wall-clock drift 170ms, timing sample 205개, 최대 sample gap 92.6ms였다. waiting/stalled/error/backwards는 모두 0이었다.

1. 새 session 생성
2. 실제 `OnAirControlCoordinator` READY
3. writable control 확인
4. Chrome에 OBS JavaScript binding 주입
5. `obs-browser-source` 후보 정확히 1개
6. `sourceActive=true`, `sourceVisible=true`
7. OBS lease 활성화와 `output_ready`
8. 동일 `<audio>` graph 포착
9. 일반 곡과 같은 Blob media 경로로 8초 fixture 로드
10. 실제 `playing` 뒤에만 `test_started`
11. media duration 8초 확인
12. marker 16개 전부 수신
13. marker index 0부터 연속
14. marker media time 연속
15. telemetry sequence 연속
16. `test_complete`의 marker count와 stopped postcondition 일치
17. 실제 pause와 source detach
18. route deactivate 뒤 active lease 없음
19. `session_ended` 수신 및 status HTTP 410 reuse fence
20. player page uncaught error 0

이 smoke는 G2까지 증명한다. 일반 Chrome에 OBS binding을 주입한 것이므로 실제 CEF, OBS mixer, 녹화 track 또는 최종 방송 출력의 증거는 아니다.

### 3.4 duplicate·source-inactive 실제 Chrome safety smoke

`npm run test:obs:v2:safety`로 별도 실행해 다음을 확인했다.

- active/visible OBS browser-source 두 개가 authoritative 후보 2개로 관측됨
- 두 player instance id가 서로 다름
- OBS 활성화가 `control_coordinator_output_candidate_count`로 동기 거부됨
- 이때 Worker command 0, pending switch 0, lease epoch 0/inactive 유지
- 중복 하나를 닫으면 후보 정확히 1개로 복구
- 단일 후보 활성화 후 lease epoch 1/ready와 `output_ready_no_playback`
- 단일 후보에서 fixture를 실제 PLAYING한 뒤 두 번째 후보를 추가해도 기존 lease/epoch/player가 유지되고, 새 후보는 paused+detached standby로 남음
- sourceActive/sourceVisible을 false로 만들면 새 활성화 후보에서는 제외되지만 이미 성립한 lease와 media graph는 유지됨
- 장면 전환 telemetry만으로 audible 또는 safe inactive를 새로 주장하지 않고, 재생 상태는 media event 증거를 계속 사용함
- 명시적 emergency stop은 같은 재생 media graph를 즉시 paused/source-detached/autoplay false로 만들고 자동 재개하지 않음
- emergency stop ACK 뒤에만 inactive, target null, stopped로 회복
- 중단된 점검은 자연 완료로 위조하지 않고 `lastAbort/startedObserved=true`로 기록
- session 종료와 HTTP 410 fence, page error 0

중요한 정책은 source inactive를 곧바로 `정상 정지`나 Browser Source 종료로 추정하지 않는 것이다. established graph는 유지하고, 실제 정지는 explicit strong-stop 증거로만 확정한다.

### 3.5 일반 곡 WebSocket close→reconnect 실제 Chrome smoke

`npm run test:obs:v2:continuity`는 strict 점검 신호가 아닌 30초 일반 세션 asset을 정상 LOAD/READY/PLAY하고, 재생 중 현재 OBS player WebSocket만 실제 close했다.

- 48kHz mono PCM WAV 2,880,044바이트를 R2 호환 session asset으로 업로드하고 Player가 Blob으로 완전히 준비한 뒤 재생했다.
- close 직후 Worker snapshot은 같은 lease target을 `unknown`, playback을 `target_disconnected`, live player 목록을 빈 배열로 관측했다.
- 이 동안 같은 `<audio>`와 같은 blob은 pause·detach 없이 약 0.358초에서 2.436초로 계속 진행했다.
- 같은 page-owned player identity가 새 connection으로 hello한 뒤 동일 lease epoch/target이 `audible`, 동일 entry/run이 `output_reconnected/playing`으로 복원됐다.
- 정상 곡 구간의 PLAY와 PLAYING은 각 1회였고, 재접속으로 인한 pause·ended·emptied·waiting·stalled·error는 0이었다.
- explicit STOP 뒤에는 media만 strong-detach하고 동일 OBS route는 `ready`로 유지해 다음 곡을 받을 수 있었다.
- deactivate, session end, status HTTP 410 reuse fence, page uncaught error 0까지 통과했다.

`npm run test:obs:v2:continuity:soak`는 이 경계를 600초/57,600,044바이트 fixture와 590초 관측으로 확장했다. media 경과는 590,065.3ms, wall 경과는 590,063.1ms로 차이가 2.2ms였으며 1,500ms 제한 안이었다. 추가 PLAY와 pause·ended·emptied·waiting·stalled·error는 0이었다.

이 smoke는 “서버 연결이 흔들려도 이미 재생 중인 반주를 앱이 스스로 끊거나 다시 재생하지 않는다”는 브라우저 경계를 실제로 증명한다. 실제 OBS mixer와 녹화·송출 트랙은 여전히 G3~G6 대상이다.

### 3.6 최신 후보 사용자 흐름

로컬 production 후보를 실제 Chrome에서 확인했다. 아래 Speaker 항목은 서버 경로 전환 테스트가 아니라 일반 웹 플레이어 계약이다.

- 새로 연 두 탭 모두 헤더가 즉시 `Playing through speakers`였고, 각 문서에 `ready`인 로컬 `<audio>`가 정확히 하나씩 존재했다.
- 두 탭은 server Speaker player identity, route lease, heartbeat, cross-tab playback owner를 만들지 않는다. 한 탭의 `currentEntry`와 active run도 다른 탭으로 가져오지 않는다.
- 설정의 Speaker radio는 `checked=true`, `enabled=true`, `disabled` 속성 없음, `aria-disabled=false`였다.
- Speaker 설정에는 `다른 탭과 창도 각각 독립적으로 재생` 안내와 다음 곡 선택 행동만 표시되며, 서버 연결 대기·경로 확인·다른 탭 제어권·긴급 정지 안내가 나타나지 않았다.
- OBS source 없이 OBS 선택 시 `OBS 플레이어 없음`으로 정확한 원인을 표시
- OBS 선택 실패·제어 충돌·재연결·unknown은 OBS 설정에만 표시되며 Speaker 선택과 로컬 transport는 계속 사용할 수 있다.

이전에 저장된 세션이 있는 브라우저에서는 `출력 제어 연결을 확인할 수 없음`이 재현됐지만, 빈 profile에서는 재현되지 않았다. 이는 전체 서버 장애 증거가 아니라 오래된 브라우저 세션/제어 상태의 복구 시나리오로 분류한다. 같은 상태가 다시 발생하면 room 상태, control close code와 session lifecycle을 함께 수집해야 한다.

설정 dialog의 키보드 동작도 확인했다.

- 열린 다음 제목으로 초기 focus 이동
- Shift+Tab focus trap
- Escape로 닫힘
- 닫힌 뒤 톱니 버튼으로 focus 복귀

출력 radio의 방향키·Home·End도 실제 production DOM에서 확인했다. OBS 후보가 없어 선택이 실패해도 focus는 의도한 항목으로 이동하고, 기존 speaker 선택은 유지되며, Home/ArrowLeft로 speaker에 즉시 복귀했다. 320/375/390/768/1280px에서 페이지·현재 재생 영역의 수평 overflow는 0이었고, 모바일 출력 버튼과 톱니는 높이 44px를 유지했다. 설정 dialog는 viewport 안에 머물고 내부 세로 scroll만 사용했으며 page error는 0이었다.

### 3.7 경량성

| 항목 | 결과 |
|---|---|
| production build | 약 1.0초 |
| OBS route 실제 closure | 382,301B raw / 116,110B gzip / 101,713B brotli |
| 예산 | 460.8KB raw / 133.1KB gzip |
| gzip 여유 | 약 14% |
| OBS DOM | 16 nodes, `<audio>` 1, image/iframe/svg 0 |
| 외부 font | OBS route 0 |
| 정적 요청 | 6개 병렬, 현 PC/CDN 5회 중앙값 약 148ms |
| 성능·수명주기 테스트 | 75/75 통과 |

기존 bundle checker는 `onAirTestFixture` 정적 의존 약 63.6KB raw를 누락했다. manifest 기반 전체 static closure로 보강해 실제 수치를 릴리스 게이트에 포함했다. 현재도 예산은 통과하지만 gzip 여유가 크지 않으므로 새 공용 의존을 OBS route에 넣을 때 주의한다.

최신 Dashboard JS chunk는 342.90KB raw / 93.98KB gzip이고 CSS는 56.42KB raw / 10.59KB gzip이다. 로컬 Speaker는 4.55KB raw / 1.82KB gzip lazy chunk로 분리돼 있으며, OBS Protocol v2 정적 closure에 Dashboard 번역·검색 catalog를 넣지 않는다. OBS 정적 closure는 382,301B raw / 116,110B gzip / 101,713B brotli다.

### 3.8 설정 안 OBS 오디오 점검 UI

설정 dialog 안에 기존 Protocol v2 `startTest`/`stopTest`를 연결했다. 큰 설명 패널을 메인 화면에 추가하지 않고, 출력 설정 안에서 다음을 직접 확인한다.

- OBS 경로가 활성·안정 상태이고 정확히 1개인 On-Air 플레이어가 lease 대상일 때만 시작 가능
- 중복·미연결·다른 탭 제어·경로 전환·곡 재생 중에는 구체적인 차단 사유 표시
- 요청 전달, 실제 `PLAYING(test_started)`, 진행 marker 수를 서로 다른 증거로 표시
- 8초 완료 뒤 G2만 확인됐다고 명시하고 OBS mixer·녹화·최종 송출은 증명하지 않음
- 사용자가 중간에 멈추면 실패가 아니라 `사용자가 중지함 · 안전 정지 확인`으로 표시
- OBS 모드에서는 이 기기 스피커가 조용한 것이 정상이라는 안내를 설정 안에 표시

실제 Dashboard → 복사한 v2 플레이어 URL → OBS binding을 넣은 Chrome 흐름으로 자연 완료와 중간 안전 정지를 모두 실행했다. 자연 완료는 실제 PLAYING, marker 16개, pause와 source detach까지 확인했다. 중간 정지는 marker 8개 시점에 실행했고 media가 paused, source detached, autoplay false, network empty 상태가 된 뒤에만 재시도를 열었다. 두 흐름 모두 page error/request failure는 0이었다.

이 UI는 의도적으로 가짜 RMS/peak를 표시하지 않는다. 앱 플레이어 내부 신호와 OBS mixer의 실제 입력은 서로 다른 증거이기 때문이다.

### 3.9 Protocol v2 READY 유휴 10분 soak

실제 Chrome, 로컬 Worker, 최신 v2 플레이어로 `npm run test:obs:v2:idle-soak`를 600,000ms 설정해 실행했다.

| 측정 | 결과 |
|---|---|
| 실제 측정 시간 | 600,026.725ms |
| long task `>50ms` | 0회 / 0ms |
| live DOM mutation | 0 record / 0 operation |
| main-thread `TaskDuration` 증가 | 1.195658초, 평균 0.199267% |
| raw JS heap | 8,047,160B → 7,563,680B, -483,480B, 강제 GC 없음 |
| coordinator 표본 | 4,598회, 위반 0 |
| media 표본 | 2,402회, event·위반 0 |
| page/request/crash | 0 |
| socket/reconnect/navigation 변화 | 0 |
| 종료 | route deactivate, session end, HTTP 410 fence 확인 |

CDP의 전체 `Nodes` 계수는 297→162로 감소했지만 live document MutationObserver는 0이었다. 이는 다른 document나 회수 가능한 detached node까지 합산하는 report-only 지표이며 실패로 판정하지 않았다. 이 결과는 일반 Chrome READY 유휴 10분 증거다. 실제 OBS CEF 30/60분, post-GC retained heap, 곡 전환 중 부하는 아직 증명하지 않는다.

## 4. 아직 자동으로 끝내야 하는 검증

### P0 — 방송 안전

- [완료] 실제 Chrome에서 같은 OBS URL 두 개가 후보 2개로 보이고, `activateOutput`이 명령을 보내기 전에 exact candidate-count 오류로 차단되며 lease epoch 0/inactive가 유지됨을 확인했다.
- [완료] 중복 소스 하나를 닫으면 후보 1개로 복구되고 `output_ready`까지 활성화됨을 확인했다.
- [완료] 활성 OBS source를 inactive/invisible로 만들면 storage-free 즉시 heartbeat와 snapshot으로 화면 관측값을 갱신하되, 이미 연결된 lease와 media graph는 유지한다. 해당 source는 새 activation 후보에서는 제외되며 explicit emergency stop 뒤에만 물리 정지를 확정한다.
- [완료] session cleanup alarm의 R2 삭제 → storage deleteAll 순서, 실패 시 fail-closed, 재전달 idempotence를 5개 직접 Worker handler 테스트로 고정했다.
- [수정] 오래된 grace/watchdog alarm이 persisted `cleanupAt`보다 먼저 도착하면 자산을 조기 삭제하던 결함을 발견해, 정확한 미래 deadline을 다시 예약하고 삭제 없이 반환하도록 수정했다.
- [대기] 최신 v2를 remote staging에서 다시 실행한다. 현재 로컬 Wrangler OAuth가 production 계정에만 연결돼 별도 staging 계정 배포를 갱신할 수 없다.
- [대기] 실제 Cloudflare runtime의 DO eviction/rehydration, alarm 자동 delivery/retry와 final R2 cleanup을 direct handler simulation이 아닌 환경에서 검증한다.
- [완료] 설정 안에 `OBS 오디오 점검 시작/중지`, 실제 PLAYING, 진행 marker, 완료·사용자 안전 정지 결과 UI를 연결하고 실제 Dashboard↔v2 플레이어 흐름으로 검증했다.
- [완료] 새 페이지의 첫 Speaker 클릭이 lazy local player 준비보다 앞서는 race를 재현했다. 명령은 탭 내부에서 최대 12초 보존되고 준비 뒤 한 번만 실행되며, 실패하면 다음 클릭이 media session 준비를 다시 시도한다. Server Speaker 후보는 요구하지 않고 후보 0/2개 OBS만 계속 fail-closed다.
- [대기] 앱 PCM RMS/peak meter와 `OBS mixer에서 확인했어요/안 보여요`를 서로 다른 증거로 저장한다. 현재 UI는 가짜 meter 대신 G2 marker와 OBS mixer 직접 확인 안내만 제공한다.

### P1 — 장애·장시간 안정성

- offline/online, WebSocket 1011, PC sleep/resume, background throttle 실제 브라우저 주입
- [완료] 일반 Chrome READY idle 10분: long task 0, DOM mutation 0, 평균 CPU 0.199267%
- Chrome/CEF 30분: post-GC heap warm baseline 대비 +16MiB 이내
- hint churn·곡 전환 100회: stale fetch 0, cache 1개, retained 128MiB 이하
- 단일 탭 Speaker↔OBS 500회: OBS control socket 1개, 같은 탭에서 중복 audible output 0. 별도 Speaker 탭들은 각자 재생 가능해야 하므로 전역 audible player 1개 제한을 두지 않는다.
- Dashboard history 1,000곡: render row 100 이하, 조작 p95 100ms 이하, localStorage 1MiB 이하
- [완료] 실제 OBS CEF 60분: renderer crash, 중복 player, unsafe route, identity 전환, 지속 working-set 증가 0. 물리 mixer의 60분 독립 녹음은 G5/G6와 별도다.

history는 닫힌 상태에서 행을 만들지 않고, 열면 최근 100곡부터 100곡씩 점진 렌더한다. 1,000곡 window·원본 보존 계약은 자동 통과했다. 실제 브라우저 조작 p95·localStorage 크기와 로컬 Blob의 전역 count·byte cap은 아직 `not-run`이다.

### P1 — 리모컨 신뢰성·편의성

- [완료] OBS 모드에서 `이 기기 스피커가 무음인 것은 정상` 안내를 출력 설정의 현재 OBS 점검 상태 가까이에 표시
- [자동 완료] 마지막 사용자 play/pause/seek/volume 요청과 player가 실제 적용한 상태·값을 정확한 command/run 기준으로 분리 표시. ACK·desired 값은 성공 증거가 아니며 5초 지연은 재생을 막지 않음. 실제 OBS 연결 화면 사용성 확인은 대기
- [완료] speaker volume과 OBS player gain 분리
- [완료] 지원 브라우저 전용 스피커 출력 장치 선택(`selectAudioOutput` + `setSinkId`)과 autoplay unlock 안내. 실패·미지원은 재생 비차단
- [완료] 실제 Speaker run 전용 Media Session metadata와 play/pause/next/seek. OBS·idle에서 handler 제거, API 실패 비차단. 실제 모바일 잠금 화면·알림·헤드셋 검증은 대기
- 세션마다 바뀌는 OBS URL 대신 stable URL 또는 1회 pairing/revoke/rotate 설계
- verification 기록에 build, fixture, OBS profile, sample rate fingerprint를 저장하고 구성 변경 시 stale 처리

### P2 — 번역과 운영

- [현재 화면 완료] 모든 실제 Dashboard 사용자 텍스트를 semantic message catalog로 이동
- locale runtime·언어 선택기·pseudo-locale·긴 문자열 overflow 검증
- [완료] 실제 사용자 화면의 hardcoded 한국어·정적 접근성/placeholder·toast/confirm source guard를 `npm test`에 추가
- [완료] 배포 workflow에 deterministic `npm ci`, test, lint, Worker syntax, build, OBS bundle gate를 배포 전 순서로 추가
- public session/prepare rate limit과 token/trace 자동 redaction 검사
- v1/v2 혼합 smoke와 rollback rehearsal

## 5. 실제 OBS에서 반드시 남은 관문

자동 작업이 모두 통과해도 아래는 실제 OBS가 없으면 판정할 수 없다.

### G3 — 정확한 OBS mixer 입력

- Browser Source 하나만 후보인지
- `Control audio via OBS` 체크 전·후 차이
- 정확한 source meter와 output meter가 삐-삐-삐 패턴으로 움직이는지
- mute, monitoring off/monitor only/monitor and output
- OBS 모드에서 대시보드 speaker 복제음과 echo가 없는지
- pause·seek·곡 전환에 click/gap/중복음이 없는지
- hide/show, scene 전환, source refresh, OBS 재시작

### G4 — 녹화 artifact

- **이 장비 구성 통과:** `2026-07-22 09-57-46.mp4`의 AAC 48kHz stereo track에 기준 신호 존재
- 880Hz pulse 12개 + 440Hz tone 4개, marker 누락·중복 0
- peak -21.2dB, clipping 0, AAC frame 해상도에서 20ms 초과 활성 구간 분할 0

### G5 — test stream artifact

- 비공개 test stream/VOD의 의도한 audio track에 기준 신호 존재
- ingest 성공 상태가 아니라 결과 파일의 PCM으로 판정

### G6 — 카라오케 싱크

- **현재 장치 구성 장시간 측정 완료·시작 offset 실패·5분 drift 재판정 필요:** `2026-07-22 21-55-45.mkv`, MR track 2·마이크 track 3
- marker 60/60, 누락·중복 0 — 통과
- jitter p95 `1.832 ms` — `≤5 ms` 통과
- 시작·끝 구간 상대 drift `15.5 ms`, 선형 회귀 `17.32 ms/590초` — 10분 stress 진단값
- 중앙 offset `43.25 ms` — 보정 후 `±20 ms` 실패
- 같은 audio clock 장치 또는 저지연 performer monitoring 경로로 재검증 필요

## 6. 다음 구현 순서

1. 완료: duplicate OBS 차단, established route의 source-inactive telemetry 보존, 명시적 emergency stop과 cleanup alarm을 자동 안전 회귀로 고정했다.
2. 완료: 설정 dialog에 `OBS 오디오 점검` 시작/중지와 G2 진행 증거를 연결하고, 자연 완료와 사용자 안전 정지를 검증했다.
3. 완료(기본): PCM 재생 증거와 OBS mixer 사용자 확인을 분리하고 room·player·check fingerprint와 결과·시각을 로컬 저장한다. app build, fixture, OBS profile, sample rate fingerprint 확장은 남아 있다.
4. 부분 완료: 실제 OBS source meter를 기계 관측했다. 사용자 monitoring 청취와 mute/monitoring mode 변형은 남아 있다.
5. 완료(현재 장비 구성): 실제 녹화 artifact에서 기준 패턴·clipping·marker 누락/중복·활성 구간 분할을 판정해 G4를 통과했다.
6. 완료(장시간 측정): 10분 mic/MR fixture와 상호상관 분석기로 현재 장치의 stress drift를 수치화했다. route 연속성·marker·jitter는 통과했고 시작 offset은 실패했으며 5분 drift는 재판정한다.
7. 같은 audio clock 장치 또는 저지연 performer monitoring 경로를 설계하고, 검증 실패가 established OBS route를 차단하지 않는 advisory UX를 고정한 뒤 5분 한 곡+짧은 반복 G6를 실행한다.
8. 사용자가 명시적으로 비공개 송출을 승인한 경우에만 test stream으로 G5를 실행한다.
9. 일반 Chrome READY 10분과 실제 OBS CEF 60분 soak는 완료했다. 100/500/1,000회 부하 예산을 이어서 자동화한다.
10. 전체 i18n·pseudo-locale를 완료한다.

## 7. 재현 명령

기본 release preflight:

```powershell
npm test
npm run lint
npm run build
npm run check:obs:bundle
node --check workers/rekasong-session/src/index.js
git diff --check
```

최신 v2 실제 Chrome smoke는 격리된 로컬 Worker와 앱을 먼저 띄운 뒤 실행한다.

```powershell
npx wrangler dev --config workers/rekasong-session/wrangler.jsonc --local --port 8787
npm run dev -- --host 127.0.0.1 --port 5100
$env:REKASONG_WORKER='http://127.0.0.1:8787'
$env:REKASONG_APP='http://127.0.0.1:5100'
npm run test:obs:v2
npm run test:obs:v2:safety
$env:REKASONG_SOAK_MS='600000'
npm run test:obs:v2:idle-soak
```

remote staging credential이 준비되기 전에는 production Worker에 장애·부하·duplicate 자동 시험을 실행하지 않는다.
