import type { Server } from 'socket.io';
import type { MeetingStatus } from '../domain/meetingMachine.js';
import type { SegmentRow, NoteRow } from '../domain/TranscriptService.js';
import type { QueuedCandidate } from '../domain/PresenceService.js';
import type { MeetingService } from '../domain/MeetingService.js';
import type { InternalJwtPayload } from '../auth/jwt.js';
import { redis } from '../db/redis.js';
import { logger } from '../lib/logger.js';

const ACTIVE_MEETINGS_KEYS = ['activemeetings:english', 'activemeetings:tamil', 'activemeetings:hindi'];

const INTERVIEWER_NSP = '/interviewer';
const CANDIDATE_NSP   = '/candidate';
const SUPERVISOR_NSP  = '/supervisor';

function meetingRoom(meetingId: string): string {
  return `meeting:${meetingId}`;
}

/**
 * Centralises all server→client emits so socket transport details
 * never leak into domain services.
 *
 * Passed to PresenceService.onBroadcast, MeetingService callbacks,
 * and namespace event handlers.
 */
export class BroadcastHelper {
  constructor(
    private readonly io: Server,
    private readonly meetingService: MeetingService,
  ) {}

  /** Notifies all connected interviewers and supervisors that candidate queue state has changed. */
  presenceDelta(candidates: QueuedCandidate[]): void {
    const payload = { candidates };
    logger.info({ count: candidates.length }, 'broadcast: presenceDelta to INTERVIEWER, SUPERVISOR');
    this.io.of(INTERVIEWER_NSP).emit('candidate_queue_update', payload);
    this.io.of(SUPERVISOR_NSP).emit('candidate_queue_update', payload);
  }

  /** Pushes a new transcript segment to everyone in the meeting room. */
  transcriptSegment(meetingId: string, segment: SegmentRow): void {
    const room = meetingRoom(meetingId);
    logger.info({ meetingId, segmentId: segment.id }, 'broadcast: transcriptSegment to INTERVIEWER, SUPERVISOR, CANDIDATE');
    this.io.of(INTERVIEWER_NSP).to(room).emit('transcript_segment', segment);
    this.io.of(CANDIDATE_NSP).to(room).emit('transcript_segment', segment);
    this.io.of(SUPERVISOR_NSP).to(room).emit('transcript_segment', segment);
  }

  /** Broadcasts a new note to staff in the meeting room. */
  noteAdded(meetingId: string, note: NoteRow): void {
    const room = meetingRoom(meetingId);
    logger.info({ meetingId, noteId: note.id }, 'broadcast: noteAdded to INTERVIEWER, SUPERVISOR, CANDIDATE');
    this.io.of(INTERVIEWER_NSP).to(room).emit('note_added', note);
    this.io.of(CANDIDATE_NSP).to(room).emit('note_added', note);
    this.io.of(SUPERVISOR_NSP).to(room).emit('note_added', note);
  }

  /** Broadcasts a note body update to staff in the meeting room. */
  noteUpdated(meetingId: string, payload: { noteId: string; body: string; updatedAt: Date }): void {
    const room = meetingRoom(meetingId);
    logger.info({ meetingId, noteId: payload.noteId }, 'broadcast: noteUpdated to INTERVIEWER, SUPERVISOR, CANDIDATE');
    this.io.of(INTERVIEWER_NSP).to(room).emit('note_updated', payload);
    this.io.of(CANDIDATE_NSP).to(room).emit('note_updated', payload);
    this.io.of(SUPERVISOR_NSP).to(room).emit('note_updated', payload);
  }

  /** Broadcasts a note deletion to staff in the meeting room. */
  noteDeleted(meetingId: string, payload: { noteId: string }): void {
    const room = meetingRoom(meetingId);
    logger.info({ meetingId, noteId: payload.noteId }, 'broadcast: noteDeleted to INTERVIEWER, SUPERVISOR, CANDIDATE');
    this.io.of(INTERVIEWER_NSP).to(room).emit('note_deleted', payload);
    this.io.of(CANDIDATE_NSP).to(room).emit('note_deleted', payload);
    this.io.of(SUPERVISOR_NSP).to(room).emit('note_deleted', payload);
  }

  /** Notifies the meeting room that the Deepgram pipeline has failed unrecoverably. */
  transcriptError(meetingId: string): void {
    const room    = meetingRoom(meetingId);
    const payload = { meetingId };
    this.io.of(INTERVIEWER_NSP).to(room).emit('transcript_error', payload);
    this.io.of(CANDIDATE_NSP).to(room).emit('transcript_error', payload);
    this.io.of(SUPERVISOR_NSP).to(room).emit('transcript_error', payload);
  }

  /** Broadcasts a meeting status change to all participants in the meeting room,
   *  and to supervisors subscribed to the active meetings monitor.
   *  `extra` carries optional name/UID fields used by the candidate to resolve
   *  the interviewer's video tile label when status becomes 'active'. */
  meetingStatus(
    meetingId: string,
    status: MeetingStatus,
    extra?: { interviewerName?: string | null; participantUids?: { interviewerUid: number; candidateUid: number } },
  ): void {
    // Invalidate supervisor active-meetings cache so next subscribe_active_meetings
    // reflects the updated status. Fire-and-forget — stale cache is self-healing at TTL.
    if (redis) {
      redis.del(...ACTIVE_MEETINGS_KEYS).catch((err: Error) =>
        logger.error({ err }, 'meetingStatus: activemeetings cache invalidation failed'),
      );
    }

    const payload = extra ? { meetingId, status, ...extra } : { meetingId, status };
    const room    = meetingRoom(meetingId);
    this.io.of(INTERVIEWER_NSP).to(room).emit('meeting_status', payload);
    this.io.of(CANDIDATE_NSP).to(room).emit('meeting_status', payload);
    // Emit to meeting room AND meetings_monitor — Socket.IO deduplicates per-socket.
    this.io.of(SUPERVISOR_NSP).to(room).to('meetings_monitor').emit('meeting_status', payload);
  }

  /** Pushes each subscribed interviewer their own language-filtered list of open rooms.
   *  Results are cached in Redis per language (5s TTL) when Redis is available. */
  async openRoomsUpdate(): Promise<void> {
    logger.info('openRoomsUpdate: starting');

    const r = redis; // capture once; stable null check throughout async calls

    // Invalidate stale cache so the first socket per language re-fetches from DB.
    if (r) {
      await r.del('openrooms:english', 'openrooms:tamil', 'openrooms:hindi')
        .catch((err: Error) => logger.error({ err }, 'openRoomsUpdate: cache invalidation failed'));
    }

    // Guard against fetchSockets hanging when the Redis adapter is slow or unavailable.
    const sockets = await Promise.race([
      this.io.of(INTERVIEWER_NSP).in('open_rooms_monitor').fetchSockets(),
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
    ]);

    logger.info({ count: sockets.length }, 'openRoomsUpdate: sockets fetched');

    for (const s of sockets) {
      try {
        const lang     = (s.data as { user?: InternalJwtPayload })?.user?.language ?? 'english';
        const cacheKey = `openrooms:${lang}`;

        if (r) {
          let cached = await r.get(cacheKey);
          if (!cached) {
            const rooms = await this.meetingService.getOpenMeetingsWithNames(lang);
            cached = JSON.stringify(rooms);
            await r.set(cacheKey, cached, 'EX', 5);
          }
          s.emit('open_rooms_update', { meetings: JSON.parse(cached) });
        } else {
          const rooms = await this.meetingService.getOpenMeetingsWithNames(lang);
          s.emit('open_rooms_update', { meetings: rooms });
        }

        logger.debug({ socketId: s.id, lang }, 'openRoomsUpdate: emitted to socket');
      } catch (err) {
        logger.error({ err, socketId: s.id }, 'openRoomsUpdate: per-socket failed');
      }
    }

    logger.info('openRoomsUpdate: done');
  }
}
