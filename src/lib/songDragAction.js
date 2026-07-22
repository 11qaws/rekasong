const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const SONG_DRAG_DATA_TYPE = 'application/x-rekasong-song';

export const SONG_DROP_DESTINATIONS = Object.freeze({
  PLAY: 'play',
  QUEUE: 'queue',
  HISTORY: 'history',
});

export const SONG_DROP_ACTIONS = Object.freeze({
  PLAY_NOW: 'play_now',
  QUEUE_FRONT: 'queue_front',
  QUEUE_END: 'queue_end',
  HISTORY: 'history',
});

const cleanText = (value) => typeof value === 'string' ? value.trim() : '';

/**
 * The drag payload is deliberately a small, page-owned value. It is never
 * serialized into storage or sent to the Worker before a successful drop.
 */
export const normalizeSongDragCandidate = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const id = cleanText(source.id || source.src);
  const title = cleanText(source.title);
  if (!YOUTUBE_ID_PATTERN.test(id) || !title) return null;

  return {
    id,
    title,
    channelTitle: cleanText(source.channelTitle || source.artist),
    tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string') : [],
    source: cleanText(source.source) || 'youtube',
    songbookId: source.songbookId || null,
    skipAiTitleExtraction: source.skipAiTitleExtraction === true,
    mrVerified: source.mrVerified === true,
  };
};

export const stagedItemFromSongDragCandidate = (candidate, stagingId) => {
  const normalized = normalizeSongDragCandidate(candidate);
  if (!normalized || !stagingId) return null;
  return {
    stagingId,
    type: 'youtube',
    src: normalized.id,
    title: normalized.title,
    artist: normalized.channelTitle,
    tags: normalized.tags,
    source: normalized.source,
    songbookId: normalized.songbookId,
    skipAiTitleExtraction: normalized.skipAiTitleExtraction,
    mrVerified: normalized.mrVerified,
  };
};

export const planSongDropAction = ({ destination, hasCurrentSong, prepareKind }) => {
  if (destination === SONG_DROP_DESTINATIONS.HISTORY) return SONG_DROP_ACTIONS.HISTORY;
  if (destination === SONG_DROP_DESTINATIONS.QUEUE) return SONG_DROP_ACTIONS.QUEUE_END;
  if (destination !== SONG_DROP_DESTINATIONS.PLAY) return null;
  return !hasCurrentSong && prepareKind === 'ready'
    ? SONG_DROP_ACTIONS.PLAY_NOW
    : SONG_DROP_ACTIONS.QUEUE_FRONT;
};
