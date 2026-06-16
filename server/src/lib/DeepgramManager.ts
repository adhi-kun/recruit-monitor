import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { LiveClient } from '@deepgram/sdk';
import type { TranscriptService, SegmentRow } from '../domain/TranscriptService.js';
import { logger } from './logger.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_BUFFERED_AUDIO_BYTES = 160_000; // ~5 seconds of 16kHz 16-bit mono PCM

// Minimal shape of a Deepgram Results event — avoids importing SDK internals.
interface DeepgramResult {
  start: number;
  duration: number;
  is_final: boolean;
  channel: {
    alternatives: Array<{ transcript: string; confidence: number }>;
  };
}

interface LiveSession {
  client: LiveClient | null;
  candidateId: string;
  connectedAt: Date;         // reset each time the connection opens
  retryCount: number;
  stopping: boolean;
  gapStartedAt: Date | null; // set when the connection drops unexpectedly; cleared on reconnect
  reconnectScheduled: boolean;
  audioBuffer: Buffer[];
  bufferedBytes: number;
}

export interface DeepgramManagerDeps {
  apiKey: string;
  transcriptService: TranscriptService;
  /** Called after a final segment is persisted. Wire broadcast here in Phase 10. */
  onSegment: (meetingId: string, segment: SegmentRow) => void;
  /** Called when all retries are exhausted. Caller should end the meeting. */
  onFatalError: (meetingId: string, err: Error) => void;
}

export class DeepgramManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly dg: ReturnType<typeof createClient>;

  constructor(private readonly deps: DeepgramManagerDeps) {
    this.dg = createClient(deps.apiKey);
  }

  // ── Public API ────────────────────────────────────────────────────────

  start(meetingId: string, candidateId: string): void {
    if (this.sessions.has(meetingId)) {
      logger.warn({ meetingId }, 'DeepgramManager.start: session already exists, ignored');
      return;
    }

    const session: LiveSession = {
      client: null,
      candidateId,
      connectedAt: new Date(),
      retryCount: 0,
      stopping: false,
      gapStartedAt: null,
      reconnectScheduled: false,
      audioBuffer: [],
      bufferedBytes: 0,
    };

    this.sessions.set(meetingId, session);
    this.openConnection(meetingId, session);
  }

  send(meetingId: string, chunk: Buffer): void {
    const session = this.sessions.get(meetingId);
    if (!session) return;
    if (!session.client?.isConnected()) {
      this.bufferAudio(session, chunk);
      return;
    }
    // Buffer is a Uint8Array view — extract the exact ArrayBuffer region it covers.
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    session.client.send(ab);
  }

  stop(meetingId: string): void {
    const session = this.sessions.get(meetingId);
    if (!session) return;
    session.stopping = true;
    session.client?.requestClose();
    session.audioBuffer = [];
    session.bufferedBytes = 0;
    this.sessions.delete(meetingId);
    logger.info({ meetingId }, 'Deepgram session stopped');
  }

  stopAll(): void {
    for (const meetingId of Array.from(this.sessions.keys())) {
      this.stop(meetingId);
    }
    logger.info('all Deepgram sessions stopped');
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  private openConnection(meetingId: string, session: LiveSession): void {
    // Remove listeners from the previous client so stale close/error events
    // don't trigger a second reconnect cycle for the same drop.
    session.client?.removeAllListeners();

    const client = this.dg.listen.live({
      model:            'nova-2',
      language:         'en-IN',
      encoding:         'linear16',
      sample_rate:      16_000,
      channels:         1,
      interim_results:  true,
      smart_format:     true,
      endpointing:      500,
      utterance_end_ms: 1000,
    });
    session.client = client;

    client.on(LiveTranscriptionEvents.Open, () => {
      const now = new Date();

      if (session.gapStartedAt !== null) {
        // ── Reconnect succeeded — close the gap ────────────────────────
        // Insert a system segment marking the dead air before resuming.
        // Reset retry state so the next drop gets a fresh backoff sequence.
        const gapStartedAt = session.gapStartedAt;
        session.gapStartedAt = null;
        session.retryCount   = 0;
        session.connectedAt  = now;
        session.reconnectScheduled = false;

        const gapSeconds = Math.round((now.getTime() - gapStartedAt.getTime()) / 1000);
        this.appendGapSegment(meetingId, gapStartedAt, now, gapSeconds).catch((err) =>
          logger.error({ err, meetingId }, 'gap segment write failed'),
        );

        logger.info({ meetingId, gapSeconds }, 'Deepgram reconnected — gap segment queued');
      } else {
        session.connectedAt = now;
        session.reconnectScheduled = false;
        logger.info({ meetingId }, 'Deepgram connection open');
      }
      this.flushAudioBuffer(meetingId, session);
    });

    client.on(LiveTranscriptionEvents.Transcript, (rawResult: unknown) => {
      void this.handleTranscript(meetingId, session, rawResult as DeepgramResult);
    });

    client.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      logger.error({ err, meetingId, retryCount: session.retryCount }, 'Deepgram error');
      if (!session.stopping) this.scheduleReconnect(meetingId, session);
    });

    client.on(LiveTranscriptionEvents.Close, () => {
      if (session.stopping) return;
      logger.warn({ meetingId, retryCount: session.retryCount }, 'Deepgram connection closed unexpectedly');
      this.scheduleReconnect(meetingId, session);
    });
  }

  // ── Reconnect with exponential backoff ────────────────────────────────

  private scheduleReconnect(meetingId: string, session: LiveSession): void {
    if (session.reconnectScheduled) return;
    session.reconnectScheduled = true;

    // Stamp gap start on first drop; keep the original timestamp across retries
    // so the gap segment reflects the full dead-air window, not just the last retry.
    if (session.gapStartedAt === null) {
      session.gapStartedAt = new Date();
    }

    if (session.retryCount >= MAX_RETRIES) {
      logger.error({ meetingId }, 'Deepgram max retries exceeded');
      this.sessions.delete(meetingId);
      this.deps.onFatalError(meetingId, new Error('Deepgram max retries exceeded'));
      return;
    }

    session.retryCount++;
    const delayMs = Math.min(INITIAL_BACKOFF_MS * 2 ** (session.retryCount - 1), MAX_BACKOFF_MS);

    logger.warn(
      { meetingId, attempt: session.retryCount, delayMs },
      'scheduling Deepgram reconnect',
    );

    setTimeout(() => {
      // Guard: meeting may have ended or been stopped during the backoff window.
      if (session.stopping || !this.sessions.has(meetingId)) return;
      session.reconnectScheduled = false;
      this.openConnection(meetingId, session);
    }, delayMs);
  }

  private bufferAudio(session: LiveSession, chunk: Buffer): void {
    if (chunk.length === 0) return;
    session.audioBuffer.push(Buffer.from(chunk));
    session.bufferedBytes += chunk.length;

    while (session.bufferedBytes > MAX_BUFFERED_AUDIO_BYTES && session.audioBuffer.length > 0) {
      const dropped = session.audioBuffer.shift();
      session.bufferedBytes -= dropped?.length ?? 0;
    }
  }

  private flushAudioBuffer(meetingId: string, session: LiveSession): void {
    if (!session.client?.isConnected() || session.audioBuffer.length === 0) return;
    const chunks = session.audioBuffer.splice(0);
    session.bufferedBytes = 0;
    for (const chunk of chunks) {
      this.send(meetingId, chunk);
    }
    logger.info({ meetingId, chunks: chunks.length }, 'Deepgram audio buffer flushed');
  }

  // ── Transcript handling (finals persisted, interims suppressed until Phase 10) ──

  private async handleTranscript(
    meetingId: string,
    session: LiveSession,
    result: DeepgramResult,
  ): Promise<void> {
    const alt = result.channel?.alternatives?.[0];
    if (!alt?.transcript) return; // empty/silent result

    if (!result.is_final) return; // interim — broadcast wired in Phase 10

    const startedAt = new Date(session.connectedAt.getTime() + result.start * 1_000);
    const endedAt   = new Date(startedAt.getTime()          + result.duration * 1_000);

    try {
      const { id, seq } = await this.deps.transcriptService.appendSegment({
        meetingId,
        speakerUserId: session.candidateId,
        speakerRole:   'candidate',
        text:          alt.transcript,
        startedAt,
        endedAt,
        isFinal:       true,
        confidence:    alt.confidence ?? null,
      });

      this.deps.onSegment(meetingId, {
        id,
        meetingId,
        seq,
        speakerUserId: session.candidateId,
        speakerRole:   'candidate',
        text:          alt.transcript,
        startedAt,
        endedAt,
        isFinal:       true,
        confidence:    alt.confidence ?? null,
        createdAt:     new Date(),
      });
    } catch (err) {
      logger.error({ err, meetingId }, 'transcript segment append failed');
    }
  }

  // ── Gap segment ───────────────────────────────────────────────────────

  private async appendGapSegment(
    meetingId: string,
    gapStartedAt: Date,
    gapEndedAt: Date,
    gapSeconds: number,
  ): Promise<void> {
    const { id, seq } = await this.deps.transcriptService.appendSegment({
      meetingId,
      speakerUserId: null,
      speakerRole:   'system',
      text:          `[transcription gap: ${gapSeconds}s]`,
      startedAt:     gapStartedAt,
      endedAt:       gapEndedAt,
      isFinal:       true,
      confidence:    null,
    });

    this.deps.onSegment(meetingId, {
      id,
      meetingId,
      seq,
      speakerUserId: null,
      speakerRole:   'system',
      text:          `[transcription gap: ${gapSeconds}s]`,
      startedAt:     gapStartedAt,
      endedAt:       gapEndedAt,
      isFinal:       true,
      confidence:    null,
      createdAt:     new Date(),
    });
  }
}
