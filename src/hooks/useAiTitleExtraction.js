import { useCallback, useEffect, useRef, useState } from 'react';
import { readTitleEventStream } from '../lib/titleStream';
import { getAppMessage } from '../copy/appMessages.js';

export function useAiTitleExtraction(setStagedItem, translate = getAppMessage) {
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatus, setAiStatusState] = useState(null);
  const requestRef = useRef({ id: 0, controller: null });
  const aiStatusMessage = aiStatus?.key
    ? translate(aiStatus.key, aiStatus.values ?? {})
    : '';
  const aiStatusPhase = aiStatus?.phase ?? 1;

  const cancelAiExtraction = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
    setIsAiLoading(false);
  }, []);

  const setAiStatus = useCallback((key = '', values = {}, phase = 1) => {
    setAiStatusState(key ? { key, values, phase } : null);
  }, []);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const runAiExtractionStream = useCallback(async (url, options = {}, stagingId, { overwriteTitle = false } = {}) => {
    requestRef.current.controller?.abort();
    const requestId = requestRef.current.id + 1;
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };

    setIsAiLoading(true);
    setAiStatusState({ key: 'ai.status.preparing', phase: 1 });

    try {
      await readTitleEventStream(url, options, {
        signal: controller.signal,
        onEvent: (data) => {
          if (requestRef.current.id !== requestId) return;
          if (typeof data.title === 'string' && data.title.trim()) {
            setStagedItem(prev => {
              if (!prev || prev.stagingId !== stagingId || (!overwriteTitle && prev.isTitleEdited)) return prev;
              return {
                ...prev,
                title: data.title.trim(),
                ...(overwriteTitle ? { isTitleEdited: false } : {})
              };
            });
            setAiStatusState(data.mode === 'cache'
              ? { key: 'ai.status.cacheComplete', phase: 3 }
              : data.mode === 'candidate'
                ? { key: 'ai.status.candidate', phase: 2 }
                : data.mode === 'fallback'
                  ? { key: 'ai.status.fallbackComplete', phase: 3 }
                  : data.mode === 'rules'
                    ? { key: 'ai.status.rulesComplete', phase: 3 }
                    : { key: 'ai.status.complete', phase: 3 });
          } else if (data.error || data.status === 'error') {
            console.error(data.error || data.status);
            setAiStatusState({ key: 'ai.status.failed', phase: 3 });
          } else if (data.message || data.status) {
            setAiStatusState({ key: 'ai.status.processing', phase: 2 });
          }
        }
      });
    } catch (error) {
      if (requestRef.current.id === requestId && error.name !== 'AbortError') {
        console.error(error);
        setAiStatusState({ key: 'ai.status.failed', phase: 3 });
      }
    } finally {
      if (requestRef.current.id === requestId) {
        requestRef.current = { id: requestId, controller: null };
        setIsAiLoading(false);
      }
    }
  }, [setStagedItem]);

  return {
    aiStatusMessage,
    aiStatusPhase,
    cancelAiExtraction,
    isAiLoading,
    runAiExtractionStream,
    setAiStatus,
  };
}
