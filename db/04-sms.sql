-- =====================================================================
--  BANDOHQ — SMS-notiser (köas här, skickas av 05-sms-utskick.sql)
--
--  Notiserna går inte att stänga av. De köas av triggers när något händer:
--    · förfrågningar (cirkel, kund, ny kund) och svaren på dem
--    · timmar som närmar sig 480 (vid 400, 440, 470 och 480)
--    · ändringar i agendan (samlade — högst ett SMS per halvtimme)
--    · påminnelse dagen innan ett pass (körs kl 17)
--  Tysta timmar 21–08 sköts av bs_sms() i 03-funktioner.sql.
-- =====================================================================

/* Timmar i cirklarna, samma regel som appens hoursFor() och my_view. */
create or replace function bs_hours(p_member text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum((r.data->>'hours')::numeric), 0)
    from records r, jsonb_array_elements_text(coalesce(r.data->'present','[]')) p(pid)
   where r.kind = 'booking' and not r.del and r.data->>'status' = 'done' and p.pid = p_member
$$;
create or replace function bs_member_by_name(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select id from members where lower(name) = lower(trim(coalesce(p_name,''))) and active limit 1
$$;
create or replace function bs_studio(p text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select data->>p from records where kind='setting' and id='studios'), 'studio ' || coalesce(p,''))
$$;
create or replace function bs_when(d jsonb) returns text
language sql immutable as $$
  select bs_day((d->>'date')::date) || ' ' || (d->>'start') || '-' || (d->>'end')
$$;

-- ---------------------------------------------------------------------
--  Händelser i posterna
-- ---------------------------------------------------------------------
create or replace function bs_notify_record() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := new.data;
  o jsonb := case when tg_op = 'UPDATE' then old.data else null end;
  actor text := bs_my_id();
  who text; rq text; rqname text; circ text; pid text; h numeric; th int; m record; win bigint;
begin
  if new.del then return new; end if;

  if new.kind = 'booking' then
    rq := d->>'reqBy';
    rqname := coalesce((select name from members where id = rq), d->>'who', 'Någon');
    /* ny förfrågan */
    if d->>'status' = 'request' and (o is null or coalesce(o->>'status','') <> 'request') then
      if coalesce(d->>'circleId','') <> '' then
        circ := (select data->>'n' from records where kind='circle' and id = d->>'circleId');
        who := bs_member_by_name(d->>'who');
        perform bs_sms(who, null, rqname || ' föreslår ' || bs_when(d) || ' för ' || coalesce(circ,'cirkeln')
          || '. Svara i BANDOHQ.', 'request', 'req:' || new.id || ':' || coalesce(who,''));
      else
        for m in select id from members where active and (role::text in ('manager','admin')
                   or id = (select producer from members where id = rq)) loop
          perform bs_sms(m.id, null, 'Ny bokningsförfrågan från ' || rqname || ': ' || bs_when(d) || ', '
            || bs_studio(d->>'studio') || '. Svara i BANDOHQ.', 'request', 'req:' || new.id || ':' || m.id);
        end loop;
      end if;
    end if;
    /* svar på en förfrågan */
    if o is not null and o->>'status' = 'request' and coalesce(d->>'status','') in ('','declined') and rq is not null then
      perform bs_sms(rq, null, case when d->>'status' = 'declined'
          then 'Tyvärr gick ' || bs_when(d) || ' inte. Föreslå gärna en annan tid i BANDOHQ.'
          else 'Godkänd: ' || bs_when(d) || ' i ' || bs_studio(d->>'studio') || '. Vi ses!' end,
        'answer', 'ans:' || new.id);
    end if;
    /* timmar som närmar sig ramen — bara den högsta gränsen man passerat */
    if d->>'status' = 'done' and (o is null or o->>'status' is distinct from 'done'
        or o->'present' is distinct from d->'present' or o->>'hours' is distinct from d->>'hours') then
      for pid in select jsonb_array_elements_text(coalesce(d->'present','[]')) loop
        h := bs_hours(pid);
        th := case when h >= 480 then 480 when h >= 470 then 470 when h >= 440 then 440 when h >= 400 then 400 else null end;
        if th is not null then
          perform bs_sms(pid, null, case when th = 480
              then 'Du har nått 480 timmar i studiecirkeln. Prata med din cirkelledare om vad som gäller nu.'
              else 'Du har ' || replace(regexp_replace(to_char(480 - h, 'FM9990.9'), '\.0?$', ''), '.', ',') || ' h kvar av dina 480 timmar i studiecirkeln.' end,
            'hours', 'hours:' || pid || ':' || th);
          if th = 480 then
            perform bs_sms(bs_member_by_name(d->>'who'), null,
              coalesce((select name from members where id = pid), 'En deltagare') || ' har nått 480 timmar.',
              'hours', 'hours:' || pid || ':480:leader');
          end if;
        end if;
      end loop;
    end if;

  elsif new.kind = 'agenda' then
    /* bara nya eller ändrade uppgifter — att bocka av är ingen nyhet */
    if o is not null and o->>'text' is not distinct from d->>'text' and o->>'who' is not distinct from d->>'who' then
      return new;
    end if;
    win := floor(extract(epoch from now()) / 1800);
    if coalesce(d->>'who','') <> '' then
      who := bs_member_by_name(d->>'who');
      if who is not null and who is distinct from actor then
        perform bs_sms_digest(who, 'Agendan har uppdaterats: %s nya eller ändrade uppgifter för dig. Se BANDOHQ.',
          'agenda', 'agenda:' || who || ':' || win, interval '10 minutes');
      end if;
    else
      for m in select id from members where active and role::text in ('manager','admin','producer','camera')
                 and id is distinct from actor loop
        perform bs_sms_digest(m.id, 'Gemensamma agendan har uppdaterats: %s ändringar. Se BANDOHQ.',
          'agenda', 'agenda-all:' || m.id || ':' || floor(extract(epoch from now()) / 7200), interval '10 minutes');
      end loop;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists records_notify on records;
create trigger records_notify after insert or update on records for each row execute function bs_notify_record();

/* Ny kund via bokningssidan → admins och managern. */
create or replace function bs_notify_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  for m in select id from members where active and role::text in ('manager','admin') loop
    perform bs_sms(m.id, null, 'Ny kund vill boka: ' || new.name || ', ' || bs_day(new.date) || ' ' || new.start_t || '-'
      || new.end_t || '. Svara i BANDOHQ.', 'lead', 'lead:' || new.id || ':' || m.id);
  end loop;
  return new;
end $$;
drop trigger if exists leads_notify on leads;
create trigger leads_notify after insert on leads for each row execute function bs_notify_lead();

-- ---------------------------------------------------------------------
--  Påminnelser dagen innan
-- ---------------------------------------------------------------------
/* Alla som har ett pass dagen p_day: den som bokat, de som är med, cirkelns
   ledare och medlemmar, och kunden. Nyckeln innehåller datum och tid — flyttas
   passet kommer en ny påminnelse. */
create or replace function sms_reminders(p_day date default null) returns int
language plpgsql security definer set search_path = public as $$
declare day date := coalesce(p_day, (now() at time zone 'Europe/Stockholm')::date + 1);
        b record; mid text; n int := 0; title text; ids text[];
begin
  for b in select id, data from records
            where kind = 'booking' and not del and data->>'date' = day::text
              and coalesce(data->>'status','') not in ('request','declined') loop
    ids := array[bs_member_by_name(b.data->>'who')]
        || array(select bs_member_by_name(x) from jsonb_array_elements_text(coalesce(b.data->'with','[]')) x);
    title := coalesce(nullif(b.data->>'title',''), 'Session');
    if coalesce(b.data->>'circleId','') <> '' then
      ids := ids || array(select jsonb_array_elements_text(coalesce(data->'members','[]'))
                            from records where kind='circle' and id = b.data->>'circleId');
    end if;
    for mid in select distinct x from unnest(ids) x where x is not null loop
      perform bs_sms(mid, null, 'Påminnelse: imorgon ' || (b.data->>'start') || '-' || (b.data->>'end') || ' i '
        || bs_studio(b.data->>'studio') || ' - ' || title || '.', 'reminder',
        'remind:' || b.id || ':' || day || ':' || (b.data->>'start') || ':' || mid);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
/* Körs varje timme av pg_cron; gör något först från kl 17 svensk tid.
   Dubbletter stoppas av dedupe-nyckeln, så det gör inget att den körs flera gånger. */
create or replace function sms_reminders_tick() returns int
language plpgsql security definer set search_path = public as $$
begin
  if extract(hour from now() at time zone 'Europe/Stockholm') < 17 then return 0; end if;
  return sms_reminders();
end $$;

-- ---------------------------------------------------------------------
--  För utskicket (edge-funktionen sms-send, med service_role)
-- ---------------------------------------------------------------------
/* Plockar ut det som ska skickas nu och låser det, så två körningar aldrig
   skickar samma SMS. */
create or replace function sms_claim(p_limit int default 50) returns setof sms_outbox
language sql security definer set search_path = public as $$
  update sms_outbox set attempts = attempts + 1, error = 'skickas', claimed_at = now()
   where id in (select id from sms_outbox
                 where sent_at is null and send_after <= now() and attempts < 5
                   and (claimed_at is null or claimed_at < now() - interval '10 minutes')
                 order by id limit p_limit for update skip locked)
  returning *
$$;
drop function if exists sms_done(bigint, boolean, int, text);
create or replace function sms_done(p_id bigint, p_ok boolean, p_cost int, p_error text, p_channel text default null)
returns void language sql security definer set search_path = public as $$
  update sms_outbox set sent_at = case when p_ok then now() end, cost = p_cost, claimed_at = null, channel = p_channel,
         error = case when p_ok then null else left(p_error, 300) end
   where id = p_id
$$;

-- ---------------------------------------------------------------------
--  PUSH
--  Notisen skickas först som push till personens enheter. Bara om ingen
--  enhet tar emot den (eller personen inte har push) går den som SMS.
-- ---------------------------------------------------------------------
/* Enheten sparar sin prenumeration. Samma enhet med ett annat konto tar över raden. */
create or replace function save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_ua text default '')
returns void language plpgsql security definer set search_path = public as $$
declare mid text := bs_my_id();
begin
  if mid is null then raise exception 'Logga in först'; end if;
  if p_endpoint !~ '^https://' or length(p_p256dh) < 80 or length(p_auth) < 16 then raise exception 'Ogiltig prenumeration'; end if;
  insert into push_subs(member_id, endpoint, p256dh, auth, ua) values (mid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua,''),200))
  on conflict (endpoint) do update set member_id = mid, p256dh = excluded.p256dh, auth = excluded.auth,
    ua = excluded.ua, fails = 0, created_at = now();
end $$;
create or replace function remove_push_sub(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subs where endpoint = p_endpoint and member_id = bs_my_id()
$$;
/* Servernyckeln (publik) — enheten behöver den för att prenumerera. */
create or replace function push_public_key() returns text
language sql stable security definer set search_path = public as $$
  select data->>'publicKey' from records where kind = 'setting' and id = 'push' and not del
$$;
/* "Skicka en testnotis" i profilen. */
create or replace function notify_test() returns void
language plpgsql security definer set search_path = public as $$
declare mid text := bs_my_id();
begin
  if mid is null then raise exception 'Logga in först'; end if;
  perform bs_sms(mid, null, 'Testnotis från BANDOHQ — det fungerar!', 'test', 'test:' || mid || ':' || now_ms());
end $$;

/* För utskicket (service_role): enheterna att skicka till, och resultatet. */
create or replace function push_targets(p_member text) returns setof push_subs
language sql stable security definer set search_path = public as $$
  select * from push_subs where member_id = p_member and fails < 5 order by id
$$;
create or replace function push_result(p_id bigint, p_ok boolean, p_gone boolean) returns void
language sql security definer set search_path = public as $$
  delete from push_subs where id = p_id and p_gone;
  update push_subs set last_ok = case when p_ok then now() else last_ok end,
         fails = case when p_ok then 0 else fails + 1 end
   where id = p_id and not p_gone;
$$;
/* Inställningen admins styr i Crew: viktiga notiser (påminnelser, timmar) även som SMS. */
create or replace function notify_policy() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select data from records where kind = 'setting' and id = 'notify' and not del), '{}'::jsonb)
$$;

/* Antal och kostnad den här månaden, och vilka som saknar push, för Crew-vyn. */
create or replace function sms_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin och manager'; end if;
  return (select jsonb_build_object(
      'sent', count(*) filter (where sent_at is not null and coalesce(channel,'sms') like '%sms%'),
      'push', count(*) filter (where sent_at is not null and channel like 'push%'),
      'queued', count(*) filter (where sent_at is null and attempts < 5),
      'failed', count(*) filter (where sent_at is null and attempts >= 5),
      'cost', coalesce(sum(cost),0) / 10000.0,
      'withPush', (select count(distinct member_id) from push_subs where fails < 5),
      'members', (select count(*) from members where active and user_id is not null),
      'noPush', (select coalesce(jsonb_agg(name order by name), '[]') from members m where active and user_id is not null
                   and not exists (select 1 from push_subs p where p.member_id = m.id and p.fails < 5)))
    from sms_outbox where created_at >= date_trunc('month', now()));
end $$;

-- ---------------------------------------------------------------------
--  Stäng de interna funktionerna
--  Supabase låter alla anropa alla funktioner via API:t om man inte säger
--  annat. De här skriver eller läser förbi behörigheterna och får bara
--  användas inifrån andra funktioner — aldrig direkt.
-- ---------------------------------------------------------------------
revoke all on function bs_put_booking(jsonb) from public, anon, authenticated;
revoke all on function bs_clash(text, tsrange, text) from public, anon, authenticated;
revoke all on function bs_sms(text,text,text,text,text,interval) from public, anon, authenticated;
revoke all on function bs_sms_digest(text,text,text,text,interval) from public, anon, authenticated;
revoke all on function bs_hours(text) from public, anon, authenticated;
revoke all on function bs_member_by_name(text) from public, anon, authenticated;
revoke all on function sms_claim(int) from public, anon, authenticated;
revoke all on function sms_done(bigint, boolean, int, text, text) from public, anon, authenticated;
revoke all on function push_targets(text) from public, anon, authenticated;
revoke all on function push_result(bigint, boolean, boolean) from public, anon, authenticated;
revoke all on function notify_policy() from public, anon, authenticated;
revoke all on function push_public_key() from public;
grant execute on function push_public_key() to anon, authenticated;
revoke all on function sms_reminders(date) from public, anon, authenticated;
revoke all on function sms_reminders_tick() from public, anon, authenticated;
revoke all on function bs_notify_record() from public, anon, authenticated;
revoke all on function bs_notify_lead() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sms_claim(int) to service_role;
    grant execute on function sms_done(bigint, boolean, int, text, text) to service_role;
    grant execute on function push_targets(text) to service_role;
    grant execute on function push_result(bigint, boolean, boolean) to service_role;
    grant execute on function notify_policy() to service_role;
    grant select, update on sms_outbox to service_role;
  end if;
end $$;
