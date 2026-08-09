# Development log

## 2026-08-09 — prepare 파이프라인에 가사 자동 준비 통합

- 전역 YouTube prepare 작업이 오디오와 같은 claim에서 metadata와 timed caption을 수집하도록 계약을 확장했다.
- 수동 caption을 우선하고 없으면 원언어 ASR을 후보로 쓰며, VTT의 음악 표식·rolling duplicate를 정규화한다.
- 가사 후보 본문은 인증된 별도 R2 JSON으로 저장하고 prepare 상태에는 언어·출처·cue 수·실패 코드만 둔다.
- Dashboard는 후보 전체를 문맥 기반 한국어 초안으로 번역하고, 자동 결과를 확정하지 않은 채 `검수 필요`로 5단계 편집기에 연결한다.
- 가사 수집·번역 실패는 오디오 `ready`를 취소하지 않으며, 곡별 `requireLyrics` 차단 정책도 그대로 유지한다.
- 늦게 끝난 이전 세션 작업은 곡별 generation과 session identity로 무시하며 자동 준비는 재생 권한을 갖지 않는다.

Worker와 VPS prepare worker 배포 및 실제 YouTube caption 검증은 아직 수행하지 않았다.

## 2026-08-09 — 이중 언어 가사 OBS 오버레이

- 작품/음원/원문/번역/tempo/cue/package를 분리한 schema와 IndexedDB repository v1을 추가했다.
- LRC, enhanced LRC, SRT, VTT, TTML, JSON, plain text import와 1:N/N:1 mapping을 추가했다.
- 번역 출처 우선순위, 공식 개사 제외, 독립 source-family consensus, user lock 정책을 순수 함수와 테스트로 고정했다.
- tempo-map의 목적 anchor 1/4음표 전 fade start, 1/8음표 전 fade end, fixed-ms fallback, blank cue, seek-safe binary lookup을 구현했다.
- 현재 곡·스테이징·대기열에서 여는 5단계 준비 modal, timing undo/redo/override, OBS preview와 style 설정을 추가했다.
- 별도 contextual lyrics translation endpoint를 추가했으며, 자격 증명이나 provider 오류 때 수동 import를 유지한다.
- 세션 범위 JSON lyrics asset upload/read/delete 경로와 SHA-256 검증을 추가했다.
- Protocol v2 capability, compact LOAD ref, runtime 관측 projection을 추가했다. 구형 Player에는 optional ref를 제거한다.
- OnAirPlayerV2의 실제 audio currentTime을 읽는 두-layer renderer를 추가했다. 가사는 audio를 제어하지 않는다.
- HAMELN 130 BPM placeholder test와 기존 5분/10분 no-drift fixture의 lyrics manifest를 추가했다.
- `791/791` unit/integration tests, production build, OBS bundle budget, Dashboard production/drag/pseudo/Blob smoke를 통과했다.
- 전용 production UI smoke에서 5단계 준비, BPM 미입력 fallback, 130 BPM, blank/undo/redo, bilingual preview, 320px, IndexedDB 저장과 합성 session publish를 확인했다.
- Session Worker version `41508a36-4169-419c-872c-adeea690bc45`를 배포하고 production에서 합성 JSON package upload/read와 hash 일치를 확인했다.

실제 OBS Studio mixer/CEF frame/녹화 검증과 음악 재생은 수행하지 않았다. frontend Pages 결과와 공개 자산 검증은 배포 workflow 완료 뒤 별도로 기록한다.

## 2026-08-09 — 현재 재생 가사 스테이지와 입력원 정리

- Meloming API, hook, 저장 필드, 화면 진입점과 번역 문구를 제거하고 구 저장값은 기본 검색 탭으로 정규화했다.
- 곡 입력 선택을 `검색 · 플레이리스트 · Setlink` 세 개의 동일 층위 탭으로 재배치하고 기본값을 검색으로 고정했다.
- 현재 재생 카드에 곡 제목 아래 가사 스테이지, 그 아래 진행률과 재생 제어가 이어지는 단일 시선 흐름을 적용했다.
- IndexedDB의 가사 패키지를 SHA-256으로 다시 검증한 뒤 기존 media time과 cue 해석기를 재사용해 원문과 한국어를 표시한다.
- 준비 전, 로딩, 누락·검증 실패, 첫 cue 전, 간주 blank, 전환·재생 상태를 각각 표시하고 360px 이하에서는 입력원 아이콘을 숨겨 세 이름을 보존한다.
- 전체 `791/791` 테스트, lint, production build를 통과했다. 로컬 브라우저에서 실제 WAV 재생과 가사 준비를 거쳐 1440×900, 1024×768, 375×900, 320×900 레이아웃과 콘솔 오류 0건을 확인했다.

이번 변경은 아직 커밋·배포하지 않았으며 실제 OBS Studio mixer/CEF frame/녹화 검증은 수행하지 않았다.
