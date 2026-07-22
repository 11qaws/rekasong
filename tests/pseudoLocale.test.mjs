import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  PSEUDO_LOCALE_EXPANSION_RATIO,
  pseudoLocalizeText,
} from '../scripts/pseudo-locale-fixture.mjs';

test('pseudo locale expands ordinary UI copy while preserving surrounding whitespace', () => {
  const source = '  Choose the language used by the app interface.  ';
  const result = pseudoLocalizeText(source);
  const sourceBody = source.trim();
  const resultBody = result.trim();

  assert.ok(result.startsWith('  ⟦'));
  assert.ok(result.endsWith('⟧  '));
  assert.notEqual(resultBody, sourceBody);
  assert.ok(resultBody.length >= sourceBody.length * (1 + PSEUDO_LOCALE_EXPANSION_RATIO));
  assert.match(resultBody, /[åçéîöû]/u);
});

test('pseudo locale preserves placeholders, URLs, product names, and protocol tokens', () => {
  const source = 'Open {{count}} tracks at https://example.com/v1?q=OBS for Rekasong OBS G2 and YouTube.';
  const result = pseudoLocalizeText(source);

  for (const protectedValue of [
    '{{count}}',
    'https://example.com/v1?q=OBS',
    'Rekasong',
    'OBS',
    'G2',
    'YouTube',
  ]) {
    assert.ok(result.includes(protectedValue), `Pseudo locale changed ${protectedValue}.`);
  }
  assert.equal(pseudoLocalizeText('https://example.com/v1'), 'https://example.com/v1');
  assert.equal(pseudoLocalizeText('한국어'), '한국어');
});

test('pseudo-locale browser smoke is an isolated deployment gate', async () => {
  const [packageJson, workflow, smoke] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/dashboard-pseudo-locale-smoke.mjs', import.meta.url), 'utf8'),
  ]);

  assert.equal(
    packageJson.scripts['test:dashboard:pseudo'],
    'node scripts/dashboard-pseudo-locale-smoke.mjs',
  );
  const buildIndex = workflow.indexOf('- name: Build');
  const pseudoIndex = workflow.indexOf('- name: Pseudo-locale layout');
  const uploadIndex = workflow.indexOf('- name: Upload Pages artifact');
  assert.ok(buildIndex >= 0 && pseudoIndex > buildIndex && uploadIndex > pseudoIndex);
  assert.match(workflow, /run: npm run test:dashboard:pseudo/);
  assert.match(smoke, /\[320, 375, 768, 1100\]/);
  assert.match(smoke, /main-dashboard/);
  assert.match(smoke, /speaker-settings/);
  assert.match(smoke, /obs-settings/);
  assert.match(smoke, /context\.route\('\*\*\/v1\/sessions\*\*'/);
  assert.match(smoke, /context\.routeWebSocket/);
  assert.match(smoke, /mediaSafety\.playing/);
});
