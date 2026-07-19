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

let browser = null;
let coordinator = null;
let session = null;
let sessionEnded = false;
let page = null;
const pageErrors = [];
const commandResults = new Map();
const testEvents = [];
const diagnostics = createHarnessDiagnosticSanitizer();

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

async function installObsBinding(targetPage) {
  await targetPage.addInitScript(() => {
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
