# Speaker / OBS 안전 정책 경계

## 결정

스피커 모드는 일반적인 음악 플레이어로 취급한다. 모바일 창 전환, PiP, BFCache, 백그라운드 타이머 지연만으로 로컬 오디오를 정지시키거나 영구 잠그지 않는다. OBS 브라우저 소스는 기존처럼 송출 사고를 막기 위해 엄격한 안전 정책을 유지한다.

## 사용자 동작 기준

| 상황 | 스피커 | OBS |
|---|---|---|
| 창 전환 / PiP / 백그라운드 | 로컬 재생 유지, 연결은 자동 재시도 | 연결·소스 증거가 끊기면 즉시 로컬 정지 및 unknown |
| heartbeat 지연 | 일시 지연으로 간주 | active output unknown 처리 |
| 연결 중 이벤트 전송 실패 | 로컬 플레이어를 영구 잠그지 않음 | 안전 정지 후 unknown |
| unknown 상태에서 같은 버튼 재선택 | 먼저 deactivation을 시도해 inactive 증거를 만든 뒤 재활성화 가능 | 기존 emergency/recovery 절차 유지 |
| 다른 출력으로 전환 | inactive 증거 전까지 자동 전환하지 않음 | inactive·소스·송출 증거 전까지 자동 전환하지 않음 |

## 안전 불변식

1. 스피커 완화는 OBS 브라우저 소스의 `sourceActive/sourceVisible` 검증에 영향을 주지 않는다.
2. 스피커도 다른 출력으로의 자동 fallback이나 자동 재생 재개는 하지 않는다.
3. heartbeat 완화는 연결된 스피커가 백그라운드에서 살아 있는 경우에만 적용한다. 실제 소켓 단절은 Worker에서 unavailable/unknown으로 남을 수 있다.
4. unknown 스피커를 복구할 때도 먼저 플레이어를 정지·분리하고, 서버가 `inactive`를 확인한 뒤에만 다시 활성화한다.

## 구현 지점

- `src/lib/onAirPlaybackAdapter.js`: `strict`/`speaker` 안전 프로필 분리. 스피커 연결 일시 손실은 로컬 emergency stop을 유발하지 않는다.
- `src/components/OnAirPlayerV2.jsx`: dashboard speaker에만 `speaker` 프로필 주입.
- `workers/rekasong-session/src/index.js`: dashboard speaker heartbeat 지연은 active output unknown으로 전환하지 않는다. OBS는 기존 threshold를 유지한다.
- `src/hooks/useOnAirOutputControl.js`: unknown 스피커 버튼 재선택은 안전 deactivation 복구 경로로 동작한다. OBS 버튼은 계속 fail-closed다.

## 검증

- adapter: OBS 연결 손실은 emergency stop·unknown, speaker 연결 손실은 로컬 그래프 유지·재연결 가능.
- Worker: OBS heartbeat stale은 unknown, speaker heartbeat throttling은 ready 유지.
- output controller: unknown speaker 재선택은 deactivation을 호출하고 OBS 자동 전환은 하지 않음.
- 실제 모바일 검증에서는 PiP 진입/이탈, 홈·앱 전환, 화면 잠금, BFCache 복귀, 30초 이상 background를 각각 확인한다. 실제 소켓이 끊긴 경우에는 같은 스피커 버튼으로 복구 deactivation을 시도한 뒤 inactive 확인 여부를 기록한다.

## 남은 수동 확인

- iOS Safari와 Android Chrome에서 PiP·화면 잠금 중 실제 `<audio>` 지속 여부
- 실제 OBS CEF에서 source hide/scene 전환 시 strict stop과 mixer 무음 여부
- 연결이 완전히 끊긴 뒤 복귀했을 때 deactivation event가 제한 시간 안에 도착하는지
