#!/usr/bin/env node
// A fresh team join link code (design/DECISIONS.md "Team join link", HANDOFF.md "Team join link").
//
//   node scripts/make-invite.mjs                       → the code and INVITE_CODE_SHA256
//   node scripts/make-invite.mjs https://<host>        → the same, plus the link to share
//
// The code is 32 random bytes as base64url; INVITE_CODE_SHA256 is the hex SHA-256 of it. Prints to stdout
// only and never writes a file: put INVITE_CODE_SHA256 (and INVITE_EXPIRES_AT) in Vercel, share the link,
// and keep the code out of the repo, tickets and screenshots.
import { createHash, randomBytes } from 'node:crypto';

const host = process.argv[2];
let origin = null;
if (host !== undefined) {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    origin = url.origin;
  } catch {
    console.error('usage: node scripts/make-invite.mjs [https://<host>]');
    process.exit(2);
  }
}

const code = randomBytes(32).toString('base64url');
const sha256 = createHash('sha256').update(code, 'utf8').digest('hex');

console.log(`JOIN_CODE=${code}`);
console.log(`INVITE_CODE_SHA256=${sha256}`);
if (origin) console.log(`JOIN_LINK=${origin}/signin#join=${code}`);
