# Build spec v2: "Is my friend in medical?" (EDC Orlando 2026)

This is the single contract for every agent building the app. Version 2 adds the findings from the GPT-6 Astra (Codex) and Claude Fable 5.1 plan reviews. §13 (v2.1), §14 (v2.2, the Phase 1a review), §15 (v2.3, the Phase 1a verification), §16 (v2.4, the integrated QA), §17 (v2.5, the product decisions of 2026-11-06 morning and afternoon) and §18 (the F2 release, 2026-11-06 evening) override anything above them.

- **When documents disagree:**
  - This file wins on engineering questions.
  - `design/DECISIONS.md` wins on product questions, except where §12 records an explicit exception.
  - On visuals, the mockups in `design/screens/` win.
- **When something is unclear:** choose the safer, simpler option and note it in your report. Never invent a product feature.

## 0. Context and bar

- **What it is.** Ground Control / Headliner Experience (GC/HX) uses it at EDC Orlando, Nov 6–8 2026. It is GC/HX's first production app, it is mission critical, and real people are looking for their friends through it.
- **The flow.** Roughly 10–30 staff use it on phones with poor connectivity.
  - Front-of-house staff at FA 3 and FA 4 log a missing person and the friend's details.
  - The medical liaison and nurses at Main Med check the charts and answer **In medical** or **Not in medical**. Nothing more is ever shared: never "left", never "hospital".
  - When the answer is In medical, the friend is walked to **Main Med**, always Main Med, and medical taps **Reunited**.
- **The bar.**
  - No bugs.
  - Secure by default.
  - Fast on a weak signal, and low on data.
  - New requests are never lost to a bad connection.
  - The UI is as close to the mockups as possible.
- **The data is sensitive.** It is identifying and contact information only, never medical records.
  - **Never log PII.** That means names, phone numbers, descriptions and notes, in the browser console or in server logs.
  - **Synthetic data only** in every test.

## 1. Sources of truth

- **`design/DECISIONS.md`** holds the approved product decisions.
- **`design/screens/*.html` + `*.png`** are the visual spec. They are real Radix Themes 3.3 markup, opened from a local file, and need internet for the CDN. Port their markup, tokens and CSS into components:
  - `sign-in`
  - `requests`
  - `new-request`
  - `profile`
  - `dashboard`
  - `states`
  - `skeletons`
- **Changes after the mockups:**
  - On sign-in step 2, remove the small "Is my friend in medical?" line. Step 1 keeps it.
  - The mockups use fixed-height frames. The real app must **scroll whenever content doesn't fit** (keyboard up, large text, short phones). "Fits on one screen" is the goal at default text size on a 390×844 viewport, not a hard clip.
- **Jeffrey's original app:** `git show 1f4580b:app/ui.tsx` and `git show 1f4580b:app/api/...`. Every working feature must survive, either kept or moved (§12).

## 2. Stack (pinned)

- **Framework:**
  - Next.js **16.4.x** (App Router; in 16 the middleware file is `proxy.ts`), React **19.3**.
  - TypeScript strict.
  - ESLint called directly, because `next lint` is gone.
- **UI:**
  - `@radix-ui/themes` **3.3.0** for all UI.
  - `lucide-react` icons. Use inline SVG only for the custom status glyph and the pie, ported exactly from the mockups.
  - `@fontsource-variable/inter`, self-hosted, with `font-feature-settings: "cv11"`.
- **Validation:** `zod` 4.
- **Server:**
  - `@supabase/supabase-js` 2, server-only.
  - `jose`.
  - `bcryptjs`.
- **Client storage:** `idb-keyval`, for IndexedDB.
- **Tests:**
  - `vitest` 5.
  - `@playwright/test` 1.65, with Chromium plus WebKit and the iPhone 14 profile.
- No other runtime dependencies without a written reason. No Tailwind or CSS frameworks.
- **No `next/image`.** Use plain `<img>`, because the optimizer would strip the session cookie, and Jeffrey used `unoptimized` for the same reason.

## 3. Environment variables

These are validated with zod when the server first uses them. A missing variable fails with a clear message.

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Name kept for compatibility with Jeffrey's Vercel env. **Server use only.** Normalize a trailing `/rest/v1/`, as `lib/supabase-url.js` does. |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only. |
| `SESSION_SECRET` | yes | 32 characters or more. |
| `APP_SHARED_PASSWORD` | one of | The plain event password. Compare in constant time: HMAC-SHA256 both sides with SESSION_SECRET, then `timingSafeEqual`. |
| `APP_SHARED_PASSWORD_HASH_B64` | one of | Jeffrey's base64 bcrypt hash. If both are set, the hash wins. |
| `EVENT_TIMEZONE` | no | Defaults to `America/New_York`. Used for every displayed time and the CSV. |

Test runs use `.env.test` (committed, local-only values that point at `127.0.0.1`). Every test helper, reset script and seed **refuses to run** unless the Supabase URL host is `127.0.0.1` or `localhost`. Never read `.env.local`.

## 4. Domain model (`lib/domain.ts` is the single source)

### Statuses

The database values stay unchanged, and the UI labels are new.

| DB value | UI label | Colour | Glyph | Open | Notes |
|---|---|---|---|---|---|
| `Added` | Waiting for check | **blue** (`--blue-9`, text `blue`) | empty ring | yes | Jeffrey asked for blue. |
| `Checked – Not Found` | Not in medical | amber | filled circle with × | no | Final, no rechecks. "Change answer" can still flip it. |
| `Found – Awaiting Reunion` | In medical · friend coming | green | ring with ¾ pie | yes | |
| `Reunited – Closed` | Reunited | grey, dimmed | filled check | no | |
| `Found – Discharged` | Discharged | grey, dimmed | filled check | no | Kept (Jeffrey confirmed). Only from the ⋯ menu. |
| `Cancelled` | Cancelled | grey, dimmed | filled check | no | |
| `Bring friend to medical` | legacy, never written | treat like `Found – Awaiting Reunion` in the UI | | yes | |

### Transitions

These are enforced in the database. The client only offers what makes sense now.

| From | Allowed to |
|---|---|
| `Added` | `Checked – Not Found`, `Found – Awaiting Reunion`. `Cancelled` only through cancel. |
| `Checked – Not Found` | `Found – Awaiting Reunion` (change answer), `Added` (undo) |
| `Found – Awaiting Reunion` | `Reunited – Closed`, `Checked – Not Found` (change answer), `Found – Discharged`, `Added` (undo) |
| `Reunited – Closed`, `Found – Discharged` | `Found – Awaiting Reunion` (undo or Reopen) |
| `Cancelled` | `Added` (undo or Reopen, **creator only**: same check as cancel) |
| `Bring friend to medical` (legacy) | `Reunited – Closed`, `Found – Discharged`, `Checked – Not Found` |

A request that matches neither the current status nor these rules returns 422. **Idempotent repeat:** if the row is already in the target status (two liaisons tapped the same answer), return the row unchanged, with no audit event and no error.

### Timestamps

These are set inside the transition function.

- `found_at`: the first time ever moved into `Found – Awaiting Reunion`. Never overwritten or cleared.
- `reunion_started_at`: set to `now()` on **every** entry into `Found – Awaiting Reunion` (matches Jeffrey's behaviour), and cleared when moving to `Added` or `Checked – Not Found`.
- `closed_at`: set on entry into Reunited, Discharged or Cancelled, and cleared when moving back to an open status.

### Teams (sign-in order)

| Card label | Canonical value |
|---|---|
| GCHX Med Transpo | `GC/HX - Special Operations/Med Transpo` |
| Dispatch | `GC/HX - Dispatch` |
| GCHX Base | `GC/HX - Base` |
| Medical | `Medical` |

The "Other team" field takes free text of 2–80 characters. The UI shows the short label. **Data stores the canonical value** (the Other text too, through `canonicalTeam`: A28).

### Posts (reporting location)

| Value | Short form |
|---|---|
| `FA 3 – Kinetic` | FA 3 |
| `FA 4 – Oasis` | FA 4 |
| `Command` | Command |
| `Base` | Base |
| `Other` | uses `other_location`, 1–80 characters |

`domain.postShort()` produces the short forms.

### Staff identity and ownership

- **The session** holds `{staffName, team}`, with `team` as the canonical value.
- **The attribution string** (`created_by`, `updated_by`, audit `staff_name`) is `"${staffName} · ${canonicalTeam}"`. This is exactly Jeffrey's format, so existing rows stay compatible.
- **Canonical comparison:** `canon(s)` = lowercase, trim, collapse whitespace, and map known legacy team aliases to canonical. Implement it identically in TypeScript (`domain.canonStaff`) and SQL (`lp_canon_staff`), and unit-test both against the same fixtures.
- **"My requests"** is the union of two sets:
  - ids created on **this phone**, kept in IndexedDB
  - rows where `canon(created_by) === canon(sessionStaff)`
- **The creator check** for cancel and for reopening a cancelled request is server-side: `lp_canon_staff(created_by) = lp_canon_staff(p_staff)`.

### Fields and limits

Validated in zod and in SQL.

| Fields | Limit |
|---|---|
| name | ≤120 characters, split into `first_name` / `last_name` at the last space, like Jeffrey's |
| age | integer 0–120, or null |
| gender | `Male` / `Female` / `Other`, or null |
| clothing, hair, height_build, identifying_features | ≤300 characters |
| last_seen | ≤1000 characters |
| physical_description, additional_notes, contact_notes | ≤2000 characters |
| contact_name, contact_relationship | ≤120 characters |
| contact_phone | ≤40 characters. The UI shows a ✓ when it has 10–15 digits. |
| post | `Other` requires `other_location`, 1–80 characters |

Empty strings become null. Omitted keys mean "unchanged", and an explicit `null` means "clear".

## 5. Database

**Do not alter existing columns or constraints** (one exception, item 2). The real production schema is `supabase/schema.sql` plus Jeffrey's two migrations. It may also have legacy nullable columns from his removed check-in feature.

### Local migration chain

The Supabase CLI needs unique versions. Rename Jeffrey's files and keep their content.

| File | Purpose |
|---|---|
| `supabase/migrations/20261101000000_baseline_local_only.sql` | A copy of `schema.sql`. Header: "LOCAL ONLY — already applied in production. Never paste into production." |
| `20261105000001_add_last_seen.sql` | Jeffrey's, unchanged. |
| `20261105000002_update_locations_and_statuses.sql` | Jeffrey's, unchanged. |
| `20261106000000_rework.sql` | **The only file Jeffrey pastes into production.** |

`scripts/db-reset.sh` (local only, with the host guard) runs `supabase db reset` and then `supabase/seed.sql`. Prove a clean-volume start and reset before any feature work.

### `20261106000000_rework.sql`

It must be safe to paste into the production SQL editor once or twice.

- The whole file is wrapped in `begin; … commit;`.
- **Preflight:** a `do $$` block that raises a clear exception if `patients`, `audit_events`, `patient_photos` or `patients.client_mutation_id` are missing, or if the unique index or constraint on `client_mutation_id` is missing.
- At the end: `notify pgrst, 'reload schema';`.
- A comment at the top tells Jeffrey how to dry-run it: run it with `commit` replaced by `rollback` first.

**Steps:**

1. **Row version.** `alter table patients add column if not exists row_version bigint not null default 0;`
2. **Locations and statuses.** Re-add the location and status CHECK constraints idempotently, with `drop constraint if exists`, then `add … not valid`, using the values in §4 **plus every value already in the table** (A30). This is in case Jeffrey's 20261105 migration never ran in production. `not valid` alone does not keep legacy rows editable, because Postgres checks every later UPDATE.
3. **Touch trigger.** A `BEFORE UPDATE` trigger function, `lp_touch()`, sets `new.updated_at = clock_timestamp()` and `new.row_version = old.row_version + 1`. Install it with `create or replace trigger lp_patients_touch`. Using `clock_timestamp()`, the wall clock at the moment of writing, rather than `now()` keeps the cursor close to commit time. Also `create index if not exists patients_updated_at_idx on patients(updated_at)`.
4. **Thumbnails.** `alter table patient_photos add column if not exists thumb_path text;`
5. **Login attempts.** `create table if not exists lp_login_attempts(id bigserial primary key, ip text not null, name_key text not null, ok boolean, at timestamptz not null default now());` with indexes on `(ip, at)` and `(name_key, at)`. RLS on, no policies.
6. **Functions.** Before every create, run `drop function if exists <full signature>`. Every function:
   - is plpgsql, `security invoker`, with `set search_path = public, pg_temp` and schema-qualified names
   - sets `set local lock_timeout = '3s'` and `set local statement_timeout = '5s'`, which bounds how long a transaction can run, a requirement of the sync overlap below
   - locks the patient row with `FOR UPDATE` where it reads and writes
   - writes its audit row **in the same transaction**
   - has `revoke all … from public, anon, authenticated` and `grant execute … to service_role`

   It also grants `service_role` the table and sequence privileges it needs, explicitly.

   | Function | Behaviour |
   |---|---|
   | `lp_canon_staff(text) returns text` | Immutable. See §4. |
   | `lp_sync(p_since timestamptz, p_ids uuid[] default null) returns jsonb` | Returns `{serverTime: clock_timestamp(), rows: [...], versions?: [...]}`. If `p_ids` is given, it returns those rows. Otherwise, if `p_since` is null, every row (full), or rows with `updated_at > p_since - interval '10 seconds'`. Rows are slim (§6, RequestSummary) and include `first_photo_id` and `photo_count`, from a lateral subquery over active photos. When called with the reconcile flag (§7), `versions` = `[[id, row_version], …]` for all rows. Returning one jsonb value avoids the PostgREST row cap. |
   | `lp_create_request(p jsonb, p_staff text) returns jsonb` | `insert … on conflict (client_mutation_id) do nothing returning *`. If nothing was returned, select the existing row. Writes the `patient_created` audit **only on an actual insert**. Returns `{created: boolean, row}`. |
   | `lp_set_status(p_id uuid, p_expected_version bigint, p_status text, p_staff text, p_kind text) returns jsonb` | `p_kind` is `answer`, `change`, `reunite`, `discharge`, `undo` or `reopen`, used for audit labels. Locks the row. If it's already at `p_status`, return the row with `changed: false`. If `row_version ≠ p_expected_version`, raise `P0409` with `HINT` = current status. Check the transition table; illegal raises `P0422`. A creator-only rule failing raises `P0403`. Set the timestamps (§4). Audit action `status_changed`, `previous_value = {status, found_at, reunion_started_at, closed_at}`, `new_value = {status, kind}`. Returns `{changed, row}`. |
   | `lp_update_fields(p_id uuid, p_patch jsonb, p_expected_version bigint, p_staff text) returns jsonb` | Accepts only whitelisted keys: the editable fields in §4 plus `reporting_location` and `other_location`. Never status, identity or system fields. A version mismatch raises `P0409`. Diff each key against the row and skip equal values. If nothing changed, return `{changed: false, row}` with no audit. Validate the **merged** row (Other needs `other_location`; this is also the CHECK). Audit action `patient_updated`, with `previous_value` and `new_value` holding only the changed keys. |
   | `lp_cancel(p_id uuid, p_expected_version bigint, p_staff text) returns jsonb` | Creator check (`P0403`). Status must be `Added` (`P0422`). Version check (`P0409`). Sets `Cancelled`, `closed_at` and audit action `cancelled`. |
   | `lp_add_photo(p_id uuid, p_photo_id uuid, p_path text, p_thumb text, p_timing text, p_staff text) returns jsonb` | Locks the patient. **Idempotent** on `p_photo_id`: if it exists, return it with `created: false`. If there are 3 or more active photos, raise `P0429`. Insert with `id = p_photo_id`. Run `update patients set updated_by = p_staff where id = p_id`, which bumps `row_version` and `updated_at` so the change syncs. Audit action `photo_uploaded`. |
   | `lp_login_begin(p_ip text, p_name_key text) returns bigint` | Takes `pg_advisory_xact_lock(hashtext(p_ip))`. Counts failed and pending (null-ok) attempts in the last 15 min. Over 10 for `(ip, name_key)` or over 100 for the IP alone raises `P0429` with `HINT` = seconds until retry. Otherwise inserts a pending row and returns its id. Pending rows older than 1 min count as failures, so a crash can't leave a free retry. |
   | `lp_login_finish(p_id bigint, p_ok boolean)` | Sets `ok` on the attempt and deletes rows older than 1 day. |
   | `lp_stats() returns jsonb` | Returns everything the dashboard needs, defined in §8. |
   | `lp_detail(p_id uuid) returns jsonb` | The row, active photos, and audit events in ascending order. |

**Errors.** The server maps supabase-js `error.code` as follows. The HTTP status PostgREST itself returns is ignored.

| SQLSTATE | HTTP |
|---|---|
| `P0409` | 409 |
| `P0422` | 422 |
| `P0403` | 403 |
| `P0429` | 429 for login, 422 for photos |
| `P0002` / no row | 404 |
| any other | 503, with a generic message and an error id |

**Tests** cover a fresh database and an **upgrade fixture**: the baseline schema with an extra legacy nullable column, some rows, and Jeffrey's old audit formats (`patient_created` with full `new_value`, `medical_search`, `medical_search_found`, `check_completed`, and photos with `photo_timing = 'unsure'` and no thumbnail). Each test applies the migration, then **applies it again**.

## 6. Server API (`app/api/**`, Node runtime)

**Every route:**

- Returns `{error: {code, message, id?}}` on failure.
- Sends `Cache-Control: no-store`, except the photo redirect.
- Requires a session, except `POST /api/session`.
- **Mutations require same-origin.** The `Origin` header must equal the request origin (from the `host` / `x-forwarded-host` and `x-forwarded-proto` that Vercel sets); otherwise 403.
- Validates params and bodies with zod.
- Rejects JSON bodies over 64 KB.
- Logs only the route, error code, error id and timing. **Never** bodies or rows.

**Identity attribution comes from the session, never from the client.**

**The session cookie** is `lp_session`:

- HttpOnly
- `Secure` in production
- **SameSite=Lax**, so links opened from iMessage or Slack keep the session. The Origin check provides the CSRF defence.
- Path `/`
- A JWT (HS256) holding `{staffName, team, iat, sid}`. It expires 12 h after it was last refreshed: authenticated responses re-issue the cookie when the token is older than 1 h. Absolute cap: 36 h after the first sign-in (`sid` carries the original issue time).

**Routes:**

| Route | Behaviour |
|---|---|
| `POST /api/session` | Body `{staffName (2–60), team, otherTeam?, password}`. Client IP = the first of `x-vercel-forwarded-for`, then `x-real-ip`, then the leftmost `x-forwarded-for`, then `0.0.0.0`. These are set by Vercel's edge and can't be spoofed there. `name_key` = lowercased, trimmed name. Calls `lp_login_begin`, verifies the password, then `lp_login_finish`. Too many attempts returns 429 with `Retry-After`. Returns `{staffName, team, staff, expiresAt}` (`SessionInfo`, A27). |
| `GET /api/session` | Returns `{staffName, team, staff, expiresAt}` or 401. |
| `DELETE /api/session` | Clears the cookie. |
| `GET /api/sync?since=<iso>&reconcile=0\|1` | Calls `lp_sync`. The response is `{serverTime, rows: RequestSummary[], versions?}`. **No ETag or 304.** |
| `GET /api/sync?ids=<uuid,…>` | Returns specific rows (max 200), used by reconcile. |
| `POST /api/requests` | Body: the form fields plus `clientMutationId` (UUID, required). Calls `lp_create_request`. Returns 201 `{request}` when created, or 200 `{request}` when it already existed. |
| `GET /api/requests/:id` | Returns `RequestDetail` through `lp_detail`. |
| `PATCH /api/requests/:id` | Body `{patch, expectedVersion}` through `lp_update_fields`. |
| `POST /api/requests/:id/status` | Body `{status, expectedVersion, kind}` through `lp_set_status`. |
| `POST /api/requests/:id/cancel` | Body `{expectedVersion}` through `lp_cancel`. |
| `POST /api/requests/:id/photos` | Multipart with fields `photoId` (client UUID), `photo` and `thumb` (each sniffed by magic bytes: JPEG, PNG or WebP), and `timing` (`today` or `older`). **The whole request must be ≤ 3,900,000 bytes, because Vercel caps request bodies at 4.5 MB.** Upload to the private bucket at the stable paths `{patientId}/{photoId}.jpg` and `{patientId}/{photoId}_thumb.jpg` with `upsert: true`, so retries are idempotent. Then call `lp_add_photo`. Delete the objects **only** after a definitive rejection: `P0429`, `P0422`, `P0403` or 404. On timeouts and network or unknown errors, keep them, return 503, and let the client retry with the same `photoId`. Orphaned objects are acceptable. |
| `GET /api/photos/:id?size=thumb\|full` | Requires a session. Looks up the active photo; `thumb` falls back to `storage_path` when `thumb_path` is null. Responds with a 302 redirect to a 120 s signed URL and `Cache-Control: private, max-age=60`. |
| ~~`GET /api/export`~~ | **Removed in v2.5 (A50); see `docs/export.sql`.** Was: CSV. Columns, all times in the event timezone: case number, name, age, gender, status label, post, clothing, last seen, hair, height/build, identifying features, physical description, notes, contact name, phone, relationship, contact notes, created by, created, updated, found, closed. Quote **every** field and double embedded quotes. Prefix `'` when the value, after leading whitespace or control characters, starts with `= + - @`, or when it starts with a tab, CR or LF, or with the full-width `＝ ＋ － ＠`. Response headers: `Content-Disposition: attachment; filename="lost-persons-YYYY-MM-DD.csv"`, `no-store`. |
| `GET /api/stats` | Returns `lp_stats()`. |

**Delete Jeffrey's old routes** (`/api/login`, `/api/logout`, `/api/patients/**` and the old `/api/photos/[id]`) once the new ones replace them. Nothing external calls them.

### Proxy (`proxy.ts`)

- **Matcher:** every page path **except** `/api/*`, `/_next/*`, `/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/logos/*`, `/fonts/*` and `/favicon*`.
- **CSP** with a per-request nonce, passed to Next as a request header and set on the response:

  ```
  default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <SUPABASE_ORIGIN>;
  connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self';
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
  ```

- In development, add `'unsafe-eval'` to `script-src`.
- Pages that use the nonce render dynamically; that's expected.
- **Also send:**
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(self), geolocation=(), microphone=()`
  - `X-Frame-Options: DENY`
- **Auth redirect:**
  - `/` without a valid cookie goes to `/signin?next=…`.
  - `/signin` with a valid cookie goes to `/`.
- `poweredByHeader: false`.

## 7. Client architecture

### One route

The signed-in app is **one route, `/`**. List, Pending, My requests, the new-request form, the profile and the dashboard are **client views** chosen by search params: `/?view=pending`, `/?new=1`, `/?r=<id>`, `/?dashboard=1`.

- Navigate with `window.history.pushState` / `replaceState`. Next 16 integrates these with `useSearchParams`. **Never** use `router.push` for in-app views, because it fetches RSC payloads, which breaks offline.
- The back button and deep links work.
- The view components load with `next/dynamic`, and **every chunk is prefetched after the first idle**, so later offline use has them.
- `/signin` is a separate route.

### Store (`lib/client/store.tsx`)

A React 19 context provider in the `/` page that uses `useSyncExternalStore`, so screens subscribe with selectors. Polls must never re-render the form while someone is typing.

**What it holds:**

- `confirmed: Map<id, RequestSummary>`, the last server truth
- `pending: Map<id, Overlay>`, optimistic overlays for in-flight mutations
- `outbox`
- `connection: 'live' | 'offline' | 'error'`
- `lastSyncAt`
- `session`

**Persistence.** It persists `confirmed` plus the cursor to IndexedDB, under a key namespaced by event and canonical staff. On load it renders from the cache instantly, then syncs.

### Sync

- **Schedule:**
  - Every 6 s ±1 s of jitter while visible.
  - Every 60 s while hidden.
  - Immediately on focus, `online`, `pageshow` (bfcache) and `visibilitychange`, with bursts coalesced.
  - The next poll is scheduled after the previous one completes.
  - Each request has a 12 s timeout.
  - Never two polls at once.
  - Backoff on errors: 6, 12, 24 and 60 s.
- **Cursor.** `serverTime` from the response, which is the database clock. The client never uses its own clock.
- **Merge.** Rows replace `confirmed` when their `rowVersion` is greater than or equal to the stored one.
- **Reconcile.** Every 10th poll sends `reconcile=1`. The client compares `versions` and fetches any ids that differ or are missing through `?ids=`.
- **Full fetch.** On first load with an empty cache, or a cursor older than 6 h, fetch everything with no `since`. This replaces `confirmed` entirely; the outbox is untouched.
- **Connection state:**

  | State | When |
  |---|---|
  | `offline` | `navigator.onLine === false`, or 2 consecutive network or timeout failures |
  | `error` | 3 consecutive HTTP 5xx |
  | `live` | Any success |

  A 401 sends the user to sign-in (§7 Session).
- **Data use.** An empty delta is about 100 bytes.

### Mutations (all go through the store; screens never call fetch directly)

1. **Overlay.** Apply an optimistic overlay. Serialize mutations **per request id**: queue a second tap until the first resolves.
2. **Send.** Send with `expectedVersion` (the confirmed `rowVersion`) and a 10 s timeout.
3. **Success.** Replace `confirmed` with the returned row and drop the overlay.
4. **409.** Drop the overlay, fetch the row, show the toast "Updated by someone else", and refresh any open profile.
5. **Other failure or timeout.** Drop the overlay and toast "Couldn't save — check signal and try again". **Never** leave an optimistic state the server hasn't confirmed.
6. **Answer taps** (Not in medical, In medical, Reunited, Change answer) show a 6 s **Undo** snackbar. Undo sends the reverse transition with `kind: 'undo'` and `expectedVersion` = the version returned by the original mutation. The store owns both the tap and the snackbar; screens only call `store.setStatus(id, status, kind)`.

### Outbox (offline create)

- **When a create queues.** It's queued if the device is offline, or if the 10 s timeout or a network error hits.
- **Save first.** The item (the payload, its `clientMutationId`, the compressed photo blobs with their `photoId`s and timing, and the operator's staff string) is written to IndexedDB **before** the UI says "Saved on this phone".
- **No durable storage.** If IndexedDB is unavailable, offline save is **disabled** and the user is told to retry. Never keep it in memory only.
- **One worker.** It flushes in order through `navigator.locks.request('lp-outbox')`, with a BroadcastChannel fallback.
- **Each item.** Create (idempotent), then each photo (idempotent on `photoId`).
- **Uncertain results** are retried with the same ids.
- **Definitive 4xx rejections** stay in the outbox as **"Needs attention"** items the user can open, fix and resend, or discard.
- **Display.** Queued items appear at the top of the list ("Waiting to send · Not sent") and in My requests.
- **Session.** On 401 the outbox **pauses** and resumes after sign-in. If the new session's staff differs from the item's operator, ask "Send 2 requests saved by Dana Kim?" with Send / Discard.
- **Legacy import.** On first load, import Jeffrey's legacy `localStorage['edc_pending_queue']` items into the outbox, keeping their `client_mutation_id`s, then remove the key.

**Not in v1** (later phase): queued status changes, and photos added to *existing* requests while offline. Those buttons are disabled offline, with the reason "Needs a connection".

### Draft (new request)

The draft is the form values, the chosen photos as compressed blobs, the photo timing and the `clientMutationId`.

- It's saved to IndexedDB on each change, debounced at 300 ms, and restored on mount. This survives iOS reloading the page after the camera.
- It's cleared after a confirmed send or a queued save, or on Cancel (with a confirm when it isn't empty).

### Session handling

- The client learns `expiresAt` from `GET /api/session`.
- **On a 401:**
  1. Keep the cache and outbox.
  2. Navigate to `/signin?next=` with step 2 prefilled from the remembered name and team.
  3. After signing in, return and flush.
- **Offline.** A failed `GET /api/session` with no network is **not** treated as a 401. The cached list shows under the offline banner.
- **Sign out:**
  - It is refused while the outbox has unsent items, with the option to discard them explicitly.
  - Otherwise it clears the IndexedDB cache, the phone-created ids, drafts and the cookie.
  - The remembered name and team are cleared only if "Change" is used.

### Service worker (`public/sw.js`, scope `/`)

- **Cache name** includes the build id, injected at build. On activate, retire old caches: each is deleted once none of the pages open at activation is left, and until then `/_next/static` requests fall back to it (a tab still on the older build keeps loading its chunks offline).
- **Complete before "Update ready".** `next build` writes `public/sw-manifest.json`, every `/_next/static` file of the build (`scripts/sw-manifest.mjs`, run as `compiler.runAfterProductionCompile`). A worker installing over an active one caches `/`, `/signin`, the core files and every manifest file (unchanged hashed files are copied from older caches), and fails its install if any is missing, so the old worker keeps serving and the update is retried later. The first install is best effort.
- **Precache:**
  - the `/` shell HTML (the first successful 200 navigation response, **not** a redirect, `type === 'basic'`)
  - `/signin`
  - the manifest
  - icons, logos and fonts
- **Fetch strategies:**

  | Request | Strategy |
  |---|---|
  | `/_next/static/*`, fonts, logos, icons | cache-first |
  | Navigations | network-first with a 4 s timeout, then the cached shell |
  | `/api/*` | **never cached**, passthrough |
  | Redirect and opaque responses | never cached |

- **Updates.** When a new SW is waiting, show the toast "Update ready · Reload". Do not auto-reload while a draft or outbox item exists.
- **The cached `/` HTML contains no PII.** All data is client-fetched.
- **Gate:** reload offline, then open the new-request view offline, then queue a request. All three must work under the production CSP.

### Alerts (in-app only for launch)

- **Where.** They're hosted by the `/` page shell, so they work on every view.
- **No alert storm on load.** The first sync after load is the baseline and alerts nothing.
- **Which changes alert:**
  - **My requests:** any status change made by someone else.
  - **New requests by others:** only when the bell is on (localStorage, off by default).
  - **Never** for this phone's own mutations.
- **Deduplication.** Each alert is keyed by `(id, rowVersion)`. More than 2 at once after a reconnect combine into one toast ("3 updates").
- **Copy:**

  | Change | Toast |
  |---|---|
  | Moved to In medical | "LP-1004 · S.L. is in medical" / "Bring the friend to Main Med" |
  | Moved to Not in medical | "LP-1004 · S.L. — not in medical" |
  | Moved to Reunited | "LP-1004 · S.L. reunited" |
  | New request | "New request · LP-1013" / "T.R. 24 M · FA 4" |

- **Signals.** The toast is always shown (it carries the alert on its own). Add a WebAudio chime once unlocked by a gesture; it's silent under the iPhone mute switch, which is fine. Use `navigator.vibrate` only where it exists.
- **The bell sheet** (first time it's turned on): the heading "Alerts are on". It explains in one line that alerts show **while this app is open**, then the Home Screen tip. A Home Screen app has its own sign-in and its own saved requests, separate from the Safari tab. Don't promise lock-screen alerts.

### Theme

- Light / Dark / Auto, stored in localStorage.
- Applied before paint by a tiny **nonce'd** inline script that sets the Radix appearance class on `<html>`.
- The sign-in toggle sits at the top right. Inside the app it's in the avatar menu.
- Radix `Theme` with `accentColor="gray" grayColor="gray" radius="medium"`.

### Remembered on this phone

- the name and canonical team
- the last post (**no default** until one is chosen once)
- the theme
- the bell setting
- the phone-created ids

The app always opens on All.

### Photos

- **Decode.** Decode through an `<img>` element: `URL.createObjectURL`, then `decode()`. Current browsers honour EXIF orientation there. Draw directly into the target-size canvas, never a full-size canvas, because iOS caps canvas size.
- **Output:**
  - The full image at up to 1600 px on the long edge, JPEG quality 0.82. Step the quality down to 0.6, then reduce the dimensions, until it's ≤ 2.5 MB.
  - The thumbnail at up to 320 px, JPEG quality 0.7.
- **EXIF** is stripped by re-encoding.
- **Loading.** Lists and the profile load thumbnails; the viewer loads full images.
- **Limit.** Three photos at most.

### Performance

- First-load JS of `/`: the budget is in **A25** (the original ≤ 170 KB is below the framework baseline).
- Load the views with `next/dynamic`.
- Inputs use a 16 px font, which prevents iOS zoom.
- Sticky bars use `env(safe-area-inset-bottom)`.
- Use `100dvh` with a fallback.

### Accessibility

- Real buttons and labels.
- `aria-live="polite"` on toasts.
- Radix handles focus inside dialogs and sheets.
- Tap targets of 44 px or more.
- Contrast passes in both themes.

## 8. Screens: behaviour

The mockups are the visual spec. Only behaviour is listed here.

### Sign-in (`/signin`)

**Step 1:**

- Logos: EDC Orlando (inverted in dark mode) | divider | Ground Control (purple, full colour). The files are `public/logos/edc-orlando.png` and `public/logos/ground-control.png`, copied from `design/`.
- The small grey line "Is my friend in medical?", then the heading "Staff sign-in".
- The name field (person icon).
- "Your team": the 2×2 cards in §4 order, plus the "Other team" field.
- Continue, disabled until the name is 2 characters or more and a team is chosen.

**Step 2:**

- The logos, then "Enter the event password" (no app-name line).
- The filled identity row with a **Change** button, which goes back to step 1.
- The password field with show/hide. Include a hidden `username` field for Keychain.
- Sign in. A wrong password shows the red field state and "Incorrect password". A 429 shows "Too many attempts. Try again in N min".

**Both steps:**

- The bottom line: "Built by Jeffrey & Brian for Ground Control / Headliner Experience".
- The theme toggle at the top right.

Remembered name and team skip to step 2. `?next=` is honoured, and only same-origin paths are accepted.

### The `/` page shell

- **List views own the header:**
  - the title "Is my friend in medical?"
  - the live dot, which you **tap to sync now** (this replaces manual refresh); it's amber when offline, grey while loading
  - search, the bell and the avatar
- **Full-screen views** (new, profile, dashboard) render their own top bars.
- **The banners:** offline ("Offline · N waiting to send"), error ("Can't reach the log · Try again"), the "Update ready" toast and alerts.

### List views

- **View switcher.** The list title opens a menu: **All requests**, a divider, **Pending** (inbox icon) and **My requests** (person icon), each with its count. In Pending or My requests, a × goes back to All. Whichever view is active shows its name.
- **All:**
  - Chronological, newest first by `createdAt`.
  - Each row: the status glyph, name, age and sex, and the time. The time is `h:mm` for today; for an earlier day it's prefixed with the weekday, e.g. "Fri 9:58".
  - The second line: the status label in its colour · post · LP number.
  - Closed rows are dimmed.
  - Outbox items sit on top.
- **Status filter.** A filter chip under the switcher ("Not in medical ×") appears when it's opened from a dashboard tile or legend row. Combined with Pending and My requests, this replaces Jeffrey's status dropdown.
- **Pending:**
  - **Friend coming:** In medical rows, oldest first. Each card shows the friend's name, "from {postShort}", the time since `reunionStartedAt`, and **Reunited**.
  - **Waiting for check:** oldest first. Each card shows the thumbnail (`firstPhotoId`), name, age and sex, LP number and post, and the wait badge (grey under 10 min, amber at 10–19, red at 20 or more). Below that, a 2-line clothing / description line, then the **Not in medical** / **In medical** buttons.
- **My requests:** cards with the progress stepper, newest update first.
- **Rows and cards** open the profile (`?r=`).
- **Search.** The field takes over the header. Search is case-insensitive over name, clothing, last seen, physical description, identifying features, hair, post and the LP number ("1012" or "LP-1012"). Matches are highlighted and a result count is shown.
- **Empty states** and **skeletons:** skeletons only when there's no cache yet.

### New request (`?new=1`, also used for Edit through `mode="edit"`)

- **The "Reporting from" row** (pin icon, full width, first) opens the post picker sheet. Other shows a "Where?" field. With no remembered post, the row shows "Choose post" with a highlight, and Send is blocked until one is picked.
- **The ID card:**
  - The photo slot, which opens the file input (`accept="image/*"`, `multiple`, max 3). Once there are photos, a count badge and a Today / Not today tag that toggles on tap.
  - Name (placeholder "Name or initials, e.g. J.D.").
  - Age, with `inputmode="numeric"` and `pattern="[0-9]*"`.
  - Gender (segmented control).
- **Wearing**, then **Last seen.**
  - The stage chips (`kineticFIELD`, `circuitGROUNDS`, `neonGARDEN`, `stereoBLOOM`, `Taken to medical`) are visible while focus is **within the Last seen row container**.
  - A chip is handled on `pointerdown` with `preventDefault`, so focus stays and the tap isn't lost.
  - A tap appends the chip text, with ", " when the field isn't empty.
- **Friend or family:** Name, Phone (`type="tel"`, ✓ when valid) and Relation.
- **More details** opens Hair, Build, Features, Description, Contact notes and Other notes.
- **Send request** is enabled once any detail is filled in, **a photo counts**, and a post is set.
- **Sending:**
  1. It's a store mutation.
  2. Success shows the toast "LP-1014 saved" and returns to the list.
  3. If it queues, the toast reads "Saved on this phone · sends when back online".
  4. Photos upload after the create. A failed photo shows a toast with Retry, and the request stays.
- **Edit mode:**
  - Prefilled.
  - It sends only the changed keys, with `expectedVersion`.
  - On 409, it shows "Someone else just updated this. Your changes are kept below — review and save again." along with the latest data.
- **Duplicate hint** (cheap): if an open request has the same name (case-insensitive), show a small "Similar open request: LP-1009" chip that links to it. It's informational only.

### Profile (`?r=<id>`)

- **Immediate render.** It renders straight from the summary. Photos and audit show skeletons until `GET /api/requests/:id` loads.
- **Refetch.** The detail is refetched whenever the synced `rowVersion` for this id changes, so another liaison's answer shows within one poll.
- **Top bar:** ×, the LP number and ⋯. The ⋯ menu holds:
  - Edit details
  - Mark discharged, only when In medical
  - Reopen, only when closed; Cancelled → Waiting is creator-only
  - Cancel request, creator only while Waiting
- **Header:**
  - The portrait thumbnail with the photo count.
  - Name, age and gender.
  - The post and who logged it, in short form.
- **The status block** uses the status colour. It shows the wait badge while Waiting, and "Rae Chen · 11:10 · {friend} heading to Main Med" while In medical.
- **Missing person** and **Friend or family:** filled fields only, each with Edit. Phone has **Call** (`tel:`).
- **Photos:** thumbnails, then the full-screen viewer (swipe, "1 of 2", tag, who and when). Legacy photos with `unsure` timing show "Timing unknown".
- **Audit trail:** newest first, every event, with who (name · short team) and when (for example "Nov 6, 11:10 PM", event timezone).
  - Status changes appear as from → to, with glyphs.
  - Edits appear as a field label with old → new, the old value struck through. Name merges first and last name; Post merges location and other.
  - Photos added.
  - Logged, with the post.
  - Jeffrey's legacy actions are normalized: `medical_search` not found → "Not in medical", `medical_search_found` → "In medical", `check_completed` → "Not in medical (rechecked)". Full-row `previous_value`/`new_value` blobs are diffed to their changed keys.
- **Sticky actions by status:**

  | Status | Actions |
  |---|---|
  | Waiting | Not in medical / In medical |
  | In medical | Change answer / Reunited |
  | Not in medical | Change answer |
  | Closed | none |

  Offline: disabled, with "Needs a connection".
- **"Cancel request"** appears only for the creator while Waiting: red, at the bottom, with the confirm "Cancel this request?" and the buttons Keep / Cancel request.
- **Conflict.** The banner "Updated by someone else" is shown when a 409 or a background version change arrives mid-edit.

### Dashboard (`?dashboard=1`, from the avatar menu)

- **Data.** `GET /api/stats` every 15 s while open.
- **What `lp_stats` returns:**

  | Field | Definition |
  |---|---|
  | `open` | `{waiting, inMedical}` |
  | `notInMedical`, `reunited`, `discharged`, `cancelled` | counts over **all** rows |
  | `longestWait` | the oldest `Added` row: `{id, caseNumber, post, minutes}`, or null |
  | `avgAnswerMinutes` | the mean of (first audit `status_changed` from `Added` to `Checked – Not Found` or `Found – Awaiting Reunion`) − `created_at`, over answers that happened in the **last 2 h**. Null if there are none. |
  | `byPost` | open counts per post, Other grouped by `other_location` |
  | `recent` | the 5 most recently updated rows: `{id, name, status, updatedAt}` |

- **Layout** (as in the mockup):
  - The hero "Open requests".
  - The thin segmented bar: blue Waiting and green In medical, 2 px gap, rounded ends. Those two colours were checked with the palette validator in light and dark.
  - The legend: glyph, label, count. **Legend rows and tiles are tappable** and open All filtered by that status.
  - 4 tiles.
  - Open by post: single-hue grey bars 10 px tall, with a 4 px rounded end and the value at the tip. A post at zero draws no bar. Each bar is tappable and filters by post.
  - Recently updated.
  - Export CSV.

### Avatar menu

- The name and short team.
- Theme (Light / Dark / Auto).
- Dashboard.
- Export CSV. In an iOS standalone app it opens in a new tab.
- Sign out (with the outbox rule).
- "Built by Jeffrey Yu", the credit line kept from Jeffrey's original.

### States

- Skeletons
- Empty
- Offline banner
- Error banner with Try again
- The session redirect
- Conflict
- "Needs attention" outbox items
- The update-ready toast

## 9. Quality gates (all must pass before the PR)

1. **Build health.** `typecheck`, `lint` and `build` are clean. `npm audit --omit=dev` shows no high or critical issues. No secret strings appear in `.next/static` (grep for the service-role key prefix and `SESSION_SECRET`).
2. **Unit tests:**
   - domain: labels, transitions, `canonStaff`, `postShort`, name splitting, phone validation, wait thresholds
   - validation schemas
   - CSV escaping, including every injection prefix
   - the alert diff, baseline and deduplication
   - store merge and overlay rules
   - outbox state machine
   - the image size-step logic
   - time formatting in the event timezone
3. **Integration tests** (vitest against local Supabase, through a `next start` test server on port 3100 with `.env.test`). Each route covers the happy path, auth required and the Origin check. Plus:
   - validation 422s
   - every illegal transition
   - the idempotent repeat answer
   - a 409 on a stale version
   - cancel by a non-creator → 403
   - reopening a cancelled request by a non-creator → 403
   - the 4th photo → 422
   - **4 concurrent photo uploads → exactly 3 succeed**
   - photo retry with the same `photoId` → still 1 row
   - the photo upload bumps `rowVersion` and appears in sync
   - **concurrent identical creates → 1 row and 1 audit event**
   - login limits: per name+IP, per IP, concurrent attempts, and a forged `x-forwarded-for` that's ignored when the Vercel headers are present
   - the CSV injection guard
   - `lp_stats` numbers on the seed
   - the sync cursor: an update committed by a transaction that started before the read is still delivered (use two connections and `pg_sleep`)
   - the migration applied twice on a fresh database and on the upgrade fixture
4. **Playwright end-to-end** (`workers: 1`, unique synthetic names, global setup truncates `lp_login_attempts`, Chromium iPhone 14 plus WebKit):
   - sign-in: wrong password, rate-limit message, remembered step 2, Change
   - create a request with a photo
   - it appears in All and My requests
   - a second context (the liaison) sees it in Pending within 8 s and taps In medical
   - the first context gets the alert toast
   - Friend coming → Reunited
   - change answer
   - undo
   - cancel (creator only, with the confirm), and reopen
   - edit with audit diffs
   - a conflict (two contexts edit)
   - search
   - dashboard numbers, and a tile filtering All
   - the CSV download
   - **offline:** `context.setOffline(true)`, reload, open the new view, queue a request with a photo, go back online, it flushes with exactly one row and the photo present
   - **lie-fi:** route `/api/requests` to hang, the create queues after 10 s, and it flushes later
   - a draft survives a reload
   - session expiry: a 401 lands on step 2 and returns
   - theme persistence with no flash
   - SW update toast
5. **Visual check.** Screenshot every view and state at 390×844 in both themes and compare with the mockup PNGs side by side. Fix drift.
6. **Security review:**
   - every route checks the session and same-origin
   - the CSP and nonce work in a production build: hydration, dialogs and SW registration all succeed
   - the cookie flags are set
   - the bucket is private (an unsigned URL returns 400 or 403)
   - RLS is still on with no policies
   - `anon` can't execute the functions
   - no PII in logs (grep the test-run server logs for the synthetic names)
7. **Load check.** A script that runs 30 simulated clients polling sync for 2 minutes against the local production build. Report p50/p95 latency and errors. It must show zero errors.

## 10. Repo and handoff

- **Branch:** `rework/ui`.
- **Commits:** small, with clear messages.
- **The PR** goes to `main`, titled "Rebuild: Is my friend in medical? (EDC Orlando 2026)". Its description includes:
  - what changed
  - **Jeffrey's migration steps**: dry-run with rollback, then commit
  - the env vars
  - a **morning manual checklist** (§11)
  - known limits
  - the Vercel plan and region notes: pin functions to the Supabase region and enable Fluid compute, and confirm the invocation budget, which is about 6 requests per second at peak
- **Docs:** replace `HANDOFF.md`, update `README.md` and keep `DECISIONS.md` current.
- **Never commit** `.env*` files (except `.env.test` and `.env.example`), build output or test artifacts.

## 11. Manual checks tests can't cover (for the PR checklist)

- iPhone camera capture with the page surviving it
- Keychain fill on step 2
- a Home Screen app with its separate sign-in and storage
- the mute switch and the toast
- CSV in standalone
- a Vercel redeploy with an old tab open, so the update toast shows
- airplane mode in the middle of a send
- lie-fi
- Jeffrey's dry run of the migration
- venue NAT sign-in with several staff

## 12. Recorded exceptions versus DECISIONS.md

| DECISIONS.md said | Now |
|---|---|
| Manual refresh | Replaced by 6 s live sync, tap-the-live-dot, and Try again |
| Status filter / "tap a group header" | Replaced by Pending, My requests, and the dashboard tiles and bars, which open a filtered All |
| "Recently updated" sort | Replaced by the dashboard's Recently updated list |
| Offline photos | **Kept for new requests** (photos ride with the queued create). Photos added later and status changes while offline are deferred. |
| Cancel | Creator only (Brian). Server-checked through canonical `created_by`. "My requests" also includes ids created on this phone. |
| Reopen | Added to the ⋯ menu for closed requests (the transitions already allowed it) |
| Discharged | Confirmed by Jeffrey. Only from the ⋯ menu while In medical. |

**Exceptions versus this spec's own earlier text** are recorded as amendments in §15:

| Earlier text said | Now |
|---|---|
| §5 `lp_update_fields`: the audit holds "only the changed keys" | A35: a merged display field (name, post) is recorded whole, the unchanged half included |
| §4 idempotent repeat (implicitly only for settable statuses) | A36: holds for every current status, legacy included; the whitelist applies only to real changes |

## 13. v2.1 amendments (OVERRIDE anything above; from the Codex + Fable re-reviews)

**A1 · DTOs (frozen in `lib/api-types.ts`).**

- **Shape rule.** RPC payloads use snake_case. The server mapper converts them to camelCase through an **explicit allowlist**; legacy columns never leak through.
- **`RequestSummary`** contains every known `patients` column, camelCased:

  | Group | Fields |
  |---|---|
  | Identity | `id`, `clientMutationId`, `caseNumber`, `firstName`, `lastName` |
  | Person | `age`, `gender`, `heightBuild`, `hair`, `identifyingFeatures`, `physicalDescription`, `lastSeen`, `clothing`, `additionalNotes` |
  | Post | `reportingLocation`, `otherLocation` |
  | Contact | `contactName`, `contactPhone`, `contactRelationship`, `contactNotes` |
  | Status and audit | `status`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `foundAt`, `reunionStartedAt`, `closedAt` |
  | Added fields | `rowVersion`, `firstPhotoId`, `photoCount` |
  | Derived | `name`, `postShort` |

- **`RequestDetail`** = `RequestSummary` + `photos` + `audit`.
  - `photos: {id, timing: 'today'|'older'|'unsure', createdAt, uploadedBy, hasThumb}[]`
  - `audit: {id, action, at, staff, previous, next, notes}[]`, where `action` is the normalized union `created | status | edit | photo | cancelled | legacy_search_not_found | legacy_search_found | legacy_check`.
- **Mutation envelopes:**

  | Mutation | Response |
  |---|---|
  | create | `{created, request}` |
  | status / patch / cancel | `{changed, request}` |
  | photo | `{created, photo, request}` |

  `request` is always the **full** `RequestSummary`.

**A2 · `lp_row`.** One SQL function, `lp_row(p patients) returns jsonb`, builds the row JSON, including `first_photo_id` and `photo_count`. `lp_sync` and every mutating function return rows built by it. `lp_add_photo` returns `{created, photo, row}`.

**A3 · Status buckets** (in `domain.ts`).

| Bucket | Statuses |
|---|---|
| `open` | `Added`, `Found – Awaiting Reunion`, legacy `Bring friend to medical` |
| `answered` | `Checked – Not Found` |
| `closed` | `Reunited – Closed`, `Found – Discharged`, `Cancelled` |

Dimming and the Reopen action apply to `closed` **only**. Stats count legacy Bring-friend as In medical.

**A4 · Domain helpers.**

- `initials(name)`: the first letters of the first and last word, uppercased, with periods ("Kayla Martinez" → "K.M.", "T.R." → "T.R."). A single word keeps its first 2 letters.
- `genderShort`: Male → M, Female → F, Other → "".
- `parseStaff("Name · Team")` → `{name, team, teamShort}`.
- The legacy team alias map, identical in TypeScript and SQL `lp_canon_staff`:

  | Alias (case-insensitive) | Canonical |
  |---|---|
  | dispatch, gchx dispatch | `GC/HX - Dispatch` |
  | base, gchx base | `GC/HX - Base` |
  | med transpo, gchx med transpo, transport, special operations | `GC/HX - Special Operations/Med Transpo` |
  | medical | `Medical` |
  | prevent | `Prevent` |

  `canon` lowercases, trims, collapses whitespace, normalizes `•` and `·` variants to " · ", then alias-maps the team part.

**A5 · Store contract additions** (frozen in `lib/client/store-contract.ts`):

- `useDetail(id)`, which fetches and refetches automatically when the synced `rowVersion` changes
- `useStats(active)`, which polls every 15 s while true
- `signOut()`
- `prefs`: theme, bell, remembered name and team, last post, and get/set
- `subscribeAlerts`
- outbox: `list`, `retry(id)`, `discard(id)`, `update(id, payload)`, `resend(id)`
- `navigate(params)` and `useView()` (A22)
- `lastSyncAt` and `connection`
- `syncNow()`

**A6 · Outbox dedupe.** The list hides any outbox item whose `clientMutationId` matches a confirmed row. The worker then continues that item's photo uploads against the confirmed row's id.

**A7 · Sync bounds and paging.**

- **Bounding the transaction.** Mutating functions carry function-level `SET statement_timeout = '4s'` and `SET lock_timeout = '2s'` attributes in `CREATE FUNCTION`, which PostgREST hoists to the transaction. **Do not** rely on `SET LOCAL` inside the function body: it does not bound the running call (verified).
- **Overlap.** The overlap becomes **30 s**.
- **Cursor.** `serverTime` = `clock_timestamp()` captured as the first statement, before the select.
- **Backstop.** Reconcile every 10th poll guarantees delivery.
- **Signature.** `lp_sync(p_since timestamptz, p_ids uuid[], p_reconcile boolean, p_after_at timestamptz, p_after_id uuid, p_limit int default 500)`. Keyset paging on `(updated_at, id)` returns `{serverTime, rows, hasMore, next: {at, id}, versions?}`. The client loops through the pages and advances its cursor **only after every page is applied**.

**A8 · Triggers.** `lp_touch` uses `create or replace function`, never drop. The trigger uses `create or replace trigger`. `lp_canon_staff` is immutable and carries **no** SET attributes. `drop function if exists` applies only to RPC functions that no trigger depends on.

**A9 · Production coverage.**

- Add `alter table patients add column if not exists last_seen text`.
- **Only** replace the location or status CHECK when the current constraint definition (from `pg_get_constraintdef`) lacks a needed value. When re-adding it, use NOT VALID, and raise a NOTICE with counts of existing rows that would violate it.
- Test against a real pre-migration fixture: Jeffrey's original schema, with `last_seen` missing and the old constraint.

**A10 · Edit concurrency.**

- When editing starts, capture `{baseRow, baseVersion}`. `updateFields(id, patch, baseVersion)` sends **that** version.
- On a 409, show a conflict review: the latest data, with the user's edits kept for them to reapply. There is no automatic rebase.

**A11 · Monotonic responses and Undo.**

- Every mutation response is applied only if its `rowVersion` is at least the confirmed one.
- The Undo snackbar appears **only** when `changed === true`.

**A12 · Status-tap 409.** For non-undo taps:

1. On a 409, fetch the row.
2. If its status still equals the status the tap started from, which means only fields or photos changed, resend once with the new version.
3. Otherwise drop the overlay and show "Updated by someone else".

Never retry an undo automatically.

**A13 · Durable creates.**

- **Every create is an outbox job, online too, persisted before sending.** A job holds `{mutationId, payload, photos: [{photoId, blob, thumbBlob, timing, acked}], serverId?, state, attempts, operator}`.
- Checkpoint `serverId` and each photo acknowledgement. Remove the job only once it's complete.
- **Retry backoff:** 5 s, 15 s, 60 s, then every 2 min.
- **Definitive 4xx on the create:** the job becomes "Needs attention". It can be edited and resent with the **same** `mutationId`, since nothing was created.
- **Definitive rejection of a photo:** the job finishes, with a toast.
- Needs-attention items never block the queue.
- **Scope:** the outbox and drafts are **per phone**; the data cache is per staff.
- **Operator prompt:** "Send as Sam Lee?", because the server attributes requests to the current session.

**A14 · Logout boundary.**

- `BroadcastChannel('lp')` sends `logout`.
- A session `generation` counter increments on logout.
- Workers stop, and responses from an older generation are ignored.
- Memory and the IndexedDB cache are cleared in every tab.

**A15 · SW precache.**

- After first load, and after an idle prefetch of every view chunk, the client posts every `/_next/static/*` URL it has seen (from `performance.getEntriesByType('resource')` plus document scripts and links) to the SW, which caches them.
- The store exposes `offlineReady` once that's done.
- The cached `/` HTML response is stored **whole**, headers included, so its CSP nonce matches.

**A16 · Cookie `Secure`.** Set it when the request protocol (`x-forwarded-proto` or the URL) is `https`. Tests over http still work.

**A17 · Login limits and test isolation.**

- **Limits:** reject at `>= 10` for name+IP, and `>= 100` for an IP alone.
- **Locally,** the server also reads `x-vercel-forwarded-for` and `x-real-ip`. Integration tests send a **unique** fake IP per test and clean their own attempts. Nobody truncates globally.
- **Harness:** reads `PORT`.
- **Playwright:**
  - signs in once per file with `storageState`
  - takes a cross-process lock in globalSetup: `mkdir /tmp/lp-e2e.lock`, waiting up to 20 min, released in teardown
  - dashboard specs assert **deltas**, not seed totals
- **Offline and SW specs** run only in Merge 2 or QA, against a production build.

**A18 · Cancel visibility.** Show Cancel only on a canonical `created_by` match, not on the phone-created set alone.

**A19 · `lp_create_request`.** Select by mutation id first, then insert with `on conflict do nothing`. This keeps LP numbers from jumping on retries.

**A20 · Draft persistence.** Flush immediately when a photo is added and on `pagehide`, in addition to the debounce.

**A21 · Stats definitions.**

- `byPost`: the 4 fixed posts are always present, plus any other location with open rows.
- `recent`: `{id, caseNumber, name, status, postShort, updatedAt}`.
- **Answer events** are matched by the status in previous and new values, so Jeffrey's full-row events and legacy `medical_search*` events count.

**A22 · Navigation parameters** (`lib/client/nav.ts`: `navigate(params, {replace?})` and `useView()`).

| Params | View |
|---|---|
| none | All |
| `view=pending` | Pending |
| `view=mine` | My requests |
| `status=<db value>` | All, filtered by status (shown as a chip) |
| `post=<value>` | All, filtered by post (shown as a chip) |
| `q=<text>` | Search |
| `new=1` | New request |
| `r=<id>` | Profile |
| `r=<id>&edit=person\|friend\|all` | Edit |
| `dashboard=1` | Dashboard |
| `outbox=<mutationId>` | The needs-attention editor, rendered by `RequestForm` |

Unknown params are ignored.

**A23 · Final view entry points.** Phase 1a creates these with their final props. The page imports them through `next/dynamic`. Phase 2 agents edit **only** inside their own directory.

| File | Owner |
|---|---|
| `components/list/ListViews.tsx` (All, Pending, Mine, Search), `components/list/AppHeader.tsx`, `components/list/ViewSwitcher.tsx` | L |
| `components/request-form/RequestFormView.tsx` (new, edit, outbox), `RequestForm.tsx`, `PostPicker.tsx` | F |
| `components/profile/ProfileView.tsx` | P |
| `components/dashboard/DashboardView.tsx` | P |
| `components/account/AccountMenu.tsx` | P |
| `components/signin/SignInFlow.tsx` | B |

- **C (1b)** owns `app/page.tsx` (the shell, and the banner, toast and alert hosts), `components/ui/*` (only Sheet, Toast/Snackbar, Banner, StatusGlyph, Skeleton blocks and EmptyState) and `lib/client/*`.
- **1a** ships a placeholder `ListViews` that renders store rows, so Merge 1 can run its smoke test.

**A24 · Edit from the profile.** `?r=<id>&edit=person|friend|all` opens the full-screen `RequestFormView` with `mode="edit"` and a `section` prop showing only that group, prefilled.

## 14. v2.2 amendments (OVERRIDE anything above; from the Phase 1a review)

**A25 · First-load JS budget** (replaces §7 "≤ 170 KB").

- **Measured** on the production build (`npm run build:test`): every `<script src>` in the server HTML of the route, gzipped. Views loaded later through `next/dynamic` don't count.
- **Baseline at Phase 1a.** Next 16.4.5, React 19.3 and Radix Themes 3.3, shared by `/` and `/signin`, come to about 192 KB. `/` was 211.5 KB in total, and 20 KB of that loads only on `/` (about 12 KB of it is the stub store and its synthetic rows). 170 KB can't be met.
- **Budget:**
  - `/` total ≤ **230 KB** gzipped.
  - Route-only code (scripts `/` loads that `/signin` does not) ≤ **40 KB** gzipped.
- **Enforced** by `tests/e2e/first-load.spec.ts`.
- **C (1b):** the real `lib/client/store.tsx` must **not** import `store-stub` or `stub-data`. `store-contract.ts` no longer re-exports the stub. Only tests use it after 1b.

**A26 · History state.** `navigate()` passes a **fresh** state object (`{lpDepth}`) to `pushState` / `replaceState`, never a copy of `window.history.state`. Next 16 patches both; when the data already carries Next's `__NA` marker, the patch skips the router sync, so the URL changes but `useSearchParams` / `useView()` don't. Only ever change views through `navigate()` / `goBack()`.

**A27 · Sign-in response.** `POST /api/session` returns the same `SessionInfo` as `GET`, `{staffName, team, staff, expiresAt}`, with `expiresAt` taken from the `exp` of the cookie it just issued. `SignInResponse` = `SessionInfo`.

**A28 · Other team.** `signInSchema` maps the "Other team" text through `domain.canonicalTeam()`. "dispatch" becomes `GC/HX - Dispatch` and "prevent" becomes `Prevent`; unknown text stays as typed (whitespace collapsed). The session, `created_by`, `updated_by`, audit `staff_name` and the CSV therefore always hold the canonical team.

**A29 · Remembered on this phone** (`lib/client/prefs.ts`, frozen).

- **One module.** It has no React and no store dependency, and it is the only reader and writer of the §7 "Remembered on this phone" values:

  | Key (localStorage) | Holds |
  |---|---|
  | `lp-theme` | the theme; shared with the pre-paint `THEME_SCRIPT` |
  | `lp-identity` | `{name, team}`, both or neither |
  | `lp-last-post` | `{reportingLocation, otherLocation}` |
  | `lp-bell` | `'1'` when on |
  | `lp-bell-intro-seen` | `'1'` once the "Alerts are on" sheet has been shown (new pref `bellIntroSeen`) |

- **The store.** `state.prefs` starts as `readPrefs()`, and `setPref` writes through `writePref`. `setPref('theme')` applies the theme, so screens never call `applyTheme`.
- **SignInFlow** renders outside `StoreProvider`. It uses `readPrefs()` to skip to step 2 and to prefill after a 401, `writeRememberedIdentity(staffName, team)` with the `POST /api/session` response, `clearRememberedIdentity()` on Change, and `setThemePref()` for the toggle.
- **Phone-created ids** stay in IndexedDB with the cache. They are not prefs.

**A30 · Legacy CHECK values** (refines §5 step 2 and A9). When step 2 replaces a CHECK, the new one allows the §4 values **plus every value already in the table**, still NOT VALID, and the NOTICE names the extra values. It is also replaced when it lacks a value that rows hold.

- **Why:** NOT VALID only skips the one-off check of existing rows. Postgres checks every later UPDATE, and every `lp_*` write is an UPDATE. A legacy row (`reporting_location = 'FA 3'`, status `Found – Transported`) could otherwise never be answered, edited or given a photo.
- **New writes stay canonical:** `lp_clean_fields` and `lp_set_status` still refuse non-canonical values.
- **Covered** by the upgrade fixture in `scripts/verify-migration.sh`.

**A31 · byPost** (refines A21). After the 4 fixed posts, byPost has one entry per **other** location with open rows. Other is grouped by `other_location` (case-insensitive); a legacy post value stays as itself, with `postShort` = the value, as in `domain.postShort`. The counts always add up to `open.waiting + open.inMedical`.

**A32 · Patch post rule.** `requestPatchSchema` rejects only an **explicit** clear (`otherLocation` null or '') together with `reportingLocation: 'Other'`. `{reportingLocation: 'Other'}` on its own is valid ("omitted = unchanged"). `lp_update_fields` checks the merged row and raises P0422 `field:other_location` when the row has none.

**A33 · Needs-attention editor** (`?outbox=<mutationId>`).

- **Photos are read-only** there. `outbox.update(mutationId, payload)` replaces only the payload; to change photos, discard the job and log the request again.
- **Prefill** with `formValuesFromCreateBody(item.payload)`, the inverse of `toCreateBody`. Save with `outbox.update(id, toCreateBody(values, id))`, then `outbox.resend(id)`.
- **Legacy queue items** (`edc_pending_queue`) are converted at import by `createBodyFromLegacyQueueItem`, which joins `first_name` and `last_name` into `name` and keeps `client_mutation_id`.

**A34 · SESSION_SECRET.** There is one reader, `sessionSecretFromEnv()` in `lib/server/session-token.ts`, which trims the value. Both the proxy and `serverEnv()` use it, so a value pasted with a trailing newline can't cause a sign-in loop.

## 15. v2.3 amendments (OVERRIDE anything above; from the Phase 1a verification)

**A35 · Edit audit pairs** (a recorded exception to §5 `lp_update_fields` "only the changed keys").

- **Rule.** `previous_value` / `new_value` hold the changed keys, except that a merged display field is recorded **whole**:
  - a change to `first_name` or `last_name` records both
  - a change to `reporting_location` or `other_location` records both
- The unchanged half has the same value on both sides. Example: changing only the last name records `{first_name: "Dana", last_name: "Kim"}` → `{first_name: "Dana", last_name: "Lee"}`.
- **Why.** Each audit row can show "Name" and "Post" on its own. An edit of only `other_location` would otherwise carry no post to show (Other/'Gate' → Other/'Gate 2' has no `reporting_location` change). `domain.displayChanges()` merges the pairs and drops rows whose merged value didn't change.
- `AuditFieldValues` (`lib/api-types.ts`) documents this. The server's audit mapper passes the pairs through.

**A36 · Idempotent repeat covers legacy statuses** (refines §4 and `lp_set_status`).

- **Order.** `lp_set_status` locks the row, then returns `{changed: false, row}` when `status = p_status`, and only then checks `p_status` against the §4 values. A row in `Bring friend to medical` asked for `Bring friend to medical` returns `changed: false`, not `P0422 invalid_field`.
- **New writes stay canonical.** No status is written on that path, and any real change still has to name a §4 value. The API's `setStatusSchema` still accepts only settable statuses.
- **Covered** by `scripts/verify-migration.sh`, which checks a legacy-status repeat and a bogus target.

**A37 · Sync cursors in URLs** (refines §6 `GET /api/sync` and A7).

- **The problem.** Every cursor the database returns (`serverTime`, `next.at`) carries a `+` offset, because sessions run in UTC (`2026-11-06T23:10:04.123456+00:00`). Interpolated raw into a query string, the `+` decodes as a space, and every delta poll would 400. A 400 never moves the connection to `error`, so the list would silently stop updating.
- **Client.** Pass cursors verbatim and URL-encoded. Build every sync URL with `syncPath()` (`lib/client/api-paths.ts`), which uses `URLSearchParams`.
- **Server.** `syncQuerySchema` reads `since` and `afterAt` through `syncCursorSchema`. That schema restores a trailing ` hh:mm` offset to `+hh:mm` before the ISO check, as a tolerance only.

**A38 · Server render of the store** (refines §7 Store; frozen in `lib/client/store-contract.ts`).

- **Why.** `StoreProvider` renders on the server too: `AppShell` is a client component returned by a server page. `ShellBanners` and `ShellHosts` put store state into the HTML the service worker caches.
- **Pure construction.** Building the store starts nothing: no timers, fetch, IndexedDB, `navigator`, window listeners, BroadcastChannel or locks.
- **`AppStore.start?(): () => void`.** All side effects begin here. `StoreProvider` calls it from `useEffect`, and the returned function stops them. Stop and start again must work, because StrictMode runs effects twice.
- **`AppStore.getServerState?(): StoreState`.** It returns `createServerState(eventTimezone)`, the same object every time: connection `live`, empty outbox, session `unknown` and `DEFAULT_PREFS`. `useStoreSelector` passes it to `useSyncExternalStore` as the server snapshot. An offline reload of the cached shell therefore hydrates cleanly, then shows the offline banner. The real store implements it, because `state.prefs` starts as `readPrefs()` (A29), which differs between the server and the phone.

**A39 · Field errors in the needs-attention editor** (refines A33).

- `OutboxItem.lastError.field?` holds `ApiError.error.field` (camelCase), copied by the store on a definitive 4xx.
- `RequestFormProps.errors?` is a `Partial<Record<keyof RequestFormValues, string>>` shown on the matching inputs.
- `formErrorsFromField(field, message)` (`lib/client/form-values.ts`) builds it. `firstName` and `lastName` map to `name`, and fields the form doesn't show give `{}`, so the view falls back to a `notice`.

## 16. v2.4 amendments (OVERRIDE anything above; from the integrated QA)

**A40 · One alert toast per request** (refines §7 Alerts).

- **The problem.** The In medical toast stays until dismissed, and toasts were only replaced when their text matched. After a Change answer or an Undo, front of house kept the green "is in medical / Bring the friend to Main Med" toast while the row said Not in medical.
- **Rule.** Alert toasts are keyed by request id. A new alert for a request replaces that request's earlier toast. Whenever synced or own rows merge, any status alert toast whose row is no longer in the status it announced closes (`alerts.ts` `alertStillCurrent`; In medical includes legacy Bring friend). That covers changes that raise no alert too: this phone's own tap, or the same staff on another phone.
- **Batches.** When one sync brings two changes of the same request, only the latest alerts, and an alert already out of date when it is shown is dropped.

**A41 · Undo after another change of the same request** (refines §7 Mutations 6 and A12).

- When any other mutation of the same request commits on this phone (another answer, Discharge, edit, cancel, photo), the earlier Undo snackbar and its record are dropped, because its `expectedVersion` can only 409.
- An Undo queued behind such a mutation sends nothing. A 409 on an Undo says "Updated by someone else" only when someone else made the change; when this phone, or the same staff on another phone, made it, the toast is "Can't undo — it changed since". An Undo is still never retried.

**A42 · Dashboard post bars open the open requests they count** (refines §8 Dashboard and A22).

- New navigation parameter `open=1`, honoured only together with `post=`: All filtered by post and to the `open` bucket (Waiting, In medical, legacy Bring friend), which are exactly the rows the bar counts (`lp_stats` byPost). Each bar opens `?post=<key>&open=1`.
- The list shows an "Open" chip next to the post chip. The post chip's count matches the bar. Clearing Open shows every request at the post; clearing the post goes back to All.
- **Open question for Brian.** The spec did not say whether a bar should open open requests only or every request at the post. Open-only was chosen because the bar's number and the list must agree.

**A43 · Test hygiene and checks** (refines §9 and A17).

- **Sign-in.** Playwright specs sign in through `POST /api/session` once per identity and reuse its `storageState` (`tests/e2e/helpers/session.ts`). No spec mints a session cookie. Each sign-in sends its own fake client IP, so login limits never carry over.
- **Integration rows.** The harness closes every request a test file created when the file ends (Waiting → Cancelled, In medical → Reunited). Photo fixtures are decodable images (`tests/helpers/images.ts`).
- **CSP smoke.** `scripts/smoke-csp.mjs` waits for the view switcher by test id, and `tests/e2e/smoke.spec.ts` runs it, so it can't go stale.

**A44 · Photo objects are immutable** (replaces the paths and `upsert: true` in §6 `POST /api/requests/:id/photos`; from the security review).

- **The problem.** With `upsert: true` the objects were overwritten before `lp_add_photo` checked idempotency. A replay of an existing photoId with other bytes changed the image while SQL returned `created: false`: no attribution, rowVersion or audit change.
- **Rule.** A stored photo object never changes.
  1. If a photo row with this `photoId` exists, the route answers from `lp_add_photo` (`created: false`, or 422 `photoId` when it belongs to another request) without touching storage.
  2. Otherwise it uploads to **content-addressed paths**, `{patientId}/{photoId}-{sha256}.jpg` and `{patientId}/{photoId}-{sha256}_thumb.jpg`, each hashed over its own bytes, with `upsert: false`. An object that already exists there holds the same bytes, so it counts as stored. That is the retry after a failed record or a partial upload.
  3. Definitive rejections from `lp_add_photo` still delete the objects, and 503s still keep them for the retry, as in §6.
- **Why hash the path.** Storage's `upsert: false` does not serialise concurrent writers. Two uploads to one path both succeed and the last one wins (checked against the local storage-api v1.60). With the hash in the name, other bytes always get another path, so a recorded row's object can't change even under a race. A losing upload is left as an orphan, which §6 allows.
- **Other bytes under an unrecorded photoId** (only the sending phone knows it) are stored beside the earlier objects and recorded as sent, attributed and audited to their sender.
- `GET /api/photos/:id` reads the path from the row, so legacy and seed photos are unaffected. `lp_add_photo` only checks the `{patientId}/` prefix and the 200-character limit; these paths are at most 148 characters.

## 17. v2.5 amendments (OVERRIDE anything above; product decisions of 2026-11-06 morning)

Brian and Jeffrey decided these after the app went live (`design/DECISIONS.md` "v2.2 (2026-11-06 morning)"). The visual spec is `design/screens/polish-v7.html` with its renders `v7-log.png`, `v7-dash.png` and `v7-laptop.png`, polished with the patterns in `design/references/mobbin-lists-dashboards.txt`. Where the mockup CSS misses WCAG AA or 44 px targets, the accessibility rules of `DECISIONS.md` ("Accessibility pass") still win. Numbering continues from A44, because A25–A44 are already taken by §14–§16.

**A45 · Not in medical is closed** (replaces the A3 bucket table; Jeffrey, texts 09:11–09:13).

| Bucket | Statuses | Colour |
|---|---|---|
| `open` | `Added` (Waiting for check); `Found – Awaiting Reunion` and legacy `Bring friend to medical` (In medical · friend coming) | blue; green |
| `closed` | `Checked – Not Found` (Not in medical), `Reunited – Closed`, `Found – Discharged`, `Cancelled` | grey |

- There is no `answered` bucket: `StatusBucket = 'open' | 'closed'` (`lib/domain.ts`, already at b48718a).
- Not in medical has tone `gray` and keeps its own glyph: a filled grey circle (`--gray-8`) with a × cut out in the background colour, the same circle as the closed ✓ (Reunited, Discharged) and – (Cancelled) glyphs. Its label is grey wherever it shows (rows, tiles, the profile status block, the audit trail, alerts).
- Only the two open statuses carry colour: Waiting is a blue ring (`--blue-9`, label `--blue-11`), In medical a green ring with a ¾ pie (`--green-9`, label `--green-11`).
- Behaviour is unchanged: Not in medical still offers **Change answer** (`primaryActions`), Reopen is still only for Reunited, Discharged and Cancelled (`menuActions`), Pending already left it out, and A42's `open=1` already meant the `open` bucket.
- Dimming (closed text at `--gray-11`, faded glyph and photo) now applies to Not in medical rows and cards too.

**A46 · All requests is log option B** (replaces the §8 "All" bullets; Brian + Jeffrey picked B).

- **Order.** Outbox items on top (unchanged). Then every `open` row, newest first by `createdAt` (ties: higher `caseNumber` first). Then one **Closed N** row, collapsed when the view opens; expanding it shows every `closed` row below it, newest first, in the same row component with name and status in secondary grey.
- **The fold** is a plain row, not a card: "Closed" (15 px, medium, secondary), N in a grey capsule (`--gray-a3`, 12 px medium, min-width 22 px, height 20 px, 7 px side padding) and a chevron pinned right that turns 180° when open. It is one `<button aria-expanded aria-controls>`, at least 44 px tall (52 px in the mockup), whose accessible name says the count in a sentence, e.g. "Closed requests, 6. Show them."
- **Filters.** The post and status chips (A22, A42) filter first, and the open/closed split applies to what is left; N counts the closed rows the view would show. Pending, My requests and Search keep their own layouts. *Open question for Brian:* whether a closed-status filter from a dashboard tile should open the fold by itself.
- **Column headers** "#", "Friend", "Status", "Created", "Updated" sit above the rows (11 px medium). They are `aria-hidden`, because each row's accessible name says everything in full.
- **Bottom padding** equals the New request button's height plus 16 px, so it never covers the last row or the fold.

**A47 · Log row columns** (replaces the §8 "Each row" and "second line" bullets; Jeffrey asked for the number and both times, Brian + Jeffrey picked AM/PM).

- **One line per row**, at least 48 px tall, no full-width rules (a hairline inset to the name column at most). Left to right, with 16 px side margins:

  | Column | Content | Rule |
  |---|---|---|
  | # | `caseNumber` as plain digits: "1013" | Leftmost, fixed width, 13 px medium, secondary grey, tabular figures |
  | Friend | `name` (the missing person) | The **only** cell that may truncate, with an ellipsis |
  | Status | the 14 px glyph and `shortLabel` ("Waiting for check", "In medical", "Not in medical", "Reunited", …) | Never truncates; colour per A45 |
  | Created | `createdAt` | Right-aligned, sized to its content, secondary grey, tabular figures |
  | Updated | `updatedAt` relative to now | Right-aligned, fixed width, tertiary grey, tabular figures |

- **Created.** `h:mm AM/PM` in the event timezone when `createdAt` is on the same event-timezone day as now ("11:02 PM", "9:58 AM"); for an earlier day, the short weekday first ("Thu 11:02 PM"). This replaces §8's "h:mm".
- **Updated.** "—" when nothing has been saved since the request was logged (`updatedAt` within 1 s of `createdAt`). Otherwise whole units, rounded down, never "ago": under 1 minute "now", under 60 minutes "2m", under 24 hours "1h", then days "3d".
- **Accessible name** of a row, in full: "LP-1013, T.R., Waiting for check, logged 11:02 PM, not updated since." or "…, updated 2 minutes ago."
- The same row, without Created, is the dashboard's Recently updated row (A48).
- Check at 375 and 390 px wide, light and dark, that no cell but the name overflows (`scrollWidth > clientWidth`).

**A48 · Dashboard global view** (replaces the §8 Dashboard layout; Jeffrey 09:13, "Lgtm" on the metrics 09:33).

- **Data** is unchanged: `GET /api/stats` every 15 s while open, plus the two new fields (A49).
- **Order on a phone:**
  1. **Status tiles**, 2 columns, 8 px gutter, filled (`--gray-a3`), no borders, 12 px radius, each label led by its status glyph. Row 1: **Open** (`open.waiting + open.inMedical`, 34 px digits, with a 4 px split bar: blue Waiting and green In medical in proportion, 2 px gap) and **Closed** (`notInMedical + reunited + discharged + cancelled`, 34 px, grey). Row 2: **Waiting for check** and **In medical**. Row 3: **Not in medical** and **Reunited**. Discharged and Cancelled have no tile of their own; they count in Closed. Status tiles open All filtered by their status (A22). There is no legend.
  2. **Open by post**: each post's label above a 6 px bar on a faint full-width track, the count in a fixed right column, scaled to the busiest post; a zero draws only the track. Order and grouping as A31; each bar opens `?post=<key>&open=1` (A42).
  3. **Recently updated**: the 5 rows of `recent` in the A47 row (number, name, status, updated); each opens the profile.
  4. **Performance**, last: rows, not tiles, with inset hairlines. Label left (icon, label, a small grey qualifier), value right (17 px semibold digits, 13 px unit):

     | Row | Value | Qualifier |
     |---|---|---|
     | Longest wait | `longestWait.minutes` | its number and post, e.g. "1010 · FA 4" |
     | Time to answer | `avgAnswerMinutes` | "avg, 2 h" |
     | Time to reunite | `avgReuniteMinutes` | "avg" |
     | Logged | `loggedLastHour` | "last hour" |

     A null value shows "—". Minutes show rounded to whole minutes with the unit "m".
- **Laptop or iPad (Command)**, as `v7-laptop.png`: the six tiles in one row (Open, Waiting for check, In medical, Closed, Not in medical, Reunited), Open by post and Recently updated side by side, and Performance in two columns.
- **Export CSV is gone** from the dashboard (A50).

**A49 · `lp_stats`: `avgReuniteMinutes` and `loggedLastHour`** (the Performance rows; the contract is in `lib/api-types.ts` since b48718a).

- **`loggedLastHour`**: the number of requests whose `created_at` is in the last 60 minutes (`> clock_timestamp() − 60 min`), any status.
- **`avgReuniteMinutes`**: the mean, in minutes rounded to 1 decimal, over reunions in the **last 2 hours**; `null` when there are none.
  - **A reunion** is, for a request that is `Reunited – Closed` now, its latest audit `status_changed` with `new_value.status = 'Reunited – Closed'`, when that happened in the last 2 hours. After an Undo or a Reopen the request is not Reunited, so it does not count until it is reunited again.
  - **It is measured from** the latest In medical answer at or before it: a `status_changed` from `Added` or `Checked – Not Found` (`previous_value.status`) into `Found – Awaiting Reunion` or legacy `Bring friend to medical` (`new_value.status`), or a legacy `medical_search_found`. So Change answer restarts the clock, while the Undo of a Reunited (which comes from `Reunited – Closed`) and a Reopen do not. Jeffrey's full-row events match on the same `status` keys.
  - A reunion with no In medical answer before it (a direct database write) is left out.
- **Computed like `avgAnswerMinutes`:** from the audit events, in the same `STABLE` snapshot as every other number, with `v_now = clock_timestamp()` captured once and the function-level `statement_timeout = '4s'` and `lock_timeout = '2s'`.
- **Migration.** `lp_stats` is now `create or replace` (no longer dropped first), so the rework file stays one transaction, keeps its preflight and is safe to run again on a database that already has every `lp_*` function. **Production needs the file applied again**, dry run first (`HANDOFF.md`).
- **Tests.** `tests/integration/stats.test.ts` checks both fields through the API against an independent recomputation from the raw audit trail, and checks exact values (the null case, Change answer, Undo, Reopen, Discharged, legacy events, the 2 h and 60 min edges, rounding) on a scratch database built from the migration chain.

**A50 · No CSV export in the app** (replaces §6 `GET /api/export`, the §8 Export CSV entries, the §9 CSV gates and the §11 "CSV in standalone" check; Brian removed the button).

- **Removed:** `app/api/export/route.ts`, `lib/server/csv.ts`, `tests/integration/export.test.ts`, the export cases in `tests/integration/security.test.ts`, the Export CSV items in the avatar menu and on the dashboard (`components/account/export-csv.ts`), and the e2e CSV download test. `GET /api/export` now reaches the unknown-route handler: a JSON 404 `{error: {code: 'not_found'}}`, `no-store`, with or without a session (asserted in `security.test.ts`).
- **`docs/export.sql`** is Jeffrey's end-of-event export from the Supabase SQL editor ("Download CSV" on the results). Its top comment gives the 3 steps. Two read-only selects:
  1. **Requests**, one row each, ordered by case number: case number (`LP-####`), name (initials or full), age, gender, height/build, hair, identifying features, physical description, clothing, last seen, notes, reporting location, other location, contact name, phone, relationship and notes, the status label and its database value, the created, updated, found, reunion-started and closed times in `America/New_York` (`YYYY-MM-DD HH24:MI:SS`), and created by and updated by.
  2. **The audit trail**, one row per event, joined to the case number, ordered by case number then time: when, staff, action, from and to status, kind, notes, and the raw previous and new values.
  - Text a spreadsheet could run as a formula gets a leading `'`, by the old CSV's rule: = + - @ or their full-width forms after any leading whitespace or invisible characters, or a leading tab, CR or LF.
- **Tests.** `tests/unit/export-sql.test.ts` lexes the file: exactly two `WITH … SELECT` statements, no statement or function that writes, locks or changes a setting, only `patients` and `audit_events`, every old CSV field. `tests/integration/export-sql.test.ts` runs both queries on the local database in a `READ ONLY` session and checks the rows, the New York times, the LP numbers and the formula guard with every injection prefix.
- **HANDOFF** checklist: "At the end, run docs/export.sql in the SQL editor and download the results" replaces the Export CSV check.

**A51 · Header declutter** (replaces the §8 "The `/` page shell" header bullets and the header part of the A23 `AppHeader`; Brian's v6 declutter, Brian + Jeffrey final).

- **The view switcher is the large page title**: the view name (28 px bold), its count (28 px regular, tertiary grey, no badge) and a small chevron on one baseline, as one menu button: "All requests 13 ⌄". The menu (§8 View switcher) is unchanged.
- **The app name leaves the list header.** "Is my friend in medical?" stays on sign-in and as the document title.
- **Right side:** search and the avatar only.
- **The alerts bell moves into the avatar menu** as an Alerts on/off item. Everything the bell did stays (§7 Alerts, the iPhone Home Screen intro, `lp-bell`).
- **The live dot only appears when the app is offline or reconnecting** (`connection` is `offline` or `error`; amber when offline). While live it is not rendered. Tapping it still syncs now, and the offline and "Can't reach the log" banners are unchanged.
- **"Newest first" goes.** The order is A46's.

**A52 · System notifications for alerts, by device** (extends §7 Alerts and A51; `design/DECISIONS.md` v2.2 row 10; Brian, 2026-11-06: "alerts should depend on the device — if it's desktop use regular notifications through Chrome"). **No server change:** no Web Push, no VAPID keys, no new route or table. The page that sees the change shows the notification through its own service worker registration, so it works only while the app is open (a background tab or a minimised window counts). Code: `lib/client/system-notify.ts`, which the store loads with `import()` after start, so the first load (A25) does not grow.

- **Supported** when `'Notification' in window` and the page has an active service worker registration (`navigator.serviceWorker.ready`; none in development) **whose worker handles notification clicks**: the page posts `{type: 'lp-caps'}` to `registration.active` and waits up to 5 s for `{notificationClick: true}`. The worker of a build before A52 has no `notificationclick` handler and never answers, and right after the deploy every laptop that used the app still runs it (navigations are network first, so the new page loads while the new worker waits for "Update ready · Reload"); a notification shown then would do nothing when clicked, so the page keeps toasts until this build's worker is active. It asks again on `controllerchange`, and on focus or `visibilitychange` while it has no answer. Not supported either: **a Safari tab on iPhone or iPad** (iPhone, iPad or iPod in the user agent, or `MacIntel` with touch points, and not standalone). That is desktop Chrome, Edge, Firefox and Safari, Android Chrome, and the iPhone Home Screen app (iOS 16.4+). Always `registration.showNotification()`, **never the `Notification` constructor** (Android Chrome throws). An unsupported device keeps today's toast + chime and is never prompted; its avatar menu and sheets are unchanged.
- **Permission** is asked only inside a tap, never on load:
  - turning **Alerts** on in the avatar menu, while the permission is still `default`;
  - a one-tap **Allow notifications** row, on supported devices, in the avatar menu (under Alerts) and in the "Alerts are on" sheet. It is there with Alerts off too, because "my request was answered" alerts always run.

  `granted` shows **System notifications on**. `denied` shows a quiet, grey **Blocked in browser**, with no button and no instructions, and the app never asks again (a screen reader hears "System notifications are blocked in this browser."). On supported devices the sheet shows this row instead of the iPhone Home Screen tip. The permission is re-read on focus, on `visibilitychange`, and on the Permissions API `change` event where the browser has one, so a change in the site settings shows without a reload.
- **Delivery** (`routeAlert`, decided once per batch in the store's `emitAlerts`, after the existing filters):

  | Permission | Page | Alert |
  |---|---|---|
  | not `granted`, or unsupported | any | toast + chime (as before) |
  | `granted` | `document.visibilityState === 'hidden'` | system notification |
  | `granted` | visible, desktop (`(hover: hover) and (pointer: fine)`), `document.hasFocus()` false | system notification |
  | `granted` | visible and focused, or a phone in front | toast + chime |

  **Never both.** A notification has no toast and is not passed to `subscribeAlerts` listeners (no chime, no vibration: the system plays its own sound). If `showNotification` fails (the permission was withdrawn, the worker is gone), the toast + chime carry that alert instead.
- **Content** (the lock screen and the notification centre see it):

  | Alert | Title | Body |
  |---|---|---|
  | My request moved to In medical | "LP-1004 · In medical" | "S.L. · FA 3", then "Bring the friend to Main Med" |
  | Any other status change of my request | "LP-1004 · Not in medical" (the status's short label: Reunited, Waiting for check, Cancelled, …) | "S.L. · FA 3" |
  | New request (Alerts on) | "New request · LP-1013" | "T.R. · FA 4" |
  | 3 or more at once | "3 new requests" when all are new, else "3 updates" | the LP numbers, up to 4, then "+N" |

  Initials and the post only. **Never** a phone number, the contact's name, relation or notes, the full name, the age or the gender.
- **Options:** `tag` = the request id (`lp-alerts` for a combined one), so a later alert for the same request replaces it; `renotify: true` on every alert, so each one sounds as its chime would (a changed answer must not silently replace "In medical"); `requireInteraction: true` for In medical, sticky like its toast; `icon` `/icons/icon-192.png`; `data: {url, key}`, where `url` is `/?r=<id>` (`/` when combined) and `key` is the alert's `(id, rowVersion)`.
- **Dedupe and staleness.** The `(id, rowVersion)` dedupe and the "more than 2 at once combine" rule are unchanged; routing happens after them, so a burst is one notification. A notification with the same `key` already showing (another tab of the same browser) is not shown again.
- **Across tabs and windows of one browser** (each has its own store, sync and dedupe, so each raises the same alert). With system notifications on (supported and `granted`), two `localStorage` records keep "never both" across them; toast-only tabs are as before.
  - `lp-alerts-front` `{tab, until}`: the app tab in front (visible, and focused on a desktop) claims it while it is signed in and past its baseline sync, refreshed every 10 s, released on blur, `visibilitychange`, `pagehide` or sign-out, and expiring after 30 s if the tab dies. A tab that is not in front shows **nothing** for an alert while another tab holds the claim: that tab raises the same alert from its own sync (every 6 s) and toasts it. So the list in the focused window and the dashboard in a second, unfocused window give one toast, not a toast and a notification.
  - `lp-alerts-delivered` `{"<id>:<rowVersion>": until}`: every alert key a tab delivered (toast or notification), kept 10 minutes, recorded before it is shown. A tab that raises one of them later (it polled later, or has come to the front since) shows nothing for it; a combined "N new requests" counts only what the tab shows. Cleared on sign-out.

  `localStorage` blocked: each tab decides alone, as before. A status notification is closed, by its `key` only (never a newer one of the same request), when its alert goes out of date (`alertStillCurrent`, as for the toast) and when the next alert for that request is shown as a toast. Sign-out and a different staff signing in close every notification of the app.
- **Click** (`public/sw.js`, `notificationclick`): close the notification, then pick an open window of the app (the focused one on `/`, else any on `/`, else another page such as `/signin`) and `focus()` it. A window on `/` is sent `{type: 'lp-open', url}`; the page (`openFromNotification` in `lib/client/system-notify.ts`) opens that view in place with `navigate` (no reload, so an open form or sheet keeps its state) and answers `{ok: true}`. A window that is not on `/`, or does not answer within 1.5 s (an older build), is `navigate()`d to the URL. With no window, or if navigation is refused, `clients.openWindow(url)`. The worker also answers `{type: 'lp-caps'}` with `{notificationClick: true}` (see Supported). The worker's precache, fetch and update behaviour is unchanged.
- **Limits** (`HANDOFF.md` Known limits): a background tab polls once a minute, so a notification can be up to a minute late; phones freeze background pages (iPhone almost at once, Android Chrome after a few minutes), so phone notifications are best effort and desktop is the main use.
- **Tests:**
  - `tests/unit/client/system-notify.test.ts`: the support matrix (a mocked `Notification`, service worker registration and visibility; an iPhone tab and Home Screen app, iPad, Android, macOS), an active worker that does not answer `lp-caps` (an older build: toasts until `controllerchange`), permission requests (asked once, never when denied or unsupported), routing, the content (no contact details), two tabs sharing one `localStorage` (the front claim, delivered keys, expiry, toast-only tabs unchanged), and the browser host with stubbed globals (the `lp-caps` round trip over a real `MessageChannel`).
  - `tests/unit/client/store-notify.test.ts`: through the real store, never both, the combine and dedupe rules, the toast fallback, closing stale notifications, and two real stores as two tabs (the focused one toasts, the other shows nothing; all in the background, one notification).
  - `tests/unit/client/notify-open.test.ts` and `tests/unit/sw/notification-click.test.ts`: the click, on both sides, and the worker's `lp-caps` answer.
  - `tests/e2e/notify.spec.ts` (Chromium, a desktop context with `context.grantPermissions(['notifications'])` and a spy on `registration.showNotification`): a hidden page notifies and shows no toast, a visible page toasts and does not notify, two windows of one browser never give a toast and a notification for one alert, denied shows "Blocked in browser" and is never prompted, and the iPhone 14 layout is unchanged (Chromium and WebKit).

**A53 · Photos of a phone screen: on-device cleanup and a quick crop** (amends §7 Photos and the §8 photo pickers; Jeffrey 2026-11-06 15:13, design/DECISIONS.md v2.2 #10).

- **Where:** the phone only, inside `preparePhoto` (the lazy photo chunk). No request, no server or Storage work, no new dependency.
- **Crop step** (`components/photo/CropSheet.tsx`, `use-crop-queue.ts`): every file picked on New request or a profile's Add photo is shown first, one at a time, with the whole photo selected. Use photo (focused; Enter) keeps the selection, Escape keeps the whole photo, Retake drops it and reopens the picker in the same tap, and a scrim tap does nothing. Corner targets are 44 px; dragging inside moves the selection, dragging on the dimmed part draws a new one. The crop is normalised to the oriented photo (`lib/client/crop.ts`) and taken straight from the decoded `<img>`.
- **Downscale:** the crop is drawn at exactly twice the output size, then halved, so each output pixel is the mean of a 2 × 2 block. The stage is at most 3200 × 3200, within one iOS canvas.
- **Cleanup** (`lib/client/image-enhance.ts`, on the ≤ 1600 px image, time-sliced every 12 ms, deadline 1 s): levels from the 0.5 % / 99.5 % points of the darkest / brightest channel, one map for R, G and B, gain ≤ 1.5, white point ≤ 248, skipped when no tone moves more than 16 levels; an unsharp mask on luma (5-tap binomial, amount 0 to 0.5 by the measured lap/grad ratio, threshold 2, limit ±20), skipped for a sharp photo. Any failure or timeout uses the plain image.
- **Never bigger:** the reference (the pipeline before A53: one draw straight to ≤ 1600 px, 0.82) is encoded too. The first candidate no bigger than it is sent: the cleaned photo at 0.82, 0.76, then 0.72; the area-averaged photo at 0.82; else the reference. Then the usual ladder down to 2.5 MB. The thumbnail comes from the same pixels, and if full + thumbnail would exceed the reference's full + thumbnail, the reference pair is sent.
- **No metadata at all:** after encoding, `stripJpegMetadata` drops APP1 (Exif, XMP), APP13 and comment segments from the full image and the thumbnail. Re-encoding already drops the photo's EXIF and GPS; this also removes the ColorSpace / pixel-size Exif block Safari's encoder writes on its own.
- **Measured:** `performance.measure('lp-photo-prepare')` with sizes, crop, cleanup outcome and timings (no photo content).

## 18. F2 amendments (OVERRIDE anything above; the F2 release, 2026-11-06 evening)

The F2 release merges, in this order onto wave 2 (`desk/wave2`, 8fd6152): `feat/sys-notify` (A52), `feat/f1-2` (with `main` = F1.1), `feat/photo-cleanup` (A53), then the review fixes and the rename below, then `desk/wave2` again (a23f86d, wave 2's review fixes) and `main` (5711c10, which adds the dashboard thresholds fix 23f415e). Product decisions: `design/DECISIONS.md` "F2 release" (items 18–20).

**A54 · The desk's brand row and live line** (DECISIONS items 19 and 20; `design/screens/live-indicator.html`, the Desktop frame).

- **One BrandCard** (`components/list/BrandCard.tsx`), F1.1's compact row, with no `'use client'`: the page (a server component) draws the desk's copy into `DeskFrame`'s brand slot (`<BrandCard logoLoading="lazy" />`, no first-load JavaScript of its own), and the phone's list (a client chunk) draws its own with `onHide`. Its X carries `data-brand-hide`; the desk's copy has no handler and `DeskFrame` forwards the click from its slot (`onHideBrand`), moving keyboard focus to the top bar's title.
- **Hidden before paint.** The server can't know `prefs.brandHidden` (localStorage `lp-brand-hidden`). `BRAND_HIDDEN_SCRIPT` (`lib/brand-pref.ts`), inlined after `THEME_SCRIPT` in the one nonce'd script in `app/layout.tsx`, sets `<html data-brand-hidden>` when it is `'1'`; `frame.module.css` keeps the slot `display: none` under it. The hydration render keeps whatever the HTML has (`useBrandInHtml`, unchanged); once hydrated the shell shows the slot only for `desk && all && !prefs.brandHidden`. `setBrandHidden` and the `storage` event of another tab keep the attribute in step (`markBrandHidden`).
- **Show header** in the account menu of the sidebar and the rail on All requests while hidden (`DeskNav` `useShowHeader`): shows it and scrolls to the top.
- **Placement and size.** From 768 px the row's margin is `14px 20px 0 24px` (lined up with the top bar's title). The slot is a named container (`desk-brand`); under 620 px of it the dates go under the title, short ("NOV 6–8"), and the title is 17 px, so it stays one line beside a docked request at 1024 px.
- **Live line in the top bar** (`components/desk/TopBar.tsx`): `LiveIndicator` right after the title on every view. Lists: `useLiveStatus()` and `refreshSync(store)`. Dashboard: the open dashboard publishes `{syncedAt, failing, refresh}` through `components/dashboard/connection-signal.ts` (`setDashboardLive` / `useDashboardLive`; null when it closes) and the top bar derives the line with `useLiveStatus({syncedAt, failing, subject: 'Dashboard'})`. The list views and the dashboard draw no line of their own in the desk (`useInDesk`); their `ConnectionBanner` stays. `components/dashboard/ConnectionChip.tsx` is gone.
- **The lockup's corner dot** (`LiveMark`) reads `useLiveStatus().state`: green healthy, amber reconnecting (`data-state="off"`), grey offline or loading; named "Live. Tap to sync now", "Reconnecting. Tap to try again", "Offline. Tap to try again" or "Syncing".
- **Tests:** `tests/unit/desk/render.test.tsx` (the line after the title on every view, the dashboard's published inputs, the slot's server-drawn row), `tests/unit/theme.test.ts` (`BRAND_HIDDEN_SCRIPT`), `tests/unit/prefs.test.ts` (the attribute), `tests/e2e/desk-shell.spec.ts` (the compact row at 1440 / 1024 / 1180, the X and Show header with no frame drawn after a reload, the live line, Refresh now, Reconnecting), `tests/e2e/dashboard.spec.ts` (the dashboard's line in the top bar, offline), `tests/e2e/list.spec.ts` and `a11y.spec.ts` (the phone row, the desk row's contrast at 1280).

**A55 · The crop step: Retake keeps the run, one answer per photo** (the two open review findings of A53).

- **Retake keeps what was kept** (`components/photo/use-crop-queue.ts`). `useCropQueue(onDone, inputRef)`: a Retake on the last waiting photo of a run that kept others leaves the run open (`retaking`), and the photo picked instead joins it ("2 of 2"); everything is handed to `onDone` together. If the picker closes with no photo, the kept ones are handed over then: on the input's `cancel` event, or, where a browser has none, `RETAKE_SETTLE_MS` (1.5 s) after the page is back in front (`focus` / `visibilitychange`) with nothing picked. `ProfileView` appends a hand-over to an open add run (its picks, unreadable count and the files it holds, against the 3-photo limit) instead of revoking and replacing it, and its input is disabled only offline or while uploading, never while `retaking`.
- **One answer per photo** (`components/photo/CropSheet.tsx`). The photo that takes over in the open sheet (the next of a multi-photo pick) ignores Use photo, Retake, Escape and Enter for `FRESH_MS` (350 ms) from its mount (a layout-effect timestamp), so the second tap of a double tap, an Escape right after Enter, or a key meant for the photo before never answers it; a photo that opens the sheet has no such wait. A held key's repeats never answer (`e.repeat` Enter is prevented in capture; `Sheet` gained `onEscapeKeyDown` and the sheet prevents a repeated or fresh Escape). A photo the browser can't show still passes on at once.
- **Tests:** `tests/e2e/profile.spec.ts` (Add with two photos, Use on the first, Retake on the second, a new photo: both in the Add sheet and uploaded; the cancelled-picker variant), `tests/e2e/photo-cleanup.spec.ts` (a double tap, Enter then Escape, a held Enter: one photo answered each time).

**A56 · "Not found in medical" and "Not found"** (DECISIONS item 18; replaces the "Not in medical" UI label in §4, A45, A47 and A52's notification copy).

- `STATUS_META['Checked – Not Found']`: `label` and `shortLabel` "Not found in medical", `narrowLabel` "Not found". `ANSWER_LABEL = {notFound: 'Not found', inMedical: 'In medical'}` is the answer buttons' text (`primaryActions`, the Pending cards, `changeAnswerChoices`). `StatusMeta.narrowLabel` ("Waiting", "Not found") is what `narrowStatusLabel` returns for the log under 400 px (A58).
- No literal of either label outside `lib/domain.ts`: alerts (`lib/client/alerts.ts`), the audit trail (`components/profile/audit-trail.ts`, the legacy "(rechecked)"), the stepper (`list-helpers.ts`), the dashboard tiles (all five read `statusMeta`), and `docs/export.sql` (its status label column, the one literal outside the app).
- **One line, never cut** (A47's rule), checked at 375–1440 px: the phone log's status cell ("Not found" under 400 px), the desk table's status column (154 px with a request docked at 1024–1279, was 140), the filter chips, the profile's status block, and My requests' progress line (its columns are `minmax(max-content, 1fr)`). The dashboard tile's label still wraps in a narrow tile, by design (the tiles keep their values on one line, A48).

**A57 · Where the last two merges met** (wave 2's review fixes and `main`'s dashboard thresholds).

- **The dashboard's top-bar line uses the thresholds.** The dashboard publishes `useStats().failing` (2 network failures or timeouts, or 3 server errors, in a row; `CONNECTION_FAILURES`), not `error`, through `connection-signal.ts`, and the top bar's `useLiveStatus()` counts the lists' last sync for the 30 s rule (`aliveAt`) like the dashboard's own banner. So the top bar's line and the column's banner turn amber, and recover, together; one failed stats poll changes neither. Tests: `tests/unit/desk/render.test.tsx` (90 s-old stats while the lists sync stay healthy; both stale is Reconnecting), `tests/e2e/dashboard.spec.ts` (desk: one 503 shows nothing, the 3rd is Reconnecting in the line and the banner, Refresh now clears both).
- **The desk table** keeps wave 2's container-query columns (Post whenever nothing is docked, Logged by from a 1040 px table) with A56's 154 px status column for a request docked at 1024–1279.
- **First-load budget (A25).** Wave 2's desk frame, system notifications' store glue, `setMedicalLocation` and `holdUndo` together put `/` at 232.4 KB (route-only 40.9 KB). The app shell's fallback `ConnectionBanner` (shown only on a phone's request page until its chunk is in, which draws its own) is now loaded with `next/dynamic` like the views, so `components/ui/Banner.tsx` and `lib/client/live-status.ts` leave the first load: `/` is **229.5 KB** (route-only 38.1 KB). It is the same module the views import, so the shell's copy still steps aside while a view's is mounted.

**A58 · Early-review fixes** (the F2 release candidate's review, 2026-11-06 evening).

- **The desk top bar never cuts the title, its count or the live line** (DECISIONS item 20, A54). `.title` and, from a 680 px bar, `.liveLine` are `flex: none`; the search field gives way instead (`flex: 0 1 260px`, at least 140 px, so a 4-digit count, "Last updated 12:59 PM" and New request with its cap still fit at 680). With search open in a narrower bar the field has a zero basis (`flex: 1000 1 0`, 120–320 px), so it narrows to 120 px before the line's words clip; with the search icon only the words can give way, and only when the bar has no room left. No fractional shrink factor: a sub-pixel clip already draws the ellipsis. On a portrait iPad (main column 730–789 px at 790–849) "All requests 21" read "All requests…" and "Last updated 8:22 PM" "Last updated 8:…".
- **The desk table's Created column is 96 px** in both narrow layouts (nothing docked under a 1040 px table; docked at 1024–1279), from 88: the widest earlier-day time ("Mon 12:58 AM") is 92 px, and WebKit drew "Thu 11:58 P…" while reporting `scrollWidth == clientWidth` for the right-aligned cell. The name track gives the 8 px.
- **Known, deferred to the next release:** beside an earlier day's time, "Not found in medical" reads "Not found in med…" at 400–427 px (Pixel 412, iPhone 414), and "Waiting for check" can lose its end at 400. Fix: apply the short labels under 430 px, with an e2e check (Brian, 2026-11-06 21:30: ship F2 without it).
- **`scripts/verify-migration.sh` honours `SUPABASE_DB_URL`** (as the integration harness's `dbUrl()` does), falling back to `supabase status`, with the same local-host guard; `tests/integration/migration.test.ts` passes `dbUrl()` and checks the script reports that database, so an isolated stack tests itself instead of the default one.
- **Old phones after the deploy** show a saved medical location in a request's history as an edit with no field name until they reload into F2 (their `FIELD_LABELS` has no `medicalLocation`). Kept: F2 needs the edit event for "Edited Location"; HANDOFF's deploy notes say to tap Update ready · Reload.
- **Tests:** `desk-shell.spec.ts` (790–849 px on All and My requests, healthy and Reconnecting, with a 3-digit count and a 2-digit-hour clock: nothing in the bar cut, measured with a Range to the sub-pixel), `desk-table.spec.ts` (an earlier day's "Mon 12:58 AM" whole at 768, 820 and docked at 1024, in Chromium and WebKit), `migration.test.ts`.
