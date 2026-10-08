const HOUR = 3_600_000;

const add = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);

// Fasst alle Tages-Zusammenfassungen zu den Daten für die Website zusammen
export function buildStats(days, history, config, now) {
  const from = Date.parse(config.start);
  const to = config.end ? Date.parse(config.end) : null;
  const optout = new Set(config.optout.map((l) => l.toLowerCase()));

  const users = new Map();    // user-id → { login, name, messages }
  const gifters = new Map();  // login → { name, gifts }
  const emotes = new Map();   // provider:id → { name, count }
  const events = new Map();
  const tiers = new Map();
  const hours = new Map();
  const raids = [];
  let messages = 0;
  let bits = 0;
  let firstTimeChatters = 0;
  let peakMinute = [0, 0];

  for (const d of days) {
    messages += d.messages;
    bits += d.bits;
    firstTimeChatters += d.firstTimeChatters;
    for (const [uid, [login, name, msgs]] of Object.entries(d.users)) {
      const u = users.get(uid) ?? { login, name, messages: 0 };
      u.name = name;
      u.messages += msgs;
      users.set(uid, u);
    }
    for (const [login, [name, gifts]] of Object.entries(d.gifters)) {
      const g = gifters.get(login) ?? { login, name, gifts: 0 };
      g.gifts += gifts;
      gifters.set(login, g);
    }
    for (const [key, [name, count]] of Object.entries(d.emotes)) {
      const e = emotes.get(key) ?? { name, count: 0 };
      e.count += count;
      emotes.set(key, e);
    }
    for (const [type, n] of Object.entries(d.events)) add(events, type, n);
    for (const [tier, n] of Object.entries(d.tiers)) add(tiers, tier, n);
    for (const [h, row] of Object.entries(d.hours)) hours.set(Number(h), row);
    raids.push(...d.raids);
    if (d.peakMinute[1] > peakMinute[1]) peakMinute = d.peakMinute;
  }

  // Stündliche Zeitreihe ohne Lücken: [ts, nachrichten, chatter, subs, emotes]
  const timeline = [];
  const lastHour = Math.max(...hours.keys(), Math.floor(from / HOUR) * HOUR);
  for (let h = Math.floor(from / HOUR) * HOUR; h <= lastHour; h += HOUR) {
    timeline.push([h, ...(hours.get(h) ?? [0, 0, 0, 0])]);
  }
  const peakHour = timeline.reduce((best, row) => (row[1] > best[1] ? row : best), [0, 0]);

  const ev = (type) => events.get(type) ?? 0;
  const visible = (login) => !optout.has(login);

  // Emotes, die nach dem ersten Abruf dazugekommen bzw. verschwunden sind
  const channelEmotes = Object.values(history.emotes).filter((e) => e.scope === 'channel');
  const emoteChanges = {
    added: channelEmotes
      .filter((e) => e.firstSeen > history.firstRefresh)
      .sort((a, b) => b.firstSeen - a.firstSeen)
      .map((e) => ({ provider: e.provider, id: e.id, name: e.name, ts: e.firstSeen })),
    removed: channelEmotes
      .filter((e) => e.lastSeen < history.lastRefresh)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((e) => ({ provider: e.provider, id: e.id, name: e.name, ts: e.lastSeen })),
  };

  return {
    channel: config.channel,
    start: from,
    end: to,
    generatedAt: now,
    totals: {
      messages,
      chatters: users.size,
      emotes: [...emotes.values()].reduce((s, e) => s + e.count, 0),
      bits,
      subs: ev('sub') + ev('resub') + ev('subgift'),
      newSubs: ev('sub'),
      resubs: ev('resub'),
      giftedSubs: ev('subgift'),
      giftBombs: ev('submysterygift'),
      prime: tiers.get('prime') ?? 0,
      tier1: tiers.get('1') ?? 0,
      tier2: tiers.get('2') ?? 0,
      tier3: tiers.get('3') ?? 0,
      raids: ev('raid'),
      timeouts: ev('timeout'),
      bans: ev('ban'),
      firstTimeChatters,
    },
    records: {
      peakMinute: { ts: peakMinute[0], messages: peakMinute[1] },
      peakHour: { ts: peakHour[0], messages: peakHour[1] },
    },
    timeline,
    topEmotes: [...emotes.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, config.topEmotes)
      .map(([key, e]) => {
        const [provider, id] = key.split(':');
        return { provider, id, name: e.name, count: e.count };
      }),
    topChatters: [...users.values()]
      .filter((u) => visible(u.login))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, config.topUsers)
      .map((u) => ({ name: u.name, messages: u.messages })),
    topGifters: [...gifters.values()]
      .filter((g) => visible(g.login))
      .sort((a, b) => b.gifts - a.gifts)
      .slice(0, config.topUsers)
      .map((g) => ({ name: g.name, gifts: g.gifts })),
    raids: raids
      .filter((r) => visible(r[1]))
      .sort((a, b) => b[3] - a[3])
      .slice(0, config.topUsers)
      .map(([ts, , name, viewers]) => ({ ts, name, viewers })),
    emoteChanges,
    coverage: days.map((d) => ({ date: d.date, final: d.final, sources: d.sources })),
  };
}
