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

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the song-drag playback smoke test.');

const createDeferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

const createWavFixture = ({ durationSeconds = 5, sampleRate = 48_000 } = {}) => {
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

const beginDrag = async (page, source) => {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await page.locator('[data-song-drop-tray="visible"]').waitFor({ state: 'visible' });
  return dataTransfer;
};

const finishCancelledDrag = async (page, source, dataTransfer) => {
  await source.dispatchEvent('dragend', { dataTransfer });
  await dataTransfer.dispose();
  await page.locator('[data-song-drop-tray="visible"]').waitFor({ state: 'detached' });
};

const dropOn = async (source, target, dataTransfer) => {
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
  await dataTransfer.dispose();
};

const timeoutAfter = (milliseconds, message) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(message)), milliseconds);
});

const previewPort = await reservePort();
const appUrl = `http://127.0.0.1:${previewPort}/`;
const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const previewLogs = [];
const preview = spawn(process.execPath, [
  vitePath,
  'preview',
  '--host', '127.0.0.1',
  '--port', String(previewPort),
  '--strictPort',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
preview.stdout.on('data', (chunk) => previewLogs.push(String(chunk)));
preview.stderr.on('data', (chunk) => previewLogs.push(String(chunk)));

let browser;
try {
  await waitForServer(appUrl, preview, previewLogs);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const openScenario = async ({
    fixtures,
    prepareGate = null,
    viewport = { width: 1100, height: 900 },
  }) => {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ legacyKey, sharedKey, tabKey }) => {
      localStorage.setItem('rekasong.locale', 'en');
      localStorage.removeItem('rekasong-on-air-session-v1');
      localStorage.removeItem(legacyKey);
      localStorage.removeItem(sharedKey);
      sessionStorage.removeItem(tabKey);
    }, {
      legacyKey: LEGACY_SYNC_STORAGE_KEY,
      sharedKey: SHARED_SYNC_STORAGE_KEY,
      tabKey: TAB_SYNC_STORAGE_KEY,
    });

    const page = await context.newPage();
    const metrics = {
      pageErrors: [],
      consoleErrors: [],
      httpErrors: [],
      sessionPosts: 0,
      preparePosts: 0,
      prepareGets: 0,
      audioRequests: 0,
      sessionSockets: 0,
      sessionSocketFrames: 0,
    };
    const prepareStarted = createDeferred();
    const wav = createWavFixture();

    page.on('pageerror', (error) => metrics.pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') metrics.consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        metrics.httpErrors.push({ status: response.status(), url: response.url() });
      }
    });
    page.on('websocket', (socket) => {
      if (!/\/v1\/sessions\/[^/]+\/ws(?:\?|$)/.test(socket.url())) return;
      metrics.sessionSockets += 1;
      socket.on('framesent', () => { metrics.sessionSocketFrames += 1; });
    });

    await page.routeWebSocket('**/v1/sessions/*/ws*', (socket) => {
      metrics.sessionSockets += 1;
      socket.onMessage(() => { metrics.sessionSocketFrames += 1; });
    });
    await page.route('**/api/search?**', (route) => {
      const query = new URL(route.request().url()).searchParams.get('q') || '';
      const fixture = fixtures[query] || Object.values(fixtures)[0];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: fixture.id,
          title: fixture.title,
          channelTitle: 'Rekasong test',
          durationText: '0:05',
          thumbnail: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="68"/%3E',
          skipAiTitleExtraction: true,
        }]),
      });
    });
    await page.route('**/api/title-cache', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    }));
    await page.route('https://www.youtube.com/embed/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Preview fixture</title>',
    }));
    await page.route('**/v1/sessions', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      metrics.sessionPosts += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          room: `drag-room-${metrics.sessionPosts}`,
          controlToken: 'drag-control-token',
          playerToken: 'drag-player-token',
          workerOrigin: 'https://rekasong-session.11qaws.workers.dev',
        }),
      });
    });
    await page.route('**/v1/sessions/*/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'active' }),
    }));
    await page.route('**/v1/prepare?**', async (route) => {
      metrics.preparePosts += 1;
      prepareStarted.resolve();
      if (prepareGate) await prepareGate.promise;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ready' }),
      });
    });
    await page.route('**/v1/prepare/**', (route) => {
      metrics.prepareGets += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: prepareGate ? 'queued' : 'ready' }),
      });
    });
    await page.route('**/v1/audio/**', (route) => {
      metrics.audioRequests += 1;
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': String(wav.length),
          'Cache-Control': 'no-store',
        },
        body: wav,
      });
    });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#output-route-live-status.is-speaker').waitFor({ state: 'visible' });

    const search = async (query) => {
      await page.locator('.search-form input').fill(query);
      await page.locator('.search-form button[type="submit"]').click();
      const fixture = fixtures[query];
      const source = page.locator(`[data-song-drag-source="${fixture.id}"]`);
      await source.waitFor({ state: 'visible' });
      return source;
    };

    const assertClean = () => {
      assert.deepEqual(metrics.pageErrors, []);
      assert.deepEqual(metrics.consoleErrors, []);
      assert.deepEqual(metrics.httpErrors, []);
      assert.equal(metrics.sessionSockets, 0, 'Speaker drag scenarios must not open an OBS control socket.');
      assert.equal(metrics.sessionSocketFrames, 0, 'Speaker drag scenarios must not send OBS control frames.');
    };

    return {
      context,
      page,
      metrics,
      prepareStarted: prepareStarted.promise,
      search,
      assertClean,
    };
  };

  const basics = await openScenario({
    fixtures: {
      'click fixture': { id: 'AaBbCcDdEe1', title: 'Click review fixture' },
      'drag fixture': { id: 'BbCcDdEeFf2', title: 'Drag history fixture' },
    },
  });
  try {
    const clickSource = await basics.search('click fixture');
    await clickSource.locator('.result-select-button').click();
    await basics.page.locator('.staging-panel').waitFor({ state: 'visible' });
    assert.equal(
      await basics.page.locator('.staging-form input').inputValue(),
      'Click review fixture',
    );
    await basics.page.locator('.staging-panel-header button').click();

    const dragSource = await basics.search('drag fixture');
    const durableBeforeCancel = await basics.page.evaluate(({ sharedKey, tabKey }) => ({
      shared: localStorage.getItem(sharedKey),
      tab: sessionStorage.getItem(tabKey),
    }), {
      sharedKey: SHARED_SYNC_STORAGE_KEY,
      tabKey: TAB_SYNC_STORAGE_KEY,
    });
    await basics.page.setViewportSize({ width: 320, height: 900 });
    const cancelTransfer = await beginDrag(basics.page, dragSource);
    assert.deepEqual(
      await basics.page.locator('[data-song-drop-destination]').allTextContents(),
      [
        'Play when readyStart automatically on this tab’s speaker after preparation',
        'End of queueAdd it last to play later',
        'Previous tracksAdd to completed tracks without playing',
      ],
    );
    const mobileLayout = await basics.page.locator('[data-song-drop-tray="visible"]').evaluate((tray) => {
      const trayRect = tray.getBoundingClientRect();
      const targets = [...tray.querySelectorAll('[data-song-drop-destination]')].map((target) => {
        const rect = target.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        trayLeft: trayRect.left,
        trayRight: trayRect.right,
        targets,
      };
    });
    assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1);
    assert.ok(mobileLayout.trayLeft >= -1 && mobileLayout.trayRight <= mobileLayout.viewportWidth + 1);
    assert.equal(
      mobileLayout.targets.every((target) => (
        target.left >= -1 && target.right <= mobileLayout.viewportWidth + 1
      )),
      true,
    );
    await finishCancelledDrag(basics.page, dragSource, cancelTransfer);
    assert.deepEqual(
      await basics.page.evaluate(({ sharedKey, tabKey }) => ({
        shared: localStorage.getItem(sharedKey),
        tab: sessionStorage.getItem(tabKey),
      }), {
        sharedKey: SHARED_SYNC_STORAGE_KEY,
        tabKey: TAB_SYNC_STORAGE_KEY,
      }),
      durableBeforeCancel,
      'Cancelling a drag must not mutate shared or tab state.',
    );

    const sessionPostsBeforeHistory = basics.metrics.sessionPosts;
    const historyTransfer = await beginDrag(basics.page, dragSource);
    await dropOn(
      dragSource,
      basics.page.locator('[data-song-drop-destination="history"]'),
      historyTransfer,
    );
    await basics.page.waitForFunction((sharedKey) => {
      const shared = JSON.parse(localStorage.getItem(sharedKey) || '{}');
      return shared.history?.length === 1;
    }, SHARED_SYNC_STORAGE_KEY);
    assert.equal(await basics.page.locator('.playback-now').count(), 0);
    assert.equal(await basics.page.locator('.queue-row').count(), 0);
    assert.equal(basics.metrics.sessionPosts, sessionPostsBeforeHistory);
    basics.assertClean();
    basics.mobileLayout = mobileLayout;
  } finally {
    await basics.context.close();
  }

  const queueOnly = await openScenario({
    fixtures: {
      'queue fixture': { id: 'CcDdEeFfGg3', title: 'Queue-only fixture' },
    },
  });
  try {
    const source = await queueOnly.search('queue fixture');
    const transfer = await beginDrag(queueOnly.page, source);
    await dropOn(
      source,
      queueOnly.page.locator('[data-song-drop-destination="queue"]'),
      transfer,
    );
    await queueOnly.page.waitForFunction(({ tabKey, title }) => {
      const tab = JSON.parse(sessionStorage.getItem(tabKey) || '{}');
      return tab.queue?.length === 1 && tab.queue[0]?.song?.title === title;
    }, { tabKey: TAB_SYNC_STORAGE_KEY, title: 'Queue-only fixture' });
    await Promise.race([
      queueOnly.prepareStarted,
      timeoutAfter(5_000, 'Queue-only preparation did not start.'),
    ]);
    await queueOnly.page.waitForTimeout(250);
    assert.equal(await queueOnly.page.locator('.playback-now').count(), 0);
    assert.equal(await queueOnly.page.locator('.queue-row strong').textContent(), 'Queue-only fixture');
    assert.equal(queueOnly.metrics.sessionPosts, 1);
    assert.equal(queueOnly.metrics.audioRequests, 0, 'Queue-only placement must not start playback.');
    queueOnly.assertClean();
  } finally {
    await queueOnly.context.close();
  }

  const prepareGate = createDeferred();
  const delayedPlay = await openScenario({
    fixtures: {
      'delayed play fixture': { id: 'DdEeFfGgHh4', title: 'Delayed play fixture' },
    },
    prepareGate,
  });
  try {
    const source = await delayedPlay.search('delayed play fixture');
    const transfer = await beginDrag(delayedPlay.page, source);
    await dropOn(
      source,
      delayedPlay.page.locator('[data-song-drop-destination="play"]'),
      transfer,
    );
    await Promise.race([
      delayedPlay.prepareStarted,
      timeoutAfter(5_000, 'Deferred play preparation did not start.'),
    ]);
    await delayedPlay.page.waitForFunction(({ tabKey, title }) => {
      const tab = JSON.parse(sessionStorage.getItem(tabKey) || '{}');
      return tab.queue?.length === 1 && tab.queue[0]?.song?.title === title;
    }, { tabKey: TAB_SYNC_STORAGE_KEY, title: 'Delayed play fixture' });
    assert.equal(await delayedPlay.page.locator('.playback-now').count(), 0);
    assert.equal(delayedPlay.metrics.audioRequests, 0);

    prepareGate.resolve();
    await delayedPlay.page.locator('.playback-now strong').waitFor({ state: 'visible' });
    assert.equal(
      await delayedPlay.page.locator('.playback-now strong').textContent(),
      'Delayed play fixture',
    );
    await delayedPlay.page.waitForFunction(() => {
      const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
      return audio && audio.paused === false && audio.currentTime > 0.05;
    });
    await delayedPlay.page.waitForFunction((tabKey) => {
      const tab = JSON.parse(sessionStorage.getItem(tabKey) || '{}');
      return Array.isArray(tab.queue) && tab.queue.length === 0;
    }, TAB_SYNC_STORAGE_KEY);
    assert.equal(delayedPlay.metrics.sessionPosts, 1);
    assert.equal(delayedPlay.metrics.preparePosts, 1);
    assert.equal(delayedPlay.metrics.audioRequests, 1);
    delayedPlay.assertClean();
  } finally {
    prepareGate.resolve();
    await delayedPlay.context.close();
  }

  const preserveCurrent = await openScenario({
    fixtures: {
      'next fixture': { id: 'EeFfGgHhIi5', title: 'Preserved next fixture' },
    },
  });
  try {
    await preserveCurrent.page.locator('.song-composer input[type="file"][accept]').setInputFiles({
      name: 'Current speaker fixture.wav',
      mimeType: 'audio/wav',
      buffer: createWavFixture({ durationSeconds: 6 }),
    });
    await preserveCurrent.page.locator('.staging-panel').waitFor({ state: 'visible' });
    await preserveCurrent.page.locator('.staging-action-buttons .go-live-btn').first().click();
    await preserveCurrent.page.waitForFunction(() => {
      const audio = document.querySelector('[data-local-speaker-state="ready"] audio');
      return audio && audio.paused === false && audio.currentTime > 0.1;
    });
    const localAudio = preserveCurrent.page.locator('[data-local-speaker-state="ready"] audio');
    const before = await localAudio.evaluate((audio) => ({
      currentTime: audio.currentTime,
      source: audio.currentSrc || audio.src,
    }));

    const source = await preserveCurrent.search('next fixture');
    const transfer = await beginDrag(preserveCurrent.page, source);
    assert.equal(
      await preserveCurrent.page.locator('[data-song-drop-destination="play"]').textContent(),
      'Play nextKeep the current track and place this first',
    );
    await dropOn(
      source,
      preserveCurrent.page.locator('[data-song-drop-destination="play"]'),
      transfer,
    );
    await preserveCurrent.page.waitForFunction(({ tabKey, title }) => {
      const tab = JSON.parse(sessionStorage.getItem(tabKey) || '{}');
      return tab.queue?.[0]?.song?.title === title;
    }, { tabKey: TAB_SYNC_STORAGE_KEY, title: 'Preserved next fixture' });
    await preserveCurrent.page.waitForTimeout(350);
    const after = await localAudio.evaluate((audio) => ({
      currentTime: audio.currentTime,
      paused: audio.paused,
      source: audio.currentSrc || audio.src,
    }));
    assert.equal(
      await preserveCurrent.page.locator('.playback-now strong').textContent(),
      'Current speaker fixture.wav',
    );
    assert.equal(after.source, before.source);
    assert.equal(after.paused, false);
    assert.ok(after.currentTime > before.currentTime, 'Current Speaker playback stopped during Play next drop.');
    assert.equal(
      await preserveCurrent.page.locator('.queue-row strong').first().textContent(),
      'Preserved next fixture',
    );
    preserveCurrent.assertClean();
  } finally {
    await preserveCurrent.context.close();
  }

  console.log(JSON.stringify({
    targetUrl: appUrl,
    basics: {
      click: 'review',
      cancel: 'zero durable mutation',
      history: 'one completed entry, zero playback',
      mobileLayout: basics.mobileLayout,
    },
    queueOnly: {
      current: null,
      queue: 'one exact entry',
      audioRequests: queueOnly.metrics.audioRequests,
    },
    delayedPlay: {
      beforeReady: 'queued and silent',
      afterReady: 'exact entry playing',
      audioRequests: delayedPlay.metrics.audioRequests,
    },
    preserveCurrent: {
      current: 'source and advancing time preserved',
      next: 'queue front',
    },
    obsControlSockets: 0,
    obsControlFrames: 0,
  }, null, 2));
} finally {
  await browser?.close();
  await stopChild(preview);
}
