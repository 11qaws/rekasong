import { LYRICS_REPOSITORY_SCHEMA_VERSION } from './lyricsSchema.js';
import { validatePlaybackLyricsPackage } from './lyricsPackage.js';

export const LYRICS_DATABASE_NAME = 'rekasong-lyrics';
export const LYRICS_OBJECT_STORES = Object.freeze([
  'songWorks',
  'trackVersions',
  'lyricDocuments',
  'translationRevisions',
  'tempoMaps',
  'cueSheets',
  'playbackPackages',
  'lyricsSettings',
  'providerCache',
  'quarantine',
]);

const STORE_KEYS = Object.freeze({
  songWorks: 'songWorkId',
  trackVersions: 'trackVersionId',
  lyricDocuments: 'lyricDocumentId',
  translationRevisions: 'translationRevisionId',
  tempoMaps: 'tempoMapId',
  cueSheets: 'cueSheetRevisionId',
  playbackPackages: 'packageId',
  lyricsSettings: 'settingsId',
  providerCache: 'cacheKey',
  quarantine: 'quarantineId',
});

export class LyricsRepositoryError extends Error {
  constructor(code, cause = null) {
    super(code, { cause });
    this.name = 'LyricsRepositoryError';
    this.code = code;
  }
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('indexeddb_transaction_aborted'));
  transaction.onerror = () => reject(transaction.error || new Error('indexeddb_transaction_failed'));
});

function createStore(database, name) {
  const store = database.createObjectStore(name, { keyPath: STORE_KEYS[name] });
  if (['trackVersions', 'lyricDocuments', 'translationRevisions', 'cueSheets'].includes(name)) {
    store.createIndex('songWorkId', 'songWorkId', { unique: false });
  }
  if (name === 'tempoMaps') store.createIndex('trackVersionId', 'trackVersionId', { unique: false });
  if (name === 'playbackPackages') {
    store.createIndex('songWorkId', 'songWorkId', { unique: false });
    store.createIndex('packageHash', 'packageHash', { unique: true });
  }
  if (['lyricDocuments', 'translationRevisions'].includes(name)) {
    store.createIndex('contentHash', 'source.contentHash', { unique: false });
  }
}

export function openLyricsRepository({ indexedDBFactory = globalThis.indexedDB } = {}) {
  if (!indexedDBFactory?.open) {
    return Promise.reject(new LyricsRepositoryError('lyrics_indexeddb_unavailable'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(LYRICS_DATABASE_NAME, LYRICS_REPOSITORY_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of LYRICS_OBJECT_STORES) {
        if (!database.objectStoreNames.contains(storeName)) createStore(database, storeName);
      }
    };
    request.onerror = () => reject(new LyricsRepositoryError('lyrics_indexeddb_open_failed', request.error));
    request.onblocked = () => reject(new LyricsRepositoryError('lyrics_indexeddb_upgrade_blocked'));
    request.onsuccess = () => resolve(createRepositoryApi(request.result));
  });
}

function classifyStorageError(error) {
  return error?.name === 'QuotaExceededError'
    ? new LyricsRepositoryError('lyrics_storage_quota_exceeded', error)
    : new LyricsRepositoryError('lyrics_storage_write_failed', error);
}

function createRepositoryApi(database) {
  const api = {
    async get(storeName, key) {
      const transaction = database.transaction(storeName, 'readonly');
      return requestResult(transaction.objectStore(storeName).get(key));
    },
    async put(storeName, value) {
      try {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(structuredClone(value));
        await transactionDone(transaction);
        return value;
      } catch (error) {
        throw classifyStorageError(error);
      }
    },
    async savePreparationBundle(bundle) {
      const records = [
        ['songWorks', bundle.songWork],
        ['trackVersions', bundle.trackVersion],
        ['lyricDocuments', bundle.lyricDocument],
        ['translationRevisions', bundle.translationRevision],
        ['tempoMaps', bundle.tempoMap],
        ['cueSheets', bundle.cueSheet],
        ['playbackPackages', bundle.playbackPackage],
      ].filter(([, value]) => value);
      const packageValidation = validatePlaybackLyricsPackage(bundle.playbackPackage);
      if (!packageValidation.ok) throw new LyricsRepositoryError('lyrics_package_invalid');
      try {
        const transaction = database.transaction(records.map(([store]) => store), 'readwrite');
        for (const [storeName, value] of records) {
          transaction.objectStore(storeName).put(structuredClone(value));
        }
        await transactionDone(transaction);
        return bundle.playbackPackage;
      } catch (error) {
        throw classifyStorageError(error);
      }
    },
    async findByContentHash(storeName, contentHash) {
      if (!['lyricDocuments', 'translationRevisions'].includes(storeName)) return null;
      const transaction = database.transaction(storeName, 'readonly');
      return requestResult(transaction.objectStore(storeName).index('contentHash').get(contentHash));
    },
    async deleteSongWork(songWorkId) {
      const stores = ['songWorks', 'trackVersions', 'lyricDocuments', 'translationRevisions', 'tempoMaps', 'cueSheets', 'playbackPackages'];
      const transaction = database.transaction(stores, 'readwrite');
      transaction.objectStore('songWorks').delete(songWorkId);
      for (const storeName of stores.filter((name) => !['songWorks', 'tempoMaps'].includes(name))) {
        const store = transaction.objectStore(storeName);
        const range = IDBKeyRange.only(songWorkId);
        const request = store.index('songWorkId').openKeyCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (storeName === 'trackVersions') {
            const tempoStore = transaction.objectStore('tempoMaps');
            const tempoRequest = tempoStore.index('trackVersionId').openKeyCursor(IDBKeyRange.only(cursor.primaryKey));
            tempoRequest.onsuccess = () => {
              const tempoCursor = tempoRequest.result;
              if (!tempoCursor) return;
              tempoStore.delete(tempoCursor.primaryKey);
              tempoCursor.continue();
            };
          }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      await transactionDone(transaction);
    },
    async quarantine(storeName, key, reason) {
      const damaged = await api.get(storeName, key);
      if (damaged === undefined) return false;
      const transaction = database.transaction([storeName, 'quarantine'], 'readwrite');
      transaction.objectStore('quarantine').put({
        quarantineId: crypto.randomUUID(),
        storeName,
        sourceKey: key,
        reason: String(reason || 'invalid_record').slice(0, 160),
        record: damaged,
        quarantinedAt: Date.now(),
      });
      transaction.objectStore(storeName).delete(key);
      await transactionDone(transaction);
      return true;
    },
    async exportBackup() {
      const backup = { schemaVersion: LYRICS_REPOSITORY_SCHEMA_VERSION, exportedAt: Date.now(), stores: {} };
      for (const storeName of LYRICS_OBJECT_STORES.filter((name) => name !== 'quarantine')) {
        const transaction = database.transaction(storeName, 'readonly');
        backup.stores[storeName] = await requestResult(transaction.objectStore(storeName).getAll());
      }
      return backup;
    },
    async importBackup(backup) {
      if (backup?.schemaVersion !== LYRICS_REPOSITORY_SCHEMA_VERSION || !backup.stores) {
        throw new LyricsRepositoryError('lyrics_backup_schema_unsupported');
      }
      const stores = LYRICS_OBJECT_STORES.filter((name) => name !== 'quarantine');
      const transaction = database.transaction(stores, 'readwrite');
      for (const storeName of stores) {
        for (const value of backup.stores[storeName] || []) transaction.objectStore(storeName).put(value);
      }
      await transactionDone(transaction);
    },
    close() {
      database.close();
    },
  };
  return Object.freeze(api);
}
