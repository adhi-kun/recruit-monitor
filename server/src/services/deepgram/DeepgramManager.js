import { DeepgramSession } from './DeepgramSession.js';
import { config } from '../../config.js';

const RECONNECT_GRACE_MS = 15000;      // 15s grace on candidate disconnect
const MAX_TRANSCRIPT_CHARS = 500000;   // ~500KB text cap

function deduplicatedAppend(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const trimmedExisting = existing.trimEnd();
  const trimmedIncoming = incoming.trimStart();
  const maxCheck = Math.min(trimmedExisting.length, trimmedIncoming.length);
  let overlapLen = 0;

  for (let len = 1; len <= maxCheck; len++) {
    const suffix = trimmedExisting.slice(-len);
    const prefix = trimmedIncoming.slice(0, len);
    if (suffix.toLowerCase() === prefix.toLowerCase()) {
      overlapLen = len;
    }
  }

  if (overlapLen > 0) {
    return trimmedExisting + ' ' + trimmedIncoming.slice(overlapLen).trimStart();
  }
  return trimmedExisting + ' ' + trimmedIncoming;
}

export class DeepgramManager {
  constructor() {
    this._sessions = new Map();
    this._graceTimers = new Map();
  }

  startSession(roomId, broadcastToRoom, roomRegistry) {
    const graceTimer = this._graceTimers.get(roomId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this._graceTimers.delete(roomId);
      console.log(`[DGM] Grace timer cancelled for room ${roomId.slice(0, 8)} (candidate rejoined)`);
    }

    const existing = this._sessions.get(roomId);
    if (existing && (existing.state === 'active' || existing.state === 'connecting')) {
      return;
    }
    if (existing) {
      existing.close();
      this._sessions.delete(roomId);
    }

    if (!config.deepgramApiKey) {
      console.error('[DGM] DEEPGRAM_API_KEY not set - transcription disabled');
      broadcastToRoom(roomId, 'transcript:error', {
        message: 'Transcription unavailable - server configuration error',
        roomId,
      });
      return;
    }

    const session = new DeepgramSession(roomId);
    this._sessions.set(roomId, session);

    session.on('transcript:final', ({ text, ...meta }) => {
      const room = roomRegistry.getRoomById(roomId);
      if (!room) return;

      let newText = deduplicatedAppend(room.transcriptText, text);

      if (newText.length > MAX_TRANSCRIPT_CHARS) {
        const trimPoint = newText.length - MAX_TRANSCRIPT_CHARS;
        const spaceIdx = newText.indexOf(' ', trimPoint);
        newText = (spaceIdx !== -1) ? '...' + newText.slice(spaceIdx) : newText.slice(trimPoint);
      }

      roomRegistry.updateRoom(roomId, { transcriptText: newText });
      broadcastToRoom(roomId, 'transcript:final', {
        text,
        fullText: newText,
        source: 'deepgram',
        ...meta,
      });
      broadcastToRoom(roomId, 'transcript:partial', {
        text: '',
        source: 'deepgram',
        isFinal: false,
        sequenceNumber: meta.sequenceNumber,
        timestamp: Date.now(),
        roomId,
        speakerRole: 'candidate',
      });
    });

    session.on('transcript:partial', (payload) => {
      broadcastToRoom(roomId, 'transcript:partial', payload);
    });

    session.on('error', ({ message, recoverable }) => {
      console.error(`[DGM] Error for room ${roomId.slice(0, 8)}: ${message}`);
      broadcastToRoom(roomId, 'transcript:error', { message, roomId, recoverable });
    });

    session.connect();
  }

  sendAudio(roomId, chunk) {
    const session = this._sessions.get(roomId);
    if (!session) return;
    session.sendAudio(chunk);
  }

  pauseSession(roomId) {
    if (this._graceTimers.has(roomId)) return;

    const timer = setTimeout(() => {
      this._graceTimers.delete(roomId);
      this.stopSession(roomId);
      console.log(`[DGM] Grace expired -> stopped session for room ${roomId.slice(0, 8)}`);
    }, RECONNECT_GRACE_MS);
    this._graceTimers.set(roomId, timer);
    console.log(`[DGM] Grace started for room ${roomId.slice(0, 8)} (${RECONNECT_GRACE_MS}ms)`);
  }

  stopSession(roomId) {
    const timer = this._graceTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(roomId);
    }
    const session = this._sessions.get(roomId);
    if (session) {
      session.close();
      this._sessions.delete(roomId);
    }
  }

  stopAll() {
    for (const [roomId] of this._sessions) {
      this.stopSession(roomId);
    }
  }
}
