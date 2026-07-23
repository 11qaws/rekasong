import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  LOCAL_BLOB_HISTORY_MAX_SOURCES,
} from '../src/lib/blobLifecycle.js';
import {
  SHARED_SYNC_STORAGE_KEY,
  TAB_SYNC_STORAGE_KEY,
} from '../src/lib/syncStorageKeys.js';

const COMPLETED_TRACK_COUNT = 30;
const MAX_POST_GC_HEAP_GROWTH_BYTES = 16 * 1024 * 1024;

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the local Blob budget smoke test.');

const createSilentWav = ({ seconds = 0.5, sampleRate = 8_000 } = {}) => {
  const sampleCount = Math.round(seconds * sampleRate);
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(sampleCount * 2, 40);
  return bytes;
};

const silentWav = createSilentWav();

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
      // The isolated preview server is still starting.
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
const previewLogs = [];
let preview;
if (!requestedUrl) {
  const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  preview = spawn(process.execPath, [
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
  preview.stdout.on('data', (chunk) => previewLogs.push(String(chunk)));
  preview.stderr.on('data', (chunk) => previewLogs.push(String(chunk)));
}

let browser;
try {
  await waitForServer(appUrl, preview, previewLogs);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.__rekasongBlobBudget = { created: [], revoked: [] };
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (...args) => {
      const src = createObjectURL(...args);
      window.__rekasongBlobBudget.created.push(src);
      return src;
    };
    URL.revokeObjectURL = (src) => {
      window.__rekasongBlobBudget.revoked.push(src);
      return revokeObjectURL(src);
    };
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  const pageErrors = [];
  const workerRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/workers\.dev|\/v1\/sessions(?:\/|\?|$)|ntfy/i.test(url)) workerRequests.push(url);
  });
  await page.route('**/api/extract-local', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: 'data: {"mode":"rules"}\n\n',
  }));
  await page.route('**/api/title-cache', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));

  const readHeap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value || 0;
  };

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.composer-file-import').waitFor({ state: 'visible', timeout: 20_000 });
  assert.match(await page.locator('.output-route-live-status').innerText(), /스피커|speaker/i);
  await cdp.send('HeapProfiler.collectGarbage');
  const baselineHeap = await readHeap();

  const fileInput = page.locator('.composer-area input[type="file"]');
  const iterationMs = [];
  for (let index = 0; index < COMPLETED_TRACK_COUNT; index += 1) {
    const startedAt = performance.now();
    await fileInput.setInputFiles({
      name: `long-session-track-${String(index + 1).padStart(2, '0')}.wav`,
      mimeType: 'audio/wav',
      buffer: silentWav,
    });
    const playNow = page.locator('.staging-panel .go-live-btn').first();
    await playNow.waitFor({ state: 'visible' });
    assert.equal(await playNow.isEnabled(), true);
    await playNow.click();
    const audio = page.locator('.live-players-hidden audio');
    await audio.waitFor({ state: 'attached' });
    await audio.evaluate((element) => {
      element.dispatchEvent(new Event('playing'));
      element.dispatchEvent(new Event('ended'));
    });
    await page.waitForFunction((count) => (
      document.querySelector('.history-accordion summary')?.textContent?.includes(`(${count})`)
    ), index + 1);
    await audio.waitFor({ state: 'detached' });
    iterationMs.push(performance.now() - startedAt);
  }

  await page.waitForFunction(({ created, retained }) => {
    const lifecycle = window.__rekasongBlobBudget;
    const revoked = new Set(lifecycle.revoked);
    return lifecycle.created.length === created
      && lifecycle.created.filter((src) => !revoked.has(src)).length === retained;
  }, {
    created: COMPLETED_TRACK_COUNT,
    retained: LOCAL_BLOB_HISTORY_MAX_SOURCES,
  });

  await page.locator('.history-accordion summary').click();
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.history-item').length === expected
  ), COMPLETED_TRACK_COUNT);
  const expiredRows = await page.locator('.history-item.is-source-expired').count();
  assert.equal(
    expiredRows,
    COMPLETED_TRACK_COUNT - LOCAL_BLOB_HISTORY_MAX_SOURCES,
    'Only the newest bounded local history sources may remain immediately replayable.',
  );
  assert.equal(
    await page.locator('.history-item:not(.is-source-expired)').count(),
    LOCAL_BLOB_HISTORY_MAX_SOURCES,
  );

  const beforeUnmount = await page.evaluate(() => {
    const created = [...new Set(window.__rekasongBlobBudget.created)];
    const revoked = new Set(window.__rekasongBlobBudget.revoked);
    return {
      created: created.length,
      revoked: created.filter((src) => revoked.has(src)).length,
      retained: created.filter((src) => !revoked.has(src)).length,
    };
  });
  assert.deepEqual(beforeUnmount, {
    created: COMPLETED_TRACK_COUNT,
    revoked: COMPLETED_TRACK_COUNT - LOCAL_BLOB_HISTORY_MAX_SOURCES,
    retained: LOCAL_BLOB_HISTORY_MAX_SOURCES,
  });

  const persisted = await page.evaluate(({ sharedKey, tabKey }) => ({
    shared: localStorage.getItem(sharedKey) || '',
    tab: sessionStorage.getItem(tabKey) || '',
  }), {
    sharedKey: SHARED_SYNC_STORAGE_KEY,
    tabKey: TAB_SYNC_STORAGE_KEY,
  });
  assert.equal(`${persisted.shared}${persisted.tab}`.includes('blob:'), false);
  assert.deepEqual(workerRequests, [], 'Speaker local-file playback must generate zero Worker/OBS traffic.');
  assert.deepEqual(pageErrors, []);

  await cdp.send('HeapProfiler.collectGarbage');
  const finalHeap = await readHeap();
  const heapGrowthBytes = Math.max(0, finalHeap - baselineHeap);
  assert.ok(
    heapGrowthBytes <= MAX_POST_GC_HEAP_GROWTH_BYTES,
    `Post-GC heap grew by ${heapGrowthBytes} bytes.`,
  );

  await page.evaluate(() => { window.location.hash = '#/widget'; });
  await page.locator('.dashboard-container').waitFor({ state: 'detached' });
  const afterUnmount = await page.evaluate(() => {
    const created = [...new Set(window.__rekasongBlobBudget.created)];
    const revoked = new Set(window.__rekasongBlobBudget.revoked);
    return {
      created: created.length,
      revoked: created.filter((src) => revoked.has(src)).length,
      retained: created.filter((src) => !revoked.has(src)).length,
    };
  });
  assert.deepEqual(afterUnmount, {
    created: COMPLETED_TRACK_COUNT,
    revoked: COMPLETED_TRACK_COUNT,
    retained: 0,
  });

  const orderedIterations = [...iterationMs].sort((left, right) => left - right);
  const p95IterationMs = orderedIterations[Math.ceil(orderedIterations.length * 0.95) - 1];
  process.stdout.write(`${JSON.stringify({
    appUrl,
    checks: {
      completedTracks: COMPLETED_TRACK_COUNT,
      retainedReplayableSources: beforeUnmount.retained,
      reclaimedSourcesBeforeUnmount: beforeUnmount.revoked,
      reclaimedSourcesAfterUnmount: afterUnmount.revoked,
      persistedBlobUrls: 0,
      workerRequests: workerRequests.length,
      postGcHeapGrowthBytes: heapGrowthBytes,
      p95IterationMs: Math.round(p95IterationMs * 10) / 10,
    },
  }, null, 2)}\n`);
  await context.close();
} finally {
  await browser?.close();
  await stopChild(preview);
}
