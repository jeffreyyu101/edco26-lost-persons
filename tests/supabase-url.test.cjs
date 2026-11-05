const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSupabaseUrl } = require('../lib/supabase-url.js');

test('keeps a Supabase project URL unchanged', () => {
  assert.equal(normalizeSupabaseUrl('https://project.supabase.co'), 'https://project.supabase.co');
});

test('removes the REST endpoint path supplied by API settings', () => {
  assert.equal(normalizeSupabaseUrl('https://project.supabase.co/rest/v1/'), 'https://project.supabase.co');
});

test('removes a trailing slash from a project URL', () => {
  assert.equal(normalizeSupabaseUrl('https://project.supabase.co/'), 'https://project.supabase.co');
});

test('preserves missing configuration for the caller to validate', () => {
  assert.equal(normalizeSupabaseUrl(undefined), undefined);
});
