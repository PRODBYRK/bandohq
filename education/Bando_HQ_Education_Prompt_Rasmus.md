# PROMPT TILL RASMUS — BYGG BANDO EDUCATION I BANDO HQ

Bygg en ny, enkel modul i vårt befintliga Bando HQ som heter **Bando Education**. Bygg direkt i den befintliga appens teknikstack, autentisering och designsystem. Vi vill **inte** bygga en separat plattform, ett LMS eller en massa extra funktioner. Målet är att cirkelledaren öppnar sin tilldelade läroplan och direkt ser vad gruppen ska lära sig denna månad.

**VIKTIGT: Jag bifogar filen `Bando_Education_200_Laroplaner.json`. Importera alla 200 poster från `laroplaner` som vår färdiga läroplansbank. Ändra inte koder eller innehåll utan att stämma av.** JSON-filen innehåller 18 ämnesområden, 200 unika utbildningsmallar, exakt sex månadsperioder per mall, slutprojekt, studiematerial samt sex färdiga fält med SV-arbetsplanstexter. Läs filen som källa; generera inte nya, påhittade kursplaner i koden.

## Vad 200 betyder

200 inriktningar = **200 återanvändbara läroplansmallar**, INTE 200 startade studiecirklar. Samma mall kan tilldelas till flera cirkelledare och användas flera gånger. En faktisk studiecirkel/grupp får en tilldelning av EN vald läroplan. Gör ingen koppling mellan olika cirklar. Varje grupp arbetar självständigt med sin egen plan och ett gemensamt lärprojekt.

## Exakt vilka sidor vi behöver

### 1. Education → Läroplansbank (admin: Gio, Oscar och behöriga administratörer)

- Lista alla 200 läroplaner, grupperade efter de 18 ämnesområdena.
- Sök på kod och namn; filtrera på ämnesområde.
- Klick på läroplan visar: titel, kod, övergripande mål, material, slutprojekt, de sex månadsperioderna och malltexter för SV:s arbetsplan.
- Knapp: **Tilldela läroplan**.
- Originalmallarna ska inte kunna ändras av vanliga cirkelledare.

### 2. Education → Tilldela läroplan (admin)

Administratören väljer:
- Cirkelledare (befintlig HQ-användare).
- Läroplan (en av 200).
- Cirkelnamn eller cirkel-ID (frivilligt för att skilja en ledares grupper åt).
- Startdatum/period (kan lämnas tomt till dess att det är bestämt).

Spara tilldelningen. Samma ledare kan få flera olika tilldelningar, och samma läroplan kan användas av många grupper. Administratören ska kunna ändra eller avsluta tilldelningar.

### 3. Education → Mina läroplaner (cirkelledare)

- Ledaren ser BARA sina tilldelade läroplaner, inte andras tilldelningar.
- Klick på en tilldelning visar sex periodkort: **Månad 1–6**.
- Varje månad visar endast **mål**, **vad gruppen ska arbeta med** och **delresultat** (från JSON-fälten `mal`, `arbete`, `delresultat`).
- Månad 1 är alltid **Introduktion**. Alla utbildningar följer samma sex steg: Introduktion → Grunder & teknik → Idé & planering → Praktiskt skapande → Fördjupning & förbättring → Slutprojekt & presentation.
- Inga veckoplaner, betyg, prov, certifikat eller individuella deltagarprofiler.

### 4. Enkel månadsuppföljning

Under varje månadsperiod finns endast två frivilliga, redigerbara frågor:
1. **Vad har gruppen lärt sig?**
2. **Vad har gruppen arbetat med eller skapat?**

Spara dessa anteckningar per tilldelning och månad. Lägg till ETT frivilligt fält på hela utbildningen: **Länk till slutprojekt** (exempelvis Drive, video, ljuddemo eller portfolio). Bygg ingen särskild projektbank eller filuppladdning nu.

### 5. SV-arbetsplan (på varje tilldelad läroplan)

Flik eller utfällbar sektion **Arbetsplan – SV**, med dessa exakt sex fält från JSON `sv_arbetsplan_mall`:
- Period
- Vad är ert mål med cirkeln?
- Hur ska ni nå målet?
- Studiematerial/inspirationskällor
- Hur får ni alla att känna sig delaktiga?
- Utvärdering vid sista träffen

Visa färdiga förslagstexter, men låt ledaren anpassa dem tillsammans med deltagarna och spara en egen version för sin grupp. Ha enkla **Kopiera**-knappar. **Ingen direktkoppling till SV:s e-tjänst och ingen automatisk rapportering.** Närvaro fortsätter att rapporteras i SV:s befintliga system enligt deras rutiner.

## Datamodell – gör minsta möjliga

Återanvänd befintligt användar- och rollsystem i HQ. Förslagsvis:

- **education_curricula**: `code` (unik), `name`, `category_code`, `goal`, `months` (6 JSON-objekt), `final_project`, `sv_template` (6 texter), `status`. Importera från den bifogade JSON-filen. Kan alternativt vara en statisk, versionshanterad JSON-katalog i appen om det är enklare.
- **education_assignments**: `id`, `curriculum_code`, `leader_user_id`, `group_label` (nullable), `start_date` (nullable), `status`, `sv_answers` (JSON, nullable), `final_project_url` (nullable).
- **education_monthly_notes**: `assignment_id`, `month_number` (1–6), `learned`, `created`, `updated_at`. Unik kombination av `assignment_id + month_number`.

Behörigheter måste kontrolleras på serversidan: endast admin/Gio/Oscar kan tilldela och visa alla tilldelningar, och en ledare får bara läsa/uppdatera sina egna tilldelningar och anteckningar. Visa inte personnummer eller annan känslig information i Education.

## Design

- Använd nuvarande Bando HQ-färg, typografi och komponenter.
- En enkel sidomenypost: **Education**.
- Under admin: **Läroplansbank** och **Tilldelningar**.
- Under cirkelledare: **Mina läroplaner**.
- Mobilvänligt med kompakta månadsflikar eller kort.
- Ingen komplex dashboard, inga poäng, ingen gamification.

## Viktiga principer för innehållet

- Alla läroplaner är **sex månader**, utan detaljstyrda veckoscheman.
- Alla börjar med introduktion, utvecklar färdigheter och slutar med ett **gemensamt lärprojekt inom sitt eget ämne**.
- Vi får gärna använda verkliga studioprojekt, demos eller sessions som övningsmaterial om samtycke och rättigheter är klara, men **huvudsyftet ska vara deltagarnas lärande**. Studiecirklar ska inte användas för kommersiell produktion eller obetald arbetskraft.
- Arbetsplanen är ett utkast som anpassas tillsammans med deltagarna. Det som skickas in till SV måste överensstämma med hur gruppen faktiskt ska arbeta.
- Ingen automatisk förflyttning till en annan utbildning efter sex månader.

## Färdig-definition (acceptanskriterier)

1. Exakt **18 ämnesområden och 200 unika läroplaner** visas från JSON-importen.
2. Alla 200 har **exakt 6 perioder** och ett ämnesspecifikt slutprojekt.
3. Gio/Oscar/admin kan tilldela en läroplan till valfri cirkelledare.
4. Samma läroplan kan tilldelas många grupper utan att duplicera eller ändra originalet.
5. En ledare ser sina tilldelningar och de sex månadsplanerna.
6. Två anteckningsfält per månad går att spara och läsa igen.
7. SV-arbetsplanens sex förifyllda fält går att ändra, spara och kopiera per tilldelning.
8. Ingen ledare kan se eller redigera en annan ledares privata tilldelningar eller anteckningar.
9. Befintliga HQ-sidor för schema, bokning, agenda och ekonomi påverkas inte.
10. Importen är idempotent: den skapar inte dubletter vid uppdatering. Kontrollera att samtliga koder och sexmånadersperioder finns med.

**Bygg bara detta nu. När grunden fungerar kan vi vidareutveckla senare.**
