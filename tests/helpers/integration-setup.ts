// Integration tests talk to the LOCAL Supabase stack and a local `next start` (port from PORT, default
// 3100) built and started with `node scripts/with-test-env.mjs`. This loads .env.test (never .env.local)
// into process.env and refuses to continue if any Supabase URL is not local.
// (F6) It also pauses the auto-close job on the local database (scripts/test-env.mjs pauseInactiveJob): the tests
// run lp_close_inactive() themselves, on their own rows.
import { assertLocalUrl, ensureTestEvent, loadTestEnv, pauseInactiveJob } from '../../scripts/test-env.mjs';

const env = loadTestEnv();
for (const [key, value] of Object.entries(env)) {
  if (key === 'PORT' && process.env.PORT) continue;
  process.env[key] = value;
}
assertLocalUrl('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
pauseInactiveJob();
// (Events) The live local event every test signs in to (its staff password, join link and the lead passcode).
await ensureTestEvent();
