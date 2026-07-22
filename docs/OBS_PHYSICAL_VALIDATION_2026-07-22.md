# Rekasong 실제 OBS 인수 검증 기록 — 2026-07-22

> 실행 위치: `D:\Agents\rekasong\Codex\workspace`
>
> 공개 앱: [https://11qaws.github.io/rekasong/](https://11qaws.github.io/rekasong/)
>
> 검증한 프런트엔드: `0.2.13` / `a71bf0dca91981040ed14c7e3303fba09dcb6e11`
>
> 추가 source refresh·OBS 재시작 복구: `0.2.19` / `187224c0a77f28a33b3a2024e0914773a66386f0`
>
> 추가 scene 전환 harness 배포: `0.2.20` / `b70d5b6e408a9fd5fe6379567b28a2eed3a25bfb`
>
> 추가 활성 곡 control-gap 검증: `0.2.24` / `ba92170f46dc6142ea9720cdfa276d2da2625737` 공개 배포·실제 OBS 통과
>
> Production Worker: `9dd91fc4-81e1-45a8-9d15-e7250e4a3496`
>
> OBS: `30.2.0`, 전용 profile·scene collection `Rekasong_Local_Record_Test_20260722`

## 1. 결론

- 실제 방송은 시작하지 않았다. OBS 로그의 `Streaming Start`와 `Streaming Stop`은 모두 **0건**이다.
- 사용자 허용 범위인 **로컬 녹화만** 사용했다. 검증 녹화에는 앱이 만든 기준 PCM이 AAC 48 kHz stereo 트랙으로 들어갔다.
- 공개 앱은 정확한 On-Air player 한 개를 찾아 `OBS 송출 중`으로 전환했고, 앱 재생 증거 G2와 OBS mixer 확인 G3-user를 별도로 표시·저장했다.
- OBS에서 재생 중이던 곡을 Speaker로 바꾸어도 같은 곡과 재생 위치가 이어졌다. 전환 확인을 위해 기존 OBS 출력을 먼저 끊어서 새 Speaker 출력을 막는 문제는 재현되지 않았다.
- Speaker 최종 상태는 일반 웹 플레이어 모드다. 설정을 닫은 상태에서 `스피커 송출 중`만 표시되며, 곡을 재생하지 않을 때 Worker session 연결을 만들지 않는다.
- 플랫폼으로 실제 전송된 결과물 G5는 의도적으로 검증하지 않았다.
- 라이브 마이크↔MR G6는 전용 분리 track과 물리 스피커·FIFINE 마이크로 10분까지 실행했다. 60/60 marker와 낮은 jitter는 확인했지만, 현재 장치 조합의 상대 drift가 허용치를 넘었으므로 **G6 통과로 판정하지 않는다**.
- 공개 v0.2.19 OBS player의 302.5초 곡을 빈 장면으로 10초 전환했다가 복귀해도 동일 player·connection·run이 유지됐고 wall 오차 `84ms`로 자연 종료했다. 30초 관측은 기록 전용이며 곡 중 재생 위치나 속도를 보정하지 않는다.
- v0.2.24 실제 control-gap run은 활성 곡 중 Dashboard 제어 socket만 끊어도 같은 coordinator·player·run이 유지되고 media timeline이 계속 전진하며, 복구 뒤 명시적 pause/play/stop이 다시 적용됨을 확인했다.

### 1.1 장면 전환 연속성 추가 검증 — 2026-07-23

- 전용 `Rekasong_Local_Record_Test_20260722` collection의 `Scene`과 빈 `Scene 2`만 사용했다. `Shutdown source when not visible=false`, `Refresh browser when scene becomes active=false`, `Control audio via OBS=true`였다.
- `sourceActive=false`를 10초 유지하는 동안 player 수는 1, 기존 lease target과 active run은 그대로였다. 이때 inactive source가 새 activation 후보에서 제외돼 candidate 수가 0인 것은 정상이다. 복귀 뒤 `sourceActive=true`를 5초 유지했고 같은 connection ID를 확인했다.
- 최종 run은 `302,584ms / 기대 302,500ms / 오차 84ms`, candidate transition 0, unsafe route 0, session 종료 뒤 HTTP 410이었다. 앞선 두 run도 오차 `97ms`, `31ms`로 곡을 자연 종료했다.
- 한 앞선 run의 control WebSocket 순간 단절에서도 OBS media graph는 계속 재생됐다. 최종 합격 run에는 client socket-close 진단과 재접속 시도가 없었다. 기존 raw disconnect counter 1은 `end_session` 뒤 정상 close까지 집계한 계측 오류였고, 정상 terminal close를 제외하도록 수정했다.
- 세 run 모두 `Start Streaming`·`Start Recording` 버튼과 두 타이머 `00:00:00`을 매번 확인했다. 실제 방송·녹화는 시작하지 않았다. 각 run 뒤 Browser Source URL을 백업으로 복원하고 임시 credential 파일을 제거했다.

### 1.2 활성 곡 control socket 단절·복구 — 2026-07-23

- 실제 OBS 30.2.0 안전 모드와 전용 `Rekasong_Local_Record_Test_20260722 / Scene / Browser`에서 production Worker·공개 player·15초 생성 WAV를 사용했다. `Control audio via OBS=true`, visible Browser source 1개 조건을 교체 도구가 먼저 검증했다.
- 최초 PLAY 후 media가 실제 advancing인 상태에서 유일한 Dashboard control WebSocket에 close `4101`을 요청했다. client close event는 Cloudflare 경로에서 `1006 / wasClean=false`로 관측됐지만 OBS player·media socket은 닫히지 않았다.
- coordinator factory는 `1`, control socket은 `1→2`, 추가 connect는 정확히 `1`이었다. disconnect/retry는 `1/1`, 최대 gap은 `1,118ms`, retry부터 READY까지 `740ms`였다. 같은 player ID·entry/run·audible lease를 복구했고 position은 `0→3.322594s`로 전진했다.
- 복구 중 자동 activate/deactivate/emergency/load/play/pause/seek/volume/stop delta는 모두 `0`이었다. 늦은 Dashboard timer도 `already_ready`로 끝나 새 coordinator/socket/command를 만들지 않았다.
- 복구 뒤 명시적 PAUSE→PLAY→STOP을 같은 run에 보내 실제 상태 변화를 확인했다. output deactivate와 end session 뒤 session status는 HTTP 410이었다.
- 첫 run은 동작 결함이 아니라 검증기가 요청 close code와 관측 close code의 일치를 강제한 탓에 실패했다. 요청·관측을 분리하도록 고친 뒤 전체 시나리오를 처음부터 다시 실행해 통과했다. 두 run 모두 정리 후 원본 URL을 exact match로 복원했다.
- 시험 전후 UI는 `Start Streaming`·`Start Recording`, 두 타이머 `00:00:00`이었다. 최종 로그 `2026-07-23 07-20-44.txt`의 Streaming/Recording Start·Stop은 모두 0이고 clean shutdown은 1회다. 원본 URL은 214자·SHA-256 `e654020bc4e70f0faf7bc5f5e5bf8672891ad461126030ecd254093873e07a2d`로 exact 복원됐고 handoff는 제거됐다. 실제 방송·녹화는 시작하지 않았다.

## 2. 안전 경계와 방송 OFF 증거

시험 전후 OBS에 `Start Streaming` 버튼이 보였고 `Stop Streaming` 버튼은 없었다. stream timer는 `00:00:00`이었다. 마지막 상태에는 `Start Recording` 버튼도 보여 방송과 녹화가 모두 꺼져 있었다.

현재 OBS 로그 `C:\Users\Qumin\AppData\Roaming\obs-studio\logs\2026-07-22 13-45-46.txt`의 이벤트 수는 다음과 같다.

| 이벤트 | 건수 |
|---|---:|
| `Streaming Start` | 0 |
| `Streaming Stop` | 0 |
| `Recording Start` | 8 |
| `Recording Stop` | 8 |

이번 인수 증거로 사용한 로컬 녹화 구간은 다음과 같다.

```text
20:39:43.541  Recording Start
20:39:43.542  Writing file C:/Users/Qumin/Videos/2026-07-22 20-39-43.mkv
20:40:38.004  file output stopped
20:40:38.005  Recording Stop
```

시험 코드와 앱에는 OBS의 방송 시작·종료 명령이 없다. 스트림 키가 구성돼 있어도 이번 검증에서는 `Start Streaming`을 클릭하거나 호출하지 않았다.

## 3. OBS source 구성

전용 시험 profile·scene collection만 사용했으며 기존 방송 profile `제목 없음`과 scene collection `My`는 수정하지 않았다.

Browser Source `Browser`의 확인된 설정은 다음과 같다.

| 항목 | 값 |
|---|---|
| URL | 공개 앱이 현재 세션에 발급한 On-Air player URL과 일치 |
| Local file | 해제 |
| Control audio via OBS | 체크 (`reroute_audio: true`) |
| Shutdown source when not visible | 해제 (`shutdown: false`) |
| Refresh browser when scene becomes active | 해제 (`restart_when_active: false`) |

앱 설정 화면은 이 source를 `OBS 플레이어 정상 · 1개 연결됨`으로 판정했다. 선택 경로와 서버가 확인한 실제 활성 경로는 모두 `OBS 방송`이었다.

## 4. G2 — 앱 player가 실제 기준 신호를 재생

공개 앱의 `OBS 오디오 점검`에서 8초 결정적 PCM 검사를 실행했다.

- UI 결과: `앱 플레이어 신호 재생 완료 · G2 확인`
- 실제 player 상태: `PLAYING · test_started`
- 진행 marker: 16개
- 신호 구조: 2초 간격 4 cycle, 각 cycle에 880 Hz pulse 3개와 440 Hz long tone 1개

이 단계는 같은 media graph가 재생됐다는 증거다. OBS mixer 입력이나 녹화·방송 성공으로 승격하지 않는다.

## 5. G3 — 정확한 OBS mixer 입력 확인

G2 신호가 재생되는 동안 전용 OBS source의 mixer meter가 움직이는 것을 확인했다. 공개 앱에서 `미터가 움직여요`를 선택해 현재 room·player·check에 묶인 G3-user 기록을 저장했다.

새로고침 뒤 OBS를 다시 선택해도 다음 문구와 확인 시각이 유지됐다.

```text
이 OBS 플레이어의 믹서 입력을 사용자가 확인했습니다.
사용자 확인 시각: 2026. 7. 22. 오후 9:05
```

이 기록은 route를 바꾸거나 재생을 막지 않는다. OBS mixer 입력 확인일 뿐, 실제 플랫폼 송출이나 마이크 상대 싱크 증거가 아니다.

## 6. G4 — 로컬 녹화 artifact의 PCM 분석

검증 파일은 저장소에 포함하지 않고 사용자 로컬 영상 폴더에 보존했다.

```text
파일: C:\Users\Qumin\Videos\2026-07-22 20-39-43.mkv
SHA-256: 0EF330FD650AAA578649F726652F1B1A2E585D826C706665B03B716FFF3AFB5A
크기: 16,991,249 bytes
길이: 54.033 s
영상: H.264, 1280x720
오디오: AAC, 48,000 Hz, stereo
```

오디오 트랙 분석 결과:

- 첫 신호 시작: 약 13.7096초
- audible group: `13.7096–14.5492`, `15.7003–16.5492`, `17.7002–18.5491`, `19.7002–20.5491`
- cycle 간격: 약 `2.00`, `1.99`, `2.00`초
- pulse 주파수: 80 ms FFT 창의 가장 가까운 bin에서 `875–875.2 Hz`로 관측되어 880 Hz 기준과 일치
- long tone: 각 cycle에서 `440.0 Hz`
- marker: 16/16 검출
- marker RMS 범위: `-15.855`~`-15.126 dBFS`
- stereo correlation: `1.0`
- 좌우 채널 차이: `0.0 dB`

따라서 앱의 기준 PCM이 OBS Browser Source와 OBS audio mixer를 지나 실제 로컬 녹화 트랙까지 도달했다. 이 결과는 G4이며 플랫폼 ingest 결과 G5는 아니다.

## 7. G6 — 물리 마이크↔MR 10분 분리 track

### 7.1 측정 구성

- OBS monitoring device: `Speakers (High Definition Audio Device)`
- 마이크: `Microphone (FIFINE K670 Microphone)`
- Browser Source: track 1·2, `Monitor and Output`, sync offset `0 ms`
- 마이크 source: track 1·3, `Monitor Off`
- 녹화: MKV, 48 kHz stereo, track 1=혼합, track 2=MR 직접 신호, track 3=물리 마이크
- fixture: 600.024초 MP3. 10초마다 880 Hz 짧은 pulse 3개와 440 Hz 400 ms tone 1개, 총 60 cycle

초기에는 OBS monitoring device가 실제 스피커와 일치하지 않거나 물리 스피커가 꺼진 상태의 녹화도 있었다. 이 파일들은 track 2에만 기준 신호가 있고 track 3 마이크에 대응 신호가 없어 지연 증거로 사용하지 않았다. 이후 monitoring device를 명시하고 스피커를 켠 뒤, **OBS가 낸 소리를 실제 FIFINE 마이크가 다시 받은 경로**만 판정에 사용했다.

### 7.2 짧은 물리 루프 기준선

```text
파일: C:\Users\Qumin\Videos\2026-07-22 21-38-03.mkv
SHA-256: 02F1DC22810200186E60993261862F1FBFD5A70BDC49FC169626E2C4299ED112
크기: 4,212,573 bytes
길이: 11.766 s
오디오: AAC, 48,000 Hz, stereo, 3 tracks
```

- 4/4 cycle 검출, 누락 0
- 440/880 Hz 결합 envelope의 마이크 지연: 전 cycle `68.5 ms`
- cycle별 correlation: `0.98445–0.98550`
- 440 Hz rise/fall edge 지연 평균 `68.938 ms`, 표준편차 `0.177 ms`, 범위 `0.5 ms`

이 결과는 물리 스피커→공기→마이크 경로가 실제로 녹화됐고 짧은 구간에서는 반복성이 높다는 기준선이다.

### 7.3 10분 연속 실행 artifact

```text
파일: C:\Users\Qumin\Videos\2026-07-22 21-55-45.mkv
SHA-256: FE05D2CBBA26BA0582B95D4FB7D88B013AD98601274BAD69578DC1DCE5554E7C
크기: 227,973,702 bytes
길이: 640.666 s
오디오: AAC, 48,000 Hz, stereo, 3 tracks
OBS Recording Start: 21:55:45.684
OBS Recording Stop: 22:06:26.770
```

앱의 실제 `내 MR 파일 추가`와 `즉시 재생` 흐름을 사용했다. 곡은 10분 fixture 끝에서 자연 종료됐고 재생 중 route 교체·restart·seek·강제 정지는 없었다.

| 항목 | 실측 | 수용 기준 | 판정 |
|---|---:|---:|---|
| marker | 60/60, 누락·중복 0 | 60/60 | 통과 |
| MR 자체 시간축 | 590초 구간에서 `+9.0 ms` | 연속 재생, marker 누락 0 | 통과 |
| 결합 envelope correlation | 최소 `0.94889`, 중앙값 `0.97760` | marker 식별 가능 | 통과 |
| detrended jitter p95 | `1.832 ms` | `≤ 5 ms` | 통과 |
| 440 Hz edge jitter p95 | `1.417 ms` | `≤ 5 ms` | 통과 |
| 첫 5 cycle↔마지막 5 cycle 중앙값 drift | `15.5 ms` | `≤ 10 ms / 10분` | **실패** |
| 선형 회귀 drift | `17.32 ms / 590초` (`1.7613 ms/min`) | `≤ 10 ms / 10분` | **실패** |
| 440 Hz edge 선형 drift | `17.996 ms / 590초` | `≤ 10 ms / 10분` | **실패** |
| 중앙 offset | `43.25 ms` | 보정 후 `±20 ms` | **실패** |

따라서 기존 10분 G6 기준으로는 **측정 완료·수용 실패**였다. 앱/OBS의 MR 시간축과 established media graph는 안정적이었지만, 현재의 온보드 스피커 출력과 별도 USB 마이크 입력은 서로 다른 하드웨어 clock을 사용한다. 관측된 누적 상대 drift는 이 물리 monitoring chain의 clock 차이와 일치하며, 앱 연결 검사로 해결하거나 route를 끊어야 할 종류의 문제가 아니다.

이후 제품 수용 단위는 실제 최대 곡 길이인 5분으로 정리했다. 곡마다 새 `runId`와 `position: 0`으로 기준점을 다시 잡고 OBS route는 유지한다. 5분 창은 아래처럼 기존 60-cycle artifact에서 직접 재분석했다. 중앙 offset `43.25ms`는 여전히 현재 물리 monitoring 경로의 시작 offset 기준을 넘으므로 같은-clock 또는 실제 헤드폰 경로에서 다시 측정해야 한다.

### 7.4 5분 곡 창 직접 재분석

재현 도구는 `scripts/analyze-obs-karaoke-window.py`다. 10초 주기의 5분 창은 구간이 30개지만 시작 `0초`와 끝 `300초`를 모두 직접 포함하려면 marker가 **31개** 필요하다. 초기 분석의 30개/290초 창은 마지막 10초를 추정하게 만드는 off-by-one이었으므로 폐기했다. 기존 녹화에는 0~300초 endpoint가 모두 있어 재녹화 없이 직접 판정할 수 있었다.

```powershell
python scripts/analyze-obs-karaoke-window.py `
  "C:\Users\Qumin\Videos\2026-07-22 21-55-45.mkv" `
  --ffmpeg "D:\Downloads\open-video-downloader\ffmpeg.exe" `
  --sample-rate 16000
```

| 항목 | 16 kHz | 8 kHz 교차 확인 | 판정 |
|---|---:|---:|---|
| endpoint-inclusive marker | 31개 / 300초 | 31개 / 300초 | 직접 관측 |
| 첫 5분 edge drift | `8.943 ms` | `8.954 ms` | 통과 |
| 마지막 5분 edge drift | `5.753 ms` | `5.781 ms` | 통과 |
| 모든 rolling 5분 중 최악 edge drift | `9.753 ms` | `9.825 ms` | `≤10 ms`, 통과 |
| 모든 rolling 5분 중 최악 linear-fit drift | `10.408 ms` | `10.428 ms` | `0.408–0.428 ms` 초과 |
| 30초 상대 변화 중앙값 / p95 / 최악 | `1.047 / 2.486 / 3.471 ms` | `1.083 / 2.483 / 3.485 ms` | 관찰값 |
| 중앙 fixed offset | `43.262 ms` | `43.234 ms` | `±20 ms`, 실패 |

두 해상도의 결과가 거의 같아 분석 재현성은 확인됐다. 직접 edge 통계는 기준 안이지만 전체 endpoint 자료의 선형 적합이 약 `0.4ms` 넘으므로 현재 장치 조합을 확실한 G6 통과로 승격하지 않는다. 판정은 **5분 drift 경계·재검 필요, 시작 offset 실패**다.

30초 값은 동기 보정 명령이 아니라 관찰 cadence다. 이 녹화에서 30초 동안의 실제 상대 변화는 p95 약 `2.5ms`였으므로 매번 seek·restart·playback-rate를 바꾸면 drift보다 측정 jitter를 따라갈 가능성이 크다. 앱은 곡 시작에서만 기준점을 새로 잡고, 곡 중 30초 관찰은 route와 media graph를 바꾸지 않는다.

OBS Browser Source에 `+69 ms` sync offset을 넣은 비교 녹화(`2026-07-22 21-45-35.mkv`)에서는 상대 마이크 지연이 약 `82–84 ms`로 더 커졌다. 이 offset은 MR과 마이크 사이의 물리 clock drift를 고치지 못하므로 `0 ms`로 복원했다. 자동 보정값으로 사용하지 않는다.

다음 G6 재검증은 입력·출력이 같은 audio clock을 공유하는 장치 또는 별도의 저지연 performer monitoring 경로에서 endpoint-inclusive 31-marker 5분 fixture와 짧은 반복 시험으로 수행한다. 점검 결과는 설정 안내로만 제공하고, 실패·미측정·일시적인 telemetry 손실을 이유로 이미 연결된 OBS route나 재생을 중단하지 않는다.

## 8. OBS → Speaker 재생 중 전환

120초 저레벨 시험음을 임시 업로드해 OBS에서 실제 재생한 뒤, 재생 중 Speaker로 전환했다.

관측 순서:

1. OBS 상태에서 같은 곡이 `0:12`, 이후 `0:22`로 진행했다.
2. Speaker를 선택했다.
3. UI가 즉시 `스피커 송출 중`, `실제 활성: 스피커`로 바뀌었다.
4. 같은 곡이 `0:47`, 이후 `1:16`으로 계속 진행했다.
5. 곡이 0초로 되돌아가거나 현재 곡이 사라지지 않았다.
6. Speaker → OBS → Speaker 재선택도 잠기지 않고 완료됐다.

이 시험은 “전환 검증이 새 경로를 역으로 막지 않는다”와 “같은 재생 run을 보존한다”를 증명한다. 다만 수동 UI 관측이므로 sample-accurate 전환 지연이나 순간적인 오디오 gap 길이를 측정한 결과는 아니다.

## 9. 자동 회귀·성능 증거

검증한 공개 코드에서 다음을 다시 실행했다.

| 검증 | 결과 |
|---|---|
| 전체 테스트 | `674/674` 통과 |
| lint | 오류 0, 기존 `functions/api/gemini.js` 경고 2개 |
| production build | 통과 |
| OBS bundle budget | raw `382,809 B`, gzip `117,317 B`, brotli `102,792 B` 통과 |
| 공개 Dashboard smoke | Speaker 기본값, KO/EN, YouTube 구조, 320/375/768/1100 px 통과 |
| 곡 click/drag | 클릭→상세, 취소 0 mutation, history drop 1건·재생 0건 통과 |
| 1,000곡 history | 최대 mount 100, warm p95 `29.7 ms`, heap 증가 `0 B` |
| Speaker network 분리 | idle/local/search에서 session HTTP·socket·frame 모두 0 |
| 로컬 파일 | 잘못된 파일 복구, queue/history 복원, Blob URL 비영속, Worker 요청 0 |

공개 앱 cold 측정은 DCL `545.8 ms`, load `546.0 ms`, 전송량 `283,461 B`, long task 1건(`72 ms`)이었다. warm 측정은 DCL `25.7 ms`, load `26.2 ms`, long task 0건이었다. 사용 중 JS heap은 약 `7.96 MB`였다.

[GitHub Pages workflow `29912724691`](https://github.com/11qaws/rekasong/actions/runs/29912724691)은 commit `a71bf0d`에서 성공했다. 공개 entry asset `assets/index-BrYVxm8V.js`는 workflow artifact와 byte-for-byte 일치했고 SHA-256은 `BBA72C89CA1A653D12351DAE7C8D845E6E38646111807DDC8468360F872775E4`였다.

## 10. 사용자 관점 판정

### 지금 확실히 사용할 수 있는 것

- 앱을 열면 복잡한 방송 연결 없이 Speaker 웹 플레이어로 시작한다.
- Speaker는 다른 탭의 존재나 Worker 연결 증거 때문에 차단되지 않는다.
- 로컬 MR은 Speaker에서 서버 업로드 없이 바로 재생한다.
- OBS를 명시적으로 선택하면 현재 On-Air player 한 개와 연결해 리모컨 명령을 보낸다.
- OBS 연결이 잠깐 흔들려도 연결 검사 자체가 살아 있는 재생을 정지·재시작하지 않는다.
- OBS에서 Speaker로 돌아올 때 새 Speaker 재생을 먼저 확정하고, 늦게 도착한 OBS 응답이 이를 되돌리지 않는다.
- 사용자는 앱 player 신호, OBS mixer 확인, 실제 녹화/방송 결과를 서로 다른 단계로 구분해 볼 수 있다.

### 아직 별도 검증이 필요한 것

- 실제 플랫폼으로 내보낸 비공개 stream/VOD의 오디오 트랙 G5. 이번에는 안전상 의도적으로 실행하지 않았다.
- 현재의 온보드 스피커+USB FIFINE 마이크 조합은 5분 edge 기준은 통과했지만 linear-fit이 약 `0.4ms` 넘고 fixed offset도 실패해 G6 전체 기준을 통과하지 못했다. 같은 clock을 공유하는 입력·출력 또는 저지연 performer monitoring 경로로 다시 측정해야 한다.
- 다른 헤드폰·오디오 인터페이스·monitoring chain의 지연과 drift는 이번 장치 결과로 대신할 수 없다.
- Android/iOS의 화면 잠금·앱 전환·PiP·블루투스 장치 전환은 지원 기기별 수동 검증이 필요하다.

## 11. 최종 상태

- 공개 앱: Speaker 선택, 설정 닫힘, 재생 곡 없음
- OBS: 전용 시험 profile·scene 유지, Browser Source 연결 유지
- OBS 방송: OFF
- OBS 녹화: OFF
- 실제 방송 profile·scene: 미변경
- 임시 시험 음원: 저장소에는 포함하지 않음. 세션 자산은 세션 종료 전까지 서버 정책에 따라 유지

G6 fixture 실행 자체는 끝났지만 현재 물리 장치 조합은 수용 기준을 통과하지 못했다. 다음 단계는 같은 audio clock 장치 또는 저지연 performer monitoring 경로를 설계한 뒤 동일 fixture를 재실행하는 것이다. 실제 플랫폼 G5는 사용자가 명시적으로 비공개 송출을 승인할 때만 수행한다.

## 12. v0.2.19 source refresh·OBS 재시작 복구 추가 검증 — 2026-07-23

- 환경: 공개 v0.2.19, production Worker, OBS 30.2.0 / obs-browser 2.23.5 / Chromium 103, 전용 `Rekasong_Local_Record_Test_20260722` profile·collection.
- 최초·source refresh 후·OBS 정상 재실행 후 player 후보는 각각 하나였고 75초 안정화 동안 candidate transition은 0이었다.
- source refresh와 OBS 재시작 모두 기존 player가 사라진 뒤 서로 다른 새 identity를 만들었다. old run과 desired playing은 `target_disconnected`로 보존됐지만 새 player는 `standby`였고 자동 takeover·LOAD·PLAY하지 않았다.
- 각 변형에서 명시적 full reset ACK 뒤 active run 없음·selected route null·desired stopped로 수렴했다. connected replacement를 명시적으로 다시 선택한 뒤 `output_ready_no_playback`과 5초 무음을 확인했다.
- 최종 evidence: `sourceRefreshCreatedNewPlayer=true`, `obsRestartCreatedNewPlayer=true`, `candidateTransitions=0`, `finalAutomaticPlayback=false`, `finalDesiredTransport=stopped`, session status HTTP 410.
- OBS runtime은 `streaming=false`, `recording=false`였고 UI는 시작 전·재시작 전·종료 후 모두 `Start Streaming`·`Start Recording`, 타이머 `00:00:00`이었다. 해당 구간의 OBS 로그에는 Streaming/Recording Start·Stop이 모두 0건이었다.
- 시험 URL은 실행 전 백업과 exact match로 복원했다. credential handoff는 harness 정리에서 제거했고 OBS는 원래 URL·전용 test profile/scene·방송/녹화 OFF 상태로 다시 열어 두었다.

이 추가 검증은 새 CEF identity가 생기는 refresh·재시작 사고에서 연결 상태를 보존하되 자동 재생하지 않고 사용자의 명시적 복구로 안전하게 돌아오는 것을 증명한다. 플랫폼 ingest G5와 다른 장치의 performer monitoring G6를 대신하지 않는다.

## 13. v0.2.21 최초 OBS 선택 후 source 후발 연결 — 2026-07-23

- 환경: 로컬 production preview `0.2.21`, production Worker, OBS 30.2.0, 전용 `Rekasong_Local_Record_Test_20260722` profile·collection, visible `Browser` source, `Control audio via OBS=true`.
- Dashboard에서 먼저 OBS를 선택하고 player 후보가 없는 상태를 유지했다. UI는 route 실패·완전 초기화·긴급 정지가 아니라 `OBS 플레이어를 열어 주세요`와 자동 계속 조건을 표시했다.
- 같은 선택 의도를 둔 채 Browser Source에 현재 player URL을 넣자 추가 출력 클릭 없이 약 2초 안에 `OBS 송출 중`, `실제 활성: OBS 방송`, `OBS 플레이어 정상 · 1개 연결됨`으로 수렴했다.
- route 활성화만으로 음악이나 점검음은 자동 재생되지 않았다. 현재 곡은 없었고 Dashboard media element는 paused, source 없음, warning/error log 0건이었다. OBS Browser mixer도 무음이었다.
- 시험 중 `Start Streaming`·`Start Recording`과 두 `00:00:00` 타이머를 계속 확인했다. 최종 OBS 로그 `2026-07-23 05-47-04.txt`의 streaming/recording start는 각각 0건이며 clean shutdown marker는 1건이다.
- Browser Source URL은 시험 전 저장한 214자 원본과 exact match로 복원했다. 복사된 session credential은 클립보드에서 폭 값 `800`으로 덮어썼고, OBS와 포트 5014 preview를 모두 종료했다.

이 검증은 “OBS를 먼저 골라도 검사가 스스로 경로 고장을 만들지 않고, 정확한 player가 나중에 나타나면 같은 사용자 의도로 자동 연결된다”는 v0.2.21의 남은 물리 관문을 닫는다. 실제 플랫폼 ingest G5와 사용자 청취, 다른 장치의 performer monitoring G6를 대신하지 않는다.
