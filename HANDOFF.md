# Handoff: "Is my friend in medical?" rebuild

Updated: 2026-11-06 (morning, v2.5). **Production is live at https://edco26-lost-persons.vercel.app**, deployed
on 2026-11-06 from `main`.

[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) is the engineering contract (§17 holds the 2026-11-06 morning
amendments), and [`design/DECISIONS.md`](design/DECISIONS.md) holds the product decisions. Setup and checks are
in [`README.md`](README.md). Never paste secrets or real people's details into prompts, issues, commits or
screenshots.

## What changed

- **The whole UI is rebuilt from the approved mockups** (Radix Themes, light and dark). It has All /
  Pending / My requests views, a two-answer check (In medical, Not found), Reunited, Undo, search, a
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

- **Not in medical (now "Not found in medical") is closed** and grey everywhere. Only Waiting for check (blue) and In medical · friend
  coming (green) are open.
- **All requests is log option B:** open requests first, every closed one folded into one "Closed N" row. The
  LP number ("1013") is the leftmost column; each row shows its created time ("11:02 PM", or "Thu 11:02 PM"
  for an earlier day) and when it last changed ("now", "2m", "1h", "3d", or "—").
- **The dashboard is Jeffrey's global view:** status tiles, Open by post, Recently updated, then Performance
  (longest wait, time to answer, time to reunite, logged in the last hour).
- **The app no longer exports a CSV** (the button and its API route are gone). At the end of the event
  Jeffrey runs [`docs/export.sql`](docs/export.sql) in the Supabase SQL editor and downloads the results.
- **Header:** the view switcher is the large page title, the bell moved into the avatar menu, the live dot
  shows only when offline or reconnecting, and "Newest first" is gone. (Superseded in the afternoon: see below.)
- **New request is fully open** in Jeffrey's order (post, missing person, more details, then friend or family
  last and optional). **Age and gender are free text** ("mid-20s", "Non-binary"; Male / Female / Other are
  quick-fill chips), and search matches the age text. This needs the migration re-run below.
- **Alerts depend on the device** (Brian; `design/DECISIONS.md` v2.2 row 10, spec §17 A52). With the app in
  the background (another tab, a minimised window), an alert is a system notification instead of the toast
  and chime, on desktop Chrome, Edge, Firefox and Safari, Android Chrome and the iPhone Home Screen app. The
  browser asks only when someone turns Alerts on or taps "Allow notifications" in the avatar menu; refused
  shows "Blocked in browser". A notification shows the LP number, the status, initials and the post (no
  phone numbers), and a click opens the request. No server change: no push, no keys to set on Vercel.

### 2026-11-06 afternoon (v2.2 afternoon, Brian)

- **The brand card is one compact row on All requests only**, with an X that hides it on that phone ("Show
  header" in the avatar menu brings it back).
- **A live line under the title** on All requests, Pending, My requests and the dashboard. The dashboard's
  Offline / Retrying chip is gone.
- **F1.2 (the Apple Mail model):** the line counts minutes, never seconds ("Updated just now", "Updated 5 min
  ago"), and has a Refresh now button. Problems are a banner, "Reconnecting…" (amber) or "Offline · N waiting
  to send" (gray), and the line then shows "Last updated 3:42 PM". One state drives the line, the banner, the
  avatar badge and the screen-reader announcements (design/DECISIONS.md items 15–17).
- Client only: no migration, no new environment variable.

### 2026-11-06 afternoon (v2.2 #10, Jeffrey's photo request)

- **Photos of a phone screen are cleaned up on the phone** before they are saved or sent: an area-averaged
  downscale, then auto levels and a light unsharp mask, each only when the photo measures as needing it. A
  sharp, well-exposed camera photo is left as it was. No extra request, no server or Supabase work, and the
  upload is never bigger than before (`lib/client/image.ts`, `lib/client/image-enhance.ts`).
- **A quick crop step** follows every photo taken or picked, on New request and on a profile's Add photo.
  One tap on **Use photo** keeps the whole photo; dragging a corner cuts away the bezel; **Retake** opens the
  camera again (`components/photo/CropSheet.tsx`).
- No migration and no environment change: this is client-only.

### 2026-11-06 evening (F2 release, `release/f2`)

- **Desk and tablet layout from 768 px** (wave 2): a sidebar or icon rail, a top bar (title, live line,
  search, New request), the list as a table, a request docked beside it from 1024 px, New request as a side
  sheet or a centred dialog. Phones under 768 px are unchanged.
- **Pending v8 and where medical has them** (Dani's request): Pending is To check | Friend coming (two
  columns on the desk); after In medical a sheet asks for the bed or chair (optional, free text, at most 60
  characters), kept until someone edits it; the answer's 10 s Undo waits while that sheet is open. **This
  needs the migration below, before the deploy.**
- **The brand row on the desk** is the phone's compact row with the same X and "Show header", and the
  **live line** ("Updated just now", Refresh now) sits in the desk's top bar next to the title.
- **"Not in medical" now reads "Not found in medical"**, and its answer button reads **"Not found"**
  (Brian, 18:00). The database value is unchanged (`Checked – Not Found`), and so is what it does. The
  end-of-event export's status label follows (`docs/export.sql`).
- **Photos:** Retake on a later photo of a multi-photo pick no longer loses the photos already kept, and a
  double tap or a held key in the crop step answers one photo, never the next.
- **System notifications** (above) ship in this release too.

### 2026-11-06 night (F5 release, `release/f5`)

- **Stages and the "Not found yet" hold** (F5): a request shows its stage (Needs info, Not found yet, Recheck
  due, Friend en route, Friend arrived) over its stored status. The first Not found ("⧗ Not found yet") keeps
  it open for a recheck in 20 minutes; on a held request the button reads "× Not found" and closes it. **This
  needs the migration below re-applied, before the deploy.**
- **Pending v9.1**: one page on a phone (Waiting for check, then Friend coming, each header folds its
  section), two columns that scroll on their own from 768 px; no To check | Friend coming tabs, no Later lane.
- **Sort by status** on All requests and My requests ("⇅ Newest" / "⇅ Updated" ↔ "⇅ Status" at the right end
  of the line under the title; the column header on the desk table).
- **Dashboard Performance**: "last 2 hours" / "last hour" on each row, and "None" for an empty value ("—" only
  while the dashboard can't reach the server).
- **Jeffrey's test-data banner is gone.** It drew nothing after 12:30 PM on Nov 6, and the first load had to stay
  within its 230 KB budget (`docs/BUILD_SPEC.md` A71).

### 2026-11-07 (team join link, `release/join-link`, ships after F5)

- **A team join link signs staff in with step 1 only** (Brian, 2026-11-06 23:55): `https://<host>/signin#join=<code>`
  → name and team → Continue → the app, no password screen. The code is its own secret, not the event
  password, and the password keeps working. No database change. See [Team join link](#team-join-link) for
  the variables, and how to make, rotate and switch off a code.

## The production migration

[`supabase/migrations/20261106000000_rework.sql`](supabase/migrations/20261106000000_rework.sql) is the only
file production needs. The other files in that folder are the local chain: the baseline and both
2026-11-05 files are already in production, or are covered by the rework file.

- **Applied to production on 2026-11-06** through the Supabase Management API, with a dry run (ending in
  `rollback;`) first, then the commit run.
- **It must be re-applied on production before the F2 build deploys** (release `release/f2`). New
  against what production has (the F1 / F1.1 file, already applied):
  - **step 1c:** `alter table public.patients add column if not exists medical_location text;` (nullable,
    no default: no table rewrite, nothing else changes);
  - **recreated functions:** `lp_row` (also returns `medical_location`), `lp_clean_fields` (takes
    `medical_location`, trimmed, at most 60 characters), `lp_create_request` (refuses `medical_location`
    on a new request) and `lp_update_fields` (stores it, audited like any edit). Every other step and
    function is re-run unchanged.

  The integrator does this, with the same dry run, then commit. **Order: migration first, then deploy.**
  F2's location save needs the new functions. The build that is live now (F1.1) keeps working on the
  migrated database: it never sends `medical_location`, and its server maps `lp_row` through an allowlist,
  so the extra key is ignored; phones with cached rows or queued requests are unaffected (a queued create
  never carries the field). The file is one transaction, keeps its preflight, and is safe to re-run: a
  second paste keeps every saved location (`add column if not exists`), `lp_stats` is `create or replace`,
  and step 1b prints `patients.age: already text, unchanged.`

  (Release `release/f1` needed the same file for `lp_stats`' `avgReuniteMinutes` / `loggedLastHour` and the
  free-text `age`; that run is done.)

- **The "Not found yet" hold (F5, `feat/stages`) needs the file applied again too, before that build
  deploys.** It adds two columns (`patients.recheck_at`, nullable, and `patients.not_found_checks`, smallint
  default 0, both `add column if not exists`: no table rewrite), the function `lp_stages_recheck_minutes()`,
  and recreates `lp_row` (two extra keys), `lp_set_status` (a first Not found keeps the request Waiting for
  check, on hold for 20 minutes) and `lp_stats` (a hold counts as Waiting). **The build that is live now keeps
  working on it**: its server calls `lp_set_status` exactly as before and maps `lp_row` through its
  allowlist, so its first Not found comes back Waiting for check and stays in its queue (a second Not found
  closes it, as on the new build), and its Undo clears the hold. Check after the commit:
  `select lp_stages_recheck_minutes();` returns `20`, and
  `select column_name from information_schema.columns where table_name = 'patients' and column_name in ('recheck_at', 'not_found_checks');`
  returns both. A second paste keeps every hold.
- **Messages and en route (section 7, 2026-11-06 evening)** need it again before that build deploys. It is
  additive: three new tables (`lp_messages`, `lp_message_reads`, `lp_enroute`, RLS on, `service_role`
  only), a partial index on `audit_events`, the trigger `lp_enroute_clear` on `patients` (a status change out
  of In medical deletes that request's en route rows in the same transaction, keeping them in its audit row so
  that going back to In medical within 30 s, e.g. an Undo of Reunited, restores them), and new functions
  (`lp_post_message`, `lp_mark_read`, `lp_set_enroute`, `lp_unsend_message`, `lp_involved_staff`,
  `lp_messages_thread`, `lp_messages_sync`, `lp_enroute_stats` and three helpers). No existing column,
  constraint or function changes. The build that is live now keeps working on it: it never calls the new
  functions, and the trigger only deletes rows only the new build writes. Migration first, then deploy (the
  new build's sync, detail and message routes call the new functions; if they are missing, sync and the
  detail still answer, without messages). A second paste keeps every message, read cursor and en route.
  Check: `select count(*) from pg_proc where proname in ('lp_post_message', 'lp_mark_read', 'lp_set_enroute',
  'lp_unsend_message', 'lp_involved_staff', 'lp_messages_thread', 'lp_messages_sync', 'lp_enroute_stats');`
  returns `8`.

By hand, in the Supabase dashboard:

1. Supabase dashboard → SQL Editor, as the default `postgres` role.
2. **Dry run.** Paste the whole file. Change the last line from `commit;` to `rollback;`, then run it. It must
   finish without an error. Read the `NOTICE` lines: they report any constraint it widened and any legacy
   values it kept allowed. Nothing is saved.
3. **Commit.** Paste the file again, unchanged (ending in `commit;`), and run it. It is one transaction, so a
   failure leaves the database as it was, and running it a second time is harmless.
4. **Check.** `select proname from pg_proc where proname like 'lp\_%' order by 1;` lists the `lp_*`
   functions (among them `lp_sync`, `lp_create_request`, `lp_set_status` and `lp_stats`), and
   `select lp_stats() ? 'avgReuniteMinutes', lp_stats() ? 'loggedLastHour';` returns `true | true`, and
   `select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.patients'::regclass and attname = 'age';`
   returns `text`. For F2,
   `select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.patients'::regclass and attname = 'medical_location';`
   returns `text`, and `select public.lp_row(p) ? 'medical_location' from public.patients p limit 1;` returns
   `true`.
5. **Storage.** Confirm the `patient-photos` bucket is still **private**.

If the preflight stops it ("Preflight failed: …"), the SQL editor is pointed at the wrong project or the
schema differs from `supabase/schema.sql`. Stop and send Brian the message. Don't edit the file.

## Deploying on Vercel

- **Environment variables.** Keep the names Jeffrey's project already has. `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) stay the same. Set `SESSION_SECRET` (32 characters
  or more) and keep `APP_SHARED_PASSWORD_HASH_B64`. `EVENT_TIMEZONE` defaults to `America/New_York`. All
  of them are listed in `.env.example`. `INVITE_CODE_SHA256` and `INVITE_EXPIRES_AT` are optional (the team
  join link, below).
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
- **After the F2 deploy, ask staff to tap "Update ready · Reload"** when it shows. Until a phone reloads,
  a request's history on it shows a saved medical location as "Edited" with no field name ("— → Chair 14",
  and screen readers hear no field name either). Nothing breaks and the value is right; the reload fixes it.

## Team join link

`https://<host>/signin#join=<code>` (or `https://<host>/#join=<code>`) opens sign-in, keeps the code for that
tab only (sessionStorage) and takes it out of the address bar and the tab's back / forward history at once;
name and team then sign straight in. The browser's own History list still keeps the link (Known limits).
A wrong, expired or switched-off code just shows the password step; too many attempts keeps the code and
shows the lock on step 1. Anyone with the link can sign in until it
expires, so share it like the password (the staff group chat, never a public post or a screenshot).

- **Variables** (Production, server-only, mark them Sensitive). Both optional; with either unset the link is
  off and sign-in is password only, so the build can go out before them.
  - `INVITE_CODE_SHA256`: the hex SHA-256 of the code. The code itself is never stored on the server.
  - `INVITE_EXPIRES_AT`: when the link stops working, ISO with `Z` or an offset: `2026-11-09T12:00:00Z`.
  - A value the server can't read turns the link off (never the app) and logs
    `{"lp":"env","message":"INVITE_… …; team links are off"}` once per instance. Each sign-in logs
    `{"lp":"signin","method":"invite"|"password","ok":…}`, never the code.
- **Make a code** (on your own machine; it prints to the terminal and writes no file):
  `node scripts/make-invite.mjs https://edco26-lost-persons.vercel.app` prints `JOIN_CODE` (32 random bytes,
  base64url), `INVITE_CODE_SHA256` (its SHA-256) and `JOIN_LINK`. Without the script:
  `node -e "const c=require('crypto').randomBytes(32).toString('base64url');console.log(c);console.log(require('crypto').createHash('sha256').update(c).digest('hex'))"`.
- **Turn it on:** set both variables in Vercel, then **redeploy** (a variable change only reaches a new
  deployment). Open `JOIN_LINK` in a private window: the address bar shows `/signin` with no `#join=…`,
  and name + team land in the app. Then share `JOIN_LINK`.
- **Rotate:** make a new code, replace `INVITE_CODE_SHA256`, redeploy, share the new link. The old link then
  shows the password step.
- **Switch off:** delete `INVITE_CODE_SHA256` (or set `INVITE_EXPIRES_AT` to a past time) and redeploy. Who
  already signed in stays signed in (12 h from last use, 36 h at most); changing `SESSION_SECRET` signs
  everyone out.
- **Limits:** a link attempt counts toward the same sign-in limits as a password (10 failed per name and
  network, 100 per network, in 15 minutes).

## Morning checklist (things tests can't cover)

- [ ] iPhone camera capture from New request, and the page survives coming back from the camera.
- [ ] On an iPhone, photograph another phone's screen showing a photo: the crop step opens with the whole
      photo selected, dragging a corner cuts the bezel, Use photo adds it within about a second, and the
      saved photo looks cleaner, not harsher. Safari's Web Inspector (Timelines) shows `lp-photo-prepare`
      with its timings.
- [ ] F2, on an iPhone: a profile's Add photo with two photos, Use photo on the first, Retake on the second,
      take another: the Add sheet shows both. Retake, then close the picker without a photo: the first
      still reaches the Add sheet within about 2 s.
- [ ] F2, on a laptop: the brand row's X hides it, a reload never flashes it, and "Show header" in the
      sidebar's account menu (All requests) brings it back.
- [ ] Keychain fills the password on sign-in step 2.
- [ ] A Home Screen app signs in on its own and keeps its own saved requests, separate from the Safari tab.
- [ ] With the mute switch on, an alert still shows its toast (silently).
- [ ] Desktop Chrome: on a laptop that used the app before this deploy, tap "Update ready · Reload" first
      (until the new build's worker is active, alerts stay toasts, because the old worker can't open a
      clicked notification). Tap "Allow notifications" in the avatar menu (or turn Alerts on) and allow it,
      then minimise the window. When someone answers one of your requests (or logs one, with Alerts on), a
      system notification appears within about a minute, with no phone number in it, and clicking it opens
      that request in the app window.
- [ ] Desktop Chrome with the app in two windows (say the list and the dashboard): an alert is one toast in
      the focused window and nothing in the other; with both minimised it is one notification.
- [ ] iPhone Home Screen app: turning Alerts on asks to allow notifications, and the app then appears in
      Settings → Notifications. In a Safari tab on iPhone nothing is asked and alerts stay toasts.
- [ ] Messages on two phones (one Medical, one front of house): medical asks from a To check card, the other
      phone shows the badge and the preview within a few seconds, the reply shows "Read" on the asker's phone.
      En route ~5 min, change it, cancel and Undo, Arrived; Reunited clears the row, and its Undo brings the
      row back. A message typed in airplane mode shows "Sending…" and goes out once the signal is back.
- [ ] At the end, run `docs/export.sql` in the SQL editor and download the results (Query 1, then Query 2;
      the steps are at the top of the file).
- [ ] Redeploy on Vercel with an old tab open: "Update ready · Reload" appears. It shows only once the phone
  has cached the whole new build, which needs `/sw-manifest.json` on the deploy (written by `next build`).
- [ ] Airplane mode in the middle of a send: it says "Saved on this phone" and sends once the signal is back,
      exactly once.
- [ ] Lie-fi (one bar): a new request queues after about 10 s and sends later.
- [ ] The re-run of the migration on production **before** this build deploys (lp_stats + age → text): dry
      run, then commit (see above).
- [ ] Several staff sign in at once behind the venue Wi-Fi (one shared IP).
- [ ] The "Not found yet" hold on real phones (Pending v9.1): medical taps "Not found yet" → the card stays in
      place with the violet chip, "Not found yet · recheck in 20 min" and Undo, and its button reads "× Not
      found"; 20 minutes later (phone clock) the chip reads "Recheck due" and nothing has moved; "× Not found"
      closes it ("B.W. closed · not found in medical", Undo). Front of house's My requests shows the chip (no
      recheck time) meanwhile.
- [ ] Pending v9.1 on a phone and an iPad: one page (Waiting for check, then Friend coming), each header folds
      its section; the board's columns scroll on their own; "⇅ Status" on All and My requests is remembered.
- [ ] Team join link (once its variables are set): tapped in iMessage on an iPhone, it opens Safari on
      sign-in with no `#join=…` in the address bar; name + team open the app. A wrong code shows the password step.
- [ ] After the event (or once the link expires), clear Safari History on shared iPads that opened the team
      join link (Settings → Apps → Safari → Clear History and Website Data).

## Known limits

- **Answers, edits and adding photos to an existing request need a connection.** Only new requests (with
  their photos) queue offline. Those buttons show "Needs a connection" offline.
- **Alerts need the app open.** There is no push. With the app in the background, desktop browsers,
  Android and the iPhone Home Screen app show a system notification (once allowed); a Safari tab on iPhone
  shows only the toast. A background tab checks once a minute, so a notification can be up to a minute late.
  Phones pause background pages (an iPhone almost at once, Android Chrome after a few minutes), so phone
  notifications are best effort; a desktop window keeps them coming. Notifications start only once the
  device runs this build's service worker ("Update ready · Reload"). A tab still open from before this
  deploy keeps its toast and chime and doesn't coordinate with newer tabs, so it can toast an alert another
  window shows as a notification until it is reloaded. The chime is silent under the mute switch.
- **Identity is self-declared.** Everyone shares one event password, and the name and team are only for
  attribution. Cancelling a request, and reopening a cancelled one, are limited to the staff member who
  logged it, matched by name and team.
- **Sign-in limits:** 10 wrong passwords per name and IP, and 100 per IP, in 15 minutes. A whole team behind
  one venue IP shares the 100.
- **A Home Screen app and the Safari tab are separate.** Each has its own sign-in, saved requests and queue.
  A team join link tapped in Messages opens Safari, so it signs in the Safari tab, not the Home Screen app.
- **A team join link is as strong as the password.** Anyone holding it can sign in until `INVITE_EXPIRES_AT`
  or until it is rotated; the name and team are still self-declared.
- **A device that opened the team join link keeps it in its browser History.** The page clears the address
  bar and the tab's back / forward history, but the browser saved the visited link (code included) first,
  and no page can remove that. The History list and address-bar suggestions offer it until it expires, also
  after sign-out, and Safari iCloud History or Chrome Sync copy it to the user's other devices. A lost or
  shared device can sign in again from History until `INVITE_EXPIRES_AT`: rotate the code if one goes missing,
  and keep the expiry short (the first link: `2026-11-09T12:00:00Z`).
- **There is no export in the app.** The end-of-event files come from `docs/export.sql`. They hold names and
  phone numbers: don't leave them on shared devices.
- **Up to three photos per request.** Photos from Jeffrey's app with no timing show "Timing unknown".
- **Photo cleanup is deliberately light.** It cannot straighten a photo taken at an angle, and moiré bands
  the camera already recorded stay (only the screen's fine pixel grid is averaged away). If cleanup fails or
  takes over 1 s on an old phone, the plain photo is used.
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
