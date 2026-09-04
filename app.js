/* MidCap 400 Momentum — vanilla, no dependencies.
   Data is pre-computed by scripts/build.py and served as static JSON. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE = 60;                         // rows appended per scroll chunk
  const WATCH_KEY = 'sp400.watchlist.v1';

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
  };

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
  /* Score colour ramp: cold (0) → neutral (50) → hot (100). */
  function tone(score) {
    const t = Math.max(0, Math.min(100, score)) / 100;
    // Piecewise so that 50 lands on a genuinely neutral amber rather than a
    // greenish midpoint: 0 = red, 0.5 = amber, 1 = green.
    const hue = t < 0.5 ? 4 + (t / 0.5) * 38 : 42 + ((t - 0.5) / 0.5) * 103;
    const sat = 62 + Math.abs(t - 0.5) * 30;
    const light = matchMedia('(prefers-color-scheme: dark)').matches ? 57 : 41;
    return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light}%)`;
  }
  const cls = (v) => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

  /* ---------- boot ---------- */
  fetch('data/latest.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((payload) => {
      state.rows = payload.rows;
      state.meta = payload.meta;
      $('asof').textContent =
        `${payload.meta.ranked} names · prices through ${fmtDate(payload.meta.asOf)}`;
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

  function fillSectors() {
    const sectors = [...new Set(state.rows.map((r) => r.sector).filter(Boolean))].sort();
    const sel = $('sector');
    for (const s of sectors) sel.append(new Option(s, s));
  }

  /* ---------- list ---------- */
  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    let out = state.rows;
    if (state.scope === 'watch') out = out.filter((r) => state.watch.has(r.symbol));
    if (state.sector) out = out.filter((r) => r.sector === state.sector);
    if (q) out = out.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));

    const key = state.sort;
    out = out.slice().sort(
      key === 'symbol'
        ? (a, b) => a.symbol.localeCompare(b.symbol)
        : (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity)
    );

    state.view = out;
    state.shown = 0;
    $('rows').replaceChildren();
    $('empty').hidden = out.length > 0;
    $('count').textContent = out.length
      ? `${out.length} of ${state.rows.length}` + (state.sort === 'score' ? ' · ranked by blended score' : '')
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
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.symbol = r.symbol;
    li.innerHTML =
      `<span class="rk">${r.rank}</span>` +
      `<a class="who" href="#/t/${r.symbol}"><b>${r.symbol}</b><small>${esc(r.name)}</small></a>` +
      `<span class="sc"><b>${r.score.toFixed(1)}</b>` +
      `<span class="bar"><i style="width:${r.score}%;background:${tone(r.score)}"></i></span></span>` +
      `<button class="star${state.watch.has(r.symbol) ? ' on' : ''}" aria-label="Watchlist">` +
      `${state.watch.has(r.symbol) ? '★' : '☆'}</button>`;
    return li;
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
    });

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.shown < state.view.length) appendChunk();
    }, { rootMargin: '600px' }).observe($('sentinel'));

    $('about-btn').addEventListener('click', () => $('about').showModal());
    $('about-close').addEventListener('click', () => $('about').close());
    addEventListener('hashchange', route);
  }

  /* ---------- routing ---------- */
  function route() {
    const match = /^#\/t\/([A-Za-z0-9.\-]+)$/.exec(location.hash);
    if (match) {
      const row = state.rows.find((r) => r.symbol === match[1].toUpperCase());
      if (row) return showDetail(row);
      location.hash = '';
      return;
    }
    $('detail-view').hidden = true;
    $('list-view').hidden = false;
    if (!state.view.length) applyFilters();
    scrollTo(0, Number(sessionStorage.getItem('sp400.scroll') || 0));
  }

  function loadHistory() {
    if (!state.historyPromise) {
      state.historyPromise = fetch('data/history.json', { cache: 'no-cache' })
        .then((r) => r.json())
        .then((h) => { state.history = h; return h; })
        .catch(() => null);
    }
    return state.historyPromise;
  }

  /* ---------- detail ---------- */
  function showDetail(r) {
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
        <span class="big" style="color:${tone(r.score)}">${r.score.toFixed(1)}</span>
        <span class="lbl">blended score<b>rank ${r.rank} of ${state.meta.ranked}</b></span>
      </div>
      <div class="tags">
        ${r.sector ? `<span class="tag">${esc(r.sector)}</span>` : ''}
        ${r.industry ? `<span class="tag">${esc(r.industry)}</span>` : ''}
        <span class="tag">${cap(r.mktCap)}</span>
      </div>

      <div class="card">
        <h3>Momentum legs</h3>
        ${leg('12–1', '12 months, last month skipped', r.p12, r.m12, r.va12)}
        ${leg('6–1', '6 months, last month skipped', r.p6, r.m6, r.va6)}
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
        <h3>Blended score through time</h3>
        <div id="chart" class="chartwrap"><p class="legend">Loading history…</p></div>
      </div>`;

    $('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = ''));
    $('dstar').addEventListener('click', (e) => toggleWatch(r.symbol, e.currentTarget));
    scrollTo(0, 0);
    loadHistory().then((h) => {
      if (location.hash !== `#/t/${r.symbol}`) return;
      drawChart($('chart'), h, r);
    });
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

  /* ---------- bar chart ---------- */
  function drawChart(host, history, r) {
    const series = history && history.scores[r.symbol];
    if (!series) { host.innerHTML = '<p class="legend">No score history for this name yet.</p>'; return; }

    const points = series
      .map((value, i) => ({ value, date: history.dates[i] }))
      .filter((p) => p.value != null);
    if (!points.length) { host.innerHTML = '<p class="legend">No score history for this name yet.</p>'; return; }

    const W = 340, H = 150, PAD_L = 22, PAD_B = 16, PAD_T = 6;
    const plotW = W - PAD_L - 4, plotH = H - PAD_B - PAD_T;
    const step = plotW / points.length;
    const barW = Math.max(2, step * 0.68);
    const y = (v) => PAD_T + plotH * (1 - v / 100);

    const bars = points.map((p, i) => {
      const x = PAD_L + i * step + (step - barW) / 2;
      const h = Math.max(1, plotH * p.value / 100);
      return `<rect data-i="${i}" x="${x.toFixed(2)}" y="${(PAD_T + plotH - h).toFixed(2)}" ` +
             `width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${tone(p.value)}"/>`;
    }).join('');

    // One x label per calendar year change, plus the last point.
    const labels = points.map((p, i) => {
      const isNewYear = i === 0 || p.date.slice(0, 4) !== points[i - 1].date.slice(0, 4);
      if (!isNewYear) return '';
      const x = PAD_L + i * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle">${p.date.slice(0, 4)}</text>`;
    }).join('');

    host.innerHTML =
      `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="Blended momentum score for ${r.symbol} over ${points.length} months">
        <line class="grid" x1="${PAD_L}" y1="${y(100)}" x2="${W - 4}" y2="${y(100)}"/>
        <line class="mid"  x1="${PAD_L}" y1="${y(50)}"  x2="${W - 4}" y2="${y(50)}"/>
        <line class="grid" x1="${PAD_L}" y1="${y(0)}"   x2="${W - 4}" y2="${y(0)}"/>
        <text x="${PAD_L - 4}" y="${y(100) + 3}" text-anchor="end">100</text>
        <text x="${PAD_L - 4}" y="${y(50) + 3}" text-anchor="end">50</text>
        <text x="${PAD_L - 4}" y="${y(0) + 3}" text-anchor="end">0</text>
        ${bars}${labels}
        <rect id="cursor" x="0" y="${PAD_T}" width="${barW.toFixed(2)}" height="${plotH}"
              fill="currentColor" opacity="0" pointer-events="none"/>
      </svg>
      <div class="readout"><span id="ro-date"></span><b id="ro-val"></b></div>
      <p class="legend">Each bar re-ranks ${r.symbol} against the whole index at that month end.
        Above the dashed line means top half of the MidCap 400.</p>`;

    const svg = host.querySelector('svg');
    const cursor = host.querySelector('#cursor');
    const roDate = host.querySelector('#ro-date');
    const roVal = host.querySelector('#ro-val');

    const select = (i) => {
      const p = points[i];
      roDate.textContent = fmtDate(p.date);
      roVal.textContent = p.value.toFixed(1);
      roVal.style.color = tone(p.value);
      cursor.setAttribute('x', (PAD_L + i * step + (step - barW) / 2).toFixed(2));
      cursor.setAttribute('opacity', '0.12');
    };
    select(points.length - 1);

    const pick = (event) => {
      const box = svg.getBoundingClientRect();
      const x = ((event.touches ? event.touches[0].clientX : event.clientX) - box.left) / box.width * W;
      const i = Math.round((x - PAD_L - step / 2) / step);
      if (i >= 0 && i < points.length) select(i);
    };
    svg.addEventListener('pointerdown', pick);
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') pick(e); });
  }
})();
