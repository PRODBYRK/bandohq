/* =====================================================================
   BANDOHQ · notify-send — skickar notiserna i utkorgen.
   Bokningsbekräftelser, förfrågningar, svar och inbjudningar går alltid som
   MEJL via Resend (och som push till den som har det påslaget). Påminnelser,
   timmar och agenda går först som PUSH och bara som mejl om ingen enhet tar
   emot dem. Anropas varje minut av pg_cron (db/05-utskick.sql).

   Skyddas av CRON_SECRET (samma värde som vault-hemligheten bandohq_cron i
   db/05) — funktionen deployas utan JWT-kontroll, eftersom Supabases nya
   API-nycklar inte är JWT.

   Secrets (Edge Functions → Secrets):
     CRON_SECRET            lång slumpsträng, samma som i db/05-utskick.sql
     RESEND_KEY             Resend-nyckel som får skicka från domänen (sending access)
     MAIL_FROM              avsändare, t.ex. BANDOHQ <noreply@bandohq.se>
     MAIL_REPLY_TO          dit svar på mejlen går (valfritt)
     APP_URL                appens adress för knappen i mejlen (standard https://bandohq.se/)
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  push-nycklarna (skapas i appen: Crew → Notiser)
     VAPID_SUBJECT          mailto:din@epost.se — kontaktadress till push-tjänsterna
   SUPABASE_URL och servernyckeln finns automatiskt.

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
const TITLE = { booked: 'Bokat', request: 'Ny förfrågan', received: 'Förfrågan mottagen', answer: 'Svar på din förfrågan',
  reminder: 'Påminnelse', hours: 'Dina timmar', agenda: 'Agendan', lead: 'Ny kund', invite: 'BANDOHQ', test: 'BANDOHQ' };
const URGENT = ['request', 'answer', 'reminder', 'lead', 'booked'];
/* Det här går alltid som mejl — det ska gå att hitta i inkorgen efteråt. */
export const ALWAYS_MAIL = ['invite', 'booked', 'request', 'received', 'answer', 'lead', 'lead-ok', 'lead-no'];
const BUTTON = { invite: 'Skapa ditt konto', 'lead-ok': 'Skapa ditt konto' };

/* Servernyckeln: den gamla service_role-JWT:n om den finns, annars en ny
   sb_secret_… ur SUPABASE_SECRET_KEYS. Nya nycklar får bara skickas som apikey. */
function serviceKey() {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return all.default || Object.values(all)[0] || ''; }
  catch (_) { return ''; }
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

/* ---------- mejlet ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* Bara riktiga webbadresser i knappen — aldrig javascript: eller liknande. */
export const safeLink = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (_) { return ''; } };
export function mailHtml(row, link) {
  const paras = String(row.body || '').split(/\n\s*\n/).map((p) =>
    `<p style="color:#d6cfe8;line-height:1.6;margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = BUTTON[row.kind] || 'Öppna BANDOHQ';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#07050c;padding:32px 16px">
<div style="max-width:460px;margin:0 auto;background:#150f24;border:1px solid #2a2140;border-radius:16px;padding:28px;color:#f6f2ff">
<div style="font-weight:700;letter-spacing:.18em;font-size:18px">BANDO<span style="color:#c084fc">HQ</span></div>
<h2 style="font-size:19px;margin:22px 0 12px;color:#f6f2ff">${esc(row.subject || TITLE[row.kind] || 'BANDOHQ')}</h2>
${paras}
<a href="${esc(link)}" style="display:inline-block;margin-top:8px;background:#7c3aed;color:#fff;text-decoration:none;padding:13px 20px;border-radius:12px;font-weight:700">${esc(btn)}</a>
<p style="color:#665e80;font-size:12px;margin:22px 0 0">Mejlet skickades automatiskt från BANDOHQ. Svara på det om du har frågor.</p>
</div></div>`;
}
export const mailText = (row, link) => `${row.body}\n\n${BUTTON[row.kind] || 'Öppna BANDOHQ'}: ${link}\n`;

export async function sendMail(row) {
  const link = safeLink(row.link) || safeLink(env('APP_URL')) || 'https://bandohq.se/';
  const msg = { from: env('MAIL_FROM') || 'BANDOHQ <noreply@bandohq.se>', to: [row.email],
    subject: row.subject || TITLE[row.kind] || 'BANDOHQ', html: mailHtml(row, link), text: mailText(row, link) };
  if (env('MAIL_REPLY_TO')) msg.reply_to = env('MAIL_REPLY_TO');
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', body: JSON.stringify(msg), headers: {
    Authorization: `Bearer ${env('RESEND_KEY')}`, 'Content-Type': 'application/json',
    /* samma notis skickas aldrig två gånger, även om ett försök görs om */
    'Idempotency-Key': String(row.dedupe_key).slice(0, 256) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text).id;
}

export async function handle() {
  const vapid = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
    ? { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY'), subject: env('VAPID_SUBJECT') || 'mailto:noreply@bandohq.se' }
    : null;
  const mailOn = !!env('RESEND_KEY');
  const rows = (await rpc('outbox_claim', { p_limit: 50 })) || [];
  const out = { claimed: rows.length, push: 0, mail: 0, failed: 0 };
  for (const r of rows) {
    const always = ALWAYS_MAIL.includes(r.kind);
    let pushed = 0;
    /* 1. push till alla personens enheter (för mejl-notiser bara första försöket,
          så att ett nytt mejlförsök inte ger en push till) */
    if (r.member_id && vapid && (!always || r.attempts <= 1)) {
      for (const t of (await rpc('push_targets', { p_member: r.member_id })) || []) {
        let status = 0;
        try { status = (await sendPush(t, { title: TITLE[r.kind] || 'BANDOHQ', body: r.body, kind: r.kind, url: './' }, vapid,
          URGENT.includes(r.kind) ? 'high' : 'normal')).status; } catch (_) { status = 0; }
        const ok = status >= 200 && status < 300;
        await rpc('push_result', { p_id: t.id, p_ok: ok, p_gone: status === 404 || status === 410 });
        if (ok) pushed++;
      }
    }
    if (pushed) out.push++;
    /* 2. påminnelser, timmar och agenda: klart om pushen kom fram */
    if (pushed && !always) {
      await rpc('outbox_done', { p_id: r.id, p_ok: true, p_error: null, p_channel: 'push' });
      continue;
    }
    /* 3. mejl */
    if (mailOn && r.email) {
      try {
        await sendMail(r);
        await rpc('outbox_done', { p_id: r.id, p_ok: true, p_error: null, p_channel: pushed ? 'push+mail' : 'mail' });
        out.mail++;
      } catch (e) {
        /* mejlet görs om nästa minut (högst fem försök) */
        await rpc('outbox_done', { p_id: r.id, p_ok: false, p_error: String(e), p_channel: pushed ? 'push' : null });
        out.failed++;
      }
    } else if (pushed) {
      await rpc('outbox_done', { p_id: r.id, p_ok: true, p_error: null, p_channel: 'push' });
    } else {
      await rpc('outbox_done', { p_id: r.id, p_ok: false, p_channel: null,
        p_error: !r.email ? 'Ingen enhet med push och ingen e-postadress' : 'Mejl är inte inkopplat (RESEND_KEY saknas)' });
      out.failed++;
    }
  }
  return out;
}

/* Bara schemaläggningen (db/05) får starta ett utskick. */
export function authorized(req) {
  const want = env('CRON_SECRET');
  return !!want && req.headers.get('x-cron-secret') === want;
}

if (globalThis.Deno && Deno.serve) {
  Deno.serve(async (req) => {
    if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try { return Response.json(await handle()); }
    catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
  });
}
