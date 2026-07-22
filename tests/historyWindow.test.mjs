import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  HISTORY_WINDOW_BATCH_SIZE,
  createHistoryWindow,
  expandHistoryWindowLimit,
} from '../src/lib/historyWindow.js';

const entries = (count) => Array.from({ length: count }, (_, index) => ({ entryId: `entry-${index}` }));

test('history window renders only the latest 100 entries by default without mutating the source', () => {
  const source = entries(1000);
  const snapshot = [...source];
  const window = createHistoryWindow(source);

  assert.equal(HISTORY_WINDOW_BATCH_SIZE, 100);
  assert.equal(window.totalCount, 1000);
  assert.equal(window.hiddenCount, 900);
  assert.equal(window.visibleCount, 100);
  assert.equal(window.entries[0].entryId, 'entry-900');
  assert.equal(window.entries.at(-1).entryId, 'entry-999');
  assert.deepEqual(source, snapshot);
});

test('history window handles empty and boundary-sized histories', () => {
  assert.deepEqual(createHistoryWindow(null), {
    entries: [], hiddenCount: 0, visibleCount: 0, totalCount: 0,
  });
  assert.equal(createHistoryWindow(entries(1)).visibleCount, 1);
  assert.equal(createHistoryWindow(entries(100)).hiddenCount, 0);
  assert.equal(createHistoryWindow(entries(101)).hiddenCount, 1);
});

test('history window expands in bounded batches and clamps at the total', () => {
  assert.equal(expandHistoryWindowLimit(100, 1000), 200);
  assert.equal(expandHistoryWindowLimit(900, 950), 950);
  assert.equal(expandHistoryWindowLimit(1000, 950), 950);
  assert.equal(createHistoryWindow(entries(1000), 200).entries[0].entryId, 'entry-800');
});

test('QueuePanel mounts history rows only while open and resets the window when closed', async () => {
  const source = await fs.readFile(new URL('../src/components/QueuePanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /onToggle=\{handleHistoryToggle\}/);
  assert.match(source, /historyOpen \? \(/);
  assert.match(source, /setHistoryRenderLimit\(HISTORY_WINDOW_BATCH_SIZE\)/);
  assert.match(source, /createHistoryWindow\(history, historyRenderLimit\)/);
  assert.match(source, /historyWindow\.entries\.map/);
});

test('the 1000-entry browser fixture is development-only, bounded, and bypasses persisted state', async () => {
  const source = await fs.readFile(new URL('../src/hooks/useSyncState.js', import.meta.url), 'utf8');
  assert.match(source, /import\.meta\.env\?\.DEV !== true/);
  assert.match(source, /DEV_HISTORY_FIXTURE_MAX = 2000/);
  assert.match(source, /if \(developmentFixture\) return \{ state: normaliseState\(developmentFixture\), droppedLocalSongs \}/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*DEV_HISTORY_FIXTURE_QUERY/);
});
