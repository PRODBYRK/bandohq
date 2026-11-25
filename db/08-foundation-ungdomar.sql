-- =====================================================================
--  BANDO FOUNDATION — FAS 2: UNGDOMAR & WORKSHOPS (2026-11)
--  Masterplanen avsnitt 19, fas 2: ansökan från hemsidan → B:s översikt → kontakt (sms via
--  telefonens egen app, loggas här) → inbjudan till rätt aktivitet (C) → närvaro, observationer,
--  medgivanden för foto och film (via länk) → uppföljning.
--
--  Behörighet (beslut 2026-11-25):
--    fd_youth_ok()  B:s medlemmar och de med protected_data ser och ändrar ungdomarnas uppgifter.
--    C (aktivitetens avdelning) ser bara namn, grupp, svar och närvaro för sina aktiviteter (fd_roster).
--    Admin utan protected_data ser bara antal (fd_youth_stats).
--  Gallring: uppgifterna sparas i 24 månader efter senaste aktivitet (integritetspolicyn), sedan
--  raderas de (fd_purge_youth, dagligen via pg_cron).
--  Loggen (record_history, kind 'fd.youth'/'fd.activity'/'fd.consent') bär aldrig namn eller kontaktuppgifter.
--  Körs efter 07. Går att köra flera gånger.
-- =====================================================================

create table if not exists fd_applicants (
  id               text primary key default bs_uid('fa_'),
  name             text not null check (length(trim(name)) >= 2),
  email            text not null default '',
  phone            text not null default '',
  area             text not null default '',
  role_interest    text not null default '',
  source           text not null default '',
  wants_member     boolean not null default false,
  wants_info       boolean not null default false,
  birth_year       int check (birth_year between 1990 and 2030),
  guardian_name    text not null default '',
  guardian_phone   text not null default '',
  guardian_email   text not null default '',
  program          text not null default 'Behind the Release',
  origin           text not null default 'manuell' check (origin in ('hemsidan','workshop','manuell')),
  external_id      text unique,
  status           text not null default 'new'
                   check (status in ('new','contacted','invited','attended','selected','not_selected','withdrawn')),
  assigned         text references members(id) on delete set null,
  note             text not null default '',
  consent_at       timestamptz,                 -- samtycke till lagringen (formuläret)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
create index if not exists fd_applicants_status on fd_applicants (status, created_at desc);

/* Samtalshistoriken: sms (skickat från telefonen), samtal, mejl och anteckningar. */
create table if not exists fd_contact_log (
  id           bigserial primary key,
  applicant_id text not null references fd_applicants(id) on delete cascade,
  kind         text not null check (kind in ('sms','samtal','mejl','anteckning')),
  template_id  text,
  body         text not null default '' check (length(body) <= 2000),
  by_id        text references members(id) on delete set null,
  at           timestamptz not null default now()
);
create index if not exists fd_contact_log_app on fd_contact_log (applicant_id, at desc);

/* Mallar (Samuels standard-sms m.fl.). [förnamn], [avsändare], [ämne], [datum], [tid], [plats] fylls i. */
create table if not exists fd_templates (
  id         text primary key default bs_uid('fm_'),
  dept       text not null default 'B' references fd_departments(code),
  name       text not null check (length(trim(name)) >= 2),
  kind       text not null default 'sms' check (kind in ('sms','mejl')),
  body       text not null check (length(body) between 1 and 1600),
  sort       int not null default 100,
  updated_by text references members(id) on delete set null,
  updated_at timestamptz not null default now()
);

/* Aktiviteter (workshops, träffar). Planeras av C; B bjuder in. */
create table if not exists fd_activities (
  id             text primary key default bs_uid('fac_'),
  dept           text not null default 'C' references fd_departments(code),
  title          text not null check (length(trim(title)) >= 2),
  kind           text not null default 'workshop' check (kind in ('workshop','aktivitet','träff')),
  date           date not null,
  start_time     text not null default '' check (start_time = '' or start_time ~ '^\d\d:\d\d$'),
  end_time       text not null default '' check (end_time = '' or end_time ~ '^\d\d:\d\d$'),
  place          text not null default '',
  capacity       int check (capacity is null or capacity > 0),
  description    text not null default '',
  lead_id        text references members(id) on delete set null,
  status         text not null default 'planned' check (status in ('planned','done','cancelled')),
  follow_summary text not null default '',
  follow_good    text not null default '',
  follow_improve text not null default '',
  created_by     text references members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create table if not exists fd_activity_groups (
  id          text primary key default bs_uid('fag_'),
  activity_id text not null references fd_activities(id) on delete cascade,
  name        text not null check (length(trim(name)) >= 1),
  sort        int not null default 0
);
create table if not exists fd_participants (
  activity_id   text not null references fd_activities(id) on delete cascade,
  applicant_id  text not null references fd_applicants(id) on delete cascade,
  group_id      text references fd_activity_groups(id) on delete set null,
  invite_status text not null default 'invited' check (invite_status in ('invited','yes','no')),
  attendance    text check (attendance in ('present','absent')),
  observation   text not null default '' check (length(observation) <= 2000),
  invited_by    text references members(id) on delete set null,
  invited_at    timestamptz not null default now(),
  updated_by    text references members(id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (activity_id, applicant_id)
);

/* Medgivanden för foto och film. Länken (token) går till målsman (under 18) eller ungdomen själv. */
create table if not exists fd_consents (
  id            text primary key default bs_uid('fcs_'),
  applicant_id  text not null references fd_applicants(id) on delete cascade,
  token         text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  signer        text not null default 'guardian' check (signer in ('guardian','self')),
  status        text not null default 'sent' check (status in ('sent','approved','denied')),
  choices       jsonb not null default '{}'::jsonb,
  answered_name text not null default '',
  answered_at   timestamptz,
  created_by    text references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '60 days'
);
create index if not exists fd_consents_app on fd_consents (applicant_id, created_at desc);

-- ---------------------------------------------------------------------
--  BEHÖRIGHET
-- ---------------------------------------------------------------------
create or replace function fd_youth_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(fd_protected_ok() or fd_in('B'), false)
$$;
/* Får läsa/ändra en deltagarrad: B/skyddad åtkomst, eller aktivitetens avdelning. */
create or replace function fd_activity_staff(p_activity text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(fd_youth_ok() or fd_admin() or (select fd_in(dept) from fd_activities where id = p_activity), false)
$$;

alter table fd_applicants enable row level security;
alter table fd_contact_log enable row level security;
alter table fd_templates enable row level security;
alter table fd_activities enable row level security;
alter table fd_activity_groups enable row level security;
alter table fd_participants enable row level security;
alter table fd_consents enable row level security;

drop policy if exists fd_applicants_all on fd_applicants;
create policy fd_applicants_all on fd_applicants for all to authenticated using (fd_youth_ok()) with check (fd_youth_ok());
drop policy if exists fd_contact_log_read on fd_contact_log;
create policy fd_contact_log_read on fd_contact_log for select to authenticated using (fd_youth_ok());
drop policy if exists fd_contact_log_insert on fd_contact_log;
create policy fd_contact_log_insert on fd_contact_log for insert to authenticated with check (fd_youth_ok() and by_id = bs_my_id());
drop policy if exists fd_consents_read on fd_consents;
create policy fd_consents_read on fd_consents for select to authenticated using (fd_youth_ok());

drop policy if exists fd_templates_read on fd_templates;
create policy fd_templates_read on fd_templates for select to authenticated using (fd_member());
drop policy if exists fd_templates_write on fd_templates;
create policy fd_templates_write on fd_templates for all to authenticated
  using (fd_admin() or fd_in(dept)) with check ((fd_admin() or fd_in(dept)) and updated_by = bs_my_id());

/* Aktiviteten själv (titel, datum, plats) är inget känsligt — alla i Foundation ser schemat. */
drop policy if exists fd_activities_read on fd_activities;
create policy fd_activities_read on fd_activities for select to authenticated using (fd_member());
drop policy if exists fd_activities_insert on fd_activities;
create policy fd_activities_insert on fd_activities for insert to authenticated
  with check ((fd_admin() or fd_in(dept)) and created_by = bs_my_id());
drop policy if exists fd_activities_update on fd_activities;
create policy fd_activities_update on fd_activities for update to authenticated
  using (fd_admin() or fd_in(dept) or fd_youth_ok()) with check (fd_admin() or fd_in(dept) or fd_youth_ok());
drop policy if exists fd_activities_delete on fd_activities;
create policy fd_activities_delete on fd_activities for delete to authenticated using (fd_admin() or fd_in(dept));

drop policy if exists fd_groups_read on fd_activity_groups;
create policy fd_groups_read on fd_activity_groups for select to authenticated using (fd_member());
drop policy if exists fd_groups_write on fd_activity_groups;
create policy fd_groups_write on fd_activity_groups for all to authenticated
  using (fd_activity_staff(activity_id)) with check (fd_activity_staff(activity_id));

/* Deltagarraderna: C läser dem (ids, grupp, svar, närvaro, observation) för sina aktiviteter;
   namnen får C bara via fd_roster. Bara B bjuder in och tar bort. */
drop policy if exists fd_part_read on fd_participants;
create policy fd_part_read on fd_participants for select to authenticated using (fd_activity_staff(activity_id));
drop policy if exists fd_part_insert on fd_participants;
create policy fd_part_insert on fd_participants for insert to authenticated with check (fd_youth_ok() and invited_by = bs_my_id());
drop policy if exists fd_part_update on fd_participants;
create policy fd_part_update on fd_participants for update to authenticated
  using (fd_activity_staff(activity_id)) with check (fd_activity_staff(activity_id));
drop policy if exists fd_part_delete on fd_participants;
create policy fd_part_delete on fd_participants for delete to authenticated using (fd_youth_ok());

-- ---------------------------------------------------------------------
--  TRIGGRAR: tider, status som följer arbetet, logg utan namn
-- ---------------------------------------------------------------------
create or replace function fd_applicant_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now(); new.last_activity_at := now();
  if tg_op = 'UPDATE' then new.created_at := old.created_at; new.external_id := old.external_id; new.origin := old.origin; end if;
  return new;
end $$;
drop trigger if exists fd_applicant_stamp on fd_applicants;
create trigger fd_applicant_stamp before insert or update on fd_applicants for each row execute function fd_applicant_stamp();

create or replace function fd_applicant_logged() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('youth', new.id, 'ny', null, jsonb_build_object('origin', new.origin, 'status', new.status));
  elsif new.status is distinct from old.status then
    perform fd_log('youth', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  return new;
end $$;
drop trigger if exists fd_applicant_logged on fd_applicants;
create trigger fd_applicant_logged after insert or update on fd_applicants for each row execute function fd_applicant_logged();

/* Kontakt: Ny → Kontaktad. Allt som händer räknas som aktivitet (gallringen). */
create or replace function fd_contact_logged() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update fd_applicants set status = case when status = 'new' and new.kind in ('sms','samtal','mejl') then 'contacted' else status end
   where id = new.applicant_id;
  return new;
end $$;
drop trigger if exists fd_contact_logged on fd_contact_log;
create trigger fd_contact_logged after insert on fd_contact_log for each row execute function fd_contact_logged();

/* Inbjudan: Ny/Kontaktad → Inbjuden. Närvarande: → Har deltagit. */
create or replace function fd_participant_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update fd_applicants set status = 'invited' where id = new.applicant_id and status in ('new','contacted');
    perform fd_log('activity', new.activity_id, 'inbjuden', null, jsonb_build_object('applicant', new.applicant_id));
    return new;
  end if;
  new.updated_at := now(); new.updated_by := bs_my_id();
  if new.attendance is distinct from old.attendance then
    if new.attendance = 'present' then
      update fd_applicants set status = 'attended' where id = new.applicant_id and status in ('new','contacted','invited');
    else
      update fd_applicants set last_activity_at = now() where id = new.applicant_id;
    end if;
    perform fd_log('activity', new.activity_id, 'närvaro', jsonb_build_object('applicant', new.applicant_id, 'attendance', old.attendance),
                   jsonb_build_object('applicant', new.applicant_id, 'attendance', new.attendance));
  end if;
  return new;
end $$;
drop trigger if exists fd_participant_ins on fd_participants;
create trigger fd_participant_ins after insert on fd_participants for each row execute function fd_participant_changed();
drop trigger if exists fd_participant_upd on fd_participants;
create trigger fd_participant_upd before update on fd_participants for each row execute function fd_participant_changed();

create or replace function fd_activity_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    if new.status is distinct from old.status then
      perform fd_log('activity', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fd_activity_stamp on fd_activities;
create trigger fd_activity_stamp before insert or update on fd_activities for each row execute function fd_activity_stamp();

-- ---------------------------------------------------------------------
--  ANSÖKAN FRÅN HEMSIDAN (anonym, med hemlig nyckel som bara hemsidans server har)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from bs_secrets where name = 'fd_intake') then
    insert into bs_secrets(name, value) values ('fd_intake', encode(extensions.gen_random_bytes(24), 'hex'));
  end if;
end $$;

create or replace function fd_apply(p_secret text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare want text := (select value from bs_secrets where name = 'fd_intake');
        d jsonb := coalesce(p_data, '{}'::jsonb);
        nm text := left(trim(coalesce(d->>'name','')), 80);
        em text := left(lower(trim(coalesce(d->>'email',''))), 160);
        ph text := left(coalesce(bs_phone(nullif(trim(coalesce(d->>'phone','')),'')), ''), 30);
        ext text := nullif(left(trim(coalesce(d->>'external_id','')), 80), '');
        org text := case when d->>'origin' in ('hemsidan','workshop') then d->>'origin' else 'hemsidan' end;
        ex fd_applicants; new_id text;
begin
  if want is null or coalesce(p_secret,'') <> want then raise exception 'Obehörig'; end if;
  if length(nm) < 2 then raise exception 'Fyll i namn'; end if;
  if em = '' and ph = '' then raise exception 'Fyll i telefonnummer eller e-post'; end if;
  if em <> '' and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-postadressen ser fel ut'; end if;
  if (select count(*) from fd_applicants where created_at > now() - interval '1 day') >= 500 then
    raise exception 'Många ansökningar just nu — försök igen senare';
  end if;
  /* samma person igen (samma källa-id, e-post eller telefon): ingen ny rad, bara ny aktivitet */
  select * into ex from fd_applicants a
   where (ext is not null and a.external_id = ext) or (em <> '' and lower(a.email) = em) or (ph <> '' and a.phone = ph)
   order by created_at limit 1;
  if ex.id is not null then
    update fd_applicants set last_activity_at = now(),
           area = coalesce(nullif(area,''), left(coalesce(d->>'area',''), 80)),
           role_interest = coalesce(nullif(role_interest,''), left(coalesce(d->>'role',''), 80)),
           phone = coalesce(nullif(phone,''), ph), email = coalesce(nullif(email,''), em)
     where fd_applicants.id = ex.id;
    return jsonb_build_object('ok', true, 'id', ex.id, 'again', true);
  end if;
  insert into fd_applicants(name, email, phone, area, role_interest, source, wants_member, wants_info, origin, external_id, consent_at, note)
  values (nm, em, ph, left(coalesce(d->>'area',''), 80), left(coalesce(d->>'role',''), 80), left(coalesce(d->>'source',''), 80),
          coalesce((d->>'member')::boolean, false), coalesce((d->>'info')::boolean, false), org, ext,
          case when coalesce((d->>'consent')::boolean, true) then now() end, left(coalesce(d->>'message',''), 1000))
  returning fd_applicants.id into new_id;
  perform fd_notify_dept('B', 'youth', 'Ny ansökan till ' || 'Behind the Release',
    'En ny ansökan har kommit in' || case when org = 'workshop' then ' via workshopanmälan' else ' via hemsidan' end || '. Öppna Ungdomar i Bando Foundation.',
    'youth', new_id);
  return jsonb_build_object('ok', true, 'id', new_id);
end $$;

-- ---------------------------------------------------------------------
--  C:s VY AV EN AKTIVITET: namn, grupp, svar, närvaro och observation — inget annat
-- ---------------------------------------------------------------------
create or replace function fd_roster(p_activity text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fd_activity_staff(p_activity) then raise exception 'Aktiviteten finns inte'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('applicant_id', p.applicant_id, 'name', a.name, 'group_id', p.group_id,
      'invite_status', p.invite_status, 'attendance', p.attendance, 'observation', p.observation,
      'updated_by', p.updated_by, 'updated_at', p.updated_at) order by a.name)
    from fd_participants p join fd_applicants a on a.id = p.applicant_id where p.activity_id = p_activity), '[]'::jsonb);
end $$;

/* Admin utan skyddad åtkomst: bara antal. */
create or replace function fd_youth_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not (fd_admin() or fd_youth_ok()) then null else jsonb_build_object(
    'total', (select count(*) from fd_applicants),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from fd_applicants group by status) x), '{}'::jsonb),
    'new_7d', (select count(*) from fd_applicants where created_at > now() - interval '7 days'),
    'activities_upcoming', (select count(*) from fd_activities where date >= current_date and status = 'planned'),
    'consents', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from fd_consents group by status) x), '{}'::jsonb)) end
$$;

-- ---------------------------------------------------------------------
--  MEDGIVANDE VIA LÄNK (foto och film)
-- ---------------------------------------------------------------------
create or replace function fd_consent_create(p_applicant text, p_signer text default 'guardian') returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fd_consents;
begin
  if not fd_youth_ok() then raise exception 'Bara B och den med behörighet för skyddade uppgifter'; end if;
  if not exists (select 1 from fd_applicants where id = p_applicant) then raise exception 'Ungdomen finns inte'; end if;
  if p_signer not in ('guardian','self') then raise exception 'Ogiltig mottagare'; end if;
  insert into fd_consents(applicant_id, signer, created_by) values (p_applicant, p_signer, bs_my_id()) returning * into c;
  update fd_applicants set last_activity_at = now() where id = p_applicant;
  perform fd_log('consent', c.id, 'skickad', null, jsonb_build_object('applicant', p_applicant, 'signer', p_signer));
  return jsonb_build_object('id', c.id, 'token', c.token, 'expires_at', c.expires_at);
end $$;

/* Sidan bakom länken (anonym): bara förnamnet och vad det gäller. */
create or replace function fd_consent_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c fd_consents; nm text;
begin
  select * into c from fd_consents where token = p_token;
  if c.id is null or length(coalesce(p_token,'')) < 20 then return jsonb_build_object('ok', false, 'why', 'Länken finns inte'); end if;
  if c.expires_at < now() then return jsonb_build_object('ok', false, 'why', 'Länken har gått ut. Be Bando Foundation om en ny.'); end if;
  select split_part(trim(name), ' ', 1) into nm from fd_applicants where id = c.applicant_id;
  return jsonb_build_object('ok', true, 'first_name', nm, 'signer', c.signer, 'status', c.status, 'choices', c.choices,
    'answered_at', c.answered_at, 'program', 'Behind the Release');
end $$;

create or replace function fd_consent_answer(p_token text, p_name text, p_approve boolean, p_choices jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fd_consents; nm text := left(trim(coalesce(p_name,'')), 80); ch jsonb;
begin
  select * into c from fd_consents where token = p_token for update;
  if c.id is null or length(coalesce(p_token,'')) < 20 then raise exception 'Länken finns inte'; end if;
  if c.expires_at < now() then raise exception 'Länken har gått ut. Be Bando Foundation om en ny.'; end if;
  if length(nm) < 2 then raise exception 'Skriv ditt namn'; end if;
  ch := jsonb_build_object('photo', coalesce((p_choices->>'photo')::boolean, false), 'film', coalesce((p_choices->>'film')::boolean, false),
                           'publish', coalesce((p_choices->>'publish')::boolean, false));
  if p_approve and not ((ch->>'photo')::boolean or (ch->>'film')::boolean) then raise exception 'Kryssa i vad du godkänner, eller tryck Nej'; end if;
  update fd_consents set status = case when p_approve then 'approved' else 'denied' end,
         choices = case when p_approve then ch else '{}'::jsonb end, answered_name = nm, answered_at = now()
   where id = c.id returning * into c;
  update fd_applicants set last_activity_at = now() where id = c.applicant_id;
  perform fd_log('consent', c.id, case when p_approve then 'godkänd' else 'nekad' end, null, jsonb_build_object('applicant', c.applicant_id, 'choices', c.choices));
  perform fd_notify(c.created_by, 'consent', case when p_approve then 'Medgivande godkänt' else 'Medgivande nekat' end,
    'Ett svar på medgivandet för foto och film har kommit in.', 'youth', c.applicant_id);
  return jsonb_build_object('ok', true, 'status', c.status);
end $$;

-- ---------------------------------------------------------------------
--  GALLRING: 24 månader efter senaste aktivitet (integritetspolicyn)
-- ---------------------------------------------------------------------
create or replace function fd_purge_youth() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from fd_applicants where last_activity_at < now() - interval '24 months';
  get diagnostics n = row_count;
  if n > 0 then
    insert into record_history(kind, rec_id, op, before, after, by_id, note)
    values ('fd.youth', 'gallring', 'gallrat', null, jsonb_build_object('n', n), null, '24 månader efter senaste aktivitet');
  end if;
  return n;
end $$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'foundation-gallring';
    perform cron.schedule('foundation-gallring', '20 3 * * *', 'select public.fd_purge_youth()');
  end if;
end $$;

-- ---------------------------------------------------------------------
--  STANDARDMALLAR (Samuels underlag, avsnitt 6)
-- ---------------------------------------------------------------------
insert into fd_templates(id, dept, name, kind, body, sort) values
  ('fm_first', 'B', 'Första kontakt', 'sms',
   'Hej [förnamn]! Jag heter [avsändare] och hör av mig från Bando Foundation. Kul att du har sökt till Behind the Release!' || E'\n' ||
   'Vi ska välja ut 40 ungdomar till ett kreativt program inom musik, film, foto, design och andra delar av branschen.' || E'\n' ||
   'Innan urvalet kommer vi bjuda in sökande till mindre workshops där ni får testa olika saker och vi får lära känna er.' || E'\n' ||
   'Jag är nyfiken, vad fick dig att söka och vad skulle du helst vilja testa?', 10),
  ('fm_invite', 'B', 'Inbjudan till aktivitet', 'sms',
   'Hej [förnamn]! Vi har en workshop inom [ämne] den [datum] kl. [tid] på [plats].' || E'\n' ||
   'Det är en del av våra aktiviteter inför urvalet till Behind the Release. Du får möjlighet att testa något kreativt och träffa oss och andra sökande.' || E'\n' ||
   'Skulle du vilja komma?', 20),
  ('fm_follow', 'B', 'Uppföljning efter aktivitet', 'sms',
   'Hej [förnamn]! Kul att du kom på workshopen! Vad tyckte du om den? Var det något du tyckte var extra roligt eller skulle vilja göra mer av?' || E'\n' ||
   'Vi hör av oss med mer information om Behind the Release och urvalet framöver.', 30),
  ('fm_consent', 'B', 'Medgivande foto och film', 'sms',
   'Hej! Det här är [avsändare] från Bando Foundation. Under våra aktiviteter fotograferar och filmar vi ibland. Här kan du svara på om det är okej för [förnamn]: [länk]', 40)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
--  RÄTTIGHETER
-- ---------------------------------------------------------------------
revoke all on function fd_applicant_stamp(), fd_applicant_logged(), fd_contact_logged(), fd_participant_changed(), fd_activity_stamp(),
  fd_purge_youth() from public, anon, authenticated;
revoke all on function fd_youth_ok(), fd_activity_staff(text), fd_roster(text), fd_youth_stats(), fd_consent_create(text, text)
  from public, anon;
grant execute on function fd_youth_ok(), fd_activity_staff(text), fd_roster(text), fd_youth_stats(), fd_consent_create(text, text)
  to authenticated;
/* hemsidans server och sidan bakom medgivandelänken: anonyma, men skyddade av nyckel/token */
revoke all on function fd_apply(text, jsonb), fd_consent_info(text), fd_consent_answer(text, text, boolean, jsonb) from public;
grant execute on function fd_apply(text, jsonb), fd_consent_info(text), fd_consent_answer(text, text, boolean, jsonb) to anon, authenticated;
revoke all on table fd_applicants, fd_contact_log, fd_templates, fd_activities, fd_activity_groups, fd_participants, fd_consents from anon;
