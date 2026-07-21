import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { createLocalSpeakerController } from '../lib/localSpeakerController.js';
import {
  createOnAirPrefetchCache,
  ON_AIR_PREFETCH_MAX_CACHED_BYTES,
} from '../lib/onAirPrefetchCache.js';
import { createOnAirSourceResolver } from '../lib/onAirSourceResolver.js';

/**
 * The dashboard's normal music-player output. It downloads prepared media
 * through the authenticated session, but playback itself is browser-local and
 * never depends on an output lease, a player heartbeat, or OBS attestation.
 */
const DashboardLocalSpeaker = forwardRef(function DashboardLocalSpeaker({
  apiBaseUrl,
  room,
  token,
  onEvidence = null,
  onStateChange = null,
}, ref) {
  const audioRef = useRef(null);
  const controllerRef = useRef(null);
  const callbacksRef = useRef({ onEvidence, onStateChange });
  const [state, setState] = useState('initializing');
  callbacksRef.current = { onEvidence, onStateChange };

  useImperativeHandle(ref, () => ({
    sendCommand(command) {
      const controller = controllerRef.current;
      if (!controller) return Promise.reject(new Error('local_speaker_not_ready'));
      try {
        return Promise.resolve(controller.sendCommand(command));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    snapshot() {
      return controllerRef.current?.snapshot() ?? null;
    },
  }), []);

  useEffect(() => {
    setState('initializing');
    callbacksRef.current.onStateChange?.('initializing');
    const audio = audioRef.current;
    if (!audio || !apiBaseUrl || !room || !token) {
      setState('invalid_configuration');
      callbacksRef.current.onStateChange?.('invalid_configuration');
      return undefined;
    }

    let disposed = false;
    let prefetchCache = null;
    let controller = null;
    try {
      const resolverConfig = { baseUrl: apiBaseUrl, room, token };
      const loadResolver = createOnAirSourceResolver({
        ...resolverConfig,
        maxBytes: 200 * 1024 * 1024,
      });
      const prefetchResolver = createOnAirSourceResolver({
        ...resolverConfig,
        maxBytes: ON_AIR_PREFETCH_MAX_CACHED_BYTES,
      });
      prefetchCache = createOnAirPrefetchCache({
        loadResolver,
        prefetchResolver,
        loadResolverMaxBytes: 200 * 1024 * 1024,
      });
      controller = createLocalSpeakerController({
        audio,
        resolveSource: prefetchCache.resolveSource,
        prefetchSources: prefetchCache.prefetch,
        onEvidence(evidence) {
          if (disposed) return;
          callbacksRef.current.onEvidence?.(evidence);
        },
      });
      controllerRef.current = controller;
      setState('ready');
      callbacksRef.current.onStateChange?.('ready');
    } catch (error) {
      setState('failed');
      callbacksRef.current.onStateChange?.('failed', error);
    }

    return () => {
      disposed = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.dispose();
      prefetchCache?.dispose();
    };
  }, [apiBaseUrl, room, token]);

  return (
    <div data-local-speaker-state={state} aria-hidden="true">
      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
    </div>
  );
});

export default DashboardLocalSpeaker;
