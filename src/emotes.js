import { parseEmotesTag } from './irc.js';
import { config } from './config.js';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const sevenTv = (list, scope) => (list ?? []).map((e) => ({ provider: '7tv', scope, id: e.id, name: e.name }));
const bttv = (list, scope) => (list ?? []).map((e) => ({ provider: 'bttv', scope, id: e.id, name: e.code }));
const ffz = (sets, scope) =>
  Object.values(sets ?? {}).flatMap((s) =>
    (s.emoticons ?? []).map((e) => ({ provider: 'ffz', scope, id: String(e.id), name: e.name })),
  );

const SOURCES = [
  ['ffz global', async () => {
    const d = await getJson('https://api.frankerfacez.com/v1/set/global');
    const defaults = new Set((d.default_sets ?? []).map(String));
    return ffz(Object.fromEntries(Object.entries(d.sets).filter(([k]) => defaults.has(k))), 'global');
  }],
  ['bttv global', async () => bttv(await getJson('https://api.betterttv.net/3/cached/emotes/global'), 'global')],
  ['7tv global', async () => sevenTv((await getJson('https://7tv.io/v3/emote-sets/global')).emotes, 'global')],
  ['ffz channel', async (roomId) => ffz((await getJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`)).sets, 'channel')],
  ['bttv channel', async (roomId) => {
    const d = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`);
    return bttv([...(d.channelEmotes ?? []), ...(d.sharedEmotes ?? [])], 'channel');
  }],
  ['7tv channel', async (roomId) => sevenTv((await getJson(`https://7tv.io/v3/users/twitch/${roomId}`)).emote_set?.emotes, 'channel')],
];

// Lädt alle Drittanbieter-Emotes. Fällt eine Quelle aus, bleiben die anderen nutzbar.
export async function fetchThirdPartyEmotes(roomId) {
  const results = await Promise.allSettled(SOURCES.map(([, fn]) => fn(roomId)));
  const emotes = [];
  const status = {};
  results.forEach((r, i) => {
    const [name] = SOURCES[i];
    if (r.status === 'fulfilled') {
      emotes.push(...r.value);
      status[name] = r.value.length;
    } else {
      status[name] = `Fehler: ${r.reason.message}`;
    }
  });
  return { emotes, status };
}

export function emoteImageUrl(provider, id) {
  switch (provider) {
    case 'twitch': return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
    case '7tv': return `https://cdn.7tv.app/emote/${id}/2x.webp`;
    case 'bttv': return `https://cdn.betterttv.net/emote/${id}/2x`;
    case 'ffz': return `https://cdn.frankerfacez.com/emote/${id}/2`;
  }
}

const PROVIDER_RANK = { ffz: 0, bttv: 1, '7tv': 2 };

// Name → Emote. Bei gleichem Namen gewinnt: aktiv vor entfernt, Kanal vor global, 7TV > BTTV > FFZ
export function buildEmoteMap(history) {
  const list = Object.values(history.emotes)
    .filter((e) => e.provider !== 'twitch')
    .map((e) => ({ ...e, active: e.lastSeen === history.lastRefresh }));
  list.sort((a, b) =>
    a.active - b.active
    || (a.scope === 'channel') - (b.scope === 'channel')
    || PROVIDER_RANK[a.provider] - PROVIDER_RANK[b.provider]);
  return new Map(list.map((e) => [e.name, e]));
}

// Zählt alle Emotes einer Nachricht: Twitch-Emotes aus dem Tag, 7TV/BTTV/FFZ per Wortabgleich
export function extractEmotes(text, emotesTag, emoteMap) {
  const chars = Array.from(text); // Twitch-Positionen sind in Codepoints
  const found = new Map();
  const add = (provider, id, name) => {
    const key = `${provider}:${id}`;
    const entry = found.get(key) ?? { provider, id, name, count: 0 };
    entry.count++;
    found.set(key, entry);
  };

  const covered = new Set();
  for (const { id, ranges } of parseEmotesTag(emotesTag)) {
    for (const [start, end] of ranges) {
      add('twitch', id, chars.slice(start, end + 1).join(''));
      covered.add(start);
    }
  }

  let i = 0;
  while (i < chars.length) {
    if (chars[i] === ' ') { i++; continue; }
    let j = i;
    while (j < chars.length && chars[j] !== ' ') j++;
    if (!covered.has(i)) {
      const emote = emoteMap.get(chars.slice(i, j).join(''));
      if (emote) add(emote.provider, emote.id, emote.name);
    }
    i = j;
  }
  return [...found.values()];
}
