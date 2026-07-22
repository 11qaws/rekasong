# Rekasong 목표 완료 감사 — 2026-07-22

> 작업 위치: `D:\Agents\rekasong\Codex\workspace`
>
> 판정 원칙: 코드 존재가 아니라 사용자가 실제로 끝까지 수행할 수 있는지, 그리고 그 사실을 어떤 증거로 확인했는지로 판정한다.
>
> 최신 공개 앱은 v0.2.15다. 실제 OBS·로컬 녹화·OBS→Speaker 전환 물리 증거는 v0.2.13 시점의 [OBS_PHYSICAL_VALIDATION_2026-07-22.md](./OBS_PHYSICAL_VALIDATION_2026-07-22.md)에 보존한다.

## 1. 현재 결론

| 사용자 목표 | 로컬 후보 | 공개 배포 | 남은 증거 |
|---|---|---|---|
| 앱을 열면 스피커로 바로 시작 | 완료 | 현재 후보 배포됨 | 모바일 OS별 백그라운드 수동 확인 |
| Speaker를 일반 웹 플레이어처럼 사용 | 완료 | 현재 후보 배포됨 | 모바일 OS별 백그라운드 수동 확인 |
| 잠금 화면·알림·헤드셋의 Speaker 제어 | 자동 계약 완료 | 현재 후보 배포됨 | 실제 지원 모바일에서 수동 확인 |
| Speaker 탭·창 수에 앱 경로 제한이 없고 서로 막지 않음 | 완료 | 현재 후보 배포됨 | 공개 다중 탭 수동 재확인 |
| Speaker 화면에서 단일 경로·다른 탭 제어 경고 제거 | 완료 | 현재 후보 배포됨 | 설정 화면 수동 재확인 |
| Speaker 감상 볼륨과 OBS 방송 gain 분리 | 완료 | 현재 후보 배포됨 | 두 모드 값 유지 수동 smoke |
| Speaker 유휴·검색이 방송 세션/제어 연결을 만들지 않음 | production-browser 실측 완료 | v0.2.15 공개 URL 재확인 | 없음 |
| Speaker 로컬 파일이 OBS 선택 전 서버 없이 즉시 재생 | production-browser 실측 완료 | v0.2.15 공개 URL 재확인 | 실제 OBS 업로드 뒤 Speaker 복귀 청취 |
| 지원 브라우저에서 Speaker 출력 장치 선택 | 완료 | 현재 후보 배포됨 | 실제 지원 장치에서 물리 청취 확인 |
| OBS만 엄격한 단일 송출 경로 사용 | 자동 검증 + G3 기계 관측 + G4 완료 | 현재 후보 배포됨 | 사용자 청취·G5, G6 장치 경로 개선·재검증 |
| OBS 재접속 중 재생 연결을 우선 보존 | 자동 검증 + 실제 source hide/show·60분 CEF 완료 | 현재 후보 배포됨 | scene 전환·source refresh·OBS 재시작 |
| OBS 리모컨 요청과 실제 플레이어 적용을 구분 | 자동 검증 완료 | 현재 후보 배포됨 | 실제 OBS 연결 상태에서 설정 카드 확인 |
| 헤더 머리핀 UI와 유레카 금발 선 | 완료 | 현재 후보 배포·시각 검증됨 | 없음 |
| YouTube 검색/목록을 한 소스로 묶기 | 완료 | 현재 후보 배포됨 | 공개 수동 smoke |
| 노래책 행 클릭 후 명확한 검토/재생 행동 | 완료 | 현재 후보 배포됨 | 공개 수동 smoke |
| 검색·노래책 곡을 지금/다음 재생·대기열·이력에 드래그 | 완료·실제 Chrome 검증 | v0.2.15 공개 검증됨 | 모바일·키보드는 기존 클릭 경로 사용 |
| 한국어/영어 전환과 번역 가능한 출력 구조 | 완료(현재 사용자 화면 범위) | 현재 후보 배포됨 | 공개 언어 전환 smoke |
| 가벼운 앱과 OBS 정적 경로 예산 | 완료 | 현재 후보 배포·60분 CEF 통과 | 로컬 Blob 장시간 상한 |
| 1,000곡 이력이 기본 조작을 무겁게 하지 않음 | production-browser 실측 완료 | v0.2.15 공개 코드 재확인 | 없음 |

현재 공개 Pages의 앱 release 기준은 frontend `0.2.15` / `94efd537e34862ca84b30b1f6cdc2e666cc2018f`이다. Speaker 출력, 미디어 HTTP 자격, OBS 제어 연결을 분리하고 로컬 파일을 OBS 선택 전까지 page Blob으로만 재생한다. 유휴·검색·로컬 파일 Speaker 재생에서는 불필요한 Worker 연결이 없다. production On-Air는 인증된 Worker display WebSocket만 사용하며 구형 공개 ntfy relay는 휴면한다. production Worker는 version `2b819923-49bb-4002-9407-848321a6c6f7`다. 전체 테스트 `686/686`와 실제 OBS CEF 60분 재생을 통과했다. G6는 실제 10분 물리 stress와 endpoint-inclusive 5분 창을 측정했고 현재 장치 조합의 시작 offset은 실패, 5분 drift는 edge 통과·linear-fit 약 `0.4ms` 초과로 경계/재검 필요다. 사용자 청취와 G5는 별도 관문으로 남는다.

### 공개 배포 실측 — 2026-07-22

- 공개 Pages `https://11qaws.github.io/rekasong/`는 HTTP 200이며 메인 자산은 `assets/index-Cw7hwxQB.js`, Dashboard JS/CSS는 `assets/Dashboard-DP9bJW4p.js` / `assets/Dashboard-CNzH05Ka.css`다. CDN Last-Modified는 `2026-07-22 14:14:33Z`다.
- 공개 Worker의 현재 활성 배포는 version `2b819923-49bb-4002-9407-848321a6c6f7`다. 기존 CEF 60분 증거의 Worker 이후 점검음 방송 유입 차단을 추가했으며, 일반 MR media graph는 변경하지 않았다.
- 공개 Worker 루트의 HTTP 404는 장애가 아니라 루트 라우트를 제공하지 않는 현재 설계다. 세션·WebSocket·미디어 API는 `/v1/...` 아래에서만 제공한다.
- 공개 첫 화면은 Speaker 기본과 `스피커 송출 중`을 유지하고, OBS 전용 설정은 톱니 안에서 OBS를 선택한 사용자에게 점진적으로 노출한다.
- 헤더의 얇은 노란 선은 유레카의 금발을 나타내는 영구 브랜드 요소다. production 390px viewport에서 실제 노란 픽셀 212개가 x=1..367, y=80..81에 존재했고 흰색 hairpin 묶음 뒤로 이어졌다. CSS는 3px, `rgb(242, 217, 141)`, `isolation:isolate`로 확인했다.
- YouTube 단일 소스, 즉시 곡 검토 표시, 한국어/영어 전환을 포함한 현재 후보가 공개 배포됐다. 표에 남긴 모바일·다중 탭·출력 장치·언어 전환 수동 smoke는 별도 실기기 관문이다.
- 공개 v0.2.9에서 검색 결과 클릭→검토와 drag 취소·이력 drop을 반복했다. 취소는 저장 변경 0건, 이력 drop은 현재 곡·대기열·재생 0건이며, 320px에서도 세 목적지가 모두 화면 안에 있다. 이력 drop 직전과 직후의 media-session 요청 수는 2→2로 같아 drop이 별도 Worker 세션을 열지 않았다.
- 공개 v0.2.10 격리 탭에서 Speaker idle 1.5초와 검색 결과 표시까지 session HTTP 0회, control WebSocket 0개, 전송 frame 0개, Worker host 요청 0회를 확인했다. 곡 drag 검증에서도 검색은 session 0회이고 클릭 검토로 필요한 media session 1회가 생긴 뒤 이력 drop 전후 1→1로 유지됐다.
- 공개 v0.2.11 격리 탭에서 로컬 WAV를 선택·검토·즉시 재생해 media time이 0.088초 이상 증가하는 동안 session HTTP 0회, control WebSocket 0개, 전송 frame 0개, Worker host 요청 0회였다. local Speaker·PlaybackEngine 청크 2개만 수요 로드됐고 원격 prepare/cache 청크는 0개였으며 durable Blob URL도 0개였다.
- 공개 v0.2.15의 격리 Chrome에서 Speaker 기본값, 한·영 전환·reload 지속성, 320/375/768/1100px hairpin·3px 노란 선, 출력 버튼 사용 가능 상태를 통과했다. production legacy ntfy 요청은 0건이고 HTTP 4xx/5xx도 0건이었다.
- 같은 공개본에서 Speaker idle·검색·로컬 파일 실제 재생은 session HTTP 0회, WebSocket 0개, 전송 frame 0개, Worker host 요청 0회였다. drag 취소는 durable 변경 0, 이력 drop은 재생 0이며 drop 전후 media-session 요청은 1→1이었다.
- 공개 v0.2.15의 1,000곡 이력은 최대 mount 100행, cold open `41.7ms`, warm p95 `46.8ms`, 320px overflow 0, 닫은 뒤 post-GC heap 증가 0B였다.
- 공개 main/CSS/Dashboard/OnAirPlayerV2 자산의 SHA-256은 같은 commit을 GitHub Actions 조건으로 다시 빌드한 로컬 산출물과 4/4 바이트 단위로 일치했다.

## 2. Speaker 사용자 흐름

### 확정한 동작

- 새 탭의 기본 출력은 항상 Speaker다. 이전 OBS 선택을 복원해 사용자를 연결 대기 상태에 넣지 않는다.
- Speaker의 재생·일시정지·탐색·볼륨·스킵·재시도·버리기는 OBS control owner, output lease, player 후보 수, heartbeat, 재연결 상태를 보지 않는다.
- 탭마다 현재 곡과 재생 run을 따로 가진다. 대기열·이력·노래책·언어 같은 지속 데이터만 탭 사이에 공유한다.
- `localStorage`에는 현재 곡과 active run을 쓰지 않는다. 다른 탭의 storage event가 현재 곡을 만들거나 덮어쓰지 못한다.
- Worker의 과거 Speaker 후보가 여러 개 남아 있어도 exact-one gate로 Speaker를 차단하지 않는다.
- Speaker와 OBS는 서로 다른 지속 볼륨 값을 사용한다. 기존 단일 볼륨은 두 값으로 무손실 승계하고, 현재 재생 중인 run의 실제 출력 모드만 조절한다.
- `selectAudioOutput`과 `setSinkId`를 모두 지원하는 브라우저에서만 Speaker 출력 장치 선택을 보여 준다. 장치 선택·복원 실패는 playback run이나 OBS 상태를 바꾸지 않고 기존/기본 출력으로 계속 재생한다.
- 브라우저 Media Session은 현재 active run의 실제 출력이 Speaker일 때만 곡 정보와 play/pause/next/seek를 제공한다. OBS run·유휴·화면 종료에서는 metadata와 handler를 제거하며, API 오류는 현재 곡이나 연결 상태를 바꾸지 않는다.
- media session 또는 lazy player 준비가 끝나지 않으면 명령은 최대 12초만 대기하고 현재 시도를 실패로 확정한다. 다음 재생 클릭은 세션 생성을 다시 시도하며, 이 실패가 Speaker 헤더를 경로 확인 상태로 바꾸지 않는다.
- 미디어 READY 증거 안에서 PLAY를 재진입 호출하지 않는다. 다음 microtask에서 같은 run인지 다시 확인해 시작하며, 그 사이 pause·stop·교체·dispose가 있으면 예약된 시작을 취소한다.
- 설정을 Speaker 상태로 열면 언어, Speaker/OBS 선택, 현재 Speaker 안내만 먼저 보인다. OBS 연결·복구·오디오 점검은 OBS를 선택하거나 OBS 선택 실패를 확인하려고 눌렀을 때만 열린다.
- 로컬 파일은 Speaker에서 page Blob으로 즉시 재생하고 OBS를 명시적으로 고른 뒤에만 방송 자산을 준비한다. 업로드 실패는 자동 반복하지 않으며 검토 화면의 `OBS 파일 다시 준비` 또는 대기열 곡 재선택으로만 재시도한다. 준비 성공 뒤에도 Speaker Blob을 보존한다.

### 실제 브라우저 증거

- 로컬 Chrome 첫 탭에서 `Best Friend`, 둘째 탭에서 `IDOL`을 각각 즉시 재생했다.
- 최종 현재 재생 표시는 첫 탭 `Best Friend 0:00 / 5:25`, 둘째 탭 `IDOL 0:00 / 3:34`로 동시에 유지됐다.
- 둘째 탭을 연 순간 현재 곡은 비어 있었고 첫 탭의 재생 상태를 가져오지 않았다.
- 곡 행 클릭 뒤 `곡 정보 확인`과 `즉시 재생` 행동이 실제로 나타났다.
- 실제 492×995 좁은 브라우저에서 영문 Speaker 설정 대화상자는 좌우 16px 여백 안에 들어왔고, 페이지·대화상자 모두 가로 overflow가 없었다. `Playing through speakers` 외에 경로 확인/서버 대기 경고도 나타나지 않았다.
- 실제 두 Dashboard 탭 상태에서 둘째 탭이 OBS를 선택하려 해도 Speaker radio는 `disabled=false`, `aria-disabled=false`를 유지했다. 첫 탭 종료 뒤 OBS 재선택은 `OBS 플레이어 없음`과 구체적인 다음 행동으로 수렴했다.
- 위 OBS 실패 상태에서 Speaker를 다시 누르자 추가 초기화나 서버 경로 증명 없이 즉시 `checked=true`, local player `data-local-speaker-state=ready`로 복귀했다. OBS 실패가 Speaker 선택·재생기를 잠그지 않았다.
- 390×844 viewport에서 흰 머리핀 헤더, YouTube→Setlink→Meloming 순서, YouTube 내부 Search/Playlist, 곡 클릭 직후 Review track/Play now 전환을 확인했다. 설정은 가로 overflow 없이 세로 스크롤만 사용했다.
- `Best Friend`를 새로 재생해 실제 `<audio>`가 `readyState=4`, `paused=false`이고 재생 시간이 증가함을 확인했다. 이는 이전의 영구 `준비 중` 교착이 실제 브라우저에서도 해소됐다는 증거다.
- Speaker 볼륨을 34%로 변경하고 곡을 버린 뒤 새로고침해 다시 재생했다. `Speaker volume` 슬라이더는 34%로 복원됐고 활성 상태였으며, 곡은 계속 진행됐다. 최종 버리기 뒤에는 media가 paused이고 source가 분리됐다.
- 현재 로컬 브라우저는 `setSinkId` 미지원이었다. 장치 선택 UI와 기술 경고는 노출되지 않았고 가로 overflow도 없었다. 같은 상태에서 `Best Friend`는 `readyState=4`, `paused=false`, 13.49초까지 진행됐으며 버리기 뒤 pause와 source 분리를 확인했다. 지원 환경의 실제 물리 장치 전환 청취는 별도 수동 증거로 남긴다.
- OBS 리모컨 적용 확인 후보를 포함한 최신 화면에서도 Speaker의 `Best Friend`가 `readyState=4`, `paused=false`로 진행됐고 헤더·Speaker 설정의 OBS 확인 카드는 0개였다. 버리기 뒤에는 media가 `paused=true`였으며 페이지 가로 overflow도 없었다.
- 공개 v0.2.11에서 48kHz 로컬 WAV를 실제 Speaker `<audio>`로 재생했고, 브라우저 media time 증가와 Worker 요청 0회를 함께 관측했다. 격리된 로컬 production-browser에서는 OBS 업로드를 첫 시도 503으로 실패시킨 뒤 번역된 재시도 버튼을 눌러 두 번째 시도만 성공시켰고, Speaker로 돌아와 보존된 같은 Blob을 실제로 다시 재생했다.

### 의도적으로 남긴 경계

- YouTube 음원 준비와 임시 자산 접근에는 방송과 같은 media session 서비스를 사용할 수 있다. 이것은 Speaker 출력 소유권이 아니다.
- 여러 Speaker 탭에서 각각 소리를 내는 것은 허용된 정상 동작이다. 사용자가 각 탭에서 직접 멈춘다.
- 준비 음원 인증은 한 Speaker만 차지하는 소유권이나 소비형 토큰이 아니다. 앱은 탭·창 수를 세거나 대표 Speaker 하나를 고르지 않는다.
- 모바일 OS가 백그라운드 탭 자체를 정지시키는 정책까지 앱이 우회한다고 약속하지 않는다. 앱 내부의 다른 탭 증거 부족은 Speaker를 차단하지 않는다.
- Media Session은 OS 조작 표면을 제공할 뿐 백그라운드 재생 지속을 보장하지 않는다. 실제 잠금 화면·알림·헤드셋 버튼은 지원 모바일에서 별도 수동 확인한다.

## 3. OBS 사용자 흐름

### 자동으로 확정한 동작

- OBS만 정확한 단일 active Browser Source와 단일 output lease를 요구한다.
- 새 OBS 활성화는 중복 후보·소스 비활성·알 수 없는 제어권을 성공으로 추측하지 않는다.
- 이미 성립한 OBS media graph는 장면의 visible/active 변화, heartbeat 지연, 일시적인 control WebSocket 단절만으로 멈추거나 detach하지 않는다.
- 같은 OBS player identity가 재접속하면 10초 heartbeat를 기다리지 않고 hello에서 route를 복원한다.
- 살아 있는 playback은 재접속 후 현재 상태를 다시 보고하지만, 이 보고 결과가 불명확하다는 이유로 재생을 끊지 않는다.
- 일반 control socket 단절은 새 welcome과 authoritative snapshot이 일치하면 명령 재전송 없이 해제한다. 진행 중 명령 결과 불명과 identity 불일치는 계속 수동 복구 대상으로 남긴다.
- source active/visible 콜백은 한 번의 storage-free 즉시 heartbeat로 합쳐 전송하고, runtime 값이 바뀔 때만 Dashboard snapshot을 갱신한다. 장면 상태는 빠르게 보이되 established graph를 멈추지 않는다.
- 실제 OBS 플레이어 heartbeat는 10초다. 최신 Dashboard Speaker는 Worker player WebSocket과 heartbeat가 없으며, 구버전 호환 Speaker만 30초 cadence를 사용한다. Worker의 정상 heartbeat 처리는 durable storage write 없이 ACK·relay만 수행한다.
- Dashboard는 마지막으로 사용자가 누른 OBS play/pause/seek/volume의 정확한 `commandId`와 run을 탭 메모리에만 보관한다. Worker는 기존 `command_applied`/`command_failed` snapshot에 그 명령 식별자를 보존하고, Dashboard는 실제 media 상태 또는 적용된 seek/volume 값까지 일치할 때만 `적용됨`으로 표시한다. 수신 ACK·desired 값은 성공 증거가 아니며, 5초 지연도 재생 중단·명령 재전송·추가 WebSocket traffic을 만들지 않는다.
- G2 신호가 실제 재생된 뒤 사용자가 정확한 OBS Audio Mixer meter의 pulse를 확인하거나 실패로 기록할 수 있다. 이 기록은 현재 room·player·check에만 묶이고 Worker 명령이나 route 전이를 만들지 않으며, 실제 G3 관측 자체를 대신하지 않는다.
- 실제 Chrome normal-playback continuity smoke에서 30초 세션 WAV를 Blob으로 완전히 준비한 뒤 재생 중 player WebSocket을 명시적으로 close했다. Worker가 `target_disconnected`를 관측한 동안에도 같은 media element/blob이 약 0.358초에서 2.436초로 진행했고, 같은 player/entry/run이 `output_reconnected`로 복원됐다. PLAY/PLAYING은 각 1회이며 재접속 pause·detach·waiting·stalled·error는 0이었다.
- 10분 continuity soak에서는 600초/57,600,044바이트 WAV를 완전히 준비해 590초를 연속 관측했다. media 경과 590,065.3ms와 wall 경과 590,063.1ms의 차이는 2.2ms였고, 명령 재전송과 재생 중단 이벤트는 0이었다. 이는 브라우저의 반주 시간축 연속성을 증명하지만 실제 OBS mixer에서 마이크와 반주의 상대 싱크를 재는 G6 증거는 아니다.

### 실제 장비에서 확정한 상한과 남은 동작

- G3 기계 관측: 앱 점검 신호 동안 정확한 `Rekasong` OBS Audio Mixer source meter가 약 -25dB까지 움직였다.
- G4 녹화 artifact: 33.283초 MP4의 AAC 48kHz stereo track에서 880Hz pulse 12개와 440Hz tone 4개를 모두 검출했다. marker 누락·중복 및 clipping은 0이었다.
- source hide/show: fixture 재생 중 약 1.4초 숨겼다가 다시 표시해도 established route를 유지하고 16/16 marker로 완료했다.
- G6 물리 측정: track 2 MR·track 3 FIFINE 마이크로 60/60 marker를 기록했고 jitter p95 `1.832ms`는 통과했다. offset은 `43.25ms`, 10분 stress drift는 `15.5–17.32ms/590초`였다. endpoint-inclusive 31-marker/300초 재분석은 edge 최악 `9.753ms` 통과, linear-fit 최악 `10.408ms` 경계 초과였다. 30초 변화 p95는 `2.486ms`였으며 관찰만 하고 재생을 보정하지 않는다. 재생 중 route 교체·restart·seek·강제 정지는 없었다.
- `+69ms` OBS Browser Sync Offset 비교는 상대 지연을 약 `82–84ms`로 악화시켜 `0ms`로 되돌렸다. 서로 다른 하드웨어 clock의 drift 보정으로 사용하지 않는다.
- 각 곡은 새 run과 `position: 0`으로 기준점을 다시 잡되 OBS route와 lease는 유지한다. 정확한 이전 run stop proof 뒤에만 다음 media run을 load/play하며, 곡 중간에는 자동 seek·restart·속도 보정을 하지 않는다.
- 남은 항목은 사용자가 직접 들은 monitoring 결과, 비공개 방송/VOD(G5), 같은 audio clock 또는 저지연 performer monitoring 경로의 5분 곡 단위 G6 재검증, scene 전환·source refresh·OBS 재시작 변형이다.

세부 증거와 남은 절차는 `docs/OBS_REMAINING_VALIDATION_PLAN_2026-07-20.md`에 유지한다.

## 4. UI와 편의성

- 헤더의 흰 머리핀 영역에는 현재 출력 상태와 설정 버튼만 둔다.
- 넓은 노란 배경 띠와 큰 설명 패널은 제거했다. 유레카의 금발을 상징하는 얇은 3px 노란 선은 상태·연결과 무관한 영구 브랜드 요소로 항상 유지한다.
- 출력 변경, OBS URL, 연결 상태, 복구, 오디오 점검, 방송 세션 종료는 톱니 안에 둔다.
- UI는 상태 이름만 제시하지 않고 `다음 행동`을 함께 말한다.
- YouTube는 상단에서 하나의 소스이며 내부에 검색/플레이리스트가 있다. 상단 순서는 YouTube → Setlink → 멜로밍이다.
- 노래책 본문은 읽기 쉬운 진한 녹색을 사용하고 emerald는 연결 상태·장식에 남긴다.
- 곡 행은 클릭 가능한 버튼이며 바쁜 상태를 즉시 보여 준 뒤 검토 화면으로 이동한다.
- 데스크톱에서는 재생 가능한 검색·노래책 곡을 끌 때만 `지금/다음 재생`, `대기열 끝`, `이전 재생곡` 목적지를 보여 준다. 현재 곡이 있으면 자르지 않고 다음 순서로 넣으며, 취소는 아무 상태도 바꾸지 않는다. 모바일·키보드는 같은 결과를 만드는 기존 클릭→검토 버튼을 유지한다.

## 5. 번역 구조

- 앱 locale은 `ko`/`en`만 정식 노출한다. 선택은 `rekasong.locale`에 저장하고 `<html lang>`과 함께 바뀐다.
- 출력/OBS, 검색, 노래책, 스테이징, 대기열, 재생 오류, AI 진행, 오류 경계의 앱 작성 문구는 semantic key로 관리한다.
- AI 분석 상태는 한국어 문장을 정규식으로 읽지 않는다. locale-neutral 단계 값과 message key를 저장하므로 언어를 바꾸면 현재 상태도 다시 번역된다.
- Display Widget은 큰 대시보드 catalog를 가져오지 않는 작은 전용 catalog를 쓴다. 복사하는 Widget URL에 `lang`을 포함한다.
- 곡명·가수명·태그·사용자 입력·외부 고유명사는 번역 대상이 아니다.
- 서버 원문 오류를 그대로 사용자 문구로 쓰지 않고 앱의 안정적인 오류 key로 바꾼다.

## 6. 성능과 자동 검증

- 닫힌 이전 재생 곡은 DOM 행 0개, 최초 개방은 최근 100개다. `이전 100곡`·`다음 100곡`·`최근 100곡`으로 이동해도 한 번에 한 페이지만 만들어 1,000곡 전체를 탐색하는 동안 실제 이력 행은 항상 100개 이하다. 닫으면 최신 페이지와 0행으로 초기화한다.
- production build를 격리 Chromium에서 실행한 1,000곡 실측은 저장 payload `290,235B`, 최초 개방 `31.9~259.4ms`, warm 조작 p95 `30.6~42.8ms`, 320px 가로 overflow 0, 닫은 뒤 GC heap 증가 약 `0.2MiB`였다. 각각 1MiB, 300ms, 100ms, 16MiB 예산 안이다. 개발 서버의 module transform 비용은 제품 UI 성능으로 세지 않는다.
- v0.2.9 배포 뒤 공개 URL을 같은 harness로 다시 측정한 결과는 최대 100행, cold open `28.4ms`, warm p95 `40.5ms`, 320px 문서 폭 `320px`, post-GC heap 증가 `257,576B`였다. 10개 페이지 전체 왕복과 최신 복귀, 5회 재개폐를 포함한다.
- v0.2.10 공개 URL의 동일 harness 결과는 최대 100행, cold open `109.1ms`, warm p95 `63.0ms`, 320px 문서 폭 `320px`, post-GC heap 증가 `0B`였다. Speaker 연결 분리 뒤 공개 Dashboard는 DOM 124개, warm DCL `25.9ms`, warm long task 0건이다.
- v0.2.11 공개 URL의 동일 harness 결과는 최대 100행, cold open `199.9ms`, warm p95 `38.3ms`, 320px 문서 폭 `320px`, post-GC heap 증가 `0B`였다. 공개 Dashboard는 DOM 124개, 초기 script 6개, decoded resource `997,845B`, warm DCL `24.0ms`다.
- 반복 가능한 공개 Dashboard 스모크가 새 격리 Chrome에서 Speaker 기본값과 두 출력 버튼의 활성 상태, YouTube 단일 상위 소스, 한·영 전환·새로고침 지속성, 320/375/768/1100px의 머리핀·금발 선·가로 overflow를 검사한다.
- v0.2.9 공개 캐시 우회 실측은 DCL `681.7ms`, 초기 자원 `281,590B` 전송 / `994,170B` decode, 69ms long task 1개였다. 캐시 재방문은 DCL `19.8ms`, long task 0개였다.
- 전체 조작 뒤 JS heap은 약 9.6MiB였다. 회귀 상한은 DOM 2,000개, decoded resource 6MiB, JS heap 64MiB로 두어 네트워크 속도 변동과 제품 비대화를 구분한다.
- 사용되지 않던 `LivePanel.jsx`와 import 0개인 `firebase` 직접 의존성을 제거했다. 설치 트리는 84개 패키지가 줄었고 실제 Dashboard/OBS runtime bundle은 변하지 않았다.
- 최신 공개 코드 전체 테스트: 686/686 통과.
- lint: 변경 코드 오류 0. 기존 `functions/api/gemini.js`의 `no-useless-escape` 경고 2개만 유지.
- production build 통과.
- Dashboard chunk: 365.15 kB raw / 100.07 kB gzip.
- Dashboard CSS: 61.55 kB raw / 11.63 kB gzip.
- 탭별 local Speaker controller lazy chunk: 7.25 kB raw / 2.51 kB gzip. 공용 playback engine은 24.87 kB raw / 6.56 kB gzip이며 둘 다 Speaker 유휴 첫 화면에는 로드하지 않는다.
- Display Widget chunk: 6.11 kB raw / 2.33 kB gzip.
- OBS 정적 경로: 383,818B raw / 117,569B gzip / 103,056B brotli.
- OBS 예산: 460,800B raw / 133,120B gzip 이내 통과.
- Worker 문법 검사와 `git diff --check` 통과.

## 7. 배포 완료와 다음 관문

1. Worker `2b819923-49bb-4002-9407-848321a6c6f7`와 frontend `0.2.15` / `94efd537e34862ca84b30b1f6cdc2e666cc2018f` 배포를 완료했다. 앱 배포 workflow `29927571438`은 성공했다.
2. GitHub Pages clean install·686개 테스트·build·OBS budget·publish, production 자산 hash, ntfy 요청 0·HTTP 오류 0, 모바일 viewport의 hairpin·유레카 금발 선을 확인했다.
3. 실제 OBS G3, G4, source hide/show, CEF 60분 재생을 통과했다.
4. 공개 단일 탭의 Speaker 기본값·출력 버튼·언어 전환과 곡 클릭·drag 취소·이력 배치 smoke는 자동화했다. 다음 수동 관문은 모바일 Speaker 백그라운드 조작, 공개 다중 탭과 실제 출력 장치 전환이다.
5. 최종 송출 관문은 사용자의 실제 청취, 명시적 승인 뒤의 비공개 방송/VOD G5, 같은 clock monitoring 경로에서의 endpoint-inclusive 5분 한 곡+짧은 반복 G6 재검증이다. 10분 run은 stress 진단으로만 남고, 현재 장치는 시작 offset 실패·5분 drift 경계/재검 필요다.
6. `graphify-out/`은 제품 커밋과 배포에 포함하지 않는다.
