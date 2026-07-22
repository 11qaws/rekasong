import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const scriptUrl = new URL('../scripts/obs-v2-external-cef-soak.mjs', import.meta.url);

test('external CEF soak keeps the player credential in a short-lived handoff file', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  assert.match(source, /mkdtemp\(join\(tmpdir\(\), 'rekasong-cef-soak-'\)\)/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /console\.log\(`SETUP_FILE \$\{setupFile\}`\)/);
  assert.match(source, /console\.log\(`STATUS_FILE \$\{statusFile\}`\)/);
  assert.match(source, /REKASONG_CEF_SOAK_STATUS_FILE/);
  assert.match(source, /Refresh cache of current page/);
  assert.match(source, /REKASONG_CEF_SOAK_CANDIDATE_STABLE_MS/);
  assert.match(source, /REKASONG_CEF_SOAK_CANDIDATE_STABLE_MS',\s*75_000/);
  assert.match(source, /REKASONG_CEF_SOAK_RECONNECT_GRACE_MS',\s*60_000/);
  assert.match(source, /async function waitForStableObsCandidate\(\)/);
  assert.match(source, /function recoverControlConnection\(snapshot, now = Date\.now\(\)\)/);
  assert.match(source, /coordinator\.connect\(\)/);
  assert.match(source, /'soak_control_reconnecting'/);
  assert.match(source, /stableForMs >= CANDIDATE_STABLE_MS/);
  assert.match(source, /candidateTransitions \+= 1/);
  assert.match(source, /await writeStatus\('candidate_connected'/);
  assert.match(source, /await writeStatus\('uploading_asset'/);
  assert.match(source, /await writeStatus\('asset_uploaded'/);
  assert.match(source, /console\.log\('CEF_CANDIDATE_CONNECTED'\)/);
  assert.match(source, /await writeStatus\('soak_playing'/);
  assert.match(source, /await writeStatus\('natural_end'/);
  assert.match(source, /await writeStatus\('passed'\)/);
  assert.match(source, /await writeStatus\('failed'/);
  assert.match(source, /await removeSetupHandoff\(\);[\s\S]*?external OBS CEF candidate connected/);
  assert.doesNotMatch(
    source,
    /console\.(?:log|error)\([^\n]*playerUrl\(/,
    'the credential-bearing player URL must never be written to stdout',
  );
});

test('external CEF soak enforces bounded media and exact route cleanup', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  assert.match(source, /const MAX_ASSET_BYTES = 64 \* 1024 \* 1024;/);
  assert.ok(
    source.indexOf('const stableCandidate = await waitForStableObsCandidate();')
      < source.indexOf('const assetId = await uploadSoakAsset(assetBytes);'),
    'the large media upload must happen only after one stable OBS candidate is proven',
  );
  assert.match(source, /candidateIds\.length === 1/);
  assert.match(source, /routeObservations\.length = 0/);
  assert.match(source, /snapshot\.confirmedPlayback\?\.status === 'ready'/);
  assert.match(source, /snapshot\?\.confirmedPlayback\?\.status === 'playing'/);
  assert.match(source, /external OBS CEF natural end/);
  assert.match(source, /unsafeObservations\.length === 0/);
  assert.match(source, /observation\.unknownLockCode !== ON_AIR_CONTROL_COORDINATOR_CODES\.CONNECTION_LOST/);
  assert.match(source, /observation\.ready && observation\.unknownLockCode === null/);
  assert.match(source, /controlDisconnectCount/);
  assert.match(source, /controlReconnectAttemptCount/);
  assert.match(source, /maxControlGapMs/);
  assert.match(source, /observation\.playerCount !== 1/);
  assert.match(source, /observation\.obsCandidateCount !== 1/);
  assert.match(
    source,
    /const stop = coordinator\.stop\(\);[\s\S]*?const deactivation = coordinator\.deactivateOutput\(\);[\s\S]*?coordinator\.endSession\(\);/,
  );
  assert.match(source, /response\.status === 410 && body\?\.status === 'ended'/);
});

test('package exposes the external CEF soak as an explicit opt-in command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['test:obs:v2:cef-soak'],
    'node scripts/obs-v2-external-cef-soak.mjs',
  );
});

test('external CEF recovery requires explicit source refresh and OBS restart actions', async () => {
  const source = await readFile(scriptUrl, 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(source, /const RECOVERY_MODE = process\.argv\.includes\('--recovery'\)/);
  assert.match(source, /await writeStatus\('awaiting_source_refresh'/);
  assert.match(source, /console\.log\('ACTION_REFRESH_SOURCE'\)/);
  assert.match(source, /await writeStatus\('awaiting_obs_restart'/);
  assert.match(source, /console\.log\('ACTION_RESTART_OBS'\)/);
  assert.match(source, /candidate\.playerInstanceId === previousPlayerInstanceId/);
  assert.match(source, /protocol\.confirmedPlayback\?\.reasonCode === 'target_disconnected'/);
  assert.match(source, /coordinator\.emergencyStop\(\{ forceReset: true \}\)/);
  assert.match(source, /protocol\.confirmedPlayback\.reasonCode === 'output_inactive'/);
  assert.match(source, /protocol\.confirmedPlayback\.recoveryOverride === true/);
  assert.match(source, /protocol\.confirmedPlayback\.missingTargetUnverified === true/);
  assert.match(source, /silent\.activeFamily === null/);
  assert.match(source, /silent\.desiredTransport\?\.status === 'stopped'/);
  assert.match(source, /silent\.confirmedPlayback\?\.reasonCode === 'output_ready_no_playback'/);
  assert.equal(
    packageJson.scripts['test:obs:v2:cef-recovery'],
    'node scripts/obs-v2-external-cef-soak.mjs --recovery',
  );
});
