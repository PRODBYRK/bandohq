# BANDOHQ i App Store: det som fylls i i App Store Connect

Allt nedan klistras in under **Appar → BANDOHQ** i App Store Connect. Bilderna ligger i
`skarmbilder/` (1320 × 2868, iPhone 6,9"). Gör nya med:

```
python3 test/run.py shot '…' bild.png 440 956 3
```

## Appinformation

| Fält | Värde |
|---|---|
| Namn | BANDOHQ |
| Undertitel (max 30) | Studio, crew och studiecirklar |
| Bundle-id | se.bandohq.app |
| Primärt språk | svenska |
| Kategori | Affärer (andra: Musik) |
| Innehållsrätt | Appen visar inget innehåll från tredje part |
| Åldersgräns | 4+ (svara "nej" på allt i frågeformuläret) |
| Copyright | 2026 Bando Collective |
| Integritetspolicy-URL | https://bandohq.se/#integritet |
| Support-URL | https://bandohq.se/#support |
| Marknadsförings-URL | https://bandocollective.com (valfritt) |
| Pris | gratis, inga köp i appen |

## Reklamtext (max 170 tecken, kan ändras utan ny granskning)

Boka studiotid hos Bando Collective. Ett pass är tre timmar — välj en tid, skicka en förfrågan
och få bekräftelsen direkt i telefonen.

## Beskrivning

BANDOHQ är Bando Collectives app för studion, crewet och studiecirklarna.

BOKA STUDIOTID
Se vilka tider som är lediga och vilka dagar som är fullbokade, välj en starttid och skicka en
förfrågan. Ett pass är tre timmar. Du får en bekräftelse när tiden är bokad. Du kan avboka själv
fram till en timme innan. Det går att boka utan konto.

FÖR CREWET
Schemat för båda studiorna, dagens och veckans pass, veckans agenda, beats och artister, ett
galleri från kamerateamet och förfrågningar att svara på. Producenterna lägger själva till sina
kunder.

FÖR STUDIECIRKLARNA
Cirkelledaren bokar pass, godkänner förslag och markerar närvaro. Deltagarna föreslår tider i
sin cirkel.

NOTISER
Bokningsbekräftelser, svar på förfrågningar och påminnelser dagen innan, direkt i telefonen.

Konton skapas med en inbjudan från Bando Collective. Studiotid bokas utan konto från
startsidan.

## Nyckelord (max 100 tecken, komma utan mellanslag)

studio,boka,studiotid,inspelning,musik,producent,studiecirkel,crew,beats,schema,bando,replokal

## Granskningsinformation (App Review Information)

| Fält | Värde |
|---|---|
| Användarnamn | apple-review |
| Lösenord | BandoDemo2026 |
| Kontakt | Rasmus Kerstell · bandocollect@gmail.com · telefon |

**Anteckningar (på engelska, till granskaren):**

> BANDOHQ is the app of Bando Collective, a recording studio and music collective in Sweden.
> The crew, study-circle members and studio customers use it to book the studio, run the
> schedule and get booking confirmations as push notifications. Accounts are created by
> invitation. Anyone can book studio time without an account: tap "BOKA STUDIOTID" on the
> first screen.
>
> Demo account: sign in with username apple-review and password BandoDemo2026. This opens a
> fully-featured demo mode with sample data (no real people), so you can review every role.
> Tap the name in the top right, then "BYT KONTO", to view the app as a producer, admin, camera
> team member, circle leader, participant or customer.
>
> Account deletion: tap the name in the top right, then "Radera mitt konto" (Delete my account).
>
> Payments: studio time is a service performed in person at the studio and paid outside the app
> (guideline 3.1.3(e)). The app has no in-app payments.

## Appens integritet (App Privacy)

**Spårning:** nej. **Reklam:** nej. Allt nedan är **kopplat till användaren** och används bara för
**appens funktion**.

| Datatyp | Vad det är |
|---|---|
| Kontaktuppgifter: namn, e-postadress, telefonnummer | kontot och bokningsbekräftelser |
| Användarinnehåll: bilder och film | kamerateamets galleri (bara crewet) |
| Användarinnehåll: annat | bokningar, agenda och mål |
| Identifierare: användar-id | inloggningen |

## Export av kryptering

Appen använder bara standardkryptering (HTTPS). `ITSAppUsesNonExemptEncryption` är satt till
`NO` i Info.plist, så frågan dyker inte upp vid varje bygge.
