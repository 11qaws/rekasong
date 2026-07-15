# Rekasong 개발 로그 (DEVELOPMENT_LOG)

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
