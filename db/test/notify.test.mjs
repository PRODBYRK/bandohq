/* Testar edge-funktionen notify-send utan Supabase och utan nätverk:
   1. krypteringen mot RFC 8291:s egna testvärden
   2. VAPID-signaturen (RFC 8292) mot den publika nyckeln
   3. hela utskicket mot riktig Postgres (PGlite), med påhittade push-tjänster
      och 46elks — enheterna dekrypterar det de får, som en telefon gör.
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
head('utskicket: push först, SMS som reserv');
const db = await boot();
const q = async (s, p) => (await db.query(s, p)).rows;
const SETOF = ['sms_claim', 'push_targets'];
const env = { SUPABASE_URL: 'https://proj.test', SUPABASE_SERVICE_ROLE_KEY: 'service', VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: VAPID.subject, ELKS_USER: 'u', ELKS_PASS: 'p' };
Object.assign(process.env, env);
const got = { push: {}, sms: [] };
const devices = {};
globalThis.fetch = async (url, opt) => {
  url = String(url);
  if (url.startsWith(env.SUPABASE_URL + '/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1], a = JSON.parse(opt.body || '{}'), ks = Object.keys(a);
    const vals = ks.map(k => a[k]);
    const sql = SETOF.includes(fn) ? `select * from ${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(',')})`
                                   : `select ${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(',')}) as v`;
    const rows = await q(sql, vals);
    return new Response(JSON.stringify(SETOF.includes(fn) ? rows : rows[0].v), { status: 200 });
  }
  if (url.startsWith('https://push.test/')) {
    const id = url.split('/').pop(), d = devices[id];
    if (!d) return new Response('', { status: 410 });
    if (!/^vapid t=/.test(opt.headers.Authorization)) return new Response('', { status: 401 });
    const msg = JSON.parse(await decryptPush(new Uint8Array(opt.body), d));
    (got.push[id] = got.push[id] || []).push(Object.assign(msg, { urgency: opt.headers.Urgency }));
    return new Response('', { status: 201 });
  }
  if (url === 'https://api.46elks.com/a1/sms') {
    const f = new URLSearchParams(opt.body.toString());
    got.sms.push({ to: f.get('to'), message: f.get('message'), from: f.get('from') });
    return new Response(JSON.stringify({ status: 'created', cost: 3500 }), { status: 200 });
  }
  throw new Error('oväntat anrop ' + url);
};
const M = (id, name, phone) => q(`insert into members(id,role,name,phone) values($1,'producer',$2,$3)`, [id, name, phone]);
await M('ada', 'Ada', '+46701111111'); await M('bo', 'Bo', '+46702222222'); await M('cy', 'Cy', null); await M('di', 'Di', '+46704444444');
const devA = await newDevice(), devA2 = await newDevice(); devices.ada1 = devA; devices.ada2 = devA2;
const sub = (mid, ep, d) => q(`insert into push_subs(member_id,endpoint,p256dh,auth) values($1,$2,$3,$4)`, [mid, 'https://push.test/' + ep, d.p256dh, d.authB]);
await sub('ada', 'ada1', devA); await sub('ada', 'ada2', devA2);
await sub('cy', 'cy-gammal', await newDevice());                 /* finns inte längre hos push-tjänsten → 410 */
const now = `now() - interval '1 minute'`;
const Q = (mid, body, kind, key) => q(`insert into sms_outbox(member_id,phone,body,kind,dedupe_key,send_after)
  values($1, coalesce((select phone from members where id=$1),''), $2, $3, $4, ${now})`, [mid, body, kind, key]);
await Q('ada', 'Ny förfrågan från Bo', 'request', 'k1');
await Q('bo', 'Påminnelse: imorgon 18-21', 'reminder', 'k2');
await Q('cy', 'Agendan har uppdaterats', 'agenda', 'k3');
await q(`insert into sms_outbox(member_id,phone,body,kind,dedupe_key,send_after) values(null,'+46735550000','Din tid är bokad','lead','k4',${now})`);
let res = await W.handle();
const row = async k => (await q(`select * from sms_outbox where dedupe_key=$1`, [k]))[0];
ok('Ada har push: notisen går som push till BÅDA hennes enheter', (got.push.ada1 || []).length === 1 && (got.push.ada2 || []).length === 1);
ok('enheten får rubrik, text och brådska', got.push.ada1[0].title === 'Ny förfrågan' && got.push.ada1[0].body === 'Ny förfrågan från Bo' && got.push.ada1[0].urgency === 'high', got.push.ada1[0]);
ok('och inget SMS till Ada', !got.sms.some(s => s.to === '+46701111111') && (await row('k1')).channel === 'push');
ok('Bo har inte push: notisen går som SMS', got.sms.some(s => s.to === '+46702222222' && /imorgon/.test(s.message)) && (await row('k2')).channel === 'sms');
ok('avsändaren är BANDOHQ och kostnaden sparas', got.sms[0].from === 'BANDOHQ' && (await row('k2')).cost === 3500);
const c3 = await row('k3');
ok('Cy: enheten finns inte längre och inget nummer → fel, inget skickat', !c3.sent_at && /inget mobilnummer/.test(c3.error), c3.error);
ok('och den döda enheten städas bort', (await q(`select 1 from push_subs where member_id='cy'`)).length === 0);
ok('ny kund (inget konto) får alltid SMS', got.sms.some(s => s.to === '+46735550000') && (await row('k4')).channel === 'sms');
ok('summering från funktionen', res.claimed === 4 && res.push === 1 && res.sms === 2 && res.failed === 1, res);

/* admin har valt "viktiga notiser även som SMS" */
await q(`insert into records(kind,id,data,up) values('setting','notify','{"criticalSms":true}',1)`);
got.sms = []; got.push = {};
await Q('ada', 'Påminnelse: imorgon 10-12', 'reminder', 'k5');
await Q('ada', 'Agendan: 2 nya', 'agenda', 'k6');
await W.handle();
ok('påminnelse går som push OCH SMS när admin valt det', (got.push.ada1 || []).some(p=>/10-12/.test(p.body)) && got.sms.some(s => s.to === '+46701111111') && (await row('k5')).channel === 'push+sms');
ok('vanliga notiser går fortfarande bara som push', (await row('k6')).channel === 'push' && got.sms.length === 1);

/* utan 46elks: bara push, och den som saknar push får ett tydligt fel */
delete process.env.ELKS_USER;
got.sms = [];
await Q('di', 'Svar på din förfrågan', 'answer', 'k7');
await W.handle();
const c7 = await row('k7');
ok('utan 46elks skickas inget SMS, felet säger varför', got.sms.length === 0 && /SMS är inte inkopplat/.test(c7.error), c7.error);
const again = await W.handle();
ok('nästa körning försöker bara om det som misslyckats (Cy, Di) — skickat skickas aldrig igen', again.claimed === 2 && again.push === 0, again);

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

console.log('\n══════════════════════════════');
console.log(pass + ' PASS · ' + fail + ' FAIL'); console.log(fail ? '✗ TRASIGT' : '✓ ALLT GRÖNT');
process.exit(fail ? 1 : 0);
