-- =====================================================================
--  BANDOHQ — funktioner
--  Allt som kräver en kontroll appen inte kan göra själv: inbjudningar,
--  synken, och det cirkelledare, deltagare och kunder får göra.
-- =====================================================================

/* Svenskt nummer → E.164 (+46…). null om det inte ser ut som ett mobilnummer. */
create or replace function bs_phone(p text) returns text
language sql immutable as $$
  select case
    when n ~ '^\+[1-9][0-9]{7,14}$' then n
    when n ~ '^00[1-9][0-9]{7,14}$' then '+' || substr(n, 3)
    when n ~ '^0[1-9][0-9]{6,11}$'  then '+46' || substr(n, 2)
    when n ~ '^46[1-9][0-9]{6,11}$' then '+' || n
    else null end
  from (select regexp_replace(coalesce(p,''), '[\s\-().]', '', 'g') as n) x
$$;
/* SMS i GSM-teckenuppsättningen ryms 160 tecken; ett enda tankstreck gör det till
   UTF-16 och 70 tecken. Byt ut det vanligaste, kapa vid 160. */
create or replace function bs_gsm(p text) returns text
language sql immutable as $$
  select left(translate(coalesce(p,''), '–—·’‘“”…•', '--.''''""..'), 160)
$$;

/* Köa ett SMS. Telefonen tas från kontot om den inte anges. Samma dedupe_key
   köas bara en gång. Tysta timmar 21–08 (svensk tid): flyttas till 08:00. */
create or replace function bs_sms(p_member text, p_phone text, p_body text, p_kind text, p_key text,
                                  p_delay interval default '0') returns void
language plpgsql security definer set search_path = public as $$
declare ph text; t timestamptz := now() + p_delay; loc timestamp;
begin
  ph := bs_phone(coalesce(p_phone, (select phone from members where id = p_member and active)));
  /* utan nummer går det fortfarande som push, om personen har det */
  if ph is null and not exists (select 1 from push_subs where member_id = p_member and fails < 5) then return; end if;
  loc := t at time zone 'Europe/Stockholm';
  if extract(hour from loc) >= 21 then
    t := (date_trunc('day', loc) + interval '1 day 8 hours') at time zone 'Europe/Stockholm';
  elsif extract(hour from loc) < 8 then
    t := (date_trunc('day', loc) + interval '8 hours') at time zone 'Europe/Stockholm';
  end if;
  insert into sms_outbox(member_id, phone, body, kind, dedupe_key, send_after)
  values (p_member, coalesce(ph,''), bs_gsm(p_body), p_kind, p_key, t)
  on conflict (dedupe_key) do nothing;
end $$;

/* Samlat SMS: inom samma nyckel räknas n upp och texten skrivs om, i stället för
   ett SMS per ändring. p_fmt har %s där antalet ska stå. */
create or replace function bs_sms_digest(p_member text, p_fmt text, p_kind text, p_key text, p_delay interval)
returns void language plpgsql security definer set search_path = public as $$
begin
  update sms_outbox set n = n + 1, body = bs_gsm(format(p_fmt, n + 1))
   where dedupe_key = p_key and sent_at is null;
  if not found then perform bs_sms(p_member, null, format(p_fmt, 1), p_kind, p_key, p_delay); end if;
end $$;

/* "tor 9 okt" — samma form som appen. */
create or replace function bs_day(d date) returns text
language sql immutable as $$
  select (array['sön','mån','tis','ons','tor','fre','lör'])[extract(dow from d)::int + 1] || ' ' ||
         extract(day from d)::int || ' ' ||
         (array['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'])[extract(month from d)::int]
$$;

create or replace function bs_uid(prefix text) returns text
language sql volatile as $$
  select prefix || substr(md5(random()::text || clock_timestamp()::text), 1, 12)
$$;

/* Krockar passet med något som redan tar plats i studion? Förfrågningar och
   avböjda pass tar ingen plats — samma regel som booked() i appen. */
create or replace function bs_clash(p_studio text, p_span tsrange, p_ignore text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from records r
     where r.kind = 'booking' and not r.del
       and coalesce(r.data->>'status','') not in ('request','declined')
       and r.data->>'studio' = p_studio
       and r.id <> coalesce(p_ignore,'')
       and bs_span(r.data) && p_span)
$$;

create or replace function bs_put_booking(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t bigint := now_ms();
begin
  d := d || jsonb_build_object('up', t, 'del', coalesce((d->>'del')::boolean, false));
  insert into records(kind,id,data,up,del) values ('booking', d->>'id', d, t, (d->>'del')::boolean)
  on conflict (kind,id) do update set data = excluded.data, up = excluded.up, del = excluded.del;
  return d;
end $$;

-- =====================================================================
--  SYNK FÖR CREWET
-- =====================================================================
/* Skickar poster; varje post skrivs bara om den är nyare än den som finns.
   Kör som anroparen (security invoker) — RLS gäller, och poster man inte
   får skriva (t.ex. någon annans mål) hoppas över i stället för att fälla
   hela omgången. */
create or replace function push_records(rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  insert into records (kind, id, data, up, del)
  select x->>'kind', x->>'id', x->'data', (x->>'up')::bigint, coalesce((x->>'del')::boolean, false)
    from jsonb_array_elements(rows) x
   where bs_can_write(x->>'kind', x->>'id', x->'data')
  on conflict (kind, id) do update
     set data = excluded.data, up = excluded.up, del = excluded.del
   where records.up < excluded.up;
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
--  INBJUDNINGAR
-- =====================================================================
drop function if exists create_invite(bs_role, text, int, int);
/* Admin och manager bjuder in. En inbjudan med namn och telefon är personlig
   (admin "lägger till en person") — då skickas länken som SMS om p_url anges. */
create or replace function create_invite(p_role bs_role, p_circle text, p_days int, p_max int,
  p_team text default null, p_name text default null, p_phone text default null, p_url text default null)
returns text language plpgsql security definer set search_path = public as $$
declare tok text; nm text := nullif(trim(coalesce(p_name,'')),'');
begin
  if not bs_is_admin() then raise exception 'Bara admin och manager kan bjuda in'; end if;
  if p_role::text = 'manager' and not bs_is_manager() then raise exception 'Bara managern kan bjuda in en manager'; end if;
  if p_role::text in ('leader','participant') and p_circle is null then
    raise exception 'Välj vilken cirkel inbjudan gäller';
  end if;
  if p_phone is not null and bs_phone(p_phone) is null then raise exception 'Telefonnumret ser fel ut'; end if;
  tok := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
               substr(md5(clock_timestamp()::text || random()::text), 1, 6));
  insert into invites(token, role, circle_id, created_by, expires_at, max_uses, team, name, phone)
  values (tok, p_role, p_circle, bs_my_id(), now() + make_interval(days => greatest(1, coalesce(p_days,14))),
          case when nm is not null then 1 else p_max end, nullif(trim(coalesce(p_team,'')),''), nm, bs_phone(p_phone));
  if p_phone is not null and p_url is not null then
    perform bs_sms(null, p_phone, 'Hej ' || split_part(coalesce(nm,''),' ',1) || '! Du är inbjuden till BANDOHQ. Skapa ditt konto här: '
      || p_url || '#join=' || tok, 'invite', 'invite:' || tok);
  end if;
  return tok;
end $$;

/* Vad en länk gäller — visas på inbjudningssidan innan man skapar konto. */
create or replace function invite_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare inv invites; cname text;
begin
  select * into inv from invites where token = upper(trim(p_token));
  if inv.token is null then return jsonb_build_object('ok', false, 'why', 'Länken finns inte'); end if;
  select data->>'n' into cname from records where kind = 'circle' and id = inv.circle_id;
  return jsonb_build_object(
    'ok', not inv.closed and inv.expires_at > now() and (inv.max_uses is null or inv.uses < inv.max_uses),
    'why', case when inv.closed then 'Länken är stängd'
                when inv.expires_at <= now() then 'Länken har gått ut'
                when inv.max_uses is not null and inv.uses >= inv.max_uses then 'Länken är redan använd'
                else '' end,
    'role', inv.role, 'circle', cname, 'team', inv.team, 'name', inv.name);
end $$;

/* Löser in en länk för den som just skapat sitt konto. Rollen och
   cirkelkopplingen kommer härifrån — aldrig från klienten. */
create or replace function redeem_invite(p_token text, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv invites; mid text; em text; nm text := trim(coalesce(p_name,''));
begin
  if auth.uid() is null then raise exception 'Skapa kontot först'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'Du har redan ett konto';
  end if;
  select * into inv from invites where token = upper(trim(p_token)) for update;
  if inv.token is null                                      then raise exception 'Länken finns inte'; end if;
  if inv.closed                                             then raise exception 'Länken är stängd'; end if;
  if inv.expires_at <= now()                                then raise exception 'Länken har gått ut'; end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses  then raise exception 'Länken är redan använd'; end if;
  if length(nm) < 2 then raise exception 'Fyll i ditt namn'; end if;
  /* SMS-notiserna går inte att stänga av — alla behöver ett nummer. */
  if bs_phone(coalesce(nullif(trim(coalesce(p_phone,'')),''), inv.phone)) is null then
    raise exception 'Fyll i ett mobilnummer — notiserna kommer som SMS';
  end if;
  if exists (select 1 from members where lower(name) = lower(nm)) then
    raise exception 'Namnet finns redan — lägg till efternamnet';
  end if;

  select email into em from auth.users where id = auth.uid();
  mid := bs_uid('m_');
  insert into members (id, user_id, role, name, email, phone, team, up)
  values (mid, auth.uid(), inv.role, nm, em, bs_phone(coalesce(nullif(trim(coalesce(p_phone,'')),''), inv.phone)),
          inv.team, now_ms());

  /* En godkänd ny kund: bokningen från förfrågan blir kundens egen. */
  if inv.lead_id is not null then
    update records set data = data || jsonb_build_object('who', nm, 'reqBy', mid, 'up', now_ms()), up = now_ms()
     where kind = 'booking' and data->>'leadId' = inv.lead_id;
  end if;

  if inv.circle_id is not null and inv.role = 'participant' then
    update records
       set data = jsonb_set(data, '{members}', coalesce(data->'members','[]'::jsonb) || to_jsonb(mid))
                  || jsonb_build_object('up', now_ms()),
           up = now_ms()
     where kind = 'circle' and id = inv.circle_id;
  elsif inv.circle_id is not null and inv.role = 'leader' then
    update records
       set data = data || jsonb_build_object('leader', nm, 'up', now_ms()), up = now_ms()
     where kind = 'circle' and id = inv.circle_id;
  end if;

  update invites set uses = uses + 1 where token = inv.token;
  return jsonb_build_object('id', mid, 'role', inv.role, 'name', nm);
end $$;

-- =====================================================================
--  LEDARE, DELTAGARE, KUND — det enda de når
-- =====================================================================
create or replace function bs_leads(p_circle text) returns boolean
language sql stable security definer set search_path = public as $$
  select bs_is_crew() or exists (
    select 1 from records where kind = 'circle' and id = p_circle and not del
       and data->>'leader' = (bs_me()).name)
$$;

/* Allt en icke-crew-användare får se, i ett svar. */
create or replace function my_view() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me members; cids text[]; res jsonb; studios jsonb; rates jsonb;
begin
  me := bs_me();
  if me.id is null then raise exception 'Inget konto'; end if;
  select data into studios from records where kind = 'setting' and id = 'studios';
  select data into rates   from records where kind = 'setting' and id = 'rates';

  if me.role = 'customer' then
    return jsonb_build_object('me', to_jsonb(me), 'studios', studios, 'rates', rates,
      'producer', (select name from members where id = me.producer and active),
      'bookings', coalesce((select jsonb_agg(data) from records
         where kind='booking' and not del and data->>'who' = me.name), '[]'),
      /* andras pass bara som upptagen tid — inga namn, ingen titel */
      'busy', coalesce((select jsonb_agg(jsonb_build_object('id',id,'studio',data->>'studio',
         'date',data->>'date','start',data->>'start','end',data->>'end')) from records
         where kind='booking' and not del and coalesce(data->>'status','') not in ('request','declined')
           and data->>'who' <> me.name), '[]'));
  end if;

  select array_agg(id) into cids from records
   where kind = 'circle' and not del
     and ((me.role = 'participant' and data->'members' ? me.id)
       or (me.role = 'leader' and data->>'leader' = me.name));
  cids := coalesce(cids, '{}');

  res := jsonb_build_object(
    'me', to_jsonb(me), 'studios', studios,
    'circles', coalesce((select jsonb_agg(data) from records where kind='circle' and id = any(cids)), '[]'),
    'curricula', coalesce((select jsonb_agg(c.data) from records c where c.kind='curriculum' and not c.del
        and c.id in (select data->>'curriculumId' from records where kind='circle' and id = any(cids))), '[]'),
    /* cirkelns pass — men andra deltagares obesvarade förfrågningar visas inte */
    'bookings', coalesce((select jsonb_agg(data) from records where kind='booking' and not del
        and data->>'circleId' = any(cids)
        and (me.role = 'leader' or coalesce(data->>'status','') <> 'request' or data->>'reqBy' = me.id)), '[]'),
    /* timmar räknas på servern — även närvaro i cirklar man inte längre är med i */
    'hours', coalesce((select jsonb_object_agg(pid, h) from (
        select p.pid, sum((r.data->>'hours')::numeric) h
          from records r, jsonb_array_elements_text(coalesce(r.data->'present','[]')) p(pid)
         where r.kind='booking' and not r.del and r.data->>'status' = 'done'
           and (p.pid = me.id or (me.role = 'leader' and p.pid in (
                 select jsonb_array_elements_text(data->'members') from records
                  where kind='circle' and id = any(cids))))
         group by p.pid) x), '{}'));

  if me.role = 'leader' then
    /* ledaren bokar studio och behöver se när den är upptagen — som kunden,
       utan namn och titel på andras pass */
    res := res || jsonb_build_object('busy', coalesce((select jsonb_agg(jsonb_build_object('id',id,
        'studio',data->>'studio','date',data->>'date','start',data->>'start','end',data->>'end')) from records
       where kind='booking' and not del and coalesce(data->>'status','') not in ('request','declined')
         and coalesce(data->>'circleId','') <> all(cids)), '[]'));
    /* ledaren ser sina medlemmars kontaktuppgifter — ingen annans */
    res := res || jsonb_build_object('people', coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'name',m.name,'role',m.role,'email',m.email,'phone',m.phone,'color',m.color))
      from members m where m.active and m.id in (
        select jsonb_array_elements_text(data->'members') from records where kind='circle' and id = any(cids))), '[]'));
  else
    res := res || jsonb_build_object('people', coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'name',m.name,'role',m.role,'color',m.color))
      from members m where m.active and m.name in (
        select data->>'leader' from records where kind='circle' and id = any(cids))), '[]'));
  end if;
  return res;
end $$;

create or replace function request_session(p_circle text, p_date date, p_start text, p_end text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); c jsonb;
begin
  select data into c from records where kind='circle' and id = p_circle and not del;
  if c is null then raise exception 'Cirkeln finns inte'; end if;
  if me.role <> 'participant' or not (c->'members' ? me.id) then
    raise exception 'Du är inte med i den cirkeln';
  end if;
  if p_start = p_end then raise exception 'Start och slut är samma tid'; end if;
  return bs_put_booking(jsonb_build_object('id', bs_uid('b'), 'studio','', 'date', p_date::text,
    'start', p_start, 'end', p_end, 'who', c->>'leader', 'title', c->>'n', 'note','',
    'circleId', p_circle, 'status','request', 'reqBy', me.id, 'hours', null,
    'present','[]'::jsonb, 'paid', false, 'with','[]'::jsonb, 'artistId',''));
end $$;

create or replace function book_circle_session(p_circle text, p_date date, p_start text, p_end text, p_studio text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb; d jsonb;
begin
  if not bs_leads(p_circle) then raise exception 'Bara cirkelns ledare kan boka'; end if;
  select data into c from records where kind='circle' and id = p_circle;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  if p_start = p_end then raise exception 'Start och slut är samma tid'; end if;
  d := jsonb_build_object('id', bs_uid('b'), 'studio', p_studio, 'date', p_date::text, 'start', p_start,
    'end', p_end, 'who', c->>'leader', 'title', c->>'n', 'note','', 'circleId', p_circle, 'status','',
    'hours', null, 'present','[]'::jsonb, 'paid', false, 'with','[]'::jsonb, 'artistId','');
  if bs_clash(p_studio, bs_span(d), null) then raise exception 'Studion är upptagen den tiden'; end if;
  return bs_put_booking(d);
end $$;

create or replace function answer_request(p_booking text, p_approve boolean, p_studio text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null or d->>'status' <> 'request' then raise exception 'Förfrågan finns inte längre'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan svara'; end if;
  if not p_approve then return bs_put_booking(d || '{"status":"declined"}'); end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  /* kollas här, inte bara i appen — någon kan ha bokat tiden under tiden */
  if bs_clash(p_studio, bs_span(d), p_booking) then raise exception 'Studion hann bli upptagen'; end if;
  return bs_put_booking(d || jsonb_build_object('studio', p_studio, 'status', ''));
end $$;

create or replace function complete_session(p_booking text, p_hours numeric, p_present jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; c jsonb; bad int;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null or coalesce(d->>'circleId','') = '' then raise exception 'Passet finns inte'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan markera genomförd'; end if;
  if d->>'status' in ('request','declined') then raise exception 'Passet är inte bokat'; end if;
  if p_hours is null then   /* ångra */
    return bs_put_booking(d || '{"status":"","hours":null,"present":[],"completedBy":""}');
  end if;
  if p_hours <= 0 or p_hours > 24 then raise exception 'Ange mellan 0,5 och 24 timmar'; end if;
  select data into c from records where kind='circle' and id = d->>'circleId';
  select count(*) into bad from jsonb_array_elements_text(coalesce(p_present,'[]')) p(x)
   where not (c->'members' ? p.x);
  if bad > 0 then raise exception 'Någon av de närvarande är inte med i cirkeln'; end if;
  return bs_put_booking(d || jsonb_build_object('status','done','hours',p_hours,
    'present', coalesce(p_present,'[]'), 'completedBy', (bs_me()).name, 'completedAt', now_ms()));
end $$;

/* Kunden bokar inte själv längre — hen skickar en förfrågan (request_customer_slot).
   Kvar för crewet, som kan boka åt en kund. */
create or replace function book_customer_slot(p_date date, p_start text, p_end text, p_studio text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); d jsonb;
begin
  if not bs_is_crew() then raise exception 'Skicka en förfrågan — crewet bekräftar tiden'; end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  if p_start = p_end then raise exception 'Start och slut är samma tid'; end if;
  d := jsonb_build_object('id', bs_uid('b'), 'studio', p_studio, 'date', p_date::text, 'start', p_start,
    'end', p_end, 'who', me.name, 'title','Studiotid', 'note','', 'circleId','', 'status','',
    'hours', null, 'present','[]'::jsonb, 'paid', true, 'with','[]'::jsonb, 'artistId','');
  if bs_clash(p_studio, bs_span(d), null) then raise exception 'Tiden är redan bokad'; end if;
  return bs_put_booking(d);
end $$;

/* Kunden ser lediga tider och skickar en förfrågan. Studion är ett önskemål;
   ingen tid reserveras förrän crewet godkänt (answer_request). */
create or replace function request_customer_slot(p_date date, p_start text, p_end text, p_studio text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); d jsonb;
begin
  if me.role is distinct from 'customer' then raise exception 'Bara kunder skickar förfrågningar här'; end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  if p_start = p_end then raise exception 'Start och slut är samma tid'; end if;
  if p_date < current_date then raise exception 'Välj en dag framåt i tiden'; end if;
  if (select count(*) from records where kind='booking' and not del and data->>'status'='request'
        and data->>'reqBy' = me.id) >= 5 then
    raise exception 'Du har redan fem obesvarade förfrågningar';
  end if;
  d := jsonb_build_object('id', bs_uid('b'), 'studio', p_studio, 'date', p_date::text, 'start', p_start,
    'end', p_end, 'who', me.name, 'title','Studiotid', 'note', left(coalesce(p_note,''),200), 'circleId','',
    'status','request', 'reqBy', me.id, 'hours', null, 'present','[]'::jsonb, 'paid', true,
    'with','[]'::jsonb, 'artistId','');
  if bs_clash(p_studio, bs_span(d), null) then raise exception 'Tiden är redan bokad'; end if;
  return bs_put_booking(d);
end $$;

-- =====================================================================
--  NYA KUNDER — bokningssidan utan konto
-- =====================================================================
/* Upptagen tid, utan namn och titel, för bokningssidan. Högst 31 dagar åt gången. */
create or replace function free_slots(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('studio',data->>'studio','date',data->>'date',
           'start',data->>'start','end',data->>'end')), '[]')
    from records
   where kind='booking' and not del and coalesce(data->>'status','') not in ('request','declined')
     and (data->>'date')::date between p_from and least(p_to, p_from + 31)
$$;

/* En ny kund föreslår en tid. p_hp är ett dolt fält som bara robotar fyller i. */
create or replace function public_request(p_name text, p_email text, p_phone text, p_date date,
  p_start text, p_end text, p_studio text, p_message text, p_hp text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare ph text := bs_phone(p_phone); id text; nm text := trim(coalesce(p_name,'')); em text := lower(trim(coalesce(p_email,'')));
begin
  if coalesce(p_hp,'') <> '' then return jsonb_build_object('ok', true); end if;      -- robot: säg ok, gör inget
  if length(nm) < 2 then raise exception 'Fyll i ditt namn'; end if;
  if ph is null then raise exception 'Fyll i ett mobilnummer — svaret kommer som SMS'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-postadressen ser fel ut'; end if;
  if p_date < current_date or p_date > current_date + 120 then raise exception 'Välj en dag inom de närmaste fyra månaderna'; end if;
  if p_start !~ '^\d\d:\d\d$' or p_end !~ '^\d\d:\d\d$' or p_start = p_end then raise exception 'Välj start och slut'; end if;
  if coalesce(p_studio,'') not in ('','A','B') then raise exception 'Välj studio'; end if;
  if (select count(*) from leads where status = 'new' and (phone = ph or lower(email) = em)) >= 3 then
    raise exception 'Du har redan tre förfrågningar som väntar på svar';
  end if;
  if (select count(*) from leads where created_at > now() - interval '1 day') >= 30 then
    raise exception 'Många förfrågningar just nu — försök igen imorgon';
  end if;
  id := bs_uid('l_');
  insert into leads(id, name, email, phone, date, start_t, end_t, studio, message)
  values (id, left(nm,60), left(em,120), ph, p_date, p_start, p_end, nullif(p_studio,''), left(coalesce(p_message,''),300));
  return jsonb_build_object('ok', true);
end $$;

/* Admin godkänner: bokningen skapas, en kundinbjudan skickas som SMS. När
   kunden gått med blir bokningen hens (redeem_invite, lead_id). */
create or replace function approve_lead(p_lead text, p_studio text, p_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l leads; d jsonb; tok text;
begin
  if not bs_is_admin() then raise exception 'Bara admin och manager svarar på nya kunder'; end if;
  select * into l from leads where id = p_lead for update;
  if l.id is null or l.status <> 'new' then raise exception 'Förfrågan finns inte längre'; end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  d := jsonb_build_object('id', bs_uid('b'), 'studio', p_studio, 'date', l.date::text, 'start', l.start_t,
    'end', l.end_t, 'who', l.name, 'title','Studiotid', 'note', coalesce(l.message,''), 'circleId','',
    'status','', 'hours', null, 'present','[]'::jsonb, 'paid', true, 'with','[]'::jsonb, 'artistId','',
    'leadId', l.id);
  if bs_clash(p_studio, bs_span(d), null) then raise exception 'Studion hann bli upptagen'; end if;
  perform bs_put_booking(d);
  tok := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
               substr(md5(clock_timestamp()::text || random()::text), 1, 6));
  insert into invites(token, role, created_by, expires_at, max_uses, name, phone, lead_id)
  values (tok, 'customer', bs_my_id(), now() + interval '30 days', 1, l.name, l.phone, l.id);
  update leads set status = 'approved', booking_id = d->>'id', invite = tok, handled_by = bs_my_id() where id = l.id;
  perform bs_sms(null, l.phone, 'Hej ' || split_part(l.name,' ',1) || '! Din tid ' || bs_day(l.date) || ' ' || l.start_t || '-' || l.end_t
    || ' är bokad. Skapa ditt konto för att se och ändra den: ' || p_url || '#join=' || tok, 'lead', 'lead-ok:' || l.id);
  return jsonb_build_object('booking', d->>'id', 'invite', tok);
end $$;

create or replace function decline_lead(p_lead text, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare l leads;
begin
  if not bs_is_admin() then raise exception 'Bara admin och manager svarar på nya kunder'; end if;
  select * into l from leads where id = p_lead for update;
  if l.id is null or l.status <> 'new' then raise exception 'Förfrågan finns inte längre'; end if;
  update leads set status = 'declined', handled_by = bs_my_id() where id = l.id;
  perform bs_sms(null, l.phone, 'Hej ' || split_part(l.name,' ',1) || '! Tyvärr kan vi inte ta tiden ' || bs_day(l.date) || ' '
    || l.start_t || '-' || l.end_t || '.' || case when coalesce(p_reason,'') <> '' then ' ' || p_reason else ' Hör av dig för en annan tid!' end
    || ' /BANDOHQ', 'lead', 'lead-no:' || l.id);
end $$;

/* Kund avbokar sin bokning, deltagare tar tillbaka sin förfrågan. */
create or replace function cancel_my_booking(p_booking text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); d jsonb;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null then raise exception 'Bokningen finns inte'; end if;
  if not ((me.role = 'customer' and d->>'who' = me.name)
       or (me.role = 'participant' and d->>'status' = 'request' and d->>'reqBy' = me.id)) then
    raise exception 'Det är inte din bokning';
  end if;
  return bs_put_booking(d || '{"del":true}');
end $$;

-- Anonyma får bara läsa vad en inbjudan gäller. Allt annat kräver inloggning.
revoke all on function invite_info(text) from public, anon;
grant execute on function invite_info(text) to anon, authenticated;
revoke all on function free_slots(date, date) from public, anon;
grant execute on function free_slots(date, date) to anon, authenticated;
revoke all on function public_request(text,text,text,date,text,text,text,text,text) from public, anon;
grant execute on function public_request(text,text,text,date,text,text,text,text,text) to anon, authenticated;
