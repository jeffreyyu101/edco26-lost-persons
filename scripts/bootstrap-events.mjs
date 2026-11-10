#!/usr/bin/env node
// One-time bootstrap of the multi-event foundation (supabase/migrations/20261110000000_events.sql), run ONCE by the
// maintainer right after that migration, against the database the app uses:
//   1. the Ground Control lead passcode → lp_org.lead_passcode_hash (bcrypt);
//   2. the EDC event (slug edco26) gets the staff password the app used until now: APP_SHARED_PASSWORD_HASH_B64 (a
//      base64 bcrypt hash, copied as is) or APP_SHARED_PASSWORD (hashed here);
//   3. the EDC event gets the old team join link when INVITE_CODE_SHA256 / INVITE_EXPIRES_AT are set (an old link then
//      reaches the Ended screen).
// Prints only what it did, never a password, a passcode, a hash or a join code.
//
//   set -a; . <env file with the production values>; set +a
//   node scripts/bootstrap-events.mjs [--dry-run] [--force]          # asks for the lead passcode (hidden, twice)
//   node scripts/bootstrap-events.mjs [--force] < passcode-file      # or reads it from stdin (first line)
//
// The lead passcode is never taken from the command line or an environment variable (both end up in shell history or
// process listings): on a terminal it is asked for (not echoed, twice); otherwise it is the first line of stdin. Needs
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY). It refuses to replace a lead passcode
// that is already set unless --force, and refuses a lead passcode equal to any event's staff password.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const BCRYPT = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function die(message) {
  console.error(`bootstrap-events: ${message}`);
  process.exit(1);
}
// Anything else on the command line is refused, unnamed: it may be a passcode typed where it must never go.
if ([...args].some((a) => a !== '--dry-run' && a !== '--force')) die('only --dry-run and --force are accepted; the lead passcode is typed at the prompt or piped on stdin.');
const env = (name) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

/** The first line of stdin (piped or redirected), without its line ending. */
async function firstStdinLine() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes('\n')) break;
  }
  return data.split(/\r?\n/)[0] ?? '';
}

async function askHidden(prompt) {
  let muted = false;
  const output = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = await new Promise((resolve) => {
    rl.question(prompt, (a) => resolve(a));
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const url = env('NEXT_PUBLIC_SUPABASE_URL')?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const key = env('SUPABASE_SECRET_KEY') ?? env('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required.');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function rpc(fn, params) {
  const { data, error } = await db.rpc(fn, params);
  if (error) die(`${fn} failed (${error.code ?? 'error'}).`); // never the message: it could echo a value
  return data;
}

// The EDC staff password, from the env the app used until now.
let edcHash = null;
const hashB64 = env('APP_SHARED_PASSWORD_HASH_B64');
const plain = process.env.APP_SHARED_PASSWORD;
if (hashB64) {
  edcHash = Buffer.from(hashB64, 'base64').toString('utf8');
  if (!BCRYPT.test(edcHash)) die('APP_SHARED_PASSWORD_HASH_B64 is not a base64-encoded bcrypt hash.');
} else if (plain) {
  edcHash = await bcrypt.hash(plain, 10);
} else {
  die('APP_SHARED_PASSWORD_HASH_B64 or APP_SHARED_PASSWORD is required (the EDC staff password).');
}

const invHex = env('INVITE_CODE_SHA256')?.toLowerCase();
const invExpires = env('INVITE_EXPIRES_AT');
const invite = invHex && /^[0-9a-f]{64}$/.test(invHex) && invExpires && !Number.isNaN(Date.parse(invExpires)) ? { sha256: invHex, expiresAt: new Date(Date.parse(invExpires)).toISOString() } : null;

const edc = await rpc('lp_event_by_slug', { p_slug: 'edco26' });
if (!edc?.id) die('the edco26 event is missing: apply 20261110000000_events.sql first.');
const secrets = await rpc('lp_auth_secrets', {});
if (secrets?.lead && !force) die('a lead passcode is already set (pass --force to replace it).');

if (process.env.LP_LEAD_PASSCODE !== undefined) die('LP_LEAD_PASSCODE is not read: type the passcode at the prompt or pipe it on stdin.');
let passcode;
if (process.stdin.isTTY) {
  passcode = await askHidden('Ground Control lead passcode: ');
  const again = await askHidden('Again: ');
  if (passcode !== again) die('the two entries differ.');
} else {
  passcode = await firstStdinLine();
}
if (passcode.length < 8) die('the lead passcode needs at least 8 characters.');
// Checked first at sign-in, so it must not be any event's staff password (EDC's included).
if (await bcrypt.compare(passcode, edcHash)) die('the lead passcode equals the EDC staff password: choose another.');
for (const e of secrets?.events ?? []) {
  if (e.hash && (await bcrypt.compare(passcode, e.hash))) die('the lead passcode equals an event staff password: choose another.');
}

if (dryRun) {
  console.log(`bootstrap-events: dry run, nothing written. Would set: lead passcode; edco26 staff password${invite ? '; edco26 join link' : ''}.`);
  process.exit(0);
}
await rpc('lp_org_set_lead_passcode', { p_hash: await bcrypt.hash(passcode, 10) });
console.log('bootstrap-events: lead passcode set.');
await rpc('lp_event_set_password', { p_event: edc.id, p_hash: edcHash });
console.log('bootstrap-events: edco26 staff password copied from the env.');
if (invite) {
  await rpc('lp_event_set_invite', { p_event: edc.id, p_sha256: invite.sha256, p_expires_at: invite.expiresAt });
  console.log('bootstrap-events: edco26 join link copied from the env.');
} else {
  console.log('bootstrap-events: no INVITE_CODE_SHA256 / INVITE_EXPIRES_AT: edco26 has no join link.');
}
