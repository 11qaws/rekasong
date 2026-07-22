const MEDIA_SESSION_ACTIONS = Object.freeze([
  'play',
  'pause',
  'nexttrack',
  'seekto',
  'seekbackward',
  'seekforward',
]);

function safeCall(operation) {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function songIdentity(song) {
  if (!song || typeof song !== 'object') return '';
  return [song.id, song.title, song.artist].map((value) => String(value || '')).join('|');
}

export function createSpeakerMediaSessionController({
  mediaSession,
  MediaMetadataClass,
} = {}) {
  let disposed = false;
  let enabled = false;
  let actions = {};
  let position = 0;
  let duration = 0;
  let metadataIdentity = '';
  const installedActions = new Set();

  const seek = (nextPosition) => {
    if (!enabled || typeof actions.onSeek !== 'function' || !(duration > 0)) return;
    actions.onSeek(Math.max(0, Math.min(duration, finiteNumber(nextPosition, position))));
  };

  const handlers = Object.freeze({
    play: () => { if (enabled) actions.onPlay?.(); },
    pause: () => { if (enabled) actions.onPause?.(); },
    nexttrack: () => { if (enabled) actions.onNext?.(); },
    seekto: (detail = {}) => seek(detail.seekTime),
    seekbackward: (detail = {}) => seek(position - finiteNumber(detail.seekOffset, 10)),
    seekforward: (detail = {}) => seek(position + finiteNumber(detail.seekOffset, 10)),
  });

  const clear = () => {
    for (const action of installedActions) {
      safeCall(() => mediaSession.setActionHandler(action, null));
    }
    installedActions.clear();
    safeCall(() => { mediaSession.metadata = null; });
    safeCall(() => { mediaSession.playbackState = 'none'; });
    metadataIdentity = '';
  };

  const install = () => {
    if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return;
    for (const action of MEDIA_SESSION_ACTIONS) {
      const installed = safeCall(() => {
        mediaSession.setActionHandler(action, handlers[action]);
        return true;
      });
      if (installed) installedActions.add(action);
    }
  };

  return Object.freeze({
    update({
      active = false,
      song = null,
      isPlaying = false,
      currentTime = 0,
      mediaDuration = 0,
      callbacks = {},
    } = {}) {
      if (disposed || !mediaSession) return;
      actions = callbacks && typeof callbacks === 'object' ? callbacks : {};
      position = Math.max(0, finiteNumber(currentTime));
      duration = Math.max(0, finiteNumber(mediaDuration));

      if (!active || !song) {
        if (enabled || installedActions.size > 0 || metadataIdentity) clear();
        enabled = false;
        return;
      }

      if (!enabled) install();
      enabled = true;

      const nextIdentity = songIdentity(song);
      if (nextIdentity !== metadataIdentity) {
        metadataIdentity = nextIdentity;
        if (typeof MediaMetadataClass === 'function') {
          safeCall(() => {
            mediaSession.metadata = new MediaMetadataClass({
              title: String(song.title || ''),
              artist: String(song.artist || ''),
              album: 'Rekasong',
            });
          });
        }
      }
      safeCall(() => { mediaSession.playbackState = isPlaying ? 'playing' : 'paused'; });
      if (duration > 0 && typeof mediaSession.setPositionState === 'function') {
        safeCall(() => mediaSession.setPositionState({
          duration,
          playbackRate: 1,
          position: Math.max(0, Math.min(duration, position)),
        }));
      }
    },
    snapshot() {
      return Object.freeze({
        disposed,
        enabled,
        installedActions: Object.freeze([...installedActions]),
        metadataIdentity,
        position,
        duration,
      });
    },
    dispose() {
      if (disposed) return;
      clear();
      enabled = false;
      disposed = true;
      actions = {};
    },
  });
}
