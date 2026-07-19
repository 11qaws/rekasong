import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { chromium } from 'playwright-core';

import {
  ON_AIR_CONTROL_COORDINATOR_CODES,
  OnAirControlCoordinator,
} from '../src/lib/onAirControlCoordinator.js';

const WORKER = process.env.REKASONG_WORKER || 'http://127.0.0.1:8787';
const APP = process.env.REKASONG_APP || 'http://127.0.0.1:5100';
const SOAK_MS = positiveIntegerEnvironment('REKASONG_SOAK_MS', 600_000);
const SAMPLE_MS = positiveIntegerEnvironment('REKASONG_SOAK_SAMPLE_MS', 250);
const STABLE_MS = positiveIntegerEnvironment('REKASONG_SOAK_STABLE_MS', 1_500);
const FAIL_AFTER_MS = optionalPositiveIntegerEnvironment('REKASONG_SOAK_FAIL_AFTER_MS');
const CONTROL_READY_TIMEOUT_MS = 8_000;
const PLAYER_READY_TIMEOUT_MS = 10_000;
const ROUTE_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const APP_READY_TIMEOUT_MS = 20_000;
const CPU_RATIO_LIMIT = 0.01;
const SENSITIVE_QUERY_PARAMETER = /(token|key|auth|secret|password|passcode|credential|signature)/i;
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

let appServer = null;
let browser = null;
let cdp = null;
let coordinator = null;
let session = null;
let sessionEnded = false;
let page = null;
let measurementActive = false;
let auditBaseline = null;
let coordinatorChecks = 0;

const pageErrors = [];
const requestFailures = [];
const pageCrashes = [];
const browserDisconnects = [];
const mainFrameNavigations = [];
const commandResults = new Map();
const commandResultEvents = [];
const coordinatorStateChanges = [];
const coordinatorDiagnostics = [];
const controlSockets = [];
const pageSockets = [];
const violations = createViolationLedger();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds; received ${raw}`);
  }
  return parsed;
}

function optionalPositiveIntegerEnvironment(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds; received ${raw}`);
  }
  return parsed;
}

function createViolationLedger() {
  const entries = new Map();
  let total = 0;
  return {
    add(category, detail = '') {
      total += 1;
      const key = `${category}${detail ? `: ${detail}` : ''}`;
      const existing = entries.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastAt = new Date().toISOString();
      } else if (entries.size < 100) {
        const now = new Date().toISOString();
        entries.set(key, { category, detail, count: 1, firstAt: now, lastAt: now });
      }
    },
    report() {
      return { total, unique: entries.size, entries: [...entries.values()] };
    },
  };
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sensitiveRepresentations(secret) {
  const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  return new Set([secret, encodeURIComponent(secret), encodeURI(secret), formEncoded]);
}

function urlParameterSets(url) {
  const sets = [url.searchParams];
  const hashQueryIndex = url.hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    sets.push(new URLSearchParams(url.hash.slice(hashQueryIndex + 1)));
  }
  return sets;
}

function credentialValuesFromUrl(value, depth = 0, seen = new Set()) {
  if (typeof value !== 'string' || depth > 4 || seen.has(value)) return [];
  seen.add(value);
  try {
    const url = new URL(value);
    const found = [];
    if (url.username) found.push(url.username);
    if (url.password) found.push(url.password);
    for (const parameters of urlParameterSets(url)) {
      for (const [name, parameterValue] of parameters) {
        if (SENSITIVE_QUERY_PARAMETER.test(name)) {
          if (parameterValue) found.push(parameterValue);
        } else if (/^(https?|wss?):/i.test(parameterValue)) {
          found.push(...credentialValuesFromUrl(parameterValue, depth + 1, seen));
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

function knownCredentialValues() {
  return new Set([
    session?.controlToken,
    session?.playerToken,
    ...credentialValuesFromUrl(WORKER),
    ...credentialValuesFromUrl(APP),
  ].filter((value) => typeof value === 'string' && value.length > 0));
}

function redactKnownCredentialValues(value) {
  let result = String(value);
  for (const secret of knownCredentialValues()) {
    for (const representation of sensitiveRepresentations(secret)) {
      result = result.replaceAll(representation, '[REDACTED_TOKEN]');
    }
  }
  return result;
}

function redactSearchParameters(parameters, depth) {
  for (const [name, parameterValue] of [...parameters.entries()]) {
    if (SENSITIVE_QUERY_PARAMETER.test(name)) {
      parameters.set(name, '[REDACTED]');
    } else if (/^(https?|wss?):/i.test(parameterValue)) {
      parameters.set(
        name,
        depth >= 4 ? '[REDACTED_NESTED_URL]' : redactUrl(parameterValue, depth + 1),
      );
    }
  }
}

function redactUrl(value, depth = 0) {
  if (typeof value !== 'string') return '<redacted-non-string-url>';
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    redactSearchParameters(url.searchParams, depth);
    const hashQueryIndex = url.hash.indexOf('?');
    if (hashQueryIndex >= 0) {
      const hashPath = url.hash.slice(0, hashQueryIndex);
      const hashParameters = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
      redactSearchParameters(hashParameters, depth);
      url.hash = `${hashPath}?${hashParameters.toString()}`;
    }
    return redactKnownCredentialValues(url.toString());
  } catch {
    return '<redacted-unparseable-url>';
  }
}

function redactKnownUrlOccurrences(value, urls = [WORKER, APP]) {
  let result = String(value);
  for (const rawUrl of urls) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) continue;
    const safeUrl = redactUrl(rawUrl);
    const replacements = new Map([
      [rawUrl, safeUrl],
      [encodeURIComponent(rawUrl), encodeURIComponent(safeUrl)],
      [encodeURI(rawUrl), encodeURI(safeUrl)],
    ]);
    for (const [raw, safe] of replacements) result = result.replaceAll(raw, safe);
  }
  return result;
}

function redactSensitiveText(value) {
  return redactKnownCredentialValues(redactKnownUrlOccurrences(value));
}

function assertRedactionSelfCheck() {
  const sentinel = 'idle-soak-redaction-sentinel';
  const nestedWorker = `https://nested-user:nested-password@worker.invalid/`
    + `?auth=${sentinel}&safe=value`;
  const unsafeUrl = (
    `https://user:password@example.invalid/ws?token=${sentinel}&api_key=${sentinel}`
      + `&authorization=${sentinel}#/widget?playerToken=${sentinel}&auth=${sentinel}`
      + `&api=${encodeURIComponent(nestedWorker)}`
  );
  const redacted = redactUrl(unsafeUrl);
  const genericError = redactKnownUrlOccurrences(
    `failed url=${unsafeUrl} encoded=${encodeURIComponent(unsafeUrl)}`,
    [unsafeUrl],
  );
  const unsafeFragments = [
    sentinel,
    encodeURIComponent(sentinel),
    'user:password',
    'nested-user',
    'nested-password',
  ];
  if (unsafeFragments.some((fragment) => redacted.includes(fragment)
    || genericError.includes(fragment))) {
    throw new Error('URL redaction self-check failed');
  }
}

function assertNoCredentialSecrets(value, label) {
  const text = String(value);
  for (const secret of knownCredentialValues()) {
    for (const representation of sensitiveRepresentations(secret)) {
      if (text.includes(representation)) {
        throw new Error(`${label} contains a raw credential`);
      }
    }
  }
}

function invariant(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS ${label}${detail ? ` - ${detail}` : ''}`);
    return;
  }
  throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
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
  if (pageErrors.length > 0) throw new Error(`player page error: ${pageErrors.join(' | ')}`);
  if (requestFailures.length > 0) {
    throw new Error(`player request failure: ${compactJson(requestFailures.at(-1))}`);
  }
  if (pageCrashes.length > 0) throw new Error('player page crashed');
  if (browserDisconnects.length > 0) throw new Error('Chrome disconnected');
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
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
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
    desiredTransport: snapshot.playerSnapshot?.desiredTransport,
    confirmedPlayback: snapshot.playerSnapshot?.confirmedPlayback,
    pendingSwitch: snapshot.pendingSwitch,
    pendingCommandIds: snapshot.pendingCommandIds,
  } : null;
  throw new Error(`${label} timed out after ${timeoutMs}ms: ${compactJson(diagnostic)}`);
}

async function waitForCleanup(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      // Cleanup callers decide whether failure is fatal.
    }
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

async function fetchReachable(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function appendServerLog(target, chunk) {
  target.push(String(chunk));
  while (target.length > 40) target.shift();
}

async function ensureAppServer() {
  if (await fetchReachable(APP)) {
    console.log(`INFO App already reachable at ${redactUrl(APP)}; no Vite process started`);
    return;
  }
  const url = new URL(APP);
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) {
    throw new Error(
      `App ${redactUrl(APP)} is unreachable and is not an auto-startable local HTTP URL`,
    );
  }
  const port = url.port || '80';
  const logs = [];
  const child = spawn(process.execPath, [
    VITE_BIN,
    '--host', url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
    '--port', port,
    '--strictPort',
  ], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appServer = { child, logs, stopped: false };
  child.stdout.on('data', (chunk) => appendServerLog(logs, chunk));
  child.stderr.on('data', (chunk) => appendServerLog(logs, chunk));
  child.on('error', (error) => appendServerLog(logs, error.stack || error.message));
  console.log(`INFO Starting isolated Vite pid=${child.pid} at ${redactUrl(APP)}`);

  const deadline = performance.now() + APP_READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (await fetchReachable(APP, 500)) {
      console.log(`PASS isolated Vite is ready - pid=${child.pid}`);
      return;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(
    `Vite failed to become ready at ${redactUrl(APP)}; exit=${child.exitCode}`
      + `; logs=${redactSensitiveText(logs.join('').slice(-2_000))}`,
  );
}

async function stopAppServer() {
  if (!appServer || appServer.stopped) return;
  appServer.stopped = true;
  const { child } = appServer;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2_000),
    ]);
  }
  console.log(`INFO Stopped isolated Vite pid=${child.pid}`);
}

async function createSession() {
  const response = await fetch(`${WORKER.replace(/\/$/, '')}/v1/sessions`, { method: 'POST' });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`session creation returned non-JSON HTTP ${response.status}; body omitted`);
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

function createControlWebSocket(url) {
  const safeUrl = redactUrl(url);
  const record = {
    url: safeUrl,
    createdAt: Date.now(),
    openedAt: null,
    closedAt: null,
    closeCode: null,
    closeReason: null,
    errorCount: 0,
    socket: null,
  };
  if (measurementActive) violations.add('unexpected_control_socket_created', safeUrl);
  controlSockets.push(record);
  const socket = new WebSocket(url);
  record.socket = socket;
  socket.addEventListener('open', () => { record.openedAt = Date.now(); });
  socket.addEventListener('close', (event) => {
    record.closedAt = Date.now();
    record.closeCode = event.code;
    record.closeReason = event.reason;
    if (measurementActive) {
      violations.add('unexpected_control_socket_closed', `code=${event.code} reason=${event.reason}`);
    }
  });
  socket.addEventListener('error', () => {
    record.errorCount += 1;
    if (measurementActive) violations.add('control_socket_error');
  });
  return socket;
}

async function installObsBinding(targetPage) {
  await targetPage.addInitScript(() => {
    let activeListener = null;
    let visibleListener = null;
    const state = { active: true, visible: true };
    const diagnostic = {
      activeAssignments: 0,
      visibleAssignments: 0,
      activeInvocations: 0,
      visibleInvocations: 0,
      emissions: 0,
      state: { ...state },
    };
    window.__rekasongObsIdleBindingDiagnostic = diagnostic;
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
    };
    const binding = {
      pluginVersion: 'rekasong-v2-idle-soak-binding',
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
    emitRuntimeEvidence();
    window.setTimeout(emitRuntimeEvidence, 0);
    window.setTimeout(emitRuntimeEvidence, 250);
  });
}

async function mediaSnapshot() {
  return page.evaluate(() => {
    const roots = document.querySelectorAll('[data-on-air-player-v2-state]');
    const mediaElements = document.querySelectorAll('audio, video');
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    return {
      rootCount: roots.length,
      mediaCount: mediaElements.length,
      exists: Boolean(media),
      paused: media?.paused ?? null,
      ended: media?.ended ?? null,
      currentTime: media?.currentTime ?? null,
      currentSrc: media?.currentSrc ?? null,
      srcAttribute: media?.getAttribute('src') ?? null,
      sourceChildren: media?.querySelectorAll('source').length ?? null,
      srcObjectDetached: !media || !('srcObject' in media) || media.srcObject === null,
      networkState: media?.networkState ?? null,
      readyState: media?.readyState ?? null,
      autoplay: media?.autoplay ?? null,
      seeking: media?.seeking ?? null,
      error: media?.error ? { code: media.error.code, message: media.error.message } : null,
      isConnected: media?.isConnected ?? false,
      routeState: roots[0]?.getAttribute('data-on-air-player-v2-state') ?? null,
      binding: window.__rekasongObsIdleBindingDiagnostic ?? null,
      bindingVersion: window.obsstudio?.pluginVersion ?? null,
    };
  });
}

function mediaReadyErrors(media, expectedRouteState = null) {
  const errors = [];
  if (media.rootCount !== 1) errors.push(`root_count=${media.rootCount}`);
  if (media.mediaCount !== 1) errors.push(`media_count=${media.mediaCount}`);
  if (!media.exists || !media.isConnected) errors.push('media_missing_or_disconnected');
  if (media.paused !== true) errors.push(`paused=${media.paused}`);
  if (media.currentSrc !== '') errors.push(`current_src=${media.currentSrc}`);
  if (media.srcAttribute !== null) errors.push(`src_attribute=${media.srcAttribute}`);
  if (media.sourceChildren !== 0) errors.push(`source_children=${media.sourceChildren}`);
  if (!media.srcObjectDetached) errors.push('src_object_attached');
  if (media.autoplay !== false) errors.push(`autoplay=${media.autoplay}`);
  if (media.seeking !== false) errors.push(`seeking=${media.seeking}`);
  if (media.error !== null) errors.push(`media_error=${compactJson(media.error)}`);
  if (media.readyState !== 0) errors.push(`ready_state=${media.readyState}`);
  if (media.bindingVersion !== 'rekasong-v2-idle-soak-binding') {
    errors.push(`binding_version=${media.bindingVersion}`);
  }
  if (media.binding?.state?.active !== true) errors.push('binding_not_active');
  if (media.binding?.state?.visible !== true) errors.push('binding_not_visible');
  if (expectedRouteState !== null && media.routeState !== expectedRouteState) {
    errors.push(`route_state=${media.routeState}`);
  }
  return errors;
}

function readySnapshotErrors(snapshot, baseline = null) {
  const errors = [];
  const protocol = snapshot?.playerSnapshot;
  const players = protocol?.players || [];
  const candidates = protocol?.eligibleCandidates?.obs || [];
  const candidateId = baseline?.candidateId ?? candidates[0];
  const playerRecord = players.find((entry) => entry.playerInstanceId === candidateId);
  const connection = coordinator?.connection?.snapshot?.();
  if (snapshot?.state !== 'ready' || snapshot?.ready !== true) errors.push('control_not_ready');
  if (snapshot?.writable !== true) errors.push('control_not_writable');
  if (snapshot?.unknown !== false || snapshot?.authorityUnknown !== false) {
    errors.push('control_authority_unknown');
  }
  if (snapshot?.routeUnknown !== false) errors.push('route_unknown');
  if (snapshot?.unknownLock !== null) errors.push(`unknown_lock=${snapshot?.unknownLock?.code}`);
  if (snapshot?.pendingSwitch !== null) errors.push('pending_switch');
  if (snapshot?.pendingTest !== null) errors.push('pending_test');
  if (snapshot?.pendingTakeover !== null) errors.push('pending_takeover');
  if (snapshot?.activeRun !== null) errors.push('active_run');
  if ((snapshot?.pendingCommandIds || []).length !== 0) errors.push('pending_commands');
  if (players.length !== 1) errors.push(`player_count=${players.length}`);
  if (candidates.length !== 1 || new Set(candidates).size !== 1) {
    errors.push(`obs_candidate_count=${candidates.length}`);
  }
  if (!playerRecord) errors.push('candidate_player_missing');
  if (playerRecord?.clientKind !== 'obs-browser-source') {
    errors.push(`candidate_kind=${playerRecord?.clientKind}`);
  }
  if (playerRecord?.runtime?.sourceActive !== true) errors.push('candidate_not_active');
  if (playerRecord?.runtime?.sourceVisible !== true) errors.push('candidate_not_visible');
  if (protocol?.selectedOutputMode !== 'obs') {
    errors.push(`selected_output=${protocol?.selectedOutputMode}`);
  }
  if (protocol?.lease?.status !== 'ready') errors.push(`lease_status=${protocol?.lease?.status}`);
  if (protocol?.lease?.leaseTarget !== candidateId) errors.push('lease_target_changed');
  if (protocol?.lease?.clientKind !== 'obs-browser-source') {
    errors.push(`lease_kind=${protocol?.lease?.clientKind}`);
  }
  if (protocol?.confirmedPlayback?.status !== 'unknown'
    || protocol?.confirmedPlayback?.reasonCode !== 'output_ready_no_playback') {
    errors.push(`confirmed_playback=${compactJson(protocol?.confirmedPlayback)}`);
  }
  if (protocol?.confirmedPlayback?.audible === true
    || snapshot?.confirmedPlayback?.audible === true) errors.push('confirmed_audible');
  if (protocol?.activeFamily !== null) errors.push('protocol_active_family');
  if (protocol?.activeCheckId !== null) errors.push('protocol_active_check');
  if (protocol?.desiredTransport?.status !== 'idle'
    || protocol?.desiredTransport?.entryId !== null
    || protocol?.desiredTransport?.runId !== null
    || protocol?.desiredTransport?.song !== null) {
    errors.push(`desired_transport=${compactJson(protocol?.desiredTransport)}`);
  }
  if (protocol?.controlLease?.writableConnected !== true) errors.push('writable_control_disconnected');
  if (connection?.state !== 'ready') errors.push(`transport_state=${connection?.state}`);
  if (connection?.liveness?.unknown === true) errors.push('transport_liveness_unknown');

  if (baseline) {
    if (candidates[0] !== baseline.candidateId) errors.push('candidate_identity_changed');
    if (playerRecord?.connectionId !== baseline.playerConnectionId) {
      errors.push('player_connection_replaced');
    }
    if (protocol?.lease?.epoch !== baseline.leaseEpoch) errors.push('lease_epoch_changed');
    if (protocol?.lease?.switchId !== baseline.switchId) errors.push('lease_switch_changed');
    if (protocol?.controlLease?.controlEpoch !== baseline.controlEpoch) {
      errors.push('control_epoch_changed');
    }
    if (protocol?.controlLease?.writableControlInstanceId !== baseline.controlInstanceId) {
      errors.push('control_owner_changed');
    }
    if (snapshot?.welcome?.connectionId !== baseline.controlConnectionId) {
      errors.push('coordinator_connection_changed');
    }
    if (connection?.connectionId !== baseline.controlConnectionId) {
      errors.push('transport_connection_changed');
    }
    if (connection?.generation !== baseline.transportGeneration) {
      errors.push('transport_generation_changed');
    }
    if (snapshot?.testEvidence?.generation !== baseline.coordinatorGeneration) {
      errors.push('coordinator_generation_changed');
    }
    if ((snapshot?.diagnostics || []).length !== baseline.diagnosticCount) {
      errors.push('coordinator_diagnostics_added');
    }
  }
  return errors;
}

function auditCoordinator(snapshot = coordinator?.snapshot?.()) {
  if (!measurementActive || !auditBaseline) return;
  coordinatorChecks += 1;
  for (const error of readySnapshotErrors(snapshot, auditBaseline)) {
    violations.add('coordinator_invariant', error);
  }
}

async function establishStableReady(candidateId) {
  const first = await waitFor(async () => {
    const snapshot = coordinator.snapshot();
    const coordinatorErrors = readySnapshotErrors(snapshot);
    const media = await mediaSnapshot();
    const mediaErrors = mediaReadyErrors(media);
    return coordinatorErrors.length === 0 && mediaErrors.length === 0
      && snapshot.playerSnapshot.lease.leaseTarget === candidateId
      ? { snapshot, media }
      : null;
  }, ROUTE_TIMEOUT_MS, 'stable output_ready precondition');

  const deadline = performance.now() + STABLE_MS;
  while (performance.now() < deadline) {
    assertHealthy();
    const snapshotErrors = readySnapshotErrors(coordinator.snapshot());
    const mediaErrors = mediaReadyErrors(await mediaSnapshot(), first.media.routeState);
    if (snapshotErrors.length > 0 || mediaErrors.length > 0) {
      throw new Error(`output_ready was not stable: ${compactJson({ snapshotErrors, mediaErrors })}`);
    }
    await sleep(Math.min(100, Math.max(1, deadline - performance.now())));
  }
  return { snapshot: coordinator.snapshot(), media: await mediaSnapshot() };
}

async function startPageMeasurement(baselineMedia) {
  return page.evaluate(({ sampleMs, expectedRouteState, baselineBinding }) => {
    const state = {
      startedAt: performance.now(),
      longTaskSupported: PerformanceObserver.supportedEntryTypes?.includes('longtask') === true,
      longTaskCountOver50Ms: 0,
      longTaskDurationMs: 0,
      longestTaskMs: 0,
      mutationRecords: 0,
      mutationOperations: 0,
      mutationTypes: { attributes: 0, characterData: 0, childList: 0 },
      mediaChecks: 0,
      mediaViolationTotal: 0,
      mediaViolations: {},
      mediaEvents: {},
      unexpectedMediaEventCount: 0,
    };
    const media = document.querySelector('[data-on-air-player-v2-state] audio');
    const addMediaViolation = (code) => {
      state.mediaViolationTotal += 1;
      state.mediaViolations[code] = (state.mediaViolations[code] || 0) + 1;
    };
    const checkMedia = () => {
      state.mediaChecks += 1;
      const roots = document.querySelectorAll('[data-on-air-player-v2-state]');
      const allMedia = document.querySelectorAll('audio, video');
      const current = document.querySelector('[data-on-air-player-v2-state] audio');
      const binding = window.__rekasongObsIdleBindingDiagnostic;
      if (roots.length !== 1) addMediaViolation(`root_count_${roots.length}`);
      if (allMedia.length !== 1) addMediaViolation(`media_count_${allMedia.length}`);
      if (!current || current !== media || !current.isConnected) addMediaViolation('media_identity_changed');
      if (current?.paused !== true) addMediaViolation('not_paused');
      if (current?.currentSrc !== '') addMediaViolation('current_src_attached');
      if (current?.getAttribute('src') !== null) addMediaViolation('src_attribute_attached');
      if (current?.querySelectorAll('source').length !== 0) addMediaViolation('source_child_attached');
      if (current && 'srcObject' in current && current.srcObject !== null) {
        addMediaViolation('src_object_attached');
      }
      if (current?.autoplay !== false) addMediaViolation('autoplay_enabled');
      if (current?.seeking !== false) addMediaViolation('media_seeking');
      if (current?.readyState !== 0) addMediaViolation(`ready_state_${current?.readyState}`);
      if (current?.error) addMediaViolation(`media_error_${current.error.code}`);
      if (Math.abs((current?.currentTime ?? 0) - (media?.currentTime ?? 0)) > 0.001) {
        addMediaViolation('media_time_advanced');
      }
      if (roots[0]?.getAttribute('data-on-air-player-v2-state') !== expectedRouteState) {
        addMediaViolation('route_state_changed');
      }
      if (window.obsstudio?.pluginVersion !== 'rekasong-v2-idle-soak-binding') {
        addMediaViolation('obs_binding_replaced');
      }
      if (binding?.state?.active !== true) addMediaViolation('obs_binding_inactive');
      if (binding?.state?.visible !== true) addMediaViolation('obs_binding_invisible');
      if (binding?.activeAssignments !== baselineBinding.activeAssignments
        || binding?.visibleAssignments !== baselineBinding.visibleAssignments) {
        addMediaViolation('obs_binding_listener_reassigned');
      }
    };
    const consumeLongTasks = (entries) => {
      for (const entry of entries) {
        if (entry.duration > 50) {
          state.longTaskCountOver50Ms += 1;
          state.longTaskDurationMs += entry.duration;
          state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration);
        }
      }
    };
    const consumeMutations = (records) => {
      state.mutationRecords += records.length;
      for (const record of records) {
        state.mutationTypes[record.type] += 1;
        state.mutationOperations += record.type === 'childList'
          ? record.addedNodes.length + record.removedNodes.length
          : 1;
      }
    };
    const longTaskObserver = state.longTaskSupported
      ? new PerformanceObserver((list) => consumeLongTasks(list.getEntries()))
      : null;
    longTaskObserver?.observe({ type: 'longtask', buffered: false });
    const mutationObserver = new MutationObserver(consumeMutations);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const mediaEventTypes = [
      'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied', 'ended', 'error',
      'loadstart', 'loadeddata', 'loadedmetadata', 'pause', 'play', 'playing', 'progress',
      'ratechange', 'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate', 'volumechange',
      'waiting',
    ];
    const mediaEventListeners = mediaEventTypes.map((type) => {
      const listener = () => {
        state.mediaEvents[type] = (state.mediaEvents[type] || 0) + 1;
        state.unexpectedMediaEventCount += 1;
      };
      media?.addEventListener(type, listener);
      return [type, listener];
    });
    checkMedia();
    const timer = window.setInterval(checkMedia, sampleMs);
    window.__rekasongIdleSoakMeasurement = {
      stop() {
        window.clearInterval(timer);
        checkMedia();
        consumeMutations(mutationObserver.takeRecords());
        mutationObserver.disconnect();
        if (longTaskObserver) {
          consumeLongTasks(longTaskObserver.takeRecords());
          longTaskObserver.disconnect();
        }
        for (const [type, listener] of mediaEventListeners) {
          media?.removeEventListener(type, listener);
        }
        return {
          ...state,
          endedAt: performance.now(),
          measuredMs: performance.now() - state.startedAt,
        };
      },
    };
    return { ...state };
  }, {
    sampleMs: SAMPLE_MS,
    expectedRouteState: baselineMedia.routeState,
    baselineBinding: baselineMedia.binding,
  });
}

async function stopPageMeasurement() {
  return page.evaluate(() => {
    const measurement = window.__rekasongIdleSoakMeasurement;
    if (!measurement || typeof measurement.stop !== 'function') {
      throw new Error('page soak measurement is unavailable');
    }
    try {
      return measurement.stop();
    } finally {
      delete window.__rekasongIdleSoakMeasurement;
    }
  });
}

async function cleanupPageMeasurement() {
  if (!page || page.isClosed()) return false;
  return page.evaluate(() => {
    const measurement = window.__rekasongIdleSoakMeasurement;
    if (!measurement || typeof measurement.stop !== 'function') return false;
    try {
      measurement.stop();
      return true;
    } finally {
      delete window.__rekasongIdleSoakMeasurement;
    }
  }).catch(() => false);
}

async function performanceMetrics() {
  const response = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
}

function requiredMetric(metrics, name) {
  const value = metrics[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`CDP Performance metric ${name} is unavailable`);
  }
  return value;
}

function captureBaseline(ready) {
  const snapshot = ready.snapshot;
  const protocol = snapshot.playerSnapshot;
  const candidateId = protocol.eligibleCandidates.obs[0];
  const playerRecord = protocol.players.find((entry) => entry.playerInstanceId === candidateId);
  const connection = coordinator.connection.snapshot();
  return {
    candidateId,
    playerConnectionId: playerRecord.connectionId,
    leaseEpoch: protocol.lease.epoch,
    switchId: protocol.lease.switchId,
    controlEpoch: protocol.controlLease.controlEpoch,
    controlInstanceId: protocol.controlLease.writableControlInstanceId,
    controlConnectionId: connection.connectionId,
    transportGeneration: connection.generation,
    coordinatorGeneration: snapshot.testEvidence.generation,
    diagnosticCount: snapshot.diagnostics.length,
    mediaRouteState: ready.media.routeState,
  };
}

async function measureIdleReady(ready) {
  auditBaseline = captureBaseline(ready);
  const controlSocketBaseline = {
    count: controlSockets.length,
    open: controlSockets.filter((record) => record.socket?.readyState === WebSocket.OPEN).length,
    closed: controlSockets.filter((record) => record.closedAt !== null).length,
  };
  const pageSocketBaseline = {
    count: pageSockets.length,
    open: pageSockets.filter((record) => record.closedAt === null).length,
    closed: pageSockets.filter((record) => record.closedAt !== null).length,
  };
  const stateChangeBaseline = coordinatorStateChanges.length;
  const diagnosticEventBaseline = coordinatorDiagnostics.length;
  const commandEventBaseline = commandResultEvents.length;
  const navigationBaseline = mainFrameNavigations.length;
  const pageErrorBaseline = pageErrors.length;
  const requestFailureBaseline = requestFailures.length;

  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
  const startMetrics = await performanceMetrics();
  let sampler = null;
  let startedAt = null;
  let pageReport;
  let finalMedia;
  let endMetrics;
  let endedAt;
  try {
    await startPageMeasurement(ready.media);
    startedAt = performance.now();
    measurementActive = true;
    auditCoordinator();
    sampler = setInterval(() => auditCoordinator(), SAMPLE_MS);
    const progressInterval = Math.min(60_000, Math.max(5_000, Math.floor(SOAK_MS / 10)));
    let nextProgressAt = progressInterval;
    while (performance.now() - startedAt < SOAK_MS) {
      const elapsed = performance.now() - startedAt;
      const remaining = SOAK_MS - elapsed;
      await sleep(Math.min(SAMPLE_MS, Math.max(1, remaining)));
      auditCoordinator();
      const nowElapsed = performance.now() - startedAt;
      if (FAIL_AFTER_MS !== null && nowElapsed >= FAIL_AFTER_MS) {
        throw new Error(`injected soak failure after ${FAIL_AFTER_MS}ms`);
      }
      if (nowElapsed >= nextProgressAt && nowElapsed < SOAK_MS) {
        console.log(
          `INFO soak progress ${Math.floor(nowElapsed)}ms/${SOAK_MS}ms`
            + ` violations=${violations.report().total}`,
        );
        nextProgressAt += progressInterval;
      }
    }
    auditCoordinator();
    pageReport = await stopPageMeasurement();
    finalMedia = await mediaSnapshot();
    endMetrics = await performanceMetrics();
    endedAt = performance.now();
  } finally {
    if (sampler !== null) clearInterval(sampler);
    measurementActive = false;
    await cleanupPageMeasurement();
  }

  const elapsedMs = endedAt - startedAt;
  const taskDurationStartSeconds = requiredMetric(startMetrics, 'TaskDuration');
  const taskDurationEndSeconds = requiredMetric(endMetrics, 'TaskDuration');
  const taskDurationDeltaSeconds = taskDurationEndSeconds - taskDurationStartSeconds;
  const taskCpuRatio = taskDurationDeltaSeconds / (elapsedMs / 1_000);
  const heapStartBytes = requiredMetric(startMetrics, 'JSHeapUsedSize');
  const heapEndBytes = requiredMetric(endMetrics, 'JSHeapUsedSize');
  const nodesStart = requiredMetric(startMetrics, 'Nodes');
  const nodesEnd = requiredMetric(endMetrics, 'Nodes');

  const endSnapshotErrors = readySnapshotErrors(coordinator.snapshot(), auditBaseline);
  const endMediaErrors = mediaReadyErrors(finalMedia, auditBaseline.mediaRouteState);
  const controlSocketFinal = {
    count: controlSockets.length,
    open: controlSockets.filter((record) => record.socket?.readyState === WebSocket.OPEN).length,
    closed: controlSockets.filter((record) => record.closedAt !== null).length,
  };
  const pageSocketFinal = {
    count: pageSockets.length,
    open: pageSockets.filter((record) => record.closedAt === null).length,
    closed: pageSockets.filter((record) => record.closedAt !== null).length,
  };
  const measurementDeltas = {
    controlStateChanges: coordinatorStateChanges.length - stateChangeBaseline,
    coordinatorDiagnostics: coordinatorDiagnostics.length - diagnosticEventBaseline,
    commandResults: commandResultEvents.length - commandEventBaseline,
    mainFrameNavigations: mainFrameNavigations.length - navigationBaseline,
    pageErrors: pageErrors.length - pageErrorBaseline,
    requestFailures: requestFailures.length - requestFailureBaseline,
  };

  const gates = [
    { name: 'full_duration', passed: elapsedMs >= SOAK_MS, actual: elapsedMs, limit: SOAK_MS },
    {
      name: 'long_task_observer_supported',
      passed: pageReport.longTaskSupported === true,
      actual: pageReport.longTaskSupported,
    },
    {
      name: 'long_tasks_over_50ms_zero',
      passed: pageReport.longTaskCountOver50Ms === 0,
      actual: pageReport.longTaskCountOver50Ms,
      limit: 0,
    },
    {
      name: 'dom_mutations_zero',
      passed: pageReport.mutationRecords === 0 && pageReport.mutationOperations === 0,
      actual: { records: pageReport.mutationRecords, operations: pageReport.mutationOperations },
      limit: 0,
    },
    {
      name: 'task_cpu_ratio_below_1_percent',
      passed: taskCpuRatio >= 0 && taskCpuRatio < CPU_RATIO_LIMIT,
      actual: taskCpuRatio,
      limitExclusive: CPU_RATIO_LIMIT,
    },
    {
      name: 'coordinator_invariants_throughout',
      passed: coordinatorChecks > 0 && violations.report().total === 0,
      actual: { checks: coordinatorChecks, violations: violations.report().total },
      limit: 0,
    },
    {
      name: 'media_non_audible_throughout',
      passed: pageReport.mediaChecks > 0
        && pageReport.mediaViolationTotal === 0
        && pageReport.unexpectedMediaEventCount === 0,
      actual: {
        checks: pageReport.mediaChecks,
        violations: pageReport.mediaViolationTotal,
        unexpectedEvents: pageReport.unexpectedMediaEventCount,
      },
      limit: 0,
    },
    {
      name: 'final_ready_candidate_player_lease',
      passed: endSnapshotErrors.length === 0 && endMediaErrors.length === 0,
      actual: { coordinator: endSnapshotErrors, media: endMediaErrors },
    },
    {
      name: 'no_page_errors_or_request_failures',
      passed: pageErrors.length === 0 && requestFailures.length === 0
        && pageCrashes.length === 0 && browserDisconnects.length === 0,
      actual: {
        pageErrors: pageErrors.length,
        requestFailures: requestFailures.length,
        pageCrashes: pageCrashes.length,
        browserDisconnects: browserDisconnects.length,
      },
      limit: 0,
    },
    {
      name: 'no_reconnect_or_navigation',
      passed: controlSocketFinal.count === controlSocketBaseline.count
        && controlSocketFinal.open === controlSocketBaseline.open
        && controlSocketFinal.closed === controlSocketBaseline.closed
        && pageSocketFinal.count === pageSocketBaseline.count
        && pageSocketFinal.open === pageSocketBaseline.open
        && pageSocketFinal.closed === pageSocketBaseline.closed
        && measurementDeltas.controlStateChanges === 0
        && measurementDeltas.mainFrameNavigations === 0,
      actual: {
        controlSocketBaseline,
        controlSocketFinal,
        pageSocketBaseline,
        pageSocketFinal,
        controlStateChanges: measurementDeltas.controlStateChanges,
        mainFrameNavigations: measurementDeltas.mainFrameNavigations,
      },
    },
  ];

  return {
    protocol: 2,
    mode: 'obs',
    state: 'output_ready_no_playback',
    configuredDurationMs: SOAK_MS,
    elapsedMs,
    sampleIntervalMs: SAMPLE_MS,
    stableWindowMs: STABLE_MS,
    coordinatorChecks,
    pageMediaChecks: pageReport.mediaChecks,
    longTasks: {
      supported: pageReport.longTaskSupported,
      countOver50Ms: pageReport.longTaskCountOver50Ms,
      totalDurationMs: pageReport.longTaskDurationMs,
      longestMs: pageReport.longestTaskMs,
    },
    domMutations: {
      records: pageReport.mutationRecords,
      operations: pageReport.mutationOperations,
      types: pageReport.mutationTypes,
    },
    taskDuration: {
      startSeconds: taskDurationStartSeconds,
      endSeconds: taskDurationEndSeconds,
      deltaSeconds: taskDurationDeltaSeconds,
      cpuRatio: taskCpuRatio,
      cpuPercent: taskCpuRatio * 100,
    },
    jsHeap: {
      startBytes: heapStartBytes,
      endBytes: heapEndBytes,
      deltaBytes: heapEndBytes - heapStartBytes,
      collection: 'raw_cdp_metrics_no_forced_gc',
    },
    domNodes: { start: nodesStart, end: nodesEnd, delta: nodesEnd - nodesStart },
    media: {
      violations: pageReport.mediaViolationTotal,
      violationKinds: pageReport.mediaViolations,
      unexpectedEventCount: pageReport.unexpectedMediaEventCount,
      events: pageReport.mediaEvents,
      final: finalMedia,
    },
    baseline: auditBaseline,
    sockets: {
      control: { baseline: controlSocketBaseline, final: controlSocketFinal },
      page: { baseline: pageSocketBaseline, final: pageSocketFinal },
    },
    measurementDeltas,
    errors: {
      page: pageErrors,
      requests: requestFailures,
      crashes: pageCrashes,
      browserDisconnects,
    },
    invariantViolations: violations.report(),
    gates,
  };
}

async function verifyEndedStatus() {
  const response = await fetch(
    `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/status`,
    { headers: { Authorization: `Bearer ${session.controlToken}` } },
  );
  const body = await response.json().catch(() => null);
  if (response.status !== 410 || body?.status !== 'ended') {
    throw new Error(`ended session was not fenced: HTTP ${response.status} ${compactJson(body)}`);
  }
}

async function normalCleanup() {
  const cleanup = { deactivated: false, sessionEnded: false, endedStatusVerified: false };
  const deactivation = coordinator.deactivateOutput();
  cleanup.deactivated = await waitForCleanup(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.lease?.status === 'inactive'
      && snapshot.playerSnapshot?.lease?.leaseTarget === null
      && snapshot.pendingSwitch === null;
  }, CLEANUP_TIMEOUT_MS);
  if (!cleanup.deactivated || commandFailure(deactivation.command.commandId)) {
    throw new Error(`output deactivation failed: ${compactJson(commandFailure(deactivation.command.commandId))}`);
  }
  coordinator.endSession();
  cleanup.sessionEnded = await waitForCleanup(
    () => coordinator.snapshot().unknownLock?.code
      === ON_AIR_CONTROL_COORDINATOR_CODES.SESSION_ENDED,
    CLEANUP_TIMEOUT_MS,
  );
  if (!cleanup.sessionEnded) throw new Error('session_ended lifecycle timed out');
  sessionEnded = true;
  await verifyEndedStatus();
  cleanup.endedStatusVerified = true;
  return cleanup;
}

async function bestEffortCleanup() {
  measurementActive = false;
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
    // Preserve the original soak failure; cleanup is best effort here.
  }
}

function printReport(report) {
  console.log(`METRIC elapsed_ms=${report.elapsedMs.toFixed(3)}`);
  console.log(
    `METRIC long_tasks_over_50ms=${report.longTasks.countOver50Ms}`
      + ` duration_ms=${report.longTasks.totalDurationMs.toFixed(3)}`,
  );
  console.log(
    `METRIC dom_mutation_records=${report.domMutations.records}`
      + ` operations=${report.domMutations.operations}`,
  );
  console.log(
    `METRIC task_duration_delta_s=${report.taskDuration.deltaSeconds.toFixed(6)}`
      + ` cpu_ratio=${report.taskDuration.cpuRatio.toFixed(8)}`
      + ` cpu_percent=${report.taskDuration.cpuPercent.toFixed(6)}`,
  );
  console.log(
    `METRIC js_heap_start=${report.jsHeap.startBytes}`
      + ` end=${report.jsHeap.endBytes} delta=${report.jsHeap.deltaBytes}`,
  );
  console.log(
    `METRIC dom_nodes_start=${report.domNodes.start}`
      + ` end=${report.domNodes.end} delta=${report.domNodes.delta}`,
  );
  for (const gate of report.gates) {
    console.log(
      `${gate.passed ? 'PASS' : 'FAIL'} gate ${gate.name}`
        + ` - ${redactSensitiveText(compactJson(gate.actual))}`,
    );
  }
  const serialized = JSON.stringify(report);
  assertNoCredentialSecrets(serialized, 'EVIDENCE report');
  console.log(`EVIDENCE ${serialized}`);
}

async function run() {
  console.log(`INFO Worker ${redactUrl(WORKER)}`);
  console.log(`INFO App ${redactUrl(APP)}`);
  console.log(`INFO READY-idle soak duration ${SOAK_MS}ms`);
  if (FAIL_AFTER_MS !== null) {
    console.log(`INFO cleanup failure injection enabled at ${FAIL_AFTER_MS}ms`);
  }
  assertRedactionSelfCheck();
  console.log('PASS URL credential redaction self-check');
  await ensureAppServer();
  session = await createSession();

  coordinator = new OnAirControlCoordinator({
    transport: {
      url: websocketUrl(session.room, session.controlToken),
      sessionId: session.room,
      webSocketFactory: createControlWebSocket,
      buildId: 'rekasong-v2-idle-soak',
      capabilities: {},
    },
    callbacks: {
      onCommandResult(result) {
        const commandId = result?.entry?.commandId;
        if (typeof commandId === 'string') commandResults.set(commandId, result);
        commandResultEvents.push({ at: Date.now(), status: result?.status, commandId });
        if (measurementActive) violations.add('unexpected_command_result', `${result?.status}:${commandId}`);
      },
      onStateChange(change) {
        coordinatorStateChanges.push({ at: Date.now(), ...change });
        if (measurementActive) {
          violations.add('unexpected_control_state_change', redactSensitiveText(compactJson(change)));
        }
      },
      onDiagnostic(diagnostic) {
        coordinatorDiagnostics.push({ at: Date.now(), ...diagnostic });
        if (measurementActive) {
          violations.add(
            'unexpected_coordinator_diagnostic',
            redactSensitiveText(compactJson(diagnostic)),
          );
        }
      },
      onSnapshot(snapshot) {
        auditCoordinator(snapshot);
      },
    },
  });
  coordinator.connect();
  await waitFor(() => coordinator.snapshot().ready, CONTROL_READY_TIMEOUT_MS, 'control negotiation');
  invariant(coordinator.snapshot().writable, 'control coordinator is writable');

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  browser.on('disconnected', () => {
    browserDisconnects.push({ at: Date.now() });
    if (measurementActive) violations.add('chrome_disconnected');
  });
  page = await browser.newPage();
  page.on('pageerror', (error) => {
    const message = redactSensitiveText(error.message);
    pageErrors.push(message);
    if (measurementActive) violations.add('page_error', message);
  });
  page.on('requestfailed', (request) => {
    const record = {
      at: Date.now(),
      method: request.method(),
      resourceType: request.resourceType(),
      url: redactUrl(request.url()),
      errorText: request.failure()?.errorText
        ? redactSensitiveText(request.failure().errorText)
        : null,
    };
    requestFailures.push(record);
    if (measurementActive) violations.add('request_failed', `${record.errorText}:${record.url}`);
  });
  page.on('crash', () => {
    pageCrashes.push({ at: Date.now() });
    if (measurementActive) violations.add('page_crashed');
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const safeUrl = redactUrl(frame.url());
    mainFrameNavigations.push({ at: Date.now(), url: safeUrl });
    if (measurementActive) violations.add('unexpected_main_frame_navigation', safeUrl);
  });
  page.on('websocket', (webSocket) => {
    const record = {
      url: redactUrl(webSocket.url()),
      createdAt: Date.now(),
      closedAt: null,
      errors: [],
    };
    pageSockets.push(record);
    if (measurementActive) violations.add('unexpected_page_socket_created', record.url);
    webSocket.on('close', () => {
      record.closedAt = Date.now();
      if (measurementActive) violations.add('unexpected_page_socket_closed', record.url);
    });
    webSocket.on('socketerror', (error) => {
      const message = redactSensitiveText(error);
      record.errors.push(message);
      if (measurementActive) violations.add('page_socket_error', `${record.url}:${message}`);
    });
  });

  cdp = await page.context().newCDPSession(page);
  await installObsBinding(page);
  await page.goto(widgetUrl(session.room, session.playerToken), { waitUntil: 'domcontentloaded' });

  const candidate = await waitFor(() => {
    const snapshot = coordinator.snapshot().playerSnapshot;
    const candidateIds = snapshot?.eligibleCandidates?.obs || [];
    const playerRecord = snapshot?.players?.find(
      (entry) => entry.playerInstanceId === candidateIds[0],
    );
    return snapshot?.players?.length === 1
      && candidateIds.length === 1
      && playerRecord?.clientKind === 'obs-browser-source'
      && playerRecord.runtime?.sourceActive === true
      && playerRecord.runtime?.sourceVisible === true
      ? { candidateId: candidateIds[0], playerRecord }
      : null;
  }, PLAYER_READY_TIMEOUT_MS, 'one active and visible OBS candidate');
  invariant(candidate.candidateId === candidate.playerRecord.playerInstanceId, 'one OBS player/candidate');

  await waitFor(
    () => page.evaluate(() => document.querySelectorAll(
      '[data-on-air-player-v2-state] audio',
    ).length === 1),
    PLAYER_READY_TIMEOUT_MS,
    'one Protocol v2 media element',
  );

  const activation = coordinator.activateOutput('obs');
  await waitFor(() => {
    const snapshot = coordinator.snapshot();
    return snapshot.playerSnapshot?.selectedOutputMode === 'obs'
      && snapshot.playerSnapshot?.lease?.status === 'ready'
      && snapshot.playerSnapshot?.lease?.leaseTarget === candidate.candidateId
      && snapshot.playerSnapshot?.confirmedPlayback?.reasonCode === 'output_ready_no_playback'
      && snapshot.pendingSwitch === null
      && snapshot.pendingCommandIds.length === 0
      ? snapshot
      : null;
  }, ROUTE_TIMEOUT_MS, 'output_ready', { commandId: activation.command.commandId });
  console.log('PASS OBS activation reached output_ready without playback');

  const ready = await establishStableReady(candidate.candidateId);
  console.log(`PASS output_ready remained stable for ${STABLE_MS}ms`);
  const report = await measureIdleReady(ready);

  let cleanup;
  try {
    cleanup = await normalCleanup();
    console.log('PASS output deactivated and session ended cleanly');
  } catch (error) {
    cleanup = { deactivated: false, sessionEnded: false, endedStatusVerified: false, error: error.message };
    report.gates.push({ name: 'clean_deactivation_and_session_end', passed: false, actual: cleanup });
    await bestEffortCleanup();
  }
  if (!report.gates.some((gate) => gate.name === 'clean_deactivation_and_session_end')) {
    report.gates.push({
      name: 'clean_deactivation_and_session_end',
      passed: cleanup.deactivated && cleanup.sessionEnded && cleanup.endedStatusVerified,
      actual: cleanup,
    });
  }
  report.cleanup = cleanup;
  report.passed = report.gates.every((gate) => gate.passed);
  printReport(report);
  invariant(report.passed, 'Protocol v2 READY-idle soak gates');
  console.log(`RESULT Protocol v2 READY-idle soak passed (${SOAK_MS}ms configured)`);
}

try {
  await run();
} catch (error) {
  console.error(
    `FAIL Protocol v2 READY-idle soak - ${redactSensitiveText(error?.stack || error)}`,
  );
  process.exitCode = 1;
} finally {
  await bestEffortCleanup();
  coordinator?.dispose();
  await cdp?.detach().catch(() => {});
  await browser?.close().catch(() => {});
  await stopAppServer();
}
