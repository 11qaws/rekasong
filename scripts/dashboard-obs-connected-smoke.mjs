import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import {
  buildOnAirPlayerUrl,
  ON_AIR_SESSION_STORAGE_KEY,
} from '../src/hooks/useOnAirSession.js';

const WORKER = process.env.REKASONG_WORKER;
assert.ok(
  WORKER,
  'Set REKASONG_WORKER explicitly before running the connected Dashboard smoke. This prevents accidental production Worker traffic.',
);
const workerUrl = new URL(WORKER);
const isExplicitProductionWorker = workerUrl.hostname === 'rekasong-session.11qaws.workers.dev';
const productionWorkerPermitted = process.env.REKASONG_ALLOW_PRODUCTION_WORKER === '1';
assert.ok(
  ['127.0.0.1', 'localhost', 'rekasong-session.11qaws-test.workers.dev']
    .includes(workerUrl.hostname)
    || (isExplicitProductionWorker && productionWorkerPermitted),
  `Connected Dashboard smoke allows local/staging; production requires REKASONG_ALLOW_PRODUCTION_WORKER=1. Received ${workerUrl.hostname}.`,
);

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the connected Dashboard smoke.');

const createWavFixture = ({ durationSeconds = 6, sampleRate = 48_000 } = {}) => {
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
};

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const waitForServer = async (url, child, logs) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard did not become reachable at ${url}. ${logs.join('').slice(-2_000)}`);
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const setRangeDraft = async (locator, value) => {
  await locator.focus();
  await locator.evaluate((input, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
};

const setProfileVolume = async (page, mode, value) => {
  const slider = page.locator(`.output-volume-profile-row[data-output-mode="${mode}"] input`);
  await setRangeDraft(slider, value);
  await page.waitForFunction(({ outputMode, expected }) => (
    document.querySelector(`.output-volume-profile-row[data-output-mode="${outputMode}"] output`)
      ?.textContent?.trim() === `${expected}%`
  ), { outputMode: mode, expected: value });
  await slider.blur();
};

const installObsBinding = async (page) => {
  await page.addInitScript(() => {
    let activeListener = null;
    let visibleListener = null;
    const invoke = (listener, value) => {
      if (typeof listener === 'function') listener(value);
    };
    const binding = {
      pluginVersion: 'rekasong-dashboard-connected-smoke',
      getControlLevel(callback) { invoke(callback, 5); },
      getStatus(callback) { invoke(callback, { streaming: false, recording: false }); },
    };
    Object.defineProperties(binding, {
      onActiveChange: {
        configurable: true,
        enumerable: true,
        get: () => activeListener,
        set(listener) {
          activeListener = listener;
          invoke(listener, true);
        },
      },
      onVisibilityChange: {
        configurable: true,
        enumerable: true,
        get: () => visibleListener,
        set(listener) {
          visibleListener = listener;
          invoke(listener, true);
        },
      },
    });
    window.obsstudio = binding;
    const emit = () => {
      invoke(activeListener, true);
      invoke(visibleListener, true);
      window.dispatchEvent(new CustomEvent('obsSourceActiveChanged', {
        detail: { active: true },
      }));
      window.dispatchEvent(new CustomEvent('obsSourceVisibleChanged', {
        detail: { visible: true },
      }));
    };
    emit();
    window.setTimeout(emit, 0);
    window.setTimeout(emit, 250);
  });
};

const port = await reservePort();
const appUrl = `http://127.0.0.1:${port}/`;
const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const viteLogs = [];
const vite = spawn(process.execPath, [
  vitePath,
  '--mode', 'staging',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    BROWSER: 'none',
    VITE_ON_AIR_BASE_URL: WORKER,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
vite.stdout.on('data', (chunk) => viteLogs.push(String(chunk)));
vite.stderr.on('data', (chunk) => viteLogs.push(String(chunk)));

let browser = null;
let context = null;
let dashboard = null;
let player = null;
let standbyPlayer = null;
let session = null;
const pageErrors = [];
const consoleErrors = [];
const sentFrames = [];

try {
  await waitForServer(appUrl, vite, viteLogs);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  dashboard = await context.newPage();
  await dashboard.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__rekasongConnectedSmokeSentFrames = [];
    window.__rekasongConnectedSmokeReceivedFrames = [];
    window.WebSocket = class RekasongConnectedSmokeWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            window.__rekasongConnectedSmokeReceivedFrames.push(event.data);
          }
        });
      }
      send(data) {
        if (typeof data === 'string') window.__rekasongConnectedSmokeSentFrames.push(data);
        return super.send(data);
      }
    };
    if (sessionStorage.getItem('rekasong-connected-output-smoke') !== '1') {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('rekasong-connected-output-smoke', '1');
    }
    localStorage.setItem('rekasong.locale', 'en');
  });
  dashboard.on('pageerror', (error) => pageErrors.push(`dashboard:${error.message}`));
  dashboard.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`dashboard:${message.text()}`);
  });
  dashboard.on('websocket', (socket) => {
    socket.on('framesent', (event) => {
      if (typeof event.payload !== 'string') return;
      try {
        sentFrames.push(JSON.parse(event.payload));
      } catch {
        // Binary/non-JSON diagnostics are irrelevant to command counts.
      }
    });
  });
  await dashboard.route('**/api/extract-local', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: 'data: {"mode":"rules"}\n\n',
  }));
  await dashboard.route('**/api/title-cache', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));

  await dashboard.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dashboard.locator('#output-route-live-status.is-speaker').waitFor({
    state: 'visible',
    timeout: 20_000,
  });

  await dashboard.locator('.output-settings-button').click();
  await dashboard.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
  await setProfileVolume(dashboard, 'speaker', 34);
  await setProfileVolume(dashboard, 'obs', 61);
  await dashboard.locator('#obs-setup-dialog > header .btn-icon').click();

  await dashboard.locator('.song-composer input[type="file"][accept]').setInputFiles({
    name: 'speaker-profile.wav',
    mimeType: 'audio/wav',
    buffer: createWavFixture({ durationSeconds: 3 }),
  });
  await dashboard.locator('.staging-action-buttons .go-live-btn').first().click();
  const speakerAudio = dashboard.locator('[data-local-speaker-state="ready"] audio');
  await dashboard.waitForFunction(() => {
    const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
    return audio && !audio.paused && audio.currentTime > 0.05;
  });
  assert.equal(await speakerAudio.evaluate((audio) => audio.volume), 0.34);
  await dashboard.locator('.playback-controls .btn-icon-danger').click();
  await dashboard.locator('.playback-idle').waitFor({ state: 'visible', timeout: 10_000 });

  await dashboard.locator('.output-settings-button').click();
  const routeButtons = dashboard.locator('.output-route-button');
  await routeButtons.nth(1).click();
  await dashboard.waitForFunction((sessionKey) => Boolean(localStorage.getItem(sessionKey)),
    ON_AIR_SESSION_STORAGE_KEY, { timeout: 20_000 });
  session = await dashboard.evaluate((sessionKey) => (
    JSON.parse(localStorage.getItem(sessionKey) || 'null')
  ), ON_AIR_SESSION_STORAGE_KEY);
  assert.ok(session?.room && session?.controlToken && session?.playerToken);

  player = await context.newPage();
  player.on('pageerror', (error) => pageErrors.push(`player:${error.message}`));
  player.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`player:${message.text()}`);
  });
  await installObsBinding(player);
  const playerUrl = buildOnAirPlayerUrl({
    origin: new URL(appUrl).origin,
    pathname: '/',
    baseUrl: WORKER,
    session,
  });
  await player.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await player.locator('[data-on-air-player-v2-state] audio').waitFor({
    state: 'attached',
    timeout: 20_000,
  });
  try {
    await dashboard.locator('#output-route-live-status.is-obs').waitFor({
      state: 'visible',
      timeout: 20_000,
    });
  } catch (error) {
    const diagnostic = {
      dashboard: await dashboard.evaluate(() => ({
        liveStatus: document.querySelector('#output-route-live-status')?.outerHTML ?? null,
        routeButtons: [...document.querySelectorAll('.output-route-button')].map((button) => ({
          text: button.textContent?.trim(),
          checked: button.getAttribute('aria-checked'),
          disabled: button.getAttribute('aria-disabled'),
        })),
        setupStatus: document.querySelector('.output-route-details-status')?.textContent?.trim() ?? null,
        nextAction: document.querySelector('.output-route-next-action')?.textContent?.trim() ?? null,
        playerStatuses: [...document.querySelectorAll('.obs-player-status')]
          .map((element) => ({ className: element.className, text: element.textContent?.trim() })),
      })),
      player: await player.evaluate(() => ({
        state: document.querySelector('[data-on-air-player-v2-state]')
          ?.getAttribute('data-on-air-player-v2-state') ?? null,
        hasObsBinding: Boolean(window.obsstudio),
        audio: (() => {
          const audio = document.querySelector('[data-on-air-player-v2-state] audio');
          return audio ? { paused: audio.paused, volume: audio.volume, src: audio.getAttribute('src') } : null;
        })(),
      })),
      sentFrameTypes: sentFrames.map((frame) => frame?.type ?? null),
      pageErrors,
      consoleErrors,
    };
    process.stderr.write(`CONNECTED_UI_DIAGNOSTIC ${JSON.stringify(diagnostic, null, 2)}\n`);
    throw error;
  }
  await dashboard.locator('.obs-player-status.is-on').waitFor({ state: 'visible', timeout: 20_000 });

  const connectedUiEvidence = {
    selectedObs: await routeButtons.nth(1).getAttribute('aria-checked'),
    actualStatus: (await dashboard.locator('#output-route-live-status').innerText()).trim(),
    playerPresence: (await dashboard.locator('.obs-player-status.is-on').innerText()).trim(),
    nextAction: (await dashboard.locator('.output-route-next-action').innerText()).trim(),
  };
  assert.equal(connectedUiEvidence.selectedObs, 'true');
  assert.match(connectedUiEvidence.actualStatus, /OBS/i);
  assert.ok(connectedUiEvidence.nextAction.length > 10);

  // Candidate cardinality is strict before activation, but a second standby
  // source must not revoke an already established exact lease. Keep the
  // duplicate connected through a full media-control cycle and prove that it
  // never receives or plays the leased target's media.
  standbyPlayer = await context.newPage();
  standbyPlayer.on('pageerror', (error) => pageErrors.push(`standby:${error.message}`));
  standbyPlayer.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`standby:${message.text()}`);
  });
  await installObsBinding(standbyPlayer);
  await standbyPlayer.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const standbyAudio = standbyPlayer.locator('[data-on-air-player-v2-state] audio');
  await standbyAudio.waitFor({ state: 'attached', timeout: 20_000 });
  await dashboard.locator('.obs-player-status.is-error').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  const duplicateUiEvidence = {
    actualStatus: (await dashboard.locator('#output-route-live-status').innerText()).trim(),
    detail: (await dashboard.locator('.output-route-authoritative-detail').innerText()).trim(),
    nextAction: (await dashboard.locator('.output-route-next-action').innerText()).trim(),
    obsRouteEnabled: await routeButtons.nth(1).isEnabled(),
    settingsNeedsAttention: await dashboard.locator('.output-settings-button')
      .evaluate((button) => button.classList.contains('has-attention')),
  };
  assert.match(duplicateUiEvidence.actualStatus, /OBS/i);
  assert.match(duplicateUiEvidence.detail, /stay connected|remain connected/i);
  assert.match(duplicateUiEvidence.nextAction, /keep using|remove only/i);
  assert.equal(duplicateUiEvidence.obsRouteEnabled, true);
  assert.equal(duplicateUiEvidence.settingsNeedsAttention, false);
  await dashboard.locator('#obs-setup-dialog > header .btn-icon').click();

  await dashboard.locator('.song-composer input[type="file"][accept]').setInputFiles({
    name: 'obs-profile.wav',
    mimeType: 'audio/wav',
    buffer: createWavFixture({ durationSeconds: 8 }),
  });
  const playObsButton = dashboard.locator('.staging-action-buttons .go-live-btn').first();
  await playObsButton.waitFor({ state: 'visible' });
  await assert.doesNotReject(() => playObsButton.click({ timeout: 30_000 }));
  const obsAudio = player.locator('[data-on-air-player-v2-state] audio');
  await player.waitForFunction(() => {
    const audio = document.querySelector('[data-on-air-player-v2-state] audio');
    return audio && !audio.paused && audio.currentTime > 0.05;
  }, null, { timeout: 30_000 });
  assert.equal(await obsAudio.evaluate((audio) => audio.volume), 0.61);
  assert.deepEqual(
    await standbyAudio.evaluate((audio) => ({
      paused: audio.paused,
      hasSource: Boolean(audio.currentSrc || audio.getAttribute('src')),
    })),
    { paused: true, hasSource: false },
    'The additional OBS source must remain silent and source-detached.',
  );

  const playbackToggle = dashboard.locator('.playback-controls .playback-primary');
  await dashboard.waitForFunction(() => {
    const button = document.querySelector('.playback-controls .playback-primary');
    return button instanceof HTMLButtonElement && button.disabled === false;
  }, null, { timeout: 10_000 });
  assert.equal(await playbackToggle.isEnabled(), true);
  await playbackToggle.click();
  await player.waitForFunction(() => {
    const audio = document.querySelector('[data-on-air-player-v2-state] audio');
    return audio?.paused === true;
  }, null, { timeout: 10_000 });
  assert.equal(await standbyAudio.evaluate((audio) => audio.paused), true);
  await playbackToggle.click();
  await player.waitForFunction(() => {
    const audio = document.querySelector('[data-on-air-player-v2-state] audio');
    return audio && !audio.paused;
  }, null, { timeout: 10_000 });

  const readVolumeCommands = async () => dashboard.evaluate(() => (
    (window.__rekasongConnectedSmokeSentFrames || []).flatMap((payload) => {
      try {
        const frame = JSON.parse(payload);
        return frame?.type === 'volume' ? [frame] : [];
      } catch {
        return [];
      }
    })
  ));
  const beforeDraft = (await readVolumeCommands()).length;
  const activeVolume = dashboard.locator('.playback-controls .volume-slider');
  await setRangeDraft(activeVolume, 60);
  await dashboard.waitForFunction(() => (
    document.querySelector('.playback-controls .volume-slider')
      ?.getAttribute('aria-valuetext') === '60%'
  ));
  await dashboard.waitForTimeout(350);
  assert.equal(
    (await readVolumeCommands()).length,
    beforeDraft,
    'Previewing the volume sent a premature WebSocket command.',
  );
  await activeVolume.press('Enter');
  await dashboard.waitForFunction(() => {
    try {
      return JSON.parse(localStorage.getItem('rekasong.output-volume-profiles.v1') || 'null')
        ?.obs === 60;
    } catch {
      return false;
    }
  });
  const commandDeadline = Date.now() + 10_000;
  let committedVolumeCommands = await readVolumeCommands();
  while (committedVolumeCommands.length === beforeDraft && Date.now() < commandDeadline) {
    await dashboard.waitForTimeout(50);
    committedVolumeCommands = await readVolumeCommands();
  }
  assert.equal(
    committedVolumeCommands.length,
    beforeDraft + 1,
    'One committed OBS volume change must send exactly one command.',
  );
  await player.waitForFunction(() => {
    const audio = document.querySelector('[data-on-air-player-v2-state] audio');
    return audio && Math.abs(audio.volume - 0.6) < 0.001;
  }, null, { timeout: 10_000 });
  const obsCommittedMediaVolume = await obsAudio.evaluate((audio) => audio.volume);

  const persistedProfiles = await dashboard.evaluate(() => JSON.parse(
    localStorage.getItem('rekasong.output-volume-profiles.v1') || 'null',
  ));
  assert.deepEqual(persistedProfiles, { version: 1, speaker: 34, obs: 60 });

  await dashboard.locator('.playback-controls .btn-icon-danger').click();
  try {
    await dashboard.locator('.playback-idle').waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const discardDiagnostic = {
      playbackText: await dashboard.locator('.playback-panel').innerText().catch(() => null),
      discardDisabled: await dashboard.locator('.playback-controls .btn-icon-danger')
        .isDisabled().catch(() => null),
      player: await player.evaluate(() => {
        const audio = document.querySelector('[data-on-air-player-v2-state] audio');
        return {
          state: document.querySelector('[data-on-air-player-v2-state]')
            ?.getAttribute('data-on-air-player-v2-state') ?? null,
          paused: audio?.paused ?? null,
          currentTime: audio?.currentTime ?? null,
          src: audio?.getAttribute('src') ?? null,
        };
      }),
      sentFrameTypes: await dashboard.evaluate(() => (
        (window.__rekasongConnectedSmokeSentFrames || []).flatMap((payload) => {
          try { return [JSON.parse(payload)?.type ?? null]; } catch { return []; }
        })
      )),
      receivedFrames: await dashboard.evaluate(() => (
        (window.__rekasongConnectedSmokeReceivedFrames || []).flatMap((payload) => {
          try {
            const frame = JSON.parse(payload);
            if (!['player_snapshot', 'command_ack', 'command_rejected'].includes(frame?.type)) {
              return [];
            }
            return [{
              type: frame.type,
              commandId: frame.commandId ?? null,
              result: frame.result ?? null,
              confirmedPlayback: frame.confirmedPlayback
                ?? frame.snapshot?.confirmedPlayback
                ?? frame.playerSnapshot?.confirmedPlayback
                ?? null,
              desiredTransport: frame.desiredTransport
                ?? frame.snapshot?.desiredTransport
                ?? frame.playerSnapshot?.desiredTransport
                ?? null,
              activeFamily: frame.activeFamily
                ?? frame.snapshot?.activeFamily
                ?? frame.playerSnapshot?.activeFamily
                ?? null,
            }];
          } catch {
            return [];
          }
        }).slice(-12)
      )),
    };
    process.stderr.write(`DISCARD_DIAGNOSTIC ${JSON.stringify(discardDiagnostic, null, 2)}\n`);
    throw error;
  }
  const duplicatePlaybackEvidence = {
    leasedPlayerStopped: await obsAudio.evaluate((audio) => (
      audio.paused && !audio.getAttribute('src')
    )),
    standbyPlayerSilent: await standbyAudio.evaluate((audio) => (
      audio.paused && !audio.getAttribute('src')
    )),
    routeStayedObs: /OBS/i.test(
      (await dashboard.locator('#output-route-live-status').innerText()).trim(),
    ),
  };
  assert.deepEqual(duplicatePlaybackEvidence, {
    leasedPlayerStopped: true,
    standbyPlayerSilent: true,
    routeStayedObs: true,
  });
  await standbyPlayer.close();
  standbyPlayer = null;
  await dashboard.locator('.output-settings-button').click();
  await routeButtons.nth(0).click();
  await dashboard.locator('#output-route-live-status.is-speaker').waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  assert.equal(
    await dashboard.locator('.output-volume-profile-row[data-output-mode="speaker"] input').inputValue(),
    '34',
  );
  assert.equal(
    await dashboard.locator('.output-volume-profile-row[data-output-mode="obs"] input').inputValue(),
    '60',
  );

  // Re-open the already prepared, silent OBS route only to expose the explicit
  // session-end action. No media command or automatic playback is allowed.
  await routeButtons.nth(1).click();
  await dashboard.locator('#output-route-live-status.is-obs').waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  dashboard.once('dialog', (dialog) => dialog.accept());
  await dashboard.getByRole('button', { name: 'End broadcast session' }).click();
  const endedDeadline = Date.now() + 15_000;
  let endedStatus = null;
  while (Date.now() < endedDeadline) {
    const response = await fetch(
      `${WORKER.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session.room)}/status`,
      { headers: { Authorization: `Bearer ${session.controlToken}` } },
    );
    endedStatus = response.status;
    if (endedStatus === 410) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(endedStatus, 410, 'The connected test session was not ended during cleanup.');

  await dashboard.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dashboard.locator('#output-route-live-status.is-speaker').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await dashboard.locator('.output-settings-button').click();
  assert.equal(
    await dashboard.locator('.output-volume-profile-row[data-output-mode="speaker"] input').inputValue(),
    '34',
  );
  assert.equal(
    await dashboard.locator('.output-volume-profile-row[data-output-mode="obs"] input').inputValue(),
    '60',
  );

  const benignConsoleError = /favicon|ERR_ABORTED|WebSocket is closed/i;
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors.filter((message) => !benignConsoleError.test(message)), []);
  process.stdout.write(`${JSON.stringify({
    appUrl,
    worker: workerUrl.origin,
    safety: {
      environment: isExplicitProductionWorker
        ? 'production Worker with a fresh isolated test session'
        : 'staging/local Worker',
      obsBindingStatus: { streaming: false, recording: false },
      actualBroadcastStarted: false,
    },
    connectedUiEvidence,
    duplicateUiEvidence,
    duplicatePlaybackEvidence,
    volumeEvidence: {
      speakerMediaVolume: 0.34,
      obsInitialMediaVolume: 0.61,
      obsCommittedMediaVolume,
      committedVolumeCommands: committedVolumeCommands.length,
      profilesAfterReload: { speaker: 34, obs: 60 },
    },
    cleanup: { sessionStatus: endedStatus },
    pageErrors,
  }, null, 2)}\n`);
} finally {
  await standbyPlayer?.close().catch(() => {});
  await player?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopChild(vite);
}
