/* Testar edge-funktionerna notify-send och auth-login utan Supabase och utan nätverk:
   1. krypteringen mot RFC 8291:s egna testvärden
   2. VAPID-signaturen (RFC 8292) mot den publika nyckeln
   3. hela utskicket mot riktig Postgres (PGlite), med påhittade push-tjänster
      och Resend — enheterna dekrypterar det de får, som en telefon gör.
   4. nycklar och skydd
   5. inloggning med användarnamn (auth-login)
   Kör: node notify.test.mjs  (Node 22+, läser .ts direkt) */
import { boot } from './harness.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const FN = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/functions/notify-send/index.ts');
const W = await import(FN);
const { b64uEnc, b64uDec, encryptPush, vapidHeader } = W;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (!c && x !== undefined ? '   → ' + JSON.stringify(x) : '')); };
const head = t => console.log('\n── ' + t + ' ──');
const te = new TextEncoder(), td = new TextDecoder();

/* ---------- 1. RFC 8291, bilaga A ---------- */
head('kryptering enligt RFC 8291');
const R = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ct: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'
};
const out = await encryptPush({ p256dh: R.uaPublic, auth: R.auth }, b64uDec(R.plaintext),
  { asPublic: R.asPublic, asPrivate: R.asPrivate, salt: R.salt });
ok('huvudet (salt, postsstorlek, servernyckel) stämmer byte för byte', b64uEnc(out.slice(0, 86)) === R.header, b64uEnc(out.slice(0, 86)));
ok('chiffertexten stämmer byte för byte', b64uEnc(out.slice(86)) === R.ct, b64uEnc(out.slice(86)));
ok('RFC:ns klartext är "When I grow up, I want to be a watermelon"', td.decode(b64uDec(R.plaintext)) === 'When I grow up, I want to be a watermelon');

/* mottagarsidan — det en telefon gör med det den får */
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function decryptPush(body, ua) {           /* ua: {pub, priv(CryptoKey), auth} */
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.priv, 256));
  const prkKey = await hmac(ua.auth, ecdh);
  const ikm = (await hmac(prkKey, cat(te.encode('WebPush: info\0'), ua.pub, asPub, [1]))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return td.decode(pt.slice(0, pt.lastIndexOf(2)));
}
async function newDevice() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pub, priv: kp.privateKey, auth, p256dh: b64uEnc(pub), authB: b64uEnc(auth) };
}
const dev = await newDevice();
const rt = await encryptPush({ p256dh: dev.p256dh, auth: dev.authB }, te.encode('Hej från BANDOHQ — påminnelse'));
ok('slumpat salt och ny nyckel varje gång: enheten dekrypterar rätt', await decryptPush(rt, dev) === 'Hej från BANDOHQ — påminnelse');
const rt2 = await encryptPush({ p256dh: dev.p256dh, auth: dev.authB }, te.encode('x'));
ok('två meddelanden ser aldrig likadana ut', b64uEnc(rt.slice(0, 16)) !== b64uEnc(rt2.slice(0, 16)));

/* ---------- 2. VAPID ---------- */
head('VAPID-signatur enligt RFC 8292');
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vjwk = await crypto.subtle.exportKey('jwk', vk.privateKey);
const vpub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', vk.publicKey)));
const VAPID = { publicKey: vpub, privateKey: vjwk.d, subject: 'mailto:test@bando.se' };
const hdr = await vapidHeader('https://web.push.apple.com/abc123', VAPID);
const m = hdr.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
ok('huvudet har formen "vapid t=…, k=…"', !!m && m[4] === vpub, hdr.slice(0, 40));
const claims = JSON.parse(td.decode(b64uDec(m[2])));
ok('aud är push-tjänstens ursprung, sub är kontaktadressen', claims.aud === 'https://web.push.apple.com' && claims.sub === 'mailto:test@bando.se', claims);
ok('giltig i högst 24 timmar', claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
const pk = await crypto.subtle.importKey('raw', b64uDec(vpub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok('signaturen (ES256) går att verifiera med den publika nyckeln', await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, b64uDec(m[3]), te.encode(m[1] + '.' + m[2])));

/* ---------- 3. hela utskicket ---------- */
head('utskicket: mejl för bekräftelser och förfrågningar, push först för påminnelser');
const db = await boot();
const q = async (s, p) => (await db.query(s, p)).rows;
const SETOF = ['outbox_claim', 'push_targets'];
const env = { SUPABASE_URL: 'https://proj.test', SUPABASE_SERVICE_ROLE_KEY: 'service', VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: VAPID.subject, RESEND_KEY: 're_test_123',
  MAIL_FROM: 'BANDOHQ <noreply@bandohq.se>', MAIL_REPLY_TO: 'svar@bando.se', APP_URL: 'https://bandohq.se/' };
Object.assign(process.env, env);
const got = { push: {}, mail: [] };
const devices = {};
let mailDown = false;
const rpcFetch = async (url, opt) => {
  const fn = url.split('/rpc/')[1], a = JSON.parse(opt.body || '{}'), ks = Object.keys(a);
  const vals = ks.map(k => a[k]);
  const sql = SETOF.includes(fn) ? `select * from ${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(',')})`
                                 : `select ${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(',')}) as v`;
  const rows = await q(sql, vals);
  return new Response(JSON.stringify(SETOF.includes(fn) ? rows : rows[0].v), { status: 200 });
};
globalThis.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith(env.SUPABASE_URL + '/rest/v1/rpc/')) return rpcFetch(url, opt);
  if (url.startsWith('https://push.test/')) {
    const id = url.split('/').pop(), d = devices[id];
    if (!d) return new Response('', { status: 410 });
    if (!/^vapid t=/.test(opt.headers.Authorization)) return new Response('', { status: 401 });
    const msg = JSON.parse(await decryptPush(new Uint8Array(opt.body), d));
    (got.push[id] = got.push[id] || []).push(Object.assign(msg, { urgency: opt.headers.Urgency }));
    return new Response('', { status: 201 });
  }
  if (url === 'https://api.resend.com/emails') {
    if (mailDown) return new Response('{"message":"Resend nere"}', { status: 500 });
    got.mail.push(Object.assign(JSON.parse(opt.body), { headers: opt.headers }));
    return new Response(JSON.stringify({ id: 'mail-' + got.mail.length }), { status: 200 });
  }
  throw new Error('oväntat anrop ' + url);
};
const M = (id, name, email) => q(`insert into members(id,role,name,email) values($1,'producer',$2,$3)`, [id, name, email]);
await M('ada', 'Ada', 'ada@b.se'); await M('bo', 'Bo', 'bo@b.se'); await M('cy', 'Cy', null); await M('di', 'Di', 'di@b.se');
const devA = await newDevice(), devA2 = await newDevice(); devices.ada1 = devA; devices.ada2 = devA2;
const sub = (mid, ep, d) => q(`insert into push_subs(member_id,endpoint,p256dh,auth) values($1,$2,$3,$4)`, [mid, 'https://push.test/' + ep, d.p256dh, d.authB]);
await sub('ada', 'ada1', devA); await sub('ada', 'ada2', devA2);
await sub('cy', 'cy-gammal', await newDevice());                 /* finns inte längre hos push-tjänsten → 410 */
const now = `now() - interval '1 minute'`;
const Q = (mid, subject, body, kind, key, email, link) => q(`insert into outbox(member_id,email,subject,body,kind,dedupe_key,send_after,link)
  values($1, coalesce($6, (select email from members where id=$1)), $2, $3, $4, $5, ${now}, $7)`, [mid, subject, body, kind, key, email || null, link || null]);
await Q('ada', 'Ny bokningsförfrågan från Bo', 'Ny förfrågan från Bo', 'request', 'k1');
await Q('bo', 'Påminnelse: imorgon 18-21', 'Påminnelse: imorgon 18-21', 'reminder', 'k2');
await Q('cy', 'Agendan har uppdaterats', 'Agendan har uppdaterats', 'agenda', 'k3');
await Q(null, 'Bokningsbekräftelse: tor 9 okt', 'Hej Kim! Din tid är bokad.', 'lead-ok', 'k4', 'kund@example.se', 'https://bandohq.se/#join=ABCD-123456');
await Q('ada', 'Påminnelse: imorgon 10-12', 'Påminnelse: imorgon 10-12', 'reminder', 'k5');
await Q('di', 'Bokningsbekräftelse', 'Hej Di! Det här är bokat:\n\ntor 9 okt 18:00-22:00 · Studio A · <script>alert(1)</script>', 'booked', 'k6', null, 'javascript:alert(1)');
let res = await W.handle();
const row = async k => (await q(`select * from outbox where dedupe_key=$1`, [k]))[0];
const mailTo = a => got.mail.filter(m => m.to[0] === a);
const req1 = id => (got.push[id] || []).filter(p => p.body === 'Ny förfrågan från Bo').length;
ok('förfrågan till Ada: push till BÅDA enheterna OCH ett mejl', req1('ada1') === 1 && req1('ada2') === 1
   && mailTo('ada@b.se').length === 1 && (await row('k1')).channel === 'push+mail');
ok('enheten får rubrik, text och brådska', got.push.ada1[0].title === 'Ny förfrågan' && got.push.ada1[0].body === 'Ny förfrågan från Bo' && got.push.ada1[0].urgency === 'high', got.push.ada1[0]);
ok('påminnelse till Ada (har push): bara push, inget mejl', (got.push.ada1 || []).some(p => /10-12/.test(p.body))
   && !mailTo('ada@b.se').some(m => /10-12/.test(m.subject)) && (await row('k5')).channel === 'push');
ok('påminnelse till Bo (ingen push): som mejl', mailTo('bo@b.se').some(m => m.subject === 'Påminnelse: imorgon 18-21') && (await row('k2')).channel === 'mail');
const m1 = mailTo('ada@b.se')[0];
ok('avsändare, svarsadress och ämne', m1.from === 'BANDOHQ <noreply@bandohq.se>' && m1.reply_to === 'svar@bando.se' && m1.subject === 'Ny bokningsförfrågan från Bo', m1);
ok('Resend-nyckeln som Bearer, dedupe-nyckeln som Idempotency-Key', m1.headers.Authorization === 'Bearer re_test_123' && m1.headers['Idempotency-Key'] === 'k1', m1.headers);
ok('mejlet har både HTML och textversion', /BANDO<span/.test(m1.html) && /Ny förfrågan från Bo/.test(m1.text));
const m4 = mailTo('kund@example.se')[0];
ok('ny kund utan konto: mejl med knappen "Skapa ditt konto" och länken', !!m4 && /Skapa ditt konto/.test(m4.html)
   && m4.html.includes('href="https://bandohq.se/#join=ABCD-123456"') && m4.text.includes('https://bandohq.se/#join=ABCD-123456'), m4 && m4.html.slice(-400));
const m6 = mailTo('di@b.se')[0];
ok('text från användare escapas i HTML (ingen <script>)', !!m6 && !/<script>/.test(m6.html) && /&lt;script&gt;/.test(m6.html));
ok('stycken och radbrytningar blir <p> och <br>', (m6.html.match(/<p style/g) || []).length >= 3);
ok('en javascript:-länk byts mot appens adress', m6.html.includes('href="https://bandohq.se/"') && !/javascript:/.test(m6.html));
const c3 = await row('k3');
ok('Cy: enheten finns inte längre och ingen e-post → fel, inget skickat', !c3.sent_at && /ingen e-postadress/.test(c3.error), c3.error);
ok('och den döda enheten städas bort', (await q(`select 1 from push_subs where member_id='cy'`)).length === 0);
ok('summering från funktionen', res.claimed === 6 && res.mail === 4 && res.failed === 1, res);

/* Resend nere: mejlet görs om — men pushen skickas inte en gång till */
head('när Resend är nere');
got.mail = []; got.push = {}; mailDown = true;
await Q('ada', 'Bokningsbekräftelse', 'Hej Ada! Bokat: fre 10 okt', 'booked', 'k7');
await W.handle();
const c7 = await row('k7');
ok('mejlet misslyckas → raden ligger kvar osänd med felet', !c7.sent_at && /500/.test(c7.error) && c7.attempts === 1, c7);
ok('pushen gick fram första gången', (got.push.ada1 || []).length === 1);
mailDown = false; got.push = {};
await q(`update outbox set send_after = now() - interval '1 minute' where dedupe_key = 'k7'`);
await W.handle();
const c7b = await row('k7');
ok('nästa körning: mejlet går, och ingen andra push', !!c7b.sent_at && mailTo('ada@b.se').length === 1 && !(got.push.ada1 || []).length, c7b);
const again = await W.handle();
ok('skickat skickas aldrig igen — bara Cy försöks om', again.claimed === 1 && again.mail === 0, again);

/* utan Resend-nyckel: tydligt fel */
delete process.env.RESEND_KEY;
await Q('di', 'Tiden gick tyvärr inte', 'Tyvärr gick tor 9 okt inte.', 'answer', 'k8');
await W.handle();
ok('utan RESEND_KEY skickas inget mejl, felet säger varför', /Mejl är inte inkopplat/.test((await row('k8')).error));
process.env.RESEND_KEY = env.RESEND_KEY;
ok('ALWAYS_MAIL innehåller bekräftelser, förfrågningar, svar och inbjudningar',
   ['booked', 'request', 'received', 'answer', 'invite', 'lead-ok', 'lead-no'].every(k => W.ALWAYS_MAIL.includes(k)) && !W.ALWAYS_MAIL.includes('reminder'));

/* ---------- 4. nycklar och skydd ---------- */
head('nycklar och skydd');
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => { if (String(url).includes('/rest/v1/rpc/')) seen.push(opt.headers); return realFetch(url, opt); };
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: 'sb_secret_abc123' });
await W.handle();
ok('ny servernyckel (sb_secret_…) läses ur SUPABASE_SECRET_KEYS', seen.length > 0 && seen.every(h => h.apikey === 'sb_secret_abc123'), seen[0]);
ok('och skickas bara som apikey, aldrig som Bearer', seen.every(h => !h.Authorization), seen[0]);
seen.length = 0; process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiJ9.e30.x';
await W.handle();
ok('gamla service_role-JWT:n används först, då även som Bearer', seen.every(h => h.apikey.startsWith('eyJ') && h.Authorization === 'Bearer ' + h.apikey));
const req = h => ({ headers: new Headers(h) });
process.env.CRON_SECRET = 'hemlig-cron-123';
ok('utan rätt hemlighet startar inget utskick', !W.authorized(req({})) && !W.authorized(req({ 'x-cron-secret': 'fel' })));
ok('med hemligheten från schemaläggningen går det', W.authorized(req({ 'x-cron-secret': 'hemlig-cron-123' })));
delete process.env.CRON_SECRET;
ok('saknas CRON_SECRET helt är funktionen stängd', !W.authorized(req({ 'x-cron-secret': '' })));

/* ---------- 5. inloggning med användarnamn ---------- */
head('auth-login: användarnamn → inloggning');
const A = await import(join(dirname(fileURLToPath(import.meta.url)), '../../supabase/functions/auth-login/index.ts'));
const uid = (await q(`insert into auth.users(email) values('rkay@b.se') returning id`))[0].id;
await q(`insert into members(id,user_id,role,name,email,username) values('rkay',$1,'producer','RKAY','rkay@b.se','rkay')`, [uid]);
process.env.SUPABASE_PUBLISHABLE_KEYS = JSON.stringify({ default: 'sb_publishable_xyz' });
const authCalls = [];
globalThis.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith(env.SUPABASE_URL + '/rest/v1/rpc/')) return rpcFetch(url, opt);
  if (url.startsWith(env.SUPABASE_URL + '/auth/v1/')) {
    const b = JSON.parse(opt.body || '{}'); authCalls.push({ url, body: b, headers: opt.headers });
    if (url.includes('/token?grant_type=password'))
      return b.email === 'rkay@b.se' && b.password === 'ratt-losen'
        ? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: uid, email: b.email } }), { status: 200 })
        : new Response(JSON.stringify({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), { status: 400 });
    if (url.includes('/recover')) return new Response('{}', { status: 200 });
  }
  throw new Error('oväntat anrop ' + url);
};
let r = await A.handle({ username: 'rkay', password: 'ratt-losen' }, '81.2.3.4');
const tok = authCalls.find(c => c.url.includes('grant_type=password'));
ok('rätt användarnamn och lösenord → sessionen', r.status === 200 && r.body.access_token === 'at', r);
ok('inloggningen görs med personens e-post och den publika nyckeln', tok.body.email === 'rkay@b.se' && tok.headers.apikey === 'sb_publishable_xyz', tok);
ok('besökarens IP skickas vidare (Supabases egen gräns räknas per besökare)', tok.headers['X-Forwarded-For'] === '81.2.3.4');
r = await A.handle({ username: '  RKAY ', password: 'ratt-losen' });
ok('stora bokstäver och mellanslag spelar ingen roll', r.status === 200);
const wrong = await A.handle({ username: 'rkay', password: 'fel' });
const unknown = await A.handle({ username: 'finnsinte', password: 'fel' });
ok('fel lösenord → samma svar som ett okänt användarnamn', wrong.status === 400 && unknown.status === 400
   && /Invalid login credentials/.test(wrong.body.msg || wrong.body.error_description) && /Invalid login credentials/.test(unknown.body.error_description), [wrong, unknown]);
ok('ingen e-postadress läcker i svaren', !JSON.stringify([wrong, unknown]).includes('@'));
ok('felen räknas per användarnamn', (await q(`select count(*)::int n from login_fails where username='rkay'`))[0].n === 1);
for (let i = 0; i < 9; i++) await A.handle({ username: 'rkay', password: 'fel' });
authCalls.length = 0;
r = await A.handle({ username: 'rkay', password: 'ratt-losen' });
ok('efter 10 fel på en kvart: spärrat, även med rätt lösenord', r.status === 429 && /vänta en kvart/.test(r.body.error_description) && authCalls.length === 0, r);
await q(`update login_fails set at = now() - interval '20 minutes'`);
r = await A.handle({ username: 'rkay', password: 'ratt-losen' });
ok('efter en kvart går det igen', r.status === 200);
authCalls.length = 0;
r = await A.handle({ action: 'recover', username: 'rkay', redirect_to: 'https://bandohq.se/' });
const rec = authCalls.find(c => c.url.includes('/recover'));
ok('glömt lösenordet med användarnamn → återställningsmejl till personens e-post', r.status === 200 && rec && rec.body.email === 'rkay@b.se'
   && rec.url.includes('redirect_to=' + encodeURIComponent('https://bandohq.se/')), rec);
authCalls.length = 0;
const r2 = await A.handle({ action: 'recover', username: 'finnsinte' });
ok('okänt användarnamn: samma svar, inget mejl', r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r.body) && authCalls.length === 0);
r = await A.handle({ username: 'a b"; drop', password: 'x' });
ok('ogiltigt användarnamn avvisas direkt', r.status === 400 && authCalls.length === 0);

console.log('\n══════════════════════════════');
console.log(pass + ' PASS · ' + fail + ' FAIL'); console.log(fail ? '✗ TRASIGT' : '✓ ALLT GRÖNT');
process.exit(fail ? 1 : 0);
