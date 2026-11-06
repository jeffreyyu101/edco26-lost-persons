// Unit tests run with a fixed timezone so time formatting is deterministic, and with no Supabase
// configuration at all (a unit test that reaches for the server environment fails loudly).
process.env.TZ = 'UTC';
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
