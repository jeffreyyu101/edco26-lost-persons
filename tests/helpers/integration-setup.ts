// Integration tests talk to the LOCAL Supabase stack and a local `next start` (port from PORT, default
// 3100) built and started with `node scripts/with-test-env.mjs`. This loads .env.test (never .env.local)
// into process.env and refuses to continue if any Supabase URL is not local.
import { assertLocalUrl, loadTestEnv } from '../../scripts/test-env.mjs';

const env = loadTestEnv();
for (const [key, value] of Object.entries(env)) {
  if (key === 'PORT' && process.env.PORT) continue;
  process.env[key] = value;
}
assertLocalUrl('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
