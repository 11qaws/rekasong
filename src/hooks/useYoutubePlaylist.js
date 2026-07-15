import { useMemo } from 'react';

export function useYoutubePlaylist(catalog) {
  const songs = useMemo(
    () => (Array.isArray(catalog) ? catalog.filter((song) => song?.title) : []),
    [catalog],
  );
  return { songs, isLoading: false, error: null, refresh: () => {} };
}
