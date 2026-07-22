import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldUseLegacyWidgetRelay } from '../src/hooks/useRemoteSync.js';

test('the legacy room/key relay is dormant when the authenticated On-Air display path exists', () => {
  assert.equal(shouldUseLegacyWidgetRelay(true), false);
  assert.equal(shouldUseLegacyWidgetRelay(false), true);
  assert.equal(shouldUseLegacyWidgetRelay(undefined), true);
});

test('Dashboard gates room creation, signing keys, and publishSync behind the legacy relay boundary', async () => {
  const source = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /const useLegacyWidgetRelay = shouldUseLegacyWidgetRelay\(useOnAirPlayer\)/,
  );
  assert.match(
    source,
    /useState\(\(\) => \(useLegacyWidgetRelay \? getOrCreateRoom\(\) : ''\)\)/,
  );
  assert.match(
    source,
    /if \(useLegacyWidgetRelay && !signingKeys\)[\s\S]*?getOrCreateSigningKeys\(\)/,
  );
  assert.match(
    source,
    /if \(useLegacyWidgetRelay && room && signingKeys\)[\s\S]*?publishSync\(/,
  );
});
