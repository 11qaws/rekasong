# OBS 믹서 사용자 확인 계약

## 목적

앱의 자동 점검은 On-Air 플레이어가 기준 신호를 실제 재생했다는 G2까지만 증명한다. 세팅한 사람이 OBS Audio Mixer의 정확한 On-Air 소스 미터에서 같은 pulse를 직접 본 경우에만 G3 사용자 확인으로 기록한다.

이 기록은 자동 측정 인증서가 아니다. OBS 녹화, 실제 송출, 마이크와 반주의 상대 싱크를 증명하지 않는다.

## 상태의 대상과 수명

- 대상: 한 Dashboard 사용자가 한 OBS 세션의 한 `playerInstanceId`에 대해 수행한 mixer meter 육안 확인.
- 식별자: `room + playerInstanceId + checkId`.
- 저장 위치: 브라우저 `localStorage`. URL, token, 오디오 데이터는 저장하지 않는다.
- 수명: 같은 room과 player identity를 유지하는 동안 “이 세팅에서 한 번 확인함”으로 표시한다. room 또는 player identity가 바뀌면 이전 결과는 stale이다.
- OBS mute, gain, monitor, filter, track 설정 변경은 앱이 직접 감지하지 못한다. 사용자가 이 설정을 바꾸면 반드시 점검 신호를 다시 실행한다.

## 중심 상태

| 상태 | 의미 | 가능한 행동 |
|---|---|---|
| `unknown` | 현재 route에 대한 사용자 확인 없음 | G2 점검 신호 시작 |
| `awaiting_user` | 현재 G2 신호가 실제 재생됐고 mixer 판정 대기 | `미터가 움직여요`, `미터가 움직이지 않아요` |
| `passed` | 사용자가 정확한 OBS source meter pulse를 확인 | 다시 점검 가능 |
| `failed` | 플레이어 G2는 재생됐지만 사용자가 mixer pulse를 보지 못함 | OBS 체크리스트 확인 후 다시 점검 |
| `stale` | 저장된 확인과 현재 room/player가 다름 | 현재 route에서 다시 점검 |

## 전이

| 현재 상태 + 이벤트 | 다음 상태 |
|---|---|
| `unknown/stale/failed/passed` + 현재 G2 `actualPlayingObserved` | `awaiting_user` |
| `awaiting_user` + 사용자가 미터 pulse 확인 | `passed` |
| `awaiting_user` + 사용자가 미터 pulse 미확인 | `failed` |
| `passed/failed` + room 또는 player identity 변경 | `stale` |
| 어떤 상태 + WebSocket 지연·장면 inactive·heartbeat stale | 상태 유지 |

## 불변식

1. 사용자 클릭 없이는 `passed`가 될 수 없다.
2. G2의 실제 `test_started`/marker/완료 증거가 없는 상태에서는 확인 버튼을 활성화하지 않는다.
3. `passed`는 `OBS 믹서 사용자 확인`으로만 표시한다. 녹화·송출·카라오케 싱크 완료로 승격하지 않는다.
4. `failed`, `stale`, 저장 실패는 OBS route, media graph, lease, 일반 곡 재생을 정지하거나 변경하지 않는다.
5. 확인 동작은 Worker 명령을 보내지 않으며 Cloudflare 메시지·저장을 추가하지 않는다.
6. 저장값이 손상되면 `unknown`으로 무시하고 재생을 차단하지 않는다.

## 실패 안내

미터가 움직이지 않으면 다음을 행동 순서로 보여 준다.

1. OBS Browser Source의 `Control audio via OBS`가 켜져 있는지 확인한다.
2. Audio Mixer에서 정확한 On-Air 소스가 음소거되지 않았는지 확인한다.
3. 같은 player URL을 쓰는 Browser Source를 하나만 남긴다.
4. 점검 신호를 다시 재생하고 같은 박자의 meter pulse를 확인한다.
