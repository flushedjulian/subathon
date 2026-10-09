const TZ = 'Europe/Berlin';
const REFRESH_MS = 5 * 60_000;
const HOUR = 3_600_000;

const nf = new Intl.NumberFormat('de-DE');
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const fmt = (n) => nf.format(n);
const dateTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const timeOnly = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hourOnly = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit' });
const isoDay = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }); // → "2026-10-08"

const $ = (id) => document.getElementById(id);

// Kleiner DOM-Helfer. Texte immer über textContent, nie als HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svgNs = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}) {
  const el = document.createElementNS(svgNs, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function duration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const hrs = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  if (d > 0) return `${d} ${d === 1 ? 'Tag' : 'Tagen'} ${hrs} Std`;
  if (hrs > 0) return `${hrs} Std ${min} Min`;
  return `${min} Min`;
}

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  return `vor ${duration(Date.now() - ts)}`;
}

let stats = null;

// ---------- Kopf & Kennzahlen ----------
function renderHeader() {
  const { start, end, generatedAt } = stats;
  $('running').textContent = end
    ? `Dauer: ${duration(end - start)}`
    : Date.now() < start
      ? `Startet ${dateTime.format(start)} Uhr`
      : `Läuft seit ${duration(Date.now() - start)}`;
  $('updated').textContent = `Stand ${timeOnly.format(generatedAt)} Uhr (${ago(generatedAt)})`;
}

function renderTotals() {
  const t = stats.totals;
  const hours = Math.max(1, (Math.min(stats.end ?? Date.now(), Date.now()) - stats.start) / HOUR);
  const perHour = stats.live?.messagesPerHour ?? 0;
  $('hero-sub').replaceChildren(
    perHour ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : '',
    perHour ? `zuletzt ~${fmt(perHour)} pro Stunde` : 'Chat gerade ruhig',
    ` · von ${fmt(t.chatters)} Chattern · Ø ${fmt(Math.round(t.messages / hours))} pro Stunde insgesamt`,
  );
  $('chatters-sub').textContent = 'nach Anzahl Nachrichten';

  const tiles = [
    ['Chatter', t.chatters, t.chatters ? `Ø ${nf1.format(t.messages / t.chatters)} Nachrichten pro Person` : ''],
    ['Subs', t.subs, `${fmt(t.newSubs)} neu · ${fmt(t.resubs)} Resubs · ${fmt(t.giftedSubs)} gifted`],
    ['Emotes', t.emotes, t.messages ? `Ø ${nf1.format(t.emotes / t.messages)} pro Nachricht` : ''],
    ['Bits', t.bits, ''],
    ['Zum ersten Mal im Chat', t.firstTimeChatters, ''],
    ['Prime-Subs', t.prime, `Tier 1: ${fmt(t.tier1)} · Tier 2: ${fmt(t.tier2)} · Tier 3: ${fmt(t.tier3)}`],
    ['Raids', t.raids, ''],
    ['Timeouts', t.timeouts, `+ ${fmt(t.bans)} Bans`],
  ];
  $('tiles').replaceChildren(...tiles.map(([label, value, detail]) =>
    h('div', { class: 'tile' },
      h('p', { class: 'label' }, label),
      h('p', { class: 'tile-value' }, fmt(value)),
      detail && h('p', { class: 'tile-detail' }, detail))));
}

// ---------- Verlauf ----------
const METRICS = [
  { key: 1, label: 'Nachrichten', unit: 'Nachrichten' },
  { key: 2, label: 'Chatter', unit: 'Chatter' },
  { key: 3, label: 'Subs', unit: 'Subs' },
  { key: 4, label: 'Emotes', unit: 'Emotes' },
];
let metric = METRICS[0];

function renderTabs() {
  $('metric-tabs').replaceChildren(...METRICS.map((m) => {
    const b = h('button', { role: 'tab', type: 'button', 'aria-selected': String(m === metric) }, m.label);
    b.addEventListener('click', () => {
      metric = m;
      renderTabs();
      renderChart();
    });
    return b;
  }));
  $('timeline-sub').textContent = `${metric.unit} pro Stunde`;
}

function niceMax(max, ticks = 4) {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

function renderChart() {
  const box = $('chart');
  const rows = stats.timeline;
  if (rows.length < 2) {
    box.replaceChildren(h('p', { class: 'empty' }, 'Noch nicht genug Daten für den Verlauf.'));
    return;
  }
  const W = box.clientWidth;
  const H = box.clientHeight;
  const m = { top: 8, right: 8, bottom: 26, left: 48 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const values = rows.map((r) => r[metric.key]);
  const { top, step } = niceMax(Math.max(...values));
  const t0 = rows[0][0];
  const t1 = rows.at(-1)[0];
  const x = (ts) => m.left + ((ts - t0) / (t1 - t0)) * iw;
  const y = (v) => m.top + ih - (v / top) * ih;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${metric.unit} pro Stunde im Verlauf des Subathons` });

  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { class: 'gridline', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
    const label = s('text', { class: 'tick', x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = fmt(v);
    svg.append(label);
  }

  // X-Achse: Mitternacht (Berlin) markieren; bei kurzen Zeiträumen alle 6 Stunden
  const spanH = (t1 - t0) / HOUR;
  const everyH = spanH <= 36 ? 6 : 24;
  const dayEvery = Math.max(1, Math.ceil((spanH / 24) / Math.max(1, Math.floor(iw / 72))));
  let dayCount = 0;
  for (const [ts] of rows) {
    const hr = Number(hourOnly.format(ts));
    if (hr % everyH !== 0) continue;
    if (everyH === 24 && dayCount++ % dayEvery !== 0) continue;
    const label = s('text', { class: 'tick', x: x(ts), y: H - 6, 'text-anchor': 'middle' });
    label.textContent = everyH === 24 ? dayLabel.format(ts) : hr === 0 ? dayLabel.format(ts) : `${hr} Uhr`;
    svg.append(label);
  }

  const pts = rows.map((r) => `${x(r[0]).toFixed(1)},${y(r[metric.key]).toFixed(1)}`);
  svg.append(s('path', { class: 'area', d: `M${x(t0)},${y(0)}L${pts.join('L')}L${x(t1)},${y(0)}Z` }));
  svg.append(s('path', { class: 'line', d: `M${pts.join('L')}` }));

  // Hover: Fadenkreuz + Tooltip
  const cross = s('line', { class: 'cross', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
  const marker = s('circle', { class: 'marker', r: 5, visibility: 'hidden' });
  const hit = s('rect', { x: m.left, y: 0, width: iw, height: H, fill: 'transparent' });
  svg.append(cross, marker, hit);

  const tip = $('tooltip');
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - m.left) / iw) * (rows.length - 1))));
    const [ts] = rows[i];
    const v = rows[i][metric.key];
    cross.setAttribute('x1', x(ts));
    cross.setAttribute('x2', x(ts));
    marker.setAttribute('cx', x(ts));
    marker.setAttribute('cy', y(v));
    cross.setAttribute('visibility', 'visible');
    marker.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 't-sub' }, `${dayLabel.format(ts)}, ${timeOnly.format(ts)}–${timeOnly.format(ts + HOUR)} Uhr`),
      h('div', {}, h('strong', {}, fmt(v)), ` ${metric.unit}`),
    );
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = ev.clientX + 14 + tw > window.innerWidth - 8 ? ev.clientX - 14 - tw : ev.clientX + 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${ev.clientY - tip.offsetHeight - 12}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);

  box.replaceChildren(svg);
}

function renderDayTable() {
  const days = new Map();
  for (const [ts, msgs, , subs, emotes] of stats.timeline) {
    const key = isoDay.format(ts);
    const d = days.get(key) ?? { ts, msgs: 0, subs: 0, emotes: 0 };
    d.msgs += msgs;
    d.subs += subs;
    d.emotes += emotes;
    days.set(key, d);
  }
  $('day-table').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Nachrichten'), h('th', {}, 'Subs'), h('th', {}, 'Emotes'))),
    h('tbody', {}, [...days.values()].map((d) =>
      h('tr', {}, h('td', {}, dayLabel.format(d.ts)), h('td', {}, fmt(d.msgs)), h('td', {}, fmt(d.subs)), h('td', {}, fmt(d.emotes))))),
  );
}

// ---------- Ranglisten ----------
const PROVIDERS = { twitch: 'Twitch', '7tv': '7TV', bttv: 'BTTV', ffz: 'FFZ' };

function emoteImg(e, size = 32) {
  return e.img
    ? h('img', { src: e.img, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async' })
    : h('span', { class: 'img-fallback', 'aria-hidden': 'true' });
}

function rankRows(list, { value, name, img, tag, unit }) {
  if (!list.length) return [h('li', { class: 'empty' }, 'Noch keine Daten')];
  const max = value(list[0]) || 1;
  return list.map((item, i) => h('li', { class: img ? 'row' : 'row no-img' },
    h('span', { class: 'rank' }, i + 1),
    img && img(item),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-name' }, h('span', {}, name(item)), tag && h('span', { class: 'provider' }, tag(item))),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(2, (value(item) / max) * 100)}%` }))),
    h('span', { class: 'row-value', 'aria-label': `${fmt(value(item))} ${unit}` }, fmt(value(item)))));
}

function setRows(id, n) {
  $(id).style.setProperty('--rows', Math.max(1, Math.ceil(n / 2)));
}

function renderLists() {
  setRows('emote-list', stats.topEmotes.length);
  setRows('chatter-list', stats.topChatters.length);
  $('emote-list').replaceChildren(...rankRows(stats.topEmotes, {
    value: (e) => e.count, name: (e) => e.name, img: emoteImg, tag: (e) => PROVIDERS[e.provider], unit: 'mal',
  }));
  $('chatter-list').replaceChildren(...rankRows(stats.topChatters, {
    value: (u) => u.messages, name: (u) => u.name, unit: 'Nachrichten',
  }));
  $('gifter-list').replaceChildren(...rankRows(stats.topGifters, {
    value: (g) => g.gifts, name: (g) => g.name, unit: 'Gift-Subs',
  }));
  $('raid-list').replaceChildren(...rankRows(stats.raids, {
    value: (r) => r.viewers, name: (r) => `${r.name} · ${dayLabel.format(r.ts)}`, unit: 'Zuschauer',
  }));
}

function renderRecords() {
  const { peakMinute, peakHour } = stats.records;
  const t = stats.totals;
  const items = [
    ['Meiste Nachrichten in einer Minute', peakMinute.messages, peakMinute.ts && `${dateTime.format(peakMinute.ts)} Uhr`],
    ['Stärkste Stunde', peakHour.messages, peakHour.ts && `${dayLabel.format(peakHour.ts)}, ${timeOnly.format(peakHour.ts)}–${timeOnly.format(peakHour.ts + HOUR)} Uhr`],
    ['Sub-Bombs', t.giftBombs, 'mehrere Subs auf einmal verschenkt'],
  ];
  $('records').replaceChildren(...items.map(([label, value, sub]) => h('div', {},
    h('dt', {}, label),
    h('dd', {}, fmt(value), sub && h('small', {}, sub)))));
}

function renderEmoteChanges() {
  const { added, removed } = stats.emoteChanges;
  $('changes-card').hidden = !added.length && !removed.length;
  const chips = (list) => list.length
    ? list.map((e) => h('li', { class: 'chip', title: `${PROVIDERS[e.provider]} · ${dateTime.format(e.ts)} Uhr` }, emoteImg(e, 24), e.name))
    : [h('li', { class: 'chip-empty' }, 'Keine')];
  $('emotes-added').replaceChildren(...chips(added));
  $('emotes-removed').replaceChildren(...chips(removed));
}

// ---------- Live-Zähler ----------
// Rechnet die Nachrichtenzahl zwischen den Updates hoch: im Schnitt mit dem Tempo der letzten Stunde,
// aber mit zufälligen Abständen, schwankendem Tempo und gelegentlichen Hype-Momenten.
// Kommt ein Update mit höherer Zahl, holt er schnell auf. Ist er zu weit vorne, bremst er (nie rückwärts).
const MAX_PREDICT_MS = 2 * HOUR; // länger ohne Update → nicht weiter hochrechnen
const MOOD_TAU = 8;              // Sekunden, bis sich das Tempo spürbar ändert
const MOOD_SIGMA = 0.35;         // wie stark das Tempo schwankt
const MOOD_NORM = Math.exp(-(MOOD_SIGMA ** 2 * MOOD_TAU) / 4); // hält den Schnitt bei 1
const HYPE_EVERY_S = 75;         // im Schnitt alle 75 s ein kurzer Hype-Moment

const counter = { introStart: null, value: null, shown: null, base: 0, lastTs: 0, perSec: 0, mood: 0, hype: 0, lastFrame: 0 };

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

// Anzahl zufälliger Ereignisse in einem Zeitabschnitt (Poisson-verteilt)
function poisson(lambda) {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= Math.random(); } while (p > limit);
  return k - 1;
}

const counterTarget = (now) =>
  counter.base + (counter.perSec * Math.min(MAX_PREDICT_MS, Math.max(0, now - counter.lastTs))) / 1000;

function updateCounter() {
  counter.base = stats.totals.messages;
  counter.lastTs = stats.live?.lastTs || stats.generatedAt;
  counter.perSec = (stats.live?.messagesPerHour ?? 0) / 3600;
  if (counter.value === null) counter.value = Math.floor(counterTarget(Date.now()));
}

function tickCounter(frameTs) {
  const dt = counter.lastFrame ? Math.min(5, (frameTs - counter.lastFrame) / 1000) : 0;
  counter.lastFrame = frameTs;

  if (counter.value !== null && dt > 0) {
    const gap = counterTarget(Date.now()) - counter.value;
    const slack = Math.max(15, counter.perSec * 20); // ~20 s Abweichung gelten als normal
    if (gap > slack * 2) {
      // Neues Update liegt deutlich höher (oder Tab war im Hintergrund): zügig aufholen
      counter.value += Math.ceil((gap - slack) * (1 - Math.exp(-dt / 0.8)));
    } else if (counter.perSec > 0) {
      counter.mood += (-counter.mood / MOOD_TAU) * dt + MOOD_SIGMA * Math.sqrt(dt) * gauss();
      if (Math.random() < dt / HYPE_EVERY_S) counter.hype = 1.5 + Math.random() * 2;
      counter.hype *= Math.exp(-dt / 4);
      const pull = Math.exp(Math.max(-3, Math.min(1, gap / slack))); // vorne → bremsen, hinten → zulegen
      const rate = counter.perSec * (Math.exp(counter.mood) * MOOD_NORM + counter.hype) * pull;
      counter.value += poisson(rate * dt);
    }
  }

  if (counter.value !== null) {
    if (counter.introStart === null) counter.introStart = frameTs;
    const p = Math.min(1, (frameTs - counter.introStart) / INTRO_MS);
    if (reducedMotion.matches || counter.shown === null && p === 1) {
      counter.shown = counter.value;
    } else if (p < 1) {
      counter.shown = counter.value * (1 - (1 - p) ** 4); // beim Laden von 0 hochrollen
    } else {
      // Die Anzeige gleitet dem Zähler hinterher → bei viel Chat dreht die Einerwalze durchgehend
      counter.shown += (counter.value - counter.shown) * (1 - Math.exp(-dt / ROLL_TAU));
      if (counter.value - counter.shown < 0.002) counter.shown = counter.value;
    }
    renderOdometer(counter.shown, counter.value);
  }
  requestAnimationFrame(tickCounter);
}

// Zahl als Kilometerzähler: jede Stelle ist eine Walze (0–9), die stufenlos dreht.
// Eine Walze dreht nur weiter, während alle Walzen rechts von ihr von 9 auf 0 rollen – wie beim echten Zähler.
const INTRO_MS = 1600;
const ROLL_TAU = 0.35; // Sekunden, wie weich die Anzeige dem Zähler folgt
const WHEEL_EM = 1.1;  // Höhe einer Ziffer auf der Walze
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const odometer = { digits: 0, wheels: [], label: null };

function renderOdometer(v, exact) {
  const el = $('hero-messages');
  const label = fmt(exact);
  if (label !== odometer.label) {
    odometer.label = label;
    el.setAttribute('aria-label', `${label} Nachrichten`);
  }

  const digits = String(Math.max(0, Math.floor(v))).length;
  if (digits !== odometer.digits) {
    odometer.digits = digits;
    odometer.wheels = [];
    const parts = [];
    for (let k = digits - 1; k >= 0; k--) { // k = Stelle, 0 = Einer
      const strip = h('span', { class: 'odo-strip' }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => h('span', {}, d)));
      parts.push(h('span', { class: 'odo-wheel', 'aria-hidden': 'true' }, strip));
      odometer.wheels[k] = { strip, pos: null };
      if (k > 0 && k % 3 === 0) parts.push(h('span', { class: 'odo-sep', 'aria-hidden': 'true' }, '.'));
    }
    el.replaceChildren(...parts);
  }

  for (let k = 0; k < digits; k++) {
    const unit = 10 ** k;
    const whole = Math.floor(v / unit);
    const below = v - whole * unit;                // Stand der Walzen rechts davon
    const turn = Math.max(0, below - (unit - 1));  // 0…1, nur während die rechten Walzen von 9 auf 0 rollen
    const pos = (whole % 10) + turn;
    const wheel = odometer.wheels[k];
    if (wheel.pos !== null && Math.abs(pos - wheel.pos) < 0.001) continue;
    wheel.pos = pos;
    wheel.strip.style.transform = `translateY(${(-pos * WHEEL_EM).toFixed(4)}em)`;
  }
}
requestAnimationFrame(tickCounter);

// ---------- Laden ----------
function render() {
  $('test-notice').hidden = !stats.test;
  updateCounter();
  renderHeader();
  renderTotals();
  renderTabs();
  renderChart();
  renderDayTable();
  renderLists();
  renderRecords();
  renderEmoteChanges();
  $('app').setAttribute('aria-busy', 'false');
}

async function load() {
  try {
    const res = await fetch(`stats.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    stats = await res.json();
    render();
  } catch {
    if (!stats) $('running').textContent = 'Daten konnten nicht geladen werden.';
  }
}

load();
setInterval(load, REFRESH_MS);
setInterval(() => stats && renderHeader(), 30_000);
new ResizeObserver(() => stats && renderChart()).observe($('chart'));
