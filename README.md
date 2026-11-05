# EDC Orlando 2026 — Lost Person Coordination

A mobile-first Next.js MVP for a small event operations team (about 10 staff) to coordinate lost-person inquiries and reunifications. The app stores identification and contact information only. Do not enter medical records, diagnoses, medications, treatment details, or clinical notes. This project is not represented as HIPAA-compliant.

## Run locally

Requires Node.js and npm. Install packages and start the development server:

```bash
npm ci
npm run dev
```

Open the local URL printed by Next.js, usually `http://localhost:3000`. `npm run dev` is for local development; it does not publish the app or make it accessible to other staff. The app connects to the Supabase project configured in `.env.local`.

## Environment

Copy `.env.example` to `.env.local` and set these values privately:

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL. The server also normalizes a URL ending in `/rest/v1/`.
- `SUPABASE_SECRET_KEY` — server-only Supabase secret key. The legacy `SUPABASE_SERVICE_ROLE_KEY` name is also accepted. Never add a `NEXT_PUBLIC_` prefix.
- `APP_SHARED_PASSWORD_HASH_B64` — base64-encoded bcrypt hash of the shared event password.
- `SESSION_SECRET` — random secret with at least 32 characters.

`.env.local` is ignored by Git. Never commit it or share its contents. Generate a password hash without writing the password into source files:

```bash
node -e "const b=require('bcryptjs'); console.log(Buffer.from(b.hashSync(process.argv[1], 12)).toString('base64'))" 'YOUR_NEW_EVENT_PASSWORD'
```

## Supabase setup

The initial database schema is in [`supabase/schema.sql`](supabase/schema.sql). It includes patients, audit events, and patient photo metadata with RLS enabled and no browser-access policies. Create a **private** Storage bucket named `patient-photos`, restricted to JPEG/PNG/WebP and 5 MB. The server checks the staff session and issues 60-second signed photo URLs.

The existing Supabase project is already configured. Do not rerun the initial schema against it. The `last_seen` migration in [`supabase/migrations/20261105_add_last_seen.sql`](supabase/migrations/20261105_add_last_seen.sql) was applied and verified on 2026-11-05. The app no longer uses requester check-in or search-attempt flows; legacy tables may remain in the project.

## Current product behavior

- Shared password login, HTTP-only signed 12-hour session cookie, and staff-entered display name (not verified identity).
- Shared patient log with search/filter, CSV export, 15-second refresh, manual refresh, and open-profile refresh.
- Patient profile with intake location/time, current workflow stage, and a dated dot-line timeline backed by `audit_events`.
- Seven statuses. Status changes save automatically on selection. Unusual transitions are muted but selectable and show a warning.
- Private photo upload/viewing; maximum three active photos per patient.
- New inquiries can be queued in browser local storage while offline. Existing edits and status changes are online-only. Reporting location preference is remembered per staff name for the browser session.

See [`HANDOFF.md`](HANDOFF.md) for the current PRD, known limitations, and prioritized readiness checklist.

## Checks

```bash
npm test
npm run build
```

The current automated tests cover Supabase URL normalization only. Manual workflow and mobile-device checks remain necessary.
