import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'rekasong-on-air-session-v1';
const SESSION_BASE_URL = String(import.meta.env.VITE_ON_AIR_BASE_URL || '').trim().replace(/\/$/, '');

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

export function useOnAirSession(onEvent) {
  const [session, setSession] = useState(readStoredSession);
  const [connectionState, setConnectionState] = useState(SESSION_BASE_URL ? 'connecting' : 'unconfigured');
  const [transport, setTransport] = useState({ status: 'idle', song: null, position: 0, volume: 100 });
  // OBS 위젯(player·display)의 실제 연결 여부 — connectionState(대시보드↔서버)와
  // 별개의 진실이다. 스냅숏의 presence 로 초기화하고 이후 presence 이벤트로 갱신한다.
  const [widgetPresence, setWidgetPresence] = useState({ player: false, display: false });
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  // 최신 세션 거울 + 생성 중 프라미스: 동시 호출(스테이징 자동 준비 ↔ '주소 복사')이
  // 겹쳐도 세션은 반드시 하나만 만든다. 두 개가 생기면 위젯과 대시보드가 서로 다른
  // 세션에 붙어 "주소를 넣었는데 초록불이 안 켜지는" 고아 세션이 된다(라이브 실측).
  const sessionRef = useRef(session);
  const createInFlightRef = useRef(null);

  const clearSession = useCallback(() => {
    persistSession(null);
    sessionRef.current = null;
    setSession(null);
    setTransport({ status: 'idle', song: null, position: 0, volume: 100 });
    setWidgetPresence({ player: false, display: false });
  }, []);

  const createSession = useCallback(async () => {
    if (!SESSION_BASE_URL) throw new Error('On-Air 출력 서버가 아직 연결되지 않았습니다.');
    const response = await fetch(`${SESSION_BASE_URL}/v1/sessions`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '방송 세션을 만들지 못했습니다.');
    persistSession(data);
    sessionRef.current = data;
    setSession(data);
    return data;
  }, []);

  const ensureSession = useCallback(async () => {
    // state 대신 ref 를 읽는다 — 렌더 클로저의 낡은 session 으로 중복 생성하지 않게.
    if (sessionRef.current) return sessionRef.current;
    if (!createInFlightRef.current) {
      createInFlightRef.current = createSession().finally(() => { createInFlightRef.current = null; });
    }
    return createInFlightRef.current;
  }, [createSession]);

  const sendCommand = useCallback((command) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('OBS On-Air 위젯이 연결되어 있지 않습니다.');
    }
    const message = { type: 'command', command: { ...command, commandId: command.commandId || commandId() } };
    socket.send(JSON.stringify(message));
    return message.command.commandId;
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
    if (!SESSION_BASE_URL || !session) return undefined;

    let disposed = false;
    // 재접속 지수 백오프(Antigravity cb4c80d): Worker 지속 실패 시 1.5초 고정
    // 재접속은 Cloudflare 로 지속 신호를 쏘는 폭주가 된다. onopen 에서 0 리셋.
    let reconnectAttempts = 0;
    const connect = () => {
      if (disposed) return;
      setConnectionState('connecting');
      const url = new URL(`/v1/sessions/${session.room}/ws`, SESSION_BASE_URL);
      url.searchParams.set('role', 'control');
      url.searchParams.set('token', session.controlToken);
      const socket = new WebSocket(toWebSocketUrl(SESSION_BASE_URL, `${url.pathname}?${url.searchParams.toString()}`));
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttempts = 0;
        if (!disposed) setConnectionState('connected');
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.transport) setTransport(payload.transport);
          if (payload.type === 'snapshot') {
            // 재접속 포함 — 스냅숏이 위젯 presence 의 기준 진실이다.
            // (구버전 Worker 스냅숏에 presence 가 없으면 안전하게 false.)
            setWidgetPresence({
              player: Boolean(payload.presence?.player),
              display: Boolean(payload.presence?.display)
            });
          }
          if (payload.type === 'presence' && (payload.role === 'player' || payload.role === 'display')) {
            setWidgetPresence((previous) => ({ ...previous, [payload.role]: Boolean(payload.connected) }));
          }
          if (payload.type === 'session_ended') {
            clearSession();
            setConnectionState('ended');
          }
          eventRef.current?.(payload);
        } catch {
          // Ignore malformed status updates without dropping a live transport connection.
        }
      };
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        // control 소켓이 끊기면 위젯 상태를 관측할 수 없다 — 낙관적 잔상(stale
        // presence) 대신 미확인=false 로 되돌린다. 재접속 시 스냅숏이 즉시 복원한다.
        // (disposed=의도된 소켓 교체는 새 스냅숏이 바로 재동기화하므로 제외.)
        setWidgetPresence({ player: false, display: false });
        if (event.code === 1008 || event.code === 1011) {
          clearSession();
          setConnectionState('ended');
          return;
        }
        setConnectionState('reconnecting');
        reconnectAttempts += 1;
        const delay = Math.min(30000, 1500 * 1.5 ** (reconnectAttempts - 1));
        reconnectRef.current = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      if (socketRef.current) socketRef.current.close();
      socketRef.current = null;
    };
  }, [clearSession, session]);

  const playerUrl = session && SESSION_BASE_URL
    ? `${window.location.origin}${window.location.pathname}#/widget?mode=player&session=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.playerToken)}&api=${encodeURIComponent(SESSION_BASE_URL)}`
    : '';

  const displayUrl = session?.displayToken && SESSION_BASE_URL
    ? `${window.location.origin}${window.location.pathname}#/widget?mode=display&session=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.displayToken)}&api=${encodeURIComponent(SESSION_BASE_URL)}`
    : '';

  const preparePlayer = useCallback(async () => {
    const activeSession = await ensureSession();
    return `${window.location.origin}${window.location.pathname}#/widget?mode=player&session=${encodeURIComponent(activeSession.room)}&token=${encodeURIComponent(activeSession.playerToken)}&api=${encodeURIComponent(SESSION_BASE_URL)}`;
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
    return `${window.location.origin}${window.location.pathname}#/widget?mode=display&session=${encodeURIComponent(activeSession.room)}&token=${encodeURIComponent(activeSession.displayToken)}&api=${encodeURIComponent(SESSION_BASE_URL)}`;
  }, [ensureSession, issueDisplayToken]);

  return {
    configured: Boolean(SESSION_BASE_URL),
    connectionState,
    // OBS 위젯의 실제 연결 여부(서버 presence 근거) — connectionState 와 혼동 금지.
    playerConnected: widgetPresence.player,
    displayConnected: widgetPresence.display,
    transport,
    session,
    playerUrl,
    displayUrl,
    preparePlayer,
    prepareDisplay,
    ensureSession,
    sendCommand,
    uploadAsset,
    clearSession
  };
}
