import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api';
import { getAppMessage } from '../copy/appMessages.js';

export function useMeloming(channelIdentifier) {
  const [songs, setSongs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const abortRef = useRef(null);
  const requestSequenceRef = useRef(0);

  const fetchSongs = useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    abortRef.current?.abort();

    if (!channelIdentifier) {
      setSongs([]);
      setSource(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/meloming?channel=${encodeURIComponent(channelIdentifier)}`), { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(getAppMessage('search.import.error.melomingFetch'));
      if (requestSequenceRef.current !== requestSequence) return;
      setSongs(Array.isArray(data.songs) ? data.songs : []);
      setSource(data.source || null);
    } catch (fetchError) {
      if (fetchError.name === 'AbortError' || requestSequenceRef.current !== requestSequence) return;
      setSongs([]);
      setSource(null);
      setError(fetchError.message || getAppMessage('search.import.error.melomingFetch'));
    } finally {
      if (requestSequenceRef.current === requestSequence) setIsLoading(false);
    }
  }, [channelIdentifier]);

  useEffect(() => {
    fetchSongs();
    return () => {
      requestSequenceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchSongs]);

  return { songs, isLoading, error, refresh: fetchSongs, source };
}
