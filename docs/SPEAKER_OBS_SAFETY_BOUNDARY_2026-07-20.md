# Speaker / OBS 안전 정책 경계

## 결정

스피커 모드는 일반적인 음악 플레이어로 취급한다. 모바일 창 전환, PiP, BFCache, 백그라운드 타이머 지연만으로 로컬 오디오를 정지시키거나 영구 잠그지 않는다. OBS 브라우저 소스는 기존처럼 송출 사고를 막기 위해 엄격한 안전 정책을 유지한다.

> 2026-07-22 갱신: Dashboard 스피커는 더 이상 Worker 출력 후보가 아니다. 각 탭의 브라우저 로컬 플레이어이며 후보 수·lease·heartbeat 제한이 없다. 아래의 dashboard-speaker 프로토콜 내용은 구버전 연결을 정리하기 위한 하위 호환 경로다.

## 사용자 동작 기준

| 상황 | 스피커 | OBS |
|---|---|---|
| 창 전환 / PiP / 백그라운드 | 로컬 재생 유지, 서버 출력 연결과 무관 | 제어 소켓·장면 active/visible 변화만으로는 재생 중인 그래프 유지; 실제 Browser Source 종료는 socket close로 판별 |
| heartbeat 지연 | heartbeat 자체를 보내지 않음 | 10초 간격의 상태 관측만 유지하며, 지연만으로 established route를 해제하거나 명령을 차단하지 않음 |
| 연결 중 이벤트 전송 실패 | 로컬 플레이어를 영구 잠그지 않음 | 안전 정지 후 unknown |
| unknown 상태에서 같은 버튼 재선택 | 즉시 로컬 재생 가능. OBS 정리 결과는 로컬 플레이어를 잠그지 않음 | 기존 emergency/recovery 절차 유지 |
| 다른 출력으로 전환 | 재생 중 OBS 전환 금지(반주 싱크 보호) | inactive·소스·송출 증거 전까지 자동 전환하지 않음 |

## 안전 불변식

1. 새 OBS 경로 활성화는 여전히 `sourceActive=true`인 정확한 단일 Browser Source만 허용한다. 다만 이미 연결된 경로의 `sourceActive/sourceVisible=false`는 장면 전환 관측값이며 정지 명령으로 사용하지 않는다.
2. 스피커도 다른 출력으로의 자동 fallback이나 자동 재생 재개는 하지 않는다.
3. 각 로컬 스피커는 독립적이다. 다른 탭의 존재나 상태가 이 탭의 transport 조작을 잠그지 않는다.
4. OBS에서 스피커로 돌아오면 새 명령은 즉시 로컬로 보낸다. 재생 중이던 OBS 곡에는 best-effort STOP을 보내되, ACK·제어권·route 상태 때문에 스피커를 잠그지 않고 서버 Speaker 출력도 활성화하지 않는다.
5. Speaker 헤더는 Worker의 후보 수·제어권·route 전이 상태를 표시하지 않는다. 이 값들이 늦게 도착하거나 모순되어도 `연결 중`, `중복`, `이전 탭 연결`, `경로 확인 필요`로 되돌아가지 않는다.

## 구현 지점

- `src/components/DashboardLocalSpeaker.jsx`, `src/lib/localSpeakerController.js`: 탭별 로컬 PlaybackEngine과 인증된 준비 음원 resolver.
- `src/pages/Dashboard.jsx`: 로컬/OBS 명령 경계, 원격 transport 이벤트 차단, OBS 전환 중 싱크 보호.
- `src/lib/onAirPlaybackAdapter.js`: OBS 제어 소켓 일시 손실과 장면 active/visible 변화는 그래프를 유지한다. 명시적 STOP/deactivate/emergency와 terminal teardown만 물리 정지한다.
- `workers/rekasong-session/src/index.js`: OBS heartbeat는 상태 관측과 새 후보 자격에만 사용한다. established route의 연속성은 live negotiated socket으로 판별한다.
- `src/pages/Dashboard.jsx`: Speaker 선택과 transport는 OBS 제어권·lease·후보 수와 무관하며, 연결된 OBS route는 silent-ready 상태로 유지할 수 있다.

## 검증

- local speaker: 두 controller가 동시에 독립적으로 load/play/seek/volume/stop하며 route 명령을 만들지 않는 자동 테스트.
- adapter: OBS 제어 연결 손실과 sourceActive/sourceVisible 변화 모두 그래프 유지. 명시적 정지 경로만 media를 detach.
- Worker: 정확한 29,999/30,000/59,999/60,000ms 경계와 durable alarm/storage race 테스트.
- dashboard: 로컬 Speaker 선택은 항상 즉시 반영되고 server Speaker activate/deactivate를 호출하지 않음. 기존 OBS run에는 STOP만 best-effort로 전송.
- 실제 모바일 검증에서는 PiP 진입/이탈, 홈·앱 전환, 화면 잠금, BFCache 복귀, 30초 이상 background를 각각 확인한다.

## 남은 수동 확인

- iOS Safari와 Android Chrome에서 PiP·화면 잠금 중 실제 `<audio>` 지속 여부
- 실제 OBS CEF에서 source hide/scene 전환 시 연결·재생 지속 여부와 OBS 설정 정책에 따른 mixer 출력
- OBS 제어 연결이 완전히 끊겼다가 복귀해도 재생 중 그래프의 오디오가 연속인지
