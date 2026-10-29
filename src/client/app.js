(() => {
'use strict';
const D = window.__DATA__;
const REL = D.releases;
const BR = D.integration;
const TRUNK = D.trunk;
const NEWEST = D.summary.newest;
const PROD = D.prod;

const MAX_LANES = 12;
const ROW_H = 44, PROD_Y = 11, RIB_Y = 22, TRUNK_Y = 34, PAD = 44, MIN_W = 13, LANE_H = 19;
// the newest tag still needs room on its right for its merge arm and label
const PAD_R = 110;
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/* Golden-angle hues keep even adjacent releases far apart in colour. */
const COLOR = new Map();
REL.forEach((r, i) => COLOR.set(r.name, `hsl(${(i * 137.508) % 360} 62% var(--l, 44%))`));
const color = (r) => COLOR.get(r.name);

/* Per-PR verdict from the model: did the work survive to the tips?
   carried = on the trunk · drift = shipped but the trunk has not seen it
   · lost = in no integration branch and not in the newest release. */
const VERDICT = { carried: 'var(--ok)', drift: 'var(--warn)', lost: 'var(--bad)' };
const VLABEL = { carried: 'carried forward', drift: 'not on ' + TRUNK, lost: 'not in ' + NEWEST };
/* Every target a PR was checked against: the integration branches and the newest release. */
const foundOn = (p) => Object.keys(p.status || {}).filter((k) => p.status[k] !== 'absent');
/* A tag on a maintenance line is not supposed to reach the trunk: say so, don't alarm. */
const tagStatus = (r, b) => (r.onLine && r.status[b] === 'absent' ? 'line' : r.status[b]);
const TAG_LABEL = { merged: 'merged', equivalent: 'equivalent', absent: 'absent', line: 'stays on its maintenance line' };
const vOf = (p) => p.verdict || 'carried';
const relVerdict = (r) => (r.lostPRs ? 'lost' : r.driftPRs ? 'drift' : 'carried');
const worst = (st) => BR.some((b) => st[b] === 'absent') ? 'absent'
  : BR.some((b) => st[b] === 'equivalent') ? 'equivalent' : 'merged';
const STATUS_VAR = { merged: 'var(--ok)', equivalent: 'var(--warn)', absent: 'var(--bad)' };
const problem = (r) => r.lostPRs > 0 || r.driftPRs > 0;

const S = { q: '', problems: false, pre: true, zoom: 1, sel: null, hot: null };

/* ------------------------------------------------------------------ scale */
const T0 = Math.min(...REL.map((r) => Math.min(r.startDate, r.date)));
const T1 = Math.max(...REL.map((r) => r.date));
const SPAN = Math.max(T1 - T0, 86400);
let ppu = 1, contentW = 1000;

function rescale() {
  const avail = Math.max($('#track').clientWidth - PAD - PAD_R, 320);
  const base = avail / SPAN;
  // widen until a typical release is legible, then apply the user's zoom
  const durs = REL.map((r) => r.date - r.startDate).filter((d) => d > 0).sort((a, b) => a - b);
  const med = durs.length ? durs[Math.floor(durs.length / 2)] : SPAN / REL.length;
  const wanted = med > 0 ? 52 / med : base;
  ppu = Math.max(base, Math.min(wanted, base * 60)) * S.zoom;
  contentW = Math.min(SPAN * ppu + PAD + PAD_R, 200000);
  if (contentW < avail + PAD + PAD_R) contentW = avail + PAD + PAD_R;
}
const X = (t) => PAD + (t - T0) * ppu;

/* ------------------------------------------------------------------ filter */
let view = [];
function refilter() {
  const q = S.q.trim().toLowerCase();
  const num = q.replace(/^#/, '');
  view = REL.filter((r) => {
    if (!S.pre && r.pre) return false;
    if (S.problems && !problem(r)) return false;
    if (!q) return true;
    if (r.name.toLowerCase().includes(q)) return true;
    if (r.subject && r.subject.toLowerCase().includes(q)) return true;
    return r.prs.some((p) => String(p.number) === num || p.title.toLowerCase().includes(q) || (p.author || '').toLowerCase().includes(q));
  });
}
const prHit = (p) => {
  const q = S.q.trim().toLowerCase();
  if (!q) return false;
  return String(p.number) === q.replace(/^#/, '') || p.title.toLowerCase().includes(q) || (p.author || '').toLowerCase().includes(q);
};

/* ------------------------------------------------------------------- rails */
function rails() {
  let s = `<line class="rail" x1="0" y1="${TRUNK_Y}" x2="${contentW}" y2="${TRUNK_Y}" stroke="var(--trunk)" stroke-width="1.25"/>`;
  if (PROD) s += `<line class="rail" x1="0" y1="${PROD_Y}" x2="${contentW}" y2="${PROD_Y}" stroke="var(--prod)" stroke-width="1.25" stroke-dasharray="1 3"/>`;
  return s;
}

/* --------------------------------------------------------------- ribbon svg */
function ribbon(r) {
  const c = color(r);
  const x0 = X(r.startDate);
  let x1 = X(r.date);
  if (x1 - x0 < MIN_W) x1 = x0 + MIN_W;
  const trunkSt = r.status[TRUNK] || 'merged';
  const prodSt = PROD ? (r.status[PROD] || 'absent') : null;

  let s = rails();
  // branch off the trunk
  s += `<path d="M${x0},${TRUNK_Y} C${x0 + 8},${TRUNK_Y} ${x0},${RIB_Y} ${x0 + 9},${RIB_Y}" fill="none" stroke="${c}" stroke-width="2" opacity=".75"/>`;
  // the release line itself
  s += `<path class="rib" d="M${x0 + 8},${RIB_Y} L${x1},${RIB_Y}" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round"/>`;
  // a tag on a maintenance line (release-3.5, v4) is not meant to merge back
  const stays = (st) => r.onLine && st === 'absent';
  // merge back into the trunk
  if (!stays(trunkSt)) s += arm(x1, RIB_Y, TRUNK_Y, trunkSt, c, 1);
  // and up into the production line
  if (PROD && !stays(prodSt)) s += arm(x1, RIB_Y, PROD_Y, prodSt, c, -1);
  // the tag itself
  s += `<path d="M${x1},${RIB_Y - 4.5} L${x1 + 4.5},${RIB_Y} L${x1},${RIB_Y + 4.5} L${x1 - 4.5},${RIB_Y} Z" fill="${c}" stroke="var(--panel)" stroke-width="1"/>`;
  // clear of both merge arms and their warning glyphs
  s += `<text x="${x1 + 26}" y="${RIB_Y + 3.5}" class="taglab" fill="${c}" opacity=".7">${esc(r.version)}</text>`;
  return `<svg width="${contentW}" height="${ROW_H}" shape-rendering="geometricPrecision">${s}</svg>`;
}

/* One merge arm out of the release line, up (-1) or down (+1) to a rail. */
function arm(x, y, ty, st, c, dir) {
  const dx = 10;
  if (st === 'merged' || st === 'equivalent') {
    const stroke = st === 'equivalent' ? 'var(--warn)' : c;
    const dash = st === 'equivalent' ? ' stroke-dasharray="3 2"' : '';
    return `<path d="M${x},${y} C${x + dx},${y} ${x + 1},${ty} ${x + dx + 2},${ty}" fill="none" stroke="${stroke}" stroke-width="2" opacity=".85"${dash}/>`
      + `<circle cx="${x + dx + 2}" cy="${ty}" r="2.4" fill="${stroke}"/>`;
  }
  // never landed: a dashed stub that stops short of the rail
  const ey = y + (ty - y) * 0.55;
  return `<path d="M${x},${y} C${x + dx},${y} ${x + 1},${ey} ${x + dx},${ey}" fill="none" stroke="var(--bad)" stroke-width="1.75" stroke-dasharray="2.5 2.5"/>`
    + `<text x="${x + dx + 3}" y="${ey + (dir > 0 ? 4 : 3)}" class="warn" fill="var(--bad)">&#9888;</text>`;
}

/* ------------------------------------------------------------------ overlay */
/* Hovering a release splits its line open into the PRs it shipped. */
function packLanes(prs) {
  const items = prs.map((p) => {
    const w = 30 + String(p.number).length * 6.5;
    return { p, x: X(p.date), w };
  }).sort((a, b) => a.x - b.x);
  const ends = [];
  for (const it of items) {
    let lane = ends.findIndex((e) => e <= it.x - 5);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = it.x + it.w;
    it.lane = lane;
  }
  return { items, lanes: ends.length };
}

function overlay(r, top) {
  const box = el('div', 'ovl');
  const x1 = Math.max(X(r.date), X(r.startDate) + MIN_W);
  if (!r.prs.length) {
    box.style.cssText = `top:${top + ROW_H}px;left:${X(r.startDate) - 10}px;width:260px;height:26px`;
    box.innerHTML = `<div class="ovlnote">no pull requests detected &mdash; ${r.commits} commit${r.commits === 1 ? '' : 's'}</div>`;
    return box;
  }
  let { items, lanes } = packLanes(r.prs);
  // an early release can own thousands of PRs; keep the split-open view readable
  // and leave the full list to the detail panel
  let hidden = 0;
  if (lanes > MAX_LANES) {
    const keep = items.filter((i) => i.lane < MAX_LANES);
    hidden = items.length - keep.length;
    items = keep;
    lanes = MAX_LANES;
  }
  const h = lanes * LANE_H + 14;
  // Span only the release's own stretch of time rather than the whole timeline:
  // a full-width translucent panel is expensive to raster and buries its neighbours.
  const left = Math.min(x1, ...items.map((i) => i.x)) - 10;
  const right = Math.max(x1, ...items.map((i) => i.x + i.w)) + 10;
  box.style.cssText = `top:${top + ROW_H}px;left:${left}px;width:${right - left}px;height:${h + (hidden ? 20 : 0)}px`;

  const c = color(r);
  const tx = x1 - left;
  let s = '';
  for (const it of items) {
    const x = it.x - left;
    const y = 8 + it.lane * LANE_H;
    s += `<path d="M${tx},-8 C${tx},${y} ${x},${-8} ${x + 4},${y}" fill="none" stroke="${c}" stroke-width="1" opacity=".28"/>`;
  }
  for (const it of items) {
    const st = vOf(it.p);
    const x = it.x - left;
    const y = 8 + it.lane * LANE_H;
    const hit = prHit(it.p);
    s += `<g class="pr${hit ? ' hit' : ''}" data-pr="${it.p.number}" data-rel="${esc(r.name)}">`
      + `<rect x="${x}" y="${y - 6.5}" width="${it.w}" height="13" rx="3.5" fill="${VERDICT[st]}" opacity="${st === 'carried' ? .16 : .26}" stroke="${VERDICT[st]}" stroke-width="${hit ? 1.4 : .8}"/>`
      + `<text x="${x + 5}" y="${y + 3.5}" class="prlab" fill="${VERDICT[st]}">#${it.p.number}</text></g>`;
  }
  box.innerHTML = `<svg width="${right - left}" height="${h}">${s}</svg>`
    + (hidden ? `<div class="ovlnote">+${hidden} more &mdash; click the release to list them all</div>` : '');
  return box;
}

/* ------------------------------------------------------------------- render */
const track = () => $('#track'), spacer = () => $('#spacer'), gut = () => $('#gutspacer');
const pool = new Map();
let ovlEl = null;

function label(r, i) {
  const d = el('div', 'rowlabel');
  d.dataset.rel = r.name;
  d.style.top = i * ROW_H + 'px';
  d.style.height = ROW_H + 'px';
  const ct = (r.lostPRs ? `<i class="lost" title="${r.lostPRs} not in ${esc(NEWEST)}">${r.lostPRs}<span> lost</span></i>` : '')
    + (r.driftPRs ? `<i class="drift" title="${r.driftPRs} shipped but not on ${esc(TRUNK)}">${r.driftPRs}<span> drift</span></i>` : '')
    + (r.tagOnlyDangling ? `<i class="quiet" title="the tag points at a release-prep commit that was never merged; its work was">tag only</i>` : '');
  d.innerHTML = `<span class="v"><b style="background:${color(r)}"></b><span class="nm">${esc(r.name)}</span>`
    + (ct ? `<span class="ct">${ct}</span>` : '') + `</span>`
    + `<span class="s">${day(r.date)} · ${r.prs.length} PR${r.prs.length === 1 ? '' : 's'}</span>`;
  return d;
}

function renderWindow() {
  const sc = track();
  const top = sc.scrollTop;
  const h = sc.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_H) - 4);
  const last = Math.min(view.length, Math.ceil((top + h) / ROW_H) + 4);
  const want = new Set();
  for (let i = first; i < last; i++) {
    const r = view[i];
    want.add(r.name);
    let n = pool.get(r.name);
    if (!n) {
      const row = el('div', 'row');
      row.dataset.rel = r.name;
      row.style.height = ROW_H + 'px';
      row.innerHTML = ribbon(r);
      const lab = label(r, i);
      spacer().appendChild(row);
      gut().appendChild(lab);
      n = { row, lab };
      pool.set(r.name, n);
    }
    n.row.style.top = i * ROW_H + 'px';
    n.lab.style.top = i * ROW_H + 'px';
    const cls = r.name === S.sel ? 'sel' : r.name === S.hot ? 'hot' : '';
    n.row.className = 'row ' + cls;
    n.lab.className = 'rowlabel ' + cls;
  }
  for (const [name, n] of pool) {
    if (!want.has(name)) { n.row.remove(); n.lab.remove(); pool.delete(name); }
  }
}

function invalidate() {
  for (const n of pool.values()) { n.row.remove(); n.lab.remove(); }
  pool.clear();
  const t = track();
  sizeWidth();
  spacer().style.height = view.length * ROW_H + 'px';
  gut().style.height = view.length * ROW_H + 'px';
  // Filtering changes the row count, so the old scrollTop can point past the end.
  // Clamp before deciding which rows are on screen, or the window renders empty.
  const maxTop = Math.max(0, view.length * ROW_H - t.clientHeight);
  if (t.scrollTop > maxTop) t.scrollTop = maxTop;
  renderAxis();
  renderWindow();
  follow(false);
  showOverlay(S.hot);
  $('#count').textContent = `${view.length} / ${REL.length}`;
  $('#empty').style.display = view.length ? 'none' : 'block';
}

function renderAxis() {
  const a = $('#axis');
  const yearPx = ppu * 31557600;
  let stepMonths = yearPx > 900 ? 1 : yearPx > 320 ? 3 : yearPx > 130 ? 6 : 12;
  let s = '';
  const start = new Date(T0 * 1000);
  const d = new Date(start.getFullYear(), Math.floor(start.getMonth() / stepMonths) * stepMonths, 1);
  while (d.getTime() / 1000 <= T1 + 86400 * 40) {
    const x = X(d.getTime() / 1000);
    if (x > 0 && x < contentW) {
      const lab = stepMonths >= 12 ? d.getFullYear()
        : (d.getMonth() === 0 ? d.getFullYear() : d.toLocaleDateString(undefined, { month: 'short' }));
      s += `<div class="tick" style="left:${x}px">${lab}</div>`;
    }
    d.setMonth(d.getMonth() + stepMonths);
  }
  a.innerHTML = s;
}

function showOverlay(name) {
  if (ovlEl) { ovlEl.remove(); ovlEl = null; }
  if (!name) return;
  const i = view.findIndex((r) => r.name === name);
  if (i < 0) return;
  ovlEl = overlay(view[i], i * ROW_H);
  spacer().appendChild(ovlEl);
}

/* ------------------------------------------------------------------ tooltip */
const tip = () => $('#tip');
function showTip(html, ev, above) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  let x = ev.clientX + 14;
  // a ribbon tooltip must not cover the PRs the same hover just revealed below it
  let y = above ? ev.clientY - r.height - 14 : ev.clientY + 16;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y < 8) y = ev.clientY + 16;
  if (y + r.height > innerHeight - 8) y = Math.max(8, ev.clientY - r.height - 14);
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
const hideTip = () => tip().classList.remove('on');
const stPills = (st) => Object.keys(st).map((b) => `<span class="pill ${st[b]}">${esc(b)} · ${st[b]}</span>`).join('');
const tagPills = (r) => BR.map((b) => { const s = tagStatus(r, b); return `<span class="pill ${s}">${esc(b)} · ${TAG_LABEL[s]}</span>`; }).join('');

/* -------------------------------------------------------------------- panel */
const RISK = { lost: 0, drift: 1, carried: 2 };
/* Work that did not survive comes first — the question the panel answers. */
const prsByRisk = (r) => r.prs.slice().sort((a, b) => RISK[vOf(a)] - RISK[vOf(b)] || a.date - b.date);
function openPanel(name) {
  S.sel = name;
  const r = REL.find((x) => x.name === name);
  const p = $('#panel');
  if (!r) { p.classList.remove('on'); return; }
  p.classList.add('on');
  const web = D.repo.web;
  const tagUrl = web ? `${web}/releases/tag/${encodeURIComponent(r.name)}` : null;
  const gh = r.github;
  $('#panel .body').innerHTML =
    `<div class="sect">merge status</div><div style="padding:0 16px"><div class="pills">${tagPills(r)}</div></div>`
    + (gh && gh.body ? `<div class="sect">release notes</div><div class="notes">${esc(gh.body.slice(0, 1200))}</div>` : '')
    + `<div class="sect">${r.prs.length} pull request${r.prs.length === 1 ? '' : 's'}`
      + (r.lostPRs ? ` · <span style="color:var(--bad)">${r.lostPRs} not in ${esc(NEWEST)}</span>` : '')
      + (r.driftPRs ? ` · <span style="color:var(--warn)">${r.driftPRs} not on ${esc(TRUNK)}</span>` : '')
      + (!r.lostPRs && !r.driftPRs ? ` · <span style="color:var(--ok)">all carried forward</span>` : '') + `</div>`
    + (r.prs.length
      ? `<ul class="prlist">${prsByRisk(r).map((x) => {
          const st = vOf(x);
          const u = web ? `${web}/pull/${x.number}` : null;
          return `<li class="${st}"><span class="dot" style="background:${VERDICT[st]}"></span>`
            + (u ? `<a class="num" href="${u}" target="_blank" rel="noreferrer">#${x.number}</a>` : `<span class="num">#${x.number}</span>`)
            + `<span class="ti">${esc(x.title)}<small>${esc(x.author)} · ${day(x.date)}`
            + (st !== 'carried' ? ` · <span style="color:${VERDICT[st]}">${esc(VLABEL[st])}${foundOn(x).length ? ' — on ' + esc(foundOn(x).join(', ')) : ''}</span>` : '')
            + `</small></span></li>`;
        }).join('')}</ul>`
      : `<div class="empty">No pull requests detected.<br><small>This release's ${r.commits} commits use neither merge-commit nor squash-merge PR subjects.</small></div>`);
  $('#panel .ph').innerHTML =
    `<h2><b style="background:${color(r)}"></b>${tagUrl ? `<a href="${tagUrl}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:none">${esc(r.name)}</a>` : esc(r.name)}</h2>`
    + `<div class="sub">${day(r.firstCommitDate || r.startDate)} → ${day(r.date)} · ${r.commits} commits`
    + (r.parent ? ` · since <code>${esc(r.parent)}</code>` : '')
    + (r.tagger ? ` · tagged by ${esc(r.tagger)}` : '') + `</div>`
    + (gh && gh.title ? `<div class="sub" style="margin-top:4px;color:var(--ink-2)">${esc(gh.title)}</div>` : '')
    + `<button class="close" title="close (esc)">&times;</button>`;
  sizeWidth();
  renderWindow();
}
function closePanel() { S.sel = null; $('#panel').classList.remove('on'); sizeWidth(); renderWindow(); }

/* --------------------------------------------------------------------- wire */
/* Rows are chronological and X is time, so the content runs on a diagonal:
   scrolling down must bring the matching stretch of time with it. Only nudges
   when the release in view has drifted off-screen, so manual panning survives. */
let holdFollow = 0;
const bounds = (r) => { const x0 = X(r.startDate); return [x0, Math.max(X(r.date), x0 + MIN_W)]; };

function follow(force) {
  if (!force && Date.now() < holdFollow) return; // a reveal is in flight
  const t = track();
  const first = Math.floor(t.scrollTop / ROW_H);
  const last = Math.ceil((t.scrollTop + t.clientHeight) / ROW_H);
  // While a release is selected and on screen it, not the middle row, is what
  // the view should track — otherwise the panel and the graph disagree.
  let i = view.findIndex((v) => v.name === S.sel);
  if (i < first || i >= last) i = Math.min(view.length - 1, Math.floor((t.scrollTop + t.clientHeight / 2) / ROW_H));
  const r = view[i];
  if (!r) return;
  const [x0, x1] = bounds(r);
  const l = t.scrollLeft, w = visibleW();
  if (force || x1 < l + 40 || x0 > l + w - 40) t.scrollLeft = Math.max(0, x1 - w * 0.68);
}

/* How much of the track the panel hides: on narrow screens it floats over the chart. */
function covered() {
  const p = $('#panel');
  return p.classList.contains('on') && getComputedStyle(p).position === 'absolute' ? p.offsetWidth : 0;
}
const visibleW = () => Math.max(120, track().clientWidth - covered());
/* Extra room past the newest release, so it can be scrolled out from under a floating panel. */
function sizeWidth() {
  const w = contentW + covered() + 'px';
  spacer().style.width = w;
  $('#axis').style.width = w;
}

/* Bring a release's ribbon on screen. Call this after the panel is shown:
   reading clientWidth forces the reflow, so we measure the narrowed track. */
function reveal(name) {
  const r = REL.find((x) => x.name === name);
  if (!r) return;
  const t = track();
  const w = visibleW();
  const [, x1] = bounds(r);
  // the tag end is what matters: a long ribbon can be on screen with its tag hidden
  if (x1 < t.scrollLeft + 40 || x1 > t.scrollLeft + w - 40) {
    holdFollow = Date.now() + 1000;
    t.scrollTo({ left: Math.max(0, x1 - w * 0.68), behavior: 'smooth' });
  }
}

function boot() {
  // without --prerelease the model holds none, and the toggle would do nothing
  if (!REL.some((r) => r.pre)) $('#f-pre').closest('label').style.display = 'none';
  rescale(); refilter(); invalidate();
  // open on the newest releases — that is what a maintainer is here to check
  track().scrollTop = view.length * ROW_H;
  follow(true);

  const trk = $('#track'), ax = $('#axisscroll'), gs = $('#gutscroll');
  let lastTop = -1;
  trk.addEventListener('scroll', () => {
    ax.scrollLeft = trk.scrollLeft;
    gs.scrollTop = trk.scrollTop;
    renderWindow();
    if (trk.scrollTop !== lastTop) { lastTop = trk.scrollTop; follow(false); }
  }, { passive: true });
  // the frozen column has no scrollbar of its own; drive the track from it
  gs.addEventListener('wheel', (e) => { trk.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });

  const hover = (name) => {
    if (S.hot === name) return;
    S.hot = name;
    showOverlay(name);
    renderWindow();
  };
  const relOf = (e) => { const n = e.target.closest('[data-rel]'); return n ? n.dataset.rel : null; };

  for (const c of [spacer(), gut()]) {
    c.addEventListener('mousemove', (e) => {
      const prNode = e.target.closest('[data-pr]');
      if (prNode) {
        const r = REL.find((x) => x.name === prNode.dataset.rel);
        const p = r && r.prs.find((x) => String(x.number) === prNode.dataset.pr);
        if (p) { showTip(`<div class="t">#${p.number} ${esc(p.title)}</div><div class="m">${esc(p.author)} · ${day(p.date)}</div>`
          + `<div class="st"><span class="pill ${vOf(p)}">${esc(VLABEL[vOf(p)])}</span>${stPills(p.status)}</div>`, e); return; }
      }
      const name = relOf(e);
      if (name) {
        hover(name);
        if (e.target.closest('.rib, .rowlabel')) {
          const r = REL.find((x) => x.name === name);
          showTip(`<div class="t">${esc(r.name)}</div><div class="m">${day(r.startDate)} → ${day(r.date)} · ${r.commits} commits · ${r.prs.length} PRs</div>`
            + `<div class="st"><span class="pill ${relVerdict(r)}">${r.carried} carried</span>`
            + (r.driftPRs ? `<span class="pill drift">${r.driftPRs} off ${esc(TRUNK)}</span>` : '')
            + (r.lostPRs ? `<span class="pill lost">${r.lostPRs} not in ${esc(NEWEST)}</span>` : '') + `</div>`, e, true);
        } else hideTip();
      } else hideTip();
    });
    c.addEventListener('click', (e) => {
      const n = relOf(e);
      if (!n) return;
      openPanel(n);
      reveal(n);
    });
  }
  $('#chart').addEventListener('mouseleave', () => { hideTip(); hover(null); });

  $('#q').addEventListener('input', (e) => { S.q = e.target.value; refilter(); invalidate(); });
  $('#f-prob').addEventListener('change', (e) => { S.problems = e.target.checked; refilter(); invalidate(); });
  $('#f-pre').addEventListener('change', (e) => { S.pre = e.target.checked; refilter(); invalidate(); });
  $('#zin').addEventListener('click', () => { S.zoom = Math.min(S.zoom * 1.6, 40); rescale(); invalidate(); });
  $('#zout').addEventListener('click', () => { S.zoom = Math.max(S.zoom / 1.6, 1); rescale(); invalidate(); });
  $('#theme').addEventListener('click', () => {
    // light is the default, so a third "system" state would look identical to it
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  });
  document.addEventListener('click', (e) => { if (e.target.closest('.close')) closePanel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if (e.key === '/' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('#q').focus(); }
  });
  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { rescale(); invalidate(); }, 120); });
}
document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
})();
