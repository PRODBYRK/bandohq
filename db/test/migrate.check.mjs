/* Uppgraderingen: dagens driftschema (projektmappen) och sedan de nya filerna ovanpå. */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'fs';
const [oldDir, newDir] = process.argv.slice(2);
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;`);
const files = ['01-schema.sql','02-rls.sql','03-funktioner.sql','04-notiser.sql'];
for (const f of files) await db.exec(readFileSync(oldDir + '/' + f, 'utf8'));
await db.exec(`insert into members(id,role,name,email) values('az','manager','AZ','az@b.se'),('rkay','producer','RKAY','r@b.se'),('k1','customer','Kund','k@b.se');
  insert into records(kind,id,data,up) values('booking','old1','{"id":"old1","studio":"A","date":"2030-01-01","start":"10:00","end":"14:00","who":"RKAY","status":""}',1);
  insert into members(id,role,name) values('lea','leader','Lea Ström'),('pa','participant','Pia Ask');
  insert into records(kind,id,data,up) values('circle','k1','{"id":"k1","n":"Prod 1","leader":"Lea Ström","members":["pa"]}',1),
    ('booking','cb1','{"id":"cb1","studio":"A","date":"2030-02-01","start":"10:00","end":"13:00","who":"Lea Ström","circleId":"k1","status":""}',1);
  insert into push_subs(member_id,endpoint,p256dh,auth) values('rkay','https://push.example/x','${'k'.repeat(87)}','${'a'.repeat(22)}');`);
await db.exec(`update members set producer='rkay' where id='k1'`);
for (const f of files) await db.exec(readFileSync(newDir + '/' + f, 'utf8'));
const r = (await db.query(`select pg_get_function_arguments(p.oid) a from pg_proc p where proname='request_customer_slot'`)).rows;
const pol = (await db.query(`select policyname from pg_policies where tablename='members' order by 1`)).rows.map(x=>x.policyname);
const kept = (await db.query(`select count(*)::int n from records where id='old1'`)).rows[0].n;
const anonExec = (await db.query(`select has_function_privilege('anon','bs_any_free(tsrange,text)','execute') a, has_function_privilege('authenticated','bs_studio_opt(text)','execute') b`)).rows[0];
console.log(JSON.stringify({request_customer_slot:r.map(x=>x.a), policies:pol, kept, anonExec}));
const web = (await db.query(`select kind from push_subs where endpoint='https://push.example/x'`)).rows[0];
const fns = (await db.query(`select proname from pg_proc where proname in ('save_device_token','delete_my_account','bs_erase_member') order by 1`)).rows.map(x=>x.proname);
const circ = (await db.query(`select proname from pg_proc where proname in ('bs_check_circle_session','circle_plan_check','place_signup','update_circle_session') order by 1`)).rows.length;
const tabs = (await db.query(`select count(*)::int n from information_schema.tables where table_name in ('circle_membership','circle_signups','bs_secrets')`)).rows[0].n;
const back = (await db.query(`select data->>'leaderId' l from records where id='cb1'`)).rows[0].l;
const hist = (await db.query(`select count(*)::int n from circle_membership where circle_id='k1'`)).rows[0].n;
console.log(JSON.stringify({circ, tabs, back, hist}));
console.log(JSON.stringify({web, fns}));
/* Access: befintliga kunder blir deltagare, och nyckeln till personnumren finns */
const acc = (await db.query(`select participant, cardinality(interests) n from members where id='k1'`)).rows[0];
const key = (await db.query(`select length(value) n from bs_secrets where name='pnr_key'`)).rows[0];
console.log(JSON.stringify({acc, key}));
/* producenter per artist: kundens producent blev första i listan */
const prods = (await db.query(`select producers from members where id='k1'`)).rows[0].producers;
console.log(JSON.stringify({prods}));
const ok = JSON.stringify(prods)==='["rkay"]' && acc && acc.participant===true && acc.n===0 && key && key.n===64 && back==='lea' && hist===1 && circ===4 && tabs===3 && web && web.kind==='web' && fns.length===3 && r.length===1 && /p_studio text DEFAULT/.test(r[0].a) && pol.includes('members_crew_clients') && kept===1 && !anonExec.a && !anonExec.b;
console.log(ok ? '✓ uppgraderingen går igenom' : '✗ något saknas'); process.exit(ok?0:1);
