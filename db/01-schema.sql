-- =====================================================================
--  BANDOHQ — schema
--  Kör i Supabase: SQL Editor → New query → klistra in → Run.
--  Ordning: 01-schema.sql, 02-rls.sql, 03-funktioner.sql, 04-notiser.sql
--  (och 05-utskick.sql när edge-funktionen är på plats). Alla går att köra om —
--  har du kört en äldre version räcker det att köra alla filerna igen.
-- =====================================================================

do $$ begin
  create type bs_role as enum ('manager','admin','producer','leader','participant','customer','camera');
exception when duplicate_object then null; end $$;
-- v8: admin (Costa, Nabbe) och kamera (Moez, D2L). Läggs till om typen redan fanns.
alter type bs_role add value if not exists 'admin' after 'manager';
alter type bs_role add value if not exists 'camera';

-- ---------------------------------------------------------------------
--  KONTON
--  id är appens konto-id (t.ex. 'rkay'). user_id kopplar till inloggningen
--  och är null för poster som inte loggar in (t.ex. en deltagare crewet
--  lagt in för hand). Namnet är unikt — appen använder det som nyckel på
--  passen ("vem bokade").
-- ---------------------------------------------------------------------
create table if not exists members (
  id         text primary key,
  user_id    uuid unique references auth.users(id) on delete set null,
  role       bs_role not null,
  name       text not null check (length(trim(name)) >= 2),
  email      text,
  phone      text,
  color      text,
  glow       text,
  active     boolean not null default true,
  up         bigint not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists members_name_uq on members (lower(name));
-- v8: team = kamerateamet personen hör till ("D2L"), ig = Instagram-namn för
-- samarbetsinlägg, producer = kundens producent (members.id)
alter table members add column if not exists team text;
alter table members add column if not exists ig text;
alter table members add column if not exists producer text;
-- v9: användarnamnet man loggar in med (väljs vid första inloggningen; e-post går också)
alter table members add column if not exists username text;
create unique index if not exists members_username_uq on members (lower(username)) where username is not null;

-- ---------------------------------------------------------------------
--  INBJUDNINGAR
--  En länk per roll (och cirkel). Den som löser in den får rollen därifrån —
--  aldrig från sin egen webbläsare. Se redeem_invite i 03-funktioner.sql.
-- ---------------------------------------------------------------------
create table if not exists invites (
  token      text primary key check (length(token) >= 10),
  role       bs_role not null,
  circle_id  text,
  created_by text references members(id) on delete set null,
  expires_at timestamptz not null default now() + interval '14 days',
  max_uses   int check (max_uses is null or max_uses > 0),   -- null = obegränsat
  uses       int not null default 0,
  closed     boolean not null default false,
  created_at timestamptz not null default now()
);
-- v8: personliga inbjudningar (admin lägger till en person) och kundförfrågningar
alter table invites add column if not exists name text;
alter table invites add column if not exists phone text;
alter table invites add column if not exists team text;
alter table invites add column if not exists lead_id text;
-- v9: inbjudan per mejl, och till en person som redan finns i appen (member_id)
alter table invites add column if not exists email text;
alter table invites add column if not exists member_id text references members(id) on delete cascade;

-- ---------------------------------------------------------------------
--  NYA KUNDER (utan konto)
--  En förfrågan från bokningssidan. Godkänd → bokning + kundinbjudan.
-- ---------------------------------------------------------------------
create table if not exists leads (
  id         text primary key,
  name       text not null,
  email      text,
  phone      text,
  date       date not null,
  start_t    text not null,
  end_t      text not null,
  studio     text,
  message    text,
  status     text not null default 'new' check (status in ('new','approved','declined')),
  booking_id text,
  invite     text,
  handled_by text,
  created_at timestamptz not null default now()
);
alter table leads alter column phone drop not null;   -- v9: svaret kommer som mejl

-- ---------------------------------------------------------------------
--  UTKORG
--  Allt som ska skickas köas här (04-notiser.sql). Utskicket görs på servern
--  (05-utskick.sql + edge-funktionen notify-send): push till den som har det,
--  mejl via Resend. Appen ser aldrig nyckeln. dedupe_key gör att samma sak
--  aldrig skickas två gånger.
-- ---------------------------------------------------------------------
/* v9: SMS-utkorgen blir utkorgen. Finns den gamla döps den om, och telefon och
   SMS-kostnad försvinner. */
do $$ begin
  if to_regclass('public.sms_outbox') is not null and to_regclass('public.outbox') is null then
    alter table sms_outbox rename to outbox;
  end if;
end $$;
alter index if exists sms_outbox_due_idx rename to outbox_due_idx;
create table if not exists outbox (
  id         bigserial primary key,
  member_id  text,
  email      text,
  subject    text,
  body       text not null,
  link       text,
  kind       text not null,
  dedupe_key text not null unique,
  n          int not null default 1,
  send_after timestamptz not null default now(),
  sent_at    timestamptz,
  error      text,
  attempts   int not null default 0,
  claimed_at timestamptz,
  channel    text,                    -- push | mail | push+mail
  created_at timestamptz not null default now()
);
alter table outbox add column if not exists email text;
alter table outbox add column if not exists subject text;
alter table outbox add column if not exists link text;
alter table outbox add column if not exists claimed_at timestamptz;
alter table outbox add column if not exists channel text;
alter table outbox drop column if exists phone;
alter table outbox drop column if exists cost;

-- ---------------------------------------------------------------------
--  MISSLYCKADE INLOGGNINGAR MED ANVÄNDARNAMN
--  Edge-funktionen auth-login spärrar ett användarnamn efter för många fel.
--  Ingen policy: bara servern (service_role) når tabellen.
-- ---------------------------------------------------------------------
create table if not exists login_fails (
  username text not null,
  at       timestamptz not null default now()
);
create index if not exists login_fails_idx on login_fails (username, at);

-- ---------------------------------------------------------------------
--  PUSH-PRENUMERATIONER
--  En rad per enhet (telefon, dator) som har slagit på notiser. Nycklarna
--  är enhetens publika krypteringsnycklar — inga hemligheter för oss.
-- ---------------------------------------------------------------------
create table if not exists push_subs (
  id         bigserial primary key,
  member_id  text not null references members(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fails      int not null default 0
);
/* iPhone-appen: push via Apple (APNs). Då är endpoint "apns:<enhetens token>" och
   krypteringsnycklarna finns inte. kind = web | apns | apns-sandbox (utvecklingsbyggen). */
alter table push_subs add column if not exists kind text not null default 'web';
alter table push_subs alter column p256dh drop not null;
alter table push_subs alter column auth drop not null;
/* Live Activity (iPhone-appen, iOS 17.2+): telefonens push-to-start-token, så att servern kan visa
   den pågående sessionen i Dynamic Island när passet börjar — även när appen är stängd.
   Hålls skild från push_subs: en sådan token tar bara emot Live Activity, aldrig vanliga notiser. */
create table if not exists live_tokens (
  token      text primary key,
  member_id  text not null references members(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fails      int not null default 0
);
/* vilka pass som redan fått sin Live Activity, per person — så att varje pass startas en gång */
create table if not exists live_sent (
  booking_id text not null,
  member_id  text not null references members(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  primary key (booking_id, member_id)
);
create index if not exists outbox_due_idx on outbox (send_after) where sent_at is null;

-- ---------------------------------------------------------------------
--  POSTER
--  Appens samlingar (pass, cirklar, agenda, artister …) som en post per rad.
--  Varje post har egen up-tidsstämpel; nyaste vinner — samma regel som
--  appen alltid haft, så ingen skrivning kan skriva över en nyare.
-- ---------------------------------------------------------------------
-- millisekunder sedan 1970 — samma tidsskala som appens Date.now()
create or replace function now_ms() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create table if not exists records (
  kind  text not null,
  id    text not null,
  data  jsonb not null,
  up    bigint not null default 0,
  del   boolean not null default false,
  /* ts = när SERVERN tog emot ändringen. Appen hämtar "allt nyare än ts",
     inte "allt nyare än up" — annars skulle en telefon som varit offline och
     skickar en ändring med äldre up aldrig nå de andra. */
  ts    bigint not null default now_ms(),
  primary key (kind, id)
);
-- v8: media = galleriet. Regeln byts ut så att en äldre installation får det nya värdet.
alter table records drop constraint if exists records_kind_check;
alter table records add constraint records_kind_check check (kind in ('booking','circle','curriculum',
  'artist','release','beat','agenda','goal','plan','file','setting','media','course'));
create index if not exists records_up_idx on records (up);
create index if not exists records_ts_idx on records (ts);
create or replace function bs_touch() returns trigger language plpgsql as $$
begin new.ts := now_ms(); return new; end $$;
drop trigger if exists records_touch on records;
create trigger records_touch before insert or update on records for each row execute function bs_touch();


-- Ett pass som tidsintervall. Slut <= start betyder nattpass, alltså +1 dygn.
create or replace function bs_span(d jsonb) returns tsrange
language sql immutable as $$
  select tsrange(s, case when e <= s then e + interval '1 day' else e end)
  from (select ((d->>'date')||' '||(d->>'start'))::timestamp as s,
               ((d->>'date')||' '||(d->>'end'))::timestamp   as e) x
$$;

-- ---------------------------------------------------------------------
--  CIRKLARNA SOM VERKSAMHETSSYSTEM (2026-10)
-- ---------------------------------------------------------------------
/* Vem som varit med i vilken grupp och när. Fylls av en trigger på cirkelposten
   (03-funktioner.sql) — ingen skriver hit för hand. */
create table if not exists circle_membership (
  id         bigserial primary key,
  circle_id  text not null,
  member_id  text not null,
  joined     timestamptz not null default now(),
  left_at    timestamptz
);
create index if not exists circle_membership_idx on circle_membership (circle_id, member_id);

/* Anmälningar till studiecirklarna från foundation-formuläret (utan personnummer —
   de stannar i kalkylarket). Admin placerar dem i en grupp. */
create table if not exists circle_signups (
  id         text primary key,
  name       text not null,
  email      text,
  phone      text,
  subject    text,
  note       text,
  status     text not null default 'new' check (status in ('new','placed','rejected')),
  member_id  text,
  circle_id  text,
  handled_by text,
  created_at timestamptz not null default now()
);

/* Hemligheter som bara databasfunktionerna läser (t.ex. nyckeln foundation-sajten
   skickar anmälningar med). Ingen policy: ingen inloggad eller anonym når tabellen. */
create table if not exists bs_secrets (
  name  text primary key,
  value text not null
);

/* Passens kontroll: Planerat ('') och Genomfört ('done') står på passet. Kontrollerat och
   Rapporterat står här — bara admin skriver, via check_sessions / report_sessions. Ett pass
   som står här är låst (03: bs_guard_reported). Snapshot = det som rapporterades. */
create table if not exists session_reports (
  booking_id  text primary key,
  status      text not null check (status in ('checked','reported')),
  checked_by  text,
  checked_at  timestamptz,
  reported_by text,
  reported_at timestamptz,
  snapshot    jsonb
);
/* Historik över alla ändringar av cirkelpass och cirklar, och om upplåsningar. */
create table if not exists record_history (
  id      bigserial primary key,
  kind    text not null,
  rec_id  text not null,
  op      text not null,
  before  jsonb,
  after   jsonb,
  by_id   text,
  note    text,
  at      timestamptz not null default now()
);
create index if not exists record_history_idx on record_history (kind, rec_id, at);

-- ---------------------------------------------------------------------
--  BANDO REWARDS — artisten är kundkontot. Inga policys: allt går via
--  funktionerna i 03-funktioner.sql (de kontrollerar vem som får vad).
-- ---------------------------------------------------------------------
/* Behörigheter utöver rollen, t.ex. 'artist_intel' (Rewards, omdömen och CRM utan att vara admin). */
alter table members add column if not exists perms text[] not null default '{}';

/* Poängloggen: rader skrivs, ändras aldrig. Saldot är summan. */
create table if not exists points (
  id            bigserial primary key,
  member_id     text not null,
  booking_id    text,
  redemption_id bigint,
  kind          text not null check (kind in ('earn','reversal','redeem','refund','adjust')),
  points        int not null,
  note          text,
  by_id         text,
  at            timestamptz not null default now()
);
create index if not exists points_member_idx on points (member_id, at);
create index if not exists points_booking_idx on points (booking_id);

create table if not exists rewards (
  id          text primary key,
  title       text not null,
  description text,
  cost        int not null check (cost > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create table if not exists redemptions (
  id         bigserial primary key,
  member_id  text not null,
  reward_id  text,
  title      text not null,
  cost       int not null,
  status     text not null default 'waiting' check (status in ('waiting','delivered','cancelled')),
  by_id      text,
  at         timestamptz not null default now(),
  handled_by text,
  handled_at timestamptz
);
/* Nivåerna: kriterier i jsonb (minEarned, minSessions12, minHours12) — fler går att lägga till. */
create table if not exists levels (
  id       text primary key,
  name     text not null,
  rank     int not null,
  criteria jsonb not null default '{}',
  perks    text,
  active   boolean not null default true
);
create table if not exists level_history (
  id         bigserial primary key,
  member_id  text not null,
  level_id   text,
  level_name text,
  rank       int,
  at         timestamptz not null default now()
);
/* Producenternas interna omdömen efter ett pass — artisten ser dem aldrig. */
create table if not exists artist_notes (
  id         bigserial primary key,
  member_id  text not null,
  booking_id text,
  author_id  text,
  went       text,
  created    text,
  strengths  text,
  develop    text,
  next       text,
  other      text,
  created_at timestamptz not null default now()
);
create index if not exists artist_notes_idx on artist_notes (member_id, created_at);
/* Intern uppföljning per artist (CRM). */
create table if not exists artist_crm (
  member_id     text primary key,
  projects      text,
  goals         text,
  followup      date,
  followup_note text,
  updated_by    text,
  updated_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------
--  BANDO HQ ACCESS (2026-10) — registreringen bakom QR-koden
--  Den som registrerar sig blir kund OCH cirkeldeltagare. Personnumret ligger
--  krypterat i en egen tabell som bara funktionerna når (03-funktioner.sql).
-- ---------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

/* participant: kunden är också cirkeldeltagare (alla kunder är det; admin kan stänga av).
   interests: inriktningarna (id:n ur setting/access). registered_at/consent_at/source sätts
   bara av register_access — ingen ändrar dem på sig själv (02: bs_guard_member). */
alter table members add column if not exists participant   boolean not null default true;
alter table members add column if not exists interests     text[]  not null default '{}';
alter table members add column if not exists registered_at timestamptz;
alter table members add column if not exists consent_at    timestamptz;
alter table members add column if not exists source        text;

/* Personnumret, krypterat med nyckeln i Supabase Vault (bs_pnr_key). pnr_hash (HMAC med
   samma nyckel) är unik — så hittas dubbletter utan att något dekrypteras. birth (ÅÅMMDD)
   är det som syns maskerat. Ingen policy: bara funktionerna läser och skriver. Raderas
   med personen (on delete cascade). */
create table if not exists member_pnr (
  member_id  text primary key references members(id) on delete cascade,
  pnr_enc    bytea not null,
  pnr_hash   text not null unique,
  birth      text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  PRODUCENTER PER ARTIST (2026-10)
--  producers: de producenter (members.id) artisten kan boka med — admin väljer. producer
--  (en) finns kvar som huvudproducent och hålls lika med den första i listan. Admins och
--  managers som också producerar har behörigheten 'producer' i perms (03: bs_is_producer).
-- ---------------------------------------------------------------------
alter table members add column if not exists producers text[] not null default '{}';
update members set producers = array[producer]
 where coalesce(producer,'') <> '' and cardinality(producers) = 0;

-- ---------------------------------------------------------------------
--  ACCESS VIA FÖRFRÅGAN ELLER INBJUDAN (2026-10)
--  Ingen skapar längre ett konto direkt: man skickar en förfrågan (access_requests) som
--  admin eller en producent godkänner — eller blir inbjuden. Inbjudan (invites, roll kund)
--  leder till Access-sidan där kontot skapas (register_access kräver den).
-- ---------------------------------------------------------------------
create table if not exists access_requests (
  id         text primary key,
  name       text not null,
  email      text not null,
  phone      text,
  interests  text[] not null default '{}',
  message    text,
  status     text not null default 'new' check (status in ('new','approved','declined')),
  invite     text,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists access_requests_status_idx on access_requests (status, created_at);
alter table invites add column if not exists interests text[] not null default '{}';
alter table invites add column if not exists request_id text;


-- ---------------------------------------------------------------------
--  REWARDS: BONUSPOÄNG, KAMPANJER OCH VÄRVA EN VÄN (2026-10)
--  Bonusar (välkomst, första sessionen, återkommande, värvning) är egna rader i
--  poängloggen med en nyckel (ref) — samma bonus kan aldrig ges två gånger.
--  referred_by: kunden som bjöd in en vän; invites.referrer: inbjudan kommer från en kund.
-- ---------------------------------------------------------------------
alter table points add column if not exists ref text;
create unique index if not exists points_ref_uq on points (member_id, ref) where ref is not null;
alter table points drop constraint if exists points_kind_check;
alter table points add constraint points_kind_check check (kind in ('earn','reversal','redeem','refund','adjust','bonus'));
alter table members add column if not exists referred_by text;
alter table invites add column if not exists referrer text;
create index if not exists invites_referrer_idx on invites (referrer) where referrer is not null;

-- ---------------------------------------------------------------------
--  BANDO EDUCATION (2026-10)
--  200 läroplansmallar (innehållet: education/laroplaner.json; koderna: 06-education-katalog.sql)
--  som tilldelas cirkelledare. En tilldelning = en grupps arbete med EN mall; samma mall kan
--  användas av många grupper och ändras aldrig. Ledaren skriver två korta anteckningar per månad
--  och gruppens egen version av SV-arbetsplanen.
-- ---------------------------------------------------------------------
create table if not exists education_curricula (
  code          text primary key check (code ~ '^[A-Z]{2}[0-9]{2}$'),
  name          text not null,
  category_code text not null,
  category_name text not null,
  sort          int  not null default 0,
  version       text not null default '',
  active        boolean not null default true
);
create table if not exists education_assignments (
  id                text primary key,
  curriculum_code   text not null references education_curricula(code),
  leader_id         text not null references members(id) on delete cascade,
  group_label       text,
  start_date        date,
  status            text not null default 'active' check (status in ('active','ended')),
  sv_answers        jsonb,
  final_project_url text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  ended_at          timestamptz
);
create index if not exists education_assignments_leader_idx on education_assignments (leader_id, status);
create table if not exists education_monthly_notes (
  assignment_id text not null references education_assignments(id) on delete cascade,
  month_number  int  not null check (month_number between 1 and 6),
  learned       text,
  created       text,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  primary key (assignment_id, month_number)
);

-- ---------------------------------------------------------------------
--  STUDIOKONTROLL (2026-10) — en per pass, skickas in av passets producent
-- ---------------------------------------------------------------------
create table if not exists studio_checks (
  booking_id      text primary key,
  items           jsonb not null default '[]',          -- de punkter som bockades av
  missing         text[] not null default '{}',         -- de som inte gick (då finns en kommentar)
  comment         text,
  damage          boolean not null default false,
  damage_text     text,
  checked_by      text references members(id) on delete set null,
  checked_by_name text not null,
  booking_date    date,
  booking_start   text,
  studio          text,
  all_ok          boolean not null default true,
  submitted_at    timestamptz not null default now()
);
create index if not exists studio_checks_date_idx on studio_checks (booking_date);
