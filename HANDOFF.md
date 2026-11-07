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
- **New request is fully open** in Jeffrey's order (post, missing person, more details, then friend or family
  last and optional). **Age and gender are free text** ("mid-20s", "Non-binary"; Male / Female / Other are
  quick-fill chips), and search matches the age text. This needs the migration re-run below.
- **Alerts depend on the device** (Brian; `design/DECISIONS.md` v2.2 row 10, spec §17 A52). With the app in
  the background (another tab, a minimised window), an alert is a system notification instead of the toast
  and chime, on desktop Chrome, Edge, Firefox and Safari, Android Chrome and the iPhone Home Screen app. The
  browser asks only when someone turns Alerts on or taps "Allow notifications" in the avatar menu; refused
  shows "Blocked in browser". A notification shows the LP number, the status, initials and the post (no
  phone numbers), and a click opens the request. No server change: no push, no keys to set on Vercel.

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

#### F4 in production

1. **Migration first.** The F4 section of `20261106000000_rework.sql` adds three tables (`lp_push_prefs`,
   `lp_push_subscriptions`, `lp_activity`) and the `lp_push_*` / `lp_activity_*` functions. It is additive:
   nothing the live build uses changes, and a second run keeps every row. Dry run (ending in `rollback;`),
   then commit, as below. Check:
   `select count(*) from pg_proc where proname like 'lp\_push\_%' or proname like 'lp\_activity\_%';`
   returns `12`, and `select to_regclass('public.lp_activity') is not null;` returns `true`.
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
| iPhone Safari, iOS 27: Menu → Share → Add to Home Screen → Open as Web App | Researched: Apple, "Turn a website into an app in Safari on iPhone" (iOS 27 page; the button is "the Page Menu button"). Re-read 2026-11-06 20:30 (iOS 27 page: "the Page Menu button"; iOS 26 page: "the More button"). Not seen on a device: this Mac has Xcode but no iOS Simulator runtime (`xcrun simctl list runtimes` is empty; the T3 device tools list no devices; checked again 2026-11-07 01:10, unchanged). |
| iPhone Safari, iOS 26: More (⋯) → Share → … | Researched: the same Apple article, iOS 26 version ("the More button"). |
| iPhone Safari, iOS 17 / 18: Share → Add to Home Screen | Researched: Apple, "Bookmark a website in Safari on iPhone", iOS 17 and 18. |
| iPad Safari 27 / 26 / 18 | Researched: Apple, "Turn a website into an app in Safari on iPad" (27: View More; 26: the More button). |
| iOS 26+ Safari's frozen user agent (iPhone OS 18_6 + Version/26.x) | Researched: WebKit, "WebKit Features in Safari 26.0". Unit-tested with those strings. |
| Home Screen app blocked: Settings → Notifications → the app → Allow Notifications | Researched: Apple, "Change notification settings on iPhone", iOS 17, 18, 26 and 27 pages (all give "Settings → Notifications, then tap an app below Notification Style … Allow Notifications"; re-read 2026-11-06 20:30 for 26 and 27, and 2026-11-07 for 26: "Go to the Settings app … Tap Notifications, then tap an app below Notification Style"). The brief's "Settings → Apps → the app → Notifications" (18+) is not on Apple's page; WebKit, "Web Push for Web Apps on iOS and iPadOS": a web app's permission is managed "in Notifications Settings — just like any other app". |
| Android Chrome: More → Site controls → Permissions → Notifications → Allow | Researched: Google, "Use notifications to get alerts" (Android; re-read 2026-11-06 20:30: "Tap More → Site controls → Permissions"). No Android emulator on this machine (no Android SDK). |
| Android installed app: Settings → Notifications → App notifications → the app | Researched: Google, "Control notifications on Android". |
| Desktop Chrome: View site information → Notifications | Researched: Google, "Use notifications to get alerts" (computer; re-read 2026-11-06 20:30: "Click View site information. To allow notifications, turn on Notifications"). Verified in Playwright Chromium (headless): the banner states, Turn on, revoke → blocked, re-check, overflow at 820 / 1180 / 1440 px. |
| Edge, Firefox, Safari on a Mac | Researched: Microsoft, "Manage website notifications in Microsoft Edge" (View site information → Permissions for this site → Notifications); Mozilla, "Web Push notifications in Firefox" (the Permissions icon in the address bar opens the site's permissions; a block is cleared with ×, then the page asks again); Apple, "Customize website notifications in Safari on Mac". Not run. |
| WebKit revokes push after silent pushes | Researched: Apple docs / WebKit blog quoted in WebKit and Firebase issues (3 silent pushes). The worker never leaves a push silent on WebKit (unit-tested). |
| A push while the app is in front shows nothing; the page syncs | Verified in Playwright Chromium: a push event dispatched inside this build's real service worker (`worker.evaluate`; the DevTools protocol's push delivery, and `setAppBadge` in a worker, crash the headless Chromium shell). The background path (shown, tag, badge, silent-and-closed on WebKit) is unit-tested against `public/sw.js`. |
| Encryption and delivery to a push service | Verified in the integration tests: `web-push` 3.6.7 sends to a fake HTTPS push service on 127.0.0.1 that decrypts every payload (aes128gcm) and answers 201, 410, 500 or never (deletion, failure counting and the timeout). |
| The banner and the sheet on an iPhone layout | Verified in Playwright WebKit (iPhone 14 profile) with a faked PushManager, permission and Home Screen mode: install, off, blocked, on. Not a real iPhone. |
| Real delivery to a phone's lock screen | Not verified here (needs a real device and the production keys): morning checklist below. |

## The production migration

[`supabase/migrations/20261106000000_rework.sql`](supabase/migrations/20261106000000_rework.sql) is the only
file production needs. The other files in that folder are the local chain: the baseline and both
2026-11-05 files are already in production, or are covered by the rework file.

- **Applied to production on 2026-11-06** through the Supabase Management API, with a dry run (ending in
  `rollback;`) first, then the commit run.
- **It must be re-applied on production before this build deploys** (release `release/f1`). Two changes
  need it:
  - `lp_stats` now also returns `avgReuniteMinutes` and `loggedLastHour` (the new dashboard reads both).
  - `patients.age` becomes free text ("mid-20s"; step 1b), its 0–120 CHECK is dropped, and
    `lp_clean_fields` takes free-text age and gender (at most 40 characters each). Every stored age is kept
    as its text (24 → `'24'`).

  The integrator does this, with the same dry run, then commit. **Order: migration first, then deploy.**
  The new build sends text ages, which the old `lp_clean_fields` refuses, and its dashboard needs the two
  new stats fields. The build that is live now keeps working on the migrated database: it sends whole-number
  ages, which are stored as their text, and reads them back as numbers. The extra stats fields change nothing
  for it. The file is one transaction, keeps its preflight, and is safe to re-run on a database that already
  has every `lp_*` function and a text `age`. `lp_stats` is `create or replace`, and step 1b prints
  `patients.age: already text, unchanged.` on a second run.

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
   returns `text`.
5. **Storage.** Confirm the `patient-photos` bucket is still **private**.

If the preflight stops it ("Preflight failed: …"), the SQL editor is pointed at the wrong project or the
schema differs from `supabase/schema.sql`. Stop and send Brian the message. Don't edit the file.

## Deploying on Vercel

- **Environment variables.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` switch lock-screen
  alerts on (F4; already set). Keep the names Jeffrey's project already has. `NEXT_PUBLIC_SUPABASE_URL` and
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

- [ ] **F4, before the deploy:** the F4 migration section is applied on production (dry run, then commit;
      the checks under "F4 in production").
- [ ] **F4, iPhone Home Screen app:** the banner says "Alerts are off"; Turn on asks, then the Alerts sheet
      opens with "On for this phone"; "Send a test alert" shows a notification on the lock screen within a few
      seconds with "Is my friend in medical?" / "Test alert"; tapping it opens the app.
- [ ] **F4, iPhone Safari tab:** the banner shows this phone's Home Screen taps and they match the screen
      (on iOS 26+, the Compact tab layout; with Bottom / Top, Share is on the toolbar).
- [ ] **F4, Android Chrome and a desktop browser:** Turn on, then "Send a test alert"; then with the screen
      locked (or the browser closed), an In medical answer on one of your requests arrives as "J.D." /
      "In medical" and opens that request. With the app in front, only the toast shows.
- [ ] **F4, Activity:** someone else answers your request: the bell shows 1; the row opens the request and the
      count drops; Mark all read → Undo.

- [ ] iPhone camera capture from New request, and the page survives coming back from the camera.
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

## Known limits

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
