import { useEffect, useRef } from 'react';
import { useTranscriptStore } from '../store/useTranscriptStore.js';
import { mediaLog } from '../utils/mediaLogger.js';

export default function useTranscript({ localAudioTrack, socket, roomId, enabled, paused = false }) {
  const cleanupRef = useRef(null);
  const pipelineIdRef = useRef(null);
  const pausedRef = useRef(paused);
  const audioContextRef = useRef(null);
  const socketRef = useRef(socket);
  const roomIdRef = useRef(roomId);
  const lastSeqRef = useRef(0);
  const emittedChunksRef = useRef(0);

  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => {
    const wasPaused = pausedRef.current;
    pausedRef.current = paused;
    mediaLog('info', 'transcript pipeline pause changed', { roomId, paused });
    if (wasPaused && !paused) {
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        mediaLog('info', 'transcript resuming suspended audioContext on unpause', { roomId });
        ctx.resume().catch((err) => {
          mediaLog('warn', 'transcript audioContext resume on unpause failed', { roomId, reason: err.message });
        });
      }
    }
  }, [paused, roomId]);

  useEffect(() => {
    if (!enabled || !localAudioTrack || !socketRef.current || !roomIdRef.current) return;
    if (!window.AudioWorklet) {
      mediaLog('warn', 'transcript audio worklet unsupported', { roomId: roomIdRef.current });
      return;
    }
    if (cleanupRef.current && pipelineIdRef.current === localAudioTrack) {
      mediaLog('warn', 'transcript duplicate pipeline prevented', { roomId: roomIdRef.current });
      return;
    }

    let destroyed = false;
    let audioContext = null;
    let source = null;
    let workletNode = null;
    let mediaStreamTrack = null;
    let healthTimer = null;
    lastSeqRef.current = 0;
    emittedChunksRef.current = 0;
    pipelineIdRef.current = localAudioTrack;

    const handlePartial = ({ text, sequenceNumber }) => {
      if (sequenceNumber != null && sequenceNumber <= lastSeqRef.current) return;
      useTranscriptStore.getState().setPartialText(text || '');
    };

    const handleFinal = ({ fullText, sequenceNumber }) => {
      if (sequenceNumber != null && sequenceNumber < lastSeqRef.current) return;
      lastSeqRef.current = sequenceNumber || 0;
      useTranscriptStore.getState().setText(fullText);
      useTranscriptStore.getState().setPartialText('');
      useTranscriptStore.getState().setTranscriptionUnavailable(false);
    };

    const handleError = ({ message }) => {
      mediaLog('warn', 'transcript server error', { roomId: roomIdRef.current, reason: message });
      useTranscriptStore.getState().setTranscriptionUnavailable(true);
    };

    async function startPipeline() {
      try {
        mediaStreamTrack = localAudioTrack.getMediaStreamTrack();
        if (!mediaStreamTrack || mediaStreamTrack.readyState === 'ended') {
          mediaLog('warn', 'transcript media track unavailable', { roomId: roomIdRef.current });
          return;
        }

        mediaStreamTrack.addEventListener('ended', handleTrackEnded);
        mediaStreamTrack.addEventListener('mute', handleTrackMuted);
        mediaStreamTrack.addEventListener('unmute', handleTrackUnmuted);

        const stream = new MediaStream([mediaStreamTrack]);
        audioContext = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioContext;
        await audioContext.audioWorklet.addModule('/audio-processor.js');
        source = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        source.connect(workletNode);

        workletNode.port.onmessage = async (event) => {
          if (destroyed || pausedRef.current) return;
          if (audioContext?.state === 'suspended') {
            try {
              await audioContext.resume();
            } catch (err) {
              mediaLog('warn', 'transcript audio context resume failed', { roomId: roomIdRef.current, reason: err.message });
            }
          }

          const buffer = event.data;
          const sock = socketRef.current;
          if (buffer && buffer.byteLength > 0 && sock?.connected) {
            sock.emit('transcript:audio-chunk', buffer);
            emittedChunksRef.current++;
          }
        };

        const sock = socketRef.current;
        sock.on('transcript:partial', handlePartial);
        sock.on('transcript:final', handleFinal);
        sock.on('transcript:error', handleError);
        sock.on('connect', handleSocketConnect);
        sock.on('disconnect', handleSocketDisconnect);

        healthTimer = setInterval(() => {
          mediaLog('info', 'transcript pipeline health', {
            roomId: roomIdRef.current,
            chunks: emittedChunksRef.current,
            paused: pausedRef.current,
            socketConnected: socketRef.current?.connected,
            trackState: mediaStreamTrack?.readyState,
            trackEnabled: mediaStreamTrack?.enabled,
            audioContextState: audioContextRef.current?.state,
          });
        }, 15000);
        healthTimer.unref?.();

        cleanupRef.current = cleanup;
        mediaLog('info', 'transcript pipeline started', { roomId: roomIdRef.current });
      } catch (err) {
        mediaLog('error', 'transcript pipeline error', { roomId: roomIdRef.current, reason: err.message });
      }
    }

    function handleTrackEnded() {
      mediaLog('warn', 'transcript media track ended', { roomId: roomIdRef.current });
      useTranscriptStore.getState().setTranscriptionUnavailable(true);
    }

    function handleTrackMuted() {
      mediaLog('info', 'transcript media track muted', { roomId: roomIdRef.current });
    }

    function handleTrackUnmuted() {
      mediaLog('info', 'transcript media track unmuted', { roomId: roomIdRef.current });
      audioContext?.resume?.().catch((err) => {
        mediaLog('warn', 'transcript resume after unmute failed', { roomId: roomIdRef.current, reason: err.message });
      });
    }

    function handleSocketConnect() {
      mediaLog('info', 'transcript socket connected', { roomId: roomIdRef.current });
    }

    function handleSocketDisconnect(reason) {
      mediaLog('warn', 'transcript socket disconnected', { roomId: roomIdRef.current, reason });
    }

    function cleanup() {
      const sock = socketRef.current;
      sock?.off('transcript:partial', handlePartial);
      sock?.off('transcript:final', handleFinal);
      sock?.off('transcript:error', handleError);
      sock?.off('connect', handleSocketConnect);
      sock?.off('disconnect', handleSocketDisconnect);
      clearInterval(healthTimer);
      mediaStreamTrack?.removeEventListener('ended', handleTrackEnded);
      mediaStreamTrack?.removeEventListener('mute', handleTrackMuted);
      mediaStreamTrack?.removeEventListener('unmute', handleTrackUnmuted);
      audioContextRef.current = null;

      try {
        workletNode?.disconnect();
        source?.disconnect();
        if (audioContext && audioContext.state !== 'closed') audioContext.close();
      } catch (err) {
        mediaLog('warn', 'transcript cleanup failed', { roomId: roomIdRef.current, reason: err.message });
      }
      mediaLog('info', 'transcript pipeline stopped', { roomId: roomIdRef.current });
    }

    startPipeline();

    return () => {
      destroyed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      pipelineIdRef.current = null;
      useTranscriptStore.getState().setPartialText('');
    };
  }, [localAudioTrack, enabled]);
}
