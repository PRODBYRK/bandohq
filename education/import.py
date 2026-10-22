#!/usr/bin/env python3
"""Bando Education: kontrollerar läroplansbanken och skriver databasens katalog.

    python3 education/import.py

Källan är education/laroplaner.json (filen från Bando, oförändrad). Skriptet stoppar om något
inte stämmer med kraven — 18 ämnesområden, 200 unika koder, exakt sex perioder i rätt ordning,
mål/arbete/delresultat i varje period, ett slutprojekt och SV-arbetsplanens sex fält — och
skriver sedan db/06-education-katalog.sql. Den filen är idempotent (upsert på koden): att köra
den igen skapar inga dubbletter, och en kod som tagits bort ur banken markeras inaktiv i stället
för att raderas (tilldelningar pekar på den). Själva innehållet läser appen ur JSON-filen.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'education', 'laroplaner.json')
OUT = os.path.join(ROOT, 'db', '06-education-katalog.sql')
PHASES = ['Introduktion', 'Grunder & teknik', 'Idé & planering', 'Praktiskt skapande',
          'Fördjupning & förbättring', 'Slutprojekt & presentation']
SV_KEYS = ['period', 'mal', 'hur', 'material', 'delaktighet', 'utvardering']


def fail(msg):
    print('✗ ' + msg); sys.exit(1)


def check(d):
    cats, items = d.get('amnesomraden') or [], d.get('laroplaner') or []
    if len(cats) != 18: fail(f'{len(cats)} ämnesområden, inte 18')
    if len(items) != 200: fail(f'{len(items)} läroplaner, inte 200')
    codes = [x.get('kod') for x in items]
    if len(set(codes)) != 200: fail('koderna är inte unika')
    cat = {c['kod']: c for c in cats}
    for x in items:
        k = x.get('kod', '?')
        if not re.fullmatch(r'[A-Z]{2}[0-9]{2}', k or ''): fail(f'{k}: koden ska vara två bokstäver och två siffror')
        if x.get('amneskod') not in cat: fail(f'{k}: okänt ämnesområde {x.get("amneskod")}')
        if not (x.get('namn') or '').strip(): fail(f'{k}: saknar namn')
        if not (x.get('slutprojekt') or '').strip(): fail(f'{k}: saknar slutprojekt')
        ps = x.get('perioder') or []
        if [p.get('nummer') for p in ps] != [1, 2, 3, 4, 5, 6]: fail(f'{k}: perioderna är inte 1–6')
        if [p.get('fas') for p in ps] != PHASES: fail(f'{k}: perioderna följer inte de sex stegen')
        for p in ps:
            if not all((p.get(f) or '').strip() for f in ('mal', 'arbete', 'delresultat')):
                fail(f'{k}: månad {p.get("nummer")} saknar mål, arbete eller delresultat')
        sv = x.get('sv_arbetsplan_mall') or {}
        if list(sv.keys()) != SV_KEYS: fail(f'{k}: SV-arbetsplanen har inte de sex fälten')
    n = {c: sum(1 for x in items if x['amneskod'] == c) for c in cat}
    for c, v in cat.items():
        if n[c] != v.get('antal_laroplaner'): fail(f'{c}: {n[c]} läroplaner, katalogen säger {v.get("antal_laroplaner")}')
    return cats, items


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    d = json.load(open(SRC, encoding='utf-8'))
    cats, items = check(d)
    cname = {c['kod']: c['namn'] for c in cats}
    ver = d.get('version', '')
    rows = ',\n'.join(f"  ({lit(x['kod'])}, {lit(x['namn'])}, {lit(x['amneskod'])}, {lit(cname[x['amneskod']])}, {i + 1}, {lit(ver)})"
                      for i, x in enumerate(items))
    sql = f"""-- =====================================================================
--  BANDO EDUCATION — läroplansbankens koder ({len(items)} st, {len(cats)} ämnesområden, version {ver})
--  GENERERAD av education/import.py från education/laroplaner.json. Ändra inte för hand:
--  byt JSON-filen och kör skriptet igen. Idempotent — samma kod skrivs över, aldrig dubbletter.
-- =====================================================================
insert into education_curricula (code, name, category_code, category_name, sort, version) values
{rows}
on conflict (code) do update set name = excluded.name, category_code = excluded.category_code,
  category_name = excluded.category_name, sort = excluded.sort, version = excluded.version, active = true
where (education_curricula.name, education_curricula.category_code, education_curricula.category_name,
       education_curricula.sort, education_curricula.version, education_curricula.active)
  is distinct from (excluded.name, excluded.category_code, excluded.category_name, excluded.sort, excluded.version, true);
/* koder som inte längre finns i banken: inaktiva (befintliga tilldelningar finns kvar) */
update education_curricula set active = false
 where active and code not in ({', '.join(lit(x['kod']) for x in items)});
"""
    open(OUT, 'w', encoding='utf-8').write(sql)
    print(f'✓ {len(cats)} ämnesområden, {len(items)} läroplaner, alla med sex perioder → db/06-education-katalog.sql')


if __name__ == '__main__':
    main()
