# WEB ↔ OBS 출력 경로 구현 체크포인트 — 2026-07-19

## 2026-07-22 v0.2.6 장기 이력 고정 창 후보

- 누적형 `이전 100곡 더 보기`를 고정 100행 페이지로 교체했다. 최신·이전·다음 페이지 이동 동안 원본 1,000곡과 순서는 보존하지만 DOM에는 언제나 최대 100행만 두며, 이력을 닫으면 0행과 최신 offset으로 돌아간다.
- production Chromium 전용 harness가 1,000곡 전체 10페이지, 최신 복귀, 5회 재개폐, 320px 모바일, GC 뒤 heap을 측정한다. 저장은 `290,235B`, 최초 개방 `31.9~259.4ms`, warm p95 `30.6~42.8ms`, 모바일 overflow 0, post-GC heap 증가 약 0.2MiB로 각각 1MiB/300ms/100ms/16MiB 예산을 통과했다.
- 개발 서버의 module transform을 UI 성능으로 잘못 세지 않도록 production build/preview만 합격 판정에 사용하고, 최초 cold open을 warm p95 표본에서 분리했다. 같은 harness는 배포 후 공개 URL도 직접 검사할 수 있다.
- 한국어·영어 이력 이동 문구를 semantic key로 추가했다. 기존 유레카 금발 3px 선의 불투명도·stacking context·반응형 가시성 회귀 검사는 그대로 유지한다.
- 이 후보는 아직 frontend `0.2.6`으로 커밋·배포 전이다. Worker와 OBS media graph/protocol에는 변경이 없다.

## 2026-07-22 유레카 브랜드 선·실제 OBS 장시간 시험 보강

- Dashboard 상단의 얇은 노란 선은 유레카의 금발을 나타내는 **고정 브랜드 요소**다. 흰색 hairpin 묶음 뒤로 항상 이어지며 데스크톱·모바일 반응형 규칙에서 숨기지 않는다. 첫 배포 점검에서 computed style은 노란색·3px·visible이었지만 `z-index:0`이 header 뒤로 빠져 실제 픽셀이 배경색인 문제를 발견했다. bar에 `isolation:isolate`를 적용해 로컬 stacking context 안에서 실제로 칠해지게 했고, 전용 회귀 테스트가 stacking context와 `display:none`, `visibility:hidden`, `opacity:0` 재도입을 차단한다.
- 실제 OBS 30.2.0의 `Rekasong` Browser Source에서 60분 AAC fixture를 재생했다. 56분까지 player 1개, OBS 후보 1개, 같은 lease target, `audible`·`playing`이 매분 유지됐고 Rekasong CEF renderer private memory는 약 38.1MiB에서 43.5~46MiB 범위로 회수돼 시간 비례 증가가 관측되지 않았다.
- 첫 장시간 실행은 약 56분에 **Dashboard control WebSocket만** 유휴 종료되어 harness가 실패했다. 실제 OBS mixer 신호는 그 뒤에도 자연 종료 시점까지 계속됐고, 즉 이미 재생 중인 OBS media graph는 제어 연결 손실 때문에 pause·detach·재시작되지 않았다.
- 원인은 player heartbeat snapshot을 control에 매번 중계하지 않도록 비용을 줄인 뒤 control role에 별도 keepalive가 없었던 것이다. control은 명령이 없으면 장시간 wire frame이 0개였다.
- 보강 후 control은 30초마다 최소 `control_heartbeat` 한 프레임만 전송한다. Worker는 이를 응답, Durable Object storage write, attachment update, snapshot broadcast, lease mutation 없이 소비한다. 비용은 control 하나당 분당 2개 수신 event이고 playback 권한은 없다.
- 예외적인 socket close에는 동일 coordinator와 동일 `controlInstanceId`로 1.5초부터 최대 30초의 bounded reconnect를 수행한다. route·LOAD·PLAY·STOP을 자동 재전송하지 않으며 새 authoritative welcome+snapshot이 기존 run/lease와 정확히 일치해야만 연결 손실 표시를 해제한다. 종료된 session은 재접속하지 않는다.
- 보강판을 production Worker와 Pages에 배포한 뒤 같은 실제 OBS Browser Source에서 60분 전체를 다시 실행했다. wall duration은 3,600,150ms, media duration은 3,600,000ms로 오차 150ms였고, player/OBS 후보 1/1, 같은 lease target, `audible`·`playing`을 종료 직전까지 유지했다. player identity 전환, unsafe route 관측, duplicate, unknown lease는 모두 0건이었고 종료 session 재조회는 HTTP 410이었다.
- 재실행 중 control transport disconnect 관측은 3건, reconnect 시도는 2건, 최대 gap은 825ms였다. 모두 같은 control/player identity로 복구됐고 route·LOAD·PLAY·STOP 재전송과 media graph 교체는 0건이었다. 따라서 짧은 제어 전송 재접속이 이미 재생 중인 OBS 출력 경로를 끊거나 다시 시작하지 않는다는 연결 우선 계약을 통과했다.
- 최종 cache refresh 뒤 생성된 실제 Rekasong CEF renderer PID 64028의 private memory는 60분 관측 내내 14.8MiB, working set은 약 33.5~33.6MiB로 유지돼 renderer crash나 시간 비례 메모리 증가가 없었다. 이 결과는 실제 CEF의 장시간 재생·경로·자원 관문이며, 물리 청취 및 ingest 이후 결과물은 여전히 G5/G6에서 별도로 판정한다.
- 시험 뒤 OBS Browser Source URL은 시험 전 값과 길이·SHA-256이 일치하도록 복원하고 cache refresh 뒤 Properties를 닫았으며 clipboard도 비웠다. credential-bearing URL은 로그와 문서에 남기지 않았다.
- 실제 OBS CEF 60분 장시간 항목과 G4 녹화 artifact는 통과했다. G5 실제 stream과 G6 마이크↔MR 싱크는 여전히 미실행이다.

> 작업 범위: `D:\Agents\rekasong\Codex\workspace`만 수정했다.
> 판정 원칙: 실제 OBS CEF·mixer·녹화·stream artifact가 없는 상태를 “OBS 송출 확인 완료”로 표시하지 않는다.
> 배포 상태: frontend `0.2.5` / release commit `743ac9a`, Worker version `7a725d35-6372-4422-b45b-2809c118ff73`를 production에 배포했다. v0.2.5는 공개 Dashboard UX·성능 smoke와 의존성 정리이며 런타임 UI 자산 hash는 유지된다.

## 1. 현재 결론

출력 선택과 OBS 점검을 안전하게 만들기 위한 Protocol v2, Worker, 공통 재생 엔진, 결정적 PCM fixture, source resolver, 출력 상태 계산, control coordinator의 기반은 구현됐다.

아직 제품 완료는 아니다.

- Dashboard에는 speaker/OBS 출력 selector와 v2 speaker player가 연결되지 않았다.
- legacy control과 v2 control의 동시 동작을 막는 UI bridge가 완전히 연결되지 않았다.
- 앱 내부 media 재생과 marker 전달은 OBS mixer·녹화·실제 송출의 증거가 아니다.
- 실제 OBS와 오디오 장치에서 G3–G6 증거를 수집하지 않았다.
- production Worker와 프런트에는 이번 변경을 배포하지 않았다.

따라서 현재 자동 증명의 상한은 브라우저 로컬 재생·프로토콜 전달 계층인 G2다. 실제 장비 판정은 `OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md`를 따른다.

## 2. production 연결 경로

- `.env.production`은 `https://rekasong-session.11qaws.workers.dev`를 사용한다.
- `.env.staging`은 `https://rekasong-session.11qaws-test.workers.dev`를 사용한다.
- production build에는 production Worker 주소만 포함되고 staging 주소는 포함되지 않아야 한다.
- 새 `player_snapshot` validator는 `activeFamily`와 `activeCheckId`를 필수로 요구한다.
- 나중에 배포할 때는 **Worker 먼저 → snapshot 필드 실측 → 프런트 canary** 순서로 진행한다. 순서를 바꾸면 새 프런트가 구 Worker snapshot을 거부한다.
- 자동 장애 주입·장시간 재생·test fixture는 production에서 실행하지 않는다.

## 3. 구현된 기반

### 3.1 출력 상태와 번역 준비

대상:

- `src/lib/onAirOutputView.js`
- `src/copy/outputMessages.js`
- `tests/onAirOutputView.test.mjs`
- `tests/outputMessages.test.mjs`

구현 내용:

- speaker와 OBS 후보를 mode별로 독립 계산한다.
- 현재 mode가 아니라 전환 목적지 후보를 기준으로 activation gate를 계산한다.
- 현재 route가 duplicate·unknown이면 목적지가 정상이어도 전환을 막는다.
- cold session에서 speaker/OBS activation 가능 여부를 각각 표현한다.
- 요청, lease, 실제 playback, test 진행, adapter 상태를 한 단계로 뭉치지 않는다.
- `speaker_playback`, `obs_mixer`, `obs_recording`, `obs_stream_artifact`, `karaoke_sync` 검증 scope를 서로 덮어쓰지 않는다.
- 검증 record가 잘못돼도 route truth를 조작하지 않는다.
- 사용자 문장 대신 semantic key와 구조화 code를 반환한다.
- 신규 출력·OBS key마다 한국어 fallback 존재 여부를 자동 검사한다.
- OBS mode의 로컬 무음이 정상이라는 사실과, 그것이 최종 송출 증명이 아니라는 사실을 동시에 표현할 copy를 마련했다.

전체 앱 번역은 아직 끝나지 않았다. 이후 순서는 `I18N_IMPLEMENTATION_PLAN_2026-07-19.md`를 따른다.

### 3.2 Protocol v2와 Worker

대상:

- `src/lib/onAirProtocol.js`
- `src/lib/onAirClientState.js`
- `src/lib/onAirV2Connection.js`
- `workers/rekasong-session/src/index.js`
- 관련 protocol/client/Worker 테스트

구현 내용:

- control/player hello와 명시적 protocol=2 opt-in
- writable control lease와 explicit takeover CAS
- speaker/OBS mode별 eligible candidate와 단일 output lease
- run의 `entryId + runId`, route의 `switchId`, test의 `checkId`, concrete connection과 lease epoch fence
- desired transport와 confirmed playback 분리
- authoritative `playing`만 audible 증거로 사용
- 정확한 SEEK/VOLUME postcondition과 강한 STOP·emergency detach postcondition
- active run과 active test의 상호 배제
- heartbeat warning/stale 경계와 target disconnect·`sourceActive=false`의 durable unknown 전이
- command/event 중복·충돌·재접속·저장 실패의 exactly-once/unknown 처리
- `activeFamily`와 `activeCheckId`를 포함한 control snapshot
- run receipt, authoritative event, telemetry, route, test lifecycle, test telemetry, emergency를 분리한 sequence namespace

`test_marker`는 다음 계약을 가진다.

- `testTelemetry` namespace를 사용한다.
- Durable Object storage에는 marker마다 쓰지 않는다.
- 연결 attachment high-water와 pending ledger에서는 reliable ACK 대상이다.
- reconnect 시 event ID와 sequence를 유지하고 concrete connection만 다시 결합한다.
- marker 뒤 `test_complete`의 같은-player 처리 순서를 보존한다.

`test_failed`의 `detail.safetyStopped`가 없거나 `false`이면 Worker는 성공 가능한 ready route를 보존하지 않는다.

- `activeCheckId`를 종료한다.
- output lease와 session transport를 동시에 `unknown`으로 낮춘다.
- `confirmedPlayback.reasonCode=test_safety_stop_failed`를 기록한다.
- 종료 후 새 `player_snapshot`을 broadcast한다.

테스트 fixture 길이는 renderer·adapter·coordinator·schema·Worker 모두 1,000–10,000ms의 safe integer로 통일했다.

### 3.3 공통 media graph와 source

대상:

- `src/lib/playbackEngine.js`
- `src/lib/onAirSourceResolver.js`
- `src/lib/onAirTestFixture.js`
- `src/lib/obsRuntimeAttestation.js`
- `src/lib/onAirPlaybackAdapter.js`

구현 내용:

- speaker와 OBS가 공유할 단일 `HTMLMediaElement` 상태 기계
- LOAD와 PLAY 분리, DOM media event 기반 READY/PLAYING/PAUSED/BUFFERING/ENDED/ERROR 증거
- pause, source/srcObject/source child 제거, autoplay 취소, `load()`, object URL 회수를 포함한 강한 detach
- prepared YouTube와 session asset의 전체 Blob fetch, 크기·type·status 검사, abort, object URL ownership
- OBS runtime/sourceActive attestation을 media source attachment와 분리
- 결정적 48kHz PCM WAV pulse fixture와 고정 marker schedule
- 곡과 같은 PlaybackEngine·audio element·Blob graph에서 TEST fixture 재생
- READY 뒤 PLAY, 실제 PLAYING 전에는 `test_started`를 보내지 않음
- 자연 종료 시 요청 길이·media time·예상 marker가 모두 충족돼야 완료
- marker event가 Worker에서 ACK될 때까지 완료를 보류
- READY, PLAYING, media progress, hard end, marker ACK의 독립 watchdog
- early END, marker drop/coalesce/outcome unknown, timeout, disconnect, route 취소, STOP race에서 emergency detach 후 안정적인 실패 code
- run/test 상호 배제와 reconnect·dispose의 자동 resume 금지

중요한 증거 한계:

- marker는 예정된 media time에 전달된 이벤트이지, pulse를 마이크로 다시 검출한 결과가 아니다.
- `test_started`는 실제 media element의 PLAYING 증거지만 OBS mixer 입력 증거는 아니다.
- `test_complete`는 브라우저 로컬 graph와 프로토콜 전달이 끝났다는 뜻이며, OBS 녹화·stream 인증을 자동 생성하지 않는다.
- RMS/peak가 없으면 가짜 meter를 만들지 않는다.

### 3.4 control coordinator

대상:

- `src/lib/onAirControlCoordinator.js`
- `tests/onAirControlCoordinator.test.mjs`

구현 내용:

- session URL fence, duplicate connect 차단, reconnect authority 초기화
- sticky unknown과 자동 retry·resume·speaker fallback 금지
- explicit deactivate 완료 후에만 새 mode activate 허용
- caller가 가진 정확한 `entryId/runId` 쌍으로 LOAD 가능; 둘 다 생략한 호환 경로는 새 ID 생성
- `endSession`, `publishDisplayState`, `prefetch` typed API
- 요청된 check와 실제 `test_started`를 분리한 `testEvidence`
- test lifecycle과 marker의 독립 sequence 검사
- marker 64개 상한, 마지막 terminal 보존, locale-neutral callback
- reconnect generation fence와 test 자동 재전송 금지
- fixture 길이 1,000–10,000ms safe integer 검사

이 coordinator는 React UI에 아직 연결되지 않았다. 순수 상태·명령 계약만 자동 검증했다.

### 3.5 Widget와 bundle 경계

- 기존 Widget player는 기본 rollback 경로로 유지한다.
- URL에 `protocol=2`가 명시된 player만 `OnAirPlayerV2`를 lazy load한다.
- v2 player는 runtime attestation, source resolver, 공통 adapter를 사용한다.
- 일반 브라우저를 OBS player로 위장하지 않는다.
- Dashboard speaker용 `dashboard-speaker` player는 별도 연결 과제다.

### 3.6 OBS 전용 페이지 경량화와 메모리 경계

대상:

- `src/App.jsx`
- `src/pages/Widget.jsx`
- `src/pages/DisplayWidget.jsx`
- `src/components/OnAirPlayerV2.jsx`
- `src/components/OnAirPlayer.jsx`
- `src/lib/onAirPrefetchCache.js`
- `src/lib/onAirSourceResolver.js`
- `scripts/check-obs-player-bundle.mjs`

구현 내용:

- Dashboard와 Widget을 route 단위로, Widget의 display·legacy·v2 player를 mode 단위로 lazy load한다.
- OBS v2의 정적 graph에서 Dashboard, DisplayWidget, legacy player, Firebase, framer-motion, react-youtube를 제외한다.
- 전역 Google Fonts import를 없애고 Dashboard/display 전용 CSS로 이동해 오디오 전용 route의 외부 font 요청을 0건으로 만들었다.
- production artifact 예산을 raw `450KiB`, gzip `130KiB`로 고정하고 `npm run check:obs:bundle`로 검사한다.
- v2 PREFETCH는 wire hint 최대 2개를 받아도 materialize 1개, cache 1개, 합계 `64MiB`만 유지한다. 최신 hint 교체, 연결 손실, session end, dispose에서 fetch와 Blob을 취소·회수한다.
- OBS v2의 직접 LOAD도 `64MiB`로 제한한다. active+prefetch retained 상한은 `128MiB`이며 더 큰 source는 disk-backed 정책 전까지 OBS v2에서 거부한다.
- legacy player도 다음 곡 1개와 `64MiB`로 제한하고 stale fetch를 abort한다. 다만 rollback 경로의 첫 곡/prefetch miss streaming 특성은 그대로이므로 방송 안전 인증 대상은 v2다.
- 길이를 신뢰할 수 있는 일반 HTTP(S) 응답은 `response.blob()`을 사용해 JS `chunks[]` 복제를 피한다. 길이가 없거나 압축·합성 응답이면 기존 bounded reader로 안전하게 fallback한다.
- 4Hz heartbeat는 coordinator의 React-facing snapshot publish를 만들지 않는다.

현재 남은 성능 한계:

- 실제 OBS CEF의 fetch backing store와 decoder 메모리는 헤드리스 Chrome으로 증명할 수 없다. active `64MiB` + prefetch `64MiB`, 100곡 전환, 60분 soak를 실제 OBS에서 측정해야 한다.
- Dashboard history는 1,000곡 원본을 보존하면서 고정 100행 window와 production-browser 예산을 통과했다. local Blob 소유권의 최근 3~5개/합계 byte cap은 아직 없으므로 로컬 파일을 반복 재생하는 장시간 메모리 안전성은 별도 관문으로 남는다.
- DisplayWidget의 fullscreen blur·particle·animation은 오디오 v2 route에는 들어오지 않지만 실제 OBS display source의 GPU 부하는 별도로 측정해야 한다.

## 4. UI에서 지켜야 할 진실 계층

| UI 표현 | 필요한 최소 증거 | 아직 증명하지 못하는 것 |
|---|---|---|
| 플레이어 페이지 연결 | negotiated player record | 재생, OBS 여부 |
| 출력 경로 준비 | matching lease + output_ready | PCM, mixer |
| 플레이어 재생 확인 | matching authoritative playing | OBS mixer, 녹화 |
| 테스트 진행 중 | matching test_started | 최종 출력 |
| 앱 marker 전달 완료 | 모든 marker ACK + strong stop | pulse 실검출, OBS 입력 |
| OBS 믹서 확인 | 사용자가 정확한 input meter 확인 | 녹화 track |
| OBS 녹화 확인 | artifact PCM 분석 | 플랫폼 송출 |
| OBS 송출 확인 | ingest/VOD artifact 분석 | 마이크↔MR 싱크 |
| 카라오케 싱크 확인 | offset·drift 기준 통과 | 다른 장비·profile |

UI는 이 표의 아래 행을 위 행의 증거로 대신하거나, 위 행을 아래 행의 성공으로 승격하면 안 된다.

## 5. 자동 검증 체크포인트

2026-07-22 최신 회귀 결과:

```powershell
npm test                         # 634/634 pass, 0 fail
npm run lint                     # exit 0, 기존 무관 warning 2건
npm run build                    # exit 0, 2,257 modules
npm run check:obs:bundle         # obs_player_bundle_budget_passed
```

추가 확인:

- Worker, playback adapter, coordinator, protocol, source resolver, prefetch cache, `useOnAirSession`의 `node --check`가 모두 통과했다.
- `git diff --check`는 공백 오류 없이 통과했다. 출력된 LF→CRLF 문구는 Git의 line-ending 경고다.
- lint warning 6건은 `functions/api/gemini.js`와 `src/components/SearchPanel.jsx`의 기존 항목이며 이번 OBS/performance 변경에서 새 warning을 만들지 않았다.
- production build는 500KiB chunk warning과 CSS `@import` warning 없이 성공했다.
- production 산출물에서 production Worker URL은 2회, staging Worker URL은 0회 검출됐다.

OBS v2가 선택하는 production artifact:

| 지표 | 측정값 | 예산 | 판정 |
|---|---:|---:|---|
| raw | 382,301B | 460,800B | 통과 |
| gzip | 116,110B | 133,120B | 통과 |
| brotli | 101,713B | 참고 | 통과 |

브라우저 cold-route 비교는 route split 전 231,345B에서 115,317B로 전송량이 50.1% 감소했고, decoded resource는 799,837B에서 384,573B로 51.9% 감소했다. 같은 개발 PC에서 load 중앙값은 244.7ms에서 68.9ms, JS heap은 2.94MB에서 2.43MB로 줄었다. 이 수치는 로컬 Chrome 기준이며 OBS CEF 합격 증거가 아니다.

4Hz heartbeat 10초 측정에서는 40회 수신, DOM mutation 0회, DOM node 변화 0, ScriptDuration 13.37ms, TaskDuration 31.19ms, 강제 GC 후 heap 변화 +4,676B였다.

## 6. 로컬 브라우저 관측

- 사용자가 알려 준 `http://127.0.0.1:5000/`는 점검 시점에 연결이 거부되어 해당 프로세스의 UI를 검증하지 못했다.
- Codex workspace의 최신 production preview에서 v2 route는 `<audio>` 1개, 전체 DOM 15개, 빈 본문으로 렌더됐고 display animation이나 Dashboard UI를 만들지 않았다.
- 같은 build의 Dashboard와 OBS 설정 dialog가 정상 렌더됐으며 현재 preview URL과 관련된 console warning/error는 0건이었다.
- OBS 설정 dialog에서 오디오 player 필수/정보 display 선택, `Control audio via OBS`, 단일 source, shutdown/refresh lifecycle, session 종료 안내를 확인했다.
- 현재 UI에는 speaker/OBS selector가 아직 없음을 확인했다. 이는 미완료 상태와 일치한다.
- 실제 OBS CEF와 mixer는 이 브라우저 관측에 포함되지 않았다.

## 7. 남은 P0

1. legacy `useOnAirSession` socket과 v2 coordinator를 기능 플래그 아래 완전히 상호 배제한다.
2. Dashboard 전용 `dashboard-speaker` player를 공통 adapter와 source resolver로 만든다.
3. `useOnAirOutputController`에서 session lifecycle, coordinator, output view를 한 owner로 묶는다.
4. idle-only selector와 명시적 deactivate → authoritative inactive → target 재평가 → activate transaction을 연결한다.
5. 요청·확정 playback, 로컬 무음 설명, test requested/started/marker ACK, G3–G6 사용자 확인을 각각 표시한다.
6. React StrictMode, reconnect, session 교체에서 control socket과 audible lease가 최대 하나인지 통합 테스트한다.
7. 설정 점검 UI를 동일 media graph의 생성 pulse와 연결하되 앱 marker 완료, OBS mixer 사용자 확인, 녹화 artifact를 서로 다른 증거로 저장한다.
8. active/prefetch 각 64MiB, 100곡 전환, 60분 재생과 display GPU를 실제 OBS CEF에서 soak한다.
9. local과 격리 staging에서 G0–G2를 통과한 뒤 실제 OBS에서 G3–G6를 실행한다.

남은 P1 성능 작업:

- [x] Dashboard history를 고정 100행 window로 제한하고 닫힌 상태를 0행으로 만든다. 1,000곡 payload가 1MiB 미만인 동안 archive는 필수 조건이 아니다.
- 로컬 감상 Blob을 최근 3~5개 또는 합계 256MiB 같은 명시적 예산으로 제한하고 URL 생성·회수 수를 계측한다.
- [x] 1,000곡 history에서 렌더 row, cold/warm 조작, localStorage payload, 모바일 overflow, post-GC heap을 production Chromium으로 측정한다.
- 불필요한 control heartbeat relay를 제거하거나 1Hz로 coalesce한다.

## 8. 실제 OBS와 배포 순서

실제 검증:

1. G0 build/schema
2. G1 player/lease/ACK
3. G2 same-graph PLAYING/marker
4. G3 정확한 OBS input mixer
5. G4 녹화 artifact
6. G5 test stream artifact
7. G6 마이크↔MR offset·10분 drift

배포:

1. 격리 staging Worker
2. staging v1/v2 혼합 smoke와 쓰기량 확인
3. production Worker 먼저 배포
4. production `player_snapshot.activeFamily/activeCheckId` read-only 확인
5. 프런트 canary
6. 실제 OBS 짧은 수동 관문
7. 문제 시 프런트 기능 플래그를 legacy로 되돌리고, 모호한 출력은 자동 재생하지 않음

## 9. 완료 판정

현재 완료된 것은 안전 기반과 자동 계약이다. 사용자가 처음 설정할 때 “리모컨과 OBS가 같은 동작을 하고 실제 방송에 정확한 반주가 들어간다”고 판정하려면 UI bridge, 실제 OBS mixer·artifact, 카라오케 sync 증거가 모두 추가로 필요하다.
