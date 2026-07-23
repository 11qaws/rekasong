import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  LEGACY_SYNC_STORAGE_KEY,
  SHARED_SYNC_STORAGE_KEY,
  TAB_SYNC_STORAGE_KEY,
} from '../src/lib/syncStorageKeys.js';

const VIDEO_ID = 'cv7zqJhKoVE';
const SESSION_PATH = /^\/v1\/sessions(?:\/|$)/;
const SESSION_SOCKET_PATH = /^\/v1\/sessions\/[^/]+\/ws$/;
const LOCAL_SPEAKER_CHUNK = /\/(?:DashboardLocalSpeaker|playbackEngine)-[^/]+\.js(?:\?|$)/;
const REMOTE_MEDIA_CHUNK = /\/(?:onAirPrefetchCache|onAirSourceResolver)-[^/]+\.js(?:\?|$)/;

const createWavFixture = ({ durationSeconds = 1, sampleRate = 48_000 } = {}) => {
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
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
};

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the Speaker network smoke test.');

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
    if (child && child.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Production preview is still starting.
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

const setRangeValueAndBlur = async (page, locator, value) => {
  await locator.focus();
  await locator.evaluate((input, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const mode = await locator.evaluate((input) => (
    input.closest('[data-output-mode]')?.dataset.outputMode
  ));
  await page.waitForFunction(({ outputMode, expected }) => (
    document.querySelector(`.output-volume-profile-row[data-output-mode="${outputMode}"] output`)
      ?.textContent?.trim() === `${expected}%`
  ), { outputMode: mode, expected: value });
  await locator.blur();
};

const requestedUrl = process.argv[2] ? new URL(process.argv[2]).href : null;
const port = requestedUrl ? null : await reservePort();
const appUrl = requestedUrl || `http://127.0.0.1:${port}/`;
const viteLogs = [];
let vite = null;

if (!requestedUrl) {
  const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  vite = spawn(process.execPath, [
    vitePath,
    'preview',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  vite.stdout.on('data', (chunk) => viteLogs.push(String(chunk)));
  vite.stderr.on('data', (chunk) => viteLogs.push(String(chunk)));
}

let browser;
try {
  await waitForServer(appUrl, vite, viteLogs);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript(({ legacyKey, sharedKey, tabKey }) => {
    if (sessionStorage.getItem('rekasong-speaker-demand-smoke-initialized') !== '1') {
      localStorage.removeItem('rekasong-on-air-session-v1');
      localStorage.removeItem(legacyKey);
      localStorage.removeItem(sharedKey);
      sessionStorage.removeItem(tabKey);
      sessionStorage.setItem('rekasong-speaker-demand-smoke-initialized', '1');
    }
    localStorage.setItem('rekasong.locale', 'en');
  }, {
    legacyKey: LEGACY_SYNC_STORAGE_KEY,
    sharedKey: SHARED_SYNC_STORAGE_KEY,
    tabKey: TAB_SYNC_STORAGE_KEY,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const workerHostRequests = [];
  const sessionHttpRequests = [];
  const sessionSockets = [];
  let sessionSocketFramesSent = 0;
  let obsAssetUploadAttempts = 0;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/workers\.dev$/i.test(url.hostname)) workerHostRequests.push(url.pathname);
    if (SESSION_PATH.test(url.pathname)) {
      sessionHttpRequests.push({ method: request.method(), path: url.pathname });
    }
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (!SESSION_SOCKET_PATH.test(url.pathname)) return;
    sessionSockets.push(url.pathname);
    socket.on('framesent', () => { sessionSocketFramesSent += 1; });
  });

  await page.route('**/api/search?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: VIDEO_ID,
      title: 'Speaker demand fixture',
      channelTitle: 'Rekasong test',
      durationText: '1:00',
      thumbnail: '',
      skipAiTitleExtraction: true,
    }]),
  }));

  if (!requestedUrl) {
    await page.routeWebSocket('**/v1/sessions/*/ws*', (socket) => {
      // Keep OBS-control bootstrap entirely inside the harness. No welcome is
      // needed for the file-demand contract, and no frame reaches production.
      socket.onMessage(() => {});
    });
    await page.route('**/v1/sessions', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          room: 'speaker-demand-room',
          controlToken: 'speaker-demand-control-token',
          playerToken: 'speaker-demand-player-token',
          workerOrigin: 'https://rekasong-session.11qaws.workers.dev',
        }),
      });
    });
    const readyPrepare = (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ready' }),
    });
    await page.route('**/v1/prepare?**', readyPrepare);
    await page.route('**/v1/prepare/**', readyPrepare);
    await page.route('**/v1/sessions/*/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'active' }),
    }));
    await page.route('**/v1/sessions/*/assets', (route) => {
      obsAssetUploadAttempts += 1;
      if (obsAssetUploadAttempts === 1) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fixture_upload_failure' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assetId: 'speaker-local-obs-asset' }),
      });
    });
  }

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#output-route-live-status.is-speaker').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_500);

  const resourceUrls = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name));
  const idleResources = await resourceUrls();
  assert.equal(
    idleResources.some((url) => LOCAL_SPEAKER_CHUNK.test(url)),
    false,
    'Idle Speaker must keep the local playback engine out of the initial load.',
  );
  assert.equal(
    idleResources.some((url) => REMOTE_MEDIA_CHUNK.test(url)),
    false,
    'Idle Speaker must keep the remote media graph out of the initial load.',
  );

  const idleEvidence = {
    sessionHttpRequests: sessionHttpRequests.length,
    sessionSockets: sessionSockets.length,
    sessionSocketFramesSent,
    storedSession: await page.evaluate(() => localStorage.getItem('rekasong-on-air-session-v1')),
  };
  assert.deepEqual(idleEvidence, {
    sessionHttpRequests: 0,
    sessionSockets: 0,
    sessionSocketFramesSent: 0,
    storedSession: null,
  }, 'An idle Speaker page must not create a media session or OBS control socket.');

  await page.locator('.output-settings-button').click();
  await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
  await setRangeValueAndBlur(
    page,
    page.locator('.output-volume-profile-row[data-output-mode="speaker"] input'),
    34,
  );
  await setRangeValueAndBlur(
    page,
    page.locator('.output-volume-profile-row[data-output-mode="obs"] input'),
    61,
  );
  await page.locator('#obs-setup-dialog > header .btn-icon').click();

  await page.locator('.song-composer input[type="file"][accept]').setInputFiles({
    name: 'speaker-local-first.wav',
    mimeType: 'audio/wav',
    buffer: createWavFixture({ durationSeconds: 4 }),
  });
  await page.locator('.staging-panel').waitFor({ state: 'visible' });
  const localPlayButton = page.locator('.staging-action-buttons .go-live-btn').first();
  assert.equal(await localPlayButton.isEnabled(), true, 'Speaker local playback must not wait for an OBS asset.');
  await localPlayButton.click();
  const localAudio = page.locator('[data-local-speaker-state="ready"] audio');
  await localAudio.waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
    return audio && audio.paused === false && audio.currentTime > 0.05;
  });
  const lifecycleBefore = await localAudio.evaluate((audio) => ({
    currentTime: audio.currentTime,
    source: audio.currentSrc || audio.src,
  }));
  const lifecycleEvent = await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    let pageHideEvent;
    if (typeof PageTransitionEvent === 'function') {
      pageHideEvent = new PageTransitionEvent('pagehide', { persisted: true });
    } else {
      pageHideEvent = new Event('pagehide');
      Object.defineProperty(pageHideEvent, 'persisted', { value: true });
    }
    window.dispatchEvent(pageHideEvent);
    return { persisted: pageHideEvent.persisted === true };
  });
  await page.waitForTimeout(300);
  const lifecycleAfter = await localAudio.evaluate((audio) => ({
    currentTime: audio.currentTime,
    paused: audio.paused,
    source: audio.currentSrc || audio.src,
  }));
  const speakerLifecycleEvidence = {
    eventPersisted: lifecycleEvent.persisted,
    mediaAdvanced: lifecycleAfter.currentTime > lifecycleBefore.currentTime,
    mediaPaused: lifecycleAfter.paused,
    sourcePreserved: lifecycleAfter.source === lifecycleBefore.source,
    sessionHttpRequests: sessionHttpRequests.length,
    sessionSockets: sessionSockets.length,
    sessionSocketFramesSent,
  };
  assert.deepEqual(speakerLifecycleEvidence, {
    eventPersisted: true,
    mediaAdvanced: true,
    mediaPaused: false,
    sourcePreserved: true,
    sessionHttpRequests: 0,
    sessionSockets: 0,
    sessionSocketFramesSent: 0,
  }, 'Visibility and persisted pagehide signals must not pause, detach, or reconnect Speaker playback.');

  const interruptionBefore = await localAudio.evaluate((audio) => ({
    currentTime: audio.currentTime,
    source: audio.currentSrc || audio.src,
  }));
  await localAudio.evaluate((audio) => audio.pause());
  await page.waitForFunction(() => (
    document.querySelector('[data-local-speaker-state="ready"] audio')?.paused === true
  ));
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  const resumeNotice = page.locator('.speaker-resume-notice');
  await resumeNotice.waitFor({ state: 'visible' });
  const resumeAction = page.locator('.speaker-resume-action');
  assert.equal(await resumeAction.isEnabled(), true);
  assert.equal(
    (await resumeNotice.locator('span').textContent())?.trim(),
    'Your device paused playback. The track and playback position are preserved.',
  );
  await page.setViewportSize({ width: 320, height: 900 });
  const mobileResumeLayout = await page.evaluate(() => {
    const action = document.querySelector('.speaker-resume-action');
    const notice = document.querySelector('.speaker-resume-notice');
    const actionRect = action?.getBoundingClientRect();
    const noticeRect = notice?.getBoundingClientRect();
    return {
      overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      actionHeight: actionRect?.height ?? 0,
      noticeWithinViewport: Boolean(
        noticeRect && noticeRect.left >= 0 && noticeRect.right <= window.innerWidth,
      ),
    };
  });
  assert.equal(mobileResumeLayout.overflowPx, 0);
  assert.ok(mobileResumeLayout.actionHeight >= 44);
  assert.equal(mobileResumeLayout.noticeWithinViewport, true);
  await page.setViewportSize({ width: 1100, height: 900 });
  const interruptionPaused = await localAudio.evaluate((audio) => ({
    currentTime: audio.currentTime,
    paused: audio.paused,
    source: audio.currentSrc || audio.src,
  }));
  await resumeAction.click();
  await page.waitForFunction((pausedAt) => {
    const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
    return audio && audio.paused === false && audio.currentTime > pausedAt + 0.05;
  }, interruptionPaused.currentTime);
  await resumeNotice.waitFor({ state: 'detached' });
  const interruptionAfter = await localAudio.evaluate((audio) => ({
    currentTime: audio.currentTime,
    paused: audio.paused,
    source: audio.currentSrc || audio.src,
  }));
  const speakerInterruptionRecoveryEvidence = {
    pausedAfterSystemSignal: interruptionPaused.paused,
    resumeActionVisible: true,
    mediaAdvancedAfterAction: interruptionAfter.currentTime > interruptionPaused.currentTime,
    mediaPausedAfterAction: interruptionAfter.paused,
    sourcePreserved: interruptionAfter.source === interruptionBefore.source,
    mobileOverflowPx: mobileResumeLayout.overflowPx,
    mobileActionHeight: mobileResumeLayout.actionHeight,
    sessionHttpRequests: sessionHttpRequests.length,
    sessionSockets: sessionSockets.length,
    sessionSocketFramesSent,
  };
  assert.deepEqual(speakerInterruptionRecoveryEvidence, {
    pausedAfterSystemSignal: true,
    resumeActionVisible: true,
    mediaAdvancedAfterAction: true,
    mediaPausedAfterAction: false,
    sourcePreserved: true,
    mobileOverflowPx: 0,
    mobileActionHeight: mobileResumeLayout.actionHeight,
    sessionHttpRequests: 0,
    sessionSockets: 0,
    sessionSocketFramesSent: 0,
  }, 'A system pause must converge to one visible local resume action without reconnecting.');
  const persistedAfterLocalPlay = await page.evaluate(({ sharedKey, tabKey }) => (
    `${localStorage.getItem(sharedKey) || ''}${sessionStorage.getItem(tabKey) || ''}`
  ), {
    sharedKey: SHARED_SYNC_STORAGE_KEY,
    tabKey: TAB_SYNC_STORAGE_KEY,
  });
  const localPlayResources = await resourceUrls();
  const localFileEvidence = {
    sessionHttpRequests: sessionHttpRequests.length,
    sessionSockets: sessionSockets.length,
    sessionSocketFramesSent,
    mediaPaused: await localAudio.evaluate((audio) => audio.paused),
    mediaTime: await localAudio.evaluate((audio) => audio.currentTime),
    mediaVolume: await localAudio.evaluate((audio) => audio.volume),
    outputVolumeProfiles: await page.evaluate(() => JSON.parse(
      localStorage.getItem('rekasong.output-volume-profiles.v1') || 'null',
    )),
    persistedBlobUrls: (persistedAfterLocalPlay.match(/blob:/g) || []).length,
    localPlaybackChunks: localPlayResources.filter((url) => LOCAL_SPEAKER_CHUNK.test(url)).length,
    remoteMediaChunks: localPlayResources.filter((url) => REMOTE_MEDIA_CHUNK.test(url)).length,
  };
  assert.equal(localFileEvidence.sessionHttpRequests, 0, 'Speaker local-file play must not create a session.');
  assert.equal(localFileEvidence.sessionSockets, 0, 'Speaker local-file play must not create a control socket.');
  assert.equal(localFileEvidence.sessionSocketFramesSent, 0);
  assert.equal(localFileEvidence.mediaPaused, false);
  assert.equal(localFileEvidence.mediaVolume, 0.34);
  assert.deepEqual(localFileEvidence.outputVolumeProfiles, {
    version: 1,
    speaker: 34,
    obs: 61,
  });
  assert.equal(localFileEvidence.persistedBlobUrls, 0, 'Page Blob URLs must stay out of durable storage.');
  assert.ok(
    localFileEvidence.localPlaybackChunks >= 2,
    'Local playback must load its controller and playback engine only when demanded.',
  );
  assert.equal(
    localFileEvidence.remoteMediaChunks,
    0,
    'A page-owned local file must not load the remote prepare/cache graph.',
  );

  await localAudio.evaluate((audio) => new Promise((resolve, reject) => {
    if (audio.ended) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      reject(new Error('Speaker fixture did not reach its natural end.'));
    }, 8_000);
    audio.addEventListener('ended', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  }));
  await page.locator('.playback-idle').waitFor({ state: 'visible' });
  await page.waitForTimeout(50);
  const naturalEndEvidence = {
    bodyText: await page.locator('body').innerText(),
    sessionHttpRequests: sessionHttpRequests.length,
    sessionSockets: sessionSockets.length,
    sessionSocketFramesSent,
  };
  assert.doesNotMatch(
    naturalEndEvidence.bodyText,
    /observer_reentry|local_speaker_[a-z_]+/,
    'A successful natural end must never expose an internal transport code.',
  );
  assert.equal(naturalEndEvidence.sessionHttpRequests, 0);
  assert.equal(naturalEndEvidence.sessionSockets, 0);
  assert.equal(naturalEndEvidence.sessionSocketFramesSent, 0);

  // Current playback is tab-owned and intentionally not durable. Reloading is
  // the bounded cleanup between the local-file and prepared-media scenarios.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#output-route-live-status.is-speaker').waitFor({ state: 'visible' });
  assert.equal(sessionHttpRequests.length, 0);
  assert.equal(sessionSockets.length, 0);

  await page.locator('.search-form input').fill('speaker demand fixture');
  await page.locator('.search-form button[type="submit"]').click();
  const source = page.locator(`[data-song-drag-source="${VIDEO_ID}"]`);
  await source.waitFor({ state: 'visible' });
  const thumbnailEvidence = await source.locator('.result-thumb').evaluate((image) => ({
    alt: image.alt,
    source: image.currentSrc || image.src,
  }));
  assert.equal(thumbnailEvidence.alt, 'Thumbnail for Speaker demand fixture');
  assert.match(
    thumbnailEvidence.source,
    /^data:image\/svg\+xml,/,
    'A missing YouTube thumbnail must use the local data image without a third-party request.',
  );
  await page.waitForTimeout(300);
  assert.equal(sessionHttpRequests.length, 0, 'Searching alone must not create a media session.');
  assert.equal(sessionSockets.length, 0, 'Searching alone must not create an OBS control socket.');

  let stagedEvidence = null;
  let persistedSessionReloadEvidence = null;
  let obsLocalFileEvidence = null;
  if (!requestedUrl) {
    await source.locator('.result-select-button').click();
    await page.locator('.staging-panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => localStorage.getItem('rekasong-on-air-session-v1') !== null);
    await page.locator('[data-local-speaker-state="ready"]').waitFor({ state: 'attached' });
    await page.waitForTimeout(500);
    stagedEvidence = {
      sessionHttpRequests: sessionHttpRequests.length,
      sessionSockets: sessionSockets.length,
      sessionSocketFramesSent,
    };
    assert.equal(
      sessionHttpRequests.filter((request) => request.method === 'POST' && request.path === '/v1/sessions').length,
      1,
      'The first prepared-media demand must create exactly one reusable session.',
    );
    assert.equal(sessionSockets.length, 0, 'Speaker media preparation must not wake OBS control sockets.');
    assert.equal(sessionSocketFramesSent, 0, 'Speaker media preparation must not send WebSocket frames.');

    sessionHttpRequests.length = 0;
    sessionSockets.length = 0;
    sessionSocketFramesSent = 0;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#output-route-live-status.is-speaker').waitFor({ state: 'visible' });
    await page.locator('[data-local-speaker-state="ready"]').waitFor({ state: 'attached' });
    await page.waitForTimeout(1_000);
    persistedSessionReloadEvidence = {
      sessionHttpRequests: sessionHttpRequests.length,
      sessionSockets: sessionSockets.length,
      sessionSocketFramesSent,
      storedSession: Boolean(
        await page.evaluate(() => localStorage.getItem('rekasong-on-air-session-v1')),
      ),
    };
    assert.deepEqual(persistedSessionReloadEvidence, {
      sessionHttpRequests: 0,
      sessionSockets: 0,
      sessionSocketFramesSent: 0,
      storedSession: true,
    }, 'A stored media session must not wake OBS control after a Speaker page reload.');

    await page.locator('.song-composer input[type="file"][accept]').setInputFiles({
      name: 'speaker-after-obs.wav',
      mimeType: 'audio/wav',
      buffer: createWavFixture(),
    });
    await page.locator('.staging-panel').waitFor({ state: 'visible' });
    const stagedPreviewSrc = await page.locator('.local-audio-preview').getAttribute('src');
    assert.match(stagedPreviewSrc || '', /^blob:/, 'OBS preparation must start beside the Speaker Blob.');

    await page.locator('.output-settings-button').click();
    await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
    const routeButtons = page.locator('.output-route-button');
    await routeButtons.nth(1).click();
    await page.locator('#obs-setup-dialog .btn-icon').first().click();
    const retryObsAsset = page.getByRole('button', { name: 'Retry OBS file' });
    await retryObsAsset.waitFor({ state: 'visible' });
    assert.equal(obsAssetUploadAttempts, 1, 'OBS selection must make one bounded initial upload attempt.');
    assert.equal(
      await page.locator('.staging-action-buttons .go-live-btn').first().isEnabled(),
      false,
      'Strict OBS playback must wait for a valid asset.',
    );

    await retryObsAsset.click();
    await page.locator('.staging-asset-status').waitFor({ state: 'detached' });
    assert.equal(obsAssetUploadAttempts, 2, 'A failed upload retries only after the explicit action.');
    assert.equal(
      await page.locator('.staging-action-buttons .go-live-btn').first().isEnabled(),
      true,
      'The OBS action must unlock after its asset becomes ready.',
    );
    assert.match(
      await page.locator('.local-audio-preview').getAttribute('src') || '',
      /^blob:/,
      'A successful OBS upload must not replace the Speaker Blob source.',
    );

    await page.locator('.output-settings-button').click();
    await page.locator('#obs-setup-dialog').waitFor({ state: 'visible' });
    await routeButtons.nth(0).click();
    await page.waitForFunction(() => (
      document.querySelector('.output-route-button[aria-checked="true"]')?.textContent || ''
    ).toLowerCase().includes('speaker'));
    await page.locator('#obs-setup-dialog .btn-icon').first().click();
    await page.locator('.staging-action-buttons .go-live-btn').first().click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
      return audio && audio.paused === false && audio.currentTime > 0.05;
    });
    obsLocalFileEvidence = {
      uploadAttempts: obsAssetUploadAttempts,
      speakerBlobPreserved: true,
      speakerPlaybackAfterObsPreparation: true,
      productionSocketFrames: 0,
    };
  }

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    targetUrl: appUrl,
    idleEvidence,
    localFileEvidence,
    speakerLifecycleEvidence,
    speakerInterruptionRecoveryEvidence,
    searchOnly: {
      sessionHttpRequests: 0,
      sessionSockets: 0,
      thumbnailEvidence,
    },
    stagedEvidence,
    persistedSessionReloadEvidence,
    obsLocalFileEvidence,
    workerHostRequests: workerHostRequests.length,
  }, null, 2));
} finally {
  await browser?.close();
  await stopChild(vite);
}
