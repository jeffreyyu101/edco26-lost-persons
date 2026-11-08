# Build spec v2: "Is my friend in medical?" (EDC Orlando 2026)

This is the single contract for every agent building the app. Version 2 adds the findings from the GPT-6 Astra (Codex) and Claude Fable 5.1 plan reviews. §13 (v2.1), §14 (v2.2, the Phase 1a review), §15 (v2.3, the Phase 1a verification), §16 (v2.4, the integrated QA), §17 (v2.5, the product decisions of 2026-11-06 morning and afternoon), §18 (the F2 release, 2026-11-06 evening), §19 (F5, stages and the hold), §20 (Pending v9.1), the team join link amendment (J1), §21 (F3, messages and en route), §22 (F4, Web Push and the Activity inbox) and §23 (the F3 + F4 release) override anything above them.

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
  - Backoff on errors: 6 s, then every 12 s while visible (2026-11-08 network fix 6: was 6, 12, 24 and 60 s). Hidden pages still poll at most once a minute.
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
- **Click** (`public/sw.js`, `notificationclick`): close the notification, then pick an open window of the app (the focused one on `/`, else any on `/`, else another page such as `/signin`) and `focus()` it. A window on `/` is sent `{type: 'lp-open', url}`; the page (`openFromNotification` in `lib/client/system-notify.ts`) opens that view in place with `navigate` (no reload, so an open form or sheet keeps its state) and answers `{ok: true}`. A window that is not on `/`, or does not answer within 1.5 s (an older build), is `navigate()`d to the URL. With no window, or if navigation is refused, `clients.openWindow(url)` (navigate and openWindow get the absolute URL). Before that hand-off the worker keeps the click's `{url, at}` in its `lp:meta` cache (outside the `lp-` version caches, so it survives a worker restart and an update) and clears it only when a page answers `lp-open` with `{ok: true}`: an iPhone Home Screen app the tap launched or resumed at its start URL `/` (a frozen page, the listener not loaded yet, a `navigate()` / `openWindow()` that did nothing) never hears `lp-open`. The page (`watchPendingOpens`, started by `startNotify` with the lp-open listener) asks `{type: 'lp-take-open'}` on start and on each `visibilitychange` to visible, window `focus` and `pageshow`, each time at 0, 1, 2.5, 5 and 8 s until something opens (iOS may hand the click to a worker it starts for it, which keeps it only after the page first asked); the worker answers `{open: {url, at}}` once while it is under 10 minutes old, else `{open: null}` (an expired one is dropped). The page opens it with `openFromNotification` only if it was tapped just then: at most 15 s before the page came back (or since), at most 2 minutes before a page started, or 10 minutes for the first app page after a sign-in (sessionStorage `lp-signed-in-at`, written by `announceSignIn`); an older one is taken and dropped, so it never moves a page in use. It does not ask while hidden, in the request form, an edit or the needs-attention editor, or while a text field holds unsent text (the message composer, a sheet's field): the click then stays with the worker. It skips a click whose address this document was itself loaded at after the click. A click a page took this way is not `navigate()`d to or opened with `openWindow()` by the worker afterwards (it re-reads the kept click first; also when a newer click replaced it). A session-expired redirect keeps `to=thread` in `?next=` for a request whose thread jump waits or landed in the last minute (`nav.ts` `signInNext`, set by `thread-jump.ts`); a jump waits 60 s for its Messages. A failed load of `system-notify` is retried after 5, 20 and 60 s. The worker also answers `{type: 'lp-caps'}` with `{notificationClick: true}` (see Supported). The worker's precache, fetch and update behaviour is unchanged.
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

## 19. v2.6 amendments, F5 (OVERRIDE anything above; status stages and the "Not found yet" hold, 2026-11-06 evening)

Brian approved these with the `design/screens/updates.html` boards #clarify, #recheck and #colors (`clarify-*`, `recheck-*`, `colors-*.png`; `design/DECISIONS.md` "Status stages and the 'Not found yet' hold"). Built on `feat/stages` beside F3 (messages, en route) and F4 (push, Activity); the shared contract between them is in that branch's brief. Numbering continues from A52; the integrator renumbers clashes with F3 / F4. Merged onto F2 (`release/f5-premerge`), F5's A53–A56 became A58–A61 (F2 took A53–A57), then A59–A62 when merged onto the F2 release (`main` took A58 for its early-review fixes) and this section became §19; F2's rename (A56) landed, so the answer button reads "Not found" and the final status "Not found in medical".

**A59 · The hold in the database** (rework SQL step 1d and `lp_set_status`; additive, safe while the live build serves).

- **Columns.** `patients.recheck_at timestamptz` (nullable) and `patients.not_found_checks smallint not null default 0`, both `add column if not exists` (a constant default needs no table rewrite). `lp_row` adds `recheck_at` and `not_found_checks` (a third `||` object); the server maps them to `RequestSummary.recheckAt?` / `notFoundChecks?` (optional: cached rows and a server without them read as not held).
- **One constant.** `public.lp_stages_recheck_minutes()` (immutable SQL, `select 20`) and `RECHECK_MINUTES` in `lib/domain.ts`; `tests/unit/stages.test.tsx` reads the SQL and compares. `lp_set_status` never repeats the literal.
- **`lp_set_status`** (signature, transitions and errors unchanged; `TRANSITIONS:BEGIN…END` unchanged):

  | Call | Stored |
  |---|---|
  | Not found on `Added` with `not_found_checks = 0`, kind ≠ undo | **the hold**: status stays `Added`; `recheck_at = now() + lp_stages_recheck_minutes()`; `not_found_checks = 1`; audit `status_changed` `{status: 'Added', kind, held: true, answer: 'not_found', recheck_at, not_found_checks, row_version}` |
  | any other Not found (held, due or not; Change answer from In medical) | final `Checked – Not Found`, `recheck_at = null`, `not_found_checks + 1` (2 after a hold) |
  | In medical | `recheck_at = null` (the count stays) |
  | `Added` (Back to Waiting `change`, `reopen`) | both cleared |
  | `Added → Added` on a held request (`undo`, `change`) | a real change (not the idempotent repeat): clears or restores the hold |
  | `undo` (not from Cancelled) | restores `recheck_at` / `not_found_checks` from the `previous_value` of the latest `status_changed`, when that event is the change being undone (its previous status = the target, its new status = the current one). From Cancelled the row keeps its own (cancel never touches them). |
  | Not found, kind answer, `expected_version = row_version − 1`, and the hold whose audit `row_version` is the current one was the last write | the idempotent repeat `{changed: false}` (two liaisons at once). Without it, the second phone's 409 retry (A12) would close the request. |

  Every `status_changed` audit adds `recheck_at` / `not_found_checks` to both sides (additive keys). Nothing runs on a clock: a due hold stays `Added` until someone answers.
- **`lp_stats`.** Held requests are `Added`, so they count in `open.waiting` and never in `notInMedical` (final answers only). The hold event counts as the request's first answer (`avgAnswerMinutes`). `longestWait` skips holds that are not due.
- **Old builds.** The live server calls `lp_set_status` with the same arguments, gets the hold, and maps `lp_row` through its allowlist (status `Added`): the request stays in its queue; its Undo (`Added`, kind undo) clears the hold. Migration first, then deploy, as before.
- **Server.** `POST /api/requests/:id/status` notifies after the response (`next/server` `after`) when the target asked for is `Checked – Not Found` and something changed: `notifyStaff(involvedStaff(id), {kind: 'not_in_medical', detail})` with `detail` "Not found yet · recheck 4:40 PM" (held) or `statusMeta(status).label` (final) — `lib/server/stage-notify.ts`. `lib/server/notify.ts` and `lib/server/involved.ts` are the contract's stubs (F4 replaces them). **F4 must take the event from the requested target, not the returned status: a hold returns `Added`.**

**A60 · Stages** (`lib/stages.ts`: lib/domain's stage system in a module of its own, so the first load of `/` (A25) does not carry it; `lib/domain.ts` keeps only `RECHECK_MINUTES`, `NOT_FOUND_YET_LABEL`, `isHeld`, `isRecheckDue` and `actionLabel`, which the store and the alerts need).

- `displayStage(row, {now, timeZone})` → `{key, label, fullLabel, tone, glyph, bucket, sub?, extra?, said, recheckAt?, due?}`; `stageLook(row)` (no clock) and `stagePhrase(row, tz)` (row sentences). One `STAGE_META` (label, tone, glyph, bucket); status stages read `STATUS_META`. F3's `needsInfo`, `lastMessage {by, mine, text}`, `lastMessageAt` and `enroute {count, earliestEta, state, mine}` are read as optional, loosely typed fields. The table is `design/DECISIONS.md`'s.
- **Glyphs** (`components/ui/StageGlyph.tsx`): the StatusGlyph rings, plus the amber ring with "?" (drawn in amber-11: amber-9 is under 3:1 on white), lucide `Hourglass` (violet-11), the mockup's walking figure (teal-11) and lucide `Check` (green-11). No circle backgrounds.
- **Text colour.** Step 11 on the page and on cards (≥ 4.5:1 in both themes, unit-tested from the Radix Themes tokens); step 12 on a tint in light and step 11 in dark for chips; the detail block's label is Radix `highContrast` (step 12) as before.
- **Surfaces.** The phone log's status cell (glyph + label; under 400 px "Waiting" and "Not found" (A56's `narrowLabel`) for those two status stages only, A63); the desk table's status cell (label + `.stx` extra; the column follows A57's container-query layout: 180 px with nothing docked (beside Post), 240 px from a 1040 px table (with Logged by); docked widths and short forms in A63; still no en route column); the detail status block (`data-stage`, tint per tone incl. violet / teal, the recheck row, and for the Medical team the answers inside the block while `Added`; front of house keeps the foot bar; `enrouteSlot` under the location row for F3); the My requests card (corner chip for Needs info / Not found yet, outline "Recheck 4:40 PM"); the dashboard's Recently updated rows (the synced row's stage when its status matches); the audit trail (Waiting for check → Not found yet, "Recheck 4:40 PM"; Not found yet → Not found in medical); the hold's alert and system notification (A63).

**A61 · Pending > To check lanes** (`lib/client/lanes.ts` `toCheckLanes`, `nextRecheckAt`; `components/list/ToCheckLanes.tsx` with `useRecheckNow`; both only on the views' chunks).

- `due` (held, `recheckAt ≤ now`, earliest first), `queue` (not held, oldest first), `later` (held, not due, earliest first). The phone's To check tab and the desk's To check column render due cards (`recheck`, blue "Recheck" chip, "FA 4 · not found 4:02"), queue cards, then `LaterGroup` ("Later N", hourglass) of `LaterRow`s (52 px buttons named by one sentence; they carry `data-request-id`, so J / K walk them on the desk).
- Counts: the To check tab = due + queue; `viewCounts(…, now)` leaves Later out of Pending. `useRecheckNow(rows)` re-renders at the next recheck moment (not only on the 15 s tick); `useCounts()` follows `useNow()`. Nothing of the stage system or the lanes is on `/`'s first load; the store's part of the hold (the overlay, the two guards, the Undo words, the alert) adds 475 B gzipped. **A25's 230 KB total was already exceeded at the F3/F4/F5 base (`b17f47b`: 235,758 B > 235,520 B, measured on `npm run build:test`)**, so `tests/e2e/first-load.spec.ts` fails there and here (236,233 B; route-only 40,195 B, under its 40 KB): the integrator decides the budget.
- The card's answers are labelled by `actionLabel('notInMedical')` / `actionLabel('inMedical')` (new export), so the rename flows through.

**A62 · Client** (`lib/client/hold.ts`, store, alerts).

- The status tap's overlay predicts the hold (`statusOverlayFields`): a first Not found keeps the status and sets `recheckAt` / `notFoundChecks`, so the card moves to Later at once instead of flashing Not in medical.
- A12's one 409 resend is skipped for a Not found when the row's hold changed meanwhile (`holdChanged`): someone else's hold must not turn this tap into the final answer.
- The first Not found's Undo bar: `"${actionLabel('notInMedical')} · recheck 4:40"` (`holdSnackMessage`); Undo sends `Added`, kind undo, as before.
- In-app alert: my request going on hold (status unchanged) by someone else raises the hold alert (`holdAlert`, kind `status_changed`; words and freshness in A63).
- **Tests.** `tests/unit/stages.test.tsx` (every status × Needs info × hold none / held / due × en route; labels from STATUS_META and the actions; the constant; contrast light + dark; lanes, Later and counts; the overlay; the alert; the mapper and the audit trail; server renders of every surface). `tests/integration/hold.test.ts` (first / second Not found, the double tap, a due hold that never closes, Undo both ways, In medical and its Undo, Back to Waiting, Change answer, a stale version, cancel and its Undo / Reopen, the old server's call and the old client's Undo, the columns and the constant, the dashboard), with the transitions, stats, export, hygiene and requests tests moved to the two-step Not found. `tests/e2e/stages.spec.ts` (the medical flow with the page clock past the recheck, Undo, front of house's card through to the final grey; the held request; the desk status strings; and a page.route fixture of every stage for overflow at 375 / 390 / 820 / 1180 / 1440 px with the post-rename "Not found in medical · 2 checks", axe and 44 px targets in light and dark, and `LP_F5_SHOTS=1` screenshots `design/screens/f5-*.png`).

**A63 · Review fixes** (2026-11-06 night; `design/DECISIONS.md` F5 section; A57 on `feat/stages`).

- **Desk status column with a request open.** `[data-pane] .table` gives Status `minmax(184px, 232px)` and Friend `minmax(96px, 1fr)` (grid sizes the fixed-max track before the flexible one), with `#` 44 / 48 px and Updated 56 px: 1024–1279 `44px minmax(96px, 1fr) minmax(176px, 232px) 96px 56px` (merged onto the F2 release: A58's 96 px Created column, so the status floor is 176 px and the five still fit the 544 px main column at 1024), from 1024 `48px minmax(96px, 1fr) minmax(184px, 232px) 96px 56px`. Nothing docked keeps A57's container-query layout (180 px beside Post, 240 px from a 1040 px table). So Status is a whole 232 px from 1080 px (1024–1279) and from 1304 px (1280+), which fits the longest value with its glyph ("Not found in medical · 2 checks" needs 221 px in Chromium, "Not found yet · 11:40 PM" 182, "Waiting for check · 59m" 172). The cell is a size container (`container-type: inline-size`); under 228 px what follows the label takes `DisplayStage.extraShort` (`.stxWide` / `.stxNarrow`): "· 11:40" for a hold's "· 11:40 PM", '' (nothing) for "· 2 checks"; the other extras are short already (a free-text location still ellipsises). The label never gives way. The age after a name gives way before the name (`.ag` flex-shrink 1000).
- **Phone log under 400 px.** `narrowStatusLabel(STATUS.notInMedical)` is "Not found" (A56's `narrowLabel`, the answer's label) beside "Waiting"; rendered as `.stNarrow[data-narrow]`.
- **Needs info on a hold** (`displayStage`): the stage keeps the Needs info label, sub and colour and adds `recheckAt`, `due`, `recheck` ("Recheck 4:40 PM"), `extra` "4:40 PM" / `extraShort` "4:40" with `extraGlyph: 'recheck'` (the desk draws lucide RefreshCw before the time), and `said` "Needs info, Rae C. asked at 4:20 PM, recheck at 4:40 PM". The request's recheck row and the My requests outline chip show whenever `stage.recheck` is set (Not found yet or Needs info on hold); the Later lane already went by `isHeld`.
- **The hold's alert.** `holdAlert(row, timeZone)` = `{kind: 'status_changed', title: initials || 'Request', subtitle: holdDetail(recheckAt, tz)}` ("K.T." / "Not found yet · recheck 4:40 PM"; `holdDetail` in `lib/domain.ts` is also the server's `notFoundDetail` for a hold); `systemNotice` of a held row's status alert is `{title: alert.title, body: alert.subtitle}`: no LP number on either. `statusAlert(row)` of a held row is the hold alert (an Undo of the final Not found, or of In medical, puts the hold back). `RaisedAlert.held` (and the store's toast / system-notification records) keep `isHeld(row)` at raise time; `alertStillCurrent(kind, status, row, held)` is false when `isHeld(row)` no longer matches, so the toast and the notification close when the first Not found is undone. `AlertContext.timeZone` carries the event timezone.
- **First load.** `/` is 236,393 B gzipped after these fixes (route-only 39.4 KB), +160 B over A61's 236,233 B (the hold's words and its freshness in the alerts); `tests/e2e/first-load.spec.ts` still fails as it did at the base (A61: the integrator decides the budget).
- **Tests.** `tests/e2e/stages.spec.ts`: `statusCuts` (each status word's Range width against its box, and clear of the next column; an ellipsis counts as cut) on every view at 375–1440 px before and after the post-rename words ("Not found in medical", and "Not found" in the narrow span); a request open beside the list at 1024 / 1180 / 1280 / 1440 px with the evening fixture (rechecks 11:18 / 11:40 / 11:51 PM, a 59 m wait, Needs info on hold at 11:35 PM), whole at 1180 / 1440 and short at 1024 / 1280. `tests/unit/stages.test.tsx`: Needs info × hold in the matrix, the renders of Needs info on hold, the hold alert's words (no LP), Undo closing it, the hold coming back. `tests/integration/stats.test.ts` leaves holds that are not due out of its oldest Waiting row; `tests/integration/hold.test.ts` makes a held request the oldest Waiting row (backdated with psql) and checks `longestWait` skips it until due, then names it.

## 20. v2.7 amendments, Pending v9.1 (OVERRIDE anything above, A61 in full; Brian 2026-11-06 19:35–20:40)

Brian approved these with `design/screens/pending-v9.html` (v9.1 note first; frames `pending-v9-1…9.png`, `#buttons` → `pending-v9-buttons-1…4.png`, `close-opt-a.png`) and `design/DECISIONS.md` "Pending v9.1". Built on `feat/pending-v9` from F5 (`5e0d8a3`); F2 (rename, live line, wave-2 review fixes) and F3 (messages, en route) merge in later. Numbering continued from A56 (F5's A53–A56 are A59–A62 here); merged onto the F5 release (`release/f5`) this section's A57–A61 became A64–A68 and the section §20 (F2 took §18, F5 §19). **A61 (Pending > To check lanes) is withdrawn: no Later lane, no due-first order, no Later rows anywhere.** The hold's SQL (A59), the stage system (A60) and the client hold (A62) stay, with the changes below.

**A64 · One status order** (`lib/client/status-order.ts`, pure, only on the views' chunks).

- `waitingOrder` / `byLongestWait`: every request Waiting for check (Needs info and held / due included), oldest `createdAt` first, ties by LP number. `pendingGroups().waiting` already gives this order.
- `friendComingOrder` / `byFriendComing`: In medical (legacy Bring friend included): rank 0 Friend arrived (F3 `enroute.state 'arrived'`; `enroute.arrivedAt` when sent, else since found), rank 1 Friend en route (soonest `enroute.earliestEta`, none last), rank 2 nobody coming (longest since found: `reunionStartedAt ?? foundAt ?? updatedAt`). F3's fields are read loosely, as A60 does.
- `statusGroups(rows)` → `{waiting, coming, closed}`; closed newest closed first (`closedAt ?? updatedAt`). `STATUS_GROUP_META` (label, glyph) for the three groups.
- `oldestWaitMinutes`, `nextRecheckAt` (moved from `lanes.ts`; Pending re-renders when a chip turns "Recheck due").
- `selectors.viewCounts` drops F5's `now` argument: Pending = Waiting for check (held included) + In medical. `useCounts()` is a plain selector again.

**A65 · Pending** (`components/list/PendingQueues.tsx`; `components/desk/PendingBoard.tsx`; `components/list/PendingTabs.tsx` and `ToCheckLanes.tsx` deleted).

- `PendingQueues` renders both sections; the phone (`PendingView`, under 768 px) stacks them in `.queues` (`data-testid="request-list"`), the board (`PendingBoard`) puts them in `pending-board.module.css` `.cols`: always two columns (no stacked fallback, a docked request included), each column `overflow-y: auto` in a box `100dvh − --desk-top − --lp-sticky-h` high (the connection banner included: the page does not scroll; frame.module.css zeroes Pending's bottom padding on the desk). The 6 px over the column headers is `.cols`' top padding, outside the scrolling columns, so a pinned header sits at the very top of its column. `.board` is a size container for the gutters (24 / 16 px under 900 / 12 px under 700); each `.col` is one for its cards (list.module.css: under 340 px 12 px card padding and 14 px answers, under 290 px the answers stack). J / K walk Waiting for check, then Friend coming (DOM order); a card scrolled to stays clear of its column's pinned header.
- `QueueHeader`: `<h2>` with a fold `<button aria-expanded aria-controls>` named by its content ("Waiting for check 7 requests", ", longest wait 51 minutes" while folded; the compact "51m" is aria-hidden), `data-testid="queue-header-check|coming"`, `queue-toggle-…`, `queue-oldest-wait` (data-tone). A count of 0 renders a plain heading (`data-zero`, dimmed glyph, no button, "Waiting for check, no requests"). Sections: `pending-section-check|coming` on the phone, `pending-column-check|coming` on the board.
- Fold memory (`lib/client/view-prefs.ts`, `useSyncExternalStore` cells): `useWaitingFold(count)` in module memory, folded at a base count, open again once the count is above the lowest count seen while folded (`waitingShowsFolded`); `useComingFold()` in localStorage `lp-fold-coming`.
- `useLeaving(waiting)`: `mark(id)` before a final Not found (not on a held → hold, not offline); when the request leaves the list, an inert, aria-hidden copy of its card (`data-testid="leaving-card"`) stays in place for 240 ms (`.leaveWrap` fades, slides 24 px and folds its measured height); Undo inside that time drops the copy. Reduced motion: no copy.
- Friend coming cards: no `friendComingLine` (removed from list-helpers), minutes always grey.

**A66 · The card and the answers** (`components/list/cards.tsx`, `StageChips.tsx`, `lib/domain.ts`, `lib/client/hold.ts`, the store, `components/ui/Toast.tsx`, `components/profile/ProfileView.tsx`).

- `holdState(row, now)`: none / held / due. CheckCard: `data-hold`, the chip row (`HoldChip`, `data-testid="hold-chip"`, `data-due` when filled), the wait always (`card-minutes`), the quiet line `post · LP-####`, no `recheck` prop. My requests: the corner keeps the wait (WaitBadge) for a hold, the chip row under the name; the corner chip is Needs info only; no `RecheckChip`.
- `domain.notFoundHolds(row)` (Waiting for check and `notFoundChecks` 0: what `lp_set_status` holds; on the first load, the store needs it) and `stages.notFoundAnswer(row)` → `{kind: 'hold' | 'close', label, said}`, with `stages.NOT_FOUND_FINAL_LABEL = 'Not found'` and `stages.RECHECK_DUE_LABEL = 'Recheck due'` (views only, so A25's first load does not carry them). `hold.holdsOnNotFound` reads `notFoundHolds`. The left answer (`data-testid="not-found-answer"`, `data-answer`) on the Pending card, the request's block answers and its foot bar: hourglass (1.75) or × (2.25), `aria-label` = `said`.
- `hold.notFoundSnack(row, to)` → `{message, said}`: held "Not found yet · recheck in 20 min" / "Not found yet, recheck in 20 minutes."; closed "<initials or LP> closed · <STATUS_META label, lower case>" / "… closed, ….". `SnackbarItem.said?` (ADD): the Snackbar shows `message` aria-hidden and `said` visually hidden. `holdSnackMessage(row, to)` keeps its name (no time zone argument).
- Undo predicts the server's restore: the Undo record keeps the hold fields from before the undone change (`UndoRecord.restore`, `hold.holdFieldsOf`), and `statusOverlayFields(row, to, 'undo', now, restore)` overlays `{status, recheckAt, notFoundChecks}`, so the final Not found's Undo shows the held card (chip, "× Not found") at once. While that Undo is on its way, `setStatus` reads the row it brings back (store-core `undoing`) for `tapHeld`: a "× Not found" tapped there is sent as the final answer once the Undo lands, not swallowed by F5's double-tap guard.

**A67 · Stages** (`lib/stages.ts`, A60 amended): `StageKey` adds `recheckDue` (`STAGE_META`: "Recheck due", violet, glyph `history` = lucide History in `StageGlyph`, open). A hold whose `recheckAt ≤ now` is `recheckDue`. Every stage of Waiting for check has `extra = "· <wait>"` and `waitMinutes` (desk heat colour: `.stx[data-tone]`); held / due keep `sub = "Recheck 4:40 PM"` for the request's block only; `said` is "Not found yet" / "Recheck due" (no time). `stageLook(row, now = 0)` and `stagePhrase(row, tz, now = 0)` take the clock; the desk rows and the dashboard's recent rows pass theirs, and the phone's log rows (All, My requests, Search) pass `list-helpers.stageClock(row, now)`: 0 unless the hold is due, then its recheck time, so a memoized `LogRow` / `SearchLogRow` re-renders when its stage changes, not on every 15 s tick. Arrived: `extra = "· 4:29 PM"` when `enroute.arrivedAt` is sent.

**A68 · Sort by status** (`components/list/SortToggle.tsx`, `lib/client/view-prefs.ts`, `components/list/rows.tsx`, `components/desk/table/DeskTable.tsx`, `DeskTableViews.tsx`).

- `useSortOrder('all' | 'mine')` → `'default' | 'status'`, localStorage `lp-sort-all` / `lp-sort-mine` (only `'status'` is stored), shared by the phone toggle and the desk header. `readSortOrder` / `writeSortOrder` never throw.
- Phone: Chrome's `sort` slot (named `live` on `feat/pending-v9`) renders `.liveRow` (a size container, F2's `.live` spacing) › `.liveIn` › F1.2's `LiveIndicator` (`.liveLead`) then `SortToggle` (`data-testid="sort-toggle"`, aria-pressed, `aria-label` from `sortToggleLabel`, the polite `sort-announcement` region; its `margin-left: auto` puts it at the right end). Under 361 px of row the line stacks and the toggle is left-aligned. Pending has no `sort`: its line is F2's plain `LiveIndicator` (`.live`).
- Status order: All: `GroupDivider` (role heading, sticky under the column header) + rows per non-empty group, then the Archived fold (`prefs.closedExpanded`) or, filtered, an "Archived" divider. My requests: dividers over card groups, then the "Closed" fold (`ArchivedFold label="Closed"`, sessionStorage `lp-mine-closed-expanded`). Every Archived / Closed fold (phone and desk, either order) is full width with › while folded and ⌄ while open, gray-11, no rotation (pending-v9.html `.arch`).
- Desk: `DeskTable sort={{order, defaultColumn: 'created' | 'updated', onChange}}`; the header becomes a one-row `role="table"` (sticky `.thSticky`) whose `role="columnheader"` cells carry `aria-sort` (`descending` on Created / Updated, `other` on Status) and wrap a button (`sort-status`, `sort-created`, `sort-updated`; names from `sortHeaderLabel`). Without a sort (Search, the skeleton) the header stays aria-hidden as before. `GroupRow` (sticky under the header) and the Archived / Closed fold in status order.

**Tests.** `tests/unit/pending-v9.test.tsx` (rules 2 and 4, groups, counts, the button by hold state, the card and Friend coming renders, the Undo words, the toggle's words and memory with storage blocked, the Waiting fold rule, the desk header's aria-sort and labels, the headers); `tests/unit/stages.test.tsx`, `list-views.test.tsx`, `client/store-hold.test.ts`, `profile/change-answer.test.tsx` follow. `tests/e2e/pending-v9.spec.ts`: a page.route fixture of the mockup's data at 4:31 PM (Pending phone sections, order, chips, the folds and their memory, the empty header, the desk board scrolling per column, the 820 tablet board, All / My status toggle with groups, live region and memory, 360 px, the desk header sort and status cells, overflow at 375 / 390 / 820 / 1180 / 1440 px in light and dark, axe and 44 px targets, `LP_V9_SHOTS=1` → `design/screens/v9-*.png`), and the real flow (first Not found → chip and "× Not found" → due in place → the final Not found animates out with its toast → Undo; the request's block). `pending-v8`, `stages`, `list`, `a11y`, `dashboard`, `desk-shell`, `desk-table` and `profile` specs follow the one page and the two-state answer.

**A69 · Where F2, F5 and Pending v9.1 met** (the F5 release, `release/f5` on `main` 85c9320; `design/DECISIONS.md` "The F5 release").

- **Merge order** (each `--no-ff`): `release/f5-premerge` (F5 5e0d8a3 on `release/f2`), `feat/stages` (68070e0, F5's A63 review fixes), `feat/pending-v9` (163fbaa). `main`'s later F2 commits (0e4ccd7: the desk top bar at 790–849 px, the 96 px Created column, `verify-migration.sh` with `SUPABASE_DB_URL`) are kept.
- **`lib/stages.ts`.** v9.1's waiting branch (`extra = "· <wait>"`, `waitMinutes`, `recheckDue`, `said` without a time) with A63's hold carried on every stage of Waiting for check, Needs info included: `recheckAt`, `due`, `recheck` ("Recheck 4:40 PM"), which only the request's status block shows (`ProfileView` `stage.recheck`). A63's `extraGlyph` and the hold's `extraShort` are gone; `extraShort: ''` stays for a closed row's "· 2 checks". `stagePhrase` of Needs info is its label. `NOT_FOUND_FINAL_LABEL = ANSWER_LABEL.notFound` (A56).
- **Desk status cell** (`DeskTable` `StatusExtra`): the wait's heat (`data-tone`, A67) on `.stx`, and A63's `.stxWide` / `.stxNarrow` pair when the stage has an `extraShort`. Column widths are A63's (with A58's Created column): docked from 1024 `48px minmax(96px, 1fr) minmax(184px, 232px) 96px 56px`, docked at 1024–1279 `44px minmax(96px, 1fr) minmax(176px, 232px) 96px 56px`; nothing docked keeps A57's container-query layout.
- **Phone chrome** (`ListViews` Chrome): F2's `useLiveStatus` line, banner and badge; the `sort` slot (A68) puts `LiveIndicator` and `SortToggle` in one `.liveRow` on All and My requests; Pending keeps F2's plain line.
- **Pending** (`PendingView`): v9.1's `PendingQueues` / `PendingBoard`; F2's `selected` (from `app-shell`) now only scrolls the open request's card into view (no tab to switch); F2's focus hand-back after In medical (`after`, the next Waiting for check card) stays. `PendingTabs.tsx` is deleted.
- **Store** (`showUndo`): v9.1's `notFoundSnack` words and `said` with F2's `armUndo` / `holdUndo` (the Undo countdown waits while the location sheet covers the bar).
- **Docs.** F5's A53–A56 → A59–A62 and its review fixes A57 → A63 (§19); v9.1's A57–A61 → A64–A68 (§20).
- **Tests.** `tests/unit/desk/render.test.tsx` pins `Date` to its fixture's NOW (the stub's last sync went stale on the real clock after 2026-11-07 03:10:30 UTC, so "shows no counts until data has loaded" failed on `main` too). e2e: the docked-board and iPad landscape tests follow the open request without tabs (`toBeInViewport`); `stages.spec.ts` checks the pane-open cells with waits ("Needs info · 16m", "Not found yet · 24m").

**A70 · Dashboard Performance windows and "None"** (Brian 2026-11-06 21:55–22:05; `components/dashboard/DashboardView.tsx`).

- Contexts (`PERF_CONTEXT`): Time to answer "last 2 hours", Time to reunite "last 2 hours" (lp_stats' reunion window is 2 hours too), Logged "last hour". Spoken: "Average time to answer over the last 2 hours: 9 minutes.", "Average time to reunite over the last 2 hours: 18 minutes."
- An empty value (`null`, or a field an older lp_stats leaves out) shows `PERF_NONE` "None" (`.val.none`), spoken "No one is waiting for a check.", "No answers in the last 2 hours.", "No reunions in the last 2 hours.", "Nothing logged in the last hour."; Logged 0 is "0".
- `DashboardContent` takes `failed` (`useStats().failing`, the Reconnecting thresholds): then an empty value shows `NO_VALUE` "—" and says "…: not available."; loaded values still show.
- **Tests.** `tests/unit/dashboard/dashboard-render.test.tsx` (the contexts, "None" and its sentences, "—" while failing), `tests/e2e/dashboard.spec.ts` ("None" and the contexts with null fields).

**A71 · The F5 release gate** (2026-11-06 night; `design/DECISIONS.md` "The F5 release"). A25's 230 KB stands.

- **First load.** F2 (`main` 85c9320) was 234,911 B gzipped, 609 B under A25; F5 + v9.1 made `/` 236,582 B. Two causes, both measured with source-mapped builds: the store's hold code (≈ 370 B), and a split of the first-load chunk that holds `lib/domain.ts` and `lib/format.ts` into two (≈ 950 B of lost compression). Turbopack splits it whenever a new import edge reaches those two modules: `domain.ts` importing `format.ts` (for `holdDetail`), a new first-load module importing both, or an `import()`ed module importing either. So:
  - `lib/client/hold-rules.ts` (ADD) is the hold's client side as `holdRules(d: HoldDomain)`, with type-only imports; the store loads it with `import()` (`store-core.ts` `loadHold`, started in `start()`; `runStatus` awaits it, and a failed load is a "Couldn't save" toast and is retried on the next tap) and binds it to lib/domain's values itself. `lib/client/hold.ts` binds it the same way for the tests and keeps its exports (`holdsOnNotFound`, `holdFieldsOf` (A72), `statusOverlayFields`, `holdChanged`, `notFoundSnack`, `holdSnackMessage`, `SnackWords`, `HoldFields`). The store must not import `hold.ts`.
  - `holdDetail` moves from `lib/domain.ts` to `lib/hold-detail.ts` (ADD; the alerts and `lib/server/stage-notify.ts` import it), so `domain.ts` imports nothing again (A60 amended: `domain.ts` keeps `RECHECK_MINUTES`, `NOT_FOUND_YET_LABEL`, `isHeld`, `isRecheckDue`, `notFoundHolds` and `actionLabel`). `/signin` is 0.9 KB lighter for it.
  - The alert chime (`lib/client/chime.ts`, no imports) loads with `import()` in `app-shell`'s `ShellHosts`, and is in `VIEW_CHUNKS`. `components/ui/TestDataBanner.tsx` (Jeffrey's, until 12:30 PM ET on Nov 6) and its `ui.module.css` rules are deleted.
  - Result: `/` 235,057 B (229.5 KB; route-only 38.1 KB), 463 B under A25; `/signin` 215.6 KB. A later first-load addition must stay off the first load the same way: check `tests/e2e/first-load.spec.ts`, and if the total jumps by about 1 KB for a small change, look for a new import edge into `domain.ts` / `format.ts` first.
- **The live line's row and the header** (A68 with A51): on the phone header the icons' tap areas (`.ib::before`) and the avatar's (`.icons [data-testid='account-trigger']::after`; the desk sidebar keeps its own) grow up and sideways, never down; the toggle's (`.sort::before`) grows 12 px down, never up, like Refresh now's. Under 361 px the stacked `.liveIn` has a 12 px gap.
- **Desk table, nothing docked under 1040 px:** `56px minmax(0, 1fr) 176px 120px 96px 64px` (Status 180 → 176 px), so the Friend column is more than 100 px at 768 with A58's 96 px Created column.
- **Tests.** `tests/integration/migration.test.ts`: the hold on a scratch copy of production as the F2 release left it (`git show 85c9320:` the rework file): the dry run (last line `rollback;`) keeps nothing, the first paste adds the hold, the second keeps every hold and location, the F2 build's calls work. e2e: `pending-v9.spec.ts` checks for overlapping tap areas at 360, 375, 390 and 430 px; `list.spec.ts` lines the live line's dot (not its box) up with the title; `desk-table.spec.ts` reads the narrow status cell's shown text (`useInnerText`: the hidden "· 2 checks" is still in the DOM).

**A72 · Pending v9.1's review fixes on the release** (`feat/pending-v9` 91cd971 merged `--no-ff` into `release/f5` after the A71 gate; `design/DECISIONS.md` "The F5 release").

- **Docs.** v9.1's amended A58–A61 are this release's A65–A68 (A69's mapping), and its "A54 amended" is A60: the A65 board, the A66 Undo restore, the A67 `stageClock` and the A68 folds above are those edits under their release numbers.
- **The board never stacks** (A65 replaces the release's one stacked column under 720 px): a docked request keeps Waiting for check | Friend coming side by side, and A69's "the desk follows the open request" still scrolls its card into view (`pending-v8.spec.ts` checks both).
- **The Undo restore inside A71's lazy hold.** `holdFieldsOf` and `statusOverlayFields(…, restore)` live in `lib/client/hold-rules.ts` (`HoldFields` is a type there; `lib/client/hold.ts` re-exports both), so the store still imports `./hold-rules` for types only. `showUndo(row, before, to, hold)` takes the loaded rules for the Undo bar's words (`hold.notFoundSnack`) and the record's `restore` (`hold.holdFieldsOf(before)`), and keeps F2's `armUndo` / `holdUndo`; `runStatus(…, restore)` waits for `loadHold` as before.
- **The request's recheck row** shows A69's `stage.recheck` with v9.1's lucide history glyph (`RefreshCw` is the live line's only).

## Team join link amendment (OVERRIDES anything above on sign-in; Brian 2026-11-06 23:55, `design/DECISIONS.md` "Team join link")

Labelled J1 rather than numbered, so it can't collide with the F5 release's A59–A72; it ships right after F5.

**J1 · Team join link** (extends §3, §6 `POST /api/session`, §8 Sign-in, A17, A27, A29).

- **Link:** `https://<host>/signin#join=<code>`; `/#join=<code>` too (the proxy's 307 to `/signin` keeps the fragment). The code is 32 random bytes, base64url (`scripts/make-invite.mjs`).
- **Client** (`lib/join-link.ts`). `JOIN_LINK_SCRIPT`, inlined with the theme script in `app/layout.tsx`, runs before first paint on every page and again on every `hashchange` (a link opened in a tab already showing that page only changes the fragment, with no reload): when the fragment has `join`, it keeps the trimmed code (1–200 characters) in sessionStorage `lp-join` on `/signin` only, and removes the fragment with `history.replaceState(history.state, '', pathname + search)` on any page. `captureJoinCode()` does the same from `SignInFlow` (with a fresh state, A26) and returns the kept code. Never localStorage, cookies or the URL. This clears the address bar and the tab's back / forward entries; the browser's History list (and its suggestions and sync) already saved the visited link and keeps it until it expires, which no page script can change.
- **Sign-in flow** (`SignInFlow.tsx`, `WhoStep.tsx`). With a kept code, step 1 opens even for a remembered identity (prefilled). Continue posts `{staffName, team, otherTeam?, invite}` (`inviteSignInBody`) and shows its spinner. 200 → forget the code, `writeRememberedIdentity`, `announceSignIn`, `location.replace(next ?? '/')`. 401 → forget the code and open step 2 with no message. 429 → keep the code and step 1, show `MESSAGES.rateLimited(N)` above Continue and keep Continue disabled until the lock passes (re-checked every 5 s, as Sign in). 400/422, 403, 5xx or no response → keep the code and show the usual message (`MESSAGES`, or the server's 422 text) above Continue. A `hashchange` that leaves a kept code (the link opened in a tab already on `/signin`) switches to that code and opens step 1, prefilled from step 2's identity when step 2 was showing. No visible text about the link; Continue is described to screen readers ("Signs you in with the team link, no password needed") and a status says "Signed in with the team link".
- **Validation** (`signInSchema`, additive): `password` and `invite` are each an optional 1–200 character string, and exactly one is required (neither → 422 field `password`; both → 422 field `invite`). Output `{staffName, team, password}` (unchanged) or `{staffName, team, invite}`.
- **Server** (`lib/server/invite.ts`, `lib/server/env.ts`). `INVITE_CODE_SHA256` (64 hex characters, either case) and `INVITE_EXPIRES_AT` (ISO with `Z` or an offset) are optional; `serverEnv().invite` is null unless both are readable. An unreadable value turns the link off and logs `{lp: 'env', message}` once, naming the variable only; it never fails `serverEnv()`. `inviteMatches` hashes the candidate (SHA-256) and compares with `timingSafeEqual` (always one comparison, also when off), then requires `now < expiresAt`.
- **Route:** `lp_login_begin` first, as for a password; a wrong, expired or switched-off code finishes the attempt as failed (401 `{code: 'unauthorized', message: 'Team link not accepted', field: 'invite'}`, no cookie), a right one as ok, with the same session token and cookie as a password. `logSignIn(method, ok)` prints `{lp: 'signin', method: 'password' | 'invite', ok}` for every checked attempt; never the code, its hash, the name or the IP. No database change (`lp_login_attempts` has no method column, and none is added).
- **Tests:** test servers get a synthetic link (`scripts/test-env.mjs` `TEST_INVITE_CODE` / `TEST_INVITE_ENV`, expiry 2099) unless `.env.test` sets its own. Unit: `tests/unit/join-link.test.ts` (script and `captureJoinCode` on the same cases), `tests/unit/invite.test.ts` (schema, hash compare, expiry, off when unset or unreadable, the log line, `make-invite.mjs`). Integration: `tests/integration/join-link.test.ts` (200 + cookie; wrong / expired / off → 401 counted toward the limit; password path unchanged; no code in the server log). E2E: `tests/e2e/join-link.spec.ts` (Chromium and WebKit; includes the link opened in a tab already on `/signin`, on step 1 and on a remembered step 2, and on `/` signed in, and a 429 on the link).

## Hotfix F5.1 amendment (OVERRIDES anything above on the phone header and sheets; Brian 2026-11-07, `design/DECISIONS.md` "Hotfix F5.1")

**A73 · Hotfix F5.1: the phone header's rhythm, and sheets on the keyboard** (Brian 2026-11-07, from his iPhone; `design/DECISIONS.md` "Hotfix F5.1"; CSS and client only, no migration, first load unchanged at 235,147 B).

- **Header (phone, < 768 px; supersedes A71's "the live line's row and the header").** pending-v9.html frames 6, 7, 9: `.top` padding-top 20 px; the line's 32 px row starts 12 px under the icons (`.live` / `.liveRow` margin-top −4 px, 6 px under it), the same on All, My requests and Pending. The "⇅" toggle is centred on the line, its right edge on the avatar's, 12 px under it; its tap area (`.sort::before`) and Refresh now's in the list header (`[data-testid='refresh-now']::before`) reach 6 px up and down, inside the row, so the header is 104 px as in the mockup and no tap area meets another. Under 361 px the stacked toggle stays 12 px under the line. The desk and the dashboard are unchanged.
- **Sheets on the keyboard.** `lib/client/visual-viewport.ts` (ADD) is the one helper: `keyboardBox(layoutHeight, vv)` (the visual viewport's box while it is more than 100 px shorter at no zoom, with `under`, the part below the layout viewport, at most 120 px: iOS 26 Safari floats its tab bar there and anchors `position: fixed; bottom: 0` above it), `followKeyboard(el)` (writes `data-kb` and `--lp-vv-top` / `--lp-vv-h` / `--lp-vv-under` on visualViewport resize and scroll, and clears them as soon as a text field loses the focus to anything but another one, before WebKit reports the keyboard gone), `lockPageScroll()` (body `position: fixed !important` at its scroll offset, over Radix's `position: relative !important`; ref-counted; puts the scroll back) and `revealDelta` (moved from form-logic, which re-exports it). `Sheet` follows on its Radix overlay, which `ui.module.css` makes the sheet's box (`top` / `height` from the variables, `contain: layout`, so the sheet's `bottom: 0` is the keyboard's top), with a scrim 100vh past it on both sides, a 16 px foot plus `under` while the keyboard is up, and a 250 ms return when it goes (none with reduced motion); a text field focused in it on a `(pointer: coarse)` screen pins the page until the sheet unmounts, and its focused field is scrolled into view inside it. Every sheet with a field gets it: the location sheet and the post picker's "Where?". The phone's request form (new request, edit details) uses the same `followKeyboard` in `use-keyboard-fit.ts` (the variables renamed from `--lp-rf-vv-*`; its foot adds `under`); its list is unmounted under it, so it needs no page lock. Popovers and dialogs from 768 px are untouched.
- **Tests.** Unit `tests/unit/client/visual-viewport.test.ts`. e2e (Chromium and WebKit, iPhone 14): `pending-v9.spec.ts` "header (light / dark)" at 360, 375, 390, 414 and 430 px (centred, 12 px clear, right edges, the row's height, the same line height on all three views, no overlapping tap areas, nothing cut); `pending-v8.spec.ts` "the sheet sits on the keyboard" with a fake visualViewport (the keyboard, a pan, iOS 26's box past the layout viewport: the sheet's bottom is the visual viewport's, the scrim covers the rest, the page doesn't move, back down at once on blur, Skip leaves the scroll where it was); `new-request.spec.ts` "the post picker sits on the keyboard". `list.spec.ts`'s line-under-the-title bound is 14 px (11 px now). No iOS Simulator runtime was installed on the build machine, so the iPhone check is the HANDOFF checklist item.

## Hotfix amendment: sheets swipe closed (OVERRIDES anything above on phone sheets and the phone's Activity sheet; Brian 2026-11-07, `design/DECISIONS.md` "Hotfix: sheets swipe closed")

Brian, from the iPhone Home Screen app: the Activity sheet "doesn't easily scroll away, I can't drag and close it easily" (it opened nearly full height with a 24 px strip of scrim, its grabber only took a tap, and there was no ✕). Client only: no migration, no environment change, the first load unchanged (the swipe code loads when a sheet first opens; the build is precached, so offline too).

- **The swipe** (`lib/client/sheet-swipe.ts`, ADD; attached while a sheet is open by `components/ui/use-sheet-swipe.ts`, which imports it on demand). Pointer events on `window` (any pointer type) drive it; a non-passive `touchmove` on the sheet is cancelled while the gesture could still be the sheet's (and once it is), so iOS and Android never start a scroll or an overscroll bounce under it, which would take the pointer away (`pointercancel`). **Start:** a primary pointer in the sheet (`data-state="open"`), not in a text field (`isTextField`), `input[type=range]`, `select`, `[role=slider]`, `[data-sheet-nodrag]` or a sideways scroller, and not a `pointerdown` something else already took (`defaultPrevented`: the crop frame). **Claim** after 8 px when the move is down (down ≥ sideways) and it started on `[data-sheet-grab]` (the grabber, the Activity header) or every vertical scroller between the finger and the sheet is at `scrollTop` 0; anything else is the browser's (a list scrolled down scrolls). On the claim a focused text field in the sheet blurs (its keyboard goes; `followKeyboard` drops `data-kb` at once, hotfix F5.1), and `data-lp-dragged` stops the slide-in animation from ever replaying. **Follow:** inline `translateY` from the claim point, never above rest. **Release:** close when the offset is at least 25 % of the sheet's `offsetHeight` or the velocity over the last 100 ms is at least 0.6 px/ms down, never at 0.6 px/ms up or faster; the close is the sheet's own `onOpenChange(false)` (the Escape / scrim path, its owner's onClose logic, focus back to the trigger where there is one), run under `flushSync`, so a sheet its owner keeps open (Add photo while it uploads) springs back instead. A closing sheet slides on from where the finger let it go (`data-lp-swiped`, `--lp-swipe-y`, 200 ms, opaque); otherwise it springs back (220 ms). With reduced motion: no slide, no spring, the same thresholds. A `pointercancel`, or a second finger, springs back. A mouse's click at the end of a drag is swallowed.
- **Which sheets.** Every `Sheet` (location, en route, post picker, photos, Add photo, Alerts) whose scrim closes it (`dismissOnOutside`, the default); the crop step (`dismissOnOutside={false}`: no accidental add) does not swipe. The location sheet's own touch swipe (64 px) and its `touch-action: pan-x` are gone (the shared one replaces them).
- **The phone's Activity sheet** (`components/activity/ActivityBell.tsx`, `ActivityPanel.tsx`, `activity.module.css`): the bell is the dialog's `Dialog.Trigger`, so every close (✕, Escape, the scrim, a swipe) gives the focus back to it; a 44 × 44 ghost `IconButton` ✕ "Close Activity" (`data-testid="activity-close"`) after Mark all read in the header, focused when the sheet opens; the grabber is a decorative drag handle (`aria-hidden`, `data-sheet-grab`, `touch-action: none`, 44 px tall with `lp-hit`); the header (sheet only) is sticky over the list and a drag handle too; `top: max(calc(env(safe-area-inset-top) + 44px), 8vh)`, so the strip of dimmed page above it is a 44 px target under the Home Screen app's status bar (iOS keeps taps on the status bar itself). The rows, read state and the desk popover are unchanged.
- **Tests.** Unit `tests/unit/client/sheet-swipe.test.ts` (intent, velocity window, close rule). e2e (Chromium and WebKit, iPhone 14) `tests/e2e/sheet-swipe.spec.ts`: ✕ (44 px, beside Mark all read, focus back on the bell) and the strip close Activity; the grabber follows, springs back, closes past a quarter or on a flick, the header drags it with the list scrolled; in the list a drag down is the list's while scrolled (no touchmove cancelled, the sheet never moves) and the sheet's at the top, up is always the list's; real touch in Chromium (DevTools touch input: the list scrolls, the grabber and the list at its top close it, nothing under the finger opens); reduced motion; no overflow at 320 / 375 px; the location sheet closes with nothing saved and never from its field, and with a (fake) keyboard up the field lets go first and the page is unpinned where it was. `pending-v8.spec.ts`'s swipe uses the shared helper (`tests/e2e/helpers/swipe.ts`); `activity.spec.ts` closes with ✕.

## 21. v2.8 amendments, F3 (OVERRIDE anything above; Messages + en route, Brian 2026-11-06 evening; renumbered from §18 A53–A60 by the F3 + F4 release)

Product decisions: `design/DECISIONS.md` "Messages and en route". Visual spec: `design/screens/updates.html` (v7, `#edit`, `#clarify`, `#colors`) and `design/screens/f34-states.html` frames 5–6. Shared with F4 / F5 through the F3/F4/F5 contract (A78). Built as §18 A53–A60 on `feat/messages`; the F3 + F4 release (§23) renumbered them A74–A81, references included.

**A74 · Data** (`20261106000000_rework.sql` section 7; additive only).

- **Tables** (RLS on, no policies; `service_role` only):
  - `lp_messages(id uuid pk, request_id → patients on delete cascade, staff text, staff_key text, team text, body text 1–500, created_at clock_timestamp(), unsent_at null, client_mutation_id uuid unique)`. Never deleted: an unsend sets `unsent_at`. `staff_key` = `lp_canon_staff(staff)`, stored at write time (no index or constraint may depend on `lp_canon_staff`, which section 6 drops and recreates). Indexes `(request_id, created_at desc, id desc)`, `(created_at)`, partial `(unsent_at)`, `(staff_key, created_at)`.
  - `lp_message_reads(request_id, staff (canonical), last_read_at, read_at, pk (request_id, staff))`: `last_read_at` is the newest message the reader has seen, `read_at` when (the receipt). Index `(staff, read_at)`.
  - `lp_enroute(request_id, staff (canonical), staff_name, eta_at null, eta_minutes 0–60 null, state 'enroute' | 'arrived', updated_at, pk (request_id, staff))`.
  - Partial index `lp_messages_audit_at_idx` on `audit_events(occurred_at)` for the three new action types.
- **Trigger** `lp_enroute_clear` (`after update of status on patients … when old.status is distinct from new.status`, function `lp_enroute_on_status()`, `create or replace`, never dropped): any status other than In medical (legacy Bring friend included) deletes the request's `lp_enroute` rows in the same transaction and writes one `enroute` audit row `{state: 'cleared', status}` attributed to `updated_by` (the rows it cleared in `previous_value.rows`; back to In medical within 30 s restores them, A81). `lp_set_status` is untouched (F5 owns it).
- **Functions** (plpgsql, `security invoker`, `search_path = public, pg_temp`, the RPCs with `statement_timeout = '4s'` / `lock_timeout = '2s'`; dropped and recreated each run; `revoke … from public, anon, authenticated`, `grant execute … to service_role`):

  | Function | Behaviour |
  |---|---|
  | `lp_post_message(p_request, p_body, p_client_mutation_id, p_staff, p_team)` | Any status. Idempotent on the mutation id (a retry → `created: false`; the same id on another request or by another staff → P0422 `field:client_mutation_id`). Body trimmed, 1–500 (P0422 `field:body`). 20 a minute per canonical staff, serialised with an advisory lock (P0429, HINT = seconds). Audit `message_posted {message_id, body}`. Returns `{created, message, activity, recipients}`. |
  | `lp_unsend_message(p_request, p_message, p_staff)` | Another request's message → P0002; someone else's → P0403; older than 15 min → P0422 `too_late` (`field:message`); repeat → `changed: false`. Sets `unsent_at`; audit `message_unsent`. |
  | `lp_mark_read(p_request, p_staff, p_upto)` | Moves the cursor forward to `least(p_upto, now)` only past someone else's message; `read_at` = now. Not audited. Returns `{changed, activity}`. |
  | `lp_set_enroute(p_request, p_action, p_eta_offset_seconds, p_eta_at, p_eta_minutes, p_staff)` | `set` (ETA = `p_eta_at`, else now + offset, clamped ±6 h), `cancel` (only mine), `arrive`. Not In medical → accepted, `{changed: false, ignored: true}`. A repeat (same state, same pill, ETA within 30 s) changes nothing. Locks the patient row `for share`. Audit `enroute {state: enroute | changed | cancelled | arrived, eta_at, eta_minutes, staff_key}`. Returns `{changed, ignored, event, activity, recipients}`. |
  | `lp_involved_staff(p_request) returns setof text` | Contract C: canonical logger, In medical / Not in medical answerers (legacy actions too), location setters, everyone who messaged, everyone ever en route (audit) or en route now. |
  | `lp_messages_thread(p_request, p_staff, p_before_at, p_before_id, p_limit 100 ≤ 200)` | The latest page before the keyset cursor, oldest first, unsent left out, `has_earlier`, and on the first page the receipt of the caller's latest message (`read_at` = earliest `read_at` of another reader whose cursor is at or past it). |
  | `lp_messages_sync(p_staff, p_ids, p_since, p_changed)` | The activity of every id in `p_ids` with any message or en route, plus (with `p_changed`) every request whose thread changed since `p_since − 30 s` (a message posted or unsent, an en route event, the caller's own read), and `lp_row` of those not in `p_ids` whose own row is older than `p_since − 30 s` (the others are in lp_sync's delta, on this page or a later one, so a paged delta never repeats a row). |
  | `lp_enroute_stats()` | `{friendsEnRoute, avgArriveMinutes}` (A79). |
  | `lp_messages_activity`, `lp_enroute_summary`, `lp_messages_json` | Internal helpers. |

- **Production**: additive and safe while the live build serves (it never calls these; the trigger only deletes en route rows, which only this build writes). Apply the file before deploying this build; a second paste keeps every message, read and en route.

**A75 · API** (every route: session, same-origin for writes, zod, `no-store`, codes only in logs).

| Route | Behaviour |
|---|---|
| `GET /api/requests/:id/messages[?beforeAt&beforeId]` | `ThreadPage` (`lp_messages_thread`). |
| `POST /api/requests/:id/messages` | `{clientMutationId, body}` → 201 / 200 `PostMessageResponse`. P0429 → 429 `rate_limited` with `Retry-After` and `retryAfterSeconds` (DbContext `message`). |
| `POST /api/requests/:id/messages/read` | `{upto?}` → `ActivityResponse`. |
| `POST /api/requests/:id/messages/:messageId/unsend` | → `ActivityResponse`; 403 / 404 / 422 as A74. |
| `POST /api/requests/:id/enroute` | `{action: set, etaMinutes: 0 | 5 | 10 | 15 | null, queuedMs?}`, `{action: set, etaAt, etaMinutes}` (Undo of a cancel), `{action: cancel | arrive}` → `ActivityResponse` (`ignored` when not In medical). |
| `GET /api/sync` | Every row carries the activity (A76); the first page of a delta adds the rows whose thread changed. If `lp_messages_sync` fails the rows go out without it (the client keeps what it had). |
| `GET /api/requests/:id` | Plus `thread` (the first page) and the activity; without them if the thread can't be read. The audit trail leaves out `message_posted`, `message_unsent` and `enroute` (`THREAD_AUDIT_ACTIONS`). |
| `GET /api/stats` | Plus `friendsEnRoute` and `avgArriveMinutes` from `lp_enroute_stats()`; left out if it fails. |

**A76 · RequestSummary activity** (`lib/api-types.ts`, all optional; contract F): `messageCount`, `lastMessageAt`, `unread` (for the caller), `needsInfo`, `lastMessage {by: "Rae C.", mine, text ≤ 120}`, `enroute {count, earliestEta, state, mine: {etaAt, etaMinutes?, state?} | null}`, plus `involved` (the caller is in `lp_involved_staff`; for the message alert). Rows without them (cached before this build, or a mutation answer built by `lp_row`) keep the client's (`carryActivity`): a status change ends `needsInfo` and drops `enroute` outside In medical. `sameRow` compares object values as JSON, so an unchanged poll keeps the row's identity.
- **needsInfo** = status `Added`, the latest (not unsent) message is from the Medical team, and it was written after the request's last `status_changed` / `cancelled` audit event.

**A77 · Client** (`lib/client/messages-core.ts`, `messages-logic.ts`, `messages-hooks.ts`; `StoreActions.messages`).
- **Outbox**: every message and en route tap is a job saved in IndexedDB (`mjob:<id>`, a prefix older builds never read) before it is sent, sent in order under the Web Lock `lp-msg-outbox`, exactly once (server idempotency; en route repeats are no-ops). Offline it waits ("Sending…", attempts not counted). 401 pauses; 429 waits `Retry-After` (toast once); a definitive 4xx with our error body, or 3 failures online, → `failed` ("Not delivered · Retry", Delete). Only sent while the signed-in staff is the job's operator. `queuedMs` keeps an en route's ETA from the tap. Other tabs reload on BroadcastChannel `mjobs`.
- **Threads**: loaded when a request's Messages is on screen (`open`), refreshed every 6 s while visible and whenever the synced `lastMessageAt` / `messageCount` changes; the latest page cached per staff under `cache:<event>:<staff>:thread:<id>` (cleared with the cache at sign-out). `markRead` posts the newest message shown, once per newest message from someone else, and clears the badge at once.
- **Alerts**: `diffMessageAlerts` (a newer `lastMessageAt`, not mine, unread, involved, not the first sync, not an open thread) → `AlertEvent.kind 'message'`, toast + chime through the A52 plan when it routes to a toast; nothing when the page is hidden (F4's Web Push). Key `${id}:m:${lastMessageAt}`.
- **Sign-out** is refused while jobs exist (`{reason: 'outbox', count, messages}`); discarding deletes the `mjob:` keys. Another staff signing in clears the threads; jobs stay for their owner.
- **En route Undo** uses the store's snackbar with a custom handler (`showCustomUndo`), 5 s.

**A78 · Notifications** (contract A/B/D). `lib/server/notify.ts` is F3's no-op stub with F4's exact API. After a real write the route calls `notifyStaff(recipients, event)` with the recipients the SQL function returned (`lp_involved_staff`): `message` ("Rae C.: Bring 1 person only"), `enroute` / `enroute_changed` ("Friend en route · ~4 min", or "Friend en route"), `enroute_cancelled` ("En route cancelled"), `arrived` ("Friend arrived"). Unsend, read and repeats notify nobody.

**A79 · UI** (`components/messages/*`).
- **Request**: `MessagesSection` after the status block (and the desk pane's actions): heading, the thread in a scroll box (`min(60dvh, 520px)`, opens at the newest, "Earlier messages", "New messages" pill, `aria-live` for incoming), the composer right under it. `StatusEnroute` under the location row.
- **Cards**: `MineActivity` (My requests), `CheckPreview` + `MessageIconButton` (To check, grid `44px 1fr 1fr`), `ComingEnroute` + `MessageButton | Reunited` (Friend coming). Slots read the store themselves; their wrappers let taps fall through to the card's open button. Screen readers get the preview as one sentence ("Last message, unread, from Rae C.: Any tattoos or marks?"); the visible line is hidden from them. A Message button is named "Message about J.D." or, with unread messages, "Message, 4 unread messages about J.D.": the visible "Message" and its count, in that order (WCAG 2.5.3; axe `label-content-name-mismatch`). `tests/e2e/a11y.spec.ts` audits the cards and the thread with unread messages from medical, in both themes.
- **The message lane** (2026-11-07, `design/screens/msg-indicator.html`, `design/DECISIONS.md` "Message lane"): `MessageMark` leads every phone log row (All, Search) and every desk table row (before #), in place of the phone's # column and the desk's count pill after the name: the blue bubble with the unread count ("99+" from 100) whenever `unread > 0` (for everyone: no involved gate), the grey outline `MessageSquare` while the request has messages, nothing without. The row's sentence ends with " 2 unread messages." / " 4 messages."; the folded Archived row carries its rows' unread total. Pending's Friend coming header and the nav's Pending (sidebar and rail): the filled `MessageSquare` in the badge blue (`UnreadDot`, `PendingDot`).
- **Dashboard**: `EnrouteTile` (full width under the tiles; "—" when missing, read as "not available"; named by its own text like the six tiles, "Friends en route 3") and the "Time to arrive" Performance row.
- **Export**: `docs/export.sql` Query 3 (case number, when, staff, team, type, text or state, ETA, unsent, unsent at).
- **Tests**: `tests/unit/messaging.test.ts`, `tests/unit/client/store-messages.test.ts`, `tests/unit/client/messages-lazy.test.ts`, `tests/integration/messages.test.ts`, `tests/e2e/messages.spec.ts` (two phones; overflow of the thread, the cards, the To check card and the en route sheet at 375, 390, 820, 1180, 1440 via `tests/e2e/helpers/overflow.ts`), the axe audit in `tests/e2e/a11y.spec.ts`, and `tests/e2e/f3-screens.spec.ts` (the `f3-*.png` renders; only with `LP_F3_SCREENS=1`, on a freshly seeded stack).
- **Live region**: the thread's polite announcer is portalled to the end of `<body>`. Inside the request it would make a modal menu's `aria-hidden` (Radix `hideOthers`, which keeps live regions readable) hide the request piece by piece instead of at its root. The composer's counter is not live; the field points to it with `aria-describedby` while it shows.

**A80 · First load** (A25, as A52 did). The store creates `createLazyMessaging` (`lib/client/messages-lazy.ts`), which loads `messages-core.ts` with `import()` when the store starts: a thread opened before it loads opens once it has, other calls wait and run in order, sign-out counts unsent messages without waiting for it (A81), and a failed load (offline before the service worker cached the chunk) is tried again on the next call; a send or en route tap then says "Messages need a connection" and drops nothing. Only the store's side stays in the first load: `lib/client/messages-activity.ts` (carrying activity over a mutation answer, the message alert) and `lib/messaging-activity.ts` (the activity fields). The F3 base already measured 230.2 KB (route-only 38.8 KB) against the 230 / 40 KB budget; with messages it is 232.1 / 40.7 KB. `tests/e2e/first-load.spec.ts` now allows **234 KB / 42 KB**.

**A81 · F3 review fixes** (overrides A74, A77, A78, A79, A80 where they differ; `design/DECISIONS.md` "Messages and en route — review fixes").
- **Boot and sign-out never wait for the messages engine.** `boot()` calls `void messaging.hydrate()`; the first sync, `kickOutbox()`, the legacy-queue import and a resumed sign-out run straight after IndexedDB opens. `createLazyMessaging` remembers a `hydrate()` asked for and runs `engine.hydrate()` (then `kick()`) as soon as any call loads the engine, so jobs saved before a failed boot load are read and sent. `signOut()` asks `messaging.unsentNow()`: the engine's count once it has read its jobs, else the number of `mjob:` keys in IndexedDB. `clear()` without the engine deletes the `mjob:` keys at once (an engine that loads later reads IndexedDB after that, through the same queue).
- **Failed en route taps.** `effectiveEnroute` applies my latest en route tap even when it failed (what I asked for stays on screen); `failedEnrouteTap` / `useFailedEnroute` give the failed one, and `EnrouteFailed` (`data-testid="enroute-failed"`) shows **Not delivered · Retry** (`api.retry`) and × (`api.discard`) under the row, or in its place, on My requests and Friend coming cards and in the request's status block (at any status, so a lingering tap can always be retried or deleted). `setEnroute` first removes my failed en route jobs on the same request (a new tap replaces them).
- **`lp_set_enroute('arrive')`** also sets every other `'enroute'` row on the request to `'arrived'` (audit `also_arrived: n` on the arriving staffer's row; no audit row of their own, so Time to arrive is unchanged). Arriving without an en route row still records an arrival (a queued tap may land after an ignored set; the friend is there).
- **`lp_enroute_stats().friendsEnRoute`** counts In medical requests whose `lp_enroute` rows are all `'enroute'` (`bool_and`): any `'arrived'` row takes the request out.
- **`lp_enroute_on_status()`**: the `cleared` audit row keeps the deleted rows (`previous_value = {count, rows: [{staff, staff_name, eta_at, eta_minutes, state, updated_at}]}`). On a change back to In medical it restores them (`insert … on conflict do nothing`, audit `enroute {state: 'restored', status, count}`) when the latest `cleared` row is under 30 s old, was cleared to `old.status`, no `enroute` audit event followed it, and the request has no en route rows. Cleared rows from before this change have no `rows` and are never restored.
- **Quick lines**: `quickLines(stage, side, enrouteMine, arrived = false)`; with `arrived` front of house's In medical lines leave out En route / Arrived.
- **Notification detail**: `messageDetail` masks contact details before the 120-character cut (`maskContacts`: email addresses, and runs of 7+ digits joined by spaces, dashes, dots, slashes or brackets → `•••`). Only the notification detail; the thread and `lastMessage` keep the text.
- **Routes** `POST …/messages` and `POST …/enroute` notify through `after()` from `next/server`: the response never waits for `notifyStaff` (F4's real one included). `tests/unit/messages-routes.test.ts`.
- **Read-only en route row**: no `role="status"`; the visible parts are `aria-hidden` and a `VisuallyHidden` sentence says it all. The tappable row (mine) keeps its button name.
- **Card slots**: `.cardSlot`, `.inStatus` and `.enr` are `box-sizing: border-box` (a read-only row is a `div`, which stuck out 24 px past the card).
- **Tests**: `tests/e2e/messages.spec.ts` checks overflow of a Pending → Friend coming card with a teal, an amber "late" and a green "Friend arrived" row, My requests cards where someone else is en route or the friend arrived, and the en route sheet (new and edit, opened from the request) at all five widths; a failing En route tap (503) shows "Not delivered · Retry" and Retry sends it; the quick lines after Arrived. `f3-screens.spec.ts` adds `f3-coming-*.png` (compare with `updates-v7-4.png`). `desk-shell.spec.ts` accepts the Pending link's "Unread messages" dot in its name (A79), which shows whenever a Pending request has unread messages.

## 22. F4 amendments (OVERRIDE anything above; Web Push, the Alerts sheet and the Activity inbox, 2026-11-06 evening; renumbered from §18 by the F3 + F4 release)

Product decisions: `design/DECISIONS.md` "F4 · Lock-screen alerts". Visual spec: `design/screens/f34-states.html` (f34-v2-1..4, 7, 8, 9), `design/screens/alerts-banner.html` (alerts-banner-1..5), rules in `design/references/mobbin-activity-inbox.txt` (the brief wins). Shared with the Messages (F3) and Not found yet (F5) releases through the contract below. Built as §18 A53–A60 (and A57b) on `feat/web-push`; the F3 + F4 release (§23) renumbered them A82–A89 (A86b), references included.

**A82 · Kinds, copy and the contract (lib/activity.ts, pure).**

- `ActivityKind` = message, enroute, enroute_changed, enroute_cancelled, arrived, new_request, in_medical, not_in_medical, back_to_waiting, moved, reunited, discharged, cancelled, edited. `ActivityEvent {requestId, kind, actor, detail}`. `lib/server/notify.ts` re-exports both and exports `notifyStaff(recipients, event)` (contract A; F3 and F5 ship a no-op stub with the same API).
- `detail` (contract B) is line 2 of the Activity row AND the push body, nouns only, built by the caller with the helpers: `messageDetail` ("Rae C.: …", 120 characters), `enrouteDetail`, `newRequestDetail` ("T.R. · 24 M · FA 4"), `inMedicalDetail` ("In medical · Chair 9"), `backToWaitingDetail`, `movedDetail` ("Chair 9 → Bed 3"), `closedDetail`, `EDITED_DETAIL`. Status words come from `STATUS_META`, so a label rename flows through. `scrubDetail` removes `LP-####` and phone-number runs (7+ digits) and caps it at 200 characters; it runs on every stored, listed and pushed detail.
- Line 1 / the push title: `requestTitle(first, last)` = `domain.initials(joinName(...))`, else "No name"; "New request" for new_request. The row's line 2 is `activityLine2(row)`: the detail, except a new request, where the leading initials (already line 1) become "New request": "New request · 24 M · FA 4" (f34-v2-2); the stored detail and the push body are unchanged.
- **The bell in the phone header** is 36 × 36 (border-box; 44 px hit area). On a phone ≤ 400 px wide the list title and count step down to 24 px (`components/list/list.module.css`), so the title is not cut beside search, the bell and the avatar.
- One glyph and Radix colour per kind (`ACTIVITY_GLYPH`); not_in_medical whose detail starts "Not found yet" is the violet hourglass. `badgeText` (hidden at 0, 1–9, "9+"), `activityTime` ("now", "2m", "1h", then "h:mm AM/PM" in the event timezone), `groupByDay` (labels only when the rows span more than one day), `activityAriaLabel` (a full sentence ending "Unread." when unread).

**A83 · Web Push.**

- **Keys.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or `https:`), validated (65- and 32-byte base64url). Missing or malformed: push is off, silently (`POST /api/push/prefs` answers `enabled: false`, no row is stored, nothing is sent, the client shows no banner). `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is read as the public key when `VAPID_PUBLIC_KEY` is not set; the client always gets the key from the server.
- **Package.** `web-push` **3.6.7** (pinned; 4.0.0 was released on 2026-11-06, under two weeks old). aes128gcm, VAPID per call, `timeout` 5 s and an overall race at 5.5 s.
- **Endpoints.** https on a push service only: `fcm.googleapis.com`, `android.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`, port 443, no credentials. Anything else is refused with 422 and never posted to. `https://127.0.0.1` is allowed only with `LP_PUSH_ALLOW_LOCAL=1` AND a local Supabase URL (tests; production never has a local Supabase URL), with a self-signed certificate accepted for that host only.
- **Per event.** One push per device (endpoints deduplicated), payload `PushPayload {v, title, body, tag: "lp-<id>", url: "/?r=<id>", kind, requestId, renotify (messages), badge (the recipient's unread count)}`, under 3 KB (the limit is 4 KB). Urgency high and TTL 3600 s for new_request, in_medical, not_in_medical, back_to_waiting and message; normal and 900 s otherwise. 404 / 410 delete the subscription; anything else adds a failure, and 5 in a row delete it; a success records `last_ok_at` and resets failures (`lp_push_result`).
- **Service worker (`public/sw.js`).** `push`: parse defensively, set the app icon badge, post `{type: 'lp-push', kind, requestId}` to every app window, then: no app window visible AND focused → `showNotification(title, {body, tag, renotify, icon: /icons/icon-192.png, data: {url, push: true, …}})`; a window in front → nothing on Chromium and Firefox; on WebKit (Safari, every iPhone browser) shown with `silent: true` and closed at once, because WebKit revokes a subscription after three pushes that show nothing. A push that fails to parse still shows "Is my friend in medical?" (tag `lp-update`). `pushsubscriptionchange`: subscribe again with the old key (or take the new subscription) and `POST /api/push/subscribe {…, oldEndpoint}`. `lp-caps` answers `{notificationClick: true, push: true}`; the page subscribes only once the active worker says `push: true`. The existing click handler opens `data.url`. Every earlier worker behaviour is unchanged.
- **No double alerts.** The page: while this device holds a subscription the server confirmed for the signed-in staff, `emitAlerts` drops alerts routed to a system notification (the push carries them, or the switch said not to); the store asks `pushHooks()?.covers(kind)` (`lib/client/f4-bridge.ts`, registered by the push client). The toast in front is unchanged. Without a subscription: A52 as before. The page's own notifications now use the tag `lp-<id>` too (`system-notify.requestTag`; `close(requestId, key)` builds it), so the OS replaces rather than stacks.

**A84 · The switches, the Alerts sheet and the test alert.**

- `lp_push_prefs (staff pk, team, new_requests, my_updates)`: created on first use with `new_requests` = the phone's old bell (`bell` in the request), else false, and `my_updates` true. Every subscription of the staff member copies them (`lp_push_subscriptions.new_requests / my_updates`, used to pick push targets).
- `POST /api/push/prefs {newRequests?, myUpdates?, bell?}` → `{enabled, publicKey, newRequests, myUpdates}` (a POST because the first call creates the row; same-origin, zod strict).
- `POST /api/push/test {endpoint}` → `{sent}`: a real push ("Is my friend in medical?" / "Test alert", tag `lp-test`) to that endpoint only, 404 unless the subscription belongs to the signed-in staff.
- The client keeps `prefs.bell` equal to the server's "New requests" (the Activity host), so one switch drives the in-app new-request toast, Activity rows and pushes. The sheet: device state ("On for this phone / iPad / computer", "Lock screen + sound"; Off + Turn on; Off + the install chips; Blocked + the path (+ Check again on a computer); Not supported, with the A52 "Allow notifications" row where the page can notify), "Send a test alert" when on, then the two switches (Radix Switch, green).

**A85 · The Activity inbox.**

- `lp_activity (staff, request_id → patients on delete cascade, kind, actor, detail, at, read_at; pk (staff, request_id))`: ONE row per staff and request. `lp_activity_record(recipients, request, kind, actor, detail)` canonicalises the recipients (`lp_canon_staff`), drops the actor and duplicates, upserts each row with `at = now(), read_at = null`, prunes that staff member's rows older than 3 days or beyond their newest 100, and returns `{written, targets (subscriptions whose switch for the kind is on), unread {staff: n}, firstName, lastName}`.
- `GET /api/activity` → `{serverTime, rows: ActivityRow[]}` (newest first, ≤ 100, 3 days; `title` = initials). `POST /api/activity/read {requestId} | {all: true}` → `{count, ids}`. `POST /api/activity/unread {requestIds}` (Undo) → `{count}`. All service_role functions, RLS on, no policies.
- `GET /api/sync` (first page only, read in parallel, additive): `activityUnread` (unread requests) and `activityKey` (16 hex characters: an md5 of every Activity row's request, time and read state, so it moves whenever a row is added, changed or read; left out when nothing is unread, so the empty delta stays under 120 bytes and a 0 tells the client everything is read); never the ids (A89). Left out when it can't be read. `GET /api/activity/unread` → `{count, ids (newest first, ≤ 100), key}`.
- Client (`lib/client/activity-client.ts`, in the F4 chunk): the count follows sync (`publishSyncExtras` in `lib/client/f4-bridge.ts`, called with the store's first page; a client that starts later is told the last value at once); when the key moves it fetches the ids (`GET /api/activity/unread`), or with the sheet / popover open the list itself, so an open list follows every new event at the sync cadence; the list loads when the sheet / popover opens; `markRead(id)` when a request opens from anywhere (the Activity host watches `?r=` / edit); Mark all read keeps the returned ids for a 5 s Undo; `navigator.setAppBadge(unread)`, also at the first sync after start (a badge a push left is cleared at 0).
- UI: the bell (`components/activity/ActivityBell.tsx`, Radix IconButton, `aria-label` "Activity, 3 unread") next to search in the phone header and at the end of the desk top bar; the sidebar item ("Activity" + the count; its name comes from that text) and the rail icon open the same popover (shared open state). Phone: a full-height Radix Dialog sheet whose grabber is its close button ("Close Activity", 44 px with `lp-hit`); Escape and the scrim strip above it close it too (superseded by "Hotfix: sheets swipe closed": ✕ in the header, a drag handle, a taller strip). ≥ 768 px: a Radix Popover, 380 × ≤ 480, scrolling. "Mark all read" is an icon button with a CSS-only tooltip (no Radix Tooltip, see A88 First load).

**A86 · Who is notified (contract C, D).**

- `involvedStaff(id)` (`lib/server/involved.ts`): `lp_involved_staff` (F3's; any error, PGRST202 / 42883 included, or an empty answer) → `lp_activity_fallback_staff` (whoever logged it and whoever answered In medical / Not in medical, legacy answers included) → `[]`. `newRequestStaff()`: everyone with "New requests" on.
- Routes (after the response, `notifyLater`): `POST /api/requests` (created only) → new_request; `POST /api/requests/:id/status` (changed only) → in_medical (with the location), back_to_waiting, reunited, discharged — **never not_in_medical** (F5); `POST /api/requests/:id/cancel` → cancelled; `PATCH /api/requests/:id` → from the audit row it just wrote: the first location while In medical → in_medical "In medical · Chair 9", another location → moved, else edited. Photos notify nobody.
- `notifyStaff` never throws and never delays a response: it runs under `next/server` `after()` (Vercel keeps it alive with waitUntil); where `after()` is unavailable the caller waits at most 1.5 s. It logs only `{lp: 'notify', code, counts}`.

**A86b · The page's own notifications drop the LP number (overrides A52 Content).** Brief rule: no request id (LP-####) in Activity rows or notifications. Without Web Push on a device, the page's own system notification (A52) now reads the way the push does: "S.L. · In medical" / "FA 3", then "Bring the friend to Main Med"; "S.L. · Not in medical" (the status's short label from `STATUS_META`) / "FA 3"; "New request" / "T.R. · FA 4"; 3 or more at once: "3 new requests" / "A.R., B.R., C.R., +N" (initials, up to 4). A request with no name is "No name". Tags are `lp-<id>` (A83). In-app toasts are unchanged. Tests: `tests/unit/client/system-notify.test.ts`, `tests/e2e/notify.spec.ts`.

**A87 · The alerts banner (`components/alerts/AlertsBanner.tsx`, `lib/client/alerts-platform.ts`).**

- `detectPlatform` from the user agent, `platform`, touch points and display mode: iPhone / iPad (iPadOS desktop mode is a Mac with touch), Safari's frozen iOS version (`Version/26+` is the real major on iOS 26+), Android, desktop OSes, and the browser.
- `alertsStatus`: unsupported (push off on the server, iOS before 16.4, no service worker / PushManager / Notification, or an active worker without push) → nothing; checking (the server or the worker has not answered) → nothing; iPhone or iPad not standalone → install; denied → blocked; granted and subscribed → on; else off. The step chips (`installSteps`, `blockedSteps`) are DECISIONS F4 row 7; the chips are `aria-hidden` and a screen reader hears one sentence.
- Shown on All, Pending and My requests (phone: above the sticky header; desk: top of the main column), never on Search, a request, a form or the dashboard. Turn on calls `pushManager.subscribe()` synchronously in the tap.

**A88 · Lifecycle (`lib/client/push-client.ts`).**

- Start (per staff member): `POST /api/push/prefs {bell}`, the worker's `lp-caps`, then with permission granted: a subscription for the current key (another key → unsubscribe and subscribe again) and `POST /api/push/subscribe` once per page load and staff member (re-binds the device; a rotated endpoint goes with `oldEndpoint`). The permission is read again on focus, visibilitychange, online, controllerchange and the Permissions API change event: revoked → the banner returns; allowed again → subscribed without asking.
- Sign-out: before the cookie is cleared, `DELETE /api/push/subscribe {endpoint}` (it never re-issues the cookie) and `subscription.unsubscribe()` (bounded 3 s by `pushHooksFor`, never rejecting); Activity and the app badge are cleared. A 401: the browser unsubscribes (the server learns on the next push: 404 / 410). Another staff member signing in on the device re-binds it. No quiet hours; never a push to the actor.
- **First load (A25).** Nothing of F4 is on the first load but `lib/client/f4-bridge.ts` (push hooks, the sync extras, the store's API door) and a few calls in the store. The pieces render through `components/activity/slots.tsx` (`next/dynamic`, client only) from one chunk, `components/activity/F4Parts.tsx`; the shell mounts the Activity host through the existing dialogs chunk. The F4 clients send through the store's own `call` (`provideApi(call)` at start; `lib/client/via-store.ts`), so a sign-out holds and aborts their requests like the store's, and they never import `lib/client/http.ts` (a module shared with a lazy chunk is split out of the store's scope-hoisted code). Lucide's Bell, Check, X, RefreshCw and Ellipsis are drawn in `components/activity/icons.tsx` for the same reason, and the "Mark all read" tooltip is CSS. Measured with the spec's own method (`tests/e2e/first-load.spec.ts`), F4 adds about 0.1 KB gzipped. The base it was built on (`b17f47b`) already measures 235,758 B (230.2 KB) against the 235,520 B budget, so `first-load.spec.ts` fails there as well; the integrator has to win back about 0.4 KB across the merged releases.
- **Migration.** Section "F4 ·" of `20261106000000_rework.sql`: three new tables (`create table if not exists`) and `lp_push_*` / `lp_activity_*` functions (every overload of those names dropped first, then created; `service_role` only). Additive: the build that is live now never calls them; a re-run keeps every row. Production: apply the file (dry run, then commit) **before** deploying this build, or every `/api/push/*` and `/api/activity*` call answers 503 and sync leaves out `activityUnread` (rows still sync).
- **Tests.** Unit: `tests/unit/activity.test.ts`, `tests/unit/client/{alerts-platform,push-client,activity-client,store-push}.test.ts`, `tests/unit/server/{push,involved}.test.ts`, `tests/unit/sw/push.test.ts`. Integration: `tests/integration/push.test.ts` (routes, wiring, a fake HTTPS push service that decrypts every push), `tests/integration/notify.test.ts` (notifyStaff with web-push mocked, involvedStaff). E2E: `tests/e2e/alerts.spec.ts`, `tests/e2e/activity.spec.ts` (each with overflow checks at 375, 390, 820, 1180 and 1440 px; a push is dispatched inside the worker with `worker.evaluate`, because CDP's push delivery and `setAppBadge` in a worker crash the headless Chromium shell), screenshots `tests/e2e/f4-screens.spec.ts` (`LP_F4_SCREENS=1`). `scripts/with-e2e-lock.mjs --migrate -- <cmd>` holds `/tmp/lp-e2e.lock`, re-applies this branch's migration twice and runs the command; Playwright inside it does not wait for the lock it is under (`LP_E2E_LOCK_OWNER`).

**A89 · F4 review fixes (2026-11-07; DECISIONS F4 rows 15–23).** Overrides A83–A88 where they differ.

- **Sign-out (A88).** `PushHooks` (`lib/client/f4-bridge.ts`) is `covers`, `beforeSignOut()`, `afterSignOut(confirmed)`, `onSessionEnded()`. The store calls `beforeSignOut()` before it marks the sign-out pending (the push client's `DELETE /api/push/subscribe`, through the store's `call`, while the session still says whose the device is); the browser's `PushSubscription` and the push client's state are untouched until `deleteSession` confirms. Confirmed → `afterSignOut(true)` (unsubscribe in the browser, forget the staff member, clear the badge), right after the `logout` broadcast; with no push client registered (a sign-out resumed at load, before the F4 chunk) the store calls `dropBrowserPush()` instead (`navigator.serviceWorker.getRegistration()` → `pushManager.getSubscription()` → `unsubscribe()`, bounded 3 s; the server deletes the row at the next push, 410). Not confirmed → `afterSignOut(false)`: if the DELETE may have reached the server (anything but a request that never left), the client posts `/api/push/subscribe` again; if that fails too it counts as not subscribed (so `covers()` is false and the page's own notifications stand in) until focus / online / visibility re-checks. Every hook is bounded (3 s) and never rejects. Tests: `tests/unit/client/store-push.test.ts` (offline and 5xx sign-outs keep it; a resumed one drops it), `tests/unit/client/push-client.test.ts`.
- **`covers(kind)` (A83).** True only when subscribed, the kind is one the server pushes in this build (`PUSHED_ALERT_KINDS`: in_medical, reunited, new_request, status_changed; **not** not_in_medical until F5 is merged) and the staff member's switch for it is on (`newRequests` for new_request, `myUpdates` for the rest). `pushCovers(state, kind)` is the pure rule.
- **In front (A83).** The worker no longer decides "in front" by `visible && focused` alone: it posts `{type: 'lp-push', kind, requestId, title, body}` to every app window, with a `MessageChannel` port to each visible one, and waits up to 600 ms for `{front}`. The page answers `inFront(browserWindow())` (`lib/client/system-notify.ts`, the same rule as its toasts: visible, and on a hover / fine-pointer device focused). Any window front → nothing shown (WebKit: shown silently and closed, as before); a window that does not answer (an older build) counts as front when visible and focused; hidden windows are told, not asked. `kind: 'test'` (Send a test alert) always shows (`showNotification`, not silent), front or not.
- **The app carries a push in front (`lib/client/push-toast.ts`, loaded with the Activity host).** On `lp-push` the page syncs; when it answered front, it waits for that sync (the one after a poll already in flight, at most 6 s) and, if no alert toast for the request (or a combined one) showed within 20 s of the push and the store holds the request, shows `showToast({tone: 'neutral', icon: 'bell', title, subtitle: body, action: View, 12 s})`. Not for a test alert.
- **New requests (A84).** `lp_push_prefs.new_requests_set` (added with `add column if not exists`): set when the switch is changed through `p_new_requests` (the Alerts sheet). Until then, `p_default_new_requests` (a device's old bell) ORs into `new_requests` on every call, so no device loses new-request alerts to another device of the same staff member that came first; afterwards the choice stays.
- **Ownership (A83).** `lp_push_unsubscribe(p_endpoint, p_staff)` deletes only the signed-in staff member's row (`DELETE /api/push/subscribe` passes `session.staff`; `{removed: false}` otherwise); `lp_push_subscribe` drops `p_old_endpoint` only when it is the same staff member's.
- **Sync data use (A85).** `lp_activity_unread` returns `{count, ids, key}`; sync sends `activityUnread` + `activityKey` only, and the count alone at 0 (was: up to 100 ids, about 3.9 KB, on every 6 s poll). `SyncResponse.activityUnreadIds` is gone (never shipped).
- **The edit event (A86).** `editEventFor` reads the latest `patient_updated` audit row **by the actor** (`staff_name = actor`), so a concurrent edit by someone else never lends it its change, and its author is never told about their own edit.
- **Desk popover focus (A85).** On open (from the bell, the sidebar item or the rail icon) the popover content takes focus (`onOpenAutoFocus`: the content element, not Mark all read, whose tooltip would show); Tab reaches Mark all read and the rows; Escape (or a row) gives focus back to whatever opened it, unless it closed because of a click or focus outside. WCAG 2.1.1.
- **Chips (A87).** `installSteps` ends with `{label: 'Add'}`; on iOS / iPadOS 26+ that step has `spoken: 'keep Open as Web App on, then Add'` (`Step.spoken` replaces the label in `stepsSentence`). `blockedSteps` names the installed app `HOME_SCREEN_NAME` ('In medical?', equal to the manifest's `short_name` and `appleWebApp.title`, unit-tested) on iPhone / iPad and installed Android; the Mac Dock app keeps `APP_NAME`.
- **The sheet and the inbox.** The Alerts sheet's "Lock screen + sound" shows only when the device noun is phone or iPad. The phone's Activity panel fills the sheet (`flex: 1 0 auto`) and the undo toast has `margin-top: auto` (still sticky), so it docks at the sheet's bottom.
- **Test keys.** The local VAPID pair and `LP_PUSH_ALLOW_LOCAL=1` live in the tracked `.env.test.push` (a `.gitignore` exception), merged under `.env.test` by `scripts/test-env.mjs loadTestEnv()`; `.env.test` is back to the base version (each worktree rewrites it for its stack, skip-worktree).
- **Tests added.** Unit: store sign-out (offline, 5xx, resumed), push client (before/after sign-out, re-arm, covers), `tests/unit/client/push-toast.test.ts`, SW (`tests/unit/sw/push.test.ts`: the page's answer, the split-view case, an older page, the test alert on Chromium and WebKit), activity client (key, badge at 0, live open list), chips and the Home Screen name. Integration: New requests OR-merge and explicit choice, nobody removes another's device, sync carries no ids and the key moves, the edit event's author. E2E: the test alert shows in front (`alerts.spec.ts`), the chips, the desk popover by keyboard (`activity.spec.ts`).

## 23. The F3 + F4 release (OVERRIDES anything above where they differ; `feat/f34`, 2026-11-07; `design/DECISIONS.md` "The F3 + F4 release")

Built on `main` 99e2db6 (F2, F5, Pending v9.1, J1). `feat/messages` (F3, efb0af0) and `feat/web-push` (F4, 97165bf) merged `--no-ff` in that order; then `main` 332c90a (Hotfix F5.1, A73) merged in, so F3's amendments moved up by one. F3's §18 A53–A60 are §21 A74–A81; F4's §18 A53–A60 (A57b) are §22 A82–A89 (A86b).

**A90 · Where the merges met.**
- `lib/server/notify.ts`, `lib/server/involved.ts`: F4's (the F3 / F5 stubs are gone). `lib/server/stage-notify.ts` (F5) now reaches F4's real `notifyStaff`.
- Migration `20261106000000_rework.sql`: steps 0–6 as on `main` (F5's step 1d, `lp_set_status`, `lp_row`, `lp_stats`), then **section 7** (F3) and **section 8** (F4), then `notify pgrst, 'reload schema'` and `commit`. `lp_involved_staff` (F3) is the only definition; it and F4's `lp_activity_fallback_staff` also count `status_changed` audit rows with `new_value ->> 'answer' = 'not_found'` (the hold's first Not found, whose status stays `Added`).
- `GET /api/sync`: `lp_sync` and `lp_activity_unread` in parallel, then F3's `decorateSync`, then F4's `activityUnread` / `activityKey` on the first page.
- `GET /api/requests/:id`: F3's thread; `PATCH`: F4's edit event.
- Pending (`components/list/PendingQueues.tsx`): `QueueHeader` takes a `marker` slot after the count; Friend coming passes F3's `UnreadDot` ("Unread messages"). `PendingTabs.tsx` stays deleted (v9.1), and `FriendComingDot` with it.
- `CheckCard`: v9.1's hold chip row, then F3's `CheckPreview`, then `m.checkActs` (Message IconButton | v9.1's left answer | In medical) when the store has the messages engine, else v9.1's `.pacts`.
- `ProfileView`: F5's `StatusBlock` gets `enrouteSlot={<StatusEnroute row={row} />}`; F3's `MessagesSection` under the action bar.
- `AccountMenu` / desk `Nav`: F4's Alerts row (sheet) replaces the switch and `NotifyItem`; main's "Show header" (`onShowHeader`) and F3's unsent-messages title and `PendingDot` stay. `TopBar`: F2's live line and F4's bell.
- `system-notify.ts`: F4's no-LP notice and F5's hold notice, both tagged `lp-<id>` (`requestTag`).
- `tests/e2e/helpers/overflow.ts`: F3's `overflowFindings(page, selector)` and F4's `overflowProblems(locator)`; `expectNoOverflow(page, selector | locator, label?)` runs the matching one.

**A91 · Contract D, integrated.** `POST /api/requests/:id/status`: target `Checked – Not Found` → F5's `notifyNotFound` only (the hold: `not_in_medical`, "Not found yet · recheck 4:40 PM"; the final answer: `not_in_medical`, `statusMeta(status).label`); any other target → F4's `statusChangeEvent` of the returned status (an Undo of a hold or of the final Not found is `back_to_waiting`). Nothing else notifies for a status change: en route cleared by F3's trigger reaches en-route staff through `lp_involved_staff`. `PUSHED_ALERT_KINDS` (`lib/client/push-client.ts`) gains `not_in_medical` (F4's integrator note): a subscribed device with "Updates on my requests" on leaves both Not found answers to the push. `lib/client/push-toast.ts` ignores `kind: 'message'` (F3's `diffMessageAlerts` owns in-front message alerts, none while the thread is on screen). `lib/activity.ts` `NOT_FOUND_YET` is `domain.NOT_FOUND_YET_LABEL`. Tests: `tests/integration/push.test.ts` (both Not found answers and the Undo: pushes `not_in_medical`, `not_in_medical`, `back_to_waiting`, one Activity row; the hold's answerer gets a later message), `tests/unit/client/push-client.test.ts`, `tests/unit/client/push-toast.test.ts`.

**A92 · Short status labels under 430 px** (the deferred F2 fix; amends A56, A58 and A63's "under 400 px"). `.stWide` / `.stNarrow` switch at `max-width: 429.98px`. `tests/e2e/list.spec.ts` checks 400, 412, 414 and 429 px ("Waiting", "Not found") and 430 px (the full labels) with an earlier day's created time: never cut, one line, the name at least 80 px, no sideways scroll.

**A93 · First load.** `/` measures 232.7 KB gzipped (route-only 41.3 KB) against A80's 234 / 42 KB (F3's raise; the F5 release kept 230 KB, A71). Brian to confirm.

**A94 · Layout where F3, F4 and Pending v9.1 share a screen.**
- `messages.module.css .checkActs` is a wrapping flex row: Message (44 px, fixed), then v9.1's two answers at `flex: 1 1 0; min-width: max-content`. They share the row equally while their one-line labels fit; otherwise In medical wraps to a full-width row (phones under about 375 px, board columns with a request docked at 1024–1279), and in the narrowest column each answer takes its own row. v9.1's `.pacts` (no messages engine) is unchanged.
- The desk's alerts banner (F4) sits in a `.alertsWrap` (`display: flow-root`) at the top of the main column; `hooks.ts useHeightVar(rootRef, '--lp-alerts-h')` mirrors its height, and `pending-board.module.css .cols` subtracts it with `--lp-sticky-h`, so the board still fits the window and the page never scrolls.
- In the phone header, F4's bell grows its 44 px tap area 8 px up and 4 px to each side, none down (`.icons [data-testid='activity-bell']::before`), like search and the avatar, so it never covers the "⇅" toggle under it.
- Activity rows are named by `activityAriaLabel` in a `VisuallyHidden` span (visible parts `aria-hidden`), not `aria-label`: a message row's visible line beside a different `aria-label` failed axe's `label-content-name-mismatch` (WCAG 2.5.3). The sentence is unchanged.

**A95 · Cross-feature review fixes** (2026-11-07; `design/DECISIONS.md` "The F3 + F4 release: cross-feature review fixes"; overrides A83, A85, A89 and A91 where they differ; client only, no migration).
- **Never both after a hidden page** (amends A83 "no double alerts"). `store-core.ts` keeps the page's last hidden spell in server time (`hiddenSpell {from, until}`, from `visibilitychange` and a page that starts hidden; server time = the last sync's `serverTime` plus the local time since). `emitAlerts` drops, besides `route === 'system'` alerts the push covers, any alert whose row's `updatedAt` (`RaisedAlert.at`) falls in that spell when `pushHooks().covers(kind)`; `emitMessageAlerts` does the same with `lastMessageAt` (`MessageAlert.at`) for `'message'`. They are marked seen and never shown. `PUSHED_ALERT_KINDS` gains `'message'` (the server pushes messages under "Updates on my requests"; the page still never shows a system notification for one). Tests: `tests/unit/client/store-push.test.ts` "a hidden, suspended page" (status and message, subscribed and not, a change after the unlock still toasts), `push-client.test.ts`.
- **Push options** (amends A83's payload). `pushPayload`: `renotify: true` for every kind; `requireInteraction: true` for `in_medical` (new optional field). `public/sw.js` `pushData` reads it and `showPush` passes `requireInteraction: data.requireInteraction && !silent`. An older payload without the flags is neither. Tests: `tests/unit/activity.test.ts`, `tests/unit/sw/push.test.ts`, `tests/integration/push.test.ts`.
- **The first message on a row without activity** (amends A77's alert rule). `diffMessageAlerts` treats a held row without the activity fields (cached by the build before messages; a create answer) as having no message: its first message from someone else alerts. Test: `tests/unit/client/store-messages.test.ts` (a cache written by the old build, a delta sync).
- **Mark all read and Undo** (amends A85). `activity-client.ts` `write()`: while either POST is on its way, and for any list or ids fetch that started before it was answered (`writeGen`), the answer is dropped (and the sync's count is not applied); once answered, the open list is fetched again (closed: the next sync fetches the ids). Tests: `tests/unit/client/activity-client.test.ts` "while the list is still loading", "a list fetched while the POST is on its way".
- **My en route row** (amends A79). The tappable row has no `aria-label`: its name is a `VisuallyHidden` copy of the visible text (label, count when more than one, the ETA), the visible pieces are `aria-hidden`, and `aria-describedby` points to a `hidden` span with `${sentence} Change or cancel yours.`. `tests/e2e/a11y.spec.ts` audits "Profile (my en route)" in both themes.
- **Activity read state of the open request** (amends A85). `markReadWhileOpen(client, id, document)` (`activity-client.ts`, used by `ActivityHost`) marks the row read only while `visibilityState === 'visible'`, and again on `visibilitychange`. Test: `activity-client.test.ts` "the request on screen".
- **Needs info over a hold** (amends A76). `carryActivity` clears `needsInfo` when the status or the hold fields (`recheckAt`, `notFoundChecks`) changed, matching `lp_messages_activity` (any `status_changed` audit row after medical's last message). Test: `tests/unit/messaging.test.ts`.
- **On top of production.** `main` 332c90a (Hotfix F5.1) is merged; its code auto-merged (`Sheet.tsx`, `ui.module.css`, `list.module.css`, the request form), its section stays A73, and the migration is unchanged by it.

## 24. F6 amendments (OVERRIDE anything above; inactivity auto-close, Brian 2026-11-06 19:55–20:07 and 2026-11-07 02:15; `feat/f6-inactive`; `design/DECISIONS.md` "F6 inactivity auto-close")

Built on `main` cf78f90 (the F3 + F4 release). Additive only: the database gains a status value, a table, functions and a pg_cron job; old clients keep working (an unknown status already renders verbatim, grey, closed, with no actions).

**A96 · The status.** `lib/domain.ts` (frozen, additive; recorded exception): `STATUS.inactive = 'Closed – Inactive'` appended to `STATUSES` (= rework step 2's `v_statuses`, unit-tested in order); `STATUS_META` `{label/shortLabel 'Closed · inactive', narrowLabel 'Inactive', tone gray, glyph 'inactive', bucket closed}`; `GlyphKind` gains `'inactive'` (`StatusGlyph`: lucide timer-off's five paths on its 24 px grid, `gray-9`, stroke 2.25, one pixel larger than the rings, no circle); `TRANSITIONS['Closed – Inactive'] = ['Found – Awaiting Reunion']` (= the SQL CASE); `primaryActions` → `[reopen]` (kind `reopen`, not undoable); `menuActions` → none. New exports: `INACTIVE_MINUTES = 60` (= `lp_inactive_minutes()`, unit-tested), `SYSTEM_STAFF = 'System'`, `AUTO_CLOSE_KIND = 'auto_close'`, `isInactiveClosed`. `lib/stages.ts`: stage key `inactive` (`STAGE_META.inactive` from `STATUS_META`; `said` "Closed, inactive"). The status order (`lib/client/status-order.ts`) needs no change: bucket closed → Archived / Closed, `byNewestClosed` on `closedAt`. `components/list/rows.tsx` narrows it under 430 px like Waiting and Not found; `list-helpers.ts stepperModel` ends "Closed · inactive". `SETTABLE_STATUSES`, `setStatusSchema` and `statusFilterSchema` are unchanged: no client may write it.

**A97 · Activity and the auto-close.** `lp_close_inactive(p_only uuid[] default null)` (rework section 9; `security definer`, `search_path = public, pg_temp`, `statement_timeout 4s`, `lock_timeout 2s`, service_role only) closes, in ONE statement (data-modifying CTEs), every request with status `Found – Awaiting Reunion` or `Bring friend to medical` whose `coalesce(max(audit_events.occurred_at), created_at)` is older than `lp_inactive_minutes()` (index `audit_patient_time_idx`), `FOR UPDATE … SKIP LOCKED` (a row someone is changing waits for the next run): `status`, `closed_at = now`, `recheck_at = null`, `updated_by 'System'` (the touch trigger bumps `row_version` / `updated_at`; F3's trigger clears en route, audited by System); one `audit_events` row `status_changed` by `System`, `previous_value` {status, found_at, reunion_started_at, closed_at, recheck_at, not_found_checks}, `new_value` {status, kind `auto_close`, idle_since, inactive_minutes, recheck_at, not_found_checks}, `notes` "No activity for 1 h"; one `lp_inactive_closes` row. Returns the count; a second call returns 0. `p_only` restricts it to those ids (tests, manual use); the job passes nothing. Every request write audits (create, `lp_set_status`, `lp_update_fields`, `lp_cancel`, `lp_add_photo`, `lp_post_message`, `lp_unsend_message`, `lp_set_enroute`); `lp_mark_read` and the `lp_activity_*` reads write none. The client's mapper reads `kind 'auto_close'` as `null` (not a `StatusKind`), so the trail shows "In medical → Closed · inactive", System, and the note.

**A98 · The job.** Section 9 enables pg_cron when it is available and not installed (`create extension if not exists pg_cron` inside an exception block, so a database where it can't run, e.g. not `cron.database_name`, still commits), then `cron.unschedule` every job named `lp-close-inactive` and `cron.schedule('lp-close-inactive', '*/5 * * * *', 'select public.lp_close_inactive()')`: exactly one job after any number of pastes. NOTICEs: how many requests are due now, `pg_cron: enabled.`, `lp-close-inactive: scheduled every 5 minutes (job N)…` or `lp-close-inactive: NOT scheduled (pg_cron is not available)…`. Pause: `select cron.unschedule('lp-close-inactive');`; a paste schedules it again. Local tooling pauses it (`scripts/test-env.mjs` `pauseInactiveJob` / `PAUSE_INACTIVE_JOB_SQL`: `tests/helpers/integration-setup.ts`, `tests/e2e/global-setup.ts`, `scripts/with-e2e-lock.mjs --migrate`, `scripts/db-reset.sh`; `scripts/verify-migration.sh` first checks the app database has exactly one job `*/5 * * * *` / `select public.lp_close_inactive()`, and that its scratch database says NOT scheduled and still commits).

**A99 · Reopen.** `lp_set_status`: `when 'Closed – Inactive' then p_status in ('Found – Awaiting Reunion')`, any staff (the creator-only rule stays Cancelled's). As for every entry into In medical: `found_at` kept, `reunion_started_at = now()`, `closed_at = null`. `'Closed – Inactive'` stays out of the target whitelist, so no client can move a request into it (422), and Reopen has no Undo (`UNDOABLE_KINDS`). The status route notifies it as F4's `in_medical`. `ProfileView` `ActionButton` `reopen`: soft grey, `RotateCcw`, `data-testid="reopen"`, in the action bar (phone foot, desk under the status block).

**A100 · Telling it once.** `lp_activity_record` accepts kind `closed_inactive`. `lp_inactive_closes (request_id, closed_at, idle_since, notified_at, quiet)`, PK (request_id, closed_at), RLS on, service_role only. `lp_close_inactive` sets `notified_at` at once, and `quiet`, for a backlog close (`idle_since` more than `lp_inactive_minutes() + 15` minutes ago), and `notified_at` for unclaimed notices older than 15 minutes. `lp_row` adds `quiet_close` (the `quiet` of the row's current close, read only while the status is Closed – Inactive; false otherwise) → `RequestSummary.quietClose?` (optional, additive; the mapper reads anything but `true` as false, so a database before F6 gives false): `diffAlerts` raises nothing for a status change into a quiet close (no toast, no system notification, nothing marked seen), and `inactiveCandidates` skips it. `lp_inactive_claim(p_ids uuid[])` (≤ 200) marks, in one statement with `SKIP LOCKED`, every untold close of those ids from the last 15 minutes whose request is still `Closed – Inactive`, and returns their ids. `GET /api/sync`: `inactiveCandidates(rows)` (Closed · inactive, `closedAt` within 15 minutes) → `after(() => notifyInactiveCloses(ids))` (`lib/server/inactive-notify.ts`): claim, then for each `deliver(involvedStaff(id), {kind 'closed_inactive', actor 'System', detail inactiveDetail()})`. Never throws; a database without the function logs `inactive_claim_failed` and syncs as before. `lib/activity.ts`: `ACTIVITY_KINDS` + `closed_inactive`, `ACTIVITY_GLYPH` {icon `timer-off`, tone gray} (`components/activity/glyphs.tsx` lucide `TimerOff`), spoken "closed", normal urgency, TTL 15 min. The page's own alert for a request of mine is `status_changed` ("LP-1004 · S.L. — closed · inactive"), already in `PUSHED_ALERT_KINDS`, so a device with push leaves it to the push.

**A101 · Dashboard and export.** `lp_stats` adds `inactive` (`Stats.inactive?`, additive); `reunited` and `avgReuniteMinutes` already read `Reunited – Closed` only. `closedTotal` adds `inactiveCount(stats)` (0 when absent). `DashboardView` `InactiveTile` (`data-testid="tile-inactive"`, status glyph, one-line label, "—" when absent) after `EnrouteTile`; both get `.tileHalf`: full width below six columns, `grid-column: span 3` each in the six-across layout (≥ 1024 px with a 900 px column). `docs/export.sql` Query 1: `when 'Closed – Inactive' then 'Closed · inactive'`.

**A102 · Medical "New requests" default (7b).** `lp_push_prefs_sync`: the default is the device's old bell OR the canonical staff's team being `medical` (`regexp_match(staff, '^(.*) · (.*)$')[2]`), on insert and, while `new_requests_set` is false, on every later sync; a value set in the sheet wins as before. Section 9 turns on existing Medical `lp_push_prefs` rows that never set it (and was off), and their `lp_push_subscriptions` rows. `lp_push_prefs.new_requests_team_default` (additive, default false) marks a switch on by the Medical default alone: set on insert (Medical, no bell, nothing set) and by section 9's update; kept while the switch is never set in the sheet, even when a device then sends `bell: true` (ActivityHost echoes the server's switch into the bell, so a later bell is not a choice); cleared once the sheet sets the switch either way; never set on a row whose old bell turned it on first. `lp_activity_record` with kind `new_request` writes no Activity row for such staff (not in `written`; their bell and badge counts are unchanged) but still pushes to their devices. The client is unchanged (ActivityHost already follows the server's switch into the in-app bell).

**A103 · Tests.** Unit `tests/unit/inactive.test.tsx` (constant, labels, glyph markup, stage, Reopen-only transitions, sort order, stepper, Activity kind, alert, dashboard total, sync candidates); `domain.test.ts` (STATUSES = `v_statuses`; the undo check covers undoable actions only); `stages.test.tsx`. Integration `tests/integration/inactive.test.ts` (eligible rows and the 60-minute line with psql-backdated audit rows and `created_at`, every write resets / reads don't, never Waiting / held / Needs info / closed, idempotent, the whole-table run in a rolled-back transaction, privileges, the migration pasted twice in a rolled-back transaction: one job and the CHECK, the Medical prefs update, Reopen and its 422s, `lp_stats` before / after, the export, the claim and the once-only notification, a quiet backlog); `push.test.ts` (Medical default on, kept when set, a new request reaches a Medical phone), `notify.test.ts` (row counts scoped to the test's staff: a shared stack's Medical identities may get new-request rows). E2E `tests/e2e/inactive.spec.ts` (Chromium and WebKit: Archived, the detail, Reopen → Friend coming; overflow and one line at 375, 390, 820, 1180, 1440 px for the row, the status block, the action bar and the dashboard tile). (Review fixes) `push.test.ts` "F6 7b": the Medical default pushes a new request with no Activity row and an unchanged unread count, the bell echo keeps it so, a sheet choice (on) or a device's old bell writes the row; `inactive.test.ts`: a backlog close syncs `quietClose: true` (`lp_inactive_closes.quiet`), a fresh close `false`, a reopened and re-closed one is told; the migration test checks `new_requests_team_default` (Medical never set → on, set → unchanged, an old bell's → not marked); unit `inactive.test.tsx`: `diffAlerts` skips a quiet close, still alerts its later Reopen and a cached row without the field, `inactiveCandidates` skips it.

## Located / Not located amendment (OVERRIDES every status and answer label above; Brian 2026-11-07, HIPAA; `design/DECISIONS.md` "Located / Not located wording")

**A104 · Located / Not located** (hotfix `hotfix/located` on `main` 59bfc67; labels only, no migration, no SQL change). No staff-visible status, stage, answer, alert, notification or Activity wording says a person is "in medical" or "not (found) in medical". `lib/domain.ts` (frozen; recorded exception, values only): `ANSWER_LABEL` {notFound `'Not located'`, inMedical `'Located'`}; `STATUS_META['Found – Awaiting Reunion']` and the legacy `'Bring friend to medical'` {label `'Located · friend coming'`, shortLabel `'Located'`}; `STATUS_META['Checked – Not Found']` {label / shortLabel `'Not located'`, no `narrowLabel`: the log shows the same words under 430 px}; `NOT_FOUND_YET_LABEL = 'Not located yet'` (so `STAGE_META.notFoundYet`, `holdDetail`, the hold's Undo bar and push read "Not located yet · recheck 4:40 PM"); `RECHECK_DUE_LABEL` unchanged. Everything else already reads these: `STAGE_META`, the action defs, Change answer, the audit trail ("Not located (rechecked)"), the Undo bars ("B.W. closed · not located"), the system notification ("S.L. · Located"), `lib/activity.ts` / `lib/server/stage-notify.ts` details, the dashboard tiles, the filter chip, the stepper. Hard-coded words changed: `lib/client/alerts.ts` in-app alert "LP-1004 · S.L. located" (was "… is in medical"), the location sheet's title "B.W. located", `components/list/cards.tsx` screen-reader sentences (from the labels), `docs/export.sql` Query 1's Status. Identifiers (`inMedical`, `notInMedical`, `in_medical`, `not_in_medical`, test ids) are unchanged. **Width:** "⧗ Not located yet" is wider than an equal share of a phone card's answer row beside Message and "✓ Located" (F3's `.checkActs`), so the card's left answer label (`list.module.css .ansLabel`, `data-size-as="Not located yet"`) reserves the longer label's width with an invisible `::after` of no height: the button keeps one width and place in both states (Pending v9.1), and "✓ Located" takes the rest; the status block's and the action bar's answers are equal grid columns already. **Old Activity rows:** `lp_activity.detail` is written once; `lib/activity.ts currentDetail(kind, detail)` (in `mapActivityRow`, so GET /api/activity) reads an `in_medical` / `not_in_medical` row whose detail is exactly, or starts with "<word> · ", "In medical", "Not found yet", "Not found in medical" or "Not in medical" with today's label; nothing else is touched. Pushes already delivered keep their words. Kept: the Medical team, the app title "Is my friend in medical?" / "In medical?", locations and messages (free text), the quick lines. Tests: unit `tests/unit/located-wording.test.ts` (every label from STATUS_META, STAGE_META, the actions, Change answer, the stepper, every stage, the alerts, system notifications, Undo bars, Activity / push details and the audit trail is free of "medical"; old Activity rows); e2e `tests/e2e/located.spec.ts` (Pending, the request page and the desk table say Located / Not located and never "medical", Chromium and WebKit). `LP_E2E_LOCK_DIR` (default `/tmp/lp-e2e.lock`) moves the e2e lock for a run on its own isolated stack (`tests/e2e/global-setup.ts lockDirFrom`, `scripts/with-e2e-lock.mjs`).

**A105 · Pending, no "Can't find them", quick lines fill the box** (`hotfix/located-pending` on A104; client only, no migration; `design/DECISIONS.md` "Pending, no 'Can't find them', quick lines fill the box"). `NOT_FOUND_YET_LABEL = 'Pending'` (so `STAGE_META.notFoundYet`, `notFoundAnswer`, `holdDetail` / `notFoundDetail` "Pending · recheck 4:40 PM", the hold's Undo bar, the alerts, the audit trail and the desk cell follow); `lib/activity.ts currentDetail` also maps "Not located yet[ · …]" to it; the card's left answer reserves the longer of "Pending" / "Not located" (`cards.tsx ANSWER_SIZE_AS`). `lib/messaging.ts quickLines`: front of house In medical = [En route | Arrived]? + "Friend left the area". `fillWithQuickLine(typed, line)` + `MessagesSection` Composer: a message pill sets or appends (one space) and focuses the field with the caret at the end (`flushSync`, then `setSelectionRange`); its accessible name is "Add to message: <line>". Tests: unit `messaging.test.ts`, `located-wording.test.ts` (the hold is "Pending"); e2e `messages.spec.ts` (fill, append, edit then Send, nothing posted before Send).

## Request page order amendment (OVERRIDES anything above on the request page, A79's "MessagesSection after the status block" included; Brian 2026-11-07, `design/DECISIONS.md` "Request page order, Brian 2026-11-07")

Labelled R1–R3 rather than numbered, so it can't collide with F6's §24 (A96–A103), built at the same time. Built on `main` cf78f90. Client and push payload only: no migration, no new environment variable, `public/sw.js` unchanged (it already passes a same-origin path and query through).

**R1 · Order and the latest-message line** (`components/profile/ProfileView.tsx`, `components/messages/CardActivity.tsx` `ThreadPreview`, `lib/messaging.ts` `threadPreviewShown`).
- `Profile` renders: hero → `StatusBlock` (unchanged) → the desk pane's action row (`presentation="panel"`) → the line → `Details` → Photos → `MessagesSection` → Audit trail → Cancel request. Same order in both presentations.
- The line shows when `threadPreviewShown(needsInfo, seenUnread, row.lastMessage)`: `needsInfo` is `displayStage(row).key === 'needsInfo'`; `seenUnread` is latched in `Profile` state (true once `unreadOf(row) > 0` was seen while the request was open, on arrival included), because `MessagesSection` marks the thread read as soon as it loads; the count only counts once this visit heard from the server: the store synced since the page loaded (`lastSyncLocalAt !== null`), the detail came back, or the thread did (`useThreadLoaded`, `loadedAt > 0`; `loadLatest` writes the row's activity before the thread, so that render has the server's count from before the read). Rows from the IndexedDB cache alone can be behind (read on another device, or just before a reload, inside the 3 s row write) and never set it; it stops counting once `lastMessage.mine` (my reply is the latest). The dot shows while `seenUnread` and the latest message is not mine.
- `ThreadPreview`: a `<button data-testid="thread-preview">` (min-height 44 px; `.threadPreview`, `.tpChip`, `.tpBox` in `messages.module.css`) holding the `StageChip` (Needs info only), the cards' `.preview` box (dot, "who: text" one line with an ellipsis, lucide `ChevronDown`), visible parts `aria-hidden`, named by a `VisuallyHidden` sentence: "[Needs info. ]Last message[, unread], from <who | you>: <text>[.] Go to messages." (the visible words in order, WCAG 2.5.3). A tap calls `requestThreadJump(row.id)`.

**R2 · Jump to the thread** (`lib/thread-link.ts`, `lib/client/thread-jump.ts`; replaces `messages-hooks.ts` `requestThreadFocus` / `takeThreadFocus`).
- **Address.** `threadPath(id)` = `/?r=<id>&to=thread`; `wantsThread(params)`. `lib/client/nav.ts` is untouched: `parseView` ignores `to`, so an older build opens the request at its top.
- **One waiting jump** `{id, until: now + 60 s}` (20 s until 2026-11-07: too short for a cold start on a festival network): `requestThreadJump(id)` (tells subscribers; sets `nav.ts` `setSignInNext(withThread)`), `threadJumpWaiting(id)`, `takeThreadJump(id)` (once), `withThread(location)` (`to=thread` added while that request's jump waits or landed in the last 60 s: a 401's `?next=`), `dropOtherThreadJump(id)`, `subscribeThreadJump(fn)`, `openThread(id)` (= jump + `navigate({r: id})`), `takeThreadParam(id)` (the page opened at `/?r=<id>&to=thread`, not with `edit`: jump, then `navigate({r: id}, {replace: true})` so `to` leaves the address). No React. Off the first load: the views import it, and the store loads it with `import()` for a message toast's View (imported statically it cost 853 B and put the route-only first load at 42.35 KB, over A80's 42). First load measured on the same machine: 232.98 KB, route-only 41.54 KB (`main` cf78f90: 232.96 / 41.52).
- **Entry points.** `MessageButton` / `MessageIconButton` → `openThread`. Phone log rows (`LogRow`, `SearchLogRow`) and desk table rows (`TableRow`, `SearchRow`) → `openRowAt(id, event.target)`: `openThread` when the click landed in the message lane (`MessageMark`, `data-thread-badge`; its `::before` covers the row's left 52 px on the phone, the left edge + lane + half the gap on the desk, the row's full height), else `navigate({r})`. With a request docked the desk's `ShortcutManager` takes the click first and opens the row in place; a click in the lane (`keyboard.inMessageLane`) calls `requestThreadJump(id)` before it, so it still lands at the thread. `ActivityPanel`: a row with `kind === 'message'` → `openThread`, else `navigate`. The store's alert toast: View on a `message` alert → `openThread` (through `import('./thread-jump')`; `navigate({r})` if that chunk can't load). `pushPayload`: `url = threadPath(id)` for `kind 'message'`, `/?r=<id>` otherwise. `systemNotice`: `url = threadPath(id)` for a `message` alert. `openFromNotification` (the page side of `public/sw.js` `lp-open`): `requestThreadJump(r)` when the URL `wantsThread` and has no `edit`, before it navigates (or finds the request already showing). `ProfileView` calls `takeThreadParam(id)` on mount (a new window, `client.navigate`, a reload).
- **Arrival** (`MessagesSection`). On mount it drops a jump waiting for another request, then on mount and on every jump request: when one waits for its request, one `requestAnimationFrame` later (after the page's and the pane's own scroll-to-top effects) it takes it, scrolls the request's own scroller (the nearest `overflow-y: auto | scroll` ancestor, else the window; not `scrollIntoView`, which also scrolled the desk page under the list) so the section's top sits under its `scroll-margin-top` (`56px + safe-area` under the phone's sticky bar, 4 px in the pane), `behavior: 'smooth'` unless `(prefers-reduced-motion: reduce)`, scrolls the thread to its newest, and focuses the composer (`preventScroll`) only when `${DESK_QUERY} and (hover: hover) and (pointer: fine)` matches; otherwise the section's `h2` (`tabIndex -1`, no outline) takes the focus. Read state is unchanged (marked read once the thread loads and the app is on screen).

**R3 · Tests.** Unit `tests/unit/request-page-order.test.tsx` (the order in both presentations, the line right under the status block / the pane's action row, its chip, dot and sentence, shown for Needs info and unread and not otherwise, not for an unread count from the cache before any sync, `threadPreviewShown`, `threadPath` / `wantsThread`, the push and page-notification URLs, the jump's lifetime, `openThread`, `openRowAt`, `openFromNotification` with and without `to`, `takeThreadParam`); `tests/unit/sw/notification-click.test.ts` (the thread address reaches the page as it is). E2E `tests/e2e/detail-order.spec.ts`, Chromium and WebKit, iPhone 14 and 1440 × 900: the order; the line for Needs info until front of house answers, for an unread message (kept for the visit after the thread read it), and not when read or with no messages; a reload whose row cache still counts a message read meanwhile on another device never shows it (watched for the whole load), while an unread one in the cache still does; the line, My requests' Message button, an Activity message row and a message notification (the worker's `lp-open` in place, and a new page at `/?r=<id>&to=thread`, `to` then gone) land at the thread with the composer not focused and the heading focused on the phone; a Pending card's Message, the line and a row's unread badge land there with the composer focused on the desk, the page itself not scrolled; a Pending card, an All row, an Activity answer row, a desk row away from its badge and an old `/?r=<id>` open at the top; axe and the 44 px line in light and dark; no overflow at 375, 390, 820, 1180 and 1440 px in light and dark. `tests/e2e/detail-order-screens.spec.ts` writes `design/screens/detail-order-*.png` (only with `LP_DETAIL_ORDER_SCREENS=1`).

## F6 follow-ups amendment (`fix/f6-followups`; on §24)

**A106 · F6 follow-ups** (`fix/f6-followups`, client only; `design/DECISIONS.md` "F6 follow-ups"; numbered after A105 so it never collides with the Located / Pending hotfixes).
(a) *The old bell.* `lib/client/prefs.ts` (additive exports): `BELL_FROM_SERVER_KEY` (`lp-bell-server`), `readOldBell()` (`lp-bell` on and no mark), `markBellFromServer()`, `forgetBell()` (bell, intro, mark), `forgetBellForOtherStaff(name, team)` (forgets unless the remembered identity is the same canonical staff). `push-client.ts` sends `bell: readOldBell()` to `/api/push/prefs` and `/api/push/subscribe`, and marks after any answer from prefs (and from subscribe with push enabled), before its epoch check. `store-core` `clearLocalData` (a confirmed sign-out, here or in another tab) calls `forgetBell()` and sets `prefs.bell` / `bellIntroSeen` false; `PasswordStep` and `SignInFlow` `openApp` call `forgetBellForOtherStaff` before `writeRememberedIdentity`. No SQL change: `lp_push_prefs_sync` already keeps a team-default row's mark when its own staff member's copy comes back.
(b) *A deliberate second Not found.* `setStatus` passes `tapHeld = 'shown'` when the confirmed row is not held but the row's `status` overlay shows a hold that started at least `DOUBLE_TAP_MS` (500) ago; `runStatus` sends it (as the final answer, queued by `serialize`) only if the confirmed row is held by then, else answers `{ok: true, changed: false}`. Faster taps keep F5's `tapHeld === false` rule.
(c) *Offline on WebKit (e2e only, no app change).* Nothing was uncaught: `apiRequest` never throws. WebKit logs one of the app's own requests that a navigation or reload cuts off before it reaches the network as the script error "Fetch API cannot load …/api/… due to access control checks.", and Playwright reports every such log as a page error: in `offline.spec.ts` the session check the `online` event starts, cut off by the test's next `page.goto` about 25 ms later (`/api/sync` and `/api/push/prefs` in other runs, `/api/push/prefs` on a reload in "activating an update"). Aborting the store's requests on `pagehide` was tried and did not help (WebKit cuts them off first), so the spec's page-error check skips exactly that WebKit line for a same-origin `/api/` URL; anything else still fails it.
(d) *Tests.* Unit: `prefs.test.ts`, `push-client.test.ts` (an own old bell goes once; a copy never; an answer that never came keeps it), `store-session.test.ts` (sign-out forgets it, a failed one keeps it), `store-hold.test.ts` (a bounce is dropped, a tap after 0.6 s is final, nothing when the hold failed). Integration `push.test.ts` "a shared phone" (the real push client and routes: Medical A → sign-out → Medical B team default push-only, never-set C off; the same with no sign-out; a live-build bell forgotten at someone else's sign-in; a phone's own old bell still counts). E2E: `list.spec.ts` and `profile.spec.ts` wait for the first Not found's POST before the second tap (`helpers/sync.ts` `answerSaved`); `offline.spec.ts` (c).

## Located alert and quick lines amendment (Brian 2026-11-07 14:18, HIPAA; `design/DECISIONS.md` "Located alert and medical quick lines")

**A107 · No "Main Med", no care wording.** `lib/client/alerts.ts` `LOCATED_SUBTITLE = 'Friend can head over'`: `statusAlert`'s `in_medical` subtitle and `system-notify.ts systemNotice`'s `in_medical` body line (overrides "Bring the friend to Main Med" in §6, A52 and A86b). `lib/messaging.ts MEDICAL_LINES.in_medical` = "Bring 1 person only", "Not ready yet — wait", "Ready for them". Client only. Tests: unit `located-wording.test.ts` (the subtitle; no alert or notification in any status says "Med" or "medical"), `messaging.test.ts`, `system-notify.test.ts`, `store-notify.test.ts`, `store-session.test.ts`, `pure.test.ts`; e2e `list.spec.ts` (the toast).

**A108 · Test tooling (speed).** The e2e lock is per stack: `scripts/test-env.mjs e2eLockDir` (used by `tests/e2e/global-setup.ts lockDirFrom` and `scripts/with-e2e-lock.mjs`) is `LP_E2E_LOCK_DIR` when set, else `/tmp/lp-e2e.lock-<port of .env.test's NEXT_PUBLIC_SUPABASE_URL>`, and `/tmp/lp-e2e.lock` for the shared stack (`SHARED_STACK_API_PORT` 54421 = `supabase/config.toml`, so older checkouts still share it) or a URL without a port. Both wait `E2E_LOCK_WAIT_MS` (2 minutes, was 20 / 30), then fail naming the holder (`e2eLockHolder`: "pid N, cwd /path", the cwd its owner writes into the lock, else `lsof`). The Chromium project launches with `--mute-audio`. Test: `tests/unit/e2e-lock.test.ts`.

## Request page tonight amendment (OVERRIDES anything above on the request page's latest-message line, its thread and quick lines, and the My requests card's En route / Arrived; Brian 2026-11-08, `design/DECISIONS.md` "Request page tonight, and no Arrived")

**A109 · Request page tonight, and no Arrived** (`feat/request-page-tonight`; client only, no migration, no SQL or API change; `design/references/request-page-ux-rec.md` "Tonight").
- **T1** `ProfileView` renders `ThreadPreview needsInfo={null}`; `threadPreviewShown(needsInfo !== null, …)` is unchanged, so the line still shows for Needs info. `ThreadPreview` keeps the prop (a chip first when one is passed).
- **T2** `ThreadPreview`: `.tpBox .previewText` is `flex: 1 1 auto; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal` (3 under 360 px); `<span class="tpTime" data-testid="preview-time">` = `formatCreatedTime(row.lastMessageAt, useNow(), useEventTimezone())` before the ⌄ when `lastMessageAt` parses (12 px, gray-11, tabular). The sentence: "Last message[, unread], from <who> at <time>: <text> Go to messages." (no " at …" without a readable time).
- **T3** `.pills`: `flex-wrap: wrap`, no `overflow-x`, no hidden scrollbar; `.panel .pills` removed (the pane already wrapped).
- **T4** ~~`.scroller` has no `overscroll-behavior`; `.panel .scroller { overscroll-behavior: contain }`~~ superseded by "Phone thread in the page" below.
- **Phone thread in the page** (DECISIONS row 7). `messages.module.css .thread` (was `.scroller`): `position: relative; display: flex; flex-direction: column`, no max-height or overflow; `.panel .thread { max-height: min(60dvh, 520px); overflow-y: auto; overscroll-behavior: contain }` (the desk pane, unchanged). `MessagesSection` (`panel` false = the phone's page): `pageView(el)` = from the section's `scroll-margin-top` (under the top bar) to `min(innerHeight − [data-testid=profile-actions] height, the visual viewport's bottom while a keyboard is up (visual-viewport.ts keyboardBox))` − `KEEP_GAP_PX` 8. `measureAtBottom()`: the pane, `scrollHeight − scrollTop − clientHeight < 32`; the phone, the thread's bottom within `[pageView.top, pageView.bottom + 32]`, read on the window's `scroll` / `resize` and the visual viewport's `resize` / `scroll` (the keyboard resizes and pans it). `scrollToEnd(smooth)`: the pane scrolls its box to the end; the phone scrolls the window down (never up) by `composer field bottom − pageView.bottom`, and the window's scroll events don't count for `OWN_SCROLL_MS` 900 (one check after). First show: the pane opens at the newest; the phone's page stays where it is (atBottom measured), unless a jump is settling. A new message at the end: mine or at the bottom → `scrollToEnd(true)`; else `newPill` = its sticky `bottom` (`pillLift()`: the pane 8 px; the phone `innerHeight − pageView.bottom`, 8 px above the bar or the keyboard, worked out again on each of those events while the pill shows), nothing scrolls. A jump: `scrollToSection(section, motion, field)` as before; the pane also scrolls its box to the end. **Earlier messages**: the tap saves the first bubble's key (`data-bubble` on its row) and its viewport top; while it loads that top follows the reader (refreshed on every scroll event above, the pane's box scroll, and any other render: a send, a new message). Once the first bubble is another one (the older page went in above), a layout effect scrolls the window (the pane: its box) by how far the saved bubble moved, then forgets it; a load that ends with the same first bubble (it failed) only forgets it.
- **Pending clarity** (DECISIONS row 8). `lib/stages.ts`: `NOT_LOCATED_YET = 'not located yet'`; a hold's `fullLabel` = `"<label> · not located yet"` (`label`, `said`, `stageLook`, `stagePhrase` unchanged: "Pending" / "Recheck due"); `recheckCountdown(recheckAt, now, tz)` → `{ due, lead: 'Medical rechecks' | 'Medical recheck was due', time: '1:12 AM', when: 'in 14 min' (whole minutes rounded up, at least 1) | '3 min ago' (rounded down; 'now' under a minute; '1 h 5 min ago'), said: 'Medical rechecks at 1:12 AM, in 14 minutes.' | 'Medical recheck was due at 1:12 AM, 3 minutes ago.' ('just now'), progress: 1 − left / RECHECK_MINUTES (0–1; 1 once due) }`, null for an unreadable time. `ProfileView StatusBlock` on a hold: the label (`aria-hidden`) + `VisuallyHidden` "Pending, not located yet."; `data-testid="status-sub"` "First check · <shortStaffName> · <formatListTime>" (`aria-hidden`) + "First check by Rae C. at <formatCreatedTime>."; the recheck row (every hold, Needs info included) = history glyph, `recheck-text` "<lead> **<time>**" (15 px, the time 17 px semibold), `recheck-when` at the right (14 px gray-11; due: violet-12 semibold), the sentence, and while not due `recheck-bar` (4 px, violet-a4 track, violet-9 fill by `scaleX(progress)`, `data-progress`). It updates with `useNow()` (15 s).
- **T5** `lib/client/messages-logic.ts`: `RUN_BREAK_MS = 5 * 60_000`; in `buildBubbles` a run is one sender's bubbles in a row with no gap over `RUN_BREAK_MS` from the one before (`runStart` / `runEnd`); an unreadable time or a negative gap (a queued bubble timed by the phone) never breaks. Display only. `MessagesSection`: `timeOf(iso, now, tz)` (`formatCreatedTime`, '' when unreadable), `RunLabel` (someone else's run: "<by> · <team> · <time>"; mine: `.from.fromMe`, the time alone, right-aligned, 12 px in from the edge; `data-testid="run-label"`, `aria-hidden`), `bubbleSaid(bubble, time)` for the bubble's `aria-label` ("Rae C., Medical, 12:14 PM: <body>." plus " Sending." / " Not delivered."). Reverses A79's "no timestamps".
- **No Arrived.** `QuickLineKind` = `message | enroute`; `quickLines(stage, side, enrouteMine, arrived)`: front of house In medical = "En route" unless I am en route or the friend arrived, then "Friend left the area". `Composer` has no `onArrived`; `EnrouteControl.arrive` is gone. `MineActivity` (front of house, In medical): `[Message | action]`, the Friend coming card's order (`MessageButton` first, the action second). The action is En route while I am not en route; once I am, or on a row whose friend arrived, `data-testid="reunited-button"` ("Reunited", named "Reunited: <name>", solid high contrast) → `components/list/hooks useStatusTap().tap(id, 'Reunited – Closed', 'reunite')`, the Friend coming card's tap (the store's 10 s Undo; offline: `aria-disabled` and "Needs a connection"). Kept: `EnrouteAction 'arrive'`, `messages-core setEnroute`, `POST /api/requests/:id/enroute {action: 'arrive'}`, `lp_set_enroute('arrive')` (an older build may still send it), `EnrouteFailed`'s words for a queued older tap, and every "Friend arrived" display (`lib/stages.ts`, lists, Pending order, the request, Activity, push, export, the dashboard's Time to arrive). Not changed: an en route row with no arrival stays `enroute` until Reunited or Cancel en route, so past its ETA it reads "late" (`etaPhrase`, `LATE_AFTER_MS`) and `lp_enroute_stats` keeps counting it in Friends en route (DECISIONS row 6, accepted).
- **Phone jump keeps the field above the bar.** `MessagesSection scrollToSection(el, behavior, keep)`: on the page (not the desk pane) with `keep` = the composer's field, the page scrolls by `max(section top − scroll-margin, field bottom − (innerHeight − [data-testid=profile-actions] height − KEEP_GAP_PX 8))`, so with a full thread (T3's wrapped quick lines, T5's run labels) the field ends above the sticky action bar and the heading may go under the top bar. A phone jump that lands while the thread is still loading lands again when its bubbles first show, however late, unless the reader's own input comes first (`touchstart`, `pointerdown`, `wheel` or `keydown` on window, `READER_INPUT`; until the 2026-11-08 review it was within 3 s, which a slow festival network outlasts). The desk pane is unchanged.
- **First load** (route-only and total of `/`, gzipped, from the build manifests): 42,996 B / 239,032 B, against 43,004 B / 239,040 B on `main` b657a49 (budget 43,008 / 239,616); with the phone thread in the page and Pending clarity 42,998 B / 239,034 B. The request page and the thread are lazy chunks.
- **Tests.** Unit `messaging.test.ts` (quick lines: no Arrived kind or words anywhere; the 5-minute rule: 4 min and exactly 5 min stay one run, 5 min 1 s breaks, my runs too, a queued bubble timed earlier, an unreadable time), `request-page-order.test.tsx` (no chip, the time before the ⌄, the sentence with " at <time>", none without a readable time), `request-page-tonight.test.tsx` (`RunLabel`, `bubbleSaid`, `timeOf`; the My requests card: En route, then Reunited once I am en route, En route while someone else is, Reunited on an arrived row, nothing for medical; the request's quick lines while en route and after arrival). E2E `detail-order.spec.ts` (no chip on the line, the status block says Needs info, the time and its sentence, at most two lines and two on a phone, the time right of centre before the ⌄; `overscroll-behavior-y` auto on the phone, contain in the desk pane), `messages.spec.ts` (run labels and spoken times; the card goes En route → Reunited with Undo, no Arrived on the card or the request, which offers "Friend left the area" only; an older build's arrived row shows "Friend arrived" with Reunited on its card). Phone thread in the page: e2e `detail-order.spec.ts` (the thread has no box of its own; a swipe that starts on a bubble scrolls the page down and up, a real touch in Chromium, the wheel on a phone-width WebKit page since mobile WebKit takes neither in Playwright; a jump to a long thread puts the field above the bar and scrolls the page; a new message at the end follows, higher up shows the pill above the bar and the page does not move, the pill goes to the newest; "Earlier messages" keeps the message on screen within 2 px (served pages), also after the reader scrolls during a slow load, and a failed load (503) moves nothing; a jump whose thread's GET takes 5 s still lands with the newest bubble and the field above the bar; the desk pane's thread opens at the newest and the wheel scrolls it, not the pane or the page). Pending clarity: unit `pending-clarity.test.tsx` (`recheckCountdown` rounding, singular, hours, progress, due, null; `fullLabel` vs the short label; the block's words, sentences and bar, held and due; lists keep "Pending"), `stages.test.tsx`; e2e `stages.spec.ts` (the block, then the clock moved with `page.clock.setFixedTime`: "in 14 min" → "in 5 min" with the bar further, then due "3 min ago" with no bar; the card keeps "Recheck due"), `pending-v9.spec.ts`. **By hand before the deploy:** on one real iPhone (Home Screen app) a swipe on the thread moves the page, and the field stays above the keyboard while typing.

## Telemetry amendment (`feat/observability`, Brian 2026-11-08 ~00:50; `design/DECISIONS.md` "In-house telemetry and the Health page"; the full design: `design/references/observability-design.md`)

**A110 · What is recorded.** 37 event names (`lib/telemetry.ts EVENT_NAMES`): lifecycle and navigation (`app_start view sheet vis sw device_state`), interaction counts (`tap swipe key field img_fail`), frustration signals with a 30-crumb trail (`stuck_scroll rage_tap dead_tap loop slow pinch error stuck_send`), timed flows (`flow_open flow_resume flow_new flow_submit flow_answer flow_msg flow_read flow_push flow_alert`), network and state (`net sync link outbox vitals push_rx notif_click`) and two server rows (`push_send tel_switch`). An event is numbers, booleans, enum values and tokens (`^[a-z0-9/][a-z0-9_.:#/-]{0,63}$`; crumbs add `> + ! ^`). Controls are named by `data-testid`, a CSS-module class (Turbopack production `<hash>_<local>` → `local`) or a role / tag; never text, values, labels, titles, `alt`, `src`, `href`, row fields or message bodies. Errors: type and an FNV hash of the type and top `/_next/static` frame (8 letters, hex as a–p), never the message. No stored string may hold 4 digits in a row (`DIGIT_RUN_RE`: the route's zod and the `lp_tel_events_no_digit_run` CHECK, behind the client's `tok()`; the longest legitimate run is a 3-digit `st`). Team from the session only (`teamKey`: medical, dispatch, base, transpo, other).

**A111 · The collector** (`lib/client/telemetry/*`, its own chunk). Loaded after idle by `components/activity/use-telemetry.ts` from `ActivityHost` (the F4 chunk) when `lib/client/telemetry-gate.ts` allows it: before `lp-tel-until` (else 2026-11-10 11:00 UTC), not after the server's off (`lp-tel-off`, a probe 30 min later), never under `navigator.webdriver` without `lp-tel-test = 1`. Observes the store's public contract, passive DOM listeners (handlers record properties only; naming and detection run in idle time), PerformanceObserver, a pass-through `window.fetch` observer (the same promise object; `FETCH_OBSERVER`), and the service worker's log. Every handler wrapped; the 20th internal fault stops it. No first-load module changed: `/` route-only 43,002 B and total 239,038 B gzipped.

**A112 · Sending.** Memory ring of 500 events plus aggregates; a 500-event IndexedDB ring of batches in its own database `lp-tel` (raw IndexedDB). A send only when visible, online, `connection` live, signed in, not syncing, no outbox or message job sending, no other `/api/*` request in flight, no tap in 1.5 s; at most every 60 s (300 s when only counts wait); ≤ 300 events / 48 KB; gzip (`application/x-lp-tel+gzip`) via CompressionStream; `priority: 'low'`; 8 s timeout. 200: settings (`until`, `flushSeconds`, `sample`, `now`), `capped` pauses to the next hour. 204: off (detach, restore fetch, clear, `lp-tel-off` + 30 min). 401/403: pause until the session is active. 413/422: drop. 5xx / network / timeout: kept, retried after 5 min, dropped after 3 tries. A send in flight is aborted the moment the app starts a request (fetch observer start, `syncing`, an outbox or message job `sending`): its batch is kept, no try counted, no backoff. A resume sends nothing itself (the post-sync hook does). A hidden page (bubble-phase `visibilitychange` / `pagehide`, after the store's own save): one batch to `sendBeacon` only when online, nothing of the app is in flight and the beacon can be accepted (`CompressionStream` on iOS stands for Safari 16.4+, which sends Sec-Fetch-Site), then not kept; otherwise it waits in IndexedDB. An api `slow` goes out once per pattern and method per minute, `k` counting the slow ones it stands for.

**A113 · Ingest** (`POST /api/telemetry`, `refresh: false`). Session, origin (`assertTelemetryOrigin`: a present Origin must match; a missing or `null` one, which is what WebKit's sendBeacon sends under `Referrer-Policy: no-referrer`, only with `Sec-Fetch-Site: same-origin`), the cached config (30 s; off only for a missing function or table, `PGRST202` / `42883` / `42P01`; any other failure is 503 for 5 s, so phones keep their batches), the body (≤ 48 KB wire, ≤ 256 KB inflated, JSON / text / gzip), zod (envelope 422; a bad event is dropped and counted in `rejected`; `tr` only on frustration; server-only names refused), then one RPC `lp_tel_ingest` (dedupe by batch id; per-hour caps of 3,000 events / 2 MB per body device id and per sign-in (`quotaKey`, a hash of the session's sid), and 60,000 / 48 MB for the fleet (`*`); bytes are the inflated JSON; the skew-corrected time clamped to [now − 2 days, now]). `POST /api/telemetry/settings {enabled}` only turns collection off (any session; `tel_switch` is recorded just before the flip); `{enabled: true}` writes nothing (back on is SQL only): it re-reads the settings, 403 while they are off. `GET /api/telemetry/health?window=1h|3h|12h|all` runs the eight `lp_tel_health` sections two at a time, shares one computation per window among concurrent requests and keeps `all` for 30 s (a failed section is null; the config is read fresh). `lib/server/notify.ts deliver()` writes `push_send` per team after `lp_push_result`; `pushPayload` adds `sentAt`.

**A114 · SQL** (`20261106000000_rework.sql` section 10; production paste `scripts/telemetry-sql.mjs`). `lp_tel_settings` (one row: `enabled`, `off_at` 2026-11-10 06:00 ET, device and fleet caps, `flush_seconds`, `sample`), `lp_tel_events` (CHECKs on every column; props and trail ≤ 4 KB; `lp_tel_events_no_digit_run` NOT VALID: no 4-digit run in area, ctl or any string in props or trail), `lp_tel_devices`, `lp_tel_quota`, `lp_tel_batches`; RLS on, no policies, service_role grants only. Functions `lp_tel_config`, `lp_tel_ingest`, `lp_tel_server_events`, `lp_tel_set`, `lp_tel_retention` (security definer) and `lp_tel_health`, service_role only. pg_cron `lp-tel-retention` daily at 09:17 UTC: events and devices after 30 days, quota and batch ids after 2 days.

**A115 · Service worker.** After a push is shown (or taken by a window in front) and at the very end of a click, `public/sw.js` appends one entry to META `/__lp/tel` (≤ 100, ≤ 24 h; kind, times, sentAt, front / shown / silent, or ps / age / via `lp-open | take-open | nav`); `{type: 'lp-tel-take'}` hands it over and clears it. The log has its own queue (`telStep`), never the pending-open one, and the page asks for it after the first sync that follows a resume (or the next 30 s check); a click entry that arrives after its request opened still counts as `flow_push` ok. A failed write is swallowed.

**A116 · `/health`** (its own route, desktop only; any signed-in session; without one → `/signin?next=/health`, in the proxy like `/`, and again in the page). KPIs (devices, frustrations, devices hit, errors, syncs ok, pushes opened, open → fresh p95, with ↑ ↓ against the previous window), Problem spots (by devices then count, ⋯ opens a trail drawer), Critical paths (p50 / p95 against targets with ✓ ↑ ↑↑), Requests (failure rate by network state, the sync line), Push, Alert coverage by team, Errors. Loads on mount and Refresh only. The switch turns collection off behind "Turn off collection?"; once off it is disabled (back on is SQL only). The page's client entry loads the dashboard with `import()`, and the dashboard uses plain elements on Radix's CSS variables and inline glyphs (no Radix Themes or lucide JS), so `/`'s first load is not regrouped. The desk sidebar and rail show Health only on a device that opened `/health` (`localStorage lp-health`).

**A117 · Tests.** Unit `tests/unit/telemetry/{sanitize,detect,flows,net,buffer,send,guard,privacy,schema,collector}.test.ts`, `tests/unit/server/telemetry.test.ts`, `tests/unit/health/health-view.test.tsx`, `tests/unit/sw/telemetry-sw.test.ts`, `tests/unit/activity.test.ts` (sentAt). Integration `tests/integration/telemetry.test.ts` (auth, origin, sizes, gzip bomb, validation, team from the session, skew, dedupe, caps, 204 when off or past `off_at` with nothing written, no Set-Cookie, the switch route, the Health aggregates, RLS / privileges / one job / retention, the standalone paste), `tests/integration/telemetry-notify.test.ts` (push_send per team; nothing when off). E2E `tests/e2e/telemetry.spec.ts` (a session with planted PII lands with rage_tap and stuck_scroll and no PII; no telemetry fetch overlaps an app request; offline then online; the kill switch's 204 stops every later send; the app works with the route failing; no collector code in the first load) and `tests/e2e/health.spec.ts`.

**A118 · On `main`'s message lane and phone thread in the page** (the merge of `main` e61de36: PR #22, PR #23). Swipe counts and stuck scroll group by `scrollArea(target)` (`lib/client/telemetry/sanitize.ts`): `area()`, except that `thread`, `messages` and `composer` outside the desk pane are the request page's (`profile`), since the phone's thread has no box of its own; in the desk pane (`[data-presentation=panel]` or `desk-pane`) the thread keeps `thread`. Stillness and `edge` already followed the page (document scroll events; the nearest box with `overflow-y` auto / scroll, else the page). The swipe crumb keeps where the finger was (`w!:thread:u`). A tap in a row's message lane (`[data-thread-badge]`, `MessageMark`) is the control `message-mark` (it opens the thread, `openRowAt`); an empty lane is the row. The recheck countdown (`recheck-row`, `recheck-when`, `recheck-bar`, every 15 s) joins `TICKING`, so it is never a tap's response. No other name the collector relies on changed (`AREAS`, `request-form-submit`, `lp-rf-*`, `add-photo`, `card-photo`, `data-sheet-grab`, `lp-toaster`; Arrived was never one); no event name, prop key or SQL change (the production paste, `node scripts/telemetry-sql.mjs`, is section 10 alone, as before). First load of `/` after the merge (route-only / total, gzipped, from the build manifests): 43,007 B / 239,043 B, against 43,004 / 239,040 on `main` e61de36 (budget 43,008 / 239,616); none of this touches a first-load module. Tests: unit `sanitize.test.ts` (the lane, `scrollArea` on the phone and in the pane), `detect.test.ts` (the phone's thread is `profile` with `thread` crumbs, the pane's stays `thread`, a page scroll is not still, the countdown is not a response); e2e `telemetry.spec.ts` (stuck scroll `profile` with `w!:thread:u` in its trail; Chromium: a real touch from the thread scrolls the page and counts as a `profile` swipe that is not still).

**A119 · First-load budget: route-only 42 → 43 KB** (Brian, 2026-11-08 morning: "sure we can raise it"). `tests/e2e/first-load.spec.ts` now allows 234 KB total (unchanged) and **43 KB route-only**. After the night's releases `/` measured 43,007 B route-only against 43,008 B, so every first-load change needed a byte hunt; the network fixes' "Updating…" line needs about 50–100 B. The cost is about 1 KB on a first open or after an update, when the scripts are not already in the service worker's cache.

