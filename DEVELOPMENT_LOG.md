# Rekasong 개발 로그 (DEVELOPMENT_LOG)

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
