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
