import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

function staticImportSpecifiers(moduleSource) {
  return [...moduleSource.matchAll(
    /^\s*import\s+(?!\()(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?/gm,
  )].map((match) => match[1]);
}

async function resolveRelativeImport(fromFile, specifier) {
  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.jsx`,
    `${unresolved}.css`,
    path.join(unresolved, 'index.js'),
    path.join(unresolved, 'index.jsx'),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next supported source extension.
    }
  }

  throw new Error(`Unable to resolve ${specifier} from ${fromFile}`);
}

async function collectStaticGraph(entryFiles) {
  const pending = entryFiles.map((file) => path.join(ROOT, file));
  const files = new Set();
  const packages = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);

    if (path.extname(file) === '.css') continue;
    const moduleSource = await readFile(file, 'utf8');
    for (const specifier of staticImportSpecifiers(moduleSource)) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier.split('/')[0].startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]);
        continue;
      }
      pending.push(await resolveRelativeImport(file, specifier));
    }
  }

  return { files, packages };
}

test('App and Widget keep dashboard, display, and player routes behind lazy boundaries', async () => {
  const app = await source('src/App.jsx');
  const widget = await source('src/pages/Widget.jsx');

  assert.deepEqual(staticImportSpecifiers(app), ['react', 'react-router-dom']);
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Dashboard'\)\)/);
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Widget'\)\)/);

  assert.deepEqual(staticImportSpecifiers(widget), ['react']);
  assert.match(widget, /lazy\(\(\) => import\('\.\/DisplayWidget'\)\)/);
  assert.match(widget, /import\('\.\.\/components\/OnAirPlayer'\)/);
  assert.match(widget, /lazy\(\(\) => import\('\.\.\/components\/OnAirPlayerV2'\)\)/);
});

test('Widget preserves existing direct-query and HashRouter parameter precedence', async () => {
  const widget = await source('src/pages/Widget.jsx');

  assert.match(widget, /const roomMatch = hash\.match\(\/room=\(\[\^&\]\+\)\//);
  assert.match(widget, /const keyMatch = hash\.match\(\/key=\(\[\^&\]\+\)\//);
  assert.match(widget, /const typeMatch = hash\.match\(\/type=\(\[\^&\]\+\)\//);
  assert.match(widget, /const room = searchParams\.get\('room'\) \|\| \(roomMatch \? roomMatch\[1\] : null\)/);
  assert.match(widget, /const publicKeyB64 = searchParams\.get\('key'\) \|\| \(keyMatch \? keyMatch\[1\] : null\)/);
  assert.match(widget, /const type = searchParams\.get\('type'\) \|\| \(typeMatch \? typeMatch\[1\] : null\)/);

  for (const name of ['mode', 'session', 'token', 'api', 'protocol']) {
    const variable = name === 'api' ? 'apiBaseUrl' : name;
    assert.match(
      widget,
      new RegExp(`const ${variable} = searchParams\\.get\\('${name}'\\) \\|\\| hashParams\\.get\\('${name}'\\) \\|\\| ''`),
    );
  }
});

test('protocol=2 selected static graph excludes dashboard, display, Firebase, and animation code', async () => {
  const { files, packages } = await collectStaticGraph([
    'src/App.jsx',
    'src/pages/Widget.jsx',
    'src/components/OnAirPlayerV2.jsx',
  ]);
  const relativeFiles = [...files].map((file) => path.relative(ROOT, file).replaceAll('\\', '/'));

  for (const forbiddenFile of [
    'src/pages/Dashboard.jsx',
    'src/pages/DisplayWidget.jsx',
    'src/components/OnAirPlayer.jsx',
    'src/hooks/useRemoteSync.js',
  ]) {
    assert.equal(relativeFiles.includes(forbiddenFile), false, `${forbiddenFile} entered the protocol=2 static graph`);
  }

  for (const forbiddenPackage of ['firebase', 'framer-motion', 'react-youtube']) {
    assert.equal(packages.has(forbiddenPackage), false, `${forbiddenPackage} entered the protocol=2 static graph`);
  }
});

test('protocol=2 player caps active and prefetched sources and releases cache lifecycle', async () => {
  const player = await source('src/components/OnAirPlayerV2.jsx');

  assert.equal(
    [...player.matchAll(/maxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES/g)].length,
    2,
  );
  assert.match(player, /loadResolverMaxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES/);
  assert.match(player, /sourceResolver: prefetchCache\.resolveSource/);
  assert.match(player, /prefetchSources: prefetchCache\.prefetch/);
  assert.match(player, /prefetchCache\?\.prefetch\(\[\]\)/);
  assert.match(player, /prefetchCache\?\.dispose\(\)/);
});

test('DisplayWidget retains remote sync and display WebSocket behavior', async () => {
  const displayWidget = await source('src/pages/DisplayWidget.jsx');

  assert.deepEqual(staticImportSpecifiers(displayWidget), [
    'react',
    'framer-motion',
    '../hooks/useRemoteSync',
    '../copy/widgetMessages.js',
    './Widget.css',
  ]);
  assert.match(displayWidget, /useWidgetSync\(room, publicKeyB64,/);
  assert.match(displayWidget, /mode !== 'display' \|\| !apiBaseUrl \|\| !session \|\| !token/);
  assert.match(displayWidget, /url\.searchParams\.set\('role', 'display'\)/);
  assert.match(displayWidget, /payload\.type === 'snapshot' \|\| payload\.type === 'display_state'/);
  assert.match(displayWidget, /payload\.type === 'session_ended'/);
});
