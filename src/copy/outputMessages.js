// Output/OBS copy is kept behind semantic keys so this safety-critical surface
// can be translated without using the Korean sentence itself as an identifier.
// Locale packs may be added incrementally; missing entries fall back to Korean.
export const outputMessageCatalog = Object.freeze({
  ko: Object.freeze({
    'playback.region.label': '현재 재생 제어',
    'playback.heading': '현재 재생',
    'playback.phase.skipping': '스킵 중…',
    'playback.phase.discarding': '취소 중…',
    'playback.phase.failed': '재생 실패',
    'playback.phase.onAir': '● ON AIR',
    'playback.phase.paused': 'Ⅱ 일시정지',
    'playback.control.locked': '지금은 재생/일시정지를 할 수 없습니다',
    'playback.control.pause': '일시정지',
    'playback.control.play': '재생',
    'playback.control.unmute': '음소거 해제',
    'playback.control.mute': '음소거',
    'playback.control.volume': '볼륨',
    'playback.control.skipFinishing': '스킵 확인 중 — 곡이 끝나면 다음 곡으로 넘어갑니다',
    'playback.control.skipFailed': '실패한 곡은 다시 재생하거나 버려 주세요',
    'playback.control.skip': '다음 곡으로 스킵',
    'playback.control.retry': '같은 곡 다시 재생 (새 시도)',
    'playback.control.requeue': '현재 곡 다시 예약',
    'playback.control.discard': '현재 곡 버리기 — 이력에 남지 않고 다음 곡을 자동 재생하지 않습니다',
    'playback.control.seek': '재생 위치',
    'playback.failure.default': '재생에 실패했습니다.',
    'playback.failure.withAction': '{{detail}} — 다시 재생하거나 버려 주세요.',
    'playback.idle': '재생 중인 곡이 없습니다. 아래에서 곡을 추가하세요.',

    'onair.output.region.label': '오디오 출력 선택과 상태',
    'onair.output.heading': '오디오 출력',
    'onair.output.description': '음악을 들을 위치를 선택합니다. 한 번에 한 출력만 재생할 수 있습니다.',
    'onair.output.mode.speaker': '스피커 · 이 기기에서 듣기',
    'onair.output.mode.obs': 'OBS · 방송으로 송출',
    'onair.output.mode.unselected': '출력 선택 안 됨',
    'onair.output.obs.localSilence': 'OBS 플레이어에서 재생합니다. 이 기기의 스피커가 무음인 것은 정상입니다.',
    'onair.output.obs.monitorGuidance': '실제 소리는 OBS 오디오 모니터링과 헤드폰 경로에서 확인하세요.',
    'onair.output.proof.playerOnly': '플레이어 동작 확인',
    'onair.output.proof.notFinalOutput': '이 상태만으로 OBS 믹서·녹화·실제 송출의 소리를 증명하지는 않습니다.',

    'onair.output.status.invalidInput': '출력 상태 정보를 검증하지 못했습니다. 자동 재생을 차단했습니다.',
    'onair.output.status.stateUnknown': '실제 출력 상태를 확인할 수 없습니다. 자동 전환과 자동 재생을 차단했습니다.',
    'onair.output.status.activationFailed': '출력 활성화에 실패했습니다. 원인을 확인한 뒤 명시적으로 다시 시도하세요.',
    'onair.output.status.emergencyStopping': '모든 출력에 긴급 정지를 요청했고 정지 증거를 기다리는 중입니다.',
    'onair.output.status.deactivating': '기존 출력이 완전히 정지했는지 확인하는 중입니다…',
    'onair.output.status.activating': '선택한 출력을 준비하는 중입니다…',
    'onair.output.status.candidateMissing': '선택한 출력의 플레이어를 찾지 못했습니다.',
    'onair.output.status.candidateDuplicate': '같은 출력의 플레이어가 둘 이상 연결되어 재생을 차단했습니다.',
    'onair.output.status.inactive': '현재 활성화된 오디오 출력이 없습니다.',
    'onair.output.status.speaker.routeReady': '이 기기의 스피커가 재생 명령을 받을 준비를 마쳤습니다.',
    'onair.output.status.speaker.playerPlaying': '이 기기의 플레이어에서 실제 재생을 확인했습니다.',
    'onair.output.status.obs.routeReady': 'OBS 플레이어가 재생 명령을 받을 준비를 마쳤습니다.',
    'onair.output.status.obs.playerPlaying': 'OBS 플레이어에서 실제 재생을 확인했습니다.',
    'onair.output.status.unselected.routeReady': '플레이어가 준비됐지만 출력 선택을 확인하지 못했습니다.',
    'onair.output.status.unselected.playerPlaying': '플레이어 재생은 감지됐지만 출력 선택을 확인하지 못했습니다.',

    'onair.output.candidate.none': '연결된 대상 플레이어 없음',
    'onair.output.candidate.single': '대상 플레이어 1개 연결됨',
    'onair.output.candidate.duplicate': '대상 플레이어 중복 연결',
    'onair.output.candidate.unknown': '대상 플레이어 수 확인 불가',
    'onair.output.lease.activating': '출력 준비 중',
    'onair.output.lease.ready': '출력 준비 확인',
    'onair.output.lease.audible': '플레이어 재생 확인',
    'onair.output.lease.unknown': '출력 상태 확인 불가',
    'onair.output.lease.deactivating': '출력 정지 확인 중',
    'onair.output.lease.inactive': '출력 비활성',
    'onair.output.lease.emergency': '긴급 정지 확인 중',
    'onair.output.playback.matched': '요청과 플레이어 상태가 일치합니다.',
    'onair.output.playback.pending': '플레이어가 요청을 적용했는지 확인하는 중입니다.',
    'onair.output.playback.conflict': '요청과 실제 플레이어 상태가 다릅니다.',
    'onair.output.playback.unknown': '실제 플레이어 상태를 확인할 수 없습니다.',
    'onair.output.test.active': 'OBS 오디오 점검 진행 중',
    'onair.output.test.inactive': 'OBS 오디오 점검 신호 꺼짐',
    'onair.output.test.unknown': 'OBS 오디오 점검 신호 상태 확인 불가',
    'onair.output.adapter.unavailable': '이 화면에는 로컬 플레이어 진단 정보가 없습니다.',
    'onair.output.adapter.invalid': '로컬 플레이어 진단 정보가 올바르지 않습니다.',
    'onair.output.adapter.unknown': '로컬 플레이어의 실제 상태를 확인할 수 없습니다.',
    'onair.output.adapter.localEventSent': '로컬 플레이어가 상태 이벤트를 전송했습니다.',
    'onair.output.adapter.localOnly': '로컬 플레이어가 명령을 적용 중이지만 서버 확인은 아직입니다.',
    'onair.output.adapter.standby': '로컬 플레이어가 안전한 대기 상태입니다.',

    'onair.output.verification.unknown': '최종 오디오 경로는 아직 검증되지 않았습니다.',
    'onair.output.verification.stale': '이전 검증 결과가 현재 설정에는 유효하지 않습니다.',
    'onair.output.verification.speakerPlayback.passed': '이 기기의 스피커 재생을 확인했습니다.',
    'onair.output.verification.speakerPlayback.stale': '스피커 재생 확인을 다시 해야 합니다.',
    'onair.output.verification.obsMixer.passed': 'OBS 믹서 입력을 확인했습니다.',
    'onair.output.verification.obsMixer.stale': 'OBS 믹서 확인이 현재 설정과 달라 다시 점검해야 합니다.',
    'onair.output.verification.obsRecording.passed': 'OBS 녹화 파일에서 테스트 신호를 확인했습니다.',
    'onair.output.verification.obsRecording.stale': 'OBS 녹화 확인이 현재 설정과 달라 다시 점검해야 합니다.',
    'onair.output.verification.obsStreamArtifact.passed': '테스트 송출 결과물에서 오디오 신호를 확인했습니다.',
    'onair.output.verification.obsStreamArtifact.stale': '실제 송출 확인이 현재 설정과 달라 다시 점검해야 합니다.',
    'onair.output.verification.karaokeSync.passed': '마이크와 반주의 상대 싱크가 기준을 통과했습니다.',
    'onair.output.verification.karaokeSync.stale': '카라오케 싱크 확인이 현재 설정과 달라 다시 측정해야 합니다.',

    'onair.output.action.switchOutput.label': '출력 전환',
    'onair.output.action.activate.label': '선택한 출력 활성화',
    'onair.output.action.deactivate.label': '현재 출력 안전하게 끄기',
    'onair.output.action.retry.label': '상태 다시 확인',
    'onair.output.action.resume.label': '재생 다시 시작',
    'onair.output.action.startTest.label': 'OBS 오디오 점검 시작',
    'onair.output.action.stopTest.label': 'OBS 오디오 점검 중지',
    'onair.output.action.emergencyStop.label': '모든 출력 긴급 정지',
    'onair.output.action.autoResume.label': '자동 재생 복구',
    'onair.output.action.autoFallback.label': '자동 출력 대체',
    'onair.output.gate.allowed': '지금 실행할 수 있습니다.',
    'onair.output.gate.invalidInput': '상태 정보가 올바르지 않아 실행할 수 없습니다.',
    'onair.output.gate.stateUnknown': '실제 출력 상태를 확인할 수 없어 실행할 수 없습니다.',
    'onair.output.gate.activePlayback': '재생 또는 점검이 진행 중이어서 출력을 바꿀 수 없습니다.',
    'onair.output.gate.stopNotProven': '기존 오디오가 완전히 정지했다는 증거가 필요합니다.',
    'onair.output.gate.candidateNotSingle': '대상 플레이어가 정확히 하나 연결되어야 합니다.',
    'onair.output.gate.leaseNotInactive': '기존 출력 권한을 먼저 해제해야 합니다.',
    'onair.output.gate.leaseNotReady': '선택한 출력이 아직 준비되지 않았습니다.',
    'onair.output.gate.noLeaseTarget': '끄거나 복구할 대상 출력이 없습니다.',
    'onair.output.gate.adapterNotSafe': '로컬 플레이어가 안전한 상태임을 확인하지 못했습니다.',
    'onair.output.gate.modeNotObs': 'OBS 출력 모드에서만 실행할 수 있습니다.',
    'onair.output.gate.testActive': '이미 오디오 점검이 진행 중입니다.',
    'onair.output.gate.noActiveTest': '중지할 오디오 점검이 없습니다.',
    'onair.output.gate.notPaused': '확인된 일시정지 상태에서만 다시 시작할 수 있습니다.',
    'onair.output.gate.policyManualOnly': '방송 사고를 막기 위해 자동 실행하지 않습니다.',
    'onair.output.gate.notNeeded': '현재 상태에서는 실행할 필요가 없습니다.',

    'obs.setup.openLabel': 'OBS 연결 설정',
    'obs.setup.eyebrow': '현재 방송 세션 · 방송 전 확인',
    'obs.setup.title': 'OBS 연결 설정',
    'obs.setup.closeLabel': '닫기',
    'obs.setup.intro': '방송 오디오에는 On-Air 플레이어 1개가 필수입니다. 화면 정보 위젯은 선택 사항이며 오디오 송출과 무관합니다.',
    'obs.setup.sessionUrl': '아래 주소는 현재 방송 세션 전용입니다. 방송 세션을 종료하면 기존 주소는 더 이상 사용할 수 없으므로, 다음 세션에서 새 주소로 OBS 소스를 갱신하세요.',
    'obs.setup.server.connected': '방송 서버 연결됨 — 아래 페이지 상태는 OBS 송출 확인이 아니라 접속 여부만 표시합니다.',
    'obs.setup.server.connecting': '방송 서버에 연결하는 중입니다…',
    'obs.setup.server.notStarted': '아래에서 주소를 만들면 방송 서버에 연결됩니다.',

    'obs.setup.player.stepTitle': '1. On-Air 플레이어',
    'obs.setup.player.requirement': '필수 · 오디오',
    'obs.setup.player.instruction': 'OBS 브라우저 소스를 하나 추가하고 ‘로컬 파일’은 해제한 뒤 URL을 붙여넣으세요. ‘Control audio via OBS’는 체크하고, 같은 플레이어 주소를 넣은 소스는 하나만 유지하세요.',
    'obs.setup.player.preparing': '준비 중…',
    'obs.setup.player.copyUrl': '주소 복사',
    'obs.setup.player.prepareAndCopy': '플레이어 준비 후 주소 복사',
    'obs.setup.player.serverRequired': 'On-Air 서버를 연결하면 주소를 준비할 수 있습니다',
    'obs.setup.player.connected': '플레이어 페이지가 서버에 연결됨 — OBS 실행·오디오 송출 여부는 아직 확인되지 않았습니다',
    'obs.setup.player.waiting': '플레이어 페이지 연결을 기다리는 중입니다',
    'obs.setup.player.prepareFailed': 'On-Air 플레이어를 준비하지 못했습니다.',
    'obs.setup.player.urlCopied': 'OBS On-Air 플레이어 주소를 복사했습니다.',

    'obs.setup.display.stepTitle': '2. 화면 정보 위젯',
    'obs.setup.display.requirement': '선택 · 화면 표시',
    'obs.setup.display.instruction': '현재 곡과 대기열을 방송 화면에 보여줄 때만 추가하세요. 무음 위젯이며 플레이어 오디오에는 영향을 주지 않습니다. 화면 크기는 방송 화면 전체(예: 1920×1080)로 맞춥니다.',
    'obs.setup.display.copyUrl': '주소 복사',
    'obs.setup.display.prepareAndCopy': '위젯 준비 후 주소 복사',
    'obs.setup.display.keyPreparing': '위젯 키 준비 중…',
    'obs.setup.display.directUrlTitle': '이 브라우저에서 재생하는 동안 현재 곡·setlist를 보여 주는 위젯 주소',
    'obs.setup.display.directUrlPendingTitle': '위젯 키를 준비하는 중입니다. 잠시 후 다시 시도해 주세요.',
    'obs.setup.display.connected': '화면 위젯 페이지가 서버에 연결됨 — OBS 화면 표시는 직접 확인하세요',
    'obs.setup.display.waiting': '화면 위젯 페이지 연결을 기다리는 중입니다',
    'obs.setup.display.prepareFailed': '화면 정보 위젯을 준비하지 못했습니다.',
    'obs.setup.display.urlCopied': 'OBS 화면 정보 위젯 주소를 복사했습니다.',
    'obs.setup.display.directUrlCopied': '화면 정보 위젯 주소를 복사했습니다.',

    'obs.setup.copyFailed': '위젯 주소를 복사하지 못했습니다.',
    'obs.setup.lifecycle.title': '오디오가 장면 전환 중에도 끊기지 않게',
    'obs.setup.lifecycle.shutdownSetting': 'Shutdown source when not visible',
    'obs.setup.lifecycle.shutdownGuidance': '장면이 바뀌어도 계속 재생하려면 해제',
    'obs.setup.lifecycle.refreshSetting': 'Refresh browser when scene becomes active',
    'obs.setup.lifecycle.refreshGuidance': '의도치 않은 새로고침을 막으려면 해제',
    'obs.setup.lifecycle.policyNote': '장면에서 숨길 때 음악도 멈추게 하려는 구성이라면 첫 설정을 다르게 선택할 수 있습니다. 변경 후에는 반드시 OBS 믹서와 짧은 녹화로 다시 확인하세요.',
    'obs.setup.session.endDescription': '방송을 완전히 마치면 세션을 종료해 현재 곡·대기열·다시 부르기 목록과 임시 로컬 파일을 함께 정리합니다.',
    'obs.setup.session.endConfirm': '방송 세션을 종료할까요? 현재 재생·대기열·이전 재생 목록과 임시 로컬 파일이 정리됩니다.',
    'obs.setup.session.endButton': '방송 세션 종료'
  }),
  en: Object.freeze({})
});

const DEFAULT_LOCALE = 'ko';

function normalizeLocale(locale) {
  return String(locale || DEFAULT_LOCALE).toLowerCase().split('-')[0];
}

function currentDocumentLocale() {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  return document.documentElement.lang || DEFAULT_LOCALE;
}

export function getOutputMessage(key, values = {}, locale = currentDocumentLocale()) {
  const requestedLocale = normalizeLocale(locale);
  const template = outputMessageCatalog[requestedLocale]?.[key]
    ?? outputMessageCatalog[DEFAULT_LOCALE]?.[key]
    ?? key;

  return String(template).replace(/\{\{(\w+)\}\}/g, (placeholder, variableName) => (
    Object.prototype.hasOwnProperty.call(values, variableName)
      ? String(values[variableName])
      : placeholder
  ));
}
