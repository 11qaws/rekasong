# Rekasong

방송용 노래 검색·MR 카탈로그·대기열·OBS 위젯 제어 도구입니다.

## 기준 문서

- [곡 생애주기와 상태 모델](docs/SONG_LIFECYCLE.md) — 재생·대기열·OBS·위젯·UI/UX의 기준 계약
- [현재 상태와 다음 작업](docs/PROJECT_STATUS.md) — 구현 범위, 알려진 차이, 우선순위별 TODO
- [가사 오버레이 계약](docs/LYRICS_OVERLAY_CONTRACT.md) — beat cue, Player media clock, Protocol/asset 경계
- [가사 번역 정책](docs/LYRICS_TRANSLATION_POLICY.md) — 출처 우선순위, provenance, user lock, AI fallback
- [OBS 가사 acceptance](docs/LYRICS_OBS_ACCEPTANCE.md) — 1920×1080 설정, 합성 HAMELN, 5분/10분 검증 절차

## 이중 언어 가사 오버레이

현재 곡, 스테이징 곡, 대기열 곡의 `가사 준비`에서 원문과 한국어 번역을 가져오고, BPM/첫 다운비트/anchor/간주 blank를 확인한 뒤 방송 세션에 준비할 수 있습니다. 준비된 원문+한국어 그룹은 Protocol v2 OBS Player에서 실제 오디오 `currentTime`을 따라 표시됩니다. 외부 가사 공급자가 없어도 파일과 붙여넣기로 전체 흐름을 사용할 수 있습니다.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
