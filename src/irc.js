const TAG_ESCAPES = { s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' };
const unescapeTag = (v) => v.replace(/\\(.)/g, (_, c) => TAG_ESCAPES[c] ?? c);

// Parst eine Twitch-IRC-Zeile: "@tags :prefix COMMAND params :trailing"
export function parseLine(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const part of rest.slice(1, sp).split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) tags[part] = '';
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = null;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }
  const [command, ...params] = rest.split(' ').filter(Boolean);
  if (trailing !== null) params.push(trailing);
  const nick = prefix?.includes('!') ? prefix.slice(0, prefix.indexOf('!')) : null;
  return { tags, prefix, nick, command, params };
}

// "25:0-4,12-16/1902:6-10" → [{ id: '25', ranges: [[0,4],[12,16]] }, ...]
export function parseEmotesTag(tag) {
  if (!tag) return [];
  return tag.split('/').map((entry) => {
    const [id, positions] = entry.split(':');
    return { id, ranges: positions.split(',').map((r) => r.split('-').map(Number)) };
  });
}

// "/me"-Nachrichten kommen als "\x01ACTION text\x01"
export function stripAction(text) {
  const m = /^\x01ACTION (.*)\x01$/.exec(text);
  return m ? { text: m[1], action: true } : { text, action: false };
}
