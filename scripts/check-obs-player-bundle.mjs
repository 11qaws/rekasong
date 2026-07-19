import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(DIST, 'assets');
const MAX_RAW_BYTES = 450 * 1024;
const MAX_GZIP_BYTES = 130 * 1024;

function exactAsset(files, pattern, label) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(`obs_bundle_asset_mismatch:${label}:${matches.length}`);
  }
  return matches[0];
}

const assetFiles = await readdir(ASSETS);
const selected = [
  path.join(DIST, 'index.html'),
  path.join(ASSETS, exactAsset(assetFiles, /^index-[^.]+\.css$/, 'entry_css')),
  path.join(ASSETS, exactAsset(assetFiles, /^index-[^.]+\.js$/, 'entry_js')),
  path.join(ASSETS, exactAsset(assetFiles, /^Widget-[^.]+\.js$/, 'widget_router')),
  path.join(ASSETS, exactAsset(assetFiles, /^OnAirPlayerV2-[^.]+\.js$/, 'v2_player')),
];

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
