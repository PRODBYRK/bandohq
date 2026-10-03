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
const red = await as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo Native',p_phone:'070-777 77 77'}));
ok('inlösen ger rollen från länken', red.role==='participant' && red.name==='Leo Native', red);
const leo = await one(`select * from members where user_id=$1`,[ny]);
ok('kontot får e-posten från inloggningen', leo.email==='ny@b.se' && leo.phone==='+46707777777', leo);
ok('och läggs in i cirkeln automatiskt', (await one(`select data->'members' ? $1 as y from records where id='c1'`,[leo.id])).y===true);
ok('samma person kan inte lösa in igen', /redan ett konto/.test(await boom(()=>as(db,ny,()=>rpc('redeem_invite',{p_token:tok,p_name:'Leo 2',p_phone:'070-111 11 11'})))||''));
const ny2 = await user('ny2@b.se'), ny3 = await user('ny3@b.se');
ok('upptaget namn nekas', /Namnet finns redan/.test(await boom(()=>as(db,ny2,()=>rpc('redeem_invite',{p_token:tok,p_name:'william ek',p_phone:'070-111 11 11'})))||''));
await as(db,ny2,()=>rpc('redeem_invite',{p_token:tok,p_name:'Maja Sund',p_phone:'070-111 11 11'}));
ok('länken tar slut efter max antal', /redan använd/.test(await boom(()=>as(db,ny3,()=>rpc('redeem_invite',{p_token:tok,p_name:'Omar Khan',p_phone:'070-111 11 11'})))||''));
const tokL = await as(db,U.az,()=>rpc('create_invite',{p_role:'leader',p_circle:'c2',p_days:14,p_max:null}));
await as(db,ny3,()=>rpc('redeem_invite',{p_token:tokL,p_name:'Omar Khan',p_phone:'070-111 11 11'}));
ok('ledarinbjudan gör personen till cirkelns ledare', (await one(`select data->>'leader' l from records where id='c2'`)).l==='Omar Khan');
await q(`update invites set closed=true where token=$1`,[tokL]);
const ny4 = await user('ny4@b.se');
ok('stängd länk nekas', /stängd/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:tokL,p_name:'Ida Berg',p_phone:'070-111 11 11'})))||''));
const tokX = await as(db,U.az,()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:1,p_max:null}));
await q(`update invites set expires_at=now()-interval '1 hour' where token=$1`,[tokX]);
ok('utgången länk nekas', /gått ut/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:tokX,p_name:'Ida Berg',p_phone:'070-111 11 11'})))||''));
ok('okänd länk nekas', /finns inte/.test(await boom(()=>as(db,ny4,()=>rpc('redeem_invite',{p_token:'AAAA-BBBBBB',p_name:'Ida Berg',p_phone:'070-111 11 11'})))||''));
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
ok('kameran ser inte utkorgen eller nya kunder', (await K(()=>q(`select 1 from sms_outbox`))).length===0 && (await K(()=>q(`select 1 from leads`))).length===0);

/* ============ v8 · INTERNA FUNKTIONER ÄR STÄNGDA ============ */
head('v8: interna funktioner');
ok('en deltagare kan inte skriva pass förbi kontrollerna', /permission denied/.test(await boom(()=>as(db,U.will,()=>rpc('bs_put_booking',{d:JSON.stringify({id:'hack',studio:'A',date:'2026-12-24',start:'10:00',end:'11:00'})})))||''));
ok('inte heller köa egna SMS', /permission denied/.test(await boom(()=>as(db,U.will,()=>q(`select bs_sms('az','0701234567','spam','x','spam1')`)))||''));
ok('eller plocka ut utkorgen', /permission denied/.test(await boom(()=>C(()=>q(`select * from sms_claim(10)`)))||''));
ok('anonyma kan inte läsa timmar', /permission denied/.test(await boom(()=>asAnon(db,()=>q(`select bs_hours('will')`)))||''));

/* ============ v8 · SMS ============ */
head('v8: SMS-notiser');
const ph = async p => (await one(`select bs_phone($1) v`,[p])).v;
ok('070-123 45 67 → +46701234567', await ph('070-123 45 67')==='+46701234567');
ok('0046… och +46… godtas', await ph('0046701234567')==='+46701234567' && await ph('+46 70 123 45 67')==='+46701234567');
ok('trasigt nummer blir null', await ph('070-7')===null && await ph('abc')===null);
ok('tankstreck byts så SMS:et ryms i 160 tecken', (await one(`select bs_gsm('tor 9 okt 18:00–21:00 · Studio') v`)).v==='tor 9 okt 18:00-21:00 . Studio');
const box = async k => q(`select * from sms_outbox where dedupe_key like $1 order by id`,[k]);
await q(`delete from sms_outbox`);
const rq2 = await as(db,U.will,()=>rpc('request_session',{p_circle:'c1',p_date:'2026-12-08',p_start:'18:00',p_end:'21:00'}));
const rs = await box('req:'+rq2.id+'%');
ok('förfrågan → SMS till ledaren', rs.length===1 && rs[0].member_id==='sofia' && /William Ek föreslår tis 8 dec 18:00-21:00/.test(rs[0].body), rs.map(r=>r.body));
await as(db,U.sofia,()=>rpc('answer_request',{p_booking:rq2.id,p_approve:true,p_studio:'B'}));
const an = await box('ans:'+rq2.id);
ok('svaret → SMS till den som frågade', an.length===1 && an[0].member_id==='will' && /Godkänd/.test(an[0].body), an.map(r=>r.body));
ok('numret sparas i E.164', an[0].phone==='+46709999999', an[0].phone);
/* timmar: will har 8 h — lägg ett stort pass så summan passerar 400 */
await q(`insert into records(kind,id,data,up) values('booking','big',$1,1)`,[JSON.stringify({id:'big',studio:'A',date:'2026-06-01',start:'10:00',end:'11:00',who:'Sofia Marks',circleId:'c1',status:'',present:[]})]);
await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'big',p_hours:24,p_present:JSON.stringify(['will'])}));
ok('under 400 h: inget SMS', (await box('hours:will%')).length===0);
const H = async (id, d) => q(`insert into records(kind,id,data,up) values('booking',$1,$2,1)`,[id,JSON.stringify({id,studio:'B',date:d||'2026-05-01',start:'10:00',end:'11:00',who:'Sofia Marks',circleId:'c1',status:'done',hours:24,present:['will']})]);
for (let i=0;i<16;i++) await H('h'+i);                       // 32 + 384 = 416 h
let hs = await box('hours:will%');
ok('passerar 400 h: ett SMS med timmar kvar', hs.length===1 && hs[0].dedupe_key==='hours:will:400' && /Du har 64 h kvar/.test(hs[0].body), hs.map(r=>r.dedupe_key+' '+r.body));
await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'big',p_hours:20.5,p_present:JSON.stringify(['will'])}));   // 412,5
ok('samma gräns skickas inte igen', (await box('hours:will%')).length===1);
await H('h16'); await H('h17');                               // 460,5
hs = await box('hours:will%');
ok('nästa gräns (440) ger ett nytt, med decimalkomma', hs.length===2 && hs[1].dedupe_key==='hours:will:440' && /19,5 h kvar/.test(hs[1].body), hs.map(r=>r.body));
await H('h18','2026-05-02');                                  // 484,5
hs = await box('hours:will:480%');
ok('vid 480 h: deltagaren OCH ledaren får veta', hs.length===2 && hs.some(r=>r.member_id==='sofia'), hs.map(r=>r.member_id));
/* agenda */
const ag = (id,who,text,done,up) => ({kind:'agenda',id,data:{id,kind:'week',week:'2026-12-07',who,text,done:!!done},up,del:false});
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a1','ADREY','Mixa',false,100)])}));
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a2','ADREY','Mastra',false,101)])}));
let aq = await box('agenda:adrey:%');
ok('ny uppgift → ett SMS, två uppgifter samlas i samma', aq.length===1 && aq[0].n===2 && /2 nya eller ändrade/.test(aq[0].body), aq.map(r=>r.n+' '+r.body));
ok('agenda-SMS väntar tio minuter så ändringar hinner samlas', new Date(aq[0].send_after) > new Date(Date.now()+8*60000));
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a1','ADREY','Mixa',true,102)])}));
ok('att bocka av skickar inget', (await box('agenda:adrey:%'))[0].n===2);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a3','RKAY','Egen sak',false,103)])}));
ok('egen uppgift man skriver själv skickar inget', (await box('agenda:rkay:%')).length===0);
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([ag('a4','','Städa',false,104)])}));
const all = (await box('agenda-all:%')).map(r=>r.member_id).sort();
ok('gemensam uppgift → hela teamet utom den som skrev', all.includes('az') && all.includes('costa') && all.includes('moez') && !all.includes('rkay') && !all.includes('will'), all);
/* tysta timmar */
const quiet = await one(`
  with t as (select ((date_trunc('day', now() at time zone 'Europe/Stockholm') + interval '1 day 23 hours') at time zone 'Europe/Stockholm') as at)
  select (select at from t) - now() as delay`);
await q(`select bs_sms('will', null, 'nattest', 'test', 'quiet1', $1::interval)`,[quiet.delay]);
const qs = await one(`select to_char(send_after at time zone 'Europe/Stockholm','HH24:MI') hm,
  (send_after at time zone 'Europe/Stockholm')::date - (now() at time zone 'Europe/Stockholm')::date as d from sms_outbox where dedupe_key='quiet1'`);
ok('SMS klockan 23 flyttas till 08:00 nästa morgon', qs.hm==='08:00' && qs.d===2, qs);
/* påminnelser */
await q(`select sms_reminders('2026-12-01'::date) n`);
const rem = (await box('remind:%')).map(r=>r.member_id).sort();
ok('påminnelser dagen innan: bokaren och cirkelns medlemmar', rem.includes('sofia') && rem.includes('will'), rem);
ok('förfrågningar får ingen påminnelse', !(await box('remind:rqN%')).length);
await q(`select sms_reminders('2026-12-01'::date)`);
ok('påminnelser skickas bara en gång', (await box('remind:%')).length===rem.length);
const tick = (await one(`select sms_reminders_tick() n`)).n;
ok('timkörningen gör inget före kl 17', (+(await one(`select extract(hour from now() at time zone 'Europe/Stockholm') h`)).h) >= 17 || tick===0, tick);

/* ============ v8 · NYA KUNDER ============ */
head('v8: nya kunder utan konto');
await q(`delete from sms_outbox`);
const pr = (o,ph) => asAnon(db,()=>rpc('public_request',Object.assign({p_name:'Nova Lind',p_email:'nova@x.se',p_phone:ph||'0731112233',
  p_date:'2026-12-15',p_start:'12:00',p_end:'16:00',p_studio:'B',p_message:'EP',p_hp:''},o)));
ok('anonym ser upptagen tid utan namn', (await asAnon(db,()=>rpc('free_slots',{p_from:'2026-11-01',p_to:'2026-12-31'}))).every(x=>!('who' in x) && !('title' in x)));
ok('och kan skicka en förfrågan', (await pr({})).ok===true && (await q(`select * from leads`)).length===1);
const ls = (await q(`select member_id from sms_outbox where kind='lead'`)).map(r=>r.member_id).sort();
ok('admins och managern får SMS om nya kunder', JSON.stringify(ls)==='["az","costa"]', ls);
await pr({p_hp:'robot'});
ok('honeypot: robotar får "ok" men inget sparas', (await q(`select * from leads`)).length===1);
ok('trasigt nummer nekas', /mobilnummer/.test(await boom(()=>pr({},'123'))||''));
await pr({}); await pr({});
ok('max tre öppna förfrågningar per person', /redan tre/.test(await boom(()=>pr({}))||''));
ok('anonyma kan inte läsa förfrågningarna', (await asAnon(db,()=>q(`select * from leads`))).length===0);
ok('producenter kan inte heller', (await as(db,U.rkay,()=>q(`select * from leads`))).length===0);
ok('admin kan', (await C(()=>q(`select * from leads`))).length===3);
const lead = await one(`select id from leads order by created_at limit 1`);
ok('producent kan inte godkänna', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://x/'})))||''));
const ap = await C(()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://bando.github.io/bandosesh/'}));
const lb = await one(`select data from records where id=$1`,[ap.booking]);
ok('godkänt: bokningen ligger i schemat', lb.data.who==='Nova Lind' && lb.data.status==='' && lb.data.leadId===lead.id, lb.data);
const lsms = await one(`select * from sms_outbox where dedupe_key=$1`,['lead-ok:'+lead.id]);
ok('och kunden får länken som SMS', lsms && lsms.phone==='+46731112233' && lsms.body.includes('#join='+ap.invite), lsms&&lsms.body);
ok('hela SMS:et ryms i 160 tecken', lsms.body.length<=160, lsms.body.length);
ok('samma förfrågan kan inte godkännas två gånger', /finns inte längre/.test(await boom(()=>C(()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'A',p_url:'x'})))||''));
const inf = await asAnon(db,()=>rpc('invite_info',{p_token:ap.invite}));
ok('länken är en kundinbjudan med namnet ifyllt', inf.ok && inf.role==='customer' && inf.name==='Nova Lind', inf);
const nm = await as(db,U.ny5,()=>rpc('redeem_invite',{p_token:ap.invite,p_name:'Nova Lind',p_phone:''}));
const lb2 = await one(`select data from records where id=$1`,[ap.booking]);
ok('när kunden gått med är bokningen hens', nm.role==='customer' && lb2.data.reqBy===nm.id, lb2.data);
ok('och syns i kundens vy', (await as(db,U.ny5,()=>rpc('my_view',{}))).bookings.some(b=>b.id===ap.booking));
const l2 = await one(`select id from leads where status='new' limit 1`);
await C(()=>rpc('decline_lead',{p_lead:l2.id,p_reason:''}));
ok('avböjd → SMS', !!(await one(`select 1 from sms_outbox where dedupe_key=$1`,['lead-no:'+l2.id])));

/* ============ v8 · KUNDFÖRFRÅGAN ============ */
head('v8: kund med konto');
await q(`update members set producer='rkay' where id='kund'`);
await q(`delete from sms_outbox`);
const kr = await as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-10',p_start:'12:00',p_end:'15:00',p_studio:'B',p_note:''}));
const kto = (await q(`select member_id from sms_outbox where dedupe_key like $1`,['req:'+kr.id+'%'])).map(r=>r.member_id).sort();
ok('förfrågan går till kundens producent och admins', JSON.stringify(kto)==='["az","costa","rkay"]', kto);
ok('kundens vy visar producenten', (await as(db,U.kund,()=>rpc('my_view',{}))).producer==='RKAY');
ok('och förfrågan', (await as(db,U.kund,()=>rpc('my_view',{}))).bookings.some(b=>b.id===kr.id && b.status==='request'));
ok('kunden kan inte svara själv', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.kund,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'})))||''));
await as(db,U.rkay,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'}));
ok('producenten godkänner → kunden får SMS', /Godkänd/.test((await one(`select body from sms_outbox where dedupe_key=$1`,['ans:'+kr.id])||{}).body||''));
const st = await C(()=>rpc('sms_stats',{}));
ok('admin ser SMS-statistik för månaden', st.queued>0 && 'cost' in st, st);
const cl = await q(`select * from sms_claim(3)`);
const cl2 = await q(`select * from sms_claim(100)`);
ok('servern plockar ut SMS att skicka, och samma rad plockas inte två gånger', cl.length===3 && !cl2.some(r=>cl.some(c=>c.id===r.id)), [cl.length, cl2.length]);
await q(`select sms_done($1,true,3500,null)`,[cl[0].id]);
await q(`select sms_done($1,false,null,'401 fel nyckel')`,[cl[1].id]);
const dn1 = await one(`select sent_at, error from sms_outbox where id=$1`,[cl[0].id]), dn2 = await one(`select sent_at, error from sms_outbox where id=$1`,[cl[1].id]);
ok('skickat markeras, fel sparas för nytt försök', !!dn1.sent_at && !dn1.error && !dn2.sent_at && /401/.test(dn2.error), [dn1, dn2]);
ok('producent ser den inte', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('sms_stats',{})))||''));

/* inbjudan med namn och telefon (admin lägger till en person) */
const tp = await C(()=>rpc('create_invite',{p_role:'camera',p_circle:null,p_days:14,p_max:5,p_team:'D2L',p_name:'D2L Bo',p_phone:'0735556677',p_url:'https://bando.github.io/bandosesh/'}));
const ti = await one(`select * from invites where token=$1`,[tp]);
ok('personlig inbjudan gäller en person', ti.max_uses===1 && ti.team==='D2L', ti);
ok('och länken skickas som SMS', /#join=/.test((await one(`select body from sms_outbox where dedupe_key=$1`,['invite:'+tp])||{}).body||''));
const bo = await as(db,U.ny6,()=>rpc('redeem_invite',{p_token:tp,p_name:'D2L Bo',p_phone:''}));
const bom = await one(`select role, team, phone from members where id=$1`,[bo.id]);
ok('personen hamnar i teamet med numret från inbjudan', bom.role==='camera' && bom.team==='D2L' && bom.phone==='+46735556677', bom);

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
   /permission denied/.test(await boom(()=>C(()=>q(`select notify_policy()`)))||''));
/* person utan nummer men med push får ändå notisen */
await q(`update members set phone=null where id='nora'`);
await q(`delete from sms_outbox`);
await as(db,U.nora,()=>rpc('notify_test',{}));
const nt = await q(`select * from sms_outbox where kind='test'`);
ok('testnotis köas, även utan telefonnummer när push finns', nt.length===1 && nt[0].phone==='' && nt[0].member_id==='nora', nt);
const tg = await q(`select * from push_targets('nora')`);
ok('servern hittar personens enheter', tg.length===1 && tg[0].endpoint==='https://push.example/will1');
await q(`select push_result($1,false,false)`,[tg[0].id]); await q(`select push_result($1,false,false)`,[tg[0].id]);
ok('misslyckad push räknas', (await one(`select fails from push_subs where id=$1`,[tg[0].id])).fails===2);
await q(`select push_result($1,true,false)`,[tg[0].id]);
ok('lyckad push nollställer', (await one(`select fails, last_ok from push_subs where id=$1`,[tg[0].id])).fails===0);
await q(`select push_result($1,false,true)`,[tg[0].id]);
ok('enhet som inte finns längre (410) tas bort', (await q(`select 1 from push_subs where id=$1`,[tg[0].id])).length===0);
await q(`select sms_done($1,true,null,null,'push')`,[nt[0].id]);
const st2 = await C(()=>rpc('sms_stats',{}));
ok('statistiken skiljer push från SMS och visar vem som saknar push', st2.push===1 && Array.isArray(st2.noPush) && st2.noPush.includes('William Ek'), st2);
await q(`insert into records(kind,id,data,up) values('setting','notify','{"criticalSms":true}',1)`);
ok('policyn för viktiga SMS läses av servern', (await one(`select notify_policy() p`)).p.criticalSms===true);

}
console.log('\n══════════════════════════════');
console.log(pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
