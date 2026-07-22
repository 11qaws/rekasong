# Speaker 모바일 Media Session 계약

## 목적

Speaker를 일반 웹 음악 플레이어처럼 사용할 때 지원 브라우저의 잠금 화면·알림·헤드셋 버튼에서 곡 정보와 재생 조작을 제공한다. 앱이 백그라운드 오디오를 강제로 보장할 수는 없지만, OS가 제공하는 표준 Media Session 통합을 사용해 창 전환 뒤에도 사용자가 앱으로 돌아오지 않고 기본 조작을 할 수 있게 한다.

이 기능은 Speaker의 보조 입력 표면이다. OBS 방송 제어, 연결 복구, route 증거 또는 재생 권위를 대체하지 않는다.

## 활성 조건

다음 조건을 모두 만족할 때만 활성화한다.

1. `navigator.mediaSession`이 존재한다.
2. 현재 곡과 active run이 있다.
3. active run의 실제 `outputMode`가 `speaker`다.

사용자가 Speaker 버튼을 선택했더라도 현재 run이 OBS에 남아 있으면 활성화하지 않는다. OBS run에서는 metadata·playback state·action handler를 제거한다.

## 노출 정보

- 제목: 현재 곡 제목
- 아티스트: 현재 곡의 아티스트가 있을 때만
- 앨범/앱: `Rekasong`
- 상태: 실제 UI가 확인한 `playing` 또는 `paused`
- 위치: 유효한 duration·position이 있을 때만, playback rate 1

곡명과 아티스트는 외부/사용자 데이터이며 번역하지 않는다. 앱 작성 문구를 Media Session metadata에 넣지 않는다.

## OS 동작 매핑

| Media Session 동작 | Speaker 동작 |
|---|---|
| play | paused면 현재 곡 재생, failed면 명시적 같은 곡 재시도 |
| pause | playing일 때만 일시정지 |
| nexttrack | 현재 곡의 기존 다음 곡/스킵 계약 사용 |
| seekto | 지정 위치로 이동 |
| seekbackward | 현재 위치에서 요청 offset, 기본 10초만큼 뒤로 |
| seekforward | 현재 위치에서 요청 offset, 기본 10초만큼 앞으로 |

`stop`을 현재 곡 버리기에 연결하지 않는다. OS stop과 Rekasong의 “이력에 남기지 않고 버리기”는 의미가 다르기 때문이다. 이전 곡 자동 재생도 임의로 추가하지 않는다.

## 불변식

1. Media Session API 미지원·예외·거부는 Speaker playback state를 바꾸거나 사용자 오류로 표시하지 않는다.
2. OS action은 기존 Dashboard 사용자 handler만 호출하고 별도 PLAY·PAUSE·SEEK·STOP 명령을 만들지 않는다.
3. OBS run에서는 handler가 설치돼 있지 않으며 OS 버튼이 OBS 명령을 보낼 수 없다.
4. metadata·position 갱신은 Worker, WebSocket, localStorage를 사용하지 않는다.
5. 잘못된 duration·position은 `setPositionState`를 호출하지 않는다.
6. position은 0~duration으로 제한한다.
7. component unmount와 Speaker→OBS 전환에서 metadata, playback state, handler를 정리한다.
8. Media Session 활성화 여부가 재생 지속 증거가 되거나 백그라운드 재생 보장으로 표시되지 않는다.

## 검증

- Speaker run에서만 metadata와 handler가 설치된다.
- OBS run/idle/dispose에서 모두 제거된다.
- play/pause/next/seek action이 기존 callback을 정확히 한 번 호출한다.
- 잘못된 위치는 무시하고 정상 위치는 범위 안으로 제한한다.
- API별 throw가 나도 controller update와 dispose가 예외를 외부로 내보내지 않는다.
- 실제 지원 모바일/브라우저의 잠금 화면·알림·헤드셋 버튼은 수동 검증으로 남긴다.
