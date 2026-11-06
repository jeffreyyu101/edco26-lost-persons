-- Align production constraints with the current coordination workflow.
-- Run once in Supabase SQL Editor before deploying app code that writes these values.
alter table public.patients drop constraint if exists patients_reporting_location_check;
alter table public.patients
  add constraint patients_reporting_location_check
  check (reporting_location in ('FA 3 – Kinetic','FA 4 – Oasis','Command','Base','Other'));

alter table public.patients drop constraint if exists patients_status_check;
alter table public.patients
  add constraint patients_status_check
  check (status in ('Added','Checked – Not Found','Found – Awaiting Reunion','Reunited – Closed','Found – Discharged','Bring friend to medical','Cancelled'));
