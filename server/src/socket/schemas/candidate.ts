import { z } from 'zod';

// Raw PCM audio from the browser — arrives as a Node.js Buffer over the binary Socket.IO transport.
export const audioChunkSchema = z.custom<Buffer>(
  (v) => Buffer.isBuffer(v),
  'Expected Buffer',
);

// Heartbeat carries no payload.
export const heartbeatSchema = z.undefined();

// start_session carries no payload — candidate clicked "Start Session" on the pre-join screen.
export const startSessionSchema = z.undefined();

export const candidateLeaveMeetingSchema = z.object({
  meetingId: z.string().uuid(),
});
