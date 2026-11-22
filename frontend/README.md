# Riyad Tech Outreach: frontend

Internal web UI. Next.js 16 (App Router), React 19, Tailwind CSS 4, TanStack Query, axios.
UI only: no API routes, no server actions. All data comes from the backend REST API.

## How requests reach the backend

The browser only calls `/api/v1/...` on this website. `next.config.ts` rewrites those
requests to `BACKEND_URL` (the Fastify backend), so the login cookie is same-site.
`src/lib/api.ts` is the only place axios is configured; it always sends
`X-Requested-With: XMLHttpRequest` (the backend's CSRF check).

## Local setup (Windows CMD)

Backend running first (`npm run dev:all` in `backend`), then in a second window:

```
cd C:\Users\Riyad\Desktop\riyadtech-outreach\frontend
copy .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build |
| `npm start` | Run the production build on port 3000 |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint (Next.js rules) |
| `npm test` | Vitest unit tests (no network) |
| `npm run check` | typecheck + lint + test |

## Pages

- `/login`: log in. Already logged in: goes straight to the dashboard (or `?next=`).
- `/dashboard`: sending windows today, system status (server, database, worker).
- Every page inside the app shows a warning when the worker's heartbeat is older than 90 s.

## Environment

| Variable | Where | Value |
| --- | --- | --- |
| `BACKEND_URL` | server side only | `http://127.0.0.1:4000` locally, `https://<service>.onrender.com` on Vercel |
| `NEXT_PUBLIC_API_URL` | browser | `/api/v1` (keep it relative) |

See `docs/decisions.md` for the decisions log.
