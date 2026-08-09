import { isFallbackGeminiKey, selectGeminiApiKey } from './gemini.js';
import {
  createNamuWikiLyricsCacheRecord,
  putCachedNamuWikiLyrics,
  selectNamuWikiLyricsBlock,
} from './lyrics-search.js';

const MAX_BODY_BYTES = 120_000;
const MAX_BLOCKS = 20;
const MAX_LINES = 2_000;
const MAX_LINE_CHARACTERS = 500;
const MAX_TOTAL_CHARACTERS = 80_000;
const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: responseHeaders,
});
const bounded = (value, max) => String(value ?? '').normalize('NFC').trim().slice(0, max);

const exactNamuWikiUrl = (value) => {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en') !== 'namu.wiki'
    || url.username || url.password || !url.pathname.startsWith('/w/')) return null;
  url.search = '';
  url.hash = '';
  return url;
};

export function validateNamuWikiIngestRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = bounded(value.title, 240);
  const artist = bounded(value.artist, 240);
  const sourceUrl = exactNamuWikiUrl(value.sourceUrl);
  if (!title || !sourceUrl || !Array.isArray(value.blocks)
    || value.blocks.length === 0 || value.blocks.length > MAX_BLOCKS) return null;

  let totalCharacters = 0;
  const blocks = [];
  for (const [blockIndex, candidate] of value.blocks.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !Array.isArray(candidate.lines)
      || candidate.lines.length < 5 || candidate.lines.length > MAX_LINES) return null;
    const lines = candidate.lines.map((line) => String(line ?? '').normalize('NFC').trim());
    if (lines.some((line) => !line || line.length > MAX_LINE_CHARACTERS)) return null;
    totalCharacters += lines.reduce((total, line) => total + line.length, 0);
    if (totalCharacters > MAX_TOTAL_CHARACTERS) return null;
    blocks.push(Object.freeze({
      blockIndex,
      heading: bounded(candidate.heading, 240),
      lines: Object.freeze(lines),
    }));
  }

  return Object.freeze({
    title,
    artist,
    sourceTitle: bounded(value.sourceTitle, 240) || title,
    sourceUrl: sourceUrl.toString(),
    blocks: Object.freeze(blocks),
  });
}

export async function ingestNamuWikiLyrics(value, {
  apiKey,
  cache,
  fetchImpl = globalThis.fetch,
} = {}) {
  const input = validateNamuWikiIngestRequest(value);
  if (!input) throw Object.assign(new Error('lyrics_ingest_request_invalid'), { status: 400 });
  if (isFallbackGeminiKey(apiKey)) {
    throw Object.assign(new Error('lyrics_web_search_credentials_unavailable'), { status: 503 });
  }
  if (!cache?.put) throw Object.assign(new Error('lyrics_cache_unavailable'), { status: 503 });

  const selected = await selectNamuWikiLyricsBlock(
    input.blocks,
    {
      sourceTitle: input.sourceTitle,
      sourceUrl: input.sourceUrl,
      sourceCategory: 'namuwiki',
    },
    input,
    apiKey,
    fetchImpl,
  );
  if (!selected) throw Object.assign(new Error('lyrics_ingest_candidate_rejected'), { status: 422 });

  const record = createNamuWikiLyricsCacheRecord(input, selected);
  if (!record) throw Object.assign(new Error('lyrics_cache_record_invalid'), { status: 422 });
  await putCachedNamuWikiLyrics(cache, record);
  return Object.freeze({
    stored: true,
    sourceUrl: record.sourceUrl,
    lineCount: record.lines.length,
    language: record.language,
    originalTextPolicy: record.originalTextPolicy,
  });
}

async function equalSecrets(left, right) {
  if (!left || !right || !globalThis.crypto?.subtle) return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', encoder.encode(left)),
    globalThis.crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const configuredSecret = String(env?.LYRICS_INGEST_SECRET || '').trim();
  if (configuredSecret.length < 24) return json({ error: 'lyrics_ingest_unavailable' }, 503);
  const authorization = request.headers.get('authorization') || '';
  const suppliedSecret = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!await equalSecrets(configuredSecret, suppliedSecret)) return json({ error: 'unauthorized' }, 401);

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'lyrics_ingest_request_too_large' }, 413);
  }
  let value;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: 'lyrics_ingest_request_too_large' }, 413);
    }
    value = JSON.parse(raw);
  } catch {
    return json({ error: 'lyrics_ingest_request_invalid' }, 400);
  }

  try {
    return json(await ingestNamuWikiLyrics(value, {
      apiKey: selectGeminiApiKey(env || {}),
      cache: env?.TITLE_CACHE,
    }));
  } catch (error) {
    const knownErrors = new Set([
      'lyrics_ingest_request_invalid',
      'lyrics_web_search_credentials_unavailable',
      'lyrics_cache_unavailable',
      'lyrics_ingest_candidate_rejected',
      'lyrics_cache_record_invalid',
      'rate_limited',
    ]);
    const message = knownErrors.has(error?.message) ? error.message : 'lyrics_ingest_failed';
    return json({ error: message }, error?.status || 502);
  }
}
