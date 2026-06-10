import 'dotenv/config';
import { env } from './config/env.js';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { newId } from './lib/ids.js';
import type { DomainError } from './lib/errors.js';
import { pool, checkDbConnection } from './db/pool.js';
import { waitForRedis, disconnectRedis } from './db/redis.js';
import { BullScheduler, MemoryScheduler } from './scheduler/bullScheduler.js';
import { recoverScheduledJobs } from './scheduler/recovery.js';
import { startPresenceSweeper } from './scheduler/sweeper.js';
import { authRouter } from './http/auth.js';
import { createMeetingsRouter } from './http/meetings.js';
import { createVideosRouter } from './http/videos.js';
import { createCandidatesRouter } from './http/candidates.js';
import { createMetricsRouter } from './http/metrics.js';
import { ClaimService } from './domain/ClaimService.js';
import { MeetingService } from './domain/MeetingService.js';
import { PresenceService } from './domain/PresenceService.js';
import { TranscriptService } from './domain/TranscriptService.js';
import { AgoraTokenService } from './domain/AgoraTokenService.js';
import { SessionService } from './domain/SessionService.js';
import { createSocketServer } from './socket/io.js';
import type { BroadcastHelper } from './socket/broadcast.js';
import { DeepgramManager } from './lib/DeepgramManager.js';

// ── Express app ───────────────────────────────────────────────────────

const app = express();

const allowedOrigins = env.CLIENT_ORIGIN.split(',').map((s) => s.trim());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

app.use(helmet());

app.use(
  pinoHttp({
    logger,
    genReqId: (req: IncomingMessage, _res: ServerResponse) => {
      const forwarded = req.headers['x-request-id'];
      return typeof forwarded === 'string' ? forwarded : newId();
    },
    customProps: (req: IncomingMessage) => ({
      request_id: (req as IncomingMessage & { id: string }).id,
    }),
    autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
  })
);

app.use(express.json({ limit: '1mb' }));

app.use('/auth', authRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: process.env['npm_package_version'] ?? 'unknown',
    nodeEnv: env.NODE_ENV,
    uptime: Math.floor(process.uptime()),
  });
});

const server = http.createServer(app);

// ── Domain services — assigned in main(), available after boot ────────
// Definite assignment (!) is safe: nothing reads these before main() completes.
let claimService!: ClaimService;
let meetingService!: MeetingService;
let presenceService!: PresenceService;
let transcriptService!: TranscriptService;
let agoraTokenService!: AgoraTokenService;
let sessionService!: SessionService;

// ── Boot sequence ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Env is already validated at import time (config/env.ts crashes on missing vars).

  // 2. Verify database connectivity before accepting traffic.
  await checkDbConnection();
  logger.info('database connected');

  // 2b. Check Redis availability once before constructing Redis-dependent services.
  //     Single 5-second window: if Redis isn't ready, fall back to in-memory for everything.
  const redisAvailable = await waitForRedis(5_000);
  if (!redisAvailable) {
    disconnectRedis(); // permanently stop ioredis reconnect loop to prevent log spam
    logger.warn('Redis unavailable — using in-memory scheduler and no Socket.IO Redis adapter');
  }

  // 3. Construct domain services.
  //    presenceService needs broadcast; createSocketServer needs presenceService.
  //    Break the cycle with a lazy ref assigned after socket server creation.
  const broadcastRef: { current?: BroadcastHelper } = {};

  const scheduler = redisAvailable ? new BullScheduler() : new MemoryScheduler();

  transcriptService = new TranscriptService({ pool });

  const deepgramManager = new DeepgramManager({
    apiKey: env.DEEPGRAM_API_KEY,
    transcriptService,
    onSegment: (meetingId, segment) => { broadcastRef.current?.transcriptSegment(meetingId, segment); },
    onFatalError: (meetingId, err) => {
      logger.error({ err, meetingId }, 'Deepgram fatal error');
      broadcastRef.current?.transcriptError(meetingId);
    },
  });

  meetingService = new MeetingService({
    pool,
    scheduler,
    graceWindowSeconds: env.GRACE_WINDOW_SECONDS,
    transcriptService,
    deepgramManager,
  });

  claimService = new ClaimService({
    pool,
    scheduler,
    claimTtlSeconds: env.CLAIM_TTL_SECONDS,
    // presenceService is assigned a few lines below; the closure captures the
    // binding, not the value — safe because no claim can expire in under 60s.
    onCandidateRequeued: (candidateId) => presenceService.broadcastPresenceDelta([candidateId]),
  });

  agoraTokenService = new AgoraTokenService({
    appId: env.AGORA_APP_ID,
    appCertificate: env.AGORA_APP_CERTIFICATE,
    tokenTtlSeconds: env.AGORA_TOKEN_TTL_SECONDS,
  });

  sessionService = new SessionService({
    pool,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  });

  presenceService = new PresenceService({
    pool,
    onBroadcast: async (candidates) => { broadcastRef.current?.presenceDelta(candidates); },
  });

  // 3b. Register BullMQ handlers then start the worker. Worker starts after all
  //     services are wired so handlers can safely close over service instances.
  scheduler.registerHandler('grace_expiry', async ({ meetingId }) => {
    await meetingService.onGraceExpired(meetingId as string);
  });
  scheduler.registerHandler('claim_expiry', async ({ meetingId }) => {
    await claimService.onClaimExpired(meetingId as string);
  });
  scheduler.start();

  // 3c. Register service-dependent HTTP routes.
  //     The error handler must come AFTER these routes so next(err) reaches it.
  app.use('/meetings', createMeetingsRouter(meetingService, transcriptService));
  app.use('/meetings', createVideosRouter(meetingService, pool));
  app.use('/candidates', createCandidatesRouter(pool, transcriptService));
  app.use('/metrics', createMetricsRouter(pool, scheduler, deepgramManager));

  app.use((err: DomainError, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, code: err.code }, err.message);
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'AUTH_ERROR'
          ? 401
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : err.code === 'VALIDATION_ERROR'
                ? 400
                : 500;
    res.status(status).json({ error: err.message, code: err.code });
  });

  logger.info('domain services constructed');

  // 4. Reconstruct any in-flight scheduled jobs that were lost on last restart.
  await recoverScheduledJobs({ pool });

  // 5. Attach socket server — must happen before listen() so the upgrade
  //    handler is in place.
  const { broadcast, io } = createSocketServer(server, {
    meetingService,
    presenceService,
    agoraTokenService,
    transcriptService,
    sessionService,
    deepgramManager,
  }, { redisAvailable });
  broadcastRef.current = broadcast;

  // 6. Start presence sweeper.
  const sweeper = startPresenceSweeper({
    pool,
    intervalMs: env.PRESENCE_SWEEPER_INTERVAL_SECONDS * 1000,
    staleAfterSeconds: env.PRESENCE_STALE_AFTER_SECONDS,
    onPresenceEvicted: (userIds) => presenceService.broadcastPresenceDelta(userIds),
  });

  // 7. Start accepting HTTP connections.
  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server started');
  });

  // 8. Boot-time settle scan.
  // After 10s, check for ACTIVE meetings that have no live sockets — these are
  // meetings that were running when the server last crashed. Transition them to
  // INTERRUPTED so the grace timer fires and participants can reconnect or the
  // meeting ends cleanly. Runs once; clients have 10s to reconnect first.
  setTimeout(async () => {
    try {
      const { rows } = await pool.query<{ id: string; candidate_id: string }>(
        `SELECT id, candidate_id FROM meetings WHERE status = 'active'`,
      );

      if (rows.length === 0) return;
      logger.info({ count: rows.length }, 'settle scan: checking active meetings for orphaned sockets');

      for (const row of rows) {
        const interviewerCount = io.of('/interviewer').adapter.rooms.get(`meeting:${row.id}`)?.size ?? 0;
        const candidateCount   = io.of('/candidate').adapter.rooms.get(`meeting:${row.id}`)?.size ?? 0;

        if (interviewerCount === 0 && candidateCount === 0) {
          logger.info({ meetingId: row.id }, 'settle scan: active meeting has no live sockets — transitioning to interrupted');
          await meetingService.onParticipantDisconnect(row.id, row.candidate_id);
          broadcast.meetingStatus(row.id, 'interrupted');
        }
      }
    } catch (err) {
      logger.error({ err }, 'settle scan failed');
    }
  }, 10_000).unref();

  // 9. Graceful shutdown.
  // Order matters: stop new work first, then close sockets (triggers disconnect
  // handlers), then drain the DB pool. io.close() also closes the HTTP server.
  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    sweeper.stop();
    scheduler.close().catch(() => {});
    deepgramManager.stopAll();
    io.close(() => {
      pool.end().then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});

export { app, server, claimService, meetingService, presenceService, transcriptService, agoraTokenService, sessionService };
