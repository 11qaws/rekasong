import { extractNamuWikiLyricsBlocks } from '../functions/api/lyrics-search.js';

const MAX_HTML_BYTES = 2_000_000;
const DEFAULT_ENDPOINT = 'https://rekasong.pages.dev/api/lyrics-ingest';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function exactNamuWikiUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en') !== 'namu.wiki'
    || url.username || url.password || !url.pathname.startsWith('/w/')) return null;
  url.hash = '';
  return url;
}

async function fetchNamuWikiHtml(sourceUrl) {
  let url = exactNamuWikiUrl(sourceUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!url) throw new Error('source_url_invalid');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Rekasong/0.2 (+https://github.com/11qaws/rekasong)' },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      url = location ? exactNamuWikiUrl(new URL(location, url).toString()) : null;
      continue;
    }
    const contentType = response.headers.get('content-type') || '';
    const declaredLength = Number(response.headers.get('content-length'));
    if (!response.ok || !/^text\/html(?:;|$)/iu.test(contentType)
      || (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES)) {
      throw new Error(`source_fetch_failed_${response.status}`);
    }
    const html = await response.text();
    if (!html || new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
      throw new Error('source_response_too_large');
    }
    return { html, sourceUrl: url.toString() };
  }
  throw new Error('source_redirect_limit');
}

function sourceTitle(sourceUrl) {
  try { return decodeURIComponent(new URL(sourceUrl).pathname.slice(3)).slice(0, 240); } catch { return ''; }
}

async function main() {
  const title = argument('title');
  const artist = argument('artist');
  const requestedSourceUrl = argument('source-url');
  const endpoint = argument('endpoint') || process.env.REKASONG_LYRICS_INGEST_ENDPOINT || DEFAULT_ENDPOINT;
  const secret = String(process.env.REKASONG_LYRICS_INGEST_SECRET || '').trim();
  if (!title || !requestedSourceUrl) {
    throw new Error('usage: node scripts/seed-namuwiki-lyrics.mjs --title <title> --artist <artist> --source-url <https://namu.wiki/w/...>');
  }
  if (secret.length < 24) throw new Error('REKASONG_LYRICS_INGEST_SECRET_is_required');

  const fetched = await fetchNamuWikiHtml(requestedSourceUrl);
  const blocks = extractNamuWikiLyricsBlocks(fetched.html);
  if (!blocks.length) throw new Error('source_lyrics_blocks_not_found');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      artist,
      sourceTitle: sourceTitle(fetched.sourceUrl) || title,
      sourceUrl: fetched.sourceUrl,
      blocks,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.stored !== true) {
    throw new Error(result.error || `ingest_failed_${response.status}`);
  }
  console.log(JSON.stringify({
    stored: true,
    sourceUrl: result.sourceUrl,
    blockCount: blocks.length,
    lineCount: result.lineCount,
    language: result.language,
    originalTextPolicy: result.originalTextPolicy,
    endpoint,
  }));
}

main().catch((error) => {
  console.error(error?.message || 'namuwiki_seed_failed');
  process.exitCode = 1;
});
