-- Initial MVP schema. Apply in Supabase SQL Editor before configuring the app.
create extension if not exists pgcrypto;
create sequence if not exists public.patient_case_number_seq start 1001;

create table if not exists public.patients (
 id uuid primary key default gen_random_uuid(),
 client_mutation_id uuid unique,
 case_number bigint not null unique default nextval('public.patient_case_number_seq'),
 first_name text, last_name text, age smallint check (age is null or (age between 0 and 120)), gender text,
 height_build text, hair text, identifying_features text, physical_description text, clothing text,
 additional_notes text,
 reporting_location text not null check (reporting_location in ('FA 3 – Kinetic','FA 4 – Oasis','Other')),
 other_location text,
 contact_name text, contact_phone text, contact_relationship text, contact_notes text,
 status text not null default 'Added' check (status in ('Added','Checked – Not Found','Found – Awaiting Reunion','Reunited – Closed','Found – Discharged','Found – Transported','Cancelled')),
 created_by text not null, updated_by text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 found_at timestamptz, reunion_started_at timestamptz, closed_at timestamptz,
 constraint other_location_required check (reporting_location <> 'Other' or nullif(trim(other_location),'') is not null)
);
create index if not exists patients_created_at_idx on public.patients(created_at desc);
create index if not exists patients_status_idx on public.patients(status);
create index if not exists patients_case_number_idx on public.patients(case_number);

create table if not exists public.audit_events (
 id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id),
 staff_name text not null, action_type text not null, previous_value jsonb, new_value jsonb, notes text,
 occurred_at timestamptz not null default now()
);
create index if not exists audit_patient_time_idx on public.audit_events(patient_id,occurred_at desc);

create table if not exists public.patient_photos (
 id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id),
 storage_path text not null unique, photo_timing text not null check (photo_timing in ('older','today','unsure')),
 uploaded_by text not null, created_at timestamptz not null default now(), is_active boolean not null default true
);
create index if not exists patient_photos_active_idx on public.patient_photos(patient_id) where is_active;

-- Prevent direct browser access. The MVP server uses the service-role key only in server routes.
alter table public.patients enable row level security;
alter table public.audit_events enable row level security;
alter table public.patient_photos enable row level security;
-- No anon/authenticated policies are intentionally created. Never expose service-role credentials.

-- Private photo bucket; create in Storage UI with name 'patient-photos', private=true, max size 5 MB.
-- Add MIME allowlist: image/jpeg, image/png, image/webp. Configure server-only signed URL access.
