# OBS 가사 오버레이 acceptance

> 기준일: 2026-08-09
> 이 문서는 자동 검증과 실제 OBS 녹화 검증을 구분한다.

## 1. OBS source 설정

1. Dashboard의 OBS 설정에서 On-Air Player 주소를 준비해 복사한다.
2. OBS에 Browser Source 하나를 만들고 `Local file`을 끈다.
3. 주소를 붙여넣고 canvas를 `1920 × 1080`으로 설정한다.
4. `Control audio via OBS`를 켜고 source를 장면 안에 보이게 둔다. 투명 배경이라 가사가 없을 때는 빈 화면이다.
5. 동일한 Player 주소를 가진 source는 하나만 유지한다. source를 숨기면 오디오와 같은 페이지의 가사도 보이지 않을 수 있다.
6. scene 전환 중 재생을 유지하려면 `Shutdown source when not visible`과 `Refresh browser when scene becomes active`를 끄고 짧은 녹화로 다시 확인한다.

Display Widget은 현재 곡·세트리스트 전용이며 가사와 오디오를 담당하지 않는다.

## 2. 합성 HAMELN 시나리오

저작권 가사 대신 placeholder를 사용한다.

```text
곡명: HAMELN
아티스트: Hatsuki Yura
BPM: 130 (test fixture only)
박자표: 4/4
C001 anchor: 60.000s
B001 blank anchor: 90.000s
C002 anchor: 105.000s
```

130 BPM의 1/4음표는 461.538 ms, 1/8음표는 230.769 ms다. 따라서 C001은 59.538462초에 전환을 시작하고 59.769231초에 완전히 보여야 한다. B001과 C002도 같은 상대 규칙을 사용한다. 실제 곡의 BPM 130은 가정하지 말고 사용자 확인 또는 분석 결과를 사용한다.

## 3. 자동 fixture

Windows 11 PowerShell:

```powershell
npm test
npm run build
npm run check:obs:bundle
npm run test:lyrics:smoke
$env:REKASONG_SESSION_BASE_URL='https://rekasong-session.11qaws.workers.dev'; npm run test:lyrics:worker
node scripts/obs-karaoke-sync-fixture.mjs .tmp\rekasong-lyrics-5m.wav
node scripts/obs-karaoke-sync-fixture.mjs .tmp\rekasong-lyrics-10m.wav --stress
```

`obs-karaoke-sync-fixture.mjs`는 48 kHz mono marker audio와 절대 media-time lyric/blank manifest를 같은 10초 cycle에 만든다. 31 cycle은 5분, 61 cycle은 10분 경계를 직접 포함한다. 관측 정책은 `observe_only_no_seek_restart_or_rate_change`이며 drift correction 명령을 만들지 않는다.

## 4. 실제 녹화 검증

자동 테스트는 실제 OBS mixer·CEF frame·녹화물을 증명하지 않는다. 배포 후 별도 승인된 환경에서 다음을 확인한다.

- marker audio와 fade start/end를 녹화 frame으로 비교한다.
- 동일 Player 내부 계산 목표는 1 frame 이내, 녹화 관찰 허용치는 50 ms 이내다.
- 5분과 10분 마지막 marker의 오차가 첫 marker보다 누적 증가하지 않는다.
- pause, buffering에서 화면이 정지한다.
- fade 중간 seek, 역탐색, 0초 restart가 즉시 해당 상태로 복원된다.
- lyric → blank → lyric에서 원문과 한국어가 한 그룹으로 움직인다.
- 다음 run이 0초 package로 다시 anchor되고 이전 fetch가 화면을 바꾸지 않는다.
- scene 전환, source 재활성화, OBS CEF 재연결 뒤 현재 cue가 media time에서 복원된다.
- 관측 때문에 seek, restart, playbackRate 변경이 발생하지 않는다.

실제 OBS 검증을 하지 않았다면 릴리스 기록에 반드시 `미실시`로 남긴다.
