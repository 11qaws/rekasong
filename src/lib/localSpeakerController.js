import { PLAYBACK_EVIDENCE_TYPES, PlaybackEngine } from './playbackEngine.js';
import {
  annotateSpeakerEvidenceWithIntent,
  observeSpeakerLifecycleSnapshot,
} from './speakerInterruption.js';

export const LOCAL_SPEAKER_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'local_speaker_invalid_configuration',
  INVALID_COMMAND: 'local_speaker_invalid_command',
  NOT_READY: 'local_speaker_not_ready',
});

export class LocalSpeakerControllerError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'LocalSpeakerControllerError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeNotify(callback, payload) {
  try {
    callback?.(payload);
  } catch {
    // UI observers never own the physical audio graph.
  }
}

/**
 * Browser-local speaker transport.
 *
 * Speaker listening deliberately has no server route lease. The Worker is
 * still used to materialize prepared media bytes, but WebSocket ownership,
 * OBS source attestation, and output-candidate proofs cannot pause or detach
 * this audio element. OBS continues to use the strict Protocol v2 path.
 */
export function createLocalSpeakerController({
  audio,
  resolveSource,
  prefetchSources = null,
  onEvidence = null,
  engineFactory = (options) => new PlaybackEngine(options),
} = {}) {
  if (!audio || typeof resolveSource !== 'function'
    || (prefetchSources !== null && typeof prefetchSources !== 'function')
    || (onEvidence !== null && typeof onEvidence !== 'function')
    || typeof engineFactory !== 'function') {
    throw new LocalSpeakerControllerError(
      LOCAL_SPEAKER_CODES.INVALID_CONFIGURATION,
      { field: 'controller_options' },
    );
  }

  let disposed = false;
  let sequence = 0;
  let pendingAutoplayRunId = null;
  let scheduledAutoplayRunId = null;
  let activeSong = null;
  let engine = null;

  const nextCommandId = (kind) => {
    sequence += 1;
    return `local-speaker-${kind}-${sequence}`;
  };

  const reportAutoplayFailure = (runId, error) => {
    safeNotify(onEvidence, Object.freeze({
      type: PLAYBACK_EVIDENCE_TYPES.ERROR,
      runId,
      mediaTime: engine.snapshot().position,
      duration: engine.snapshot().duration,
      code: error?.code || LOCAL_SPEAKER_CODES.INVALID_COMMAND,
      detail: error?.detail || {},
    }));
  };

  const playWhenReady = (evidence) => {
    const annotatedEvidence = annotateSpeakerEvidenceWithIntent(
      evidence,
      engine?.snapshot(),
      { mediaEnded: audio.ended === true },
    );
    safeNotify(onEvidence, annotatedEvidence);
    if (disposed || evidence?.type !== PLAYBACK_EVIDENCE_TYPES.READY
      || evidence.runId !== pendingAutoplayRunId
      || scheduledAutoplayRunId === evidence.runId) return;
    const readyRunId = evidence.runId;
    scheduledAutoplayRunId = readyRunId;
    // PlaybackEngine deliberately rejects commands issued from an evidence
    // observer. Leave that observer frame before PLAY, while retaining the run
    // identity so a pause, stop, replacement load, or dispose can cancel this
    // queued autoplay without letting an old song start later.
    queueMicrotask(() => {
      if (scheduledAutoplayRunId === readyRunId) scheduledAutoplayRunId = null;
      if (disposed || pendingAutoplayRunId !== readyRunId) return;
      pendingAutoplayRunId = null;
      let operation;
      try {
        operation = engine.play({
          commandId: nextCommandId('autoplay'),
          runId: readyRunId,
        });
      } catch (error) {
        reportAutoplayFailure(readyRunId, error);
        return;
      }
      Promise.resolve(operation).catch((error) => {
        reportAutoplayFailure(readyRunId, error);
      });
    });
  };

  engine = engineFactory({ audio, onEvidence: playWhenReady });
  if (!engine || typeof engine.execute !== 'function' || typeof engine.snapshot !== 'function') {
    throw new LocalSpeakerControllerError(
      LOCAL_SPEAKER_CODES.INVALID_CONFIGURATION,
      { field: 'engine' },
    );
  }

  const assertAvailable = () => {
    if (disposed) {
      throw new LocalSpeakerControllerError(LOCAL_SPEAKER_CODES.NOT_READY, {});
    }
  };

  const sendCommand = (command) => {
    assertAvailable();
    if (!isRecord(command) || typeof command.type !== 'string') {
      throw new LocalSpeakerControllerError(LOCAL_SPEAKER_CODES.INVALID_COMMAND, {});
    }
    const runId = command.runId;
    switch (command.type) {
      case 'load': {
        if (typeof runId !== 'string' || !runId || !isRecord(command.song)) {
          throw new LocalSpeakerControllerError(
            LOCAL_SPEAKER_CODES.INVALID_COMMAND,
            { type: command.type },
          );
        }
        activeSong = command.song;
        pendingAutoplayRunId = runId;
        const sourceFactory = ({ signal }) => resolveSource({
          song: command.song,
          payload: Object.freeze({ song: command.song }),
          signal,
        });
        return Promise.resolve(engine.load({
          commandId: nextCommandId('load'),
          runId,
          sourceFactory,
          position: Number.isFinite(command.position) ? command.position : 0,
          volume: Number.isFinite(command.volume) ? command.volume : 100,
        })).catch((error) => {
          if (pendingAutoplayRunId === runId) pendingAutoplayRunId = null;
          if (scheduledAutoplayRunId === runId) scheduledAutoplayRunId = null;
          throw error;
        });
      }
      case 'play':
        pendingAutoplayRunId = null;
        scheduledAutoplayRunId = null;
        return engine.play({ commandId: nextCommandId('play'), runId });
      case 'pause':
        pendingAutoplayRunId = null;
        scheduledAutoplayRunId = null;
        return engine.pause({ commandId: nextCommandId('pause'), runId });
      case 'seek':
        return engine.seek({
          commandId: nextCommandId('seek'),
          runId,
          position: command.position,
        });
      case 'volume':
        return engine.volume({
          commandId: nextCommandId('volume'),
          runId,
          volume: command.volume,
        });
      case 'stop':
        pendingAutoplayRunId = null;
        scheduledAutoplayRunId = null;
        activeSong = null;
        return engine.stop({ commandId: nextCommandId('stop'), runId });
      case 'prefetch':
        return prefetchSources
          ? prefetchSources(Array.isArray(command.videoIds) ? command.videoIds : [])
          : Promise.resolve(Object.freeze({ status: 'unsupported' }));
      default:
        throw new LocalSpeakerControllerError(
          LOCAL_SPEAKER_CODES.INVALID_COMMAND,
          { type: command.type },
        );
    }
  };

  const observePhysicalState = () => {
    assertAvailable();
    const evidence = observeSpeakerLifecycleSnapshot(engine.snapshot(), {
      mediaEnded: audio.ended === true,
    });
    if (evidence) safeNotify(onEvidence, evidence);
    return evidence;
  };

  return Object.freeze({
    sendCommand,
    observePhysicalState,
    snapshot() {
      return Object.freeze({
        ...engine.snapshot(),
        pendingAutoplayRunId,
        scheduledAutoplayRunId,
        activeSong,
        disposed,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingAutoplayRunId = null;
      scheduledAutoplayRunId = null;
      activeSong = null;
      engine.dispose();
    },
  });
}
