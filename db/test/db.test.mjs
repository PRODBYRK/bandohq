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
await R('booking','cp1',{id:'cp1',studio:'A',date:'2026-11-20',start:'10:00',end:'13:00',who:'RKAY',title:'x',circleId:'',status:''});
const n1 = await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'booking',id:'cp1',data:{id:'cp1',title:'ÄLDRE'},up:0},
  {kind:'agenda',id:'offline',data:{id:'offline',text:'NYARE'},up:99},
  {kind:'goal',id:'g2',data:{id:'g2',owner:'adrey',text:'kapat'},up:99},
  {kind:'artist',id:'a1',data:{id:'a1',n:'Nova'},up:5}])}));
ok('push: äldre post skriver inte över, okänd post läggs till', n1===2, n1);
ok('push: titeln på cp1 orörd', (await one(`select data->>'title' t from records where id='cp1'`)).t==='x');
ok('push: nyare post vinner', (await one(`select data->>'text' t from records where id='offline'`)).t==='NYARE');
const n2 = await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'booking',id:'s2',data:{id:'s2',title:'KAPAT',studio:'B',date:'2026-11-10',start:'18:00',end:'21:00',circleId:'c2'},up:999},
  {kind:'booking',id:'s1',data:{id:'s1',title:'KAPAT'},up:999},
  {kind:'circle',id:'c2',data:{id:'c2',n:'Kapad',leader:'RKAY',members:[]},up:999},
  {kind:'agenda',id:'offline2',data:{id:'offline2',text:'går igenom'},up:1}])}));
ok('cirkelpass, cirklar och pass som var cirkelpass går inte att skriva direkt — resten av omgången går igenom', n2===1
   && (await one(`select data->>'title' t from records where id='s2'`)).t!=='KAPAT' && (await one(`select data->>'title' t from records where id='s1'`)).t==='x'
   && (await one(`select data->>'n' n from records where id='c2'`)).n==='Grupp 2', n2);
ok('push: någon annans mål hoppas över, inte kapas', (await one(`select data->>'text' t from records where id='g2'`)).t==='ADREYs hemliga mål');
const rkSees = (await as(db,U.rkay,()=>q(`select id from members`))).map(r=>r.id).sort();
ok('producenten ser crewet, kunderna och deltagarna i cirkeln hen leder — inte andras deltagare',
   JSON.stringify(rkSees)===JSON.stringify(['adrey','az','kund','nora','rkay','sofia']), rkSees);
ok('admin ser alla', (await as(db,U.az,()=>q(`select id from members`))).length===7);
ok('producenten ser bara cirklar hen leder', JSON.stringify((await as(db,U.rkay,()=>q(`select id from records where kind='circle'`))).map(r=>r.id))==='["c2"]');

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
ok('deltagaren ser ledarens namn och kontakt (för avbokning med kort varsel)', pv.people.length===1 && pv.people[0].name==='Sofia Marks' && pv.people[0].email==='sofia@b.se', pv.people);
ok('och studions upptagna tider utan namn eller titel — inte sin egen cirkels', Array.isArray(pv.busy) && pv.busy.some(b=>b.id==='s2')
   && pv.busy.every(b=>!('who' in b) && !('title' in b)) && !pv.busy.some(b=>b.id==='s1'), pv.busy);
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
ok('ett pass är alltid tre timmar', /tre timmar/.test(await boom(()=>as(db,U.will,()=>rpc('request_session',{p_circle:'c1',p_date:'2026-12-02',p_start:'18:00',p_end:'22:00'})))||''));
ok('en deltagare kan inte svara på förfrågningar', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.will,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
ok('en annan ledare kan inte heller', /Bara cirkelns ledare/.test(await boom(()=>as(db,ny3,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
await bk('busy',{date:'2026-12-01',start:'17:00',end:'22:00',studio:'A',circleId:'',who:'RKAY'});
ok('godkännande mot upptagen studio nekas', /hann bli upptagen/.test(await boom(()=>as(db,U.sofia,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'A'})))||''));
const ap = await as(db,U.sofia,()=>rpc('answer_request',{p_booking:req.id,p_approve:true,p_studio:'B'}));
ok('ledaren godkänner mot ledig studio', ap.status==='' && ap.studio==='B', ap);
ok('ledaren bokar ett pass själv', (await as(db,U.sofia,()=>rpc('book_circle_session',{p_circle:'c1',p_date:'2026-12-15',p_start:'18:00',p_end:'21:00',p_studio:'A'}))).status==='');
ok('men inte i en krockande tid', /upptagen/.test(await boom(()=>as(db,U.sofia,()=>rpc('book_circle_session',{p_circle:'c1',p_date:'2026-12-01',p_start:'19:00',p_end:'20:00',p_studio:'A'})))||''));
ok('närvaro för någon utanför cirkeln nekas', /inte med i cirkeln/.test(await boom(()=>as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:3,p_present:JSON.stringify(['nora'])})))||''));
ok('orimliga timmar nekas', /0,5 och 24/.test(await boom(()=>as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:40,p_present:JSON.stringify(['will'])})))||''));
const dn = await as(db,U.sofia,()=>rpc('complete_session',{p_booking:'s1',p_hours:3,p_present:JSON.stringify(['will'])}));
ok('ledaren markerar genomförd', dn.status==='done' && +dn.hours===3 && dn.completedBy==='Sofia Marks', dn);
ok('och timmarna landar hos deltagaren', +(await as(db,U.will,()=>rpc('my_view',{}))).hours.will===8);
ok('deltagaren kan inte markera genomförd', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.will,()=>rpc('complete_session',{p_booking:'s1',p_hours:24,p_present:JSON.stringify(['will'])})))||''));
ok('kunden kan inte boka direkt längre', /förfrågan/.test(await boom(()=>as(db,U.kund,()=>rpc('book_customer_slot',{p_date:'2026-12-02',p_start:'10:00',p_end:'13:00',p_studio:'A'})))||''));
const cb = await as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-02',p_start:'10:00',p_end:'13:00',p_studio:'A',p_note:'Mix'}));
ok('kunden skickar en förfrågan, markerad betald — utan studio, crewet väljer', cb.paid===true && cb.who==='Studio Nord AB' && cb.status==='request' && cb.studio==='', cb);
ok('kundens förfrågan är alltid tre timmar', /tre timmar/.test(await boom(()=>as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-02',p_start:'10:00',p_end:'14:00',p_studio:''})))||''));
ok('en tid där en studio är ledig går bra', (await as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-01',p_start:'14:00',p_end:'17:00'}))).status==='request');
ok('men inte när båda studiorna är upptagna', /fullbokad/.test(await boom(()=>as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2026-12-01',p_start:'18:00',p_end:'21:00',p_studio:''})))||''));
ok('och inte bakåt i tiden', /framåt i tiden/.test(await boom(()=>as(db,U.kund,()=>rpc('request_customer_slot',{p_date:'2020-01-01',p_start:'10:00',p_end:'13:00',p_studio:''})))||''));
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
  p_date:'2026-12-15',p_start:'12:00',p_end:'15:00',p_studio:'',p_message:'EP',p_hp:''},o)));
ok('anonym ser upptagen tid utan namn', (await asAnon(db,()=>rpc('free_slots',{p_from:'2026-11-01',p_to:'2026-12-31'}))).every(x=>!('who' in x) && !('title' in x)));
ok('bokningssidan utan konto är stängd — man registrerar sig på /access', /bandohq\.se\/access/.test(await boom(()=>pr({}))||''));
await pr({p_hp:'robot'});
ok('honeypot: robotar får "ok" och inget sparas', (await q(`select * from leads`)).length===0);
/* förfrågningar som redan väntade när Access kom besvaras som förut */
let lseq = 0;
const L = (name, email, phone) => q(`insert into leads(id,name,email,phone,date,start_t,end_t,message,created_at)
  values($1,$2,$3,$4,'2026-12-15','12:00','15:00','EP', now() + make_interval(secs => $5))`, ['l_' + (++lseq), name, email, phone, lseq]);
await L('Nova Lind', 'nova@x.se', null);
const ls = (await q(`select member_id from outbox where kind='lead'`)).map(r=>r.member_id).sort();
ok('admins och managern får mejl om nya kunder', JSON.stringify(ls)==='["az","costa"]', ls);
const lr = (await q(`select * from outbox where kind='received'`))[0];
ok('och kunden får ett kvitto på mejlen', lr && lr.email==='nova@x.se' && !lr.member_id && /tagit emot din förfrågan om tis 15 dec 12:00-15:00/.test(lr.body), lr);
await L('Ola Tel', null, '+46739998877');
ok('crewet får numret i mejlet om den nya kunden', /Ny kund vill boka: Ola Tel \(\+46739998877\), /.test((await one(`select o.body from outbox o join leads l on o.dedupe_key = 'lead:'||l.id||':az' where l.name='Ola Tel'`)).body));
ok('och e-posten när den finns', /Ny kund vill boka: Nova Lind \(nova@x\.se\), tis 15 dec/.test((await one(`select body from outbox where kind='lead' and member_id='az' order by id limit 1`)).body));
ok('utan e-post går inget kvitto (crewet ringer)', !(await one(`select 1 from outbox o join leads l on o.dedupe_key = 'lead-rcv:'||l.id where l.name='Ola Tel'`)));
await q(`delete from leads where name='Ola Tel'`);
await L('Nova Lind', 'nova@x.se', null); await L('Nova Lind', 'nova@x.se', null);
ok('anonyma kan inte läsa förfrågningarna', (await asAnon(db,()=>q(`select * from leads`))).length===0);
ok('producenter kan inte heller', (await as(db,U.rkay,()=>q(`select * from leads`))).length===0);
ok('admin kan', (await C(()=>q(`select * from leads`))).length===3);
const lead = await one(`select id from leads order by created_at limit 1`);
ok('producent kan inte godkänna', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://x/'})))||''));
const ap = await C(()=>rpc('approve_lead',{p_lead:lead.id,p_studio:'B',p_url:'https://bandohq.se/'}));
const lb = await one(`select data from records where id=$1`,[ap.booking]);
ok('godkänt: bokningen ligger i schemat', lb.data.who==='Nova Lind' && lb.data.status==='' && lb.data.leadId===lead.id, lb.data);
const lmail = await one(`select * from outbox where dedupe_key=$1`,['lead-ok:'+lead.id]);
ok('och kunden får bekräftelsen med länken till sitt konto på mejlen', lmail && lmail.email==='nova@x.se' && lmail.link==='https://bandohq.se/access.html?inbjudan='+ap.invite
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
ok('kunden kan inte svara själv', /Bara admin och artistens producenter/.test(await boom(()=>as(db,U.kund,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'})))||''));
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

/* ============ v10 · AVBOKA SENAST EN TIMME INNAN ============ */
head('v10: avboka senast en timme innan');
/* svensk tid om x minuter, som datum och HH:MM */
const sthlm = min => { const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
  .formatToParts(new Date(Date.now()+min*60000)).map(x=>[x.type,x.value])); return {date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour==='24'?'00':p.hour}:${p.minute}`}; };
const plus3 = t => { const [h,m] = t.split(':').map(Number); return String((h+3)%24).padStart(2,'0')+':'+String(m).padStart(2,'0'); };
const soon = sthlm(30), later = sthlm(180);
await bk('kSoon',{date:soon.date,start:soon.time,end:plus3(soon.time),studio:'A',circleId:'',who:'Studio Nord AB',status:'',reqBy:'kund'});
await bk('kLater',{date:later.date,start:later.time,end:plus3(later.time),studio:'B',circleId:'',who:'Studio Nord AB',status:'',reqBy:'kund'});
ok('kunden kan inte avboka när det är mindre än en timme kvar — ska höra av sig till sin producent',
   /mindre än en timme kvar — hör av dig till RKAY/.test(await boom(()=>as(db,U.kund,()=>rpc('cancel_my_booking',{p_booking:'kSoon'})))||''));
ok('men tre timmar innan går det', (await as(db,U.kund,()=>rpc('cancel_my_booking',{p_booking:'kLater'}))).del===true);
const kc = await q(`select member_id, kind, subject, body from outbox where dedupe_key like 'cancel:kLater:%'`);
ok('avbokningen mejlas till kundens producent — inte till kunden själv', kc.length===1 && kc[0].member_id==='rkay' && kc[0].kind==='cancel'
   && /Studio Nord AB har avbokat .*THE BOOTH.*Tiden är ledig igen/.test(kc[0].body), kc);
const kvc = await as(db,U.kund,()=>rpc('my_view',{}));
ok('kundens vy har producentens kontaktuppgifter', kvc.contact && kvc.contact.name==='RKAY' && kvc.contact.email==='rkay@b.se', kvc.contact);
await bk('wSoon',{date:soon.date,start:soon.time,end:plus3(soon.time),studio:'B',status:'',reqBy:'nora'});
await bk('wLater',{date:later.date,start:later.time,end:plus3(later.time),studio:'A',status:'',reqBy:'nora'});
await bk('wGroup',{date:later.date,start:later.time,end:plus3(later.time),studio:'A',status:''});
ok('deltagaren avbokar sitt godkända pass i god tid', (await as(db,U.nora,()=>rpc('cancel_my_booking',{p_booking:'wLater'}))).del===true);
const wc = (await q(`select member_id from outbox where dedupe_key like 'cancel:wLater:%' order by member_id`)).map(r=>r.member_id);
ok('ledaren och de andra i cirkeln får veta att passet är avbokat', wc.includes('sofia') && wc.includes('will') && !wc.includes('nora'), wc);
await as(db,U.rkay,()=>q(`update records set data = data || '{"del":true}', del = true where id = 'wGroup'`));
ok('crewet som tar bort ett pass utlöser ingen avbokningsnotis', !(await one(`select 1 from outbox where dedupe_key like 'cancel:wGroup:%'`)));
await q(`update records set data = data - 'del', del = false where id = 'wGroup'`);
ok('men inte med under en timme kvar — ska höra av sig till ledaren', /mindre än en timme kvar — hör av dig till Sofia Marks/.test(await boom(()=>as(db,U.nora,()=>rpc('cancel_my_booking',{p_booking:'wSoon'})))||''));
const wgErr = await boom(()=>as(db,U.nora,()=>rpc('cancel_my_booking',{p_booking:'wGroup'})));
ok('och inte gruppens pass som ledaren bokat', /inte din/.test(wgErr||''), wgErr);

/* ============ v10 · CREWET LÄGGER TILL KUNDER OCH DELTAGARE ============ */
head('v10: producenter lägger till kunder och deltagare');
await as(db,U.rkay,()=>q(`insert into members(id,role,name,email,producer) values('k_ny','customer','Kund Ny','kundny@b.se','rkay')`));
ok('en producent lägger in en kund', !!(await one(`select 1 from members where id='k_ny' and role='customer'`)));
await as(db,U.rkay,()=>q(`insert into members(id,role,name) values('d_ny','participant','Deltagare Ny')`));
ok('och en cirkeldeltagare', !!(await one(`select 1 from members where id='d_ny'`)));
ok('men ingen annan roll', !!(await boom(()=>as(db,U.rkay,()=>q(`insert into members(id,role,name) values('p_ny','producer','Ny Producent')`)))));
ok('och aldrig med en inloggning kopplad', !!(await boom(()=>as(db,U.rkay,()=>q(`insert into members(id,user_id,role,name) values('k_x','${U.nora}','customer','Kapad')`)))));
ok('kamerateamet kan inte lägga till någon', !!(await boom(()=>K(()=>q(`insert into members(id,role,name) values('k_m','customer','Moez Kund')`)))));
await q(`delete from outbox`);
const tkn = await as(db,U.rkay,()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:14,p_max:1,p_member:'k_ny',p_email:'kund.ny@b.se',p_url:'https://bandohq.se/'}));
ok('producenten bjuder in kunden — e-posten sparas och mejlet går', /^[0-9A-F]{4}-/.test(tkn) && (await one(`select email from members where id='k_ny'`)).email==='kund.ny@b.se'
   && !!(await one(`select 1 from outbox where dedupe_key=$1 and email='kund.ny@b.se'`,['invite:'+tkn])));
ok('men får inte bjuda in som producent', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:1,p_member:'k_ny',p_url:'x'})))||''));
ok('eller bjuda in någon i crewet', /bara bjuda in kunder/.test(await boom(()=>as(db,U.rkay,()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:14,p_max:1,p_member:'adrey',p_email:'a@b.se',p_url:'x'})))||''));
ok('eller skapa öppna länkar', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('create_invite',{p_role:'participant',p_circle:'c1',p_days:14,p_max:null})))||''));
ok('kamerateamet bjuder inte in', /Bara admin/.test(await boom(()=>K(()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:14,p_max:1,p_member:'k_ny',p_url:'x'})))||''));

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
await q(`insert into records(kind,id,data,up) values('circle','c3',$1,1)`,[JSON.stringify({id:'c3',n:'Grupp 3',leader:'ADREY',members:[]})]);
const ta1 = await C(()=>rpc('create_invite',{p_role:'producer',p_circle:null,p_days:14,p_max:9,p_member:'adrey',p_email:'adrey@gmail.com',p_url:'https://bandohq.se/'}));
ok('inbjudan till ADREY sparar e-posten på personen', (await one(`select email from members where id='adrey'`)).email==='adrey@gmail.com');
const ta2 = await C(()=>rpc('create_invite',{p_role:'admin',p_circle:null,p_days:7,p_max:1,p_member:'adrey',p_url:'https://bandohq.se/'}));
ok('"skicka igen" stänger den förra länken', (await one(`select closed from invites where token=$1`,[ta1])).closed===true);
ok('och det nya mejlet går till samma adress, som admin denna gång', /som admin/.test((await one(`select body, email from outbox where dedupe_key=$1`,['invite:'+ta2])).body)
   && (await one(`select email from outbox where dedupe_key=$1`,['invite:'+ta2])).email==='adrey@gmail.com');
ok('ADREY leder Grupp 3 — mejlet säger "admin och cirkelledare för Grupp 3"', /som admin och cirkelledare för Grupp 3\./.test((await one(`select body from outbox where dedupe_key=$1`,['invite:'+ta2])).body));
const ai = await asAnon(db,()=>rpc('invite_info',{p_token:ta2}));
ok('och länken vet vilka cirklar ADREY leder', JSON.stringify(ai.leads)==='["Grupp 3"]', ai.leads);
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

/* ============ iPHONE-APPEN · PUSH VIA APNs, RADERA MITT KONTO ============ */
head('iPhone-appen: enhetstoken och radera mitt konto');
const T64 = 'ab'.repeat(32), T2 = 'cd'.repeat(32);
ok('anonyma kan inte spara en enhetstoken', /Logga in|permission denied/.test(await boom(()=>asAnon(db,()=>rpc('save_device_token',{p_token:T64,p_env:'production'})))||''));
ok('skräp som token nekas', /Ogiltig enhetstoken/.test(await boom(()=>as(db,U.kund,()=>rpc('save_device_token',{p_token:'hej',p_env:'production'})))||''));
await as(db,U.kund,()=>rpc('save_device_token',{p_token:'<'+T64.toUpperCase()+'>',p_env:'production'}));
await as(db,U.nora,()=>rpc('save_device_token',{p_token:T2,p_env:'sandbox'}));
const dv = await q(`select member_id, endpoint, kind, p256dh from push_subs where endpoint like 'apns:%' order by endpoint`);
ok('token sparas som apns:<token> (gemener), sandbox för utvecklingsbyggen', dv.length===2 && dv[0].endpoint==='apns:'+T64 && dv[0].kind==='apns'
   && dv[0].member_id==='kund' && dv[0].p256dh===null && dv[1].kind==='apns-sandbox', dv);
ok('utskicket hittar telefonen', (await q(`select kind from push_targets('kund')`)).some(r=>r.kind==='apns'));
ok('man ser bara sina egna enheter', (await as(db,U.kund,()=>q(`select endpoint from push_subs`))).every(r=>r.endpoint==='apns:'+T64));
await as(db,U.nora,()=>rpc('save_device_token',{p_token:T64,p_env:'production'}));
ok('samma telefon med ett annat konto tar över raden', (await one(`select member_id from push_subs where endpoint=$1`,['apns:'+T64])).member_id==='nora');
await as(db,U.nora,()=>rpc('remove_push_sub',{p_endpoint:'apns:'+T64}));
ok('utloggning tar bort telefonen', !(await one(`select 1 from push_subs where endpoint=$1`,['apns:'+T64])));
await as(db,U.kund,()=>rpc('save_device_token',{p_token:T64,p_env:'production'}));

ok('anonyma kan inte radera något', /permission denied|Inget konto/.test(await boom(()=>asAnon(db,()=>rpc('delete_my_account',{})))||''));
ok('den interna raderingen går inte att anropa direkt', /permission denied/.test(await boom(()=>as(db,U.kund,()=>q(`select bs_erase_member(m) from members m where id='rkay'`)))||''));
ok('den enda managern kan inte radera sig själv', /enda managern/.test(await boom(()=>as(db,U.az,()=>rpc('delete_my_account',{})))||''));
await q(`insert into records(kind,id,data,up) values('booking','kdel',$1,1)`,[JSON.stringify({id:'kdel',studio:'A',date:'2026-12-29',start:'10:00',end:'13:00',who:'Studio Nord AB',status:'',reqBy:'kund'})]);
const dk = await as(db,U.kund,()=>rpc('delete_my_account',{}));
ok('kunden raderar sitt eget konto', dk.deleted==='Studio Nord AB', dk);
ok('kontot, inloggningen och telefonen är borta', !(await one(`select 1 from members where id='kund'`)) && !(await one(`select 1 from auth.users where id=$1`,[U.kund]))
   && !(await one(`select 1 from push_subs where endpoint=$1`,['apns:'+T64])));
ok('namnet är borta ur passen', (await one(`select data from records where id='kdel'`)).data.who==='Raderad person');

/* ============ CIRKLARNA · ETAPP 1: LEDARE, KROCKAR, TIMBANK, HISTORIK, ANMÄLNINGAR ============ */
head('cirklarna: ledar-id, krockar, timbank, historik och anmälningar');
U.lea = await user('lea@b.se'); U.lars = await user('lars@b.se');
await M('lea', U.lea, 'leader', 'Lea Ström', 'lea@b.se', null);
await M('lars', U.lars, 'leader', 'Lars Berg', 'lars@b.se', null);
for (const [id,n] of [['pa','Pia Ask'],['pb','Per Bo'],['pc','Pål Ceder'],['pd','Pim Dahl']]) await M(id, null, 'participant', n, id+'@b.se', null);
await C(()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'circle',id:'k1',data:{id:'k1',n:'Prod 1',subject:'Musikproduktion',leader:'Lea Ström',members:['pa','pb']},up:1},
  {kind:'circle',id:'k2',data:{id:'k2',n:'Art 1',subject:'Artistutveckling',leader:'Lars Berg',members:['pb','pc']},up:1}])}));
const mem0 = await q(`select circle_id, member_id from circle_membership where circle_id in ('k1','k2') and left_at is null order by 1,2`);
ok('medlemshistoriken får en rad per deltagare när cirkeln skapas', mem0.length===4, mem0);

const b1 = await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-11-23',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
ok('cirkelpasset får ledarens id', b1.leaderId==='lea', b1);
ok('ett cirkelpass är 3 timmar', /cirkelpass är 3 timmar/.test(await boom(()=>as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-11-24',p_start:'10:00',p_end:'12:00',p_studio:'A'})))||''));
ok('ledaren kan inte ha två pass samtidigt', /Krock: Lea Ström har redan Prod 1 10:00–13:00/.test(await boom(()=>as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-11-23',p_start:'11:00',p_end:'14:00',p_studio:'B'})))||''));
ok('en deltagare kan inte vara i två cirklar samtidigt', /Krock: Per Bo är med i Prod 1 10:00–13:00/.test(await boom(()=>as(db,U.lars,()=>rpc('book_circle_session',{p_circle:'k2',p_date:'2026-11-23',p_start:'12:00',p_end:'15:00',p_studio:'B'})))||''));
ok('men utan gemensamma deltagare går det', (await as(db,U.lars,()=>rpc('book_circle_session',{p_circle:'k2',p_date:'2026-11-23',p_start:'13:00',p_end:'16:00',p_studio:'B'}))).status==='');
await R('booking','rkS',{id:'rkS',studio:'A',date:'2026-11-26',start:'10:00',end:'13:00',who:'RKAY',title:'Mix',circleId:'',status:''});
ok('en producent som leder krockar också med sina egna studiopass', /Krock: RKAY har redan Mix 10:00–13:00/.test(await boom(()=>as(db,U.rkay,()=>rpc('book_circle_session',{p_circle:'c2',p_date:'2026-11-26',p_start:'11:00',p_end:'14:00',p_studio:'B'})))||''));
ok('producenten kan inte boka i en cirkel hen inte leder', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.rkay,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-11-27',p_start:'10:00',p_end:'13:00',p_studio:'A'})))||''));
ok('admin kan', (await C(()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-11-27',p_start:'10:00',p_end:'13:00',p_studio:'A'}))).leaderId==='lea');

/* timbanken: gränsen gäller från leaderMaxFrom — här 6 timmar från 2027 */
await C(()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'circles',data:{leaderYearMax:6,leaderMaxFrom:2027,warn:[3]},up:5}])}));
ok('producenter kan inte ändra cirkelreglerna', (await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'circles',data:{leaderYearMax:9999},up:99}])})))===0);
await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-12-01',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-12-02',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
ok('2026 har ingen gräns (fler än 6 timmar går)', true);
await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2027-01-11',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2027-01-12',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
const lh = await q(`select member_id, subject, body from outbox where dedupe_key like 'lhours:lea:2027:%' order by member_id`);
ok('ledaren och admins får veta när timbanken är full', lh.some(r=>r.member_id==='lea' && /Timbanken är full/.test(r.subject) && /Du har 6 av 6 timmar 2027/.test(r.body))
   && lh.some(r=>r.member_id==='az' && /Lea Ström har 6 av 6/.test(r.body)) && !lh.some(r=>r.member_id==='rkay'), lh);
ok('2026 ger ingen timbanksnotis (gränsen gäller från 2027)', !(await one(`select 1 from outbox where dedupe_key like 'lhours:lea:2026:%'`)));
ok('2027: timbanken stoppar pass som går över gränsen', /Lea Ström har 6 av 6 timmar 2027/.test(await boom(()=>as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2027-01-13',p_start:'10:00',p_end:'13:00',p_studio:'A'})))||''));
const plan = await as(db,U.lars,()=>rpc('circle_plan_check',{p_circle:'k2',p_dates:JSON.stringify(['2027-02-01','2027-02-08','2027-02-15']),p_start:'10:00',p_studio:'A'}));
ok('förhandsvisning av återkommande pass räknar in de tidigare i omgången', plan.length===3 && plan[0].ok && plan[1].ok && !plan[2].ok && /6 av 6 timmar 2027/.test(plan[2].reason), plan);
const lv2 = await as(db,U.lea,()=>rpc('my_view',{}));
ok('ledaren ser sin timbank och reglerna', lv2.leaderHours && +lv2.leaderHours['2027'].planned===6 && lv2.circleCfg.leaderYearMax===6, [lv2.leaderHours, lv2.circleCfg]);
await C(()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'circles',data:{},up:6}])}));

/* flytta och ställa in */
const mv = await as(db,U.lea,()=>rpc('update_circle_session',{p_booking:b1.id,p_date:'2026-11-24',p_start:'14:30',p_studio:'A'}));
ok('ledaren flyttar passet — slutet räknas ut (3 timmar)', mv.start==='14:30' && mv.end==='17:30' && mv.studio==='A', mv);
ok('inte till en krockande tid', /Krock/.test(await boom(()=>as(db,U.lea,()=>rpc('update_circle_session',{p_booking:b1.id,p_date:'2026-11-27',p_start:'11:00',p_studio:'B'})))||''));
ok('någon annan ledare kan inte flytta det', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.lars,()=>rpc('update_circle_session',{p_booking:b1.id,p_date:'2026-11-23',p_start:'09:00',p_studio:'B'})))||''));
await as(db,U.lea,()=>rpc('complete_session',{p_booking:b1.id,p_hours:3,p_present:JSON.stringify(['pa','pb'])}));
ok('ett genomfört pass går inte att flytta', /redan genomfört/.test(await boom(()=>as(db,U.lea,()=>rpc('update_circle_session',{p_booking:b1.id,p_date:'2026-11-24',p_start:'10:00',p_studio:'A'})))||''));
ok('eller ställa in', /genomfört/.test(await boom(()=>as(db,U.lea,()=>rpc('cancel_circle_session',{p_booking:b1.id})))||''));
const b2 = await as(db,U.lea,()=>rpc('book_circle_session',{p_circle:'k1',p_date:'2026-12-03',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
ok('ett bokat pass går att ställa in', (await as(db,U.lea,()=>rpc('cancel_circle_session',{p_booking:b2.id}))).del===true);
ok('producenten som inte leder kan inte markera andras pass genomförda', /Bara cirkelns ledare/.test(await boom(()=>as(db,U.rkay,()=>rpc('complete_session',{p_booking:b1.id,p_hours:3,p_present:'[]'})))||''));

/* ledarbyte och medlemshistorik */
const fut = await as(db,U.lars,()=>rpc('book_circle_session',{p_circle:'k2',p_date:'2026-12-20',p_start:'10:00',p_end:'13:00',p_studio:'A'}));
await C(()=>rpc('push_records',{rows:JSON.stringify([{kind:'circle',id:'k2',data:{id:'k2',n:'Art 1',subject:'Artistutveckling',leader:'Lea Ström',members:['pc','pd']},up:10}])}));
const fd = (await one(`select data from records where id=$1`,[fut.id])).data;
ok('ny ledare: kommande pass följer med', fd.leaderId==='lea' && fd.who==='Lea Ström', fd);
const hist = await q(`select member_id, left_at is not null as left from circle_membership where circle_id='k2' order by member_id`);
ok('historiken visar vem som lämnade och vem som kom', JSON.stringify(hist)===JSON.stringify([{member_id:'pb',left:true},{member_id:'pc',left:false},{member_id:'pd',left:false}]), hist);
ok('bara admin ser historiken', (await as(db,U.lea,()=>q(`select 1 from circle_membership`))).length===0 && (await C(()=>q(`select 1 from circle_membership`))).length>0);

/* dubbletter och att lägga till deltagare */
const dup = await C(()=>rpc('find_duplicates',{p_name:'pia  ask',p_email:'',p_phone:''}));
ok('dubblettkontrollen hittar samma namn (oavsett stora bokstäver och mellanslag)', dup.length===1 && dup[0].id==='pa' && dup[0].why==='samma namn', dup);
ok('och samma e-post', (await C(()=>rpc('find_duplicates',{p_name:'Någon Annan',p_email:'PB@b.se',p_phone:''})))[0].why==='samma e-post');
ok('en deltagare får inget svar', (await as(db,U.lea,()=>rpc('find_duplicates',{p_name:'Pia Ask',p_email:'',p_phone:''}))).length===0);
ok('ledaren lägger till en deltagare i sin cirkel', (await as(db,U.lea,()=>rpc('add_circle_member',{p_circle:'k1',p_member:'pc'}))).members.includes('pc'));
ok('men inte i någon annans', /Bara admin eller cirkelns ledare/.test(await boom(()=>as(db,U.lars,()=>rpc('add_circle_member',{p_circle:'k1',p_member:'pd'})))||''));
ok('och bara cirkeldeltagare', /inte cirkeldeltagare/.test(await boom(()=>as(db,U.lea,()=>rpc('add_circle_member',{p_circle:'k1',p_member:'rkay'})))||''));

/* anmälningar från foundation-sajten */
ok('utan nyckel tas ingen anmälan emot', /Obehörig/.test(await boom(()=>asAnon(db,()=>rpc('circle_signup',{p_secret:'x',p_name:'Ny Person',p_email:'ny@x.se',p_phone:'',p_subject:'',p_note:''})))||''));
await q(`insert into bs_secrets(name,value) values('signup','hemlig-123') on conflict (name) do update set value = excluded.value`);
ok('ingen kan läsa nyckeln', (await asAnon(db,()=>boom(()=>q(`select value from bs_secrets`))))!==null || (await as(db,U.az,()=>q(`select value from bs_secrets`))).length===0);
const su = await asAnon(db,()=>rpc('circle_signup',{p_secret:'hemlig-123',p_name:'Ny Person',p_email:'NY@x.se',p_phone:'070-111 22 33',p_subject:'Musikproduktion',p_note:''}));
ok('anmälan med rätt nyckel tas emot', su.ok===true && /^s_/.test(su.id), su);
ok('samma person igen blir ingen ny rad', (await asAnon(db,()=>rpc('circle_signup',{p_secret:'hemlig-123',p_name:'Ny Person',p_email:'ny@x.se',p_phone:'',p_subject:'',p_note:''}))).again===true);
ok('admin ser anmälningarna, producenter inte', (await C(()=>q(`select * from circle_signups`))).length===1 && (await as(db,U.rkay,()=>q(`select * from circle_signups`))).length===0);
const pl = await C(()=>rpc('place_signup',{p_signup:su.id,p_circle:'k1',p_member:null}));
const npm = await one(`select role, email, phone from members where id=$1`,[pl.member]);
ok('admin placerar anmälan: en ny deltagare i gruppen', npm.role==='participant' && npm.email==='ny@x.se' && npm.phone==='+46701112233'
   && (await one(`select data->'members' m from records where id='k1'`)).m.includes(pl.member), [pl, npm]);
const su2 = await asAnon(db,()=>rpc('circle_signup',{p_secret:'hemlig-123',p_name:'Pia Ask',p_email:'pia2@x.se',p_phone:'',p_subject:'',p_note:''}));
ok('en anmälan med ett namn som redan finns måste kopplas till personen', /redan en person som heter Pia Ask/.test(await boom(()=>C(()=>rpc('place_signup',{p_signup:su2.id,p_circle:null,p_member:null})))||''));
ok('och kan kopplas', (await C(()=>rpc('place_signup',{p_signup:su2.id,p_circle:null,p_member:'pa'}))).member==='pa');
const su3 = await asAnon(db,()=>rpc('circle_signup',{p_secret:'hemlig-123',p_name:'Spam Spamsson',p_email:'s@x.se',p_phone:'',p_subject:'',p_note:''}));
await C(()=>rpc('reject_signup',{p_signup:su3.id}));
ok('admin kan avvisa en anmälan', (await one(`select status from circle_signups where id=$1`,[su3.id])).status==='rejected');
ok('producenter kan inte placera', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('place_signup',{p_signup:su3.id,p_circle:null,p_member:null})))||''));

/* ============ CIRKLARNA · ETAPP 2: KONTROLL, LÅSNING, RAPPORT, HISTORIK ============ */
head('cirklarna: kontroll, låsning, rapport och historik');
const past = (id, o) => R('booking', id, Object.assign({id, studio:'A', date:'2026-10-01', start:'10:00', end:'13:00', who:'Lea Ström',
  title:'Prod 1', circleId:'k1', status:'done', hours:3, present:['pa'], leaderId:'lea', with:[], paid:false}, o));
await past('cx1', {});
await past('cx2', {date:'2026-10-02', hours:2});
await past('cx3', {date:'2026-10-03', status:'', hours:null, present:[]});
await past('cx4', {date:'2026-10-04', present:['rkay']});
const hb = await one(`select op, by_id from record_history where rec_id=$1 order by id desc limit 1`, [mv.id]);
ok('historiken sparar varje ändring av ett cirkelpass, med vem', hb && hb.by_id==='lea', hb);
const cs = await C(()=>rpc('check_sessions',{p_ids:JSON.stringify(['cx1','cx2','cx3','cx4',mv.id])}));
const why = Object.fromEntries(cs.skipped.map(x=>[x.id, x.reason]));
ok('admin godkänner ett korrekt genomfört pass', JSON.stringify(cs.checked)==='["cx1"]', cs);
ok('fel timmar godkänns inte', /Timmarna stämmer inte \(2 i stället för 3\)/.test(why.cx2), why);
ok('inte heller ett pass utan registrerad närvaro', /inte registrerad/.test(why.cx3));
ok('eller med närvarande som inte är med i gruppen', /inte med i gruppen/.test(why.cx4));
ok('eller ett pass som inte har varit än', /inte varit än/.test(why[mv.id]));
ok('producenter och ledare kan inte godkänna', /Bara admin/.test(await boom(()=>as(db,U.lea,()=>rpc('check_sessions',{p_ids:'["cx2"]'})))||'')
   && /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('check_sessions',{p_ids:'["cx2"]'})))||''));
ok('ett kontrollerat pass är låst för ledaren', /kontrollerat — admin måste låsa upp/.test(await boom(()=>as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx1',p_hours:2,p_present:'[]'})))||''));
await C(()=>rpc('push_records',{rows:JSON.stringify([{kind:'booking',id:'cx1',data:{id:'cx1',circleId:'k1',hours:9,status:'done'},up:9e12}])}));
ok('och kan inte ändras via synken — inte ens av admin', +(await one(`select data->>'hours' h from records where id='cx1'`)).h===3);
ok('ledaren ser status på sina pass, andra ledare inte', (await as(db,U.lea,()=>q(`select booking_id from session_reports`))).length===1
   && (await as(db,U.lars,()=>q(`select booking_id from session_reports`))).length===0);
ok('och i sin vy', (await as(db,U.lea,()=>rpc('my_view',{}))).reports.cx1==='checked');
ok('bara admin ser historiken', (await as(db,U.lea,()=>q(`select 1 from record_history`))).length===0);
const rp = await C(()=>rpc('report_sessions',{p_ids:JSON.stringify(['cx1','cx2'])}));
ok('rapporten tar bara kontrollerade pass', rp.length===1 && rp[0].id==='cx1', rp.map(x=>x.id));
ok('ögonblicksbilden har tid, timmar, grupp, ledare och de närvarande med kontakt', rp[0].circle==='Prod 1' && rp[0].leader==='Lea Ström' && +rp[0].hours===3
   && rp[0].present.length===1 && rp[0].present[0].name==='Pia Ask' && rp[0].present[0].email==='pa@b.se', rp[0]);
ok('status: rapporterat', (await one(`select status from session_reports where booking_id='cx1'`)).status==='reported');
const rsn = await C(()=>rpc('report_snapshots',{p_from:'2026-10-01',p_to:'2026-10-31'}));
ok('underlaget går att ta ut igen för en period', rsn.length===1 && rsn[0].id==='cx1' && !!rsn[0].reportedAt, rsn.length);
ok('upplåsning kräver en anledning', /Skriv varför/.test(await boom(()=>C(()=>rpc('unlock_session',{p_booking:'cx1',p_reason:''})))||''));
await C(()=>rpc('unlock_session',{p_booking:'cx1',p_reason:'Fel deltagare registrerad'}));
const un = await one(`select op, note from record_history where rec_id='cx1' order by id desc limit 1`);
ok('upplåst: anledningen sparas i historiken', un.op==='upplåst' && un.note==='Fel deltagare registrerad', un);
ok('och ledaren kan rätta passet igen', (await as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx1',p_hours:3,p_present:'["pa","pb"]'}))).present.length===2);
const ops = (await q(`select op from record_history where rec_id='cx1' order by id`)).map(r=>r.op).join(',');
ok('historiken visar hela kedjan', /skapad.*kontrollerat.*rapporterat.*upplåst.*ändrad/.test(ops), ops);
await C(()=>rpc('check_sessions',{p_ids:'["cx1"]'})); await C(()=>rpc('report_sessions',{p_ids:'["cx1"]'}));
await as(db,U.az,()=>rpc('delete_member',{p_id:'pb'}));
ok('raderas en person ligger den rapporterade ögonblicksbilden kvar (med namnet, för rapporteringen)',
   !(await one(`select 1 from members where id='pb'`))
   && (await one(`select snapshot from session_reports where booking_id='cx1'`)).snapshot.present.some(p=>p.name==='Per Bo'));

/* ============ CIRKLARNA · ETAPP 3: UTBILDNINGSSYSTEMET ============ */
head('cirklarna: kurser och lektioner');
await C(()=>rpc('push_records',{rows:JSON.stringify([
  {kind:'course',id:'kp',data:{id:'kp',subject:'Musikproduktion',levels:[{title:'Grund',lessons:[{id:'l1',title:'DAW-grunder'},{id:'l2',title:'Trummor'}]},{title:'Fördjupning',lessons:[{id:'l3',title:'Mix'}]}]},up:1},
  {kind:'circle',id:'k1',data:{id:'k1',n:'Prod 1',subject:'Musikproduktion',leader:'Lea Ström',members:['pa','pc'],courseId:'kp'},up:9e12}])}));
ok('producenter kan inte skapa eller ändra kurser', (await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([{kind:'course',id:'kx',data:{id:'kx'},up:1}])})))===0);
await past('cx5', {date:'2026-10-06', status:'', hours:null, present:[]});
const ls1 = await as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx5',p_hours:3,p_present:'["pa"]',p_lesson:'l1'}));
ok('ledaren markerar passet genomfört med lektionen', ls1.lessonId==='l1' && ls1.lessonTitle==='DAW-grunder', ls1);
ok('bara lektioner i gruppens kurs', /finns inte i gruppens kurs/.test(await boom(()=>as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx5',p_hours:3,p_present:'["pa"]',p_lesson:'nope'})))||''));
ok('utan lektion går också (grupp utan kurs, eller pass utan lektion)', (await as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx5',p_hours:3,p_present:'["pa"]'}))).lessonId==='');
await as(db,U.lea,()=>rpc('complete_session',{p_booking:'cx5',p_hours:3,p_present:'["pa"]',p_lesson:'l1'}));
const lvk = await as(db,U.lea,()=>rpc('my_view',{}));
ok('ledaren får kursen i sin vy', lvk.courses.length===1 && lvk.courses[0].id==='kp');
await C(()=>rpc('check_sessions',{p_ids:'["cx5"]'}));
const snap5 = await C(()=>rpc('report_sessions',{p_ids:'["cx5"]'}));
ok('lektionen följer med i rapporten', snap5[0].lesson==='DAW-grunder', snap5[0]);

/* ============ BANDO REWARDS ============ */
head('Bando Rewards: poäng, belöningar, nivåer, omdömen och artist intelligence');
/* poängtrappan för sig — bonusarna, kampanjerna och värva en vän har ett eget avsnitt längst ned */
await R('setting','rewards',{bonuses:{welcome:0,first:0,recurring:0},referral:{enabled:false}});
U.ku1 = await user('ku1@b.se'); U.pr2 = await user('pr2@b.se');
await M('ku1', U.ku1, 'customer', 'Kim Kund', 'ku1@b.se', null);
await q(`update members set producer='rkay' where id='ku1'`);
await M('pr2', U.pr2, 'producer', 'PR2', 'pr2@b.se', null);
const KB = (id, o) => R('booking', id, Object.assign({id, studio:'A', date:'2026-10-05', start:'10:00', end:'13:00', who:'Kim Kund', title:'Studiotid',
  circleId:'', status:'', with:[], paid:true}, o));
await KB('kb1', {}); await KB('kb2', {date:'2026-10-06', end:'16:00'}); await KB('kb3', {date:'2026-10-07', with:['PR2']}); await KB('kbF', {date:'2027-01-05'});
const clK = await as(db,U.rkay,()=>rpc('close_session',{p_booking:'kb1',p_paid:true,p_note:JSON.stringify({went:'Bra flyt',created:'Två verser',strengths:'Melodier',develop:'Andning',next:'Mixa',other:''})}));
ok('producenten avslutar kundens pass: 3 h = 100 poäng', clK.points===100 && clK.available===100, clK);
const kbK = (await one(`select data from records where id='kb1'`)).data;
ok('passet blir avslutat och betalt, med vem', kbK.closed===true && kbK.paid===true && kbK.closedBy==='RKAY', kbK);
await as(db,U.rkay,()=>rpc('close_session',{p_booking:'kb1',p_paid:true}));
ok('samma pass ger aldrig poäng två gånger', +(await one(`select sum(points) s from points where member_id='ku1'`)).s===100);
await as(db,U.rkay,()=>rpc('close_session',{p_booking:'kb1',p_paid:false}));
ok('avmarkeras betalt dras poängen tillbaka', +(await one(`select sum(points) s from points where member_id='ku1'`)).s===0
   && (await one(`select kind from points where booking_id='kb1' order by id desc limit 1`)).kind==='reversal');
await as(db,U.rkay,()=>rpc('close_session',{p_booking:'kb1',p_paid:true}));
ok('6 h = 500 poäng', (await as(db,U.rkay,()=>rpc('close_session',{p_booking:'kb2',p_paid:true}))).points===500);
ok('ett pass som inte har varit kan inte avslutas', /inte börjat/.test(await boom(()=>as(db,U.rkay,()=>rpc('close_session',{p_booking:'kbF',p_paid:true})))||''));
ok('en annan producent kan inte avsluta kundens pass', /Bara kundens producent/.test(await boom(()=>as(db,U.pr2,()=>rpc('close_session',{p_booking:'kb1',p_paid:true})))||''));
ok('men den som var med på passet kan', (await as(db,U.pr2,()=>rpc('close_session',{p_booking:'kb3',p_paid:true}))).points===100);
ok('cirkelpass har inga poäng', /Cirkelpass/.test(await boom(()=>as(db,U.lea,()=>rpc('close_session',{p_booking:'cx1',p_paid:true})))||''));

const meK = await as(db,U.ku1,()=>rpc('points_summary',{}));
ok('kunden ser sina poäng och sin historik', meK.available===700 && meK.earned===700 && meK.history.length===5 && meK.level.name==='Member', [meK.available, meK.history.length, meK.level]);
ok('och nästa nivå', meK.next.name==='Silver', meK.next);
ok('men aldrig omdömena', (await as(db,U.ku1,()=>rpc('artist_notes_for',{p_member:'ku1'}))).length===0);
ok('en annan kund ser inte någon annans poäng', /Inte behörig/.test(await boom(()=>as(db,U.ku1,()=>rpc('points_summary',{p_member:'rkay'})))||''));
ok('cirkelledare: ingen åtkomst till Rewards', /Inte behörig/.test(await boom(()=>as(db,U.lea,()=>rpc('points_summary',{p_member:'ku1'})))||'')
   && (await as(db,U.lea,()=>rpc('rewards_catalog',{})))===null && (await as(db,U.lea,()=>rpc('artist_notes_for',{p_member:'ku1'}))).length===0);
ok('ingen läser tabellerna direkt', (await as(db,U.rkay,()=>q(`select * from points`))).length===0 && (await as(db,U.az,()=>q(`select * from artist_notes`))).length===0);

const rnK = await as(db,U.rkay,()=>rpc('artist_notes_for',{p_member:'ku1'}));
ok('producenten ser omdömet på sin kunds pass', rnK.length===1 && rnK[0].went==='Bra flyt' && rnK[0].author==='RKAY' && rnK[0].date==='2026-10-05', rnK);
ok('en producent som inte var med ser det inte', (await as(db,U.pr2,()=>rpc('artist_notes_for',{p_member:'ku1'}))).length===0);
await as(db,U.pr2,()=>rpc('add_artist_note',{p_booking:'kb3',p_note:JSON.stringify({went:'Snabbt',next:'Vocals'})}));
ok('omdöme i efterhand på ett pass man var med på', (await as(db,U.pr2,()=>rpc('artist_notes_for',{p_member:'ku1'}))).length===1);
ok('admin ser alla omdömen', (await C(()=>rpc('artist_notes_for',{p_member:'ku1'}))).length===2);

ok('bara admin skapar belöningar', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('save_reward',{p:JSON.stringify({title:'Merch',cost:100})})))||''));
const rwA = await C(()=>rpc('save_reward',{p:JSON.stringify({title:'Hoodie',description:'Bando-hoodie',cost:600})}));
const rwB = await C(()=>rpc('save_reward',{p:JSON.stringify({title:'Gratis pass',cost:5000})}));
const catK = await as(db,U.ku1,()=>rpc('rewards_catalog',{}));
ok('kunden ser belöningarna, nivåerna och poängtrappan', catK.rewards.length===2 && catK.levels.length===4 && catK.tiers.length===2, catK);
const rdK = await as(db,U.ku1,()=>rpc('redeem_reward',{p_reward:rwA}));
ok('kunden löser in — poängen dras direkt', rdK.available===100, rdK);
ok('admins får veta', !!(await one(`select 1 from outbox where kind='reward' and member_id='az'`)));
ok('för få poäng går inte', /För få poäng — 100 av 5000/.test(await boom(()=>as(db,U.ku1,()=>rpc('redeem_reward',{p_reward:rwB})))||''));
ok('producenter kan inte lösa in åt kunden', /Bara kunder|Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('redeem_reward',{p_reward:rwA,p_member:'ku1'})))||''));
const pendK = await C(()=>rpc('pending_redemptions',{}));
ok('admin ser inlösningar som väntar', pendK.length===1 && pendK[0].name==='Kim Kund' && pendK[0].title==='Hoodie', pendK);
await C(()=>rpc('handle_redemption',{p_id:pendK[0].id,p_status:'cancelled'}));
ok('makulerad inlösen ger tillbaka poängen', (await as(db,U.ku1,()=>rpc('points_summary',{}))).available===700);
ok('en hanterad inlösen kan inte hanteras igen', /redan hanterad/.test(await boom(()=>C(()=>rpc('handle_redemption',{p_id:pendK[0].id,p_status:'delivered'})))||''));
ok('justering kräver en anledning', /Skriv varför/.test(await boom(()=>C(()=>rpc('adjust_points',{p_member:'ku1',p_points:400,p_note:''})))||''));
ok('saldot kan inte bli negativt', /negativt/.test(await boom(()=>C(()=>rpc('adjust_points',{p_member:'ku1',p_points:-5000,p_note:'Rättelse'})))||''));
await C(()=>rpc('adjust_points',{p_member:'ku1',p_points:400,p_note:'Välkomstbonus'}));
const lvK = await as(db,U.ku1,()=>rpc('points_summary',{}));
ok('nivån uppdateras automatiskt: 1 100 intjänat → Silver', lvK.level.name==='Silver' && lvK.next.name==='Gold', lvK.level);
ok('och kunden får en notis om nivån', !!(await one(`select 1 from outbox where kind='level' and member_id='ku1' and subject='Ny nivå: Silver'`)));
await C(()=>rpc('save_level',{p:JSON.stringify({id:'lv_silver',name:'Silver',rank:1,criteria:{minEarned:2000},perks:'10 % rabatt'})}));
ok('admin ändrar nivåns kriterier', (await as(db,U.ku1,()=>rpc('points_summary',{}))).level.name==='Member');

ok('Artist Intelligence: producenter utan behörighet ser ingenting', (await as(db,U.rkay,()=>rpc('artist_intel',{}))).length===0);
const aiR = await C(()=>rpc('artist_intel',{}));
const kim = aiR.find(x=>x.id==='ku1');
ok('admin ser bokningar, timmar, senaste och nästa pass, producenter och poäng', kim && +kim.bookings===3 && +kim.hours===12 && kim.last==='2026-10-07' && kim.next==='2027-01-05'
   && kim.producers.includes('RKAY') && kim.producers.includes('PR2') && kim.available===1100 && kim.notes===2 && kim.status==='återkommande', kim);
ok('RKAY kan inte ge sig själv behörighet', !!(await as(db,U.rkay,()=>q(`update members set perms='{artist_intel}' where id='rkay'`).then(()=>null)), true)
   && (await one(`select perms from members where id='rkay'`)).perms.length===0);
await C(()=>rpc('set_member_perms',{p_member:'rkay',p_perms:'["artist_intel"]'}));
ok('admin ger RKAY behörigheten — då ser RKAY Artist Intelligence', (await as(db,U.rkay,()=>rpc('artist_intel',{}))).length>0);
await as(db,U.rkay,()=>rpc('save_artist_crm',{p_member:'ku1',p:JSON.stringify({projects:'EP i vår',goals:'Spelning',followup:'2026-11-01',followup_note:'Ring om EP:n'})}));
ok('och kan föra uppföljning', (await C(()=>rpc('artist_intel',{}))).find(x=>x.id==='ku1').crm.followup_note==='Ring om EP:n');
ok('utan behörighet går det inte', /Inte behörig/.test(await boom(()=>as(db,U.pr2,()=>rpc('save_artist_crm',{p_member:'ku1',p:'{}'})))||''));

}

/* ============ BANDO HQ ACCESS ============ */
{
head('Access: registreringen');
await q(`delete from outbox`);
/* giltiga personnummer: kontrollsiffran räknas fram (Luhn på ÅÅMMDDNNN) */
const luhn = d => { let s=0; [...d].forEach((c,i)=>{ let x=+c*(i%2===0?2:1); s+=Math.floor(x/10)+x%10; }); return (10 - s%10) % 10; };
const pnr = (ymd, nnn) => ymd + '-' + nnn + luhn(ymd.slice(2) + nnn);
const P1 = pnr('19990315','123'), P2 = pnr('20050704','456'), P3 = pnr('19870101','789'), P4 = pnr('19920202','246'), P5 = pnr('20010911','135');
const AD = fn => as(db, U.costa, fn);
const AU = {};
for (const k of ['a1','a2','a3','a4','a5','a6','a7','a8','old','oldp']) AU[k] = await user(k + '@acc.se');
/* en kund och en deltagare från tiden före Access (med inloggning, utan personnummer) */
await M('oldk', AU.old, 'customer', 'Studio Syd AB', 'old@acc.se', '070-000 00 20');
await M('oldp', AU.oldp, 'participant', 'Petra Gammal', 'oldp@acc.se', '070-000 00 21');
/* nya konton kräver en kundinbjudan — varje registrering får en egen om testet inte anger någon */
let invN = 0;
const mkInv = async (o={}) => { const t = 'INV-' + String(++invN).padStart(6,'0');
  await q(`insert into invites(token,role,created_by,max_uses,name,email,member_id,interests) values($1,'customer',$2,1,$3,$4,$5,$6)`,
    [t, o.by||'az', o.name||null, o.email||null, o.member||null, o.interests||[]]); return t; };
const reg = async (u, o) => { o = Object.assign({}, o); if(!('p_invite' in o)) o.p_invite = await mkInv();
  return as(db, u, ()=>rpc('register_access', Object.assign({p_name:'Alva Strand', p_phone:'070-123 45 67', p_pnr:P1,
    p_interests:JSON.stringify(['production','mixing']), p_consent:true, p_url:'https://www.bandohq.se/'}, o))); };

const info = await asAnon(db,()=>rpc('access_info',{}));
ok('registreringssidan får tolv inriktningar och sex förmåner — utan priser', info.interests.length===12 && info.perks.length===6
   && !('services' in info) && info.interests[0].label==='Låtskrivning & textförfattande' && !('subject' in info.interests[0]), info);
ok('anonyma kan inte registrera någon', /permission denied|Skapa kontot/.test(await boom(()=>asAnon(db,()=>rpc('register_access',{p_name:'X Y',p_phone:'0701234567',p_pnr:P1,p_interests:'["rap"]',p_consent:true})))||''));
ok('för- och efternamn krävs', /för- och efternamn/.test(await boom(()=>reg(AU.a1,{p_name:'Alva'}))||''));
ok('namnet får inte innehålla siffror', /bokstäver/.test(await boom(()=>reg(AU.a1,{p_name:'Alva 2 Strand'}))||''));
ok('telefonnumret kontrolleras', /mobilnummer/.test(await boom(()=>reg(AU.a1,{p_phone:'123'}))||''));
ok('personnummer med fel kontrollsiffra nekas', /Personnumret stämmer inte/.test(await boom(()=>reg(AU.a1,{p_pnr:P1.slice(0,-1) + ((+P1.slice(-1)+1)%10)}))||''));
ok('personnummer med omöjligt datum nekas', /Personnumret stämmer inte/.test(await boom(()=>reg(AU.a1,{p_pnr:pnr('19991332','123')}))||''));
ok('personnummer i framtiden nekas', /Personnumret stämmer inte/.test(await boom(()=>reg(AU.a1,{p_pnr:pnr('20991201','123')}))||''));
ok('minst en inriktning', /minst en inriktning/.test(await boom(()=>reg(AU.a1,{p_interests:'[]'}))||''));
ok('bara inriktningar som finns', /Okänd inriktning: golf/.test(await boom(()=>reg(AU.a1,{p_interests:'["golf"]'}))||''));
ok('samtycket krävs', /personuppgifter/.test(await boom(()=>reg(AU.a1,{p_consent:false}))||''));
ok('inget sparades av de nekade försöken', !(await one(`select 1 from members where user_id=$1`,[AU.a1])) && (await one(`select count(*)::int n from member_pnr`)).n===0);

const r1 = await reg(AU.a1, {});
const m1 = await one(`select * from members where id=$1`, [r1.id]);
ok('registrerad: en kund som också är cirkeldeltagare', r1.ok && !r1.linked && m1.role==='customer' && m1.participant===true && m1.user_id===AU.a1
   && m1.email==='a1@acc.se' && m1.phone==='+46701234567' && m1.source==='access' && m1.registered_at && m1.consent_at
   && JSON.stringify(m1.interests)==='["mixing","production"]', m1);
const pr1 = await one(`select encode(pnr_enc,'hex') e, pnr_hash, birth from member_pnr where member_id=$1`, [r1.id]);
const plain = Buffer.from(P1.replace('-','')).toString('hex');
ok('personnumret är krypterat — inte i klartext, inte i kontot', pr1 && !pr1.e.includes(plain) && pr1.birth==='990315'
   && !JSON.stringify(m1).includes(P1.slice(-4) + '"') && pr1.pnr_hash.length===64, pr1);
ok('kunden når inte personnummertabellen', /permission denied/.test(await boom(()=>as(db,AU.a1,()=>q(`select * from member_pnr`)))||''));
ok('inte producenter heller', /permission denied/.test(await boom(()=>as(db,U.rkay,()=>q(`select * from member_pnr`)))||''));
ok('inte ens admin direkt — bara via funktionerna', /permission denied/.test(await boom(()=>AD(()=>q(`select * from member_pnr`)))||''));
const wel = await one(`select * from outbox where kind='welcome'`);
ok('välkomstmejl till personen', wel && wel.email==='a1@acc.se' && wel.subject==='Välkommen till Bando HQ' && /Hej Alva!/.test(wel.body)
   && /Musikproduktion & beatmaking/.test(wel.body) && wel.link==='https://www.bandohq.se/', wel);
const adm = (await q(`select member_id, body from outbox where kind='access' order by member_id`));
const admIds = (await q(`select id from members where active and role::text in ('manager','admin') order by id`)).map(x=>x.id).join();
ok('admins och managern får "Ny registrering" med inriktningarna', adm.map(x=>x.member_id).join()===admIds && admIds.includes('costa')
   && /Alva Strand \(a1@acc\.se, \+46701234567\)/.test(adm[0].body) && /Mixning & mastering/.test(adm[0].body), adm);
const st1 = await as(db,AU.a1,()=>rpc('access_status',{}));
ok('access_status: kopplad och komplett', st1.member && st1.complete && JSON.stringify(st1.missing)==='{}', st1);
const v1 = await as(db,AU.a1,()=>rpc('my_view',{}));
ok('prislistan: åtta studiopaket (1 session 1 500 kr … 8 sessions 6 500 kr) och mix & master 1 500 kr/låt',
   v1.access.packages.length===8 && v1.access.packages[0].price===1500 && v1.access.packages[0].hours===3 && v1.access.packages[7].price===6500
   && v1.access.packages[7].hours===24 && v1.access.services[0].price===1500 && v1.access.notes.length===2, v1.access.packages);
ok('kundvyn har priserna och förmånerna, profilen och ingen grupp än', v1.access.services.length===5 && v1.access.perks.length===6
   && v1.profile.pnr===true && v1.profile.consent===true && v1.circle===null && v1.group.length===0, {c:v1.circle, p:v1.profile});
ok('och kontot i vyn innehåller inget personnummer', !JSON.stringify(v1).includes(P1.slice(-4) + '"') && !('pnr_enc' in v1.me));
ok('samma inloggning kan inte registrera ett konto till', (await reg(AU.a1,{p_pnr:P2})).completed===true
   && (await one(`select count(*)::int n from members where user_id=$1`,[AU.a1])).n===1);
await reg(AU.a1, {});      // tillbaka till P1

head('Access: dubbletter');
const r2 = await reg(AU.a2, {p_name:'Annan Person', p_phone:'0739990001'});
ok('samma personnummer → inget nytt konto, logga in i stället', r2.ok===false && r2.exists===true && /redan ett konto/.test(r2.why), r2);
ok('och den nya inloggningen tas bort igen', !(await one(`select 1 from auth.users where id=$1`,[AU.a2])) && !(await one(`select 1 from members where name='Annan Person'`)));
ok('personnumret i 10-siffrig form känns igen som samma', (await reg(AU.a3, {p_name:'Tredje Försök', p_pnr:P1.slice(2)})).exists===true);
await M('lk1', null, 'customer', 'Leo Krona', 'a4@acc.se', null);
await R('booking','lkb',{id:'lkb',studio:'A',date:'2026-09-01',start:'10:00',end:'13:00',who:'Leo Krona',title:'Studiotid',circleId:'',status:'',present:[],with:[]});
const r4 = await reg(AU.a4, {p_name:'Leo Kronberg', p_phone:'0701112233', p_pnr:P2});
const m4 = await one(`select * from members where id='lk1'`);
ok('kund som crewet lagt in (samma e-post) → inloggningen kopplas till den raden', r4.ok && r4.linked && r4.id==='lk1' && m4.user_id===AU.a4
   && m4.name==='Leo Krona' && m4.participant && m4.registered_at, {r4, m4});
ok('namnet och passen följer med — ingen dubblett', (await one(`select count(*)::int n from members where lower(name) like 'leo kron%'`)).n===1
   && (await as(db,AU.a4,()=>rpc('my_view',{}))).bookings.some(b=>b.id==='lkb'));
await M('lb1', null, 'participant', 'Lina Berg', null, '0702223344');
const r5 = await reg(AU.a5, {p_name:'lina  berg', p_phone:'+46702223344', p_pnr:P3});
ok('deltagare från anmälningskön (samma telefon och namn) → kopplas och blir kund och deltagare', r5.linked && r5.id==='lb1'
   && (await one(`select role from members where id='lb1'`)).role==='customer', r5);
await M('ns1', null, 'customer', 'Nils Sten', null, '0705556677');
const r6 = await reg(AU.a6, {p_name:'Annie Sten', p_phone:'0705556677', p_pnr:P4});
ok('samma telefon men annat namn kopplas inte (familjer delar nummer)', r6.ok && !r6.linked && r6.id!=='ns1', r6);
const r7 = await reg(AU.a7, {p_name:'Nora Lind', p_phone:'0708889900', p_pnr:P5});
ok('samma namn som någon annan → eget konto med en siffra', r7.ok && !r7.linked && r7.name==='Nora Lind 2', r7);

head('Access: befintliga kunder och deltagare');
const stK = await as(db,AU.old,()=>rpc('access_status',{}));
ok('en kund från tiden före Access saknar personnummer, inriktning och samtycke', stK.member && !stK.complete
   && stK.missing.pnr && stK.missing.interests && stK.missing.consent && !stK.missing.phone, stK);
ok('och kan inte använda någon annans personnummer', /annat konto/.test(await boom(()=>reg(AU.old,{p_pnr:P2}))||''));
const rk = await reg(AU.old, {p_name:'Ignoreras', p_phone:'', p_pnr:pnr('19800505','111'), p_interests:'["industry"]'});
const mk = await one(`select * from members where id='oldk'`);
ok('kompletterar profilen: namnet och telefonen behålls', rk.completed && mk.name==='Studio Syd AB' && mk.phone==='070-000 00 20'
   && mk.consent_at && mk.interests[0]==='industry' && mk.role==='customer', mk);
await reg(AU.oldp, {p_name:'x', p_phone:'', p_pnr:pnr('20000101','222'), p_interests:'["rap"]'});
ok('en deltagare som kompletterar behåller sin roll', (await one(`select role, consent_at from members where id='oldp'`)).role==='participant');
ok('crewkonton registrerar sig inte', /crewkonto/.test(await boom(()=>reg(U.rkay,{p_pnr:pnr('19750101','333')}))||''));
ok('access_status för crewet: komplett', (await as(db,U.rkay,()=>rpc('access_status',{}))).complete===true);

head('Access: skyddet');
await as(db,AU.a1,()=>q(`update members set interests='{golf}', consent_at=null, participant=false, registered_at=null where user_id=$1`,[AU.a1]));
const g1 = await one(`select interests, consent_at, participant, registered_at from members where id=$1`,[r1.id]);
ok('kunden kan inte ändra inriktning, samtycke eller deltagande direkt', g1.interests.join()==='mixing,production' && g1.consent_at && g1.participant && g1.registered_at, g1);
ok('men byter inriktning via set_my_interests', JSON.stringify(await as(db,AU.a1,()=>rpc('set_my_interests',{p_interests:'["vocals","rap"]'})))==='["rap","vocals"]');
ok('och bara till inriktningar som finns', /Okänd/.test(await boom(()=>as(db,AU.a1,()=>rpc('set_my_interests',{p_interests:'["golf"]'})))||''));
await AD(()=>q(`update members set consent_at = null, registered_at = null where id=$1`,[r1.id]));
ok('inte ens admin ändrar samtycket i efterhand', !!(await one(`select consent_at from members where id=$1`,[r1.id])).consent_at);
ok('producenter kan inte lägga in en person med påhittat samtycke', /row-level security|violates/.test(await boom(()=>as(db,U.rkay,()=>q(
  `insert into members(id,role,name,consent_at) values('fake1','customer','Fake Fejk',now())`)))||''));
const masks = await AD(()=>rpc('pnr_masks',{}));
ok('admin ser personnumren maskerade', masks[r1.id]==='990315-••••' && Object.keys(masks).length>=7, masks);
ok('producenter ser inga', JSON.stringify(await as(db,U.rkay,()=>rpc('pnr_masks',{})))==='{}');
ok('producenter kan inte visa ett personnummer', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('reveal_pnr',{p_member:r1.id})))||''));
ok('kunden kan inte visa sitt eget heller', /Bara admin/.test(await boom(()=>as(db,AU.a1,()=>rpc('reveal_pnr',{p_member:r1.id})))||''));
ok('admin visar det', (await AD(()=>rpc('reveal_pnr',{p_member:r1.id})))===P1);
ok('och visningen loggas', !!(await one(`select 1 from record_history where kind='member' and rec_id=$1 and op='personnummer visat' and by_id='costa'`,[r1.id])));
const rp = await AD(()=>rpc('report_pnrs',{p_members:JSON.stringify([r1.id,'lk1','okänd'])}));
ok('rapportunderlaget får personnumren — och det loggas per person', rp[r1.id]===P1 && rp.lk1===P2 && !rp['okänd']
   && (await one(`select count(*)::int n from record_history where op='personnummer i rapport'`)).n===2, rp);
ok('producenter får inget rapportunderlag', /Bara admin/.test(await boom(()=>as(db,U.rkay,()=>rpc('report_pnrs',{p_members:JSON.stringify([r1.id])})))||''));
const ap1 = await AD(()=>rpc('access_people',{}));
ok('admin ser registreringsdatum, källa och maskerat personnummer', ap1.find(x=>x.id===r1.id).source==='access' && ap1.find(x=>x.id===r1.id).pnr==='990315-••••');

head('Access: cirkeln');
const cm = await AD(()=>rpc('add_circle_member',{p_circle:'c1',p_member:r1.id}));
ok('admin placerar en kund som är deltagare i en cirkel', cm.members.includes(r1.id));
await q(`update members set participant=false where id='ns1'`);
ok('en kund som inte är deltagare kan inte placeras', /inte cirkeldeltagare/.test(await boom(()=>AD(()=>rpc('add_circle_member',{p_circle:'c1',p_member:'ns1'})))||''));
const v2 = await as(db,AU.a1,()=>rpc('my_view',{}));
ok('kunden ser sin grupp, ansvarig producent och gruppens kommande pass', v2.circle && v2.circle.id==='c1' && v2.circle.leader==='Sofia Marks'
   && v2.leaderContact.phone==='070-000 00 04' && v2.group.length>0 && !v2.group.some(g=>g.id==='rqN')
   && (await q(`select id from records where kind='booking' and not del and data->>'circleId'='c1' and coalesce(data->>'status','')=''
        and (data->>'date')::date >= current_date`)).length===v2.group.length, {c:v2.circle, g:v2.group});
ok('utan egen producent är gruppens ledare kontakten vid sen avbokning', v2.contact && v2.contact.name==='Sofia Marks', v2.contact);
ok('närvaron är aldrig automatisk: inga timmar förrän ledaren markerat', +v2.circleHours===0);
await q(`update records set data = jsonb_set(data, '{present}', data->'present' || to_jsonb($1::text)) where id='d1'`, [r1.id]);
ok('när ledaren markerat närvaro räknas timmarna', +(await as(db,AU.a1,()=>rpc('my_view',{}))).circleHours===3);

head('Access: inställningarna');
const acc = {interests:[{id:'production',label:'Produktion & beats',subject:'Musikproduktion'},{id:'rap',label:'Rap',subject:'Artistutveckling',off:true}],
  services:[{id:'mix',name:'Mix & master',price:2000,access:1500,unit:'per låt'}]};
await as(db,U.rkay,()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'access',data:acc,up:10}])}));
ok('producenter ändrar inte Access-inställningarna', !(await one(`select 1 from records where kind='setting' and id='access'`)));
await AD(()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'access',data:acc,up:10}])}));
const info2 = await asAnon(db,()=>rpc('access_info',{}));
ok('admin ändrar inriktningarna — sidan visar dem direkt, dolda syns inte', info2.interests.length===1 && info2.interests[0].label==='Produktion & beats'
   && info2.perks.length===6, info2.interests);
ok('och priserna syns för kunden', (await as(db,AU.a1,()=>rpc('my_view',{}))).access.services[0].access===1500);
ok('paketen ligger kvar när admin inte ändrat dem', (await as(db,AU.a1,()=>rpc('my_view',{}))).access.packages.length===8);
ok('en dold inriktning går inte att välja vid registrering', /Okänd inriktning: rap/.test(await boom(()=>reg(AU.a8,{p_name:'Åsa Öst',p_pnr:pnr('19950505','777'),p_interests:'["rap"]'}))||''));
ok('men den som redan har den behåller den', JSON.stringify(await as(db,AU.a1,()=>rpc('set_my_interests',{p_interests:'["rap","production"]'})))==='["production","rap"]');
ok('svenska tecken i namnet går bra', (await reg(AU.a8,{p_name:'Åsa Öst-Ärlig',p_phone:'0761234567',p_pnr:pnr('19950505','777'),p_interests:'["production"]'})).name==='Åsa Öst-Ärlig');

head('Access: radering och #boka');
await as(db,AU.a8,()=>rpc('delete_my_account',{}));
ok('radera mitt konto tar bort personnumret också', (await one(`select count(*)::int n from member_pnr p left join members m on m.id=p.member_id where m.id is null`)).n===0
   && !(await one(`select 1 from members where name='Åsa Öst-Ärlig'`)));
}

/* ============ ALLMÄN AGENDA OCH MÅLSÄTTNING ============ */
{
head('Allmän agenda (gemensamt) och målsättning (personligt)');
await q(`delete from outbox`);
const J = rows => JSON.stringify(rows), MK = fn => as(db,U.moez,fn), CA = fn => as(db,U.costa,fn);
const box = async k => q(`select * from outbox where dedupe_key like $1 order by id`,[k]);
const kg = await MK(()=>rpc('push_records',{rows:J([
  {kind:'goal',id:'mg1',data:{id:'mg1',owner:'moez',text:'Bättre ljussättning',cat:'utveckling',status:'aktiv'},up:9e12},
  {kind:'goal',id:'mg2',data:{id:'mg2',owner:'rkay',text:'Kapa RKAYs mål',status:'aktiv'},up:9e12},
  {kind:'plan',id:'moez',data:{id:'moez',text:'Min plan'},up:9e12},
  {kind:'plan',id:'rkay',data:{id:'rkay',text:'Fejk'},up:9e12}])}));
ok('kamerateamet skriver sin egen målsättning — mål och plan, inget åt andra', kg===2 && !(await one(`select 1 from records where id='mg2'`))
   && (await one(`select data->>'text' t from records where kind='plan' and id='rkay'`)||{t:''}).t!=='Fejk', kg);
const kr = (await MK(()=>q(`select id from records where kind in ('goal','plan') order by id`))).map(r=>r.id);
ok('och ser bara sin egen', JSON.stringify(kr)==='["mg1","moez"]', kr);
ok('ingen annan i teamet ser den — inte producenter, inte admin, bara managern', !(await as(db,U.rkay,()=>q(`select 1 from records where id='mg1'`))).length
   && !(await CA(()=>q(`select 1 from records where id='mg1'`))).length && (await as(db,U.az,()=>q(`select 1 from records where id='mg1'`))).length===1);
ok('målsättningen skickar inga notiser', (await q(`select 1 from outbox`)).length===0);

await q(`insert into records(kind,id,data,up) values('agenda','gen1','{"id":"gen1","kind":"general","cat":"projekt","who":"","by":"az","text":"Eget releasebolag"}',1)`);
await q(`delete from outbox`);
const kgen = await MK(()=>rpc('push_records',{rows:J([
  {kind:'agenda',id:'gen2',data:{id:'gen2',kind:'general',cat:'mojlighet',who:'',by:'moez',text:'Festivaler i sommar'},up:9e12},
  {kind:'agenda',id:'gen1',data:{id:'gen1',kind:'general',cat:'projekt',who:'',by:'az',text:'Kapat',done:true},up:9e12},
  {kind:'agenda',id:'gen3',data:{id:'gen3',kind:'general',cat:'projekt',who:'',by:'rkay',text:'I RKAYs namn'},up:9e12}])}));
ok('kamerateamet lägger till i allmänna agendan — men ändrar inte andras punkter och skriver inte i andras namn', kgen===1
   && !!(await one(`select 1 from records where id='gen2'`)) && (await one(`select data->>'text' t from records where id='gen1'`)).t==='Eget releasebolag'
   && !(await one(`select 1 from records where id='gen3'`)), kgen);
ok('alla i teamet läser den — kamerateamet också', (await MK(()=>q(`select id from records where kind='agenda' and data->>'kind'='general'`))).length===2);
const gb = (await box('agenda-gen:%')).map(r=>r.member_id).sort();
ok('en ny punkt i allmänna agendan → hela teamet utom den som skrev, aldrig deltagare eller kunder', gb.includes('az') && gb.includes('costa') && gb.includes('rkay')
   && !gb.includes('moez') && !gb.includes('oldk') && !gb.some(x=>x==='nora'), gb);
await as(db,U.rkay,()=>rpc('push_records',{rows:J([{kind:'agenda',id:'gen4',data:{id:'gen4',kind:'general',cat:'ambition',who:'ADREY',by:'rkay',text:'Gammal punkt med namn'},up:9e12}])}));
ok('även en äldre punkt med namn går till hela teamet — aldrig som personlig uppgift', (await box('agenda:adrey:%')).length===0
   && (await box('agenda-gen:adrey:%')).length===1);
await q(`insert into members(id,role,name) values('tmpc','camera','Tillfällig Kamera')`);
await q(`insert into records(kind,id,data,up) values
  ('agenda','gen5','{"id":"gen5","kind":"general","cat":"utveckling","who":"","by":"tmpc","text":"Bättre bilder"}',1),
  ('agenda','wk5','{"id":"wk5","kind":"week","who":"Tillfällig Kamera","text":"Egen uppgift"}',1),
  ('goal','tg5','{"id":"tg5","owner":"tmpc","text":"Eget mål"}',1)`);
await as(db,U.az,()=>rpc('delete_member',{p_id:'tmpc'}));
const g5 = await one(`select del, data->>'by' b from records where id='gen5'`), w5 = await one(`select del from records where id='wk5'`), t5 = await one(`select del from records where id='tg5'`);
ok('radera en person: punkterna i allmänna agendan ligger kvar (utan namnet), det personliga försvinner', g5 && !g5.del && g5.b==='' && w5.del && t5.del, {g5, w5, t5});
}

/* ============ PRODUCENTER PER ARTIST ============ */
{
head('Producenter per artist (och RKAY som admin och producent)');
await q(`delete from outbox`);
const J = rows => JSON.stringify(rows), CA = fn => as(db,U.costa,fn);
const box = async k => q(`select * from outbox where dedupe_key like $1 order by id`,[k]);
/* en admin som också producerar, och en artist med två producenter */
const pu = await user('prodadmin@b.se'), ar = await user('artist7@b.se'), pz = await user('prod9@b.se');
await q(`insert into members(id,user_id,role,name,email,perms) values('pa1',$1,'admin','Prod Admin','prodadmin@b.se','{producer}')`,[pu]);
await q(`insert into members(id,user_id,role,name,email) values('pz9',$1,'producer','PZ','prod9@b.se')`,[pz]);
await q(`insert into members(id,user_id,role,name,email,producers,producer) values('ar7',$1,'customer','Artist Sju','artist7@b.se','{pa1,pz9}','pa1')`,[ar]);
await q(`insert into member_pnr(member_id,pnr_enc,pnr_hash,birth) values('ar7','\\x00','h-ar7','990101')`);
const prodOk = (await one(`select bs_is_producer('pa1') a, bs_is_producer('pz9') b, bs_is_producer('costa') c, bs_is_producer('rkay') d`));
ok('producent är en egenskap: admin med behörigheten producer räknas, admin utan gör det inte', prodOk.a && prodOk.b && !prodOk.c && prodOk.d, prodOk);
const AR = fn => as(db, ar, fn);
const v7 = await AR(()=>rpc('my_view',{}));
ok('artisten ser sina producenter — och bara dem', JSON.stringify(v7.producers.map(p=>p.name))==='["PZ","Prod Admin"]', v7.producers);
const req = (o) => AR(()=>rpc('request_customer_slot', Object.assign({p_date:'2026-12-14',p_start:'12:00',p_end:'15:00',p_studio:'',p_note:'',p_with:'[]'}, o)));
ok('artist med producenter måste välja en', /Välj vilken producent/.test(await boom(()=>req({}))||''));
ok('och kan inte boka med någon annans', /Du kan inte boka med RKAY/.test(await boom(()=>req({p_with:'["RKAY"]'}))||''));
ok('okänd producent nekas', /Okänd producent/.test(await boom(()=>req({p_with:'["Ingen Alls"]'}))||''));
await q(`insert into records(kind,id,data,up) values('booking','pzbusy','{"id":"pzbusy","studio":"A","date":"2026-12-14","start":"13:00","end":"16:00","who":"RKAY","with":["PZ"],"status":""}',1)`);
ok('en upptagen producent går inte att boka den tiden', /PZ är upptagen/.test(await boom(()=>req({p_with:'["PZ"]'}))||''));
ok('upptagen tid syns för artisten utan namn eller titel', v7.producerBusy.length===0
   && (await AR(()=>rpc('my_view',{}))).producerBusy.some(x=>x.name==='PZ' && x.date==='2026-12-14' && x.start==='13:00' && !('who' in x) && !('title' in x)));
const r1 = await req({p_with:'["Prod Admin"]'});
ok('artisten bokar med sin producent: producenten står på passet', JSON.stringify(r1.with)==='["Prod Admin"]' && r1.status==='request', r1);
const toR = (await q(`select member_id from outbox where dedupe_key like $1`, ['req:'+r1.id+'%'])).map(x=>x.member_id).sort();
ok('förfrågan går till admins och den valda producenten — inte till den andra', toR.includes('pa1') && toR.includes('az') && !toR.includes('pz9'), toR);
ok('en producent artisten inte valt kan inte svara', /artistens producenter/.test(await boom(()=>as(db,pz,()=>rpc('answer_request',{p_booking:r1.id,p_approve:true,p_studio:'B'})))||''));
const ans = await as(db,pu,()=>rpc('answer_request',{p_booking:r1.id,p_approve:true,p_studio:'B'}));
ok('den valda producenten godkänner', ans.status==='' && ans.studio==='B', ans);
const bk = (await q(`select member_id from outbox where kind='booked'`)).map(x=>x.member_id);
ok('bekräftelsen går till artisten och producenten', bk.includes('ar7') && bk.includes('pa1'), bk);
await q(`update records set data = data || '{"date":"2026-10-01","start":"10:00","end":"13:00"}'::jsonb where id=$1`, [r1.id]);
ok('producenten artisten bokat med får avsluta passet', (await as(db,pu,()=>rpc('close_session',{p_booking:r1.id,p_paid:true,p_note:null}))).points===100);
ok('kontakten vid sen avbokning är huvudproducenten', (await AR(()=>rpc('my_view',{}))).contact.name==='Prod Admin');
const ai = (await CA(()=>rpc('artist_intel',{}))).find(x=>x.id==='ar7');
ok('Artist Intelligence listar artistens producenter', ai.producers.includes('PZ') && ai.producers.includes('Prod Admin'), ai.producers);
/* bara admin väljer producenterna */
await AR(()=>q(`update members set producers='{rkay}' where id='ar7'`));
await as(db,pz,()=>q(`update members set producers='{rkay}' where id='ar7'`).catch(()=>null));
ok('artisten och en producent kan inte ändra listan', JSON.stringify((await one(`select producers from members where id='ar7'`)).producers)==='["pa1","pz9"]');
await CA(()=>q(`update members set producers='{pz9}', producer='pz9' where id='ar7'`));
ok('admin ändrar den', JSON.stringify((await one(`select producers from members where id='ar7'`)).producers)==='["pz9"]');
/* en artist utan producenter väljer ingen — förfrågan går till admins */
const nu = await user('artist8@b.se');
await q(`insert into members(id,user_id,role,name,email) values('ar8',$1,'customer','Artist Åtta','artist8@b.se')`,[nu]);
await q(`insert into member_pnr(member_id,pnr_enc,pnr_hash,birth) values('ar8','\\x00','h-ar8','990101')`);
ok('en artist utan producenter kan inte välja någon', /crewet väljer/.test(await boom(()=>as(db,nu,()=>rpc('request_customer_slot',{p_date:'2026-12-15',p_start:'12:00',p_end:'15:00',p_studio:'',p_note:'',p_with:'["PZ"]'})))||''));
const r8 = await as(db,nu,()=>rpc('request_customer_slot',{p_date:'2026-12-15',p_start:'12:00',p_end:'15:00',p_studio:'',p_note:'',p_with:'[]'}));
ok('men bokar utan — som förut', r8.status==='request' && r8.with.length===0, r8);
}

/* ============ ACCESS VIA FÖRFRÅGAN ELLER INBJUDAN ============ */
{
head('Access via förfrågan eller inbjudan');
await q(`delete from outbox`);
const CA = fn => as(db,U.costa,fn), RK = fn => as(db,U.rkay,fn);
const box = async k => q(`select * from outbox where dedupe_key like $1 order by id`,[k]);
const luhn = d => { let s=0; [...d].forEach((c,i)=>{ let x=+c*(i%2===0?2:1); s+=Math.floor(x/10)+x%10; }); return (10 - s%10) % 10; };
const pnr = (ymd, nnn) => ymd + '-' + nnn + luhn(ymd.slice(2) + nnn);
const AU_K = await user('kund9@ny.se');
await q(`insert into members(id,user_id,role,name,email) values('kund9',$1,'customer','Kund Nio','kund9@ny.se')`,[AU_K]);
const ra = o => asAnon(db,()=>rpc('request_access', Object.assign({p_name:'Mira Ny', p_email:'mira@ny.se', p_phone:'070-765 43 21',
  p_interests:'["production"]', p_message:'Jag skriver och sjunger R&B.', p_consent:true, p_hp:''}, o)));
ok('förfrågan kräver för- och efternamn, e-post, telefon, inriktning och godkännande',
   /för- och efternamn/.test(await boom(()=>ra({p_name:'Mira'}))||'') && /e-postadress/.test(await boom(()=>ra({p_email:'mira'}))||'')
   && /mobilnummer/.test(await boom(()=>ra({p_phone:'12'}))||'') && /minst en inriktning/.test(await boom(()=>ra({p_interests:'["golf"]'}))||'')
   && /Godkänn/.test(await boom(()=>ra({p_consent:false}))||''));
ok('robotar (dolt fält) får "ok" men inget sparas', (await ra({p_hp:'x'})).ok===true && (await q(`select 1 from access_requests`)).length===0);
const r1 = await ra({});
const row = await one(`select * from access_requests where email='mira@ny.se'`);
ok('en anonym förfrågan sparas — utan lösenord och personnummer', r1.ok===true && row && row.status==='new' && row.phone==='+46707654321'
   && JSON.stringify(row.interests)==='["production"]' && row.message==='Jag skriver och sjunger R&B.', row);
const crew = (await q(`select member_id from outbox where kind='access-req'`)).map(x=>x.member_id).sort();
ok('admins, managern och producenterna får "Förfrågan om Bando HQ Access"', crew.includes('az') && crew.includes('costa') && crew.includes('rkay')
   && !crew.includes('moez') && !crew.includes('will'), crew);
ok('och personen får ett kvitto', !!(await one(`select 1 from outbox where kind='received' and email='mira@ny.se' and subject='Vi har tagit emot din förfrågan'`)));
await ra({p_message:'Nytt meddelande'});
ok('samma e-post igen blir ingen ny rad', (await q(`select 1 from access_requests where email='mira@ny.se'`)).length===1
   && (await one(`select message from access_requests where email='mira@ny.se'`)).message==='Nytt meddelande');
await ra({p_name:'Någon Annan', p_email:'rkay@b.se'});
ok('en e-post som redan har konto: ingen rad, men adressen får ett mejl om det', !(await one(`select 1 from access_requests where email='rkay@b.se'`))
   && !!(await one(`select 1 from outbox where email='rkay@b.se' and subject='Du har redan ett konto i Bando HQ'`)));
ok('crewet ser förfrågningarna — kunder och anonyma gör det inte', (await RK(()=>q(`select 1 from access_requests`))).length===1
   && (await as(db,AU_K,()=>q(`select 1 from access_requests`))).length===0 && (await asAnon(db,()=>q(`select 1 from access_requests`))).length===0);
ok('en kund kan inte godkänna', /Bara admin och producenter/.test(await boom(()=>as(db,AU_K,()=>rpc('approve_access',{p_id:row.id,p_url:'https://www.bandohq.se/'})))||''));
const ap = await RK(()=>rpc('approve_access',{p_id:row.id,p_url:'https://www.bandohq.se/'}));
const inv = await one(`select * from invites where token=$1`,[ap.invite]);
ok('en producent godkänner: en kundinbjudan med uppgifterna från förfrågan', inv && inv.role==='customer' && inv.created_by==='rkay' && inv.email==='mira@ny.se'
   && inv.phone==='+46707654321' && JSON.stringify(inv.interests)==='["production"]' && inv.request_id===row.id && inv.max_uses===1, inv);
const im = await one(`select * from outbox where dedupe_key=$1`,['invite:'+ap.invite]);
ok('och personen får länken till Access-sidan på mejlen', im && im.email==='mira@ny.se' && im.kind==='invite-access'
   && im.link==='https://www.bandohq.se/access.html?inbjudan='+ap.invite && /godkänd/.test(im.body), im);
ok('förfrågan är besvarad', (await one(`select status, invite, handled_by from access_requests where id=$1`,[row.id])).status==='approved');
ok('och kan inte godkännas igen', /finns inte längre/.test(await boom(()=>CA(()=>rpc('approve_access',{p_id:row.id,p_url:'x'})))||''));
const info = await asAnon(db,()=>rpc('invite_info',{p_token:ap.invite}));
ok('Access-sidan får uppgifterna via länken', info.ok && info.role==='customer' && info.name==='Mira Ny' && info.phone==='+46707654321'
   && JSON.stringify(info.interests)==='["production"]' && info.by==='RKAY', info);
/* kontot */
const mu = await user('mira@ny.se'), xu = await user('utan@ny.se'), yu = await user('igen@ny.se');
const regA = (u, o) => as(db, u, ()=>rpc('register_access', Object.assign({p_name:'Mira Ny', p_phone:'070-765 43 21', p_pnr:pnr('19980202','314'),
  p_interests:'["production"]', p_consent:true, p_url:'https://www.bandohq.se/'}, o)));
ok('utan inbjudan går det inte att skapa ett konto', /kräver en inbjudan/.test(await boom(()=>regA(xu, {}))||''));
ok('med en påhittad inbjudan inte heller', /kräver en inbjudan/.test(await boom(()=>regA(xu, {p_invite:'FAKE-123456'}))||''));
const okA = await regA(mu, {p_invite:ap.invite});
const mm = await one(`select * from members where id=$1`,[okA.id]);
ok('med inbjudan skapas kontot — och producenten som godkände blir artistens producent', okA.ok && mm.role==='customer'
   && JSON.stringify(mm.producers)==='["rkay"]' && mm.producer==='rkay', mm);
ok('inbjudan är förbrukad', (await one(`select uses from invites where token=$1`,[ap.invite])).uses===1
   && /redan använd/.test(await boom(()=>regA(yu, {p_invite:ap.invite, p_pnr:pnr('19970303','222')}))||''));
/* avböj */
await ra({p_name:'Nej Tack', p_email:'nej@ny.se'});
const nr = await one(`select id from access_requests where email='nej@ny.se'`);
await CA(()=>rpc('decline_access',{p_id:nr.id,p_reason:'Vi är fulla till våren.'}));
const nm = await one(`select * from outbox where dedupe_key=$1`,['acc-no:'+nr.id]);
ok('avböjd: personen får ett vänligt mejl med raden', nm && nm.email==='nej@ny.se' && /Vi är fulla till våren/.test(nm.body)
   && (await one(`select status from access_requests where id=$1`,[nr.id])).status==='declined', nm);
/* direktinbjudan */
ok('direktinbjudan till en adress med konto nekas', /redan ett konto/.test(await boom(()=>RK(()=>rpc('invite_access',{p_name:'X Y',p_email:'rkay@b.se',p_phone:'',p_interests:'[]',p_url:'https://www.bandohq.se/'})))||''));
const di = await RK(()=>rpc('invite_access',{p_name:'Direkt Inbjuden',p_email:'direkt@ny.se',p_phone:'',p_interests:'["production"]',p_url:'https://www.bandohq.se/'}));
const dm = await one(`select * from outbox where dedupe_key=$1`,['invite:'+di.invite]);
ok('en producent bjuder in direkt — länken till Access-sidan på mejlen', dm && dm.email==='direkt@ny.se' && dm.kind==='invite-access' && /av RKAY/.test(dm.body), dm);
const di2 = await RK(()=>rpc('invite_access',{p_name:'Direkt Inbjuden',p_email:'direkt@ny.se',p_phone:'',p_interests:'[]',p_url:'https://www.bandohq.se/'}));
ok('en ny inbjudan till samma adress stänger den förra', (await one(`select closed from invites where token=$1`,[di.invite])).closed===true && di2.invite!==di.invite);
/* inbjudan till en person som crewet redan lagt in */
await q(`insert into members(id,role,name,email) values('crw1','customer','Crew Inlagd','crewinlagd@ny.se')`);
const ci = await CA(()=>rpc('create_invite',{p_role:'customer',p_circle:null,p_days:14,p_max:1,p_team:null,p_name:null,p_email:null,p_url:'https://www.bandohq.se/',p_member:'crw1'}));
const cm = await one(`select * from outbox where dedupe_key=$1`,['invite:'+ci]);
ok('kundinbjudningar från appen länkar också till Access-sidan', cm && cm.kind==='invite-access' && cm.link==='https://www.bandohq.se/access.html?inbjudan='+ci, cm);
const cu = await user('crewinlagd@ny.se');
const cr = await as(db, cu, ()=>rpc('register_access',{p_name:'Annat Namn',p_phone:'0701112299',p_pnr:pnr('19960404','333'),p_interests:'["production"]',p_consent:true,p_url:null,p_invite:ci}));
ok('och kontot kopplas till personen crewet lade in', cr.ok && cr.linked && cr.id==='crw1' && (await one(`select user_id from members where id='crw1'`)).user_id===cu, cr);
}
/* ============ REWARDS: BONUSPOÄNG, KAMPANJER OCH VÄRVA EN VÄN ============ */
{
head('Rewards: bonuspoäng, kampanjer och värva en vän');
await q(`delete from outbox`);
const CA = fn => as(db,U.costa,fn);
const luhn = d => { let s=0; [...d].forEach((c,i)=>{ let x=+c*(i%2===0?2:1); s+=Math.floor(x/10)+x%10; }); return (10 - s%10) % 10; };
const pnr = (ymd, nnn) => ymd + '-' + nnn + luhn(ymd.slice(2) + nnn);
const cfg = data => q(`update records set data=$1, up=up+1 where kind='setting' and id='rewards'`, [JSON.stringify(data)]);
await cfg({});
const bon = await one(`select bs_rcfg('bonuses') b, bs_rcfg('referral') r`);
ok('standardvärden: välkomst 100, första 200, återkommande 150 vid 3 sessioner samma månad, värvning 300 och högst 3 öppna',
   bon.b.welcome===100 && bon.b.first===200 && bon.b.recurring===150 && bon.b.recurringCount===3 && bon.r.points===300 && bon.r.maxOpen===3 && bon.r.enabled===true, bon);
await cfg({bonuses:{first:250}});
const mg = (await one(`select bs_rcfg('bonuses') b`)).b;
ok('det admin sparat går före, resten följer standardvärdena', mg.first===250 && mg.welcome===100 && mg.recurring===150, mg);
await cfg({bonuses:{first:'mycket'}});
ok('ett felskrivet värde ger standardvärdet i stället för ett fel', +(await one(`select bs_rnum('bonuses','first',7) v`)).v===7);
await cfg({});

/* den som värvar: en kund med komplett profil */
const rvU = await user('rita@vv.se');
await q(`insert into members(id,user_id,role,name,email,interests,consent_at) values('rv1',$1,'customer','Rita Värvare','rita@vv.se','{production}',now())`,[rvU]);
await q(`insert into member_pnr(member_id,pnr_enc,pnr_hash,birth) values('rv1','\\x00','h-rv1','990101')`);
const RV = fn => as(db, rvU, fn);
const fr = (name, email) => RV(()=>rpc('invite_friend',{p_name:name, p_email:email, p_url:'https://www.bandohq.se/'}));
ok('bara artister bjuder in vänner', /Bara artister/.test(await boom(()=>as(db,U.rkay,()=>rpc('invite_friend',{p_name:'Vän Ett',p_email:'v1@vv.se',p_url:null})))||''));
const kxU = await user('kx1@vv.se');
await q(`insert into members(id,user_id,role,name,email) values('kx1',$1,'customer','Kim Ofärdig','kx1@vv.se')`,[kxU]);
ok('en artist utan komplett profil kompletterar först', /Komplettera din profil/.test(await boom(()=>as(db,kxU,()=>rpc('invite_friend',{p_name:'Vän Ett',p_email:'v1@vv.se',p_url:null})))||''));
ok('namn och e-post kontrolleras', /för- och efternamn/.test(await boom(()=>fr('Vän','v1@vv.se'))||'') && /e-postadress/.test(await boom(()=>fr('Vän Ett','v1'))||''));
ok('inte sin egen adress, och inte någon som redan finns hos Bando', /din egen/.test(await boom(()=>fr('Rita Själv','rita@vv.se'))||'')
   && /finns redan/.test(await boom(()=>fr('Någon Annan','rkay@b.se'))||''));
const f1 = await fr('Vera Vän', 'vera@vv.se');
const iv = await one(`select * from invites where token=$1`,[f1.invite]);
ok('inbjudan: en kundinbjudan från artisten, 30 dagar och en användning', iv.role==='customer' && iv.referrer==='rv1' && iv.created_by==='rv1'
   && iv.email==='vera@vv.se' && iv.max_uses===1 && f1.open===1 && f1.max===3, iv);
const vm = await one(`select * from outbox where dedupe_key=$1`,['invite:'+f1.invite]);
ok('vännen får mejlet "Rita Värvare bjuder in dig" med länken till Access-sidan', vm && vm.email==='vera@vv.se' && vm.kind==='invite-access'
   && vm.subject==='Rita Värvare bjuder in dig till Bando HQ Access' && vm.link==='https://www.bandohq.se/access.html?inbjudan='+f1.invite, vm);
ok('samma vän två gånger går inte', /redan fått en inbjudan/.test(await boom(()=>fr('Vera Vän','vera@vv.se'))||''));
await fr('Olle Vän', 'olle@vv.se'); await fr('Per Vän', 'per@vv.se');
ok('högst tre inbjudningar väntar samtidigt', /3 inbjudningar som väntar/.test(await boom(()=>fr('Fyra Vän','fyra@vv.se'))||''));
await cfg({referral:{enabled:false}});
ok('admin kan stänga av värva en vän', /avstängt/.test(await boom(()=>fr('Fem Vän','fem@vv.se'))||''));
await cfg({});
const info = await asAnon(db,()=>rpc('invite_info',{p_token:f1.invite}));
ok('Access-sidan visar vem som bjöd in', info.ok && info.by==='Rita Värvare' && info.name==='Vera Vän', info);

/* vännen skapar sitt konto */
const veU = await user('vera@vv.se');
const regV = o => as(db, veU, ()=>rpc('register_access', Object.assign({p_name:'Vera Vän',p_phone:'0703334455',p_pnr:pnr('20000101','111'),
  p_interests:'["production"]',p_consent:true,p_url:'https://www.bandohq.se/',p_invite:null}, o)));
const reg = await regV({p_invite:f1.invite});
const ve = await one(`select * from members where id=$1`,[reg.id]);
ok('vännen är värvad av artisten och får välkomstbonusen', reg.ok && ve.referred_by==='rv1' && reg.bonus===100
   && !!(await one(`select 1 from points where member_id=$1 and kind='bonus' and ref='welcome' and points=100`,[reg.id])), [reg, ve.referred_by]);
const wm = await one(`select * from outbox where dedupe_key=$1`,['welcome:'+reg.id]);
ok('välkomstmejlet nämner poängen', /Välkomstgåva: 100 poäng i Bando Rewards/.test(wm.body), wm.body);
const again = await regV({});
ok('välkomstbonusen ges en gång', again.ok && again.bonus===0 && (await q(`select 1 from points where member_id=$1 and ref='welcome'`,[reg.id])).length===1, again);
await as(db, veU, ()=>q(`update members set referred_by=null where id=$1`,[reg.id]).catch(()=>null));
ok('vännen kan inte ändra vem som värvade', (await one(`select referred_by from members where id=$1`,[reg.id])).referred_by==='rv1');
const sumR = await RV(()=>rpc('points_summary',{}));
ok('artisten ser sina vänner: en har gått med, två väntar', sumR.friends.length===3 && sumR.friends.filter(f=>f.status==='waiting').length===2
   && sumR.friends.some(f=>f.name==='Vera Vän' && f.status==='joined'), sumR.friends);
ok('och kan bjuda in en till nu när en gått med', !!(await fr('Fyra Vän','fyra@vv.se')).invite);

/* första sessionen och värvningen */
const VB = (id, date, o) => R('booking', id, Object.assign({id, studio:'A', date, start:'10:00', end:'13:00', who:'Vera Vän', title:'Studiotid',
  circleId:'', status:'', with:[]}, o));
await VB('vb1','2026-08-04'); await VB('vb2','2026-08-11'); await VB('vb3','2026-08-18'); await VB('vb4','2026-08-25');
await VB('vb5','2026-09-02'); await VB('vb6','2026-09-03', {end:'16:00'});
const c1 = await CA(()=>rpc('close_session',{p_booking:'vb1',p_paid:true,p_note:null}));
ok('första betalda sessionen: 100 poäng + 200 i bonus', c1.points===100 && c1.bonus===200, c1);
const rvp = await one(`select * from points where member_id='rv1' and ref=$1`,['referral:'+reg.id]);
ok('och den som värvade får 300 poäng', rvp && rvp.points===300 && rvp.kind==='bonus' && /Värva en vän: Vera Vän/.test(rvp.note), rvp);
const pn = await one(`select * from outbox where kind='points' and member_id='rv1'`);
ok('med en notis', pn && /tack för att du bjöd in Vera/.test(pn.subject) && /300 poäng/.test(pn.body), pn);
await CA(()=>rpc('close_session',{p_booking:'vb1',p_paid:true,p_note:null}));
await CA(()=>rpc('close_session',{p_booking:'vb2',p_paid:true,p_note:null}));
ok('bonusarna ges bara en gång', (await q(`select 1 from points where member_id=$1 and ref='first'`,[reg.id])).length===1
   && (await q(`select 1 from points where member_id='rv1' and ref like 'referral:%'`)).length===1);
const sumR2 = await RV(()=>rpc('points_summary',{}));
ok('vännen står som klar, med poängen', sumR2.friends.some(f=>f.name==='Vera Vän' && f.status==='done' && f.points===300) && sumR2.available===300, sumR2.friends);

/* återkommande */
const c3 = await CA(()=>rpc('close_session',{p_booking:'vb3',p_paid:true,p_note:null}));
ok('tre betalda sessioner samma månad: 150 i bonus', c3.bonus===150
   && (await one(`select note from points where member_id=$1 and ref='recurring:2026-08'`,[reg.id])).note==='Återkommande: 3 sessioner i augusti', c3);
ok('en fjärde samma månad ger ingen till', (await CA(()=>rpc('close_session',{p_booking:'vb4',p_paid:true,p_note:null}))).bonus===0);
await CA(()=>rpc('close_session',{p_booking:'vb4',p_paid:false,p_note:null}));
ok('avmarkeras betalt dras passets poäng tillbaka, bonusarna står kvar', +(await one(`select coalesce(sum(points),0) s from points where booking_id='vb4'`)).s===0
   && !!(await one(`select 1 from points where member_id=$1 and ref='recurring:2026-08'`,[reg.id])));

/* kampanjer */
await cfg({campaigns:[{id:'k1',label:'Dubbla poäng',from:'2026-09-01',to:'2026-09-30',multiplier:2},
                      {id:'k2',label:'Lite extra',from:'2026-09-03',to:'2026-09-03',multiplier:1.5},
                      {id:'kx',label:'Trasig',from:'x',to:'y',multiplier:'z'}]});
const c5 = await CA(()=>rpc('close_session',{p_booking:'vb5',p_paid:true,p_note:null}));
ok('under en kampanj gångras passets poäng: 3 h = 200', c5.points===200 && c5.campaign==='Dubbla poäng', c5);
ok('historiken säger vilken kampanj', /Dubbla poäng ×2/.test((await one(`select note from points where booking_id='vb5' and kind='earn'`)).note));
ok('överlappar två kampanjer gäller den högsta faktorn, och en trasig rad stoppar inget',
   (await CA(()=>rpc('close_session',{p_booking:'vb6',p_paid:true,p_note:null}))).points===1000);
await CA(()=>rpc('close_session',{p_booking:'vb5',p_paid:false,p_note:null}));
ok('rättelse: kampanjpoängen dras tillbaka', +(await one(`select sum(points) s from points where booking_id='vb5'`)).s===0);
await CA(()=>rpc('close_session',{p_booking:'vb5',p_paid:true,p_note:null}));
ok('och kommer tillbaka', +(await one(`select sum(points) s from points where booking_id='vb5'`)).s===200);
ok('faktorn skrivs på svenska', (await one(`select bs_mult_text(1.5) a, bs_mult_text(2.00) b`)).a==='×1,5');
const t = Date.now(), d0 = new Date(t - 864e5).toISOString().slice(0,10), d1 = new Date(t + 864e5).toISOString().slice(0,10);
await cfg({campaigns:[{id:'k1',label:'Dubbla poäng',from:'2026-09-01',to:'2026-09-30',multiplier:2},{id:'k3',label:'Höstkampanj',from:d0,to:d1,multiplier:2}]});
const catV = await as(db, veU, ()=>rpc('rewards_catalog',{}));
ok('artisten ser kampanjen som pågår, och bonusarna', catV.campaign && catV.campaign.label==='Höstkampanj' && catV.campaigns.length===1
   && catV.bonuses.first===200 && catV.referral.points===300 && catV.referral.enabled===true, catV);
ok('admin ser alla kampanjer, även de som är slut', (await CA(()=>rpc('rewards_catalog',{}))).campaigns.length===2);
const sv = await as(db, veU, ()=>rpc('points_summary',{}));
ok('bonusarna räknas som intjänade poäng (nivåerna)', sv.earned===sv.history.filter(h=>['earn','reversal','adjust','bonus'].includes(h.kind)).reduce((a,h)=>a+h.points,0)
   && sv.history.some(h=>h.kind==='bonus' && h.note==='Första sessionen'), [sv.earned, sv.history]);
/* bara admin ändrar inställningarna */
await as(db, U.rkay, ()=>rpc('push_records',{rows:JSON.stringify([{kind:'setting',id:'rewards',data:{bonuses:{first:99999}},up:9e12,del:false}])}).catch(()=>null));
ok('en producent kan inte ändra bonusarna', (await one(`select bs_rcfg('bonuses') b`)).b.first===200);
await cfg({});
}
console.log('\n══════════════════════════════');
console.log(pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
