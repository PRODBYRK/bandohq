import { boot, as, asAnon, boom } from './harness.mjs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?pass++:fail++; console.log((c?'PASS  ':'FAIL  ')+n+(!c&&x!==undefined?'   → '+JSON.stringify(x):'')); };
const head=t=>console.log('\n── '+t+' ──');

const db = await boot();
const q = async (s,p)=> (await db.query(s,p)).rows;
const one = async (s,p)=> (await q(s,p))[0];
const rpc = async (fn, args)=> { const keys = Object.keys(args||{});
  const r = await q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, keys.map(k=>args[k]));
  return r[0].v; };

/* ── seed som superuser ── */
const user = async email => (await one(`insert into auth.users(email) values($1) returning id`,[email])).id;
const U = {};
for (const [k,e] of [['az','az@b.se'],['rkay','rkay@b.se'],['sofia','sofia@b.se'],['will','will@b.se'],
                     ['nora','nora@b.se'],['kund','kund@b.se']]) U[k] = await user(e);
const M = (id,uid,role,name,email,phone)=>q(`insert into members(id,user_id,role,name,email,phone) values($1,$2,$3,$4,$5,$6)`,
  [id,uid,role,name,email,phone]);
await M('az',U.az,'manager','AZ','az@b.se','070-000 00 01');
await M('rkay',U.rkay,'producer','RKAY','rkay@b.se','070-000 00 02');
await M('adrey',null,'producer','ADREY','adrey@b.se','070-000 00 03');
await M('sofia',U.sofia,'leader','Sofia Marks','sofia@b.se','070-000 00 04');
await M('will',U.will,'participant','William Ek','will@b.se','070-000 00 05');
await M('nora',U.nora,'participant','Nora Lind','nora@b.se','070-000 00 06');
await M('kund',U.kund,'customer','Studio Nord AB','kund@b.se','070-000 00 10');
const R = (kind,id,data,up=1)=>q(`insert into records(kind,id,data,up) values($1,$2,$3,$4)`,[kind,id,JSON.stringify(data),up]);
await R('setting','studios',{A:'STUDIO A',B:'THE BOOTH'});
await R('curriculum','cu1',{id:'cu1',subject:'Musik',title:'Aktuell läroplan',body:'Mix'});
await R('circle','c1',{id:'c1',n:'Grupp 1',leader:'Sofia Marks',curriculumId:'cu1',members:['will']});
await R('circle','c2',{id:'c2',n:'Grupp 2',leader:'RKAY',curriculumId:'',members:['nora']});
const bk = (id,o)=>R('booking',id,Object.assign({id,studio:'A',date:'2026-11-10',start:'18:00',end:'21:00',who:'Sofia Marks',
  title:'x',circleId:'c1',status:'',hours:null,present:[],paid:false,with:[],artistId:''},o));
await bk('s1',{});
await bk('s2',{circleId:'c2',who:'RKAY',studio:'B'});
await bk('rqN',{circleId:'c1',status:'request',reqBy:'nora_x',studio:''});      // annan deltagares förfrågan
await bk('d1',{date:'2026-10-01',status:'done',hours:3,present:['will']});
await bk('d2',{date:'2026-09-01',circleId:'c2',who:'RKAY',status:'done',hours:2,present:['will']}); // gammal cirkel
await R('goal','g1',{id:'g1',owner:'rkay',text:'RKAYs mål'});
await R('goal','g2',{id:'g2',owner:'adrey',text:'ADREYs hemliga mål'});
await R('plan','adrey',{id:'adrey',text:'ADREYs plan'});

/* ============ CREW ============ */
head('crewet');
ok('producent läser posterna', (await as(db,U.rkay,()=>q(`select 1 from records where kind='booking'`))).length===5);
const ts0 = +(await one(`select max(ts) m from records`)).m;
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([{kind:'agenda',id:'offline',data:{id:'offline',text:'skrevs offline'},up:5,del:false}])}));
const off = await one(`select up, ts from records where id='offline'`);
ok('en gammal ändring (låg up) får ändå en ny serverstämpel', +off.up===5 && +off.ts>=ts0, off);
ok('producent ser sitt eget mål', (await as(db,U.rkay,()=>q(`select 1 from records where id='g1'`))).length===1);
ok('producent ser INTE andras mål', (await as(db,U.rkay,()=>q(`select 1 from records where id='g2'`))).length===0);
ok('producent ser INTE andras plan', (await as(db,U.rkay,()=>q(`select 1 from records where kind='plan'`))).length===0);
ok('managern ser allas mål och planer', (await as(db,U.az,()=>q(`select 1 from records where kind in ('goal','plan')`))).length===3);
const n1 = await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'booking',id:'s1',data:{id:'s1',title:'ÄLDRE'},up:0},
  {kind:'booking',id:'s2',data:{id:'s2',title:'NYARE',studio:'B',date:'2026-11-10',start:'18:00',end:'21:00'},up:99},
  {kind:'goal',id:'g2',data:{id:'g2',owner:'adrey',text:'kapat'},up:99},
  {kind:'artist',id:'a1',data:{id:'a1',n:'Nova'},up:5}])}));
ok('push: äldre post skriver inte över, okänd post läggs till', n1===2, n1);
ok('push: titeln på s1 orörd', (await one(`select data->>'title' t from records where id='s1'`)).t==='x');
ok('push: nyare post vinner', (await one(`select data->>'title' t from records where id='s2'`)).t==='NYARE');
ok('push: någon annans mål hoppas över, inte kapas', (await one(`select data->>'text' t from records where id='g2'`)).t==='ADREYs hemliga mål');
ok('crewet ser allas kontaktuppgifter', (await as(db,U.rkay,()=>q(`select phone from members`))).length===7);

/* ============ ICKE-CREW HAR INGEN TABELLÅTKOMST ============ */
head('ledare, deltagare, kund — ingen tabellåtkomst');
for (const [k,label] of [['sofia','ledaren'],['will','deltagaren'],['kund','kunden']]){
  ok(label+' kan inte läsa posterna direkt', (await as(db,U[k],()=>q(`select 1 from records`))).length===0);
  ok(label+' ser bara sin egen konto-rad', (await as(db,U[k],()=>q(`select id from members`))).length===1);
}
ok('deltagaren kan inte skriva poster direkt',
   (await boom(()=>as(db,U.will,()=>q(`insert into records(kind,id,data,up) values('booking','x','{}',1)`))))!==null);
await as(db,U.will,()=>q(`update members set role='manager', name='Hax' where id='will'`));
const w = await one(`select role,name from members where id='will'`);
ok('deltagaren kan inte befordra sig själv eller byta namn', w.role==='participant' && w.name==='William Ek', w);
await as(db,U.will,()=>q(`update members set phone='070-999 99 99' where id='will'`));
ok('men får ändra sitt telefonnummer', (await one(`select phone from members where id='will'`)).phone==='070-999 99 99');

/* ============ INBJUDNINGAR ============ */
head('inbjudningar');
ok('producent kan inte skapa inbjudan', /Bara admin och manager/.test(await boom(()=>as(db,U.rkay,()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:null})))||''));
ok('deltagarinbjudan kräver cirkel', /Välj vilken cirkel/.test(await boom(()=>as(db,U.az,()=>rpc('create_invite',{p_role:'participant',p_circle:null,p_days:14,p_max:null})))||''));
const tok = await as(db,U.az,()=>rpc('create_invite',{p_role:'participant',p_circle:'c1',p_days:14,p_max:2}));
ok('managern skapar en länk', /^[0-9A-F]{4}-[0-9A-F]{6}$/.test(tok), tok);
const info = await asAnon(db,()=>rpc('invite_info',{p_token:tok.toLowerCase()}));
ok('vem som helst kan se vad länken gäller', info.ok===true && info.role==='participant' && info.circle==='Grupp 1', info);
ok('anonym kan inte läsa inbjudningstabellen', (await asAnon(db,()=>q(`select 1 from invites`).catch(()=>[]))).length===0);
ok('producent kan inte läsa inbjudningstabellen', (await as(db,U.rkay,()=>q(`select 1 from invites`))).length===0);

const ny = await user('ny@b.se');
ok('nytt konto kan inte skapa sin egen roll direkt',
   (await boom(()=>as(db,ny,()=>q(`insert into members(id,user_id,role,name) values('x','${ny}','manager','Hax')`))))!==null);
ok('användarnamn krävs', /Välj ett användarnamn/.test(await boom(()=>as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo Native',p_username:'a'})))||''));
ok('bara a–z, 0–9 och . _ - i användarnamnet', /Välj ett användarnamn/.test(await boom(()=>as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo Native',p_username:'leo native'})))||''));
const red = await as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo Native',p_username:'Leo.N'}));
ok('inlösen ger rollen från länken', red.role==='participant' && red.name==='Leo Native' && red.username==='leo.n', red);
const leo = await one(`select * from members where user_id=$1`,[ny]);
ok('kontot får e-posten från inloggningen och användarnamnet i gemener, inget telefonkrav', leo.email==='ny@b.se' && leo.username==='leo.n' && leo.phone===null, leo);
ok('och läggs in i cirkeln automatiskt', (await one(`select data->'members' ? $1 as y from records where id='c1'`,[leo.id])).y===true);
ok('samma person kan inte lösa in igen', /redan ett konto/.test(await boom(()=>as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo 2',p_username:'leo2'})))||''));
const ny2 = await user('ny2@b.se'), ny3 = await user('ny3@b.se');
ok('upptaget namn nekas', /Namnet finns redan/.test(await boom(()=>as(db,ny2,()=>rpc('redeem_invite',{p_token:tok,p_name:'william ek',p_username:'maja'})))||''));
ok('upptaget användarnamn nekas, oavsett stora bokstäver', /upptaget/.test(await boom(()=>as(db,ny2,()=>rpc('redeem_invite',{p_token:tok,p_name:'Maja Sund',p_username:'LEO.N'})))||''));
ok('ledigt användarnamn syns utan inloggning', (await asAnon(db,()=>rpc('username_free',{p_username:'maja'})))===true
   && (await asAnon(db,()=>rpc('username_free',{p_username:'Leo.N'})))===false && (await asAnon(db,()=>rpc('username_free',{p_username:'x'})))===false);
await as(db,ny2,()=>rpc('redeem_invite',{p_token:tok,p_name:'Maja Sund',p_username:'maja'}));
ok('länken tar slut efter max antal', /redan använd/.test(await boom(()=>as(db,ny3,()=>rpc('redeem_invite',{p_token:tok,p_name:'Omar Khan',p_username:'omar'})))||''));
const tokL = await as(db,U.az,()=>rpc('create_invite',{p_role:'leader',p_circle:'c2',p_days:14,p_max:null}));
await as(db,ny3,()=>rpc('redeem_invite',{p_token:tokL,p_name:'Omar Khan',p_username:'omar'}));
ok('ledarinbjudan gör personen till cirkelns ledare', (await one(`select data->>'leader' l from records where id='c2'`)).l==='Omar Khan');
await q(`update invites set closed=true where token=$1`,[tokL]);
const ny4 = await user('ny4@b.se');
ok('stängd länk nekas', /stängd/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:tokL,p_name:'Ida Berg',p_username:'ida'})))||''));
const tokX = await as(db,U.az,()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:1,p_max:null}));
await q(`update invites set expires_at=now()-interval '1 hour' where token=$1`,[tokX]);
ok('utgången länk nekas', /gått ut/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:tokX,p_name:'Ida Berg',p_username:'ida'})))||''));
ok('okänd länk nekas', /finns inte/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:'AAAA-BBBBBB',p_name:'Ida Berg',p_username:'ida'})))||''));
await as(db,ny,()=>q(`update members set username='hax' where user_id='${ny}'`));
ok('man kan inte byta sitt eget användarnamn i efterhand', (await one(`select username from members where user_id=$1`,[ny])).username==='leo.n');
await q(`update records set data = data || '{"leader":"RKAY"}' where id='c2'`);   // tillbaka

/* ============ MY_VIEW ============ */
head('vad varje roll får se');
const pv = await as(db,U.will,()=>rpc('my_view',{}));
ok('deltagaren ser sin cirkel men inte andras', pv.circles.map(c=>c.id).join()==='c1', pv.circles.map(c=>c.id));
ok('och sin läroplan', pv.curricula.length===1);
ok('och cirkelns pass', pv.bookings.some(b=>b.id==='s1'));
ok('men inte en annan deltagares förfrågan', !pv.bookings.some(b=>b.id==='rqN'));
ok('timmar räknas även från cirklar man lämnat', +pv.hours.will===5, pv.hours);
ok('ledarens namn syns, men inte hens kontaktuppgifter', pv.people.length===1 && pv.people[0].name==='Sofia Marks' && !('phone' in pv.people[0]), pv.people);
const lv = await as(db,U.sofia,()=>rpc('my_view',{}));
ok('ledaren ser sin cirkel', lv.circles.map(c=>c.id).join()==='c1');
ok('ledaren ser förfrågningar i sin cirkel', lv.bookings.some(b=>b.id==='rqN'));
ok('ledaren ser sina medlemmars kontaktuppgifter', lv.people.some(p=>p.name==='William Ek' && p.phone==='070-999 99 99' && p.email==='will@b.se'), lv.people);
ok('men inte medlemmar i andras cirklar', !lv.people.some(p=>p.name==='Nora Lind'));
ok('ledaren ser andras pass som upptagen tid, utan namn', lv.busy.some(b=>b.id==='s2') && lv.busy.every(b=>!('who' in b) && !('title' in b)), lv.busy);
ok('men inte sin egen cirkels pass dubbelt', !lv.busy.some(b=>b.id==='s1'));
ok('och aldrig andras förfrågningar', !lv.busy.some(b=>b.id==='rqN'));
const kv = await as(db,U.kund,()=>rpc('my_view',{}));
ok('kunden ser upptagen tid utan namn och titel', kv.busy.length>0 && kv.busy.every(b=>!('who' in b) && !('title' in b)), kv.busy[0]);

/* ============ HANDLINGAR ============ */
head('handlingar');
const req = await as(db,U.will,()=>rpc('request_session',{p_circle:'c1',p_date:'2026-12-01',p_start:'18:00',p_end:'21:00'}));
ok('deltagaren föreslår en tid i sin cirkel', req.status==='request' && req.reqBy==='will' && req.who==='Sofia Marks', req);
ok('men inte i en annan cirkel', /inte med i/.test(await boom(()=>as(db,U.will,()=>rpc('request_session',{p_circle:'c2',p_date:'2026-12-01',p_start:'18:00',p_end:'21:00'})))||''));
ok('en deltagare kan inte svara på förfrågningar', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.will,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
ok('en annan ledare kan inte heller', /Bara cirkelns ledare/.test(await boom(()=>as(db,ny3,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
await bk('busy',{date:'2026-12-01',start:'17:00',end:'22:00',studio:'A',circleId:'',who:'RKAY'});
ok('godkännande mot upptagen studio nekas', /hann bli upptagen/.test(await boom(()=>as(db,U.sofia,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
const ap = await as(db,U.sofia,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'B'}));
ok('ledaren godkänner mot ledig studio', ap.status==='' && ap.studio==='B', ap);
ok('ledaren bokar ett pass själv', (await as(db,U.sofia,()=>rpc('book_circle_session',{p_circle:'c1',p_date:'2026-12-08',p_start:'18:00',p_end:'21:00',p_studio:'A'}))).status==='');
ok('men inte i en krockande tid', /upptagen/.test(await boom(()=>as(db,U.sofia,()=>rpc('book_circle_session',{p_circle:'c1',p_date:'2026-12-01',p_start:'19:00',p_end:'20:00',p_studio:'A'})))||''));
ok('närvaro för någon utanför cirkeln nekas', /inte med i cirkeln/.test(await boom(()=>as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:3,p_present:JSON.stringify(['nora'])})))||''));
ok('orimliga timmar nekas', /0,5 och 24/.test(await boom(()=>as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:40,p_present:JSON.stringify(['will'])})))||''));
const dn = await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:3,p_present:JSON.stringify(['will'])}));
ok('ledaren markerar genomförd', dn.status==='done' && +dn.hours===3 && dn.completedBy==='Sofia Marks', dn);
ok('och timmarna landar hos deltagaren', +(await as(db,U.will,()=>rpc('my_view',{}))).hours.will===8);
ok('deltagaren kan inte markera genomförd', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.will,()=>rpc('complete_session',{p_booking:'s1',p_hours:24,p_present:JSON.stringify(['will'])})))||''));
ok('kunden kan inte boka direkt längre', /förfrågan/.test(await boom(()=>as(db,U.kund,()=>rpc('book_customer_slot',{p_date:'2026-12-02',p_start:'10:00',p_end:'14:00',p_studio:'A'})))||''));
const cb = await as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-02',p_start:'10:00',p_end:'14:00',p_studio:'A',p_note:'Mix'}));
ok('kunden skickar en förfrågan, markerad betald', cb.paid===true && cb.who==='Studio Nord AB' && cb.status==='request', cb);
ok('kunden kan inte fråga om upptagen tid', /redan bokad/.test(await boom(()=>as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-01',p_start:'18:00',p_end:'19:00',p_studio:'A'})))||''));
ok('kunden kan inte avboka någon annans pass', /inte din/.test(await boom(()=>as(db,U.kund,()=>rpc('cancel_my_booking',{p_booking:'s1'})))||''));
ok('men sin egen', (await as(db,U.kund,()=>rpc('cancel_my_booking',{p_booking:cb.id}))).del===true);


{ /* eget block: v8-testerna återanvänder korta namn */
/* ============ v8 · ADMIN OCH KAMERA ============ */
head('v8: admin och kamerateam');
for (const [k,e] of [['costa','costa@b.se'],['moez','moez@b.se'],['d2la','d2la@b.se'],['d2lb','d2lb@b.se'],['ny5','ny5@b.se'],['ny6','ny6@b.se']]) U[k] = await user(e);
await M('costa',U.costa,'admin','Costa','costa@b.se','070-000 00 07');
await M('moez',U.moez,'camera','Moez','moez@b.se','070-000 00 08');
await M('d2la',U.d2la,'camera','D2L Alva','d2la@b.se','070-000 00 09');
await q(`update members set team='D2L' where id='d2la'`);
const C = fn => as(db,U.costa,fn), K = fn => as(db,U.moez,fn);
ok('admin läser schemat', (await C(()=>q(`select 1 from records where kind='booking'`))).length>0);
ok('admin ser INTE andras mål', (await C(()=>q(`select 1 from records where kind='goal'`))).length===0);
ok('admin ser inte andras planer', (await C(()=>q(`select 1 from records where kind='plan'`))).length===0);
ok('admin bjuder in en producent', /^[0-9A-F]{4}-/.test(await C(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:1})) ));
ok('men inte en manager', /Bara managern/.test(await boom(()=>C(()=>rpc('create_invite',{p_role:'manager',p_circle:null,p_days:14,p_max:1})))||''));
await C(()=>q(`update members set phone='070-222 22 22' where id='rkay'`));
ok('admin ändrar ett konto', (await one(`select phone from members where id='rkay'`)).phone==='070-222 22 22');
ok('admin kan inte göra någon till manager', /Bara managern/.test(await boom(()=>C(()=>q(`update members set role='manager' where id='rkay'`)))||''));
ok('admin kan inte ändra managern', /Bara managern/.test(await boom(()=>C(()=>q(`update members set phone='1' where id='az'`)))||''));
ok('admin kan inte lägga in en manager', !!(await boom(()=>C(()=>q(`insert into members(id,role,name) values('x9','manager','Ny Chef')`)))));
ok('admin kan inte göra sig själv till manager', !!(await boom(()=>C(()=>q(`update members set role='manager' where id='costa'`)))));
ok('kameran läser schemat', (await K(()=>q(`select 1 from records where kind='booking'`))).length>0);
ok('men inte mål eller cirklar', (await K(()=>q(`select 1 from records where kind in ('goal','plan','circle','curriculum')`))).length===0);
const km = (await K(()=>q(`select name from members`))).map(r=>r.name);
ok('kameran ser teamet men inte deltagare och kunder', km.includes('RKAY') && km.includes('D2L Alva') && !km.includes('William Ek') && !km.includes('Studio Nord AB'), km);
const kp = await K(()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'agenda',id:'ka1',data:{id:'ka1',kind:'week',who:'Moez',text:'Filma Nova'},up:9e12},
  {kind:'agenda',id:'ka2',data:{id:'ka2',kind:'week',who:'RKAY',text:'Kapa RKAY'},up:9e12},
  {kind:'booking',id:'kb1',data:{id:'kb1',studio:'A',date:'2026-12-20',start:'10:00',end:'11:00',who:'Moez'},up:9e12},
  {kind:'media',id:'md1',data:{id:'md1',by:'moez',team:'Moez',name:'nova.jpg'},up:9e12},
  {kind:'media',id:'md2',data:{id:'md2',by:'rkay',name:'fejk.jpg'},up:9e12}])}));
ok('kameran skriver sin agenda och sitt galleri — inget annat', kp===2 && !!(await one(`select 1 from records where id='ka1'`)) && !!(await one(`select 1 from records where id='md1'`)), kp);
ok('kameran kan inte boka pass', !(await one(`select 1 from records where id='kb1'`)));
ok('kameran ser inte utkorgen eller nya kunder', (await K(()=>q(`select 1 from outbox`))).length===0 && (await K(()=>q(`select 1 from leads`))).length===0);

/* ============ v8 · INTERNA FUNKTIONER ÄR STÄNGDA ============ */
head('v8: interna funktioner');
ok('en deltagare kan inte skriva pass förbi kontrollerna', /permission denied/.test(await boom(()=>as(db,U.will,()=>rpc('bs_put_booking',{d:JSON.stringify({id:'hack',studio:'A',date:'2026-12-24',start:'10:00',end:'11:00'})})))||''));
ok('inte heller köa egna mejl', /permission denied/.test(await boom(()=>as(db,U.will,()=>q(`select bs_notify('az','a@b.se','spam','spam','x','spam1')`)))||''));
ok('eller plocka ut utkorgen', /permission denied/.test(await boom(()=>C(()=>q(`select * from outbox_claim(10)`)))||''));
ok('ingen utanför servern kan slå upp e-post från ett användarnamn', /permission denied/.test(await boom(()=>asAnon(db,()=>q(`select bs_login_lookup('leo.n')`)))||'')
   && /permission denied/.test(await boom(()=>C(()=>q(`select bs_login_lookup('leo.n')`)))||'') && /permission denied/.test(await boom(()=>asAnon(db,()=>q(`select bs_login_fail('x')`)))||''));
ok('och ingen kan läsa misslyckade inloggningar', (await C(()=>q(`select 1 from login_fails`))).length===0);
ok('anonyma kan inte läsa timmar', /permission denied/.test(await boom(()=>asAnon(db,()=>q(`select bs_hours('will')`)))||''));

/* ============ v9 · NOTISER (mejl och push) ============ */
head('v9: notiser');
const ph = async p => (await one(`select bs_phone($1) v`,[p])).v;
ok('070-123 45 67 → +46701234567 (telefon är frivillig kontaktuppgift)', await ph('070-123 45 67')==='+46701234567');
ok('trasigt nummer blir null', await ph('070-7')===null && await ph('abc')===null);
ok('SMS-funktionerna finns inte längre', !(await one(`select 1 from pg_proc where proname in ('bs_sms','bs_gsm','sms_claim','sms_done','sms_stats','notify_policy')`)));
const box = async k => q(`select * from outbox where dedupe_key like $1 order by id`,[k]);
await q(`delete from outbox`);
const rq2 = await as(db,U.will,()=>rpc('request_session',{p_circle:'c1',p_date:'2026-12-08',p_start:'18:00',p_end:'21:00'}));
const rs = await box('req:'+rq2.id+'%');
ok('förfrågan → mejl till ledaren', rs.length===1 && rs[0].member_id==='sofia' && rs[0].email==='sofia@b.se'
   && /William Ek föreslår tis 8 dec 18:00-21:00/.test(rs[0].body) && /föreslår en tid för Grupp 1/.test(rs[0].subject), rs.map(r=>[r.subject,r.body]));
await as(db,U.sofia,()=>rpc('answer_request',{p_booking:rq2.id,p_approve:true,p_studio:'B'}));
const bkd = await box('booked:%');
const c1m = (await one(`select data->'members' m from records where id='c1'`)).m;
ok('godkänd → orderbekräftelse till alla i sessionen (ledaren och hela cirkeln)', bkd.map(r=>r.member_id).sort().join()===['sofia',...c1m].sort().join() && c1m.includes('will') && c1m.length===3, [bkd.map(r=>r.member_id), c1m]);
ok('bekräftelsen har tid och studio, och ämnet "Bokningsbekräftelse"', /tis 8 dec 18:00-21:00 · THE BOOTH · Grupp 1/.test(bkd[0].body) && /^Bokningsbekräftelse: tis 8 dec/.test(bkd[0].subject), bkd[0]);
ok('bekräftelsen väntar två minuter så att flera pass hinner samlas', new Date(bkd[0].send_after) > new Date(Date.now()+60000));
ok('inget separat "godkänd"-mejl', (await box('ans:%')).length===0);
/* nej på en förfrågan */
const rq3 = await as(db,U.will,()=>rpc('request_session',{p_circle:'c1',p_date:'2026-12-09',p_start:'18:00',p_end:'21:00'}));
await as(db,U.sofia,()=>rpc('answer_request',{p_booking:rq3.id,p_approve:false,p_studio:null}));
const no3 = await box('ans:'+rq3.id);
ok('nej → mejl till den som frågade', no3.length===1 && no3[0].member_id==='will' && /Tyvärr gick ons 9 dec/.test(no3[0].body), no3);
/* crewet bokar direkt — tre pass på en gång blir ett mejl per person */
await q(`delete from outbox`);
const bkRow = (id, d, o) => ({kind:'booking', id, data:Object.assign({id, studio:'A', date:d, start:'12:00', end:'15:00', who:'RKAY', title:'Nova EP',
  circleId:'', status:'', hours:null, present:[], paid:false, with:['ADREY'], artistId:''}, o||{}), up:200, del:false});
await q(`update members set email='adrey@b.se' where id='adrey'`);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([bkRow('w1','2026-12-14'), bkRow('w2','2026-12-21'), bkRow('w3','2026-12-28')])}));
const wb = await box('booked:%');
ok('direktbokning → bekräftelse till den som bokat och medproducenten', wb.map(r=>r.member_id).sort().join()==='adrey,rkay', wb.map(r=>r.member_id));
const wr = wb.find(r=>r.member_id==='rkay');
ok('tre pass på en gång → ETT mejl med tre rader', wr.n===3 && wr.body.split('\n').filter(l=>/· STUDIO A · Nova EP/.test(l)).length===3, wr.body);
ok('och ämnet säger hur många', wr.subject==='Bokningsbekräftelse: 3 sessioner', wr.subject);
ok('ADREY saknar inloggning men har e-post — får bekräftelsen ändå', wb.find(r=>r.member_id==='adrey').email==='adrey@b.se');
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([Object.assign(bkRow('w1','2026-12-14',{title:'Ändrad'}),{up:300})])}));
ok('en ändring av ett bokat pass skickar ingen ny bekräftelse', (await box('booked:rkay:%')).length===1 && (await box('booked:rkay:%'))[0].n===3);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([bkRow('old1','2026-01-10')])}));
ok('ett pass bakåt i tiden (t.ex. en import) mejlar ingen', (await box('booked:%')).every(r=>!/sön 10 jan/.test(r.body)));
/* timmar: will har 8 h — lägg ett stort pass så summan passerar 400 */
await q(`insert into records(kind,id,data,up) values('booking','big',$1,1)`,[JSON.stringify({id:'big',studio:'A',date:'2026-06-01',start:'10:00',end:'11:00',who:'Sofia Marks',circleId:'c1',status:'',present:[]})]);
await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'big',p_hours:24,p_present:JSON.stringify(['will'])}));
ok('under 400 h: ingen notis', (await box('hours:will%')).length===0);
const H = async (id, d) => q(`insert into records(kind,id,data,up) values('booking',$1,$2,1)`,[id,JSON.stringify({id,studio:'B',date:d||'2026-05-01',start:'10:00',end:'11:00',who:'Sofia Marks',circleId:'c1',status:'done',hours:24,present:['will']})]);
for (let i=0;i<16;i++) await H('h'+i);                       // 32 + 384 = 416 h
let hs = await box('hours:will%');
ok('passerar 400 h: en notis med timmar kvar', hs.length===1 && hs[0].dedupe_key==='hours:will:400' && /Du har 64 h kvar/.test(hs[0].body), hs.map(r=>r.dedupe_key+' '+r.body));
await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'big',p_hours:20.5,p_present:JSON.stringify(['will'])}));   // 412,5
ok('samma gräns skickas inte igen', (await box('hours:will%')).length===1);
await H('h16'); await H('h17');                               // 460,5
hs = await box('hours:will%');
ok('nästa gräns (440) ger en ny, med decimalkomma', hs.length===2 && hs[1].dedupe_key==='hours:will:440' && /19,5 h kvar/.test(hs[1].body), hs.map(r=>r.body));
await H('h18','2026-05-02');                                  // 484,5
hs = await box('hours:will:480%');
ok('vid 480 h: deltagaren OCH ledaren får veta', hs.length===2 && hs.some(r=>r.member_id==='sofia'), hs.map(r=>r.member_id));
/* agenda */
const ag = (id,who,text,done,up) => ({kind:'agenda',id,data:{id,kind:'week',week:'2026-12-07',who,text,done:!!done},up,del:false});
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a1','ADREY','Mixa',false,100)])}));
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a2','ADREY','Mastra',false,101)])}));
let aq = await box('agenda:adrey:%');
ok('ny uppgift → en notis, två uppgifter samlas i samma', aq.length===1 && aq[0].n===2 && /2 nya eller ändrade/.test(aq[0].body), aq.map(r=>r.n+' '+r.body));
ok('agendanotisen väntar tio minuter så ändringar hinner samlas', new Date(aq[0].send_after) > new Date(Date.now()+8*60000));
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a1','ADREY','Mixa',true,102)])}));
ok('att bocka av skickar inget', (await box('agenda:adrey:%'))[0].n===2);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a3','RKAY','Egen sak',false,103)])}));
ok('egen uppgift man skriver själv skickar inget', (await box('agenda:rkay:%')).length===0);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a4','','Städa',false,104)])}));
const all = (await box('agenda-all:%')).map(r=>r.member_id).sort();
ok('gemensam uppgift → hela teamet utom den som skrev', all.includes('az') && all.includes('costa') && all.includes('moez') && !all.includes('rkay') && !all.includes('will'), all);
/* tysta timmar gäller påminnelser — inte bekräftelser */
const quiet = await one(`
  with t as (select ((date_trunc('day', now() at time zone 'Europe/Stockholm') + interval '1 day 23 hours') at time zone 'Europe/Stockholm') as at)
  select (select at from t) - now() as delay`);
await q(`select bs_notify('will', null, 'Påminnelse', 'nattest', 'reminder', 'quiet1', $1::interval)`,[quiet.delay]);
await q(`select bs_notify('will', null, 'Bekräftelse', 'nattest', 'booked', 'quiet2', $1::interval)`,[quiet.delay]);
const qs = await one(`select to_char(send_after at time zone 'Europe/Stockholm','HH24:MI') hm,
  (send_after at time zone 'Europe/Stockholm')::date - (now() at time zone 'Europe/Stockholm')::date as d from outbox where dedupe_key='quiet1'`);
ok('påminnelse klockan 23 flyttas till 08:00 nästa morgon', qs.hm==='08:00' && qs.d===2, qs);
ok('en bekräftelse klockan 23 går direkt', (await one(`select to_char(send_after at time zone 'Europe/Stockholm','HH24:MI') hm from outbox where dedupe_key='quiet2'`)).hm==='23:00');
await q(`select bs_notify(null, 'inte-en-adress', 'x', 'x', 'booked', 'bad1')`);
ok('utan giltig e-post och utan push köas inget', (await box('bad1')).length===0);
/* påminnelser */
await q(`select reminders('2026-12-01'::date) n`);
const rem = (await box('remind:%')).map(r=>r.member_id).sort();
ok('påminnelser dagen innan: bokaren och cirkelns medlemmar', rem.includes('sofia') && rem.includes('will'), rem);
ok('förfrågningar får ingen påminnelse', !(await box('remind:rqN%')).length);
await q(`select reminders('2026-12-01'::date)`);
ok('påminnelser skickas bara en gång', (await box('remind:%')).length===rem.length);
const tick = (await one(`select reminders_tick() n`)).n;
ok('timkörningen gör inget före kl 17', (+(await one(`select extract(hour from now() at time zone 'Europe/Stockholm') h`)).h) >= 17 || tick===0, tick);

/* ============ v8 · NYA KUNDER ============ */
head('v8: nya kunder utan konto');
await q(`delete from outbox`);
const pr = (o) => asAnon(db,()=>rpc('public_request',Object.assign({p_name:'Nova Lind',p_email:'nova@x.se',p_phone:'',
  p_date:'2026-12-15',p_start:'12:00',p_end:'16:00',p_studio:'B',p_message:'EP',p_hp:''},o)));
ok('anonym ser upptagen tid utan namn', (await asAnon(db,()=>rpc('free_slots',{p_from:'2026-11-01',p_to:'2026-12-31'}))).every(x=>!('who' in x) && !('title' in x)));
ok('och kan skicka en förfrågan utan telefonnummer', (await pr({})).ok===true && (await q(`select * from leads`)).length===1);
const ls = (await q(`select member_id from outbox where kind='lead'`)).map(r=>r.member_id).sort();
ok('admins och managern får mejl om nya kunder', JSON.stringify(ls)==='["az","costa"]', ls);
const lr = (await q(`select * from outbox where kind='received'`))[0];
ok('och kunden får ett kvitto på mejlen', lr && lr.email==='nova@x.se' && !lr.member_id && /tagit emot din förfrågan om tis 15 dec 12:00-16:00/.test(lr.body), lr);
await pr({p_hp:'robot'});
ok('honeypot: robotar får "ok" men inget sparas', (await q(`select * from leads`)).length===1);
ok('ett ifyllt men trasigt nummer nekas', /Telefonnumret ser fel ut/.test(await boom(()=>pr({p_phone:'123'}))||''));
ok('trasig e-post nekas', /E-postadressen/.test(await boom(()=>pr({p_email:'nova'}))||''));
await pr({}); await pr({});
ok('max tre öppna förfrågningar per e-postadress', /redan tre/.test(await boom(()=>pr({}))||''));
ok('anonyma kan inte läsa förfrågningarna', (await asAnon(db,()=>q(`select * from leads`))).length===0);
ok('producenter kan inte heller', (await as(db,U.rkay,()=>q(`select * from leads`))).length===0);
ok('admin kan', (await C(()=>q(`select * from leads`))).length===3);
const lead = await one(`select id from leads order by created_at limit 1`);
ok('producent kan inte godkänna', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://x/'})))||''));
const ap = await C(()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://bandohq.se/'}));
const lb = await one(`select data from records where id=$1`,[ap.booking]);
ok('godkänt: bokningen ligger i schemat', lb.data.who==='Nova Lind' && lb.data.status==='' && lb.data.leadId===lead.id, lb.data);
const lmail = await one(`select * from outbox where dedupe_key=$1`,['lead-ok:'+lead.id]);
ok('och kunden får bekräftelsen med länken till sitt konto på mejlen', lmail && lmail.email==='nova@x.se' && lmail.link==='https://bandohq.se/#join='+ap.invite
   && /Din tid är bokad/.test(lmail.body) && /^Bokningsbekräftelse: tis 15 dec/.test(lmail.subject), lmail);
ok('och ingen dubblett från bokningen', (await box('booked:%')).length===0);
ok('samma förfrågan kan inte godkännas två gånger', /finns inte längre/.test(await boom(()=>C(()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'A',p_url:'x'})))||''));
const inf = await asAnon(db,()=>rpc('invite_info',{p_token:ap.invite}));
ok('länken är en kundinbjudan med namn och e-post ifyllda', inf.ok && inf.role==='customer' && inf.name==='Nova Lind' && inf.email==='nova@x.se', inf);
const nm = await as(db,U.ny5,()=>rpc('redeem_invite',{p_token:ap.invite,p_name:'Nova Lind',p_username:'nova'}));
const lb2 = await one(`select data from records where id=$1`,[ap.booking]);
ok('när kunden gått med är bokningen hens', nm.role==='customer' && lb2.data.reqBy===nm.id, lb2.data);
ok('och syns i kundens vy', (await as(db,U.ny5,()=>rpc('my_view',{}))).bookings.some(b=>b.id===ap.booking));
const l2 = await one(`select id from leads where status='new' limit 1`);
await C(()=>rpc('decline_lead',{p_lead:l2.id,p_reason:''}));
const lno = await one(`select * from outbox where dedupe_key=$1`,['lead-no:'+l2.id]);
ok('avböjd → mejl', lno && lno.email==='nova@x.se' && /Tyvärr kan vi inte ta tiden/.test(lno.body), lno);

/* ============ v8 · KUNDFÖRFRÅGAN ============ */
head('v8: kund med konto');
await q(`update members set producer='rkay' where id='kund'`);
await q(`delete from outbox`);
const kr = await as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-10',p_start:'12:00',p_end:'15:00',p_studio:'B',p_note:'Mix av singeln'}));
const kto = (await q(`select member_id from outbox where dedupe_key like $1`,['req:'+kr.id+'%'])).map(r=>r.member_id).sort();
ok('förfrågan går till kundens producent och admins', JSON.stringify(kto)==='["az","costa","rkay"]', kto);
ok('med kundens meddelande', /Meddelande: Mix av singeln/.test((await one(`select body from outbox where dedupe_key=$1`,['req:'+kr.id+':rkay'])).body));
const krc = await one(`select * from outbox where dedupe_key=$1`,['rcv:'+kr.id]);
ok('kunden får ett kvitto', krc && krc.member_id==='kund' && krc.email==='kund@b.se' && /Vi har tagit emot/.test(krc.subject), krc);
ok('kundens vy visar producenten', (await as(db,U.kund,()=>rpc('my_view',{}))).producer==='RKAY');
ok('och förfrågan', (await as(db,U.kund,()=>rpc('my_view',{}))).bookings.some(b=>b.id===kr.id && b.status==='request'));
ok('kunden kan inte svara själv', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.kund,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'})))||''));
await as(db,U.rkay,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'}));
const kbk = await q(`select * from outbox where kind='booked' and member_id='kund'`);
ok('producenten godkänner → kunden får orderbekräftelsen', kbk.length===1 && /tor 10 dec 12:00-15:00 · THE BOOTH/.test(kbk[0].body), kbk);
const st = await C(()=>rpc('notify_stats',{}));
ok('admin ser notisstatistik för månaden', st.queued>0 && 'mail' in st && 'push' in st && !('cost' in st), st);
const cl = await q(`select * from outbox_claim(2)`);
const cl2 = await q(`select * from outbox_claim(100)`);
ok('servern plockar ut notiser att skicka, och samma rad plockas inte två gånger', cl.length===2 && !cl2.some(r=>cl.some(c=>c.id===r.id)), [cl.length, cl2.length]);
await q(`select outbox_done($1,true,null,'mail')`,[cl[0].id]);
await q(`select outbox_done($1,false,'500 Resend nere',null)`,[cl[1].id]);
const dn1 = await one(`select sent_at, error, channel from outbox where id=$1`,[cl[0].id]), dn2 = await one(`select sent_at, error from outbox where id=$1`,[cl[1].id]);
ok('skickat markeras, fel sparas för nytt försök', !!dn1.sent_at && !dn1.error && dn1.channel==='mail' && !dn2.sent_at && /500/.test(dn2.error), [dn1, dn2]);
ok('producent ser inte statistiken', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('notify_stats',{})))||''));

/* ============ v9 · INBJUDAN PER MEJL ============ */
head('v9: inbjudan per mejl');
await q(`delete from outbox`);
const tp = await C(()=>rpc('create_invite',{p_role:'camera',p_circle:null,p_days:14,p_max:5,p_team:'D2L',p_name:'D2L Bo',p_email:'Bo@D2L.se',p_url:'https://bandohq.se/'}));
const ti = await one(`select * from invites where token=$1`,[tp]);
ok('personlig inbjudan gäller en person', ti.max_uses===1 && ti.team==='D2L' && ti.email==='bo@d2l.se', ti);
const im = await one(`select * from outbox where dedupe_key=$1`,['invite:'+tp]);
ok('och länken skickas som mejl', im && im.email==='bo@d2l.se' && im.link==='https://bandohq.se/#join='+tp && im.kind==='invite'
   && /Du är inbjuden till BANDOHQ som kamerateam/.test(im.body) && /14 dagar/.test(im.body), im);
ok('trasig e-post nekas', /E-postadressen ser fel ut/.test(await boom(()=>C(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:1,p_email:'bo@',p_url:'x'})))||''));
const bo = await as(db,U.ny6,()=>rpc('redeem_invite',{p_token:tp,p_name:'D2L Bo',p_username:'d2l.bo'}));
const bom = await one(`select role, team, email from members where id=$1`,[bo.id]);
ok('personen hamnar i teamet med e-posten från inloggningen', bom.role==='camera' && bom.team==='D2L' && bom.email==='ny6@b.se', bom);

/* en person som redan finns i appen (ADREY, utan inloggning) */
await q(`insert into records(kind,id,data,up) values('booking','adb',$1,1)`,[JSON.stringify({id:'adb',studio:'A',date:'2026-12-31',start:'10:00',end:'12:00',who:'ADREY',status:''})]);
ok('admin kan inte bjuda in någon som redan har ett konto', /RKAY har redan ett konto/.test(await boom(()=>C(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:1,p_member:'rkay',p_url:'https://bandohq.se/'})))||''));
ok('e-post krävs till en befintlig person utan adress', /Fyll i en e-postadress till Moez Ny/.test(await boom(async()=>{
  await q(`insert into members(id,role,name) values('moezny','camera','Moez Ny')`);
  return C(()=>rpc('create_invite',{p_role:'camera',p_circle:null,p_days:14,p_max:1,p_member:'moezny',p_url:'https://bandohq.se/'}));})||''));
const ta1 = await C(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:9,p_member:'adrey',p_email:'adrey@gmail.com',p_url:'https://bandohq.se/'}));
ok('inbjudan till ADREY sparar e-posten på personen', (await one(`select email from members where id='adrey'`)).email==='adrey@gmail.com');
const ta2 = await C(()=>rpc('create_invite',{p_role:'admin',p_circle:null,p_days:7,p_max:1,p_member:'adrey',p_url:'https://bandohq.se/'}));
ok('"skicka igen" stänger den förra länken', (await one(`select closed from invites where token=$1`,[ta1])).closed===true);
ok('och det nya mejlet går till samma adress, som admin denna gång', /som admin/.test((await one(`select body, email from outbox where dedupe_key=$1`,['invite:'+ta2])).body)
   && (await one(`select email from outbox where dedupe_key=$1`,['invite:'+ta2])).email==='adrey@gmail.com');
const ai = await asAnon(db,()=>rpc('invite_info',{p_token:ta2}));
ok('länken visar namnet som redan finns och e-posten', ai.ok && ai.member===true && ai.name==='ADREY' && ai.email==='adrey@gmail.com' && ai.role==='admin', ai);
U.adrey = await user('adrey@gmail.com');
ok('den gamla länken går inte att använda', /stängd/.test(await boom(()=>as(db,U.adrey,()=>rpc('redeem_invite',{p_token:ta1,p_username:'adrey'})))||''));
const before = (await one(`select count(*)::int n from members`)).n;
const ar = await as(db,U.adrey,()=>rpc('redeem_invite',{p_token:ta2,p_name:'Fel Namn',p_username:'Adrey'}));
const arow = await one(`select * from members where id='adrey'`);
ok('inloggningen kopplas till ADREYS rad — ingen ny rad', ar.id==='adrey' && (await one(`select count(*)::int n from members`)).n===before && arow.user_id===U.adrey, ar);
ok('namnet ADREY behålls, rollen kommer från länken', arow.name==='ADREY' && arow.role==='admin' && arow.username==='adrey' && arow.email==='adrey@gmail.com', arow);
ok('ADREYS pass och färg finns kvar', (await one(`select data->>'who' w from records where id='adb'`)).w==='ADREY');
ok('ADREY loggar in och ser sig själv', (await as(db,U.adrey,()=>q(`select id from members where user_id=auth.uid()`))).length===1);
U.hax = await user('hax@b.se');
const ta3 = await as(db,U.az,()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:7,p_max:1,p_member:'moezny',p_email:'moez@ny.se',p_url:'https://bandohq.se/'}));
await q(`update members set user_id=$1 where id='moezny'`,[U.hax]);
ok('en rad som hunnit få en inloggning kan inte kapas', /redan en inloggning/.test(await boom(async()=>{ const u = await user('kapa@b.se');
  return as(db,u,()=>rpc('redeem_invite',{p_token:ta3,p_username:'kapare'})); })||''));

/* ============ v8.1 · PUSH ============ */
head('v8.1: push-notiser');
const sub = (n) => ({p_endpoint:'https://push.example/'+n, p_p256dh:'B'+'x'.repeat(86), p_auth:'a'.repeat(22), p_ua:'iPhone'});
await as(db,U.will,()=>rpc('save_push_sub', sub('will1')));
await as(db,U.rkay,()=>rpc('save_push_sub', sub('rkay1')));
ok('en enhet sparar sin prenumeration', (await q(`select member_id from push_subs where endpoint='https://push.example/will1'`))[0].member_id==='will');
ok('var och en ser bara sina egna enheter', (await as(db,U.will,()=>q(`select endpoint from push_subs`))).map(r=>r.endpoint).join()==='https://push.example/will1');
ok('admins ser alla', (await C(()=>q(`select 1 from push_subs`))).length>=2);
ok('ingen kan lägga in rader direkt', !!(await boom(()=>as(db,U.will,()=>q(`insert into push_subs(member_id,endpoint,p256dh,auth) values('rkay','https://x/y','k','a')`)))));
ok('skräp som prenumeration nekas', /Ogiltig/.test(await boom(()=>as(db,U.will,()=>rpc('save_push_sub',{p_endpoint:'http://x',p_p256dh:'k',p_auth:'a',p_ua:''})))||''));
ok('anonyma kan inte spara', /Logga in/.test(await boom(()=>asAnon(db,()=>rpc('save_push_sub', sub('anon'))))||''));
await as(db,U.nora,()=>rpc('save_push_sub', sub('will1')));
ok('samma enhet med ett annat konto tar över raden', (await q(`select member_id from push_subs where endpoint='https://push.example/will1'`))[0].member_id==='nora');
await as(db,U.will,()=>rpc('remove_push_sub',{p_endpoint:'https://push.example/rkay1'}));
ok('man kan inte ta bort någon annans enhet', (await q(`select 1 from push_subs where endpoint='https://push.example/rkay1'`)).length===1);
await as(db,U.rkay,()=>rpc('remove_push_sub',{p_endpoint:'https://push.example/rkay1'}));
ok('men sin egen', (await q(`select 1 from push_subs where endpoint='https://push.example/rkay1'`)).length===0);
await q(`insert into records(kind,id,data,up) values('setting','push','{"publicKey":"BPUB"}',1) on conflict (kind,id) do update set data=excluded.data`);
ok('servernyckeln går att läsa utan inloggning', (await asAnon(db,()=>rpc('push_public_key',{})))==='BPUB');
ok('utskicksfunktionerna är stängda för inloggade', /permission denied/.test(await boom(()=>as(db,U.nora,()=>q(`select * from push_targets('nora')`)))||'') &&
   /permission denied/.test(await boom(()=>C(()=>q(`select outbox_done(1,true,null,null)`)))||''));
/* person utan e-post men med push får ändå notisen */
await q(`update members set email=null where id='nora'`);
await q(`delete from outbox`);
await as(db,U.nora,()=>rpc('notify_test',{}));
const nt = await q(`select * from outbox where kind='test'`);
ok('testnotis köas, även utan e-post när push finns', nt.length===1 && nt[0].email===null && nt[0].member_id==='nora', nt);
const tg = await q(`select * from push_targets('nora')`);
ok('servern hittar personens enheter', tg.length===1 && tg[0].endpoint==='https://push.example/will1');
await q(`select push_result($1,false,false)`,[tg[0].id]); await q(`select push_result($1,false,false)`,[tg[0].id]);
ok('misslyckad push räknas', (await one(`select fails from push_subs where id=$1`,[tg[0].id])).fails===2);
await q(`select push_result($1,true,false)`,[tg[0].id]);
ok('lyckad push nollställer', (await one(`select fails, last_ok from push_subs where id=$1`,[tg[0].id])).fails===0);
await q(`select push_result($1,false,true)`,[tg[0].id]);
ok('enhet som inte finns längre (410) tas bort', (await q(`select 1 from push_subs where id=$1`,[tg[0].id])).length===0);
await q(`select outbox_done($1,true,null,'push')`,[nt[0].id]);
const st2 = await C(()=>rpc('notify_stats',{}));
ok('statistiken skiljer push från mejl och visar vem som får mejl i stället', st2.push===1 && Array.isArray(st2.noPush) && st2.noPush.includes('William Ek'), st2);


/* ============ LANSERING · RADERA PERSON, STUDIOINFO ============ */
head('lansering: radera person och studioinfo');
await q(`insert into records(kind,id,data,up) values('setting','studios','{"A":"STUDIO A","B":"THE BOOTH","openFrom":"11:00","openTo":"22:00"}',2)
         on conflict (kind,id) do update set data=excluded.data, up=excluded.up`);
const si = await asAnon(db,()=>rpc('studio_info',{}));
ok('bokningssidan får studionamn och öppettider utan inloggning', si.B==='THE BOOTH' && si.openFrom==='11:00' && si.openTo==='22:00', si);
ok('admin kan inte radera konton', /Bara managern/.test(await boom(()=>C(()=>rpc('delete_member',{p_id:'will'})))||''));
ok('managern kan inte radera sig själv', /eget konto/.test(await boom(()=>as(db,U.az,()=>rpc('delete_member',{p_id:'az'})))||''));
await q(`insert into records(kind,id,data,up) values('agenda','dw1',$1,1)`,[JSON.stringify({id:'dw1',who:'William Ek',text:'Hemligt'})]);
await q(`insert into records(kind,id,data,up) values('booking','dwb',$1,1)`,[JSON.stringify({id:'dwb',studio:'A',date:'2026-12-30',start:'10:00',end:'11:00',who:'RKAY',with:['William Ek','ADREY'],status:''})]);
const hoursBefore = +(await one(`select bs_hours('will') h`)).h;
await as(db,U.will,()=>rpc('save_push_sub', sub('will-del')));
const dm = await as(db,U.az,()=>rpc('delete_member',{p_id:'will'}));
ok('managern raderar en person', dm.deleted==='William Ek', dm);
ok('kontot och inloggningen är borta', !(await one(`select 1 from members where id='will'`)) && !(await one(`select 1 from auth.users where id=$1`,[U.will])));
ok('enheterna för push är borta', !(await one(`select 1 from push_subs where endpoint='https://push.example/will-del'`)));
ok('namnet är borta ur pass han var med på', JSON.stringify((await one(`select data from records where id='dwb'`)).data.with)==='["ADREY"]');
ok('och ur cirkeln', !(await one(`select data from records where id='c1'`)).data.members.includes('will'));
ok('hans agenda är borta', (await one(`select del from records where id='dw1'`)).del===true);
ok('timmarna finns kvar för rapporteringen', +(await one(`select bs_hours('will') h`)).h===hoursBefore && hoursBefore>0, hoursBefore);
ok('ingen kvarvarande rad nämner namnet', !(await one(`select 1 from records where not del and data::text like '%William Ek%'`)));

}
console.log('\n══════════════════════════════');
console.log(pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
