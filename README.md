# BANDOHQ

Bando Collectives studioapp — schema, agenda, beats, galleri, artister, studiecirklar och kunder.

- **Appen:** `index.html` + `sw.js`, `manifest.webmanifest` och ikonerna (behövs för push och hemskärmen).
  Publiceras med GitHub Pages direkt från roten.
- **Databasen:** `db/` (Supabase: schema, behörigheter, funktioner, notiser).
- **Notiser:** `supabase/functions/notify-send` — push först, SMS via 46elks som reserv.
- **Sätta upp:** se `SETUP.md`. **Tester:** se `test/README.md`.

Utan Supabase-uppgifter i `index.html` körs appen i förhandsläge (välj konto, allt sparas lokalt).
