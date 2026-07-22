import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';
import {
  createHarnessDiagnosticSanitizer,
  omittedHttpBodyErrorMessage,
} from './obs-v2-harness-safety.mjs';

const WORKER = process.env.REKASONG_WORKER || 'http://127.0.0.1:8787';
const APP = process.env.REKASONG_APP || 'http://127.0.0.1:5100';
const ASSET_PATH = process.env.REKASONG_CEF_SOAK_ASSET || '';
const ASSET_MIME = process.env.REKASONG_CEF_SOAK_MIME || 'audio/mp4';
const EXPECTED_DURATION_MS = positiveIntegerEnvironment('REKASONG_CEF_SOAK_DURATION_MS', 60_000);
const CONTROL_READY_TIMEOUT_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_CONTROL_TIMEOUT_MS',
  10_000,
);
const CANDIDATE_TIMEOUT_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_CANDIDATE_TIMEOUT_MS',
  300_000,
);
const CANDIDATE_STABLE_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_CANDIDATE_STABLE_MS',
  75_000,
);
const COMMAND_TIMEOUT_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_COMMAND_TIMEOUT_MS',
  20_000,
);
const PLAYBACK_GRACE_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_PLAYBACK_GRACE_MS',
  30_000,
);
const PROGRESS_INTERVAL_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_PROGRESS_INTERVAL_MS',
  30_000,
);
const CONTROL_RECONNECT_GRACE_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_SOAK_RECONNECT_GRACE_MS',
  60_000,
);
const EXTERNAL_STATUS_FILE = process.env.REKASONG_CEF_SOAK_STATUS_FILE || '';
const RECOVERY_MODE = process.argv.includes('--recovery');
const RECOVERY_ACTION_TIMEOUT_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_RECOVERY_ACTION_TIMEOUT_MS',
  600_000,
);
const RECOVERY_SILENCE_OBSERVATION_MS = positiveIntegerEnvironment(
  'REKASONG_CEF_RECOVERY_SILENCE_MS',
  5_000,
);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

let coordinator = null;
let session = null;
let sessionEnded = false;
let temporaryDirectory = null;
let setupFile = null;
let statusFile = EXTERNAL_STATUS_FILE || null;
let progressTimer = null;
let stopRequested = false;
let controlGapStartedAt = null;
let nextControlReconnectAt = 0;
let controlDisconnectCount = 0;
let controlReconnectAttemptCount = 0;
let currentControlReconnectAttempts = 0;
let maxControlGapMs = 0;
const commandResults = new Map();
const routeObservations = [];
const diagnostics = createHarnessDiagnosticSanitizer();

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${raw}`);
  }
  return parsed;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pass(label, detail = '') {
  console.log(diagnostics.text(`PASS ${label}${detail ? ` - ${detail}` : ''}`));
}

function invariant(condition, label, detail = '') {
  if (condition) {
    pass(label, detail);
    return;
  }
  throw new Error(diagnostics.text(`${label}${detail ? `: ${detail}` : ''}`));
}

function commandFailure(commandId) {
  const result = commandResults.get(commandId);
  if (!result) return null;
  if (result.status === 'rejected' || result.status === 'outcome_unknown'
    || result.entry?.state === 'rejected' || result.entry?.state === 'outcome_unknown') {
    return result;
  }
  return null;
}

function finishRecoveredControlGap(now = Date.now()) {
  if (controlGapStartedAt === null) return;
  maxControlGapMs = Math.max(maxControlGapMs, now - controlGapStartedAt);
  controlGapStartedAt = null;
  nextControlReconnectAt = 0;
  currentControlReconnectAttempts = 0;
}

function recoverControlConnection(snapshot, now = Date.now()) {
  if (snapshot?.unknownLock?.code !== ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST) {
    return false;
  }
  if (controlGapStartedAt === null) {
    controlGapStartedAt = now;
    controlDisconnectCount += 1;
  }
  const gapMs = now - controlGapStartedAt;
  if (gapMs > CONTROL_RECONNECT_GRACE_MS) {
    throw new Error(`control reconnect exceeded ${CONTROL_RECONNECT_GRACE_MS}ms grace`);
  }
  if (['disconnected', 'closed'].includes(snapshot.state) && now >= nextControlReconnectAt) {
    const attempt = currentControlReconnectAttempts;
    const delay = Math.min(30_000, 1_500 * (1.5 ** attempt));
    nextControlReconnectAt = now + delay;
    currentControlReconnectAttempts += 1;
    controlReconnectAttemptCount += 1;
    try {
      coordinator.connect();
    } catch {
      // The next polling pass re-reads state and retries with bounded backoff.
    }
  }
  return true;
}

function assertHealthy({ allowSessionEnded = false, commandId = null } = {}) {
  if (stopRequested) throw new Error('external CEF soak interrupted');
  if (commandId) {
    const failure = commandFailure(commandId);
    if (failure) throw new Error(`command ${commandId} failed: ${diagnostics.json(failure)}`);
  }
  const snapshot = coordinator?.snapshot?.();
  const lock = snapshot?.unknownLock;
  if (!lock) finishRecoveredControlGap();
  if (lock && !(allowSessionEnded
    && lock.code === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED)) {
    if (recoverControlConnection(snapshot)) return;
    throw new Error(`coordinator entered unknown state: ${diagnostics.json(lock)}`);
  }
}

async function waitFor(predicate, timeoutMs, label, options = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertHealthy(options);
    const result = await predicate();
    if (result) return result;
    await sleep(100);
  }
  assertHealthy(options);
  const snapshot = coordinator?.snapshot?.();
  throw new Error(`${label} timed out after ${timeoutMs}ms: ${diagnostics.json({
    ready: snapshot?.ready,
    writable: snapshot?.writable,
    unknownLock: snapshot?.unknownLock,
    players: snapshot?.playerSnapshot?.players,
    eligibleCandidates: snapshot?.playerSnapshot?.eligibleCandidates,
    lease: snapshot?.playerSnapshot?.lease,
    activeFamily: snapshot?.playerSnapshot?.activeFamily,
    confirmedPlayback: snapshot?.playerSnapshot?.confirmedPlayback,
  })}`);
}

function currentObsCandidate() {
  const snapshot = coordinator.snapshot().playerSnapshot;
  const candidateIds = snapshot?.eligibleCandidates?.obs || [];
  const player = snapshot?.players?.find((entry) => entry.playerInstanceId === candidateIds[0]);
  return candidateIds.length === 1
    && player?.clientKind === 'obs-browser-source'
    && player.runtime?.sourceActive !== false
    && player.runtime?.sourceVisible !== false
    ? player
    : null;
}

async function waitForStableObsCandidate() {
  const deadline = Date.now() + CANDIDATE_TIMEOUT_MS;
  let candidateId = null;
  let lastObservedCandidateId = null;
  let candidateTransitions = 0;
  let stableSince = 0;
  let lastStatusAt = 0;
  while (Date.now() < deadline) {
    assertHealthy();
    const candidate = currentObsCandidate();
    const now = Date.now();
    if (!candidate) {
      candidateId = null;
      stableSince = 0;
    } else if (candidate.playerInstanceId !== candidateId) {
      if (lastObservedCandidateId !== null
        && candidate.playerInstanceId !== lastObservedCandidateId) {
        candidateTransitions += 1;
      }
      candidateId = candidate.playerInstanceId;
      lastObservedCandidateId = candidate.playerInstanceId;
      stableSince = now;
      lastStatusAt = 0;
    }

    if (candidate && candidate.playerInstanceId === candidateId) {
      const stableForMs = now - stableSince;
      if (stableForMs >= CANDIDATE_STABLE_MS) {
        return { candidate, candidateTransitions };
      }
      if (now - lastStatusAt >= 1_000) {
        await writeStatus('candidate_stabilizing', {
          stableForMs,
          requiredStableMs: CANDIDATE_STABLE_MS,
          candidateTransitions,
        });
        lastStatusAt = now;
      }
    }
    await sleep(100);
  }

  assertHealthy();
  const snapshot = coordinator?.snapshot?.();
  throw new Error(`one stable external OBS CEF candidate timed out after ${CANDIDATE_TIMEOUT_MS}ms: ${diagnostics.json({
    requiredStableMs: CANDIDATE_STABLE_MS,
    players: snapshot?.playerSnapshot?.players,
    eligibleCandidates: snapshot?.playerSnapshot?.eligibleCandidates,
    lease: snapshot?.playerSnapshot?.lease,
    confirmedPlayback: snapshot?.playerSnapshot?.confirmedPlayback,
  })}`);
}

async function waitForCleanup(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function websocketUrl(room, token) {
  const url = new URL(`/v1/sessions/${encodeURIComponent(room)}/ws`, WORKER);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'control');
  url.searchParams.set('token', token);
  url.searchParams.set('protocol', '2');
  return url.toString();
}

function playerUrl(room, token) {
  const parameters = new URLSearchParams({
    mode: 'player',
    session: room,
    token,
    api: WORKER,
    protocol: '2',
  });
  return `${APP.replace(/\/$/, '')}/#/widget?${parameters.toString()}`;
}

async function createSession() {
  const response = await fetch(`${WORKER.replace(/\/$/, '')}/v1/sessions`, { method: 'POST' });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(omittedHttpBodyErrorMessage({
      operation: 'session creation',
      status: response.status,
      body: text,
    }));
  }
  invariant(
    response.ok && typeof payload.room === 'string'
      && typeof payload.controlToken === 'string'
      && typeof payload.playerToken === 'string',
    'Protocol v2 session created',
    `HTTP ${response.status}`,
  );
  return payload;
}

async function readSoakAsset() {
  invariant(ASSET_PATH.length > 0, 'external CEF soak asset path is configured');
  const bytes = await readFile(ASSET_PATH);
  invariant(bytes.byteLength > 0 && bytes.byteLength <= MAX_ASSET_BYTES,
    'external CEF soak asset fits the active-media cap',
    `bytes=${bytes.byteLength} limit=${MAX_ASSET_BYTES}`);
  return bytes;
}

async function uploadSoakAsset(bytes) {
  const response = await fetch(
    `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/assets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.controlToken}`,
        'Content-Type': ASSET_MIME,
        'X-Rekasong-Size': String(bytes.byteLength),
        'X-Rekasong-Type': ASSET_MIME,
        'X-Rekasong-Name': encodeURIComponent(basename(ASSET_PATH)),
      },
      body: bytes,
    },
  );
  const body = await response.json().catch(() => null);
  invariant(
    response.ok && typeof body?.assetId === 'string',
    'external CEF soak asset uploaded',
    `HTTP ${response.status} bytes=${bytes.byteLength}`,
  );
  return body.assetId;
}

async function writeSetupHandoff() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'rekasong-cef-soak-'));
  setupFile = join(temporaryDirectory, 'obs-player-url.json');
  statusFile ||= join(temporaryDirectory, 'soak-status.json');
  await writeStatus('awaiting_candidate', {
    expectedDurationMs: EXPECTED_DURATION_MS,
  });
  await writeFile(
    setupFile,
    JSON.stringify({
      playerUrl: playerUrl(session.room, session.playerToken),
      statusFile,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  console.log(`SETUP_FILE ${setupFile}`);
  console.log(`STATUS_FILE ${statusFile}`);
  console.log(`ACTION In OBS: set the URL and click OK; reopen Properties; click "Refresh cache of current page"; immediately click OK again. The harness waits ${CANDIDATE_STABLE_MS}ms for the surviving CEF identity before activation.`);
}

async function writeStatus(phase, detail = {}) {
  if (!statusFile) return;
  const payload = diagnostics.text(JSON.stringify({
    phase,
    at: new Date().toISOString(),
    ...detail,
  }));
  await writeFile(statusFile, payload, { encoding: 'utf8', mode: 0o600 });
}

async function removeSetupHandoff() {
  if (!setupFile) return;
  await unlink(setupFile).catch(() => {});
  setupFile = null;
}

function routeObservation(snapshot) {
  return {
    at: Date.now(),
    ready: snapshot?.ready ?? false,
    writable: snapshot?.writable ?? false,
    unknownLockCode: snapshot?.unknownLock?.code ?? null,
    playerCount: snapshot?.playerSnapshot?.players?.length ?? 0,
    obsCandidateCount: snapshot?.playerSnapshot?.eligibleCandidates?.obs?.length ?? 0,
    leaseStatus: snapshot?.playerSnapshot?.lease?.status ?? null,
    leaseTarget: snapshot?.playerSnapshot?.lease?.leaseTarget ?? null,
    activeEntryId: snapshot?.playerSnapshot?.activeFamily?.entryId ?? null,
    activeRunId: snapshot?.playerSnapshot?.activeFamily?.runId ?? null,
    confirmedStatus: snapshot?.playerSnapshot?.confirmedPlayback?.status ?? null,
    confirmedReason: snapshot?.playerSnapshot?.confirmedPlayback?.reasonCode ?? null,
  };
}

function startProgress(playerInstanceId, startedAt) {
  progressTimer = setInterval(() => {
    const snapshot = coordinator.snapshot();
    const observation = routeObservation(snapshot);
    const elapsedMs = Date.now() - startedAt;
    const controlRecovering = observation.unknownLockCode
      === ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST || !observation.ready;
    console.log(diagnostics.text(`INFO CEF soak progress ${elapsedMs}ms/${EXPECTED_DURATION_MS}ms ${diagnostics.json({
      ready: observation.ready,
      writable: observation.writable,
      unknownLockCode: observation.unknownLockCode,
      playerCount: observation.playerCount,
      obsCandidateCount: observation.obsCandidateCount,
      leaseStatus: observation.leaseStatus,
      sameTarget: observation.leaseTarget === playerInstanceId,
      confirmedStatus: observation.confirmedStatus,
      controlRecovering,
      controlReconnectAttemptCount,
    })}`));
    void writeStatus(controlRecovering ? 'soak_control_reconnecting' : 'soak_playing', {
      elapsedMs,
      expectedDurationMs: EXPECTED_DURATION_MS,
      playerCount: observation.playerCount,
      obsCandidateCount: observation.obsCandidateCount,
      leaseStatus: observation.leaseStatus,
      sameTarget: observation.leaseTarget === playerInstanceId,
      confirmedStatus: observation.confirmedStatus,
      controlDisconnectCount,
      controlReconnectAttemptCount,
      currentControlReconnectAttempts,
    }).catch(() => {});
  }, PROGRESS_INTERVAL_MS);
}

function stopProgress() {
  if (progressTimer !== null) clearInterval(progressTimer);
  progressTimer = null;
}

async function waitForStableReplacementObsCandidate(previousPlayerInstanceId, actionName) {
  const deadline = Date.now() + RECOVERY_ACTION_TIMEOUT_MS;
  let candidateId = null;
  let stableSince = 0;
  let lastStatusAt = 0;
  let sawTargetDisconnected = false;
  let disconnectedSnapshot = null;

  while (Date.now() < deadline) {
    assertHealthy();
    const protocol = coordinator.snapshot().playerSnapshot;
    const oldPlayerMissing = !protocol?.players?.some((player) => (
      player.playerInstanceId === previousPlayerInstanceId
    ));
    const routeIsDisconnected = protocol?.lease?.status === 'unknown'
      && protocol.lease.leaseTarget === previousPlayerInstanceId
      && protocol.confirmedPlayback?.reasonCode === 'target_disconnected'
      && oldPlayerMissing;
    if (routeIsDisconnected) {
      sawTargetDisconnected = true;
      disconnectedSnapshot = protocol;
    }

    const candidate = currentObsCandidate();
    const now = Date.now();
    if (!candidate || candidate.playerInstanceId === previousPlayerInstanceId) {
      candidateId = null;
      stableSince = 0;
    } else if (candidate.playerInstanceId !== candidateId) {
      candidateId = candidate.playerInstanceId;
      stableSince = now;
      lastStatusAt = 0;
    }

    if (candidate && candidate.playerInstanceId === candidateId) {
      const stableForMs = now - stableSince;
      if (sawTargetDisconnected && stableForMs >= CANDIDATE_STABLE_MS) {
        invariant(
          disconnectedSnapshot?.activeFamily === null,
          `${actionName} clears the vanished run family instead of resuming it`,
        );
        return { candidate, disconnectedSnapshot, stableForMs };
      }
      if (now - lastStatusAt >= 1_000) {
        await writeStatus(`${actionName}_candidate_stabilizing`, {
          sawTargetDisconnected,
          stableForMs,
          requiredStableMs: CANDIDATE_STABLE_MS,
        });
        lastStatusAt = now;
      }
    }
    await sleep(100);
  }

  const snapshot = coordinator?.snapshot?.();
  throw new Error(`${actionName} replacement candidate timed out after ${RECOVERY_ACTION_TIMEOUT_MS}ms: ${diagnostics.json({
    previousPlayerInstanceId,
    sawTargetDisconnected,
    players: snapshot?.playerSnapshot?.players,
    eligibleCandidates: snapshot?.playerSnapshot?.eligibleCandidates,
    lease: snapshot?.playerSnapshot?.lease,
    confirmedPlayback: snapshot?.playerSnapshot?.confirmedPlayback,
  })}`);
}

async function activateRecoveryCandidate(candidate, actionName) {
  const activation = coordinator.activateOutput('obs');
  const ready = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    return protocol?.selectedOutputMode === 'obs'
      && protocol.lease?.status === 'ready'
      && protocol.lease.leaseTarget === candidate.playerInstanceId
      && protocol.activeFamily === null
      && protocol.confirmedPlayback?.reasonCode === 'output_ready_no_playback'
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, `${actionName} explicit OBS output_ready`, {
    commandId: activation.command.commandId,
  });
  invariant(
    ready.playerSnapshot.desiredTransport?.status === 'stopped',
    `${actionName} OBS selection does not start playback`,
  );
  return ready;
}

async function startRecoveryPlayback(candidate, assetId, actionName) {
  const entryId = `external-cef-${actionName}-entry`;
  const runId = `external-cef-${actionName}-run`;
  const load = coordinator.load({
    entryId,
    runId,
    song: {
      type: 'local',
      assetId,
      title: 'OBS CEF recovery fixture',
      artist: 'Rekasong',
    },
    position: 0,
    volume: 20,
  });
  await waitFor(() => {
    const protocol = coordinator.snapshot().playerSnapshot;
    return protocol?.activeFamily?.entryId === entryId
      && protocol.activeFamily.runId === runId
      && protocol.confirmedPlayback?.status === 'ready'
      && protocol.confirmedPlayback.playerInstanceId === candidate.playerInstanceId
      ? protocol
      : null;
  }, COMMAND_TIMEOUT_MS, `${actionName} recovery media ready`, {
    commandId: load.command.commandId,
  });

  const play = coordinator.play();
  const playing = await waitFor(() => {
    const protocol = coordinator.snapshot().playerSnapshot;
    return protocol?.confirmedPlayback?.status === 'playing'
      && protocol.confirmedPlayback.entryId === entryId
      && protocol.confirmedPlayback.runId === runId
      && protocol.confirmedPlayback.playerInstanceId === candidate.playerInstanceId
      && protocol.lease?.status === 'audible'
      ? protocol
      : null;
  }, COMMAND_TIMEOUT_MS, `${actionName} recovery media playing`, {
    commandId: play.command.commandId,
  });
  await writeStatus(`${actionName}_playing`, {
    playerCount: playing.players.length,
    obsCandidateCount: playing.eligibleCandidates.obs.length,
    leaseStatus: playing.lease.status,
  });
  return { entryId, runId };
}

async function recoverReplacementCandidate(previousCandidate, actionName) {
  const replacement = await waitForStableReplacementObsCandidate(
    previousCandidate.playerInstanceId,
    actionName,
  );
  pass(`${actionName} creates a different stable OBS player identity`);

  const emergency = coordinator.emergencyStop({ forceReset: true });
  const commandResult = await coordinator.waitForCommandResult(
    emergency.command.commandId,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  invariant(
    commandResult?.status === 'acknowledged',
    `${actionName} full reset command is acknowledged`,
    diagnostics.json(commandResult),
  );
  const reset = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    return snapshot.ready === true
      && snapshot.unknownLock === null
      && protocol?.lease?.status === 'inactive'
      && protocol.lease.leaseTarget === null
      && protocol.selectedOutputMode === null
      && protocol.activeFamily === null
      && protocol.confirmedPlayback?.status === 'unknown'
      && protocol.confirmedPlayback.reasonCode === 'output_inactive'
      && protocol.confirmedPlayback.recoveryOverride === true
      && protocol.confirmedPlayback.missingTargetUnverified === true
      && protocol.desiredTransport?.status === 'stopped'
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, `${actionName} full reset terminal inactive snapshot`, {
    commandId: emergency.command.commandId,
  });
  invariant(
    reset.playerSnapshot.players.some((player) => (
      player.playerInstanceId === replacement.candidate.playerInstanceId
    )),
    `${actionName} keeps the connected replacement available after reset`,
  );
  await writeStatus(`${actionName}_reset_complete`, {
    recoveryOverride: true,
    missingTargetUnverified: true,
    selectedOutputMode: null,
  });

  await activateRecoveryCandidate(replacement.candidate, actionName);
  await sleep(RECOVERY_SILENCE_OBSERVATION_MS);
  const silent = coordinator.snapshot().playerSnapshot;
  invariant(
    silent?.lease?.status === 'ready'
      && silent.lease.leaseTarget === replacement.candidate.playerInstanceId
      && silent.activeFamily === null
      && silent.desiredTransport?.status === 'stopped'
      && silent.confirmedPlayback?.reasonCode === 'output_ready_no_playback',
    `${actionName} stays silent after explicit OBS re-selection`,
    diagnostics.json(silent),
  );
  await writeStatus(`${actionName}_reselected_silent`, {
    silenceObservationMs: RECOVERY_SILENCE_OBSERVATION_MS,
    activeRun: false,
    desiredTransport: 'stopped',
  });
  return replacement.candidate;
}

async function finishRecoverySession() {
  const deactivation = coordinator.deactivateOutput();
  await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.lease?.status === 'inactive'
      && snapshot.playerSnapshot?.lease?.leaseTarget === null
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF recovery output deactivation', {
    commandId: deactivation.command.commandId,
  });
  coordinator.endSession();
  await waitFor(
    () => coordinator.snapshot().unknownLock?.code
      === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
    COMMAND_TIMEOUT_MS,
    'external OBS CEF recovery session_ended',
    { allowSessionEnded: true },
  );
  sessionEnded = true;
  await verifyEndedStatus();
}

async function runRecoveryScenario({ candidate, assetId, candidateTransitions }) {
  await activateRecoveryCandidate(candidate, 'initial');
  await startRecoveryPlayback(candidate, assetId, 'before-source-refresh');
  await writeStatus('awaiting_source_refresh', {
    action: 'refresh_browser_source_cache_then_close_properties',
  });
  console.log('ACTION_REFRESH_SOURCE');

  const sourceRefreshCandidate = await recoverReplacementCandidate(candidate, 'source_refresh');
  await startRecoveryPlayback(sourceRefreshCandidate, assetId, 'before-obs-restart');
  await writeStatus('awaiting_obs_restart', {
    action: 'exit_and_reopen_obs_without_starting_stream_or_recording',
  });
  console.log('ACTION_RESTART_OBS');

  const restartCandidate = await recoverReplacementCandidate(
    sourceRefreshCandidate,
    'obs_restart',
  );
  await finishRecoverySession();
  console.log(diagnostics.text(`EVIDENCE ${diagnostics.json({
    mode: 'recovery',
    sourceRefreshCreatedNewPlayer: sourceRefreshCandidate.playerInstanceId
      !== candidate.playerInstanceId,
    obsRestartCreatedNewPlayer: restartCandidate.playerInstanceId
      !== sourceRefreshCandidate.playerInstanceId,
    candidateTransitions,
    finalAutomaticPlayback: false,
    finalDesiredTransport: 'stopped',
    controlDisconnectCount,
    controlReconnectAttemptCount,
    maxControlGapMs,
  })}`));
}

async function verifyEndedStatus() {
  const response = await fetch(
    `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/status`,
    { headers: { Authorization: `Bearer ${session.controlToken}` } },
  );
  const body = await response.json().catch(() => null);
  invariant(
    response.status === 410 && body?.status === 'ended',
    'ended soak session is fenced from reuse',
    `HTTP ${response.status}`,
  );
}

async function bestEffortCleanup() {
  stopProgress();
  await removeSetupHandoff();
  if (coordinator && !sessionEnded) {
    try {
      const snapshot = coordinator.snapshot();
      if (snapshot.ready && snapshot.welcome) {
        try {
          const activeFamily = snapshot.playerSnapshot?.activeFamily;
          if (activeFamily) {
            const stop = coordinator.stop();
            await waitForCleanup(
              () => !commandFailure(stop.command.commandId)
                && coordinator.snapshot().playerSnapshot?.activeFamily === null,
              COMMAND_TIMEOUT_MS,
            );
          }
          if (coordinator.snapshot().playerSnapshot?.lease?.status !== 'inactive') {
            const deactivate = coordinator.deactivateOutput();
            await waitForCleanup(
              () => !commandFailure(deactivate.command.commandId)
                && coordinator.snapshot().playerSnapshot?.lease?.status === 'inactive',
              COMMAND_TIMEOUT_MS,
            );
          }
          coordinator.endSession();
          sessionEnded = await waitForCleanup(
            () => coordinator.snapshot().unknownLock?.code
              === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
            COMMAND_TIMEOUT_MS,
          );
        } catch {
          try {
            coordinator.emergencyStop();
          } catch {
            // Cleanup remains best effort after the primary soak result is fixed.
          }
        }
      }
    } catch {
      // Cleanup remains best effort after the primary soak result is fixed.
    }
  }
  coordinator?.dispose();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  temporaryDirectory = null;
}

async function run() {
  console.log(diagnostics.text(`INFO Worker ${WORKER}`));
  console.log(diagnostics.text(`INFO App ${APP}`));
  const assetBytes = await readSoakAsset();
  session = await createSession();
  diagnostics.registerSecret(session.controlToken);
  diagnostics.registerSecret(session.playerToken);
  diagnostics.selfCheck();
  pass('diagnostic sanitizer fail-closed self-check');

  coordinator = new OnAirControlCoordinator({
    transport: {
      url: websocketUrl(session.room, session.controlToken),
      sessionId: session.room,
      webSocketFactory: (url) => new WebSocket(url),
      buildId: 'rekasong-v2-external-cef-soak',
      capabilities: {},
    },
    callbacks: {
      onSnapshot(snapshot) {
        routeObservations.push(routeObservation(snapshot));
        if (routeObservations.length > 512) routeObservations.shift();
      },
      onCommandResult(result) {
        const commandId = result?.entry?.commandId;
        if (typeof commandId === 'string') commandResults.set(commandId, result);
      },
      onStateChange(change) {
        if (['disconnected', 'closed'].includes(change?.state)
          && controlGapStartedAt === null) {
          controlGapStartedAt = Date.now();
          controlDisconnectCount += 1;
        }
      },
    },
  });
  coordinator.connect();
  await waitFor(
    () => coordinator.snapshot().ready,
    CONTROL_READY_TIMEOUT_MS,
    'control negotiation',
  );
  invariant(coordinator.snapshot().writable, 'control coordinator is writable');
  await writeSetupHandoff();

  const stableCandidate = await waitForStableObsCandidate();
  const { candidate, candidateTransitions } = stableCandidate;
  await writeStatus('candidate_connected', {
    playerCount: 1,
    obsCandidateCount: 1,
    stableMs: CANDIDATE_STABLE_MS,
    candidateTransitions,
  });
  await removeSetupHandoff();
  console.log('CEF_CANDIDATE_CONNECTED');
  pass('external OBS CEF candidate connected', candidate.playerInstanceId);
  routeObservations.length = 0;

  // Prove that one stable OBS CEF identity exists before spending the large
  // media upload. A broken or mistyped Browser Source URL must not consume R2
  // ingress repeatedly while the operator is still fixing the OBS setup.
  await writeStatus('uploading_asset', {
    bytes: assetBytes.byteLength,
  });
  const assetId = await uploadSoakAsset(assetBytes);
  await writeStatus('asset_uploaded', {
    bytes: assetBytes.byteLength,
  });

  if (RECOVERY_MODE) {
    await runRecoveryScenario({ candidate, assetId, candidateTransitions });
    return;
  }

  const activation = coordinator.activateOutput('obs');
  await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.selectedOutputMode === 'obs'
      && snapshot.playerSnapshot?.lease?.status === 'ready'
      && snapshot.playerSnapshot?.lease?.leaseTarget === candidate.playerInstanceId
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF output_ready', {
    commandId: activation.command.commandId,
  });
  await writeStatus('output_ready');

  const entryId = 'external-cef-soak-entry';
  const runId = 'external-cef-soak-run';
  const load = coordinator.load({
    entryId,
    runId,
    song: {
      type: 'local',
      assetId,
      title: 'OBS CEF soak',
      artist: 'Rekasong',
    },
    position: 0,
    volume: 25,
  });
  await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.activeFamily?.entryId === entryId
      && snapshot.activeFamily.runId === runId
      && snapshot.confirmedPlayback?.status === 'ready'
      && snapshot.confirmedPlayback.playerInstanceId === candidate.playerInstanceId
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF media ready', {
    commandId: load.command.commandId,
  });
  await writeStatus('media_ready');

  const play = coordinator.play();
  const playing = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.confirmedPlayback?.status === 'playing'
      && snapshot.confirmedPlayback.entryId === entryId
      && snapshot.confirmedPlayback.runId === runId
      && snapshot.lease?.status === 'audible'
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF media playing', {
    commandId: play.command.commandId,
  });
  const startedAt = Date.now();
  await writeStatus('soak_playing', {
    elapsedMs: 0,
    expectedDurationMs: EXPECTED_DURATION_MS,
    playerCount: 1,
    obsCandidateCount: 1,
    leaseStatus: playing.lease.status,
    sameTarget: playing.lease.leaseTarget === candidate.playerInstanceId,
    confirmedStatus: playing.confirmedPlayback.status,
  });
  console.log('SOAK_PLAYING');
  startProgress(candidate.playerInstanceId, startedAt);

  const ended = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.confirmedPlayback?.status === 'ended'
      && snapshot.confirmedPlayback.entryId === entryId
      && snapshot.confirmedPlayback.runId === runId
      ? snapshot
      : null;
  }, EXPECTED_DURATION_MS + PLAYBACK_GRACE_MS, 'external OBS CEF natural end');
  stopProgress();
  const wallDurationMs = Date.now() - startedAt;
  const durationDriftMs = Math.abs(wallDurationMs - EXPECTED_DURATION_MS);
  await writeStatus('natural_end', {
    wallDurationMs,
    expectedDurationMs: EXPECTED_DURATION_MS,
    durationDriftMs,
  });
  invariant(
    durationDriftMs <= PLAYBACK_GRACE_MS,
    'external OBS CEF wall duration stays inside the configured grace',
    `wall=${wallDurationMs}ms expected=${EXPECTED_DURATION_MS}ms drift=${durationDriftMs}ms`,
  );
  invariant(
    Math.abs((ended.confirmedPlayback.duration * 1_000) - EXPECTED_DURATION_MS) <= 1_000,
    'external OBS CEF media duration matches the soak contract',
    `media=${ended.confirmedPlayback.duration * 1_000}ms expected=${EXPECTED_DURATION_MS}ms`,
  );

  const unsafeObservations = routeObservations.filter((observation) => (
    (observation.unknownLockCode !== null
      && observation.unknownLockCode !== ON_AIR_CONTROL_COORDINATOR_CODES.CONNECTION_LOST)
    || (observation.ready && observation.unknownLockCode === null && (
      ['unknown', 'failed', 'emergency_stopping'].includes(observation.leaseStatus)
      || observation.playerCount !== 1
      || observation.obsCandidateCount !== 1
    ))
  ));
  invariant(
    unsafeObservations.length === 0,
    'external OBS CEF soak had no disconnect, duplicate, or unknown route observation',
    diagnostics.json(unsafeObservations.slice(-8)),
  );
  invariant(
    playing.lease.leaseTarget === candidate.playerInstanceId,
    'external OBS CEF kept the exact leased player identity',
  );

  const stop = coordinator.stop();
  await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.confirmedPlayback?.status === 'stopped'
      && snapshot.activeFamily === null
      && snapshot.lease?.status === 'ready'
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF strong stop', {
    commandId: stop.command.commandId,
  });
  const deactivation = coordinator.deactivateOutput();
  await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.lease?.status === 'inactive'
      && snapshot.playerSnapshot?.lease?.leaseTarget === null
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, COMMAND_TIMEOUT_MS, 'external OBS CEF output deactivation', {
    commandId: deactivation.command.commandId,
  });
  coordinator.endSession();
  await waitFor(
    () => coordinator.snapshot().unknownLock?.code
      === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
    COMMAND_TIMEOUT_MS,
    'external OBS CEF session_ended',
    { allowSessionEnded: true },
  );
  sessionEnded = true;
  await verifyEndedStatus();
  console.log(diagnostics.text(`EVIDENCE ${diagnostics.json({
    playerInstanceId: candidate.playerInstanceId,
    wallDurationMs,
    expectedDurationMs: EXPECTED_DURATION_MS,
    durationDriftMs,
    candidateTransitions,
    controlDisconnectCount,
    controlReconnectAttemptCount,
    maxControlGapMs,
    routeObservationCount: routeObservations.length,
    unsafeObservationCount: unsafeObservations.length,
  })}`));
}

const requestStop = () => {
  stopRequested = true;
};
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

try {
  await run();
  await writeStatus('passed');
  console.log(`RESULT Protocol v2 external OBS CEF ${RECOVERY_MODE ? 'recovery' : 'soak'} passed`);
} catch (error) {
  await writeStatus('failed', {
    error: diagnostics.errorText(error),
  }).catch(() => {});
  console.error(`FAIL Protocol v2 external OBS CEF ${RECOVERY_MODE ? 'recovery' : 'soak'} - ${diagnostics.errorText(error)}`);
  process.exitCode = 1;
} finally {
  await bestEffortCleanup();
  process.removeListener('SIGINT', requestStop);
  process.removeListener('SIGTERM', requestStop);
}
