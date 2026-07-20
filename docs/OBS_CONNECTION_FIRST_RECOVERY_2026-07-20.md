# OBS 연결 우선 복구와 스피커 재연결 설계

## 사용자에게 보이는 원칙

1. 스피커 모드는 일반 음악 플레이어다. 창 전환, PiP, 백그라운드, 모바일 절전으로 연결이 잠시 흔들려도 로컬 오디오를 임의로 끊지 않는다.
2. OBS 모드는 송출 사고를 막기 위해 source 증거를 엄격하게 본다. 다만 WebSocket 재연결 자체는 소스가 사라졌다는 증거가 아니므로 현재 오디오 그래프를 보존한다.
3. 연결이 복구되는 동안에는 “재생 성공”이라고 표시하지 않는다. 사용자가 누른 명령의 결과가 모호하면 다시 재생하지 않고, 현재 상태와 다음 행동만 안내한다.
4. 같은 스피커 버튼을 다시 누르면 스피커의 `unknown` 상태를 복구하는 전용 동작으로 처리한다. 먼저 deactivate의 실제 완료를 확인하고, 그 다음에만 다시 activate한다.

## OBS 모드 상태별 동작

| 상태 | 로컬 오디오 | UI | 허용 동작 |
|---|---|---|---|
| 연결됨 + sourceActive/sourceVisible true | 유지 | OBS 송출 중 | 재생·일시정지·탐색 |
| WebSocket 재연결 중 | 유지 | OBS 연결 확인 중 | 새 재생 명령은 대기/거부, 자동 재생 금지 |
| sourceActive 또는 sourceVisible false | 즉시 안전 정지 | OBS 소스 확인 필요 | 사용자가 source를 복구한 뒤 새 activate |
| 동일 OBS player 재연결 + capability/source 증거 회복 | 유지, 자동 재개 없음 | OBS 연결 복구됨 | 사용자가 재생 재시도 |
| 후보 0개 또는 2개 이상 | 유지 중인 재생은 보존 | OBS 플레이어 수를 1개로 맞추라는 안내 | 후보가 하나가 된 뒤 다시 선택 |

## 스피커 꼬임 복구

- Worker가 `target_disconnected`를 기록하면 lease는 `unknown`으로 남긴다. 이것은 재생 여부를 추측하지 않는 서버 안전 규칙이다.
- 스피커 player가 같은 `playerInstanceId`로 돌아오면 heartbeat만으로 자동 `ready`로 만들지 않는다. 스피커는 OBS source attestation이 없기 때문이다.
- 사용자가 스피커 버튼을 다시 누르면 컨트롤러는 `unknown → deactivating → inactive`를 허용한다. 이때 중간 `unknown` snapshot은 복구 intent를 취소하지 않는다.
- `output_deactivated` 또는 inactive snapshot을 받은 뒤에만 스피커를 재활성화한다. 다른 탭의 speaker candidate는 절대 자동 채택하지 않는다.
- 복구가 제한 시간 안에 완료되지 않으면 “스피커 연결을 확인한 뒤 다시 누르세요”를 표시하고, 영구 잠금이나 무음 fallback은 만들지 않는다.

## 검증 순서

1. 스피커 정상 재생 → 탭 전환/PiP/백그라운드 → 재생 위치와 버튼 조작이 유지되는지 확인한다.
2. 스피커 socket 종료 → 동일 player 재연결 → 스피커 버튼 재선택 → inactive 증거 → 재활성화 순서를 확인한다.
3. OBS source hide/show는 strict 안전 정지로 분리하고, 단순 socket 종료는 로컬 그래프 보존으로 확인한다.
4. OBS player 재연결 heartbeat가 lease를 `output_reconnected`로 복원하되, active run이나 자동 PLAY를 만들지 않는지 확인한다.
5. 후보 0/중복/이전 탭 잔류/제어권 상실을 각각 재현하고, 버튼이 이유와 다음 행동을 보여주는지 확인한다.

## 현재 구현과 남은 실제 OBS 확인

- 자동 검증: adapter 연결 우선, Worker OBS 재연결 복구, speaker unknown deactivation 복구, 후보 중복 차단.
- 실제 OBS 필요: CEF 오디오 캡처, mixer meter, source hide/show, scene/PiP 전환, 장시간 kara­oke drift.
- 배포 전 기준: `npm test`, lint, build, Worker syntax, OBS bundle budget, 실제 OBS 수동 acceptance를 모두 통과해야 한다.
