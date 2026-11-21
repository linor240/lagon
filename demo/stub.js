// Demo for the website: stands in for the Lagon app behind the page (window.lagon), with made-up
// data, so the real interface (copied from renderer/) runs in the browser. Hover opens it, as in Lagon.
// Query: ?open=<page> keeps it open on that page (screenshots) · ?idle=1 no music (little face)
(() => {
  const q = new URLSearchParams(location.search);
  const L = {};
  const on = (n) => (fn) => { (L[n] = L[n] || []).push(fn); return Promise.resolve(); };
  const fire = (n, v) => (L[n] || []).forEach((f) => f(v));
  const R = (v) => Promise.resolve(v);

  const settings = {
    openMode: 'hover', position: 'center', peekOnTrack: false, compactLyrics: true, volumeOsd: true,
    widgetMusic: true, widgetLyrics: true, widgetSound: true, widgetPc: true, widgetTime: true, idleFace: true,
    islandAttach: 'attached', islandStyle: 'opaque', glassOpacity: 60, hudBrightness: true, hudCaps: true, hudLang: true,
    hudBattery: true, hudWifi: true, hudBluetooth: true, hideInFullscreen: true, gpuAcceleration: false, gpuActive: false,
    faceSleepSeconds: 120, lyricsSize: 16, lyricsFont: 'segoe', pingHost: '1.1.1.1', idleMinutes: 5, islandScale: 100,
    widgetTwitch: true, twitchTicker: true, twitchClientId: '', display: 'primary', openAtLogin: true,
    widgetValorant: true, valoRiotId: 'Lagon#EUW', valoRegion: 'eu', valoPlatform: 'pc',
    musicPriority: true, focusMode: false, focusHotkey: 'ctrl+alt+f',
  };

  // album cover: a gradient drawn here (no real artwork)
  function cover() {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 160, 160);
    grad.addColorStop(0, '#dfb6b2');
    grad.addColorStop(0.5, '#854f6c');
    grad.addColorStop(1, '#2b124c');
    g.fillStyle = grad;
    g.fillRect(0, 0, 160, 160);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.arc(112, 46, 16, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 5;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let x = 0; x <= 160; x += 4) g.lineTo(x, 104 + k * 18 + Math.sin(x / 14 + k) * 6);
      g.stroke();
    }
    return c.toDataURL('image/png');
  }

  // an invented song with invented lines
  const DURATION = 3 * 60000 + 24000;
  const LINES = ['Le soleil se pose sur l’eau', 'On laisse filer les heures', 'Rien ne presse ce soir', 'Juste le bruit des vagues',
    'Et la lumière qui danse', 'On reste là, sans un mot', 'La marée revient doucement', 'Encore un peu de bleu'];
  const synced = [];
  for (let t = 4000, i = 0; t < DURATION; t += 4200, i++) synced.push({ t, text: LINES[i % LINES.length] });
  const media = {
    active: !q.get('idle'), playing: !q.get('idle'), title: 'Marée haute', artist: 'Les Lagons', album: 'Eau claire',
    app: 'Spotify.exe', durationMs: DURATION, positionMs: 52000, updatedAtMs: Date.now(), art: '',
  };
  const pos = () => (media.playing ? media.positionMs + Date.now() - media.updatedAtMs : media.positionMs) % DURATION;
  const pushMedia = () => { media.positionMs = pos(); media.updatedAtMs = Date.now(); fire('media:state', { ...media }); };

  const audio = {
    master: 0.62, muted: false,
    apps: [
      { key: 'spotify', name: 'Spotify', vol: 0.8, muted: false, active: true },
      { key: 'discord', name: 'Discord', vol: 0.55, muted: false, active: true },
      { key: 'valorant', name: 'VALORANT', vol: 0.7, muted: false, active: false },
      { key: 'chrome', name: 'Chrome', vol: 1, muted: false, active: false },
    ],
  };

  let statsTimer = null;
  const jitter = (v, d) => Math.round((v + (Math.random() - 0.5) * d) * 10) / 10;
  const sendStats = () => fire('sys:stats', {
    cpu: jitter(14, 8), gpu: Math.round(jitter(31, 10)), gpuTemp: Math.round(jitter(58, 3)), ramUsed: jitter(9.4, 0.2), ramTotal: 16,
    vramUsed: jitter(3.1, 0.1), vramTotal: 8, ping: Math.round(jitter(14, 4)), pingHost: '1.1.1.1',
  });

  function usage() {
    const today = new Date().getDay();
    const totals = [16200, 21400, 9800, 25100, 18300, 22600];
    const week = totals.map((t, i) => ({ day: (today + i + 1) % 7, total: t, today: false }));
    week.push({ day: today, total: 13500, today: true });
    return {
      total: 13500, week, current: 'valorant',
      apps: [
        { key: 'valorant', name: 'VALORANT', s: 5400 }, { key: 'chrome', name: 'Chrome', s: 3300 },
        { key: 'discord', name: 'Discord', s: 2400 }, { key: 'obs', name: 'OBS Studio', s: 1500 }, { key: 'spotify', name: 'Spotify', s: 900 },
      ],
    };
  }

  function sys(cmd) {
    const [k, a, b] = cmd.split(' ');
    if (k === 'stats') {
      clearInterval(statsTimer);
      statsTimer = a === '1' ? setInterval(sendStats, 1000) : null;
      if (a === '1') sendStats();
      return;
    }
    if (k === 'master') audio.master = +a / 100;
    else if (k === 'mute') audio.muted = a === '1';
    else if (k === 'app' || k === 'appmute') {
      const x = audio.apps.find((p) => p.key === a);
      if (x && k === 'app') x.vol = +b / 100;
      if (x && k === 'appmute') x.muted = b === '1';
    } else return;
    fire('sys:audio', JSON.parse(JSON.stringify(audio)));
  }

  function command(cmd) {
    if (!media.active) return;
    if (cmd === 'toggle') { media.positionMs = pos(); media.updatedAtMs = Date.now(); media.playing = !media.playing; }
    else if (cmd === 'next' || cmd === 'prev') { media.positionMs = 0; media.updatedAtMs = Date.now(); }
    else if (cmd.startsWith('seek ')) { media.positionMs = +cmd.slice(5); media.updatedAtMs = Date.now(); }
    else return;
    fire('media:state', { ...media });
  }

  const twitch = { status: { clientId: true, connected: true, login: 'lagon', pending: null, error: null },
    stats: { live: false, followers: 1284, today: 17, subs: 42, subsNote: '', viewers: null, startedAt: null } };
  const valorant = { hasKey: true, riotId: 'Lagon#EUW', error: null, updated: '21:40', stats: {
    name: 'Lagon', tag: 'EUW', tier: 18, tierName: 'Diamond 1', rr: 47, lastChange: 18, elo: 1547, leaderboard: null, needed: 0,
    peak: { tier: 21, tierName: 'Ascendant 1', rr: 12, season: 'e9a2' }, wins: 3, losses: 1, draws: 0, todayRR: 34 } };

  window.lagon = new Proxy({
    onState: on('media:state'), onLyrics: on('media:lyrics'), onHover: on('island:hover'), onAudio: on('sys:audio'),
    onStats: on('sys:stats'), onHud: on('sys:hud'), onLook: on('face:look'), onAway: on('face:away'),
    onSettings: on('settings:changed'), onPaused: on('island:paused'), onTwitchStatus: on('twitch:status'),
    onTwitchStats: on('twitch:stats'), onValorant: on('valorant:state'),
    getSettings: () => R({ ...settings }),
    setSetting: (k, v) => { settings[k] = v; fire('settings:changed', { ...settings }); return R({ ...settings }); },
    getUsage: () => R(usage()), getDisplays: () => R([{ id: 'primary', label: 'Écran 1', size: '2560×1440', primary: true }]),
    twitchStatus: () => R(twitch.status), valorantState: () => R(valorant), sys: (c) => { sys(c); return R(); },
    command: (c) => { command(c); return R(); },
  }, { get: (t, k) => t[k] || (() => R(null)) });

  window.addEventListener('DOMContentLoaded', () => {
    media.art = cover();
    const island = document.getElementById('island');
    setTimeout(() => {
      fire('settings:changed', { ...settings });
      pushMedia();
      if (media.active) fire('media:lyrics', { key: `${media.artist}|${media.title}`, synced });
      fire('sys:audio', JSON.parse(JSON.stringify(audio)));
      fire('twitch:status', twitch.status);
      fire('twitch:stats', twitch.stats);
      const open = q.get('open');
      if (open) {
        fire('island:hover', true);
        if (open === 'settings') document.querySelector('.gear').click();
        else document.querySelector(`.tabs button[data-page="${open}"]`)?.click();
        const cat = q.get('cat');
        if (cat) setTimeout(() => document.querySelector(`.s-nav button[data-cat="${cat}"]`)?.click(), 100);
        return; // stays open (screenshots)
      }
      // hover, like the cursor check of the real app
      let leaveTimer = null;
      island.addEventListener('mouseenter', () => { clearTimeout(leaveTimer); fire('island:hover', true); });
      island.addEventListener('mouseleave', () => { leaveTimer = setTimeout(() => fire('island:hover', false), 250); });
    }, 60);
  });
})();
