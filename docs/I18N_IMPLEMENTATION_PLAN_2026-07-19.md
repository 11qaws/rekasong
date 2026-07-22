# Rekasong 텍스트·번역 체계 구현 계획

> 작성일: 2026-07-19
> 작업 위치: `D:\Agents\rekasong\Codex\workspace`
> 기본 언어: 한국어
> 관계: OBS/오디오 검증과 별도 합격 게이트지만 모든 신규 UI에 즉시 적용

현재 체크포인트:

- `src/copy/outputMessages.js`에 신규 출력·OBS 상태, 동작, gate, 검증 scope의 semantic key와 한국어 fallback을 구축했다.
- output view와 coordinator는 번역된 문장 대신 안정적인 code/key와 구조화 detail을 반환한다.
- 자동 테스트가 key 형식, 한국어 fallback 존재, placeholder parity를 검사한다.
- Dashboard의 현재 사용자 흐름, 출력/OBS 설정, 검색·노래책·스테이징·대기열·재생 오류·AI 진행·오류 경계 문구를 semantic key로 이관했다.
- 정식 locale 선택기는 한국어/영어만 노출하며 새로고침 없이 `<html lang>`과 화면 문구를 함께 바꾼다.
- Display Widget은 대시보드 catalog를 끌어오지 않는 작은 전용 catalog를 사용하고, 복사하는 URL에 locale을 고정한다.
- 이번 경량화 변경은 사용자 노출 문구를 새로 만들지 않았다. `DisplayWidget` 분리는 기존 JSX copy를 의미 변경 없이 이동했고, prefetch·resolver·성능 budget은 locale-neutral code와 개발자용 진단만 사용한다.

2026-07-22 진행 갱신:

- Speaker/OBS 경계, 출력 전환 경고, 독립 탭 안내, YouTube 탭/검색, 노래책 선택 affordance에 새로 추가하거나 의미를 바꾼 문구는 모두 semantic key로 이관하고 `ko`/`en`을 함께 작성했다.
- `SearchPanel` 회귀 테스트가 해당 화면의 `t('…')` 키에 한국어·영어 catalog가 모두 존재하는지 검사한다.
- 기본 문서 언어는 실제 UI와 동일한 `<html lang="ko">`로 유지한다.
- 현재 사용자 흐름의 하드코딩 문구 이관과 무새로고침 선택기는 완료했다. AI 진행 상태도 한국어 문장 정규식이 아니라 locale-neutral 단계와 message key를 저장한다.
- pseudo-locale와 모바일 긴 문구 검증은 test-only browser gate로 완료했다. 남은 범위는 앞으로 추가되는 서버 이벤트의 semantic status code 확대다. 곡명·가수명·태그·사용자 입력·외부 고유명사는 번역하지 않는다.

## 1. 결정

지금부터 새로 만들거나 의미를 수정하는 사용자 노출 텍스트는 번역 가능한 구조로 작성한다. 기존 화면 전체 이관은 OBS Protocol v2 작업을 막지 않도록 화면 단위로 진행한다.

- 한국어 문장을 번역 key로 쓰지 않는다.
- 자동 AST wrapping으로 기존 문장을 기계적으로 `t()`로 감싸지 않는다.
- 상태·오류·프로토콜에는 번역문이 아니라 안정적인 code를 저장한다.
- 실제 번역이 검수되지 않은 locale은 선택기에 노출하지 않는다.
- 한국어는 authoritative source이자 최종 fallback이다.

## 2. Gemini 시도에서 재사용하지 않을 것

Gemini 폴더의 i18n 작업은 읽기 전용으로 조사했다. 다음 이유로 diff 전체를 병합하지 않는다.

- 약 20개 파일을 자동 변환해 코드 의미 변경과 번역 변경이 섞였다.
- 한국어 원문이나 동적 template 전체를 `t()` key처럼 사용한 부분이 있다.
- JSX, hook, 일반 함수에 서로 다른 방식으로 i18n 접근이 삽입됐다.
- 일부 interpolation과 조사·복수형이 문자열 이어 붙이기로 남았다.
- 한국어/영어/일본어/레카어 catalog의 품질과 제품 톤이 정식 검수되지 않았다.
- source locale조차 실험적 말투가 섞여 제품의 실제 한국어 문구로 사용할 수 없다.

재사용 가능한 것은 `common`, `dashboard`, `queue`, `search`, `staging` 같은 domain 분리 아이디어뿐이다. key, 번역문, 자동 변환 결과는 Codex에서 다시 검토한다.

## 3. 사용자 노출 텍스트의 범위

다음은 모두 번역 대상이다.

- JSX 본문과 heading
- button/link/menu/tab label
- form label, placeholder, help text
- `title`, `aria-label`, `aria-description`
- toast, banner, snackbar
- confirm/dialog 제목·본문·행동
- loading/empty/error/success/status
- OBS wizard와 검증 결과
- Widget에 표시되는 시스템 문구
- 파일 제한, 네트워크 실패, 권한 안내
- 날짜·시간·숫자·곡 수의 주변 문구
- 이메일이나 외부 알림이 추가될 경우 해당 template

곡명, 가수명, 사용자가 입력한 메모, 서버에서 받은 고유명사는 번역하지 않는다.

## 4. key 설계

형식:

```text
<domain>.<feature>.<element-or-state>
```

예시:

```text
common.action.close
common.action.retry
playback.output.speaker.label
playback.output.obs.description
obs.setup.player.required_title
obs.status.player_page_connected
obs.status.runtime_attested
obs.verification.recording.passed
protocol.error.stale_lease
```

규칙:

- key는 영어 소문자와 숫자, 점, underscore만 사용한다.
- 화면 위치보다 의미를 우선한다. 같은 의미가 아니면 문장이 같아도 key를 공유하지 않는다.
- `button1`, `text2`, 한국어 음차, 현재 문장 전체를 key로 사용하지 않는다.
- 성공·실패·미확인·stale을 하나의 문자열 interpolation으로 합치지 말고 상태별 key를 둔다.
- aria label은 보이는 label과 의미가 같으면 재사용할 수 있지만, 추가 설명이 필요하면 별도 key를 둔다.

## 5. catalog 구조

목표 구조:

```text
src/i18n/
├─ index.js
├─ localeStore.js
├─ formatters.js
├─ pseudoLocale.js
├─ useAppTranslation.js
└─ locales/
   ├─ ko/
   │  ├─ common.json
   │  ├─ playback.json
   │  ├─ obs.json
   │  ├─ queue.json
   │  ├─ search.json
   │  ├─ staging.json
   │  └─ widget.json
   ├─ en/...
   ├─ ja/...
   └─ reka/...
```

첫 vertical slice 동안 `src/copy/outputMessages.js` 같은 domain catalog를 사용할 수 있다. 다만 외부 component는 catalog 객체를 직접 읽지 않고 translator facade만 호출한다. 정식 i18n runtime을 붙일 때 component를 다시 바꾸지 않기 위해서다.

현재 pseudo-locale는 production locale pack에 넣지 않는다. `scripts/pseudo-locale-fixture.mjs`와
`scripts/dashboard-pseudo-locale-smoke.mjs`에서만 reviewed English copy를 변형한다. 따라서 정식 선택기는
계속 한국어/English만 표시하고, 첫 화면과 OBS player closure의 다운로드 크기도 늘리지 않는다.

## 6. translator 계약

component에서 기대하는 최소 API:

```js
const { t, locale, formatNumber, formatDate, formatDuration } = useAppTranslation();

t('obs.status.player_page_connected');
t('queue.count', { count });
t('obs.command.seek_pending', { position: formatDuration(seconds) });
```

React 밖의 순수 모듈은 번역된 Error를 만들지 않는다.

```js
throw new AppError('prepare.unreachable', { status });
```

UI 경계가 error code를 현재 locale로 변환한다.

## 7. interpolation·복수형·formatting

- named placeholder만 사용한다.
- locale별 placeholder 이름과 개수는 반드시 같아야 한다.
- HTML string interpolation을 하지 않는다.
- React node가 필요한 문장은 rich-text component mapping을 사용한다.
- 곡 수, 실패 수, player 수는 locale plural rule을 사용한다.
- 시간은 직접 `분:초` 문자열과 조사 문장을 결합하지 않고 formatter를 사용한다.
- 날짜·시간·숫자는 `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`을 사용한다.
- dBFS, ms, Hz 같은 기술 단위는 값과 label을 분리하고 locale별 spacing을 formatter가 담당한다.

## 8. locale 선택과 저장

- 최초 기본값은 `ko`다.
- 지원·검수 완료 locale만 `supportedLocales`에 둔다.
- 사용자가 고른 locale은 별도 versioned key로 저장한다.
- 저장값이 더 이상 지원되지 않으면 한국어로 fallback한다.
- 브라우저 언어 자동 감지는 두 번째 정식 locale이 출시될 때 활성화한다.
- URL/query로 pseudo-locale를 켜는 기능은 development/staging에서만 허용한다.
- locale 변경은 페이지 새로고침 없이 React UI를 다시 렌더해야 한다.
- `<html lang>`도 현재 locale에 맞춰 갱신한다.

## 9. Worker/API/저장 데이터

신규 Protocol v2는 다음 형태를 사용한다.

```json
{
  "type": "error",
  "code": "stale_lease",
  "details": {
    "expectedEpoch": 12,
    "receivedEpoch": 11
  }
}
```

금지:

```json
{
  "message": "이전 연결에서 온 명령입니다."
}
```

정책:

- code는 protocol contract이며 locale과 무관하다.
- details는 번역용 named data이고 사용자 입력을 HTML로 취급하지 않는다.
- 로그에는 code와 structured detail을 남긴다.
- localStorage/IndexedDB/certificate에는 status code를 저장한다.
- 이전 v1 localized message는 호환 기간 동안 읽되 신규 v2 write에는 추가하지 않는다.
- 알 수 없는 code는 `common.error.unknown`과 진단 ID로 fallback한다.

## 10. 번역 상태와 활성화

각 locale/key는 내부적으로 다음 상태를 가진다.

```text
missing → drafted → reviewed → product_qa → released
```

- `missing/drafted` locale은 production selector에 노출하지 않는다.
- 기계 번역은 draft까지만 허용한다.
- 방송 안전 문구는 제품 담당자와 해당 언어 검토자가 의미를 확인한다.
- `mute`, `monitor`, `recording`, `stream`, `player PCM`처럼 혼동 위험이 있는 용어는 glossary로 고정한다.
- 한국어 문구 변경 시 다른 released locale을 stale로 표시한다.

## 11. pseudo-locale

pseudo-locale는 번역 품질이 아니라 구현 누락과 layout을 검사한다.

- 문구 길이를 약 30~50% 늘린다.
- ASCII 문자를 accent 형태로 바꾸되 key와 placeholder는 보존한다.
- 곡명, URL, token, code block은 변환하지 않는다.
- 320/375/768/1100px에서 overflow와 잘림을 검사한다.
- button, tab, toast, modal, table, OBS status strip을 포함한다.
- screen reader label도 missing key가 그대로 노출되지 않는지 검사한다.

적용 상태:

- [x] 일반 문구를 accent 형태로 바꾸고 약 40% 늘리는 deterministic fixture
- [x] `{{placeholder}}`, URL, 이메일, 제품명, 대문자 protocol token과 version/단위 보존
- [x] 본문뿐 아니라 `aria-label`, `aria-description`, `title`, `placeholder`, `alt` 변환
- [x] 메인 Dashboard, Speaker 설정, 전체 OBS 설정과 performer-monitor 상세 검사
- [x] 320/375/768/1100px document/dialog overflow, 버튼 이탈, 숨은 잘림 검사
- [x] OBS 설정 검사 중 session HTTP와 모든 WebSocket 차단, media source·재생 0 확인
- [x] production build 뒤 Pages artifact upload 전에 실패시키는 CI gate

## 12. 자동 검증

### catalog test

- key naming rule
- 한국어 authoritative key 존재
- released locale completeness
- placeholder parity
- JSON/JS parse
- duplicate key
- orphan key와 missing key report
- fallback 동작
- unsafe HTML interpolation 금지

### source scan

- 신규·수정 JSX의 hardcoded 한국어/영어 UI text 감지
- `title`, `aria-label`, toast, confirm 누락 감지
- Worker/API 신규 한국어 `message` 감지
- source text를 `t()` key로 사용한 패턴 감지
- 동적 template 전체를 key로 사용하는 패턴 감지

초기에는 기존 hardcoded text를 baseline allowlist에 기록하고 **신규 증가만 실패**시킨다. 화면을 이관할 때 해당 allowlist를 줄인다.

### UI test

- locale runtime switch
- 한국어 fallback
- missing key diagnostic
- pseudo-locale layout
- plural 0/1/many
- long artist/song names와 번역문 조합
- keyboard/screen reader에서 언어 변경

## 13. 화면별 migration 순서

1. OBS 연결·출력·검증 wizard
2. 공통 action/error/status
3. 현재 재생과 출력 선택기
4. 대기열과 이전 곡
5. 검색과 외부 노래책 연동
6. staging/준비 pipeline
7. Widget/display
8. ErrorBoundary와 전역 toast
9. hook/lib의 AppError code
10. Worker/API v1 compatibility message 제거

각 slice는 코드 변경, 한국어 catalog, test, pseudo-locale screenshot을 함께 제출한다.

## 14. 구현 단계

### I0 — 기반

- semantic key 규칙
- 한국어 catalog
- translator facade
- interpolation/formatter
- test runner와 catalog contract test
- `lang="ko"`

### I1 — OBS 첫 slice

- Phase 0 OBS modal copy
- 상태 chip과 오류 code
- title/aria/toast/confirm 포함
- pseudo-locale modal 검증

### I2 — 앱 공통

- common action/status/error
- AppError class와 code mapping
- global toast/confirm wrapper

### I3 — 화면 이관

- migration 순서대로 vertical slice
- baseline hardcoded scan 감소

### I4 — 두 번째 언어

- glossary 확정
- 전체 translation/review/product QA
- selector와 browser detection 활성화

### I5 — 일본어·레카어

- 각 locale 독립 completeness/QA
- 미완성 locale 비공개 유지

## 15. 첫 구현 slice의 완료 정의

- [x] OBS Phase 0에서 새로 추가·수정한 모든 문구가 semantic key를 사용한다.
- [x] title/aria/toast/confirm도 같은 catalog를 사용한다.
- [x] 한국어 fallback과 named interpolation이 동작한다.
- [x] 신규 Worker v2 error/status가 code 기반이다.
- [x] catalog key/placeholder/fallback test가 있다.
- [x] Gemini 자동 변환 파일을 복사하지 않았다.
- [x] `lang="ko"`와 modal 접근성이 함께 검증됐다.
- [x] 실제 Dashboard 사용자 화면 8개의 hardcoded text baseline과 source guard가 기록됐다. 사용하지 않는 legacy 화면은 별도 유지보수 backlog로 남긴다.

## 16. 현재 작업과의 관계

- Protocol v2 schema와 lease 검증은 번역 완료를 기다리지 않는다.
- 신규 protocol code는 처음부터 locale-neutral하게 만든다.
- 공통 playback adapter와 source resolver도 사용자 문장을 반환하지 않고 안정적인 locale-neutral code와 bounded detail만 반환한다.
- 실제 OBS G3/G3-S/G4 결과는 locale별 UI 문구와 별개로 raw 수치·code를 저장한다.
- 번역 UI 실패가 audio safety state를 바꾸지 않게 상태 machine과 copy layer를 분리한다.
- 번역되지 않은 key가 있어도 안전 상태를 낙관적으로 바꾸지 않고 한국어 fallback과 진단을 사용한다.

## 17. 2026-07-22 적용 상태

- 설정 대화상자에 한국어/English 선택기를 정식으로 추가했다. 선택은 `rekasong.locale`에 저장되고 `document.documentElement.lang`과 함께 갱신된다.
- Dashboard 전용 번역은 `src/copy/appMessages.js`, OBS/출력 안전 문구는 `src/copy/outputMessages.js`로 분리했다. Dashboard catalog가 output catalog를 fallback으로 사용하므로 기존 key 호환성을 유지한다.
- 두 catalog를 합친 전체 key 집합은 한국어/영어가 1:1 parity를 가져야 하며 자동 테스트가 이를 강제한다.
- YouTube 소스, 노래책, 곡 검토, 대기열, 현재 재생, 출력 설정의 정적 UI 문구를 semantic key로 연결했다. 사용자 노래책 제목과 YouTube iframe 자체 문구는 번역 대상 데이터/외부 UI로 구분한다.
- YouTube 재생목록과 Setlink 기본 출처명은 API에서 locale-neutral 메타데이터로 저장하고, 화면에서는 현재 locale의 semantic key로 다시 표시한다. 사용자가 지정한 Setlink 이름만 원문 그대로 유지한다.
- Dashboard locale pack은 OBS Protocol v2 정적 closure에 포함되지 않는다. 최신 후보의 OBS gzip은 115,958 bytes로 예산 133,120 bytes 안이며, 번역 추가 전과 실질적으로 동일하다.
- AI title 진행 상태와 오래된 Dashboard toast는 locale-neutral code로 이관했고, Widget/Display 전용 소형 locale pack을 분리했다.
- `tests/i18nSourceGuard.test.mjs`가 실제 Dashboard 사용자 화면의 하드코딩 한국어, 정적 title/aria/placeholder, toast/confirm 증가를 배포 전 `npm test`에서 막는다.
- 참조가 없고 번역되지 않은 구형 `LivePanel.jsx`는 v0.2.5에서 제거했다. 현재 Dashboard 사용자 흐름의 번역 범위와 별개인 죽은 화면을 baseline backlog로 유지하지 않는다.
- `scripts/dashboard-pseudo-locale-smoke.mjs`가 reviewed English copy를 test-only `qps-ploc` 형태로 늘려 메인/Speaker 설정/OBS 설정을 320/375/768/1100px에서 검사한다. 이 검사는 session HTTP에 격리된 503을 반환하고 WebSocket을 서버에 연결하지 않으며, audio/video source와 재생이 0인지 확인한다.
- `.github/workflows/deploy-pages.yml`은 production build 직후 `npm run test:dashboard:pseudo`를 실행하고, 통과한 artifact만 Pages에 올린다. pseudo catalog와 Playwright 검사는 runtime import graph에 들어가지 않는다.
