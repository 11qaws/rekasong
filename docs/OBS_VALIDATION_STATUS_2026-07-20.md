# WEB ↔ OBS 검증 현황과 잔여 작업

> 기준일: 2026-07-20 KST
> 검증 시작 frontend: `74afc4e0bf0f2a6126abfc079856506382a85cab`
> 현재 검증 후보: 이 문서와 같은 commit의 코드
> production app: `https://11qaws.github.io/rekasong/`
> production Worker: `https://rekasong-session.11qaws.workers.dev`
> 실제 장비 판정 절차: `OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md`

## 1. 현재 결론

현재 자동 증거의 상한은 **G2: 브라우저 플레이어가 일반 곡과 같은 media element 경로로 기준 PCM을 실제 재생하고 안전하게 정지함**이다.

- 앱·Worker의 출력 단일화, 전환 실패 복구, 다중 탭 제어권, stale 명령 차단은 자동 테스트로 강하게 고정돼 있다.
- 최신 Protocol v2는 로컬 Durable Object와 실제 Chrome에서 OBS runtime 후보 1개, `output_ready`, 8초 재생, 16개 marker, 강한 정지, 세션 종료까지 통과했다.
- 새 브라우저의 production UI는 불안한 서버 장애 문구 없이 시작했다. 제어 연결과 숨은 speaker player 등록 사이의 첫 클릭 race도 고쳐, 느린 등록 중에는 `스피커 연결 중`, 성공 뒤에는 `스피커 송출 중`으로 수렴한다.
- OBS 전용 route의 실제 정적 로드는 예산 안이다.
- **아직 실제 OBS mixer, 녹화 파일, 플랫폼 결과물, 마이크↔반주 싱크는 확인하지 않았다.** 따라서 현재 상태를 `OBS 송출 확인 완료` 또는 `카라오케 싱크 확인 완료`라고 부르면 안 된다.

## 2. 사용자가 지금 믿어도 되는 부분

| 사용자 행동·상황 | 현재 판정 | 근거 |
|---|---|---|
| 처음 앱을 열면 곧바로 서버 장애처럼 보이지 않음 | 확인 | 빈 Chrome profile에서 `송출 경로 없음`, 두 출력 버튼 활성, page error 0, 출력 Worker session/status 200 |
| 스피커를 선택해 음악 감상 경로를 준비 | 확인 | production 첫 클릭 후 `스피커 연결 중`을 거쳐 `스피커 송출 중`, 선택·실제 경로가 speaker로 수렴 |
| OBS가 없는데 OBS를 잘못 누름 | 확인 | `OBS 플레이어 없음`, OBS 선택이 남지 않고 speaker 선택 유지, 두 버튼 계속 활성 |
| 전환 실패가 영구 잠금으로 남지 않음 | 확인 | production 실제 UI + output-control 회귀 테스트 |
| 한 탭만 조종하고 다른 탭은 이유·제어권 이전을 봄 | 계약 및 production UI 확인 | 다중 탭 회귀와 2026-07-19 production 브라우저 검증 |
| speaker와 OBS에 동시에 재생 권한을 주지 않음 | 계약 확인 | 단일 lease, candidate count, deactivate-before-activate 테스트 |
| 연결 손실·긴급 정지 뒤 자동으로 다시 재생하지 않음 | 계약 확인 | physical pause/detach, safety lock, auto-resume 금지 테스트 |
| 최신 v2 플레이어가 실제 PCM 기준 신호를 재생 | Chrome에서 확인 | 실제 `<audio>`의 PLAYING, 8초 fixture, marker 16개, `test_complete` |
| 기준 신호 종료 뒤 실제 재생 자원을 정지·분리 | Chrome에서 확인 | paused, src/srcObject/source child 분리, NETWORK_EMPTY/NO_SOURCE, autoplay false |
| 그 PCM이 실제 OBS mixer와 방송으로 들어감 | **미확인** | 실제 OBS G3–G5 필요 |
| 스트리머 마이크와 반주 싱크가 방송 내내 유지 | **미확인** | 실제 장비 G6와 10분 분석 필요 |

## 3. 2026-07-20에 실행한 자동 검증

### 3.1 기본 회귀와 정적 계약

| 검증 | 결과 |
|---|---|
| 전체 테스트 | 최종 542/542 통과 |
| Worker·출력 제어 집중 테스트 | 374건 통과 |
| v2 adapter/protocol/hibernation 집중 테스트 | 105건 통과 |
| lint | exit 0, 기존 warning 6개, 신규 warning 0 |
| production build | 통과 |
| Worker syntax | `node --check` 통과 |
| whitespace | `git diff --check` 통과 |
| production artifact 환경 | production Worker 포함, staging Worker 미포함 |

기존 warning 6개는 `SearchPanel.jsx` 4개와 `functions/api/gemini.js` 2개다. 이번 OBS 변경으로 새 warning은 생기지 않았다.

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
- sourceActive/sourceVisible을 false로 만들면 후보 0, lease `unknown`, reason `target_source_inactive`
- 이 불확실 상태를 audible 또는 safe inactive로 거짓 표시하지 않음
- 서버 emergency ACK 전에도 같은 재생 media graph가 즉시 paused/source-detached/autoplay false가 되고, source/runtime 복원만으로 자동 재개하지 않음
- 명시적 emergency stop ACK 뒤에만 inactive, target null, stopped로 회복
- 중단된 점검은 자연 완료로 위조하지 않고 `lastAbort/startedObserved=true`로 기록
- session 종료와 HTTP 410 fence, page error 0

중요한 정책은 source inactive를 곧바로 `정상 정지`라고 추정하지 않는 것이다. 물리적으로 소리가 나지 않더라도 server truth는 explicit strong-stop 증거가 오기 전까지 unknown으로 유지한다.

### 3.5 production 사용자 흐름

완전히 빈 headless Chrome profile로 로컬 production build와 production Worker를 연결해 확인했다.

- 초기 상태: `송출 경로 없음`
- speaker/OBS 버튼 모두 활성
- 설정 버튼에 불필요한 `확인 필요` 경고 없음
- page error 0, production Worker session/status HTTP 200. 정적 로컬 preview에는 선택적 개발 동기화용 `/api/sync`가 없어 404가 나지만 출력 제어 Worker 경로와는 무관함
- 버튼이 처음 보이는 즉시 speaker를 선택하면 2,929ms 안에 `스피커 연결 중` → `스피커 송출 중`
- speaker player chunk를 인위적으로 4.5초 지연해도 7,152ms 안에 같은 순서로 수렴하고 blocked/attention을 거치지 않음
- Dashboard가 미리 만든 exact `playerInstanceId`를 control과 speaker player가 공유해, 이전 탭의 단독 speaker가 먼저 도착해도 자동 활성화하지 않음
- OBS source 없이 OBS 선택 시 `OBS 플레이어 없음`으로 정확한 원인을 표시
- 실패 뒤 speaker 선택은 계속 유지되고 OBS 선택은 남지 않음
- 두 출력 버튼은 계속 활성
- 즉시 speaker를 다시 눌러 `스피커 송출 중`으로 복구

이전에 저장된 세션이 있는 브라우저에서는 `출력 제어 연결을 확인할 수 없음`이 재현됐지만, 빈 profile에서는 재현되지 않았다. 이는 전체 서버 장애 증거가 아니라 오래된 브라우저 세션/제어 상태의 복구 시나리오로 분류한다. 같은 상태가 다시 발생하면 room 상태, control close code와 session lifecycle을 함께 수집해야 한다.

설정 dialog의 키보드 동작도 확인했다.

- 열린 다음 제목으로 초기 focus 이동
- Shift+Tab focus trap
- Escape로 닫힘
- 닫힌 뒤 톱니 버튼으로 focus 복귀

출력 radio의 방향키·Home·End도 실제 production DOM에서 확인했다. OBS 후보가 없어 선택이 실패해도 focus는 의도한 항목으로 이동하고, 기존 speaker 선택은 유지되며, Home/ArrowLeft로 speaker에 즉시 복귀했다. 320/375/390/768/1280px에서 페이지·현재 재생 영역의 수평 overflow는 0이었고, 모바일 출력 버튼과 톱니는 높이 44px를 유지했다. 설정 dialog는 viewport 안에 머물고 내부 세로 scroll만 사용했으며 page error는 0이었다.

### 3.6 경량성

| 항목 | 결과 |
|---|---|
| production build | 약 1.0–1.5초 |
| OBS route 실제 closure | 379,454B raw / 114,459B gzip |
| 예산 | 460.8KB raw / 133.1KB gzip |
| gzip 여유 | 약 14% |
| OBS DOM | 16 nodes, `<audio>` 1, image/iframe/svg 0 |
| 외부 font | OBS route 0 |
| 정적 요청 | 6개 병렬, 현 PC/CDN 5회 중앙값 약 148ms |
| 성능·수명주기 테스트 | 75/75 통과 |

기존 bundle checker는 `onAirTestFixture` 정적 의존 약 63.6KB raw를 누락했다. manifest 기반 전체 static closure로 보강해 실제 수치를 릴리스 게이트에 포함했다. 현재도 예산은 통과하지만 gzip 여유가 크지 않으므로 새 공용 의존을 OBS route에 넣을 때 주의한다.

Dashboard 초기 closure는 약 774KB raw / 229KB gzip이다. 현재 즉시 장애 수준은 아니지만 `framer-motion`, `jsmediatags`, staging/YouTube 관련 코드는 후속 interaction-time lazy load 후보다.

### 3.7 설정 안 OBS 오디오 점검 UI

설정 dialog 안에 기존 Protocol v2 `startTest`/`stopTest`를 연결했다. 큰 설명 패널을 메인 화면에 추가하지 않고, 출력 설정 안에서 다음을 직접 확인한다.

- OBS 경로가 활성·안정 상태이고 정확히 1개인 On-Air 플레이어가 lease 대상일 때만 시작 가능
- 중복·미연결·다른 탭 제어·경로 전환·곡 재생 중에는 구체적인 차단 사유 표시
- 요청 전달, 실제 `PLAYING(test_started)`, 진행 marker 수를 서로 다른 증거로 표시
- 8초 완료 뒤 G2만 확인됐다고 명시하고 OBS mixer·녹화·최종 송출은 증명하지 않음
- 사용자가 중간에 멈추면 실패가 아니라 `사용자가 중지함 · 안전 정지 확인`으로 표시
- OBS 모드에서는 이 기기 스피커가 조용한 것이 정상이라는 안내를 설정 안에 표시

실제 Dashboard → 복사한 v2 플레이어 URL → OBS binding을 넣은 Chrome 흐름으로 자연 완료와 중간 안전 정지를 모두 실행했다. 자연 완료는 실제 PLAYING, marker 16개, pause와 source detach까지 확인했다. 중간 정지는 marker 8개 시점에 실행했고 media가 paused, source detached, autoplay false, network empty 상태가 된 뒤에만 재시도를 열었다. 두 흐름 모두 page error/request failure는 0이었다.

이 UI는 의도적으로 가짜 RMS/peak를 표시하지 않는다. 앱 플레이어 내부 신호와 OBS mixer의 실제 입력은 서로 다른 증거이기 때문이다.

### 3.8 Protocol v2 READY 유휴 10분 soak

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
- [완료] 활성 OBS source를 inactive/invisible로 만들면 자동으로 안전하다고 추정하지 않고 route를 `target_source_inactive/unknown`으로 fence하며, emergency stop의 강한 증거 뒤에만 inactive로 복구됨을 확인했다.
- [완료] session cleanup alarm의 R2 삭제 → storage deleteAll 순서, 실패 시 fail-closed, 재전달 idempotence를 5개 직접 Worker handler 테스트로 고정했다.
- [수정] 오래된 grace/watchdog alarm이 persisted `cleanupAt`보다 먼저 도착하면 자산을 조기 삭제하던 결함을 발견해, 정확한 미래 deadline을 다시 예약하고 삭제 없이 반환하도록 수정했다.
- [대기] 최신 v2를 remote staging에서 다시 실행한다. 현재 로컬 Wrangler OAuth가 production 계정에만 연결돼 별도 staging 계정 배포를 갱신할 수 없다.
- [대기] 실제 Cloudflare runtime의 DO eviction/rehydration, alarm 자동 delivery/retry와 final R2 cleanup을 direct handler simulation이 아닌 환경에서 검증한다.
- [완료] 설정 안에 `OBS 오디오 점검 시작/중지`, 실제 PLAYING, 진행 marker, 완료·사용자 안전 정지 결과 UI를 연결하고 실제 Dashboard↔v2 플레이어 흐름으로 검증했다.
- [완료] 새 페이지의 첫 speaker 클릭이 lazy player 후보 등록보다 앞서는 race를 재현하고, 최대 12초 동안 사용자 intent를 유지해 **현재 Dashboard가 미리 공유한 exact player ID**가 유일 후보로 도착할 때 한 번만 활성화하도록 수정했다. 이전 탭 후보는 자동 활성화하지 않고, 후보 0/2개 OBS는 계속 fail-closed다.
- [대기] 앱 PCM RMS/peak meter와 `OBS mixer에서 확인했어요/안 보여요`를 서로 다른 증거로 저장한다. 현재 UI는 가짜 meter 대신 G2 marker와 OBS mixer 직접 확인 안내만 제공한다.

### P1 — 장애·장시간 안정성

- offline/online, WebSocket 1011, PC sleep/resume, background throttle 실제 브라우저 주입
- [완료] 일반 Chrome READY idle 10분: long task 0, DOM mutation 0, 평균 CPU 0.199267%
- Chrome/CEF 30분: post-GC heap warm baseline 대비 +16MiB 이내
- hint churn·곡 전환 100회: stale fetch 0, cache 1개, retained 128MiB 이하
- speaker↔OBS 500회: control socket 1개, audible player 1개
- Dashboard history 1,000곡: render row 100 이하, 조작 p95 100ms 이하, localStorage 1MiB 이하
- 실제 OBS CEF 60분: crash/dropout/중복 player/지속 working-set 증가 0

현재 history는 전체 렌더이며 로컬 Blob의 전역 count·byte cap도 없다. 따라서 1,000곡·장시간 리모컨 메모리 안정성은 아직 `not-run`이다.

### P1 — 리모컨 신뢰성·편의성

- [완료] OBS 모드에서 `이 기기 스피커가 무음인 것은 정상` 안내를 출력 설정의 현재 OBS 점검 상태 가까이에 표시
- 요청한 seek/volume과 player가 마지막으로 확인한 실제 값을 분리 표시
- speaker volume과 OBS player gain 분리
- 스피커 출력 장치 선택(`setSinkId`)과 autoplay unlock 안내
- 세션마다 바뀌는 OBS URL 대신 stable URL 또는 1회 pairing/revoke/rotate 설계
- verification 기록에 build, fixture, OBS profile, sample rate fingerprint를 저장하고 구성 변경 시 stale 처리

### P2 — 번역과 운영

- 모든 사용자 텍스트를 semantic message catalog로 이동
- locale runtime·언어 선택기·pseudo-locale·긴 문자열 overflow 검증
- hardcoded 사용자 텍스트 baseline을 CI에 추가
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

- 10초 전용 녹화 파일에 기준 신호가 실제 존재
- 의도한 track, sample rate, channel
- clipping 0, 20ms 초과 dropout 0, marker 누락·중복 0

### G5 — test stream artifact

- 비공개 test stream/VOD의 의도한 audio track에 기준 신호 존재
- ingest 성공 상태가 아니라 결과 파일의 PCM으로 판정

### G6 — 카라오케 싱크

- 마이크와 MR을 가능하면 분리 track으로 10분 기록
- 보정 후 고정 offset 목표 ±20ms
- 시작↔끝 상대 drift 10ms 이내
- jitter p95 5ms 이하
- marker 누락·중복 0

## 6. 다음 구현 순서

1. 완료: duplicate OBS, source inactive, emergency stop과 cleanup alarm을 자동 안전 회귀로 고정했다.
2. 완료: 설정 dialog에 `OBS 오디오 점검` 시작/중지와 G2 진행 증거를 연결하고, 자연 완료와 사용자 안전 정지를 검증했다.
3. PCM meter와 OBS mixer 사용자 확인을 분리하고 verification fingerprint를 저장한다.
4. 실제 OBS에서 G3를 실행하고 정확한 source/mixer/monitoring 진단 문구를 조정한다.
5. 10초 녹화 artifact 분석기를 추가해 G4를 자동 판정한다.
6. 비공개 test stream으로 G5를 실행한다.
7. 10분 mic/MR fixture와 상호상관 분석기로 G6를 실행한다.
8. 일반 Chrome READY 10분 soak는 완료했다. Chrome/CEF 30/60분과 100/500/1,000회 부하 예산을 이어서 자동화한다.
9. 전체 i18n·pseudo-locale를 완료한다.

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
