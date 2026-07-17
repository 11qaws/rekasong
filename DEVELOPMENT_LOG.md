# Rekasong 개발 로그 (DEVELOPMENT_LOG)

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
