-- docs/export.sql: the end-of-event export for "Is my friend in medical?" (EDC Orlando 2026).
-- It replaces the app's Export CSV button (removed 2026-11-06). Two read-only queries; nothing is changed.
--
--   1. Supabase dashboard → SQL Editor → New query. Paste this whole file.
--   2. Highlight Query 1 (from its "with" to its ";") and click Run, so only that query runs. If the
--      editor offers a row limit, set it to "No limit" first, so every row comes back.
--   3. Above the results, click "Download CSV" (under Export). Then repeat steps 2 and 3 for Query 2.
--
-- Query 1 is every request, one row each, by case number. Query 2 is the whole audit trail, one row per
-- event, by case number and time. Times are America/New_York, the event's time zone.
-- Text a spreadsheet could run as a formula (starting with = + - @ or the full-width ＝ ＋ － ＠, after
-- any spaces or invisible characters, or starting with a tab or a line break) gets a leading ', as the
-- app's CSV export did. The files hold names and phone numbers: keep them off shared devices.

-- Query 1: requests
with settings as (
  select 'America/New_York'::text as tz,
         'YYYY-MM-DD HH24:MI:SS'::text as fmt,
         '^(?=[\t\r\n]|[\u0001- \u007f- ­؜ ᠎ -‏ -  -⁤　﻿]*[=+@＝＋－＠-])'::text as guard
)
select
  'LP-' || lpad(p.case_number::text, greatest(4, length(p.case_number::text)), '0') as "Case number",
  regexp_replace(nullif(concat_ws(' ', nullif(p.first_name, ''), nullif(p.last_name, '')), ''), s.guard, '''') as "Name",
  p.age as "Age",
  p.gender as "Gender",
  regexp_replace(p.height_build, s.guard, '''') as "Height/build",
  regexp_replace(p.hair, s.guard, '''') as "Hair",
  regexp_replace(p.identifying_features, s.guard, '''') as "Identifying features",
  regexp_replace(p.physical_description, s.guard, '''') as "Physical description",
  regexp_replace(p.clothing, s.guard, '''') as "Clothing",
  regexp_replace(p.last_seen, s.guard, '''') as "Last seen",
  regexp_replace(p.additional_notes, s.guard, '''') as "Notes",
  p.reporting_location as "Reporting location",
  regexp_replace(p.other_location, s.guard, '''') as "Other location",
  regexp_replace(p.contact_name, s.guard, '''') as "Contact name",
  regexp_replace(p.contact_phone, s.guard, '''') as "Contact phone",
  regexp_replace(p.contact_relationship, s.guard, '''') as "Contact relationship",
  regexp_replace(p.contact_notes, s.guard, '''') as "Contact notes",
  case p.status
    when 'Added' then 'Waiting for check'
    when 'Checked – Not Found' then 'Not in medical'
    when 'Found – Awaiting Reunion' then 'In medical · friend coming'
    when 'Bring friend to medical' then 'In medical · friend coming'
    when 'Reunited – Closed' then 'Reunited'
    when 'Found – Discharged' then 'Discharged'
    when 'Cancelled' then 'Cancelled'
    else p.status
  end as "Status",
  p.status as "Status (database)",
  to_char(p.created_at at time zone s.tz, s.fmt) as "Created",
  to_char(p.updated_at at time zone s.tz, s.fmt) as "Updated",
  to_char(p.found_at at time zone s.tz, s.fmt) as "Found",
  to_char(p.reunion_started_at at time zone s.tz, s.fmt) as "Reunion started",
  to_char(p.closed_at at time zone s.tz, s.fmt) as "Closed",
  regexp_replace(p.created_by, s.guard, '''') as "Created by",
  regexp_replace(p.updated_by, s.guard, '''') as "Updated by"
from public.patients p
cross join settings s
order by p.case_number;

-- Query 2: audit trail
with settings as (
  select 'America/New_York'::text as tz,
         'YYYY-MM-DD HH24:MI:SS'::text as fmt,
         '^(?=[\t\r\n]|[\u0001- \u007f- ­؜ ᠎ -‏ -  -⁤　﻿]*[=+@＝＋－＠-])'::text as guard
)
select
  'LP-' || lpad(p.case_number::text, greatest(4, length(p.case_number::text)), '0') as "Case number",
  to_char(e.occurred_at at time zone s.tz, s.fmt) as "When",
  regexp_replace(e.staff_name, s.guard, '''') as "Staff",
  e.action_type as "Action",
  regexp_replace(e.previous_value ->> 'status', s.guard, '''') as "From status",
  regexp_replace(e.new_value ->> 'status', s.guard, '''') as "To status",
  regexp_replace(e.new_value ->> 'kind', s.guard, '''') as "Kind",
  regexp_replace(e.notes, s.guard, '''') as "Notes",
  e.previous_value::text as "Previous value",
  e.new_value::text as "New value"
from public.audit_events e
left join public.patients p on p.id = e.patient_id
cross join settings s
order by p.case_number nulls last, e.occurred_at, e.id;
