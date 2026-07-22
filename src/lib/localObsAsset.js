const validAssetId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

export const localSongNeedsObsAsset = (song) => Boolean(
  song?.type === 'local'
  && typeof song.src === 'string'
  && song.src.startsWith('blob:')
  && !validAssetId(song.assetId)
);

export function attachObsAssetToLocalSong(song, { src, assetId } = {}) {
  if (!localSongNeedsObsAsset(song) || song.src !== src || !validAssetId(assetId)) return song;
  return { ...song, assetId };
}

export function attachObsAssetToPlaybackState(state, attachment) {
  if (!state || typeof state !== 'object') return state;
  let changed = false;
  const updateEntry = (entry) => {
    if (!entry?.song) return entry;
    const song = attachObsAssetToLocalSong(entry.song, attachment);
    if (song === entry.song) return entry;
    changed = true;
    return { ...entry, song };
  };
  const queue = (Array.isArray(state.queue) ? state.queue : []).map(updateEntry);
  const history = (Array.isArray(state.history) ? state.history : []).map(updateEntry);
  const currentEntry = updateEntry(state.currentEntry);
  return changed ? { ...state, queue, history, currentEntry } : state;
}

export function collectLocalObsAssetCandidates(state) {
  const candidates = [];
  const seen = new Set();
  const add = (entry) => {
    const song = entry?.song;
    if (!localSongNeedsObsAsset(song) || seen.has(song.src)) return;
    seen.add(song.src);
    candidates.push(song);
  };
  add(state?.currentEntry);
  (Array.isArray(state?.queue) ? state.queue : []).forEach(add);
  return candidates;
}
