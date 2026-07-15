import { useCallback, useEffect, useRef, useState } from 'react';

export function useAiTitleExtraction(setStagedItem) {
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState('');
  const requestRef = useRef({ id: 0, controller: null });

  const cancelAiExtraction = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
    setIsAiLoading(false);
  }, []);

  const setAiStatus = useCallback((message = '') => {
    setAiStatusMessage(message);
  }, []);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const runAiExtractionStream = useCallback(async (url, options = {}, stagingId, { overwriteTitle = false } = {}) => {
    requestRef.current.controller?.abort();
    const requestId = requestRef.current.id + 1;
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };

    setIsAiLoading(true);
    setAiStatusMessage('AI 분석을 준비하고 있습니다…');

    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          if (requestRef.current.id !== requestId) return;
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            if (typeof data.title === 'string' && data.title.trim()) {
              setStagedItem(prev => {
                if (!prev || prev.stagingId !== stagingId || (!overwriteTitle && prev.isTitleEdited)) return prev;
                return {
                  ...prev,
                  title: data.title.trim(),
                  ...(overwriteTitle ? { isTitleEdited: false } : {})
                };
              });
              setAiStatusMessage(
                data.mode === 'cache'
                  ? '저장된 곡명 적용 완료'
                  : data.mode === 'candidate'
                  ? (data.status || '곡명 후보를 확인 중입니다.')
                  : data.mode === 'fallback'
                  ? '기본 제목 정리 완료 · AI 분석을 사용하려면 Gemini 키를 연결하세요.'
                  : data.mode === 'rules'
                    ? '제목 규칙 정리 완료 · 필요하면 다시 분석하세요.'
                  : 'AI 제목 정리 완료'
              );
            } else if (data.error || data.status === 'error') {
              console.error(data.error || data.status);
              setAiStatusMessage('AI 분석에 실패했습니다. 직접 수정할 수 있어요.');
            } else if (data.message || data.status) {
              setAiStatusMessage(data.message || data.status);
            }
          } catch {
            // Ignore a partial SSE frame; the next frame completes it.
          }
        }
      }
    } catch (error) {
      if (requestRef.current.id === requestId && error.name !== 'AbortError') {
        console.error(error);
        setAiStatusMessage('AI 분석에 실패했습니다. 직접 수정할 수 있어요.');
      }
    } finally {
      clearTimeout(timeoutId);
      if (requestRef.current.id === requestId) {
        requestRef.current = { id: requestId, controller: null };
        setIsAiLoading(false);
      }
    }
  }, [setStagedItem]);

  return { aiStatusMessage, cancelAiExtraction, isAiLoading, runAiExtractionStream, setAiStatus };
}
