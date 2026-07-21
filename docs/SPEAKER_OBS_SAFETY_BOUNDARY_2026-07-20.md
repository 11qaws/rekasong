# Speaker / OBS 안전 정책 경계

## 결정

스피커 모드는 일반적인 음악 플레이어로 취급한다. 모바일 창 전환, PiP, BFCache, 백그라운드 타이머 지연만으로 로컬 오디오를 정지시키거나 영구 잠그지 않는다. OBS 브라우저 소스는 기존처럼 송출 사고를 막기 위해 엄격한 안전 정책을 유지한다.

> 2026-07-22 갱신: Dashboard 스피커는 더 이상 Worker 출력 후보가 아니다. 각 탭의 브라우저 로컬 플레이어이며 후보 수·lease·heartbeat 제한이 없다. 아래의 dashboard-speaker 프로토콜 내용은 구버전 연결을 정리하기 위한 하위 호환 경로다.

## 사용자 동작 기준

| 상황 | 스피커 | OBS |
|---|---|---|
| 창 전환 / PiP / 백그라운드 | 로컬 재생 유지, 서버 출력 연결과 무관 | 제어 소켓 일시 손실만으로는 재생 중인 그래프 유지; 실제 OBS 소스 손실은 즉시 정지 |
| heartbeat 지연 | heartbeat 자체를 보내지 않음 | 10초 간격, 60초 동안 6회 누락 시 half-open fallback unknown |
| 연결 중 이벤트 전송 실패 | 로컬 플레이어를 영구 잠그지 않음 | 안전 정지 후 unknown |
| unknown 상태에서 같은 버튼 재선택 | 즉시 로컬 재생 가능. 단, 실제 OBS가 켜져 있으면 OBS 정지 증거를 먼저 요구 | 기존 emergency/recovery 절차 유지 |
| 다른 출력으로 전환 | 재생 중 OBS 전환 금지(반주 싱크 보호) | inactive·소스·송출 증거 전까지 자동 전환하지 않음 |

## 안전 불변식

1. 스피커 완화는 OBS 브라우저 소스의 `sourceActive/sourceVisible` 검증에 영향을 주지 않는다.
2. 스피커도 다른 출력으로의 자동 fallback이나 자동 재생 재개는 하지 않는다.
3. 각 로컬 스피커는 독립적이다. 다른 탭의 존재나 상태가 이 탭의 transport 조작을 잠그지 않는다.
4. OBS에서 스피커로 돌아올 때는 OBS를 먼저 정지하되, 서버에 새 스피커 출력을 활성화하지 않는다.

## 구현 지점

- `src/components/DashboardLocalSpeaker.jsx`, `src/lib/localSpeakerController.js`: 탭별 로컬 PlaybackEngine과 인증된 준비 음원 resolver.
- `src/pages/Dashboard.jsx`: 로컬/OBS 명령 경계, 원격 transport 이벤트 차단, OBS 전환 중 싱크 보호.
- `src/lib/onAirPlaybackAdapter.js`: OBS 제어 소켓 일시 손실은 그래프를 유지하고 실제 sourceActive/sourceVisible 손실만 물리 정지한다.
- `workers/rekasong-session/src/index.js`: OBS heartbeat 30초 warning/60초 stale fallback. 실제 소켓 close와 소스 이벤트는 즉시 처리한다.
- `src/hooks/useOnAirOutputControl.js`: `selectLocalSpeakerMode()`는 서버 출력을 deactivate만 하고 speaker candidate를 activate하지 않는다.

## 검증

- local speaker: 두 controller가 동시에 독립적으로 load/play/seek/volume/stop하며 route 명령을 만들지 않는 자동 테스트.
- adapter: OBS 제어 연결 손실은 그래프 유지, 실제 sourceActive/sourceVisible 손실은 즉시 물리 정지.
- Worker: 정확한 29,999/30,000/59,999/60,000ms 경계와 durable alarm/storage race 테스트.
- output controller: 로컬 Speaker 선택은 inactive에서 무명령, OBS active에서는 deactivate만 호출하고 speaker activate는 하지 않음.
- 실제 모바일 검증에서는 PiP 진입/이탈, 홈·앱 전환, 화면 잠금, BFCache 복귀, 30초 이상 background를 각각 확인한다.

## 남은 수동 확인

- iOS Safari와 Android Chrome에서 PiP·화면 잠금 중 실제 `<audio>` 지속 여부
- 실제 OBS CEF에서 source hide/scene 전환 시 strict stop과 mixer 무음 여부
- OBS 제어 연결이 완전히 끊겼다가 복귀해도 재생 중 그래프의 오디오가 연속인지
