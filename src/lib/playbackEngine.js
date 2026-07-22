/**
 * Browser-independent playback state machine shared by speaker and OBS adapters.
 *
 * The engine owns transport safety and media evidence. Web Audio routing, test
 * fixtures, and analyser telemetry intentionally stay outside this slice. Those
 * integrations can observe source lifetime through the `instrumentation` hooks
 * without changing command semantics.
 */

export const PLAYBACK_COMMAND_TYPES = Object.freeze({
  LOAD: 'load',
  PLAY: 'play',
  PAUSE: 'pause',
  SEEK: 'seek',
  VOLUME: 'volume',
  STOP: 'stop',
  EMERGENCY_STOP: 'emergency_stop',
  DETACH: 'detach',
});

export const PLAYBACK_EVIDENCE_TYPES = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
  POSITION: 'position',
  ENDED: 'ended',
  ERROR: 'error',
});

export const PLAYBACK_ENGINE_CODES = Object.freeze({
  INVALID_AUDIO_ELEMENT: 'invalid_audio_element',
  INVALID_CLOCK: 'invalid_clock',
  INVALID_URL_API: 'invalid_url_api',
  INVALID_CALLBACK: 'invalid_callback',
  OBSERVER_REENTRY: 'observer_reentry',
  MEDIA_OWNERSHIP_CONFLICT: 'media_ownership_conflict',
  DETACH_POSTCONDITION_FAILED: 'detach_postcondition_failed',
  INVALID_COMMAND: 'invalid_command',
  UNKNOWN_COMMAND: 'unknown_command',
  INVALID_IDENTIFIER: 'invalid_identifier',
  COMMAND_ID_CONFLICT: 'command_id_conflict',
  ENGINE_DISPOSED: 'engine_disposed',
  NO_ACTIVE_RUN: 'no_active_run',
  STALE_RUN_IDENTITY: 'stale_run_identity',
  SOURCE_REQUIRED: 'source_required',
  INVALID_SOURCE: 'invalid_source',
  SOURCE_RESOLUTION_FAILED: 'source_resolution_failed',
  OBJECT_URL_CREATE_FAILED: 'object_url_create_failed',
  OBJECT_URL_REVOKE_FAILED: 'object_url_revoke_failed',
  SOURCE_ATTACH_FAILED: 'source_attach_failed',
  MEDIA_OPERATION_FAILED: 'media_operation_failed',
  MEDIA_POSTCONDITION_FAILED: 'media_postcondition_failed',
  PLAY_REJECTED: 'play_rejected',
  INITIAL_SEEK_PENDING: 'initial_seek_pending',
  INITIAL_SEEK_FAILED: 'initial_seek_failed',
  INVALID_POSITION: 'invalid_position',
  INVALID_VOLUME: 'invalid_volume',
  INVALID_HISTORY_LIMIT: 'invalid_history_limit',
  CRITICAL_COMMAND_LIMIT_REACHED: 'critical_command_limit_reached',
});

const COMMAND_TYPE_SET = new Set(Object.values(PLAYBACK_COMMAND_TYPES));
const IDENTIFIER_MAX_LENGTH = 256;
const INITIAL_SEEK_TOLERANCE_SECONDS = 0.05;

const defaultClock = Object.freeze({
  now: () => globalThis.performance?.now?.() ?? Date.now(),
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function causeName(error) {
  return typeof error?.name === 'string' && error.name ? error.name : 'Error';
}

function validateIdentifier(value, field) {
  const invalid = typeof value !== 'string'
    || value.trim().length === 0
    || value !== value.trim()
    || value.length > IDENTIFIER_MAX_LENGTH
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
  if (invalid) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_IDENTIFIER, { field });
  }
  return value;
}

function validatePosition(value, field = 'position') {
  if (!Number.isFinite(value) || value < 0) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_POSITION, {
      field,
      min: 0,
    });
  }
  return value;
}

function validateVolume(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_VOLUME, {
      field: 'volume',
      min: 0,
      max: 100,
    });
  }
  return value;
}

function validateSource(source) {
  if (typeof source === 'string') {
    if (!source) throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_SOURCE, { field: 'source' });
    return Object.freeze({ kind: 'url', url: source });
  }
  if (!isRecord(source)) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_SOURCE, { field: 'source' });
  }
  if (source.kind === 'url' && typeof source.url === 'string' && source.url) {
    return Object.freeze({ kind: 'url', url: source.url });
  }
  if (source.kind === 'blob' && source.blob !== null
    && (typeof source.blob === 'object' || typeof source.blob === 'function')) {
    return Object.freeze({ kind: 'blob', blob: source.blob });
  }
  throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_SOURCE, { field: 'source' });
}

function validateAudioElement(audio) {
  const requiredMethods = [
    'addEventListener',
    'removeEventListener',
    'play',
    'pause',
    'load',
    'setAttribute',
    'getAttribute',
    'removeAttribute',
    'querySelector',
  ];
  const invalidMethods = !audio
    || requiredMethods.some((method) => typeof audio[method] !== 'function');
  let invalidProperties = true;
  if (!invalidMethods) {
    try {
      invalidProperties = !('srcObject' in audio)
        || typeof audio.currentSrc !== 'string'
        || !Number.isSafeInteger(audio.networkState);
    } catch {
      invalidProperties = true;
    }
  }
  if (invalidMethods || invalidProperties) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_AUDIO_ELEMENT, {
      requiredMethods,
      requiredProperties: ['srcObject', 'currentSrc', 'networkState'],
    });
  }
}

function validateClock(clock) {
  if (!clock || typeof clock.now !== 'function') {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CLOCK, { field: 'clock.now' });
  }
  let initial;
  try {
    initial = clock.now();
  } catch {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CLOCK, { field: 'clock.now' });
  }
  if (!Number.isFinite(initial) || initial < 0) {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CLOCK, { field: 'clock.now' });
  }
  return initial;
}

function validateUrlApi(urlApi) {
  if (!urlApi || typeof urlApi.createObjectURL !== 'function'
    || typeof urlApi.revokeObjectURL !== 'function') {
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_URL_API, {
      requiredMethods: ['createObjectURL', 'revokeObjectURL'],
    });
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export class PlaybackEngineError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'PlaybackEngineError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export class PlaybackEngine {
  constructor({
    audio,
    clock = defaultClock,
    urlApi = globalThis.URL,
    onEvidence = () => {},
    instrumentation = {},
    onInstrumentationError = () => {},
    commandHistoryLimit = 256,
    criticalCommandHistoryLimit = 1024,
  } = {}) {
    validateAudioElement(audio);
    const initialTime = validateClock(clock);
    validateUrlApi(urlApi);
    if (typeof onEvidence !== 'function') {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CALLBACK, {
        field: 'onEvidence',
      });
    }
    if (!isRecord(instrumentation)) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CALLBACK, {
        field: 'instrumentation',
      });
    }
    for (const hook of ['onSourceAttached', 'onSourceDetached', 'onEvidence']) {
      if (hasOwn(instrumentation, hook) && typeof instrumentation[hook] !== 'function') {
        throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CALLBACK, {
          field: `instrumentation.${hook}`,
        });
      }
    }
    if (typeof onInstrumentationError !== 'function') {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_CALLBACK, {
        field: 'onInstrumentationError',
      });
    }
    if (!Number.isSafeInteger(commandHistoryLimit) || commandHistoryLimit < 1) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_HISTORY_LIMIT, {
        field: 'commandHistoryLimit',
        min: 1,
      });
    }
    if (!Number.isSafeInteger(criticalCommandHistoryLimit) || criticalCommandHistoryLimit < 1) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_HISTORY_LIMIT, {
        field: 'criticalCommandHistoryLimit',
        min: 1,
      });
    }

    this.audio = audio;
    this.clock = clock;
    this.urlApi = urlApi;
    this.onEvidence = onEvidence;
    this.instrumentation = instrumentation;
    this.onInstrumentationError = onInstrumentationError;
    this.commandHistoryLimit = commandHistoryLimit;
    this.criticalCommandHistoryLimit = criticalCommandHistoryLimit;

    this.generation = 0;
    this.activeRunId = null;
    this.status = 'idle';
    this.sourceAttached = false;
    this.sourceValue = '';
    this.sourceKind = null;
    this.ownedObjectUrl = null;
    this.pendingInitialPosition = 0;
    this.initialSeekState = 'not_required';
    this.canPlayObserved = false;
    this.pendingPlay = null;
    this.pendingSourceController = null;
    this.wantsPlayback = false;
    this.listeners = [];
    this.readyEvidenceGeneration = null;
    this.commandEntries = new Map();
    this.terminalCommandOrder = new Map();
    // Emergency-stop tombstones live for the entire engine lifetime. Unlike
    // ordinary command history, they are never evicted: replaying an old global
    // stop against a later run is more dangerous than rejecting a new command.
    this.criticalCommandEntries = new Map();
    this.objectIdentities = new WeakMap();
    this.nextObjectIdentity = 1;
    this.lastClockValue = initialTime;
    this.disposed = false;
    this.observerDepth = 0;
    this.currentObserverHook = null;

    // A pre-existing autoplay attribute must not turn load into play.
    this.audio.autoplay = false;
  }

  execute(command) {
    const normalized = this.#normalizeCommand(command);
    const fingerprint = this.#commandFingerprint(normalized);
    if (this.observerDepth > 0) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.OBSERVER_REENTRY, {
        hook: this.currentObserverHook,
      });
    }
    const existing = this.commandEntries.get(normalized.commandId)
      ?? this.criticalCommandEntries.get(normalized.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.COMMAND_ID_CONFLICT, {
          commandId: normalized.commandId,
          previousType: existing.type,
          receivedType: normalized.type,
        });
      }
      return existing.promise;
    }
    if (this.disposed) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.ENGINE_DISPOSED, {});
    }
    const critical = normalized.type === PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP;
    if (critical && this.criticalCommandEntries.size >= this.criticalCommandHistoryLimit) {
      const safetyPostcondition = this.#enterCriticalCommandSafetyLock();
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.CRITICAL_COMMAND_LIMIT_REACHED, {
        limit: this.criticalCommandHistoryLimit,
        safetyLocked: true,
        sourceDetached: safetyPostcondition.sourceDetached,
        mediaPaused: safetyPostcondition.mediaPaused,
      });
    }

    let resolveOperation;
    let rejectOperation;
    const promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const registry = critical ? this.criticalCommandEntries : this.commandEntries;
    registry.set(normalized.commandId, {
      type: normalized.type,
      fingerprint,
      promise,
    });
    if (!critical) {
      promise.then(
        () => this.#rememberTerminalCommand(normalized.commandId),
        () => this.#rememberTerminalCommand(normalized.commandId),
      );
    }

    try {
      Promise.resolve(this.#applyCommand(normalized)).then(resolveOperation, rejectOperation);
    } catch (error) {
      rejectOperation(error);
    }
    return promise;
  }

  load(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.LOAD });
  }

  play(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.PLAY });
  }

  pause(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.PAUSE });
  }

  seek(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.SEEK });
  }

  volume(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.VOLUME });
  }

  stop(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.STOP });
  }

  emergencyStop(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP });
  }

  detach(command) {
    return this.execute({ ...command, type: PLAYBACK_COMMAND_TYPES.DETACH });
  }

  snapshot() {
    return Object.freeze({
      generation: this.generation,
      runId: this.activeRunId,
      status: this.status,
      sourceAttached: this.sourceAttached,
      sourceKind: this.sourceKind,
      mediaPaused: Boolean(this.audio.paused),
      position: finiteOrNull(this.audio.currentTime),
      duration: finiteOrNull(this.audio.duration),
      readyState: Number.isSafeInteger(this.audio.readyState) ? this.audio.readyState : null,
      seeking: Boolean(this.audio.seeking),
      volume: finiteOrNull(this.audio.volume),
      pendingPlay: Boolean(this.pendingPlay && !this.pendingPlay.cancelled),
      wantsPlayback: this.wantsPlayback,
      initialSeekState: this.initialSeekState,
      disposed: this.disposed,
    });
  }

  dispose() {
    if (this.disposed) return this.#detachedPostcondition(true);
    this.#advanceGeneration();
    const result = this.#detachPhysical('dispose', true);
    this.activeRunId = null;
    let failure = null;
    try {
      this.#assertDetachedPostcondition(result, 'dispose', true);
    } catch (error) {
      failure = error;
    }
    this.status = failure ? 'error' : 'disposed';
    this.disposed = true;
    this.commandEntries.clear();
    this.terminalCommandOrder.clear();
    this.criticalCommandEntries.clear();
    if (failure) throw failure;
    return Object.freeze({
      ...result,
      generation: this.generation,
    });
  }

  #normalizeCommand(command) {
    if (!isRecord(command)) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_COMMAND, {
        field: 'command',
      });
    }
    if (!COMMAND_TYPE_SET.has(command.type)) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.UNKNOWN_COMMAND, {
        field: 'type',
      });
    }
    const normalized = {
      type: command.type,
      commandId: validateIdentifier(command.commandId, 'commandId'),
    };

    const runRequired = ![
      PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP,
      PLAYBACK_COMMAND_TYPES.DETACH,
    ].includes(command.type);
    if (runRequired || hasOwn(command, 'runId')) {
      normalized.runId = validateIdentifier(command.runId, 'runId');
    }

    if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
      const hasSource = hasOwn(command, 'source');
      const hasSourceFactory = hasOwn(command, 'sourceFactory');
      if (hasSource === hasSourceFactory) {
        throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.SOURCE_REQUIRED, {
          fields: ['source', 'sourceFactory'],
        });
      }
      if (hasSource) normalized.source = validateSource(command.source);
      if (hasSourceFactory) {
        if (typeof command.sourceFactory !== 'function') {
          throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INVALID_SOURCE, {
            field: 'sourceFactory',
          });
        }
        normalized.sourceFactory = command.sourceFactory;
      }
      normalized.position = hasOwn(command, 'position')
        ? validatePosition(command.position)
        : 0;
      normalized.volume = hasOwn(command, 'volume')
        ? validateVolume(command.volume)
        : null;
    } else if (command.type === PLAYBACK_COMMAND_TYPES.SEEK) {
      normalized.position = validatePosition(command.position);
    } else if (command.type === PLAYBACK_COMMAND_TYPES.VOLUME) {
      normalized.volume = validateVolume(command.volume);
    }

    return Object.freeze(normalized);
  }

  #commandFingerprint(command) {
    const parts = [command.type, command.runId ?? ''];
    if (command.type === PLAYBACK_COMMAND_TYPES.LOAD) {
      if (command.sourceFactory) {
        parts.push(`factory:${this.#objectIdentity(command.sourceFactory)}`);
      } else if (command.source.kind === 'url') {
        parts.push(`url:${command.source.url}`);
      } else {
        parts.push(`blob:${this.#objectIdentity(command.source.blob)}`);
      }
      parts.push(`position:${command.position}`, `volume:${command.volume ?? ''}`);
    } else if (command.type === PLAYBACK_COMMAND_TYPES.SEEK) {
      parts.push(`position:${command.position}`);
    } else if (command.type === PLAYBACK_COMMAND_TYPES.VOLUME) {
      parts.push(`volume:${command.volume}`);
    }
    return parts.join('\u0000');
  }

  #objectIdentity(value) {
    let identity = this.objectIdentities.get(value);
    if (!identity) {
      identity = this.nextObjectIdentity;
      this.nextObjectIdentity += 1;
      this.objectIdentities.set(value, identity);
    }
    return identity;
  }

  #assertExclusiveMediaOwnership() {
    let srcObjectPresent = true;
    let sourceChildPresent = true;
    try {
      srcObjectPresent = 'srcObject' in this.audio && this.audio.srcObject !== null;
    } catch {
      srcObjectPresent = true;
    }
    try {
      sourceChildPresent = this.audio.querySelector('source') !== null;
    } catch {
      sourceChildPresent = true;
    }
    if (!srcObjectPresent && !sourceChildPresent) return;

    // A PlaybackEngine instance requires a dedicated media element. Silence an
    // element that violates that contract, but never claim ownership of it.
    this.wantsPlayback = false;
    this.#cancelPendingPlay();
    try {
      this.audio.autoplay = false;
    } catch {
      // The stable ownership error below is the public failure.
    }
    try {
      this.audio.pause();
    } catch {
      // The stable ownership error below is the public failure.
    }
    this.status = 'error';
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.MEDIA_OWNERSHIP_CONFLICT, {
      srcObjectPresent,
      sourceChildPresent,
    });
  }

  async #resolveSourceFactory(sourceFactory, context, signal) {
    let removeAbortListener = () => {};
    const aborted = new Promise((_, reject) => {
      const rejectAbort = () => {
        const error = new Error('source_aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
    });

    let factoryResult;
    try {
      factoryResult = sourceFactory(context);
    } catch (error) {
      removeAbortListener();
      throw error;
    }
    try {
      return await Promise.race([Promise.resolve(factoryResult), aborted]);
    } finally {
      removeAbortListener();
    }
  }

  #abortPendingSourceResolution() {
    const controller = this.pendingSourceController;
    this.pendingSourceController = null;
    if (!controller || controller.signal.aborted) return;
    try {
      controller.abort();
    } catch {
      // Generation fencing still prevents a late source from attaching.
    }
  }

  #enterCriticalCommandSafetyLock() {
    this.#advanceGeneration();
    const postcondition = this.#detachPhysical('critical_command_limit', true);
    this.activeRunId = null;
    this.status = 'error';
    this.disposed = true;
    this.commandEntries.clear();
    this.terminalCommandOrder.clear();
    return postcondition;
  }

  #applyCommand(command) {
    switch (command.type) {
      case PLAYBACK_COMMAND_TYPES.LOAD:
        return this.#load(command);
      case PLAYBACK_COMMAND_TYPES.PLAY:
        return this.#play(command);
      case PLAYBACK_COMMAND_TYPES.PAUSE:
        return this.#pause(command);
      case PLAYBACK_COMMAND_TYPES.SEEK:
        return this.#seek(command);
      case PLAYBACK_COMMAND_TYPES.VOLUME:
        return this.#volume(command);
      case PLAYBACK_COMMAND_TYPES.STOP:
        return this.#stop(command, 'stop');
      case PLAYBACK_COMMAND_TYPES.EMERGENCY_STOP:
        return this.#emergencyStop(command);
      case PLAYBACK_COMMAND_TYPES.DETACH:
        return this.#detach(command);
      default:
        throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.UNKNOWN_COMMAND, {
          field: 'type',
        });
    }
  }

  async #load(command) {
    this.#assertExclusiveMediaOwnership();
    const hadPhysicalSource = this.sourceAttached
      || Boolean(this.audio.getAttribute('src'))
      || Boolean(this.audio.currentSrc);
    this.#advanceGeneration();
    const generation = this.generation;
    const replacementPostcondition = this.#detachPhysical('load_replaced', hadPhysicalSource);
    try {
      this.#assertDetachedPostcondition(
        replacementPostcondition,
        'load_replaced',
        hadPhysicalSource,
      );
    } catch (error) {
      this.activeRunId = null;
      this.status = 'error';
      throw error;
    }
    this.activeRunId = command.runId;
    this.status = 'loading';
    this.pendingInitialPosition = command.position;
    this.initialSeekState = command.position > 0 ? 'waiting_metadata' : 'not_required';
    this.canPlayObserved = false;
    this.readyEvidenceGeneration = null;
    if (command.volume !== null) this.#setVolume(command.volume);

    let source;
    const sourceController = command.sourceFactory ? new AbortController() : null;
    if (sourceController) this.pendingSourceController = sourceController;
    try {
      source = command.sourceFactory
        ? validateSource(await this.#resolveSourceFactory(
          command.sourceFactory,
          Object.freeze({
            runId: command.runId,
            generation,
            signal: sourceController.signal,
          }),
          sourceController.signal,
        ))
        : command.source;
    } catch (error) {
      if (!this.#isCurrent(generation, command.runId)) {
        return this.#supersededResult(command.runId, generation);
      }
      const failure = error instanceof PlaybackEngineError
        ? error
        : new PlaybackEngineError(PLAYBACK_ENGINE_CODES.SOURCE_RESOLUTION_FAILED, {
          causeName: causeName(error),
        });
      this.status = 'error';
      this.#emitError(failure.code, failure.detail, generation, command.runId);
      throw failure;
    } finally {
      if (this.pendingSourceController === sourceController) {
        this.pendingSourceController = null;
      }
    }

    if (!this.#isCurrent(generation, command.runId)) {
      return this.#supersededResult(command.runId, generation);
    }
    try {
      this.#assertExclusiveMediaOwnership();
    } catch (error) {
      this.status = 'error';
      this.#emitError(error.code, error.detail, generation, command.runId);
      throw error;
    }

    let sourceValue = source.url;
    let ownedObjectUrl = null;
    if (source.kind === 'blob') {
      try {
        sourceValue = this.urlApi.createObjectURL(source.blob);
        ownedObjectUrl = sourceValue;
      } catch (error) {
        const failure = new PlaybackEngineError(PLAYBACK_ENGINE_CODES.OBJECT_URL_CREATE_FAILED, {
          causeName: causeName(error),
        });
        this.status = 'error';
        this.#emitError(failure.code, failure.detail, generation, command.runId);
        throw failure;
      }
      if (typeof sourceValue !== 'string' || !sourceValue) {
        const failure = new PlaybackEngineError(PLAYBACK_ENGINE_CODES.OBJECT_URL_CREATE_FAILED, {
          causeName: 'InvalidObjectUrl',
        });
        this.status = 'error';
        this.#emitError(failure.code, failure.detail, generation, command.runId);
        throw failure;
      }
    }

    if (!this.#isCurrent(generation, command.runId)) {
      if (ownedObjectUrl) this.#revokeObjectUrl(ownedObjectUrl, generation, command.runId);
      return this.#supersededResult(command.runId, generation);
    }

    try {
      this.audio.autoplay = false;
      if (typeof this.audio.setAttribute === 'function') {
        this.audio.setAttribute('src', sourceValue);
      } else {
        this.audio.src = sourceValue;
      }
      this.sourceAttached = true;
      this.sourceValue = sourceValue;
      this.sourceKind = source.kind;
      this.ownedObjectUrl = ownedObjectUrl;
      this.#bindMediaEvents(generation, command.runId, sourceValue);
      this.audio.load();
    } catch (error) {
      this.#unbindMediaEvents();
      this.#removeSourceAttribute();
      this.sourceAttached = false;
      this.sourceValue = '';
      this.sourceKind = null;
      this.ownedObjectUrl = null;
      if (ownedObjectUrl) this.#revokeObjectUrl(ownedObjectUrl, generation, command.runId);
      const failure = new PlaybackEngineError(PLAYBACK_ENGINE_CODES.SOURCE_ATTACH_FAILED, {
        causeName: causeName(error),
      });
      this.status = 'error';
      this.#emitError(failure.code, failure.detail, generation, command.runId);
      throw failure;
    }

    this.#callInstrumentation('onSourceAttached', Object.freeze({
      audio: this.audio,
      runId: command.runId,
      generation,
      sourceKind: source.kind,
    }));
    if (!this.#isCurrent(generation, command.runId)) {
      return this.#supersededResult(command.runId, generation, command.commandId);
    }

    return Object.freeze({
      status: 'applied',
      type: command.type,
      commandId: command.commandId,
      runId: command.runId,
      generation,
      postcondition: Object.freeze({
        sourceAttached: this.sourceAttached,
        autoplayStarted: false,
        mediaPaused: Boolean(this.audio.paused),
        initialSeekPending: this.initialSeekState !== 'not_required',
      }),
    });
  }

  #play(command) {
    this.#assertCurrentRun(command.runId);
    if (!this.sourceAttached) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.NO_ACTIVE_RUN, {
        runId: command.runId,
        sourceAttached: false,
      });
    }
    if (this.initialSeekState === 'failed') {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INITIAL_SEEK_FAILED, {
        runId: command.runId,
      });
    }
    if (!['not_required', 'complete'].includes(this.initialSeekState)) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.INITIAL_SEEK_PENDING, {
        runId: command.runId,
        state: this.initialSeekState,
      });
    }
    let resolveCancellation;
    const cancellationPromise = new Promise((resolve) => {
      resolveCancellation = resolve;
    });
    const playAttempt = {
      generation: this.generation,
      runId: command.runId,
      command,
      cancelled: false,
      resolveCancellation,
    };
    const previousPlay = this.pendingPlay;
    this.pendingPlay = playAttempt;
    this.wantsPlayback = true;
    if (previousPlay) this.#cancelPlayAttempt(previousPlay);

    let nativePlayPromise;
    try {
      nativePlayPromise = this.audio.play();
    } catch (error) {
      if (playAttempt.cancelled || !this.#isCurrent(playAttempt.generation, playAttempt.runId)) {
        return cancellationPromise;
      }
      if (this.pendingPlay === playAttempt) {
        this.pendingPlay = null;
        this.wantsPlayback = false;
      }
      const failure = new PlaybackEngineError(PLAYBACK_ENGINE_CODES.PLAY_REJECTED, {
        causeName: causeName(error),
        mediaErrorCode: finiteOrNull(this.audio.error?.code),
      });
      this.status = 'error';
      this.#emitError(failure.code, failure.detail, playAttempt.generation, playAttempt.runId);
      throw failure;
    }

    // Always observe the native promise even when the engine command is cancelled
    // immediately. Its late settlement may otherwise become an unhandled rejection
    // or restart playback after a stop.
    const nativeSettlement = Promise.resolve(nativePlayPromise).then(
      () => {
        if (playAttempt.cancelled
          || !this.#isCurrent(playAttempt.generation, playAttempt.runId)) {
          return this.#cancelledPlayResult(command, playAttempt, true);
        }
        if (this.pendingPlay === playAttempt) this.pendingPlay = null;
        if (this.audio.paused || !this.wantsPlayback) {
          this.wantsPlayback = false;
          this.status = 'error';
          const detail = Object.freeze({
            action: 'play',
            mediaPaused: Boolean(this.audio.paused),
            wantsPlayback: this.wantsPlayback,
          });
          this.#emitError(
            PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
            detail,
            playAttempt.generation,
            playAttempt.runId,
          );
          throw new PlaybackEngineError(
            PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
            detail,
          );
        }
        return Object.freeze({
          status: 'applied',
          type: command.type,
          commandId: command.commandId,
          runId: command.runId,
          generation: playAttempt.generation,
          postcondition: Object.freeze({
            playPromiseResolved: true,
            mediaPaused: Boolean(this.audio.paused),
          }),
        });
      },
      (error) => {
        if (playAttempt.cancelled
          || !this.#isCurrent(playAttempt.generation, playAttempt.runId)) {
          return this.#cancelledPlayResult(command, playAttempt, false);
        }
        if (this.pendingPlay === playAttempt) {
          this.pendingPlay = null;
          this.wantsPlayback = false;
        }
        const failure = new PlaybackEngineError(PLAYBACK_ENGINE_CODES.PLAY_REJECTED, {
          causeName: causeName(error),
          mediaErrorCode: finiteOrNull(this.audio.error?.code),
        });
        this.status = 'error';
        this.#emitError(failure.code, failure.detail, playAttempt.generation, playAttempt.runId);
        throw failure;
      },
    );
    return Promise.race([cancellationPromise, nativeSettlement]);
  }

  #pause(command) {
    this.#assertCurrentRun(command.runId);
    this.wantsPlayback = false;
    this.#cancelPendingPlay();
    this.#mediaOperation('pause', () => this.audio.pause());
    if (!this.audio.paused) {
      this.status = 'error';
      const detail = Object.freeze({
        action: 'pause',
        mediaPaused: false,
      });
      this.#emitError(
        PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
        detail,
        this.generation,
        command.runId,
      );
      throw new PlaybackEngineError(
        PLAYBACK_ENGINE_CODES.MEDIA_POSTCONDITION_FAILED,
        detail,
      );
    }
    return this.#appliedResult(command, {
      mediaPaused: Boolean(this.audio.paused),
      sourceAttached: this.sourceAttached,
    });
  }

  #seek(command) {
    this.#assertCurrentRun(command.runId);
    this.#mediaOperation('seek', () => {
      this.audio.currentTime = command.position;
    });
    return this.#appliedResult(command, {
      position: finiteOrNull(this.audio.currentTime),
    });
  }

  #volume(command) {
    this.#assertCurrentRun(command.runId);
    this.#setVolume(command.volume);
    return this.#appliedResult(command, {
      volume: finiteOrNull(this.audio.volume),
    });
  }

  #stop(command, reason) {
    this.#assertCurrentRun(command.runId);
    const stoppedRunId = this.activeRunId;
    this.#advanceGeneration();
    const postcondition = this.#detachPhysical(reason, true);
    this.activeRunId = null;
    try {
      this.#assertDetachedPostcondition(postcondition, reason, true);
      this.status = 'stopped';
    } catch (error) {
      this.status = 'error';
      throw error;
    }
    return Object.freeze({
      status: 'applied',
      type: command.type,
      commandId: command.commandId,
      runId: stoppedRunId,
      generation: this.generation,
      postcondition,
    });
  }

  #emergencyStop(command) {
    const stoppedRunId = this.activeRunId;
    this.#advanceGeneration();
    const postcondition = this.#detachPhysical('emergency_stop', true);
    this.activeRunId = null;
    try {
      this.#assertDetachedPostcondition(postcondition, 'emergency_stop', true);
      this.status = 'stopped';
    } catch (error) {
      this.status = 'error';
      throw error;
    }
    return Object.freeze({
      status: 'applied',
      type: command.type,
      commandId: command.commandId,
      runId: stoppedRunId,
      generation: this.generation,
      postcondition,
    });
  }

  #detach(command) {
    if (command.runId !== undefined && this.activeRunId !== null) {
      this.#assertCurrentRun(command.runId);
    }
    const detachedRunId = this.activeRunId;
    this.#advanceGeneration();
    const postcondition = this.#detachPhysical('detach', true);
    this.activeRunId = null;
    try {
      this.#assertDetachedPostcondition(postcondition, 'detach', true);
      this.status = 'detached';
    } catch (error) {
      this.status = 'error';
      throw error;
    }
    return Object.freeze({
      status: 'applied',
      type: command.type,
      commandId: command.commandId,
      runId: detachedRunId,
      generation: this.generation,
      postcondition,
    });
  }

  #setVolume(volume) {
    this.#mediaOperation('volume', () => {
      this.audio.volume = volume / 100;
    });
  }

  #mediaOperation(action, operation) {
    try {
      operation();
    } catch (error) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.MEDIA_OPERATION_FAILED, {
        action,
        causeName: causeName(error),
      });
    }
  }

  #assertCurrentRun(runId) {
    if (this.activeRunId === null) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.NO_ACTIVE_RUN, { runId });
    }
    if (runId !== this.activeRunId) {
      throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.STALE_RUN_IDENTITY, {
        expectedRunId: this.activeRunId,
        receivedRunId: runId,
      });
    }
  }

  #advanceGeneration() {
    this.#abortPendingSourceResolution();
    this.generation += 1;
    this.wantsPlayback = false;
    this.#cancelPendingPlay();
    this.#unbindMediaEvents();
    this.readyEvidenceGeneration = null;
    return this.generation;
  }

  #cancelPendingPlay() {
    const pendingPlay = this.pendingPlay;
    this.pendingPlay = null;
    if (pendingPlay) this.#cancelPlayAttempt(pendingPlay);
  }

  #cancelPlayAttempt(playAttempt) {
    if (playAttempt.cancelled) return;
    playAttempt.cancelled = true;
    playAttempt.resolveCancellation(
      this.#cancelledPlayResult(playAttempt.command, playAttempt, false),
    );
  }

  #cancelledPlayResult(command, playAttempt, enforcePhysicalPause) {
    if (enforcePhysicalPause && !this.wantsPlayback) {
      try {
        this.audio.pause();
      } catch {
        // A stale play continuation must not replace the stop/detach result.
      }
    }
    if (this.pendingPlay === playAttempt) this.pendingPlay = null;
    return Object.freeze({
      status: 'cancelled',
      type: command.type,
      commandId: command.commandId,
      runId: command.runId,
      generation: playAttempt.generation,
      postcondition: Object.freeze({
        autoplayCancelled: true,
        mediaPaused: Boolean(this.audio.paused),
        sourceDetached: !this.sourceAttached,
      }),
    });
  }

  #detachPhysical(reason, forceLoad) {
    const detached = {
      runId: this.activeRunId,
      generation: this.generation,
      sourceKind: this.sourceKind,
      reason,
    };
    const hadSource = this.sourceAttached || Boolean(this.ownedObjectUrl);
    const objectUrl = this.ownedObjectUrl;
    let pauseCalled = false;
    let loadCalled = false;
    let objectUrlReleased = !objectUrl;
    let autoplayCancelled = false;

    this.#cancelPendingPlay();
    try {
      this.audio.autoplay = false;
      autoplayCancelled = this.audio.autoplay === false;
    } catch {
      autoplayCancelled = false;
    }
    try {
      this.audio.pause();
      pauseCalled = true;
    } catch {
      // Continue through detach; the returned postcondition remains truthful.
    }
    try {
      if ('srcObject' in this.audio && this.audio.srcObject !== null) {
        this.audio.srcObject = null;
      }
    } catch {
      // The physical ownership fields below report that detachment failed.
    }
    this.#removeSourceAttribute();
    this.sourceAttached = false;
    this.sourceValue = '';
    this.sourceKind = null;
    this.ownedObjectUrl = null;
    this.pendingInitialPosition = 0;
    this.initialSeekState = 'not_required';
    this.canPlayObserved = false;
    if (forceLoad) {
      try {
        this.audio.load();
        loadCalled = true;
      } catch {
        // Continue to object URL release and report loadCalled=false.
      }
    }
    if (objectUrl) {
      objectUrlReleased = this.#revokeObjectUrl(
        objectUrl,
        detached.generation,
        detached.runId,
      );
    }
    if (hadSource) this.#callInstrumentation('onSourceDetached', Object.freeze(detached));

    const physical = this.#physicalDetachState();
    return Object.freeze({
      mediaPaused: Boolean(this.audio.paused),
      sourceDetached: !this.sourceAttached && Object.values(physical).every(Boolean),
      srcAttributeDetached: physical.srcAttributeDetached,
      srcObjectDetached: physical.srcObjectDetached,
      sourceChildrenDetached: physical.sourceChildrenDetached,
      currentSrcDetached: physical.currentSrcDetached,
      networkDetached: physical.networkDetached,
      autoplayCancelled,
      pauseCalled,
      loadCalled,
      objectUrlReleased,
    });
  }

  #detachedPostcondition(objectUrlReleased) {
    const physical = this.#physicalDetachState();
    return Object.freeze({
      mediaPaused: Boolean(this.audio.paused),
      sourceDetached: !this.sourceAttached && Object.values(physical).every(Boolean),
      srcAttributeDetached: physical.srcAttributeDetached,
      srcObjectDetached: physical.srcObjectDetached,
      sourceChildrenDetached: physical.sourceChildrenDetached,
      currentSrcDetached: physical.currentSrcDetached,
      networkDetached: physical.networkDetached,
      autoplayCancelled: this.audio.autoplay === false,
      pauseCalled: false,
      loadCalled: false,
      objectUrlReleased,
    });
  }

  #removeSourceAttribute() {
    try {
      if (typeof this.audio.removeAttribute === 'function') {
        this.audio.removeAttribute('src');
      } else {
        this.audio.src = '';
      }
    } catch {
      try {
        this.audio.src = '';
      } catch {
        // The physical postcondition reports failure if the source remains.
      }
    }
  }

  #physicalDetachState() {
    let srcAttributeDetached = false;
    let srcObjectDetached = false;
    let sourceChildrenDetached = false;
    let currentSrcDetached = false;
    let networkDetached = false;
    try {
      srcAttributeDetached = this.audio.getAttribute('src') === null;
    } catch {
      srcAttributeDetached = false;
    }
    try {
      srcObjectDetached = !('srcObject' in this.audio) || this.audio.srcObject === null;
    } catch {
      srcObjectDetached = false;
    }
    try {
      sourceChildrenDetached = this.audio.querySelector('source') === null;
    } catch {
      sourceChildrenDetached = false;
    }
    try {
      // Chromium retains currentSrc as the last selected URL even after load()
      // reaches NETWORK_EMPTY. It is historical at that point, not an active
      // source, so currentSrc must be interpreted together with networkState.
      networkDetached = this.audio.networkState === 0 || this.audio.networkState === 3;
      const currentSrc = typeof this.audio.currentSrc === 'string'
        ? this.audio.currentSrc
        : this.audio.src;
      currentSrcDetached = !currentSrc || networkDetached;
    } catch {
      currentSrcDetached = false;
      networkDetached = false;
    }
    return Object.freeze({
      srcAttributeDetached,
      srcObjectDetached,
      sourceChildrenDetached,
      currentSrcDetached,
      networkDetached,
    });
  }

  #assertDetachedPostcondition(postcondition, action, requireLoad) {
    const satisfied = postcondition.mediaPaused
      && postcondition.sourceDetached
      && postcondition.autoplayCancelled
      && postcondition.pauseCalled
      && (!requireLoad || postcondition.loadCalled)
      && postcondition.objectUrlReleased;
    if (satisfied) return;
    const detail = Object.freeze({
      action,
      mediaPaused: postcondition.mediaPaused,
      sourceDetached: postcondition.sourceDetached,
      autoplayCancelled: postcondition.autoplayCancelled,
      pauseCalled: postcondition.pauseCalled,
      loadCalled: postcondition.loadCalled,
      objectUrlReleased: postcondition.objectUrlReleased,
      srcAttributeDetached: postcondition.srcAttributeDetached,
      srcObjectDetached: postcondition.srcObjectDetached,
      sourceChildrenDetached: postcondition.sourceChildrenDetached,
      currentSrcDetached: postcondition.currentSrcDetached,
      networkDetached: postcondition.networkDetached,
    });
    this.#emitError(
      PLAYBACK_ENGINE_CODES.DETACH_POSTCONDITION_FAILED,
      detail,
      this.generation,
      this.activeRunId,
    );
    throw new PlaybackEngineError(PLAYBACK_ENGINE_CODES.DETACH_POSTCONDITION_FAILED, detail);
  }

  #revokeObjectUrl(objectUrl, generation, runId) {
    try {
      this.urlApi.revokeObjectURL(objectUrl);
      return true;
    } catch (error) {
      this.#emitError(
        PLAYBACK_ENGINE_CODES.OBJECT_URL_REVOKE_FAILED,
        { causeName: causeName(error) },
        generation,
        runId,
      );
      return false;
    }
  }

  #bindMediaEvents(generation, runId, expectedSource) {
    const bindings = [
      ['loadedmetadata', (event) => this.#handleLoadedMetadata(event, generation, runId, expectedSource)],
      ['canplay', (event) => this.#handleReady(event, generation, runId, expectedSource)],
      ['playing', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.PLAYING, event, generation, runId, expectedSource)],
      ['pause', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.PAUSED, event, generation, runId, expectedSource)],
      ['waiting', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.BUFFERING, event, generation, runId, expectedSource)],
      ['stalled', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.BUFFERING, event, generation, runId, expectedSource)],
      ['timeupdate', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.POSITION, event, generation, runId, expectedSource)],
      ['seeked', (event) => this.#handleSeeked(event, generation, runId, expectedSource)],
      ['ended', (event) => this.#handleMediaEvidence(PLAYBACK_EVIDENCE_TYPES.ENDED, event, generation, runId, expectedSource)],
      ['error', (event) => this.#handleMediaError(event, generation, runId, expectedSource)],
    ];
    for (const [type, listener] of bindings) {
      this.audio.addEventListener(type, listener);
      this.listeners.push([type, listener]);
    }
  }

  #unbindMediaEvents() {
    for (const [type, listener] of this.listeners) {
      this.audio.removeEventListener(type, listener);
    }
    this.listeners = [];
  }

  #handleLoadedMetadata(_event, generation, runId, expectedSource) {
    if (!this.#acceptMediaEvent(generation, runId, expectedSource)) return;
    if (this.initialSeekState !== 'waiting_metadata') return;
    this.initialSeekState = 'waiting_seeked';
    try {
      this.audio.currentTime = this.pendingInitialPosition;
    } catch (error) {
      this.#failInitialSeek(
        { reason: 'assignment_failed', causeName: causeName(error) },
        generation,
        runId,
      );
    }
  }

  #handleReady(_event, generation, runId, expectedSource) {
    if (!this.#acceptMediaEvent(generation, runId, expectedSource)) return;
    if (!Number.isSafeInteger(this.audio.readyState) || this.audio.readyState < 3) return;
    this.canPlayObserved = true;
    this.#maybeEmitReady(generation, runId);
  }

  #handleSeeked(event, generation, runId, expectedSource) {
    if (!this.#acceptMediaEvent(generation, runId, expectedSource)) return;
    if (this.initialSeekState === 'waiting_seeked') {
      const actualPosition = finiteOrNull(this.audio.currentTime);
      const positioned = actualPosition !== null
        && !this.audio.seeking
        && Math.abs(actualPosition - this.pendingInitialPosition)
          <= INITIAL_SEEK_TOLERANCE_SECONDS;
      if (!positioned) {
        this.#failInitialSeek(
          {
            reason: 'position_mismatch',
            expectedPosition: this.pendingInitialPosition,
            actualPosition,
          },
          generation,
          runId,
        );
      } else {
        this.initialSeekState = 'complete';
        this.pendingInitialPosition = 0;
      }
    }
    this.#handleMediaEvidence(
      PLAYBACK_EVIDENCE_TYPES.POSITION,
      event,
      generation,
      runId,
      expectedSource,
    );
    this.#maybeEmitReady(generation, runId);
  }

  #maybeEmitReady(generation, runId) {
    if (!this.canPlayObserved || this.initialSeekState === 'failed') return;
    if (!['not_required', 'complete'].includes(this.initialSeekState)) return;
    if (this.readyEvidenceGeneration === generation) return;
    this.readyEvidenceGeneration = generation;
    if (!this.wantsPlayback || this.audio.paused) this.status = 'ready';
    this.#emitEvidence(PLAYBACK_EVIDENCE_TYPES.READY, generation, runId);
  }

  #failInitialSeek(detail, generation, runId) {
    if (this.initialSeekState === 'failed') return;
    this.initialSeekState = 'failed';
    this.status = 'error';
    this.#emitError(
      PLAYBACK_ENGINE_CODES.INITIAL_SEEK_FAILED,
      detail,
      generation,
      runId,
    );
  }

  #handleMediaEvidence(type, _event, generation, runId, expectedSource) {
    if (!this.#acceptMediaEvent(generation, runId, expectedSource)) return;
    if (type === PLAYBACK_EVIDENCE_TYPES.PLAYING) {
      if (this.audio.paused) return;
      if (!this.wantsPlayback) {
        try {
          this.audio.pause();
        } catch {
          // A later liveness layer reports failure to enforce desired silence.
        }
        return;
      }
    } else if (type === PLAYBACK_EVIDENCE_TYPES.PAUSED) {
      if (!this.audio.paused) return;
      // A physical pause is evidence, not a new command intent. In particular,
      // a queued pause event must not erase a newer play request.
    } else if (type === PLAYBACK_EVIDENCE_TYPES.BUFFERING) {
      if (!this.wantsPlayback || this.audio.paused || this.audio.readyState >= 3) return;
    } else if (type === PLAYBACK_EVIDENCE_TYPES.ENDED) {
      if (this.audio.ended !== true) return;
      this.wantsPlayback = false;
    }
    if (type !== PLAYBACK_EVIDENCE_TYPES.POSITION) this.status = type;
    this.#emitEvidence(type, generation, runId);
  }

  #handleMediaError(_event, generation, runId, expectedSource) {
    if (!this.#acceptMediaEvent(generation, runId, expectedSource)) return;
    if (!this.audio.error) return;
    this.wantsPlayback = false;
    this.status = 'error';
    this.#emitError('media_error', {
      mediaErrorCode: finiteOrNull(this.audio.error?.code),
    }, generation, runId);
  }

  #acceptMediaEvent(generation, runId, expectedSource) {
    return this.#isCurrent(generation, runId)
      && this.sourceAttached
      && this.sourceValue === expectedSource;
  }

  #isCurrent(generation, runId) {
    return this.generation === generation && this.activeRunId === runId && !this.disposed;
  }

  #emitError(code, detail, generation, runId) {
    this.#emitEvidence(
      PLAYBACK_EVIDENCE_TYPES.ERROR,
      generation,
      runId,
      { code, detail: Object.freeze({ ...detail }) },
    );
  }

  #emitEvidence(type, generation, runId, extra = {}) {
    const evidence = Object.freeze({
      type,
      runId,
      generation,
      monotonicTimeMs: this.#clockNow(),
      mediaTime: finiteOrNull(this.audio.currentTime),
      duration: finiteOrNull(this.audio.duration),
      paused: Boolean(this.audio.paused),
      readyState: Number.isSafeInteger(this.audio.readyState) ? this.audio.readyState : null,
      seeking: Boolean(this.audio.seeking),
      sourceAttached: this.sourceAttached,
      ...extra,
    });
    this.#invokeObserver('onEvidence', this.onEvidence, evidence);
    this.#callInstrumentation('onEvidence', evidence);
    return evidence;
  }

  #clockNow() {
    try {
      const value = this.clock.now();
      if (Number.isFinite(value) && value >= 0) {
        this.lastClockValue = Math.max(this.lastClockValue, value);
      }
    } catch {
      // Preserve the last valid monotonic value.
    }
    return this.lastClockValue;
  }

  #callInstrumentation(hook, payload) {
    const observer = this.instrumentation[hook];
    if (!observer) return;
    this.#invokeObserver(`instrumentation.${hook}`, observer, payload);
  }

  #invokeObserver(hook, observer, payload) {
    const previousHook = this.currentObserverHook;
    this.observerDepth += 1;
    this.currentObserverHook = hook;
    let result;
    try {
      result = observer(payload);
    } catch (error) {
      this.#reportInstrumentationError(hook, error);
    } finally {
      this.observerDepth -= 1;
      this.currentObserverHook = previousHook;
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch((error) => {
        this.#reportInstrumentationError(hook, error);
      });
    }
  }

  #reportInstrumentationError(hook, error) {
    const report = Object.freeze({
      code: 'observer_callback_failed',
      hook,
      causeName: causeName(error),
      callbackCode: typeof error?.code === 'string' ? error.code : null,
    });
    const previousHook = this.currentObserverHook;
    this.observerDepth += 1;
    this.currentObserverHook = 'onInstrumentationError';
    let result;
    try {
      result = this.onInstrumentationError(report);
    } catch {
      return;
    } finally {
      this.observerDepth -= 1;
      this.currentObserverHook = previousHook;
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
    }
  }

  #appliedResult(command, postcondition) {
    return Object.freeze({
      status: 'applied',
      type: command.type,
      commandId: command.commandId,
      runId: command.runId ?? this.activeRunId,
      generation: this.generation,
      postcondition: Object.freeze({ ...postcondition }),
    });
  }

  #supersededResult(runId, generation, commandId = undefined) {
    return Object.freeze({
      status: 'superseded',
      type: PLAYBACK_COMMAND_TYPES.LOAD,
      commandId,
      runId,
      generation,
      postcondition: Object.freeze({
        sourceAttached: false,
        autoplayStarted: false,
      }),
    });
  }

  #rememberTerminalCommand(commandId) {
    if (!this.commandEntries.has(commandId)) return;
    this.terminalCommandOrder.delete(commandId);
    this.terminalCommandOrder.set(commandId, true);
    while (this.terminalCommandOrder.size > this.commandHistoryLimit) {
      const oldestCommandId = this.terminalCommandOrder.keys().next().value;
      this.terminalCommandOrder.delete(oldestCommandId);
      this.commandEntries.delete(oldestCommandId);
    }
  }
}
