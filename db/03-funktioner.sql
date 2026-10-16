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
declare me members; cids text[]; res jsonb; studios jsonb; rates jsonb; circ jsonb; lead members;
begin
  me := bs_me();
  if me.id is null then raise exception 'Inget konto'; end if;
  select data into studios from records where kind = 'setting' and id = 'studios';
  select data into rates   from records where kind = 'setting' and id = 'rates';

  if me.role = 'customer' then
    /* Access: kunden är också cirkeldeltagare — gruppen, ansvarig producent och gruppens pass */
    select data into circ from records where kind = 'circle' and not del and data->'members' ? me.id
     order by coalesce((data->>'active')::boolean, true) desc, up desc limit 1;
    select * into lead from members where active and circ is not null and name = circ->>'leader' limit 1;
    return jsonb_build_object('me', to_jsonb(me), 'studios', studios, 'rates', rates,
      'producer', (select name from members where id = me.producer and active),
      /* den kunden hör av sig till om det är mindre än en timme kvar: sin producent, annars gruppens ledare */
      'contact', coalesce((select jsonb_build_object('name', name, 'email', email, 'phone', phone)
                    from members where id = me.producer and active),
                  case when lead.id is not null then jsonb_build_object('name', lead.name, 'email', lead.email, 'phone', lead.phone) end),
      'circle', case when circ is null then null else jsonb_build_object('id', circ->>'id', 'n', circ->>'n',
                  'subject', circ->>'subject', 'leader', circ->>'leader', 'size', jsonb_array_length(coalesce(circ->'members','[]'::jsonb))) end,
      'leaderContact', case when lead.id is null then null else jsonb_build_object('name', lead.name, 'email', lead.email, 'phone', lead.phone) end,
      /* gruppens kommande pass (ledaren planerar dem; närvaron markeras där) */
      'group', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'date', data->>'date', 'start', data->>'start',
                  'end', data->>'end', 'studio', data->>'studio', 'title', data->>'title', 'lessonTitle', data->>'lessonTitle')
                  order by data->>'date', data->>'start') from records
                 where kind = 'booking' and not del and circ is not null and data->>'circleId' = circ->>'id'
                   and coalesce(data->>'status','') = '' and (data->>'date')::date >= current_date), '[]'::jsonb),
      'circleHours', coalesce((select sum((r.data->>'hours')::numeric) from records r
                  where r.kind = 'booking' and not r.del and r.data->>'status' = 'done'
                    and coalesce(r.data->'present','[]'::jsonb) ? me.id), 0),
      'access', bs_acfg(),
      'profile', jsonb_build_object('pnr', exists (select 1 from member_pnr where member_id = me.id),
                  'registered', me.registered_at, 'consent', me.consent_at is not null),
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
    /* kurserna gruppernas ledare följer (utbildningssystemet) */
    'courses', coalesce((select jsonb_agg(k.data) from records k where k.kind='course' and not k.del
        and k.id in (select data->>'courseId' from records where kind='circle' and id = any(cids))), '[]'),
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
  /* Access: deltagaren kompletterar profilen (personnummer, inriktning) som kunderna */
  if me.role = 'participant' then
    res := res || jsonb_build_object('access', bs_acfg(), 'profile', jsonb_build_object(
      'pnr', exists (select 1 from member_pnr where member_id = me.id), 'registered', me.registered_at, 'consent', me.consent_at is not null));
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

/* Genomfört: närvaro, timmar och (om gruppen har en kurs) vilken lektion som gicks igenom.
   Gruppens läge i kursen räknas fram ur de genomförda passens lektioner. */
drop function if exists complete_session(text, numeric, jsonb);
create or replace function complete_session(p_booking text, p_hours numeric, p_present jsonb, p_lesson text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; c jsonb; bad int; ltitle text;
begin
  select data into d from records where kind='booking' and id = p_booking and not del;
  if d is null or coalesce(d->>'circleId','') = '' then raise exception 'Passet finns inte'; end if;
  if not bs_leads(d->>'circleId') then raise exception 'Bara cirkelns ledare kan markera genomförd'; end if;
  if bs_locked(p_booking) then raise exception 'Passet är kontrollerat — admin måste låsa upp det först'; end if;
  if d->>'status' in ('request','declined') then raise exception 'Passet är inte bokat'; end if;
  if p_hours is null then   /* ångra */
    return bs_put_booking(d || '{"status":"","hours":null,"present":[],"completedBy":"","lessonId":"","lessonTitle":""}');
  end if;
  if p_hours <= 0 or p_hours > 24 then raise exception 'Ange mellan 0,5 och 24 timmar'; end if;
  select data into c from records where kind='circle' and id = d->>'circleId';
  select count(*) into bad from jsonb_array_elements_text(coalesce(p_present,'[]')) p(x)
   where not (c->'members' ? p.x);
  if bad > 0 then raise exception 'Någon av de närvarande är inte med i cirkeln'; end if;
  if nullif(p_lesson,'') is not null then
    select ls->>'title' into ltitle
      from records k, jsonb_array_elements(coalesce(k.data->'levels','[]'::jsonb)) lv, jsonb_array_elements(coalesce(lv->'lessons','[]'::jsonb)) ls
     where k.kind = 'course' and not k.del and k.id = c->>'courseId' and ls->>'id' = p_lesson;
    if ltitle is null then raise exception 'Lektionen finns inte i gruppens kurs'; end if;
  end if;
  return bs_put_booking(d || jsonb_build_object('status','done','hours',p_hours,
    'present', coalesce(p_present,'[]'), 'completedBy', (bs_me()).name, 'completedAt', now_ms(),
    'lessonId', coalesce(nullif(p_lesson,''), ''), 'lessonTitle', coalesce(ltitle, '')));
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
  if not bs_is_part(p_member) then raise exception 'Personen är inte cirkeldeltagare'; end if;
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
  elsif not bs_is_part(mid) then
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
  /* Access (2026-10): man bokar inte längre utan konto — man registrerar sig */
  raise exception 'Bokningen sker nu i Bando HQ — registrera dig på bandohq.se/access';
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

-- =====================================================================
--  BANDO REWARDS — poäng, belöningar, nivåer, omdömen och artist intelligence
--  Artisten är kundkontot. Tabellerna har inga policys; allt går via funktionerna
--  här, som kontrollerar vem som får vad:
--    admin (och den med behörigheten artist_intel): allt
--    producenter: avsluta egna kunders pass och skriva omdömen, se omdömen på egna pass
--    kunden: sina egna poäng, sin nivå och belöningarna — aldrig omdömen eller CRM
--    cirkelledare, deltagare, kamera: ingenting
-- =====================================================================
create or replace function bs_rcfg(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select data->p_key from records where kind = 'setting' and id = 'rewards' and not del and data ? p_key),
    jsonb_build_object('tiers', jsonb_build_array(jsonb_build_object('hours', 3, 'points', 100), jsonb_build_object('hours', 6, 'points', 500)),
      'activeDays', 60, 'recurringMin', 3, 'recurringWindow', 90)->p_key)
$$;
create or replace function bs_has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select bs_is_admin() or exists (select 1 from members where user_id = auth.uid() and active and p = any(perms))
$$;
/* Poängen för ett pass: högsta steget i trappan som passets längd når (3 h → 100, 6 h → 500). */
create or replace function bs_points_for(p_hours numeric) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max((t->>'points')::int), 0) from jsonb_array_elements(bs_rcfg('tiers')) t
   where (t->>'hours')::numeric <= p_hours + 0.0001
$$;
create or replace function bs_balance(p_member text) returns table(earned int, spent int, available int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(points) filter (where kind in ('earn','reversal','adjust')), 0)::int,
         coalesce(-sum(points) filter (where kind in ('redeem','refund')), 0)::int,
         coalesce(sum(points), 0)::int
    from points where member_id = p_member
$$;
/* Kundens pass (kundens namn står på passet). Avslutade och betalda räknas för nivåerna. */
create or replace function bs_level_stats(p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'earned', (select earned from bs_balance(p_member)),
    'sessions12', count(*) filter (where (r.data->>'closed')::boolean and (r.data->>'paid')::boolean
                                     and (r.data->>'date')::date >= current_date - 365),
    'hours12', coalesce(sum(bs_len_h(r.data)) filter (where (r.data->>'closed')::boolean and (r.data->>'paid')::boolean
                                     and (r.data->>'date')::date >= current_date - 365), 0))
    from members m left join records r on r.kind = 'booking' and not r.del and lower(r.data->>'who') = lower(m.name)
                                       and coalesce(r.data->>'circleId','') = ''
   where m.id = p_member
$$;
/* Högsta aktiva nivån vars kriterier är uppfyllda. Saknas ett kriterium räknas det som 0. */
create or replace function bs_member_level(p_member text) returns levels
language sql stable security definer set search_path = public as $$
  select l.* from levels l, bs_level_stats(p_member) s
   where l.active
     and (s->>'earned')::numeric     >= coalesce((l.criteria->>'minEarned')::numeric, 0)
     and (s->>'sessions12')::numeric >= coalesce((l.criteria->>'minSessions12')::numeric, 0)
     and (s->>'hours12')::numeric    >= coalesce((l.criteria->>'minHours12')::numeric, 0)
   order by l.rank desc limit 1
$$;
/* Nivån räknas om efter varje poängändring; en ny nivå loggas, och en högre ger kunden en notis. */
create or replace function bs_update_level(p_member text) returns void
language plpgsql security definer set search_path = public as $$
declare lv levels := bs_member_level(p_member); prev level_history;
begin
  select * into prev from level_history where member_id = p_member order by id desc limit 1;
  if coalesce(prev.level_id,'') is not distinct from coalesce(lv.id,'') then return; end if;
  insert into level_history(member_id, level_id, level_name, rank) values (p_member, lv.id, lv.name, lv.rank);
  if lv.id is not null and coalesce(lv.rank, 0) > coalesce(prev.rank, -1) and prev.id is not null then
    perform bs_notify(p_member, null, 'Ny nivå: ' || lv.name,
      'Grattis! Du är nu ' || lv.name || '-medlem hos Bando.' || coalesce(E'\n\n' || 'Det här ingår: ' || nullif(lv.perks,''), ''),
      'level', 'level:' || p_member || ':' || lv.id);
  end if;
end $$;
create or replace function bs_note_text(n jsonb) returns text
language sql immutable as $$
  select trim(concat_ws('', n->>'went', n->>'created', n->>'strengths', n->>'develop', n->>'next', n->>'other'))
$$;
/* Får jag avsluta passet och skriva omdöme? Admin, kundens producent eller en producent som var med. */
create or replace function bs_may_close(d jsonb, cu members) returns boolean
language sql stable security definer set search_path = public as $$
  select bs_is_admin() or (bs_is_crew() and (cu.producer = bs_my_id() or coalesce(d->'with','[]'::jsonb) ? (bs_me()).name
                                            or d->>'closedBy' = (bs_me()).name))
$$;

/* Efter passet: genomfört och betalt → poäng (en gång per pass; avmarkeras betalt dras de
   tillbaka). Ett omdöme kan skrivas samtidigt. */
create or replace function close_session(p_booking text, p_paid boolean, p_note jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; cu members; pts int; net int; diff int; me members := bs_me();
begin
  select data into d from records where kind = 'booking' and id = p_booking and not del for update;
  if d is null then raise exception 'Passet finns inte'; end if;
  if coalesce(d->>'circleId','') <> '' then raise exception 'Cirkelpass avslutas med närvaron'; end if;
  if coalesce(d->>'status','') <> '' then raise exception 'Passet är inte bokat'; end if;
  if bs_starts(d) > now() then raise exception 'Passet har inte börjat än'; end if;
  select * into cu from members where role::text = 'customer' and lower(name) = lower(d->>'who') limit 1;
  if cu.id is null then raise exception 'Passet är inte bokat av en kund'; end if;
  if not bs_may_close(d, cu) then raise exception 'Bara kundens producent, en producent som var med eller admin kan avsluta passet'; end if;
  pts := case when p_paid then bs_points_for(bs_len_h(d)) else 0 end;
  perform pg_advisory_xact_lock(hashtext('points:' || cu.id));
  select coalesce(sum(points), 0) into net from points where booking_id = p_booking and kind in ('earn','reversal');
  diff := pts - net;
  if diff <> 0 then
    insert into points(member_id, booking_id, kind, points, note, by_id)
    values (cu.id, p_booking, case when diff > 0 then 'earn' else 'reversal' end, diff, bs_when(d), me.id);
  end if;
  perform bs_put_booking(d || jsonb_build_object('closed', true, 'paid', p_paid,
    'closedBy', coalesce(d->>'closedBy', me.name), 'closedAt', now_ms()));
  if p_note is not null and bs_note_text(p_note) <> '' then
    insert into artist_notes(member_id, booking_id, author_id, went, created, strengths, develop, next, other)
    values (cu.id, p_booking, me.id, p_note->>'went', p_note->>'created', p_note->>'strengths', p_note->>'develop', p_note->>'next', p_note->>'other');
  end if;
  perform bs_update_level(cu.id);
  return jsonb_build_object('points', pts, 'available', (select available from bs_balance(cu.id)));
end $$;

/* Omdöme i efterhand (samma regler som när passet avslutas). */
create or replace function add_artist_note(p_booking text, p_note jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb; cu members;
begin
  select data into d from records where kind = 'booking' and id = p_booking and not del;
  if d is null then raise exception 'Passet finns inte'; end if;
  select * into cu from members where role::text = 'customer' and lower(name) = lower(d->>'who') limit 1;
  if cu.id is null then raise exception 'Passet är inte bokat av en kund'; end if;
  if not bs_may_close(d, cu) then raise exception 'Bara producenter som var med på passet kan skriva omdöme'; end if;
  if bs_note_text(p_note) = '' then raise exception 'Skriv något först'; end if;
  insert into artist_notes(member_id, booking_id, author_id, went, created, strengths, develop, next, other)
  values (cu.id, p_booking, bs_my_id(), p_note->>'went', p_note->>'created', p_note->>'strengths', p_note->>'develop', p_note->>'next', p_note->>'other');
end $$;

/* Omdömena om en artist som den inloggade får se: admin och artist_intel allt; producenter
   sina egna och de på pass där de var med eller är kundens producent. */
create or replace function artist_notes_for(p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'at', n.created_at, 'author', a.name, 'mine', n.author_id = bs_my_id(),
      'booking', n.booking_id, 'date', r.data->>'date', 'start', r.data->>'start', 'end', r.data->>'end',
      'went', n.went, 'created', n.created, 'strengths', n.strengths, 'develop', n.develop, 'next', n.next, 'other', n.other)
      order by n.created_at desc), '[]'::jsonb)
    from artist_notes n
    left join members a on a.id = n.author_id
    left join records r on r.kind = 'booking' and r.id = n.booking_id
    left join members cu on cu.id = n.member_id
   where n.member_id = p_member and bs_is_crew()
     and (bs_has_perm('artist_intel') or n.author_id = bs_my_id() or cu.producer = bs_my_id()
          or coalesce(r.data->'with','[]'::jsonb) ? (bs_me()).name or r.data->>'closedBy' = (bs_me()).name)
$$;

/* Katalogen: belöningar (aktiva — admin ser alla), nivåer och poängtrappan. */
create or replace function rewards_catalog() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when bs_my_id() is null or not (bs_is_crew() or (bs_me()).role::text = 'customer') then null else jsonb_build_object(
    'rewards', coalesce((select jsonb_agg(to_jsonb(w) order by w.cost) from rewards w where w.active or bs_has_perm('artist_intel')), '[]'::jsonb),
    'levels', coalesce((select jsonb_agg(to_jsonb(l) order by l.rank) from levels l where l.active or bs_has_perm('artist_intel')), '[]'::jsonb),
    'tiers', bs_rcfg('tiers')) end
$$;
/* En artists poäng, nivå, historik och inlösningar — för artisten själv, admin och artist_intel. */
create or replace function points_summary(p_member text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare mid text := coalesce(p_member, bs_my_id()); b record; lv levels; nx levels; st jsonb;
begin
  if mid is null or not (mid = bs_my_id() or bs_has_perm('artist_intel')) then raise exception 'Inte behörig'; end if;
  select * into b from bs_balance(mid);
  lv := bs_member_level(mid); st := bs_level_stats(mid);
  select * into nx from levels where active and rank > coalesce(lv.rank, -1) order by rank limit 1;
  return jsonb_build_object('earned', b.earned, 'spent', b.spent, 'available', b.available, 'stats', st,
    'level', case when lv.id is null then null else to_jsonb(lv) end, 'next', case when nx.id is null then null else to_jsonb(nx) end,
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'points', points, 'note', note) order by at desc)
                           from (select * from points where member_id = mid order by at desc limit 50) x), '[]'::jsonb),
    'redemptions', coalesce((select jsonb_agg(to_jsonb(r) order by r.at desc) from redemptions r where r.member_id = mid), '[]'::jsonb));
end $$;

/* Lös in: kunden själv, eller admin åt en kund. Poängen dras direkt. */
create or replace function redeem_reward(p_reward text, p_member text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); mid text; w rewards; bal int; rid bigint; cname text; adm members;
begin
  if p_member is null then
    if me.role::text <> 'customer' then raise exception 'Bara kunder löser in poäng'; end if;
    mid := me.id;
  else
    if not bs_is_admin() then raise exception 'Bara admin löser in åt en kund'; end if;
    mid := p_member;
  end if;
  select * into w from rewards where id = p_reward and active;
  if w.id is null then raise exception 'Belöningen finns inte'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || mid));
  select available into bal from bs_balance(mid);
  if bal < w.cost then raise exception 'För få poäng — % av %', bal, w.cost; end if;
  insert into redemptions(member_id, reward_id, title, cost, by_id) values (mid, w.id, w.title, w.cost, me.id) returning id into rid;
  insert into points(member_id, redemption_id, kind, points, note, by_id) values (mid, rid, 'redeem', -w.cost, w.title, me.id);
  cname := (select name from members where id = mid);
  for adm in select * from members where active and role::text in ('manager','admin') loop
    perform bs_notify(adm.id, null, cname || ' löste in ' || w.title, cname || ' löste in ' || w.title || ' (' || w.cost || ' poäng). Lämna ut den och markera det i BANDOHQ.',
      'reward', 'reward:' || rid || ':' || adm.id);
  end loop;
  return jsonb_build_object('redemption', rid, 'available', bal - w.cost);
end $$;
create or replace function handle_redemption(p_id bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare r redemptions;
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar inlösningar'; end if;
  if p_status not in ('delivered','cancelled') then raise exception 'Ogiltig status'; end if;
  select * into r from redemptions where id = p_id for update;
  if r.id is null or r.status <> 'waiting' then raise exception 'Inlösningen är redan hanterad'; end if;
  update redemptions set status = p_status, handled_by = bs_my_id(), handled_at = now() where id = p_id;
  if p_status = 'cancelled' then
    insert into points(member_id, redemption_id, kind, points, note, by_id) values (r.member_id, r.id, 'refund', r.cost, 'Makulerad: ' || r.title, bs_my_id());
  end if;
end $$;
create or replace function pending_redemptions() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not bs_has_perm('artist_intel') then '[]'::jsonb else coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('name', m.name) order by r.at), '[]'::jsonb) end
    from redemptions r left join members m on m.id = r.member_id where r.status = 'waiting'
$$;
create or replace function adjust_points(p_member text, p_points int, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin justerar saldon'; end if;
  if coalesce(p_points, 0) = 0 then raise exception 'Ange hur många poäng'; end if;
  if length(trim(coalesce(p_note,''))) < 3 then raise exception 'Skriv varför saldot justeras'; end if;
  if not exists (select 1 from members where id = p_member and role::text = 'customer') then raise exception 'Bara kunder har poäng'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_member));
  if (select available from bs_balance(p_member)) + p_points < 0 then raise exception 'Saldot kan inte bli negativt'; end if;
  insert into points(member_id, kind, points, note, by_id) values (p_member, 'adjust', p_points, left(trim(p_note), 200), bs_my_id());
  perform bs_update_level(p_member);
  return jsonb_build_object('available', (select available from bs_balance(p_member)));
end $$;

/* Belöningar och nivåer — admin. */
create or replace function save_reward(p jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare rid text := coalesce(nullif(p->>'id',''), bs_uid('rw_'));
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar belöningar'; end if;
  if length(trim(coalesce(p->>'title',''))) < 2 then raise exception 'Belöningen behöver ett namn'; end if;
  if coalesce((p->>'cost')::int, 0) <= 0 then raise exception 'Poängkravet måste vara större än 0'; end if;
  insert into rewards(id, title, description, cost, active) values (rid, trim(p->>'title'), p->>'description', (p->>'cost')::int, coalesce((p->>'active')::boolean, true))
  on conflict (id) do update set title = excluded.title, description = excluded.description, cost = excluded.cost, active = excluded.active;
  return rid;
end $$;
create or replace function delete_reward(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar belöningar'; end if;
  delete from rewards where id = p_id;            -- inlösningarna behåller namn och poäng
end $$;
create or replace function save_level(p jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare lid text := coalesce(nullif(p->>'id',''), bs_uid('lv_'));
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar nivåer'; end if;
  if length(trim(coalesce(p->>'name',''))) < 2 then raise exception 'Nivån behöver ett namn'; end if;
  insert into levels(id, name, rank, criteria, perks, active)
  values (lid, trim(p->>'name'), coalesce((p->>'rank')::int, 0), coalesce(p->'criteria','{}'::jsonb), p->>'perks', coalesce((p->>'active')::boolean, true))
  on conflict (id) do update set name = excluded.name, rank = excluded.rank, criteria = excluded.criteria, perks = excluded.perks, active = excluded.active;
  return lid;
end $$;
create or replace function delete_level(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin hanterar nivåer'; end if;
  delete from levels where id = p_id;
end $$;
/* Startnivåerna — exempelgränser som ni ändrar. Läggs bara in om det inte finns några nivåer. */
do $$ begin
  if not exists (select 1 from levels) then
    insert into levels(id, name, rank, criteria, perks) values
      ('lv_member', 'Member', 0, '{}', null),
      ('lv_silver', 'Silver', 1, '{"minEarned":1000}', null),
      ('lv_gold', 'Gold', 2, '{"minEarned":3000,"minSessions12":10}', null),
      ('lv_platinum', 'Platinum', 3, '{"minEarned":6000,"minSessions12":20}', null);
  end if;
end $$;

/* Intern uppföljning per artist. */
create or replace function save_artist_crm(p_member text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_has_perm('artist_intel') then raise exception 'Inte behörig'; end if;
  insert into artist_crm(member_id, projects, goals, followup, followup_note, updated_by, updated_at)
  values (p_member, p->>'projects', p->>'goals', nullif(p->>'followup','')::date, p->>'followup_note', bs_my_id(), now())
  on conflict (member_id) do update set projects = excluded.projects, goals = excluded.goals, followup = excluded.followup,
    followup_note = excluded.followup_note, updated_by = excluded.updated_by, updated_at = now();
end $$;
create or replace function set_member_perms(p_member text, p_perms jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not bs_is_admin() then raise exception 'Bara admin delar ut behörigheter'; end if;
  update members set perms = array(select jsonb_array_elements_text(coalesce(p_perms,'[]'::jsonb))) where id = p_member;
end $$;

/* Artist Intelligence: en rad per kund med aktivitet, nivå, poäng och uppföljning. */
create or replace function artist_intel() returns jsonb
language sql stable security definer set search_path = public as $$
  with cu as (select * from members where role::text = 'customer' and active),
  bk as (select m.id mid, r.data d from cu m join records r on r.kind = 'booking' and not r.del
           and lower(r.data->>'who') = lower(m.name) and coalesce(r.data->>'circleId','') = ''
           and coalesce(r.data->>'status','') not in ('request','declined'))
  select case when not bs_has_perm('artist_intel') then '[]'::jsonb else coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb) end
  from (select jsonb_build_object(
      'id', m.id, 'name', m.name, 'email', m.email, 'phone', m.phone,
      'producer', (select name from members where id = m.producer),
      'bookings', (select count(*) from bk where bk.mid = m.id and (bk.d->>'date')::date <= current_date),
      'hours', coalesce((select sum(bs_len_h(bk.d)) from bk where bk.mid = m.id and (bk.d->>'date')::date <= current_date), 0),
      'last', (select max(bk.d->>'date') from bk where bk.mid = m.id and (bk.d->>'date')::date <= current_date),
      'next', (select min(bk.d->>'date') from bk where bk.mid = m.id and (bk.d->>'date')::date > current_date),
      'months', (select jsonb_agg(coalesce((select count(*) from bk where bk.mid = m.id
                   and date_trunc('month', (bk.d->>'date')::date) = date_trunc('month', current_date) - make_interval(months => g)), 0) order by g desc)
                 from generate_series(0, 5) g),
      'recent', (select count(*) from bk where bk.mid = m.id and (bk.d->>'date')::date between current_date - (bs_rcfg('recurringWindow'))::text::int and current_date),
      'producers', (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from (
          select jsonb_array_elements_text(coalesce(bk.d->'with','[]'::jsonb)) p from bk where bk.mid = m.id
          union select bk.d->>'closedBy' from bk where bk.mid = m.id and bk.d->>'closedBy' is not null
          union select name from members where id = m.producer) x where p is not null),
      'available', (select available from bs_balance(m.id)), 'earned', (select earned from bs_balance(m.id)),
      'level', (select name from bs_member_level(m.id)),
      'notes', (select count(*) from artist_notes n where n.member_id = m.id),
      'crm', (select to_jsonb(c) - 'member_id' from artist_crm c where c.member_id = m.id),
      'status', case
         when (select count(*) from bk where bk.mid = m.id and (bk.d->>'date')::date <= current_date) <= 1 then 'ny'
         when not exists (select 1 from bk where bk.mid = m.id and (bk.d->>'date')::date between current_date - (bs_rcfg('activeDays'))::text::int and current_date + 365) then 'inaktiv'
         when (select count(*) from bk where bk.mid = m.id and (bk.d->>'date')::date between current_date - (bs_rcfg('recurringWindow'))::text::int and current_date)
              >= (bs_rcfg('recurringMin'))::text::int then 'återkommande'
         else 'aktiv' end) as row
    from cu m) x
$$;

revoke all on function bs_rcfg(text) from public, anon, authenticated;
revoke all on function bs_points_for(numeric) from public, anon, authenticated;
revoke all on function bs_balance(text) from public, anon, authenticated;
revoke all on function bs_level_stats(text) from public, anon, authenticated;
revoke all on function bs_member_level(text) from public, anon, authenticated;
revoke all on function bs_update_level(text) from public, anon, authenticated;
revoke all on function bs_note_text(jsonb) from public, anon, authenticated;
revoke all on function bs_may_close(jsonb, members) from public, anon, authenticated;
revoke all on function bs_has_perm(text) from public, anon, authenticated;
revoke all on function close_session(text, boolean, jsonb), add_artist_note(text, jsonb), artist_notes_for(text), rewards_catalog(),
  points_summary(text), redeem_reward(text, text), handle_redemption(bigint, text), pending_redemptions(), adjust_points(text, int, text),
  save_reward(jsonb), delete_reward(text), save_level(jsonb), delete_level(text), save_artist_crm(text, jsonb),
  set_member_perms(text, jsonb), artist_intel() from public, anon;
grant execute on function close_session(text, boolean, jsonb), add_artist_note(text, jsonb), artist_notes_for(text), rewards_catalog(),
  points_summary(text), redeem_reward(text, text), handle_redemption(bigint, text), pending_redemptions(), adjust_points(text, int, text),
  save_reward(jsonb), delete_reward(text), save_level(jsonb), delete_level(text), save_artist_crm(text, jsonb),
  set_member_perms(text, jsonb), artist_intel() to authenticated;

-- =====================================================================
--  BANDO HQ ACCESS — registreringen bakom QR-koden (bandohq.se/access)
--  Den som registrerar sig blir kund OCH cirkeldeltagare: bokar studiotid som
--  kunder gör och placeras av admin i en studiocirkel. Personnumret behövs för
--  rapporteringen av studiecirklarna till studieförbundet. Det lagras krypterat
--  (member_pnr), syns bara för admin och då maskerat; varje visning loggas.
-- =====================================================================
/* Inriktningar, förmåner och tjänstepriser. Admin ändrar dem i appen (Mer → Rewards →
   Access); det som saknas i setting/access tas härifrån. */
create or replace function bs_access_default() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'interests', jsonb_build_array(
      jsonb_build_object('id','songwriting','label','Låtskrivning & textförfattande','subject','Musikproduktion'),
      jsonb_build_object('id','rap','label','Rap, flow & delivery','subject','Artistutveckling'),
      jsonb_build_object('id','vocals','label','Sång & vokalteknik','subject','Artistutveckling'),
      jsonb_build_object('id','production','label','Musikproduktion & beatmaking','subject','Musikproduktion'),
      jsonb_build_object('id','recording','label','Inspelning & studioteknik','subject','Musikproduktion'),
      jsonb_build_object('id','mixing','label','Mixning & mastering','subject','Musikproduktion'),
      jsonb_build_object('id','artistdev','label','Artistutveckling & sound','subject','Artistutveckling'),
      jsonb_build_object('id','performance','label','Scennärvaro & performance','subject','Artistutveckling'),
      jsonb_build_object('id','content','label','Content & sociala medier','subject','Marknadsföring'),
      jsonb_build_object('id','film','label','Foto, film & musikvideo','subject','Foto och film'),
      jsonb_build_object('id','marketing','label','Marknadsföring & release','subject','Marknadsföring'),
      jsonb_build_object('id','industry','label','A&R, management & musikbranschen','subject','Management')),
    'perks', jsonb_build_array(
      jsonb_build_object('title','Studiobokningar','text','Boka sessions smidigt och till förmånliga priser.'),
      jsonb_build_object('title','Rabatter på tjänster','text','Ta del av bättre priser på mix & master, foto, musikvideo, content och marknadsföring.'),
      jsonb_build_object('title','Kreativa samarbeten','text','Få tillgång till erbjudanden från producenter, filmare och andra kreatörer inom Bandos nätverk.'),
      jsonb_build_object('title','Strategi & artistutveckling','text','Få vägledning kring din musik, dina projekt och kommande releaser.'),
      jsonb_build_object('title','A&R-feedback','text','Möjlighet att skicka in musik för professionell feedback, även från A&R-kontakter på stora skivbolag.'),
      jsonb_build_object('title','Merch & egna projekt','text','Få hjälp med att utveckla och producera egna kläder, merchandise och kreativa produkter.')),
    /* tjänstepriserna: price = ordinarie, access = med Bando HQ Access (null = fråga oss) */
    'services', jsonb_build_array(
      jsonb_build_object('id','mix','name','Mix & master','price',null,'access',null,'unit','per låt'),
      jsonb_build_object('id','photo','name','Foto','price',null,'access',null,'unit',''),
      jsonb_build_object('id','video','name','Musikvideo','price',null,'access',null,'unit',''),
      jsonb_build_object('id','content','name','Content','price',null,'access',null,'unit',''),
      jsonb_build_object('id','marketing','name','Marknadsföring','price',null,'access',null,'unit','')))
$$;
create or replace function bs_acfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select bs_access_default() || coalesce((select jsonb_strip_nulls(jsonb_build_object(
           'interests', data->'interests', 'perks', data->'perks', 'services', data->'services'))
         from records where kind = 'setting' and id = 'access' and not del), '{}'::jsonb)
$$;
/* Inriktningarna som går att välja (dolda ligger kvar för dem som redan valt dem). */
create or replace function bs_interest_ids() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(i->>'id'), '{}') from jsonb_array_elements(bs_acfg()->'interests') i
   where not coalesce((i->>'off')::boolean, false)
$$;

/* Registreringssidan: inriktningar och förmåner. Inga priser — de syns inloggad. */
create or replace function access_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'interests', coalesce((select jsonb_agg(jsonb_build_object('id', i->>'id', 'label', i->>'label')) from jsonb_array_elements(bs_acfg()->'interests') i
                            where not coalesce((i->>'off')::boolean, false)), '[]'::jsonb),
    'perks', bs_acfg()->'perks')
$$;

/* Nyckeln: Supabase Vault (skapas på servern första gången och lämnar den aldrig).
   Utan Vault (testerna) ligger den i bs_secrets. */
create or replace function bs_pnr_key() returns text
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = ''bandohq_pnr'' limit 1' into k;
  end if;
  if k is null then select value into k from bs_secrets where name = 'pnr_key'; end if;
  if k is null or length(k) < 32 then raise exception 'Personnummernyckeln saknas — kör db/03-funktioner.sql igen'; end if;
  return k;
end $$;
do $$ begin
  if to_regclass('vault.secrets') is not null then
    if not exists (select 1 from vault.secrets where name = 'bandohq_pnr') then
      perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bandohq_pnr', 'BANDOHQ: nyckeln till personnumren');
    end if;
  elsif not exists (select 1 from bs_secrets where name = 'pnr_key') then
    insert into bs_secrets(name, value) values ('pnr_key', encode(extensions.gen_random_bytes(32), 'hex'));
  end if;
end $$;

/* "19900101-1234", "900101-1234", "199001011234" → "199001011234", eller null om det inte
   är ett giltigt personnummer (datum och kontrollsiffra). Samordningsnummer (dag + 60) går. */
create or replace function bs_pnr(p text) returns text
language plpgsql stable as $$
declare raw text := regexp_replace(coalesce(p,''), '[\s]', '', 'g'); d text; full_ text; y int; mo int; dd int; s int := 0; k int; x int;
begin
  if raw !~ '^(\d{6}|\d{8})[-+]?\d{4}$' then return null; end if;
  d := regexp_replace(raw, '[-+]', '', 'g');
  if length(d) = 10 then
    /* sekelskiftet: '+' betyder 100 år eller äldre, annars det senaste sekel som inte ligger i framtiden */
    y := substr(d,1,2)::int;
    full_ := (case when y > extract(year from current_date)::int % 100 then 19 else 20 end
              - case when raw like '%+%' then 1 else 0 end)::text || d;
  else full_ := d; end if;
  y := substr(full_,1,4)::int; mo := substr(full_,5,2)::int; dd := substr(full_,7,2)::int;
  if dd > 60 then dd := dd - 60; end if;
  if mo < 1 or mo > 12 or dd < 1 then return null; end if;
  begin
    if make_date(y, mo, dd) > current_date or y < extract(year from current_date)::int - 120 then return null; end if;
  exception when others then return null; end;
  for k in 3..12 loop
    x := substr(full_, k, 1)::int * case when k % 2 = 1 then 2 else 1 end;
    s := s + x / 10 + x % 10;
  end loop;
  if s % 10 <> 0 then return null; end if;
  return full_;
end $$;
create or replace function bs_pnr_hash(p12 text) returns text
language sql stable security definer set search_path = public as $$
  select encode(extensions.hmac(p12, bs_pnr_key(), 'sha256'), 'hex')
$$;
create or replace function bs_put_pnr(p_member text, p12 text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into member_pnr(member_id, pnr_enc, pnr_hash, birth)
  values (p_member, extensions.pgp_sym_encrypt(p12, bs_pnr_key()), bs_pnr_hash(p12), substr(p12, 3, 6))
  on conflict (member_id) do update set pnr_enc = excluded.pnr_enc, pnr_hash = excluded.pnr_hash,
    birth = excluded.birth, created_at = now();
end $$;
/* "Ali  hassan-berg " → "Ali Hassan-Berg"? Nej — namnet skrivs som personen skrev det, bara
   utan dubbla mellanslag. Jämförelser görs på gemener. */
create or replace function bs_clean_name(p text) returns text
language sql immutable as $$ select regexp_replace(trim(coalesce(p,'')), '\s+', ' ', 'g') $$;

/* Är personen cirkeldeltagare? Rollen deltagare, eller kund (Access) som är deltagare. */
create or replace function bs_is_part(p_member text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where id = p_member and active
                    and (role::text = 'participant' or (role::text = 'customer' and participant)))
$$;

/* Registreringen. Körs av den som just skapat sin inloggning och bekräftat e-posten med
   koden. Skapar kunden (och deltagaren), eller kopplar inloggningen till en person som
   redan finns utan inloggning (inlagd av crewet eller via anmälningskön). Samma funktion
   fyller i det som saknas för en befintlig kund ("Komplettera din profil").
   Dubbletter: samma personnummer, eller e-post på ett konto som redan loggar in, ger
   inget nytt konto — då tas den nya inloggningen bort igen och personen får logga in. */
create or replace function register_access(p_name text, p_phone text, p_pnr text, p_interests jsonb,
  p_consent boolean, p_url text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); em text; me members; nm text := bs_clean_name(p_name); ph text; p12 text; h text;
        ints text[]; bad text; cand members; owner text; mid text; base text; n int := 1; linked boolean := false;
        labels text; a record;
begin
  if uid is null then raise exception 'Skapa kontot först'; end if;
  select lower(email) into em from auth.users where id = uid;
  select * into me from members where user_id = uid;
  if me.id is not null and not me.active then raise exception 'Kontot är avstängt — hör av dig till oss'; end if;

  /* ---- kontrollerna (samma som på sidan) ---- */
  if me.id is null then
    if length(nm) < 3 or nm !~ '\S+\s+\S' then raise exception 'Fyll i för- och efternamn'; end if;
    if length(nm) > 60 then raise exception 'Namnet är för långt'; end if;
    if nm ~ '[0-9@#$%^&*_=+<>?/\\|{}\[\]:;"!]' then raise exception 'Namnet får bara innehålla bokstäver'; end if;
  end if;
  ph := bs_phone(p_phone);
  if ph is null and (me.id is null or nullif(trim(coalesce(p_phone,'')),'') is not null or bs_phone(me.phone) is null) then
    raise exception 'Fyll i ett giltigt mobilnummer';
  end if;
  p12 := bs_pnr(p_pnr);
  if p12 is null then raise exception 'Personnumret stämmer inte — skriv ÅÅÅÅMMDD-XXXX'; end if;
  ints := array(select distinct x from jsonb_array_elements_text(case when jsonb_typeof(p_interests) = 'array' then p_interests else '[]'::jsonb end) x order by x);
  if coalesce(array_length(ints, 1), 0) = 0 then raise exception 'Välj minst en inriktning'; end if;
  select x into bad from unnest(ints) x where x <> all(bs_interest_ids()) limit 1;
  if bad is not null then raise exception 'Okänd inriktning: %', bad; end if;
  if not coalesce(p_consent, false) then raise exception 'Godkänn hur vi hanterar dina personuppgifter'; end if;
  h := bs_pnr_hash(p12);
  select member_id into owner from member_pnr where pnr_hash = h;

  /* ---- befintlig kund: komplettera profilen ---- */
  if me.id is not null then
    if me.role::text not in ('customer','participant') then raise exception 'Ditt konto är ett crewkonto — Access gäller kunder'; end if;
    if owner is not null and owner <> me.id then
      raise exception 'Personnumret finns redan på ett annat konto — hör av dig till oss';
    end if;
    perform set_config('bs.link', '1', true);
    update members set phone = coalesce(ph, phone), interests = ints, participant = true,
           consent_at = now(), registered_at = coalesce(registered_at, now()),
           source = coalesce(source, 'app'), up = now_ms()
     where id = me.id;
    perform set_config('bs.link', '', true);
    perform bs_put_pnr(me.id, p12);
    return jsonb_build_object('ok', true, 'id', me.id, 'name', me.name, 'completed', true);
  end if;

  /* ---- ny: finns personen redan? ---- */
  if owner is not null then
    select * into cand from members where id = owner;
    if cand.user_id is not null then
      delete from auth.users where id = uid;          /* den nya inloggningen behövs inte */
      return jsonb_build_object('ok', false, 'exists', true,
        'why', 'Du har redan ett konto hos oss. Logga in med det — har du glömt lösenordet kan du få ett nytt.');
    end if;
  end if;
  if exists (select 1 from members where user_id is not null and lower(email) = em) then
    delete from auth.users where id = uid;
    return jsonb_build_object('ok', false, 'exists', true,
      'why', 'Det finns redan ett konto med den e-postadressen. Logga in med det.');
  end if;
  /* en person utan inloggning: personnummer, e-post, telefon + namn, eller bara namnet
     om crewet inte lagt in några kontaktuppgifter */
  if cand.id is null then
    select * into cand from members m where m.user_id is null and m.active and m.role::text in ('customer','participant')
       and ((em is not null and lower(m.email) = em)
         or (bs_phone(m.phone) = ph and lower(bs_clean_name(m.name)) = lower(nm))
         or (lower(bs_clean_name(m.name)) = lower(nm) and coalesce(m.email,'') = '' and coalesce(m.phone,'') = ''))
       and not exists (select 1 from member_pnr x where x.member_id = m.id and x.pnr_hash <> h)
     order by (lower(m.email) = em) desc nulls last, (bs_phone(m.phone) = ph) desc nulls last limit 1;
  end if;

  if cand.id is not null then
    perform set_config('bs.link', '1', true);
    update members set user_id = uid, email = em, phone = ph, role = 'customer', participant = true,
           interests = ints, registered_at = now(), consent_at = now(), source = 'access', active = true, up = now_ms()
     where id = cand.id;
    perform set_config('bs.link', '', true);
    mid := cand.id; nm := cand.name; linked := true;
  else
    /* namnet är nyckeln på passen — finns det redan någon med samma namn får det en siffra */
    base := nm;
    while exists (select 1 from members where lower(name) = lower(nm)) loop
      n := n + 1; nm := base || ' ' || n;
    end loop;
    mid := bs_uid('m_');
    insert into members(id, user_id, role, name, email, phone, participant, interests, registered_at, consent_at, source, up)
    values (mid, uid, 'customer', nm, em, ph, true, ints, now(), now(), 'access', now_ms());
  end if;
  perform bs_put_pnr(mid, p12);

  /* ---- mejlen ---- */
  select string_agg(i->>'label', ', ') into labels from jsonb_array_elements(bs_acfg()->'interests') i where i->>'id' = any(ints);
  perform bs_notify(mid, em, 'Välkommen till Bando HQ',
    'Hej ' || split_part(nm, ' ', 1) || '!' || E'\n\n'
    || 'Ditt konto är klart. Du har nu tillgång till Bando HQ Access: boka sessions, se dina bokningar, priser och förmåner.'
    || E'\n\n' || 'Du är också deltagare i våra studiocirklar. Vi placerar dig i en grupp utifrån det du valt ('
    || coalesce(labels, '') || '), och du ser din grupp och ansvariga producent i Bando HQ.'
    || E'\n\n' || 'Logga in med din e-postadress och lösenordet du valde.',
    'welcome', 'welcome:' || mid, '0', coalesce(p_url, 'https://www.bandohq.se/'));
  for a in select id from members where active and role::text in ('manager','admin') loop
    perform bs_notify(a.id, null, 'Ny registrering: ' || nm,
      'Ny registrering i Bando HQ Access: ' || nm || ' (' || concat_ws(', ', em, ph) || ').'
      || E'\n\n' || 'Inriktning: ' || coalesce(labels, '—') || '.'
      || case when linked then E'\n\n' || 'Personen fanns redan i BANDOHQ — inloggningen är kopplad till den raden.' else '' end
      || E'\n\n' || 'Placera personen i en studiocirkel under Cirklar → Fördela.',
      'access', 'access:' || mid || ':' || a.id, '0', coalesce(p_url, 'https://www.bandohq.se/'));
  end loop;
  return jsonb_build_object('ok', true, 'id', mid, 'name', nm, 'linked', linked);
end $$;

/* Är inloggningen kopplad till ett konto, och saknas något i profilen? (Registreringssidan
   och appen frågar innan de visar formuläret.) */
create or replace function access_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then jsonb_build_object('login', false)
    else coalesce((select jsonb_build_object('login', true, 'member', true, 'name', m.name, 'role', m.role,
        'complete', m.role::text not in ('customer','participant')
                    or (m.consent_at is not null and cardinality(m.interests) > 0 and exists (select 1 from member_pnr where member_id = m.id)),
        'missing', jsonb_strip_nulls(jsonb_build_object(
           'pnr', case when not exists (select 1 from member_pnr where member_id = m.id) then true end,
           'interests', case when cardinality(m.interests) = 0 then true end,
           'phone', case when bs_phone(m.phone) is null then true end,
           'consent', case when m.consent_at is null then true end)))
      from members m where m.user_id = auth.uid()), jsonb_build_object('login', true, 'member', false)) end
$$;

/* Kunden ändrar sina inriktningar. Admin ändrar dem på personen (vanlig synk). */
create or replace function set_my_interests(p_interests jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me members := bs_me(); ints text[]; bad text;
begin
  if me.id is null then raise exception 'Inget konto'; end if;
  ints := array(select distinct x from jsonb_array_elements_text(coalesce(p_interests,'[]'::jsonb)) x order by x);
  if coalesce(array_length(ints, 1), 0) = 0 then raise exception 'Välj minst en inriktning'; end if;
  select x into bad from unnest(ints) x where x <> all(bs_interest_ids()) and x <> all(me.interests) limit 1;
  if bad is not null then raise exception 'Okänd inriktning: %', bad; end if;
  perform set_config('bs.link', '1', true);
  update members set interests = ints, up = now_ms() where id = me.id;
  perform set_config('bs.link', '', true);
  return to_jsonb(ints);
end $$;

/* Admin: vem har personnummer, och det maskerade (ÅÅMMDD-••••). Inget dekrypteras. */
create or replace function pnr_masks() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not bs_is_admin() then '{}'::jsonb
    else coalesce(jsonb_object_agg(member_id, birth || '-••••'), '{}'::jsonb) end from member_pnr
$$;
/* Admin visar ett personnummer. Varje visning loggas i historiken. */
create or replace function reveal_pnr(p_member text) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not bs_is_admin() then raise exception 'Bara admin ser personnummer'; end if;
  select extensions.pgp_sym_decrypt(pnr_enc, bs_pnr_key()) into v from member_pnr where member_id = p_member;
  if v is null then raise exception 'Inget personnummer registrerat'; end if;
  insert into record_history(kind, rec_id, op, by_id) values ('member', p_member, 'personnummer visat', bs_my_id());
  return substr(v, 1, 8) || '-' || substr(v, 9, 4);
end $$;
/* Personnumren till rapportunderlaget (CSV till studieförbundet) — bara admin, loggas per person. */
create or replace function report_pnrs(p_members jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '{}'; r record;
begin
  if not bs_is_admin() then raise exception 'Bara admin tar ut rapportunderlaget'; end if;
  for r in select member_id, extensions.pgp_sym_decrypt(pnr_enc, bs_pnr_key()) v from member_pnr
            where member_id in (select jsonb_array_elements_text(coalesce(p_members,'[]'::jsonb))) loop
    out := out || jsonb_build_object(r.member_id, substr(r.v, 1, 8) || '-' || substr(r.v, 9, 4));
    insert into record_history(kind, rec_id, op, by_id) values ('member', r.member_id, 'personnummer i rapport', bs_my_id());
  end loop;
  return out;
end $$;
/* Admin: registreringarna — när, källa och samtycke (det som inte synkas med kontona). */
create or replace function access_people() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not bs_is_admin() then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'registered', m.registered_at, 'consent', m.consent_at, 'source', m.source,
      'pnr', (select birth || '-••••' from member_pnr where member_id = m.id)) order by m.registered_at desc nulls last), '[]'::jsonb) end
    from members m where m.role::text in ('customer','participant')
$$;

revoke all on function bs_access_default() from public, anon, authenticated;
revoke all on function bs_acfg() from public, anon, authenticated;
revoke all on function bs_interest_ids() from public, anon, authenticated;
revoke all on function bs_pnr_key() from public, anon, authenticated;
revoke all on function bs_pnr(text) from public, anon, authenticated;
revoke all on function bs_pnr_hash(text) from public, anon, authenticated;
revoke all on function bs_put_pnr(text, text) from public, anon, authenticated;
revoke all on function bs_clean_name(text) from public, anon, authenticated;
revoke all on function bs_is_part(text) from public, anon, authenticated;
revoke all on function access_info() from public;
grant execute on function access_info() to anon, authenticated;
revoke all on function register_access(text, text, text, jsonb, boolean, text), access_status(), set_my_interests(jsonb),
  pnr_masks(), reveal_pnr(text), report_pnrs(jsonb), access_people() from public, anon;
grant execute on function register_access(text, text, text, jsonb, boolean, text), access_status(), set_my_interests(jsonb),
  pnr_masks(), reveal_pnr(text), report_pnrs(jsonb), access_people() to authenticated;
