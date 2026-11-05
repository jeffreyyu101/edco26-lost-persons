# Agent handoff: EDC Orlando 2026 Lost Person Coordination

Updated: 2026-11-04

This is the working brief for the next coding session (Codex, Claude Code, or another agent). Read this file and `README.md` before making changes. Keep `.env.local` private. Never enter real patient data while developing or testing.

## Product context

This is a small-team MVP for roughly 10 event staff coordinating lost-person inquiries at EDC Orlando 2026 (event dates shown in the app: November 6–8, 2026). Staff need a shared, mobile-friendly log for identity descriptions, friend/family contact, location, status, and reunion coordination.

It is not a medical record system. Do not collect diagnoses, medication, treatment, or information copied from medical records. Do not claim HIPAA compliance. Use synthetic data for every development and test workflow.

## Latest PRD

### Users and access

- About 10 event staff share one event password.
- Each staff member enters a display name for action attribution. This name is self-selected and does not establish identity.
- Login compares the submitted password with `APP_SHARED_PASSWORD_HASH_B64` (base64-encoded bcrypt hash) and sets an HTTP-only, signed 12-hour session cookie.
- All patient, export, audit, and photo access must remain behind the session check. Supabase secret/service-role credentials remain server-only.

### Intake and patient profile

- Create an inquiry with identifying description, event location, and friend/family contact details.
- Show case number and patient name, with intake location and date/time prominent at the top of the profile.
- Mobile use is a core requirement: touch-friendly controls, single-column form on narrow screens, and a usable full-height bottom-sheet profile.
- Patient edits and status changes are shared; the log refreshes every 15 seconds and can be refreshed manually.
- Search/filter the shared log and export a CSV. The CSV contains patient/contact data and must be treated as sensitive.

### Workflow and statuses

The profile is a journey timeline, not a collection of medical-search or requester-confirmation actions.

1. **Added** — first timeline point, with the reporting location and intake time.
2. **Checked – Not Found** — a completed check with no match; show the timestamp and “repeat later” meaning. When the current status is already this value, staff can record another check, adding another dated event without changing the status.
3. **Found – Awaiting Reunion** — found and waiting for reunification.
4. **Reunited – Closed**, **Found – Discharged**, **Found – Transported**, and **Cancelled** — closed outcomes.

The current stage appears near the top of the profile. The status dropdown includes all statuses. Expected transitions are normal text; unusual transitions are muted but remain selectable and show an inline warning. Do not use a blocking confirmation popup for saving. Saving should append an audit event and refresh the open profile and log.

The `audit_events` relationship supplies workflow history. Intake is represented from the patient’s `created_at`; status transitions use `occurred_at`. Existing historic `medical_search` and `medical_search_found` audit entries are still interpreted for timeline continuity where possible. There is no medical-search UI/API now.

### Explicitly removed

- No requester waiting confirmation, requester check-in workflow, check-in button, timer, notification, or requester check-in API.
- No separate medical-search buttons, notes prompt, search-attempt endpoint, or search history panel. A “not found” check is represented by the status workflow and audit timeline.
- Do not bring these flows back unless the product owner asks.

The prior production schema may still have nullable requester check-in columns and old search/check-in tables. The app no longer uses them. The local `supabase/schema.sql` omits them for a fresh setup. Do not run destructive SQL against the existing project without explicit approval.

### Photos

- Photos must remain in a **private** `patient-photos` bucket.
- Authenticated server endpoint accepts JPEG/PNG/WebP up to 5 MB and limits each inquiry to three active photos.
- Viewing requires an active staff session and uses a 60-second signed URL.
- Never make the bucket public or add a public URL path.

## Current implementation and known gaps

- Next.js 15.5.29 App Router, React 18, Supabase JS, `jose`, and `bcryptjs`.
- Supabase connection issue was a URL with `/rest/v1/`; server now strips that suffix before creating the client. A read-only query succeeded after normalization.
- `.env.local` is present locally. Its variable names match the code: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, and `APP_SHARED_PASSWORD_HASH_B64`. Values were not included in this handoff. `.env.local` must stay untracked.
- `.env.example` contains placeholders only.
- `npm test` currently has four tests for Supabase URL normalization; there are no API, auth, database, or workflow component tests.
- `npm run build` passed after the latest workflow implementation.
- No deployment target is configured. `npm run dev` serves this machine only; it does not make the app accessible to all staff. If event staff need to use it on separate devices, choose and configure an HTTPS host before calling it operational. No target or production credential is currently available.
- Patient writes and audit writes are separate operations, so partial success is possible. The three-photo limit can race under simultaneous uploads.
- Login has no rate limiter. Shared password and entered staff names are limited identity controls.
- Offline queue uses browser local storage and only handles new inquiries; existing updates/status changes require a connection. It has not been field-tested.
- UI has no complete audit-history screen; the profile timeline shows intake/status milestones.
- Photo bucket configuration and the full upload/view flow still need a synthetic-data manual test.
- Backups/restore, retention/purge, monitoring, staff training, and formal security/privacy review are not complete.

## Readiness plan for 2026-11-05

Treat “ready” as a verified staging/demo state, not automatic approval to use real person data. Prioritize in this order:

### P0 — protect the project and prove core flows

- Confirm `.env.local` is ignored by Git before staging or committing. Never print or copy secret values.
- Keep the repository private. Review staged files before committing; do not stage `.env.local`, `.next`, or `node_modules`.
- Run `npm ci`, `npm test`, and `npm run build` from a clean checkout.
- Use synthetic records to manually verify: login/sign-out/session expiry; create; search/filter; profile intake details; status transition; repeated “Checked – Not Found” event; found/reunified/closed timeline; cross-refresh state; CSV export; and edits.
- Test on a real iPhone in Safari: sign-in, create, open profile, select a status, warning for unusual transition, save, view timeline, rotate/scroll, and refresh.
- Test upload/view for valid image types, wrong content type, over 5 MB, fourth photo, unauthenticated access, and private bucket behavior. Do not use real photos.

### P0 — decide whether this is local demo or multi-device operation

- Local `npm run dev` is only reachable on the developer’s computer by default. It does not satisfy shared access for 10 staff.
- If shared devices are required, the product owner must choose an HTTPS hosting target and configure its environment secrets. Do not deploy to an unspecified target, and do not use a development server as the event service.
- Before any live operation, confirm the operations owner, password distribution/rotation, device access, backup/restore plan, retention process, and who responds to errors.

### P1 — address before real operational data

- Add login rate limiting and review auth/session behavior.
- Make patient + audit updates atomic (e.g. vetted database RPC/transaction design); do not silently accept partial audit failures.
- Make three-photo enforcement concurrency-safe.
- Add focused automated tests for auth gates, input validation, status/audit timestamps, and photo access. Prefer an isolated test project or mocks; never write synthetic tests into production data.
- Review CSV export scope and privacy; restrict access and avoid storing exports on shared devices.
- Run a security/privacy review with the event/medical operations owner. Do not claim compliance certification.

## Local setup

```bash
npm ci
npm run dev
```

Run verification with:

```bash
npm test
npm run build
```

Use `README.md` for environment setup. Existing Supabase project and private bucket were configured previously. Do not run schema changes against production as part of pickup. No production database changes or deployment were made in this workspace.

## Handoff checklist

- [ ] `.gitignore` is in place and `.env.local` is confirmed ignored.
- [ ] Create/connect a private Git remote; review files before committing.
- [ ] Share this file and `README.md` with the next agent.
- [ ] Tell the next agent whether the goal is local demo or multi-device hosted operation.
- [ ] Keep tests synthetic; never paste secrets or patient information into prompts, logs, commits, or screenshots.
