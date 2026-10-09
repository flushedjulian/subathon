// Wird von der GitHub Action alle 15 Minuten ausgeführt (lokal: npm run build)
// 1. Emote-Listen abrufen und Verlauf aktualisieren
// 2. Chat-Logs holen: laufende Tage nur das Neue seit dem letzten Abruf,
//    abgeschlossene Tage einmal komplett aus allen Archiven
// 3. dist/ mit Website + stats.json bauen (verschlüsselt, wenn STATS_PASSWORD gesetzt ist)
//
// Der Zwischenstand liegt in .state/ (in der Action: nicht-öffentlicher Cache, nicht im Repo).
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { parseLine } from '../src/irc.js';
import { fetchDay, fetchRange } from '../src/archives.js';
import { addMessages, createDay, finalizeDay, lineKey } from '../src/aggregate.js';
import { buildEmoteMap, emoteImageUrl, fetchThirdPartyEmotes } from '../src/emotes.js';
import { buildStats } from '../src/merge.js';
import { encryptJson } from '../src/encrypt.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OVERLAP = 2 * MINUTE;   // Überlappung zum letzten Abruf, falls das Archiv etwas hinterherhängt
const KEEP = new Set(['PRIVMSG', 'USERNOTICE', 'CLEARCHAT']);

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const STATE_DIR = process.env.STATE_DIR ?? root('.state');
const DAYS_DIR = `${STATE_DIR}/days`;
const IMG_DIR = `${STATE_DIR}/emote-images`;
const HISTORY_FILE = `${STATE_DIR}/emotes.json`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const DIST = process.env.DIST_DIR ?? root('dist');

const now = Number(process.env.NOW ?? Date.now()); // NOW nur zum Testen überschreiben
const from = Date.parse(config.start);
const to = config.end ? Date.parse(config.end) : Infinity;
const until = Math.min(now, to);
const log = (...args) => console.log(...args);
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const host = (url) => new URL(url).host;
const isoDate = (ts) => new Date(ts).toISOString().slice(0, 10);
const dayFile = (date) => `${DAYS_DIR}/${date}.json`;
const saveDay = (day) => writeFileSync(dayFile(day.date), JSON.stringify(day));

// ---------- Zwischenstand ----------
let state = readJson(STATE_FILE, null);
if (state?.start !== config.start) {
  log(`Neuer Startzeitpunkt ${config.start}: fange von vorne an`);
  rmSync(STATE_DIR, { recursive: true, force: true });
  state = { start: config.start, fetchedUntil: 0, recentIds: {} };
}
mkdirSync(DAYS_DIR, { recursive: true });
mkdirSync(IMG_DIR, { recursive: true });

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
const opts = { emoteMap: buildEmoteMap(history), bots: config.bots, from, to: until };

// ---------- 2. Chat-Logs ----------
function parse(lines, into = new Map()) {
  for (const line of lines) {
    const msg = parseLine(line);
    if (!KEEP.has(msg.command)) continue;
    const key = lineKey(msg);
    if (!into.has(key)) into.set(key, msg);
  }
  return into;
}

// Probiert die Archive der Reihe nach, bis eins antwortet
async function firstArchive(fetcher) {
  const errors = {};
  for (const base of config.archives) {
    try {
      return { lines: await fetcher(base), source: host(base) };
    } catch (err) {
      errors[host(base)] = err.message;
    }
  }
  log('Alle Archive nicht erreichbar:', errors);
  return null;
}

// Ein Tag gilt 2 Stunden nach Mitternacht (UTC) als abgeschlossen
const isClosing = (dayStart) => now > dayStart + DAY + 2 * HOUR;
const dayStarts = [];
for (let d = Math.floor(from / DAY) * DAY; d < until; d += DAY) dayStarts.push(d);

// 2a. Abgeschlossene Tage: einmal komplett aus allen Archiven zusammenführen
for (const dayStart of dayStarts.filter(isClosing)) {
  const date = isoDate(dayStart);
  if (readJson(dayFile(date), null)?.final) continue;
  const merged = new Map();
  const sources = {};
  let ok = 0;
  for (const base of config.archives) {
    try {
      const lines = await fetchDay(base, config.channel, dayStart);
      sources[host(base)] = lines.length;
      parse(lines, merged);
      ok++;
    } catch (err) {
      sources[host(base)] = `Fehler: ${err.message}`;
    }
  }
  if (ok === 0) {
    log(`${date}: alle Archive nicht erreichbar, behalte alten Stand`);
    continue;
  }
  const day = addMessages(createDay(date), merged.values(), opts);
  day.sources = sources;
  // Abschließen, wenn mind. 2 Archive geantwortet haben. Nach einem Tag Wartezeit reicht auch eins.
  if (ok >= 2 || now > dayStart + 2 * DAY) finalizeDay(day);
  saveDay(day);
  log(`${date}: ${day.messages} Nachrichten${day.final ? ' (abgeschlossen)' : ''}`, sources);
}

// 2b. Laufende Tage: nur die Nachrichten seit dem letzten Abruf
const openDays = dayStarts.filter((d) => !isClosing(d));
const days = new Map(openDays.map((d) => [d, readJson(dayFile(isoDate(d)), null)]));
const fresh = !state.fetchedUntil || openDays.some((d) => !days.get(d) && d < state.fetchedUntil);

if (fresh) {
  // Kein (vollständiger) Zwischenstand: laufende Tage komplett holen
  state.recentIds = {};
  let complete = true;
  for (const dayStart of openDays) {
    const res = await firstArchive((base) => fetchDay(base, config.channel, dayStart));
    if (!res) { complete = false; continue; }
    const msgs = parse(res.lines);
    const day = addMessages(createDay(isoDate(dayStart)), msgs.values(), opts);
    for (const [key, msg] of msgs) {
      const ts = Number(msg.tags['tmi-sent-ts']);
      if (ts < until) state.recentIds[key] = ts;
    }
    saveDay(day);
    log(`${day.date}: komplett geholt, ${day.messages} Nachrichten (${res.source})`);
  }
  if (complete) state.fetchedUntil = until;
} else if (openDays.length) {
  const since = Math.max(state.fetchedUntil - OVERLAP, openDays[0]);
  const res = await firstArchive((base) => fetchRange(base, config.channel, since, until));
  if (res) {
    const byDay = new Map();
    let added = 0;
    for (const [key, msg] of parse(res.lines)) {
      if (state.recentIds[key]) continue; // schon beim letzten Abruf gezählt
      const ts = Number(msg.tags['tmi-sent-ts']);
      const dayStart = Math.floor(ts / DAY) * DAY;
      if (!days.has(dayStart)) continue;
      state.recentIds[key] = ts;
      if (!byDay.has(dayStart)) byDay.set(dayStart, []);
      byDay.get(dayStart).push(msg);
      added++;
    }
    for (const [dayStart, msgs] of byDay) {
      const day = days.get(dayStart) ?? createDay(isoDate(dayStart));
      saveDay(addMessages(day, msgs, opts));
    }
    state.fetchedUntil = until;
    log(`Seit ${new Date(since).toISOString()}: ${res.lines.length} Zeilen, ${added} neu (${res.source})`);
  }
}

// IDs nur für die Überlappung aufheben
for (const [key, ts] of Object.entries(state.recentIds)) {
  if (ts < state.fetchedUntil - 10 * MINUTE) delete state.recentIds[key];
}
writeFileSync(STATE_FILE, JSON.stringify(state));

// ---------- 3. Website bauen ----------
const firstDay = isoDate(Math.floor(from / DAY) * DAY);
const allDays = readdirSync(DAYS_DIR)
  .filter((f) => f.endsWith('.json') && f.slice(0, 10) >= firstDay)
  .sort()
  .map((f) => readJson(`${DAYS_DIR}/${f}`));
const stats = buildStats(allDays, history, config, now);

rmSync(DIST, { recursive: true, force: true });
cpSync(root('public'), DIST, { recursive: true });
mkdirSync(`${DIST}/emotes`, { recursive: true });

// Emote-Bilder einmal herunterladen und mit ausliefern, damit die Website keine fremden Server kontaktiert
const images = new Map(readdirSync(IMG_DIR).map((f) => [f.replace(/\.\w+$/, ''), f]));
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
      writeFileSync(`${IMG_DIR}/${name}.${ext}`, Buffer.from(await res.arrayBuffer()));
      images.set(name, `${name}.${ext}`);
    } catch {
      return null;
    }
  }
  copyFileSync(`${IMG_DIR}/${images.get(name)}`, `${DIST}/emotes/${images.get(name)}`);
  return `emotes/${images.get(name)}`;
}
for (const e of [...stats.topEmotes, ...stats.emoteChanges.added, ...stats.emoteChanges.removed]) {
  e.img = await emoteImage(e.provider, e.id);
}
// Mit Passwort: nur die verschlüsselte Fassung ausliefern. In der Action ist das Pflicht,
// damit die Daten nie versehentlich offen online gehen.
const password = process.env.STATS_PASSWORD;
if (password) {
  // Salt bleibt gleich, solange der Zwischenstand lebt → der Browser muss den Schlüssel nur einmal ableiten
  state.salt ??= Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  writeFileSync(STATE_FILE, JSON.stringify(state));
  const encrypted = await encryptJson(stats, password, Buffer.from(state.salt, 'base64'));
  writeFileSync(`${DIST}/stats.enc.json`, JSON.stringify(encrypted));
} else if (process.env.CI) {
  throw new Error('STATS_PASSWORD fehlt: Secret im Repo anlegen (Settings → Secrets and variables → Actions)');
} else {
  writeFileSync(`${DIST}/stats.json`, JSON.stringify(stats));
}

// Versionsnummer an CSS/JS hängen, damit Browser nach einer Änderung nicht die alte Datei aus dem Cache nehmen
const index = readFileSync(`${DIST}/index.html`, 'utf8').replace(/(style\.css|app\.js)(\?v=\w+)?"/g, (_, file) => {
  const hash = createHash('sha1').update(readFileSync(`${DIST}/${file}`)).digest('hex').slice(0, 8);
  return `${file}?v=${hash}"`;
});
writeFileSync(`${DIST}/index.html`, index);

log(`stats.json: ${stats.totals.messages} Nachrichten, ${stats.totals.chatters} Chatter, ${stats.totals.subs} Subs`);
