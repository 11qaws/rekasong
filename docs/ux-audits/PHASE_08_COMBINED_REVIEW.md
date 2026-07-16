# PHASE 08 — 통합 아키텍처 검토: 데이터 연결·전송 구조 + 생애주기 모델 적용 계획

- 검토일: 2026-07-16 · 방식: 정적 코드 실측(읽기 전용) · 실행 검증 미수행 항목은 '검증 필요' 표기
- 기준 문서: [SONG_LIFECYCLE.md](../SONG_LIFECYCLE.md)(규범), [PROJECT_STATUS.md](../PROJECT_STATUS.md)(P0/P1/P2), [PHASE_07](PHASE_07_FUNCTIONAL_SCENARIOS.md)(결함 D-01~D-31)
- 목적: (1) 현재 아키텍처 실측 맵 (2) PHASE_07 재검증 (3) 원격동기화·On-Air 전송 구조 검토 (4) 생애주기 모델을 **현재 직접 재생 구조**에 레포 안에서 구현하는 설계 (5) 오디오 프록시 백엔드 통합 위치 (6) 통합 실행계획

---

## 0. 검토 전제의 정정 (실측 결과, 배경 가정 2건 수정)

1. **On-Air Worker(Durable Object) 코드는 이 저장소에 존재한다.** `workers/rekasong-session/src/index.js`(384줄) + `workers/rekasong-session/wrangler.jsonc`(DO `SessionRoom` + R2 `rekasong-session-media` 바인딩, account_id 기재). 따라서 생애주기 P0의 "Worker 진실원"은 *레포 밖 신축*이 아니라 **레포 내 Worker 확장** 작업이다. 다만 이 Worker는 명령 릴레이 + transport 스냅숏 저장소이지 상태기계가 아니다(§3-2).
2. **On-Air 모드는 프로덕션 빌드에서 기본 활성이다.** `.env.production`(git 추적 중)이 `VITE_ON_AIR_BASE_URL=https://rekasong-session.11qaws.workers.dev`를 지정한다. `npm run dev`(로컬)에서만 unconfigured → 직접 재생 모드. 즉 "현재 실제 동작 모드 = 직접 재생"은 **개발 환경 한정**이며, 배포 빌드는 On-Air 경로를 탄다(해당 Worker URL의 실배포 상태는 검증 필요). 두 경로 모두 방송 품질 기준으로 검토해야 한다.

---

## 1. 현재 아키텍처 실측 맵

### 1-1. 컴포넌트 트리 (실사용 기준)

```text
App.jsx (HashRouter)
├─ #/            Dashboard.jsx (854줄, 코디네이터 + 숨김 플레이어 호스트)
│   ├─ PlaybackPanel.jsx   현재 재생 제어 + OBS 설정 다이얼로그(위젯 URL·세션 종료)
│   ├─ QueuePanel.jsx      대기열(드래그·바로 재생·제거) + 이전 재생 아코디언
│   └─ SongComposer.jsx    stagedItem 유무로 SearchPanel ↔ StagingPanel 전환
│       ├─ SearchPanel.jsx (826줄) 유튜브 검색/URL·멜로밍·YouTube목록·Setlink·로컬 파일
│       └─ StagingPanel.jsx 2단계 확인(미리보기·AI 곡명·송출 버튼)
└─ #/widget      Widget.jsx
    ├─ (room&key)          ntfy/BroadcastChannel 구독 화면정보 위젯
    ├─ (mode=display)      On-Air Worker WS display 구독 화면정보 위젯
    └─ (mode=player)       OnAirPlayer.jsx — OBS 내 실제 재생기(YouTube/audio/video)
```

- **데드 코드**: `src/components/LivePanel.jsx`(361줄)는 어떤 파일에서도 import되지 않는다(PHASE_07 당시 UI의 잔해). PHASE_07의 LivePanel 기준 라인 인용은 전부 재대조가 필요했으며 §2에 반영했다.

### 1-2. 상태·데이터 흐름

| 계층 | 소유자 | 내용 | 근거 |
|---|---|---|---|
| 공유 앱 상태 | `useSyncState` (localStorage `karaoke_app_state` + storage 이벤트) | `currentSong/queue/history` + 카탈로그(setlink/playlist/songbookMrCache 등) + `autoPlayNext` | useSyncState.js:3-23 |
| 재생 런타임 | Dashboard 로컬 state/ref | `isPlaying/volume/currentTime/duration`, `ytPlayerRef/audioRef/videoRef`, `activeSongIdRef` | Dashboard.jsx:55-70 |
| 스테이징 | Dashboard `stagedItem` | 2단계 곡(비영속, 새로고침 시 소실) | Dashboard.jsx:173 |
| 원격 위젯 | `publishSync` → BroadcastChannel + localStorage + (dev)/api/sync + ntfy.sh | **state 전체** + timestamp + ECDSA 서명 | Dashboard.jsx:204-209, useRemoteSync.js:94-125 |
| On-Air 세션 | `useOnAirSession` (localStorage `rekasong-on-air-session-v1`) | room + control/player/display 토큰, control WS | useOnAirSession.js:3-35 |
| Worker 영속 | DO SQLite storage `session` | 토큰 해시, `transport{status,song,sessionId,position,volume}`, `display{currentSong,history}`, assets 목록 | workers/.../index.js:127-138 |

### 1-3. 직접 재생 경로 (dev / unconfigured)

```text
StagingPanel [즉시 재생] → handleGoLive → setSharedState(currentSong=newSong)
  └ updater 안에서 playAudioForSong(newSong) → setIsPlaying(true) + activeVideoId/localAudioSrc 설정
숨김 플레이어 (Dashboard.jsx:797-851)
  ├ <YouTube key={videoId+'-'+song.id}> onEnd/onError/onStateChange(3=지연)
  ├ <video>/<audio src={blob}> onEnded/onError/onWaiting  ← key 없음
  └ 종료: onLivePlayerEnd(songId) → activeSongIdRef 가드 → history 편입 + autoPlayNext 분기
```

- 확정 근거로 쓸 수 있는 실제 media 이벤트가 **이미 배선되어 있다**: YouTube `onEnd`/`onStateChange`, audio/video `onEnded/onError/onWaiting`(Dashboard.jsx:804-848). 다만 `playing/paused` 확인 이벤트(YT state 1/2, `onplaying/onpause`)는 소비하지 않고, `isPlaying`은 명령 측 낙관 상태다(불변식 5 위반의 근원).
- 이벤트 검증 키는 `song.id`(= `Date.now().toString()`, Dashboard.jsx:428) 하나뿐 — 생애주기의 entryId/runId/playerInstanceId 3중 검증이 없다.

### 1-4. On-Air 경로 (프로덕션 빌드)

```text
Dashboard ──control WS──▶ SessionRoom(DO) ──player WS──▶ OnAirPlayer(OBS)
   ▲  load/play/pause/seek/volume/stop/display_state/end_session      │
   └──transport/player_event/presence/snapshot ◀── event{type,sessionId,position}
Widget(mode=display) ◀─display_state/snapshot── SessionRoom
로컬 파일: XHR 업로드 → R2 → /media/{assetId}?token= 스트리밍 (Range 지원)
세션 수명: init +30분 알람 → player 접속 시 알람 해제 → player 전원 이탈 +2분 → end
          → end 후 +10분 → R2 자산 삭제 + storage.deleteAll (index.js:1-3, 339-364)
```

- Worker가 지원하는 명령: `load/play/pause/seek/volume/stop/display_state/end_session`(index.js:240-260). **`prepare/finish/discard/restart/retry`는 없다** — PROJECT_STATUS P0 그대로.
- Player 이벤트 검증은 `sessionId`(= 대시보드가 넣은 `song.id`, Dashboard.jsx:392) 단일 값(index.js:274, OnAirPlayer.jsx:32). runId/playerInstanceId 없음.
- `presence` 이벤트는 Worker가 발신하지만(index.js:198-199, 333) `useOnAirSession`도 Dashboard 핸들러(Dashboard.jsx:671-702)도 저장·표시하지 않는다 → P0 "presence/lease" 미구현 확인. PlaybackPanel의 "OBS 플레이어 연결됨"(PlaybackPanel.jsx:181)은 실제로는 **control WS 연결 상태**를 표시한다 — 생애주기 §2-3 위반.

---

## 2. PHASE_07 재검증 표 (D-01~D-31)

판정: **유효**(현행 코드에 존재) / **부분 유효** / **해결됨** / **무효**(전제 소멸). 매핑: 생애주기 phase·불변식(INV#) + PROJECT_STATUS 항목.

| # | 판정 | 현재 코드 근거 | 생애주기 매핑 | PROJECT_STATUS |
|---|---|---|---|---|
| D-01 스킵 버튼 무동작 | **유효** | PlaybackPanel.jsx:127 `onClick={onSkip}` → 클릭 이벤트가 `handlePlayNext(expectedSongId)` 첫 인자로 전달, Dashboard.jsx:503 가드 `expectedSongId && current.id !== expectedSongId`에 항상 걸림 | `finishing` 전이 부재의 표면화. 스킵=finish→ended→completed(§4-3) | P0-3 (문서가 이미 "화면 버튼도 클릭 이벤트를 곡 ID로 오인"이라 명시) |
| D-02 blob revoke로 재예약/재호출 재생 불가 | **유효**(직접 모드) | Dashboard.jsx:116-123 cleanup이 `localAudioSrc` 교체 시 무조건 revoke. 재예약(PlaybackPanel.jsx:131)·재호출(QueuePanel.jsx:69)은 같은 blob src를 복제 | `queued` 항목의 sourceStatus가 조용히 `unavailable`로 부패. INV-8(수명 관리) | P1 "Blob URL 수명" |
| D-03 autoPlayNext OFF 복구 불능 | **해결됨** | QueuePanel.jsx:55 "바로 재생" + Dashboard.jsx:534 `handlePlayQueuedSong`(currentSong 없어도 동작) | `queued → starting` 승격(§4-6) | — |
| D-04 로컬 곡 무통보 소실 | **유효(범위 축소)** | useSyncState.js:39 `blob:` src 로컬만 fromStorage 필터(On-Air asset 로컬은 생존). 새로고침 시 여전히 **무통보** 삭제, 멀티탭 storage 전파(:83-95)로 다른 탭 큐의 blob 곡 소멸. currentSong 리셋은 의도된 설계(주석 :47-49) | `abandoned` 전이가 안내 없이 발생. INV-8 | P1 "Blob URL 수명·R2 만료" |
| D-05 위젯 setlist=queue 의미 어긋남 | **해결됨** | Widget.jsx:63-66 setlist = history + currentSong(큐는 의도적 비공개, 주석 명시). QueuePanel.jsx:70 라벨 "기록에서 삭제" | INV-9(위젯은 확정 상태 표시) 취지 부합 | — |
| D-06 같은 로컬 곡 연속 재생 무음 정지 | **유효** | `<audio>`(Dashboard.jsx:832-849)·`<video>`(:821-830)에 key 없음. 같은 blob src면 리마운트 안 됨 + `playAudioForSong`의 `setIsPlaying(true)`(:406)가 이미 true면 재생 이펙트(:83-94) 미재발화 → `play()` 미호출. YouTube만 key에 song.id 포함(:800) | `starting → playing` 확인 부재의 전형. runId를 key로 쓰면 구조적 해소 | P0-2 (entryId/runId) |
| D-07 placeholder 제목 송출 | **부분 유효** | SearchPanel.jsx:190 `'URL 직접 입력 영상 (분석 중...)'` 스테이징 + StagingPanel.jsx:153 송출 버튼이 `title.trim()`만 검사(AI 진행 중 미차단). ⚡즉시재생 경로는 **제거되어** 재현2는 무효 | `sourceStatus`(카탈로그)와 `phase`의 분리(§2-2). 표시 확정 전 송출 방지 | P2 (전이 중 버튼 제어) |
| D-08 GH Pages 배포 불능 | **해결됨(검증 필요)** | lib/api.js:5 프로덕션 기본 `https://rekasong.pages.dev`, vite.config.js:64 `base: GITHUB_ACTIONS ? '/rekasong/' : '/'`, functions/api 8개 파일 전부 CORS 헤더 확인 | — | — (rekasong.pages.dev 실배포 상태만 검증 필요) |
| D-09 곡 id `Date.now()` 충돌 | **유효** | Dashboard.jsx:428(송출), PlaybackPanel.jsx:131(다시 예약), QueuePanel.jsx:69(재호출) 모두 `Date.now().toString()`. 토스트/스테이징 id는 random 접미(Dashboard.jsx:189,244) — 곡 id만 뒤처짐 | **entryId 도입 지점 그 자체**(§1). INV-2의 전제 | P0-2 |
| D-10 setState updater 내 부작용 | **부분 유효** | `handlePlayNext`(:508-511 주석과 함께 수정됨)·`handlePlayQueuedSong`(:539-543)은 I/O 분리 완료. **잔존**: `handleGoLive`(:474-492 updater 안 playAudioForSong+showToast), `onLivePlayerEnd`(:651-667 updater 안 playAudioForSong·setIsPlaying — On-Air에선 updater 안에서 WS load 명령 송신). main.jsx:7 StrictMode → dev 이중 실행 | 이벤트→전이→부수효과 순서(§6). INV-4(자동 다음 곡은 completed 전이 하나에서만) | P0-1 |
| D-11 stale ytPlayerRef | **유효** | onLivePlayerReady(:642)에서 설정 후 언마운트 시 null 처리 없음. 볼륨(:75)·재생(:86 — 예외 시 :87 audio.play() 미실행)·진행(:130)·seek(:161)가 파괴된 플레이어 호출 (동기 예외 여부 검증 필요) | `playerInstanceId` 검증 부재의 로컬판 | P0-2 |
| D-12 늦게 연 원격 위젯 빈 화면 | **유효** | useRemoteSync.js:174 `EventSource(`…/sse`)` — `since=` 재생 없음. 같은 브라우저만 localStorage 캐시(:136-139) 복원 | INV-9. 위젯 접속 시 projection 스냅숏 필요(§6) | P1 "위젯 projection" |
| D-13 위젯 URL 복사 경쟁(key=undefined) | **무효(대체)** | 해당 UI(LivePanel)가 데드 코드화. 현 PlaybackPanel은 room/publicKeyB64를 props로 받되 **구조분해조차 안 함**(PlaybackPanel.jsx:4-22) → 경쟁이 아니라 **경로 자체 소멸**. 신규 갭 **N-01**로 재정의(§3-1) | — | — |
| D-14 ntfy 페이로드 비대·평문 | **유효(악화)** | Dashboard.jsx:204-209 `state` **전체** 발행 — 이제 setlinkCatalog·youtubePlaylistCatalog·songbookMrCache까지 포함. history 무상한(§D-29). 공개 토픽 `ntfy.sh/rekasong-{8자}` 평문(서명만, useRemoteSync.js:65,118-121) | INV-9: 위젯엔 display projection만 필요 | P1 "위젯 projection" + 신규 갭 N-08 |
| D-15 노래책 meta 소실 | **해결됨** | SearchPanel.jsx:276-290 `pendingSongbookMatch` 병합, :292-304 `stageSongbookMr`가 source/tags/songbookId 보존 | `sourceStatus`/카탈로그 정체성 유지 | — |
| D-16 타이핑만으로 "검색 결과 없음" | **유효** | SearchPanel.jsx:479 조건 `query !== ''`(검색 실행 여부 아님) — hasSearched 플래그 부재 | — (카탈로그 UX) | P2 |
| D-17 11자 검색어 ID 강제 해석 | **해결됨** | SearchPanel.jsx:184 완전한 YouTube URL 정규식으로 교체(단독 11자 토큰 매칭 제거) | — | — |
| D-18 비상정지 기록 증발 | **무효(제거)** | 비상정지 버튼 비노출(PROJECT_STATUS §2 명시, 현 PlaybackPanel에 없음). **잔존 파생**: `isPlaying`이 발행 payload에 없어 위젯이 일시정지를 모름(Dashboard.jsx:206 state에 isPlaying 없음) → §5 위젯 projection에 포함 | 비상정지=세션 명령(§4-7) 문서와 일치 | P0-1 |
| D-19 Staging Enter=즉시 송출 | **해결됨** | StagingPanel에 form/Enter 배선 없음(입력은 div 안 단독 input, :101-126). 송출은 버튼 클릭만 | — | — |
| D-20 mute/prevVolume 엣지 | **부분 유효** | PlaybackPanel.jsx:23 `useState(100)` 비영속, 슬라이더로 0 도달 시 previousVolume 미갱신(:91-97 토글 경로만 기억) → 해제 시 100 점프. useSyncState.js:9-10 `volume/isMuted` 죽은 공유 필드 잔존(Dashboard는 별도 `rekasong_volume` localStorage 사용, :56-60) | — | P2 |
| D-21 드래그 vs 자동 전환 경쟁 | **유효** | QueuePanel.jsx:48 dragstart에 **인덱스** 스냅숏, :8-19 drop 시 그 인덱스로 splice — 드래그 중 큐 소비 시 엉뚱한 곡 이동 | entryId 기준 재정렬(§1) | P1 "대기열 드래그·삭제 ID 기준" |
| D-22 정상 버퍼링 오경보 | **유효** | Dashboard.jsx:805-807 YT state 3 즉시 `handlePlaybackDelay`(:601-605, 곡당 1회 억제만·디바운스 없음), audio `onWaiting`(:838) 동일 | `buffering` phase 도입 시 "N초 지속" 조건으로 정식화 | P2 |
| D-23 로컬 곡 source='youtube' | **해결됨** | Dashboard.jsx:295 `source: songbookContext?.source \|\| 'local'`, handleGoLive는 stagedItem.source 우선(:436) | — | — |
| D-24 위젯 소스별 표시 격차 | **유효(부분)** | Widget.jsx:79 배경 블러는 youtube만, :107 로컬은 무관 unsplash 사진(전경 img는 onError 폴백 있음 :110, 배경 div는 없음 :87). 아티스트 전 소스 미표시 | — | P2 |
| D-25 Ctrl+→ 무조건 성공 토스트 | **유효** | Dashboard.jsx:231-235 — `handlePlayNext`가 조용히 return해도 "다음 곡으로 스킵" 표시 | §5 "상태를 추측해 보이지 않는다" 위반의 최소 사례 | P2 |
| D-26 Space와 버튼 포커스 충돌 | **유효** | Dashboard.jsx:224 INPUT/TEXTAREA/SELECT만 제외, BUTTON 미제외 (브라우저별 동작 검증 필요) | — | P2 |
| D-27 `preview=true` 죽은 배선 | **무효** | 해당 배선은 데드 코드 LivePanel에만 존재. 현 PlaybackPanel에 미리보기 iframe 자체가 없음 | — | — |
| D-28 오류 채널 혼재 | **유효** | SearchPanel.jsx:216,220 `alert()` / SearchPanel.jsx:420·PlaybackPanel.jsx:193 `confirm` / 그 외 토스트 | — | P2 |
| D-29 history 무제한 | **유효** | useSyncState에 상한 없음. On-Air display projection만 `slice(-100)`(Dashboard.jsx:32, worker index.js:48) — **ntfy 발행 경로는 무상한 그대로** | INV-8 | P1 |
| D-30 즉시 재생이 큐 새치기 | **유효** | Dashboard.jsx:479 `!prev.currentSong`이면 큐 무시하고 즉시 재생. StagingPanel.jsx:155 라벨도 경고 없음 | §4-6 "바로 재생" 복합 명령 정의 필요 | P1 "바로 재생 통합" |
| D-31 대시보드 종료 후 위젯 잔상 | **부분 해결** | 명시적 "방송 세션 종료"(PlaybackPanel.jsx:186-199) 시: On-Air는 `session_ended`로 위젯 정리(Widget.jsx:46), 직접 모드는 빈 상태 발행(Dashboard.jsx:590). **단순 창 닫기**엔 여전히 마지막 payload 잔존 | 세션 종료 시 `abandoned` 정리(§4-7) | P1 |

**집계**: 해결 7 (D-03/05/08/15/17/19/23) · 부분 해결 1 (D-31) · 무효 3 (D-13/18/27) · **유효 20** (부분 유효 D-04/07/10/20/24 포함).
유효 20건 중 **13건**(D-01/02/04/06/07/09/10/11/21/22/25/29/30)이 entryId/runId + phase 상태기계 하나로 뿌리를 공유한다 — PHASE_07의 "곡 생성 경로 5갈래" 결론과 생애주기 §1의 결정이 일치함을 재확인.

---

## 3. 데이터 연결·전송 구조 검토 (원 PHASE_08 목적)

### 3-1. 원격 동기화 (ntfy publish/subscribe) — 직접 재생 모드의 위젯 채널

PROJECT_STATUS가 이미 다룬 것: 위젯의 낙관 상태 렌더(P1), projection 필요성. **추가 발견 갭**:

- **N-01 [High] 직접 재생 모드에서 화면정보 위젯 URL 복사 수단이 UI에 없다.**
  Dashboard는 `room`·`signingKeys`를 만들어 매 상태 변경마다 ntfy에 발행하고(Dashboard.jsx:194-209), Widget.jsx는 `room&key` 파라미터를 여전히 지원한다(:12-28). 그런데 PlaybackPanel은 `room/publicKeyB64` props를 받기만 하고 사용하지 않으며(PlaybackPanel.jsx 시그니처에 미포함), OBS 다이얼로그의 두 복사 버튼은 On-Air 전용 + `unconfigured`면 disabled(:168,178). 결과: **dev/미설정 환경에서는 위젯을 연결할 공식 경로가 없고, 수신자 없는 발행만 계속된다.** 하위 호환 관점: 구버전에서 복사해 둔 `room&key` URL은 계속 동작한다(지원 범위: Widget.jsx가 room/key 판독을 유지하는 한).
- **N-08 [Med] 발행 페이로드가 위젯에 불필요한 개인 데이터를 공개 토픽에 노출.** D-14의 악화형. `state` 전체(노래책 카탈로그, MR 캐시, 멜로밍 채널 ID, **비공개로 설계된 queue** — Widget.jsx:64 주석이 "큐는 시청자에게 비공개"라 명시)가 8자 room의 공개 ntfy 토픽에 서명-평문으로 올라간다. 서명은 위변조만 막고 열람은 못 막는다. 위젯이 실제 쓰는 필드는 `currentSong/history`뿐.
- **timestamp 경쟁**: 위젯 수신부는 `payload.timestamp <= lastAcceptedTs` 가드(useRemoteSync.js:181)로 SSE 내 역행은 막지만, BroadcastChannel/localStorage 경로(:132-146)는 timestamp 검사 없이 즉시 적용 — 같은 브라우저에서 SSE 지연 재도착분과 교차하면 순간 되감김 가능(실측 검증 필요, 500ms 디바운스 :91-123가 완화).
- **늦게 연 위젯**(D-12 유효): SSE `since=` 미사용. 원격 OBS는 다음 상태 변경까지 빈 화면.
- **isPlaying 미발행**(D-18 잔존): 위젯은 일시정지를 모른다.

### 3-2. On-Air WebSocket/Worker 경로

PROJECT_STATUS가 이미 다룬 것(코드로 확인됨): `finish/discard` 명령 부재, presence 미상태화(P0), 재연결 루프(P1), 단일 활성 Player 정책 부재(P0). 각각의 정확한 코드 위치와 **추가 갭**:

- **N-02 [High] Worker 자신이 낙관 갱신을 한다.** `handleCommand`가 `play`→`status:'playing'`, `pause`→`'paused'`로 **Player 확인 전에** transport를 확정하고 control에 브로드캐스트한다(index.js:246-249, 266). 대시보드를 "Worker projection 소비자"로 바꿔도(P0-1) 이 projection 자체가 §6 계약("확정 상태는 반드시 Player 확인 이벤트로만") 위반이라 drift가 남는다. Player 이벤트가 나중에 덮어쓰긴 하나(index.js:279-281), 그 사이 UI는 거짓 `재생 중`을 표시한다.
- **N-03 [High] 종료된 세션의 재연결 무한 루프 — 메커니즘 확정.** 세션 종료/삭제 후 재접속 시 DO는 WS 업그레이드를 **HTTP 401로 거부**한다(index.js:181-183). 브라우저에서 이는 1008/1011 close가 아니라 연결 실패(close code 1006)로 떨어지므로 `useOnAirSession`의 1008/1011 분기(:129-133)를 타지 못하고 1.5초 간격 무한 재연결(:134-135)이 된다. OnAirPlayer는 아예 무조건 재연결한다(OnAirPlayer.jsx:98-100). P1 문구("일반 close가 1008/1011이 아니면")의 원인이 서버 측 거부 방식에 있음을 명확히 함: **해결은 클라이언트 백오프 + 서버가 수락 후 1008로 닫기** 둘 다 필요.
- **N-04 [High] player 소켓 다중 허용 — 단일 활성 Player lease 부재.** `openSocket`은 같은 playerToken으로 몇 개든 수락하고(index.js:185-200), 명령은 모든 player에 브로드캐스트(:265, 366-371) → OBS 미리보기+본방 등 두 탭이면 **이중 오디오**. `hasConnectedPlayer`(:373-375)도 개수만 본다. 생애주기 §2-3의 lease 개념이 정확히 이 지점.
- **N-05 [Med] presence가 발신만 되고 소비되지 않는다.** index.js:198-199(접속)·:333(이탈, role 무필터 브로드캐스트) → useOnAirSession.onmessage는 transport/session_ended만 저장(:113-125), Dashboard 핸들러(:671-702)도 presence 분기 없음. PlaybackPanel의 "OBS 플레이어 연결됨"(:181)은 control WS 상태다 — **P0-5의 코드 확정**.
- **N-07 [Med] snapshot 복원이 큐와 비조율.** 대시보드 재접속 시 `transport.song`을 currentSong으로 채택하지만(Dashboard.jsx:672-679) queue/history와의 정합(그 곡이 큐에도 남아 있는 경우 중복, history 미기록)은 검토하지 않는다. useSyncState는 새로고침 시 currentSong을 null로 리셋(useSyncState.js:49)하므로 On-Air에선 transport가 이를 되살린다 — 두 진실원의 봉합선.
- **N-09 [Med] On-Air ended 처리 경로의 updater 내 WS 송신.** `player_event: ended` → `onLivePlayerEnd` → setState updater 안 `playAudioForSong(nextSong)` → `sendCommand({type:'load'})`(Dashboard.jsx:658-661, 390-397). StrictMode/렌더 재시작 시 이중 load 명령 위험. D-10의 On-Air판.
- **긍정 확인**: 토큰은 해시 저장(index.js:130-132), R2 스트리밍은 Range/ETag 지원(:52-65), display projection은 필드 화이트리스트+길이 제한(:32-50), 세션 수명 알람 설계(:1-3)는 견고. OnAirPlayer의 명령 sessionId 가드(:32)와 Worker 이벤트 가드(:274)는 **단일 세대 검증으로는** 작동한다 — 부족한 것은 재시도(runId) 세대 구분이다.

---

## 4. 생애주기 모델의 '현재 직접 재생 구조' 매핑 (레포 내 구현 가능 설계)

원칙: **UI 구조(3열: 재생/대기열/작곡기)는 유지**하고, Dashboard를 코디네이터(=Worker 역할의 로컬 대행)로, 실제 media 이벤트를 확정 근거로 삼는다. 풀 DO-Worker 이식은 §6 Stage 7로 명시 분리.

### 4-1. 상태 스키마 최소 변경 (useSyncState v2)

```js
// 단일 팩토리 (PHASE_07 §4 통일 방안과 동일 지점)
createQueueEntry(songDef) => ({
  entryId: crypto.randomUUID(),          // D-09 해소, 재예약=새 entryId (§1)
  song: { type, src, title, artist, tags, source, songbookId, mediaType },
  phase: 'queued',                       // §2-1 어휘 그대로
  completionReason: null,                // 'natural' | 'skipped' | null
  createdAt: Date.now()
})

// 공유 상태
{ queue: QueueEntry[], history: QueueEntry[],  // history는 completed만 (INV-3)
  active: { entryId, runId, phase } | null }   // 한 세션 active 최대 1 (INV-1)
```

- `runId`는 **재생 시도마다** Dashboard가 발급해 `active.runId`에 기록. 숨김 플레이어의 모든 이벤트 핸들러는 마운트 시점의 `{entryId, runId}`를 클로저로 캡처해 전달하고, 코디네이터는 `active`와 일치할 때만 전이시킨다(§6 계약의 로컬판). `activeSongIdRef` 가드(:97,602,608,649)를 이 검증으로 교체.
- `<audio>/<video>`에 `key={runId}` 부여 → 같은 src 연속 재생도 리마운트+autoPlay 보장(**D-06 구조적 해소**), YouTube key도 runId로 통일(**D-11**은 언마운트 시 `ytPlayerRef.current=null` 병행).
- 하위 호환: localStorage 구 스키마(`song` 평면 객체)는 `normaliseState`에서 entry로 승격 래핑. blob 로컬 곡은 기존 필터 유지하되 **소실 시 안내 토스트**(D-04). 이 마이그레이션은 저장 형식 변경이므로 버전 규약상 Minor 상승(x.y.0) 대상.

### 4-2. phase 전이 ↔ 실제 이벤트 대응 (직접 재생)

| 전이 | 트리거(의도) | 확정 근거(실제 이벤트) | 현재 코드의 대응물 |
|---|---|---|---|
| `staged → queued` | 대기열 추가 | 즉시(로컬 조작) | handleGoLive(:416) |
| `queued → starting` | 바로 재생/자동 다음 곡 | runId 발급 + 플레이어 마운트 | playAudioForSong(:381) |
| `starting → playing` | — | YT `onStateChange` data===1 / `<audio onPlaying>` **(신규 배선 필요)** | 현재는 낙관 `setIsPlaying(true)`(:406) |
| `playing ↔ paused` | 토글 | YT state 2 / `onpause` (신규 배선) | 낙관 토글(:573) |
| `playing → buffering` | — | YT state 3 / `onwaiting` + **N초 지속 조건**(D-22) | :805,:838 즉시 발화 |
| `playing/paused → finishing` | 스킵 | 로컬: `el.currentTime = el.duration` / YT: `seekTo(getDuration())` → **동일 runId의 ended 대기** | 없음 — 현재 스킵은 다음 곡 직접 로드(:501-532) |
| `finishing/playing → completed` | — | `onEnded`/YT state 0, runId 일치 | onLivePlayerEnd(:648) — 단 가드가 songId |
| `active → discarding → discarded` | 현재 곡 쓰레기통 | pause + src 해제/YT 언마운트 → 로컬에선 동기적 확정 가능. 늦은 ended는 runId 불일치로 폐기(§4-4) | 없음 — 현재 UI에 현재 곡 쓰레기통 자체가 없음(PROJECT_STATUS §6 의도적 비노출) |
| `starting/playing → failed` | — | `onError`, runId 일치. **자동 스킵 제거**(INV-3·§4-5: 재시도/버리기 제시) | handleMediaFailure(:607-613)가 400ms 후 자동 스킵 — 위반 |
| 세션 종료 → `abandoned` | 방송 세션 종료 | 즉시 + blob revoke 일괄 | handleEndBroadcastSession(:588) |

- **`completed`에서만** history 편입 + autoPlayNext 실행(INV-2/3/4). 현재 `handlePlayNext`가 스킵 시 즉시 history에 넣는 것(:524)은 finishing 도입 시 "ended 수신 후"로 이동.
- 직접 재생의 이점: 플레이어가 같은 페이지에 있어 `finish`(끝으로 seek) 명령과 ended 회신이 **한 프로세스 안**에서 결정적이다. 로컬 `<audio>`는 `currentTime=duration` 대입으로 ended가 확실히 발화한다. YouTube iframe은 광고 중이면 getDuration이 광고 길이를 반환할 수 있어(검증 필요) `outputSafety: unknown` 동안 스킵-완료 처리를 보류(§4-3 "길이를 모르면 완료 처리하지 않음")하고 폴백으로 기존 다음-곡-직접-로드를 쓰되 completionReason을 구분 기록.
- `preparing/ready`는 직접 재생에서 로컬 파일의 `canplaythrough`(현재 미배선)와 프록시 오디오(§5)로만 실질 의미를 갖는다. YouTube iframe 경로는 `ready` 표시를 **하지 않는다**(INV-6 — iframe 생성은 근거가 아님).

### 4-3. 컴포넌트별 phase 표시 책임

| 컴포넌트 | 표시 담당 phase | 구체 변경(레이아웃 불변) |
|---|---|---|
| PlaybackPanel | `starting/playing/paused/buffering/finishing/discarding/failed` | ON AIR 배지를 phase 문구로: `재생 시작 중…/● ON AIR/Ⅱ 일시정지/버퍼링/스킵 중…/취소 중…/재생 실패`. finishing 중 토글·seek 비활성(쓰레기통만 허용, §4-3). failed 시 재시도/버리기 버튼 |
| QueuePanel | `queued`(+`preparing/ready`는 프록시 도입 후) | 행 배지: `대기`/`MR 연결됨`(sourceStatus)과 구분. 드래그를 entryId 기준으로(D-21) |
| QueuePanel history | `completed` | completionReason(자연 종료/스킵) 배지 · "다시 부르기"는 새 entryId 생성임을 툴팁 명시(§4-6) |
| SongComposer/Staging | `staged` + `sourceStatus` | AI 분석 중 송출 버튼에 "분석 중 원제로 송출됩니다" 경고 또는 비활성(D-07) |
| Widget | 확정 projection만 | `starting` 중엔 이전 곡 유지(§5-5), isPlaying/phase 포함한 축소 payload 소비 |

---

## 5. 오디오 프록시 백엔드(Oracle VPS) 통합 위치

전제: YouTube videoId → 광고 없는 `<audio>` 스트림 프록시(기배포·검증됨, 레포 밖). 이 조각이 생애주기에서 갖는 의미: **YouTube 콘텐츠에 대해 `outputSafety: safe`(§2-4)와 결정적 media 이벤트를 동시에 실현**하는 유일한 수단이다.

### 5-1. 통합 지점

1. **구성**: `VITE_AUDIO_PROXY_BASE_URL`(lib/api.js 패턴 준용, 미설정 시 완전 무영향). 프록시 URL 규약(예: `{base}/stream/{videoId}`)은 백엔드 스펙 확인 필요(검증 필요).
2. **재생 경로 분기**: `playAudioForSong`(Dashboard.jsx:381)에서 `song.type==='youtube' && proxyConfigured`이면 iframe 대신 `<audio src={proxyUrl(videoId)}>` 경로로. 기존 `<audio>` 배선(onEnded/onError/onWaiting + §4의 onplaying/onpause 신규 배선)을 **그대로 재사용**하므로 신규 플레이어 코드가 거의 없다. 소스 무관 일관성(PHASE_07 §4 통일 방안 2 "재생 엔진 통일")도 이 지점에서 달성된다.
3. **생애주기 효과**:
   - `preparing → ready`: 숨김 `<audio preload="auto">`의 `canplaythrough`가 **실제 Player 확인**(INV-6)이 된다. 큐 상위 1곡 preload 슬롯(§4-1 "단일 준비 슬롯")도 iframe과 달리 음소거·비출력으로 안전하게 구현 가능.
   - `finishing → completed`: `el.currentTime = el.duration` → 결정적 `ended` → completed. **D-01 계열 스킵이 규범대로** 구현된다.
   - `outputSafety: safe` 고정 — 광고/실곡 구분 문제(P0-6) 자체가 소멸.
   - `buffering`·position이 timeupdate 기반으로 정확 → D-22 오경보 조건 정교화.
4. **폴백 체인**: 프록시 미설정 → 기존 iframe 경로 그대로. 프록시 `onError`/타임아웃 → 같은 entryId로 **새 runId** 발급 후 iframe 재시도(phase `starting` 유지, `outputSafety: unknown` 강등 표시) → 그것도 실패 시 `failed`. runId 세대 구분이 있어야 프록시의 늦은 이벤트가 iframe run을 오염시키지 않는다 — **§4 스키마가 프록시 통합의 선행 조건**인 이유.
5. **On-Air 경로 확장(후속)**: OnAirPlayer.jsx의 youtube 분기(:168-184)에도 동일 분기 적용 가능 — OBS 출력에서 광고 제거 효과가 가장 큰 곳. Worker 명령/이벤트 계약 변경 없이 Player 내부 소스 선택만 바뀐다.
6. **리스크 헷징**: (a) 프록시 단일 서버 장애 → 폴백 체인이 상쇄, 대시보드에 프록시 상태 배지 권장. (b) 스트림이 Range를 지원 안 하면 seek 불가 → seek 시도 실패 시 iframe 강등(검증 필요). (c) GitHub Pages 정적 호스팅 관점: 프록시는 외부 오리진이므로 **CORS 허용 필수**(`<audio>` 재생 자체는 CORS 불요하나 오류 정보·향후 시각화에 필요), Mixed Content 방지 위해 HTTPS 필수. (d) 저작권/약관 리스크는 운영 판단 사항으로 본 검토 범위 외 표기.

---

## 6. 통합 우선순위 실행계획 (모델 우선, 레포 내 실현 가능 순)

SONG_LIFECYCLE §8의 순서(1 Worker → 2 Player 프로토콜 → 3 projection 소비자 → 4 phase UI → 5 카탈로그)를 "현재 구조 + 레포 내" 기준으로 재배열: **직접 재생 경로에서 코디네이터·상태기계를 먼저 완성**하고(§8-1의 '소유자'를 임시로 Dashboard가 대행), Worker 이식은 같은 상태기계를 옮기는 후속으로 둔다. 표면 버튼 단독 패치는 없다 — D-01조차 Stage 2의 전이 구현 안에서 고친다.

| Stage | 작업 | 해소하는 결함 | 충족 불변식/P항목 |
|---|---|---|---|
| **1. 스키마** — `createQueueEntry` 팩토리 + entryId/runId + useSyncState v2(구 상태 마이그레이션, blob 소실 안내) | 재예약/재호출/드래그/삭제를 entryId 기준으로 전환 | D-09, D-21, D-04(안내), D-15 재발 방지 | INV-1 전제 · P0-2 · P1(드래그 ID) |
| **2. 코디네이터 상태기계** — `active{entryId,runId,phase}`, media 이벤트에 runId 클로저 바인딩, `<audio>/<video>/YT key=runId`, playing/paused 확인 이벤트 신규 배선, updater 부작용 완전 제거, ytPlayerRef null 처리, 스킵 배선을 의도 명령으로 재작성 | **D-01**, D-06, D-10, D-11, D-25(가드 후 토스트) | INV-5 · P0-1(로컬판), P0-2 |
| **3. finishing/discarding/failed 전이** — 스킵=끝으로 seek→ended→completed(YT는 outputSafety unknown 시 보류 폴백), 현재 곡 쓰레기통 재도입(discarding 표시), failed 자동 스킵 제거+재시도/버리기, autoPlayNext·바로 재생·다시 예약을 completed 전이 하나로 통합 | D-01 잔여 의미론, D-30(복합 명령 명시), 자동 스킵 위반 | INV-2/3/4 · P0-3, P0-4, P1(전이 통합) |
| **4. blob 수명 + 세션 정리** — revoke를 state 참조 카운트 기반으로, 세션 종료 시 일괄 revoke+abandoned, 새로고침 복구 안내 | **D-02**, D-04 완결, D-31 완결 | INV-7/8 · P1(blob/R2) |
| **5. 위젯 projection** — 발행 payload를 `{currentSong(phase,completionReason 포함), history, isPlaying}`로 축소, history 상한, ntfy `since=` 또는 위젯 접속 재발행, **직접 모드 위젯 URL 복사 UI 복원(N-01)**, phase 표시(§4-3 표) | D-12, D-14, D-16, D-18잔존, D-20, D-22, D-24, D-26, D-28, D-29, N-01, N-08 | INV-9 · P1(위젯) · P2 전반 |
| **6. 오디오 프록시 통합** — §5 설계. preparing/ready 실증, outputSafety safe, 결정적 finish | P0-6(광고/실곡 구분)의 실질 해소, D-22 정교화 | INV-6 · P0-6 |
| **7. [후속·대형] On-Air Worker 상태기계 이식** — Stage 2-3의 상태기계를 SessionRoom으로 이동: finish/discard/prepare 명령+회신, 단일 player lease(N-04), presence 상태화(N-05), 낙관 갱신 제거(N-02), 종료 세션 1008 close+클라이언트 백오프(N-03), snapshot-큐 정합(N-07), Dashboard/Widget projection 소비자화 | N-02~N-05, N-07, N-09 | INV 전체의 원격판 · P0-1/3/4/5, P1(재연결) |
| **8. 카탈로그·AI 정리** — Gemini 키 trim/순차 재시도(functions/api/gemini.js:6-9 현재 무작위 선택·재시도 없음), 대량 제목 캐시 일괄 조회, MR 재검증 시각 | — | P1(카탈로그) — 방송 상태 진실성 확보 후(PROJECT_STATUS §4-5와 동일) |

Stage 1-6이 전부 **레포 내 + 현행 UI 구조 유지**로 가능하다. Stage 7만 Worker 배포가 필요하나 §0-1의 정정대로 코드는 이미 레포 안에 있다.

### 검증 필요 목록
- `rekasong-session.11qaws.workers.dev`·`rekasong.pages.dev` 실배포/동작 상태
- YouTube iframe에서 광고 재생 중 `getDuration()`/`seekTo(duration)` 동작(스킵 보류 조건의 실측 근거)
- 파괴된 YT 플레이어 메서드 호출의 동기 예외 여부(D-11)
- 오디오 프록시의 URL 규약·Range(seek) 지원·CORS 헤더
- BroadcastChannel 경로의 timestamp 미검사로 인한 실제 되감김 재현 여부(§3-1)

---

**핵심 결론**: PHASE_07의 31건 중 7건 해결·3건 무효·1건 부분 해결·**20건 유효**이며, 유효 결함의 65%가 entryId/runId 부재라는 단일 뿌리를 공유한다. 전송 구조에서는 규범 문서가 아직 다루지 않은 갭 6건(N-01 직접 모드 위젯 URL 부재, N-02 Worker 낙관 갱신, N-03 1006-루프 메커니즘, N-04 다중 player, N-07 snapshot-큐 비조율, N-08 카탈로그 평문 노출)을 새로 확정했다. 생애주기 P0는 "Worker 신축"이 아니라 (a) 레포 내 직접 재생 경로에 상태기계를 먼저 세우고 (b) 이미 레포에 있는 SessionRoom Worker로 그 상태기계를 옮기는 2단계로 재정의되며, 오디오 프록시 백엔드는 YouTube 곡의 `outputSafety: safe`와 결정적 `finishing→ended→completed`를 실현하는 Stage 6 조각으로 기존 `<audio>` 배선에 그대로 얹힌다.
