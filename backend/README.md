# Riyad Tech Outreach: backend

Internal API and (later) background worker for Riyad Tech's outreach tool.
Node.js 22, Fastify 5, TypeScript (strict), Prisma 7 + PostgreSQL (Neon), zod, pino, Vitest.

## Local setup (Windows CMD)

```
cd C:\Users\Riyad\Desktop\riyadtech-outreach\backend
copy .env.example .env
notepad .env          (paste the Neon dev-branch URLs)
npm install           (also runs `prisma generate`)
npm run db:migrate
npm run db:check
npm run seed:admin    (creates the admin; type the password when asked)
npm run dev
```

Then open http://127.0.0.1:4000/health

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the API with auto-reload (tsx) |
| `npm run dev:worker` | Start the worker with auto-reload (second CMD window) |
| `npm run dev:all` | Start API + worker together, like on Render (no auto-reload) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled API + worker (`dist/all.js`, Render start command) |
| `npm run start:server` / `start:worker` | Run only one compiled process |
| `npm run typecheck` | TypeScript check (src + tests) |
| `npm run lint` | ESLint |
| `npm test` | Vitest (no network, no real database) |
| `npm run check` | typecheck + lint + test |
| `npm run test:int` | Integration tests against `TEST_DATABASE_URL` (Neon dev branch) |
| `npm run db:generate` | Generate the Prisma client into `src/generated/prisma` |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`, uses `DIRECT_URL`) |
| `npm run db:status` | Show which migrations are applied |
| `npm run seed:admin` | Create the admin (`ADMIN_EMAIL`) or set a new password (logs out all sessions) |
| `npm run geonames:import -- [GB IE US AU] [--dir folder]` | Load GeoNames regions and cities (also a button on the Finder page) |
| `npm run finder -- --country GB --city Manchester [--dry-run] [--verbose]` | Run a finder job in the terminal, printing each step (and with --verbose each download) |
| `npm run db:check` | Check URLs, connection, migrations, tables, a test write, retry + lock |

## Processes

- `src/server.ts`: the API.
- `src/worker.ts`: background worker. Writes a heartbeat every 30 s (`worker_heartbeat`) and reloads settings from the database every 60 s, so changes need no restart. Later phases add the job loops.
- `src/all.ts`: starts both as child processes. If either exits, both stop and the process exits with code 1 so Render restarts the service.
- `GET /api/v1/system/status` (login required): worker state `ok` / `stale` (no heartbeat for 90 s) / `never`.

Note: a running worker keeps the Neon compute awake. Do not leave `dev:worker` / `dev:all` running all day locally (the free plan has a monthly compute limit shared by all branches).

## Lead finder (Phase 1)

1. **Areas**: GeoNames regions and cities (population over 5,000) in `locations`, loaded by a job.
2. **Plan** (`finder.plan` task): the latest Overture release from the STAC catalog
   (https://stac.overturemaps.org), the area box (city radius, or around the region's/country's
   GeoNames cities; optional: the real border from `divisions/division_area`, setting
   `finder.useOutlines`), then only the place files and Parquet row groups whose bounding
   boxes overlap the area. One `finder.import` task per few row groups.
3. **Import** (`finder.import`): reads only the needed columns over HTTP range requests and keeps a
   place when it is inside the area box and its address (if it has one) names the right
   country/state (or, with outlines on: inside the border, or the address names it),
   open, confidence >= 0.6, mapped to one of our categories (`seed/categories.json`) and has its own
   website (not a platform from `seed/platform-domains.json`). Dry runs only count. Real runs check
   the storage limit, stage rows in `stg_overture_places` and merge them into `places` in one
   statement: one row per website domain per segment; several Overture places of one domain count
   as locations.
4. US and Australia: per state or per city. UK: per city. Ireland: whole country allowed.

Seed files in `seed/` (reviewed, synced into the database when the server starts):
`countries.json`, `categories.json` (Overture taxonomy 2026-09-23), `platform-domains.json`, `offer.json`.

Data: Overture Maps Foundation (CDLA Permissive 2.0) and GeoNames (CC BY 4.0); attribution is on the Finder page.

Test fixtures in `test/fixtures/overture` imitate a real release (built by `make_fixtures.py`);
they use the fake release `1999-12-31.0`, `.invalid` domains and GeoNames ids from 990000000,
so integration tests on the dev database remove exactly what they create.

## Rules

- Secrets only in `.env` (local) or the hosting Environment page. `.env` is never committed.
- Real lead files and exports go in `data/` (git-ignored).
- Auth: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`. Session = httpOnly JWT cookie `rt_session`.
- Every `POST/PUT/PATCH/DELETE` under `/api/v1` needs the header `X-Requested-With: XMLHttpRequest` (CSRF).
- Every API error has the shape `{ "error": { "code", "message", "details" } }`.
- See `docs/decisions.md` for the decisions log.
