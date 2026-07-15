import { useMemo } from 'react';

// The catalogue is fetched explicitly by the SearchPanel and then supplied to
// this hook. Keeping the hook local makes refreshes and persisted snapshots
// deterministic instead of polling Setlink in the background.
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
