# Development log

## 2026-08-09 - Grounded NamuWiki result URLs (v0.2.71)

- NamuWiki relay candidates now prefer the actual URLs in Gemini's Google Search result steps over a model-rewritten URL.
- The localhost helper tries at most three host-validated NamuWiki results, while the server still accepts only an exact-song complete-lyrics block.

## 2026-08-09 - Host-validated local NamuWiki handoff (v0.2.70)

- When Google discovery identifies a NamuWiki page but server-side URL Context is blocked, the host-validated `namu.wiki` URL is now handed to the localhost helper.
- The helper still accepts only NamuWiki pages, and the returned bounded blocks still require exact-song and complete-lyrics selection before any original text is accepted.

## 2026-08-09 - Lyrics artist provenance (v0.2.69)

- AI title cleanup now returns and caches the canonical recording/composition artist separately from the YouTube uploader.
- YouTube uploader names are no longer treated as artists; AI-resolved, user-edited, and Setlink catalog artists remain trusted search hints for caption and NamuWiki discovery.

## 2026-08-09 - Application-owned verified originals (v0.2.68)

- Verified NamuWiki or official lyrics are no longer requested in the model output; the application keeps the fetched source lines byte-for-byte after NFC normalization.
- Gemini returns translations only for verified lyrics, while the exact application validator still requires one non-empty translation for every original line.

## 2026-08-09 - Large verified-lyrics translation schema (v0.2.67)

- Removed provider-side dynamic array-length constraints that caused Gemini to reject a real 245-line NamuWiki candidate before translation.
- The application validator still requires both returned arrays to match the exact source-line count and still rejects any source-line rewrite for verified lyrics.

## 2026-08-09 - Retry lyrics after AI identity correction (v0.2.66)

- Invalidated provisional automatic-lyrics jobs when AI title extraction or an artist edit changes the song identity for the same video.
- Old failures and NamuWiki priority misses can no longer suppress a fresh search using the corrected title; generation guards still discard late results from the obsolete identity.

## 2026-08-09 - Local NamuWiki lyrics relay (v0.2.65)

- Added a loopback-only Node helper for the case where NamuWiki serves the user's Windows IP but challenges Cloudflare and Oracle data-center egress.
- NamuWiki-first preparation detects the helper, relays only bounded candidate blocks, and reuses the existing AI block-index selection plus mandatory review without regenerating source text.
- Added an explicit URL Context identity check for citation-free Google discovery so the verified public NamuWiki URL can be retried through the local helper.
- The helper accepts only `namu.wiki/w` pages, same-site redirects, bounded HTML, and allowlisted Rekasong origins including Chromium Private Network Access preflights.

## 2026-08-09 — grounded lyrics discovery and whole-song polish

- Extended the preparation fallback from LRCLIB exact/broad search to one bounded Gemini Google Search + URL Context pass, ordered from dedicated or official lyric sources through NamuWiki/Touhou Wiki/VocaDB discovery and finally the general web.
- Grounded web candidates are accepted only when the returned direct source URL is present in Gemini citation annotations and the response confirms one complete source. Untimed results enter review with explicit estimated timing instead of fabricated synchronization.
- Replaced line-only translation with one whole-song correction-and-translation request. The response must preserve the exact line count for both corrected originals and Korean lines; Korean captions now pass through the same contextual typo correction path.
- Added a preparation evidence panel for source, discovery path, correction count, timing quality, and the original source link. Every automatic result still stops at `review_required`.
- Bumped the deployment version to `0.2.48`.

## 2026-08-09 — Google caption integration boundary

- Public deployment probes confirmed that Gemini accepts direct public YouTube video input, but it did not produce a usable timed lyric candidate for a music video and added about 26 seconds to a miss.
- Removed Gemini from the automatic path rather than delaying every LRCLIB miss. A future Google Cloud Speech-to-Text fallback belongs in the Oracle prepare worker after dedicated billing, storage, and credentials are configured.
- Bumped the verified-provider deployment to `0.2.47`.

## 2026-08-09 — prepared lyrics web fallback

- Added the missing `/api/lyrics-search` Pages Function from the lyrics implementation plan.
- When YouTube manual and automatic captions are unavailable or fail, the Dashboard now searches LRCLIB for synchronized lyrics using the staged title and artist.
- The selected result keeps its LRCLIB source URL, is normalized into the existing bounded timed-candidate contract, and always stops at `review_required` before use.
- Existing YouTube timed captions remain first priority; the web fallback runs during preparation only, never during playback.

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
# 2026-08-09 - Gemini stable model migration (v0.2.49)

- Moved the shared Interactions API model from `gemini-3-flash-preview` to the production-stable `gemini-3.6-flash`.
- The same stable model now powers title detection, grounded lyrics discovery, and whole-song lyrics correction/translation.
- This follows Google's current production migration guidance and keeps Search Grounding, URL Context, and structured output support.

## 2026-08-09 - Grounding tool compatibility (v0.2.50)

- Matched the current Google URL Context example order by declaring URL Context before Google Search.
- Added a bounded provider-status diagnostic that excludes prompts, lyrics, and credentials.

## 2026-08-09 - Grounding compatibility fallback (v0.2.51)

- If Gemini rejects the combined URL Context and Google Search request, the preparation pipeline retries Google Search once within the same 25-second budget.
- The retry keeps the same exact-title matching, complete-page confirmation, direct citation match, and manual-review requirements.

## 2026-08-09 - Grounded schema compatibility (v0.2.52)

- Removed the provider-side `maxItems: 2000` state-space constraint from the grounded-search response schema.
- The application still rejects more than 2,000 lines, 50,000 total characters, overlong lines, invalid URLs, and responses without an exact citation match.

## 2026-08-09 - Safe grounded-search diagnostics (v0.2.53)

- Candidate misses now expose only bounded structural metadata: interaction status, step types, output length, citation/line counts, completion flag, and source host.
- Diagnostics never include prompts, lyric text, provider credentials, or raw provider errors.

## 2026-08-09 - Explicit URL Context evidence pass (v0.2.54)

- Structured Google Search results without inline JSON citations now receive one bounded URL Context verification pass.
- The verifier returns no lyrics and accepts the candidate only when the exact page contains every line in order, matches the requested title and artist, and cites that same public URL.

## 2026-08-09 - URL Context result provenance (v0.2.55)

- The evidence parser now accepts a successful `url_context_result` URL as first-party tool provenance in addition to inline `url_citation` annotations.
- Failed URL Context calls and non-success result entries remain unusable evidence.

## 2026-08-09 - Touhou source classification (v0.2.56)

- Added the public `thwiki.cc` Touhou Wiki family to the preparation evidence classifier.
- Verified the deployed web fallback against an LRCLIB-miss subculture track without logging or displaying lyric text.

## 2026-08-09 - NamuWiki-first lyrics preparation (v0.2.57)

- Every automatic lyrics job now probes a verified `namu.wiki` page before using prepared YouTube captions, LRCLIB, or the broader web fallback.
- A NamuWiki miss or provider failure falls through without blocking the existing timed-caption path.
- NamuWiki candidates still require an exact public-page provenance check and remain `review_required` with estimated timing.

## 2026-08-09 - Verbatim source lyrics and mandatory review (v0.2.58)

- Split AI web collection into three trust boundaries: Google Search discovers one direct NamuWiki or official/public source page, URL Context extracts only the page's visible lyrics verbatim, and a separate URL Context pass verifies every extracted line against the same page.
- NamuWiki, official web, LRCLIB, and human-authored YouTube caption candidates now lock their original wording. Translation output cannot correct, reinterpret, or replace those lines; automatic captions accept only bounded typo-scale corrections and reject unrelated replacements.
- Automatic drafts require four explicit human confirmations for exact song/source identity, line-by-line original text, Korean translation, and previewed timing before local save or session publication.
- Bumped the deployment version to `0.2.58`.

## 2026-08-09 - NamuWiki direct-text AI block selection (v0.2.59)

- Production evidence showed Google Search could identify the exact NamuWiki page while Gemini URL Context returned zero lyric lines, consistent with the provider's separate recitation/output restriction.
- NamuWiki fallback now fetches only bounded `namu.wiki` HTML through a same-site redirect guard, preserves candidate table-cell text directly, and asks Gemini to return only the matching block index and validation fields instead of regenerating lyrics.
- Candidate HTML, block count, line length, total characters, redirect count, and fetch time are bounded. The selected text remains verbatim and still stops at the four-item human review gate with estimated timing.
- Bumped the deployment version to `0.2.59`.

## 2026-08-09 - Deterministic NamuWiki title probe (v0.2.60)

- Added a first probe for the exact `namu.wiki/w/{song title}` page so a transient Google Search miss cannot skip an otherwise public exact-title document.
- Gemini still has to confirm the selected HTML block matches the requested title and artist and contains the complete lyrics; a missing or rejected exact-title page falls through to grounded AI discovery.
- Bumped the deployment version to `0.2.60`.

## 2026-08-09 - Safe NamuWiki probe diagnostics (v0.2.61)

- Removed the redundant requirement for Gemini to restate the server-known selected line count; the model now only selects a block and confirms exact-song and complete-lyrics status.
- Candidate misses expose only safe direct-probe structure (`attempted`, HTML available, block count, selected), never the page body, lyric lines, prompts, or credentials.
- Bumped the deployment version to `0.2.61`.
