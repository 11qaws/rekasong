# Speaker / OBS 안전 정책 경계

## 결정

스피커 모드는 일반적인 음악 플레이어로 취급한다. 모바일 창 전환, PiP, BFCache, 백그라운드 타이머 지연만으로 로컬 오디오를 정지시키거나 영구 잠그지 않는다. OBS 브라우저 소스는 기존처럼 송출 사고를 막기 위해 엄격한 안전 정책을 유지한다.

> 2026-07-22 갱신: Dashboard 스피커는 더 이상 Worker 출력 후보가 아니다. 각 탭의 브라우저 로컬 플레이어이며 후보 수·lease·heartbeat 제한이 없다. 아래의 dashboard-speaker 프로토콜 내용은 구버전 연결을 정리하기 위한 하위 호환 경로다.

앱 라우팅 관점에서 Speaker 탭·창의 개수 상한은 없다. 준비 음원 접근용 인증은 재생 소유권을 소비하는 단일-use lease가 아니며, 여러 로컬 플레이어가 같은 사용자 세션에서 각자 음원을 받을 수 있다. 브라우저·OS·네트워크의 일반적인 자원 한계는 있을 수 있지만 앱이 한 Speaker 경로를 선정해 나머지를 차단하지 않는다.

## 사용자 동작 기준

| 상황 | 스피커 | OBS |
|---|---|---|
| 창 전환 / PiP / 백그라운드 | 로컬 재생 유지, 서버 출력 연결과 무관 | 제어 소켓·장면 active/visible 변화만으로는 재생 중인 그래프 유지; 실제 Browser Source 종료는 socket close로 판별 |
| heartbeat 지연 | heartbeat 자체를 보내지 않음 | 10초 간격의 상태 관측만 유지하며, 지연만으로 established route를 해제하거나 명령을 차단하지 않음 |
| 연결 중 이벤트 전송 실패 | 로컬 플레이어를 영구 잠그지 않음 | 재생 그래프는 유지하고, 결과가 불명확한 제어 명령만 복구 전까지 재전송하지 않음 |
| unknown 상태에서 같은 버튼 재선택 | 즉시 로컬 재생 가능. OBS 정리 결과는 로컬 플레이어를 잠그지 않음 | 기존 emergency/recovery 절차 유지 |
| 다른 출력으로 전환 | 재생 중 OBS 전환 금지(반주 싱크 보호) | inactive·소스·송출 증거 전까지 자동 전환하지 않음 |

## 안전 불변식

1. 새 OBS 경로 활성화는 여전히 `sourceActive=true`인 정확한 단일 Browser Source만 허용한다. 다만 이미 연결된 경로의 `sourceActive/sourceVisible=false`는 장면 전환 관측값이며 정지 명령으로 사용하지 않는다.
2. 스피커도 다른 출력으로의 자동 fallback이나 자동 재생 재개는 하지 않는다.
3. 각 로컬 스피커는 독립적이다. 다른 탭의 존재나 상태가 이 탭의 transport 조작을 잠그지 않는다.
4. OBS에서 스피커로 돌아오면 새 명령은 즉시 로컬로 보낸다. 재생 중이던 OBS 곡에는 best-effort STOP을 보내되, ACK·제어권·route 상태 때문에 스피커를 잠그지 않고 서버 Speaker 출력도 활성화하지 않는다.
5. Speaker 헤더는 Worker의 후보 수·제어권·route 전이 상태를 표시하지 않는다. 이 값들이 늦게 도착하거나 모순되어도 `연결 중`, `중복`, `이전 탭 연결`, `경로 확인 필요`로 되돌아가지 않는다.
6. `현재 곡`과 재생 시도 ID는 해당 탭의 미디어 요소에만 속한다. `localStorage`에는 이 런타임을 기록하지 않고, 다른 탭의 storage 이벤트도 이 탭의 현재 곡·재생 상태를 바꾸지 않는다. 노래책·대기열·환경 설정 같은 지속 데이터만 탭 사이에서 공유한다.
7. Speaker의 출력 선택 상태와 준비 음원 HTTP 세션 상태를 분리한다. 세션 생성 실패는 Speaker를 `경로 확인 필요`로 바꾸지 않으며, 실패 뒤 다음 재생 행동이 새 세션 생성을 명시적으로 다시 시도한다.
8. 로컬 오디오 요소가 준비되기 전 들어온 명령은 최대 12초만 기다린다. 준비되면 명령 전송 직전에 대기 타이머를 해제하고, 준비되지 않으면 해당 재생 시도를 실패로 확정해 재시도/버리기 UI로 보낸다.
9. READY evidence observer 안에서는 PLAY를 동기 호출하지 않는다. 동일 run의 PLAY를 다음 microtask로 넘기고, 그 사이 pause·stop·교체 LOAD·dispose가 있으면 예약된 자동재생을 취소한다. 엔진 재진입 방어가 사용자 화면의 영구 `준비 중`으로 숨지 않게 한다.
10. Speaker와 OBS의 볼륨은 별도 프로필이다. 현재 run이 있으면 그 run의 실제 `outputMode`만 조절하며, 유휴일 때만 선택한 모드의 값을 보여 준다. 한 프로필의 저장 실패나 변경은 다른 출력의 route·재생·gain을 바꾸지 않는다.
11. Speaker 출력 장치는 `selectAudioOutput`과 `setSinkId`가 모두 있는 브라우저에서만 선택한다. 선택·복원 실패는 play/pause/seek/stop 또는 OBS 명령을 만들지 않으며, 미지원 브라우저는 시스템 기본 출력으로 계속 재생한다. 세부 수명 계약은 `docs/SPEAKER_OUTPUT_DEVICE_CONTRACT_2026-07-22.md`를 따른다.
12. Media Session은 현재 active run의 실제 `outputMode`가 Speaker일 때만 설치한다. OS play/pause/next/seek는 기존 Dashboard handler만 호출하고, OBS run·유휴·dispose에서는 metadata와 action handler를 제거한다. 미지원·예외는 playback이나 연결 상태를 바꾸지 않는다. 세부 계약은 `docs/SPEAKER_MEDIA_SESSION_CONTRACT_2026-07-22.md`를 따른다.
13. OBS 리모컨 적용 확인은 실제 OBS run에서 마지막으로 사용자가 보낸 play/pause/seek/volume 하나만 탭 메모리로 추적한다. 정확한 command/run과 실제 media 상태·값이 맞아야 성공이며, 지연·실패는 안내만 바꾸고 재생·route·Speaker·명령 재전송을 만들지 않는다. 세부 계약은 `docs/OBS_REMOTE_CONTROL_FEEDBACK_CONTRACT_2026-07-22.md`를 따른다.

## Speaker 미디어 준비 상태

출력 상태 `speaker`와 아래 보조 상태는 서로 독립이다. 보조 상태가 실패해도 출력 선택을 OBS식 unknown/blocked로 바꾸지 않는다.

| 현재 상태 | 이벤트 | 다음 상태 | 사용자 결과 |
|---|---|---|---|
| `idle`/`failed` | 앱의 조용한 사전 준비 또는 사용자의 재생 | `initializing` | 출력 표시는 계속 Speaker |
| `initializing` | media session 생성 + 로컬 요소 준비 | `ready` | 대기 명령을 순서대로 전달 |
| `initializing` | 세션 생성 실패 또는 12초 초과 | `failed` | 현재 재생 시도만 실패로 표시, 다음 재생에서 다시 시도 |
| `ready` | play/pause/seek/volume/stop | `ready` | 일반 웹플레이어 transport |
| `ready` | 세션 credential 무효 + 이미 buffered 재생 중 | `ready` | 현재 오디오는 유지하고 곡 종료 후 credential 교체 |
| `ready` | 세션 credential 무효 + starting/failed run | `initializing` | 실패 run을 대기열 앞으로 돌리고 credential 교체 |

## 구현 지점

- `src/components/DashboardLocalSpeaker.jsx`, `src/lib/localSpeakerController.js`: 탭별 로컬 PlaybackEngine과 인증된 준비 음원 resolver.
- `src/pages/Dashboard.jsx`: 로컬/OBS 명령 경계, 원격 transport 이벤트 차단, OBS 전환 중 싱크 보호.
- `src/lib/onAirPlaybackAdapter.js`: OBS 제어 소켓 일시 손실과 장면 active/visible 변화는 그래프를 유지한다. 명시적 STOP/deactivate/emergency와 terminal teardown만 물리 정지한다.
- `workers/rekasong-session/src/index.js`: OBS heartbeat는 상태 관측과 새 후보 자격에만 사용한다. established route의 연속성은 live negotiated socket으로 판별한다.
- `src/pages/Dashboard.jsx`: Speaker 선택과 transport는 OBS 제어권·lease·후보 수와 무관하며, 연결된 OBS route는 silent-ready 상태로 유지할 수 있다.
- `src/hooks/useSyncState.js`: 공유 가능한 지속 상태와 탭 소유 재생 런타임을 분리한다. 여러 Speaker 탭은 서로 다른 곡과 run ID를 유지한다.

## 검증

- local speaker: 두 controller가 동시에 독립적으로 load/play/seek/volume/stop하며 route 명령을 만들지 않는 자동 테스트.
- media access: 여러 로컬 controller가 같은 인증 범위에서 동시에 준비 음원을 요청해도 player 등록·후보 경쟁·토큰 소비가 발생하지 않는 정적 계약.
- adapter: OBS 제어 연결 손실과 sourceActive/sourceVisible 변화 모두 그래프 유지. 명시적 정지 경로만 media를 detach.
- Worker: 정확한 29,999/30,000/59,999/60,000ms 경계와 durable alarm/storage race 테스트.
- dashboard: 로컬 Speaker 선택은 항상 즉시 반영되고 server Speaker activate/deactivate를 호출하지 않음. 기존 OBS run에는 STOP만 best-effort로 전송.
- cross-tab: 한 탭의 재생 시작이 다른 탭에 가짜 `현재 재생`을 만들지 않고, 각 탭의 기존 run/outputMode를 보존하는 자동 테스트. 구버전 Worker Speaker 후보도 여러 개가 공존할 때 정확히 하나라는 후보 수 gate로 거부되지 않는 테스트.
- autoplay: PlaybackEngine observer 재진입을 모사한 fake engine에서도 READY 직후 PLAY가 observer 밖에서 한 번만 실행되고, 그 사이 pause가 오면 stale PLAY가 0회인 회귀 테스트.
- volume: 기존 단일 값의 양쪽 프로필 승계, Speaker/OBS 독립 변경, 손상·저장 실패 fallback, 현재 run 기준 라우팅을 자동 테스트. 실제 브라우저에서도 Speaker 34%를 새로고침 뒤 복원하고 재생 지속을 확인했다.
- output device: capability gate, 선택·초기화·거부·저장 실패의 비차단 계약과 OBS 명령 부재를 자동 테스트했다. 현재 미지원 로컬 브라우저에서는 UI가 숨고 기존 Speaker 재생이 13.49초 이상 진행됨을 확인했다.
- media session: 실제 Speaker run에서만 metadata·상태·play/pause/next/seek handler를 설치하고 OBS run·idle·dispose에서 제거하는 계약, 위치 범위 제한, API 예외 비차단을 자동 테스트했다.
- OBS remote feedback: Worker가 applied/failed에서만 정확한 command ID를 확인 snapshot에 보존하고 receipt ACK에서는 보존하지 않는지, Dashboard가 exact run/command/value 또는 실제 play/pause 상태만 성공으로 판정하는지, Speaker run과 새 protocol message가 전혀 생기지 않는지를 자동 테스트했다. 실제 Speaker 재생에서도 OBS 확인 카드 0개와 media 진행을 확인했다.
- 공개 v0.2.38의 모바일형 3탭 자동 검증은 foreground 탭 전환, hidden/visible, persisted pagehide/pageshow, 브라우저/기기 pause 모사와 명시적 사용자 복구를 통과했다. 두 독립 곡은 같은 source로 계속 전진했고 유휴 탭은 media graph를 만들지 않았으며 Worker/session/WebSocket/frame과 경로 경고는 0이었다.
- 실제 모바일 검증에서는 PiP 진입/이탈, 홈·앱 전환, 화면 잠금, 실제 BFCache 복귀, 30초 이상 OS background를 각각 확인한다. 자동 lifecycle 이벤트 모사는 이 실기기 관문을 닫지 않는다.

## 남은 수동 확인

- iOS Safari와 Android Chrome에서 PiP·화면 잠금 중 실제 `<audio>` 지속 여부와 잠금 화면·알림·헤드셋 Media Session 조작
- 실제 OBS CEF에서 source hide/scene 전환 시 연결·재생 지속 여부와 OBS 설정 정책에 따른 mixer 출력
- OBS 제어 연결이 완전히 끊겼다가 복귀해도 재생 중 그래프의 오디오가 연속인지
