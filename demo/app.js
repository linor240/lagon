const $ = (s) => document.querySelector(s);
const island = $('#island');
const el = {
  cArt: $('.c-art'), cText: $('.c-text'), cClock: $('.c-clock'),
  art: $('.art'), title: $('.title'), artist: $('.artist'), source: $('.source'),
  lyrics: $('.lyrics'), lCur: $('.l-cur'), lNext: $('.l-next'),
  pos: $('.t-pos'), dur: $('.t-dur'), bar: $('.bar'), fill: $('.fill'), knob: $('.knob'),
  eTime: $('.e-time'), eDate: $('.e-date'),
};

let state = { active: false };
let art = '';
let lyrics = null;      // { key, synced: [{t,text}], plain, instrumental }
let lyricIdx = -2;
let compactLine = null;
let hovering = false;
let peekTimer = null;
let paused = false; // true while hidden for a fullscreen app
// replaced by the saved settings as soon as the main process answers
let settings = {
  openMode: 'hover', position: 'center', peekOnTrack: true, compactLyrics: true, volumeOsd: true, idleFace: true, faceSleepSeconds: 120,
  widgetMusic: true, widgetLyrics: true, widgetSound: true, widgetPc: true, widgetTime: true,
  lyricsSize: 16, lyricsFont: 'segoe', pingHost: '1.1.1.1', idleMinutes: 5, openAtLogin: false,
};

const trackKey = (s) => (s && s.active ? `${s.artist}|${s.title}` : null);

// ---------- open / close ----------
function setOpen(open) {
  island.classList.toggle('open', open);
  window.lagon.setOpenState(open); // the main process hit-tests the open or the compact shape
  if (open) hideOsd();
  if (!open) {
    window.lagon.keyboard(false);
    // settings are a detour: next time the island opens on the last real page
    if (page === 'settings') setTimeout(() => { if (!island.classList.contains('open')) setPage(userPage, true); }, 450);
  }
  syncStats();
}

// The main process watches the cursor and tells us when it enters / leaves.
// "Au survol": entering opens. "Au clic": entering only makes it clickable (and grow a bit).
window.lagon.onHover((on) => {
  hovering = on;
  island.classList.toggle('hot', on);
  if (!on) { setOpen(false); return; }
  if (settings.focusMode) return; // focus: a thin line that never opens (a click brings the bar back)
  if (peekTimer) {
    // the pointer caught a song peek: keep it open
    clearTimeout(peekTimer);
    peekTimer = null;
    if (settings.openMode === 'hover') setPage(userPage, true);
  }
  if (settings.openMode === 'hover') setOpen(true);
});

island.addEventListener('click', () => {
  if (settings.focusMode) { window.lagon.setSetting('focusMode', false).then(applySettings); return; }
  if (settings.openMode !== 'click' || island.classList.contains('open')) return;
  setPage(userPage, true);
  setOpen(true);
});

// Sizes must match style.css (#island, #island.idle, #island.idle.face-mode, --open-w / --open-h).
let sentSizes = '';
function sendSizes(idle) {
  const focus = !!settings.focusMode;
  const w = focus ? 64 : !idle ? 290 : settings.idleFace ? 184 : 132;
  const gap = settings.islandAttach === 'floating' ? 8 : 0; // floating: the island starts 8px lower
  const tickerRow = island.classList.contains('ticker-on') ? 22 : 0; // live ticker under the closed island
  const h = focus ? 6 : 36 + tickerRow; // keep in sync with #island.focus in style.css
  const sizes = { compact: { w, h: h + gap }, open: { w: 540, h: 228 + gap } };
  if (JSON.stringify(sizes) === sentSizes) return;
  sentSizes = JSON.stringify(sizes);
  window.lagon.setSizes(sizes);
}

// Briefly show the music card when a new song starts.
function peek() {
  if (hovering || !settings.peekOnTrack || settings.focusMode) return;
  setPage('music', true, false);
  setOpen(true);
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (!hovering) { setOpen(false); setTimeout(() => setPage(userPage, true), 450); }
  }, 3500);
}

// ---------- pages ----------
const PAGES = ['music', 'sound', 'pc', 'time', 'twitch', 'obs', 'valorant', 'discord', 'settings'];
let page = 'music';
let userPage = 'music'; // the page the user picked last; peeks and settings don't change it
const pagesEl = $('.pages');
const tabs = [...document.querySelectorAll('.tabs button')];
const gear = $('.gear');

function setPage(name, instant = false, byUser = true) {
  page = name;
  if (byUser) userPage = name;
  pagesEl.classList.toggle('instant', instant);
  pagesEl.style.setProperty('--page', PAGES.indexOf(name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('current', p.classList.contains(name)));
  tabs.forEach((t) => t.classList.toggle('on', t.dataset.page === name));
  gear.classList.toggle('on', name === 'settings');
  if (instant) requestAnimationFrame(() => pagesEl.classList.remove('instant'));
  if (name === 'settings') renderDisplays(); // screens may have been plugged in or out
  syncStats();
}
tabs.forEach((t) => t.addEventListener('click', () => setPage(t.dataset.page)));
gear.addEventListener('click', () => {
  if (page === 'settings') setPage(userPage);
  else setPage('settings', false, false);
});

// PC stats are only collected while the PC page is on screen
// (querying the NVIDIA card would otherwise keep it awake on a laptop).
let statsOn = false;
let usageTimer = null; // refreshes the screen time page while it is shown
function syncStats() {
  syncUsage();
  const want = island.classList.contains('open') && page === 'pc';
  if (want === statsOn) return;
  statsOn = want;
  window.lagon.sys(`stats ${want ? 1 : 0}`);
}
setPage('music', true);

// ---------- media state ----------
window.lagon.onState((s) => {
  const prevKey = trackKey(state);
  if (s.art !== undefined) art = s.art || '';
  if (!s.active) art = '';
  state = s;

  const key = trackKey(s);
  if (key !== prevKey) {
    lyrics = null;
    lyricIdx = -2;
    if (key) peek();
  }
  render();
});

window.lagon.onLyrics((l) => {
  if (l.key !== trackKey(state)) return;
  lyrics = l;
  lyricIdx = -2;
  tick();
});

// "Idle" = nothing is actually playing: no media at all, or paused for a few seconds
// (a paused Spotify keeps its session open). The closed notch then shows the clock and the face;
// the open card still shows the paused player so it can be resumed.
const PAUSE_GRACE_MS = 3000;
let pausedSince = 0;
let idleTimer = null;

function computeIdle() {
  if (!state.active) return true;
  if (state.playing) { pausedSince = 0; return false; }
  if (!pausedSince) pausedSince = Date.now();
  const left = PAUSE_GRACE_MS - (Date.now() - pausedSince);
  if (left > 0) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(render, left + 20);
    return false;
  }
  return true;
}

function render() {
  const idle = computeIdle();
  island.classList.toggle('idle', idle);
  island.classList.toggle('no-media', !state.active);
  sendSizes(idle);
  island.classList.toggle('playing', !!(state.active && state.playing));
  if (!state.active) return;

  if (el.art.getAttribute('src') !== art) {
    el.art.src = art;
    el.cArt.src = art;
    if (art) pickAccent(art);
  }
  el.title.textContent = state.title || '';
  el.artist.textContent = [state.artist, state.album].filter(Boolean).join(' — ');
  el.source.textContent = appName(state.app);
  el.dur.textContent = fmt(state.durationMs);
  tick();
}

function appName(id = '') {
  const s = id.toLowerCase();
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('chrome')) return 'Chrome';
  if (s.includes('msedge')) return 'Edge';
  if (s.includes('firefox')) return 'Firefox';
  if (s.includes('zune') || s.includes('media')) return 'Lecteur multimédia';
  if (s.includes('applemusic') || s.includes('itunes')) return 'Apple Music';
  if (s.includes('deezer')) return 'Deezer';
  if (s.includes('tidal')) return 'TIDAL';
  return id.split('!').pop().replace(/\.exe$/i, '');
}

// ---------- position, progress, lyrics ----------
function currentPos() {
  if (!state.active) return 0;
  let p = state.positionMs || 0;
  if (state.playing && state.updatedAtMs) p += Date.now() - state.updatedAtMs;
  if (state.durationMs > 0) p = Math.min(p, state.durationMs);
  return Math.max(0, p);
}

function tick() {
  updateClock();
  if (!state.active) return;
  const pos = currentPos();
  if (island.classList.contains('open')) { // the progress bar is only visible in the open card
    const pct = state.durationMs > 0 ? (pos / state.durationMs) * 100 : 0;
    el.fill.style.width = pct + '%';
    el.knob.style.left = pct + '%';
    el.pos.textContent = fmt(pos);
  }
  updateLyrics(pos);
}

function updateLyrics(pos) {
  let cur = '', next = '', idx = -1, plain = false;

  if (lyrics && lyrics.synced && lyrics.synced.length) {
    const L = lyrics.synced;
    // last line whose time has passed (lines are sorted)
    let lo = 0, hi = L.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= pos + 150) { idx = m; lo = m + 1; } else hi = m - 1; }
    cur = idx >= 0 ? L[idx].text || '♪' : '♪';
    const n = L.slice(idx + 1).find((x) => x.text);
    next = n ? n.text : '';
  } else if (lyrics && lyrics.instrumental) {
    cur = 'Instrumental ♪'; idx = -3;
  } else if (lyrics && lyrics.plain) {
    cur = 'Paroles disponibles, mais non synchronisées'; idx = -4; plain = true;
  } else if (lyrics) {
    cur = 'Pas de paroles trouvées'; idx = -5; plain = true;
  } else {
    cur = 'Recherche des paroles…'; idx = -6; plain = true;
  }

  if (idx !== lyricIdx) {
    lyricIdx = idx;
    el.lyrics.classList.toggle('plain', plain);
    el.lyrics.classList.add('shift');
    el.lCur.textContent = cur;
    el.lNext.textContent = next;
    void el.lyrics.offsetWidth; // restart the slide-in
    el.lyrics.classList.remove('shift');
  }

  // compact pill: the current lyric line if there is one, otherwise the song
  const hasLine = settings.widgetLyrics && settings.compactLyrics && lyrics && lyrics.synced && lyrics.synced.length && idx >= 0 && lyrics.synced[idx].text;
  const line = hasLine ? lyrics.synced[idx].text : `${state.title}${state.artist ? ' · ' + state.artist : ''}`;
  if (line !== compactLine) {
    compactLine = line;
    el.cText.classList.add('swap');
    setTimeout(() => {
      el.cText.textContent = line;
      el.cText.classList.toggle('lyric', !!hasLine); // lyric lines use the lyrics font
      el.cText.classList.remove('swap');
    }, 120);
  }
}

function updateClock() {
  const now = new Date();
  const hm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (el.cClock.textContent !== hm) {
    el.cClock.textContent = hm;
    el.eTime.textContent = hm;
    el.eDate.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
}

function fmt(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

let tickTimer = setInterval(tick, 120);

// ---------- controls ----------
document.querySelectorAll('.controls button').forEach((b) => {
  b.addEventListener('click', () => {
    const cmd = b.dataset.cmd;
    if (cmd === 'toggle' && state.active) {
      // optimistic: flip right away, the bridge confirms a moment later
      state.positionMs = currentPos();
      state.updatedAtMs = Date.now();
      state.playing = !state.playing;
      render();
    }
    window.lagon.command(cmd);
  });
});

el.bar.addEventListener('click', (e) => {
  if (!state.active || !(state.durationMs > 0)) return;
  const r = el.bar.getBoundingClientRect();
  const ms = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * state.durationMs);
  state.positionMs = ms;
  state.updatedAtMs = Date.now();
  lyricIdx = -2;
  tick();
  window.lagon.command(`seek ${ms}`);
});

// ---------- colours from the artwork ----------
// Two dominant vivid colours: --c1 / --c2 drive the background gradient,
// --accent (a lighter c1) drives the equalizer, progress bar and glow.
function pickAccent(src) {
  const img = new Image();
  img.onload = () => {
    const N = 32, BINS = 18;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;

    const bins = Array.from({ length: BINS }, (_, i) => ({ i, w: 0, r: 0, g: 0, b: 0 }));
    let satSum = 0, count = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      satSum += s; count++;
      if (l < 0.1 || l > 0.95) continue;               // near black / white: no hue
      const w = Math.pow(s, 1.5) * (1 - Math.abs(l - 0.5)); // vivid, mid-light pixels count most
      const bin = bins[Math.floor(h * BINS) % BINS];
      bin.w += w; bin.r += d[i] * w; bin.g += d[i + 1] * w; bin.b += d[i + 2] * w;
    }
    const ranked = bins.filter((b) => b.w > 0).sort((a, b) => b.w - a.w);
    const root = document.documentElement.style;

    if (!ranked.length || satSum / count < 0.08) {        // greyscale cover
      root.setProperty('--c1', 'hsl(230 8% 42%)');
      root.setProperty('--c2', 'hsl(230 6% 26%)');
      root.setProperty('--accent', '#e8e8ed');
      return;
    }
    const avg = (b) => rgbToHsl(b.r / b.w, b.g / b.w, b.b / b.w);
    const top = ranked[0];
    const far = (b) => Math.min(Math.abs(b.i - top.i), BINS - Math.abs(b.i - top.i)) >= 2;
    const second = ranked.find((b) => b !== top && far(b) && b.w > top.w * 0.12);

    const [h1, s1] = avg(top);
    const [h2, s2] = second ? avg(second) : [(h1 + 0.08) % 1, s1];
    const hsl = (h, s, l) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
    root.setProperty('--c1', hsl(h1, Math.max(0.55, s1), 0.5));
    root.setProperty('--c2', hsl(h2, Math.max(0.5, s2), second ? 0.45 : 0.32));
    root.setProperty('--accent', hsl(h1, Math.max(0.5, s1), 0.7));
  };
  img.src = src;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

// ---------- sound ----------
const snd = { spk: $('.master .spk'), master: $('.master input'), masterPct: $('.master .pct'), apps: $('.apps') };
const osd = { icon: $('.o-icon'), fill: $('.o-fill'), pct: $('.o-pct'), title: $('.o-title'), sub: $('.o-sub') };
let audio = null;
let lastLocal = 0;   // when we last changed a volume ourselves (no pop-up for those)
let osdTimer = null;
let appKeys = null;

function speakerSvg(level, muted) {
  const waves = muted
    ? '<path d="M16 9.5l5 5M21 9.5l-5 5"/>'
    : (level > 0.01 ? '<path d="M15.5 9a4 4 0 0 1 0 6"/>' : '') + (level > 0.5 ? '<path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>' : '');
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor"/>${waves}</svg>`;
}

const dragging = (input) => input.dataset.drag === '1';
window.addEventListener('pointerup', () => document.querySelectorAll('input[data-drag]').forEach((i) => delete i.dataset.drag));

function paintSlider(input, pct) {
  input.value = pct;
  input.style.setProperty('--p', pct + '%');
}

// Sends at most ~30 commands per second while dragging; mouse wheel steps by 2 %.
function bindSlider(input, toCommand, onLocal) {
  let pending = null, timer = null;
  const flush = () => { timer = null; if (pending === null) return; lastLocal = Date.now(); window.lagon.sys(toCommand(pending)); pending = null; };
  const set = (pct) => {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    paintSlider(input, pct);
    if (onLocal) onLocal(pct);
    pending = (pct / 100).toFixed(3);
    if (!timer) timer = setTimeout(flush, 33);
  };
  input.addEventListener('pointerdown', () => { input.dataset.drag = '1'; });
  input.addEventListener('input', () => set(+input.value));
  input.addEventListener('wheel', (e) => { e.preventDefault(); set(+input.value + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
}

bindSlider(snd.master, (v) => `master ${v}`, (pct) => { snd.masterPct.textContent = pct + '%'; });
snd.spk.addEventListener('click', () => {
  if (!audio) return;
  lastLocal = Date.now();
  window.lagon.sys(`mute ${audio.muted ? 0 : 1}`);
});

window.lagon.onAudio((a) => {
  const prev = audio;
  audio = a;
  if (!dragging(snd.master)) {
    paintSlider(snd.master, Math.round(a.master * 100));
    snd.masterPct.textContent = a.muted ? 'Muet' : Math.round(a.master * 100) + '%';
  }
  const spk = speakerSvg(a.master, a.muted);
  if (snd.spk.dataset.svg !== spk) { snd.spk.dataset.svg = spk; snd.spk.innerHTML = spk; }
  snd.master.parentElement.classList.toggle('muted-row', a.muted);

  // volume keys / Windows mixer changed the volume: show the pill indicator
  const changed = prev && (Math.abs(prev.master - a.master) > 0.004 || prev.muted !== a.muted);
  if (changed && Date.now() - lastLocal > 800) showOsd();
  else if (island.classList.contains('osd')) paintOsd();

  renderApps(a.apps || []);
});

function renderApps(apps) {
  const keys = apps.map((x) => x.key).join('|');
  if (keys !== appKeys) {
    appKeys = keys;
    snd.apps.textContent = '';
    if (!apps.length) {
      const empty = document.createElement('div');
      empty.className = 'apps-empty';
      empty.textContent = 'Aucune application n’utilise le son pour l’instant';
      snd.apps.appendChild(empty);
    }
    for (const a of apps) {
      const row = document.createElement('div');
      row.className = 'app-row';
      row.dataset.key = a.key;
      const icon = document.createElement('button');
      icon.className = 'app-icon';
      icon.title = 'Couper / rétablir';
      icon.addEventListener('click', () => {
        const cur = audio && audio.apps.find((x) => x.key === a.key);
        lastLocal = Date.now();
        window.lagon.sys(`appmute ${a.key} ${cur && cur.muted ? 0 : 1}`);
      });
      const name = document.createElement('span');
      name.className = 'app-name';
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: 0, max: 100, step: 1 });
      input.setAttribute('aria-label', `Volume ${a.name}`);
      const pct = document.createElement('span');
      pct.className = 'pct';
      bindSlider(input, (v) => `app ${a.key} ${v}`, (p) => { pct.textContent = p + '%'; });
      row.append(icon, name, input, pct);
      snd.apps.appendChild(row);
    }
  }
  for (const a of apps) {
    const row = [...snd.apps.children].find((r) => r.dataset.key === a.key);
    if (!row) continue;
    row.classList.toggle('inactive', !a.active);
    row.classList.toggle('muted-row', a.muted);
    const [icon, name, input, pct] = row.children;
    if (a.icon && icon.dataset.src !== a.icon) {
      icon.dataset.src = a.icon;
      const img = document.createElement('img');
      img.alt = '';
      img.src = a.icon;
      icon.replaceChildren(img);
    } else if (!a.icon && !icon.dataset.src) {
      icon.textContent = (a.name || '?').slice(0, 1).toUpperCase();
    }
    name.textContent = a.name;
    name.title = a.name;
    if (!dragging(input)) {
      paintSlider(input, Math.round(a.vol * 100));
      pct.textContent = Math.round(a.vol * 100) + '%';
    }
  }
}

// ---------- pop-ups (HUD) in the closed island ----------
// h = { kind, icon (svg), title?, sub?, bar? (0..1 -> bar layout), value?, tone? ('ok'|'warn'|'hot'), muted? }
let hudKind = null;
function renderHud(h) {
  island.classList.toggle('osd-text', h.bar == null);
  osd.icon.className = 'o-icon' + (h.tone ? ' ' + h.tone : '');
  osd.icon.innerHTML = h.icon;
  osd.title.textContent = h.title || '';
  osd.sub.textContent = h.sub || '';
  osd.fill.style.width = (h.bar == null ? 0 : h.bar * 100) + '%';
  osd.pct.textContent = h.value == null ? '' : h.value;
  island.classList.toggle('muted', !!h.muted);
}
function showHud(h, ms = 1800) {
  if (island.classList.contains('open') || settings.focusMode) return;
  hudKind = h.kind;
  island.classList.add('osd');
  renderHud(h);
  clearTimeout(osdTimer);
  osdTimer = setTimeout(hideOsd, ms);
}
function hideOsd() {
  clearTimeout(osdTimer);
  hudKind = null;
  island.classList.remove('osd', 'osd-text');
}

const volumeHud = () => ({
  kind: 'volume', icon: speakerSvg(audio.master, audio.muted), bar: audio.muted ? 0 : audio.master,
  value: audio.muted ? 'Muet' : Math.round(audio.master * 100), muted: audio.muted,
});
function showOsd() {
  if (!audio || !settings.volumeOsd) return;
  showHud(volumeHud(), 1600);
}
function paintOsd() {
  if (audio && hudKind === 'volume') renderHud(volumeHud());
}

const svg = (body, fill = 'none') => `<svg viewBox="0 0 24 24" width="18" height="18" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  sun: () => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  caps: () => svg('<path d="M12 4 4 12h4.5v4h7v-4H20z"/><path d="M8.5 20h7"/>'),
  keyboard: () => svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>'),
  battery: (pct, charging) => svg(`<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/>`
    + `<rect x="4.5" y="9" width="${Math.max(1, 13 * pct / 100).toFixed(1)}" height="6" rx="1" fill="currentColor" stroke="none"/>`
    + (charging ? '<path d="M11.5 8.5 9.5 12h3l-2 3.5" stroke="#000" stroke-width="1.6"/>' : '')),
  wifi: (bars) => {
    const on = (n) => (bars < 0 || bars >= n ? 'currentColor' : 'rgba(255,255,255,0.25)');
    return svg(`<path d="M2.5 9a14 14 0 0 1 19 0" stroke="${on(4)}"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" stroke="${on(3)}"/>`
      + `<path d="M8.5 16a5 5 0 0 1 7 0" stroke="${on(2)}"/><circle cx="12" cy="19.2" r="1" fill="currentColor" stroke="none"/>`);
  },
  ethernet: () => svg('<rect x="8" y="3" width="8" height="6" rx="1"/><path d="M12 9v4M5 13h14M5 13v4M12 13v4M19 13v4"/><rect x="3" y="17" width="4" height="4" rx="1"/><rect x="10" y="17" width="4" height="4" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/>'),
  offline: () => svg('<path d="M2.5 9a14 14 0 0 1 19 0M8.5 16a5 5 0 0 1 7 0M3 3l18 18"/>'),
  headphones: () => svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>'),
};

const HUD_SETTING = { bright: 'hudBrightness', caps: 'hudCaps', lang: 'hudLang', battery: 'hudBattery', net: 'hudWifi', bt: 'hudBluetooth' };

// {"t":"hud","kind":...} from the helper -> what the pop-up shows
function hudFor(m) {
  switch (m.kind) {
    case 'bright':
      return { kind: 'bright', icon: ICONS.sun(), bar: m.value / 100, value: m.value };
    case 'caps':
      return { kind: 'caps', icon: ICONS.caps(), title: m.on ? 'Verr. Maj. activé' : 'Verr. Maj. désactivé', tone: m.on ? 'warn' : '' };
    case 'lang':
      // "Clavier FR (US)": the language, then the keyboard layout (as Windows writes FRA (US))
      return { kind: 'lang', icon: ICONS.keyboard(), title: `Clavier ${m.code}${m.layout ? ` (${m.layout})` : ''}`,
        sub: m.layoutName || m.name };
    case 'battery': {
      const t = { plug: 'En charge', unplug: 'Sur batterie', low: 'Batterie faible', full: 'Batterie chargée' }[m.event] || 'Batterie';
      const tone = m.event === 'low' ? (m.pct <= 10 ? 'hot' : 'warn') : m.charging ? 'ok' : '';
      return { kind: 'battery', icon: ICONS.battery(m.pct, m.charging), title: t, value: `${m.pct} %`, tone };
    }
    case 'net':
      if (m.state === 'wifi') return { kind: 'net', icon: ICONS.wifi(m.bars), title: 'Wi-Fi connecté', sub: m.name, tone: 'ok' };
      if (m.state === 'ethernet') return { kind: 'net', icon: ICONS.ethernet(), title: 'Ethernet connecté', tone: 'ok' };
      return { kind: 'net', icon: ICONS.offline(), title: 'Déconnecté', sub: 'Pas de connexion Internet', tone: 'warn' };
    case 'bt':
      return { kind: 'bt', icon: ICONS.headphones(), title: m.connected ? 'Casque connecté' : 'Casque déconnecté', sub: m.name, tone: m.connected ? 'ok' : '' };
  }
  return null;
}

window.lagon.onHud((m) => {
  if (!settings[HUD_SETTING[m.kind]]) return;
  const h = hudFor(m);
  if (h) showHud(h, m.kind === 'bright' ? 1600 : 2600);
});

// ---------- PC stats ----------
const tiles = {};
document.querySelectorAll('.pc .tile').forEach((t) => {
  tiles[t.dataset.stat] = { el: t, v: t.querySelector('.v'), s: t.querySelector('.s'), b: t.querySelector('.b i') };
});
const nf = (n, d = 1) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// value: [big number, small unit]; level: 0 normal, 1 warning, 2 hot
function setTile(name, value, sub, frac, level = 0) {
  const t = tiles[name];
  if (value) {
    const small = document.createElement('small');
    small.textContent = value[1];
    t.v.replaceChildren(document.createTextNode(value[0]), small);
  } else {
    t.v.textContent = '–';
  }
  t.s.textContent = sub || ' ';
  t.b.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + '%';
  t.el.classList.toggle('warn', level === 1);
  t.el.classList.toggle('hot', level === 2);
}

window.lagon.onStats((s) => {
  setTile('cpu', s.cpu >= 0 ? [Math.round(s.cpu), '%'] : null, 'utilisation', s.cpu / 100, s.cpu > 90 ? 1 : 0);
  setTile('gpu', s.gpu >= 0 ? [s.gpu, '%'] : null, s.gpu >= 0 ? 'carte NVIDIA' : 'indisponible', s.gpu / 100);
  const t = s.gpuTemp;
  setTile('gpuTemp', t >= 0 ? [t, '°C'] : null, t < 0 ? 'indisponible' : t >= 87 ? 'très chaud' : t >= 78 ? 'chaud' : 'normal', t / 100, t >= 87 ? 2 : t >= 78 ? 1 : 0);
  const ram = s.ramUsed / s.ramTotal;
  setTile('ram', [nf(s.ramUsed), ` / ${nf(s.ramTotal, 0)} Go`], `${Math.round(ram * 100)} % utilisés`, ram, ram > 0.9 ? 1 : 0);
  const vram = s.vramTotal > 0 ? s.vramUsed / s.vramTotal : 0;
  setTile('vram', s.vramUsed >= 0 ? [nf(s.vramUsed), ` / ${nf(s.vramTotal, 0)} Go`] : null, s.vramUsed >= 0 ? `${Math.round(vram * 100)} % utilisés` : 'indisponible', vram, vram > 0.9 ? 1 : 0);
  setTile('ping', s.ping >= 0 ? [s.ping, ' ms'] : null, s.ping >= 0 ? s.pingHost : 'pas de réponse', Math.min(1, s.ping / 150), s.ping > 100 ? 2 : s.ping > 60 ? 1 : 0);
});

// ---------- screen time ----------
const DAY_LETTERS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']; // indexed by Date.getDay()

// 42 s -> "< 1 min", 754 s -> "12 min", 11100 s -> "3 h 05"
function fmtDur(s) {
  const m = Math.floor(s / 60);
  if (m < 1) return '< 1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function syncUsage() {
  const want = island.classList.contains('open') && page === 'time';
  if (want && !usageTimer) {
    refreshUsage();
    usageTimer = setInterval(refreshUsage, 5000);
  } else if (!want && usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

async function refreshUsage() {
  const u = await window.lagon.getUsage();
  if (u) renderUsage(u);
}

function renderUsage(u) {
  const total = $('.t-total');
  const m = Math.floor(u.total / 60);
  if (m >= 60) {
    const small = document.createElement('small');
    small.textContent = ` h ${String(m % 60).padStart(2, '0')}`;
    total.replaceChildren(document.createTextNode(Math.floor(m / 60)), small);
  } else {
    const small = document.createElement('small');
    small.textContent = ' min';
    total.replaceChildren(document.createTextNode(m < 1 ? '< 1' : m), small);
  }
  const yesterday = u.week[5].total;
  $('.t-sub').textContent = yesterday > 0 ? `aujourd’hui · hier ${fmtDur(yesterday)}` : 'aujourd’hui';

  // last 7 days
  const max = Math.max(3600, ...u.week.map((d) => d.total));
  const week = $('.week');
  week.replaceChildren(...u.week.map((d) => {
    const col = document.createElement('div');
    col.className = 'd' + (d.today ? ' today' : '');
    col.title = d.total ? fmtDur(d.total) : 'pas de données';
    const wrap = document.createElement('div');
    wrap.className = 'col';
    const bar = document.createElement('div');
    bar.className = 'bar-d';
    bar.style.height = d.total ? `max(3px, ${(d.total / max) * 100}%)` : '0';
    wrap.appendChild(bar);
    const l = document.createElement('span');
    l.className = 'l';
    l.textContent = DAY_LETTERS[d.day];
    col.append(wrap, l);
    return col;
  }));

  // top apps today
  const list = $('.t-apps');
  if (!u.apps.length) {
    const p = document.createElement('div');
    p.className = 't-empty';
    p.textContent = 'Le compteur vient de démarrer : tes applis apparaîtront ici après quelques minutes d’utilisation.';
    list.replaceChildren(p);
    return;
  }
  const top = u.apps[0].s || 1;
  list.replaceChildren(...u.apps.map((a) => {
    const row = document.createElement('div');
    row.className = 't-row' + (a.key === u.current ? ' now' : '');
    const icon = document.createElement('div');
    icon.className = 'app-icon';
    if (a.icon) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = a.icon;
      icon.appendChild(img);
    } else {
      icon.textContent = (a.name || '?').slice(0, 1).toUpperCase();
    }
    const mid = document.createElement('div');
    mid.className = 't-mid';
    const name = document.createElement('span');
    name.className = 't-name';
    name.textContent = a.name;
    const bar = document.createElement('div');
    bar.className = 't-bar';
    const fill = document.createElement('i');
    fill.style.width = (a.s / top) * 100 + '%';
    bar.appendChild(fill);
    mid.append(name, bar);
    const time = document.createElement('span');
    time.className = 't-time';
    time.textContent = fmtDur(a.s);
    row.append(icon, mid, time);
    return row;
  }));
}


// ---------- settings ----------
const settingsPage = $('.page.settings');

// categories: the list on the left picks which panel shows on the right
const catButtons = [...settingsPage.querySelectorAll('.s-nav button')];
const catPanels = [...settingsPage.querySelectorAll('.s-panel')];
function showCategory(cat) {
  catButtons.forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
  catPanels.forEach((p) => p.classList.toggle('on', p.dataset.cat === cat));
}
catButtons.forEach((b) => b.addEventListener('click', () => showCategory(b.dataset.cat)));
const pingInput = $('.ping-host');
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;

function applySettings(s) {
  if (!s) return;
  settings = s;
  settingsPage.querySelectorAll('input[data-setting]').forEach((i) => { i.checked = !!s[i.dataset.setting]; });
  settingsPage.querySelectorAll('[data-setting] button').forEach((b) => {
    b.classList.toggle('on', String(s[b.parentElement.dataset.setting]) === b.dataset.v);
  });
  if (document.activeElement !== pingInput) { pingInput.value = s.pingHost; pingInput.classList.remove('bad'); }
  if (document.activeElement !== vlId) { vlId.value = s.valoRiotId || ''; vlId.classList.remove('bad'); }

  document.body.dataset.pos = s.position;
  // GPU option: changing it needs a restart
  $('.restart-row').hidden = s.gpuAcceleration === s.gpuActive;
  document.body.dataset.attach = s.islandAttach;
  document.body.dataset.style = s.islandStyle;
  document.documentElement.style.setProperty('--glass-a', (s.glassOpacity / 100).toFixed(2));
  // options of a widget that is off are greyed out (its category name too)
  const needs = { ...s, styleGlass: s.islandStyle === 'glass' };
  settingsPage.querySelectorAll('[data-needs]').forEach((el) => el.classList.toggle('off', !needs[el.dataset.needs]));
  catButtons.forEach((b) => {
    const panel = catPanels.find((p) => p.dataset.cat === b.dataset.cat);
    b.classList.toggle('dim', !!panel && panel.classList.contains('off'));
  });
  applyWidgets();
  island.classList.toggle('click-mode', s.openMode === 'click');
  island.classList.toggle('focus', !!s.focusMode);
  if (typeof renderDiscord === 'function') renderDiscord();
  if (s.focusMode) { hideOsd(); if (island.classList.contains('open') && !hovering) setOpen(false); }
  if (typeof syncTicker === 'function') syncTicker();
  const root = document.documentElement.style;
  root.setProperty('--lyric-size', s.lyricsSize + 'px');
  root.setProperty('--lyric-font', `var(--font-${s.lyricsFont})`);

  compactLine = null; // re-evaluate the compact text (lyrics on/off)
  tick();
}
window.lagon.getSettings().then(applySettings);
window.lagon.onSettings(applySettings);

settingsPage.querySelectorAll('input[data-setting]').forEach((i) => {
  i.addEventListener('change', () => window.lagon.setSetting(i.dataset.setting, i.checked).then(applySettings));
});
// segmented controls and font chips: <div data-setting="key" [data-type="num"]><button data-v="…">
function bindChoice(b) {
  b.addEventListener('click', () => {
    // looked up on click: the screen buttons are bound before they are put in their group
    const group = b.closest('[data-setting]');
    if (!group) return;
    const value = group.dataset.type === 'num' ? +b.dataset.v : b.dataset.v;
    window.lagon.setSetting(group.dataset.setting, value).then(applySettings);
  });
}
settingsPage.querySelectorAll('[data-setting] button').forEach(bindChoice);

// Screen choice: one button per connected screen (the main one is stored as "primary", so it
// stays right even if Windows renumbers the screens).
function renderDisplays() {
  if (!window.lagon.getDisplays) return;
  window.lagon.getDisplays().then((list) => {
    const box = $('.displays');
    box.replaceChildren(...list.map((d) => {
      const b = document.createElement('button');
      b.dataset.v = d.primary ? 'primary' : d.id;
      b.textContent = d.label + (d.primary ? ' · principal' : '');
      b.title = d.size;
      bindChoice(b);
      return b;
    }));
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings.display) === b.dataset.v));
  });
}

// Typing needs keyboard focus, which the window normally refuses (so games keep it).
pingInput.addEventListener('pointerdown', () => window.lagon.keyboard(true));
pingInput.addEventListener('input', () => pingInput.classList.toggle('bad', !HOST_RE.test(pingInput.value.trim())));
pingInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pingInput.blur();
  if (e.key === 'Escape') { pingInput.value = settings.pingHost; pingInput.blur(); }
});
pingInput.addEventListener('blur', () => {
  window.lagon.keyboard(false);
  const v = pingInput.value.trim();
  if (HOST_RE.test(v) && v !== settings.pingHost) window.lagon.setSetting('pingHost', v).then(applySettings);
  else { pingInput.value = settings.pingHost; pingInput.classList.remove('bad'); }
});


// ---------- little face ----------
// Shown in the closed island when nothing plays. Blinks, looks around, follows the mouse,
// smiles now and then, falls asleep while you are away and wakes up surprised.
const face = $('.face');
let faceTimer = null;
let lastLookAt = 0;     // last time the mouse moved the eyes
let lookTimer = null;
let asleep = false;
let faceWasActive = null;

const faceVisible = () => settings.idleFace && island.classList.contains('idle')
  && !island.classList.contains('open') && !island.classList.contains('osd');

// one-shot expression: add a class for a moment
function momentary(cls, ms) {
  face.classList.add(cls);
  setTimeout(() => face.classList.remove(cls), ms);
}
const blink = () => momentary('blink', 120);

function setLook(x, y) {
  face.style.setProperty('--lx', x.toFixed(2));
  face.style.setProperty('--ly', y.toFixed(2));
}

function faceAct() {
  faceTimer = setTimeout(faceAct, 1600 + Math.random() * 3800);
  if (paused) return;
  if (!faceVisible() || asleep) return;
  const r = Math.random();
  if (r < 0.42) blink();
  else if (r < 0.58) { blink(); setTimeout(blink, 240); }   // double blink
  else if (r < 0.68) momentary('wink', 420);
  else if (r < 0.86 && Date.now() - lastLookAt > 3000) {     // glance left/right (if the mouse isn't leading)
    const dir = Math.random() < 0.5 ? -1 : 1;
    setLook(dir, Math.random() < 0.3 ? -0.6 : 0);
    clearTimeout(lookTimer);
    lookTimer = setTimeout(() => { if (Date.now() - lastLookAt > 900) setLook(0, 0); }, 900 + Math.random() * 700);
  } else momentary('happy', 1500);
}
faceAct();

// the main process streams where the cursor is while the face is visible
window.lagon.onLook(({ x, y }) => {
  if (asleep) return;
  lastLookAt = Date.now();
  setLook(x, y);
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => setLook(0, 0), 2200); // mouse stopped: relax
});

// Away (no input for the face delay, or PC locked):
//   two heavy blinks -> slides to the centre while the clock fades -> eyes close, z's float up.
// Back:
//   eyes pop open, surprised hop -> slides back left of the clock -> happy.
let awaySeq = [];
function sequence(steps) {
  awaySeq.forEach(clearTimeout);
  awaySeq = steps.map(([ms, fn]) => setTimeout(fn, ms));
}

window.lagon.onAway((away) => {
  if (away === asleep) return;
  asleep = away;
  if (away) {
    setLook(0, 0);
    face.classList.remove('happy', 'surprised');
    sequence([
      [0, () => face.classList.add('drowsy')],
      [550, () => face.classList.remove('drowsy')],
      [900, () => face.classList.add('drowsy')],
      [1500, () => { face.classList.remove('drowsy'); island.classList.add('face-center'); }],
      [2300, () => face.classList.add('sleep')],
    ]);
  } else {
    face.classList.remove('drowsy', 'sleep', 'happy');
    sequence([
      [0, () => momentary('surprised', 650)],
      [500, () => island.classList.remove('face-center')],
      [1150, () => momentary('happy', 1300)],
    ]);
  }
});

// keep the main process informed so it only streams the cursor when it matters
function syncFace() {
  island.classList.toggle('face-mode', !!settings.idleFace);
  sendSizes(island.classList.contains('idle'));
  const active = faceVisible();
  if (active !== faceWasActive) { faceWasActive = active; window.lagon.setFaceActive(active); }
  // click mode: pleased when the pointer is on it
  face.classList.toggle('pleased', active && hovering && settings.openMode === 'click');
  syncAnim();
}
let faceSyncTimer = setInterval(syncFace, 250);

// ---------- widgets on / off ----------
const WIDGET_OF_PAGE = { music: 'widgetMusic', sound: 'widgetSound', pc: 'widgetPc', time: 'widgetTime', twitch: 'widgetTwitch', valorant: 'widgetValorant', discord: 'widgetDiscord', obs: 'widgetObs' };
const pageEnabled = (name) => !WIDGET_OF_PAGE[name] || !!settings[WIDGET_OF_PAGE[name]];

function applyWidgets() {
  tabs.forEach((t) => { t.hidden = !pageEnabled(t.dataset.page); });
  island.classList.toggle('no-lyrics', !settings.widgetLyrics);
  if (!settings.volumeOsd && hudKind === 'volume') hideOsd();
  // the page we would open on is off: fall back to the first one still on (or the settings)
  if (!pageEnabled(userPage)) {
    const next = PAGES.find((p) => p !== 'settings' && pageEnabled(p)) || 'settings';
    if (page === 'settings') userPage = next;
    else setPage(next, true);
  }
}

render();

// ---------- low-frame-rate animations ----------
// The equalizer bars and the sleeping face (breathing, floating z's) are moved here ~15 times a
// second. As CSS animations they made the screen redraw at its refresh rate (240 Hz) the whole time:
// measured +2.2 % CPU, constantly, while music played.
const eqBars = [...document.querySelectorAll('.eq i')];
const zs = [...document.querySelectorAll('.zzz b')];
const faceIn = $('.face-in');
const EQ_WAVES = [[3.5, 0], [4.5, 1.3], [3, 2.1], [4, 0.6]]; // speed, phase per bar
let animTimer = null;
let animWasOn = { eq: true, sleep: true }; // forces one reset on start

const closedView = () => !island.classList.contains('open') && !island.classList.contains('osd');
const eqWanted = () => closedView() && island.classList.contains('playing') && !island.classList.contains('idle');
const sleepWanted = () => closedView() && face.classList.contains('sleep') && faceVisible();

function animFrame() {
  const t = performance.now() / 1000;
  const eq = eqWanted();
  if (eq || animWasOn.eq) {
    eqBars.forEach((bar, i) => {
      const [speed, phase] = EQ_WAVES[i];
      const v = eq ? 0.25 + 0.75 * Math.abs(Math.sin(t * speed + phase)) : 0.25;
      bar.style.transform = `scaleY(${v.toFixed(2)})`;
    });
  }
  const sleep = sleepWanted();
  if (sleep) {
    const b = 0.5 - 0.5 * Math.cos((t / 3.2) * 2 * Math.PI); // breathing 0..1
    faceIn.style.transform = `translateY(${b.toFixed(2)}px) scale(${(1 - 0.03 * b).toFixed(3)})`;
    zs.forEach((z, i) => {
      const p = ((t + i * 0.9) % 2.7) / 2.7; // each z floats up over 2.7 s
      z.style.opacity = (p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8).toFixed(2);
      z.style.transform = `translate(${(9 * p).toFixed(1)}px, ${(2 - 18 * p).toFixed(1)}px) scale(${(0.7 + 0.45 * p).toFixed(2)})`;
    });
  } else if (animWasOn.sleep) {
    faceIn.style.transform = '';
    zs.forEach((z) => { z.style.opacity = ''; z.style.transform = ''; });
  }
  animWasOn = { eq, sleep };
}

function syncAnim() {
  const need = !paused && (eqWanted() || sleepWanted());
  if (need && !animTimer) animTimer = setInterval(animFrame, 66);
  else if (!need && animTimer) { clearInterval(animTimer); animTimer = null; }
  if (!need) animFrame(); // settle the bars / face once
}

// ---------- pause (fullscreen app in front, island hidden) ----------
window.lagon.onPaused((on) => {
  paused = on;
  clearInterval(tickTimer);
  clearInterval(faceSyncTimer);
  if (on) {
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
  } else {
    tickTimer = setInterval(tick, 120);
    faceSyncTimer = setInterval(syncFace, 250);
    tick();
    syncFace();
  }
});

$('.restart').addEventListener('click', () => window.lagon.relaunch());

// ---------- Twitch ----------
// Numbers come from the app (it signs in and asks Twitch every minute while live, 5 min otherwise).
const twPage = $('.page.twitch');
const twTab = tabs.find((t) => t.dataset.page === 'twitch');
const twTiles = {};
document.querySelectorAll('.tw-grid .tile').forEach((t) => {
  twTiles[t.dataset.tw] = { el: t, v: t.querySelector('.v'), s: t.querySelector('.s') };
});
const tw = { status: null, stats: null };
const fmtCount = (n) => (n == null ? '–' : Number(n).toLocaleString());

function fmtUptime(iso) {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function setTw(name, value, sub, live = false) {
  const t = twTiles[name];
  t.v.textContent = value;
  t.s.textContent = sub || ' ';
  t.el.classList.toggle('live', live);
}

function renderTwitch() {
  const st = tw.status || {};
  const s = st.connected ? tw.stats : null;
  twPage.classList.toggle('ready', !!s);
  twTab.classList.toggle('live', !!(s && s.live));
  $('.tw-msg').textContent = !st.connected ? 'Connecte ta chaîne dans les paramètres (roue dentée → Twitch).'
    : st.error ? st.error : 'Chargement des chiffres…';
  if (s) {
    setTw('status', s.live ? 'EN DIRECT' : 'Hors ligne', s.live ? (s.game || '') : (st.login ? '@' + st.login : ''), s.live);
    setTw('followers', fmtCount(s.followers), 'au total');
    setTw('today', (s.today > 0 ? '+' : '') + fmtCount(s.today), 'nouveaux followers');
    setTw('subs', s.subs == null ? '–' : fmtCount(s.subs), s.subs == null ? s.subsNote : 'au total');
    setTw('viewers', s.live ? fmtCount(s.viewers) : '–', s.live ? 'en ce moment' : 'hors live');
    setTw('uptime', s.live && s.startedAt ? fmtUptime(s.startedAt) : '–', s.live ? 'depuis le début' : '');
  }
  // settings
  $('.tw-state').textContent = st.connected ? `Connecté : ${st.login}` : st.pending ? 'En attente du code…' : 'Pas connecté';
  $('.tw-btn').textContent = st.connected ? 'Se déconnecter' : st.pending ? 'Nouveau code' : 'Se connecter';
  $('.tw-code').hidden = !st.pending;
  if (st.pending) $('.tw-code b').textContent = st.pending.code;
  $('.tw-err').textContent = st.error || '';
}

window.lagon.onTwitchStatus((st) => { tw.status = st; renderTwitch(); });
window.lagon.onTwitchStats((s) => { tw.stats = s; renderTwitch(); });
$('.tw-btn').addEventListener('click', () => {
  const action = tw.status && tw.status.connected ? window.lagon.twitchDisconnect() : window.lagon.twitchConnect();
  action.then((st) => { tw.status = st; renderTwitch(); });
});
setInterval(() => { if (tw.stats && tw.stats.live && page === 'twitch') renderTwitch(); }, 30000); // live duration

// ---------- live ticker ----------
// While live (and the option is on), a second row under the closed island rolls through the stats,
// one every 3 s. The island's usual content stays as it is.
const ticker = { el: $('.tk-text'), timer: null, i: 0 };

function tickerItems() {
  const s = tw.stats;
  if (!s) return [];
  const items = [`<b>EN DIRECT</b> · ${fmtCount(s.viewers)} spectateur${s.viewers === 1 ? '' : 's'}`];
  items.push(`<b>${fmtCount(s.followers)}</b> followers`);
  items.push(`<b>${s.today > 0 ? '+' : ''}${fmtCount(s.today)}</b> aujourd’hui`);
  if (s.subs != null) items.push(`<b>${fmtCount(s.subs)}</b> subs`);
  if (s.startedAt) items.push(`Live depuis <b>${fmtUptime(s.startedAt)}</b>`);
  return items;
}

function rollTicker() {
  const items = tickerItems();
  if (!items.length) return;
  ticker.i = (ticker.i + 1) % items.length;
  const el = ticker.el;
  el.classList.add('out');
  setTimeout(() => {
    el.innerHTML = items[ticker.i]; // our own text and numbers only
    el.classList.remove('out');
    el.classList.add('pre');
    void el.offsetWidth;
    el.classList.remove('pre');
  }, 280);
}

function syncTicker() {
  const st = tw.status || {};
  const on = !!(settings.widgetTwitch && settings.twitchTicker && st.connected && tw.stats && tw.stats.live && !paused && !settings.focusMode);
  if (on !== island.classList.contains('ticker-on')) {
    island.classList.toggle('ticker-on', on);
    if (on) { ticker.i = -1; rollTicker(); }
    sendSizes(island.classList.contains('idle'));
  }
  if (on && !ticker.timer) ticker.timer = setInterval(rollTicker, 3000);
  if (!on && ticker.timer) { clearInterval(ticker.timer); ticker.timer = null; }
}
window.lagon.onTwitchStats(() => syncTicker());
window.lagon.onTwitchStatus(() => syncTicker());
window.lagon.onSettings(() => syncTicker());
window.lagon.onPaused(() => syncTicker());

// ---------- Valorant ----------
// Numbers come from the app (HenrikDev API, every 3 minutes). The API key is typed here once and
// only goes to the app, which keeps it encrypted; it never comes back to the page.
const vlPage = $('.page.valorant');
const vlTiles = {};
document.querySelectorAll('.vl-grid [data-vl]').forEach((t) => {
  vlTiles[t.dataset.vl] = { el: t, v: t.querySelector('.v'), s: t.querySelector('.s') };
});
let vl = null;
const vlIcon = $('.vl-icon');
// rank pictures ship with Lagon (renderer/ranks/<tier id>.png): no request, works offline
const RANK_ICONS = 'ranks/';
vlIcon.addEventListener('error', () => vlIcon.classList.add('none'));
vlIcon.addEventListener('load', () => vlIcon.classList.remove('none'));

const TIER_FR = { Iron: 'Fer', Bronze: 'Bronze', Silver: 'Argent', Gold: 'Or', Platinum: 'Platine', Diamond: 'Diamant',
  Ascendant: 'Ascendant', Immortal: 'Immortel', Radiant: 'Radiant', Unrated: 'Non classé', Unranked: 'Non classé' };
const tierFr = (name) => {
  if (!name) return '–';
  const [base, n] = String(name).split(' ');
  return (TIER_FR[base] || base) + (n ? ' ' + n : '');
};
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);

function setVl(name, value, sub, cls = '') {
  const t = vlTiles[name];
  t.v.textContent = value;
  t.s.textContent = sub || ' ';
  t.el.classList.toggle('up', cls === 'up');
  t.el.classList.toggle('down', cls === 'down');
}

// The last game: "Victoire 13–9", agent · map, K/D/A · HS % · ACS, and the RR it gave.
function renderLastMatch(s, m) {
  const tile = $('.vl-match');
  const rr = s.lastChange;
  tile.classList.remove('up', 'down');
  const agent = $('.vl-agent');
  if (m && m.agentIcon && agent.getAttribute('src') !== m.agentIcon) agent.src = m.agentIcon;
  agent.classList.toggle('none', !(m && m.agentIcon));
  $('.vl-m-rr').textContent = rr == null ? '' : `${signed(rr)} RR`;
  if (m) {
    const result = m.draw ? 'Égalité' : m.won ? 'Victoire' : 'Défaite';
    tile.classList.add(m.draw ? 'flat' : m.won ? 'up' : 'down');
    $('.vl-m-head').textContent = `${result} ${m.roundsWon}–${m.roundsLost}`;
    $('.vl-m-where').textContent = `${m.agent} · ${m.map}`;
    $('.vl-m-stats').textContent = `${m.kills}/${m.deaths}/${m.assists} · ${m.hs} % HS · ACS ${m.acs}`;
  } else if (rr != null) {
    tile.classList.add(rr > 0 ? 'up' : rr < 0 ? 'down' : 'flat');
    $('.vl-m-head').textContent = rr > 0 ? 'Victoire' : rr < 0 ? 'Défaite' : 'Égalité';
    $('.vl-m-where').textContent = 'détails en chargement…';
    $('.vl-m-stats').textContent = ' ';
  } else {
    $('.vl-m-head').textContent = '–';
    $('.vl-m-where').textContent = 'pas encore de match classé';
    $('.vl-m-stats').textContent = ' ';
  }
}

function renderValorant() {
  const st = vl || {};
  const s = st.stats;
  vlPage.classList.toggle('ready', !!s);
  $('.vl-msg').textContent = !st.riotId ? 'Ajoute ton Riot ID dans les paramètres (roue dentée → Valorant).'
    : !st.hasKey ? 'Ajoute ta clé API HenrikDev dans les paramètres (roue dentée → Valorant).'
    : st.error ? st.error : 'Chargement du rang…';
  if (s) {
    const ranked = s.tier >= 3;
    if (ranked) {
      const src = RANK_ICONS + s.tier + '.png';
      if (vlIcon.getAttribute('src') !== src) vlIcon.src = src;
    } else vlIcon.classList.add('none');
    $('.vl-tier').textContent = tierFr(s.tierName);
    $('.vl-who').textContent = s.name ? `${s.name}#${s.tag}` : st.riotId;
    const high = s.tier >= 24; // Immortal and Radiant: RR keep counting past 100
    $('.vl-rank .b i').style.width = ranked ? (high ? 100 : Math.min(100, s.rr)) + '%' : '0%';
    $('.vl-rr').textContent = !ranked ? (s.needed > 0 ? `encore ${s.needed} match(s) de placement` : ' ')
      : high ? `${s.rr} RR` + (s.leaderboard ? ` · #${s.leaderboard.toLocaleString()} du classement` : '')
      : `${s.rr} / 100 RR`;

    renderLastMatch(s, st.lastMatch);

    const played = s.wins + s.losses + s.draws;
    const pct = played ? Math.round((s.wins / played) * 100) : 0;
    setVl('today', played ? `${s.wins} V – ${s.losses} D` : '0 match',
      played ? `${signed(s.todayRR)} RR · ${pct} % de victoires` + (s.draws ? ` · ${s.draws} nul${s.draws > 1 ? 's' : ''}` : '') : 'en classé depuis minuit',
      played ? (s.todayRR > 0 ? 'up' : s.todayRR < 0 ? 'down' : '') : '');
    if (s.peak && s.peak.tierName) setVl('peak', tierFr(s.peak.tierName), s.peak.season ? `saison ${s.peak.season}` : '');
    else setVl('peak', '–', '');
  }
  // settings
  $('.vl-key-saved').hidden = !st.hasKey;
  $('.vl-key-new').hidden = !!st.hasKey;
  $('.vl-err').textContent = st.error || '';
}

window.lagon.onValorant((st) => { vl = st; renderValorant(); });
window.lagon.valorantState().then((st) => { vl = st; renderValorant(); });
$('.vl-clear').addEventListener('click', () => window.lagon.valorantClearKey().then((st) => { vl = st; renderValorant(); }));
$('.vl-get').addEventListener('click', () => window.lagon.valorantDashboard());

// Riot ID field: "Name#TAG" (1–16 characters, #, 1–5 characters)
const vlId = $('.valo-id');
const RIOT_RE = /^[^#\p{Cc}]{1,16}#[^#\p{Cc}]{1,5}$/u;
const riotOk = (v) => v === '' || (RIOT_RE.test(v) && v.split('#')[0].trim() !== '' && v.split('#')[1].trim() !== '');
vlId.addEventListener('pointerdown', () => window.lagon.keyboard(true));
vlId.addEventListener('input', () => vlId.classList.toggle('bad', !riotOk(vlId.value.trim())));
vlId.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') vlId.blur();
  if (e.key === 'Escape') { vlId.value = settings.valoRiotId || ''; vlId.blur(); }
});
vlId.addEventListener('blur', () => {
  window.lagon.keyboard(false);
  const v = vlId.value.trim();
  if (riotOk(v) && v !== (settings.valoRiotId || '')) window.lagon.setSetting('valoRiotId', v).then(applySettings);
  else { vlId.value = settings.valoRiotId || ''; vlId.classList.remove('bad'); }
});

// API key field: sent once to the app, then emptied
const vlKey = $('.valo-key');
vlKey.addEventListener('pointerdown', () => window.lagon.keyboard(true));
vlKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const k = vlKey.value.trim();
    vlKey.value = '';
    vlKey.blur();
    if (k) window.lagon.valorantSetKey(k).then((st) => { vl = st; renderValorant(); });
  }
  if (e.key === 'Escape') { vlKey.value = ''; vlKey.blur(); }
});
vlKey.addEventListener('blur', () => window.lagon.keyboard(false));

// ---------- Discord ----------
// The voice channel you are in (who is there, who speaks, who is muted), your own mute / deafen as
// an icon in the closed bar, and a pop-up with the name of who sent you a DM (never the message).
let dc = { status: 'off', members: [] };
const dcAvatars = new Map(); // picture address -> image, sent once by Lagon
const DC_SVG = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
// solid shapes (like Discord's): thin outlines broke into pieces at 14 px and looked half hidden.
// The bar across is drawn twice: a dark gap, then the red line, so it reads over the shape.
const DC_CUT = '<path class="gap" d="M4 3.5l16.5 16.5"/><path class="cut" d="M4 3.5l16.5 16.5"/>';
const DC_MIC_OFF = DC_SVG('<rect class="f" x="8.5" y="2" width="7" height="12.5" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22"/>' + DC_CUT);
// deafen: no dark gap here (across an earcup it looked like a black block), just the red bar
const DC_DEAF = DC_SVG('<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><path class="f" d="M3 13.5h4.2v6.5H5a2 2 0 0 1-2-2zM21 13.5h-4.2v6.5H19a2 2 0 0 0 2-2z"/><path class="cut" d="M3.5 3l17 17"/>');
const DC_LOGO = `<svg class="filled" viewBox="0 0 24 24"><path d="${$('.tabs [data-page="discord"] path').getAttribute('d')}"/></svg>`;

function dcMember(m) {
  const row = document.createElement('div');
  row.className = 'dc-m' + (m.speaking ? ' talk' : '');
  const av = document.createElement('span');
  av.className = 'dc-av';
  const pic = dcAvatars.get(m.avatar_url);
  if (typeof pic === 'string' && pic.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = pic;
    img.alt = '';
    av.append(img);
  } else {
    av.textContent = (m.name || '?').slice(0, 1).toUpperCase();
  }
  const name = document.createElement('span');
  name.className = 'dc-name';
  name.textContent = m.name || '?';
  const ic = document.createElement('span');
  ic.className = 'dc-ic';
  ic.innerHTML = (m.muted ? DC_MIC_OFF : '') + (m.deaf ? DC_DEAF : '');
  row.append(av, name, ic);
  return row;
}

function renderDiscordBadge() {
  const st = dc || {};
  const discordOn = !!(settings.widgetDiscord && settings.discordBadge && st.status === 'connected' && (st.mute || st.deaf));
  const o = typeof ob === 'object' && ob ? ob : {};
  const obsOn = !!(settings.widgetObs && settings.obsMicBadge && o.status === 'connected' && (o.live || o.rec) && o.micMuted);
  const on = discordOn || obsOn;
  island.classList.toggle('dc-badge', on);
  const badge = $('.c-dc');
  const html = (obsOn ? `<span class="ob-badge" title="Micro coupé dans OBS">${DC_MIC_OFF}</span>` : '')
    + (discordOn ? (st.deaf ? DC_DEAF : DC_MIC_OFF) : '');
  if (badge.innerHTML !== html) badge.innerHTML = html;
}

function renderDiscord() {
  const st = dc || {};
  const connected = st.status === 'connected';
  const msg = {
    noclient: 'Ouvre Discord sur ce PC : Lagon s’y connecte tout seul.',
    signedout: 'Connecte Discord dans les paramètres (roue dentée → Discord).',
    authorizing: 'Accepte la demande dans la fenêtre de Discord.',
  }[st.status] || '';
  const pageEl = $('.page.discord');
  pageEl.classList.toggle('ready', connected && !!st.channel);
  $('.dc-msg').textContent = connected ? 'Tu n’es dans aucun salon vocal.' : msg;
  if (connected && st.channel) {
    $('.dc-chan').textContent = st.channel;
    $('.dc-me').innerHTML = (st.mute ? DC_MIC_OFF : '') + (st.deaf ? DC_DEAF : '');
    const members = Array.isArray(st.members) ? st.members : [];
    $('.dc-list').replaceChildren(...members.map(dcMember));
  }
  $('.dc-state').textContent = connected ? `Connecté : ${st.user || 'Discord'}`
    : st.status === 'authorizing' ? 'En attente de Discord…'
    : st.status === 'noclient' ? 'Discord n’est pas ouvert sur ce PC'
    : 'Pas connecté';
  const btn = $('.dc-btn');
  btn.textContent = connected ? 'Se déconnecter' : 'Se connecter';
  btn.disabled = !connected && st.status !== 'signedout';
  $('.dc-err').textContent = st.error || '';
  renderDiscordBadge();
}

$('.dc-btn').addEventListener('click', () => {
  const action = dc && dc.status === 'connected' ? window.lagon.discordDisconnect() : window.lagon.discordConnect();
  Promise.resolve(action).then((st) => { if (st) { dc = st; renderDiscord(); } });
});
window.lagon.onDiscord((st) => { if (st) { dc = st; renderDiscord(); } });
window.lagon.onDiscordAvatar((a) => {
  if (!a || typeof a.url !== 'string' || typeof a.data !== 'string') return;
  dcAvatars.set(a.url, a.data);
  if (dc && Array.isArray(dc.members) && dc.members.some((m) => m.avatar_url === a.url)) renderDiscord();
});
Promise.resolve(window.lagon.discordState && window.lagon.discordState()).then((st) => { if (st) dc = st; renderDiscord(); });
window.lagon.onDiscordDm((m) => {
  if (!m || !m.from || !settings.discordDmPopup) return;
  // one line: the two-line layout didn't fit the bar's height
  showHud({ kind: 'dm', icon: DC_LOGO, title: `MP de ${m.from}` }, 3500);
});
window.lagon.onDiscordVoice((m) => {
  if (!m || !m.name || !settings.discordVoicePopup) return;
  showHud({ kind: 'voice', icon: DC_LOGO, title: m.kind === 'join' ? `${m.name} a rejoint le vocal` : `${m.name} a quitté le vocal` }, 3000);
});

// ---------- OBS ----------
// Stream / recording time, bitrate and dropped frames, OBS's microphone (a click mutes it in OBS)
// and the scenes (a click switches). Lagon talks to OBS's own WebSocket server on this PC.
let ob = { status: 'off' };
let obAt = Date.now(); // when the last durations arrived: the clock keeps running in between
const OB_ICON = svg('<rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5z"/>');
function obDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(x).padStart(2, '0');
}

function renderObs() {
  const o = ob || {};
  const connected = o.status === 'connected';
  const pageEl = $('.page.obs');
  pageEl.classList.toggle('ready', connected);
  $('.ob-msg').textContent = {
    noobs: 'Ouvre OBS sur ce PC : Lagon s’y connecte tout seul.',
    needpass: 'Ajoute le mot de passe OBS dans les paramètres (roue dentée → OBS).',
    badpass: 'OBS refuse le mot de passe : vérifie-le dans les paramètres.',
  }[o.status] || '';
  $('.tabs [data-page="obs"]').classList.toggle('live', connected && !!o.live);
  if (connected) {
    const since = Date.now() - obAt;
    const liveTile = $('.ob-live');
    liveTile.classList.toggle('hot', !!o.live);
    $('.ob-live-v').textContent = o.live ? `● ${obDur(o.liveMs + since)}` : 'Hors ligne';
    $('.ob-live-s').textContent = o.rec ? `enregistrement ${obDur(o.recMs + since)}` : o.live ? 'en direct' : 'pas de live en cours';
    $('.ob-kbps').textContent = o.live && o.kbps != null ? `${o.kbps.toLocaleString('fr-FR')} kb/s` : '–';
    const drop = o.dropped;
    $('.ob-rate').classList.toggle('warn', o.live && drop != null && drop >= 1);
    $('.ob-drop').textContent = o.live && drop != null ? `${String(drop).replace('.', ',')} % d’images perdues` : ' ';
    const mic = $('.ob-mic');
    mic.disabled = !o.mic;
    mic.classList.toggle('hot', !!o.micMuted);
    $('.ob-mic-v').textContent = !o.mic ? '–' : o.micMuted ? 'Coupé' : 'Actif';
    $('.ob-mic-s').textContent = o.mic ? o.mic : 'aucun micro dans OBS';
    mic.title = o.mic ? `Clic pour ${o.micMuted ? 'réactiver' : 'couper'} le micro dans OBS` : '';
    const scenes = Array.isArray(o.scenes) ? o.scenes : [];
    const box = $('.ob-scenes');
    const key = JSON.stringify([scenes, o.scene]);
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(...scenes.map((name) => {
        const b = document.createElement('button');
        b.className = 'ob-scene' + (name === o.scene ? ' on' : '');
        b.textContent = name;
        b.addEventListener('click', () => window.lagon.obsScene(name));
        return b;
      }));
    }
  }
  // settings
  $('.ob-state').textContent = connected ? (o.live ? 'Connecté à OBS · en direct' : 'Connecté à OBS')
    : o.status === 'needpass' ? 'OBS demande un mot de passe'
    : o.status === 'badpass' ? 'Mot de passe refusé par OBS'
    : o.status === 'off' ? 'Désactivé' : 'OBS n’est pas ouvert';
  $('.ob-pass-saved').hidden = !o.hasPassword;
  $('.ob-pass-new').hidden = !!o.hasPassword;
  $('.ob-err').textContent = o.error || '';
  renderDiscordBadge();
}

function setObs(o) {
  if (!o) return;
  ob = o;
  obAt = Date.now();
  renderObs();
}
window.lagon.onObs(setObs);
Promise.resolve(window.lagon.obsState && window.lagon.obsState()).then(setObs);
setInterval(() => { if (ob && (ob.live || ob.rec) && island.classList.contains('open') && page === 'obs') renderObs(); }, 1000);
$('.ob-mic').addEventListener('click', () => window.lagon.obsToggleMic());
window.lagon.onObsAlert((a) => {
  if (!a || !a.text || !settings.obsAlerts) return;
  showHud({ kind: 'obs', icon: OB_ICON, title: String(a.text), tone: a.kind === 'drops' ? 'warn' : a.kind === 'live' ? 'hot' : '' }, 3500);
});
const obPass = $('.ob-pass');
obPass.addEventListener('pointerdown', () => window.lagon.keyboard(true));
obPass.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const p = obPass.value;
    obPass.value = '';
    obPass.blur();
    if (p.trim()) window.lagon.obsSetPassword(p).then(setObs);
  }
  if (e.key === 'Escape') { obPass.value = ''; obPass.blur(); }
});
obPass.addEventListener('blur', () => window.lagon.keyboard(false));
$('.ob-clear').addEventListener('click', () => window.lagon.obsClearPassword().then(setObs));

// ---------- updates ----------
let up = { status: 'idle' };
const UP_ICON = svg('<path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16"/>');
function renderUpdate() {
  const u = up || {};
  const cur = u.current || '';
  $('.up-text').textContent = {
    checking: 'Recherche de mise à jour…',
    downloading: 'Téléchargement de la mise à jour…',
    available: `Version ${u.available} disponible (tu as la ${cur})`,
    uptodate: `Version ${cur} · à jour`,
    error: `Version ${cur} · vérification impossible`,
  }[u.status] || `Version ${cur}`;
  const btn = $('.up-btn');
  btn.textContent = u.status === 'available' ? 'Installer' : 'Vérifier';
  btn.classList.toggle('go', u.status === 'available');
  btn.disabled = u.status === 'checking' || u.status === 'downloading';
  btn.title = u.status === 'error' && u.error ? u.error : '';
  // a new version: red dot on the gear, and the row stands out at the top of Settings > Bar
  const ready = u.status === 'available';
  gear.classList.toggle('has-update', ready);
  $('.up-row').classList.toggle('ready', ready);
}
// with an update waiting, the gear opens straight on Settings > Bar, where the button is
gear.addEventListener('click', () => {
  if (up && up.status === 'available') setTimeout(() => $('.s-nav button[data-cat="bar"]')?.click(), 0);
});
function setUpdate(u) { if (u) { up = u; renderUpdate(); } }
window.lagon.onUpdate(setUpdate);
Promise.resolve(window.lagon.updateState && window.lagon.updateState()).then(setUpdate);
$('.up-btn').addEventListener('click', () => {
  const action = up && up.status === 'available' ? window.lagon.updateInstall() : window.lagon.updateCheck();
  Promise.resolve(action).then(setUpdate);
});
window.lagon.onUpdateAvailable((m) => {
  if (m && m.version) showHud({ kind: 'update', icon: UP_ICON, title: `Mise à jour ${m.version} dispo : Paramètres → Barre` }, 5000);
});
