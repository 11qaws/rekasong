import { sha256TextHash } from './lyricsPackage.js';

const requestJson = async (url, options, fetchImpl, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
};

const catalogIdentity = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/\s+/gu, ' ')
  .trim();

export async function songbookLyricsCatalogKey(input) {
  const title = catalogIdentity(input?.title);
  if (!title) return '';
  const artist = catalogIdentity(input?.artist);
  return (await sha256TextHash(`${title}\u0000${artist}`)).slice('sha256:'.length);
}

async function searchBundledSongbookLyrics({ catalogBaseUrl, input, fetchImpl }) {
  if (!catalogBaseUrl) return null;
  const key = await songbookLyricsCatalogKey(input);
  if (!key) return null;
  let result;
  try {
    const { response, body } = await requestJson(
      new URL(`${key}.json`, catalogBaseUrl).toString(),
      { method: 'GET' },
      fetchImpl,
      10_000,
    );
    if (!response.ok) return null;
    result = body;
  } catch { return null; }
  if (result?.schemaVersion !== 1
    || catalogIdentity(result.title) !== catalogIdentity(input.title)
    || catalogIdentity(result.artist) !== catalogIdentity(input.artist)) return null;
  const requiredSource = input.sourcePriority === 'namuwiki_only'
    ? 'namuwiki'
    : input.sourcePriority === 'official_only'
      ? 'official'
      : input.sourcePriority === 'vocaro_only'
        ? 'vocaro'
        : '';
  if (requiredSource && !String(result.sourceKind || '').includes(requiredSource)) return null;
  return {
    ...result,
    videoId: input.videoId,
    discoveryPath: ['bundled_songbook_catalog', ...(Array.isArray(result.discoveryPath) ? result.discoveryPath : [])]
      .slice(0, 8),
  };
}

export async function searchHostedLyrics({
  endpoint,
  catalogBaseUrl = '',
  input,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function' || !endpoint || !input) {
    throw new TypeError('lyrics_search_configuration_invalid');
  }
  const bundled = input.sourcePriority === 'timing_only'
    ? null
    : await searchBundledSongbookLyrics({ catalogBaseUrl, input, fetchImpl });
  if (bundled) return bundled;
  const { response, body } = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl, input.sourcePriority === 'timing_only' ? 150_000 : 90_000);
  if (response.ok) return body;
  const error = new Error(body.error || 'lyrics_web_search_failed');
  error.code = body.error || 'lyrics_web_search_failed';
  error.status = response.status;
  error.diagnostics = body.diagnostics || null;
  throw error;
}
