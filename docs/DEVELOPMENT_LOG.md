# Development log

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
