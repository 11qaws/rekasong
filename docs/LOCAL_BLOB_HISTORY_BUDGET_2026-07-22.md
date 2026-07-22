# Speaker 로컬 파일 수명·복구 상태 모델 — 2026-07-22

## 1. 목적과 범위

Speaker를 일반 웹 플레이어처럼 오래 사용해도 완료 이력이 모든 `blob:` 음원을 페이지 메모리에 무한히 붙잡지 않게 한다. 동시에 메모리 정리가 현재 재생이나 대기열을 끊어서는 안 되며, 새로고침·다른 탭·예산 만료 뒤에도 곡 제목을 지우지 않고 사용자가 할 수 있는 다음 행동을 남긴다.

이 문서의 대상은 브라우저가 `URL.createObjectURL(file)`로 만든 **Speaker 로컬 파일**뿐이다. YouTube 준비 자산, OBS 세션의 `assetId`, R2 자산, 현재 OBS media graph와 Worker/WebSocket 프로토콜은 변경하지 않는다.

## 2. 상태 단위

### 2.1 로컬 원본 상태

| 상태 | 판정 | 의미 | 허용 행동 |
|---|---|---|---|
| `retained` | `type=local`, `src=blob:*`, `localSourceExpired` 아님 | 이 탭이 실제 파일 바이트를 보유 | 재생·대기열 추가·이력 다시 추가 |
| `protected` | retained 원본을 `currentEntry` 또는 `queue`가 참조 | 사용자가 현재 듣거나 앞으로 들으려는 원본 | 자동 만료 금지 |
| `history-retained` | retained 원본을 완료 이력만 참조 | 짧은 기간 다시 듣기용 캐시 | 예산 안에서 다시 추가 가능 |
| `expired` | `type=local`, `src=''`, `localSourceExpired=true` | 제목·가수·태그만 남고 파일 바이트는 없음 | 파일 다시 선택·기록 삭제 |

`expired`는 재생 실패 상태가 아니라 **원본 가용성**이다. QueueEntry의 중심 생애주기(`queued`, `completed`)와 별도 필드로 둔다.

### 2.2 원본 메타데이터

- `localBlobBytes`: 브라우저가 받은 `File.size`. 정수 바이트만 허용한다.
- `localSourceExpired`: 파일 바이트가 이 탭에 없음을 나타내는 boolean.
- 만료해도 `entryId`, `title`, `artist`, `tags`, `source`, `songbookId`, `createdAt`, 완료 사유는 보존한다.
- 만료 시 `src`는 반드시 빈 문자열이다. 이미 revoke한 URL을 재생 가능한 것처럼 저장하지 않는다.

## 3. 전이표

| 현재 상태 + 이벤트 | 다음 상태 | 부수 효과 |
|---|---|---|
| 파일 선택 | retained | Blob URL 1개 생성, 크기 기록 |
| retained → 현재 재생/대기열 | protected | 예산 계산에서 제외 |
| protected 곡 완료, 같은 src의 현재/대기열 참조 없음 | history-retained | 최근 이력 예산 후보가 됨 |
| history-retained + 예산 초과 | expired | 같은 src를 쓰는 완료 이력을 한 번에 만료한 뒤 URL revoke |
| retained + 다른 탭 저장 이벤트 | retained 유지 | 다른 탭의 expired 투영이 이 탭의 실제 Blob을 덮어쓰지 않음 |
| 다른 탭 또는 새로고침에서 retained 항목 수신 | expired | 페이지 전용 URL을 재생하지 않고 메타데이터만 유지 |
| expired 대기열 + 파일 다시 선택 | retained/queued | 같은 entryId·순서를 유지하고 새 Blob으로 교체 |
| expired 이력 + 파일 다시 선택 | expired 이력 + 새 retained/queued | 원래 이력은 보존하고 새 QueueEntry를 대기열 맨 위에 추가 |
| retained 항목 삭제/전체 비우기 | 참조 없음 | 최신 상태에 참조가 없을 때만 URL revoke |
| pagehide(비-bfcache)/명시적 세션 종료 | 참조 없음 | 보유한 모든 Blob URL을 멱등 revoke |

## 4. 완료 이력 예산

- 완료 이력만 참조하는 고유 Blob 원본은 최근 **5개**까지 유지한다.
- 그 합계는 **256 MiB**를 넘지 않는다.
- 현재 곡과 대기열이 참조하는 원본은 개수·바이트 예산에서 제외하고 절대 자동 revoke하지 않는다.
- 같은 Blob URL을 여러 이력 항목이 공유하면 하나의 원본으로 계산하고 모두 유지하거나 모두 만료한다.
- 최신 완료 시각(`createdAt`, 동률이면 이력 내 최신 위치)부터 유지한다.
- 크기를 알 수 없는 구버전 원본은 256 MiB로 계산한다. 알 수 없음을 0바이트로 취급해 무제한 유지하지 않는다.
- 예산 계산은 순수 함수다. 상태 변경과 `URL.revokeObjectURL` I/O를 같은 React updater 안에서 수행하지 않는다.

## 5. 탭 간 동기화 계약

`blob:` URL은 만든 탭의 페이지 수명에만 속하므로 공유 저장소의 재생 근거가 아니다.

1. `localStorage`에는 retained queue/history를 expired 메타데이터로 투영한다. Blob URL 자체는 저장하지 않는다.
2. 저장 이벤트를 받은 탭은 공유 가능한 YouTube·OBS 자산·설정 순서를 받아들인다.
3. 수신 목록의 같은 `entryId`가 expired여도, 이 탭이 retained Blob을 갖고 있으면 로컬 항목이 이긴다.
4. 수신 목록에 빠진 이 탭 소유 Blob 항목도 원래 인덱스에 가깝게 다시 삽입한다.
5. `currentEntry`와 active run은 기존 계약대로 탭 로컬이며 절대 가져오지 않는다.

이 계약은 여러 Speaker 탭을 막지 않는다. 각 탭은 같은 메타데이터에 자기 파일을 다시 연결할 수 있고, 한 탭의 설정 변경이 다른 탭의 실제 재생 파일을 제거하지 않는다.

## 6. UI 계약

- expired 대기열 행은 비활성 재생 버튼 대신 **파일 다시 선택**을 주 행동으로 표시한다.
- expired 이력 행도 일반적인 “다시 추가 불가” 툴팁 대신 **파일 다시 선택**을 표시한다.
- 파일 형식·200 MiB 제한은 일반 파일 추가와 동일하다.
- 대기열 복구는 기존 entryId와 위치를 유지한다.
- 이력 복구는 곡을 몰래 재생하지 않고 대기열 맨 위에 새 항목으로 추가한다.
- 새 문구는 한국어·영어 semantic key를 동시에 추가한다.
- 예산 만료는 정상적인 장기 정리이므로 반복 토스트를 띄우지 않는다. 사용자가 해당 행을 볼 때 필요한 행동이 보이면 충분하다.

## 7. 불변식

1. 현재 재생 또는 대기열 Blob은 자동 만료·revoke하지 않는다.
2. revoke 직전 최신 state 전체에서 같은 src 참조가 0개인지 다시 확인한다.
3. expired 항목은 `isPlayableSongDef`를 통과하지 않는다.
4. expired 항목의 메타데이터와 entryId는 보존한다.
5. 한 src를 공유하는 이력은 부분 만료하지 않는다.
6. 다른 탭의 저장 이벤트가 이 탭 소유 Blob queue/history를 지우지 않는다.
7. 이 기능은 Worker 요청, WebSocket 메시지, OBS route 명령을 추가하지 않는다.
8. 메모리 정리 실패는 재생·출력 전환을 막지 않는다.

## 8. Before / After와 2차 영향

### Before

- 로컬 파일을 많이 완주하면 이력의 `blob:` 참조가 창을 닫을 때까지 모두 남는다.
- 다른 탭이 설정을 저장하면 원래 탭의 로컬 queue/history가 수신 병합에서 사라질 수 있다.
- 새로고침 뒤에는 로컬 곡 자체를 목록에서 지워 제목과 복구 위치도 잃는다.

### After

- 현재/대기열은 계속 재생 가능하고, 완료 이력 캐시만 5개·256 MiB로 제한된다.
- 장기 이력은 가벼운 메타데이터로 남고 파일 다시 선택 행동을 제공한다.
- 다른 탭의 쓰기는 로컬 파일 재생을 끊지 않는다.

### 2차 영향과 방어

- **잘못된 파일 재선택:** 사용자가 명시적으로 고른 파일만 연결하고 자동 파일 추측은 하지 않는다.
- **예산 정리와 즉시 재대기열 경합:** 상태 적용 뒤에도 src가 다시 참조되면 pending revoke를 취소한다.
- **중복 이력:** 같은 src 그룹을 원자적으로 만료해 일부 행만 죽은 URL을 가리키지 않게 한다.
- **저장 payload 증가:** 원본 바이트나 Blob URL은 저장하지 않고 작은 메타데이터만 유지한다.
- **다른 탭의 placeholder:** 실제 파일이 없는 사실과 복구 행동을 그대로 보여 주며, 재생 가능하다고 가장하지 않는다.

## 9. 검증 관문

- 순수 함수: 개수 한도, 바이트 한도, unknown 크기, 동일 src 그룹, current/queue 보호, 입력 불변성.
- 스키마: expired 항목은 queue/history에서 보존되지만 playable은 아님.
- 탭 병합: 공유 목록 변경을 받으면서 로컬 Blob entryId·순서·src 유지.
- UI: queue/history에 번역된 파일 다시 선택 행동, 복구 뒤 재생 가능한 Blob 항목.
- 장시간: 500회 Speaker↔OBS 전환 테스트와 별개로, 이 정리는 route/Worker 호출 0개임을 정적·동적 테스트로 확인.
- 전체 테스트, lint, production build, OBS 정적 번들 예산, 320px UI overflow를 통과해야 배포한다.

## 10. v0.2.8 구현·검증 결과

- 대기열과 현재 재생이 참조하는 Blob은 예산 정리 대상에서 제외한다.
- 완료 이력만 참조하는 Blob은 최신 5개·합계 256 MiB 안에서만 유지하며, 같은 Blob을 공유하는 이력은 전부 유지하거나 전부 만료한다.
- 저장소와 다른 탭에는 `blob:` URL을 쓰지 않고 만료된 메타데이터만 전달한다. 현재 탭이 실제 Blob을 가진 항목은 다른 탭의 placeholder/삭제 이벤트로 덮어쓰지 않는다.
- 만료된 대기열과 이력에는 번역 가능한 `파일 다시 선택`을 표시한다. 대기열 복구는 같은 위치를 유지하고, 이력 복구는 원래 기록을 남긴 채 새 항목을 대기열 맨 위에 추가한다.
- 신규 Blob은 페이지 소유 목록으로 추적한다. 정리는 최신 상태에서 참조가 없다는 사실이 확인된 뒤에만 수행하며, 고정 지연시간으로 재생 파일을 추측해 해제하지 않는다.
- 브라우저 복구 smoke: 대기열·이력 복구 성공, localStorage의 Blob URL 0개, Worker 요청 0개, 320px 문서 너비 320px, Dashboard 이탈 시 생성 Blob 2/2 해제.
- 출력 전환 soak: 로컬 Speaker↔OBS 500회 왕복에서 잠금·watchdog·소켓 소유자·미디어 명령 누적 0개.
- 1,000곡 이력: 첫 열기 276.9ms, 반복 상호작용 p95 47.6ms, 닫은 뒤 GC heap 증가 210,564B, 320px overflow 0.
- 전체 자동 테스트 650/650, production build, OBS 정적 번들 382,301B raw / 116,109B gzip, 로컬 운영 화면 320/375/768/1100px 검증을 통과했다.
