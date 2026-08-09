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

export async function searchHostedLyrics({
  endpoint,
  input,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function' || !endpoint || !input) {
    throw new TypeError('lyrics_search_configuration_invalid');
  }
  const { response, body } = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl, 90_000);
  if (response.ok) return body;
  const error = new Error(body.error || 'lyrics_web_search_failed');
  error.code = body.error || 'lyrics_web_search_failed';
  error.status = response.status;
  error.diagnostics = body.diagnostics || null;
  throw error;
}
