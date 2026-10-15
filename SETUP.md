# BANDOHQ — sätta upp

Fyra saker görs en gång: lägga appen på en webbadress, skapa en Supabase-databas,
skapa en Dropbox-app och koppla in mejlen via Resend. Räkna med en timme. Sedan lägger du
till folk med namn och e-post — de får en inbjudan på mejlen, väljer själva användarnamn och
lösenord och skriver in en kod från mejlet.

| Var | Vad | Varför |
|---|---|---|
| **Supabase** | konton, inloggning, inbjudningar, schemat, cirklar, agenda, artister | alla roller måste kunna logga in på sin egen telefon och se sitt |
| **Dropbox** | beats, bilder och film | stora filer, och Dropbox-appen på datorn synkar mappen av sig själv |
| **Resend + push** | notiser | bokningsbekräftelser, förfrågningar, svar och inbjudningar som mejl; påminnelser, agenda och timmar som push (gratis), annars mejl |

> **Förhandsvisning tills steg 2 är klart.** Så länge Supabase-uppgifterna är tomma i
> `index.html` visar inloggningssidan en kontoväljare märkt *Förhandsvisning*, och allt
> sparas bara i den webbläsaren. Så fort uppgifterna är ifyllda försvinner väljaren och det
> blir användarnamn (eller e-post) och lösenord. Det finns ingen separat flagga att komma ihåg.

---

## Steg 1 · Lägg appen på nätet (GitHub + Netlify, gratis)

1. Logga in på [github.com](https://github.com) → **+** → **New repository** → namn `bandohq`,
   **Public** → **Create repository**.
2. **uploading an existing file** → dra in de här fem filerna från projektmappen → **Commit changes**:
   `index.html`, `sw.js`, `manifest.webmanifest`, `apple-touch-icon.png`, `icon-512.png`.
   (De fyra extra behövs för push-notiserna och hemskärmsikonen.)
3. [app.netlify.com](https://app.netlify.com) → **Sign up with GitHub** → **Add new site → Import an
   existing project → GitHub** → välj repot. *Build command* tomt, *Publish directory* `.` → **Deploy**.
   Allt som laddas upp till GitHub publiceras sedan automatiskt.
4. **Site configuration → Access & security → Visitor access**: stäng av skyddet — annars möts alla
   besökare av Netlifys inloggning.
5. Appen ligger nu på `https://bandohq.netlify.app`.

> Vi körde först GitHub Pages, men dess https-certifikat för den egna domänen fastnade i över ett
> dygn (ett känt fel där bara GitHub Support kan starta om jobbet). Netlify ordnar certifikatet själv
> på några minuter.

### 1b · Egen adress: bandohq.se (Loopia)
Netlify → **Domain management → Add a domain** → `bandohq.se`. Netlify lägger till `www.bandohq.se`
också och skickar den vidare till `bandohq.se`.

Sedan DNS hos Loopia, för hand (LoopiaAPI kan inte ändra DNS-poster): Kundzon → **bandohq.se →
DNS-editor**.

| Subdomän | Typ | Data |
|---|---|---|
| `@` | A | `75.2.60.5` (bara den — ta bort andra A-poster) |
| `www` | CNAME | `bandohq.netlify.app.` |

Loopias formulär vill ha **TTL** (`3600`), och en andra post på en subdomän som redan finns läggs
till *under* den — inte via *Lägg till subdomän*. Loopias ns1 kan visa gamla svar upp till en timme
efter en ändring; kontrollera med `dig +tcp @ns1.loopia.se bandohq.se`.

När DNS:en slagit igenom: Netlify → **Domain management → HTTPS → Verify DNS configuration** (och
**Provision certificate** om knappen visas). Adressen blir **https://bandohq.se**.

**På telefonen:** öppna adressen i Safari → dela-knappen → **Lägg till på hemskärmen**. Då får
BANDOHQ husikonen och öppnas i helskärm som en vanlig app. **På iPhone fungerar gratis-notiserna
(push) bara när appen öppnas från hemskärmen** — appen påminner själv om det.

Appen måste ligga på `https://` — dubbelklickar du på filen fungerar varken inloggningen
eller Dropbox.

---

## Steg 2 · Supabase (konton och data)

### 2a · Skapa projektet
[supabase.com](https://supabase.com) → **New project**.
- Namn: `bandohq`
- Databaslösenord: ett långt, sparat i din lösenordshanterare
- **Region: Stockholm (eu-north-1)**, eller en annan i EU — det är personuppgifter
- Gratisplanen räcker gott

### 2b · Kör databasfilerna
**SQL Editor → New query.** Öppna filerna i mappen `db/` i tur och ordning, klistra in
hela innehållet och tryck **Run**:

1. `db/01-schema.sql` — tabellerna
2. `db/02-rls.sql` — vem som får läsa och skriva vad
3. `db/03-funktioner.sql` — inbjudningar, förfrågningar, nya kunder, godkännanden, timmar
4. `db/04-notiser.sql` — vilka notiser och mejl som ska skickas och när (själva utskicket är steg 5)

Alla fyra ska svara *Success*. Filerna går att köra om utan att något försvinner — **har du
redan kört en äldre version räcker det att köra alla fyra igen**, i samma ordning.

### 2c · Inloggningen
**Authentication → URL Configuration:**
- **Site URL:** `https://bandohq.se/`
- **Redirect URLs** → *Add URL*, lägg in båda:
  ```
  https://bandohq.se/
  https://bandohq.se/index.html
  ```

**Authentication → Sign In / Providers → Email** ska vara på (det är det från början).
*Confirm email* ska vara på: den som går med får en **sexsiffrig kod** på mejlen och skriver in
den i appen — sedan är hen inne med rätt roll. Mallen **Authentication → Emails → Confirm signup**
måste innehålla `{{ .Token }}` (koden) i stället för länken; lanseringsverktyget lägger in en svensk
mall. Kommer man in på en annan telefon innan koden är inskriven skickar appen en ny kod.

**Mejlen måste gå via en egen avsändare.** Supabases inbyggda mejl skickar bara till projektets
egna medlemmar (max 2 i timmen) och är inte gjort för drift. Använd **Resend** (gratis upp till
3 000 mejl/månad): lägg till domänen `bandohq.se` hos Resend (region EU), lägg in Resends DNS-poster
hos Loopia, och sätt sedan **Authentication → Emails → SMTP Settings**: host `smtp.resend.com`,
port `465`, användare `resend`, lösenord = Resend-API-nyckeln, avsändare `noreply@bandohq.se`,
namn `BANDOHQ`. Lanseringsverktyget gör allt det här, inklusive svenska mejltexter.

### 2d · Den första managern (du)
Inbjudningar skapas av en manager, så det första kontot läggs in för hand.

1. **Authentication → Users → Add user → Create new user.** Din e-post och ett lösenord,
   kryssa i **Auto Confirm User**.
2. **SQL Editor** — byt e-posten och kör:

   ```sql
   insert into members (id, user_id, role, name, email, username)
   select 'az', id, 'manager', 'AZ', email, 'az' from auth.users where email = 'din@epost.se';
   ```

### 2e · Koppla appen till databasen
**Project Settings → API.** Kopiera **Project URL** och nyckeln **anon public**.

Öppna `index.html`, sök efter `CLOUD_CONFIG` och fyll i:

```js
const CLOUD_CONFIG = { url: 'https://abcdefgh.supabase.co', key: 'eyJhbGciOi…' };
```

> **Bara `anon public`.** Nyckeln som heter `service_role` får aldrig in i appen — den
> går förbi alla behörigheter. `anon public` är gjord för att ligga i webbläsaren; det
> är databasens regler som skyddar datan, inte nyckeln.

Ladda upp den nya `index.html` till GitHub (den ersätter den gamla). Öppna adressen och
logga in med kontot från 2d.

**Har du lagt in något i förhandsvisningen?** Gör så här *innan* du laddar upp den nya
filen: öppna appen i förhandsläget, välj AZ → avataren → **Kopiera allt för flytt till
servern**, och spara texten någonstans. Efter inloggningen på riktigt: avataren →
**Flytta in från förhandsvisningen** → klistra in. Pass, cirklar, artister och agenda följer
med. Kontona gör det inte — crewet går med via länkar (steg 4), och cirkeldeltagarna läggs
i cirkeln av sin egen länk.

---

## Steg 3 · Dropbox (beats och galleri)

### 3a · Skapa Dropbox-appen
[dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → **Create app**.
- **Scoped access**
- **Full Dropbox** — krävs för att mappen ska kunna delas mellan era konton
- Namn: något unikt, t.ex. `BANDOHQ-bando`

**Fliken Permissions** — kryssa i och tryck **Submit**:
```
files.metadata.read     files.content.read     files.content.write
sharing.read            sharing.write
```

**Fliken Settings:**
- **Redirect URIs** → lägg in samma två adresser som i 2c.
- **Allow public clients (Implicit Grant & PKCE):** *Allow*. Appen använder PKCE — det
  finns ingen hemlig nyckel i webbläsaren.
- **Development users → Enable additional users.** Annars är det bara du som kan koppla.
- Kopiera **App key**.

### 3b · Koppla och sätt upp mapparna
I appen: avataren → **Dropbox → Koppla Dropbox** → klistra in App key → **Spara och koppla**
→ godkänn hos Dropbox → tillbaka i appen: **Sätt upp mapparna**.

Det skapas i ditt Dropbox:

```
BANDOHQ/                ← delas med crewet och kamerateamet
├── Beats/
│   ├── RKAY/  ADREY/  V2K/  GIOVANNI/  PKL/  AZ/ …
└── Media/                ← galleriet
    ├── Moez/
    └── D2L/
```

Mappen delas med e-posten på varje konto i teamet (crew + kamerateam). Använder någon en annan adress i
Dropbox: dela mappen till den adressen direkt i Dropbox. **Kör setupen igen** när nya
producenter eller kamerafolk gått med, så får de sin mapp och delningen.

### 3c · Producenterna
Var och en: avataren → **Koppla mitt Dropbox** → godkänn. Den delade mappen dyker upp i deras
Dropbox av sig själv. Med **Dropbox-appen på datorn** blir `BANDOHQ/Beats/<namn>` en vanlig
mapp i Finder — allt som sparas där kommer in i beatkanalen inom ett par minuter, och kan
spelas direkt i appen.

> **Lagringsutrymme — kolla det här.** För vanliga Dropbox-konton räknas en delad mapp
> mot **allas** utrymme, inte bara ägarens. Har producenterna gratiskonton (2 GB) blir de
> fulla fort med WAV-filer. Är er betalda Dropbox ett **team-konto** (Business/Standard/
> Advanced) och producenterna är med i teamet, delar ni teamets utrymme och det här är
> inget problem. Annars behöver var och en eget utrymme.

---

## Steg 4 · Lägg till alla

**Crew → Lägg till person.** Namn, e-post och roll → **Lägg till och skicka inbjudan**.
Personen får ett mejl med en länk, väljer själv användarnamn och lösenord, skriver in koden från
mejlet och är inne med rätt roll.

**Crew → Inbjudningar** listar alla som finns i appen men inte har loggat in (crewet från början
ligger redan där). Tryck **Bjud in**, fyll i e-posten och välj vad personen ska bjudas in som —
inloggningen kopplas till det konto som redan finns, så namnet, passen och färgen följer med.
Har flera redan en e-post: **Skicka till alla med e-post**. **Igen** skickar en ny länk och
stänger den gamla.

**Flera roller:** *Cirkelledare* går att kombinera med *Producent*, *Admin* och *Manager* — tryck på
båda och välj vilka cirklar personen leder. Ledarskapet sätts direkt på cirklarna, och inbjudan
säger t.ex. "producent och cirkelledare för Grupp 1". Bara *Cirkelledare* går också, för den som
leder utan att vara i crewet.

| Vem | Roll |
|---|---|
| **Costa**, **Nabbe** | Admin — sköter konton, cirklar, schemat och artister. Leder cirklar. |
| **Moez** | Kamerateam (team: *Moez*) |
| **D2L** (två personer) | Kamerateam, team: **D2L** — ligger som *D2L 1* och *D2L 2*; döp om dem under Crew → Hantera konton |
| Producenter | Producent |
| Cirkelledare som inte är producent | Cirkelledare · välj cirkel |
| Kund som hyr studio | Kund · välj kundens producent |

**Hela cirkelgrupper** går smidigare med en länk: **Crew → Bjud in med länk** → Deltagare ·
*[cirkeln]* · *Hela gruppen* → klistra in i gruppchatten. Under länklistan ser du hur många
som gått med och kan stänga en länk.

**Producenterna lägger själva till sina kunder och cirkeldeltagare:** Crew → **+ Kund** eller
**+ Deltagare**. En kund som en producent lägger till blir producentens kund. Personen får en
inbjudan på mejlen. Kamerateamet kan inte lägga till någon, och producenterna kan bara bjuda in
kunder och deltagare. Allt annat sköter admin.

**Nya kunder** behöver ingen inbjudan. Lägg länken `https://bandohq.se/#boka`
i Instagram-bion. Där ser de vilka tider som är bokade och skickar en förfrågan med namn och
telefon eller e-post; studion väljer de inte. Förfrågan hamnar under **Väntar på svar** på IDAG.
Med e-post får kunden ett kvitto direkt, och vid ett ja en bokningsbekräftelse med en länk för att
skapa sitt konto. Har kunden bara lämnat telefonnummer får du efter godkännandet en färdig text
med länken, som du skickar som sms.

**Artister** (de som inte ska logga in) läggs in under **Mer → Artister** — eller importeras
från ett kalkylark (se nedan).

Byta roll i efterhand: **Crew → Hantera konton** → personen. Bara du (manager) kan göra någon
till manager eller ändra ditt konto.

---

## Steg 5 · Notiser: mejl och push

Notiserna går **inte** att stänga av. De skickas vid:

| Händelse | Vem får det | Hur |
|---|---|---|
| Ett pass bokas (orderbekräftelse) | alla i sessionen: den det är bokat för, medproducenter, cirkelns deltagare, kunden | mejl (+ push) |
| Ny bokningsförfrågan | cirkelledaren, eller kundens producent + admins; nya kunder → admins | mejl (+ push) |
| Kvitto på förfrågan | kunden (med konto eller via `#boka`) | mejl |
| Svar på förfrågan | den som frågade — ja är en orderbekräftelse, nej ett eget mejl | mejl (+ push) |
| Avbokning (kund eller deltagare avbokar själv) | de andra i passet, kundens producent (annars admins), cirkelledaren | push, annars mejl |
| Inbjudan | den som bjuds in | mejl |
| Påminnelse dagen innan (kl 17) | den som bokat, de som är med, cirkelns ledare och deltagare, kunden | push, annars mejl |
| Agendan ändrad | den det gäller (samlas: högst en per halvtimme) — gemensamma uppgifter till hela teamet | push, annars mejl |
| Timmar som tar slut (400, 440, 470, 480 h) | deltagaren, och ledaren vid 480 | push, annars mejl |

Bokas flera pass på en gång (t.ex. *upprepa varje vecka*) blir det **ett** mejl per person med
alla passen. Pass bakåt i tiden ger ingen bekräftelse. Påminnelser, agenda och timmar skickas
inte mellan 21 och 08; bekräftelser och svar går direkt. Admins ser under **Crew → Notiser**
vad som gått iväg och vem som får påminnelserna som mejl (= har inte slagit på push).

**Resends gratisplan** räcker långt: 100 mejl om dagen och 3 000 i månaden, inloggningskoderna
inräknade. Kommer ni i närheten syns det i Resend → *Usage*.

### 5a · Push-nycklar (i appen)
Logga in som manager → **Crew → Notiser → Skapa push-nycklar**. Två nycklar visas:
`VAPID_PUBLIC_KEY` och `VAPID_PRIVATE_KEY`. Kopiera båda till steg 5c — den privata visas bara
den här gången. (Skapar du nya nycklar senare måste alla slå på notiserna igen.)

### 5b · Resend (mejlen)
Domänen `bandohq.se` är redan uppsatt hos Resend (steg 2c). Skapa en nyckel som **bara får skicka**:
Resend → **API Keys → Create API Key**, *Sending access*, domän `bandohq.se`. Den används av
edge-funktionen nedan — samma nyckel som SMTP-lösenordet i 2c går bra.

### 5c · Edge-funktionerna
I Supabase: **Edge Functions → Deploy a new function → Via Editor**, två gånger:
- `notify-send` — klistra in `supabase/functions/notify-send/index.ts` (skickar notiserna)
- `auth-login` — klistra in `supabase/functions/auth-login/index.ts` (inloggning med användarnamn)

Stäng av **Enforce JWT verification** för båda: `notify-send` skyddas av `CRON_SECRET`, och
`auth-login` måste nås innan man är inloggad (den lämnar aldrig ut någon mejladress och spärrar
ett användarnamn efter tio fel på en kvart).

**Secrets** (Edge Functions → Secrets):

| Namn | Värde |
|---|---|
| `RESEND_KEY` | nyckeln från 5b |
| `MAIL_FROM` | `BANDOHQ <noreply@bandohq.se>` |
| `MAIL_REPLY_TO` | dit svar på mejlen ska gå, t.ex. din egen adress |
| `APP_URL` | `https://bandohq.se/` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | från 5a |
| `VAPID_SUBJECT` | `mailto:` + din e-post |
| `CRON_SECRET` | en lång slumpsträng — samma som i 5d |

### 5d · Slå på utskicket
1. **Database → Extensions**: slå på **pg_cron** och **pg_net**.
2. Öppna `db/05-utskick.sql`, byt de två värdena högst upp (projektets URL och samma
   `CRON_SECRET` som funktionen har) och kör den i SQL Editor.

Nu skickas utkorgen varje minut och påminnelserna varje kväll. Testa: profilen → **Slå på
notiser** → **Skicka en testnotis**. Hela kedjan går att följa i **Table Editor → outbox**
(`channel` = push, mail eller push+mail, `sent_at` = skickat, `error` = vad som gick fel) och i
Resend → *Emails*.

---

## Steg 6 · iPhone-appen i App Store

Appen i App Store är ett tunt skal (`app/`, Capacitor) runt https://bandohq.se. Det skalet
tillför tre saker som webben inte har:

- push via Apple, även när appen är stängd
- länkar till bandohq.se (inbjudningar, `#boka`, nytt lösenord) som öppnar appen
- delningsmenyn för nedladdningar

En vanlig ändring i `index.html` når appen direkt när den är publicerad på Netlify. Ett nytt bygge
behövs bara när skalet ändras.

**Konton (en gång):**

1. **D-U-N-S-nummer** för Bando: developer.apple.com/enroll/duns-lookup.
2. **Apple Developer Program** som organisation, 99 USD per år.
3. I **developer.apple.com → Identifiers**: skapa `se.bandohq.app` med **Push Notifications**
   och **Associated Domains** påslagna.
4. **Keys** → ny nyckel med *Apple Push Notifications service*. Ladda ner .p8-filen. Sedan:

   ```
   python3 tools/launch.py apns <KEY_ID> <TEAM_ID> ~/Downloads/AuthKey_<KEY_ID>.p8
   python3 tools/launch.py aasa <TEAM_ID>
   ```

   Pusha. Netlify publicerar då `/.well-known/apple-app-site-association`.
   Apple hämtar den från **www.bandohq.se** (huvudadressen). bandohq.se skickas vidare dit, och
   Apple följer inte omdirigeringar.
5. **App Store Connect → Användare och åtkomst → Integrationer**: skapa en API-nyckel med rollen
   *App Manager*.
6. **App Store Connect → Appar → +**: skapa BANDOHQ med bundle-id `se.bandohq.app`.

**Codemagic (bygger i molnet, gratis upp till 500 minuter per månad):**

1. Logga in med GitHub och lägg till repot `PRODBYRK/bandohq`.
2. **Teams → Integrations → Developer Portal:** lägg in API-nyckeln och döp den till exakt
   **BANDOHQ** (`codemagic.yaml` använder det namnet).
3. **Teams → Code signing identities:** *Generate certificate* (Apple Distribution), och under
   *iOS provisioning profiles* *Fetch profiles* för `se.bandohq.app` (App Store).
4. **Start new build → ios-testflight**, eller pusha till grenen `ios`. Efter cirka 15 minuter
   ligger bygget i **TestFlight**.

**Inskick:** fyll i App Store-sidan från `app/store/APP-STORE.md` (texter, nyckelord,
integritetsfrågorna och granskarens demokonto) och ladda upp bilderna i `app/store/skarmbilder/`.
Välj bygget och skicka in. Granskningen tar oftast 1–3 dagar.

**Demoläget:** användarnamnet `apple-review` med lösenordet `BandoDemo2026` öppnar appen med
påhittad data (`demo.js`). Inget når servern. Det är det Apples granskare loggar in i, och det
går också bra att visa appen för någon utan att visa riktiga kunder.

**Radera mitt konto** finns i profilen för alla (Apple kräver det). Raderingen städar som när
managern raderar någon. Den enda managern kan inte radera sig själv.

---

## Cirklarna (verksamhetssystemet)

**Cirklar** har flikarna **Översikt**, **Vecka**, **Grupper**, **Deltagare**, **Kalender** och **Kurser**.
Admin ser allt, och en producent eller cirkelledare ser bara sina egna grupper (utan Vecka och
Deltagare).

**Översikten** är kontrollpanelen:
- antal grupper, deltagare och ledare, och timmar i år
- **Att åtgärda**: alla fel och varningar de senaste åtta veckorna, fel först
- ledarna med sina grupper och sin timbank
- kommande pass de närmaste 14 dagarna
- närvaro och rapportstatus per vecka för sex veckor
- varje grupps nivå och lektion i kursen

Ledare utan producentroll ser *Att åtgärda* för sina egna pass överst i sin vy.

**Utbildningssystemet (Cirklar → Utbildning):**
- **En kurs per ämne**, med nivåer och färdiga lektioner. Varje lektion har innehåll, lärandemål och
  övning.
- **Startinnehållet** är ett **utkast** som behöver skrivas om: sex ämnen, tre nivåer och fem
  lektioner per nivå. Lägg in det med *Lägg in startinnehåll*.
- **Admin redigerar kurserna** (lägg till, ändra, flytta lektioner). Ledarna följer kurserna och
  skapar inga egna.
- **En ny grupp börjar på nivå 1, lektion 1**, och får kursen i sitt ämne automatiskt. Har gruppen
  redan kommit längre väljer admin var den börjar (*Ändra cirkeln → Gruppen börjar på*).
- **Ledaren väljer lektion** när ett pass markeras genomfört. Nästa lektion är förvald. Gruppens läge
  räknas fram ur passen, så nästa lektion blir tillgänglig av sig själv.
- **Ledaren ser nästa lektion** med innehåll, mål och övning.
- **Lektionen följer med i rapporten.**

**Veckans administration (Cirklar → Vecka)** — gör det tillsammans en gång i veckan. Vyn öppnas på förra
veckan.

1. Alla cirkelpass i veckan visas med status: **Planerat → Genomfört → Kontrollerat → Rapporterat**.
2. Kontrollen flaggar **fel**, som måste rättas innan passet kan godkännas, och **varningar**. Knappen
   bredvid öppnar rätt ställe, t.ex. *Registrera närvaro*.

   | Fel | Varningar |
   |---|---|
   | passet har varit men närvaron saknas | för få deltagare i gruppen |
   | fel antal timmar | någon har inte varit med på något av startpassen |
   | ingen närvarande | färre närvarande än målet efter startperioden |
   | närvarande som inte är med i gruppen | pass utan ledare |
   | krock | |
   | ledaren över timbanken | |
   | deltagaren över 480 timmar | |
   | genomfört i framtiden | |

3. **Godkänn alla utan fel**. Godkända pass blir *Kontrollerade* och **låsta**: ingen kan ändra
   dem, inte ens via synken.
4. **Sammanställ rapport** markerar dem *Rapporterade* och laddar ner underlaget som CSV för Excel: en
   rad per närvarande deltagare, med datum, tid, timmar, grupp, ämne, lektion, ledare, namn, telefon och
   e-post. Personnummer läggs till från kalkylarket.
5. Behöver ett låst pass ändras: **Lås upp** och skriv en anledning. Den sparas i passets **historik**,
   som visar varje ändring med vem och när.

Reglerna för kontrollen finns på ett ställe i appen (`SESSION_RULES` och `CIRCLE_RULES` i index.html),
så att en ny regel blir en ny rad. Servern kontrollerar de viktigaste igen när admin godkänner
(`check_sessions`).

- **Regler** (Cirklar → Grupper → *Regler för cirklarna*), med standardvärdena inom parentes:
  - deltagare per grupp (4)
  - startpass där alla ska ha varit med (3)
  - närvarande per pass därefter (3)
  - timmar per pass (3)
  - max timmar per ledare och kalenderår (480)
  - från vilket år gränsen gäller (2027)
  - vid vilka timmar ledaren varnas (400, 440, 470)

  Ändringar gäller direkt, även på servern.
- **Varje cirkelpass är exakt så långt som reglerna säger.** Det går inte att boka om:
  - ledaren redan har ett pass då, i en cirkel eller ett eget studiopass
  - någon av deltagarna är med i en annan grupp samtidigt
  - ledarens timbank skulle gå över gränsen
- **Upprepa varje vecka:** varje datum kontrolleras först och visas med ✓ eller ✗ och anledningen.
  Sedan bokas bara de som går.
- **Timbanken** står under Grupper för admin och överst i ledarens vy. Den visar genomförda och bokade
  timmar per år. Ledaren och admins får en notis vid varningsgränserna och när banken är full.
- **Grupper** visar hur många deltagare varje grupp har mot gruppstorleken. **Fördela** föreslår var nya
  anmälningar och deltagare utan grupp ska hamna: samma ämne först, sedan flest lediga platser.
- **Deltagare:** nya anmälningar och alla i programmet. Lägger man till någon som redan finns (samma
  e-post, telefon eller namn) frågar appen först.
- **Anmälningar från foundation-sidan** (`/studiecirkel/…`): när kalkylarket är kopplat skickar
  formuläret namn, telefon och e-post, **aldrig personnumret**, till BANDOHQ:s kö. Det kräver tre
  variabler i Vercel:
  - `BANDOHQ_URL` och `BANDOHQ_KEY`, samma som i appen
  - `BANDOHQ_SECRET`, samma värde som raden `signup` i tabellen `bs_secrets`. Den sätts med:

    ```
    insert into bs_secrets(name, value) values ('signup', '<lång slumpsträng>')
      on conflict (name) do update set value = excluded.value;
    ```

## Rollerna

| Roll | Ser och gör |
|---|---|
| **Manager** (du) | Allt — även statistiken och allas mål och planer |
| **Admin** (Costa, Nabbe) | Konton, inbjudningar, nya kunder, cirklar, schemat, artister, priser, Dropbox. Inte statistiken eller andras mål. |
| **Producent** | Hela schemat, agenda, beats, artister, galleriet, sina egna mål och siffror. Cirklar: **bara de hen leder** — andras grupper och deltagare syns inte |
| **Kamerateam** (Moez, D2L) | Schemat, sin agenda och galleriet — laddar upp bilder och film |
| **Cirkelledare** | Två saker: **boka pass** för sina cirklar (godkänna förfrågningar, markera genomförda) och **medlemmarna** med e-post (och telefon om den finns) |
| **Deltagare** | Bara bokning: föreslå pass i sin cirkel och avboka sina egna, senast en timme innan |
| **Kund** | Bara bokning: skicka förfrågningar och avboka sina bokningar, senast en timme innan |

Behörigheterna ligger **i databasen**, inte bara i appen. En deltagare kan inte läsa andras
pass ens med webbläsarens utvecklarverktyg, en ledare ser bara sina egna medlemmars
kontaktuppgifter, och mål och planer syns bara för ägaren och managern.

---

## Det nya i v10

**Alla pass är tre timmar.** Kunder, deltagare och `#boka` väljer bara en starttid, och passet
slutar alltid tre timmar senare. Starttiden kan vara vilken halvtimme som helst inom öppettiden.
Crewets snabbval är också tre timmar (10–13, 13–16, … och ett nattpass), men crewet kan ändra
sluttiden.

**Kunder och deltagare bokar och gör inget annat.** De ser en dagremsa där fullbokade dagar är
markerade, och en tidslinje per studio med det som är bokat. Där står bara *Bokat*, aldrig vem
eller vad. Kunder och `#boka` väljer aldrig studio; crewet väljer den när förfrågan godkänns.
Läroplanen och timmarna syns inte längre i deltagarvyn.

**Avboka senast en timme innan.** Därefter hänvisar appen till producenten (kund) eller till
cirkelledaren (deltagare), med telefon och mejl. Avbokningen meddelas crewet. Deltagare kan bara
avboka pass de själva föreslagit, inte gruppens pass.

**Producenterna lägger till kunder och deltagare**, se steg 4.

## Det nya i v9

**Mejl i stället för SMS.** Orderbekräftelse till alla i sessionen när ett pass bokas, mejl
när en kund förfrågar en tid (och ett kvitto till kunden), svar och inbjudningar på mejlen.
Påminnelser, agenda och timmar går som push och som mejl till den som saknar push. 46elks
behövs inte längre.

**Användarnamn.** Man loggar in med användarnamn eller e-post. Det väljs första gången, efter
inbjudningslänken, tillsammans med lösenordet — och kontot bekräftas med en kod från mejlet.

**Inbjudan till dem som redan finns.** Crew → Inbjudningar: fyll i e-post, välj roll, skicka.
Inloggningen kopplas till kontot som redan finns.

## Det nya i v8

**Admins och kamerateam** — se Rollerna ovan. Admin kan inte göra sig själv eller någon annan
till manager; det stoppas i databasen, inte bara i appen.

**Lägg till person** — i v9 med e-post, och inbjudan går som mejl.

**Kunder** ser lediga studiotider och skickar förfrågningar i stället för att boka direkt.
**Nya kunder** bokar via `#boka`-länken utan konto och får inlogg när de godkänts.

**Notiser** som inte går att stänga av (steg 5) — i v9 som mejl och push.

**Galleri** för bilder och film från kamerateamet. Filerna ligger i `BANDOHQ/Media/<team>`
i Dropbox. Alla får posta därifrån: *Dela / spara* skickar filen till telefonens delningsmeny
(Instagram), *Kopiera bildtext* ger texten med kredit, och appen listar vilka konton som ska
bjudas in som **samarbetspartner** i Instagram (lägg in Instagram-namn på kamerateamet under
Crew och på artisterna). *Markera som postad* så alla ser vad som redan använts.

**Beatkanalen med profiler** — en profil per producent med deras beats i.

**Artister i prio 1, 2 och 3** (1 = det vi satsar på nu, 3 = inte prio), ordningen inom
graden dras om med pilar. **Importera kalkylark**: klistra in rader från Excel/Google Sheets
eller välj en `.csv`/`.xlsx` med kolumnerna *Namn, Prio* (och gärna *Genre, Anteckning,
Instagram*). Prio kan stå som 1/2/3 eller Hög/Mellan/Låg. *Exportera* ger en CSV tillbaka.

**Veckoplanen** — under AGENDA: *Skriv in veckan* som text (t.ex. `Mån 18-22 RKAY + ADREY med
Nova`), eller *Kopiera förra veckan* och justera. Var och en bockar i **Kört** när passet är
gjort. Producenterna skriver in sin egen plan; admin allas.

**Statistiken** visar *Flest pass ihop* — paren med flest sessions tillsammans, med förändring
mot förra perioden — och artisterna grupperade på prio med sessions och släppta låtar.

**Säkerhet:** interna databasfunktioner (t.ex. den som skriver pass förbi kontrollerna) är nu
stängda för direkta anrop. Supabase öppnar annars alla funktioner för alla inloggade.

## Det nya i v7

**Cirkelledarens vy** — två flikar. *Pass*: Boka pass överst, sedan *Väntar på dig* med
Godkänn/Avböj, *Att markera* med Genomförd, kommande och genomförda. *Medlemmar*: ring,
sms:a eller mejla direkt, *Mejla alla*, och timmar mot ramen på 480 h.

**Artister rankas** #1, #2, #3 … Managern flyttar med pilarna, eller drar raderna på datorn.
Ordningen syns för alla och styr artistlistan i bokningsformuläret. Den gamla Hög/Mellan/Låg
blev startordningen.

**Agendan** — IDAG har *Veckans agenda* för hela crewet i ett kort: en rad per producent med
förloppet och de öppna uppgifterna, bocka av direkt. SCHEMA har *Min agenda* — på datorn en
kolumn till vänster om kalendern, på mobilen ett kort överst som går att fälla ihop.

**Dropbox i stället för Google Drive**, och beats spelas direkt i appen.

**Datorlayout** från 1024 px: navigeringen i en sidopanel, IDAG och SCHEMA i två kolumner,
statistiken i ett rutnät, dialoger som en panel från höger. Mobilen har kvar flikarna i botten.

**Lugnare design** — samma neon, men glöden bara på det som är aktivt, en korttyp, ett
avståndssystem och färre versaler.

---

## I drift

**Systemstatus** (Crew, för admins): servern, push-nycklarna, senaste notisutskicket, Dropbox och
senaste säkerhetskopian på ett ställe. Gult = behöver göras, rött = något är fel.

**Säkerhetskopia** — gratisplanen hos Supabase har ingen egen backup. Under Crew finns **Ladda ner
säkerhetskopia**: en fil med alla poster och konton (inga lösenord). Appen påminner på IDAG när det
gått mer än 7 dagar. Spara filen säkert — den innehåller kontaktuppgifter. **Läs tillbaka en kopia**
lägger bara tillbaka det som saknas; inget som finns skrivs över.

**Radera en person** (managern, under Hantera konton): kontot och inloggningen försvinner, namnet
tas bort ur gamla pass, agenda och mål raderas. Passen och cirkeltimmarna ligger kvar för
rapporteringen. Går inte att ångra. *Stäng av kontot* finns kvar för den som bara ska pausas.

**Öppettider** för kunder och bokningssidan: Crew → Studios och öppettider.

**Integritetstexten** (`…/#integritet`, länkad från inloggningen, kontoformuläret och
bokningssidan) beskriver vad som sparas och hur man får det raderat. Fyll i en e-postadress för
frågor överst i `index.html`: `const ORG = { name: 'Bando Collective', email: '' };` — annars
hänvisar texten till en admin i appen. Alla som skapar konto eller skickar en förfrågan kryssar i
att de läst den.

## Om något strular

**"Invalid API key"** — fel nyckel i `CLOUD_CONFIG`. Det ska vara *anon public* från
Project Settings → API, och URL:en ska sluta på `.supabase.co`.

**"Inloggningen fungerade, men inget konto är kopplat"** — kontot finns i Supabase men har
ingen rad i `members`. För dig: kör SQL:en i 2d. För andra: de ska gå med via en länk.

**Mejllänken (bekräfta / nytt lösenord) öppnar fel sida** — *Site URL* och *Redirect URLs*
i 2c stämmer inte med adressen.

**Dropbox säger "redirect_uri mismatch"** — adressen under *Redirect URIs* i 3a måste vara
exakt den appen öppnas på. Lägg in både med och utan `index.html`.

**Dropbox vägrar koppla för en producent** — *Enable additional users* i 3a är inte gjort.

**En producent ser inte mappen** — hen har inte fått delningen (fel e-post, eller setupen
kördes innan hen gick med). Kör **Sätt upp mapparna** igen, eller dela mappen i Dropbox.
Tryck sedan *Koppla mitt Dropbox* en gång till.

**Beats syns i Dropbox men inte i appen** — de ska ligga i en producents egen mapp,
`BANDOHQ/Beats/<namn>/` (undermappar går bra). Filer direkt i `Beats/`, eller i en mapp
med ett namn som inte är någons i crewet, hoppas över. Kanalen läser av mapparna varannan
minut medan appen är öppen.

---

**Ingen push kommer** — på iPhone: öppnas appen från hemskärmen? (I Safari går det inte.) Står
`channel` = mail i `outbox` för en påminnelse hade personen ingen fungerande push — be hen trycka
**Slå på notiser** i profilen igen. Står det fel om nycklar: `VAPID_PUBLIC_KEY` i Supabase måste
vara exakt samma som den appen visar under Crew.

**Inga mejl kommer** — titta i *Table Editor → outbox*. Står det något i `error`: `401`/`403` =
fel `RESEND_KEY`, *domain is not verified* = DNS-posterna hos Loopia (steg 2c). Är raden
skickad (`sent_at`) men mejlet syns inte: Resend → *Emails* visar om det levererades eller
studsade — och kolla skräpposten. Är tabellen tom: har personen en e-post (Crew → personen)?
Ligger raderna kvar utan `sent_at` och utan fel: kör
`select * from cron.job_run_details order by start_time desc limit 5;` — då syns om cron och
edge-funktionen anropas (fel URL eller hemlighet i 05-filen).

**Koden kommer inte** — den skickas av Supabase via Resend (steg 2c, SMTP). *Skicka en ny* i
appen ger en ny kod efter en minut. Har personen redan ett konto med den adressen skickas ingen
kod — logga in i stället.

**Påminnelsen kom på morgonen i stället för direkt** — den köades efter kl 21. Så ska det vara.

## Testa själv

```
python3 -m http.server 8000
```

**Enklast:** `python3 test/run.py` kör allt (databasen, edge-funktionerna, förhandsläget och
molnet mot en egen emulator) i en headless Chrome och säger om något är rött. `python3 test/run.py test`
kör bara förhandsläget, och `cloud` eller `db` en del i taget.

För hand:

- `http://localhost:8000/test/test.html` — appen i förhandsläget, 416 testfall
- `http://localhost:8000/test/shot.html?as=AZ` — demodata att klicka runt i

Databasen och molnflödet (kräver Node):

```
cd db/test
npm install                       # en gång
node db.test.mjs                  # behörigheter, notiskön, inbjudningar, push, nya kunder och radering i riktig Postgres, 320 testfall
node notify.test.mjs              # push-krypteringen (RFC 8291), mejlutskicket och inloggning med användarnamn, 55 testfall
node emulator.mjs                 # lokal Supabase på :8738 — låt den stå igång
```

… och sedan `http://localhost:8000/test/cloud.html` — appen mot emulatorn: inloggning,
inbjudningar, förfrågningar, godkännanden, kund, ny kund via bokningssidan, admin,
utkorgen med mejlen, push, säkerhetskopia, radering, glömt lösenord, koden vid första inloggningen,
användarnamn, inbjudan till någon som redan finns, producenter som lägger till kunder och flytten
från förhandsvisningen, 150 testfall.
Starta om emulatorn före varje körning.
Se `test/README.md`.
