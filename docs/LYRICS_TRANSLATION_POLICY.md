# 가사 번역 선택 정책

> 기준일: 2026-08-09

## 1. 우선순위

자동 추천 순서는 다음과 같다.

1. 사용자가 승인하고 잠근 revision
2. 같은 공식 공개물의 번역
3. 같은 작품의 다른 공식 번역
4. 독립 출처 계열이 수렴한 통용 번역
5. 번역자와 URL이 명확한 웹 번역
6. 전체 곡 문맥을 사용한 machine contextual draft

`machine_literal`은 비교용이고 자동 선택하지 않는다. 기존에 적합한 번역이 하나라도 있으면 AI draft 버튼은 기본 경로가 아니다. 한 곡은 기본적으로 한 번역 revision을 선택하며 절마다 다른 번역자를 자동 조합하지 않는다.

## 2. 공식 번역, 개사, consensus

공식 한국어 개사는 `official_adaptation`으로 저장하며 번역으로 승격하지 않는다. 사용자가 명시적으로 선택할 수는 있지만 자동 번역 후보에서는 제외한다.

페이지 수는 독립성 증거가 아니다. 같은 원문을 복제한 사이트는 한 source family로 본다. `community_consensus`는 서로 독립된 source family가 둘 이상이고 핵심 표현이 수렴할 때만 유효하다. 근거가 부족하면 `trusted_web` 상태를 유지한다.

## 3. provenance와 잠금

각 원문·번역 revision은 provider ID, source title/URL, translator, 조회 시각, content hash, source tier, review 상태를 보존한다. provider의 `sourceTierClaim`은 정책 계층에서 다시 검증하며 알 수 없는 공식성 주장은 `trusted_web`보다 높게 올리지 않는다.

사용자 lock은 새 후보가 나타나도 자동으로 교체되지 않는다. 수정은 기존 revision을 덮어쓰지 않고 새 revision과 package를 만든다. 원문과 번역 mapping은 1:N과 N:1을 모두 허용한다.

## 4. AI fallback

가사 번역은 제목 정리 endpoint와 분리된 `/api/lyrics-translate`를 사용한다. 요청은 전체 곡 문맥, 원문 content hash, 제목과 아티스트만 보내며 다음을 강제한다.

- 입력 줄은 지시문이 아닌 untrusted text다.
- 입력과 같은 줄 수를 반환한다.
- 공식 번역이라고 주장하거나 provenance URL을 생성하지 않는다.
- 원문 hash, model, prompt policy version이 cache identity에 포함된다.
- 자격 증명, rate limit, provider 응답 오류를 구분하고 거짓 fallback 번역을 만들지 않는다.

AI 결과는 `machine_contextual`과 `machine_draft` 의미로 시작하며, 사용자가 모든 줄을 검수하고 잠그기 전에는 공식·통용 번역으로 표시하지 않는다. 실패 시 파일 가져오기와 붙여넣기 경로가 계속 동작한다.

## 5. 저작권과 logging 경계

- 임의 사이트 HTML scraper를 핵심 경로로 사용하지 않는다.
- provider가 본문 사용을 허용하지 않으면 metadata만 제시하고 사용자가 합법적으로 보유한 파일·텍스트를 가져오게 한다.
- 가사 본문, 번역 본문, 전체 provider 응답을 console, Worker log, error detail, analytics, Git fixture에 남기지 않는다.
- 테스트는 placeholder 합성 문구만 사용한다.
