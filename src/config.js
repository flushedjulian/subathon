export const config = {
  channel: 'letshugotv',
  roomId: '117385099', // Twitch-ID von letshugotv, für die 7TV/BTTV/FFZ-Emotes

  // Subathon-Zeitraum. end: null = läuft noch.
  // Wird start geändert, verwirft der nächste Build automatisch alle bisherigen Daten.
  start: process.env.START ?? '2026-10-06T00:00:00+02:00',
  end: process.env.END ?? null,
  // Zeigt auf der Website einen Testlauf-Hinweis
  test: true,

  // Öffentliche Chat-Archive (justlog). Das erste ist die Hauptquelle für den laufenden Tag,
  // fertige Tage werden aus allen zusammengeführt.
  archives: ['https://logs.ivr.fi', 'https://logs.zonian.dev', 'https://logs.susgee.dev'],
  userAgent: 'subathon-stats (github.com/flushedjulian)',

  // Werden komplett ignoriert
  bots: [
    'streamelements', 'nightbot', 'moobot', 'fossabot', 'streamlabs',
    'soundalerts', 'wizebot', 'sery_bot', 'botrixoficial', 'kofistreambot',
  ],
  // Opt-out: tauchen in keiner Rangliste auf (Login, kleingeschrieben)
  optout: [],

  topEmotes: 30,
  topUsers: 10,
};
