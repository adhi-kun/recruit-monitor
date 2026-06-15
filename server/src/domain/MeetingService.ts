import type { Pool } from 'pg';
import type { IScheduler } from '../scheduler/bullScheduler.js';
import type { TranscriptService } from './TranscriptService.js';
import type { DeepgramManager } from '../lib/DeepgramManager.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { NotFoundError, InvalidTransitionError, ConflictError } from '../lib/errors.js';
import {
  guardMeetingTransition,
  guardCandidateTransition,
  type MeetingStatus,
  type CandidateStatus,
  type EndReason,
} from './meetingMachine.js';

export interface MeetingServiceDeps {
  pool: Pool;
  scheduler: IScheduler;
  graceWindowSeconds: number;
  transcriptService: TranscriptService;
  deepgramManager: DeepgramManager;
}

export interface MeetingDetails {
  id: string;
  interviewerId: string | null;
  candidateId: string;
  agoraChannel: string;
  status: MeetingStatus;
}

export interface MeetingDetailsWithNames extends MeetingDetails {
  interviewerName: string | null;
  candidateName: string;
}

export interface OpenMeetingDetails {
  id: string;
  candidateId: string;
  candidateName: string;
  agoraChannel: string;
  createdAt: string;
}

export interface CurrentMeetingAttachment extends MeetingDetails {
  shouldMarkReconnected: boolean;
}

interface MeetingRow {
  id: string;
  interviewer_id: string | null;
  candidate_id: string;
  agora_channel: string;
  status: MeetingStatus;
}

interface MeetingRowWithNames extends MeetingRow {
  interviewer_name: string | null;
  candidate_name: string;
}

interface CandidatePresenceRow {
  user_id: string;
  status: CandidateStatus;
}

export class MeetingService {
  constructor(private readonly deps: MeetingServiceDeps) {}

  /**
   * Creates a solo room for the candidate with status='open'.
   * Transitions candidate presence: offline|waiting → in_meeting.
   * Called from the candidate socket connection handler.
   */
  async createOpenMeeting(candidateId: string): Promise<{ meetingId: string; agoraChannel: string }> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Ensure a presence row exists for this candidate (new users have none yet).
      await client.query(
        `INSERT INTO candidate_presence (user_id, status, updated_at)
         VALUES ($1, 'offline', now())
         ON CONFLICT (user_id) DO NOTHING`,
        [candidateId],
      );

      const { rows: presenceRows } = await client.query<CandidatePresenceRow>(
        `SELECT user_id, status FROM candidate_presence WHERE user_id = $1 FOR UPDATE`,
        [candidateId],
      );
      const presence = presenceRows[0];
      if (!presence) throw new NotFoundError(`Candidate presence for ${candidateId} not found`);

      guardCandidateTransition(presence.status, 'open_meeting_created');

      const meetingId    = newId();
      const agoraChannel = newId();
      const createdAt    = new Date();

      await client.query(
        `INSERT INTO meetings (id, candidate_id, interviewer_id, status, agora_channel, created_at)
         VALUES ($1, $2, NULL, 'open', $3, $4)`,
        [meetingId, candidateId, agoraChannel, createdAt],
      );

      await client.query(
        `UPDATE candidate_presence
            SET status             = 'in_meeting',
                current_meeting_id = $2,
                claimed_by         = NULL,
                claimed_at         = NULL,
                updated_at         = now()
          WHERE user_id = $1`,
        [candidateId, meetingId],
      );

      await client.query('COMMIT');

      // Start Deepgram now so the candidate's audio is transcribed from the start.
      this.deps.deepgramManager.start(meetingId, candidateId);
      logger.info({ meetingId, candidateId }, 'open meeting created');
      return { meetingId, agoraChannel };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transitions meeting: open → active.
   * Sets interviewer_id, started_at. Starts Deepgram.
   * Called when an interviewer joins an open solo room.
   */
  async onInterviewerJoin(meetingId: string, interviewerId: string): Promise<{ agoraChannel: string; candidateId: string; interviewerName: string | null }> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, interviewer_id, agora_channel, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = rows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      guardMeetingTransition(meeting.status, 'interviewer_join');

      const now = new Date();

      await client.query(
        `UPDATE meetings
            SET interviewer_id = $2,
                status         = 'active',
                started_at     = $3
          WHERE id = $1`,
        [meetingId, interviewerId, now],
      );

      const { rows: userRows } = await client.query<{ name: string }>(
        `SELECT name FROM users WHERE id = $1`,
        [interviewerId],
      );

      await client.query('COMMIT');

      this.deps.deepgramManager.start(meetingId, meeting.candidate_id);
      logger.info({ meetingId, interviewerId }, 'interviewer joined open meeting — now active');
      return {
        agoraChannel:    meeting.agora_channel,
        candidateId:     meeting.candidate_id,
        interviewerName: userRows[0]?.name ?? null,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns open meetings with candidate names, filtered to a single language.
   * Used by the interviewer dashboard and broadcast.
   */
  async getOpenMeetingsWithNames(language: string): Promise<OpenMeetingDetails[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      candidate_id: string;
      candidate_name: string;
      agora_channel: string;
      created_at: Date;
    }>(
      `SELECT m.id, m.candidate_id, u.name AS candidate_name, m.agora_channel, m.created_at
         FROM meetings m
         JOIN users u ON u.id = m.candidate_id
        WHERE m.status = 'open'
          AND u.language = $1
        ORDER BY m.created_at`,
      [language],
    );
    return rows.map((r) => ({
      id:            r.id,
      candidateId:   r.candidate_id,
      candidateName: r.candidate_name,
      agoraChannel:  r.agora_channel,
      createdAt:     r.created_at.toISOString(),
    }));
  }

  /**
   * Returns the meeting ID if the candidate currently has an INTERRUPTED meeting,
   * null otherwise.
   */
  async findInterruptedMeetingForCandidate(candidateId: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ current_meeting_id: string }>(
      `SELECT current_meeting_id
         FROM candidate_presence
        WHERE user_id = $1
          AND status = 'disconnected'
          AND current_meeting_id IS NOT NULL`,
      [candidateId],
    );
    return rows[0]?.current_meeting_id ?? null;
  }

  /**
   * Returns the meeting ID if this user is a participant in an INTERRUPTED meeting
   * and has not explicitly left.
   */
  async findInterruptedMeetingForParticipant(userId: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ meeting_id: string }>(
      `SELECT mp.meeting_id
         FROM meeting_participants mp
         JOIN meetings m ON m.id = mp.meeting_id
        WHERE mp.user_id = $1
          AND mp.left_at IS NULL
          AND m.status = 'interrupted'
        LIMIT 1`,
      [userId],
    );
    return rows[0]?.meeting_id ?? null;
  }

  /**
   * Authoritative socket recovery lookup.
   * Includes 'open' so a reconnecting candidate is reattached to their solo room.
   */
  async resumeOrAttachCurrentMeeting(
    userId: string,
    role: 'candidate' | 'interviewer' | 'supervisor',
  ): Promise<CurrentMeetingAttachment | null> {
    if (role === 'supervisor') return null;

    const predicate = role === 'candidate'
      ? 'candidate_id = $1'
      : 'interviewer_id = $1';

    const { rows } = await this.deps.pool.query<MeetingRow>(
      `SELECT id, interviewer_id, candidate_id, agora_channel, status
         FROM meetings
        WHERE ${predicate}
          AND status IN ('open', 'claimed', 'connecting', 'active', 'interrupted')
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id:            row.id,
      interviewerId: row.interviewer_id,
      candidateId:   row.candidate_id,
      agoraChannel:  row.agora_channel,
      status:        row.status,
      shouldMarkReconnected: row.status === 'interrupted',
    };
  }

  /** Returns active/interrupted meetings. Used by supervisor dashboard. */
  async getActiveMeetings(): Promise<MeetingDetails[]> {
    const { rows } = await this.deps.pool.query<MeetingRow>(
      `SELECT id, interviewer_id, candidate_id, agora_channel, status
         FROM meetings
        WHERE status IN ('active', 'interrupted')
        ORDER BY started_at DESC NULLS LAST`,
    );
    return rows.map((row) => ({
      id:            row.id,
      interviewerId: row.interviewer_id,
      candidateId:   row.candidate_id,
      agoraChannel:  row.agora_channel,
      status:        row.status,
    }));
  }

  /** Returns active/interrupted meetings with participant names, filtered to a single language. Used by supervisor dashboard. */
  async getActiveMeetingsWithNames(language: string): Promise<MeetingDetailsWithNames[]> {
    const { rows } = await this.deps.pool.query<MeetingRowWithNames>(
      `SELECT m.id, m.interviewer_id, m.candidate_id, m.agora_channel, m.status,
              iv.name AS interviewer_name, ca.name AS candidate_name
         FROM meetings m
         LEFT JOIN users iv ON iv.id = m.interviewer_id
         JOIN users ca ON ca.id = m.candidate_id
        WHERE m.status IN ('active', 'interrupted')
          AND ca.language = $1
        ORDER BY m.started_at DESC NULLS LAST`,
      [language],
    );
    return rows.map((row) => ({
      id:              row.id,
      interviewerId:   row.interviewer_id,
      candidateId:     row.candidate_id,
      agoraChannel:    row.agora_channel,
      status:          row.status,
      interviewerName: row.interviewer_name,
      candidateName:   row.candidate_name,
    }));
  }

  /** Like getMeeting() but includes participant names. Used by HTTP GET /meetings/:id. */
  async getMeetingWithNames(meetingId: string): Promise<MeetingDetailsWithNames> {
    const { rows } = await this.deps.pool.query<MeetingRowWithNames>(
      `SELECT m.id, m.interviewer_id, m.candidate_id, m.agora_channel, m.status,
              iv.name AS interviewer_name, ca.name AS candidate_name
         FROM meetings m
         LEFT JOIN users iv ON iv.id = m.interviewer_id
         JOIN users ca ON ca.id = m.candidate_id
        WHERE m.id = $1`,
      [meetingId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`Meeting ${meetingId} not found`);
    return {
      id:              row.id,
      interviewerId:   row.interviewer_id,
      candidateId:     row.candidate_id,
      agoraChannel:    row.agora_channel,
      status:          row.status,
      interviewerName: row.interviewer_name,
      candidateName:   row.candidate_name,
    };
  }

  /** Plain read — no lock, no transaction. */
  async getMeeting(meetingId: string): Promise<MeetingDetails> {
    const { rows } = await this.deps.pool.query<MeetingRow>(
      `SELECT id, interviewer_id, candidate_id, agora_channel, status
         FROM meetings
        WHERE id = $1`,
      [meetingId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`Meeting ${meetingId} not found`);
    return {
      id:           row.id,
      interviewerId: row.interviewer_id,
      candidateId:  row.candidate_id,
      agoraChannel: row.agora_channel,
      status:       row.status,
    };
  }

  private async scheduleGraceExpiry(meetingId: string, disconnectedAt: Date): Promise<void> {
    const runAt = new Date(disconnectedAt.getTime() + this.deps.graceWindowSeconds * 1000);
    const delay = Math.max(0, runAt.getTime() - Date.now());
    try {
      await this.deps.scheduler.schedule('grace_expiry', { meetingId }, delay, `grace_expiry:${meetingId}`);
    } catch (err) {
      logger.error({ err, meetingId }, 'scheduleGraceExpiry: failed — grace timer not set (Redis down?)');
    }
  }

  /**
   * Transitions meeting: claimed → connecting.
   * Legacy path — not used for open meetings.
   */
  async onCandidateJoin(meetingId: string): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = rows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      guardMeetingTransition(meeting.status, 'candidate_join');

      await client.query(
        `UPDATE meetings SET status = 'connecting' WHERE id = $1`,
        [meetingId],
      );

      await client.query('COMMIT');
      logger.info({ meetingId }, 'meeting connecting');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transitions meeting: connecting → active, candidate: claimed → in_meeting.
   * Legacy path — not used for open meetings (Deepgram is started in onInterviewerJoin instead).
   */
  async onBothConnected(meetingId: string): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meetingRows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = meetingRows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      guardMeetingTransition(meeting.status, 'both_connected');

      const { rows: presenceRows } = await client.query<CandidatePresenceRow>(
        `SELECT user_id, status FROM candidate_presence WHERE user_id = $1 FOR UPDATE`,
        [meeting.candidate_id],
      );
      const presence = presenceRows[0];
      if (!presence) throw new NotFoundError(`Candidate presence for ${meeting.candidate_id} not found`);

      guardCandidateTransition(presence.status, 'meeting_active');

      const now = new Date();

      await client.query(
        `UPDATE meetings SET status = 'active', started_at = $2 WHERE id = $1`,
        [meetingId, now],
      );
      await client.query(
        `UPDATE candidate_presence SET status = 'in_meeting', updated_at = $2 WHERE user_id = $1`,
        [meeting.candidate_id, now],
      );

      await client.query('COMMIT');

      this.deps.deepgramManager.start(meetingId, meeting.candidate_id);
      logger.info({ meetingId }, 'meeting active');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transitions meeting: connecting|active → interrupted, candidate: in_meeting → disconnected.
   */
  async onParticipantDisconnect(meetingId: string, userId: string): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meetingRows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = meetingRows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      try {
        guardMeetingTransition(meeting.status, 'disconnect');
      } catch (err) {
        await client.query('ROLLBACK');
        if (err instanceof InvalidTransitionError) {
          logger.debug(
            { meetingId, currentStatus: meeting.status },
            'participant_disconnect: meeting already transitioned, skipping',
          );
          return;
        }
        throw err;
      }

      const now = new Date();

      await client.query(
        `UPDATE meetings SET status = 'interrupted' WHERE id = $1`,
        [meetingId],
      );
      await client.query(
        `UPDATE meeting_participants SET disconnected_at = $3 WHERE meeting_id = $1 AND user_id = $2`,
        [meetingId, userId, now],
      );

      if (userId === meeting.candidate_id) {
        const { rows: presenceRows } = await client.query<CandidatePresenceRow>(
          `SELECT user_id, status FROM candidate_presence WHERE user_id = $1 FOR UPDATE`,
          [meeting.candidate_id],
        );
        const presence = presenceRows[0];
        if (presence) {
          try {
            guardCandidateTransition(presence.status, 'participant_disconnect');
            await client.query(
              `UPDATE candidate_presence SET status = 'disconnected', updated_at = $2 WHERE user_id = $1`,
              [meeting.candidate_id, now],
            );
          } catch (err) {
            if (!(err instanceof InvalidTransitionError)) throw err;
            logger.debug(
              { meetingId, candidateStatus: presence.status },
              'participant_disconnect: candidate presence already transitioned, skipping',
            );
          }
        }
      }

      await client.query('COMMIT');

      await this.scheduleGraceExpiry(meetingId, now);
      logger.info({ meetingId, userId }, 'meeting interrupted — grace timer started');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transitions meeting: interrupted → active, candidate: disconnected → in_meeting.
   */
  async onParticipantReconnect(meetingId: string, userId: string): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meetingRows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = meetingRows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      guardMeetingTransition(meeting.status, 'reconnect');

      const now = new Date();

      await client.query(
        `UPDATE meetings SET status = 'active' WHERE id = $1`,
        [meetingId],
      );
      await client.query(
        `UPDATE meeting_participants SET disconnected_at = NULL WHERE meeting_id = $1 AND user_id = $2`,
        [meetingId, userId],
      );

      if (userId === meeting.candidate_id) {
        const { rows: presenceRows } = await client.query<CandidatePresenceRow>(
          `SELECT user_id, status FROM candidate_presence WHERE user_id = $1 FOR UPDATE`,
          [meeting.candidate_id],
        );
        const presence = presenceRows[0];
        if (presence) {
          try {
            guardCandidateTransition(presence.status, 'participant_reconnect');
            await client.query(
              `UPDATE candidate_presence SET status = 'in_meeting', updated_at = $2 WHERE user_id = $1`,
              [meeting.candidate_id, now],
            );
          } catch (err) {
            if (!(err instanceof InvalidTransitionError)) throw err;
            logger.debug(
              { meetingId, candidateStatus: presence.status },
              'participant_reconnect: candidate presence already transitioned, skipping',
            );
          }
        }
      }

      await client.query('COMMIT');

      await this.deps.scheduler.cancel(`grace_expiry:${meetingId}`)
        .catch((err) => logger.error({ err, meetingId }, 'onParticipantReconnect: cancel grace timer failed'));
      logger.info({ meetingId, userId }, 'participant reconnected — grace timer cancelled');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transitions meeting: open|active|interrupted → ended.
   * Handles candidate presence cleanup and Deepgram stop.
   */
  async endMeeting(meetingId: string, reason: EndReason): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meetingRows } = await client.query<MeetingRow>(
        `SELECT id, candidate_id, status FROM meetings WHERE id = $1 FOR UPDATE`,
        [meetingId],
      );
      const meeting = meetingRows[0];
      if (!meeting) throw new NotFoundError(`Meeting ${meetingId} not found`);

      // 'grace_expired' only allows interrupted→ended; 'end' allows open|active|interrupted→ended.
      // Using the narrower event when reason is grace_expired prevents a late-firing grace job
      // from terminating a meeting that has already been reconnected to 'active'.
      const transitionEvent = reason === 'grace_expired' ? 'grace_expired' : 'end';
      guardMeetingTransition(meeting.status, transitionEvent);

      const now = new Date();

      await client.query(
        `UPDATE meetings SET status = 'ended', ended_at = $2, end_reason = $3 WHERE id = $1`,
        [meetingId, now, reason],
      );

      const { rows: presenceRows } = await client.query<CandidatePresenceRow>(
        `SELECT user_id, status FROM candidate_presence WHERE user_id = $1 FOR UPDATE`,
        [meeting.candidate_id],
      );
      const presence = presenceRows[0];
      if (presence) {
        try {
          guardCandidateTransition(presence.status, 'meeting_ended');
          await client.query(
            `UPDATE candidate_presence
                SET status             = 'offline',
                    claimed_by         = NULL,
                    claimed_at         = NULL,
                    current_meeting_id = NULL,
                    updated_at         = $2
              WHERE user_id = $1`,
            [meeting.candidate_id, now],
          );
        } catch (err) {
          if (!(err instanceof InvalidTransitionError)) throw err;
          logger.debug(
            { meetingId, candidateStatus: presence.status },
            'end_meeting: candidate presence already transitioned, skipping',
          );
        }
      }

      await client.query('COMMIT');

      await this.deps.scheduler.cancel(`grace_expiry:${meetingId}`)
        .catch((err) => logger.error({ err, meetingId }, 'endMeeting: cancel grace timer failed'));
      try {
        await this.deps.transcriptService.flush(meetingId);
      } finally {
        this.deps.transcriptService.clearSeqCounter(meetingId);
        this.deps.deepgramManager.stop(meetingId);
      }
      logger.info({ meetingId, reason }, 'meeting ended');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Called by the scheduler when GRACE_WINDOW_SECONDS elapses without a reconnect.
   */
  async onGraceExpired(meetingId: string): Promise<void> {
    try {
      await this.endMeeting(meetingId, 'grace_expired');
    } catch (err) {
      if (err instanceof InvalidTransitionError || err instanceof NotFoundError) {
        logger.debug({ meetingId }, 'grace_expired: meeting already resolved, skipping');
        return;
      }
      throw err;
    }
  }
}
