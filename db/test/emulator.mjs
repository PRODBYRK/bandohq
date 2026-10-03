/* =====================================================================
   SUPABASE-EMULATOR för tester — riktig Postgres (PGlite) med samma
   schema, RLS och funktioner som i db/, bakom de HTTP-anrop appen gör:
     /auth/v1/*  signup, token (password/refresh), user, recover, logout
     /rest/v1/*  rpc, tabeller (GET med filter, POST upsert, PATCH)
   Starta:  node emulator.mjs [port]     (standard 8738)
   Testkrokar: GET /__mail (skickade mejl), GET /__sms (SMS-utkorgen), POST /__config {confirm:true}
   Detta är ett testverktyg. Det har inga riktiga lösenordshashar och hör
   inte hemma i drift — där är det Supabase som kör.
   ===================================================================== */
import http from 'http';
import { boot, as, asAnon } from './harness.mjs';

const PORT = +process.argv[2] || 8738;
const ANON = 'anon-test-key';
const db = await boot();
const q = async (s, p) => (await db.query(s, p)).rows;

/* ---------- konton i minnet (auth.users finns i databasen) ---------- */
const users = new Map();          // email → {id, email, password, meta, confirmed}
const mail = [];                  // skickade mejl
const cfg = { confirm: false };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = u => b64({alg:'none'}) + '.' + b64({sub:u.id, email:u.email, exp:Math.floor(Date.now()/1000)+3600}) + '.x';
const tokenSub = t => { try{ return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub; }catch(e){ return null; } };
const refresh = new Map();        // refresh-token → email
function session(u){
  const rt = 'rt-' + Math.random().toString(36).slice(2);
  refresh.set(rt, u.email);
  return {access_token:jwt(u), refresh_token:rt, expires_in:3600, token_type:'bearer',
    user:{id:u.id, email:u.email, user_metadata:u.meta||{}}};
}
async function addUser(email, password, meta){
  const id = (await q(`insert into auth.users(email) values($1) returning id`, [email]))[0].id;
  const u = {id, email, password, meta:meta||{}, confirmed:!cfg.confirm};
  users.set(email, u); return u;
}
const byId = id => [...users.values()].find(u=>u.id===id);

/* ---------- seed: AZ som manager, så det finns någon att logga in som ---------- */
const az = await addUser('az@b.se', 'losen123', {name:'AZ'});
await q(`insert into members(id,user_id,role,name,email,phone,color,glow) values('az',$1,'manager','AZ','az@b.se','070-000 00 01','#cbd5e1','#f1f5f9')`, [az.id]);
await q(`insert into members(id,role,name,email,color,glow) values('rkay','producer','RKAY','rkay@b.se','#7c3aed','#a855f7')`);
await q(`insert into records(kind,id,data,up) values('setting','studios','{"A":"STUDIO A","B":"THE BOOTH"}',1)`);

/* ---------- PostgREST: filter → SQL ---------- */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const TABLES = new Set(['members','invites','records','leads','sms_outbox','push_subs']);
function where(params, args){
  const parts = [];
  for(const [k, v] of params){
    if(['select','order','limit','on_conflict'].includes(k)) continue;
    if(!IDENT.test(k)) throw new Error('ogiltig kolumn ' + k);
    const m = v.match(/^(eq|gt|gte|lt|lte|neq)\.(.*)$/); if(!m) throw new Error('okänt filter ' + v);
    const op = {eq:'=', gt:'>', gte:'>=', lt:'<', lte:'<=', neq:'<>'}[m[1]];
    args.push(m[2]);
    /* likhet jämförs som text (fungerar för uuid och text), storlek som tal (up, ts) */
    parts.push(op === '=' || op === '<>' ? `${k}::text ${op} $${args.length}` : `${k} ${op} $${args.length}::bigint`);
  }
  return parts.length ? ' where ' + parts.join(' and ') : '';
}
function pgErr(res, e){
  send(res, 400, {code:'P0001', message:e.message, details:null, hint:null});
}
function send(res, status, body){
  res.writeHead(status, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/* PGlite har en anslutning — kör en fråga i taget. */
let chain = Promise.resolve();
const serial = fn => (chain = chain.then(fn, fn));

async function rest(req, res, url, body, uid){
  const path = url.pathname.replace('/rest/v1/', '');
  const run = fn => uid ? as(db, uid, fn) : asAnon(db, fn);
  if(path.startsWith('rpc/')){
    const fn = path.slice(4); if(!IDENT.test(fn)) return send(res, 404, {message:'okänd funktion'});
    const keys = Object.keys(body||{}), vals = keys.map(k => body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]);
    try{
      const r = await run(() => q(`select ${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as v`, vals));
      return send(res, 200, r[0].v);
    }catch(e){ return pgErr(res, e); }
  }
  if(!TABLES.has(path)) return send(res, 404, {message:'okänd tabell'});
  const params = [...url.searchParams.entries()];
  try{
    if(req.method === 'GET'){
      const args = [], sel = url.searchParams.get('select') || '*';
      const cols = sel === '*' ? '*' : sel.split(',').map(c=>{ if(!IDENT.test(c)) throw new Error('kolumn'); return c; }).join(',');
      let sql = `select ${cols} from ${path}` + where(params, args);
      const ord = url.searchParams.get('order');
      if(ord){ const [c, d] = ord.split('.'); if(!IDENT.test(c)) throw new Error('order'); sql += ` order by ${c} ${d==='desc'?'desc':'asc'}`; }
      const lim = +url.searchParams.get('limit'); if(lim) sql += ` limit ${Math.min(lim, 10000)}`;
      return send(res, 200, await run(() => q(sql, args)));
    }
    if(req.method === 'POST'){
      const rows = Array.isArray(body) ? body : [body], conflict = url.searchParams.get('on_conflict');
      for(const row of rows){
        const ks = Object.keys(row).filter(k=>IDENT.test(k));
        const vals = ks.map(k => row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]);
        let sql = `insert into ${path} (${ks.join(',')}) values (${ks.map((_,i)=>'$'+(i+1)).join(',')})`;
        if(conflict && IDENT.test(conflict)) sql += ` on conflict (${conflict}) do update set ` +
          ks.filter(k=>k!==conflict).map(k=>`${k} = excluded.${k}`).join(',');
        await run(() => q(sql, vals));
      }
      return send(res, 201);
    }
    if(req.method === 'PATCH'){
      const ks = Object.keys(body||{}).filter(k=>IDENT.test(k));
      const args = ks.map(k => body[k]);
      const sql = `update ${path} set ${ks.map((k,i)=>`${k} = $${i+1}`).join(',')}` + where(params, args);
      await run(() => q(sql, args));
      return send(res, 204);
    }
  }catch(e){ return pgErr(res, e); }
  send(res, 405, {message:'metod'});
}

async function auth(req, res, url, body, bearer){
  const path = url.pathname.replace('/auth/v1', '');
  const grant = url.searchParams.get('grant_type');
  if(path === '/signup' && req.method === 'POST'){
    const email = String(body.email||'').toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, {msg:'Unable to validate email address: invalid format'});
    if((body.password||'').length < 6) return send(res, 422, {msg:'Password should be at least 6 characters'});
    if(users.has(email)) return send(res, 422, {msg:'User already registered'});
    const u = await addUser(email, body.password, body.data);
    if(!u.confirmed){
      mail.push({to:email, type:'signup', link:'#access_token=' + jwt(u) + '&refresh_token=' + session(u).refresh_token + '&expires_in=3600&type=signup'});
      return send(res, 200, {id:u.id, email, user_metadata:u.meta});
    }
    return send(res, 200, session(u));
  }
  if(path === '/token' && grant === 'password'){
    const u = users.get(String(body.email||'').toLowerCase());
    if(!u || u.password !== body.password) return send(res, 400, {error:'invalid_grant', error_description:'Invalid login credentials'});
    if(!u.confirmed) return send(res, 400, {error:'invalid_grant', error_description:'Email not confirmed'});
    return send(res, 200, session(u));
  }
  if(path === '/token' && grant === 'refresh_token'){
    const em = refresh.get(body.refresh_token); if(!em) return send(res, 400, {error_description:'Invalid Refresh Token'});
    return send(res, 200, session(users.get(em)));
  }
  const me = bearer && byId(tokenSub(bearer));
  if(path === '/user' && req.method === 'GET'){
    if(!me) return send(res, 401, {msg:'JWT saknas'});
    return send(res, 200, {id:me.id, email:me.email, user_metadata:me.meta});
  }
  if(path === '/user' && req.method === 'PUT'){
    if(!me) return send(res, 401, {msg:'JWT saknas'});
    if(body.password) me.password = body.password;
    return send(res, 200, {id:me.id, email:me.email, user_metadata:me.meta});
  }
  if(path === '/recover'){
    const u = users.get(String(body.email||'').toLowerCase());
    if(u){ u.confirmed = true; mail.push({to:u.email, type:'recovery', redirect:url.searchParams.get('redirect_to'),
      link:'#access_token=' + jwt(u) + '&refresh_token=' + session(u).refresh_token + '&expires_in=3600&type=recovery'}); }
    return send(res, 200, {});          /* svarar likadant oavsett — avslöjar inte vilka konton som finns */
  }
  if(path === '/logout') return send(res, 204);
  send(res, 404, {msg:'okänd auth-väg'});
}

http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){
    res.writeHead(204, {'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'apikey,authorization,content-type,prefer,x-client-info', 'Access-Control-Max-Age':'600'});
    return res.end();
  }
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => serial(async () => {
    const url = new URL(req.url, 'http://x');
    let body = null; try{ body = raw ? JSON.parse(raw) : null; }catch(e){}
    if(url.pathname === '/__mail') return send(res, 200, mail);
    if(url.pathname === '/__sms') return send(res, 200, await q(`select id, member_id, phone, body, kind, dedupe_key, n, send_after from sms_outbox order by id`));
    if(url.pathname === '/__config'){ Object.assign(cfg, body||{}); return send(res, 200, cfg); }
    if(req.headers.apikey !== ANON) return send(res, 401, {message:'Invalid API key'});
    const bearer = String(req.headers.authorization||'').replace(/^Bearer /, '');
    const uid = bearer && bearer !== ANON ? tokenSub(bearer) : null;
    try{
      if(url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, body||{}, bearer);
      if(url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, body, uid);
      send(res, 404, {message:'okänd väg'});
    }catch(e){ send(res, 500, {message:e.message}); }
  }));
}).listen(PORT, () => console.log('Supabase-emulator på http://localhost:' + PORT + '  (anon key: ' + ANON + ')'));
