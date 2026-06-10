import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const redis: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    })
  : null;

if (redis) {
  redis.on('connect', () => logger.info('Redis connected'));
  redis.on('error', (err: Error & { name?: string; code?: string }) => {
    // MaxRetriesPerRequestError and ECONNRESET are expected when Redis is flaky or
    // when we've already decided to fall back to in-memory. Log quietly so they don't
    // flood the log at error level.
    if (err.name === 'MaxRetriesPerRequestError' || err.code === 'ECONNRESET') {
      logger.debug({ msg: err.message }, 'Redis transient error (suppressed)');
    } else {
      logger.error({ err }, 'Redis error');
    }
  });
}

/**
 * Permanently closes the Redis connection and stops ioredis's internal retry loop.
 * Call this immediately after waitForRedis() returns false to prevent log spam from
 * repeated reconnect attempts that will never succeed.
 */
export function disconnectRedis(): void {
  if (redis) {
    redis.disconnect();
    logger.info('Redis disconnected — in-memory fallback active, reconnect loop stopped');
  }
}

/**
 * Resolves true if Redis is already ready or becomes ready within timeoutMs.
 * Resolves false when REDIS_URL is absent or Redis does not connect in time.
 */
export async function waitForRedis(timeoutMs = 5_000): Promise<boolean> {
  if (!redis) return false;
  if (redis.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      redis!.removeListener('ready', onReady);
      redis!.removeListener('error', onError);
      resolve(value);
    };
    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, 'Redis did not connect within timeout — using in-memory fallback');
      settle(false);
    }, timeoutMs);
    const onReady = () => settle(true);
    const onError = () => settle(false);
    redis.once('ready', onReady);
    redis.once('error', onError);
  });
}
