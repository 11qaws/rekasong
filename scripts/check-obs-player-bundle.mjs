import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');
const WIDGET_SOURCE = 'src/pages/Widget.jsx';
const PLAYER_SOURCE = 'src/components/OnAirPlayerV2.jsx';
const MAX_RAW_BYTES = 450 * 1024;
const MAX_GZIP_BYTES = 130 * 1024;

function exactManifestKey(manifest, predicate, label) {
  const matches = Object.entries(manifest)
    .filter(([key, entry]) => predicate(entry, key))
    .map(([key]) => key);
  if (matches.length !== 1) {
    throw new Error(`obs_bundle_manifest_entry_mismatch:${label}:${matches.length}`);
  }
  return matches[0];
}

function manifestEntry(manifest, key) {
  const entry = manifest[key];
  if (!entry) throw new Error(`obs_bundle_manifest_reference_missing:${key}`);
  return entry;
}

function dynamicImportPath(manifest, startKey, targetKey) {
  const active = new Set();

  function visit(key) {
    if (key === targetKey) return [key];
    if (active.has(key)) return null;

    active.add(key);
    const entry = manifestEntry(manifest, key);
    for (const importedKey of entry.dynamicImports ?? []) {
      manifestEntry(manifest, importedKey);
      const suffix = visit(importedKey);
      if (suffix) {
        active.delete(key);
        return [key, ...suffix];
      }
    }
    active.delete(key);
    return null;
  }

  const result = visit(startKey);
  if (!result) {
    throw new Error(`obs_bundle_dynamic_path_missing:${startKey}:${targetKey}`);
  }
  return result;
}

function staticImportClosure(manifest, rootKeys) {
  const pending = [...rootKeys];
  const included = new Set();

  while (pending.length > 0) {
    const key = pending.pop();
    if (included.has(key)) continue;

    const entry = manifestEntry(manifest, key);
    included.add(key);
    pending.push(...(entry.imports ?? []));
  }

  return included;
}

export function collectObsPlayerArtifacts(manifest) {
  const appEntryKey = exactManifestKey(
    manifest,
    (entry, key) => entry.isEntry && (key === 'index.html' || entry.src === 'index.html'),
    'app_entry',
  );
  const widgetEntryKey = exactManifestKey(
    manifest,
    (entry, key) => key === WIDGET_SOURCE || entry.src === WIDGET_SOURCE,
    'widget_entry',
  );
  const playerEntryKey = exactManifestKey(
    manifest,
    (entry, key) => key === PLAYER_SOURCE || entry.src === PLAYER_SOURCE,
    'v2_player',
  );

  const appToWidget = dynamicImportPath(manifest, appEntryKey, widgetEntryKey);
  const widgetToPlayer = dynamicImportPath(manifest, widgetEntryKey, playerEntryKey);
  const routeKeys = [...appToWidget, ...widgetToPlayer.slice(1)];
  const dependencyKeys = staticImportClosure(manifest, routeKeys);
  const artifactPaths = new Set();

  for (const key of dependencyKeys) {
    const entry = manifestEntry(manifest, key);
    if (entry.file) artifactPaths.add(entry.file);
    for (const css of entry.css ?? []) artifactPaths.add(css);
    for (const asset of entry.assets ?? []) artifactPaths.add(asset);
  }

  return ['index.html', ...[...artifactPaths].sort()];
}

function fileWithinDist(relativeFile) {
  const file = path.resolve(DIST, relativeFile);
  const relative = path.relative(DIST, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`obs_bundle_artifact_outside_dist:${relativeFile}`);
  }
  return file;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const selected = collectObsPlayerArtifacts(manifest).map(fileWithinDist);

  const artifacts = await Promise.all(selected.map(async (file) => {
    const bytes = await readFile(file);
    return {
      file: path.relative(DIST, file).replaceAll('\\', '/'),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(bytes).byteLength,
      text: bytes.toString('utf8'),
    };
  }));

  const totals = artifacts.reduce((result, artifact) => ({
    rawBytes: result.rawBytes + artifact.rawBytes,
    gzipBytes: result.gzipBytes + artifact.gzipBytes,
    brotliBytes: result.brotliBytes + artifact.brotliBytes,
  }), { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 });

  const selectedText = artifacts.map(({ text }) => text).join('\n');
  for (const forbidden of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    if (selectedText.includes(forbidden)) {
      throw new Error(`obs_bundle_external_font_request:${forbidden}`);
    }
  }
  if (totals.rawBytes > MAX_RAW_BYTES) {
    throw new Error(`obs_bundle_raw_budget_exceeded:${totals.rawBytes}:${MAX_RAW_BYTES}`);
  }
  if (totals.gzipBytes > MAX_GZIP_BYTES) {
    throw new Error(`obs_bundle_gzip_budget_exceeded:${totals.gzipBytes}:${MAX_GZIP_BYTES}`);
  }

  const report = {
    code: 'obs_player_bundle_budget_passed',
    budgets: {
      rawBytes: MAX_RAW_BYTES,
      gzipBytes: MAX_GZIP_BYTES,
    },
    totals,
    artifacts: artifacts.map(({ text: _text, ...artifact }) => artifact),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
