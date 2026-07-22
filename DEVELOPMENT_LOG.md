# Rekasong 개발 로그 (DEVELOPMENT_LOG)

## 2026-07-23 (Codex) — v0.2.16 실제 OBS 5분 격리 검증과 시험 업로드 안전화

- 외부 CEF smoke가 이전 작업 기록의 staging 주소(`rekasong-session.11qaws-test.workers.dev`)를 따라가며 제어 협상에 실패한 것을 확인했다. 현재 production frontend 설정과 Wrangler 배포 대상은 `rekasong-session.11qaws.workers.dev`다. 로컬 Worker+앱 v2 smoke와 production Worker+공개 Pages v2 smoke를 각각 통과시켜 앱 결함과 잘못된 시험 endpoint를 분리했다.
- 현재 Worker를 production에 다시 배포했고 활성 version은 `71c233ad-5e37-4655-8f62-b3ff306e7708`이다. v0.2.16 release commit `b4e94a066b12d8f80174f6cdc2e6638877afbd9d`의 Pages workflow `29935855849`는 clean install, 전체 테스트, lint, Worker 문법, production build, OBS bundle budget과 publish를 모두 통과했다. Worker 루트 404는 기존 설계이며 `/v1/...` 세션·WebSocket·미디어 계약으로 실제 smoke를 판정했다.
- 실제 OBS 외부 CEF harness는 먼저 동일한 Browser Source 후보 한 개가 75초 동안 안정적으로 유지되는지 확인한 뒤에만 큰 fixture를 R2에 올리도록 순서를 바꿨다. 오타·만료 URL을 고치는 동안 29MiB 시험 파일을 반복 업로드하지 않으며 `uploading_asset`/`asset_uploaded` 상태를 남긴다. 재생·route·제품 앱 코드는 바꾸지 않았다.
- 전용 OBS test profile/scene에서 방송은 끝까지 끄고 로컬 녹화만 시작했다. 29,040,044바이트/302.5초 fixture는 wall `302,594ms`(오차 `94ms`)로 자연 종료했고, candidate 전이 `0`, 재생 중 control disconnect/reconnect `0`, unsafe route 관측 `0`, 동일 leased player identity와 종료 뒤 410 fence를 통과했다.
- 녹화 `C:\Users\Qumin\Videos\2026-07-23 00-30-11.mkv`는 `150,015,715바이트`, SHA-256 `4E396C3C22705BC7426A6FD97927757755378AB21F1972F5F1C8A2849D0C0E78`이다. Browser direct track과 VB-Audio Virtual Cable loopback track에서 marker 31/31, 300초 endpoint 전체를 검출했다. edge drift `0.965ms`, linear-fit drift `0.352ms`, jitter p95 `2.015ms`는 통과했고 중앙 고정 offset `85.797ms`는 실패했다.
- 30초 관측 변화는 중앙 `0.830ms`, p95 `3.224ms`, 최악 `3.537ms`였다. 측정 흔들림이 5분 누적 linear drift보다 크므로 30초 cadence는 관찰·기록만 하며 곡 중 seek·restart·playback-rate 변경을 하지 않는다. route/lease는 유지하고 다음 곡을 새 run과 0초 기준으로 시작한다.
- 가상 케이블 결과는 플레이어가 한 곡 동안 상대 drift를 누적하지 않는다는 경로 격리 증거다. `85.797ms` 고정 offset은 그 loopback의 장치·monitoring 지연이며 실제 가수 마이크/헤드폰 합격을 뜻하지 않는다. 물리 performer 경로는 같은 clock 또는 저지연 monitoring 구성에서 별도 재검증한다.
- 시험 뒤 OBS Browser URL SHA-256은 원본 `e654020bc4e70f0faf7bc5f5e5bf8672891ad461126030ecd254093873e07a2d`와 일치했고, Browser monitoring/type·mixers·sync offset, FIFINE 입력 device, Windows monitoring device를 원래 값으로 복원했다. OBS 최종 화면은 `Start Streaming`·`Start Recording`, 두 타이머 `00:00:00`이었다. 실제 방송은 시작하지 않았다.
- 공개 앱을 다시 점검해 기본 Speaker, YouTube 단일 상위 소스+검색/플레이리스트, Setlink→멜로밍, 부제목 부재, 한·영 즉시 전환을 확인했다. Speaker 유휴·검색·로컬 WAV 실제 재생은 session HTTP/WebSocket/frame/Worker 요청이 모두 `0`이었고, 곡 클릭→검토·drag 취소·이력 drop·320px 목적지 배치도 통과했다.
- 배포 직후 공개 v0.2.16을 다시 읽어 HTTP 200과 CDN Last-Modified `2026-07-22 15:58:46Z`를 확인했다. 공개 Dashboard smoke는 기본 Speaker, 한·영+reload, 320/375/768/1100px, 3px 금발 선, 출력 버튼, ntfy 요청 `0`, HTTP 오류 `0`을 통과했다. warm DCL은 `27.2ms`, long task `0`, JS heap 사용량은 약 `7.9MiB`였다.

## 2026-07-22 (Codex) — 재현 가능한 5분 G6 fixture와 30초 관측 계약

- `scripts/obs-karaoke-sync-fixture.mjs`를 제품 번들과 분리된 오프라인 도구로 추가했다. 앱의 안전한 10초 점검음 상한은 그대로 유지하면서, 48kHz mono PCM WAV에 10초 주기 440/880Hz marker를 endpoint-inclusive `31개/0..300초`로 기록한다.
- 파일에는 첫 marker 상관 분석을 위한 1초 lead-in과 마지막 marker 분석 여백을 포함한다. 기본 5분 제품 fixture는 `302.5초/29,040,044바이트`, 선택적인 10분 stress는 61 marker로 제한되며 둘 다 외부 CEF harness의 64MiB active-media 한도 안이다.
- 30초 cadence는 fixture metadata에서도 `observe_only_no_seek_restart_or_rate_change`로 고정했다. 측정값은 route·media graph를 바꾸지 않으며 다음 곡만 새 run과 0초 기준으로 시작한다. 실제 OBS 방송 시작·종료 권한은 추가하지 않았다.
- Node 회귀 테스트는 endpoint 수, 30초 관측 pair, WAV header, digital silence, deterministic bytes, cycle 상한을 검증한다. 생성 CLI는 artifact SHA-256·크기·marker 수를 JSON으로 출력해 로컬 녹화와 분석 결과를 재현할 수 있게 한다.
- 실제 생성 artifact `D:\Agents\rekasong\Codex\artifacts\rekasong-obs-karaoke-5m-v1.wav`의 SHA-256은 `2DE113DE43A45940C92220740647B0E8FC0BCE0B548744D6A7D360EEF9955708`이다. 동일 파일을 direct MR 두 track과 의도적인 `+12ms` mic track으로 임시 mux한 뒤 기존 분석기를 실행해 31/31 marker, 중앙 offset `12.001ms`, 300초 linear drift `0.003ms`, 30초 변화 최악 `0.007ms`를 복원했다. 임시 MKV는 분석 직후 삭제했으며 OBS와 방송 상태는 변경하지 않았다.
- 검증: 전체 `689/689` 테스트, lint 신규 오류 0(기존 Gemini escape 경고 2건), Python/Node 문법, production build를 통과했다. OBS 정적 closure는 raw `383,782B`, gzip `117,554B`, brotli `102,987B`로 기존 예산 안이며 오프라인 fixture 모듈은 production bundle에 포함되지 않았다.

## 2026-07-22 (Codex) — v0.2.15 공개 위젯 중복 릴레이 제거와 곡 단위 싱크 기준

- production On-Air 구성은 시청자 화면 상태를 이미 인증된 session Worker의 `display_state` WebSocket으로 보낸다. 그런데 Dashboard가 일반 Speaker 상태 변화에도 구형 공개 `ntfy.sh` room/key relay를 함께 만들고 있어 중복 HTTP와 429 오류 표면이 남아 있었다. On-Air가 구성된 production에서는 room·서명 키 생성과 ntfy publish를 완전히 휴면시키고, On-Air가 없는 직접 모드에서만 구버전 위젯 호환 relay를 유지한다.
- 공개·로컬 drag smoke는 HTTP 4xx/5xx URL을 함께 기록한다. 직접 모드 개발 스모크만 외부 ntfy를 204 fixture로 격리하고, 공개 배포 검증은 가로채지 않아 production에서 ntfy 요청이 실제로 0건인지 판정한다. Speaker 유휴·검색·로컬 파일 재생은 기존처럼 session HTTP 0회, WebSocket 0개, 전송 frame 0개다.
- 노래 방송의 운영 싱크 단위를 무한한 단일 시간축이 아니라 한 곡으로 확정했다. OBS route와 player lease는 곡 사이에도 유지하고, 각 곡은 새 `runId`와 `position: 0`으로 시작한다. 기존 곡의 exact strong-stop proof 뒤에만 다음 LOAD→PLAY를 진행하며, 곡 중간에는 analyzer나 telemetry를 이유로 자동 seek·restart·playback-rate 보정을 하지 않는다.
- 최대 곡 길이 5분의 시작 offset·relative drift를 제품 관문으로 사용하고, 기존 10분 fixture는 장치 drift 속도와 장시간 연속성을 보는 stress 진단으로 낮췄다. 10분 결과는 route나 재생을 차단하지 않는다. 모든 새 안내는 한국어·영어 semantic key로 함께 추가했다.
- 기존 60-cycle 물리 녹화를 재현 가능한 `scripts/analyze-obs-karaoke-window.py`로 16kHz·8kHz 교차 분석했다. 10초 주기의 5분 창은 30개가 아니라 시작과 끝을 포함한 31개 marker가 필요하다는 off-by-one을 바로잡아 0~300초를 직접 관측했다. rolling edge drift 최악은 `9.753ms`(`8kHz 9.825ms`)로 통과했지만 linear-fit 최악은 `10.408ms`(`8kHz 10.428ms`)로 약 `0.4ms` 초과했고, fixed offset `43.262ms`도 실패해 G6를 경계·재검 필요로 유지한다.
- 같은 분석에서 30초 상대 변화는 중앙 `1.047ms`, p95 `2.486ms`, 최악 `3.471ms`였다. 30초 cadence는 관찰·기록에만 쓰고 곡 중 seek·restart·playback-rate 보정을 하지 않는다. OBS route와 lease는 계속 유지하며 보정 기준점은 다음 곡 시작에서 새 run으로 만든다.
- 분석기·문서 commit `a40320e413e6e16444a4a3e21f03d47f908fbe92`는 Pages workflow `29929542974`에서 686 tests, lint, Worker 문법, production build, OBS bundle 검사를 모두 통과해 배포됐다. 공개 entry/CSS/Dashboard/OnAirPlayerV2 자산 이름과 SHA-256은 기존 v0.2.15와 동일해 플레이어 런타임 바이트가 변하지 않았음을 확인했다.
- 검증: 전체 686/686 테스트, lint 신규 오류 0(기존 Gemini escape 경고 2건), Worker·브라우저 스크립트 문법, production build, OBS 정적 closure 예산(raw `383,818B` / gzip `117,569B` / brotli `103,056B`)을 통과했다. Dashboard JS는 `365.15kB` raw / `100.07kB` gzip이다. 로컬 drag는 HTTP 오류 0·Worker 요청 0, Speaker 유휴/검색/로컬 재생은 session HTTP 0·WebSocket 0·frame 0을 유지했다. 1,000곡 이력은 최대 100행, cold `273.3ms`, warm p95 `37ms`, 320px overflow 0, post-GC heap 증가 0B였다.
- frontend commit `94efd537e34862ca84b30b1f6cdc2e666cc2018f`는 Pages workflow `29927571438`로 배포됐다. 공개 v0.2.15는 ntfy 요청 0건·HTTP 오류 0건, Speaker idle/검색/로컬 재생의 Worker host 요청 0건을 확인했다. 공개 1,000곡은 cold `41.7ms`, warm p95 `46.8ms`, post-GC 증가 0B였고 CI 조건으로 다시 빌드한 main/CSS/Dashboard/OnAirPlayerV2 자산 SHA-256이 공개 파일과 4/4 일치했다.

## 2026-07-22 (Codex) — v0.2.13 OBS → Speaker 원자적 재생권 이관과 방송 시작 금지

- 공개 v0.2.12의 실제 OBS 재검증에서 1차 forwarded-ref 문제는 사라졌지만 두 번째 순서 경쟁을 확인했다. 사용자가 OBS 재생 중 Speaker를 누르면 UI는 `스피커 송출 중`으로 바뀌고 OBS 신호도 멈췄으나, OBS STOP/ENDED 증거가 Speaker run을 만드는 `setTimeout(0)`보다 먼저 도착해 현재 곡을 `natural` 완료로 이력에 넣고 source를 회수했다. 그 결과 Speaker `<audio>`가 재생할 곡을 잃었다.
- v0.2.13은 같은 곡의 새 Speaker run을 먼저 만들고 `currentEntry`·queue·history는 그대로 둔 채 active 재생권만 한 번에 교체한다. React paint 전에도 `stateRef`와 `activeRef`를 새 run으로 동기화해 즉시 도착한 이전 OBS STOP/ENDED/error/snapshot이 곡을 완료·실패·복원 처리하지 못하게 한다. 그 뒤의 OBS STOP은 실패해도 Speaker 시작을 막지 않는 best-effort 정리다.
- Speaker LOAD는 타이머 한 번에 맡기지 않는다. 새 active marker가 React에 실제 commit된 뒤 작은 bounded queue에서 일치하는 LOAD를 claim하고, claim 전에 제거해 StrictMode·재렌더에서도 정확히 한 번만 보낸다. commit되지 않은 시도는 최대 8개로 제한하고, 하나가 commit되면 나머지 stale Blob command 참조를 즉시 회수한다.
- 원격 session 종료도 로컬 Speaker run을 멈추거나 현재 시간을 0으로 되돌리지 않는다. 단 사용자가 명시적으로 `방송 종료`를 실행한 `explicit` 종료는 기존처럼 목록과 Blob을 정리한다. legacy snapshot에서 복원한 run에도 `outputMode: 'obs'`를 붙여 이후 Speaker 이관과 늦은 이벤트 차단이 같은 규칙을 사용한다.
- 방송 안전 경계를 별도 회귀 계약으로 고정했다. 앱/Worker 명령 allowlist에는 OBS 방송·녹화 시작/종료 명령이 없고, OBS runtime의 streaming/recording 상태는 관측만 한다. 실제 시험 자동화는 새로 확인한 `streaming=false`와 전용 test profile·scene이 없으면 PCM을 재생하지 않으며, 사용자가 허용한 로컬 녹화만 시작·종료할 수 있다. `Start Streaming`과 방송용 profile·scene·Browser Source URL 조작은 금지한다.
- 이번 작업 중 실제 OBS 방송은 시작되지 않았다. OBS UI가 `Start Streaming`·`Start Recording`, 방송 타이머 `00:00:00`인 것을 다시 확인했고, 시험용 Browser Source URL은 원래 224자 URL로 정확히 복원해 설정 파일에서 일치 여부와 임시 URL 부재를 확인했다. 이후 임시 headless 시험 브라우저도 종료했으며, 안전 경계 합의 뒤 실제 OBS 재생은 추가 실행하지 않았다.
- 검증: 자동 테스트 674/674, lint 신규 경고 0(기존 `functions/api/gemini.js` escape 경고 2건만 유지), 모든 Functions/Worker 문법, production build, OBS 정적 closure 예산(raw 382,809B / gzip 117,317B / brotli 102,792B)을 통과했다. 로컬 Speaker 실재생은 session HTTP 0회/WebSocket 0개/frame 0개, local playback chunk 2개/remote chunk 0개를 유지했고 로컬 파일 복구·drag도 통과했다. 1,000곡은 cold 223.8ms, warm p95 32.7ms, post-GC heap 증가 0B, 320px overflow 0이었다.
- 로컬 production Dashboard는 124 DOM node, decoded resource 1,000,733B, warm DCL 23.3–25.0ms, warm long task 0건이었다. cold 73–79ms long task 1건은 공개 v0.2.12에서도 80ms로 동일하게 재현돼 이번 변경의 신규 회귀가 아니며, Dashboard chunk는 362.83kB raw / 99.57kB gzip이다. 한국어·영어 320/375/768/1100px, 320px 설정창, 기본 Speaker, 유레카의 3px 노란 머리선도 모두 통과했다.

## 2026-07-22 (Codex) — v0.2.12 재생 중 OBS → Speaker 전환 복구

- 공개 v0.2.11과 실제 OBS 30.2.0 `Rekasong` Browser Source로 48kHz mono 880Hz 펄스 WAV를 재생했다. OBS 믹서의 `Rekasong` 레벨이 실제로 움직였고, 로컬 녹화 `C:\Users\Qumin\Videos\2026-07-22 18-40-45.mp4`는 223.933초 H.264 + AAC 48kHz stereo, 34,830,505바이트였다. 첫 실행은 18개 펄스를 모두 기록했고 두 번째 실행은 Speaker 전환 시점까지 10개를 기록한 뒤 OBS 신호가 멈췄으며, 전체 peak는 -19.1dB로 clipping이 없었다. 라이브 송출은 시작하지 않았다.
- 이 물리 시험에서 OBS 출력은 정상 정지했지만 Dashboard가 `Playing through speakers`로 바뀐 직후 실제 Speaker `<audio>`에는 source가 붙지 않고 `The speaker player is getting ready` 실패로 끝나는 race를 재현했다. 원인은 lazy/remount 구간에 forwarded ref와 React의 `ready`/`initializing` 라벨이 서로 다른 commit을 가리킬 수 있는데, 기존 dispatch가 라벨을 먼저 믿고 즉시 실패하거나 이미 사용 가능한 ref를 불필요하게 대기시킨 것이었다.
- v0.2.12는 실제 local Speaker controller ref를 물리적 준비 근거로 삼는다. ref가 있으면 stale `initializing` 라벨과 무관하게 즉시 명령을 보내고, ref가 잠시 없으면 stale `ready` 라벨이어도 기존 12초 상한 queue에 넣는다. 자식의 모든 `ready` 알림에서 `ready → ready`처럼 React state effect가 생략되는 경우까지 queue를 drain한다. `failed`/`invalid_configuration`만 즉시 실패하며 OBS 정지 확인 실패는 기존처럼 Speaker 시작을 막지 않는다.
- `dispatchDeferredTransportCommand`와 `reconcileDeferredTransportState`의 순수 회귀 계약을 추가했다. stale-ready/no-ref 명령이 대기한 뒤 remount-ready 알림에서 정확히 한 번 실행되는지, stale-initializing/live-ref는 즉시 실행되는지, terminal 실패는 bounded인지 자동 테스트한다.
- 검증: 자동 테스트 666/666, lint 신규 경고 0(기존 `functions/api/gemini.js` escape 경고 2건만 유지), 모든 Functions/Worker 문법, production build, OBS 정적 closure 예산(raw 382,809B / gzip 117,324B / brotli 102,821B)을 통과했다. 로컬 Speaker network smoke는 실제 재생 중 session HTTP 0회/WebSocket 0개/frame 0개, local chunk 2개/remote chunk 0개를 유지했고, 로컬 파일 복구·drag·Dashboard·1,000곡 성능 smoke도 통과했다. 1,000곡 cold 254.7ms, warm p95 34.6ms, post-GC heap 증가 0B, 320px overflow 0이었다.
- 유레카의 노란 머리를 상징하는 3px 금발선은 영구 UI 계약으로 보존한다. 이번 변경은 CSS를 건드리지 않았고 기존 한국어·영어 320/375/768/1100px 브라우저 검증과 정적 회귀 검사를 계속 유지한다.
- 실제 OBS 설정은 시험 후 원래 Browser Source URL로 정확히 복원했고 테스트 URL이 설정 파일에 남지 않았음을 확인했다. v0.2.12 배포 뒤 같은 실제 OBS → Speaker 재생 중 전환을 다시 실행해 `<audio>`의 `paused=false`, Blob source, 증가하는 media time을 최종 확인한다.

## 2026-07-22 (Codex) — v0.2.11 Speaker 로컬 파일 완전 로컬 우선

- 로컬 파일 선택·검토·즉시 재생·대기열 추가·파일 다시 선택은 이제 page-owned `blob:`만 사용한다. Speaker에서는 파일을 Worker에 올리거나 `/v1/sessions`를 만들지 않으며, 로컬 WAV를 실제 `<audio>`로 재생해 시간이 증가하는 동안 session HTTP 0회 / control WebSocket 0개 / 전송 frame 0개를 확인했다.
- 한 로컬 곡은 Speaker용 `blob:`과 선택적인 OBS용 `assetId`를 나란히 가진다. OBS 준비가 끝나도 Speaker source를 덮어쓰거나 회수하지 않으므로 업로드·OBS 연결 실패 뒤에도 같은 페이지에서 Speaker로 즉시 돌아갈 수 있다. 같은 Blob을 참조하는 현재 곡·대기열·이력은 source별 업로드 하나를 공유한다.
- OBS를 명시적으로 고른 순간에만 현재 곡·대기열·검토 중 파일의 방송 자산을 준비한다. 유효한 `assetId` 전에는 strict OBS 재생을 시작하지 않으며, 준비 완료 뒤 곡을 다시 누르라는 다음 행동을 한국어·영어로 안내한다. 실패는 자동 무한 재시도하지 않고, 검토 화면에는 `OBS 파일 다시 준비` 버튼을 제공하며 대기열 곡은 다시 누를 때만 재시도한다.
- Speaker 출력은 OBS 파일 준비가 진행 중이거나 실패해도 잠기지 않는다. 로컬 파일 다시 선택도 먼저 Blob을 복구하며 OBS 업로드를 기다리지 않는다. Blob URL은 기존처럼 `localStorage`와 탭 간 공유 상태에 쓰지 않고 마지막 페이지 참조가 사라질 때 회수한다.
- 첫 화면에서는 `DashboardLocalSpeaker`, `playbackEngine`, 원격 prepare/cache graph를 모두 내려받지 않는다. 로컬 파일을 검토할 때 Speaker controller와 playback engine 두 청크만 지연 로드하고, 원격 resolver/cache 두 청크는 로컬 재생에서 계속 0개였다. 새 Dashboard는 DOM 124개, script 6개, decoded resource 약 0.99MiB를 유지한다.
- 모든 새 사용자 문구는 locale catalog의 semantic key로 한국어·영어를 함께 추가했다. OBS player·Worker protocol·단일 출력 lease는 수정하지 않았다. 유레카의 금발을 뜻하는 3px 노란 선은 연결·파일 상태와 독립된 영구 UI 계약으로 유지하고 320/375/768/1100px, 한국어·영어 로컬 브라우저에서 다시 확인했다.
- 검증: 자동 테스트 664/664, lint 신규 경고 0(기존 Gemini escape 경고 2건), Worker 문법, production build, OBS 정적 closure 예산(raw 382,809B / gzip 117,326B / brotli 102,762B), Speaker network/local-file recovery/drag/Dashboard/1,000곡 browser smoke를 통과했다. 업로드 실패→수동 재시도→Blob 보존→Speaker 실제 재생도 격리 브라우저에서 통과했다. 1,000곡은 최대 100행, cold 218.7ms, warm p95 33.2ms, post-GC heap 증가 0B이며 320px overflow가 없다.
- 앱 커밋 `4341403`을 Pages workflow `29907992528`로 배포했다. clean install, 664개 테스트, lint, Worker 문법, production build, OBS bundle budget, publish가 모두 성공했다.
- 캐시를 우회한 공개 v0.2.11에서 로컬 WAV가 실제 재생되는 동안 session HTTP 0회 / WebSocket 0개 / frame 0개 / Worker host 요청 0회였고, local Speaker·PlaybackEngine 청크 2개만 수요 로드됐으며 remote media 청크는 0개였다. 공개 Dashboard는 DOM 124개, 초기 script 6개, decoded resource 997,845B, warm DCL 24.0ms였다. 320/375/768/1100px 한국어·영어의 머리핀·금발 선을 모두 통과했다.
- 공개 1,000곡 이력은 cold 199.9ms, warm p95 38.3ms, post-GC heap 증가 0B, 320px overflow 0이었다. 공개 drag도 취소 저장 변경 0건, 이력 drop 재생 0건, session 요청 1→1을 유지했다.
- 실제 OBS에서 로컬 파일을 업로드해 송출한 뒤 같은 파일을 Speaker로 다시 듣는 과정, 사용자 청취, 비공개 방송/VOD, 모바일 OS별 백그라운드·장치, 장면/소스 새로고침·OBS 재시작 변형, 10분 마이크↔MR 상호상관은 자동 증거와 구분한 물리 관문으로 남긴다.

## 2026-07-22 (Codex) — v0.2.10 Speaker 수요 기반 연결 분리

- 새 Dashboard는 일반 웹 플레이어인 Speaker로 즉시 시작하며, 페이지 진입이나 검색만으로 production Worker의 `/v1/sessions`를 만들지 않는다. 준비할 YouTube 미디어·로컬 업로드·OBS 주소처럼 실제 미디어 자격이 필요한 행동에서만 저장 세션을 만들거나 재사용한다.
- 미디어 HTTP 자격과 OBS 제어권을 분리했다. Speaker에서 곡 준비용 세션이 생기거나 저장 세션이 있는 채로 새로고침해도 legacy observer와 Protocol v2 control WebSocket은 열리지 않는다. 이 페이지에서 사용자가 OBS를 명시적으로 고른 뒤에만 두 제어 연결을 깨운다.
- 첫 OBS 선택은 비활성 controller의 초기 상태를 오류로 보지 않고 bootstrap intent로 받아들인다. 같은 페이지에서 OBS 연결을 한번 시작한 뒤 Speaker로 돌아오는 경우에는 진행 중인 OBS 정리와 빠른 복구를 위해 controller를 유지하지만, Speaker 선택·재생은 그 권한이나 정지 증거를 기다리지 않는다.
- 새 production-browser smoke는 격리된 Chrome에서 idle 1.5초, 검색, 첫 곡 준비, 저장 세션 새로고침을 각각 계측한다. idle·검색·저장 세션 재방문은 session HTTP 0회 / WebSocket 0개 / 전송 frame 0개였고, 첫 곡 준비만 session POST 1회였으며 WebSocket은 계속 0개였다. 곡 drag smoke도 검색 자체와 이력 drop 자체가 별도 session 요청을 만들지 않음을 확인했다.
- 계약 문서에 Speaker 출력·미디어 인증·OBS 제어의 세 상태와 전이를 분리해 기록했다. 로컬 파일을 서버 없이 page Blob으로 먼저 재생하고 실제 OBS 수요 때만 업로드하는 후속 상태기는 파일 수명과 업로드 복구를 포함해 별도로 적용한다.
- 사용자 노출 문구는 추가하지 않았으며 locale catalog parity에 영향이 없다. OBS player·Worker media graph와 protocol은 수정하지 않았다. 유레카의 금발을 뜻하는 실제 3px 노란 선도 영구 불변식으로 명시하고 320/375/768/1100px 한국어·영어 production-browser smoke에서 다시 확인했다.
- 검증: 자동 테스트 654/654, 그 안의 500회 Speaker↔OBS 왕복, lint 신규 경고 0(기존 Gemini escape 경고 2건), Worker 문법, production build, 로컬 Dashboard/곡 drag/로컬 파일 복구/Speaker network smoke를 통과했다. 1,000곡은 cold 220.2ms, warm p95 30.9ms, post-GC heap 증가 0B이며 320px overflow가 없다.
- 성능: 초기 Dashboard는 제어 세션이 없어서 DOM 124개, warm load 33.1ms, long task 0건으로 실측됐다. Dashboard JS 356.31kB raw / 97.69kB gzip, CSS 59.79kB raw / 11.32kB gzip이며 OBS 정적 closure는 raw 382,301B / gzip 116,103B / brotli 101,699B로 기존 예산 안이다.
- 앱 커밋 `ea5b871`을 Pages workflow `29905853199`로 배포했다. clean install 뒤 654개 테스트, lint, Worker 문법, production build, OBS bundle budget과 publish가 모두 성공했다.
- 캐시를 우회한 공개 v0.2.10에서 Speaker idle 1.5초와 검색 후 Worker session HTTP 0회, control WebSocket 0개, 전송 frame 0개를 재확인했다. 공개 Dashboard는 DOM 124개, warm DCL 25.9ms, warm long task 0건이었고 320/375/768/1100px의 머리핀·3px 금발 선, 한영 전환을 통과했다. 공개 1,000곡은 cold 109.1ms, warm p95 63.0ms, post-GC heap 증가 0B다.
- 실제 청취, 비공개 방송/VOD, 모바일 OS별 백그라운드, 장면/소스 새로고침·OBS 재시작 변형, 10분 마이크↔MR 상호상관은 이 연결 분리와 별도의 물리 관문으로 계속 남는다.

## 2026-07-22 (Codex) — v0.2.9 곡 클릭·드래그 빠른 배치

- 기존 곡 클릭은 그대로 `곡 정보 확인`으로 들어가며, YouTube 검색 결과와 MR이 실제 연결된 YouTube 플레이리스트·Setlink·멜로밍 곡에 데스크톱 드래그 빠른 경로를 추가했다. MR이 없거나 곡명 정리 중인 노래책 행은 재생 가능한 척하지 않고 기존 클릭→MR 찾기 흐름만 사용한다.
- 곡을 끄는 동안에만 화면 아래에 `지금/다음 재생`, `대기열 끝`, `이전 재생곡` 세 목적지가 나타난다. drop 전에는 앱 상태·localStorage·Worker를 전혀 바꾸지 않으며, drag 취소는 durable state 변경 0건으로 실측했다.
- `지금 재생`은 현재 곡이 없고 준비가 끝난 경우 기존 재생 상태기를 그대로 사용한다. 현재 곡이 있으면 문구가 `다음 재생`으로 바뀌고 현재 곡을 강제 절단하지 않은 채 새 항목을 대기열 맨 앞으로 보낸다. 준비 중인 곡도 동일하게 맨 앞에서 준비를 계속한다. `대기열 끝`은 재생 유무와 관계없이 끝에 추가하고, `이전 재생곡`은 미디어·OBS 명령 없이 completed 항목만 만든다.
- drag payload는 11자 YouTube ID·곡명·가수·태그·source·songbookId만 가진 페이지 메모리 값으로 제한했다. drop마다 새 `entryId`를 발급하며 대기열/이력 내부의 기존 entryId 드래그나 로컬 파일 drop 타입과 섞이지 않는다.
- 모든 새 문구는 한국어/영어 semantic key를 함께 추가했다. 드래그는 포인터 가속 경로일 뿐이며 모바일·키보드는 기존 클릭→검토→재생/대기열 버튼을 정식 대체 경로로 유지한다.
- 실제 Chrome 격리 origin에서 클릭→검토, 이력 0→1(재생 0), 대기열 0→1, 준비된 곡의 실제 Speaker 재생을 확인했다. 현재 곡을 일시정지한 뒤 다른 곡을 재생 목적지에 놓았을 때 현재 곡과 위치는 그대로였고 새 곡만 대기열 1번이 됐다.
- 320px 시각 검증에서 검색 결과의 긴 제목이 문서를 368px로 늘리는 문제를 발견해 결과 flex 항목의 `min-width: 0`, 제목 줄바꿈, 모바일 썸네일 폭을 고정했다. 수정 뒤 문서 폭은 정확히 320px, drop tray는 x=8..312의 304px, 세 목적지는 각각 약 90.7px로 화면 안에 들어왔다.
- 직전 클릭 토스트가 drop tray를 덮어 목적지가 없는 것처럼 보이는 문제도 캡처로 발견했다. drag 중에는 tray를 최우선 조작면으로 두고 toast를 잠시 숨기며, drag가 끝나면 기존 toast가 다시 나타난다. 평상시 tray DOM은 0개라 상시 UI·레이아웃 비용이 없다.
- 검증: 654/654 자동 테스트, 그 안의 500회 로컬 Speaker↔OBS 왕복, 새 `dashboard-song-drag-smoke`, 로컬 파일 복구 smoke, 1,000곡 production-browser 성능 smoke, 로컬 production Dashboard smoke, Worker 문법, production build를 통과했다. lint는 기존 `functions/api/gemini.js` escape 경고 2건만 유지한다.
- 성능: Dashboard JS 356.26kB raw / 97.66kB gzip, CSS 59.79kB raw / 11.32kB gzip, 1,000곡 cold open 34.1ms, warm p95 47.5ms, post-GC heap 증가 210,748B다. OBS 정적 closure는 raw 382,301B / gzip 116,112B / brotli 101,671B로 450KiB/130KiB 예산 안이며 OBS player·Worker media graph는 변경하지 않았다.
- 앱 커밋 `f8f78ad`를 Pages workflow `29904080444`로 배포했다. clean install 뒤 654개 테스트, lint, Worker 문법, production build, OBS bundle 예산과 publish가 모두 성공했다.
- 캐시를 우회한 공개 v0.2.9 Dashboard smoke에서 Speaker 기본값, 활성 Speaker/OBS 선택, YouTube 단일 소스, 한국어↔영어 지속성, 설정 대화상자와 320/375/768/1100px 반응형을 통과했다. 유레카 금발을 뜻하는 실제 3px 노란 선도 모든 폭에서 다시 확인했다.
- 드래그 smoke가 로컬 개발 서버뿐 아니라 대상 URL을 직접 받을 수 있게 했다. 공개 주소에서도 클릭→검토, 취소 시 저장 변경 0건, 이력 drop 시 재생 0건, 320px 문서 폭 320px와 3개 목적지 범위를 통과했다. 공개 환경의 media-session 요청은 이력 drop 직전 2건에서 직후 2건으로 유지돼 drop 자체가 새 세션 연결을 만들지 않았다. 같은 공개 릴리스의 1,000곡 이력은 cold 28.4ms, warm p95 40.5ms, post-GC heap 증가 257,576B였다.
- 실제 청취, 비공개 방송/VOD, 모바일 OS별 백그라운드, 10분 마이크↔MR 상호상관은 이 UI 변경과 별도의 물리 관문으로 계속 남는다.

## 2026-07-22 (Codex) — v0.2.7 유레카 금발선 영구 요소 승격

- 유레카의 노란 머리를 상징하는 헤더의 3px 노란 선을 CSS 가상 요소에서 `Dashboard`가 항상 렌더하는 실제 장식 요소로 승격했다. 출력 상태 포털이 아직 비어 있거나 연결 UI가 바뀌어도 선의 생명주기는 헤더와 같으며, Speaker/OBS 상태·WebSocket·재생 로직에는 의존하지 않는다.
- 쌓임 순서는 헤더 배경 < 금발선 < 흰 머리핀으로 명시했다. 금발선은 `z-index: 1`, 머리핀은 `z-index: 2`라서 기존처럼 computed style은 정상이지만 헤더 뒤에 칠해지는 회귀를 막는다. 320px 이하를 포함한 반응형 규칙에서도 선을 숨기지 않는다.
- `127.0.0.1:5000`이 현재 소스가 아니라 이전 `dist` 자산을 제공해 머리핀 상태 영역이 없는 오래된 화면을 보이고 있음을 확인했다. v0.2.7 production build로 `dist`를 갱신해 로컬 preview와 현재 소스 기준을 일치시켰다.
- 정적 회귀 테스트는 실제 `dashboard-brand-hairline` DOM 존재, 3px 높이, 금발 토큰, stacking 순서와 숨김 규칙 부재를 고정한다. Dashboard 브라우저 smoke는 320/375/768/1100px에서 실제 요소의 폭·불투명 색·높이·z-index와 머리핀 viewport 범위를 확인한다.
- 검증: 자동 테스트 635/635, lint 신규 오류·경고 0(기존 Gemini escape 경고 2건), production build, 로컬 Dashboard smoke, OBS 정적 closure budget(raw `382,301B` / gzip `116,109B` / brotli `101,706B`), `git diff --check`를 통과했다. 로컬 렌더에서도 선은 `rgb(242, 217, 141)`, 3px, opacity 1, 헤더 전체 폭으로 확인했다.

## 2026-07-22 (Codex) — v0.2.6 장기 이력 고정 창과 브라우저 성능 관문 후보

- 기존의 `이전 100곡 더 보기`는 누를 때마다 100→200→…→1,000행을 한 화면에 누적했다. 닫힌 이력 0행과 최초 100행은 가벼웠지만, 오래 사용할수록 결국 모든 행을 다시 만드는 구조라 장시간 웹 플레이어 예산에 맞지 않았다.
- 이력은 이제 언제나 한 페이지만 렌더한다. 최근 100곡에서 `이전 100곡 보기`로 이동하고, 오래된 페이지에서는 `다음 100곡 보기` 또는 `최근 100곡 보기`로 돌아간다. 원본 1,000곡, 저장 순서, 삭제·재신청·드래그 식별자는 그대로 유지하면서 DOM에는 최대 100행만 둔다. 이력을 닫으면 행 0개와 최신 페이지로 즉시 초기화한다. 950곡처럼 100의 배수가 아닌 이력도 가장 오래된 50곡과 다음 100곡이 겹치지 않도록 페이지 offset을 batch 경계에 고정했다.
- 새 버튼 문구는 한국어·영어 semantic key로 함께 추가해 locale catalog parity를 유지했다. 320px에서도 두 개의 돌아가기 버튼이 줄바꿈되며 가로 overflow를 만들지 않는다.
- `scripts/dashboard-history-performance-smoke.mjs`를 추가해 production build/preview와 공개 URL 모두에서 현실적인 1,000곡 localStorage fixture를 주입하고, 전체 10페이지 왕복·최신 복귀·5회 재개폐·모바일 폭·GC 뒤 heap을 실제 Chromium으로 측정한다. 개발 서버의 module transform 비용이 UI 조작 시간에 섞이는 문제를 발견해 production preview만 성능 판정에 사용하며, 최초 cold open은 warm p95와 분리한다.
- 반복 실측에서 저장 payload는 `290,235B`, 최대 이력 행은 `100`, 최초 개방은 `31.9~259.4ms`, warm 조작 p95는 `30.6~42.8ms`, 320px 문서 폭은 정확히 `320px`, 닫고 GC한 뒤 heap 증가는 약 `0.2MiB`였다. 기준은 각각 1MiB, 100행, cold 300ms, warm p95 100ms, heap 증가 16MiB다.
- 유레카의 금발을 뜻하는 3px 노란 선은 기존 stacking-context 회귀 검사와 Dashboard smoke에 계속 포함된다. 이 성능 변경에서도 320/375/768/1100px 한국어·영어 화면의 선 높이·불투명 색·머리핀 범위를 다시 통과했다.
- 검증: 자동 테스트 635/635, lint 신규 오류 0(기존 Gemini escape 경고 2건), production build, 로컬 Dashboard smoke, 1,000곡 production-browser 성능 smoke, OBS 정적 closure budget(raw `382,301B` / gzip `116,113B` / brotli `101,719B`), `git diff --check`를 통과했다.
- 첫 Pages workflow `29898243550`은 clean install 뒤 기존 adapter 통합 테스트의 fixture Blob 대기가 CI에서 29ms 만에 만료돼 중단됐다. 제품 timeout이 아니라 `setImmediate` 250회라는 CPU 속도 의존 테스트 상한이 원인이었다. 이를 실제 시간 2초의 bounded wait로 교체해 빠른 로컬과 병렬 Linux CI가 같은 시간 계약을 사용하게 했다. 실제 고착은 여전히 2초 뒤 실패한다.
- 주 기능은 `511beed`, CI 대기 보강은 `eb25839`에 커밋했다. Pages workflow `29898336642`는 clean install, 635개 테스트, lint, Worker 문법, build, OBS budget, publish를 모두 통과했다.
- 공개 `https://11qaws.github.io/rekasong/` 재검증은 Speaker 기본값·활성화된 Speaker/OBS 버튼·YouTube 단일 소스·한영 전환·320/375/768/1100px의 머리핀과 3px 금발 선을 모두 통과했다. 공개 1,000곡 실측은 최대 100행, 저장 `290,235B`, cold open `32.3ms`, warm p95 `46.9ms`, 320px overflow 0, post-GC heap 증가 `219,300B`였다.

## 2026-07-22 (Codex) — 실제 OBS 녹화 G4와 숨은 소스 비파괴 복구

- OBS 30.2.0의 `Rekasong` Browser Source에서 로컬 녹화를 시작한 뒤 앱 점검 신호를 재생하고 녹화를 정상 종료했다. 라이브 송출은 시작하지 않았다.
- 결과 파일 `C:\Users\Qumin\Videos\2026-07-22 09-57-46.mp4`는 33.283초, 5,302,320바이트, H.264 영상 + AAC 48kHz stereo 오디오다. 전체 오디오 peak는 -21.2dB로 clipping이 없었다.
- 주파수별 frame 분석에서 880Hz 짧은 pulse 12개와 440Hz 긴 tone 4개가 정확히 검출됐다. 16개 marker의 누락·중복이 없고, AAC frame 해상도에서 20ms를 넘는 활성 구간 분할도 관측되지 않았다. 이 구성의 G4 녹화 artifact는 통과했지만 사용자 청취, 비공개 방송 결과물, 마이크↔MR 싱크는 별도 관문으로 남는다.
- 실제 production UI에서 OBS source 눈 아이콘을 끈 뒤 OBS를 새로 선택하면 연결된 player가 있어도 `OBS 플레이어 없음`과 완전 초기화를 안내하는 문제를 재현했다. 원인은 명시적인 `sourceActive/sourceVisible=false`와 일반 candidate 부재를 같은 상태로 표시한 것이었다.
- 최신 후보는 정확히 한 OBS player가 연결돼 있고 source inactive가 명시적으로 관측된 경우 `OBS 소스를 표시해 주세요`와 `Rekasong 눈 아이콘을 켠 뒤 OBS를 다시 선택하세요`만 안내한다. 이 상태에서는 완전 초기화 카드를 숨기며, 초기 미관측 상태는 inactive로 오인하지 않는다.
- source를 약 1.4초 숨겼다가 다시 표시하는 동안 established OBS route와 test fixture를 실제로 실행했다. route는 OBS 활성 상태를 유지했고 G2는 16/16 marker로 완료됐다. hide/show는 연결을 파괴하거나 자동 재생하지 않는 비파괴 telemetry임을 실제 OBS로 확인했다.
- 이 변경은 사용자 검토 전이므로 아직 커밋·배포하지 않았다. 공개 Pages/Worker에는 기존의 일반 복구 안내가 남아 있다.

## 2026-07-22 (Codex) — v0.2.2 Speaker 독립 탭·단순 설정·정식 locale 후보

- OBS 리모컨의 마지막 사용자 play/pause/seek/volume 요청과 플레이어가 실제로 적용한 결과를 분리했다. 코디네이터가 만든 정확한 `commandId`와 run을 기준으로 Worker의 기존 `command_applied`/`command_failed` 확인값만 연결하며, 단순 수신 ACK나 optimistic 값은 성공으로 표시하지 않는다. 5초 안에 실제 값이 돌아오지 않으면 재생을 끊거나 명령을 재전송하지 않고 `지연`과 다음 확인 행동만 보여 준다. 새 WebSocket message, polling, heartbeat, Durable Object write는 추가하지 않았다.
- 장시간 사용 이력은 닫혀 있을 때 행을 전혀 만들지 않고, 처음 열면 최근 100곡만 렌더한다. 숨은 곡은 100곡씩 명시적으로 확장하고, 닫거나 `최근 100곡만 보기`를 누르면 다시 가벼운 창으로 돌아간다. 1,000곡 원본 데이터·순서·저장 스키마는 그대로 유지하면서 초기 이력 DOM을 1,000행에서 0행으로 줄였다.
- 개인 감상용 Speaker 볼륨과 방송용 OBS gain을 별도 프로필로 분리했다. 기존 `rekasong_volume`은 배포 직후 음량이 튀지 않도록 두 프로필의 최초값으로 한 번만 승계하며, 이후 한 모드의 조절이 다른 모드에 영향을 주지 않는다. 현재 run의 실제 출력 모드가 조절 대상을 결정하므로 OBS→Speaker 이동도 OBS gain을 물려받지 않는다.
- 실제 로컬 브라우저에서 음원은 완전히 준비됐지만 `준비 중`에 영구 정지하는 문제를 발견했다. 원인은 PlaybackEngine의 READY 증거 observer 안에서 동기적으로 PLAY를 호출해 엔진의 재진입 방어에 걸린 것이며, 해당 실패가 관측 보조 오류로 흡수돼 UI까지 도달하지 않던 것이었다. PLAY를 다음 microtask로 미루고 run ID에 묶었으며, 그 사이 pause·stop·교체 LOAD·dispose가 오면 예약된 자동재생을 취소하도록 수정했다.
- 수정 뒤 `Best Friend`가 실제 `<audio>`에서 `readyState=4`, `paused=false`로 재생되고 media time이 계속 증가함을 확인했다. Speaker 볼륨을 34%로 바꾼 뒤 곡을 버리고 새로고침해 같은 곡을 다시 재생했을 때 슬라이더 34%, 활성 상태, 재생 시간 증가를 다시 확인했다. 마지막 버리기는 `paused=true`, `src` 분리까지 확인했다.
- Speaker 시작 실패는 내부 코드 대신 다음 행동을 말한다. 브라우저 자동재생 차단은 현재 곡의 재생 버튼을 한 번 누르도록, 그 외 시작·로딩 실패는 다시 재생하거나 버리도록 한국어·영어로 안내한다.
- 지원 브라우저의 Speaker 설정에 Rekasong 전용 출력 장치 선택을 추가했다. `selectAudioOutput`과 `setSinkId`가 모두 있을 때만 표시하며 선택·취소·권한 거부·저장 실패는 곡이나 OBS route를 멈추지 않는다. 장치 선호는 로컬에만 저장하고 현재·다음 Speaker media에 best-effort로 적용한다. 미지원 브라우저에서는 별도 경고 없이 시스템 기본 출력으로 계속 재생한다.
- 실제 Speaker run에만 브라우저 Media Session을 연결했다. 지원 모바일의 잠금 화면·알림·헤드셋 play/pause/next/seek는 기존 Dashboard 조작을 그대로 호출하며, OBS run·유휴·화면 종료에서는 metadata와 handler를 모두 제거한다. API 미지원이나 예외는 재생·Worker·WebSocket·저장 상태에 영향을 주지 않는다.
- 현재 실제 Dashboard 사용자 화면 8개에 source guard를 추가했다. 하드코딩 한국어, 정적 title/aria/placeholder, toast/confirm 문구가 다시 들어오면 전체 테스트가 실패한다. 외부 고유명사와 locale-neutral legacy metadata만 명시적으로 제외한다.
- Speaker의 `currentEntry`와 active run을 탭 소유 런타임으로 분리했다. `localStorage`에는 큐·이력·노래책·설정만 저장하며, storage event가 다른 탭의 현재 곡을 만들거나 재생을 덮어쓰지 않는다.
- 실제 Chrome 두 탭에서 첫 탭 `Best Friend`, 둘째 탭 `IDOL`을 동시에 각자의 현재 곡으로 유지했다. Worker의 여러 legacy Speaker 후보도 exact-one gate 없이 공존한다.
- Speaker 상태로 설정을 열 때 OBS 연결·제어권·복구·오디오 점검을 한꺼번에 노출하지 않는다. 언어와 출력 선택, 이 탭의 Speaker 안내만 먼저 보이고 OBS를 선택하거나 막힌 OBS 선택을 점검할 때만 방송 설정을 연다.
- 재생·대기열 토스트, AI 분석 진행, 네트워크/미디어 오류, ErrorBoundary, Display Widget을 semantic message key로 이관했다. AI 단계는 한국어 문장 정규식 대신 locale-neutral phase를 사용한다. Widget은 작은 전용 `ko/en` catalog와 URL `lang`을 사용한다.
- 자동 생성되는 YouTube 재생목록·Setlink 기본 출처명은 저장 당시 언어를 영구 보존하지 않고 현재 앱 언어로 다시 표시한다. 사용자가 지정한 Setlink 이름은 그대로 보존한다.
- 초기 media session 생성이 실패하면 로컬 Speaker 명령이 `initializing` 대기열에 무기한 남던 복구 구멍을 닫았다. 준비 대기는 12초로 제한하고, 실패는 현재 재생 시도만 종료하며 다음 재생 행동이 세션 생성을 다시 시도한다. 이 보조 실패는 Speaker 출력을 `경로 확인 필요`로 바꾸지 않는다.
- 실제 492×995 좁은 브라우저에서 영문 Speaker 설정 대화상자의 좌우 여백, 가로 overflow 부재, 경로 확인/서버 대기 문구 부재를 재검증했다.
- 검증: 626 tests pass, lint 신규 오류·경고 0(기존 Gemini escape 경고 2), production build pass. Dashboard 341.66kB raw / 93.60kB gzip, CSS 56.22kB raw / 10.56kB gzip, local Speaker lazy 4.55kB raw / 1.82kB gzip. OBS 정적 경로 raw 381,225B / gzip 115,962B / brotli 101,613B로 예산 통과. Worker syntax와 `git diff --check` 통과.
- 공개 Pages/Worker는 아직 `2c7dca5` 기준이다. 이 후보는 사용자 검토와 승인 전이라 커밋·배포하지 않았다. 실제 OBS G3~G6은 계속 미완료다.

### Speaker 경로 수 제한 제거 재감사

- Dashboard Speaker는 서버 출력 후보가 아니므로 1개 경로 제한의 대상이 아니다. 탭·창마다 로컬 `<audio>`와 controller를 하나씩 가지며 여러 탭이 동시에 각각 재생할 수 있다. 과거 `dashboard-speaker` 후보/lease 코드는 구버전 프로토콜 호환용일 뿐 최신 Dashboard의 선택·재생을 차단하지 않는다.
- Speaker 설정 radio는 OBS 제어 연결, 다른 탭 owner, route unknown, heartbeat, legacy Speaker 후보 수와 무관하게 항상 선택 가능하다. 재생 lifecycle 자체의 준비·종료 처리 외에는 play/pause/seek/volume/skip에 출력 경로 잠금을 적용하지 않는다.
- 폐기된 “첫 Speaker 후보 exact-one 등록 대기” 설명이 남은 OBS 테스트·검증 문서를 현재 로컬-player 계약으로 교정했다. OBS만 정확히 한 eligible Browser Source와 단일 lease를 요구한다.
- 실제 Chrome 두 탭에서 각각 `data-local-speaker-state=ready`, 로컬 `<audio>` 1개, `Playing through speakers`를 확인했다. 두 번째 탭의 Speaker radio는 `checked=true`, `enabled=true`, `disabled` 속성 없음, `aria-disabled=false`였다. Speaker 설정에는 서버 대기·경로 확인·다른 탭 제어권 경고가 나타나지 않았다.
- OBS 리모컨 적용 확인을 추가한 뒤에도 실제 Speaker 재생은 `readyState=4`, `paused=false`로 진행됐고, Speaker 설정과 헤더에는 OBS 확인 카드가 0개였다. 곡을 버리자 media는 즉시 `paused=true`가 됐다.
- 앱 라우팅 관점의 Speaker 탭·창 개수 상한은 없다. 준비 음원 접근 토큰은 소유권을 소비하는 단일-use lease가 아니므로 같은 사용자가 연 여러 로컬 플레이어가 각자 음원을 받을 수 있다. 실제 한계는 브라우저·OS·네트워크 자원뿐이며 앱이 임의로 한 경로를 선정하거나 나머지를 차단하지 않는다.
- OBS 설정에는 실제 G2 신호 뒤 사용자가 정확한 Audio Mixer meter를 확인해 `움직임`/`움직이지 않음`을 남기는 별도 관문을 추가했다. 결과는 room·player·check 단위로 이 브라우저에만 저장하고 route·재생·Worker에는 영향을 주지 않는다. 이는 G3 사용자 확인 기록일 뿐 녹화·송출·마이크↔MR 싱크 증거로 승격하지 않는다.
- 실제 UI에서 두 Dashboard 탭을 연 상태로 둘째 탭의 OBS 선택을 시도했을 때는 다른 탭 제어권을 안내했지만 Speaker radio는 계속 활성 상태였다. 첫 탭을 닫은 뒤 OBS를 다시 선택하자 `OBS 플레이어 없음`과 다음 행동을 정상 표시했고, 그 실패 상태에서 Speaker를 누르면 즉시 `checked=true`, `aria-disabled=false`, local player `ready`로 돌아왔다. 실패한 OBS 경로가 Speaker를 가두지 않는다.
- 390×844 viewport에서도 흰 머리핀 헤더, 단일 YouTube→Setlink→Meloming 소스 순서, YouTube 내부 Search/Playlist, 곡 클릭 직후 Review track/Play now 전환을 실제 화면으로 확인했다. 설정 대화상자는 세로 스크롤만 사용하고 가로 overflow 없이 Speaker 안내와 OBS 고급 설정을 분리했다.

## 2026-07-22 (Codex) — 일반 곡 OBS WebSocket 연속성 실제 Chrome smoke

- 기존 8초 점검 신호와 scene-inactive smoke는 있었지만, 일반 LOAD/PLAY 곡의 player WebSocket을 실제로 닫고 같은 페이지의 자동 재접속을 검증하는 브라우저 관문은 단위 테스트에만 있었다. `npm run test:obs:v2:continuity`를 추가해 이 공백을 닫았다.
- 48kHz mono PCM WAV를 5초~10분 범위에서 생성하는 bounded fixture를 추가했다. 기본 30초 파일은 2,880,044바이트이며 세션 asset으로 업로드된 뒤 Player가 완전히 Blob으로 준비한 다음 정상 LOAD→READY→PLAY 계약을 따른다.
- 실제 Chrome에서 현재 player WebSocket만 명시적으로 close했다. Worker는 `target_disconnected`와 lease `unknown`을 관측했지만 같은 `<audio>`/blob은 pause·detach 없이 약 0.358초에서 2.436초로 계속 진행했다.
- 같은 page-owned `playerInstanceId`가 새 connection으로 hello하자 lease는 동일 epoch/target의 `audible`, playback은 동일 entry/run의 `output_reconnected`로 복원됐다. 재접속 구간의 PLAY와 PLAYING은 각 1회뿐이고 pause/ended/emptied/waiting/stalled/error는 0이었다.
- `npm run test:obs:v2:continuity:soak`로 같은 경계를 10분 fixture까지 확장했다. 600초/57,600,044바이트 WAV를 완전히 준비해 590초를 관측했고, media는 590.430초까지 진행했다. media 경과 590,065.3ms와 wall 경과 590,063.1ms의 차이는 2.2ms였으며 허용치 1,500ms 안이었다. 추가 PLAY와 pause/ended/emptied/waiting/stalled/error는 없었다.
- explicit normal STOP은 media를 강하게 분리하되 OBS route 자체는 같은 target의 `ready`로 남겨 다음 곡을 받을 수 있었다. 이후 deactivate, session end, HTTP 410 fence까지 통과했다.
- Chrome의 network-offline 에뮬레이션은 이미 열린 WebSocket을 즉시 close하지 않는 half-open 동작을 보였다. 그 상태에서도 heartbeat 지연만 늘고 재생/lease를 자체 절단하지 않았다. 실제 close 관문은 별도 WebSocket 진단 훅으로 결정적으로 만들었으며 URL·token은 기록하지 않는다.

## 2026-07-20 (Codex) 송출 경로 완전 초기화

- 송출 경로가 막혔거나 선택/실제 경로를 확인할 수 없을 때 설정에서 전체 출력을 정지하고 송출 제어 연결을 다시 시작하는 명시적 초기화 동작을 추가했다.
- 긴급 정지의 ACK 결과를 확인한 경우에만 기존 제어 연결을 폐기하고 새 연결을 만든다. 결과가 불명확하거나 제한 시간 안에 오지 않으면 상태를 성공으로 지우지 않고 실패 안내를 유지한다. 초기화가 성공한 뒤에는 사용자가 스피커 또는 OBS 경로를 다시 선택한다.

## 2026-07-22 (Codex) — v0.2.1 unrestricted Speaker / connection-first OBS

- Speaker 선택은 이제 Worker 출력 lease, 정확히 한 후보, control owner, heartbeat, OBS route 상태와 완전히 분리된다. 설정에서 Speaker는 항상 선택할 수 있고, 읽기 전용·재연결·unknown인 OBS 상태도 로컬 play/pause/seek/volume/skip을 잠그지 않는다.
- 공용 헤더 상태 판정도 Speaker를 서버의 `connecting`·`duplicate`·`foreign owner`·`blocked`로 되돌릴 수 없게 고정했다. 남아 있던 복구 문구도 OBS 전용으로 바꿔, 스피커 화면에는 단일 경로 제한이나 다른 탭 제어 안내가 다시 나타나지 않는다.
- lazy local player가 아직 마운트 중인 첫 클릭은 명령을 버리거나 “경로 확인 필요”로 실패시키지 않고 탭 내부 큐에서 순서대로 실행한다. 각 탭·창의 local controller는 독립적이며 server Speaker player나 heartbeat를 만들지 않는다.
- OBS→Speaker는 로컬 선택을 즉시 반영한다. 기존 OBS run에는 STOP을 best-effort로 보내고 같은 곡을 현재 위치에서 새 local run으로 명시적으로 옮기지만, STOP ACK·제어권·route 전이 결과가 Speaker 사용을 막지 않는다. 준비된 OBS route는 재접속 비용 없이 silent-ready로 남을 수 있다.
- OBS `sourceActive/sourceVisible=false`는 장면 전환 telemetry로 취급한다. 연결된 socket과 media graph를 강제 detach하거나 lease를 unknown으로 만들지 않는다. 새 OBS 활성화는 계속 정확히 한 active OBS Browser Source만 허용하고, 실제 socket close·send failure·명시적 STOP/deactivate/emergency·terminal teardown은 강한 경계로 유지한다.
- OBS heartbeat는 10초 상태 관측이며 established route의 destructive alarm, durable write, 재생 차단 근거가 아니다. dashboard control만 연결된 Speaker 세션도 살아 있고, 모든 control/player가 사라진 뒤에는 30분 reconnect grace를 둔다.
- 번역을 고려해 새 사용자 문구는 `ko/en` semantic key로 함께 추가했다. 전체 locale selector와 기존 하드코딩 문구 이관은 후속 범위다.
- 검증: 567 tests pass, production build pass, OBS bundle raw 379,303B / gzip 115,427B (budgets 460,800B / 133,120B), Worker syntax pass. 실제 OBS mixer/recording/scene-switch/G3~G6 증거는 수동 검증 전까지 미완료다.

## 2026-07-20 (Codex) output intent watchdog

- A route click queued before writable output-control authority is proven now expires after 8 seconds, triggers one reconnect, and exposes settings recovery instead of remaining indefinitely pending.
- The compact output selector disables repeated no-op clicks while recovery is required and uses localized `onair.output.nextAction.control` guidance.

## 2026-07-20 (Codex) — Worker WebSocket heartbeat 빈도 절감
- Protocol v2 기본 테스트 cadence는 보존하되 실제 플레이어는 OBS 1초, 대시보드 스피커 5초 주기로 heartbeat를 보낸다. 250ms 전송은 오디오 시계가 아니며 유휴 브라우저 소켓마다 불필요한 Cloudflare `websocket:message`를 만든다.
- heartbeat는 연결 유지·OBS 런타임 증명의 보조 신호일 뿐 재생 자체의 시간축이 아니다. OBS 소스 상실은 기존 로컬 런타임 콜백이 즉시 처리하고, 서버 heartbeat는 재연결/상태 복구용으로 남긴다.

## 2026-07-20 (Codex) — 연결 우선 복구와 스피커 재연결 UX
- OBS 모드에서는 WebSocket·heartbeat·명령 전달이 일시적으로 모호해져도 연결된 재생 그래프를 즉시 파괴하지 않는다. 당시에는 `sourceActive=false`/`sourceVisible=false`를 긴급 정지 대상으로 두었지만, 후속 v0.2.1에서 장면 전환 telemetry로 재분류해 established graph를 보존하도록 대체했다.
- 같은 OBS 플레이어가 `sourceActive=true`와 OBS 런타임 capability를 다시 보고하면 lease를 `ready`로 복원하되 자동 재생은 하지 않는다.
- 스피커 모드에서 연결이 `unknown`으로 꼬인 뒤 같은 스피커 버튼을 다시 누르면 즉시 실패 고정하지 않고 명시적 해제 확인을 기다려 복구할 수 있게 했다. 재연결만으로는 성공으로 간주하지 않는다.
- Worker 프로토콜 테스트에 스피커 소켓 종료→재연결→명시적 `deactivate_output`→`output_deactivated` 확인 시나리오를 추가했다.

## 2026-07-18 — On-Air 위젯 프리버퍼(pre-buffer): 다음 곡 미리 받기

대기열의 다가오는 곡(준비 완료된 YouTube 곡, 최대 2개)을 On-Air 위젯이 미리 blob으로 통째로 받아 두어 곡 전환이 즉시 되게 했다. 순수 최적화·복원력 작업으로, 프리페치 실패·미스는 항상 기존 스트리밍 재생으로 무손실 폴백된다(기능 변경·회귀 없음).

- **Worker(`handleCommand`)**: `prefetch` 명령을 player로 **broadcast만** 하는 순수 릴레이 추가. transport/세션 상태 불변, **`storage.put` 절대 없음** — 직전 DO 무료 티어 쓰기 한도 초과 사고의 재발 방지가 최우선 제약. videoId는 11자 패턴 검증 + 최대 2개로 잘라 릴레이.
- **위젯(`OnAirPlayer.jsx`)**: `Map<videoId, objectURL>` 캐시(최대 2곡 — 긴 메들리 blob은 수십 MB라 메모리 방어). 힌트 목록에서 빠진 항목은 revoke, 언마운트·세션 종료 시 전부 revoke. 재생 src는 곡(sessionId)당 1회 첫 렌더에서 확정(sticky): 캐시 히트면 blob URL, 아니면 기존 스트리밍 URL.
- **코디네이터(`Dashboard.jsx`)**: 큐에서 `ready`인 YouTube 곡을 순서대로 최대 2개 골라 prefetch 힌트 전송. 같은 목록 중복 전송 억제(ref), 위젯 재연결 시 기억을 지워 재전송(위젯 캐시가 비므로). 빈 목록도 보낸다 — 위젯의 불필요 blob 회수 신호.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **재생 중 `<audio src>` 교체는 요소를 리셋해 재생을 처음부터 다시 시작시킨다.** blob이 뒤늦게 도착했을 때 src를 '업그레이드'하면 회귀다 — src 선택은 sessionId당 1회로 고정(sticky)하고, 늦은 blob은 그냥 버려지게(다음 사용처가 없으면 sweep) 설계했다.
2. **재생에 물린 objectURL을 revoke하면 미디어 fetch가 끊길 수 있다.** sweep은 현재 재생 src와 같은 URL을 보류하고, 곡이 바뀐 뒤(sessionId effect — key 리마운트로 이전 `<audio>`가 내려간 커밋 후)에 회수한다. 따라서 순간 최대 메모리는 '프리페치 2곡 + 재생 중 1곡'이다(재생 중 blob은 어차피 요소가 쥐고 있어 줄일 수 없는 몫).
3. **oxlint exhaustive-deps는 effect가 참조하는 함수가 props를 캡처하는 순간 경고를 낸다.** `applyCommand`(소켓 핸들러)에 prefetch fetch를 넣자 `apiBaseUrl/room/token` 캡처로 신규 경고 발생 — 소켓 effect가 이미 같은 deps로 재연결되므로 거울 ref(`prefetchAuthRef`)로 읽어 함수를 다시 '안정'으로 만들었다(기존 `onMediaReadyRef` 패턴과 동일).

### 검증

- `vite build` 통과, `oxlint` 변경 파일 3종 신규 경고 0.
- **라이브 미검증**: DO 쓰기 한도 소진으로 세션 생성이 500이라 위젯 실재생 검증 불가. 한도 회복 후 코디네이터가 (a) prefetch 릴레이 수신, (b) blob 재생 전환 즉시성, (c) 폴백(캐시 미스 시 스트리밍) 라이브 확인 필요. Worker는 미배포 상태(코드만 커밋).

## 2026-07-17 — 생애주기 Stage 3: finishing / discarding / failed 전이

기준: `docs/SONG_LIFECYCLE.md` §4-3/§4-4/§4-5, `docs/ux-audits/PHASE_08_COMBINED_REVIEW.md` §6 Stage 3. Stage 1(QueueEntry 스키마)·Stage 2(코디네이터 상태기계) 위에 종료 계열 전이만 얹었다. CSS/디자인 파일 무변경(기존 클래스 재사용), 프로토콜(Worker/OnAirPlayer) 무변경.

- **스킵을 규범대로**: 스킵이 '다음 곡 직접 로드 + 즉시 completed'에서 `finishing → 실제 ended 확인 → completed`로 바뀌었다. 로컬 미디어는 duration이 확인될 때 끝으로 보내고(`el.currentTime = el.duration`), 동일 runId의 실제 `ended`에서만 이력 편입·다음 곡 승격이 일어난다(INV-2/3/4). 스킵 버튼의 '다음 곡으로' 의도는 `active.pendingNextEntryId` 예약으로 보존해 autoPlayNext OFF에서도 기존처럼 다음 곡이 승격된다.
- **YouTube 광고 안전장치(§4-3)**: iframe 경로는 outputSafety를 확인할 수단이 없어(§2-4 unknown 고정) 광고 중 `seekTo(끝)`가 'finishing 고착'을 만들 수 있다. 길이/안전성 미확인 시 기존 '다음 곡 직접 로드' 폴백을 쓰되 completionReason='skipped'는 유지한다(오디오 프록시 Stage 6 전 과도기). On-Air 경로도 finish 명령이 없어(Stage 7) 같은 폴백을 쓴다.
- **현재 곡 쓰레기통 재도입(§4-4)**: PlaybackPanel에 `btn-icon btn-icon-danger` 쓰레기통 버튼. 로컬은 명시 pause + 언마운트로 동기 확정, On-Air는 stop 송신 성공 시 확정(확인 이벤트는 Stage 7). 이력 없음·자동 다음 곡 없음(INV-3). 버린 entryId는 늦은 transport 스냅숏이 되살리지 못하게 가드.
- **failed 자동 스킵 제거(§4-5)**: 재생 오류 시 400ms 뒤 자동 다음 곡이던 것을 `phase='failed'` 확정 + 재시도(같은 entry, 새 runId)/버리기 제시로 교체. 실패 사유는 `active.failureDetail`로 남겨 진행 바 자리에 표시(`mr-unavailable` 클래스 재사용).
- **전이 중 조작 잠금**: finishing/discarding/failed 중 재생·일시정지·seek·스킵을 버튼 비활성 + 코디네이터 가드(Space/Ctrl+→ 단축키 경로 포함)로 이중 차단. 상태 배지가 `스킵 중…`/`취소 중…`/`재생 실패`를 표시. playing/paused 확인 이벤트는 이 잠금 phase를 되돌리지 못한다.
- **바로 재생 복합 명령(§4-6)**: 재생 중 대기열 곡 바로 재생은 '선택 곡 예약 + 현재 곡 스킵 요청'(finishing 경유)이 됐다. failed 곡 위의 바로 재생은 '버리기 + 시작'으로, 실패 곡이 완료 이력에 들어가지 않는다.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **일시정지 중 `currentTime = duration` 만으로는 `ended`가 발화하지 않을 수 있다.** 끝으로 보내기 전에 `el.play()`로 재생을 재개해야 ended가 확실히 발화한다(끝 지점이라 청감상 무음). 반대로 ended 상태에서 `play()`를 먼저 부르면 처음으로 되감기므로 순서는 반드시 play → seek.
2. **프로덕션 빌드는 `.env.production`의 `VITE_ON_AIR_BASE_URL`이 항상 주입되어 직접 재생(숨김 플레이어) 경로가 렌더되지 않는다.** 직접 재생 경로의 실렌더 검증은 vite dev 서버(개발 모드)로 해야 한다. preview(프로덕션 빌드)로 로컬 파일을 올리면 실제 배포 Worker에 세션/자산이 생성되니 주의.
3. **`<audio>`를 React 언마운트만으로 정리하면 재생이 즉시 멎지 않을 수 있다.** discard는 언마운트 전에 명시적으로 `pause()`/`stopVideo()`를 부른다.

### 검증

- `vite build` / `oxlint` 통과(경고는 기존 6건 그대로, 변경 파일 무경고).
- playwright-core + Chrome 실렌더 22개 체크 전부 통과: 스킵(재생/일시정지 중)→finishing→ended→completed, 쓰레기통(이력·자동 다음 곡 없음), failed(자동 스킵 제거·버튼/단축키 잠금·재시도 새 runId·버리기), 바로 재생 복합 명령.
- 미검증: YouTube 폴백 스킵(네트워크 필요, 로직은 Stage 2의 기존 경로 재사용), On-Air 폴백(stop/load 송신 — 실제 Worker+플레이어 위젯 필요).

### 호환성

- 상태 스키마는 `active`에 선택 필드 3종(`pendingCompletionReason`, `pendingNextEntryId`, `failureDetail`)만 추가 — 구 상태를 읽을 때 없으면 무시되므로 하위 호환 유지. 버전 번호는 이번 지시 범위(버전/package.json 변경 금지)에 따라 올리지 않았다.

## 2026-07-16 — 반응형 통일 디자인 (UX Audit Phase 06)

상세 계획·검증은 `docs/ux-audits/PHASE_06_RESPONSIVE_UNITY.md` 참조. CSS만 변경(JS/JSX 무변경).

- **뷰포트 잠금(wide)**: 대시보드가 100vh 플렉스 체인 + `grid-rows: auto minmax(0,1fr)`로 잠기고, 페이지 스크롤 없이 대기열/검색 리스트만 패널 내부에서 스크롤. narrow(≤1100px)는 기존 스택을 보존하되 리스트 높이를 캡해 페이지 길이를 고정.
- **컨테이너 쿼리**: 2단계 미리보기 레이아웃이 뷰포트가 아닌 composer 칼럼 실폭(620px)에 반응.
- **색 위계 재정렬**: 활성 탭 등 상시 면적의 네온 에메랄드를 딥그린(--chr-vest)으로, 네온은 ON AIR·현재재생·포커스링(`:focus-visible`)·재생 CTA로 한정.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **미정의 CSS 변수 4종**(`--accent-red`, `--eureka-azure`, `--bg-panel`, `--text-dim/--neon-cyan`)이 조용히 스타일을 죽이고 있었다(패닉 경고 무색, 스크롤바 투명 등). 기존 리터럴 값을 변수로 승격해 복구. *교훈: 변수 참조 추가 시 :root 정의 여부를 반드시 교차 확인.*
2. **`.glass-card`의 다크테마 잔재 테두리**(`rgba(255,255,255,0.08)`)가 캐스케이드에서 `.panel` 실버 테두리를 덮어써 모든 패널이 무테였다.
3. **flex-basis 0%에서는 `flex-wrap`이 영영 발동하지 않는다.** 탭 오버플로 수정 시 `flex: 1` → `flex: 1 1 auto` + 컨테이너 `min-width: 0` 필요.
4. **`display: grid` 리스트에 `grid-template-columns`가 없으면 트랙이 max-content로 늘어난다.** 긴 곡명이 대기열 행을 옆으로 밀어 모바일에서 버튼이 화면 밖으로 나감 → `minmax(0, 1fr)` 명시.
5. **스크롤 컨테이너의 위쪽 padding 영역에는 스크롤 지나가는 콘텐츠가 비쳐 보인다.** sticky 제목 위로 영상 프리뷰가 비침 → 패널 `padding-top: 0` + sticky 제목이 간격을 불투명하게 대체.
6. **Chrome headless `--screenshot`은 원인 불명의 스테일 렌더를 반환할 수 있다.** 같은 빌드를 playwright-core(설치된 Chrome 채널)로 열자 DOM 실측과 스크린샷이 일치. 시각 검증은 playwright 경유를 권장.
7. 검증 중 발견한 기존 결함 수정: `.btn-secondary` 스타일 부재(기본 버튼 렌더), `.btn-icon-danger` 95px 고정폭(아이콘 버튼 비대), 히스토리 행 액션 세로 쌓임(~90px 행).

### 검증
- `npm run lint` / `npm run build` 통과 (경고는 기존 JS 경고 6건 그대로).
- vite preview + playwright-core로 6개 뷰포트 × 대기열 12곡/2단계/온보딩 상태 실렌더 확인.

## v0.0.6 — External failure resilience

- Audited 120 external-failure and damaged-input scenarios across widget sync, YouTube, local audio, and persisted/external state.
- Media end and error callbacks now carry the expected song ID, so a late callback cannot skip a newer song after the streamer has already recovered manually.
- YouTube player errors and local audio decode/read failures now explain the reason, skip only the failed song, and leave the rest of the queue intact.
- YouTube buffering and local audio waiting show one non-blocking delay notice instead of guessing that playback has failed.
- Search requests now time out after 12 seconds, validate the response shape, and point the streamer to direct YouTube URL input as the fast fallback.
- Persisted state is normalized before use; invalid records are dropped and local Blob songs are intentionally not restored after a reload because they are no longer playable.

## v0.0.5 — Streamer-first recovery controls

- Re-ran the product review as a 30-question practical karaoke-stream audit, prioritizing uninterrupted song flow and recovery from on-air mistakes.
- Queue removal now offers a five-second **Undo** action and restores the song at its former position without overwriting later queue changes.
- The panic confirmation now explicitly says it stops both the current song and the entire queue, and confirms completion after execution.
- Deliberately did not add an OBS “connected” badge: the current transport has no authenticated widget acknowledgement, so showing one would mislead a streamer during a live broadcast.
- Static GitHub Pages remains limited to UI-only operation; AI extraction and cross-device sync require their server endpoints.

## 2026-07-15 — v0.0.4 UX Audit Phase 03: 다중 관점

### 감사 방식

`docs/ux-audits/PHASE_03_MULTIPERSPECTIVE_AUDIT.md`에 초심자·노래 스트리머·UI/UX 디자이너·버튜버 유레카 팬 관점으로 각각 30문항, 총 120문항을 기록했다. 한 관점의 장식적 선호보다 네 관점에서 공통으로 위험한 항목만 구현 대상으로 삼았다.

### 공통 개선

- **로고 장식:** 기존 문자형 `✖✖` 헤어핀은 오류 기호처럼 보이고 화면 낭독 결과에도 섞였다. 금발·은색 핀을 CSS 도형으로 바꿔 유레카 모티브는 유지하면서 로고는 `Rekasong`만 읽히게 했다.
- **상태 알림:** 토스트 컨테이너에 `role="status"`, `aria-live="polite"`를 적용해 곡 선택·취소·복사 같은 암묵적 변화가 보조기기 사용자에게도 전달되게 했다.

### 관점 간 합의와 다음 회차

- 초심자와 UI/UX 디자이너는 첫 실행 시 유튜브 검색을 최우선으로 요구했고, 스트리머는 재방문 시 마지막 작업 탭 복원을 원했다. 이 충돌은 첫 실행 여부를 명시적으로 기록하는 정책으로 다음 회차에서 설계한다.
- 스트리머·디자이너 공통으로 동기화 연결 상태, 대기열 삭제 Undo, 긴급 정지 영향 설명이 남았다. 팬 관점의 추가 장식보다 방송 신뢰성 개선을 우선한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 브라우저 화면에서 로고 문자 장식 제거, 상태 영역 노출, 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.3 UX Audit Phase 02: 방송 제어·복구

### 감사 방식

`docs/ux-audits/PHASE_02_CONTROL_AND_RECOVERY.md`에 방송 중 조작·실수 방지·고급 옵션 노출을 확인하는 30개 질문을 기록했다. 핵심은 한 번의 실수가 OBS 화면이나 대기열을 예측 불가능하게 만들지 않는 것이다.

### Before → After

- **Before:** 자동 다음 곡 체크박스가 대기열 제목 옆에 항상 노출돼, 기본 흐름에서 별도의 판단을 요구했다.
  **After:** `재생 옵션`으로 접고, 현재 켜짐/꺼짐과 실제 동작을 함께 설명한다.
- **Before:** 위젯 주소 복사는 브라우저 alert만 띄웠고, 권한 거부 시 실패 원인이 드러나지 않았다.
  **After:** Clipboard API와 호환 복사 경로를 순서대로 시도하고, 결과를 앱 토스트로 안내한다.
- **Before:** 재생 전의 라이브 패널은 빈 상태만 보였다.
  **After:** 1단계 검색과 2단계 확인으로 이어지는 다음 행동을 안내한다.

### 리스크와 다음 회차

- 복사 실패 시 수동 복사 안내까지는 제공하지만, 브라우저·OBS 임베디드 환경마다 클립보드 권한이 달라 실제 OBS 환경 검증이 필요하다.
- 브라우저가 마지막으로 보던 노래책 탭을 복원하는 동작을 확인했다. 재방문자 편의와 첫 사용자 기본 흐름을 구분하는 정책을 다음 UX 감사에서 결정한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 방송 제어 초기 화면 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.2 UX Audit Phase 01: 초심자 핵심 흐름

### 감사 방식

`docs/ux-audits/PHASE_01_BEGINNER_FLOW.md`에 30개 질문을 기록하고, 첫 사용자가 곡을 찾아 방송에 표시하기까지의 흐름만 우선 판정했다. 장식·새 기능보다 단계 인지와 상태 피드백을 먼저 고쳤다.

### Before → After

- **Before:** 검색 패널은 탭으로 바로 시작해 1단계라는 사실이 드러나지 않았고, `실시간 송출 관리`는 행동보다 기술 용어에 가까웠다.
  **After:** `1 노래 찾기 → 2 곡 정보 확인 → 3 방송 제어`로 단계 이름을 통일했다.
- **Before:** 새 곡 선택과 스테이징 취소는 화면 상태만 바뀌어 사용자가 이전 선택·AI 분석의 처리 결과를 추측해야 했다.
  **After:** 곡 선택·로컬 파일 추가·취소 시 토스트를 표시하고, 취소는 진행 중 AI 요청도 함께 중단한다.

### 리스크와 다음 회차

- 마지막으로 보던 노래책 탭을 복원하는 동작은 재방문자에게 편리하지만, 데모 노래책이 처음 보이는 상황은 초심자 흐름을 흐릴 수 있다. 첫 실행과 재방문을 구분하는 정책을 Phase 02에서 검토한다.
- 동기화 연결 상태 표시와 대기열 삭제 Undo는 아직 구현하지 않았다. 기능을 늘리기 전에 30문항 감사에서 방송 중 사고 예방 효과를 다시 판정한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 초기 화면에서 1단계·3단계 문구 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.1 방송 안전성 및 핵심 흐름 정비

### 사용자 시나리오

초심자 스트리머가 **검색 → 정보 확인 → 재생/OBS 표시**를 한 흐름으로 끝낸다. 곡을 바꾸거나 AI 분석이 늦어져도 사용자가 직접 입력한 정보와 현재 재생은 예기치 않게 바뀌지 않아야 한다.

### 반영 내용

- Gemini 제목 추출을 `gemini-3.5-flash` Interactions API 공통 모듈로 전환했다.
- `useAiTitleExtraction` 훅으로 AI 스트림·취소·시간 초과를 분리했다. 새 곡을 선택하거나 스테이징을 비우면 이전 요청을 취소하고, 사용자가 수정한 제목은 AI가 덮어쓰지 않는다.
- OBS 위젯 동기화를 방별 채널·저장 키로 분리하고, 늦게 열린 위젯도 마지막 상태를 복원하도록 했다. 로컬 개발용 `/api/sync`와 Cloudflare Functions용 엔드포인트를 추가했다.
- 자동 다음 곡의 UI·실행 조건을 동기화 상태 `autoPlayNext` 하나로 통일했다.
- 노래책의 `MR 찾기`는 실제 유튜브 검색을 실행하도록 수정했고, 유튜브 URL·영상 ID와 로컬 파일 전체 드롭 영역을 처리한다.
- Setlink·Meloming은 아직 실제 API가 없는 목업이므로, 실제 연동처럼 보이지 않게 데모 모드임을 화면에 표시했다.

### 호환성 및 남은 제약

- 기존 OBS 위젯 URL과 상태 데이터 형식은 유지한다. 이 패치는 하위 호환성을 깨지 않는 `0.0.1` 패치다.
- GitHub Pages 같은 정적 호스팅에서는 Cloudflare Functions와 로컬 `/api/sync`가 제공되지 않는다. 정적 배포 시에는 동일 브라우저 동기화만 가능하며, 원격 OBS 동기화에는 Cloudflare Pages 배포 또는 별도 릴레이가 필요하다.
- Setlink·Meloming 실제 연동은 각 서비스의 공식 API 명세와 인증 방식이 확보된 뒤 구현한다. 데모 데이터를 실제 신청곡으로 취급해서는 안 된다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 로컬 앱 화면 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15
**1. UI/UX 및 폴더 구조 전면 개편 (Rettostock 표준 적용)**
- **문제 인식**: 기존 레카송 프로젝트의 파일(`Dashboard.jsx` 등)이 너무 비대하고, 뷰/로직/컴포넌트 구분이 명확하지 않았음.
- **해결 방안**: 인접 프로젝트인 `Rettostock`의 모범 사례(Best Practice)를 벤치마킹하여 `src/pages`, `src/components`, `src/hooks` 구조로 분리.
- **결과**: `Dashboard.jsx`와 `Widget.jsx`를 `pages`로 이동하고, 대시보드를 3단 패널(`SearchPanel`, `StagingPanel`, `LivePanel`)로 나누어 모듈화함. Glassmorphism 디자인 적용.

**2. 유튜브 API 자체 내장 및 이중 재생 문제 해결**
- **문제 인식**: 기존에는 사용자가 유튜브 탭을 따로 띄우고 URL을 복사해와야 했으며, 이로 인해 대시보드 리모컨과 유튜브 원본 탭 양쪽에서 소리가 중복 송출되는(에코 현상) 치명적인 UX 결함이 발생.
- **해결 방안**: 
  - `functions/api/search.js` 백엔드 라우트 생성 (Cloudflare Pages Functions 활용). 
  - 외부 API 없이 유튜브 검색 결과(`ytInitialData`)를 크롤링하여 `MR, TJ, 금영` 키워드를 자동으로 덧붙여 반주 영상을 최우선으로 검색하도록 구현.
  - 대시보드 안에서 바로 검색하고 추가함으로써 외부 탭의 중복 재생 원천 차단.

**3. 트러블슈팅: White Screen 에러 및 포트 혼동 문제**
- **이슈 1 (포트 번호 혼선)**: `vite` 기본 포트인 5173으로 안내했으나, 옆동네 프로젝트(Rettostock)가 5173을 선점한 상태였음. 또한 `wrangler pages dev` 명령을 통해 실행했기 때문에 실제 Cloudflare 런타임은 `8788` 포트에서 작동 중이었음. 
- **해결 1**: 사용자가 `http://localhost:8788`로 접속하도록 정정.
- **이슈 2 (White Screen of Death)**: `Dashboard.jsx` 내 `useEffect`에서 `publishSync(room, signingKeys, state).catch(console.error);`를 호출하여 빈 화면 에러 발생. `publishSync`가 반환값 없는(비동기가 아닌) 일반 함수였으며, 매개변수 순서(payload가 첫 번째)와 형식이 맞지 않았음.
- **해결 2**: `const payload = { state, timestamp: Date.now() }; publishSync(payload, room, signingKeys.privateKey);`로 올바른 매개변수 구조를 통과시켜 에러 수정 완료.

---

## TODO / Next Steps (Claude 인계용)
앞으로 진행해야 할 주요 과제 및 발전 방향입니다.

**1. 대기열(Queue) 시스템 및 자동 재생 도입**
- **현황**: 현재는 사전 검토(Staging) 영역에서 `[방송 송출]`을 누르면 바로 `activeVideoId`를 덮어쓰고 재생하며, 내역은 `history`로만 쌓임.
- **목표**: 
  - 방송용 대시보드인 만큼 여러 곡을 예약해 둘 수 있는 **대기열(Queue) 시스템** 구현.
  - 리스트의 현재 곡이 끝나면(YouTube `onEnd` 이벤트 등 활용) 다음 곡으로 자동 런다운되는 로직 필요.

**2. 멜로밍(Meloming) 서비스 연동**
- **목표**: 앞서 논의되었던 멜로밍 플랫폼과의 시너지 창출 방안 구체화.
- **예상 작업**: 멜로밍에서 신청받은 노래 목록을 레카송의 대기열(Queue)로 직접 Import 하거나, 레카송에서 부른 셋리스트를 멜로밍으로 내보내는(Export) API 연동 기획 및 구현.

**3. 로컬 파일 송출 안정화 및 위젯 연동**
- **현황**: 로컬 MP3 파일은 현재 대시보드(Dashboard.jsx)의 `<audio>` 태그로 재생됨.
- **과제**: 로컬 파일 재생 시 위젯(OBS 화면)에도 현재 재생 중인 곡의 메타데이터(곡명 등)가 올바르게 전송되고 표시되는지 세밀한 테스트 필요.

**4. UI 디테일 및 피드백 강화**
- 3단 패널(Search, Staging, Live) 간의 상호작용(예: 버튼 클릭 시 애니메이션, 성공 토스트 알림 등) 추가로 조작 직관성 향상.

## 2026-07-17
**이전 재생 곡(setlist) 편집 기능 — history 재정렬·표시 전용(수동) 항목 직접 추가**
- **배경**: history(완료 QueueEntry)는 OBS 위젯 setlist로 송출되지만 편집 불가였음. 잘못 올라간 곡의 순서 교정·수기 추가가 필요.
- **스키마 (`src/lib/queueEntry.js`)**:
  - `song.manual: true` 마커 도입 — setlist 표기 전용, 재생 src 없음. `sanitizeSongDef`가 화이트리스트에 보존.
  - `isManualSongDef` 추가, `createManualEntry(title, artist)` 헬퍼(phase `completed`, `source:'manual'`, src `''`).
  - `toQueueEntry`: 재생 불가 항목이라도 **manual + phase completed** 조합만 보존. 대기열·현재 곡 위치로 흘러들면 정규화 단계에서 구조적으로 폐기(재생 불가 유령 방지). manual 아닌 src-less 항목은 기존대로 폐기.
- **UI (`src/components/QueuePanel.jsx`, CSS 파일 무변경 — 기존 클래스 재사용)**:
  - history 아코디언에 직접 추가 폼(제목 필수 + 가수 선택, `glass-input`/`queue-play-action` 재사용, 레이아웃만 인라인 flex).
  - history 항목 드래그 재정렬 — queue의 D-21 방식(entryId 식별, 드롭 시점 재계산) 그대로 이식. 드래그 하이라이트는 기존 `.queue-item.draggable.drag-over` 클래스 조건부 부여로 해결.
  - dataTransfer 타입 가드(`queueentryid`/`historyentryid`)로 대기열↔이력 교차 드롭·외부 드래그 오작동 차단.
  - manual 항목은 '다시 부르기' 버튼 disabled + 툴팁 안내(재생 정보 없음). 실제 완료 곡의 다시 부르기·삭제는 기존 동작 유지.
- **하위 호환**: 저장된 v1/v2 상태는 기존 경로 그대로 통과(회귀 없음). manual 항목은 새 스키마 확장이라 구버전 데이터에 영향 없음. 위젯은 `toLegacySong` 평면 투영의 title만 소비하므로 무수정 호환.
- **검증**: vite build·oxlint 통과. playwright-core 실렌더 12/12 통과(추가·저장·재정렬·교차 드롭 가드·삭제·새로고침 보존·requeue 활성/비활성 구분) + dev 서버 `/api/sync` 경유 위젯 setlist에 수동 항목 제목 표시 확인.

## 2026-07-17 (2)
**생애주기 Stage 5 — 위젯 projection 축소(N-08) + isPlaying/phase 발행(D-18) + history 상한(D-29) + 직접모드 위젯 URL 복원(N-01)**
- **N-08 프라이버시 (핵심)**: `Dashboard.jsx`가 원격 발행 시 `state` 전체(setlinkCatalog·youtubePlaylistCatalog·songbookMrCache·melomingChannelId·**시청자 비공개 설계인 queue**)를 공개 ntfy 토픽(`rekasong-{room}`)에 서명-평문으로 올리던 것을, 위젯이 실제 표시하는 필드만 담은 축소 projection `{ currentSong{id,title,artist,type,src(youtube만),tags,source,phase,completionReason}, history[≤50], isPlaying }`으로 교체. `toWidgetSong` 화이트리스트 팩토리로 구성 — 발행 경로 4곳(BroadcastChannel/localStorage/dev `/api/sync`/ntfy) 전부 `publishSync` 하나를 지나므로 일괄 축소.
  - 로컬 곡 src(blob:/세션 자산 id)는 발행하지 않음(`src:''`) — 위젯에서 재생 불가·정보 노출만 됨.
  - `legacyQueue` 평면 투영 제거(발행 전용이었음). 로컬 UI(QueuePanel)는 `state.queue` 그대로 사용.
- **D-18 잔존**: `isPlaying`과 `currentSong.phase`를 payload에 포함. `Widget.jsx`가 phase 우선(§5-1 상태 추측 금지)으로 `일시정지/스킵 중…/취소 중…/재생 시작 중…/버퍼링…/재생 실패` 배지를 기존 출처 배지(Meloming/Setlink)와 같은 인라인 최소 텍스트 형식으로 표시. phase·isPlaying 둘 다 없는 구버전 payload에서는 배지 미표시.
- **D-29/D-14**: 발행 history를 최근 50곡으로 cap(`WIDGET_HISTORY_LIMIT`). state 자체 cap은 미도입(발행 cap만으로 payload 비대 해소).
- **N-01**: PlaybackPanel이 미사용으로 받던 `room/publicKeyB64` props를 배선. On-Air `unconfigured`(직접 재생 모드)일 때 OBS 설정 다이얼로그의 '화면 정보 위젯' 단계가 disabled 버튼 대신 `#/widget?room=…&key=…` 주소 복사 버튼(`btn-copy` 재사용)을 노출. 구버전 room&key 위젯 URL 형식과 동일.
- **범위 외로 명시 이월**: D-12(늦게 연 위젯 빈 화면 — ntfy `since=`/접속 스냅숏)는 코드 주석으로 후속 표기. 코디네이터 상태기계·재생 로직·On-Air display 프로토콜(`toDisplayState`) 무변경.
- **하위 호환**: 구버전 위젯이 소비하는 평면 필드 계약(id=entryId, title/type/src/source/tags) 유지 — 축소 payload로도 현재곡·setlist 표시 지속. 큐 표시는 원래 설계상 비공개라 지원 범위 밖임을 명확화.
- **검증**: vite build·oxlint 통과(신규 경고 0). playwright-core + dev `/api/sync` 실렌더 22/22 통과 — payload 키가 {currentSong,history,isPlaying}뿐(카탈로그·큐·채널ID·MR캐시·blob: 부재를 발행 JSON 문자열 검사로 확인), history 50 cap·completionReason 포함, 위젯 현재곡/수동 항목/완료 이력 표시, 일시정지 시 payload(phase=paused)와 위젯 배지 반영, 직접모드 복사 버튼 활성·복사 URL로 위젯 구동.

## 2026-07-17 (3)
**생애주기 Stage 6 — 방송 출력에서 YouTube iframe 제거(전면 fail-safe)**
- **불변식 확정**: 방송 출력(직접모드·On-Air 모두)은 광고가 나올 수 있는 어떤 경로(iframe/YouTube 플레이어)도 절대 쓰지 않는다. **광고 없는 오디오가 확정되기 전엔 재생하지 않는다.** 근거: 방송 중 통제 불가 광고는 완전한 실패이고, 재생이 안 되는 편이 낫다(사용자 결정 "전면 fail-safe"). 프록시 실패 시 iframe 폴백을 두려던 초안은 **폐기** — 폴백이 존재하는 순간 불변식이 무너진다.
- `src/lib/audioProxy.js` 신설, `Dashboard.jsx`에서 `react-youtube` 의존 제거. 숨김 라이브 플레이어를 프록시 `<audio>`로 교체. 실패는 항상 `failed`(무음), 12초 시작 타임아웃 포함.
- `getYoutubeOutputSafety()`의 `'unknown'` 고정 해소 → 프록시면 `'safe'`, 아니면 `'blocked'`. 광고 여부 미상으로 재생하는 경로가 소멸.
- 재생 엔진이 `<audio>` 하나로 통일되어 YouTube 곡도 로컬과 같은 규범 스킵 경로(finishing→ended→completed)를 쓴다. iframe이라서 폴백하던 사유(§4-3 "길이를 모르면 완료 처리하지 않음") 소멸.
- StagingPanel의 iframe은 사적 미리듣기(autoplay 0) 전용으로 존치 — 방송 출력과 연결되지 않는다.
- **미해결로 남은 위험(중요)**: 운영 환경은 `.env.production`의 `VITE_ON_AIR_BASE_URL` 때문에 항상 On-Air 모드라 OBS 위젯(`OnAirPlayer.jsx`)이 플레이어를 호스팅한다. Stage 6은 직접 재생 경로만 고쳤으므로 **운영 방송에는 여전히 iframe 광고가 나간다.** Stage 6b가 완결 지점.

## 2026-07-17 (4)
**설계 전환 — 스트리밍 프록시에서 곡 준비(prepare) 파이프라인으로 (`docs/PREPARE_PIPELINE.md`)**
- **발단**: 사용자 제안 — "대기열/재생으로 넘기는 과정에서 yt-dlp로 파일을 일시적으로 받아 재생하면 안 되나?"
- **검토 결과**: 광고 차단 성능은 **동일하다**(둘 다 같은 yt-dlp/googlevideo 스트림, 광고는 플레이어 주입). 이득은 광고가 아니라 **실패 시점**이다.
  - 기존(URL 캐시 5h + 실시간 바이트 중계): yt-dlp의 모든 불확실성(봇월·URL 만료·스로틀)이 **곡이 방송에 나가는 순간** 판가름 → 곡 중간 끊김·라이브 실패 가능. 현행 fail-safe는 "광고 대신 무음"이지만 **여전히 방송 중에** 실패한다.
  - 준비 방식: 그 실패를 **전부 대기열 이전으로** 이동. 재생 시점엔 완성된 바이트만 서빙 → googlevideo 의존 0, 중간 끊김 물리적 불가, 탐색 즉시 정확.
  - `preparing→ready`가 **증거 기반**이 됨(설정 플래그 → 실제 존재하는 바이트). INV-6의 정신.
- **부수 효과(큼)**: VPS가 작업을 *폴링*하므로 **Cloudflare Tunnel 불필요** — HANDOFF 숙제 2개 중 1개 소멸(쿠키만 남음). 재생이 R2/엣지라 **VPS가 방송 경로에서 이탈**(방송 중 VPS 장애 무관).
- **함정 발견**: 기존 R2 자산 경로는 **세션 종속**(`assetKey(room, assetId)`)이고 `deleteAssets()`가 세션 종료 시 전부 삭제한다(로컬 파일용으론 올바름). 준비 캐시를 여기 넣으면 **방송마다 캐시가 날아가 봇월로 되돌아간다.** → `audio/{videoId}` **영구·전역 네임스페이스**로 분리. `session.assets`에 절대 넣지 말 것.
- **쿠키 판단 보류(계측 우선)**: 봇월은 요청량/패턴에 걸린다. R2 영구 캐시는 요청량을 **고유 영상당 평생 1회**로 줄이고, 노래방은 곡이 반복되므로 레퍼토리가 쌓일수록 0에 수렴한다. 따라서 쿠키가 애초에 불필요할 가능성이 높다. `failureKind:'botwall'` 비율을 `/v1/prepare/stats`로 계측한 뒤에만 투입한다(쿠키는 만료·밴 위험·집IP↔데이터센터IP 동시 사용이라는 의심 신호를 동반하는 부서지기 쉬운 의존성 — 필요 증명 전 투입은 순서가 거꾸로다).
- **탈출구**: 폴링 구조라 준비 워커가 **위치 독립적**이다. 사용자 PC(가정용 IP)에서 같은 코드를 돌리면 봇월·쿠키 문제 자체가 존재하지 않는다. VPS와 공존 가능(claim이 원자적).
- **하위 호환(의도된 단절)**: 준비 파이프라인 도입 시 `VITE_AUDIO_PROXY_BASE_URL` 스트리밍 경로는 **제거**한다. 두 경로 병존은 "준비 안 된 곡이 스트리밍으로 새어나가는" 우회로가 되어 불변식을 깬다. 준비되지 않은 YouTube 곡의 재생은 지원 범위 밖.

## 2026-07-17 (5) — v0.1.0
**Stage 6b+6c — 준비 게이팅 + On-Air 위젯 iframe 제거 (광고 제거 완결)**
- **★ 완결 지점**: `OnAirPlayer.jsx`에서 `react-youtube`를 삭제하고 `/v1/audio/{videoId}` `<audio>`로 교체. 운영 환경은 `.env.production`의 `VITE_ON_AIR_BASE_URL` 때문에 항상 On-Air 모드라 **Stage 6까지는 운영 방송에 여전히 iframe 광고가 나가고 있었다.** 이제 `react-youtube`는 `StagingPanel.jsx`(사적 미리듣기, `autoplay: 0`, 방송 출력과 미연결) 한 곳에만 남는다 — **방송 경로에 광고 가능 경로가 존재하지 않는다.**
- **단일 관문**: `beginPlaybackRun`이 `if (useOnAirPlayer)` 분기보다 **앞에서** `ready`가 아닌 YouTube run 생성을 차단한다 — 모드 불문. 자동 다음 곡·스킵·바로 재생·재시도 전 경로가 이 하나를 지나므로 우회로가 없다. 폴백은 어떤 조건에서도 없다(실패 = 무음).
- `getYoutubeOutputSafety(entry)`가 **곡별 증거 기반**으로 전환(`ready`→safe, 그 외 blocked). 설정 플래그 판정 폐기 — INV-6의 정신.
- `src/lib/preparePipeline.js` 신설, `audioProxy.js` 삭제. 베이스 URL은 `VITE_ON_AIR_BASE_URL` 재사용(새 env 없음). `songPrepareState()`가 소스 불문 단일 판정 지점 — 로컬 파일은 항상 ready. 알 수 없는 응답이 ready로 오인되지 않게 화이트리스트 정규화(fail-safe).
- **UX**: 대기열 준비 배지(ready는 조용한 딥그린 `--chr-vest` — 상시 표시라 네온 금지, 실패 계열만 `--accent-red`로 도드라짐 → **실패가 방송 전에 눈에 띄는 것이 이 설계의 존재 이유**). 실패 행은 '바로 재생' 슬롯을 '다시 시도'(`force:true`)로 교체 — 버튼 슬롯 재사용이라 행 폭·뷰포트 불변, `unavailable`의 유일한 부활 경로. 준비 중 즉시 재생은 에러로 튕기지 않고 **대기열 예약으로 전환**하되 라벨이 먼저 바뀌고 토스트가 확인한다(암묵 변경 방지).
- **경계에서 잡은 결함 3건** (에이전트 산출물을 그대로 받지 않고 교차 검증해서 발견):
  1. `POST /v1/prepare` 무인증 → 아무나 임의 videoId를 큐잉하면 YouTube 요청량이 폭증해 **설계가 피하려던 봇월을 그대로 부른다**(§0/§6 전제 붕괴). `/v1/audio`와 동일한 room+playerToken 게이트로 폐쇄. 원칙: **재생할 수 없으면 큐잉도 할 수 없다.** `ensureSession()`이 스테이징 시점에 토큰을 내주므로 흐름은 안 막힌다.
  2. `unavailable` 영구 실패에 **탈출구 없음** → 비공개→공개 전환 영상·오분류가 실재하는데 되살릴 방법이 없었다. `force: true` 수동 재시도 추가. **자동은 보수적(봇월 회피), 수동은 항상 가능(사용자 통제)**로 분리. force는 `attempts`도 초기화(누적 백오프를 물려받으면 수동 재시도의 의미가 반감).
  3. VPS 워커의 `unavailable` 조기 중단 최적화 → YouTube는 **클라이언트별 접근 가능성이 갈린다**(그래서 `_CLIENT_ATTEMPTS`가 여럿). `unavailable`은 자동 재시도가 없어 오분류 비용이 영구적이다. 계약 §4대로 전 클라이언트 시도 후 확정으로 철회 + 회귀 테스트 고정. **아끼는 건 몇 초, 잃는 건 곡이다.**
- **하위 호환(의도된 단절, 그래서 0.0.6 → 0.1.0)**: `VITE_AUDIO_PROXY_BASE_URL` 스트리밍 경로 제거(병존 시 준비 안 된 곡이 새어나가는 우회로가 된다 — 계약 §7). **세션 없는 직접 재생 모드의 YouTube 재생은 지원하지 않는다** — `<audio src>`는 헤더를 못 붙여 PREPARE_TOKEN 우회로를 열면 쿼리스트링으로 VPS 토큰이 샌다. 운영은 항상 On-Air라 실사용 영향 없음. 로컬 파일·대기열·이력·On-Air 세션 프로토콜은 무변경.
- **검증**: vite build·oxlint 통과(신규 경고 0). Worker(`f33a70b`)와 프론트(`971f5f7`) 교차 검증 — 게이트·`force` body·`publicJob` 응답 형태 일치. 그 과정에서 발견한 absent 고착 엣지는 `67d06c8`로 해소. 브라우저 런타임 검증은 playwright 부재로 미실시(정적 시나리오 검토로 대체) — **실배포 후 실측 필요.**

## 2026-07-18 — v0.1.1
**On-Air↔OBS 연결 진실성(presence) + OBS 설정 안내 UX (`docs/ONAIR_CONNECTION.md`)**
- **문제(실측)**: PlaybackPanel의 "OBS 플레이어 연결됨" 칩이 `onAir.connectionState`(대시보드 자신의 control 소켓)에 근거 — **OBS 위젯을 열지 않아도 초록불이 켜졌고**, 재생 게이트도 control만 확인해 위젯 0개 상태에서 load가 허공으로 나갔다.
- **Worker**: `openSocket` 스냅숏에 `presence:{player,display}` 추가(`ctx.getWebSockets()` attachment role 런타임 집계 — **DO 스토리지 스키마 불변, 마이그레이션 없음**). display 연결/해제도 control로 브로드캐스트(player와 대칭). `webSocketClose`는 같은 역할의 **다른 소켓이 남아 있으면 connected:true**를 보낸다(위젯 새로고침 시 새/구 소켓 겹침 → 거짓 false 방지). `hasConnectedPlayer(excluded)`로 닫히는 소켓을 명시 제외.
- **프론트**: `useOnAirSession`이 `playerConnected/displayConnected` 반환(스냅숏 초기화 + presence 이벤트 갱신). control 소켓이 **비의도적으로** 끊기면 presence를 false로 리셋(관측 불가=미확인, 재접속 스냅숏이 즉시 복원) — 의도된 소켓 교체(세션 업그레이드)는 리셋하지 않아 칩 깜빡임 없음.
- **재생 게이트 이동**: `beginPlaybackRun`에 위젯 presence 게이트(모든 시작 경로 공통: 즉시 재생·대기열 바로 재생·재시도·자동 다음 곡). `handleGoLive` 상단의 control 게이트는 **제거** — 이 함수는 '대기열에 추가'도 담당하므로 OBS를 아직 안 연 상태의 setlist 예약을 막으면 안 된다(송출만 막는다).
- **트러블슈팅 — 고아 세션 레이스(라이브 검증으로 발견)**: `ensureSession()`이 state 클로저 기반이라 스테이징 자동 준비(prepare 폴링)와 '주소 복사'가 겹치면 **세션이 2개** 만들어졌다 → 위젯은 세션 A, 대시보드는 세션 B에 붙어 "주소를 넣었는데 초록불이 안 켜짐" + 명령 허공 송출. `sessionRef` + in-flight 프라미스 합류로 단일화. 헤드리스 검증이 아니었으면 실방송에서야 발견됐을 결함.
- **UX**: 설정 다이얼로그 칩을 실제 presence 기반으로 — 미연결=회색 점 "OBS에 주소를 넣으면 여기 초록불이 켜집니다" / 연결=✓ 초록(`--chr-vest`, 성공 상태에만 절제). display 단계에도 동일 칩 신설. 대시보드↔서버(control) 상태는 무채색 한 줄(`obs-server-note`)로 **위젯 연결과 시각 구분**. 초심자 흐름: 소스 2개·순서 번호·'로컬 파일' 체크 해제 경고·화면 정보=무음(1920×1080)·플레이어=오디오 믹서에 이 소스만. **넣는 즉시 칩이 초록으로 바뀌는 것이 행동이 먹혔다는 즉각 피드백.** 직접 재생 모드(N-01) room&key 흐름 무변경.
- **검증(라이브 16/16)**: 배포 Worker + production preview + 헤드리스 위젯/대시보드. (a) 위젯 전 presence false (b) 위젯 연결→presence true 전이 (c) **위젯 선연결+control 재연결→스냅숏만으로 즉시 true** (d) 위젯 종료→false 전이 (e) player 미연결 즉시 재생→토스트 차단·재생 미진입. 추가: display presence 대칭, 다이얼로그 칩 회색→초록 실전이, 위젯 연결 후 같은 버튼으로 실재생(과차단 없음), 위젯 실제 오디오 진행. vite build·oxlint 신규 경고 0.
- **하위 호환**: 구 Worker 스냅숏(presence 없음)은 안전하게 false로 강등, 구 프론트는 새 presence 메시지를 무시 — 어느 방향 배포 순서든 안전. 스토리지·relay/transport 의미 불변.

## 2026-07-18 (2) — DO 쓰기 한도 소진 확인 + 최적화 병합 (Antigravity f461686)

**실측 확정: Cloudflare Durable Objects 무료 티어 쓰기 한도 초과.**
- Worker 예외: `Exceeded allowed rows written in Durable Objects free tier.` (index.js fetch)
- 증상: DO를 쓰는 모든 엔드포인트가 500(`/v1/sessions`·`/v1/prepare/stats`). `/v1/audio`(401)·404는 정상.
- 원인: `handlePlayerEvent`가 **position 이벤트(초당 1회)마다 `storage.put`** → 2시간 방송 세션당 ~7200 쓰기. 이번 세션의 다수 재생 테스트가 오늘치 무료 한도를 소진.
- **Antigravity(Gemini)가 자기 세션에서 이 문제를 진단하고 `f461686`로 선제 수정.** 본 커밋은 그 수정을 현재(presence 반영) Worker에 병합한 것.

**병합 내용 (f461686 → 현재 Worker):**
- `this.sessionState` 인메모리 세션 캐시(DO 단일 스레드라 경합 없음).
- `handlePlayerEvent`: `event.type !== 'position'` 일 때만 `storage.put` — 순수 진행도는 영속 안 함(브로드캐스트는 유지, 캐시에는 반영, 다음 상태변경에서 함께 영속).
- `webSocketClose`: 플레이어(위젯) 전원 끊김 시 재생 중 상태를 `paused`로 내려 대시보드 반영(presence 로직과 병합).
- presence 스냅숏/브로드캐스트(내 작업)와 충돌 없음.

**복구·후속:**
- 무료 티어 DO 쓰기 한도는 **매일(UTC) 리셋** → 자동 복구. 현재는 소진 상태라 On-Air/prepare 500.
- 최적화 후 실사용은 곡당 상태변경 몇 회(로드/재생/일시정지/종료)만 쓰므로 한도 근처도 안 간다. 테스트가 소진의 주범이었음.
- 다중 스트리머·완전한 안정성이 필요하면 **Workers Paid($5/월)** 로 무료 티어 한도 자체를 제거하는 것이 근본책(사용자 결정).
## 2026-07-20 (Codex) — speaker/OBS 안전 정책 경계 분리

- 스피커는 음악 감상용 일반 플레이어로 취급하고, 모바일 창 전환·PiP·백그라운드 heartbeat 지연만으로 로컬 오디오를 emergency stop/영구 unknown 잠금하지 않도록 `OnAirPlaybackAdapter` 안전 프로필을 분리했다.
- OBS 브라우저 소스는 기존 strict 프로필을 유지한다. sourceActive/sourceVisible 손실, 연결 중 authoritative event ambiguity, safety stop 실패는 기존 fail-closed 규칙을 그대로 적용한다.
- Worker는 dashboard-speaker에 한해 heartbeat throttling을 active output unknown으로 승격하지 않는다. 실제 소켓 단절과 route 전환의 inactive 증거 요구는 유지한다.
- unknown 스피커에서 같은 송출경로 버튼을 다시 누르면 deactivation을 먼저 시도해 inactive 증거를 만들고 재활성화할 수 있다. OBS로 자동 전환하거나 재생을 자동 재개하지 않는다.
- 회귀 테스트: adapter 55개, output controller 48개, Worker Protocol v2 106개 중 변경 시나리오 포함 전부 통과. 상세 설계와 수동 모바일/OBS 확인 항목은 `docs/SPEAKER_OBS_SAFETY_BOUNDARY_2026-07-20.md`에 기록했다.

## 2026-07-20 (Codex) — 스피커 복구 후보 대기 순서 보정

- 끊긴 dashboard-speaker lease가 `unknown`에서 `inactive`으로 정리되는 순간, 새 페이지 소유 플레이어가 아직 후보로 재등록되지 않았다는 이유로 출력 전환을 즉시 `candidate_count` 차단하던 순서 버그를 수정했다.
- 스피커 복구도 첫 연결과 동일하게 page-owned 후보 등록을 기다린 뒤 정확한 player identity가 확인되면 activate하도록 통일했다. OBS 경로의 엄격한 후보 검증은 변경하지 않았다.
- 회귀 테스트를 추가하고 로컬 브라우저에서 새로고침 후 `ready → 스피커 송출 중`, 설정 패널에서 `선택: 스피커 / 실제 활성: 스피커`를 확인했다.
- 이전 탭의 외부 스피커 후보가 하나 남아 있는 경우도 page-owned 후보가 돌아올 때까지 기다리도록 보완했다. 외부 후보를 임의로 활성화하지 않으며, 두 개 이상이면 기존처럼 차단한다.

## 2026-07-20 (Codex) — 송출 UI를 다음 행동 중심으로 보강

- 송출 헤더에 상태만 표시하지 않고 `다음 행동` 안내를 항상 함께 표시한다.
- 스피커/OBS 활성·연결 중·후보 없음·제어권 충돌·복구 필요 상태마다 사용자가 눌러야 할 버튼이나 확인할 위치를 한국어/영어 번역 키로 제공한다.
- 상태 계산과 행동 안내 키를 분리해 기존의 authoritative 상태 판정은 유지하고, 안내 문구만 독립적으로 번역·테스트할 수 있게 했다.
## 2026-07-21 (Codex) — Speaker heartbeat candidate eligibility

- Speaker players send heartbeats every 5 seconds so mobile/background/PiP playback is not forced to stop, but the Worker was excluding every stale heartbeat after 2 seconds. A live speaker socket therefore disappeared from `eligibleCandidates` even while its player was ready, causing route selection to fall back to “output route needs confirmation”.
- Speaker candidate eligibility now uses the live WebSocket and `sourceActive !== false`; OBS retains the strict 2-second heartbeat and runtime attestation gate. Added a regression test for a speaker candidate at the stale boundary.

## 2026-07-21 (Codex) — Output status bar and speaker-first dashboard layout

- Separated the current playback card from output status. The yellow area directly below the Rekasong header now carries the compact On-Air/output status and the settings gear, styled as a right-side hairpin accent.
- Moved Speaker/OBS route switching, authoritative route details, OBS audio check, recovery and session controls into the settings dialog. The playback card no longer carries route controls.
- A fresh web-player dashboard now queues Speaker as the default route once output control is ready, while an existing route or explicit user intent is preserved.

## 2026-07-21 (Codex) — Speaker route remains open with white hairpin controls

- Removed the full-width yellow output strip. `ON AIR`, the active output label, and settings now sit in one compact white hairpin-like control block at the right of the header.
- Speaker candidates may coexist without the OBS-style exact-one candidate gate. Speaker route readiness and playback continuity accept the page-owned player among multiple speaker candidates; OBS still requires exactly one eligible browser source.

## 2026-07-22 (Codex) — v0.2.0 local Speaker / strict OBS boundary

- **Speaker is no longer a Worker output route.** The dashboard now owns a hidden browser-local `PlaybackEngine` through `DashboardLocalSpeaker`. Prepared audio is still downloaded with the authenticated session, but play/pause/seek/volume/stop never depend on a WebSocket control lease, player candidate count, heartbeat, another tab, PiP, or BFCache state.
- Removed the dashboard's `DashboardSpeakerPlayerV2` mount, page-owned speaker identity, ownership `BroadcastChannel`, and candidate lifecycle. Multiple tabs/windows can each listen independently and create no speaker-player heartbeat traffic. The prior 2026-07-20/21 speaker-candidate recovery logic remains only as protocol backward compatibility, not the current dashboard path.
- Selecting Speaker with no server-routed output is immediate. When OBS is truly active, the controller performs a **deactivate-only** transition and never activates a replacement speaker candidate. Selecting OBS while a local song is active is refused with an explicit sync warning; changing routes mid-song cannot silently offset a singer from the backing track.
- Late Worker transport snapshots and player events are ignored for local runs. Unexpected session credential rotation waits until an already-buffered local track leaves the player, so server maintenance cannot relabel, pause, or detach local audio.
- OBS remains strict about exactly one eligible OBS browser source, runtime `sourceActive` proof for new activation, route activation/deactivation identity, and physical stop evidence. Ordinary control-socket loss and scene active/visible changes keep an established media graph alive; explicit stop/deactivate/emergency/terminal boundaries remain destructive.
- Production OBS heartbeat changed from 1 second to 10 seconds. The Durable Object treats heartbeat as half-open-socket fallback with warning/stale thresholds of 30/60 seconds; native socket close and OBS callbacks remain immediate. Idle heartbeat message volume drops 90%, while six missed beats are required before the fallback marks a still-open target stale.
- UI: removed the Rekasong subtitle; retained the compact white hairpin header; default status is Speaker; tabs are `YouTube 검색 → YouTube 목록 → Setlink → 멜로밍`; song/search copy areas are keyboard-accessible buttons with visible affordances; Meloming/songbook success text uses dark `--chr-vest` rather than neon emerald.
- Translation groundwork: every new/changed user-facing string in this slice uses semantic catalog keys with Korean and English entries. Existing full-screen migration remains tracked in `docs/I18N_IMPLEMENTATION_PLAN_2026-07-19.md`.
- Performance: local Speaker is a 1.62 KiB gzip lazy chunk; the main dashboard remains about 79.98 KiB gzip. The OBS static closure is 115,807 bytes gzip against a 133,120-byte budget.
- Verification: 564 automated tests pass; Worker heartbeat thresholds pass exact boundary/alarm/race tests; lint has no new application warnings; production build and OBS bundle budget pass. Local browser verification confirmed `스피커 송출 중`, no subtitle, the requested tab order, unlocked Speaker selection, and consistent local-speaker guidance in settings.

## 2026-07-22 (Codex) — v0.2.2 UI source grouping and formal locale packs (review candidate)

- Combined YouTube search and imported playlists into one top-level `YouTube` source. A compact inner switch keeps Search and Playlist available without making them look like unrelated providers; the top-level order is now YouTube → Setlink → Meloming.
- Songbook rows now expose an immediate busy state while resolving the linked backing track, then open the existing review step with explicit Play now / queue placement actions. This keeps the click path clear on mobile without introducing drag-only controls.
- Added a persistent Korean/English selector inside output settings. Dashboard-only copy lives in `appMessages.js`; output and OBS safety copy remains the fallback catalog. The merged catalogs have complete Korean/English key parity. Playback/queue errors, AI progress, ErrorBoundary, and Display Widget now also use semantic locale state; changing locale re-derives the current AI status instead of retaining streamed Korean prose.
- The compact white header hairpin, removed subtitle, dark-green songbook text, speaker-first default, and unrestricted browser-local Speaker path remain intact. Speaker playback still has no single-player, lease, heartbeat, or cross-tab ownership restriction.
- Removed the remaining cross-tab runtime coupling: `currentEntry` and `active` are no longer written into the shared `localStorage` payload or imported from another tab. Each Speaker tab now retains its own current song, run identity, controls, and output mode while durable queue/songbook/preferences continue to sync. The state normalizer also preserves `active.outputMode`, preventing later OBS controls from silently falling back to the local Speaker transport.
- OBS reconnect recovery no longer waits for the next 10-second heartbeat. The same OBS player identity restores its established lease in the `player_hello` handshake, then re-attests the surviving media graph's current playback state without issuing LOAD or PLAY. Ordinary playback evidence ambiguity records a warning but cannot emergency-stop or detach a live song. A dashboard control socket with no in-flight ambiguity also unlocks after a fresh welcome and authoritative snapshot agree; outcome-unknown commands and test/run identity conflicts stay sticky. No reconnect path replays commands, while test fixtures and explicit stop/deactivate/emergency/terminal boundaries remain strict.
- Performance isolation: the translation/search catalog stays outside the Protocol v2 OBS static closure. OBS totals are 381,173 bytes raw / 115,927 bytes gzip / 101,552 bytes brotli against 460,800 / 133,120 budgets. The Dashboard is 88.53 KiB gzip, the local Speaker lazy chunk is 1.63 KiB gzip, and the translated Display Widget is 2.33 KiB gzip.
- Verification: 586 automated tests pass, oxlint reports only the two pre-existing `functions/api/gemini.js` escape warnings, Worker syntax, production build, whitespace, and OBS bundle budget pass. Local browser verification covered the three source tabs, songbook click → review transition, live Korean↔English switching, and two simultaneous Speaker tabs retaining different current songs. Cross-tab contracts additionally prove tab-owned runtime isolation and that multiple legacy Speaker candidates do not trigger an exact-one rejection.
- OBS player lifecycle audit: generated `playerInstanceId` now lives in a page ref and the effect depends on the protocol identity value rather than the caller object's reference. Recreating `{ playerInstanceId: 'same-id' }` during a normal render cannot dispose an established media graph; URL, room, token, client kind, a genuinely different player ID, real unmount, and terminal/explicit stop boundaries remain lifecycle changes.
- OBS runtime callbacks now coalesce into one immediate storage-free heartbeat. The Worker broadcasts a fresh control snapshot only when runtime attestation actually changes or a reconnect is restored, so scene state reaches the Dashboard immediately without returning to per-second WebSocket traffic or Durable Object writes. Actual Chrome safety smoke proved inactive/invisible telemetry preserved the established lease, blob, playing event count, and advancing media time; the later explicit emergency command alone physically stopped and detached both players.

## 2026-07-22 (Codex) — 실제 OBS 숨김 상태 안내 일관성

- 공개 배포본과 실제 OBS 30.2.0을 함께 사용해 `Rekasong` Browser Source의 눈 아이콘을 끄고 다시 켰다. 숨김 중에도 기존 OBS lease와 media graph는 유지됐고, 다시 표시한 뒤 약 2초 안에 `OBS 플레이어 정상 · 1개 연결됨`으로 자동 복구됐다. 라이브 송출과 녹화는 시작하지 않았다.
- 연결은 유지됐지만 기존 UI가 같은 화면에서 `OBS 송출 중`, `OBS 플레이어 없음`, `연결된 OBS On-Air 플레이어가 없습니다`를 동시에 표시하는 모순을 확인했다. 이 상태에서 완전 초기화를 권하거나 경로를 끊는 것은 연결 우선 원칙에 어긋난다.
- 숨겨진 단일 OBS 소스를 별도 상태로 표시한다. 상단은 `OBS 소스 숨김 · 연결 유지`, 다음 행동은 눈 아이콘을 켜라는 지시와 재선택이 불필요하다는 설명을 제공한다. 설정의 플레이어 상태와 오디오 점검도 `플레이어 없음` 대신 숨김 상태를 표시하며, 점검 신호 시작만 안전하게 막는다.
- 한국어와 영어 메시지 키를 함께 추가했다. 626개 전체 테스트, lint(기존 Gemini escape 경고 2건만 유지), production build, `git diff --check`, OBS 정적 번들 예산(raw 381,225B / gzip 115,957B / brotli 101,631B)을 통과했다.

## 2026-07-22 (Codex) — public deployment comparison before v0.2.2 approval

- Read-only production inspection confirmed Pages serves HTTP 200 with `assets/index-Cr5lSL-w.js` and a Last-Modified time matching commit `2c7dca5` (`0.2.1`). Public `master`, `origin/master`, and local HEAD all point to that commit; the `0.2.2` candidate remains uncommitted and undeployed. Cloudflare reports Worker version `797ef6e2-34bc-4037-8c7a-10f596fe5d96` (number 30) at 100%, deployed less than two minutes before the Pages artifact.
- The public first screen already defaults to Speaker, has no subtitle, reports `스피커 송출 중`, and leaves the Speaker radio enabled. This confirms the earlier local-Speaker boundary is live.
- Opening public settings in Speaker mode still exposes all OBS setup, continuity, test, URL, and session-ending controls together, including the alarming `다른 탭이 출력 제어 중입니다` status. The v0.2.2 progressive settings disclosure is therefore a real production UX fix, not only refactoring.
- Clicking a public songbook row eventually created the song review/preparation UI, but the visible transition arrived roughly five seconds later and below the current viewport. The v0.2.2 row busy state supplies the missing immediate acknowledgement.
- Public source tabs are still split into YouTube search and YouTube playlist, and no locale selector exists. These remain expected deployment deltas, not local regression failures.

## 2026-07-22 (Codex) — 실제 OBS 초기 상태 오판 수정과 G3 기계 관측

- 실제 OBS 30.2.0/browser plugin 2.23.5의 Rekasong Browser Source를 production과 동일한 player URL로 연결하고, 방송·녹화는 끈 채 런타임과 오디오 경로를 점검했다.
- 원인은 OBS browser API가 처음 로드된 source의 active/visible 값을 조회하는 getter를 제공하지 않는데도 앱이 이벤트 미관측 초기값을 `false`로 만들었던 것이다. 이미 활성 장면에서 페이지가 열리면 callback이 오지 않아 정상 player가 영구 후보 제외되고 `OBS 플레이어 없음`에 갇혔다.
- runtime attestation, playback adapter, output path, Worker 후보 판정을 `unobserved`와 명시적 `false`로 분리했다. OBS binding+최신 heartbeat의 초기 미관측은 허용하고, 실제 callback으로 관측한 false는 새 활성화를 계속 fail-closed 한다.
- 개발 전용 `tools/obs-runtime-probe.html`에서 초기 event 0/unobserved와 source visibility off/on 뒤 true callback을 실제 OBS 화면으로 확인했다. 진단 overlay는 앱에서 제거했으며 probe는 production 앱 경로에 연결하지 않았다.
- 최신 로컬 player는 READY에 도달했고 dashboard에서 후보 1개와 OBS route 활성화를 확인했다. 앱 점검 신호가 G2 완료로 끝나는 동안 실제 Rekasong mixer meter가 약 -25 dB까지 움직여 G3 기계 관측을 통과했다.
- 사용자 청취, mute/monitoring/scene 변형, 녹화 파일, 비공개 방송 결과물, 10분 mic↔MR offset/drift는 아직 남았다. 이 증거 전에는 `OBS 송출 확인 완료`나 `카라오케 싱크 확인 완료`로 판정하지 않는다.
- 최종 review candidate 검증: 자동 테스트 624/624, Worker syntax, production build, whitespace, OBS 정적 closure 예산을 통과했다. OBS closure는 raw 381,225B / gzip 115,968B / brotli 101,564B이며 raw 450KiB / gzip 130KiB 예산 안이다. lint는 신규 오류 없이 기존 `functions/api/gemini.js`의 escape 경고 2건만 남는다. `tools/obs-runtime-probe.html`은 production `dist`에 포함되지 않는다.

## 2026-07-22 (Codex) — v0.2.5 공개 Dashboard UX·성능 스모크와 의존성 정리

- 공개 Pages와 로컬 배포를 같은 조건으로 확인하는 `scripts/dashboard-production-smoke.mjs`를 추가했다. 새 격리 브라우저에서 Speaker 기본값, 잠기지 않은 Speaker/OBS 선택 버튼, YouTube 단일 상위 소스와 Search/Playlist 내부 모드, 한국어→영어 즉시 전환과 새로고침 지속성을 검증한다.
- 320/375/768/1100px에서 한국어와 긴 영어 상태 문구를 각각 확인한다. 흰 머리핀 컨트롤이 viewport를 벗어나지 않고 가로 overflow가 없으며, 유레카의 3px 금발 선이 모든 폭에서 불투명하게 남는지 자동으로 실패시킨다. 320px 영어 설정 대화상자도 별도 검증한다.
- 공개 냉시작 실측은 HTML DCL 약 499ms, 초기 자원 289,872B 전송/1,018,946B decode, DOM 125개, 72ms long task 1개였다. 캐시 재방문은 DCL 약 28ms, long task 0개였고 전체 상호작용 뒤 JS heap은 약 9.2MiB였다. 네트워크 속도를 합격 조건으로 삼지 않고 DOM 2,000개, decoded resource 6MiB, JS heap 64MiB의 넉넉한 회귀 상한만 둔다.
- 소스 참조가 0개인 구형 `LivePanel.jsx`를 제거했다. 이 화면에 남아 있던 하드코딩 문구와 사용하지 않는 애니메이션 유지보수 표면도 함께 사라졌다.
- 소스 import가 0개인 `firebase` 직접 의존성을 제거해 설치 트리에서 84개 패키지를 줄였다. 공개 Dashboard/OBS 번들은 원래 Firebase를 포함하지 않아 런타임 동작과 OBS bundle byte 수는 변하지 않는다.
- 첫 Pages 작업은 깨끗한 `npm ci`에서 Rolldown의 선택적 WASM fallback이 요구하는 `@emnapi/core`/`@emnapi/runtime` peer 레코드가 lockfile에 없다고 중단됐다. `npm uninstall`이 Firebase 트리와 함께 공유된 선택적 peer 레코드까지 제거한 것이 원인이었다. Firebase를 되살리지 않고 두 optional peer lock 레코드만 복원했으며, 빈 검증 디렉터리의 `npm ci --ignore-scripts`로 lockfile 재현성을 확인했다.
- 수정 배포 `743ac9a`의 GitHub Pages 작업은 clean install, 634개 테스트, lint, Worker 문법, build, OBS budget, publish를 모두 통과했다. CDN Last-Modified는 `2026-07-22 06:34:36Z`로 갱신됐고, 런타임 코드가 의도대로 동일해 main/CSS 자산 hash는 유지됐다. 게시 뒤 공개 스모크도 다시 통과했다.
- 검증: 자동 테스트 634/634, lint 신규 오류 0(기존 Gemini escape 경고 2건), production build, whitespace, 공개·로컬 Dashboard smoke, OBS 정적 closure budget(raw 382,301B / gzip 116,110B / brotli 101,713B)을 통과했다.

## 2026-07-22 (Codex) — v0.2.8 Speaker 로컬 파일 수명·복구 상한

- Speaker의 페이지 소유 `blob:` 파일이 완료 이력에 무한히 남지 않도록 상태 모델과 예산을 추가했다. 현재 재생·대기열은 항상 보호하고, 완료 이력 전용 파일만 최신 5개·합계 256 MiB 안에서 유지한다. 같은 Blob을 공유하는 이력은 원자적으로 함께 유지하거나 만료한다.
- 만료는 곡 삭제가 아니다. 제목·순서·entryId를 보존한 `파일 필요` 항목으로 바꾸고, 사용자가 명시적으로 `파일 다시 선택`하면 대기열은 제자리에서 복구하고 이력은 원본 기록을 둔 채 새 재생 항목을 대기열 맨 위에 만든다. 모든 신규 문구는 한국어·영어 semantic key로 함께 추가했다.
- localStorage와 다른 탭에는 페이지에서만 유효한 Blob URL을 절대 기록하지 않는다. 다른 탭의 동기화가 현재 탭이 실제 파일을 가진 대기열·이력 항목을 placeholder로 낮추거나 지우지 못하도록 병합 경계를 보강했다.
- Blob 생성·해제는 페이지 소유 목록으로 관리하고, 최신 상태에 참조가 없다는 사실이 확인된 뒤에만 해제한다. 느린 탭에서도 고정 시간 추정으로 재생 파일을 먼저 해제하지 않는다. OBS의 `assetId`, Worker, WebSocket 계약은 변경하지 않았다.
- 500회 로컬 Speaker↔OBS 왕복 테스트에서 출력 잠금, watchdog, 소켓 소유자, LOAD/PLAY/STOP 명령이 누적되지 않았다. 격리 브라우저에서 대기열·이력 파일 복구, 잘못된 파일 거부 뒤 재시도, 저장 Blob URL 0개, Worker 요청 0개, 320px overflow 0, Dashboard 이탈 시 생성 Blob 2/2 해제를 확인했다.
- 1,000곡 이력 성능은 첫 열기 276.9ms, 반복 상호작용 p95 47.6ms, 닫은 뒤 GC heap 증가 210,564B였다. 전체 650/650 테스트, production build, 로컬 Dashboard 320/375/768/1100px smoke, 유레카의 고정 3px 노란 머리선, OBS 정적 번들 예산(raw 382,301B / gzip 116,109B)을 통과했다. lint는 신규 오류 없이 기존 `functions/api/gemini.js` escape 경고 2건만 남는다.

## 2026-07-22 (Codex) — v0.2.14 OBS 점검음 방송 유입 차단과 노래 방송 모니터 안내

- OBS 오디오 점검 신호가 실제 방송 프로그램 오디오로 들어갈 가능성을 제품 경계에서 제거했다. 정확한 OBS Browser Source가 `streamingStatusObserved=true`와 `streaming=false`를 보고한 경우에만 점검을 시작하며, 방송 중이거나 방송 여부를 확인하지 못하면 사용자가 해야 할 다음 행동을 한국어·영어로 안내한다.
- 같은 조건을 Dashboard/Coordinator, Durable Object Worker, OBS player의 fixture LOAD 전과 PLAY 직전에 각각 다시 검사한다. 점검 도중 OBS streaming 시작 callback이 오면 점검 fixture만 strong stop한다. 일반 MR은 방송 중 재생하는 것이 본래 목적이므로 streaming·scene telemetry가 정상 곡을 끊거나 media graph를 다시 만들지 않는다.
- 설정 안에 기본 접힘 상태의 `노래 방송 모니터 경로` 안내를 추가했다. 물리 스피커→마이크 loop는 측정용일 뿐이고 실제 방송에서는 헤드폰을 사용한다는 점, 가능하면 마이크 입력과 헤드폰 출력을 같은 오디오 인터페이스 clock에 두는 점, OBS monitoring 설정과 10분 재측정 순서를 설명한다. 실패 결과는 연결·재생을 막거나 Sync Offset을 자동 변경하지 않는다.
- 실제 OBS 10분 분리 트랙은 MR 재생 중단·restart·seek 없이 marker 60/60과 jitter p95 1.832ms를 기록했다. 현재 온보드 출력+별도 USB 마이크 조합은 drift 15.5–17.32ms/590초와 중앙 offset 43.25ms로 수용 기준을 넘었으므로, 같은 audio clock 경로에서 재측정하기 전에는 카라오케 sync 통과로 표시하지 않는다.
- 전체 684/684 테스트, Worker 문법, production build, `git diff --check`, OBS 정적 closure 예산(raw 383,782B / gzip 117,558B / brotli 103,025B)을 통과했다. lint는 신규 오류 없이 기존 `functions/api/gemini.js` escape 경고 2건만 남는다. production Worker는 먼저 version `2b819923-49bb-4002-9407-848321a6c6f7`로 배포했으며 실제 streaming은 시작하지 않았다.
