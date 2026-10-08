import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLines(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent },
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).split(/\r?\n/).filter(Boolean);
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(5_000 * attempt);
    }
  }
}

// Rohdaten eines ganzen UTC-Tages aus einem justlog-Archiv. Leeres Array, wenn es den Tag nicht gibt.
export function fetchDay(base, channel, dayStart) {
  const d = new Date(dayStart);
  return fetchLines(`${base}/channel/${channel}/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}?raw`);
}

// Nur die Nachrichten in einem Zeitraum, z. B. seit dem letzten Abruf
export function fetchRange(base, channel, from, to) {
  const iso = (ts) => new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z');
  return fetchLines(`${base}/channel/${channel}?from=${iso(from)}&to=${iso(to)}&raw`);
}
