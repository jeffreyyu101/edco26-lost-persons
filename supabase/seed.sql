-- Local synthetic seed. LOCAL ONLY: every name, phone number and description below is invented.
-- Loaded by scripts/db-reset.sh after `supabase db reset` (never by hand against another database).
--
-- 21 requests that match the mockups (design/screens/*): 4 Waiting for check, 3 In medical (one with the
-- legacy status 'Bring friend to medical'), 2 Not in medical, 10 Reunited, 1 Discharged, 1 Cancelled.
-- Times are relative to now() so wait badges look like the mockups whenever the seed is loaded.
-- LP-0996 and LP-0997 (and LP-1005's events) use Jeffrey's legacy audit formats: full-row patient_created,
-- medical_search, medical_search_found, check_completed, full-row status_changed / patient_updated, and a
-- photo with photo_timing 'unsure' and no thumbnail.

begin;

do $guard$
begin
  if exists (select 1 from public.patients) then
    raise exception 'seed.sql refuses to run: public.patients is not empty. Run scripts/db-reset.sh on the LOCAL stack.';
  end if;
end
$guard$;

create function pg_temp.ago(p_minutes numeric) returns timestamptz
language sql stable as $$ select now() - make_interval(secs => p_minutes * 60) $$;

create function pg_temp.pid(p_case integer) returns uuid
language sql immutable as $$ select ('5eed0000-0000-4000-8000-' || lpad(p_case::text, 12, '0'))::uuid $$;

create function pg_temp.photo(p_case integer, p_n integer) returns uuid
language sql immutable as $$ select ('f0f0f0f0-0000-4000-8000-' || lpad((p_case * 10 + p_n)::text, 12, '0'))::uuid $$;

-- Staff attribution strings ("Name · canonical team"), exactly the app's format.
create function pg_temp.staff(p_key text) returns text
language sql immutable as $$
  select case p_key
    when 'dana' then 'Dana Kim · GC/HX - Dispatch'
    when 'lee' then 'Lee Park · GC/HX - Base'
    when 'rae' then 'Rae Chen · GC/HX - Special Operations/Med Transpo'
    when 'sam' then 'Sam Ortiz · Medical'
    when 'alex' then 'Alex Rivera · GC/HX - Dispatch'
  end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------------------------------
insert into public.patients (
  id, client_mutation_id, case_number, first_name, last_name, age, gender, height_build, hair,
  identifying_features, physical_description, last_seen, clothing, additional_notes, reporting_location,
  other_location, contact_name, contact_phone, contact_relationship, contact_notes, status, created_by,
  updated_by, created_at, updated_at, found_at, reunion_started_at, closed_at, row_version
) values
  -- Waiting for check
  (pg_temp.pid(1013), gen_random_uuid(), 1013, 'T.R.', null, 24, 'Male', null, 'Blond buzz cut', null, null,
   'Near the circuitGROUNDS entrance', 'Red hoodie, blond buzz cut, green wristband', null, 'FA 4 – Oasis', null,
   'Chris P.', '(407) 555-0110', 'Friend', null, 'Added', pg_temp.staff('lee'), pg_temp.staff('lee'),
   pg_temp.ago(1), pg_temp.ago(1), null, null, null, 0),
  (pg_temp.pid(1012), gen_random_uuid(), 1012, 'Kayla', 'Martinez', 19, 'Female', null, 'Blond, two braids', null,
   'Pink cowboy hat, silver fringe top, braids. Last seen Kinetic Field rail.', 'kineticFIELD rail, ~10:30',
   'Pink cowboy hat, silver fringe top, white shorts', null, 'FA 3 – Kinetic', null,
   'Maya R.', '(407) 555-0142', 'Best friend', null, 'Added', pg_temp.staff('dana'), pg_temp.staff('dana'),
   pg_temp.ago(12), pg_temp.ago(9), null, null, null, 3),
  (pg_temp.pid(1011), gen_random_uuid(), 1011, 'D.F.', null, 28, 'Male', 'Tall, slim', null, null, null,
   'Ferris wheel line', 'Black cap, glow necklace, cargo shorts', null, 'Command', null,
   'Priya S.', '407-555-0123', 'Sister', null, 'Added', pg_temp.staff('lee'), pg_temp.staff('lee'),
   pg_temp.ago(16), pg_temp.ago(16), null, null, null, 0),
  (pg_temp.pid(1010), gen_random_uuid(), 1010, 'B.W.', null, 23, 'Female', null, null, null, null,
   'stereoBLOOM, left side', 'Neon green bikini top, white platform boots, red bandana', null, 'FA 4 – Oasis', null,
   'Tasha W.', '(407) 555-0177', 'Cousin', 'Has her phone but it is dead', 'Added', pg_temp.staff('lee'),
   pg_temp.staff('lee'), pg_temp.ago(24), pg_temp.ago(24), null, null, null, 0),

  -- Not in medical
  (pg_temp.pid(1009), gen_random_uuid(), 1009, 'A.N.', null, 21, 'Female', null, null, null, null,
   'neonGARDEN', 'Light-up butterfly wings, black shorts', null, 'FA 3 – Kinetic', null,
   'Jo N.', '(407) 555-0164', 'Partner', null, 'Checked – Not Found', pg_temp.staff('dana'), pg_temp.staff('rae'),
   pg_temp.ago(38), pg_temp.ago(20), null, null, null, 1),
  (pg_temp.pid(1008), gen_random_uuid(), 1008, 'N.G.', null, 27, 'Male', null, 'Black, curly', null, null,
   'Main stage food court', 'White tee, camo pants', null, 'FA 4 – Oasis', null,
   null, null, null, null, 'Checked – Not Found', pg_temp.staff('lee'), pg_temp.staff('sam'),
   pg_temp.ago(45), pg_temp.ago(30), null, null, null, 1),

  -- In medical · friend coming
  (pg_temp.pid(1007), gen_random_uuid(), 1007, 'Jordan', 'Diaz', 22, 'Male', null, null, 'Sleeve tattoo, left arm', null,
   'Taken to medical', 'Kandi to elbows, white tank, sleeve tattoo', null, 'FA 4 – Oasis', null,
   'Ty B.', '(407) 555-0131', 'Friend', null, 'Found – Awaiting Reunion', pg_temp.staff('lee'), pg_temp.staff('rae'),
   pg_temp.ago(32), pg_temp.ago(2), pg_temp.ago(2), pg_temp.ago(2), null, 1),
  (pg_temp.pid(1005), 'c0ffee00-0000-4000-8000-000000001005', 1005, 'M.P.', null, 26, 'Male', null, null, 'Round glasses', null,
   'Bass pod, kineticFIELD', 'Gold sequin jacket, round glasses', null, 'FA 3 – Kinetic', null,
   'Ana P.', '(407) 555-0105', 'Girlfriend', null, 'Bring friend to medical', pg_temp.staff('alex'), pg_temp.staff('alex'),
   pg_temp.ago(80), pg_temp.ago(60), pg_temp.ago(60), null, null, 3),
  (pg_temp.pid(1004), gen_random_uuid(), 1004, 'S.L.', null, 20, 'Female', null, null, null, null,
   'kineticFIELD, near the bridge', 'Green bucket hat, mesh top', null, 'FA 3 – Kinetic', null,
   'Jess T.', '(407) 555-0187', 'Friend', null, 'Found – Awaiting Reunion', pg_temp.staff('dana'), pg_temp.staff('rae'),
   pg_temp.ago(51), pg_temp.ago(3), pg_temp.ago(3), pg_temp.ago(3), null, 2),

  -- Closed today
  (pg_temp.pid(1006), gen_random_uuid(), 1006, 'L.W.', null, 25, 'Female', null, null, null, null,
   'Command tent', 'Blue sequin dress', null, 'Command', null,
   'Rob W.', '(407) 555-0106', 'Brother', null, 'Reunited – Closed', pg_temp.staff('lee'), pg_temp.staff('sam'),
   pg_temp.ago(70), pg_temp.ago(40), pg_temp.ago(55), pg_temp.ago(55), pg_temp.ago(40), 2),
  (pg_temp.pid(1003), gen_random_uuid(), 1003, 'C.H.', null, 25, 'Male', null, null, null, null,
   'circuitGROUNDS', 'Orange jersey, silver chain', null, 'FA 4 – Oasis', null,
   'Lia H.', '(407) 555-0103', 'Friend', null, 'Reunited – Closed', pg_temp.staff('lee'), pg_temp.staff('sam'),
   pg_temp.ago(65), pg_temp.ago(34), pg_temp.ago(50), pg_temp.ago(50), pg_temp.ago(34), 2),
  (pg_temp.pid(1002), gen_random_uuid(), 1002, 'Dani', 'V.', 20, 'Female', null, null, null, null,
   'neonGARDEN', 'Holographic skirt, white sneakers', null, 'FA 3 – Kinetic', null,
   'Marco V.', '(407) 555-0102', 'Brother', null, 'Found – Discharged', pg_temp.staff('dana'), pg_temp.staff('sam'),
   pg_temp.ago(82), pg_temp.ago(45), pg_temp.ago(70), pg_temp.ago(70), pg_temp.ago(45), 2),
  (pg_temp.pid(1001), gen_random_uuid(), 1001, 'R.K.', null, 31, 'Male', null, null, null, null,
   null, 'Grey hoodie', null, 'Base', null,
   null, null, null, null, 'Cancelled', pg_temp.staff('lee'), pg_temp.staff('lee'),
   pg_temp.ago(93), pg_temp.ago(90), null, null, pg_temp.ago(90), 1),

  -- Closed yesterday (weekday-prefixed times in the list)
  (pg_temp.pid(1000), gen_random_uuid(), 1000, 'Z.A.', null, 22, 'Female', null, null, null, null,
   'kineticFIELD', 'White fringe jacket', null, 'FA 3 – Kinetic', null,
   'Omar A.', '(407) 555-0100', 'Friend', null, 'Reunited – Closed', pg_temp.staff('dana'), pg_temp.staff('sam'),
   pg_temp.ago(1500), pg_temp.ago(1460), pg_temp.ago(1480), pg_temp.ago(1480), pg_temp.ago(1460), 2),
  (pg_temp.pid(999), gen_random_uuid(), 999, 'O.B.', null, 24, 'Male', null, null, null, null,
   null, 'Black mesh shirt', null, 'FA 4 – Oasis', null,
   null, null, null, null, 'Reunited – Closed', pg_temp.staff('lee'), pg_temp.staff('rae'),
   pg_temp.ago(1530), pg_temp.ago(1490), pg_temp.ago(1510), pg_temp.ago(1510), pg_temp.ago(1490), 2),
  (pg_temp.pid(998), gen_random_uuid(), 998, 'J.H.', null, 27, 'Female', null, 'Pink', null,
   'Black tank, pink hair, glitter on face', 'Info booth', 'Black tank, pink hair, glitter on face', null,
   'FA 4 – Oasis', null, 'Kim H.', '(407) 555-0198', 'Sister', null, 'Reunited – Closed', pg_temp.staff('lee'),
   pg_temp.staff('rae'), pg_temp.ago(1560), pg_temp.ago(1500), pg_temp.ago(1530), pg_temp.ago(1530),
   pg_temp.ago(1500), 2),
  (pg_temp.pid(997), 'c0ffee00-0000-4000-8000-000000000997', 997, 'Q.T.', '', 30, 'Male', null, null, null, null,
   'Near the info booth by the main gate', 'Tie-dye shirt', 'Friend says he wanders off', 'Other', 'Info booth',
   'Vic T.', '4075550197', 'Friend', null, 'Reunited – Closed', pg_temp.staff('alex'), pg_temp.staff('alex'),
   pg_temp.ago(1620), pg_temp.ago(1540), pg_temp.ago(1570), pg_temp.ago(1570), pg_temp.ago(1540), 4),
  (pg_temp.pid(996), 'c0ffee00-0000-4000-8000-000000000996', 996, 'G.M.', '', 19, 'Female', null, null, null, null,
   null, 'Purple wig', null, 'FA 4 – Oasis', null,
   'Hal M.', '(407) 555-0196', 'Father', null, 'Reunited – Closed', pg_temp.staff('alex'), pg_temp.staff('alex'),
   pg_temp.ago(1650), pg_temp.ago(1580), pg_temp.ago(1610), pg_temp.ago(1610), pg_temp.ago(1580), 3),
  (pg_temp.pid(995), gen_random_uuid(), 995, 'Sky', 'N.', 23, 'Female', null, null, null, null,
   null, 'Silver bodysuit', null, 'Command', null,
   null, null, null, null, 'Reunited – Closed', pg_temp.staff('lee'), pg_temp.staff('sam'),
   pg_temp.ago(1680), pg_temp.ago(1620), pg_temp.ago(1650), pg_temp.ago(1650), pg_temp.ago(1620), 2),
  (pg_temp.pid(994), gen_random_uuid(), 994, 'Ben', 'A.', 26, 'Male', null, null, null, null,
   null, 'Yellow raincoat', null, 'FA 3 – Kinetic', null,
   null, null, null, null, 'Reunited – Closed', pg_temp.staff('dana'), pg_temp.staff('sam'),
   pg_temp.ago(1700), pg_temp.ago(1640), pg_temp.ago(1670), pg_temp.ago(1670), pg_temp.ago(1640), 2),
  (pg_temp.pid(993), gen_random_uuid(), 993, 'Mo', 'E.', 21, 'Male', null, null, null, null,
   null, 'Green visor', null, 'Base', null,
   null, null, null, null, 'Reunited – Closed', pg_temp.staff('lee'), pg_temp.staff('rae'),
   pg_temp.ago(1720), pg_temp.ago(1660), pg_temp.ago(1690), pg_temp.ago(1690), pg_temp.ago(1660), 2);

-- The next real request is LP-1014.
select setval('public.patient_case_number_seq', 1013, true);

-- ---------------------------------------------------------------------------------------------------
-- Photos (objects are uploaded by scripts/db-reset.sh from supabase/seed-photos/)
-- ---------------------------------------------------------------------------------------------------
insert into public.patient_photos (id, patient_id, storage_path, thumb_path, photo_timing, uploaded_by, created_at, is_active) values
  (pg_temp.photo(1012, 1), pg_temp.pid(1012),
   pg_temp.pid(1012) || '/' || pg_temp.photo(1012, 1) || '.jpg', pg_temp.pid(1012) || '/' || pg_temp.photo(1012, 1) || '_thumb.jpg',
   'today', pg_temp.staff('dana'), pg_temp.ago(11), true),
  (pg_temp.photo(1012, 2), pg_temp.pid(1012),
   pg_temp.pid(1012) || '/' || pg_temp.photo(1012, 2) || '.jpg', pg_temp.pid(1012) || '/' || pg_temp.photo(1012, 2) || '_thumb.jpg',
   'today', pg_temp.staff('dana'), pg_temp.ago(11), true),
  (pg_temp.photo(1004, 1), pg_temp.pid(1004),
   pg_temp.pid(1004) || '/' || pg_temp.photo(1004, 1) || '.jpg', pg_temp.pid(1004) || '/' || pg_temp.photo(1004, 1) || '_thumb.jpg',
   'today', pg_temp.staff('dana'), pg_temp.ago(50), true),
  -- Legacy (Jeffrey's app): random object name, no thumbnail.
  (pg_temp.photo(1005, 1), pg_temp.pid(1005),
   pg_temp.pid(1005) || '/0b1e0b1e-0000-4000-8000-000000010051.jpg', null,
   'older', pg_temp.staff('alex'), pg_temp.ago(79), true),
  (pg_temp.photo(1005, 2), pg_temp.pid(1005),
   pg_temp.pid(1005) || '/0b1e0b1e-0000-4000-8000-000000010052.jpg', null,
   'unsure', pg_temp.staff('alex'), pg_temp.ago(78), true),
  (pg_temp.photo(996, 1), pg_temp.pid(996),
   pg_temp.pid(996) || '/0b1e0b1e-0000-4000-8000-000000009961.jpg', null,
   'unsure', pg_temp.staff('alex'), pg_temp.ago(1640), true),
  -- An inactive (removed) legacy photo: never shown, never counted.
  (pg_temp.photo(996, 2), pg_temp.pid(996),
   pg_temp.pid(996) || '/0b1e0b1e-0000-4000-8000-000000009962.jpg', null,
   'today', pg_temp.staff('alex'), pg_temp.ago(1639), false);

-- ---------------------------------------------------------------------------------------------------
-- Audit events, current format
-- ---------------------------------------------------------------------------------------------------
create function pg_temp.created(p_case integer, p_staff text, p_at timestamptz) returns void
language sql as $$
  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
  select p.id, p_staff, 'patient_created', null,
         jsonb_build_object('reporting_location', p.reporting_location, 'other_location', p.other_location), p_at
  from public.patients p where p.id = pg_temp.pid(p_case)
$$;

create function pg_temp.status(p_case integer, p_staff text, p_at timestamptz, p_from text, p_to text, p_kind text,
                               p_found timestamptz, p_reunion timestamptz, p_closed timestamptz) returns void
language sql as $$
  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
  values (pg_temp.pid(p_case), p_staff, 'status_changed',
          jsonb_build_object('status', p_from, 'found_at', p_found, 'reunion_started_at', p_reunion, 'closed_at', p_closed),
          jsonb_build_object('status', p_to, 'kind', p_kind), p_at)
$$;

create function pg_temp.photo_event(p_case integer, p_n integer, p_staff text, p_at timestamptz, p_timing text) returns void
language sql as $$
  insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
  values (pg_temp.pid(p_case), p_staff, 'photo_uploaded', null,
          jsonb_build_object('photo_id', pg_temp.photo(p_case, p_n), 'photo_timing', p_timing), p_at)
$$;

select pg_temp.created(1013, pg_temp.staff('lee'), pg_temp.ago(1));

select pg_temp.created(1012, pg_temp.staff('dana'), pg_temp.ago(12));
select pg_temp.photo_event(1012, 1, pg_temp.staff('dana'), pg_temp.ago(11), 'today');
select pg_temp.photo_event(1012, 2, pg_temp.staff('dana'), pg_temp.ago(11), 'today');
insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
values (pg_temp.pid(1012), pg_temp.staff('dana'), 'patient_updated', '{"hair": null}', '{"hair": "Blond, two braids"}', pg_temp.ago(9));

select pg_temp.created(1011, pg_temp.staff('lee'), pg_temp.ago(16));
select pg_temp.created(1010, pg_temp.staff('lee'), pg_temp.ago(24));

select pg_temp.created(1009, pg_temp.staff('dana'), pg_temp.ago(38));
select pg_temp.status(1009, pg_temp.staff('rae'), pg_temp.ago(20), 'Added', 'Checked – Not Found', 'answer', null, null, null);

select pg_temp.created(1008, pg_temp.staff('lee'), pg_temp.ago(45));
select pg_temp.status(1008, pg_temp.staff('sam'), pg_temp.ago(30), 'Added', 'Checked – Not Found', 'answer', null, null, null);

select pg_temp.created(1007, pg_temp.staff('lee'), pg_temp.ago(32));
select pg_temp.status(1007, pg_temp.staff('rae'), pg_temp.ago(2), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);

select pg_temp.created(1004, pg_temp.staff('dana'), pg_temp.ago(51));
select pg_temp.photo_event(1004, 1, pg_temp.staff('dana'), pg_temp.ago(50), 'today');
select pg_temp.status(1004, pg_temp.staff('rae'), pg_temp.ago(3), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);

select pg_temp.created(1006, pg_temp.staff('lee'), pg_temp.ago(70));
select pg_temp.status(1006, pg_temp.staff('rae'), pg_temp.ago(55), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(1006, pg_temp.staff('sam'), pg_temp.ago(40), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(55), pg_temp.ago(55), null);

select pg_temp.created(1003, pg_temp.staff('lee'), pg_temp.ago(65));
select pg_temp.status(1003, pg_temp.staff('rae'), pg_temp.ago(50), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(1003, pg_temp.staff('sam'), pg_temp.ago(34), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(50), pg_temp.ago(50), null);

select pg_temp.created(1002, pg_temp.staff('dana'), pg_temp.ago(82));
select pg_temp.status(1002, pg_temp.staff('rae'), pg_temp.ago(70), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(1002, pg_temp.staff('sam'), pg_temp.ago(45), 'Found – Awaiting Reunion', 'Found – Discharged', 'discharge', pg_temp.ago(70), pg_temp.ago(70), null);

select pg_temp.created(1001, pg_temp.staff('lee'), pg_temp.ago(93));
insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at)
values (pg_temp.pid(1001), pg_temp.staff('lee'), 'cancelled',
        '{"status": "Added", "found_at": null, "reunion_started_at": null, "closed_at": null}', '{"status": "Cancelled"}', pg_temp.ago(90));

select pg_temp.created(1000, pg_temp.staff('dana'), pg_temp.ago(1500));
select pg_temp.status(1000, pg_temp.staff('rae'), pg_temp.ago(1480), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(1000, pg_temp.staff('sam'), pg_temp.ago(1460), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1480), pg_temp.ago(1480), null);

select pg_temp.created(999, pg_temp.staff('lee'), pg_temp.ago(1530));
select pg_temp.status(999, pg_temp.staff('rae'), pg_temp.ago(1510), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(999, pg_temp.staff('rae'), pg_temp.ago(1490), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1510), pg_temp.ago(1510), null);

select pg_temp.created(998, pg_temp.staff('lee'), pg_temp.ago(1560));
select pg_temp.status(998, pg_temp.staff('rae'), pg_temp.ago(1530), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(998, pg_temp.staff('rae'), pg_temp.ago(1500), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1530), pg_temp.ago(1530), null);

select pg_temp.created(995, pg_temp.staff('lee'), pg_temp.ago(1680));
select pg_temp.status(995, pg_temp.staff('sam'), pg_temp.ago(1650), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(995, pg_temp.staff('sam'), pg_temp.ago(1620), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1650), pg_temp.ago(1650), null);

select pg_temp.created(994, pg_temp.staff('dana'), pg_temp.ago(1700));
select pg_temp.status(994, pg_temp.staff('sam'), pg_temp.ago(1670), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(994, pg_temp.staff('sam'), pg_temp.ago(1640), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1670), pg_temp.ago(1670), null);

select pg_temp.created(993, pg_temp.staff('lee'), pg_temp.ago(1720));
select pg_temp.status(993, pg_temp.staff('rae'), pg_temp.ago(1690), 'Added', 'Found – Awaiting Reunion', 'answer', null, null, null);
select pg_temp.status(993, pg_temp.staff('rae'), pg_temp.ago(1660), 'Found – Awaiting Reunion', 'Reunited – Closed', 'reunite', pg_temp.ago(1690), pg_temp.ago(1690), null);

-- ---------------------------------------------------------------------------------------------------
-- Audit events, Jeffrey's legacy formats (LP-1005, LP-0997, LP-0996)
--   patient_created: new_value = the full inserted record (incl. created_by, status, client_mutation_id)
--   status_changed / patient_updated / check_completed: previous_value = the full old row,
--     new_value = the patch (incl. updated_by, updated_at and any timestamps)
--   medical_search: new_value = {outcome: 'not_found', notes}; medical_search_found: new_value = {}
--   photo_uploaded: new_value = {photo_id, photo_timing}
-- ---------------------------------------------------------------------------------------------------
create function pg_temp.legacy_record(p_case integer) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'first_name', p.first_name, 'last_name', p.last_name, 'age', p.age, 'gender', p.gender,
    'height_build', p.height_build, 'hair', p.hair, 'identifying_features', p.identifying_features,
    'physical_description', p.physical_description, 'last_seen', p.last_seen, 'clothing', p.clothing,
    'additional_notes', p.additional_notes, 'reporting_location', p.reporting_location,
    'other_location', p.other_location, 'contact_name', p.contact_name, 'contact_phone', p.contact_phone,
    'contact_relationship', p.contact_relationship, 'contact_notes', p.contact_notes))
    || jsonb_build_object('client_mutation_id', p.client_mutation_id, 'created_by', p.created_by,
                          'updated_by', p.created_by, 'status', 'Added')
  from public.patients p where p.id = pg_temp.pid(p_case)
$$;

-- Full old row as Jeffrey's server read it (select *), at a given status and timestamps.
create function pg_temp.legacy_row(p_case integer, p_status text, p_updated timestamptz,
                                   p_found timestamptz, p_reunion timestamptz, p_closed timestamptz) returns jsonb
language sql stable as $$
  select (to_jsonb(p) - 'row_version')
         || jsonb_build_object('status', p_status, 'updated_at', p_updated, 'updated_by', p.created_by,
                               'found_at', p_found, 'reunion_started_at', p_reunion, 'closed_at', p_closed)
  from public.patients p where p.id = pg_temp.pid(p_case)
$$;

-- LP-1005 M.P.: logged in Jeffrey's app, moved to the legacy 'Bring friend to medical'.
insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at) values
  (pg_temp.pid(1005), pg_temp.staff('alex'), 'patient_created', null, pg_temp.legacy_record(1005), pg_temp.ago(80)),
  (pg_temp.pid(1005), pg_temp.staff('alex'), 'photo_uploaded', null,
   jsonb_build_object('photo_id', pg_temp.photo(1005, 1), 'photo_timing', 'older'), pg_temp.ago(79)),
  (pg_temp.pid(1005), pg_temp.staff('alex'), 'photo_uploaded', null,
   jsonb_build_object('photo_id', pg_temp.photo(1005, 2), 'photo_timing', 'unsure'), pg_temp.ago(78)),
  (pg_temp.pid(1005), pg_temp.staff('alex'), 'status_changed',
   pg_temp.legacy_row(1005, 'Added', pg_temp.ago(78), null, null, null),
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(60),
                      'status', 'Bring friend to medical', 'found_at', pg_temp.ago(60), 'closed_at', null),
   pg_temp.ago(60));

-- LP-0997 Q.T.: medical_search not found, a recheck (check_completed), an edit, then found and reunited.
insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, notes, occurred_at) values
  (pg_temp.pid(997), pg_temp.staff('alex'), 'patient_created', null, pg_temp.legacy_record(997), null, pg_temp.ago(1620)),
  (pg_temp.pid(997), pg_temp.staff('alex'), 'medical_search', null,
   '{"outcome": "not_found", "notes": "Checked all three tents"}', null, pg_temp.ago(1610)),
  (pg_temp.pid(997), pg_temp.staff('alex'), 'check_completed',
   pg_temp.legacy_row(997, 'Checked – Not Found', pg_temp.ago(1610), null, null, null),
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(1590),
                      'status', 'Checked – Not Found', 'closed_at', null),
   'Rechecked after 20 minutes', pg_temp.ago(1590)),
  (pg_temp.pid(997), pg_temp.staff('alex'), 'patient_updated',
   pg_temp.legacy_row(997, 'Checked – Not Found', pg_temp.ago(1590), null, null, null)
     || '{"clothing": "Tie-dye shirt, jeans", "last_seen": "Info booth"}',
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(1580),
                      'clothing', 'Tie-dye shirt', 'last_seen', 'Near the info booth by the main gate'),
   null, pg_temp.ago(1580)),
  (pg_temp.pid(997), pg_temp.staff('alex'), 'medical_search_found', null, '{}', null, pg_temp.ago(1570)),
  (pg_temp.pid(997), pg_temp.staff('alex'), 'status_changed',
   pg_temp.legacy_row(997, 'Found – Awaiting Reunion', pg_temp.ago(1570), pg_temp.ago(1570), pg_temp.ago(1570), null),
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(1540),
                      'status', 'Reunited – Closed', 'closed_at', pg_temp.ago(1540)),
   null, pg_temp.ago(1540));

-- LP-0996 G.M.: found via medical_search_found, a photo with unknown timing, reunited.
insert into public.audit_events (patient_id, staff_name, action_type, previous_value, new_value, occurred_at) values
  (pg_temp.pid(996), pg_temp.staff('alex'), 'patient_created', null, pg_temp.legacy_record(996), pg_temp.ago(1650)),
  (pg_temp.pid(996), pg_temp.staff('alex'), 'photo_uploaded', null,
   jsonb_build_object('photo_id', pg_temp.photo(996, 1), 'photo_timing', 'unsure'), pg_temp.ago(1640)),
  (pg_temp.pid(996), pg_temp.staff('alex'), 'medical_search_found', null, '{}', pg_temp.ago(1610)),
  (pg_temp.pid(996), pg_temp.staff('alex'), 'status_changed',
   pg_temp.legacy_row(996, 'Added', pg_temp.ago(1640), null, null, null),
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(1610),
                      'status', 'Found – Awaiting Reunion', 'found_at', pg_temp.ago(1610),
                      'reunion_started_at', pg_temp.ago(1610), 'closed_at', null),
   pg_temp.ago(1610)),
  (pg_temp.pid(996), pg_temp.staff('alex'), 'status_changed',
   pg_temp.legacy_row(996, 'Found – Awaiting Reunion', pg_temp.ago(1610), pg_temp.ago(1610), pg_temp.ago(1610), null),
   jsonb_build_object('updated_by', pg_temp.staff('alex'), 'updated_at', pg_temp.ago(1580),
                      'status', 'Reunited – Closed', 'closed_at', pg_temp.ago(1580)),
   pg_temp.ago(1580));

commit;
