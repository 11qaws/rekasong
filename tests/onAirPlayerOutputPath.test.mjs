import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { transformWithOxc } from 'vite';

import { evaluateOnAirPlayerOutputPath } from '../src/lib/onAirPlayerOutputPath.js';
import { PLAYER_CLIENT_KINDS } from '../src/lib/onAirProtocol.js';

const safeStandby = () => ({
  audio: { isConnected: true },
  engine: { mediaPaused: true, sourceAttached: false },
  signal: { aborted: false },
});

test('dashboard speaker readiness needs only a live DOM audio element and exact safe standby', () => {
  const result = evaluateOnAirPlayerOutputPath({
    clientKind: PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER,
    ...safeStandby(),
  });

  assert.deepEqual(result, { ready: true });
  assert.equal(Object.isFrozen(result), true);
});

test('dashboard speaker fails closed for abort, DOM detach, playback, or an attached source', () => {
  const scenarios = [
    { signal: { aborted: true } },
    { audio: { isConnected: false } },
    { engine: { mediaPaused: false, sourceAttached: false } },
    { engine: { mediaPaused: true, sourceAttached: true } },
  ];

  for (const override of scenarios) {
    const result = evaluateOnAirPlayerOutputPath({
      clientKind: PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER,
      ...safeStandby(),
      ...override,
    });
    assert.equal(result.ready, false);
  }
});

test('OBS and generic routes require the binding and reject explicit inactive evidence', () => {
  for (const clientKind of [
    PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE,
    PLAYER_CLIENT_KINDS.GENERIC_BROWSER,
  ]) {
    assert.equal(evaluateOnAirPlayerOutputPath({
      clientKind,
      ...safeStandby(),
      obsAttestation: { detected: true, sourceActive: true },
    }).ready, true);

    assert.equal(evaluateOnAirPlayerOutputPath({
      clientKind,
      ...safeStandby(),
      obsAttestation: { detected: false, sourceActive: true },
    }).ready, false);

    assert.equal(evaluateOnAirPlayerOutputPath({
      clientKind,
      ...safeStandby(),
      obsAttestation: { detected: true, sourceActive: false },
    }).ready, false);

    assert.equal(evaluateOnAirPlayerOutputPath({
      clientKind,
      ...safeStandby(),
      obsAttestation: { detected: true },
    }).ready, true);
  }
});

test('component wiring keeps auto-detection default and fixes dashboard speaker identity', async () => {
  const playerPath = fileURLToPath(new URL('../src/components/OnAirPlayerV2.jsx', import.meta.url));
  const wrapperPath = fileURLToPath(new URL('../src/components/DashboardSpeakerPlayerV2.jsx', import.meta.url));
  const [player, wrapper] = await Promise.all([
    readFile(playerPath, 'utf8'),
    readFile(wrapperPath, 'utf8'),
  ]);

  await transformWithOxc(player, playerPath, { lang: 'jsx' });
  await transformWithOxc(wrapper, wrapperPath, { lang: 'jsx' });

  assert.match(player, /clientKind: requestedClientKind = null/);
  assert.match(player, /identity = null/);
  assert.match(player, /generatedIdentityRef\.current = createPlayerPageIdentity\(\)/);
  assert.match(player, /identity: typeof identityLifecycleKey === 'string'/);
  assert.match(
    player,
    /\[apiBaseUrl, identityLifecycleKey, requestedClientKind, room, token\]/,
    'equivalent identity objects must not dispose an established OBS media graph',
  );
  assert.doesNotMatch(
    player,
    /\[apiBaseUrl, identity, requestedClientKind, room, token\]/,
  );
  assert.match(player, /requestedClientKind \|\| \(runtime\.capabilities\.obsRuntime/);
  assert.match(player, /runtime = isDashboardSpeaker\s*\? null\s*: createObsRuntimeAttestation/);
  assert.match(
    player,
    /onChange\(snapshot\)[\s\S]*?adapter\?\.handleRuntimeAttestation\(snapshot, \{ phase: 'obs_callback' \}\)/,
    'OBS runtime source events must synchronously reach the local playback safety adapter',
  );
  assert.match(player, /runtimeProbe: \(\) => runtime\?\.runtime\(\) \|\| \{\}/);
  assert.match(
    player,
    /clientKind,\s+identity: typeof identityLifecycleKey === 'string'[\s\S]*?capabilities:/,
  );
  assert.match(player, /safeNotify\(callbacksRef\.current\.onStateChange, change\)/);
  assert.match(player, /safeNotify\(callbacksRef\.current\.onSnapshot, snapshot\)/);

  const spreadIndex = wrapper.indexOf('{...props}');
  const fixedKindIndex = wrapper.indexOf('clientKind={PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER}');
  assert.ok(spreadIndex >= 0 && fixedKindIndex > spreadIndex, 'fixed clientKind must override caller props');
});

test('dashboard speaker is browser-local while OBS control reconnect stays bounded', async () => {
  const dashboardPath = fileURLToPath(new URL('../src/pages/Dashboard.jsx', import.meta.url));
  const playbackPanelPath = fileURLToPath(new URL('../src/components/PlaybackPanel.jsx', import.meta.url));
  const [source, playbackPanel] = await Promise.all([
    readFile(dashboardPath, 'utf8'),
    readFile(playbackPanelPath, 'utf8'),
  ]);

  await transformWithOxc(source, dashboardPath, { lang: 'jsx' });
  await transformWithOxc(playbackPanel, playbackPanelPath, { lang: 'jsx' });

  assert.match(source, /const outputControllerReady = outputControlAuthority\.writable;/);
  assert.doesNotMatch(source, /dashboardSpeakerIdentityRef|createPlayerPageIdentity/);
  assert.match(
    source,
    /const DashboardLocalSpeaker = lazy\(\(\) => import\('\.\.\/components\/DashboardLocalSpeaker'\)\)/,
  );
  assert.match(
    source,
    /const \[obsControlRequested, setObsControlRequested\] = useState\(false\);/,
    'a new page must start as a normal Speaker player without OBS control intent',
  );
  assert.match(
    source,
    /useOnAirSession\([\s\S]*?\{ enabled: obsControlRequested, observeOnly: true \}[\s\S]*?\);/,
    'the legacy OBS observer must remain dormant until OBS is explicitly selected',
  );
  assert.match(
    source,
    /useOnAirOutputControl\(\{[\s\S]*?enabled: obsControlRequested\s+&& onAir\.configured/,
    'the authoritative OBS controller must remain dormant during Speaker listening',
  );
  assert.match(
    source,
    /const outputControlUnavailable = obsControlRequested\s+&& !outputControlTakeoverPending/,
    'a dormant OBS controller must not turn into a visible Speaker route failure',
  );
  assert.match(
    source,
    /const outputBootstrapSelectionAvailable = !obsControlRequested \|\| Boolean\(/,
    'the first explicit OBS click must be allowed to start the controller bootstrap',
  );
  assert.match(
    source,
    /<DashboardLocalSpeaker[\s\S]*?ref=\{localSpeakerRef\}[\s\S]*?onEvidence=\{handleLocalSpeakerEvidence\}/,
    'the dashboard must host its own local player without a Worker route lease',
  );
  assert.match(
    source,
    /createBoundedCommandQueue\([\s\S]*?LOCAL_SPEAKER_COMMAND_WAIT_TIMEOUT_MS[\s\S]*?localSpeakerCommandQueueRef\.current\.enqueue\(command\)[\s\S]*?localSpeakerState === 'ready'[\s\S]*?localSpeakerCommandQueueRef\.current\.drain/,
    'a first Speaker click must wait for the local element instead of surfacing a route lock',
  );
  assert.match(
    source,
    /LOCAL_SPEAKER_COMMAND_WAIT_TIMEOUT_MS = 12_000[\s\S]*?timeoutError: \(\) => new Error\(t\('playback\.localSpeaker\.notReady'\)\)/,
    'a missing local player must reject its queued command instead of waiting forever',
  );
  assert.doesNotMatch(
    source,
    /if \(useOnAirPlayer && !onAirSession\) \{[\s\S]*?retryLocalSpeakerSession\(\)/,
    'a local Speaker command must not create a media session while its lazy element mounts',
  );
  assert.match(
    source,
    /if \(!localSpeaker\) \{\s+if \(localSpeakerState === 'initializing'\) return queueLocalSpeakerCommand\(command\);/,
    'the first local command waits only for the page-owned player element',
  );
  assert.doesNotMatch(source, /DashboardSpeakerPlayerV2|shouldHostDashboardSpeaker|rekasong-output-owner/);
  assert.doesNotMatch(source, /const selectLocalSpeakerMode = outputControl\.selectLocalSpeakerMode;/);
  assert.match(source, /const selectedOutputMode = outputModePreference;/);
  assert.match(source, /const speakerPlayerMode = selectedOutputMode === 'speaker';/);
  assert.match(
    source,
    /const outputRouteStable = speakerPlayerMode \? true : establishedObsRouteConnected;/,
    'media bootstrap failures must not relabel the local Speaker selection as an unverified route',
  );
  assert.match(
    source,
    /const establishedObsRouteConnected = Boolean\([\s\S]*?\['ready', 'audible'\]\.includes\(activeOutputLease\?\.status\)[\s\S]*?activeOutputPlayer\?\.clientKind === 'obs-browser-source'/,
    'an established live OBS route must depend on the live leased socket, not scene telemetry',
  );
  assert.match(
    source,
    /establishedObsRouteConnected && activeOutputPlayer\?\.heartbeatStale[\s\S]*?onair\.output\.status\.obs\.heartbeatDelayed/,
    'delayed OBS telemetry must be shown without replacing the established route',
  );
  assert.match(
    source,
    /const obsSourceTemporarilyInactive[\s\S]*?onair\.output\.status\.obs\.sceneInactive/,
    'scene visibility must be reported without disconnecting an established route',
  );
  assert.match(
    source,
    /const handleSeek = \(time\) => \{[\s\S]*?if \(useOnAirPlayer\) \{[\s\S]*?dispatchPlaybackCommand\(\{[\s\S]*?type: 'seek'/,
    'local speaker seek must use the local transport instead of the legacy hidden media ref',
  );
  const speakerSelectionStart = source.indexOf("if (mode === 'speaker') {");
  const obsSelectionStart = source.indexOf('} else {', speakerSelectionStart);
  const speakerSelection = source.slice(speakerSelectionStart, obsSelectionStart);
  const obsSelectionEnd = source.indexOf('outputIntentSequenceRef.current += 1;', obsSelectionStart);
  const obsSelection = source.slice(obsSelectionStart, obsSelectionEnd);
  assert.doesNotMatch(
    speakerSelection,
    /outputControllerReady|outputControlConflict|outputControlUnavailable|selectLocalSpeakerMode/,
    'Speaker selection must never wait for OBS authority or a server route transition',
  );
  assert.doesNotMatch(
    speakerSelection,
    /setObsControlRequested\(false\)/,
    'same-page Speaker recovery keeps an already-started OBS controller alive for cleanup',
  );
  assert.match(
    obsSelection,
    /setObsControlRequested\(true\)/,
    'only an explicit OBS selection may wake the OBS controller',
  );
  assert.match(
    source,
    /const runOutputMode = outputMode === 'obs' \|\| outputMode === 'speaker'[\s\S]*?outputModePreference === 'obs' \? 'obs' : 'speaker'/,
    'new playback must follow the local route choice instead of a stale OBS lease',
  );
  assert.match(
    source,
    /if \(actualOutputMode !== 'obs' && activeRef\.current\?\.outputMode !== 'obs'\) return;/,
    'late Worker transport snapshots must not overwrite a browser-local speaker timeline',
  );
  assert.match(
    source,
    /activeRef\.current\?\.outputMode === 'speaker'[\s\S]*?\['playing', 'paused', 'buffering'\]\.includes\(activeRef\.current\?\.phase\)[\s\S]*?onAirSessionRecoveryGate\.claim\(\)/,
    'session credential rotation must preserve buffered playback but recover starting or failed attempts',
  );
  assert.match(source, /const releasedOwnerRetryRef = useRef\(null\);/);
  assert.match(
    source,
    /if \(releasedOwnerRetryRef\.current === retryKey\) return undefined;\s+releasedOwnerRetryRef\.current = retryKey;/,
    'the released-owner epoch must be consumed before scheduling reconnect',
  );
  const releasedOwnerStart = source.indexOf('const releasedOwnerRetryRef = useRef(null);');
  const transportRecoveryStart = source.indexOf('// A transport drop is different', releasedOwnerStart);
  const releasedOwnerRecovery = source.slice(releasedOwnerStart, transportRecoveryStart);
  assert.equal(
    [...releasedOwnerRecovery.matchAll(/retryOnAirOutputControl\(\)/g)].length,
    1,
    'released-owner recovery has one explicit retry site and no reconnect loop',
  );
  assert.match(
    source,
    /if \(outputControl\.snapshot\?\.ready === true\) \{[\s\S]*?window\.setTimeout\(\(\) => \{[\s\S]*?attempts = 0;[\s\S]*?\}, 10_000\);/,
    'a flapping READY state must not replenish the bounded reconnect budget immediately',
  );
  assert.match(
    playbackPanel,
    /const isSelectedRouteInvalid = selectedOutputMode === 'obs' && isOnAirInvalid;/,
    'an expired OBS session must not poison the browser-local Speaker status',
  );
  assert.match(
    playbackPanel,
    /isSessionInvalid: isSelectedRouteInvalid \|\| outputRouteStateUnknown/,
  );
  assert.match(
    playbackPanel,
    /const outputAuthorityLocked = selectedOutputMode === 'obs' && \(/,
    'OBS authority loss must not disable normal Speaker transport controls',
  );
  assert.match(
    playbackPanel,
    /const isOptionDisabled = typeof onSelectOutputMode !== 'function'[\s\S]*?mode === 'obs' && outputSelectionLocked/,
    'Speaker must remain selectable even when the OBS option is locked',
  );
});
