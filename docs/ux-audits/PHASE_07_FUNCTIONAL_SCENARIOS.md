# PHASE 07 — 시나리오 기반 기능성 심층 감사 (소스 무관 일관성 중심)

- 감사일: 2026-07-16 · 감사 방식: 정적 코드 감사(읽기 전용), 실행 검증 미수행 항목은 '검증 필요' 표기
- 품질 기준: "방송 중 단 한 번의 예기치 않은 동작도 신뢰를 깬다" — 각 결함에 신뢰 영향(trust impact) 1줄 명시
- 대상: src/components/{SearchPanel,StagingPanel,LivePanel}.jsx, src/pages/{Dashboard,Widget}.jsx,
  src/hooks/{useSyncState,useRemoteSync,useAiTitleExtraction,useMeloming,useSetlink}.js, functions/api/*

> 심각도 요약: **High 8 · Medium 14 · Low 9**

---

## 1. 버튼/컨트롤 인벤토리 (영역별·위치별)

### 1-1. SearchPanel (1단계 · 노래 찾기)
| 위치 | 컨트롤 | 의도된 동작 | 실제 배선 |
|---|---|---|---|
| 상단 탭 | 유튜브 검색 / 멜로밍 / Setlink | 소스 전환, 선택 탭 영속화 | `handleTabChange` → `activeIntegrationTab` 공유상태 저장 (SearchPanel.jsx:35-38) |
| 검색폼 | 검색 버튼(＋Enter) | 키워드 검색 또는 URL/ID 즉시 스테이징 | `searchYoutube` — URL/11자 ID면 `onSelectResult` 직행 (40-61) |
| 결과 행 | 행 클릭 | 2단계 스테이징 + AI 제목추출 시작 | `onSelectResult` → `handleSelectSearchResult` (Dashboard.jsx:172-190) |
| 결과 행 우측 | ⚡ (빠른재생) | 검토 없이 즉시재생 또는 대기열 끝 예약 | `handleQuickPlay` (Dashboard.jsx:192-213) |
| 하단 | 로컬 파일 드롭존/파일 선택 | audio/*, 50MB 이하 → 스테이징 + ID3/AI 추출 | `addLocalFile`→`onLocalFileDrop` (SearchPanel.jsx:103-119, Dashboard.jsx:215-260) |
| 노래책(연동 전) | "내 노래책 불러오기" | 채널ID/공유URL 연결 | `handleIntegrationConnect` (121-132) |
| 노래책(연동 후) | 새로고침 / 해제 / 곡별 "준비"·"MR 찾기" | 재조회 / confirm 후 해제 / 유튜브 탭으로 전환해 MR 검색 | `refresh`, `handleIntegrationDisconnect`, `handleSongbookSearch` (96-101) |

### 1-2. StagingPanel (2단계 · 곡 정보 확인)
| 위치 | 컨트롤 | 의도된 동작 |
|---|---|---|
| 타이틀 우측 | "비우기" (X) | 스테이징 취소 + 진행 중 AI 중단 (`handleClearStaged`, Dashboard.jsx:271-275) |
| 폼 | 곡명/가수 입력 (Enter=송출) | 사용자 수정 시 `isTitleEdited/isArtistEdited` 세워 AI 덮어쓰기 차단 (Dashboard.jsx:262-269) |
| 하단 | "즉시 재생 (방송 송출)" / "대기열에 추가" | currentSong 유무에 따라 라벨 전환, `onGoLive(false)` |
| 하단(재생 중일 때만) | "바로 다음 곡으로 (새치기)" | `onGoLive(true)` → queue 최상단 삽입 |
| 미리보기 | YouTube iframe(수동) / `<audio controls>` | 소스별 사전 청취 |

### 1-3. LivePanel (3단계 · 방송 제어)
| 위치 | 컨트롤 | 의도된 동작 |
|---|---|---|
| 헤더 | ⏸/▶ 토글, "비상 정지"(2단 확인, 3초 창) | 재생토글 / currentSong+queue 전체 정지 (LivePanel.jsx:113-127) |
| OBS 아코디언 | 통합/현재곡/셋리스트 위젯 URL 복사, 미리보기 iframe | 위젯 URL 클립보드 복사 (33-43) |
| Now Playing | ⏸/▶, 음소거 토글, 볼륨 슬라이더, "스킵", "다시 예약", seek 슬라이더 | 재생 제어 (194-242) |
| 대기열 | 드래그 재정렬, 곡별 X(되돌리기 토스트), "전체 비우기"(confirm) | 큐 관리 |
| 재생 옵션 | 자동 다음 곡 체크박스 | `autoPlayNext` 공유상태 (274-289) |
| 이전 재생 곡 | ↑(대기열 맨 위 재호출), 🗑("위젯 기록에서 삭제", confirm) | 히스토리 관리 (351-356) |

### 1-4. Dashboard (전역)
- Space: 재생/일시정지 토글(입력창 제외) · Ctrl+→: 다음 곡 (Dashboard.jsx:151-170)
- 숨김 플레이어: YouTube(onEnd/onError/onStateChange=3 지연감지), `<audio>`(onEnded/onError/onWaiting) (505-548)
- 원격 publish: state 변경마다 `publishSync({state, timestamp})` (143-148)

### 1-5. Widget (OBS)
- 파라미터: `room`, `key`, `type`(current/setlist/없으면 둘 다). `preview` 파라미터는 **판독하지 않음** (Widget.jsx:9-18)
- 표시: 현재곡(앨범아트+제목+태그+meloming/setlink 배지), setlist 영역(=**queue만**, Widget.jsx:103)

---

## 2. 사용 시나리오 매트릭스 (초심자 스트리머 × 5개 소스)

소스: **A**=유튜브 검색 / **B**=URL·영상ID 직접 / **C**=로컬 파일 / **D**=Meloming(목업) / **E**=Setlink(목업)

| 시나리오 → 검증 질문 | A 검색 | B URL/ID | C 로컬 | D Meloming | E Setlink |
|---|---|---|---|---|---|
| **스테이징→송출**: 2단계에 올린 곡이 수정한 제목 그대로 나가는가? | ○ (AI 완료 전 Enter 시 원제 송출 — D-19) | ✗ AI 실패 시 "(분석 중...)" placeholder 송출 가능 (D-07) | ○ (ID3→AI 순, 사용자 수정 보존 ○) | △ 검색결과 경유 시 source/tags 소실 (D-15) | △ 동일 (D-15) |
| **즉시재생 vs 예약 구분**: 버튼이 지금 무엇을 할지 알 수 있는가? | △ ⚡는 재생 중이면 예약으로 변함(툴팁만) | 해당 없음(⚡ 경로 없음) | ○ 라벨 전환됨 | △ "준비/MR 찾기"가 실제론 유튜브 검색으로 튐 | △ 동일 |
| **대기열 재정렬/삭제**: 재생 종료와 겹쳐도 올바른 곡이 움직이는가? | ✗ 드래그 중 큐 소비 시 stale index (D-21) | 동일 | 동일 | 동일 | 동일 |
| **스킵**: 버튼 클릭으로 다음 곡이 나오는가? | ✗ **버튼 무동작** (D-01), Ctrl+→만 동작 | ✗ 동일 | ✗ 동일 | ✗ 동일 | ✗ 동일 |
| **다시예약 후 재생**: 예약 사본이 문제없이 재생되는가? | ○ (key에 song.id 포함 → 리마운트) | ○ | ✗ blob revoke(D-02) / 연속 동일곡 무음정지(D-06) | ○(유튜브 경유이므로 A와 동일) | ○ |
| **히스토리 재호출**: 이전 곡을 다시 부를 수 있는가? | ○ | ○ | ✗ blob revoke (D-02), 새로고침 후엔 항목 자체 소실 (D-04) | ○ | ○ |
| **위젯 표시**: 소스와 무관하게 같은 품질로 뜨는가? | ○ 썸네일+제목 | ○ (단 placeholder 제목 위험) | ✗ 무관한 unsplash 사진, 배경블러 없음 (D-24) | △ 배지 뜨나 검색결과 경유 시 소실 | △ 동일 |
| **실패 시 처리**: 곡이 안 나올 때 알려주고 건너뛰는가? | ○ 오류코드별 토스트+400ms 후 스킵 | ○ (삭제/비공개 등 안내) | ○ (단 revoke로 인한 실패도 "형식 오류"로 오보고) | A와 동일 | A와 동일 |
| **자동 다음 곡 OFF + 종료**: 다음 큐 곡을 시작할 수 있는가? | ✗ 시작 버튼 없음 (D-03) | ✗ | ✗ | ✗ | ✗ |
| **새로고침 복원**: 상태가 그대로 돌아오는가? | ○ | ○ | ✗ 큐/히스토리/현재곡에서 **조용히 삭제** (D-04) | ○ (곡은 유튜브 타입) | ○ |
| **비상정지**: 2번 클릭으로 전부 멈추고, 부른 곡 기록은 남는가? | △ currentSong이 history에 안 남음 (D-20) | △ | △ | △ | △ |

---

## 3. 발견된 결함 목록 (심각도순)

### HIGH

**D-01 [데이터연결·High] '스킵' 버튼 완전 무동작**
- 재현: 아무 곡이나 재생 → Now Playing의 "스킵" 버튼 클릭 → **아무 일도 일어나지 않음**. Ctrl+→는 동작.
- 원인: `LivePanel.jsx:210` `<button onClick={onSkip}>`이 클릭 이벤트를 첫 인자로 전달 →
  `Dashboard.jsx:328-332` `handlePlayNext(expectedSongId)`의 가드
  `if (expectedSongId && prev.currentSong?.id !== expectedSongId) return prev;`
  에서 SyntheticEvent(truthy) ≠ 곡 id → 항상 `prev` 반환.
- 신뢰 영향: 방송 중 가장 자주 쓰는 버튼이 소리소문없이 죽어 있음 — 즉시 신뢰 붕괴.
- 수정 방향: `onClick={() => onSkip()}` 또는 `onSkip={() => handlePlayNext()}`.

**D-02 [데이터연결·High] 로컬 blob revoke로 재예약/재호출 로컬 곡 재생 불가**
- 재현: 로컬 곡 A 재생 → "다시 예약" → 다른 곡(유튜브든 로컬이든)으로 전환 →
  `Dashboard.jsx:74-80` cleanup이 `URL.revokeObjectURL(blobA)` 실행 → 큐의 A 사본 차례에
  audio error(코드 2/4) → "로컬 음원을 재생할 수 없습니다" 토스트 후 자동 스킵.
- 원인: revoke가 "이 blob을 참조하는 곡이 큐/히스토리에 남아 있는가"를 고려하지 않음. 히스토리 ↑재호출도 동일.
- 신뢰 영향: "다시 예약했는데 그 곡 차례에 엉뚱한 에러" — 예측 불가능성의 전형.
- 수정 방향: revoke를 세션 종료/명시적 삭제 시점으로 미루거나, 참조 카운팅(state 내 동일 src 존재 시 revoke 금지).

**D-03 [논리오류·High] autoPlayNext OFF에서 곡 종료 후 대기열을 시작할 마우스 수단 없음**
- 재현: 자동 다음 곡 꺼짐 + 큐 2곡 → 현재 곡 종료 → currentSong=null →
  스킵/재생 버튼은 `currentSong` 있을 때만 렌더(`LivePanel.jsx:181-250`), 큐 항목에는 재생 버튼 없음.
  빈 상태 문구 "1단계에서 노래를 찾고, 2단계에서 재생을 시작하세요"(247-248)는 큐가 차 있어도 표시 — 오도.
- 신뢰 영향: 초심자는 큐가 먹통이 됐다고 인식. Ctrl+→ 단축키를 모르면 복구 불능처럼 보임.
- 수정 방향: currentSong 없고 큐가 있으면 "다음 곡 시작" 버튼 노출 + 빈 상태 문구 분기.

**D-04 [데이터연결·High] 로컬 곡의 무통보 소실 (새로고침·멀티탭)**
- 원인: `useSyncState.js:28` `keepSong = isPlayableSong(song) && !(fromStorage && song.type === 'local')`.
  - 새로고침: 큐/히스토리/현재곡의 로컬 곡이 **아무 안내 없이** 삭제됨.
  - 멀티탭: 대시보드를 두 탭 열고 두 번째 탭에서 아무 조작(볼륨 외 setSharedState) → 필터링된 상태가
    저장되고 storage 이벤트로 첫 탭에 전파(`useSyncState.js:62-74`, fromStorage:true) → **재생 중이던 로컬 곡까지 즉시 소멸**.
- 신뢰 영향: 방송 준비한 로컬 MR 셋리스트가 증발 — 치명.
- 수정 방향: 소실 시 토스트/복구 안내(파일 재선택 유도), 멀티탭 감지 경고, 로컬 곡을 placeholder(재연결 필요)로 남기기.

**D-05 [인지착각·High] "위젯 기록"의 의미가 실제 위젯과 어긋남 (history vs queue)**
- 근거: 위젯 setlist 영역은 `queue.map(...)`만 렌더(`Widget.jsx:103`) — history는 위젯 어디에도 표시 안 됨.
  그런데 대시보드 히스토리 삭제는 confirm "정말 위젯 기록에서 삭제하시겠습니까?"(`LivePanel.jsx:74`),
  버튼 title "위젯 기록에서 삭제"(`:354`). LivePanel의 "셋리스트 복사" 버튼(:158)도 '부른 곡 목록'으로 오인 유도.
- 신뢰 영향: 스트리머가 "방송 화면에 뭐가 나가는지"를 오해 — 지웠는데 그대로 있거나, 부른 곡이 setlist에 안 쌓임.
- 수정 방향: 위젯 setlist에 history(+현재곡+큐)를 표시하든지, 라벨을 "기록에서 삭제"로 고치고 위젯 표시 대상을 명시.
  (참고: `Widget.jsx:104-105`의 `isCurrent/isPast`는 currentSong이 queue에 절대 없으므로 **죽은 코드** — 원설계는 setlist에 현재/과거 곡 포함이었음을 시사.)

**D-06 [논리오류·High] 같은 로컬 곡 연속 재생 시 무음 정지 + ON AIR 오표시**
- 재현: 로컬 곡 A 재생 중 "다시 예약" → 자동 다음 곡 ON → A 종료 → 큐의 A′(같은 blob src) 차례.
- 원인: `<audio>`는 song.id 기반 key가 없어(`Dashboard.jsx:529-547`) src 불변이면 리마운트 안 됨(autoPlay 미발동).
  `playAudioForSong`의 `setIsPlaying(true)`(:278)는 이미 true라 `[isPlaying]` 이펙트(:45-53)도 재실행 안 됨 → `play()` 미호출.
  ended 상태로 정지하지만 헤더는 🔴 ON AIR 유지. 유튜브는 key에 `currentSong.id` 포함(:508)이라 정상 — **소스별 동작 차이**.
- 신뢰 영향: "노래가 나와야 하는데 침묵 + 표시등은 방송 중" — 최악의 조합. (검증 필요: play() 호출 시 ended→처음 재생은 스펙상 가능하나 호출 자체가 안 됨)
- 수정 방향: audio에도 `key={currentSong?.id}` 부여, 또는 곡 전환 시 `audioRef.currentTime=0; play()` 명시 호출.

**D-07 [인지착각·High] placeholder 제목이 방송에 그대로 송출될 수 있음 + 경로별 제목 품질 상이**
- 재현1: URL 붙여넣기 → 스테이징 제목 "URL 직접 입력 영상 (분석 중...)"(`SearchPanel.jsx:54`) → AI 실패(상태 문구만 변경, 제목 유지) → 송출 버튼은 `title.trim()`만 검사(StagingPanel.jsx:90) → 위젯에 "URL 직접 입력 영상 (분석 중...)" 표시.
- 재현2: 같은 곡을 ⚡즉시재생하면 검토·AI 없이 원본 유튜브 제목(【MR】... 따위) 그대로 송출(`Dashboard.jsx:192-213`) — 행 클릭 경로와 결과 품질이 다름.
- 신뢰 영향: 방송 화면에 시스템 내부 문구/잡음 제목 노출.
- 수정 방향: placeholder 제목인 동안 송출 버튼 비활성 또는 경고, ⚡ 경로에도 최소한의 제목 정리/확인.

**D-08 [데이터연결·High·검증 필요] 배포 대상 불일치 — GH Pages라면 검색·AI 전면 불능**
- 근거: `/api/search`, `/api/extract-title`, `/api/extract-local`은 `functions/api/*`(Cloudflare Pages Functions 규격).
  GitHub Pages 정적 호스팅에는 함수 실행 환경이 없어 전부 404 → 검색/AI 추출/로컬 AI 전부 실패.
  `vite.config.js`에 `base` 미설정 — GH Pages 프로젝트 페이지(`/repo/`)라면 자산 경로도 깨짐.
- 신뢰 영향: 핵심 기능(1단계 검색)이 환경에 따라 통째로 죽음.
- 수정 방향: 배포 대상 확정(CF Pages 권장) 또는 GH Pages 모드에서 검색 UI를 "URL 직접 입력 전용"으로 명시 강등.

### MEDIUM

**D-09 [데이터연결·Med] 곡 id `Date.now().toString()` 충돌**
- 위치: `Dashboard.jsx:194`(⚡), `:299`(송출), `LivePanel.jsx:84`(재호출), `:215`(다시예약).
- 재현: "다시 예약" 더블클릭(같은 ms) → 동일 id 2개 → React key 중복, X 클릭 시 `filter(id)`로 **둘 다 삭제**, `expectedSongId` 가드 신뢰성 저하. 토스트/스테이징 id는 이미 `Date.now()+random` 방식(:128, :175)을 쓰므로 곡 id만 뒤처짐.
- 신뢰 영향: 간헐적·재현 불가한 큐 오동작 = 비결정성.
- 수정: 곡 id도 `Date.now()+'-'+random` 통일.

**D-10 [논리오류·Med] setState updater 내부 부작용 (playAudioForSong/showToast/setIsPlaying)**
- 위치: `Dashboard.jsx:203-212, 308-322, 329-355, 410-427`. `main.jsx`가 StrictMode(React 19)이므로 dev에서 updater 2회 실행 → 토스트 중복, 프로덕션에서도 렌더 재시작 시 재실행 가능.
- 신뢰 영향: "예약되었습니다" 토스트가 2번 뜨는 등 앱이 조잡해 보임 + 잠재 비결정성.
- 수정: 부작용을 updater 밖(커밋 후 effect 또는 사전 계산)으로 이동.

**D-11 [데이터연결·Med·검증 필요] stale `ytPlayerRef` — 유튜브→로컬 전환 후 파괴된 플레이어 호출**
- 위치: `Dashboard.jsx:30` ref가 YouTube 언마운트 시 해제되지 않음 → 볼륨 이펙트(:39), 재생 이펙트(:47,50), 진행 인터벌(:86-91), `handleSeek`(:104)가 파괴된 플레이어를 계속 호출. `:47` `playVideo()`가 예외를 던지면 바로 다음 줄 `audioRef.play()`가 실행되지 않아 **로컬 재생 토글 실패** 가능.
- 수정: YouTube 언마운트/전환 시 `ytPlayerRef.current = null`.

**D-12 [데이터연결·Med] 늦게 연 원격(다른 기기 OBS) 위젯은 다음 상태 변경까지 빈 화면**
- 위치: `useRemoteSync.js:171-187` ntfy SSE에 `since=` 재생 없음. 같은 브라우저는 localStorage 캐시(:136-139)로 즉시 복원 — **환경별 동작 상이**.
- 수정: SSE URL에 `?since=all|30m` 추가 또는 위젯 접속 시 대시보드가 재-publish.

**D-13 [데이터연결·Med] 위젯 URL 복사 경쟁 — 키 준비 전 복사 시 `key=undefined`**
- 위치: `LivePanel.jsx:10`(즉시 URL 구성) vs `Dashboard.jsx:134-140`(signingKeys 비동기). 같은 브라우저는 BroadcastChannel/localStorage 경로가 키 검증을 안 해서(useRemoteSync.js:141-152) 동작하지만, 원격 OBS에선 서명 검증 실패로 **조용히** 아무것도 안 뜸.
- 수정: 키 준비 전 복사 버튼 비활성/로딩 표시.

**D-14 [논리오류·Med·검증 필요] ntfy 공개 릴레이 한계 — 페이로드 비대 시 원격 동기화 무성 실패**
- 위치: `useRemoteSync.js:94-125`. history 무제한 누적(정리 없음) → state 전체를 매번 POST. ntfy 메시지 크기 제한(기본 수 KB) 초과 시 원격만 조용히 끊김. 또한 `rekasong-{room}`(8자) 공개 토픽에 상태 평문 게시(서명만, 암호화 없음).
- 수정: history 상한(예: 최근 50곡), 위젯에 필요한 필드만 발행, 실패 시 대시보드에 연결상태 표시.

**D-15 [데이터연결·Med] Meloming/Setlink 곡의 source/tags가 검색결과 경유 시 소실**
- 위치: `SearchPanel.jsx:96-101` songMeta는 URL 직행 분기(:50-61)에서만 적용. 목업 데이터는 `youtubeUrl:''`이므로 항상 검색 경유 → 결과 클릭 시 `video.source||'youtube'`(Dashboard.jsx:183) → **배지·태그 없는 유튜브 곡으로 둔갑**. 대기열/히스토리/위젯의 Meloming/Setlink 배지가 사실상 표시될 일 없음.
- 신뢰 영향: 소스 배지가 실제 출처와 어긋남 — 소스 무관 일관성 위반의 핵심 사례.
- 수정: 검색 세션에 songMeta를 유지해 결과 선택 시 병합.

**D-16 [인지착각·Med] 타이핑만 해도 "검색 결과가 없습니다" 표시**
- 위치: `SearchPanel.jsx:201-207` 조건이 `query !== ''`(검색 실행 여부 아님) → 검색 전 입력 중에 🤷 "검색 결과가 없습니다" 노출. 또한 새 검색 실패 시 이전 결과가 지워지지 않아 오래된 결과+에러가 동시 표시(:74는 성공시에만 setResults).
- 수정: `hasSearched` 플래그 도입, 검색 시작 시 results 초기화.

**D-17 [인지착각·Med] 11자 단일 토큰 검색어가 영상 ID로 강제 해석**
- 위치: `SearchPanel.jsx:43` `/^[\w-]{11}$/`. 예: "TWICE-Likey"(11자) 검색 → 검색 대신 존재하지 않는/엉뚱한 영상이 즉시 스테이징되고 "분석 중" 제목으로 진행.
- 수정: ID 해석 시 확인 단계 또는 oEmbed로 존재 검증 후 실패 시 일반 검색 폴백.

**D-18 [논리오류·Med] 비상정지가 현재 곡을 기록에서 증발시킴 + isPlaying/위젯 정합**
- 위치: `LivePanel.jsx:119-123` currentSong을 history에 안 넣고 null 처리 → 부르다 만 곡이 어디에도 안 남음. 위젯은 currentSong=null 수신으로 사라지지만(정상), 일시정지 상태는 위젯에 전혀 반영 안 됨(공유상태에 isPlaying 없음) — 일시정지 중에도 위젯은 "재생 중"처럼 보임.
- 수정: 정지 시 현재 곡을 history에 편입, isPlaying을 발행 payload에 포함.

**D-19 [인지착각·Med] Staging Enter키 = 즉시 송출 — AI 분석 중 미완성 제목 송출**
- 위치: `StagingPanel.jsx:19-23`. AI 추출 진행 중(제목이 아직 원본 잡음 제목) Enter → 그대로 방송. AI 완료 후 제목이 바뀌어도 이미 송출된 곡에는 소급 안 됨(의도일 수 있으나 안내 없음).
- 수정: `isAiLoading` 중 Enter 시 확인 또는 "분석 중 송출됨" 안내.

**D-20 [논리오류·Med] mute/prevVolume 왕복 엣지**
- 위치: `LivePanel.jsx:92-102`. (a) 슬라이더로 0을 만든 경우 prevVolume 미갱신 → 해제 시 100(초기값)으로 급점프. (b) prevVolume 비영속 — 저장된 볼륨 0으로 재시작 시 해제=100 blast. (c) `useSyncState.js:9-10`의 `volume/isMuted` 공유 필드는 아무도 안 씀 — 이중 진실(죽은 데이터).
- 수정: 슬라이더로 0 도달 시에도 직전 값 기억, prevVolume localStorage 저장, 죽은 필드 제거.

**D-21 [데이터연결·Med] 드래그 재정렬 vs 자동 곡 전환 경쟁**
- 위치: `LivePanel.jsx:48-70` dragstart에 인덱스 스냅샷 → 드래그 중 autoPlayNext가 queue[0] 소비하면 drop 시 **엉뚱한 곡이 이동**.
- 수정: 인덱스 대신 song.id로 재정렬 계산.

**D-22 [인지착각·Med·검증 필요] 정상 버퍼링에도 "재생이 지연되고 있습니다" 토스트**
- 위치: `Dashboard.jsx:513-515` YT state 3(buffering)은 곡 시작 시 정상적으로 스치는 상태 — 곡마다 1회 오경보 가능(`reportedDelayRef`로 중복만 억제). `<audio onWaiting>`도 유사.
- 수정: N초 이상 buffering 지속 시에만 발화(디바운스).

### LOW

**D-23 [일관성·Low] 로컬 곡의 `source`가 'youtube'로 기록** — `Dashboard.jsx:305` `source: stagedItem.source || 'youtube'` (⚡ 경로 :200, 선택 경로 :183 동일). 현재 UI엔 meloming/setlink 배지만 있어 표면화 안 되지만 데이터가 거짓. `source:'local'` 명시 권장.

**D-24 [일관성·Low] 위젯 소스별 표시 격차** — 로컬 곡: 무관한 unsplash 콘서트 사진(Widget.jsx:65), 배경 블러 없음(:37). 유튜브: `maxresdefault.jpg`는 404 빈번한데 배경 div에는 onError 폴백 없음(:45). 아티스트는 모든 소스에서 미표시(대시보드와 정보량 불일치).

**D-25 [인지착각·Low] Ctrl+→ 토스트가 곡/큐 없어도 "다음 곡으로 스킵" 표시** — `Dashboard.jsx:162-165` 실제 아무 일 안 해도 성공처럼 보임.

**D-26 [인지착각·Low·검증 필요] Space 전역 단축키와 버튼 포커스 충돌** — `Dashboard.jsx:154` BUTTON 미제외. 버튼 클릭 후 Space 치면 재생 토글(+버튼 재활성화 가능성) — 비상정지 직후 특히 위험.

**D-27 [인지착각·Low] 위젯 미리보기 `&preview=true` 미구현** — `LivePanel.jsx:167`가 붙이는 파라미터를 Widget.jsx가 판독하지 않음(현재는 무해하나 죽은 배선).

**D-28 [일관성·Low] 오류 피드백 채널 혼재** — 로컬 파일 검증은 `alert()`(SearchPanel.jsx:106,110), 삭제류는 `window.confirm`, 그 외는 토스트. 톤 불일치 + OBS 임베디드 브라우저에서 alert 차단 가능.

**D-29 [논리오류·Low] history 무제한 증가** — 정리 로직 없음 → localStorage/발행 payload 비대(D-14 악화).

**D-30 [인지착각·Low] "즉시 재생 (방송 송출)"이 큐를 새치기** — currentSong=null이지만 큐가 남아 있는 상태(D-03 상황)에서 새 곡 송출 시 큐 앞 곡보다 먼저 재생됨 — 경고 없음.

**D-31 [인지착각·Low] 대시보드 종료 후 위젯 잔상** — 대시보드를 닫아도 위젯은 마지막 payload를 유지 — '방송 끝'을 위젯이 모름.

---

## 4. 소스 무관 일관성 판정

| 검증 항목 | 유튜브(검색/URL) | 로컬 | Meloming/Setlink | 판정 |
|---|---|---|---|---|
| 스테이징 메타데이터 | AI 추출 | ID3+AI | **검색 경유로 태그·출처 소실 (D-15)** | ✗ |
| 동일곡 연속 재생 | key 리마운트로 정상 | **무음 정지 (D-06)** | 유튜브와 동일 | ✗ |
| 다시예약/재호출 | 정상 | **blob revoke 실패 (D-02)** | 정상 | ✗ |
| 새로고침 복원 | 정상 | **무통보 소실 (D-04)** | 정상 | ✗ |
| 위젯 아트/배경 | 썸네일+블러 | 무관 사진, 블러 없음 (D-24) | 유튜브와 동일 | △ |
| 소스 배지 | (없음=기본) | 데이터상 'youtube'로 거짓 기록 (D-23) | 경유 경로 따라 사라짐 (D-15) | ✗ |
| 실패 처리 | 오류코드 안내+자동스킵 | 동일(단 revoke 실패를 형식오류로 오보고) | 유튜브와 동일 | ○ |
| ⚡ vs 행클릭 | 제목 품질 상이 (D-07) | 해당 없음 | 해당 없음 | △ |

**통일 방안 요지**: (1) 곡 객체 스키마 통일 — `{id(충돌 없는), type, src, title, artist, tags, source(정직한 값), artworkUrl}` 을 모든 진입 경로에서 동일하게 생성하는 단일 팩토리 함수 도입. (2) 재생 엔진 통일 — 유튜브/로컬 모두 `currentSong.id`를 key로 리마운트해 "새 곡 = 처음부터 자동재생"을 소스 불문 보장. (3) 로컬 blob 수명 관리를 state 참조 기반으로. (4) 노래책 → 검색 → 선택 경로에 songMeta 전파.

## 5. 좁은 디자인 제약 존중 — 넓은 레이아웃 전용 제안 (별도 표시)

현행 좁은 3열 레이아웃 안에서 해결 가능한 것: D-01~D-23 전부 (로직/라벨/토스트 수준, 레이아웃 불변).

**[WIDE-ONLY]** 넓은 화면에서만 고려할 개선:
- 큐 항목별 "지금 재생" 인라인 버튼(좁은 화면에선 D-03의 단일 "다음 곡 시작" 버튼으로 충분).
- 위젯 미리보기를 현재곡/셋리스트 탭 분할 프리뷰로 확장.
- Now Playing에 소스 아이콘+원본 링크+아트워크 썸네일 병기.
- 히스토리에 재생 시각/재생 횟수 컬럼.

## 6. 검증 필요 목록
- D-08 실제 배포 대상(CF Pages vs GH Pages) 확인.
- D-11 파괴된 YT 플레이어 메서드 호출이 동기 예외를 던지는지(react-youtube/youtube-player 프록시 동작).
- D-14 ntfy.sh 메시지 크기 제한 실측.
- D-22 buffering(state 3) 오경보 빈도 실측.
- D-26 Space keydown preventDefault가 버튼 keyup 활성화를 막는지 브라우저별 확인.

---

**핵심 결론**: "믿고 쓰는 앱" 기준으로 볼 때 최대 위협은 (1) UI 스킵 버튼 무동작(D-01), (2) 로컬 소스에만 존재하는 3중 함정(D-02/D-04/D-06), (3) 위젯 setlist=queue와 대시보드 라벨의 의미 불일치(D-05)다. 소스 무관 일관성은 현재 **불합격**이며, 원인 대부분이 곡 생성 경로가 5갈래로 흩어져 스키마·수명 관리가 제각각인 데 있다.
