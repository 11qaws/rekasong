import { useCallback, useEffect, useRef, useState } from 'react';

import { openLyricsRepository } from '../lib/lyrics/lyricsRepository.js';

export default function useLyricsRepository() {
  const repositoryRef = useRef(null);
  const promiseRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [errorCode, setErrorCode] = useState(null);

  const repository = useCallback(async () => {
    if (repositoryRef.current) return repositoryRef.current;
    if (!promiseRef.current) {
      setStatus('opening');
      promiseRef.current = openLyricsRepository()
        .then((value) => {
          repositoryRef.current = value;
          setStatus('ready');
          return value;
        })
        .catch((error) => {
          setStatus('error');
          setErrorCode(error?.code || 'lyrics_indexeddb_open_failed');
          promiseRef.current = null;
          throw error;
        });
    }
    return promiseRef.current;
  }, []);

  useEffect(() => () => repositoryRef.current?.close(), []);

  const savePreparationBundle = useCallback(async (bundle) => (
    (await repository()).savePreparationBundle(bundle)
  ), [repository]);
  const getPlaybackPackage = useCallback(async (packageId) => (
    (await repository()).get('playbackPackages', packageId)
  ), [repository]);
  const exportBackup = useCallback(async () => (await repository()).exportBackup(), [repository]);
  const importBackup = useCallback(async (backup) => (await repository()).importBackup(backup), [repository]);
  const getProviderCache = useCallback(async (cacheKey) => (
    (await repository()).get('providerCache', cacheKey)
  ), [repository]);
  const putProviderCache = useCallback(async (value) => (
    (await repository()).put('providerCache', value)
  ), [repository]);

  return Object.freeze({
    status,
    errorCode,
    savePreparationBundle,
    getPlaybackPackage,
    exportBackup,
    importBackup,
    getProviderCache,
    putProviderCache,
  });
}
