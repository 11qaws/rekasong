# Speaker 로컬 파일 수요 계약 — 2026-07-22

## 사용자 약속

로컬 파일을 Speaker에서 듣는 일은 일반 웹 플레이어 조작이다. 파일 선택, 검토, 즉시 재생, 대기열 추가, 파일 다시 선택은 production Worker, OBS Browser Source, 제어 WebSocket의 가용성과 무관하게 동작한다. OBS를 명시적으로 선택한 경우에만 같은 파일을 방송 플레이어가 받을 수 있도록 세션 자산을 준비한다.

## 한 곡의 두 소스

| 필드 | 소유자 | 용도 | 수명 |
|---|---|---|---|
| `song.src = blob:…` | 현재 Dashboard 페이지 | Speaker 미리듣기·재생 | 페이지 종료 또는 마지막 참조 제거까지 |
| `song.assetId` | 현재 방송 세션 | OBS Browser Source 재생 | 세션 자산 정책까지 |

OBS 준비는 `assetId`를 Blob 옆에 추가하며 `src`를 덮어쓰거나 회수하지 않는다. 따라서 OBS 업로드 실패·연결 실패·제어권 충돌이 발생해도 사용자는 Speaker로 돌아가 같은 Blob을 계속 들을 수 있다.

## 상태 전이

| 현재 | 사용자 행동 | 다음 | Worker session/업로드 |
|---|---|---|---|
| Speaker idle | 로컬 파일 선택 | Speaker 검토 | 0 / 0 |
| Speaker 검토 | 즉시 재생·대기열 | Speaker Blob 재생/대기 | 0 / 0 |
| Speaker expired placeholder | 파일 다시 선택 | Speaker Blob 대기열 | 0 / 0 |
| Speaker Blob 대기열 | OBS 명시적 선택 | OBS 파일 준비 | media session 필요 시 1 / Blob source별 1 |
| OBS 파일 준비 | Speaker 선택 | Speaker | 업로드 완료를 기다리지 않으며 Blob 즉시 사용 |
| OBS 파일 준비 완료 | OBS에서 곡 선택 | 기존 strict OBS LOAD | `assetId` 사용 |
| OBS 파일 준비 실패 | Speaker 선택, 검토 화면의 다시 준비, 또는 대기열 곡 재선택 | Speaker 계속 사용 또는 명시적 재시도 | 자동 무한 재시도 없음 |

## 불변식

1. 새 페이지와 로컬 파일 Speaker 재생은 `/v1/sessions` 요청, session WebSocket, WebSocket frame이 모두 0이다.
2. `blob:` URL은 `localStorage`, 원격 위젯 projection, Worker 명령의 공개 표시 필드에 저장하지 않는다.
3. 같은 Blob을 참조하는 현재 곡·대기열·이력은 하나의 OBS 업로드 결과를 공유하며 중복 업로드하지 않는다.
4. OBS run은 유효한 `assetId` 없이는 시작하지 않는다. 준비 중이면 자동 재생을 추측하지 않고, 준비 완료 안내 뒤 대기열에서 다시 누르는 다음 행동을 제공한다. 검토 중 준비 실패에는 그 자리에서 누를 수 있는 번역된 다시 준비 버튼을 제공한다.
5. 업로드는 Speaker transport를 pause·detach·재시작하지 않는다. OBS에서 Speaker로 돌아가는 선택도 업로드 완료를 기다리지 않는다.
6. 페이지 종료·대기열 제거·이력 예산 회수는 실제 Blob 참조를 기준으로 한다. `assetId`의 존재가 page Blob 수명을 바꾸지 않는다.
7. 로컬 Speaker/PlaybackEngine chunk도 idle 첫 화면에는 내려받지 않는다. 로컬 파일 검토·현재/대기 곡 또는 실제 media session 수요가 생길 때만 lazy mount한다.
8. OBS player·Worker protocol과 strict 단일 출력 lease는 변경하지 않는다.
9. 유레카의 3px 노란 머리선은 파일·연결 상태와 무관하게 항상 렌더한다.

## 검증 관문

- 순수 계약: 로컬 Blob resolver는 `ensureSession` 0회, remote media만 수요 시 session을 확보한다.
- 실제 production-browser: local WAV 선택→검토→재생에서 media time 증가, session HTTP 0회, WebSocket 0개, frame 0개, durable Blob URL 0개.
- OBS 준비: 같은 Blob의 current/queue/history에 `assetId`를 덧붙여도 Blob `src`가 유지되고 source별 후보가 중복되지 않는다.
- 전체 앱: 한영 catalog parity, 320px overflow, 1,000곡 이력 예산, OBS 정적 bundle 예산, 500회 Speaker↔OBS 왕복을 계속 통과한다.

실제 OBS에서 로컬 파일을 업로드해 송출하고 Speaker로 돌아와 같은 파일을 청취하는 물리 검증은 production 배포 뒤 수행한다. 사용자 청취·비공개 방송/VOD·마이크↔MR 10분 싱크와 동일하게 자동 증거와 구분해 기록한다.
