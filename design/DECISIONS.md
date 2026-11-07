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

### v2.2 #10 — Photos of a phone screen (Jeffrey, 2026-11-06 15:13) — `screens/photo-crop-*.png`

Staff will often photograph the friend's or family member's **phone screen** showing a picture of the missing person. Jeffrey: *"it'll be blurry/not great quality but that's fine. If you can clean up the photo … when uploading without introducing connectivity issues or run into usage limits with Supabase and Vercel that would be great."* Engineering detail is in `docs/BUILD_SPEC.md` §17 A53.

| # | Decision | Who and when |
|---|---|---|
| 10a | **Cleanup happens on the phone, before upload.** No extra request, no server or Supabase work, nothing new on Vercel. The upload is never bigger than the app made it before this change: the phone also makes the photo the old way and sends the cleaned one only if it is no bigger (at quality 0.82, else 0.76, else 0.72), else the plain area-averaged one if no bigger, else the old one. | Jeffrey's ask; Brian, 2026-11-06 |
| 10b | **Every photo gets the same conservative cleanup, only where it measures a need:** an area-averaged downscale (softens the screen's pixel grid instead of turning it into moiré), auto levels (0.5 % clipped at each end, at most 1.5×, no skin channel pushed past 248), and a light unsharp mask on brightness, only for a soft photo. A sharp, well-exposed camera photo is left as it was. If cleanup fails or takes over 1 s, the plain photo is used. | Brian, 2026-11-06 |
| 10c | **A quick crop step after every photo is taken or picked** (New request, and Add photo on a profile). The whole photo is selected, so one tap on **Use photo** keeps it as it was. Drag a corner (44 px targets) or draw a rectangle to cut away the bezel and the scene around the phone; **Retake** drops it and opens the camera again. No pinch, no rotate, no helper text: the dimmed area and the corner brackets show what is kept. Keyboard: Tab to a corner, arrows move it, Enter uses the photo, Escape keeps the whole photo. A tap on the scrim does nothing, so a photo is never added by accident. | Brian, 2026-11-06 |

- **Unchanged:** EXIF and GPS are still stripped by re-encoding (and now the small Exif block Safari's own encoder adds is dropped too, so no upload carries any), orientation still comes from the photo, the full image is still at most 1600 px and 2.5 MB (well under Vercel's 4.5 MB body cap; the server still refuses over 3.9 MB), the thumbnail is still 320 px, new requests still queue offline with their photos, and three photos is still the limit.
- **Not done:** straightening a photo taken at an angle (perspective), and removing moiré bands the camera already recorded (only the fine grid texture is averaged away). Both need much heavier processing.

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
- **The dashboard uses the lists' thresholds (review fix):** a failed stats fetch counts toward Reconnecting only after 2 network failures or timeouts, or 3 server errors, in a row (the store's own counts, `CONNECTION_FAILURES`), and the lists' syncs count as landing for the 30 s rule, so one missed 15 s poll (a 503, or a request that hits the 12 s timeout) shows no banner. When the connection comes back after a failed stats fetch, the stats go out at once, so the dashboard's banner leaves with the lists' instead of up to 15 s later, and screen readers hear the same changes as on the lists.

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

## F2 release (assembled 2026-11-06 evening) — `screens/f2-*.png`

The F2 release puts together wave 2 (the desk and tablet layout, Pending v8 and where medical has them), system notifications (v2.2 row 10), F1.2's live line (items 15–17) on top of F1.1 (items 10–14, live since the afternoon), and photo cleanup (v2.2 #10). Where they met, these decisions were made. They override anything above.

| # | Decision | Who and when |
|---|---|---|
| 18 | **"Not in medical" is renamed "Not found in medical"** everywhere the status shows: the log, the desk table, the profile's status block, the audit trail's "from → to", My requests' progress line, the Undo bar, toasts and system notifications ("LP-1004 · S.L. — not found in medical"), the dashboard tile and its filter chip, row sentences for screen readers, and the end-of-event export's status label. **The answer button reads "Not found"** (the Pending cards, the profile, and the Change answer menu's choice), beside "In medical". The database value stays `Checked – Not Found`. On a phone under 400 px wide the log's status cell reads "Not found" (known, deferred to the next release: beside an earlier day's time the full label is cut at 400–427 px) (the grey × says the rest), as "Waiting for check" reads "Waiting" there; the row's sentence always says the whole status. | Brian, 2026-11-06 18:00 |
| 19 | **The desk's brand row is the phone's compact row** (item 10's wide layout: logos, "Is my friend in medical?", "NOVEMBER 6–8, 2026" beside it, the X), at the top of All requests' main column above the top bar (wave 2's place), lined up with the top bar's title; it scrolls away and the bar stays. With a request docked beside a narrow list (1024–1279), the dates go back under the title, short, so the title keeps its one line. **The same X and Show header** as the phone (item 11): the X hides it on this device, and the account menu in the sidebar or rail offers **Show header** on All requests while it is hidden. A hidden row is never drawn, not even before the page is interactive. | `screens/live-indicator.html` Desktop frame; items 10–12 |
| 20 | **On the desk the live line sits in the top bar, right after the title and count** ("All requests 12 · ● Updated just now ⟳"), on every view: All requests, Pending, My requests, Search, and the dashboard (from its last stats fetch). The Reconnecting / Offline banner stays at the top of the main column, and the lockup's corner dot in the sidebar or rail shows the same state (green, amber reconnecting, grey offline). There is no other live line on the desk. | `screens/live-indicator.html` Desktop frame; items 15–17 |

- **Supersedes:** "Not in medical" as a label and as the answer button (Requests screen, Request profile, v2.2 rows 1 and 8, Pending v8); wave 2's tall brand card on the desk with its kicker, credit line and rings (already superseded on the phone by item 10); the desk top bar's Offline / Retrying chip on the dashboard (item 13 had removed it on the phone).
- **Unchanged:** what Not found in medical means and does (closed, grey, Change answer only, never in Pending), the database values, and every behaviour of items 10–17 on a phone.
- **Numbering.** Three branches each continued the decision numbers from 9: system notifications (row 10 of the v2.2 morning table), the brand row and live line (items 10–17), and photos (10a–10c). They are told apart by their section; the numbers here continue from 17. In `docs/BUILD_SPEC.md` system notifications are A52 and photos A53.

## Pending order hotfix (Brian, 2026-11-06 19:40)

- **Waiting for check comes first on Pending, then Friend coming.** Waiting for check is the priority. This supersedes "Friend coming section at the top of To check" (Friend coming, above). Both sections stay oldest first. The F2 release keeps the same priority: To check is the default tab on the phone and the left column on the desk (the F2 Pending view supersedes the hotfix's stacked order).

## Status stages and the "Not found yet" hold (F5; approved by Brian 2026-11-06 evening) — `screens/updates.html#clarify`, `#recheck`, `#colors`

The mockups are `updates.html` (#clarify: messages before found and the derived stages, `clarify-1…8.png`; #recheck: the Not found yet hold, `recheck-1…6.png`; #colors: colour = meaning, `colors-1…6.png`, Not found yet = option A, violet). The build is in `screens/f5-*.png`. Engineering detail: `docs/BUILD_SPEC.md` §19 A59–A62 (A53–A56 on `feat/stages`, renumbered when merged onto F2 and again onto the F2 release). F2's rename (item 18) has landed: below, "Not in medical" is the final status that now reads "Not found in medical", and the answer button reads "Not found". These override anything above.

- **A stage is what a request shows; its status is what is stored.** The stored statuses and their transitions are unchanged (one exception: what the first Not found stores, below). Each surface shows the stage (`lib/stages.ts` `displayStage`, one `STAGE_META` map):

  | Stage | When | Colour and glyph | Under it / after it on the desk |
  |---|---|---|---|
  | Waiting for check | Waiting, nothing else | blue ring | minutes waiting: "9m" |
  | Needs info | Waiting, and medical asked (F3's `needsInfo`) | amber ring with "?" | "Rae C. asked · 4:20 PM"; on hold, the desk adds "⟳ 4:40 PM" |
  | Not found yet | Waiting, on hold (`recheckAt`) | violet hourglass | "Recheck 4:40 PM" / "· 4:40 PM" |
  | In medical | In medical | green ring with ¾ pie | where: "Bed 3" |
  | Friend en route | In medical, someone en route (F3) | teal walking figure | "~4 min" |
  | Friend arrived | In medical, arrived (F3) | green check (not filled) | — |
  | Not in medical, Reunited, Discharged, Cancelled | closed | grey, as before | Not in medical after a hold: "2 checks" |

  Needs info beats Not found yet for the label, but a request on hold keeps its recheck time everywhere while medical asks (the request's "⟳ Recheck 4:40 PM" row, the My requests outline chip, "Needs info ⟳ 4:40 PM" on the desk; review fix 2026-11-06). Status stages take their labels from `STATUS_META`, so the coming rename ("Not found in medical") flows through; the new stages' words are in `STAGE_META`. Colour = meaning: blue medical is looking, amber front of house's turn, violet on hold, green found, teal on the move, grey closed.
- **The first Not found holds; the second is final (Brian 18:05).** On a request Waiting for check that was never held, Not found keeps it open: the status stays Waiting for check (`Added`), `recheck_at` = now + 20 minutes and `not_found_checks` = 1, with one audit entry (Not found, held). It shows as Not found yet with its recheck time everywhere. A Not found on a held request, due or not, is the real, closed Not in medical (2 checks). **A due hold never closes by itself**: it waits on top of To check until someone answers. In medical at any time clears the recheck time. Back to Waiting for check (and Reopen) clears both. Undo puts back exactly what the undone tap replaced: the first Not found's Undo clears the hold; the final one's Undo, or In medical's on a held request, puts the hold back. 20 minutes is one constant shared by the app and the database.
- **Pending > To check (recheck-2.png).** Due rechecks first, as full cards with a blue "Recheck" chip (rotate glyph) where the minutes would be and "FA 4 · not found 4:02" as their quiet line; then the normal queue; then "Later N" (hourglass) over one compact row per held request, earliest recheck first: initials, age and sex, ⟳ and the recheck time; a row opens the request. To check, and Pending's count, are due + queue: Later is not counted. A held card moves to the top on time, on the phone's clock, with no refetch. The answer buttons are labelled by their actions (today "Not in medical", "Not found" after the rename). The first Not found's Undo bar reads "Not in medical · recheck 4:40" (the action's label, so "Not found · recheck 4:40" after the rename).
- **The request.** The status block takes the stage's tint (violet-a3 Not found yet, amber-a3 Needs info, blue-a3 Waiting, green-a3 In medical), its glyph, its label and one line under it (who answered or asked, and when). A held request adds a "⟳ Recheck 4:40 PM" row. For the **medical side** (Medical team), the two answers sit inside the block while the request is Waiting for check, held or not (clarify-7, recheck-3), and not again at the foot. **Front of house keeps them in the bar at the foot as before** (no roles: anyone may still answer); open question for Brian, see below.
- **My requests (colors-3.png).** Top right of a card: a violet "Not found yet" or amber "Needs info" chip; under the name, an outlined violet "⟳ Recheck 4:40 PM" while held (under a Needs info chip too). Every other stage keeps the card as it was, with the stage's glyph and label.
- **All requests and the desk.** The phone log's status cell shows the stage's glyph and label on one line (clarify-2, colors-2); under 400 px Waiting for check reads "Waiting" and Not in medical reads the label of the answer that gave it (the same words today, "Not found" once the rename makes the status "Not found in medical"), so the long label never gets cut on a small phone. The desk table's status cell adds what follows it ("Waiting for check · 9m", "Not found yet · 4:40 PM", "In medical · Bed 3", "Friend en route · ~4 min", "Not in medical · 2 checks", "Needs info ⟳ 4:40 PM"); there is no separate en route column, and the status column is wide enough for the longest of them, "Not found in medical · 2 checks" or "Not found yet · 11:40 PM" (colors-6). **With a request open beside the list** (the desk's usual state) the status column keeps that full width ahead of the Friend column whenever the window allows (from 1080 px, and from 1304 px with the full sidebar); only on the narrowest windows does what follows the label take a short form instead of being cut: "· 11:40" for "· 11:40 PM", and a closed row's "· 2 checks" drops out (review fix 2026-11-06).
- **Dashboard.** A held request is open and Waiting for check (Open and Waiting tiles), never Not in medical: the Not in medical tile counts final answers only. Its first Not found is its first answer (time to answer). A hold that is not due is not the longest wait.
- **Told (contract D).** Both Not found answers notify everyone involved in the request (push and Activity, F4's): "Not found yet · recheck 4:40 PM", then the final status's label. Until F4's push lands, a phone with the app open alerts for its own request in the contract's words, with no LP number (recheck-6.png): "K.T." over "Not found yet · recheck 4:40 PM", as the toast and as the system notification. The alert goes away when the hold is undone, and an Undo that puts the hold back alerts "Not found yet" again, never "waiting for check" (review fix 2026-11-06).
- **Old phones and the build that is live now.** They call the same Not found and get the hold: the request comes back Waiting for check and stays in their queue, so a second Not found (later, or by someone on a new phone) closes it. Their Undo of that first Not found clears the hold.
- **Open questions for Brian.** (1) Should front of house still see the answer buttons on a Waiting request (today: yes, in the bar at the foot)? (2) The My requests progress line still shows "Checked" as pending while held; a violet "Checked" step could say "checked once".

## Pending v9.1, Brian 2026-11-06 19:35–20:40 (all approved) — `screens/pending-v9.html` (frames `pending-v9-1…9.png`), `#buttons` (`pending-v9-buttons-1…4.png`), `close-opt-a.png`

The approved mockup is `pending-v9.html` (its top comment is the spec; the v9.1 note at its head wins over the older v9 notes); the Mobbin notes are `references/mobbin-pending-sort.txt` (where they conflict, the HTML and Brian's brief win). The build is in `screens/v9-*.png`. Engineering detail: `docs/BUILD_SPEC.md` §20 A64–A68 (A57–A61 on `feat/pending-v9`, renumbered on the F5 release). **These override anything above: they supersede F5's Later lane and its Recheck-on-top ordering ("Pending > To check", the "Later N" rows, the due-first order, the blue "Recheck" chip, "FA 4 · not found 4:02", the outline "Recheck 4:40 PM" chip on My requests, "Not found yet · 4:40 PM" on the desk), Pending v8's To check | Friend coming tabs (the phone's SegmentedControl, the board's narrow fallback to it, the remembered tab), and the "→ friend · relationship" line on Friend coming cards.**

1. **Pending on a phone (under 768 px) is one scrolling page.** The large title, the line under it (F1.2's "● Updated just now ⟳" once that release is in), then **Waiting for check N**, then **Friend coming N**. No SegmentedControl, no sort control. Each section header is one 44 px row (status glyph, label, count, chevron) that pins under the title while its section scrolls; one tap folds it. A folded Waiting header keeps the oldest wait on its right, heat-coloured (≥ 20 min red, ≥ 10 amber). Fold memory: Waiting for this page session only (never stored) and it opens again by itself when its count rises; Friend coming per device (localStorage, every read and write in try/catch). An empty section keeps its header with a dimmed glyph and 0 (no rows, no text), and Friend coming never moves above Waiting for check. "Pending N" counts both sections.
2. **Waiting for check is every request whose status is Waiting for check**, Needs info (F3), "Not found yet" (held) and Recheck due included, in ONE order: longest wait first (wait = since logged). There is no Later lane and nothing jumps to the top when a recheck comes due: "Not found yet" is an indicator only. F5's lanes are gone everywhere (`lib/client/lanes.ts`, `components/list/ToCheckLanes.tsx`).
3. **The Waiting for check card.** The wait at the top right (the clock, heat-coloured) is the only time on the card; the quiet line is the post and LP number (no "not found 4:02", no recheck time anywhere on a card). A chip row shows only while held or due: an outlined violet "⧗ Not found yet", then, 20 minutes after the hold, a filled violet "↺ Recheck due" (lucide history). Needs info keeps its amber chip (F3). The answers: [message icon, F3] [left answer] [✓ In medical, green]. The left answer is **"⧗ Not found yet"** on a request with no Not found yet (the first Not found: the hold) and **"× Not found"** on a held or due one (× at the ✓'s 2.25 stroke; the final answer, which closes it as the Not found status): same style, width and place. Undo bars (10 s): "Not found yet · recheck in 20 min"; "B.W. closed · not found in medical" (initials; the status label, so F2's rename flows through). The closed card animates out of Pending (a short fade and fold; none with reduced motion). Screen readers: "Not found yet. Keeps this request open and schedules a recheck" / "Not found. Closes this request as not found in medical" / "B.W. closed, not found in medical." then Undo. The same two-state left answer is used wherever medical answers a Waiting request: the request's status block (medical), its foot bar (front of house) and the desk pane. (There is no keyboard shortcut for an answer on this build, so no shortcut label changes.)
4. **Friend coming** is In medical in this order: Friend arrived (earliest arrival first), Friend en route (soonest ETA first, no ETA last), then In medical with nobody coming (longest since found first). Its cards lose the "→ Chris P. · boyfriend" line everywhere (the request still shows the friend). Their minutes are grey only: red and amber mean "waiting for check too long" and never appear on a found patient.
5. **Tablet and desk (768 px and up): a two-column board**, Waiting for check | Friend coming, each column scrolling on its own under the top bar, headers with the chevron (the phone's folds and memory). No Later, and no stacked fallback: a request docked beside the board (a 1024–1279 px screen, an iPad in landscape) keeps the two columns. A column under 340 px tightens its cards (12 px padding, 14 px answers with 6 px side padding) so "⧗ Not found yet" keeps its one line; under 290 px (only with a request docked on a 1024–1279 px screen) the two answers stack, full width, Not found first. The page never scrolls: the board fills the window under the top bar and the connection banner.
6. **Sort by status on All requests and My requests.** A one-tap toggle at the right end of the line under the title: outlined "⇅ Newest" (All) or "⇅ Updated" (My requests) ↔ filled gray-a4 "⇅ Status". No menu. aria-pressed, and a polite live region says "Sorted by status" / "Sorted: newest first" ("Sorted: latest update first" on My requests). Remembered per view on this device (try/catch). At 360 px and narrower it drops to its own row, left-aligned. Sorted by status, a list shows groups under thin pinned dividers (glyph, label, count): Waiting for check (rule 2's order), Friend coming (rule 4's), then the closed ones folded last, newest closed first ("Archived" on All; "Closed" on My requests). The phone log's status cell is the stage label (held "Not found yet", due "Recheck due", violet). With a status or post filter the closed group is a divider, not a fold (filtered lists never fold).
7. **The desk table's column header is its sort control.** Default "Created ↓" on All requests ("Updated ↓" on My requests, which lists latest update first); clicking Status sorts by status (aria-sort; the arrow only on the active header; Status again, or Created / Updated, goes back). Inactive sortable headers show a faint ↕ on hover or focus. Sorted by status the table shows the same group header rows and the Archived / Closed fold. The status cell's extra is the elapsed wait for every row of Waiting for check, heat-coloured ("Waiting for check · 27m", "Needs info · 9m", "Not found yet · 47m", "Recheck due · 40m"); the others as F5 ("In medical · Bed 3", "Friend en route · ~4 min", and "Friend arrived · 4:29 PM" once the server sends the arrival time).
8. **The due stage's label is "Recheck due"** (lib/stages.ts `STAGE_META.recheckDue`: violet, lucide history). Every F5 colour is kept. The request's own status block (not a card) still shows when the recheck is due.

- **Built differently from the mockup.** (a) This branch is built on F5 (`5e0d8a3`), before F2's release: the line under the title ("● Updated just now ⟳", F1.2) is not here yet, so on a phone the "⇅" toggle sits alone at the right end of that line's row (`components/list/ListViews.tsx` Chrome `live`), where F1.2's `LiveIndicator` goes at its left on the merge; the status reads "Not in medical" until F2's rename lands (every new string derives from `STATUS_META`, so it reads "Not found in medical" after the merge). (b) The message icon and the Needs info chip are F3's (`feat/messages`), not on this branch: the card's answer row is [left answer] [In medical] until F3 adds its icon on the left. (c) The phone log keeps its column header and Updated column (the mockup leaves them out), so a 390 px row shows "Waiting" for Waiting for check as before. (d) F3's en route summary has no arrival time: Friend arrived sorts by its arrival time when a server sends `enroute.arrivedAt`, else by when it was found; the desk shows "Friend arrived" alone until then.
- **Review fixes (v9.1 review).** The board never stacks (rule 5 above). Its column headers pin to the very top of their column (the 6 px over them is the board's, outside the scrolling columns), so no scrolled card shows above a pinned header. The Archived / Closed folds use Pending's fold: › while folded, ⌄ while open, gray-11, no rotation (pending-v9.html `.arch`), on the phone and the desk table, and My requests' Closed fold is full width. The request's recheck row uses lucide history like every other Recheck (refresh-cw is the live line's Refresh only). Undo of the final Not found brings the card back held at once (its chip and "× Not found"), and a "× Not found" tapped while that Undo is on its way is the final answer, not dropped as a double tap.
- **For F3's merge.** With F3's 44 px message icon on the left of the answers, a 330 px board column (768 px iPad) leaves 123 px per answer and "⧗ Not found yet" needs 125 at 14 px: raise the stack breakpoint in `components/list/list.module.css` (`@container (max-width: 289.98px)` → about 340 px) or narrow the gaps when the icon lands.
- **Open questions for Brian.** (1) The quiet line on a held card keeps "FA 4 · LP-0010" (the mockup's held cards show the post alone, its button frames "FA 4 · LP-0010"); the brief's "post only" was read as "no time". (2) The request's own status block still has the "↺ Recheck 4:40 PM" row (F5) and the "Rae Chen · 4:06" line under its heading — two clock times, where v9.1 says the only time shown is the elapsed wait (written for cards; the block is not a card). Say if either should go.

## The F5 release: F2 + F5 + Pending v9.1 (assembled 2026-11-06 night, `release/f5`)

What the next release ships on top of the live F2 (`main` 85c9320): F5 (stages and the "Not found yet" hold, with its review fixes) and Pending v9.1. Where they met (`docs/BUILD_SPEC.md` §20 A69):

- **Pending v9.1 wins for Pending** (one page on a phone, the two-column board, no tabs, no Later lane), the card's answers ("⧗ Not found yet" / "× Not found"), the orders, and the desk status cell: every stage of Waiting for check is followed by its wait ("Waiting for check · 27m", "Needs info · 9m", "Not found yet · 47m", "Recheck due · 40m"). No recheck time on a card or a cell: F5's later "Needs info ⟳ 4:40 PM" / "· 11:40 PM" extras and the My requests "Recheck 4:40 PM" chip are gone. The request's own status block keeps its "↺ Recheck 4:40 PM" row (lucide history since the v9.1 review fixes), for Needs info on hold too (F5 review fix).
- **F2 wins** for the rename ("Not found in medical"; the final answer reads "Not found", the same words), the brand row and the line under the title, the desk top bar fixes, the Created column and the photo fixes. On All and My requests the line and the "⇅" toggle share one row: "● Updated just now ⟳" at its left, the toggle at its right end.
- **F5 wins** for the hold's SQL, the stage colours and the hold alerts. Its wider status column with a request docked stays (184–232 px; 176 px at least at 1024–1279, so the five columns still fit beside F2's 96 px Created column), and a closed row's "· 2 checks" still drops out where the column is narrow.
- **The desk follows the open request on Pending**: its card is scrolled into view (the board has no tabs to switch any more).
- **The first load stays within its 230 KB** (`docs/BUILD_SPEC.md` A71; the budget is not raised). The hold's client rules load right after the page, as the stages do; the alert chime too; and Jeffrey's test-data banner is removed (it drew nothing after 12:30 PM on Nov 6, and its file said to delete it once the event started).
- **Where the line meets the header** (All and My requests, phone): the search and avatar buttons' 44 px tap areas grow up and sideways, the "⇅" toggle's down, so a tap at the seam goes to the control drawn there. Under 361 px the stacked line and toggle are 12 px apart.
- **Nothing docked under 1040 px, the desk's status column is 176 px** (as docked at 1024–1279), so beside F2's 96 px Created column the Friend column keeps more than 100 px at 768.
- **Pending v9.1's review fixes are in** (`feat/pending-v9` 91cd971, merged after the gate; `docs/BUILD_SPEC.md` A72): the board keeps its two columns with a request docked (no stacked column), and the open request's card is still scrolled into view; Undo of the final Not found brings the held card back at once, inside the hold code the first load no longer carries.

## Dashboard Performance windows and "None" (Brian, 2026-11-06 21:55–22:05)

- **Every Performance row names its window**: Time to answer "last 2 hours" (was "avg, 2 h"), Time to reunite "last 2 hours" (was "avg"; lp_stats averages reunions over the last 2 hours too), Logged "last hour" (unchanged).
- **An empty value reads "None"**, not "—": no one waiting (Longest wait), no answers or no reunions in the last 2 hours. Screen readers hear "No one is waiting for a check", "No answers in the last 2 hours", "No reunions in the last 2 hours". Logged is a count, so 0 stays "0".
- **"—" only while the stats request fails** (the dashboard's Reconnecting): then an empty value is not known to be empty, and its sentence says "not available". Values that did load still show.

## Team join link (Brian 2026-11-06 23:55)

Brian: "send a link with the password in the url so it auto logs them in … they just do the first step and get in". Built as Claude proposed and Brian approved: the same experience, but safer than putting the event password in a URL.

- **The link carries its own join code, not the event password:** `https://<host>/signin#join=<code>` (`/#join=<code>` works too). The code is in the fragment, so it never reaches the server, its logs or a Referer. Rotating or switching off the code never changes the password, and the password keeps working.
- **Step 1 is the only step.** Name and team (unchanged), then Continue signs in and opens the app; there is no password screen. A remembered name and team prefill step 1 instead of skipping to step 2. Nothing on screen mentions the link (show it, don't explain it); screen readers hear "Signs you in with the team link, no password needed" on Continue and "Signed in with the team link" once it worked.
- **A wrong, expired or switched-off code falls back silently** to the password step as it is today, with no message about the link. Too many attempts says nothing about the code, so it is kept: step 1 stays, "Too many attempts. Try again in N min" shows above Continue, and Continue waits until then (as Sign in does). A dropped signal or a server error keeps the code and shows the usual message above Continue, which tries again.
- **The code leaves the address bar at once** (before the page paints, and also when the link is opened in a tab already showing that page, where only the fragment changes) and is kept for that tab only (sessionStorage; never localStorage, a cookie or the URL), so it is in none of the tab's back / forward entries, no later screenshot and no re-shared link. It is forgotten as soon as the server answers. A signed-in visitor opening the link just gets the app.
- **The browser's own History list keeps the link.** The browser saves the visited URL, fragment included, before any script on the page runs, and nothing on the page can remove it: the History list and address-bar suggestions on that device (and, with Safari iCloud History or Chrome Sync, the user's other devices) offer the link until it expires, after sign-out and after the tab closes. So the expiry stays short (the first link: 2026-11-09 12:00 UTC) and a lost or shared device that opened it means rotating the code (HANDOFF "Known limits").
- **Server:** `POST /api/session` takes exactly one of `password` or `invite`. Only the code's SHA-256 is configured (`INVITE_CODE_SHA256`), compared in constant time, and it works only before `INVITE_EXPIRES_AT` (first link: 2026-11-09 12:00 UTC). With either unset the link is off. A link attempt counts toward the same sign-in limits as a password, a failed one as a failed attempt, and gets the same session cookie. Logs name the method only ("invite" or "password"). No database change.
- **Recorded exception:** `signInSchema` is in the frozen `lib/validation.ts`; the change is additive (a body with a password parses exactly as before).
- Code: `lib/join-link.ts`, `components/signin/SignInFlow.tsx`, `lib/server/invite.ts`, `scripts/make-invite.mjs`. Spec: `docs/BUILD_SPEC.md` J1. Operations: `HANDOFF.md` "Team join link".
