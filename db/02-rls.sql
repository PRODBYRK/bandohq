-- =====================================================================
--  BANDOHQ — behörigheter (Row Level Security)
--
--  Crewet (manager, admin, producent) läser och skriver posterna direkt.
--  Kamerateamet läser schemat och artisterna och skriver sin egen agenda
--  och sitt galleri. Cirkelledare, deltagare och kunder har INGEN
--  tabellåtkomst — de går via funktionerna i 03-funktioner.sql.
--  Mål och planer ser bara ägaren och managern — inte admins.
-- =====================================================================

alter table members enable row level security;
alter table invites enable row level security;
alter table records enable row level security;
alter table leads enable row level security;
alter table outbox enable row level security;
alter table push_subs enable row level security;
alter table login_fails enable row level security;

-- ---------- hjälpare (security definer: går förbi RLS internt) ----------
create or replace function bs_me() returns members
language sql stable security definer set search_path = public as $$
  select * from members where user_id = auth.uid() and active limit 1
$$;
create or replace function bs_my_id() returns text
language sql stable security definer set search_path = public as $$
  select id from members where user_id = auth.uid() and active
$$;
create or replace function bs_my_role() returns bs_role
language sql stable security definer set search_path = public as $$
  select role from members where user_id = auth.uid() and active
$$;
create or replace function bs_is_crew() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bs_my_role()::text in ('manager','admin','producer'), false)
$$;
create or replace function bs_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bs_my_role()::text = 'manager', false)
$$;
/* Admin sköter konton, inbjudningar, cirklar och artister — men ser inte
   allas mål. Därför två frågor: is_admin (manager ELLER admin) och is_manager. */
create or replace function bs_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bs_my_role()::text in ('manager','admin'), false)
$$;
create or replace function bs_is_camera() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bs_my_role()::text = 'camera', false)
$$;

/* Får jag LÄSA posten? */
create or replace function bs_can_read(p_kind text, p_id text, p_data jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when bs_is_crew() then
         p_kind not in ('goal','plan')
      or bs_is_manager()
      or (p_kind = 'goal' and p_data->>'owner' = bs_my_id())
      or (p_kind = 'plan' and p_id = bs_my_id())
    when bs_is_camera() then p_kind in ('booking','artist','agenda','media','setting')
    else false end
$$;
/* Får jag SKRIVA posten? Crewet som förut. Kameran: sin egen agenda (och de
   gemensamma uppgifterna, som alla får bocka av) och sina egna galleriposter. */
create or replace function bs_can_write(p_kind text, p_id text, p_data jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when bs_is_crew() then bs_can_read(p_kind, p_id, p_data)
    when bs_is_camera() then
         (p_kind = 'agenda' and coalesce(p_data->>'who','') in ('', (bs_me()).name))
      or (p_kind = 'media'  and p_data->>'by' = bs_my_id())
    else false end
$$;
/* Kvar för bakåtkompatibilitet — samma som att skriva. */
create or replace function bs_can_record(p_kind text, p_id text, p_data jsonb) returns boolean
language sql stable security definer set search_path = public as $$ select bs_can_write(p_kind, p_id, p_data) $$;

-- ---------- konton ----------
/* Crewet ser alla konton. Kameran ser bara teamet (crew + kamera), inte
   deltagarnas eller kundernas kontaktuppgifter. Alla ser sig själva. */
drop policy if exists members_read on members;
create policy members_read on members for select to authenticated
  using (bs_is_crew() or user_id = auth.uid()
      or (bs_is_camera() and role::text in ('manager','admin','producer','camera')));

drop policy if exists members_manager on members;
drop policy if exists members_admin on members;
create policy members_admin on members for all to authenticated
  using (bs_is_admin())
  with check (bs_is_admin() and (role::text <> 'manager' or bs_is_manager()));

drop policy if exists members_self on members;
create policy members_self on members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

/* WITH CHECK kan inte jämföra mot gamla raden — därför en trigger:
   admin ändrar roll, namn och status, men aldrig något som rör managerrollen;
   alla andra ändrar bara sin egen telefon, färg och Instagram.
   Undantag: redeem_invite kopplar en ny inloggning till ett konto som redan
   finns (bs.link sätts bara där, inom transaktionen). */
create or replace function bs_guard_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  /* Ingen inloggad användare = SQL-editorn eller servern själv: får ändra allt.
   (Anonyma via API:t når inte tabellen alls — RLS.) Obs: current_user duger
   inte här, i en security definer-funktion är det alltid ägaren. */
  if auth.uid() is null then return new; end if;
  if current_setting('bs.link', true) = '1' then return new; end if;
  if bs_is_manager() then return new; end if;
  if bs_is_admin() then
    if old.role::text = 'manager' or new.role::text = 'manager' then
      raise exception 'Bara managern kan ändra en manager';
    end if;
    new.user_id := old.user_id;
    return new;
  end if;
  new.id := old.id; new.role := old.role; new.name := old.name;
  new.active := old.active; new.user_id := old.user_id; new.email := old.email;
  new.team := old.team; new.producer := old.producer; new.username := old.username;
  return new;
end $$;
drop trigger if exists members_guard on members;
create trigger members_guard before update on members
  for each row execute function bs_guard_member();

-- ---------- inbjudningar och nya kunder: manager + admin ----------
drop policy if exists invites_manager on invites;
drop policy if exists invites_admin on invites;
create policy invites_admin on invites for all to authenticated
  using (bs_is_admin()) with check (bs_is_admin() and (role::text <> 'manager' or bs_is_manager()));

drop policy if exists leads_admin on leads;
create policy leads_admin on leads for select to authenticated using (bs_is_admin());
-- (nya förfrågningar skapas bara via public_request, svar bara via approve_lead/decline_lead)

-- ---------- utkorgen: bara läsning, för manager och admin ----------
drop policy if exists sms_admin on outbox;
drop policy if exists outbox_admin on outbox;
create policy outbox_admin on outbox for select to authenticated using (bs_is_admin());
-- (login_fails har ingen policy alls: bara servern når den)

-- ---------- push: var och en ser sina enheter, admins ser alla ----------
drop policy if exists push_read on push_subs;
create policy push_read on push_subs for select to authenticated
  using (member_id = bs_my_id() or bs_is_admin());
-- (läggs till och tas bort bara via save_push_sub / remove_push_sub)

-- ---------- poster ----------
drop policy if exists records_read on records;
create policy records_read on records for select to authenticated
  using (bs_can_read(kind, id, data));

drop policy if exists records_insert on records;
create policy records_insert on records for insert to authenticated
  with check (bs_can_write(kind, id, data));

drop policy if exists records_update on records;
create policy records_update on records for update to authenticated
  using (bs_can_write(kind, id, data)) with check (bs_can_write(kind, id, data));
-- Ingen DELETE-policy: borttagning är del = true, så att synken kan sprida den.
