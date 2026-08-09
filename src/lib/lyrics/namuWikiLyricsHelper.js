export const NAMUWIKI_LYRICS_HELPER_URL = 'http://127.0.0.1:47653';

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

const helperAvailable = async (helperUrl, fetchImpl) => {
  try {
    const { response, body } = await requestJson(
      `${helperUrl}/health`,
      { method: 'GET', cache: 'no-store' },
      fetchImpl,
      800,
    );
    return response.ok && body.ok === true;
  } catch { return false; }
};

const fetchRelay = async (helperUrl, input, fetchImpl) => {
  try {
    const { response, body } = await requestJson(
      `${helperUrl}/v1/namuwiki`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      fetchImpl,
      20_000,
    );
    return response.ok ? body : null;
  } catch { return null; }
};

const postLyricsSearch = async (endpoint, input, fetchImpl, namuRelay = null) => {
  const { response, body } = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, ...(namuRelay ? { namuRelay } : {}) }),
    },
    fetchImpl,
    90_000,
  );
  return { response, body };
};

const throwSearchError = ({ response, body }) => {
  const error = new Error(body.error || 'lyrics_web_search_failed');
  error.code = body.error || 'lyrics_web_search_failed';
  error.status = response.status;
  error.diagnostics = body.diagnostics || null;
  throw error;
};

export async function searchLyricsWithNamuWikiHelper({
  endpoint,
  input,
  fetchImpl = globalThis.fetch,
  helperUrl = NAMUWIKI_LYRICS_HELPER_URL,
} = {}) {
  if (typeof fetchImpl !== 'function' || !endpoint || !input) {
    throw new TypeError('lyrics_search_configuration_invalid');
  }
  if (input.sourcePriority !== 'namuwiki_only') {
    const result = await postLyricsSearch(endpoint, input, fetchImpl);
    return result.response.ok ? result.body : throwSearchError(result);
  }

  const available = await helperAvailable(helperUrl, fetchImpl);
  const exactRelay = available
    ? await fetchRelay(helperUrl, { title: input.title }, fetchImpl)
    : null;
  let result = await postLyricsSearch(endpoint, input, fetchImpl, exactRelay);
  if (result.response.ok) return result.body;

  const discoveredUrls = [...new Set([
    result.body?.diagnostics?.namuRelayUrl,
    ...(Array.isArray(result.body?.diagnostics?.namuRelayUrls)
      ? result.body.diagnostics.namuRelayUrls
      : []),
  ].map((value) => String(value || '')).filter(Boolean))].slice(0, 3);
  for (const discoveredUrl of discoveredUrls) {
    if (!available || discoveredUrl === exactRelay?.sourceUrl) continue;
    const discoveredRelay = await fetchRelay(helperUrl, { sourceUrl: discoveredUrl }, fetchImpl);
    if (discoveredRelay) {
      result = await postLyricsSearch(endpoint, input, fetchImpl, discoveredRelay);
      if (result.response.ok) return result.body;
    }
  }
  return throwSearchError(result);
}
