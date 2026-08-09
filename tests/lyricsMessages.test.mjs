import test from 'node:test';
import assert from 'node:assert/strict';

import { lyricsMessageCatalog } from '../src/copy/lyricsMessages.js';

test('lyrics preparation and status copy keeps Korean-English key parity', () => {
  assert.deepEqual(
    Object.keys(lyricsMessageCatalog.ko).sort(),
    Object.keys(lyricsMessageCatalog.en).sort(),
  );
});
