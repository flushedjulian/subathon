# LetsHugoTV Subathon – Chat-Statistiken

Inoffizielles Fanprojekt von flushedjulian.
Website: https://flushedjulian.github.io/subathon/

## So funktioniert's

Es läuft nichts dauerhaft. Eine GitHub Action macht stündlich Folgendes:

1. Sie holt die aktuellen Emote-Listen (7TV, BTTV, FFZ) und merkt sich, welche Emotes dazukommen oder verschwinden (`data/emotes.json`).
2. Sie holt die Chat-Logs der Subathon-Tage aus öffentlichen Archiven (logs.ivr.fi, logs.zonian.dev, logs.susgee.dev)
   und fasst jeden Tag zu Zahlen zusammen (`data/days/JJJJ-MM-TT.json`).
   - Für den laufenden Tag fragt sie nur das Hauptarchiv ab.
   - Ein abgeschlossener Tag wird einmal aus allen drei Archiven zusammengeführt und danach nicht mehr abgerufen.
3. Sie schreibt `public/stats.json` und lädt die Bilder der Top-Emotes nach `public/emotes/`.
4. Sie veröffentlicht `public/` auf GitHub Pages.

Nachrichtentexte werden nicht gespeichert, nur Zahlen und Usernamen für die Ranglisten.

## Einstellungen

Alles steht in `src/config.js`:
- `start` / `end`: Zeitraum des Subathons
- `bots`: werden komplett ignoriert
- `optout`: tauchen in keiner Rangliste auf

Nach einer Änderung von `start`, `bots` oder der Emote-Erkennung die betroffenen Dateien in `data/days/` löschen, damit sie neu berechnet werden.

## Lokal

```bash
npm run build     # Daten holen und stats.json bauen
npm run preview   # Website auf http://localhost:8765
```
