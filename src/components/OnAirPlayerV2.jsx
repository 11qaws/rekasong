import React, { useEffect, useRef, useState } from 'react';

import { OnAirPlaybackAdapter } from '../lib/onAirPlaybackAdapter';
import {
  createOnAirPrefetchCache,
  ON_AIR_PREFETCH_MAX_CACHED_BYTES,
} from '../lib/onAirPrefetchCache';
import { evaluateOnAirPlayerOutputPath } from '../lib/onAirPlayerOutputPath';
import { PLAYER_CLIENT_KINDS, SERVER_MESSAGE_TYPES } from '../lib/onAirProtocol';
import { createOnAirSourceResolver } from '../lib/onAirSourceResolver';
import { ON_AIR_V2_CONNECTION_STATES } from '../lib/onAirV2Connection';
import { createObsRuntimeAttestation } from '../lib/obsRuntimeAttestation';

const BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID || 'rekasong-web-v2');
const PLAYER_CLIENT_KIND_SET = new Set(Object.values(PLAYER_CLIENT_KINDS));

function safeNotify(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch {
    // Observability callbacks never own playback or connection state.
  }
}

function playerSocketUrl(apiBaseUrl, room, token) {
  const url = new URL(`/v1/sessions/${encodeURIComponent(room)}/ws`, apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'player');
  url.searchParams.set('token', token);
  url.searchParams.set('protocol', '2');
  return url.toString();
}

/**
 * Explicit Protocol v2 player. Widget keeps the legacy player as the default
 * rollback path; only URLs carrying protocol=2 mount this component.
 */
export default function OnAirPlayerV2({
  apiBaseUrl,
  room,
  token,
  clientKind: requestedClientKind = null,
  onSnapshot = null,
  onStateChange = null,
}) {
  const audioRef = useRef(null);
  const callbacksRef = useRef({ onSnapshot, onStateChange });
  callbacksRef.current = { onSnapshot, onStateChange };
  const [localState, setLocalState] = useState('initializing');

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !apiBaseUrl || !room || !token) {
      setLocalState('invalid_configuration');
      return undefined;
    }

    let disposed = false;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let adapter = null;
    let prefetchCache = null;
    const hasExplicitClientKind = requestedClientKind !== null
      && requestedClientKind !== undefined;
    if (hasExplicitClientKind && !PLAYER_CLIENT_KIND_SET.has(requestedClientKind)) {
      setLocalState('invalid_configuration');
      return undefined;
    }
    const isDashboardSpeaker = requestedClientKind === PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER;
    // A dashboard speaker is a normal DOM output and must not depend on the
    // OBS JavaScript binding or its source-active events.
    const runtime = isDashboardSpeaker
      ? null
      : createObsRuntimeAttestation({ windowObject: window });
    const clientKind = requestedClientKind || (runtime.capabilities.obsRuntime
      ? PLAYER_CLIENT_KINDS.OBS_BROWSER_SOURCE
      : PLAYER_CLIENT_KINDS.GENERIC_BROWSER);

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      reconnectAttempts += 1;
      const delay = Math.min(30_000, 1_500 * (1.5 ** (reconnectAttempts - 1)));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (disposed) return;
        try {
          adapter.connect();
        } catch {
          setLocalState('connection_failed');
          scheduleReconnect();
        }
      }, delay);
    };

    try {
      const resolverConfig = {
        baseUrl: apiBaseUrl,
        room,
        token,
      };
      // A browser-source renderer is long-lived and shares memory with OBS.
      // Keep one active source and one prefetched source within 128 MiB total;
      // larger medleys need a future disk-backed source policy.
      const loadResolver = createOnAirSourceResolver({
        ...resolverConfig,
        maxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES,
      });
      const prefetchResolver = createOnAirSourceResolver({
        ...resolverConfig,
        maxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES,
      });
      prefetchCache = createOnAirPrefetchCache({
        loadResolver,
        prefetchResolver,
        loadResolverMaxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES,
      });
      adapter = new OnAirPlaybackAdapter({
        connectionOptions: {
          url: playerSocketUrl(apiBaseUrl, room, token),
          webSocketFactory: (url) => new WebSocket(url),
          buildId: BUILD_ID,
          clientKind,
          capabilities: {
            audioWorklet: typeof AudioWorkletNode === 'function',
            analyser: typeof AudioContext === 'function',
            sinkSelection: typeof audio.setSinkId === 'function',
            ...(runtime?.capabilities || {
              obsRuntime: false,
              obsStudioBinding: false,
            }),
          },
          onStateChange(change) {
            setLocalState(change.state);
            safeNotify(callbacksRef.current.onStateChange, change);
            if (change.state === ON_AIR_V2_CONNECTION_STATES.READY) {
              reconnectAttempts = 0;
            } else if (change.state === ON_AIR_V2_CONNECTION_STATES.DISCONNECTED) {
              Promise.resolve(prefetchCache?.prefetch([])).catch(() => {});
              scheduleReconnect();
            }
          },
          onFrame(frame) {
            if (frame?.type === SERVER_MESSAGE_TYPES.SESSION_ENDED) {
              prefetchCache?.dispose();
            }
          },
        },
        engineOptions: { audio },
        sourceResolver: prefetchCache.resolveSource,
        prefetchSources: prefetchCache.prefetch,
        runtimeProbe: () => runtime?.runtime() || {},
        outputPathProbe: ({ engine, signal }) => evaluateOnAirPlayerOutputPath({
          clientKind,
          audio,
          engine,
          signal,
          obsAttestation: runtime?.snapshot() || null,
        }),
        onSnapshot(snapshot) {
          if (!disposed) {
            setLocalState(snapshot.routeState);
            safeNotify(callbacksRef.current.onSnapshot, snapshot);
          }
        },
      });
      adapter.connect();
    } catch {
      setLocalState('initialization_failed');
    }

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      adapter?.dispose();
      prefetchCache?.dispose();
      runtime?.dispose();
    };
  }, [apiBaseUrl, requestedClientKind, room, token]);

  return (
    <div data-on-air-player-v2-state={localState} aria-hidden="true">
      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
    </div>
  );
}
