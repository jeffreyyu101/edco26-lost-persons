# Rework decisions

Product and design decisions for the rework of the lost-persons app, in the order they were made. Screens live in `screens/`. Each screen has an `.html` file that uses real Radix Themes components and needs internet to load them, plus a `.png` of it.

## Ground rules

- **Every working feature in Jeffrey's app stays.** Only cosmetic things may be cut, such as the headline, the date line and the Insomniac label. If a feature moves, write down where it went.
- **One screen for everyone.** There are no roles and no accounts: staff open a link. Name and team exist only for the audit trail (Jeffrey's spec).
- **Look:** Radix Themes 3.3, monochrome (accent gray, high contrast), the Inter font, and a light/dark toggle in the top right. Aim for a Linear-like feel: clean, modern, not flashy.

## Sign-in (approved 2026-11-06) — `screens/sign-in.*`

- **Step 1 is name plus team.** Teams are cards in a 2×2 grid, with the "Other team" text field below. Jeffrey picked the teams on 2026-11-06. Each card shows its icon above the label so all four stay the same height.

  | Card label | Saved value |
  |---|---|
  | Dispatch | `GC/HX - Dispatch` |
  | GCHX Base | `GC/HX - Base` |
  | GCHX Med Transpo | `GC/HX - Special Operations/Med Transpo` |
  | Medical | `Medical` |

  **Backend change needed:** `Medical` replaces `Prevent` in `DEPARTMENTS` (`lib/types.ts`).
- **Heading (Brian, 2026-11-06).** With "Is my friend in medical?" as the heading, the name field read as if it wanted the *friend's* name. So the app name is now a small grey line under the logo, and the heading says **"Staff sign-in"**. The name field has a person icon, and the team label reads "Your team". Step 2 keeps the same small app-name line above "Enter the event password".
- **Step 2 is the event password.**
  - A filled identity row (avatar, name, team) has a Change button that goes back to step 1.
  - The password field has a show/hide button.
  - A wrong password turns the field border red and shows a message under it.
- **The phone remembers name and team.** After the 12-hour session expires, sign-in opens directly on step 2.
- **Where the old sign-in features went:**
  - Sign out: the avatar menu.
  - "Operating as name · department": the avatar menu.
  - The privacy note: the new-request form.
  - The "Built by Jeffrey Yu" credit: the avatar menu.

## Name of the missing person (Jeffrey + Devin, 2026-11-06)

- Full names are allowed. Jeffrey prefers initials and Devin is fine with full names, so we ask for initials but accept anything.
- The field is labelled **Name**. Its placeholder (ghost text) is **"Initials, e.g. J.D."**
- There is no warning after a full name is typed. The old "For privacy, use initials…" warning is removed.
- This applies to both the new-request form and editing in the profile.
- The saved data is unchanged: the API still splits the name into `first_name` and `last_name` at the last space.
- Lists and cards must work with long full names. A name that doesn't fit is cut off with "…".

## Requests screen (approved 2026-11-06, v5) — `screens/requests.*`

- **App name:** "Is my friend in medical?" (Jeffrey). It is the sign-in heading and the in-app header title.
- **Main view (Jeffrey, 01:03).** **All** is the default and the main screen. It is one chronological log, newest first, with no grouping. Each row shows a status icon, name, age and sex, the time logged, a status label in that status's colour, the post, and the LP number. Closed requests stay in the list but are dimmed.
- **Views (Jeffrey's spec, built as Brian asked).** The list title is a view switcher, "All requests 21 ⌄", in the style of Mail or Linear views. Views are named by task, not role, because a nurse thinks "what's pending?", not "I'm the medical liaison" (Brian). The menu (`screens/view-menu.png`):
  - **All requests**, the default.
  - A divider.
  - **Pending** (inbox icon): the queue that needs checking, plus Friend coming.
  - **My requests** (person icon): what this phone sent.
  - Each option shows its count, with no role labels or descriptions. In Pending or My requests, a × returns to All.
- **The check has two outcomes only (Brian and Jeffrey, together, 2026-11-06): In medical or Not in medical.** Nothing else is shared with the friend, so never "left" or "taken to hospital". The labels and their database values:

  | Shown as | Database value | Colour |
  |---|---|---|
  | Waiting for check | `Added` | grey |
  | Not in medical | `Checked – Not Found` | amber |
  | In medical · friend coming | `Found – Awaiting Reunion` | green |
  | Reunited / Discharged / Cancelled | the closed statuses, set from the profile | dimmed |

  **"Bring friend to medical" is removed**, along with the follow-up "still in medical?" question and its sheet. No screen offers it. The database constraint can keep the value until there is a cleanup migration.
- **To check (the liaison's queue).**
  - Requests are listed oldest first. The waiting time turns amber at 10 minutes and red at 20 (Jeffrey confirmed).
  - Each card has two buttons, **Not in medical** and **In medical**. One tap sets the status, and an Undo bar shows for a few seconds.
  - **Not in medical is final (Brian):** no rechecks and no Recheck section. The request leaves To check, and its progress line ends at Logged → Checked → Not in medical.
  - **Friend coming (Brian, 2026-11-06).** An "In medical" request moves to a **Friend coming** section at the top of To check. Each card shows the patient, the friend's name, which post they're coming from, and how long ago they set off, so medical knows who to expect. **Reunions always happen at Main Med.** A **Reunited** button closes the request when they meet.
  - On front of house's side, the alert reads "LP-1004 · S.L. is in medical — Bring the friend to Main Med", so they know to take the friend over.
- **Mine (front of house).** Requests are sorted by most recently updated, with a progress line under each: Logged → Checked → In medical → Reunited.
- **Header.** Search, the alert bell and your avatar. To make room for the app name, the light/dark toggle in the app moved into the avatar menu. It stays in the top right on sign-in.
- **Alerts.**
  - Changes to your own requests always alert you.
  - New requests alert you only when the bell is on.
  - Inside the app, an alert is a banner with a sound.
  - Lock-screen alerts on iPhone need the app added to the Home Screen. Vibration works only on Android.
- **Features from Jeffrey's app that still need a place on this screen:**
  - CSV export and the light/dark toggle: the avatar menu.
  - The offline queue: a banner showing how many requests are waiting to send.
  - Manual refresh: pull to refresh.
  - The status filter: tap a group header.
  - "Recently updated": a sort option.

## New request (approved 2026-11-06, v3) — `screens/new-request.*`

References: `references/mobbin-forms.png` with notes in `references/mobbin-forms.txt` (Fitbit, Google Calendar, Linear, Todoist, WhatsApp, Skype, Citizen, Alma, Slopes, Grab).

**Rule (Brian):** the whole form fits on one phone screen with no scrolling. It uses progressive disclosure, so people only see what is relevant at each moment.

- **Layout.** Two groups ("Missing person" and "Friend or family"), all in one row style with the label on the left and the value on the right. There is no stepper, because one screen is enough. The top bar has Cancel and the title. A sticky **Send request** button sits at the bottom. It stays disabled until at least one detail is entered.
- **Reporting from:** the first row, full width, with a pin icon and the post's full name (e.g. "FA 3 – Kinetic ▾"). It is remembered from last time. It is big because a missed or wrong post sends the friend's details to the wrong tent (Brian).
- **Missing person:**
  - **The top of the group is an ID-style card.** On the left is a portrait photo slot, which opens the camera or the library. On the right are three fields: Name (hint "Name or initials, e.g. J.D."), Age (number keypad), and Gender (Male / Female / Other). This idea came from Alma on Mobbin.
  - **Photo badges.** Once photos are added, the slot shows a count badge and a "Today" label. Tapping it switches to Not today. This replaces the separate Photos and Taken rows.
  - **Below the card:** Wearing (`clothing`) and Last seen.
- **Friend or family:** Name, Phone (phone keypad, with a ✓ once the number is valid, as in WhatsApp), Relation.
- **Shown only when relevant:**
  - The stage shortcuts (kineticFIELD, circuitGROUNDS, neonGARDEN, stereoBLOOM, "Taken to medical") appear only while Last seen is being typed.
  - **More details** is one row at the bottom. It opens Hair, Build (`height_build`), Features (`identifying_features`), Description (`physical_description`), Contact notes, and Other notes (`additional_notes`). This is the only case where the form scrolls.
- **Privacy note: removed** (Brian, 2026-11-06). It was a shortened version of Jeffrey's intake notice ("Do not enter private patient medical records…"). Tell Jeffrey in case he wants it shown somewhere else.
- **Offline.** An amber banner reads "Offline · N waiting to send" and the button becomes "Save offline". Photos wait in the queue too, which is a change from Jeffrey's app and needs IndexedDB.
- **Draft.** The form keeps its contents while open, as in Jeffrey's app, but without his explanation text.
- **All of Jeffrey's intake fields are still there.**

## New request: free text and everything open (Jeffrey, 2026-11-06 10:31)

> "when submitting a new request, make all other fields free response - for example for age, they can put mid-20s, not just numbers. And then for more details, make that after the first missing persons and show automatically, then friends and family is at the bottom - that is truly optional. Make everything show automatically, not need a click to expand."

This overrides the New request section above where they differ.

- **Every person and contact field is free text.**
  - **Age** takes any text up to 40 characters, such as "24" or "mid-20s". It is no longer a 0–120 number. Ages saved as numbers before the change read back as the same text ("24").
  - **Gender** takes any text up to 40 characters. Male, Female and Other stay as quick-fill options, and existing values keep working.
  - **Phone** stays text and is never rejected for its format. The ✓ for 10–15 digits is only a hint.
  - **Unchanged:** the reporting post keeps its fixed list plus Other, and photo timing keeps Today / Not today.
- **Order, all open, no tap to expand:** Reporting from → Missing person (photo, name or initials, age, gender, wearing, last seen) → More details (hair, height/build, identifying features, physical description, other notes) → Friend or family (name, phone, relation, contact notes), which is optional and last.
- **Supersedes:** "the whole form fits on one phone screen with no scrolling" and "More details is one row at the bottom" (the form now scrolls), Age on the number keypad, Gender as a fixed Male / Female / Other choice, and Contact notes inside More details (it moves to Friend or family).
- **Database:** `20261106000000_rework.sql` turns `patients.age` from a number into text, keeping every value, and drops the old 0–120 check. That step runs only while the column is still a number, so the file stays safe to paste again on production. Search matches the age text too ("mid-20s").

## Request profile (approved by Brian 2026-11-06) — `screens/profile.*`

- **Opens when a request is tapped.** The top bar has a close button (×), the LP number and a ⋯ menu.
- **Header.** A portrait photo with a photo-count badge, the name, age and gender, then the post and who logged it.
- **Status block.** It shows the status icon and label, and how long the request has been waiting. "In medical" also shows who checked it and when, and "[friend] heading to Main Med".
- **Details.**
  - The Missing person and Friend or family groups each have an **Edit** button, which opens the New request form already filled in. This replaces Jeffrey's save-when-you-leave-the-field editing.
  - Empty fields are hidden.
  - Phone has a **Call** button.
  - Photos show as tiles, with an Add tile until there are 3.
- **Activity.** A timeline, newest first, built from the audit events: what happened, who did it with their team, and the time.
- **Actions.** A sticky bottom bar that shows only what fits the current status:
  - Waiting for check: **Not in medical** and **In medical**.
  - In medical: **Change answer** and **Reunited**. Reunited closes the request.
  - Not in medical: **Change answer**.
  - Closed: no actions.
- **Cancel request.** Only the person who logged the request sees it, at the bottom of the profile in red. It asks once ("Cancel this request?", Keep / Cancel request) and saves the status as `Cancelled`.
- **⋯ menu.** Edit details, plus Mark discharged so `Found – Discharged` stays available. Its status is still to be confirmed with Brian and Jeffrey.
- **Kept from Jeffrey's app:**
  - The alert when someone else changed the request at the same time: a banner, then the screen reloads.
  - Every change written to `audit_events`.

## Small screens and states (draft, 2026-11-06) — `screens/states.*`

- **Avatar menu.** Name and team, a Theme setting (Light / Dark / Auto, where Auto follows the phone), Export CSV, Sign out, and "Built by Jeffrey Yu" at the bottom.
- **Reporting from picker.** A sheet listing FA 3 – Kinetic, FA 4 – Oasis, Command, Base and Other. Picking Other shows a "Where?" field below it (`other_location`). The last pick is remembered.
- **Search.** The search field replaces the header, with Cancel beside it. Results show a count, highlight the matching text, and include each status. Search covers names, descriptions, last seen and LP numbers, the same fields as Jeffrey's search.
- **Photo viewer.** Full screen on black, with "1 of 2", swipe between photos, the Today / Not today tag, who added the photo and when, and × to close.
- **Turning on alerts on iPhone.** Three icon steps: tap Share, Add to Home Screen, then open the app from there and tap the bell. This is needed because iPhone only allows web alerts for apps on the Home Screen. On other phones, the bell asks for permission straight away.
- **Empty.** An icon with "No requests yet", and the New request button.
- **Offline.**
  - The live dot turns amber and a banner reads "Offline · N waiting to send".
  - Requests saved on the phone appear at the top with a dashed status icon, "Waiting to send" and "Not sent" where the LP number would be. They get their LP number once they send.
- **Can't reach the server.** An icon, "Can't reach the log", and a Try again button.
- **Session expired.** After 12 hours the app goes back to sign-in step 2, with the name and team already filled in. No extra screen.
- **Someone else changed the request while it was open.** A banner on the profile, then the latest version loads. This is Jeffrey's conflict check.

## Loading skeletons (draft, 2026-11-06) — `screens/skeletons.*`

- **Built with Radix Themes' own `<Skeleton>`**, which shimmers in the real app.
- **The page frame appears straight away:** the header, the view switcher (only its count is a placeholder) and New request.
- **Only the data is a placeholder,** shaped like what will load:
  - All requests: list rows with a status dot, a name line, a status line and a time. The widths vary so it reads like text.
  - Pending: cards with a photo square, two text lines and two button blocks.
  - My requests: cards with a progress line of four dots.
  - Profile: a portrait, the name lines, the status block and the detail rows. The action buttons are placeholders too, because the right buttons depend on the status, which hasn't loaded yet.

## Accessibility pass (engineering, 2026-11-06; Brian to confirm against the mockups)

The spec requires 4.5:1 text contrast in both themes and 44 px tap targets. The mockup CSS misses both in a
few places, so the build differs from the mockups here:

- Secondary text (row times and meta, counts, the dashboard sub-lines, the sign-in credit line) is gray-11, not gray-10.
- Closed rows and cards dim their text to gray-11 and fade the status icon and photo, instead of fading the whole row.
- The solid In medical button (and the red confirm buttons) use step 11 of their colour: white text in light mode, dark text in dark mode.
- Amber and red badges, banners, the status block label and "Choose post" use step-12 text on their tint.
- The Pending answer buttons are 40 px tall. Every small control gets an invisible hit area of at least 44 px, so the header icons sit 14 px apart and the Last seen place chips have 20 px between rows.
- Dashboard bars for Other locations read "Other · Gate 9", so a location typed as "Base" can't look like the Base post.

## Jeffrey's answers (2026-11-06)

1. Teams are Dispatch, GCHX Base, GCHX Med Transpo and Medical.
2. ~~"Bring friend to medical" (debrief)~~. Superseded: Brian and Jeffrey agreed the only outcomes are In medical and Not in medical.
3. All is the default view, with To check and Mine as the other two filters.
4. The 10 and 20 minute thresholds are fine.
5. The app is called "Is my friend in medical?"
7. All is a plain chronological list and the default main view. To check and Mine are secondary filters, clearly tied to each role (01:03).

## Final approval

On 2026-11-06 at 01:30, Jeffrey was texted all four screens (sign-in, requests, new request, profile) for final approval, along with the Discharged question. **Building starts only after he approves.**

## v2.2 (2026-11-06 morning) — `screens/polish-v7.*`, `screens/v7-log.png`, `screens/v7-dash.png`, `screens/v7-laptop.png`

Final, decided by Brian and Jeffrey on the morning of 2026-11-06, after the app went live. The mockup is `screens/polish-v7.html`, built from `screens/requests-v6.html` (log options A, B and C) and `screens/dashboard-v2.html`, polished with the Mobbin patterns in `references/mobbin-lists-dashboards.txt`. Engineering detail is in `docs/BUILD_SPEC.md` §17 (A45–A51). These override anything above.

| # | Decision | Who and when |
|---|---|---|
| 1 | **Not in medical counts as closed** and is greyed out everywhere: a grey glyph with ×, a grey label. Only Waiting for check (blue) and In medical · friend coming (green) are open and coloured. | Jeffrey, texts 09:11–09:13 |
| 2 | **The All requests log is option B:** open requests first, and every closed request folded into one "Closed N" row. | Brian + Jeffrey picked B (of A, B and C) |
| 3 | **The request number is the leftmost column** (the "numbering"), shown as just "1013". | Jeffrey, texts 09:11–09:13 |
| 4 | **Each row shows when it was logged and when it last changed.** Logged: "11:02 PM" in the event timezone, or "Thu 11:02 PM" for an earlier day. Last changed: "now", "2m", "1h", "3d", or "—" when nothing changed since it was logged. | Jeffrey asked for both times (09:11–09:13); Brian + Jeffrey picked AM/PM |
| 5 | **The dashboard is the "global view":** status count tiles first, then Open by post, Recently updated, and Performance last (longest wait, time to answer, time to reunite, logged in the last hour). | Jeffrey, 09:13 ("more of a global view … performance metrics secondary, further down"); Jeffrey "Lgtm" on the metrics, 09:33 |
| 6 | **No Export CSV for staff.** The button leaves the avatar menu and the dashboard. Jeffrey exports from Supabase at the end of the event with `docs/export.sql`. | Brian removed the button |
| 7 | **Header declutter.** The view switcher becomes the large page title ("All requests 13 ⌄"), the alerts bell moves into the avatar menu, the live dot only appears when the app is offline or reconnecting, and "Newest first" goes. | Brian (the v6 declutter), Brian + Jeffrey final |
| 8 | **Change answer opens a small menu** with two choices: the other answer (In medical ↔ Not in medical) and **Back to Waiting for check** (status `Added`, kind `change`). Each item carries the glyph of the status it moves to, and a tap saves at once with the usual optimistic update, audit entry and Undo. Not in medical stays closed and grey but keeps Change answer. Legacy "Bring friend to medical" rows only get Not in medical, because the database has no move from it back to Waiting. | Brian + Jeffrey, 2026-11-06: "if someone accidentally sets an in medical state then it's easy to undo and also set back to pending" |
| 9 | **Undo lasts 10 s, not 6 s, on every answer:** the profile's Not in medical, In medical and Reunited buttons, the Pending cards' buttons, and both Change answer choices. | Brian + Jeffrey, 2026-11-06 (same message) |
| 10 | **Alerts depend on the device.** With the app in front, an alert is the toast with a chime, as before. With the app in the background (another tab, a minimised window), it is a **system notification** instead, on devices that allow one: desktop Chrome, Edge, Firefox and Safari, Android Chrome, and the iPhone Home Screen app. Never both for one alert, even with the app open in two tabs or windows. A Safari tab on iPhone keeps the toast and chime and is never asked. Permission is asked only from a tap: turning Alerts on, or **Allow notifications** in the avatar menu or the "Alerts are on" sheet (that row also covers "my request was answered" alerts with Alerts off). Allowed reads **System notifications on**; refused reads a quiet **Blocked in browser**, and the app never asks again. A notification shows the LP number, the status or "New request", initials and the post, never a phone number or other contact detail; clicking it opens that request. No push server: an app that is closed gets nothing. | Brian, 2026-11-06: "alerts should depend on the device — if it's desktop use regular notifications through Chrome" |

- **Supersedes:** the amber "Not in medical" and its separate "answered" group (Requests screen table above); "All is one chronological log, newest first, with no grouping" (Requests screen); the bell and live dot in the header; Export CSV in the avatar menu (Small screens and states) and on the dashboard; Change answer as a one-tap flip to the other answer (Request profile, Actions); "an Undo bar shows for a few seconds" and the 6 s Undo (Requests screen, README).
- **Unchanged:** Not in medical is still final for the liaison (no Recheck section; Back to Waiting for check is how a mistaken answer goes back in the queue), Change answer works from the profile only, and closed requests can still be opened from the Archived row (the old Closed row, renamed in the brand-card release).
- **Back to Waiting for check** keeps the request's original logged time, so the wait badge and the Pending order still count from when it was logged. The dashboard's time to answer uses the first answer only, so a correction does not change it.
- **Row 10 of this table (system notifications)** supersedes "Inside the app, an alert is a banner with a sound" (Requests screen, Alerts) for an app in the background, and the "in-app only" alerts and "no lock-screen notifications" of `BUILD_SPEC.md` §7 and the README on devices that allow notifications. It needs no server change (no Web Push): the page that sees the change shows the notification through its service worker, so it only works while the app is open. Engineering detail: `docs/BUILD_SPEC.md` §17 A52.

### v2.2, 2026-11-06 afternoon — `screens/brand-compact.*` (option A), `screens/live-indicator.*`, built as `screens/f11-*.png`

Approved by Brian at about 14:30, after real staff started at 12:30 PM ET. These override anything above.

| # | Decision | Who and when |
|---|---|---|
| 10 | **The brand card becomes one compact row** (about 56 px on a phone): Jeffrey's gradient and colours, the white EDC Orlando logo, a divider and the Ground Control logo, then "Is my friend **in medical?**" (16/700, "in medical?" cyan at weight 500) with "NOV 6–8" under it. On a wide screen it is still one row, with "NOVEMBER 6–8, 2026" beside the title. No "event operations" text, no credit line, no rings, no glow. Every text on it passes 4.5:1 against every pixel behind it, in both themes. | Brian, option A of `brand-compact.html` |
| 11 | **An X hides the row on this device** (remembered in localStorage, `lp-brand-hidden`). A hidden row is never drawn, not even for a frame after a reload. While it is hidden, the avatar menu on All requests offers **Show header**, which brings it back. | Brian |
| 12 | **The brand row is on All requests only.** Pending and My requests start at their title. All requests with a filter is still All requests, so the row stays there. | Brian |
| 13 | **The live indicator** sits under the view title on All requests, Pending and My requests, and under the dashboard title. It is a plain solid 7 px dot (no ring, halo or shadow) and one line: "Updated now" (under 2 s), "Updated 6s ago", "Updated 2m ago", counted from the last successful sync on this phone's clock and ticking at most once a second, only while it is on screen and the page is visible. **Reconnecting** (amber dot, "Reconnecting · updated 2m ago") shows when the last successful sync is more than 30 s old (visible time only), when the log can't be reached, or when requests fail while the phone reports a connection. **Offline** (grey dot, "Offline · updated 5m ago") shows when the phone reports no connection. Before the first sync it shows nothing but keeps its line, so nothing moves. Screen readers get the line as one sentence ("List updated 6 seconds ago"), and a polite live region announces only state changes ("List is live", "Reconnecting", "Offline"). | Brian, `live-indicator.html` |
| 14 | **No status dot has a halo ring.** The current step of the My requests progress line is a plain filled dot now. | Brian ("reads AI written") |

- **Supersedes:** the tall brand card over All, Pending and My requests (Jeffrey, 10:31), its "Event operations · November 6–8, 2026" kicker, its orbit rings and its "Built by Jeffrey & Brian for Ground Control / Headliner Experience" credit line ("Built by Jeffrey Yu" stays in the avatar menu); "the live dot only appears when the app is offline or reconnecting" (item 7); the dashboard's Offline / Retrying chip, which the dashboard's live line replaces (it counts from the last stats fetch, every 15 s, and reads Reconnecting while a fetch fails).
- **Unchanged:** the offline / "Can't reach the log" banners and the offline badge on the avatar.
- **Differs from the mockup:** the line's text is gray-11, not gray-10, for 4.5:1 in both themes (the accessibility pass above). When requests fail while the phone still reports a connection, the line says Reconnecting and the existing banner still says "Offline · N waiting to send". Brian should confirm that pairing. (Resolved by item 15: both now say Reconnecting.)

### v2.2 afternoon (F1.2, 2026-11-06 about 16:20–16:35) — the Apple Mail model, built as `screens/f12-*.png`

Brian found the line's ticking seconds ("Updated 6s ago", "7s ago", …) distracting, and chose the Apple Mail model: the line says how fresh the data is in minutes, and problems become a banner. Client only: no migration, no new environment variable. These override item 13 above.

| # | Decision | Who and when |
|---|---|---|
| 15 | **Healthy, the line counts minutes, never seconds:** a plain green dot and "Updated just now" while the last successful sync is under 60 s old, then "Updated 1 min ago", "Updated 5 min ago", "Updated 1 hr ago" (gray-11). It renders at most once a minute: it wakes on the minute boundaries since the last sync (and at the moment it would turn stale), never once a second. While syncs land every 6 s it never changes at all. **Problems are a banner**, the existing one at the top of the view: **Reconnecting…** (amber) when syncs fail or nothing has landed for more than 30 s of visible time while the phone reports a connection, with no countdown; **Offline · N waiting to send** (gray, was amber) when the phone reports no connection. "Can't reach the log · Try again" (red) is gone: it is Reconnecting now. While a banner shows, the line shows the fixed clock time of the last good sync, "Last updated 3:42 PM" (event timezone, AM/PM), with an amber or gray dot matching the banner. **One state for everything:** the line, the banner, the avatar badge (gray cloud offline, amber arrow reconnecting, no longer turning) and the screen-reader live region all read one derivation (`lib/client/live-status.ts`), so the F1.1 pairing above (Reconnecting line under an Offline banner) can't happen. The dashboard header follows the same rules from its last stats fetch, and shows the same banner under its header. | Brian, 2026-11-06 16:2x (found the ticking seconds distracting; chose the Apple Mail model) |
| 16 | **Refresh now:** a small refresh-cw icon button right after the line (32 px, 44 px tap target, named "Refresh now") on All requests, Pending, My requests and the dashboard. On a list it forces one immediate sync through the store's `syncNow()` (it replaces the poll that was due, so exactly one request goes out); on the dashboard it fetches the stats at once. While that request is in flight the arrow turns (it finishes the turn it is in, so it never snaps back), and with reduced motion it only dims; repeat taps are ignored meanwhile. Success brings back "Updated just now"; a failure shows the way any failed sync does (the banner rules), with no toast. It never reloads the page. | Brian, 2026-11-06 16:3x |
| 17 | **Screen readers hear only changes of state:** "Reconnecting", "Offline", "Back online", from one polite live region beside the banner (the banner itself is no longer a live region, so a new waiting count is never read out). The line is one full sentence: "List updated just now.", "Reconnecting. List last updated at 3:42 PM." | Brian, 2026-11-06 16:3x |

- **Why:** Brian found the ticking seconds distracting. A number that changes every second pulls the eye to the line that matters least while everything is fine; minutes are precise enough to trust the list, and a banner puts a real problem in one place, in words, only while it lasts.
- **Supersedes:** item 13's "Updated now / 6s ago / 2m ago" ticking at most once a second, "Reconnecting · updated 2m ago" and "Offline · updated 5m ago" on the line, and its "List is live" announcement; the amber Offline banner and the red "Can't reach the log · Try again" banner (item 13's "Unchanged" line); the turning arrow on the avatar badge.
- **Layout:** the line's row is the button's 32 px tall and starts where the title's box ends, so the title's 44 px tap area now reaches up from the title instead of down, and Refresh now's tap area reaches down into the space under the line; no two tap areas overlap (a11y spec). The line sits about 6 px lower than in F1.1.
- **Unchanged:** the form's own banners ("Offline · N waiting to send" and "Needs a connection" on New request and Edit), and the empty "Can't reach the log · Try again" state when nothing has ever loaded.

## Pending v8 and where medical has them (approved by Brian 2026-11-06 14:2x; Dani's request) — `screens/pending-v8.*`

Dani, 14:12: "once med staff check a request … input what bed or beach chair number the patient is in". Brian: just an optional free-text location, and Pending "shows so much clutter … they need the information nicely". The mockup is `screens/pending-v8.html` with its renders `pending-v8-1.png` … `pending-v8-5.png`; the build is in `w2-pending-*.png`. These override anything above.

- **Brand card on All requests only.** Pending and My requests open with just their large title.
- **Pending on a phone: one list at a time.** Under the title, a segmented control **To check N | Friend coming N**. To check is the default; the last tab is remembered on the device (`localStorage` `lp-pending-tab`, best effort). Arrow keys move between the two tabs.
- **To check card.** The photo only when there is one (no empty placeholder), the name or initials (18/600) with age and sex, the minutes it has waited on the right with a clock (amber from 10, red from 20), what they're wearing (two lines at most), one quiet line "FA 4 · LP-0010", then **Not in medical** and **In medical** at 44 px.
- **Friend coming card.** The photo when there is one, the name with age and sex, the minutes since the In medical answer, where medical has them (a green chip with a pin, or a quiet **+ Location** chip; either one edits it), "Chris P. · boyfriend, on the way" (no coloured arrow line, no post), then a full-width **Reunited**.
- **In medical, then where.** The tap saves at once (the usual optimistic update, audit entry and 10 s Undo), then a bottom sheet asks "B.W. is in medical" with one free-text field (focused, the normal keyboard, placeholder "Bed or chair") and **Skip / Save**. Skip, a tap on the scrim, Esc or a swipe down closes it with nothing more saved. If the answer itself fails (someone else answered first), the sheet closes. Saving the location keeps the answer's Undo usable, and an Undo back to Waiting keeps the location.
- **The location.** `patients.medical_location`, nullable text, trimmed, at most 60 characters. It is set with `PATCH /api/requests/:id {patch: {medicalLocation}}` (`lp_update_fields`, audited like any edit: "Edited Location"), never on create, and **kept until someone edits it**: no status change clears it. It is `medicalLocation` in the summary, the detail and sync, and search matches it ("chair 14"). Rows cached on a phone before it existed simply have none.
- **The request's status block.** In medical shows "In medical · friend coming", then only who answered and when ("Rae Chen · 1:52 PM"). **The "[friend] heading to Main Med" line is gone everywhere** (Brian). Under it, the location row: a pin, the location (18/650) and a pencil, or "+ Location" when there is none; the whole row edits it. Waiting, Not in medical and the closed states are unchanged (no location row).
- **My requests.** The same cleanup: no empty photo placeholders (queued cards too). Everything else stays.
- **Desk and tablet (from 768 px).** Pending is a two-column board in the main column, To check | Friend coming, with the same cards; J / K walk To check, then Friend coming. When the main column is under 700 px (a request docked beside it at 1024–1279) the board stacks into the phone's tabs; iPad portrait (708 px of main column) keeps both columns. The location sheet becomes a small popover: under the card that was tapped (it stays there while that card moves on to Friend coming), or under the location chip or row that opened it. Keyboard shortcuts are off while it is open.
- **Offline.** The location needs a connection like every other edit: the chip and row look disabled and say so when tapped; the sheet's Save waits.
- **Production order: migration first, then deploy.** The rework file adds the column (`add column if not exists`, step 1c) and recreates `lp_row`, `lp_clean_fields`, `lp_create_request` and `lp_update_fields`. The build that is live now keeps working on the migrated database (it never sends the field, and its server maps `lp_row` through an allowlist); this build's location save needs the new functions. A second paste keeps every saved location.
- **Built differently from the mockup (contrast, spec §7):** the cards are the solid panel colour (white in light, gray-2 in dark, the mockup's gray-a2 over the page) so the amber and red minutes keep 4.5:1, and the quiet line and the tab counts are gray-11, not gray-10.
- **Supersedes:** the brand card over Pending and My requests (brand-card release); Friend coming as a section on top of To check, with "friend · from FA 3 · 4m" (Requests screen); "[friend] heading to Main Med" in the status block (Request profile); the Pending answer buttons at 40 px with a 44 px hit area (Accessibility pass: they are 44 px now); the Pending skeleton's photo square (Loading skeletons).
