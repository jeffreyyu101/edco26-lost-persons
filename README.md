# Is my friend in medical? — EDC Orlando 2026

A phone-first web app for Ground Control / Headliner Experience (GC/HX) staff at EDC Orlando, Nov 6–8 2026.
Front-of-house staff at FA 3 and FA 4 log a missing person and the friend looking for them. The medical
liaison at Main Med checks the charts and answers **In medical** or **Not in medical**. When the answer is
In medical, the friend is walked to Main Med, and medical taps **Reunited**.

The app stores identifying and contact details only. Never enter medical records, diagnoses, medications or
clinical notes. It is not represented as HIPAA compliant. Use synthetic data for every test.

- The engineering contract is [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md).
- Product decisions are in [`design/DECISIONS.md`](design/DECISIONS.md), and the visual spec is in [`design/screens/`](design/screens/).
- Deploying, the production migration and the morning checklist are in [`HANDOFF.md`](HANDOFF.md).

## Stack

- Next.js 16.4 (App Router, `proxy.ts`) and React 19.3, in strict TypeScript.
- Radix Themes 3.3, lucide icons, and Inter (self-hosted).
- Supabase (Postgres and a private Storage bucket), reached **only from the server** with the secret key.
  Every write is a `lp_*` SQL function, so each change and its audit row commit together.
- Tests use vitest (unit and integration) and Playwright (Chromium with the iPhone 14 profile, and WebKit).

Node 22.12 or newer is required.

## Environment variables

Copy [`.env.example`](.env.example) to `.env.local` for a manual run against a real project, and set the same
names in Vercel. They are validated when the server first uses them, and a missing one fails with a clear
message.

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | The project URL. Used by the server only (the name is kept from the existing Vercel env). A trailing `/rest/v1/` is stripped. |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only. Never give it a `NEXT_PUBLIC_` prefix. |
| `SESSION_SECRET` | yes | 32 characters or more. Changing it signs everyone out. |
| `APP_SHARED_PASSWORD_HASH_B64` or `APP_SHARED_PASSWORD` | one of them | The event password, as a base64 bcrypt hash or as plain text. If both are set, the hash wins. |
| `EVENT_TIMEZONE` | no | Defaults to `America/New_York`. Every displayed time uses it. |

To make a password hash without writing the password into a file:

```bash
node -e "const b=require('bcryptjs'); console.log(Buffer.from(b.hashSync(process.argv[1], 12)).toString('base64'))" 'THE-EVENT-PASSWORD'
```

Never commit `.env.local` or any other `.env*` file. The only exceptions are `.env.example` (placeholders)
and `.env.test`, which holds local-only values that work against `127.0.0.1` and nothing else.

## Database

### Migration chain

`supabase/migrations/` holds the local chain. The Supabase CLI applies it in this order:

| File | What it is | Production |
|---|---|---|
| `20261101000000_baseline_local_only.sql` | A copy of `supabase/schema.sql`, the production baseline. | **Never paste.** Already applied. |
| `20261105000001_add_last_seen.sql` | Jeffrey's `last_seen` column. | Already applied (verified 2026-11-05). |
| `20261105000002_update_locations_and_statuses.sql` | Jeffrey's location and status CHECK update. | Not needed: the rework covers it whether or not it ran. |
| `20261106000000_rework.sql` | Row versions, the touch trigger, thumbnails, login limits, free-text `age` (text since 2026-11-06), the "Not found yet" hold (`recheck_at`, `not_found_checks`) and every `lp_*` function the app calls. | **The one file production needs.** Applied 2026-11-06; apply it again (the v2.5 `lp_stats` change and `age` → text) **before** deploying this build. See [`HANDOFF.md`](HANDOFF.md). |

Without `20261106000000_rework.sql`, every API route fails, because each one calls an `lp_*` function. The
file is one transaction, is safe to run twice (also on a database that already has every `lp_*` function),
and starts with a dry-run note.

### End-of-event export

The app has no export. [`docs/export.sql`](docs/export.sql) holds two read-only queries for the Supabase SQL
editor: every request (one row each, by case number, times in New York) and the whole audit trail. Run each
one and use "Download CSV" on the results; the steps are at the top of the file. The files hold names and
phone numbers, so treat them as sensitive.

### Photos

Photos live in a **private** Storage bucket named `patient-photos` (JPEG, PNG or WebP). The app uploads a
full image of up to 1600 px and a 320 px thumbnail. Pages load them through `/api/photos/:id`, which checks
the session and redirects to a signed URL that lasts 120 s. Never make the bucket public.

## Run it locally

```bash
npm ci
npx playwright install chromium webkit   # once, for the end-to-end tests
supabase start                           # the local stack (project lp-local, Postgres 17)
npm run db:reset                         # migrations + synthetic seed + seed photos (local only)
npm run build:test                       # production build with .env.test
npm run start:test                       # http://127.0.0.1:3100
```

`.env.test` points at the local stack. Every script and test helper refuses to run unless the Supabase URL is
`127.0.0.1` or `localhost`, and none of them read `.env.local`. `npm run dev` also serves on port 3100
(`PORT` changes it), but it needs a `.env.local`.

## Checks

| Command | What it runs |
|---|---|
| `npm run typecheck` | `next typegen`, then `tsc --noEmit` |
| `npm run lint` | ESLint, with no warnings allowed |
| `npm test` | Unit tests (vitest, no network or database) |
| `npm run test:int` | Integration tests: every route, the SQL functions, concurrency, login limits, the migration and `docs/export.sql` (run read-only), against the local stack through a production build on `PORT` (default 3100). If nothing listens there, the harness starts `next start` itself. Run `npm run build:test` first. |
| `npm run test:e2e` | Playwright on the production build: sign-in, lists, the two-phone flow (log → Pending → In medical → alert), system notifications on a desktop (hidden page notifies, visible page toasts), profile, edit and conflicts, dashboard, offline and lie-fi queueing, the service-worker update, the first-load JS budget, and accessibility (axe-core WCAG 2.1 A/AA in light and dark, plus 44 px tap targets). Run `npm run build:test` first. |
| `node scripts/smoke-csp.mjs` | The production CSP and nonce in Chromium and WebKit: `/signin` hydrates with no violations, `/` redirects without a session, and with one the list, a profile and Back work. Needs the production build running on `PORT`. `npm run test:e2e` runs it too (`tests/e2e/smoke.spec.ts`). |
| `npm run db:verify-migration` | Applies the rework migration twice to the local database and to an upgrade fixture built from Jeffrey's original schema, then smoke-tests the functions. |
| `node scripts/load-test.mjs` | 30 simulated phones polling for 2 minutes against a running local production build (see the file header). |

End-to-end runs take a lock (`/tmp/lp-e2e.lock`), so two suites never share the local stack at once. Every
spec signs in through `POST /api/session` once per identity and reuses that session (`storageState`).
Integration tests close the requests they create when each file ends, so nothing they leave shows in
Pending.

## How it behaves

- **Sign-in.** Step 1 is your name and team, and step 2 is the event password. The phone remembers step 1.
  Sessions last 12 hours from the last use, and 36 hours at most. Too many wrong passwords from one place
  pauses sign-in for a while.
- **One page, several views.** All requests, Pending (Friend coming, then Waiting for check), My requests
  (with a progress line), Search, New request, the profile, Edit and the dashboard. Views are URL parameters
  on `/`, so Back and shared links work. The view menu is the large page title ("All requests 13 ⌄").
- **All requests.** Open requests (Waiting for check, In medical) come first, newest first; every closed one
  (Not in medical, Reunited, Discharged, Cancelled) folds into one "Archived N" row. Each row shows the LP
  number, the name, the status, when it was logged ("11:02 PM", or "Thu 11:02 PM" for an earlier day) and
  when it last changed ("now", "2m", "1h", "3d", or "—").
- **Live.** The list syncs every 6 s while the app is open (60 s in the background). A dot by the title shows
  only while the app is offline or reconnecting. Offline and "can't reach the log" show as banners.
- **Not found yet.** The first Not found on a waiting request holds it for a recheck in 20 minutes (still open,
  Waiting for check in the database, violet "Not found yet" on screen, under Pending's "Later"); when the time
  comes it is back on top of To check as a Recheck, and it never closes by itself. The second Not found is the
  final, closed Not in medical. Lists show each request's stage: Needs info, Not found yet, Friend en route and
  Friend arrived refine the stored status (`design/DECISIONS.md`, spec §18).
- **Answers.** Not in medical, In medical, Reunited and Change answer each offer Undo for 10 s. Change answer
  is a menu: the other answer, or Back to Waiting for check. Two people giving the same answer is harmless.
  A change made by someone else shows as "Updated by someone else".
- **Alerts** appear only while the app is open: changes to your requests by someone else, and new requests
  when alerts are on (the bell, in the avatar menu). With the app in front, an alert is a toast with a
  chime. In the background (another tab, a minimised window) it is a system notification instead, where the
  device allows one and it was allowed (desktop Chrome, Edge, Firefox and Safari, Android Chrome, the iPhone
  Home Screen app; "Allow notifications" in the avatar menu). It shows the LP number, the status, initials
  and the post, never contact details, and a click opens the request. One alert is never both a toast and a
  notification, even with the app in two windows. A Safari tab on iPhone keeps the toast only. There is no
  push: a closed app gets nothing.
- **Offline.** A new request (with its photos) is saved on the phone first and sent when the signal is back.
  Answers, edits and adding photos to an existing request need a connection.
- **Dashboard.** Status count tiles first, then Open by post, Recently updated, and Performance last (longest
  wait, average time to answer and to reunite over the last 2 hours, and requests logged in the last hour).
  Tiles open the list filtered by status; a post bar opens that post's open requests (the rows it counts),
  and clearing the Open chip shows every request at the post.
- **Export.** None in the app: see [End-of-event export](#end-of-event-export).
