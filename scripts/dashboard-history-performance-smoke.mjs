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

const HISTORY_COUNT = 1_000;
const HISTORY_BATCH_SIZE = 100;
const STORAGE_BUDGET_BYTES = 1024 * 1024;
const COLD_OPEN_BUDGET_MS = 300;
const INTERACTION_P95_BUDGET_MS = 100;
const POST_GC_HEAP_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

const executableCandidates = [
  process.env.REKASONG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Chrome or Edge is required for the Dashboard history performance smoke test.');

const fixtureState = {
  queue: [],
  history: Array.from({ length: HISTORY_COUNT }, (_, index) => ({
    entryId: `history-performance-${index}`,
    song: {
      type: 'local',
      src: '',
      title: `Performance history track ${String(index + 1).padStart(4, '0')}`,
      artist: 'Rekasong fixture',
      tags: [],
      source: 'manual',
      songbookId: null,
      mediaType: 'audio',
      manual: true,
    },
    phase: 'completed',
    completionReason: null,
    createdAt: 1_700_000_000_000 + index,
  })),
  currentEntry: null,
  active: null,
  volume: 100,
  isMuted: false,
  melomingChannelId: '',
  setlinkCatalog: [],
  setlinkSourceUrl: '',
  setlinkCatalogMeta: null,
  youtubePlaylistCatalog: [],
  youtubePlaylistSourceUrl: '',
  youtubePlaylistCatalogMeta: null,
  songbookMrCache: {},
  activeIntegrationTab: 'youtube',
  autoPlayNext: false,
};
const fixtureJson = JSON.stringify(fixtureState);
const fixtureBytes = Buffer.byteLength(fixtureJson, 'utf8');

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
      // The isolated Vite process is still starting.
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

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
};

const requestedUrl = process.argv[2] ? new URL(process.argv[2]).href : null;
const port = requestedUrl ? null : await reservePort();
const appUrl = requestedUrl || `http://127.0.0.1:${port}/`;
const viteLogs = [];
let vite;
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
  await context.addInitScript(({ serializedState, legacyKey, sharedKey, tabKey }) => {
    try {
      localStorage.removeItem(legacyKey);
      localStorage.setItem(sharedKey, serializedState);
      sessionStorage.removeItem(tabKey);
    } catch {
      // about:blank has no storage origin; the script runs again for the app document.
    }
  }, {
    serializedState: fixtureJson,
    legacyKey: LEGACY_SYNC_STORAGE_KEY,
    sharedKey: SHARED_SYNC_STORAGE_KEY,
    tabKey: TAB_SYNC_STORAGE_KEY,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.history-accordion').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction((count) => (
    document.querySelector('.history-accordion summary')?.textContent?.includes(String(count))
  ), HISTORY_COUNT);

  const readMetrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    return {
      jsHeapUsedBytes: values.JSHeapUsedSize,
      nodes: values.Nodes,
      documents: values.Documents,
    };
  };

  const baseline = await readMetrics();
  assert.equal(await page.locator('.history-item').count(), 0, 'Closed history must mount zero rows.');
  assert.equal(await page.evaluate(() => document.querySelectorAll('*').length) < 500, true);
  assert.equal(
    await page.evaluate((sharedKey) => localStorage.getItem(sharedKey)?.length > 0, SHARED_SYNC_STORAGE_KEY),
    true,
  );

  const interactionDurations = [];
  const openDuration = await page.evaluate(async (expectedRows) => {
    const details = document.querySelector('.history-accordion');
    const start = performance.now();
    details.querySelector('summary').click();
    while (document.querySelectorAll('.history-item').length !== expectedRows) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  }, HISTORY_BATCH_SIZE);
  const coldOpenDuration = openDuration;

  const pageSnapshots = [];
  const readHistoryPage = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.history-item')];
    return {
      rowCount: rows.length,
      first: rows[0]?.querySelector('.history-title')?.textContent?.trim() || '',
      last: rows.at(-1)?.querySelector('.history-title')?.textContent?.trim() || '',
      domNodes: document.querySelectorAll('*').length,
    };
  });
  pageSnapshots.push(await readHistoryPage());

  for (let pageIndex = 1; pageIndex < HISTORY_COUNT / HISTORY_BATCH_SIZE; pageIndex += 1) {
    const previousFirst = pageSnapshots.at(-1).first;
    const duration = await page.evaluate(async ({ expectedRows, previousFirst: oldFirst }) => {
      const button = document.querySelector('.history-window-actions:not(.is-bottom) button');
      if (!button) throw new Error('Older-history button is missing.');
      const start = performance.now();
      button.click();
      while (true) {
        const rows = [...document.querySelectorAll('.history-item')];
        const first = rows[0]?.querySelector('.history-title')?.textContent?.trim() || '';
        if (rows.length === expectedRows && first && first !== oldFirst) break;
        await new Promise(requestAnimationFrame);
      }
      return performance.now() - start;
    }, { expectedRows: HISTORY_BATCH_SIZE, previousFirst });
    interactionDurations.push(duration);
    const snapshot = await readHistoryPage();
    assert.equal(snapshot.rowCount, HISTORY_BATCH_SIZE, 'History paging exceeded one DOM batch.');
    pageSnapshots.push(snapshot);
  }

  assert.match(pageSnapshots[0].first, /0901/);
  assert.match(pageSnapshots[0].last, /1000/);
  assert.match(pageSnapshots.at(-1).first, /0001/);
  assert.match(pageSnapshots.at(-1).last, /0100/);
  assert.equal(Math.max(...pageSnapshots.map(({ rowCount }) => rowCount)), HISTORY_BATCH_SIZE);

  const newerDuration = await page.evaluate(async (expectedRows) => {
    const button = document.querySelector('.history-window-actions.is-bottom button');
    if (!button) throw new Error('Newer-history button is missing.');
    const oldFirst = document.querySelector('.history-title')?.textContent || '';
    const start = performance.now();
    button.click();
    while (true) {
      const rows = [...document.querySelectorAll('.history-item')];
      const first = rows[0]?.querySelector('.history-title')?.textContent || '';
      if (rows.length === expectedRows && first && first !== oldFirst) break;
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  }, HISTORY_BATCH_SIZE);
  interactionDurations.push(newerDuration);
  assert.match((await readHistoryPage()).first, /0101/);

  const latestDuration = await page.evaluate(async (expectedRows) => {
    const buttons = [...document.querySelectorAll('.history-window-actions.is-bottom button')];
    const button = buttons.at(-1);
    if (!button) throw new Error('Latest-history button is missing.');
    const start = performance.now();
    button.click();
    while (true) {
      const rows = [...document.querySelectorAll('.history-item')];
      const first = rows[0]?.querySelector('.history-title')?.textContent || '';
      if (rows.length === expectedRows && /0901/.test(first)) break;
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  }, HISTORY_BATCH_SIZE);
  interactionDurations.push(latestDuration);

  const closeDuration = await page.evaluate(async () => {
    const details = document.querySelector('.history-accordion');
    const start = performance.now();
    details.querySelector('summary').click();
    while (document.querySelectorAll('.history-item').length !== 0) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  });
  interactionDurations.push(closeDuration);
  assert.equal(await page.locator('.history-item').count(), 0);

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const reopenDuration = await page.evaluate(async (expectedRows) => {
      const details = document.querySelector('.history-accordion');
      const start = performance.now();
      details.querySelector('summary').click();
      while (document.querySelectorAll('.history-item').length !== expectedRows) {
        await new Promise(requestAnimationFrame);
      }
      return performance.now() - start;
    }, HISTORY_BATCH_SIZE);
    interactionDurations.push(reopenDuration);

    const recloseDuration = await page.evaluate(async () => {
      const details = document.querySelector('.history-accordion');
      const start = performance.now();
      details.querySelector('summary').click();
      while (document.querySelectorAll('.history-item').length !== 0) {
        await new Promise(requestAnimationFrame);
      }
      return performance.now() - start;
    });
    interactionDurations.push(recloseDuration);
  }

  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.history-accordion summary').click();
  await page.waitForFunction((expectedRows) => (
    document.querySelectorAll('.history-item').length === expectedRows
  ), HISTORY_BATCH_SIZE);
  const mobileLayout = await page.evaluate(() => {
    const actionRow = document.querySelector('.history-window-actions');
    const rect = actionRow?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      actionLeft: rect?.left ?? null,
      actionRight: rect?.right ?? null,
      rowCount: document.querySelectorAll('.history-item').length,
    };
  });
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1,
    `1,000-track mobile history overflows horizontally (${mobileLayout.documentWidth}px).`);
  assert.ok(mobileLayout.actionLeft >= -1 && mobileLayout.actionRight <= mobileLayout.viewportWidth + 1,
    'Mobile history navigation leaves the viewport.');
  assert.equal(mobileLayout.rowCount, HISTORY_BATCH_SIZE);
  await page.locator('.history-accordion summary').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 0);

  await cdp.send('HeapProfiler.collectGarbage');
  const afterClose = await readMetrics();
  const interactionP95Ms = percentile(interactionDurations, 0.95);
  const maximumDomNodes = Math.max(...pageSnapshots.map(({ domNodes }) => domNodes));
  const heapGrowthBytes = Math.max(0, afterClose.jsHeapUsedBytes - baseline.jsHeapUsedBytes);

  const result = {
    appUrl,
    historyCount: HISTORY_COUNT,
    mountedRowMaximum: HISTORY_BATCH_SIZE,
    persistedStateBytes: fixtureBytes,
    coldOpenMs: Number(coldOpenDuration.toFixed(2)),
    warmInteractionSamplesMs: interactionDurations.map((value) => Number(value.toFixed(2))),
    warmInteractionP95Ms: Number(interactionP95Ms.toFixed(2)),
    maximumDomNodes,
    mobileLayout,
    baseline,
    afterClose,
    postGcHeapGrowthBytes: heapGrowthBytes,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  assert.ok(fixtureBytes < STORAGE_BUDGET_BYTES,
    `1,000-track persisted state exceeds 1 MiB (${fixtureBytes} bytes).`);
  assert.ok(coldOpenDuration < COLD_OPEN_BUDGET_MS,
    `First history open exceeds 300ms (${coldOpenDuration.toFixed(1)}ms).`);
  assert.ok(interactionP95Ms < INTERACTION_P95_BUDGET_MS,
    `History interaction p95 exceeds 100ms (${interactionP95Ms.toFixed(1)}ms).`);
  assert.ok(heapGrowthBytes < POST_GC_HEAP_GROWTH_BUDGET_BYTES,
    `Post-GC heap grew by more than 16 MiB (${heapGrowthBytes} bytes).`);

  await context.close();
} finally {
  await browser?.close();
  await stopChild(vite);
}
