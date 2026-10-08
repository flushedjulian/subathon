import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rohdaten eines UTC-Tages aus einem justlog-Archiv. Leeres Array, wenn es den Tag nicht gibt.
export async function fetchDay(base, channel, dayStart) {
  const d = new Date(dayStart);
  const url = `${base}/channel/${channel}/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}?raw`;
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
