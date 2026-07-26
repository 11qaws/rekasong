# Prepare 워커 즉시 기상 프로토콜

> 목표: 앱이 열리거나 새 곡이 준비 큐에 들어오면 Oracle 준비 워커가 유휴
> polling의 최대 30초를 기다리지 않고 즉시 작업을 확인한다. 앱과 작업이 없을
> 때에는 기존 적응형 polling으로 돌아가 Cloudflare 호출 예산을 지킨다.

## 1. 사용자 시나리오와 완료 조건

1. 사용자가 Rekasong 앱을 연다.
2. 앱은 세션을 새로 만들지 않고 `POST /v1/prepare/activity`를 한 번 보낸다.
   이 요청은 음악 재생·OBS 연결·송출을 시작하지 않는다.
3. `PrepareQueue`는 hibernatable WebSocket으로 연결된 Oracle 준비 워커에
   `prepare.wake` 프레임을 보낸다.
4. 준비 워커는 진행 중인 유휴 대기를 즉시 끝내고 `/v1/prepare/claim`을 호출한다.
5. 앱이 열린 뒤 나중에 곡을 등록해도 `enqueue()`가 같은 기상 프레임을 보내므로
   다음 polling 시각을 기다리지 않는다.
6. 앱이 닫히고 새 작업도 없으면 추가 활동 프레임이 생기지 않는다. 워커는
   `5→10→20→최대 30초` 유휴 polling으로 자동 복귀한다.

완료 기준:

- 정상 기상 채널에서 앱 활동 또는 enqueue부터 첫 claim까지 목표 2초 이내.
- 기상 채널이 끊겨도 기존 polling으로 최대 30초 안에 작업을 발견.
- 앱 유휴 상태에서 주기적인 활동 HTTP heartbeat를 새로 만들지 않음.
- 실제 곡·OBS·방송·녹화를 자동 시작하지 않음.

## 2. 상태의 단위

### 앱 활동 신호

| 상태 | 의미 | 다음 이벤트 |
|---|---|---|
| `unsent` | 이번 화면 수명에서 아직 신호를 보내지 않음 | mount/pageshow/online |
| `sending` | 세션 생성 없이 활동 요청 진행 중 | success/failure/unmount |
| `sent` | 최근 활동 신호가 전달됨 | 60초 뒤 pageshow/online에서 재전송 가능 |
| `fallback` | 신호 실패. 사용자 기능은 막지 않음 | 다음 명시적 복귀 이벤트에서 재시도 |

앱은 타이머 heartbeat를 보내지 않는다. 같은 화면 수명에서 `pageshow`,
`online`, visible 복귀가 발생해도 60초 cooldown 안에서는 중복 전송하지 않는다.

### Oracle 기상 채널

| 상태 | 의미 | 다음 이벤트 |
|---|---|---|
| `disabled` | 라이브러리/설정 부재. polling만 사용 | 서비스 재시작 |
| `connecting` | Worker WebSocket 연결 시도 | open/failure/stop |
| `connected` | 신호 수신 가능. Cloudflare DO는 유휴 시 hibernate 가능 | wake/close/stop |
| `retry_wait` | 연결 실패 후 1→2→4→8→최대 30초 재연결 대기 | timeout/stop |
| `stopped` | 서비스 종료 | 없음 |

### 유휴 claim

| 현재 상태 + 이벤트 | 다음 상태/행동 |
|---|---|
| 어떤 유휴 단계 + `prepare.wake` | backoff reset, sleep 중단, 즉시 claim |
| 어떤 유휴 단계 + WebSocket `open` | backoff reset, 즉시 claim |
| 빈 claim | 5→10→20→최대 30초 대기 |
| 실제 job claim | backoff reset, 기존 다운로드·업로드 처리 |
| WebSocket 단절 | polling은 중단하지 않고 재연결 병행 |

## 3. API와 인증

### 앱 활동

```http
POST /v1/prepare/activity
```

- 작업을 만들거나 상태를 바꿀 권한이 없는 비권위 힌트다. 새 세션을 만들지 않아
  Speaker 첫 화면의 lazy loading과 무연결 재생 계약을 보존한다.
- `PrepareQueue`는 앱 활동 기상을 전역 30초에 한 번으로 합쳐 반복 요청이
  Oracle claim을 계속 깨우지 못하게 한다. 마지막 기상 시각은 연결된 워커의
  WebSocket attachment에 기록해 Durable Object가 hibernate해도 제한을 유지한다.
- 본문과 사용자 입력은 받지 않는다.
- 성공은 `204 No Content`.
- 실패해도 플레이어 UI를 잠그지 않는다. 실제 prepare 요청과 30초 fallback이
  계속 동작한다.

### 준비 워커 WebSocket

```http
GET /v1/prepare/wake
Upgrade: websocket
Authorization: Bearer {PREPARE_TOKEN}
```

서버 프레임:

```json
{
  "type": "prepare.wake",
  "version": 1,
  "reason": "connected | app_active | job_enqueued",
  "sentAt": 0
}
```

- `PrepareQueue`가 서버이고 Oracle 워커가 아웃바운드 클라이언트다.
- `ctx.acceptWebSocket()`을 사용해 Durable Object가 유휴 중 hibernate한다.
- 여러 준비 워커가 연결돼도 모두 깨울 수 있다. 실제 claim은 기존 DO 원자성으로
  한 워커만 가져간다.

## 4. 불변식

1. 기상 프레임은 작업의 `queued/preparing/ready` 상태를 직접 바꾸지 않는다.
2. `ready`는 여전히 R2 바이트가 실제 존재할 때만 확정한다.
3. 앱 활동 요청은 작업을 만들 수 없는 bounded hint다. enqueue/status는 유효한
   player token, 워커 연결·claim은 `PREPARE_TOKEN` 없이는 허용하지 않는다.
4. 중복 기상 프레임은 generation 기반 `threading.Condition`으로 합쳐지며 중복 claim은
   PrepareQueue의 원자적 claim이 흡수한다.
5. WebSocket 의존성이 없거나 연결이 끊겨도 준비 서비스는 종료되지 않는다.
6. 기상 프로토콜은 오디오 재생, OBS 소스 활성화, 방송 시작을 호출하지 않는다.
7. 토큰·room 원문과 WebSocket Authorization 값은 로그에 남기지 않는다.

## 5. 관측과 장애 복구

- VPS 시작 로그: 프로토콜 버전, 기상 채널 활성 여부, fallback polling 범위.
- 연결 전이 로그: `connected`, `closed`, 재연결 지연. 동일 오류 반복은 매
  polling tick마다 기록하지 않는다.
- 기상 로그: reason과 수신 횟수만 기록하며 토큰·URL query는 기록하지 않는다.
- 배포 검증: 가짜 세션 활동 요청만 보내 VPS의 빈 claim 시각을 측정한다.
  실제 YouTube 다운로드와 OBS 송출은 시작하지 않는다.
