import { useState, useEffect } from 'react';

const STORAGE_KEY = 'karaoke_app_state';

const defaultState = {
  queue: [],
  history: [],
  currentSong: null,
  volume: 100,
  isMuted: false,
  melomingChannelId: '',
  setlinkPublicId: '',
  activeIntegrationTab: 'youtube'
};

export function useSyncState() {
  const [state, setState] = useState(() => {
    try {
      const item = window.localStorage.getItem(STORAGE_KEY);
      const parsed = item ? JSON.parse(item) : null;
      return parsed || defaultState;
    } catch (error) {
      console.warn('Error reading localStorage', error);
      return defaultState;
    }
  });

  // Sync from other tabs
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        setState(JSON.parse(e.newValue));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Set and sync to other tabs
  const setSharedState = (newStateOrUpdater) => {
    setState((prevState) => {
      const nextState = typeof newStateOrUpdater === 'function' ? newStateOrUpdater(prevState) : newStateOrUpdater;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      // Dispatch storage event manually for the same tab (useful if needed, though usually used cross-tab)
      window.dispatchEvent(new Event('local-storage-sync'));
      return nextState;
    });
  };

  // Listen to manual dispatches from the same tab
  useEffect(() => {
    const handleLocalSync = () => {
      const item = window.localStorage.getItem(STORAGE_KEY);
      if (item) setState(JSON.parse(item));
    };
    window.addEventListener('local-storage-sync', handleLocalSync);
    return () => window.removeEventListener('local-storage-sync', handleLocalSync);
  }, []);

  return [state, setSharedState];
}
