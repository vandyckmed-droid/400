/* MidCap 400 Momentum — vanilla, no dependencies.
   Data is pre-computed by scripts/build.py and served as static JSON. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE = 60;                         // rows appended per scroll chunk
  const WATCH_KEY = 'sp400.watchlist.v1';
  const UNIVERSE_KEY = 'sp400.universe.v1';
  const BASIS_KEY = 'sp400.basis.v1';
  const ADJUST_KEY = 'sp400.adjust.v1';
  const GRAIN_KEY = 'sp400.grain.v1';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Three independent axes, deliberately not merged into one control:
     `universe` is a mode you set once and the whole app then lives in, while
     `basis` (whole or sector) and `adjust` (the return, or the return over its
     own volatility) are ways of looking at whichever universe you chose. Data
     for all eight combinations ships in latest.json, keyed c/e + w/s + r/v. */
  const UNIVERSES = {
    core: { label: 'MidCap 400', size: '400' },
    ext: { label: 'MidCap 650', size: '650' },
  };
  const keyFor = (universe, basis, adjust) =>
    (universe === 'core' ? 'c' : 'e') +
    (basis === 'sector' ? 's' : 'w') +
    (adjust === 'vol' ? 'v' : 'r');

  const state = {
    rows: [],
    meta: null,
    history: null,
    historyPromise: null,
    watch: loadWatch(),
    scope: 'all',
    sector: '',
    sort: 'score',
    query: '',
    view: [],
    shown: 0,
    backtest: null,
    backtestPromise: null,
    horizon: '6',
    universe: (() => {
      try { return localStorage.getItem(UNIVERSE_KEY) === 'ext' ? 'ext' : 'core'; }
      catch { return 'core'; }
    })(),
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

  const peerKey = () => keyFor(state.universe, state.basis, state.adjust);
  /* The portfolio curves cover whole-universe rankings only, so a reader on the
     within-sector basis still sees the whole-universe record, labelled. */
  const perfKey = () => keyFor(state.universe, 'whole', state.adjust);
  const volAdjusted = () => state.adjust === 'vol';

  /* This row's placement in the active peer set, or undefined if it isn't a
     member (an S&P 500 tail name while the MidCap 400 universe is selected). */
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
      // The refresh job is weekly and silent; stale data is its worst failure
      // mode, so say so rather than let an old ranking pass for a fresh one.
      const ageDays = (Date.now() - Date.parse(payload.meta.generatedAt)) / 864e5;
      if (ageDays > 10) {
        $('stale').hidden = false;
        $('stale').textContent = `This ranking is ${Math.floor(ageDays)} days old — the weekly refresh `
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
      `<span class="perf-txt"><b>Top decile</b>` +
      `<small>${sectorBasis() ? 'whole-universe ranking · ' : ''}backtested</small></span>` +
      `<span class="perf-num"><b class="${cls(v.cagr)}">${spct(v.cagr)}</b>` +
      `<small>a year · ${spct(v.excess)} vs all</small></span>` +
      `<span class="perf-go" aria-hidden="true">›</span>`;
    el.setAttribute('aria-label',
      `Top decile backtest: ${spct(v.cagr)} a year, ${spct(v.excess)} against the whole universe. ` +
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
     a ranking or a handful of names. The counts move with the universe and
     with the scoring basis (a sector too small to score drops out), so this
     rebuilds on both rather than filling once at boot. */
  function fillSectors() {
    const members = state.rows.filter(place);
    const counts = new Map();
    for (const r of members) if (r.sector) counts.set(r.sector, (counts.get(r.sector) || 0) + 1);
    const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const sel = $('sector');
    sel.replaceChildren(new Option(`All sectors (${members.length})`, ''));
    for (const [name, n] of ordered) sel.append(new Option(`${name} (${n})`, name));
    // A sector can vanish when the universe shrinks; fall back to all sectors.
    if (state.sector && !counts.has(state.sector)) state.sector = '';
    sel.value = state.sector;
  }

  /* The universe is the title. It needs no control of its own: naming the
     app after it says which one is active and switching it is the same tap. */
  const other = () => (state.universe === 'core' ? 'ext' : 'core');

  function syncControls() {
    const here = UNIVERSES[state.universe], there = UNIVERSES[other()];
    $('title').innerHTML = `MidCap<span class="pill">${here.size} <i aria-hidden="true">⇄</i></span>`;
    $('title').setAttribute('aria-label', `Universe: ${here.label}. Switch to ${there.label}.`);
    document.title = `${here.label} Momentum`;
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
      ['MidCap 400 ranked', m.core],
      ['MidCap 650 ranked', m.ext],
      ['History', `${m.params.historyMonths} months · ${m.params.historyWeeks} weeks`],
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

  /* ---------- list ---------- */
  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    let out = state.rows.filter(place);
    if (state.scope === 'watch') out = out.filter((r) => state.watch.has(r.symbol));
    if (state.sector) out = out.filter((r) => r.sector === state.sector);
    if (q) out = out.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));

    const key = state.sort;
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
    const total = state.rows.filter(place).length;

    // Watched names outside the active universe are still watched; say where they went.
    const watching = state.scope === 'watch';
    const elsewhere = watching
      ? [...state.watch].filter((sym) => { const r = state.bySymbol.get(sym); return !r || !place(r); }).length
      : 0;
    $('empty').hidden = out.length > 0;
    $('empty').textContent = !watching ? 'No matches.'
      : state.watch.size === 0 ? 'Tap ☆ on any name to keep it here.'
      : state.query || state.sector ? 'No watched names match.'
      : `Your ${elsewhere} watched name${elsewhere === 1 ? ' is' : 's are'} outside ${UNIVERSES[state.universe].label}. Tap the title to switch.`;
    $('count').textContent = out.length
      ? `${out.length} of ${total} · ` + (sectorBasis()
          ? 'scored within each sector, so the number on the left is the position inside that sector'
          : 'ranked across the whole universe')
        + (elsewhere ? ` · ${elsewhere} more outside ${UNIVERSES[state.universe].label}` : '')
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
      `<span class="rk">${p.k}</span>` +
      `<a class="who" href="#/t/${r.symbol}"><b>${r.symbol}</b>` +
      `<small>${r.idx === '500' ? '<i class="badge">S&amp;P 500</i> ' : ''}${esc(r.name)}</small></a>` +
      sparkline(r.symbol) +
      `<span class="sc"><b>${p.s.toFixed(1)}</b></span>` +
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
    $('title').addEventListener('click', () => {
      state.universe = other();
      try { localStorage.setItem(UNIVERSE_KEY, state.universe); } catch { /* private mode */ }
      peerSetChanged();
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
    $('sector').addEventListener('change', (e) => { state.sector = e.target.value; applyFilters(); });
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
  const VIEWS = ['list-view', 'detail-view', 'evidence-view', 'settings-view'];
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
    const ticker = /^#\/t\/([A-Za-z0-9.\-]+)$/.exec(location.hash);
    if (ticker) {
      const row = state.rows.find((r) => r.symbol === ticker[1].toUpperCase());
      if (row) return showDetail(row);
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
    // A name reached by deep link may not belong to the chosen universe (an
    // S&P 500 tail name while MidCap 400 is selected). Fall back to the
    // extended universe for this page rather than showing nothing, keeping the
    // basis the reader picked.
    const key = r.r[peerKey()] ? peerKey() : keyFor('ext', state.basis, state.adjust);
    const p = r.r[key];
    const borrowed = key !== peerKey();
    if (!$('list-view').hidden) sessionStorage.setItem('sp400.scroll', String(scrollY));
    $('list-view').hidden = true;
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
          key[1] === 's' ? ` in ${esc(r.sector)}` : ''}</b></span>
      </div>
      ${borrowed ? `<p class="scope">${r.symbol} is not in the MidCap&nbsp;400, so this page is
        scored against <b>MidCap&nbsp;650</b>. Tap the title on the list to switch universe and see
        it ranked alongside everything else.</p>` : ''}
      <div class="tags">
        ${r.sector ? `<span class="tag">${esc(r.sector)}</span>` : ''}
        ${r.industry ? `<span class="tag">${esc(r.industry)}</span>` : ''}
        <span class="tag">${cap(r.mktCap)}</span>
        ${r.idx === '500' ? '<span class="tag">S&amp;P 500 tail</span>' : ''}
        <a class="tag link" href="#/evidence">Decile ${decileOf(p.k, p.n)} · how it tested →</a>
      </div>

      <div class="card">
        <h3>Momentum legs</h3>
        ${leg('12–1', '12 months, last month skipped', p.p12, r.m12, r.va12)}
        ${leg('6–1', '6 months, last month skipped', p.p6, r.m6, r.va6)}
      </div>

      <div class="card">
        <h3>Against its peers</h3>
        <table class="peers">
          <tbody>${[['whole', `All of ${UNIVERSES[key[0] === 'c' ? 'core' : 'ext'].label}`],
                    ['sector', `Within ${esc(r.sector) || 'its sector'}`]].map(([b, label]) => {
            const q = r.r[keyFor(key[0] === 'c' ? 'core' : 'ext', b, state.adjust)];
            const active = (b === 'sector') === (key[1] === 's');
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
    const W = 340, H = cfg.height || 150, PAD_L = cfg.padLeft || 26, PAD_B = 16, PAD_T = 6;
    const plotW = W - PAD_L - 4, plotH = H - PAD_B - PAD_T;
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
      `x2="${W - 4}" y2="${y(g.at).toFixed(1)}"/>` +
      `<text x="${PAD_L - 4}" y="${(y(g.at) + 3).toFixed(1)}" text-anchor="end">${g.label}</text>`
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
    const W = 340, H = cfg.height || 160, PAD_L = 34, PAD_B = 16, PAD_T = 8;
    const plotW = W - PAD_L - 6, plotH = H - PAD_B - PAD_T;
    const all = cfg.series.flatMap((se) => se.values);
    const lo = Math.min(...all), hi = Math.max(...all);
    const span = (hi - lo) || 1;
    const n = cfg.series[0].values.length;
    const x = (i) => PAD_L + (i / (n - 1)) * plotW;
    const y = (v) => PAD_T + plotH * (1 - (v - lo) / span);

    const guides = (cfg.guides || []).map((g) =>
      `<line class="${g.dashed ? 'mid' : 'grid'}" x1="${PAD_L}" y1="${y(g.at).toFixed(1)}" ` +
      `x2="${W - 6}" y2="${y(g.at).toFixed(1)}"/>` +
      `<text x="${PAD_L - 4}" y="${(y(g.at) + 3).toFixed(1)}" text-anchor="end">${g.label}</text>`
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
      <p class="legend key">${cfg.series.map((se) =>
        `<i class="swatch ${se.cls}"></i>${se.label}`).join(' ')}</p>
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
      ? ` Dimmed bars are from before ${r.symbol} joined ${UNIVERSES[key[0] === 'c' ? 'core' : 'ext'].label}
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
      note: `Each bar re-ranks ${r.symbol} against ${key[1] === 's'
               ? `other ${r.sector} names`
               : `all of ${UNIVERSES[key[0] === 'c' ? 'core' : 'ext'].label}`} at that
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
        '<span class="grow"><b>Does the score work?</b><small>loading…</small></span></div>';
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
  const months = (h) => (h === '1' ? '1 month' : `${h} months`);
  const monthsAdj = (h) => `${h}-month`;              // adjectival: "6-month return"

  function renderEvidence(el, bt, pf) {
    const h = state.horizon;
    const H = bt.variants[state.adjust].horizons[h];
    const sp = H.spread;
    const v = pf && pf.variants[perfKey()];
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="eback">‹ Back</button>
        <span class="grow"><b>Does the score work?</b>
          <small>${bt.rankingDates} month ends · ${fmtDate(bt.from)} – ${fmtDate(bt.to)}</small></span>
      </div>
      <p class="scope">Ranked on <b>${RANKED_ON[state.adjust]}</b>, the setting you have on.
        The curve below covers the <b>${UNIVERSES[state.universe].label} as a whole</b>; the decile
        table under it is the MidCap&nbsp;400 only. The within-sector basis is a display option on
        the list — it is not tested here.</p>
      ${v ? portfolioCard(v, pf) : ''}
      <p class="sechead">Forward returns, ${bt.rankingDates} month ends,
        ${fmtDate(bt.from)} – ${fmtDate(bt.to)}</p>
      <div class="hero">
        <span class="big" style="color:${tone(sp.mean > 0 ? 82 : 18)}">${signed(sp.mean * 100, 1)}%</span>
        <span class="lbl">top minus bottom decile<b>mean over ${months(h)}</b></span>
      </div>
      <div class="ctrl">
        <div class="segmented" id="hsel" role="tablist" aria-label="Forward-return horizon">
          ${['1', '3', '6'].map((k) => `<button role="tab" data-h="${k}"
            class="${k === h ? 'on' : ''}" aria-selected="${k === h}">${months(k)}</button>`).join('')}
        </div>
      </div>

      <div class="card">
        <h3>Forward return by decile</h3>
        <div id="decile-chart"></div>
      </div>

      <div class="card">
        <h3>Top minus bottom, month by month</h3>
        <dl class="stats trio">
          <div><dt>Mean spread</dt><dd class="${cls(sp.mean)}">${signed(sp.mean * 100, 2)}%</dd></div>
          <div><dt>Hit rate</dt><dd>${(sp.hitRate * 100).toFixed(0)}%</dd></div>
          <div><dt>t-stat</dt><dd>${sp.tIndependent.toFixed(2)}</dd></div>
        </dl>
        <div id="spread-chart"></div>
      </div>

      <div class="card caution">
        <h3>Read this before using it</h3>
        <ul class="caveats">
          <li><b>The obvious t-stat is wrong.</b> Sampling ${monthsAdj(h)} returns every month makes the
            windows overlap. Naive t is ${sp.tNaive.toFixed(2)}; corrected it is
            ${sp.tNeweyWest.toFixed(2)} (Newey–West), or ${sp.tIndependent.toFixed(2)} across the
            ${sp.nIndependent} genuinely independent window${sp.nIndependent === 1 ? '' : 's'}.
            The headline number above is a mean, not a proven edge.</li>
          <li><b>One regime.</b> Three years of a mostly rising market. Every decile is positive at
            six months, so the spread is the only figure carrying information here — and momentum is
            known to work in trends and break at reversals. This sample contains no reversal.</li>
          <li><b>It is decaying.</b> Spread by ranking-date year —
            ${sp.byYear.map((y) => `${y.year} ${signed(y.mean * 100, 1)}%` +
              (y.n < 6 ? ` <i>(only ${y.n})</i>` : '')).join(' · ')}.</li>
          <li><b>Scope.</b> This table is one peer set only: the MidCap 400 against itself, ranked
            on ${RANKED_ON[state.adjust]}. A sector-relative ranking is a different signal and would
            need its own test. The curve at the top covers the universe you have selected.</li>
          <li><b>What is and isn't corrected.</b> Index membership is reconstructed month by month,
            so no name is ranked before it joined. Delisted names are held to their last price and
            then treated as cash. Costs, spreads and taxes are not modelled.</li>
        </ul>
      </div>

      <footer class="foot"><p>A percentile is a rank against peers, not a return forecast.
        Past decile behaviour is not a prediction for any individual holding.</p></footer>`;

    el.querySelector('#eback').addEventListener('click', goBack);
    el.querySelector('#hsel').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-h]');
      if (!tab || tab.dataset.h === state.horizon) return;
      state.horizon = tab.dataset.h;
      renderEvidence(el, bt, pf);
    });

    if (v) drawPortfolio(el.querySelector('#perf-chart'), v, pf);
    drawDeciles(el.querySelector('#decile-chart'), H, h);
    drawSpread(el.querySelector('#spread-chart'), sp, h);
  }

  /* What holding the top decile did, against the only benchmark that makes the
     question fair: owning the same universe equally weighted. The comparison is
     put next to every number rather than left for the reader to do, because on
     this data the gap is small and a lone CAGR would flatter the ranking. */
  function portfolioCard(v, pf) {
    const t = v.topStats, a = v.allStats, b = v.bottomStats;
    const years = ((Date.parse(pf.to) - Date.parse(pf.from)) / 3.15576e10);
    const tile = (label, mine, theirs, sign) => `
      <div><dt>${label}</dt>
        <dd class="${sign ? cls(mine) : ''}">${(sign ? spct : pct)(mine)}</dd>
        <dd class="vs">all ${(sign ? spct : pct)(theirs)}</dd></div>`;
    return `
      <div class="card">
        <h3 class="row"><span>Holding the top decile</span>
          <span class="span">${fmtDate(pf.from)} – ${fmtDate(pf.to)}</span></h3>
        <div id="perf-chart"></div>
        <dl class="stats trio compare">
          ${tile('Return a year', t.cagr, a.cagr, true)}
          ${tile('Volatility', t.vol, a.vol, false)}
          ${tile('Worst fall', t.maxDrawdown, a.maxDrawdown, true)}
        </dl>
        <table class="peers years">
          <tr><th>Year</th><th>Top decile</th><th>Whole universe</th></tr>
          ${t.byYear.map((row, i) => `<tr>
            <td>${row.year}${row.n < 200 ? ' <i>part</i>' : ''}</td>
            <td class="${cls(row.ret)}">${spct(row.ret)}</td>
            <td>${spct(a.byYear[i].ret)}</td></tr>`).join('')}
        </table>
        <p class="legend">${verdict(v)}</p>
      </div>`;
  }

  /* Written from the numbers rather than fixed in the markup, so a refresh that
     turns the finding around cannot leave a stale claim on the page. */
  function verdict(v) {
    const t = v.topStats, a = v.allStats, b = v.bottomStats;
    const excess = t.cagr - a.cagr;
    const won = t.byYear.filter((y, i) => y.ret > a.byYear[i].ret).length;
    const lead = excess > 0
      ? `The top decile beat an equal-weighted holding of the whole universe by
         ${spct(excess, 1)} a year`
      : `The top decile did not beat an equal-weighted holding of the whole universe:
         ${spct(excess, 1)} a year`;
    return `${lead}, and it ${t.vol > a.vol ? 'carried more risk doing it' : 'did so with less risk'}
      — ${pct(t.vol)} volatility against ${pct(a.vol)}, worst fall ${spct(t.maxDrawdown)} against
      ${spct(a.maxDrawdown)}. It was ahead in ${won} of the ${t.byYear.length} calendar years above,
      so read that column before the average. The ordering shows more clearly at the two ends than
      at the top: top decile minus bottom decile is ${spct(t.cagr - b.cagr, 1)} a year over the same
      window. ${v.holds} names, rebalanced monthly, no costs or tax.`;
  }

  function drawPortfolio(host, v, pf) {
    // ~250 drawn points out of a daily series: past that the line is redrawing
    // pixels it already owns. Every statistic above is computed on all of it.
    const step = Math.max(1, Math.ceil(v.top.length / 250));
    const idx = [];
    for (let i = 0; i < v.top.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== v.top.length - 1) idx.push(v.top.length - 1);
    const dates = idx.map((i) => pf.dates[i]);
    const pick = (arr) => idx.map((i) => arr[i]);
    const top = pick(v.top), all = pick(v.all);
    const hi = Math.max(...top, ...all);

    const marks = [];
    dates.forEach((d, i) => {
      if (i && d.slice(0, 4) !== dates[i - 1].slice(0, 4)) marks.push({ at: i, text: d.slice(0, 4) });
    });

    lineChart(host, {
      series: [
        { values: top, cls: 'top', label: 'Top decile' },
        { values: all, cls: 'all', label: 'Whole universe, equal weight' },
      ],
      guides: [{ at: 100, label: '100', dashed: true },
               { at: hi, label: Math.round(hi).toString() }],
      xLabels: marks,
      aria: 'Growth of 100 dollars in the top momentum decile against the equal-weighted universe',
      readout: (i) => [
        `${fmtDate(dates[i])} · universe <b>${spct(all[i] / 100 - 1)}</b>`,
        spct(top[i] / 100 - 1),
      ],
      note: `100 invested at the first rebalance, ${fmtDate(pf.from)}. Equal weights are set at each
             month end and then left alone; a name that stops trading is held at its last price.
             Dividends are in the prices. Costs, spreads and tax are not.`,
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
      points, min: Math.min(...values, 0) * 1.15, max: top, baseline: 0, barRatio: 0.74, padLeft: 30,
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
      points, min: lo * 1.1, max: hi * 1.1, baseline: 0, padLeft: 30,
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
