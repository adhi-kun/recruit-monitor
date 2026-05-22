---
name: verify
description: Verify the interview platform is in a working state — runs ESLint on the client and confirms the server starts cleanly. Use after making changes to catch lint errors and startup failures before testing manually.
---

Run the following checks in order and report any failures:

1. **Client lint** — run `cd client && npm run lint` from the project root. Report all ESLint errors and warnings. If clean, say so.

2. **Server startup check** — run `node --check server/src/index.js` to verify the server entry point has no syntax errors. Then inspect `server/src/config.js` and `server/src/lib/supabase.js` to confirm all required env vars are documented and that the startup exit-on-missing-env logic is intact.

3. **Summary** — list what passed and what needs fixing. If anything failed, suggest the minimal fix.

Note: there is no test suite. Lint + startup check is the automated safety net. For functional verification (video, sockets, transcription), the app must be run manually with two terminals: `npm run dev:server` and `npm run dev:client`.
