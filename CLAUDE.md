# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RecruitMonitor is a real-time interview monitoring platform. Interviewers conduct live video interviews (Agora RTC); supervisors silently monitor (stealth mode); Deepgram Nova-2 transcribes candidate audio server-side via Socket.IO.

Monorepo with two packages: `client/` (React 19 + Vite + Tailwind) and `server/` (Node.js + Express + Socket.IO). Plain JavaScript throughout — no TypeScript.

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

**All state is in-memory** — `server/src/state/roomRegistry.js` uses plain Maps. All session data is destroyed when the interview ends. `server/src/db/` exists but is empty (future placeholder). No persistence, no recovery on server restart.

**Supabase env vars are required at startup** — `server/src/lib/supabase.js` exits with code 1 if any of `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` are missing, even if a given request doesn't use Supabase.

**`_sv_` supervisor prefix** — supervisor Agora UIDs are prefixed `_sv_` (set in `server/src/socket/interviewerHandlers.js`). `client/src/hooks/useAgora.js` filters these out of `remoteUsers`. Never change this prefix without updating both sides.

## Socket.IO Namespaces

| Namespace | Auth | Notes |
|-----------|------|-------|
| `/interviewer` | JWT required | Creates/ends rooms, edits transcripts |
| `/candidate` | None (room code acts as credential) | Sends audio chunks for Deepgram |
| `/supervisor` | JWT required | Stealth — UID prefixed `_sv_`, no audio/video publish, filtered from client view |

Before broadcasting room data to clients, `socketId` fields are stripped to hide socket identity from supervisors.

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
- **Server**: Railway — `npm start` (`node src/index.js`). Railway sets `PORT` automatically.

## Default Test Credentials (local dev)

See README.md for current values — these are seeded in Supabase.
