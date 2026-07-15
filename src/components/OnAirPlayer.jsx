import React, { useEffect, useMemo, useRef, useState } from 'react';
import YouTube from 'react-youtube';

const PREPARED_AT_SECONDS = 1.5;
const PREPARED_STABLE_FOR_MS = 650;
const PREPARED_MIN_ADVANCE_SECONDS = 0.45;
const PREPARE_TIMEOUT_MS = 90_000;

const websocketUrl = (baseUrl, path) => {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const eventId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isYouTubeSong = (song) => song?.type === 'youtube' && song?.id && song?.src;

/**
 * The player pool has one promoted (audible) slot and up to five standby slots.
 * A standby slot is paused as soon as the actual video timeline advances. When
 * selected from the queue it is promoted in place, avoiding a new iframe.
 */
export default function OnAirPlayer({ apiBaseUrl, room, token }) {
  const [transport, setTransport] = useState({ status: 'idle', song: null, position: 0, volume: 100, sessionId: null });
  const [youtubeSlots, setYoutubeSlots] = useState([]);
  const mediaRef = useRef(null);
  const socketRef = useRef(null);
  const playerRefs = useRef(new Map());
  const slotRefs = useRef(new Map());
  const prepTimersRef = useRef(new Map());
  const transportRef = useRef(transport);
  const lastProgressRef = useRef(0);

  const commitTransport = (nextTransport) => {
    transportRef.current = nextTransport;
    setTransport(nextTransport);
  };

  const syncSlots = () => setYoutubeSlots(Array.from(slotRefs.current.values()));

  const clearPreparationWatch = (slotId) => {
    const timer = prepTimersRef.current.get(slotId);
    if (timer) window.clearInterval(timer);
    prepTimersRef.current.delete(slotId);
  };

  const setSlot = (slotId, slot) => {
    slotRefs.current.set(slotId, slot);
    syncSlots();
  };

  const removeSlot = (slotId) => {
    clearPreparationWatch(slotId);
    try { playerRefs.current.get(slotId)?.stopVideo?.(); } catch { /* player can already be gone */ }
    playerRefs.current.delete(slotId);
    slotRefs.current.delete(slotId);
    syncSlots();
  };

  const sendEvent = (event) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'event', event: { ...event, eventId: eventId(), sessionId: event.sessionId || transportRef.current.sessionId } }));
    }
  };

  const reportPreloadStatus = (slotId, status, detail = {}) => {
    const slot = slotRefs.current.get(slotId);
    if (!slot?.song?.id) return;
    sendEvent({ type: 'preload_status', songId: slot.song.id, status, detail, sessionId: undefined });
  };

  const updateActiveStatus = (type, position, duration) => {
    const current = transportRef.current;
    const next = {
      ...current,
      status: type,
      position: Number.isFinite(position) ? position : current.position
    };
    if (Number.isFinite(duration)) next.duration = duration;
    commitTransport(next);
    sendEvent({ type, position: next.position, duration: Number.isFinite(duration) ? duration : undefined });
  };

  const startPreparationWatch = (slotId, purpose) => {
    if (prepTimersRef.current.has(slotId)) return;

    const startedAt = Date.now();
    let timelineCandidateAt = 0;
    let timelineCandidatePosition = 0;
    let lastProbeReportedAt = 0;
    const timer = window.setInterval(() => {
      const slot = slotRefs.current.get(slotId);
      const player = playerRefs.current.get(slotId);
      if (!slot || !player || (purpose === 'standby' && slot.mode !== 'preparing') || (purpose === 'active' && slot.mode !== 'active')) {
        clearPreparationWatch(slotId);
        return;
      }

      const position = Number(player.getCurrentTime?.() || 0);
      const now = Date.now();
      if (purpose === 'standby' && now - lastProbeReportedAt >= 1000) {
        lastProbeReportedAt = now;
        reportPreloadStatus(slotId, 'preparing', { phase: '곡 시간 확인', position });
      }
      if (position >= PREPARED_AT_SECONDS) {
        if (!timelineCandidateAt) {
          timelineCandidateAt = now;
          timelineCandidatePosition = position;
          return;
        }
        if (now - timelineCandidateAt < PREPARED_STABLE_FOR_MS || position - timelineCandidatePosition < PREPARED_MIN_ADVANCE_SECONDS) return;

        clearPreparationWatch(slotId);
        if (purpose === 'standby') {
          player.pauseVideo?.();
          player.seekTo?.(0, true);
          setSlot(slotId, { ...slot, mode: 'ready', prepared: true });
          reportPreloadStatus(slotId, 'ready', { phase: '곡 시간 확인 완료', position });
          return;
        }

        // The direct-play fallback uses the same verification, then rewinds to
        // the beginning before opening the output volume. This keeps the song
        // intro intact while a not-yet-prepared item remains silent.
        player.pauseVideo?.();
        player.seekTo?.(0, true);
        player.unMute?.();
        player.setVolume?.(Math.max(0, Math.min(100, Number(transportRef.current.volume) || 0)));
        setSlot(slotId, { ...slot, prepared: true });
        player.playVideo?.();
        updateActiveStatus('playing', 0, Number(player.getDuration?.() || 0));
        return;
      }

      timelineCandidateAt = 0;
      timelineCandidatePosition = 0;

      if (now - startedAt >= PREPARE_TIMEOUT_MS) {
        clearPreparationWatch(slotId);
        if (purpose === 'standby') {
          player.pauseVideo?.();
          setSlot(slotId, { ...slot, mode: 'failed', prepared: false });
          reportPreloadStatus(slotId, 'failed', { phase: '90초 동안 곡 시간 없음', position });
        } else {
          player.pauseVideo?.();
          sendEvent({ type: 'error', message: '곡 재생 준비 시간이 초과되었습니다.' });
        }
      }
    }, 180);
    prepTimersRef.current.set(slotId, timer);
  };

  const startActiveSlot = (slotId) => {
    const slot = slotRefs.current.get(slotId);
    const player = playerRefs.current.get(slotId);
    if (!slot || !player || slot.mode !== 'active') return;

    if (slot.prepared) {
      player.unMute?.();
      player.setVolume?.(Math.max(0, Math.min(100, Number(transportRef.current.volume) || 0)));
      player.seekTo?.(Number(transportRef.current.position) || 0, true);
      player.playVideo?.();
      return;
    }

    // A directly selected, not-yet-ready song is intentionally silent until
    // its real video timeline starts. This is also the fallback for a queue
    // item that was outside the warm pool.
    player.mute?.();
    player.setVolume?.(0);
    player.seekTo?.(Number(transportRef.current.position) || 0, true);
    player.playVideo?.();
    startPreparationWatch(slotId, 'active');
  };

  const activateYoutubeSong = (song, sessionId) => {
    if (!isYouTubeSong(song)) return;

    const nextId = String(sessionId || song.id);
    const existing = slotRefs.current.get(nextId);
    const currentActive = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');

    if (currentActive && currentActive.id !== nextId) removeSlot(currentActive.id);

    if (existing) {
      clearPreparationWatch(nextId);
      setSlot(nextId, { ...existing, mode: 'active' });
      startActiveSlot(nextId);
      return;
    }

    setSlot(nextId, { id: nextId, song, mode: 'active', prepared: false });
  };

  const clearActiveYoutube = () => {
    const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
    if (active) removeSlot(active.id);
  };

  const stagePreloads = (songs) => {
    const desired = new Map();
    (Array.isArray(songs) ? songs : []).filter(isYouTubeSong).forEach((song) => desired.set(String(song.id), song));

    Array.from(slotRefs.current.values()).forEach((slot) => {
      if (slot.mode !== 'active' && !desired.has(slot.id)) removeSlot(slot.id);
    });

    desired.forEach((song, slotId) => {
      const existing = slotRefs.current.get(slotId);
      if (existing) return;
      setSlot(slotId, { id: slotId, song, mode: 'preparing', prepared: false });
    });
  };

  const applyCommand = (command) => {
    const activeSessionId = transportRef.current.sessionId;
    if (command.sessionId && activeSessionId && command.sessionId !== activeSessionId && !['load', 'preload'].includes(command.type)) return;

    if (command.type === 'preload') {
      stagePreloads(command.songs);
      return;
    }

    if (command.type === 'load') {
      const next = {
        ...transportRef.current,
        song: command.song || null,
        sessionId: command.sessionId || crypto.randomUUID(),
        position: Number(command.position) || 0,
        volume: Number.isFinite(command.volume) ? command.volume : transportRef.current.volume,
        status: 'loading'
      };
      commitTransport(next);
      if (next.song?.type === 'youtube') activateYoutubeSong(next.song, next.sessionId);
      else clearActiveYoutube();
      return;
    }

    if (command.type === 'play') {
      const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
      if (active) startActiveSlot(active.id);
      mediaRef.current?.play?.().catch(() => sendEvent({ type: 'error', message: '브라우저가 재생을 차단했습니다.' }));
      return;
    }
    if (command.type === 'pause') {
      const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
      clearPreparationWatch(active?.id);
      playerRefs.current.get(active?.id)?.pauseVideo?.();
      mediaRef.current?.pause?.();
      return;
    }
    if (command.type === 'seek') {
      const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
      playerRefs.current.get(active?.id)?.seekTo?.(Number(command.position) || 0, true);
      if (mediaRef.current) mediaRef.current.currentTime = Number(command.position) || 0;
      return;
    }
    if (command.type === 'volume') {
      const volume = Math.max(0, Math.min(100, Number(command.volume) || 0));
      commitTransport({ ...transportRef.current, volume });
      const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
      if (active?.prepared) playerRefs.current.get(active.id)?.setVolume?.(volume);
      if (mediaRef.current) mediaRef.current.volume = volume / 100;
      return;
    }
    if (command.type === 'stop') {
      Array.from(slotRefs.current.keys()).forEach(removeSlot);
      mediaRef.current?.pause?.();
      if (mediaRef.current) mediaRef.current.currentTime = 0;
      commitTransport({ ...transportRef.current, status: 'stopped', position: 0, song: null, sessionId: null });
    }
  };

  const hydrateSnapshot = (snapshot) => {
    const nextTransport = snapshot?.transport || { status: 'idle', song: null, position: 0, volume: 100, sessionId: null };
    commitTransport(nextTransport);
    if (nextTransport.song?.type === 'youtube') activateYoutubeSong(nextTransport.song, nextTransport.sessionId);
    else clearActiveYoutube();
    stagePreloads(snapshot?.preloads);
  };

  useEffect(() => {
    if (!apiBaseUrl || !room || !token) return undefined;
    let disposed = false;
    const preparationTimers = prepTimersRef.current;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(websocketUrl(apiBaseUrl, `/v1/sessions/${room}/ws?role=player&token=${encodeURIComponent(token)}`));
      socketRef.current = socket;
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'snapshot') hydrateSnapshot(payload);
          if (payload.type === 'command') applyCommand(payload.command || {});
          if (payload.type === 'session_ended') {
            Array.from(slotRefs.current.keys()).forEach(removeSlot);
            mediaRef.current?.pause?.();
            commitTransport({ status: 'stopped', song: null, position: 0, volume: 100, sessionId: null });
          }
        } catch {
          // Keep the player available if a malformed relay frame arrives.
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
      Array.from(preparationTimers.keys()).forEach(clearPreparationWatch);
    };
  }, [apiBaseUrl, room, token]);

  useEffect(() => {
    if (transport.status !== 'playing') return undefined;
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (now - lastProgressRef.current < 900) return;
      lastProgressRef.current = now;
      const active = Array.from(slotRefs.current.values()).find((slot) => slot.mode === 'active');
      const player = active ? playerRefs.current.get(active.id) : null;
      const position = player?.getCurrentTime?.() ?? mediaRef.current?.currentTime;
      const duration = player?.getDuration?.() ?? mediaRef.current?.duration;
      if (Number.isFinite(position)) sendEvent({ type: 'position', position, duration: Number.isFinite(duration) ? duration : undefined });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [transport.status, transport.sessionId]);

  const localMediaUrl = useMemo(() => {
    if (transport.song?.type !== 'local' || !transport.song?.assetId || !apiBaseUrl || !room || !token) return '';
    return `${apiBaseUrl}/v1/sessions/${encodeURIComponent(room)}/media/${encodeURIComponent(transport.song.assetId)}?token=${encodeURIComponent(token)}`;
  }, [apiBaseUrl, room, token, transport.song]);

  const onYoutubeReady = (slotId) => (event) => {
    playerRefs.current.set(slotId, event.target);
    const slot = slotRefs.current.get(slotId);
    if (!slot) return;
    if (slot.mode === 'active') {
      if (transportRef.current.status !== 'paused' && transportRef.current.status !== 'stopped') startActiveSlot(slotId);
      return;
    }
    if (slot.mode === 'preparing') {
      event.target.mute?.();
      event.target.setVolume?.(0);
      event.target.playVideo?.();
      reportPreloadStatus(slotId, 'preparing', { phase: 'iframe 준비됨', position: 0 });
    }
  };

  const onYoutubeState = (slotId) => (event) => {
    const slot = slotRefs.current.get(slotId);
    if (!slot) return;

    if (slot.mode === 'preparing') {
      const position = Number(event.target.getCurrentTime?.() || 0);
      const phase = { 0: '종료 신호', 1: '재생 신호', 2: '일시정지 신호', 3: '버퍼링 신호' }[event.data] || `상태 ${event.data}`;
      reportPreloadStatus(slotId, 'preparing', { phase, position });
      if (event.data === 1) startPreparationWatch(slotId, 'standby');
      return;
    }
    if (slot.mode === 'failed') return;
    if (slot.mode !== 'active') return;

    const states = { 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering' };
    const type = states[event.data];
    if (!type) return;
    const position = Number(event.target.getCurrentTime?.() || 0);
    const duration = Number(event.target.getDuration?.() || 0);

    if (!slot.prepared) {
      if (type === 'playing') startPreparationWatch(slotId, 'active');
      // Keep the shared transport in `loading` until the real song timeline
      // moves. Buffering or a pre-roll must not make the console look on-air.
      if (type !== 'ended') return;
    }
    updateActiveStatus(type, position, duration);
  };

  const onYoutubeError = (slotId) => (event) => {
    const slot = slotRefs.current.get(slotId);
    if (!slot) return;
    if (slot.mode === 'preparing') {
      setSlot(slotId, { ...slot, mode: 'failed', prepared: false });
      reportPreloadStatus(slotId, 'failed', { phase: `YouTube 오류 ${event.data}`, position: 0 });
      return;
    }
    if (slot.mode === 'active') sendEvent({ type: 'error', message: `YouTube 재생 오류 (${event.data})` });
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
    updateActiveStatus(type, position, Number.isFinite(duration) ? duration : undefined);
  };

  const hasSlots = youtubeSlots.length > 0;
  const shouldRenderLocal = transport.song?.type === 'local';
  if (!hasSlots && !shouldRenderLocal) return <div className="on-air-player-idle" aria-label="On-Air player waiting" />;

  return (
    <>
      {hasSlots && (
        <div className="on-air-player" aria-hidden="true">
          {youtubeSlots.map((slot) => (
            <YouTube
              key={`${slot.id}:${slot.song.src}`}
              videoId={slot.song.src}
              opts={{ width: '200', height: '200', playerVars: { autoplay: 1, controls: 0, origin: window.location.origin } }}
              onReady={onYoutubeReady(slot.id)}
              onStateChange={onYoutubeState(slot.id)}
              onError={onYoutubeError(slot.id)}
            />
          ))}
        </div>
      )}
      {shouldRenderLocal && transport.song.mediaType === 'video' && (
        <video ref={mediaRef} className="on-air-player" src={localMediaUrl} playsInline onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />
      )}
      {shouldRenderLocal && transport.song.mediaType !== 'video' && (
        <audio ref={mediaRef} className="on-air-player" src={localMediaUrl} onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />
      )}
    </>
  );
}
