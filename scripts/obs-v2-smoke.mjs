import { chromium } from 'playwright-core';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';
import { TEST_EVENT_TYPES } from '../src/lib/onAirProtocol.js';
import {
  ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
  ON_AIR_TEST_FIXTURE_MARKERS,
} from '../src/lib/onAirTestFixture.js';
import {
  createHarnessDiagnosticSanitizer,
  omittedHttpBodyErrorMessage,
} from './obs-v2-harness-safety.mjs';
import { renderObsV2ContinuityFixture } from './obs-v2-continuity-fixture.mjs';

const WORKER = process.env.REKASONG_WORKER || 'http://127.0.0.1:8787';
const APP = process.env.REKASONG_APP || 'http://127.0.0.1:5100';
const CONTROL_READY_TIMEOUT_MS = 8_000;
const PLAYER_READY_TIMEOUT_MS = 10_000;
const ROUTE_TIMEOUT_MS = 12_000;
const TEST_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const EXPECTED_PLAYER_BUILD_ID = process.env.REKASONG_EXPECTED_PLAYER_BUILD_ID
  || 'rekasong-web-v2';
const MAX_FIXTURE_WALL_DRIFT_MS = 500;
const MAX_MEDIA_SAMPLE_GAP_MS = 250;
const MIN_TIMING_SAMPLES = 50;
const RUN_CONTINUITY_SMOKE = process.argv.includes('--continuity');
const RUN_FORCE_RESET_SMOKE = process.argv.includes('--force-reset');
const CONTINUITY_DURATION_MS = positiveIntegerEnvironment(
  'REKASONG_CONTINUITY_DURATION_MS',
  30_000,
);
const CONTINUITY_GAP_OBSERVATION_MS = positiveIntegerEnvironment(
  'REKASONG_CONTINUITY_GAP_MS',
  2_000,
);
const CONTINUITY_RECONNECT_TIMEOUT_MS = 20_000;
const CONTINUITY_WALL_DRIFT_LIMIT_MS = positiveIntegerEnvironment(
  'REKASONG_CONTINUITY_DRIFT_LIMIT_MS',
  1_000,
);

let browser = null;
let coordinator = null;
let session = null;
let sessionEnded = false;
let page = null;
const pageErrors = [];
const commandResults = new Map();
const testEvents = [];
const routeObservations = [];
const diagnostics = createHarnessDiagnosticSanitizer();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${raw}`);
  }
  return parsed;
}

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

function compactJson(value) {
  return diagnostics.json(value);
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

function assertHealthy({ allowSessionEnded = false, commandId = null } = {}) {
  if (pageErrors.length > 0) {
    throw new Error(`player page error: ${pageErrors.join(' | ')}`);
  }
  if (commandId) {
    const failure = commandFailure(commandId);
    if (failure) throw new Error(`command ${commandId} failed: ${compactJson(failure)}`);
  }
  if (!coordinator) return;
  const lock = coordinator.snapshot().unknownLock;
  if (lock && !(allowSessionEnded
    && lock.code === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED)) {
    throw new Error(`coordinator entered unknown state: ${compactJson(lock)}`);
  }
  const failedTest = testEvents.find((event) => event.event === TEST_EVENT_TYPES.TEST_FAILED);
  if (failedTest) throw new Error(`OBS fixture failed: ${compactJson(failedTest)}`);
}

async function waitFor(predicate, timeoutMs, label, options = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertHealthy(options);
    const result = await predicate();
    if (result) return result;
    await sleep(50);
  }
  assertHealthy(options);
  const snapshot = coordinator?.snapshot?.();
  const diagnostic = snapshot ? {
    state: snapshot.state,
    ready: snapshot.ready,
    writable: snapshot.writable,
    unknownLock: snapshot.unknownLock,
    players: snapshot.playerSnapshot?.players,
    eligibleCandidates: snapshot.playerSnapshot?.eligibleCandidates,
    lease: snapshot.playerSnapshot?.lease,
  } : null;
  let playerDiagnostic = null;
  try {
    playerDiagnostic = await page?.evaluate(() => ({
      routeState: document.querySelector('[data-on-air-player-v2-state]')
        ?.getAttribute('data-on-air-player-v2-state') ?? null,
      binding: window.__rekasongObsSmokeBindingDiagnostic ?? null,
    }));
  } catch {
    // A closed/crashed page is already represented by the coordinator snapshot.
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms${diagnostic ? `: ${compactJson(diagnostic)}` : ''}`
      + `${playerDiagnostic ? ` player=${compactJson(playerDiagnostic)}` : ''}`,
  );
}

async function waitForCleanup(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return false;
}

async function waitForObservation(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pageErrors.length > 0) throw new Error(`player page error: ${pageErrors.join(' | ')}`);
    const result = await predicate();
    if (result) return result;
    await sleep(50);
  }
  const snapshot = coordinator?.snapshot?.();
  throw new Error(`${label} timed out after ${timeoutMs}ms: ${compactJson({
    unknownLock: snapshot?.unknownLock,
    players: snapshot?.playerSnapshot?.players,
    lease: snapshot?.playerSnapshot?.lease,
    confirmedPlayback: snapshot?.playerSnapshot?.confirmedPlayback,
  })}`);
}

function websocketUrl(room, token) {
  const url = new URL(`/v1/sessions/${encodeURIComponent(room)}/ws`, WORKER);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'control');
  url.searchParams.set('token', token);
  url.searchParams.set('protocol', '2');
  return url.toString();
}

function widgetUrl(room, token) {
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

async function uploadContinuityFixture(fixture) {
  const response = await fetch(
    `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/assets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.controlToken}`,
        'Content-Type': fixture.mimeType,
        'X-Rekasong-Size': String(fixture.byteLength),
        'X-Rekasong-Type': fixture.mimeType,
        'X-Rekasong-Name': encodeURIComponent(fixture.filename),
      },
      body: fixture.bytes,
    },
  );
  const body = await response.json().catch(() => null);
  invariant(
    response.ok && typeof body?.assetId === 'string',
    'normal continuity fixture uploaded as a session asset',
    `HTTP ${response.status} bytes=${fixture.byteLength}`,
  );
  return body.assetId;
}

async function installObsBinding(targetPage) {
  await targetPage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const trackedSockets = [];
    class RekasongSmokeWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        trackedSockets.push(this);
      }
    }
    window.WebSocket = RekasongSmokeWebSocket;
    window.__rekasongObsSmokeSocketControl = {
      closeLatest() {
        const socket = [...trackedSockets].reverse().find((candidate) => (
          candidate.readyState === NativeWebSocket.OPEN
        ));
        if (!socket) return { closed: false, tracked: trackedSockets.length };
        socket.close(4000, 'continuity_smoke_disconnect');
        return { closed: true, tracked: trackedSockets.length };
      },
    };
    let activeListener = null;
    let visibleListener = null;
    const diagnostic = {
      activeAssignments: 0,
      visibleAssignments: 0,
      activeInvocations: 0,
      visibleInvocations: 0,
      emissions: 0,
    };
    window.__rekasongObsSmokeBindingDiagnostic = diagnostic;
    const invoke = (listener, value) => {
      if (typeof listener === 'function') listener(value);
    };
    const binding = {
      pluginVersion: 'rekasong-v2-smoke-binding',
      getControlLevel(callback) {
        invoke(callback, 5);
      },
      getStatus(callback) {
        invoke(callback, { streaming: false, recording: false });
      },
    };
    Object.defineProperties(binding, {
      onActiveChange: {
        configurable: true,
        enumerable: true,
        get: () => activeListener,
        set(listener) {
          diagnostic.activeAssignments += 1;
          activeListener = listener;
          invoke(listener, true);
        },
      },
      onVisibilityChange: {
        configurable: true,
        enumerable: true,
        get: () => visibleListener,
        set(listener) {
          diagnostic.visibleAssignments += 1;
          visibleListener = listener;
          invoke(listener, true);
        },
      },
    });
    window.obsstudio = binding;
    const emitRuntimeEvidence = () => {
      diagnostic.emissions += 1;
      if (typeof activeListener === 'function') diagnostic.activeInvocations += 1;
      if (typeof visibleListener === 'function') diagnostic.visibleInvocations += 1;
      invoke(activeListener, true);
      invoke(visibleListener, true);
      window.dispatchEvent(new CustomEvent('obsSourceActiveChanged', {
        detail: { active: true },
      }));
      window.dispatchEvent(new CustomEvent('obsSourceVisibleChanged', {
        detail: { visible: true },
      }));
    };
    emitRuntimeEvidence();
    window.setTimeout(emitRuntimeEvidence, 0);
    window.setTimeout(emitRuntimeEvidence, 250);
  });
}

async function mediaSnapshot() {
  return page.evaluate(() => {
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    return {
      exists: Boolean(media),
      sameElement: Boolean(media && media === window.__rekasongV2SmokeMedia),
      paused: media?.paused ?? null,
      ended: media?.ended ?? null,
      currentTime: media?.currentTime ?? null,
      duration: media?.duration ?? null,
      currentSrc: media?.currentSrc ?? null,
      srcAttribute: media?.getAttribute('src') ?? null,
      sourceChildren: media?.querySelectorAll('source').length ?? null,
      srcObjectDetached: !media || !('srcObject' in media) || media.srcObject === null,
      networkState: media?.networkState ?? null,
      autoplay: media?.autoplay ?? null,
      isConnected: media?.isConnected ?? false,
      events: [...(window.__rekasongV2SmokeMediaEvents || [])],
    };
  });
}

async function armMediaObservation() {
  return page.evaluate(() => {
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    if (!media) return false;
    window.__rekasongV2SmokeMedia = media;
    window.__rekasongV2SmokeMediaEvents = [];
    window.__rekasongV2SmokeTiming = {
      startedAt: null,
      endedAt: null,
      samples: [],
      backwardsCount: 0,
      waitingCount: 0,
      stalledCount: 0,
      errorCount: 0,
      lastMediaTime: null,
    };
    let sampleTimer = null;
    const timing = window.__rekasongV2SmokeTiming;
    const sample = () => {
      const mediaTime = media.currentTime;
      if (!Number.isFinite(mediaTime)) return;
      const at = performance.now();
      if (timing.lastMediaTime !== null && mediaTime + 0.005 < timing.lastMediaTime) {
        timing.backwardsCount += 1;
      }
      timing.lastMediaTime = mediaTime;
      timing.samples.push({ at, mediaTime });
      if (timing.samples.length > 512) timing.samples.shift();
    };
    const startSampling = () => {
      if (sampleTimer !== null) return;
      sample();
      sampleTimer = window.setInterval(sample, 40);
    };
    const stopSampling = () => {
      sample();
      if (sampleTimer !== null) window.clearInterval(sampleTimer);
      sampleTimer = null;
    };
    for (const type of [
      'loadstart', 'canplay', 'play', 'playing', 'waiting', 'stalled',
      'error', 'pause', 'ended', 'emptied',
    ]) {
      media.addEventListener(type, () => {
        if (type === 'playing') {
          if (timing.startedAt === null) timing.startedAt = performance.now();
          startSampling();
        }
        if (type === 'waiting') timing.waitingCount += 1;
        if (type === 'stalled') timing.stalledCount += 1;
        if (type === 'error') timing.errorCount += 1;
        if (type === 'ended') {
          timing.endedAt = performance.now();
          stopSampling();
        }
        window.__rekasongV2SmokeMediaEvents.push({
          type,
          at: performance.now(),
          mediaTime: media.currentTime,
          paused: media.paused,
          srcAttached: Boolean(media.currentSrc || media.getAttribute('src')),
          mediaErrorCode: media.error?.code ?? null,
        });
      });
    }
    return true;
  });
}

async function timingSnapshot() {
  return page.evaluate(() => {
    const timing = window.__rekasongV2SmokeTiming;
    if (!timing) return null;
    const samples = [...timing.samples];
    let maximumSampleGapMs = 0;
    for (let index = 1; index < samples.length; index += 1) {
      maximumSampleGapMs = Math.max(
        maximumSampleGapMs,
        samples[index].at - samples[index - 1].at,
      );
    }
    return {
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      wallDurationMs: timing.startedAt !== null && timing.endedAt !== null
        ? timing.endedAt - timing.startedAt
        : null,
      maximumSampleGapMs,
      sampleCount: samples.length,
      firstMediaTime: samples[0]?.mediaTime ?? null,
      lastMediaTime: samples.at(-1)?.mediaTime ?? null,
      backwardsCount: timing.backwardsCount,
      waitingCount: timing.waitingCount,
      stalledCount: timing.stalledCount,
      errorCount: timing.errorCount,
    };
  });
}

async function runNormalPlaybackContinuitySmoke(playerInstanceId) {
  invariant(
    CONTINUITY_DURATION_MS >= CONTINUITY_GAP_OBSERVATION_MS + 5_000,
    'continuity fixture leaves enough media after the forced transport gap',
    `duration=${CONTINUITY_DURATION_MS}ms gap=${CONTINUITY_GAP_OBSERVATION_MS}ms`,
  );
  const fixture = renderObsV2ContinuityFixture({ durationMs: CONTINUITY_DURATION_MS });
  const assetId = await uploadContinuityFixture(fixture);
  pass(
    'normal continuity fixture is fully buffered before playback',
    `duration=${fixture.durationMs}ms bytes=${fixture.byteLength}`,
  );

  const entryId = 'obs-continuity-entry';
  const runId = 'obs-continuity-run';
  const load = coordinator.load({
    entryId,
    runId,
    song: {
      type: 'local',
      assetId,
      title: 'OBS continuity smoke',
      artist: 'Rekasong',
    },
    position: 0,
    volume: 25,
  });
  const loaded = await waitFor(async () => {
    const media = await mediaSnapshot();
    const protocol = coordinator.snapshot().playerSnapshot;
    return media.sameElement
      && media.paused === true
      && media.currentSrc.startsWith('blob:')
      && Math.abs(media.duration - (CONTINUITY_DURATION_MS / 1_000)) <= 0.15
      && protocol?.activeFamily?.entryId === entryId
      && protocol.activeFamily.runId === runId
      && protocol.confirmedPlayback?.status === 'ready'
      && protocol.confirmedPlayback.entryId === entryId
      && protocol.confirmedPlayback.runId === runId
      && protocol.confirmedPlayback.playerInstanceId === playerInstanceId
      && protocol.confirmedPlayback.leaseEpoch === protocol.lease?.epoch
      ? media
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'normal continuity media READY', {
    commandId: load.command.commandId,
  });
  const normalEventOffset = loaded.events.length;

  const play = coordinator.play();
  const playing = await waitFor(async () => {
    const media = await mediaSnapshot();
    return media.sameElement
      && media.paused === false
      && media.currentSrc === loaded.currentSrc
      && media.currentTime >= 0.35
      ? media
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'normal continuity media PLAYING', {
    commandId: play.command.commandId,
  });
  const continuitySource = playing.currentSrc;
  const beforeDisconnectTime = playing.currentTime;
  const continuityWallStartedAt = performance.now();
  const observationOffset = routeObservations.length;
  const closeResult = await page.evaluate(() => (
    window.__rekasongObsSmokeSocketControl?.closeLatest?.()
  ));
  invariant(
    closeResult?.closed === true,
    'the current OBS player WebSocket is explicitly closed without unloading the page',
    compactJson(closeResult),
  );
  const disconnectEvidence = await waitForObservation(() => (
    routeObservations.slice(observationOffset).find((observation) => (
      observation.leaseStatus === 'unknown'
        && observation.leaseTarget === playerInstanceId
        && observation.confirmedReason === 'target_disconnected'
        && !observation.playerIds.includes(playerInstanceId)
    )) || null
  ), PLAYER_READY_TIMEOUT_MS, 'player WebSocket disconnect is authoritative');

  await sleep(CONTINUITY_GAP_OBSERVATION_MS);
  const duringGap = await mediaSnapshot();
  const continuityWallElapsedMs = performance.now() - continuityWallStartedAt;
  const continuityMediaAdvanceMs = (duringGap.currentTime - beforeDisconnectTime) * 1_000;
  const minimumAdvance = Math.max(0.5, (CONTINUITY_GAP_OBSERVATION_MS / 1_000) * 0.6);
  invariant(
    duringGap.sameElement
      && duringGap.paused === false
      && duringGap.currentSrc === continuitySource
      && duringGap.currentTime >= beforeDisconnectTime + minimumAdvance,
    'normal media graph advances through the WebSocket disconnect and reconnect window',
    compactJson({ beforeDisconnectTime, duringGap, minimumAdvance, disconnectEvidence }),
  );
  invariant(
    Math.abs(continuityMediaAdvanceMs - continuityWallElapsedMs)
      <= CONTINUITY_WALL_DRIFT_LIMIT_MS,
    'normal media clock stays aligned with wall time across reconnect',
    `media=${continuityMediaAdvanceMs.toFixed(1)}ms wall=${continuityWallElapsedMs.toFixed(1)}ms `
      + `drift=${Math.abs(continuityMediaAdvanceMs - continuityWallElapsedMs).toFixed(1)}ms `
      + `limit=${CONTINUITY_WALL_DRIFT_LIMIT_MS}ms`,
  );

  const restored = await waitForObservation(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    const playerRecord = protocol?.players?.find((candidate) => (
      candidate.playerInstanceId === playerInstanceId
    ));
    return snapshot.ready === true
      && snapshot.unknownLock === null
      && ['ready', 'audible'].includes(protocol?.lease?.status)
      && protocol.lease.leaseTarget === playerInstanceId
      && playerRecord?.clientKind === 'obs-browser-source'
      && protocol.confirmedPlayback?.status === 'playing'
      && protocol.confirmedPlayback.playerInstanceId === playerInstanceId
      && protocol.confirmedPlayback.entryId === entryId
      && protocol.confirmedPlayback.runId === runId
      ? snapshot
      : null;
  }, CONTINUITY_RECONNECT_TIMEOUT_MS, 'same OBS player restores its established route');
  assertHealthy();

  const afterReconnect = await waitForObservation(async () => {
    const media = await mediaSnapshot();
    return media.sameElement
      && media.paused === false
      && media.currentSrc === continuitySource
      && media.currentTime >= beforeDisconnectTime
        + (CONTINUITY_GAP_OBSERVATION_MS / 1_000) + 0.25
      ? media
      : null;
  }, CONTINUITY_RECONNECT_TIMEOUT_MS, 'same media timeline advances after reconnect');
  const continuityEvents = afterReconnect.events.slice(normalEventOffset);
  invariant(
    continuityEvents.filter((event) => event.type === 'play').length === 1
      && continuityEvents.filter((event) => event.type === 'playing').length === 1
      && !continuityEvents.some((event) => [
        'pause', 'ended', 'emptied', 'waiting', 'stalled', 'error',
      ].includes(event.type)),
    'reconnect sends no duplicate PLAY and causes no media interruption',
    compactJson(continuityEvents),
  );
  invariant(
    restored.playerSnapshot.lease.leaseTarget === playerInstanceId
      && restored.playerSnapshot.activeFamily?.entryId === entryId
      && restored.playerSnapshot.activeFamily?.runId === runId,
    'reconnect preserves the same lease target and normal run family',
    compactJson({
      lease: restored.playerSnapshot.lease,
      activeFamily: restored.playerSnapshot.activeFamily,
      confirmedPlayback: restored.playerSnapshot.confirmedPlayback,
    }),
  );
  pass('normal OBS playback survives a real WebSocket disconnect and same-page reconnect');

  const stop = coordinator.stop();
  const stopped = await waitFor(async () => {
    const snapshot = coordinator.snapshot();
    const media = await mediaSnapshot();
    return snapshot.playerSnapshot?.confirmedPlayback?.status === 'stopped'
      && snapshot.playerSnapshot?.activeFamily === null
      && media.sameElement
      && media.paused === true
      && media.srcAttribute === null
      && media.sourceChildren === 0
      && media.srcObjectDetached === true
      && media.autoplay === false
      ? { snapshot, media }
      : null;
  }, CLEANUP_TIMEOUT_MS, 'normal continuity media strong stop', {
    commandId: stop.command.commandId,
  });
  invariant(
    stopped.snapshot.playerSnapshot.lease.status === 'ready'
      && stopped.snapshot.playerSnapshot.lease.leaseTarget === playerInstanceId,
    'explicit normal stop keeps the trusted OBS route ready for the next song',
    compactJson(stopped.snapshot.playerSnapshot.lease),
  );
}

async function runForcedRefreshRecoverySmoke(previousPlayerInstanceId) {
  await page.close();
  const disconnected = await waitForObservation(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.lease?.status === 'unknown'
      && snapshot.lease.leaseTarget === previousPlayerInstanceId
      && snapshot.confirmedPlayback?.reasonCode === 'target_disconnected'
      && !snapshot.players.some((playerRecord) => (
        playerRecord.playerInstanceId === previousPlayerInstanceId
      ))
      ? snapshot
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'closed OBS page leaves an explicit unknown route');
  invariant(
    disconnected.activeFamily === null,
    'refresh recovery begins without silently resuming a media run',
  );

  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(diagnostics.errorText(error)));
  await installObsBinding(page);
  await page.goto(widgetUrl(session.room, session.playerToken), { waitUntil: 'domcontentloaded' });
  const replacement = await waitForObservation(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    const candidateIds = snapshot?.eligibleCandidates?.obs || [];
    const playerRecord = snapshot?.players?.find((candidate) => (
      candidate.playerInstanceId === candidateIds[0]
    ));
    return candidateIds.length === 1
      && candidateIds[0] !== previousPlayerInstanceId
      && playerRecord?.clientKind === 'obs-browser-source'
      && playerRecord.runtime?.sourceActive === true
      && playerRecord.runtime?.sourceVisible === true
      ? playerRecord
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'replacement OBS page registers one new candidate');
  await waitForObservation(
    () => page.evaluate(() => Boolean(document.querySelector('[data-on-air-player-v2-state] audio'))),
    PLAYER_READY_TIMEOUT_MS,
    'replacement Protocol v2 media element',
  );
  invariant(await armMediaObservation(), 'replacement HTMLMediaElement graph captured');

  const emergency = coordinator.emergencyStop({ forceReset: true });
  const reset = await waitForObservation(() => {
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
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'confirmed full reset releases the vanished OBS identity');
  invariant(
    reset.playerSnapshot.desiredTransport?.status === 'stopped',
    'full reset leaves playback stopped and does not auto-resume',
  );
  const emergencyResult = commandResults.get(emergency.command.commandId);
  invariant(
    emergencyResult?.status === 'acknowledged',
    'full reset command is acknowledged before route reuse',
    compactJson(emergencyResult),
  );
  const replacementMedia = await mediaSnapshot();
  invariant(
    replacementMedia.sameElement
      && replacementMedia.paused === true
      && replacementMedia.srcAttribute === null
      && replacementMedia.sourceChildren === 0,
    'replacement player remains silent after full reset',
    compactJson(replacementMedia),
  );

  const activation = coordinator.activateOutput('obs');
  await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    return snapshot?.lease?.status === 'ready'
      && snapshot.lease.leaseTarget === replacement.playerInstanceId
      && snapshot.confirmedPlayback?.reasonCode === 'output_ready_no_playback'
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'replacement OBS route activates after full reset', {
    commandId: activation.command.commandId,
  });
  pass('OBS refresh gets a recoverable route without automatic playback');
}

async function verifyEndedStatus() {
  const response = await fetch(
    `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/status`,
    { headers: { Authorization: `Bearer ${session.controlToken}` } },
  );
  const body = await response.json().catch(() => null);
  invariant(
    response.status === 410 && body?.status === 'ended',
    'ended session is fenced from reuse',
    `HTTP ${response.status} ${compactJson(body)}`,
  );
}

async function bestEffortCleanup() {
  if (!coordinator || sessionEnded) return;
  try {
    const snapshot = coordinator.snapshot();
    if (snapshot.ready && snapshot.welcome) {
      try {
        coordinator.endSession();
      } catch {
        try {
          const emergency = coordinator.emergencyStop();
          const stopped = await waitForCleanup(
            () => coordinator.snapshot().playerSnapshot?.lease?.status === 'inactive',
            CLEANUP_TIMEOUT_MS,
          );
          if (!stopped || commandFailure(emergency.command.commandId)) return;
          coordinator.endSession();
        } catch {
          return;
        }
      }
      const ended = await waitForCleanup(
        () => coordinator.snapshot().unknownLock?.code
          === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
        CLEANUP_TIMEOUT_MS,
      );
      sessionEnded = ended;
    }
  } catch {
    // The smoke failure remains authoritative; cleanup is best effort only.
  }
}

async function run() {
  console.log(diagnostics.text(`INFO Worker ${WORKER}`));
  console.log(diagnostics.text(`INFO App ${APP}`));
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
      buildId: 'rekasong-v2-smoke',
      capabilities: {},
    },
    callbacks: {
      onSnapshot(snapshot) {
        routeObservations.push({
          unknownLockCode: snapshot?.unknownLock?.code ?? null,
          leaseStatus: snapshot?.playerSnapshot?.lease?.status ?? null,
          leaseTarget: snapshot?.playerSnapshot?.lease?.leaseTarget ?? null,
          confirmedStatus: snapshot?.playerSnapshot?.confirmedPlayback?.status ?? null,
          confirmedReason: snapshot?.playerSnapshot?.confirmedPlayback?.reasonCode ?? null,
          playerIds: (snapshot?.playerSnapshot?.players || []).map(
            (playerRecord) => playerRecord.playerInstanceId,
          ),
        });
        if (routeObservations.length > 128) routeObservations.shift();
      },
      onCommandResult(result) {
        const commandId = result?.entry?.commandId;
        if (typeof commandId === 'string') commandResults.set(commandId, result);
      },
      onTestEvent({ event }) {
        testEvents.push(event);
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

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(diagnostics.errorText(error)));
  await installObsBinding(page);
  await page.goto(widgetUrl(session.room, session.playerToken), { waitUntil: 'domcontentloaded' });

  const candidateSnapshot = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    const candidateIds = snapshot?.eligibleCandidates?.obs || [];
    const player = snapshot?.players?.find((entry) => entry.playerInstanceId === candidateIds[0]);
    return candidateIds.length === 1
      && player?.clientKind === 'obs-browser-source'
      && player.runtime?.sourceActive === true
      && player.runtime?.sourceVisible === true
      ? { snapshot, player }
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'one active and visible OBS candidate');
  invariant(
    candidateSnapshot.snapshot.eligibleCandidates.obs.length === 1,
    'OBS candidate count is exactly one',
    candidateSnapshot.player.playerInstanceId,
  );
  invariant(
    candidateSnapshot.player.runtime.sourceActive === true
      && candidateSnapshot.player.runtime.sourceVisible === true,
    'OBS sourceActive/sourceVisible attestations are true',
  );
  invariant(
    candidateSnapshot.player.buildId === EXPECTED_PLAYER_BUILD_ID,
    'player reports the expected runtime build ID',
    `expected=${EXPECTED_PLAYER_BUILD_ID} actual=${candidateSnapshot.player.buildId}`,
  );
  console.log(diagnostics.text(
    'INFO Runtime freshness is asserted by the exact player build ID; '
      + 'the application does not currently expose a content hash.',
  ));

  await waitFor(
    () => page.evaluate(() => Boolean(document.querySelector('[data-on-air-player-v2-state] audio'))),
    PLAYER_READY_TIMEOUT_MS,
    'Protocol v2 media element',
  );
  invariant(await armMediaObservation(), 'Protocol v2 HTMLMediaElement graph captured');

  const activation = coordinator.activateOutput('obs');
  const readySnapshot = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.selectedOutputMode === 'obs'
      && snapshot.playerSnapshot?.lease?.status === 'ready'
      && snapshot.playerSnapshot?.lease?.leaseTarget
        === candidateSnapshot.player.playerInstanceId
      && snapshot.playerSnapshot?.confirmedPlayback?.reasonCode === 'output_ready_no_playback'
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'output_ready', { commandId: activation.command.commandId });
  invariant(readySnapshot.writable, 'output_ready preserved writable control authority');
  pass('OBS activation reached output_ready');

  const start = coordinator.startTest({ durationMs: ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS });
  const startedEvent = await waitFor(
    () => testEvents.find((event) => event.event === TEST_EVENT_TYPES.TEST_STARTED
      && event.checkId === start.command.checkId),
    PLAYER_READY_TIMEOUT_MS,
    'test_started after PLAYING',
    { commandId: start.command.commandId },
  );
  const playingMedia = await waitFor(async () => {
    const media = await mediaSnapshot();
    return media.sameElement
      && media.paused === false
      && media.currentSrc.startsWith('blob:')
      && media.events.some((event) => event.type === 'playing')
      ? media
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'same media element PLAYING evidence');
  invariant(startedEvent.checkId === start.command.checkId, 'test_started identity matches request');
  invariant(
    Math.abs(playingMedia.duration - (ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS / 1_000)) <= 0.1,
    'same media graph loaded the canonical eight-second fixture',
    `duration=${playingMedia.duration}`,
  );
  pass('same HTMLMediaElement emitted PLAYING');

  const completedEvent = await waitFor(
    () => testEvents.find((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE
      && event.checkId === start.command.checkId),
    TEST_TIMEOUT_MS,
    'natural test_complete',
    { commandId: start.command.commandId },
  );
  const markers = testEvents.filter((event) => event.event === TEST_EVENT_TYPES.TEST_MARKER
    && event.checkId === start.command.checkId);
  const expectedMarkerTimes = ON_AIR_TEST_FIXTURE_MARKERS.map((marker) => marker.startMs);
  invariant(markers.length === expectedMarkerTimes.length, 'all fixture markers were relayed', `${markers.length}`);
  invariant(
    markers.every((marker, index) => marker.markerIndex === index
      && marker.markerTimeMs === expectedMarkerTimes[index]),
    'marker indexes and media times are continuous',
  );
  invariant(
    markers.every((marker, index) => index === 0 || marker.sequence === markers[index - 1].sequence + 1),
    'marker telemetry sequence is continuous',
  );
  invariant(
    completedEvent.markerCount === markers.length
      && completedEvent.postcondition?.stopped === true,
    'test_complete carries exact stopped marker count',
  );

  const timing = await timingSnapshot();
  invariant(
    timing?.waitingCount === 0 && timing?.stalledCount === 0 && timing?.errorCount === 0,
    'fixture media emitted no waiting, stalled, or error event',
    compactJson(timing),
  );
  invariant(
    timing.backwardsCount === 0,
    'fixture media time never moved backwards',
    compactJson(timing),
  );
  invariant(
    timing.sampleCount >= MIN_TIMING_SAMPLES,
    'fixture timing has sufficient continuous samples',
    `samples=${timing.sampleCount}`,
  );
  invariant(
    Number.isFinite(timing.wallDurationMs)
      && Math.abs(timing.wallDurationMs - ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS)
        <= MAX_FIXTURE_WALL_DRIFT_MS,
    'eight-second fixture wall-clock drift is bounded',
    `wall=${timing.wallDurationMs?.toFixed?.(1)}ms drift=${Math.abs(
      timing.wallDurationMs - ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS,
    ).toFixed(1)}ms limit=${MAX_FIXTURE_WALL_DRIFT_MS}ms`,
  );
  invariant(
    timing.maximumSampleGapMs <= MAX_MEDIA_SAMPLE_GAP_MS,
    'fixture maximum timing-sample gap is bounded',
    `maxGap=${timing.maximumSampleGapMs.toFixed(1)}ms limit=${MAX_MEDIA_SAMPLE_GAP_MS}ms`,
  );
  console.log(diagnostics.text(`EVIDENCE timing=${compactJson(timing)}`));

  const stoppedMedia = await waitFor(async () => {
    const media = await mediaSnapshot();
    const networkDetached = media.networkState === 0 || media.networkState === 3;
    return media.sameElement
      && media.paused === true
      && media.srcAttribute === null
      && media.srcObjectDetached === true
      && media.sourceChildren === 0
      && (media.currentSrc === '' || networkDetached)
      && media.autoplay === false
      ? media
      : null;
  }, CLEANUP_TIMEOUT_MS, 'strong media stop after test_complete');
  invariant(stoppedMedia.isConnected, 'same HTMLMediaElement remains connected after strong stop');
  invariant(
    stoppedMedia.events.some((event) => event.type === 'pause')
      && stoppedMedia.events.some((event) => event.type === 'emptied'),
    'physical stop emitted pause and source-detach evidence',
  );

  if (RUN_CONTINUITY_SMOKE) {
    await runNormalPlaybackContinuitySmoke(candidateSnapshot.player.playerInstanceId);
  }

  if (RUN_FORCE_RESET_SMOKE) {
    await runForcedRefreshRecoverySmoke(candidateSnapshot.player.playerInstanceId);
  }

  const deactivation = coordinator.deactivateOutput();
  await waitFor(
    () => {
      const snapshot = coordinator.snapshot();
      return snapshot.playerSnapshot?.lease?.status === 'inactive'
        && snapshot.playerSnapshot?.lease?.leaseTarget === null
        && snapshot.pendingSwitch === null;
    },
    ROUTE_TIMEOUT_MS,
    'output deactivation',
    { commandId: deactivation.command.commandId },
  );
  pass('output deactivated with no active lease');

  coordinator.endSession();
  await waitFor(
    () => coordinator.snapshot().unknownLock?.code
      === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
    CLEANUP_TIMEOUT_MS,
    'session_ended lifecycle',
    { allowSessionEnded: true },
  );
  sessionEnded = true;
  pass('session_ended lifecycle received');
  await verifyEndedStatus();
  invariant(pageErrors.length === 0, 'player page emitted no uncaught errors');
}

try {
  await run();
  console.log('RESULT Protocol v2 OBS smoke passed');
} catch (error) {
  console.error(`FAIL Protocol v2 OBS smoke - ${diagnostics.errorText(error)}`);
  process.exitCode = 1;
} finally {
  await bestEffortCleanup();
  coordinator?.dispose();
  await browser?.close();
}
