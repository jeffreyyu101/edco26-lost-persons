# Releasing multi-event (Ground Control, many events)

What ships: `supabase/migrations/20261110000000_events.sql` (one transaction, additive, safe to run twice) together
with the build of `feat/events-all` (phases 1, 2a, 2b and 3 joined). Rollback: `supabase/rollback/20261110000000_events_down.sql`
with the build of `main` 0a416a9.

Follow the steps in order. Every SQL step runs in Supabase → **SQL Editor** (role `postgres`) of the production project
`yrdwvenzktmcbspapdcy`. Never paste a password, passcode, hash or join code into a command line, a chat, a PR or an
issue.

**Do this only while no event is live.** EDC is over; Warped Tour Orlando practice starts Thu 2026-11-12. The old build
and the new build cannot share a database: from the migration until the new deployment is Ready, nothing reaches the
log (phones keep what they already show), so nobody may be working a live log then.

## 1. Before the day

- [ ] The PR is reviewed, its checks are green, and it is **not merged** yet (merging deploys it).
- [ ] Decided: the lead passcode (8 characters or more; not the EDC staff password, not any password an event will use).
      It is typed at the bootstrap's prompt only.
- [ ] Vercel → Project → Deployments: write down the deployment id of the current production deployment (`main`
      0a416a9). That is the rollback target.
- [ ] Vercel → Settings → Environment Variables (Production): `APP_SHARED_PASSWORD_HASH_B64` (or `APP_SHARED_PASSWORD`)
      is still there. The bootstrap reads it once; a rollback to 0a416a9 needs it, with `INVITE_CODE_SHA256` /
      `INVITE_EXPIRES_AT`. Remove none of them. No new variable is needed.
- [ ] Have a file with the production values the bootstrap needs, readable by you only (`chmod 600`), outside every
      repository: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) and
      `APP_SHARED_PASSWORD_HASH_B64` (or `APP_SHARED_PASSWORD`).
- [ ] Note the last production build time in Vercel (the outage is about that long, see 3).
- [ ] A checkout of the PR's branch with `npm ci` done (for the bootstrap script), and the Supabase CLI installed
      (`supabase --version`) for the backup.

## 2. Backup (same day, right before the cut-over)

The migration changes no existing value (proved on a copy of `main`'s schema with rows in every table: every
pre-existing column of every row identical after it, after a second run, and after up → down → up), but take a copy
anyway. Storage (the photos) is not touched by the migration; only the database needs copying.

1. Supabase → Project Settings → Database → **Connection string** → "Session pooler" URI. Keep it in a shell variable,
   never in a file in a repository or in your shell history:
   ```sh
   read -rs PROD_DB_URL; export PROD_DB_URL     # paste the URI (with the database password), Enter
   mkdir -p ~/lp-backups && chmod 700 ~/lp-backups && cd ~/lp-backups
   supabase db dump --db-url "$PROD_DB_URL" -f pre-events-schema.sql
   supabase db dump --db-url "$PROD_DB_URL" --data-only --use-copy -f pre-events-data.sql
   chmod 600 pre-events-*.sql
   ```
   These files hold real people's details: keep them on your machine only, and delete them once the release has been
   confirmed for a week.
2. Count what the database holds now. SQL Editor:
   ```sql
   select 'patients' t, count(*) from public.patients union all select 'audit_events', count(*) from public.audit_events
   union all select 'patient_photos', count(*) from public.patient_photos union all select 'lp_messages', count(*) from public.lp_messages
   union all select 'lp_activity', count(*) from public.lp_activity union all select 'lp_push_subscriptions', count(*) from public.lp_push_subscriptions
   order by 1;
   ```
3. Verify the dump holds the same rows (one line per row between `COPY "public"."<table>"` and `\.`):
   ```sh
   awk '/^COPY / {t=$2; gsub(/"/, "", t); n=0; next} /^\\\.$/ {if (t) print t, n; t=""; next} t {n++}' pre-events-data.sql | grep -E '^public\.(patients|audit_events|patient_photos|lp_messages|lp_activity|lp_push_subscriptions) '
   ```
   Every count must equal step 2's. Also: `grep -c 'CREATE TABLE' pre-events-schema.sql` is more than 10, and
   `grep -c 'CREATE OR REPLACE FUNCTION' pre-events-schema.sql` is more than 40. If anything differs, stop here.
4. Supabase → Database → Backups: note the time of the latest scheduled backup as well (the second safety net).

Restoring (only if a rollback in 6 is not enough): into an empty Supabase database, `psql "$URL" -f pre-events-schema.sql`
then `psql "$URL" -f pre-events-data.sql`; or ask Supabase support to restore the scheduled backup of step 4.

## 3. Cut-over, in this order

| Step | What you do | What staff and leads see |
| --- | --- | --- |
| 0 | Nothing yet | The old build, EDC's log (EDC is over; nobody works in it). |
| 1. Dry run | SQL Editor: the **patients fingerprint** (section 4), write down both values. Then paste the whole events file, change its **last** line `commit;` to `rollback;`, run. It must finish without an error (notices are fine). | Nothing changes. |
| 2. Migration | Paste the file again **unchanged** (ending in `commit;`) and run it. **The outage starts here.** | Nothing reaches the log (the old build calls functions this file retired). A phone keeps its last list with "Updating…" and holds a new request on the phone as "Waiting to send". Only a phone with nothing stored shows "Can't reach the log". |
| 3. Deploy | Merge the PR to `main` at once. Vercel builds and deploys it. | The same until the new deployment is Ready. Then old sessions are refused, so everyone lands on sign-in, and every password is refused (none is set yet). A phone or computer that last ran the old build may show the old EDC screen until it signs in or reloads. |
| 4. Bootstrap | In the checkout: `set -a; . <the file from 1>; set +a; node scripts/bootstrap-events.mjs --dry-run`, then the same without `--dry-run`. It asks for the lead passcode twice (hidden). If it stops after `lead passcode set.` (before `retired staff password recorded`), run it again with `--force`: without it, it refuses a passcode that is already set. Type the same passcode. **The outage ends here.** | The lead passcode signs in as a lead (the Events list). The EDC password is refused like any wrong password. |
| 5. Check | Section 4 below, signed in. | — |
| 6. Next event | A lead creates Warped Tour in the app (section 5) and leaves it in practice until the show. | Its staff sign in with its password or join link. |

**Expected outage:** from step 2 to the end of step 4: the Vercel build time plus about a minute (usually 3 to 5
minutes). Run steps 2, 3 and 4 back to back.

**If the Vercel build fails in step 3:** the old build is still the production deployment, so there is nothing to undo
in Vercel. The way back is the rollback SQL alone (section 6, steps 2, 3 and 5). Then push nothing to `main` until you go
forward again (or revert the merge): the next build of `main` that succeeds deploys the new build onto the rolled-back
database.

The bootstrap sets the lead passcode and records EDC's old staff password (from the env) as **retired**: it is never a
way in, and only stops anyone from choosing it as the lead passcode, now or later in the app. An archived event keeps no
staff password and no join link once 24 hours have passed since its end (EDC ended long before; see "Ended" below).

## 4. Verify

### Patients fingerprint (right before step 2 and right after it)

```sql
select count(*) as patients, md5(coalesce(string_agg((to_jsonb(p) - 'event_id')::text, E'\n' order by p.id), '')) as fingerprint from public.patients p;
```

Every column of every request except `event_id` (the one column the migration adds), in id order. After step 2 both
values must equal the ones written down in step 1. If they differ, roll back (section 6, steps 2 and 3).

### Right after step 2 (SQL Editor)

- The patients fingerprint above → the same two values as before step 2.
- `select slug, stage, case_seq, staff_password_hash is null as no_pw, invite_code_sha256 is null as no_link from public.events;`
  → one row: `edco26 | archived | <highest EDC LP number> | true | true`.
- `select count(*) from public.patients where event_id is null;` → `0`.
- `select count(*), bool_and(active) from cron.job where jobname = 'lp-close-inactive';` → `1 | true` (unchanged; it
  now only touches live events). `false` means it was paused before the release: it is not needed for correctness, but
  turn it back on as it was.

### After step 4, signed in (a phone and a computer)

Lead (phone):
- [ ] Sign-in → your name and team → Continue → the lead passcode in "Event password" → the **Events** list. EDC Orlando
      is under "Archived 1" with the Archived chip and an initials tile (EO) for its logo (EDC has none until a lead
      uploads one on the event's screen).
- [ ] Open EDC Orlando → its log: read-only (no New request), the Archived chip by "Updated", the dashboard with day
      tabs (All + one per show day). Account menu → Events → back to the list.
- [ ] On the Events list: account menu (top right) → Lead passcode is there; leave it unchanged. (The event log's
      account menu has no Lead passcode.)
- [ ] `select lead_passcode_hash is not null, lead_passcode_version, (select ended_password_hash is not null from public.events where slug = 'edco26') from public.lp_org;`
      → `true | 1 | true`.

Staff, ended event:
- [ ] Sign-in with the old EDC password → "Incorrect password".
- [ ] An old EDC join link (made before events, `#join=<code>` without the event's name) → name + team → Continue →
      the password step, as for any link that is not accepted. (Links made in the app carry the event,
      `#join=<slug>.<code>`, and reach the Ended screen.)

Lead (computer, 1024 px or wider), with a throwaway practice event:
- [ ] Events → New event: a name such as "Release check", one post, one team, Create. Set a staff password; Create a
      join link and Copy it.
- [ ] A second browser (private window): open the join link → name + team → Continue → the practice log with the
      **Practice** chip, its one post, no rows. Log a request: **LP-0001**.
- [ ] Back as lead: the sidebar's event switcher lists EDC Orlando and Release check; switching shows each event's rows
      only.
- [ ] Go live (the sheet's Practice requests tile shows 1 with the **Deleted** chip) → the second browser loses the practice request within a few
      seconds and the Practice chip goes away (a phone shows the green **Live** chip; the desk shows none); a new
      request there is **LP-0001** again.
- [ ] End event → the second browser shows the **Ended** screen: Ground Control (and the event's logo, if one was uploaded), the event name,
      the Archived chip, "This event is now closed. Thank you for your work.", and nothing else. Opening the join link
      again shows the same screen; its password is refused.
- [ ] The test event's request now belongs to an archived event: it never shows to any other event. Leave it, or
      remove it with section 6, step 1 (Reopen, delete, End). A rollback needs it gone.

A phone or computer that last ran the old build shows the old EDC screen until it signs in, and can show it again
right after signing in: on a slow or no signal the old app shows its own stored sign-in page, which signs in but then
opens the old EDC screen. If a check above shows the old screen (EDC banner, New request on EDC, no event switcher):
close the app completely and open it again on good signal (a second time if needed). Staff can also tap
**Update ready** → **Reload**; the old app refuses that while something is waiting to send or a new request is open.
A lead with no event open gets a stuck screen there and no **Update ready**: account menu → **Sign out**, then sign in
again on good signal. On a lead's computer, close every other tab of the app before signing in; if a tab then hangs,
close it and open a new one.

## 5. Setting up Warped Tour (no developer needed)

Lead, on a phone or computer: Events → **New event**, in the screen's order: Name, Link (suggested), Dates, Time zone,
Day starts, Posts, Main medical, Teams (mark the medical team), Last seen, Report (Department, Prepared by, Staffing) →
**Create**.

- Names: a post up to 40 characters, a team up to 80. **Short** (what charts and chips show; at most 16 for a post,
  24 for a team) is optional. Left empty, it is made from the label: the label itself if it fits, otherwise the part
  before a dash, colon, slash or bracket ("FA 1" from "FA 1 – Main Stage"), otherwise the label cut at a word. The
  empty Short field shows that value greyed out, and each chip shows the Short it will be stored with. Type a Short
  only to choose another one.
- Each Short is used once among the posts and once among the teams. Two labels that make the same Short ("Gate A –
  North Side" and "Gate A – South Side" both make "Gate A") are refused: the second chip gets a red outline and the
  alert glyph, the line under the list reads "<label>: Short already used", and tapping the chip opens it on Short.
- After Create the event's screen shows **Logo** → **Upload** (PNG, WebP or JPEG up to 1 MB; a single-colour logo on a
  transparent background is tinted on the staff, desk, sign-in and lead screens, anything else is shown as uploaded).
- Password → Staff → **Set** the staff password. Join link → **Create**, then **Copy** it at once: it is shown once.
  **New link** replaces the link already sent; the old one stops working. A link stops working two full days after
  the event's last day. "Event dates have passed" or "Event is more than 90 days away" under the Join link row: fix
  the Dates first.

The event starts in practice: every screen shows the amber Practice chip. **Go live** on the morning of the show deletes
every practice request (rows, messages, photos) and restarts numbering at LP-0001; phones already open drop the practice
rows at their next sync. Its sheet shows Practice → Live, the **Practice requests** count (with a **Deleted** chip when
there are any) and **Starts at** LP-0001. Practice requests in any new event close the rollback path (section 6).

**End event** signs staff out to the Ended screen; nothing on the server is deleted. Its sheet shows the **Open** and
**Logged** counts, then Staff **Signed out**, Records **✓ Kept**, Password and link **Kept 24 h**. End only after the
last request is in: a request a phone still holds as "Waiting to send" is dropped when the event ends, and Reopen does
not bring it back.

**Reopen** (on the event's screen: Events → the event → account menu **Event**, or the desk sidebar's **Event** →
Reopen) brings an archived event back to live. Within 24 hours of the end it keeps the same staff password and join link
(staff sign in again with what they have); after that, set a new password and link. The Reopen sheet shows which:
Password and Join link, each **Kept** or **New one needed**, **Time left** (within the 24 hours), the **Open requests** count, and Staff
**Sign in again**.

## Tell staff before the first show

Lines a lead can paste into the briefing:

- Before the practice, sign in for the first time on good signal or Wi-Fi with the new link, and keep the app open
  until it has loaded once.
- If the old EDC screen shows after signing in, close the app completely and open it again (a second time if needed).
- Nothing typed into the old EDC screen is sent. A request logged there shows **Not sent · needs attention**: close
  the app, open it again, sign in, and log it again.

## 6. Roll back

Possible only while **no event is live and no request belongs to an event other than EDC**: the rollback refuses
otherwise and changes nothing. So: before Warped Tour's first request (practice included), or after step 1.

If the Vercel build failed in section 3, step 3, the old build is still serving: do steps 2, 3 and 5 only.

1. For every event other than EDC that holds requests (the Release check event from section 4 does):
   1. If it is archived, **Reopen** it in the app first (Events → the event → account menu **Event**, or the desk
      sidebar's **Event** → Reopen). An archived event's requests can't be deleted: the write guard answers
      `event_ended` to every delete.
   2. SQL Editor: delete its requests, with its link name in place of `<link name>` (three times):
      ```sql
      begin;
      delete from public.patient_photos where patient_id in (select p.id from public.patients p where p.event_id = (select e.id from public.events e where e.slug = '<link name>'));
      delete from public.audit_events where event_id = (select e.id from public.events e where e.slug = '<link name>');
      delete from public.patients where event_id = (select e.id from public.events e where e.slug = '<link name>');
      commit;
      ```
      Its messages, message reads, en route marks, activity and auto-close records go with each request (they are
      deleted with it). The photo files stay in Storage (`patient-photos`); nothing shows them.
   3. **End** it in the app.
2. Dry run: SQL Editor, paste `supabase/rollback/20261110000000_events_down.sql`, change its last line `commit;` to
   `rollback;`, run. It must finish without an error.
3. Paste it again unchanged and run it. From here the new build fails (its functions are gone).
4. At once: Vercel → Deployments → the 0a416a9 production deployment noted in 1 → **Instant Rollback** (seconds). The
   old build works again with the env password and join link. Later pushes to `main` are not promoted until you
   promote one by hand.
5. Check: sign in with the EDC password → EDC's log; `select count(*) from public.patients;` is section 2's count plus
   any request someone typed during the outage. Those were held on the phone and are sent once the old build is back
   (they have no event, and go to `edco26` if you go forward again). A device that ran the new build shows it once:
   reload. A computer that opened the test event may still list its request: sign out and clear the site's data on it,
   or ignore it (the database count is the truth).

What stays after a rollback: the `events` and `lp_org` tables, every `event_id` column with its values, the lead
functions, the `event-logos` bucket, and `lp_tel_events_team_check` in its looser form. Requests the old build creates
meanwhile have no event; running the events file again later puts them in `edco26` with the rest.

To go forward again: start at section 3 step 1 (the fingerprint and the dry run; the file is safe to run twice and on a
rolled-back database), then steps 2 and 3. Skip step 4: the lead passcode and EDC's retired password are kept (the
bootstrap's `--dry-run` refuses: "a lead passcode is already set"). The outage ends when the deployment is Ready.
Expect `lead_passcode_version` unchanged, and one more archived event per test event ("Archived 2" with Release check;
two rows in the step 2 events check).

## Ended, sign-in and passwords

- **24-hour grace period after End.** For 24 hours after `ended_at` the event keeps its staff password hash and join
  link, so an accidental End can be undone: **Reopen** within them brings the event back live with the same password
  and link working again (staff were signed out at End and sign in again with what they already have).
- **While held**, sign-in with that password or that join link answers 410 `event_ended` with the event (the Ended
  screen) and signs nobody in. No other event may be given that password and the lead passcode may not equal it (the
  uniqueness rule counts a held hash like a running event's).
- **After 24 hours** both are cleared: lazily at the next sign-in or join-link attempt and at Reopen (correctness never
  waits for a job), and by the `lp-close-inactive` job every 5 minutes so stale hashes do not linger. Then an old
  password is a wrong password ("Incorrect password"); an old join link (`#join=<slug>.<code>`) still reaches the Ended
  screen through its slug (410 `event_ended`; it verified no credential, so it counts as a failed attempt in the
  sign-in rate limit); Reopen needs a new password and link. EDC's own old links have no slug: they are simply not
  accepted (the sign-in goes on to the password step).
- **Sign-in cost stays bounded:** a failed sign-in compares the password with the bcrypt hash (≈ 70 ms each) of every
  practice or live event and of every event that ended under 24 hours ago; never with older ended events.
- **Never two running events with one password:** setting a staff password re-checks, under the `lp_org` row lock that
  Reopen also takes, that no hash came into force after the app server compared (`p_checked`); if one did (a Reopen
  kept its password at that moment), the write is refused and the server checks again.
- Staff still signed in when the event ends get the Ended screen at their next sync or write (unchanged).
- An archived event refuses a new staff password or join link (409); Reopen first.
- Once cleared, the hash is kept apart (`events.ended_password_hash`) for one purpose: the lead passcode may never
  equal it. Sign-in never reads it.
- Check (SQL Editor): `select slug, stage, ended_at, staff_password_hash is not null as held_pw, invite_code_sha256 is not null as held_link from public.events where stage = 'archived';`
  → `held_*` true only where `ended_at` is under 24 hours ago.

## For builders

- `20261110000000_events.sql` must be the **last** migration applied. The older files (the rework file above all) put
  back the fixed post list, the global case number and the old functions when pasted after it. If you paste an older
  file into a local stack, paste every later file again in order afterwards (`reapplyAfterRework()` in
  `tests/integration/harness.ts` does that for the tests; `~/.config/lp-stacks/use.sh N <worktree>` does it for a stack).
- A stack that has had the events file is not fit for a branch without it (`main`): the rework file alone does not bring
  back the later files' functions. Paste the rollback file into it first. It refuses while an event is live or holds
  requests, so **delete the test events' requests first, while they are still running, then end them** (an archived
  event's requests can't be deleted: the write guard refuses). Or give that branch a stack that never had the events
  file.
- New migrations go after the events file and keep its guards: every write RPC calls `lp_require_writable(event)`
  first; requests and their audit, messages, photos and en route rows of an archived event are refused by triggers.
- Client: `useEventConfig()` / `useSessionRole()` (`lib/client/event-config.ts`), the chip `components/ui/StageChip.tsx`,
  the logo `components/ui/EventLogo.tsx`. Anything that opens another event calls `markSignedInEvent(eventId)`
  (`lib/client/signed-in-at.ts`) before loading `/` (sign-in, the Events list and the desk switcher do), so the app
  never starts from the previous event's cache.

## Notes by phase

- **First-load budget (phase 3):** back under the original limits (235 KB total, 44 KB route-only); 2a's raise to
  236 KB is withdrawn. The toasts and the Undo bar now load with the dialogs chunk right after hydration.
- **Alerts banner (phase 3):** the device remembers the banner it last showed (`localStorage lp-alerts-banner`, not per
  event) and holds its place from the first paint, so a second cold load no longer moves the list. A first-ever visit
  still shifts once.
- **Old phones (2a, cut-over fixes):** a phone that holds the old build shows the old EDC screen until it signs in.
  The NEW sign-in page deletes the old build's stored app page `/` (only a page without
  `<meta name="lp-shell" content="events">`; this build's own stored page is kept), so the next open loads the new
  build from the network, and the new build's worker takes over without "Update ready". This holds only when the new
  sign-in page loaded: the old worker serves its own stored sign-in page when the network takes over 4 s or the phone is
  offline at that moment. That old page signs in to the new event (same body) and opens the old EDC screen, with the
  new cookie; it heals within one or two full relaunches on good signal. For a lead the old page goes to `/`, which the
  proxy redirects, so the old worker never offers an update: account menu → Sign out, then sign in on good signal. The
  old app refuses Update ready → Reload while anything waits to send or a draft is open. Nothing from the old screen
  lands: its create (`POST /api/requests` with no `X-LP-Event`) gets `422` "Not sent. This screen is out of date…",
  which the old app shows on the item as Not sent · needs attention; every other call with no header gets
  `409 wrong_event`, retried quietly. After the cut-over sign-in, open the app once on good signal until it has
  reloaded or Update ready is gone: until the new worker has installed, the old worker's cache holds the new page but
  not all its view chunks. A request left unsent in the old app is not shown by the new one (the new app keeps caches
  and queued items under the event's id). Jeffrey's pre-rework queue (`localStorage edc_pending_queue`) is no longer
  imported.
- **`X-LP-Event` (2a):** every client call names the event the tab works; a cookie of another event (signed in in
  another tab) answers `409 wrong_event` on event routes and the tab re-reads its session. No header at all answers the
  same (the log line has `dbCode: no_header`: the old build's app), except the create (`POST /api/requests`: `422`
  with the out-of-date message, so the old app stops retrying it) and the three routes whose calls cannot carry
  one, marked `headerless` (photo images, telemetry beacons, the service worker's push re-subscribe).
- **Telemetry (2a):** on while any event is in practice or live (the kill switch on `/health` still applies); no fixed
  off date.
- **Renamed teams (2a):** keep their earlier labels in `teams[].aliases` (server-maintained; sending them back is
  accepted and ignored).
- **Lead screens (2b):** work online only; the service worker caches `/` and `/signin`. Report fields (department,
  staffing, prepared by) are stored; the report itself is phase 4.
