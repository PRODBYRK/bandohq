/* BANDO FOUNDATION — fas 3–5 mot riktig Postgres (PGlite) och edge-funktionen fd-agent mot en
   påhittad Claude API. Kontakter (D/E), redaktionen (G), F:s bibliotek, AI-agenterna med budget,
   finansieringen (I) med veckorapport och påminnelser, undersökningar (H) med anonyma svar, J:s arkiv. */
import { boot, as, asAnon, boom } from './harness.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
let pass=0, fail=0;
const ok=(n,c,x)=>{ c?pass++:fail++; console.log((c?'PASS  ':'FAIL  ')+n+(!c&&x!==undefined?'   → '+JSON.stringify(x).slice(0,600):'')); };
const head=t=>console.log('\n── '+t+' ──');
const db = await boot();
/* briefernas startuppgifter (10) testas i foundation4 — här börjar uppgiftstabellen tom som förut */
await db.query(`delete from fd_tasks where seed is not null`);
const q = async (s,p)=> (await db.query(s,p)).rows;
const one = async (s,p)=> (await q(s,p))[0];
const rpc = async (fn, args)=> { const keys = Object.keys(args||{});
  const r = await q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, keys.map(k=>args[k])); return r[0].v; };

const U = {};
for (const k of ['az','rkay','nanna','adrian','joseph','samuel','amir','jasmin','hanna','kim']) U[k] = (await one(`insert into auth.users(email) values($1) returning id`,[k+'@b.se'])).id;
const M = (id,role,name,perms)=>q(`insert into members(id,user_id,role,name,email,perms) values($1,$2,$3,$4,$5,$6)`,[id,U[id],role,name,id+'@b.se',perms||[]]);
await M('az','manager','AZ',['foundation_admin']); await M('rkay','manager','RKAY',['foundation_admin','protected_data']);
for (const [id,n] of [['nanna','Nanna'],['adrian','Adrian'],['joseph','Joseph'],['samuel','Samuel'],['amir','Amir'],['jasmin','Jasmin'],['hanna','Hanna']]) await M(id,'foundation',n);
await M('kim','customer','Kim Kund');
await q(`insert into fd_memberships values('nanna','G','member'),('amir','G','member'),('amir','C','chief'),('adrian','D','chief'),('joseph','A','chief'),('joseph','E','chief'),
  ('samuel','B','chief'),('jasmin','F','chief'),('jasmin','J','chief'),('hanna','H','chief'),('rkay','I','chief')`);
const AS = id => f => as(db, U[id], f);
const NA=AS('nanna'), AD=AS('adrian'), JO=AS('joseph'), SA=AS('samuel'), AM=AS('amir'), JA=AS('jasmin'), HA=AS('hanna'), RK=AS('rkay'), AZ=AS('az');
/* datum i svensk tid, som databasens påminnelser */
const D = n => { const t = new Date().toLocaleDateString('sv-SE', {timeZone:'Europe/Stockholm'}); const d = new Date(t + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };

head('D: profiler med medverkansalternativ, E: samarbetsprocess');
const prof = await AD(()=>one(`insert into fd_contacts(dept,kind,name,phone,email,area,status,note,options,links,created_by)
  values('D','person','Artist X','0701234567','x@artist.se','Stockholm','Positiv','Kan tänka sig studiobesök i november','{intervju,workshop}','https://artistx.se','adrian') returning id, options`));
ok('Adrian registrerar en profil med intervju och workshop', prof.options.join()==='intervju,workshop');
ok('ett okänt alternativ nekas', !!(await boom(()=>AD(()=>q(`insert into fd_contacts(dept,kind,name,options,created_by) values('D','person','Y','{dans}','adrian')`)))));
const h = await AD(()=>one(`select * from fd_handover_send(p_from_dept => 'D', p_to_dept => 'G', p_to_member => null, p_subject => 'Intervju med Artist X', p_contact => $1)`,[prof.id]));
ok('överlämning till G — samma kontakt, ingen kopia', h.to_dept==='G' && (await one(`select count(*)::int n from fd_contacts where name='Artist X'`)).n===1);
const pa = await JO(()=>one(`insert into fd_contacts(dept,kind,name,stage,created_by) values('E','org','Företaget AB','dialog','joseph') returning stage`));
ok('Joseph följer en partner i processen (Dialog)', pa.stage==='dialog');
ok('en ogiltig processtatus nekas', !!(await boom(()=>JO(()=>q(`insert into fd_contacts(dept,kind,name,stage,created_by) values('E','org','Z','kanske','joseph')`)))));

head('G: redaktionen');
const prod = await NA(()=>one(`insert into fd_productions(title,area,kind,guest_contact,owner,created_by) values('Intervju: Artist X','manniskorna','intervju',$1,'nanna','nanna') returning id`,[prof.id]));
ok('Nanna skapar en intervjuproduktion med gästen från D', !!prod.id);
ok('alla i Foundation ser G:s planering', (await SA(()=>q(`select 1 from fd_productions`))).length===1 && (await JA(()=>q(`select 1 from fd_productions`))).length===1);
ok('en kund ser den inte', (await as(db,U.kim,()=>q(`select 1 from fd_productions`))).length===0);
ok('bara G (och ansvarig) flyttar produktionen', (await SA(()=>q(`update fd_productions set status='research' returning id`))).length===0);
await AM(()=>q(`update fd_productions set status='research' where id=$1`,[prod.id]));
ok('Amir (G) flyttar den till Research — Nanna (ansvarig) får en notis', (await q(`select 1 from fd_notifications where member_id='nanna' and kind='production'`)).length===1);
const ct = await NA(()=>rpc('fd_comments_thread',{p_owner_type:'production',p_owner_id:prod.id}));
await NA(()=>rpc('fd_post',{p_thread:ct,p_body:'@Amir kan du boka studion?',p_mentions:JSON.stringify(['amir'])}));
ok('kommentarer på produktionen, och omnämnanden inom G fungerar', (await q(`select 1 from fd_notifications where member_id='amir' and kind='mention'`)).length===1);

head('F: materialbiblioteket och publiceringar');
const mat = await JA(()=>one(`insert into fd_materials(title,category,updated_by) values('Foundation-presentation','presentation','jasmin') returning id`));
await JA(()=>q(`insert into fd_documents(owner_type,owner_id,dept,kind,name,url,uploaded_by) values('material',$1,'F','link','v1','https://drive.google.com/a','jasmin')`,[mat.id]));
const d2 = await JA(()=>one(`insert into fd_documents(owner_type,owner_id,dept,kind,name,url,uploaded_by) values('material',$1,'F','link','v2','https://drive.google.com/b','jasmin') returning id`,[mat.id]));
const m2 = await one(`select version, current_doc from fd_materials where id=$1`,[mat.id]);
ok('varje ny fil blir nästa version och den som gäller', m2.version===2 && m2.current_doc===d2.id, m2);
ok('alla ser biblioteket', (await SA(()=>q(`select 1 from fd_materials`))).length===1);
ok('men bara F lägger upp nya versioner', !!(await boom(()=>SA(()=>q(`insert into fd_documents(owner_type,owner_id,kind,name,url,uploaded_by) values('material',$1,'link','v3','https://x.se','samuel')`,[mat.id])))));
const pub = await NA(()=>one(`insert into fd_publications(title,channel,production_id,created_by) values('Klipp: Artist X','Instagram',$1,'nanna') returning status`,[prod.id]));
ok('G lämnar material till F: Material mottaget', pub.status==='received');

head('AI: agentbiblioteket, behörighet och budget');
ok('elva agenter enligt masterplanen', (await one(`select count(*)::int n from fd_agents`)).n===11);
ok('alla i Foundation ser agenterna, en kund inte', (await SA(()=>q(`select 1 from fd_agents`))).length===11 && (await as(db,U.kim,()=>q(`select 1 from fd_agents`))).length===0);
ok('AI är avstängt tills Claude API-nyckeln finns', /AI är avstängt/.test(await boom(()=>NA(()=>rpc('fd_agent_request',{p_agent:'a_deepdive',p_owner_type:'production',p_owner_id:prod.id,p_question:''})))||''));
await AZ(()=>rpc('fd_save_ai_settings',{p_budget_sek:500,p_usd_sek:10.5,p_enabled:true}));
ok('admin slår på AI', (await AZ(()=>rpc('fd_ai_budget',{}))).enabled===true);
ok('Samuel (B) kan inte starta G:s Deep Dive', /hör till avdelning G/.test(await boom(()=>SA(()=>rpc('fd_agent_request',{p_agent:'a_deepdive',p_owner_type:'production',p_owner_id:prod.id,p_question:''})))||''));
const run1 = await NA(()=>rpc('fd_agent_request',{p_agent:'a_deepdive',p_owner_type:'production',p_owner_id:prod.id,p_question:''}));
const pl = (await one(`select payload from fd_agent_runs where id=$1`,[run1])).payload;
ok('Nanna startar Deep Dive: underlaget har gästen och kunskapsbasen', pl.underlag.produktion['gäst']==='Artist X' && pl.kunskapsbas.length===2, pl);
ok('men aldrig telefon eller e-post', !JSON.stringify(pl).includes('0701234567') && !JSON.stringify(pl).includes('x@artist.se'));
ok('A kan inte starta en agent på B:s avdelning', /Du kan inte starta|hör till/.test(await boom(()=>JO(()=>rpc('fd_agent_request',{p_agent:'a_outreach',p_owner_type:'dept',p_owner_id:'B',p_question:'x'})))||''));
ok('anonyma når inte agenterna', !!(await boom(()=>asAnon(db,()=>rpc('fd_agent_request',{p_agent:'a_outreach',p_owner_type:'dept',p_owner_id:'A',p_question:'x'})))));
ok('vanliga användare kan inte ta kön (bara edge-funktionen)', !!(await boom(()=>NA(()=>rpc('fd_agent_claim',{})))));
ok('admin ser budgeten', (await AZ(()=>rpc('fd_ai_budget',{}))).budget_sek==500);
ok('bara admin ändrar budgeten', /Bara Foundation-admin/.test(await boom(()=>NA(()=>rpc('fd_save_ai_settings',{p_budget_sek:9999,p_usd_sek:10,p_enabled:true})))||''));

head('edge-funktionen fd-agent mot en påhittad Claude API');
Object.assign(process.env, { SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE_KEY: 'service', ANTHROPIC_API_KEY: 'sk-test', CRON_SECRET: 'cron' });
const F = await import(join(dirname(fileURLToPath(import.meta.url)), '../../supabase/functions/fd-agent/index.ts'));
const sent = []; let replies = [];
globalThis.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith('https://supa.test/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1], a = JSON.parse(opt.body || '{}'), ks = Object.keys(a);
    const vals = ks.map(k => a[k] !== null && typeof a[k] === 'object' ? JSON.stringify(a[k]) : a[k]);
    const r = await q(`select ${fn}(${ks.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, vals);
    return new Response(r[0].v == null ? '' : JSON.stringify(r[0].v), { status: 200 });
  }
  if (url === F.API) {
    sent.push({ headers: opt.headers, body: JSON.parse(opt.body) });
    const next = replies.shift();
    if (typeof next === 'number') return new Response('{"type":"error"}', { status: next });
    return new Response(JSON.stringify(next), { status: 200 });
  }
  throw new Error('oväntat anrop ' + url);
};
const U1 = { input_tokens: 10000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 4 } };
const U2 = { input_tokens: 2000, output_tokens: 6000, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, server_tool_use: { web_search_requests: 2 } };
replies = [
  { stop_reason: 'pause_turn', usage: U1, content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Jag söker.' },
    { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'Artist X intervju' } }] },
  { stop_reason: 'end_turn', usage: U2, content: [
    { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
    { type: 'text', text: '# Researchrapport\n## 1 Bakgrund\nArtist X släppte debutalbumet 2019 ', citations: [{ type: 'web_search_result_location', url: 'https://sv.wikipedia.org/wiki/Artist_X', title: 'Artist X – Wikipedia', cited_text: '…' }] },
    { type: 'text', text: '[Verifierat].\n# Interview Playbook\n- Varför intressant …\n# Filmbrief\nLugn ton.', citations: [{ type: 'web_search_result_location', url: 'https://p3.se/x', title: 'P3 intervju', cited_text: '…' }, { type: 'web_search_result_location', url: 'https://sv.wikipedia.org/wiki/Artist_X', title: 'dubblett', cited_text: '…' }] }] },
];
const h1 = await F.handle(20000);
ok('en väckning: två steg (pause_turn fortsätter direkt) och körningen är klar', h1.steps===2 && h1.done===1, h1);
const b0 = sent[0].body, hd = sent[0].headers;
ok('anropet: rätt modell, version, nyckel och fallback', b0.model==='claude-opus-5-5' && hd['anthropic-version']==='2026-10-21' && hd['x-api-key']==='sk-test'
   && hd['anthropic-beta']==='server-side-fallback-2026-07-01' && b0.fallbacks==='default', { model: b0.model, hd });
ok('webbsökning (svensk plats, högst 20 sökningar) och webbhämtning; Deep Dive på hög effort', b0.tools[0].type==='web_search_20260318' && b0.tools[0].max_uses===20
   && b0.tools[0].user_location.country==='SE' && b0.tools[1].type==='web_fetch_20260209' && b0.output_config.effort==='high' && b0.cache_control.type==='ephemeral');
ok('uppdraget: Foundations regler, åtta researchområden och tre leveranser', /Hitta aldrig på/.test(b0.system[0].text) && /8 Frågor att undersöka vidare/.test(b0.messages[0].content)
   && /# Interview Playbook/.test(b0.messages[0].content) && /# Filmbrief/.test(b0.messages[0].content));
const b1 = sent[1].body;
ok('fortsättningen skickar tillbaka assistentens innehåll oförändrat (ingen extra fråga)', b1.messages.length===2 && b1.messages[1].role==='assistant'
   && b1.messages[1].content[0].signature==='s1' && b1.messages[1].content[2].id==='srv1');
const r1 = await one(`select status, result, sources, cost_usd, steps, usage from fd_agent_runs where id=$1`,[run1]);
const want = (10000*4 + 2000*20 + 2000*4 + 6000*20 + 30000*0.2)/1e6 + 6*0.01;
ok('resultatet: rapport, playbook och filmbrief', r1.status==='done' && /^# Researchrapport/.test(r1.result) && /# Interview Playbook/.test(r1.result) && /# Filmbrief/.test(r1.result), r1.result);
ok('källorna, utan dubbletter', r1.sources.length===2 && r1.sources[0].url==='https://sv.wikipedia.org/wiki/Artist_X', r1.sources);
ok('kostnaden: tokens × pris + 6 sökningar', Math.abs(+r1.cost_usd - want) < 1e-9 && r1.steps===2 && +r1.usage.web_search_requests===6, [r1.cost_usd, want]);
ok('Nanna får en notis när den är klar', (await q(`select 1 from fd_notifications where member_id='nanna' and kind='ai' and title like 'G · Interview Deep Dive är klar%'`)).length===1);
ok('alla i Foundation kan läsa produktionens research', (await SA(()=>q(`select 1 from fd_agent_runs where id=$1`,[run1]))).length===1);

const run2 = await NA(()=>rpc('fd_agent_request',{p_agent:'a_deepdive',p_owner_type:'production',p_owner_id:prod.id,p_question:'Hans tid som låtskrivare åt andra'}));
sent.length = 0; replies = [429, { stop_reason: 'end_turn', usage: U2, content: [{ type: 'text', text: 'Fördjupning.' }] }];
const h2 = await F.handle(20000);
ok('överbelastning (429): försöker igen och blir klar', h2.steps===2 && (await one(`select status from fd_agent_runs where id=$1`,[run2])).status==='done');
ok('fördjupningen skickar frågan', /Fördjupa researchen kring: Hans tid som låtskrivare/.test(sent[0].body.messages[0].content));
const run3 = await AD(()=>rpc('fd_agent_request',{p_agent:'a_profile',p_owner_type:'contact',p_owner_id:prof.id,p_question:'Inför mötet'}));
sent.length = 0; replies = [{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' }, usage: U2, content: [] }];
await F.handle(20000);
ok('avböjt: körningen markeras och Adrian får veta det', (await one(`select status, error from fd_agent_runs where id=$1`,[run3])).error.includes('avböjde')
   && (await q(`select 1 from fd_notifications where member_id='adrian' and title like '%misslyckades'`)).length===1);
ok('D:s agent: medium effort', sent[0].body.output_config.effort==='medium' && sent[0].body.tools[0].max_uses===10);
const ign = await JO(()=>rpc('fd_agent_request',{p_agent:'a_outreach',p_owner_type:'dept',p_owner_id:'A',p_question:'Hitta HVB-hem i Järva'}));
await AZ(()=>rpc('fd_save_ai_settings',{p_budget_sek:0,p_usd_sek:10.5,p_enabled:true}));
sent.length = 0; await F.handle(20000);
ok('budgeten slut: kön stoppar körningen innan anropet, Joseph får veta', sent.length===0 && (await one(`select status from fd_agent_runs where id=$1`,[ign])).status==='blocked'
   && (await q(`select 1 from fd_notifications where member_id='joseph' and title='AI-körningen stoppades'`)).length===1);
ok('och nya körningar går inte att starta', /budget är slut/.test(await boom(()=>JO(()=>rpc('fd_agent_request',{p_agent:'a_outreach',p_owner_type:'dept',p_owner_id:'A',p_question:'x'})))||''));
await AZ(()=>rpc('fd_save_ai_settings',{p_budget_sek:500,p_usd_sek:10.5,p_enabled:true}));

head('I: finansiering');
const rep = await RK(()=>one(`insert into fd_funding_reports(body,created_by) values($1,'rkay') returning id`,['Veckorapport måndag: Kulturbryggan — Snabba spåret, deadline 2027-01-20, upp till 100 000 kr. MUCF Projektbidrag — kräver två års verksamhet.']));
const run4 = await RK(()=>rpc('fd_agent_request',{p_agent:'a_fundimport',p_owner_type:'funding_report',p_owner_id:rep.id,p_question:''}));
const G = (o) => Object.assign({ name: '', funder: '', url: '', deadline: '', deadline_text: '', amount_text: '', eligibility: 'unclear', priority: 'B', fit_projects: '', requirements: '', next_action: '', analysis: '', previous_recipients: '', verified: false }, o);
sent.length = 0; replies = [{ stop_reason: 'end_turn', usage: U1, content: [{ type: 'text', text: JSON.stringify({ grants: [
  G({ name: 'Snabba spåret', funder: 'Kulturbryggan', url: 'https://kulturbryggan.se', deadline: '2027-01-20', amount_text: 'upp till 100 000 kr', eligibility: 'eligible', priority: 'A', next_action: 'Skriv projektplan' }),
  G({ name: 'Projektbidrag', funder: 'MUCF', eligibility: 'not_yet', priority: 'C', requirements: 'Två års verksamhet' })] }) }] }];
await F.handle(20000);
ok('veckorapporten läses in: strukturerat svar, inga webbverktyg', sent[0].body.output_config.format.type==='json_schema' && !sent[0].body.tools);
const gs = await RK(()=>q(`select name, priority, eligibility, deadline::text, source from fd_grants order by name`));
ok('två bidrag i databasen med prioritet och behörighet', gs.length===2 && gs.some(g=>g.name==='Snabba spåret' && g.priority==='A' && g.deadline==='2027-01-20' && g.source==='veckorapport'), gs);
ok('rapporten vet hur många', (await one(`select grants_count from fd_funding_reports where id=$1`,[rep.id])).grants_count===2);
const run5 = await RK(()=>rpc('fd_agent_request',{p_agent:'a_fundimport',p_owner_type:'funding_report',p_owner_id:rep.id,p_question:''}));
replies = [{ stop_reason: 'end_turn', usage: U1, content: [{ type: 'text', text: JSON.stringify({ grants: [G({ name: 'Snabba spåret', funder: 'Kulturbryggan', amount_text: 'upp till 120 000 kr' })] }) }] }];
await F.handle(20000);
ok('samma bidrag nästa vecka uppdaterar posten i stället för en dubblett', (await one(`select count(*)::int n, max(amount_text) a from fd_grants where name='Snabba spåret'`)).n===1
   && (await one(`select amount_text from fd_grants where name='Snabba spåret'`)).amount_text==='upp till 120 000 kr');
ok('E och J ser bidragen, A och en kund inte', (await JO(()=>q(`select 1 from fd_grants`))).length===2 && (await JA(()=>q(`select 1 from fd_grants`))).length===2
   && (await SA(()=>q(`select 1 from fd_grants`))).length===0 && (await as(db,U.kim,()=>q(`select 1 from fd_grants`))).length===0);
ok('bara I ändrar ett bidrag', (await JO(()=>q(`update fd_grants set status='preparing' returning id`))).length===0);
const g1 = (await one(`select id from fd_grants where name='Snabba spåret'`)).id;
await RK(()=>q(`update fd_grants set status='ready', deadline=$2 where id=$1`,[g1, D(7)]));
ok('statusbytet till Klar för godkännande loggas (en människa skickar in)', (await q(`select 1 from record_history where kind='fd.grant' and rec_id=$1 and op='status' and after->>'status'='ready'`,[g1])).length===1);
await q(`insert into fd_memberships values('jasmin','I','member') on conflict do nothing`);
await RK(()=>q(`update fd_grants set status='preparing' where id=$1`,[g1])); await RK(()=>q(`update fd_grants set status='ready' where id=$1`,[g1]));
ok('och de andra i I får notisen Klar för godkännande', (await q(`select 1 from fd_notifications where member_id='jasmin' and title like 'Klar för godkännande:%'`)).length===1);
await q(`delete from fd_memberships where member_id='jasmin' and dept='I'`);
await q(`update fd_grants set status='preparing' where id=$1`,[g1]);
const nrem = await rpc('fd_daily_reminders',{});
ok('påminnelse 7 dagar före deadline till I', nrem>=1 && (await q(`select 1 from fd_notifications where member_id='rkay' and title like 'Deadline om 7 dagar:%'`)).length===1);
ok('påminnelserna kan inte anropas av användare', !!(await boom(()=>RK(()=>rpc('fd_daily_reminders',{})))));

head('H: undersökningar (anonyma)');
const sv = await HA(()=>one(`insert into fd_surveys(title,kind,questions,status,created_by) values('Ungas framtidsplaner','societal',$1,'open','hanna') returning id, token`,
  [JSON.stringify([{id:'q1',type:'scale',label:'Hur trygg känner du dig?'},{id:'q2',type:'choice',label:'Vad vill du jobba med?',options:['Musik','Film','Annat']},{id:'q3',type:'text',label:'Något mer?'}])]));
const inf = await asAnon(db,()=>rpc('fd_survey_info',{p_token:sv.token}));
ok('länken visar enkäten för vem som helst', inf.ok && inf.questions.length===3);
await asAnon(db,()=>rpc('fd_survey_answer',{p_token:sv.token,p_answers:JSON.stringify({q1:4,q2:'Musik',q3:'Mer studiotid',smuggel:'x'})}));
await asAnon(db,()=>rpc('fd_survey_answer',{p_token:sv.token,p_answers:JSON.stringify({q1:2,q2:'Film'})}));
ok('ett ogiltigt svar nekas', /Ogiltigt/.test(await boom(()=>asAnon(db,()=>rpc('fd_survey_answer',{p_token:sv.token,p_answers:JSON.stringify({q1:9})})))||''));
ok('svaren sparas utan något som pekar ut personen', JSON.stringify((await q(`select answers from fd_survey_responses`)).map(r=>r.answers)).indexOf('smuggel')===-1);
const res = await HA(()=>rpc('fd_survey_report',{p_survey:sv.id}));
ok('H ser resultatet: snitt, fördelning och fritext', res.svar==2 && +res['frågor'][0].resultat.snitt===3 && res['frågor'][1].resultat.Musik==1 && res['frågor'][2].resultat[0]==='Mer studiotid', res);
ok('A ser inte resultatet', /Resultaten ser/.test(await boom(()=>JO(()=>rpc('fd_survey_report',{p_survey:sv.id})))||''));
ok('ingen läser svarstabellen direkt', (await HA(()=>q(`select 1 from fd_survey_responses`))).length===0);
const act = await AM(()=>one(`insert into fd_activities(dept,title,date,created_by) values('C','Workshop: film',$1,'amir') returning id`,[D(-1)]));
const ev = await AM(()=>one(`insert into fd_surveys(title,kind,activity_id,questions,status,created_by) values('Utvärdering: film','internal',$1,$2,'open','amir') returning id, token`,
  [act.id, JSON.stringify([{id:'q1',type:'scale',label:'Vad tyckte du?'}])]));
await asAnon(db,()=>rpc('fd_survey_answer',{p_token:ev.token,p_answers:JSON.stringify({q1:5})}));
ok('C skapar en utvärdering efter sin workshop och ser resultatet', (await AM(()=>rpc('fd_survey_report',{p_survey:ev.id}))).svar==1);
ok('B ser den också (aktivitetens folk)', (await SA(()=>rpc('fd_survey_report',{p_survey:ev.id}))).svar==1);
await HA(()=>q(`update fd_surveys set status='closed' where id=$1`,[sv.id]));
ok('en stängd enkät tar inte emot svar', /inte öppen/.test(await boom(()=>asAnon(db,()=>rpc('fd_survey_answer',{p_token:sv.token,p_answers:JSON.stringify({q1:3})})))||''));

head('J: arkiv och viktiga datum');
await JA(()=>q(`insert into fd_documents(owner_type,owner_id,dept,kind,name,url,uploaded_by) values('archive','stadgar','J','link','Stadgar 2025','https://drive.google.com/s','jasmin')`));
ok('Jasmin (J) lägger stadgarna i arkivet', (await JA(()=>q(`select 1 from fd_documents where owner_type='archive'`))).length===1);
ok('A ser inte arkivet', (await JO(()=>q(`select 1 from fd_documents where owner_type='archive'`))).length===0);
ok('och kan inte lägga något där', !!(await boom(()=>JO(()=>q(`insert into fd_documents(owner_type,owner_id,kind,name,url,uploaded_by) values('archive','avtal','link','x','https://x.se','joseph')`)))));
await JA(()=>q(`insert into fd_deadlines(title,date,dept,created_by) values('Årsmöte: kallelse',$1,'J','jasmin')`,[D(1)]));
await rpc('fd_daily_reminders',{});
ok('dagen före ett datum får J en påminnelse', (await q(`select 1 from fd_notifications where member_id='jasmin' and title='I morgon: Årsmöte: kallelse'`)).length===1);

head('veckorapporten till admin');
await rpc('fd_weekly_report',{});
const wr = await q(`select body from fd_notifications where member_id='az' and kind='report'`);
ok('admin får en veckorapport med siffror — inga namn', wr.length===1 && /uppgifter klara/.test(wr[0].body) && /AI denna månad/.test(wr[0].body) && !/Artist X|Nanna/.test(wr[0].body), wr);

head('studion är orörd');
ok('kunden ser inget av Foundations nya delar', (await as(db,U.kim,()=>q(`select 1 from fd_surveys union all select 1 from fd_materials union all select 1 from fd_agent_runs`))).length===0);

console.log('\n'+pass+' PASS · '+fail+' FAIL'); console.log(fail?'✗ TRASIGT':'✓ ALLT GRÖNT');
process.exit(fail?1:0);
