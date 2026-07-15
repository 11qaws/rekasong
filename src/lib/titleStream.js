export async function readTitleEventStream(url, options = {}, { signal, onEvent, timeoutMs = 60000 } = {}) {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener('abort', abortRequest, { once: true });
  const timeoutId = setTimeout(abortRequest, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: requestController.signal });
    if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resolvedTitle = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (typeof event.title === 'string' && event.title.trim()) resolvedTitle = event.title.trim();
          onEvent?.(event);
        } catch {
          // Ignore a partial SSE frame; the next one completes it.
        }
      }
    }

    return resolvedTitle;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortRequest);
  }
}
