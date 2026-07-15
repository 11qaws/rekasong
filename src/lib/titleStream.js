export async function readTitleEventStream(url, options = {}, { signal, onEvent } = {}) {
  const response = await fetch(url, { ...options, signal });
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
}
