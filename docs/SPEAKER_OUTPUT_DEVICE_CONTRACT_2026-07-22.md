# Speaker 출력 장치 선택 계약

## 목적

Speaker는 일반 웹 플레이어다. 브라우저가 명시적 오디오 출력 장치 선택 API를 제공할 때 사용자는 시스템 전체 기본 장치를 바꾸지 않고 Rekasong이 들릴 스피커·헤드폰을 고를 수 있다.

이 설정은 개인 감상용 Speaker에만 적용한다. OBS Browser Source, OBS mixer, 방송 gain, output lease, player 후보, WebSocket에는 어떤 명령이나 상태 변화도 만들지 않는다.

## 지원 범위

장치 선택 UI는 아래 두 API가 모두 있을 때만 표시한다.

1. `navigator.mediaDevices.selectAudioOutput()`
2. 현재 media element의 `setSinkId()`

둘 중 하나라도 없으면 앱은 별도 경고 없이 시스템 기본 출력 장치를 사용한다. 기능 미지원은 Speaker 재생 실패가 아니다.

## 상태와 수명

| 상태 | 의미 | 사용자 행동 |
|---|---|---|
| `unsupported` | 브라우저가 명시적 장치 선택을 지원하지 않음 | 시스템 기본 장치로 계속 재생 |
| `default` | 시스템 기본 출력 장치 사용 | 다른 장치 선택 가능 |
| `choosing` | 브라우저의 장치 선택 창을 기다리는 중 | 중복 선택만 잠금, 재생은 유지 |
| `selected` | 선택한 장치 ID를 새·현재 Speaker media에 적용 | 다시 선택 또는 기본값 복귀 |
| `failed` | 선택·적용에 실패함 | 기존 출력으로 계속 재생하고 다시 선택 가능 |

선택한 `deviceId`와 표시용 `label`은 이 브라우저의 versioned localStorage에 저장한다. 탭마다 현재 재생은 독립이지만, 이후 여는 탭과 새 Speaker media는 같은 장치 선호를 사용한다. 다른 탭의 storage event로 현재 media를 원격 전환하지 않는다.

## 전이

| 현재 상태 + 이벤트 | 다음 상태 | media 결과 |
|---|---|---|
| `default`/`selected` + 장치 선택 시작 | `choosing` | 현재 재생 유지 |
| `choosing` + 사용자 장치 선택 + 적용 성공 | `selected` | 현재 Speaker media만 새 장치로 전환 |
| `choosing` + 사용자가 취소하거나 API 실패 | `failed` | 기존 장치와 재생 유지 |
| `selected` + 시스템 기본으로 복귀 성공 | `default` | 현재 Speaker media에 빈 sink ID 적용 |
| 저장된 장치 + 새 media mount | `selected` 유지 | 재생과 독립적으로 best-effort 적용 |
| 저장된 장치 적용 실패 | `failed` | media를 pause·detach하지 않고 기본/기존 출력으로 계속 재생 |
| `selected` + OS `devicechange` + 같은 sink 재적용 성공 | `selected` 유지 | 같은 media와 재생을 그대로 유지 |
| `selected` + OS `devicechange` + sink 소실 | `failed` | 시스템 기본 sink를 best-effort로 적용하고 다시 선택 행동 제공 |
| 어떤 상태 + OBS 선택 | 상태 보존 | OBS route와 gain에는 적용하지 않음 |

## 불변식

1. 장치 선택 실패·취소·권한 거부는 곡을 pause, stop, seek, detach하거나 `failed` playback run으로 바꾸지 않는다.
2. `setSinkId()`를 호출하기 전후에 play/pause 명령을 만들지 않는다.
3. 장치 선택 중에도 Speaker 재생·일시정지·탐색·볼륨·스킵은 사용할 수 있다.
4. 장치 ID는 Worker, OBS, Widget URL, 원격 동기화 payload로 보내지 않는다.
5. 저장 실패는 현재 장치 전환 성공을 취소하지 않고 재생을 막지 않는다.
6. 장치 label은 사용자에게 보여 주는 로컬 정보일 뿐 연결 증거나 재생 권위가 아니다.
7. 현재 element가 없어도 사용자가 승인한 선호는 저장하고 다음 Speaker element에 적용한다.
8. OBS 모드의 media element에는 Speaker sink를 적용하지 않는다.
9. `devicechange`는 timer나 polling을 만들지 않고, 겹친 이벤트는 직렬화·병합한다.
10. 장치 검사 중 시작된 새 사용자 선택은 오래된 실패나 기본 sink 폴백이 덮어쓰지 않는다.

## 사용자 문구 원칙

- 지원되지 않는 브라우저에는 복잡한 기술 설명을 노출하지 않는다.
- 실패 문구는 “기존 출력으로 계속 재생됩니다”와 “다시 선택” 행동을 함께 말한다.
- 한국어·영어 문구를 같은 semantic key로 제공한다.

## 검증

- 지원 API가 모두 있을 때만 UI가 나타난다.
- 선택 성공, 사용자 취소, `setSinkId` 거부, 저장 실패가 각각 재생 명령을 만들지 않는다.
- 새 media와 현재 local controller 모두 선택한 sink를 best-effort 적용한다.
- 기본값 복귀는 빈 sink ID를 사용한다.
- USB/Bluetooth 장치 제거는 같은 media element에서 선택 sink 재검사→기본 sink 폴백 순서로 처리한다.
- 연속 장치 이벤트는 중복 `setSinkId` 폭주를 만들지 않고, dispose 뒤 늦은 실패는 UI를 바꾸지 않는다.
- Speaker 장치 선택이 OBS command·route·volume profile을 건드리지 않는다.
- 실제 지원 브라우저에서는 장치 선택 UI 접근성 이름, 실패 안내, 재생 지속을 확인한다.
