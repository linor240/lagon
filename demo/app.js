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
let settingsLoaded = false; // the saved settings arrived (until then the page uses its defaults)
let barXw = 0; // extra width of the closed island for the pinned stats (see renderBarStats)
let paused = false; // true while hidden for a fullscreen app
let winTheme = null; // Windows' { light, accent: "#rrggbb" } (null in the browser demo)
let coverPal = null; // hues of the current artwork (see pickAccent), null = greyscale / none yet
let welcomeOn = false; // the first-launch screen is shown (the card stays open, big)
let tabOrderKey = ''; // tab order applied last (see applyTabOrder)
let game = null; // the mini-game ({ sync }), set up further down
let wheel = null; // the other mini-game, la Roue ({ sync })
let fpsNow = null; // last FPS reading from the helper ({state, fps, app})
let fpsAccess = null; // may this Windows account read the FPS (null: not asked yet)
let fpsGrant = null; // answer to "Autoriser les FPS": asking, ok, already, cancelled, error
// replaced by the saved settings as soon as the main process answers
let settings = {
  openMode: 'hover', position: 'center', peekOnTrack: true, compactLyrics: true, volumeOsd: true, idleFace: true, faceSleepSeconds: 120,
  widgetMusic: true, widgetLyrics: true, widgetSound: true, widgetPc: true, widgetTime: true,
  lyricsSize: 16, lyricsFont: 'segoe', pingHost: '1.1.1.1', idleMinutes: 5, openAtLogin: false,
  theme: 'dark', accentColor: 'cover', halos: false, oledShift: false, faceStyle: 'classic',
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
  if (!on) { if (!welcomeOn) setOpen(false); return; } // the welcome screen waits for its button
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

// Sizes must match style.css (#island, #island.idle, #island.idle.face-mode, --open-w / --open-h,
// #island.big for the settings and the welcome screen).
let sentSizes = '';
function sendSizes(idle) {
  const focus = !!settings.focusMode;
  const w = focus ? 64 : (!idle ? 290 : settings.idleFace ? 184 : 132) + barXw;
  const gap = settings.islandAttach === 'floating' ? 8 : 0; // floating: the island starts 8px lower
  const tickerRow = island.classList.contains('ticker-on') ? 22 : 0; // live ticker under the closed island
  const h = focus ? 6 : 36 + tickerRow; // keep in sync with #island.focus in style.css
  const big = island.classList.contains('big');
  const sizes = { compact: { w, h: h + gap }, open: big ? { w: 720, h: 420 + gap } : { w: 540, h: 228 + gap } };
  if (JSON.stringify(sizes) === sentSizes) return;
  sentSizes = JSON.stringify(sizes);
  window.lagon.setSizes(sizes);
}

// Briefly show the music card when a new song starts.
function peek() {
  if (hovering || !settings.peekOnTrack || settings.focusMode || welcomeOn) return;
  setPage('music', true, false);
  setOpen(true);
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (!hovering) { setOpen(false); setTimeout(() => setPage(userPage, true), 450); }
  }, 3500);
}

// ---------- pages ----------
// in the tabs' order (applyTabOrder rearranges it in place); settings always last
const PAGES = ['music', 'sound', 'pc', 'time', 'twitch', 'obs', 'valorant', 'discord', 'game', 'settings'];
let page = 'music';
let userPage = 'music'; // the page the user picked last; peeks and settings don't change it
const pagesEl = $('.pages');
const tabs = [...document.querySelectorAll('.tabs button')];
const gear = $('.gear');

function setPage(name, instant = false, byUser = true) {
  page = name;
  if (byUser) userPage = name;
  // kept in the settings: Lagon opens on it again, even after a restart
  if (byUser && name !== 'settings' && settingsLoaded && settings.lastPage !== name) {
    settings.lastPage = name;
    window.lagon.setSetting('lastPage', name);
  }
  pagesEl.classList.toggle('instant', instant);
  pagesEl.style.setProperty('--page', PAGES.indexOf(name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('current', p.classList.contains(name)));
  tabs.forEach((t) => t.classList.toggle('on', t.dataset.page === name));
  gear.classList.toggle('on', name === 'settings');
  syncBig();
  if (instant) requestAnimationFrame(() => pagesEl.classList.remove('instant'));
  if (name === 'settings') renderDisplays(); // screens may have been plugged in or out
  if (name === 'settings' && settings.fpsCounter) window.lagon.sys('fpscheck');
  syncStats();
}
tabs.forEach((t) => t.addEventListener('click', () => setPage(t.dataset.page)));

// the settings and the welcome screen use the big card (720x420)
function syncBig() {
  island.classList.toggle('big', welcomeOn || page === 'settings');
  sendSizes(island.classList.contains('idle'));
}

// Tab order (Settings > Modules, dragged): the tabs, the pages behind them and the list in the
// settings follow it. Ignored until valid (the demo has none).
function applyTabOrder(order) {
  const names = PAGES.filter((p) => p !== 'settings');
  if (!Array.isArray(order) || order.length !== names.length || !names.every((p) => order.includes(p))) return;
  const key = order.join();
  if (key === tabOrderKey) return;
  tabOrderKey = key;
  PAGES.splice(0, PAGES.length, ...order, 'settings');
  const nav = $('.tabs');
  const last = $('.page.settings');
  order.forEach((p) => {
    nav.appendChild(tabs.find((t) => t.dataset.page === p));
    pagesEl.insertBefore($(`.page.${p}`), last);
    if (modRows[p]) modList.appendChild(modRows[p]);
  });
  setPage(page, true, false); // same page, new place in the row
}
gear.addEventListener('click', () => {
  if (page === 'settings') setPage(userPage);
  else setPage('settings', false, false);
});

// PC stats are only collected while the PC page is on screen
// (querying the NVIDIA card would otherwise keep it awake on a laptop).
let statsOn = false;
let fpsOn = false; // the helper counts frames (FPS counter on and shown)
let usageTimer = null; // refreshes the screen time page while it is shown
function syncStats() {
  syncUsage();
  if (game) game.sync();
  const fpsPinned = !!(settings.fpsCounter && settings.barFps) && !settings.focusMode && !paused;
  const fpsWant = !!settings.fpsCounter && !paused && ((island.classList.contains('open') && page === 'pc') || fpsPinned);
  if (fpsWant !== fpsOn) {
    fpsOn = fpsWant;
    if (!fpsWant) fpsNow = null;
    window.lagon.sys(`fps ${fpsWant ? 1 : 0}`);
  }
  const pinned = !!(settings.barCpu || settings.barGpu || settings.barTemp || settings.barPing) && !settings.focusMode && !paused;
  const want = (island.classList.contains('open') && page === 'pc') || pinned;
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
// --accent (a lighter c1, darker in the light theme) drives the equalizer, progress bar and glow.
// pickAccent finds the hues (coverPal), applyColors turns them into colours for the current theme,
// or uses Windows' accent colour instead (accentColor: "windows").
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

    if (!ranked.length || satSum / count < 0.08) {        // greyscale cover
      coverPal = null;
    } else {
      const avg = (b) => rgbToHsl(b.r / b.w, b.g / b.w, b.b / b.w);
      const top = ranked[0];
      const far = (b) => Math.min(Math.abs(b.i - top.i), BINS - Math.abs(b.i - top.i)) >= 2;
      const second = ranked.find((b) => b !== top && far(b) && b.w > top.w * 0.12);
      const [h1, s1] = avg(top);
      const [h2, s2] = second ? avg(second) : [(h1 + 0.08) % 1, s1];
      coverPal = { h1, s1, h2, s2, second: !!second };
    }
    applyColors();
  };
  img.src = src;
}

// Windows' accent colour as a palette (null if it is a grey)
function hexPal(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
  const n = parseInt(hex.slice(1), 16);
  const [h, s] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return s < 0.08 ? null : { h1: h, s1: s, h2: (h + 0.08) % 1, s2: s, second: false };
}

function applyColors() {
  const light = document.body.dataset.theme === 'light';
  // Windows' colour unknown (never chosen) or grey: the music's colours instead
  const p = (settings.accentColor === 'windows' && winTheme && hexPal(winTheme.accent)) || coverPal;
  const root = document.documentElement.style;
  if (!p) {
    root.setProperty('--c1', light ? 'hsl(230 8% 72%)' : 'hsl(230 8% 42%)');
    root.setProperty('--c2', light ? 'hsl(230 6% 82%)' : 'hsl(230 6% 26%)');
    root.setProperty('--accent', light ? '#3a3a42' : '#e8e8ed');
    return;
  }
  const hsl = (h, s, l) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  root.setProperty('--c1', hsl(p.h1, Math.max(0.55, p.s1), light ? 0.62 : 0.5));
  root.setProperty('--c2', hsl(p.h2, Math.max(0.5, p.s2), p.second ? (light ? 0.64 : 0.45) : (light ? 0.74 : 0.32)));
  root.setProperty('--accent', hsl(p.h1, Math.max(0.5, p.s1), light ? 0.42 : 0.7));
}

// light / dark: the setting, or Windows' mode for "auto"
function applyTheme() {
  const t = settings.theme === 'auto' ? (winTheme && winTheme.light ? 'light' : 'dark') : settings.theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = t;
  applyColors();
}
const gotWindowsTheme = (t) => { winTheme = t && typeof t === 'object' ? t : null; applyTheme(); };
if (window.lagon.getWindowsTheme) window.lagon.getWindowsTheme().then(gotWindowsTheme).catch(() => {});
if (window.lagon.onWindowsTheme) window.lagon.onWindowsTheme(gotWindowsTheme);

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
  // The bar keeps the width it had before the pop-up (no jump); the text is centred in it. A text
  // too long for it makes the bar wider (20 px steps, up to what the window can show), and if even
  // that isn't enough the text goes on several lines (the bar gets taller): it is never cut.
  let need = 290; // bar pop-ups (volume, brightness) as before
  let height = 0; // 0 = the usual 36 px row
  const maxW = Math.floor(Math.min(520, 588 / ((Number(settings.islandScale) || 100) / 100)) / 20) * 20;
  if (h.bar == null) {
    const w = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
    // Measured on the hidden copy, on one line: the shown text may already end with "…" (the bar
    // is still at its old width), and a cut text measures only what is visible (Discord names were
    // cut that way while short texts like the keyboard language were not).
    osdMeasure.style.width = '';
    osdMeasure.classList.add('one-line');
    osdMeasure.firstChild.textContent = osd.title.textContent;
    osdMeasure.lastChild.textContent = osd.sub.textContent;
    const text = Math.ceil(osdMeasure.getBoundingClientRect().width) + 1;
    osdMeasure.classList.remove('one-line');
    const pct = osd.pct.textContent ? w(osd.pct) + 10 : 0;
    const chrome = 8 + 6 + 20 + 10 + pct + 22; // paddings, icon, gaps, value
    need = chrome + text;
    if (need > maxW) {
      osdMeasure.style.width = (maxW - chrome) + 'px';
      osdMeasure.firstChild.textContent = osd.title.textContent;
      osdMeasure.lastChild.textContent = osd.sub.textContent;
      height = Math.ceil(osdMeasure.offsetHeight) + 14;
      if (height <= 36) height = 0;
    }
  }
  const width = Math.min(maxW, Math.max(osdBase, Math.ceil(need / 20) * 20));
  island.style.setProperty('--osd-w', width + 'px');
  island.classList.toggle('osd-wrap', height > 0);
  if (height) island.style.setProperty('--osd-h', height + 'px');
}
// hidden copy of the pop-up text, to know how tall it is once it wraps
const osdMeasure = document.createElement('div');
osdMeasure.className = 'o-measure';
osdMeasure.append(document.createElement('span'), document.createElement('span'));
osdMeasure.firstChild.className = 'o-title';
osdMeasure.lastChild.className = 'o-sub';
document.body.append(osdMeasure);
let osdBase = 290; // the closed bar's width when the pop-up started
let calmTimer = null;
function showHud(h, ms = 1800) {
  if (island.classList.contains('open') || settings.focusMode) return;
  hudKind = h.kind;
  if (!island.classList.contains('osd')) osdBase = island.offsetWidth;
  clearTimeout(calmTimer);
  island.classList.add('calm'); // soft width changes, no spring bounce, while a pop-up is shown
  island.classList.add('osd');
  renderHud(h);
  // long texts stay a little longer, so they can be read to the end
  const len = h.bar == null ? (h.title || '').length + (h.sub || '').length : 0;
  ms = Math.min(8000, ms + Math.max(0, len - 40) * 50);
  clearTimeout(osdTimer);
  osdTimer = setTimeout(hideOsd, ms);
}
function hideOsd() {
  clearTimeout(osdTimer);
  hudKind = null;
  island.classList.remove('osd', 'osd-text', 'osd-wrap');
  clearTimeout(calmTimer);
  calmTimer = setTimeout(() => island.classList.remove('calm'), 500); // back to the usual size softly too
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
    + (charging ? '<path d="M11.5 8.5 9.5 12h3l-2 3.5" class="carve" stroke-width="1.6"/>' : '')),
  wifi: (bars) => {
    const on = (n) => (bars < 0 || bars >= n ? '' : ' stroke-opacity="0.25"');
    return svg(`<path d="M2.5 9a14 14 0 0 1 19 0"${on(4)}/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"${on(3)}/>`
      + `<path d="M8.5 16a5 5 0 0 1 7 0"${on(2)}/><circle cx="12" cy="19.2" r="1" fill="currentColor" stroke="none"/>`);
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

// All the categories are one long list on the right (like osu!): a click on the left scrolls to
// one, and while the list scrolls the category being read lights up.
const catButtons = [...settingsPage.querySelectorAll('.s-nav button')];
const catPanels = [...settingsPage.querySelectorAll('.s-panel')];
const sPanels = $('.s-panels');
const lightCategory = (cat) => catButtons.forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
function showCategory(cat, smooth = true) {
  const p = catPanels.find((x) => x.dataset.cat === cat);
  if (!p) return;
  lightCategory(cat);
  spyHold = Date.now() + 700; // the clicked one stays lit, even if the list can't scroll that far
  sPanels.scrollTo({ top: p.offsetTop, behavior: smooth ? 'smooth' : 'instant' });
}
catButtons.forEach((b) => b.addEventListener('click', () => showCategory(b.dataset.cat)));
let spyFrame = 0;
let spyHold = 0;
function spyCategory() {
  spyFrame = 0;
  if (Date.now() < spyHold) return;
  const top = sPanels.scrollTop;
  let cur = catPanels[0];
  if (top + sPanels.clientHeight >= sPanels.scrollHeight - 4) cur = catPanels[catPanels.length - 1]; // the end of the list
  else catPanels.forEach((p) => { if (p.offsetTop - 70 <= top) cur = p; });
  lightCategory(cur.dataset.cat);
}
sPanels.addEventListener('scroll', () => { if (!spyFrame) spyFrame = requestAnimationFrame(spyCategory); }, { passive: true });

// Modules: one row per tab, switched on / off here and dragged by its dots to change the order
const MODULES = [
  ['music', 'widgetMusic', 'Musique', 'Titre, pochette et paroles'],
  ['sound', 'widgetSound', 'Son', 'Volume de chaque appli'],
  ['pc', 'widgetPc', 'PC', 'CPU, GPU, RAM et ping'],
  ['time', 'widgetTime', 'Temps d’écran', 'Le temps passé sur chaque appli'],
  ['twitch', 'widgetTwitch', 'Twitch', 'Followers, subs, spectateurs'],
  ['obs', 'widgetObs', 'OBS', 'Live, débit et micro'],
  ['valorant', 'widgetValorant', 'Valorant', 'Rang, RR et dernier match'],
  ['discord', 'widgetDiscord', 'Discord', 'Ton vocal, micro et sourdine'],
  ['game', 'widgetGame', 'Jeu', 'Saut de gravité et la Roue'],
];
const ACCOUNT_WIDGETS = ['widgetTwitch', 'widgetObs', 'widgetDiscord', 'widgetValorant'];
const GRIP_SVG = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const tabIcon = (p) => tabs.find((t) => t.dataset.page === p).querySelector('svg').cloneNode(true);
function moduleText(name, desc) {
  const box = document.createElement('span');
  box.className = 'mod-txt';
  const n = document.createElement('b');
  n.textContent = name;
  const d = document.createElement('span');
  d.textContent = desc;
  box.append(n, d);
  return box;
}
const modList = $('.mod-list');
const modRows = {};
MODULES.forEach(([p, key, name, desc]) => {
  const row = document.createElement('div');
  row.className = 'mod-row';
  row.dataset.page = p;
  const grip = document.createElement('span');
  grip.className = 'mod-grip';
  grip.title = 'Glisser pour changer l’ordre';
  grip.innerHTML = GRIP_SVG; // the app's own icon
  const ic = document.createElement('span');
  ic.className = 'mod-ic';
  ic.append(tabIcon(p));
  const sw = document.createElement('label');
  sw.className = 'sw-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.setting = key;
  input.setAttribute('aria-label', name);
  const knob = document.createElement('i');
  knob.className = 'sw';
  sw.append(input, knob);
  row.append(grip, ic, moduleText(name, desc), sw);
  modList.append(row);
  modRows[p] = row;
});

// drag a row by its dots: the others make room, the order is saved on release
let drag = null;
modList.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.mod-grip');
  if (!grip || e.button !== 0) return;
  e.preventDefault();
  const rows = [...modList.children];
  const row = grip.closest('.mod-row');
  const step = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : row.offsetHeight;
  drag = { row, rows, step, y0: e.clientY, from: rows.indexOf(row), to: rows.indexOf(row) };
  grip.setPointerCapture(e.pointerId);
  row.classList.add('dragging');
  modList.classList.add('sorting');
});
modList.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y0;
  const { rows, from, step } = drag;
  drag.to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
  drag.row.style.translate = `0 ${dy}px`;
  rows.forEach((r, i) => {
    if (r === drag.row) return;
    const shift = i > from && i <= drag.to ? -step : i < from && i >= drag.to ? step : 0;
    r.style.translate = shift ? `0 ${shift}px` : '';
  });
});
function endDrag() {
  if (!drag) return;
  const { rows, row, from, to } = drag;
  drag = null;
  modList.classList.remove('sorting');
  row.classList.remove('dragging');
  modList.classList.add('settle'); // rows jump to their new place without sliding back
  rows.forEach((r) => { r.style.translate = ''; });
  requestAnimationFrame(() => requestAnimationFrame(() => modList.classList.remove('settle')));
  if (from === to) return;
  const order = rows.map((r) => r.dataset.page);
  order.splice(to, 0, ...order.splice(from, 1));
  applyTabOrder(order); // right away, the saved settings confirm it
  window.lagon.setSetting('tabOrder', order).then(applySettings);
}
modList.addEventListener('pointerup', endDrag);
modList.addEventListener('pointercancel', endDrag);
modList.addEventListener('lostpointercapture', endDrag);

// ---------- welcome screen (first launch, or Settings > Général) ----------
const welcomeEl = $('.welcome');
const wlGo = $('.wl-go');
const wlCards = MODULES.map(([p, key, name, desc]) => {
  const b = document.createElement('button');
  b.className = 'wl-card';
  b.dataset.key = key;
  const ic = document.createElement('span');
  ic.className = 'mod-ic';
  ic.append(tabIcon(p));
  const check = document.createElement('i');
  check.className = 'wl-check';
  b.append(ic, moduleText(name, desc), check);
  b.addEventListener('click', () => window.lagon.setSetting(key, !settings[key]).then(applySettings));
  return b;
});
$('.wl-grid').append(...wlCards);
function renderWelcome() {
  wlCards.forEach((c) => c.classList.toggle('on', !!settings[c.dataset.key]));
  const accounts = ACCOUNT_WIDGETS.some((k) => settings[k]);
  wlGo.textContent = accounts ? 'Suivant : me connecter' : 'C’est parti';
  $('.wl-note').style.visibility = accounts ? '' : 'hidden';
}
function startWelcome() {
  welcomeOn = true;
  clearTimeout(peekTimer); // a song peek started just before would close it
  peekTimer = null;
  renderWelcome();
  island.classList.add('wl-on'); // not "welcome": that class is the screen itself
  syncBig();
  setOpen(true);
}
wlGo.addEventListener('click', () => {
  welcomeOn = false;
  island.classList.remove('wl-on');
  if (!settings.welcomeDone) window.lagon.setSetting('welcomeDone', true).then(applySettings);
  if (ACCOUNT_WIDGETS.some((k) => settings[k])) {
    // accounts to connect: straight to them
    setPage('settings', false, false);
    showCategory('accounts', false);
  } else {
    syncBig();
    if (!hovering) setOpen(false);
  }
});
$('.wl-again').addEventListener('click', startWelcome);
const pingInput = $('.ping-host');
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;

let fpsWasOn = false;
function applySettings(s) {
  if (!s) return;
  settings = s;
  if (!settingsLoaded) {
    settingsLoaded = true;
    // back on the tab used last time (if its widget is still on)
    if (s.lastPage && PAGES.includes(s.lastPage) && pageEnabled(s.lastPage) && s.lastPage !== page) setPage(s.lastPage, true);
    if (s.welcomeDone === false) setTimeout(startWelcome, 600); // first launch: pick the modules
  }
  applyTabOrder(s.tabOrder);
  if (welcomeOn) renderWelcome();
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
  applyTheme();
  $('.face').dataset.look = s.faceStyle || 'classic';
  if (typeof syncOled === 'function') syncOled();
  // options of a widget that is off are greyed out
  const needs = { ...s, styleGlass: s.islandStyle === 'glass' };
  settingsPage.querySelectorAll('[data-needs]').forEach((el) => el.classList.toggle('off', !needs[el.dataset.needs]));
  applyWidgets();
  island.classList.toggle('click-mode', s.openMode === 'click');
  island.classList.toggle('focus', !!s.focusMode);
  if (typeof renderDiscord === 'function') renderDiscord();
  if (typeof renderHotkeys === 'function') renderHotkeys();
  if (s.fpsCounter && !fpsWasOn && settingsLoaded) window.lagon.sys('fpscheck');
  fpsWasOn = !!s.fpsCounter;
  if (typeof renderFps === 'function') renderFps();
  if (typeof renderBarStats === 'function') renderBarStats();
  if (typeof syncStats === 'function') syncStats();
  if (s.focusMode) { hideOsd(); if (island.classList.contains('open') && !hovering && !welcomeOn) setOpen(false); }
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
const WIDGET_OF_PAGE = { music: 'widgetMusic', sound: 'widgetSound', pc: 'widgetPc', time: 'widgetTime', twitch: 'widgetTwitch', valorant: 'widgetValorant', discord: 'widgetDiscord', obs: 'widgetObs', game: 'widgetGame' };
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
const halos = [...document.querySelectorAll('.halo i')];
let animTimer = null;
let animWasOn = { eq: true, sleep: true }; // forces one reset on start
let halosMoved = false;

const closedView = () => !island.classList.contains('open') && !island.classList.contains('osd');
const eqWanted = () => closedView() && island.classList.contains('playing') && !island.classList.contains('idle');
const sleepWanted = () => closedView() && face.classList.contains('sleep') && faceVisible();
// colour glows drift while they are shown: open card with music, or closed bar while music plays
const haloWanted = () => !!settings.halos && (island.classList.contains('open')
  ? !island.classList.contains('no-media')
  : island.classList.contains('playing') && !island.classList.contains('idle'));

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
  if (haloWanted()) {
    // slow Lissajous drift (periods 23-37 s), in % of the layer (1.5x the island)
    const w = (period, phase = 0) => Math.sin((t / period) * 2 * Math.PI + phase);
    halos[0].style.transform = `translate(${(7 * w(23)).toFixed(2)}%, ${(8 * w(31, 1)).toFixed(2)}%) scale(${(1 + 0.06 * w(19, 2)).toFixed(3)})`;
    halos[1].style.transform = `translate(${(-7 * w(29, 2)).toFixed(2)}%, ${(-8 * w(37)).toFixed(2)}%) scale(${(1 + 0.06 * w(27)).toFixed(3)})`;
    halosMoved = true;
  } else if (halosMoved && !settings.halos) {
    // option turned off: back to the fixed place (when only hidden, they stay where they are)
    halos.forEach((h) => { h.style.transform = ''; });
    halosMoved = false;
  }
  animWasOn = { eq, sleep };
}

function syncAnim() {
  const need = !paused && (eqWanted() || sleepWanted() || haloWanted());
  if (need && !animTimer) animTimer = setInterval(animFrame, 66);
  else if (!need && animTimer) { clearInterval(animTimer); animTimer = null; }
  if (!need) animFrame(); // settle the bars / face once
}

// ---------- OLED care ----------
// oledShift: the closed bar's content (clock, face, text, pinned stats) moves by 1 px every 90 s
// along a 5 x 3 px snake and back, so no white pixel stays lit at the same place for hours.
const OLED_PATH = (() => {
  const snake = [];
  [-1, 0, 1].forEach((y, i) => { const xs = [-2, -1, 0, 1, 2]; (i % 2 ? xs.reverse() : xs).forEach((x) => snake.push([x, y])); });
  return snake.concat(snake.slice(1, -1).reverse());
})();
let oledTimer = null;
let oledStep = 7; // [0, 0]
function oledTick() {
  if (paused) return;
  oledStep = (oledStep + 1) % OLED_PATH.length;
  const [x, y] = OLED_PATH[oledStep];
  island.style.setProperty('--ox', x + 'px');
  island.style.setProperty('--oy', y + 'px');
}
function syncOled() {
  if (settings.oledShift && !oledTimer) oledTimer = setInterval(oledTick, 90000);
  else if (!settings.oledShift && oledTimer) {
    clearInterval(oledTimer);
    oledTimer = null;
    oledStep = 7;
    island.style.removeProperty('--ox');
    island.style.removeProperty('--oy');
  }
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
  syncStats(); // stats, FPS and the mini-game stop while hidden
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
      : high ? `${s.rr} RR` + (s.leaderboard ? ` · top ${s.leaderboard.toLocaleString('fr-FR')}` : '')
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
const DC_SVG = (p) => `<svg class="dcv" viewBox="0 0 24 24">${p}</svg>`;
// solid shapes (like Discord's): thin outlines broke into pieces at 14 px and looked half hidden.
// The bar across is drawn twice: a dark gap, then the red line, so it reads over the shape.
const DC_CUT = '<path class="gap" d="M4 3.5l16.5 16.5"/><path class="cut" d="M4 3.5l16.5 16.5"/>';
const DC_MIC_OFF = DC_SVG('<rect class="f" x="8.5" y="2" width="7" height="12.5" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22"/>' + DC_CUT);
const DC_MIC = DC_SVG('<rect class="f" x="8.5" y="2" width="7" height="12.5" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22"/>');
const DC_HEAD = DC_SVG('<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><path class="f" d="M3 13.5h4.2v6.5H5a2 2 0 0 1-2-2zM21 13.5h-4.2v6.5H19a2 2 0 0 0 2-2z"/>');
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
  // mic / sound buttons: red while cut; greyed if Discord hasn't allowed Lagon to change them
  $('.page.discord').classList.toggle('online', connected);
  const can = connected && !!st.control;
  const mic = $('.dc-tg-mic'), deaf = $('.dc-tg-deaf');
  const micHtml = st.mute || st.deaf ? DC_MIC_OFF : DC_MIC, deafHtml = st.deaf ? DC_DEAF : DC_HEAD;
  if (mic.innerHTML !== micHtml) mic.innerHTML = micHtml;
  if (deaf.innerHTML !== deafHtml) deaf.innerHTML = deafHtml;
  mic.classList.toggle('cut', !!(st.mute || st.deaf));
  deaf.classList.toggle('cut', !!st.deaf);
  mic.disabled = deaf.disabled = !can;
  const why = connected && !st.control ? ' (autorise le contrôle dans Paramètres → Discord)' : '';
  mic.title = (st.mute ? 'Réactiver le micro' : 'Couper le micro') + why;
  deaf.title = (st.deaf ? 'Désactiver la sourdine' : 'Sourdine') + why;
  $('.dc-ctl-row').hidden = !(connected && !st.control);
  renderDiscordBadge();
}

$('.dc-tg-mic').addEventListener('click', () => window.lagon.discordToggle(false));
$('.dc-tg-deaf').addEventListener('click', () => window.lagon.discordToggle(true));
$('.dc-reauth').addEventListener('click', () => Promise.resolve(window.lagon.discordReauthorize()).then((st) => { if (st) { dc = st; renderDiscord(); } }));
// closed bar: a click on the red icon gives you your voice back (instead of opening the bar)
$('.c-dc').addEventListener('click', (e) => {
  const st = dc || {};
  if (!(st.status === 'connected' && st.control && (st.mute || st.deaf))) return;
  e.stopPropagation();
  window.lagon.discordToggle(!!st.deaf);
});
window.lagon.onDiscordVoiceSet((v) => {
  if (!v) return;
  const title = v.deaf ? 'Sourdine activée' : v.mute ? 'Micro coupé' : 'Micro réactivé';
  showHud({ kind: 'dcvoice', icon: v.deaf ? DC_DEAF : v.mute ? DC_MIC_OFF : DC_MIC, title, tone: v.mute || v.deaf ? 'hot' : 'ok' }, 1600);
});
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
  // a new version: red dot on the gear, and the row stands out at the top of Settings > Général
  const ready = u.status === 'available';
  gear.classList.toggle('has-update', ready);
  $('.up-row').classList.toggle('ready', ready);
}
// with an update waiting, the gear opens straight on Settings > Général, where the button is
gear.addEventListener('click', () => {
  if (up && up.status === 'available') setTimeout(() => showCategory('general', false), 0);
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

// ---------- stats pinned to the closed bar ----------
// Chosen in Settings > Bar (CPU, GPU, GPU temperature, ping, Twitch followers): a strip at the right
// end of the closed island, which grows by the strip's width.
let barSys = null;
const barStatsEl = $('.c-stats');
function renderBarStats() {
  const s = barSys || {};
  const items = [];
  if (settings.barCpu) items.push(['CPU', s.cpu >= 0 ? `${Math.round(s.cpu)}%` : '–']);
  if (settings.barGpu) items.push(['GPU', s.gpu >= 0 ? `${s.gpu}%` : '–']);
  if (settings.barTemp) items.push(['', s.gpuTemp > 0 ? `${s.gpuTemp}°` : '–°']);
  if (settings.barPing) items.push(['', s.ping >= 0 ? `${s.ping} ms` : '– ms']);
  if (settings.barFps && settings.fpsCounter) items.push(['FPS', fpsNow && fpsNow.state === 'ok' && fpsNow.fps >= 0 ? String(fpsNow.fps) : '–']);
  if (settings.barFollowers) {
    const f = tw && tw.stats && tw.stats.followers;
    items.push(['♥', f != null ? Number(f).toLocaleString('fr-FR') : '–']);
  }
  const on = items.length > 0 && !settings.focusMode;
  island.classList.toggle('has-stats', on);
  barStatsEl.replaceChildren(...items.map(([k, v]) => {
    const span = document.createElement('span');
    span.className = 'cs';
    if (k) { const b = document.createElement('b'); b.textContent = k; span.append(b, ' '); }
    span.append(v);
    return span;
  }));
  // a stable width (it would jitter with every number otherwise): measured, rounded up to 8 px
  // the strip is hidden while the bar is open or shows a pop-up: shown for the measure only, or it
  // would measure 0 and the music would cover it once the bar closes
  let w = 0;
  if (on) {
    const hidden = getComputedStyle(barStatsEl).display === 'none';
    if (hidden) { barStatsEl.style.visibility = 'hidden'; barStatsEl.style.display = 'flex'; }
    w = barStatsEl.scrollWidth;
    if (hidden) { barStatsEl.style.display = ''; barStatsEl.style.visibility = ''; }
  }
  const xw = on ? Math.ceil((w + 14) / 8) * 8 : 0;
  if (xw !== barXw) {
    barXw = xw;
    island.style.setProperty('--xw', xw + 'px');
    sendSizes(island.classList.contains('idle'));
  }
  // FPS needs the FPS counter: lit only when both are on
  settingsPage.querySelectorAll('.bar-stats button').forEach((b) => b.classList.toggle('on', !!settings[b.dataset.k] && (b.dataset.k !== 'barFps' || !!settings.fpsCounter)));
}
settingsPage.querySelectorAll('.bar-stats button').forEach((b) => b.addEventListener('click', async () => {
  const k = b.dataset.k;
  if (k === 'barFps' && !(settings.barFps && settings.fpsCounter)) {
    // one click is enough: the FPS chip also switches the FPS counter on
    if (!settings.fpsCounter) await window.lagon.setSetting('fpsCounter', true).then(applySettings);
    window.lagon.setSetting('barFps', true).then(applySettings);
    return;
  }
  window.lagon.setSetting(k, !settings[k]).then(applySettings);
}));
window.lagon.onStats((s) => { barSys = s; if (island.classList.contains('has-stats')) renderBarStats(); });
window.lagon.onTwitchStats(() => renderBarStats());

// ---------- FPS counter (PC tile, closed bar, Réglages › Modules › PC) ----------
// The helper counts the frames Windows sees the app in front present (ETW, never the game itself).
// Windows only lets an admin or a member of "Performance Log Users" read them: one "Oui" (UAC) and a
// new Windows session, once.
// the status and the button exist twice: Modules › PC, and under the bar chips (Général)
const fpsStatus = [...document.querySelectorAll('.fps-status')];
const fpsGrantRow = [...document.querySelectorAll('.fps-grant-row')];
function renderFps() {
  const on = !!settings.fpsCounter;
  $('.page.pc').classList.toggle('with-fps', on);
  const f = fpsNow;
  if (on) {
    const denied = fpsAccess === false || (f && f.state === 'denied');
    let value = null, sub = '';
    if (f && f.state === 'ok' && f.fps >= 0) { value = [f.fps, '']; sub = f.app || 'appli au premier plan'; }
    else if (denied) sub = fpsGrant === 'ok' || fpsGrant === 'already' ? 'ferme ta session Windows' : 'à autoriser (Réglages)';
    else if (f && f.state === 'error') sub = 'indisponible';
    else sub = f ? 'aucun jeu au premier plan' : ' ';
    setTile('fps', value, sub, value ? Math.min(1, f.fps / 240) : 0);
  }
  // settings: what Windows allows, and the button to ask for it
  let text = '';
  let button = false;
  if (fpsGrant === 'ok' || fpsGrant === 'already') text = 'C’est fait ! Ferme ta session Windows et rouvre-la une fois (ou redémarre le PC) : les FPS s’afficheront ensuite.';
  else if (fpsAccess === true) text = 'Autorisé par Windows : les FPS s’affichent dans l’onglet PC, et dans la barre fermée si tu choisis « FPS » (Général › Barre).';
  else if (fpsAccess === false) {
    button = true;
    text = fpsGrant === 'cancelled' ? 'Annulé. Tu peux réessayer quand tu veux.'
      : fpsGrant === 'error' ? 'Ça n’a pas marché. Réessaie, ou demande à un compte administrateur de ce PC.'
      : 'Windows doit d’abord autoriser ton compte à lire ces mesures : une fenêtre Windows te demandera « Oui » une seule fois, puis il faudra fermer ta session et la rouvrir.';
  }
  fpsStatus.forEach((el) => { el.textContent = text; el.hidden = !text; });
  fpsGrantRow.forEach((el) => { el.hidden = !button; });
  // under the bar chips: only while FPS is chosen there and Windows still has to allow it
  $('.fps-bar-note').hidden = !(on && settings.barFps && fpsAccess !== true && text);
}
document.querySelectorAll('.fps-grant').forEach((b) => b.addEventListener('click', () => {
  fpsGrant = 'asking';
  fpsStatus.forEach((el) => { el.textContent = 'Réponds « Oui » dans la fenêtre de Windows…'; el.hidden = false; });
  fpsGrantRow.forEach((el) => { el.hidden = true; });
  window.lagon.sys('fpsgrant');
}));
if (window.lagon.onFps) window.lagon.onFps((m) => {
  if (!m) return;
  if (m.t === 'fpsaccess') fpsAccess = !!m.ok;
  else if (m.t === 'fpsgrant') fpsGrant = m.result;
  else if (m.t === 'fps') { fpsNow = m; if (m.state === 'ok') fpsAccess = true; else if (m.state === 'denied') fpsAccess = false; }
  renderFps();
  if (m.t === 'fps' && island.classList.contains('has-stats')) renderBarStats();
});

// ---------- shortcuts (Settings > Shortcuts) ----------
// Click one, then press the keys: Ctrl / Alt / Shift + a letter, a digit or F1–F12.
const HK_DEFAULTS = { focusHotkey: 'ctrl+alt+f', discordMuteHotkey: 'ctrl+alt+m', discordDeafHotkey: 'ctrl+alt+d', reloadHotkey: 'ctrl+alt+r' };
const HK_NAMES = { focusHotkey: 'Mode focus', discordMuteHotkey: 'Micro Discord', discordDeafHotkey: 'Sourdine Discord', reloadHotkey: 'Recharger Lagon' };
let hkState = {};
let hkEditing = null;
const hkLabel = (s) => (!s || s === 'off' ? 'Aucun' : s.split('+').map((p) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Maj' })[p] || p.toUpperCase()).join(' + '));
function hkError(msg) { $('.hk-err').textContent = msg || ''; }
function renderHotkeys() {
  document.querySelectorAll('.hk-row').forEach((row) => {
    const key = row.dataset.hk;
    const btn = row.querySelector('.hk-btn');
    const editing = hkEditing === key;
    btn.textContent = editing ? 'Appuie sur les touches…' : hkLabel(settings[key]);
    btn.classList.toggle('editing', editing);
    const taken = !editing && hkState[key] === 'taken' && settings[key] !== 'off';
    btn.classList.toggle('taken', taken);
    btn.title = taken ? 'Déjà utilisé par une autre application : choisis-en un autre' : '';
  });
}
function hkStop() {
  if (!hkEditing) return;
  hkEditing = null;
  window.lagon.keyboard(false);
  window.lagon.hotkeysPause(false);
  renderHotkeys();
}
document.querySelectorAll('.hk-row').forEach((row) => row.querySelector('.hk-btn').addEventListener('click', () => {
  if (hkEditing === row.dataset.hk) { hkStop(); return; }
  hkEditing = row.dataset.hk;
  hkError('');
  window.lagon.keyboard(true); // keys go to Lagon while recording
  window.lagon.hotkeysPause(true); // and not to its own shortcuts
  renderHotkeys();
}));
document.addEventListener('keydown', (e) => {
  if (!hkEditing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { hkStop(); return; }
  const key = hkEditing;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    window.lagon.setSetting(key, 'off').then(applySettings);
    hkStop();
    return;
  }
  const m = /^Key([A-Z])$/.exec(e.code) || /^Digit([0-9])$/.exec(e.code) || /^(F(?:[1-9]|1[0-2]))$/.exec(e.code);
  if (!m) return; // a modifier alone: wait for the rest
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean);
  if (!mods.length) { hkError('Ajoute Ctrl, Alt ou Maj avec la touche.'); return; }
  const spec = [...mods, m[1].toLowerCase()].join('+');
  const other = Object.keys(HK_DEFAULTS).find((k) => k !== key && settings[k] === spec);
  if (other) { hkError(`${hkLabel(spec)} sert déjà à « ${HK_NAMES[other]} ».`); return; }
  window.lagon.setSetting(key, spec).then(applySettings);
  hkStop();
}, true);
$('.hk-reset').addEventListener('click', async () => {
  hkStop();
  hkError('');
  let s = null;
  for (const [k, v] of Object.entries(HK_DEFAULTS)) s = await window.lagon.setSetting(k, v);
  applySettings(s);
});
window.lagon.onHotkeys((st) => { if (st) { hkState = st; renderHotkeys(); } });
Promise.resolve(window.lagon.hotkeysState && window.lagon.hotkeysState()).then((st) => { if (st) { hkState = st; renderHotkeys(); } });

// ---------- mini-game: "Saut de gravité" (one key, endless) ----------
// The little face runs along the card; a click or Space sends it from the floor to the ceiling
// (and back) over the spikes. Faster and faster. Drawn on a canvas, only while it is played on
// screen: leaving the tab, closing the bar or a fullscreen app pauses it (no frame drawn then).
(() => { // a function, not a bare block: its function names stay inside (a bare block once replaced render())
  const canvas = $('.gm-canvas');
  const ctx = canvas.getContext('2d');
  const gmScore = $('.gm-score'), gmBest = $('.gm-best'), gmMsg = $('.gm-msg'), gmTitle = $('.gm-title'), gmSub = $('.gm-sub');
  const SIZE = 22, PAD = 10, PX = 64;          // player size, floor / ceiling margin, player x
  const GRAV = 2700, SPEED0 = 230, SPEEDMAX = 560, ACCEL = 7;
  let W = 0, H = 0, colors = null;
  let st = 'ready', raf = 0, last = 0, keyboardOn = false;
  let y = 0, vy = 0, dir = 1, grounded = true, buffered = 0, speed = SPEED0, dist = 0, t = 0;
  let spikes = [], nextAt = 0, lastSide = 1, trail = [], deadAt = 0, blink = 0, newBest = false;

  const floorY = () => H - PAD - SIZE;   // top of the player when it stands on the floor
  const ceilY = () => PAD;               // ... when it hangs from the ceiling
  const score = () => Math.floor(dist / 12);

  function readColors() {
    const cs = getComputedStyle(island);
    const v = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
    colors = { fg: v('--fg', '255, 255, 255'), accent: v('--accent', '#7aa2ff'), eye: v('--on-accent', '#000'), bg: v('--bg', '#000'), hot: v('--hot', '#ff5f57') };
  }

  function fit() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth), h = Math.round(canvas.clientHeight);
    if (!w || !h || !r.width) return false;
    if (w !== W || h !== H || canvas.width !== Math.round(w * dpr)) {
      W = w; H = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (st !== 'play' && st !== 'pause') y = floorY();
    }
    return true;
  }

  function message(title, sub) {
    gmMsg.hidden = !title;
    gmTitle.textContent = title || '';
    gmSub.textContent = sub || '';
  }
  function hud() {
    const best = Number(settings.gameBest) || 0;
    gmBest.textContent = best ? `Record ${best}` : '';
    gmScore.textContent = st === 'ready' ? '' : String(score());
  }

  function reset() {
    fit();
    y = floorY(); vy = 0; dir = 1; grounded = true; buffered = 0;
    speed = SPEED0; dist = 0; t = 0; spikes = []; trail = []; lastSide = 1; newBest = false;
    nextAt = W + 120;
  }

  // a group of 1 to 3 spikes on the floor or the ceiling; always leaves time to switch sides
  function spawn() {
    const n = 1 + Math.floor(Math.random() * (t < 8 ? 2 : 3));
    const side = Math.random() < 0.5 ? 1 : -1;
    const w = n * 16;
    const h = 13 + Math.random() * 5;
    spikes.push({ x: nextAt, w, h, n, side });
    const travel = Math.sqrt((2 * (floorY() - ceilY())) / GRAV) * speed; // ground covered while switching sides
    const minGap = side !== lastSide ? travel + SIZE + 26 : SIZE + 40;
    lastSide = side;
    nextAt += w + Math.max(minGap, speed * (0.5 + Math.random() * 0.7));
  }

  function flip() {
    if (!grounded) { buffered = 0.13; return; } // pressed just before landing: flips on landing
    dir = -dir; grounded = false; vy = dir * 90; buffered = 0;
  }

  function press() {
    if (st === 'play') { flip(); return; }
    if (st === 'over' && performance.now() - deadAt < 450) return; // not a restart by accident
    if (st === 'ready' || st === 'over') reset();
    readColors();
    st = 'play';
    message('');
    hud();
    last = performance.now();
    loop();
  }

  function die() {
    st = 'over';
    deadAt = performance.now();
    cancelAnimationFrame(raf); raf = 0;
    const s = score(), best = Number(settings.gameBest) || 0;
    newBest = s > best;
    if (newBest) { settings.gameBest = s; window.lagon.setSetting('gameBest', s); }
    message(newBest ? 'Nouveau record !' : 'Perdu !', `Score ${s}${!newBest && best ? ` · record ${best}` : ''} — clique ou appuie sur Espace pour rejouer`);
    hud();
    draw();
  }

  function step(dt) {
    t += dt;
    speed = Math.min(SPEEDMAX, SPEED0 + t * ACCEL);
    const dx = speed * dt;
    dist += dx;
    // gravity pulls towards the floor (dir 1) or the ceiling (dir -1)
    if (!grounded) {
      vy += dir * GRAV * dt;
      y += vy * dt;
      if (dir === 1 && y >= floorY()) { y = floorY(); vy = 0; grounded = true; }
      if (dir === -1 && y <= ceilY()) { y = ceilY(); vy = 0; grounded = true; }
      trail.push({ x: PX, y, a: 0.35 });
    }
    if (buffered > 0) { buffered -= dt; if (grounded) flip(); }
    trail.forEach((p) => { p.x -= dx; p.a -= dt * 1.6; });
    trail = trail.filter((p) => p.a > 0);
    // spikes scroll left; new ones come in from the right
    spikes.forEach((s) => { s.x -= dx; });
    nextAt -= dx;
    spikes = spikes.filter((s) => s.x + s.w > -10);
    while (nextAt < W + 60) spawn();
    // hit: the player's box (a bit smaller) against the middle of each spike
    const px0 = PX + 3, px1 = PX + SIZE - 3, py0 = y + 3, py1 = y + SIZE - 3;
    for (const s of spikes) {
      for (let i = 0; i < s.n; i++) {
        const cx = s.x + i * 16 + 8;
        const sx0 = cx - 4, sx1 = cx + 4;
        const sy0 = s.side === 1 ? H - PAD - s.h + 3 : PAD, sy1 = s.side === 1 ? H - PAD : PAD + s.h - 3;
        if (px1 > sx0 && px0 < sx1 && py1 > sy0 && py0 < sy1) return false;
      }
    }
    return true;
  }

  function draw() {
    if (!fit()) return;
    if (!colors) readColors();
    const { fg, accent, eye } = colors;
    ctx.clearRect(0, 0, W, H);
    // floor and ceiling, with marks that scroll to show the speed
    ctx.fillStyle = `rgba(${fg}, 0.16)`;
    ctx.fillRect(0, PAD - 2, W, 2);
    ctx.fillRect(0, H - PAD, W, 2);
    ctx.fillStyle = `rgba(${fg}, 0.10)`;
    const off = -(dist % 40);
    for (let x = off; x < W; x += 40) { ctx.fillRect(x, PAD - 6, 10, 2); ctx.fillRect(x + 20, H - PAD + 4, 10, 2); }
    // spikes
    ctx.fillStyle = `rgba(${fg}, 0.82)`;
    for (const s of spikes) {
      ctx.beginPath();
      for (let i = 0; i < s.n; i++) {
        const x0 = s.x + i * 16;
        if (s.side === 1) { ctx.moveTo(x0, H - PAD); ctx.lineTo(x0 + 8, H - PAD - s.h); ctx.lineTo(x0 + 16, H - PAD); }
        else { ctx.moveTo(x0, PAD); ctx.lineTo(x0 + 8, PAD + s.h); ctx.lineTo(x0 + 16, PAD); }
      }
      ctx.fill();
    }
    // trail, then the little face (its style follows Réglages › Petit visage)
    for (const p of trail) {
      ctx.globalAlpha = Math.max(0, p.a);
      ctx.fillStyle = accent;
      roundRect(p.x + 4, p.y + 4, SIZE - 8, SIZE - 8, 5);
    }
    ctx.globalAlpha = 1;
    drawFace(PX, y);
    // not playing: the scene stays behind the message, dimmed
    if (st !== 'play') {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function roundRect(x, yy, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, yy);
    ctx.arcTo(x + w, yy, x + w, yy + h, r);
    ctx.arcTo(x + w, yy + h, x, yy + h, r);
    ctx.arcTo(x, yy + h, x, yy, r);
    ctx.arcTo(x, yy, x + w, yy, r);
    ctx.closePath();
    ctx.fill();
  }

  function drawFace(x, yy) {
    const look = settings.faceStyle || 'classic';
    const up = dir === -1; // on the ceiling: upside down, ears / antenna point down
    const { accent, eye } = colors;
    ctx.fillStyle = accent;
    if (look === 'cat') {
      const ey = up ? yy + SIZE : yy;
      const s = up ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x + 2, ey); ctx.lineTo(x + 5, ey + s * 7); ctx.lineTo(x + 9, ey);
      ctx.moveTo(x + SIZE - 9, ey); ctx.lineTo(x + SIZE - 5, ey + s * 7); ctx.lineTo(x + SIZE - 2, ey);
      ctx.fill();
    }
    if (look === 'robot') {
      const ay = up ? yy + SIZE : yy;
      ctx.fillRect(x + SIZE / 2 - 1, up ? ay : ay - 6, 2, 6);
      ctx.beginPath(); ctx.arc(x + SIZE / 2, up ? ay + 7 : ay - 7, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    roundRect(x, yy, SIZE, SIZE, look === 'robot' ? 4 : 8);
    // eyes (closed for a blink now and then, crosses when lost)
    ctx.fillStyle = eye;
    ctx.strokeStyle = eye;
    const ey = yy + (up ? 12 : 7);
    const eyesX = [x + 7, x + SIZE - 9];
    if (st === 'over') {
      ctx.lineWidth = 1.6;
      eyesX.forEach((ex) => { ctx.beginPath(); ctx.moveTo(ex - 1, ey); ctx.lineTo(ex + 3, ey + 4); ctx.moveTo(ex + 3, ey); ctx.lineTo(ex - 1, ey + 4); ctx.stroke(); });
    } else if (blink > 0) {
      eyesX.forEach((ex) => ctx.fillRect(ex - 0.5, ey + 1.5, 3.5, 1.5));
    } else {
      eyesX.forEach((ex) => roundRect(ex, ey, 2.6, 4.2, 1.3));
    }
    if (look === 'cute') {
      ctx.fillStyle = 'rgba(255, 120, 150, 0.55)';
      ctx.beginPath(); ctx.arc(x + 4.5, ey + (up ? -2 : 6), 2, 0, Math.PI * 2); ctx.arc(x + SIZE - 4.5, ey + (up ? -2 : 6), 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  function loop() {
    raf = requestAnimationFrame((now) => {
      raf = 0;
      if (st !== 'play') return;
      const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
      last = now;
      blink = blink > 0 ? blink - dt : Math.random() < dt / 3 ? 0.12 : 0;
      if (!step(dt)) { die(); return; }
      draw();
      gmScore.textContent = String(score());
      loop();
    });
  }

  // only while the tab is really on screen; otherwise pause and give the keyboard back
  // two games in the tab: Saut de gravité ("jump") and la Roue ("wheel"), picked top-left
  const gameEl = $('.page.game');
  const modeBtns = [...gameEl.querySelectorAll('.gm-modes button')];
  modeBtns.forEach((b) => b.addEventListener('click', () => {
    if (settings.gameMode === b.dataset.v) return;
    settings.gameMode = b.dataset.v;
    window.lagon.setSetting('gameMode', b.dataset.v);
    sync();
  }));

  function sync() {
    const mode = settings.gameMode === 'wheel' ? 'wheel' : 'jump';
    gameEl.dataset.mode = mode;
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
    const onTab = island.classList.contains('open') && page === 'game' && !paused && !welcomeOn;
    if (wheel) wheel.sync(onTab && mode === 'wheel');
    const shown = onTab && mode === 'jump';
    if (!shown) {
      if (st === 'play') {
        st = 'pause';
        cancelAnimationFrame(raf); raf = 0;
        message('Pause', 'Clique ou appuie sur Espace pour reprendre');
      }
      if (keyboardOn) { keyboardOn = false; window.lagon.keyboard(false); }
      return;
    }
    if (st === 'ready') message('Saut de gravité', 'Clique ou appuie sur Espace : le petit bonhomme passe du sol au plafond. Évite les pics, ça accélère !');
    hud();
    if (st !== 'play') requestAnimationFrame(draw); // after the card has its size
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Space works too from now on: Lagon takes the keyboard while you play (given back on leaving)
    if (!keyboardOn) { keyboardOn = true; window.lagon.keyboard(true); }
    press();
  });
  window.addEventListener('keydown', (e) => {
    if (page !== 'game' || !island.classList.contains('open') || settings.gameMode === 'wheel') return;
    if (e.code !== 'Space' && e.code !== 'ArrowUp' && e.code !== 'KeyW') return;
    e.preventDefault();
    if (!e.repeat) press();
  });

  game = { sync };
})();

// ---------- mini-game: la Roue (play chips, double or nothing) ----------
// A strip of 15 cases (7 red, 7 black, 1 green) slides under the marker and slows down. Pick a bet,
// then click a colour: red / black pay x2, green x14. Chips only (nothing real), kept in the
// settings; at 0 the bank starts again at 100. The strip only moves during a spin (one transition).
(() => { // same: own scope (its render() replaced the music one in 0.11.0)
  const el = $('.wh');
  const track = $('.wh-track');
  const bankEl = $('.wh-bank'), bestEl = $('.wh-best'), resEl = $('.wh-res');
  const betBtns = [...el.querySelectorAll('[data-bet]')];
  const ORDER = ['g', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b', 'r', 'b'];
  const NAME = { r: 'Rouge', b: 'Noir', g: 'Vert' };
  const PITCH = 40, CELL = 36, REPS = 9;
  let betKind = '10', spinning = false, at = 15, built = false; // at: case under the marker (2nd lap: cases on both sides)
  const fmt = (n) => Number(n).toLocaleString('fr-FR');
  const coins = () => (settings.wheelCoins == null ? 100 : Math.max(0, Math.floor(Number(settings.wheelCoins) || 0)));

  function build() {
    if (built) return;
    built = true;
    const cells = [];
    for (let i = 0; i < REPS; i++) ORDER.forEach((c) => { const d = document.createElement('i'); d.className = `wh-cell ${c}`; cells.push(d); });
    track.replaceChildren(...cells);
  }
  // put case number n (of the whole strip) under the marker, with a small offset inside the case
  function place(n, jitter, animate) {
    const center = track.parentElement.clientWidth / 2;
    track.classList.toggle('spin', animate);
    track.style.transform = `translateX(${Math.round(center - (n * PITCH + CELL / 2 + jitter))}px)`;
  }
  function bet() {
    const c = coins();
    const b = betKind === 'all' ? c : betKind === 'half' ? Math.ceil(c / 2) : Number(betKind);
    return Math.max(0, Math.min(c, b));
  }
  function render() {
    bankEl.textContent = `${fmt(coins())} jetons`;
    bestEl.textContent = `Record ${fmt(Math.max(coins(), Number(settings.wheelBest) || 0))}`;
    betBtns.forEach((b) => b.classList.toggle('on', b.dataset.bet === betKind));
    el.classList.toggle('busy', spinning);
  }
  function save(n) {
    settings.wheelCoins = n;
    window.lagon.setSetting('wheelCoins', n);
    if (n > (Number(settings.wheelBest) || 0)) { settings.wheelBest = n; window.lagon.setSetting('wheelBest', n); }
  }

  function spin(color) {
    if (spinning) return;
    const stake = bet();
    if (stake < 1) return;
    const r = new Uint32Array(2);
    crypto.getRandomValues(r);
    const hit = r[0] % 15;
    const jitter = ((r[1] % 1000) / 1000 - 0.5) * (CELL - 10);
    spinning = true;
    resEl.className = 'wh-res';
    resEl.textContent = `${fmt(stake)} sur ${NAME[color]}…`;
    save(coins() - stake); // the stake leaves the bank now (a closed Lagon can't cheat a loss)
    render();
    place(15 + (at % 15), 0, false); // back to the 2nd lap, same case: no visible jump
    void track.offsetWidth;
    at = 15 * (REPS - 2) + hit;
    place(at, jitter, true);
    setTimeout(() => {
      spinning = false;
      const got = ORDER[hit];
      if (got === color) {
        const win = stake * (color === 'g' ? 14 : 2);
        save(coins() + win);
        resEl.className = 'wh-res win';
        resEl.textContent = `${NAME[got]} ! +${fmt(win - stake)} jetons · « Tout » pour tout remiser`;
      } else if (coins() < 1) {
        save(100);
        resEl.className = 'wh-res lose';
        resEl.textContent = `${NAME[got]}… plus rien ! On te redonne 100 jetons`;
      } else {
        resEl.className = 'wh-res lose';
        resEl.textContent = `${NAME[got]}… −${fmt(stake)} jetons`;
      }
      render();
    }, 4300);
  }

  betBtns.forEach((b) => b.addEventListener('click', () => { betKind = b.dataset.bet; render(); }));
  el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => spin(b.dataset.c)));

  wheel = {
    sync(shown) {
      if (!shown) return;
      build();
      if (!spinning) { place(at, 0, false); if (!resEl.textContent) resEl.textContent = 'Choisis ta mise, puis une couleur'; }
      render();
    },
  };
})();
