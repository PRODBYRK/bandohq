# BANDOHQ — sätta upp

Fyra saker görs en gång: lägga appen på en webbadress, skapa en Supabase-databas,
skapa en Dropbox-app och koppla in SMS via 46elks. Räkna med en timme. Sedan lägger du
till folk med namn och mobilnummer — de får en länk som SMS och väljer själva e-post och
lösenord.

| Var | Vad | Varför |
|---|---|---|
| **Supabase** | konton, inloggning, inbjudningar, schemat, cirklar, agenda, artister | alla roller måste kunna logga in på sin egen telefon och se sitt |
| **Dropbox** | beats, bilder och film | stora filer, och Dropbox-appen på datorn synkar mappen av sig själv |
| **Push + 46elks** | notiser | påminnelser, förfrågningar, svar, agendaändringar och timmar — gratis som push, SMS som reserv |

> **Förhandsvisning tills steg 2 är klart.** Så länge Supabase-uppgifterna är tomma i
> `index.html` visar inloggningssidan en kontoväljare märkt *Förhandsvisning*, och allt
> sparas bara i den webbläsaren. Så fort uppgifterna är ifyllda försvinner väljaren och det
> blir e-post och lösenord. Det finns ingen separat flagga att komma ihåg.

---

## Steg 1 · Lägg appen på GitHub Pages (gratis)

1. Logga in på [github.com](https://github.com) → **+** → **New repository** → namn `bandohq`,
   **Public** → **Create repository**.
2. **uploading an existing file** → dra in de här fem filerna från projektmappen → **Commit changes**:
   `index.html`, `sw.js`, `manifest.webmanifest`, `apple-touch-icon.png`, `icon-512.png`.
   (De fyra extra behövs för push-notiserna och hemskärmsikonen.)
3. **Settings → Pages** → *Deploy from a branch* → **main** / **(root)** → **Save**.
4. Efter 1–2 minuter står adressen högst upp. Skriv upp den:

   ```
   https://DITT-ANVÄNDARNAMN.github.io/bandohq/
   ```

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
4. `db/04-sms.sql` — vilka SMS som ska skickas och när (själva utskicket är steg 5)

Alla fyra ska svara *Success*. Filerna går att köra om utan att något försvinner — **har du
redan kört en äldre version räcker det att köra alla fyra igen**, i samma ordning.

### 2c · Inloggningen
**Authentication → URL Configuration:**
- **Site URL:** `https://DITT-ANVÄNDARNAMN.github.io/bandohq/`
- **Redirect URLs** → *Add URL*, lägg in båda:
  ```
  https://DITT-ANVÄNDARNAMN.github.io/bandohq/
  https://DITT-ANVÄNDARNAMN.github.io/bandohq/index.html
  ```

**Authentication → Sign In / Providers → Email** ska vara på (det är det från början).
*Confirm email* kan vara på — appen klarar det: den som går med får ett mejl, trycker på
länken och är inne med rätt roll, även om mejlet öppnas på en annan telefon.

### 2d · Den första managern (du)
Inbjudningar skapas av en manager, så det första kontot läggs in för hand.

1. **Authentication → Users → Add user → Create new user.** Din e-post och ett lösenord,
   kryssa i **Auto Confirm User**.
2. **SQL Editor** — byt e-posten och kör:

   ```sql
   insert into members (id, user_id, role, name, email)
   select 'az', id, 'manager', 'AZ', email from auth.users where email = 'din@epost.se';
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

**Crew → Lägg till person.** Namn, mobilnummer och roll → **Lägg till och skicka SMS**.
Personen får en länk som SMS, väljer själv e-post och lösenord, och är inne med rätt roll.
Ingen behöver skriva in någon annans e-post.

| Vem | Roll |
|---|---|
| **Costa**, **Nabbe** | Admin — sköter konton, cirklar, schemat och artister. Leder cirklar. |
| **Moez** | Kamerateam (team: *Moez*) |
| **D2L** (två personer) | Kamerateam, team: **D2L** — lägg till båda; de krediteras som D2L i galleriet |
| Producenter | Producent |
| Cirkelledare som inte är producent | Cirkelledare · välj cirkel |
| Kund som hyr studio | Kund · välj kundens producent |

**Hela cirkelgrupper** går smidigare med en länk: **Crew → Bjud in med länk** → Deltagare ·
*[cirkeln]* · *Hela gruppen* → klistra in i gruppchatten. Under länklistan ser du hur många
som gått med och kan stänga en länk.

**Nya kunder** behöver ingen inbjudan. Lägg länken `https://DITT-ANVÄNDARNAMN.github.io/bandohq/#boka`
i Instagram-bion: där ser de lediga tider och skickar en förfrågan. Den hamnar under
**Väntar på svar** på IDAG. Godkänn → tiden bokas och kunden får ett SMS med en länk för att
skapa sitt konto.

**Artister** (de som inte ska logga in) läggs in under **Mer → Artister** — eller importeras
från ett kalkylark (se nedan).

Byta roll i efterhand: **Crew → Hantera konton** → personen. Bara du (manager) kan göra någon
till manager eller ändra ditt konto.

---

## Steg 5 · Notiser: push (gratis) och SMS (reserv)

Notiserna går **inte** att stänga av. De skickas vid:

| Händelse | Vem får det |
|---|---|
| Påminnelse dagen innan (skickas kl 17) | den som bokat, de som är med, cirkelns ledare och deltagare, kunden |
| Ny bokningsförfrågan | cirkelledaren, eller kundens producent + admins; nya kunder → admins |
| Svar på förfrågan | den som frågade |
| Agendan ändrad | den det gäller (samlas: högst en per halvtimme) — gemensamma uppgifter till hela teamet |
| Timmar som tar slut (400, 440, 470, 480 h) | deltagaren, och ledaren vid 480 |

**Så väljs vägen:** har personen slagit på notiser i appen går det som **push** — gratis, som en
vanlig app-notis. Har hen inte det (eller stängt av dem i telefonen) går det som **SMS** via 46elks,
ungefär 0,35–0,50 kr styck. Nya kunder utan konto får alltid SMS. Appen påminner var och en
tills push är påslaget, och admins ser under **Crew → SMS-notiser** vilka som fortfarande får SMS.
Inget skickas mellan 21 och 08.

Vill ni vara extra säkra kan en admin kryssa i **Påminnelser och timmar även som SMS** — då går de
två viktigaste som både push och SMS.

### 5a · Push-nycklar (i appen)
Logga in som manager → **Crew → SMS-notiser → Skapa push-nycklar**. Två nycklar visas:
`VAPID_PUBLIC_KEY` och `VAPID_PRIVATE_KEY`. Kopiera båda till steg 5c — den privata visas bara
den här gången. (Skapar du nya nycklar senare måste alla slå på notiserna igen.)

### 5b · 46elks (för SMS-reserven)
1. Skapa konto på [46elks.se](https://46elks.se) och fyll på saldo.
2. **Account → API credentials**: kopiera *API username* och *API password*.

Hoppar du över 46elks går bara push — den som saknar push får då inga notiser alls, och felet
syns i `sms_outbox`.

### 5c · Edge-funktionen
I Supabase: **Edge Functions → Deploy a new function → Via Editor**.
- Namn: `notify-send`
- Klistra in hela `supabase/functions/notify-send/index.ts` → **Deploy**
- **Secrets** (Edge Functions → Secrets):

  | Namn | Värde |
  |---|---|
  | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | från 5a |
  | `VAPID_SUBJECT` | `mailto:` + din e-post, t.ex. `mailto:rasmus@bandocollective.com` |
  | `ELKS_USER`, `ELKS_PASS` | från 5b |

  Vill du testa SMS gratis först: lägg även `ELKS_DRYRUN` = `yes` (46elks låtsas skicka). Ta bort
  den när det fungerar.

### 5d · Slå på utskicket
1. **Database → Extensions**: slå på **pg_cron** och **pg_net**.
2. Öppna `db/05-sms-utskick.sql`, byt de två värdena högst upp (samma URL och *anon public*-nyckel
   som i `CLOUD_CONFIG`) och kör den i SQL Editor.

Nu skickas utkorgen varje minut och påminnelserna varje kväll. Testa: profilen → **Slå på
notiser** → **Skicka en testnotis**. Hela kedjan går att följa i **Table Editor → sms_outbox**
(`channel` = push eller sms, `sent_at` = skickat, `error` = vad som gick fel).

---

## Rollerna

| Roll | Ser och gör |
|---|---|
| **Manager** (du) | Allt — även statistiken och allas mål och planer |
| **Admin** (Costa, Nabbe) | Konton, inbjudningar, nya kunder, cirklar, schemat, artister, priser, Dropbox. Inte statistiken eller andras mål. |
| **Producent** | Hela schemat, agenda, beats, artister, galleriet, sina egna mål och siffror, och de cirklar hen leder |
| **Kamerateam** (Moez, D2L) | Schemat, sin agenda och galleriet — laddar upp bilder och film |
| **Cirkelledare** | Två saker: **boka pass** för sina cirklar (godkänna förfrågningar, markera genomförda) och **medlemmarna** med telefon och e-post |
| **Deltagare** | Sin läroplan, sina timmar, och föreslå tider med sin ledare |
| **Kund** | Lediga studiotider, förfrågningar och sina egna bokningar |

Behörigheterna ligger **i databasen**, inte bara i appen. En deltagare kan inte läsa andras
pass ens med webbläsarens utvecklarverktyg, en ledare ser bara sina egna medlemmars
kontaktuppgifter, och mål och planer syns bara för ägaren och managern.

---

## Det nya i v8

**Admins och kamerateam** — se Rollerna ovan. Admin kan inte göra sig själv eller någon annan
till manager; det stoppas i databasen, inte bara i appen.

**Lägg till person** med namn och mobilnummer — länken går som SMS.

**Kunder** ser lediga studiotider och skickar förfrågningar i stället för att boka direkt.
**Nya kunder** bokar via `#boka`-länken utan konto och får inlogg när de godkänts.

**Notiser** som inte går att stänga av (steg 5) — gratis som push till dem som slagit på det, annars som SMS.

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
`channel` = sms i `sms_outbox` hade personen ingen fungerande push — be hen trycka **Slå på
notiser** i profilen igen. Står det fel om nycklar: `VAPID_PUBLIC_KEY` i Supabase måste vara
exakt samma som den appen visar under Crew.

**Inga SMS kommer** — titta i *Table Editor → sms_outbox*. Står det något i `error`: `401` = fel
46elks-nycklar, `402`/`saldo` = fyll på hos 46elks. Är tabellen tom: kontrollera att personen har
ett mobilnummer (Crew → personen). Ligger raderna kvar utan `sent_at` och utan fel: kör
`select * from cron.job_run_details order by start_time desc limit 5;` — då syns om cron och
edge-funktionen anropas (fel URL eller nyckel i 05-filen).

**SMS:et kommer på morgonen i stället för direkt** — det skickades efter kl 21. Så ska det vara.

## Testa själv

```
python3 -m http.server 8000
```

- `http://localhost:8000/test/test.html` — appen i förhandsläget, 290 testfall
- `http://localhost:8000/test/shot.html?as=AZ` — demodata att klicka runt i

Databasen och molnflödet (kräver Node):

```
cd db/test
npm install                       # en gång
node db.test.mjs                  # behörigheter, notiskön, push och nya kunder i riktig Postgres, 159 testfall
node notify.test.mjs              # push-krypteringen mot RFC 8291:s egna testvärden + hela utskicket, 22 testfall
node emulator.mjs                 # lokal Supabase på :8738 — låt den stå igång
```

… och sedan `http://localhost:8000/test/cloud.html` — appen mot emulatorn: inloggning,
inbjudningar, förfrågningar, godkännanden, kund, ny kund via bokningssidan, admin,
SMS-utkorgen, push, glömt lösenord, e-postbekräftelse och flytten från förhandsvisningen, 90 testfall. Starta om emulatorn före varje körning.
Se `test/README.md`.
