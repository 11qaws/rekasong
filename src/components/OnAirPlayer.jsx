import React, { useEffect, useMemo, useRef, useState } from 'react';
import { prepareAudioUrl } from '../lib/preparePipeline';

// Stage 6b: 방송 출력(OBS 위젯)에서 YouTube iframe을 완전히 제거했다.
// YouTube 곡은 준비 파이프라인이 R2에 확정한 오디오(/v1/audio/{videoId})를
// 로컬 파일과 같은 <audio>로 재생한다 — 광고가 나갈 수 있는 경로는 어떤
// 조건에서도 존재하지 않으며, 실패는 항상 무음(error 이벤트→대시보드 failed)이다.

const websocketUrl = (baseUrl, path) => {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const eventId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function OnAirPlayer({ apiBaseUrl, room, token }) {
  const [transport, setTransport] = useState({ status: 'idle', song: null, position: 0, volume: 100, sessionId: null });
  const mediaRef = useRef(null);
  const socketRef = useRef(null);
  const lastProgressRef = useRef(0);
  const transportRef = useRef(transport);
  // 시작 타임아웃 해제 근거: 어느 sessionId의 미디어가 실제로 열렸는지 기록.
  const mediaReadySessionRef = useRef(null);

  // ── 프리버퍼(pre-buffer) 캐시 ──────────────────────────────────────────
  // 대시보드의 prefetch 힌트(다가오는 곡 videoId, 최대 2개)를 받아 준비된
  // 오디오를 미리 통째로 받아 둔다: videoId → objectURL. 곡 전환을 즉시 만들기
  // 위한 순수 최적화로, 실패·미스는 항상 기존 스트리밍 URL 재생으로 무손실
  // 폴백된다 — 재생 이벤트 경로는 blob이든 스트리밍이든 완전히 동일하다.
  const prefetchCacheRef = useRef(new Map()); // videoId → objectURL (최대 2곡 — 긴 메들리 blob은 수십 MB라 메모리 방어)
  const prefetchInFlightRef = useRef(new Set());
  // applyCommand(소켓 핸들러)가 props를 직접 캡처하지 않게 하는 거울 ref —
  // 소켓 effect는 기존처럼 [apiBaseUrl, room, token]에만 의존한다(값은 동일).
  const prefetchAuthRef = useRef({ apiBaseUrl, room, token });
  prefetchAuthRef.current = { apiBaseUrl, room, token };
  const prefetchWantedRef = useRef([]); // 마지막으로 받은 prefetch 힌트 목록
  // 이 곡(sessionId)의 재생 src 확정값 — 곡당 1회, 첫 렌더에서 결정(sticky).
  const playbackSrcRef = useRef({ sessionId: null, videoId: null, src: '' });
  // blob 도착을 렌더에 반영하는 카운터. src 선택은 sessionId당 1회로 고정되므로
  // 재생 중 곡의 src가 뒤바뀌는 일은 없다(아래 렌더 주석 참조).
  const [, setPrefetchVersion] = useState(0);

  // 최신 힌트 목록에 없는 캐시를 회수한다. 지금 재생에 물린 URL만 보류 —
  // 재생 중 revokeObjectURL은 미디어 fetch를 끊을 수 있다. 보류분은 곡이 바뀐
  // 뒤의 sweep(sessionId effect)에서 회수된다.
  const sweepPrefetchCache = () => {
    const cache = prefetchCacheRef.current;
    for (const [videoId, url] of [...cache.entries()]) {
      if (prefetchWantedRef.current.includes(videoId)) continue;
      if (url && url === playbackSrcRef.current.src) continue;
      URL.revokeObjectURL(url);
      cache.delete(videoId);
    }
  };

  // 세션 종료·언마운트용 전체 회수(멱등).
  const clearPrefetchCache = () => {
    prefetchWantedRef.current = [];
    playbackSrcRef.current = { sessionId: null, videoId: null, src: '' };
    prefetchCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
    prefetchCacheRef.current.clear();
  };

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
    if (command.type === 'prefetch') {
      // 다가오는 곡의 준비된 오디오를 미리 통째로 받는다(최대 2곡).
      // transport는 일절 건드리지 않는다 — 이 명령은 캐시 힌트일 뿐이다.
      const wanted = (Array.isArray(command.videoIds) ? command.videoIds : [])
        .filter((id) => typeof id === 'string' && id)
        .slice(0, 2);
      prefetchWantedRef.current = wanted;
      sweepPrefetchCache();
      wanted.forEach((videoId) => {
        if (prefetchCacheRef.current.has(videoId) || prefetchInFlightRef.current.has(videoId)) return;
        prefetchInFlightRef.current.add(videoId);
        const auth = prefetchAuthRef.current;
        fetch(prepareAudioUrl(auth.apiBaseUrl, videoId, { room: auth.room, token: auth.token }))
          .then((response) => {
            if (!response.ok) throw new Error(`prefetch ${response.status}`);
            return response.blob();
          })
          .then((blob) => {
            // 받는 사이 힌트가 바뀌었으면 버린다 — 캐시 2곡 상한 유지.
            if (!prefetchWantedRef.current.includes(videoId)) return;
            prefetchCacheRef.current.set(videoId, URL.createObjectURL(blob));
            setPrefetchVersion((version) => version + 1);
          })
          .catch(() => {
            // 실패는 조용히 무시 — 재생은 기존 스트리밍 경로로 무손실 폴백.
          })
          .finally(() => prefetchInFlightRef.current.delete(videoId));
      });
      return;
    }
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
      mediaRef.current?.play?.().catch(() => sendEvent({ type: 'error', message: '브라우저가 재생을 차단했습니다.' }));
      return;
    }
    if (command.type === 'pause') {
      mediaRef.current?.pause?.();
      return;
    }
    if (command.type === 'seek') {
      if (mediaRef.current) mediaRef.current.currentTime = Number(command.position) || 0;
      return;
    }
    if (command.type === 'volume') {
      const volume = Math.max(0, Math.min(100, Number(command.volume) || 0));
      setTransport((previous) => ({ ...previous, volume }));
      if (mediaRef.current) mediaRef.current.volume = volume / 100;
      return;
    }
    if (command.type === 'stop') {
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
            mediaRef.current?.pause?.();
            clearPrefetchCache(); // 세션 종료 — 프리버퍼 blob 전부 회수
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
      const position = mediaRef.current?.currentTime;
      const duration = mediaRef.current?.duration;
      if (Number.isFinite(position)) sendEvent({ type: 'position', position, duration: Number.isFinite(duration) ? duration : undefined });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [transport.status, transport.sessionId]);

  // 곡 전환·정지 시 프리버퍼 캐시 정리: 직전 곡 재생에 보류돼 있던 blob 등
  // 최신 힌트에 없는 항목을 회수한다. key={sessionId} 리마운트로 이전 <audio>가
  // 이미 내려간 뒤(커밋 후)라 revoke가 진행 중 재생을 건드리지 않는다.
  useEffect(() => {
    if (playbackSrcRef.current.sessionId !== transport.sessionId) {
      playbackSrcRef.current = { sessionId: transport.sessionId, videoId: null, src: '' };
    }
    sweepPrefetchCache();
    // eslint 참고: sweepPrefetchCache는 ref만 읽는 안정적 로직 — sessionId 전환에만 반응한다.
  }, [transport.sessionId]);

  // 언마운트 시 프리버퍼 blob 전부 회수(메모리 누수 방지).
  useEffect(() => () => clearPrefetchCache(), []);

  // 같은 곡을 다시 load(재시도 run)하면 key/src가 그대로라 요소가 리마운트되지
  // 않고 canplay도 다시 오지 않는다 — 이미 열려 있는 미디어면 즉시 ready 경로를
  // 밟는다(첫 로드에서는 readyState가 낮아 no-op, canplay가 담당).
  const onMediaReadyRef = useRef(null);
  useEffect(() => {
    if (transport.status !== 'loading') return;
    const media = mediaRef.current;
    if (!media) return;
    if (media.error) {
      media.load(); // 오류로 끝난 같은 src의 재시도 — 다시 받아 canplay를 기다린다.
      return;
    }
    if (media.readyState >= 2) onMediaReadyRef.current?.();
  }, [transport.status, transport.sessionId]);

  // Stage 6b fail-safe: 준비된 오디오가 열리지 않으면(onError조차 안 오는 무응답
  // 포함) 시작 타임아웃으로 error 이벤트를 올린다 — 대시보드가 failed(무음)로
  // 확정한다. iframe 재시도 같은 폴백은 존재하지 않는다.
  useEffect(() => {
    if (transport.song?.type !== 'youtube' || transport.status !== 'loading') return undefined;
    const sessionId = transport.sessionId;
    const timer = window.setTimeout(() => {
      if (mediaReadySessionRef.current === sessionId) return;
      sendEvent({ type: 'error', message: '준비된 오디오를 열지 못했습니다(응답 없음).' });
    }, 12000);
    return () => window.clearTimeout(timer);
    // eslint 참고: sendEvent는 socketRef 기반이라 재생성돼도 동작이 같다.
  }, [transport.sessionId, transport.song, transport.status]);

  const localMediaUrl = useMemo(() => {
    if (transport.song?.type !== 'local' || !transport.song?.assetId || !apiBaseUrl || !room || !token) return '';
    return `${apiBaseUrl}/v1/sessions/${encodeURIComponent(room)}/media/${encodeURIComponent(transport.song.assetId)}?token=${encodeURIComponent(token)}`;
  }, [apiBaseUrl, room, token, transport.song]);

  // 준비 파이프라인이 R2에 캐시한 오디오(계약 §3). 준비되지 않은 곡은 대시보드
  // 게이팅(ready가 아니면 load 명령 자체가 없음)이 막고, 여기 도달한 뒤의 실패도
  // 무음으로 끝난다. 접근은 이 위젯의 player 토큰으로 게이트된다(오픈 프록시 금지).
  const preparedAudioSrc = useMemo(() => {
    if (transport.song?.type !== 'youtube' || !transport.song?.src || !apiBaseUrl || !room || !token) return '';
    return prepareAudioUrl(apiBaseUrl, transport.song.src, { room, token });
  }, [apiBaseUrl, room, token, transport.song]);

  // 초기 위치 복원을 이 곡(sessionId)당 1회만 적용했는지 기록.
  const positionAppliedRef = useRef(null);
  const onMediaReady = () => {
    const media = mediaRef.current;
    if (!media) return;
    mediaReadySessionRef.current = transportRef.current.sessionId;
    media.volume = transport.volume / 100;
    // 초기 위치(재개 지점) 복원은 곡 로드 시 1회만. canplay 는 seek 마다 다시
    // 발화하므로, 매번 transport.position 을 다시 적용하면 앞 seek 시
    // seek→canplay→같은 위치 재적용→seek… 무한 루프가 되어 재생이 rs1 에서
    // 멈춘다(실측). 이후의 위치 이동은 seek 명령이 직접 담당한다.
    if (positionAppliedRef.current !== transport.sessionId) {
      positionAppliedRef.current = transport.sessionId;
      if (transport.position) media.currentTime = transport.position;
    }
    if (['loading', 'playing', 'buffering'].includes(transport.status)) {
      media.play().catch(() => sendEvent({ type: 'error', message: '브라우저가 재생을 차단했습니다.' }));
    }
    sendEvent({ type: 'ready', duration: media.duration || 0 });
  };
  onMediaReadyRef.current = onMediaReady;

  const onMediaEvent = (type) => () => {
    const position = mediaRef.current?.currentTime || 0;
    const duration = mediaRef.current?.duration;
    setTransport((previous) => ({ ...previous, status: type, position }));
    sendEvent({ type, position, duration: Number.isFinite(duration) ? duration : undefined });
  };

  // 실패 문구는 광고가 아니라 '준비된 오디오'의 언어로(계약 §5).
  const onPreparedAudioError = () => {
    const errorCode = mediaRef.current?.error?.code;
    const details = {
      1: '가져오기가 중단됨',
      2: '방송 출력 서버에 연결할 수 없음',
      3: '준비된 오디오가 손상되었거나 지원되지 않음',
      4: '준비된 오디오를 열 수 없음(만료·권한 확인 필요)'
    };
    setTransport((previous) => ({ ...previous, status: 'error' }));
    sendEvent({ type: 'error', message: `준비된 오디오 재생 오류: ${details[errorCode] || '알 수 없는 오류'}` });
  };

  if (!transport.song) return <div className="on-air-player-idle" aria-label="On-Air player waiting" />;

  if (transport.song.type === 'youtube') {
    // 프리버퍼 적용: 이 곡의 재생 src는 곡(sessionId)당 1회, 첫 렌더에서
    // 확정한다(sticky — 렌더당 멱등한 지연 초기화라 StrictMode에도 안전).
    // 재생 도중 캐시가 뒤늦게 채워져도 src를 바꾸지 않는다 — <audio src> 교체는
    // 요소를 리셋해 재생을 처음부터 다시 시작시키기 때문. 캐시 미스·프리페치
    // 실패는 기존 스트리밍 URL 그대로(무손실 폴백)이며, 이벤트 배선·시작
    // 타임아웃·위치복원(positionAppliedRef)은 두 경로가 완전히 동일하다.
    if (playbackSrcRef.current.sessionId !== transport.sessionId) {
      playbackSrcRef.current = {
        sessionId: transport.sessionId,
        videoId: transport.song.src,
        src: prefetchCacheRef.current.get(transport.song.src) || ''
      };
    }
    // key={sessionId}: 곡(entry)이 바뀌면 요소를 새로 만들어 이전 곡의 늦은
    // 이벤트·버퍼가 새 곡을 오염시키지 않게 한다(구 iframe과 동일 규약).
    return (
      <audio
        key={transport.sessionId}
        ref={mediaRef}
        className="on-air-player"
        src={playbackSrcRef.current.src || preparedAudioSrc}
        preload="auto"
        onCanPlay={onMediaReady}
        onPlay={onMediaEvent('playing')}
        onPause={onMediaEvent('paused')}
        onEnded={onMediaEvent('ended')}
        onWaiting={onMediaEvent('buffering')}
        onError={onPreparedAudioError}
      />
    );
  }

  if (transport.song.mediaType === 'video') {
    return <video ref={mediaRef} className="on-air-player" src={localMediaUrl} playsInline onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />;
  }

  return <audio ref={mediaRef} className="on-air-player" src={localMediaUrl} onCanPlay={onMediaReady} onPlay={onMediaEvent('playing')} onPause={onMediaEvent('paused')} onEnded={onMediaEvent('ended')} onWaiting={onMediaEvent('buffering')} onError={onMediaEvent('error')} />;
}
