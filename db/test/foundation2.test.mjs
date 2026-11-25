/* BANDO FOUNDATION — fas 2 (ungdomar och workshops) mot riktig Postgres (PGlite) med RLS.
   Beslut 2026-11-25: B och de med protected_data ser ungdomarnas uppgifter; C ser bara namn och
   närvaro för sina aktiviteter; admin utan behörigheten ser bara antal. 24 månaders gallring.
   Medgivanden för foto och film via länk. Inget sms-tjänst — sms skickas från telefonen och loggas. */
import { boot, as, asAnon, boom } from './harness.mjs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?pass++:fail++; console.log((c?'PASS  ':'FAIL  ')+n+(!c&&x!==undefined?'   → '+JSON.stringify(x):'')); };
const head=t=>console.log('\n── '+t+' ──');
const db = await boot();
const q = async (s,p)=> (await db.query(s,p)).rows;
const one = async (s,p)=> (await q(s,p))[0];
const rpc = async (fn, args)=> { const keys = Object.keys(args||{});
  const r = await q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, keys.map(k=>args[k])); return r[0].v; };

const U = {};
for (const k of ['az','rkay','adrey','samuel','amir','joseph','kund']) U[k] = (await one(`insert into auth.users(email) values($1) returning id`,[k+'@b.se'])).id;
const M = (id,role,name,perms)=>q(`insert into members(id,user_id,role,name,email,perms) values($1,$2,$3,$4,$5,$6)`,[id,U[id],role,name,id+'@b.se',perms||[]]);
await M('az','manager','AZ',['foundation_admin']); await M('rkay','manager','RKAY',['foundation_admin','protected_data']);
await M('adrey','producer','ADREY'); await M('samuel','foundation','Samuel'); await M('amir','foundation','Amir'); await M('joseph','foundation','Joseph');
await M('kund','customer','Kim Kund');
await q(`insert into fd_memberships values('samuel','B','chief'),('amir','C','chief'),('joseph','A','chief')`);
const AZ=f=>as(db,U.az,f), RK=f=>as(db,U.rkay,f), SA=f=>as(db,U.samuel,f), AM=f=>as(db,U.amir,f), JO=f=>as(db,U.joseph,f), AD=f=>as(db,U.adrey,f);
const secret = (await one(`select value from bs_secrets where name='fd_intake'`)).value;
const D = n => { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };

head('ansökan från hemsidan');
ok('en hemlig nyckel skapades för hemsidan', /^[0-9a-f]{48}$/.test(secret));
ok('utan rätt nyckel: nej', /Obehörig/.test(await boom(()=>asAnon(db,()=>rpc('fd_apply',{p_secret:'fel',p_data:JSON.stringify({name:'Lisa Ung',email:'lisa@x.se'})})))||''));
const a1 = await asAnon(db,()=>rpc('fd_apply',{p_secret:secret,p_data:JSON.stringify({name:'Lisa Ung',email:'Lisa@X.se',phone:'070-111 22 33',
  area:'Tensta 163 64',role:'Artist',source:'Instagram',member:true,info:false,external_id:'web-1',message:'Program: Behind the Release'})}));
ok('ansökan kommer in (anonymt, med nyckeln)', a1.ok && /^fa_/.test(a1.id), a1);
const again = await asAnon(db,()=>rpc('fd_apply',{p_secret:secret,p_data:JSON.stringify({name:'Lisa Ung',email:'lisa@x.se'})}));
ok('samma person igen blir ingen dubblett', again.again===true && again.id===a1.id && (await one(`select count(*)::int n from fd_applicants`)).n===1);
const a2 = await asAnon(db,()=>rpc('fd_apply',{p_secret:secret,p_data:JSON.stringify({name:'Omar Ny',phone:'0702223344',origin:'workshop',external_id:'ws-9'})}));
ok('workshopanmälan (bara telefon) kommer in med källan workshop', (await one(`select origin, phone from fd_applicants where id=$1`,[a2.id])).origin==='workshop');
ok('anonyma kan inte läsa ansökningarna', !!(await boom(()=>asAnon(db,()=>q(`select 1 from fd_applicants`)))));
const nB = await q(`select title, body from fd_notifications where member_id='samuel' and kind='youth'`);
ok('B får en notis — utan namn', nB.length===2 && nB.every(n=>!/Lisa|Omar/.test(n.title+n.body)), nB);
const ob = await q(`select subject, body from outbox where member_id='samuel'`);
ok('även push/mejl via utkorgen saknar namn', ob.length===2 && ob.every(n=>!/Lisa|Omar/.test(n.subject+n.body)), ob);

head('vem ser ungdomarna');
ok('Samuel (B) ser båda', (await SA(()=>q(`select id from fd_applicants`))).length===2);
ok('RKAY (skyddade uppgifter) ser båda', (await RK(()=>q(`select id from fd_applicants`))).length===2);
ok('AZ (admin utan behörigheten) ser inga', (await AZ(()=>q(`select id from fd_applicants`))).length===0);
ok('Amir (C) ser inga', (await AM(()=>q(`select id from fd_applicants`))).length===0);
ok('Joseph (A) ser inga', (await JO(()=>q(`select id from fd_applicants`))).length===0);
ok('en studio-producent ser inga', (await AD(()=>q(`select id from fd_applicants`))).length===0);
const st = await AZ(()=>rpc('fd_youth_stats',{}));
ok('admin ser bara antal', +st.total===2 && +st.by_status.new===2, st);
ok('en vanlig medlem i C får inga antal', (await AM(()=>rpc('fd_youth_stats',{})))===null);
ok('AZ kan inte ändra en ungdom', (await AZ(()=>q(`update fd_applicants set note='x' returning id`))).length===0);

head('kontakt och samtalshistorik');
await SA(()=>q(`update fd_applicants set birth_year=2010, guardian_name='Maria Ung', guardian_phone='0709998877', assigned='samuel' where id=$1`,[a1.id]));
await SA(()=>q(`insert into fd_contact_log(applicant_id,kind,template_id,body,by_id) values($1,'sms','fm_first','Hej Lisa! …','samuel')`,[a1.id]));
ok('ett loggat sms gör ansökan Kontaktad', (await one(`select status from fd_applicants where id=$1`,[a1.id])).status==='contacted');
ok('historiken syns för B', (await SA(()=>q(`select kind from fd_contact_log where applicant_id=$1`,[a1.id]))).length===1);
ok('men inte för C eller admin utan behörigheten', (await AM(()=>q(`select 1 from fd_contact_log`))).length===0 && (await AZ(()=>q(`select 1 from fd_contact_log`))).length===0);
ok('man kan inte logga i någon annans namn', !!(await boom(()=>SA(()=>q(`insert into fd_contact_log(applicant_id,kind,body,by_id) values($1,'samtal','x','amir')`,[a1.id])))));
ok('mallarna finns för alla i Foundation', (await AM(()=>q(`select id from fd_templates order by sort`))).map(r=>r.id).join()==='fm_first,fm_invite,fm_follow,fm_consent');
await SA(()=>q(`update fd_templates set body = body || ' /Samuel', updated_by='samuel' where id='fm_follow'`));
ok('B redigerar sina mallar', /\/Samuel$/.test((await one(`select body from fd_templates where id='fm_follow'`)).body));
ok('C kan inte ändra B:s mallar', (await AM(()=>q(`update fd_templates set body='x', updated_by='amir' where id='fm_first' returning id`))).length===0);

head('aktiviteter: C planerar, B bjuder in, C tar närvaro');
const act = await AM(()=>one(`insert into fd_activities(dept,title,kind,date,start_time,end_time,place,capacity,created_by,lead_id)
  values('C','Workshop: beatmaking','workshop',$1,'14:00','18:00','Råsundavägen 102, Solna',20,'amir','amir') returning id`,[D(5)]));
ok('Amir (C) skapar en workshop', /^fac_/.test(act.id));
ok('alla i Foundation ser att den finns', (await JO(()=>q(`select title from fd_activities`))).length===1);
ok('A kan inte skapa en aktivitet åt C', !!(await boom(()=>JO(()=>q(`insert into fd_activities(dept,title,date,created_by) values('C','X',$1,'joseph')`,[D(3)])))));
const g1 = await AM(()=>one(`insert into fd_activity_groups(activity_id,name) values($1,'Grupp 1') returning id`,[act.id]));
await SA(()=>q(`insert into fd_participants(activity_id,applicant_id,invited_by,group_id) values($1,$2,'samuel',$3),($1,$4,'samuel',null)`,[act.id,a1.id,g1.id,a2.id]));
ok('Samuel (B) bjuder in två till workshopen', (await one(`select count(*)::int n from fd_participants`)).n===2);
ok('inbjudan gör dem Inbjudna', (await q(`select status from fd_applicants order by created_at`)).every(r=>r.status==='invited'));
ok('C kan inte bjuda in', !!(await boom(()=>AM(()=>q(`insert into fd_participants(activity_id,applicant_id,invited_by) values($1,$2,'amir')`,[act.id,a1.id])))));
const ro = await AM(()=>rpc('fd_roster',{p_activity:act.id}));
ok('C ser namn, grupp och svar för sin workshop', ro.length===2 && ro.some(r=>r.name==='Lisa Ung' && r.group_id===g1.id), ro);
ok('men inga kontaktuppgifter', ro.every(r=>!('phone' in r) && !('email' in r) && !('guardian_phone' in r)));
ok('A ser inte deltagarlistan', /finns inte/.test(await boom(()=>JO(()=>rpc('fd_roster',{p_activity:act.id})))||''));
await AM(()=>q(`update fd_participants set attendance='present', observation='Tog initiativ i gruppen' where applicant_id=$1`,[a1.id]));
await AM(()=>q(`update fd_participants set attendance='absent' where applicant_id=$1`,[a2.id]));
ok('C markerar närvaro: Lisa Har deltagit, Omar fortfarande Inbjuden', (await one(`select status from fd_applicants where id=$1`,[a1.id])).status==='attended'
   && (await one(`select status from fd_applicants where id=$1`,[a2.id])).status==='invited');
ok('B ser C:s observation', (await SA(()=>one(`select observation from fd_participants where applicant_id=$1`,[a1.id]))).observation==='Tog initiativ i gruppen');
ok('C kan inte ta bort en inbjudan', (await AM(()=>q(`delete from fd_participants where applicant_id=$1 returning 1`,[a2.id]))).length===0);
await AM(()=>q(`update fd_activities set status='done', follow_summary='Bra energi', follow_good='Grupperna', follow_improve='Mer tid' where id=$1`,[act.id]));
ok('uppföljningen sparas på aktiviteten', (await one(`select follow_improve from fd_activities where id=$1`,[act.id])).follow_improve==='Mer tid');

head('medgivande för foto och film via länk');
ok('C kan inte skapa medgivanden', /Bara B/.test(await boom(()=>AM(()=>rpc('fd_consent_create',{p_applicant:a1.id,p_signer:'guardian'})))||''));
const cs = await SA(()=>rpc('fd_consent_create',{p_applicant:a1.id,p_signer:'guardian'}));
ok('Samuel skapar en länk till målsman', /^[0-9a-f]{36}$/.test(cs.token), cs);
const inf = await asAnon(db,()=>rpc('fd_consent_info',{p_token:cs.token}));
ok('länken visar bara förnamnet', inf.ok && inf.first_name==='Lisa' && !JSON.stringify(inf).includes('Ung') && !JSON.stringify(inf).includes('070'), inf);
ok('en gissad länk ger inget', (await asAnon(db,()=>rpc('fd_consent_info',{p_token:'0'.repeat(36)}))).ok===false);
ok('måste kryssa i något för att godkänna', /Kryssa i/.test(await boom(()=>asAnon(db,()=>rpc('fd_consent_answer',{p_token:cs.token,p_name:'Maria Ung',p_approve:true,p_choices:'{}'})))||''));
await asAnon(db,()=>rpc('fd_consent_answer',{p_token:cs.token,p_name:'Maria Ung',p_approve:true,p_choices:JSON.stringify({photo:true,film:true,publish:false})}));
const c1 = await SA(()=>one(`select status, choices, answered_name from fd_consents where id=$1`,[cs.id]));
ok('målsman godkänner foto och film, inte publicering', c1.status==='approved' && c1.choices.photo && c1.choices.film && !c1.choices.publish && c1.answered_name==='Maria Ung', c1);
ok('Samuel får en notis om svaret', (await q(`select 1 from fd_notifications where member_id='samuel' and kind='consent'`)).length===1);
await asAnon(db,()=>rpc('fd_consent_answer',{p_token:cs.token,p_name:'Maria Ung',p_approve:false,p_choices:'{}'}));
ok('svaret kan ändras (återkallas) via samma länk', (await one(`select status from fd_consents where id=$1`,[cs.id])).status==='denied');
ok('C och admin utan behörigheten ser inte medgivandena', (await AM(()=>q(`select 1 from fd_consents`))).length===0 && (await AZ(()=>q(`select 1 from fd_consents`))).length===0);
await q(`update fd_consents set expires_at = now() - interval '1 day' where id=$1`,[cs.id]);
ok('en utgången länk går inte att använda', /gått ut/.test(await boom(()=>asAnon(db,()=>rpc('fd_consent_answer',{p_token:cs.token,p_name:'X Y',p_approve:false,p_choices:'{}'})))||''));

head('loggen och gallringen');
const lg = await RK(()=>q(`select kind, before, after from record_history where kind in ('fd.youth','fd.activity','fd.consent')`));
ok('loggen har händelserna — utan namn eller telefonnummer', lg.length>=8 && !JSON.stringify(lg).match(/Lisa|Omar|Maria|070|tensta/i), lg.length);
await q(`update fd_applicants set last_activity_at = now() - interval '25 months' where id=$1`,[a2.id]);
await q(`alter table fd_applicants disable trigger fd_applicant_stamp`);   /* stämpeln skulle annars sätta now() */
await q(`update fd_applicants set last_activity_at = now() - interval '25 months' where id=$1`,[a2.id]);
await q(`alter table fd_applicants enable trigger fd_applicant_stamp`);
ok('gallringen raderar den som varit inaktiv i mer än 24 månader', (await rpc('fd_purge_youth',{}))===1 && (await q(`select id from fd_applicants`)).map(r=>r.id).join()===a1.id);
ok('med deltagarrader och allt', (await one(`select count(*)::int n from fd_participants where applicant_id=$1`,[a2.id])).n===0);
ok('gallringen kan inte anropas av användare', !!(await boom(()=>SA(()=>rpc('fd_purge_youth',{})))));

head('studion är orörd');
ok('kunder och studio-producenter ser inget av detta', (await as(db,U.kund,()=>q(`select 1 from fd_activities`))).length===0 && (await AD(()=>q(`select 1 from fd_templates`))).length===0);

console.log('\n'+pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
