# Rekasong 개발 로그 (DEVELOPMENT_LOG)

## 2026-07-20 (Codex) 송출 경로 완전 초기화

- 송출 경로가 막혔거나 선택/실제 경로를 확인할 수 없을 때 설정에서 전체 출력을 정지하고 송출 제어 연결을 다시 시작하는 명시적 초기화 동작을 추가했다.
- 긴급 정지의 ACK 결과를 확인한 경우에만 기존 제어 연결을 폐기하고 새 연결을 만든다. 결과가 불명확하거나 제한 시간 안에 오지 않으면 상태를 성공으로 지우지 않고 실패 안내를 유지한다. 초기화가 성공한 뒤에는 사용자가 스피커 또는 OBS 경로를 다시 선택한다.

## 2026-07-20 (Codex) output intent watchdog

- A route click queued before writable output-control authority is proven now expires after 8 seconds, triggers one reconnect, and exposes settings recovery instead of remaining indefinitely pending.
- The compact output selector disables repeated no-op clicks while recovery is required and uses localized `onair.output.nextAction.control` guidance.

## 2026-07-20 (Codex) — Worker WebSocket heartbeat 빈도 절감
- Protocol v2 기본 테스트 cadence는 보존하되 실제 플레이어는 OBS 1초, 대시보드 스피커 5초 주기로 heartbeat를 보낸다. 250ms 전송은 오디오 시계가 아니며 유휴 브라우저 소켓마다 불필요한 Cloudflare `websocket:message`를 만든다.
- heartbeat는 연결 유지·OBS 런타임 증명의 보조 신호일 뿐 재생 자체의 시간축이 아니다. OBS 소스 상실은 기존 로컬 런타임 콜백이 즉시 처리하고, 서버 heartbeat는 재연결/상태 복구용으로 남긴다.

## 2026-07-20 (Codex) — 연결 우선 복구와 스피커 재연결 UX
- OBS 모드에서는 WebSocket·heartbeat·명령 전달이 일시적으로 모호해져도 연결된 재생 그래프를 즉시 파괴하지 않는다. `sourceActive=false`/`sourceVisible=false` 같은 실제 소스 상실 증거만 긴급 정지 대상으로 유지했다.
- 같은 OBS 플레이어가 `sourceActive=true`와 OBS 런타임 capability를 다시 보고하면 lease를 `ready`로 복원하되 자동 재생은 하지 않는다.
- 스피커 모드에서 연결이 `unknown`으로 꼬인 뒤 같은 스피커 버튼을 다시 누르면 즉시 실패 고정하지 않고 명시적 해제 확인을 기다려 복구할 수 있게 했다. 재연결만으로는 성공으로 간주하지 않는다.
- Worker 프로토콜 테스트에 스피커 소켓 종료→재연결→명시적 `deactivate_output`→`output_deactivated` 확인 시나리오를 추가했다.

## 2026-07-18 — On-Air 위젯 프리버퍼(pre-buffer): 다음 곡 미리 받기

대기열의 다가오는 곡(준비 완료된 YouTube 곡, 최대 2개)을 On-Air 위젯이 미리 blob으로 통째로 받아 두어 곡 전환이 즉시 되게 했다. 순수 최적화·복원력 작업으로, 프리페치 실패·미스는 항상 기존 스트리밍 재생으로 무손실 폴백된다(기능 변경·회귀 없음).

- **Worker(`handleCommand`)**: `prefetch` 명령을 player로 **broadcast만** 하는 순수 릴레이 추가. transport/세션 상태 불변, **`storage.put` 절대 없음** — 직전 DO 무료 티어 쓰기 한도 초과 사고의 재발 방지가 최우선 제약. videoId는 11자 패턴 검증 + 최대 2개로 잘라 릴레이.
- **위젯(`OnAirPlayer.jsx`)**: `Map<videoId, objectURL>` 캐시(최대 2곡 — 긴 메들리 blob은 수십 MB라 메모리 방어). 힌트 목록에서 빠진 항목은 revoke, 언마운트·세션 종료 시 전부 revoke. 재생 src는 곡(sessionId)당 1회 첫 렌더에서 확정(sticky): 캐시 히트면 blob URL, 아니면 기존 스트리밍 URL.
- **코디네이터(`Dashboard.jsx`)**: 큐에서 `ready`인 YouTube 곡을 순서대로 최대 2개 골라 prefetch 힌트 전송. 같은 목록 중복 전송 억제(ref), 위젯 재연결 시 기억을 지워 재전송(위젯 캐시가 비므로). 빈 목록도 보낸다 — 위젯의 불필요 blob 회수 신호.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **재생 중 `<audio src>` 교체는 요소를 리셋해 재생을 처음부터 다시 시작시킨다.** blob이 뒤늦게 도착했을 때 src를 '업그레이드'하면 회귀다 — src 선택은 sessionId당 1회로 고정(sticky)하고, 늦은 blob은 그냥 버려지게(다음 사용처가 없으면 sweep) 설계했다.
2. **재생에 물린 objectURL을 revoke하면 미디어 fetch가 끊길 수 있다.** sweep은 현재 재생 src와 같은 URL을 보류하고, 곡이 바뀐 뒤(sessionId effect — key 리마운트로 이전 `<audio>`가 내려간 커밋 후)에 회수한다. 따라서 순간 최대 메모리는 '프리페치 2곡 + 재생 중 1곡'이다(재생 중 blob은 어차피 요소가 쥐고 있어 줄일 수 없는 몫).
3. **oxlint exhaustive-deps는 effect가 참조하는 함수가 props를 캡처하는 순간 경고를 낸다.** `applyCommand`(소켓 핸들러)에 prefetch fetch를 넣자 `apiBaseUrl/room/token` 캡처로 신규 경고 발생 — 소켓 effect가 이미 같은 deps로 재연결되므로 거울 ref(`prefetchAuthRef`)로 읽어 함수를 다시 '안정'으로 만들었다(기존 `onMediaReadyRef` 패턴과 동일).

### 검증

- `vite build` 통과, `oxlint` 변경 파일 3종 신규 경고 0.
- **라이브 미검증**: DO 쓰기 한도 소진으로 세션 생성이 500이라 위젯 실재생 검증 불가. 한도 회복 후 코디네이터가 (a) prefetch 릴레이 수신, (b) blob 재생 전환 즉시성, (c) 폴백(캐시 미스 시 스트리밍) 라이브 확인 필요. Worker는 미배포 상태(코드만 커밋).

## 2026-07-17 — 생애주기 Stage 3: finishing / discarding / failed 전이

기준: `docs/SONG_LIFECYCLE.md` §4-3/§4-4/§4-5, `docs/ux-audits/PHASE_08_COMBINED_REVIEW.md` §6 Stage 3. Stage 1(QueueEntry 스키마)·Stage 2(코디네이터 상태기계) 위에 종료 계열 전이만 얹었다. CSS/디자인 파일 무변경(기존 클래스 재사용), 프로토콜(Worker/OnAirPlayer) 무변경.

- **스킵을 규범대로**: 스킵이 '다음 곡 직접 로드 + 즉시 completed'에서 `finishing → 실제 ended 확인 → completed`로 바뀌었다. 로컬 미디어는 duration이 확인될 때 끝으로 보내고(`el.currentTime = el.duration`), 동일 runId의 실제 `ended`에서만 이력 편입·다음 곡 승격이 일어난다(INV-2/3/4). 스킵 버튼의 '다음 곡으로' 의도는 `active.pendingNextEntryId` 예약으로 보존해 autoPlayNext OFF에서도 기존처럼 다음 곡이 승격된다.
- **YouTube 광고 안전장치(§4-3)**: iframe 경로는 outputSafety를 확인할 수단이 없어(§2-4 unknown 고정) 광고 중 `seekTo(끝)`가 'finishing 고착'을 만들 수 있다. 길이/안전성 미확인 시 기존 '다음 곡 직접 로드' 폴백을 쓰되 completionReason='skipped'는 유지한다(오디오 프록시 Stage 6 전 과도기). On-Air 경로도 finish 명령이 없어(Stage 7) 같은 폴백을 쓴다.
- **현재 곡 쓰레기통 재도입(§4-4)**: PlaybackPanel에 `btn-icon btn-icon-danger` 쓰레기통 버튼. 로컬은 명시 pause + 언마운트로 동기 확정, On-Air는 stop 송신 성공 시 확정(확인 이벤트는 Stage 7). 이력 없음·자동 다음 곡 없음(INV-3). 버린 entryId는 늦은 transport 스냅숏이 되살리지 못하게 가드.
- **failed 자동 스킵 제거(§4-5)**: 재생 오류 시 400ms 뒤 자동 다음 곡이던 것을 `phase='failed'` 확정 + 재시도(같은 entry, 새 runId)/버리기 제시로 교체. 실패 사유는 `active.failureDetail`로 남겨 진행 바 자리에 표시(`mr-unavailable` 클래스 재사용).
- **전이 중 조작 잠금**: finishing/discarding/failed 중 재생·일시정지·seek·스킵을 버튼 비활성 + 코디네이터 가드(Space/Ctrl+→ 단축키 경로 포함)로 이중 차단. 상태 배지가 `스킵 중…`/`취소 중…`/`재생 실패`를 표시. playing/paused 확인 이벤트는 이 잠금 phase를 되돌리지 못한다.
- **바로 재생 복합 명령(§4-6)**: 재생 중 대기열 곡 바로 재생은 '선택 곡 예약 + 현재 곡 스킵 요청'(finishing 경유)이 됐다. failed 곡 위의 바로 재생은 '버리기 + 시작'으로, 실패 곡이 완료 이력에 들어가지 않는다.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **일시정지 중 `currentTime = duration` 만으로는 `ended`가 발화하지 않을 수 있다.** 끝으로 보내기 전에 `el.play()`로 재생을 재개해야 ended가 확실히 발화한다(끝 지점이라 청감상 무음). 반대로 ended 상태에서 `play()`를 먼저 부르면 처음으로 되감기므로 순서는 반드시 play → seek.
2. **프로덕션 빌드는 `.env.production`의 `VITE_ON_AIR_BASE_URL`이 항상 주입되어 직접 재생(숨김 플레이어) 경로가 렌더되지 않는다.** 직접 재생 경로의 실렌더 검증은 vite dev 서버(개발 모드)로 해야 한다. preview(프로덕션 빌드)로 로컬 파일을 올리면 실제 배포 Worker에 세션/자산이 생성되니 주의.
3. **`<audio>`를 React 언마운트만으로 정리하면 재생이 즉시 멎지 않을 수 있다.** discard는 언마운트 전에 명시적으로 `pause()`/`stopVideo()`를 부른다.

### 검증

- `vite build` / `oxlint` 통과(경고는 기존 6건 그대로, 변경 파일 무경고).
- playwright-core + Chrome 실렌더 22개 체크 전부 통과: 스킵(재생/일시정지 중)→finishing→ended→completed, 쓰레기통(이력·자동 다음 곡 없음), failed(자동 스킵 제거·버튼/단축키 잠금·재시도 새 runId·버리기), 바로 재생 복합 명령.
- 미검증: YouTube 폴백 스킵(네트워크 필요, 로직은 Stage 2의 기존 경로 재사용), On-Air 폴백(stop/load 송신 — 실제 Worker+플레이어 위젯 필요).

### 호환성

- 상태 스키마는 `active`에 선택 필드 3종(`pendingCompletionReason`, `pendingNextEntryId`, `failureDetail`)만 추가 — 구 상태를 읽을 때 없으면 무시되므로 하위 호환 유지. 버전 번호는 이번 지시 범위(버전/package.json 변경 금지)에 따라 올리지 않았다.

## 2026-07-16 — 반응형 통일 디자인 (UX Audit Phase 06)

상세 계획·검증은 `docs/ux-audits/PHASE_06_RESPONSIVE_UNITY.md` 참조. CSS만 변경(JS/JSX 무변경).

- **뷰포트 잠금(wide)**: 대시보드가 100vh 플렉스 체인 + `grid-rows: auto minmax(0,1fr)`로 잠기고, 페이지 스크롤 없이 대기열/검색 리스트만 패널 내부에서 스크롤. narrow(≤1100px)는 기존 스택을 보존하되 리스트 높이를 캡해 페이지 길이를 고정.
- **컨테이너 쿼리**: 2단계 미리보기 레이아웃이 뷰포트가 아닌 composer 칼럼 실폭(620px)에 반응.
- **색 위계 재정렬**: 활성 탭 등 상시 면적의 네온 에메랄드를 딥그린(--chr-vest)으로, 네온은 ON AIR·현재재생·포커스링(`:focus-visible`)·재생 CTA로 한정.

### 트러블슈팅 기록 (재발 방지 레퍼런스)

1. **미정의 CSS 변수 4종**(`--accent-red`, `--eureka-azure`, `--bg-panel`, `--text-dim/--neon-cyan`)이 조용히 스타일을 죽이고 있었다(패닉 경고 무색, 스크롤바 투명 등). 기존 리터럴 값을 변수로 승격해 복구. *교훈: 변수 참조 추가 시 :root 정의 여부를 반드시 교차 확인.*
2. **`.glass-card`의 다크테마 잔재 테두리**(`rgba(255,255,255,0.08)`)가 캐스케이드에서 `.panel` 실버 테두리를 덮어써 모든 패널이 무테였다.
3. **flex-basis 0%에서는 `flex-wrap`이 영영 발동하지 않는다.** 탭 오버플로 수정 시 `flex: 1` → `flex: 1 1 auto` + 컨테이너 `min-width: 0` 필요.
4. **`display: grid` 리스트에 `grid-template-columns`가 없으면 트랙이 max-content로 늘어난다.** 긴 곡명이 대기열 행을 옆으로 밀어 모바일에서 버튼이 화면 밖으로 나감 → `minmax(0, 1fr)` 명시.
5. **스크롤 컨테이너의 위쪽 padding 영역에는 스크롤 지나가는 콘텐츠가 비쳐 보인다.** sticky 제목 위로 영상 프리뷰가 비침 → 패널 `padding-top: 0` + sticky 제목이 간격을 불투명하게 대체.
6. **Chrome headless `--screenshot`은 원인 불명의 스테일 렌더를 반환할 수 있다.** 같은 빌드를 playwright-core(설치된 Chrome 채널)로 열자 DOM 실측과 스크린샷이 일치. 시각 검증은 playwright 경유를 권장.
7. 검증 중 발견한 기존 결함 수정: `.btn-secondary` 스타일 부재(기본 버튼 렌더), `.btn-icon-danger` 95px 고정폭(아이콘 버튼 비대), 히스토리 행 액션 세로 쌓임(~90px 행).

### 검증
- `npm run lint` / `npm run build` 통과 (경고는 기존 JS 경고 6건 그대로).
- vite preview + playwright-core로 6개 뷰포트 × 대기열 12곡/2단계/온보딩 상태 실렌더 확인.

## v0.0.6 — External failure resilience

- Audited 120 external-failure and damaged-input scenarios across widget sync, YouTube, local audio, and persisted/external state.
- Media end and error callbacks now carry the expected song ID, so a late callback cannot skip a newer song after the streamer has already recovered manually.
- YouTube player errors and local audio decode/read failures now explain the reason, skip only the failed song, and leave the rest of the queue intact.
- YouTube buffering and local audio waiting show one non-blocking delay notice instead of guessing that playback has failed.
- Search requests now time out after 12 seconds, validate the response shape, and point the streamer to direct YouTube URL input as the fast fallback.
- Persisted state is normalized before use; invalid records are dropped and local Blob songs are intentionally not restored after a reload because they are no longer playable.

## v0.0.5 — Streamer-first recovery controls

- Re-ran the product review as a 30-question practical karaoke-stream audit, prioritizing uninterrupted song flow and recovery from on-air mistakes.
- Queue removal now offers a five-second **Undo** action and restores the song at its former position without overwriting later queue changes.
- The panic confirmation now explicitly says it stops both the current song and the entire queue, and confirms completion after execution.
- Deliberately did not add an OBS “connected” badge: the current transport has no authenticated widget acknowledgement, so showing one would mislead a streamer during a live broadcast.
- Static GitHub Pages remains limited to UI-only operation; AI extraction and cross-device sync require their server endpoints.

## 2026-07-15 — v0.0.4 UX Audit Phase 03: 다중 관점

### 감사 방식

`docs/ux-audits/PHASE_03_MULTIPERSPECTIVE_AUDIT.md`에 초심자·노래 스트리머·UI/UX 디자이너·버튜버 유레카 팬 관점으로 각각 30문항, 총 120문항을 기록했다. 한 관점의 장식적 선호보다 네 관점에서 공통으로 위험한 항목만 구현 대상으로 삼았다.

### 공통 개선

- **로고 장식:** 기존 문자형 `✖✖` 헤어핀은 오류 기호처럼 보이고 화면 낭독 결과에도 섞였다. 금발·은색 핀을 CSS 도형으로 바꿔 유레카 모티브는 유지하면서 로고는 `Rekasong`만 읽히게 했다.
- **상태 알림:** 토스트 컨테이너에 `role="status"`, `aria-live="polite"`를 적용해 곡 선택·취소·복사 같은 암묵적 변화가 보조기기 사용자에게도 전달되게 했다.

### 관점 간 합의와 다음 회차

- 초심자와 UI/UX 디자이너는 첫 실행 시 유튜브 검색을 최우선으로 요구했고, 스트리머는 재방문 시 마지막 작업 탭 복원을 원했다. 이 충돌은 첫 실행 여부를 명시적으로 기록하는 정책으로 다음 회차에서 설계한다.
- 스트리머·디자이너 공통으로 동기화 연결 상태, 대기열 삭제 Undo, 긴급 정지 영향 설명이 남았다. 팬 관점의 추가 장식보다 방송 신뢰성 개선을 우선한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 브라우저 화면에서 로고 문자 장식 제거, 상태 영역 노출, 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.3 UX Audit Phase 02: 방송 제어·복구

### 감사 방식

`docs/ux-audits/PHASE_02_CONTROL_AND_RECOVERY.md`에 방송 중 조작·실수 방지·고급 옵션 노출을 확인하는 30개 질문을 기록했다. 핵심은 한 번의 실수가 OBS 화면이나 대기열을 예측 불가능하게 만들지 않는 것이다.

### Before → After

- **Before:** 자동 다음 곡 체크박스가 대기열 제목 옆에 항상 노출돼, 기본 흐름에서 별도의 판단을 요구했다.
  **After:** `재생 옵션`으로 접고, 현재 켜짐/꺼짐과 실제 동작을 함께 설명한다.
- **Before:** 위젯 주소 복사는 브라우저 alert만 띄웠고, 권한 거부 시 실패 원인이 드러나지 않았다.
  **After:** Clipboard API와 호환 복사 경로를 순서대로 시도하고, 결과를 앱 토스트로 안내한다.
- **Before:** 재생 전의 라이브 패널은 빈 상태만 보였다.
  **After:** 1단계 검색과 2단계 확인으로 이어지는 다음 행동을 안내한다.

### 리스크와 다음 회차

- 복사 실패 시 수동 복사 안내까지는 제공하지만, 브라우저·OBS 임베디드 환경마다 클립보드 권한이 달라 실제 OBS 환경 검증이 필요하다.
- 브라우저가 마지막으로 보던 노래책 탭을 복원하는 동작을 확인했다. 재방문자 편의와 첫 사용자 기본 흐름을 구분하는 정책을 다음 UX 감사에서 결정한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 방송 제어 초기 화면 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.2 UX Audit Phase 01: 초심자 핵심 흐름

### 감사 방식

`docs/ux-audits/PHASE_01_BEGINNER_FLOW.md`에 30개 질문을 기록하고, 첫 사용자가 곡을 찾아 방송에 표시하기까지의 흐름만 우선 판정했다. 장식·새 기능보다 단계 인지와 상태 피드백을 먼저 고쳤다.

### Before → After

- **Before:** 검색 패널은 탭으로 바로 시작해 1단계라는 사실이 드러나지 않았고, `실시간 송출 관리`는 행동보다 기술 용어에 가까웠다.
  **After:** `1 노래 찾기 → 2 곡 정보 확인 → 3 방송 제어`로 단계 이름을 통일했다.
- **Before:** 새 곡 선택과 스테이징 취소는 화면 상태만 바뀌어 사용자가 이전 선택·AI 분석의 처리 결과를 추측해야 했다.
  **After:** 곡 선택·로컬 파일 추가·취소 시 토스트를 표시하고, 취소는 진행 중 AI 요청도 함께 중단한다.

### 리스크와 다음 회차

- 마지막으로 보던 노래책 탭을 복원하는 동작은 재방문자에게 편리하지만, 데모 노래책이 처음 보이는 상황은 초심자 흐름을 흐릴 수 있다. 첫 실행과 재방문을 구분하는 정책을 Phase 02에서 검토한다.
- 동기화 연결 상태 표시와 대기열 삭제 Undo는 아직 구현하지 않았다. 기능을 늘리기 전에 30문항 감사에서 방송 중 사고 예방 효과를 다시 판정한다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 초기 화면에서 1단계·3단계 문구 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15 — v0.0.1 방송 안전성 및 핵심 흐름 정비

### 사용자 시나리오

초심자 스트리머가 **검색 → 정보 확인 → 재생/OBS 표시**를 한 흐름으로 끝낸다. 곡을 바꾸거나 AI 분석이 늦어져도 사용자가 직접 입력한 정보와 현재 재생은 예기치 않게 바뀌지 않아야 한다.

### 반영 내용

- Gemini 제목 추출을 `gemini-3.5-flash` Interactions API 공통 모듈로 전환했다.
- `useAiTitleExtraction` 훅으로 AI 스트림·취소·시간 초과를 분리했다. 새 곡을 선택하거나 스테이징을 비우면 이전 요청을 취소하고, 사용자가 수정한 제목은 AI가 덮어쓰지 않는다.
- OBS 위젯 동기화를 방별 채널·저장 키로 분리하고, 늦게 열린 위젯도 마지막 상태를 복원하도록 했다. 로컬 개발용 `/api/sync`와 Cloudflare Functions용 엔드포인트를 추가했다.
- 자동 다음 곡의 UI·실행 조건을 동기화 상태 `autoPlayNext` 하나로 통일했다.
- 노래책의 `MR 찾기`는 실제 유튜브 검색을 실행하도록 수정했고, 유튜브 URL·영상 ID와 로컬 파일 전체 드롭 영역을 처리한다.
- Setlink·Meloming은 아직 실제 API가 없는 목업이므로, 실제 연동처럼 보이지 않게 데모 모드임을 화면에 표시했다.

### 호환성 및 남은 제약

- 기존 OBS 위젯 URL과 상태 데이터 형식은 유지한다. 이 패치는 하위 호환성을 깨지 않는 `0.0.1` 패치다.
- GitHub Pages 같은 정적 호스팅에서는 Cloudflare Functions와 로컬 `/api/sync`가 제공되지 않는다. 정적 배포 시에는 동일 브라우저 동기화만 가능하며, 원격 OBS 동기화에는 Cloudflare Pages 배포 또는 별도 릴레이가 필요하다.
- Setlink·Meloming 실제 연동은 각 서비스의 공식 API 명세와 인증 방식이 확보된 뒤 구현한다. 데모 데이터를 실제 신청곡으로 취급해서는 안 된다.

### 검증

- `npm run lint` 통과
- `npm run build` 통과
- 로컬 앱 화면 렌더링 및 브라우저 콘솔 오류 없음 확인

## 2026-07-15
**1. UI/UX 및 폴더 구조 전면 개편 (Rettostock 표준 적용)**
- **문제 인식**: 기존 레카송 프로젝트의 파일(`Dashboard.jsx` 등)이 너무 비대하고, 뷰/로직/컴포넌트 구분이 명확하지 않았음.
- **해결 방안**: 인접 프로젝트인 `Rettostock`의 모범 사례(Best Practice)를 벤치마킹하여 `src/pages`, `src/components`, `src/hooks` 구조로 분리.
- **결과**: `Dashboard.jsx`와 `Widget.jsx`를 `pages`로 이동하고, 대시보드를 3단 패널(`SearchPanel`, `StagingPanel`, `LivePanel`)로 나누어 모듈화함. Glassmorphism 디자인 적용.

**2. 유튜브 API 자체 내장 및 이중 재생 문제 해결**
- **문제 인식**: 기존에는 사용자가 유튜브 탭을 따로 띄우고 URL을 복사해와야 했으며, 이로 인해 대시보드 리모컨과 유튜브 원본 탭 양쪽에서 소리가 중복 송출되는(에코 현상) 치명적인 UX 결함이 발생.
- **해결 방안**: 
  - `functions/api/search.js` 백엔드 라우트 생성 (Cloudflare Pages Functions 활용). 
  - 외부 API 없이 유튜브 검색 결과(`ytInitialData`)를 크롤링하여 `MR, TJ, 금영` 키워드를 자동으로 덧붙여 반주 영상을 최우선으로 검색하도록 구현.
  - 대시보드 안에서 바로 검색하고 추가함으로써 외부 탭의 중복 재생 원천 차단.

**3. 트러블슈팅: White Screen 에러 및 포트 혼동 문제**
- **이슈 1 (포트 번호 혼선)**: `vite` 기본 포트인 5173으로 안내했으나, 옆동네 프로젝트(Rettostock)가 5173을 선점한 상태였음. 또한 `wrangler pages dev` 명령을 통해 실행했기 때문에 실제 Cloudflare 런타임은 `8788` 포트에서 작동 중이었음. 
- **해결 1**: 사용자가 `http://localhost:8788`로 접속하도록 정정.
- **이슈 2 (White Screen of Death)**: `Dashboard.jsx` 내 `useEffect`에서 `publishSync(room, signingKeys, state).catch(console.error);`를 호출하여 빈 화면 에러 발생. `publishSync`가 반환값 없는(비동기가 아닌) 일반 함수였으며, 매개변수 순서(payload가 첫 번째)와 형식이 맞지 않았음.
- **해결 2**: `const payload = { state, timestamp: Date.now() }; publishSync(payload, room, signingKeys.privateKey);`로 올바른 매개변수 구조를 통과시켜 에러 수정 완료.

---

## TODO / Next Steps (Claude 인계용)
앞으로 진행해야 할 주요 과제 및 발전 방향입니다.

**1. 대기열(Queue) 시스템 및 자동 재생 도입**
- **현황**: 현재는 사전 검토(Staging) 영역에서 `[방송 송출]`을 누르면 바로 `activeVideoId`를 덮어쓰고 재생하며, 내역은 `history`로만 쌓임.
- **목표**: 
  - 방송용 대시보드인 만큼 여러 곡을 예약해 둘 수 있는 **대기열(Queue) 시스템** 구현.
  - 리스트의 현재 곡이 끝나면(YouTube `onEnd` 이벤트 등 활용) 다음 곡으로 자동 런다운되는 로직 필요.

**2. 멜로밍(Meloming) 서비스 연동**
- **목표**: 앞서 논의되었던 멜로밍 플랫폼과의 시너지 창출 방안 구체화.
- **예상 작업**: 멜로밍에서 신청받은 노래 목록을 레카송의 대기열(Queue)로 직접 Import 하거나, 레카송에서 부른 셋리스트를 멜로밍으로 내보내는(Export) API 연동 기획 및 구현.

**3. 로컬 파일 송출 안정화 및 위젯 연동**
- **현황**: 로컬 MP3 파일은 현재 대시보드(Dashboard.jsx)의 `<audio>` 태그로 재생됨.
- **과제**: 로컬 파일 재생 시 위젯(OBS 화면)에도 현재 재생 중인 곡의 메타데이터(곡명 등)가 올바르게 전송되고 표시되는지 세밀한 테스트 필요.

**4. UI 디테일 및 피드백 강화**
- 3단 패널(Search, Staging, Live) 간의 상호작용(예: 버튼 클릭 시 애니메이션, 성공 토스트 알림 등) 추가로 조작 직관성 향상.

## 2026-07-17
**이전 재생 곡(setlist) 편집 기능 — history 재정렬·표시 전용(수동) 항목 직접 추가**
- **배경**: history(완료 QueueEntry)는 OBS 위젯 setlist로 송출되지만 편집 불가였음. 잘못 올라간 곡의 순서 교정·수기 추가가 필요.
- **스키마 (`src/lib/queueEntry.js`)**:
  - `song.manual: true` 마커 도입 — setlist 표기 전용, 재생 src 없음. `sanitizeSongDef`가 화이트리스트에 보존.
  - `isManualSongDef` 추가, `createManualEntry(title, artist)` 헬퍼(phase `completed`, `source:'manual'`, src `''`).
  - `toQueueEntry`: 재생 불가 항목이라도 **manual + phase completed** 조합만 보존. 대기열·현재 곡 위치로 흘러들면 정규화 단계에서 구조적으로 폐기(재생 불가 유령 방지). manual 아닌 src-less 항목은 기존대로 폐기.
- **UI (`src/components/QueuePanel.jsx`, CSS 파일 무변경 — 기존 클래스 재사용)**:
  - history 아코디언에 직접 추가 폼(제목 필수 + 가수 선택, `glass-input`/`queue-play-action` 재사용, 레이아웃만 인라인 flex).
  - history 항목 드래그 재정렬 — queue의 D-21 방식(entryId 식별, 드롭 시점 재계산) 그대로 이식. 드래그 하이라이트는 기존 `.queue-item.draggable.drag-over` 클래스 조건부 부여로 해결.
  - dataTransfer 타입 가드(`queueentryid`/`historyentryid`)로 대기열↔이력 교차 드롭·외부 드래그 오작동 차단.
  - manual 항목은 '다시 부르기' 버튼 disabled + 툴팁 안내(재생 정보 없음). 실제 완료 곡의 다시 부르기·삭제는 기존 동작 유지.
- **하위 호환**: 저장된 v1/v2 상태는 기존 경로 그대로 통과(회귀 없음). manual 항목은 새 스키마 확장이라 구버전 데이터에 영향 없음. 위젯은 `toLegacySong` 평면 투영의 title만 소비하므로 무수정 호환.
- **검증**: vite build·oxlint 통과. playwright-core 실렌더 12/12 통과(추가·저장·재정렬·교차 드롭 가드·삭제·새로고침 보존·requeue 활성/비활성 구분) + dev 서버 `/api/sync` 경유 위젯 setlist에 수동 항목 제목 표시 확인.

## 2026-07-17 (2)
**생애주기 Stage 5 — 위젯 projection 축소(N-08) + isPlaying/phase 발행(D-18) + history 상한(D-29) + 직접모드 위젯 URL 복원(N-01)**
- **N-08 프라이버시 (핵심)**: `Dashboard.jsx`가 원격 발행 시 `state` 전체(setlinkCatalog·youtubePlaylistCatalog·songbookMrCache·melomingChannelId·**시청자 비공개 설계인 queue**)를 공개 ntfy 토픽(`rekasong-{room}`)에 서명-평문으로 올리던 것을, 위젯이 실제 표시하는 필드만 담은 축소 projection `{ currentSong{id,title,artist,type,src(youtube만),tags,source,phase,completionReason}, history[≤50], isPlaying }`으로 교체. `toWidgetSong` 화이트리스트 팩토리로 구성 — 발행 경로 4곳(BroadcastChannel/localStorage/dev `/api/sync`/ntfy) 전부 `publishSync` 하나를 지나므로 일괄 축소.
  - 로컬 곡 src(blob:/세션 자산 id)는 발행하지 않음(`src:''`) — 위젯에서 재생 불가·정보 노출만 됨.
  - `legacyQueue` 평면 투영 제거(발행 전용이었음). 로컬 UI(QueuePanel)는 `state.queue` 그대로 사용.
- **D-18 잔존**: `isPlaying`과 `currentSong.phase`를 payload에 포함. `Widget.jsx`가 phase 우선(§5-1 상태 추측 금지)으로 `일시정지/스킵 중…/취소 중…/재생 시작 중…/버퍼링…/재생 실패` 배지를 기존 출처 배지(Meloming/Setlink)와 같은 인라인 최소 텍스트 형식으로 표시. phase·isPlaying 둘 다 없는 구버전 payload에서는 배지 미표시.
- **D-29/D-14**: 발행 history를 최근 50곡으로 cap(`WIDGET_HISTORY_LIMIT`). state 자체 cap은 미도입(발행 cap만으로 payload 비대 해소).
- **N-01**: PlaybackPanel이 미사용으로 받던 `room/publicKeyB64` props를 배선. On-Air `unconfigured`(직접 재생 모드)일 때 OBS 설정 다이얼로그의 '화면 정보 위젯' 단계가 disabled 버튼 대신 `#/widget?room=…&key=…` 주소 복사 버튼(`btn-copy` 재사용)을 노출. 구버전 room&key 위젯 URL 형식과 동일.
- **범위 외로 명시 이월**: D-12(늦게 연 위젯 빈 화면 — ntfy `since=`/접속 스냅숏)는 코드 주석으로 후속 표기. 코디네이터 상태기계·재생 로직·On-Air display 프로토콜(`toDisplayState`) 무변경.
- **하위 호환**: 구버전 위젯이 소비하는 평면 필드 계약(id=entryId, title/type/src/source/tags) 유지 — 축소 payload로도 현재곡·setlist 표시 지속. 큐 표시는 원래 설계상 비공개라 지원 범위 밖임을 명확화.
- **검증**: vite build·oxlint 통과(신규 경고 0). playwright-core + dev `/api/sync` 실렌더 22/22 통과 — payload 키가 {currentSong,history,isPlaying}뿐(카탈로그·큐·채널ID·MR캐시·blob: 부재를 발행 JSON 문자열 검사로 확인), history 50 cap·completionReason 포함, 위젯 현재곡/수동 항목/완료 이력 표시, 일시정지 시 payload(phase=paused)와 위젯 배지 반영, 직접모드 복사 버튼 활성·복사 URL로 위젯 구동.

## 2026-07-17 (3)
**생애주기 Stage 6 — 방송 출력에서 YouTube iframe 제거(전면 fail-safe)**
- **불변식 확정**: 방송 출력(직접모드·On-Air 모두)은 광고가 나올 수 있는 어떤 경로(iframe/YouTube 플레이어)도 절대 쓰지 않는다. **광고 없는 오디오가 확정되기 전엔 재생하지 않는다.** 근거: 방송 중 통제 불가 광고는 완전한 실패이고, 재생이 안 되는 편이 낫다(사용자 결정 "전면 fail-safe"). 프록시 실패 시 iframe 폴백을 두려던 초안은 **폐기** — 폴백이 존재하는 순간 불변식이 무너진다.
- `src/lib/audioProxy.js` 신설, `Dashboard.jsx`에서 `react-youtube` 의존 제거. 숨김 라이브 플레이어를 프록시 `<audio>`로 교체. 실패는 항상 `failed`(무음), 12초 시작 타임아웃 포함.
- `getYoutubeOutputSafety()`의 `'unknown'` 고정 해소 → 프록시면 `'safe'`, 아니면 `'blocked'`. 광고 여부 미상으로 재생하는 경로가 소멸.
- 재생 엔진이 `<audio>` 하나로 통일되어 YouTube 곡도 로컬과 같은 규범 스킵 경로(finishing→ended→completed)를 쓴다. iframe이라서 폴백하던 사유(§4-3 "길이를 모르면 완료 처리하지 않음") 소멸.
- StagingPanel의 iframe은 사적 미리듣기(autoplay 0) 전용으로 존치 — 방송 출력과 연결되지 않는다.
- **미해결로 남은 위험(중요)**: 운영 환경은 `.env.production`의 `VITE_ON_AIR_BASE_URL` 때문에 항상 On-Air 모드라 OBS 위젯(`OnAirPlayer.jsx`)이 플레이어를 호스팅한다. Stage 6은 직접 재생 경로만 고쳤으므로 **운영 방송에는 여전히 iframe 광고가 나간다.** Stage 6b가 완결 지점.

## 2026-07-17 (4)
**설계 전환 — 스트리밍 프록시에서 곡 준비(prepare) 파이프라인으로 (`docs/PREPARE_PIPELINE.md`)**
- **발단**: 사용자 제안 — "대기열/재생으로 넘기는 과정에서 yt-dlp로 파일을 일시적으로 받아 재생하면 안 되나?"
- **검토 결과**: 광고 차단 성능은 **동일하다**(둘 다 같은 yt-dlp/googlevideo 스트림, 광고는 플레이어 주입). 이득은 광고가 아니라 **실패 시점**이다.
  - 기존(URL 캐시 5h + 실시간 바이트 중계): yt-dlp의 모든 불확실성(봇월·URL 만료·스로틀)이 **곡이 방송에 나가는 순간** 판가름 → 곡 중간 끊김·라이브 실패 가능. 현행 fail-safe는 "광고 대신 무음"이지만 **여전히 방송 중에** 실패한다.
  - 준비 방식: 그 실패를 **전부 대기열 이전으로** 이동. 재생 시점엔 완성된 바이트만 서빙 → googlevideo 의존 0, 중간 끊김 물리적 불가, 탐색 즉시 정확.
  - `preparing→ready`가 **증거 기반**이 됨(설정 플래그 → 실제 존재하는 바이트). INV-6의 정신.
- **부수 효과(큼)**: VPS가 작업을 *폴링*하므로 **Cloudflare Tunnel 불필요** — HANDOFF 숙제 2개 중 1개 소멸(쿠키만 남음). 재생이 R2/엣지라 **VPS가 방송 경로에서 이탈**(방송 중 VPS 장애 무관).
- **함정 발견**: 기존 R2 자산 경로는 **세션 종속**(`assetKey(room, assetId)`)이고 `deleteAssets()`가 세션 종료 시 전부 삭제한다(로컬 파일용으론 올바름). 준비 캐시를 여기 넣으면 **방송마다 캐시가 날아가 봇월로 되돌아간다.** → `audio/{videoId}` **영구·전역 네임스페이스**로 분리. `session.assets`에 절대 넣지 말 것.
- **쿠키 판단 보류(계측 우선)**: 봇월은 요청량/패턴에 걸린다. R2 영구 캐시는 요청량을 **고유 영상당 평생 1회**로 줄이고, 노래방은 곡이 반복되므로 레퍼토리가 쌓일수록 0에 수렴한다. 따라서 쿠키가 애초에 불필요할 가능성이 높다. `failureKind:'botwall'` 비율을 `/v1/prepare/stats`로 계측한 뒤에만 투입한다(쿠키는 만료·밴 위험·집IP↔데이터센터IP 동시 사용이라는 의심 신호를 동반하는 부서지기 쉬운 의존성 — 필요 증명 전 투입은 순서가 거꾸로다).
- **탈출구**: 폴링 구조라 준비 워커가 **위치 독립적**이다. 사용자 PC(가정용 IP)에서 같은 코드를 돌리면 봇월·쿠키 문제 자체가 존재하지 않는다. VPS와 공존 가능(claim이 원자적).
- **하위 호환(의도된 단절)**: 준비 파이프라인 도입 시 `VITE_AUDIO_PROXY_BASE_URL` 스트리밍 경로는 **제거**한다. 두 경로 병존은 "준비 안 된 곡이 스트리밍으로 새어나가는" 우회로가 되어 불변식을 깬다. 준비되지 않은 YouTube 곡의 재생은 지원 범위 밖.

## 2026-07-17 (5) — v0.1.0
**Stage 6b+6c — 준비 게이팅 + On-Air 위젯 iframe 제거 (광고 제거 완결)**
- **★ 완결 지점**: `OnAirPlayer.jsx`에서 `react-youtube`를 삭제하고 `/v1/audio/{videoId}` `<audio>`로 교체. 운영 환경은 `.env.production`의 `VITE_ON_AIR_BASE_URL` 때문에 항상 On-Air 모드라 **Stage 6까지는 운영 방송에 여전히 iframe 광고가 나가고 있었다.** 이제 `react-youtube`는 `StagingPanel.jsx`(사적 미리듣기, `autoplay: 0`, 방송 출력과 미연결) 한 곳에만 남는다 — **방송 경로에 광고 가능 경로가 존재하지 않는다.**
- **단일 관문**: `beginPlaybackRun`이 `if (useOnAirPlayer)` 분기보다 **앞에서** `ready`가 아닌 YouTube run 생성을 차단한다 — 모드 불문. 자동 다음 곡·스킵·바로 재생·재시도 전 경로가 이 하나를 지나므로 우회로가 없다. 폴백은 어떤 조건에서도 없다(실패 = 무음).
- `getYoutubeOutputSafety(entry)`가 **곡별 증거 기반**으로 전환(`ready`→safe, 그 외 blocked). 설정 플래그 판정 폐기 — INV-6의 정신.
- `src/lib/preparePipeline.js` 신설, `audioProxy.js` 삭제. 베이스 URL은 `VITE_ON_AIR_BASE_URL` 재사용(새 env 없음). `songPrepareState()`가 소스 불문 단일 판정 지점 — 로컬 파일은 항상 ready. 알 수 없는 응답이 ready로 오인되지 않게 화이트리스트 정규화(fail-safe).
- **UX**: 대기열 준비 배지(ready는 조용한 딥그린 `--chr-vest` — 상시 표시라 네온 금지, 실패 계열만 `--accent-red`로 도드라짐 → **실패가 방송 전에 눈에 띄는 것이 이 설계의 존재 이유**). 실패 행은 '바로 재생' 슬롯을 '다시 시도'(`force:true`)로 교체 — 버튼 슬롯 재사용이라 행 폭·뷰포트 불변, `unavailable`의 유일한 부활 경로. 준비 중 즉시 재생은 에러로 튕기지 않고 **대기열 예약으로 전환**하되 라벨이 먼저 바뀌고 토스트가 확인한다(암묵 변경 방지).
- **경계에서 잡은 결함 3건** (에이전트 산출물을 그대로 받지 않고 교차 검증해서 발견):
  1. `POST /v1/prepare` 무인증 → 아무나 임의 videoId를 큐잉하면 YouTube 요청량이 폭증해 **설계가 피하려던 봇월을 그대로 부른다**(§0/§6 전제 붕괴). `/v1/audio`와 동일한 room+playerToken 게이트로 폐쇄. 원칙: **재생할 수 없으면 큐잉도 할 수 없다.** `ensureSession()`이 스테이징 시점에 토큰을 내주므로 흐름은 안 막힌다.
  2. `unavailable` 영구 실패에 **탈출구 없음** → 비공개→공개 전환 영상·오분류가 실재하는데 되살릴 방법이 없었다. `force: true` 수동 재시도 추가. **자동은 보수적(봇월 회피), 수동은 항상 가능(사용자 통제)**로 분리. force는 `attempts`도 초기화(누적 백오프를 물려받으면 수동 재시도의 의미가 반감).
  3. VPS 워커의 `unavailable` 조기 중단 최적화 → YouTube는 **클라이언트별 접근 가능성이 갈린다**(그래서 `_CLIENT_ATTEMPTS`가 여럿). `unavailable`은 자동 재시도가 없어 오분류 비용이 영구적이다. 계약 §4대로 전 클라이언트 시도 후 확정으로 철회 + 회귀 테스트 고정. **아끼는 건 몇 초, 잃는 건 곡이다.**
- **하위 호환(의도된 단절, 그래서 0.0.6 → 0.1.0)**: `VITE_AUDIO_PROXY_BASE_URL` 스트리밍 경로 제거(병존 시 준비 안 된 곡이 새어나가는 우회로가 된다 — 계약 §7). **세션 없는 직접 재생 모드의 YouTube 재생은 지원하지 않는다** — `<audio src>`는 헤더를 못 붙여 PREPARE_TOKEN 우회로를 열면 쿼리스트링으로 VPS 토큰이 샌다. 운영은 항상 On-Air라 실사용 영향 없음. 로컬 파일·대기열·이력·On-Air 세션 프로토콜은 무변경.
- **검증**: vite build·oxlint 통과(신규 경고 0). Worker(`f33a70b`)와 프론트(`971f5f7`) 교차 검증 — 게이트·`force` body·`publicJob` 응답 형태 일치. 그 과정에서 발견한 absent 고착 엣지는 `67d06c8`로 해소. 브라우저 런타임 검증은 playwright 부재로 미실시(정적 시나리오 검토로 대체) — **실배포 후 실측 필요.**

## 2026-07-18 — v0.1.1
**On-Air↔OBS 연결 진실성(presence) + OBS 설정 안내 UX (`docs/ONAIR_CONNECTION.md`)**
- **문제(실측)**: PlaybackPanel의 "OBS 플레이어 연결됨" 칩이 `onAir.connectionState`(대시보드 자신의 control 소켓)에 근거 — **OBS 위젯을 열지 않아도 초록불이 켜졌고**, 재생 게이트도 control만 확인해 위젯 0개 상태에서 load가 허공으로 나갔다.
- **Worker**: `openSocket` 스냅숏에 `presence:{player,display}` 추가(`ctx.getWebSockets()` attachment role 런타임 집계 — **DO 스토리지 스키마 불변, 마이그레이션 없음**). display 연결/해제도 control로 브로드캐스트(player와 대칭). `webSocketClose`는 같은 역할의 **다른 소켓이 남아 있으면 connected:true**를 보낸다(위젯 새로고침 시 새/구 소켓 겹침 → 거짓 false 방지). `hasConnectedPlayer(excluded)`로 닫히는 소켓을 명시 제외.
- **프론트**: `useOnAirSession`이 `playerConnected/displayConnected` 반환(스냅숏 초기화 + presence 이벤트 갱신). control 소켓이 **비의도적으로** 끊기면 presence를 false로 리셋(관측 불가=미확인, 재접속 스냅숏이 즉시 복원) — 의도된 소켓 교체(세션 업그레이드)는 리셋하지 않아 칩 깜빡임 없음.
- **재생 게이트 이동**: `beginPlaybackRun`에 위젯 presence 게이트(모든 시작 경로 공통: 즉시 재생·대기열 바로 재생·재시도·자동 다음 곡). `handleGoLive` 상단의 control 게이트는 **제거** — 이 함수는 '대기열에 추가'도 담당하므로 OBS를 아직 안 연 상태의 setlist 예약을 막으면 안 된다(송출만 막는다).
- **트러블슈팅 — 고아 세션 레이스(라이브 검증으로 발견)**: `ensureSession()`이 state 클로저 기반이라 스테이징 자동 준비(prepare 폴링)와 '주소 복사'가 겹치면 **세션이 2개** 만들어졌다 → 위젯은 세션 A, 대시보드는 세션 B에 붙어 "주소를 넣었는데 초록불이 안 켜짐" + 명령 허공 송출. `sessionRef` + in-flight 프라미스 합류로 단일화. 헤드리스 검증이 아니었으면 실방송에서야 발견됐을 결함.
- **UX**: 설정 다이얼로그 칩을 실제 presence 기반으로 — 미연결=회색 점 "OBS에 주소를 넣으면 여기 초록불이 켜집니다" / 연결=✓ 초록(`--chr-vest`, 성공 상태에만 절제). display 단계에도 동일 칩 신설. 대시보드↔서버(control) 상태는 무채색 한 줄(`obs-server-note`)로 **위젯 연결과 시각 구분**. 초심자 흐름: 소스 2개·순서 번호·'로컬 파일' 체크 해제 경고·화면 정보=무음(1920×1080)·플레이어=오디오 믹서에 이 소스만. **넣는 즉시 칩이 초록으로 바뀌는 것이 행동이 먹혔다는 즉각 피드백.** 직접 재생 모드(N-01) room&key 흐름 무변경.
- **검증(라이브 16/16)**: 배포 Worker + production preview + 헤드리스 위젯/대시보드. (a) 위젯 전 presence false (b) 위젯 연결→presence true 전이 (c) **위젯 선연결+control 재연결→스냅숏만으로 즉시 true** (d) 위젯 종료→false 전이 (e) player 미연결 즉시 재생→토스트 차단·재생 미진입. 추가: display presence 대칭, 다이얼로그 칩 회색→초록 실전이, 위젯 연결 후 같은 버튼으로 실재생(과차단 없음), 위젯 실제 오디오 진행. vite build·oxlint 신규 경고 0.
- **하위 호환**: 구 Worker 스냅숏(presence 없음)은 안전하게 false로 강등, 구 프론트는 새 presence 메시지를 무시 — 어느 방향 배포 순서든 안전. 스토리지·relay/transport 의미 불변.

## 2026-07-18 (2) — DO 쓰기 한도 소진 확인 + 최적화 병합 (Antigravity f461686)

**실측 확정: Cloudflare Durable Objects 무료 티어 쓰기 한도 초과.**
- Worker 예외: `Exceeded allowed rows written in Durable Objects free tier.` (index.js fetch)
- 증상: DO를 쓰는 모든 엔드포인트가 500(`/v1/sessions`·`/v1/prepare/stats`). `/v1/audio`(401)·404는 정상.
- 원인: `handlePlayerEvent`가 **position 이벤트(초당 1회)마다 `storage.put`** → 2시간 방송 세션당 ~7200 쓰기. 이번 세션의 다수 재생 테스트가 오늘치 무료 한도를 소진.
- **Antigravity(Gemini)가 자기 세션에서 이 문제를 진단하고 `f461686`로 선제 수정.** 본 커밋은 그 수정을 현재(presence 반영) Worker에 병합한 것.

**병합 내용 (f461686 → 현재 Worker):**
- `this.sessionState` 인메모리 세션 캐시(DO 단일 스레드라 경합 없음).
- `handlePlayerEvent`: `event.type !== 'position'` 일 때만 `storage.put` — 순수 진행도는 영속 안 함(브로드캐스트는 유지, 캐시에는 반영, 다음 상태변경에서 함께 영속).
- `webSocketClose`: 플레이어(위젯) 전원 끊김 시 재생 중 상태를 `paused`로 내려 대시보드 반영(presence 로직과 병합).
- presence 스냅숏/브로드캐스트(내 작업)와 충돌 없음.

**복구·후속:**
- 무료 티어 DO 쓰기 한도는 **매일(UTC) 리셋** → 자동 복구. 현재는 소진 상태라 On-Air/prepare 500.
- 최적화 후 실사용은 곡당 상태변경 몇 회(로드/재생/일시정지/종료)만 쓰므로 한도 근처도 안 간다. 테스트가 소진의 주범이었음.
- 다중 스트리머·완전한 안정성이 필요하면 **Workers Paid($5/월)** 로 무료 티어 한도 자체를 제거하는 것이 근본책(사용자 결정).
## 2026-07-20 (Codex) — speaker/OBS 안전 정책 경계 분리

- 스피커는 음악 감상용 일반 플레이어로 취급하고, 모바일 창 전환·PiP·백그라운드 heartbeat 지연만으로 로컬 오디오를 emergency stop/영구 unknown 잠금하지 않도록 `OnAirPlaybackAdapter` 안전 프로필을 분리했다.
- OBS 브라우저 소스는 기존 strict 프로필을 유지한다. sourceActive/sourceVisible 손실, 연결 중 authoritative event ambiguity, safety stop 실패는 기존 fail-closed 규칙을 그대로 적용한다.
- Worker는 dashboard-speaker에 한해 heartbeat throttling을 active output unknown으로 승격하지 않는다. 실제 소켓 단절과 route 전환의 inactive 증거 요구는 유지한다.
- unknown 스피커에서 같은 송출경로 버튼을 다시 누르면 deactivation을 먼저 시도해 inactive 증거를 만들고 재활성화할 수 있다. OBS로 자동 전환하거나 재생을 자동 재개하지 않는다.
- 회귀 테스트: adapter 55개, output controller 48개, Worker Protocol v2 106개 중 변경 시나리오 포함 전부 통과. 상세 설계와 수동 모바일/OBS 확인 항목은 `docs/SPEAKER_OBS_SAFETY_BOUNDARY_2026-07-20.md`에 기록했다.

## 2026-07-20 (Codex) — 스피커 복구 후보 대기 순서 보정

- 끊긴 dashboard-speaker lease가 `unknown`에서 `inactive`으로 정리되는 순간, 새 페이지 소유 플레이어가 아직 후보로 재등록되지 않았다는 이유로 출력 전환을 즉시 `candidate_count` 차단하던 순서 버그를 수정했다.
- 스피커 복구도 첫 연결과 동일하게 page-owned 후보 등록을 기다린 뒤 정확한 player identity가 확인되면 activate하도록 통일했다. OBS 경로의 엄격한 후보 검증은 변경하지 않았다.
- 회귀 테스트를 추가하고 로컬 브라우저에서 새로고침 후 `ready → 스피커 송출 중`, 설정 패널에서 `선택: 스피커 / 실제 활성: 스피커`를 확인했다.
- 이전 탭의 외부 스피커 후보가 하나 남아 있는 경우도 page-owned 후보가 돌아올 때까지 기다리도록 보완했다. 외부 후보를 임의로 활성화하지 않으며, 두 개 이상이면 기존처럼 차단한다.

## 2026-07-20 (Codex) — 송출 UI를 다음 행동 중심으로 보강

- 송출 헤더에 상태만 표시하지 않고 `다음 행동` 안내를 항상 함께 표시한다.
- 스피커/OBS 활성·연결 중·후보 없음·제어권 충돌·복구 필요 상태마다 사용자가 눌러야 할 버튼이나 확인할 위치를 한국어/영어 번역 키로 제공한다.
- 상태 계산과 행동 안내 키를 분리해 기존의 authoritative 상태 판정은 유지하고, 안내 문구만 독립적으로 번역·테스트할 수 있게 했다.
## 2026-07-21 (Codex) — Speaker heartbeat candidate eligibility

- Speaker players send heartbeats every 5 seconds so mobile/background/PiP playback is not forced to stop, but the Worker was excluding every stale heartbeat after 2 seconds. A live speaker socket therefore disappeared from `eligibleCandidates` even while its player was ready, causing route selection to fall back to “output route needs confirmation”.
- Speaker candidate eligibility now uses the live WebSocket and `sourceActive !== false`; OBS retains the strict 2-second heartbeat and runtime attestation gate. Added a regression test for a speaker candidate at the stale boundary.
