/* =====================================================================
   BANDOHQ · notify-send — skickar notiserna i utkorgen.
   Först som PUSH till personens enheter (gratis). Har personen ingen
   enhet med push påslaget, eller tar ingen emot den, går notisen som
   SMS via 46elks. Anropas varje minut av pg_cron (db/05-sms-utskick.sql).

   Secrets (Edge Functions → notify-send → Secrets):
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  push-nycklarna (skapas i appen: Crew → Notiser)
     VAPID_SUBJECT          mailto:din@epost.se — kontaktadress till push-tjänsterna
     ELKS_USER, ELKS_PASS   46elks (valfritt: utan dem går bara push)
     ELKS_FROM              SMS-avsändare, högst 11 tecken (standard BANDOHQ)
     ELKS_DRYRUN            "yes" = 46elks låtsas skicka
   SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY finns automatiskt.

   Webb-push är skrivet direkt mot standarderna (RFC 8291 kryptering,
   RFC 8292 VAPID) med WebCrypto — inga bibliotek. Testas mot RFC:ns
   egna testvärden i db/test/notify.test.mjs.
   ===================================================================== */

/* ---------- webb-push ---------- */
const enc = new TextEncoder();
export const b64uEnc = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64uDec = (s) => {
  s = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of parts) { out.set(x, i); i += x.length; }
  return out;
};
const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
};
/* publik nyckel (65 byte, okomprimerad) + ev. privat d → JWK */
const ecJwk = (pubRaw, d) => Object.assign({ kty: 'EC', crv: 'P-256', ext: true,
  x: b64uEnc(pubRaw.slice(1, 33)), y: b64uEnc(pubRaw.slice(33, 65)) }, d ? { d } : {});

/* RFC 8291: krypterar meddelandet till en enhet (aes128gcm, en post).
   `fixed` används bara av testerna (salt och servernyckel från RFC:n). */
export async function encryptPush(sub, plaintext, fixed) {
  const uaPub = b64uDec(sub.p256dh), auth = b64uDec(sub.auth);
  let asPriv, asPub;
  if (fixed) {
    asPub = b64uDec(fixed.asPublic);
    asPriv = await crypto.subtle.importKey('jwk', ecJwk(asPub, fixed.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const salt = fixed ? b64uDec(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = (await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, [1]))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, [2])));
  const head = new Uint8Array(21);
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return concat(head, asPub, ct);
}

/* RFC 8292: VAPID-huvudet som visar push-tjänsten att det är vi som skickar. */
export async function vapidHeader(endpoint, vapid) {
  const pub = b64uDec(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', ecJwk(pub, vapid.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64uEnc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64uEnc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p)));
  return `vapid t=${h}.${p}.${b64uEnc(sig)}, k=${vapid.publicKey}`;
}

export async function sendPush(target, payload, vapid, urgency) {
  const body = await encryptPush({ p256dh: target.p256dh, auth: target.auth }, enc.encode(JSON.stringify(payload)));
  return fetch(target.endpoint, { method: 'POST', body, headers: {
    Authorization: await vapidHeader(target.endpoint, vapid), TTL: '43200', Urgency: urgency || 'normal',
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
}

/* ---------- utskicket ---------- */
const env = (k) => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) || '';
const TITLE = { request: 'Ny förfrågan', answer: 'Svar på din förfrågan', reminder: 'Påminnelse', hours: 'Dina timmar',
  agenda: 'Agendan', lead: 'Ny kund', invite: 'BANDOHQ', test: 'BANDOHQ' };
const URGENT = ['request', 'answer', 'reminder', 'lead'];

async function rpc(fn, args) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function sendSms(row) {
  const body = new URLSearchParams({ from: (env('ELKS_FROM') || 'BANDOHQ').slice(0, 11), to: row.phone, message: row.body });
  if (env('ELKS_DRYRUN') === 'yes') body.set('dryrun', 'yes');
  const res = await fetch('https://api.46elks.com/a1/sms', { method: 'POST', body,
    headers: { Authorization: 'Basic ' + btoa(`${env('ELKS_USER')}:${env('ELKS_PASS')}`), 'Content-Type': 'application/x-www-form-urlencoded' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  const j = JSON.parse(text);
  return j.estimated_cost ?? j.cost ?? null;
}

export async function handle() {
  const vapid = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
    ? { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY'), subject: env('VAPID_SUBJECT') || 'mailto:noreply@bandocollective.com' }
    : null;
  const smsOn = !!env('ELKS_USER');
  const policy = (await rpc('notify_policy', {})) || {};
  const rows = (await rpc('sms_claim', { p_limit: 50 })) || [];
  const out = { claimed: rows.length, push: 0, sms: 0, failed: 0 };
  for (const r of rows) {
    let pushed = 0;
    /* 1. push till alla personens enheter */
    if (r.member_id && vapid) {
      for (const t of (await rpc('push_targets', { p_member: r.member_id })) || []) {
        let status = 0;
        try { status = (await sendPush(t, { title: TITLE[r.kind] || 'BANDOHQ', body: r.body, kind: r.kind, url: './' }, vapid,
          URGENT.includes(r.kind) ? 'high' : 'normal')).status; } catch (_) { status = 0; }
        const ok = status >= 200 && status < 300;
        await rpc('push_result', { p_id: t.id, p_ok: ok, p_gone: status === 404 || status === 410 });
        if (ok) pushed++;
      }
    }
    /* 2. SMS som reserv — eller också, för påminnelser och timmar om admin valt det */
    const critical = !!policy.criticalSms && ['reminder', 'hours'].includes(r.kind);
    if (pushed && !critical) {
      await rpc('sms_done', { p_id: r.id, p_ok: true, p_cost: null, p_error: null, p_channel: 'push' });
      out.push++; continue;
    }
    if (smsOn && r.phone) {
      try {
        const cost = await sendSms(r);
        await rpc('sms_done', { p_id: r.id, p_ok: true, p_cost: cost, p_error: null, p_channel: pushed ? 'push+sms' : 'sms' });
        out.sms++; if (pushed) out.push++;
      } catch (e) {
        await rpc('sms_done', { p_id: r.id, p_ok: !!pushed, p_cost: null, p_error: pushed ? null : String(e), p_channel: pushed ? 'push' : null });
        if (pushed) out.push++; else out.failed++;
      }
    } else if (pushed) {
      await rpc('sms_done', { p_id: r.id, p_ok: true, p_cost: null, p_error: null, p_channel: 'push' });
      out.push++;
    } else {
      await rpc('sms_done', { p_id: r.id, p_ok: false, p_cost: null, p_channel: null,
        p_error: !r.phone ? 'Ingen enhet med push och inget mobilnummer' : 'Ingen push och SMS är inte inkopplat (ELKS_USER saknas)' });
      out.failed++;
    }
  }
  return out;
}

if (globalThis.Deno && Deno.serve) {
  Deno.serve(async () => {
    try { return Response.json(await handle()); }
    catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
  });
}
