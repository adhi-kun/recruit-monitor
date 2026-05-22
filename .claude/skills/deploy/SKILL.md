---
name: deploy
description: Step-by-step deployment checklist for the interview platform — client to Vercel, server to Railway. Run this when preparing a production release.
disable-model-invocation: true
---

Walk through the deployment checklist interactively:

## Pre-deploy checks

1. Run `/verify` first — fix any lint or startup errors before deploying.
2. Confirm `client/.env` is NOT committed (it's gitignored). Verify Vercel has the correct env vars set:
   - `VITE_API_URL` — Railway server URL (e.g. `https://your-app.railway.app`)
   - `VITE_SOCKET_URL` — same Railway URL
   - `VITE_AGORA_APP_ID`
3. Confirm Railway has all server env vars set:
   - `JWT_SECRET` (min 32 chars)
   - `CLIENT_ORIGIN_PROD` — Vercel app URL
   - `AGORA_APP_ID`
   - `DEEPGRAM_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `PORT` is auto-set by Railway — do not override.

## Deploy client (Vercel)

```bash
npm run build:client
# Then push to main — Vercel auto-deploys from GitHub, or:
vercel --prod  # from client/ directory if using Vercel CLI
```

`client/vercel.json` handles SPA rewrites (all routes → `index.html`).

## Deploy server (Railway)

Push to main (if Railway is linked to GitHub) or use Railway CLI:
```bash
railway up  # from server/ directory
```

Railway runs `npm start` → `node src/index.js`. No build step needed.

## Post-deploy verification

1. Open the Vercel URL — confirm login page loads.
2. Log in as interviewer, create a room, verify room code appears.
3. Open supervisor login in a second tab, join the room — confirm stealth mode (supervisor not visible in participant list).
4. Confirm Deepgram transcription works (candidate audio → transcript).
5. End interview — confirm room is cleaned up (no active rooms listed).
