# Implementation plan

Companion to `docs/BUILD_SPEC.md`. It covers the order of work, who builds what, and how each step is checked.

**Time box:** about 6 hours overnight, done before Brian and Jeffrey wake up and deploy to Vercel for EDC Orlando on Nov 6.

## Phase 0: plan review (now)

Two independent reviews read the spec, this plan, `design/DECISIONS.md`, the mockups and Jeffrey's original code:

- **GPT-6 Astra** (Codex, top reasoning setting)
- **Claude Fable 5.1** (max reasoning)

Their findings get merged into the spec before any code is written.

## Phase 1: foundation (1 agent, sequential, on `rework/ui`)

Owns these shared files. Later agents must not restructure them, and may only add to them.

1. **Toolchain.**
   - Upgrade to Next 16.4 and React 19.3.
   - Add the deps from spec §2.
   - Scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `test` (vitest unit), `test:int` (vitest integration against local Supabase), `test:e2e` (playwright), `db:start`, `db:reset`.
   - TypeScript strict. ESLint flat config.
2. **Local Supabase.**
   - `supabase/config.toml`, with the private bucket.
   - The migration `20261106_rework.sql` (spec §5), applied on top of `schema.sql` and the two existing migrations.
   - `seed.sql` (synthetic).
   - A `scripts/db-reset.sh` that rebuilds the local database from scratch.
   - Prove the migration is idempotent by running it twice.
3. **Server core** (`lib/server/`):
   - `env.ts` (zod)
   - `supabase.ts` (server client)
   - `session.ts` (JWT cookie)
   - `password.ts` (plain or bcrypt, constant time)
   - `http.ts` (error shape, Origin check, body limits, SQLSTATE→HTTP mapping, no-PII logging)
   - `rateLimit.ts`
   - `mappers.ts` (DB row → `RequestSummary` / `RequestDetail`)
4. **Shared code** (`lib/`):
   - `domain.ts` (statuses, transitions, labels, colours, teams, posts, limits, name split, phone check, wait thresholds)
   - `validation.ts` (zod for every API body)
   - `api-types.ts` (the `RequestSummary`, `RequestDetail`, `AuditEvent` and `Stats` types used by both server and client)
   - `format.ts` (event-timezone times, "12m" style durations, LP numbers)
5. **Middleware.** CSP nonce, security headers, auth redirects.
6. **Design system** (`components/ui/`):
   - Theme provider with no-flash script.
   - `StatusGlyph` (port the exact SVG from the mockups).
   - `Icon` re-exports.
   - `Sheet` (bottom sheet built on Radix Dialog).
   - `Toast` / `Snackbar` system with `aria-live`.
   - `Banner`.
   - `AppHeader` (title, live dot, search, bell, avatar slots).
   - `ViewSwitcher`.
   - `EmptyState`.
   - Skeleton blocks.
   - Global CSS: tokens and the mockup CSS ported.
   - Inter self-hosted.
7. **Client core** (`lib/client/`):
   - `api.ts` (typed fetch with errors, `If-None-Match`, abort)
   - `store.tsx` (context, IndexedDB cache, delta polling, optimistic mutations, undo, outbox for new requests)
   - `alerts.ts` (diffing, chime, vibrate, bell setting)
   - `prefs.ts` (theme, name and team, last post)
   - `image.ts` (compression to full and thumbnail)
8. **App routes.**
   - `app/(auth)/signin` placeholder.
   - `app/(app)/layout.tsx` (store provider, header).
   - Placeholder pages for `/`, `/new`, `/r/[id]` and `/dashboard`.
   - Service worker registration and `public/sw.js` (spec §7).
   - The manifest.
9. **Test harness.**
   - Vitest config: unit and integration projects.
   - An integration helper that starts the Next route handlers against local Supabase, or runs `next start` on a test port.
   - Playwright config: iPhone 14 profile, light and dark projects, and a global setup that resets the database and builds.
10. **Commit.**

**Gate:** typecheck, lint, build and unit tests pass, the migration is applied locally, and a smoke test of `/api/session` and `GET /api/requests` against the seed passes.

## Phase 2: features (5 agents in parallel, each in its own git worktree off the foundation commit)

**File ownership is strict.** An agent may **read** everything but only **write** its own files. Missing shared pieces go in the agent's report, and the integration agent adds them. No new dependencies.

| Agent | Owns (writes) | Builds |
|---|---|---|
| **A. API** | `app/api/**`, `lib/server/**` (adding only), `tests/integration/**` | Every route in spec §6, calling the RPCs; integration tests for each route (spec §9.3) |
| **B. Sign-in** | `app/(auth)/**`, `components/signin/**`, `public/logos/*` | Both steps, logos, credit, theme toggle, session-expiry landing, rate-limit message; e2e `signin.spec.ts` |
| **C. List** | `app/(app)/page.tsx`, `components/list/**`, `components/search/**` | All, Pending (Friend coming and Waiting), My requests, view switcher wiring, search, empty / offline / error states, skeletons, undo snackbar, alert banners shown on the list; e2e `list.spec.ts` |
| **D. New request** | `app/(app)/new/**`, `components/request-form/**` | The form (shared with Edit through a `mode` prop), post picker sheet, stage chips, photo capture and compression, draft, offline outbox UI; e2e `new-request.spec.ts` |
| **E. Profile and dashboard** | `app/(app)/r/**`, `app/(app)/dashboard/**`, `components/profile/**`, `components/dashboard/**`, `components/account/**` | Profile (status block, details, Call, photos and viewer, audit trail, sticky actions, change answer, cancel dialog, conflict banner, edit through D's form component, which waits on D, or a stub on the shared props contract), dashboard, avatar menu, CSV; e2e `profile.spec.ts` and `dashboard.spec.ts` |

Each agent checks its own work before reporting:

1. Typecheck, lint and unit tests pass in its worktree.
2. It starts the app against local Supabase and screenshots its screens at 390×844 in both themes, then compares them with the mockup PNG.
3. It commits on its branch, `feat/<agent>`.

## Phase 3: integrate (1 agent)

1. Merge A through E into `rework/ui`.
2. Resolve conflicts.
3. Wire the shared gaps that agents reported.
4. Run the full gate: typecheck, lint, build, unit, integration and end-to-end.
5. Fix everything until it's green.
6. Commit.

## Phase 4: review (parallel, then fix, repeated until a round finds nothing new)

1. **Claude reviewers, one per lens:**
   - security (auth, CSRF, CSP, IDOR, injection, secrets, rate limit, bucket privacy)
   - correctness and data integrity (transitions, races, idempotency, timestamps, timezones)
   - offline and sync (polling, merge, outbox, service worker never caching the API, low data)
   - UI fidelity against the mockups (screenshots)
   - accessibility and mobile (tap targets, keyboards, iOS Safari quirks, safe areas)
   - performance (bundle, renders, image sizes)
2. **Adversarial verify.** Each finding is checked by 2 skeptics; it survives only if it's real.
3. A fix agent fixes the confirmed findings, adds regression tests and reruns the gate.
4. **Codex review (GPT-6 Astra, ultra)** of the whole branch diff. Its findings go through the same verify and fix steps.

## Phase 5: browser QA (1 agent)

1. Run the full Playwright suite in headed Chromium and WebKit.
2. Explore manually through browser automation, following the operational script: two staff, front of house and liaison, through a whole night's flow, offline included.
3. Do a final screenshot comparison against the mockups.

## Phase 6: ship (me)

1. Final gate.
2. Update the README and HANDOFF.
3. Push `rework/ui` and open the PR with Jeffrey's migration steps.
4. Link the PR.

## Phase 7: only if there's time, after the PR is pushed

- An offline outbox for photos and status changes, with conflict handling.
- Lock-screen Web Push (VAPID env, `push_subscriptions` table, sending from the routes).

Each goes in its own commit on the same PR, behind the same gate and review loop.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Next 16 or React 19 incompatibility | Fall back to Next 15.5 latest plus React 19 only if the build fails, and note it in the PR. |
| Merge conflicts between the parallel agents | Strict ownership, shared contracts frozen in phase 1, and the integration agent owns the glue. |
| The production database differs from `schema.sql`, with legacy columns | The migration only adds things; the functions use only known columns. Jeffrey runs it once. |
| iOS Safari quirks: viewport, `100dvh`, safe areas, bfcache, IndexedDB in private mode | Explicit tests on WebKit and the iPhone profile. Fall back to memory if IndexedDB is unavailable. |
| Clock skew between server and phone | The cursor is always `serverTime` from the server, and the `since` window overlaps by 5 s. |
