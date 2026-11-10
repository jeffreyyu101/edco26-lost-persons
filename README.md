# Is my friend in medical? — EDC Orlando 2026

A phone-first web app for Ground Control / Headliner Experience (GC/HX) staff at EDC Orlando, Nov 6–8 2026.
Front-of-house staff at FA 3 and FA 4 log a missing person and the friend looking for them. The medical
liaison at Main Med checks the charts and answers **In medical** or **Not found** (the request then reads "Not
found in medical"). When the answer is
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
| `INVITE_CODE_SHA256` | no | The team join link: hex SHA-256 of the code (`node scripts/make-invite.mjs`). Unset: password only. |
| `INVITE_EXPIRES_AT` | with the one above | ISO time the team join link stops working, e.g. `2026-11-09T12:00:00Z`. Unset: the link is off. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | for lock-screen alerts | Web Push (already set in production). All three switch it on; `VAPID_SUBJECT` is `mailto:` or `https:`. Missing or invalid: push is off, silently (no alerts banner, no pushes; Activity and in-app alerts still work). A new pair makes every device subscribe again on its next open. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | no | The same public key at build time. The app reads the key from the server anyway (`POST /api/push/prefs`). |

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
| `20261108000000_dashboard_v4.sql` | Dashboard v4: `lp_stats(p_range)` beside `lp_stats()` (live split, needs attention, speed, calls by 15 min and the night before, hour × tent, recap, who's on). Additive. | Paste it **alone** before deploying the v4 dashboard (the build falls back to `lp_stats()` without it). See [`HANDOFF.md`](HANDOFF.md). |
| `20261108120000_companion.sql` | Companion: `friend_in_medical*` and `swap_*` columns, statuses `Found – Accompanied` / `Closed – Friend Informed`, `lp_swap`, the new Activity kinds, and every status list (transitions, involved, stats, inactive close) updated. Additive. | Paste it **alone** (after dashboard v4) **before** deploying the companion build: `node scripts/companion-sql.mjs` writes `migration.sql` and `dry-run.sql`. |
| `20261108190000_companion_cancel.sql` | Companion follow-up: `lp_swap` action `cancel` (swap requested → cleared; swap approved → back to `Found – Accompanied`), Activity kind `swap_cancelled`. Additive, same signatures. | Paste it **alone** (after companion) **before** deploying the cancel build. |
| `20261109120000_companion_post_event.sql` | Companion fixes after the event: new nullable `patients.swap_closed` (+ CHECK, added only when missing) returned by `lp_row`; `lp_swap` (approve needs an open request, except an older app's Undo of its own Cancel swap; `restore`, the Undo of Cancel swap / Decline / Swap at …, keeps the original requester; withdraw tells the answerer; Undo / Reopen no longer count as "who answered"); `lp_set_status` (Reopen of an Accompanied request closed as inactive or discharged returns to Accompanied; Friend informed over an open swap request is a conflict; Undo of a change brings back the swap request it ended); `lp_stats()` / `lp_stats(text)` (a swap approval or Change answer out of Accompanied restarts the friend's clock). Additive, same signatures, no row rewritten, nothing dropped; safe to run twice. | Paste it **alone** (after the cancel file) **before** deploying this build. |

Without `20261106000000_rework.sql`, every API route fails, because each one calls an `lp_*` function. The
file is one transaction, is safe to run twice (also on a database that already has every `lp_*` function),
and starts with a dry-run note.

### End-of-event export

The app has no export. [`docs/export.sql`](docs/export.sql) holds three read-only queries for the Supabase SQL
editor: every request (one row each, by case number, times in New York), the whole audit trail, and every
message and en route event (unsent messages marked). Run each
one and use "Download CSV" on the results; the steps are at the top of the file. The files hold names and
phone numbers, so treat them as sensitive.

### Photos

Photos live in a **private** Storage bucket named `patient-photos` (JPEG, PNG or WebP). The app uploads a
full image of up to 1600 px and a 320 px thumbnail. Pages load them through `/api/photos/:id`, which checks
the session and redirects to a signed URL that lasts 120 s. Never make the bucket public.

Every photo is prepared **on the phone** before it is saved or sent (`lib/client/image.ts`): an optional
quick crop, an area-averaged downscale, and a conservative cleanup for photos of a phone screen (auto levels
and light sharpening, each only when the photo measures as needing it; `lib/client/image-enhance.ts`).
Re-encoding strips EXIF and GPS. The cleanup adds no request and no server work, and the upload is never
bigger than the app made it before the cleanup existed (design/DECISIONS.md v2.2 #10).

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
| `node scripts/with-e2e-lock.mjs --migrate -- <command>` | Runs integration or e2e tests while holding the shared local-stack lock, after re-applying this branch's rework migration twice (several branches share one local stack). |
| `npm run test:e2e` | Playwright on the production build: sign-in, lists, the two-phone flow (log → Pending → In medical → alert), system notifications on a desktop (hidden page notifies, visible page toasts), profile, edit and conflicts, dashboard, offline and lie-fi queueing, the service-worker update, the first-load JS budget, and accessibility (axe-core WCAG 2.1 A/AA in light and dark, plus 44 px tap targets). Run `npm run build:test` first. |
| `node scripts/smoke-csp.mjs` | The production CSP and nonce in Chromium and WebKit: `/signin` hydrates with no violations, `/` redirects without a session, and with one the list, a profile and Back work. Needs the production build running on `PORT`. `npm run test:e2e` runs it too (`tests/e2e/smoke.spec.ts`). |
| `npm run test:e2e:lanes` | The same Playwright suite in parallel lanes (default 3, about a third of the time); see Parallel e2e lanes below. |
| `npm run db:verify-migration` | Applies the rework migration twice to the local database (`SUPABASE_DB_URL` when set, else the stack `supabase status` reports) and to an upgrade fixture built from Jeffrey's original schema, then smoke-tests the functions. |
| `node scripts/load-test.mjs` | 30 simulated phones polling for 2 minutes against a running local production build (see the file header). |

End-to-end runs take a lock per stack (`LP_E2E_LOCK_DIR`, else `/tmp/lp-e2e.lock-<port of .env.test's Supabase URL>`;
`/tmp/lp-e2e.lock` on the shared stack), so two suites never share a local stack at once; a run that waits 2 minutes
fails naming the holder's pid and cwd. Every
spec signs in through `POST /api/session` once per identity and reuses that session (`storageState`).
Integration tests close the requests they create when each file ends, so nothing they leave shows in
Pending.

### Parallel e2e lanes

`npm run test:e2e:lanes` runs the same specs, in both browser projects, in three lanes at once; a full pass takes
roughly a third of the time of `npm run test:e2e`. Every lane has its own local Supabase stack and its own
production build and `next start` on its own port, and runs its share with one worker, as a single run does, so the
specs that assert on list contents and dashboard totals still see only their own lane's data. Nothing shared is
rewritten: each lane runs in a copy of the checkout (APFS clone, so seconds and no disk) whose `.env.test` names its
stack and port.

```bash
npm run test:e2e:lanes                              # 3 lanes, full suite
npm run test:e2e:lanes -- --lanes 2                 # 1 to 6 lanes
npm run test:e2e:lanes -- --files list.spec.ts,health.spec.ts
npm run test:e2e:lanes -- --plan                    # print the split and start nothing
npm run test:e2e:lanes -- -- --grep "dashboard"     # after a second `--`: passed to Playwright
```

It needs `~/.config/lp-stacks` (`claim.sh`, `make.sh`, `release.sh`) and at least three unclaimed stacks in
`~/.lp-stacks`. Each lane's stack is rebuilt from this checkout's migrations (`supabase db reset`), seeded as
`npm run db:reset` does, and has the `lp-close-inactive` job paused; the unused auth container is stopped. Before
starting it checks free memory (this Mac and the Docker VM) and disk and refuses, naming the shortfall, when there
is not enough. Plan on about 0.7 GB of Docker memory per lane.

- **Split:** whole spec files per project, never single tests, so each file keeps its own order. Lanes are balanced
  by seconds from `scripts/e2e-lane-timings.json` (spec file and project), which the runner refreshes after a run
  that ran every test; a file with no entry is weighed by its test count.
- **Result:** one summary with passed, failed and skipped over all lanes, the wall-clock and per-lane times, and each
  failure as `file:line`, project and lane. The set of tests that ran is compared with `playwright test --list`;
  a missing, duplicated or unexpected test fails the run. The exit code is non-zero on any failure. A failing lane
  does not stop the others.
- **Logs:** per-lane logs, server logs, Playwright's JSON and `results.json` are in a `lp-e2e-lanes-<time>` folder in
  the temp directory (printed at the start and the end); a failing lane's traces and screenshots are copied there.
- **Cleanup:** on exit, Ctrl-C or error, every server it started is stopped, every stack it claimed is released and
  stopped (`--keep-stacks` leaves them running), and the lane copies are deleted.
- **Trade-off:** a spec that depended on another spec file's leftovers would behave differently here, because lanes
  start from a fresh seed and run files in a different order. None is known; if one fails only in lanes, run it
  alone with `npm run test:e2e`.

## How it behaves

- **Sign-in.** Step 1 is your name and team, and step 2 is the event password. The phone remembers step 1.
  Sessions last 12 hours from the last use, and 36 hours at most. Too many wrong passwords from one place
  pauses sign-in for a while. A team join link (`/signin#join=<code>`, HANDOFF "Team join link") skips the
  password: step 1, then the app.
- **One page, several views.** All requests, Pending (Waiting for check, then Friend coming), My requests
  (with a progress line), Search, New request, the profile, Edit and the dashboard. Views are URL parameters
  on `/`, so Back and shared links work. The view menu is the large page title ("All requests 13 ⌄").
- **All requests.** Open requests (Waiting for check, In medical) come first, newest first; every closed one
  (Not found in medical, Reunited, Discharged, Cancelled) folds into one "Archived N" row. Each row shows the LP
  number, the name, the status, when it was logged ("11:02 PM", or "Thu 11:02 PM" for an earlier day) and
  when it last changed ("now", "2m", "1h", "3d", or "—").
- **Live.** The list syncs every 6 s while the app is open (60 s in the background). A line under the title
  says when it last synced, in minutes ("Updated just now", "Updated 5 min ago"), with a Refresh now button.
  Problems show as a banner, "Reconnecting…" (amber) or "Offline · N waiting to send" (gray), while the line
  shows the last good time ("Last updated 3:42 PM").
- **Brand row.** All requests opens with one compact row (logos, "Is my friend in medical?", the dates). Its X
  hides it on that device; "Show header" in the avatar menu brings it back.
- **Desk and tablet (from 768 px).** A sidebar (or an icon rail under 1280 px), a top bar with the view's
  title, its live line and Refresh now, search and New request, and the list as a table; a request opens
  beside it (docked from 1024 px) and New request as a side sheet or a centred dialog. Pending is two
  columns, Waiting for check and Friend coming, each scrolling on its own. All requests opens with the same
  compact brand row, its X and Show header.
- **Pending** (Pending v9.1) is one page on a phone: Waiting for check (longest wait first), then Friend coming
  (friend arrived, then en route, then nobody yet), each under a header that folds it; side by side from 768 px.
- **Not found yet.** The first Not found ("⧗ Not found yet") on a waiting request holds it for a recheck in 20
  minutes: still open, Waiting for check in the database, in its place in Pending with a violet "Not found yet"
  chip, which turns into "Recheck due" after 20 minutes. Nothing moves and it never closes by itself. On a held
  request the button reads "× Not found": the final answer, which closes it as Not found in medical. Lists show
  each request's stage: Needs info, Not found yet, Recheck due, Friend en route and Friend arrived refine the
  stored status (`design/DECISIONS.md`, spec §19).
- **Closed · inactive** (F6). A request In medical with no activity (no answer, edit, location, photo, message or en
  route) for an hour is closed by the database every 5 minutes (pg_cron job `lp-close-inactive`), grey with a timer
  glyph, in Archived; anyone can Reopen it to Friend coming. Waiting for check never closes by itself. Local test
  stacks keep the job paused (`scripts/test-env.mjs` `pauseInactiveJob`); tests run `lp_close_inactive()` themselves.
- **Sort by status.** All requests and My requests have a one-tap "⇅ Newest" / "⇅ Updated" ↔ "⇅ Status" toggle
  at the right end of the line under the title (the column header on the desk table), remembered on the
  device: Waiting for check, Friend coming, then the closed ones folded.
- **Answers.** Not found, In medical, Reunited and Change answer each offer Undo for 10 s. Change answer
  is a menu: the other answer, or Back to Waiting for check. Two people giving the same answer is harmless.
  A change made by someone else shows as "Updated by someone else".
- **Messages** (2026-11-06 evening). Every request has its own thread, at every status: iMessage-style
  bubbles, "Delivered" / "Read 4:14 PM" under your latest message, quick lines for the status and your side
  (medical or front of house), Copy and Unsend (15 minutes). My requests and Pending cards show the last
  message and an unread count. A message written offline is saved on the phone and sent once the signal is
  back. Front of house can say **Friend en route** (optional ETA) and **Arrived**; one teal row shows it, with
  no names. Any status change out of In medical clears it (an Undo within 30 s puts it back). An En route
  tap that could not be sent shows "Not delivered · Retry" under the row.
- **Request page order** (2026-11-07). A request reads status, details, photos, then Messages, then the audit
  trail. While it needs info or has unread messages, one line under the status shows the latest message; it, a
  Message button, a desk row's unread badge, a message's Activity row, toast or notification open the request at
  its thread (the composer focused on a computer only). See `design/DECISIONS.md` "Request page order".
- **Alerts.** With the app in front, an alert is a toast with a chime: changes to your requests by someone
  else, and new requests when "New requests" is on. **Lock-screen alerts (Web Push, F4)** reach a locked
  phone or a closed laptop app once "Turn on" was tapped on that device (desktop browsers, Android Chrome,
  the iPhone / iPad Home Screen app): answers, location changes and other updates on requests you logged or
  answered, and new requests with "New requests" on. A notification shows the request's initials and one
  line ("In medical · Chair 9"), never a name, LP number or contact details, and opens the request. A banner
  on All, Pending and My requests shows what this device still needs (Turn on, the Home Screen taps, or the
  settings path when blocked). Avatar menu → Alerts opens the Alerts sheet: this device's state, "Send a test
  alert", and the "New requests" and "Updates on my requests" switches (saved on the server for every device
  of yours). One alert is never both a toast and a notification. Without push on a device, a page in the
  background still shows a system notification where allowed ("Allow notifications"), as before, now
  without the LP number ("S.L. · In medical" / "FA 3").
- **Activity.** The bell next to search (and in the desk top bar and sidebar) counts requests with something
  new for you. One row per request, newest first; opening the request (from anywhere) marks it read; Mark all
  read has Undo. The app icon badge shows the same count.
- **Photos.** After a photo is taken or picked, a crop step shows it with the whole photo selected: **Use
  photo** keeps it as it is, dragging a corner cuts away a phone's bezel, **Retake** opens the camera again.
  Photos of a phone screen are cleaned up on the phone (levels, light sharpening) before upload.
- **Offline.** A new request (with its photos) is saved on the phone first and sent when the signal is back.
  Answers, edits and adding photos to an existing request need a connection.
- **Dashboard.** Status count tiles first, then Open by post, Recently updated, and Performance last (longest
  wait, average time to answer and to reunite over the last 2 hours, and requests logged in the last hour).
  Tiles open the list filtered by status; a post bar opens that post's open requests (the rows it counts),
  and clearing the Open chip shows every request at the post.
- **Export.** None in the app: see [End-of-event export](#end-of-event-export).
