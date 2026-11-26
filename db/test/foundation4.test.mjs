/* BANDO FOUNDATION — avdelningarnas briefer och startuppgifter (10) mot riktig Postgres (PGlite) med RLS.
   Varje avdelning har en brief som alla i Foundation läser. Startuppgifterna går till rätt person
   när den går med (chef, medlems-id eller förnamn), med en samlad notis i stället för en per uppgift. */
import { boot, as, asAnon, boom } from './harness.mjs';
import { readFileSync } from 'fs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?pass++:fail++; console.log((c?'PASS  ':'FAIL  ')+n+(!c&&x!==undefined?'   → '+JSON.stringify(x).slice(0,600):'')); };
const head=t=>console.log('\n── '+t+' ──');
const db = await boot();
const q = async (s,p)=> (await db.query(s,p)).rows;
const one = async (s,p)=> (await q(s,p))[0];
const rpc = async (fn, args)=> { const keys = Object.keys(args||{});
  const r = await q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, keys.map(k=>args[k])); return r[0].v; };
const sql10 = readFileSync(new URL('../10-foundation-briefer.sql', import.meta.url), 'utf8');

const U = {};
for (const k of ['az','rkay','joseph','samuel','amir','nanna','hanna','jasmin','kund']) U[k] = (await one(`insert into auth.users(email) values($1) returning id`,[k+'@b.se'])).id;
const M = (id,role,name,perms)=>q(`insert into members(id,user_id,role,name,email,perms) values($1,$2,$3,$4,$5,$6)`,[id,U[id],role,name,id+'@b.se',perms||[]]);
await M('az','manager','AZ',['foundation_admin']); await M('rkay','manager','RKAY',['foundation_admin','protected_data']);
await M('joseph','foundation','Joseph'); await M('samuel','foundation','Samuel'); await M('amir','foundation','Amir Karimi');
await M('nanna','foundation','Nanna Svensson'); await M('hanna','foundation','Hanna'); await M('jasmin','foundation','Jasmin'); await M('kund','customer','Kim Kund');
/* som i produktion: RKAY finns när migreringen körs */
await q(`delete from fd_tasks where seed is not null`); await db.exec(sql10);
const AS = id => f => as(db, U[id], f);
const AZ=AS('az'), RK=AS('rkay'), JO=AS('joseph'), SA=AS('samuel'), AM=AS('amir'), NA=AS('nanna'), HA=AS('hanna'), KU=AS('kund');
const mine = id => q(`select seed from fd_tasks where assignee=$1 and seed is not null order by seed`,[id]).then(r=>r.map(x=>x.seed));
const notes = (id, kind) => q(`select title, body, ref_type, ref_id from fd_notifications where member_id=$1 and kind=$2`,[id,kind]);

head('briefer för alla tio avdelningar och en gemensam');
const ds = await q(`select code, brief from fd_departments order by sort`);
ok('alla tio avdelningar har en brief med uppdraget', ds.length===10 && ds.every(d => d.brief.length > 1500 && /## Uppdraget/.test(d.brief)), ds.map(d=>[d.code,d.brief.length]));
ok('A har arbetsområdena A1–A8 och läget nu', ['A1','A2','A3','A4','A5','A6','A7','A8'].every(x => ds[0].brief.includes('**'+x+' –')) && /Tre fritidsgårdar har fått mejl/.test(ds[0].brief));
ok('B har samtalsstödet och statusstegen', /Första samtalet/.test(ds[1].brief) && /Ny ansökan → Kontaktad/.test(ds[1].brief));
ok('C har koncepten 01–07 och de fem frågorna', ['01','02','03','04','05','06','07'].every(n => ds[2].brief.includes('**'+n+' ')) && /Fem frågor/.test(ds[2].brief));
ok('D har de fyra sätten att vara med', /Visa stöd/.test(ds[3].brief) && /Inspirationsmentor/.test(ds[3].brief));
ok('G har rollerna för Nanna, D2L, Rasmus och Amir', ['**Nanna**','**D2L**','**Rasmus (RKAY)**','**Amir**'].every(x => ds[6].brief.includes(x)));
ok('H har prioriteringarna och I har bidragen från 2 november', /Vilka möjligheter ser unga för sin framtid/.test(ds[7].brief) && /Gålöstiftelsen/.test(ds[8].brief));
const common = await one(`select value->>'text' t from fd_settings where key='brief'`);
ok('den gemensamma briefen finns (så arbetar vi i HQ)', common && /## Så arbetar vi i HQ/.test(common.t) && /WhatsApp/.test(common.t));

head('startuppgifterna');
const seeded = await q(`select dept, count(*)::int n, count(*) filter (where due is not null)::int d from fd_tasks where seed is not null group by dept order by dept`);
ok('varje avdelning har startuppgifter', seeded.length===10 && seeded.every(s => s.n >= 4), seeded);
ok('ingen startuppgift har en ansvarig innan någon gått med (utom RKAY:s, som inte finns i G/I än)',
   (await one(`select count(*)::int n from fd_tasks where seed is not null and assignee is not null`)).n===0);
ok('startuppgifterna har deadlines i agendan', (await one(`select count(*)::int n from fd_tasks where seed is not null and due is not null`)).n >= 30);
ok('skapade av RKAY', (await one(`select bool_and(created_by='rkay') ok from fd_tasks where seed is not null`)).ok===true);

head('chefen får avdelningens uppgifter när hen går med via sin personliga länk');
const lj = await AZ(()=>rpc('fd_create_personal_link',{p_label:'Joseph',p_depts:'A,E',p_chiefs:'A,E',p_days:30}));
await JO(()=>rpc('fd_join_link',{p_token:lj.token}));
const jo = await mine('joseph');
ok('Joseph får A:s och E:s chefsuppgifter', jo.filter(s=>s.startsWith('brief:A:')).length===8 && jo.filter(s=>s.startsWith('brief:E:')).length===7, jo);
ok('ingen notis per uppgift (Joseph gick med själv, så ingen notis alls)', (await notes('joseph','task')).length===0 && (await notes('joseph','brief')).length===0);
ok('uppgifterna syns i Josephs agenda (deadline och ansvarig)', (await JO(()=>q(`select count(*)::int n from fd_tasks where assignee='joseph' and due is not null`)))[0].n >= 10);
ok('loggen visar ny ansvarig', (await one(`select count(*)::int n from record_history where kind='fd.task' and op='ansvarig' and after->>'assignee'='joseph'`)).n===15);

head('förnamn: Amir får G:s strukturuppgift, Nanna sina');
const la = await AZ(()=>rpc('fd_create_personal_link',{p_label:'Amir',p_depts:'C,G',p_chiefs:'C',p_days:30}));
await AM(()=>rpc('fd_join_link',{p_token:la.token}));
const am = await mine('amir');
ok('Amir får C:s uppgifter och G:08 (förnamnet), inte Nannas', am.filter(s=>s.startsWith('brief:C:')).length===7 && am.includes('brief:G:08') && !am.includes('brief:G:01'), am);
const lg = await AZ(()=>rpc('fd_create_link',{p_dept:'G',p_days:30,p_max:10}));
await NA(()=>rpc('fd_join_link',{p_token:lg.token}));
ok('Nanna (Nanna Svensson) får sina tre via G-länken', JSON.stringify(await mine('nanna'))==='["brief:G:01","brief:G:02","brief:G:03"]', await mine('nanna'));
ok('D2L:s uppgift ligger kvar utan ansvarig för redaktionen', (await one(`select assignee from fd_tasks where seed='brief:G:04'`)).assignee===null);
ok('Nanna ser D2L:s uppgift och kan ta den', (await NA(()=>q(`update fd_tasks set assignee='nanna' where seed='brief:G:04' returning id`))).length===1);
await q(`update fd_tasks set assignee=null where seed='brief:G:04'`);

head('RKAY, som redan är med, och en chef som utses av admin');
await q(`insert into fd_memberships values('rkay','G','member'),('rkay','I','member')`);
const rk = await mine('rkay');
ok('RKAY får G:05–07 och I:01–03 (medlems-id), inte I:s chefsuppgift', JSON.stringify(rk)==='["brief:G:05","brief:G:06","brief:G:07","brief:I:01","brief:I:02","brief:I:03"]', rk);
ok('RKAY får en samlad notis per avdelning', (await notes('rkay','brief')).length===2 && (await notes('rkay','task')).length===0);
await AZ(()=>rpc('fd_set_membership',{p_member:'hanna',p_dept:'H',p_role:'chief'}));
const hn = await notes('hanna','brief');
ok('Hanna blir chef i H av admin: fem uppgifter och en notis, inga per uppgift', (await mine('hanna')).length===5 && hn.length===1 && (await notes('hanna','task')).length===0, hn);
ok('notisen länkar till briefen', hn[0] && hn[0].ref_type==='brief' && hn[0].ref_id==='H' && /5 startuppgifter/.test(hn[0].body), hn);
ok('och går som push/mejl med länk till briefen', (await one(`select count(*)::int n from outbox where member_id='hanna' and link like '%foundation.html#brief-H'`)).n===1);
await q(`update fd_tasks set status='done' where seed='brief:B:01'`);
const ls = await AZ(()=>rpc('fd_create_personal_link',{p_label:'Samuel',p_depts:'B',p_chiefs:'B',p_days:30}));
await SA(()=>rpc('fd_join_link',{p_token:ls.token}));
ok('en klar startuppgift delas inte ut', (await mine('samuel')).length===7 && !(await mine('samuel')).includes('brief:B:01'));
ok('Samuel får inte Josephs eller H:s uppgifter', (await mine('samuel')).every(s=>s.startsWith('brief:B:')));
ok('vanlig uppgift som admin tilldelar ger fortfarande en notis', await (async()=>{
  const t = await AZ(()=>one(`insert into fd_tasks(dept,title,created_by) values('B','Vanlig uppgift','az') returning id`));
  await AZ(()=>q(`update fd_tasks set assignee='samuel' where id=$1`,[t.id]));
  return (await notes('samuel','task')).length===1; })());

head('seed kan inte sättas eller ändras av användare');
const own = await SA(()=>one(`insert into fd_tasks(dept,title,created_by,seed,seed_for) values('B','Egen','samuel','brief:B:99','chief') returning seed, seed_for`));
ok('en användare kan inte skapa en startuppgift', own.seed===null && own.seed_for===null);
await SA(()=>q(`update fd_tasks set seed_for='samuel', seed='x' where seed='brief:B:02'`));
ok('och kan inte ändra en', !!(await one(`select 1 x from fd_tasks where seed='brief:B:02' and seed_for='chief'`)));

head('läsa och ändra briefen');
ok('Samuel (B) läser A:s brief', (await SA(()=>q(`select brief from fd_departments where code='A'`)))[0].brief.length > 1500);
ok('en kund läser ingen brief', (await KU(()=>q(`select brief from fd_departments`))).length===0);
ok('en kund läser inte den gemensamma briefen', (await KU(()=>q(`select key from fd_settings where key='brief'`))).length===0);
await JO(()=>rpc('fd_save_brief',{p_dept:'A',p_text:'## Uppdraget\nJosephs egen version'}));
const a2 = await one(`select brief, brief_updated_by from fd_departments where code='A'`);
ok('Joseph (chef i A) ändrar A:s brief', a2.brief==='## Uppdraget\nJosephs egen version' && a2.brief_updated_by==='joseph');
ok('Samuel kan inte ändra A:s brief', /Bara avdelningens chef/.test(await boom(()=>SA(()=>rpc('fd_save_brief',{p_dept:'A',p_text:'x'})))||''));
ok('Amir (chef i C) ändrar C:s brief', !(await boom(()=>AM(()=>rpc('fd_save_brief',{p_dept:'C',p_text:(ds[2].brief)})))));
await NA(()=>rpc('fd_save_brief',{p_dept:'G',p_text:ds[6].brief + '\nNannas tillägg'}));
ok('alla i G (utan chef) kan ändra G:s brief', /Nannas tillägg/.test((await one(`select brief from fd_departments where code='G'`)).brief));
ok('Joseph kan inte ändra G:s brief', !!(await boom(()=>JO(()=>rpc('fd_save_brief',{p_dept:'G',p_text:'x'})))));
ok('Joseph kan inte ändra den gemensamma', /Bara Foundation-admin/.test(await boom(()=>JO(()=>rpc('fd_save_brief',{p_dept:null,p_text:'x'})))||''));
await AZ(()=>rpc('fd_save_brief',{p_dept:null,p_text:common.t + '\nTillägg'}));
ok('admin ändrar den gemensamma', /Tillägg$/.test((await one(`select value->>'text' t from fd_settings where key='brief'`)).t));
ok('en för lång brief nekas', /för lång/.test(await boom(()=>AZ(()=>rpc('fd_save_brief',{p_dept:'J',p_text:'x'.repeat(40001)})))||''));
ok('ändringarna loggas utan texten', (await one(`select count(*)::int n, bool_and(after ? 'length' and not after ? 'brief') ok from record_history where kind='fd.brief'`)).n===4);
ok('anonyma kan inte anropa fd_save_brief', !!(await boom(()=>asAnon(db,()=>rpc('fd_save_brief',{p_dept:'A',p_text:'x'})))));
ok('fd_assign_seeded är inte öppen för inloggade', !!(await boom(()=>SA(()=>rpc('fd_assign_seeded',{p_member:'samuel',p_dept:'A'})))));

head('driftsättningen körs igen');
const before = await one(`select count(*)::int n from fd_tasks where seed is not null`);
await db.exec(sql10); await db.exec(sql10);
ok('inga dubbletter av startuppgifterna', (await one(`select count(*)::int n from fd_tasks where seed is not null`)).n===before.n);
ok('en ändrad brief skrivs inte över', (await one(`select brief from fd_departments where code='A'`)).brief==='## Uppdraget\nJosephs egen version');
ok('den gemensamma skrivs inte över', /Tillägg$/.test((await one(`select value->>'text' t from fd_settings where key='brief'`)).t));
ok('ingen ny notis till dem som redan fått sina', (await notes('rkay','brief')).length===2 && (await notes('hanna','brief')).length===1);

console.log(`\n${pass} PASS · ${fail} FAIL`); console.log(fail ? '✗ TRASIGT' : '✓ ALLT GRÖNT'); process.exit(fail ? 1 : 0);
