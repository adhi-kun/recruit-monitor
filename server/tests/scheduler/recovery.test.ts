import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { recoverScheduledJobs } from '../../src/scheduler/recovery.js';

// recoverScheduledJobs was simplified when BullMQ replaced the MemoryScheduler.
// BullMQ persists delayed jobs in Redis and replays them automatically on worker
// restart, so boot-time timer reconstruction from DB is no longer needed.
// The function now does exactly one thing: delete expired sessions.

function makePool(rowCount = 0) {
  const querySpy = vi.fn(async () => ({ rows: [], rowCount }));
  return {
    pool: { query: querySpy } as unknown as Pool,
    querySpy,
  };
}

describe('recoverScheduledJobs', () => {
  it('issues exactly one query — the session DELETE', async () => {
    const { pool, querySpy } = makePool();
    await recoverScheduledJobs({ pool });
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('the single query deletes from the sessions table', async () => {
    const { pool, querySpy } = makePool();
    await recoverScheduledJobs({ pool });
    const sql = querySpy.mock.calls[0]![0] as string;
    expect(sql).toMatch(/DELETE\s+FROM\s+sessions/i);
  });

  it('does not query claimed or interrupted meetings — BullMQ replays jobs from Redis', async () => {
    const { pool, querySpy } = makePool();
    await recoverScheduledJobs({ pool });
    const sqls = querySpy.mock.calls.map(([sql]) => sql as string);
    expect(sqls.every((s) => !/claimed|interrupted/i.test(s))).toBe(true);
  });

  it('resolves to undefined when sessions are deleted', async () => {
    const { pool } = makePool(3);
    await expect(recoverScheduledJobs({ pool })).resolves.toBeUndefined();
  });

  it('resolves to undefined on an empty database', async () => {
    const { pool } = makePool(0);
    await expect(recoverScheduledJobs({ pool })).resolves.toBeUndefined();
  });
});
