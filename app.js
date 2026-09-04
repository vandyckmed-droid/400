/* MidCap 400 Momentum — vanilla, no dependencies.
   Data is pre-computed by scripts/build.py and served as static JSON. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE = 60;                         // rows appended per scroll chunk
  const WATCH_KEY = 'sp400.watchlist.v1';
  const PEER_KEY = 'sp400.peerset.v1';

  /* The four peer sets a name can be ranked against. `uni` picks the universe,
     `basis` picks whether the cross-section is the whole thing or just the
     name's own sector. Data for all four ships in latest.json. */
  const PEERS = {
    cw: { label: 'MidCap 400', short: '400', basis: 'whole' },
    cs: { label: 'MidCap 400 · within sector', short: '400 · sector', basis: 'sector' },
    ew: { label: 'Extended 650', short: '650', basis: 'whole' },
    es: { label: 'Extended 650 · within sector', short: '650 · sector', basis: 'sector' },
  };

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
    peer: (() => {
      try { return PEERS[localStorage.getItem(PEER_KEY)] ? localStorage.getItem(PEER_KEY) : 'cw'; }
      catch { return 'cw'; }
    })(),
  };

  /* This row's placement in the active peer set, or undefined if it isn't a
     member (an S&P 500 tail name while a MidCap 400 peer set is selected). */
  const place = (r) => r.r[state.peer];
  const sectorBasis = () => PEERS[state.peer].basis === 'sector';

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
      $('peer').value = state.peer;
      $('asof').textContent = `prices through ${fmtDate(payload.meta.asOf)}`;
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
    out = out.slice().sort(
      key === 'symbol'
        ? (a, b) => a.symbol.localeCompare(b.symbol)
        : (a, b) => (sortValue(b, key) ?? -Infinity) - (sortValue(a, key) ?? -Infinity)
    );

    state.view = out;
    state.shown = 0;
    $('rows').replaceChildren();
    $('empty').hidden = out.length > 0;
    const total = state.rows.filter(place).length;
    $('count').textContent = out.length
      ? `${out.length} of ${total} · ` + (sectorBasis()
          ? 'scored within each sector, so the number on the left is the position inside that sector'
          : `ranked across the ${PEERS[state.peer].short === '650' ? 'extended 650' : 'MidCap 400'}`)
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
      `<span class="sc"><b>${p.s.toFixed(1)}</b>` +
      `<span class="bar"><i style="width:${p.s}%;background:${tone(p.s)}"></i></span></span>` +
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
    $('peer').addEventListener('change', (e) => {
      state.peer = e.target.value;
      try { localStorage.setItem(PEER_KEY, state.peer); } catch { /* private mode */ }
      applyFilters();
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
    $('about-evidence').addEventListener('click', () => $('about').close());
    addEventListener('hashchange', route);
  }

  /* ---------- routing ---------- */
  const VIEWS = ['list-view', 'detail-view', 'evidence-view'];
  function showView(id) {
    if (id !== 'list-view' && !$('list-view').hidden) {
      sessionStorage.setItem('sp400.scroll', String(scrollY));
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
    showView('list-view');
    if (!state.view.length) applyFilters();
    scrollTo(0, Number(sessionStorage.getItem('sp400.scroll') || 0));
  }

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
  const loadHistory = (key) => loadJSON(`data/history/${key}.json`, `hist_${key}`);
  const loadBacktest = () => loadJSON('data/backtest.json', 'backtest');

  /* ---------- detail ---------- */
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function showDetail(r) {
    // A name reached by deep link may not belong to the peer set the list is
    // on (an S&P 500 tail name while MidCap 400 is selected). Resolve one peer
    // set for the whole page rather than letting the hero and the chart
    // disagree about which cross-section they are showing.
    const key = r.r[state.peer] ? state.peer
      : PEERS[state.peer].basis === 'sector' ? 'es' : 'ew';
    const p = r.r[key];
    const borrowed = key !== state.peer;
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
          PEERS[key].basis === 'sector' ? ` in ${esc(r.sector)}` : ''}</b></span>
      </div>
      ${borrowed ? `<p class="scope">${r.symbol} is not in the MidCap 400, so this page is scored
        against <b>${PEERS[key].label}</b>. Switch the list to an extended peer set to rank it
        alongside everything else.</p>` : ''}
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
        <h3>Against every peer set</h3>
        <table class="peers">
          <tbody>${Object.entries(PEERS).map(([k, cfg]) => {
            const q = r.r[k];
            return `<tr class="${k === key ? 'on' : ''}">
              <td>${cfg.label.replace(' · within sector', ' <i>· sector</i>')}</td>
              <td class="v" style="color:${q ? tone(q.s) : 'var(--ink-3)'}">${q ? q.s.toFixed(1) : '—'}</td>
              <td class="k">${q ? `${q.k} / ${q.n}` : 'not a member'}</td></tr>`;
          }).join('')}</tbody>
        </table>
        <p class="legend">A name can look ordinary against the whole index and strong against its own
          sector, or the reverse. Switching the peer set on the list changes which row drives this page.</p>
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
        <div id="chart"><p class="legend">Loading history…</p></div>
      </div>`;

    $('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = ''));
    $('dstar').addEventListener('click', (e) => toggleWatch(r.symbol, e.currentTarget));
    scrollTo(0, 0);
    loadHistory(key).then((h) => {
      if (location.hash !== `#/t/${r.symbol}`) return;
      drawChart($('chart'), h, r, key);
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
             `rx="1" fill="${p.color}"/>`;
    }).join('');

    const guides = (cfg.guides || []).map((g) =>
      `<line class="${g.dashed ? 'mid' : 'grid'}" x1="${PAD_L}" y1="${y(g.at).toFixed(1)}" ` +
      `x2="${W - 4}" y2="${y(g.at).toFixed(1)}"/>` +
      `<text x="${PAD_L - 4}" y="${(y(g.at) + 3).toFixed(1)}" text-anchor="end">${g.label}</text>`
    ).join('');

    const labels = pts.map((p, i) => {
      const text = cfg.xLabel ? cfg.xLabel(p, i, pts) : '';
      if (!text) return '';
      return `<text x="${(PAD_L + i * step + step / 2).toFixed(1)}" y="${H - 4}" ` +
             `text-anchor="middle">${text}</text>`;
    }).join('');

    host.innerHTML =
      `<div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${cfg.aria}">
        ${guides}${bars}${labels}
        <rect class="cursor" x="0" y="${PAD_T}" width="${barW.toFixed(2)}" height="${plotH}"
              fill="currentColor" opacity="0" pointer-events="none"/>
      </svg></div>
      <div class="readout"><span class="ro-l"></span><b class="ro-r"></b></div>
      ${cfg.note ? `<p class="legend">${cfg.note}</p>` : ''}`;

    const svg = host.querySelector('svg');
    const cursor = host.querySelector('.cursor');
    const left = host.querySelector('.ro-l');
    const right = host.querySelector('.ro-r');

    const select = (i) => {
      const [l, r, colour] = cfg.readout(pts[i], i);
      left.textContent = l;
      right.textContent = r;
      right.style.color = colour || pts[i].color;
      cursor.setAttribute('x', barX(i).toFixed(2));
      cursor.setAttribute('opacity', '0.12');
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

  /* Per-ticker score history: fixed 0-100 domain, 50 marks the index median. */
  function drawChart(host, history, r, key) {
    const series = history && history.scores[r.symbol];
    const points = (series || [])
      .map((value, i) => ({ value, date: history.dates[i] }))
      .filter((p) => p.value != null)
      .map((p) => ({ ...p, color: tone(p.value) }));
    if (!points.length) {
      host.innerHTML = '<p class="legend">No score history for this name yet.</p>';
      return;
    }
    barChart(host, {
      points, min: 0, max: 100, baseline: 0,
      guides: [{ at: 100, label: '100' }, { at: 50, label: '50', dashed: true }, { at: 0, label: '0' }],
      xLabel: (p, i, all) =>
        i === 0 || p.date.slice(0, 4) !== all[i - 1].date.slice(0, 4) ? p.date.slice(0, 4) : '',
      aria: `Blended momentum score for ${r.symbol} over ${points.length} months`,
      readout: (p) => [fmtDate(p.date), p.value.toFixed(1)],
      note: `Each bar re-ranks ${r.symbol} against ${PEERS[key].basis === 'sector'
               ? `other ${r.sector} names in the ${PEERS[key].short.split(' ')[0]}`
               : `the whole ${PEERS[key].short}`} at that month end, using the membership that was
             live on the day. Above the dashed line means the better half of that peer set.`,
    });
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
    loadBacktest().then((bt) => {
      if (location.hash !== '#/evidence') return;
      if (!bt) {
        el.querySelector('.grow small').textContent = 'backtest data unavailable';
        return;
      }
      renderEvidence(el, bt);
    });
  }

  const decileOf = (rank, n) => Math.min(10, Math.floor((rank - 1) / (n / 10)) + 1);
  const goBack = () => (history.length > 1 ? history.back() : (location.hash = ''));
  const months = (h) => (h === '1' ? '1 month' : `${h} months`);
  const monthsAdj = (h) => `${h}-month`;              // adjectival: "6-month return"

  function renderEvidence(el, bt) {
    const h = state.horizon;
    const H = bt.horizons[h];
    const sp = H.spread;
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="dtop">
        <button class="back" id="eback">‹ Back</button>
        <span class="grow"><b>Does the score work?</b>
          <small>${bt.rankingDates} month ends · ${fmtDate(bt.from)} – ${fmtDate(bt.to)}</small></span>
      </div>
      <p class="scope">Tested on the <b>MidCap&nbsp;400 ranked as a whole</b>. The extended 650
        universe and the within-sector bases are display options on the list — they are not tested
        here, so nothing below carries over to them.</p>
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
          <li><b>Scope.</b> One peer set only: the MidCap 400 against itself. A sector-relative
            ranking is a different signal and would need its own test.</li>
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
      renderEvidence(el, bt);
    });

    drawDeciles(el.querySelector('#decile-chart'), H, h);
    drawSpread(el.querySelector('#spread-chart'), sp, h);
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
