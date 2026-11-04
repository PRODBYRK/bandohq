# Design System: BANDOHQ

Gäller appen (`index.html`). Värdena står som tokens överst i stilmallen; lagret
"LUGNARE OCH MJUKARE (nov 2026)" längst ner i stilmallen är där reglerna nedan sätts.

## 1. Atmosfär

Natten i studion. En mörk, lugn arbetsyta som används hela dagen av crew, cirkelledare,
deltagare och artister. Bandos neonskylt får vara högljudd på ett enda ställe per vy:
dagens datum, vyns rubrik, eller studion som är tänd just nu. Allt annat är tyst.

- Täthet: vardagsapp (5 av 10). Kort och listor med luft, inga tabellväggar på telefonen.
- Variation: förutsägbar (3 av 10). Samma kort, samma rader, samma knappar överallt.
- Rörelse: sparsam CSS (4 av 10). Bara där något händer: tryck, ark, ett nytt pass som
  landar, en flik som byts. Aldrig på det man gör hundra gånger om dagen.

## 2. Färger och roller

Varumärkets rosa är den enda accenten. Avsteget från stitch-reglernas förbud mot lila och neon
är medvetet. Rosan och neonröret *är* Bando, så de stannar, men de lyser bara där något är aktivt.

| Namn | Värde | Roll |
|---|---|---|
| Natt | `#0b090e` | Bakgrund |
| Yta | `#141119` | Kort, rader, ark |
| Yta 2 | `#1a1620` | Tryckt eller hovrat kort |
| Text | `#f3eff7` | Brödtext och rubriker |
| Dämpad | `#a39bae` | Underrader, etiketter |
| Linje | `rgba(255,255,255,.075)` | Kortens kant, avdelare |
| Linje 2 | `rgba(255,255,255,.13)` | Starkare kant (spökknappar, valda rutor) |
| Neonrosa | `#ff3ebf` / rör `#ff6ad8` | Det valda, det pågående, markörer |
| Knapprosa | `#d01b8c` | Fyllda knappar (vit text håller kontrast) |
| Status | ok `#34d399`, varning `#fab219`, fel `#fb7185` | Alltid med text, aldrig färg ensam |

Crewets och studiornas färger (`--c1`..`--c6`, `SC`) är data, inte dekor. De står alltid
bredvid ett namn. Övrig studio (`X`) är neutral `#a39bae`.

## 3. Typografi

- **Skylten:** Barlow Condensed 800, versaler. Bara för vyns rubrik (`.h1`), arkets rubrik,
  veckonumret och den tända studion. Inget annat får låna den rösten.
- **Allt annat:** Barlow 400 till 600.
- **Handlingar skrivs som meningar:** knappar, textlänkar, chips, flikar och menyn.
  Rätt: "Boka passet", "Ändra status". Fel: "BOKA PASSET". Namn och förkortningar behåller
  sin form (RKAY, SV, Bando HQ, Studio A, The Booth). Studionamn som sparats i versaler visas
  med `niceName()`.
- **Etiketter och status är små lugna versaler:** sektionsrubriker (`.eyebrow`), fältetiketter,
  faktaradernas etiketter och statuspiller. 11 till 12 px, spärrning högst .1em, dämpad färg.
- **Siffror:** tabellsiffror (`.nums`) i tider och belopp.

## 4. Komponenter

- **Knappar:** kapslar (`--r-pill`). Fylld knapprosa för huvudhandlingen, spökknapp (svag
  ljus ton och hårfin kant) för det andra, rosa kant för att ta bort. Trycks in till 97 %.
  Högst en fylld knapp per kort.
- **Chips och flikar:** kapslar. Valt chip är en fylld rosa ton, inte en neonram. Flikar är ett
  segmentreglage: tyst spår, den valda fliken som en ljusare kapsel som glider (240 ms).
- **Kort:** 16 px hörn, ytfärg, hårfin ljus kant. Ett kort ligger aldrig i ett kort. Passkort
  har producentens färg som en rundad stapel innanför vänsterkanten.
- **Rutor (dagar, studioval):** 12 px hörn. Vald = rosa ton och rosa kant, ingen glöd.
- **Fält:** fyllda och rundade (12 px). Etiketten står ovanför, fokus är en mjuk rosa ring.
- **Ark:** glider upp från botten (420 ms in, 280 ms ut), 22 px hörn upptill; på datorn en
  panel från höger. Stängknappen är en rund ton, inte en ram.
- **Rutor för besked:** varning och klart är tonade, rundade rutor, utan vänsterkant.
- **Tomt läge:** ett släckt hus och en mening om hur man fyller det, gärna med en länk.
- **Laddning:** skelett (`.skel`) i innehållets form, aldrig en snurra.

## 5. Layout

- Telefon först. En kolumn under 1024 px; en sidomeny och ett bredare innehåll från 1024 px.
- Avstånd i steg om 4/8/12/16/24/32 (`--s1`..`--s6`). Sektioner har 30 px luft ovanför.
- Sektionsrubriker har ingen linje bredvid sig. Ett räknetal får stå längst till höger.
- Ingen horisontell rullning av sidan. Chiprader får rulla i sidled och tonar ut mot kanten.
- Tryckytor är minst 40 px höga, knappar 50 px.

## 6. Rörelse

Kurvor: `--ease` `cubic-bezier(.23,1,.32,1)` (det som kommer in), `--ease-io`
`cubic-bezier(.77,0,.175,1)` (linjer som flyttar sig), `--ease-drawer`
`cubic-bezier(.32,.72,0,1)` (ark och paneler). Bara `transform` och `opacity`.

| Var | Vad | Varför |
|---|---|---|
| Allt man trycker på | skala .95 till .99, 140 till 160 ms | Återkoppling |
| Textlänkar | dämpas till 55 % | Återkoppling |
| Ark | glider upp 420 ms, ner 280 ms | Rumslig: varifrån det kom |
| Flikar | kapseln glider 240 ms | Visar att vyn bytts |
| Nytt eller ändrat pass | landar på plats (6 px, 280 ms) när arket stängs | Undviker att något bara "finns där" |
| Bocka av | bocken poppar 260 ms | Återkoppling |
| Första vyn per session | korten kommer i tur och ordning | Entré, en gång |

Medvetet utan rörelse: byte mellan menyflikarna (görs hela dagen), val av dag i veckan,
diagrammen (data man läser). Med "minska rörelse" står allt still eller tonar.

## 7. Förbjudet

- Versaler med bred spärrning i knappar, länkar, chips, flikar eller menyn.
- Neonglöd på något som inte är aktivt. Glöd är för det valda och det pågående.
- Raka hörn på nya komponenter. Inga kort i kort.
- Rena `#000` eller `#fff` som ytor.
- Emojier i gränssnittet, utom där innehållet själv är text från Bando.
- Fejkade siffror, platshållarnamn ("John Doe", "Acme").
- Tankstreck som dekor i nya rubriker och knappar; använd punkt, komma eller kolon.
