# Handoff: "Is my friend in medical?" rebuild

Updated: 2026-11-07 (F6 inactivity auto-close, `feat/f6-inactive`, on top of the F3 + F4 release). **Production is live at
https://edco26-lost-persons.vercel.app**, deployed from `main`.

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

### 2026-11-07 (F3 + F4 release, `feat/f34`, ships after the join link)

- **Messages and en route (F3)** and **lock-screen alerts, the Alerts sheet and Activity (F4)** on top of
  production (F2, F5, Pending v9.1, the join link, Hotfix F5.1). Both are described below. **This needs the migration below
  re-applied, before the deploy** ([F3 + F4 in production](#f3--f4-in-production)).
- **Pending v9.1 stays as it is**, with F3's pieces added: the Friend coming section header gets the unread
  dot; Waiting for check cards get the last-message line and a Message button left of the answers (where the
  three don't fit on a narrow phone or a narrow board column, In medical moves to its own row; nothing is
  cut); Friend coming cards get the en route row and Message | Reunited.
- **Every event notifies once.** Both Not found answers ("Not found yet · recheck 4:40 PM", then "Not found in
  medical") reach everyone involved as Activity rows and pushes; an Undo of either reads "Back to Waiting for
  check". Whoever gave the first Not found is now involved in the request.
- **On phones under 430 px wide** the log's status reads "Waiting" / "Not found" (was under 400 px), so an
  earlier day's time never cuts the full label at 400–429 px.
- **Cross-feature review fixes:** a locked iPhone with push never also toasts what the lock screen showed; every
  lock-screen alert sounds when it replaces the request's earlier one, and In medical stays until dismissed on a
  computer; the first message on a request a phone saved before the update alerts; Mark all read holds on a slow
  network; the open request's Activity row turns read only while the app is on screen; Not found yet ends Needs info
  at once. Client only, no migration.
- **Hotfix F5.1 is in** (`main` 332c90a merged): the release ships on top of exactly what production runs.
- Decisions: `design/DECISIONS.md` "The F3 + F4 release" (and its review fixes); spec: `docs/BUILD_SPEC.md` §23 (A90–A95).

### 2026-11-07 (F6 inactivity auto-close, `feat/f6-inactive`, ships after F3 + F4)

- **A request In medical with no activity for an hour closes by itself** as **"Closed · inactive"** (grey, a timer-off
  glyph; "Inactive" on a phone under 430 px), folded into Archived / Closed. Activity is any write (answer, edit,
  location, photo, message, en route); opening or reading never counts. Waiting for check (Needs info, Not found yet)
  never closes. The database does it every 5 minutes (pg_cron job **`lp-close-inactive`**), as "System", with the
  note "No activity for 1 h" in the audit trail and the export.
- **Reopen** (anyone) is in the request's action bar and brings it back to Friend coming. The staff involved get one
  Activity row and push, "Closed · inactive". The backlog the first run closes is told to nobody: no Activity row,
  no push, and no in-app alert on a phone running this build.
- **Dashboard:** a "Closed · inactive" tile beside Friends en route; they count in Closed, never in Reunited or Time to
  reunite. **Export:** the status reads "Closed · inactive".
- **Medical starts with "New requests" on** (lock-screen push and the in-app toast) unless they switched it off in the
  Alerts sheet (Brian, 2026-11-07 02:15). On by that default alone it adds no Activity row: their bell and app badge
  count what they counted before.
- **Deploy first, then the migration** ([F6 in production](#f6-in-production)): this build works on today's database.
- Decisions: `design/DECISIONS.md` "F6 inactivity auto-close"; spec: `docs/BUILD_SPEC.md` §24 (A96–A103).

### 2026-11-06 evening (F4: lock-screen alerts, the Alerts sheet and Activity)

- **Lock-screen alerts (Web Push).** Answers, location changes, Back to Waiting, Reunited, Discharged,
  Cancelled and edits reach everyone involved in the request; new requests reach staff with "New requests"
  on. The notification shows the request's initials and one line ("In medical · Chair 9"), never a name, LP
  number or phone number. One per request on the lock screen. With the app in front there is no
  notification (the toast shows); a phone with push never also gets the page's own notification. The page's
  own notification (devices without push) no longer shows the LP number either: "S.L. · In medical" / "FA 3".
- **Alerts sheet** (avatar menu → Alerts; the desk sidebar and rail): this device On / Off / Blocked, "Send a
  test alert", and the two switches "New requests" and "Updates on my requests", saved on the server for every
  device of the staff member. "New requests" is the old in-app Alerts bell.
- **Alerts banner** on All, Pending and My requests until alerts work on the device, with the exact taps for
  that phone or browser (Turn on; Home Screen steps on an iPhone or iPad Safari tab; the settings path when
  blocked).
- **Activity**: a bell next to search (and in the desk top bar and sidebar) with an unread count; one row per
  request, newest first; opening the request marks it read; Mark all read with Undo; the app icon badge.
- Not in this release: messages, en route and the Not in medical / Not found yet notifications (the
  Messages and Not found yet releases send those through the same inbox and pushes).
- **Review fixes (2026-11-07, DECISIONS F4 rows 15–23, BUILD_SPEC A60):** a sign-out that fails (offline)
  keeps the device's lock-screen alerts; "Send a test alert" shows with the app open; the open app decides
  whether it is in front (iPad split view, Android multi-window) and toasts pushed events it would not toast
  itself; a desk with the old bell off can't switch a phone's "New requests" off; the iPhone Home Screen
  chips end with "Add" (Open as Web App is already on); the blocked path names the app "In medical?" as
  Settings lists it; the desk Activity popover works with the keyboard; a poll no longer carries the unread
  ids; nobody can remove another person's device.

#### F4 integrator notes

- **Done in the F3 + F4 release:** `'not_in_medical'` is in `PUSHED_ALERT_KINDS` (`lib/client/push-client.ts`
  and its test), now that F5's stage-notify pushes both Not found answers.
- **Test keys:** the local VAPID pair and `LP_PUSH_ALLOW_LOCAL=1` are in the tracked `.env.test.push` (loaded
  by `scripts/test-env.mjs` under `.env.test`). `.env.test` itself is unchanged from the base, so the stack
  scripts (`use.sh`) need nothing new.

#### F4 in production

1. **Migration first.** The F4 section of `20261106000000_rework.sql` adds three tables (`lp_push_prefs`,
   `lp_push_subscriptions`, `lp_activity`) and the `lp_push_*` / `lp_activity_*` functions. It is additive:
   nothing the live build uses changes, and a second run keeps every row. Dry run (ending in `rollback;`),
   then commit, as below. Check:
   `select count(*) from pg_proc where proname like 'lp\_push\_%' or proname like 'lp\_activity\_%';`
   returns `12`, `select to_regclass('public.lp_activity') is not null;` returns `true`, and
   `select count(*) from information_schema.columns where table_name = 'lp_push_prefs' and column_name = 'new_requests_set';`
   returns `1`.
2. **Environment.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are already set in production
   (keep them; `VAPID_SUBJECT` must be `mailto:` or `https:`). `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is optional
   (the app reads the key from the server). If the keys are missing or invalid, push is simply off: no banner,
   no pushes; Activity and in-app alerts still work. Do not change the pair during the event: every device
   would subscribe again on its next open.
3. **Then deploy.** A build deployed before the migration answers 503 on `/api/push/*` and `/api/activity*`
   (the bell stays empty, no banner); sync and everything else keep working.
4. Old phones keep working: their cached app ignores the new sync fields, their queued requests send as
   before (a new request then notifies staff with "New requests" on).

#### Verified vs researched (alerts banner chips and push behaviour)

| What | How it was checked |
|---|---|
| iPhone Safari, iOS 27: Menu → Share → Add to Home Screen → Add (Open as Web App is on already, so it is not a chip; VoiceOver hears "keep Open as Web App on") | Researched: Apple, "Turn a website into an app in Safari on iPhone" (steps: "Tap Add to Home Screen", "Turn on Open as Web App", "Tap Add"); WebKit, "WebKit Features in Safari 26.0" ("By default, every website added to the Home Screen opens as a web app"); re-checked 2026-11-07. Apple's iOS 27 page: the button is "the Page Menu button". Re-read 2026-11-06 20:30 (iOS 27 page: "the Page Menu button"; iOS 26 page: "the More button"). Not seen on a device: this Mac has Xcode but no iOS Simulator runtime (`xcrun simctl list runtimes` is empty; the T3 device tools list no devices; checked again 2026-11-07 01:10, unchanged). |
| iPhone Safari, iOS 26: More (⋯) → Share → … | Researched: the same Apple article, iOS 26 version ("the More button"). |
| iPhone Safari, iOS 17 / 18: Share → Add to Home Screen → Add | Researched: Apple, "Bookmark a website in Safari on iPhone", iOS 17 and 18 (the Add button of the sheet that opens). |
| iPad Safari 27 / 26 / 18 | Researched: Apple, "Turn a website into an app in Safari on iPad" (27: View More; 26: the More button). |
| iOS 26+ Safari's frozen user agent (iPhone OS 18_6 + Version/26.x) | Researched: WebKit, "WebKit Features in Safari 26.0". Unit-tested with those strings. |
| Home Screen app blocked: Settings → Notifications → In medical? (the Home Screen name, `apple-mobile-web-app-title` / manifest `short_name`) → Allow Notifications; Android installed app likewise "In medical?" | Researched: Apple, "Change notification settings on iPhone", iOS 17, 18, 26 and 27 pages (all give "Settings → Notifications, then tap an app below Notification Style … Allow Notifications"; re-read 2026-11-06 20:30 for 26 and 27, and 2026-11-07 for 26: "Go to the Settings app … Tap Notifications, then tap an app below Notification Style"). The brief's "Settings → Apps → the app → Notifications" (18+) is not on Apple's page; WebKit, "Web Push for Web Apps on iOS and iPadOS": a web app's permission is managed "in Notifications Settings — just like any other app". |
| Android Chrome: More → Site controls → Permissions → Notifications → Allow | Researched: Google, "Use notifications to get alerts" (Android; re-read 2026-11-06 20:30: "Tap More → Site controls → Permissions"). No Android emulator on this machine (no Android SDK). |
| Android installed app: Settings → Notifications → App notifications → the app | Researched: Google, "Control notifications on Android". |
| Desktop Chrome: View site information → Notifications | Researched: Google, "Use notifications to get alerts" (computer; re-read 2026-11-06 20:30: "Click View site information. To allow notifications, turn on Notifications"). Verified in Playwright Chromium (headless): the banner states, Turn on, revoke → blocked, re-check, overflow at 820 / 1180 / 1440 px. |
| Edge, Firefox, Safari on a Mac | Researched: Microsoft, "Manage website notifications in Microsoft Edge" (View site information → Permissions for this site → Notifications); Mozilla, "Web Push notifications in Firefox" (the Permissions icon in the address bar opens the site's permissions; a block is cleared with ×, then the page asks again); Apple, "Customize website notifications in Safari on Mac". Not run. |
| WebKit revokes push after silent pushes | Researched: Apple docs / WebKit blog quoted in WebKit and Firebase issues (3 silent pushes). The worker never leaves a push silent on WebKit (unit-tested). |
| A push while the app is in front shows nothing; the page syncs | Verified in Playwright Chromium: a push event dispatched inside this build's real service worker (`worker.evaluate`; the DevTools protocol's push delivery, and `setAppBadge` in a worker, crash the headless Chromium shell). The background path (shown, tag, badge, silent-and-closed on WebKit) is unit-tested against `public/sw.js`. |
| "Send a test alert" shows with the app in front; a page that says it is in front (iPad split view) gets no notification | Verified in Playwright Chromium (the worker's own `showNotification` calls, recorded) and unit-tested against `public/sw.js` with Chromium and WebKit user agents. Not seen on a real iPad. |
| The desk Activity popover by keyboard (Enter on the bell or the sidebar item, Tab to Mark all read and the rows, Escape back) | Verified in Playwright Chromium (`tests/e2e/activity.spec.ts`). |
| Encryption and delivery to a push service | Verified in the integration tests: `web-push` 3.6.7 sends to a fake HTTPS push service on 127.0.0.1 that decrypts every payload (aes128gcm) and answers 201, 410, 500 or never (deletion, failure counting and the timeout). |
| The banner and the sheet on an iPhone layout | Verified in Playwright WebKit (iPhone 14 profile) with a faked PushManager, permission and Home Screen mode: install, off, blocked, on. Not a real iPhone. |
| Real delivery to a phone's lock screen | Not verified here (needs a real device and the production keys): morning checklist below. |

## The production migration

### F6 in production

Production has the F3 + F4 file (`main` cf78f90). This release's file is that file with section 9 appended (the
auto-close) and these additive changes in place: step 2's status list gains `'Closed – Inactive'` (so the first paste
replaces `patients_status_check` once, `NOT VALID`, keeping every value in use), `lp_row` adds `quiet_close`,
`lp_set_status` allows Closed – Inactive → In medical (Reopen), `lp_stats` adds `inactive`, `lp_push_prefs` gains
`new_requests_team_default`, `lp_activity_record` accepts `closed_inactive` (and writes no new-request row for a
Medical switch that is on by the team's default alone), and `lp_push_prefs_sync` starts Medical with New requests on.

**Order: deploy first, then the migration.** This build works on the database production has now: it calls one new
function (`lp_inactive_claim`) only for a Closed · inactive row, which can't exist yet; the dashboard's "Closed ·
inactive" tile shows "—"; Reopen never appears; the Alerts switches are read and set as before. The other order would
let the first run (within 5 minutes of the commit) close the backlog under the old build, which shows the value
verbatim with no Reopen, raises an in-app alert for each one on its phones, and never tells a close in the gap (an
untold close is given up after 15 minutes).

1. **Deploy** (merge to `main`; Vercel deploys it; no new environment variable). Ask staff to tap "Update ready ·
   Reload". A phone left on the old build still works; it only shows the closes verbatim, grey, with no Reopen, until
   it reloads.
2. **Before** (SQL Editor, as `postgres`):
   - `select public.lp_stages_recheck_minutes();` returns `20`, and
     `select count(*) from pg_proc where proname like 'lp\_push\_%' or proname like 'lp\_activity\_%';` returns `12`
     (F5 and F4 are applied). If not, stop.
   - `select name, installed_version from pg_available_extensions where name = 'pg_cron';` returns one row (the
     installed version may be empty: the file enables it). No row: the file still applies, but nothing closes until
     pg_cron is enabled (Database → Extensions → pg_cron) and the file is pasted again.
3. **Dry run.** Paste the whole file, change the last line `commit;` to `rollback;`, run. It must finish without an
   error. Read the NOTICEs:
   - `patients_status_check: replacing (NOT VALID). Legacy values kept …` (first time only);
   - `lp-close-inactive: N request(s) In medical have had no activity for 60 min now (the next run closes them).`
     N is the backlog the first run will close, quietly (a close more than 15 minutes past the hour tells nobody: no
     Activity row, no push, no in-app alert on the new build);
   - `pg_cron: enabled.` (only if it was not), then `lp-close-inactive: scheduled every 5 minutes (job …)`.
     `NOT scheduled (pg_cron is not available)` means step 2's pg_cron row was missing.
   Nothing is saved. The locks are brief: the CHECK swap on `patients` (`lock_timeout` 5 s; behind a long live write it
   stops with a lock timeout and changes nothing: run it again).
4. **Commit:** paste the file again unchanged (ending in `commit;`) and run it.
5. **Check:**
   - `select public.lp_inactive_minutes();` returns `60`;
   - `select count(*) from pg_proc where proname in ('lp_close_inactive', 'lp_inactive_claim', 'lp_inactive_minutes');` returns `3`;
   - `select jobname, schedule, command, active from cron.job where jobname = 'lp-close-inactive';` returns exactly one
     row: `lp-close-inactive | */5 * * * * | select public.lp_close_inactive() | t`;
   - `select pg_get_constraintdef(oid) like '%Closed – Inactive%' from pg_constraint where conname = 'patients_status_check';` returns `true`;
   - `select to_regclass('public.lp_inactive_closes') is not null, public.lp_stats() ? 'inactive';` returns `true | true`;
   - (7b) `select count(*) from public.lp_push_prefs where staff like '% · medical' and not new_requests_set and not new_requests;` returns `0`.
6. **After the first run** (within 5 minutes of the commit):
   - `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'lp-close-inactive') order by start_time desc limit 3;`
     shows `succeeded`;
   - `select count(*) from public.patients where status = 'Closed – Inactive';` is the dry run's N (plus any closed since);
   - `select count(*), count(*) filter (where quiet) from public.lp_inactive_closes;` the second number is the backlog;
   - `select count(*) from public.lp_inactive_closes where notified_at is null;` is `0` within 20 minutes.

**Pause it** (a bad night, a wrong close): `select cron.unschedule('lp-close-inactive');`. Nothing closes until the file
is pasted again (which schedules exactly one job) or `select cron.schedule('lp-close-inactive', '*/5 * * * *', 'select public.lp_close_inactive()');`.
A closed request is reopened from its action bar (Reopen), one at a time. To go back, redeploy the previous build and
pause the job; the SQL can stay (the old build shows Closed – Inactive verbatim and can't reopen it). A second paste
keeps every close and notice and leaves one job.

If the migration has to go first after all (the deploy is blocked), pause the job right after the commit as a normal
step (`select cron.unschedule('lp-close-inactive');`) and schedule it again (the `cron.schedule` line above, or a
paste of the file) once the new build is live. The old build works on the migrated database: it never calls the new
functions; its Not found, answers and edits are unchanged; its dashboard's Closed tile leaves Closed · inactive out;
its Activity list skips a `closed_inactive` row (the bell still counts it) until the phone reloads.

### F3 + F4 in production

Production has `main`'s file (99e2db6: F2, F5, the join link; Hotfix F5.1, 332c90a, did not change it). This release's file is that file with two
sections appended (7: messages and en route; 8: Web Push and Activity) and four header comment lines; no line
of `main`'s file changes. **Order: migration first, then deploy.**

1. **Before:** `select public.lp_stages_recheck_minutes();` returns `20` (F5 is applied). If not, stop.
2. **Dry run** (Supabase dashboard → SQL Editor, as `postgres`): paste the whole file, change the last line
   `commit;` to `rollback;`, run. It must finish without an error. It takes locks for a moment only: the
   new trigger on `patients`, the new index on `audit_events`. `lock_timeout` is 5 s, so behind a long live
   write it stops with a lock timeout and changes nothing; run it again.
3. **Commit:** paste the file again unchanged (ending in `commit;`) and run it.
4. **Check:**
   - `select count(*) from pg_proc where proname in ('lp_post_message','lp_mark_read','lp_set_enroute','lp_unsend_message','lp_involved_staff','lp_messages_thread','lp_messages_sync','lp_enroute_stats');` returns `8`;
   - `select count(*) from pg_proc where proname like 'lp\_push\_%' or proname like 'lp\_activity\_%';` returns `12`;
   - `select to_regclass('public.lp_messages') is not null, to_regclass('public.lp_enroute') is not null, to_regclass('public.lp_activity') is not null;` returns `true | true | true`;
   - `select count(*) from pg_trigger where tgname = 'lp_enroute_clear';` returns `1`;
   - `select count(*) from information_schema.columns where table_name = 'lp_push_prefs' and column_name = 'new_requests_set';` returns `1`.
5. **Environment (Vercel):** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` set and unchanged (see "F4
   in production"). Missing keys only switch push off.
6. **Deploy.** Then ask staff to tap "Update ready · Reload".

The build that is live now keeps working on the migrated database: it never calls the new functions, and the
trigger only deletes en route rows, which only this build writes. Phones with old cached rows ignore the new
optional fields; their queued requests send as before (a queued new request then also notifies staff with
"New requests" on). A second paste keeps every message, read cursor, en route row, subscription, switch and
Activity row. To go back, redeploy the previous build; the SQL can stay. Proven locally: `main`'s file on a
fresh stack with the seed, then this file twice, then the full integration and end-to-end suites.

### Earlier runs

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

- **Environment variables.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` switch lock-screen
  alerts on (F4; already set). Keep the names Jeffrey's project already has. `NEXT_PUBLIC_SUPABASE_URL` and
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

- [ ] **F6, after the deploy:** the migration is applied ([F6 in production](#f6-in-production): deploy, dry run,
      commit, checks); within 5 minutes `cron.job_run_details` shows the first run `succeeded`, and an open phone on
      the new build shows no toast for the backlog it closed.
- [ ] **F6 on real phones:** a front-of-house phone with alerts on, locked; an In medical request of theirs left alone
      for an hour shows "Closed · inactive" under its initials on the lock screen, once; in the app it is in Archived
      with the grey timer; Reopen on it puts it back in Friend coming.
- [ ] **F6, Medical:** a Medical phone that never touched the Alerts sheet shows "New requests" on, and a new request
      reaches its lock screen; its Activity bell does not count it.

- [ ] **F3 + F4, before the deploy:** the migration is applied on production ([F3 + F4 in
      production](#f3--f4-in-production): dry run, commit, checks).
- [ ] **F3 + F4, Not found on real phones:** front of house with alerts on locks the phone; medical taps "Not
      found yet": the lock screen shows the initials and "Not found yet · recheck 4:40 PM" once; "× Not found"
      replaces it with "Not found in medical"; Undo shows "Back to Waiting for check". With the app open, only
      the toast shows.
- [ ] **F3 + F4, messages:** a message from medical reaches a locked front-of-house phone as "J.D." / "Rae C.:
      …"; with that request open on screen, no toast and no notification.

- [ ] **F4, before the deploy:** the F4 migration section is applied on production (dry run, then commit;
      the checks under "F4 in production").
- [ ] **F4, iPhone Home Screen app:** the banner says "Alerts are off"; Turn on asks, then the Alerts sheet
      opens with "On for this phone"; "Send a test alert" shows a notification on the lock screen within a few
      seconds with "Is my friend in medical?" / "Test alert"; tapping it opens the app.
- [ ] **F4, iPhone Safari tab:** the banner shows this phone's Home Screen taps and they match the screen
      (on iOS 26+, the Compact tab layout; with Bottom / Top, Share is on the toolbar), and "Open as Web App"
      is already on when the Add sheet opens. With alerts blocked, Settings → Notifications lists the app as
      "In medical?".
- [ ] **F4, sign-out offline:** on a phone with alerts on, airplane mode → sign out (it fails) → back online:
      the Alerts sheet still says "On for this phone" and "Send a test alert" arrives.
- [ ] **F4, Android Chrome and a desktop browser:** Turn on, then "Send a test alert"; then with the screen
      locked (or the browser closed), an In medical answer on one of your requests arrives as "J.D." /
      "In medical" and opens that request. With the app in front, only the toast shows.
- [ ] **F4, Activity:** someone else answers your request: the bell shows 1; the row opens the request and the
      count drops; Mark all read → Undo.

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
- [ ] Hotfix F5.1 on an iPhone (Safari tab and Home Screen app): In medical → the "Bed or chair" sheet sits right on the
      keyboard, nothing undimmed between them, the list doesn't move; Done on the keyboard drops the sheet back down;
      Skip leaves the list where it was. On All and My requests "⇅" stands clear of the avatar on the live line.
- [ ] Pending v9.1 on a phone and an iPad: one page (Waiting for check, then Friend coming), each header folds
      its section; the board's columns scroll on their own; "⇅ Status" on All and My requests is remembered.
- [ ] Team join link (once its variables are set): tapped in iMessage on an iPhone, it opens Safari on
      sign-in with no `#join=…` in the address bar; name + team open the app. A wrong code shows the password step.
- [ ] After the event (or once the link expires), clear Safari History on shared iPads that opened the team
      join link (Settings → Apps → Safari → Clear History and Website Data).

## Known limits

- **The auto-close is by the clock, not by intent** (F6): a request someone is still working on without touching it
  (no message, location or en route) closes after an hour In medical; Reopen brings it back. A close is told to the
  staff involved only when a phone syncs within 15 minutes of it (any open app does, every few seconds), and never
  for the backlog closed on the first run after the migration or after the job was paused (no Activity row, no push,
  no in-app alert; a phone still on a build from before F6 shows its usual in-app update for its own requests).
- **Medical's default "New requests" is a push, not an Activity row** (F6 7b): a Medical member who switches it on
  in the Alerts sheet (or whose phone's old bell had it on) gets the Activity row too, as everyone else does.

- **Answers, edits and adding photos to an existing request need a connection.** Only new requests (with
  their photos) queue offline. Those buttons show "Needs a connection" offline.
- **Lock-screen alerts need Web Push on the device** (F4): desktop browsers, Android Chrome and the iPhone /
  iPad Home Screen app (iOS 16.4+), once Turn on was tapped. A Safari tab on iPhone gets the banner with the
  Home Screen taps instead. Push goes through Apple's, Google's, Mozilla's or Microsoft's push service, so a
  phone with no signal gets it when it is back (within an hour for answers, 15 minutes for the rest).
  Without push, the earlier behaviour holds: with the app in the background, desktop browsers,
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
