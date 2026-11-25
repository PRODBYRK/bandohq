-- =====================================================================
--  BANDO FOUNDATION — ARBETSYTAN (fas 1, 2026-11)
--  Samma konton och samma inloggning som studiodelen, men egna tabeller (fd_*). Ingen
--  studiotabell ändras. Underlag: HQ-masterplanen avsnitt 1–3, 18–21.
--
--  Behörigheter
--    fd_admin()         behörigheten 'foundation_admin' — ser alla avdelningar
--    fd_in(avd)         personen har ett medlemskap i avdelningen
--    fd_protected_ok()  behörigheten 'protected_data'. Följer INTE med admin. Rader med
--                       protected = true syns bara för den som har den (ungdomsdata, fas 2).
--  Statusbyten på överlämningar, trådar, meddelanden och medlemskap går via funktioner som
--  loggar i record_history (kind 'fd.*') och skickar notiser (fd_notifications + bs_notify).
--  Körs efter 01–06. Går att köra flera gånger.
-- =====================================================================

/* Den som bara arbetar i Foundation (ser inte studion). */
alter type bs_role add value if not exists 'foundation';

-- ---------------------------------------------------------------------
--  TABELLER
-- ---------------------------------------------------------------------
create table if not exists fd_departments (
  code      text primary key check (code ~ '^[A-J]$'),
  name      text not null,
  mission   text not null default '',
  has_chief boolean not null default true,          -- G är en gemensam redaktion utan chef
  sort      int not null default 0
);

create table if not exists fd_memberships (
  member_id  text not null references members(id) on delete cascade,
  dept       text not null references fd_departments(code),
  role       text not null default 'member' check (role in ('chief','member')),
  created_at timestamptz not null default now(),
  primary key (member_id, dept)
);
create unique index if not exists fd_one_chief on fd_memberships (dept) where role = 'chief';

/* Verksamheter och personer som en överlämning gäller (bara det fas 1 behöver). */
create table if not exists fd_contacts (
  id             text primary key default bs_uid('fc_'),
  dept           text not null references fd_departments(code),
  kind           text not null default 'org' check (kind in ('org','person')),
  name           text not null check (length(trim(name)) >= 2),
  contact_person text not null default '',
  phone          text not null default '',
  email          text not null default '',
  area           text not null default '',
  status         text not null default '',
  note           text not null default '',
  next_step      text not null default '',
  protected      boolean not null default false,
  created_by     text references members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists fd_handovers (
  id              text primary key default bs_uid('fh_'),
  from_dept       text not null references fd_departments(code),
  from_member     text references members(id) on delete set null,
  to_dept         text not null references fd_departments(code),
  to_member       text references members(id) on delete set null,
  subject         text not null check (length(trim(subject)) >= 2),
  background      text not null default '',
  expected_action text not null default '',
  due             date,
  status          text not null default 'sent' check (status in ('sent','received','in_progress','done')),
  received_by     text references members(id) on delete set null,
  received_at     timestamptz,
  done_at         timestamptz,
  contact_id      text references fd_contacts(id) on delete set null,
  protected       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists fd_handovers_to on fd_handovers (to_dept, status);
create index if not exists fd_handovers_from on fd_handovers (from_dept, status);

create table if not exists fd_tasks (
  id          text primary key default bs_uid('ft_'),
  dept        text not null references fd_departments(code),
  title       text not null check (length(trim(title)) >= 2),
  description text not null default '',
  assignee    text references members(id) on delete set null,
  created_by  text references members(id) on delete set null,
  due         date,
  status      text not null default 'todo' check (status in ('todo','doing','waiting','done')),
  contact_id  text references fd_contacts(id) on delete set null,
  handover_id text references fd_handovers(id) on delete set null,
  protected   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists fd_tasks_dept on fd_tasks (dept, status);
create index if not exists fd_tasks_assignee on fd_tasks (assignee, status);

/* Trådar: privat (dm), avdelningsgrupp (dept), projekt (project) och kommentarer på en
   uppgift eller överlämning (comments). */
create table if not exists fd_threads (
  id         text primary key default bs_uid('fth_'),
  kind       text not null check (kind in ('dm','dept','project','comments')),
  title      text not null default '',
  dept       text references fd_departments(code),
  owner_type text check (owner_type in ('task','handover')),
  owner_id   text,
  protected  boolean not null default false,
  created_by text references members(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'dept') = (dept is not null and owner_type is null)),
  check ((kind = 'comments') = (owner_type is not null and owner_id is not null))
);
create unique index if not exists fd_threads_dept on fd_threads (dept) where kind = 'dept';
create unique index if not exists fd_threads_owner on fd_threads (owner_type, owner_id) where kind = 'comments';

create table if not exists fd_thread_members (
  thread_id    text not null references fd_threads(id) on delete cascade,
  member_id    text not null references members(id) on delete cascade,
  last_read_at timestamptz,
  primary key (thread_id, member_id)
);

create table if not exists fd_messages (
  id         bigserial primary key,
  thread_id  text not null references fd_threads(id) on delete cascade,
  author     text references members(id) on delete set null,
  body       text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists fd_messages_thread on fd_messages (thread_id, created_at);

create table if not exists fd_mentions (
  message_id bigint not null references fd_messages(id) on delete cascade,
  member_id  text not null references members(id) on delete cascade,
  primary key (message_id, member_id)
);

/* Notiserna i appen. Samma händelse går också som push och mejl via bs_notify. */
create table if not exists fd_notifications (
  id         bigserial primary key,
  member_id  text not null references members(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  ref_type   text,
  ref_id     text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists fd_notifications_member on fd_notifications (member_id, created_at desc);

/* Dokument kopplas till det de hör till (owner_type + owner_id). Filer ligger i Storage
   (bucket 'foundation', sökväg owner_type/owner_id/…); video är en länk (Drive). */
create table if not exists fd_documents (
  id           text primary key default bs_uid('fdoc_'),
  owner_type   text not null check (owner_type in ('task','handover','project','contact')),
  owner_id     text not null,
  dept         text references fd_departments(code),
  kind         text not null check (kind in ('file','link')),
  name         text not null check (length(trim(name)) >= 1),
  storage_path text unique,
  url          text,
  mime         text,
  size         bigint,
  uploaded_by  text references members(id) on delete set null,
  protected    boolean not null default false,
  created_at   timestamptz not null default now(),
  check ((kind = 'file' and storage_path is not null and url is null) or (kind = 'link' and url ~ '^https?://' and storage_path is null))
);
create index if not exists fd_documents_owner on fd_documents (owner_type, owner_id);

/* Avdelningsuppdateringen: fyra fält som andra avdelningar kan läsa. */
create table if not exists fd_dept_updates (
  dept          text primary key references fd_departments(code),
  working_on    text not null default '',
  recently_done text not null default '',
  need_help     text not null default '',
  waiting_for   text not null default '',
  updated_by    text references members(id) on delete set null,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  AVDELNINGARNA A–J (masterplanen avsnitt 4–15)
-- ---------------------------------------------------------------------
insert into fd_departments(code, name, mission, has_chief, sort) values
  ('A','Outreach & aktörsrelationer','Bygga relationer med verksamheter som når ungdomar: fritidsgårdar, skolor, HVB och andra ungdomsaktörer, och lämna över möjligheter när någon visar intresse.', true, 1),
  ('B','Ungdomsrelationer, ansökningar & urval','Ta emot ansökningar, kontakta och lära känna ungdomarna, bjuda in till aktiviteter och samordna urvalet till Behind the Release.', true, 2),
  ('C','Workshops & aktiviteter','Utveckla, planera och genomföra Foundations workshops och aktiviteter, med innehåll, bemanning, resurser och uppföljning.', true, 3),
  ('D','Artist- & profilrelationer','Personliga möten och relationer med artister, kreatörer och branschprofiler som kan medverka genom stöd, intervju, workshop eller mentorskap.', true, 4),
  ('E','Strategiska partnerskap','Utveckla större och långsiktiga samarbeten med organisationer, företag och institutioner som skapar resurser och möjligheter.', true, 5),
  ('F','Kommunikation & varumärke','Ansvara för hur Foundation presenteras utåt: identitet, presentationsmaterial, publiceringar, hemsida och PR.', true, 6),
  ('G','Redaktion & content','En gemensam redaktion utan ensam chef: intervjuer, research, filmproduktion, redigering och publicering.', false, 7),
  ('H','Ungdomsinsikter & samhällsundersökningar','Förstå våra deltagare och vad unga i Sverige tycker: undersökningar, utvärderingar och rapporter.', true, 8),
  ('I','Finansiering & finansieringsintelligens','Hitta, granska och bevaka bidrag och finansieringsmöjligheter och samordna ansökningar.', true, 9),
  ('J','Administration & ekonomi','Foundations administrativa och ekonomiska funktion: föreningsdokument, avtal, budgetar och administrativa deadlines.', true, 10)
on conflict (code) do nothing;
insert into fd_dept_updates(dept) select code from fd_departments on conflict (dept) do nothing;

-- ---------------------------------------------------------------------
--  HJÄLPFUNKTIONER FÖR BEHÖRIGHETEN (null blir alltid false)
-- ---------------------------------------------------------------------
create or replace function fd_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(exists (select 1 from members where user_id = auth.uid() and active and p = any(perms)), false)
$$;
create or replace function fd_admin() returns boolean
language sql stable security definer set search_path = public as $$ select fd_perm('foundation_admin') $$;
create or replace function fd_protected_ok() returns boolean
language sql stable security definer set search_path = public as $$ select fd_perm('protected_data') $$;
create or replace function fd_in(p_dept text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(exists (select 1 from fd_memberships f join members m on m.id = f.member_id
                           where m.user_id = auth.uid() and m.active and f.dept = p_dept), false)
$$;
create or replace function fd_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(fd_admin() or exists (select 1 from fd_memberships f join members m on m.id = f.member_id
                                          where m.user_id = auth.uid() and m.active), false)
$$;
/* En rad som hör till en avdelning: admin, avdelningens medlemmar och de personer raden
   nämner (ansvarig, skapare). Skyddade rader bara med protected_data — även för admin. */
create or replace function fd_see(p_dept text, p_people text[], p_protected boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((not coalesce(p_protected, false) or fd_protected_ok())
     and (fd_admin() or fd_in(p_dept) or bs_my_id() = any(coalesce(p_people, '{}'))), false)
$$;
/* En överlämning: båda avdelningarna, avsändaren, mottagaren och admin. */
create or replace function fd_see_handover(p_from text, p_to text, p_people text[], p_protected boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((not coalesce(p_protected, false) or fd_protected_ok())
     and (fd_admin() or fd_in(p_from) or fd_in(p_to) or bs_my_id() = any(coalesce(p_people, '{}'))), false)
$$;
create or replace function fd_can_task(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select fd_see(dept, array[assignee, created_by], protected) from fd_tasks where id = p_id), false)
$$;
create or replace function fd_can_handover(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select fd_see_handover(from_dept, to_dept, array[from_member, to_member, received_by], protected)
                     from fd_handovers where id = p_id), false)
$$;
/* En kontakt: avdelningen den hör till — och de som får läsa en överlämning om den. */
create or replace function fd_can_contact(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select fd_see(dept, array[created_by], protected) from fd_contacts where id = p_id)
      or exists (select 1 from fd_handovers h where h.contact_id = p_id and fd_can_handover(h.id))
      or exists (select 1 from fd_tasks t where t.contact_id = p_id and fd_can_task(t.id)), false)
$$;
/* En tråd: deltagarna (privat och projekt), avdelningen (avdelningsgrupp), den som får läsa
   uppgiften eller överlämningen (kommentarer) och admin — utom privata trådar, som bara
   deltagarna läser. */
create or replace function fd_can_thread(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (not t.protected or fd_protected_ok()) and case t.kind
      when 'dept' then fd_admin() or fd_in(t.dept)
      when 'comments' then case t.owner_type when 'task' then fd_can_task(t.owner_id) else fd_can_handover(t.owner_id) end
      when 'project' then fd_admin() or exists (select 1 from fd_thread_members x where x.thread_id = t.id and x.member_id = bs_my_id())
      else exists (select 1 from fd_thread_members x where x.thread_id = t.id and x.member_id = bs_my_id()) end
    from fd_threads t where t.id = p_id), false)
$$;
/* Det ett dokument hör till. */
create or replace function fd_can_owner(p_type text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case p_type
    when 'task' then fd_can_task(p_id)
    when 'handover' then fd_can_handover(p_id)
    when 'contact' then fd_can_contact(p_id)
    when 'project' then exists (select 1 from fd_threads t where t.id = p_id and t.kind = 'project') and fd_can_thread(p_id)
    else false end, false)
$$;
create or replace function fd_can_doc(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (not protected or fd_protected_ok()) and fd_can_owner(owner_type, owner_id) from fd_documents where id = p_id), false)
$$;

-- ---------------------------------------------------------------------
--  LOGG OCH NOTISER
-- ---------------------------------------------------------------------
/* Granskningsloggen återanvänder record_history (kind 'fd.*'). */
create or replace function fd_log(p_kind text, p_id text, p_op text, p_before jsonb, p_after jsonb, p_note text default null) returns void
language sql security definer set search_path = public as $$
  insert into record_history(kind, rec_id, op, before, after, by_id, note) values ('fd.' || p_kind, p_id, p_op, p_before, p_after, bs_my_id(), p_note)
$$;
/* Vad som skrivs i loggen om en uppgift eller överlämning: metadata, och titeln bara när raden
   inte är skyddad. (Studions admin läser också record_history — se history_read i 02.) */
create or replace function fd_task_log(t fd_tasks) returns jsonb
language sql immutable as $$
  select jsonb_build_object('dept', t.dept, 'status', t.status, 'assignee', t.assignee, 'due', t.due)
    || case when t.protected then jsonb_build_object('protected', true) else jsonb_build_object('title', t.title) end
$$;
create or replace function fd_handover_log(h fd_handovers) returns jsonb
language sql immutable as $$
  select jsonb_build_object('from_dept', h.from_dept, 'to_dept', h.to_dept, 'to_member', h.to_member, 'status', h.status, 'due', h.due)
    || case when h.protected then jsonb_build_object('protected', true) else jsonb_build_object('subject', h.subject) end
$$;

/* Notis i appen + push och mejl via den befintliga utkorgen. Ingen notis till den som själv gjorde det. */
create or replace function fd_notify(p_member text, p_kind text, p_title text, p_body text, p_ref_type text, p_ref_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_member is null or p_member is not distinct from bs_my_id() then return; end if;
  if not exists (select 1 from members where id = p_member and active) then return; end if;
  insert into fd_notifications(member_id, kind, title, body, ref_type, ref_id) values (p_member, p_kind, p_title, coalesce(p_body,''), p_ref_type, p_ref_id);
  perform bs_notify(p_member, null, p_title, coalesce(nullif(p_body,''), p_title), 'foundation',
    'fd:' || p_kind || ':' || coalesce(p_ref_id,'') || ':' || p_member || ':' || now_ms(), '0',
    'https://www.bandohq.se/foundation.html#' || coalesce(p_ref_type,'') || '-' || coalesce(p_ref_id,''));
end $$;
/* Alla i en avdelning (mottagare utan namngiven person). */
create or replace function fd_notify_dept(p_dept text, p_kind text, p_title text, p_body text, p_ref_type text, p_ref_id text) returns void
language plpgsql security definer set search_path = public as $$
declare m text;
begin
  for m in select member_id from fd_memberships where dept = p_dept loop
    perform fd_notify(m, p_kind, p_title, p_body, p_ref_type, p_ref_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  TRIGGRAR
-- ---------------------------------------------------------------------
/* G har ingen avdelningschef. */
create or replace function fd_membership_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'chief' and not (select has_chief from fd_departments where code = new.dept) then
    raise exception 'Avdelning % har ingen avdelningschef', new.dept;
  end if;
  return new;
end $$;
drop trigger if exists fd_membership_guard on fd_memberships;
create trigger fd_membership_guard before insert or update on fd_memberships for each row execute function fd_membership_guard();

/* Uppgifter: tider, logg på status och ansvarig, och notis till den nya ansvariga. */
create or replace function fd_task_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('task', new.id, 'skapad', null, fd_task_log(new));
    perform fd_notify(new.assignee, 'task', case when new.protected then 'Ny skyddad uppgift' else 'Ny uppgift: ' || new.title end,
      coalesce((select name from members where id = new.created_by), 'Någon') || ' gav dig en uppgift'
      || case when new.protected then '' else ': "' || new.title || '"' end
      || coalesce(' med deadline ' || new.due, '') || '. Öppna den i Bando Foundation.', 'task', new.id);
    return new;
  end if;
  if new.status is distinct from old.status then
    perform fd_log('task', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  if new.assignee is distinct from old.assignee then
    perform fd_log('task', new.id, 'ansvarig', jsonb_build_object('assignee', old.assignee), jsonb_build_object('assignee', new.assignee));
    perform fd_notify(new.assignee, 'task', case when new.protected then 'Ny skyddad uppgift' else 'Ny uppgift: ' || new.title end,
      coalesce((select name from members where id = bs_my_id()), 'Någon') || ' gav dig en uppgift'
      || case when new.protected then '' else ': "' || new.title || '"' end || '.', 'task', new.id);
  end if;
  return new;
end $$;
create or replace function fd_task_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then new.done_at := now(); end if;
  if new.status <> 'done' then new.done_at := null; end if;
  return new;
end $$;
drop trigger if exists fd_task_stamp on fd_tasks;
create trigger fd_task_stamp before insert or update on fd_tasks for each row execute function fd_task_stamp();
drop trigger if exists fd_task_changed on fd_tasks;
create trigger fd_task_changed after insert or update on fd_tasks for each row execute function fd_task_changed();

/* Dokument: uppladdning och borttagning loggas. */
create or replace function fd_document_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('document', new.id, case when new.kind = 'file' then 'uppladdad' else 'länk' end, null,
      jsonb_build_object('owner_type', new.owner_type, 'owner_id', new.owner_id, 'kind', new.kind, 'size', new.size)
      || case when new.protected then jsonb_build_object('protected', true) else jsonb_build_object('name', new.name) end);
    return new;
  end if;
  perform fd_log('document', old.id, 'borttagen', jsonb_build_object('owner_type', old.owner_type, 'owner_id', old.owner_id)
      || case when old.protected then jsonb_build_object('protected', true) else jsonb_build_object('name', old.name) end, null);
  return old;
end $$;
drop trigger if exists fd_document_changed on fd_documents;
create trigger fd_document_changed after insert or delete on fd_documents for each row execute function fd_document_changed();

create or replace function fd_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists fd_contact_touch on fd_contacts;
create trigger fd_contact_touch before update on fd_contacts for each row execute function fd_touch();

/* Foundation-behörigheterna ändras bara via fd_set_perm. Studions set_member_perms (och en
   direkt uppdatering) skriver hela listan — då behålls Foundation-delen som den var, så att en
   studio-admin varken råkar ta bort den eller kan ge sig själv skyddad åtkomst den vägen.
   Migreringar och servern (ingen inloggad användare) går förbi. */
create or replace function fd_perms_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare fdp text[] := array['foundation_admin','protected_data'];
begin
  if auth.uid() is null or coalesce(current_setting('fd.perm', true), '') = '1' then return new; end if;
  if new.perms is distinct from old.perms then
    new.perms := array(select distinct x from unnest(
      array(select x from unnest(coalesce(new.perms,'{}')) x where not x = any(fdp))
      || array(select x from unnest(coalesce(old.perms,'{}')) x where x = any(fdp))) x order by 1);
  end if;
  return new;
end $$;
drop trigger if exists fd_perms_guard on members;
create trigger fd_perms_guard before update of perms on members for each row execute function fd_perms_guard();

-- ---------------------------------------------------------------------
--  RLS
-- ---------------------------------------------------------------------
alter table fd_departments enable row level security;
alter table fd_memberships enable row level security;
alter table fd_contacts enable row level security;
alter table fd_handovers enable row level security;
alter table fd_tasks enable row level security;
alter table fd_threads enable row level security;
alter table fd_thread_members enable row level security;
alter table fd_messages enable row level security;
alter table fd_mentions enable row level security;
alter table fd_notifications enable row level security;
alter table fd_documents enable row level security;
alter table fd_dept_updates enable row level security;

drop policy if exists fd_departments_read on fd_departments;
create policy fd_departments_read on fd_departments for select to authenticated using (fd_member());
drop policy if exists fd_memberships_read on fd_memberships;
create policy fd_memberships_read on fd_memberships for select to authenticated using (fd_member());

drop policy if exists fd_contacts_read on fd_contacts;
create policy fd_contacts_read on fd_contacts for select to authenticated
  using (fd_see(dept, array[created_by], protected)
      or exists (select 1 from fd_handovers h where h.contact_id = fd_contacts.id and fd_can_handover(h.id))
      or exists (select 1 from fd_tasks t where t.contact_id = fd_contacts.id and fd_can_task(t.id)));
drop policy if exists fd_contacts_insert on fd_contacts;
create policy fd_contacts_insert on fd_contacts for insert to authenticated
  with check ((fd_admin() or fd_in(dept)) and created_by = bs_my_id() and (not protected or fd_protected_ok()));
drop policy if exists fd_contacts_update on fd_contacts;
create policy fd_contacts_update on fd_contacts for update to authenticated
  using ((fd_admin() or fd_in(dept)) and (not protected or fd_protected_ok()))
  with check ((fd_admin() or fd_in(dept)) and (not protected or fd_protected_ok()));

drop policy if exists fd_tasks_read on fd_tasks;
create policy fd_tasks_read on fd_tasks for select to authenticated using (fd_see(dept, array[assignee, created_by], protected));
drop policy if exists fd_tasks_insert on fd_tasks;
create policy fd_tasks_insert on fd_tasks for insert to authenticated
  with check ((fd_admin() or fd_in(dept)) and created_by = bs_my_id() and (not protected or fd_protected_ok()));
drop policy if exists fd_tasks_update on fd_tasks;
create policy fd_tasks_update on fd_tasks for update to authenticated
  using (fd_see(dept, array[assignee, created_by], protected))
  with check (fd_see(dept, array[assignee, created_by], protected));

/* Överlämningar skapas och ändras bara via funktionerna (fd_handover_*). */
drop policy if exists fd_handovers_read on fd_handovers;
create policy fd_handovers_read on fd_handovers for select to authenticated
  using (fd_see_handover(from_dept, to_dept, array[from_member, to_member, received_by], protected));

drop policy if exists fd_threads_read on fd_threads;
create policy fd_threads_read on fd_threads for select to authenticated using (fd_can_thread(id));
drop policy if exists fd_thread_members_read on fd_thread_members;
create policy fd_thread_members_read on fd_thread_members for select to authenticated using (fd_can_thread(thread_id));
drop policy if exists fd_messages_read on fd_messages;
create policy fd_messages_read on fd_messages for select to authenticated using (fd_can_thread(thread_id));
drop policy if exists fd_mentions_read on fd_mentions;
create policy fd_mentions_read on fd_mentions for select to authenticated
  using (exists (select 1 from fd_messages m where m.id = message_id and fd_can_thread(m.thread_id)));

drop policy if exists fd_notifications_read on fd_notifications;
create policy fd_notifications_read on fd_notifications for select to authenticated using (member_id = bs_my_id());

drop policy if exists fd_documents_read on fd_documents;
create policy fd_documents_read on fd_documents for select to authenticated
  using ((not protected or fd_protected_ok()) and fd_can_owner(owner_type, owner_id));
drop policy if exists fd_documents_insert on fd_documents;
create policy fd_documents_insert on fd_documents for insert to authenticated
  with check (uploaded_by = bs_my_id() and fd_can_owner(owner_type, owner_id) and (not protected or fd_protected_ok())
    and (kind = 'link' or storage_path like owner_type || '/' || owner_id || '/%'));
drop policy if exists fd_documents_delete on fd_documents;
create policy fd_documents_delete on fd_documents for delete to authenticated
  using ((uploaded_by = bs_my_id() or fd_admin()) and fd_can_owner(owner_type, owner_id));

drop policy if exists fd_dept_updates_read on fd_dept_updates;
create policy fd_dept_updates_read on fd_dept_updates for select to authenticated using (fd_member());
drop policy if exists fd_dept_updates_write on fd_dept_updates;
create policy fd_dept_updates_write on fd_dept_updates for update to authenticated
  using (fd_admin() or fd_in(dept)) with check ((fd_admin() or fd_in(dept)) and updated_by = bs_my_id());

/* Granskningsloggen: Foundation-admin läser Foundation-raderna (studions regel står kvar). */
drop policy if exists history_read_fd on record_history;
create policy history_read_fd on record_history for select to authenticated using (kind like 'fd.%' and fd_admin());

-- ---------------------------------------------------------------------
--  FUNKTIONER
-- ---------------------------------------------------------------------
/* Skicka en överlämning. Mottagaren är en avdelning och (valfritt) en person i den. */
create or replace function fd_handover_send(p_from_dept text, p_to_dept text, p_to_member text, p_subject text,
  p_background text default '', p_expected text default '', p_due date default null, p_contact text default null,
  p_protected boolean default false) returns fd_handovers
language plpgsql security definer set search_path = public as $$
declare h fd_handovers; me text := bs_my_id(); who text := (select name from members where id = bs_my_id()); subj text;
begin
  if me is null or not (fd_admin() or fd_in(p_from_dept)) then raise exception 'Du kan bara skicka överlämningar från din avdelning'; end if;
  if p_from_dept = p_to_dept then raise exception 'Välj en annan avdelning att lämna över till'; end if;
  if not exists (select 1 from fd_departments where code = p_to_dept) then raise exception 'Avdelningen finns inte'; end if;
  if p_to_member is not null and not exists (select 1 from fd_memberships where member_id = p_to_member and dept = p_to_dept) then
    raise exception 'Mottagaren är inte med i avdelning %', p_to_dept;
  end if;
  if length(trim(coalesce(p_subject,''))) < 2 then raise exception 'Skriv vad överlämningen gäller'; end if;
  if p_contact is not null and not fd_can_contact(p_contact) then raise exception 'Kontakten finns inte'; end if;
  if coalesce(p_protected, false) and not fd_protected_ok() then raise exception 'Du saknar behörighet för skyddade uppgifter'; end if;
  insert into fd_handovers(from_dept, from_member, to_dept, to_member, subject, background, expected_action, due, contact_id, protected)
  values (p_from_dept, me, p_to_dept, p_to_member, trim(p_subject), coalesce(p_background,''), coalesce(p_expected,''), p_due, p_contact, coalesce(p_protected,false))
  returning * into h;
  perform fd_log('handover', h.id, 'skickad', null, fd_handover_log(h));
  subj := case when h.protected then 'en skyddad överlämning' else '"' || h.subject || '"' end;
  if p_to_member is not null then
    perform fd_notify(p_to_member, 'handover', 'Överlämning från ' || p_from_dept || case when h.protected then '' else ': ' || h.subject end,
      who || ' lämnar över ' || subj || ' till dig. Bekräfta att du tar emot den.', 'handover', h.id);
  else
    perform fd_notify_dept(p_to_dept, 'handover', 'Överlämning från ' || p_from_dept || case when h.protected then '' else ': ' || h.subject end,
      who || ' lämnar över ' || subj || ' till avdelning ' || p_to_dept || '. Bekräfta att ni tar emot den.', 'handover', h.id);
  end if;
  return h;
end $$;

/* Mottagaren bekräftar att den tagit över ansvaret. */
create or replace function fd_handover_receive(p_id text) returns fd_handovers
language plpgsql security definer set search_path = public as $$
declare h fd_handovers; me text := bs_my_id();
begin
  select * into h from fd_handovers where id = p_id for update;
  if h.id is null or not fd_can_handover(p_id) then raise exception 'Överlämningen finns inte'; end if;
  if not (fd_in(h.to_dept) or h.to_member = me) then raise exception 'Bara mottagande avdelning kan ta emot överlämningen'; end if;
  if h.to_member is not null and h.to_member <> me and not fd_in(h.to_dept) then raise exception 'Överlämningen är till någon annan'; end if;
  if h.status <> 'sent' then raise exception 'Överlämningen är redan mottagen'; end if;
  update fd_handovers set status = 'received', received_by = me, received_at = now(), updated_at = now(),
         to_member = coalesce(to_member, me) where id = p_id returning * into h;
  perform fd_log('handover', h.id, 'mottagen', jsonb_build_object('status','sent'), jsonb_build_object('status','received','by', me));
  perform fd_notify(h.from_member, 'handover', 'Mottagen: ' || case when h.protected then 'skyddad överlämning' else h.subject end,
    coalesce((select name from members where id = me), 'Mottagaren') || ' i avdelning ' || h.to_dept || ' har tagit emot '
    || case when h.protected then 'överlämningen' else '"' || h.subject || '"' end || '.', 'handover', h.id);
  return h;
end $$;

/* Mottagaren uppdaterar arbetet: Pågår eller Slutförd. */
create or replace function fd_handover_status(p_id text, p_status text) returns fd_handovers
language plpgsql security definer set search_path = public as $$
declare h fd_handovers; was text;
begin
  select * into h from fd_handovers where id = p_id for update;
  if h.id is null or not fd_can_handover(p_id) then raise exception 'Överlämningen finns inte'; end if;
  if not (fd_in(h.to_dept) or h.to_member = bs_my_id() or fd_admin()) then raise exception 'Bara mottagande avdelning ändrar status'; end if;
  if p_status not in ('in_progress','done') then raise exception 'Ogiltig status'; end if;
  if h.status = 'sent' then raise exception 'Ta emot överlämningen först'; end if;
  was := h.status;
  update fd_handovers set status = p_status, updated_at = now(), done_at = case when p_status = 'done' then now() else null end
   where id = p_id returning * into h;
  perform fd_log('handover', h.id, 'status', jsonb_build_object('status', was), jsonb_build_object('status', p_status));
  perform fd_notify(h.from_member, 'handover', case when p_status = 'done' then 'Slutförd: ' else 'Pågår: ' end
      || case when h.protected then 'skyddad överlämning' else h.subject end,
    'Avdelning ' || h.to_dept || ' har satt ' || case when h.protected then 'överlämningen' else '"' || h.subject || '"' end
    || ' till ' || case when p_status = 'done' then 'slutförd' else 'pågår' end || '.', 'handover', h.id);
  return h;
end $$;

/* Medlemskap och roller i avdelningarna (admin). p_role null tar bort medlemskapet. */
create or replace function fd_set_membership(p_member text, p_dept text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare was text;
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin ändrar medlemskap'; end if;
  if not exists (select 1 from members where id = p_member) then raise exception 'Personen finns inte'; end if;
  select role into was from fd_memberships where member_id = p_member and dept = p_dept;
  if p_role is null then
    delete from fd_memberships where member_id = p_member and dept = p_dept;
  else
    if p_role not in ('chief','member') then raise exception 'Ogiltig roll'; end if;
    if p_role = 'chief' then update fd_memberships set role = 'member' where dept = p_dept and role = 'chief' and member_id <> p_member; end if;
    insert into fd_memberships(member_id, dept, role) values (p_member, p_dept, p_role)
      on conflict (member_id, dept) do update set role = excluded.role;
  end if;
  perform fd_log('membership', p_member || ':' || p_dept, 'medlemskap', jsonb_build_object('role', was), jsonb_build_object('role', p_role));
end $$;

/* Foundation-behörigheter (admin). protected_data kan bara ges av den som själv har den. */
create or replace function fd_set_perm(p_member text, p_perm text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare before text[];
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin ändrar behörigheter'; end if;
  if p_perm not in ('foundation_admin','protected_data') then raise exception 'Okänd behörighet'; end if;
  if p_perm = 'protected_data' and not fd_protected_ok() then raise exception 'Bara den som har behörigheten kan ge den vidare'; end if;
  if p_member = bs_my_id() and p_perm = 'foundation_admin' and not p_on then raise exception 'Du kan inte ta bort din egen admin-behörighet'; end if;
  select perms into before from members where id = p_member;
  if before is null then raise exception 'Personen finns inte'; end if;
  perform set_config('fd.perm', '1', true);
  update members set perms = case when p_on then array(select distinct x from unnest(perms || p_perm) x order by 1)
                                  else array_remove(perms, p_perm) end where id = p_member;
  perform set_config('fd.perm', '', true);
  perform fd_log('perm', p_member, case when p_on then 'behörighet given' else 'behörighet borttagen' end,
    jsonb_build_object('perms', before), jsonb_build_object('perm', p_perm, 'on', p_on));
end $$;

/* Lägg till en person i Foundation (admin): en ny rad med rollen foundation, eller en befintlig
   person (samma e-post). Inbjudan skickas sedan med create_invite (samma flöde som studion). */
create or replace function fd_add_person(p_name text, p_email text, p_depts jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare mid text; em text := lower(nullif(trim(coalesce(p_email,'')),'')); nm text := trim(coalesce(p_name,'')); d jsonb;
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin lägger till personer'; end if;
  if em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Fyll i en giltig e-postadress'; end if;
  select id into mid from members where lower(email) = em limit 1;
  if mid is null then
    if length(nm) < 2 then raise exception 'Fyll i namn'; end if;
    if exists (select 1 from members where lower(name) = lower(nm)) then raise exception 'Det finns redan en person som heter %', nm; end if;
    mid := bs_uid('m_');
    insert into members(id, role, name, email, up) values (mid, 'foundation', nm, em, now_ms());
    perform fd_log('person', mid, 'tillagd', null, jsonb_build_object('name', nm, 'email', em));
  end if;
  for d in select x from jsonb_array_elements(coalesce(p_depts,'[]'::jsonb)) x loop
    perform fd_set_membership(mid, d->>'dept', coalesce(d->>'role','member'));
  end loop;
  return mid;
end $$;

/* Vem jag är i Foundation: admin, skyddad åtkomst och mina avdelningar. Studion frågar också
   (visar länken till Foundation bara för den som har åtkomst). */
create or replace function fd_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'role', m.role, 'member', fd_member(),
    'admin', fd_admin(), 'protected', fd_protected_ok(),
    'depts', coalesce((select jsonb_agg(jsonb_build_object('dept', f.dept, 'role', f.role) order by f.dept)
                         from fd_memberships f where f.member_id = m.id), '[]'::jsonb))
  from members m where m.user_id = auth.uid() and m.active
$$;
/* Personerna i Foundation (namn och avdelningar) för val av mottagare, ansvarig och omnämnanden.
   Admin får också studions crew och e-post, för att kunna lägga till befintliga personer. */
create or replace function fd_people() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not fd_member() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'role', m.role, 'login', m.user_id is not null,
      'email', case when fd_admin() then m.email end,
      'admin', 'foundation_admin' = any(m.perms),
      'protected', case when fd_admin() then 'protected_data' = any(m.perms) end,
      'depts', coalesce((select jsonb_agg(jsonb_build_object('dept', f.dept, 'role', f.role) order by f.dept)
                           from fd_memberships f where f.member_id = m.id), '[]'::jsonb)) order by m.name), '[]'::jsonb) end
  from members m
  where m.active and (exists (select 1 from fd_memberships f where f.member_id = m.id) or 'foundation_admin' = any(m.perms)
     or (fd_admin() and m.role::text in ('manager','admin','producer','camera','staff','foundation')))
$$;

/* Trådar */
create or replace function fd_dept_thread(p_dept text) returns text
language plpgsql security definer set search_path = public as $$
declare tid text;
begin
  if not (fd_admin() or fd_in(p_dept)) then raise exception 'Bara avdelningens medlemmar'; end if;
  select id into tid from fd_threads where kind = 'dept' and dept = p_dept;
  if tid is null then
    insert into fd_threads(kind, dept, title, created_by) values ('dept', p_dept, (select name from fd_departments where code = p_dept), bs_my_id())
      on conflict do nothing returning id into tid;
    if tid is null then select id into tid from fd_threads where kind = 'dept' and dept = p_dept; end if;
  end if;
  return tid;
end $$;
create or replace function fd_comments_thread(p_owner_type text, p_owner_id text) returns text
language plpgsql security definer set search_path = public as $$
declare tid text;
begin
  if p_owner_type not in ('task','handover') or not fd_can_owner(p_owner_type, p_owner_id) then raise exception 'Ärendet finns inte'; end if;
  select id into tid from fd_threads where kind = 'comments' and owner_type = p_owner_type and owner_id = p_owner_id;
  if tid is null then
    insert into fd_threads(kind, owner_type, owner_id, created_by, protected)
    values ('comments', p_owner_type, p_owner_id, bs_my_id(),
      coalesce(case p_owner_type when 'task' then (select protected from fd_tasks where id = p_owner_id)
                                 else (select protected from fd_handovers where id = p_owner_id) end, false))
    on conflict do nothing returning id into tid;
    if tid is null then select id into tid from fd_threads where kind = 'comments' and owner_type = p_owner_type and owner_id = p_owner_id; end if;
  end if;
  return tid;
end $$;
/* Privat tråd (dm, två personer) eller projekttråd (titel och deltagare). */
create or replace function fd_open_thread(p_kind text, p_members jsonb, p_title text default '') returns text
language plpgsql security definer set search_path = public as $$
declare me text := bs_my_id(); ids text[]; tid text; x text;
begin
  if me is null or not fd_member() then raise exception 'Du har ingen åtkomst till Foundation'; end if;
  ids := array(select distinct v from jsonb_array_elements_text(coalesce(p_members,'[]'::jsonb)) v where v <> me);
  if exists (select 1 from unnest(ids) v where not exists (select 1 from members where id = v and active)) then raise exception 'Okänd person'; end if;
  if p_kind = 'dm' then
    if cardinality(ids) <> 1 then raise exception 'Välj en person'; end if;
    select t.id into tid from fd_threads t where t.kind = 'dm'
       and (select count(*) from fd_thread_members m where m.thread_id = t.id) = 2
       and exists (select 1 from fd_thread_members m where m.thread_id = t.id and m.member_id = me)
       and exists (select 1 from fd_thread_members m where m.thread_id = t.id and m.member_id = ids[1]) limit 1;
    if tid is not null then return tid; end if;
  elsif p_kind = 'project' then
    if length(trim(coalesce(p_title,''))) < 2 then raise exception 'Ge projektet ett namn'; end if;
  else raise exception 'Ogiltig tråd'; end if;
  insert into fd_threads(kind, title, created_by) values (p_kind, trim(coalesce(p_title,'')), me) returning id into tid;
  insert into fd_thread_members(thread_id, member_id) values (tid, me);
  foreach x in array ids loop insert into fd_thread_members(thread_id, member_id) values (tid, x) on conflict do nothing; end loop;
  return tid;
end $$;
/* Lägg till deltagare i ett projekt (den som redan är med). */
create or replace function fd_thread_add(p_thread text, p_member text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from fd_threads where id = p_thread and kind = 'project') or not fd_can_thread(p_thread) then raise exception 'Projektet finns inte'; end if;
  insert into fd_thread_members(thread_id, member_id) values (p_thread, p_member) on conflict do nothing;
  perform fd_notify(p_member, 'thread', 'Du är med i ' || (select title from fd_threads where id = p_thread),
    coalesce((select name from members where id = bs_my_id()), 'Någon') || ' lade till dig i projektet.', 'thread', p_thread);
end $$;
/* Skriv i en tråd. Omnämnda (p_mentions, member-id) får en notis; i en privat tråd får
   mottagaren alltid en; i ett ärende får ansvarig/mottagare en. */
create or replace function fd_post(p_thread text, p_body text, p_mentions jsonb default '[]') returns fd_messages
language plpgsql security definer set search_path = public as $$
declare msg fd_messages; me text := bs_my_id(); who text := (select name from members where id = bs_my_id()); t fd_threads;
        x text; v_title text; snippet text; notified text[] := '{}';
begin
  if me is null or not fd_can_thread(p_thread) then raise exception 'Tråden finns inte'; end if;
  if length(trim(coalesce(p_body,''))) = 0 then raise exception 'Skriv något'; end if;
  select * into t from fd_threads where id = p_thread;
  insert into fd_messages(thread_id, author, body) values (p_thread, me, trim(p_body)) returning * into msg;
  perform fd_thread_seen(p_thread);
  snippet := case when t.protected then 'Öppna Bando Foundation för att läsa.' else left(trim(p_body), 160) end;
  v_title := case t.kind when 'dm' then who
                       when 'dept' then 'Avdelning ' || t.dept
                       when 'project' then t.title
                       else case when t.protected then 'ett skyddat ärende'
                         else coalesce((select title from fd_tasks where id = t.owner_id), (select subject from fd_handovers where id = t.owner_id), 'Ärende') end end;
  for x in select distinct v from jsonb_array_elements_text(coalesce(p_mentions,'[]'::jsonb)) v loop
    /* bara personer som får läsa tråden kan nämnas */
    if exists (select 1 from members where id = x and active) and fd_thread_reader(p_thread, x) then
      insert into fd_mentions(message_id, member_id) values (msg.id, x) on conflict do nothing;
      perform fd_notify(x, 'mention', who || ' nämnde dig: ' || v_title, snippet, 'thread', p_thread);
      notified := notified || x;
    end if;
  end loop;
  if t.kind = 'dm' then
    for x in select member_id from fd_thread_members where thread_id = p_thread and member_id <> me loop
      if not x = any(notified) then perform fd_notify(x, 'message', 'Meddelande från ' || who, snippet, 'thread', p_thread); end if;
    end loop;
  elsif t.kind = 'comments' then
    for x in select distinct v from unnest(case t.owner_type
        when 'task' then (select array[assignee, created_by] from fd_tasks where id = t.owner_id)
        else (select array[from_member, to_member] from fd_handovers where id = t.owner_id) end) v where v is not null and v <> me loop
      if not x = any(notified) then perform fd_notify(x, 'comment', who || ' kommenterade: ' || v_title, snippet, t.owner_type, t.owner_id); end if;
    end loop;
  end if;
  return msg;
end $$;
/* Får personen p_member läsa tråden? (för omnämnanden — körs som den som skriver) */
create or replace function fd_thread_reader(p_thread text, p_member text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case t.kind
      when 'dept' then exists (select 1 from fd_memberships where member_id = p_member and dept = t.dept)
                    or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      when 'comments' then exists (select 1 from fd_memberships f where f.member_id = p_member and f.dept in (
                             select dept from fd_tasks where id = t.owner_id
                             union select from_dept from fd_handovers where id = t.owner_id
                             union select to_dept from fd_handovers where id = t.owner_id))
                        or exists (select 1 from fd_tasks where id = t.owner_id and p_member in (assignee, created_by))
                        or exists (select 1 from fd_handovers where id = t.owner_id and p_member in (from_member, to_member))
                        or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      when 'project' then exists (select 1 from fd_thread_members where thread_id = t.id and member_id = p_member)
                       or exists (select 1 from members where id = p_member and 'foundation_admin' = any(perms))
      else exists (select 1 from fd_thread_members where thread_id = t.id and member_id = p_member) end
    from fd_threads t where t.id = p_thread), false)
$$;
create or replace function fd_mark_read(p_ids jsonb default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update fd_notifications set read_at = now() where member_id = bs_my_id() and read_at is null
     and (p_ids is null or id in (select (v)::bigint from jsonb_array_elements_text(p_ids) v));
  get diagnostics n = row_count; return n;
end $$;
/* Läst-markering. I avdelningsgrupper och kommentarer läggs läsaren till i trådens lista (det
   ger ingen åtkomst — den följer avdelningen eller ärendet); privata trådar och projekt
   ändrar bara den som redan är med. */
create or replace function fd_thread_seen(p_thread text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if bs_my_id() is null or not fd_can_thread(p_thread) then raise exception 'Tråden finns inte'; end if;
  if (select kind from fd_threads where id = p_thread) in ('dept','comments') then
    insert into fd_thread_members(thread_id, member_id, last_read_at) values (p_thread, bs_my_id(), now())
    on conflict (thread_id, member_id) do update set last_read_at = now();
  else
    update fd_thread_members set last_read_at = now() where thread_id = p_thread and member_id = bs_my_id();
  end if;
end $$;

/* Avdelningsuppdateringen (medlemmar och admin). */
create or replace function fd_save_update(p_dept text, p_working text, p_done text, p_help text, p_waiting text) returns fd_dept_updates
language plpgsql security definer set search_path = public as $$
declare u fd_dept_updates; before fd_dept_updates;
begin
  if not (fd_admin() or fd_in(p_dept)) then raise exception 'Bara avdelningens medlemmar uppdaterar den'; end if;
  select * into before from fd_dept_updates where dept = p_dept;
  update fd_dept_updates set working_on = left(coalesce(p_working,''), 2000), recently_done = left(coalesce(p_done,''), 2000),
         need_help = left(coalesce(p_help,''), 2000), waiting_for = left(coalesce(p_waiting,''), 2000),
         updated_by = bs_my_id(), updated_at = now() where dept = p_dept returning * into u;
  perform fd_log('update', p_dept, 'avdelningsuppdatering', to_jsonb(before), to_jsonb(u));
  return u;
end $$;

/* Adminöversikten: status per avdelning, väntande överlämningar, ärenden utan ansvarig och
   datum som närmar sig. Skyddade rader räknas bara med protected_data. */
create or replace function fd_overview(p_days int default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ok boolean := fd_protected_ok(); horizon date := (now() at time zone 'Europe/Stockholm')::date + greatest(1, coalesce(p_days,14));
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin'; end if;
  return jsonb_build_object(
    'departments', (select coalesce(jsonb_agg(jsonb_build_object(
        'code', d.code, 'name', d.name,
        'chief', (select m.name from fd_memberships f join members m on m.id = f.member_id where f.dept = d.code and f.role = 'chief'),
        'members', (select count(*) from fd_memberships f where f.dept = d.code),
        'open', (select count(*) from fd_tasks t where t.dept = d.code and t.status <> 'done' and (ok or not t.protected)),
        'waiting', (select count(*) from fd_tasks t where t.dept = d.code and t.status = 'waiting' and (ok or not t.protected)),
        'done30', (select count(*) from fd_tasks t where t.dept = d.code and t.status = 'done' and t.done_at > now() - interval '30 days' and (ok or not t.protected)),
        'in_waiting', (select count(*) from fd_handovers h where h.to_dept = d.code and h.status = 'sent' and (ok or not h.protected)),
        'out_waiting', (select count(*) from fd_handovers h where h.from_dept = d.code and h.status = 'sent' and (ok or not h.protected)),
        'update', (select to_jsonb(u) - 'dept' from fd_dept_updates u where u.dept = d.code)) order by d.sort), '[]'::jsonb) from fd_departments d),
    'waiting_handovers', (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at), '[]'::jsonb) from fd_handovers h where h.status = 'sent' and (ok or not h.protected)),
    'unassigned', (select coalesce(jsonb_agg(to_jsonb(t) order by t.due nulls last, t.created_at), '[]'::jsonb) from fd_tasks t
                    where t.assignee is null and t.status <> 'done' and (ok or not t.protected)),
    'upcoming', (select coalesce(jsonb_agg(x order by x->>'due'), '[]'::jsonb) from (
        select jsonb_build_object('type','task','id',t.id,'title',t.title,'dept',t.dept,'due',t.due,'status',t.status) x
          from fd_tasks t where t.status <> 'done' and t.due is not null and t.due <= horizon and (ok or not t.protected)
        union all
        select jsonb_build_object('type','handover','id',h.id,'title',h.subject,'dept',h.to_dept,'due',h.due,'status',h.status)
          from fd_handovers h where h.status <> 'done' and h.due is not null and h.due <= horizon and (ok or not h.protected)) s),
    'protected_hidden', case when ok then 0 else
        (select count(*) from fd_tasks where protected) + (select count(*) from fd_handovers where protected) end);
end $$;

-- ---------------------------------------------------------------------
--  FILER (Supabase Storage, bucket 'foundation', privat). Video är en länk (Drive).
--  Läsa och ta bort kräver en rad i fd_documents med samma sökväg som man får läsa;
--  ladda upp kräver att man får läsa det filen ska höra till (sökvägens två första delar).
-- ---------------------------------------------------------------------
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('foundation', 'foundation', false, 52428800, array[
  'application/pdf','image/png','image/jpeg','image/webp','image/gif','image/heic',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.apple.keynote','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv'])
on conflict (id) do nothing;
drop policy if exists fd_files_read on storage.objects;
create policy fd_files_read on storage.objects for select to authenticated
  using (bucket_id = 'foundation' and exists (select 1 from fd_documents d where d.storage_path = storage.objects.name and fd_can_doc(d.id)));
drop policy if exists fd_files_insert on storage.objects;
create policy fd_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'foundation' and fd_can_owner(split_part(name, '/', 1), split_part(name, '/', 2)));
drop policy if exists fd_files_delete on storage.objects;
create policy fd_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'foundation' and exists (select 1 from fd_documents d where d.storage_path = storage.objects.name
         and (d.uploaded_by = bs_my_id() or fd_admin()) and fd_can_doc(d.id)));

-- ---------------------------------------------------------------------
--  INBJUDNINGSLÄNKAR PER AVDELNING (2026-11-25)
--  En länk som admin delar (sms, gruppchatt) i stället för att samla in e-post. Länken är en
--  vanlig inbjudan i invites (samma join-flöde som studion: #join=KOD, konto, användarnamn) med
--  rollen foundation; fd_invite_links säger vilken avdelning den gäller. När någon använder den
--  (redeem_invite räknar upp uses) läggs personen in i avdelningen av triggern nedan.
-- ---------------------------------------------------------------------
create table if not exists fd_invite_links (
  token      text primary key references invites(token) on delete cascade,
  dept       text not null references fd_departments(code),
  created_by text references members(id) on delete set null,
  created_at timestamptz not null default now()
);
/* 2026-11-25: en länk kan gälla flera avdelningar (en person kan vara med i flera). dept = den första. */
alter table fd_invite_links add column if not exists depts text[] not null default '{}';
update fd_invite_links set depts = array[dept] where depts = '{}';
alter table fd_invite_links enable row level security;
drop policy if exists fd_invite_links_read on fd_invite_links;
create policy fd_invite_links_read on fd_invite_links for select to authenticated using (fd_admin());

/* "A och E" */
create or replace function fd_depts_text(p text[]) returns text
language sql immutable as $$
  select case when cardinality(p) <= 1 then coalesce(p[1], '')
              else array_to_string(p[1:cardinality(p)-1], ', ') || ' och ' || p[cardinality(p)] end
$$;

/* p_dept: en avdelning ("B") eller flera, kommaseparerade ("A,E"). */
create or replace function fd_create_link(p_dept text, p_days int default 30, p_max int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text; days int := least(greatest(coalesce(p_days, 30), 1), 90);
        ds text[] := array(select distinct upper(trim(x)) from unnest(string_to_array(coalesce(p_dept, ''), ',')) x where trim(x) <> '' order by 1);
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin skapar länkar'; end if;
  if cardinality(ds) = 0 then raise exception 'Välj minst en avdelning'; end if;
  if exists (select 1 from unnest(ds) x where not exists (select 1 from fd_departments where code = x)) then raise exception 'Avdelningen finns inte'; end if;
  if p_max is not null and p_max < 1 then raise exception 'Antalet måste vara minst 1'; end if;
  tok := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
               substr(md5(clock_timestamp()::text || random()::text), 1, 6));
  insert into invites(token, role, created_by, expires_at, max_uses, team)
  values (tok, 'foundation', bs_my_id(), now() + make_interval(days => days), p_max,
          'Bando Foundation, avdelning ' || fd_depts_text(ds));
  insert into fd_invite_links(token, dept, depts, created_by) values (tok, ds[1], ds, bs_my_id());
  perform fd_log('link', tok, 'länk skapad', null, jsonb_build_object('depts', to_jsonb(ds), 'days', days, 'max', p_max));
  return jsonb_build_object('token', tok, 'dept', ds[1], 'depts', to_jsonb(ds), 'expires_at', now() + make_interval(days => days), 'max_uses', p_max);
end $$;

create or replace function fd_links() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not fd_admin() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
      'token', l.token, 'dept', l.dept, 'depts', to_jsonb(case when l.depts = '{}' then array[l.dept] else l.depts end),
      'by', l.created_by, 'created_at', l.created_at, 'expires_at', i.expires_at,
      'max_uses', i.max_uses, 'uses', i.uses, 'open', not i.closed and i.expires_at > now() and (i.max_uses is null or i.uses < i.max_uses))
    order by l.created_at desc), '[]'::jsonb) end
  from fd_invite_links l join invites i on i.token = l.token
$$;

create or replace function fd_close_link(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not fd_admin() then raise exception 'Bara Foundation-admin stänger länkar'; end if;
  if not exists (select 1 from fd_invite_links where token = p_token) then raise exception 'Länken finns inte'; end if;
  update invites set closed = true where token = p_token;
  perform fd_log('link', p_token, 'länk stängd', null, null);
end $$;

/* Den som redan har ett konto (i studion eller i en annan avdelning) och öppnar en länk:
   samma kontroller som redeem_invite, sedan räknas länken upp och triggern lägger in avdelningarna. */
create or replace function fd_join_link(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv invites; l fd_invite_links; mid text := bs_my_id(); ds text[]; added text[];
begin
  if mid is null then raise exception 'Logga in först'; end if;
  select * into inv from invites where token = upper(trim(coalesce(p_token,''))) for update;
  select * into l from fd_invite_links where token = inv.token;
  if inv.token is null or l.token is null then raise exception 'Länken finns inte'; end if;
  if inv.closed then raise exception 'Länken är stängd'; end if;
  if inv.expires_at <= now() then raise exception 'Länken har gått ut'; end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then raise exception 'Länken är redan använd'; end if;
  ds := case when l.depts = '{}' then array[l.dept] else l.depts end;
  added := array(select x from unnest(ds) x where not exists (select 1 from fd_memberships where member_id = mid and dept = x));
  if cardinality(added) = 0 then return jsonb_build_object('ok', true, 'added', '[]'::jsonb, 'depts', to_jsonb(ds)); end if;
  update invites set uses = uses + 1 where token = inv.token;     /* fd_link_redeemed lägger in avdelningarna */
  return jsonb_build_object('ok', true, 'added', to_jsonb(added), 'depts', to_jsonb(ds));
end $$;

/* När en avdelningslänk används (redeem_invite för ett nytt konto, eller fd_join_link för ett
   befintligt): personen blir medlem i länkens avdelningar. Andra inbjudningar berörs inte. */
create or replace function fd_link_redeemed() returns trigger
language plpgsql security definer set search_path = public as $$
declare l fd_invite_links; mid text; nm text; d text; added text[] := '{}';
begin
  if new.uses <= old.uses then return new; end if;
  select * into l from fd_invite_links where token = new.token;
  if l.token is null then return new; end if;
  select id, name into mid, nm from members where user_id = auth.uid();
  if mid is null then return new; end if;
  foreach d in array (case when l.depts = '{}' then array[l.dept] else l.depts end) loop
    insert into fd_memberships(member_id, dept, role) values (mid, d, 'member') on conflict (member_id, dept) do nothing;
    if found then
      added := added || d;
      perform fd_log('membership', mid || ':' || d, 'gick med via länk', null, jsonb_build_object('role', 'member', 'link', new.token));
    end if;
  end loop;
  if cardinality(added) > 0 then
    perform fd_notify(l.created_by, 'member', 'Ny i avdelning ' || fd_depts_text(added) || ': ' || nm,
      nm || ' gick med via din inbjudningslänk.', 'dept', added[1]);
  end if;
  return new;
end $$;
drop trigger if exists fd_link_redeemed on invites;
create trigger fd_link_redeemed after update of uses on invites for each row execute function fd_link_redeemed();

-- ---------------------------------------------------------------------
--  RÄTTIGHETER: interna hjälpfunktioner stängs; resten bara för inloggade
-- ---------------------------------------------------------------------
revoke all on function fd_log(text, text, text, jsonb, jsonb, text), fd_notify(text, text, text, text, text, text),
  fd_notify_dept(text, text, text, text, text, text), fd_task_log(fd_tasks), fd_handover_log(fd_handovers), fd_link_redeemed(), fd_task_changed(), fd_document_changed(), fd_membership_guard(), fd_perms_guard()
  from public, anon, authenticated;
revoke all on function fd_handover_send(text, text, text, text, text, text, date, text, boolean), fd_handover_receive(text),
  fd_handover_status(text, text), fd_set_membership(text, text, text), fd_set_perm(text, text, boolean), fd_add_person(text, text, jsonb),
  fd_dept_thread(text), fd_comments_thread(text, text), fd_open_thread(text, jsonb, text), fd_thread_add(text, text),
  fd_post(text, text, jsonb), fd_mark_read(jsonb), fd_thread_seen(text), fd_save_update(text, text, text, text, text), fd_overview(int),
  fd_me(), fd_people(), fd_create_link(text, int, int), fd_links(), fd_close_link(text), fd_join_link(text)
  from public, anon;
grant execute on function fd_handover_send(text, text, text, text, text, text, date, text, boolean), fd_handover_receive(text),
  fd_handover_status(text, text), fd_set_membership(text, text, text), fd_set_perm(text, text, boolean), fd_add_person(text, text, jsonb),
  fd_dept_thread(text), fd_comments_thread(text, text), fd_open_thread(text, jsonb, text), fd_thread_add(text, text),
  fd_post(text, text, jsonb), fd_mark_read(jsonb), fd_thread_seen(text), fd_save_update(text, text, text, text, text), fd_overview(int),
  fd_me(), fd_people(), fd_create_link(text, int, int), fd_links(), fd_close_link(text), fd_join_link(text)
  to authenticated;
revoke all on table fd_departments, fd_memberships, fd_contacts, fd_handovers, fd_tasks, fd_threads, fd_thread_members,
  fd_messages, fd_mentions, fd_notifications, fd_documents, fd_dept_updates, fd_invite_links from anon;

-- ---------------------------------------------------------------------
--  FOUNDATION-ADMIN (beslut 2026-11-13): RKAY, Nabbe, Costa och AZ
-- ---------------------------------------------------------------------
update members set perms = array(select distinct x from unnest(perms || 'foundation_admin'::text) x order by 1)
 where lower(name) in ('rkay','nabbe','costa','az') and not 'foundation_admin' = any(perms);
