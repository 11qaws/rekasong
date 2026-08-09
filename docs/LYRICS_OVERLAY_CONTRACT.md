# 이중 언어 가사 오버레이 계약

> 기준일: 2026-08-09
> 범위: 방송 전 준비, 세션 자산, Protocol v2 Player 렌더링

## 1. 데이터 경계

- `SongWork`는 작품 정체성과 원문 언어를 보관한다.
- `TrackVersion`은 실제 재생 음원, 길이, 선행 무음, 전역 offset을 보관한다.
- `LyricDocument`와 `TranslationRevision`은 원문과 한국어 번역의 출처·revision을 분리한다.
- `TempoMap`은 음원 버전에, `CueSheet`는 음원 버전과 선택된 원문·번역 revision에 묶인다.
- `PlaybackLyricsPackage`만 OBS Player로 전달한다. 후보, 편집 이력, provider cache, 전체 문서 객체는 보내지 않는다.
- QueueEntry에는 본문 대신 package ID/hash, schema, 현재 세션 asset ID로 이루어진 `lyricsRef`만 둔다.

IndexedDB `rekasong-lyrics` schema v1은 `songWorks`, `trackVersions`, `lyricDocuments`, `translationRevisions`, `tempoMaps`, `cueSheets`, `playbackPackages`, `lyricsSettings`, `providerCache`, `quarantine` store를 사용한다. 준비 bundle은 한 transaction으로 저장하며, package hash와 문서 content hash로 중복을 찾을 수 있다.

## 2. cue와 시간 계약

`lyric` cue의 anchor는 실제 첫 음절 시점이고, `blank` cue의 anchor는 화면을 비울 음악 경계다. 간주는 데이터 누락이 아니라 명시적 `blank`다.

PPQ가 960일 때 목적 cue 전환은 다음과 같다.

```text
fadeStartTick = anchorTick - 960     # 1/4음표 전
fadeEndTick   = anchorTick - 480     # 1/8음표 전
```

템포 맵이 없으면 `anchor - 600ms`, `anchor - 300ms`를 사용하고 package에 `fixed_ms_fallback`을 기록한다. 이는 박자 동기 모드가 아니라 degraded fallback이다. 너무 가까운 cue는 이전 anchor보다 앞으로 넘어가지 않도록 축소하며, 사용자 override는 `fadeStartMs <= fadeEndMs <= anchorMs`만 허용한다.

`visualCue`는 현재 화면에 보이는 cue이고 `singingCue`는 anchor를 지난 실제 가창 cue다. 목적 cue는 anchor 1/8음표 전에 완전히 보일 수 있지만 word highlight는 anchor 전에는 활성화되지 않는다.

## 3. Player 시계와 렌더링

가사 시계의 유일한 권위는 Protocol v2 Player의 실제 `<audio>.currentTime`이다. 서버 position, Dashboard 추정 시각, 누적 wall-clock timer는 사용하지 않는다.

별도 원곡/공식 lyric 영상의 자막 시각은 현재 반주의 시각으로 자동 확정하지 않는다. 검수 단계에서 같은 첫 구절과 마지막 구절의 원곡·반주 시각 두 쌍을 확인하고 affine mapping으로 전체 cue를 이동·확대한 뒤, 미리보기와 개별 cue 조정을 거친다. 서로 다른 편곡이나 중간 템포 변화는 이 매핑의 자동 승인 대상이 아니다.

- 매 animation frame에서 절대 media time을 조회한다.
- pause와 buffering으로 media time이 멈추면 화면도 멈춘다.
- seek와 역탐색은 해당 절대 시각의 opacity를 즉시 다시 계산한다.
- playbackRate가 변해도 별도 보정 명령을 만들지 않는다.
- 가사는 오디오를 따르며 가사가 seek, restart, rate 변경을 요청하지 않는다.
- 이전 cue와 목적 cue는 두 DOM layer로 함께 교차 페이드한다. 원문과 한국어는 한 layer 안의 한 그룹이다.

새 LOAD는 기존 package와 DOM을 먼저 지우고 `entryId + runId + playerInstanceId + packageHash` ticket을 만든다. 늦게 완료된 이전 ticket은 현재 package를 바꿀 수 없다. optional lyrics 실패는 오디오 source 준비와 분리되며, 곡별 `requireLyrics`가 true일 때만 package 검증을 오디오 LOAD보다 먼저 기다린다.

## 4. Protocol과 세션 asset

OBS Player hello는 지원할 때만 다음 capability를 보낸다.

```json
{
  "lyricsOverlay": true,
  "lyricsPackageSchemaVersions": [1]
}
```

LOAD에는 `assetId`, `packageId`, `packageHash`, `schemaVersion`, `requireLyrics`만 들어간다. Worker는 capability 없는 Player로 보내는 optional ref를 제거하고 오디오는 유지한다. required ref는 명확히 거절한다.

가사 package 업로드는 미디어 upload와 분리된 `POST /lyrics-assets`, 읽기는 player-token 전용 `GET /lyrics/{assetId}`를 사용한다. JSON MIME, 선언 크기, 512 KiB 상한, 2,000 cue 상한, schema, SHA-256을 검증한다. key는 `sessions/{room}/lyrics/{assetId}`이며 세션 cleanup에서 미디어와 함께 삭제한다. 가사 본문은 WebSocket, display state, heartbeat, 로그에 넣지 않는다.

런타임 heartbeat에는 본문 없이 status, package hash, timing mode, cue count만 관측 정보로 보낼 수 있다.

## 5. 호환성과 롤백

- `VITE_LYRICS_OVERLAY_ENABLED=false`면 capability와 visual DOM을 추가하지 않는다.
- `protocol=2`가 없는 기존 Player URL과 display widget URL은 그대로다.
- 구형 Player 또는 capability 미지원 Player는 optional 가사만 생략하고 오디오는 재생한다.
- 가사 asset 장애는 기본 오디오 lifecycle event로 가장하지 않는다.
