import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getOutputMessage,
  outputMessageCatalog,
  outputSwitchFailureMessageKey,
} from '../src/copy/outputMessages.js';
import { appMessageCatalog } from '../src/copy/appMessages.js';
import {
  ON_AIR_OUTPUT_ACTIONS,
  ON_AIR_OUTPUT_GATE_CODES,
  ON_AIR_OUTPUT_LEASE_STATES,
  ON_AIR_OUTPUT_MODES,
} from '../src/lib/onAirOutputView.js';

const SEMANTIC_KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function placeholders(template) {
  return [...String(template).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

test('Korean output catalog uses semantic keys and non-empty source messages', () => {
  const entries = Object.entries(outputMessageCatalog.ko);
  assert.ok(entries.length >= 60, 'the first OBS/playback vertical slice should remain substantial');

  for (const [key, message] of entries) {
    assert.match(key, SEMANTIC_KEY, `non-semantic message key: ${key}`);
    assert.doesNotMatch(key, /[가-힣]/, `source prose must not be a key: ${key}`);
    assert.equal(typeof message, 'string');
    assert.ok(message.trim().length > 0, `empty Korean source message: ${key}`);
  }
});

test('requested locales use their catalog and unsupported locales fall back without exposing the key', () => {
  const key = 'obs.setup.player.connected';
  assert.equal(getOutputMessage(key, {}, 'en-US'), outputMessageCatalog.en[key]);
  assert.equal(getOutputMessage(key, {}, 'ja'), outputMessageCatalog.ko[key]);
  assert.equal(getOutputMessage('missing.semantic.key', {}, 'en'), 'missing.semantic.key');
});

test('named interpolation replaces supplied values and preserves missing placeholders for diagnostics', () => {
  assert.equal(
    getOutputMessage('playback.failure.withAction', { detail: 'decode_failed' }, 'ko'),
    'decode_failed — 다시 재생하거나 버려 주세요.',
  );
  assert.equal(
    getOutputMessage('playback.failure.withAction', {}, 'ko'),
    '{{detail}} — 다시 재생하거나 버려 주세요.',
  );
});

test('every translated locale entry preserves Korean placeholder names', () => {
  for (const [locale, catalog] of Object.entries(outputMessageCatalog)) {
    if (locale === 'ko') continue;
    for (const [key, message] of Object.entries(catalog)) {
      assert.ok(Object.hasOwn(outputMessageCatalog.ko, key), `${locale} has orphan key ${key}`);
      assert.deepEqual(
        placeholders(message),
        placeholders(outputMessageCatalog.ko[key]),
        `${locale} placeholder mismatch for ${key}`,
      );
    }
  }
});

test('PlaybackPanel references only existing merged app catalog keys', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  const usedKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(usedKeys.length >= 60, 'expected PlaybackPanel copy to use the translation facade');

  const koreanAppCatalog = { ...outputMessageCatalog.ko, ...appMessageCatalog.ko };
  const missing = [...new Set(usedKeys)].filter((key) => !Object.hasOwn(koreanAppCatalog, key));
  assert.deepEqual(missing, []);
});

test('PlaybackPanel keeps only output status in the header and route controls in settings', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  const headerStart = source.indexOf('className="playback-panel-header"');
  const playbackBodyStart = source.indexOf('{currentSong ? (', headerStart);
  const modalStart = source.indexOf('{isObsSetupOpen && (');
  const detailsStart = source.indexOf('className="output-route-details"');
  const portalStart = source.indexOf('className="dashboard-output-route-bar-inner"');

  assert.ok(headerStart >= 0 && playbackBodyStart > headerStart, 'playback header must remain identifiable');
  const headerSource = source.slice(headerStart, playbackBodyStart);
  assert.doesNotMatch(headerSource, /playback-live-badges|output-route-switch|output-route-actions/);
  assert.ok(portalStart >= 0 && portalStart < modalStart, 'the compact status bar must render in the dashboard header portal');
  assert.match(source.slice(portalStart, modalStart), /output-route-live-status/);
  assert.match(source.slice(portalStart, modalStart), /output-settings-button/);
  assert.doesNotMatch(source, /className="output-selector"/);
  assert.ok(modalStart >= 0 && detailsStart > modalStart, 'route diagnostics must render inside the settings dialog');
  assert.match(source.slice(detailsStart), /className="output-route-switch"/);
  assert.match(source.slice(detailsStart), /onair\.output\.selector\.status\.selected/);
  assert.match(source.slice(detailsStart), /onair\.output\.selector\.status\.actual/);
  assert.match(source.slice(detailsStart), /outputView\?\.messageKey/);
  assert.match(source.slice(detailsStart), /obs\.setup\.recovery\.routeUnknown/);
});

test('OBS audio check stays inside settings, exposes evidence accessibly, and states its G2 limit', async () => {
  const [panelSource, dashboardSource, viewSource] = await Promise.all([
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/obsAudioCheckView.js', import.meta.url), 'utf8'),
  ]);
  const modalStart = panelSource.indexOf('{isObsSetupOpen && (');
  const checkStart = panelSource.indexOf('className={`obs-audio-check', modalStart);
  assert.ok(modalStart >= 0 && checkStart > modalStart, 'the check must remain in the gear dialog');
  assert.doesNotMatch(panelSource.slice(0, modalStart), /obs-audio-check/);
  assert.match(panelSource.slice(checkStart), /aria-labelledby="obs-audio-check-title"/);
  assert.match(panelSource.slice(checkStart), /role="status"[\s\S]*?aria-live="polite"/);
  assert.match(panelSource.slice(checkStart), /role="list"[\s\S]*?role="listitem"/);
  assert.match(panelSource.slice(checkStart), /aria-describedby="obs-audio-check-scope obs-audio-check-status obs-audio-check-prompt"/);
  assert.match(panelSource.slice(checkStart), /onStartObsAudioCheck/);
  assert.match(panelSource.slice(checkStart), /onStopObsAudioCheck/);
  const obsConfigurationGate = panelSource.indexOf('{isObsConfigurationVisible && (', modalStart);
  assert.ok(
    obsConfigurationGate > modalStart && obsConfigurationGate < checkStart,
    'Speaker settings must not expose OBS verification until OBS configuration is requested',
  );
  assert.match(panelSource, /if \(mode === 'obs'\) setIsObsConfigurationVisible\(true\)/);
  assert.match(panelSource, /if \(mode === 'speaker'\) setIsObsConfigurationVisible\(false\)/);
  assert.match(dashboardSource, /onStartObsAudioCheck=\{outputControl\.startTest\}/);
  assert.match(dashboardSource, /onStopObsAudioCheck=\{outputControl\.stopTest\}/);
  assert.match(dashboardSource, /onConfirmObsMixerSignal=\{handleConfirmObsMixerSignal\}/);
  assert.match(dashboardSource, /onReportMissingObsMixerSignal=\{handleReportMissingObsMixerSignal\}/);
  assert.match(panelSource.slice(checkStart), /obs-mixer-verification/);
  assert.match(panelSource.slice(checkStart), /onConfirmObsMixerSignal/);
  assert.match(panelSource.slice(checkStart), /onReportMissingObsMixerSignal/);
  assert.doesNotMatch(viewSource, /rmsDbfs|peakDbfs/);

  assert.match(outputMessageCatalog.ko['obs.audioCheck.scope'], /G2/);
  assert.match(outputMessageCatalog.ko['obs.audioCheck.scope'], /의미하지 않습니다/);
  assert.match(outputMessageCatalog.en['obs.audioCheck.scope'], /does not prove/i);
});

test('OBS audio check copy has exact Korean-English key and placeholder parity', () => {
  const prefix = 'obs.audioCheck.';
  const keysByLocale = Object.fromEntries(
    ['ko', 'en'].map((locale) => [
      locale,
      Object.keys(outputMessageCatalog[locale]).filter((key) => key.startsWith(prefix)).sort(),
    ]),
  );
  assert.deepEqual(keysByLocale.en, keysByLocale.ko, 'OBS check locale key sets must stay at 100% parity');

  const required = [
    'title',
    'scope',
    'localSpeakerSilent',
    'mixerPrompt',
    'stage.ready',
    'stage.requested',
    'stage.awaitingPlaying',
    'stage.playing',
    'stage.progress',
    'stage.stopping',
    'stage.completed',
    'stage.cancelled',
    'stage.failed',
    'stage.streamingSafetyStopped',
    'stage.unknown',
    'block.connection',
    'block.otherController',
    'block.mode',
    'block.candidateNone',
    'block.sourceInactive',
    'block.candidateDuplicate',
    'block.switching',
    'block.activeWork',
    'block.route',
    'block.streamingActive',
    'block.streamingUnknown',
    'block.unavailable',
    'block.staleEvidence',
    'evidence.label',
    'evidence.requested',
    'evidence.playing',
    'evidence.playingPending',
    'evidence.markers',
    'evidence.markersPending',
    'progressLabel',
    'action.start',
    'action.retry',
    'action.requesting',
    'action.stop',
    'action.stopping',
    'action.startFailed',
    'action.stopFailed',
    'mixerVerification.title',
    'mixerVerification.runFirst',
    'mixerVerification.awaiting',
    'mixerVerification.passed',
    'mixerVerification.failed',
    'mixerVerification.stale',
    'mixerVerification.checkedAt',
    'mixerVerification.action.seen',
    'mixerVerification.action.missing',
    'mixerVerification.help.controlAudio',
    'mixerVerification.help.unmute',
    'mixerVerification.help.singleSource',
    'mixerVerification.help.retry',
    'mixerVerification.userScope',
    'mixerVerification.unavailable',
    'mixerVerification.saveFailed',
    'mixerVerification.savedPassed',
    'mixerVerification.savedFailed',
  ].map((suffix) => `${prefix}${suffix}`);
  assert.deepEqual(required.filter((key) => !keysByLocale.ko.includes(key)), []);

  for (const key of keysByLocale.ko) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean OBS check copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English OBS check copy for ${key}`);
    assert.deepEqual(
      placeholders(outputMessageCatalog.en[key]),
      placeholders(outputMessageCatalog.ko[key]),
      `OBS check placeholder mismatch for ${key}`,
    );
  }

  assert.match(outputMessageCatalog.ko['obs.audioCheck.block.activeWork'], /끝내거나.*제거/);
  assert.match(outputMessageCatalog.en['obs.audioCheck.block.activeWork'], /Finish or remove/);
  assert.match(outputMessageCatalog.ko['obs.audioCheck.mixerVerification.userScope'], /사용자.*G3-user/);
  assert.match(outputMessageCatalog.ko['obs.audioCheck.mixerVerification.userScope'], /녹화.*별도/);
  assert.match(outputMessageCatalog.en['obs.audioCheck.mixerVerification.userScope'], /only what you saw/i);
});

test('karaoke performer-monitor guidance is compact, translated, and explicitly nonblocking', async () => {
  const panelSource = await readFile(
    new URL('../src/components/PlaybackPanel.jsx', import.meta.url),
    'utf8',
  );
  const modalStart = panelSource.indexOf('{isObsSetupOpen && (');
  const obsGate = panelSource.indexOf('{isObsConfigurationVisible && (', modalStart);
  const monitorStart = panelSource.indexOf('<details className="obs-performer-monitor"', obsGate);
  const checkStart = panelSource.indexOf('className={`obs-audio-check', monitorStart);
  assert.ok(obsGate > modalStart && monitorStart > obsGate && checkStart > monitorStart);
  assert.doesNotMatch(panelSource.slice(0, modalStart), /obs-performer-monitor/);
  assert.match(panelSource.slice(monitorStart, checkStart), /<details/);
  assert.match(panelSource.slice(monitorStart, checkStart), /Headphones/);

  const prefix = 'obs.performerMonitor.';
  const koreanKeys = Object.keys(outputMessageCatalog.ko)
    .filter((key) => key.startsWith(prefix))
    .sort();
  const englishKeys = Object.keys(outputMessageCatalog.en)
    .filter((key) => key.startsWith(prefix))
    .sort();
  assert.deepEqual(englishKeys, koreanKeys);
  assert.equal(koreanKeys.length, 10);
  assert.match(outputMessageCatalog.ko[`${prefix}speakerTestOnly`], /물리 스피커.*측정용.*헤드폰/);
  assert.match(outputMessageCatalog.ko[`${prefix}step.sameClock`], /같은 오디오 인터페이스/);
  assert.match(outputMessageCatalog.ko[`${prefix}step.perSong`], /곡마다.*0.*곡 중간.*하지 않습니다/);
  assert.match(outputMessageCatalog.ko[`${prefix}step.verify`], /5분.*10분.*스트레스 진단/);
  assert.match(outputMessageCatalog.en[`${prefix}step.perSong`], /every song.*position zero.*Never auto-seek/i);
  assert.match(outputMessageCatalog.en[`${prefix}step.verify`], /five-minute.*ten-minute.*stress diagnostic/i);
  assert.match(outputMessageCatalog.ko[`${prefix}policy`], /연결이나 재생을 끊지 않고/);
  assert.match(outputMessageCatalog.ko[`${prefix}policy`], /자동 변경하지 않/);
  assert.match(outputMessageCatalog.en[`${prefix}policy`], /never disconnect/i);
  assert.match(outputMessageCatalog.en[`${prefix}policy`], /never change Sync Offset automatically/i);
});

test('local speaker failures tell the listener what to do and never expose engine codes', async () => {
  const dashboardSource = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');

  assert.match(outputMessageCatalog.ko['playback.localSpeaker.autoplayBlocked'], /재생 버튼을 한 번 눌러/);
  assert.match(outputMessageCatalog.ko['playback.localSpeaker.startFailed'], /다시 재생하거나 버려/);
  assert.match(outputMessageCatalog.en['playback.localSpeaker.autoplayBlocked'], /play button once/i);
  assert.match(outputMessageCatalog.en['playback.localSpeaker.startFailed'], /retry or discard/i);
  assert.doesNotMatch(
    dashboardSource,
    /evidence\.code \|\| t\('playback\.localSpeaker\.loadFailed'\)/,
  );
  assert.match(dashboardSource, /evidence\.code === 'play_rejected'/);
  assert.match(dashboardSource, /evidence\.code === 'media_postcondition_failed'/);
});

test('Speaker is a local choice while every blocked OBS route remains recoverable', async () => {
  const [dashboardSource, panelSource] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    dashboardSource,
    /const selectedOutputMode = outputModePreference;/,
    'the browser-local Speaker choice must not be replaced by a retained OBS lease',
  );
  assert.match(
    dashboardSource,
    /const failedOutputMode = outputSwitchStatus === 'blocked'\s+\? outputSwitchTargetMode\s+: null;/,
    'a rejected target remains diagnostic information without becoming checked',
  );
  assert.match(
    panelSource,
    /const isOptionDisabled = typeof onSelectOutputMode !== 'function'\s+\|\| \(mode === 'obs' && outputSelectionLocked\);/,
  );
  assert.doesNotMatch(
    panelSource,
    /const isOptionDisabled =[^;]*mode === 'speaker'[^;]*outputSelectionLocked/,
    'an OBS failure must never disable the local Speaker route',
  );
  assert.match(
    panelSource,
    /if \(normalizedOutputSwitchState !== 'blocked'[\s\S]*?mode === confirmedOutputMode\) return;\s+onSelectOutputMode\(mode\);/,
    'reselecting the actual route while blocked must reach the controller and clear the failure',
  );
  assert.match(panelSource, /aria-checked=\{isSelected\}/);
  assert.match(dashboardSource, /failedOutputMode=\{failedOutputMode\}/);
});

test('speaker stays clickable while OBS intent waits for writable authority', async () => {
  const [dashboardSource, panelSource] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    panelSource,
    /const outputSelectionLocked = \['conflict', 'switching'\]\.includes\(normalizedOutputSwitchState\)\s+\|\| \(normalizedOutputSwitchState === 'connecting' && !allowOutputSelectionWhileConnecting\)/,
    'only explicitly identified first bootstrap may bypass the normal connecting lock',
  );
  assert.match(dashboardSource, /const \[queuedOutputIntent, setQueuedOutputIntent\] = useState\(null\);/);
  assert.match(dashboardSource, /const OUTPUT_INTENT_WAIT_TIMEOUT_MS = 8_000;/);
  assert.match(
    dashboardSource,
    /setQueuedOutputIntent\(\(current\) => \(current\?\.id === intentId \? null : current\)\)[\s\S]*?setOutputControlRecoveryRequired\(true\)/,
    'a queued route intent must expire and expose explicit control recovery',
  );
  assert.match(dashboardSource, /const \[outputControllerEverReady, setOutputControllerEverReady\] = useState\(false\);/);
  assert.match(dashboardSource, /!outputControllerEverReady\s+&& !outputControllerReady/);
  assert.match(
    dashboardSource,
    /if \(!outputControllerReady\) return;[\s\S]*?claimedOutputIntentRef\.current = queuedOutputIntent\.id;[\s\S]*?setQueuedOutputIntent\(null\);[\s\S]*?dispatchOutputModeSelection\(queuedOutputIntent\.mode\);/,
    'the latest bootstrap choice must wait for writable authority and then dispatch once',
  );
  assert.match(
    dashboardSource,
    /allowOutputSelectionWhileConnecting=\{speakerPlayerMode \|\| outputBootstrapSelectionAvailable\}[\s\S]*?onSelectOutputMode=\{handleSelectOutputMode\}/,
    'the local speaker handler stays available even when OBS control is still connecting',
  );
  assert.match(
    dashboardSource,
    /if \(mode === 'speaker'\) \{[\s\S]*?setOutputModePreference\('speaker'\);[\s\S]*?setQueuedOutputIntent\(null\);[\s\S]*?return;/,
    'speaker selection is immediate and never waits for a server-routed output to deactivate',
  );
  const speakerSelectionStart = dashboardSource.indexOf("if (mode === 'speaker') {");
  const obsSelectionStart = dashboardSource.indexOf('} else {', speakerSelectionStart);
  const speakerSelection = dashboardSource.slice(speakerSelectionStart, obsSelectionStart);
  assert.doesNotMatch(speakerSelection, /selectLocalSpeakerMode|outputControllerReady|outputControlConflict/);
  assert.match(
    dashboardSource,
    /else \{[\s\S]*?outputControlRecoveryRequired \|\| outputControlConflict[\s\S]*?showToast\(t\('onair\.output\.selector\.locked\.unavailable'\)/,
    'OBS activation remains authority-gated inside the route handler',
  );
  assert.match(
    dashboardSource,
    /if \(activeRef\.current\?\.outputMode === 'speaker'\) \{[\s\S]*?onair\.output\.obs\.finishLocalTrackFirst/,
    'a local song must finish before OBS can take over without breaking sync',
  );
  assert.match(panelSource, /aria-checked=\{isSelected\}[\s\S]*?aria-busy=\{isPending \|\| undefined\}/);
  assert.match(dashboardSource, /pendingOutputMode=\{queuedOutputIntent\?\.mode \?\? null\}/);
});

test('safety-locked output clicks explain themselves instead of failing silently', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');

  for (const key of [
    'onair.output.selector.locked.connecting',
    'onair.output.selector.locked.otherTab',
    'onair.output.selector.locked.switching',
    'onair.output.selector.locked.unavailable',
  ]) {
    assert.match(source, new RegExp(key.replaceAll('.', '\\.') ));
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean lock explanation for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English lock explanation for ${key}`);
  }

  assert.match(source, /if \(mode === 'obs' && outputSelectionLocked\) \{[\s\S]*?showToast\?\.\([\s\S]*?t\(outputSelectionLockMessageKey\)/);
  assert.match(source, /title=\{isOptionDisabled \? t\(outputSelectionLockMessageKey\) : undefined\}/);
  assert.ok(outputMessageCatalog.ko['onair.output.selector.status.blockedTarget']?.includes('{{mode}}'));
  assert.ok(outputMessageCatalog.en['onair.output.selector.status.blockedTarget']?.includes('{{mode}}'));
});

test('a durable route-transition timeout uses the localized switch recovery panel', async () => {
  const [dashboardSource, panelSource] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    dashboardSource,
    /outputControlConfirmedReason === 'route_transition_timeout'/,
    'the Worker stability code must map to the same translated recovery UI as the local watchdog',
  );
  assert.match(
    panelSource,
    /const outputRecoveryNeedsEmergencyStop = outputLeaseNeedsEmergencyStop\s+\|\| outputControlRecoveryReason === 'switch_timeout';/,
    'a timed-out unknown route must expose emergency stop instead of entering a reconnect-only loop',
  );
  assert.match(
    panelSource,
    /outputRecoveryNeedsEmergencyStop && !outputControlConflict/,
    'emergency recovery must remain visible alongside timeout reconnect controls',
  );
  assert.ok(outputMessageCatalog.ko['onair.control.recovery.switchTimeout.description']?.trim());
  assert.ok(outputMessageCatalog.en['onair.control.recovery.switchTimeout.description']?.trim());
});

test('route refusal, watchdog recovery, and takeover timeout copy is localized and actionable', async () => {
  const [dashboardSource, panelSource] = await Promise.all([
    readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8'),
  ]);
  const keys = [
    'onair.output.switch.blocked.activeWork',
    'onair.output.switch.blocked.candidate',
    'onair.output.switch.blocked.pending',
    'onair.output.switch.blocked.unknown',
    'onair.output.switch.blocked.notReady',
    'onair.control.takeover.timeout',
    'obs.setup.recovery.emergencyTimeout',
    'onair.control.recovery.connectionTimeout.title',
    'onair.control.recovery.connectionTimeout.description',
    'onair.control.recovery.switchTimeout.title',
    'onair.control.recovery.switchTimeout.description',
    'obs.setup.player.candidate.none',
    'obs.setup.player.candidate.single',
    'obs.setup.player.candidate.duplicate',
    'obs.setup.player.candidate.unknown',
  ];
  for (const key of keys) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean recovery copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English recovery copy for ${key}`);
  }

  assert.equal(
    outputSwitchFailureMessageKey('output_control_active_work'),
    'onair.output.switch.blocked.activeWork',
  );
  assert.equal(
    outputSwitchFailureMessageKey('output_control_candidate_count'),
    'onair.output.switch.blocked.candidate',
  );
  assert.equal(
    outputSwitchFailureMessageKey('output_control_state_unknown'),
    'onair.output.switch.blocked.unknown',
  );
  assert.equal(
    outputSwitchFailureMessageKey('output_control_target_identity_mismatch'),
    'onair.output.switch.blocked.foreignSpeaker',
  );
  assert.match(dashboardSource, /t\(outputSwitchFailureMessageKey\(error\)\)/);
  assert.match(panelSource, /onair\.control\.takeover\.timeout/);
  assert.match(
    panelSource,
    /setControlTransferPhase\('failed'\);[\s\S]*?retryOutputControlRef\.current\(\)/,
    'takeover timeout must rebuild authority state before another CAS attempt',
  );
  assert.match(panelSource, /}, 12_000\);/);
  assert.match(
    panelSource,
    /if \(!isEmergencyStoppingOutput\)[\s\S]*?obs\.setup\.recovery\.emergencyTimeout[\s\S]*?retryOutputControlRef\.current\(\)/,
    'missing emergency-stop evidence must time out into a fresh state check',
  );
  assert.match(panelSource, /\.catch\(\(error\) => \{[\s\S]*?obs\.setup\.recovery\.emergencyFailed/);
  assert.match(
    dashboardSource,
    /const obsPlayerCandidate = outputControl\.outputView\?\.candidates\?\.obs \?\? null;/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /Boolean\([\s\S]{0,120}?eligibleCandidates\?\.obs\?\.length/,
    'duplicate OBS candidates must not be flattened into connected=true',
  );
  assert.match(panelSource, /candidateState=\{onAirPlayerCandidate\?\.state \?\? 'unknown'\}/);
  assert.match(panelSource, /obs\.setup\.player\.candidate\.duplicate[\s\S]*?count: onAirPlayerCandidate\?\.count/);
  assert.ok(outputMessageCatalog.ko['obs.setup.player.candidate.duplicate'].includes('{{count}}'));
  assert.ok(outputMessageCatalog.en['obs.setup.player.candidate.duplicate'].includes('{{count}}'));
});

test('read-only and reconnecting tabs disable OBS mutations but never local Speaker transport', async () => {
  const source = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /const outputAuthorityLocked = selectedOutputMode === 'obs' && \([\s\S]*?normalizedOutputSwitchState === 'connecting'[\s\S]*?\|\| outputControlConflict[\s\S]*?\|\| outputControlUnavailable[\s\S]*?\);/,
  );
  assert.match(source, /const transportControlsLocked = isStarting \|\| controlsLocked \|\| outputAuthorityLocked;/);
  assert.match(source, /onClick=\{toggleMute\}[\s\S]*?disabled=\{transportControlsLocked\}/);
  assert.match(source, /aria-label=\{t\('playback\.control\.volumeForOutput',[\s\S]*?disabled=\{transportControlsLocked\}/);
  assert.match(source, /onClick=\{\(\) => onSkip\(\)\}[\s\S]*?disabled=\{transportControlsLocked\}/);
});

test('a connected but hidden OBS source gets a direct recovery action without full reset', async () => {
  const dashboardSource = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
  const panelSource = await readFile(new URL('../src/components/PlaybackPanel.jsx', import.meta.url), 'utf8');

  assert.match(
    dashboardSource,
    /const obsSourceInactive = connectedObsPlayers\.length === 1[\s\S]*?sourceActive === false[\s\S]*?sourceVisible === false/,
  );
  assert.match(panelSource, /targetSourceInactive: failedSelectionMode === 'obs' && obsSourceInactive/);
  assert.match(panelSource, /activeSourceInactive: selectedOutputMode === 'obs' && obsSourceInactive/);
  assert.match(panelSource, /connectedButInactive=\{obsSourceInactive\}/);
  assert.match(panelSource, /obs\.setup\.player\.candidate\.sourceInactive/);
  assert.match(
    panelSource,
    /const outputNeedsDestructiveReset = outputNeedsAttention && !\([\s\S]*?failedSelectionMode === 'obs' && obsSourceInactive/,
  );

  for (const key of [
    'onair.output.header.blocked.obs.sourceInactive',
    'onair.output.header.active.obs.sourceInactive',
    'onair.output.nextAction.obs.sourceInactive',
    'onair.output.nextAction.obs.sourceInactiveConnected',
    'onair.output.selector.status.sourceInactive',
    'obs.audioCheck.block.sourceInactive',
    'obs.setup.player.candidate.sourceInactive',
  ]) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean hidden-source copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English hidden-source copy for ${key}`);
  }
});

test('compact output header and settings diagnostics have Korean and English copy', () => {
  const keys = [
    'onair.output.header.active.speaker',
    'onair.output.header.active.obs',
    'onair.output.header.standby.speaker',
    'onair.output.header.standby.obs',
    'onair.output.header.active.connecting',
    'onair.output.header.active.switching',
    'onair.output.header.connecting.speaker',
    'onair.output.header.connecting.obs',
    'onair.output.header.blocked.speaker.none',
    'onair.output.header.blocked.speaker.duplicate',
    'onair.output.header.blocked.speaker.foreign',
    'onair.output.header.blocked.obs.none',
    'onair.output.header.blocked.obs.duplicate',
    'onair.output.header.blocked.obs.sourceInactive',
    'onair.output.header.active.obs.sourceInactive',
    'onair.output.header.active.attention',
    'onair.output.header.active.inactive',
    'onair.output.details.title',
    'onair.output.details.description',
    'obs.setup.openLabel',
    'obs.setup.openLabelAttention',
    'obs.setup.recovery.routeUnknown',
    'obs.setup.recovery.emergencyConfirm',
    'obs.setup.recovery.emergencyInProgress',
    'obs.setup.recovery.emergencyFailed',
  ];

  for (const key of keys) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English copy for ${key}`);
  }
});

test('prepare status and control ownership copy is complete in Korean and English', () => {
  const keys = [
    'prepare.badge.ready.label',
    'prepare.badge.ready.title',
    'prepare.badge.preparing.label',
    'prepare.badge.preparing.title',
    'prepare.badge.failed.label',
    'prepare.badge.unavailable.label',
    'prepare.badge.sessionInvalid.label',
    'prepare.badge.sessionEnded.label',
    'prepare.badge.networkError.label',
    'prepare.badge.serverError.label',
    'prepare.badge.temporarilyUnavailable.label',
    'prepare.badge.blocked.label',
    'prepare.badge.reasonDetail',
    'prepare.block.unavailable',
    'prepare.block.failed',
    'prepare.block.sessionInvalid',
    'prepare.block.sessionEnded',
    'prepare.block.networkError',
    'prepare.block.serverError',
    'prepare.block.temporarilyUnavailable',
    'prepare.block.blocked',
    'prepare.block.preparing',
    'prepare.action.retry.label',
    'prepare.action.retry.title',
    'prepare.action.retry.notice',
    'prepare.action.refreshConnection.label',
    'prepare.action.refreshConnection.title',
    'prepare.action.playNow.title',
    'queue.region.label',
    'queue.heading',
    'queue.action.clear.title',
    'queue.autoplay.summary',
    'queue.autoplay.on',
    'queue.autoplay.off',
    'queue.autoplay.label',
    'queue.empty',
    'queue.action.playNow.label',
    'queue.action.remove.title',
    'queue.localFile.requiredLabel',
    'queue.localFile.restoreLabel',
    'queue.localFile.restoringLabel',
    'queue.localFile.inputLabel',
    'queue.localFile.restoreQueueTitle',
    'queue.localFile.restoreHistoryTitle',
    'queue.localFile.restoreMissing',
    'queue.localFile.restoreFailed',
    'queue.localFile.restoredQueue',
    'queue.localFile.restoredHistory',
    'queue.history.summary',
    'queue.history.manual.title.placeholder',
    'queue.history.manual.title.label',
    'queue.history.manual.artist.placeholder',
    'queue.history.manual.artist.label',
    'queue.history.manual.add.title',
    'queue.history.manual.add.label',
    'queue.history.empty',
    'queue.history.reorder.title',
    'queue.history.replay.title',
    'queue.history.replay.unavailableTitle',
    'queue.history.remove.title',
    'queue.history.showOlder',
    'queue.history.showNewer',
    'queue.history.showLatest',
    'onair.output.header.control.otherTab',
    'onair.output.selector.status.otherTab',
    'onair.control.otherTab.title',
    'onair.control.otherTab.description',
    'onair.control.takeover.action',
    'onair.control.takeover.stopAndAction',
    'onair.control.takeover.stopping',
    'onair.control.takeover.claiming',
    'onair.control.takeover.retry',
    'onair.control.takeover.failed',
    'onair.control.unavailable.title',
    'onair.control.unavailable.description',
    'onair.control.unavailable.action',
    'onair.control.unavailable.inProgress',
    'onair.control.unavailable.failed',
  ];

  for (const key of keys) {
    assert.ok(outputMessageCatalog.ko[key]?.trim(), `missing Korean copy for ${key}`);
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing English copy for ${key}`);
  }
});

test('initial output setup copy is calm and does not claim a server failure', () => {
  assert.equal(outputMessageCatalog.ko['onair.output.header.active.connecting'], '재생 준비 중');
  assert.equal(outputMessageCatalog.en['onair.output.header.active.connecting'], 'Preparing playback');
  assert.doesNotMatch(outputMessageCatalog.ko['onair.output.selector.status.connecting'], /서버|실패|오류/);
  assert.match(outputMessageCatalog.ko['onair.output.selector.status.connecting'], /정상 단계/);
  assert.match(outputMessageCatalog.en['onair.output.selector.status.connecting'], /normal/i);
  assert.doesNotMatch(outputMessageCatalog.ko['obs.setup.server.connecting'], /대기|실패|오류/);
  assert.match(outputMessageCatalog.ko['obs.setup.player.waiting'], /아직 열리지 않았습니다/);
  assert.match(outputMessageCatalog.ko['obs.setup.display.waiting'], /아직 열리지 않았습니다/);
  for (const key of [
    'obs.setup.server.connecting',
    'obs.setup.player.waiting',
    'obs.setup.display.waiting',
  ]) {
    assert.ok(outputMessageCatalog.en[key]?.trim(), `missing calm English setup copy for ${key}`);
  }
});

test('QueuePanel uses translation keys and no longer displays the ambiguous server-wait label', async () => {
  const source = await readFile(new URL('../src/components/QueuePanel.jsx', import.meta.url), 'utf8');
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /서버 연결 대기/);
  assert.doesNotMatch(executableSource, /[가-힣]/, 'visible QueuePanel copy must use translation keys');
  const usedKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  const missingKorean = [...new Set(usedKeys)]
    .filter((key) => !Object.hasOwn(outputMessageCatalog.ko, key));
  const missingEnglish = [...new Set(usedKeys)]
    .filter((key) => !Object.hasOwn(outputMessageCatalog.en, key));
  assert.deepEqual(missingKorean, []);
  assert.deepEqual(missingEnglish, []);
  assert.match(source, /prepare\.badge\.sessionInvalid\.label/);
  assert.match(source, /prepare\.badge\.sessionEnded\.label/);
  assert.match(source, /prepare\.badge\.networkError\.label/);
  assert.match(source, /prepare\.badge\.serverError\.label/);
  assert.match(source, /prepare\.action\.refreshConnection\.label/);
});

test('the output selector state contract has Korean fallback copy for every public action and gate', () => {
  const camel = (value) => value.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
  const required = new Set([
    ...Object.values(ON_AIR_OUTPUT_ACTIONS)
      .map((action) => `onair.output.action.${action}.label`),
    ...Object.values(ON_AIR_OUTPUT_GATE_CODES)
      .map((code) => `onair.output.gate.${camel(code)}`),
    ...Object.values(ON_AIR_OUTPUT_LEASE_STATES)
      .map((state) => `onair.output.lease.${state}`),
    ...[...Object.values(ON_AIR_OUTPUT_MODES), 'unselected']
      .map((mode) => `onair.output.mode.${mode}`),
    ...['none', 'single', 'duplicate', 'unknown']
      .map((state) => `onair.output.candidate.${state}`),
    ...['matched', 'pending', 'conflict', 'unknown']
      .map((state) => `onair.output.playback.${state}`),
    ...['active', 'inactive', 'unknown']
      .map((state) => `onair.output.test.${state}`),
    ...['unavailable', 'invalid', 'unknown', 'localEventSent', 'localOnly', 'standby']
      .map((state) => `onair.output.adapter.${state}`),
    ...['speaker', 'obs', 'unselected'].flatMap((mode) => [
      `onair.output.status.${mode}.routeReady`,
      `onair.output.status.${mode}.playerPlaying`,
    ]),
    ...[
      'invalidInput',
      'stateUnknown',
      'activationFailed',
      'emergencyStopping',
      'deactivating',
      'activating',
      'candidateMissing',
      'candidateDuplicate',
      'inactive',
    ].map((status) => `onair.output.status.${status}`),
    'onair.output.verification.unknown',
    'onair.output.verification.stale',
    ...['speakerPlayback', 'obsMixer', 'obsRecording', 'obsStreamArtifact', 'karaokeSync']
      .flatMap((scope) => [
        `onair.output.verification.${scope}.passed`,
        `onair.output.verification.${scope}.stale`,
      ]),
  ]);

  const missing = [...required].filter((key) => !Object.hasOwn(outputMessageCatalog.ko, key));
  assert.deepEqual(missing, []);
});
