# RecruitMonitor — Interview Monitoring Platform

An internal recruitment interview monitoring platform enabling interviewers to conduct video interviews with candidates while supervisors silently monitor in real-time.

## Features

- **Video Interviews** — Real-time video/audio via Agora RTC
- **Live Transcription** — Candidate speech transcribed via Deepgram Nova-2
- **Supervisor Stealth Monitoring** — Supervisors can observe any interview without being detected
- **Editable Transcripts** — Interviewers can edit transcripts live; all edits sync in real-time
- **No Database** — All session data lives in server memory and is destroyed when the interview ends
- **Role-Based Access** — JWT authentication for interviewers and supervisors; candidates join via room code

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS v3, Zustand, React Router v6 |
| Backend | Node.js, Express, Socket.IO |
| RTC | Agora Web SDK |
| Speech-to-Text | Deepgram Nova-2 (native WebSocket) |
| Auth | JWT + bcryptjs |
| State | In-memory Node.js Maps |

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- Agora App ID (from [Agora Console](https://console.agora.io))
- Deepgram API Key (from [Deepgram Console](https://console.deepgram.com))

### Setup

```bash
# Clone and install
cd interview-platform
npm install --workspaces

# Configure environment
cp server/.env.example server/.env
cp client/.env.example client/.env
# Edit both .env files with your actual keys

# Start development
npm run dev:server   # Terminal 1 — starts on port 4000
npm run dev:client   # Terminal 2 — starts on port 5173
```

### Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Interviewer | interviewer@company.com | interviewer123 |
| Supervisor | supervisor@company.com | supervisor123 |

Candidates do not need credentials — they join via a 6-character room code.

## Architecture

```
interview-platform/
├── client/          # React frontend (Vite)
│   ├── public/      # Static assets (AudioWorklet processor)
│   └── src/
│       ├── components/   # Reusable UI components
│       ├── hooks/        # Custom hooks (Agora, Socket, Transcript)
│       ├── pages/        # Route pages
│       └── store/        # Zustand state stores
└── server/          # Node.js backend (Express + Socket.IO)
    └── src/
        ├── middleware/   # Auth middleware
        ├── routes/       # REST API routes
        ├── socket/       # Socket.IO namespace handlers
        └── state/        # In-memory room registry
```

## Deployment

### Backend on Railway

1. Connect GitHub repo → select `server/` as root directory
2. **Build command:** `npm install`
3. **Start command:** `npm start`
4. Add environment variables:
   - `PORT` — Railway assigns automatically
   - `JWT_SECRET` — minimum 32 characters
   - `CLIENT_ORIGIN` — your Vercel URL (e.g., `https://yourapp.vercel.app`)
   - `CLIENT_ORIGIN_PROD` — same as above
   - `INTERVIEWER_EMAIL` — interviewer login email
   - `INTERVIEWER_PASSWORD` — interviewer login password
   - `SUPERVISOR_EMAIL` — supervisor login email
   - `SUPERVISOR_PASSWORD` — supervisor login password
   - `AGORA_APP_ID` — from Agora Console
5. Note the Railway URL after deploy

### Frontend on Vercel

1. Connect GitHub repo → select `client/` as root directory
2. **Build command:** `npm run build`
3. **Output directory:** `dist`
4. Add environment variables:
   - `VITE_API_URL` — Railway backend URL
   - `VITE_SOCKET_URL` — Railway backend URL (same)
   - `VITE_AGORA_APP_ID` — from Agora Console
   - `VITE_DEEPGRAM_API_KEY` — from Deepgram Console
5. Redeploy after adding variables

## How It Works

### Interview Flow

1. **Interviewer** logs in → creates a room → receives a 6-character room code
2. **Candidate** enters their name + room code → joins the interview
3. Both participants see each other's video/audio
4. Candidate's speech is transcribed in real-time via Deepgram
5. Interviewer can edit the transcript; edits sync to all participants
6. **Supervisor** can silently join any active room — completely invisible to both parties

### Supervisor Stealth Mechanism

- Supervisor's Agora UID starts with `_sv_`
- The `useAgora` hook filters out any remote user with `_sv_` prefix
- Supervisor never publishes audio/video tracks
- Supervisor is never shown in the participant panel
- Socket ID information is stripped before sending room data to clients

### Data Privacy

- All transcript data exists only in server memory during the session
- When an interview ends, all data is permanently destroyed
- No database, no file storage, no logs of interview content
- Idle rooms are automatically cleaned up after 30 minutes

## API Reference

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/login | No | Login with email/password |
| GET | /auth/me | JWT | Get current user info |
| GET | /rooms/active | JWT (supervisor) | List all active rooms |
| GET | /health | No | Health check |

### Socket.IO Namespaces

- `/interviewer` — JWT-authenticated interviewer events
- `/candidate` — Unauthenticated candidate events (room code is credential)
- `/supervisor` — JWT-authenticated supervisor events

## License

Internal use only.
