# Speaker 연결 수요 계약 — 2026-07-22

## 사용자 목표

Speaker는 앱을 여는 순간부터 일반 웹 플레이어다. OBS를 쓰지 않는 사용자는 방송 세션, 제어권, Browser Source 후보, WebSocket 상태를 알거나 기다릴 이유가 없다. 반대로 OBS를 선택한 사용자는 기존 Protocol v2의 엄격한 단일 경로와 복구 증거를 그대로 사용한다.

## 서로 다른 세 상태

| 상태 대상 | 시작 조건 | 하는 일 | Speaker를 막을 수 있는가 |
|---|---|---|---|
| 로컬 Speaker 출력 | 페이지 진입 | 이 탭의 재생 선택과 UI를 즉시 제공 | 아니오 |
| 미디어 인증 세션 | 준비할 YouTube 곡, 업로드할 로컬 파일, OBS 주소 생성 중 하나가 처음 필요함 | 준비 음원·세션 자산 HTTP 접근용 자격을 한 번 만들거나 재사용 | 해당 미디어 요청만 실패시킬 수 있음 |
| OBS 제어 연결 | 이 페이지에서 사용자가 OBS를 명시적으로 선택 | control WebSocket, 단일 lease, source attestation과 리모컨 확인 | OBS 선택·OBS run에만 영향 |

미디어 인증 세션이 존재한다는 사실은 OBS 제어를 켜는 조건이 아니다. 저장된 세션이 있어도 새 페이지는 Speaker로 시작하며, 명시적인 OBS 의도 전에는 control WebSocket을 열지 않는다.

## 전이

| 현재 | 이벤트 | 다음 | 허용되는 부작용 |
|---|---|---|---|
| Speaker idle | 페이지 열기 | Speaker idle | Worker session 요청 0, session WebSocket 0 |
| Speaker idle | 검색어 입력·검색 결과 표시 | Speaker idle | 검색 API만 허용; session 생성 0 |
| Speaker idle | YouTube 곡 검토·대기열 준비 | Speaker media preparing | media session 1회 생성/재사용과 HTTP prepare 허용; WebSocket 0 |
| Speaker idle/media | OBS 선택 | OBS connecting | session 확보, control 연결, authoritative snapshot 대기 |
| OBS connecting | 정확한 writable snapshot | OBS selectable | 기존 단일 Browser Source 검증 사용 |
| 어느 상태 | Speaker 선택 | Speaker | OBS 불확실성이 로컬 선택·로컬 transport를 잠그지 않음 |

## 불변식

1. 새 Speaker 페이지는 자동으로 `/v1/sessions`를 만들지 않는다.
2. 검색만으로 media session이나 WebSocket을 만들지 않는다.
3. Speaker의 HTTP media session은 출력 lease가 아니며 OBS controller를 깨우지 않는다.
4. OBS control은 페이지 수명 중 첫 명시적 OBS 선택 뒤에만 활성화한다. 한번 활성화된 control은 같은 페이지에서 Speaker로 돌아가도 진행 중인 안전 정리와 빠른 복구를 위해 유지한다.
5. OBS player·Worker media graph, heartbeat, route/command 프로토콜은 이 변경에서 수정하지 않는다.
6. 유레카의 3px 노란 머리선은 연결 상태와 무관한 영구 브랜드 요소로 계속 렌더한다.

## 후속 분리

현재 production의 로컬 파일은 OBS로 전환할 가능성을 위해 drop 즉시 세션 자산으로 업로드한다. 일반 Speaker에서 서버 장애 없이 Blob을 바로 재생하고, 실제 OBS 선택 시에만 업로드하도록 바꾸는 작업은 파일 수명·중간 전환·업로드 실패 복구를 별도 상태기로 설계한 뒤 이어서 적용한다. 이번 계약은 먼저 불필요한 유휴 세션과 Speaker control WebSocket을 제거한다.
