-- Apply to an existing Supabase project before saving inquiries with the Last seen field.
alter table public.patients add column if not exists last_seen text;
