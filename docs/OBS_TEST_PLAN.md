# WEB ↔ OBS 송출 통합 테스트 계획

## 2026-07-20 연결 우선 복구 규칙

OBS 모드의 검증은 송출 경로를 지키기 위한 것이지, 일시적인 WebSocket 지연으로 로컬 재생을 끊기 위한 것이 아니다.

- 브라우저 소스의 `sourceActive=false` 또는 `sourceVisible=false`는 장면 전환에서도 정상적으로 발생한다. 이미 연결된 플레이어의 media graph를 정지하거나 lease를 unknown으로 내리지 않고, OBS 믹서 확인 안내만 표시한다.
- WebSocket 재연결, heartbeat 지연, 명령 응답 유실만으로는 로컬 오디오를 즉시 정지하지 않는다. 현재 오디오 그래프와 재생 위치는 유지하고, 화면에는 연결 유지 또는 확인 중인 사실을 표시한다.
- 재연결 중 명령은 성공으로 간주하지 않는다. 자동 재생·스피커 fallback·다른 소스로의 자동 전환은 하지 않는다.
- 동일한 OBS player ID와 OBS capability가 다시 연결되면 현재 장면 visibility와 무관하게 Worker lease를 `ready`로 복원한다. `confirmedPlayback`은 `output_reconnected`로 남기며 재생은 사용자가 다시 누를 때만 시작한다.
- 스피커는 서버 player 후보·lease·heartbeat·control owner를 사용하지 않는다. 모든 탭의 로컬 Speaker가 독립적으로 즉시 선택·조작 가능해야 한다.
- OBS Browser Source API는 초기 active/visible 상태 getter를 제공하지 않는다. callback 전 `unobserved`를 `false`로 단정하지 않고, OBS binding+최신 heartbeat가 있으면 후보로 인정한다. 실제 callback의 `false`는 새 활성화를 계속 차단한다.

이 규칙은 연결이나 장면 상태가 잠깐 흔들릴 때 방송을 끊지 않으면서도, 실제 socket 종료와 명시적 정지 결과는 놓치지 않는 경계다.

> 목표는 “플레이어가 연결됐다”가 아니라, 반주 PCM이 OBS 최종 출력에 들어가고 라이브 마이크와의 상대 싱크가 방송 내내 유지된다는 사실을 증명하는 것이다.

실제 장비에서 이 계획을 실행할 때는 `OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md`의 G0–G6 관문과 증거 기록 양식을 사용한다. 2026-07-20의 실행 결과와 잔여 검증은 `OBS_VALIDATION_STATUS_2026-07-20.md`, 제품·상태 설계 기준은 `AUDIO_OUTPUT_OBS_MASTER_PLAN_2026-07-19.md`를 우선한다.

## 1. 증거 단계를 섞지 않는다

| 단계 | 증명하는 것 | 증명하지 못하는 것 | 판정 주체 |
|---|---|---|---|
| A. player presence | player 역할 WebSocket이 열림 | OBS 여부, 오디오 재생·캡처 | 자동 |
| B. 위젯 media/analyser | 브라우저 위젯이 PCM을 생성 | OBS 믹서 입력·최종 출력 | 자동 |
| C. OBS 소스 믹서 meter | OBS가 해당 소스 신호를 캡처 | 녹화/방송 트랙 라우팅 | 실제 OBS |
| D. OBS 녹화 결과 | 최종 믹스 또는 지정 트랙에 신호 존재 | 마이크↔반주 상대 싱크 | 실제 OBS + 파일 분석 |
| E. 마이크↔MR 파형 비교 | 고정 지연과 장시간 drift | 다른 PC·오디오 장치의 결과 | 실제 장비별 1회 |

연결 칩은 A만 의미한다. D까지 통과해야 “OBS 송출 확인 완료”, E까지 통과해야 “카라오케 싱크 확인 완료”로 판정한다.

## 2. 테스트 환경 격리

- 사용자가 현재 띄운 로컬 프론트: `http://127.0.0.1:5000/`. 실행 주체와 빌드 mode를 확인한 뒤 테스트하며 임의로 다른 에이전트 폴더의 프로세스나 소스를 조작하지 않는다.
- 포트 충돌 또는 격리 staging이 필요하면 Codex 빌드를 `http://127.0.0.1:5100/`에 별도로 띄운다.
- staging Worker: `https://rekasong-session.11qaws-test.workers.dev`.
- prod Worker에는 자동·장애·부하 테스트를 실행하지 않는다.
- 앱과 시험 자동화는 OBS의 방송 시작·종료를 호출하지 않는다. 스트림 키가 설정돼 있어도 `Start Streaming`은 사용자만 조작하며, 자동 시험의 허용 범위는 사용자가 승인한 로컬 녹화 시작·종료까지다.
- 실제 OBS에서 PCM을 재생하기 직전에 `streaming=false`를 새로 확인하지 못하면 시험을 중단한다. 이전 확인, 버튼 위치 추정, 타이머 `00:00:00`, 스트림 키 유무는 현재 방송 OFF의 대체 증거가 아니다.
- 실제 장비 시험은 전용 test profile·scene collection·scene에서만 실행한다. 현재 방송용 장면이나 원본 Browser Source URL을 시험 주소로 바꾸지 않으며, 전용 환경이 없으면 headless 가상 플레이어까지만 검증한다.
- 공유 staging에서는 짧은 smoke만 수행하고 `end_session`으로 정리한다.
- 장시간 장애·부하·DO 쓰기량 검증은 격리된 로컬 Worker/R2 fixture에서 수행한다.

Codex smoke 실행:

```powershell
npm ci
npm run build -- --mode staging
npm run preview -- --port 5100 --host 127.0.0.1
$env:REKASONG_APP='http://127.0.0.1:5100'
npm run test:obs:staging
```

위 명령은 legacy 실제 미디어 경로다. 최신 Protocol v2의 G2 smoke는 격리된 로컬 Worker와 최신 앱을 띄운 뒤 별도로 실행한다.

```powershell
npx wrangler dev --config workers/rekasong-session/wrangler.jsonc --local --port 8787
npm run dev -- --host 127.0.0.1 --port 5100
$env:REKASONG_WORKER='http://127.0.0.1:8787'
$env:REKASONG_APP='http://127.0.0.1:5100'
npm run test:obs:v2
npm run test:obs:v2:continuity
npm run test:obs:v2:continuity:soak
npm run test:obs:v2:safety
npm run test:obs:v2:idle-soak
```

## 3. 설정 1회 필수 관문

### 3.1 무음 방송 방지

1. OBS 브라우저 소스에서 `Local file`을 해제한다.
2. On-Air 플레이어 소스에서 `Control audio via OBS`를 체크한다.
3. 해당 소스가 음소거되지 않았고 원하는 방송/녹화 트랙에 라우팅됐는지 확인한다.
4. 앱의 `OBS 오디오 송출 점검`을 실행한다.
5. 동일한 `<audio>` 출력 경로로 `삐-삐-삐` 기준 WAV를 재생한다.
6. 앱 내부 meter가 움직이는지 확인한다(B).
7. OBS의 정확한 소스 mixer meter가 같은 박자로 움직이는지 확인한다(C).
8. 10초 녹화 후 파일에서 동일 패턴이 들리고 파형이 존재하는지 확인한다(D).

생성 톤을 별도 `OscillatorNode`로만 재생하면 실제 곡의 `HTMLMediaElement` 경로를 검증하지 못한다. 테스트 PCM은 결정적 WAV로 만들되 실제 곡과 같은 media element 및 출력 노드를 사용한다. Worker/R2 전달 경로 자체는 별도의 준비된 기준 트랙으로 검증한다.

### 3.2 카라오케 싱크 관문

1. 시작·중간·끝을 구분할 수 있는 click marker가 든 10분 기준 트랙을 플레이어로 재생한다.
2. 같은 기준 신호를 실제 마이크 체인에도 loopback으로 넣는다. 가능하면 두 신호를 OBS의 분리 트랙으로 녹화한다.
3. 녹화 파일을 PCM WAV로 추출하고 시작·중간·끝 구간의 파형 상호상관으로 상대 offset을 구한다.
4. 고정 offset은 OBS `Sync Offset`으로 보정하고 다시 녹화한다.
5. 시작과 끝의 offset 차이로 drift를 판정한다.

초기 프로젝트 판정 기준 제안:

- marker 누락·중복 및 청취 가능한 dropout: 0회
- 보정 후 마이크↔MR 고정 offset: 목표 `±20ms` 이내
- 10분 시작↔끝 상대 drift: `10ms` 이내
- click 간격 오차 p95: `5ms` 이내

이 수치는 첫 실제 가창 청취 결과에 따라 더 엄격하게 조정한다.

## 4. 자동 검증 매트릭스

### 4.1 연결·프로토콜

- [자동] control/player/display presence 전이와 새로고침 snapshot 복원.
- [자동] OBS player 미연결 시 OBS 송출만 차단한다. Speaker는 Worker player 후보가 아니며, 현재 탭의 로컬 `<audio>`가 늦게 준비되면 사용자 명령을 탭 내부에서 최대 12초 동안 순서대로 보존한다. 준비 실패는 그 재생 시도만 실패시키고 다음 클릭에서 media session을 다시 준비하며, 서버 route·control owner·다른 탭 상태로 Speaker를 차단하지 않는다.
- [자동] 일반 브라우저도 player presence를 만들 수 있음을 회귀 테스트해, UI가 이를 OBS 증거로 표현하지 않게 한다.
- [자동] 동일 room의 OBS 중복 player 연결 탐지와 단일 OBS player lease. legacy Speaker player는 여러 개가 공존해도 exact-one 오류를 만들지 않는다.
- [자동] room/session 격리와 다른 세션 이벤트 차단.
- [자동] `entryId + runId + playerInstanceId`로 같은 entry의 이전 run 늦은 이벤트 차단.

### 4.2 실제 media element

- [자동] ready YouTube 첫 곡의 cold streaming 재생, pause, seek, ended/error.
- [자동] 실제 `playing/buffering/position/ended/error` 이벤트가 control에 돌아오는지 확인.
- [자동] `currentTime`과 `performance.now()`를 100ms 이하 간격으로 표본화해 역행·정지·dropout을 검사.
- [자동] 자동재생 차단 시 실패 이벤트와 사용자 안내가 정확한지 확인.
- [자동] 로컬 오디오와 비디오 자산의 Range, seek, 종료.

### 4.3 프리버퍼와 네트워크

- [자동] ready 큐 곡의 fetch가 끝난 뒤 materialized Blob source로 재생되는지 확인.
- [자동] blob 재생 중 네트워크를 차단해 끝까지 진행되는지 확인.
- [자동] prefetch 미스도 LOAD resolver가 전체 응답을 검증·materialize한 뒤에만 media element에 붙이는지 확인.
- [자동] PREFETCH는 wire hint 최대 2개를 받아도 동시 materialize 1개, 보유 Blob 1개, aggregate 64MiB를 넘지 않는지 확인.
- [자동] hint 교체·연결 손실·세션 종료·언마운트에서 in-flight fetch와 보유 Blob이 즉시 취소·회수되는지 확인.
- [자동] cache hit LOAD가 Blob을 take/delete하여 cache와 engine이 같은 Blob을 장기 중복 소유하지 않는지 확인.
- [자동] OBS v2 direct LOAD 64MiB + PREFETCH 64MiB의 retained 상한 128MiB와 body-read 중 보수적 transient 상한 256MiB를 실제 heap/프로세스 메모리로 측정.

`preload="auto"`나 일부 다음 곡의 blob만으로 “모든 곡이 재생 중 네트워크 의존 0”이라고 판정하지 않는다.

### 4.4 장애와 상태 일치

- [자동] `test:obs:v2:continuity`에서 일반 30초 세션 asset을 완전히 Blob으로 준비·재생한 뒤 현재 player WebSocket을 실제 close한다. 같은 media graph가 pause+detach 없이 진행되고, 같은 player/entry/run과 lease가 `output_reconnected`로 복원되며 PLAY/PLAYING이 각 1회인지 관측한다. 페이지 종료처럼 실제 media graph가 사라지는 경우에는 재접속 뒤 자동 LOAD/PLAY 없이 명시적 복구만 허용한다.
- [자동] 재접속만으로 LOAD/PLAY가 0회인지, adapter가 `safetyLocked`와 `autoResumeAllowed=false`를 유지하는지 확인.
- [자동] 명시적 deactivate→activate→LOAD→PLAY 뒤에만 실제 media와 authoritative snapshot이 다시 수렴하는지 확인.
- [자동] source refresh/페이지 재생성은 새 instance이며 자동 takeover·자동 resume가 없음을 확인.
- [자동] On-Air skip이 실제 player 종료 확인 뒤 다음 곡으로 넘어가는지 확인.
- [자동] 세션 종료 시 media 정지, socket 종료, object URL 회수.
- [자동] position/seek/prefetch 이벤트의 DO storage write 횟수 계측.

### 4.5 Speaker 로컬 재생 ↔ OBS 출력 선택

- [자동] 모든 Dashboard 탭·창이 서로 다른 로컬 Speaker player와 현재 곡/run을 가질 수 있다. Speaker player 수, OBS 제어권, heartbeat, route 상태는 Speaker 선택·재생·일시정지·탐색·볼륨·skip을 잠그지 않는다.
- [자동] Speaker의 `currentEntry`와 active run은 다른 탭의 storage event로 복제되지 않는다. 큐·이력·노래책·일반 설정만 공유한다.
- [자동] 로컬 Speaker 곡이 재생·일시정지 중이면 OBS 전환을 거부하고 곡을 끝내거나 버리라는 행동을 안내한다. OBS→Speaker 선택은 즉시 반영하며 기존 OBS STOP 결과를 기다리지 않는다.
- [자동] OBS→OBS target 교체는 old target의 matching `output_deactivated` 또는 inactive snapshot 없이 새 activation을 보내지 않는다.
- [자동] OBS `output_deactivation_failed`, socket loss, 명령 결과 불명 중 어느 하나라도 발생하면 다른 OBS source 자동 activation을 금지한다. Speaker를 자동 fallback으로 선택하거나 Speaker를 함께 잠그지 않는다.
- [자동] `output_ready`는 paused+detached+autoplay-cancelled+path-ready+non-audible 5개 조건을 모두 만족해야 하며, 그 뒤에만 LOAD를 허용한다.
- [자동] OBS mode에서 Dashboard의 speaker media element는 paused+detached이고, UI는 로컬 무음이 정상이라는 사실과 OBS 최종 송출 미확인을 동시에 표시한다.
- [자동] desired playing만으로 ON AIR를 표시하지 않고 current target/run/lease가 일치하는 authoritative playing evidence를 요구한다.

### 4.6 OBS 플레이어 성능·자원 수명

방송용 숨은 페이지는 Dashboard와 다른 성능 예산을 가진다. 로컬 개발 PC에서 한 번 빨리 뜨는 것만으로 합격시키지 않고 production build와 장시간 OBS CEF를 모두 측정한다.

- [자동] `protocol=2` cold route가 선택하는 HTML+CSS+JS는 raw `450KiB`, gzip `130KiB` 이하로 유지한다.
- [자동] 해당 정적 import graph에 Dashboard, DisplayWidget, legacy player, Firebase, framer-motion, react-youtube가 들어오지 않는다.
- [자동] 오디오 전용 route에서 Google Fonts와 display 이미지 같은 외부 장식 요청은 0건이어야 한다.
- [자동] 초기 DOM은 상태 wrapper와 단일 `<audio>`만 허용하고 display animation·blur·particle을 만들지 않는다.
- [자동] 정상 OBS heartbeat는 10초 cadence로 transport 내부에서 처리하며 player React state와 control coordinator snapshot publish를 일으키지 않는다. source active/visible 콜백은 한 번으로 coalesce한 storage-free 즉시 heartbeat를 보내고, runtime 값이 실제로 바뀔 때만 control snapshot을 갱신한다.
- [자동] 유휴 control은 30초마다 transport-only heartbeat 한 개만 보내며 Worker는 응답·storage write·attachment update·snapshot broadcast·lease mutation 없이 소비한다. 일시 단절 시 같은 control identity로 bounded reconnect하되 route·LOAD·PLAY·STOP을 재전송하지 않고, 종료 session은 재접속하지 않는다.
- [자동] READY idle 10분 동안 DOM mutation과 long task(`>50ms`)는 0회, main-thread CPU 평균은 기준 PC에서 1% 미만을 목표로 한다.
- [자동] idle 30분과 곡 전환 100회 뒤 post-GC heap이 단조 증가하지 않고, 마지막 post-GC heap이 warm baseline 대비 `16MiB` 이내인지 확인한다.
- [자동] player WebSocket, reconnect timer, heartbeat interval, active media element는 각각 최대 1개인지 계측한다.
- [자동] 64MiB 경계, 64MiB+1, Content-Length 없음, 중단 응답, hint 연속 교체를 포함한 메모리 장애 시험을 실행한다.
- [자동] Dashboard 1,000곡 history에서 실제 렌더 row 100 이하 또는 virtualization, 조작 p95 100ms 이하, localStorage 1MiB 이하인지 검사한다.
- [자동] 로컬 감상 Blob은 설정된 count·byte 예산을 넘지 않고 session 교체·삭제·unmount 뒤 object URL 생성/회수 수가 일치하는지 검사한다.
- [OBS] 60분 재생 soak 동안 CEF renderer crash, audible gap, 중복 player, authoritative route unknown, 지속적인 working-set 증가가 0인지 기록한다. control gap이 생기면 gap 길이·재접속 횟수·동일 identity·명령 재전송 0회·OBS media 연속성을 별도 증거로 남긴다.

번들 예산 통과는 실행 성능을 대신하지 않고, heap/CPU 통과도 실제 OBS PCM·녹화·싱크 증거를 대신하지 않는다.

## 5. 실제 OBS 검증 매트릭스

- [OBS] CEF에서 준비된 AAC/오디오가 실제 재생된다.
- [OBS] `Control audio via OBS` 체크 전/후 mixer 동작이 예상과 일치한다.
- [OBS] source mute, monitoring, Advanced Audio Properties, 방송/녹화 트랙 라우팅.
- [OBS] source hide/show, scene 전환, refresh, OBS 재시작.
- [OBS] pause/seek/곡 전환 때 click·gap·중복 재생이 없다.
- [OBS] 같은 player URL을 두 소스에서 열었을 때 중복 음원·echo를 차단한다.
- [OBS] 10초 최종 녹화에 테스트 신호가 존재한다.
- [OBS] 10분 마이크↔MR 분리 트랙의 offset·drift가 기준을 만족한다.

가능하면 obs-websocket을 선택 기능으로 연결해 방송 OFF 상태와 source 설정 조회, input meter 수집, **로컬 녹화** 시작/종료와 결과 파일 위치 확인을 자동화한다. 방송 시작/종료 명령은 구현하지 않으며, obs-websocket이 없어도 수동 관문은 반드시 남긴다.

## 6. 구현 우선순위

1. 완료: 연결 문구를 일반 player page presence로 낮추고 OBS 송출 완료와 분리했다.
2. 완료: run/player/connection/lease identity, OBS 중복 candidate 차단, route postcondition, 10초 관측 heartbeat와 30/60초 warning/stale 경계, emergency·mutation race를 Protocol v2 자동 테스트로 고정했다.
3. 완료: 공통 PlaybackEngine과 player adapter가 연결 손실·emergency에 physical stop/detach하고 자동 resume를 금지한다.
4. 완료: 전체 Blob source resolver와 bounded prefetch 수신 경계를 구현했다. OBS는 Protocol v2 adapter를, Dashboard Speaker는 탭별 `DashboardLocalSpeaker` controller를 사용하며 물리 재생 엔진만 공유한다.
5. 부분 완료/P0: v2 route split, heavy graph/font 제외, raw/gzip budget, OBS 10초 heartbeat 무렌더, active/prefetch 64MiB cap과 실제 OBS CEF 60분 soak는 완료했다. Dashboard history/local Blob 상한은 남아 있다. 60분 실측은 wall/media 3,600,150/3,600,000ms, player/OBS 후보 1/1, unsafe route와 identity 전환 0건, renderer private 14.8MiB·working set 약 33.5~33.6MiB였다.
6. 완료: Speaker를 서버 출력 selector/lease에서 분리했다. 새 탭은 즉시 Speaker로 시작하고, 각 탭의 현재 곡과 run은 독립적이며, 다른 탭·OBS 제어 상태·legacy Speaker 후보 수 때문에 버튼이나 transport가 잠기지 않는다. OBS 후보 없음·중복은 OBS 선택에만 명시적으로 fail-closed하고 Speaker는 계속 사용할 수 있다.
7. 부분 완료/P0: 같은 graph의 결정적 생성 pulse, reliable marker, 설정 안 시작·중지·진행·안전 정지 UI와 `OBS 출력 중 로컬 무음은 정상` 안내를 구현했다. 앱 재생 증거(G2)와 OBS mixer 직접 확인(G3)을 분리해 표시하며, 실제 G2 뒤 사용자가 정확한 OBS meter의 움직임/미움직임을 기록하는 로컬 확인 UI와 room·player·check 식별 저장도 구현했다. 이 기록은 route나 재생을 바꾸지 않으며, 실제 mixer 관측과 녹화 artifact 판정은 여전히 수동 관문이다.
8. 완료: authoritative/test sequence gap, 강한 종료 증거, outcome unknown 뒤 수동 reconciliation contract를 구현했다. 정상 run 자동 resume는 제공하지 않는다.
9. P1: 실제 OBS 녹화 파형 분석 도구와 10분 싱크 fixture를 추가한다.
10. P1: skip/auto-next/display projection, legacy player count, v2 display presence 공백을 회귀 테스트로 고정한다.
