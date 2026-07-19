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

test('OBS and generic routes retain the existing detected and active source attestation gates', () => {
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
  assert.match(player, /requestedClientKind \|\| \(runtime\.capabilities\.obsRuntime/);
  assert.match(player, /runtime = isDashboardSpeaker\s*\? null\s*: createObsRuntimeAttestation/);
  assert.match(player, /runtimeProbe: \(\) => runtime\?\.runtime\(\) \|\| \{\}/);
  assert.match(player, /safeNotify\(callbacksRef\.current\.onStateChange, change\)/);
  assert.match(player, /safeNotify\(callbacksRef\.current\.onSnapshot, snapshot\)/);

  const spreadIndex = wrapper.indexOf('{...props}');
  const fixedKindIndex = wrapper.indexOf('clientKind={PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER}');
  assert.ok(spreadIndex >= 0 && fixedKindIndex > spreadIndex, 'fixed clientKind must override caller props');
});

test('dashboard speaker ownership and released-owner reconnect stay authority-gated', async () => {
  const dashboardPath = fileURLToPath(new URL('../src/pages/Dashboard.jsx', import.meta.url));
  const source = await readFile(dashboardPath, 'utf8');

  await transformWithOxc(source, dashboardPath, { lang: 'jsx' });

  assert.match(source, /const outputControllerReady = outputControlAuthority\.writable;/);
  assert.match(
    source,
    /\{useOnAirPlayer && shouldHostDashboardSpeaker && onAirSession\?\.room && onAirSession\?\.playerToken && \(/,
    'only the page-lifetime authority owner may host the dashboard speaker player',
  );
  assert.match(source, /const dashboardSpeakerOwnershipRef = useRef\(\{[\s\S]*?sessionKey: null,[\s\S]*?held: false,[\s\S]*?controlInstanceId: null,/);
  assert.match(source, /else if \(outputControlConflict\s+\|\| \(outputControlUnavailable && outputConnectionState === 'ready'\)\) \{\s+dashboardSpeakerOwnershipRef\.current\.held = false;/);
  assert.match(source, /new globalThis\.BroadcastChannel\(`rekasong-output-owner:\$\{onAirSession\.room\}`\)/);
  assert.match(source, /if \(!preservingDashboardSpeakerDuringReconnect\) return undefined;[\s\S]*?\}, 8_000\);/);
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
});
