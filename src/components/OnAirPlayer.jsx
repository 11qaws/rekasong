import React, { useEffect, useMemo, useRef, useState } from 'react';
import YouTube from 'react-youtube';

const websocketUrl = (baseUrl, path) => {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const eventId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function OnAirPlayer({ apiBaseUrl, room, token }) {
  const [transport, setTransport] = useState({ status: 'idle', song: null, position: 0, volume: 100, sessionId: null });
  const youtubeRef = useRef(null);
  const mediaRef = useRef(null);
  const socketRef = useRef(null);
  const lastProgressRef = useRef(0);
  const transportRef = useRef(transport);

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  const sendEvent = (event) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'event', event: { ...event, eventId: eventId(), sessionId: event.sessionId || transportRef.current.sessionId } }));
    }
  };

  const applyCommand = (command) => {
    if (command.sessionId && transportRef.current.sessionId && command.sessionId !== transportRef.current.sessionId && command.type !== 'load') return;
    if (command.type === 'load') {
      setTransport((previous) => ({
        ...previous,
        song: command.song,
        sessionId: command.sessionId,
        position: Number(command.position) || 0,
        volume: Number.isFinite(command.volume) ? command.volume : previous.volume,
        status: 'loading'
      }));
      return;
    }
    if (command.type === 'play') {
      youtubeRef.current?.playVideo?.();
      mediaRef.current?.play?.().catch(() => sendEvent({ type: 'error', message: '브라우저가 재생을 차단했습니다.' }));
      return;
    }
    if (command.type === 'pause') {
      youtubeRef.current?.pauseVideo?.();
      mediaRef.current?.pause?.();
      return;
    }
    if (command.type === 'seek') {
      youtubeRef.current?.seekTo?.(Number(command.position) || 0, true);
      if (mediaRef.current) mediaRef.current.currentTime = Number(command.position) || 0;
      return;
    }
    if (command.type === 'volume') {
      const volume = Math.max(0, Math.min(100, Number(command.volume) || 0));
      setTransport((previous) => ({ ...previous, volume }));
      youtubeRef.current?.setVolume?.(volume);
      if (mediaRef.current) mediaRef.current.volume = volume / 100;
      return;
    }
    if (command.type === 'stop') {
      youtubeRef.current?.stopVideo?.();
      mediaRef.current?.pause?.();
      if (mediaRef.current) mediaRef.current.currentTime = 0;
      setTransport((previous) => ({ ...previous, status: 'stopped', position: 0 }));
    }
  };

  useEffect(() => {
    if (!apiBaseUrl || !room || !token) return undefined;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(websocketUrl(apiBaseUrl, `/v1/sessions/${room}/ws?role=player&token=${encodeURIComponent(token)}`));
      socketRef.current = socket;
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'snapshot' && payload.transport) {
            setTransport(payload.transport);
            return;
          }
          if (payload.type === 'command') applyCommand(payload.command || {});
          if (payload.type === 'session_ended') {
            youtubeRef.current?.stopVideo?.();
            mediaRef.current?.pause?.();
            setTransport({ status: 'stopped', song: null, position: 0, volume: 100, sessionId: null });
          }
        } catch {
          // Keep the player available if a relay status frame is malformed.
        }
      };
      socket.onclose = () => {
        if (!disposed) window.setTimeout(connect, 1500);
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      disposed = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [apiBaseUrl, room, token]);

  useEffect(() => {
    if (transport.status !== 'playing') return undefined;
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (now - lastProgressRef.current < 900) return;
      lastProgressRef.current = now;
      const position = youtubeRef.current?.getCurrentTime?.() ?? mediaRef.current?.currentTime;
      const duration = youtubeRef.current?.getDuration?.() ?? mediaRef.current?.duration;
      if (Number.isFinite(position)) sendEvent({ type: 'position', position, duration: Number.isFinite(duration) ? duration : undefined });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [transport.status, transport.sessionId]);

  const localMediaUrl = useMemo(() => {
    if (transport.song?.type !== 'local' || !transport.song?.assetId || !apiBaseUrl || !room || !token) return '';
    return `${apiBaseUrl}/v1/sessions/${encodeURIComponent(room)}/media/${encodeURIComponent(transport.song.assetId)}?token=${encodeURIComponent(token)}`;
  }, [apiBaseUrl, room, token, transport.song]);

  const onYoutubeReady = (event) => {
    youtubeRef.current = event.target;
    event.target.setVolume(transport.volume);
    if (transport.position) event.target.seekTo(transport.position, true);
    if (['loading', 'playing', 'buffering'].includes(transport.status)) event.target.playVideo();
    sendEvent({ type: 'ready', duration: event.target.getDuration?.() || 0 });
  };

  const onYoutubeState = (event) => {
    const states = { 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering' };
    const type = states[event.data];
    if (type) {
      const position = event.target.getCurrentTime?.() || 0;
      const duration = event.target.getDuration?.() || 0;
      setTransport((previous) => ({ ...previous, status: type, position }));
      sendEvent({ type, position, duration });
    }
  };

  const onMediaReady = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.volume = transport.volume / 100;
    if (transport.position) media.currentTime = transport.position;
    if (['loading', 'playing', 'buffering'].includes(transport.status)) {
      media.play().catch(() => sendEvent({ type: 'error', message: '브라우저가 재생을 차단했습니다.' }));
    }
    sendEvent({ type: 'ready', duration: media.duration || 0 });
  };

  const onMediaEvent = (type) => () => {
    const position = mediaRef.current?.currentTime || 0;
    const duration = mediaRef.current?.duration;
    setTransport((previous) => ({ ...previous, status: type, position }));
    sendEvent({ type, position, duration: Number.isFinite(duration) ? duration : undefined });
  };

  if (!transport.song) return <div className="on-air-player-idle" aria-label="On-Air player waiting" />;

  if (transport.song.type === 'youtube') {
    return (
      <div className="on-air-player" aria-hidden="true">
        <YouTube
          key={transport.sessionId}
          videoId={transport.song.src}
          // YouTube requires an embedded player viewport of at least 200×200.
          // The wrapper is kept outside the OBS canvas in Widget.css, so this
          // remains an audio-only browser source without shrinking the player
          // into an unsupported 1px iframe.
          opts={{ width: '200', height: '200', playerVars: { autoplay: 1, controls: 0, origin: window.location.origin } }}
          onReady={onYoutubeReady}
          onStateChange={onYoutubeState}
          onError={(event) => sendEvent({ type: 'error', message: `YouTube 재생 오류 (${event.data})` })}
        />
      </div>
    );
  }

  if (transport.song.mediaType === 'video') {
    return <video ref={mediaRef} className="on-air-player" src={localMediaUrl} playsInline onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />;
  }

  return <audio ref={mediaRef} className="on-air-player" src={localMediaUrl} onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />;
}
