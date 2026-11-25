/* =====================================================================
   SUPABASE-EMULATOR för tester — riktig Postgres (PGlite) med samma
   schema, RLS och funktioner som i db/, bakom de HTTP-anrop appen gör:
     /auth/v1/*  signup (med 6-siffrig kod), verify, resend, token (password/refresh), user, recover, logout
     /rest/v1/*  rpc, tabeller (GET med filter, POST upsert, PATCH)
     /functions/v1/auth-login  den riktiga edge-funktionen (supabase/functions/auth-login)
     /storage/v1/object/*      ladda upp, hämta, signera och ta bort (RLS på storage.objects som i Supabase)
   Starta:  node emulator.mjs [port]     (standard 8738)
   Testkrokar: GET /__mail (inloggningsmejlen, med koden), GET /__outbox (utkorgen),
               POST /__sql {sql}, POST /__config {confirm:true}
   Detta är ett testverktyg. Det har inga riktiga lösenordshashar och hör
   inte hemma i drift — där är det Supabase som kör.
   ===================================================================== */
import http from 'http';
import { boot, as, asAnon } from './harness.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PORT = +process.argv[2] || 8738;
const ANON = 'anon-test-key', SERVICE = 'service-test-key';
/* auth-login körs som på riktigt och anropar emulatorn med servernyckeln */
Object.assign(process.env, { SUPABASE_URL: 'http://localhost:' + PORT, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON });
const LOGIN = await import(join(dirname(fileURLToPath(import.meta.url)), '../../supabase/functions/auth-login/index.ts'));
const db = await boot();
/* date-kolumner som text ("2026-11-25"), som PostgREST — inte som Date-objekt */
const q = async (s, p) => (await db.query(s, p, {parsers:{1082: v => v}})).rows;

/* ---------- konton i minnet (auth.users finns i databasen) ---------- */
const users = new Map();          // email → {id, email, password, meta, confirmed, code}
const newCode = () => String(Math.floor(100000 + Math.random() * 900000));
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
/* Konton som databasen tagit bort (register_access vid dubblett, delete_my_account) */
async function forgetDeleted(){
  const ids = new Set((await q(`select id::text from auth.users`)).map(r=>r.id));
  for(const [em, u] of users) if(!ids.has(String(u.id))) users.delete(em);
}

/* ---------- seed: AZ som manager, så det finns någon att logga in som ---------- */
const az = await addUser('az@b.se', 'losen123', {name:'AZ'});
await q(`insert into members(id,user_id,role,name,email,username,color,glow) values('az',$1,'manager','AZ','az@b.se','az','#cbd5e1','#f1f5f9')`, [az.id]);
await q(`insert into members(id,role,name,email,color,glow) values('rkay','producer','RKAY','rkay@b.se','#7c3aed','#a855f7')`);
await q(`insert into records(kind,id,data,up) values('setting','studios','{"A":"STUDIO A","B":"THE BOOTH"}',1)`);

/* ---------- PostgREST: filter → SQL ---------- */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ARRAYS = new Set(['interests', 'perms', 'producers']);
const TABLES = new Set(['members','invites','records','leads','outbox','push_subs', 'session_reports', 'record_history', 'circle_signups', 'circle_membership',
  'access_requests', 'fd_departments', 'fd_memberships', 'fd_contacts', 'fd_tasks', 'fd_handovers', 'fd_threads',
  'fd_thread_members', 'fd_messages', 'fd_mentions', 'fd_notifications', 'fd_documents', 'fd_dept_updates']);
function where(params, args){
  const parts = [];
  for(const [k, v] of params){
    if(['select','order','limit','on_conflict'].includes(k)) continue;
    if(!IDENT.test(k)) throw new Error('ogiltig kolumn ' + k);
    if(v === 'is.null' || v === 'not.is.null'){ parts.push(`${k} is ${v === 'is.null' ? '' : 'not '}null`); continue; }
    const inl = v.match(/^in\.\((.*)\)$/);
    if(inl){ args.push(inl[1] ? inl[1].split(',').map(x=>x.replace(/^"|"$/g,'')) : []); parts.push(`${k}::text = any($${args.length}::text[])`); continue; }
    const lk = v.match(/^like\.(.*)$/);
    if(lk){ args.push(lk[1].replace(/\*/g, '%')); parts.push(`${k}::text like $${args.length}`); continue; }
    const m = v.match(/^(eq|gt|gte|lt|lte|neq)\.(.*)$/); if(!m) throw new Error('okänt filter ' + v);
    const op = {eq:'=', gt:'>', gte:'>=', lt:'<', lte:'<=', neq:'<>'}[m[1]];
    args.push(m[2]);
    /* likhet jämförs som text (fungerar för uuid och text); storlek som datum när värdet är ett
       datum, annars som tal (up, ts) */
    const cast = /^\d{4}-\d\d-\d\d/.test(m[2]) ? '::timestamptz' : '::bigint';
    parts.push(op === '=' || op === '<>' ? `${k}::text ${op} $${args.length}` : `${k} ${op} $${args.length}${cast}`);
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

async function rest(req, res, url, body, uid, service){
  const path = url.pathname.replace('/rest/v1/', '');
  /* servernyckeln går förbi RLS, som service_role i Supabase */
  const run = fn => service ? fn() : uid ? as(db, uid, fn) : asAnon(db, fn);
  if(path.startsWith('rpc/')){
    const fn = path.slice(4); if(!IDENT.test(fn)) return send(res, 404, {message:'okänd funktion'});
    const keys = Object.keys(body||{}), vals = keys.map(k => body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]);
    try{
      /* en funktion som returnerar en tabellrad blir ett JSON-objekt, som i PostgREST */
      const comp = (await q(`select t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype where p.proname = $1 limit 1`, [fn]))[0];
      const call = `${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')})`;
      const r = await run(() => q(`select ${comp && comp.typtype === 'c' ? `to_jsonb(${call})` : call} as v`, vals));
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
    const repr = /return=representation/.test(String(req.headers.prefer||''));
    if(req.method === 'POST'){
      const rows = Array.isArray(body) ? body : [body], conflict = url.searchParams.get('on_conflict'), out = [];
      for(const row of rows){
        const ks = Object.keys(row).filter(k=>IDENT.test(k));
        /* text[]-kolumner (inriktningar, behörigheter) tar en lista; jsonb tar JSON */
        const vals = ks.map(k => Array.isArray(row[k]) && ARRAYS.has(k) ? row[k] : row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]);
        let sql = `insert into ${path} (${ks.join(',')}) values (${ks.map((_,i)=>'$'+(i+1)).join(',')})`;
        if(conflict && IDENT.test(conflict)) sql += ` on conflict (${conflict}) do update set ` +
          ks.filter(k=>k!==conflict).map(k=>`${k} = excluded.${k}`).join(',');
        out.push(...await run(() => q(sql + (repr ? ' returning *' : ''), vals)));
      }
      return repr ? send(res, 201, out) : send(res, 201);
    }
    if(req.method === 'PATCH'){
      const ks = Object.keys(body||{}).filter(k=>IDENT.test(k));
      const args = ks.map(k => body[k]);
      const vals = args.map(v => v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
      const sql = `update ${path} set ${ks.map((k,i)=>`${k} = $${i+1}`).join(',')}` + where(params, vals);
      const r = await run(() => q(sql + (repr ? ' returning *' : ''), vals));
      return repr ? send(res, 200, r) : send(res, 204);
    }
    if(req.method === 'DELETE'){
      const args = [], w = where(params, args);
      if(!w) return send(res, 400, {message:'DELETE kräver ett filter'});
      const r = await run(() => q(`delete from ${path}` + w + (repr ? ' returning *' : ''), args));
      return repr ? send(res, 200, r) : send(res, 204);
    }
  }catch(e){ return pgErr(res, e); }
  send(res, 405, {message:'metod'});
}

/* ---------- Storage: filerna i minnet, raderna i storage.objects (med RLS, som i Supabase) ---------- */
const files = new Map();           // bucket/name → {buf, type}
const signed = new Map();          // token → {key, exp}
async function storage(req, res, url, buf, uid, service){
  const run = fn => service ? fn() : uid ? as(db, uid, fn) : asAnon(db, fn);
  let p = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''));
  const mode = (p.match(/^(authenticated|sign|public)\//) || [])[1] || '';
  if(mode) p = p.slice(mode.length + 1);
  const bucket = p.split('/')[0], name = p.slice(bucket.length + 1), key = bucket + '/' + name;
  if(!bucket || !name || name.includes('..')) return send(res, 400, {statusCode:'400', error:'InvalidKey', message:'Ogiltig sökväg'});
  try{
    if(mode === 'sign' && req.method === 'GET'){
      const t = signed.get(url.searchParams.get('token')||'');
      if(!t || t.key !== key || t.exp < Date.now() || !files.has(key)) return send(res, 400, {statusCode:'400', error:'InvalidSignature', message:'Ogiltig länk'});
      const f = files.get(key);
      res.writeHead(200, {'Content-Type':f.type, 'Access-Control-Allow-Origin':'*'}); return res.end(f.buf);
    }
    if(mode === 'sign' && req.method === 'POST'){
      const r = await run(() => q(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]));
      if(!r.length) return send(res, 400, {statusCode:'404', error:'not_found', message:'Object not found'});
      const tok = 'st-' + Math.random().toString(36).slice(2);
      let exp = 60; try{ exp = +(JSON.parse(buf.toString() || '{}').expiresIn) || 60; }catch(e){}
      signed.set(tok, {key, exp: Date.now() + 1000 * exp});
      return send(res, 200, {signedURL: `/object/sign/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}?token=${tok}`});
    }
    if(req.method === 'GET'){
      const r = await run(() => q(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]));
      if(!r.length || !files.has(key)) return send(res, 400, {statusCode:'404', error:'not_found', message:'Object not found'});
      const f = files.get(key);
      res.writeHead(200, {'Content-Type':f.type, 'Access-Control-Allow-Origin':'*'}); return res.end(f.buf);
    }
    if(req.method === 'POST'){
      const b = (await q(`select file_size_limit, allowed_mime_types from storage.buckets where id = $1`, [bucket]))[0];
      if(!b) return send(res, 400, {statusCode:'404', error:'Bucket not found', message:'Bucket not found'});
      const type = String(req.headers['content-type']||'application/octet-stream').split(';')[0];
      if(b.file_size_limit && buf.length > +b.file_size_limit) return send(res, 413, {statusCode:'413', error:'Payload too large', message:'The object exceeded the maximum allowed size'});
      if(b.allowed_mime_types && !b.allowed_mime_types.includes(type)) return send(res, 415, {statusCode:'415', error:'invalid_mime_type', message:`mime type ${type} is not supported`});
      if(files.has(key)) return send(res, 409, {statusCode:'409', error:'Duplicate', message:'The resource already exists'});
      /* som Supabase: en uppladdning kräver bara INSERT-policyn (inte SELECT), så ingen RETURNING som användaren */
      await run(() => q(`insert into storage.objects(bucket_id, name, owner, metadata) values($1, $2, $3, $4)`,
        [bucket, name, uid, JSON.stringify({mimetype:type, size:buf.length})]));
      const r = await q(`select id from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]);
      files.set(key, {buf, type});
      return send(res, 200, {Key: key, Id: r[0].id});
    }
    if(req.method === 'DELETE'){
      const r = await run(() => q(`delete from storage.objects where bucket_id = $1 and name = $2 returning id`, [bucket, name]));
      if(!r.length) return send(res, 400, {statusCode:'404', error:'not_found', message:'Object not found'});
      files.delete(key); return send(res, 200, {message:'Successfully deleted'});
    }
  }catch(e){ return send(res, 403, {statusCode:'403', error:'Unauthorized', message:'new row violates row-level security policy'}); }
  send(res, 405, {message:'metod'});
}

async function auth(req, res, url, body, bearer){
  const path = url.pathname.replace('/auth/v1', '');
  const grant = url.searchParams.get('grant_type');
  if(path === '/signup' && req.method === 'POST'){
    await forgetDeleted();
    const email = String(body.email||'').toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, {msg:'Unable to validate email address: invalid format'});
    if((body.password||'').length < 6) return send(res, 422, {msg:'Password should be at least 6 characters'});
    /* Som Supabase med e-postbekräftelse på: en adress som redan har ett bekräftat konto ger
       inget fel (det skulle avslöja vilka adresser som finns) utan en låtsasanvändare utan
       identities — och inget mejl. Ett obekräftat konto får en ny kod. */
    const ex = users.get(email);
    if(ex && (ex.confirmed || !cfg.confirm)){
      if(!cfg.confirm) return send(res, 422, {msg:'User already registered'});
      return send(res, 200, {id:'00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12,'0'), email, identities:[], user_metadata:{}});
    }
    const u = ex || await addUser(email, body.password, body.data);
    if(ex){ u.password = body.password; u.meta = body.data || u.meta; }
    if(!u.confirmed){
      u.code = newCode();
      mail.push({to:email, type:'signup', code:u.code, link:'#access_token=' + jwt(u) + '&refresh_token=' + session(u).refresh_token + '&expires_in=3600&type=signup'});
      return send(res, 200, {id:u.id, email, identities:[{provider:'email'}], user_metadata:u.meta});
    }
    return send(res, 200, session(u));
  }
  /* koden från mejlet (Supabase: verifyOtp type signup) */
  if(path === '/verify' && req.method === 'POST'){
    const u = users.get(String(body.email||'').toLowerCase());
    if(!u || !u.code || String(body.token||'').trim() !== u.code)
      return send(res, 403, {code:403, error_code:'otp_expired', msg:'Token has expired or is invalid'});
    u.confirmed = true; u.code = null;
    return send(res, 200, session(u));
  }
  if(path === '/resend' && req.method === 'POST'){
    const u = users.get(String(body.email||'').toLowerCase());
    if(u && !u.confirmed){ u.code = newCode(); mail.push({to:u.email, type:'signup', code:u.code}); }
    return send(res, 200, {});
  }
  if(path === '/token' && grant === 'password'){
    await forgetDeleted();
    const u = users.get(String(body.email||'').toLowerCase());
    if(!u || u.password !== body.password) return send(res, 400, {code:400, error_code:'invalid_credentials', msg:'Invalid login credentials'});
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
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks), raw = buf.toString('utf8');
    /* edge-funktionen anropar emulatorn själv — därför utanför kön */
    if(req.url.startsWith('/functions/v1/auth-login')){
      let b = {}; try{ b = raw ? JSON.parse(raw) : {}; }catch(e){}
      try{ const r = await LOGIN.handle(b, '127.0.0.1'); return send(res, r.status, r.body); }
      catch(e){ return send(res, 500, {error_description:e.message}); }
    }
    serial(async () => {
    const url = new URL(req.url, 'http://x');
    let body = null; if(!url.pathname.startsWith('/storage/')){ try{ body = raw ? JSON.parse(raw) : null; }catch(e){} }
    if(url.pathname === '/__mail') return send(res, 200, mail);
    if(url.pathname === '/__outbox') return send(res, 200, await q(`select id, member_id, email, subject, body, link, kind, dedupe_key, n, send_after from outbox order by id`));
    /* bara för tester: kör SQL som databasens ägare (t.ex. simulera att en post försvunnit) */
    if(url.pathname === '/__sql'){ try{ return send(res, 200, await q(body.sql)); }catch(e){ return send(res, 400, {message:e.message}); } }
    if(url.pathname === '/__config'){ Object.assign(cfg, body||{}); return send(res, 200, cfg); }
    /* en signerad fillänk öppnas utan nycklar (som i Supabase) */
    if(url.pathname.startsWith('/storage/v1/object/sign/') && req.method === 'GET') return await storage(req, res, url, buf, null, false);
    if(req.headers.apikey !== ANON && req.headers.apikey !== SERVICE) return send(res, 401, {message:'Invalid API key'});
    const bearer = String(req.headers.authorization||'').replace(/^Bearer /, '');
    const uid = bearer && bearer !== ANON ? tokenSub(bearer) : null;
    try{
      if(url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, body||{}, bearer);
      if(url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, body, uid, req.headers.apikey === SERVICE);
      if(url.pathname.startsWith('/storage/v1/object/')) return await storage(req, res, url, buf, uid, req.headers.apikey === SERVICE);
      send(res, 404, {message:'okänd väg'});
    }catch(e){ send(res, 500, {message:e.message}); }
    });
  });
}).listen(PORT, () => console.log('Supabase-emulator på http://localhost:' + PORT + '  (anon key: ' + ANON + ')'));
