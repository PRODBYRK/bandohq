import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Riktig Postgres i WASM + det Supabase ger gratis: auth.users, auth.uid(), rollerna. */
export async function boot(){
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    grant usage on schema public, auth to anon, authenticated;
    grant select on auth.users to authenticated;
    /* Som Supabase: allt nytt i public får anon och authenticated rättigheter
       automatiskt. Därför måste interna funktioner stängas uttryckligen. */
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;`);
  for (const f of ['01-schema.sql','02-rls.sql','03-funktioner.sql','04-notiser.sql'])
    await db.exec(readFileSync(join(DIR, f), 'utf8'));
  return db;
}
export async function as(db, uid, fn){
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
}
export async function asAnon(db, fn){
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub','',false);`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
export async function boom(fn){ try { await fn(); return null; } catch(e){ return e.message; } }
