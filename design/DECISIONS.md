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
- **Row 10 (system notifications)** supersedes "Inside the app, an alert is a banner with a sound" (Requests screen, Alerts) for an app in the background, and the "in-app only" alerts and "no lock-screen notifications" of `BUILD_SPEC.md` §7 and the README on devices that allow notifications. It needs no server change (no Web Push): the page that sees the change shows the notification through its service worker, so it only works while the app is open. Engineering detail: `docs/BUILD_SPEC.md` §17 A52.

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

## F4 · Lock-screen alerts (Web Push), the Alerts sheet and the Activity inbox (2026-11-06 evening) — `screens/f34-states.html`, `screens/alerts-banner.html`

Brian, 2026-11-06 ~17:00–18:15: alerts must reach a phone that is locked or a laptop with the app closed, a reminder must stay up until they work on that device, and a bell must show "everything relevant to me so nothing is missed". The approved renders are `f34-v2-1..4`, `7`, `8`, `9` and `alerts-banner-1..5`; the build is in `f4-*.png`. Engineering detail is in `docs/BUILD_SPEC.md` §18 (A53–A59). These override anything above.

| # | Decision | Why / who |
|---|---|---|
| 1 | **Web Push for the lock screen.** A notification's title is the request's initials ("J.D."), or "New request" for a new one; its body is the same line the Activity row shows ("In medical · Chair 9", "Rae C.: Bring 1 person only"). Never a full name, an LP number, a phone number or contact details. One notification per request on the lock screen (tag `lp-<id>`): a later event replaces it; a message sounds again. | Brief; f34-v2-8 |
| 2 | **Never both.** While the app is visible and focused on a device, a push shows nothing there and the app syncs at once (its toast and bell carry the event). With the app hidden or closed, the push is the only alert: the page's own system notification (v2.2 row 10) stands down on a device with push. Without push on a device, the page's system notifications work as before. On Safari and every iPhone browser (WebKit), a push that shows nothing three times costs the subscription, so there the notification is shown silently and taken away at once. | Brief; WebKit's rule, see BUILD_SPEC A54 |
| 3 | **Two switches, server-side, in the Alerts sheet:** "New requests" and "Updates on my requests". They belong to the staff member, so every device they sign in on follows. "New requests" is the same switch as the old in-app Alerts bell (it also turns the in-app new-request toast on and off). It starts as this phone's old bell was (off unless it was on); "Updates on my requests" starts on. | Brief (f34-v2-7). Default: engineering, the safe choice — nobody starts getting new-request alerts they did not ask for |
| 4 | **The switches decide pushes; Activity always fills in.** An update about a request you are involved in always lands in Activity, whatever the switch; it is pushed only with "Updates on my requests" on. A new request lands in Activity (and is pushed) only for staff with "New requests" on. With "Updates on my requests" off, the toast in the app still shows. | Engineering: the inbox is "everything relevant to me" |
| 5 | **Alerts in the avatar menu opens the Alerts sheet** (it was an On / Off toggle with an "Alerts are on" intro). It reads On, Off or Blocked for this device. The desk sidebar's and rail's Alerts open the same sheet. Where a device has no Web Push but the page can notify while open, "Allow notifications" stays in the menu and the sheet. | Brief: "avatar menu / sidebar" |
| 6 | **The alerts banner** sits above the title on All, Pending and My requests (it scrolls away with the page), until alerts work on that device; it cannot be dismissed. Off: "Alerts are off" + Turn on (asks from that tap; the Alerts sheet opens once it works). iPhone or iPad Safari tab: "Get alerts on your lock screen" + the taps to the Home Screen app. Refused: "Alerts are blocked" + this device's exact path (+ a re-check button on a computer). No Web Push on the device: nothing. | Brief; alerts-banner-1..5 |
| 7 | **The step chips follow the vendors' current help pages, not the mockup where they differ.** iPhone, iOS 27: Menu → Share → Add to Home Screen → Open as Web App; iOS 26: More (⋯) → Share → …; iOS 17/18: Share → Add to Home Screen (iPad: 27 Share → View More → …, 26 Share → More → …). A Home Screen app that was refused: Settings → Notifications → Is my friend in medical? → Allow Notifications — Apple's own page gives this path for iOS 17, 18, 26 and 27 (the brief expected Settings → Apps → … for 18+). Android Chrome: More (⋮) → Site controls → Permissions → Notifications → Allow, Google's current page (the mockup's "Site icon" is the older path); an installed Android app: Settings → Notifications → App notifications → the app. Desktop Chrome: Icon left of the address → Notifications → On; Edge: View site information → Permissions for this site → Notifications → Allow; Safari on a Mac: Safari → Settings → Websites → Notifications → Allow; Firefox: Permissions icon (in the address bar) → Send Notifications → Clear (×) — Firefox clears a block rather than switching it to Allow, so Check again then shows Turn on, which asks. Only Compact-layout taps are shown on iOS (the default); with the Bottom / Top layout, Share is on the toolbar. | Brief ("chips MUST match the current UI"); sources in HANDOFF.md |
| 8 | **The Activity inbox:** a bell next to search on every main view (and in the desk top bar, plus an Activity item in the sidebar and rail) with a monochrome count (hidden at 0, 1–9, "9+"). One row per request, its latest event, newest first: a bare outline glyph, the initials, the detail, the time ("now", "2m", "1h", then "4:12 PM"). Unread is a dot and a semibold first line. Opening the request from anywhere (Activity, a list, a link, a notification) marks it read; opening the sheet does not. Mark all read gives "N marked read · Undo" for 5 s. The last 3 days, at most 100 rows. A phone gets a full-height sheet, the desk a 380 px popover. The app icon badge is the unread count. | Brief; f34-v2-1..4, 9; references/mobbin-activity-inbox.txt |
| 9 | **The first location while In medical completes the answer:** "In medical · Chair 9" (it replaces the row and the lock-screen notification), not a separate move. A later change is "Chair 9 → Bed 3". | Engineering, matches f34-v2-2 |
| 10 | **Urgent pushes:** new requests, answers (In medical, Not in medical, Back to Waiting for check) and messages are sent as high urgency and kept an hour if the phone is unreachable; the rest normal, 15 minutes (Activity keeps everything). | Brief; times: engineering |
| 11 | **"Send a test alert"** pushes "Is my friend in medical?" / "Test alert" to this device only. | Brief |
| 12 | **No LP number in any notification.** The page's own system notification (a device without push, v2.2 row 10) reads like the push: the initials and the status ("S.L. · In medical"), or "New request"; then the post. Three or more at once list initials, not LP numbers. The in-app toasts keep their wording. | Brief (UI rules: no request ids in notifications) |
| 13 | **A new request's Activity row reads "T.R." / "New request · 24 M · FA 4"** (f34-v2-2), not the initials twice. The stored detail and the push body stay contract B ("New request" / "T.R. · 24 M · FA 4" on the lock screen). | f34-v2-2; engineering (contract B is the push's wording) |
| 14 | **On a phone 400 px wide or less, the list title and its count are 24 px (28 px above).** Search, the bell and the avatar sit beside it; at 28 px "All requests 758" would be cut to "All requ…". | Brief: nothing is cut off |
| 15 | **A sign-out takes this device's lock-screen alerts away only once it has really happened.** The server forgets the device first (while the session can still say whose it is); the phone drops its subscription only after the sign-out is confirmed. A sign-out that fails (offline at the festival, a server error) leaves the session and the alerts exactly as they were; if the server had already forgotten the device, it is told again. A sign-out that finishes when the app is opened again (it was closed half way) drops the subscription too. | Review (F4 fixes); brief: lifecycle |
| 16 | **"Send a test alert" always shows the notification, with the app open.** It is only ever tapped inside the app, so it is the one push that never stands down for the toast. | Review (F4 fixes); HANDOFF morning checklist |
| 17 | **"In front" is the app's own rule, everywhere.** The push asks the open app whether it is in front (visible, and on a computer focused: the rule the app already uses for its toasts), so an iPad in split view, Android multi-window or a pulled-down notification shade never gets a toast and a notification. With the app in front, an event the app would not toast by itself (a location change "Chair 9 → Bed 3", the location that completes an answer, an edit, an answer on a request someone else logged) shows as an in-app toast with the push's own two lines (initials, then the line) and View. Never both: no such toast when the app's own alert toast for that request came first. | Review (F4 fixes); brief: "Page visible → in-app toast only" |
| 18 | **"New requests" is never lost to whichever device came first.** Until the staff member sets "New requests" in the Alerts sheet, any of their devices whose old in-app bell was on turns it on for all of them (a desk computer with the bell off can no longer switch a phone's new-request alerts off). Once they set it in the sheet, their choice stays. Updates row 3 ("It starts as this phone's old bell was"). | Review (F4 fixes); engineering: losing alerts is worse than an extra one, and the sheet turns it off |
| 19 | **iPhone / iPad Home Screen taps end with "Add".** On iOS / iPadOS 26 and later "Open as Web App" is already on when Add to Home Screen opens; a chip for it made people switch it off and add a Safari bookmark, which never gets push. The chips are Menu (27) or More (26) → Share → Add to Home Screen → Add (iPad: Share → View More / More → Add to Home Screen → Add); iOS 17 / 18 Share → Add to Home Screen → Add. VoiceOver hears "…then Add to Home Screen, then keep Open as Web App on, then Add." Replaces the end of row 7's iPhone and iPad paths. | Review (F4 fixes); Apple "Turn a website into an app in Safari on iPhone" ("Turn on Open as Web App", "Tap Add"); WebKit "Features in Safari 26.0" (on by default) |
| 20 | **Where a phone lists the app by its Home Screen name, the chip says "In medical?".** iPhone / iPad Settings → Notifications and Android's App notifications list the installed app under the manifest's short name, so the blocked path is Settings → Notifications → In medical? → Allow Notifications. The Home Screen name stays "In medical?" (the full name does not fit under an icon); the Mac's Dock app keeps "Is my friend in medical?". | Review (F4 fixes); brief's app name kept everywhere else (notification titles, the test alert) |
| 21 | **The Alerts sheet says "Lock screen + sound" only on a phone or an iPad.** On a computer it reads "On for this computer" alone. | Review (F4 fixes); UI rules: labels and values only |
| 22 | **"N marked read · Undo" sits at the bottom of the Activity sheet** (as f34-v2-3), not under the last row. | f34-v2-3 |
| 23 | **The app's own notification stands down only for what the push will carry.** A device with push still gets the app's own system notification (app in the background, still alive) for a Not in medical answer (pushed by the Not found yet release, not this one) and for any update while "Updates on my requests" is off. Narrows row 2. | Review (F4 fixes); brief: "with the relevant switch on" |

- **Built differently from the mockups (contrast, spec §7):** text the mockups draw in gray-10 (the Activity time, read rows' second line, step separators) is gray-11; the Turn on button is step 11 of blue (`lp-solid-accent`). The phone's Activity sheet has no ✕ (as in f34-v2-2): its grabber is the close button ("Close Activity", so VoiceOver and Switch Control can leave it), and Escape and the strip of scrim above it close it too. "Mark all read" keeps its tooltip, drawn in CSS (Radix Tooltip would have grown the first load, spec A25). The walking figure is the mockup's own outline (lucide has none).
- **Supersedes:** the Alerts On / Off switch in the avatar menu and the desk sidebar and rail, and the "Alerts are on" sheet it opened (Small screens and states; v2.2 row 10's "Allow notifications" stays only where Web Push is not available); "There is no push: a closed app gets nothing" (v2.2 row 10, README); "A notification shows the LP number" (v2.2 row 10; row 12 above).
- **Not in this release (owned by the Messages and Not found yet releases):** messages, en route and the Not in medical / Not found yet notifications. Their events use the same inbox, the same notifications and the same switches once they are merged. Until the Not found yet release is in, a Not in medical answer reaches front of house as the in-app toast, or the app's own system notification while it is in the background (row 23), not as a push. When that release is merged, `PUSHED_ALERT_KINDS` in `lib/client/push-client.ts` gains `not_in_medical` (HANDOFF, F4 integrator notes), or a device with push would get both.
