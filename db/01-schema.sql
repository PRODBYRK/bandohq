-- =====================================================================
--  BANDOHQ — schema
--  Kör i Supabase: SQL Editor → New query → klistra in → Run.
--  Ordning: 01-schema.sql, 02-rls.sql, 03-funktioner.sql, 04-sms.sql
--  (och 05-sms-utskick.sql när 46elks är klart). Alla går att köra om —
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

-- ---------------------------------------------------------------------
--  NYA KUNDER (utan konto)
--  En förfrågan från bokningssidan. Godkänd → bokning + kundinbjudan.
-- ---------------------------------------------------------------------
create table if not exists leads (
  id         text primary key,
  name       text not null,
  email      text,
  phone      text not null,
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

-- ---------------------------------------------------------------------
--  SMS-UTKORG
--  Allt som ska skickas köas här (04-sms.sql). Utskicket görs på servern
--  (05-sms-utskick.sql + edge-funktionen sms-send) — appen ser aldrig nyckeln.
--  dedupe_key gör att samma sak aldrig skickas två gånger.
-- ---------------------------------------------------------------------
create table if not exists sms_outbox (
  id         bigserial primary key,
  member_id  text,
  phone      text not null,
  body       text not null,
  kind       text not null,
  dedupe_key text not null unique,
  n          int not null default 1,
  send_after timestamptz not null default now(),
  sent_at    timestamptz,
  error      text,
  attempts   int not null default 0,
  cost       int,
  created_at timestamptz not null default now()
);
alter table sms_outbox add column if not exists claimed_at timestamptz;
-- v8.1: notisen går som push när personen har det påslaget, annars som SMS
alter table sms_outbox add column if not exists channel text;

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
create index if not exists sms_outbox_due_idx on sms_outbox (send_after) where sent_at is null;

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
  'artist','release','beat','agenda','goal','plan','file','setting','media'));
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
