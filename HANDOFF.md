# Handoff: "Is my friend in medical?" rebuild

Updated: 2026-11-06 (morning, v2.5). **Production is live at https://edco26-lost-persons.vercel.app**, deployed
on 2026-11-06 from `main`.

[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) is the engineering contract (§17 holds the 2026-11-06 morning
amendments), and [`design/DECISIONS.md`](design/DECISIONS.md) holds the product decisions. Setup and checks are
in [`README.md`](README.md). Never paste secrets or real people's details into prompts, issues, commits or
screenshots.

## What changed

- **The whole UI is rebuilt from the approved mockups** (Radix Themes, light and dark). It has All /
  Pending / My requests views, a two-answer check (In medical, Not in medical), Reunited, Undo, search, a
  dashboard and the avatar menu.
- **Every write is one SQL function** (`lp_*`). The change and its audit row commit together, and
  `row_version` catches conflicting edits. The three-photo limit holds under concurrent uploads, and a
  repeated create (a retry) never makes a second row.
- **Live sync every 6 s with a database cursor**, replacing the 15 s refresh and manual refresh. Status
  changes save on tap (with Undo) instead of as a draft when the profile closes.
- **Offline-safe new requests.** Each one is saved on the phone (IndexedDB) before it is sent, with its
  photos, and is retried until the server has it. A service worker keeps the app opening with no signal.
- **Security.** A per-request CSP nonce, same-origin checks on every write, a signed HttpOnly session cookie,
  sign-in rate limits per name and per IP, a private photo bucket with 120 s signed URLs, and no PII in logs.
- **Jeffrey's old routes are gone** (`/api/login`, `/api/logout`, `/api/patients/**`). Every working feature
  was kept or moved (spec §12).

### 2026-11-06 morning (v2.5, Brian + Jeffrey)

- **Not in medical is closed** and grey everywhere. Only Waiting for check (blue) and In medical · friend
  coming (green) are open.
- **All requests is log option B:** open requests first, every closed one folded into one "Closed N" row. The
  LP number ("1013") is the leftmost column; each row shows its created time ("11:02 PM", or "Thu 11:02 PM"
  for an earlier day) and when it last changed ("now", "2m", "1h", "3d", or "—").
- **The dashboard is Jeffrey's global view:** status tiles, Open by post, Recently updated, then Performance
  (longest wait, time to answer, time to reunite, logged in the last hour).
- **The app no longer exports a CSV** (the button and its API route are gone). At the end of the event
  Jeffrey runs [`docs/export.sql`](docs/export.sql) in the Supabase SQL editor and downloads the results.
- **Header:** the view switcher is the large page title, the bell moved into the avatar menu, the live dot
  shows only when offline or reconnecting, and "Newest first" is gone.

## The production migration

[`supabase/migrations/20261106000000_rework.sql`](supabase/migrations/20261106000000_rework.sql) is the only
file production needs. The other files in that folder are the local chain: the baseline and both
2026-11-05 files are already in production, or are covered by the rework file.

- **Applied to production on 2026-11-06** through the Supabase Management API, with a dry run (ending in
  `rollback;`) first, then the commit run.
- **It must be applied again after this merge**, because v2.5 changed `lp_stats` (it now also returns
  `avgReuniteMinutes` and `loggedLastHour`). The integrator does this, with the same dry run, then commit.
  Apply it **before** deploying the new build: the new dashboard reads both fields, and two extra fields
  change nothing for the build that is live now, so that order is safe. The file is one transaction, keeps
  its preflight, and is safe on a database that already has every `lp_*` function (`lp_stats` is
  `create or replace`).

By hand, in the Supabase dashboard:

1. Supabase dashboard → SQL Editor, as the default `postgres` role.
2. **Dry run.** Paste the whole file. Change the last line from `commit;` to `rollback;`, then run it. It must
   finish without an error. Read the `NOTICE` lines: they report any constraint it widened and any legacy
   values it kept allowed. Nothing is saved.
3. **Commit.** Paste the file again, unchanged (ending in `commit;`), and run it. It is one transaction, so a
   failure leaves the database as it was, and running it a second time is harmless.
4. **Check.** `select proname from pg_proc where proname like 'lp\_%' order by 1;` lists the `lp_*`
   functions (among them `lp_sync`, `lp_create_request`, `lp_set_status` and `lp_stats`), and
   `select lp_stats() ? 'avgReuniteMinutes', lp_stats() ? 'loggedLastHour';` returns `true | true`.
5. **Storage.** Confirm the `patient-photos` bucket is still **private**.

If the preflight stops it ("Preflight failed: …"), the SQL editor is pointed at the wrong project or the
schema differs from `supabase/schema.sql`. Stop and send Brian the message. Don't edit the file.

## Deploying on Vercel

- **Environment variables.** Keep the names Jeffrey's project already has. `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) stay the same. Set `SESSION_SECRET` (32 characters
  or more) and keep `APP_SHARED_PASSWORD_HASH_B64`. `EVENT_TIMEZONE` defaults to `America/New_York`. All
  of them are listed in `.env.example`.
- **Region.** Pin Functions to the region closest to the Supabase project (Project Settings → Functions →
  Function Region). The Vercel project is on `iad1` (Washington, D.C.) and the Supabase project is in
  `us-east-2` (Ohio), so **`cle1` (Cleveland) is closer**. Almost every request reads or writes the database,
  so the distance is added to every tap and poll.
- **Fluid compute.** Turn it on (Project Settings → Functions). Polls are short and mostly wait on Postgres,
  so sharing instances keeps cold starts and cost down.
- **Invocation budget.** About 30 phones polling every 6 s comes to about 5 requests a second, and about
  6 at peak with answers and new requests. That is roughly 22,000 invocations an hour, or about 300,000
  for a 14-hour event day (background tabs poll only once a minute). Confirm the plan covers about 1
  million for the three days.
- **Request size.** Photo uploads stay under 3.9 MB, because Vercel caps request bodies at 4.5 MB.
- **Redeploys during the event** are safe. Open phones show "Update ready · Reload", and a reload never
  happens while a new request is unsent.

## Morning checklist (things tests can't cover)

- [ ] iPhone camera capture from New request, and the page survives coming back from the camera.
- [ ] Keychain fills the password on sign-in step 2.
- [ ] A Home Screen app signs in on its own and keeps its own saved requests, separate from the Safari tab.
- [ ] With the mute switch on, an alert still shows its toast (silently).
- [ ] At the end, run `docs/export.sql` in the SQL editor and download the results (Query 1, then Query 2;
      the steps are at the top of the file).
- [ ] Redeploy on Vercel with an old tab open: "Update ready · Reload" appears. It shows only once the phone
  has cached the whole new build, which needs `/sw-manifest.json` on the deploy (written by `next build`).
- [ ] Airplane mode in the middle of a send: it says "Saved on this phone" and sends once the signal is back,
      exactly once.
- [ ] Lie-fi (one bar): a new request queues after about 10 s and sends later.
- [ ] The re-run of the migration after this merge: dry run, then commit (see above).
- [ ] Several staff sign in at once behind the venue Wi-Fi (one shared IP).

## Known limits

- **Answers, edits and adding photos to an existing request need a connection.** Only new requests (with
  their photos) queue offline. Those buttons show "Needs a connection" offline.
- **Alerts show only while the app is open.** There are no push or lock-screen notifications. The chime is
  silent under the mute switch.
- **Identity is self-declared.** Everyone shares one event password, and the name and team are only for
  attribution. Cancelling a request, and reopening a cancelled one, are limited to the staff member who
  logged it, matched by name and team.
- **Sign-in limits:** 10 wrong passwords per name and IP, and 100 per IP, in 15 minutes. A whole team behind
  one venue IP shares the 100.
- **A Home Screen app and the Safari tab are separate.** Each has its own sign-in, saved requests and queue.
- **There is no export in the app.** The end-of-event files come from `docs/export.sql`. They hold names and
  phone numbers: don't leave them on shared devices.
- **Up to three photos per request.** Photos from Jeffrey's app with no timing show "Timing unknown".
- **Legacy rows.** Rows with an old post (for example `FA 3`) or an old status stay readable and editable,
  and appear as their own bar on the dashboard. On the dashboard, an Other location shows as "Other · Gate 9",
  so it never reads like a fixed post.
- **Accessibility versus the mockups.** For WCAG AA contrast (4.5:1) in both themes, some details differ from
  the mockup CSS: secondary text uses gray-11 instead of gray-10; the solid In medical and red confirm
  buttons use step 11 of their colour (white text in light mode, dark text in dark mode); closed rows dim
  their text to gray-11 and fade the icon instead of fading the whole row; and amber and red badges and
  banners use step-12 text. Every control has a tap target of at least 44 px, so the header icons sit
  slightly further apart and the Last seen place chips have more space between rows. Brian should confirm
  these with the mockups. `tests/e2e/a11y.spec.ts` keeps them passing.
