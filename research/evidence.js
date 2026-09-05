/* The evidence page: what holding the top decile of the momentum score would
   have done, and forward returns by decile. Moved out of the app in September
   2026 and kept self-contained: the chart primitives and helpers it needs are
   copied here rather than shared, so a change to the app can never alter this
   record and this record never weighs on the app.

   Reads research/data/backtest.json and research/data/portfolio.json, which
   the "Refresh research" workflow regenerates on demand. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ADJUST_KEY = 'sp400.adjust.v1';      // shared with the app, so the choice follows the reader
  const ADJ = { raw: 'r', vol: 'v', resid: 'm' };
  const RANKED_ON = { raw: 'the return itself', vol: 'return ÷ volatility', resid: 'return net of the market' };
  const ADJUST_LABEL = { raw: 'Return', vol: '÷ Volatility', resid: 'Net of market' };
  const ADJUST_NOTE = {
    raw: 'The return itself over each formation window. The simplest reading, and the one the '
      + 'app ranks on by default.',
    vol: 'The return divided by the annualised standard deviation of its own window, so a steady '
      + 'climb outranks an equally large but erratic one.',
    resid: 'The part of the return the market does not explain: each name\'s daily moves are '
      + 'regressed on the equal-weight universe over the window, and only what is left over is '
      + 'ranked.',
  };

  const state = {
    adjust: (() => {
      try { const v = localStorage.getItem(ADJUST_KEY); return v in ADJ ? v : 'raw'; }
      catch { return 'raw'; }
    })(),
    horizon: '6',
    folds: new Set(),
    bt: null, pf: null,
  };
  const perfKey = () => 'w' + ADJ[state.adjust];

  /* ---------- formatting ---------- */
  const pct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';
  const signed = (v, d = 1) => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
  const cls = (v) => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const spct = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : '−'}${pct(Math.abs(v), d)}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const range = (r) => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
  const months = (h) => (h === '1' ? '1 month' : `${h} months`);
  const monthsAdj = (h) => `${h}-month`;
  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
      .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let dark = scheme.matches;
  scheme.addEventListener('change', (e) => { dark = e.matches; if (state.bt) render(); });
  function tone(score) {
    const t = Math.max(0, Math.min(100, score)) / 100;
    const hue = t < 0.5 ? 4 + (t / 0.5) * 38 : 42 + ((t - 0.5) / 0.5) * 103;
    const sat = 62 + Math.abs(t - 0.5) * 30;
    return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${dark ? 57 : 41}%)`;
  }

  /* ---------- bar chart ----------
     Bars rising from a baseline with a tap-and-drag readout. */
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

  /* ---------- line chart ----------
     A money chart: two series sharing one cursor. Linear axis. */
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

  /* ---------- the page ---------- */
  const load = (file) => fetch(file, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch(() => null);

  Promise.all([load('data/backtest.json'), load('data/portfolio.json')]).then(([bt, pf]) => {
    if (!bt) {
      document.querySelector('.grow small').textContent = 'backtest data unavailable';
      return;
    }
    state.bt = bt; state.pf = pf;
    if (!bt.variants[state.adjust]) state.adjust = 'raw';
    render();
  });

  const fold = (key, title, body) =>
    `<details class="card fold" data-fold="${key}"${state.folds.has(key) ? ' open' : ''}>
       <summary><h3>${title}</h3></summary><div class="fold-body">${body}</div></details>`;

  function render() {
    const el = $('evidence'), bt = state.bt, pf = state.pf;
    const h = state.horizon;
    const H = bt.variants[state.adjust].horizons[h];
    const sp = H.spread;
    const v = pf && pf.method && pf.variants[perfKey()];
    const y = scrollY;
    el.innerHTML = `
      <div class="dtop">
        <a class="back" href="./">‹ Research</a>
        <span class="grow"><b>${v ? 'Top 10% vs all ranked' : 'Forward returns by decile'}</b>
          <small>${v
            ? `${fmtDate(pf.from)} – ${fmtDate(pf.to)} · ${pf.rebalances} monthly rebalances`
            : `${bt.rankingDates} month ends · ${fmtDate(bt.from)} – ${fmtDate(bt.to)}`}</small></span>
      </div>
      <div class="choice">
        <span class="grow"><b>What each leg measures</b><small>${ADJUST_NOTE[state.adjust]}</small></span>
        <div class="segmented" id="adjust-seg" role="radiogroup" aria-label="What each leg measures">
          ${Object.keys(ADJ).filter((k) => bt.variants[k]).map((k) =>
            `<button type="button" role="radio" data-adjust="${k}" class="${k === state.adjust ? 'on' : ''}"
               aria-checked="${k === state.adjust}">${ADJUST_LABEL[k]}</button>`).join('')}
        </div>
      </div>
      ${v ? chartCard(v, pf) + methodCard(v, pf) + resultsCard(v, pf) : ''}
      ${v ? fold('conc', 'Sector concentration of the top 10%', concentrationBody(v)) : ''}
      ${fold('decile', 'A second test: forward returns by decile', decileBody(bt, sp, h))}
      ${fold('caveats', 'Read this before using it', caveatsBody(sp, h, pf))}
      <footer class="foot"><p>A percentile is a rank against peers, not a return forecast.
        Past behaviour of a basket is not a prediction for any holding in it.</p>
        <p>This page is a research record outside the app. It is refreshed on demand, not daily:
        the dates above say what it covers.</p></footer>`;

    for (const d of el.querySelectorAll('details[data-fold]')) {
      d.addEventListener('toggle', () => {
        if (d.open) state.folds.add(d.dataset.fold); else state.folds.delete(d.dataset.fold);
      });
    }
    el.querySelector('#adjust-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-adjust]');
      if (!b || b.dataset.adjust === state.adjust) return;
      state.adjust = b.dataset.adjust;
      try { localStorage.setItem(ADJUST_KEY, state.adjust); } catch { /* private mode */ }
      render();
    });
    el.querySelector('#hsel').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-h]');
      if (!tab || tab.dataset.h === state.horizon) return;
      state.horizon = tab.dataset.h;
      render();
    });

    if (v) drawPortfolio(el.querySelector('#perf-chart'), v, pf);
    if (v) drawConcentration(el.querySelector('#conc-chart'), v);
    drawDeciles(el.querySelector('#decile-chart'), H, h);
    drawSpread(el.querySelector('#spread-chart'), sp, h);
    scrollTo(0, y);
  }

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

  function methodCard(v, pf) {
    const m = pf.method;
    const vol = state.adjust === 'vol';
    const resid = state.adjust === 'resid';
    const w = m.weights;
    const rows = [
      ['Universe', `On each rebalance date: every S&amp;P MidCap 400 member that day, plus the
        ${m.sizeTail} S&amp;P 500 members with the smallest market cap that day (latest cap on or
        before the date). Membership is rebuilt from each index's change log.`],
      ['Score', `From adjusted closes, two returns per name: from ${m.longDays} to ${m.skipDays}
        trading days before the date (12–1) and from ${m.midDays} to ${m.skipDays} (6–1).${vol
          ? ` Each is divided by the annualised standard deviation of the name's daily log returns
              over that same window.` : ''}${resid
          ? ` Each is replaced by the return a regression of the name's daily log returns on the
              equal-weight universe's, over that same window, leaves unexplained — the name's own
              move net of its beta times the market's.` : ''}
        Each is converted to a 0–100 percentile across all ranked names, ties sharing their average
        rank. Score = ${w[0]} × 12–1 percentile + ${w[1]} × 6–1 percentile.
        <span class="setting">Ranked on ${RANKED_ON[state.adjust]} — chosen above.</span>`],
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

  function caveatsBody(sp, h, pf) {
    const held = (pf && pf.method && pf.method.held) || { min: '?', max: '?' };
    return `
      <ul class="caveats">
        <li><b>The obvious t-stat is wrong.</b> Sampling ${monthsAdj(h)} returns every month makes the
          windows overlap. Naive t is ${sp.tNaive.toFixed(2)}; corrected it is
          ${sp.tNeweyWest.toFixed(2)} (Newey–West), or ${sp.tIndependent.toFixed(2)} across the
          ${sp.nIndependent} genuinely independent window${sp.nIndependent === 1 ? '' : 's'}.
          A mean is not a proven edge.</li>
        <li><b>Regime.</b> Momentum is known to work in trends and break at reversals, so read
          the years before the mean. Spread by ranking-date year —
          ${sp.byYear.map((y) => `${y.year} ${signed(y.mean * 100, 1)}%` +
            (y.n < 6 ? ` <i>(only ${y.n})</i>` : '')).join(' · ')}.
          ${(() => { const bad = sp.byYear.filter((y) => y.mean < 0).map((y) => y.year);
            return bad.length ? `The ranking went the wrong way in ${bad.join(' and ')}.`
                              : 'Every year in the sample was positive.'; })()}</li>
        <li><b>Scope.</b> Both tests rank across the whole universe on ${RANKED_ON[state.adjust]}.
          The within-sector basis in the app is a different signal and is not tested.</li>
        <li><b>Not modelled.</b> Costs, spreads, tax, and the price impact of trading
          ${range(held)} names at once.</li>
      </ul>`;
  }

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
    const points = rows.map((r) => ({ ...r, value: r.effective, color: tone((r.effective / ceiling) * 100) }));
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

  function drawDeciles(host, H, h) {
    const points = H.deciles.map((d, i) => ({ ...d, value: d.mean, color: tone(100 - (i * 100) / 9) }));
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
    const points = sp.series.map((p) => ({ ...p, value: p.spread, color: tone(p.spread > 0 ? 82 : 18) }));
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
