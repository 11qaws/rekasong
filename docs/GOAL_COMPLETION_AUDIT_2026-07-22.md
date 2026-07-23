# Rekasong 목표 완료 감사 — 2026-07-22

> 작업 위치: `D:\Agents\rekasong\Codex\workspace`
>
> 판정 원칙: 코드 존재가 아니라 사용자가 실제로 끝까지 수행할 수 있는지, 그리고 그 사실을 어떤 증거로 확인했는지로 판정한다.
>
> 최신 공개 배포는 v0.2.29다. 출력별 음량과 OBS strong-stop 뒤 폐기 UI 복구를 추가하고, 실제 운영 Worker의 격리 세션과 공개 Pages에서 검증했다. 실제 OBS·로컬 녹화·OBS→Speaker 전환 물리 증거는 [OBS_PHYSICAL_VALIDATION_2026-07-22.md](./OBS_PHYSICAL_VALIDATION_2026-07-22.md)와 [OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md](./OBS_MANUAL_ACCEPTANCE_RUNBOOK_2026-07-19.md)에 보존한다.

## 1. 현재 결론

| 사용자 목표 | 로컬 후보 | 공개 배포 | 남은 증거 |
|---|---|---|---|
| 앱을 열면 스피커로 바로 시작 | 완료 | v0.2.26 공개 배포됨 | 모바일 OS별 백그라운드 수동 확인 |
| Speaker를 일반 웹 플레이어처럼 사용 | 완료 | v0.2.26 공개 배포됨 | 모바일 OS별 백그라운드 수동 확인 |
| 잠금 화면·알림·헤드셋의 Speaker 제어 | 자동 계약 완료 | v0.2.26 공개 배포됨 | 실제 지원 모바일에서 수동 확인 |
| Speaker 탭·창 수에 앱 경로 제한이 없고 서로 막지 않음 | v0.2.18 실제 3탭 통과 | v0.2.18 실제 3탭·재생·reload 통과 | 모바일 OS별 백그라운드·PiP 수동 확인 |
| Speaker 화면에서 단일 경로·다른 탭 제어 경고 제거 | 완료 | v0.2.26 공개 배포·자동 재확인 | 없음 |
| Speaker 감상 볼륨과 OBS 방송 gain 분리 | 운영 연결 자동 검증 완료 | v0.2.29 공개 배포·34/60 reload 유지 | 물리 OBS mixer 청취 |
| Speaker 유휴·검색이 방송 세션/제어 연결을 만들지 않음 | production-browser 실측 완료 | v0.2.15 공개 URL 재확인 | 없음 |
| Speaker 로컬 파일이 OBS 선택 전 서버 없이 즉시 재생 | production-browser 실측 완료 | v0.2.15 공개 URL 재확인 | 실제 OBS 업로드 뒤 Speaker 복귀 청취 |
| 지원 브라우저에서 Speaker 출력 장치 선택·탈착 복구 | v0.2.22 자동·모사 브라우저 검증 완료 | v0.2.22 배포·공개 자산 확인 | 실제 지원 장치에서 물리 청취 확인 |
| OBS만 엄격한 단일 송출 경로 사용 | 자동 검증 + G3 기계 관측 + G4 완료 | v0.2.26 공개 배포됨 | 사용자 청취·G5, G6 장치 경로 개선·재검증 |
| OBS 최초 설정 대기가 경로 고장으로 바뀌지 않고 자동으로 이어짐 | v0.2.21 로컬 제품 UI·자동 계약·실제 OBS 후발 연결 통과 | v0.2.21 배포·공개 자산 확인 | 없음 |
| OBS 재접속 중 재생 연결을 우선 보존 | 같은 player ID 자동 복구 + control coordinator/run 소유권 보존 + 새 ID 명시적 완전 초기화 + 실제 source hide/show·scene 전환·60분 CEF·source refresh·OBS 재시작·활성 곡 control socket 단절 후 조작 복구 완료 | v0.2.26 공개 배포됨 | 없음 |
| OBS 리모컨 요청과 실제 플레이어 적용을 구분 | 운영 Worker 연결 자동 검증 완료 | v0.2.29 공개 배포됨 | 실제 OBS 화면 수동 확인 |
| OBS 오디오를 건드리지 않고 평상시 위치 관측만 30초로 제한 | 5분·4Hz 모사 1,200→9 + 실제 CEF 302.5초 position 10회, 자동 media 명령 0 | v0.2.26 공개 player 실제 OBS 통과 | 없음 |
| 헤더 머리핀 UI와 유레카 금발 선 | 완료 | v0.2.26 공개 배포·긴 문구 시각 검증됨 | 없음 |
| YouTube 검색/목록을 한 소스로 묶기 | 완료 | v0.2.26 공개 smoke 통과 | 없음 |
| 노래책 행 클릭 후 명확한 검토/재생 행동 | 완료 | v0.2.26 공개 smoke 통과 | 없음 |
| 검색·노래책 곡을 지금/다음 재생·대기열·이력에 드래그 | 완료·실제 Chrome 검증 | v0.2.15 공개 검증됨 | 모바일·키보드는 기존 클릭 경로 사용 |
| 한국어/영어 전환과 번역 가능한 출력 구조 | 완료(현재 사용자 화면 범위 + pseudo CI) | v0.2.26 공개 언어 전환·reload·3화면×4폭 긴 문구 통과 | 없음 |
| 가벼운 앱과 OBS 정적 경로 예산 | 완료 | v0.2.29 공개 예산·30곡 Blob 수명, 기존 60분 CEF 통과 | 없음 |
| 1,000곡 이력이 기본 조작을 무겁게 하지 않음 | production-browser 실측 완료 | v0.2.15 공개 코드 재확인 | 없음 |

현재 공개 Pages는 `0.2.29` / release commit `03a062a190994a62c17c2b8307b9b7d52d9e78aa`까지 성공적으로 배포됐다. Pages workflow `29972538959`와 deployment `5565613740`가 success이며 clean Ubuntu에서 733개 테스트·pseudo-locale layout·30곡 local Blob 수명·OBS bundle 예산을 통과했다. Actions artifact에서 실제 배포 대상 21개를 내려받아 공개 CDN과 바이트·SHA-256 exact match를 확인했다. 공개 production smoke는 기본 Speaker, 출력별 음량 reload, 한영 전환, 320~1100px, 320px 영문 설정, 금발 선을 통과했고 HTTP 오류·ntfy 요청·warm long task는 0이었다. 운영 Worker 격리 연결에서는 실제 방송·녹화 없이 OBS 재생·음량 확정 1회·strong-stop 뒤 UI 종료·Speaker 복귀·세션 410을 통과했다. 30초 cadence는 계속 observation-only이며 곡 중간 seek·restart·속도 변경·재연결을 하지 않는다. production Worker runtime은 변경·재배포하지 않았다. 실제 OBS CEF 60분과 별도 5분 가상 케이블 증거는 유지되며, 사용자 청취·G5·같은 clock 경로 G6는 별도 관문으로 남는다.

### v0.2.28 공개 배포·Speaker 로컬 파일 장시간 수명 관문 — 2026-07-23

- production build 브라우저에서 기본 Speaker로 로컬 WAV 30개를 UI 선택→재생→종료까지 반복했다. 완료 기록 30개는 유지하면서 최근 5개만 즉시 재생 가능한 Blob으로 남고 오래된 25개는 복구 가능한 메타데이터로 만료됐다.
- Dashboard가 열린 동안 Object URL은 생성 30·회수 25·유지 5였고 Dashboard unmount 뒤에는 30개 전부 회수·유지 0이었다. 저장소 `blob:` URL, Worker session/WebSocket/ntfy 요청, page error는 모두 0이었다.
- Linux와 같은 `en-US` locale로 고정한 최종 배포 후보 run의 강제 GC 뒤 JS heap 증가는 `4,200,944B`, 30회 UI 전이 p95는 `1,342.4ms`였다. byte 상한과 현재/대기열 보호는 단위 계약으로 함께 재확인했다.
- 이 관문은 새 재생 제한이나 서버 검사를 추가하지 않는다. 기존 수명 정책을 실제 제품 UI에서 검증하고 Pages workflow에 넣은 test-only 변경이다.
- Pages workflow `29970083896`과 deployment `5565152862`가 release commit `1346be0d5eef6e8ac680d2d9b6bd46eb134bea49`로 성공했다. 공개 URL의 동일 30곡 run은 post-GC heap 증가 `4,222,900B`, 전이 p95 `1,340.9ms`였고 나머지 수명 판정은 로컬 후보와 같았다.
- 공개 production smoke는 기본 Speaker·주요 소스·한영 reload·320~1100px·320px 영문 설정·금발 선을 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `26.0ms`, long task 0, JS heap `8,012,016B`였다. 공개 파일 21개는 Actions artifact와 바이트·SHA-256 exact match였다.

### v0.2.27 실제 CEF cadence 검증 안전화 — 2026-07-23

- 실제 CEF harness는 현재 OBS status의 `streaming=false`·`recording=false`를 관측하기 전에는 upload·activation하지 않고, 재생 중에도 같은 조건을 계속 검사한다. 방송·녹화 명령 surface는 없다.
- 공개 v0.2.26 player의 302.5초 실제 OBS run은 position 10회, 최소 간격 `30,025ms`, wall 오차 `132ms`, candidate 전환·control disconnect/reconnect·unsafe route 0으로 통과했다. 30초 관측은 리모컨 표시 기준만 갱신하며 음원 seek·restart·속도 변경·재연결을 하지 않는다.
- 시험 전·중·후 UI와 최종 로그에서 Streaming/Recording Start·Stop 0을 확인했고, Browser Source 설정을 원본 SHA-256과 exact match로 복원했다.
- commit `b23ca23d69ca61c823d85c0a91b7aa0145e78064`, Pages workflow `29968661755`, deployment `5564872415`가 성공했다. public 21개 파일이 Actions artifact와 exact match였고 runtime hash는 v0.2.26과 동일했다.
- 공개 smoke는 기본 Speaker와 320~1100px 한·영 UI를 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `23.4ms`, long task 0, JS heap `7,944,864B`였고 media·OBS route·방송·녹화를 시작하지 않았다.

### v0.2.26 공개 배포·30초 위치 관측 — 2026-07-23

- 5분 재생을 4Hz `timeupdate` 1,200회로 모사했을 때 WebSocket `position`은 30·60·90·120·150·180·210·240·270초의 9회만 발생했다. `playing`과 `ended`는 즉시 별도 전달됐고 관측이 만든 media command는 0건이었다.
- Dashboard는 마지막 절대 position과 `performance.now()`로 화면만 보간한다. 탭 timer가 늦어져도 누적 tick 오차가 없고 pause/loading/buffering에서는 timer가 멈춘다. 30초 관측은 오디오 시계나 자동 보정 신호가 아니다.
- 전체 `724/724`, lint(신규 오류 0, 기존 Gemini escape 경고 2), Worker 문법, build, pseudo-locale, OBS bundle을 통과했다. Dashboard는 `372.71kB raw / 102.09kB gzip`, OBS 정적 경로는 `384,105B raw / 118,427B gzip / 103,644B brotli`로 예산 안이다.
- Pages workflow `29966902022`, deployment `5564569384`, commit `ccac98477871f01a6625f90056535a9a9687ca33`이 success다. 공개 `index.html` SHA-256은 `40ccad6f20e84296efb14bea43c7b1effd7fd9fdf36834bb546560fda19bc63b`, Dashboard는 `59b87898917dbd5c5ca00e3e590560cb3ca0b41e7202c9a4a4ce83f829075c6b`, `OnAirPlayerV2-DgWroZwz.js`는 `42,665B`·SHA-256 `9374f8e757276e0bf2b780656fa05dab177dec835990fdaef5078b3e8727521e`이며 Actions artifact와 정확히 같다.
- 공개 smoke는 기본 Speaker, 두 출력 버튼, YouTube/Setlink/Meloming, Search/Playlist, 한·영 reload, 320/375/768/1100px, 320px 영문 설정과 금발 선을 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `23.6ms`, warm long task 0, JS heap `7,970,680B`였다. 음악·OBS route·방송·녹화는 시작하지 않았다.

### v0.2.25 공개 배포·번역 길이 관문 — 2026-07-23

- production selector는 검수한 한국어/English만 유지한다. test-only pseudo locale가 문구를 약 40% 늘리고 placeholder·URL·제품명·protocol token을 보존한 채 본문과 접근성 속성을 변환한다.
- 메인 Dashboard, Speaker 설정, 전체 OBS 설정과 performer-monitor 상세를 320/375/768/1100px에서 검사해 document/dialog overflow, 화면 밖 조작부와 숨은 text/control 잘림이 모두 0임을 확인했다. 공개 앱에서도 같은 smoke를 다시 통과했다.
- OBS 설정 시나리오는 session HTTP를 격리된 503으로 끝내고 모든 WebSocket을 서버 연결 전에 막았다. 세 시나리오 모두 media source·playing 0이라 방송·녹화·점검 신호·음악을 시작하지 않았다.
- 전체 `720/720`, lint, Worker 문법, build, OBS bundle과 Pages artifact upload·deploy를 통과했다. 이 관문은 scripts/tests에만 있어 Dashboard·Speaker·OBS runtime byte를 늘리지 않았다.

### v0.2.24 공개 배포·실제 OBS 활성 곡 control-gap 검증 — 2026-07-23

- 실제 `OnAirOutputController`를 사용하는 opt-in harness가 유일한 control socket만 닫고 Dashboard의 350ms 복구 경로를 실행한다. coordinator factory 수와 socket 수명, 명령 호출을 계측해 단위 테스트가 아닌 실제 OBS CEF player에 대한 증거를 남긴다.
- 합격 run은 coordinator `1`, socket `1→2`, disconnect/retry `1/1`, 최대 gap `1,118ms`, READY 복귀 `740ms`, 같은 player identity, position `0→3.322594s`를 확인했다. 자동 activate/deactivate/emergency/load/play/pause/seek/volume/stop delta는 모두 `0`이었다.
- 복구 후 명시적 pause→play→stop이 같은 run에 적용됐고 늦은 복구 timer는 `already_ready`로 끝났다. session end 뒤 status는 HTTP 410이었다.
- 실제 close 요청은 `4101`이었지만 Cloudflare 경로에서 client가 관측한 close event는 `1006 / wasClean=false`였다. 요청과 관측을 분리해 기록하며, 이를 route나 media 실패로 오판하지 않는다.
- OBS는 시험 전후 `Start Streaming`·`Start Recording`, 타이머 `00:00:00`이었다. 최종 OBS 로그의 Streaming/Recording Start·Stop은 모두 0, 원본 Browser URL exact 복원과 임시 handoff 제거를 확인했다.
- 전체 `717/717`, build, OBS bundle budget, Speaker network/local-file/drag/history smoke가 통과했다. Speaker 로컬 재생 중 Worker HTTP/socket/frame은 0, 1,000곡 warm p95는 `26.8ms`, post-GC heap 증가는 `0B`였다.
- commit `ba92170f46dc6142ea9720cdfa276d2da2625737`의 Pages workflow `29962845583`는 build 24초·deploy 8초로 성공했고 deployment `5563857486`도 success다. 공개 `index.html` SHA-256은 `ebe5c7dd0ca571285048f1ffb8a012d3c6dc99c0b6ba9500ddb1936176b2850f`, `OnAirPlayerV2-wxBcfHSA.js`는 `42,343B`·SHA-256 `7da8802df59db5a63969c65977de87aa1ab4e46ee1dcf0b7ed86639fd6c861cb`이며 둘 다 Actions artifact와 정확히 같다.
- 배포 후 공개 smoke는 기본 Speaker, 두 출력 버튼, YouTube/Setlink/Meloming, Search/Playlist, 한·영 reload, 320/375/768/1100px, 320px 영문 설정과 금발 선을 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `22.1ms`, warm long task 0, JS heap `7,948,940B`였다. 음악·OBS route·방송·녹화는 시작하지 않았다.

### v0.2.23 공개 배포 — 2026-07-23

- 단순 제어 소켓 손실은 같은 coordinator와 현재 `entryId/runId/player/lease` 소유권을 보존하고 socket만 다시 연다. 겹친 복구 timer는 `reconnect_in_progress` 또는 `already_ready`로 끝나며 route·LOAD·PLAY·PAUSE·SEEK·VOLUME·STOP·emergency를 재전송하지 않는다.
- 자동 검증은 `716/716`, lint, Worker 문법, production build, OBS bundle 예산을 통과했다. Dashboard는 `370.81kB raw / 101.51kB gzip`, OBS closure는 `383,782B raw / 117,552B gzip / 102,951B brotli`다. 로컬 production preview의 warm DCL은 `21.6ms`, warm long task 0, JS heap `7,896,004B`, HTTP 오류·ntfy 요청 0이었다.
- commit `462bd2fac91e8cb60b13fdb5dc615aa21f4b0103`의 Pages workflow `29960932902`는 clean install·716 tests·lint·Worker 문법·build·OBS budget·deploy를 모두 통과했고 deployment SHA도 일치한다.
- 공개 entry/Dashboard는 `index-CELi0hru.js` / `Dashboard-Da33zoCb.js`다. Dashboard SHA-256 `e0efd63ed84fabb2b89443b37eac2f42328d2582035676ed32a4357ff0059250`에 `reconnect_in_progress`·`already_ready`가 모두 포함됐다.
- 공개 격리 smoke는 기본 Speaker, 두 출력 버튼, YouTube/Setlink/Meloming, Search/Playlist, 한·영 reload, 320/375/768/1100px, 모바일 설정, 금발 선을 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `37.7ms`, warm long task 0, JS heap `7,893,252B`였다. 음악 재생·OBS route·방송·녹화는 시작하지 않았다.
- 활성 곡의 실제 control socket 단절 뒤 같은 player/run 복구와 명시적 pause/play/stop 관문은 v0.2.24 실물 run으로 통과했다. 사용자 물리 청취, 실제 플랫폼 ingest/VOD G5, 장치 조합별 G6는 별도 관문으로 남는다.

### v0.2.22 공개 배포 — 2026-07-23

- Speaker transport에는 visibility·PiP·OBS proof·heartbeat 기반 차단이 없음을 회귀 테스트로 고정했다. 브라우저/OS가 백그라운드 탭 자체를 정지시키는 정책은 여전히 실기기 관문이지만 앱 내부 검사가 이를 정지시키지는 않는다.
- 지원 브라우저의 `devicechange`에서 선택 sink를 이벤트 기반으로 재확인하고, 소실 시 같은 media element에 시스템 기본 sink를 적용한다. 장치 이벤트가 겹치면 직렬화하며 새 사용자 선택은 오래된 실패가 덮지 못한다. timer·polling·Worker·WebSocket·재생 명령은 추가하지 않았다.
- 실제 headless Chrome 로컬 파일 smoke는 5초 WAV media source를 보존한 채 `smoke-speaker`→기본 sink 폴백, 저장 선호 초기화, 번역된 재선택 안내, Worker 요청 0을 통과했다. 이는 브라우저 wiring 증거이며 실제 USB/Bluetooth 청취를 대신하지 않는다.
- 자동 검증은 `715/715`, lint, Worker 문법, production build, OBS bundle 예산을 통과했다. Dashboard는 `370.33kB raw / 101.41kB gzip`, OBS closure는 `383,782B raw / 117,551B gzip / 102,979B brotli`다. production preview의 warm DCL은 `22.2ms`, warm long task 0, JS heap 약 `7.89MiB`, HTTP 오류·ntfy 요청 0이었다.
- 30초 cadence는 기존 fixture의 관찰 전용 정책을 재검증했다. 제품 타이머로 물리 싱크를 가장하거나 곡 중 seek·restart·속도 보정을 하지 않고, 다음 곡을 새 run의 0초 기준으로 시작하면서 OBS route를 유지한다.
- commit `c307e2007675e3dbb3b1ded09f62566546422670`의 Pages workflow `29959351699`는 715 tests·lint·Worker 문법·build·OBS budget·deploy를 모두 통과했고 deployment SHA도 일치한다. 공개 자산 `speakerOutputDevice-CS9Ii3JE.js`에 `devicechange` 코드가 포함됐다.
- 공개 격리 smoke는 기본 Speaker, 두 출력 버튼, YouTube/Setlink/Meloming, Search/Playlist, 한·영 reload, 320/375/768/1100px, 모바일 설정, 금발 선을 통과했다. HTTP 오류·ntfy 요청 0, warm DCL `29.9ms`, warm long task 0, JS heap 약 `7.92MiB`였다.

### v0.2.21 공개 배포 — 2026-07-23

- OBS를 고른 뒤 플레이어가 없음·중복이거나 단일 source가 숨겨져 있으면 이를 route 실패로 확정하지 않는다. 선택 의도를 보존하고 exact-one visible candidate가 되면 같은 상태 전이가 자동으로 활성화를 이어 간다. control negotiation 자체의 timeout과 unknown authority는 기존처럼 별도 실패 경계다.
- production Worker 설정의 로컬 Dashboard와 production build preview에서 `OBS 플레이어 없음`을 각각 11초·9초 유지했다. 두 경우 모두 `송출 경로 확인 필요`, 완전 초기화, 긴급 정지가 나타나지 않았고 실제 다음 행동과 자동 계속 조건만 표시됐다. Speaker를 누르면 추가 reset 없이 즉시 `스피커 송출 중`으로 돌아왔다.
- 준비 대기는 route activation·LOAD·PLAY·오디오 점검·추가 polling을 시작하지 않는다. 정확히 한 플레이어가 나타날 때까지 control/session 연결만 유지한다.
- 자동 검증은 `709/709`, production build와 OBS bundle 예산을 통과했다. Dashboard는 `369.83kB raw / 101.28kB gzip`, OBS closure는 `383,782B raw / 117,550B gzip / 102,988B brotli`다. production preview smoke의 warm DCL은 `24.8ms`, long task 0, JS heap 약 `7.87MiB`, HTTP 오류·ntfy 요청 0이었다.
- commit `128f977eb835d70fcd44dbb57da575658f3f29d1`의 Pages workflow `29955448969`는 709 tests·lint·Worker syntax·build·OBS budget·deploy를 모두 통과했다. 공개 main/Dashboard 자산은 `index-nTobOpEa.js` / `Dashboard-CVlr6ZcZ.js`이며 새 setup 상태 key가 게시 파일에 포함됐다.
- 공개 격리 smoke는 기본 Speaker, 한·영 reload, 320/375/768/1100px, YouTube 묶음, 두 출력 버튼과 금발 선을 통과했다. HTTP 오류·ntfy 요청은 0, warm DCL `25.8ms`, long task 0, JS heap 약 `7.97MiB`였다. 기존 브라우저의 실제 다른 control owner 상태는 계속 별도 안내하고 Speaker 복귀를 막지 않았다.
- 실제 OBS 30.2.0에서 Dashboard가 먼저 `OBS 플레이어를 열어 주세요`로 기다리는 동안 기존 visible Browser Source에 같은 세션의 player URL을 넣었다. 별도의 OBS 출력 재클릭 없이 약 2초 안에 `OBS 송출 중`·`실제 활성: OBS 방송`·player 1개 정상으로 수렴했다. route 준비 중 현재 곡은 없었고 local media는 paused/source 없음, browser warning/error 0건이었다.
- 시험 전 남은 다른 control owner도 `다른 탭에서 제어 중`으로 정확히 드러났고, `이 탭에서 제어` 뒤 명시적 OBS 선택으로 같은 후발 연결 경로를 정상 수행했다. 방송·녹화 시작은 0건이었고 OBS URL은 시험 전 원본과 exact match로 복원했다.

### v0.2.20 실제 OBS scene 전환 — 2026-07-23

- commit `b70d5b6e408a9fd5fe6379567b28a2eed3a25bfb`의 Pages workflow `29952984161`은 clean install·707 tests·lint·Worker 문법·production build·OBS budget·publish를 모두 통과했다. GitHub Pages deployment도 같은 SHA를 가리킨다.
- 공개 Dashboard smoke는 기본 Speaker, 두 출력 버튼, YouTube/Setlink/Meloming, 한·영 전환·reload, 320/375/768/1100px, 모바일 설정, 금발 선을 통과했다. ntfy 요청과 HTTP 오류는 0, warm DCL `20.9ms`, long task 0, JS heap 약 `7.9MiB`였다.
- 공개 v0.2.19 player와 production Worker를 전용 OBS 30.2.0 test collection에서 검증했다. 빈 장면 10초와 원래 장면 복귀 5초 동안 동일 player ID·connection ID·entry/run·audible lease가 유지됐다.
- 최종 302.5초 fixture는 wall `302,584ms`(오차 `84ms`)로 자연 종료했고 candidate transition `0`, unsafe route 관측 `0`, 종료 session HTTP 410을 통과했다. 장면 밖에서 `obsCandidateCount=0`인 것은 inactive source가 새 활성화 후보에서 제외되는 정상 상태이며 established lease 실패가 아니다.
- 앞선 두 run도 wall 오차 `97ms`, `31ms`로 자연 종료했다. 한 run에서 control socket이 잠깐 끊겼지만 OBS media graph는 끝까지 진행했고, 다음 두 run 중 하나는 control 단절 0이었다. 검증기는 bounded control reconnect와 실제 route 손상을 분리해 기록한다.
- 30초 cadence는 관찰 전용이다. 곡 중 seek·restart·속도 보정은 하지 않으며 다음 곡 시작 때 새 run의 0초 기준만 다시 잡는다.
- 모든 run에서 OBS 방송·녹화 버튼과 타이머는 OFF/`00:00:00`이었고, 실제 방송·녹화는 시작하지 않았다. 시험 URL과 임시 credential은 실행 뒤 복원·제거했다.

### v0.2.19 공개 배포·실제 OBS 복구 — 2026-07-23

- Pages workflow `29947296396`은 clean install, 705개 테스트, lint, Worker 문법, production build, OBS bundle budget과 publish를 모두 통과했다. 공개 entry asset은 같은 Actions 환경의 로컬 build와 SHA-256 `fbb26f52aa7dec817039e5a9a22d9203b20125ce459373116b9dd91c2f5505c3`으로 일치했다.
- OBS 30.2.0의 Chromium 103에서 최초·source refresh 후·OBS 재실행 후 player 후보 하나를 각각 75초 안정화했다. refresh·재시작은 서로 다른 새 ID를 만들었고 candidate transition 0, 자동 takeover·LOAD·PLAY 0이었다.
- 두 변형 모두 full reset ACK→inactive/unverified→connected replacement 보존→명시적 OBS 재선택→active run 없음·desired stopped·5초 무음 순서를 통과했다. final automatic playback은 false였고 session은 HTTP 410으로 폐기됐다.
- OBS runtime과 UI·로그는 시험 전체에서 방송·녹화 OFF를 증명했다. 시험 URL은 실행 전 값과 exact match로 복원했다.

### v0.2.18 공개 배포 실측 — 2026-07-23

- Pages workflow `29944366536`은 clean install, 699개 테스트, lint, Worker 문법, production build, OBS bundle budget과 publish를 모두 통과했다.
- 공개 A/B 탭에서 A만 `Me at the zoo`를 대기열에 넣고 자동 다음 곡을 켰을 때 A=`queue 1/on`, B=`queue 0/off`였고 두 탭 새로고침 뒤에도 그대로였다. A의 실제 audio는 `paused=false`, `readyState=4`, `0.846→1.827초`로 진행했지만 B는 source 없음·`paused=true`였다. 검증 재생을 즉시 버린 뒤 새 C는 `queue 0/off/idle`과 공유 이력만 보였다.
- 공개 Dashboard smoke는 기본 Speaker, YouTube 단일 상위 소스와 내부 Search/Playlist, Setlink, Meloming, 한국어→영어→reload, 320/375/768/1100px, 320px 영어 설정 dialog, 출력 버튼, 금발 선을 통과했다. ntfy 요청과 HTTP 오류는 0이었다.
- 공개 cold DCL은 `297.4ms`, warm DCL은 `25.0ms`, warm long task 0, JS heap 약 `7.9MiB`였다. Dashboard chunk는 `368.34kB raw / 100.91kB gzip`, OBS closure는 `383,782B raw / 117,547B gzip / 102,918B brotli`로 예산 안이다.

### v0.2.17 공개 배포 실측 — 2026-07-23

- Pages workflow `29939145445`는 clean install, 696개 테스트, lint, Worker 문법, production build, OBS bundle budget과 publish를 모두 통과했다.
- 공개 Dashboard는 기본 Speaker, YouTube 단일 소스, Setlink, Meloming, 한·영 reload, 320/375/768/1100px, 모바일 설정 dialog, 두 출력 버튼, 3px 금발 선을 통과했다. ntfy 요청과 HTTP 오류는 0, warm DCL은 `25.9ms`, long task 0, JS heap 약 `7.6MiB`였다.
- production 새-ID recovery smoke는 기존 player 종료→새 ID 등록→완전 초기화→inactive/unverified→새 media paused·source 없음→명시적 OBS 재선택 ready를 통과했다. 8초 신호는 16/16 marker, wall 오차 `176.3ms`, 최대 sample gap `93.6ms`, waiting/stalled/error/backward 0이었고 세션 종료 뒤 HTTP 410 fence까지 확인했다.
- 공개 Dashboard chunk `Dashboard-C_ssb4Et.js`에 `forceReset`과 `dashboard.playback.outputReset`이 포함돼 최신 복구 UI 코드가 실제 CDN에 게시됐음을 확인했다.

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
- 2026-07-23 공개 URL을 다시 열어 기본 `스피커 송출 중`, YouTube 단일 상위 소스와 내부 `검색/플레이리스트`, Setlink→멜로밍 순서, Rekasong 부제목 부재를 확인했다. 설정에서 한국어→영어 전환 시 현재 출력·소스·OBS 설명이 즉시 영어로 바뀌고 한국어 작성 문구가 남지 않았으며, 검증 뒤 한국어로 원복했다.
- 같은 공개본에서 Speaker 유휴·로컬 WAV 실제 재생·검색은 session HTTP `0`, control WebSocket `0`, 전송 frame `0`, Worker host 요청 `0`이었다. 검색 결과 클릭→검토, drag 취소 durable 변경 `0`, 이력 drop 재생 `0`, drop 전후 media-session 요청 `1→1`, 320px 세 목적지와 가로 overflow도 통과했다.
- 공개 v0.2.15의 1,000곡 이력은 최대 mount 100행, cold open `41.7ms`, warm p95 `46.8ms`, 320px overflow 0, 닫은 뒤 post-GC heap 증가 0B였다.
- 공개 main/CSS/Dashboard/OnAirPlayerV2 자산의 SHA-256은 같은 commit을 GitHub Actions 조건으로 다시 빌드한 로컬 산출물과 4/4 바이트 단위로 일치했다.

## 2. Speaker 사용자 흐름

### 확정한 동작

- 새 탭의 기본 출력은 항상 Speaker다. 이전 OBS 선택을 복원해 사용자를 연결 대기 상태에 넣지 않는다.
- Speaker의 재생·일시정지·탐색·볼륨·스킵·재시도·버리기는 OBS control owner, output lease, player 후보 수, heartbeat, 재연결 상태를 보지 않는다.
- 탭마다 현재 곡·재생 run·대기열·자동 다음 곡을 따로 가진다. 완료 이력·노래책·MR 연결·언어 같은 사용자 라이브러리와 환경설정만 탭 사이에 공유한다.
- `localStorage`에는 현재 곡·active run·대기열·자동 다음 곡을 쓰지 않는다. 탭 대기열과 auto-next는 `sessionStorage`에 두며, 다른 탭의 storage event가 이 탭의 재생 순서나 run을 만들거나 덮어쓰지 못한다.
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
- v0.2.18 로컬 production build의 세 탭에서 A만 YouTube audio가 진행되고 B는 source 없는 idle임을 확인했다. 완료 이력은 공유됐지만 A의 `queue 1/auto-next on`은 새로고침 뒤에도 A에만 남았고 B와 새 C는 `queue 0/off/idle`을 유지했다.

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
- Browser Source refresh·OBS 재시작처럼 새 player ID가 생기면 자동으로 기존 경로를 승계하지 않는다. 사용자가 완전 초기화를 확인한 경우에만 현재 연결된 출력의 정지 ACK를 기다리고, 사라진 이전 target은 물리 정지 미확인으로 표시한 채 잠금을 해제한다. 완료 후 선택 경로를 비우고 Dashboard는 Speaker로 돌아가며 중단 곡을 자동 재생하지 않는다.
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
- G6 가상 케이블 격리 측정: 실제 OBS CEF Browser direct track과 VB-Audio Virtual Cable loopback track의 31/31 marker를 300초 전체에서 기록했다. edge drift `0.965ms`, linear-fit `0.352ms`, jitter p95 `2.015ms`는 통과했고 고정 offset `85.797ms`는 실패했다. 30초 변화 p95 `3.224ms`는 실제 누적 drift보다 커서 30초마다 강제 보정하지 않고 관찰만 한다. 이 run은 플레이어의 누적 drift 격리 증거이며 실제 가수 monitoring path 합격을 대신하지 않는다.
- `+69ms` OBS Browser Sync Offset 비교는 상대 지연을 약 `82–84ms`로 악화시켜 `0ms`로 되돌렸다. 서로 다른 하드웨어 clock의 drift 보정으로 사용하지 않는다.
- 각 곡은 새 run과 `position: 0`으로 기준점을 다시 잡되 OBS route와 lease는 유지한다. 정확한 이전 run stop proof 뒤에만 다음 media run을 load/play하며, 곡 중간에는 자동 seek·restart·속도 보정을 하지 않는다.
- 실제 OBS source refresh와 정상 종료·재실행에서 새 CEF player identity를 각각 75초 안정화했고, old run 보존·replacement standby·무자동재생·명시적 full reset·재선택 뒤 5초 무음을 통과했다. profile·scene·Browser/FIFINE source·mixer 설정도 보존됐다.
- OBS 30.2.0의 Chromium 103과 Vite 8 기본 Chrome 111+ target 사이의 공백은 v0.2.19의 명시적 `chrome103` JS·CSS target으로 제거했다. 전용 test collection에만 비공개 handoff URL을 백업 후 원자적으로 넣고 복원하는 fail-closed 도구와 실제 CEF run을 모두 통과했다.
- 남은 항목은 사용자가 직접 들은 monitoring 결과, 비공개 방송/VOD(G5), 같은 audio clock 또는 저지연 performer monitoring 경로의 5분 곡 단위 G6 재검증이다.

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
- 구 On-Air player의 오류 frame도 번역 문장 대신 안정적인 code를 보내며, hardcoded Korean/accessibility copy 가드에 포함한다.

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
- v0.2.23 후보 전체 테스트: 716/716 통과.
- lint: 변경 코드 오류 0. 기존 `functions/api/gemini.js`의 `no-useless-escape` 경고 2개만 유지.
- production build 통과.
- Dashboard chunk: 370.81 kB raw / 101.51 kB gzip.
- Dashboard CSS: 61.49 kB raw / 11.61 kB gzip.
- 탭별 local Speaker controller lazy chunk: 7.25 kB raw / 2.51 kB gzip. 공용 playback engine은 24.87 kB raw / 6.56 kB gzip이며 둘 다 Speaker 유휴 첫 화면에는 로드하지 않는다.
- Display Widget chunk: 6.11 kB raw / 2.33 kB gzip.
- OBS 정적 경로: 383,782B raw / 117,552B gzip / 102,951B brotli.
- OBS 예산: 460,800B raw / 133,120B gzip 이내 통과.
- Worker 문법 검사와 `git diff --check` 통과.
- v0.2.23 로컬 production preview는 기본 Speaker·주요 소스·검색 모드·한영 지속성·320/375/768/1100px·320px 영문 설정·출력 버튼·금발 선을 통과했다. HTTP 오류·ntfy 요청·console error는 0, warm DCL `21.6ms`, warm long task 0, JS heap `7,896,004B`였다.

## 7. 배포 완료와 다음 관문

1. 현재 공개 frontend는 `0.2.31` / `e7a4acb1c5d6d466e3bbf93e661fc063dd69c38d`다. Pages workflow `29974560178`의 build job `89103488646`과 deploy job `89103692362`가 성공하고 같은 product SHA를 가리킨다.
2. GitHub Pages clean install·734개 테스트·build·pseudo-locale layout·30곡 local Blob 수명·OBS budget·publish와 공개 production smoke를 통과했다. ntfy 요청·HTTP 오류 0, 모바일 viewport의 hairpin·유레카 금발 선, 한국어/영어와 긴 문구 3화면×4폭을 확인했다. v0.2.31 Actions artifact와 공개 파일은 21/21 exact match다.
3. 실제 OBS G3, G4, source hide/show, 5분 scene 전환, CEF 60분 재생을 통과했다.
4. 공개 단일 탭의 Speaker 기본값·출력 버튼·언어 전환과 곡 클릭·drag 취소·이력 배치 smoke는 자동화했고, 공개 3탭 독립 재생·reload도 v0.2.18에서 통과했다. 다음 수동 관문은 모바일 Speaker 백그라운드·잠금 화면/PiP 조작과 실제 출력 장치 전환·청취다.
5. 최종 송출 관문은 사용자의 실제 청취, 명시적 승인 뒤의 비공개 방송/VOD G5, 같은 clock monitoring 경로에서의 endpoint-inclusive 5분 한 곡+짧은 반복 G6 재검증이다. 10분 run은 stress 진단으로만 남고, 현재 장치는 시작 offset 실패·5분 drift 경계/재검 필요다.
6. `graphify-out/`은 제품 커밋과 배포에 포함하지 않는다.
7. v0.2.17의 새-ID 완전 초기화는 로컬과 production 실제 브라우저+Worker에서 무자동재생까지 통과했다.
8. v0.2.18의 탭별 대기열·auto-next는 로컬과 공개 실제 세 탭, 새로고침, A 단독 실제 재생을 통과했다.

## 8. v0.2.29 배포 증거 — 2026-07-23

- 스피커와 OBS 음량은 설정 안에서 별도 프로필로 저장된다. 운영 연결 브라우저 검증에서 Speaker `0.34`, OBS 초기 `0.61`, OBS 확정 변경 `0.60`이 실제 media element 값으로 확인됐고 새로고침 뒤 `34/60`이 유지됐다.
- 설정 슬라이더 preview는 WebSocket 명령을 보내지 않았고 commit 한 번에 volume 명령 정확히 1개만 발생했다. 비활성 출력 설정은 현재 run에 전달되지 않는다.
- OBS STOP이 물리적으로 성공했지만 UI가 `폐기 중`에 남는 결함을 운영 Worker 격리 세션에서 재현했다. 로컬 `discardRequested` 보존과 root/player strong-stop snapshot 통합 관찰로 수정했으며 같은 전체 흐름에서 재생 카드 종료, Speaker 전환, 세션 410 정리까지 통과했다.
- 스피커 로컬 재생은 Worker session HTTP, WebSocket, 송신 frame이 모두 0이었다. 스피커는 경로 검증이나 OBS 상태로 중단되지 않는 일반 플레이어 경계를 유지한다.
- 번역은 `appMessageCatalog + outputMessageCatalog`의 실제 병합 surface를 기준으로 한국어/영어 648개 key, 비어 있지 않은 값과 placeholder parity를 자동 검증한다. 새 음량 UI도 양 언어 key를 동시에 추가했다.
- 전체 자동 근거는 733/733, pseudo-locale overflow 0, 30곡 Blob 예산, production browser smoke, OBS bundle budget 통과다. 실제 방송·녹화는 시작하지 않았다.
- release commit `03a062a190994a62c17c2b8307b9b7d52d9e78aa`, Pages workflow `29972538959`, deployment `5565613740`가 성공했다. 공개 파일 21/21이 Actions artifact와 exact match이며 공개 smoke의 HTTP 오류·ntfy 요청·warm long task는 0이었다.
- 아직 목표 전체 완료로 판정하지 않는다. 실제 모바일 백그라운드/PiP·물리 출력 장치 청취, OBS monitoring 청취, 명시 승인 뒤 G5, 같은 clock 경로의 G6가 남아 있다.

## 9. v0.2.30 출력별 음소거·실제 OBS 연결 증거 — 2026-07-23

- 음소거 해제 시 Speaker와 OBS가 하나의 이전 음량을 공유하던 상태 누출을 제거했다. 각 출력은 자기 마지막 양수 음량만 기억하고 복원하며, 다른 출력의 0/양수 전환에 영향을 받지 않는다.
- 자동 근거는 전체 `734/734`, 출력별 mute/unmute 계약 `33/33`, production build, pseudo-locale, Speaker network 분리, drag, 1,000곡 history, OBS closure budget 통과다. 공개 Speaker에서 로컬 media 진행과 `34/61` 프로필을 다시 확인했고 session HTTP·socket·frame은 모두 0이었다.
- 실제 OBS Browser Source의 현재 설정은 public `/widget`과 production Worker protocol 2를 사용하고 `Control audio via OBS`가 켜져 있다. source는 enabled/unmuted, volume 1, Monitor and Output이며 OBS CEF child에서 Worker 주소로 established TCP 연결 하나가 존재했다. 존재하지 않는 asset에 대한 credential 비노출 read-only 요청은 `404`여서 세션 만료나 인증 실패가 아닌 정상 연결임을 확인했다.
- 이 확인 동안 OBS streaming/recording은 모두 OFF였고 LOAD/PLAY도 보내지 않았다. 따라서 “연결 구성과 CEF transport가 살아 있다”는 증거이지, v0.2.30에서 mixer meter·청취·녹화 PCM을 새로 재측정한 증거는 아니다.
- 30초 측정은 오차 관찰과 추세 기록에만 쓴다. 30초마다 seek/restart/playbackRate/reconnect를 실행하지 않으며 established OBS route를 끊지 않는다. 실제 기준점 재설정은 곡 자연 종료 뒤 다음 run이 `position: 0`으로 시작할 때 한 번만 수행한다.
- release artifact는 공개 CDN 21/21과 exact match다. 남은 관문은 지원 모바일 환경의 백그라운드/PiP·물리 장치 전환, 사용자 OBS monitoring 청취, 명시 승인 뒤 G5, 같은 clock 경로의 endpoint-inclusive 5분 G6다.

## 10. v0.2.31 Speaker 페이지 수명·공개 배포 증거 — 2026-07-23

- Speaker 로컬 WAV가 실제 재생되는 동안 앱에 `visibilitychange`와 보존형 `pagehide(persisted=true)`를 전달해도 같은 media source를 유지했고 재생 시간이 계속 증가했으며 `paused=false`였다. 이 경로에서 session HTTP, WebSocket, 송신 frame, Worker host 요청은 모두 0이었다. 따라서 앱 자체의 페이지 수명 검사가 Speaker를 정지·분리·재연결하지 않는다는 것은 공개본에서 확인됐다. 실제 Android/iOS가 백그라운드 탭을 동결하는 정책은 별도 실기기 관문이다.
- YouTube 결과에 썸네일이 없거나 로드가 실패해도 제3자 placeholder 서비스에 요청하지 않는다. 공개 smoke는 로컬 textless SVG data URL과 locale catalog의 영어 대체 텍스트를 확인했고, literal `alt`를 포함하는 source guard와 한국어/영어 key parity가 이를 회귀로 고정한다.
- 공개 Dashboard는 Speaker 기본, 두 출력 선택, YouTube 단일 상위 소스와 Search/Playlist, Setlink, Meloming, 한국어→영어→reload, 320/375/768/1100px, 320px 영문 설정, 흰 hairpin과 3px 금발 선을 통과했다. HTTP 오류·legacy ntfy 요청·warm long task는 0, warm DCL은 `24.1ms`, JS heap은 `8,368,268B`였다.
- 30초 관찰 정책은 구현과 테스트가 일치한다. OBS adapter는 playing/paused/buffering/ended lifecycle을 즉시 전송하고 position만 30초 간격으로 제한한다. 5분 fixture는 30~270초의 position 9건과 command 0건을 증명한다. Dashboard는 절대 position+단조 시계로 표시만 재기준화하고, 새 run은 이전 시간을 상속하지 않고 기본 0초에서 시작한다. 관찰값은 seek·restart·playbackRate·route 전환·reconnect를 만들지 않는다.
- release commit `e7a4acb1c5d6d466e3bbf93e661fc063dd69c38d`, Pages workflow `29974560178`, build `89103488646`, deploy `89103692362`가 성공했다. Actions artifact에서 manifest를 제외한 실제 게시 파일을 공개 URL에서 다시 내려받아 SHA-256으로 비교했고 `21/21` exact match였다.
- 목표는 아직 완료로 판정하지 않는다. 실제 모바일 백그라운드/PiP·잠금 화면·물리 출력 장치 청취, 사용자 OBS monitoring 청취, 별도 명시 승인 뒤 G5, 같은 audio clock/저지연 performer monitoring 경로의 곡 단위 G6가 남아 있다. 방송·녹화는 시작하지 않았다.
