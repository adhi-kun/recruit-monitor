import { useEffect, useRef } from 'react';
import { DEEPGRAM_API_KEY } from '../config.js';
import { useTranscriptStore } from '../store/useTranscriptStore.js';

export default function useTranscript({ localAudioTrack, socket, roomId, enabled }) {
  const retryCountRef = useRef(0);
  const maxRetries = 5;
  const cleanupRef = useRef(null);

  useEffect(() => {
    if (!enabled || !localAudioTrack || !socket || !roomId) return;

    // Feature detection
    if (!window.AudioWorklet) {
      console.warn('AudioWorklet not supported — transcription disabled');
      return;
    }

    let destroyed = false;

    async function startPipeline() {
      let audioContext = null;
      let source = null;
      let workletNode = null;
      let ws = null;

      try {
        // Get the underlying MediaStreamTrack from the Agora audio track
        const mediaStreamTrack = localAudioTrack.getMediaStreamTrack();
        const stream = new MediaStream([mediaStreamTrack]);

        audioContext = new AudioContext({ sampleRate: 16000 });
        await audioContext.audioWorklet.addModule('/audio-processor.js');

        source = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        source.connect(workletNode);
        // Do NOT connect workletNode to audioContext.destination — causes echo

        // Deepgram WebSocket
        ws = new WebSocket(
          'wss://api.deepgram.com/v1/listen' +
          '?model=nova-2&language=en&punctuate=true' +
          '&interim_results=false' +
          '&endpointing=500' +
          '&smart_format=true' +
          '&encoding=linear16' +
          '&sample_rate=16000' +
          '&channels=1',
          ['token', DEEPGRAM_API_KEY]
        );

        ws.onopen = () => {
          console.log('Deepgram WebSocket connected');
          retryCountRef.current = 0; // Reset retries on successful connection
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const transcript = data?.channel?.alternatives?.[0]?.transcript;
            if (data.is_final && transcript) {
              const current = useTranscriptStore.getState().text;
              const newText = current + (current ? ' ' : '') + transcript;
              useTranscriptStore.getState().setText(newText);
              socket.emit('transcript:update', { roomId, text: newText });
            }
          } catch (err) {
            console.warn('Deepgram message parse error:', err);
          }
        };

        ws.onerror = (err) => {
          console.warn('Deepgram WebSocket error:', err);
        };

        ws.onclose = (event) => {
          console.log('Deepgram WebSocket closed:', event.code, event.reason);
          if (!destroyed && event.code !== 1000 && retryCountRef.current < maxRetries) {
            const delay = Math.pow(2, retryCountRef.current) * 1000;
            retryCountRef.current++;
            console.log(`Deepgram reconnecting in ${delay}ms (attempt ${retryCountRef.current})`);
            setTimeout(() => {
              if (!destroyed) {
                cleanup();
                startPipeline();
              }
            }, delay);
          }
        };

        // Send audio data to Deepgram
        workletNode.port.onmessage = (event) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(event.data);
          }
        };

        // Store cleanup function
        cleanupRef.current = cleanup;

        function cleanup() {
          try {
            if (workletNode) workletNode.disconnect();
            if (source) source.disconnect();
            if (audioContext && audioContext.state !== 'closed') audioContext.close();
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
              ws.close(1000);
            }
          } catch (err) {
            console.warn('Transcript cleanup error:', err);
          }
        }

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
    };
  }, [localAudioTrack, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
