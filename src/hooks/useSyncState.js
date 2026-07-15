import { useState, useEffect } from 'react';

const STORAGE_KEY = 'karaoke_app_state';

const defaultState = {
  queue: [],
  history: [],
  currentSong: null,
  volume: 100,
  isMuted: false,
  melomingChannelId: '',
  setlinkCatalog: [],
  setlinkSourceUrl: '',
  setlinkCatalogMeta: null,
  youtubePlaylistCatalog: [],
  youtubePlaylistSourceUrl: '',
  youtubePlaylistCatalogMeta: null,
  activeIntegrationTab: 'youtube',
  autoPlayNext: false
};

const isPlayableSong = (song) =>
  song &&
  typeof song === 'object' &&
  typeof song.id === 'string' &&
  typeof song.title === 'string' &&
  (song.type === 'youtube' || song.type === 'local') &&
  typeof song.src === 'string' &&
  song.src.length > 0;

const normaliseState = (candidate, { fromStorage = false } = {}) => {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const keepSong = (song) => isPlayableSong(song) && !(fromStorage && song.type === 'local');
  const volume = Number(source.volume);

  return {
    ...defaultState,
    ...source,
    queue: Array.isArray(source.queue) ? source.queue.filter(keepSong) : [],
    history: Array.isArray(source.history) ? source.history.filter(keepSong) : [],
    currentSong: keepSong(source.currentSong) ? source.currentSong : null,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : defaultState.volume,
    isMuted: Boolean(source.isMuted),
    melomingChannelId: typeof source.melomingChannelId === 'string' ? source.melomingChannelId : '',
    setlinkCatalog: Array.isArray(source.setlinkCatalog) ? source.setlinkCatalog : [],
    setlinkSourceUrl: typeof source.setlinkSourceUrl === 'string' ? source.setlinkSourceUrl : '',
    setlinkCatalogMeta: source.setlinkCatalogMeta && typeof source.setlinkCatalogMeta === 'object' ? source.setlinkCatalogMeta : null,
    youtubePlaylistCatalog: Array.isArray(source.youtubePlaylistCatalog) ? source.youtubePlaylistCatalog : [],
    youtubePlaylistSourceUrl: typeof source.youtubePlaylistSourceUrl === 'string' ? source.youtubePlaylistSourceUrl : '',
    youtubePlaylistCatalogMeta: source.youtubePlaylistCatalogMeta && typeof source.youtubePlaylistCatalogMeta === 'object' ? source.youtubePlaylistCatalogMeta : null,
    activeIntegrationTab: ['youtube', 'meloming', 'setlink', 'youtube-playlist'].includes(source.activeIntegrationTab)
      ? source.activeIntegrationTab
      : defaultState.activeIntegrationTab,
    autoPlayNext: Boolean(source.autoPlayNext)
  };
};

const readStoredState = () => {
  try {
    const item = window.localStorage.getItem(STORAGE_KEY);
    return item ? normaliseState(JSON.parse(item), { fromStorage: true }) : defaultState;
  } catch (error) {
    console.warn('Error reading localStorage', error);
    return defaultState;
  }
};

export function useSyncState() {
  const [state, setState] = useState(readStoredState);

  // Sync from other tabs
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          setState(normaliseState(JSON.parse(e.newValue), { fromStorage: true }));
        } catch (error) {
          console.warn('Error reading synced localStorage state', error);
        }
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Set and sync to other tabs
  const setSharedState = (newStateOrUpdater) => {
    setState((prevState) => {
      const candidate = typeof newStateOrUpdater === 'function' ? newStateOrUpdater(prevState) : newStateOrUpdater;
      const nextState = normaliseState(candidate);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      return nextState;
    });
  };

  return [state, setSharedState];
}
