# Implementation plan v2

Companion to `docs/BUILD_SPEC.md` (v2). It folds in the Codex (GPT-6 Astra) and Claude Fable 5.1 plan reviews.

## Ground rules for every agent

- **Read first:** `docs/BUILD_SPEC.md`, `design/DECISIONS.md` and the mockups that apply to you.
- **Local services:**
  - **One** local Supabase stack runs for the whole build. Phase 1a starts it from the main checkout with `supabase start`.
  - **Worktree agents must never** start, stop or reset it, and must not run `supabase db reset`. Only the Phase 1a, 1b-server, Integrate and QA agents may reset it, and only when no other agent is running.
  - Tests that mutate data create their own uniquely named synthetic rows (`TEST-<agent>-<n>`).
  - Each agent uses its own Next port: 1a uses 3100, server 3101, client 3102, sign-in 3103, list 3104, form 3105, profile 3106, integrate and QA 3100.
- **Environment.** Never read `.env.local`. Use `.env.test`. The helpers refuse non-local hosts.
- **Dependencies.** No new ones after Phase 1a. If you need one, stop and report it.
- **Commits.** Commit to your own branch with clear messages. Your final reply must list:
  - the branch name and last commit SHA
  - what was built
  - the test results
  - anything a later agent must wire up
  - anything you could not finish

## Phase 0: plan review (done)

Codex and Fable reviewed the plan and their findings are merged into spec v2. Next comes a short confirmation re-review by both, running **in parallel with Phase 1a**. If they find blockers, they get patched into the contracts before Phase 1b starts.

## Phase 1a: contracts and toolchain (1 agent, on `rework/ui` in the main checkout, about 45 min)

1. **Background installs.** Run `npx playwright install chromium webkit` in the background.
2. **Clean out the old app.** Delete the old app's `app/page.tsx`, `app/ui.tsx`, `app/styles.css`, `app/api/**` and `lib/*` (keep `lib/supabase-url.js` logic by moving it into `lib/server/env.ts`) and `tests/supabase-url.test.cjs` (port it to vitest).
3. **Upgrade and configure.**
   - Next 16.4, React 19.3, and the spec §2 dependencies.
   - `tsconfig` strict.
   - ESLint flat config.
   - `vitest.config.ts` with the projects `unit` and `integration`.
   - `playwright.config.ts`: `workers: 1`, Chromium iPhone 14 plus WebKit, `baseURL` from `PORT`.
   - Scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `test:int`, `test:e2e`, `db:reset`.
4. **Supabase local:**
   - `supabase/config.toml` (project_id `lp-local`, the private bucket `patient-photos`, 6 MB, jpeg/png/webp).
   - The renamed migration chain (§5).
   - A **complete** `20261106000000_rework.sql` with every function.
   - `supabase/seed.sql` (synthetic, about 21 rows across every status, plus 2 legacy-format rows).
   - `scripts/db-reset.sh` with the host guard.
   - `supabase start`, reset, and prove the migration runs twice.
   - `.env.test` with the local keys.
5. **Contracts.** Frozen after this phase; later agents may add to them, never change them.
   - `lib/domain.ts`, complete, with unit tests.
   - `lib/api-types.ts`: `RequestSummary`, `RequestDetail`, `AuditEvent` with normalized legacy actions, `Stats`, `ApiError`, `SyncResponse`, `OutboxItem`.
   - `lib/validation.ts`: zod for every body.
   - `lib/format.ts`: event timezone, `h:mm`, weekday, durations, `LP-1004`.
   - `lib/client/store-contract.ts`: the store's public TypeScript interface (state shape, selectors, `setStatus`, `create`, `updateFields`, `cancel`, `addPhotos`, `syncNow`, `outbox` API, `connection`) and a **stub** implementation good enough for UI agents to render against seeded fake data.
   - Component **stubs** with final props: `RequestForm`, `PostPicker`, `AccountMenu`, `StatusGlyph`, `Sheet`, `Toast`/`Snackbar`, `Banner`, `ViewSwitcher`, `AppHeader`.
6. **App skeleton:**
   - `app/layout.tsx` (Inter, the no-flash theme script with the nonce, Radix Theme).
   - `app/signin/page.tsx` (placeholder).
   - `app/page.tsx`: the store provider and a view router that uses search params and `history.pushState`, with placeholder views.
   - A `proxy.ts` that adds the CSP nonce, the security headers and the auth redirects, with the matcher from §6.
   - `public/manifest.webmanifest`, icons (192 and 512 maskable, plus `apple-touch-icon` generated from the EDC and GC logos on a dark background), and `public/logos/*`.
7. **Gate:** `typecheck`, `lint`, `build` and `unit` pass, and the migration is applied locally twice. Commit.

## Phase 1b: core (2 agents in parallel, each in its own worktree off the 1a commit)

| Agent | Owns (writes) | Builds |
|---|---|---|
| **S: server** | `app/api/**`, `lib/server/**`, `tests/integration/**`, `scripts/load-test.mjs` | Every route in §6. Env, session (sliding renewal), password, Origin check, error mapping, mappers including legacy audit normalization, CSV, the photo pipeline. **Every integration test in §9.3**, migration upgrade-fixture tests included. The load script (§9.7). May reset the database (it's the only database user in 1b). |
| **C: client core** | `lib/client/**` (replacing the stub with the real store), `components/ui/**` (real implementations of the stubs), `public/sw.js`, `app/page.tsx` shell wiring, `tests/unit/client/**` | Store: sync and reconcile, overlays, per-id serialization, undo, the outbox with photos and `navigator.locks`, the draft in IndexedDB, session handling and legacy queue import. Alerts. Image compression. Prefs. The service worker with the update toast. The design-system components ported from the mockups. Unit tests for all of it, using a mocked fetch. |

**Gate**, per agent: `typecheck`, `lint` and its own tests pass. Commit on its branch.

## Merge 1 (1 agent, main checkout)

1. Merge S and C into `rework/ui`.
2. Run the full unit and integration suites.
3. Smoke test the real store against the real API, through a scripted Playwright check: sign in, the seeded list renders, create, set status, sync.
4. Fix anything broken.
5. Commit.

## Phase 2: screens (4 agents in parallel, worktrees off Merge 1)

| Agent | Owns | Builds |
|---|---|---|
| **B: sign-in** | `app/signin/**`, `components/signin/**`, `tests/e2e/signin.spec.ts` | Both steps, exactly as in the mockup |
| **L: lists** | `components/list/**`, `components/search/**`, `tests/e2e/list.spec.ts` | Header, All, Pending, My requests, view menu, filter chip, search, empty and skeleton states, banners on the list |
| **F: form** | `components/request-form/**` (the real `RequestForm`, `PostPicker`), `tests/e2e/new-request.spec.ts` | Create and edit modes, stage chips, the photo slot, the draft wiring, the duplicate hint |
| **P: profile and dashboard** | `components/profile/**`, `components/dashboard/**`, `components/account/**`, `tests/e2e/profile.spec.ts`, `tests/e2e/dashboard.spec.ts` | Profile (all of §8, using `RequestForm` for edit), photo viewer, audit trail, dashboard, avatar menu with CSV |

Every Phase 2 agent:

1. Renders its views against the real store and API on its own port.
2. Screenshots them at 390×844 in light and dark, and compares them with the mockup PNG. A screenshot diff note goes in the report.
3. Writes its end-to-end spec.
4. Commits on its branch.

## Merge 2 / Integrate (1 agent)

1. Merge B, L, F and P.
2. Wire any gaps.
3. Run the **full gate (§9.1–9.4)** in a production build.
4. Fix until green.
5. Commit.

## Phase 3: review loop (repeat until a round finds nothing new)

1. **Claude reviewers, one per lens, in parallel:**
   - security
   - data integrity and races
   - sync, offline and service worker
   - UI fidelity (screenshots against mockups)
   - iOS, mobile and accessibility
   - performance and data use
2. **Codex, GPT-6 Astra (ultra),** reviews the full branch diff.
3. Each finding is checked by 2 adversarial verifiers. It survives only if both agree it's real.
4. A fix agent fixes the confirmed findings and adds a regression test for each.
5. Full gate.
6. Commit.

## Phase 4: browser QA (1 agent)

1. Run the full Playwright suite in Chromium and WebKit.
2. Run a scripted festival-night scenario with 3 contexts (two front of house, one liaison), including offline and lie-fi.
3. Final screenshot comparison against the mockups.
4. Run the load check (§9.7).

## Phase 5: ship (lead)

1. Final gate.
2. Update the README and HANDOFF.
3. Push `rework/ui`.
4. Open the PR with the migration steps and the manual checklist.
5. Link it.

## Phase 6: only if there's time

- Queued status changes, and photos added to existing requests while offline.
- Lock-screen Web Push.

Each one gets its own commits, the full gate and a review.

## Cut line, if time runs short

| | |
|---|---|
| **Must ship** | sign-in, the three views, new request with photos, profile actions and undo, audit trail, CSV, offline create, security |
| **May degrade** | dashboard polish, swiping in the photo viewer, the alerts sheet, skeleton polish, the load check (run it manually) |
