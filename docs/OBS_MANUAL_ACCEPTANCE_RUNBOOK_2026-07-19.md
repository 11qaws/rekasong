# WEB ↔ OBS 실제 송출 인수 테스트 실행서

> 작성일: 2026-07-19
> 작업 위치: `D:\Agents\rekasong\Codex\workspace`
> 상태: 실행 절차 확정 · 실제 OBS G4 및 CEF 60분 통과 · G6 현재 장치 측정 완료/수용 실패 · G5 미실행
> 목적: “브라우저 플레이어가 연결됨”이 아니라, 반주가 OBS의 의도한 경로에 들어가고 리모컨 동작과 카라오케 상대 싱크가 유지되는지를 실제 증거로 판정한다.

## 1. 이 실행서가 증명하는 범위

검증 결과는 아래 계층을 건너뛰어 승격하지 않는다.

| 단계 | 확인 대상 | 합격해도 아직 말할 수 없는 것 |
|---|---|---|
| G0 | 빌드·schema·Worker 계약 | 브라우저 재생 |
| G1 | 대상 player 연결·lease·명령 ACK | PCM 생성, OBS 입력 |
| G2 | 동일 media element의 실제 `playing`·marker | OBS mixer 입력 |
| G3 | OBS mixer meter에서 신호 관측 | 녹화·실제 stream output |
| G4 | OBS 녹화 artifact에서 기준 패턴 검출 | 플랫폼으로 나간 stream |
| G5 | test stream/ingest/VOD artifact에서 패턴 검출 | 마이크↔반주 싱크 |
| G6 | 마이크↔MR offset·drift 합격 | 다른 장비·profile·scene collection |

화면 문구도 이 단계와 일치해야 한다. G2만 통과한 상태를 `OBS 송출 확인 완료`라고 표시하면 실패다.

## 2. 시험 기록 헤더

시험을 시작하기 전에 아래 값을 한 묶음으로 기록한다.

```text
checkId:
실행 시각(KST):
테스터:
frontend buildId / commit:
Worker deployment/version:
protocolVersion:
fixtureId / fixture hash:
브라우저·CEF 버전:
OBS 버전:
OS / audio device / sample rate:
OBS profile / scene collection / scene / source 이름:
Control audio via OBS:
monitoring mode:
streaming 중 여부:
recording 중 여부:
선택한 output mode:
playerInstanceId / connectionId / leaseEpoch:
```

OBS profile, scene collection, source, audio device, sample rate, monitoring, track routing, 앱 build 또는 fixture가 바뀌면 이전 결과는 `stale`로 내린다.

## 3. 안전 경계

다음 중 하나면 자동 시험을 시작하지 않는다.

- production 방송이 실제 송출 중이다.
- 현재 OBS 상태를 새로 조회해 `streaming=false`임을 확인할 수 없다. 스트림 키가 연결돼 있다는 사실은 방송 상태와 별개이며, 확인 불가는 OFF로 간주하지 않는다.
- OBS가 이미 녹화 중인데 그 녹화의 소유권을 현재 `checkId`로 증명할 수 없다.
- 기존 출력이 완전히 정지했다는 pause·source detach·autoplay cancel 증거가 없다.
- 같은 출력 모드의 eligible player가 0개 또는 2개 이상이다.
- legacy player가 세션에 남아 있다.
- control이 read-only이거나 control epoch가 일치하지 않는다.
- active run 또는 다른 active test가 있다.
- player heartbeat, source-active attestation, lease 또는 실제 media 상태 중 하나가 `unknown`이다.

앱은 위 상황에서 speaker로 자동 fallback하거나 자동 resume하지 않는다. 긴급 정지는 모든 live player에 보내되, 정지 ACK가 모두 모이기 전에는 새 출력을 활성화하지 않는다.

앱과 시험 자동화는 `Start Streaming` 또는 방송 종료를 조작하지 않는다. 실제 OBS 자동 조작은 전용 test profile·scene에서 사용자가 허용한 로컬 녹화 시작·종료만 가능하다. 방송용 profile·scene·Browser Source URL은 시험 대상으로 수정하지 않는다.

## 4. 시험 환경 준비

1. production이 아닌 전용 local/staging Worker, bucket, session을 사용한다.
2. OBS에 전용 test profile과 scene collection을 만든다. 사용자의 실제 방송 profile을 자동 수정하지 않는다.
3. 오디오 Browser Source는 정확히 하나만 둔다.
4. Browser Source에서 `Local file`을 해제한다.
5. `Control audio via OBS`를 체크한다.
6. 장면 전환 중 계속 재생하는 정책이면 `Shutdown source when not visible`과 `Refresh browser when scene becomes active`를 해제한다.
7. 화면 정보 위젯은 오디오 player와 별도 source로 두며, 무음 source임을 확인한다.
8. OBS Advanced Audio Properties에서 monitoring mode와 녹화/방송 track routing을 기록한다.
9. Windows와 OBS의 sample rate를 기록하고 의도치 않은 변환 여부를 확인한다.
10. test scene 외의 모든 audio source를 mute하거나 기록에서 분리한다.

## 5. G0 — 자동 계약 회귀

Codex 작업 폴더에서 다음을 실행한다.

```powershell
npm test
npm run lint
npm run build
npm run check:obs:bundle
node --check workers/rekasong-session/src/index.js
git diff --check
```

합격 기준:

- 테스트 실패 0.
- 신규 lint warning 0. 기존 warning은 파일·개수와 함께 기록한다.
- production build artifact에는 production Worker 주소만 있고 staging Worker 주소는 없다.
- `player_snapshot`에 `activeFamily`와 `activeCheckId`가 모두 존재한다.
- schema를 엄격하게 읽는 frontend를 배포하기 전 Worker가 먼저 해당 필드를 제공한다.
- 기본 player URL은 legacy rollback을 유지하고, v2는 명시적 `protocol=2` opt-in으로만 열린다.

### 5.1 성능 preflight

번들 통과와 실제 renderer 통과를 분리해 기록한다.

1. production build에서 OBS v2 선택 artifact가 raw `450KiB`, gzip `130KiB` 이하여야 한다.
2. v2 정적 graph에 Dashboard, DisplayWidget, legacy player, Firebase, framer-motion, react-youtube와 외부 font URL이 없어야 한다.
3. 오디오 route의 초기 DOM은 상태 wrapper와 `<audio>` 1개뿐이며 장식 animation·blur·particle을 만들지 않아야 한다.
4. 10분 READY idle에서 long task 0, DOM mutation 0, 평균 main-thread CPU 1% 미만을 기록한다.
5. 30분 post-GC heap은 warm baseline 대비 `16MiB` 이내이고 socket·timer·media element가 각각 최대 1개여야 한다.
6. active/prefetch `64MiB`씩, hint churn 100회와 곡 전환 100회에서 stale fetch 0, cache 1개, retained `128MiB` 이하를 확인한다.
7. 실제 OBS CEF에서 60분 재생하며 renderer crash, audio dropout, 중복 player, 지속 working-set 증가가 0인지 기록한다.

Dashboard 장시간 검사는 별도다. 1,000곡 fixture에서 실제 history row 100 이하 또는 virtualization, 조작 p95 100ms 이하, localStorage payload 1MiB 이하, local Blob count·byte 예산 준수를 확인한다. 이 기준을 아직 구현하지 않았다면 장시간 리모컨 메모리 안정성은 `not-run`으로 둔다.

Chrome 통과만으로 OBS CEF 성능을 합격시키지 않는다. 측정마다 CPU, RAM, OBS/CEF 버전, source 크기와 codec을 함께 기록한다.

### 5.2 실제 외부 OBS CEF 재생 soak

`scripts/obs-v2-external-cef-soak.mjs`는 헤드리스 브라우저가 아니라 사용자가 연 실제 OBS Browser Source 하나를 Protocol v2 세션에 연결한다. 세션 credential이 든 URL은 stdout이나 명령행에 출력하지 않고, 권한이 제한된 임시 JSON handoff 파일로만 전달한다.

```powershell
$env:REKASONG_WORKER='https://<worker-host>'
$env:REKASONG_APP='https://<frontend-host>'
$env:REKASONG_CEF_SOAK_ASSET='C:\path\to\60-minute-fixture.m4a'
$env:REKASONG_CEF_SOAK_MIME='audio/mp4'
$env:REKASONG_CEF_SOAK_DURATION_MS='3600000'
$env:REKASONG_CEF_SOAK_PROGRESS_INTERVAL_MS='60000'
$env:REKASONG_CEF_SOAK_STATUS_FILE='C:\path\to\cef-soak-status.json'
npm run test:obs:v2:cef-soak
```

운영 순서:

1. harness가 출력한 `SETUP_FILE`의 `playerUrl`을 현재 시험용 Browser Source URL에 입력한다. URL 자체를 로그나 캡처에 남기지 않는다.
2. Properties의 `OK`를 눌러 먼저 저장한다.
3. Properties를 다시 열어 저장된 URL이 동일한지 확인한다.
4. `Refresh cache of current page`를 누르고 즉시 `OK`를 누른다. OBS 툴바의 일반 새로고침만으로 대체하지 않는다.
5. Properties 미리보기 CEF는 잠시 뒤 사라지고 본 source CEF가 새 identity로 연결될 수 있다. harness가 하나의 후보를 75초 연속 관측해 확정할 때까지 Properties를 다시 열거나 source를 조작하지 않는다.
6. `SOAK_PLAYING` 뒤 player 1개, OBS 후보 1개, `audible`, `playing`, 동일 lease target을 주기적으로 기록한다. OBS 본체와 해당 renderer의 working set/private memory도 같은 간격으로 기록한다.
7. 자연 종료 뒤 harness가 STOP, output deactivate, session end와 HTTP 410 재사용 차단까지 완료하는지 확인한다.
8. 시험 전 URL을 복원하고, 다시 저장 확인 → cache refresh → 즉시 OK 순서를 지킨다. clipboard에 URL을 남기지 않는다.

합격 기준:

- 준비 단계의 preview→본 source 전환은 lease 전에 흡수되고, 활성 재생 중 player identity 전환은 0건이다.
- 전체 재생 동안 player/OBS 후보는 정확히 1/1이고 `audible`, `playing`, 동일 target이 유지된다.
- 자연 종료 시 media duration 오차는 1초 이내, wall duration은 설정한 grace 이내다.
- OBS player disconnect, duplicate, authoritative unknown/failed lease 관측은 0건이다.
- control transport disconnect는 원칙적으로 0건이다. 발생하면 60초 안에 같은 control identity로 복구되고 route·media 명령 자동 재전송이 0건이며, 그 사이 OBS media graph가 계속 재생됐다는 별도 mixer/artifact 증거가 있어야 한다. 이 조건을 충족하지 못하면 실패다.
- renderer crash와 재생 중단이 없고, 메모리가 시간에 비례해 계속 증가하지 않는다.
- 종료 세션의 status 조회는 HTTP 410이다.

2026-07-22 첫 60분 실행 기록:

- 약 56분까지 player/OBS 후보 1/1, 같은 target, `audible`·`playing`을 유지했다.
- Rekasong CEF renderer private memory는 약 38.1MiB에서 43.5~46MiB 범위였고 반복 회수가 관측됐다.
- 약 56분에 명령이 없던 control WebSocket만 `socket_closed`로 종료돼 harness가 실패했다. OBS mixer는 이후에도 fixture 자연 종료까지 움직였으며 종료 뒤 무음으로 바뀌어 media graph 자체는 끊기거나 재시작되지 않았음을 확인했다.
- 원인에 맞춰 30초 storage-free/no-reply control keepalive와 동일 coordinator 자동 재접속을 추가했다. 수정 배포 뒤 60분 전체를 재실행하기 전까지 이 항목은 **미통과**로 유지한다.

2026-07-22 보강 배포 후 60분 재실행 기록:

- 실제 OBS 30.2.0 Browser Source 한 개로 3,600,000ms AAC fixture를 끝까지 재생했다. wall duration은 3,600,150ms로 오차 150ms였고 media duration은 계약과 정확히 일치했다.
- 전체 관측에서 player/OBS 후보는 1/1, lease는 `audible`, 상태는 `playing`, target은 동일했다. candidate transition, unsafe route, duplicate, authoritative unknown 및 player identity 교체는 모두 0건이었다.
- control transport disconnect 관측 3건과 reconnect 시도 2건이 있었지만 최대 gap은 825ms였다. 동일 identity로 복구했고 route·LOAD·PLAY·STOP 재전송과 OBS media graph 교체는 0건이었다.
- Rekasong CEF renderer의 private memory는 14.8MiB, working set은 약 33.5~33.6MiB로 유지됐고 renderer crash나 시간 비례 증가가 없었다.
- 자연 종료 뒤 strong STOP·output deactivate·session end 정리가 완료됐고 종료 session 조회는 HTTP 410이었다. 이로써 이 실행서의 실제 CEF 60분 장시간 관문은 **통과**다.
- 시험 URL은 원래 URL과 길이·SHA-256을 대조해 복원하고 cache refresh를 적용했다. clipboard와 credential-bearing 임시 파일은 제거했다.
- 이 결과는 실제 OBS CEF 재생 경로와 자원 안정성 증거다. 사용자의 물리 모니터링 청취, ingest/VOD(G5), 라이브 마이크↔MR 상대 싱크(G6)는 대체하지 않는다.

## 6. G1 — 출력 선택과 단일 lease

### 6.1 스피커

1. 출력에서 `스피커 · 이 기기에서 듣기`를 선택한다.
2. 선택한 탭의 로컬 플레이어가 즉시 준비되는지 확인한다. Worker player 후보, lease, 다른 Dashboard 탭의 제어권은 기다리지 않는다.
3. 다른 탭·창에서 Speaker를 함께 사용해도 각 탭의 현재 곡, 위치, 볼륨과 재생 상태가 서로 독립적인지 확인한다.
4. OBS 연결 실패, 후보 없음·중복, heartbeat 지연, 다른 제어 탭이 있어도 Speaker 선택과 play/pause/seek/volume/skip이 잠기지 않는지 확인한다.
5. 브라우저 autoplay가 막혔다면 현재 재생 시도만 실패로 안내하고, 사용자의 다음 명시적 재생에서 로컬 media session을 다시 준비한다. 서버 경로나 다른 탭을 복구 조건으로 요구하지 않는다.

### 6.2 OBS

1. 재생·test가 없고 strong stop이 증명된 상태에서만 OBS 전환을 시작한다.
2. 기존 speaker가 있다면 먼저 `deactivate_output`을 보내고 matching `output_deactivated` 또는 authoritative inactive snapshot을 기다린다.
3. eligible `obs-browser-source`가 정확히 하나인지 확인한다. URL role만 맞는 generic browser는 합격 대상이 아니다.
4. 새 `activate_output`과 matching `output_ready`를 확인한다.
5. 대시보드 speaker media element가 paused+detached인지 확인한다.
6. 화면에 `OBS 플레이어에서 재생합니다. 이 기기의 스피커가 무음인 것은 정상입니다.`와 최종 송출 미확인 안내가 동시에 보이는지 확인한다.

합격 기준:

- 어느 시점에도 재생 권한을 가진 player가 둘이 되지 않는다.
- current player와 destination player의 후보 수를 각각 따로 판단한다.
- ACK 유실, target disconnect, heartbeat stale, source inactive에서는 새 출력을 시작하지 않고 `unknown`으로 내린다.
- duplicate control에서는 writable owner만 명령 가능하고 mirror는 읽기 전용이다.

## 7. G2 — 동일 재생 경로의 결정적 점검 신호

1. OBS output이 `ready`, active run 없음, active test 없음임을 확인한다.
2. `start_test`에 새 `checkId`, 기준 `fixtureId`, duration을 보낸다.
3. player가 일반 곡과 같은 `PlaybackEngine → HTMLMediaElement → Blob URL` 경로로 fixture를 LOAD하는지 확인한다.
4. 실제 media `READY` 뒤 PLAY가 호출되는지 확인한다.
5. 실제 `PLAYING` 전에는 `test_started`가 절대 나오지 않는지 확인한다.
6. marker가 media time을 기준으로 순서대로 오고, 역행·중복·누락이 없는지 확인한다.
7. 자연 ENDED 또는 명시 STOP 뒤 물리 stop postcondition을 확인한다.

합격 기준:

- `test_started` 이전 실제 `playing` 증거 존재.
- marker index가 0부터 단조 증가하며 중복 0, 누락 0.
- 벽시계만으로 marker를 만들어 성공을 가장하지 않는다.
- 현재 구현에 RMS/peak 계측이 없다면 해당 값은 `unknown`이어야 하며 0 또는 임의 값으로 채우지 않는다.
- `test_complete` 이전 mediaPaused=true, sourceDetached=true, autoplayCancelled=true.
- stop 증명이 실패하면 `test_complete`가 아니라 emergency stop 후 `test_failed`.

## 8. G3 — OBS mixer 실제 입력 확인

G2를 실행하면서 사람이 OBS Audio Mixer를 직접 본다.

1. 기준 삐-삐-삐 박자와 mixer meter pulse가 같은 패턴인지 확인한다.
2. source mute를 켜고 끄며 예상한 source meter와 output meter가 구분되는지 확인한다.
3. `Control audio via OBS`를 끈 대조 시험에서는 왜 실패하는지 UI 진단이 맞는지 확인한 뒤 다시 켠다.
4. monitoring off / monitor only / monitor and output 각각의 결과를 기록한다.
5. 대시보드에서는 로컬 복제 재생이 없어 echo가 생기지 않는지 확인한다.

사용자 확인은 다음처럼 기록한다.

```text
player playing: passed/failed
player marker: passed/failed
OBS source meter pulse: passed/failed
OBS output meter pulse: passed/failed/unknown
헤드폰 모니터 청취: passed/failed/not-applicable
로컬 speaker 무음: expected/unexpected/not-applicable
```

G3 합격은 OBS mixer 입력까지만 증명한다.

## 9. G4 — OBS 녹화 artifact

1. 앱이 시작하지 않은 기존 녹화가 없음을 확인한다.
2. 현재 `checkId`에 귀속되는 10초 test recording을 시작한다.
3. fixture 전체와 시작/종료 여유 구간을 녹화한다.
4. 현재 시험이 시작한 recording만 중지한다.
5. 녹화 파일 경로, 크기, container, audio track 수, sample rate를 기록한다.
6. 기준 marker 패턴을 artifact에서 검출한다.
7. clipping, dropout, marker 간격, 시작 latency를 계산한다.

합격 기준:

- 의도한 녹화 track에 기준 패턴 존재.
- clipping sample 0.
- 활성 구간 dropout 20ms 초과 0.
- marker 누락·중복 0.
- artifact analyzer가 구현되기 전에는 사람이 들었다는 사실만으로 자동 합격시키지 않는다.

2026-07-22 실제 실행 기록:

```text
OBS: 30.2.0 / browser plugin 2.23.5
scene/source: Stream_panel_Fullscreen 2 / Rekasong
recording: C:\Users\Qumin\Videos\2026-07-22 09-57-46.mp4
duration/size: 33.283s / 5,302,320 bytes
container/tracks: MP4, H.264 video + AAC audio
audio: 48kHz stereo, mean -35.7dB, peak -21.2dB
fixture detection: 880Hz pulse 12/12, 440Hz tone 4/4
marker missing/duplicate: 0 / 0
active-region split over one AAC frame: 0
live stream: not started
result: G4 passed for this exact OBS/profile/track configuration
```

## 10. G5 — 실제 test stream output

1. 플랫폼의 test stream 또는 비공개 ingest를 사용한다.
2. stream key와 credential을 앱이나 로그에 평문 저장하지 않는다.
3. test stream의 ingest/VOD artifact를 수집한다.
4. G4와 같은 marker 패턴을 검출하고 녹화 대비 추가 offset·dropout을 계산한다.
5. ingest 성공 상태만으로 오디오 성공을 판정하지 않는다.

합격 기준:

- 플랫폼 결과물의 의도한 오디오 track/channel에 패턴 존재.
- marker 누락·중복과 활성 구간 dropout 기준 통과.
- G4 통과·G5 미실행 상태는 `OBS 녹화 확인 완료`까지만 표시한다.

## 11. G6 — 카라오케 마이크↔반주 싱크

1. MR fixture와 마이크 기준 신호를 가능한 한 분리 track으로 녹화한다.
2. 시작 count-in과 주기 marker를 함께 기록한다.
3. 10분 동안 scene 전환 없이 기준 상태를 측정한다.
4. 같은 시험을 scene hide/show, monitor mode 변경, source refresh 시나리오와 섞지 않는다. 장애 시험은 별도 run으로 분리한다.
5. 시작·중간·끝 구간의 mic↔MR 상대 offset과 marker interval을 계산한다.

합격 기준:

- 보정 후 고정 offset: ±20ms 이내.
- 10분 상대 drift: 10ms 이내.
- marker interval/offset jitter p95: 5ms 이하.
- 기준을 넘으면 앱이 임의로 OBS sync offset을 자동 변경하지 않고 측정값과 수동 조치만 제시한다.

2026-07-22 현재 장치 실행 결과:

- artifact: `C:\Users\Qumin\Videos\2026-07-22 21-55-45.mkv`
- MR track 2, FIFINE K670 마이크 track 3, marker 60/60
- jitter p95 `1.832ms` 통과
- 중앙 offset `43.25ms`, 10분 drift `15.5–17.32ms`로 실패
- OBS Browser Sync Offset `+69ms` 비교는 상대 지연을 약 `82–84ms`로 악화시켜 `0ms`로 복원
- 판정: **측정 완료·수용 실패**. established OBS route와 재생은 유지하며 같은 audio clock 장치 또는 저지연 performer-monitor 경로에서 재실행
- 상세 설계: [OBS_PERFORMER_MONITOR_DESIGN_2026-07-22.md](./OBS_PERFORMER_MONITOR_DESIGN_2026-07-22.md)

## 12. 장애 주입 매트릭스

각 행은 정상 시험과 별도 `checkId`로 실행한다.

| 장애 | 기대 결과 |
|---|---|
| OBS player source 새로고침 | 새 player instance, 자동 takeover·resume 없음 |
| player WebSocket 일시 단절 | 살아 있는 로컬 media graph 보존, Worker가 `paused` 성공을 추측하지 않음, 재연결 뒤 자동 LOAD/PLAY 없음 |
| heartbeat 30초 지연 | warning만, established graph 해제·성공 증거 승격 없음 |
| heartbeat 60초 stale | 새 activation 후보에서는 제외하되 established graph를 heartbeat만으로 파괴하지 않음 |
| `sourceActive=false` | 새 activation 후보에서는 제외, established graph는 장면 telemetry만으로 pause·detach하지 않음 |
| 같은 OBS URL source 2개 | candidate duplicate, activation 차단 |
| 두 Dashboard | writable 1개, 다른 화면 read-only |
| stale control epoch | command 거부, 자동 retry 없음 |
| stale lease/run/check event | 상태 변경 0 |
| START_TEST 중 LOAD | 상호 배제, 기존 test/run 임의 교체 없음 |
| STOP ACK 유실 | outcome unknown, 자동 재전송·resume 없음 |
| deactivation failure | 기존 target 유지, explicit deactivate 재시도만 허용 |
| fixture fetch/decode 실패 | test_failed, 강한 detach 증거 없으면 connection close |
| scene hide/show | 설정 정책과 일치; 결과가 바뀌면 인증 stale |
| OBS 재시작 | 새 pairing 필요, 이전 인증을 현재 연결 증거로 사용하지 않음 |

## 13. 리모컨·UI 인수 기준

데스크톱과 320/375/390px에서 확인한다.

- 출력 선택이 mute 토글이 아니라 `스피커`와 `OBS` 두 위치로 보인다.
- 선택 의도, lease 준비, 실제 player playing, OBS mixer, 녹화, stream, karaoke sync가 한 상태로 합쳐지지 않는다.
- OBS 모드의 로컬 무음 설명은 접힌 도움말 안에 숨지 않는다.
- 재생·일시정지·seek·volume 요청과 마지막 확인된 실제 값을 함께 볼 수 있다.
- 원격 position은 확인 전에 낙관적으로 확정하지 않는다.
- 0 player, duplicate player, unknown, read-only control, stale verification의 원인과 다음 행동이 구분된다.
- 긴급 정지는 다른 action보다 명확하지만 오조작 방지 label과 결과 확인 단계를 가진다.
- 출력 radio, 상태, 오류, test progress는 키보드와 screen reader로 접근 가능하다.
- modal은 초기 focus, focus trap, Escape, trigger focus 복귀를 지킨다.
- test 진행 중 backdrop 오클릭으로 점검 UI만 사라지지 않는다.

## 14. 번역·문구 인수 기준

- 신규 사용자 문구, button, title, aria-label, toast, confirm은 semantic key를 사용한다.
- protocol, adapter, Worker는 번역 문장 대신 안정적인 code와 구조화 detail을 반환한다.
- 한국어 fallback key가 빠지면 테스트가 실패한다.
- 지원하지 않는 locale은 공개하지 않는다.
- pseudo-locale에서 선택기, 긴 오류, 모바일 modal이 잘리거나 겹치지 않는다.
- `연결됨`, `재생 확인`, `OBS 믹서 확인`, `녹화 확인`, `송출 확인`, `싱크 확인` 용어를 서로 바꾸어 쓰지 않는다.

## 15. 배포·canary·rollback

1. local 전체 회귀를 통과한다.
2. 격리 staging Worker를 배포하고 v1/v2 mixed smoke를 수행한다.
3. 실제 OBS test profile에서 G1~G4를 통과한다.
4. schema 필드 추가 배포는 **Worker 먼저**, 새 snapshot을 read-only로 확인한 뒤 frontend를 배포한다.
5. frontend의 v2 경로는 명시적 opt-in/canary로 켜고 legacy URL rollback을 유지한다.
6. production에서는 session 생성·test tone·장애 주입을 자동 실행하지 않는다.
7. 제한 canary에서 player 한 개, control 한 개, 짧은 fixture를 확인한 뒤 범위를 넓힌다.
8. rollback 때 frontend만 먼저 되돌려도 새 Worker의 확장 필드를 legacy frontend가 무시할 수 있어야 한다.

## 16. 최종 판정 양식

```text
G0 계약 회귀: pass/fail
G1 단일 출력 lease: pass/fail
G2 동일 player graph: pass/fail
G3 OBS mixer: pass/fail/not-run
G4 OBS recording artifact: pass/fail/not-run
G5 stream artifact: pass/fail/not-run
G6 karaoke sync: pass/fail/not-run

실패 code:
측정값:
artifact 위치/해시:
스크린샷/로그:
stale 조건:
재시험 필요 단계:
최종 사용자 표시 문구:
```

실제 OBS artifact 없이 완료할 수 있는 최대 단계는 G2다. 그 상태의 올바른 결론은 `플레이어 내부 재생 경로 확인, OBS 최종 출력 미검증`이다.
