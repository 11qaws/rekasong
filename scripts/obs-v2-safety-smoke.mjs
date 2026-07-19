import { chromium } from 'playwright-core';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';
import { TEST_EVENT_TYPES } from '../src/lib/onAirProtocol.js';
import { ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS } from '../src/lib/onAirTestFixture.js';
import {
  createHarnessDiagnosticSanitizer,
  omittedHttpBodyErrorMessage,
} from './obs-v2-harness-safety.mjs';

const WORKER = process.env.REKASONG_WORKER || 'http://127.0.0.1:8787';
const APP = process.env.REKASONG_APP || 'http://127.0.0.1:5100';
const CONTROL_READY_TIMEOUT_MS = 8_000;
const PLAYER_READY_TIMEOUT_MS = 10_000;
const ROUTE_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const EXPECTED_PLAYER_BUILD_ID = process.env.REKASONG_EXPECTED_PLAYER_BUILD_ID
  || 'rekasong-web-v2';

let browser = null;
let coordinator = null;
let session = null;
let sessionEnded = false;
const openPages = new Set();
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

function sameMembers(left, right) {
  return left.length === right.length
    && left.every((entry) => right.includes(entry));
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
    throw new Error(`coordinator entered authority-unknown state: ${compactJson(lock)}`);
  }
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
    routeUnknown: snapshot.routeUnknown,
    unknownLock: snapshot.unknownLock,
    players: snapshot.playerSnapshot?.players,
    eligibleCandidates: snapshot.playerSnapshot?.eligibleCandidates,
    lease: snapshot.playerSnapshot?.lease,
    desiredTransport: snapshot.playerSnapshot?.desiredTransport,
    confirmedPlayback: snapshot.playerSnapshot?.confirmedPlayback,
    pendingSwitch: snapshot.pendingSwitch,
    pendingCommandIds: snapshot.pendingCommandIds,
  } : null;
  throw new Error(
    `${label} timed out after ${timeoutMs}ms${diagnostic ? `: ${compactJson(diagnostic)}` : ''}`,
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

async function installObsBinding(targetPage, name) {
  await targetPage.addInitScript(({ pageName }) => {
    let activeListener = null;
    let visibleListener = null;
    const state = { active: true, visible: true };
    const diagnostic = {
      pageName,
      activeAssignments: 0,
      visibleAssignments: 0,
      activeInvocations: 0,
      visibleInvocations: 0,
      emissions: 0,
      state: { ...state },
    };
    window.__rekasongObsSafetyBindingDiagnostic = diagnostic;

    const invoke = (listener, value, counter) => {
      if (typeof listener !== 'function') return;
      diagnostic[counter] += 1;
      listener(value);
    };
    const emitRuntimeEvidence = () => {
      diagnostic.emissions += 1;
      diagnostic.state = { ...state };
      invoke(activeListener, state.active, 'activeInvocations');
      invoke(visibleListener, state.visible, 'visibleInvocations');
      window.dispatchEvent(new CustomEvent('obsSourceActiveChanged', {
        detail: { active: state.active },
      }));
      window.dispatchEvent(new CustomEvent('obsSourceVisibleChanged', {
        detail: { visible: state.visible },
      }));
      return { ...state };
    };

    const binding = {
      pluginVersion: 'rekasong-v2-safety-smoke-binding',
      getControlLevel(callback) {
        if (typeof callback === 'function') callback(5);
      },
      getStatus(callback) {
        if (typeof callback === 'function') callback({ streaming: false, recording: false });
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
          invoke(listener, state.active, 'activeInvocations');
        },
      },
      onVisibilityChange: {
        configurable: true,
        enumerable: true,
        get: () => visibleListener,
        set(listener) {
          diagnostic.visibleAssignments += 1;
          visibleListener = listener;
          invoke(listener, state.visible, 'visibleInvocations');
        },
      },
    });
    window.obsstudio = binding;
    window.__rekasongObsSafetySetSourceState = ({ active, visible } = {}) => {
      if (typeof active === 'boolean') state.active = active;
      if (typeof visible === 'boolean') state.visible = visible;
      return emitRuntimeEvidence();
    };
    window.setTimeout(emitRuntimeEvidence, 0);
    window.setTimeout(emitRuntimeEvidence, 250);
  }, { pageName: name });
}

async function openObsPage(name) {
  const targetPage = await browser.newPage();
  openPages.add(targetPage);
  targetPage.on('close', () => openPages.delete(targetPage));
  targetPage.on('pageerror', (error) => pageErrors.push(
    diagnostics.text(`${name}: ${diagnostics.errorText(error)}`),
  ));
  await installObsBinding(targetPage, name);
  await targetPage.goto(widgetUrl(session.room, session.playerToken), {
    waitUntil: 'domcontentloaded',
  });
  return targetPage;
}

async function mediaSafetySnapshot(targetPage) {
  return targetPage.evaluate(() => {
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    return {
      exists: Boolean(media),
      sameElement: Boolean(media && media === window.__rekasongObsSafetyMedia),
      paused: media?.paused ?? null,
      ended: media?.ended ?? null,
      currentTime: media?.currentTime ?? null,
      currentSrc: media?.currentSrc ?? null,
      srcAttribute: media?.getAttribute('src') ?? null,
      sourceChildren: media?.querySelectorAll('source').length ?? null,
      srcObjectDetached: !media || !('srcObject' in media) || media.srcObject === null,
      networkState: media?.networkState ?? null,
      autoplay: media?.autoplay ?? null,
      isConnected: media?.isConnected ?? false,
      routeState: document.querySelector('[data-on-air-player-v2-state]')
        ?.getAttribute('data-on-air-player-v2-state') ?? null,
      binding: window.__rekasongObsSafetyBindingDiagnostic ?? null,
      events: [...(window.__rekasongObsSafetyMediaEvents || [])],
    };
  });
}

async function armSafetyMediaObservation(targetPage) {
  return targetPage.evaluate(() => {
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    if (!media) return false;
    window.__rekasongObsSafetyMedia = media;
    window.__rekasongObsSafetyMediaEvents = [];
    for (const type of [
      'loadstart', 'canplay', 'play', 'playing', 'waiting', 'stalled',
      'error', 'pause', 'ended', 'emptied',
    ]) {
      media.addEventListener(type, () => {
        window.__rekasongObsSafetyMediaEvents.push({
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
    let snapshot = coordinator.snapshot();
    if (!snapshot.ready || !snapshot.welcome) return;
    if (snapshot.playerSnapshot?.lease?.status !== 'inactive') {
      try {
        coordinator.emergencyStop();
        await waitForCleanup(
          () => coordinator.snapshot().playerSnapshot?.lease?.status === 'inactive',
          CLEANUP_TIMEOUT_MS,
        );
      } catch {
        return;
      }
    }
    snapshot = coordinator.snapshot();
    if (snapshot.playerSnapshot?.lease?.status !== 'inactive') return;
    coordinator.endSession();
    sessionEnded = await waitForCleanup(
      () => coordinator.snapshot().unknownLock?.code
        === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
      CLEANUP_TIMEOUT_MS,
    );
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
      buildId: 'rekasong-v2-safety-smoke',
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
  const primaryPage = await openObsPage('primary');
  const initialDuplicatePage = await openObsPage('initial-duplicate');

  const duplicateState = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    const candidateIds = snapshot?.eligibleCandidates?.obs || [];
    const candidates = candidateIds.map((candidateId) => snapshot?.players?.find(
      (player) => player.playerInstanceId === candidateId,
    ));
    return candidateIds.length === 2
      && new Set(candidateIds).size === 2
      && candidates.every((player) => player?.clientKind === 'obs-browser-source'
        && player.runtime?.sourceActive === true
        && player.runtime?.sourceVisible === true)
      ? { snapshot, candidateIds, candidates }
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'two active and visible OBS candidates');
  invariant(
    duplicateState.candidateIds.length === 2,
    'authoritative OBS duplicate candidate count is visibly 2',
    duplicateState.candidateIds.join(','),
  );
  invariant(
    duplicateState.candidates.every((player) => player.runtime.sourceActive === true
      && player.runtime.sourceVisible === true),
    'both duplicate candidates attest sourceActive/sourceVisible true',
  );
  invariant(
    duplicateState.candidates.every((player) => player.buildId === EXPECTED_PLAYER_BUILD_ID),
    'duplicate players report the expected runtime build ID',
    compactJson(duplicateState.candidates.map((player) => player.buildId)),
  );
  console.log(diagnostics.text(`EVIDENCE duplicateCandidates=${compactJson({
    count: duplicateState.candidateIds.length,
    ids: duplicateState.candidateIds,
  })}`));

  const beforeRejection = coordinator.snapshot();
  const commandResultCountBefore = commandResults.size;
  let localRejection = null;
  let unexpectedActivation = null;
  try {
    unexpectedActivation = coordinator.activateOutput('obs');
  } catch (error) {
    localRejection = error;
  }
  invariant(
    unexpectedActivation === null
      && localRejection?.code === ON_AIR_CONTROL_COORDINATOR_CODES.OUTPUT_CANDIDATE_COUNT,
    'duplicate activation is rejected locally with OUTPUT_CANDIDATE_COUNT',
    compactJson({ code: localRejection?.code, detail: localRejection?.detail }),
  );
  invariant(
    localRejection.detail?.mode === 'obs'
      && localRejection.detail?.count === 2
      && sameMembers(localRejection.detail?.candidates || [], duplicateState.candidateIds),
    'local rejection carries the exact duplicate candidate state',
  );
  await sleep(750);
  const afterRejection = coordinator.snapshot();
  invariant(
    afterRejection.playerSnapshot?.lease?.status === 'inactive'
      && afterRejection.playerSnapshot?.lease?.leaseTarget === null
      && afterRejection.playerSnapshot?.lease?.epoch
        === beforeRejection.playerSnapshot?.lease?.epoch
      && afterRejection.playerSnapshot?.selectedOutputMode
        === beforeRejection.playerSnapshot?.selectedOutputMode
      && afterRejection.pendingSwitch === null
      && sameMembers(afterRejection.pendingCommandIds, beforeRejection.pendingCommandIds)
      && commandResults.size === commandResultCountBefore,
    'local rejection created no switch, command, or lease activation',
    compactJson(afterRejection.playerSnapshot?.lease),
  );

  await initialDuplicatePage.close();
  const soleCandidateState = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    const candidateIds = snapshot?.eligibleCandidates?.obs || [];
    const player = snapshot?.players?.find(
      (entry) => entry.playerInstanceId === candidateIds[0],
    );
    return candidateIds.length === 1
      && player?.clientKind === 'obs-browser-source'
      && player.runtime?.sourceActive === true
      && player.runtime?.sourceVisible === true
      ? { snapshot, candidateId: candidateIds[0], player }
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'exactly one OBS candidate after duplicate closes');
  invariant(
    soleCandidateState.snapshot.eligibleCandidates.obs.length === 1,
    'closing one page leaves exactly one authoritative OBS candidate',
    soleCandidateState.candidateId,
  );
  invariant(
    soleCandidateState.player.buildId === EXPECTED_PLAYER_BUILD_ID,
    'sole candidate reports the expected runtime build ID',
    `expected=${EXPECTED_PLAYER_BUILD_ID} actual=${soleCandidateState.player.buildId}`,
  );
  console.log(diagnostics.text(
    'INFO Runtime freshness is asserted by the exact player build ID; '
      + 'the application does not currently expose a content hash.',
  ));

  const activation = coordinator.activateOutput('obs');
  const readyState = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.selectedOutputMode === 'obs'
      && snapshot.playerSnapshot?.lease?.status === 'ready'
      && snapshot.playerSnapshot?.lease?.leaseTarget === soleCandidateState.candidateId
      && snapshot.playerSnapshot?.confirmedPlayback?.reasonCode === 'output_ready_no_playback'
      && snapshot.pendingSwitch === null
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'sole OBS candidate output_ready', {
    commandId: activation.command.commandId,
  });
  invariant(readyState.writable, 'sole-candidate activation preserves writable authority');
  pass(
    'sole OBS candidate activation reaches ready',
    compactJson(readyState.playerSnapshot.lease),
  );

  await waitFor(
    () => primaryPage.evaluate(() => Boolean(
      document.querySelector('[data-on-air-player-v2-state] audio'),
    )),
    PLAYER_READY_TIMEOUT_MS,
    'Protocol v2 media element',
  );
  invariant(
    await armSafetyMediaObservation(primaryPage),
    'primary Protocol v2 media graph captured',
  );
  const readyMedia = await mediaSafetySnapshot(primaryPage);
  invariant(
    readyMedia.exists && readyMedia.sameElement && readyMedia.paused === true
      && readyMedia.currentSrc === '' && readyMedia.srcAttribute === null
      && readyMedia.sourceChildren === 0 && readyMedia.srcObjectDetached === true
      && readyMedia.autoplay === false,
    'output_ready is physically non-audible and source-detached',
    compactJson(readyMedia),
  );

  const start = coordinator.startTest({ durationMs: ON_AIR_TEST_FIXTURE_DEFAULT_DURATION_MS });
  await waitFor(
    () => testEvents.find((event) => event.event === TEST_EVENT_TYPES.TEST_STARTED
      && event.checkId === start.command.checkId),
    PLAYER_READY_TIMEOUT_MS,
    'fixture TEST_STARTED while sole target is leased',
    { commandId: start.command.commandId },
  );
  pass('fixture TEST_STARTED while sole target is leased');
  await waitFor(
    () => testEvents.find((event) => event.event === TEST_EVENT_TYPES.TEST_MARKER
      && event.checkId === start.command.checkId),
    PLAYER_READY_TIMEOUT_MS,
    'fixture marker before duplicate arrival',
    { commandId: start.command.commandId },
  );
  pass('fixture marker observed before duplicate arrival');
  const playingBeforeDuplicate = await waitFor(async () => {
    const media = await mediaSafetySnapshot(primaryPage);
    return media.sameElement
      && media.paused === false
      && media.currentSrc.startsWith('blob:')
      && media.events.some((event) => event.type === 'playing')
      ? media
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'primary fixture PLAYING before duplicate arrival');
  const leaseBeforeLiveDuplicate = coordinator.snapshot().playerSnapshot.lease;
  const markerCountBeforeLiveDuplicate = testEvents.filter(
    (event) => event.event === TEST_EVENT_TYPES.TEST_MARKER
      && event.checkId === start.command.checkId,
  ).length;

  const liveDuplicatePage = await openObsPage('playing-duplicate');
  const liveDuplicateState = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    const candidateIds = protocol?.eligibleCandidates?.obs || [];
    const candidates = candidateIds.map((candidateId) => protocol?.players?.find(
      (player) => player.playerInstanceId === candidateId,
    ));
    const duplicateCandidateId = candidateIds.find(
      (candidateId) => candidateId !== soleCandidateState.candidateId,
    );
    return candidateIds.length === 2
      && new Set(candidateIds).size === 2
      && Boolean(duplicateCandidateId)
      && candidates.every((player) => player?.clientKind === 'obs-browser-source'
        && player.buildId === EXPECTED_PLAYER_BUILD_ID
        && player.runtime?.sourceActive === true
        && player.runtime?.sourceVisible === true)
      && protocol.lease?.leaseTarget === soleCandidateState.candidateId
      && protocol.lease?.epoch === leaseBeforeLiveDuplicate.epoch
      && protocol.lease?.status === leaseBeforeLiveDuplicate.status
      && protocol.selectedOutputMode === 'obs'
      && protocol.activeCheckId === start.command.checkId
      && snapshot.pendingSwitch === null
      ? { snapshot, protocol, candidateIds, duplicateCandidateId }
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'duplicate arrival during active fixture playback');
  invariant(
    liveDuplicateState.protocol.lease.leaseTarget === soleCandidateState.candidateId
      && liveDuplicateState.protocol.lease.epoch === leaseBeforeLiveDuplicate.epoch,
    'playing target lease cannot be taken over by a duplicate candidate',
    compactJson(liveDuplicateState.protocol.lease),
  );

  await waitFor(
    () => liveDuplicatePage.evaluate(() => Boolean(
      document.querySelector('[data-on-air-player-v2-state] audio'),
    )),
    PLAYER_READY_TIMEOUT_MS,
    'playing duplicate Protocol v2 media element',
  );
  const duplicateStandbyMedia = await mediaSafetySnapshot(liveDuplicatePage);
  invariant(
    duplicateStandbyMedia.exists && duplicateStandbyMedia.paused === true
      && duplicateStandbyMedia.currentSrc === ''
      && duplicateStandbyMedia.srcAttribute === null
      && duplicateStandbyMedia.sourceChildren === 0
      && duplicateStandbyMedia.srcObjectDetached === true
      && duplicateStandbyMedia.autoplay === false,
    'new duplicate remains physically silent in detached standby',
    compactJson(duplicateStandbyMedia),
  );
  const continuedPrimary = await waitFor(async () => {
    const media = await mediaSafetySnapshot(primaryPage);
    return media.sameElement
      && media.paused === false
      && media.currentSrc.startsWith('blob:')
      && media.currentTime > playingBeforeDuplicate.currentTime + 0.2
      ? media
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'primary playback continues under duplicate candidate');
  await waitFor(
    () => testEvents.filter((event) => event.event === TEST_EVENT_TYPES.TEST_MARKER
      && event.checkId === start.command.checkId).length > markerCountBeforeLiveDuplicate,
    PLAYER_READY_TIMEOUT_MS,
    'fixture marker continues after duplicate arrival',
    { commandId: start.command.commandId },
  );
  pass('fixture marker continued after duplicate arrival');
  invariant(
    continuedPrimary.events.filter((event) => event.type === 'playing').length === 1
      && !continuedPrimary.events.some((event) => ['waiting', 'stalled', 'error'].includes(event.type)),
    'duplicate arrival causes no primary replay or media fault',
    compactJson(continuedPrimary.events),
  );
  pass('duplicate is visible to control while exactly one media graph is playing');

  const disabledState = await primaryPage.evaluate(() => (
    window.__rekasongObsSafetySetSourceState({ active: false, visible: false })
  ));
  invariant(
    disabledState?.active === false && disabledState?.visible === false,
    'active OBS source was explicitly disabled',
  );

  const unsafeRouteState = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    const leasedPlayer = protocol?.players?.find(
      (player) => player.playerInstanceId === soleCandidateState.candidateId,
    );
    return protocol?.eligibleCandidates?.obs?.length === 1
      && protocol.eligibleCandidates.obs[0] === liveDuplicateState.duplicateCandidateId
      && leasedPlayer?.runtime?.sourceActive === false
      && protocol?.lease?.status === 'unknown'
      && protocol.lease.leaseTarget === soleCandidateState.candidateId
      && protocol.lease.epoch === leaseBeforeLiveDuplicate.epoch
      && protocol.confirmedPlayback?.status === 'unknown'
      && protocol.confirmedPlayback?.reasonCode === 'target_source_inactive'
      && snapshot.routeUnknown === true
      && snapshot.pendingSwitch === null
      ? { snapshot, protocol, leasedPlayer }
      : null;
  }, ROUTE_TIMEOUT_MS, 'disabled active source exact target_source_inactive fence');
  invariant(
    unsafeRouteState.protocol.confirmedPlayback?.audible !== true,
    'disabled source is never represented as confirmed audible',
    compactJson(unsafeRouteState.protocol.confirmedPlayback),
  );
  pass(
    'disabled active source fences route as unknown without duplicate takeover',
    compactJson({
      lease: unsafeRouteState.protocol.lease,
      confirmedPlayback: unsafeRouteState.protocol.confirmedPlayback,
    }),
  );

  const sourceLossStoppedMedia = await waitFor(async () => {
    const media = await mediaSafetySnapshot(primaryPage);
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
  }, CLEANUP_TIMEOUT_MS, 'source loss physically stops and detaches before emergency');
  invariant(
    sourceLossStoppedMedia.isConnected
      && sourceLossStoppedMedia.events.some((event) => event.type === 'playing')
      && sourceLossStoppedMedia.events.some((event) => event.type === 'emptied'),
    'source loss preserves the same media element with prior PLAYING and detach evidence',
    compactJson(sourceLossStoppedMedia),
  );
  pass('source loss immediately silences and detaches the playing media graph without a server ACK');

  await sleep(350);
  const stillUnknown = coordinator.snapshot();
  invariant(
    stillUnknown.routeUnknown === true
      && stillUnknown.playerSnapshot?.lease?.status === 'unknown'
      && stillUnknown.playerSnapshot?.lease?.leaseTarget === soleCandidateState.candidateId
      && stillUnknown.playerSnapshot?.confirmedPlayback?.reasonCode === 'target_source_inactive',
    'source-inactive fence cannot silently self-recover or take over duplicate',
    compactJson(stillUnknown.playerSnapshot),
  );
  const preEmergencyMedia = await mediaSafetySnapshot(primaryPage);
  invariant(
    preEmergencyMedia.paused === true
      && preEmergencyMedia.srcAttribute === null
      && preEmergencyMedia.sourceChildren === 0
      && preEmergencyMedia.srcObjectDetached === true
      && preEmergencyMedia.autoplay === false,
    'runtime restoration delay cannot auto-resume or reattach before explicit emergency',
    compactJson(preEmergencyMedia),
  );

  const emergency = coordinator.emergencyStop();
  const stoppedState = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const protocol = snapshot.playerSnapshot;
    return protocol?.lease?.status === 'inactive'
      && protocol.lease.leaseTarget === null
      && protocol.confirmedPlayback?.status === 'stopped'
      && protocol.confirmedPlayback?.reasonCode === 'emergency_stop_acknowledged'
      && protocol.confirmedPlayback?.paused === true
      && protocol.confirmedPlayback?.sourceDetached === true
      && protocol.confirmedPlayback?.autoplayCancelled === true
      && protocol.confirmedPlayback?.audible === false
      && protocol.desiredTransport?.status === 'stopped'
      && protocol.lease.epoch === leaseBeforeLiveDuplicate.epoch + 1
      && snapshot.routeUnknown === false
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'strong emergency stop acknowledgement', {
    commandId: emergency.command.commandId,
  });
  const emergencyAcknowledgement = await waitFor(() => {
    const result = commandResults.get(emergency.command.commandId);
    return result?.status === 'acknowledged' && result.entry?.state === 'acknowledged'
      ? result.entry.result
      : null;
  }, ROUTE_TIMEOUT_MS, 'exact emergency command acknowledgement');
  invariant(
    emergencyAcknowledgement.code === 'emergency_stop_dispatched'
      && emergencyAcknowledgement.leaseEpoch === leaseBeforeLiveDuplicate.epoch + 1
      && emergencyAcknowledgement.delivered?.protocolV2 === 2
      && emergencyAcknowledgement.delivered?.legacy === 0,
    'emergency command ACK advances one epoch and dispatches to both v2 players',
    compactJson(emergencyAcknowledgement),
  );
  const abortedTestState = await waitFor(() => {
    const snapshot = coordinator.snapshot();
    const abort = snapshot.testEvidence?.lastAbort;
    return snapshot.testEvidence?.started === null
      && abort?.outcome === 'aborted'
      && abort.reasonCode === 'emergency_stop_acknowledged'
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'emergency-aborted test evidence convergence');
  invariant(
    abortedTestState.testEvidence.lastAbort.checkId === start.command.checkId
      && abortedTestState.testEvidence.lastAbort.startedObserved === true
      && abortedTestState.testEvidence.lastAbort.emergencyCommandId === emergency.command.commandId
      && abortedTestState.testEvidence.lastAbort.playerInstanceId === soleCandidateState.candidateId
      && abortedTestState.testEvidence.lastAbort.leaseEpoch === leaseBeforeLiveDuplicate.epoch
      && abortedTestState.testEvidence.lastAbort.emergencyLeaseEpoch
        === leaseBeforeLiveDuplicate.epoch + 1,
    'exact emergency proof records an aborted started test without a fake terminal',
    compactJson(abortedTestState.testEvidence),
  );
  invariant(
    stoppedState.playerSnapshot.eligibleCandidates.obs.length === 1
      && stoppedState.playerSnapshot.eligibleCandidates.obs[0]
        === liveDuplicateState.duplicateCandidateId,
    'emergency stop does not manufacture eligibility for disabled target',
  );

  const primaryStoppedMedia = await waitFor(async () => {
    const media = await mediaSafetySnapshot(primaryPage);
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
  }, CLEANUP_TIMEOUT_MS, 'emergency preserves the already detached former target');
  const duplicateStoppedMedia = await mediaSafetySnapshot(liveDuplicatePage);
  invariant(
    primaryStoppedMedia.isConnected
      && primaryStoppedMedia.events.some((event) => event.type === 'playing')
      && primaryStoppedMedia.events.some((event) => event.type === 'emptied'),
    'former target remains detached with the same prior PLAYING and detach evidence',
    compactJson(primaryStoppedMedia),
  );
  invariant(
    duplicateStoppedMedia.paused === true
      && duplicateStoppedMedia.srcAttribute === null
      && duplicateStoppedMedia.srcObjectDetached === true
      && duplicateStoppedMedia.sourceChildren === 0
      && duplicateStoppedMedia.autoplay === false,
    'duplicate remains physically stopped after global emergency fence',
    compactJson(duplicateStoppedMedia),
  );
  invariant(
    !testEvents.some((event) => event.event === TEST_EVENT_TYPES.TEST_COMPLETE
      && event.checkId === start.command.checkId),
    'interrupted fixture cannot be reported as naturally complete',
  );
  pass('only explicit emergency stop recovers unknown route to strongly stopped inactive lease');

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
  invariant(pageErrors.length === 0, 'player pages emitted no uncaught errors');
}

try {
  await run();
  console.log('RESULT Protocol v2 duplicate-output safety smoke passed');
} catch (error) {
  console.error(
    `FAIL Protocol v2 duplicate-output safety smoke - ${diagnostics.errorText(error)}`,
  );
  process.exitCode = 1;
} finally {
  await bestEffortCleanup();
  coordinator?.dispose();
  await browser?.close();
}
