import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvError, eventTimezone, normalizeSupabaseUrl, resetServerEnvCache, serverEnv } from '@/lib/server/env';

// Ported from Jeffrey's tests/supabase-url.test.cjs.
describe('normalizeSupabaseUrl', () => {
  it('keeps a Supabase project URL unchanged', () => {
    expect(normalizeSupabaseUrl('https://project.supabase.co')).toBe('https://project.supabase.co');
  });

  it('removes the REST endpoint path supplied by API settings', () => {
    expect(normalizeSupabaseUrl('https://project.supabase.co/rest/v1/')).toBe('https://project.supabase.co');
    expect(normalizeSupabaseUrl('https://project.supabase.co/rest/v1')).toBe('https://project.supabase.co');
  });

  it('removes a trailing slash from a project URL', () => {
    expect(normalizeSupabaseUrl('https://project.supabase.co/')).toBe('https://project.supabase.co');
  });

  it('preserves missing configuration for the caller to validate', () => {
    expect(normalizeSupabaseUrl(undefined)).toBeUndefined();
  });
});

describe('serverEnv', () => {
  const KEYS = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SESSION_SECRET',
    'APP_SHARED_PASSWORD',
    'APP_SHARED_PASSWORD_HASH_B64',
    'EVENT_TIMEZONE',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    resetServerEnvCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetServerEnvCache();
  });

  const valid = () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54421/rest/v1/';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.APP_SHARED_PASSWORD = 'pw';
  };

  it('reads a valid environment and normalises the URL', () => {
    valid();
    const env = serverEnv();
    expect(env.supabaseUrl).toBe('http://127.0.0.1:54421');
    expect(env.supabaseOrigin).toBe('http://127.0.0.1:54421');
    expect(env.password).toEqual({ kind: 'plain', value: 'pw' });
    expect(env.eventTimezone).toBe('America/New_York');
  });

  it('falls back to SUPABASE_SERVICE_ROLE_KEY', () => {
    valid();
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-key';
    expect(serverEnv().supabaseKey).toBe('legacy-key');
  });

  it('prefers the bcrypt hash when both passwords are set', () => {
    valid();
    const hash = '$2b$10$' + 'a'.repeat(53);
    process.env.APP_SHARED_PASSWORD_HASH_B64 = Buffer.from(hash).toString('base64');
    expect(serverEnv().password).toEqual({ kind: 'bcrypt', hash });
  });

  it('fails with a clear message naming every problem, never values', () => {
    process.env.SESSION_SECRET = 'short-secret-value';
    process.env.EVENT_TIMEZONE = 'Mars/Olympus';
    let error: unknown;
    try {
      serverEnv();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as Error).message;
    expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL is missing');
    expect(message).toContain('SUPABASE_SECRET_KEY');
    expect(message).toContain('SESSION_SECRET must be at least 32 characters');
    expect(message).toContain('APP_SHARED_PASSWORD_HASH_B64 or APP_SHARED_PASSWORD is required');
    expect(message).toContain('EVENT_TIMEZONE is not a valid IANA time zone');
    expect(message).not.toContain('short-secret-value');
  });

  it('rejects a hash that is not bcrypt', () => {
    valid();
    process.env.APP_SHARED_PASSWORD_HASH_B64 = Buffer.from('not-a-hash').toString('base64');
    expect(() => serverEnv()).toThrow(/not a base64-encoded bcrypt hash/);
  });

  it('treats blank values as unset', () => {
    valid();
    process.env.SUPABASE_SECRET_KEY = '   ';
    expect(() => serverEnv()).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('eventTimezone() falls back to the default on bad input', () => {
    process.env.EVENT_TIMEZONE = 'Nope/Nope';
    expect(eventTimezone()).toBe('America/New_York');
    process.env.EVENT_TIMEZONE = 'America/Chicago';
    expect(eventTimezone()).toBe('America/Chicago');
  });
});
