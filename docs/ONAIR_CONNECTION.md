# On-Air ↔ OBS 연결: 진실성 + 설정 안내 — 계약

> 목표: (A) 대시보드가 **OBS 위젯의 실제 연결**을 진실하게 알고 보여준다.
> (B) 스트리머가 OBS쪽에서 뭘 해야 하는지 명확히 알고, 넣는 즉시 연결을 확인한다.
> 라이브 검증 완료: 준비된 광고 없는 오디오가 위젯에서 실제 재생됨(9/9). 재생은
> 되지만 **연결 상태 표시가 거짓**이라는 것이 이 작업의 대상이다.

## 0. 진단 (실측)

- **표시기가 거짓말한다.** `PlaybackPanel` 상태 칩 "OBS 플레이어 연결됨"은
  `onAir.connectionState`(=대시보드 자신의 control 소켓)에 근거한다. **OBS 위젯을
  열지 않아도 대시보드만 붙으면 "연결됨"으로 뜬다.**
- **대시보드는 위젯 presence 를 처리하지 않는다.** Worker 는 presence 를 control 로
  보내지만(라이브 테스트에서 수신 확인) 대시보드가 안 쓴다. 배관은 있는데 계기판
  미연결.
- **위젯 없이도 송출이 나간다.** 재생 게이트(`Dashboard.jsx` 재생 시작부)가 control
  연결만 확인 → OBS 위젯이 하나도 없어도 load 명령이 허공으로 나간다.
- **스냅숏에 현재 presence 가 없다.** `openSocket` 스냅숏은 `{transport, display,
  session}`뿐. 위젯을 먼저 켜고 대시보드를 나중에 열면(또는 새로고침) **이미 연결된
  위젯을 모른다** — presence 는 이후 이벤트로만 오기 때문.

## 1. Worker 변경 (`workers/rekasong-session/src/index.js`)

목표: control 이 언제 붙어도 **두 위젯(player·display)의 현재 연결 상태**를 알 수 있다.

1. **스냅숏에 presence 포함**: `openSocket` 이 control 에게 보내는 `snapshot` 에
   현재 연결된 역할 정보를 추가한다. 예: `presence: { player: <bool>, display: <bool> }`
   (`ctx.getWebSockets()` 의 attachment role 로 집계). control 이 처음/재접속해도
   진실을 즉시 안다.
2. **display presence 도 control 로 브로드캐스트**: 현재는 player↔control 만
   presence 를 주고받는다. **display 연결/해제도 control 에 알린다** — 설정 흐름에서
   화면정보 위젯이 실제 들어갔는지 확인해야 하기 때문. (connect 시 + `webSocketClose`
   시 둘 다.) player 브로드캐스트 규약과 대칭으로.
3. `webSocketClose` 의 presence 브로드캐스트가 role 정보를 담는지 확인
   (`{type:'presence', role, connected:false}`). control 이 어느 위젯이 빠졌는지 알아야 한다.
4. **(선택) 하트비트**: OBS 브라우저 소스는 얼어붙어도 소켓이 안 닫힐 수 있다.
   player 의 position 이벤트가 재생 중엔 암묵 하트비트다. 유휴 시 감지가 필요하면
   서버가 주기 ping / last-seen 을 두는 방안을 주석으로 남기되, 이번 범위 필수는 아님.

**불변식**: 이 변경은 relay/transport 의미를 바꾸지 않는다. presence 는 부가 신호다.
DO 마이그레이션 불필요(스토리지 스키마 불변 — presence 는 런타임 소켓 집계).

## 2. 프론트 — 연결 진실성 (`useOnAirSession.js`, `Dashboard.jsx`)

1. **`useOnAirSession` 이 presence 를 추적**한다: 스냅숏의 `presence` 로 초기화 +
   이후 `{type:'presence'}` 이벤트로 갱신. `{ playerConnected, displayConnected }`
   를 반환값에 추가한다. (control 소켓 재접속 시 스냅숏으로 재동기화되므로 stale
   presence 가 남지 않게 하라.)
2. **두 상태를 명확히 구분**:
   - `connectionState`(기존) = 대시보드↔서버(control). "서버 연결".
   - `playerConnected`/`displayConnected`(신규) = **OBS 위젯↔서버(실제)**.
3. **재생 게이트를 위젯 presence 로**: On-Air 모드에서 재생 시작(송출) 시 control
   연결뿐 아니라 **player 위젯이 실제 연결됐는지** 확인. 없으면 명확한 토스트
   ("OBS On-Air 플레이어가 연결되지 않았습니다. OBS에 플레이어 소스를 추가하세요.")
   로 막는다 — 허공 송출 방지. (기존 `sendCommand` 의 소켓-닫힘 예외와 별개로,
   사용자가 이해할 사유를 앞단에서 제시.)

## 3. 프론트 — OBS 설정 안내 UX (`PlaybackPanel.jsx` + CSS)

기존 `obs-setup-dialog`(화면정보 위젯 / On-Air 플레이어 2단계 구조)를 유지·강화한다.

1. **상태 칩을 진실하게**: player 단계의 칩은 `playerConnected`(실제)에 근거.
   - 미연결: "OBS에 이 주소를 넣으면 여기 초록불이 켜집니다"(대기, 회색).
   - 연결: "✓ OBS 플레이어 연결됨"(초록, `--chr-vest`/`--eureka-emerald` 절제).
   - display 단계에도 동일한 실시간 칩 추가(`displayConnected`).
   - **대시보드↔서버 상태(control)와 시각적으로 구분** — 이건 "서버 준비"이지 위젯
     연결이 아님을 오해 없이.
2. **초심자용 흐름 명확화** (사용자 지침: beginner-first, 오해 없는 단방향 흐름):
   - 순서·개수·오디오 켬끔·권장 크기를 단계마다 분명히. 예: 화면정보=오디오 끄기,
     플레이어=이 소스만 오디오 믹서에 남기기. "로컬 파일 체크 해제" 같은 흔한 실수 경고.
   - 각 단계 = OBS 브라우저 소스 1개. "무엇을·왜"를 한 줄로.
   - 넣는 즉시 칩이 초록으로 바뀌는 것이 **행동이 먹혔다는 즉각 피드백**이다(핵심 UX).
3. **디자인 규율**(사용자 지침): 초록은 핵심 포인트지만 남발 금지 — "연결됨"의 성공
   상태에만 절제해서. 뷰포트 우선(스크롤 늘리지 말 것). 기존 클래스/토큰 재사용.
4. **직접 재생 모드(N-01)** 호환 유지: On-Air 서버 미설정 시 기존 room&key 위젯 주소
   복사 흐름을 깨지 말 것. presence 는 On-Air 모드에서만 유효.

## 4. 검증 (필수 — 코드 리뷰로 끝내지 말 것)

- `vite build` + `oxlint`(신규 경고 0).
- **라이브 presence 회귀 테스트**: 배포된 Worker + 헤드리스 위젯으로,
  (a) 위젯 연결 전 대시보드는 `playerConnected=false`,
  (b) 위젯 연결 시 `presence` 로 true 전이,
  (c) **위젯을 먼저 연결하고 control 을 새로 연결하면 스냅숏 presence 로 즉시 true**,
  (d) 위젯 종료 시 false 전이,
  (e) player 미연결 상태에서 재생 시작이 토스트로 막힘.
  (기존 `scratchpad/onair.mjs` 패턴 재사용 — 세션 생성 + control WS + 위젯 헤드리스.)
- 참고: Worker 배포는 사용자 승인 규칙(`Bash(npx wrangler:*)`)으로 가능. 프론트는
  push 시 GitHub Pages 자동 배포되므로, **커밋만 하고 푸시/배포는 코디네이터가 판단.**

## 5. 범위 밖 (이번 아님)

- 상태머신 Worker 완전 이식(Stage 7): finish/discard 명령, 플레이어 리스, 1008 close
  백오프 등은 별도. 이번은 presence 관측 + 설정 UX 에 한정.
- Worker 낙관적 transport(명령만으로 status 전환, N-02)는 이번에 건드리지 않는다 —
  presence 와 독립적이고, 현재 load 흐름은 실제 player_event 로 확정되므로 안전.
