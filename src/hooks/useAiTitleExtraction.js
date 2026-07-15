import { useCallback, useEffect, useRef, useState } from 'react';

// AI 응답이 늦게 도착해도 현재 스테이징 곡과 사용자의 수동 편집을 침범하지 않게 한다.
export function useAiTitleExtraction(setStagedItem) {
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState('');
  const requestRef = useRef({ id: 0, controller: null });

  const cancelAiExtraction = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
    setIsAiLoading(false);
  }, []);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const runAiExtractionStream = useCallback(async (url, options = {}, stagingId) => {
    requestRef.current.controller?.abort();
    const requestId = requestRef.current.id + 1;
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };

    setIsAiLoading(true);
    setAiStatusMessage('AI 분석 준비 중...');

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);

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
            if (data.status === '완료') {
              setStagedItem(prev => {
                if (!prev || prev.stagingId !== stagingId || prev.isTitleEdited) return prev;
                return { ...prev, title: data.title };
              });
              setAiStatusMessage('AI 추출 완료');
            } else if (data.status === '에러') {
              console.error(data.error);
              setAiStatusMessage('AI 추출 실패 (직접 입력 가능)');
            } else {
              setAiStatusMessage(data.status);
            }
          } catch {
            // 분할 전송된 불완전 이벤트는 다음 청크를 기다린다.
          }
        }
      }
    } catch (error) {
      if (requestRef.current.id === requestId && error.name !== 'AbortError') {
        console.error(error);
        setAiStatusMessage('AI 추출 실패 (직접 입력 가능)');
      } else if (requestRef.current.id === requestId && timedOut) {
        setAiStatusMessage('AI 응답 지연 (직접 입력 가능)');
      }
    } finally {
      clearTimeout(timeoutId);
      if (requestRef.current.id === requestId) {
        requestRef.current = { id: requestId, controller: null };
        setIsAiLoading(false);
      }
    }
  }, [setStagedItem]);

  return { aiStatusMessage, cancelAiExtraction, isAiLoading, runAiExtractionStream };
}
