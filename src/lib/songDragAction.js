const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const SONG_DRAG_DATA_TYPE = 'application/x-rekasong-song';

export const SONG_DROP_DESTINATIONS = Object.freeze({
  PLAY: 'play',
  QUEUE: 'queue',
  HISTORY: 'history',
});

export const SONG_DROP_ACTIONS = Object.freeze({
  PLAY_NOW: 'play_now',
  PLAY_WHEN_READY: 'play_when_ready',
  QUEUE_FRONT: 'queue_front',
  QUEUE_END: 'queue_end',
  HISTORY: 'history',
});

export const DEFERRED_SONG_DROP_PLAY_STATES = Object.freeze({
  NONE: 'none',
  WAITING: 'waiting',
  READY: 'ready',
  CANCELLED: 'cancelled',
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

export const planSongDropAction = ({
  destination,
  hasCurrentSong,
  prepareKind,
  outputMode = 'speaker',
  outputReady = true,
}) => {
  if (destination === SONG_DROP_DESTINATIONS.HISTORY) return SONG_DROP_ACTIONS.HISTORY;
  if (destination === SONG_DROP_DESTINATIONS.QUEUE) return SONG_DROP_ACTIONS.QUEUE_END;
  if (destination !== SONG_DROP_DESTINATIONS.PLAY) return null;
  if (hasCurrentSong) return SONG_DROP_ACTIONS.QUEUE_FRONT;
  if (prepareKind === 'ready' && (outputMode !== 'obs' || outputReady)) {
    return SONG_DROP_ACTIONS.PLAY_NOW;
  }
  if (outputMode === 'speaker' && !['blocked', 'unavailable'].includes(prepareKind)) {
    return SONG_DROP_ACTIONS.PLAY_WHEN_READY;
  }
  return SONG_DROP_ACTIONS.QUEUE_FRONT;
};

/**
 * Resolve one tab-local "play this exact prepared song" intent.
 *
 * The first queue position is part of the identity contract: if the user
 * reorders the queue, removes the item, starts something else, or switches
 * output, an old async prepare result must not surprise-start audio later.
 */
export const resolveDeferredSongDropPlay = ({
  intent,
  currentEntry,
  queue,
  prepareKind,
  outputMode,
}) => {
  if (!intent?.entryId || !intent?.sourceId || intent.outputMode !== 'speaker') {
    return { state: DEFERRED_SONG_DROP_PLAY_STATES.NONE, reason: 'missing_intent' };
  }
  if (outputMode !== intent.outputMode) {
    return { state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED, reason: 'output_changed' };
  }
  if (currentEntry) {
    return { state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED, reason: 'current_started' };
  }

  const firstEntry = Array.isArray(queue) ? queue[0] : null;
  if (firstEntry?.entryId !== intent.entryId || firstEntry?.song?.src !== intent.sourceId) {
    return { state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED, reason: 'queue_changed' };
  }
  if (['blocked', 'unavailable'].includes(prepareKind)) {
    return { state: DEFERRED_SONG_DROP_PLAY_STATES.CANCELLED, reason: 'source_unavailable' };
  }
  if (prepareKind === 'ready') {
    return {
      state: DEFERRED_SONG_DROP_PLAY_STATES.READY,
      reason: 'source_ready',
      entry: firstEntry,
    };
  }
  return {
    state: DEFERRED_SONG_DROP_PLAY_STATES.WAITING,
    reason: 'source_preparing',
    entry: firstEntry,
  };
};
