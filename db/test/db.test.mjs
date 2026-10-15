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
ok('och kan skicka en förfrågan utan telefonnummer', (await pr({})).ok===true && (await q(`select * from leads`)).length===1);
const ls = (await q(`select member_id from outbox where kind='lead'`)).map(r=>r.member_id).sort();
ok('admins och managern får mejl om nya kunder', JSON.stringify(ls)==='["az","costa"]', ls);
const lr = (await q(`select * from outbox where kind='received'`))[0];
ok('och kunden får ett kvitto på mejlen', lr && lr.email==='nova@x.se' && !lr.member_id && /tagit emot din förfrågan om tis 15 dec 12:00-15:00/.test(lr.body), lr);
await pr({p_hp:'robot'});
ok('honeypot: robotar får "ok" men inget sparas', (await q(`select * from leads`)).length===1);
ok('ett ifyllt men trasigt nummer nekas', /Telefonnumret ser fel ut/.test(await boom(()=>pr({p_phone:'123'}))||''));
ok('trasig e-post nekas', /E-postadressen/.test(await boom(()=>pr({p_email:'nova'}))||''));
ok('namn och telefon ELLER e-post krävs', /telefonnummer eller e-post/.test(await boom(()=>pr({p_email:'', p_phone:''}))||''));
ok('ett pass från bokningssidan är tre timmar', /tre timmar/.test(await boom(()=>pr({p_end:'16:00'}))||''));
ok('bara telefon räcker — och studion sparas inte', (await pr({p_name:'Ola Tel', p_email:'', p_phone:'0739998877', p_studio:'B'})).ok===true
   && (await one(`select email, phone, studio from leads where name='Ola Tel'`)).phone==='+46739998877'
   && (await one(`select email, studio from leads where name='Ola Tel'`)).email===null && (await one(`select studio from leads where name='Ola Tel'`)).studio===null);
ok('crewet får numret i mejlet om den nya kunden', /Ny kund vill boka: Ola Tel \(\+46739998877\), /.test((await one(`select o.body from outbox o join leads l on o.dedupe_key = 'lead:'||l.id||':az' where l.name='Ola Tel'`)).body));
ok('och e-posten när den finns', /Ny kund vill boka: Nova Lind \(nova@x\.se\), tis 15 dec/.test((await one(`select body from outbox where kind='lead' and member_id='az' order by id limit 1`)).body));
ok('utan e-post går inget kvitto (crewet ringer)', !(await one(`select 1 from outbox o join leads l on o.dedupe_key = 'lead-rcv:'||l.id where l.name='Ola Tel'`)));
await q(`delete from leads where name='Ola Tel'`);
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
ok('kunden kan inte svara själv', /Bara admin och kundens producent/.test(await boom(()=>as(db,U.kund,()=>rpc('answer_request',{p_booking:kr.id,p_approve:true,p_studio:'B'})))||''));
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

}
console.log('\n══════════════════════════════');
console.log(pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
