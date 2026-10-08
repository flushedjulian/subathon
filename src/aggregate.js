import { stripAction } from './irc.js';
import { extractEmotes } from './emotes.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const TIERS = { Prime: 'prime', 1000: '1', 2000: '2', 3000: '3' };
const SUB_TYPES = new Set(['sub', 'resub', 'subgift']);

// Eindeutiger Schlüssel pro Chat-Zeile, um Archive und überlappende Abrufe zusammenzuführen
export function lineKey(msg) {
  return msg.tags.id ?? `${msg.command}:${msg.tags['tmi-sent-ts']}:${msg.params[1] ?? ''}`;
}

// Zusammenfassung eines Tages. Nur Zahlen und Usernamen, keine Nachrichtentexte.
export function createDay(date) {
  return {
    date,
    final: false,
    messages: 0,
    bits: 0,
    firstTimeChatters: 0,
    users: {},        // user-id → [login, displayName, nachrichten, bits]
    emotes: {},       // provider:id → [name, anzahl]
    events: {},       // msg-id → anzahl
    tiers: {},        // prime/1/2/3 → anzahl (sub, resub, subgift)
    gifters: {},      // login → [displayName, gifts]
    raids: [],        // [ts, login, displayName, zuschauer]
    hours: {},        // stunden-ts → [nachrichten, chatter, subs, emotes]
    peakMinute: [0, 0],
    lastTs: 0,        // Zeitpunkt der letzten Nachricht
    recentMinutes: {}, // minuten-ts → nachrichten, nur die letzte Stunde vor lastTs
    // Zwischenstand, solange der Tag läuft (fällt beim Abschluss weg)
    hourChatters: {}, // stunden-ts → [user-ids]
    minutes: {},      // minuten-ts → nachrichten
  };
}

// Addiert Chat-Zeilen auf einen Tag auf
export function addMessages(day, messages, { emoteMap, bots, from, to }) {
  const botSet = new Set(bots);
  const chatterSets = {};
  const chatters = (h) => (chatterSets[h] ??= new Set(day.hourChatters[h] ?? []));
  const hour = (ts) => (day.hours[Math.floor(ts / HOUR) * HOUR] ??= [0, 0, 0, 0]);
  const count = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };

  const countEmotes = (ts, text, tag) => {
    let n = 0;
    for (const e of extractEmotes(text, tag, emoteMap)) {
      const entry = (day.emotes[`${e.provider}:${e.id}`] ??= [e.name, 0]);
      entry[1] += e.count;
      n += e.count;
    }
    if (n) hour(ts)[3] += n;
  };

  for (const msg of messages) {
    const ts = Number(msg.tags['tmi-sent-ts']);
    if (!ts || ts < from || ts >= to) continue;
    const login = msg.tags.login ?? msg.nick;
    const name = msg.tags['display-name'] || login;

    if (msg.command === 'PRIVMSG') {
      if (botSet.has(login)) continue;
      const { text } = stripAction(msg.params[1] ?? '');
      const uid = msg.tags['user-id'];
      const bits = Number(msg.tags.bits ?? 0);
      const user = (day.users[uid] ??= [login, name, 0, 0]);
      user[1] = name;
      user[2]++;
      user[3] += bits;
      day.messages++;
      day.bits += bits;
      if (msg.tags['first-msg'] === '1') day.firstTimeChatters++;
      if (ts > day.lastTs) day.lastTs = ts;

      hour(ts)[0]++;
      chatters(Math.floor(ts / HOUR) * HOUR).add(uid);
      count(day.minutes, Math.floor(ts / MINUTE) * MINUTE);

      countEmotes(ts, text, msg.tags.emotes);
    } else if (msg.command === 'USERNOTICE') {
      const type = msg.tags['msg-id'];
      count(day.events, type);
      if (SUB_TYPES.has(type)) {
        hour(ts)[2]++;
        count(day.tiers, TIERS[msg.tags['msg-param-sub-plan']] ?? '?');
      }
      if (type === 'subgift') (day.gifters[login] ??= [name, 0])[1]++;
      if (type === 'raid') {
        day.raids.push([ts, login, msg.tags['msg-param-displayName'] || name, Number(msg.tags['msg-param-viewerCount'] ?? 0)]);
      }
      // Resub-Nachrichten enthalten oft Emotes
      if (msg.params[1]) countEmotes(ts, msg.params[1], msg.tags.emotes);
    } else if (msg.command === 'CLEARCHAT') {
      count(day.events, !msg.params[1] ? 'chat_clear' : msg.tags['ban-duration'] ? 'timeout' : 'ban');
    }
  }

  // Abgeleitete Werte aktualisieren
  for (const [h, set] of Object.entries(chatterSets)) {
    day.hourChatters[h] = [...set];
    hour(Number(h))[1] = set.size;
  }
  day.recentMinutes = {};
  for (const [m, c] of Object.entries(day.minutes)) {
    if (c > day.peakMinute[1]) day.peakMinute = [Number(m), c];
    if (Number(m) > day.lastTs - HOUR) day.recentMinutes[m] = c;
  }
  return day;
}

// Abgeschlossener Tag: Zwischenstand wird nicht mehr gebraucht
export function finalizeDay(day) {
  day.final = true;
  delete day.hourChatters;
  delete day.minutes;
  return day;
}
