import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { onRequest as loadSetlink } from '../functions/api/setlink.js';
import { extractVocaroLyrics } from '../functions/api/lyrics-search.js';
import { songbookLyricsCatalogKey } from '../src/lib/lyrics/lyricsSearchClient.js';

const SONGBOOK_URL = 'https://setlink.jp/public/ccd4cab1-5f67-40a1-92af-e6f8b80fc307';
const VOCARO_ORIGIN = 'https://vocaro.wikidot.com';
const OUTPUT_DIRECTORY = resolve('public/lyrics-catalog/v1');
const USER_AGENT = 'Rekasong/0.2 (+https://github.com/11qaws/rekasong)';
const CONCURRENCY = 4;

const decodeHtml = (value) => String(value || '')
  .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
  .replace(/&#x([a-f\d]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/giu, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  })[name.toLowerCase()]);

const text = (value) => decodeHtml(String(value || '').replace(/<[^>]+>/gu, ' '))
  .replace(/\s+/gu, ' ')
  .trim();

const comparable = (value) => text(value)
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const compactArtist = (value) => comparable(value).replace(/\s+/gu, '');

function artistMatches(songArtist, credits) {
  const wanted = compactArtist(songArtist);
  if (!wanted) return false;
  return credits
    .filter((credit) => credit.role === '작곡' || credit.role === '작사')
    .some((credit) => {
      const found = compactArtist(credit.name);
      return found.length >= 2
        && (wanted === found || wanted.includes(found) || found.includes(wanted));
    });
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`fetch_failed_${response.status}:${url}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/^text\/html(?:;|$)/iu.test(contentType)) throw new Error(`html_required:${url}`);
  return response.text();
}

async function songbookSongs() {
  const requestUrl = `https://catalog.invalid/api/setlink?url=${encodeURIComponent(SONGBOOK_URL)}`;
  const response = await loadSetlink({ request: new Request(requestUrl) });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.songs)) throw new Error(body.error || 'songbook_load_failed');
  return body.songs.map(({ title, artist }) => ({ title, artist }));
}

async function vocaroIndex() {
  const root = await fetchText(`${VOCARO_ORIGIN}/allsongs`);
  const categories = [...new Set([...root.matchAll(/href=['"](\/allsongs(?:-[a-z\d]+)?)['"]/giu)]
    .map((match) => match[1]))]
    .filter((path) => path !== '/allsongs');
  const pages = [];
  for (let index = 0; index < categories.length; index += CONCURRENCY) {
    const batch = categories.slice(index, index + CONCURRENCY);
    pages.push(...await Promise.all(batch.map(async (path) => ({ path, html: await fetchText(`${VOCARO_ORIGIN}${path}`) }))));
  }
  const entries = [];
  for (const { html } of pages) {
    for (const match of html.matchAll(/<a\b[^>]*href=['"](\/[^"'#?]+)['"][^>]*>([^]*?)<\/a>/giu)) {
      const title = text(match[2]);
      const key = comparable(title);
      const slug = match[1];
      if (!key || slug.startsWith('/allsongs') || /^\/(?:system|search|admin):/u.test(slug)) continue;
      entries.push(Object.freeze({ title, key, slug }));
    }
  }
  return [...new Map(entries.map((entry) => [entry.slug, entry])).values()];
}

async function main() {
  const generatedAt = new Date().toISOString();
  const [songs, index] = await Promise.all([songbookSongs(), vocaroIndex()]);
  const byTitle = new Map();
  for (const entry of index) {
    const matches = byTitle.get(entry.key) || [];
    matches.push(entry);
    byTitle.set(entry.key, matches);
  }
  const exact = songs
    .map((song) => ({ song, matches: byTitle.get(comparable(song.title)) || [] }))
    .filter(({ matches }) => matches.length === 1);
  const accepted = [];
  const rejected = [];
  for (let indexOffset = 0; indexOffset < exact.length; indexOffset += CONCURRENCY) {
    const batch = exact.slice(indexOffset, indexOffset + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ song, matches }) => {
      const sourceUrl = `${VOCARO_ORIGIN}${matches[0].slug}`;
      try {
        const extracted = extractVocaroLyrics(await fetchText(sourceUrl), song);
        if (!extracted || !artistMatches(song.artist, extracted.credits)) {
          return { accepted: false, song, sourceUrl, reason: extracted ? 'artist_mismatch' : 'page_invalid' };
        }
        return { accepted: true, song, sourceUrl, extracted };
      } catch (error) {
        return { accepted: false, song, sourceUrl, reason: error?.message || 'fetch_failed' };
      }
    }));
    for (const result of results) (result.accepted ? accepted : rejected).push(result);
    console.log(`vocaro ${Math.min(indexOffset + CONCURRENCY, exact.length)}/${exact.length}; accepted ${accepted.length}`);
  }

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const coveredKeys = new Set();
  for (const { song, sourceUrl, extracted } of accepted) {
    const key = await songbookLyricsCatalogKey(song);
    coveredKeys.add(key);
    const record = {
      schemaVersion: 1,
      title: song.title,
      artist: song.artist,
      status: 'review_required',
      language: extracted.language,
      sourceKind: 'vocaro_verbatim_lyrics',
      sourceTitle: `${extracted.pageTitle} - 보카로 가사 위키`,
      sourceUrl,
      retrievedAt: Date.parse(generatedAt),
      autoGenerated: false,
      originalTextPolicy: 'verbatim',
      timingEstimated: true,
      discoveryPath: ['vocaro'],
      lines: extracted.lines,
      translations: extracted.translations,
      translationSourceKind: 'vocaro_korean_translation',
      translationSourceTitle: `${extracted.pageTitle} - 보카로 가사 위키`,
      translationSourceUrl: sourceUrl,
      attribution: {
        source: '보카로 가사 위키',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
    };
    await writeFile(resolve(OUTPUT_DIRECTORY, `${key}.json`), `${JSON.stringify(record)}\n`, 'utf8');
  }

  const coverage = await Promise.all(songs.map(async (song) => {
    const key = await songbookLyricsCatalogKey(song);
    return { title: song.title, artist: song.artist, key, status: coveredKeys.has(key) ? 'bundled' : 'missing' };
  }));
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    songbook: { url: SONGBOOK_URL, total: songs.length },
    providers: [{ id: 'vocaro', indexed: index.length, exactTitleMatches: exact.length, bundled: accepted.length }],
    bundled: accepted.length,
    missing: songs.length - accepted.length,
    rejected: rejected.map(({ song, sourceUrl, reason }) => ({ ...song, sourceUrl, reason })),
    coverage,
  };
  await writeFile(resolve(OUTPUT_DIRECTORY, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ total: songs.length, bundled: accepted.length, missing: songs.length - accepted.length, output: OUTPUT_DIRECTORY }));
}

main().catch((error) => {
  console.error(error?.message || 'songbook_catalog_build_failed');
  process.exitCode = 1;
});
