import { useEffect, useRef } from 'react';
import { useTranscriptStore } from '../store/useTranscriptStore.js';

export default function useTranscript({ localAudioTrack, socket, roomId, enabled }) {
  const cleanupRef = useRef(null);

  // Refs for socket and roomId — avoid stale closures without rebuilding AudioContext on every change
  const socketRef = useRef(socket);
  const roomIdRef = useRef(roomId);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  // Sequence number tracking for out-of-order event rejection
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !localAudioTrack || !socketRef.current || !roomIdRef.current) return;
    if (!window.AudioWorklet) {
      console.warn('AudioWorklet not supported — transcription disabled');
      return;
    }

    let destroyed = false;
    lastSeqRef.current = 0;

    async function startPipeline() {
      let audioContext = null;
      let source = null;
      let workletNode = null;

      try {
        const mediaStreamTrack = localAudioTrack.getMediaStreamTrack();
        const stream = new MediaStream([mediaStreamTrack]);

        audioContext = new AudioContext({ sampleRate: 16000 });
        await audioContext.audioWorklet.addModule('/audio-processor.js');
        source = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        source.connect(workletNode);
        // Do NOT connect to audioContext.destination — causes echo

        // Send raw binary to server (no JSON wrapping)
        workletNode.port.onmessage = (event) => {
          if (destroyed) return;
          const buffer = event.data; // ArrayBuffer from worklet
          const sock = socketRef.current;
          if (buffer && buffer.byteLength > 0 && sock?.connected) {
            sock.emit('transcript:audio-chunk', buffer);
          }
        };

        // Ordering enforcement on incoming events
        const handlePartial = ({ text, sequenceNumber }) => {
          if (sequenceNumber != null && sequenceNumber <= lastSeqRef.current) return; // stale
          // Partials don't advance lastSeqRef — only finals do
          useTranscriptStore.getState().setPartialText(text || '');
        };

        const handleFinal = ({ fullText, sequenceNumber }) => {
          if (sequenceNumber != null && sequenceNumber < lastSeqRef.current) return; // stale
          lastSeqRef.current = sequenceNumber || 0;
          useTranscriptStore.getState().setText(fullText);
          useTranscriptStore.getState().setPartialText('');
          useTranscriptStore.getState().setTranscriptionUnavailable(false);
        };

        const handleError = ({ message }) => {
          console.warn('Transcription error:', message);
          useTranscriptStore.getState().setTranscriptionUnavailable(true);
        };

        const sock = socketRef.current;
        sock.on('transcript:partial', handlePartial);
        sock.on('transcript:final', handleFinal);
        sock.on('transcript:error', handleError);

        cleanupRef.current = () => {
          sock.off('transcript:partial', handlePartial);
          sock.off('transcript:final', handleFinal);
          sock.off('transcript:error', handleError);
          try {
            if (workletNode) workletNode.disconnect();
            if (source) source.disconnect();
            if (audioContext && audioContext.state !== 'closed') audioContext.close();
          } catch (err) {
            console.warn('Transcript cleanup error:', err);
          }
        };

      } catch (err) {
        console.error('Transcript pipeline error:', err);
      }
    }

    startPipeline();

    return () => {
      destroyed = true;
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      useTranscriptStore.getState().setPartialText('');
    };
  }, [localAudioTrack, enabled]);
  // socket and roomId intentionally accessed via refs — adding them as deps
  // would tear down and recreate the AudioContext on every socket identity change
}
