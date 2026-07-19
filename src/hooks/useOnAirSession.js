import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'rekasong-on-air-session-v1';
const SESSION_BASE_URL = String(import.meta.env?.VITE_ON_AIR_BASE_URL || '').trim().replace(/\/$/, '');
const IDLE_TRANSPORT = Object.freeze({ status: 'idle', song: null, position: 0, volume: 100 });
const EMPTY_WIDGET_PRESENCE = Object.freeze({ player: false, display: false });
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;

export const ON_AIR_SESSION_SCHEMA_VERSION = 2;

export const ON_AIR_SESSION_VALIDATION_STATES = Object.freeze({
  ACTIVE: 'active',
  INVALID: 'invalid',
  ENDED: 'ended',
  RETRYABLE: 'retryable'
});

export const LEGACY_CONTROL_DISABLED_ERROR_CODE = 'ON_AIR_LEGACY_CONTROL_DISABLED';

export const resolveLegacyControlEnabled = (options) => options?.enabled !== false;
export const resolveLegacyControlObserveOnly = (options) => options?.observeOnly === true
  || options?.readOnly === true;

const readStoredSession = () => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return value?.room && value?.controlToken && value?.playerToken ? value : null;
  } catch {
    return null;
  }
};

const persistSession = (session) => {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The player can still run for this page even when storage is unavailable.
  }
};

const commandId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const toWebSocketUrl = (baseUrl, path) => {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const normalizeWorkerOrigin = (value) => String(value || '').trim().replace(/\/$/, '');

export function buildOnAirPlayerUrl({ origin, pathname, baseUrl, session } = {}) {
  const workerOrigin = normalizeWorkerOrigin(baseUrl);
  if (!origin || !pathname || !workerOrigin
    || !session?.room || !session?.playerToken) return '';
  return `${origin}${pathname}#/widget?mode=player&session=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.playerToken)}&api=${encodeURIComponent(workerOrigin)}&protocol=2`;
}

export function buildOnAirDisplayUrl({ origin, pathname, baseUrl, session } = {}) {
  const workerOrigin = normalizeWorkerOrigin(baseUrl);
  if (!origin || !pathname || !workerOrigin
    || !session?.room || !session?.displayToken) return '';
  return `${origin}${pathname}#/widget?mode=display&session=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.displayToken)}&api=${encodeURIComponent(workerOrigin)}`;
}

const storedSessionRecord = (session, { forceCurrentOrigin = false } = {}) => {
  if (!session?.room || !session?.controlToken || !session?.playerToken) return null;
  return {
    ...session,
    workerOrigin: forceCurrentOrigin
      ? SESSION_BASE_URL
      : normalizeWorkerOrigin(session.workerOrigin) || SESSION_BASE_URL,
    schemaVersion: ON_AIR_SESSION_SCHEMA_VERSION,
    createdAt: Number.isFinite(session.createdAt) && session.createdAt > 0
      ? session.createdAt
      : Date.now()
  };
};

const createDisabledError = () => {
  const error = new Error(LEGACY_CONTROL_DISABLED_ERROR_CODE);
  error.code = LEGACY_CONTROL_DISABLED_ERROR_CODE;
  return error;
};

/**
 * Validates stored control credentials without mutating the remote session.
 * Only an explicit 200/401/410 is authoritative; every other response is
 * retryable so a transient Worker or network failure cannot discard tokens.
 */
export async function validateOnAirSession({
  baseUrl = SESSION_BASE_URL,
  session,
  fetchImpl = globalThis.fetch,
  signal
} = {}) {
  const workerOrigin = normalizeWorkerOrigin(baseUrl);
  if (!workerOrigin || !session?.room || !session?.controlToken) {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.INVALID, reason: 'invalid_session_record' };
  }

  const storedOrigin = normalizeWorkerOrigin(session.workerOrigin);
  if (storedOrigin && storedOrigin !== workerOrigin) {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.INVALID, reason: 'worker_origin_mismatch' };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.RETRYABLE, reason: 'validator_unavailable' };
  }

  let response;
  try {
    response = await fetchImpl(
      `${workerOrigin}/v1/sessions/${encodeURIComponent(session.room)}/status`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${session.controlToken}` },
        credentials: 'omit',
        cache: 'no-store',
        signal
      }
    );
  } catch (error) {
    return {
      status: ON_AIR_SESSION_VALIDATION_STATES.RETRYABLE,
      reason: signal?.aborted ? 'validation_aborted' : 'network_error',
      error
    };
  }

  if (response.status === 200) {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.ACTIVE, httpStatus: 200 };
  }
  if (response.status === 401) {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.INVALID, reason: 'credential_invalid', httpStatus: 401 };
  }
  if (response.status === 410) {
    return { status: ON_AIR_SESSION_VALIDATION_STATES.ENDED, reason: 'session_ended', httpStatus: 410 };
  }
  return {
    status: ON_AIR_SESSION_VALIDATION_STATES.RETRYABLE,
    reason: 'unexpected_status',
    httpStatus: response.status
  };
}

/**
 * Owns the legacy control socket independently from React's effect lifetime.
 * Keeping one manager in a ref lets a StrictMode cleanup close the old socket
 * before the following setup creates its replacement.
 */
export function createLegacyControlSocketManager({
  baseUrl,
  webSocketFactory,
  validateSession = validateOnAirSession,
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (timer) => window.clearTimeout(timer),
  onConnectionState = () => {},
  onTransport = () => {},
  onPresence = () => {},
  onSessionEnded = () => {},
  onSessionInvalid = () => {},
  onEvent = () => {},
  commandIdFactory = commandId,
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS
}) {
  let activeLease = null;
  let currentSocket = null;
  let pendingLease = null;
  let currentValidation = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let nextLeaseId = 0;
  let nextValidationId = 0;
  let lastConnectionState = null;
  const reconnectLimit = Number.isSafeInteger(maxReconnectAttempts) && maxReconnectAttempts >= 0
    ? maxReconnectAttempts
    : DEFAULT_MAX_RECONNECT_ATTEMPTS;

  const publishConnectionState = (state) => {
    lastConnectionState = state;
    onConnectionState(state);
  };

  const isCurrentLease = (lease) => activeLease === lease
    && lease.enabled
    && !lease.ended
    && !lease.invalid;

  const clearReconnect = () => {
    if (reconnectTimer !== null) cancel(reconnectTimer);
    reconnectTimer = null;
  };

  const cancelValidation = (lease = null) => {
    if (!currentValidation || (lease && currentValidation.lease !== lease)) return;
    currentValidation.controller.abort();
    currentValidation = null;
  };

  const resetObservedTruth = () => {
    onTransport({ ...IDLE_TRANSPORT });
    onPresence({ ...EMPTY_WIDGET_PRESENCE });
  };

  const closeSocket = (socket) => {
    if (!socket || socket.readyState === 2 || socket.readyState === 3) return;
    socket.close();
  };

  const scheduleReconnect = (lease) => {
    if (!isCurrentLease(lease)) return;
    clearReconnect();
    onPresence({ ...EMPTY_WIDGET_PRESENCE });
    if (reconnectAttempts >= reconnectLimit) {
      publishConnectionState('unavailable');
      return;
    }
    reconnectAttempts += 1;
    publishConnectionState('reconnecting');
    const delay = Math.min(30000, 1500 * 1.5 ** (reconnectAttempts - 1));
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect(lease);
    }, delay);
  };

  const openValidatedSocket = (lease) => {
    if (!isCurrentLease(lease)) return;
    publishConnectionState(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let socket;
    try {
      const url = new URL(`/v1/sessions/${lease.session.room}/ws`, baseUrl);
      url.searchParams.set('role', 'control');
      url.searchParams.set('token', lease.session.controlToken);
      socket = webSocketFactory(toWebSocketUrl(baseUrl, `${url.pathname}?${url.searchParams.toString()}`));
    } catch {
      scheduleReconnect(lease);
      return;
    }
    currentSocket = { socket, lease };

    socket.onopen = () => {
      if (currentSocket?.socket !== socket || !isCurrentLease(lease)) {
        closeSocket(socket);
        return;
      }
      reconnectAttempts = 0;
      publishConnectionState('connected');
    };

    socket.onmessage = (event) => {
      if (currentSocket?.socket !== socket || !isCurrentLease(lease)) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.transport) onTransport(payload.transport);
        if (payload.type === 'snapshot') {
          onPresence({
            player: Boolean(payload.presence?.player),
            display: Boolean(payload.presence?.display)
          });
        }
        if (payload.type === 'presence' && (payload.role === 'player' || payload.role === 'display')) {
          onPresence((previous) => ({ ...previous, [payload.role]: Boolean(payload.connected) }));
        }
        if (payload.type === 'session_ended') {
          lease.ended = true;
          clearReconnect();
          pendingLease = null;
          onSessionEnded();
          publishConnectionState('ended');
          closeSocket(socket);
        }
        onEvent(payload);
      } catch {
        // Ignore malformed status updates without dropping a live transport connection.
      }
    };

    socket.onclose = () => {
      if (currentSocket?.socket !== socket) return;
      currentSocket = null;

      const queuedLease = pendingLease;
      pendingLease = null;
      if (queuedLease && isCurrentLease(queuedLease)) {
        connect(queuedLease);
        return;
      }
      if (!isCurrentLease(lease)) return;

      onPresence({ ...EMPTY_WIDGET_PRESENCE });
      // Close codes cannot prove credential/session state. In particular 1011
      // is a retryable server failure and must never delete a stored session.
      scheduleReconnect(lease);
    };

    socket.onerror = () => closeSocket(socket);
  };

  const validateAndConnect = async (lease) => {
    if (!isCurrentLease(lease)) return;
    const validation = {
      id: ++nextValidationId,
      lease,
      controller: new AbortController()
    };
    currentValidation = validation;
    publishConnectionState(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let result;
    try {
      result = await validateSession({
        baseUrl,
        session: lease.session,
        signal: validation.controller.signal
      });
    } catch (error) {
      result = { status: ON_AIR_SESSION_VALIDATION_STATES.RETRYABLE, reason: 'validator_error', error };
    }

    if (currentValidation?.id !== validation.id || !isCurrentLease(lease)) return;
    currentValidation = null;

    if (result?.status === ON_AIR_SESSION_VALIDATION_STATES.ACTIVE) {
      openValidatedSocket(lease);
      return;
    }
    if (result?.status === ON_AIR_SESSION_VALIDATION_STATES.INVALID) {
      lease.invalid = true;
      clearReconnect();
      resetObservedTruth();
      onSessionInvalid(lease.session, result);
      publishConnectionState('invalid');
      return;
    }
    if (result?.status === ON_AIR_SESSION_VALIDATION_STATES.ENDED) {
      lease.ended = true;
      clearReconnect();
      resetObservedTruth();
      onSessionEnded(lease.session, result);
      publishConnectionState('ended');
      return;
    }
    scheduleReconnect(lease);
  };

  const connect = (lease) => {
    if (!isCurrentLease(lease) || !baseUrl || !lease.session) return;

    if (currentSocket?.socket?.readyState === 3) currentSocket = null;
    if (currentSocket) {
      pendingLease = lease;
      closeSocket(currentSocket.socket);
      return;
    }
    if (currentValidation?.lease === lease) return;

    pendingLease = null;
    validateAndConnect(lease);
  };

  const deactivate = (lease) => {
    if (activeLease !== lease) return;
    activeLease = null;
    clearReconnect();
    cancelValidation(lease);
    if (pendingLease === lease) pendingLease = null;
    if (currentSocket?.lease === lease) closeSocket(currentSocket.socket);
  };

  const activate = ({
    enabled = true,
    session = null,
    observeOnly = false,
    readOnly = false
  } = {}) => {
    if (activeLease) deactivate(activeLease);
    const lease = {
      id: ++nextLeaseId,
      enabled: enabled !== false,
      observeOnly: observeOnly === true || readOnly === true,
      ended: false,
      invalid: false,
      session
    };
    activeLease = lease;
    clearReconnect();
    reconnectAttempts = 0;
    pendingLease = null;

    if (!lease.enabled) {
      resetObservedTruth();
      publishConnectionState(baseUrl ? 'disabled' : 'unconfigured');
    } else if (!baseUrl) {
      resetObservedTruth();
      publishConnectionState('unconfigured');
    } else if (session) {
      connect(lease);
    } else {
      resetObservedTruth();
      if (!['ended', 'invalid'].includes(lastConnectionState)) publishConnectionState('connecting');
    }

    return () => deactivate(lease);
  };

  const send = (command) => {
    if (!isCurrentLease(activeLease) || activeLease.observeOnly) throw createDisabledError();
    const socket = currentSocket?.lease === activeLease ? currentSocket.socket : null;
    if (!socket || socket.readyState !== 1) {
      const error = new Error('OBS On-Air 위젯이 연결되어 있지 않습니다.');
      error.code = 'ON_AIR_LEGACY_CONTROL_NOT_CONNECTED';
      throw error;
    }
    const message = { type: 'command', command: { ...command, commandId: command.commandId || commandIdFactory() } };
    socket.send(JSON.stringify(message));
    return message.command.commandId;
  };

  return { activate, send };
}

export function useOnAirSession(onEvent, options) {
  const enabled = resolveLegacyControlEnabled(options);
  const observeOnly = resolveLegacyControlObserveOnly(options);
  const [session, setSession] = useState(readStoredSession);
  const [connectionState, setConnectionState] = useState(
    SESSION_BASE_URL ? (enabled ? 'connecting' : 'disabled') : 'unconfigured'
  );
  const [transport, setTransport] = useState({ ...IDLE_TRANSPORT });
  // OBS 위젯(player·display)의 실제 연결 여부 — connectionState(대시보드↔서버)와
  // 별개의 진실이다. 스냅숏의 presence 로 초기화하고 이후 presence 이벤트로 갱신한다.
  const [widgetPresence, setWidgetPresence] = useState({ ...EMPTY_WIDGET_PRESENCE });
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const observeOnlyRef = useRef(observeOnly);
  observeOnlyRef.current = observeOnly;
  // 최신 세션 거울 + 생성 중 프라미스: 동시 호출(스테이징 자동 준비 ↔ '주소 복사')이
  // 겹쳐도 세션은 반드시 하나만 만든다. 두 개가 생기면 위젯과 대시보드가 서로 다른
  // 세션에 붙어 "주소를 넣었는데 초록불이 안 켜지는" 고아 세션이 된다(라이브 실측).
  const sessionRef = useRef(session);
  const createInFlightRef = useRef(null);

  const clearSession = useCallback(() => {
    persistSession(null);
    sessionRef.current = null;
    setSession(null);
    setTransport({ ...IDLE_TRANSPORT });
    setWidgetPresence({ ...EMPTY_WIDGET_PRESENCE });
  }, []);

  const createSession = useCallback(async () => {
    if (!SESSION_BASE_URL) throw new Error('On-Air 출력 서버가 아직 연결되지 않았습니다.');
    const response = await fetch(`${SESSION_BASE_URL}/v1/sessions`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '방송 세션을 만들지 못했습니다.');
    const createdSession = storedSessionRecord(data, { forceCurrentOrigin: true });
    if (!createdSession) throw new Error('방송 세션 응답이 올바르지 않습니다.');
    persistSession(createdSession);
    sessionRef.current = createdSession;
    setSession(createdSession);
    return createdSession;
  }, []);

  const ensureSession = useCallback(async () => {
    // state 대신 ref 를 읽는다 — 렌더 클로저의 낡은 session 으로 중복 생성하지 않게.
    if (sessionRef.current) return sessionRef.current;
    if (!createInFlightRef.current) {
      createInFlightRef.current = createSession().finally(() => { createInFlightRef.current = null; });
    }
    return createInFlightRef.current;
  }, [createSession]);

  const managerCallbacksRef = useRef(null);
  managerCallbacksRef.current = {
    setConnectionState,
    setTransport,
    setWidgetPresence,
    clearSession,
    emitEvent: (payload) => eventRef.current?.(payload)
  };
  const managerRef = useRef(null);
  if (!managerRef.current) {
    managerRef.current = createLegacyControlSocketManager({
      baseUrl: SESSION_BASE_URL,
      webSocketFactory: (url) => new WebSocket(url),
      validateSession: ({ baseUrl, session: candidate, signal }) => validateOnAirSession({
        baseUrl,
        session: candidate,
        fetchImpl: fetch,
        signal
      }),
      onConnectionState: (state) => managerCallbacksRef.current?.setConnectionState(state),
      onTransport: (value) => managerCallbacksRef.current?.setTransport(value),
      onPresence: (value) => managerCallbacksRef.current?.setWidgetPresence(value),
      onSessionEnded: () => managerCallbacksRef.current?.clearSession(),
      // Invalid credentials remain visible until the user explicitly replaces
      // them. This avoids silently orphaning an active OBS/session route.
      onSessionInvalid: () => {},
      onEvent: (payload) => managerCallbacksRef.current?.emitEvent(payload)
    });
  }

  const sendCommand = useCallback((command) => {
    if (!enabledRef.current || observeOnlyRef.current) throw createDisabledError();
    return managerRef.current.send(command);
  }, []);

  const uploadAsset = useCallback(async (file, onProgress) => {
    const activeSession = await ensureSession();
    const url = `${SESSION_BASE_URL}/v1/sessions/${activeSession.room}/assets`;

    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.setRequestHeader('Authorization', `Bearer ${activeSession.controlToken}`);
      request.setRequestHeader('X-Rekasong-Name', encodeURIComponent(file.name || 'local-media'));
      request.setRequestHeader('X-Rekasong-Type', file.type || 'application/octet-stream');
      request.setRequestHeader('X-Rekasong-Size', String(file.size));
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      request.onerror = () => reject(new Error('로컬 파일 업로드 연결이 끊겼습니다.'));
      request.onload = () => {
        let data;
        try { data = JSON.parse(request.responseText || '{}'); } catch { data = {}; }
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(data.error || '로컬 파일 업로드에 실패했습니다.'));
          return;
        }
        resolve(data);
      };
      request.send(file);
    });
  }, [ensureSession]);

  useEffect(() => {
    return managerRef.current.activate({ enabled, observeOnly, session });
  }, [enabled, observeOnly, session]);

  const playerUrl = buildOnAirPlayerUrl({
    origin: window.location.origin,
    pathname: window.location.pathname,
    baseUrl: SESSION_BASE_URL,
    session
  });

  const displayUrl = buildOnAirDisplayUrl({
    origin: window.location.origin,
    pathname: window.location.pathname,
    baseUrl: SESSION_BASE_URL,
    session
  });

  const preparePlayer = useCallback(async () => {
    const activeSession = await ensureSession();
    return buildOnAirPlayerUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      baseUrl: SESSION_BASE_URL,
      session: activeSession
    });
  }, [ensureSession]);

  const issueDisplayToken = useCallback(async (activeSession) => {
    const response = await fetch(`${SESSION_BASE_URL}/v1/sessions/${encodeURIComponent(activeSession.room)}/display-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeSession.controlToken}` }
    });
    const data = await response.json();
    if (!response.ok || !data.displayToken) throw new Error(data.error || '화면 정보 위젯 토큰을 만들지 못했습니다.');

    const upgradedSession = { ...activeSession, displayToken: data.displayToken };
    persistSession(upgradedSession);
    sessionRef.current = upgradedSession;
    setSession(upgradedSession);
    return upgradedSession;
  }, []);

  const prepareDisplay = useCallback(async () => {
    let activeSession = await ensureSession();
    if (!activeSession.displayToken) activeSession = await issueDisplayToken(activeSession);
    return buildOnAirDisplayUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      baseUrl: SESSION_BASE_URL,
      session: activeSession
    });
  }, [ensureSession, issueDisplayToken]);

  const replaceSession = useCallback((replacement) => {
    const nextSession = replacement === null ? null : storedSessionRecord(replacement);
    if (replacement !== null && !nextSession) {
      throw new TypeError('Invalid On-Air session replacement');
    }
    persistSession(nextSession);
    sessionRef.current = nextSession;
    setSession(nextSession);
    setTransport({ ...IDLE_TRANSPORT });
    setWidgetPresence({ ...EMPTY_WIDGET_PRESENCE });
    return nextSession;
  }, []);

  const createFreshSession = useCallback(async () => {
    if (!createInFlightRef.current) {
      createInFlightRef.current = createSession().finally(() => { createInFlightRef.current = null; });
    }
    return createInFlightRef.current;
  }, [createSession]);

  return {
    configured: Boolean(SESSION_BASE_URL),
    baseUrl: SESSION_BASE_URL,
    connectionState: enabled ? connectionState : (SESSION_BASE_URL ? 'disabled' : 'unconfigured'),
    // OBS 위젯의 실제 연결 여부(서버 presence 근거) — connectionState 와 혼동 금지.
    playerConnected: enabled ? widgetPresence.player : false,
    displayConnected: enabled ? widgetPresence.display : false,
    transport: enabled ? transport : IDLE_TRANSPORT,
    session,
    playerUrl,
    displayUrl,
    preparePlayer,
    prepareDisplay,
    ensureSession,
    replaceSession,
    createFreshSession,
    sendCommand,
    uploadAsset,
    clearSession
  };
}
