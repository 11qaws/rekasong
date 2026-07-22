# OBS 리모컨 조작 확인 계약

## 목적

OBS 모드에서는 이 기기의 스피커가 조용하므로 스트리머가 리모컨 버튼·탐색·음량 조절이 실제 On-Air 플레이어에 반영됐는지 귀로 바로 확인할 수 없다. 마지막 사용자 조작을 정확한 플레이어 증거에 연결해 다음을 구분한다.

1. 사용자가 조작을 요청함
2. 서버가 명령을 대상 플레이어에 전달함
3. 대상 플레이어가 같은 명령을 실제 미디어에 적용함
4. 실제 재생 상태가 요청과 일치함

이 표시는 리모컨 신뢰성을 위한 보조 증거다. OBS Audio Mixer, 녹화 트랙, 최종 방송 음성 또는 마이크↔MR 싱크를 증명하지 않는다.

## 범위

- 실제 active run의 `outputMode === 'obs'`일 때 사용자가 누른 `play`, `pause`, `seek`, `volume`만 추적한다.
- 자동 LOAD, 자동 다음 곡, STOP, route 전환, 오디오 점검은 각각 기존 생애주기 UI를 사용하며 이 작은 표시를 덮어쓰지 않는다.
- Speaker 조작은 추적하지 않는다. Speaker는 사용자가 이 기기에서 직접 듣는 일반 웹 플레이어이며 OBS 확인 상태 때문에 조작이나 표시가 바뀌지 않는다.
- Worker·플레이어의 기존 Protocol v2 메시지와 snapshot만 사용한다. 새 polling, heartbeat, Durable Object write, WebSocket message를 추가하지 않는다.

## 상태의 대상과 수명

한 상태 레코드는 **현재 Dashboard 탭에서 가장 최근에 보낸 OBS 사용자 조작 한 건**에만 속한다.

| 필드 | 의미 |
|---|---|
| `commandId` | Coordinator가 발급하고 플레이어가 되돌려준 정확한 명령 식별자 |
| `entryId`, `runId` | 조작 대상 playback run |
| `action` | `play`, `pause`, `seek`, `volume` |
| `requestedValue` | seek 초 또는 volume 퍼센트. play/pause는 없음 |
| `phase` | `waiting`, `confirmed`, `delayed`, `failed` |
| `requestedAt`, `observedAt` | 이 탭의 표시 수명과 지연 판정용 시각 |
| `confirmedValue` | 플레이어가 실제 적용했다고 보고한 seek/volume 값 |

새 사용자 조작은 이전 표시를 교체한다. run이 바뀌거나 Speaker로 이동하거나 현재 곡이 끝나면 레코드를 제거한다. 다른 탭이나 새로고침으로 승계하지 않고 `localStorage`에 저장하지 않는다.

## 전이

| 현재 상태 | 이벤트 | 다음 상태 | 사용자 의미 |
|---|---|---|---|
| 없음 | 유효한 OBS 사용자 명령 발급 | `waiting` | 플레이어의 실제 적용 증거를 기다림 |
| `waiting` | 같은 `commandId`의 `command_failed` | `failed` | 적용하지 못했으며 다시 시도해야 함 |
| `waiting` | 같은 `commandId`의 SEEK 적용 + 위치 일치 | `confirmed` | 해당 위치가 실제 적용됨 |
| `waiting` | 같은 `commandId`의 VOLUME 적용 + 음량 일치 | `confirmed` | 해당 gain이 실제 적용됨 |
| `waiting` | 같은 `commandId` 뒤 실제 `playing`/`paused` | `confirmed` | play/pause의 물리 상태가 일치함 |
| `waiting` | 5초 동안 위 증거 없음 | `delayed` | 재생을 끊지 않고 OBS 화면·믹서 확인 또는 재시도를 안내 |
| 모든 상태 | 다른 run·Speaker·현재 곡 종료 | 없음 | 오래된 증거를 현재 곡에 표시하지 않음 |
| 모든 상태 | 더 늦게 도착한 다른 `commandId` | 유지 | 다른 명령의 증거로 현재 요청을 확정하지 않음 |

`COMMAND_ACK`는 서버가 명령을 받았다는 증거일 뿐 `confirmed` 조건이 아니다. `command_applied`와 실제 media event만 적용 증거로 사용한다.

## 플레이어 증거 보존

Worker의 `confirmedPlayback`은 플레이어가 보낸 authoritative run event를 반영할 때 다음을 함께 보존한다.

- `commandId`: `command_applied` 또는 `command_failed`가 가리키는 정확한 명령
- `commandType`: SEEK/VOLUME처럼 플레이어가 명시적으로 보고한 적용 종류, 없으면 `null`
- `event`: 마지막 authoritative event
- `position`, `volume`, `status`: 플레이어가 실제 보고한 값

기존 player event wire 형식과 validation은 바꾸지 않는다. snapshot의 선택적 진단 필드만 보존하므로 구버전 플레이어의 이벤트도 계속 허용한다.

## UI 원칙

- 메인 헤더나 현재 재생 카드에 새 큰 패널을 만들지 않는다.
- 톱니 안 OBS 설정에 한 줄짜리 작은 응답 카드로 둔다.
- `waiting`: 기다리라는 행동을 말한다.
- `confirmed`: 별도 행동이 필요 없다고 말하고 실제 적용 값을 표시한다.
- `delayed`: 재생을 중단하지 않았음을 먼저 밝히고 OBS 화면·믹서 확인 또는 같은 조작 재시도를 안내한다.
- `failed`: 연결 상태를 확인한 뒤 다시 조작하도록 안내한다.
- 상태가 없으면 “조작하면 실제 적용 결과를 여기서 확인할 수 있음”만 조용히 표시한다.
- 모든 앱 작성 문구는 `ko/en` semantic message key로 제공한다.

## 불변식

1. 다른 `commandId`, 다른 `entryId/runId`, 다른 player/lease의 증거로 확정하지 않는다.
2. seek·volume은 요청값과 플레이어 적용값이 허용 오차 안에서 일치할 때만 확정한다.
3. 단순 ACK, desired transport, optimistic slider 값은 실제 적용 증거가 아니다.
4. 확인 지연이나 실패는 STOP, 재전송, route 해제, Speaker 잠금 또는 자동 fallback을 만들지 않는다.
5. 표시를 위해 새 서버 메시지, heartbeat, storage write를 만들지 않는다.
6. Speaker UI와 transport에는 이 상태를 전달하지 않는다.
7. 실제 OBS mixer·녹화·방송 검증 문구와 리모컨 적용 확인 문구를 섞지 않는다.

## 검증

- 정확한 command/run identity만 `confirmed`로 전이
- stale command와 다른 run 증거 무시
- seek/volume 실제 값 불일치 시 대기 유지
- `command_failed`와 5초 지연의 서로 다른 안내
- Speaker 선택·재생 코드와 Worker 전송량에 변화 없음
- 한국어·영어 catalog와 하드코딩 source guard 통과
- 기존 Protocol v2, continuity, bundle budget 회귀 통과
