import { verifyPlaybackLyricsPackage } from './lyricsPackage.js';
import { createLyricsRuntimeState } from './lyricsRuntimeState.js';

function lyricsAssetUrl(baseUrl, room, token, assetId) {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(room)}/lyrics/${encodeURIComponent(assetId)}`,
    baseUrl,
  );
  url.searchParams.set('token', token);
  return url.toString();
}

export async function fetchPlaybackLyricsPackage({
  baseUrl,
  room,
  token,
  assetId,
  expectedHash,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl || !room || !token || !assetId || !expectedHash || typeof fetchImpl !== 'function') {
    throw new TypeError('lyrics_asset_configuration_invalid');
  }
  const response = await fetchImpl(lyricsAssetUrl(baseUrl, room, token, assetId), {
    method: 'GET',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`lyrics_asset_http_${response.status}`);
  const playbackPackage = await response.json();
  const validation = await verifyPlaybackLyricsPackage(playbackPackage, expectedHash);
  if (!validation.ok) throw new Error(`lyrics_asset_invalid:${validation.errors.join(',')}`);
  return Object.freeze(playbackPackage);
}

export function createLyricsPlaybackController({
  baseUrl,
  room,
  token,
  playerInstanceId,
  fetchPackage = fetchPlaybackLyricsPackage,
  onChange = null,
} = {}) {
  const runtime = createLyricsRuntimeState();
  let activeAbort = null;

  const publish = () => onChange?.(runtime.snapshot());
  const clear = () => {
    activeAbort?.abort();
    activeAbort = null;
    runtime.clear();
    publish();
  };

  return Object.freeze({
    async prepare({ entryId, runId, lyrics } = {}) {
      if (!lyrics) {
        clear();
        return null;
      }
      activeAbort?.abort();
      const requestAbort = new AbortController();
      activeAbort = requestAbort;
      const ticket = runtime.begin({
        entryId,
        runId,
        playerInstanceId,
        packageHash: lyrics.packageHash,
      });
      publish();
      try {
        const playbackPackage = await fetchPackage({
          baseUrl,
          room,
          token,
          assetId: lyrics.assetId,
          expectedHash: lyrics.packageHash,
          signal: requestAbort.signal,
        });
        if (runtime.complete(ticket, playbackPackage)) publish();
        return playbackPackage;
      } catch (error) {
        if (requestAbort.signal.aborted) return null;
        if (runtime.fail(ticket, error?.message || 'lyrics_asset_load_failed')) publish();
        if (lyrics.requireLyrics === true) throw error;
        return null;
      }
    },
    handlePlayerCommand(command) {
      if (command?.type === 'stop' || command?.type === 'emergency_stop') clear();
    },
    clear,
    snapshot: runtime.snapshot,
  });
}
