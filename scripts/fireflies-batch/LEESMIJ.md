# Voicememo's laten transcriberen met Fireflies

Dit script uploadt je voicememo's (.m4a) één voor één naar Fireflies, houdt bij wat er al gedaan is en schrijft de transcripten als tekstbestanden weg. Je kunt het zonder zorgen onderbreken (Ctrl+C) of opnieuw starten: wat al gelukt is, wordt nooit dubbel geüpload.

## Voorbereiding

1. Open Terminal.
2. Ga naar de Werkplaats-map:

   ```
   cd "/Users/dwf/Reforge DWF Config/Werkplaats"
   ```
3. Zorg dat de OneDrive-map met de audio volledig is gesynchroniseerd (bestanden niet "alleen online").
4. Je hebt een Fireflies API-sleutel nodig en een betaald Fireflies-abonnement (met het gratis abonnement kan er niet geüpload worden). Het script vraagt om de sleutel zodra het nodig is. Je plakt hem, je ziet niets verschijnen, en je drukt op Enter. De sleutel wordt nergens opgeslagen.

Het script zoekt de audiomap zelf (`OneDrive.../AI Config Oud/Dictafoon/audio`). Lukt dat niet, voeg dan toe: `--bron "/pad/naar/de/audiomap"`. De transcripten komen standaard in een map `transcripten` naast de audiomap; kies zelf een map met `--uit "/pad"`.

## De commando's

Elk commando begint met `node scripts/fireflies-batch/fireflies-batch.mjs`. Hieronder staat alleen het laatste deel.

### 1. `telling` — eerst kijken wat er ligt

```
node scripts/fireflies-batch/fireflies-batch.mjs telling
```

Doet niets met internet en schrijft niets. Toont het aantal bestanden, de totale grootte, de totale duur, hoeveel dagen je nodig hebt (maximaal 50 uploads per dag), hoeveel minuten dat is tegenover de 3.000 minuten per maand en wat het ongeveer kost als je alles in één maand doet. Bestanden kleiner dan 100 KB worden overgeslagen en apart genoemd. Het duurt iets langer omdat de duur van elk bestand wordt uitgelezen; met `--zonder-duur` gaat het sneller.

### 2. `upload` — uploaden

Test eerst met één bestand:

```
node scripts/fireflies-batch/fireflies-batch.mjs upload --alleen "Nieuwe opname 191.m4a"
```

Gaat dat goed, dan alles in één keer (het script stopt zelf bij 50 per dag):

```
node scripts/fireflies-batch/fireflies-batch.mjs upload
```

Het script geeft per bestand één regel. Bij elke start gaat het eerst na of een bestand al in Fireflies staat (op titel); zo ja, dan wordt het niet nog eens geüpload. Verder kun je meegeven:

- `--max 20` — maximaal 20 nieuwe uploads in deze run.
- `--maand-limiet 3000` — stop voordat je boven dit aantal minuten in de kalendermaand komt (standaard 3000; `0` = geen limiet, dan betaal je de meerkosten). Dit is een benadering: het script telt alleen zijn eigen uploads en rekent per kalendermaand, terwijl Fireflies ook andere uploads meetelt en per factuurperiode kan rekenen.

Elke dag (UTC-dag, dus vanaf 01:00 of 02:00 's nachts Nederlandse tijd) kun je opnieuw tot 50 bestanden uploaden. Start het commando gewoon de volgende dag opnieuw; het gaat verder waar het gebleven was. Het script meldt zelf vanaf welk moment het weer kan.

### 3. `ophalen` — transcripten binnenhalen

Fireflies heeft even nodig om te transcriberen. Draai dit later (of herhaaldelijk):

```
node scripts/fireflies-batch/fireflies-batch.mjs ophalen
```

Voor elk bestand waarvan het transcript klaar is, komt een `.txt` in de transcripten-map (met titel, datum, duur, link en de tekst met tijdstippen). Nog niet klaar? Dan blijft het staan en pak je het de volgende keer mee. Bestaat er al een `.txt` met dezelfde naam dat niet van het script is, dan wordt die nooit overschreven; je krijgt een waarschuwing.

### 4. `status` — hoe staat het ervoor

```
node scripts/fireflies-batch/fireflies-batch.mjs status
```

Geen internet. Toont hoeveel bestanden in welke fase zitten, welke bestanden aandacht nodig hebben en wat de volgende stap is.

### 5. `opnieuw` — één bestand terugzetten

```
node scripts/fireflies-batch/fireflies-batch.mjs opnieuw "Nieuwe opname 191.m4a"
```

Alleen gebruiken nadat je in Fireflies hebt gecontroleerd dat het bestand daar niet staat (of dat je het bewust nog eens wilt). Het script vraagt om bevestiging (`j` of `n`).

## Wat doe ik als er iets misgaat?

- **Het scherm sluit, de computer valt uit, internet valt weg, of je drukt Ctrl+C:** niets aan de hand. Start hetzelfde commando opnieuw. Het script ziet wat al klaar is en maakt af wat half was.
- **"Er draait al een ander proces":** je hebt het script nog een keer open staan. Wacht tot het klaar is of sluit dat venster. Na een crash ruimt het script zelf een oud slotbestand op.
- **"Daglimiet bereikt" of "te veel verzoeken":** Fireflies laat per dag maar 50 uploads toe. Er staat bij vanaf wanneer het weer kan. Start het commando dan opnieuw.
- **"Maandlimiet bereikt":** de 3.000 minuten van deze maand zijn bijna op. Wacht tot de volgende maand, of start met `--maand-limiet 0` als je de extra kosten ($0,01 per minuut) accepteert.
- **Abonnement of beheerder ("paid_required", "uitgezet"):** met het gratis abonnement of als een beheerder uploads heeft uitgezet kan het niet. Pas dat in Fireflies aan en start opnieuw.
- **Bestand met status `fout`:** dit bestand is geweigerd en wordt de volgende keren overgeslagen. Lees met `status` wat Fireflies zei. Wil je het toch nog eens proberen, gebruik dan `opnieuw`.
- **Bestand met status `controleren`:** het script weet niet zeker of het bestand in Fireflies staat. Zoek het in Fireflies op titel. Staat het er, dan hoef je niets te doen (of haal het transcript daar zelf op). Staat het er niet, gebruik dan `opnieuw` en daarna `upload`. Het script gokt hier bewust niet, om dubbele uploads te voorkomen.
- **Bestand is veranderd sinds de upload:** je krijgt een waarschuwing en het wordt niet opnieuw geüpload. Gebruik `opnieuw` als je dat wel wilt.
- **Iets onverwachts:** stuur de melding (zonder je sleutel, die staat er nooit in) en de uitvoer van `status` door.

## Wat staat waar

- Voortgang: `fireflies-voortgang.json` in de transcripten-map. Niet verwijderen of bewerken; daarmee weet het script wat er al gedaan is.
- Transcripten: `<naam van het bestand>.txt` in de transcripten-map.
- Audio, voortgang en transcripten staan in `.gitignore` en komen nooit in git.
