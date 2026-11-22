// ===== the only line to change: your GitHub repository, as "pseudo/lagon" =====
const GITHUB_REPO = 'linor240/lagon';

// Download buttons: always the newest release on GitHub. The page asks GitHub which version is
// the latest and links straight to its installer; if that fails, the buttons open the releases page.
(async () => {
  const links = document.querySelectorAll('.dl-link');
  const notes = document.querySelectorAll('.dl-notes');
  if (!GITHUB_REPO) {
    links.forEach((a) => { a.href = '#installer'; });
    notes.forEach((a) => { a.hidden = true; });
    return;
  }
  const page = `https://github.com/${GITHUB_REPO}/releases/latest`;
  links.forEach((a) => { a.href = page; });
  notes.forEach((a) => { a.href = page; });
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!r.ok) return;
    const rel = await r.json();
    const exe = (rel.assets || []).find((x) => /setup\.exe$/i.test(x.name));
    if (exe) links.forEach((a) => { a.href = exe.browser_download_url; });
    const v = String(rel.tag_name || '').replace(/^v/i, '');
    if (v) document.querySelectorAll('.dl-version').forEach((s) => { s.textContent = `Version ${v}`; });
  } catch { /* offline or rate-limited: the releases page link stays */ }
})();

// Screenshot tabs
const shotImg = document.querySelector('.g-img');
const shotTabs = [...document.querySelectorAll('.g-tabs button')];
shotTabs.forEach((b) => b.addEventListener('click', () => {
  shotTabs.forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
  shotImg.classList.add('fade');
  setTimeout(() => {
    shotImg.onload = () => shotImg.classList.remove('fade');
    shotImg.src = `img/${b.dataset.shot}.png`;
    shotImg.alt = `Page ${b.textContent} de Lagon`;
    if (shotImg.complete) shotImg.classList.remove('fade');
  }, 180);
}));
// load the other pictures ahead so switching is instant
window.addEventListener('load', () => shotTabs.forEach((b) => { new Image().src = `img/${b.dataset.shot}.png`; }));

// The open card is 620 px wide with its shadow (the frame is 800 px for the big settings card):
// shrink it on narrow screens
const wrap = document.querySelector('.demo-wrap');
const screenEl = document.querySelector('.screen');
const fit = () => wrap.style.setProperty('--s', Math.min(1, (screenEl.clientWidth - 8) / 620));
new ResizeObserver(fit).observe(screenEl);
fit();
if (matchMedia('(hover: none)').matches) document.querySelector('.try').lastChild.textContent = 'Touche la barre pour l’ouvrir';
