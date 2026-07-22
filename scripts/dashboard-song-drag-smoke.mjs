import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const VIDEO_ID = 'cv7zqJhKoVE';
const FIXTURE_TITLE = 'Drag placement fixture';

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the song-drag smoke test.');

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

const beginDrag = async (page, source) => {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await page.locator('[data-song-drop-tray="visible"]').waitFor({ state: 'visible' });
  return dataTransfer;
};

const dropOn = async (source, target, dataTransfer) => {
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
  await dataTransfer.dispose();
};

const requestedUrl = process.argv[2]?.trim();
let appUrl = requestedUrl;
let vite = null;
const viteLogs = [];

if (!appUrl) {
  const port = await reservePort();
  appUrl = `http://127.0.0.1:${port}/`;
  const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  vite = spawn(process.execPath, [
    vitePath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
    '--mode', 'development',
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      BROWSER: 'none',
      VITE_ON_AIR_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  vite.stdout.on('data', (chunk) => viteLogs.push(String(chunk)));
  vite.stderr.on('data', (chunk) => viteLogs.push(String(chunk)));
}

let browser;
try {
  if (vite) await waitForServer(appUrl, vite, viteLogs);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('rekasong.locale', 'en');
      localStorage.removeItem('karaoke_app_state');
    } catch {
      // about:blank has no storage origin; this runs again for the app document.
    }
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const workerHostRequests = [];
  const sessionWorkerRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const requestUrl = request.url();
    if (/workers\.dev/i.test(requestUrl)) workerHostRequests.push(requestUrl);
    if (/\/v1\/sessions(?:\/|\?|$)/i.test(requestUrl)) sessionWorkerRequests.push(requestUrl);
  });
  await page.route('**/api/search?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: VIDEO_ID,
      title: FIXTURE_TITLE,
      channelTitle: 'Rekasong test',
      durationText: '1:00',
      thumbnail: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="68"/%3E',
      skipAiTitleExtraction: true,
    }]),
  }));
  await page.route('https://www.youtube.com/embed/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Preview fixture</title>',
  }));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.search-form input').fill('drag fixture');
  await page.locator('.search-form button[type="submit"]').click();
  const source = page.locator(`[data-song-drag-source="${VIDEO_ID}"]`);
  await source.waitFor({ state: 'visible' });
  assert.equal(await source.count(), 1);
  const sessionRequestsAfterSearch = sessionWorkerRequests.length;

  // Click remains the complete touch/keyboard alternative to dragging.
  await source.locator('.result-select-button').click();
  await page.locator('.staging-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.staging-form input').inputValue(), FIXTURE_TITLE);
  await page.locator('.staging-panel-header button').click();
  await page.locator('.search-form input').fill('drag fixture');
  await page.locator('.search-form button[type="submit"]').click();
  await source.waitFor({ state: 'visible' });
  await page.waitForTimeout(250);

  const stateBeforeCancel = await page.evaluate(() => localStorage.getItem('karaoke_app_state'));
  const cancelTransfer = await beginDrag(page, source);
  assert.deepEqual(
    await page.locator('[data-song-drop-destination]').allTextContents(),
    [
      'Play nowStart immediately when preparation is complete',
      'End of queueAdd it last to play later',
      'Previous tracksAdd to completed tracks without playing',
    ],
  );
  await source.dispatchEvent('dragend', { dataTransfer: cancelTransfer });
  await cancelTransfer.dispose();
  await page.locator('[data-song-drop-tray="visible"]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('karaoke_app_state')), stateBeforeCancel,
    'Cancelling a drag must not mutate durable state.');
  const sessionRequestsBeforeHistoryDrop = sessionWorkerRequests.length;

  await page.setViewportSize({ width: 320, height: 900 });
  const historyTransfer = await beginDrag(page, source);
  const mobileLayout = await page.locator('[data-song-drop-tray="visible"]').evaluate((tray) => {
    const trayRect = tray.getBoundingClientRect();
    const targets = [...tray.querySelectorAll('[data-song-drop-destination]')].map((target) => {
      const rect = target.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      tray: { left: trayRect.left, right: trayRect.right, width: trayRect.width },
      targets,
    };
  });
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1, '320px drag tray caused horizontal overflow.');
  assert.ok(mobileLayout.tray.left >= -1 && mobileLayout.tray.right <= mobileLayout.viewportWidth + 1,
    '320px drag tray leaves the viewport.');
  assert.equal(mobileLayout.targets.length, 3);
  assert.equal(mobileLayout.targets.every((target) => target.left >= -1 && target.right <= mobileLayout.viewportWidth + 1), true,
    'A 320px drag destination leaves the viewport.');
  if (process.env.REKASONG_DRAG_SCREENSHOT) {
    await mkdir(dirname(process.env.REKASONG_DRAG_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.REKASONG_DRAG_SCREENSHOT });
  }

  const historyTarget = page.locator('[data-song-drop-destination="history"]');
  await dropOn(source, historyTarget, historyTransfer);
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('karaoke_app_state') || '{}');
    return stored.history?.length === 1;
  });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('karaoke_app_state') || '{}'));
  assert.equal(stored.queue?.length || 0, 0);
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].song.title, FIXTURE_TITLE);
  assert.equal(stored.history[0].song.src, VIDEO_ID);
  assert.equal(stored.currentEntry, null);
  assert.equal(await page.locator('[data-song-drop-tray="visible"]').count(), 0);
  await page.waitForTimeout(100);
  assert.equal(
    sessionWorkerRequests.length,
    sessionRequestsBeforeHistoryDrop,
    'Dropping a search result into history unexpectedly created session Worker traffic.',
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  console.log(JSON.stringify({
    targetUrl: appUrl,
    clickPath: 'search result -> review',
    cancelPath: 'zero durable mutation',
    historyDrop: 'one completed entry, zero playback',
    mobileLayout,
    workerHostRequests: workerHostRequests.length,
    sessionWorkerRequests: {
      afterSearch: sessionRequestsAfterSearch,
      beforeHistoryDrop: sessionRequestsBeforeHistoryDrop,
      afterHistoryDrop: sessionWorkerRequests.length,
    },
  }, null, 2));
} finally {
  await browser?.close();
  await stopChild(vite);
}
