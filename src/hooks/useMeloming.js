import { useCallback, useEffect, useState } from 'react';

export function useMeloming(channelId) {
  const [songs, setSongs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);

  const fetchSongs = useCallback(async () => {
    if (!channelId) {
      setSongs([]);
      setSource(null);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/meloming?channelId=${encodeURIComponent(channelId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '멜로밍 노래책을 가져오지 못했습니다.');
      setSongs(Array.isArray(data.songs) ? data.songs : []);
      setSource(data.source || null);
    } catch (fetchError) {
      setSongs([]);
      setSource(null);
      setError(fetchError.message || '멜로밍 노래책을 가져오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    fetchSongs();
  }, [fetchSongs]);

  return { songs, isLoading, error, refresh: fetchSongs, source };
}
