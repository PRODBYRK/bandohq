/* =====================================================================
   BANDOHQ · auth-login — inloggning med användarnamn.
   Supabase loggar in med e-post. Den här funktionen tar ett användarnamn,
   slår upp e-posten på servern och loggar in åt personen — så att ingen
   mejladress någonsin skickas till webbläsaren. "Glömt lösenordet?" går
   samma väg och svarar alltid likadant, vare sig namnet finns eller inte.
   Efter 10 fel på en kvart är användarnamnet spärrat en stund.

   Anropas av appen (publikt, utan JWT-kontroll):
     POST /functions/v1/auth-login  {username, password}            → sessionen
     POST /functions/v1/auth-login  {action:'recover', username, redirect_to} → {}
   Inga egna secrets: SUPABASE_URL och nycklarna finns automatiskt.
   ===================================================================== */
const env = (k) => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) || '';
const MAX_FAILS = 10;
export const USERNAME = /^[a-z0-9._-]{2,24}$/;

/* Servernyckeln (bara för uppslaget) — gamla JWT:n eller en ny sb_secret_…. */
function serviceKey() {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return all.default || Object.values(all)[0] || ''; }
  catch (_) { return ''; }
}
/* Publika nyckeln — inloggningen görs som en vanlig besökare. */
function publicKey() {
  try { const all = JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') || '{}'); const k = all.default || Object.values(all)[0]; if (k) return k; }
  catch (_) { /* gamla nycklar */ }
  return env('SUPABASE_ANON_KEY');
}
async function rpc(fn, args) {
  const key = serviceKey();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}), headers });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const auth = (path, body, ip) => fetch(`${env('SUPABASE_URL')}/auth/v1${path}`, { method: 'POST', body: JSON.stringify(body),
  headers: Object.assign({ apikey: publicKey(), 'Content-Type': 'application/json' }, ip ? { 'X-Forwarded-For': ip } : {}) });

const WRONG = { error: 'invalid_grant', error_description: 'Invalid login credentials' };

/* Svarar {status, body}. ip skickas vidare så att Supabases egen gräns räknas per besökare. */
export async function handle(body, ip) {
  const name = String(body?.username || '').trim().toLowerCase();
  if (body?.action === 'recover') {
    if (USERNAME.test(name)) {
      const look = await rpc('bs_login_lookup', { p_username: name });
      if (look?.email) {
        const to = String(body.redirect_to || '');
        await auth('/recover' + (to ? '?redirect_to=' + encodeURIComponent(to) : ''), { email: look.email }, ip);
      }
    }
    return { status: 200, body: {} };                 /* samma svar oavsett — avslöjar inget */
  }
  if (!USERNAME.test(name) || !body?.password) return { status: 400, body: WRONG };
  const look = await rpc('bs_login_lookup', { p_username: name });
  if ((look?.fails || 0) >= MAX_FAILS) {
    return { status: 429, body: { error: 'too_many', error_description: 'För många försök — vänta en kvart och försök igen' } };
  }
  if (!look?.email) { await rpc('bs_login_fail', { p_username: name }); return { status: 400, body: WRONG }; }
  const r = await auth('/token?grant_type=password', { email: look.email, password: String(body.password) }, ip);
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch (_) { j = { error_description: text }; }
  if (!r.ok) {
    if (r.status === 400 && /invalid/i.test(j.error_description || j.msg || '')) await rpc('bs_login_fail', { p_username: name });
    return { status: r.status, body: j };
  }
  return { status: 200, body: j };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' };

if (globalThis.Deno && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return Response.json({ error: 'POST' }, { status: 405, headers: CORS });
    let body = {}; try { body = await req.json(); } catch (_) { /* tom */ }
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    try { const r = await handle(body, ip); return Response.json(r.body, { status: r.status, headers: CORS }); }
    catch (e) { return Response.json({ error: 'server', error_description: 'Inloggningen strular just nu — försök igen' }, { status: 500, headers: CORS }); }
  });
}
