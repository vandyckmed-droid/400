/* MidCap 650 Momentum — vanilla, no dependencies.
   Data is pre-computed by scripts/build.py and served as static JSON. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE = 60;                         // rows appended per scroll chunk
  const WATCH_KEY = 'sp400.watchlist.v1';
  const SECTORS_KEY = 'sp400.sectors.v1';
  const BASIS_KEY = 'sp400.basis.v1';
  const ADJUST_KEY = 'sp400.adjust.v1';
  const GRAIN_KEY = 'sp400.grain.v1';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* One universe: the MidCap 400 plus the smallest 250 of the S&P 500 by market
     cap, ~650 names. It is not a setting — a name is measured against
     everything of roughly its size, and which index committee happens to hold
     it is not a fact about the name. What remains are two ways of looking at
     that one universe: `basis` (against all of it, or against the name's own
     sector) and `adjust` (the return, or the return over its own volatility).
     All four combinations ship in latest.json, keyed w/s + r/v. */
  const UNIVERSE = { label: 'MidCap 650', size: '650' };
  const keyFor = (basis, adjust) =>
    (basis === 'sector' ? 's' : 'w') + (adjust === 'vol' ? 'v' : 'r');

  const state = {
    rows: [],
    meta: null,
    history: null,
    historyPromise: null,
    watch: loadWatch(),
    scope: 'all',
    sectors: loadSectors(),
    sort: 'score',
    query: '',
    view: [],
    shown: 0,
    backtest: null,
    backtestPromise: null,
    horizon: '6',
    folds: new Set(),
    basis: (() => {
      try { return localStorage.getItem(BASIS_KEY) === 'sector' ? 'sector' : 'whole'; }
      catch { return 'whole'; }
    })(),
    /* Default is the return itself. Dividing by volatility is a real choice
       about what "momentum" means, not a detail, so it is opt-in. */
    adjust: (() => {
      try { return localStorage.getItem(ADJUST_KEY) === 'vol' ? 'vol' : 'raw'; }
      catch { return 'raw'; }
    })(),
    grain: (() => {
      try { return localStorage.getItem(GRAIN_KEY) === 'w' ? 'w' : 'm'; } catch { return 'm'; }
    })(),
  };

  const peerKey = () => keyFor(state.basis, state.adjust);
  /* The portfolio curves cover whole-universe rankings only, so a reader on the
     within-sector basis still sees the whole-universe record, labelled. */
  const perfKey = () => keyFor('whole', state.adjust);
  const volAdjusted = () => state.adjust === 'vol';

  /* This row's placement in the active peer set. Every published name is a
     member of the universe and every sector clears MIN_SECTOR, so unlike when
     the universe was a choice, this never comes back undefined. */
  const place = (r) => r.r[peerKey()];
  const sectorBasis = () => state.basis === 'sector';

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
  /* Score colour ramp: cold (0) → neutral (50) → hot (100). The scheme is
     read once and refreshed on change rather than queried per bar; a theme
     flip mid-session (auto dark mode at dusk) re-renders the open view. */
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let dark = scheme.matches;
  scheme.addEventListener('change', (e) => { dark = e.matches; if (state.rows.length) route(); });

  function tone(score) {
    const t = Math.max(0, Math.min(100, score)) / 100;
    // Piecewise so that 50 lands on a genuinely neutral amber rather than a
    // greenish midpoint: 0 = red, 0.5 = amber, 1 = green.
    const hue = t < 0.5 ? 4 + (t / 0.5) * 38 : 42 + ((t - 0.5) / 0.5) * 103;
    const sat = 62 + Math.abs(t - 0.5) * 30;
    return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${dark ? 57 : 41}%)`;
  }
  const cls = (v) => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  // pct() above is unsigned; a return needs its sign, and a real minus sign.
  const spct = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : '−'}${pct(Math.abs(v), d)}`;
  const RANKED_ON = { raw: 'the return itself', vol: 'return ÷ volatility' };

  /* ---------- data files ----------
     Everything past latest.json is fetched once and memoised on state, so a
     view can ask for what it needs without tracking whether it already has
     it. A failed fetch resolves to null: a missing extra never breaks the
     ranking, it just leaves that piece of the page out. */
  function loadJSON(file, key) {
    const cached = key + 'Promise';
    if (!state[cached]) {
      state[cached] = fetch(file, { cache: 'no-cache' })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => { state[key] = d; return d; })
        .catch(() => null);
    }
    return state[cached];
  }
  /* Monthly and weekly ship as separate files; the weekly one is three times
     the size and most visits never open it, so it loads only when asked for. */
  const loadHistory = (key, grain) =>
    loadJSON(`data/history/${key}${grain === 'w' ? 'w' : ''}.json`, `hist_${key}${grain}`);
  const loadBacktest = () => loadJSON('data/backtest.json', 'backtest');
  /* One strip file per peer set: the list only ever draws the active one, and
     eight sets in one payload would be seven wasted downloads. */
  const loadSpark = () => loadJSON(`data/spark/${peerKey()}.json`, `spark_${peerKey()}`);
  /* Headline portfolio numbers, small enough to load with the ranking; the full
     daily curves wait until the evidence view asks for them. */
  const loadBrief = () => loadJSON('data/portfolio-brief.json', 'brief');
  const loadPortfolio = () => loadJSON('data/portfolio.json', 'portfolio');

  /* ---------- boot ---------- */
  Promise.all([
    fetch('data/latest.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    loadSpark(),      // optional: rows still render without their strips
    loadBrief(),      // optional: the performance strip fills in when it lands
  ])
    .then(([payload]) => {
      state.rows = payload.rows;
      state.meta = payload.meta;
      state.bySymbol = new Map(payload.rows.map((r) => [r.symbol, r]));
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
      renderPerf();
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

  /* A one-line record of what the ranking's top decile actually did, so the
     question "is this list worth acting on" has an answer on the screen the
     reader is already looking at. It is a small line, not a hero: the number is
     a backtest, and the universe's own return sits beside it so the comparison
     that matters cannot be skipped. Taps through to the full curve. */
  function renderPerf() {
    const el = $('perf');
    const v = state.brief && state.brief.variants[perfKey()];
    if (!v) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      `${equitySpark(v.curve)}` +
      `<span class="perf-txt"><b>Top 10%</b>` +
      `<small>${sectorBasis() ? 'whole-universe ranking · ' : ''}backtested</small></span>` +
      `<span class="perf-num"><b class="${cls(v.cagr)}">${spct(v.cagr)}</b>` +
      `<small>a year · ${spct(v.excess)} vs universe</small></span>` +
      `<span class="perf-go" aria-hidden="true">›</span>`;
    el.setAttribute('aria-label',
      `Top 10% backtest: ${spct(v.cagr)} a year, ${spct(v.excess)} against all ranked names. ` +
      'See the full record.');
  }

  /* The strip's own chart is a line, not bars: bars in this app mean a
     cross-sectional score, a line means money compounding. Keeping those two
     languages apart is worth more than reusing one primitive. */
  function equitySpark(curve) {
    const W = 56, H = 22, lo = Math.min(...curve), hi = Math.max(...curve);
    const span = (hi - lo) || 1;
    const x = (i) => (i / (curve.length - 1)) * W;
    const y = (v) => H - 1.5 - ((v - lo) / span) * (H - 3);
    const line = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${line} ${W},${H} 0,${H}`;
    return `<svg class="eqspark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">` +
      `<polygon points="${area}"/><polyline points="${line}"/></svg>`;
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

  function syncControls() {
    $('basis').checked = sectorBasis();
    $('adjust').checked = volAdjusted();
  }

  /* Everything that has to happen when the peer set changes, in one place so no
     control can forget a step. The strips live in a per-set file, so rows are
     redrawn once now on whatever is cached and again when the new file lands. */
  function peerSetChanged() {
    syncControls();
    fillSectors();
    applyFilters();
    renderPerf();
    const key = peerKey();
    loadSpark().then(() => { if (peerKey() === key) applyFilters(); });
  }

  /* ---------- settings ---------- */
  function showSettings() {
    showView('settings-view');
    scrollTo(0, 0);
    const m = state.meta;
    $('data-stats').innerHTML = [
      ['Prices through', fmtDate(m.asOf)],
      ['Last refresh', fmtDate(m.generatedAt.slice(0, 10))],
      ['Names ranked', m.members],
      ['Chart history', `${m.params.historyMonths} months or ${m.params.historyWeeks} weeks`],
      ['From the MidCap 400', m.fromCore],
      ['From the S&P 500 tail', m.members - m.fromCore],
      ['Blend', `${m.params.weights[0] * 100}/${m.params.weights[1] * 100} · skip ${m.params.skipDays}d`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    /* The method has to describe the score the reader is actually getting, so
       the volatility step appears only when it is switched on. */
    $('method').innerHTML = [
      ['12–1 momentum', 'Total return on dividend- and split-adjusted closes over the 12 months '
        + 'ending one month ago. The most recent month is skipped to sidestep short-term reversal.'],
      ['6–1 momentum', 'Same idea over the trailing 6 months, again ending one month ago.'],
      ...(volAdjusted() ? [['Volatility adjustment', 'Each leg is divided by the annualised standard '
        + 'deviation of daily log returns measured over that same formation window, so a steady '
        + 'climb outranks an equally large but erratic one.']] : []),
      ['Cross-sectional percentile', `Each ${volAdjusted() ? 'adjusted ' : ''}leg is ranked against `
        + 'every other name in the peer set on the same day and mapped to 0–100.'],
      ['Blend', `Final score = ${m.params.weights[0] * 100}% × 12–1 percentile + `
        + `${m.params.weights[1] * 100}% × 6–1 percentile.`],
    ].map(([k, v]) => `<li><b>${k}.</b> ${v}</li>`).join('');
  }

  const sortValue = (r, key) => {
    if (key === 'mktCap') return r.mktCap;
    const p = place(r);
    return key === 'score' ? p.s : key === 'p12' ? p.p12 : p.p6;
  };

  /* What the two numbers on a row mean. They always describe whatever the list
     is ordered by: showing a blended rank and a blended score while the list is
     ordered by something else made the column read 1, 297, 2, 14 and the score
     beside it run 99.8, 53.8, 98.7, with nothing on screen explaining why.
     Ticker A-Z is the exception — it is a lookup order, not a ranking, so the
     rows keep the standing they have in the ranking proper. */
  const SORTS = {
    score: { label: 'blended score', value: (r) => place(r).s.toFixed(1) },
    p12: { label: '12–1 percentile', value: (r) => place(r).p12.toFixed(1) },
    p6: { label: '6–1 percentile', value: (r) => place(r).p6.toFixed(1) },
    mktCap: { label: 'market cap', value: (r) => cap(r.mktCap) },
    symbol: { label: 'ticker', value: (r) => place(r).s.toFixed(1) },
  };

  /* Rank on the active metric, over the whole universe rather than the filtered
     view: with a sector chosen, "8th" should still mean eighth of 649, which is
     the more useful fact and what the list has always shown. */
  function rankOn(key) {
    if (key === 'score' || key === 'symbol') return null;   // place().k already is it
    const ordered = state.rows.slice().sort(
      (a, b) => ((sortValue(b, key) ?? -Infinity) - (sortValue(a, key) ?? -Infinity))
                || a.symbol.localeCompare(b.symbol));
    return new Map(ordered.map((r, i) => [r.symbol, i + 1]));
  }

  /* ---------- list ---------- */
  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    let out = state.rows;
    if (state.scope === 'watch') out = out.filter((r) => state.watch.has(r.symbol));
    if (state.sectors.size) out = out.filter((r) => state.sectors.has(r.sector));
    if (q) out = out.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));

    const key = state.sort;
    state.ranks = rankOn(key);
    // Scores ship rounded to 2dp, so names can tie on the value the list sorts
    // by while the pipeline ranked them on the unrounded one. Break ties on
    // rank so the number in the left column never runs 3, 2, 4.
    out = out.slice().sort(
      key === 'symbol'
        ? (a, b) => a.symbol.localeCompare(b.symbol)
        : (a, b) => ((sortValue(b, key) ?? -Infinity) - (sortValue(a, key) ?? -Infinity))
                    || (place(a).k - place(b).k)
    );

    state.view = out;
    state.shown = 0;
    $('rows').replaceChildren();

    const watching = state.scope === 'watch';
    $('empty').hidden = out.length > 0;
    $('empty').textContent = !watching ? 'No matches.'
      : state.watch.size === 0 ? 'Tap ☆ on any name to keep it here.'
      : 'No watched names match.';
    /* One line, naming whatever actually decides the order on screen. Two
       things had to agree with the rows and did not: saying "ranked across the
       whole universe" beside a list ordered by market cap described two
       different orderings at once, and the within-sector wording claimed the
       left column was a position inside the sector, which stops being true the
       moment another metric decides the order. */
    const ordered = key !== 'score' && key !== 'symbol';
    const metric = SORTS[key].label
      + (sectorBasis() && (key === 'p12' || key === 'p6') ? ', within sector' : '');
    $('count').textContent = out.length
      ? `${out.length} of ${state.rows.length} · ` + (
          ordered ? `ordered by ${metric}`
          : sectorBasis()
            ? 'scored within each sector, so the number on the left is the position inside that sector'
            : 'ranked across the whole universe')
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
    const p = place(r);
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.symbol = r.symbol;
    li.innerHTML =
      `<span class="rk">${state.ranks ? state.ranks.get(r.symbol) : p.k}</span>` +
      `<a class="who" href="#/t/${r.symbol}"><b>${r.symbol}</b>` +
      `<small>${r.idx === '500' ? '<i class="badge">S&amp;P 500</i> ' : ''}${esc(r.name)}</small></a>` +
      sparkline(r.symbol) +
      `<span class="sc"><b>${SORTS[state.sort].value(r)}</b></span>` +
      `<button class="star${state.watch.has(r.symbol) ? ' on' : ''}" aria-label="Watchlist">` +
      `${state.watch.has(r.symbol) ? '★' : '☆'}</button>`;
    return li;
  }

  /* A year of month-end scores as a strip of tone-coloured bars, the same
     ramp the detail chart uses, with a hairline at 50 so above/below the
     median reads at a glance. Months scored as an outsider (before the name
     joined the index) are dimmed, as in the detail chart. */
  const SPARK = { w: 6, gap: 2, h: 22 };
  function sparkline(symbol) {
    const sp = state[`spark_${peerKey()}`];
    const scores = sp && sp.scores[symbol];
    const n = sp ? sp.dates.length : 12;
    const width = n * (SPARK.w + SPARK.gap) - SPARK.gap;
    const outside = (sp && sp.outside[symbol]) || [];
    let bars = '';
    if (scores) {
      scores.forEach((v, i) => {
        if (v == null) return;
        const h = Math.max(1.5, v / 100 * SPARK.h);
        bars += `<rect x="${i * (SPARK.w + SPARK.gap)}" y="${(SPARK.h - h).toFixed(1)}" `
          + `width="${SPARK.w}" height="${h.toFixed(1)}" rx="1" fill="${tone(v)}"`
          + `${outside.includes(i) ? ' opacity=".4"' : ''}/>`;
      });
    }
    const first = scores && scores.find((v) => v != null);
    const label = scores ? `Score over the last ${n} months: ${first} to ${scores[scores.length - 1]}` : '';
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
    let debounce;
    $('search').addEventListener('input', (e) => {
      clearTimeout(debounce);
      const value = e.target.value;
      debounce = setTimeout(() => { state.query = value; applyFilters(); }, 120);
    });
    $('basis').addEventListener('change', (e) => {
      state.basis = e.target.checked ? 'sector' : 'whole';
      try { localStorage.setItem(BASIS_KEY, state.basis); } catch { /* private mode */ }
      peerSetChanged();
    });
    $('adjust').addEventListener('change', (e) => {
      state.adjust = e.target.checked ? 'vol' : 'raw';
      try { localStorage.setItem(ADJUST_KEY, state.adjust); } catch { /* private mode */ }
      peerSetChanged();
      showSettings();                       // the method text below it changes too
    });
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

    for (const tab of document.querySelectorAll('.segmented button')) {
      tab.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.segmented button')) {
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

    addEventListener('hashchange', route);
  }

  /* ---------- routing ---------- */
  const VIEWS = ['list-view', 'detail-view', 'evidence-view', 'settings-view', 'chart-view'];
  /* Whether the list is behind us in history. It isn't when the page was
     opened straight on a ticker or the evidence view from a shared link, and
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
    if (location.hash === '#/evidence') return showEvidence();
    if (location.hash === '#/settings') return showSettings();
    showView('list-view');
    if (!state.view.length) applyFilters();
    const y = Number(sessionStorage.getItem('sp400.scroll') || 0);
    while (state.shown < state.view.length && document.documentElement.scrollHeight < y + innerHeight) {
      appendChunk();
    }
    scrollTo(0, y);
  }


  /* ---------- detail ---------- */
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function showDetail(r) {
    const key = peerKey();
    const p = r.r[key];
    if (!$('list-view').hidden) sessionStorage.setItem('sp400.scroll', String(scrollY));
    for (const v of VIEWS) if (v !== 'detail-view') $(v).hidden = true;
    const el = $('detail-view');
    el.hidden = false;
    const range = r.yearHigh && r.yearLow && r.yearHigh > r.yearLow
      ? ((r.price - r.yearLow) / (r.yearHigh - r.yearLow)) * 100 : null;

    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="back">‹ Back</button>
        <span class="grow"><b>${r.symbol}</b><small>${esc(r.name)}</small></span>
        <button class="star${state.watch.has(r.symbol) ? ' on' : ''}" id="dstar" aria-label="Watchlist">${state.watch.has(r.symbol) ? '★' : '☆'}</button>
      </div>
      <div class="hero">
        <span class="big" style="color:${tone(p.s)}">${p.s.toFixed(1)}</span>
        <span class="lbl">blended score<b>${ordinal(p.k)} of ${p.n}${
          key[0] === 's' ? ` in ${esc(r.sector)}` : ''}</b></span>
      </div>
      <div class="tags">
        ${r.sector ? `<span class="tag">${esc(r.sector)}</span>` : ''}
        ${r.industry ? `<span class="tag">${esc(r.industry)}</span>` : ''}
        <span class="tag">${cap(r.mktCap)}</span>
        ${r.idx === '500' ? '<span class="tag">S&amp;P 500 tail</span>' : ''}
        <a class="tag link" href="#/evidence">Decile ${decileOf(p.k, p.n)} · how it tested →</a>
      </div>

      <a class="card go" href="#/t/${r.symbol}/chart"><b>Price chart →</b>
        <small>Daily bars with a 200-day regression channel. Drag to pan, pinch to zoom,
          drag the price axis to stretch it.</small></a>

      <div class="card">
        <h3>Momentum legs</h3>
        ${leg('12–1', '12 months, last month skipped', p.p12, r.m12, r.va12)}
        ${leg('6–1', '6 months, last month skipped', p.p6, r.m6, r.va6)}
      </div>

      <div class="card">
        <h3>Against its peers</h3>
        <table class="peers">
          <tbody>${[['whole', `All of ${UNIVERSE.label}`],
                    ['sector', `Within ${esc(r.sector) || 'its sector'}`]].map(([b, label]) => {
            const q = r.r[keyFor(b, state.adjust)];
            const active = (b === 'sector') === (key[0] === 's');
            return `<tr class="${active ? 'on' : ''}">
              <td>${label}</td>
              <td class="v" style="color:${q ? tone(q.s) : 'var(--ink-3)'}">${q ? q.s.toFixed(1) : '—'}</td>
              <td class="k">${q ? `${q.k} / ${q.n}` : '—'}</td></tr>`;
          }).join('')}</tbody>
        </table>
        <p class="legend">A name can look ordinary against the whole universe and strong against its
          own sector, or the reverse.</p>
      </div>

      <div class="card">
        <h3>Quote &amp; risk</h3>
        <dl class="stats">
          <div><dt>Price</dt><dd>${money(r.price)}</dd></div>
          <div><dt>Change</dt><dd class="${cls(r.chg)}">${r.chg == null ? '—' : signed(r.chg, 2) + '%'}</dd></div>
          <div><dt>Market cap</dt><dd>${cap(r.mktCap)}</dd></div>
          <div><dt>Ann. vol (12m)</dt><dd>${pct(r.vol12)}</dd></div>
          <div><dt>Ann. vol (6m)</dt><dd>${pct(r.vol6)}</dd></div>
          <div><dt>In 52w range</dt><dd>${range == null ? '—' : num(range, 0) + '%'}</dd></div>
        </dl>
      </div>

      <div class="card">
        <h3 class="row">Score through time
          <span class="segmented mini" id="grain" role="tablist" aria-label="Chart interval">
            ${[['m', 'Monthly'], ['w', 'Weekly']].map(([g, label]) =>
              `<button role="tab" data-g="${g}" class="${g === state.grain ? 'on' : ''}"
                 aria-selected="${g === state.grain}">${label}</button>`).join('')}
          </span>
        </h3>
        <div id="chart"><p class="legend">Loading history…</p></div>
      </div>`;

    $('back').addEventListener('click', goBack);
    $('dstar').addEventListener('click', (e) => toggleWatch(r.symbol, e.currentTarget));
    scrollTo(0, 0);
    el.querySelector('#grain').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-g]');
      if (!tab || tab.dataset.g === state.grain) return;
      state.grain = tab.dataset.g;
      try { localStorage.setItem(GRAIN_KEY, state.grain); } catch { /* private mode */ }
      for (const b of el.querySelectorAll('#grain button')) {
        const on = b === tab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      }
      renderTickerChart(r, key);
    });
    renderTickerChart(r, key);
  }

  /* One momentum leg: percentile, raw return, and the vol-adjusted ratio. */
  function leg(title, note, percentile, raw, adjusted) {
    return `<div class="leg">
      <h4>${title}<small>${note}</small></h4>
      <dl class="stats">
        <div><dt>Percentile</dt><dd style="color:${tone(percentile)}">${num(percentile)}</dd></div>
        <div><dt>Return</dt><dd class="${cls(raw)}">${pct(raw)}</dd></div>
        <div><dt>Vol-adjusted</dt><dd class="${cls(adjusted)}">${signed(adjusted, 2)}</dd></div>
      </dl>
    </div>`;
  }

  /* ---------- bar chart ----------
     Every chart in the app is bars rising from a baseline with a tap-and-drag
     readout, so they all come through this one primitive: the score history,
     the decile returns, and the spread series only differ in their scale,
     colours and labels. */
  function barChart(host, cfg) {
    const W = 340, H = cfg.height || 150, PAD_L = 4, PAD_R = cfg.padAxis || 26, PAD_B = 16, PAD_T = 6;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_B - PAD_T;
    const pts = cfg.points;
    const step = plotW / pts.length;
    const barW = Math.max(2, step * (cfg.barRatio || 0.68));
    const span = (cfg.max - cfg.min) || 1;
    const y = (v) => PAD_T + plotH * (1 - (v - cfg.min) / span);
    const base = y(cfg.baseline ?? cfg.min);
    const barX = (i) => PAD_L + i * step + (step - barW) / 2;

    const bars = pts.map((p, i) => {
      const top = Math.min(y(p.value), base), bottom = Math.max(y(p.value), base);
      return `<rect data-i="${i}" x="${barX(i).toFixed(2)}" y="${top.toFixed(2)}" ` +
             `width="${barW.toFixed(2)}" height="${Math.max(1, bottom - top).toFixed(2)}" ` +
             `rx="1" fill="${p.color}"${p.opacity != null ? ` fill-opacity="${p.opacity}"` : ''}/>`;
    }).join('');

    const guides = (cfg.guides || []).map((g) =>
      `<line class="${g.dashed ? 'mid' : 'grid'}" x1="${PAD_L}" y1="${y(g.at).toFixed(1)}" ` +
      `x2="${W - PAD_R}" y2="${y(g.at).toFixed(1)}"/>` +
      `<text x="${W - PAD_R + 4}" y="${(y(g.at) + 3).toFixed(1)}">${g.label}</text>`
    ).join('');

    // Optional smoothed line over the bars, one value per bar (null = gap).
    const ov = cfg.overlay && cfg.overlay.values;
    const cx = (i) => barX(i) + barW / 2;
    const line = ov && ov.some((v) => v != null)
      ? `<polyline class="ma" fill="none" points="${ov.map((v, i) =>
          v == null ? null : `${cx(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' ')}"/>
         <circle class="ma-dot" r="3" opacity="0"/>`
      : '';

    const labels = pts.map((p, i) => {
      const text = cfg.xLabel ? cfg.xLabel(p, i, pts) : '';
      if (!text) return '';
      return `<text x="${(PAD_L + i * step + step / 2).toFixed(1)}" y="${H - 4}" ` +
             `text-anchor="middle">${text}</text>`;
    }).join('');

    host.innerHTML =
      `<div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${cfg.aria}">
        ${guides}${bars}${line}${labels}
        <rect class="cursor" x="0" y="${PAD_T}" width="${barW.toFixed(2)}" height="${plotH}"
              fill="currentColor" opacity="0" pointer-events="none"/>
      </svg></div>
      <div class="readout"><span class="ro-l"></span><b class="ro-r"></b></div>
      ${cfg.note ? `<p class="legend">${cfg.note}</p>` : ''}`;

    const svg = host.querySelector('svg');
    const cursor = host.querySelector('.cursor');
    const left = host.querySelector('.ro-l');
    const right = host.querySelector('.ro-r');

    const dot = host.querySelector('.ma-dot');
    const select = (i) => {
      const [l, r, colour] = cfg.readout(pts[i], i);
      left.textContent = l;
      right.textContent = r;
      right.style.color = colour || pts[i].color;
      cursor.setAttribute('x', barX(i).toFixed(2));
      cursor.setAttribute('opacity', '0.12');
      if (dot) {
        const v = ov[i];
        dot.setAttribute('opacity', v == null ? '0' : '1');
        if (v != null) { dot.setAttribute('cx', cx(i).toFixed(1)); dot.setAttribute('cy', y(v).toFixed(1)); }
      }
    };
    select(cfg.initial ?? pts.length - 1);

    const pick = (event) => {
      const box = svg.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width * W;
      const i = Math.round((x - PAD_L - step / 2) / step);
      if (i >= 0 && i < pts.length) select(i);
    };
    svg.addEventListener('pointerdown', pick);
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') pick(e); });
  }

  /* A money chart, kept deliberately separate from barChart: bars in this app
     always mean a cross-sectional score, a line always means value compounding.
     Two series share one cursor so the comparison is read in a single gesture.
     The axis is linear — over four years and under a doubling, a log axis would
     buy accuracy nobody can see. */
  function lineChart(host, cfg) {
    const W = 340, H = cfg.height || 160, PAD_L = 6, PAD_R = 34, PAD_B = 16, PAD_T = 8;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_B - PAD_T;
    const all = cfg.series.flatMap((se) => se.values);
    const lo = Math.min(...all), hi = Math.max(...all);
    const span = (hi - lo) || 1;
    const n = cfg.series[0].values.length;
    const x = (i) => PAD_L + (i / (n - 1)) * plotW;
    const y = (v) => PAD_T + plotH * (1 - (v - lo) / span);

    const guides = (cfg.guides || []).map((g) =>
      `<line class="${g.dashed ? 'mid' : 'grid'}" x1="${PAD_L}" y1="${y(g.at).toFixed(1)}" ` +
      `x2="${W - PAD_R}" y2="${y(g.at).toFixed(1)}"/>` +
      `<text x="${W - PAD_R + 4}" y="${(y(g.at) + 3).toFixed(1)}">${g.label}</text>`
    ).join('');

    const lines = cfg.series.map((se) =>
      `<polyline class="ln ${se.cls}" points="${se.values.map((v, i) =>
        `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
    const dots = cfg.series.map((se) => `<circle class="ln-dot ${se.cls}" r="3.2"/>`).join('');

    const labels = (cfg.xLabels || []).map(({ at, text }) =>
      `<text x="${x(at).toFixed(1)}" y="${H - 4}" text-anchor="middle">${text}</text>`).join('');

    host.innerHTML =
      `<div class="chartwrap"><svg class="chart line" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="${cfg.aria}">
        ${guides}${lines}
        <line class="vcursor" y1="${PAD_T}" y2="${PAD_T + plotH}" opacity="0"/>
        ${dots}${labels}
      </svg></div>
      <div class="readout"><span class="ro-l"></span><b class="ro-r"></b></div>
      ${cfg.legend === false ? '' : `<p class="legend key">${cfg.series.map((se) =>
        `<i class="swatch ${se.cls}"></i>${se.label}`).join(' ')}</p>`}
      ${cfg.note ? `<p class="legend">${cfg.note}</p>` : ''}`;

    const svg = host.querySelector('svg');
    const cursor = svg.querySelector('.vcursor');
    const marks = [...svg.querySelectorAll('.ln-dot')];
    const left = host.querySelector('.ro-l');
    const right = host.querySelector('.ro-r');

    const select = (i) => {
      const [l, r] = cfg.readout(i);
      left.innerHTML = l;
      right.innerHTML = r;
      cursor.setAttribute('x1', x(i).toFixed(1));
      cursor.setAttribute('x2', x(i).toFixed(1));
      cursor.setAttribute('opacity', '0.35');
      marks.forEach((dot, k) => {
        dot.setAttribute('cx', x(i).toFixed(1));
        dot.setAttribute('cy', y(cfg.series[k].values[i]).toFixed(1));
        dot.setAttribute('opacity', '1');
      });
    };
    select(n - 1);

    const pick = (event) => {
      const box = svg.getBoundingClientRect();
      const px = (event.clientX - box.left) / box.width * W;
      const i = Math.round(((px - PAD_L) / plotW) * (n - 1));
      if (i >= 0 && i < n) select(i);
    };
    svg.addEventListener('pointerdown', pick);
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') pick(e); });
  }

  function renderTickerChart(r, key) {
    const host = $('chart');
    const grain = state.grain;
    host.innerHTML = '<p class="legend">Loading history…</p>';
    loadHistory(key, grain).then((h) => {
      if (location.hash !== `#/t/${r.symbol}` || state.grain !== grain) return;
      drawChart(host, h, r, key, grain);
    });
  }

  /* Per-ticker score history: fixed 0-100 domain, 50 marks the peer-set median. */
  function drawChart(host, history, r, key, grain) {
    const series = history && history.scores[r.symbol];
    // Bars from before the name joined this universe: scored as an outsider
    // against that day's members, so the chart still shows its trajectory.
    const outside = new Set((history && history.outside && history.outside[r.symbol]) || []);
    const points = (series || [])
      .map((value, i) => ({ value, date: history.dates[i], pre: outside.has(i) }))
      .filter((p) => p.value != null)
      .map((p) => ({ ...p, color: tone(p.value), opacity: p.pre ? 0.38 : null }));
    const joined = points.find((p) => !p.pre);
    const joinedNote = joined && points.some((p) => p.pre)
      ? ` Dimmed bars are from before ${r.symbol} joined ${UNIVERSE.label}
         (${fmtDate(joined.date)}) and show where it would have ranked against that day's members.`
      : '';
    if (!points.length) {
      host.innerHTML = '<p class="legend">No score history for this name yet.</p>';
      return;
    }
    // Trailing 4-period simple average: 4 weeks or 4 months depending on the
    // interval. Smooths the week-to-week noise without lagging so far that a
    // turn only shows up after it's over.
    const MA = 4;
    const avg = points.map((_, i) => i < MA - 1 ? null
      : points.slice(i - MA + 1, i + 1).reduce((t, p) => t + p.value, 0) / MA);
    const unit = grain === 'w' ? 'wk' : 'mo';
    barChart(host, {
      points, min: 0, max: 100, baseline: 0,
      overlay: { values: avg },
      guides: [{ at: 100, label: '100' }, { at: 50, label: '50', dashed: true }, { at: 0, label: '0' }],
      xLabel: grain === 'w' ? weeklyLabel : (p, i, all) =>
        i === 0 || p.date.slice(0, 4) !== all[i - 1].date.slice(0, 4) ? p.date.slice(0, 4) : '',
      aria: `Blended momentum score for ${r.symbol} over ${points.length} ` +
            `${grain === 'w' ? 'weeks' : 'months'}`,
      readout: (p, i) => [
        (grain === 'w' ? 'week ending ' : '') + fmtDate(p.date) +
          (avg[i] == null ? '' : ` · ${MA}-${unit} avg ${avg[i].toFixed(1)}`) +
          (p.pre ? ' · not yet a member' : ''),
        p.value.toFixed(1),
      ],
      note: `Each bar re-ranks ${r.symbol} against ${key[0] === 's'
               ? `other ${r.sector} names`
               : `all of ${UNIVERSE.label}`} at that
             ${grain === 'w' ? 'week' : 'month'} end, using the membership that was live on the day.
             Above the dashed line means the better half of that peer set. The line is the trailing
             ${MA}-${grain === 'w' ? 'week' : 'month'} average.${joinedNote}`,
    });
  }

  /* 78 weekly bars is too many to label every month: mark each quarter, and the
     year where it turns over. */
  function weeklyLabel(p, i, all) {
    if (i === 0) return p.date.slice(0, 4);
    if (i < 6) return '';                       // don't crowd the origin label
    const prev = all[i - 1].date;
    if (p.date.slice(0, 4) !== prev.slice(0, 4)) return p.date.slice(0, 4);
    const month = +p.date.slice(5, 7);
    return month !== +prev.slice(5, 7) && (month - 1) % 3 === 0 ? MONTHS[month - 1] : '';
  }

  /* ---------- evidence ---------- */
  function showEvidence() {
    showView('evidence-view');
    scrollTo(0, 0);
    const el = $('evidence-view');
    if (!el.dataset.ready) {
      el.innerHTML = '<div class="dtop"><button class="back" id="eback">‹ Back</button>' +
        '<span class="grow"><b>Top 10% vs all ranked</b><small>loading…</small></span></div>';
      el.querySelector('#eback').addEventListener('click', goBack);
    }
    Promise.all([loadBacktest(), loadPortfolio()]).then(([bt, pf]) => {
      if (location.hash !== '#/evidence') return;
      if (!bt) {
        el.querySelector('.grow small').textContent = 'backtest data unavailable';
        return;
      }
      renderEvidence(el, bt, pf);
    });
  }

  const decileOf = (rank, n) => Math.min(10, Math.floor((rank - 1) / (n / 10)) + 1);
  const goBack = () => (listBehind ? history.back() : (location.hash = ''));

  /* ---------- price chart ----------
     A full-screen, non-scrolling view: every drag on it is a chart gesture.
     The drawing and the gestures live in chart.js, which knows nothing about
     the app; this only fetches the bars and frames them. */
  function showChart(r) {
    const fromDetail = !$('detail-view').hidden;
    showView('chart-view');
    const el = $('chart-view');
    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="cback">‹ Back</button>
        <span class="grow"><b>${r.symbol}</b><small>${esc(r.name)}</small></span>
        <span class="cpx" id="cpx"></span>
      </div>
      <canvas id="price-chart" aria-label="Daily price bars for ${r.symbol} with a 200-day regression channel"></canvas>
      <p class="hint" id="chint">Drag to pan · pinch to zoom · drag the price axis to stretch · double-tap it to reset</p>`;
    $('cback').addEventListener('click', () => (fromDetail ? history.back() : (location.hash = `#/t/${r.symbol}`)));
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
      priceChart($('price-chart'), bars);
      setTimeout(() => { const h = $('chint'); if (h) h.style.opacity = 0; }, 6000);
    });
  }

  /* One fetch per symbol per session. A missing file resolves to null, so a
     name published before its bars were means an empty chart, not a broken one. */
  function loadBars(symbol) {
    state.bars = state.bars || new Map();
    if (!state.bars.has(symbol)) {
      state.bars.set(symbol, fetch(`data/bars/${symbol}.json`, { cache: 'no-cache' })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch(() => null));
    }
    return state.bars.get(symbol);
  }
  const months = (h) => (h === '1' ? '1 month' : `${h} months`);
  const monthsAdj = (h) => `${h}-month`;              // adjectival: "6-month return"

  /* The page is built for a sceptic. The chart and the two line definitions
     come first; the construction — every parameter the pipeline actually ran
     with, read from portfolio.json rather than retyped here — comes second and
     stays visible; everything else is folded. Nothing on the page asks the
     reader to infer a method from a label. */
  const fold = (key, title, body) =>
    `<details class="card fold" data-fold="${key}"${state.folds.has(key) ? ' open' : ''}>
       <summary><h3>${title}</h3></summary><div class="fold-body">${body}</div></details>`;

  function renderEvidence(el, bt, pf) {
    const h = state.horizon;
    const H = bt.variants[state.adjust].horizons[h];
    const sp = H.spread;
    const v = pf && pf.method && pf.variants[perfKey()];
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="eback">‹ Back</button>
        <span class="grow"><b>${v ? 'Top 10% vs all ranked' : 'Forward returns by decile'}</b>
          <small>${v
            ? `${fmtDate(pf.from)} – ${fmtDate(pf.to)} · ${pf.rebalances} monthly rebalances`
            : `${bt.rankingDates} month ends · ${fmtDate(bt.from)} – ${fmtDate(bt.to)}`}</small></span>
      </div>
      ${v ? chartCard(v, pf) + methodCard(v, pf) + resultsCard(v, pf) : ''}
      ${v ? fold('conc', 'Sector concentration of the top 10%', concentrationBody(v)) : ''}
      ${fold('decile', 'A second test: forward returns by decile', decileBody(bt, sp, h))}
      ${fold('caveats', 'Read this before using it', caveatsBody(sp, h))}
      <footer class="foot"><p>A percentile is a rank against peers, not a return forecast.
        Past behaviour of a basket is not a prediction for any holding in it.</p></footer>`;

    el.querySelector('#eback').addEventListener('click', goBack);
    for (const d of el.querySelectorAll('details[data-fold]')) {
      d.addEventListener('toggle', () => {
        if (d.open) state.folds.add(d.dataset.fold); else state.folds.delete(d.dataset.fold);
      });
    }
    el.querySelector('#hsel').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-h]');
      if (!tab || tab.dataset.h === state.horizon) return;
      state.horizon = tab.dataset.h;
      renderEvidence(el, bt, pf);
    });

    if (v) drawPortfolio(el.querySelector('#perf-chart'), v, pf);
    if (v) drawConcentration(el.querySelector('#conc-chart'), v);
    drawDeciles(el.querySelector('#decile-chart'), H, h);
    drawSpread(el.querySelector('#spread-chart'), sp, h);
  }

  const range = (r) => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);

  /* The chart, and directly under it the one-line definition of each line.
     Everything a reader needs to say what the two lines are, before any number. */
  function chartCard(v, pf) {
    const m = pf.method;
    return `
      <div class="card prime">
        <div id="perf-chart"></div>
        <ul class="lines">
          <li><i class="swatch top"></i><b>Top 10%</b> — the ${range(m.held)} highest-scored names
            at each month end, equal weight, held until the next month end.</li>
          <li><i class="swatch all"></i><b>All ranked</b> — every name that was ranked that month
            end (${range(m.ranked)}), equal weight, held the same way.</li>
        </ul>
      </div>`;
  }

  /* Every choice that decides the plotted values, in the order a reader would
     need them to rebuild the lines. Numbers come from pf.method — what the run
     used — not from this file. */
  function methodCard(v, pf) {
    const m = pf.method;
    const vol = state.adjust === 'vol';
    const w = m.weights;
    const rows = [
      ['Universe', `On each rebalance date: every S&amp;P MidCap 400 member that day, plus the
        ${m.sizeTail} S&amp;P 500 members with the smallest market cap that day (latest cap on or
        before the date). Membership is rebuilt from each index's change log.`],
      ['Score', `From adjusted closes, two returns per name: from ${m.longDays} to ${m.skipDays}
        trading days before the date (12–1) and from ${m.midDays} to ${m.skipDays} (6–1).${vol
          ? ` Each is divided by the annualised standard deviation of the name's daily log returns
              over that same window.` : ''}
        Each is converted to a 0–100 percentile across all ranked names, ties sharing their average
        rank. Score = ${w[0]} × 12–1 percentile + ${w[1]} × 6–1 percentile.
        <span class="setting">Ranked on ${RANKED_ON[state.adjust]} — set in Settings.</span>`],
      ['Who is ranked', `A name needs at least ${m.minObsLong} daily returns inside its 12–1 window
        and ${m.minObsMid} inside its 6–1 window. Names that fall short are in neither line. Call
        the number that qualify N: ${range(m.ranked)} here.`],
      ['When', `The last trading day of each complete month, ${pf.rebalances} times:
        ${fmtDate(m.firstRebalance)} to ${fmtDate(m.lastRebalance)}. Each basket is held until the
        next rebalance; the last is held to ${fmtDate(pf.to)}.`],
      ['Top 10% line', `The N ÷ ${m.deciles} highest scores, rounded down (${range(m.held)} names),
        ties broken by ticker A–Z. Equal weight. Each name is bought at its last adjusted close on
        or before the rebalance date and held untouched until the next one.`],
      ['All ranked line', `All N ranked names that month, equal weight, bought and held the same
        way.`],
      ['Value', `100 on ${fmtDate(pf.from)}. On each trading day, the holdings summed at that
        day's adjusted close. Adjusted closes carry dividends and splits, so dividends are
        reinvested. No costs, spreads or tax.`],
    ];
    const edge = [
      `A name that stops trading keeps its last value until the next rebalance, then drops out.`,
      `A name with no bar on a day keeps the previous day's value.`,
      `A name with no adjusted close on or before a rebalance date is left out of that basket;
        the rest share its weight.`,
      `A month with fewer than ${m.minScored} ranked names is skipped. ${m.skippedMonths === 0
        ? 'None were.' : `${m.skippedMonths} were.`}`,
      `A name needs at least ${m.minPriceBars} daily closes from the price vendor to be in the
        universe at all. ${m.unpriced.length} names in the index change logs have none.
        ${m.unpriced.length - m.unpricedInWindow.length - m.unpricedPossibleTail.length} left
        their index before this window began and cannot affect either line.
        ${m.unpricedInWindow.length ? `<b>${m.unpricedInWindow.join(', ')}</b> were MidCap 400
        members on rebalance dates in this window and are missing from both lines.` : ''}
        ${m.unpricedPossibleTail.length ? `${m.unpricedPossibleTail.join(', ')} were S&amp;P 500
        members in the window and are missing only if they were small enough for the tail.` : ''}
        Both lines carry survivorship bias to that extent.`,
      `The final holding period, ${fmtDate(m.lastRebalance)} to ${fmtDate(pf.to)}, is not a full
        month.`,
      `Plotted values are stored to 0.01. The statistics below use the unrounded series.`,
      `Prices: ${esc(m.priceSource)}. Market caps: ${esc(m.capSource)}.`,
    ];
    return `
      <div class="card">
        <h3>How each line is built</h3>
        <dl class="build">${rows.map(([k, t]) => `<dt>${k}</dt><dd>${t}</dd>`).join('')}</dl>
        <details class="edge"${state.folds.has('edge') ? ' open' : ''} data-fold="edge">
          <summary>Edge cases that affect the result</summary>
          <ul>${edge.map((t) => `<li>${t}</li>`).join('')}</ul>
        </details>
      </div>`;
  }

  /* Secondary by design: the outcome, each figure beside the same figure for
     the other line, and a sentence written from the numbers. */
  function resultsCard(v, pf) {
    const t = v.topStats, a = v.allStats;
    const tile = (label, mine, theirs, sign) => `
      <div><dt>${label}</dt>
        <dd class="${sign ? cls(mine) : ''}">${(sign ? spct : pct)(mine)}</dd>
        <dd class="vs">all ranked ${(sign ? spct : pct)(theirs)}</dd></div>`;
    return `
      <div class="card secondary">
        <h3>Result</h3>
        <dl class="stats trio compare">
          ${tile('Growth per year', t.cagr, a.cagr, true)}
          ${tile('Volatility', t.vol, a.vol, false)}
          ${tile('Max drawdown', t.maxDrawdown, a.maxDrawdown, true)}
        </dl>
        <p class="legend">Growth per year = compound annual growth rate of the line.
          Volatility = standard deviation of daily changes × √${Math.round(pf.method.tradingDaysPerYear)}.
          Max drawdown = largest fall from a previous high, on daily values.</p>
        <p class="legend verdict">${verdict(v)}</p>
        <details class="edge"${state.folds.has('years') ? ' open' : ''} data-fold="years">
          <summary>Year by year</summary>
          <table class="peers years">
            <tr><th>Year</th><th>Top 10%</th><th>All ranked</th></tr>
            ${t.byYear.map((row, i) => `<tr>
              <td>${row.year}${row.n < 200 ? ' <i>part</i>' : ''}</td>
              <td class="${cls(row.ret)}">${spct(row.ret)}</td>
              <td>${spct(a.byYear[i].ret)}</td></tr>`).join('')}
          </table>
        </details>
      </div>`;
  }

  function decileBody(bt, sp, h) {
    return `
      <p class="legend">A different test from the chart above: at each of ${bt.rankingDates} month
        ends (${fmtDate(bt.from)} – ${fmtDate(bt.to)}) every ranked name is put into one of ten
        equal groups by score, and each group's mean return over the following
        ${months(h)} is measured. Same universe and score as the chart.</p>
      <div class="hero">
        <span class="big" style="color:${tone(sp.mean > 0 ? 82 : 18)}">${signed(sp.mean * 100, 1)}%</span>
        <span class="lbl">top 10% minus bottom 10%<b>mean over ${months(h)}</b></span>
      </div>
      <div class="ctrl">
        <div class="segmented" id="hsel" role="tablist" aria-label="Forward-return horizon">
          ${['1', '3', '6'].map((k) => `<button role="tab" data-h="${k}"
            class="${k === h ? 'on' : ''}" aria-selected="${k === h}">${months(k)}</button>`).join('')}
        </div>
      </div>
      <h4>Forward return by group</h4>
      <div id="decile-chart"></div>
      <h4>Top minus bottom, month by month</h4>
      <dl class="stats trio">
        <div><dt>Mean spread</dt><dd class="${cls(sp.mean)}">${signed(sp.mean * 100, 2)}%</dd></div>
        <div><dt>Hit rate</dt><dd>${(sp.hitRate * 100).toFixed(0)}%</dd></div>
        <div><dt>t-stat</dt><dd>${sp.tIndependent.toFixed(2)}</dd></div>
      </dl>
      <div id="spread-chart"></div>`;
  }

  function caveatsBody(sp, h) {
    return `
      <ul class="caveats">
        <li><b>The obvious t-stat is wrong.</b> Sampling ${monthsAdj(h)} returns every month makes the
          windows overlap. Naive t is ${sp.tNaive.toFixed(2)}; corrected it is
          ${sp.tNeweyWest.toFixed(2)} (Newey–West), or ${sp.tIndependent.toFixed(2)} across the
          ${sp.nIndependent} genuinely independent window${sp.nIndependent === 1 ? '' : 's'}.
          A mean is not a proven edge.</li>
        <li><b>One regime.</b> A few years of a mostly rising market. Momentum is known to work in
          trends and break at reversals; this sample contains no reversal.</li>
        <li><b>It is decaying.</b> Spread by ranking-date year —
          ${sp.byYear.map((y) => `${y.year} ${signed(y.mean * 100, 1)}%` +
            (y.n < 6 ? ` <i>(only ${y.n})</i>` : '')).join(' · ')}.</li>
        <li><b>Scope.</b> Both tests rank across the whole universe on ${RANKED_ON[state.adjust]}.
          The within-sector basis on the list is a different signal and is not tested.</li>
        <li><b>Not modelled.</b> Costs, spreads, tax, and the price impact of trading
          ${range((state.portfolio && state.portfolio.method || { held: { min: '?', max: '?' } }).held)}
          names at once.</li>
      </ul>`;
  }

  /* How many sectors the decile is really spread across, month by month.
     A momentum screen has no diversification rule, so its top decile drifts
     toward whatever is working; when that drift goes far enough the sleeve
     stops being a momentum bet and becomes a sector bet, which is the way a
     single sector unwinding takes the whole thing down at once. Bars, not a
     line: each one is a reading taken on a rebalance date, the same thing
     every other bar chart in this app means. */
  function concentrationBody(v) {
    const c = v.concentration, now = c.now, universe = c.nowAll;
    return `
        <p class="legend">Sectors are today's GICS sector for each name, applied to every past
          basket. Weight = share of the basket's names.</p>
        <div id="conc-chart"></div>
        <table class="peers years mix">
          <tr><th>Latest top 10%</th><th>Names</th><th>Weight</th></tr>
          ${now.weights.slice(0, 5).map((w) => `<tr>
            <td>${esc(w.sector)}</td>
            <td class="n">${Math.round(w.w * now.count)}</td>
            <td>${pct(w.w, 0)}</td></tr>`).join('')}
          ${now.weights.length > 5 ? `<tr class="rest"><td>${now.weights.length - 5} smaller
            sector${now.weights.length - 5 === 1 ? '' : 's'}</td><td class="n">—</td>
            <td>${pct(now.weights.slice(5).reduce((t, w) => t + w.w, 0), 0)}</td></tr>` : ''}
        </table>
        <p class="legend">Sector Herfindahl: square each sector's share of the basket and add them
          up, then invert it. ${pct(now.topWeight, 0)} of the decile sits in ${esc(now.top)}, which
          works out at <b>${now.effective.toFixed(1)} equally sized sectors</b> against
          ${universe.effective.toFixed(1)} for all ranked names. Concentration is not a fault —
          it is the ranking finding something — but it is the number to look at before deciding how
          much of a portfolio this sleeve should be.</p>`;
  }

  function drawConcentration(host, v) {
    const rows = v.concentration.series;
    const ceiling = v.concentration.nowAll.sectors;
    const points = rows.map((r) => ({
      ...r, value: r.effective, color: tone((r.effective / ceiling) * 100),
    }));
    const universe = rows.map((r) => r.all);
    const top = Math.max(...points.map((p) => p.value), ...universe) * 1.08;
    barChart(host, {
      points, min: 0, max: top, baseline: 0, barRatio: 0.7, padAxis: 22, height: 140,
      overlay: { values: universe },
      guides: [{ at: top, label: top.toFixed(0) }, { at: 1, label: '1' }],
      xLabel: (p, i, all) =>
        i === 0 || p.date.slice(0, 4) !== all[i - 1].date.slice(0, 4) ? p.date.slice(0, 4) : '',
      aria: 'Effective number of sectors in the top 10% at each monthly rebalance',
      readout: (p) => [
        `${fmtDate(p.date)} · ${pct(p.topWeight, 0)} ${esc(p.top)}`,
        `${p.effective.toFixed(1)} sectors`,
      ],
      note: `Effective sectors in the top 10% at each rebalance. The line is the same measure for
             all ranked names — the gap between them is the concentration the ranking itself adds.
             Lower means fewer, bigger sector bets.`,
    });
  }

  /* Written from the numbers rather than fixed in the markup, so a refresh that
     turns the finding around cannot leave a stale claim on the page. */
  function verdict(v) {
    const t = v.topStats, a = v.allStats, b = v.bottomStats;
    const excess = t.cagr - a.cagr;
    const won = t.byYear.filter((y, i) => y.ret > a.byYear[i].ret).length;
    const lead = excess > 0
      ? `The top 10% beat all ranked names, equally weighted, by ${spct(excess, 1)} a year`
      : `The top 10% did not beat all ranked names, equally weighted: ${spct(excess, 1)} a year`;
    return `${lead}, ${t.vol > a.vol ? 'with more risk' : 'with less risk'} —
      ${pct(t.vol)} volatility against ${pct(a.vol)}, max drawdown ${spct(t.maxDrawdown)} against
      ${spct(a.maxDrawdown)}. It was ahead in ${won} of ${t.byYear.length} calendar years. The
      bottom 10%, built the same way, returned ${spct(b.cagr, 1)} a year.`;
  }

  function drawPortfolio(host, v, pf) {
    // Every daily value is drawn. A decimated line would show a shallower
    // drawdown than the statistic computed on the full series, and a reader
    // checking a plotted value against the data should find exactly that value.
    const dates = pf.dates.slice(0, v.top.length);
    const top = v.top, all = v.all;
    const hi = Math.max(...top, ...all), lo = Math.min(...top, ...all);
    const marks = [];
    dates.forEach((d, i) => {
      if (i && d.slice(0, 4) !== dates[i - 1].slice(0, 4)) marks.push({ at: i, text: d.slice(0, 4) });
    });
    lineChart(host, {
      height: 200, legend: false,
      series: [
        { values: top, cls: 'top', label: 'Top 10%' },
        { values: all, cls: 'all', label: 'All ranked' },
      ],
      guides: [
        { at: 100, label: '100', dashed: true },
        ...[125, 150, 175, 200, 225, 250, 300].filter((t) => t > lo && t < hi - 6)
          .map((t) => ({ at: t, label: String(t) })),
        { at: hi, label: hi.toFixed(0) },
        ...(lo < 95 ? [{ at: lo, label: lo.toFixed(0) }] : []),
      ],
      xLabels: marks,
      aria: 'Value of 100 held in the top 10% by score against 100 held in all ranked names, daily',
      readout: (i) => [
        `${fmtDate(dates[i])}`,
        `<i class="swatch top"></i>${top[i].toFixed(2)} <i class="swatch all"></i>${all[i].toFixed(2)}`,
      ],
    });
  }

  /* Deciles keep the list's colour ramp: D1 wears the same green as a 100 score. */
  function drawDeciles(host, H, h) {
    const points = H.deciles.map((d, i) => ({
      ...d, value: d.mean, color: tone(100 - (i * 100) / 9),
    }));
    const values = points.map((p) => p.value);
    const top = Math.max(...values, 0) * 1.1;
    barChart(host, {
      points, min: Math.min(...values, 0) * 1.15, max: top, baseline: 0, barRatio: 0.74, padAxis: 30,
      guides: [{ at: 0, label: '0%' }, { at: top, label: (top * 100).toFixed(0) + '%' }],
      xLabel: (p, i) => (i === 0 ? 'D1' : i === 9 ? 'D10' : ''),
      aria: `Mean ${monthsAdj(h)} forward return for each momentum decile`,
      readout: (p, i) => [
        `D${p.decile}${i === 0 ? ' (top)' : i === 9 ? ' (bottom)' : ''} · positive in ` +
        `${(p.winRate * 100).toFixed(0)}% of months`,
        signed(p.mean * 100, 2) + '%',
      ],
      initial: 0,
      note: `Mean ${monthsAdj(h)} return of an equal-weighted basket of each decile, rebalanced at
             every month end. The ordering matters more than any single bar.`,
    });
  }

  function drawSpread(host, sp, h) {
    const points = sp.series.map((p) => ({
      ...p, value: p.spread, color: tone(p.spread > 0 ? 82 : 18),
    }));
    const values = points.map((p) => p.value);
    const hi = Math.max(...values, 0), lo = Math.min(...values, 0);
    barChart(host, {
      points, min: lo * 1.1, max: hi * 1.1, baseline: 0, padAxis: 30,
      guides: [
        { at: hi, label: (hi * 100).toFixed(0) + '%' },
        { at: 0, label: '0', dashed: true },
        { at: lo, label: (lo * 100).toFixed(0) + '%' },
      ],
      xLabel: (p, i, all) =>
        i === 0 || p.date.slice(0, 4) !== all[i - 1].date.slice(0, 4) ? p.date.slice(0, 4) : '',
      aria: `Top-minus-bottom decile spread over ${monthsAdj(h)} windows, by ranking date`,
      readout: (p) => [`ranked ${fmtDate(p.date)}`, signed(p.spread * 100, 1) + '%'],
      note: `Each bar is one ranking date: what the top decile made minus the bottom decile over the
             following ${months(h)}. Bars below the line are months the ranking got it backwards.`,
    });
  }
})();
