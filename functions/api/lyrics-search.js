const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const MAX_RESULTS = 50;
const MAX_CUES = 2_000;
const MAX_SYNCED_LYRICS_LENGTH = 200_000;
const MAX_CUE_TEXT_LENGTH = 500;

const corsHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const bounded = (value, max) => String(value ?? '').normalize('NFC').trim().slice(0, max);

export function validateLyricsSearchRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const videoId = bounded(value.videoId, 11);
  const title = bounded(value.title, 240);
  const artist = bounded(value.artist, 240);
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId) || !title) return null;
  const durationMs = Number(value.durationMs);
  return Object.freeze({
    videoId,
    title,
    artist,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
  });
}

const comparable = (value) => bounded(value, 500)
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const tokenOverlap = (left, right) => {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const matches = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return matches / Math.max(leftTokens.size, rightTokens.size);
};

const matchScore = (input, candidate) => {
  const wantedTitle = comparable(input.title);
  const foundTitle = comparable(candidate?.trackName);
  if (!wantedTitle || !foundTitle) return -1;

  let score = wantedTitle === foundTitle
    ? 10
    : wantedTitle.includes(foundTitle) || foundTitle.includes(wantedTitle)
      ? 7
      : Math.round(tokenOverlap(wantedTitle, foundTitle) * 6);
  if (score < 4) return -1;

  const wantedArtist = comparable(input.artist);
  const foundArtist = comparable(candidate?.artistName);
  if (wantedArtist && foundArtist) {
    if (wantedArtist === foundArtist) score += 5;
    else if (wantedArtist.includes(foundArtist) || foundArtist.includes(wantedArtist)) score += 4;
    else score += Math.round(tokenOverlap(wantedArtist, foundArtist) * 3) - 1;
  }

  if (input.durationMs && Number.isFinite(Number(candidate?.duration))) {
    const difference = Math.abs(input.durationMs / 1_000 - Number(candidate.duration));
    if (difference <= 3) score += 4;
    else if (difference <= 8) score += 3;
    else if (difference <= 15) score += 1;
    else if (difference > 30) score -= 4;
  }
  return score;
};

export function parseSyncedLyrics(value) {
  const source = String(value ?? '');
  if (!source || source.length > MAX_SYNCED_LYRICS_LENGTH) return [];
  const cues = [];
  for (const rawLine of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)];
    if (!timestamps.length) continue;
    const text = rawLine
      .replace(/\[[^\]]+\]/gu, '')
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/gu, '')
      .normalize('NFC')
      .trim()
      .slice(0, MAX_CUE_TEXT_LENGTH);
    if (!text) continue;
    for (const timestamp of timestamps) {
      const fraction = String(timestamp[3] || '0').padEnd(3, '0').slice(0, 3);
      const anchorMs = ((Number(timestamp[1]) * 60) + Number(timestamp[2])) * 1_000 + Number(fraction);
      if (!Number.isFinite(anchorMs)) continue;
      cues.push({ anchorMs, text });
      if (cues.length >= MAX_CUES) break;
    }
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((left, right) => left.anchorMs - right.anchorMs);
}

export function selectLrclibCandidate(input, results) {
  let selected = null;
  for (const value of Array.isArray(results) ? results.slice(0, MAX_RESULTS) : []) {
    if (!value || value.instrumental === true || !Number.isInteger(value.id)) continue;
    const cues = parseSyncedLyrics(value.syncedLyrics);
    if (!cues.length) continue;
    const score = matchScore(input, value);
    if (score < 4 || (selected && selected.score >= score)) continue;
    selected = { value, cues, score };
  }
  if (!selected) return null;

  const { value, cues } = selected;
  const trackName = bounded(value.trackName, 240) || input.title;
  const artistName = bounded(value.artistName, 240) || input.artist;
  return Object.freeze({
    schemaVersion: 1,
    videoId: input.videoId,
    status: 'review_required',
    language: bounded(value.lang, 16) || 'und',
    sourceKind: 'lrclib_synced_lyrics',
    sourceTitle: [trackName, artistName].filter(Boolean).join(' — '),
    sourceUrl: `https://lrclib.net/api/get/${value.id}`,
    retrievedAt: Date.now(),
    autoGenerated: false,
    cues,
  });
}

export async function searchLrclibLyrics(input, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('lyrics_web_provider_unavailable'), { status: 503 });
  const url = new URL(LRCLIB_SEARCH_URL);
  url.searchParams.set('track_name', input.title);
  if (input.artist) url.searchParams.set('artist_name', input.artist);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Rekasong/0.2 (+https://github.com/11qaws/rekasong)' },
      signal: controller.signal,
    });
  } catch (cause) {
    throw Object.assign(new Error('lyrics_web_provider_unavailable', { cause }), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw Object.assign(new Error('lyrics_web_provider_unavailable'), { status: response.status === 429 ? 429 : 502 });
  }

  let results;
  try { results = await response.json(); } catch { results = null; }
  const candidate = selectLrclibCandidate(input, results);
  if (!candidate) throw Object.assign(new Error('lyrics_web_candidate_not_found'), { status: 404 });
  return candidate;
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let input;
  try { input = validateLyricsSearchRequest(await request.json()); } catch { input = null; }
  if (!input) return json({ error: 'lyrics_search_request_invalid' }, 400);
  try {
    return json(await searchLrclibLyrics(input));
  } catch (error) {
    return json({ error: error?.message || 'lyrics_web_search_failed' }, error?.status || 502);
  }
}
