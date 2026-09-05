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
     sector) and `adjust` (the return, the return over its own volatility, or
     the return net of the market). All six combinations ship in latest.json,
     keyed w/s + r/v/m. */
  const UNIVERSE = { label: 'MidCap 650', size: '650' };
  const ADJ = { raw: 'r', vol: 'v', resid: 'm' };
  const keyFor = (basis, adjust) =>
    (basis === 'sector' ? 's' : 'w') + (ADJ[adjust] || 'r');

  const state = {
    rows: [],
    meta: null,
    watch: loadWatch(),
    scope: 'all',
    sectors: loadSectors(),
    sort: 'score',
    view: [],
    shown: 0,
    basis: (() => {
      try { return localStorage.getItem(BASIS_KEY) === 'sector' ? 'sector' : 'whole'; }
      catch { return 'whole'; }
    })(),
    /* Default is the return itself. The other two are real choices about what
       "momentum" means, not details, so they are opt-in. */
    adjust: (() => {
      try { const v = localStorage.getItem(ADJUST_KEY); return v in ADJ ? v : 'raw'; }
      catch { return 'raw'; }
    })(),
    grain: (() => {
      try { return localStorage.getItem(GRAIN_KEY) === 'w' ? 'w' : 'm'; } catch { return 'm'; }
    })(),
  };

  const peerKey = () => keyFor(state.basis, state.adjust);
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
  const ADJUST_NOTE = {
    raw: 'The return itself over each formation window. The simplest reading, and the one the '
      + 'published tests use by default.',
    vol: 'The return divided by the annualised standard deviation of its own window, so a steady '
      + 'climb outranks an equally large but erratic one. Historically a calmer ride at a similar '
      + 'return.',
    resid: 'The part of the return the market does not explain: each name\'s daily moves are '
      + 'regressed on the equal-weight universe over the window, and only what is left over is '
      + 'ranked. Stops rewarding names that merely rode the market.',
  };

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
  /* One strip file per peer set: the list only ever draws the active one, and
     eight sets in one payload would be seven wasted downloads. */
  const loadSpark = () => loadJSON(`data/spark/${peerKey()}.json`, `spark_${peerKey()}`);

  /* ---------- boot ---------- */
  Promise.all([
    fetch('data/latest.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    loadSpark(),      // optional: rows still render without their strips
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

  function syncControls() {
    $('basis').checked = sectorBasis();
    for (const b of $('adjust-seg').querySelectorAll('button')) {
      const on = b.dataset.adjust === state.adjust;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    }
    $('adjust-note').textContent = ADJUST_NOTE[state.adjust];
  }

  /* Everything that has to happen when the peer set changes, in one place so no
     control can forget a step. The strips live in a per-set file, so rows are
     redrawn once now on whatever is cached and again when the new file lands. */
  function peerSetChanged() {
    syncControls();
    fillSectors();
    applyFilters();
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
      ...(state.adjust === 'resid' ? [['Market stripped out', 'Over that same window each name\'s '
        + 'daily log returns are regressed on the equal-weight average of every priced name. The '
        + 'leg becomes the return that regression leaves unexplained — the name\'s own move, net of '
        + 'its beta times the market\'s.']] : []),
      ['Cross-sectional percentile', `Each ${state.adjust === 'raw' ? '' : 'adjusted '}leg is ranked against `
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
    let out = state.rows;
    if (state.scope === 'watch') out = out.filter((r) => state.watch.has(r.symbol));
    if (state.sectors.size) out = out.filter((r) => state.sectors.has(r.sector));

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
    $('basis').addEventListener('change', (e) => {
      state.basis = e.target.checked ? 'sector' : 'whole';
      try { localStorage.setItem(BASIS_KEY, state.basis); } catch { /* private mode */ }
      peerSetChanged();
    });
    $('adjust-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-adjust]');
      if (!b || b.dataset.adjust === state.adjust) return;
      state.adjust = b.dataset.adjust;
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
        <span class="tag">Decile ${decileOf(p.k, p.n)}</span>
      </div>

      <a class="card go" href="#/t/${r.symbol}/chart"><b>Price chart →</b>
        <small>Daily bars with a 200-day regression channel. Drag to pan, pinch to zoom,
          drag the price axis to stretch it.</small></a>

      <div class="card">
        <h3>Momentum legs</h3>
        ${leg('12–1', '12 months, last month skipped', p.p12, r.m12, r.va12, r.rm12)}
        ${leg('6–1', '6 months, last month skipped', p.p6, r.m6, r.va6, r.rm6)}
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

  /* One momentum leg: percentile, then the three things a leg can measure.
     The one the active setting ranks on is marked. */
  function leg(title, note, percentile, raw, adjusted, resid) {
    const on = (k) => state.adjust === k ? ' class="on"' : '';
    return `<div class="leg">
      <h4>${title}<small>${note}</small></h4>
      <dl class="stats quad">
        <div><dt>Percentile</dt><dd style="color:${tone(percentile)}">${num(percentile)}</dd></div>
        <div${on('raw')}><dt>Return</dt><dd class="${cls(raw)}">${pct(raw)}</dd></div>
        <div${on('vol')}><dt>÷ Volatility</dt><dd class="${cls(adjusted)}">${signed(adjusted, 2)}</dd></div>
        <div${on('resid')}><dt>Net of market</dt><dd class="${cls(resid)}">${resid == null ? '—' : spct(resid)}</dd></div>
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

  /* ---------- shared bits of the detail and chart views ---------- */
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
})();
