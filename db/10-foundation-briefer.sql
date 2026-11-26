-- =====================================================================
--  10 · AVDELNINGARNAS BRIEFER OCH STARTUPPGIFTER
--  Underlag: masterplanen (BF HQ) och ansvarsunderlagen för A–E, C, D, G, H och I.
--  Briefen är avdelningens hela uppdrag i text. Den läses av alla i Foundation och
--  redigeras av avdelningens chef (i G av alla i redaktionen) och av admin.
--  Startuppgifterna läggs in utan ansvarig och går till rätt person när den går med:
--  'chief' till avdelningens chef, annars ett medlems-id eller ett förnamn.
--  Körs om utan att skriva över ändringar: briefen sätts bara när den är tom och varje
--  startuppgift har en unik nyckel.
-- =====================================================================

alter table fd_departments add column if not exists brief text not null default '';
alter table fd_departments add column if not exists brief_updated_at timestamptz;
alter table fd_departments add column if not exists brief_updated_by text references members(id) on delete set null;

alter table fd_tasks add column if not exists seed text;
alter table fd_tasks add column if not exists seed_for text;
create unique index if not exists fd_tasks_seed on fd_tasks (seed) where seed is not null;

/* seed och seed_for sätts bara av migreringen, aldrig av en inloggad användare. */
create or replace function fd_task_seed_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then new.seed := null; new.seed_for := null;
  else new.seed := old.seed; new.seed_for := old.seed_for; end if;
  return new;
end $$;
drop trigger if exists fd_task_seed_guard on fd_tasks;
create trigger fd_task_seed_guard before insert or update on fd_tasks for each row execute function fd_task_seed_guard();

/* Som i 07, men utan en notis per uppgift när startuppgifterna fördelas (då kommer en samlad notis). */
create or replace function fd_task_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform fd_log('task', new.id, 'skapad', null, fd_task_log(new));
    perform fd_notify(new.assignee, 'task', case when new.protected then 'Ny skyddad uppgift' else 'Ny uppgift: ' || new.title end,
      coalesce((select name from members where id = new.created_by), 'Någon') || ' gav dig en uppgift'
      || case when new.protected then '' else ': "' || new.title || '"' end
      || coalesce(' med deadline ' || new.due, '') || '. Öppna den i Bando Foundation.', 'task', new.id);
    return new;
  end if;
  if new.status is distinct from old.status then
    perform fd_log('task', new.id, 'status', jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  if new.assignee is distinct from old.assignee then
    perform fd_log('task', new.id, 'ansvarig', jsonb_build_object('assignee', old.assignee), jsonb_build_object('assignee', new.assignee));
    if coalesce(current_setting('fd.seed', true), '') <> '1' then
      perform fd_notify(new.assignee, 'task', case when new.protected then 'Ny skyddad uppgift' else 'Ny uppgift: ' || new.title end,
        coalesce((select name from members where id = bs_my_id()), 'Någon') || ' gav dig en uppgift'
        || case when new.protected then '' else ': "' || new.title || '"' end || '.', 'task', new.id);
    end if;
  end if;
  return new;
end $$;

/* Ger en person de startuppgifter i avdelningen som är tänkta för den. */
create or replace function fd_assign_seeded(p_member text, p_dept text) returns int
language plpgsql security definer set search_path = public as $$
declare n int; fn text; is_chief boolean;
begin
  select lower(split_part(trim(name), ' ', 1)) into fn from members where id = p_member;
  is_chief := exists (select 1 from fd_memberships where member_id = p_member and dept = p_dept and role = 'chief');
  perform set_config('fd.seed', '1', true);
  update fd_tasks set assignee = p_member
   where dept = p_dept and assignee is null and seed is not null and status <> 'done'
     and ((seed_for = 'chief' and is_chief) or lower(seed_for) = lower(p_member) or lower(seed_for) = fn);
  get diagnostics n = row_count;
  perform set_config('fd.seed', '', true);
  if n > 0 then
    perform fd_notify(p_member, 'brief', 'Din brief för avdelning ' || p_dept,
      (select name from fd_departments where code = p_dept) || ': ' || n
      || case when n = 1 then ' startuppgift ligger' else ' startuppgifter ligger' end
      || ' på dig. Läs briefen först, den beskriver hela uppdraget.', 'brief', p_dept);
  end if;
  return n;
end $$;

create or replace function fd_membership_seeded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform fd_assign_seeded(new.member_id, new.dept);
  return null;
end $$;
drop trigger if exists fd_membership_seeded on fd_memberships;
create trigger fd_membership_seeded after insert or update of role on fd_memberships for each row execute function fd_membership_seeded();

/* Briefen ändras av admin, avdelningens chef, eller i G av alla i redaktionen.
   p_dept null = den gemensamma briefen för hela Foundation (bara admin). */
create or replace function fd_save_brief(p_dept text, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare d fd_departments; t text := coalesce(p_text, '');
begin
  if length(t) > 40000 then raise exception 'Briefen är för lång'; end if;
  if p_dept is null then
    if not fd_admin() then raise exception 'Bara Foundation-admin ändrar den gemensamma briefen'; end if;
    insert into fd_settings(key, value, updated_by, updated_at) values ('brief', jsonb_build_object('text', t), bs_my_id(), now())
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
    perform fd_log('brief', 'gemensam', 'ändrad', null, jsonb_build_object('length', length(t)));
    return;
  end if;
  select * into d from fd_departments where code = p_dept;
  if d.code is null then raise exception 'Avdelningen finns inte'; end if;
  if not (fd_admin() or exists (select 1 from fd_memberships where member_id = bs_my_id() and dept = p_dept and (role = 'chief' or not d.has_chief))) then
    raise exception 'Bara avdelningens chef och admin ändrar briefen';
  end if;
  update fd_departments set brief = t, brief_updated_at = now(), brief_updated_by = bs_my_id() where code = p_dept;
  perform fd_log('brief', p_dept, 'ändrad', jsonb_build_object('length', length(d.brief)), jsonb_build_object('length', length(t)));
end $$;

revoke all on function fd_task_seed_guard(), fd_assign_seeded(text, text), fd_membership_seeded() from public, anon, authenticated;
revoke all on function fd_save_brief(text, text) from public, anon;
grant execute on function fd_save_brief(text, text) to authenticated;

-- ---------------------------------------------------------------------
--  DEN GEMENSAMMA BRIEFEN (masterplanen avsnitt 1–3 och 20)
-- ---------------------------------------------------------------------
insert into fd_settings(key, value) values ('brief', jsonb_build_object('text', $b$
## Varför vi finns
Bando Foundation vill hjälpa ungdomar att upptäcka fler möjligheter i livet: nya intressen och talanger, fler alternativ när de tänker på sin framtid, och människor som kan inspirera dem. Genom positiva sammanhang vill vi också bidra till att förebygga utanförskap och kriminalitet.
Det handlar inte om att alla ska jobba med musik. Det handlar om att ungdomarna ska upptäcka vad de kan göra med sina liv.

## Behind the Release
Vårt första stora program. 40 ungdomar får arbeta med kreativa projekt och upptäcka allt som händer bakom ett musiksläpp: produktion, film, foto, design, marknadsföring och strategi.
Innan programmet bjuder vi in sökande till heldagsworkshops där de får prova kreativa arbeten. Workshopparna är också en del av urvalet.

## Så arbetar vi i HQ
HQ är platsen där hela Foundation arbetar. Varje person ansvarar för sitt område och lämnar uppgifter vidare genom tydliga överlämningar.
- **Uppgifter:** rubrik, beskrivning, ansvarig, avdelning, deadline och status (Att göra → Pågår → Väntar → Klar). En uppgift med deadline hamnar i den ansvarigas agenda.
- **Överlämningar:** en överlämning är genomförd när mottagaren har fått relevant information och accepterat ansvaret. Skriv vad den gäller, vad som hittills sagts, vad som ska göras härnäst, vem som tar ansvar och eventuellt datum.
- **Meddelanden:** arbetskommunikationen sker i HQ, inte i privata WhatsApp-trådar. Viktiga beslut skrivs i rätt ärende så att de inte försvinner i en chatt.
- **Dokument:** ladda upp på uppgiften, kontakten eller aktiviteten det hör till. Godkänt material finns i Kommunikation.
- **Avdelningsuppdateringen:** vad vi arbetar med, vad vi nyligen slutfört, vad vi behöver hjälp med och vad vi väntar på. Andra avdelningar läser den i stället för att boka möten om varje liten sak.

## Regler som gäller alla
- En kontakt ska inte behöva skapas flera gånger. Samma ärende kan följas av flera avdelningar.
- Inga överlämningar får försvinna. Avsändare och mottagare ser vem som har ansvaret.
- Alla ska kunna arbeta självständigt: lägga upp kontakter, filer och uppgifter utan att vänta på någon annan.
- Ungdomsuppgifter, filmmedgivanden och interna dokument hanteras med rätt behörighet. Samla bara in det som behövs.
- AI får hjälpa till att analysera, planera och skriva utkast, men skickar inga SMS, publicerar inget, godkänner inga deltagare, tecknar inga avtal och skickar inga ansökningar. Människorna ansvarar för besluten.
- Ekonomiska och bindande åtaganden kräver beslut av behöriga företrädare. Bando Foundation och Bando Collective är separata verksamheter.

## Avdelningarna
- **A – Outreach & aktörsrelationer:** Joseph
- **B – Ungdomsrelationer, ansökningar & urval:** Samuel
- **C – Workshops & aktiviteter:** Amir
- **D – Artist- & profilrelationer:** Adrian
- **E – Strategiska partnerskap:** Joseph
- **F – Kommunikation & varumärke:** Jasmin
- **G – Redaktion & content:** gemensam redaktion (Nanna, D2L, Rasmus, Amir)
- **H – Ungdomsinsikter & samhällsundersökningar:** ej tillsatt
- **I – Finansiering:** Rasmus bygger systemet, William prioriterar
- **J – Administration & ekonomi:** Jasmin
Rasmus samordnar arbetsflödena mellan avdelningarna och utvecklar HQ tillsammans med Viktor. William följer upp avdelningsansvariga via telefon.
$b$)) on conflict (key) do nothing;

-- ---------------------------------------------------------------------
--  AVDELNINGARNAS BRIEFER
-- ---------------------------------------------------------------------
update fd_departments set brief = $b$
## Uppdraget
A ska etablera och utveckla relationer med verksamheter som redan möter ungdomar: fritidsgårdar, skolor, HVB, ungdomsföreningar och andra relevanta aktörer. Genom dem når vi ut med Foundations verksamhet, träffar ungdomar och skapar möjligheter för dem att registrera sitt intresse och delta.
A ansvarar för relationerna med verksamheterna. Den individuella ungdomshanteringen tillhör B.
Målet är ett växande nätverk av ungdomsverksamheter som regelbundet hjälper oss att nå nya deltagare.

## Ansvarig
**Joseph** är huvudansvarig för A (och för E). Han ansvarar för riktning, prioriteringar, relationer och utveckling, och har frihet att utforma arbetssätt och ta initiativ inom Foundations gemensamma ramar.

## Arbetsområden
- **A1 – Aktörskartläggning:** identifiera relevanta verksamheter och kontaktpersoner och undersök vilka samarbeten som är möjliga.
- **A2 – Kontaktarbete:** etablera dialog, presentera Foundation, undersök intresse och boka möten eller besök.
- **A3 – Outreach-material:** använd våra presentationer, projektunderlag, broschyrer och registreringslänkar. Behov av nytt material lämnas till F.
- **A4 – Verksamhetsbesök:** organisera och genomför besök där vi presenterar Foundation, träffar personal eller ungdomar och undersöker möjliga aktiviteter.
- **A5 – Nya kontaktvägar:** utveckla relationer med fler typer av ungdomsverksamheter och hitta nya sammanhang där vi når målgruppen.
- **A6 – Relationsutveckling:** behåll kontakten och utveckla återkommande samarbeten.
- **A7 – Kontaktregister & uppföljning:** kontakter, överenskommelser och nästa steg ska finnas i HQ.
- **A8 – Outreachstrategi:** avdelningens strategiska inriktning, prioriteringar och utveckling.

## Från kontakt till deltagande
1. **Kontakt med verksamheten:** A etablerar en relation, till exempel med en fritidsgård eller skola.
2. **Presentation och intresse:** besök, samtal eller material. Intresserade ungdomar hänvisas till registreringen på hemsidan.
3. **Registrering:** ansökan går automatiskt till B i HQ.
4. **Personlig kontakt genom B:** Samuel och B-teamet ringer eller sms:ar ungdomen.
5. **Inbjudan till aktivitet:** B bjuder in till workshops som C ansvarar för.
A ansvarar för verksamhetsrelationen och vägen fram till registrering. Du ska kunna följa hur många registreringar en verksamhet leder till utan att hantera ungdomarnas personuppgifter.

## Läget nu
Kontakten med fritidsgårdar är i ett inledande skede. Tre fritidsgårdar har fått mejl, men ingen ordentlig dialog eller etablerat samarbete har kommit till stånd. Det praktiska relationsarbetet återstår till stor del.
Det här finns förberett:
- Organisationspresentation för Bando Foundation
- Presentation av Behind the Release
- Broschyrmaterial för ungdomar
- Samtalsstruktur och kontaktmanus
- Standardmejl och presentationsunderlag
- Grundläggande kartläggning av fritidsgårdar
- Planerat upplägg för verksamhetsbesök
Foundation har också genomfört två demoworkshops med upp till cirka 50 ungdomar. Det är tidigare erfarenheter, inte resultat från fritidsgårdskontakterna.

## Överlämningar från A
- **Till B (Samuel):** en verksamhet vill sprida ansökan till sina ungdomar.
- **Till C (Amir):** en verksamhet vill ha en workshop eller presentation. Skicka önskemål, datum och praktiska förutsättningar. A behåller relationen.
- **Till E:** ett första samtal växer till ett större organisationssamarbete. Kontakten kopplas vidare utan att skapas på nytt.
- **Till F (Jasmin):** verksamheten behöver presentations- eller informationsmaterial.
Skilj mellan att någon är positiv till idén och att ett samarbete är formellt bekräftat.

## Samarbete
- **D (Adrian):** D tar enskilda artister och profiler, A tar organisationer. Kontakter som berör båda samordnas.
- **H:** A kan bidra med erfarenheter från ungdomsverksamheterna och hjälpa H nå fler platser för undersökningar.
- **J:** avtal och ekonomiska åtaganden hanteras enligt föreningens beslutsordning.

## Mandat
Joseph har självständigt ansvar för den operativa och strategiska utvecklingen av A inom överenskomna ramar. Beslut som kräver andra avdelningars resurser samordnas med respektive ansvarig. Avtal, arvoden och ekonomiska åtaganden hanteras enligt föreningens beslutade ordning.

## I HQ
- **Kontakter (avdelning A):** varje verksamhet med kontaktperson, telefon, område, status, kommentar och nästa steg.
- **Överlämningar:** knappen Skicka överlämning på kontakten.
- **Avdelningens AI (Outreach Research):** hjälper att hitta verksamheter, samla offentliga kontaktuppgifter och förbereda samtal. Du ansvarar för den faktiska relationen.

## Arbetsrytm (förslag, ändra fritt)
- Löpande: skriv in varje samtal och besök på kontakten direkt, med nästa steg.
- Varje vecka: uppdatera avdelningsuppdateringen och gå igenom kontakter där nästa steg passerat.
- Telefonavstämning med William om utvecklingen, viktiga möjligheter och beslut som behöver förankras.
$b$ where code = 'A' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
B ansvarar för den personliga kontakten med ungdomarna som söker till Bando Foundation: ta emot ansökningar, kontakta ungdomarna, lära känna dem, bjuda in dem till aktiviteter och samordna urvalet till de 40 platserna i Behind the Release.
Vi vill skapa personliga relationer och förstå vilka ungdomarna är, inte bara vad de skriver i ansökan. B ansvarar också för deltagarrelationer, uppföljning och den övergripande deltagartryggheten.

## Ansvarig
**Samuel** ansvarar för B och samarbetar direkt med övriga avdelningsansvariga.

## Vilka ungdomar vi söker
Inte bara de som redan kan producera, filma eller skapa. Vi söker personlighet, nyfikenhet och vilja att utvecklas. Tidigare erfarenhet är inget krav.
- **Driv och initiativ:** vill någonting, tar egna initiativ och försöker.
- **Energi och engagemang:** närvaro, intresse och engagemang.
- **Egna idéer och perspektiv:** vågar tänka annorlunda och komma med förslag.
- **Personlighet och autenticitet:** vågar vara sig själv och visa vem man är.
- **Nyfikenhet och utvecklingsvilja:** öppen för att prova och lära sig.
- **Samarbetsförmåga:** bidrar till gruppen och lyssnar på andra.
Vi vill inte ha 40 likadana personer, utan olika styrkor som kompletterar varandra.

## Ansökningsprocessen
1. **Ansökan:** ungdomen ansöker på hemsidan och ansökan kommer automatiskt in under Ungdomar. Ett bekräftelsemejl går ut direkt.
2. **Personlig kontakt:** Samuel eller någon i B ringer eller sms:ar, presenterar programmet och får en första bild av personen.
3. **Workshops:** de sökande deltar i aktiviteter som C arrangerar. Ungdomarna ska känna att de är där för att prova, inte för att genomgå ett prov.
4. **Helhetsbedömning:** ansökan, samtal och erfarenheter från aktiviteterna vägs samman. B sammanställer underlaget med C:s observationer. Slutligt urval görs av de ansvariga Foundation utser.
5. **Antagning:** 40 ungdomar erbjuds plats. B ansvarar för besked, deltagarkontakt och introduktion. De som inte får plats ska, där det går, kunna fortsätta delta i andra aktiviteter.
Statusstegen i HQ: Ny ansökan → Kontaktad → Samtal genomfört → Workshop planeras → Workshop genomförd → Urval → Beslut. Att delta i en workshop betyder inte att man fått en plats.

## Första samtalet
Börja ungefär så här: "Hej! Det är [namn] från Bando Foundation. Du har sökt till Behind the Release, så jag ville höra av mig, berätta lite om programmet och lära känna dig lite. Har du några minuter?"
Förklara att vi väljer ut 40 ungdomar och att sökande först bjuds in till mindre workshops. Frågor som hjälper:
1. Vad var det som fick dig att söka?
2. Vad brukar du fastna för när du gör något du verkligen gillar?
3. Om du fick skapa något helt fritt, vad hade du velat göra?
4. Har du något du brinner för just nu? (Det behöver inte handla om musik.)
5. Vad tycker du är roligast med att göra saker tillsammans med andra?
6. Vad skulle du vilja få ut av Behind the Release?
Använd frågorna naturligt, inte som ett förhör. Bra följdfrågor: "Hur kom du på det?", "Berätta mer", "Har du testat det någon gång?"

## SMS
SMS skickas från telefonens egen SMS-app via HQ, med godkända mallar (första kontakt, inbjudan, påminnelse, uppföljning efter aktivitet). Alla SMS från B ska tydligt visa Samuel, Bando Foundation och BandoFoundation.com. Utskicket sparas i ungdomens historik.
Inbjudningar och ändringar ska utgå från den faktiska planeringen så att ingen får fel information.

## Gruppplanering med C
1. Samuel ser ansökningarna, intressena och tillgängligheten.
2. Amir skapar workshopen med datum, tid, plats, platser och ledare.
3. Samuel föreslår deltagare utifrån intressen och förutsättningar.
4. Amir bekräftar gruppstorlek, bemanning, utrustning och lokal.
5. Samuel skickar inbjudan med rätt tid och plats.
6. Samuel ser vem som tackat ja, nej eller inte svarat.
7. Gruppen är klar och Amir har det han behöver.
Deltagare kan flyttas mellan workshops och återbud hanteras utan nya ansökningar.

## Trygghet
- B har det övergripande ansvaret för deltagartryggheten. C ansvarar för säkerheten under aktiviteterna.
- Åldersanpassad kommunikation, godkända kontaktvägar och bara de uppgifter som behövs.
- Vårdnadshavare involveras enligt verksamhetens rutiner. Medgivanden för foto och film går via länk.
- Urvalet dokumenteras sakligt efter fastställda kriterier. Frånvaro vid en aktivitet likställs inte automatiskt med bristande motivation.
- Ungdomars medverkan i content är frivillig och påverkar inte antagningen.
- Bara behöriga ser individuella urvalsunderlag. AI bestämmer aldrig vem som antas.

## Samarbete
- **A (Joseph):** skapar vägarna till ansökan. När ungdomen registrerat sig tar B över.
- **C (Amir):** planerar och genomför workshopparna. B och C delar observationer inför urvalet.
- **G:** om ungdomar ska vara med i content samordnas det med B.
- **H:** B kan bidra med sammanställda insikter om ungdomarnas intressen och erfarenheter.
- **J:** stödjer arbetet med personuppgifter, integritet och rutiner.

## I HQ
- **Ungdomar:** ansökningar, status, samtalsanteckningar, SMS-historik och urval.
- **Aktiviteter:** workshopparna, grupper, inbjudningar och närvaro (tillsammans med C).
- **SMS-mallar:** under Ungdomar.
- **Avdelningens AI (Youth Operations Assistant):** hjälper med organisering och SMS-utkast. Ungdomarnas personuppgifter skickas aldrig till AI.

## Arbetsrytm (förslag, ändra fritt)
- Varje dag: nya ansökningar kontaktas, helst inom ett par dagar.
- Inför varje workshop: bekräfta gruppen med Amir och skicka påminnelse dagen innan.
- Efter varje workshop: uppföljnings-SMS och observationer från C in i urvalsunderlaget.
- Varje vecka: avdelningsuppdateringen och telefonavstämning med William.
$b$ where code = 'B' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
C utvecklar, planerar och genomför Foundations workshops och kreativa program. Inför Behind the Release arrangerar vi heldagsworkshops för ungdomar som sökt till programmets 40 platser.
Varje workshop ska ge en konkret upplevelse av något som faktiskt görs i musikbranschen eller en närliggande kreativ bransch. Ungdomarna arbetar med ett uppdrag, tar egna beslut, samarbetar och skapar ett resultat.

## Ansvarig
**Amir** ansvarar för hela C: aktivitetsutveckling, planering, resurser, genomförande och uppföljning. Han har frihet att utveckla och testa koncept inom Foundations ramar. Amir är också med i G och hjälper till med redaktionens struktur.

## Grundmodellen: en dag, ett projekt
Cirka 5–6 timmar med en sammanhängande kreativ process. Inga musikquiz, lekar eller fristående småaktiviteter.
1. **Uppdraget:** ett konkret uppdrag, till exempel en låt, ett singelomslag eller en releasekampanj, och vilka yrkesroller som gör det.
2. **Idéer och research:** ungdomarna undersöker och kommer med egna idéer.
3. **Kreativa beslut:** gruppen väljer riktning och fördelar uppgifter.
4. **Produktion:** större delen av dagen.
5. **Färdigställande:** sammanställa och förbättra.
6. **Presentation och återkoppling:** visa resultatet och berätta om besluten.
Resultatet behöver inte vara professionellt. Det viktiga är att ungdomarna fått följa och påverka en verklig arbetsprocess.
Tidsplan som utgångspunkt (5 h 45 min): uppdrag 25 min, research 45, kreativ planering 45, produktion 120, färdigställande 50, presentation 30, pauser 30. Anpassa efter innehållet.

## De första koncepten
- **01 Produce a Track:** en musikproduktion från grunden. Producent från nätverket. Resultat: ett musikdemo.
- **02 Record a Track:** en inspelningssession med ett förberett beat. Recording engineer eller producent. Ingen behöver själv uppträda.
- **03 Create the Cover:** ett singelomslag till ett demo. Kreatör eller designer.
- **04 Shoot a Music Video:** en kort musikvideo med mobilkamera. Filmare. Deltagarna kan jobba bakom kameran.
- **05 Plan the Release:** A&R-team på ett skivbolag planerar en fiktiv artists singelsläpp. Person med branscherfarenhet.
- **06 Create the Campaign:** en kampanjidé med ett färdigt exempel, till exempel en teaser. Kreatör med content-erfarenhet.
- **07 Develop the Artist:** identitet och visuellt uttryck för ett fiktivt artistprojekt. Kreativ handledare.
Senare, när vi känner ungdomarna bättre: Studio Takeover, Creative Team for a Day, Direct the Artist, Artist Campaign och A&R Session tillsammans med artister och profiler.

## Nya workshops
Utgå från en verklig arbetsprocess och gör en mindre version som går att genomföra på 5–6 timmar. Fem frågor:
1. Vilken verklig arbetsprocess ska deltagarna uppleva?
2. Vad är det konkreta uppdraget?
3. Vilka steg behöver göras under dagen?
4. Vilka roller kan ungdomarna ta?
5. Vad ska gruppen ha skapat när dagen är slut?
AI kan hjälpa med research och idéer, men koncepten bedöms mot de här frågorna och Foundations faktiska resurser.

## Workshops som en del av urvalet
Vi uppmärksammar engagemang och driv, egna idéer, initiativförmåga, nyfikenhet, samarbetsförmåga och personlighet. Observationerna utgår från vad deltagarna faktiskt gör och bidrar med, inte från hur utåtriktade de är. C lämnar återkoppling till B, som samordnar urvalsunderlaget.

## Varje aktivitet i HQ
Upplägg, arbetsprocess, bemanning, resurser, deltagargrupp (överenskommen med Samuel), dokument, meddelanden och resultat efteråt.
**Film:** alla workshops filmas inte. Välj Ingen dokumentation, Begränsad dokumentation eller Redaktionell produktion. Vid film fylls filmplanen i (syfte, vad som ska och inte ska filmas, ansvariga, användning, tillstånd) och G får en överlämning. Ingen deltagare ska behöva bli filmad för att vara med.

## Samarbete
- **A (Joseph):** förfrågningar om aktiviteter från ungdomsverksamheter kommer som överlämningar.
- **B (Samuel):** ansökningar, inbjudningar, deltagarrelationer och urval.
- **D (Adrian):** artister och profiler som vill medverka eller bli inspirationsmentorer. C gör upplägget.
- **E (Joseph):** samarbeten som kan ge lokaler, utrustning och kompetens.
- **G:** redaktionell dokumentation. Verksamheten ska inte störas för att få fram material.
- **H:** tar emot erfarenheter och utvärderingar från aktiviteterna.
- **I:** kan få aktivitets- och resursunderlag från C till ansökningar.
- **J:** formella och ekonomiska frågor.
C ansvarar för säkerhet och trygghet under aktiviteterna. B har det övergripande ansvaret för deltagartryggheten.

## I HQ
- **Aktiviteter:** skapa workshops, grupper, närvaro, filmplan och uppföljning.
- **Avdelningens AI (Workshop Planner):** koncept, tidsplaner, checklistor och sammanställning av feedback.

## Arbetsrytm (förslag, ändra fritt)
- Två veckor före en workshop: upplägg, ledare, utrustning och lokal klart, och beslut om dokumentation.
- En vecka före: gruppen bekräftad med Samuel.
- Dagen efter: kort utvärdering, observationer till B och resultat uppladdat.
- Varje vecka: avdelningsuppdateringen och telefonavstämning med William.
$b$ where code = 'C' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
D träffar artister och profiler, berättar om projektet och får dem intresserade av att vara med. Arbetet bygger på personliga möten och relationer inom musik och kreativa branscher, inte massutskick.
Du behöver inte själv planera intervjuer eller workshops. När någon är intresserad ser du till att personen kommer i kontakt med rätt ansvarig inom Foundation.

## Ansvarig
**Adrian** ansvarar för D.

## Varför vi vill ha med artister och profiler
Många ungdomar ser upp till artister och kreativa personer, men ser bara framgången, inte vägen dit. Vi vill att de träffar människor som vågat tänka annorlunda och valt andra vägar.
Tänk vad det kan betyda för en 16-åring att träffa någon den ser upp till och upptäcka: "Det där skulle jag också kunna göra."

## Fyra sätt att vara med
1. **Visa stöd:** en bild med Bando Foundation-tröjan. Lämnas över till F.
2. **Intervju:** dela erfarenheter, historia och perspektiv i en redaktionell intervju. Lämnas över till G.
3. **Besöka en workshop:** komma förbi studion, träffa ungdomarna, ge feedback eller skapa något tillsammans. Lämnas över till C.
4. **Inspirationsmentor:** träffa en grupp i Behind the Release vid några tillfällen. Lämnas över till C för planering.
Alla behöver inte göra allt. Vi hittar ett sätt som passar personen.

## Så kan du förklara projektet
"Vi har startat Bando Foundation för att ge ungdomar fler möjligheter och öppna deras ögon för olika vägar i livet. Många unga vet inte vad de vill göra eller vilka möjligheter som ens finns. Vi har ett program som heter Behind the Release där 40 ungdomar får testa olika kreativa roller och skapa projekt tillsammans. Vi försöker få med artister och profiler som vill inspirera ungdomarna, allt från att visa stöd eller göra en intervju till att komma förbi studion eller bli inspirationsmentor."
Sedan pratar du vidare på ditt eget sätt. Kom ihåg tre saker:
- **Vad vill vi?** Öppna ungdomarnas ögon för fler möjligheter i livet.
- **Hur?** Kreativa projekt, nya erfarenheter och möten med inspirerande människor.
- **Varför artister och profiler?** Deras historier och närvaro kan inspirera ungdomar att tänka större.
Visa gärna hemsidan och den digitala presentationen om personen vill veta mer.

## Så registrerar du en kontakt
Under Kontakter (avdelning D): profil, hur ni träffades, vilka alternativ personen är intresserad av, status och kommentar, till exempel "Kan tänka sig ett studiobesök i november". Klicka sedan Överlämna till rätt avdelning. Samma profil kan ha flera medverkanden utan att skapas igen, och du ser vad som händer med kontakten efteråt.

## Samarbete
- **G:** när någon vill göra en intervju tar G fram idén och ansvarar för produktionen. Du ser när det blivit en genomförd intervju.
- **C:** workshopbesök och mentorskap planeras av Amir.
- **F:** stödbilder och profilpaketet du visar upp.
- **A och E (Joseph):** organisationer hanteras av Joseph. Kontakter som berör båda samordnas.

## I HQ
- **Kontakter (avdelning D):** dina profiler och deras medverkan.
- **Kommunikation:** godkänt presentationsmaterial att visa.
- **Avdelningens AI (Profile Research):** offentlig bakgrund inför personliga möten. AI kontaktar aldrig profiler.

## Arbetsrytm (förslag, ändra fritt)
- Efter varje möte: skriv in kontakten samma dag med intresse och nästa steg.
- När någon säger ja: överlämna direkt, så att rätt avdelning hör av sig medan intresset finns.
- Varje vecka: avdelningsuppdateringen.
$b$ where code = 'D' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
E etablerar och utvecklar samarbeten med företag, organisationer, institutioner och andra aktörer som kan bidra till Foundations utveckling. Samarbeten kan ge:
- Lokaler och utrustning
- Yrkespersoner och branschkompetens
- Utbildning, mentorskap och erfarenheter
- Nätverk och nya möjligheter för ungdomar
- Gemensamma aktiviteter och projekt
- Ekonomiska eller andra resurser
Ett partnerskap behöver inte handla om pengar. Det viktiga är vilket värde samarbetet skapar och att det finns en tydlig grund för båda parter.
Målet är ett starkt nätverk av samarbetspartners som öppnar nya dörrar och hjälper Foundation att växa.

## Ansvarig
**Joseph** ansvarar för E (och för A).

## Arbetsområden
- **E1 – Partnerkartläggning:** identifiera relevanta företag, organisationer och andra aktörer.
- **E2 – Kontakt & presentation:** etablera relationer, presentera Foundation och undersök möjliga samarbetsområden.
- **E3 – Samarbetsutveckling:** utveckla konkreta förslag och vad parterna kan bidra med.
- **E4 – Förankring & överlämning:** involvera berörda avdelningar och behöriga beslutsfattare innan ett samarbete innebär konkreta åtaganden.
- **E5 – Partneransvar & uppföljning:** behåll den övergripande partnerrelationen och följ upp samarbeten.
Samarbetsprocessen i HQ: Identifierad → Första kontakt → Dialog → Förslag → Förankring → Överenskommelse → Aktivt samarbete.

## Skillnaden mellan A och E
A skapar vägar till ungdomar och leder till registrering. E skapar resurser och möjligheter och leder till samarbeten och gemensamma initiativ. Samma organisation kan vara relevant för båda. Då samordnas relationen så att Foundation har en kontaktväg och inte ger motstridiga budskap.

## Exempel
- **Lokaler:** en organisation vill erbjuda lokaler för workshops. Registrera möjligheten i E och överlämna till C för det praktiska. Behövs ett avtal kopplas J in.
- **Företagssamarbete:** berörda avdelningar bedömer vad som går att genomföra. När villkoren är förankrade och besluten fattade tar respektive avdelning sin del. Joseph behåller partnerrelationen.

## Läget nu
Vi har nätverk och tidigare kontakter inom musik, kultur, ungdomsarbete och samhällsdrivet entreprenörskap, bland annat personer med koppling till Jobyard och Changers Hub, och ett kreativt nätverk genom Bando Collective. Kontakterna är på olika nivåer och ska inte automatiskt räknas som etablerade samarbetspartners.

## Samarbete
- **H:** E kan hjälpa till att etablera större samarbeten med undersökningsorganisationer, universitet och forskare. H ansvarar för undersökningarnas innehåll och metod.
- **I:** E kan stå för relationsarbetet när en finansieringsmöjlighet kräver externa kontakter, till exempel med finansiärer och bidragsexperter.
- **J:** avtal och ekonomiska åtaganden.
- **D (Adrian):** enskilda artister och profiler. Kontakter som berör båda samordnas.

## Mandat
Joseph har självständigt ansvar för E inom överenskomna ramar. Formella och ekonomiska åtaganden hanteras enligt föreningens beslutade ordning. Bando Foundation och Bando Collective är separata verksamheter och samarbeten mellan dem förankras på rätt sätt. AI ingår inga avtal och lovar inga prestationer.

## I HQ
- **Kontakter (avdelning E):** partners med steg i samarbetsprocessen, vad de kan bidra med och ärenden som kräver beslut.
- **Avdelningens AI (Partnership Intelligence):** kartlägger partners och tar fram mötes- och beslutsunderlag.

## Arbetsrytm (förslag, ändra fritt)
- Efter varje samtal: uppdatera steget och nästa steg på partnern.
- Varje vecka: avdelningsuppdateringen och telefonavstämning med William om möjligheter och beslut som behöver förankras.
$b$ where code = 'E' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
F ansvarar för hur Foundation presenteras utåt: identitet, budskap, kommunikationsmaterial, hemsida, marknadsföring och PR. HQ samlar våra officiella material, publiceringar och presentationsunderlag.

## Ansvarig
**Jasmin** ansvarar för F (och för J).

## Arbetsområden
- Planerad kommunikation och publiceringar
- Presentationsmaterial som alla avdelningar använder
- Material från G som ska publiceras
- Bilder och grafiskt material
- Hemsidans innehåll och uppdateringsbehov (bandofoundation.com)
- Kommunikationsuppgifter till andra

## Det gemensamma materialbiblioteket
Färdiga underlag som alla avdelningar kan använda, med tydlig versionshantering så att ingen använder gamla uppgifter av misstag:
- Foundation-presentation
- Behind the Release-presentation
- Material för fritidsgårdar och skolor
- Profilpaket för Adrian
- Informationsmaterial till ungdomar
- Partnerpresentation
- Bidragspresentation
- Officiella logotyper och grafiska resurser
A och E använder godkänt material och kan lyfta behov av förändringar.

## Publiceringsprocessen
Material mottaget → Granskning → Godkänt → Planerat → Publicerat.
Material där nödvändiga tillstånd eller rättigheter saknas stoppas. Inget publiceras utan godkännande. F ansvarar för kommunikationsdelen men gör inte G:s filmproduktion.

## Samarbete
- **G:** redaktionen ansvarar för innehållet, F för hur det publiceras och presenteras.
- **D (Adrian):** stödbilder med Foundation-tröjan kommer som överlämningar till F.
- **A (Joseph):** verksamheter som behöver material.
- **H:** godkända undersökningsresultat och rapporter kommuniceras genom Foundations officiella kanaler.

## I HQ
- **Kommunikation:** materialbiblioteket med versioner och publiceringarna.
- **Avdelningens AI (Communication Assistant):** textutkast, hemsidesinnehåll, publiceringsplaner och korrektur, enligt Foundations identitet. Inget publiceras automatiskt.

## Arbetsrytm (förslag, ändra fritt)
- Varje vecka: gå igenom väntande publiceringar och nytt material från G.
- När något ändras i verksamheten: uppdatera berörda material och ladda upp en ny version.
- Varje vecka: avdelningsuppdateringen.
$b$ where code = 'F' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
G är Bando Foundations kreativa redaktion. Vi producerar innehåll som människor faktiskt vill se: intervjuer, dokumentärer, reportage, kreativa format och innehåll från verksamheten. Vi vill ha ett eget innehåll och en egen publik, inte bara marknadsföra Foundation eller filma workshops.

## Ingen ensam chef
Vi bygger redaktionen tillsammans. Alla har sina områden och levererar inom dem, och alla kan ta initiativ. Det betyder inte att ansvaret är otydligt: varje uppgift har en ansvarig.

## Roller
- **Nanna** – intervjuer och programledning: research, frågor, följdfrågor och intervjuns innehåll, med stöd av Interview Playbook. Bidrar med idéer och återkoppling.
- **D2L** – filmproduktion och redigering: filmning och klippning enligt överenskomna uppdrag. Är med och utvecklar format redan när idéerna formas.
- **Rasmus (RKAY)** – samordning och AI-utveckling: håller ihop det praktiska, ser till att information når rätt personer och att produktionerna går framåt. Bygger researchstödet (Deep Dive).
- **Amir** – struktur och utveckling: enkla sätt att gå från idé till färdigt innehåll, planering och ansvarsfördelning. Ska inte automatiskt bära det kreativa arbetet.
- **Moez och andra kreatörer:** filmare, fotografer, redigerare eller programledare efter behov.

## Våra fyra innehållsområden
1. **Människorna bakom kulturen:** artister, producenter, kreatörer och entreprenörer.
2. **Kultur, bransch & samhälle:** kreativitet, karriärvägar, möjligheter och samhället.
3. **Foundation i verkligheten:** ungdomarna, workshopparna och Behind the Release.
4. **Ungdomarnas perspektiv:** ungdomars egna frågor och tankar.
Innehållet ska vara genuint och genomarbetat. Vi behöver inte få in ett inspirationsbudskap i varje produktion.

## Från idé till färdig produktion
1. **Idé:** någon föreslår en gäst, berättelse eller ett format.
2. **Research:** vi samlar information. Rasmus hjälper med AI-stöd.
3. **Kreativ planering:** Nanna får ett intervjuunderlag och D2L en separat filmbrief.
4. **Produktion:** Nanna intervjuar, D2L filmar.
5. **Redigering och återkoppling:** D2L klipper och teamet ger feedback.
6. **Publicering:** kvalitetssäkras och samordnas med F. Frågetecken om rättigheter löses före publicering.
7. **Utveckling:** vad fungerade och vad gör vi bättre?
Pipelinen i HQ: Idé → Research → Redaktionell planering → Inspelning → Redigering → Granskning → Publicerad.

## Interview Playbook
Gör ordentlig research, hitta en tydlig huvudvinkel, fråga om verkliga händelser och beslut, lyssna och ställ naturliga följdfrågor, var nyfiken, undvik generiska motivationsfrågor och skapa samtal som är intressanta även utan Foundation som avsändare. Playbooken utvecklas tillsammans i takt med erfarenheten.

## Research och AI
Deep Dive ger en källbelagd researchrapport (verifierade fakta, hypoteser och öppna frågor) och en gästversion av Interview Playbook med vinklar och frågor. Nanna kan välja en annan vinkel, redigera och spara den godkända briefen. AI hittar fler möjliga berättelser, men människorna i G väljer vad som berättas. Alla fakta kontrolleras, och privata förhållanden som saknar betydelse kartläggs inte.

## Samarbete
- **D (Adrian):** när en profil vill göra en intervju kommer den som en överlämning till G.
- **C (Amir):** innehåll kring workshopparna, utan att störa verksamheten.
- **B (Samuel):** ungdomars medverkan samordnas med B och är alltid frivillig.
- **F (Jasmin):** publicering och hur materialet presenteras.
- **H:** undersökningsresultat kan bli reportage. H ansvarar för att resultaten beskrivs korrekt.

## Arbetsprinciper
Kreativ frihet, tydligt ansvar, samarbete, kvalitet, utveckling och förtroende. Vi bygger inga hierarkier vi inte behöver. G växer genom människorna som bygger den.

## I HQ
- **Redaktion:** produktioner, intervjubriefer, filmbriefer, Deep Dive och publiceringsstatus.
- **Aktiviteter:** filmplanen när en workshop ska dokumenteras, med vad som inte får filmas.

## Arbetsrytm (förslag, ändra fritt)
- Varje vecka: gå igenom produktionslistan tillsammans. Vem ansvarar för vad och vad är nästa steg?
- Efter varje produktion: kort genomgång av vad som fungerade.
- Varje vecka: Rasmus skriver avdelningsuppdateringen.
$b$ where code = 'G' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
H hjälper oss förstå vad ungdomar tycker, tänker, behöver och drömmer om. Vi utgår inte från vad vuxna tror är viktigt för unga, utan vill höra ungdomarna själva. Tre områden:
1. **Förstå våra egna deltagare:** vad ungdomarna får ut av workshops och program och hur vi blir bättre.
2. **Undersöka unga i hela Sverige:** samhällsundersökningar om åsikter, erfarenheter, intressen och framtid.
3. **Bygga samarbeten och kunskap:** med undersökningsorganisationer, forskare och ungdomsaktörer.

## Ansvarig
Ej tillsatt än. Tills dess följer admin upp avdelningens uppgifter.

## H1 – Ungdomsinsikter inom Foundation
Korta undersökningar och naturlig återkoppling: intressen, vilka yrken de känner till, vad de upptäcker på workshopparna, samarbetet, framtidstro, vad de vill ha mer av och vad vi ska förbättra. Informationen används för att förbättra programmen. C och B får sammanställda resultat.

## H2 – Samhällsundersökningar
Bredare än musik: framtid och karriär, skola och utbildning, trygghet och samhälle, fritid och gemenskap, förebilder och påverkan, kultur, teknik och kreativitet. Även frågor ungdomarna själva lyfter.

## H3 – Samarbeten med undersökningsorganisationer
Möjliga kontakter, inte etablerade samarbeten: Ungdomsbarometern, MUCF, SOM-institutet vid Göteborgs universitet, och forskare inom ungdomsfrågor, sociologi, utbildning och socialt arbete. Vi bidrar med frågor, ungdomsperspektiv och kontakter. En partner bidrar med metod, analys och kapacitet. E (Joseph) hjälper till med större organisationssamarbeten.

## H4 – Nå ungdomar i hela landet
Fritidsgårdar, skolor, föreningar, kommunala initiativ, nationella ungdomsorganisationer och professionella partners. Svar från flera städer betyder inte att undersökningen representerar alla unga i Sverige. Var tydlig med vilka som svarat och vilka slutsatser som håller.

## H5 – Rapporter
Förslag: en återkommande rapportserie, "Ungas perspektiv", om framtiden, karriär och möjligheter, förebilder, fritiden och att bli lyssnad på. Redovisa hur resultaten samlats in och överdriv inte slutsatserna.

## H6 – Effektmätning
Skilj mellan vad vi genomför (workshops, deltagare, projekt), vad ungdomarna upplever, och vad som förändras över tid före och efter Behind the Release. Positiva enkätsvar bevisar inte långsiktiga samhällseffekter.

## Prioriteringar
1. Enkla frågor och metoder för att följa upp workshops och Behind the Release.
2. Kartlägg befintlig kunskap, så att vi inte gör om undersökningar i onödan.
3. Kartlägg samarbetspartners, samarbetsformer och kostnader.
4. En första mindre samhällsundersökning: "Vilka möjligheter ser unga för sin framtid?"
5. En nationell undersökningsmodell när samarbeten och kompetens finns.

## Integritet
Var tydlig med varför en undersökning görs och hur svaren används. När minderåriga deltar behövs rättslig grund, tydlig information och skyddsåtgärder. Samla inte in känsliga uppgifter som inte behövs, och publicera inte resultat från så små grupper att någon kan identifieras. Att svara är frivilligt och påverkar aldrig möjligheten att delta. Undersökningsdata blandas inte med B:s ungdomsregister.

## Samarbete
- **B:** frivillig återkoppling från våra egna ungdomar.
- **C:** använder insikterna för att utveckla workshops.
- **D:** insikter om förebilder och yrkesroller som intresserar ungdomarna.
- **F:** kommunicerar godkända resultat.
- **G:** kan göra reportage utifrån resultaten.
- **I:** kvalitetssäkrade undersökningar och resultat i bidragsansökningar.
- **J:** personuppgifter, avtal och rättigheter.

## I HQ
- **Undersökningar:** alltid anonyma enkäter via länk, utvärderingar och resultat.
- **Avdelningens AI (Youth Insights Research):** tidigare studier, frågeutkast och sammanställningar. AI hittar aldrig på statistik och beskriver inte en liten enkät som representativ.
$b$ where code = 'H' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
I ska ge Foundation en tydlig och realistisk väg till finansiering: vilka pengar som går att söka i dag, vilka vi behöver förbereda oss för och vilka vi kan bli behöriga för i framtiden. Vi behöver inte pengar omedelbart, men vi bygger en finansieringsplan så att vi på sikt kan genomföra större projekt och betala rimliga arvoden. Vi lovar inga arvoden utifrån bidrag vi inte fått.

## Hur arbetet fördelas
- **Rasmus (RKAY)** – system och AI: bygger och utvecklar finansieringsfunktionen och finansieringsagenten, ser till att informationen sparas och kan följas upp. Skriver inte själv alla ansökningar.
- **William** – strategiska prioriteringar: vilka finansieringsspår och projekt vi satsar på.
- **Joseph (E)** – externa relationer: kontakt med finansieringsexperter, partners och organisationer.
- **Jasmin (J)** – ekonomi och administration: budgetar, ekonomiska underlag och föreningens formalia.
- **H** – underlag om ungdomarnas behov och vad insatserna leder till.
- **Avdelningen som ska genomföra projektet** ansvarar för att verksamhetsbeskrivning, omfattning och projektplan är realistiska.
AI hjälper oss att hitta och analysera finansieringen. Människorna i Foundation ansvarar för besluten och genomförandet.

## Vad vi letar efter
- **Offentliga stöd:** kommunala, regionala och statliga bidrag, kultur- och ungdomsstöd, sociala och brottsförebyggande projektstöd, utbildningsstöd, nordiska och EU-program.
- **Privata finansiärer:** stiftelser, fonder, företagsstiftelser, donationer, företag med samhällsengagemang, sponsring.
- **Samarbeten som ger resurser:** lokaler, utrustning, kompetens. Hålls isär från rena kontantbidrag.

## Så granskas varje bidrag
1. Identifiera stödet: namn, finansiär, officiell källa och status.
2. Verifiera reglerna: deadlines, behörighet, organisationsålder, geografi, målgrupp, belopp, godkända kostnader, dokument och återrapportering.
3. Bedöm behörigheten: sökbart nu, förberedelse krävs eller inte behörig än.
4. Undersök tidigare mottagare med källor. Hitta inte på något.
5. Föreslå 2–4 sanningsenliga projektvinklar utifrån vår faktiska verksamhet.
6. Prioritera efter behörighet, relevans, potential, tidskritikalitet och arbetsbörda.
7. Föreslå konkreta nästa steg.
Vi anpassar hur vi beskriver våra verkliga projekt efter finansiärens syfte, men hittar aldrig på verksamhet, målgrupper eller samarbeten för att passa ett bidrag.

## Regler
- Verifiera mot officiella källor och ange när informationen kontrollerades.
- Skilj mellan fakta, tolkning och rekommendation.
- Håll isär Bando Foundation och Bando Collective. Uppmärksamma jäv, närståendetransaktioner och dubbelfinansiering.
- Inga ansökningar, mejl eller erbjudanden skickas automatiskt.
- Datum och villkor från första rapporten (2 november 2026) kontrolleras på nytt innan de används i en verklig ansökan.

## Läget nu
En veckovis AI-bevakning är redan igång (måndagsbevakningen) och dess rapporter förs in i HQ. Första rapporten lyfte bland annat Region Stockholm (projektstöd kultur), Postkodlotteriets Stiftelse, Skandias Idéer för livet, Gålöstiftelsen och Allmänna arvsfonden. Finansieringsagenten är byggd och kopplas in när Claude API-nyckeln är på plats.

## I HQ
- **Finansiering:** bidrag med status, deadlines, belopp, behörighet, analyser, projektvinklar, tidigare mottagare och nästa steg. Påminnelser 14, 7 och 3 dagar före deadline.
- **Avdelningens AI (Funding Intelligence):** deep dives på bidrag och import av veckorapporten.

## Arbetsrytm (förslag, ändra fritt)
- Varje måndag: för in veckobevakningen och uppdatera befintliga bidragsposter.
- Varje vecka: gå igenom bidrag med deadline inom en månad och bestäm vem som gör vad.
- Löpande: prioriteringarna stäms av med William.
$b$ where code = 'I' and brief = '';

update fd_departments set brief = $b$
## Uppdraget
J är Foundations administrativa och ekonomiska funktion: administrativa rutiner, dokumentation, budgetarbete, ekonomisk uppföljning och avtalshantering. Vi håller J enkelt i början och bygger fler funktioner när verksamheten och finansieringen kräver det.

## Ansvarig
**Jasmin** ansvarar för J (och för F).

## Det J håller ordning på
- Föreningsdokument och stadgar
- Styrelsehandlingar och protokoll
- Firmateckningshandlingar
- Avtal med leverantörer
- Projektbudgetar och fakturaunderlag
- Bidragsbeslut och återrapporteringar
- Kommande administrativa deadlines
- Underlag som andra avdelningar lämnat in
- Ärenden som kräver godkännande
HQ är inte vårt bokföringssystem. Originalhandlingar lagras säkert eller länkas från behöriga dokumenttjänster.

## Ärenden till J
När en annan avdelning behöver ett avtal, ett ekonomiskt underlag eller en administrativ kontroll skickar den en överlämning till J. Markera vad som är klart och vad som saknas.

## Regler
- Ekonomiska och bindande åtaganden kräver beslut av behöriga företrädare.
- Om Foundation köper tjänster eller hyr resurser av Bando Collective ska avtal, prissättning och eventuella jävsfrågor hanteras korrekt. Foundation och Collective är separata verksamheter.

## Samarbete
- **I:** budgetar, ekonomiska underlag och formalia till bidragsansökningar.
- **B och H:** personuppgifter, integritet och rutiner.
- **E:** avtal när ett partnerskap blir en överenskommelse.

## I HQ
- **Administration:** arkiv för föreningsdokument, viktiga datum med påminnelser och ärenden.
- **Veckorapporten:** admin får varje måndag en sammanställning av hela Foundation.
- **Avdelningens AI (Administration Assistant):** checklistor och översikter. Ger inga slutliga juridiska eller skattemässiga besked.

## Arbetsrytm (förslag, ändra fritt)
- Varje vecka: gå igenom öppna ärenden till J och kommande datum.
- Efter varje styrelsemöte: ladda upp protokollet i arkivet.
- Varje vecka: avdelningsuppdateringen.
$b$ where code = 'J' and brief = '';

-- ---------------------------------------------------------------------
--  STARTUPPGIFTER (seed_for: 'chief', ett medlems-id eller ett förnamn; tomt = avdelningen tar den)
-- ---------------------------------------------------------------------
insert into fd_tasks (seed, dept, seed_for, title, description, due, created_by)
select s.seed, s.dept, s.seed_for, s.title, s.description, s.due::date, (select id from members where id = 'rkay')
from (values
 -- A · Joseph
 ('brief:A:01','A','chief','Läs avdelningens brief','Briefen för A beskriver hela uppdraget: arbetsområdena A1–A8, vägen från kontakt till deltagande, överlämningarna och mandatet. Läs den och säg till om något saknas eller ska ändras. Du kan själv redigera briefen.','2026-12-01'),
 ('brief:A:02','A','chief','Lägg in de befintliga kontakterna i HQ','A7: lägg in den grundläggande kartläggningen av fritidsgårdar och de tre fritidsgårdar som fått mejl under Kontakter (avdelning A), med kontaktperson, område, status och nästa steg.','2026-12-02'),
 ('brief:A:03','A','chief','Följ upp de tre fritidsgårdarna som fått mejl','A2: ingen ordentlig dialog har kommit igång än. Ring eller mejla ansvarig person, presentera Foundation och Behind the Release och försök boka ett möte eller besök. Skriv resultatet och nästa steg på kontakten.','2026-12-04'),
 ('brief:A:04','A','chief','Gå igenom outreach-materialet','A3: organisationspresentationen, Behind the Release-presentationen, broschyren, samtalsmanuset och standardmejlen. Behöver något ändras eller saknas något lämnar du en överlämning till F (Jasmin).','2026-12-09'),
 ('brief:A:05','A','chief','Bredda kartläggningen till HVB, skolor och föreningar','A1 och A5: identifiera fler ungdomsverksamheter och rätt kontaktpersoner. Lägg in dem som kontakter så att vi ser vilka som kontaktats.','2026-12-11'),
 ('brief:A:06','A','chief','Planera det första verksamhetsbesöket','A4: utgå från det planerade upplägget för verksamhetsbesök. Vill verksamheten ha en workshop skickar du en överlämning till C (Amir) med önskemål, datum och praktiska förutsättningar.','2026-12-18'),
 ('brief:A:07','A','chief','Formulera avdelningens outreachstrategi','A8: prioriteringar och inriktning för A de närmaste månaderna. Stäm av med William.','2026-12-18'),
 ('brief:A:08','A','chief','Skriv A:s första avdelningsuppdatering','Under Avdelningar → A → Uppdatera: vad ni arbetar med nu, vad som nyligen är klart, vad ni behöver hjälp med och vad ni väntar på.','2026-12-02'),
 -- E · Joseph
 ('brief:E:01','E','chief','Läs avdelningens brief','Briefen för E beskriver uppdraget, E1–E5, samarbetsprocessen och skillnaden mot A.','2026-12-01'),
 ('brief:E:02','E','chief','Gå igenom befintliga nätverk och tidigare kontakter','Bland annat personer med koppling till Jobyard, Changers Hub och Bando Collectives kreativa nätverk. Be om kontakthistoriken och bedöm vilka relationer som är aktuella att utveckla. Kontakterna räknas inte automatiskt som etablerade partners.','2026-12-09'),
 ('brief:E:03','E','chief','Kartlägg potentiella partners','E1: företag, organisationer, kommuner och branschaktörer som kan bidra med lokaler, utrustning, kompetens, mentorskap eller projekt. Lägg in dem under Kontakter (avdelning E) i steget Identifierad.','2026-12-11'),
 ('brief:E:04','E','chief','Ta första kontakt med de partners du prioriterar','E2: presentera Foundation och undersök möjliga samarbetsområden. Innan ett samarbete innebär åtaganden involveras berörda avdelningar och beslutsfattare (E4).',null),
 ('brief:E:05','E','chief','Stöd H med kontakter till undersökningsorganisationer','H vill undersöka samarbeten med bland andra Ungdomsbarometern, MUCF, SOM-institutet och forskare. E kan hjälpa till med relationsarbetet. H ansvarar för innehåll och metod.',null),
 ('brief:E:06','E','chief','Stöd I med kontakter till finansiärer och bidragsexperter','När en finansieringsmöjlighet kräver externa kontakter kan E ta relationsarbetet.',null),
 ('brief:E:07','E','chief','Skriv E:s första avdelningsuppdatering','Under Avdelningar → E → Uppdatera.','2026-12-02'),
 -- B · Samuel
 ('brief:B:01','B','chief','Läs avdelningens brief','Briefen för B beskriver ansökningsprocessen, vilka ungdomar vi söker, samtalsstödet, SMS, gruppplaneringen med C och trygghetsansvaret.','2026-12-01'),
 ('brief:B:02','B','chief','Gå igenom SMS-mallarna','Under Ungdomar finns mallarna för första kontakt, inbjudan, påminnelse och uppföljning. Justera dem till ditt sätt att skriva. Alla SMS ska visa Samuel, Bando Foundation och BandoFoundation.com.','2026-12-01'),
 ('brief:B:03','B','chief','Kontakta alla sökande som inte kontaktats än','Under Ungdomar: ring eller sms:a, presentera programmet, skriv en kort anteckning och flytta statusen till Kontaktad eller Samtal genomfört.','2026-12-02'),
 ('brief:B:04','B','chief','Bekräfta deltagarna till workshopen 5 december','Gå igenom gruppen med Amir, skicka inbjudan till dem som ska med och följ vem som tackat ja, nej eller inte svarat. Påminnelse dagen innan.','2026-12-03'),
 ('brief:B:05','B','chief','Följ upp efter workshopen 5 december','Uppföljnings-SMS till deltagarna och för in C:s observationer i urvalsunderlaget.','2026-12-08'),
 ('brief:B:06','B','chief','Fastställ urvalskriterierna tillsammans med C','Urvalet till de 40 platserna ska utgå från gemensamma, fastställda kriterier: driv, engagemang, egna idéer, personlighet, nyfikenhet och samarbetsförmåga. Skriv ner hur de används och vilka som fattar det slutliga beslutet.','2026-12-18'),
 ('brief:B:07','B','chief','Rutin för vårdnadshavare och trygghet','Tillsammans med J: när vårdnadshavare involveras, vilka kontaktvägar som är godkända och vilka uppgifter vi samlar in.',null),
 ('brief:B:08','B','chief','Skriv B:s första avdelningsuppdatering','Under Avdelningar → B → Uppdatera.','2026-12-02'),
 -- C · Amir
 ('brief:C:01','C','chief','Läs avdelningens brief','Briefen för C beskriver grundmodellen (en dag, ett projekt), koncepten 01–07, de fem frågorna för nya workshops och hur workshopparna ingår i urvalet.','2026-12-01'),
 ('brief:C:02','C','chief','Färdigställ workshopen 5 december','På aktivitetssidan: vilket koncept, upplägg och arbetsprocess, workshopledare från nätverket, utrustning och lokal. Bekräfta gruppen med Samuel.','2026-12-02'),
 ('brief:C:03','C','chief','Bestäm om workshopen 5 december ska dokumenteras','Ingen dokumentation, begränsad eller redaktionell produktion. Ska den filmas fyller du i filmplanen och G får en överlämning med vad som ska och inte ska filmas.','2026-12-02'),
 ('brief:C:04','C','chief','Lämna observationer till B efter workshopen','Sakliga observationer om vad deltagarna gjorde och bidrog med, som stöd för urvalet. Ladda upp resultatet och skriv en kort utvärdering på aktiviteten.','2026-12-08'),
 ('brief:C:05','C','chief','Lägg en plan för de första workshopparna','Vilka av koncepten 01–07 som körs när, vem som leder och vad som behövs. Lägg in dem som aktiviteter så att Samuel kan planera inbjudningarna.','2026-12-18'),
 ('brief:C:06','C','chief','Skicka aktivitets- och resursunderlag till I','I kan använda verkliga projektplaner och resursbehov i bidragsansökningar.',null),
 ('brief:C:07','C','chief','Skriv C:s första avdelningsuppdatering','Under Avdelningar → C → Uppdatera.','2026-12-02'),
 -- D · Adrian
 ('brief:D:01','D','chief','Läs avdelningens brief','Briefen för D beskriver varför vi vill ha med artister och profiler, de fyra sätten att vara med och hur du förklarar projektet.','2026-12-01'),
 ('brief:D:02','D','chief','Gå igenom hemsidan och den digitala presentationen','Du ska kunna visa dem när någon vill veta mer. Saknas något ber du F (Jasmin) om profilpaketet.','2026-12-04'),
 ('brief:D:03','D','chief','Lista artister och profiler du vill träffa','Lägg in dem under Kontakter (avdelning D).','2026-12-09'),
 ('brief:D:04','D','chief','Registrera varje möte och lämna över de intresserade','Skriv in vem du träffat och vad de är intresserade av. Stöd → F, intervju → G, workshop eller mentorskap → C.',null),
 ('brief:D:05','D','chief','Skriv D:s första avdelningsuppdatering','Under Avdelningar → D → Uppdatera.','2026-12-02'),
 -- F · Jasmin
 ('brief:F:01','F','chief','Läs avdelningens brief','Briefen för F beskriver materialbiblioteket, publiceringsprocessen och samarbetet med G.','2026-12-01'),
 ('brief:F:02','F','chief','Bygg upp materialbiblioteket','Under Kommunikation: Foundation-presentation, Behind the Release-presentation, material för fritidsgårdar och skolor, information till ungdomar, partnerpresentation, bidragspresentation, logotyper och grafiska resurser. Ladda upp den gällande versionen av varje.','2026-12-11'),
 ('brief:F:03','F','chief','Ta fram profilpaketet till Adrian','Det Adrian visar för artister och profiler som vill veta mer.','2026-12-09'),
 ('brief:F:04','F','chief','Gå igenom hemsidans innehåll','Vad på bandofoundation.com behöver uppdateras? Lägg in det som uppgifter.','2026-12-18'),
 ('brief:F:05','F','chief','Sätt publiceringsprocessen med G','Material mottaget → Granskning → Godkänt → Planerat → Publicerat. Inget publiceras utan godkännande och nödvändiga tillstånd.',null),
 ('brief:F:06','F','chief','Skriv F:s första avdelningsuppdatering','Under Avdelningar → F → Uppdatera.','2026-12-02'),
 -- J · Jasmin
 ('brief:J:01','J','chief','Läs avdelningens brief','Briefen för J beskriver vad J håller ordning på och hur ärenden kommer in.','2026-12-01'),
 ('brief:J:02','J','chief','Ladda upp föreningsdokumenten','Under Administration: stadgar, styrelseprotokoll och firmateckningshandlingar.','2026-12-11'),
 ('brief:J:03','J','chief','Lägg in föreningens administrativa deadlines','Under Administration → viktiga datum, så att påminnelserna går ut i tid.','2026-12-11'),
 ('brief:J:04','J','chief','Rutin för avtal och jäv med Bando Collective','Om Foundation köper tjänster eller hyr resurser av Bando Collective ska avtal, prissättning och jävsfrågor hanteras korrekt.',null),
 ('brief:J:05','J','chief','Skriv J:s första avdelningsuppdatering','Under Avdelningar → J → Uppdatera.','2026-12-02'),
 -- G · redaktionen
 ('brief:G:01','G','Nanna','Läs redaktionens brief','Briefen för G beskriver roller, de fyra innehållsområdena, vägen från idé till produktion och Interview Playbook.','2026-12-01'),
 ('brief:G:02','G','Nanna','Föreslå de första gästerna och ämnena','Lägg in dem som idéer under Redaktion. Kom ihåg att det kan vara gäster, ämnen eller format.','2026-12-09'),
 ('brief:G:03','G','Nanna','Gå igenom Interview Playbook med teamet','Vad fungerar och vad vill du utveckla?',null),
 ('brief:G:04','G',null,'D2L: föreslå format och visuella idéer','Hur kan de första produktionerna berättas visuellt? D2L är med redan när idéerna formas. Den i redaktionen som jobbar med D2L tar uppgiften.',null),
 ('brief:G:05','G','rkay','Lägg in produktionslistan och fördela ansvar','Under Redaktion: de idéer som finns, vem som ansvarar för research, inspelning och klippning, och nästa steg.','2026-12-04'),
 ('brief:G:06','G','rkay','Koppla in Deep Dive när Claude API-nyckeln finns','Lägg in nyckeln, slå på AI under Admin → AI och gör en första körning på en testprofil.',null),
 ('brief:G:07','G','rkay','Skriv G:s första avdelningsuppdatering','Under Avdelningar → G → Uppdatera.','2026-12-02'),
 ('brief:G:08','G','Amir','Föreslå en enkel arbetsstruktur för G','Hur går vi från idé till färdigt innehåll, vem ansvarar för vad och hur samarbetar G med övriga Foundation?','2026-12-18'),
 -- H · ej tillsatt
 ('brief:H:01','H','chief','Läs avdelningens brief','Briefen för H beskriver H1–H6, prioriteringarna och integritetsreglerna.',null),
 ('brief:H:02','H','chief','Utvärdering efter workshopparna','Prioritet 1: korta, anonyma frågor efter varje workshop (vad tyckte du, vad lärde du dig, upptäckte du något nytt, vad vill du göra mer av). Skapa enkäten under Undersökningar.','2026-12-04'),
 ('brief:H:03','H','chief','Kartlägg befintlig kunskap om ungdomar','Prioritet 2: rapporter och studier om ungas framtid, karriärval, fritid, trygghet och möjligheter, så att vi inte gör om undersökningar i onödan.',null),
 ('brief:H:04','H','chief','Kartlägg möjliga undersökningspartners','Prioritet 3: Ungdomsbarometern, MUCF, SOM-institutet och forskare. Möjliga samarbetsformer, kostnader och vad vi kan bidra med. E (Joseph) hjälper med större samarbeten.',null),
 ('brief:H:05','H','chief','Planera den första samhällsundersökningen','Prioritet 4: "Vilka möjligheter ser unga för sin framtid?" Börja med en mindre studie och redovisa tydligt vilka som deltagit.',null),
 -- I · finansiering
 ('brief:I:01','I','rkay','Kontrollera bidragen från rapporten 2 november','Region Stockholm (projektstöd kultur), Postkodlotteriets Stiftelse, Skandias Idéer för livet, Gålöstiftelsen och Allmänna arvsfonden ska finnas under Finansiering med källor, villkor och nästa steg. Datum och villkor kontrolleras på nytt innan de används i en ansökan.','2026-12-04'),
 ('brief:I:02','I','rkay','Gå igenom finansieringsprioriteringarna med William','Vilka finansieringsspår och projekt Foundation ska satsa på först.','2026-12-11'),
 ('brief:I:03','I','rkay','Koppla in finansieringsagenten när Claude API-nyckeln finns','Deep dives på bidrag och automatisk import av veckorapporten.',null),
 ('brief:I:04','I','chief','Kartlägg bidragsexperter och konsulter','Dokumenterad erfarenhet, specialisering, kontaktvägar och betalningsmodeller. E kan ta kontakten.',null)
) as s(seed, dept, seed_for, title, description, due)
on conflict (seed) where seed is not null do nothing;

/* De som redan är med (till exempel RKAY i G och I) får sina startuppgifter direkt. */
select fd_assign_seeded(member_id, dept) from fd_memberships;
