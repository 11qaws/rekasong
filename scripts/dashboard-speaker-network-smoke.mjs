import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const VIDEO_ID = 'cv7zqJhKoVE';
const SESSION_PATH = /^\/v1\/sessions(?:\/|$)/;
const SESSION_SOCKET_PATH = /^\/v1\/sessions\/[^/]+\/ws$/;

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
  await context.addInitScript(() => {
    if (sessionStorage.getItem('rekasong-speaker-demand-smoke-initialized') !== '1') {
      localStorage.removeItem('rekasong-on-air-session-v1');
      localStorage.removeItem('karaoke_app_state');
      sessionStorage.setItem('rekasong-speaker-demand-smoke-initialized', '1');
    }
    localStorage.setItem('rekasong.locale', 'en');
  });
  const page = await context.newPage();
  const pageErrors = [];
  const workerHostRequests = [];
  const sessionHttpRequests = [];
  const sessionSockets = [];
  let sessionSocketFramesSent = 0;

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
      thumbnail: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="68"/%3E',
      skipAiTitleExtraction: true,
    }]),
  }));

  if (!requestedUrl) {
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
  }

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#output-route-live-status.is-speaker').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_500);

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

  await page.locator('.search-form input').fill('speaker demand fixture');
  await page.locator('.search-form button[type="submit"]').click();
  const source = page.locator(`[data-song-drag-source="${VIDEO_ID}"]`);
  await source.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  assert.equal(sessionHttpRequests.length, 0, 'Searching alone must not create a media session.');
  assert.equal(sessionSockets.length, 0, 'Searching alone must not create an OBS control socket.');

  let stagedEvidence = null;
  let persistedSessionReloadEvidence = null;
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
  }

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    targetUrl: appUrl,
    idleEvidence,
    searchOnly: {
      sessionHttpRequests: 0,
      sessionSockets: 0,
    },
    stagedEvidence,
    persistedSessionReloadEvidence,
    workerHostRequests: workerHostRequests.length,
  }, null, 2));
} finally {
  await browser?.close();
  await stopChild(vite);
}
