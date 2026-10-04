# Tester

Kräver en lokal server — `file://` funkar inte (localStorage och crypto strular).

```
cd ..            # projektmappen, där index.html ligger
python3 -m http.server 8000
```

| Sida | Vad | Antal |
|---|---|---|
| `test/test.html` | appen i förhandsläget: roller (även admin och kamera), förfrågningar, timmar, synk, agenda, veckoplan, texttolken, Dropbox-mocken, galleri, beatprofiler, inbjudningar med användarnamn, lägg till person med e-post, bjud in någon som redan finns, kunder och bokningssidan, artistgrader och kalkylarksimport, push-filerna, integritet, säkerhetskopia, radera person, öppettider | 316 |
| `test/cloud.html` | appen mot Supabase-emulatorn: inloggning med användarnamn eller e-post, inbjudningslänkar, koden vid första inloggningen (fel kod, ny kod, annan enhet), RLS sett från webbläsaren, godkännanden, kundförfrågningar, ny kund via bokningssidan, admin, utkorgen med mejlen, push, säkerhetskopia, radering, glömt lösenord (även med användarnamn), inbjudan till RKAY som redan finns, flytten från förhandsvisningen | 116 |
| `db/test/db.test.mjs` | behörigheter, stängda interna funktioner, notiskön (orderbekräftelser, kvitton, svar, timmar, agenda), påminnelser, inbjudningar per mejl och till befintliga personer, användarnamn, nya kunder, push och radering direkt i Postgres (`node db.test.mjs`) | 203 |
| `db/test/notify.test.mjs` | edge-funktionerna: notify-send (kryptering mot RFC 8291:s testvärden, VAPID, mejl via Resend, push först för påminnelser) och auth-login (inloggning med användarnamn, spärr, glömt lösenord) (`node notify.test.mjs`) | 47 |
| `test/shot.html` | demodata att titta på | — |

**Molntestet** kräver emulatorn: `cd db/test && npm install && node emulator.mjs`. Den kör
riktig Postgres (PGlite) med filerna i `db/` och svarar på samma anrop som Supabase.
Starta om den före varje körning — testet räknar med en tom databas med bara AZ i.

`shot.html`-parametrar:

```
as=AZ                 manager (hela appen)
as=RKAY               producent (hela appen)
as=Sofia%20Marks      cirkelledare utan producentroll (Pass / Medlemmar)
as=William%20Ek       deltagare (läroplan + föreslå tid)
as=Studio%20Nord%20AB kund (lediga tider, förfrågningar)
as=Costa             admin
as=Moez              kamerateam (schema, agenda, galleri)
gate=1                inloggningssidan i förhandsläget (välj konto)
gate=1&mode=public    bokningssidan för nya kunder (#boka)
leads=1               en ny kund som väntar på svar (IDAG för admins)
cloud=1               inloggningssidan med servern inkopplad (e-post + lösenord, mot emulatorn)
join=K7Q2-M9XA4B      öppna en inbjudningslänk (jrole=producer för producentlänk)
tab=today|week|agenda|beats|more|artists|gallery|goals|team|circles|dash
dbx=1                 Dropbox kopplat och uppsatt (mock-läget svarar i stället för Dropbox, med platshållarbilder i galleriet)
circle=c1             öppna en cirkel
sheet=openInvites()   kör valfritt uttryck efter laddning
w=1440&h=1000         storlek — 390 är mobil, 1024 och uppåt ger datorlayouten
```

Testerna seedar localStorage och kör appen i en iframe, sedan läses resultatet ut.
Kör dem efter varje ändring.

**Fällor i riggen, värda att minnas:**
- `S.bookings.find(...)` ger en LEVANDE referens. Läs av värdet direkt i stället för
  att spara objektet och läsa det vid retur — annars hinner nästa anrop mutera det.
- Riv ner iframen helt (`about:blank` + paus) mellan scenarier, annars skriver en
  efterslängd `save()` över nästa scenarios seed.
- `document.body.innerHTML` innehåller appens egen `<script>`-källa. Leta efter läckor
  (som ordet *undefined*) bara i det som ritas.
- Tecken som `+` i `sheet=`-parametern blir mellanslag i en URL — skriv `%2B`.
- Emulatorn: `GET /__outbox` visar utkorgen (mejlen), och `GET /__mail` inloggningsmejlen med
  koden — så molntestet kan läsa länkar och koder som skickas. `POST /__config {confirm:true}`
  slår på kodsteget (som i drift).
