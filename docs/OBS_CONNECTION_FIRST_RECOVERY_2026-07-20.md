# OBS 연결 우선 복구와 스피커 재연결 설계

## 사용자에게 보이는 원칙

1. 스피커 모드는 일반 음악 플레이어다. 창 전환, PiP, 백그라운드, 모바일 절전으로 연결이 잠시 흔들려도 로컬 오디오를 임의로 끊지 않는다.
2. OBS 모드는 새 경로를 활성화할 때 source 증거를 엄격하게 본다. 다만 이미 연결된 경로의 WebSocket 재연결이나 scene visibility 변화는 소스가 물리적으로 사라졌다는 증거가 아니므로 현재 오디오 그래프를 보존한다.
3. 연결이 복구되는 동안에는 새 명령을 자동 재생하지 않는다. 명령 결과가 모호하면 현재 곡을 끊지도, 같은 명령을 되풀이하지도 않고 서버의 최신 상태와 사용자가 할 다음 행동을 안내한다.
4. 스피커는 서버 경로가 아니라 각 탭의 일반 웹 플레이어다. 다른 탭, OBS 제어권, heartbeat, 후보 수 때문에 스피커 조작을 막지 않는다.

## OBS 모드 상태별 동작

| 상태 | 로컬 오디오 | UI | 허용 동작 |
|---|---|---|---|
| 연결됨 + active/visible 미관측 또는 true | 유지 | OBS 송출 중 | 재생·일시정지·탐색 |
| WebSocket 재연결 중 | 유지 | OBS 연결 확인 중 | 새 재생 명령은 대기/거부, 자동 재생 금지 |
| sourceActive 또는 sourceVisible false telemetry | 이미 성립한 graph 유지 | OBS 장면·소스 상태 확인 | 새 activate는 막되 명시적 정지·해제는 허용 |
| 동일 OBS player 재연결 + OBS capability | 유지, 자동 명령 없음 | OBS 연결 복구됨 | 살아 있는 재생 상태를 다시 확인하고 명시적 조작 허용 |
| source refresh·OBS 재시작으로 새 player ID 생성 | 이전 페이지의 graph는 종료, 새 페이지는 무음 | 이전 경로 확인 불가 | 사용자가 `송출 경로 완전 초기화`를 승인하면 연결된 새 출력부터 정지하고 오래된 경로 잠금을 해제한 뒤 스피커로 복귀 |
| 후보 0개 또는 2개 이상 | 유지 중인 재생은 보존 | OBS 플레이어 수를 1개로 맞추라는 안내 | 후보가 하나가 된 뒤 다시 선택 |

OBS browser API에는 초기 source active/visible getter가 없으므로, 이벤트가 오기 전의 상태는 `false`가 아니라 `unobserved`다. OBS binding과 최신 heartbeat가 있는 unobserved 후보는 새 활성화를 허용한다. 반대로 callback으로 실제 `false`가 관측되면 새 활성화는 차단한다. 초기 미관측을 비활성으로 오인하면 이미 활성 장면에서 페이지를 연 정상 사용자가 영구 `OBS 플레이어 없음`에 갇힌다.

정확히 한 OBS player가 연결돼 있고 callback으로 `sourceActive=false` 또는 `sourceVisible=false`가 명시적으로 관측됐다면 일반 candidate 부재나 연결 실패가 아니다. UI는 `OBS 소스를 표시해 주세요`와 `Rekasong 눈 아이콘을 켠 뒤 OBS를 다시 선택하세요`를 안내하고 완전 초기화를 권하지 않는다. source를 다시 표시하면 기존 socket과 media graph를 재사용해 즉시 재선택할 수 있어야 한다.

`sourceActive/sourceVisible` 콜백은 둘이 연속으로 들어와도 한 microtask에서 합쳐 storage-free heartbeat 한 번만 즉시 보낸다. Worker는 runtime 값이 실제로 바뀐 경우에만 control에 최신 snapshot을 broadcast한다. 따라서 설정 화면은 10초 주기 heartbeat를 기다리지 않지만, 평상시에는 heartbeat마다 snapshot을 뿌리거나 Durable Object storage를 쓰지 않는다.

### 사용자가 승인한 완전 초기화

- 일반 `모든 출력 정지`는 지금도 기존 lease target의 정확한 strong-stop 증거를 요구한다. 사라진 출력이 있는데도 안전하다고 추측하지 않는다.
- `송출 경로 완전 초기화`만 별도의 `forceReset` 권한을 사용한다. 현재 연결된 모든 v2 출력에는 정지·source 분리를 요구하고 ACK를 기다린다.
- source refresh·OBS 재시작으로 이전 `playerInstanceId`가 이미 사라졌다면 그 출력의 정지를 증명했다고 기록하지 않는다. `output_inactive + recoveryOverride`로 불확실성을 남기되, 사라진 대상의 ACK를 영원히 기다리지는 않는다.
- 정지 명령을 받은 새·대기 출력이 ACK 전에 사라져도 남은 연결의 정지 결과를 수렴시킨 뒤 잠금을 해제한다. 사라진 출력은 `liveTargetLossUnverified`로 남는다.
- 완료 뒤 Worker의 선택 경로를 비우고 Dashboard는 스피커 기본 상태로 돌아간다. 중단된 OBS 곡은 `failed`로 보존해 사용자가 재시도하거나 버리게 하며, Speaker나 OBS 어디에서도 자동 재생하지 않는다.
- 앱이 증명할 수 없는 사라진 출력은 사용자에게 숨기지 않는다. 완료 안내는 OBS Audio Mixer에 남은 소리가 없는지 직접 확인한 뒤 OBS를 다시 선택하라고 말한다.

## 스피커 독립 동작

- 대시보드가 소유한 로컬 `<audio>`가 스피커 재생의 전부이며 Worker player나 출력 lease를 만들지 않는다.
- 각 탭·창은 독립적으로 재생할 수 있다. 다른 탭의 재생, 제어권, heartbeat, candidate count를 관측하거나 제한하지 않는다.
- 앱 기본값은 스피커이며 로컬 play/pause/seek/volume/skip은 OBS 연결 상태와 무관하게 동작한다.
- OBS에서 스피커로 바꿀 때 기존 OBS STOP은 best-effort다. 그 ACK나 경로 해제 결과가 로컬 스피커를 잠그지 않는다.

## 검증 순서

1. 스피커 정상 재생 → 탭 전환/PiP/백그라운드 → 재생 위치와 버튼 조작이 유지되는지 확인한다.
2. 여러 탭에서 스피커를 각각 재생하고 Worker control 연결을 끊어도 각 탭의 transport가 잠기거나 정지하지 않는지 확인한다.
3. OBS source hide/show와 단순 socket 재접속 모두 established graph를 보존하고, 새 OBS 활성화만 정확한 후보 증거를 요구하는지 확인한다.
4. 같은 OBS player가 재접속하면 첫 `player_hello` 응답에서 lease를 즉시 `output_reconnected`로 복원하되, active run을 새로 만들거나 자동 PLAY하지 않는지 확인한다.
5. 재접속 후 살아 있는 media graph가 현재 `playing`/`paused` 상태를 한 번 다시 보고하고, 이 보고가 실패하거나 결과 불명이어도 실제 오디오를 정지·분리하지 않는지 확인한다.
6. 후보 0/중복/이전 탭 잔류/제어권 상실을 각각 재현하고, 버튼이 이유와 다음 행동을 보여주는지 확인한다.
7. source refresh로 새 player ID를 만든 뒤 완전 초기화가 현재 연결된 출력의 정지를 기다리고, 사라진 이전 출력은 미확인으로 남긴 채 inactive로 수렴하며, 새 페이지에서 media가 무음인 상태로만 OBS를 다시 선택할 수 있는지 확인한다.

## 현재 구현과 남은 실제 OBS 확인

- 자동 검증: adapter 연결 우선, 초기 active/visible 미관측과 명시적 false 분리, Worker OBS hello 단계 즉시 재연결 복구, 살아 있는 playback 상태 재보고, 보고 결과 불명 시 media graph 보존, 장면 telemetry 즉시 관측·graph 보존, Speaker 독립 로컬 재생, OBS 후보 중복 차단, 새 player ID가 생긴 source refresh의 명시적 완전 초기화·무자동재생·재선택.
- 실제 OBS 확인: 초기 이벤트 0건에서도 READY·후보 1개·OBS route 활성화, G2 점검 완료, Rekasong mixer meter 입력, source hide/show 중 route 유지와 16/16 marker 완료, G4 녹화 artifact까지 확인했다.
- 실제 OBS 보조 확인: OBS UI의 Browser Source refresh와 OBS 프로세스 재시작 뒤 test profile·scene·Browser source·FIFINE source·mixer 구성이 보존됐다. 이 확인은 만료된 세션 URL의 실제 route 재연결 증거가 아니므로 live-session 변형은 잔여 관문이다.
- 실제 OBS 잔여: 사용자 청취, scene 전환, 유효한 live-session URL에서 source refresh·OBS 재시작 후 완전 초기화와 재선택, 비공개 방송 artifact, performer monitoring 경로의 karaoke 싱크.
- 배포 전 기준: `npm test`, lint, build, Worker syntax, OBS bundle budget, 실제 OBS 수동 acceptance를 모두 통과해야 한다.

## 2026-07-22 OBS 플레이어 수명주기 감사

OBS 출력은 단순 화면 갱신과 실제 출력 경로 교체를 구분한다. 다음 표를 컴포넌트 수명주기의 고정 계약으로 사용한다.

| 발생 조건 | 플레이어 연결 재생성 | 재생 그래프 정지 | 이유 |
|---|---:|---:|---|
| 부모 컴포넌트의 일반 재렌더 | 아니오 | 아니오 | 렌더는 출력 경로 변경 증거가 아니다. |
| 같은 `playerInstanceId`를 담은 새 객체 전달 | 아니오 | 아니오 | 객체 주소가 아니라 프로토콜 신분 값으로 수명을 판정한다. |
| 언어·설명·관측 콜백 변경 | 아니오 | 아니오 | 표시와 관측은 실제 오디오 경로의 소유권을 갖지 않는다. |
| OBS scene active/visible 변경 | 아니오 | 아니오 | 장면 전환 telemetry이며 Browser Source 종료 증거가 아니다. |
| WebSocket 일시 단절·재연결 | 기존 adapter 재사용 | 아니오 | 살아 있는 media graph를 보존하고 같은 플레이어 신분으로 재보고한다. |
| URL·room·token·client kind·실제 player ID 변경 | 예 | 예 | 다른 연결 계약 또는 다른 출력 신분으로 넘어가는 명시적 경계다. |
| 컴포넌트 실제 제거·세션 종료·명시적 strong stop | 종료 | 예 | 더는 출력 페이지가 존재하지 않거나 사용자가 정지를 명령한 강한 경계다. |

- 자동 생성한 `playerInstanceId`는 페이지 컴포넌트의 `useRef`에 한 번만 만들고 보존한다. React StrictMode의 개발용 effect cleanup/setup에서도 같은 신분을 사용하므로 잠깐 나타나는 유령 중복 플레이어를 만들지 않는다.
- effect 의존성은 `identity` 객체 자체가 아니라 `identityLifecycleKey`를 사용한다. 따라서 `{ playerInstanceId: 'same-id' }` 객체가 다시 만들어져도 established OBS graph를 `dispose()`하지 않는다.
- 실제 OBS Browser Source 페이지가 사라지는 unmount는 계속 강한 종료 경계다. 이 경우 로컬 오디오를 멈추고 source를 분리하는 것이 맞다.

## 2026-07-23 제어 소켓 복구와 활성 곡 소유권

OBS 플레이어 소켓과 대시보드 제어 소켓은 서로 다른 수명이다. 제어 소켓이 잠시 끊겨도 OBS의 media element는 계속 재생할 수 있고, 기존 제어 코디네이터는 자신이 만든 `entryId/runId/leaseEpoch/playerInstanceId`를 기억한다. 재연결 뒤 Worker의 새 snapshot이 이 네 값과 일치해야만 같은 곡의 조작 권한을 다시 연다.

이때 단순 연결 손실에서 제어 코디네이터를 새로 만들면 안 된다. 새 인스턴스는 살아 있는 곡을 자신이 만든 적이 없으므로 `unowned active run`으로 판단하고, 실제 소리가 계속 나는데도 일시정지·정지 같은 후속 조작을 잠글 수 있다. 따라서 다음 계약을 고정한다.

| 제어 상태 | 복구 방식 | 활성 곡·OBS graph | 자동 명령 |
|---|---|---|---|
| `disconnected/closed` + 순수 `connection_lost` | 같은 coordinator에서 socket만 reconnect | 소유 identity와 graph 모두 보존 | 없음 |
| 같은 reconnect가 `connecting/negotiating/ready 증명 대기` 중 | 기존 시도 대기, 두 번째 socket·coordinator 생성 금지 | 보존 | 없음 |
| reconnect 뒤 exact run/lease snapshot 일치 | connection lock만 해제 | 동일 곡을 명시적으로 계속 조작 가능 | 없음 |
| 복구 timer가 이미 READY인 활성 곡 뒤늦게 실행 | `already_ready`, coordinator 교체 금지 | 동일 곡과 소유 identity 보존 | 없음 |
| 명령 결과 불명·identity 불일치 | 기존 coordinator와 불확실성 보존 | 임의 정지·재생 금지 | 사용자가 완전 초기화를 명시할 때만 emergency stop |
| 활성 곡이 없는 `superseded`, owner release, 시작 협상 고착 | 새 권한 증거가 필요할 때만 coordinator 교체 | 어떤 곡도 자동 채택하지 않음 | 없음 |

`superseded`·invalid snapshot처럼 권한이 불명확하더라도 활성 곡 증거가 남아 있으면 일반 재연결 버튼은 coordinator를 폐기하지 않는다. 살아 있는 곡의 소유권을 복구 동작 자체가 없애지 않도록 그대로 잠그고, 사용자가 명시적으로 완전 초기화를 선택할 때만 strong-stop 경계를 통과한다.

대시보드의 빠른 350ms/1.2s/3s 복구 요청과 controller 내부 1.5초~30초 backoff는 모두 이 분기를 공유한다. 여러 타이머가 겹쳐도 이미 협상 중이면 `reconnect_in_progress`, fresh snapshot으로 활성 곡이 복구된 뒤 늦게 실행되면 `already_ready`만 반환하며 coordinator, active run, route, media graph를 바꾸지 않는다.
