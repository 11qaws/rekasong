# Phase 06 — 반응형 통일 디자인 (Responsive Unity)

> 목표: narrow(좁은 화면)와 wide(넓은 화면)를 **하나의 반응형 시스템**으로 통일하고,
> 핵심 시나리오(검색 → 곡 정보 확인 → 방송 제어)가 **한 화면 안에서 스크롤 없이** 완결되게 한다.
> 색은 "중립 60%+ / 딥그린(--chr-vest) 구조 액센트 30% / 네온 에메랄드(--eureka-emerald) ≤10%" 위계를 강제한다.

---

## 1. Before — 진단

### 1-1. 레이아웃 (스크롤 문제)
- `Dashboard.css`에 3세대 레이아웃(2단 그리드 → workflow/live → live-console)이 **겹겹이 덧쓰기**되어 있었고,
  최종 상태는 "페이지 전체가 `overflow-y: auto`로 세로 스크롤"이었다.
- 검색 결과·노래책 리스트(최대 100곡)가 **페이지를 무한정 늘려서**, wide 화면에서도
  대기열/재생 컨트롤이 화면 밖으로 밀려났다. 뷰포트 잠금 규칙(`height: calc(100vh - 220px)`)은
  후속 덧쓰기(`height: auto`)로 사실상 무력화된 상태.
- 죽은 셀렉터 다수: `.workflow-column`/`.live-column`(JSX에 미존재), `.search-tabs`,
  구형 `@media 1200px` 블록(캐스케이드상 이미 무효).

### 1-2. 미정의 CSS 변수 (조용히 죽어 있던 스타일)
| 변수 | 사용처 | 증상 |
|---|---|---|
| `--accent-red` | 패닉 경고, `.mr-unavailable`, `.go-live-next` | 속성 무효 → 경고 색이 아예 안 나옴 |
| `--eureka-azure` | Setlink 액센트, 재분석 버튼 | 텍스트 색 상속으로 위장 |
| `--bg-panel` | 드롭존 sticky 배경 | 배경 투명 → 리스트가 드롭존 뒤로 비침 |
| `--text-dim`, `--neon-cyan` | index.css 스크롤바 | 스크롤바 썸 투명(안 보임) |

→ **기존에 쓰이던 리터럴 값을 변수로 승격**해 보완(새 색 발명 아님): `--eureka-azure: #6D9ABD`(기존
`rgba(109,154,189,…)` 리터럴과 동일), `--accent-red: #EF4444`(기존 danger 리터럴), `--bg-panel: var(--bg-mid)`.

### 1-3. 다크테마 잔재 (라이트 테마에서 보이지 않던 것들)
- `.glass-card { border: rgba(255,255,255,0.08) }`가 캐스케이드에서 `.panel`의 실버 테두리를 **지우고** 있었음 → 모든 패널이 사실상 무테.
- 스크롤바 썸 `rgba(255,255,255,0.2)`(흰 배경 위 흰색), `.songbook-item:hover` 흰 반투명 배경,
  토스트 액션 버튼 흰 반투명 배경, `.result-item:hover`의 검정 0.3 그림자 등.
- `.btn-secondary`는 **스타일 정의가 아예 없어** 브라우저 기본 버튼으로 렌더("파일 선택", "방송 세션 종료", "다른 MR 찾기").

### 1-4. 녹색 남용
- 탭 활성 배경이 네온 에메랄드 풀필(상시 노출 면적) + 글로우 그림자.
- 흰 배경 위 네온 에메랄드 **텍스트**(`songbook-mr-state.is-linked`, AI 단계 트랙, "저장된 곡명 적용 완료" 등) — 가독성 불량이자 위계 붕괴.
- `#10b981`(구형 그린, 팔레트 외) 텍스트/그림자 산재.

---

## 2. After — 하나의 시스템

### 2-1. 뷰포트 우선 · 무스크롤 전략

**Wide (>1100px): 뷰포트 잠금.** `calc()` px 상수 대신 플렉스 체인으로 100vh를 정확히 분배한다
(헤더 높이가 변해도 안 깨짐 — calc(100vh - 220px) 접근의 강화판).

```
.dashboard-container  height:100vh; flex column; overflow:hidden   ← 페이지 스크롤 금지
└ .dashboard-grid     flex:1; min-height:0
                      rows: auto minmax(0,1fr)                      ← 핵심
                      areas: 'playback playback' / 'queue composer'
   ├ playback  1행: 콘텐츠 높이 (재생 스트립)
   ├ queue     2행 좌: 셀 높이 고정 → queue-list만 내부 스크롤
   └ composer  2행 우: 셀 높이 고정 → search-results만 내부 스크롤
```

- 잠금 체인: 영역(flex) → `.song-composer`(flex:1) → motion 래퍼(flex:1) → `.panel`(flex:1, `min-height:0`, overflow:hidden).
- `staging-active`여도 그리드는 불변(2단계는 composer 내부 교체) — 화면이 덜컥이지 않는다.

**Narrow (≤1100px): 스택 + 예측 가능한 스크롤.** 기존 방향성(재생 → 대기열 → 곡 추가 세로 스택)을 보존.
페이지 스크롤은 허용하되 각 리스트를 캡(`queue-list` 300px, 검색 결과 48vh)해서
**페이지 길이가 콘텐츠 양과 무관하게 일정**하도록 했다. 100곡 노래책을 붙여도 페이지는 3패널 높이로 고정.

**Compact (≤768px):** 구 768/650 두 블록을 하나로 통합. 헤더 네거티브 마진이 컨테이너 패딩과 어긋나
가로가 잘리던 버그(768~650 구간)도 이 통합으로 해소.

**컨테이너 쿼리 (반응형 통일의 핵심 장치):** 2단계 미리보기(`.staging-media-info`)는 뷰포트가 아니라
**composer 칼럼의 실제 폭**에 반응한다(`container-type: inline-size`, 620px 기준).
→ 1920px 화면(칼럼 650px)에서는 좌우 배치, 1366px 화면(칼럼 520px)에서는 세로 스택,
narrow 전체폭 패널에서는 다시 좌우 배치. 같은 컴포넌트가 어디서든 알맞은 형태. (미지원 브라우저는 768px 미디어쿼리 폴백)

### 2-2. 내부 스크롤 UX 원칙 (스크롤 난립 방지)

> 지시 반영: "패널 내부 스크롤도 UX 검토 대상 — 불필요한 스크롤이 이곳저곳 생겨 미감을 해치면 안 되고, 스크롤 자체도 테마 적용."

1. **패널당 스크롤 영역 최대 1개**, 그것도 '무한히 자랄 수 있는 리스트'에만:
   - 대기열 패널 → `.queue-list` (히스토리 아코디언은 접혀 있고, 열면 자체 180px 캡)
   - 곡 추가 패널 → `.search-results` (탭·검색폼·드롭존은 **항상 보임**)
   - 2단계 패널 → 리스트가 없으므로 세로가 모자랄 때만 패널 자체가 스크롤
2. **중첩 스크롤 구조적 제거**: `tab-content`(inline `overflow:auto`)가 결과 리스트와 이중 스크롤되지 않도록
   `min-height: 0` 체인으로 리스트가 먼저 수축·스크롤하게 강제. tab-content의 overflow는 폴백으로만 남음.
3. **넘칠 때만 스크롤바**: 전부 `overflow-y: auto`. 평상시(곡 5곡 이하 등)에는 스크롤바 자체가 없다.
4. **레이아웃 점프 방지**: 스크롤 리스트에 `scrollbar-gutter: stable` — 스크롤바가 생겼다 사라져도 행이 밀리지 않음.
5. **스크롤바 테마 통일**(index.css 한 곳에서): `scrollbar-width: thin; scrollbar-color: var(--chr-silver) transparent`
   (Firefox·Chromium 121+) + webkit 폴백(6px 실버 썸/투명 트랙, hover 시 딥그린).
   Dashboard.css의 다크테마용 흰 반투명 스크롤바 재정의는 삭제.
6. **sticky 비침 버그 수정**: 스크롤되는 스테이징 패널에서 위쪽 *패딩 영역*으로 지나가는 콘텐츠(검은 영상 프리뷰)가
   sticky 제목 위에 비쳐 보였다 → 패널 `padding-top: 0` + sticky 제목이 그 간격을 불투명하게 대신 채움.

### 2-3. 색 위계 규칙 (문서화된 계약)

| 층 | 색 | 허용 용도 | 이번에 정리한 것 |
|---|---|---|---|
| 60%+ 중립 | `--bg-deep/--bg-mid/--chr-silver/--text-*` | 배경, 패널, 테두리, 본문 | `.glass-card` 테두리 복구, 호버 배경을 `--bg-deep`으로 |
| 30% 구조 액센트 | `--chr-vest` (딥그린) | 메인 버튼, **활성 탭**, 흰 배경 위 상태 텍스트, 슬라이더 accent | 탭 활성 배경 네온→vest, AI 트랙/연결됨/상태 텍스트 네온→vest, progress-slider 기본파랑→vest |
| ≤10% 네온 | `--eureka-emerald` | ON AIR·현재재생(비주얼라이저, active 행), **포커스링**, 드래그/드롭 순간, 재생 CTA | 포커스링을 `:focus-visible` 에메랄드로 일원화. 재생 버튼만 에메랄드 유지(아이콘은 네이비로 대비 확보) |
| 보조 | `--chr-hat`(네이비), `--eureka-lemon`, `--accent-red` | 헤더/새치기 버튼, 복사 호버, 위험 동작 | `.go-live-next`를 red→navy로(새치기는 파괴적 동작이 아님), 패닉 armed 상태는 red 활성화 |

### 2-4. 프리미엄 완성도 소항목
- `.btn-secondary` 기본 스타일 신설(중립 테두리, hover 시 vest) — 미스타일 기본 버튼 제거.
- `.btn-icon-danger`의 95px 고정 최소폭 제거(현재 전부 아이콘 전용 — 패닉/X 버튼이 비정상적으로 넓었음).
- 히스토리 행 액션 아이콘 가로 정렬(세로로 쌓여 행이 ~90px로 비대) + 대기열 행과 밀도 통일(42px).
- 탭: 레이블 `white-space: nowrap` + 컨테이너 `flex-wrap`(+`flex-basis: auto`, `min-width: 0` — basis 0%면 wrap이 영영 발동 안 함).
- `.queue-list`에 `grid-template-columns: minmax(0,1fr)` — 긴 곡명이 트랙을 max-content로 밀어
  모바일에서 버튼이 화면 밖으로 나가던 버그 수정. `.history-title`에도 `min-width: 0`.
- `.step-number` 노란 글로우, `.btn-copy` 중복 에메랄드 글로우, 토스트 0.3 검정 그림자 등 과한 효과 절제.
- 빈 대기열 플레이스홀더가 남는 공간을 채우도록(`:has(> .queue-empty)`) — 어색한 여백 제거.

---

## 3. Before → After 근거 (실기기 헤드리스 캡처로 검증)

vite preview + Chrome headless(+playwright-core로 상태 주입·인터랙션)로 실측:

| 시나리오 | Before | After |
|---|---|---|
| 1920×1080, 대기열 12곡 | 페이지 세로 스크롤 발생(리스트가 페이지를 늘림) | **페이지 무스크롤**, 12곡 전부 한 화면, 초과분은 리스트 내부 스크롤 |
| 1366×768, 대기열 12곡 + 히스토리 열림 | 세로 스크롤 + 히스토리 행 비대(~90px) | 무스크롤, 히스토리 42px 행, queue-list 내부 스크롤 |
| 1280×620 (초저높이) | 세로 스크롤 | 무스크롤 — 검색 힌트가 먼저 수축하며 폼·드롭존 유지 |
| 2단계(스테이징) 1920 / 1366 / 400 | 뷰포트 기준 650px에서만 1열 전환 | 칼럼 폭 기준 자동 전환(650px 칼럼=2열, 520px 칼럼=1열, 400 모바일=1열) |
| 400×850 (모바일) | 탭 4개 가로 오버플로(Setlink 잘림), 대기열 행 버튼이 화면 밖 | 탭 2행 wrap, 대기열 행 말줄임 + 버튼 보임. 페이지 스크롤 총량 = 3패널 고정 높이 |
| 세로 스크롤 총량 (wide) | 콘텐츠 양에 비례해 무한 증가 | **0** (페이지 기준). 내부 스크롤은 패널당 최대 1개 |

캡처 파일(스크래치패드): `pw_wide1920/1366`, `pw_short1280`, `pw_mobile400`, `pw_q_1920/1366/mobile`(대기열 주입),
`pw_staging_debug/1366_fixed/mobile2`(2단계), `pw_setlink_tab`(온보딩).

---

## 4. 2차 파급효과 검토 (Risk Hedging)

| 변경 | 잠재 파급 | 검토/방어 |
|---|---|---|
| `--accent-red` 정의 활성화 | 이 변수를 쓰던 곳이 일제히 빨개짐 | 전수 조사: 패닉 armed(의도된 경고, 개선), `.mr-unavailable`(에러 텍스트, 개선), `.go-live-next`(새치기 버튼 — 빨강은 오해 소지 → **네이비로 명시 변경**) |
| 그리드 고정높이 + `min-height:0` 체인 | 초소형 창에서 내용 클리핑 | `.queue-panel overflow:hidden` + 리스트 min-height 바닥값, 2단계 패널은 자체 스크롤. 1280×620 실측 통과 |
| `.panel` 높이 잠금 | framer-motion(layout/AnimatePresence) 래퍼와 충돌 | motion 래퍼를 flex 체인에 포함(`.song-composer > div`), 실렌더 확인 — 전환 정상 |
| `:focus` → `:focus-visible` | 마우스 클릭 시 포커스 링 사라짐 | 의도된 개선(웹 관습). 키보드 접근성은 에메랄드 링으로 오히려 강화. 입력창은 기존 `.glass-input:focus` 스타일 유지 |
| 탭 `flex-wrap` | 중간 폭에서 어중간한 2행 | nowrap 레이블 + basis auto라 필요할 때만 wrap. 1366/1920 1행, 400 2행 실측 |
| `:has()`, `@container`, `scrollbar-gutter` | 구형 브라우저 미지원 | 전부 **점진적 향상**: 미지원 시 기존 동작(빈 대기열 상단 정렬, 768px 미디어쿼리 폴백, 스크롤바 점프)으로 자연 강등. 대시보드는 스트리머 본인용 최신 Chrome/Edge 전제 |
| 스테이징 패널 `padding-top:0` | 다른 패널 제목과 간격 불일치 | `.staging-panel > .panel-title`에만 한정한 보정 패딩. narrow(스크롤 없음)에서도 시각 결과 동일 |
| localStorage 구버전 상태 | 하위 호환 | 상태 스키마·키(`karaoke_app_state`) 무변경. CSS만의 변경이므로 구버전 데이터 완전 호환 |
| GitHub Pages/OBS | 정적 호스팅 제약 | 순수 CSS 변경, 외부 리소스 추가 없음. Widget.css(OBS 오버레이)는 의도적으로 무변경 — 방송 화면 리스크 0 |

**의도적으로 남긴 것(선 넘지 않기 위해):**
- StagingPanel의 Meloming/Setlink 소스 뱃지 인라인 색(네온 배경 + 흰 글자, 대비 낮음) — 인라인 style이라 CSS만으로는
  `!important` 남발 없이 못 고침. JSX 색상 변경은 이번 범위(레이아웃 최소 변경) 밖으로 판단, 후속 제안으로 남김.
  (단, `.ai-status-done`은 클래스가 있어 클래스 레벨에서 교정함.)
- `LivePanel.jsx`/`OnAirPlayer.jsx` 전용 CSS(위젯/구패널)는 미사용이어도 보존 — 플레이어 예열 커밋과의 충돌 방지.

## 5. 검증
- `npm run lint` 통과(경고 6건은 기존과 동일, 전부 JS 파일 — 본 변경과 무관).
- `npm run build` 통과.
- 헤드리스 실렌더 검증: 6개 뷰포트 × 4개 상태(기본/대기열 12곡/2단계/온보딩) 스크린샷 — 3절 표 참조.
