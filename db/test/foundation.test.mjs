/* BANDO FOUNDATION — arbetsytan (fas 1) mot riktig Postgres (PGlite) med RLS.
   Klart-kriterierna: B läser inte C:s uppgifter, en överlämning syns för båda, admin ser allt
   utom skyddade uppgifter, TEST 1 (Joseph → B → Samuel) och TEST 8 (adminöversikten). */
import { boot, as, asAnon, boom } from './harness.mjs';
import { readFileSync } from 'fs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?pass++:fail++; console.log((c?'PASS  ':'FAIL  ')+n+(!c&&x!==undefined?'   → '+JSON.stringify(x):'')); };
const head=t=>console.log('\n── '+t+' ──');

const db = await boot();
/* briefernas startuppgifter (10) testas i foundation4 — här börjar uppgiftstabellen tom som förut */
await db.query(`delete from fd_tasks where seed is not null`);
const q = async (s,p)=> (await db.query(s,p)).rows;
const one = async (s,p)=> (await q(s,p))[0];
const rpc = async (fn, args)=> { const keys = Object.keys(args||{});
  const r = await q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, keys.map(k=>args[k]));
  return r[0].v; };
const rpcRow = async (fn, args)=> { const keys = Object.keys(args||{});
  return (await q(`select * from ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')})`, keys.map(k=>args[k])))[0]; };

/* ── personerna: studio-crewet (AZ, RKAY, ADREY) och Foundation (masterplanen) ── */
const user = async email => (await one(`insert into auth.users(email) values($1) returning id`,[email])).id;
const U = {};
for (const k of ['az','rkay','adrey','joseph','samuel','amir','adrian','jasmin','kund']) U[k] = await user(k+'@b.se');
const M = (id,role,name)=>q(`insert into members(id,user_id,role,name,email) values($1,$2,$3,$4,$5)`,[id,U[id],role,name,id+'@b.se']);
await M('az','manager','AZ'); await M('rkay','manager','RKAY'); await M('adrey','producer','ADREY');
await M('joseph','foundation','Joseph'); await M('samuel','foundation','Samuel'); await M('amir','foundation','Amir');
await M('adrian','foundation','Adrian'); await M('jasmin','foundation','Jasmin'); await M('kund','customer','Kim Kund');
await q(`insert into records(kind,id,data,up) values('booking','s1','{"id":"s1","studio":"A","date":"2027-01-10","start":"10:00","end":"13:00","who":"RKAY","status":""}',1)`);

head('driftsättningen');
/* filen körs igen vid varje driftsättning — nu finns AZ och RKAY, och de blir Foundation-admin */
const sql07 = readFileSync(new URL('../07-foundation.sql', import.meta.url), 'utf8');
await db.exec(sql07); await db.exec(sql07);
const admins = (await q(`select id from members where 'foundation_admin' = any(perms) order by id`)).map(r=>r.id);
ok('RKAY och AZ blir Foundation-admin (Nabbe och Costa när de finns), en gång', JSON.stringify(admins)==='["az","rkay"]', admins);
ok('perms har inga dubbletter efter två körningar', (await one(`select cardinality(perms) n from members where id='az'`)).n===1);
ok('tio avdelningar A–J, G utan chef', (await one(`select count(*)::int n, string_agg(code,'' order by sort) s, bool_and(has_chief) filter (where code='G') g from fd_departments`)).s==='ABCDEFGHIJ');
ok('G kan inte få en avdelningschef', /ingen avdelningschef/.test(await boom(()=>q(`insert into fd_memberships values('amir','G','chief')`))||''));
ok('bucketen är privat och tar inte video', await one(`select public=false and not ('video/mp4' = any(allowed_mime_types)) ok from storage.buckets where id='foundation'`).then(r=>r.ok));
ok('rollen foundation finns i bs_role', (await one(`select 'foundation'::bs_role::text r`)).r==='foundation');

head('admin lägger upp avdelningarna');
const C2 = f=>as(db,U.az,f), AZ = f=>as(db,U.az,f), JO = f=>as(db,U.joseph,f), SA = f=>as(db,U.samuel,f), AM = f=>as(db,U.amir,f),
      AD = f=>as(db,U.adrian,f), JA = f=>as(db,U.jasmin,f), RK = f=>as(db,U.rkay,f), ADREY = f=>as(db,U.adrey,f);
for (const [m,d,r] of [['joseph','A','chief'],['joseph','E','chief'],['samuel','B','chief'],['amir','C','chief'],['amir','G','member'],
                       ['adrian','D','chief'],['jasmin','F','chief'],['jasmin','J','chief']])
  await AZ(()=>rpc('fd_set_membership',{p_member:m,p_dept:d,p_role:r}));
ok('admin satte medlemskapen', (await one(`select count(*)::int n from fd_memberships`)).n===8);
ok('en vanlig medlem kan inte ändra medlemskap', /Bara Foundation-admin/.test(await boom(()=>SA(()=>rpc('fd_set_membership',{p_member:'samuel',p_dept:'C',p_role:'member'})))||''));
ok('en studio-manager utan Foundation-behörighet heller inte', /Bara Foundation-admin/.test(await boom(()=>ADREY(()=>rpc('fd_set_membership',{p_member:'adrey',p_dept:'C',p_role:'member'})))||''));
ok('medlemmar kan inte skriva direkt i tabellen', !!(await boom(()=>SA(()=>q(`insert into fd_memberships values('samuel','C','member')`)))));
const newId = await AZ(()=>rpc('fd_add_person',{p_name:'Nanna',p_email:'nanna@b.se',p_depts:JSON.stringify([{dept:'G',role:'member'}])}));
const nanna = await one(`select role::text, name from members where id=$1`,[newId]);
ok('admin lägger till en ny person med rollen foundation och avdelning', nanna.role==='foundation' && (await one(`select dept from fd_memberships where member_id=$1`,[newId])).dept==='G', nanna);
const inv = await AZ(()=>one(`select create_invite(p_role => 'foundation', p_circle => null, p_days => 14, p_max => 1, p_member => $1, p_url => 'https://www.bandohq.se/') v`,[newId]));
ok('inbjudan går ut med den befintliga create_invite', !!inv && !!inv.v);
const invMail = await one(`select subject, body, link from outbox where email='nanna@b.se' order by id desc limit 1`);
ok('mejlet säger Bando Foundation och länkar till #join', /medarbetare i Bando Foundation/.test(invMail.body) && invMail.link.endsWith('#join='+inv.v), invMail);
ok('en befintlig person (samma e-post) läggs inte till två gånger', (await AZ(()=>rpc('fd_add_person',{p_name:'X',p_email:'SAMUEL@b.se',p_depts:'[]'})))==='samuel');
ok('admin kan inte ge skyddad åtkomst utan att själv ha den', /Bara den som har behörigheten/.test(await boom(()=>AZ(()=>rpc('fd_set_perm',{p_member:'samuel',p_perm:'protected_data',p_on:true})))||''));
await q(`update members set perms = perms || '{protected_data}'::text[] where id='samuel'`);   /* given av ägaren i driften */
await AZ(()=>rpc('fd_set_perm',{p_member:'jasmin',p_perm:'foundation_admin',p_on:true}));
await AZ(()=>rpc('fd_set_perm',{p_member:'jasmin',p_perm:'foundation_admin',p_on:false}));
ok('admin ger och tar bort Foundation-admin', !(await one(`select 'foundation_admin' = any(perms) a from members where id='jasmin'`)).a);
await AZ(()=>rpc('set_member_perms',{p_member:'rkay',p_perms:JSON.stringify(['producer','protected_data'])}));
const rkp = (await one(`select perms from members where id='rkay'`)).perms;
ok('studions set_member_perms kan inte ge skyddad åtkomst och tar inte bort Foundation-admin', JSON.stringify(rkp)==='["foundation_admin","producer"]', rkp);
await AZ(()=>q(`update members set perms='{}' where id='rkay'`));
ok('inte heller en direkt uppdatering', JSON.stringify((await one(`select perms from members where id='rkay'`)).perms)==='["foundation_admin"]');
await AZ(()=>rpc('set_member_perms',{p_member:'rkay',p_perms:JSON.stringify(['artist_intel','producer'])}));
ok('studions egna behörigheter sätts som förut', JSON.stringify((await one(`select perms from members where id='rkay'`)).perms)==='["artist_intel","foundation_admin","producer"]');
ok('admin kan inte ta bort sin egen admin', /egen admin/.test(await boom(()=>AZ(()=>rpc('fd_set_perm',{p_member:'az',p_perm:'foundation_admin',p_on:false})))||''));

const meS = await SA(()=>rpc('fd_me',{}));
ok('fd_me: Samuel är chef i B, inte admin', meS.member && !meS.admin && meS.protected && JSON.stringify(meS.depts)==='[{"dept":"B","role":"chief"}]', meS);
const meAZ = await AZ(()=>rpc('fd_me',{}));
ok('fd_me: AZ är admin utan avdelning och utan skyddad åtkomst', meAZ.admin && meAZ.member && !meAZ.protected && meAZ.depts.length===0, meAZ);
ok('fd_me: en studio-producent har ingen åtkomst', (await ADREY(()=>rpc('fd_me',{}))).member===false);
const pplS = await SA(()=>rpc('fd_people',{}));
ok('fd_people: medlemmen ser Foundation-personerna utan e-post', pplS.some(p=>p.id==='joseph') && !pplS.some(p=>p.id==='adrey') && pplS.every(p=>p.email==null), pplS.map(p=>p.id));
const pplA = await AZ(()=>rpc('fd_people',{}));
ok('fd_people: admin ser också studions crew (för att lägga till) men inga kunder', pplA.some(p=>p.id==='adrey' && p.email) && !pplA.some(p=>p.id==='kund'));
ok('fd_people: tomt för den utan åtkomst', (await ADREY(()=>rpc('fd_people',{}))).length===0);

head('inbjudningslänk per avdelning (utan e-post)');
const link = await AZ(()=>rpc('fd_create_link',{p_dept:'B',p_days:30,p_max:null}));
ok('admin skapar en länk till avdelning B', /^[0-9A-F]{4}-[0-9A-F]{6}$/.test(link.token) && link.dept==='B', link);
ok('en vanlig medlem kan inte skapa länkar', /Bara Foundation-admin/.test(await boom(()=>SA(()=>rpc('fd_create_link',{p_dept:'B',p_days:30,p_max:null})))||''));
ok('inte heller en studio-producent', /Bara Foundation-admin/.test(await boom(()=>ADREY(()=>rpc('fd_create_link',{p_dept:'B',p_days:30,p_max:null})))||''));
const info = await asAnon(db,()=>rpc('invite_info',{p_token:link.token}));
ok('länken visas som en vanlig inbjudan (studions join-flöde)', !!info, info);
U.ny1 = await user('ny1@b.se'); U.ny2 = await user('ny2@b.se');
const r1 = await as(db,U.ny1,()=>rpc('redeem_invite',{p_token:link.token,p_name:'William Berg',p_username:'william'}));
const r2 = await as(db,U.ny2,()=>rpc('redeem_invite',{p_token:link.token.toLowerCase(),p_name:'Sara Ek',p_username:'sara.ek'}));
ok('två personer går med via samma länk och får rollen foundation', r1.role==='foundation' && r2.role==='foundation', [r1, r2]);
const memB = (await q(`select member_id, role from fd_memberships where dept='B' order by member_id`)).map(r=>r.member_id+':'+r.role);
ok('båda hamnar i avdelning B som medlemmar', memB.includes(r1.id+':member') && memB.includes(r2.id+':member') && memB.includes('samuel:chief'), memB);
const meNy = await as(db,U.ny1,()=>rpc('fd_me',{}));
ok('den nya personen har åtkomst till Foundation via avdelningen', meNy.member===true && meNy.admin===false && meNy.depts[0].dept==='B', meNy);
ok('den som skapade länken får en notis', (await q(`select 1 from fd_notifications where member_id='az' and kind='member'`)).length===2);
ok('och det loggas', (await q(`select 1 from record_history where kind='fd.membership' and op='gick med via länk'`)).length===2);
const lst = await AZ(()=>rpc('fd_links',{}));
ok('admin ser länken med antal som gått med', lst.length===1 && lst[0].uses===2 && lst[0].open===true, lst);
ok('medlemmar ser inte länkarna', (await SA(()=>rpc('fd_links',{}))).length===0 && (await SA(()=>q(`select 1 from fd_invite_links`))).length===0);
await AZ(()=>rpc('fd_close_link',{p_token:link.token}));
U.ny3 = await user('ny3@b.se');
ok('en stängd länk går inte att använda', /stängd/.test(await boom(()=>as(db,U.ny3,()=>rpc('redeem_invite',{p_token:link.token,p_name:'Sen Person',p_username:'sen'})))||''));
const one1 = await AZ(()=>rpc('fd_create_link',{p_dept:'C',p_days:7,p_max:1}));
await as(db,U.ny3,()=>rpc('redeem_invite',{p_token:one1.token,p_name:'Sen Person',p_username:'sen'}));
U.ny4 = await user('ny4@b.se');
ok('en engångslänk räcker till en person', /redan använd/.test(await boom(()=>as(db,U.ny4,()=>rpc('redeem_invite',{p_token:one1.token,p_name:'Fyra',p_username:'fyra'})))||''));
/* flera avdelningar: en länk till A och E, och en person som redan har ett konto använder en länk till */
const multi = await AZ(()=>rpc('fd_create_link',{p_dept:'e, a',p_days:30,p_max:null}));
ok('en länk kan gälla flera avdelningar', JSON.stringify(multi.depts)==='["A","E"]', multi);
ok('inbjudan säger avdelning A och E', /avdelning A och E/.test((await asAnon(db,()=>rpc('invite_info',{p_token:multi.token}))).team||''));
U.ny6 = await user('ny6@b.se');
const r6 = await as(db,U.ny6,()=>rpc('redeem_invite',{p_token:multi.token,p_name:'Multi Person',p_username:'multi'}));
ok('den som går med hamnar i båda avdelningarna', (await q(`select dept from fd_memberships where member_id=$1 order by dept`,[r6.id])).map(r=>r.dept).join()==='A,E');
ok('admin får en notis: Ny i avdelning A och E', (await q(`select 1 from fd_notifications where member_id='az' and title like 'Ny i avdelning A och E:%'`)).length===1);
const lkB = await AZ(()=>rpc('fd_create_link',{p_dept:'B',p_days:30,p_max:null}));
const j1 = await AM(()=>rpc('fd_join_link',{p_token:lkB.token}));
ok('Amir (redan i C och G) använder B-länken och är nu med i B också', JSON.stringify(j1.added)==='["B"]'
   && (await q(`select dept from fd_memberships where member_id='amir' order by dept`)).map(r=>r.dept).join()==='B,C,G', j1);
const j2 = await AM(()=>rpc('fd_join_link',{p_token:lkB.token}));
ok('samma länk igen: inget nytt, räknas inte två gånger', JSON.stringify(j2.added)==='[]' && (await one(`select uses from invites where token=$1`,[lkB.token])).uses===1);
await ADREY(()=>rpc('fd_join_link',{p_token:lkB.token}));
ok('en studio-producent utan avdelning kan gå med via länken', (await q(`select dept from fd_memberships where member_id='adrey'`)).map(r=>r.dept).join()==='B');
await AZ(()=>rpc('fd_close_link',{p_token:lkB.token}));
ok('en stängd länk går inte att använda med konto heller', /stängd/.test(await boom(()=>SA(()=>rpc('fd_join_link',{p_token:lkB.token})))||''));
ok('en studiolänk (inte Foundation) går inte att använda här', /finns inte/.test(await boom(()=>AM(()=>rpc('fd_join_link',{p_token:link.token.replace(/./,'Z')})))||''));
ok('utan inloggning: nej', !!(await boom(()=>asAnon(db,()=>rpc('fd_join_link',{p_token:multi.token})))));
await q(`delete from fd_memberships where (member_id='amir' and dept='B') or member_id in ('adrey',$1)`,[r6.id]);
/* personliga länkar till cheferna */
const pj = await AZ(()=>rpc('fd_create_personal_link',{p_label:'Josefine',p_depts:'H,I',p_chiefs:'H,I',p_days:30}));
ok('personlig länk: två avdelningar, chef i båda, en gång', JSON.stringify(pj.depts)==='["H","I"]' && JSON.stringify(pj.chiefs)==='["H","I"]' && pj.max_uses===1, pj);
ok('chef kan bara vara i länkens avdelningar', /Chef bara i länkens/.test(await boom(()=>AZ(()=>rpc('fd_create_personal_link',{p_label:'X Y',p_depts:'H',p_chiefs:'I',p_days:30})))||''));
ok('G har ingen chef', /G har ingen/.test(await boom(()=>AZ(()=>rpc('fd_create_personal_link',{p_label:'X Y',p_depts:'G',p_chiefs:'G',p_days:30})))||''));
ok('bara admin', /Bara Foundation-admin/.test(await boom(()=>SA(()=>rpc('fd_create_personal_link',{p_label:'X Y',p_depts:'B',p_chiefs:'',p_days:30})))||''));
U.ny7 = await user('ny7@b.se');
const r7 = await as(db,U.ny7,()=>rpc('redeem_invite',{p_token:pj.token,p_name:'Josefine Lind',p_username:'josefine'}));
ok('hon går med och blir chef i H och I', (await q(`select dept||':'||role x from fd_memberships where member_id=$1 order by dept`,[r7.id])).map(r=>r.x).join()==='H:chief,I:chief');
ok('länken går inte att använda igen', /redan använd/.test(await boom(()=>AM(()=>rpc('fd_join_link',{p_token:pj.token})))||''));
const pb = await AZ(()=>rpc('fd_create_personal_link',{p_label:'Ny B-chef',p_depts:'B',p_chiefs:'B',p_days:30}));
await JO(()=>rpc('fd_join_link',{p_token:pb.token}));
ok('B har redan en chef (Samuel): den nya blir medlem, Samuel är kvar', (await one(`select role from fd_memberships where member_id='joseph' and dept='B'`)).role==='member'
   && (await one(`select role from fd_memberships where member_id='samuel' and dept='B'`)).role==='chief');
await q(`insert into fd_memberships values('adrey','F','member')`);
await q(`update fd_memberships set role='member' where dept='F' and member_id='jasmin'`);
const pf = await AZ(()=>rpc('fd_create_personal_link',{p_label:'ADREY',p_depts:'F',p_chiefs:'F',p_days:30}));
const jf = await ADREY(()=>rpc('fd_join_link',{p_token:pf.token}));
ok('en medlem som får en personlig chefslänk blir chef', JSON.stringify(jf.added)==='["F"]' && (await one(`select role from fd_memberships where member_id='adrey' and dept='F'`)).role==='chief', jf);
ok('admin ser vem länken var till', (await AZ(()=>rpc('fd_links',{}))).some(l=>l.label==='Josefine' && l.uses===1));
await q(`delete from fd_memberships where member_id in ('adrey',$1) or (member_id='joseph' and dept='B')`,[r7.id]);
await q(`update fd_memberships set role='chief' where dept='F' and member_id='jasmin'`);
const stud = await C2(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:5}));
U.ny5 = await user('ny5@b.se');
const r5 = await as(db,U.ny5,()=>rpc('redeem_invite',{p_token:stud,p_name:'Prod Ny',p_username:'prodny'}));
ok('studions vanliga inbjudningar påverkas inte (ingen avdelning)', r5.role==='producer' && (await q(`select 1 from fd_memberships where member_id=$1`,[r5.id])).length===0);
await q(`delete from fd_memberships where member_id in ($1,$2,$3)`, [r1.id, r2.id, (await one(`select id from members where username='sen'`)).id]);

head('KRITERIUM 1a · B läser inte C:s uppgifter');
const tC = await AM(()=>one(`insert into fd_tasks(dept,title,description,assignee,created_by,due) values('C','Planera workshop i beatmaking','Lokal och schema','amir','amir',current_date+3) returning id`));
await AM(()=>q(`insert into fd_tasks(dept,title,created_by) values('C','Ta fram material till workshopen','amir')`));
const tB = await SA(()=>one(`insert into fd_tasks(dept,title,assignee,created_by,due) values('B','Ring de nya sökande','samuel','samuel',current_date+1) returning id`));
const cTasksForSamuel = await SA(()=>q(`select id from fd_tasks where dept='C'`));
ok('Samuel (B) läser 0 av C:s uppgifter', cTasksForSamuel.length===0, cTasksForSamuel);
ok('Samuel ser inte C:s uppgift ens med id', (await SA(()=>q(`select 1 from fd_tasks where id=$1`,[tC.id]))).length===0);
ok('Amir (C) läser C:s två uppgifter', (await AM(()=>q(`select 1 from fd_tasks where dept='C'`))).length===2);
ok('Amir läser inte B:s uppgift', (await AM(()=>q(`select 1 from fd_tasks where dept='B'`))).length===0);
ok('Samuel kan inte ändra C:s uppgift', (await SA(()=>q(`update fd_tasks set status='done' where id=$1 returning id`,[tC.id]))).length===0);
ok('Samuel kan inte skapa en uppgift i C', !!(await boom(()=>SA(()=>q(`insert into fd_tasks(dept,title,created_by) values('C','Smyg','samuel')`)))));
ok('och kan inte skapa i någon annans namn', !!(await boom(()=>SA(()=>q(`insert into fd_tasks(dept,title,created_by) values('B','Falsk','joseph')`)))));
ok('C:s kommentarstråd är stängd för B', /finns inte/.test(await boom(()=>SA(()=>rpc('fd_comments_thread',{p_owner_type:'task',p_owner_id:tC.id})))||''));
ok('en studio-producent utan avdelning ser inga uppgifter', (await ADREY(()=>q(`select 1 from fd_tasks`))).length===0);
ok('en kund ser inga uppgifter', (await as(db,U.kund,()=>q(`select 1 from fd_tasks`))).length===0);
ok('anonym kommer inte åt tabellen', !!(await boom(()=>asAnon(db,()=>q(`select 1 from fd_tasks`)))));

head('uppgifter · status, ansvarig, agenda och logg');
ok('Amir fick en notis om uppgiften han gav sig själv? nej', (await q(`select 1 from fd_notifications where member_id='amir'`)).length===0);
const tAssign = await AM(()=>one(`insert into fd_tasks(dept,title,assignee,created_by,due) values('C','Boka lokal för workshopen','amir','amir',current_date) returning id`));
await AZ(()=>q(`update fd_tasks set assignee='samuel' where id=$1`,[tAssign.id]));
ok('ny ansvarig (Samuel, i B) får en notis', (await q(`select title from fd_notifications where member_id='samuel' and ref_id=$1`,[tAssign.id])).length===1);
ok('och notisen går också ut som push/mejl via utkorgen', (await q(`select 1 from outbox where member_id='samuel' and kind='foundation'`)).length>=1);
ok('uppgiften syns i Samuels agenda trots att den hör till C', (await SA(()=>q(`select id from fd_tasks where assignee='samuel' and due is not null`))).map(r=>r.id).includes(tAssign.id));
ok('men Samuel ser fortfarande inte C:s övriga uppgifter', (await SA(()=>q(`select 1 from fd_tasks where dept='C'`))).length===1);
for (const s of ['doing','waiting','done']) await AM(()=>q(`update fd_tasks set status=$1 where id=$2`,[s,tC.id]));
const tc = await one(`select status, done_at is not null d from fd_tasks where id=$1`,[tC.id]);
ok('Att göra → Pågår → Väntar → Klar, med tidpunkt', tc.status==='done' && tc.d);
ok('ogiltig status nekas', !!(await boom(()=>AM(()=>q(`update fd_tasks set status='kanske' where id=$1`,[tC.id])))));
await AM(()=>q(`update fd_tasks set created_by='joseph' where id=$1`,[tC.id]));
ok('skaparen kan inte skrivas om', (await one(`select created_by from fd_tasks where id=$1`,[tC.id])).created_by==='amir');
const tlog = await q(`select op from record_history where kind='fd.task' and rec_id=$1 order by id`,[tC.id]);
ok('granskningsloggen har skapad + tre statusbyten', JSON.stringify(tlog.map(r=>r.op))==='["skapad","status","status","status"]', tlog);

head('KRITERIUM 1b + TEST 1 · Joseph registrerar en ungdomsverksamhet och lämnar över till B');
const org = await JO(()=>one(`insert into fd_contacts(dept,kind,name,contact_person,phone,area,status,note,next_step,created_by)
  values('A','org','Fritidsgården Tensta','Lina Berg','070-123 45 67','Tensta','Intresserad','Vill ha en workshop för sina ungdomar','B kontaktar ungdomarna','joseph') returning id`));
ok('Joseph registrerade verksamheten i A', !!org.id);
ok('B ser inte A:s kontakt innan överlämningen', (await SA(()=>q(`select 1 from fd_contacts where id=$1`,[org.id]))).length===0);
ok('Joseph kan inte lämna över från en avdelning han inte är med i', /din avdelning/.test(await boom(()=>JO(()=>rpc('fd_handover_send',{p_from_dept:'C',p_to_dept:'B',p_to_member:'samuel',p_subject:'x'})))||''));
ok('mottagaren måste vara med i mottagande avdelning', /inte med i avdelning B/.test(await boom(()=>JO(()=>rpc('fd_handover_send',{p_from_dept:'A',p_to_dept:'B',p_to_member:'amir',p_subject:'x'})))||''));
const before = +(await one(`select count(*) n from outbox where member_id='samuel'`)).n;
const h = await JO(()=>rpcRow('fd_handover_send',{p_from_dept:'A',p_to_dept:'B',p_to_member:'samuel',p_subject:'Fritidsgården Tensta vill vara med',
  p_background:'Träffade personalen i tisdags, sex ungdomar är intresserade av Behind the Release.',p_expected:'Kontakta ungdomarna och bjud in till en workshop.',
  p_due:new Date(Date.now()+5*864e5).toISOString().slice(0,10),p_contact:org.id}));
ok('överlämningen skapades med status Skickad', h && h.status==='sent' && h.from_member==='joseph' && h.to_member==='samuel', h);
const sn = await SA(()=>q(`select title, body, ref_type, ref_id, read_at from fd_notifications where ref_id=$1`,[h.id]));
ok('Samuel får en notis i appen', sn.length===1 && /Överlämning från A/.test(sn[0].title) && sn[0].read_at===null, sn);
const ob = await q(`select subject, link, kind from outbox where member_id='samuel' order by id desc limit 1`);
ok('och via den befintliga utkorgen (push/mejl) med länk till ärendet', +(await one(`select count(*) n from outbox where member_id='samuel'`)).n===before+1
  && ob[0].kind==='foundation' && ob[0].link.endsWith('#handover-'+h.id), ob);
ok('Joseph (avsändaren) ser överlämningen: Skickad, väntar på mottagaren', (await JO(()=>one(`select status from fd_handovers where id=$1`,[h.id]))).status==='sent');
ok('Samuel (mottagaren) ser samma ärende', (await SA(()=>one(`select status from fd_handovers where id=$1`,[h.id]))).status==='sent');
ok('B ser nu verksamheten genom överlämningen', (await SA(()=>q(`select name from fd_contacts where id=$1`,[org.id])))[0]?.name==='Fritidsgården Tensta');
ok('men B kan inte ändra A:s kontakt', (await SA(()=>q(`update fd_contacts set status='x' where id=$1 returning id`,[org.id]))).length===0);
ok('Adrian (D) ser inte överlämningen', (await AD(()=>q(`select 1 from fd_handovers where id=$1`,[h.id]))).length===0);
ok('och inte kontakten', (await AD(()=>q(`select 1 from fd_contacts where id=$1`,[org.id]))).length===0);
ok('avsändaren kan inte bekräfta sin egen överlämning', /Bara mottagande/.test(await boom(()=>JO(()=>rpc('fd_handover_receive',{p_id:h.id})))||''));
ok('Adrian kan inte bekräfta den', /finns inte/.test(await boom(()=>AD(()=>rpc('fd_handover_receive',{p_id:h.id})))||''));
ok('ingen kan skriva status direkt i tabellen', (await SA(()=>q(`update fd_handovers set status='done' where id=$1 returning id`,[h.id]).catch(()=>[]))).length===0);
ok('Pågår går inte innan mottagandet är bekräftat', /Ta emot/.test(await boom(()=>SA(()=>rpc('fd_handover_status',{p_id:h.id,p_status:'in_progress'})))||''));
const rec = await SA(()=>rpcRow('fd_handover_receive',{p_id:h.id}));
ok('Samuel bekräftar mottagandet → Mottagen', rec.status==='received' && rec.received_by==='samuel' && !!rec.received_at);
ok('Joseph ser Mottagen', (await JO(()=>one(`select status, received_by from fd_handovers where id=$1`,[h.id]))).status==='received');
ok('Samuel ser Mottagen', (await SA(()=>one(`select status from fd_handovers where id=$1`,[h.id]))).status==='received');
ok('Joseph får en notis om att den är mottagen', (await JO(()=>q(`select title from fd_notifications where ref_id=$1`,[h.id]))).some(n=>/^Mottagen/.test(n.title)));
ok('det går inte att bekräfta två gånger', /redan mottagen/.test(await boom(()=>SA(()=>rpc('fd_handover_receive',{p_id:h.id})))||''));
ok('det är ett ärende, ingen kopia', (await one(`select count(*)::int n from fd_handovers`)).n===1);

head('kommentarer, omnämnanden och dokument på ärendet');
const ct = await SA(()=>rpc('fd_comments_thread',{p_owner_type:'handover',p_owner_id:h.id}));
ok('samma kommentarstråd för båda', ct===await JO(()=>rpc('fd_comments_thread',{p_owner_type:'handover',p_owner_id:h.id})));
await SA(()=>rpc('fd_post',{p_thread:ct,p_body:'@Joseph tack! Ringer Lina i morgon. @Adrian kolla gärna artister.',p_mentions:JSON.stringify(['joseph','adrian'])}));
ok('Joseph (omnämnd) får en notis', (await q(`select 1 from fd_notifications where member_id='joseph' and kind='mention'`)).length===1);
ok('Adrian kan inte läsa ärendet och nämns därför inte', (await q(`select 1 from fd_notifications where member_id='adrian'`)).length===0
  && (await q(`select member_id from fd_mentions`)).map(r=>r.member_id).join()==='joseph');
ok('Joseph läser kommentaren', (await JO(()=>q(`select body from fd_messages where thread_id=$1`,[ct]))).length===1);
ok('Adrian läser den inte', (await AD(()=>q(`select 1 from fd_messages where thread_id=$1`,[ct]))).length===0);
await JO(()=>rpc('fd_post',{p_thread:ct,p_body:'Toppen!',p_mentions:'[]'}));
ok('en kommentar utan omnämnande går till den andra parten', (await q(`select 1 from fd_notifications where member_id='samuel' and kind='comment'`)).length===1);
await JO(()=>q(`insert into fd_documents(owner_type,owner_id,dept,kind,name,url,uploaded_by) values('handover',$1,'A','link','Film från besöket (Drive)','https://drive.google.com/x','joseph')`,[h.id]));
ok('video som länk på överlämningen', (await SA(()=>q(`select name from fd_documents where owner_id=$1`,[h.id]))).length===1);
ok('länken måste vara http(s)', !!(await boom(()=>JO(()=>q(`insert into fd_documents(owner_type,owner_id,kind,name,url,uploaded_by) values('handover',$1,'link','x','javascript:alert(1)','joseph')`,[h.id])))));
/* fil: först objektet i Storage, sedan raden — sökvägen bestämmer vad filen hör till */
const path = `handover/${h.id}/presentation.pdf`;
await JO(()=>q(`insert into storage.objects(bucket_id,name,owner) values('foundation',$1,$2)`,[path,U.joseph]));
await JO(()=>q(`insert into fd_documents(owner_type,owner_id,dept,kind,name,storage_path,mime,size,uploaded_by) values('handover',$1,'A','file','Presentation.pdf',$2,'application/pdf',120000,'joseph')`,[h.id,path]));
ok('Samuel läser filen i Storage', (await SA(()=>q(`select 1 from storage.objects where name=$1`,[path]))).length===1);
ok('Adrian läser den inte', (await AD(()=>q(`select 1 from storage.objects where name=$1`,[path]))).length===0);
ok('Adrian kan inte ladda upp till ärendet', !!(await boom(()=>AD(()=>q(`insert into storage.objects(bucket_id,name) values('foundation',$1)`,[`handover/${h.id}/smyg.pdf`])))));
ok('en uppladdning till C:s uppgift nekas för B', !!(await boom(()=>SA(()=>q(`insert into storage.objects(bucket_id,name) values('foundation',$1)`,[`task/${tC.id}/x.pdf`])))));
ok('dokumentraden måste peka under ärendets sökväg', !!(await boom(()=>JO(()=>q(`insert into fd_documents(owner_type,owner_id,kind,name,storage_path,uploaded_by) values('handover',$1,'file','x','task/annan/x.pdf','joseph')`,[h.id])))));
ok('Samuel kan inte ta bort Josephs fil', (await SA(()=>q(`delete from storage.objects where name=$1 returning id`,[path]))).length===0);
ok('uppladdningen loggas', (await q(`select op from record_history where kind='fd.document'`)).map(r=>r.op).join()==='länk,uppladdad');

head('Pågår och Slutförd');
await SA(()=>rpc('fd_handover_status',{p_id:h.id,p_status:'in_progress'}));
ok('Joseph ser Pågår', (await JO(()=>one(`select status from fd_handovers where id=$1`,[h.id]))).status==='in_progress');
ok('avsändaren kan inte sätta status', /Bara mottagande/.test(await boom(()=>JO(()=>rpc('fd_handover_status',{p_id:h.id,p_status:'done'})))||''));
await SA(()=>rpc('fd_handover_status',{p_id:h.id,p_status:'done'}));
ok('Slutförd för båda', (await JO(()=>one(`select status from fd_handovers where id=$1`,[h.id]))).status==='done' && (await SA(()=>one(`select status, done_at from fd_handovers where id=$1`,[h.id]))).done_at);
const hl = await q(`select op from record_history where kind='fd.handover' and rec_id=$1 order by id`,[h.id]);
ok('loggen: skickad, mottagen, pågår, slutförd', JSON.stringify(hl.map(r=>r.op))==='["skickad","mottagen","status","status"]', hl);

head('överlämning till en avdelning (utan namngiven mottagare)');
const h2 = await JO(()=>rpcRow('fd_handover_send',{p_from_dept:'E',p_to_dept:'C',p_to_member:null,p_subject:'Företag erbjuder lokal för workshops',p_expected:'Ta ställning till lokalen'}));
ok('hela C får notisen', (await q(`select member_id from fd_notifications where ref_id=$1`,[h2.id])).map(r=>r.member_id).join()==='amir');
ok('och den väntar hos C', (await AM(()=>one(`select status from fd_handovers where id=$1`,[h2.id]))).status==='sent');
await AM(()=>rpc('fd_handover_receive',{p_id:h2.id}));
ok('den som tar emot blir mottagare', (await one(`select to_member from fd_handovers where id=$1`,[h2.id])).to_member==='amir');

head('meddelanden: privat, avdelningsgrupp och projekt');
const dm = await SA(()=>rpc('fd_open_thread',{p_kind:'dm',p_members:JSON.stringify(['amir']),p_title:''}));
ok('samma privata tråd öppnas igen', dm===await AM(()=>rpc('fd_open_thread',{p_kind:'dm',p_members:JSON.stringify(['samuel']),p_title:''})));
await SA(()=>rpc('fd_post',{p_thread:dm,p_body:'Hej Amir, kan vi ses om workshopen?',p_mentions:'[]'}));
ok('mottagaren får en notis', (await q(`select 1 from fd_notifications where member_id='amir' and kind='message'`)).length===1);
ok('admin läser INTE privata meddelanden', (await AZ(()=>q(`select 1 from fd_messages where thread_id=$1`,[dm]))).length===0);
ok('och ingen annan heller', (await JO(()=>q(`select 1 from fd_messages where thread_id=$1`,[dm]))).length===0);
const dB = await SA(()=>rpc('fd_dept_thread',{p_dept:'B'}));
await SA(()=>rpc('fd_post',{p_thread:dB,p_body:'Veckomöte torsdag',p_mentions:'[]'}));
ok('avdelningsgruppen läses av avdelningen', (await SA(()=>q(`select 1 from fd_messages where thread_id=$1`,[dB]))).length===1);
ok('men inte av C', (await AM(()=>q(`select 1 from fd_messages where thread_id=$1`,[dB]))).length===0);
ok('C kan inte skriva i B:s grupp', /finns inte/.test(await boom(()=>AM(()=>rpc('fd_post',{p_thread:dB,p_body:'hej',p_mentions:'[]'})))||''));
const pr = await JO(()=>rpc('fd_open_thread',{p_kind:'project',p_members:JSON.stringify(['samuel','amir']),p_title:'Behind the Release – workshopturné'}));
await JO(()=>rpc('fd_post',{p_thread:pr,p_body:'Första planeringen',p_mentions:'[]'}));
ok('projektets deltagare läser projektet', (await AM(()=>q(`select 1 from fd_messages where thread_id=$1`,[pr]))).length===1);
ok('andra läser det inte', (await AD(()=>q(`select 1 from fd_threads where id=$1`,[pr]))).length===0);
await AM(()=>q(`select fd_mark_read(null)`));
ok('notiser markeras lästa, bara de egna', (await q(`select count(*)::int n from fd_notifications where member_id='amir' and read_at is null`))[0].n===0
  && (await q(`select count(*)::int n from fd_notifications where member_id='samuel' and read_at is null`))[0].n>0);
ok('man läser bara sina egna notiser', (await SA(()=>q(`select distinct member_id from fd_notifications`))).map(r=>r.member_id).join()==='samuel');

head('avdelningsuppdateringen');
await SA(()=>rpc('fd_save_update',{p_dept:'B',p_working:'Ringer sökande från Tensta',p_done:'Tog emot överlämningen från A',p_help:'Fler som kan ringa',p_waiting:'Datum för workshop från C'}));
const upd = await AM(()=>one(`select working_on, waiting_for, updated_by from fd_dept_updates where dept='B'`));
ok('C läser B:s fyra fält', upd.working_on==='Ringer sökande från Tensta' && upd.waiting_for==='Datum för workshop från C' && upd.updated_by==='samuel', upd);
ok('C kan inte skriva B:s uppdatering', /Bara avdelningens/.test(await boom(()=>AM(()=>rpc('fd_save_update',{p_dept:'B',p_working:'x',p_done:'',p_help:'',p_waiting:''})))||''));
ok('en studio-producent läser den inte', (await ADREY(()=>q(`select 1 from fd_dept_updates`))).length===0);

head('KRITERIUM 1c · skyddade uppgifter');
const tP = await SA(()=>one(`insert into fd_tasks(dept,title,description,assignee,created_by,protected,due) values('B','Uppföljning: ungdom med särskilt stöd','Känsliga uppgifter','samuel','samuel',true,current_date+2) returning id`));
const hP = await SA(()=>rpcRow('fd_handover_send',{p_from_dept:'B',p_to_dept:'C',p_to_member:'amir',p_subject:'Anpassning för en deltagare',p_protected:true}));
ok('Samuel (behörighet för skyddade uppgifter) ser sin skyddade uppgift', (await SA(()=>q(`select 1 from fd_tasks where id=$1`,[tP.id]))).length===1);
ok('admin ser INTE den skyddade uppgiften', (await AZ(()=>q(`select 1 from fd_tasks where id=$1`,[tP.id]))).length===0);
ok('admin ser INTE den skyddade överlämningen', (await AZ(()=>q(`select 1 from fd_handovers where id=$1`,[hP.id]))).length===0);
ok('mottagaren utan behörigheten ser den inte heller', (await AM(()=>q(`select 1 from fd_handovers where id=$1`,[hP.id]))).length===0);
ok('en person utan behörigheten kan inte skapa skyddade rader', !!(await boom(()=>JO(()=>q(`insert into fd_tasks(dept,title,created_by,protected) values('A','x','joseph',true)`)))));
const plog = await q(`select after from record_history where rec_id in ($1,$2) and op in ('skapad','skickad')`,[tP.id,hP.id]);
ok('loggen bär inte skyddat innehåll (studions admin läser också loggen)', plog.length===2 && plog.every(r=>r.after.protected===true && !JSON.stringify(r.after).includes('särskilt stöd') && !JSON.stringify(r.after).includes('Anpassning')), plog);
const pnot = await q(`select title, body from fd_notifications where ref_id=$1 union all select subject, body from outbox where link like $2`,[hP.id,'%'+hP.id]);
ok('och notiserna (även push/mejl) nämner inte ämnet', pnot.length>=2 && pnot.every(n=>!/Anpassning/.test(n.title+n.body)), pnot);
const ctP = await SA(()=>rpc('fd_comments_thread',{p_owner_type:'handover',p_owner_id:hP.id}));
await SA(()=>rpc('fd_post',{p_thread:ctP,p_body:'Deltagaren behöver hörselskydd',p_mentions:JSON.stringify(['amir'])}));
const pc = await q(`select title, body from fd_notifications where member_id='amir' and kind='mention' order by id desc limit 1`);
ok('en kommentar i en skyddad tråd skickar inte texten i notisen', pc.length===0 || !/hörselskydd|Anpassning/.test(pc[0].title+pc[0].body), pc);
ok('skyddad kommentarstråd stängd för admin', /finns inte/.test(await boom(()=>AZ(()=>rpc('fd_comments_thread',{p_owner_type:'task',p_owner_id:tP.id})))||''));

head('TEST 8 · adminöversikten');
const tU = await AM(()=>one(`insert into fd_tasks(dept,title,created_by,due) values('C','Hitta workshopledare','amir',current_date+4) returning id`));
await JA(()=>q(`insert into fd_tasks(dept,title,created_by,assignee) values('J','Budget för våren','jasmin','jasmin')`));
const allTasks = await AZ(()=>q(`select dept, id from fd_tasks order by dept`));
const visibleNonProt = +(await one(`select count(*) n from fd_tasks where not protected`)).n;
ok('admin läser uppgifterna i alla avdelningar (utom skyddade)', allTasks.length===visibleNonProt && new Set(allTasks.map(r=>r.dept)).size===3, allTasks);
ok('admin läser alla överlämningar (utom skyddade)', (await AZ(()=>q(`select 1 from fd_handovers`))).length===2);
ok('admin läser projekten', (await AZ(()=>q(`select title from fd_threads where kind='project'`))).length===1);
ok('admin läser avdelningsgrupperna', (await AZ(()=>q(`select 1 from fd_messages where thread_id=$1`,[dB]))).length===1);
ok('RKAY (också Foundation-admin) läser samma', (await RK(()=>q(`select 1 from fd_tasks`))).length===visibleNonProt);
const ov = await AZ(()=>rpc('fd_overview',{p_days:14}));
const dC = ov.departments.find(d=>d.code==='C'), dB2 = ov.departments.find(d=>d.code==='B');
ok('status för alla tio avdelningar', ov.departments.length===10);
ok('C: chef, öppna och klara uppgifter', dC.chief==='Amir' && +dC.open===3 && +dC.done30===1, dC);
ok('B räknar inte den skyddade uppgiften', +dB2.open===1, dB2);
ok('avdelningsuppdateringen följer med', dB2.update.working_on==='Ringer sökande från Tensta');
ok('ärenden utan ansvarig', ov.unassigned.map(t=>t.id).includes(tU.id) && ov.unassigned.every(t=>!t.protected));
ok('datum som närmar sig (uppgifter och överlämningar)', ov.upcoming.some(u=>u.id===tU.id) && ov.upcoming.every(u=>u.id!==tP.id));
ok('väntande överlämningar (ingen just nu — den skyddade räknas inte)', ov.waiting_handovers.length===0, ov.waiting_handovers);
ok('översikten säger att skyddade rader är dolda', +ov.protected_hidden===2, ov.protected_hidden);
ok('vanliga medlemmar når inte översikten', /Bara Foundation-admin/.test(await boom(()=>SA(()=>rpc('fd_overview',{p_days:14})))||''));
const logKinds = (await AZ(()=>q(`select distinct split_part(kind,'.',2) k from record_history where kind like 'fd.%' order by 1`))).map(r=>r.k).join();
ok('admin läser granskningsloggen', logKinds.split(',').sort().join()==='document,handover,link,membership,perm,person,task,update', logKinds);
ok('en medlem läser den inte', (await SA(()=>q(`select 1 from record_history where kind like 'fd.%'`))).length===0);
ok('behörighetsändringar loggas med före och efter', (await q(`select 1 from record_history where kind='fd.perm' and rec_id='jasmin'`)).length===2);

head('studion är orörd');
ok('studiobokningen läses som förut av crewet', (await RK(()=>q(`select 1 from records where id='s1'`))).length===1);
ok('Foundation-personer ser inte studions poster', (await SA(()=>q(`select 1 from records`))).length===0);
ok('Foundation-personer kan inte anropa studions adminfunktioner', !!(await boom(()=>SA(()=>q(`select create_invite(p_role => 'producer', p_circle => null, p_days => 14, p_max => 1)`)))));

console.log('\n'+pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
