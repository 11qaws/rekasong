# Speaker / OBS 볼륨 프로필 계약

## 목적

Speaker는 개인 감상용 로컬 플레이어이고 OBS는 방송 출력이다. 두 용도가 하나의 볼륨을 공유하면 스피커에서 작게 듣던 값이 방송에 적용되거나, 방송용 gain이 로컬 스피커에서 갑자기 크게 들릴 수 있다. 따라서 볼륨은 출력 모드별 지속 설정으로 분리한다.

이 기능은 음량 값만 선택한다. 출력 route, OBS lease, player 후보, 재생 상태, 곡 위치를 변경하거나 검증하지 않는다.

## 상태의 대상과 수명

| 상태 | 대상 | 수명 |
|---|---|---|
| `speakerVolume` | 이 브라우저에서 새로 시작할 Speaker 재생 | 브라우저 localStorage |
| `obsVolume` | 이 브라우저에서 새로 시작할 OBS 재생과 현재 OBS run | 브라우저 localStorage |
| 현재 run의 실제 volume | 탭의 한 PlaybackRun | run 종료까지 |

각 탭은 저장값을 시작값으로 읽는다. 이미 열린 다른 Speaker 탭의 재생 볼륨을 storage event로 원격 변경하지 않는다. 사용자가 조작한 탭의 현재 run만 즉시 바뀌며, 저장값은 이후 시작하는 run과 새 탭의 기본값이 된다.

## 마이그레이션

1. 새 프로필 저장값이 있으면 그 값을 사용한다.
2. 새 프로필이 없고 기존 `rekasong_volume` 값이 있으면 `speakerVolume`과 `obsVolume` 양쪽에 같은 값을 복사한다.
3. 둘 다 없거나 값이 손상됐으면 양쪽 모두 100으로 시작한다.
4. 기존 key는 롤백 호환을 위해 삭제하지 않는다. 새 앱은 이후 새 프로필 key만 갱신한다.

기존 값을 양쪽에 복사하는 이유는 배포 직후 OBS gain이나 스피커 음량을 앱이 임의로 바꾸지 않기 위해서다. 분리는 사용자가 어느 한 모드의 볼륨을 처음 조절한 순간부터 드러난다.

## 전이

| 현재 상황 + 이벤트 | 결과 |
|---|---|
| 현재 run 없음 + Speaker 선택 | UI는 `speakerVolume`을 표시 |
| 현재 run 없음 + OBS 선택 | UI는 `obsVolume`을 표시 |
| Speaker run + 볼륨 조절 | `speakerVolume` 저장 + 해당 로컬 run에만 VOLUME 적용 |
| OBS run + 볼륨 조절 | `obsVolume` 저장 + 해당 OBS run에만 VOLUME 적용 |
| 새 Speaker run | LOAD에 `speakerVolume` 사용 |
| 새 OBS run | LOAD에 `obsVolume` 사용 |
| OBS run을 Speaker로 명시 전환 | 새 Speaker run은 기존 OBS 값이 아니라 `speakerVolume` 사용 |
| 다른 탭에서 볼륨 변경 | 이 탭의 현재 run은 변경하지 않음 |

## 불변식

1. Speaker 볼륨 변경은 OBS run에 명령을 보내지 않는다.
2. OBS 볼륨 변경은 다른 탭의 Speaker media element를 바꾸지 않는다.
3. 모드를 선택했다는 이유만으로 현재 곡을 재생·정지·seek하지 않는다.
4. 볼륨 저장 실패는 현재 재생을 중단하거나 출력 상태를 unknown으로 바꾸지 않는다.
5. 모든 값은 0~100으로 제한하고 손상된 저장값은 안전한 기본값으로 무시한다.
6. 재생 중에는 현재 run의 `outputMode`가 볼륨 대상의 권위다. 현재 run이 없을 때만 사용자가 선택한 출력 모드를 따른다.
7. OBS의 실제 Mixer gain, monitor, track 설정은 앱 volume과 별개이며 G3 사용자 확인으로 검증한다.

## 검증

- 기존 단일 값에서 두 프로필로 무손실 마이그레이션한다.
- Speaker와 OBS 값을 각각 변경해도 상대 프로필이 유지된다.
- OBS→Speaker run 전환 시 LOAD가 Speaker 프로필을 사용한다.
- 저장값 손상·quota 오류가 재생 또는 route 상태를 바꾸지 않는다.
- 한국어·영어 접근성 이름이 현재 조절 대상 출력을 명확히 말한다.

실제 브라우저에서는 Speaker 볼륨을 34%로 조절하고 곡을 완전히 버린 뒤 페이지를 새로고침했다. 같은 곡의 새 run에서 `Speaker volume`이 34%로 복원됐고 슬라이더는 활성 상태였으며 media time이 계속 증가했다. 마지막 버리기 뒤 media는 paused이고 source가 분리됐다.
