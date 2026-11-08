# Observability: in-house telemetry and the Health page (design)

2026-11-08, ~01:00 ET. Brian, at 00:50, said session replays help "because like you catch users getting frustrated
with UI parts like the scrolling issue". He also said: "lets try to log everything so we can make actionabile
improvements", "observability would also only run ... until tomorrow night" and "that can just deploy and be pushed
ik its not something that should affect the UX at all".

Decisions already made with Brian:

- **In-house.** It lives in our own Supabase project (yrdwvenzktmcbspapdcy). There is no third-party SDK, no
  replay vendor, and nothing runs on Brian's Mac.
- **A desktop-only Health page** inside the app.
- **Vercel logs** stay the place for raw server logs.

The code was read at `origin/main` b657a49 (worktree `newreq-default`). This document is the whole build. Nothing in
it has been implemented yet.

---

## 0. At a glance

**What it is.** A small collector, about 9 KB gzipped, loads after the app is idle. It loads from the F4 host that is
already lazy (`components/activity/ActivityHost.tsx`), so it is never part of the first load. It watches what the app
already exposes and touches no first-load module:

- the store (`AppStore.subscribe`, `getState`, `actions.messages`, `actions.subscribeAlerts`);
- the DOM, through passive capture listeners and one `MutationObserver` on `<body>` children;
- network timing, through `PerformanceObserver` and a pass-through `fetch` observer;
- the service worker, through one new message.

It builds events made only of numbers, enums and ids. It keeps them in memory and in a 500-event IndexedDB ring in
its own database. It sends at most about once a minute, when the phone is idle, to `POST /api/telemetry`. That route
writes them through one RPC into new `lp_tel_*` tables. **`/health`** is a desk-only page that reads aggregates
through one more RPC.

**Hard rules, and how the design meets each one**

| Rule | How |
|---|---|
| Privacy: no screen text, no data | Controls are named only by `data-testid`, a CSS-module class or a role/tag (§1.3). The collector never reads `textContent`, `innerText`, `value`, `aria-label`, `title`, `alt`, `src` or `href`. A unit test enforces this with booby-trapped elements that throw on those reads. Staff are identified by **team key only**, and the server takes it from the session, never from the body. Requests are never identified: flows are timed on the device, and only durations leave it. |
| Zero UX impact | The first load is unchanged: the import site is in the F4 chunk, and **no first-load file is edited** (`first-load.spec.ts` is unchanged and must pass at ≤ 43,008 / ≤ 239,616 B). Every listener is passive, and every handler is O(1) and wrapped. DOM walks and detection run in idle time. There are no layout reads in handlers. Nothing is sent while a sync, outbox, message or photo request is in flight. |
| Network-safe | Events wait in a memory ring plus a 500-event IndexedDB ring (`lp-tel` database, separate from `lp-client`). A send happens when the phone is online, the page is visible and the app is idle, at most once every 60 s, and only once every 5 min when only aggregates are waiting. A hidden page sends with `sendBeacon`. Bodies are gzipped with `CompressionStream`. A failed send is retried at most twice, 5 min apart, and then dropped. |
| Supabase budget | Five new tables with RLS on and no policies, and no change to any existing table. A server cap per device per hour (3,000 events or 2 MB). A payload cap (48 KB on the wire, 256 KB inflated, 300 events). Batch dedupe. pg_cron `lp-tel-retention` deletes after 30 days. Auto-off at `2026-11-10 06:00 ET`. A kill switch row, cached for 30 s on the server; the client obeys the 204. |

**First-load and download cost**

| | Before | After |
|---|---|---|
| `/` route-only first-load JS (gzip) | ~43,006 B | unchanged (no first-load module edited) |
| `/` total first-load JS | ≤ 239,616 B | unchanged |
| F4 chunk (`components/activity/F4Parts`) | — | + ~0.5 KB (`use-telemetry.ts` and the gate) |
| New lazy chunk `lib/client/telemetry` | — | ≤ 9 KB gzip (precached by the SW at "Update ready", once) |
| `/health` route chunks | — | ~6–8 KB gzip (precached too, because `sw-manifest.json` lists every static file) |
| Requests per phone | ~600/h polling | + ≤ 60/h (typically 10–20/h) |

**Files**

| Kind | Path |
|---|---|
| SQL (new, additive, pasted alone) | `supabase/migrations/20261108000000_telemetry.sql` |
| Shared constants (pure, no zod) | `lib/telemetry.ts`: event names, prop keys, view enum, team keys, limits |
| Server | `lib/server/telemetry.ts` (config cache, body reader, zod, team key, server events); `app/api/telemetry/route.ts` (ingest); `app/api/telemetry/health/route.ts`; `app/api/telemetry/settings/route.ts` |
| Server touch | `lib/server/notify.ts`: one guarded `recordPushSend()` call after `lp_push_result`. `lib/activity.ts`: `pushPayload` adds `sentAt` (P1; see §8) |
| Client gate and hook (F4 chunk) | `lib/client/telemetry-gate.ts`, `components/activity/use-telemetry.ts`, plus one line in `ActivityHost.tsx` |
| Client collector (lazy chunk) | `lib/client/telemetry/{index,host,sanitize,crumbs,detect,flows,dom,net,errors,sw,buffer,send}.ts` |
| Service worker | `public/sw.js`: a push and click log in META, and an `lp-tel-take` message |
| Health page | `app/health/page.tsx`, `components/health/{HealthView,ProblemTable,PathTable,NetTable,PushPanel,CoverageTable,ErrorList,TrailDrawer}.tsx`, `components/health/health.module.css`; desk link in `components/desk/Nav.tsx` |
| Tests | `tests/unit/telemetry/*.test.ts`, `tests/unit/sw/telemetry-sw.test.ts`, `tests/unit/health/*.test.tsx`, `tests/integration/telemetry.test.ts`, `tests/e2e/telemetry.spec.ts`, `tests/e2e/health.spec.ts` |
| Docs | `HANDOFF.md` "Telemetry in production", `docs/BUILD_SPEC.md` amendment (A109–A116) |

---

## 1. Event taxonomy

### 1.1 Batch envelope (sent once per batch, not per event)

```jsonc
{
  "v": 1,
  "b": "k3j9x0q2m1ab",        // batch id, 12 base36: the server drops a repeat (beacon + later resend)
  "d": "a8f3k2q9w0e7r5t1",    // device id, 16 base36, random per install (localStorage 'lp-tel-device')
  "s": "q9w8e7r6t5",          // session id, 10 base36, random per page load
  "sent": 1762600000000,      // device epoch ms at send: the server corrects clock skew from it
  "ctx": {
    "plat": "ios",            // ios | android | mac | windows | linux | other   (UA, parsed on device; the UA is never sent)
    "osv": 18,                // OS major (iOS / Android), 0 when unknown
    "eng": "webkit",          // webkit | blink | gecko | other
    "sa": true,               // standalone (Home Screen app): display-mode standalone || navigator.standalone
    "lay": "phone",           // phone <768 | tablet 768–1023 | laptop 1024–1279 | desktop ≥1280 (components/desk/breakpoints.ts)
    "dpr": 3,                 // 1 | 2 | 3 (rounded, capped)
    "touch": true,            // maxTouchPoints > 0
    "build": "1x9k2a7c",      // the controlling SW's ?v= (lib/client/sw-client.ts build id), 'none' without one
    "eff": "na",              // navigator.connection.effectiveType, 'na' where absent (iOS)
    "mem": -1                 // navigator.deviceMemory, -1 where absent
  },
  "ev": [ /* events, §1.2 */ ]
}
```

The client never sends a team, name or staff string. The server derives `team` from `session.claims.team`: `Medical`
becomes `medical`, `GC/HX - Dispatch` becomes `dispatch`, `GC/HX - Base` becomes `base`, `GC/HX - Special
Operations/Med Transpo` becomes `transpo`, and anything else (custom team text included) becomes `other`.

### 1.2 Event fields (every event)

| Key | Type | Meaning |
|---|---|---|
| `n` | enum (§1.4) | event name |
| `at` | int | device epoch ms when it happened (the server adds the skew, clamped to [received − 2 days, received]) |
| `v` | enum | view: `all pending mine search new profile edit dashboard outbox unknown` (from `lib/client/nav.ts` `View['name']`) |
| `a` | token | area (§1.3), or a path pattern for network events |
| `c` | token | control (§1.3), or an error type or key name |
| `ms` | int 0…86,400,000 | duration |
| `k` | int 0…100,000 | count |
| `ok` | bool | yes or no (open/close, visible/hidden, outcome) |
| `p` | object | props: only keys from the `PROP_KEYS` enum in `lib/telemetry.ts`; values are an int, a bool, an enum token (`^[a-z0-9_.:-]{1,24}$`), or for `p.d` alone an int[] of up to 120 |
| `tr` | array | breadcrumb trail (§1.5), only on frustration and error events, up to 30 entries |

A **token** matches `^[a-z0-9/][a-z0-9_.:#/-]{0,63}$`. The client produces it, the zod schema checks it, and a SQL
CHECK backs both up. Spaces, capitals, `@`, digits runs (replaced by `#`) and non-ASCII characters cannot pass, which
by construction rules out names, phone numbers and message text.

### 1.3 Naming controls and areas (no text, ever)

All of this lives in `lib/client/telemetry/sanitize.ts` (pure), and all of it runs in idle time, never inside the
event handler.

- **`tok(s)`**: lowercase. UUIDs become `#` and runs of 2 or more digits become `#`. Characters outside
  `[a-z0-9_.:#/-]` are dropped. The result is cut at 48 characters and returns `null` unless it matches the token
  regex.
- **Class token**: only these forms are accepted:
  - Turbopack CSS modules `<file>-module__<hash>__<local>` become `<file>.<local>` (for example `list.row`);
  - webpack `<file>_<local>__<hash5>` becomes `<file>.<local>`;
  - global `lp-*` classes (`lp-rf-pchip`, `lp-toast`), except `lp-hit`;
  - Radix component classes `rt-<Component>` (for example `rt-button`; `rt-r-*`, `rt-variant-*` and other modifier
    classes are ignored).

  Any other class is ignored. A unit test reads real class names out of a production build's CSS, so a change in
  the hashing format fails CI.
- **Interactive element**: the closest ancestor within 8 levels matching `button, a[href], input, select, textarea,
  label, summary, [role=button|link|tab|menuitem|switch|checkbox|radio|option], [tabindex]:not([tabindex="-1"])`.
- **`ctl(target)`**, from the interactive element (or the target when there is none), taking the first that exists:
  1. `tok(el.dataset.testid)`;
  2. `tok()` of the closest `[data-testid]` at most 2 levels up;
  3. the first class token;
  4. `role` or the lowercase tag.

  Examples: `not-found-answer`, `composer-send`, `list.row`, `rt-iconbutton`, `button`.
- **`area(target)`**: the first ancestor whose `data-testid` is in `AREAS` (a curated list in `lib/telemetry.ts`:
  `request-list pending-board pending-column-# pending-section-# profile thread composer messages request-form
  alerts-sheet activity-sheet activity-panel activity-popover enroute-sheet location-form photo-viewer crop-frame
  desk-sidebar desk-rail desk-topbar desk-pane desk-table-view dashboard brand-card`), or `lp-toaster`, or the
  `data-testid` (else the class token) of an open `[role=dialog]` around it. Failing all of those, it is the first
  `data-testid` ancestor within 15 levels, or `page`. Areas stay few and stable, so they rank well.
- **Form fields** (only inside `[data-testid=request-form]`):
  - the field key is the suffix of the input's `id` after React's `useId` prefix (`«r3»-lastSeen` becomes
    `lastseen`), whitelisted against `FORM_FIELDS` (else `field`);
  - the section is the suffix of the enclosing `[role=group]`'s `aria-labelledby` id (`person`, `more`, `friend`),
    plus `post` (class `lp-rf-pchip`) and `photo` (`add-photo` or a photo slot).

  These are attribute ids, not labels. Values and lengths are never read.
- **Path pattern**: `URL.pathname` with UUIDs replaced by `:id` and the query dropped. `/api/sync` gets a mode from
  which query keys are present, never their values: `/api/sync:delta`, `:full`, `:reconcile`, `:page` or `:ids`.
  For example `/api/requests/:id/messages/:id/unsend`.
- **Never read**: `textContent`, `innerText`, `innerHTML`, `value`, `aria-label`, `aria-description`, `title`,
  `alt`, `placeholder`, `src`, `href`, toast titles and subtitles, the store's rows (only `createdAt`, `rowVersion`
  and the status key are read, for flows), and message bodies. `tests/unit/telemetry/privacy.test.ts` makes those
  properties throw.

### 1.4 Events

"Agg" means one row per key per flush: the counts are kept in memory and written when a batch is built. **F** marks a
frustration signal; those carry `tr`.

**Lifecycle and navigation**

| `n` | Fires when | Fields (`v a c ms k ok`) | `p` |
|---|---|---|---|
| `app_start` | the collector starts (once per page load) | `v`; `ms` = collector start − `timeOrigin` | `nav` (navigate, reload, back_forward, other), `cold` (no SW controller at load), `ttfb` `dcl` `load` `fcp` (ms, navigation and paint timing), `upd` (ms from the previous page's update_ready to this load, from localStorage `lp-tel-upd`, then cleared) |
| `view` | the view changes (fed by `useView()` in ActivityHost) | `v` = new; `ms` = dwell on the previous view | `from`, `lay`, `filter` (status, post or none, for `all`; the value is never sent), `pane` (desk: a request docked) |
| `sheet` | a dialog, sheet, menu or popover opens or closes (body `MutationObserver`, `[role=dialog|alertdialog|menu]`) | `a` = sheet id; `ok` true = open, false = close; `ms` = dwell on close | `role`, `how` on close: `x` (last tap was a close control), `swipe` (a touch gesture ended within 300 ms), `esc`, `backdrop` (last tap outside the content), `action` (other tap inside), `nav` (view changed), `unknown` |
| `vis` | `visibilitychange` | `v`; `ok` true = visible; `ms` = time in the previous state | — |
| `sw` | SW lifecycle | `ms` since app_start | `what`: `update_ready` (store `updateReady` false → true), `reload_tap` (tap on the update toast's action), `controller` (`controllerchange`), `offline_ready` (store `offlineReady`), `no_sw` |
| `device_state` | at start, then whenever a value changes (checked at each flush) | — | `perm` (default, granted, denied, unsupported), `notif` (system notifications supported, the same rule as `system-notify.ts` `notifyStateOf`), `push` (sub, none, unsupported, unk, from `pushManager.getSubscription()`, refreshed at most every 5 min), `newreq` (`prefs.bell`), `sa`, `badge` (`setAppBadge` in navigator) |

**Interaction**

| `n` | Fires when | Fields | `p` |
|---|---|---|---|
| `tap` (agg) | `pointerup` on a control (a click-length press, ≤ 10 px of movement) | `v a c`, `k` | `ptr` (touch, mouse, pen) |
| `swipe` (agg) | `touchend` after ≥ 30 px of movement, or a `wheel` burst (desk) | `v a`, `k` | `up` `down` `left` `right` (counts), `still` (no scroll followed, §1.6), `prev` (a touchmove had `defaultPrevented`), `input` (touch or wheel) |
| `key` (agg) | `keydown` **outside** text fields, whitelisted named keys only (`escape enter arrowup arrowdown j k n slash`) | `v`, `c` = key, `k` | — |
| `field` (agg) | `focusin` on a request-form field | `v`, `a` = section, `c` = field key, `k` | — |
| `img_fail` (agg) | an `<img>` fails to load (capture `error`) | `a` = `photo`, `thumb`, `icon`, `logo` or `other` (from the element's class token or testid; never the URL) | — |

**Frustration signals (F, each with `tr`)**

| `n` | Fires when (§1.6) | Fields | `p` |
|---|---|---|---|
| `stuck_scroll` | ≥ 3 swipes or wheel bursts with no scroll movement in the same area within 10 s | `v a`, `k` = still swipes | `dir` (the dominant direction), `edge` (top, bottom, mid, unk), `prev` (prevented count), `input`, `sheet` (a dialog was open), `kb` (keyboard probably open: `visualViewport.height < 0.75 × innerHeight`) |
| `rage_tap` | ≥ 3 `pointerdown`s within 1,000 ms, all within 30 px of the first | `v a c`, `k` = taps | `ptr`, `inter` (the target was interactive), `r` (max radius, px) |
| `dead_tap` | a tap on something that looks tappable but isn't, or a control that shows no response within 1 s, or a disabled control | `v a c` | `why`: `not_interactive`, `no_response` or `disabled`; `ptr` |
| `loop` | the same sheet or view is opened and closed within 2 s, twice within 20 s | `v`, `a` = sheet id or `view:<name>`, `k`, `ms` = the shortest dwell | — |
| `slow` | an `/api/*` request takes > 3 s, or a flow segment goes past its slow limit (§1.6) | `v`, `a` = pattern or flow name, `ms` | `what` (api, answer, submit, send, resume, open), `m`, `st`, `on`, `conn`, `eff` |
| `pinch` | a 2-finger `touchstart`, or WebKit `gesturestart`, deduped per 3 s | `v a` | `scale` (`visualViewport.scale × 100` at the end), `touches` |
| `error` | window `error` (script) or `unhandledrejection`; capture `error` on a `<script>` or `<link>` (a failed chunk) | `v`, `a` = source (`chunk:<file-hash8>`, `app`, `ext` for another origin, `unk`), `c` = type, `k` = repeats of this fingerprint in the flush | `type` (`typeerror referenceerror syntaxerror rangeerror chunkloaderror aborterror notallowederror quotaexceedederror securityerror other`), `kind` (error, rejection, resource), `line` `col` (top `/_next/static` frame), `fp` (8-char FNV-1a hash of type plus the top frame, **never the message**: V8 `JSON.parse` messages quote input text) |
| `stuck_send` | an outbox job or message job pending > 120 s while online and the connection is live | `v` | `q` (outbox, message), `depth`, `age` (s) |

**Flows (timed on the device; only durations leave it)**

| `n` | Start → end | `ms` | `p` |
|---|---|---|---|
| `flow_open` | `performance.timeOrigin` → the first `state.lastSyncLocalAt` of this page (read at once when the sync already happened before the collector loaded) | launch to fresh data | `out` (ok, offline when the connection is offline at 30 s, none), `cache` (yes when `hasData` was true before the first fresh sync, no, unk), `api` (ms from timeOrigin to the first `/api/sync` resource entry) |
| `flow_resume` | `vis` hidden → visible, then the next `lastSyncLocalAt` greater than the visible time | resume to fresh data | `out` (ok, fail when the connection goes offline or error first, none after 30 s), `away` (s hidden) |
| `flow_new` | the view becomes `new` → submit (a tap on `request-form-submit`, then a new outbox `mutationId` within 3 s) or abandon (the view leaves `new` without one) | start to submit or abandon | `out` (submit, abandon), `from`, `s_post` `s_person` `s_more` `s_friend` `s_photo` (dwell per section, from focus and tap times), `fields` (distinct fields focused), `photos` (photo taps), `inval` (submits followed by `.lp-rf-err` appearing; a DOM query only), `desk` |
| `flow_submit` | that `mutationId` appears in `state.outbox` → it leaves the outbox (the create, and its photos, done) | submit to server | `out` (ok, attention when `needs_attention`, discarded, unload), `tries` (`attempts`), `offline` (it waited while offline), `photos` (`job.photos.length`) |
| `flow_answer` | a new `state.pending` overlay (`Overlay.startedAt`) → that overlay removed | tap to server answer | `kind` (status, fields, cancel), `to` (status key from `STATUS_META`: `waiting in_medical not_found reunited cancelled closed_inactive …`, for status only), `out` (ok when `rowVersion` moved; failed when a red toast appeared in the same tick; conflict on amber; offline when the connection is offline), `queued` (ms from overlay start to the matching POST/PATCH start, fetch observer), `st` |
| `flow_msg` | a message or en route job appears in `actions.messages.getSnapshot().jobs` → it disappears after a 2xx (the observer saw the 201/200) | send to delivered | `q` (message, enroute), `out` (ok, failed when the job went to `failed`, discarded), `tries`, `offline` |
| `flow_read` | after `flow_msg` ok, that thread's `receipt.messageId` gets `readAt` (only while the thread is open and polled; that is "where the receipt shows it") | `readAt − message.createdAt`, **both server times** | `lag` (ms from `readAt` to this phone seeing it, skew-corrected) |
| `flow_push` | a notification click from the SW log (§4.7) → the next `view` to `profile` within 15 s | click to request shown | `src` (push, page), `kind`, `via` (`lp-open` when a window answered; `take-open` when a page took the pending click; `nav` when the worker navigated or opened a window), `cold` (click before `timeOrigin`), `out` (ok, not_shown) |
| `flow_alert` | a row from someone else appears in `state.confirmed` (not in `myIds`, after the first sync, `createdAt` within 15 min) → the first alert on this device: `subscribeAlerts` with `new_request` or `combined` within 2 s (toast), or a SW `push_rx` of kind `new_request` within ±60 s | alert moment − `createdAt`, server clock (skew from the ingest answer's `now`) | `route` (toast, push, off when `prefs.bell` is false, hidden when the page was hidden and no push came, none), `seen` (row arrival − `createdAt`), `vis`, `skew` (ok or unk) |

**Network, state, push and server**

| `n` | Fires when | Fields | `p` |
|---|---|---|---|
| `net` (agg, key = pattern + `m` + `st` + `on` + `conn`) | every `/api/*` request except `/api/telemetry` | `a` = pattern, `k` = count | `m` (get, post, patch, delete), `st` (`2xx 4xx 401 409 429 5xx net timeout abort unk`), `on` (`navigator.onLine` at start), `conn` (store `connection` at start: live, offline, error), `eff`, `d` (int[] of durations, first 120), `bytes` (sum of `transferSize`, on the 2xx row), `retry` (starts of the same pattern and method within 30 s of a failure) |
| `sync` (agg) | store `syncing` true → false | — | `ok` and `fail` (`lastSyncLocalAt` advanced or not), `full` (`/api/sync:full` count), `age` (s, the maximum data age seen while visible: now − `lastSyncLocalAt`, sampled at each store emit) |
| `link` | `online` / `offline` events, and store `connection` changes | `ok` = online or live; `ms` = time in the previous state | `what` (link, conn), `to` (online, offline, live, error) |
| `outbox` (agg) | each flush, only when anything was queued | — | `max`, `end`, `attn` (needs_attention), `mq` (max message jobs) |
| `vitals` | once: at the first hide or after 60 s | — | `fcp`, `lcp` and `cls`×1000 (Chromium), `inp` (Event Timing, ≥ 104 ms entries; Chromium), `lt` and `ltms` (long tasks, Chromium); absent keys when unsupported |
| `push_rx` | drained from the SW log: one per push received | `ms` = transit (`rx.at + skew − sentAt`; absent without `sentAt`) | `kind` (`ACTIVITY_KINDS` and `test`), `front` (a window took it in the app), `shown` (a notification shown), `silent` (WebKit silent show) |
| `notif_click` | drained from the SW log: one per notification click | `ms` = notification `timestamp` → click | `src`, `kind`, `via` |
| `push_send` (server) | `lib/server/notify.ts` `deliver()`, after `lp_push_result`, one row per team | `ms` = send duration | `kind`, `ok`, `gone`, `failed` (counts) |
| `tel_switch` (server) | the kill switch is flipped from `/health` | `ok` = enabled | — |

That is 37 names. `lib/telemetry.ts` holds `EVENT_NAMES`, `FRUSTRATION = [stuck_scroll, rage_tap, dead_tap, loop,
slow, pinch, error, stuck_send]`, `PROP_KEYS` and `VIEWS`. Both the client and the zod schema import them, and a
unit test checks this table against them.

### 1.5 Breadcrumb trail

The collector keeps a ring of the last 30 crumbs from **every** observed thing, aggregated kinds included. A
frustration or error event carries a copy as `tr: [[dt, code], ...]`, where `dt` is ms before the event (≤ 0) and
`code` is a token:

| Code | Meaning |
|---|---|
| `v>pending` | view |
| `s+alerts-sheet` / `s-alerts-sheet` | sheet open / close |
| `t:thread/bubble-mine` | tap (area/ctl) |
| `w:thread:u` | swipe up; `!` = no scroll followed, `^` = prevented (`w!:thread:u`) |
| `sc:thread` | a scroll burst |
| `k:escape` | key |
| `f:person/lastseen` | field focus |
| `n:/api/sync:delta:200:340` | request end (pattern:status:ms) |
| `x:offline` / `x:online` | link |
| `c:error` | store connection |
| `h` / `u` | hidden / visible |
| `toast:red:alert` | toast added (tone:icon, the store's enums; never its text) |
| `kb+` / `kb-` | keyboard |
| `z` | pinch |
| `e:typeerror` | error |

A trail is ≤ 30 × 64 B, and the server caps it at 4 KB.

### 1.6 Detector definitions (`lib/client/telemetry/detect.ts`, pure, clock injected)

**Swipe stillness.**

1. `touchstart` (passive, window) records x, y, t, the target and `touches.length`. Two or more touches is a pinch.
2. `touchmove` stores the last `touches[0].clientX/Y`, and ORs `defaultPrevented` into the swipe. The listener is in
   the bubble phase on window, so it runs after the app's own non-passive handlers: toast-swipe, sheet-swipe and
   react-remove-scroll.
3. `touchend` turns it into a swipe when the movement is ≥ 30 px.
4. A passive capture `scroll` listener on document only records `{t, target}`.
5. 400 ms after `touchend`, the swipe is **still** when no scroll event since its `touchstart` came from the document,
   or from an element that contains the touch target.
6. Swipes that started inside `.lp-toaster`, or on a sheet's handle or grabber (`[data-testid$=grabber]` or the
   sheet header class), are gestures, not scrolls: they never count.
7. For a still swipe, `edge` is computed once, in idle time: the nearest scrolled ancestor's `scrollTop ≤ 0` gives
   top, and `scrollTop + clientHeight ≥ scrollHeight − 1` gives bottom. That is the only layout read in the
   detector, it runs only for candidates, and it never runs in a handler.

Wheel works the same way: a burst is wheel events less than 150 ms apart, and it is still when no scroll event lands
within 300 ms.

**Stuck scroll.** ≥ 3 still swipes in the same `area` within 10 s fire one event, with a 30 s cooldown per area.
This is exactly the thread scroll trap in `request-page-ux-audit.md` #7 (`overscroll-behavior: contain` at the
thread's edge: no scroll anywhere).

**Rage tap.** A ring of `pointerdown` {t, x, y}. ≥ 3 within 1,000 ms whose distance from the first is ≤ 30 px fire
one event, and that cluster then stays silent for 2 s. Controls in `REPEAT_OK` (steppers, if any; the list starts
empty) are skipped.

**Dead tap.**

- **`not_interactive`**: the tap has no interactive ancestor, and the target (or an ancestor up to 3 levels) looks
  tappable. Its `data-testid` or class token matches
  `/(chip|card|row|badge|pill|tile|avatar|thumb|photo|glyph|icon|tab|link|btn|button)/`, or, on a mouse only, its
  computed `cursor` is `pointer`, read in idle time.
- **`disabled`**: the closest `button:disabled, [aria-disabled=true]` (from `pointerup`; disabled buttons send no
  click).
- **`no_response`**: for a button, link or role=button only (native inputs always respond), within 1 s of the tap:
  - no `view` change and no `location.href` change;
  - no `/api/*` request start;
  - no `sheet` open or close;
  - no `document.activeElement` change;
  - no store emit;
  - no mutation under the tap's area (a `MutationObserver` with childList and attributes on the area element,
    attached for 1 s and dropped at the first record).

  The live line's ticking text (`live-text`, `card-minutes`, `wait-badge`) is excluded. False "responses" are
  possible; false "dead" taps are rare, which is the safe direction.

**Loop.** On each close of a sheet or a profile view, a dwell under 2 s marks it quick. A second quick close of the
same id within 20 s fires `loop`.

**Slow limits.**

| Flow or request | Limit |
|---|---|
| `/api/*` | 3 s |
| `flow_answer` | 3 s |
| `flow_msg` | 5 s |
| `flow_submit` | 10 s (photos included) |
| `flow_resume` | 5 s |
| `flow_open` | 8 s |

Each slow item fires one `slow`, with a trail.

**Stuck send.** At each store emit, if `state.outbox` or the message jobs held an item continuously for > 120 s while
`navigator.onLine` was true and `connection` was live, one event fires per item.

**Timeout versus abort** (fetch observer). A rejection named `AbortError` is a `timeout` when the elapsed time is ≥
the path's client timeout − 250 ms, else an `abort`. The timeouts:

| Path | Timeout |
|---|---|
| `/api/sync` | 12 s (`SYNC.requestTimeoutMs`) |
| POST `/api/requests` | 15 s (`OUTBOX_CREATE_TIMEOUT_MS`) |
| `/photos` | 60 s |
| `/api/session` | 5 s |
| messages and en route | 10 s |
| everything else | 10 s (`MUTATION_TIMEOUT_MS`) |

---

## 2. Schema (`supabase/migrations/20261108000000_telemetry.sql`)

The file follows the rework file's conventions:

- the header says how to apply it (dry run with `rollback;`, then `commit;`);
- `begin;` with `set local lock_timeout = '5s'` and `statement_timeout = '60s'`;
- a preflight;
- numbered sections;
- idempotent statements;
- revokes, then explicit grants;
- `notify pgrst, 'reload schema'; commit;`.

It is **its own file** and is pasted alone. It does not re-run the 3,400-line rework file mid-event, and it touches
nothing in it. It needs only `public.lp_push_subscriptions` (read by the Health coverage query), and the preflight
checks that it exists.

```sql
-- 1. Settings: one row. The kill switch and the auto-off.
create table if not exists public.lp_tel_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  off_at timestamptz not null default timestamptz '2026-11-10 06:00:00-05',   -- Monday 06:00 ET (EST, after DST ended Nov 1)
  device_hour_cap integer not null default 3000 check (device_hour_cap between 0 and 100000),
  device_hour_bytes integer not null default 2097152 check (device_hour_bytes between 0 and 67108864),
  flush_seconds integer not null default 60 check (flush_seconds between 30 and 3600),
  sample numeric(3,2) not null default 1.00 check (sample between 0 and 1),      -- share of sessions that record tap/swipe/key/field aggregates
  updated_at timestamptz not null default now()
);
insert into public.lp_tel_settings (id) values (true) on conflict (id) do nothing;

-- 2. Events. One row per event (aggregates are already one row per key per flush).
create table if not exists public.lp_tel_events (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  device text not null check (device ~ '^[a-z0-9]{8,24}$' or device = 'server'),
  session text not null check (session ~ '^[a-z0-9]{6,24}$' or session = 'server'),
  team text not null check (team in ('medical','dispatch','base','transpo','other')),
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,23}$'),
  view text check (view ~ '^[a-z]{1,16}$'),
  area text check (area ~ '^[a-z0-9/][a-z0-9_.:#/-]{0,63}$'),
  ctl text check (ctl ~ '^[a-z0-9/][a-z0-9_.:#/-]{0,63}$'),
  ms integer check (ms between 0 and 86400000),
  n integer check (n between 0 and 100000),
  ok boolean,
  props jsonb check (props is null or (jsonb_typeof(props) = 'object' and octet_length(props::text) <= 4096)),
  trail jsonb check (trail is null or (jsonb_typeof(trail) = 'array' and octet_length(trail::text) <= 4096))
);
create index if not exists lp_tel_events_at_idx on public.lp_tel_events (at);
create index if not exists lp_tel_events_name_at_idx on public.lp_tel_events (name, at);
create index if not exists lp_tel_events_device_at_idx on public.lp_tel_events (device, at);

-- 3. Devices: the latest context per device (the Health page's platform / standalone / build split).
create table if not exists public.lp_tel_devices (
  device text primary key,
  team text not null,
  plat text, osv integer, eng text, sa boolean, lay text, dpr integer, touch boolean, build text, eff text, mem integer,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  last_session text
);
create index if not exists lp_tel_devices_last_seen_idx on public.lp_tel_devices (last_seen);

-- 4. Per device per hour quota, and batch dedupe.
create table if not exists public.lp_tel_quota (
  device text not null, hour timestamptz not null,
  events integer not null default 0, bytes integer not null default 0,
  primary key (device, hour)
);
create table if not exists public.lp_tel_batches (
  id text primary key check (id ~ '^[a-z0-9]{8,24}$'),
  device text not null,
  received_at timestamptz not null default now()
);

alter table public.lp_tel_settings enable row level security;
alter table public.lp_tel_events  enable row level security;
alter table public.lp_tel_devices enable row level security;
alter table public.lp_tel_quota   enable row level security;
alter table public.lp_tel_batches enable row level security;
-- No policies: browsers can never read them (like every lp_ table). Service role only.
revoke all on table public.lp_tel_settings, public.lp_tel_events, public.lp_tel_devices, public.lp_tel_quota,
  public.lp_tel_batches from public, anon, authenticated;
revoke all on sequence public.lp_tel_events_id_seq from public, anon, authenticated;
grant select, update on table public.lp_tel_settings to service_role;
grant select, insert, delete on table public.lp_tel_events to service_role;
grant select, insert, update, delete on table public.lp_tel_devices, public.lp_tel_quota, public.lp_tel_batches to service_role;
grant usage, select on sequence public.lp_tel_events_id_seq to service_role;
```

**5. Functions.** Every one has `set search_path = public, pg_temp`, `set statement_timeout` (4 s, except Health at
6 s and retention at 120 s) and `set lock_timeout = '2s'`. All are revoked from `public, anon, authenticated` and
granted to `service_role`. Every function name is dropped first, so a re-run is clean.

```sql
-- lp_tel_config(): what the route caches for 30 s.
--   → {on, until, cap, capBytes, flushSeconds, sample}
-- on = enabled and clock_timestamp() < off_at.

-- lp_tel_ingest(p_batch text, p_device text, p_session text, p_team text, p_skew_ms bigint,
--               p_ctx jsonb, p_events jsonb, p_bytes integer) → jsonb
create function public.lp_tel_ingest(p_batch text, p_device text, p_session text, p_team text, p_skew_ms bigint,
                                     p_ctx jsonb, p_events jsonb, p_bytes integer)
returns jsonb language plpgsql volatile security invoker
set search_path = public, pg_temp set statement_timeout = '4s' set lock_timeout = '2s'
as $fn$
declare
  v_set public.lp_tel_settings;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer := coalesce(pg_catalog.jsonb_array_length(p_events), 0);
  v_prev_events integer; v_prev_bytes integer; v_allowed integer; v_inserted integer;
begin
  select * into v_set from public.lp_tel_settings where id;
  if not found or not v_set.enabled or v_now >= v_set.off_at then
    return pg_catalog.jsonb_build_object('on', false);                         -- authoritative off (the route also caches it)
  end if;
  insert into public.lp_tel_batches (id, device) values (p_batch, p_device) on conflict do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('on', true, 'accepted', 0, 'dup', true);
  end if;
  insert into public.lp_tel_quota as q (device, hour, events, bytes)
       values (p_device, pg_catalog.date_trunc('hour', v_now), v_count, p_bytes)
  on conflict (device, hour) do update set events = q.events + excluded.events, bytes = q.bytes + excluded.bytes
  returning q.events - v_count, q.bytes - p_bytes into v_prev_events, v_prev_bytes;
  v_allowed := case when v_prev_bytes + p_bytes > v_set.device_hour_bytes then 0
                    else greatest(0, least(v_count, v_set.device_hour_cap - v_prev_events)) end;
  insert into public.lp_tel_events (at, device, session, team, name, view, area, ctl, ms, n, ok, props, trail)
  select least(v_now, greatest(v_now - interval '2 days',
               pg_catalog.to_timestamp(((x.e->>'at')::bigint + p_skew_ms) / 1000.0))),
         p_device, p_session, p_team, x.e->>'n', x.e->>'v', x.e->>'a', x.e->>'c',
         (x.e->>'ms')::integer, (x.e->>'k')::integer, (x.e->>'ok')::boolean, x.e->'p', x.e->'tr'
    from pg_catalog.jsonb_array_elements(p_events) with ordinality as x(e, i)
   where x.i <= v_allowed;
  get diagnostics v_inserted = row_count;
  insert into public.lp_tel_devices as d (device, team, plat, osv, eng, sa, lay, dpr, touch, build, eff, mem, last_session)
  values (p_device, p_team, p_ctx->>'plat', (p_ctx->>'osv')::integer, p_ctx->>'eng', (p_ctx->>'sa')::boolean,
          p_ctx->>'lay', (p_ctx->>'dpr')::integer, (p_ctx->>'touch')::boolean, p_ctx->>'build', p_ctx->>'eff',
          (p_ctx->>'mem')::integer, p_session)
  on conflict (device) do update set team = excluded.team, plat = excluded.plat, osv = excluded.osv, eng = excluded.eng,
     sa = excluded.sa, lay = excluded.lay, dpr = excluded.dpr, touch = excluded.touch, build = excluded.build,
     eff = excluded.eff, mem = excluded.mem, last_seen = v_now, last_session = excluded.last_session;
  return pg_catalog.jsonb_build_object('on', true, 'accepted', v_inserted, 'dropped', v_count - v_inserted,
                                       'capped', v_inserted < v_count);
end
$fn$;

-- lp_tel_server_events(p_rows jsonb) → integer: server-side rows (device = session = 'server'),
-- gated by the same settings check. p_rows = [{n, team, ms, k, ok, p}], ≤ 20.

-- lp_tel_set(p_enabled boolean, p_off_at timestamptz default null) → jsonb (lp_tel_config()):
-- the kill switch, from /health.

-- lp_tel_retention() → integer. SECURITY DEFINER, for pg_cron:
--   delete from lp_tel_events  where at < now() - interval '30 days';
--   delete from lp_tel_quota   where hour < now() - interval '2 days';
--   delete from lp_tel_batches where received_at < now() - interval '2 days';
--   delete from lp_tel_devices where last_seen < now() - interval '30 days';

-- lp_tel_health(p_section text, p_since timestamptz, p_limit integer default 50) → jsonb (section 6 below).
```

**6. pg_cron.** The `do $cron$` block mirrors `lp-close-inactive`: it enables pg_cron where it can, unschedules any
job of the same name, schedules exactly one job, and raises a NOTICE either way.

```sql
perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lp-tel-retention';
perform cron.schedule('lp-tel-retention', '17 9 * * *', 'select public.lp_tel_retention()');   -- 04:17 ET daily
```

**Caps and auto-off: where they apply**

| Limit | Client | Route | SQL |
|---|---|---|---|
| Auto-off `off_at` | stops collecting at `until` (cached from the last answer; default `Date.UTC(2026,10,10,11)`); the gate refuses to even load the chunk after it | 204 from the cached config | `lp_tel_ingest` returns `{on:false}`, nothing is written |
| Kill switch `enabled = false` | a 204 detaches everything and sets `lp-tel-off` (probe again in 30 min) | 204 within ≤ 30 s (per instance) | the same authoritative check |
| Per device per hour | pauses until the next hour on `capped` | — | `lp_tel_quota` upsert: events ≤ 3,000, bytes ≤ 2 MB |
| Payload | batches of ≤ 300 events and ≤ 48 KB | 413 when the wire body is > 48 KB or the inflated body is > 256 KB; 422 for a bad envelope; bad single events are dropped and counted | CHECKs on every column, and props and trail ≤ 4 KB |
| Retention | IndexedDB drops events older than 24 h | — | `lp-tel-retention` deletes after 30 days |

**Volume estimate.** About 40 devices. Discrete events come to about 60 per hour per device. Aggregates, at one row
per key per 5-minute flush, add about 150. That is about 210 rows per device-hour, or 8.4k/h in total, and about
250k rows for the ~30 h until auto-off. At about 300 B a row plus indexes, that is **~150 MB**, against the Pro
plan's 8 GB. The worst case allowed by the cap is 3,000 × 40 = 120k rows/h.

---

## 3. Ingest API

### `POST /api/telemetry` (`app/api/telemetry/route.ts`)

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// refresh: false: never re-issue the session cookie (a late telemetry answer must not bring a signed-out cookie
// back; the store aborts its own requests at sign-out for the same reason, store-core.ts `call`).
export const POST = authedRoute('POST /api/telemetry', { refresh: false }, async ({ request, session }) => {
  const cfg = await telemetryConfig();                    // lp_tel_config(), cached 30 s per instance; any error → off
  if (!cfg.on) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const { bytes, text } = await readTelemetryBody(request); // ≤ 48 KB wire; gzip inflated with maxOutputLength 256 KB
  const batch = parseBatch(text);                         // zod envelope → 422; per-event safeParse, bad ones dropped
  const skew = clampSkew(Date.now() - batch.sent);        // 0 when |skew| < 1.5 s; clamped to ±24 h
  const res = await rpc<IngestResult>('lp_tel_ingest', {
    p_batch: batch.b, p_device: batch.d, p_session: batch.s, p_team: teamKey(session.claims.team),
    p_skew_ms: skew, p_ctx: batch.ctx, p_events: batch.ev, p_bytes: bytes,
  });
  if (res.on === false) { invalidateTelemetryConfig(); return new Response(null, { status: 204 }); }
  return json({ on: true, until: cfg.until, flushSeconds: cfg.flushSeconds, sample: cfg.sample,
                now: Date.now(), rejected: batch.rejected, ...(res.capped ? { capped: true } : {}) });
});
```

- **Auth.** A signed-in session (`authedRoute`). Without one the answer is 401, and the client drops the batch and
  pauses until the store's session is active again. The same-origin check is the default for POST. `sendBeacon`
  sends `Origin` and cookies on same-origin POSTs.
- **Body.** Three content types are accepted:
  - `application/x-lp-tel+gzip` (`fetch`, `CompressionStream`);
  - `application/json` (`fetch` without `CompressionStream`);
  - `text/plain;charset=UTF-8` (`sendBeacon` with a string).

  There is no `Content-Encoding` header: Next.js and Vercel would treat one specially. `readTelemetryBody` reuses
  `readBodyLimited` (lib/server/http.ts) with a 48 KB limit, then `zlib.gunzipSync(buf, { maxOutputLength: 262144 })`.
  A `RangeError` from that becomes 413 `too_large`, which stops a gzip bomb.
- **Validation** (zod, `lib/server/telemetry.ts`):
  - **Envelope**: `v === 1`; `b`, `d` and `s` match their regexes; `sent` is an int; `ctx` uses the enums in §1.1;
    `ev` is an array of 1–300 (0 only with `probe: 1`, the off-probe of §4.4, which writes no events).
  - **Per event**: `n` in `EVENT_NAMES`, minus the server-only `push_send` and `tel_switch`; `at` within
    [sent − 24 h, sent + 60 s]; `v` in `VIEWS`; `a` and `c` match the token regex; `ms` and `k` are ranged ints;
    `p` uses `PROP_KEYS` with ≤ 24 keys and typed values; `tr` holds ≤ 30 pairs of [int ≤ 0, token]; `tr` is
    accepted only when `n ∈ FRUSTRATION`.

  A failure in the envelope is 422. A failure in an event drops that event, which is counted in `rejected`, so one
  bad event never loses a batch.
- **Caps.** The RPC enforces the per-device-hour event and byte caps atomically (the quota upsert) and dedupes on the
  batch id.
- **Answers.**
  - `200 {on: true, until, flushSeconds, sample, now, rejected, capped?}`. The client uses `now` to estimate its clock
    skew for `flow_alert` and `flow_read` lag.
  - `204`: off (the kill switch, past `off_at`, settings that can't be read, or a missing table).
  - `401`, `403`, `413`, `422`, `503` (the wrapper; logged by `logRequest` with route, status and timing only).
- **The order of the checks is cheap first**: origin, session, cached config, body, RPC. When off, the body is never
  read and no database call is made, as long as the config is cached.

### `POST /api/telemetry/settings` (kill switch from /health)

`{enabled: boolean}` calls `lp_tel_set`, then `invalidateTelemetryConfig()`, then records a `tel_switch` server event
(team only). It answers with `lp_tel_config()`. Every signed-in session can use it; that is the same trust as reading
/health. The SQL path in §7 stays authoritative.

### `GET /api/telemetry/health?window=1h|3h|12h|all`

It calls `lp_tel_health(section, since)` for `kpis, problems, examples, flows, net, push, coverage, errors` **in
parallel**, so a slow or failing section returns `null` and its panel shows "—" while the others render. The answer
is `{generatedAt, window, config, kpis, problems, examples, flows, net, push, coverage, errors}`, ≤ ~40 KB with
`Cache-Control: no-store`. `all` means the last 30 days (whatever retention has kept).

### Server-side push events (`lib/server/notify.ts`)

After `await rpc('lp_push_result', ...)` in `deliver()`:

```ts
await recordPushSend(event.kind, targets, outcomes, sendMs);
```

It groups the outcomes by `teamKey(parseStaff(target.staff).team)` into at most 5 rows of `{n: 'push_send', team,
ms, p: {kind, ok, gone, failed}}`, and makes one `lp_tel_server_events` RPC. It is gated by the cached config,
wrapped in try/catch, and already runs after the response (`after()`), so it can never delay a request or throw.

---

## 4. Client collector

### 4.1 Lazy load point: never on the first load

```
app/app-shell.tsx  ShellHosts → <ActivityHost/>          (next/dynamic through ShellDialogs → activity/slots → F4Parts: lazy)
  components/activity/ActivityHost.tsx
    + useTelemetry(store, view)                          components/activity/use-telemetry.ts  (F4 chunk, ~0.4 KB)
        telemetryAllowed()                               lib/client/telemetry-gate.ts          (F4 chunk, ~0.1 KB)
        → after idle (requestIdleCallback {timeout: 5000}, or setTimeout 3000 on Safari, which has no rIC)
        → import('@/lib/client/telemetry')               its own chunk (≤ 9 KB gzip), precached with the build
             → startTelemetry(browserTelemetryHost(store, getView)) → { view(name, extra), stop() }
```

- `useTelemetry` keeps the latest `{name, filter, pane}` in a ref, so the collector reads the current view the moment
  it starts. A `useEffect` on `view.name` calls `handle.view(...)`. Unmount calls `stop()`.
- **The gate** returns false when any of these holds:
  - `Date.now() ≥ until`: localStorage `lp-tel-until` from the last answer, else `Date.UTC(2026, 10, 10, 11, 0, 0)`;
  - `lp-tel-off` > now (the server said off; this is when it may probe again);
  - `navigator.webdriver` is true while `localStorage['lp-tel-test'] !== '1'` (e2e specs stay quiet unless they opt
    in);
  - localStorage can't be read.

  Every read is in try/catch.
- The chunk is a next/dynamic-style `import()` from a lazy chunk. A failed load (a dropped chunk on festival Wi-Fi)
  is not retried this page load. Nothing depends on it.
- **No first-load file changes.** It does not touch `store-core.ts`, `store-contract.ts`, `nav.ts`, `http.ts`,
  `sw-client.ts` or `app-shell.tsx`. The collector imports types and pure helpers from first-load modules
  (`STATUS_META`, `layoutFor`); the bundler references those, it doesn't copy them.

### 4.2 Observers (all passive; every handler wrapped)

```ts
// lib/client/telemetry/host.ts
const on = (target: EventTarget, type: string, fn: (e: Event) => void, opts: AddEventListenerOptions = {}) => {
  const h = (e: Event) => { if (!alive) return; try { fn(e); } catch { fault(); } };
  target.addEventListener(type, h, { passive: true, capture: true, ...opts });
  offs.push(() => target.removeEventListener(type, h, { capture: opts.capture ?? true }));
};
// fault(): counts internal errors; the 20th calls stop() for this page load. Nothing is rethrown.
```

| Source | How | What the handler does (O(1)) |
|---|---|---|
| Store | `store.subscribe(fn)` plus `store.getState()` | diffs `{view-independent: connection, syncing, lastSyncLocalAt, outbox (ids, states, attempts), pending (ids, kind, startedAt), confirmed size + new ids since last emit (Map key diff only when size or the ref changed), toasts (ids, tone, icon), updateReady, offlineReady, session.status, prefs.bell}` and queues flow and state events |
| Messages | `store.actions.messages?.subscribe` (it arrives lazily: checked at each flush until present) | diffs job ids and states, and thread receipts for threads with a pending read watch |
| Alerts | `store.actions.subscribeAlerts(fn)` | records `{kind, at}` (fires only for in-app toast alerts, store-core `showAlertToast`) |
| View | `handle.view()` from the hook | `view` event, dwell, flow_new start and end, loop check |
| Pointer | `pointerdown` and `pointerup` on document (capture) | pushes `{type, t, x, y, target, pointerType}` onto `pending` and schedules `process()` |
| Touch and wheel | `touchstart`, `touchmove`, `touchend` and `wheel` on window (bubble, passive) | stores coordinates, ORs `defaultPrevented`, `touches.length`; no reads |
| Scroll | `scroll` on document (capture, passive) | `lastScroll = {t, target}` and a burst counter |
| Keys and focus | `keydown` and `focusin` on document (capture) | keydown: drops it when the target is a text field (`input, textarea, [contenteditable]`), else queues the whitelisted `e.key`; focusin: queues the target |
| Dialogs | `MutationObserver(body, {childList: true})` | for each added or removed node: `querySelector('[role=dialog],[role=alertdialog],[role=menu]')` on that node only, which queues sheet open or close |
| Visibility | `visibilitychange`, `pagehide`, `online`, `offline` | `vis` and `link` events; the hidden flush (§4.4) |
| Errors | `error` on window (capture: scripts **and** resource errors), `unhandledrejection` | queues `{type, file, line, col}` (§1.4) |
| Fetch | pass-through observer (§4.3) | `inflight++`, start time, pattern |
| Timing | `PerformanceObserver` for `resource` (buffered), `paint`, `largest-contentful-paint`, `layout-shift`, `event` (durationThreshold 104), `longtask`, each in try/catch (unsupported types are skipped) | `/api/*` bytes and early `/api/sync` timings; the `vitals` numbers. Never calls `clearResourceTimings()` or changes the buffer size: `sw-client.ts collectAssetUrls()` reads the same buffer for the offline precache |
| SW | `controllerchange`; `lp-tel-take` drain on start and on each visible (§4.7) | `sw` events, `push_rx`, `notif_click`, `flow_push` correlation |

`process()` runs once per idle slot (`requestIdleCallback`, or `setTimeout(…, 250)`), never in the handler. It drains
`pending`:

- resolves `ctl` and `area` (attribute reads only);
- runs the detectors;
- updates the aggregates and the crumb ring;
- performs the few deferred reads: `cursor` for mouse taps on non-interactive targets, and `scrollTop` for still
  swipes.

There is no `getBoundingClientRect`, no `offset*` and no forced layout anywhere else.

### 4.3 Network: resource timing plus a pass-through fetch observer

Resource timing (`PerformanceObserver({type: 'resource', buffered: true})`) gives the duration and `transferSize` for
every `/api/*` entry, and `responseStatus` where the engine has it (it is feature-detected). It cannot report a
status on engines without `responseStatus`, and failed or aborted fetches produce no entry on WebKit. WebKit is
mostly what the staff use. So the collector **also** observes `window.fetch`, which every store request goes through
at call time (`store-core.ts browserEnv: fetch: (input, init) => window.fetch(input, init)`; the F4 and F3 clients
use the store's `call`):

```ts
// lib/client/telemetry/net.ts
const native = window.fetch;
const bound = native.bind(window);
const observed: typeof fetch = (input, init) => {
  const promise = bound(input, init);              // the app's request starts first, unchanged
  try { watch(input, init, promise); } catch { fault(); }
  return promise;                                  // the SAME promise object: no wrapping, no delay, no extra await
};
window.fetch = observed;
// stop(): if (window.fetch === observed) window.fetch = native;
```

`watch()` only acts on same-origin `/api/` paths, and never on `/api/telemetry`. It reads the URL from a string,
`URL` or `Request.url`, and the method from `init` or the `Request`. It never reads a body or headers. It attaches
`promise.then(onResponse, onError)`: `res.status`, `redirected`, 511 and 0 count as `net`, as in http.ts, and an
`AbortError` becomes timeout or abort (§1.6). It keeps an `inflight` counter that the sender checks. The response
body is never touched (no `clone()`).

The resource entries add `bytes` and cover the first `/api/sync` calls, made before the collector loaded, for
`flow_open.api`. The observer is the `cfg.fetchObs` knob, on by default. With it off, only resource timing is used,
and status and timeouts become `unk` on WebKit. Unit tests check promise identity, an untouched rejection, and that a
throwing recorder changes nothing.

### 4.4 Buffering, idle send, compression

- **Memory ring.** 500 discrete events (the oldest are dropped). Aggregates (tap, swipe, key, field, net, sync,
  outbox, img_fail) live in maps and become events only when a batch is built.
- **IndexedDB ring.** `idb-keyval` `createStore('lp-tel', 'q')` is a **separate database** from `lp-client`, so its
  transactions never queue behind the store's readwrite transactions. Each value is one built batch `{b, ev, tries}`
  keyed by `b`. When the stored events pass 500, the oldest batches are deleted. Batches older than 24 h are dropped
  at load. The collector writes only when the page hides, and when a send fails. On start it loads the stored
  batches and sends them first (each keeps its batch id, so a beacon that did land is deduped).
- **Session change.** When `session.status` leaves `active`, or the staff changes (store `generation` or
  `session.staff` changes), the memory ring, the aggregates and the IndexedDB store are cleared. Events from one
  team are never sent under another's cookie.
- **When to send** (`send.ts`). It is evaluated after each store emit in which `syncing` went false, plus a 30 s
  check timer while visible. It sends when **all** of these hold:
  - visible, `navigator.onLine`, and `state.connection === 'live'`;
  - `session.status === 'active'`;
  - not `state.syncing`;
  - no outbox job `sending`;
  - no message job `sending`;
  - `inflight === 0`, which covers photo uploads too;
  - no tap in the last 1.5 s;
  - ≥ `flushSeconds` (60 s) since the last send when discrete events are waiting, or ≥ 300 s when only aggregates
    are;
  - not capped or off.

  Then it waits for `requestIdleCallback` (`{timeout: 2000}`), or `setTimeout(0)` where rIC is missing. The best
  moment is about 0.5–1 s after a sync finished: the radio is already awake, and the next poll is about 5 s away.
- **Request.** A batch holds ≤ 300 events and ≤ 48 KB of JSON (the rest waits for the next send). The body is
  `gzip` through `new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()`
  when `CompressionStream` exists (Safari 16.4+, Chrome 80+), and the plain JSON otherwise. The call is
  `bound('/api/telemetry', {method: 'POST', body, headers: {'Content-Type': ...}, credentials: 'same-origin',
  cache: 'no-store', keepalive: false, priority: 'low', signal})` with an 8 s abort. It never goes through the
  store's `call` and adds nothing to any app request.
- **Answers.**
  - **200**: drop the batch; store `until` (`lp-tel-until`); apply `flushSeconds` and `sample`; update the clock
    skew from `now`; on `capped`, pause until the next hour.
  - **204**: stop everything (detach listeners, restore `fetch`, clear the buffers), set `lp-tel-off = now + 30 min`.
    After that the gate lets the next app start through, and the collector sends one **empty probe** (`ev: []`
    allowed only with `probe: 1`) before attaching any listener.
  - **401 or 403**: drop the batch, pause until the session is active.
  - **413 or 422**: drop the batch.
  - **5xx, network or timeout**: keep it (`tries + 1`, in IndexedDB), and don't try again for 5 min. After 3 tries
    it is dropped.
- **Hidden page** (`visibilitychange` → hidden; `pagehide` as a backup, because the iPhone Home Screen app often
  never fires `pagehide`):
  1. build the batch from everything waiting;
  2. write it to IndexedDB;
  3. `navigator.sendBeacon('/api/telemetry', jsonString)` (uncompressed, because there is no time for async
     compression; ≤ 48 KB, else IndexedDB only).

  When the beacon is queued, the IndexedDB copy stays: it is resent at the next start, and the server dedupes it.
  There is no network on hide unless the device is online (`navigator.onLine`).

### 4.5 Sampling knobs and kill switch

| Knob | Where | Default | Effect |
|---|---|---|---|
| `enabled` | `lp_tel_settings` | true | false gives 204 everywhere; clients stop and probe every 30 min |
| `off_at` | `lp_tel_settings` | 2026-11-10 06:00 ET | after it: 204, and clients stop at their cached `until` |
| `sample` | settings (sent in each 200) | 1.00 | per session: `Math.random() < sample` keeps tap, swipe, key and field aggregates; frustration, errors, flows, net, state and push are always kept |
| `flush_seconds` | settings | 60 | the minimum spacing for discrete events (aggregates: 5 × this) |
| `device_hour_cap` / `device_hour_bytes` | settings | 3000 / 2 MB | server cap |
| `fetchObs` | `lib/telemetry.ts` constant | on | §4.3 |
| `TRAIL_LEN`, `MEM_CAP`, `IDB_CAP`, `MAX_BATCH`, `BACKOFF_MS`, `MAX_TRIES` | constants | 30, 500, 500, 300 events or 48 KB, 300,000, 3 | — |

### 4.6 Device id, session id, team

- **Device id**: 16 random base36 characters from `crypto.getRandomValues`, in localStorage `lp-tel-device`, created
  on first start. On an iPhone, the Home Screen app's storage is separate from Safari's, so it is per install.
- **Session id**: 10 random base36 characters per page load, in memory.
- **Team**: from the server session only. The client never sends the staff name.

### 4.7 Service worker additions (`public/sw.js`)

The SW is a static file, so this costs nothing on the first load. A new build has a new `?v=`, so it installs like
any update.

- **Push log.** In `handlePush`, **after** the notification is shown (or the decision not to show one), the SW calls
  `telLog({e: 'rx', k: data.kind, at: Date.now(), sent: raw.sentAt|null, fr: front, sh: shown, si: silent})`.
- **Click log.** In the `notificationclick` path, at the **end** of `handleClick`, after focus, lp-open, navigate or
  openWindow, so it never costs the click its user activation, the SW calls `telLog({e: 'click', k:
  data.kind|null, ps: data.push === true, at, age: Date.now() − notification.timestamp, via})`. `via` is `lp-open`
  when `openFromNotification` returned true, `take-open` when `kept && await pendingTaken(open)`, and `nav`
  otherwise. This reads values that already exist; the control flow does not change.
- **`telLog`.** It appends to META `/__lp/tel` (JSON array) through the existing `pendingStep`-style queue. It holds
  at most 100 entries, drops entries older than 24 h, and swallows every error, so a failed log can never stop a
  notification.
- **The `lp-tel-take` message.** It replies `{entries}` on the port and clears the log. An older worker never
  answers; the collector times out after 3 s and moves on.
- **`sentAt`** (P1). `lib/activity.ts pushPayload` adds `sentAt: Date.now()` (8 bytes of a 3,000-byte budget), and
  `pushData` in sw.js keeps `raw.sentAt` when it is a number. The collector computes the transit as `rx.at + skew −
  sentAt`. This is the only change to an existing payload. It is not a client request, and it can be dropped
  without losing anything else (transit is then left out).

---

## 5. Health page (desktop only)

### 5.1 Route and access

- **`app/health/page.tsx`** is a server component. It runs `await connection()`, then verifies the `lp_session`
  cookie with `verifySessionToken` (the same check as proxy.ts). Without a valid session it runs
  `redirect('/signin?next=/health')`, which `safeNextPath` accepts. Otherwise it renders `<HealthView />`, a client
  component. It is a **separate route**, so `/`'s bundle and first load are untouched and the store does not start
  there (no sync loop).
- **Desktop only.** Under 768 px it renders an `EmptyState` with a `Monitor` icon and the label "Desktop only". From
  768 px it shows the dashboard.
- **Who can see it.** Any signed-in session can view it and flip the switch. The data is non-PII by construction.
- **The link** sits in the desk sidebar under Dashboard, as a lucide `Activity` icon and "Health". The rail has the
  icon with a `Tip`. It is a plain `<a href="/health">`, not a `ViewLink`. It shows only on devices where
  localStorage `lp-health === '1'`, which `/health` sets on its first visit. Brian types `/health` once on his
  laptop, and floor staff never see it. This lives in `components/desk/Nav.tsx`, which is in the desk chunk, not
  the first load.
- **Loading and refresh.** Data loads on mount and on **Refresh** only, with **no polling**. Refresh disables itself
  while loading.

### 5.2 Layout (Radix Themes, lucide; values first, no helper sentences)

```
┌ Health ────────────────────────────── [1 h | 3 h | 12 h | All]   ⟳  3:42 PM     ● Collecting  Mon 6:00 AM  (switch) ┐
│  38            412 ↑            17             9            98.6 %          71 %          3.1 s                     │
│  devices       frustrations     devices hit    errors       syncs ok        pushes opened  open → fresh p95          │
├─ Problem spots ─────────────────────────────────────────────┬─ Critical paths ─────────────────────────────────────┤
│ ↕ Stuck scroll  profile › thread              41   12 ▮▮▮  │ Open → fresh data        212   1.2 s   3.1 s ▬▬▬▬ ✓   │
│ ✶ Rage tap      pending › check-card          17    9      │ Resume → fresh data      840   0.6 s   2.4 s ▬▬▬  ✓   │
│ ⊘ Dead tap      profile › audit-item          12    7      │ New request → submit      31  48 s    2.6 m   ·  ⧉ 6   │
│ ↻ Loop          alerts-sheet                   6    5      │ Submit → server           31   0.9 s   6.8 s ▬▬▬▬▬ ↑ │
│ ⧗ Slow          /api/sync:delta               54   22      │ Answer → server          188   0.4 s   2.9 s ▬▬▬  ✓   │
│ ⚠ Error         chunk:3fa2c1d0 · typeerror      3    2      │ Message → delivered       96   0.5 s   4.1 s ▬▬▬▬ ↑  │
│   chips: Medical Dispatch  ·  2 m  ·  [⋯ trail]            │ Delivered → read          41  38 s    4.0 m        │
│                                                             │ Push open → shown         27   0.8 s   2.2 s ▬▬   ✓  │
│                                                             │ New request → alert       64   4.1 s  11 s  ▬▬▬  ✓   │
├─ Requests ─────────────────────────┬─ Push ─────────────────┼─ Alert coverage ─────────────────────────────────────┤
│ /api/sync:delta  GET  9,812  0.4 % │ new_request 120 ✓112 … │ Medical   14  ▣ 12  🔔 11  ⇪ 12  ● 13  4.0 s         │
│   live 0.1 % · offline 31 %  p95   │  rx 96  open 41 (43 %) │ Dispatch   6  ▣  6  🔔  5  ⇪  6  ● 6   5.2 s         │
│ POST /api/requests/:id/status …    │ message …              │ …                                                     │
├─ Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 3:41 PM  ⚠ typeerror  chunk:3fa2c1d0:1:48211   profile   Medical   ×3  2 dev                                       │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Grid.** Two columns from 1280 px, one from 768–1279 px. Cards use `Radix Card`. Each panel heading is a label
  only ("Problem spots", "Critical paths", "Requests", "Push", "Alert coverage", "Errors"), with no captions under
  them.
- **KPI row.** Large numerals (`Text size="7"`) with a small gray label under each. A trend glyph (↑ ↓) compares
  against the previous window of the same length, coloured and paired with the glyph.
- **Problem spots.** Rows are sorted by distinct devices, then by count.
  - The left chip has the signal glyph and colour: `MoveVertical` stuck scroll, `Zap` rage tap, `Ban` dead tap,
    `Repeat` loop, `Hourglass` slow, `ZoomIn` pinch, `TriangleAlert` error, `CloudOff` stuck send. Each is paired
    with its short label.
  - Then `view › area · ctl` in mono, count, devices with a mini bar, team chips, the last time (relative), and a
    `⋯` that opens the **Trail drawer**.
  - The **Trail drawer** is a Radix `Dialog` styled as a right sheet. It shows a vertical timeline of the example's
    crumbs:
    - the time in mono (`−12.4 s`);
    - a glyph per crumb kind: `Eye` view, `Hand` tap, `MoveVertical` swipe, `Layers` sheet, `Cloud` network,
      `Wifi`/`WifiOff` link, `Bell` toast, `Keyboard`;
    - the code tokens.

    The event itself is the last row, highlighted. Up to 3 examples per problem can be stepped through with ‹ ›.
- **Critical paths.** Each row shows n, p50, p95 and a p95 bar against the path's target, coloured and paired with
  `✓` (≤ target), `↑` (≤ 2×) or `↑↑` (> 2×). Outcome splits are small chips (`submit 25 · abandon 6`).

  | Path | Target |
  |---|---|
  | Open → fresh data | 3 s |
  | Resume → fresh data | 2 s |
  | Submit → server | 5 s |
  | Answer → server | 2 s |
  | Message → delivered | 3 s |
  | Push open → shown | 3 s |
  | New request → alert | 15 s (the poll interval of 6 s plus jitter plus a resume) |

- **Requests.** One row per endpoint and method: n, failure rate (`5xx + net + timeout` over n; 4xx shown apart),
  p50 and p95. Under it, split chips by network state (`live`, `error`, `offline`, `link down` = `on:false`). There
  is a timeout count, and a sync line: ok %, full fetches, p95 data age.
- **Push.** Per kind: server `ok / gone / failed` (`push_send`), device received (`push_rx`), shown, opened
  (`notif_click` with `src=push`), open rate = opened / received, and transit p50/p95. Devices drain the SW log only
  when the app opens, so "received" undercounts until then. A `·` chip next to it marks "so far" visually.
- **Alert coverage by team.** One row per team key.
  - **Device columns** (latest `device_state` per device seen in the window): active devices, Home Screen (`⇪`),
    notifications granted (`🔔`, using the lucide `Bell` glyph, not an emoji), push subscribed (`▣`), and New
    requests on (`●`).
  - **Server truth** (`lp_push_subscriptions` grouped by team key, `new_requests`): a subscriptions count chip.
  - **Alerts** (`flow_alert` by team): p50 latency and the share alerted within 30 s, coloured with a glyph.
- **Errors.** The most recent first: time, type chip, source (`chunk:<hash>:line:col`), view, team chip, × count by
  fingerprint, and devices.
- **Header controls.**
  - a `SegmentedControl` for the window;
  - a `IconButton` (`RefreshCw`) with "3:42 PM" beside it (when it was generated);
  - a status chip (`● Collecting · until Mon 6:00 AM`, or `○ Off`);
  - a Radix `Switch` that flips `enabled` through `POST /api/telemetry/settings`, behind an `AlertDialog` that asks
    "Turn off collection?" with the actions Cancel and Turn off.
- **Accessibility.** Tables are real `<table>`s. Every chip and bar has a full-sentence `aria-label`, for example
  "Stuck scroll in the thread on the request page: 41 times on 12 devices, Medical and Dispatch, last 2 minutes
  ago." The visible text stays labels and values only, per Brian's rule. axe runs in `health.spec.ts`.

### 5.3 Server-side aggregation (`lp_tel_health(p_section, p_since, p_limit)`)

Each section is one query over `lp_tel_events` with `at >= p_since`, which uses `(name, at)` or `(at)`. The queries,
in brief:

```sql
-- kpis
select jsonb_build_object(
  'devices', count(distinct device) filter (where device <> 'server'),
  'sessions', count(distinct session) filter (where device <> 'server'),
  'frustrations', count(*) filter (where name = any(:frustration)),
  'hitDevices', count(distinct device) filter (where name = any(:frustration)),
  'errors', count(*) filter (where name = 'error'),
  'syncOk', (select sum((props->>'ok')::int)::numeric / nullif(sum((props->>'ok')::int + (props->>'fail')::int), 0)
               from lp_tel_events where name = 'sync' and at >= p_since))
from lp_tel_events where at >= p_since;

-- problems (ranked)
select name, view, area, ctl, count(*) n, count(distinct device) devices, array_agg(distinct team) teams,
       max(at) last_at, (array_agg(id order by at desc))[1:3] examples
from lp_tel_events
where at >= p_since and name = any(:frustration)
group by name, view, area, ctl
order by devices desc, n desc
limit p_limit;

-- examples: one row per id in the top problems' examples (≤ 30): id, name, at, team, view, area, ctl, props, trail

-- flows
select name, coalesce(props->>'out', 'ok') out, count(*) n,
       percentile_cont(0.5)  within group (order by ms) p50,
       percentile_cont(0.95) within group (order by ms) p95
from lp_tel_events where at >= p_since and name like 'flow\_%' and ms is not null
group by 1, 2;

-- net: counts from the rows, percentiles from the duration arrays (two CTEs joined on the key)
with rows as (
  select area pattern, props->>'m' m, props->>'st' st,
         case when (props->>'on')::boolean is false then 'link_down' else props->>'conn' end state, n
    from lp_tel_events where at >= p_since and name = 'net'),
durs as (
  select e.area pattern, e.props->>'m' m, d.v::int ms
    from lp_tel_events e cross join lateral jsonb_array_elements_text(e.props->'d') d(v)
   where e.at >= p_since and e.name = 'net' and e.props->>'st' = '2xx')
select r.pattern, r.m, sum(r.n) n,
       sum(r.n) filter (where r.st in ('5xx','net','timeout')) failed,
       sum(r.n) filter (where r.st = 'timeout') timeouts,
       jsonb_object_agg(...)  -- per-state {n, failed}
       , (select percentile_cont(array[0.5, 0.95]) within group (order by ms) from durs where durs.pattern = r.pattern and durs.m = r.m) p
from rows r group by r.pattern, r.m order by n desc;

-- push
select kind,
  (select sum((props->>'ok')::int) from lp_tel_events where name='push_send' and props->>'kind'=k.kind and at >= p_since) sent_ok,
  ... gone, failed,
  count(*) filter (where name='push_rx') rx, count(*) filter (where name='push_rx' and (props->>'shown')::boolean) shown,
  count(*) filter (where name='notif_click' and props->>'src'='push') opened,
  percentile_cont(0.5) within group (order by ms) filter (where name='push_rx') transit_p50 ...
from (lp_tel_events joined to kind) group by kind;

-- coverage
with latest as (
  select distinct on (device) device, team, props from lp_tel_events
   where name = 'device_state' and at >= p_since order by device, at desc),
subs as (
  select case team when 'Medical' then 'medical' when 'GC/HX - Dispatch' then 'dispatch' when 'GC/HX - Base' then 'base'
                   when 'GC/HX - Special Operations/Med Transpo' then 'transpo' else 'other' end team,
         count(*) n, count(*) filter (where new_requests) newreq
    from public.lp_push_subscriptions group by 1),
alerts as (
  select team, count(*) n, count(*) filter (where ms <= 30000 and props->>'route' in ('toast','push')) within30,
         percentile_cont(0.5) within group (order by ms) p50
    from lp_tel_events where name = 'flow_alert' and at >= p_since group by team)
select l.team, count(*) devices,
       count(*) filter (where (l.props->>'sa')::boolean) standalone,
       count(*) filter (where l.props->>'perm' = 'granted') granted,
       count(*) filter (where l.props->>'push' = 'sub') pushsub,
       count(*) filter (where (l.props->>'newreq')::boolean) newreq,
       max(s.n) subs, max(s.newreq) subs_newreq, max(a.n) alerts, max(a.within30) within30, max(a.p50) p50
from latest l left join subs s using (team) left join alerts a using (team) group by l.team;

-- errors
select props->>'fp' fp, ctl type, area src, props->>'line' line, props->>'col' col,
       count(*) n, count(distinct device) devices, array_agg(distinct team) teams,
       array_agg(distinct view) views, max(at) last_at
from lp_tel_events where at >= p_since and name = 'error'
group by 1, 2, 3, 4, 5 order by last_at desc limit p_limit;
```

**Performance.** At the estimated ≤ 250k rows, each section is a single indexed scan. The function's 6 s statement
timeout sits under the server's 8 s `DB_TIMEOUT_MS`. `all` (30 days) is the only window that can approach it; if it
does, that section returns `null` and the page shows "—" for it.

---

## 6. Test plan

**Unit** (`vitest --project unit`, node environment, fake hosts in the style of `PendingOpenHost`; no jsdom)

| File | What it proves |
|---|---|
| `tests/unit/telemetry/sanitize.test.ts` | `tok()` replaces UUIDs and digit runs with `#` and refuses spaces, capitals and non-ASCII; CSS-module class parsing in both Turbopack and webpack forms, against class names read from a real `.next` build's CSS (skipped without a build); `ctl` and `area` precedence; form field keys and sections from `id` and `aria-labelledby` suffixes; path patterns (`/api/requests/<uuid>/messages/<uuid>/unsend` → `/api/requests/:id/messages/:id/unsend`; sync modes from keys only) |
| `tests/unit/telemetry/privacy.test.ts` | Fake elements whose `textContent`, `innerText`, `innerHTML`, `value`, `title`, `alt`, `placeholder`, `src` and `href`, plus `getAttribute('aria-label' \| 'title' \| 'alt' \| 'placeholder' \| 'href' \| 'src')`, **throw**, so `ctl`, `area`, the detectors and `process()` never touch them. A scripted session runs through the whole collector with every element labelled with names from `tests/fixtures/canon-staff.json`. In every serialized batch: no fixture name (case-insensitive), no `@`, no run of 3 or more digits outside `at`/`ms`/`k`/`p` numbers, no UUID, and no space in any string |
| `tests/unit/telemetry/detect.test.ts` | Rage: 3 taps in 900 ms within 25 px gives 1 event with `k=3`; 40 px apart or over 1.2 s gives none; a 4th tap within 2 s does not repeat. Stuck: 3 still swipes in `thread` within 8 s gives 1 event (dir, edge); swipes prevented inside `lp-toaster` or a grabber are ignored; the wheel variant; the 30 s cooldown. Dead: `not_interactive` (a card-like div), `no_response` (a button, nothing for 1 s), a response via mutation, view, fetch or sheet suppresses it, and `disabled`. Loop: open and close within 2 s twice within 20 s. Slow: limits per flow. Stuck send: 121 s online and live |
| `tests/unit/telemetry/flows.test.ts` | Store snapshot sequences give `flow_open` (both before and after the collector loads), `flow_resume`, `flow_new` (submit with section dwell, abandon, an invalid submit), `flow_submit` (ok, attention, offline wait), `flow_answer` from `Overlay.startedAt` (ok, failed on a red toast, conflict on amber), `flow_msg` and `flow_read` from server times, `flow_alert` routes (toast, push, off, hidden), `flow_push` (warm through lp-open and take-open, cold, not shown) |
| `tests/unit/telemetry/net.test.ts` | `window.fetch(...)` returns **the identical promise** from the native call; rejections and resolutions pass through untouched; a throwing `watch` is swallowed; `/api/telemetry` and non-`/api` paths are ignored; timeout versus abort by elapsed time per path; retry counting; `d` capped at 120; `stop()` restores the native fetch only when it is still ours; resource entries add bytes and never call `clearResourceTimings` |
| `tests/unit/telemetry/buffer.test.ts` (`fake-indexeddb`) | The memory ring caps at 500 and drops the oldest; the IndexedDB ring caps at 500 events by dropping the oldest batches; batches older than 24 h are dropped at load; stored batches are resent with the same `b`; a session or staff change clears everything; the `lp-tel` database is separate from `lp-client` |
| `tests/unit/telemetry/send.test.ts` | No send while hidden, offline, connection not live, syncing, outbox `sending`, message `sending`, `inflight > 0`, or within 1.5 s of a tap; spacing of 60 s for discrete events and 300 s for aggregates only; hidden → IndexedDB then beacon; gzip with a `CompressionStream` fake and plain JSON without one; 200 stores `until` and the skew; 204 detaches every listener, restores fetch, sets `lp-tel-off`, and the next start sends a probe first; 401 drops the batch and pauses; 5xx backs off 5 min, with 3 tries then drop; `capped` pauses until the next hour |
| `tests/unit/telemetry/guard.test.ts` | Every registered handler is wrapped (a thrown error inside never escapes to the dispatcher); the 20th fault stops the collector; the gate refuses past `until`, with `lp-tel-off`, and under `navigator.webdriver` without `lp-tel-test` |
| `tests/unit/telemetry/schema.test.ts` | `EVENT_NAMES`, `PROP_KEYS`, `VIEWS` and `FRUSTRATION` in `lib/telemetry.ts` equal the server zod enums and the table in this document (parsed from the markdown); the token regex is identical in TS, zod and SQL (read from the migration) |
| `tests/unit/sw/telemetry-sw.test.ts` (the existing `tests/unit/sw` harness) | The push log is written **after** `showNotification` resolves; a log write that throws still shows the notification; the click log comes after focus, open or navigate, with `via` for lp-open, take-open and nav; the cap of 100 and the 24 h drop; `lp-tel-take` returns and clears; `sentAt` is kept only when it is a number |
| `tests/unit/server/telemetry.test.ts` | `teamKey` for the 4 canonical teams, aliases, and custom text (`other`); `clampSkew`; envelope versus per-event validation; `tr` refused on non-frustration events; server-only names refused from clients |
| `tests/unit/health/health-view.test.tsx` (react-dom/server) | Fixture JSON renders values before labels; every chip has a glyph and an `aria-label` sentence; no visible text node over 6 words (screen-reader-only spans excluded); a `null` section renders "—"; phone width renders the "Desktop only" state |
| `tests/unit/activity.test.ts` (existing) | `pushPayload` gains `sentAt` (the existing deep-equal is updated) |

**Integration** (`vitest --project integration`, real local Supabase stack; isolated stacks per agent, per
`~/.config/lp-stacks`)

| File | What it proves |
|---|---|
| `tests/integration/telemetry.test.ts` (route) | 401 without a session; 403 with a bad Origin; 413 for a wire body over 48 KB and for a gzip that inflates past 256 KB; 422 for a bad envelope; one bad event among good ones stores the rest and returns `rejected: 1`; `team` is the session's key (a `team` field in the body is ignored); custom team text gives `other`; the skew shifts `at`; the same batch twice stores its rows once (`dup`); with the cap set to 50, 60 events store 50 and return `capped`; the byte cap; `enabled=false` gives **204 with no row written**, and no RPC while it is cached (`resetTelemetryConfigCache()` hook); `off_at` in the past gives 204; `lp_tel_ingest` called directly while off gives `{on: false}` and writes nothing; no `Set-Cookie` on any answer (`refresh: false`) |
| `tests/integration/telemetry.test.ts` (SQL) | The file applies twice on the migrated app database (idempotent; the existing `scripts/verify-migration.sh` pattern, extended with a `telemetry` step); exactly one `lp-tel-retention` job; RLS on for all 5 tables; `select count(*) from pg_policies where tablename like 'lp\_tel\_%'` is 0; `has_table_privilege('anon' \| 'authenticated', t, 'select')` is false for every table; functions are executable by `service_role` only; `lp_tel_retention()` deletes events older than 30 days and keeps newer ones |
| Health aggregates | Seeded fixture rows give the expected `problems` order (devices, then count), `flows` p50/p95, `net` failure rates by state, `push` rates, `coverage` (it reads `lp_push_subscriptions` too), and `errors` grouped by `fp` |
| `tests/integration/notify.test.ts` (existing, extended) | `deliver()` with the fake push service (`tests/integration/push-service.ts`) writes `push_send` rows per team with ok, gone and failed counts; with telemetry off it writes nothing; with the `lp_tel_*` tables dropped it still delivers and never throws |

**End-to-end** (Playwright, production build `npm run build:test`)

| Spec | What it proves |
|---|---|
| `tests/e2e/first-load.spec.ts` (**unchanged**) | Route-only ≤ 43,008 B and total ≤ 239,616 B. A new assertion: none of the HTML's script chunks contains the string `lp-tel` (the collector is not on the first load) |
| `tests/e2e/telemetry.spec.ts` (`chromium-iphone14` with touch; plus the WebKit project where configured) | Sets `lp-tel-test=1`, signs in, then: All → Pending → a request → Messages. A triple tap on a non-interactive card area writes a `rage_tap` row with a trail (read with the admin client). Three swipes at the top of the thread write `stuck_scroll` with `a = thread`. With the context offline for 30 s and then online, the events arrive afterwards, with `link` offline and online. Setting `enabled=false` through the admin client makes the next send get a 204, and then there is **no `POST /api/telemetry` during 2 more minutes of activity** |
| Privacy (same spec) | Creates a request named `TEST-e2e Quorra Zyxwvut`, phone `407 555 0199`, last seen `Gate Plum`; sends the message `TEST-e2e secret phrase plum`; searches `Quorra`; opens the photo viewer. Then `select row_to_json(e)::text from lp_tel_events e where received_at > :start` contains none of `quorra`, `zyxwvut`, `0199`, `plum` or `secret` (case-insensitive) |
| No impact (same spec) | Over a scripted 2-minute session, telemetry on versus off: the same number of `/api/sync` requests within ±1, the same median sync duration within ±20 %, and (Chromium) a long-task count no higher. No `/api/telemetry` request ever starts while another `/api/*` request is pending (checked from `page.on('request' \| 'requestfinished' \| 'requestfailed')` timestamps) |
| `tests/e2e/health.spec.ts` (desktop project) | `/health` without a session goes to `/signin?next=/health` and back after sign-in; seeded rows render every panel; **Refresh makes exactly one `GET /api/telemetry/health`**; no request in 60 s idle (no polling); 390 px wide shows "Desktop only"; the sidebar's Health link is absent until `/health` has been visited on that device, then present; the switch's confirm turns collection off (204 for the next ingest); axe is clean |
| Existing suites | Unchanged and green: offline, messages, notify, alerts, sheet-swipe, toast-swipe and desk. They run with `navigator.webdriver` set, so the collector does not load and changes nothing |

**Manual** (the morning checklist, on a real iPhone Home Screen app plus a laptop):

- tap around, then check that `/health` shows an `ios` standalone device on the right build;
- "Send a test alert" gives `push_rx` (kind test), `notif_click` and `flow_push`;
- flip the switch, and POSTs stop within a minute;
- confirm in Safari Web Inspector that no `/api/telemetry` request overlaps a sync.

---

## 7. Production rollout, and how to turn it off

**Gate.** Run one full gate (unit, integration, e2e, `first-load.spec`), because the build touches `public/sw.js` and
the push payload. If time is short, drop §4.7 (the SW log and `sentAt`) from the build. What is left touches no
existing behaviour and fits the hotfix lane. Push open rates then come only from `flow_alert`, and `flow_push` waits
for a later build.

1. **Migration first** (Supabase dashboard, SQL Editor, as `postgres`):
   1. **Before**: `select to_regclass('public.lp_push_subscriptions') is not null;` returns `true` (F4 is applied).
   2. **Dry run**: paste `supabase/migrations/20261108000000_telemetry.sql`, change the last `commit;` to
      `rollback;`, and run it. It must finish without an error. The NOTICEs are
      `lp-tel-retention: scheduled daily 09:17 UTC (job …)`, or `NOT scheduled (pg_cron is not available)`. It takes
      no lock on any existing table; all five tables are new.
   3. **Commit**: paste it again unchanged and run it.
   4. **Check**:
      - `select enabled, off_at from public.lp_tel_settings;` gives `t | 2026-11-10 11:00:00+00`;
      - `select count(*) from pg_class where relname like 'lp\_tel\_%' and relkind = 'r' and relrowsecurity;` gives `5`;
      - `select count(*) from pg_policies where tablename like 'lp\_tel\_%';` gives `0`;
      - `select has_table_privilege('anon', 'public.lp_tel_events', 'select');` gives `f`;
      - `select jobname, schedule, active from cron.job where jobname = 'lp-tel-retention';` gives one row,
        `17 9 * * * | t`.

   The live build never calls these tables, so the migration changes nothing for it.
2. **Deploy.** Merge to `main`; Vercel deploys it. **No new environment variable.** Phones show "Update ready ·
   Reload". Telemetry starts on each phone once it runs the new build, and nobody needs to be asked to reload. The
   update downloads about 9 KB for the collector and about 7 KB for `/health` once, through the SW precache.
3. **Verify events arrive** (within 5 minutes of the first reloads):
   - `select name, count(*) from public.lp_tel_events where received_at > now() - interval '10 minutes' group by 1 order by 2 desc;`
     shows `app_start`, `view`, `net`, `sync`, `device_state`;
   - `select team, plat, sa, build, count(*) from public.lp_tel_devices where last_seen > now() - interval '15 minutes' group by 1,2,3,4;`;
   - open `/health` on a laptop: the devices KPI is above 0 and Requests lists `/api/sync:delta`;
   - Vercel logs: `{"lp":"api","route":"POST /api/telemetry"...}` lines appear only for failures or slow requests.
     A run of 4xx/5xx there means turn it off (step 5) and look.
4. **Watch the budget** (now and then):
   - `select pg_size_pretty(pg_total_relation_size('public.lp_tel_events'));` should stay under ~200 MB;
   - `select device, events, bytes from public.lp_tel_quota where hour = date_trunc('hour', now()) order by events desc limit 5;`
     shows no device near 3,000.
5. **Turn it off.** Any of these works:
   - **Kill switch**: `update public.lp_tel_settings set enabled = false, updated_at = now();`, or the switch on
     `/health`. Server instances answer 204 within ≤ 30 s. Each phone stops at its next send (≤ 60 s while active),
     detaches every listener, restores `fetch`, and checks again only once every 30 min with one empty probe.
   - **Auto-off**: it happens by itself at `2026-11-10 06:00 ET`. Move it with
     `update public.lp_tel_settings set off_at = timestamptz '2026-11-09 06:00-05', updated_at = now();`. Clients
     cache `until` from each answer, and after it the gate does not even load the chunk.
   - **Back on**: `update public.lp_tel_settings set enabled = true, updated_at = now();`. Phones pick it up within
     30 min, at their next probe.
   - **Pause retention**: `select cron.unschedule('lp-tel-retention');`.
6. **Go back.** Redeploy the previous build; the SQL can stay. The old build never touches the `lp_tel_*` tables.
7. **Teardown** (after the analysis; retention would empty the table by about 2026-12-10 anyway):
   ```sql
   begin;
   select cron.unschedule(jobid) from cron.job where jobname = 'lp-tel-retention';
   drop function if exists public.lp_tel_health(text, timestamptz, integer), public.lp_tel_retention(),
     public.lp_tel_set(boolean, timestamptz), public.lp_tel_server_events(jsonb), public.lp_tel_config(),
     public.lp_tel_ingest(text, text, text, text, bigint, jsonb, jsonb, integer);
   drop table if exists public.lp_tel_events, public.lp_tel_devices, public.lp_tel_quota, public.lp_tel_batches,
     public.lp_tel_settings;
   notify pgrst, 'reload schema';
   commit;
   ```
   The design fails closed. With the tables gone, `telemetryConfig()` can't be read, so the route answers 204 and
   every client turns itself off. The teardown SQL alone is safe, even before a build that removes the collector.

---

## 8. Decisions and risks

| Decision | Why | Fallback |
|---|---|---|
| Observe; don't instrument | The first load has about 2 B of headroom, so no first-load module may change. Everything is read from the store's public contract, the DOM, timing APIs and the SW | — |
| A pass-through `fetch` observer on top of resource timing | WebKit, which is most staff phones, gives no `responseStatus` and no entry for failed or aborted fetches. The observer returns the native promise itself; unit tests prove identity and isolation | the `fetchObs` knob off: resource timing only, with status and timeouts `unk` on WebKit |
| Flows timed on the device; no request ids | Keeps request ids, and so anything joinable to `patients`, out of telemetry | — |
| `/health` as its own route | `?health=1` would change `nav.ts parseView` (first load) | — |
| Its own migration file | Pasting the 3,400-line rework file again mid-event is needless risk; this one is self-contained and fails closed when absent | — |
| Error messages are never stored | V8 `JSON.parse` and other messages can quote data; the type plus the frame hash is enough to find and fix it with source maps | — |
| Aggregates flushed every 5 min, discrete events every ≥ 60 s | Cuts rows about 5× (§2 estimate) without losing breadcrumbs, which carry the sequence | — |
| `refresh: false` on the ingest route | A late telemetry answer must not re-set a cookie the user just signed out of | — |
| The SW log writes after the notification and after the click's navigation | It never risks WebKit's silent-push revocation or the click's user activation | drop §4.7 |

**Known limits**

- `no_response` dead taps can be hidden by unrelated store emits; it errs toward not flagging.
- `edge` comes from one idle read and can be wrong after momentum.
- LCP, CLS, INP and long tasks are Chromium-only.
- Push "received" counts only reach the server once the app opens again.
- `pagehide` is unreliable in iPhone Home Screen apps, so events from a session killed in the background arrive at
  the next launch (IndexedDB plus dedupe).
- `requestIdleCallback` is missing on Safari, which falls back to timers.

**Not in this build**

- Session replay or DOM snapshots: deliberately out, because of privacy.
- Server log ingestion: Vercel logs cover it.
- A per-request drill-down: it would need request ids, which are excluded on purpose.
