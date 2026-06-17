import type { Pool } from 'pg';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { NotFoundError, ForbiddenError } from '../lib/errors.js';

export interface TranscriptServiceDeps {
  pool: Pool;
}

export type SpeakerRole = 'candidate' | 'interviewer' | 'system';

export interface AppendSegmentParams {
  meetingId: string;
  speakerUserId: string | null;
  speakerRole: SpeakerRole;
  text: string;
  startedAt: Date;
  endedAt: Date;
  isFinal: boolean;
  confidence: number | null;
}

export interface SegmentRow {
  id: string;
  meetingId: string;
  seq: number;
  speakerUserId: string | null;
  speakerRole: SpeakerRole;
  text: string;
  startedAt: Date;
  endedAt: Date;
  isFinal: boolean;
  confidence: number | null;
  createdAt: Date;
}

export interface AddNoteParams {
  meetingId: string;
  anchorSegmentId: string | null;
  authorUserId: string;
  body: string;
}

export interface NoteRow {
  id: string;
  meetingId: string;
  anchorSegmentId: string | null;
  authorUserId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

interface BufferedSegment {
  id: string;
  seq: number;
  params: AppendSegmentParams;
}

const BATCH_SIZE         = 20;
const FLUSH_INTERVAL_MS  = 500;
const MAX_DRAIN_ATTEMPTS = 3;   // consecutive failures before explicit drain gives up
const DRAIN_BACKOFF_MS   = 50;  // ms between retries in the bounded drain loop

export class TranscriptService {
  private readonly seqCounters     = new Map<string, number>();
  private readonly seqInitPromises = new Map<string, Promise<void>>();
  private readonly segmentBuffer   = new Map<string, BufferedSegment[]>();
  private readonly flushInFlight    = new Map<string, Promise<void>>();
  private readonly flushTimer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: TranscriptServiceDeps) {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => logger.error({ err }, 'transcript interval flush failed'));
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Assigns a seq number and buffers the segment for a batch DB write.
   * Returns immediately — the broadcast path is not delayed.
   * The DB write is flushed every 500ms or when the buffer reaches 20 segments.
   */
  async appendSegment(params: AppendSegmentParams): Promise<{ id: string; seq: number }> {
    if (!this.seqCounters.has(params.meetingId)) {
      // Single-flight init: all concurrent first-calls for the same meeting share ONE
      // MAX(seq) query. The promise is stored before the first await, so any concurrent
      // caller that checks seqInitPromises before the query resolves finds it and waits
      // on the same Promise — no second query is issued, no two callers bootstrap from
      // the same max and produce duplicate seq values.
      if (!this.seqInitPromises.has(params.meetingId)) {
        const p = this.deps.pool
          .query<{ max_seq: number }>(
            `SELECT COALESCE(MAX(seq), 0) AS max_seq
               FROM transcript_segments
              WHERE meeting_id = $1`,
            [params.meetingId],
          )
          .then(({ rows }) => {
            this.seqCounters.set(params.meetingId, rows[0]!.max_seq);
          })
          .finally(() => {
            this.seqInitPromises.delete(params.meetingId);
          });
        this.seqInitPromises.set(params.meetingId, p);
      }
      await this.seqInitPromises.get(params.meetingId)!;
    }

    const seq = this.seqCounters.get(params.meetingId)! + 1;
    this.seqCounters.set(params.meetingId, seq);
    const id = newId();

    const buffer = this.segmentBuffer.get(params.meetingId) ?? [];
    buffer.push({ id, seq, params });
    this.segmentBuffer.set(params.meetingId, buffer);

    if (buffer.length >= BATCH_SIZE) {
      await this.flush(params.meetingId);
    }

    logger.debug({ meetingId: params.meetingId, seq, isFinal: params.isFinal }, 'segment buffered');
    return { id, seq };
  }

  /**
   * Flushes buffered segments to the DB.
   *
   * Interval path (no meetingId): fires per-meeting writes in parallel, skips any
   * meeting already being written (avoids double-write on slow DB).
   *
   * Explicit path (meetingId given, called by endMeeting or BATCH_SIZE trigger):
   * awaits any in-flight write first, then drains until the buffer is fully empty.
   * Caps consecutive failures at MAX_DRAIN_ATTEMPTS so a permanently-down DB
   * degrades to "last segments lost" rather than an infinite loop.
   */
  async flush(meetingId?: string): Promise<void> {
    if (meetingId !== undefined) {
      const existing = this.flushInFlight.get(meetingId);
      if (existing) await existing;
      let consecutiveFailures = 0;
      while ((this.segmentBuffer.get(meetingId)?.length ?? 0) > 0) {
        const ok = await this.writeOnce(meetingId);
        if (ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_DRAIN_ATTEMPTS) {
            logger.error(
              { meetingId, buffered: this.segmentBuffer.get(meetingId)?.length ?? 0 },
              'transcript drain: max consecutive failures — remaining segments lost',
            );
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_BACKOFF_MS));
        }
      }
      return;
    }

    // Interval path: launch writes in parallel; skip meetings already in flight.
    for (const mid of Array.from(this.segmentBuffer.keys())) {
      if (this.flushInFlight.has(mid)) continue;
      const buffer = this.segmentBuffer.get(mid);
      if (!buffer || buffer.length === 0) {
        this.segmentBuffer.delete(mid);
        continue;
      }
      void this.writeOnce(mid);
    }
  }

  // Snapshots the current buffer for one meeting and starts the DB write.
  // Returns true if the write succeeded, false on any error (after logging).
  // Transient errors: snapshot is re-prepended for next attempt.
  // 23505 unique violation: snapshot is dropped (retrying identical seqs never succeeds).
  // Stores the in-flight promise in flushInFlight so interval skips this meeting.
  private writeOnce(mid: string): Promise<boolean> {
    const buffer   = this.segmentBuffer.get(mid) ?? [];
    const snapshot = buffer.splice(0);
    if (snapshot.length === 0) return Promise.resolve(true);

    const p: Promise<boolean> = this.insertBatch(snapshot)
      .then((): true => true)
      .catch((err: unknown): false => {
        const isUniqueViolation = (err as { code?: string })?.code === '23505';
        if (isUniqueViolation) {
          logger.error(
            { err, meetingId: mid, count: snapshot.length },
            'transcript batch flush: seq collision (23505) — batch dropped',
          );
        } else {
          logger.error(
            { err, meetingId: mid, count: snapshot.length },
            'transcript batch flush failed — retained for retry',
          );
          const live = this.segmentBuffer.get(mid) ?? [];
          this.segmentBuffer.set(mid, [...snapshot, ...live]);
        }
        return false;
      })
      .finally(() => {
        this.flushInFlight.delete(mid);
      });

    this.flushInFlight.set(mid, p.then(() => undefined));
    return p;
  }

  private async insertBatch(segments: BufferedSegment[]): Promise<void> {
    if (segments.length === 0) return;

    const ids         = segments.map((s) => s.id);
    const meetingIds  = segments.map((s) => s.params.meetingId);
    const seqs        = segments.map((s) => s.seq);
    const speakerIds  = segments.map((s) => s.params.speakerUserId);
    const roles       = segments.map((s) => s.params.speakerRole);
    const texts       = segments.map((s) => s.params.text);
    const startedAts  = segments.map((s) => s.params.startedAt);
    const endedAts    = segments.map((s) => s.params.endedAt);
    const isFinals    = segments.map((s) => s.params.isFinal);
    const confidences = segments.map((s) => s.params.confidence);

    await this.deps.pool.query(
      `INSERT INTO transcript_segments
         (id, meeting_id, seq, speaker_user_id, speaker_role,
          text, started_at, ended_at, is_final, confidence)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::int[], $4::uuid[], $5::speaker_role[],
         $6::text[], $7::timestamptz[], $8::timestamptz[], $9::bool[], $10::float8[]
       )`,
      [ids, meetingIds, seqs, speakerIds, roles, texts, startedAts, endedAts, isFinals, confidences],
    );
    logger.debug({ count: segments.length }, 'transcript batch written');
  }

  /** Evicts the seq counter for a meeting. Called by MeetingService on endMeeting after flush. */
  clearSeqCounter(meetingId: string): void {
    this.seqCounters.delete(meetingId);
  }

  /**
   * Returns segments in seq order.
   * afterSeq is exclusive — pass the last seq seen for cursor-based pagination.
   */
  async getSegments(
    meetingId: string,
    afterSeq = 0,
    limit = 100,
  ): Promise<SegmentRow[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      meeting_id: string;
      seq: number;
      speaker_user_id: string | null;
      speaker_role: SpeakerRole;
      text: string;
      started_at: Date;
      ended_at: Date;
      is_final: boolean;
      confidence: number | null;
      created_at: Date;
    }>(
      `SELECT id, meeting_id, seq, speaker_user_id, speaker_role,
              text, started_at, ended_at, is_final, confidence, created_at
         FROM transcript_segments
        WHERE meeting_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [meetingId, afterSeq, limit],
    );

    return rows.map((r) => ({
      id:            r.id,
      meetingId:     r.meeting_id,
      seq:           r.seq,
      speakerUserId: r.speaker_user_id,
      speakerRole:   r.speaker_role,
      text:          r.text,
      startedAt:     r.started_at,
      endedAt:       r.ended_at,
      isFinal:       r.is_final,
      confidence:    r.confidence,
      createdAt:     r.created_at,
    }));
  }

  /** Returns all notes for a meeting in creation order. */
  async getNotes(meetingId: string): Promise<NoteRow[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      meeting_id: string;
      anchor_segment_id: string | null;
      author_user_id: string;
      body: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, meeting_id, anchor_segment_id, author_user_id, body, created_at, updated_at
         FROM transcript_notes
        WHERE meeting_id = $1
        ORDER BY created_at`,
      [meetingId],
    );
    return rows.map((r) => ({
      id:              r.id,
      meetingId:       r.meeting_id,
      anchorSegmentId: r.anchor_segment_id,
      authorUserId:    r.author_user_id,
      body:            r.body,
      createdAt:       r.created_at,
      updatedAt:       r.updated_at,
    }));
  }

  /**
   * Adds an interviewer note, optionally anchored to a segment.
   * Validates that anchorSegmentId, if given, belongs to the same meeting.
   */
  async addNote(params: AddNoteParams): Promise<NoteRow> {
    if (params.anchorSegmentId !== null) {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id FROM transcript_segments WHERE id = $1 AND meeting_id = $2`,
        [params.anchorSegmentId, params.meetingId],
      );
      if (!rows[0]) {
        throw new NotFoundError(
          `Segment ${params.anchorSegmentId} not found in meeting ${params.meetingId}`,
        );
      }
    }

    const id = newId();
    const { rows } = await this.deps.pool.query<{ created_at: Date; updated_at: Date }>(
      `INSERT INTO transcript_notes (id, meeting_id, anchor_segment_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING created_at, updated_at`,
      [id, params.meetingId, params.anchorSegmentId, params.authorUserId, params.body],
    );

    logger.debug({ meetingId: params.meetingId, noteId: id }, 'note added');
    return {
      id,
      meetingId:       params.meetingId,
      anchorSegmentId: params.anchorSegmentId,
      authorUserId:    params.authorUserId,
      body:            params.body,
      createdAt:       rows[0]!.created_at,
      updatedAt:       rows[0]!.updated_at,
    };
  }

  /** Updates a note body. Only the original author may update. */
  async updateNote(noteId: string, body: string, authorUserId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ author_user_id: string }>(
      `SELECT author_user_id FROM transcript_notes WHERE id = $1`,
      [noteId],
    );
    if (!rows[0]) throw new NotFoundError(`Note ${noteId} not found`);
    if (rows[0].author_user_id !== authorUserId) {
      throw new ForbiddenError('Only the note author may update this note');
    }

    await this.deps.pool.query(
      `UPDATE transcript_notes SET body = $2, updated_at = now() WHERE id = $1`,
      [noteId, body],
    );
  }

  /** Deletes a note. Only the original author may delete. */
  async deleteNote(noteId: string, authorUserId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ author_user_id: string }>(
      `SELECT author_user_id FROM transcript_notes WHERE id = $1`,
      [noteId],
    );
    if (!rows[0]) throw new NotFoundError(`Note ${noteId} not found`);
    if (rows[0].author_user_id !== authorUserId) {
      throw new ForbiddenError('Only the note author may delete this note');
    }

    await this.deps.pool.query(
      `DELETE FROM transcript_notes WHERE id = $1`,
      [noteId],
    );
  }
}
