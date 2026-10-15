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
/* v9: SMS är borta — notiserna går som push och mejl. De gamla funktionerna tas bort. */
drop function if exists bs_sms(text,text,text,text,text,interval);
drop function if exists bs_sms_digest(text,text,text,text,interval);
drop function if exists bs_gsm(text);

/* Köa en notis. Mejladressen tas från kontot om den inte anges; utan både mejl
   och push hoppas den över. Samma dedupe_key köas bara en gång. Påminnelser,
   timmar och agenda håller tysta timmar 21–08 (svensk tid) — de går som push. */
create or replace function bs_notify(p_member text, p_email text, p_subject text, p_body text, p_kind text,
                                     p_key text, p_delay interval default '0', p_link text default null) returns void
language plpgsql security definer set search_path = public as $$
declare em text; t timestamptz := now() + p_delay; loc timestamp;
begin
  em := lower(nullif(trim(coalesce(p_email, (select email from members where id = p_member and active), '')), ''));
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := null; end if;
  if em is null and not exists (select 1 from push_subs where member_id = p_member and fails < 5) then return; end if;
  if p_kind in ('reminder','hours','agenda') then
    loc := t at time zone 'Europe/Stockholm';
    if extract(hour from loc) >= 21 then
      t := (date_trunc('day', loc) + interval '1 day 8 hours') at time zone 'Europe/Stockholm';
    elsif extract(hour from loc) < 8 then
      t := (date_trunc('day', loc) + interval '8 hours') at time zone 'Europe/Stockholm';
    end if;
  end if;
  insert into outbox(member_id, email, subject, body, kind, dedupe_key, send_after, link)
  values (p_member, em, p_subject, p_body, p_kind, p_key, t, p_link)
  on conflict (dedupe_key) do nothing;
end $$;

/* Samlad notis: inom samma nyckel räknas n upp och texten skrivs om, i stället för
   en notis per ändring. p_fmt har %s där antalet ska stå. */
create or replace function bs_notify_digest(p_member text, p_subject text, p_fmt text, p_kind text, p_key text, p_delay interval)
returns void language plpgsql security definer set search_path = public as $$
begin
  update outbox set n = n + 1, body = format(p_fmt, n + 1)
   where dedupe_key = p_key and sent_at is null and claimed_at is null;
  if not found then perform bs_notify(p_member, null, p_subject, format(p_fmt, 1), p_kind, p_key, p_delay); end if;
end $$;

/* Samlad lista: varje händelse blir en rad i samma mejl (t.ex. tolv bokade pass på
   en gång blir ett mejl, inte tolv). p_many har %s där antalet ska stå. */
create or replace function bs_notify_append(p_member text, p_email text, p_subject text, p_many text, p_head text,
                                            p_line text, p_kind text, p_key text, p_delay interval) returns void
language plpgsql security definer set search_path = public as $$
begin
  update outbox set n = n + 1, body = body || E'\n' || p_line, subject = format(p_many, n + 1)
   where dedupe_key = p_key and sent_at is null and claimed_at is null;
  if not found then
    perform bs_notify(p_member, p_email, p_subject, p_head || E'\n\n' || p_line, p_kind, p_key, p_delay);
  end if;
end $$;

/* Rollen i klartext — för mejlen. */
create or replace function bs_role_sv(r text) returns text
language sql immutable as $$
  select case r when 'manager' then 'manager' when 'admin' then 'admin' when 'producer' then 'producent'
    when 'leader' then 'cirkelledare' when 'participant' then 'deltagare' when 'customer' then 'kund'
    when 'camera' then 'kamerateam' else coalesce(r,'') end
$$;

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

/* Kunder, deltagare och nya kunder bokar alltid tre timmar (valfri start). */
create or replace function bs_three_hours(d jsonb) returns boolean
language sql immutable as $$ select upper(bs_span(d)) - lower(bs_span(d)) = interval '3 hours' $$;
/* Minst en studio är ledig hela tiden — kunder och deltagare väljer ingen studio själva. */
create or replace function bs_any_free(p_span tsrange, p_ignore text) returns boolean
language sql stable security definer set search_path = public as $$
  select not bs_clash('A', p_span, p_ignore) or not bs_clash('B', p_span, p_ignore)
$$;
/* När passet börjar, som riktig tidpunkt (datum och tid är svensk tid). */
create or replace function bs_starts(d jsonb) returns timestamptz
language sql stable as $$ select lower(bs_span(d)) at time zone 'Europe/Stockholm' $$;

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
/* Får jag skriva över posten som redan ligger där (om någon)? Läser förbi RLS — annars
   skulle en post man inte får se ge ett fel som stoppar hela synkomgången. */
create or replace function bs_existing_writable(p_kind text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select bs_can_write(kind, id, data) from records where kind = p_kind and id = p_id), true)
$$;
create or replace function push_records(rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  /* Poster man inte får skriva hoppas över tyst — resten av omgången går igenom. */
  insert into records (kind, id, data, up, del)
  select x->>'kind', x->>'id', x->'data', (x->>'up')::bigint, coalesce((x->>'del')::boolean, false)
    from jsonb_array_elements(rows) x
   where bs_can_write(x->>'kind', x->>'id', x->'data')
     and bs_existing_writable(x->>'kind', x->>'id')
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
drop function if exists create_invite(bs_role, text, int, int, text, text, text, text);
/* Admin och manager bjuder in. Med p_email skickas länken som mejl. Med p_member
   gäller inbjudan en person som redan finns i appen men inte har loggat in —
   inloggningen kopplas då till den raden (redeem_invite), och rollen sätts från
   inbjudan. En ny inbjudan till samma person stänger den förra. */
create or replace function create_invite(p_role bs_role, p_circle text, p_days int, p_max int,
  p_team text default null, p_name text default null, p_email text default null, p_url text default null,
  p_member text default null)
returns text language plpgsql security definer set search_path = public as $$
declare tok text; nm text := nullif(trim(coalesce(p_name,'')),''); em text := lower(nullif(trim(coalesce(p_email,'')),''));
        m members; days int := greatest(1, coalesce(p_days,14)); circ text; leads text;
begin
  /* Admin bjuder in alla roller. Producenter (crewet) bjuder in kunder och cirkeldeltagare
     de lagt till — kamerateamet bjuder inte in någon. */
  if not bs_is_admin() and not (bs_is_crew() and p_role::text in ('customer','participant') and p_member is not null) then
    raise exception 'Bara admin och manager kan bjuda in';
  end if;
  if p_role::text = 'manager' and not bs_is_manager() then raise exception 'Bara managern kan bjuda in en manager'; end if;
  if p_role::text in ('leader','participant') and p_circle is null then
    raise exception 'Välj vilken cirkel inbjudan gäller';
  end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-postadressen ser fel ut'; end if;
  if p_member is not null then
    select * into m from members where id = p_member for update;
    if m.id is null then raise exception 'Personen finns inte'; end if;
    if m.user_id is not null then raise exception '% har redan ett konto', m.name; end if;
    if m.role::text = 'manager' and not bs_is_manager() then raise exception 'Bara managern kan bjuda in en manager'; end if;
    if not bs_is_admin() and m.role::text not in ('customer','participant') then
      raise exception 'Du kan bara bjuda in kunder och cirkeldeltagare';
    end if;
    em := coalesce(em, lower(nullif(trim(coalesce(m.email,'')),'')));
    if em is null then raise exception 'Fyll i en e-postadress till %', m.name; end if;
    if exists (select 1 from members where lower(email) = em and id <> m.id and user_id is not null) then
      raise exception 'Den e-postadressen används redan av ett annat konto';
    end if;
    nm := m.name;
    perform set_config('bs.link', '1', true);          /* e-posten sätts även när en producent bjuder in */
    update members set email = em, up = now_ms() where id = m.id;
    perform set_config('bs.link', '', true);
    update invites set closed = true where member_id = m.id and not closed;
  end if;
  tok := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
               substr(md5(clock_timestamp()::text || random()::text), 1, 6));
  insert into invites(token, role, circle_id, created_by, expires_at, max_uses, team, name, email, member_id)
  values (tok, p_role, p_circle, bs_my_id(), now() + make_interval(days => days),
          case when nm is not null or p_member is not null then 1 else p_max end,
          coalesce(nullif(trim(coalesce(p_team,'')),''), m.team), nm, em, p_member);
  if em is not null and p_url is not null then
    select data->>'n' into circ from records where kind = 'circle' and id = p_circle;
    /* leder personen cirklar (t.ex. producent och cirkelledare) står det i mejlet */
    select string_agg(data->>'n', ', ' order by data->>'n') into leads from records
     where kind = 'circle' and not del and p_member is not null and data->>'leader' = nm;
    perform bs_notify(p_member, em, 'Du är inbjuden till BANDOHQ',
      'Hej' || coalesce(' ' || split_part(nm,' ',1), '') || '!' || E'\n\n'
      || 'Du är inbjuden till BANDOHQ som '
      || case when p_role::text = 'leader' then 'cirkelledare för ' || coalesce(leads, circ, 'en cirkel')
              else bs_role_sv(p_role::text) || coalesce(' och cirkelledare för ' || leads, '') || coalesce(' i ' || circ, '') end || '. '
      || 'Tryck på knappen, välj användarnamn och lösenord och skriv in koden du får på mejlen — sedan är du inne.'
      || E'\n\n' || 'Länken gäller i ' || days || ' dagar och bara för dig.',
      'invite', 'invite:' || tok, '0', p_url || '#join=' || tok);
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
    'role', inv.role, 'circle', cname, 'team', inv.team, 'name', inv.name, 'email', inv.email,
    'member', inv.member_id is not null,
    /* cirklarna en befintlig person leder — "producent och cirkelledare för …" */
    'leads', case when inv.member_id is null then '[]'::jsonb else coalesce((select jsonb_agg(data->>'n' order by data->>'n')
               from records where kind = 'circle' and not del and data->>'leader' = inv.name), '[]'::jsonb) end);
end $$;

/* Är användarnamnet ledigt? Visas medan man fyller i formuläret, så att man inte
   kör fast efter kodsteget. Användarnamn är inte hemliga — mejladresserna är det. */
create or replace function username_free(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(trim(coalesce(p_username,''))) ~ '^[a-z0-9._-]{2,24}$'
     and not exists (select 1 from members where lower(username) = lower(trim(p_username)))
$$;

/* Löser in en länk för den som just skapat sitt konto. Rollen och
   cirkelkopplingen kommer härifrån — aldrig från klienten. Gäller inbjudan en
   person som redan finns kopplas inloggningen till den raden (namnet, passen och
   färgen följer med); annars skapas ett nytt konto. */
drop function if exists redeem_invite(text, text, text);
create or replace function redeem_invite(p_token text, p_name text default null, p_username text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv invites; mid text; em text; nm text := trim(coalesce(p_name,'')); un text := lower(trim(coalesce(p_username,'')));
        m members;
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
  if un !~ '^[a-z0-9._-]{2,24}$' then
    raise exception 'Välj ett användarnamn: 2–24 tecken, a–z, 0–9, punkt, bindestreck eller understreck';
  end if;
  if exists (select 1 from members where lower(username) = un) then raise exception 'Användarnamnet är upptaget'; end if;
  select email into em from auth.users where id = auth.uid();

  if inv.member_id is not null then
    select * into m from members where id = inv.member_id for update;
    if m.id is null then raise exception 'Kontot finns inte längre — be om en ny länk'; end if;
    if m.user_id is not null then raise exception 'Kontot har redan en inloggning'; end if;
    perform set_config('bs.link', '1', true);
    update members set user_id = auth.uid(), email = em, role = inv.role, username = un,
           team = coalesce(inv.team, team), up = now_ms()
     where id = m.id;
    perform set_config('bs.link', '', true);
    mid := m.id; nm := m.name;
  else
    if length(nm) < 2 then raise exception 'Fyll i ditt namn'; end if;
    if exists (select 1 from members where lower(name) = lower(nm)) then
      raise exception 'Namnet finns redan — lägg till efternamnet';
    end if;
    mid := bs_uid('m_');
    insert into members (id, user_id, role, name, email, username, team, up)
    values (mid, auth.uid(), inv.role, nm, em, un, inv.team, now_ms());
  end if;

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
     where kind = 'circle' and id = inv.circle_id and not (coalesce(data->'members','[]'::jsonb) ? mid);
  elsif inv.circle_id is not null and inv.role = 'leader' then
    update records
       set data = data || jsonb_build_object('leader', nm, 'up', now_ms()), up = now_ms()
     where kind = 'circle' and id = inv.circle_id;
  end if;

  update invites set uses = uses + 1 where token = inv.token;
  return jsonb_build_object('id', mid, 'role', inv.role, 'name', nm, 'username', un);
end $$;

/* För edge-funktionen auth-login (bara service_role): användarnamn → e-post, och
   hur många fel det varit senaste kvarten. */
create or replace function bs_login_lookup(p_username text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', (select u.email from members m join auth.users u on u.id = m.user_id
               where lower(m.username) = lower(trim(coalesce(p_username,''))) and m.active limit 1),
    'fails', (select count(*) from login_fails
               where username = lower(trim(coalesce(p_username,''))) and at > now() - interval '15 minutes'))
$$;
create or replace function bs_login_fail(p_username text) returns void
language sql security definer set search_path = public as $$
  delete from login_fails where at < now() - interval '1 day';
  insert into login_fails(username) values (lower(trim(coalesce(p_username,''))));
$$;

-- =====================================================================
--  CIRKLARNA — regler, timbank och krockar
--  Siffrorna ligger i inställningen setting/circles, som admin ändrar i appen
--  (Cirklar → Regler). Saknas ett värde gäller standardvärdet här.
-- =====================================================================
create or replace function bs_ccfg(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select data->p_key from records where kind = 'setting' and id = 'circles' and not del and data ? p_key),
    jsonb_build_object('groupSize', 4, 'attendTarget', 3, 'startSessions', 3, 'sessionHours', 3,
      'leaderYearMax', 480, 'leaderMaxFrom', 2027, 'participantMax', 480,
      'warn', jsonb_build_array(400, 440, 470))->p_key)
$$;
/* 474 → "474", 2.5 → "2,5" */
create or replace function bs_fmt_h(n numeric) returns text
language sql immutable as $$ select replace(regexp_replace(to_char(n, 'FM99990.9'), '\.0?$', ''), '.', ',') $$;
/* Passets längd i timmar. */
create or replace function bs_len_h(d jsonb) returns numeric
language sql immutable as $$ select (extract(epoch from upper(bs_span(d)) - lower(bs_span(d))) / 3600)::numeric $$;

/* Ledarens timmar ett kalenderår: genomförda pass med sina registrerade timmar,
   bokade pass med passets längd. Förfrågningar och avböjda räknas inte. */
create or replace function bs_leader_hours(p_leader text, p_year int, p_ignore text default null)
returns table(done numeric, planned numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when data->>'status' = 'done' then coalesce((data->>'hours')::numeric, 0) end), 0),
         coalesce(sum(case when coalesce(data->>'status','') = '' then bs_len_h(data) end), 0)
    from records
   where kind = 'booking' and not del and coalesce(data->>'circleId','') <> ''
     and data->>'leaderId' = p_leader and id <> coalesce(p_ignore, '')
     and coalesce(data->>'status','') in ('', 'done')
     and left(data->>'date', 4) = p_year::text
$$;

/* Krockar ett cirkelpass för ledaren eller någon av deltagarna? Svarar med en
   förklaring, eller null. (Studion kollas för sig med bs_clash.) */
create or replace function bs_circle_conflict(d jsonb, p_ignore text) returns text
language plpgsql stable security definer set search_path = public as $$
declare sp tsrange := bs_span(d); lid text := nullif(d->>'leaderId',''); lname text; mem jsonb; hit record;
begin
  select coalesce(data->'members','[]'::jsonb), nullif(data->>'leader','') into mem, lname
    from records where kind = 'circle' and id = d->>'circleId';
  /* ledaren: ett annat cirkelpass hen leder, eller ett studiopass där hen bokat eller är med */
  select r.data->>'title' t, r.data->>'start' s, r.data->>'end' e into hit
    from records r
   where r.kind = 'booking' and not r.del and r.id <> coalesce(p_ignore,'')
     and coalesce(r.data->>'status','') not in ('request','declined')
     and bs_span(r.data) && sp
     and ((lid is not null and r.data->>'leaderId' = lid)
       or (lname is not null and coalesce(r.data->>'circleId','') = ''
           and (r.data->>'who' = lname or coalesce(r.data->'with','[]'::jsonb) ? lname)))
   limit 1;
  if found then
    return coalesce(lname, 'Ledaren') || ' har redan ' || coalesce(nullif(hit.t,''), 'ett pass') || ' ' || hit.s || '–' || hit.e;
  end if;
  /* deltagarna: ett annat cirkelpass samtidigt där någon av gruppens deltagare är med */
  select r.data->>'title' t, r.data->>'start' s, r.data->>'end' e, m.name n into hit
    from records r
    join records c on c.kind = 'circle' and c.id = r.data->>'circleId' and not c.del
    cross join lateral jsonb_array_elements_text(coalesce(c.data->'members','[]'::jsonb)) x(mid)
    join members m on m.id = x.mid
   where r.kind = 'booking' and not r.del and r.id <> coalesce(p_ignore,'')
     and r.data->>'circleId' <> coalesce(d->>'circleId','')
     and coalesce(r.data->>'status','') not in ('request','declined')
     and bs_span(r.data) && sp
     and mem ? x.mid
   limit 1;
  if found then
    return hit.n || ' är med i ' || coalesce(nullif(hit.t,''), 'en annan cirkel') || ' ' || hit.s || '–' || hit.e;
  end if;
  return null;
end $$;

/* Allt som måste stämma innan ett cirkelpass bokas eller flyttas: passlängden, krockar
   och ledarens timbank (från leaderMaxFrom, t.ex. 2027). p_extra = timmar som planeras
   i samma omgång (återkommande pass). Kastar ett fel med förklaringen. */
create or replace function bs_check_circle_session(d jsonb, p_ignore text, p_extra numeric default 0) returns void
language plpgsql security definer set search_path = public as $$
declare hrs numeric := bs_len_h(d); want numeric := (bs_ccfg('sessionHours'))::text::numeric;
        yr int := left(d->>'date', 4)::int; mx numeric := (bs_ccfg('leaderYearMax'))::text::numeric;
        y0 int := (bs_ccfg('leaderMaxFrom'))::text::int; u record; msg text;
begin
  if want > 0 and hrs <> want then raise exception 'Ett cirkelpass är % timmar', bs_fmt_h(want); end if;
  msg := bs_circle_conflict(d, p_ignore);
  if msg is not null then raise exception 'Krock: %', msg; end if;
  if nullif(d->>'leaderId','') is not null and mx > 0 and yr >= y0 then
    select * into u from bs_leader_hours(d->>'leaderId', yr, p_ignore);
    if u.done + u.planned + coalesce(p_extra,0) + hrs > mx then
      raise exception '% har % av % timmar % — passet skulle gå över gränsen',
        coalesce((select name from members where id = d->>'leaderId'), 'Ledaren'),
        bs_fmt_h(u.done + u.planned + coalesce(p_extra,0)), bs_fmt_h(mx), yr;
    end if;
  end if;
end $$;

/* Cirkelpass får ledarens id — stabil nyckel för timbanken (namnet kan bytas). */
create or replace function bs_circle_booking_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.data->>'circleId','') <> '' and coalesce(new.data->>'leaderId','') = '' then
    new.data := new.data || jsonb_build_object('leaderId',
      (select m.id from records c join members m on lower(m.name) = lower(c.data->>'leader')
        where c.kind = 'circle' and c.id = new.data->>'circleId' and coalesce(c.data->>'leader','') <> '' limit 1));
  end if;
  return new;
end $$;
drop trigger if exists records_circle_fill on records;
create trigger records_circle_fill before insert or update on records
  for each row when (new.kind = 'booking') execute function bs_circle_booking_fill();

/* Cirkeln ändras: medlemshistoriken skrivs (vem kom med, vem lämnade), och byts
   ledaren följer kommande pass med till den nya. */
create or replace function bs_circle_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare oldm jsonb := case when tg_op = 'UPDATE' and not old.del then coalesce(old.data->'members','[]'::jsonb) else '[]'::jsonb end;
        newm jsonb := case when new.del then '[]'::jsonb else coalesce(new.data->'members','[]'::jsonb) end;
        x text; lid text; t bigint := now_ms();
begin
  for x in select jsonb_array_elements_text(newm) except select jsonb_array_elements_text(oldm) loop
    insert into circle_membership(circle_id, member_id) values (new.id, x);
  end loop;
  for x in select jsonb_array_elements_text(oldm) except select jsonb_array_elements_text(newm) loop
    update circle_membership set left_at = now() where circle_id = new.id and member_id = x and left_at is null;
  end loop;
  if tg_op = 'UPDATE' and coalesce(old.data->>'leader','') is distinct from coalesce(new.data->>'leader','') then
    lid := (select id from members where lower(name) = lower(new.data->>'leader') limit 1);
    update records set data = data || jsonb_build_object('leaderId', lid, 'who', coalesce(new.data->>'leader',''), 'up', t), up = t
     where kind = 'booking' and not del and data->>'circleId' = new.id
       and coalesce(data->>'status','') in ('', 'request') and data->>'date' >= to_char(current_date, 'YYYY-MM-DD');
  end if;
  return new;
end $$;
drop trigger if exists records_circle_changed on records;
create trigger records_circle_changed after insert or update on records
  for each row when (new.kind = 'circle') execute function bs_circle_changed();

/* En gång: befintliga cirkelpass får ledar-id, och nuvarande medlemmar en startrad i historiken. */
do $$ begin
  update records set data = data where kind = 'booking' and coalesce(data->>'circleId','') <> '' and coalesce(data->>'leaderId','') = '';
  insert into circle_membership(circle_id, member_id)
  select c.id, x from records c cross join lateral jsonb_array_elements_text(coalesce(c.data->'members','[]'::jsonb)) x
   where c.kind = 'circle' and not c.del
     and not exists (select 1 from circle_membership cm where cm.circle_id = c.id and cm.member_id = x);
end $$;

-- =====================================================================
--  CIRKLARNA — kontroll, låsning, historik och rapportering
--  Planerat ('') och Genomfört ('done') står på passet; Kontrollerat och Rapporterat i
--  session_reports, som bara admin skriver i (via funktionerna nedan).
-- =====================================================================
/* Ett kontrollerat eller rapporterat pass är låst. Ingen ändring går igenom — inte ens via
   synken (den hoppas tyst över) — förrän admin låser upp det med unlock_session. */
create or replace function bs_guard_reported() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('bs.unlock', true) = '1' then return new; end if;
  if new.data is not distinct from old.data and new.del = old.del then return new; end if;
  if exists (select 1 from session_reports where booking_id = old.id) then return null; end if;
  return new;
end $$;
drop trigger if exists records_guard_reported on records;
create trigger records_guard_reported before update on records
  for each row when (old.kind = 'booking') execute function bs_guard_reported();

/* Historik: varje ändring av ett cirkelpass eller en cirkel — före, efter, vem och när. */
create or replace function bs_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare circ boolean;
begin
  circ := new.kind = 'circle' or (new.kind = 'booking' and (coalesce(new.data->>'circleId','') <> ''
          or (tg_op = 'UPDATE' and coalesce(old.data->>'circleId','') <> '')));
  if not circ then return new; end if;
  if tg_op = 'UPDATE' and new.data is not distinct from old.data and new.del = old.del then return new; end if;
  insert into record_history(kind, rec_id, op, before, after, by_id)
  values (new.kind, new.id,
          case when tg_op = 'INSERT' then 'skapad' when new.del and not old.del then 'borttagen' else 'ändrad' end,
          case when tg_op = 'UPDATE' then old.data end, new.data, bs_my_id());
  return new;
end $$;
drop trigger if exists records_history on records;
create trigger records_history after insert or update on records for each row execute function bs_history();

/* Ett pass är låst om det står i session_reports. */
create or replace function bs_locked(p_booking text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from session_reports where booking_id = p_booking)
$$;

/* Admin godkänner genomförda pass. Bara pass utan fel går igenom — de andra kommer
   tillbaka med anledningen. (Appens veckovy visar samma regler, och fler varningar.) */
create or replace function check_sessions(p_ids jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bid text; d jsonb; c jsonb; why text; k text; good jsonb := '[]'; bad jsonb := '[]';
        want numeric := (bs_ccfg('sessionHours'))::text::numeric;
begin
  if not bs_is_admin() then raise exception 'Bara admin kontrollerar pass'; end if;
  for bid in select jsonb_array_elements_text(coalesce(p_ids,'[]'::jsonb)) loop
    select data into d from records where kind = 'booking' and id = bid and not del;
    why := null;
    if d is null or coalesce(d->>'circleId','') = '' then why := 'Passet finns inte';
    elsif bs_locked(bid) then why := 'Redan kontrollerat';
    elsif coalesce(d->>'status','') <> 'done' then why := 'Närvaron är inte registrerad';
    elsif bs_starts(d) > now() then why := 'Passet har inte varit än';
    elsif coalesce((d->>'hours')::numeric, 0) <> want then
      why := 'Timmarna stämmer inte (' || bs_fmt_h(coalesce((d->>'hours')::numeric, 0)) || ' i stället för ' || bs_fmt_h(want) || ')';
    elsif jsonb_array_length(coalesce(d->'present','[]'::jsonb)) = 0 then why := 'Ingen närvarande registrerad';
    else
      select data into c from records where kind = 'circle' and id = d->>'circleId';
      if exists (select 1 from jsonb_array_elements_text(d->'present') p(x)
                  where not (coalesce(c->'members','[]'::jsonb) ? p.x)
                    and not exists (select 1 from circle_membership m where m.circle_id = d->>'circleId' and m.member_id = p.x)) then
        why := 'Någon av de närvarande är inte med i gruppen';
      else
        k := bs_circle_conflict(d, bid);
        if k is not null then why := 'Krock: ' || k; end if;
      end if;
    end if;
    if why is null then
      insert into session_reports(booking_id, status, checked_by, checked_at) values (bid, 'checked', bs_my_id(), now());
      insert into record_history(kind, rec_id, op, by_id) values ('booking', bid, 'kontrollerat', bs_my_id());
      good := good || to_jsonb(bid);
    else
      bad := bad || jsonb_build_object('id', bid, 'reason', why);
    end if;
  end loop;
  return jsonb_build_object('checked', good, 'skipped', bad);
end $$;

/* Ögonblicksbilden som rapporteras: tid, timmar, grupp, ämne, lektion, ledare och de
   närvarande med kontaktuppgifter (personnummer finns inte här — de läggs till i arket). */
create or replace function bs_snapshot(p_booking text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'date', r.data->>'date', 'start', r.data->>'start', 'end', r.data->>'end',
    'hours', (r.data->>'hours')::numeric, 'studio', r.data->>'studio',
    'circle', c.data->>'n', 'subject', c.data->>'subject', 'lesson', r.data->>'lessonTitle',
    'leader', (select name from members where id = r.data->>'leaderId'),
    'present', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'phone', m.phone) order by m.name)
                           from members m where r.data->'present' ? m.id), '[]'::jsonb))
    from records r left join records c on c.kind = 'circle' and c.id = r.data->>'circleId'
   where r.kind = 'booking' and r.id = p_booking
$$;

/* Rapportera kontrollerade pass: ögonblicksbilden sparas och skickas tillbaka (till exporten). */
create or replace function report_sessions(p_ids jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bid text; snap jsonb; out jsonb := '[]';
begin
  if not bs_is_admin() then raise exception 'Bara admin rapporterar'; end if;
  for bid in select jsonb_array_elements_text(coalesce(p_ids,'[]'::jsonb)) loop
    if not exists (select 1 from session_reports where booking_id = bid and status = 'checked') then continue; end if;
    snap := bs_snapshot(bid);
    update session_reports set status = 'reported', reported_by = bs_my_id(), reported_at = now(), snapshot = snap where booking_id = bid;
    insert into record_history(kind, rec_id, op, by_id) values ('booking', bid, 'rapporterat', bs_my_id());
    out := out || snap;
  end loop;
  return out;
end $$;

/* Allt som rapporterats under en period — för att ta ut underlaget igen. */
create or replace function report_snapshots(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not bs_is_admin() then '[]'::jsonb else coalesce(jsonb_agg(snapshot || jsonb_build_object('reportedAt', reported_at)
           order by snapshot->>'date', snapshot->>'start'), '[]'::jsonb) end
    from session_reports
   where status = 'reported' and (snapshot->>'date')::date between p_from and p_to
$$;

/* Lås upp ett kontrollerat eller rapporterat pass — med en anledning som sparas i historiken. */
create or replace function unlock_session(p_booking text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin låser upp pass'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Skriv varför passet låses upp'; end if;
  delete from session_reports where booking_id = p_booking;
  if not found then raise exception 'Passet är inte låst'; end if;
  insert into record_history(kind, rec_id, op, by_id, note) values ('booking', p_booking, 'upplåst', bs_my_id(), left(trim(p_reason), 300));
end $$;

-- =====================================================================
--  LEDARE, DELTAGARE, KUND — det enda de når
-- =====================================================================
/* Admin, eller cirkelns ledare. (Producenter leder bara de cirklar de är ledare för.) */
create or replace function bs_leads(p_circle text) returns boolean
language sql stable security definer set search_path = public as $$
  select bs_is_admin() or exists (
    select 1 from records where kind = 'circle' and id = p_circle and not del
       and coalesce(data->>'leader','') <> '' and data->>'leader' = (bs_me()).name)
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
      /* den kunden hör av sig till om det är mindre än en timme kvar */
      'contact', (select jsonb_build_object('name', name, 'email', email, 'phone', phone)
                    from members where id = me.producer and active),
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
    /* kontrollstatus på ledarens pass (Kontrollerat / Rapporterat) */
    res := res || jsonb_build_object('reports', coalesce((select jsonb_object_agg(sr.booking_id, sr.status)
      from session_reports sr join records r on r.kind = 'booking' and r.id = sr.booking_id
     where r.data->>'circleId' = any(cids)), '{}'::jsonb));
    /* timbanken: i år och nästa år, och reglerna appen visar dem mot */
    res := res || jsonb_build_object('circleCfg', coalesce((select data from records where kind = 'setting' and id = 'circles' and not del), '{}'::jsonb),
      'leaderHours', (select jsonb_object_agg(y::text, jsonb_build_object('done', h.done, 'planned', h.planned))
         from generate_series(extract(year from now())::int, extract(year from now())::int + 1) y
         cross join lateral bs_leader_hours(me.id, y, null) h));
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
    /* deltagaren ser ledarens kontaktuppgifter (för avbokning med kort varsel) */
    res := res || jsonb_build_object('people', coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'name',m.name,'role',m.role,'color',m.color,'email',m.email,'phone',m.phone))
      from members m where m.active and m.name in (
        select data->>'leader' from records where kind='circle' and id = any(cids))), '[]'));
    /* och när studion är upptagen — utan namn eller titel på andras pass */
    res := res || jsonb_build_object('busy', coalesce((select jsonb_agg(jsonb_build_object('id',id,
        'studio',data->>'studio','date',data->>'date','start',data->>'start','end',data->>'end')) from records
       where kind='booking' and not del and coalesce(data->>'status','') not in ('request','declined')
         and coalesce(data->>'circleId','') <> all(cids)), '[]'));
  end if;
  return res;
end $$;

create or replace function request_session(p_circle text, p_date date, p_start text, p_end text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); c jsonb; d jsonb;
begin
  select data into c from records where kind='circle' and id = p_circle and not del;
  if c is null then raise exception 'Cirkeln finns inte'; end if;
  if me.role <> 'participant' or not (c->'members' ? me.id) then
    raise exception 'Du är inte med i den cirkeln';
  end if;
  d := jsonb_build_object('id', bs_uid('b'), 'studio','', 'date', p_date::text,
    'start', p_start, 'end', p_end, 'who', c->>'leader', 'title', c->>'n', 'note','',
    'circleId', p_circle, 'status','request', 'reqBy', me.id, 'hours', null,
    'present','[]'::jsonb, 'paid', false, 'with','[]'::jsonb, 'artistId','');
  if not bs_three_hours(d) then raise exception 'Ett pass är tre timmar'; end if;
  if bs_starts(d) < now() then raise exception 'Välj en tid framåt i tiden'; end if;
  if not bs_any_free(bs_span(d), null) then raise exception 'Den tiden är fullbokad'; end if;
  return bs_put_booking(d);
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
    'hours', null, 'present','[]'::jsonb, 'paid', false, 'with','[]'::jsonb, 'artistId','',
    'leaderId', (select id from members where lower(name) = lower(c->>'leader') limit 1));
  if bs_clash(p_studio, bs_span(d), null) then raise exception 'Studion är upptagen den tiden'; end if;
  perform bs_check_circle_session(d, null);
  return bs_put_booking(d);
end $$;

create or replace function answer_request(p_booking text, p_approve boolean, p_studio text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null or d->>'status' <> 'request' then raise exception 'Förfrågan finns inte längre'; end if;
  /* cirkelförfrågan: ledaren (eller admin). Kundförfrågan: admin eller kundens producent. */
  if coalesce(d->>'circleId','') <> '' then
    if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan svara'; end if;
  elsif not (bs_is_admin() or exists (select 1 from members where id = d->>'reqBy' and producer = bs_my_id())) then
    raise exception 'Bara admin och kundens producent kan svara';
  end if;
  if not p_approve then return bs_put_booking(d || '{"status":"declined"}'); end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  /* kollas här, inte bara i appen — någon kan ha bokat tiden under tiden */
  if bs_clash(p_studio, bs_span(d), p_booking) then raise exception 'Studion hann bli upptagen'; end if;
  if coalesce(d->>'circleId','') <> '' then perform bs_check_circle_session(d || jsonb_build_object('studio', p_studio), p_booking); end if;
  return bs_put_booking(d || jsonb_build_object('studio', p_studio, 'status', ''));
end $$;

create or replace function complete_session(p_booking text, p_hours numeric, p_present jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; c jsonb; bad int;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null or coalesce(d->>'circleId','') = '' then raise exception 'Passet finns inte'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan markera genomförd'; end if;
  if bs_locked(p_booking) then raise exception 'Passet är kontrollerat — admin måste låsa upp det först'; end if;
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

/* Flytta ett bokat cirkelpass (ledaren eller admin). Passet behåller sin längd från
   reglerna — bara dag, starttid och studio väljs. */
create or replace function update_circle_session(p_booking text, p_date date, p_start text, p_studio text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; n jsonb; want numeric := (bs_ccfg('sessionHours'))::text::numeric;
begin
  select data into d from records where kind = 'booking' and id = p_booking and not del;
  if d is null or coalesce(d->>'circleId','') = '' then raise exception 'Passet finns inte'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan flytta passet'; end if;
  if bs_locked(p_booking) then raise exception 'Passet är kontrollerat — admin måste låsa upp det först'; end if;
  if d->>'status' = 'done' then raise exception 'Passet är redan genomfört — ångra det först'; end if;
  if coalesce(d->>'status','') in ('request','declined') then raise exception 'Passet är inte bokat'; end if;
  if p_studio not in ('A','B') then raise exception 'Välj studio'; end if;
  if p_start !~ '^\d\d:\d\d$' then raise exception 'Välj en starttid'; end if;
  n := d || jsonb_build_object('date', p_date::text, 'start', p_start, 'studio', p_studio,
    'end', to_char(p_start::time + make_interval(mins => (want * 60)::int), 'HH24:MI'));
  if bs_clash(p_studio, bs_span(n), p_booking) then raise exception 'Studion är upptagen den tiden'; end if;
  perform bs_check_circle_session(n, p_booking);
  return bs_put_booking(n);
end $$;

/* Ställa in ett bokat cirkelpass (ledaren eller admin). Genomförda pass ligger kvar —
   de är underlag för timmarna. */
create or replace function cancel_circle_session(p_booking text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select data into d from records where kind = 'booking' and id = p_booking and not del;
  if d is null or coalesce(d->>'circleId','') = '' then raise exception 'Passet finns inte'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan ställa in passet'; end if;
  if bs_locked(p_booking) then raise exception 'Passet är kontrollerat — admin måste låsa upp det först'; end if;
  if d->>'status' = 'done' then raise exception 'Passet är genomfört — ångra det först om det inte blev av'; end if;
  return bs_put_booking(d || '{"del":true}');
end $$;

/* Förhandsvisning innan återkommande pass bokas: för varje datum, går det — och om inte,
   varför. Timbanken räknar in de pass som går tidigare i samma omgång. */
create or replace function circle_plan_check(p_circle text, p_dates jsonb, p_start text, p_studio text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; d jsonb; dt text; out jsonb := '[]'; extra jsonb := '{}'; yr text; hrs numeric;
        want numeric := (bs_ccfg('sessionHours'))::text::numeric; lid text;
begin
  if not bs_leads(p_circle) then raise exception 'Bara cirkelns ledare kan planera'; end if;
  select data into c from records where kind = 'circle' and id = p_circle and not del;
  lid := (select id from members where lower(name) = lower(c->>'leader') limit 1);
  for dt in select jsonb_array_elements_text(p_dates) loop
    d := jsonb_build_object('date', dt, 'start', p_start, 'circleId', p_circle, 'leaderId', lid,
      'end', to_char(p_start::time + make_interval(mins => (want * 60)::int), 'HH24:MI'));
    yr := left(dt, 4); hrs := bs_len_h(d);
    begin
      if p_studio in ('A','B') then
        if bs_clash(p_studio, bs_span(d), null) then raise exception 'Studion är upptagen'; end if;
      elsif not bs_any_free(bs_span(d), null) then raise exception 'Båda studiorna är upptagna';
      end if;
      perform bs_check_circle_session(d, null, coalesce((extra->>yr)::numeric, 0));
      extra := extra || jsonb_build_object(yr, coalesce((extra->>yr)::numeric, 0) + hrs);
      out := out || jsonb_build_object('date', dt, 'ok', true);
    exception when others then
      out := out || jsonb_build_object('date', dt, 'ok', false, 'reason', sqlerrm);
    end;
  end loop;
  return out;
end $$;

/* Finns personen redan? Samma e-post, samma telefonnummer eller samma namn. */
create or replace function find_duplicates(p_name text, p_email text, p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not bs_is_crew() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'role', m.role,
      'why', case when nullif(lower(trim(p_email)),'') = lower(m.email) then 'samma e-post'
                  when bs_phone(p_phone) is not null and bs_phone(p_phone) = bs_phone(m.phone) then 'samma telefonnummer'
                  else 'samma namn' end) order by m.name), '[]'::jsonb) end
    from members m
   where m.active and (
         (nullif(lower(trim(p_email)),'') is not null and lower(m.email) = lower(trim(p_email)))
      or (bs_phone(p_phone) is not null and bs_phone(m.phone) = bs_phone(p_phone))
      or (length(trim(coalesce(p_name,''))) >= 2
          and lower(regexp_replace(trim(m.name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_name), '\s+', ' ', 'g'))))
$$;

/* Lägg en deltagare i en cirkel — admin, eller ledaren för just den cirkeln. */
create or replace function add_circle_member(p_circle text, p_member text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; t bigint := now_ms();
begin
  if not bs_leads(p_circle) then raise exception 'Bara admin eller cirkelns ledare kan lägga till deltagare'; end if;
  if not exists (select 1 from members where id = p_member and role::text = 'participant') then
    raise exception 'Personen är inte cirkeldeltagare';
  end if;
  select data into c from records where kind = 'circle' and id = p_circle and not del;
  if c is null then raise exception 'Cirkeln finns inte'; end if;
  if coalesce(c->'members','[]'::jsonb) ? p_member then return c; end if;
  c := jsonb_set(c, '{members}', coalesce(c->'members','[]'::jsonb) || to_jsonb(p_member)) || jsonb_build_object('up', t);
  update records set data = c, up = t where kind = 'circle' and id = p_circle;
  return c;
end $$;

/* Anmälan från foundation-sajten (Vercel-funktionen skickar med en hemlig nyckel).
   Inget personnummer — det stannar i kalkylarket. */
create or replace function circle_signup(p_secret text, p_name text, p_email text, p_phone text,
  p_subject text default '', p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare want text := (select value from bs_secrets where name = 'signup'); nm text := trim(coalesce(p_name,''));
        em text := nullif(lower(trim(coalesce(p_email,''))),''); ph text := bs_phone(nullif(trim(coalesce(p_phone,'')),''));
        ex text; id text;
begin
  if want is null or coalesce(p_secret,'') <> want then raise exception 'Obehörig'; end if;
  if length(nm) < 2 then raise exception 'Fyll i namn'; end if;
  if em is null and ph is null then raise exception 'Fyll i telefonnummer eller e-post'; end if;
  if (select count(*) from circle_signups where created_at > now() - interval '1 day') >= 200 then
    raise exception 'Många anmälningar just nu — försök igen imorgon';
  end if;
  /* samma person som redan väntar: ingen ny rad */
  select s.id into ex from circle_signups s where s.status = 'new'
     and ((em is not null and lower(s.email) = em) or (ph is not null and s.phone = ph)) limit 1;
  if ex is not null then return jsonb_build_object('ok', true, 'id', ex, 'again', true); end if;
  id := bs_uid('s_');
  insert into circle_signups(id, name, email, phone, subject, note)
  values (id, left(nm, 60), left(em, 120), ph, left(nullif(trim(coalesce(p_subject,'')),''), 40), left(coalesce(p_note,''), 300));
  return jsonb_build_object('ok', true, 'id', id);
end $$;

/* Admin placerar en anmälan: en ny deltagare (eller en som redan finns, p_member) läggs
   in och, om en cirkel väljs, i den. */
create or replace function place_signup(p_signup text, p_circle text default null, p_member text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sg circle_signups; mid text := p_member;
begin
  if not bs_is_admin() then raise exception 'Bara admin placerar anmälningar'; end if;
  select * into sg from circle_signups where id = p_signup for update;
  if sg.id is null or sg.status <> 'new' then raise exception 'Anmälan finns inte längre'; end if;
  if mid is null then
    if exists (select 1 from members where lower(name) = lower(sg.name)) then
      raise exception 'Det finns redan en person som heter % — koppla anmälan till den i stället', sg.name;
    end if;
    mid := bs_uid('m_');
    insert into members(id, role, name, email, phone, up) values (mid, 'participant', sg.name, sg.email, sg.phone, now_ms());
  elsif not exists (select 1 from members where id = mid and role::text = 'participant') then
    raise exception 'Personen är inte cirkeldeltagare';
  end if;
  if p_circle is not null then perform add_circle_member(p_circle, mid); end if;
  update circle_signups set status = 'placed', member_id = mid, circle_id = p_circle, handled_by = bs_my_id() where id = sg.id;
  return jsonb_build_object('member', mid, 'circle', p_circle);
end $$;
create or replace function reject_signup(p_signup text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar anmälningar'; end if;
  update circle_signups set status = 'rejected', handled_by = bs_my_id() where id = p_signup and status = 'new';
  if not found then raise exception 'Anmälan finns inte längre'; end if;
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
create or replace function request_customer_slot(p_date date, p_start text, p_end text, p_studio text default '', p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); d jsonb;
begin
  if me.role is distinct from 'customer' then raise exception 'Bara kunder skickar förfrågningar här'; end if;
  if p_date < current_date then raise exception 'Välj en dag framåt i tiden'; end if;
  if (select count(*) from records where kind='booking' and not del and data->>'status'='request'
        and data->>'reqBy' = me.id) >= 5 then
    raise exception 'Du har redan fem obesvarade förfrågningar';
  end if;
  /* Kunden väljer ingen studio — crewet väljer när förfrågan godkänns. */
  d := jsonb_build_object('id', bs_uid('b'), 'studio', '', 'date', p_date::text, 'start', p_start,
    'end', p_end, 'who', me.name, 'title','Studiotid', 'note', left(coalesce(p_note,''),200), 'circleId','',
    'status','request', 'reqBy', me.id, 'hours', null, 'present','[]'::jsonb, 'paid', true,
    'with','[]'::jsonb, 'artistId','');
  if not bs_three_hours(d) then raise exception 'Ett pass är tre timmar'; end if;
  if bs_starts(d) < now() then raise exception 'Välj en tid framåt i tiden'; end if;
  if not bs_any_free(bs_span(d), null) then raise exception 'Den tiden är fullbokad'; end if;
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
declare ph text := bs_phone(nullif(trim(coalesce(p_phone,'')),'')); id text; nm text := trim(coalesce(p_name,''));
        em text := lower(trim(coalesce(p_email,'')));
begin
  if coalesce(p_hp,'') <> '' then return jsonb_build_object('ok', true); end if;      -- robot: säg ok, gör inget
  if length(nm) < 2 then raise exception 'Fyll i ditt namn'; end if;
  if nullif(trim(coalesce(p_phone,'')),'') is not null and ph is null then raise exception 'Telefonnumret ser fel ut'; end if;
  if em <> '' and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-postadressen ser fel ut'; end if;
  if em = '' and ph is null then raise exception 'Fyll i telefonnummer eller e-post'; end if;
  if p_date < current_date or p_date > current_date + 120 then raise exception 'Välj en dag inom de närmaste fyra månaderna'; end if;
  if p_start !~ '^\d\d:\d\d$' or p_end !~ '^\d\d:\d\d$' or p_start = p_end then raise exception 'Välj start och slut'; end if;
  if upper(bs_span(jsonb_build_object('date', p_date::text, 'start', p_start, 'end', p_end)))
     - lower(bs_span(jsonb_build_object('date', p_date::text, 'start', p_start, 'end', p_end))) <> interval '3 hours' then
    raise exception 'Ett pass är tre timmar';
  end if;
  if (select count(*) from leads where status = 'new' and ((em <> '' and lower(email) = em) or (ph is not null and phone = ph))) >= 3 then
    raise exception 'Du har redan tre förfrågningar som väntar på svar';
  end if;
  if (select count(*) from leads where created_at > now() - interval '1 day') >= 30 then
    raise exception 'Många förfrågningar just nu — försök igen imorgon';
  end if;
  id := bs_uid('l_');
  insert into leads(id, name, email, phone, date, start_t, end_t, studio, message)
  values (id, left(nm,60), nullif(left(em,120),''), ph, p_date, p_start, p_end, null, left(coalesce(p_message,''),300));
  return jsonb_build_object('ok', true);
end $$;

/* Admin godkänner: bokningen skapas, och kunden får ett mejl med tiden och en
   länk för att skapa sitt konto. När kunden gått med blir bokningen hens
   (redeem_invite, lead_id). */
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
  insert into invites(token, role, created_by, expires_at, max_uses, name, email, lead_id)
  values (tok, 'customer', bs_my_id(), now() + interval '30 days', 1, l.name, l.email, l.id);
  update leads set status = 'approved', booking_id = d->>'id', invite = tok, handled_by = bs_my_id() where id = l.id;
  perform bs_notify(null, l.email, 'Bokningsbekräftelse: ' || bs_when(d),
    'Hej ' || split_part(l.name,' ',1) || '! Din tid är bokad:' || E'\n\n'
    || bs_when(d) || ' · ' || bs_studio(p_studio) || E'\n\n'
    || 'Skapa ditt konto med knappen nedan för att se och ändra bokningen. Länken gäller i 30 dagar.',
    'lead-ok', 'lead-ok:' || l.id, '0', p_url || '#join=' || tok);
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
  perform bs_notify(null, l.email, 'Tiden gick tyvärr inte',
    'Hej ' || split_part(l.name,' ',1) || '! Tyvärr kan vi inte ta tiden ' || bs_day(l.date) || ' '
    || l.start_t || '-' || l.end_t || '.' || case when coalesce(p_reason,'') <> '' then ' ' || p_reason else ' Hör av dig för en annan tid!' end,
    'lead-no', 'lead-no:' || l.id);
end $$;

/* Kund avbokar sin bokning, deltagare tar tillbaka sin förfrågan. */
/* Kunden avbokar sin tid, deltagaren sin förfrågan eller sitt godkända pass.
   Förfrågningar går alltid att ta tillbaka; ett bokat pass senast en timme innan —
   sedan får man höra av sig till sin producent (kund) eller cirkelledare (deltagare). */
create or replace function cancel_my_booking(p_booking text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); d jsonb; who text;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null then raise exception 'Bokningen finns inte'; end if;
  /* coalesce: ett pass utan reqBy/who ger annars null, och då skulle spärren hoppas över */
  if not coalesce((me.role = 'customer' and coalesce(d->>'who','') = me.name)
       or (me.role = 'participant' and coalesce(d->>'reqBy','') = me.id and coalesce(d->>'status','') in ('request','')), false) then
    raise exception 'Det är inte din bokning';
  end if;
  if coalesce(d->>'status','') = 'done' then raise exception 'Passet är redan genomfört'; end if;
  if coalesce(d->>'status','') = '' and bs_starts(d) < now() + interval '1 hour' then
    who := case when me.role = 'customer' then (select name from members where id = me.producer and active)
                else d->>'who' end;
    raise exception 'Det är mindre än en timme kvar — hör av dig till %', coalesce(who, 'din producent');
  end if;
  return bs_put_booking(d || '{"del":true}');
end $$;

-- =====================================================================
--  RADERA EN PERSON (managern, på begäran — GDPR)
--  Kontot och inloggningen försvinner. Namnet ersätts med "Raderad person"
--  i gamla pass, men passen och cirkeltimmarna ligger kvar: de behövs för
--  rapporteringen och för de andra som var med.
-- =====================================================================
/* Själva raderingen — samma för managern (delete_member) och för den som raderar sig själv
   (delete_my_account). Intern: bara de två funktionerna anropar den. */
create or replace function bs_erase_member(m members) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t bigint := now_ms(); n int := 0; gone text := 'Raderad person';
begin
  perform set_config('bs.unlock', '1', true);     -- även låsta pass: namnet ska bort
  /* pass: bokare och medproducent */
  update records set data = data || jsonb_build_object('who', gone, 'up', t), up = t
   where kind = 'booking' and data->>'who' = m.name;
  get diagnostics n = row_count;
  update records set data = jsonb_set(data, '{with}', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(data->'with') x
           where x <> m.name), '[]'::jsonb)) || jsonb_build_object('up', t), up = t
   where kind = 'booking' and data->'with' ? m.name;
  /* cirklar: ledare och medlemskap */
  update records set data = data || jsonb_build_object('leader', '', 'up', t), up = t
   where kind = 'circle' and data->>'leader' = m.name;
  update records set data = jsonb_set(data, '{members}', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(data->'members') x
           where x <> m.id), '[]'::jsonb)) || jsonb_build_object('up', t), up = t
   where kind = 'circle' and data->'members' ? m.id;
  /* personligt: agenda, mål och plan tas bort; beats och galleri behåller filerna men inte namnet */
  update records set del = true, up = t, data = data || jsonb_build_object('del', true, 'up', t)
   where (kind = 'agenda' and data->>'who' = m.name) or (kind = 'goal' and data->>'owner' = m.id) or (kind = 'plan' and id = m.id);
  update records set data = data || jsonb_build_object('who', gone, 'up', t), up = t where kind = 'beat' and data->>'who' = m.name;
  update records set data = data || jsonb_build_object('by', '', 'up', t), up = t where kind = 'media' and data->>'by' = m.id;
  delete from outbox where member_id = m.id and sent_at is null;
  delete from members where id = m.id;                       -- push_subs följer med (on delete cascade)
  if m.user_id is not null then delete from auth.users where id = m.user_id; end if;
  return jsonb_build_object('deleted', m.name, 'bookings', n);
end $$;

create or replace function delete_member(p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m members;
begin
  if not bs_is_manager() then raise exception 'Bara managern kan radera konton'; end if;
  select * into m from members where id = p_id;
  if m.id is null then raise exception 'Kontot finns inte'; end if;
  if m.id = bs_my_id() then raise exception 'Du kan inte radera ditt eget konto'; end if;
  return bs_erase_member(m);
end $$;

/* "Radera mitt konto" i profilen (Apple kräver det i appen). Den inloggade raderar sig själv,
   med samma städning som när managern raderar. Den sista managern kan inte — då finns ingen kvar
   som styr appen. */
create or replace function delete_my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
declare m members := bs_me();
begin
  if m.id is null then raise exception 'Inget konto'; end if;
  if m.role::text = 'manager' and not exists (select 1 from members where role::text = 'manager' and active and id <> m.id) then
    raise exception 'Du är den enda managern — gör någon annan till manager först';
  end if;
  return bs_erase_member(m);
end $$;

/* Studionamn och öppettider — bokningssidan för nya kunder behöver dem utan inloggning. */
create or replace function studio_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select data from records where kind = 'setting' and id = 'studios' and not del), '{}'::jsonb)
$$;

-- Anonyma får bara läsa vad en inbjudan gäller. Allt annat kräver inloggning.
revoke all on function invite_info(text) from public, anon;
grant execute on function invite_info(text) to anon, authenticated;
revoke all on function studio_info() from public, anon;
grant execute on function studio_info() to anon, authenticated;
revoke all on function free_slots(date, date) from public, anon;
grant execute on function free_slots(date, date) to anon, authenticated;
revoke all on function public_request(text,text,text,date,text,text,text,text,text) from public, anon;
grant execute on function public_request(text,text,text,date,text,text,text,text,text) to anon, authenticated;
revoke all on function username_free(text) from public, anon;
grant execute on function username_free(text) to anon, authenticated;
-- inloggning med användarnamn: bara servern (edge-funktionen auth-login)
revoke all on function bs_login_lookup(text) from public, anon, authenticated;
revoke all on function bs_erase_member(members) from public, anon, authenticated;
revoke all on function bs_ccfg(text) from public, anon, authenticated;
revoke all on function bs_guard_reported() from public, anon, authenticated;
revoke all on function bs_history() from public, anon, authenticated;
revoke all on function bs_locked(text) from public, anon, authenticated;
revoke all on function bs_snapshot(text) from public, anon, authenticated;
revoke all on function check_sessions(jsonb) from public, anon;
revoke all on function report_sessions(jsonb) from public, anon;
revoke all on function report_snapshots(date, date) from public, anon;
revoke all on function unlock_session(text, text) from public, anon;
grant execute on function check_sessions(jsonb), report_sessions(jsonb), report_snapshots(date, date), unlock_session(text, text) to authenticated;
revoke all on function bs_fmt_h(numeric) from public, anon, authenticated;
revoke all on function bs_len_h(jsonb) from public, anon, authenticated;
revoke all on function bs_leader_hours(text, int, text) from public, anon, authenticated;
revoke all on function bs_circle_conflict(jsonb, text) from public, anon, authenticated;
revoke all on function bs_check_circle_session(jsonb, text, numeric) from public, anon, authenticated;
revoke all on function bs_circle_booking_fill() from public, anon, authenticated;
revoke all on function bs_circle_changed() from public, anon, authenticated;
revoke all on function circle_signup(text,text,text,text,text,text) from public;
grant execute on function circle_signup(text,text,text,text,text,text) to anon, authenticated;
revoke all on function update_circle_session(text,date,text,text) from public, anon;
revoke all on function cancel_circle_session(text) from public, anon;
revoke all on function circle_plan_check(text,jsonb,text,text) from public, anon;
revoke all on function find_duplicates(text,text,text) from public, anon;
revoke all on function add_circle_member(text,text) from public, anon;
revoke all on function place_signup(text,text,text) from public, anon;
revoke all on function reject_signup(text) from public, anon;
grant execute on function update_circle_session(text,date,text,text), cancel_circle_session(text),
  circle_plan_check(text,jsonb,text,text), find_duplicates(text,text,text), add_circle_member(text,text),
  place_signup(text,text,text), reject_signup(text) to authenticated;
revoke all on function delete_my_account() from public, anon;
grant execute on function delete_my_account() to authenticated;
revoke all on function bs_login_fail(text) from public, anon, authenticated;
revoke all on function bs_role_sv(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function bs_login_lookup(text) to service_role;
    grant execute on function bs_login_fail(text) to service_role;
  end if;
end $$;
