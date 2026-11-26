-- =====================================================================
--  BANDO FOUNDATION — FAS 3–5: CONTENT, KONTAKTER, AI-MILJÖN, FINANSIERING, UNDERSÖKNINGAR OCH ADMINISTRATION (2026-11)
--  Masterplanen avsnitt 8–12 och 16:
--    D  profiler (kontakter med medverkansalternativ) → överlämning till G, F eller C
--    E  partners i en samarbetsprocess (Identifierad → … → Aktivt samarbete)
--    F  materialbibliotek med versioner och publiceringsflöde
--    G  gemensam redaktion: produktioner Idé → … → Publicerad, intervju- och filmbrief
--    H  undersökningar med anonyma svar (publik enkät), resultat till H, C och B
--    I  bidragsdatabas, ansökningsprocess, veckorapporten som läses in, påminnelser 14/7/3 dagar
--    J  arkiv per kategori och viktiga datum
--    AI ett agentbibliotek (namn, syfte, avdelning, verktyg, godkännande, historik),
--       en gemensam kunskapsbas och en månadsbudget. Körningarna görs av edge-funktionen
--       fd-agent (Claude API) som cron väcker varje minut; ett steg per väckning.
--  AI får bara läsa det körningen gäller (ögonblicksbilden byggs här, med användarens
--  behörighet) och aldrig ungdomarnas uppgifter. AI föreslår — människor beslutar.
--  Körs efter 08. Går att köra flera gånger. Ersätter fd_can_thread, fd_can_owner,
--  fd_comments_thread och fd_thread_reader från 07 med versioner som känner de nya ägartyperna.
-- =====================================================================

-- ---------------------------------------------------------------------
--  KONTAKTER: D:s medverkansalternativ, E:s samarbetsprocess, länkar
-- ---------------------------------------------------------------------
alter table fd_contacts add column if not exists options text[] not null default '{}';
alter table fd_contacts add column if not exists stage text not null default '';
alter table fd_contacts add column if not exists links text not null default '';
alter table fd_contacts add column if not exists met_at date;
do $$ begin
  alter table fd_contacts add constraint fd_contacts_options_check
    check (options <@ array['stod','intervju','workshop','mentor']::text[]);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table fd_contacts add constraint fd_contacts_stage_check
    check (stage in ('','identified','first_contact','dialog','proposal','anchoring','agreement','active','paused'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
--  G: PRODUKTIONER
-- ---------------------------------------------------------------------
create table if not exists fd_productions (
  id             text primary key default bs_uid('fp_'),
  title          text not null check (length(trim(title)) >= 2),
  area           text not null default 'manniskorna'
                 check (area in ('manniskorna','kultur','foundation','ungdomarna')),
  kind           text not null default 'intervju' check (kind in ('intervju','reportage','film','artikel','annat')),
  status         text not null default 'idea'
                 check (status in ('idea','research','planning','recording','editing','review','published','paused')),
  owner          text references members(id) on delete set null,
  guest_contact  text references fd_contacts(id) on delete set null,
  guest_name     text not null default '',
  guest_links    text not null default '',
  angle          text not null default '',
  interview_brief text not null default '',
  brief_approved_at timestamptz,
  brief_approved_by text references members(id) on delete set null,
  film_brief     text not null default '',
  recording_date date,
  publish_date   date,
  notes          text not null default '',
  created_by     text references members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists fd_productions_status on fd_productions (status, updated_at desc);

-- ---------------------------------------------------------------------
--  F: MATERIALBIBLIOTEK (versioner = dokument på materialet) OCH PUBLICERINGAR
-- ---------------------------------------------------------------------
create table if not exists fd_materials (
  id          text primary key default bs_uid('fmt_'),
  title       text not null check (length(trim(title)) >= 2),
  category    text not null default 'presentation'
              check (category in ('presentation','ungdomar','partner','bidrag','profil','logotyp','grafik','annat')),
  audience    text not null default '',
  description text not null default '',
  current_doc text,                               -- dokumentet som gäller nu (senaste godkända versionen)
  version     int not null default 0,
  status      text not null default 'draft' check (status in ('draft','approved','archived')),
  updated_by  text references members(id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create table if not exists fd_publications (
  id            text primary key default bs_uid('fpb_'),
  title         text not null check (length(trim(title)) >= 2),
  channel       text not null default '',
  production_id text references fd_productions(id) on delete set null,
  status        text not null default 'received' check (status in ('received','review','approved','planned','published')),
  planned_date  date,
  published_url text not null default '' check (published_url = '' or published_url ~ '^https?://'),
  owner         text references members(id) on delete set null,
  notes         text not null default '',
  created_by    text references members(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  AI: AGENTER, KÖRNINGAR, KUNSKAPSBAS, INSTÄLLNINGAR
-- ---------------------------------------------------------------------
create table if not exists fd_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by text references members(id) on delete set null,
  updated_at timestamptz not null default now()
);
/* AI är avstängt tills Claude API-nyckeln är inlagd (admin slår på det under Admin → AI) */
insert into fd_settings(key, value) values ('ai', '{"budget_sek":500,"usd_sek":10.5,"model":"claude-opus-5-5","enabled":false}')
on conflict (key) do nothing;
insert into fd_settings(key, value) values ('workshop', '{"activity_id":null}') on conflict (key) do nothing;

/* Vilken aktivitet nya workshopanmälningar från hemsidan läggs in i (B, C eller admin). */
create or replace function fd_set_workshop_activity(p_activity text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (fd_admin() or fd_in('B') or fd_in('C')) then raise exception 'Bara B, C och admin'; end if;
  if p_activity is not null and not exists (select 1 from fd_activities where id = p_activity) then raise exception 'Aktiviteten finns inte'; end if;
  update fd_settings set value = jsonb_build_object('activity_id', p_activity), updated_by = bs_my_id(), updated_at = now() where key = 'workshop';
  perform fd_log('activity', coalesce(p_activity, 'ingen'), 'tar emot workshopanmälningar', null, jsonb_build_object('activity_id', p_activity));
end $$;

create table if not exists fd_agents (
  id            text primary key,
  dept          text references fd_departments(code),
  name          text not null,
  purpose       text not null default '',
  instructions  text not null default '',
  mode          text not null default 'research' check (mode in ('research','deep_dive','funding_import','writer')),
  model         text not null default 'claude-opus-5-5',
  effort        text not null default 'medium' check (effort in ('low','medium','high','xhigh','max')),
  web           boolean not null default true,
  max_searches  int not null default 8 check (max_searches between 0 and 40),
  output        text not null default '',
  approval      text not null default 'Resultatet är ett förslag. En människa granskar och beslutar.',
  active        boolean not null default true,
  updated_by    text references members(id) on delete set null,
  updated_at    timestamptz not null default now()
);

create table if not exists fd_knowledge (
  id         text primary key default bs_uid('fk_'),
  title      text not null check (length(trim(title)) >= 2),
  body       text not null default '' check (length(body) <= 20000),
  dept       text references fd_departments(code),   -- null = gäller alla agenter
  approved   boolean not null default true,
  updated_by text references members(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists fd_agent_runs (
  id          text primary key default bs_uid('frun_'),
  agent_id    text not null references fd_agents(id),
  owner_type  text not null check (owner_type in ('production','contact','grant','funding_report','survey','dept','activity')),
  owner_id    text not null,
  question    text not null default '' check (length(question) <= 4000),
  payload     jsonb not null default '{}'::jsonb,     -- ögonblicksbilden agenten får (byggs med användarens behörighet)
  state       jsonb not null default '[]'::jsonb,     -- meddelandena hittills (fortsättning vid pause_turn)
  status      text not null default 'queued' check (status in ('queued','running','continuing','done','error','cancelled','blocked')),
  steps       int not null default 0,
  attempts    int not null default 0,
  lease_until timestamptz,
  result      text not null default '',
  sources     jsonb not null default '[]'::jsonb,
  usage       jsonb not null default '{}'::jsonb,
  cost_usd    numeric not null default 0,
  error       text not null default '',
  started_by  text references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists fd_agent_runs_owner on fd_agent_runs (owner_type, owner_id, created_at desc);
create index if not exists fd_agent_runs_queue on fd_agent_runs (status, created_at);

-- ---------------------------------------------------------------------
--  I: FINANSIERING (masterplanen avsnitt 14 och Rasmus I-underlaget, avsnitt 10)
--  Bidragsdatabas, ansökningsprocess, konsulter (kontakter i I), veckorapporter som läses in.
-- ---------------------------------------------------------------------
create or replace function fd_funding_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(fd_admin() or fd_in('I') or fd_in('J') or fd_in('E'), false)
$$;
create table if not exists fd_grants (
  id                  text primary key default bs_uid('fg_'),
  name                text not null check (length(trim(name)) >= 2),
  funder              text not null default '',
  url                 text not null default '' check (url = '' or url ~ '^https?://'),
  deadline            date,
  deadline_text       text not null default '',
  amount_text         text not null default '',
  eligibility         text not null default 'unclear' check (eligibility in ('eligible','not_yet','unclear','not_eligible')),
  priority            text not null default 'B' check (priority in ('A','B','C')),
  fit_projects        text not null default '',
  requirements        text not null default '',
  next_action         text not null default '',
  analysis            text not null default '',
  previous_recipients text not null default '',
  status              text not null default 'identified'
                      check (status in ('identified','reviewed','preparing','ready','submitted','granted','denied','closed')),
  applied_amount      text not null default '',
  granted_amount      text not null default '',
  decision_terms      text not null default '',
  report_due          date,
  owner               text references members(id) on delete set null,
  verified_at         date,
  source              text not null default 'manuell' check (source in ('manuell','veckorapport','agent')),
  external_key        text unique,
  created_by          text references members(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists fd_grants_deadline on fd_grants (deadline) where status not in ('granted','denied','closed');
create table if not exists fd_funding_reports (
  id           text primary key default bs_uid('frp_'),
  body         text not null check (length(body) between 20 and 100000),
  received_at  date not null default current_date,
  grants_count int not null default 0,
  run_id       text,
  created_by   text references members(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  J: VIKTIGA DATUM (administrativa deadlines). Arkivet = dokument med ägartypen 'archive'.
-- ---------------------------------------------------------------------
create table if not exists fd_deadlines (
  id         text primary key default bs_uid('fdl_'),
  title      text not null check (length(trim(title)) >= 2),
  date       date not null,
  dept       text not null default 'J' references fd_departments(code),
  note       text not null default '',
  done       boolean not null default false,
  created_by text references members(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  H: UNDERSÖKNINGAR — svaren är alltid anonyma (beslut 2026-11-25) och blandas aldrig med B:s register
-- ---------------------------------------------------------------------
create table if not exists fd_surveys (
  id          text primary key default bs_uid('fs_'),
  title       text not null check (length(trim(title)) >= 2),
  kind        text not null default 'internal' check (kind in ('internal','societal')),
  activity_id text references fd_activities(id) on delete set null,
  intro       text not null default '',
  questions   jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  status      text not null default 'draft' check (status in ('draft','open','closed')),
  token       text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  created_by  text references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists fd_survey_responses (
  id         bigserial primary key,
  survey_id  text not null references fd_surveys(id) on delete cascade,
  answers    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists fd_survey_responses_s on fd_survey_responses (survey_id);

/* Resultat: H och admin; för en utvärdering kopplad till en aktivitet även aktivitetens folk (C och B). */
create or replace function fd_survey_results_ok(p_survey text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(fd_admin() or fd_in('H') or exists (select 1 from fd_surveys s where s.id = p_survey and s.activity_id is not null
                                                        and fd_activity_staff(s.activity_id)), false)
$$;
/* Sammanställningen (internt — kontrollen görs i fd_survey_report och fd_agent_request). */
create or replace function fd_survey_results(p_survey text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('svar', (select count(*) from fd_survey_responses where survey_id = p_survey),
    'frågor', coalesce((select jsonb_agg(jsonb_build_object('id', q->>'id', 'fråga', q->>'label', 'typ', q->>'type',
      'resultat', case q->>'type'
        when 'scale' then (select jsonb_build_object('snitt', round(avg((r.answers->>(q->>'id'))::numeric), 2),
                             'fördelning', (select coalesce(jsonb_object_agg(v, n), '{}'::jsonb) from (select r2.answers->>(q->>'id') v, count(*) n
                               from fd_survey_responses r2 where r2.survey_id = p_survey and r2.answers ? (q->>'id') group by 1) x))
                           from fd_survey_responses r where r.survey_id = p_survey and r.answers ? (q->>'id'))
        when 'choice' then (select coalesce(jsonb_object_agg(v, n), '{}'::jsonb) from (select r.answers->>(q->>'id') v, count(*) n
                              from fd_survey_responses r where r.survey_id = p_survey and r.answers ? (q->>'id') group by 1) x)
        else (select coalesce(jsonb_agg(r.answers->>(q->>'id') order by r.id), '[]'::jsonb) from (select * from fd_survey_responses r
                where r.survey_id = p_survey and coalesce(r.answers->>(q->>'id'), '') <> '' order by id desc limit 300) r) end)
      order by ord) from fd_surveys s, jsonb_array_elements(s.questions) with ordinality as e(q, ord) where s.id = p_survey), '[]'::jsonb))
$$;
create or replace function fd_survey_report(p_survey text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fd_survey_results_ok(p_survey) then raise exception 'Resultaten ser H, admin och aktivitetens ansvariga'; end if;
  return fd_survey_results(p_survey);
end $$;
/* Sidan bakom enkätlänken (anonym). */
create or replace function fd_survey_info(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('ok', status = 'open', 'why', case when status = 'open' then '' when status = 'closed'
           then 'Undersökningen är stängd. Tack ändå!' else 'Undersökningen har inte öppnat än.' end,
           'title', title, 'intro', intro, 'questions', questions)
         from fd_surveys where token = p_token and length(coalesce(p_token,'')) >= 16), jsonb_build_object('ok', false, 'why', 'Länken finns inte'))
$$;
create or replace function fd_survey_answer(p_token text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s fd_surveys; clean jsonb := '{}'::jsonb; q jsonb; v jsonb;
begin
  select * into s from fd_surveys where token = p_token and length(coalesce(p_token,'')) >= 16;
  if s.id is null then raise exception 'Länken finns inte'; end if;
  if s.status <> 'open' then raise exception 'Undersökningen är inte öppen'; end if;
  if (select count(*) from fd_survey_responses where survey_id = s.id and created_at > now() - interval '1 hour') >= 500 then
    raise exception 'Många svar just nu — försök igen om en stund';
  end if;
  /* bara frågornas egna id, och värden av rätt sort */
  for q in select x from jsonb_array_elements(s.questions) x loop
    v := p_answers -> (q->>'id');
    if v is null or v = 'null'::jsonb then continue; end if;
    if q->>'type' = 'scale' then
      if jsonb_typeof(v) <> 'number' or (v::text)::numeric not between 1 and 5 then raise exception 'Ogiltigt svar'; end if;
    elsif q->>'type' = 'choice' then
      if jsonb_typeof(v) <> 'string' or not (coalesce(q->'options','[]'::jsonb) ? (v #>> '{}')) then raise exception 'Ogiltigt svar'; end if;
    else
      v := to_jsonb(left(trim(v #>> '{}'), 2000));
    end if;
    clean := clean || jsonb_build_object(q->>'id', v);
  end loop;
  if clean = '{}'::jsonb then raise exception 'Svara på minst en fråga'; end if;
  insert into fd_survey_responses(survey_id, answers) values (s.id, clean);
  return jsonb_build_object('ok', true);
end $$;

/* Veckorapporten (agenten a_fundimport) → bidragsposter. Uppdaterar samma post i stället för dubbletter. */
create or replace function fd_grants_import(p_run text, p_json text) returns int
language plpgsql security definer set search_path = public as $$
declare d jsonb; g jsonb; n int := 0; k text; rep text; by_id text;
begin
  begin d := p_json::jsonb; exception when others then return 0; end;
  select owner_id, started_by into rep, by_id from fd_agent_runs where id = p_run;
  for g in select x from jsonb_array_elements(coalesce(d->'grants', '[]'::jsonb)) x loop
    if length(trim(coalesce(g->>'name',''))) < 2 then continue; end if;
    k := lower(regexp_replace(trim(g->>'name') || '|' || trim(coalesce(g->>'funder','')), '\s+', ' ', 'g'));
    insert into fd_grants(name, funder, url, deadline, deadline_text, amount_text, eligibility, priority, fit_projects, requirements,
                          next_action, analysis, previous_recipients, verified_at, source, external_key, created_by)
    values (left(trim(g->>'name'), 200), left(coalesce(g->>'funder',''), 200),
            case when coalesce(g->>'url','') ~ '^https?://' then g->>'url' else '' end,
            case when coalesce(g->>'deadline','') ~ '^\d{4}-\d\d-\d\d$' then (g->>'deadline')::date end,
            left(coalesce(g->>'deadline_text',''), 200), left(coalesce(g->>'amount_text',''), 200),
            case when g->>'eligibility' in ('eligible','not_yet','unclear','not_eligible') then g->>'eligibility' else 'unclear' end,
            case when g->>'priority' in ('A','B','C') then g->>'priority' else 'B' end,
            left(coalesce(g->>'fit_projects',''), 2000), left(coalesce(g->>'requirements',''), 4000), left(coalesce(g->>'next_action',''), 1000),
            left(coalesce(g->>'analysis',''), 8000), left(coalesce(g->>'previous_recipients',''), 4000),
            case when coalesce((g->>'verified')::boolean, false) then current_date end, 'veckorapport', k, by_id)
    on conflict (external_key) do update set
      url = coalesce(nullif(excluded.url, ''), fd_grants.url), deadline = coalesce(excluded.deadline, fd_grants.deadline),
      deadline_text = coalesce(nullif(excluded.deadline_text, ''), fd_grants.deadline_text),
      amount_text = coalesce(nullif(excluded.amount_text, ''), fd_grants.amount_text),
      requirements = coalesce(nullif(excluded.requirements, ''), fd_grants.requirements),
      analysis = coalesce(nullif(excluded.analysis, ''), fd_grants.analysis),
      verified_at = coalesce(excluded.verified_at, fd_grants.verified_at), updated_at = now();
    n := n + 1;
  end loop;
  update fd_funding_reports set grants_count = n, run_id = p_run where id = rep;
  perform fd_log('grant', coalesce(rep, p_run), 'veckorapport inläst', null, jsonb_build_object('n', n));
  return n;
end $$;

/* Påminnelser 14, 7 och 3 dagar före en bidragsdeadline (I och ansvarig) och 7 och 1 dag före J:s datum. */
create or replace function fd_daily_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare g fd_grants; d fd_deadlines; left_days int; n int := 0; today date := (now() at time zone 'Europe/Stockholm')::date;
begin
  for g in select * from fd_grants where deadline in (today + 14, today + 7, today + 3)
             and status not in ('submitted','granted','denied','closed') loop
    left_days := g.deadline - today;
    perform fd_notify_dept('I', 'grant', 'Deadline om ' || left_days || ' dagar: ' || g.name,
      coalesce(nullif(g.funder,'') || ' · ', '') || 'Nästa steg: ' || coalesce(nullif(g.next_action,''), 'ta ställning till ansökan') || '.', 'grant', g.id);
    if g.owner is not null and not exists (select 1 from fd_memberships where member_id = g.owner and dept = 'I') then
      perform fd_notify(g.owner, 'grant', 'Deadline om ' || left_days || ' dagar: ' || g.name, '', 'grant', g.id);
    end if;
    n := n + 1;
  end loop;
  for d in select * from fd_deadlines where not done and date in (today + 7, today + 1) loop
    perform fd_notify_dept(d.dept, 'deadline', (case when d.date = today + 1 then 'I morgon: ' else 'Om en vecka: ' end) || d.title, d.note, 'dept', d.dept);
    n := n + 1;
  end loop;
  return n;
end $$;

/* Automatisk veckorapport till Foundation-admin (måndag morgon): siffror, inga personuppgifter. */
create or replace function fd_weekly_report() returns int
language plpgsql security definer set search_path = public as $$
declare m text; body text; n int := 0;
begin
  body := concat_ws(E'\n',
    'Senaste 7 dagarna: ' || (select count(*) from fd_tasks where status = 'done' and done_at > now() - interval '7 days') || ' uppgifter klara, '
      || (select count(*) from fd_handovers where created_at > now() - interval '7 days') || ' nya överlämningar, '
      || (select count(*) from fd_applicants where created_at > now() - interval '7 days') || ' nya ansökningar.',
    'Väntar på mottagare: ' || (select count(*) from fd_handovers where status = 'sent') || ' överlämningar. Utan ansvarig: '
      || (select count(*) from fd_tasks where assignee is null and status <> 'done') || ' uppgifter.',
    'Redaktionen: ' || (select count(*) from fd_productions where status not in ('published','paused')) || ' pågående produktioner.',
    'Bidrag med deadline inom 14 dagar: ' || (select count(*) from fd_grants where deadline between current_date and current_date + 14
      and status not in ('submitted','granted','denied','closed')) || '.',
    'AI denna månad: ' || (fd_ai_budget()->>'spent_sek') || ' av ' || (fd_ai_budget()->>'budget_sek') || ' kr.');
  for m in select id from members where active and 'foundation_admin' = any(perms) loop
    perform fd_notify(m, 'report', 'Veckorapport Bando Foundation', body, 'admin', 'overview');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
--  ÄGARTYPERNA FÖR KOMMENTARER OCH DOKUMENT
-- ---------------------------------------------------------------------
alter table fd_threads drop constraint if exists fd_threads_owner_type_check;
alter table fd_threads add constraint fd_threads_owner_type_check check (owner_type in ('task','handover','production','grant','publication'));
alter table fd_documents drop constraint if exists fd_documents_owner_type_check;
alter table fd_documents add constraint fd_documents_owner_type_check
  check (owner_type in ('task','handover','project','contact','production','material','grant','survey','archive','publication'));

/* Avdelningen som äger något (för omnämnanden och notiser). */
create or replace function fd_owner_dept(p_type text, p_id text) returns text
language sql stable security definer set search_path = public as $$
  select case p_type when 'production' then 'G' when 'publication' then 'F' when 'material' then 'F'
                     when 'grant' then 'I' when 'archive' then 'J' when 'survey' then 'H'
                     when 'task' then (select dept from fd_tasks where id = p_id)
                     when 'handover' then (select to_dept from fd_handovers where id = p_id)
                     when 'contact' then (select dept from fd_contacts where id = p_id) end
$$;
create or replace function fd_can_owner(p_type text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case p_type
    when 'task' then fd_can_task(p_id)
    when 'handover' then fd_can_handover(p_id)
    when 'contact' then fd_can_contact(p_id)
    when 'project' then exists (select 1 from fd_threads t where t.id = p_id and t.kind = 'project') and fd_can_thread(p_id)
    /* G:s planering och F:s bibliotek är gemensamma för alla i Foundation */
    when 'production' then fd_member() and exists (select 1 from fd_productions where id = p_id)
    when 'material' then fd_member() and exists (select 1 from fd_materials where id = p_id)
    when 'publication' then fd_member() and exists (select 1 from fd_publications where id = p_id)
    when 'grant' then fd_funding_ok() and exists (select 1 from fd_grants where id = p_id)
    when 'survey' then fd_member() and exists (select 1 from fd_surveys where id = p_id)
    /* J:s arkiv: owner_id är kategorin */
    when 'archive' then (fd_admin() or fd_in('J')) and p_id in ('stadgar','protokoll','firma','avtal','budget','faktura','bidragsbeslut','aterrapport','ovrigt')
    else false end, false)
$$;
create or replace function fd_can_thread(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (not t.protected or fd_protected_ok()) and case t.kind
      when 'dept' then fd_admin() or fd_in(t.dept)
      when 'comments' then fd_can_owner(t.owner_type, t.owner_id)
      when 'project' then fd_admin() or exists (select 1 from fd_thread_members x where x.thread_id = t.id and x.member_id = bs_my_id())
      else exists (select 1 from fd_thread_members x where x.thread_id = t.id and x.member_id = bs_my_id()) end
    from fd_threads t where t.id = p_id), false)
$$;
create or replace function fd_comments_thread(p_owner_type text, p_owner_id text) returns text
language plpgsql security definer set search_path = public as $$
declare tid text;
begin
  if p_owner_type not in ('task','handover','production','grant','publication') or not fd_can_owner(p_owner_type, p_owner_id) then
    raise exception 'Ärendet finns inte';
  end if;
  select id into tid from fd_threads where kind = 'comments' and owner_type = p_owner_type and owner_id = p_owner_id;
  if tid is null then
    insert into fd_threads(kind, owner_type, owner_id, created_by, protected)
    values ('comments', p_owner_type, p_owner_id, bs_my_id(),
      coalesce(case p_owner_type when 'task' then (select protected from fd_tasks where id = p_owner_id)
                                 when 'handover' then (select protected from fd_handovers where id = p_owner_id) end, false))
    on conflict do nothing returning id into tid;
    if tid is null then select id into tid from fd_threads where kind = 'comments' and owner_type = p_owner_type and owner_id = p_owner_id; end if;
  end if;
  return tid;
end $$;
create or replace function fd_thread_reader(p_thread text, p_member text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case t.kind
      when 'dept' then exists (select 1 from fd_memberships where member_id = p_member and dept = t.dept)
                    or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      when 'comments' then case when t.owner_type in ('task','handover') then
                             exists (select 1 from fd_memberships f where f.member_id = p_member and f.dept in (
                               select dept from fd_tasks where id = t.owner_id
                               union select from_dept from fd_handovers where id = t.owner_id
                               union select to_dept from fd_handovers where id = t.owner_id))
                             or exists (select 1 from fd_tasks where id = t.owner_id and p_member in (assignee, created_by))
                             or exists (select 1 from fd_handovers where id = t.owner_id and p_member in (from_member, to_member))
                           when t.owner_type = 'grant' then exists (select 1 from fd_memberships where member_id = p_member and dept in ('I','J','E'))
                           else exists (select 1 from fd_memberships where member_id = p_member) end
                        or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      when 'project' then exists (select 1 from fd_thread_members where thread_id = t.id and member_id = p_member)
                       or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      else exists (select 1 from fd_thread_members where thread_id = t.id and member_id = p_member) end
    from fd_threads t where t.id = p_thread), false)
$$;

-- ---------------------------------------------------------------------
--  RLS
-- ---------------------------------------------------------------------
alter table fd_productions enable row level security;
alter table fd_materials enable row level security;
alter table fd_publications enable row level security;
alter table fd_settings enable row level security;
alter table fd_agents enable row level security;
alter table fd_knowledge enable row level security;
alter table fd_agent_runs enable row level security;

drop policy if exists fd_productions_read on fd_productions;
create policy fd_productions_read on fd_productions for select to authenticated using (fd_member());
drop policy if exists fd_productions_insert on fd_productions;
create policy fd_productions_insert on fd_productions for insert to authenticated
  with check ((fd_admin() or fd_in('G')) and created_by = bs_my_id());
drop policy if exists fd_productions_update on fd_productions;
create policy fd_productions_update on fd_productions for update to authenticated
  using (fd_admin() or fd_in('G') or owner = bs_my_id()) with check (fd_admin() or fd_in('G') or owner = bs_my_id());

drop policy if exists fd_materials_read on fd_materials;
create policy fd_materials_read on fd_materials for select to authenticated using (fd_member());
drop policy if exists fd_materials_write on fd_materials;
create policy fd_materials_write on fd_materials for all to authenticated
  using (fd_admin() or fd_in('F')) with check ((fd_admin() or fd_in('F')) and updated_by = bs_my_id());

drop policy if exists fd_publications_read on fd_publications;
create policy fd_publications_read on fd_publications for select to authenticated using (fd_member());
drop policy if exists fd_publications_insert on fd_publications;
create policy fd_publications_insert on fd_publications for insert to authenticated
  with check ((fd_admin() or fd_in('F') or fd_in('G')) and created_by = bs_my_id());
drop policy if exists fd_publications_update on fd_publications;
create policy fd_publications_update on fd_publications for update to authenticated
  using (fd_admin() or fd_in('F') or fd_in('G')) with check (fd_admin() or fd_in('F') or fd_in('G'));

drop policy if exists fd_settings_read on fd_settings;
create policy fd_settings_read on fd_settings for select to authenticated using (fd_member());
drop policy if exists fd_agents_read on fd_agents;
create policy fd_agents_read on fd_agents for select to authenticated using (fd_member());
drop policy if exists fd_agents_write on fd_agents;
create policy fd_agents_write on fd_agents for update to authenticated using (fd_admin()) with check (fd_admin() and updated_by = bs_my_id());
drop policy if exists fd_knowledge_read on fd_knowledge;
create policy fd_knowledge_read on fd_knowledge for select to authenticated using (fd_member());
drop policy if exists fd_knowledge_write on fd_knowledge;
create policy fd_knowledge_write on fd_knowledge for all to authenticated using (fd_admin()) with check (fd_admin() and updated_by = bs_my_id());
/* körningar: den som startade, admin, och den som får läsa det körningen gäller */
drop policy if exists fd_agent_runs_read on fd_agent_runs;
create policy fd_agent_runs_read on fd_agent_runs for select to authenticated
  using (started_by = bs_my_id() or fd_admin()
         or (owner_type in ('production','contact','grant','survey') and fd_can_owner(owner_type, owner_id))
         or (owner_type = 'dept' and fd_in(owner_id))
         or (owner_type = 'funding_report' and fd_funding_ok()));

create or replace function fd_touch_updated() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists fd_productions_touch on fd_productions;
create trigger fd_productions_touch before update on fd_productions for each row execute function fd_touch_updated();
drop trigger if exists fd_publications_touch on fd_publications;
create trigger fd_publications_touch before update on fd_publications for each row execute function fd_touch_updated();

/* G: statusbyte loggas; notis till ansvarig när någon annan flyttar produktionen */
create or replace function fd_production_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('production', new.id, 'skapad', null, jsonb_build_object('title', new.title, 'status', new.status));
  elsif new.status is distinct from old.status then
    perform fd_log('production', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
    perform fd_notify(new.owner, 'production', 'Produktionen ' || new.title || ' är nu ' ||
      case new.status when 'idea' then 'en idé' when 'research' then 'i research' when 'planning' then 'i planering'
        when 'recording' then 'i inspelning' when 'editing' then 'i redigering' when 'review' then 'i granskning'
        when 'published' then 'publicerad' else 'pausad' end, '', 'production', new.id);
  end if;
  return new;
end $$;
drop trigger if exists fd_production_changed on fd_productions;
create trigger fd_production_changed after insert or update on fd_productions for each row execute function fd_production_changed();

/* F: en ny fil på ett material blir nästa version och den som gäller */
create or replace function fd_material_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_type = 'material' then
    update fd_materials set version = version + 1, current_doc = new.id, updated_at = now(), updated_by = coalesce(new.uploaded_by, updated_by)
     where id = new.owner_id;
  end if;
  return new;
end $$;
/* Nya versioner av F:s material och filer i J:s arkiv: bara den avdelningen (och admin) */
drop policy if exists fd_documents_owner_write on fd_documents;
create policy fd_documents_owner_write on fd_documents as restrictive for insert to authenticated
  with check ((owner_type <> 'material' or fd_admin() or fd_in('F')) and (owner_type <> 'archive' or fd_admin() or fd_in('J')));
drop trigger if exists fd_material_version on fd_documents;
create trigger fd_material_version after insert on fd_documents for each row execute function fd_material_version();

-- ---------------------------------------------------------------------
--  AI: BEGÄRAN (med användarens behörighet), KÖ OCH RESULTAT (edge-funktionen, servernyckeln)
-- ---------------------------------------------------------------------
/* Vad som spenderats den här kalendermånaden (kr) och taket. */
create or replace function fd_ai_budget() returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select value from fd_settings where key = 'ai'),
       m as (select coalesce(sum(cost_usd), 0) usd, count(*) n from fd_agent_runs where created_at >= date_trunc('month', now()))
  select jsonb_build_object('budget_sek', (select (value->>'budget_sek')::numeric from s),
    'usd_sek', (select (value->>'usd_sek')::numeric from s), 'enabled', (select coalesce((value->>'enabled')::boolean, true) from s),
    'spent_usd', round(m.usd, 4), 'spent_sek', round(m.usd * (select (value->>'usd_sek')::numeric from s), 2), 'runs', m.n)
  from m
$$;
create or replace function fd_save_ai_settings(p_budget_sek numeric, p_usd_sek numeric, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin'; end if;
  if p_budget_sek < 0 or p_budget_sek > 100000 or p_usd_sek <= 0 or p_usd_sek > 100 then raise exception 'Orimliga värden'; end if;
  update fd_settings set value = value || jsonb_build_object('budget_sek', p_budget_sek, 'usd_sek', p_usd_sek, 'enabled', p_enabled),
         updated_by = bs_my_id(), updated_at = now() where key = 'ai';
  perform fd_log('ai', 'settings', 'inställningar', null, jsonb_build_object('budget_sek', p_budget_sek, 'usd_sek', p_usd_sek, 'enabled', p_enabled));
  return fd_ai_budget();
end $$;

/* Ögonblicksbilden av det körningen gäller — aldrig telefon, e-post eller ungdomsuppgifter. */
create or replace function fd_agent_snapshot(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if p_type = 'production' then
    select jsonb_build_object('produktion', jsonb_build_object('titel', p.title, 'område', p.area, 'typ', p.kind, 'status', p.status,
             'gäst', coalesce(nullif(p.guest_name, ''), c.name), 'länkar', concat_ws(E'\n', nullif(p.guest_links, ''), nullif(c.links, '')),
             'vinkel', p.angle, 'intervjubrief', p.interview_brief, 'anteckningar', p.notes,
             'om gästen (D)', case when c.id is null then null else jsonb_build_object('område', c.area, 'kommentar', c.note, 'status', c.status) end))
      into r from fd_productions p left join fd_contacts c on c.id = p.guest_contact where p.id = p_id;
  elsif p_type = 'contact' then
    select jsonb_build_object('kontakt', jsonb_build_object('namn', name, 'typ', kind, 'avdelning', dept, 'område', area, 'status', status,
             'kommentar', note, 'nästa steg', next_step, 'medverkan', options, 'process', stage, 'länkar', links))
      into r from fd_contacts where id = p_id and not protected;
  elsif p_type = 'grant' then
    select jsonb_build_object('bidrag', to_jsonb(g) - 'created_by' - 'owner') into r from fd_grants g where id = p_id;
  elsif p_type = 'funding_report' then
    select jsonb_build_object('veckorapport', body, 'mottagen', received_at) into r from fd_funding_reports where id = p_id;
  elsif p_type = 'survey' then
    select jsonb_build_object('undersökning', jsonb_build_object('titel', title, 'typ', kind, 'frågor', questions), 'resultat', fd_survey_results(id))
      into r from fd_surveys where id = p_id;
  elsif p_type = 'activity' then
    select jsonb_build_object('aktivitet', jsonb_build_object('titel', title, 'typ', kind, 'datum', date, 'plats', place, 'innehåll', description,
             'uppföljning', concat_ws(E'\n', follow_summary, follow_good, follow_improve))) into r from fd_activities where id = p_id;
  elsif p_type = 'dept' then
    select jsonb_build_object('avdelning', jsonb_build_object('kod', d.code, 'namn', d.name, 'uppdrag', d.mission),
             'uppdatering', (select to_jsonb(u) - 'dept' - 'updated_by' from fd_dept_updates u where u.dept = d.code))
      into r from fd_departments d where d.code = p_id;
  end if;
  return coalesce(r, '{}'::jsonb);
end $$;

/* Starta en agent på något (bara den som får läsa det, och bara inom budgeten). */
create or replace function fd_agent_request(p_agent text, p_owner_type text, p_owner_id text, p_question text default '') returns text
language plpgsql security definer set search_path = public as $$
declare a fd_agents; b jsonb := fd_ai_budget(); rid text; me text := bs_my_id(); know jsonb;
begin
  if me is null or not fd_member() then raise exception 'Du har ingen åtkomst till Foundation'; end if;
  select * into a from fd_agents where id = p_agent and active;
  if a.id is null then raise exception 'Agenten finns inte eller är avstängd'; end if;
  if not coalesce((b->>'enabled')::boolean, true) then raise exception 'AI är avstängt av admin'; end if;
  if (b->>'spent_sek')::numeric >= (b->>'budget_sek')::numeric then raise exception 'Månadens AI-budget är slut (% kr). Admin kan höja den.', b->>'budget_sek'; end if;
  /* agenten arbetar åt sin avdelning (admin kan använda alla) */
  if a.dept is not null and not (fd_admin() or fd_in(a.dept)) then raise exception 'Agenten hör till avdelning %', a.dept; end if;
  if not (case p_owner_type
       when 'dept' then fd_admin() or fd_in(p_owner_id)
       when 'funding_report' then fd_funding_ok() and exists (select 1 from fd_funding_reports where id = p_owner_id)
       when 'activity' then exists (select 1 from fd_activities where id = p_owner_id)
       when 'production' then fd_can_owner('production', p_owner_id)
       when 'contact' then fd_can_owner('contact', p_owner_id) and not coalesce((select protected from fd_contacts where id = p_owner_id), true)
       when 'grant' then fd_can_owner('grant', p_owner_id)
       when 'survey' then fd_survey_results_ok(p_owner_id)
       else false end) then
    raise exception 'Du kan inte starta en agent på det här';
  end if;
  if (select count(*) from fd_agent_runs where started_by = me and status in ('queued','running','continuing')) >= 3 then
    raise exception 'Du har redan tre körningar igång. Vänta tills någon är klar.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('titel', title, 'text', body) order by dept nulls first, title), '[]'::jsonb) into know
    from fd_knowledge where approved and (dept is null or dept = a.dept);
  insert into fd_agent_runs(agent_id, owner_type, owner_id, question, payload, started_by)
  values (a.id, p_owner_type, p_owner_id, left(coalesce(p_question,''), 4000),
          jsonb_build_object('underlag', fd_agent_snapshot(p_owner_type, p_owner_id), 'kunskapsbas', know,
                             'datum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')), me)
  returning id into rid;
  perform fd_log('ai', rid, 'startad', null, jsonb_build_object('agent', a.id, 'owner_type', p_owner_type, 'owner_id', p_owner_id));
  return rid;
end $$;

create or replace function fd_agent_cancel(p_run text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update fd_agent_runs set status = 'cancelled', finished_at = now(), lease_until = null
   where id = p_run and status in ('queued','running','continuing') and (started_by = bs_my_id() or fd_admin());
  if not found then raise exception 'Körningen går inte att avbryta'; end if;
end $$;

/* Edge-funktionen (servernyckeln): ta nästa körning. Budgeten kontrolleras före varje steg. */
create or replace function fd_agent_claim() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r fd_agent_runs; a fd_agents; b jsonb := fd_ai_budget();
begin
  select * into r from fd_agent_runs
   where status in ('queued','continuing') or (status = 'running' and lease_until < now())
   order by created_at limit 1 for update skip locked;
  if r.id is null then return null; end if;
  if not coalesce((b->>'enabled')::boolean, true) or (b->>'spent_sek')::numeric >= (b->>'budget_sek')::numeric then
    update fd_agent_runs set status = 'blocked', error = 'Månadens AI-budget är slut', finished_at = now() where id = r.id;
    perform fd_notify(r.started_by, 'ai', 'AI-körningen stoppades', 'Månadens AI-budget är slut. Admin kan höja den.', r.owner_type, r.owner_id);
    return jsonb_build_object('skipped', 'budget');
  end if;
  if r.attempts >= 4 and r.status = 'running' then
    update fd_agent_runs set status = 'error', error = 'Körningen avbröts flera gånger (tidsgräns)', finished_at = now() where id = r.id;
    perform fd_notify(r.started_by, 'ai', 'AI-körningen misslyckades', 'Den tog för lång tid. Försök igen med en smalare fråga.', r.owner_type, r.owner_id);
    return jsonb_build_object('skipped', 'attempts');
  end if;
  update fd_agent_runs set status = 'running', lease_until = now() + interval '7 minutes',
         attempts = case when status = 'running' then attempts + 1 else 0 end
   where id = r.id returning * into r;
  select * into a from fd_agents where id = r.agent_id;
  return jsonb_build_object('run', to_jsonb(r) - 'result' - 'sources', 'agent', to_jsonb(a),
    'remaining_usd', greatest(0, ((b->>'budget_sek')::numeric - (b->>'spent_sek')::numeric) / nullif((b->>'usd_sek')::numeric, 0)));
end $$;

/* Edge-funktionen: spara ett steg. done → resultat och källor; continuing → nästa väckning fortsätter. */
create or replace function fd_agent_save(p_run text, p_state jsonb, p_status text, p_result text, p_sources jsonb, p_usage jsonb,
  p_cost_usd numeric, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare r fd_agent_runs; a fd_agents;
begin
  if p_status not in ('continuing','done','error') then raise exception 'Ogiltig status'; end if;
  update fd_agent_runs set state = coalesce(p_state, state), status = p_status, steps = steps + 1, lease_until = null,
         result = case when p_status = 'done' then coalesce(p_result, '') else result end,
         sources = case when p_status = 'done' then coalesce(p_sources, '[]'::jsonb) else sources end,
         usage = coalesce((select jsonb_object_agg(k, coalesce((usage->>k)::numeric, 0) + coalesce((p_usage->>k)::numeric, 0))
                    from jsonb_object_keys(coalesce(usage,'{}'::jsonb) || coalesce(p_usage,'{}'::jsonb)) k), '{}'::jsonb),
         cost_usd = cost_usd + coalesce(p_cost_usd, 0), error = coalesce(p_error, ''),
         finished_at = case when p_status in ('done','error') then now() end
   where id = p_run and status = 'running' returning * into r;
  if r.id is null then return; end if;                                    -- avbruten under tiden: spara inget
  select * into a from fd_agents where id = r.agent_id;
  if p_status = 'done' then
    if a.mode = 'funding_import' then perform fd_grants_import(r.id, p_result); end if;
    perform fd_notify(r.started_by, 'ai', a.name || ' är klar',
      'Resultatet finns där du startade agenten' || case when a.mode = 'deep_dive' then ' (produktionens Deep Dive).' else '.' end,
      r.owner_type, r.owner_id);
  elsif p_status = 'error' then
    perform fd_notify(r.started_by, 'ai', a.name || ' misslyckades', left(coalesce(p_error, ''), 200), r.owner_type, r.owner_id);
  end if;
  perform fd_log('ai', r.id, p_status, null, jsonb_build_object('cost_usd', round(r.cost_usd, 4), 'steps', r.steps));
end $$;

-- ---------------------------------------------------------------------
--  AGENTBIBLIOTEKET (masterplanen avsnitt 16) — instruktionerna kan ändras av admin
-- ---------------------------------------------------------------------
insert into fd_agents(id, dept, name, purpose, mode, effort, web, max_searches, output, instructions) values
 ('a_outreach', 'A', 'A · Outreach Research', 'Hittar relevanta ungdomsverksamheter och hjälper Joseph att förbereda kontakter.', 'research', 'medium', true, 10,
  'Lista med verksamheter (namn, område, varför relevant, officiell kontaktväg, källa) och ett förslag på första kontakt.',
  'Du hjälper avdelning A att hitta och förbereda kontakter med verksamheter som når ungdomar (fritidsgårdar, skolor, HVB, föreningar). Använd officiella källor. Kontakta ingen.'),
 ('a_youthops', 'B', 'B · Youth Operations Assistant', 'Hjälper Samuel med ansökningsadministration, gruppförslag och sms-utkast.', 'writer', 'medium', false, 0,
  'Utkast och checklistor. Inga personuppgifter.',
  'Du hjälper avdelning B med rutiner, sms-utkast och planering kring ungdomarna. Du får inga personuppgifter om ungdomar och ska inte be om dem. Skicka inget själv.'),
 ('a_workshop', 'C', 'C · Workshop Planner', 'Hjälper Amir att utveckla och planera verkliga kreativa workshops.', 'research', 'medium', true, 6,
  'Upplägg (mål, tidsplan, material, bemanning, risker) och förslag på uppföljningsfrågor.',
  'Du hjälper avdelning C att planera kreativa workshops för unga 13–23 år inom musik, film, foto och design. Var konkret och realistisk om tid, plats och resurser.'),
 ('a_profile', 'D', 'D · Profile Research', 'Tar fram relevant offentlig bakgrund inför Adrians personliga möten med profiler.', 'research', 'medium', true, 10,
  'Kort bakgrund, relevanta projekt, möjliga sätt att medverka (stöd, intervju, workshop, mentor) och frågor inför mötet — med källor.',
  'Du förbereder avdelning D inför personliga möten med artister och profiler. Bara offentliga, relevanta uppgifter om yrkesliv och verk — inga privata förhållanden. Kontakta ingen.'),
 ('a_partner', 'E', 'E · Partnership Intelligence', 'Undersöker potentiella partners och samarbetsmöjligheter.', 'research', 'medium', true, 10,
  'Verksamhet, gemensamma intressen, förslag på samarbetsupplägg och ett mötesunderlag — med källor.',
  'Du hjälper avdelning E att förstå potentiella partners (företag, organisationer, kommuner). Föreslå samarbeten men lova eller avtala aldrig något.'),
 ('a_comms', 'F', 'F · Communication Assistant', 'Hjälper med presentationsunderlag, texter och kommunikationsplanering.', 'writer', 'medium', false, 0,
  'Textutkast anpassade till målgrupp, och korrekturförslag.',
  'Du skriver textutkast för avdelning F enligt Foundations identitetsdokument i kunskapsbasen. Inget publiceras utan att en människa godkänt det.'),
 ('a_deepdive', 'G', 'G · Interview Deep Dive', 'Djupgående research och en personlig intervjubrief inför varje intervju.', 'deep_dive', 'high', true, 20,
  'A. Fullständig researchrapport (verifierade fakta, redaktionella hypoteser, öppna frågor, med källor). B. Interview Playbook.',
  'Du gör en ordentlig deep dive inför en redaktionell intervju åt Bando Foundations redaktion (G). Undersök: 1 Bakgrund, 2 Projekt och meriter (vilken roll hade personen själv?), 3 Tidigare intervjuer (vad återkommer, vad är outforskat?), 4 Viktiga vägval, 5 Professionella relationer, 6 Perspektiv, 7 Oväntade vinklar, 8 Frågor att verifiera. Bara relevanta offentliga källor, inga privata förhållanden. Hitta aldrig på meriter, uttalanden, konflikter eller samarbeten. Varje faktapåstående ska ha en källa.'),
 ('a_insights', 'H', 'H · Youth Insights Research', 'Hjälper med studier, undersökningar och analyser.', 'research', 'medium', true, 10,
  'Relevanta studier med metodförbehåll, frågeutkast och mönster — med källor.',
  'Du hjälper avdelning H med undersökningar om ungas villkor. Hitta aldrig på statistik och beskriv aldrig en begränsad enkät som representativ för hela Sverige.'),
 ('a_funding', 'I', 'I · Funding Intelligence', 'Hittar, verifierar och bevakar finansieringsmöjligheter.', 'research', 'high', true, 15,
  'Per stöd: grundinformation, behörighet för Bando Foundation, godkända kostnader, krav, tidigare mottagare, matchning mot projekt och prioritet A/B/C — med källor.',
  'Du är Bando Foundations finansieringsagent. Verifiera mot finansiärens officiella information. Bando Foundation bildades den 5 december 2025 — kontrollera krav på verksamhetsår, organisationsform och geografi. Markera osäker information tydligt. Skicka aldrig in ansökningar och ingå inga avtal.'),
 ('a_fundimport', 'I', 'I · Läs in veckorapport', 'Gör om den befintliga veckobevakningens rapport till poster i bidragsdatabasen.', 'funding_import', 'medium', false, 0,
  'Strukturerade bidragsposter (namn, finansiär, länk, deadline, belopp, behörighet, prioritet, nästa åtgärd).',
  'Läs veckorapporten och gör om varje stöd den nämner till en post. Ta bara med det som står i rapporten — fyll inte i det som saknas, lämna fältet tomt och sätt verified till false.'),
 ('a_admin', 'J', 'J · Administration Assistant', 'Hjälper med dokumentöversikter, administrativa checklistor och underlag.', 'writer', 'low', false, 0,
  'Checklistor och sammanställningar.',
  'Du hjälper avdelning J med administrativa checklistor och översikter för en ideell förening. Ge inte juridisk eller skattemässig rådgivning som slutligt besked — hänvisa till ansvarig person.')
on conflict (id) do nothing;

/* Kunskapsbasen startar med det masterplanen säger om Foundation (admin fyller på). */
insert into fd_knowledge(id, title, body, dept) values
 ('fk_foundation', 'Bando Foundation', 'Bando Foundation är en ideell förening, bildad den 5 december 2025. Föreningen bygger möjligheter för unga (13–23 år) inom musik, film, foto, design och kreativa branscher. Första stora satsningen är Behind the Release, där 40 ungdomar väljs ut till ett kreativt program. Bando Education och Bando HQ Access hör också till verksamheten. Organisationen har tio avdelningar A–J.', null),
 ('fk_content', 'Redaktionens fyra innehållsområden', 'Människorna bakom kulturen; Kultur, bransch och samhälle; Foundation i verkligheten; Ungdomarnas perspektiv.', 'G')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
--  SCHEMALÄGGNING: edge-funktionen fd-agent varje minut (samma hemligheter som notify-send)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'foundation-ai';
    perform cron.schedule('foundation-ai', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'bandohq_url') || '/functions/v1/fd-agent',
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bandohq_cron')),
        body := '{}'::jsonb)
      where exists (select 1 from public.fd_agent_runs where status in ('queued','continuing') or (status = 'running' and lease_until < now()))
    $job$);
  end if;
end $$;

-- ---------------------------------------------------------------------
--  RLS FÖR FAS 4–5
-- ---------------------------------------------------------------------
alter table fd_grants enable row level security;
alter table fd_funding_reports enable row level security;
alter table fd_deadlines enable row level security;
alter table fd_surveys enable row level security;
alter table fd_survey_responses enable row level security;     -- inga policyer: svaren läses bara via fd_survey_report

drop policy if exists fd_grants_read on fd_grants;
create policy fd_grants_read on fd_grants for select to authenticated using (fd_funding_ok());
drop policy if exists fd_grants_insert on fd_grants;
create policy fd_grants_insert on fd_grants for insert to authenticated with check ((fd_admin() or fd_in('I')) and created_by = bs_my_id());
drop policy if exists fd_grants_update on fd_grants;
create policy fd_grants_update on fd_grants for update to authenticated using (fd_admin() or fd_in('I')) with check (fd_admin() or fd_in('I'));
drop policy if exists fd_funding_reports_read on fd_funding_reports;
create policy fd_funding_reports_read on fd_funding_reports for select to authenticated using (fd_funding_ok());
drop policy if exists fd_funding_reports_insert on fd_funding_reports;
create policy fd_funding_reports_insert on fd_funding_reports for insert to authenticated
  with check ((fd_admin() or fd_in('I')) and created_by = bs_my_id());

drop policy if exists fd_deadlines_read on fd_deadlines;
create policy fd_deadlines_read on fd_deadlines for select to authenticated using (fd_member());
drop policy if exists fd_deadlines_write on fd_deadlines;
create policy fd_deadlines_write on fd_deadlines for all to authenticated
  using (fd_admin() or fd_in(dept)) with check ((fd_admin() or fd_in(dept)) and created_by = bs_my_id());

drop policy if exists fd_surveys_read on fd_surveys;
create policy fd_surveys_read on fd_surveys for select to authenticated using (fd_member());
drop policy if exists fd_surveys_insert on fd_surveys;
create policy fd_surveys_insert on fd_surveys for insert to authenticated
  with check (created_by = bs_my_id() and (fd_admin() or fd_in('H') or (kind = 'internal' and activity_id is not null and fd_activity_staff(activity_id))));
drop policy if exists fd_surveys_update on fd_surveys;
create policy fd_surveys_update on fd_surveys for update to authenticated
  using (fd_admin() or fd_in('H') or created_by = bs_my_id()) with check (fd_admin() or fd_in('H') or created_by = bs_my_id());

drop trigger if exists fd_grants_touch on fd_grants;
create trigger fd_grants_touch before update on fd_grants for each row execute function fd_touch_updated();
drop trigger if exists fd_surveys_touch on fd_surveys;
create trigger fd_surveys_touch before update on fd_surveys for each row execute function fd_touch_updated();
create or replace function fd_grant_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('grant', new.id, 'nytt', null, jsonb_build_object('name', new.name, 'source', new.source));
  elsif new.status is distinct from old.status then
    perform fd_log('grant', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
    if new.status = 'ready' then
      perform fd_notify_dept('I', 'grant', 'Klar för godkännande: ' || new.name, 'En människa ansvarar för att skicka in ansökan.', 'grant', new.id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fd_grant_changed on fd_grants;
create trigger fd_grant_changed after insert or update on fd_grants for each row execute function fd_grant_changed();

-- ---------------------------------------------------------------------
--  SCHEMALÄGGNING: påminnelser varje morgon, veckorapport måndag 08.00 (svensk tid ≈ UTC+1)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('foundation-paminnelser', 'foundation-veckorapport');
    perform cron.schedule('foundation-paminnelser', '0 6 * * *', 'select public.fd_daily_reminders()');
    perform cron.schedule('foundation-veckorapport', '0 7 * * 1', 'select public.fd_weekly_report()');
  end if;
end $$;

-- ---------------------------------------------------------------------
--  RÄTTIGHETER
-- ---------------------------------------------------------------------
revoke all on function fd_production_changed(), fd_material_version(), fd_grant_changed(), fd_touch_updated(),
  fd_agent_claim(), fd_agent_save(text, jsonb, text, text, jsonb, jsonb, numeric, text), fd_grants_import(text, text),
  fd_daily_reminders(), fd_weekly_report(), fd_survey_results(text), fd_agent_snapshot(text, text)
  from public, anon, authenticated;
revoke all on function fd_owner_dept(text, text), fd_funding_ok(), fd_survey_results_ok(text), fd_survey_report(text),
  fd_ai_budget(), fd_save_ai_settings(numeric, numeric, boolean), fd_agent_request(text, text, text, text), fd_agent_cancel(text)
  from public, anon;
grant execute on function fd_owner_dept(text, text), fd_funding_ok(), fd_survey_results_ok(text), fd_survey_report(text),
  fd_ai_budget(), fd_save_ai_settings(numeric, numeric, boolean), fd_agent_request(text, text, text, text), fd_agent_cancel(text)
  to authenticated;
revoke all on function fd_set_workshop_activity(text) from public, anon;
grant execute on function fd_set_workshop_activity(text) to authenticated;
/* enkätsidan: anonym, skyddad av länkens token */
revoke all on function fd_survey_info(text), fd_survey_answer(text, jsonb) from public;
grant execute on function fd_survey_info(text), fd_survey_answer(text, jsonb) to anon, authenticated;
/* edge-funktionen fd-agent använder servernyckeln */
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function fd_agent_claim(), fd_agent_save(text, jsonb, text, text, jsonb, jsonb, numeric, text) to service_role;
  end if;
end $$;
revoke all on table fd_productions, fd_materials, fd_publications, fd_settings, fd_agents, fd_knowledge, fd_agent_runs,
  fd_grants, fd_funding_reports, fd_deadlines, fd_surveys, fd_survey_responses from anon;
