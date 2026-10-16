# QR-koden till Bando HQ Access

Koden leder alltid till **https://www.bandohq.se/access**. Adressen ändras aldrig, så tryckta
skyltar och affischer fungerar för all framtid. Det som står på sidan (inriktningar, förmåner,
priser) ändras i appen under Mer → Rewards → Access, inte i koden.

| Fil | Till |
|---|---|
| `bando-hq-access-qr.svg` | tryck, svart på vitt. Vektor, så den kan skalas till valfri storlek |
| `bando-hq-access-qr.png` | tryck, svart på vitt, 2050 × 2050 px |
| `bando-hq-access-qr-rosa.svg` / `.png` | skärm och sociala medier, rosa på svart |
| `bando-hq-access-affisch-a5.pdf` | A5-affischen till studion, skrivs ut i 100 % |
| `bando-hq-access-affisch-a5.png` | samma affisch som bild, 300 dpi |
| `bando-hq-access-dela.png` | delningsbilden (1200 × 630), visas när länken delas |

Felkorrigeringen är högsta nivån (H): koden går att läsa även om upp till 30 % är skadat eller
täckt. Alla fyra varianterna är kontrollerade med en QR-läsare.

**Tips:** skriv ut koden minst 3 × 3 cm och låt den vita kanten runt den vara kvar. Den rosa
varianten läses av iPhone-kameran och Google Lens, men svart på vitt är säkrast i tryck.

## Göra om filerna

QR-koderna (kräver `segno`, `pip3 install --target ~/.cache/bandohq-tools segno`):

```
PYTHONPATH=~/.cache/bandohq-tools python3 -c "import segno; q=segno.make('https://www.bandohq.se/access', error='h');
q.save('bando-hq-access-qr.svg', scale=10, border=4); q.save('bando-hq-access-qr.png', scale=50, border=4)"
```

Affischen och delningsbilden ritas från `affisch.html` (servera repot med `python3 -m http.server 8798`):

```
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --no-pdf-header-footer --virtual-time-budget=4000 --print-to-pdf=qr/bando-hq-access-affisch-a5.pdf http://127.0.0.1:8798/qr/affisch.html
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=3.125 --window-size=559,794 --virtual-time-budget=4000 --screenshot=qr/bando-hq-access-affisch-a5.png http://127.0.0.1:8798/qr/affisch.html
"$CHROME" --headless=new --hide-scrollbars --window-size=1200,630 --virtual-time-budget=4000 --screenshot=qr/bando-hq-access-dela.png "http://127.0.0.1:8798/qr/affisch.html?dela=1"
```
