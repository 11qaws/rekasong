import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { createLocalSpeakerController } from '../lib/localSpeakerController.js';
import { applySpeakerOutputDevice } from '../lib/speakerOutputDevice.js';
import { createSpeakerSourcePipeline } from '../lib/speakerSourceResolver.js';

/**
 * The dashboard's normal music-player output. Page-owned local files play
 * immediately; prepared media acquires HTTP credentials only when requested.
 * Playback itself never depends on an output lease, heartbeat, or OBS proof.
 */
const DashboardLocalSpeaker = forwardRef(function DashboardLocalSpeaker({
  apiBaseUrl,
  ensureSession,
  sinkId = '',
  onEvidence = null,
  onSinkError = null,
  onStateChange = null,
}, ref) {
  const audioRef = useRef(null);
  const controllerRef = useRef(null);
  const callbacksRef = useRef({ onEvidence, onSinkError, onStateChange });
  const [state, setState] = useState('initializing');
  callbacksRef.current = { onEvidence, onSinkError, onStateChange };

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
    setSinkId(deviceId) {
      return applySpeakerOutputDevice(audioRef.current, deviceId);
    },
  }), []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || typeof audio.setSinkId !== 'function') return undefined;
    let cancelled = false;
    applySpeakerOutputDevice(audio, sinkId).catch((error) => {
      if (!cancelled) callbacksRef.current.onSinkError?.(error);
    });
    return () => { cancelled = true; };
  }, [sinkId]);

  useEffect(() => {
    setState('initializing');
    callbacksRef.current.onStateChange?.('initializing');
    const audio = audioRef.current;
    if (!audio || !apiBaseUrl || typeof ensureSession !== 'function') {
      setState('invalid_configuration');
      callbacksRef.current.onStateChange?.('invalid_configuration');
      return undefined;
    }

    let disposed = false;
    let sourcePipeline = null;
    let controller = null;
    try {
      sourcePipeline = createSpeakerSourcePipeline({
        baseUrl: apiBaseUrl,
        ensureSession,
      });
      controller = createLocalSpeakerController({
        audio,
        resolveSource: sourcePipeline.resolveSource,
        prefetchSources: sourcePipeline.prefetch,
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
      sourcePipeline?.dispose();
    };
  }, [apiBaseUrl, ensureSession]);

  return (
    <div data-local-speaker-state={state} aria-hidden="true">
      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
    </div>
  );
});

export default DashboardLocalSpeaker;
