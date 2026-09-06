/* MidCap 650 Momentum — vanilla, no dependencies.
   Data is pre-computed by scripts/build.py and served as static JSON. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE = 60;                         // rows appended per scroll chunk
  const WATCH_KEY = 'sp400.watchlist.v1';
  const SECTORS_KEY = 'sp400.sectors.v1';
  const SCORE_KEY = 'sp400.score.v1';      // the score's four choices
  const CHART_KEY = 'sp400.chart.v1';      // the price chart's own settings
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* One universe: the MidCap 400 plus the smallest 250 of the S&P 500 by market
     cap, ~650 names. It is not a setting — a name is measured against
     everything of roughly its size, and which index committee happens to hold
     it is not a fact about the name. */
  const UNIVERSE = { label: 'MidCap 650', size: '650' };

  /* ---------- the score ----------
     One definition, built here step for step as scripts/build.py builds it,
     on the same rounded inputs, so what this scores in the browser (the list)
     and what the pipeline published (every day's cross-section, for the
     score pane) agree to the last digit. Four choices:
       period   '12' (12–1), '6' (6–1) or 'blend' (the two averaged 50/50)
       vol      divide each period's return by its own volatility
       resid    use the return net of the market instead of the return
       basis    z-score against the whole 'universe' or the name's 'sector'
     and one reading of the completed score, `display`: its 'value', its
     integer 'rank' across the whole universe (1 = best), or its percentile
     'pct' across the whole universe (100 = best). Display never changes the
     order, only the number shown. */
  const SCORE_DEFAULTS = { period: 'blend', vol: false, resid: false, basis: 'universe', display: 'pct' };
  const PERIODS = { 12: '12–1', 6: '6–1', blend: 'Blend' };
  const DISPLAYS = { value: 'Score value', rank: 'Rank', pct: 'Percentile' };
  const BASES = { universe: 'Universe', sector: 'Sector' };

  const state = {
    rows: [],
    meta: null,
    watch: loadWatch(),
    scope: 'all',
    sectors: loadSectors(),
    sort: 'score',
    view: [],
    shown: 0,
    score: loadScoreSettings(),
    chart: loadChartPrefs(),
  };

  const adjustKey = (s) => (s.vol && s.resid ? 'volresid' : s.vol ? 'vol' : s.resid ? 'resid' : 'none');
  const scoreKey = (s = state.score) => `${s.period}-${adjustKey(s)}-${s.basis}`;
  const round2 = (v) => Math.floor(v * 100 + 0.5) / 100;         // as build.py's round2
  /* What one period measures under the adjustments, from its legs: r the
     return, v its volatility, e the return net of the market, w the residual
     volatility. Null where the name has no legs for that period. */
  function measure(legs, period, s) {
    const r = legs['r' + period], v = legs['v' + period], e = legs['e' + period], w = legs['w' + period];
    if (r == null) return null;
    return s.resid ? (s.vol ? e / w : e) : (s.vol ? r / v : r);
  }
  const zOf = (x, st) => (x == null || !st ? null : st[1] > 0 ? round2((x - st[0]) / st[1]) : 0);
  /* The completed score from a name's legs and a lookup of the peer statistics
     ([mean, sd]) for a period. */
  function scoreFrom(legs, statFor, s = state.score) {
    const per = (p) => zOf(measure(legs, p, s), statFor(p));
    if (s.period === 'blend') {
      const a = per('12'), b = per('6');
      return { z12: a, z6: b, s: a == null || b == null ? null : round2((a + b) / 2) };
    }
    const z = per(s.period);
    return { z12: s.period === '12' ? z : null, z6: s.period === '6' ? z : null, s: z };
  }
  const groupOf = (row, s = state.score) => (s.basis === 'universe' ? '*' : row.sector || '');
  /* Today's peer statistics, from latest.json, for one row. */
  const statToday = (row, s = state.score) => (p) => {
    const by = state.meta.stats[p] && state.meta.stats[p][adjustKey(s)];
    return by ? by[groupOf(row, s)] || null : null;
  };
  /* Rank against a ladder — the members' scores × 100, ascending — as
     1 + the number strictly better, so ties share the better position. */
  function rankIn(ladder, score) {
    const v = Math.round(score * 100);
    let lo = 0, hi = ladder.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ladder[m] <= v) lo = m + 1; else hi = m; }
    return 1 + ladder.length - lo;
  }
  const pctOf = (rank, n) => (n > 1 ? 100 * (n - rank) / (n - 1) : 100);
  /* Score every row under `s`: {symbol: {s, z12, z6, rank, pct}}, plus the
     ladder and member count the ranks came from. */
  function scoreAll(s = state.score) {
    const by = {};
    for (const r of state.rows) by[r.symbol] = scoreFrom(r.legs, statToday(r, s), s);
    const ladder = Object.values(by).filter((x) => x.s != null).map((x) => Math.round(x.s * 100)).sort((a, b) => a - b);
    for (const x of Object.values(by)) {
      x.rank = x.s == null ? null : rankIn(ladder, x.s);
      x.pct = x.rank == null ? null : pctOf(x.rank, ladder.length);
    }
    return { by, ladder, n: ladder.length };
  }
  const rescore = () => { state.scored = scoreAll(); };
  const scoreOf = (r) => state.scored.by[r.symbol];
  const displayed = (sc, d = state.score.display) => (d === 'value' ? sc.s : d === 'rank' ? sc.rank : sc.pct);
  const FMT = {
    value: (v) => (v == null ? '—' : `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(2)}`),
    rank: (v) => (v == null ? '—' : String(v)),
    pct: (v) => (v == null ? '—' : v.toFixed(1)),
  };
  const fmtShown = (sc, d = state.score.display) => FMT[d](displayed(sc, d));
  /* One line naming the score as built: "Blend · ÷ volatility · vs universe". */
  const scoreSummary = (s = state.score) => [
    PERIODS[s.period], s.vol ? '÷ volatility' : '', s.resid ? 'net of market' : '', `vs ${s.basis}`,
  ].filter(Boolean).join(' · ');

  /* ---------- persistence ---------- */
  function loadWatch() {
    try {
      const raw = JSON.parse(localStorage.getItem(WATCH_KEY));
      return new Set(Array.isArray(raw) ? raw : []);
    } catch { return new Set(); }
  }
  function saveWatch() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watch])); } catch { /* private mode */ }
  }
  function loadSectors() {
    try {
      const raw = JSON.parse(localStorage.getItem(SECTORS_KEY));
      return new Set(Array.isArray(raw) ? raw : []);
    } catch { return new Set(); }
  }
  function saveSectors() {
    try { localStorage.setItem(SECTORS_KEY, JSON.stringify([...state.sectors])); } catch { /* private mode */ }
  }
  /* The score's four choices. Anything unreadable falls back to the defaults;
     the two settings the app had before (basis, adjustment) carry over. */
  function loadScoreSettings() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SCORE_KEY)); } catch { /* absent or malformed */ }
    if (!raw || typeof raw !== 'object') {
      raw = {};
      try {
        if (localStorage.getItem('sp400.basis.v1') === 'sector') raw.basis = 'sector';
        const adj = localStorage.getItem('sp400.adjust.v1');
        if (adj === 'vol') raw.vol = true;
        if (adj === 'resid') raw.resid = true;
      } catch { /* private mode */ }
    }
    const s = { ...SCORE_DEFAULTS };
    if (raw.period in PERIODS) s.period = String(raw.period);
    s.vol = !!raw.vol;
    s.resid = !!raw.resid;
    if (raw.basis === 'sector') s.basis = 'sector';
    if (raw.display in DISPLAYS) s.display = raw.display;
    return s;
  }
  function saveScoreSettings() {
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(state.score)); } catch { /* private mode */ }
  }
  /* Chart settings: one object keyed by indicator, in the shape chart.js
     declares, so a new indicator or setting is a new key rather than a new
     store. Anything unreadable falls back to the chart's defaults. */
  function loadChartPrefs() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(CHART_KEY)) || {}; } catch { /* absent or malformed */ }
    // The first version stored only { fill }; that choice carries into the channel.
    if (typeof raw.fill === 'number' && !raw.channel) raw = { channel: { fill: raw.fill } };
    if (raw.rank && !raw.score) raw.score = raw.rank;     // the pane was called Rank for a while
    return priceChart.normalize(raw);
  }
  function saveChartPrefs() {
    try { localStorage.setItem(CHART_KEY, JSON.stringify(state.chart)); } catch { /* private mode */ }
  }

  /* ---------- formatting ---------- */
  const pct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 1) => v == null ? '—' : v.toFixed(d);
  const signed = (v, d = 1) => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
  const money = (v) => v == null ? '—' : '$' + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  function cap(v) {
    if (v == null) return '—';
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
    for (const [size, suffix] of units) if (v >= size) return '$' + (v / size).toFixed(v / size >= 100 ? 0 : 1) + suffix;
    return '$' + v.toLocaleString();
  }
  /* Colour ramp over the percentile: cold (0) → neutral (50) → hot (100), so
     a name's colour is its standing whatever the display shows. The scheme is
     read once and refreshed on change rather than queried per bar; a theme
     flip mid-session (auto dark mode at dusk) re-renders the open view. */
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let dark = scheme.matches;
  scheme.addEventListener('change', (e) => { dark = e.matches; if (state.rows.length) route(); });

  function tone(pctl) {
    if (pctl == null) return 'var(--ink-3)';
    const t = Math.max(0, Math.min(100, pctl)) / 100;
    // Piecewise so that 50 lands on a genuinely neutral amber rather than a
    // greenish midpoint: 0 = red, 0.5 = amber, 1 = green.
    const hue = t < 0.5 ? 4 + (t / 0.5) * 38 : 42 + ((t - 0.5) / 0.5) * 103;
    const sat = 62 + Math.abs(t - 0.5) * 30;
    return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${dark ? 57 : 41}%)`;
  }
  const cls = (v) => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  // pct() above is unsigned; a return needs its sign, and a real minus sign.
  const spct = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : '−'}${pct(Math.abs(v), d)}`;
  /* ---------- data files ----------
     Everything past latest.json is fetched once and memoised on state, so a
     view can ask for what it needs without tracking whether it already has
     it. A failed fetch resolves to null: a missing extra never breaks the
     ranking, it just leaves that piece of the page out. */
  /* Every data file comes through here: fresh from the server, parsed, and
     an HTTP failure turned into a rejection the caller decides about. */
  const getJSON = (file) => fetch(file, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

  function loadJSON(file, key) {
    const cached = key + 'Promise';
    if (!state[cached]) {
      state[cached] = getJSON(file)
        .then((d) => { state[key] = d; return d; })
        .catch(() => null);
    }
    return state[cached];
  }
  /* One strip file per score definition: the list only ever draws the
     active one, and 24 in one payload would be 23 wasted downloads. */
  const loadSpark = () => loadJSON(`data/spark/${scoreKey()}.json`, `spark_${scoreKey()}`);
  /* Every day's cross-section under one score definition, for the score pane:
     member counts, peer statistics and the ladders of member scores. About
     1.5 MB, fetched once per definition per session. */
  const loadScoreFile = () => loadJSON(`data/score/${scoreKey()}.json`, `score_${scoreKey()}`);

  /* ---------- boot ---------- */
  Promise.all([
    getJSON('data/latest.json'),
    loadSpark(),      // optional: rows still render without their strips
  ])
    .then(([payload]) => {
      state.rows = payload.rows;
      state.meta = payload.meta;
      state.bySymbol = new Map(payload.rows.map((r) => [r.symbol, r]));
      rescore();
      syncControls();
      $('asof').textContent = `prices through ${fmtDate(payload.meta.asOf)}`;
      // The refresh job runs each weekday morning and is silent; stale data is
      // its worst failure mode, so say so rather than let an old ranking pass
      // for a fresh one. Four days clears a long weekend.
      const ageDays = (Date.now() - Date.parse(payload.meta.generatedAt)) / 864e5;
      if (ageDays > 4) {
        $('stale').hidden = false;
        $('stale').textContent = `This ranking is ${Math.floor(ageDays)} days old — the daily refresh `
          + 'may have failed. Treat it as a snapshot, not a live read.';
      }
      $('gen').textContent = `Refreshed ${fmtDate(payload.meta.generatedAt.slice(0, 10))}. Source: Financial Modeling Prep.`;
      fillSectors();
      wire();
      route();
    })
    .catch((err) => {
      $('asof').textContent = 'Could not load data.';
      $('empty').hidden = false;
      $('empty').textContent = 'Data failed to load (' + err.message + '). Try again shortly.';
    });

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  /* Sectors are ordered by how many names they hold, biggest first, because
     the size of the pool is what tells you whether a sector filter leaves you
     a ranking or a handful of names. They do not move with any setting — the
     universe is fixed and every sector clears the minimum — so this fills once
     at boot. */
  function fillSectors() {
    const counts = new Map();
    for (const r of state.rows) if (r.sector) counts.set(r.sector, (counts.get(r.sector) || 0) + 1);
    const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    state.sectorList = ordered;
    // A saved sector that no longer exists (a rare data-shape change) is
    // dropped rather than trusted; anything else round-trips untouched.
    for (const name of [...state.sectors]) if (!counts.has(name)) state.sectors.delete(name);
    renderSectorList();
    updateSectorLabel();
  }

  /* One row per sector, tapped to toggle membership in state.sectors. Built
     once per data load (or basis/universe change, same as before); after that,
     toggling a row updates its own class in place rather than rebuilding the
     list, so the sheet doesn't flash or lose scroll position while in use. */
  function renderSectorList() {
    $('sector-list').innerHTML = state.sectorList.map(([name, n]) => `
      <li><button type="button" class="sheet-row${state.sectors.has(name) ? ' on' : ''}"
        data-sector="${esc(name)}"><span>${esc(name)}</span><small>${n}</small>
        <i aria-hidden="true">✓</i></button></li>`).join('');
  }

  /* What the closed trigger says: the one honest sentence for however many
     sectors are checked, so the button never has to be opened to know the
     filter's current state. */
  function updateSectorLabel() {
    const n = state.sectors.size;
    $('sector-value').textContent = n === 0 ? 'All sectors'
      : n === 1 ? [...state.sectors][0]
      : `${n} sectors`;
    $('sector-clear').hidden = n === 0;
  }

  function toggleSector(name) {
    if (state.sectors.has(name)) state.sectors.delete(name); else state.sectors.add(name);
    saveSectors();
    updateSectorLabel();
    $(`sector-list`).querySelector(`[data-sector="${CSS.escape(name)}"]`).classList.toggle('on', state.sectors.has(name));
    applyFilters();
  }

  function openSectorSheet() {
    $('sector-backdrop').hidden = false;
    $('sector-sheet').hidden = false;
    $('sector-btn').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => { $('sector-sheet').classList.add('open'); $('sector-backdrop').classList.add('open'); });
  }

  function closeSectorSheet() {
    $('sector-sheet').classList.remove('open');
    $('sector-backdrop').classList.remove('open');
    $('sector-btn').setAttribute('aria-expanded', 'false');
    setTimeout(() => { $('sector-backdrop').hidden = true; $('sector-sheet').hidden = true; }, 200);
  }

  const NOTES = {
    period: {
      12: 'The return over the 12 months ending one month ago.',
      6: 'The return over the 6 months ending one month ago.',
      blend: 'Both periods, each standardized on its own, then averaged 50/50.',
    },
    basis: {
      universe: `Each period's measure is z-scored against all of ${UNIVERSE.label}.`,
      sector: 'Each period\'s measure is z-scored against the name\'s own GICS sector, so a strong '
        + 'name in a weak sector still scores well.',
    },
    display: {
      value: 'The completed score, in standard deviations from the peer mean: 0 is average, '
        + 'negative is below it.',
      rank: `Integer position across the whole universe, 1 = best.`,
      pct: `Position across the whole universe on a 0–100 scale, 100 = best.`,
    },
  };
  function syncControls() {
    const seg = (id, attr, value) => {
      for (const b of $(id).querySelectorAll('button')) {
        const on = b.dataset[attr] === value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on);
      }
    };
    seg('period-seg', 'period', state.score.period);
    seg('basis-seg', 'basis', state.score.basis);
    seg('display-seg', 'display', state.score.display);
    $('adj-vol').checked = state.score.vol;
    $('adj-resid').checked = state.score.resid;
    $('period-note').textContent = NOTES.period[state.score.period];
    $('basis-note').textContent = NOTES.basis[state.score.basis];
    $('display-note').textContent = NOTES.display[state.score.display];
  }

  /* Everything that has to happen when the score changes, in one place so no
     control can forget a step. The strips live in a per-definition file, so
     rows are redrawn once now on whatever is cached and again when the new
     file lands. */
  function scoreChanged(patch) {
    Object.assign(state.score, patch);
    saveScoreSettings();
    rescore();
    syncControls();
    applyFilters();
    const key = scoreKey();
    loadSpark().then(() => { if (scoreKey() === key) applyFilters(); });
    if (!$('settings-view').hidden) showSettings();   // the method text follows the settings
  }

  /* ---------- settings ---------- */
  function showSettings() {
    showView('settings-view');
    scrollTo(0, 0);
    const m = state.meta, s = state.score;
    $('data-stats').innerHTML = [
      ['Prices through', fmtDate(m.asOf)],
      ['Last refresh', fmtDate(m.generatedAt.slice(0, 10))],
      ['Names scored', state.scored.n],
      ['Daily scores', `${m.params.dailyDays} trading days`],
      ['From the MidCap 400', m.fromCore],
      ['From the S&P 500 tail', m.members - m.fromCore],
      ['Skip', `${m.params.skipDays} trading days`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    /* The method has to describe the score the reader is actually getting, so
       each step appears only when it is switched on. */
    const periods = s.period === 'blend' ? ['12', '6'] : [s.period];
    const against = s.basis === 'sector' ? 'the name\'s own GICS sector' : `all of ${UNIVERSE.label}`;
    $('method').innerHTML = [
      ...periods.map((p) => [`${PERIODS[p]} return`, `Total return on dividend- and split-adjusted closes over the `
        + `${p} months ending one month ago. The most recent month is skipped to sidestep short-term reversal.`]),
      ...(s.resid ? [['Market residualization', 'Over that same window each name\'s daily log returns are '
        + 'regressed on the equal-weight average of every priced name. The measure becomes the return that '
        + 'regression leaves unexplained — the name\'s own move, net of its beta times the market\'s.']] : []),
      ...(s.vol ? [['Volatility adjustment', `The ${s.resid ? 'residual ' : ''}return is divided by the `
        + `annualised standard deviation of the ${s.resid ? 'residual ' : ''}daily log returns over that same `
        + 'window, so a steady climb outscores an equally large but erratic one.']] : []),
      ['Standardize', `Each period's measure is turned into a z-score against ${against} on the same day: `
        + '(measure − peer mean) ÷ peer standard deviation, to two decimals.'],
      [s.period === 'blend' ? 'Blend' : 'Score', s.period === 'blend'
        ? 'The score is the 50/50 average of the 12–1 and 6–1 z-scores.'
        : `The score is the ${PERIODS[s.period]} z-score.`],
      ['Display', `${DISPLAYS[s.display]}: ${NOTES.display[s.display].charAt(0).toLowerCase()}${NOTES.display[s.display].slice(1)} `
        + 'Rank and percentile are read across the whole universe whatever the score is standardized against, '
        + 'and all three displays keep the same order.'],
    ].map(([k, v]) => `<li><b>${k}.</b> ${v}</li>`).join('');
  }

  /* What the two numbers on a row mean. The left column is the name's position
     in whatever the list is ordered by; the right column is the score in the
     chosen display, or the market cap when that is the order. Ticker A–Z is
     a lookup order, not a ranking, so rows keep their score standing. */
  const SORTS = {
    score: { label: 'score', value: (r) => fmtShown(scoreOf(r)) },
    mktCap: { label: 'market cap', value: (r) => cap(r.mktCap) },
    symbol: { label: 'ticker', value: (r) => fmtShown(scoreOf(r)) },
  };
  const byScore = (a, b) => ((scoreOf(b).s ?? -Infinity) - (scoreOf(a).s ?? -Infinity)) || a.symbol.localeCompare(b.symbol);

  /* Position on the active order, over the whole universe rather than the
     filtered view: with a sector chosen, "8th" should still mean eighth of
     649, which is the more useful fact and what the list has always shown. */
  function rankOn(key) {
    if (key !== 'mktCap') return null;       // the score's own rank already is it
    const ordered = state.rows.slice().sort((a, b) => ((b.mktCap ?? -Infinity) - (a.mktCap ?? -Infinity)) || a.symbol.localeCompare(b.symbol));
    return new Map(ordered.map((r, i) => [r.symbol, i + 1]));
  }

  /* ---------- list ---------- */
  function applyFilters() {
    let out = state.rows;
    if (state.scope === 'watch') out = out.filter((r) => state.watch.has(r.symbol));
    if (state.sectors.size) out = out.filter((r) => state.sectors.has(r.sector));

    const key = state.sort;
    state.ranks = rankOn(key);
    out = out.slice().sort(
      key === 'symbol' ? (a, b) => a.symbol.localeCompare(b.symbol)
        : key === 'mktCap' ? (a, b) => ((b.mktCap ?? -Infinity) - (a.mktCap ?? -Infinity)) || a.symbol.localeCompare(b.symbol)
        : byScore
    );

    state.view = out;
    state.shown = 0;
    $('rows').replaceChildren();

    const watching = state.scope === 'watch';
    $('empty').hidden = out.length > 0;
    $('empty').textContent = !watching ? 'No matches.'
      : state.watch.size === 0 ? 'Tap ☆ on any name to keep it here.'
      : 'No watched names match.';
    /* One line, naming whatever actually decides the order on screen and how
       the score on the right is built. */
    $('count').textContent = out.length
      ? `${out.length} of ${state.rows.length} · ` + (
          key === 'mktCap' ? 'ordered by market cap'
          : key === 'symbol' ? `A–Z · ${DISPLAYS[state.score.display].toLowerCase()} on the right`
          : `ranked by score · ${scoreSummary()} · ${DISPLAYS[state.score.display].toLowerCase()}`)
      : '';
    $('watch-count').textContent = state.watch.size ? `(${state.watch.size})` : '';
    appendChunk();
  }

  function appendChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(state.shown + PAGE, state.view.length);
    for (let i = state.shown; i < end; i++) frag.append(rowNode(state.view[i]));
    $('rows').append(frag);
    state.shown = end;
  }

  function rowNode(r) {
    const sc = scoreOf(r);
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.symbol = r.symbol;
    li.innerHTML =
      `<span class="rk">${state.ranks ? state.ranks.get(r.symbol) : (sc.rank ?? '—')}</span>` +
      `<a class="who" href="#/t/${r.symbol}"><b>${r.symbol}</b>` +
      `<small>${esc(r.name)}</small></a>` +
      sparkline(r.symbol) +
      `<span class="sc"><b style="color:${state.sort === 'mktCap' ? 'inherit' : tone(sc.pct)}">${SORTS[state.sort].value(r)}</b></span>` +
      `<button class="star${state.watch.has(r.symbol) ? ' on' : ''}" aria-label="Watchlist">` +
      `${state.watch.has(r.symbol) ? '★' : '☆'}</button>`;
    return li;
  }

  /* A year of month-end standings as a strip of tone-coloured bars: each
     bar's height and colour is that month's percentile, so the strip reads
     the same whatever the display shows, and the label carries the display. */
  const SPARK = { w: 6, gap: 2, h: 22 };
  function sparkline(symbol) {
    const sp = state[`spark_${scoreKey()}`];
    const scores = sp && sp.s[symbol], ranks = sp && sp.k[symbol];
    const n = sp ? sp.dates.length : 12;
    const width = n * (SPARK.w + SPARK.gap) - SPARK.gap;
    let bars = '', label = '';
    if (scores) {
      const pcts = scores.map((v, i) => (v == null ? null : pctOf(ranks[i], sp.n[i])));
      pcts.forEach((p, i) => {
        if (p == null) return;
        const h = Math.max(1.5, p / 100 * SPARK.h);
        bars += `<rect x="${i * (SPARK.w + SPARK.gap)}" y="${(SPARK.h - h).toFixed(1)}" `
          + `width="${SPARK.w}" height="${h.toFixed(1)}" rx="1" fill="${tone(p)}"/>`;
      });
      const d = state.score.display;
      const at = (i) => (scores[i] == null ? '—' : FMT[d](d === 'value' ? scores[i] / 100 : d === 'rank' ? ranks[i] : pcts[i]));
      label = `${DISPLAYS[d]} over the last ${n} months: ${at(0)} to ${at(n - 1)}`;
    }
    return `<svg class="spark" viewBox="0 0 ${width} ${SPARK.h}" width="${width}" height="${SPARK.h}" `
      + `role="img" aria-label="${label}"><line x1="0" x2="${width}" y1="${SPARK.h / 2}" y2="${SPARK.h / 2}"/>${bars}</svg>`;
  }

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toggleWatch(symbol, button) {
    if (state.watch.has(symbol)) state.watch.delete(symbol); else state.watch.add(symbol);
    saveWatch();
    const on = state.watch.has(symbol);
    if (button) { button.classList.toggle('on', on); button.textContent = on ? '★' : '☆'; }
    $('watch-count').textContent = state.watch.size ? `(${state.watch.size})` : '';
    if (state.scope === 'watch' && !on) applyFilters();
  }

  /* ---------- events ---------- */
  function wire() {
    for (const [id, attr] of [['period-seg', 'period'], ['basis-seg', 'basis'], ['display-seg', 'display']]) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest(`button[data-${attr}]`);
        if (!b || b.dataset[attr] === state.score[attr]) return;
        scoreChanged({ [attr]: b.dataset[attr] });
      });
    }
    $('adj-vol').addEventListener('change', (e) => scoreChanged({ vol: e.target.checked }));
    $('adj-resid').addEventListener('change', (e) => scoreChanged({ resid: e.target.checked }));
    $('sback').addEventListener('click', goBack);
    $('sector-btn').addEventListener('click', openSectorSheet);
    $('sector-done').addEventListener('click', closeSectorSheet);
    $('sector-backdrop').addEventListener('click', closeSectorSheet);
    $('sector-clear').addEventListener('click', () => {
      state.sectors.clear();
      saveSectors();
      renderSectorList();
      updateSectorLabel();
      applyFilters();
    });
    $('sector-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-sector]');
      if (row) toggleSector(row.dataset.sector);
    });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('sector-sheet').hidden) closeSectorSheet();
    });
    $('sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });

    for (const tab of document.querySelectorAll('.segmented button[data-scope]')) {
      tab.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.segmented button[data-scope]')) {
          const on = other === tab;
          other.classList.toggle('on', on);
          other.setAttribute('aria-selected', String(on));
        }
        state.scope = tab.dataset.scope;
        applyFilters();
      });
    }

    $('rows').addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      if (star) { toggleWatch(star.closest('.row').dataset.symbol, star); return; }
      if (e.target.closest('a.who')) return;          // the link handles itself
      const row = e.target.closest('.row');
      if (row) location.hash = `#/t/${row.dataset.symbol}`;
    });

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.shown < state.view.length) appendChunk();
    }, { rootMargin: '600px' }).observe($('sentinel'));

    addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.target.matches('input, select, textarea')) return;
      const open = ['chart-view', 'detail-view'].map($).find((v) => !v.hidden);
      const b = open && open.querySelector(`.pager .${e.key === 'ArrowLeft' ? 'prev' : 'next'}[data-go]`);
      if (b) b.click();
    });
    addEventListener('hashchange', route);
  }

  /* ---------- routing ---------- */
  const VIEWS = ['list-view', 'detail-view', 'settings-view', 'chart-view'];
  /* Whether the list is behind us in history. It isn't when the page was
     opened straight on a ticker or the settings view from a shared link, and
     calling history.back() there would leave the site instead of going to the
     list. */
  let listBehind = false;

  function showView(id) {
    if (id !== 'list-view' && !$('list-view').hidden) {
      sessionStorage.setItem('sp400.scroll', String(scrollY));
      listBehind = true;
    }
    for (const v of VIEWS) $(v).hidden = v !== id;
  }

  function route() {
    const ticker = /^#\/t\/([A-Za-z0-9.\-]+)(\/chart)?$/.exec(location.hash);
    if (ticker) {
      const row = state.rows.find((r) => r.symbol === ticker[1].toUpperCase());
      if (row) return ticker[2] ? showChart(row) : showDetail(row);
      location.hash = '';
      return;
    }
    if (location.hash === '#/settings') return showSettings();
    showView('list-view');
    if (!state.view.length) applyFilters();
    const y = Number(sessionStorage.getItem('sp400.scroll') || 0);
    while (state.shown < state.view.length && document.documentElement.scrollHeight < y + innerHeight) {
      appendChunk();
    }
    scrollTo(0, y);
  }


  /* ---------- previous / next ---------- */
  /* The names either side of this one in the list as it stands (sort, sector,
     watchlist), so the arrows walk the order on screen. A name the current
     filter hides falls back to the full ranking. */
  function neighbors(symbol) {
    const order = state.view.some((r) => r.symbol === symbol) ? state.view : state.rows;
    const i = order.findIndex((r) => r.symbol === symbol);
    return { prev: order[i - 1] || null, next: order[i + 1] || null, pos: i + 1, count: order.length };
  }
  function pagerHtml(symbol) {
    const { prev, next, pos, count } = neighbors(symbol);
    const side = (r, dir) => r
      ? `<button type="button" class="pg ${dir}" data-go="${r.symbol}" aria-label="${dir === 'prev' ? 'Previous' : 'Next'}: ${r.symbol}">`
        + `${dir === 'prev' ? '‹ ' : ''}${r.symbol}${dir === 'next' ? ' ›' : ''}</button>`
      : `<span class="pg ${dir}"></span>`;
    return `<div class="pager">${side(prev, 'prev')}<span class="pos">${pos} of ${count}</span>${side(next, 'next')}</div>`;
  }
  /* Stepping replaces the current entry rather than stacking one per name,
     so Back still returns to where the reader came from. */
  function wirePager(el, suffix, before) {
    el.querySelector('.pager').addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]');
      if (!b) return;
      if (before) before();
      location.replace(`#/t/${b.dataset.go}${suffix}`);
    });
  }

  function showDetail(r) {
    const s = state.score, sc = scoreOf(r), n = state.scored.n;
    if (!$('list-view').hidden) sessionStorage.setItem('sp400.scroll', String(scrollY));
    for (const v of VIEWS) if (v !== 'detail-view') $(v).hidden = true;
    const el = $('detail-view');
    el.hidden = false;
    const range = r.yearHigh && r.yearLow && r.yearHigh > r.yearLow
      ? ((r.price - r.yearLow) / (r.yearHigh - r.yearLow)) * 100 : null;

    const meta = [r.sector, r.industry, cap(r.mktCap)].filter(Boolean).map(esc).join(' · ');
    // The headline is the chosen display; the other two readings sit beside it.
    const others = ['rank', 'pct', 'value'].filter((d) => d !== s.display).map((d) =>
      d === 'rank' ? `rank ${FMT.rank(sc.rank)} of ${n}` : d === 'pct' ? `${FMT.pct(sc.pct)} percentile` : `score ${FMT.value(sc.s)}`);
    const comp = components(r, sc);
    const peers = againstPeers(r);

    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="back">‹ Back</button>
        <span class="grow"><b>${r.symbol}</b><small>${esc(r.name)}</small></span>
        <button class="star${state.watch.has(r.symbol) ? ' on' : ''}" id="dstar" aria-label="Watchlist">${state.watch.has(r.symbol) ? '★' : '☆'}</button>
      </div>
      ${pagerHtml(r.symbol)}

      <section class="card focus" aria-label="Score">
        <div class="hero">
          <span class="big" style="color:${tone(sc.pct)}">${fmtShown(sc)}</span>
          <span class="lbl"><b>${DISPLAYS[s.display]}${s.display === 'rank' ? ` of ${n}` : ''}</b>
            <span>${others.join(' · ')}</span>
            <span>${scoreSummary()} · ${fmtDate(state.meta.asOf)}</span></span>
        </div>
        ${meta ? `<p class="meta">${meta}</p>` : ''}
      </section>

      <a class="sect link" href="#/t/${r.symbol}/chart"><b>Price chart</b>
        <small>3 years of daily bars, with the score beneath</small><i>›</i></a>

      <details class="sect">
        <summary><b>Score components</b><small>${comp.summary}</small><i>›</i></summary>
        <div class="body">${comp.body}</div>
      </details>

      <details class="sect">
        <summary><b>Against its peers</b><small>${peers.summary}</small><i>›</i></summary>
        <div class="body">${peers.body}</div>
      </details>

      <details class="sect">
        <summary><b>Quote &amp; risk</b>
          <small>${money(r.price)}${r.chg == null ? '' : ` · ${signed(r.chg, 2)}%`}</small><i>›</i></summary>
        <div class="body">
          <dl class="stats">
            <div><dt>Price</dt><dd>${money(r.price)}</dd></div>
            <div><dt>Change</dt><dd class="${cls(r.chg)}">${r.chg == null ? '—' : signed(r.chg, 2) + '%'}</dd></div>
            <div><dt>Market cap</dt><dd>${cap(r.mktCap)}</dd></div>
            <div><dt>Ann. vol (12m)</dt><dd>${pct(r.legs.v12)}</dd></div>
            <div><dt>Ann. vol (6m)</dt><dd>${pct(r.legs.v6)}</dd></div>
            <div><dt>In 52w range</dt><dd>${range == null ? '—' : num(range, 0) + '%'}</dd></div>
          </dl>
        </div>
      </details>`;

    $('back').addEventListener('click', goBack);
    wirePager(el, '');
    $('dstar').addEventListener('click', (e) => toggleWatch(r.symbol, e.currentTarget));
    scrollTo(0, 0);
  }

  /* The score, taken apart: the two periods side by side, one row per step —
     the legs, the measure the adjustments pick, the peer statistics it is
     standardized against, the z-score — and the blend written out. Only the
     rows the settings use are marked; the others are shown for reference. */
  function components(r, sc) {
    const s = state.score, legs = r.legs;
    const used = (p) => s.period === 'blend' || s.period === p;
    const cell = (v, klass) => `<td class="${klass || ''}">${v}</td>`;
    const th = (p) => `<th class="${used(p) ? 'on' : ''}">${PERIODS[p]}<small>${p} months</small></th>`;
    const row = (label, f12, f6, on) => `<tr${on ? ' class="on"' : ''}><td>${label}</td>${f12}${f6}</tr>`;
    const stat = (p) => statToday(r)(p);
    const x = (p) => measure(legs, p, s);
    const fmtX = (v) => (v == null ? '—' : s.vol ? signed(v, 2) : spct(v));
    const z = { 12: sc.z12, 6: sc.z6 };
    const body = `
        <p class="sub">Both periods end one month ago; the most recent month is skipped.</p>
        <table class="comp">
          <thead><tr><th></th>${th('12')}${th('6')}</tr></thead>
          <tbody>
            ${row('Return', cell(spct(legs.r12), cls(legs.r12)), cell(spct(legs.r6), cls(legs.r6)), !s.resid)}
            ${row('Net of market', cell(spct(legs.e12), cls(legs.e12)), cell(spct(legs.e6), cls(legs.e6)), s.resid)}
            ${row(s.resid ? 'Residual volatility' : 'Volatility (ann.)', cell(pct(s.resid ? legs.w12 : legs.v12)), cell(pct(s.resid ? legs.w6 : legs.v6)), s.vol)}
            ${row('Measure', cell(fmtX(x('12')), cls(x('12'))), cell(fmtX(x('6')), cls(x('6'))), true)}
            ${row('Peer mean', cell(fmtX(stat('12') && stat('12')[0])), cell(fmtX(stat('6') && stat('6')[0])), true)}
            ${row('Peer std dev', cell(stat('12') ? (s.vol ? num(stat('12')[1], 2) : pct(stat('12')[1])) : '—'), cell(stat('6') ? (s.vol ? num(stat('6')[1], 2) : pct(stat('6')[1])) : '—'), true)}
            <tr class="pct"><td>z-score</td>
              <td class="${used('12') ? 'on' : ''}">${used('12') ? FMT.value(z[12]) : '·'}</td>
              <td class="${used('6') ? 'on' : ''}">${used('6') ? FMT.value(z[6]) : '·'}</td></tr>
          </tbody>
        </table>
        <div class="blend">
          <div><b>Score</b><small>${s.period === 'blend'
            ? `(${FMT.value(sc.z12)} + ${FMT.value(sc.z6)}) ÷ 2`
            : `the ${PERIODS[s.period]} z-score`}</small></div>
          <span class="big" style="color:${tone(sc.pct)}">${FMT.value(sc.s)}</span>
        </div>
        <p class="legend">Marked rows are the steps in use: ${scoreSummary()}. The score's rank
          (${FMT.rank(sc.rank)} of ${state.scored.n}) and percentile (${FMT.pct(sc.pct)}) are read across the
          whole universe. All four choices are made in Settings.</p>
        <a class="more" href="#/settings">Calculation details ›</a>`;
    return { summary: s.period === 'blend' ? `(${FMT.value(sc.z12)} + ${FMT.value(sc.z6)}) ÷ 2 = ${FMT.value(sc.s)}` : `${PERIODS[s.period]} z-score ${FMT.value(sc.s)}`, body };
  }

  /* The same name standardized the other way: against the universe and
     against its sector, with the rank and percentile each gives. The marked
     row is the one the headline uses. */
  function againstPeers(r) {
    const s = state.score;
    const rows = ['universe', 'sector'].map((basis) => {
      const alt = basis === s.basis ? state.scored : scoreAll({ ...s, basis });
      const sc = alt.by[r.symbol];
      return { basis, sc, n: alt.n, on: basis === s.basis };
    });
    const other = rows.find((x) => !x.on);
    const summary = other && other.sc.s != null
      ? `vs ${other.basis}: ${FMT.value(other.sc.s)} · rank ${other.sc.rank} of ${other.n}` : '';
    const body = `
          <table class="peers">
            <tbody>${rows.map(({ basis, sc, n, on }) => `<tr class="${on ? 'on' : ''}">
                <td>${basis === 'universe' ? `Against all of ${UNIVERSE.label}` : `Against ${esc(r.sector) || 'its sector'}`}</td>
                <td class="v" style="color:${tone(sc.pct)}">${FMT.value(sc.s)}</td>
                <td class="k">${sc.rank == null ? '—' : `${sc.rank} / ${n}`}</td></tr>`).join('')}</tbody>
          </table>
          <p class="legend">A name can look ordinary against the whole universe and strong against its
            own sector, or the reverse. Rank and percentile are always across the whole universe; the
            marked row is the standardization the headline uses.</p>`;
    return { summary, body };
  }

  /* ---------- shared bits of the detail and chart views ---------- */
  const goBack = () => (listBehind ? history.back() : (location.hash = ''));

  /* ---------- price chart ----------
     A full-screen, non-scrolling view: every drag on it is a chart gesture.
     The drawing and the gestures live in chart.js, which knows nothing about
     the app; this only fetches the bars and frames them. */
  let chartZoom = null;                    // bar width and right edge, carried from name to name
  function showChart(r) {
    const fromDetail = !$('detail-view').hidden;
    showView('chart-view');
    const el = $('chart-view');
    let chart = null;
    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="cback">‹ Back</button>
        <span class="grow"><b>${r.symbol}</b><small>${esc(r.name)}</small></span>
        <span class="cpx" id="cpx"></span>
        <button type="button" class="ghost" id="ctune" aria-label="Chart settings" aria-haspopup="dialog"
                aria-expanded="false" hidden><svg width="16" height="16" aria-hidden="true"><use href="#i-tune"/></svg></button>
      </div>
      ${pagerHtml(r.symbol)}
      <canvas id="price-chart" aria-label="Daily price bars for ${r.symbol}"></canvas>
      <p class="hint" id="chint">Drag to pan · pinch to zoom · hold for a crosshair · drag the price axis to stretch · double-tap it to reset</p>
      <div class="cpanel" id="cpanel" role="dialog" aria-label="Chart settings" hidden>
        <div class="sheet-handle" aria-hidden="true"></div>
        <div id="cpanel-root">
          <div class="cpanel-head">
            <b>Chart</b>
            <button type="button" id="creset-all" aria-label="Reset all chart settings">Reset</button>
            <button type="button" class="done" id="cdone">Done</button>
          </div>
          <ul class="tree" id="ind-list"></ul>
          <p class="fine">Tap a name for its settings; the eye shows or hides it.</p>
        </div>
        <div id="cpanel-set" hidden>
          <div class="cpanel-head">
            <button type="button" class="backlink" id="cset-back">‹ Chart</button>
            <b id="cset-title"></b>
            <button type="button" id="creset">Reset</button>
          </div>
          <div id="cset-fields"></div>
          <p class="fine" id="cset-blurb"></p>
        </div>
      </div>`;
    $('cback').addEventListener('click', () => (fromDetail ? history.back() : location.replace(`#/t/${r.symbol}`)));
    wirePager(el, '/chart', () => { if (chart) chartZoom = chart.zoom(); });
    const scoreFile = loadScoreFile();
    loadBars(r.symbol).then((bars) => {
      if (!location.hash.startsWith(`#/t/${r.symbol}/chart`)) return;
      if (!bars) {
        $('cpx').innerHTML = '<small>No bars yet</small>';
        $('chint').textContent = 'Daily bars for this name arrive with the next data refresh.';
        return;
      }
      const n = bars.c.length, last = bars.c[n - 1], prev = n > 1 ? bars.c[n - 2] : bars.o[n - 1];
      const chg = last / prev - 1;
      $('cpx').innerHTML = `<b>${last.toFixed(2)}</b><small class="${cls(chg)}">${spct(chg, 2)}</small>` +
        `<small>${fmtDate(bars.dates[n - 1])}</small>`;
      let panel = null;
      chart = priceChart($('price-chart'), bars, {
        indicators: state.chart, view: chartZoom,
        onChange: (cfg) => { state.chart = cfg; saveChartPrefs(); },
        onOpen: (id) => panel && panel.openTo(id),
      });
      // The score pane fills in when its file lands; the bars never wait for it.
      scoreFile.then((file) => {
        if (chart && file && bars.legs && location.hash.startsWith(`#/t/${r.symbol}/chart`)) chart.setSeries(seriesFor(r, bars, file));
      });
      // The gesture hint shows once per session, not on every name stepped to.
      setTimeout(() => { const h = $('chint'); if (h) h.style.opacity = 0; }, chartZoom ? 0 : 6000);
      panel = wireChartPanel(chart, r.symbol);
    });
  }

  /* The name's daily score, one entry per bar, in the chosen display: each
     day's legs from the bar file scored against that day's peer statistics
     from the score file, then read off that day's ladder for the rank or
     percentile. The last day is the same arithmetic the list did, on the same
     numbers, so the pane's last point and the row agree. */
  function seriesFor(r, bars, file) {
    const s = state.score, kind = s.display;
    const at = new Map(file.dates.map((d, i) => [d, i]));
    if (!file.decoded) file.decoded = file.ladder.map(unpackLadder);
    const group = file.stats[groupOf(r)] || {};
    const values = bars.dates.map((d, i) => {
      const k = at.get(d);
      if (k == null) return null;
      const legs = {};
      for (const key of Object.keys(bars.legs)) legs[key] = bars.legs[key][i];
      const sc = scoreFrom(legs, (p) => (group[p] ? group[p][k] : null));
      if (sc.s == null) return null;
      if (kind === 'value') return sc.s;
      const rank = rankIn(file.decoded[k], sc.s);
      return kind === 'rank' ? rank : pctOf(rank, file.n[k]);
    });
    const n = bars.dates.map((d) => { const k = at.get(d); return k == null ? null : file.n[k]; });
    return { kind, values, n, label: kind === 'value' ? 'Score' : kind === 'rank' ? 'Score rank' : 'Score pctl' };
  }
  /* A ladder ships as base64 little-endian int16. */
  function unpackLadder(b64) {
    const bin = atob(b64), out = new Int16Array(bin.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    return out;
  }

  /* How each indicator's settings read in the panel. The numbers themselves
     (defaults, ranges) come from chart.js so the two can never disagree. */
  const IND_UI = {
    channel: {
      blurb: 'A straight line fitted through the closes over the length, with bands the chosen '
        + 'number of standard deviations either side, extended to the right edge. On a log axis the '
        + 'fit is on the logarithm of the closes, so the bands are equal percentages apart. Fill '
        + 'shades the bands; 0% keeps the lines only.',
      fields: [
        { key: 'len', label: 'Length', fmt: (v) => `${v} days` },
        { key: 'dev', label: 'Width', fmt: (v) => `${v.toFixed(1)}σ` },
        { key: 'fill', label: 'Fill', scale: 100, fmt: (v) => `${Math.round(v * 100)}%` },
      ],
      summary: (c) => `${c.len} days · ${c.dev.toFixed(1)}σ · ${Math.round(c.fill * 100)}% fill`,
    },
    ma: {
      blurb: 'The simple average of the closes over the period, drawn in amber over the bars.',
      fields: [{ key: 'period', label: 'Period', fmt: (v) => `${v} days` }],
      summary: (m) => `Simple · ${m.period} days`,
    },
    ma2: {
      blurb: 'A second simple average, drawn in violet, so a short and a long one can be read '
        + 'together (50 and 200 days is the common pair).',
      fields: [{ key: 'period', label: 'Period', fmt: (v) => `${v} days` }],
      summary: (m) => `Simple · ${m.period} days`,
    },
    score: {
      get blurb() {
        return `The score on each day as Settings define it (${scoreSummary()}), shown as its `
          + `${DISPLAYS[state.score.display].toLowerCase()}, drawn beneath the price on the same dates so a move `
          + 'in the score reads against the bars that made it. Each day is a full cross-section of the universe '
          + 'as it stood that day. The divider between the panes drags too.';
      },
      choices: [{ key: 'style', label: 'Draw as', labels: { line: 'Line', bars: 'Bars' } }],
      fields: [{ key: 'height', label: 'Height', scale: 100, fmt: (v) => `${Math.round(v * 100)}% of the chart` }],
      summary: (c) => `${c.style === 'bars' ? 'Bars' : 'Line'} · ${DISPLAYS[state.score.display].toLowerCase()} · ${scoreSummary()}`,
    },
    axis: {
      blurb: 'Linear spaces prices evenly. Log spaces them so equal percentage moves are equal '
        + 'heights, which keeps a name that has doubled or halved in proportion; the regression '
        + 'channel is then fitted in logs too. Switching returns the price range to automatic.',
      labels: { linear: 'Linear', log: 'Log' },
    },
  };

  /* The panel's root is a full-screen list of what the chart draws: the
     price plot first (its settings are the price axis), then the overlays,
     then a divider and whatever is drawn in its own pane below the price —
     each with an eye to show or hide it and a tap-through to its settings.
     One item's settings open as a small sheet over the chart so it redraws
     live as a control moves. The canvas keeps its own gestures — a touch on
     it both closes the sheet and pans, which is what a finger expects. */
  function wireChartPanel(chart, symbol) {
    const IND = priceChart.INDICATORS, AXIS = priceChart.AXIS;
    const btn = $('ctune'), panel = $('cpanel'), root = $('cpanel-root'), setScreen = $('cpanel-set');
    let editing = null;

    const icon = (id) => `<svg class="tree-ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;
    const row = ([id, spec]) => `
        <li class="tree-row${state.chart[id].on ? ' on' : ''}" data-ind="${id}">
          <button type="button" class="ind-open" data-ind="${id}">${icon('wave')}<span><b>${spec.name} <i>›</i></b>
            <small>${IND_UI[id].summary(state.chart[id])}</small></span></button>
          <button type="button" class="eye" data-eye="${id}" aria-pressed="${state.chart[id].on}"
                  aria-label="Show ${spec.name}"><svg aria-hidden="true"><use href="#i-eye${state.chart[id].on ? '' : '-off'}"/></svg></button>
        </li>`;
    const renderList = () => {
      const scale = IND_UI.axis.labels[state.chart.axis.scale];
      const entries = Object.entries(IND);
      const above = entries.filter(([, spec]) => spec.pane !== 'below');
      const below = entries.filter(([, spec]) => spec.pane === 'below');
      $('ind-list').innerHTML = `
        <li class="tree-row price on">
          <button type="button" class="ind-open" data-ind="axis">${icon('bars')}<span><b>${symbol} · 1D</b>
            <small>${AXIS.name} · ${scale}</small></span></button>
        </li>
        <li class="tree-sep" aria-hidden="true">On the chart</li>
        ${above.map(row).join('')}
        <li class="tree-sep" aria-hidden="true">Below the chart</li>
        ${below.length ? below.map(row).join('') : '<li class="tree-empty">Nothing yet.</li>'}`;
    };
    const renderFields = (id) => {
      if (id === 'axis') return renderAxis();
      const cur = state.chart[id];
      $('cset-title').textContent = IND[id].name;
      $('cset-blurb').textContent = IND_UI[id].blurb;
      const choices = (IND_UI[id].choices || []).map((f) => `
        <div class="cchoice"><span>${f.label}</span>
          <div class="segmented" role="radiogroup" aria-label="${IND[id].name} ${f.label.toLowerCase()}">
            ${IND[id].choices[f.key].map((v) => `<button type="button" role="radio" data-ind="${id}" data-choice="${f.key}"
               data-value="${v}" class="${v === cur[f.key] ? 'on' : ''}" aria-checked="${v === cur[f.key]}">${f.labels[v]}</button>`).join('')}
          </div>
        </div>`).join('');
      $('cset-fields').innerHTML = choices + IND_UI[id].fields.map((f) => {
        const [lo, hi, step] = IND[id].limits[f.key], k = f.scale || 1;
        return `<label class="cslider"><span>${f.label} <output data-out="${f.key}">${f.fmt(cur[f.key])}</output></span>
          <input type="range" data-ind="${id}" data-key="${f.key}" min="${lo * k}" max="${hi * k}" step="${step * k}"
                 value="${Math.round(cur[f.key] * k * 1e6) / 1e6}" aria-label="${IND[id].name} ${f.label.toLowerCase()}"></label>`;
      }).join('');
    };
    const renderAxis = () => {
      const cur = state.chart.axis.scale;
      $('cset-title').textContent = AXIS.name;
      $('cset-blurb').textContent = IND_UI.axis.blurb;
      $('cset-fields').innerHTML = `
        <div class="cchoice">
          <div class="segmented" id="scale-seg" role="radiogroup" aria-label="${AXIS.name}">
            ${AXIS.choices.scale.map((v) => `<button type="button" role="radio" data-scale="${v}"
               class="${v === cur ? 'on' : ''}" aria-checked="${v === cur}">${IND_UI.axis.labels[v]}</button>`).join('')}
          </div>
        </div>`;
    };
    const apply = (id, patch) => {
      chart.set({ [id]: patch });
      state.chart = chart.indicators();            // the chart's clamped copy is the truth
    };
    /* Reset all: one tap arms it and says so, a second tap within a few
       seconds returns every eye, setting and the axis to defaults. Anything
       else — opening an item, closing — disarms it. */
    const resetAll = $('creset-all');
    let armed = 0;
    const disarm = () => { clearTimeout(armed); armed = 0; resetAll.textContent = 'Reset'; resetAll.classList.remove('armed'); };
    const showList = () => {
      disarm();
      editing = null; renderList();
      setScreen.hidden = true; root.hidden = false; panel.classList.add('full');
    };
    const showSettings = (id) => {
      disarm();
      editing = id; renderFields(id);
      $('creset').hidden = id !== 'axis' && !IND_UI[id].fields.length && !(IND_UI[id].choices || []).length;
      root.hidden = true; setScreen.hidden = false; panel.classList.remove('full');
    };
    const open = () => {
      showList();
      panel.hidden = false;
      $('chint').style.opacity = 0;
      btn.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => panel.classList.add('open'));
    };
    const close = () => {
      if (panel.hidden) return;
      disarm();
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { panel.hidden = true; }, 220);
    };

    btn.hidden = false;
    btn.addEventListener('click', () => (panel.hidden ? open() : close()));
    $('cdone').addEventListener('click', close);
    resetAll.addEventListener('click', () => {
      if (!armed) {
        resetAll.textContent = 'Reset all?';
        resetAll.classList.add('armed');
        armed = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      const defaults = Object.fromEntries(Object.entries(IND).map(([id, spec]) => [id, { ...spec.defaults }]));
      defaults.axis = { ...AXIS.defaults };
      chart.set(defaults);
      state.chart = chart.indicators();
      saveChartPrefs();
      renderList();
    });
    $('cset-back').addEventListener('click', showList);
    $('creset').addEventListener('click', () => {
      if (editing === 'axis') {
        apply('axis', { ...AXIS.defaults });
      } else {
        const { on, ...defaults } = IND[editing].defaults;   // reset the numbers, keep the eye
        apply(editing, defaults);
      }
      saveChartPrefs();
      renderFields(editing);
    });
    panel.addEventListener('click', (e) => {
      const openBtn = e.target.closest('.ind-open');
      if (openBtn) return showSettings(openBtn.dataset.ind);
      const eye = e.target.closest('.eye');
      if (eye) {
        const id = eye.dataset.eye, on = !state.chart[id].on;
        apply(id, { on });
        saveChartPrefs();
        eye.setAttribute('aria-pressed', String(on));
        eye.querySelector('use').setAttribute('href', `#i-eye${on ? '' : '-off'}`);
        eye.closest('.tree-row').classList.toggle('on', on);
        return;
      }
      const scaleBtn = e.target.closest('button[data-scale]');
      if (scaleBtn) {
        apply('axis', { scale: scaleBtn.dataset.scale });
        saveChartPrefs();
        renderAxis();
        return;
      }
      const choiceBtn = e.target.closest('button[data-choice]');
      if (choiceBtn) {
        apply(choiceBtn.dataset.ind, { [choiceBtn.dataset.choice]: choiceBtn.dataset.value });
        saveChartPrefs();
        renderFields(choiceBtn.dataset.ind);
      }
    });
    panel.addEventListener('change', (e) => {
      if (e.target.type === 'range') saveChartPrefs();
    });
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (t.type !== 'range') return;
      const id = t.dataset.ind, key = t.dataset.key;
      const f = IND_UI[id].fields.find((x) => x.key === key), k = f.scale || 1;
      const step = IND[id].limits[key][2], dec = (String(step).split('.')[1] || '').length;
      const v = +(Math.round(t.valueAsNumber / k / step) * step).toFixed(dec);
      apply(id, { [key]: v });
      setScreen.querySelector(`output[data-out="${key}"]`).textContent = f.fmt(state.chart[id][key]);
    });
    $('price-chart').addEventListener('pointerdown', close);
    const onKey = (e) => {
      if (!panel.isConnected) { removeEventListener('keydown', onKey); return; }   // chart view was rebuilt
      if (e.key !== 'Escape') return;
      if (editing) showList(); else close();
    };
    addEventListener('keydown', onKey);

    /* Open straight to one item's settings: what a tap on its label on the
       chart does. The sheet slides up over the chart as usual. */
    const openTo = (id) => {
      showSettings(id);
      if (panel.hidden) {
        panel.hidden = false;
        $('chint').style.opacity = 0;
        btn.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => panel.classList.add('open'));
      }
    };
    return { openTo };
  }

  /* One fetch per symbol per session. A missing file resolves to null, so a
     name published before its bars were means an empty chart, not a broken one. */
  function loadBars(symbol) {
    state.bars = state.bars || new Map();
    if (!state.bars.has(symbol)) {
      state.bars.set(symbol, getJSON(`data/bars/${symbol}.json`).catch(() => null));
    }
    return state.bars.get(symbol);
  }
})();
