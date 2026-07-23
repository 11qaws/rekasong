import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const LIVE_USER_SURFACES = [
  '../src/pages/Dashboard.jsx',
  '../src/components/PlaybackPanel.jsx',
  '../src/components/QueuePanel.jsx',
  '../src/components/SearchPanel.jsx',
  '../src/components/SongComposer.jsx',
  '../src/components/StagingPanel.jsx',
  '../src/components/ErrorBoundary.jsx',
  '../src/components/OnAirPlayer.jsx',
  '../src/pages/DisplayWidget.jsx',
];

function withoutBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function koreanOutsideLineComments(source) {
  const findings = [];
  for (const [index, line] of withoutBlockComments(source).split(/\r?\n/).entries()) {
    const koreanIndex = line.search(/[가-힣]/);
    if (koreanIndex < 0) continue;
    const commentIndex = line.indexOf('//');
    if (commentIndex >= 0 && koreanIndex > commentIndex) continue;
    // Locale-neutral legacy metadata migration, not visible UI copy.
    const executable = line.replaceAll("'Setlink 공개 목록'", "''");
    if (/[가-힣]/.test(executable)) findings.push(`${index + 1}: ${executable.trim()}`);
  }
  return findings;
}

test('live Dashboard surfaces cannot add hardcoded Korean user copy', async () => {
  for (const relativePath of LIVE_USER_SURFACES) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.deepEqual(
      koreanOutsideLineComments(source),
      [],
      `${relativePath} must use semantic message keys for Korean user copy`,
    );
  }
});

test('live Dashboard surfaces cannot hardcode accessibility, placeholder, toast, or confirm copy', async () => {
  const visibleAttribute = /(?:alt|title|aria-label|aria-description|placeholder)=["']([^"']*[A-Za-z가-힣][^"']*)["']/g;
  const imperativeCopy = /(?:showToast|window\.confirm|confirm)\(\s*['"`]([^'"`]*[A-Za-z가-힣][^'"`]*)['"`]/g;

  for (const relativePath of LIVE_USER_SURFACES) {
    const source = withoutBlockComments(
      await readFile(new URL(relativePath, import.meta.url), 'utf8'),
    );
    assert.deepEqual(
      [...source.matchAll(visibleAttribute)].map((match) => match[0]),
      [],
      `${relativePath} must translate static accessibility and form copy`,
    );
    assert.deepEqual(
      [...source.matchAll(imperativeCopy)].map((match) => match[0]),
      [],
      `${relativePath} must translate toast and confirm copy`,
    );
  }
});
