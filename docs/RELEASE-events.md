# Releasing the multi-event foundation (phase 1)

`supabase/migrations/20261110000000_events.sql` with the build of `feat/events-foundation`. Rollback:
`supabase/rollback/20261110000000_events_down.sql` with the build at `main` 0a416a9.

**Do this only while no event is live.** Today that means EDC is over and the next event has not started (Warped Tour
practice from Thu 2026-11-12). The old build and the new build cannot share a database: whichever goes first, the app
does not work until the other one is in place, so there is an outage window and nobody may be working a live log
during it.

## Before the day

- The PR is reviewed and green, but **not merged** (merging deploys it).
- No new environment variable is needed. Keep `APP_SHARED_PASSWORD_HASH_B64` (or `APP_SHARED_PASSWORD`),
  `INVITE_CODE_SHA256` and `INVITE_EXPIRES_AT` in Vercel: the bootstrap reads them once, and a rollback needs them.
- Note the Vercel deployment of `main` 0a416a9 (Deployments → the current production one): that is the rollback
  target.
- Have the lead passcode ready (8 characters or more, not the EDC staff password). It is typed at a prompt, never put
  on a command line.
- Look at the last production build time in Vercel. The outage window below is about that long.

## Cut-over, in this order

| Step | What you do | What staff see |
| --- | --- | --- |
| 0 | Nothing yet | The old build, EDC's log (EDC is over; nobody should be working in it). |
| 1. Dry run | Supabase → SQL Editor (role `postgres`): paste the whole events file, change the last line `commit;` to `rollback;`, run. It must finish without an error. | Nothing changes. |
| 2. Migration | Paste the file again unchanged (ending in `commit;`) and run it. **The outage starts here.** | Every screen fails: lists and new requests answer "Couldn't reach the log" (the old build calls functions this file retired). |
| 3. Deploy | Merge the PR to `main` right away. Vercel builds and deploys it. | Still the error until the new deployment is Ready. Then: old cookies are refused, so everyone lands on sign-in, and every password is refused (none is set yet). |
| 4. Bootstrap | `set -a; . <file with the production values>; set +a; node scripts/bootstrap-events.mjs --dry-run`, then the same without `--dry-run`. It asks for the lead passcode twice (hidden). **The outage ends here.** | The lead passcode signs in as lead (Events). The EDC password and the EDC join link show the Ended screen. |
| 5. Next event | A lead creates it in the app, sets its staff password (and join link), and goes live when ready. | Staff of the new event sign in with its password. |

**Outage window:** from step 2 to the end of step 4: the Vercel build time plus about a minute (typically 3 to 5
minutes). Run steps 2, 3 and 4 back to back.

## Verify

After step 2 (SQL Editor):

- `select slug, stage, ended_at, case_seq from public.events;` → one row, `edco26 | archived | 2026-11-09 11:00:00+00 | <highest LP number>`.
- `select count(*) from public.patients where event_id is null;` → `0`.
- `select count(*) from cron.job where jobname = 'lp-close-inactive';` → `1` (unchanged; it now only touches live events).

After step 4:

- Sign in with the lead passcode → the Events list (role lead, no event open).
- Sign in with the old EDC password, and open an old EDC join link → the Ended screen (HTTP 410 `event_ended`).
- `select lead_passcode_hash is not null, lead_passcode_version from public.lp_org;` → `true | 1`.

## Roll back

Only before a new event has requests: the rollback refuses when any event is live or any request belongs to an event
other than `edco26`, and it deletes nothing.

1. Dry run: SQL Editor, paste `supabase/rollback/20261110000000_events_down.sql`, last line `commit;` → `rollback;`, run.
2. Paste it again unchanged and run it. From here the new build fails (its functions are gone).
3. At once: Vercel → Deployments → the 0a416a9 production deployment → Instant Rollback (seconds). The old build
   works again with the env password. Later pushes to `main` are not promoted until you promote one by hand.

What stays: the `events` and `lp_org` tables, every `event_id` column and its values, the lead functions. Requests the
old build creates afterwards have no event; running the events file again later puts them in `edco26`, like the rest.

To go forward again: the same cut-over from step 1 (the file is safe to run twice and on a rolled-back database).

## For phase 2 builders

- `20261110000000_events.sql` must be the **last** migration applied. The older files (the rework file above all) put
  back the fixed post list, the global case number and the old functions when pasted after it. If you paste an older
  file into a local stack, paste every later file again in order afterwards (`reapplyAfterRework()` in
  `tests/integration/harness.ts` does that for the tests).
- `~/.config/lp-stacks/use.sh N <worktree>` does it for you: on a worktree that has the events file it applies the
  rework file twice and then every later migration in order, the events file last. On a branch without the events file
  it does what it always did.
- New migrations go after the events file and must keep its guards: every write RPC calls `lp_require_writable(event)`
  first; requests and their audit, messages, photos and en route rows of an archived event are refused by triggers.
