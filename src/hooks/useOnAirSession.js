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
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;

  const clearSession = useCallback(() => {
    persistSession(null);
    setSession(null);
    setTransport({ status: 'idle', song: null, position: 0, volume: 100 });
  }, []);

  const createSession = useCallback(async () => {
    if (!SESSION_BASE_URL) throw new Error('On-Air 출력 서버가 아직 연결되지 않았습니다.');
    const response = await fetch(`${SESSION_BASE_URL}/v1/sessions`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '방송 세션을 만들지 못했습니다.');
    persistSession(data);
    setSession(data);
    return data;
  }, []);

  const ensureSession = useCallback(async () => session || createSession(), [createSession, session]);

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
    const connect = () => {
      if (disposed) return;
      setConnectionState('connecting');
      const url = new URL(`/v1/sessions/${session.room}/ws`, SESSION_BASE_URL);
      url.searchParams.set('role', 'control');
      url.searchParams.set('token', session.controlToken);
      const socket = new WebSocket(toWebSocketUrl(SESSION_BASE_URL, `${url.pathname}?${url.searchParams.toString()}`));
      socketRef.current = socket;

      socket.onopen = () => {
        if (!disposed) setConnectionState('connected');
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.transport) setTransport(payload.transport);
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
        if (event.code === 1008 || event.code === 1011) {
          clearSession();
          setConnectionState('ended');
          return;
        }
        setConnectionState('reconnecting');
        reconnectRef.current = window.setTimeout(connect, 1500);
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

  const preparePlayer = useCallback(async () => {
    const activeSession = await ensureSession();
    return `${window.location.origin}${window.location.pathname}#/widget?mode=player&session=${encodeURIComponent(activeSession.room)}&token=${encodeURIComponent(activeSession.playerToken)}&api=${encodeURIComponent(SESSION_BASE_URL)}`;
  }, [ensureSession]);

  return {
    configured: Boolean(SESSION_BASE_URL),
    connectionState,
    transport,
    session,
    playerUrl,
    preparePlayer,
    ensureSession,
    sendCommand,
    uploadAsset,
    clearSession
  };
}
