# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RecruitMonitor is a real-time interview monitoring platform. Interviewers conduct live video interviews (Agora RTC); supervisors silently monitor (stealth mode); Deepgram Nova-2 transcribes candidate audio server-side via Socket.IO.

Monorepo with two packages: `client/` (React 19 + Vite + Tailwind) and `server/` (Node.js + Express + Socket.IO).

**Languages:** Client is plain JavaScript (`.jsx`). Server is TypeScript — entry point is `server/src/server.ts`, run via `tsx` (`node --import tsx/esm src/server.ts` in production, `tsx watch src/server.ts` in dev). No compile step; tsx transpiles on the fly. A legacy `.js` layer exists under `server/src/_legacy_unused/` — those files are not imported by anything and do not run.

## Dev Commands

Run in two separate terminals:

```
# Terminal 1
npm run dev:server        # Express on port 4000

# Terminal 2
npm run dev:client        # Vite on port 5173
```

```
npm run build:client      # Production bundle → client/dist/
cd client && npm run lint # ESLint (client only; no server-side lint config)
```

## Critical Gotchas

**No React StrictMode** — `client/src/main.jsx` deliberately omits `<React.StrictMode>`. StrictMode double-invokes effects and breaks Agora RTC + Socket.IO lifecycle. Do not add it.

**State is persisted to Postgres** — `server/src/domain/TranscriptService.ts` buffers transcript segments and flushes to the DB. Meeting state lives in `server/src/domain/MeetingService.ts` backed by `server/src/db/pool.ts`. `server/src/db/` is active; run `npm run migrate` (inside `server/`) to apply migrations.

**Supabase env vars are required at startup** — `server/src/lib/supabase.ts` is the live Supabase client; it reads from `config/env.ts` which exits with code 1 on missing vars.

**Supervisor stealth** — enforced by two independent mechanisms: (1) the server issues a `subscriber`-only Agora token (`server/src/socket/namespaces/supervisor.ts`, `role: 'subscriber'`), which Agora's media servers enforce at the protocol level; (2) `client/src/hooks/useAgora.js` skips track creation and `client.publish()` entirely for `role === 'supervisor'` (lines 167–211). A supervisor never triggers `user-published` on other clients, so the supervisor UID is never added to `remoteUsers` — no client-side prefix filter is used or needed.

## Socket.IO Namespaces

| Namespace | Auth | Notes |
|-----------|------|-------|
| `/interviewer` | JWT required | Creates/ends meetings, edits transcripts — `server/src/socket/namespaces/interviewer.ts` |
| `/candidate` | JWT required (role: `candidate`) | Sends audio chunks for Deepgram — `server/src/socket/namespaces/candidate.ts` |
| `/supervisor` | JWT required (role: `supervisor`) | Stealth — subscriber-only Agora token; skips track creation/publish client-side; never fires `user-published` on other clients — `server/src/socket/namespaces/supervisor.ts` |

## Environment Variables

**Client** (`client/.env`):
```
VITE_API_URL=http://localhost:4000
VITE_SOCKET_URL=http://localhost:4000
VITE_AGORA_APP_ID=<agora_app_id>
```

**Server** (`server/.env`):
```
PORT=4000
JWT_SECRET=<min 32 chars>
CLIENT_ORIGIN=http://localhost:5173
CLIENT_ORIGIN_PROD=https://yourapp.vercel.app
AGORA_APP_ID=<agora_app_id>
DEEPGRAM_API_KEY=<deepgram_key>
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=<anon_key>
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

## Deployment

- **Client**: Vercel — `npm run build:client`, output `dist/`. `client/vercel.json` handles SPA rewrites.
- **Server**: Railway — `npm start` (`node --import tsx/esm src/server.ts`). Railway sets `PORT` automatically. Dockerfile is at `server/Dockerfile`.

## Default Test Credentials (local dev)

See README.md for current values — these are seeded in Supabase.
