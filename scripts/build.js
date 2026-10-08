// Wird von der GitHub Action ausgeführt (lokal: npm run build)
// 1. Emote-Listen abrufen und Verlauf aktualisieren
// 2. Chat-Logs der Subathon-Tage aus den Archiven holen und pro Tag zusammenfassen
// 3. public/stats.json für die Website schreiben
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { parseLine } from '../src/irc.js';
import { fetchDay } from '../src/archives.js';
import { aggregateDay, lineKey } from '../src/aggregate.js';
import { buildEmoteMap, emoteImageUrl, fetchThirdPartyEmotes } from '../src/emotes.js';
import { buildStats } from '../src/merge.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const DAYS_DIR = root('data/days');
const HISTORY_FILE = root('data/emotes.json');
const STATE_FILE = root('data/state.json');
const EMOTE_IMG_DIR = root('public/emotes');
const STATS_FILE = root('public/stats.json');
const KEEP = new Set(['PRIVMSG', 'USERNOTICE', 'CLEARCHAT']);

const now = Date.now();
const from = Date.parse(config.start);
const to = config.end ? Date.parse(config.end) : Infinity;
const log = (...args) => console.log(...args);
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const host = (url) => new URL(url).host;

// Neuer Startzeitpunkt (z. B. Testlauf → echter Subathon): alte Daten verwerfen
if (readJson(STATE_FILE, {}).start !== config.start) {
  log(`Startzeit geändert auf ${config.start}, setze Daten zurück`);
  rmSync(DAYS_DIR, { recursive: true, force: true });
  rmSync(HISTORY_FILE, { force: true });
  rmSync(EMOTE_IMG_DIR, { recursive: true, force: true });
}
mkdirSync(DAYS_DIR, { recursive: true });
mkdirSync(EMOTE_IMG_DIR, { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify({ start: config.start }));

// ---------- 1. Emotes ----------
// Nur während des Subathons abrufen, sonst würden spätere Änderungen als "neu" auftauchen
const history = readJson(HISTORY_FILE, { firstRefresh: 0, lastRefresh: 0, emotes: {} });
if (now < to) {
  const { emotes, status } = await fetchThirdPartyEmotes(config.roomId);
  log('Emotes:', status);
  if (emotes.length) {
    for (const e of emotes) {
      const key = `${e.provider}:${e.id}`;
      history.emotes[key] = { firstSeen: now, ...history.emotes[key], ...e, lastSeen: now };
    }
    history.firstRefresh ||= now;
    history.lastRefresh = now;
    writeFileSync(HISTORY_FILE, JSON.stringify(history));
  }
}
const emoteMap = buildEmoteMap(history);

// ---------- 2. Chat-Logs pro UTC-Tag ----------
for (let dayStart = Math.floor(from / DAY) * DAY; dayStart < Math.min(now, to); dayStart += DAY) {
  const date = new Date(dayStart).toISOString().slice(0, 10);
  const file = `${DAYS_DIR}/${date}.json`;
  if (readJson(file, null)?.final) continue;

  // Ein Tag gilt 2 Stunden nach Mitternacht (UTC) als abgeschlossen → dann alle Archive zusammenführen.
  // Für den laufenden Tag reicht die Hauptquelle, um die Archive zu schonen.
  const closing = now > dayStart + DAY + 2 * HOUR;
  const merged = new Map();
  const sources = {};
  let ok = 0;
  for (const base of config.archives) {
    try {
      const lines = await fetchDay(base, config.channel, dayStart);
      sources[host(base)] = lines.length;
      ok++;
      for (const line of lines) {
        const msg = parseLine(line);
        if (!KEEP.has(msg.command)) continue;
        const key = lineKey(msg);
        if (!merged.has(key)) merged.set(key, msg);
      }
      if (!closing && lines.length) break;
    } catch (err) {
      sources[host(base)] = `Fehler: ${err.message}`;
    }
  }
  if (ok === 0) {
    log(`${date}: alle Archive nicht erreichbar, behalte alten Stand`, sources);
    continue;
  }

  // Abschließen, wenn mind. 2 Archive geantwortet haben. Nach einem Tag Wartezeit reicht auch eins.
  const final = closing && (ok >= 2 || now > dayStart + 2 * DAY);
  const day = aggregateDay(merged.values(), { emoteMap, bots: config.bots, from, to });
  writeFileSync(file, JSON.stringify({ date, final, fetchedAt: now, sources, ...day }));
  log(`${date}: ${day.messages} Nachrichten, ${Object.keys(day.users).length} Chatter${final ? ' (abgeschlossen)' : ''}`, sources);
}

// ---------- 3. stats.json ----------
const firstDay = new Date(Math.floor(from / DAY) * DAY).toISOString().slice(0, 10);
const days = readdirSync(DAYS_DIR)
  .filter((f) => f.endsWith('.json') && f.slice(0, 10) >= firstDay)
  .sort()
  .map((f) => readJson(`${DAYS_DIR}/${f}`));
const stats = buildStats(days, history, config, now);

// Emote-Bilder lokal speichern, damit die Website keine fremden Server kontaktiert
const images = new Map(readdirSync(EMOTE_IMG_DIR).map((f) => [f.replace(/\.\w+$/, ''), f]));
const extensions = { 'image/webp': 'webp', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };
async function emoteImage(provider, id) {
  const name = `${provider}-${id}`.replace(/[^\w-]/g, '_');
  if (!images.has(name)) {
    try {
      const res = await fetch(emoteImageUrl(provider, id), {
        headers: { 'User-Agent': config.userAgent },
        signal: AbortSignal.timeout(20_000),
      });
      const ext = extensions[res.headers.get('content-type')?.split(';')[0]];
      if (!res.ok || !ext) return null;
      writeFileSync(`${EMOTE_IMG_DIR}/${name}.${ext}`, Buffer.from(await res.arrayBuffer()));
      images.set(name, `${name}.${ext}`);
    } catch {
      return null;
    }
  }
  return `emotes/${images.get(name)}`;
}
for (const e of [...stats.topEmotes, ...stats.emoteChanges.added, ...stats.emoteChanges.removed]) {
  e.img = await emoteImage(e.provider, e.id);
}

writeFileSync(STATS_FILE, JSON.stringify(stats));
log(`stats.json: ${stats.totals.messages} Nachrichten, ${stats.totals.chatters} Chatter, ${stats.totals.subs} Subs`);

// Versionsnummer an CSS/JS hängen, damit Browser nach einer Änderung nicht die alte Datei aus dem Cache nehmen
const INDEX_FILE = root('public/index.html');
const versioned = readFileSync(INDEX_FILE, 'utf8').replace(/(style\.css|app\.js)(\?v=\w+)?"/g, (_, file) => {
  const hash = createHash('sha1').update(readFileSync(root(`public/${file}`))).digest('hex').slice(0, 8);
  return `${file}?v=${hash}"`;
});
writeFileSync(INDEX_FILE, versioned);
