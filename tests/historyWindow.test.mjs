import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  HISTORY_WINDOW_BATCH_SIZE,
  createHistoryWindow,
  shiftHistoryWindowOffset,
} from '../src/lib/historyWindow.js';

const entries = (count) => Array.from({ length: count }, (_, index) => ({ entryId: `entry-${index}` }));

test('history window renders only the latest 100 entries by default without mutating the source', () => {
  const source = entries(1000);
  const snapshot = [...source];
  const window = createHistoryWindow(source);

  assert.equal(HISTORY_WINDOW_BATCH_SIZE, 100);
  assert.equal(window.totalCount, 1000);
  assert.equal(window.olderCount, 900);
  assert.equal(window.newerCount, 0);
  assert.equal(window.visibleCount, 100);
  assert.equal(window.offset, 0);
  assert.equal(window.entries[0].entryId, 'entry-900');
  assert.equal(window.entries.at(-1).entryId, 'entry-999');
  assert.deepEqual(source, snapshot);
});

test('history window handles empty and boundary-sized histories', () => {
  assert.deepEqual(createHistoryWindow(null), {
    entries: [], olderCount: 0, newerCount: 0, visibleCount: 0, totalCount: 0, offset: 0,
  });
  assert.equal(createHistoryWindow(entries(1)).visibleCount, 1);
  assert.equal(createHistoryWindow(entries(100)).olderCount, 0);
  assert.equal(createHistoryWindow(entries(101)).olderCount, 1);
});

test('history window pages through older entries without mounting more than one batch', () => {
  const source = entries(1000);
  const older = createHistoryWindow(source, 100);
  assert.equal(older.visibleCount, 100);
  assert.equal(older.entries[0].entryId, 'entry-800');
  assert.equal(older.entries.at(-1).entryId, 'entry-899');
  assert.equal(older.olderCount, 800);
  assert.equal(older.newerCount, 100);
  assert.equal(older.offset, 100);

  const oldest = createHistoryWindow(source, 9999);
  assert.equal(oldest.visibleCount, 100);
  assert.equal(oldest.entries[0].entryId, 'entry-0');
  assert.equal(oldest.entries.at(-1).entryId, 'entry-99');
  assert.equal(oldest.olderCount, 0);
  assert.equal(oldest.newerCount, 900);
  assert.equal(oldest.offset, 900);

  assert.equal(shiftHistoryWindowOffset(0, 'older', 1000), 100);
  assert.equal(shiftHistoryWindowOffset(900, 'older', 1000), 900);
  assert.equal(shiftHistoryWindowOffset(900, 'newer', 1000), 800);
  assert.equal(shiftHistoryWindowOffset(50, 'newer', 1000), 0);
});

test('a partial oldest page never overlaps its neighbouring page', () => {
  const source = entries(950);
  const nextToOldest = createHistoryWindow(source, 800);
  const oldestOffset = shiftHistoryWindowOffset(nextToOldest.offset, 'older', source.length);
  const oldest = createHistoryWindow(source, oldestOffset);

  assert.equal(oldestOffset, 900);
  assert.equal(oldest.visibleCount, 50);
  assert.equal(oldest.entries[0].entryId, 'entry-0');
  assert.equal(oldest.entries.at(-1).entryId, 'entry-49');
  assert.equal(nextToOldest.entries[0].entryId, 'entry-50');
  assert.equal(shiftHistoryWindowOffset(oldestOffset, 'newer', source.length), 800);
  assert.equal(new Set([...oldest.entries, ...nextToOldest.entries].map(({ entryId }) => entryId)).size, 150);
});

test('QueuePanel mounts history rows only while open and resets the window when closed', async () => {
  const source = await fs.readFile(new URL('../src/components/QueuePanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /onToggle=\{handleHistoryToggle\}/);
  assert.match(source, /historyOpen \? \(/);
  assert.match(source, /setHistoryWindowOffset\(0\)/);
  assert.match(source, /createHistoryWindow\(history, historyWindowOffset\)/);
  assert.match(source, /shiftHistoryWindowOffset\(current, 'older', history\.length\)/);
  assert.match(source, /shiftHistoryWindowOffset\(current, 'newer', history\.length\)/);
  assert.doesNotMatch(source, /historyRenderLimit|expandHistoryWindowLimit/);
  assert.match(source, /historyWindow\.entries\.map/);
});

test('the 1000-entry browser fixture is development-only, bounded, and bypasses persisted state', async () => {
  const source = await fs.readFile(new URL('../src/hooks/useSyncState.js', import.meta.url), 'utf8');
  assert.match(source, /import\.meta\.env\?\.DEV !== true/);
  assert.match(source, /DEV_HISTORY_FIXTURE_MAX = 2000/);
  assert.match(source, /if \(developmentFixture\) return \{ state: normaliseState\(developmentFixture\), localFilesNeedReselection \}/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*DEV_HISTORY_FIXTURE_QUERY/);
});
