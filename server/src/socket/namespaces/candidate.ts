import type { Server } from 'socket.io';
import type { PresenceService } from '../../domain/PresenceService.js';
import type { MeetingService } from '../../domain/MeetingService.js';
import { AgoraTokenService } from '../../domain/AgoraTokenService.js';
import type { SessionService } from '../../domain/SessionService.js';
import type { TranscriptService } from '../../domain/TranscriptService.js';
import type { DeepgramManager } from '../../lib/DeepgramManager.js';
import type { BroadcastHelper } from '../broadcast.js';
import { requireJwtSocket } from '../middleware/requireJwtSocket.js';
import { attachReconnectSession } from '../middleware/attachReconnectSession.js';
import { audioChunkSchema, heartbeatSchema, startSessionSchema } from '../schemas/candidate.js';
import { addNoteSchema, updateNoteSchema, deleteNoteSchema } from '../schemas/interviewer.js';
import { shareVideoSchema, videoSyncSchema } from '../schemas/video.js';
import { ForbiddenError, InvalidTransitionError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { CandidateSocket } from '../types.js';
import { onSafe } from '../safeHandler.js';
import { resetSocketRateLimit } from '../rateLimiter.js';
import { pool } from '../../db/pool.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const VIDEO_BUCKET = 'interview-videos';

export interface CandidateDeps {
  io: Server;
  presenceService: PresenceService;
  meetingService: MeetingService;
  agoraTokenService: AgoraTokenService;
  sessionService: SessionService;
  deepgramManager: DeepgramManager;
  broadcast: BroadcastHelper;
  transcriptService: TranscriptService;
}

export function registerCandidateNamespace(io: Server, deps: CandidateDeps): void {
  const {
    meetingService,
    agoraTokenService,
    sessionService,
    deepgramManager,
    broadcast,
    transcriptService,
  } = deps;
  const nsp = io.of('/candidate');

  nsp.use((socket, next) => requireJwtSocket(socket as CandidateSocket, next, 'candidate'));
  nsp.use((socket, next) => attachReconnectSession(sessionService)(socket, next));

  nsp.on('connection', async (rawSocket) => {
    const socket = rawSocket as CandidateSocket;
    const { userId } = socket.data.user;

    await socket.join(`user:${userId}`);

    // Guard against fetchSockets hanging if the Redis adapter is slow or unreachable.
    const existingSockets = await Promise.race([
      nsp.in(`user:${userId}`).fetchSockets(),
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
    ]);
    for (const old of existingSockets) {
      if (old.id !== socket.id) {
        old.emit('session_replaced', {});
        old.disconnect(true);
      }
    }

    sessionService.create(userId)
      .then(({ reconnectToken, expiresAt }) => {
        socket.emit('session_established', { reconnectToken, expiresAt });
      })
      .catch((err) => logger.error({ err, userId }, 'session create failed'));

    // ── Reconnect path: candidate already has an active/open/interrupted meeting ──

    const currentMeeting = await meetingService.resumeOrAttachCurrentMeeting(userId, 'candidate');
    let attachedMeeting = false;

    if (currentMeeting) {
      try {
        let status = currentMeeting.status;
        if (currentMeeting.shouldMarkReconnected) {
          await meetingService.onParticipantReconnect(currentMeeting.id, userId);
          status = 'active';
          broadcast.meetingStatus(currentMeeting.id, status);
        }

        socket.data.meetingId     = currentMeeting.id;
        socket.data.meetingStatus = status;
        await socket.join(`meeting:${currentMeeting.id}`);

        const uid = AgoraTokenService.deriveUid(currentMeeting.id, userId);
        const agoraToken = agoraTokenService.generateToken({
          channelName: currentMeeting.agoraChannel,
          uid,
          role: 'publisher',
        });

        socket.emit('meeting_attached', {
          meetingId:     currentMeeting.id,
          status,
          agoraChannel:  currentMeeting.agoraChannel,
          agoraToken,
          uid,
          candidateId:   currentMeeting.candidateId,
          interviewerId: currentMeeting.interviewerId,
          participantUids: {
            interviewerUid: currentMeeting.interviewerId
              ? AgoraTokenService.deriveUid(currentMeeting.id, currentMeeting.interviewerId)
              : null,
            candidateUid: AgoraTokenService.deriveUid(currentMeeting.id, currentMeeting.candidateId),
          },
        });

        attachedMeeting = true;
        logger.info(
          { socketId: socket.id, userId, meetingId: currentMeeting.id, status },
          'candidate reattached to current meeting',
        );
      } catch (err) {
        logger.warn({ err, userId, meetingId: currentMeeting.id }, 'candidate meeting reattach failed');
      }
    }

    logger.info({ socketId: socket.id, userId, attachedMeeting }, 'candidate connected');

    // ── Start session (pre-join → create open room) ───────────────────────
    // Only registered if the candidate does NOT already have an active meeting.
    // Once the meeting is created this handler becomes a no-op (socket.data.meetingId is set).

    if (!attachedMeeting) {
      onSafe(socket, {
        event: 'start_session',
        schema: startSessionSchema,
        rateLimit: { limit: 20, windowMs: 60_000 },
      }, async (_payload, { ack }) => {
        try {
          if (socket.data.meetingId) {
            // The candidate may have navigated back from an ended meeting without
            // disconnecting the socket, leaving meetingId stale. Verify the meeting
            // is still in a live state before blocking the new session.
            try {
              const existing = await meetingService.getMeeting(socket.data.meetingId);
              if (existing.status !== 'ended') {
                ack({ ok: false, error: 'Session already started', code: 'CONFLICT' });
                return;
              }
            } catch (err) {
              if (!(err instanceof NotFoundError)) {
                logger.error({ err, meetingId: socket.data.meetingId }, 'start_session: stale meeting check failed');
                ack({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
                return;
              }
              // Meeting not found — treat meetingId as stale, fall through.
            }
            // Meeting ended or missing — clear stale meetingId and allow new session.
            // Also reset the rate-limit bucket so navigating back from an ended meeting
            // doesn't exhaust the window before the candidate can start a new one.
            socket.data.meetingId = undefined;
            resetSocketRateLimit(socket, 'start_session');
          }

          const { meetingId, agoraChannel } = await meetingService.createOpenMeeting(userId);

          socket.data.meetingId     = meetingId;
          socket.data.meetingStatus = 'open';
          await socket.join(`meeting:${meetingId}`);

          const uid = AgoraTokenService.deriveUid(meetingId, userId);
          const agoraToken = agoraTokenService.generateToken({
            channelName: agoraChannel,
            uid,
            role: 'publisher',
          });

          const participantUids = {
            interviewerUid: null,
            candidateUid:   AgoraTokenService.deriveUid(meetingId, userId),
          };

          socket.emit('meeting_attached', {
            meetingId,
            status:        'open',
            agoraChannel,
            agoraToken,
            uid,
            candidateId:   userId,
            interviewerId: null,
            participantUids,
          });

          // Notify interviewer dashboards — fire-and-forget, must not block the ack.
          broadcast.openRoomsUpdate()
            .catch((err) => logger.error({ err }, 'openRoomsUpdate after start_session failed'));

          ack({ ok: true, data: { meetingId, agoraChannel, agoraToken, uid, participantUids } });
          logger.info({ socketId: socket.id, userId, meetingId }, 'start_session: open meeting created');
        } catch (err) {
          logger.error({ err, userId }, 'start_session: unhandled error');
          ack({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
        }
      });
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    onSafe(socket, {
      event: 'heartbeat',
      schema: heartbeatSchema,
      rateLimit: { limit: 1, windowMs: 8_000 },
    }, async () => {
      // Heartbeats are a no-op in the new flow — presence is managed via meeting status.
      // Keep the handler so existing client code doesn't cause unknown-event warnings.
    });

    // ── Audio forwarding to Deepgram ──────────────────────────────────────

    let rateLimitWindowStart = Date.now();
    let rateLimitBytesInWindow = 0;

    onSafe(socket, { event: 'audio_chunk', schema: audioChunkSchema }, (data) => {
      const { meetingId, meetingStatus } = socket.data;
      if (!meetingId) return;
      if (data.length === 0 || data.length > 32_768 || data.length % 2 !== 0) return;

      if (meetingStatus !== 'active' && meetingStatus !== 'open') return;
      if (!socket.rooms.has(`meeting:${meetingId}`)) return;

      const now = Date.now();
      if (now - rateLimitWindowStart >= 1_000) {
        rateLimitWindowStart = now;
        rateLimitBytesInWindow = 0;
      }
      rateLimitBytesInWindow += data.length;
      if (rateLimitBytesInWindow > 200_000) {
        logger.warn({ userId, meetingId }, 'audio_chunk rate limit exceeded - chunk dropped');
        return;
      }

      deepgramManager.send(meetingId, data);
    });

    // ── Disconnect ────────────────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
      const { meetingId } = socket.data;
      const intentional = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';

      if (meetingId) {
        meetingService.getMeeting(meetingId).then(async (meeting) => {
          if (meeting.status === 'open') {
            // Solo room — candidate left before interviewer arrived. End immediately.
            await meetingService.endMeeting(meetingId, 'candidate_left');
            broadcast.meetingStatus(meetingId, 'ended');
            broadcast.openRoomsUpdate()
              .catch((err) => logger.error({ err, meetingId }, 'openRoomsUpdate after candidate_left failed'));
          } else if (!intentional) {
            await meetingService.onParticipantDisconnect(meetingId, userId);
            broadcast.meetingStatus(meetingId, 'interrupted');
          } else {
            logger.debug(
              { socketId: socket.id, userId, meetingId, reason },
              'candidate intentional disconnect - skipping grace timer',
            );
          }
        }).catch((err) => logger.error({ err, meetingId, userId }, 'disconnect handler failed'));

        logger.info({ socketId: socket.id, userId, meetingId, reason }, 'candidate disconnected during meeting');
        return;
      }

      logger.info({ socketId: socket.id, userId, reason }, 'candidate disconnected (no meeting)');
    });

    // ── Notes ─────────────────────────────────────────────────────────────

    onSafe(socket, {
      event: 'add_note',
      schema: addNoteSchema,
      rateLimit: { limit: 30, windowMs: 60_000 },
    }, async ({ meetingId, anchorSegmentId, body }, { ack }) => {
      try {
        const meeting = await meetingService.getMeeting(meetingId);
        if (meeting.candidateId !== userId) {
          ack({ ok: false, error: 'Meeting not found', code: 'NOT_FOUND' });
          return;
        }
        const note = await transcriptService.addNote({
          meetingId,
          anchorSegmentId: anchorSegmentId ?? null,
          authorUserId: userId,
          body,
        });
        broadcast.noteAdded(meetingId, note);
        ack({ ok: true, data: { noteId: note.id } });
      } catch (err) {
        if (err instanceof NotFoundError) ack({ ok: false, error: 'Anchor segment not found', code: 'NOT_FOUND' });
        else {
          logger.error({ err, meetingId }, 'add_note failed');
          ack({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
        }
      }
    });

    onSafe(socket, {
      event: 'update_note',
      schema: updateNoteSchema,
      rateLimit: { limit: 30, windowMs: 60_000 },
    }, async ({ meetingId, noteId, body }, { ack }) => {
      try {
        await transcriptService.updateNote(noteId, body, userId);
        const updatedAt = new Date();
        broadcast.noteUpdated(meetingId, { noteId, body, updatedAt });
        ack({ ok: true });
      } catch (err) {
        if (err instanceof NotFoundError) ack({ ok: false, error: 'Note not found', code: 'NOT_FOUND' });
        else if (err instanceof ForbiddenError) ack({ ok: false, error: 'Only the note author may edit this note', code: 'FORBIDDEN' });
        else {
          logger.error({ err, noteId }, 'update_note failed');
          ack({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
        }
      }
    });

    onSafe(socket, {
      event: 'delete_note',
      schema: deleteNoteSchema,
      rateLimit: { limit: 30, windowMs: 60_000 },
    }, async ({ meetingId, noteId }, { ack }) => {
      try {
        await transcriptService.deleteNote(noteId, userId);
        broadcast.noteDeleted(meetingId, { noteId });
        ack({ ok: true });
      } catch (err) {
        if (err instanceof NotFoundError) ack({ ok: false, error: 'Note not found', code: 'NOT_FOUND' });
        else if (err instanceof ForbiddenError) ack({ ok: false, error: 'Only the note author may delete this note', code: 'FORBIDDEN' });
        else {
          logger.error({ err, noteId }, 'delete_note failed');
          ack({ ok: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
        }
      }
    });

    // ── Video resume ──────────────────────────────────────────────────────

    onSafe(socket, {
      event: 'share_video',
      schema: shareVideoSchema,
      rateLimit: { limit: 10, windowMs: 60_000 },
    }, async ({ meetingId, videoId }) => {
      if (!socket.rooms.has(`meeting:${meetingId}`)) return;

      const result = await pool.query<{ storage_path: string }>(
        'SELECT storage_path FROM meeting_videos WHERE id = $1 AND meeting_id = $2',
        [videoId, meetingId],
      );
      if (result.rows.length === 0) {
        logger.warn({ userId, meetingId, videoId }, 'share_video: video not found');
        return;
      }

      const { data, error } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET)
        .createSignedUrl(result.rows[0]!.storage_path, 3600);

      if (error || !data) {
        logger.error({ error, meetingId, videoId }, 'share_video: signed URL generation failed');
        return;
      }

      const payload = { videoId, signedUrl: data.signedUrl, sharedBy: userId };
      io.of('/interviewer').in(`meeting:${meetingId}`).emit('video_available', payload);
      io.of('/candidate').in(`meeting:${meetingId}`).emit('video_available', payload);
      io.of('/supervisor').in(`meeting:${meetingId}`).emit('video_available', payload);
      logger.info({ userId, meetingId, videoId }, 'share_video: broadcast sent');
    });

    onSafe(socket, {
      event: 'video_play',
      schema: videoSyncSchema,
      rateLimit: { limit: 60, windowMs: 60_000 },
    }, ({ meetingId, videoId, currentTime }) => {
      if (!socket.rooms.has(`meeting:${meetingId}`)) return;
      const syncPayload = { videoId, currentTime };
      nsp.in(`meeting:${meetingId}`).except(socket.id).emit('video_play_sync', syncPayload);
      io.of('/interviewer').in(`meeting:${meetingId}`).emit('video_play_sync', syncPayload);
      io.of('/supervisor').in(`meeting:${meetingId}`).emit('video_play_sync', syncPayload);
    });

    onSafe(socket, {
      event: 'video_pause',
      schema: videoSyncSchema,
      rateLimit: { limit: 60, windowMs: 60_000 },
    }, ({ meetingId, videoId, currentTime }) => {
      if (!socket.rooms.has(`meeting:${meetingId}`)) return;
      const syncPayload = { videoId, currentTime };
      nsp.in(`meeting:${meetingId}`).except(socket.id).emit('video_pause_sync', syncPayload);
      io.of('/interviewer').in(`meeting:${meetingId}`).emit('video_pause_sync', syncPayload);
      io.of('/supervisor').in(`meeting:${meetingId}`).emit('video_pause_sync', syncPayload);
    });

    onSafe(socket, {
      event: 'video_seek',
      schema: videoSyncSchema,
      rateLimit: { limit: 60, windowMs: 60_000 },
    }, ({ meetingId, videoId, currentTime }) => {
      if (!socket.rooms.has(`meeting:${meetingId}`)) return;
      const syncPayload = { videoId, currentTime };
      nsp.in(`meeting:${meetingId}`).except(socket.id).emit('video_seek_sync', syncPayload);
      io.of('/interviewer').in(`meeting:${meetingId}`).emit('video_seek_sync', syncPayload);
      io.of('/supervisor').in(`meeting:${meetingId}`).emit('video_seek_sync', syncPayload);
    });
  });
}
