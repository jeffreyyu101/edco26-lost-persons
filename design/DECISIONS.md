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
| 10 | **Alerts depend on the device.** With the app in front, an alert is the toast with a chime, as before. With the app in the background (another tab, a minimised window), it is a **system notification** instead, on devices that allow one: desktop Chrome, Edge, Firefox and Safari, Android Chrome, and the iPhone Home Screen app. Never both for one alert. A Safari tab on iPhone keeps the toast and chime and is never asked. Permission is asked only from a tap: turning Alerts on, or **Allow notifications** in the avatar menu or the "Alerts are on" sheet (that row also covers "my request was answered" alerts with Alerts off). Allowed reads **System notifications on**; refused reads a quiet **Blocked in browser**, and the app never asks again. A notification shows the LP number, the status or "New request", initials and the post, never a phone number or other contact detail; clicking it opens that request. No push server: an app that is closed gets nothing. | Brian, 2026-11-06: "alerts should depend on the device — if it's desktop use regular notifications through Chrome" |

- **Supersedes:** the amber "Not in medical" and its separate "answered" group (Requests screen table above); "All is one chronological log, newest first, with no grouping" (Requests screen); the bell and live dot in the header; Export CSV in the avatar menu (Small screens and states) and on the dashboard; Change answer as a one-tap flip to the other answer (Request profile, Actions); "an Undo bar shows for a few seconds" and the 6 s Undo (Requests screen, README).
- **Unchanged:** Not in medical is still final for the liaison (no Recheck section; Back to Waiting for check is how a mistaken answer goes back in the queue), Change answer works from the profile only, and closed requests can still be opened from the Closed row.
- **Back to Waiting for check** keeps the request's original logged time, so the wait badge and the Pending order still count from when it was logged. The dashboard's time to answer uses the first answer only, so a correction does not change it.
- **Row 10 (system notifications)** supersedes "Inside the app, an alert is a banner with a sound" (Requests screen, Alerts) for an app in the background, and the "in-app only" alerts and "no lock-screen notifications" of `BUILD_SPEC.md` §7 and the README on devices that allow notifications. It needs no server change (no Web Push): the page that sees the change shows the notification through its service worker, so it only works while the app is open. Engineering detail: `docs/BUILD_SPEC.md` §17 A52.
