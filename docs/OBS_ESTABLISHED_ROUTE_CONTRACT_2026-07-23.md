# OBS 확립 경로 보존 계약 — 2026-07-23

## 1. 사용자에게 보장하는 결과

OBS 방송을 처음 선택할 때는 같은 On-Air 플레이어 주소를 쓰는 활성 Browser Source가 정확히 하나여야 한다. 하지만 한 번 정확한 플레이어에 출력 lease가 확립된 뒤에는 후보 수가 잠깐 0개나 2개로 바뀌었다는 이유만으로 현재 곡과 리모컨을 끊지 않는다.

이 계약의 우선순위는 다음과 같다.

1. 현재 lease가 가리키는 정확한 `playerInstanceId`와 `leaseEpoch`를 보존한다.
2. 재생·일시정지·탐색·음량·정지와 다음 곡 LOAD는 그 대상 한 곳에만 보낸다.
3. 추가 OBS 소스는 연결 후보일 뿐이며 기존 lease를 빼앗거나 같은 명령을 받지 않는다.
4. 후보 수 경고는 사용자가 정리할 설정 문제로 표시하고 재생 잠금이나 연결 해제로 승격하지 않는다.
5. lease 대상 자체가 사라졌거나 신원이 달라진 경우에만 경로 손실로 처리한다.

## 2. 신규 활성화와 확립 경로의 분리

| 시점 | 관측 | 판정 | 허용 동작 | 사용자 안내 |
|---|---|---|---|---|
| OBS 신규 활성화 전 | 후보 0개 | 준비 미완료 | 활성화·점검음 시작 금지 | Browser Source 주소를 넣고 소스를 켜기 |
| OBS 신규 활성화 전 | 후보 정확히 1개 | 활성화 가능 | 그 한 플레이어에 lease 요청 | 자동으로 준비됨 |
| OBS 신규 활성화 전 | 후보 2개 이상 | 대상 불명확 | 활성화·점검음 시작 금지 | 같은 주소의 소스를 하나만 남기기 |
| OBS lease 확립 뒤 | 정확한 lease 대상이 후보 1개 | 정상 | 모든 현재 경로 조작 | OBS 송출 중 |
| OBS lease 확립 뒤 | lease 대상 + 추가 후보 | 연결 유지·정리 권고 | 현재 곡, pause/play, seek, volume, stop, 다음 곡 LOAD | 현재 조작은 유지됨. 추가 소스만 제거 |
| OBS lease 확립 뒤 | 후보 0개지만 lease 대상 socket/player가 등록됨 | 장면 숨김·일시 비활성으로 간주 | 현재 경로와 곡 수명 유지 | 눈 아이콘·현재 장면 포함 여부 확인. OBS를 다시 선택할 필요 없음 |
| OBS lease 확립 뒤 | 다른 후보만 있고 lease 대상이 등록되지 않음 | 실제 대상 손실 | 새 LOAD·PLAY 완료 판정 실패, 복구 안내 | 기존 대상을 다시 연결하거나 명시적으로 초기화 |
| 어떤 상태든 | lease/epoch/run identity 불일치 | 권한 불명 | 자동 재생·대체 경로·명령 재전송 금지 | 안전 복구 또는 완전 초기화 |

후보 수는 “누구에게 처음 lease를 줄 것인가”를 정하는 조건이다. 확립 뒤의 명령 대상은 후보 목록이 아니라 이미 확정된 lease 신원이다.

## 3. 조작별 계약

| 조작 | 확립 경로 + 후보 0/2 | 이유 |
|---|---:|---|
| 현재 곡 재생·일시정지 | 허용 | 정확한 run과 lease 대상으로만 전달 |
| 탐색·음량 | 허용 | 다른 후보에 브로드캐스트하지 않음 |
| 정지·폐기 | 허용 | 안전 조작이 후보 경고 때문에 막히면 안 됨 |
| 자연 종료 뒤 다음 곡 | 허용 | 이전 run의 strong-stop 뒤 같은 lease에 새 LOAD |
| OBS 점검음 시작 | 후보 정확히 1개일 때만 허용 | 사용자가 확인할 mixer 대상을 모호하게 만들지 않음 |
| 이미 시작된 점검음 정지 | 항상 확립 대상에 허용 | 안전 정지를 후보 경고가 막아서는 안 됨 |
| OBS 신규 선택·재활성화 | 후보 정확히 1개일 때만 허용 | 새 lease 대상은 엄격하게 선택 |
| 자동 Speaker 전환·자동 route 재연결 | 금지 | 실제 방송 경로를 추측해 바꾸지 않음 |

## 4. UI 계약

- 머리핀 상태는 확립된 경로가 살아 있으면 계속 `OBS 송출 중`으로 표시한다.
- 설정의 상세 문구는 “연결이 끊겼다”가 아니라 “현재 대상과 조작은 유지된다”고 먼저 말한다.
- 중복이면 다음 행동을 `현재 곡과 리모컨은 계속 사용하고 같은 주소의 추가 소스만 제거`로 안내한다.
- 후보가 잠시 0개면 `눈 아이콘과 현재 장면 포함 여부를 확인하고 OBS를 다시 선택하지 않아도 됨`을 안내한다.
- 이 두 상태는 설정 톱니의 치명적 경고 점, 완전 초기화 요구, transport 잠금을 만들지 않는다.
- lease 대상이 실제로 사라진 경우에만 경로 확인·복구 UI를 사용한다.
- 모든 새 문구는 한국어·영어 semantic key를 동시에 추가하고 placeholder parity 검증을 통과해야 한다.

## 5. 30초 위치 관찰과 곡 단위 기준점

30초 cadence는 리모컨 표시와 OBS 플레이어의 실제 위치 차이를 관찰하는 주기다. 다음 동작은 하지 않는다.

- 곡 중간 `seek`
- 곡 중간 restart
- `playbackRate` 변경
- 출력 route 교체
- WebSocket 재연결

작은 차이는 표시 타이머만 재기준화한다. 새 오디오 기준점은 이전 곡의 strong-stop 뒤 다음 run을 `position: 0`으로 시작할 때 만든다. 최대 5분인 곡 안에서 물리 장치 clock drift가 허용 범위를 넘는다면 웹 타이머로 반주를 튕겨 맞추지 않고, 같은 audio interface/clock 경로와 OBS monitoring 설정을 고친다.

## 6. 방송 안전 경계

- 웹 프로토콜에는 OBS 스트리밍 시작·녹화 시작 명령이 없다.
- 점검음은 OBS가 streaming 중이 아님을 관측한 뒤에만 시작할 수 있다.
- 이번 자동 검증은 `streaming=false`, `recording=false`인 가짜 OBS binding과 격리 세션만 사용한다.
- 실제 스트림 키, 실제 방송 시작, 실제 녹화 시작을 사용하지 않는다.
- 실제 방송 산출물 검증 G5는 사용자의 별도 명시 승인 없이는 수행하지 않는다.

## 7. 구현·자동 검증 증거

v0.2.33 후보에서 다음을 확인했다.

- `OnAirOutputController`는 전환 완료와 다음 LOAD 가능 여부를 후보 정확히 1개가 아니라 정확한 lease 대상의 후보 포함 또는 player 등록으로 판단한다.
- `deriveOnAirOutputView`는 확립 대상이 살아 있으면 후보 0/2를 `route_ready` 또는 `player_playing_confirmed`로 유지한다.
- 중복 상태에서도 resume·stop-test 안전 동작을 허용하고, 새 점검음 시작은 정확히 한 후보일 때만 허용한다.
- lease 대상이 사라지고 다른 플레이어만 남은 fixture는 계속 `output_route_lost`로 실패한다.
- 전체 자동 테스트 `742/742`, 신규 lint 오류 0, production build, pseudo-locale 3화면×4폭, OBS 정적 closure 예산을 통과했다.
- Dashboard chunk는 `377.58 kB raw / 103.44 kB gzip`, OBS 정적 closure는 `384,105B raw / 118,430B gzip / 103,684B brotli`로 기존 상한 `460,800B raw / 133,120B gzip` 안이다.
- production Worker의 새 격리 세션과 가짜 OBS 페이지 2개를 실제 연결했다. 머리핀은 `Broadcasting through OBS`, 설정은 연결 유지 안내를 표시했고 치명적 경고 점이 생기지 않았다.
- 두 OBS 페이지가 연결된 동안 곡 LOAD→PLAY→PAUSE→PLAY→VOLUME→STOP을 완료했다. lease 대상만 재생·정지했고 추가 페이지는 source-detached·paused 상태를 유지했다.
- 테스트 세션은 HTTP `410`으로 종료됐다. 실제 방송과 녹화는 시작하지 않았다.

## 8. 배포 확인 결과와 남은 수동 관문

1. 공개 Pages는 v0.2.33 product commit `99a621b5352027d20075a7776481769dda3ea7ca`를 배포했다. workflow `29977321000`, build `89111772404`, deploy `89111947797`, deployment `5566498219`가 모두 성공했다.
2. GitHub Actions의 clean install·`742/742`·build·pseudo-locale·30곡 Blob·OBS bundle 관문이 모두 통과했다.
3. manifest를 제외한 Actions artifact와 공개 CDN 파일은 크기·SHA-256 `21/21` exact match다.
4. 공개 Speaker smoke는 session HTTP·WebSocket·송신 frame·Worker host 요청이 모두 0인 상태에서 로컬 재생과 기기-pause 복구를 완료했다.
5. 한국어·영어 연결 유지 문구는 catalog parity와 pseudo-locale을 통과했고, 배포된 Dashboard bundle은 검증 artifact와 정확히 같다.
6. 실제 사용자 OBS에서 동일 주소의 임시 두 번째 Browser Source를 만들 수 있을 때, 방송·녹화 OFF 상태에서 같은 결과를 수동 확인한다. 이 수동 항목은 자동 근거와 별도 기록한다.
