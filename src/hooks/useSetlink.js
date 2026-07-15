import { useMemo } from 'react';

// Setlink catalogs are imported explicitly by SearchPanel and passed here.
export function useSetlink(catalog) {
  const songs = useMemo(
    () => (Array.isArray(catalog) ? catalog.filter((song) => song?.title) : []),
    [catalog],
  );

  return {
    songs,
    isLoading: false,
    error: null,
    refresh: () => {},
  };
}
