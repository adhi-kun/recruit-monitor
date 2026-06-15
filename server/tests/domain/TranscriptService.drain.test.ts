import { describe, it, expect, vi } from 'vitest';
import { TranscriptService } from '../../src/domain/TranscriptService.js';

// Must match the private constant in TranscriptService.ts.
const MAX_DRAIN_ATTEMPTS = 3;

const SEG = {
  speakerUserId: null as string | null,
  speakerRole:   'candidate' as const,
  text:          'hello',
  startedAt:     new Date(),
  endedAt:       new Date(),
  isFinal:       true,
  confidence:    0.9,
};

describe('TranscriptService drain', () => {
  const mid = 'meeting-drain-test';

  it('TEST 1 — transient failure terminates, does not hang; segment retained', async () => {
    let insertCalls = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
        insertCalls++;
        throw new Error('db down');
      }),
    };

    const svc = new TranscriptService({ pool: pool as any });
    await svc.appendSegment({ meetingId: mid, ...SEG });

    // Must resolve within 1 s — if the drain loops forever this rejects.
    await expect(
      Promise.race([
        svc.flush(mid),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('flush timed out after 1 s')), 1_000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // Attempted exactly MAX_DRAIN_ATTEMPTS inserts before giving up.
    expect(insertCalls).toBe(MAX_DRAIN_ATTEMPTS);

    // Prove segment is still retained: a subsequent successful flush writes it.
    let afterInserts = 0;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
      afterInserts++;
      return { rows: [] };
    });
    await svc.flush(mid);
    expect(afterInserts).toBe(1);
  });

  it('TEST 2 — 23505 unique violation: attempted once, batch dropped, buffer empty', async () => {
    let insertCalls = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
        insertCalls++;
        throw Object.assign(new Error('unique violation'), { code: '23505' });
      }),
    };

    const svc = new TranscriptService({ pool: pool as any });
    await svc.appendSegment({ meetingId: mid, ...SEG });

    await expect(
      Promise.race([
        svc.flush(mid),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('flush timed out after 1 s')), 1_000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // 23505 is not retried.
    expect(insertCalls).toBe(1);

    // Buffer is empty (batch was dropped, not re-prepended).
    let afterInserts = 0;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
      afterInserts++;
      return { rows: [] };
    });
    await svc.flush(mid);
    expect(afterInserts).toBe(0);
  });

  it('TEST 3 — success path: both segments written in a single batch, buffer empty', async () => {
    let insertCalls = 0;
    const batchSizes: number[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
        insertCalls++;
        // params[0] is the ids array; its length equals the batch size.
        batchSizes.push((params[0] as unknown[]).length);
        return { rows: [] };
      }),
    };

    const svc = new TranscriptService({ pool: pool as any });
    await svc.appendSegment({ meetingId: mid, ...SEG });
    await svc.appendSegment({ meetingId: mid, ...SEG });
    await svc.flush(mid);

    expect(insertCalls).toBe(1);
    expect(batchSizes[0]).toBe(2);

    // Prove buffer is empty: a subsequent flush does not call INSERT.
    let afterInserts = 0;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: 0 }] };
      afterInserts++;
      return { rows: [] };
    });
    await svc.flush(mid);
    expect(afterInserts).toBe(0);
  });
});
