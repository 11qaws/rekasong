# WEB ↔ OBS 검증 기록 — 2026-07-18

## 결론

현재 구현은 “Chromium player가 준비 음원을 재생하고 control에 이벤트를 돌려준다”까지는 통과했다. 그러나 “OBS 최종 출력에 들어갔다”와 “마이크 대비 지연·drift가 맞다”는 아직 통과하지 않았다.

## 기준 상태

- Claude frontend/Worker 저장소 기준 커밋: `9b7f98e`
- Codex 독립 사본: `D:\Agents\rekasong\Codex\workspace`
- Claude의 실행 중인 `127.0.0.1:5000` 서버와 파일은 변경·중지하지 않음
- Codex staging build/preview는 별도 `127.0.0.1:5100`에서 실행 후 종료
- staging Worker: `https://rekasong-session.11qaws-test.workers.dev`

## 실행 결과

| 검증 | 결과 | 근거 |
|---|---|---|
| `npm ci` | PASS | 취약점 0 |
| `npm run lint` | PASS | 기존 warning 6건, error 0 |
| `npm run build -- --mode staging` | PASS | Vite build 완료; 500kB 초과 chunk 경고 1건 |
| player/display presence + dashboard reload snapshot | PASS | 두 위젯 연결 상태 즉시 복원 |
| 일반 앱 브라우저 player 재생 | FAIL(예상 가능한 환경 차이) | presence는 true였지만 autoplay가 막혀 `paused=true`; dashboard가 재생 실패로 전환 |
| 자동재생 허용 headless staging smoke | PASS 11/11 | `scripts/obs-staging-smoke.mjs` |
| cold ready 곡 | PASS | Worker `/v1/audio/` streaming, 실제 재생 |
| ready 곡 prefetch | PASS | HTTP 206 완료 후 `blob:` 재생, 전체 duration buffered |
| prefetch 미스 ready 곡 | PASS | Worker streaming fallback, 실제 재생 |
| 10초 media clock | PASS | waiting/stalled/error/backwards 0, wall clock 대비 `-4ms` |
| 실제 player event 왕복 | PASS | playing + position 수신 |
| 실제 OBS source 기본 설정 | 부분 확인 | `Local file` 해제, `Control audio via OBS` 체크 확인 |
| 실제 OBS source mixer 입력 | 부분 확인 | `Rekasong` mixer가 unmuted이고 meter 신호가 보였음 |
| 테스트 세션과 실제 OBS source 페어링 | 미확인 | 기존 OBS source 설정을 변경하지 않음 |
| OBS 최종 녹화 파일의 테스트 신호 | 미검증 | 녹화를 자동 시작하지 않음 |
| 마이크↔MR 고정 지연·10분 drift | 미검증 | loopback/분리 트랙 녹화 필요 |

headless smoke의 마지막 staging 세션은 `end_session` 명령으로 정리했다.

## 확인된 중요한 사실

### 1. 초록 연결 표시는 OBS 증거가 아니다

Worker의 presence는 `role=player` WebSocket 수만 센다. 실제 테스트에서도 일반 브라우저 탭이 `OBS 플레이어 연결됨` 표시를 만들었지만 오디오는 자동재생 차단으로 시작되지 않았다. 현재 문구는 사실보다 강하다.

### 2. “모든 곡 전체 다운로드”는 사실이 아니다

완전 blob은 큐에서 prefetch된 ready YouTube 곡 최대 2개에만 적용된다. 다음은 streaming이다.

- 첫 즉시 재생 곡
- prefetch 완료 전 전환한 곡
- prefetch 대상이 아니었던 ready 곡
- 모든 로컬 오디오·비디오 자산

이번 실측도 cold/fallback은 Worker URL, prefetch hit만 blob으로 나뉘었다.

### 3. 브라우저 시계와 OBS/마이크 싱크는 다른 측정이다

10초 `-4ms` 결과는 Chromium media clock이 매끄럽게 진행했다는 뜻이다. CEF→OBS mixer→program/recording과 실제 마이크 DSP 체인의 고정 지연·resampling drift는 포함하지 않는다.

### 4. 제안된 톤/meter 기능은 아직 구현되지 않았다

저장소에는 test tone, `AudioContext`, `AnalyserNode`, level meter, `들려요/안 들려요`, 점검 완료 기록이 없다. 내부 analyser를 추가해도 OBS 이후를 증명하지는 못하므로 실제 mixer와 녹화 확인을 함께 요구해야 한다.

## 코드 감사에서 발견한 P0

1. player socket close 시 media는 계속 재생할 수 있지만 Worker transport는 paused가 된다. 재접속 snapshot이 실제 `media.pause()`/`play()`를 호출하지 않아 상태가 갈릴 수 있다.
2. 실제 계약에 `runId`와 `playerInstanceId`가 없고 `sessionId=entryId`만 사용한다. 같은 entry retry의 늦은 이벤트를 구분하지 못한다.
3. 같은 session에 player가 여러 개 연결되면 모두 명령을 받고 이벤트가 섞인다. OBS+일반 브라우저 또는 중복 OBS source에서 echo 위험이 있다.
4. On-Air skip은 실제 ended 확인 전에 이전 곡을 completed 처리하고 다음 load를 보낸다.
5. Worker는 load/play/pause 명령만으로 transport를 낙관적으로 바꾸므로 UI 일부가 실제 player event보다 앞설 수 있다.
6. On-Air display projection은 widget이 기대하는 artist/source/phase 일부를 제거한다.

## 재실행

터미널 1:

```powershell
cd D:\Agents\rekasong\Codex\workspace
npm run build -- --mode staging
npm run preview -- --port 5100 --host 127.0.0.1
```

터미널 2:

```powershell
cd D:\Agents\rekasong\Codex\workspace
$env:REKASONG_APP='http://127.0.0.1:5100'
npm run test:obs:staging
```

이 smoke는 Chromium 위젯 계층만 판정한다. 실제 송출 합격은 `docs/OBS_TEST_PLAN.md`의 OBS 녹화 및 마이크↔MR 관문까지 완료해야 한다.
