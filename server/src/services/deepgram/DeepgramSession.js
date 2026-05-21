import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { config } from '../../config.js';

export const MAX_AUDIO_CHUNK_SIZE = 32768;    // 32 KB max per chunk
export const MAX_BUFFERED_CHUNKS  = 50;       // bounded queue depth limit
const KEEPALIVE_INTERVAL_MS       = 15000;    // 15s ping
const STALE_TIMEOUT_MS            = 30000;    // 30s no-pong -> reconnect
const INACTIVITY_TIMEOUT_MS       = 60000;    // 60s no-transcript -> reconnect
const RECONNECT_MAX_RETRIES       = 5;

export class DeepgramSession extends EventEmitter {
  constructor(roomId) {
    super();
    this.roomId = roomId;
    this._state = 'connecting';
    this._queue = [];
    this._droppedChunks = 0;
    this._sequenceNumber = 0;
    this._retryCount = 0;
    this._lastPongReceived = Date.now();
    this._lastTranscriptReceived = Date.now();
    this._destroyed = false;
    this._keepaliveInterval = null;
    this._staleCheckInterval = null;
    this._reconnectTimeout = null;
    this.ws = null;
  }

  _setState(newState) {
    const old = this._state;
    if (old === newState) return;
    this._state = newState;
    this.emit('stateChange', { from: old, to: newState, roomId: this.roomId });
    console.log(`[DG:${this.roomId.slice(0, 8)}] ${old} -> ${newState}`);
  }

  get state() { return this._state; }
  get isHealthy() { return this._state === 'active'; }

  connect() {
    if (this._destroyed) return;
    this._setState('connecting');

    const ws = new WebSocket(
      'wss://api.deepgram.com/v1/listen' +
      '?model=nova-2&language=en&punctuate=true' +
      '&interim_results=true&endpointing=500' +    // intentional: partial results required
      '&smart_format=true&encoding=linear16' +
      '&sample_rate=16000&channels=1' +
      '&utterances=true',                          // intentional: required for deduplication
      { headers: { Authorization: `Token ${config.deepgramApiKey}` } }
    );
    this.ws = ws;

    ws.on('open', () => {
      this._setState('active');
      this._retryCount = 0;
      this._lastPongReceived = Date.now();
      this._lastTranscriptReceived = Date.now();
      this._flushQueue();
      this._startKeepalive();
    });

    ws.on('message', (raw) => { this._handleMessage(raw); });
    ws.on('pong', () => { this._lastPongReceived = Date.now(); });
    ws.on('error', (err) => {
      console.warn(`[DG:${this.roomId.slice(0, 8)}] WS error:`, err.message);
    });
    ws.on('close', (code, reason) => { this._handleClose(code, reason); });
  }

  _startKeepalive() {
    this._keepaliveInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);

    this._staleCheckInterval = setInterval(() => {
      const now = Date.now();
      const pongStale = (now - this._lastPongReceived) > STALE_TIMEOUT_MS;
      const transcriptStale = (now - this._lastTranscriptReceived) > INACTIVITY_TIMEOUT_MS;
      if (pongStale || transcriptStale) {
        const reason = pongStale ? 'no pong' : 'transcript inactivity';
        console.warn(`[DG:${this.roomId.slice(0, 8)}] Stale detected (${reason}), reconnecting`);
        this._reconnect();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepalive() {
    clearInterval(this._keepaliveInterval);
    clearInterval(this._staleCheckInterval);
    this._keepaliveInterval = null;
    this._staleCheckInterval = null;
  }

  _handleMessage(raw) {
    this._lastTranscriptReceived = Date.now();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn(`[DG:${this.roomId.slice(0, 8)}] Ignoring non-JSON message:`, err.message);
      return;
    }

    const transcript = data?.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    this._sequenceNumber++;
    const meta = {
      sequenceNumber: this._sequenceNumber,
      timestamp: Date.now(),
      roomId: this.roomId,
      speakerRole: 'candidate',
      source: 'deepgram',
    };

    if (data.is_final) {
      this.emit('transcript:final', { text: transcript, isFinal: true, ...meta });
    } else {
      this.emit('transcript:partial', { text: transcript, isFinal: false, ...meta });
    }
  }

  sendAudio(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return;
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_AUDIO_CHUNK_SIZE) return;
    if (chunk.byteLength % 2 !== 0) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this._queue.length < MAX_BUFFERED_CHUNKS) {
      this._queue.push(chunk);
    } else {
      this._queue.shift();
      this._queue.push(chunk);
      this._droppedChunks++;
      if (this._droppedChunks % 100 === 1) {
        console.warn(`[DG:${this.roomId.slice(0, 8)}] Backpressure: ${this._droppedChunks} total chunks dropped`);
      }
    }
  }

  _flushQueue() {
    while (this._queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this._queue.shift());
    }
  }

  _handleClose(code, reason) {
    this._stopKeepalive();
    if (this._destroyed || code === 1000) {
      this._setState('closed');
      return;
    }
    if (this._retryCount >= RECONNECT_MAX_RETRIES) {
      this._setState('failed');
      this.emit('error', {
        message: `Deepgram connection failed after ${RECONNECT_MAX_RETRIES} retries`,
        roomId: this.roomId,
        recoverable: true,
      });
      return;
    }
    this._reconnect();
  }

  _reconnect() {
    if (this._destroyed) return;
    this._setState('reconnecting');
    this._stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        console.warn(`[DG:${this.roomId.slice(0, 8)}] WS close during reconnect failed:`, err.message);
      }
      this.ws = null;
    }
    const delay = Math.min(Math.pow(2, this._retryCount) * 1000, 32000);
    this._retryCount++;
    console.log(`[DG:${this.roomId.slice(0, 8)}] Reconnecting in ${delay}ms (attempt ${this._retryCount}/${RECONNECT_MAX_RETRIES})`);
    this._reconnectTimeout = setTimeout(() => {
      if (!this._destroyed) this.connect();
    }, delay);
  }

  close() {
    this._destroyed = true;
    this._stopKeepalive();
    clearTimeout(this._reconnectTimeout);
    this._reconnectTimeout = null;
    this._queue = [];
    this._droppedChunks = 0;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch (err) {
        console.warn(`[DG:${this.roomId.slice(0, 8)}] CloseStream send failed:`, err.message);
      }
      try {
        this.ws.close(1000);
      } catch (err) {
        console.warn(`[DG:${this.roomId.slice(0, 8)}] WS close failed:`, err.message);
      }
      this.ws = null;
    }
    this._setState('closed');
    this.removeAllListeners();
  }
}
