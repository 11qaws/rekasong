import {
  ON_AIR_MESSAGE_FAMILIES,
  ON_AIR_MESSAGE_TYPES,
  ON_AIR_PROTOCOL_VERSION,
  ON_AIR_SEQUENCE_NAMESPACES,
  ROUTE_COMMAND_TYPES,
  SERVER_MESSAGE_TYPES,
  getOnAirMessageFamily,
  validateOnAirMessage,
  validateOnAirPlayerCommand,
} from './onAirProtocol.js';
import {
  ON_AIR_CLIENT_STATE_CODES,
  OnAirCommandLedger,
  OnAirPlayerCommandLedger,
  OnAirPlayerEventOutbox,
  OnAirSequenceCounters,
  createControlPageIdentity,
  createPlayerPageIdentity,
} from './onAirClientState.js';

/**
 * Browser-independent WebSocket transport for On-Air Protocol v2.
 *
 * The core owns one page-lifetime identity, command/event reliability state,
 * and monotonically increasing player sequences. A WebSocket, clock, and
 * interval scheduler are injected so browser and deterministic test adapters
 * use the same state machine.
 */

export const ON_AIR_V2_CONNECTION_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  NEGOTIATING: 'negotiating',
  NEGOTIATION_EXTENSION: 'negotiation_extension',
  READY: 'ready',
  DISCONNECTED: 'disconnected',
  SUPERSEDED: 'superseded',
  CLOSED: 'closed',
});

export const ON_AIR_V2_CONNECTION_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'v2_connection_invalid_configuration',
  INVALID_STATE: 'v2_connection_invalid_state',
  INVALID_FRAME_ENCODING: 'v2_connection_invalid_frame_encoding',
  INVALID_FRAME_JSON: 'v2_connection_invalid_frame_json',
  INVALID_PROTOCOL_FRAME: 'v2_connection_invalid_protocol_frame',
  INVALID_OUTBOUND_FRAME: 'v2_connection_invalid_outbound_frame',
  STALE_SOCKET_FRAME: 'v2_connection_stale_socket_frame',
  SUPERSEDED_SOCKET_FRAME: 'v2_connection_superseded_socket_frame',
  FRAME_BEFORE_NEGOTIATION: 'v2_connection_frame_before_negotiation',
  UNEXPECTED_WELCOME: 'v2_connection_unexpected_welcome',
  FOREIGN_WELCOME_IDENTITY: 'v2_connection_foreign_welcome_identity',
  FOREIGN_TARGET_CONNECTION: 'v2_connection_foreign_target_connection',
  FOREIGN_TARGET_PLAYER: 'v2_connection_foreign_target_player',
  SOCKET_NOT_OPEN: 'v2_connection_socket_not_open',
  SOCKET_FACTORY_FAILED: 'v2_connection_socket_factory_failed',
  SOCKET_SEND_FAILED: 'v2_connection_socket_send_failed',
  SOCKET_ERROR: 'v2_connection_socket_error',
  SOCKET_CLOSED: 'v2_connection_socket_closed',
  CONNECTION_SUPERSEDED: 'v2_connection_superseded',
  CALLBACK_FAILED: 'v2_connection_callback_failed',
  HEARTBEAT_GENERATION_FAILED: 'v2_connection_heartbeat_generation_failed',
  HEARTBEAT_ACK_UNEXPECTED_ROLE: 'v2_connection_heartbeat_ack_unexpected_role',
  HEARTBEAT_ACK_FOREIGN_PLAYER: 'v2_connection_heartbeat_ack_foreign_player',
  HEARTBEAT_ACK_FOREIGN_CONNECTION: 'v2_connection_heartbeat_ack_foreign_connection',
  HEARTBEAT_ACK_FUTURE_SEQUENCE: 'v2_connection_heartbeat_ack_future_sequence',
  HEARTBEAT_ACK_DUPLICATE: 'v2_connection_heartbeat_ack_duplicate',
  HEARTBEAT_ACK_OUT_OF_ORDER: 'v2_connection_heartbeat_ack_out_of_order',
  COMMAND_RESULT_IGNORED: 'v2_connection_command_result_ignored',
  EVENT_RESULT_IGNORED: 'v2_connection_event_result_ignored',
  STALE_PLAYER_LEASE_EPOCH: 'v2_connection_stale_player_lease_epoch',
  INVALID_PLAYER_LEASE_ADVANCE: 'v2_connection_invalid_player_lease_advance',
  PLAYER_COMMAND_DUPLICATE: 'v2_connection_player_command_duplicate',
  PLAYER_COMMAND_ID_CONFLICT: 'v2_connection_player_command_id_conflict',
  PLAYER_COMMAND_HISTORY_EXHAUSTED: 'v2_connection_player_command_history_exhausted',
  STALE_NEGOTIATION_COMPLETION: 'v2_connection_stale_negotiation_completion',
});

// Protocol tests keep the historical 250ms default, while production players
// choose a slower cadence by client kind. Heartbeats are liveness hints, not
// an audio clock; four frames per second from every idle source needlessly
// consumes the Worker WebSocket message budget.
export const ON_AIR_V2_HEARTBEAT_INTERVAL_MS = 250;
export const ON_AIR_V2_OBS_HEARTBEAT_INTERVAL_MS = 1_000;
export const ON_AIR_V2_SPEAKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const ON_AIR_V2_LIVENESS_WARNING_MS = 500;
export const ON_AIR_V2_LIVENESS_UNKNOWN_MS = 2_000;

const PLAYER_COMMAND_FAMILIES = new Set([
  ON_AIR_MESSAGE_FAMILIES.RUN_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.ROUTE_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.TEST_COMMAND,
  ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND,
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value) {
  if (value === undefined) return null;
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function validationDetail(validation) {
  return {
    family: validation.family,
    errors: validation.errors.map(({ path, code }) => ({ path, code })),
  };
}

function safeErrorDetail(error) {
  if (error && typeof error === 'object') {
    const detail = isRecord(error.detail) ? error.detail : {};
    return {
      errorCode: typeof error.code === 'string' ? error.code : null,
      errorName: typeof error.name === 'string' ? error.name : 'Error',
      detail,
    };
  }
  return { errorCode: null, errorName: typeof error, detail: {} };
}

function requireConfiguration(condition, field, kind) {
  if (!condition) {
    throw new OnAirV2ConnectionError(
      ON_AIR_V2_CONNECTION_CODES.INVALID_CONFIGURATION,
      { field, kind },
    );
  }
}

function createDefaultNow() {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now.bind(globalThis.performance);
  }
  let last = Math.max(0, Date.now());
  return () => {
    last = Math.max(last, Date.now());
    return last;
  };
}

export class OnAirV2ConnectionError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OnAirV2ConnectionError';
    this.code = code;
    this.detail = immutableJson(detail);
  }
}

/**
 * One instance must live for the whole page lifetime. Calling connect() again
 * replaces only the socket generation; it does not replace identity, sequence,
 * command-ledger, or event-outbox state.
 */
export class OnAirV2Connection {
  #role;
  #url;
  #webSocketFactory;
  #now;
  #setInterval;
  #clearInterval;
  #buildId;
  #capabilities;
  #clientKind;
  #runtime;
  #identity;
  #state = ON_AIR_V2_CONNECTION_STATES.IDLE;
  #generationNumber = 0;
  #generation = null;
  #connectionId = null;
  #welcome = null;
  #leaseEpoch = 0;
  #lastEvidenceAt = null;
  #lastObservedNow = 0;
  #heartbeatTimer = null;
  #heartbeatIntervalMs = ON_AIR_V2_HEARTBEAT_INTERVAL_MS;
  #heartbeatLastSentSequence = null;
  #heartbeatLastAckSequence = null;
  #heartbeatLastAckAt = null;
  #sequenceCounters;
  #commandLedger;
  #playerCommandLedger;
  #eventOutbox;
  #diagnostics = [];
  #diagnosticLimit;
  #callbacks;

  constructor({
    role,
    url,
    webSocketFactory,
    now = createDefaultNow(),
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
    idFactory,
    identity,
    buildId,
    capabilities = {},
    clientKind = null,
    runtime = {},
    commandHistoryLimit = 256,
    commandPendingCapacity = 256,
    playerCommandHistoryLimit = 256,
    eventCapacity = 256,
    eventHistoryLimit = 256,
    diagnosticLimit = 64,
    heartbeatPayload = null,
    heartbeatIntervalMs = ON_AIR_V2_HEARTBEAT_INTERVAL_MS,
    onPlayerCommand = null,
    onFrame = null,
    onCommandResult = null,
    onEventResult = null,
    onDiagnostic = null,
    onStateChange = null,
    onNegotiated = null,
    onNegotiationExtension = null,
  } = {}) {
    requireConfiguration(role === 'control' || role === 'player', 'role', 'control_or_player');
    requireConfiguration(typeof url === 'string' && url.trim().length > 0, 'url', 'non_empty_string');
    requireConfiguration(typeof webSocketFactory === 'function', 'webSocketFactory', 'function');
    requireConfiguration(typeof now === 'function', 'now', 'function');
    requireConfiguration(typeof setIntervalFn === 'function', 'setIntervalFn', 'function');
    requireConfiguration(typeof clearIntervalFn === 'function', 'clearIntervalFn', 'function');
    requireConfiguration(typeof buildId === 'string' && buildId.trim().length > 0, 'buildId', 'identifier');
    requireConfiguration(isRecord(capabilities), 'capabilities', 'record');
    requireConfiguration(isRecord(runtime), 'runtime', 'record');
    requireConfiguration(Number.isSafeInteger(diagnosticLimit) && diagnosticLimit > 0, 'diagnosticLimit', 'positive_safe_integer');
    requireConfiguration(Number.isSafeInteger(heartbeatIntervalMs) && heartbeatIntervalMs >= 250,
      'heartbeatIntervalMs', 'safe_integer_at_least_250');
    if (role === 'player') {
      requireConfiguration(typeof clientKind === 'string' && clientKind.length > 0, 'clientKind', 'identifier');
    }

    this.#role = role;
    this.#url = url;
    this.#webSocketFactory = webSocketFactory;
    this.#now = () => this.#observeNow(now());
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
    this.#buildId = buildId;
    this.#capabilities = immutableJson(capabilities);
    this.#clientKind = clientKind;
    this.#runtime = immutableJson(runtime);
    this.#diagnosticLimit = diagnosticLimit;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#callbacks = {
      heartbeatPayload,
      onPlayerCommand,
      onFrame,
      onCommandResult,
      onEventResult,
      onDiagnostic,
      onStateChange,
      onNegotiated,
      onNegotiationExtension,
    };

    const identityOptions = idFactory === undefined ? {} : { idFactory };
    this.#identity = immutableJson(identity ?? (
      role === 'player'
        ? createPlayerPageIdentity(identityOptions)
        : createControlPageIdentity(identityOptions)
    ));

    this.#sequenceCounters = new OnAirSequenceCounters();
    this.#commandLedger = role === 'control'
      ? new OnAirCommandLedger({
          idFactory,
          historyLimit: commandHistoryLimit,
          pendingCapacity: commandPendingCapacity,
        })
      : null;
    this.#playerCommandLedger = role === 'player'
      ? new OnAirPlayerCommandLedger({ historyLimit: playerCommandHistoryLimit })
      : null;
    this.#eventOutbox = role === 'player'
      ? new OnAirPlayerEventOutbox({
        idFactory,
        sequenceCounters: this.#sequenceCounters,
        capacity: eventCapacity,
        historyLimit: eventHistoryLimit,
      })
      : null;

    const helloValidation = validateOnAirMessage(this.#helloFrame());
    requireConfiguration(helloValidation.ok, 'identity_or_hello', 'valid_protocol_hello');
  }

  get role() {
    return this.#role;
  }

  get identity() {
    return this.#identity;
  }

  get state() {
    return this.#state;
  }

  get connectionId() {
    return this.#connectionId;
  }

  get commandLedger() {
    return this.#commandLedger;
  }

  get eventOutbox() {
    return this.#eventOutbox;
  }

  get playerCommandLedger() {
    return this.#playerCommandLedger;
  }

  /** Start or replace a socket generation. Replacing a control socket is ambiguous by design. */
  connect() {
    if (this.#generation) {
      const priorSocket = this.#generation.socket;
      this.#retireGeneration('connection_replaced');
      if (typeof priorSocket?.close === 'function') {
        try {
          priorSocket.close(4000, 'connection_replaced');
        } catch {
          // The retired generation is already fenced even if its adapter cannot close.
        }
      }
    }

    const generation = {
      number: this.#generationNumber + 1,
      socket: null,
      retired: false,
      disconnected: false,
      superseded: false,
    };
    this.#generationNumber = generation.number;
    this.#generation = generation;
    this.#connectionId = null;
    this.#welcome = null;
    this.#lastEvidenceAt = null;
    this.#resetHeartbeatRoundTrip();
    this.#setState(ON_AIR_V2_CONNECTION_STATES.CONNECTING, { generation: generation.number });

    let socket;
    try {
      socket = this.#webSocketFactory(this.#url, {
        role: this.#role,
        generation: generation.number,
      });
    } catch (error) {
      generation.disconnected = true;
      this.#setState(ON_AIR_V2_CONNECTION_STATES.DISCONNECTED, { generation: generation.number });
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.SOCKET_FACTORY_FAILED,
        safeErrorDetail(error),
      );
    }
    requireConfiguration(socket && typeof socket === 'object', 'webSocketFactory', 'socket_object');
    requireConfiguration(typeof socket.send === 'function', 'socket.send', 'function');
    generation.socket = socket;
    this.#attachSocket(generation);
    return generation.number;
  }

  /** Close the current transport while retaining page-lifetime terminal history. */
  close(code, reason) {
    if (this.#generation) {
      this.#retireGeneration('connection_closed');
      const socket = this.#generation.socket;
      if (typeof socket?.close === 'function') {
        try {
          socket.close(code, reason);
        } catch {
          // Local close is already fenced; a socket adapter failure cannot reopen it.
        }
      }
    }
    this.#connectionId = null;
    this.#welcome = null;
    this.#lastEvidenceAt = null;
    this.#resetHeartbeatRoundTrip();
    this.#setState(ON_AIR_V2_CONNECTION_STATES.CLOSED, {});
  }

  /**
   * Reserved negotiation extension point for a future validated resume flow.
   * The current v2 wire sends no resume token and completes immediately unless
   * onNegotiationExtension explicitly returns { defer: true }.
   */
  completeNegotiation() {
    if (this.#state !== ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_STATE,
        { operation: 'completeNegotiation', state: this.#state },
      );
    }
    this.#finishNegotiation(this.#generation);
  }

  /** Create, ledger, and send a control command. Commands are never auto-resend candidates. */
  requestCommand(command, options = {}) {
    this.#requireRoleAndReady('control', 'requestCommand');
    const validationCandidate = isRecord(command)
      ? {
          ...command,
          commandId: options.commandId ?? command.commandId ?? 'client-validation-command',
        }
      : command;
    const previewValidation = validateOnAirMessage(validationCandidate);
    if (!previewValidation.ok) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME,
        validationDetail(previewValidation),
      );
    }
    const result = this.#commandLedger.request(command, options);
    if (!result.retryAllowed) return result;

    const validation = validateOnAirMessage(result.entry.command);
    if (!validation.ok) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME,
        validationDetail(validation),
      );
    }
    if (!this.#sendWire(result.entry.command)) {
      this.#disconnectCurrent('command_send_failed');
      const settled = this.#commandLedger.get(result.entry.commandId);
      return Object.freeze({
        status: 'outcome_unknown',
        entry: settled,
        retryAllowed: false,
      });
    }
    return result;
  }

  /** Queue and send one ACKed player event on the current concrete connection. */
  emitEvent(draft) {
    this.#requireRoleAndReady('player', 'emitEvent');
    if (draft?.playerInstanceId !== undefined
      && draft.playerInstanceId !== this.#identity.playerInstanceId) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME,
        { field: 'playerInstanceId', code: 'identity_mismatch' },
      );
    }
    if (draft?.connectionId !== undefined && draft.connectionId !== this.#connectionId) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME,
        { field: 'connectionId', code: 'connection_mismatch' },
      );
    }
    const result = this.#eventOutbox.enqueue({
      ...draft,
      playerInstanceId: this.#identity.playerInstanceId,
      connectionId: this.#connectionId,
    }, { connectionId: this.#connectionId });
    if (result.retryAllowed && !this.#sendWire(result.entry.message)) {
      this.#disconnectCurrent('event_send_failed');
      const settled = this.#eventOutbox.get(result.entry.eventId);
      if (settled?.state === 'outcome_unknown') {
        return Object.freeze({
          status: 'outcome_unknown',
          entry: settled,
          retryAllowed: false,
        });
      }
    }
    return result;
  }

  /**
   * Tombstone exact caller-owned event IDs without requiring or mutating a
   * socket. This is intentionally available while disconnected so a
   * terminalized local operation cannot leak stale events into reconnect.
   */
  abandonEvents(eventIds, options = {}) {
    if (this.#role !== 'player') {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_STATE,
        { operation: 'abandonEvents', role: this.#role, state: this.#state },
      );
    }
    return this.#eventOutbox.abandonEvents(eventIds, options);
  }

  /** Derive liveness solely from trusted current-generation inbound evidence. */
  livenessSnapshot(at = this.#now()) {
    const observedAt = this.#observeNow(at);
    const ready = this.#state === ON_AIR_V2_CONNECTION_STATES.READY;
    if (!ready || !Number.isFinite(this.#lastEvidenceAt)) {
      return Object.freeze({
        state: 'unknown',
        warning: false,
        unknown: true,
        ageMs: null,
        code: 'transport_not_ready',
      });
    }
    const ageMs = Math.max(0, observedAt - this.#lastEvidenceAt);
    if (ageMs >= ON_AIR_V2_LIVENESS_UNKNOWN_MS) {
      return Object.freeze({
        state: 'unknown', warning: false, unknown: true, ageMs, code: 'liveness_unknown',
      });
    }
    if (ageMs >= ON_AIR_V2_LIVENESS_WARNING_MS) {
      return Object.freeze({
        state: 'warning', warning: true, unknown: false, ageMs, code: 'liveness_warning',
      });
    }
    return Object.freeze({
      state: 'healthy', warning: false, unknown: false, ageMs, code: 'liveness_healthy',
    });
  }

  snapshot() {
    return Object.freeze({
      role: this.#role,
      state: this.#state,
      generation: this.#generation?.number ?? 0,
      connectionId: this.#connectionId,
      leaseEpoch: this.#role === 'player' ? this.#leaseEpoch : null,
      identity: this.#identity,
      welcome: this.#welcome,
      liveness: this.livenessSnapshot(),
      heartbeatRoundTrip: Object.freeze({
        lastSentSequence: this.#heartbeatLastSentSequence,
        lastAckSequence: this.#heartbeatLastAckSequence,
        lastAckAt: this.#heartbeatLastAckAt,
      }),
      sequences: this.#sequenceCounters.snapshot(),
      commands: this.#commandLedger?.snapshot() ?? null,
      inboundCommands: this.#playerCommandLedger?.snapshot() ?? null,
      events: this.#eventOutbox?.snapshot() ?? null,
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  #helloFrame() {
    if (this.#role === 'player') {
      return {
        type: ON_AIR_MESSAGE_TYPES.PLAYER_HELLO,
        protocolVersion: ON_AIR_PROTOCOL_VERSION,
        playerInstanceId: this.#identity.playerInstanceId,
        buildId: this.#buildId,
        clientKind: this.#clientKind,
        capabilities: this.#capabilities,
        runtime: this.#runtime,
      };
    }
    return {
      type: ON_AIR_MESSAGE_TYPES.CONTROL_HELLO,
      protocolVersion: ON_AIR_PROTOCOL_VERSION,
      controlInstanceId: this.#identity.controlInstanceId,
      buildId: this.#buildId,
      capabilities: this.#capabilities,
    };
  }

  #attachSocket(generation) {
    const handlers = {
      open: () => this.#handleOpen(generation),
      message: (event) => this.#handleMessage(generation, event),
      close: (event) => this.#handleClose(generation, event),
      error: (event) => this.#handleError(generation, event),
    };
    if (typeof generation.socket.addEventListener === 'function') {
      for (const [type, handler] of Object.entries(handlers)) {
        generation.socket.addEventListener(type, handler);
      }
      return;
    }
    generation.socket.onopen = handlers.open;
    generation.socket.onmessage = handlers.message;
    generation.socket.onclose = handlers.close;
    generation.socket.onerror = handlers.error;
  }

  #handleOpen(generation) {
    if (!this.#isCurrent(generation)) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME, {
        phase: 'open', generation: generation.number,
      });
      return;
    }
    this.#setState(ON_AIR_V2_CONNECTION_STATES.NEGOTIATING, { generation: generation.number });
    const hello = this.#helloFrame();
    const validation = validateOnAirMessage(hello);
    if (!validation.ok) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME, validationDetail(validation));
      this.#disconnectCurrent('invalid_hello');
      return;
    }
    if (!this.#sendWire(hello)) this.#disconnectCurrent('hello_send_failed');
  }

  #handleMessage(generation, event) {
    if (generation.superseded) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.SUPERSEDED_SOCKET_FRAME, {
        generation: generation.number,
      });
      return;
    }
    if (!this.#isCurrent(generation)) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.STALE_SOCKET_FRAME, {
        generation: generation.number,
        currentGeneration: this.#generation?.number ?? null,
      });
      return;
    }

    const parsed = this.#parseInbound(event?.data);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    const family = getOnAirMessageFamily(frame);
    const playerCommand = this.#role === 'player' && PLAYER_COMMAND_FAMILIES.has(family);
    const validation = playerCommand
      ? validateOnAirPlayerCommand(frame)
      : validateOnAirMessage(frame);
    if (!validation.ok) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_PROTOCOL_FRAME, validationDetail(validation));
      return;
    }

    if (family === ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME
      || family === ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME) {
      this.#handleWelcome(generation, frame, family);
      return;
    }
    if (frame.type === SERVER_MESSAGE_TYPES.CONNECTION_SUPERSEDED) {
      this.#handleSuperseded(generation, frame);
      return;
    }
    if (this.#state !== ON_AIR_V2_CONNECTION_STATES.READY) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.FRAME_BEFORE_NEGOTIATION, {
        type: frame.type,
        state: this.#state,
      });
      return;
    }

    if (family === ON_AIR_MESSAGE_FAMILIES.SERVER_HEARTBEAT_ACK) {
      this.#applyHeartbeatAck(frame);
      return;
    }

    // A targeted player command proves this player's downlink only after its
    // concrete connection/player fence passes in #applyPlayerCommand(). Other
    // valid current-generation frames remain ordinary transport evidence.
    if (!playerCommand) this.#lastEvidenceAt = this.#now();
    if (this.#role === 'control'
      && family === ON_AIR_MESSAGE_FAMILIES.SERVER_COMMAND_RESULT) {
      this.#applyCommandResult(frame);
      return;
    }
    if (this.#role === 'player'
      && family === ON_AIR_MESSAGE_FAMILIES.SERVER_EVENT_RESULT) {
      this.#applyEventResult(frame);
      return;
    }
    if (playerCommand) {
      this.#applyPlayerCommand(frame);
      return;
    }
    this.#call('onFrame', frame);
  }

  #parseInbound(data) {
    if (typeof data !== 'string') {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_FRAME_ENCODING, {
        receivedType: data === null ? 'null' : typeof data,
      });
      return { ok: false };
    }
    try {
      return { ok: true, frame: JSON.parse(data) };
    } catch {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_FRAME_JSON, {});
      return { ok: false };
    }
  }

  #handleWelcome(generation, frame, family) {
    const expectedFamily = this.#role === 'player'
      ? ON_AIR_MESSAGE_FAMILIES.PLAYER_WELCOME
      : ON_AIR_MESSAGE_FAMILIES.CONTROL_WELCOME;
    if (family !== expectedFamily || this.#state !== ON_AIR_V2_CONNECTION_STATES.NEGOTIATING) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.UNEXPECTED_WELCOME, {
        family,
        state: this.#state,
      });
      return;
    }
    const identityField = this.#role === 'player' ? 'playerInstanceId' : 'controlInstanceId';
    if (frame[identityField] !== this.#identity[identityField]) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.FOREIGN_WELCOME_IDENTITY, {
        field: identityField,
        received: frame[identityField],
      });
      return;
    }

    this.#connectionId = frame.connectionId;
    this.#welcome = immutableJson(frame);
    if (this.#role === 'player') this.#leaseEpoch = frame.leaseEpoch;
    this.#lastEvidenceAt = this.#now();

    const extension = this.#call('onNegotiationExtension', {
      role: this.#role,
      welcome: this.#welcome,
      generation: generation.number,
      complete: () => this.#completeNegotiationGeneration(generation),
    });
    if (extension?.defer === true) {
      this.#setState(ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION, {
        generation: generation.number,
      });
      return;
    }
    this.#finishNegotiation(generation);
  }

  #finishNegotiation(generation) {
    if (!this.#isCurrent(generation) || !this.#connectionId) return;
    this.#setState(ON_AIR_V2_CONNECTION_STATES.READY, {
      generation: generation.number,
      connectionId: this.#connectionId,
    });
    if (this.#role === 'player') {
      const rebound = this.#eventOutbox.rebindConnection(this.#connectionId);
      for (const record of rebound.rebound) {
        if (!this.#sendWire(record.message)) {
          this.#disconnectCurrent('event_retransmit_failed');
          break;
        }
      }
      if (this.#state === ON_AIR_V2_CONNECTION_STATES.READY) this.#startHeartbeat();
      for (const record of rebound.outcomeUnknown) {
        this.#call('onEventResult', Object.freeze({
          status: 'outcome_unknown',
          entry: record,
          retryAllowed: false,
        }));
      }
    }
    this.#call('onNegotiated', this.snapshot());
  }

  #completeNegotiationGeneration(generation) {
    if (
      !this.#isCurrent(generation)
      || this.#state !== ON_AIR_V2_CONNECTION_STATES.NEGOTIATION_EXTENSION
    ) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.STALE_NEGOTIATION_COMPLETION, {
        generation: generation?.number ?? null,
        currentGeneration: this.#generation?.number ?? null,
        state: this.#state,
      });
      return false;
    }
    this.#finishNegotiation(generation);
    return true;
  }

  #applyPlayerCommand(frame) {
    if (frame.targetConnectionId !== this.#connectionId) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.FOREIGN_TARGET_CONNECTION, {
        commandId: frame.commandId,
        targetConnectionId: frame.targetConnectionId,
        currentConnectionId: this.#connectionId,
      });
      return;
    }
    if (frame.targetPlayerInstanceId !== undefined
      && frame.targetPlayerInstanceId !== this.#identity.playerInstanceId) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.FOREIGN_TARGET_PLAYER, {
        commandId: frame.commandId,
        targetPlayerInstanceId: frame.targetPlayerInstanceId,
      });
      return;
    }

    // Only a command fenced to this exact player transport is evidence for the
    // player's downlink. A valid command for another player must never recover
    // this connection's liveness indicator.
    this.#lastEvidenceAt = this.#now();

    let inspection;
    try {
      inspection = this.#playerCommandLedger.inspect(frame);
    } catch (error) {
      const code = error?.code === ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_ID_CONFLICT
        ? ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_ID_CONFLICT
        : ON_AIR_V2_CONNECTION_CODES.INVALID_PROTOCOL_FRAME;
      this.#diagnose(code, {
        commandId: frame.commandId,
        ...safeErrorDetail(error),
      });
      return;
    }
    if (!inspection.shouldApply) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_DUPLICATE, {
        commandId: frame.commandId,
        targetConnectionId: frame.targetConnectionId,
      });
      return;
    }

    const emergency = inspection.family === ON_AIR_MESSAGE_FAMILIES.EMERGENCY_COMMAND;
    if (!emergency) {
      if (frame.leaseEpoch < this.#leaseEpoch) {
        this.#diagnose(ON_AIR_V2_CONNECTION_CODES.STALE_PLAYER_LEASE_EPOCH, {
          commandId: frame.commandId,
          expectedMinimum: this.#leaseEpoch,
          actual: frame.leaseEpoch,
        });
        return;
      }
      const activatesNewLease = frame.type === ROUTE_COMMAND_TYPES.ACTIVATE;
      const invalidAdvance = activatesNewLease
        ? frame.leaseEpoch <= this.#leaseEpoch
        : frame.leaseEpoch !== this.#leaseEpoch;
      if (invalidAdvance) {
        this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_PLAYER_LEASE_ADVANCE, {
          commandId: frame.commandId,
          type: frame.type,
          expected: activatesNewLease
            ? { greaterThan: this.#leaseEpoch }
            : this.#leaseEpoch,
          actual: frame.leaseEpoch,
        });
        return;
      }
    }

    try {
      this.#playerCommandLedger.observe(frame);
    } catch (error) {
      const historyExhausted = error?.code
        === ON_AIR_CLIENT_STATE_CODES.PLAYER_COMMAND_HISTORY_CAPACITY_EXCEEDED;
      const code = historyExhausted
        ? ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_HISTORY_EXHAUSTED
        : ON_AIR_V2_CONNECTION_CODES.PLAYER_COMMAND_ID_CONFLICT;
      this.#diagnose(code, {
        commandId: frame.commandId,
        ...safeErrorDetail(error),
      });
      if (historyExhausted && emergency) {
        // Repeating stop is safer than dropping it when bounded tombstones are
        // saturated. The stop remains connection-bound and idempotent.
        this.#callPlayerCommand(frame);
      } else if (historyExhausted) {
        this.#disconnectCurrent('player_command_history_exhausted');
      }
      return;
    }

    if (!emergency && frame.leaseEpoch > this.#leaseEpoch) {
      this.#leaseEpoch = frame.leaseEpoch;
    }
    this.#callPlayerCommand(frame);
  }

  #callPlayerCommand(frame) {
    const callback = this.#callbacks.onPlayerCommand;
    const generation = this.#generation;
    const connectionId = this.#connectionId;
    let result;
    try {
      if (typeof callback !== 'function') throw new TypeError('on_player_command_required');
      result = callback(frame);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          this.#handlePlayerCommandFailure(error, generation, connectionId, frame.commandId);
        });
      }
    } catch (error) {
      this.#handlePlayerCommandFailure(error, generation, connectionId, frame.commandId);
    }
  }

  #handlePlayerCommandFailure(error, generation, connectionId, commandId) {
    this.#diagnose(ON_AIR_V2_CONNECTION_CODES.CALLBACK_FAILED, {
      callback: 'onPlayerCommand',
      commandId,
      ...safeErrorDetail(error),
    });
    if (
      this.#isCurrent(generation)
      && this.#connectionId === connectionId
      && this.#state === ON_AIR_V2_CONNECTION_STATES.READY
    ) {
      this.#disconnectCurrent('player_command_callback_failed');
    }
  }

  #applyCommandResult(frame) {
    try {
      const result = this.#commandLedger.handleServerFrame(frame);
      this.#call('onCommandResult', result);
    } catch (error) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.COMMAND_RESULT_IGNORED, safeErrorDetail(error));
    }
  }

  #applyEventResult(frame) {
    try {
      const result = this.#eventOutbox.applyServerAck(frame);
      this.#call('onEventResult', result);
    } catch (error) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.EVENT_RESULT_IGNORED, safeErrorDetail(error));
    }
  }

  #applyHeartbeatAck(frame) {
    if (this.#role !== 'player') {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_UNEXPECTED_ROLE, {
        role: this.#role,
      });
      return;
    }
    if (frame.playerInstanceId !== this.#identity.playerInstanceId) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FOREIGN_PLAYER, {
        received: frame.playerInstanceId,
      });
      return;
    }
    if (frame.connectionId !== this.#connectionId) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FOREIGN_CONNECTION, {
        received: frame.connectionId,
        currentConnectionId: this.#connectionId,
      });
      return;
    }
    if (this.#heartbeatLastAckSequence !== null
      && frame.sequence === this.#heartbeatLastAckSequence) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_DUPLICATE, {
        sequence: frame.sequence,
      });
      return;
    }
    if (this.#heartbeatLastAckSequence !== null
      && frame.sequence < this.#heartbeatLastAckSequence) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_OUT_OF_ORDER, {
        sequence: frame.sequence,
        previous: this.#heartbeatLastAckSequence,
      });
      return;
    }
    if (this.#heartbeatLastSentSequence === null
      || frame.sequence > this.#heartbeatLastSentSequence) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_ACK_FUTURE_SEQUENCE, {
        sequence: frame.sequence,
        lastSentSequence: this.#heartbeatLastSentSequence,
      });
      return;
    }
    const acknowledgedAt = this.#now();
    this.#heartbeatLastAckSequence = frame.sequence;
    this.#heartbeatLastAckAt = acknowledgedAt;
    this.#lastEvidenceAt = acknowledgedAt;
    this.#leaseEpoch = Math.max(this.#leaseEpoch, frame.leaseEpoch);
  }

  #handleSuperseded(generation, frame) {
    generation.superseded = true;
    this.#stopHeartbeat();
    this.#markControlUnknown('connection_superseded');
    this.#markPlayerConnectionLost(this.#connectionId);
    this.#connectionId = null;
    this.#welcome = null;
    this.#lastEvidenceAt = null;
    this.#resetHeartbeatRoundTrip();
    this.#setState(ON_AIR_V2_CONNECTION_STATES.SUPERSEDED, {
      generation: generation.number,
      code: frame.code,
    });
    this.#diagnose(ON_AIR_V2_CONNECTION_CODES.CONNECTION_SUPERSEDED, {
      generation: generation.number,
      code: frame.code,
    });
    this.#call('onFrame', frame);
  }

  #handleClose(generation, event) {
    if (!this.#isCurrent(generation) || generation.superseded) return;
    this.#disconnectCurrent('socket_closed');
    this.#diagnose(ON_AIR_V2_CONNECTION_CODES.SOCKET_CLOSED, {
      generation: generation.number,
      code: Number.isInteger(event?.code) ? event.code : null,
      wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
    });
  }

  #handleError(generation) {
    if (!this.#isCurrent(generation)) return;
    this.#diagnose(ON_AIR_V2_CONNECTION_CODES.SOCKET_ERROR, {
      generation: generation.number,
    });
  }

  #sendWire(frame) {
    const generation = this.#generation;
    const socket = generation?.socket;
    if (!generation || !this.#isCurrent(generation)
      || (typeof socket?.readyState === 'number' && socket.readyState !== 1)) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.SOCKET_NOT_OPEN, {
        generation: generation?.number ?? null,
        readyState: typeof socket?.readyState === 'number' ? socket.readyState : null,
      });
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.SOCKET_SEND_FAILED, safeErrorDetail(error));
      return false;
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = this.#setInterval(
      () => this.#emitHeartbeat(),
      this.#heartbeatIntervalMs,
    );
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer !== null) {
      this.#clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #emitHeartbeat() {
    if (this.#role !== 'player' || this.#state !== ON_AIR_V2_CONNECTION_STATES.READY) return;
    let extension = {};
    try {
      if (typeof this.#callbacks.heartbeatPayload === 'function') {
        extension = this.#callbacks.heartbeatPayload({
          now: this.#now(),
          connectionId: this.#connectionId,
          leaseEpoch: this.#leaseEpoch,
        }) ?? {};
      }
      if (!isRecord(extension)) throw new TypeError('heartbeat_payload_not_record');
    } catch (error) {
      this.#diagnose(
        ON_AIR_V2_CONNECTION_CODES.HEARTBEAT_GENERATION_FAILED,
        safeErrorDetail(error),
      );
      return;
    }

    const frame = {
      ...extension,
      type: ON_AIR_MESSAGE_TYPES.PLAYER_HEARTBEAT,
      playerInstanceId: this.#identity.playerInstanceId,
      connectionId: this.#connectionId,
      leaseEpoch: this.#leaseEpoch,
      sequence: this.#sequenceCounters.next(ON_AIR_SEQUENCE_NAMESPACES.HEARTBEAT),
      monotonicTimeMs: this.#now(),
    };
    const validation = validateOnAirMessage(frame);
    if (!validation.ok) {
      this.#diagnose(ON_AIR_V2_CONNECTION_CODES.INVALID_OUTBOUND_FRAME, validationDetail(validation));
      return;
    }
    if (!this.#sendWire(frame)) {
      this.#disconnectCurrent('heartbeat_send_failed');
      return;
    }
    this.#heartbeatLastSentSequence = frame.sequence;
  }

  #requireRoleAndReady(role, operation) {
    if (this.#role !== role || this.#state !== ON_AIR_V2_CONNECTION_STATES.READY) {
      throw new OnAirV2ConnectionError(
        ON_AIR_V2_CONNECTION_CODES.INVALID_STATE,
        { operation, role: this.#role, state: this.#state },
      );
    }
  }

  #isCurrent(generation) {
    return this.#generation === generation && !generation.retired && !generation.disconnected;
  }

  #retireGeneration(reason) {
    const generation = this.#generation;
    if (!generation || generation.retired) return;
    generation.retired = true;
    this.#stopHeartbeat();
    this.#markControlUnknown(reason);
    this.#markPlayerConnectionLost(this.#connectionId);
  }

  #disconnectCurrent(reason) {
    const generation = this.#generation;
    if (!generation || generation.disconnected) return;
    generation.disconnected = true;
    this.#stopHeartbeat();
    this.#markControlUnknown(reason);
    this.#markPlayerConnectionLost(this.#connectionId);
    this.#connectionId = null;
    this.#welcome = null;
    this.#lastEvidenceAt = null;
    this.#resetHeartbeatRoundTrip();
    this.#setState(ON_AIR_V2_CONNECTION_STATES.DISCONNECTED, {
      generation: generation.number,
      reason,
    });
  }

  #markControlUnknown(reason) {
    if (!this.#commandLedger) return;
    const changed = this.#commandLedger.markReconnectOutcomeUnknown({ code: reason });
    for (const entry of changed) {
      this.#call('onCommandResult', Object.freeze({
        status: 'outcome_unknown',
        entry,
        retryAllowed: false,
      }));
    }
  }

  #markPlayerConnectionLost(connectionId) {
    if (!this.#eventOutbox || typeof connectionId !== 'string' || connectionId.length === 0) return;
    const changed = this.#eventOutbox.markConnectionLost(connectionId);
    for (const entry of changed) {
      this.#call('onEventResult', Object.freeze({
        status: 'outcome_unknown',
        entry,
        retryAllowed: false,
      }));
    }
  }

  #resetHeartbeatRoundTrip() {
    this.#heartbeatLastSentSequence = null;
    this.#heartbeatLastAckSequence = null;
    this.#heartbeatLastAckAt = null;
  }

  #observeNow(value) {
    if (Number.isFinite(value) && value >= 0) {
      this.#lastObservedNow = Math.max(this.#lastObservedNow, value);
    }
    return this.#lastObservedNow;
  }

  #setState(state, detail) {
    if (this.#state === state) return;
    const previous = this.#state;
    this.#state = state;
    this.#call('onStateChange', Object.freeze({
      previous,
      state,
      detail: immutableJson(detail),
    }));
  }

  #call(name, payload) {
    const callback = this.#callbacks[name];
    if (typeof callback !== 'function') return undefined;
    try {
      const result = callback(payload);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          if (name !== 'onDiagnostic') {
            this.#diagnose(ON_AIR_V2_CONNECTION_CODES.CALLBACK_FAILED, {
              callback: name,
              ...safeErrorDetail(error),
            });
          }
        });
      }
      return result;
    } catch (error) {
      if (name !== 'onDiagnostic') {
        this.#diagnose(ON_AIR_V2_CONNECTION_CODES.CALLBACK_FAILED, {
          callback: name,
          ...safeErrorDetail(error),
        });
      }
      return undefined;
    }
  }

  #diagnose(code, detail) {
    const diagnostic = Object.freeze({
      code,
      detail: immutableJson(detail),
      generation: this.#generation?.number ?? 0,
      at: this.#now(),
    });
    this.#diagnostics.push(diagnostic);
    while (this.#diagnostics.length > this.#diagnosticLimit) this.#diagnostics.shift();
    this.#call('onDiagnostic', diagnostic);
    return diagnostic;
  }
}

export function createOnAirV2Connection(options) {
  return new OnAirV2Connection(options);
}
