-- =====================================================================
--  BANDOHQ — utskick av notiserna: push först, SMS via 46elks som reserv
--  Kör EFTER att du:
--    1. slagit på pg_cron och pg_net (Database → Extensions)
--    2. lagt in edge-funktionen notify-send med sina secrets (se SETUP.md, steg 5)
--  Byt de två värdena nedan (samma som i CLOUD_CONFIG i index.html) och kör.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform vault.create_secret('https://DITT-PROJEKT.supabase.co', 'bandohq_url');
exception when others then null; end $$;
do $$ begin
  perform vault.create_secret('DIN-ANON-PUBLIC-NYCKEL', 'bandohq_anon');
exception when others then null; end $$;
-- Skrev du fel? Rätta så här:
--   update vault.secrets set secret = 'rätt värde' where name = 'bandohq_url';

-- Varje minut: skicka det som ligger i utkorgen (push, annars SMS).
select cron.schedule('bandohq-notiser', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bandohq_url') || '/functions/v1/notify-send',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bandohq_anon')),
    body := '{}'::jsonb)
$$);

-- Varje timme: påminnelser för morgondagens pass (gör något först från kl 17).
select cron.schedule('bandohq-paminnelser', '5 * * * *', $$ select sms_reminders_tick() $$);
