# Build spec: "Is my friend in medical?" (EDC Orlando 2026)

This is the single contract for every agent building the app. If anything here conflicts with `design/DECISIONS.md`, `DECISIONS.md` wins on product questions and this file wins on engineering questions. If something is unclear, choose the safer and simpler option and note it in your report.

## 0. Context and bar

- **What it is.** Ground Control / Headliner Experience (GC/HX) uses it at EDC Orlando, Nov 6–8 2026. It is GC/HX's first production app, it is mission critical, and real people are looking for their friends through it.
- **Who uses it.** Roughly 10–30 staff on phones, under bad festival connectivity. The flow:
  - Front-of-house staff at FA 3 and FA 4 log a missing person and the friend's details.
  - The medical liaison and nurses at Main Med check the charts and answer **In medical** or **Not in medical**.
  - When the answer is In medical, the friend is walked to Main Med, and medical taps **Reunited**.
- **The bar.**
  - No bugs.
  - Secure by default.
  - Fast on a weak signal, and low on data.
  - Still usable when the signal drops.
  - The UI matches the approved mockups as closely as possible.
- **The data is sensitive.** It is identifying and contact information only, never medical records. Never log names, phone numbers or descriptions to the console or server logs. Use synthetic data in every test.

## 1. Sources of truth (read before building)

- **Product decisions:** `design/DECISIONS.md`. Every approved decision is there.
- **Mockups:** `design/screens/*.html` (real Radix Themes 3.3 markup, opened from a local file, needs internet for the CDN) and the matching `*.png`:
  - `sign-in`
  - `requests` (All, Pending, My requests, the view menu)
  - `new-request`
  - `profile`
  - `dashboard`
  - `states` (avatar menu, post picker, search, photo viewer, alerts sheet, empty, offline, error)
  - `skeletons`

  Port the markup, tokens and CSS from these files into real components. They are the visual spec.
- **One change after the mockups:** on sign-in step 2 ("Enter the event password"), **remove** the small "Is my friend in medical?" line. Step 1 keeps it.
- **Jeffrey's original app:** `git show 1f4580b:app/ui.tsx` and the original `app/api/**`. Every working feature in it must survive, either kept or moved (`DECISIONS.md` lists where each one went).

## 2. Stack (pinned)

- **Framework and UI:**
  - Next.js **16.4.x** (App Router) with React **19.3**. This upgrade also clears the npm audit warnings on Next and PostCSS.
  - TypeScript strict mode.
  - `@radix-ui/themes` **3.3.0** for all UI: Theme, Button, IconButton, TextField, TextArea, SegmentedControl, RadioCards, Badge, Card, Avatar, Dialog, AlertDialog, DropdownMenu, Skeleton.
  - `lucide-react` for icons. Fall back to inline SVG paths from the mockups only where the mockups use custom glyphs, such as the status glyph and the pie fill.
  - `@fontsource-variable/inter`, self-hosted with no Google Fonts call, so the font works offline. Apply `font-feature-settings: "cv11"` as in the mockups.
- **Validation:** `zod` 4 on every API input and every env var.
- **Server:**
  - `@supabase/supabase-js` 2, **server-only**, with the secret or service-role key.
  - `jose` for the session JWT.
  - `bcryptjs` for the password hash.
- **Client storage:** `idb-keyval` for IndexedDB (the offline cache and outbox).
- **Tests:**
  - `vitest` for unit and integration tests.
  - `@playwright/test` for end-to-end tests, run in Chromium with the iPhone 14 profile and Mobile Safari (WebKit) where possible.
- **No other runtime dependencies** without a written reason in the PR description. No CSS frameworks, no Tailwind.

## 3. Environment variables

These are validated with zod at server startup, and missing ones fail with a clear message.

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Name kept for compatibility with Jeffrey's Vercel env. **Used server-side only.** Normalize a trailing `/rest/v1/` the way `lib/supabase-url.js` does today. |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only. Never sent to the client. Never prefixed `NEXT_PUBLIC_`. |
| `SESSION_SECRET` | yes | At least 32 characters. |
| `APP_SHARED_PASSWORD` | one of | The plain event password. Brian wants to set it as an env var. Compare it in constant time (HMAC both sides with SESSION_SECRET, then `timingSafeEqual`). |
| `APP_SHARED_PASSWORD_HASH_B64` | one of | Jeffrey's existing base64 bcrypt hash, still supported. If both are set, the hash wins. |
| `EVENT_TIMEZONE` | no | Defaults to `America/New_York`. Used for every displayed time and the CSV. |

Update `.env.example` (placeholders only) and the README.

## 4. Domain model

### Statuses

The database values stay unchanged, and the UI labels are new. Every status is defined in one module, `lib/domain.ts`: label, colour token, glyph kind, whether it counts as open, and progress steps.

| DB value | UI label | Colour | Glyph | Open? |
|---|---|---|---|---|
| `Added` | Waiting for check | blue (`--blue-9`, text `blue`) | empty ring | yes |
| `Checked – Not Found` | Not in medical | amber | filled circle with × | no (final, no rechecks) |
| `Found – Awaiting Reunion` | In medical · friend coming | green | ring with ¾ pie | yes |
| `Reunited – Closed` | Reunited | grey, dimmed in lists | filled check | no |
| `Found – Discharged` | Discharged | grey, dimmed | filled check | no |
| `Cancelled` | Cancelled | grey, dimmed | filled check | no |
| `Bring friend to medical` | (legacy, never set by the app) | Show as "In medical · friend coming" if found in old data | same as In medical | yes |

### Allowed status changes

These are **enforced on the server**, inside the database function. The client only offers what makes sense for the current status (progressive disclosure).

- `Added` → `Checked – Not Found`, `Found – Awaiting Reunion`. A move to `Cancelled` happens only through cancel, and only by the creator.
- `Checked – Not Found` → `Found – Awaiting Reunion` (change answer), `Added` (undo).
- `Found – Awaiting Reunion` → `Reunited – Closed`, `Checked – Not Found` (change answer), `Found – Discharged` (⋯ menu), `Added` (undo).
- `Reunited – Closed` and `Found – Discharged` → `Found – Awaiting Reunion` (undo or reopen).
- `Cancelled` → `Added` (undo, creator only).
- `Bring friend to medical` → `Reunited – Closed`, `Found – Discharged`, `Checked – Not Found`.
- Anything else returns 422.

### Timestamps on a status change

These match Jeffrey's semantics.

- Moving into `Found – Awaiting Reunion` sets `found_at` and `reunion_started_at`, but only if they are null.
- Moving into a closed status (`Reunited – Closed`, `Found – Discharged`, `Cancelled`) sets `closed_at = now()`.
- Moving back to an open status clears `closed_at`.

### Teams (sign-in), in this order

| Card label | Saved value |
|---|---|
| GCHX Med Transpo | `GC/HX - Special Operations/Med Transpo` |
| Dispatch | `GC/HX - Dispatch` |
| GCHX Base | `GC/HX - Base` |
| Medical | `Medical` |

The "Other team" field takes free text of 2–80 characters. **Show the short label everywhere in the UI.**

### Posts (reporting location)

`FA 3 – Kinetic`, `FA 4 – Oasis`, `Command`, `Base`, `Other`. Other needs `other_location` (1–80 characters). This is enforced by the existing CHECK constraint and by zod.

### Staff identity

- The session holds `{staffName, team}`.
- The audit and `created_by` string is `"${staffName} · ${teamShort}"`. This keeps Jeffrey's format of name, middle dot, department.
- "My requests" = `created_by === sessionStaffString`. Compare after trimming and normalizing whitespace, case-insensitively.

### Request fields and limits

| Fields | Limit |
|---|---|
| name | ≤120 characters, split into `first_name` / `last_name` at the last space, like Jeffrey's |
| age | integer 0–120, or null |
| gender | `Male` / `Female` / `Other`, or null |
| clothing, last_seen, hair, height_build, identifying_features | ≤300 characters each (`last_seen` ≤1000) |
| physical_description, additional_notes, contact_notes | ≤2000 characters |
| contact_name, contact_relationship | ≤120 characters |
| contact_phone | ≤40 characters. Show a ✓ in the UI when it parses as 10 or more digits; the format is not enforced. |

Empty strings are stored as null.

## 5. Database

The existing schema is in `supabase/schema.sql` plus the two applied migrations. **Do not change existing columns or constraints.**

Add **one** idempotent migration, `supabase/migrations/20261106_rework.sql`. Jeffrey will paste it into the Supabase SQL editor before deploying, so it must be safe to run twice and on the existing production database. The migration:

1. Adds `patients.updated_at` maintenance: a `BEFORE UPDATE` trigger sets `updated_at = now()`. Also `create index if not exists patients_updated_at_idx on patients(updated_at desc)`.
2. Adds `patient_photos.thumb_path text` (nullable, `if not exists`).
3. Creates the table `lp_login_attempts(id bigserial pk, key text not null, ok boolean not null, at timestamptz default now())` with an index on `(key, at desc)`. RLS on, no policies.
4. Creates these **atomic functions** (plpgsql, `security invoker`, `set search_path = public`). The server calls them through `supabase.rpc`. Each writes its audit row **in the same transaction**, and each takes a `FOR UPDATE` lock on the patient row where it reads and writes.

   | Function | Behaviour |
   |---|---|
   | `lp_create_request(p jsonb, p_staff text) returns patients` | Idempotent on `p->>'client_mutation_id'`: an existing row is returned unchanged. Inserts the patient with status `Added`, and an audit event with action `patient_created`, `new_value` = the inserted fields. |
   | `lp_set_status(p_id uuid, p_expected text, p_status text, p_staff text, p_is_undo boolean default false) returns patients` | Locks the row. A mismatch with `p_expected` raises SQLSTATE `P0409` with the current status in the message, which the server maps to 409. Enforces the transition table above, raising `P0422` otherwise. Sets the timestamps. Writes an audit event with action `status_changed` (or `status_undone`), `previous_value = {status: old}` and `new_value = {status: new}`. |
   | `lp_update_fields(p_id uuid, p_patch jsonb, p_expected_updated_at timestamptz, p_staff text) returns patients` | Only whitelisted keys. A stale `updated_at` returns 409, unless the patch doesn't touch fields changed since. Simplest correct approach: compare `updated_at` and raise `P0409`; the client then refetches and asks the user to reapply. Writes an audit event with action `patient_updated` and `previous_value` / `new_value` holding **only the changed keys**. |
   | `lp_cancel(p_id uuid, p_staff text) returns patients` | Only when `created_by = p_staff` (normalized comparison; otherwise `P0403`) and the status is `Added`. Sets `Cancelled`, sets `closed_at` and writes an audit event with action `cancelled`. |
   | `lp_add_photo(p_id uuid, p_path text, p_thumb text, p_timing text, p_staff text) returns patient_photos` | Locks the patient. If there are already 3 or more active photos, raises `P0429`. Inserts the photo and an audit event with action `photo_uploaded`. |
   | `lp_login_allowed(p_key text) returns boolean` | False if there are 8 or more failed attempts for this key in the last 15 minutes. |
   | `lp_login_record(p_key text, p_ok boolean)` | Records an attempt and prunes rows older than 1 day. |
   | `lp_stats(p_tz text) returns jsonb` | Everything the dashboard needs, in one call (see §8). |

5. Runs `revoke all on function … from public, anon, authenticated; grant execute … to service_role;` for every function.

**Local testing.** Colima (Docker) is running on this machine. Use `supabase init` (if needed) and `supabase start` for local Postgres, PostgREST and Storage. Then apply `supabase/schema.sql`, the two existing migrations and the new one, in order. Configure the private bucket `patient-photos` in `supabase/config.toml`: `public = false`, 6 MB, image/jpeg, image/png and image/webp. Add a `supabase/seed.sql` with **synthetic** data matching the mockups (about 21 requests across all statuses). Tests must never touch production.

## 6. Server: API routes (`app/api/**`)

These rules apply to every route:

- It returns JSON in the shape `{ error: { code, message } }` on failure.
- It sends `Cache-Control: no-store`, unless stated otherwise.
- It requires a valid session, except `POST /api/session`.
- **Mutations** (POST, PATCH, DELETE) also require a same-origin `Origin` header, matching the request host. Otherwise return 403 (CSRF defence on top of the SameSite cookie).
- zod validates the body and params. A UUID check on ids. Body size limits: JSON ≤64 KB, photos ≤6 MB per file.
- No PII in logs. Log only the error code and request id.
- Database exceptions map as follows:

  | SQLSTATE | HTTP |
  |---|---|
  | P0409 | 409 |
  | P0422 | 422 |
  | P0403 | 403 |
  | P0429 | 429 / 422 |
  | other | 503, with a generic message |

The routes:

| Route | Purpose |
|---|---|
| `POST /api/session` | Body `{staffName, team, otherTeam?, password}`. **Rate limited** by key = sha256(IP + user-agent), through `lp_login_allowed` and `lp_login_record`. Returns 429 with a `retryAfter` value. Sets an HttpOnly, Secure (in production), SameSite=Strict cookie `lp_session` (a JWT HS256 that expires in 12h) with `{staffName, team}`. Returns `{staffName, team}`. |
| `GET /api/session` | Returns `{staffName, team, staff}` or 401. |
| `DELETE /api/session` | Clears the cookie. |
| `GET /api/requests?since=<iso>` | **The sync endpoint** (see §7). The list payload is `RequestSummary[]`, a slim row with no audit and no photo URLs. Fields: `id`, `caseNumber`, `name`, `age`, `gender`, `status`, `post` (location or other_location), `clothing`, `lastSeen`, `photoCount`, `createdAt`, `updatedAt`, `foundAt`, `closedAt`, `createdBy`, `contactName`. Without `since`, it returns all open requests plus the newest 300 closed ones. With `since`, it returns rows with `updated_at > since − 5s`. Response: `{requests, serverTime, full}`. Sends a weak `ETag`; a matching `If-None-Match` gets 304. |
| `POST /api/requests` | Creates through `lp_create_request`. Body: form fields plus `client_mutation_id` (UUID, required). Returns `{request: RequestSummary}` with status 201, or 200 if the request already existed. |
| `GET /api/requests/:id` | Returns a `RequestDetail`: all fields, the photo list `[{id, timing, createdAt, uploadedBy}]`, and audit events sorted ascending `[{id, action, at, staff, previous, new}]`. |
| `PATCH /api/requests/:id` | Body `{patch, expectedUpdatedAt}` through `lp_update_fields`. |
| `POST /api/requests/:id/status` | Body `{status, expectedStatus, undo?}` through `lp_set_status`. |
| `POST /api/requests/:id/cancel` | Through `lp_cancel`. |
| `POST /api/requests/:id/photos` | Multipart with fields `photo` (full image) and `thumb`, both sniffed by magic bytes (JPEG, PNG or WebP), and `timing` (`today` or `older`). Uploads both files to the private bucket under `{patientId}/{uuid}.jpg` and `…_thumb.jpg`, then calls `lp_add_photo`. If the RPC fails, delete the uploaded objects. |
| `GET /api/photos/:id?size=thumb\|full` | 302 redirect to a 120 s signed URL. Header: `Cache-Control: private, max-age=60`. |
| `GET /api/export` | CSV. The columns are curated (case number, name, age, gender, status label, post, clothing, last seen, hair, height/build, identifying features, physical description, notes, contact name, phone, relationship, contact notes, created by, created, updated, found, closed). Times are in the event timezone. Keep the formula-injection guard (prefix `'` before `= + - @ \t \r`). Filename: `lost-persons-YYYY-MM-DD.csv`. Header: `no-store`. |
| `GET /api/stats` | Returns `lp_stats` (see §8). |

**Headers and middleware** (`middleware.ts` or the Next 16 equivalent):

- A strict CSP with a per-request nonce:

  ```
  default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co;
  connect-src 'self'; font-src 'self'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'
  ```

  Radix needs inline styles, which is why `style-src` allows `unsafe-inline`. Add `img-src` for the signed Supabase URLs, using the configured Supabase host.
- Also send:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(self), geolocation=(), microphone=()`
  - `X-Frame-Options: DENY`
- **Unauthenticated page requests** go to `/signin`. Authenticated users who hit `/signin` go to `/`.
- `poweredByHeader: false`.

## 7. Client architecture

### Routes

| Route | Screen |
|---|---|
| `/signin` | Two steps. |
| `/` | The request list, with the view switcher for All, Pending and My requests. |
| `/new` | Full-screen new-request form. |
| `/r/[id]` | Full-screen request profile. |
| `/dashboard` | Dashboard. |

Navigation must be instant: no refetch when moving between routes.

### Store

`lib/client/store.tsx` is a React context mounted in the authenticated layout. It holds:

- `requests: Map<id, RequestSummary>`
- `status: 'live' | 'offline' | 'error'`
- `lastSync`
- the session

It is backed by IndexedDB through idb-keyval (the last list plus a cursor), so the app opens instantly and works offline with the last data it had.

### Sync

- **Polling with delta.** Poll every 5 s while the page is visible, every 30 s while hidden, and stop while `navigator.onLine` is false.
- **Triggers.** Poll immediately on focus, `online` and `visibilitychange`.
- **Cursor.** Use `serverTime` as the cursor, and merge by id, keeping the larger `updatedAt`.
- **Conditional requests.** Use `If-None-Match`.
- **Backoff.** Back off exponentially on errors, up to 60 s. Mark the store `error` after 3 failures.
- **No overlap.** Use an AbortController so two polls never run at once.

### Mutations

- They go through the store, which updates the request optimistically, then reconciles with the server response.
- **On 409:** refetch the detail and show the conflict banner ("Updated by someone else", with the latest data shown).
- **Undo:** after a status tap, show a 6 s snackbar. Undo calls the reverse transition with `undo: true` and `expectedStatus` = the new status.

### Offline (v1)

1. **The app shell loads offline** through a minimal service worker. It precaches the shell and Next static assets with a versioned cache and cache-first for `/_next/static`. It must **never cache `/api/*`**. On a failed navigation, it falls back to the cached shell.
2. **The last list shows** from IndexedDB, with the amber banner "Offline · N waiting to send" and an amber live dot.
3. **New requests with no photos can be queued offline.** They go to an IndexedDB outbox, show at the top of the list as "Waiting to send · Not sent", and are sent automatically in order when the connection returns. Each carries a stable `client_mutation_id`, so a retry never creates a duplicate.
4. **Photos and status changes need a connection in v1.** The UI disables those buttons with a clear reason when offline. Queued photos and status changes are a **later phase**; design the outbox so it can be extended to them.

### Alerts (in-app only for launch)

- **When:** after each sync, compare with the previous state and alert:
  - for status changes on **My requests** (always)
  - for new requests from others, but only when the bell is on (stored in localStorage, off by default)
- **How:**
  - A banner toast, the same component as the mockup.
  - A short WebAudio chime, unlocked on the first user gesture.
  - `navigator.vibrate(200)` where supported.
- **Bell.** It toggles the setting. The first time it's turned on, show the "Turn on alerts" sheet from the mockup, iPhone steps included, because lock-screen push comes later. Its copy must not promise lock-screen alerts yet. Proposed copy, which the tester checks: the heading "Alerts are on", plus the Home Screen tip.

### Theme

- Light / Dark / Auto, stored in localStorage and applied **before paint** with a tiny nonce'd inline script, so there is no flash.
- The toggle sits at the top right on sign-in. Inside the app, it's under Theme in the avatar menu.
- Radix `Theme` with `accentColor="gray" grayColor="gray" radius="medium"`, and the appearance from the setting.

### Remembered on this phone

- name and team (sign-in step 2 starts there)
- the last reporting location
- the theme
- the bell setting

The view always opens on **All**.

### Photos

- **Compression.** Compress on the client before upload. Draw on a canvas and export:
  - the full image at up to 1600 px on the long edge, JPEG quality 0.8
  - a thumbnail at 320 px, JPEG quality 0.7
- **EXIF.** Strip it by re-encoding. Handle orientation, since `createImageBitmap` with `imageOrientation: 'from-image'` does it.
- **Loading.** Lists and profiles load the thumbnails. The viewer loads the full image.
- **Limit.** Three photos at most.

### Performance

- Under 150 KB of JavaScript for the first load of `/`, gzipped, as a target.
- Load the routes for `/r/[id]`, `/new` and `/dashboard` only when visited.
- No layout shift.
- Show skeletons only when there's no cached data yet.

### Accessibility

- Real buttons and labels.
- `aria-live` on toasts.
- Focus management in sheets and dialogs (Radix handles it).
- Tap targets of 44 px or more.
- Contrast that passes in both themes.

## 8. Screens: behaviour notes

The mockups show the visuals. This section only covers behaviour.

- **Sign-in.**
  - Step 1:
    - The EDC Orlando logo (inverted in dark mode) and the Ground Control logo (purple, full colour) side by side, with a divider between them.
    - The small grey line "Is my friend in medical?", then "Staff sign-in".
    - The name field with a person icon.
    - "Your team" with the 2×2 cards and the Other team field.
    - Continue, which is disabled until the name and a team are valid.
  - Step 2:
    - The logos, then "Enter the event password".
    - The filled identity row with a Change button, which goes back to step 1.
    - The password field with show/hide. The field carries `autocomplete="current-password"`, and a hidden username field supports Keychain.
    - Sign in.
    - A wrong password shows a red border and "Incorrect password".
    - Too many attempts shows "Too many attempts. Try again in N min".
  - On both steps, the bottom reads "Built by Jeffrey & Brian for Ground Control / Headliner Experience".
  - When the 12 h session expires, the user lands on step 2 with the name and team already filled in.
  - The logos are in `design/edc-logo.png` and `design/gc-logo.png`; copy them into `public/`.
- **List (`/`).**
  - The header has the title, the live dot, search, the bell and the avatar.
  - The view switcher shows All requests / Pending / My requests, with counts.
  - **All** is chronological, newest first. Each row shows the status glyph, name, age and sex, the time logged (event timezone, h:mm), the status label in its colour, post and LP number. Closed rows are dimmed.
  - **Pending** has the sections "Friend coming" (In medical, open; cards with the friend's name, from-post and time since, plus Reunited) and "Waiting for check", oldest first. Each Waiting card has a thumbnail, name, age and sex, LP number and post, a wait badge (grey under 10 min, amber at 10–19, red at 20 or more), a 2-line description and the Not in medical / In medical buttons.
  - **My requests** has cards with the progress stepper, newest update first.
  - The floating "New request" button.
  - Tapping a row or card opens `/r/[id]`.
  - Search covers names, clothing, last seen, descriptions and LP number, case-insensitively, with highlighted matches.
- **New request (`/new`).**
  - Everything fits on one phone screen without scrolling until More details is opened (see the mockup).
  - The "Reporting from" row (pin icon) opens the post picker sheet. Choosing Other reveals a "Where?" field.
  - The ID-style card: a photo slot, Name (placeholder "Name or initials, e.g. J.D."), Age (numeric keypad) and the Gender segmented control.
  - Wearing, then Last seen. The stage chips appear **only while Last seen has focus**: `kineticFIELD`, `circuitGROUNDS`, `neonGARDEN`, `stereoBLOOM`, `Taken to medical`. A tap adds the chip text.
  - The photo slot opens the file input, which accepts the camera or the library, takes multiple files, and allows up to 3. Once there are photos, the slot shows a count badge and a Today / Not today tag (tap to toggle).
  - Friend or family: Name, Phone (tel keypad, ✓ when valid) and Relation.
  - More details opens Hair, Build, Features, Description, Contact notes and Other notes.
  - Send request is disabled until any field is filled.
  - **Draft.** The form keeps its contents in sessionStorage while open.
  - **After sending:** the toast "LP-1014 saved", and the screen returns to `/` (the list).
  - **Upload order:** the request is created first, then the photos. If a photo upload fails, show an error toast and let the user retry from the profile.
- **Profile (`/r/[id]`).**
  - The top bar has ×, the LP number and ⋯ (Edit details, Mark discharged when the status is In medical, and Cancel request for the creator while the status is Waiting).
  - The header shows the portrait thumbnail, name, age and gender, post and who logged it.
  - The status block uses the status colour.
  - Missing person and Friend or family each have an Edit button. Edit opens the same form, prefilled, and saves through PATCH.
  - Phone has a Call button (`tel:`).
  - The photo tiles open a full-screen viewer that swipes between photos.
  - **The audit trail**, newest first:
    - Every status change shown as from → to, with glyphs.
    - Every edit shown as the field with old → new (old value struck through).
    - Photos added and the original request logged.
    - Each entry shows who (name · team) and when (for example "Nov 6, 11:10 PM").
  - **Sticky actions, by status:**

    | Status | Buttons |
    |---|---|
    | Waiting | Not in medical, In medical |
    | In medical | Change answer, Reunited |
    | Not in medical | Change answer |
    | Closed | none |

  - "Cancel request" (red, at the bottom) appears only for the creator while the status is Waiting, behind the confirm dialog "Cancel this request?" with Keep / Cancel request.
- **Dashboard (`/dashboard`).** Opened from the avatar menu. It shows:
  - Open requests as a hero number (56 px).
  - A thin segmented bar: blue = Waiting, green = In medical. These colours were checked with the palette validator in light and dark.
  - A legend of glyph, label and count.
  - 4 tiles:
    - Not in medical
    - Reunited (with the discharged / cancelled note)
    - Longest wait (with its LP number and post)
    - Average answer time, over the last 2 h: the mean of first-status-change time minus created time
  - Open by post: single-hue grey bars, 10 px tall, with a 4 px rounded end and the value at the tip. A post at zero draws no bar.
  - Recently updated (5 rows).
  - Export CSV.

  The data comes from `/api/stats`, refreshed every 15 s while the screen is open.
- **Avatar menu.** Name and team, Theme (Light / Dark / Auto), Dashboard, Export CSV, Sign out, and "Built by Jeffrey Yu" at the bottom. Keep this line, since it's Jeffrey's credit.
- **States.** Skeletons (Radix `Skeleton`, shaped like the content), empty, offline banner, "Can't reach the log" with Try again, the session-expired redirect, and the conflict banner on the profile.

## 9. Quality gates (all must pass before the PR)

1. `npm run typecheck`, `npm run lint` and `npm run build` pass with zero warnings that matter. `npm audit --omit=dev` shows no high or critical issues.
2. **Unit tests:** the domain module (status labels and transitions), validation schemas, name splitting, CSV escaping, phone check, wait-badge thresholds, the diff/alert logic, store merging and image compression sizing.
3. **Integration tests** against the local Supabase: every API route covering the happy path, auth required, Origin check, validation errors, 409 conflicts, illegal transitions, cancel by a non-creator (403), the 4th photo (rejected), concurrent photo uploads (only 3 succeed), idempotent create, login rate limit, CSV injection guard, and stats numbers.
4. **Playwright end-to-end tests** (iPhone viewport, light and dark):
   - sign in, including wrong password and rate limit
   - create a request with a photo
   - see it in All and My requests
   - a second browser context (the liaison) sees it in Pending within 6 s and taps In medical
   - the first context gets the alert
   - Friend coming → Reunited
   - change answer
   - undo
   - cancel (creator only)
   - edit fields, and the audit trail shows the diffs
   - search
   - dashboard numbers
   - CSV download
   - offline: create a request while offline (through `context.setOffline`), it appears as Not sent, it syncs when back online, with no duplicate
   - session expiry redirect
   - theme persistence with no flash
5. **Visual check.** Screenshot every screen and state at 390×844 in both themes, and compare with `design/screens/*.png` side by side. Fix any obvious drift: spacing, type, colours, missing elements.
6. **Security review:**
   - every route checks the session and same origin
   - no secret appears in the client bundle (grep `.next/static`)
   - the CSP is applied
   - the cookie flags are set
   - the bucket is private
   - RLS is still on with no policies
   - the functions are not executable by anon

## 10. Repo, branch and handoff

- **Branch:** `rework/ui` (it already exists and has `design/`). Commit often, with clear messages. The final push opens a PR to `main` titled "Rebuild: Is my friend in medical? (EDC Orlando 2026)". The PR description covers what changed, **the migration steps for Jeffrey** (run `20261106_rework.sql` in the SQL editor first), the env vars, how to test, and known limits.
- **Remove** dead files from the old app once they're replaced.
- **Docs:** update `README.md` and replace `HANDOFF.md` with the new state.
- **Never commit** `.env*` files, build output or test artifacts.
