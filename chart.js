/* Price chart: daily bars on a canvas with the three gestures a phone
   needs — drag to pan time, pinch to zoom time, drag the price axis to stretch
   it — plus optional indicators (a linear regression channel and two simple
   moving averages) and a linear or log price axis. */
(function () {
  'use strict';

  /* The indicators the chart can draw: each one's defaults and the range
     every setting may take, as [min, max, step]. app.js builds the panel
     from this and stores the choices; the chart only ever sees a normalised
     copy. Adding an indicator means a new entry here plus its drawing. */
  const INDICATORS = {
    channel: {
      name: 'Regression channel',
      defaults: { on: true, len: 200, dev: 2, fill: 0.07 },
      limits: { len: [20, 360, 10], dev: [1, 3, 0.1], fill: [0, 0.4, 0.01] },
    },
    ma: {
      name: 'Moving average 1',
      defaults: { on: false, period: 50 },
      limits: { period: [5, 200, 5] },
      color: '--mid',
    },
    ma2: {
      name: 'Moving average 2',
      defaults: { on: false, period: 200 },
      limits: { period: [5, 300, 5] },
      color: '--ma2',
    },
    /* Drawn in its own pane beneath the price (`pane: 'below'`), on the same
       dates: the name's daily score in the peer set the app hands in. */
    rank: {
      name: 'Rank',
      pane: 'below',
      defaults: { on: true, style: 'line', height: 0.24 },
      limits: { height: [0.12, 0.6, 0.01] },     // share of the canvas the pane takes
      choices: { style: ['line', 'bars'] },
      color: '--accent',
    },
  };
  const MAS = ['ma', 'ma2'];     // the moving-average indicators, drawn the same way

  /* The price axis: linear, or log so equal percentage moves are equal
     heights. Stored and normalised beside the indicators; shown on the
     panel's Chart tab rather than in the indicator list. */
  const AXIS = {
    name: 'Price axis',
    defaults: { scale: 'linear' },
    choices: { scale: ['linear', 'log'] },
  };
  const SPECS = { ...INDICATORS, axis: AXIS };

  /* Fill in defaults, clamp every number and reject unknown choices, so a
     stale or hand-edited store can never put the chart in a state it cannot
     draw. */
  function normalize(prefs) {
    const out = {};
    for (const [id, spec] of Object.entries(SPECS)) {
      const raw = (prefs && typeof prefs[id] === 'object' && prefs[id]) || {};
      const o = {};
      if ('on' in spec.defaults) o.on = typeof raw.on === 'boolean' ? raw.on : spec.defaults.on;
      for (const [k, [lo, hi]] of Object.entries(spec.limits || {})) {
        const v = raw[k];
        o[k] = (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : spec.defaults[k];
      }
      for (const [k, allowed] of Object.entries(spec.choices || {})) {
        o[k] = allowed.includes(raw[k]) ? raw[k] : spec.defaults[k];
      }
      out[id] = o;
    }
    return out;
  }

  const TUNE = {
    barW: 3,             // starting pixels per bar
    minBarW: 0.4,        // small enough that three years fit the plot when zoomed right out
    maxBarW: 40,
    pad: 0.06,           // auto-scale head/foot room as a share of the range
    rightRoom: 0.4,      // how far past the last bar you can pan, share of the plot width
    axisDragHalf: 110,   // px of axis drag that halves or doubles the price span
    timeDragDouble: 150, // px of time-axis drag that doubles bar width
    tickPx: 64,          // target pixels between price ticks
    dateLabelPx: 46,     // minimum pixels between date labels
    snapMs: 160,         // snap-to-nice animation
    doubleTapMs: 320,
    holdMs: 320,         // press-and-hold before the crosshair appears
    holdSlop: 6,         // px a held finger may drift and still be a hold, not a pan
    xhairEase: 0.35,     // per-frame share of the way the crosshair slides to its bar
    dividerGrab: 9,      // px either side of the pane divider that drags it
    tapMs: 350,          // a touch shorter than this that does not move is a tap
    lowerPadT: 18,       // headroom above 100 in the lower pane, px
    lowerPadB: 6,        // foot room below 0
  };

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* 1-2-5 steps: the nice step closest (in log terms) to `span / target`. */
  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.42 ? 1 : m < 3.17 ? 2 : m < 7.08 ? 5 : 10) * p;
  }

  const fmtPrice = (v) => (Math.abs(v) < 0.005 ? 0 : v)   // never "-0.00" on a tick that lands on zero
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Ordinary least squares over the last `len` closes — on the closes for a
     linear axis, on their logarithm for a log axis, so the fit is a straight
     line on whichever axis is showing and the bands are equal dollar (or
     equal percentage) distances either side. Residual deviation is the
     population standard deviation, which is what the TradingView channel
     uses. edge(i, k) is the price of the line k deviations from the fit at
     bar i; values are linear in bar index so the lines extend past the
     last bar. */
  function regression(c, len, log) {
    const n = c.length;
    len = Math.min(len, n);
    const start = n - len;
    const y = log ? c.slice(start).map(Math.log) : c.slice(start);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < len; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
    const slope = len > 1 ? (len * sxy - sx * sy) / (len * sxx - sx * sx) : 0;
    const intercept = (sy - slope * sx) / len;
    let ss = 0;
    for (let i = 0; i < len; i++) { const r = y[i] - (intercept + slope * i); ss += r * r; }
    const sd = Math.sqrt(ss / len);
    const edge = (i, k) => { const f = intercept + slope * (i - start) + k * sd; return log ? Math.exp(f) : f; };
    return { start, len, edge };
  }

  /* Simple moving average of the closes; NaN until `len` bars are in. */
  function sma(c, len) {
    const out = new Array(c.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < c.length; i++) {
      sum += c[i];
      if (i >= len) sum -= c[i - len];
      if (i >= len - 1) out[i] = sum / len;
    }
    return out;
  }

  /* opts: { indicators, view, rank, onChange, onOpen }. `indicators` is the
     whole settings object — one entry per indicator plus `axis` — in the
     shape of SPECS' defaults; the app owns where it is stored, hands it in,
     and changes it later through set(). `view` is a zoom() snapshot from a
     previous chart, so stepping between names keeps the same bar width and
     right edge. `rank` is the daily score, one value (or null) per bar;
     without it the lower pane stays closed whatever the switch says.
     `onChange(settings)` is called when a gesture changes a setting (a drag
     of the pane divider), so the app can store it; `onOpen(id)` when the
     reader taps an indicator's label on the chart. */
  function priceChart(canvas, bars, opts = {}) {
    const { dates, o, h, l, c } = bars;
    const n = c.length;
    const rank = Array.isArray(opts.rank) && opts.rank.length === n ? opts.rank : null;
    const ctx = canvas.getContext('2d');
    let cfg = normalize(opts.indicators);
    let channel = regression(c, cfg.channel.len, cfg.axis.scale === 'log');
    const mas = Object.fromEntries(MAS.map((id) => [id, sma(c, cfg[id].period)]));

    // View state. `right` is the fractional bar index sitting at the right edge
    // of the plot; `auto` means the price range follows the visible bars.
    const view = { right: n + 2, barW: TUNE.barW, auto: true, lo: 0, hi: 1 };
    if (opts.view) { view.barW = opts.view.barW; view.right = n - opts.view.fromEnd; }
    const zoom = () => ({ barW: view.barW, fromEnd: n - view.right });
    let W = 0, H = 0, dpr = 1, axisW = 64, timeH = 26, plotL = 0, plotR = 0, plotT = 8, plotB = 0;
    let timeY = 0, lowT = 0, lowB = 0;      // the time axis, and the pane between the price and it
    let colors = {};
    let raf = 0;
    let tween = null;

    const plotW = () => plotR - plotL;
    const plotH = () => plotB - plotT;
    const visible = () => plotW() / view.barW;
    const xOf = (i) => plotR - (view.right - i - 0.5) * view.barW;
    const indexAt = (x) => view.right - (plotR - x) / view.barW;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const barAt = (x) => clamp(Math.floor(indexAt(x)), 0, n - 1);

    /* The lower pane: open when the rank is switched on and there is one to
       draw. A fixed 0–100 scale with a little head and foot room. */
    const lowerOn = () => !!(rank && cfg.rank.on);
    const lowerH = () => (lowerOn() ? clamp(Math.round(H * cfg.rank.height), 60, Math.round(H * 0.6)) : 0);
    const lowSpan = () => lowB - lowT - TUNE.lowerPadT - TUNE.lowerPadB;
    const yR = (v) => lowB - TUNE.lowerPadB - (v / 100) * lowSpan();
    const rankAt = (y) => 100 * (lowB - TUNE.lowerPadB - y) / lowSpan();
    const LABEL = { w: 64, h: 24 };          // the tappable label at the pane's top left

    /* Price <-> pixel goes through one transform: identity on a linear axis,
       natural log on a log axis. view.lo and view.hi stay prices on both, so
       the auto range, snapping and tick labels keep working in price terms;
       only spans — the gesture arithmetic — are measured in transformed
       units, which is what makes an axis drag feel the same on either. */
    const FLOOR = 1e-6;                      // log needs a positive price; below this is off the chart anyway
    const isLog = () => cfg.axis.scale === 'log';
    const T = (v) => (isLog() ? Math.log(Math.max(v, FLOOR)) : v);
    const Tinv = (t) => (isLog() ? Math.exp(t) : t);
    const spanT = () => T(view.hi) - T(view.lo);
    const yOf = (v) => plotT + (T(view.hi) - T(v)) / spanT() * plotH();
    const priceAt = (y) => Tinv(T(view.hi) - (y - plotT) / plotH() * spanT());

    function readColors() {
      colors = {
        bg: css('--bg'), ink: css('--ink'), ink3: css('--ink-3'), grid: css('--line-soft'),
        line: css('--line'), hot: css('--hot'), cold: css('--cold'), accent: css('--accent'),
      };
    }

    function resize() {
      const box = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = box.width; H = box.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
      axisW = Math.ceil(ctx.measureText('8,888.88').width) + 18;
      layout();
      clampView();
      draw();
    }

    function layout() {
      plotL = 0; plotR = W - axisW; timeY = H - timeH;
      plotB = timeY - lowerH();
      lowT = plotB + 1; lowB = timeY;
    }

    function clampView() {
      const minBar = Math.max(TUNE.minBarW, plotW() / (n * 1.15));
      view.barW = clamp(view.barW, minBar, TUNE.maxBarW);
      view.right = clamp(view.right, 8, n + TUNE.rightRoom * visible());
    }

    /* Auto range: the visible bars plus whichever indicators are on screen. */
    function autoRange() {
      const from = Math.max(0, Math.floor(view.right - visible()));
      const to = Math.min(n - 1, Math.ceil(view.right));
      let lo = Infinity, hi = -Infinity;
      for (let i = from; i <= to; i++) { if (l[i] < lo) lo = l[i]; if (h[i] > hi) hi = h[i]; }
      const barLo = lo;
      if (cfg.channel.on) {
        const dev = cfg.channel.dev;
        for (const i of [Math.max(from, channel.start), Math.min(view.right, n - 1 + TUNE.rightRoom * visible())]) {
          if (i < channel.start) continue;
          lo = Math.min(lo, channel.edge(i, -dev));
          hi = Math.max(hi, channel.edge(i, dev));
        }
      }
      for (const id of MAS) {
        if (!cfg[id].on) continue;
        const ma = mas[id];
        for (let i = from; i <= to; i++) { const v = ma[i]; if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      }
      if (!isFinite(lo)) { lo = c[n - 1] * 0.9; hi = c[n - 1] * 1.1; }
      // Belt and braces: on a log axis the fit is in logs, so every edge is
      // positive; this only guards against a value the arithmetic cannot produce.
      if (isLog() && !(lo > 0)) lo = (isFinite(barLo) ? barLo : c[n - 1]) * 0.5;
      const pad = (T(hi) - T(lo) || 1) * TUNE.pad;
      return [Tinv(T(lo) - pad), Tinv(T(hi) + pad)];
    }

    /* The tick step near price v: constant on a linear axis; on a log axis
       the price distance that spans tickPx pixels at that height. */
    function tickStepAt(v) {
      if (!isLog()) return niceStep(view.hi - view.lo, plotH() / TUNE.tickPx);
      return niceStep(Math.max(v, FLOOR) * TUNE.tickPx * spanT() / plotH(), 1);
    }

    function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

    function draw() {
      if (tween) {
        const t = Math.min(1, (performance.now() - tween.t0) / TUNE.snapMs);
        const e = 1 - Math.pow(1 - t, 3);
        view.lo = tween.lo0 + (tween.lo1 - tween.lo0) * e;
        view.hi = tween.hi0 + (tween.hi1 - tween.hi0) * e;
        if (t >= 1) tween = null; else schedule();
      } else if (view.auto) {
        [view.lo, view.hi] = autoRange();
      }
      const pw = plotW(), ph = plotH();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 1;

      // Price ticks and horizontal grid: one nice step on a linear axis; on a
      // log axis the step grows with the price, so ticks stay about tickPx
      // apart all the way up instead of crowding at the top.
      const tagY = yOf(c[n - 1]);
      ctx.strokeStyle = colors.grid;
      ctx.fillStyle = colors.ink3;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let lastLabelY = Infinity;
      let step = tickStepAt(view.lo);
      for (let v = Math.ceil(view.lo / step) * step, k = 0; v <= view.hi && step > 0 && k < 200; k++) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
        if (Math.abs(y - tagY) > 14 && lastLabelY - y > 14) { ctx.fillText(fmtPrice(v), plotR + 8, y); lastLabelY = y; }
        step = tickStepAt(v);
        v = Math.floor(v / step + 1e-9) * step + step;     // the next multiple of the (possibly larger) step
      }

      // Date labels and vertical grid at month starts, thinned to fit.
      const from = Math.max(0, Math.floor(view.right - visible()) - 1);
      const to = Math.min(n - 1, Math.ceil(view.right));
      const stride = Math.max(1, Math.ceil(TUNE.dateLabelPx / (21 * view.barW)));
      ctx.textAlign = 'center';
      for (let i = Math.max(1, from); i <= to; i++) {
        if (dates[i].slice(0, 7) === dates[i - 1].slice(0, 7)) continue;
        const yr = +dates[i].slice(0, 4), mo = +dates[i].slice(5, 7) - 1;
        if ((yr * 12 + mo) % stride) continue;
        const x = Math.round(xOf(i) - view.barW / 2) + 0.5;
        ctx.strokeStyle = colors.grid;
        ctx.beginPath(); ctx.moveTo(x, plotT); ctx.lineTo(x, timeY); ctx.stroke();
        ctx.fillStyle = mo === 0 ? colors.ink : colors.ink3;
        ctx.fillText(mo === 0 ? String(yr) : MONTHS[mo], x, timeY + timeH / 2);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(plotL, plotT, pw, ph); ctx.clip();

      // Regression channel: light fill, thin lines, extended to the right edge.
      // The fit follows the axis (prices on linear, logs on log), so every
      // edge is a straight line on screen and two points draw it.
      if (cfg.channel.on) {
        const dev = cfg.channel.dev;
        // Start at the channel's first bar or just left of the plot, whichever
        // is later: the same line either way, but bounded geometry rasterises
        // identically at every zoom.
        const i0 = Math.max(channel.start, indexAt(plotL) - 1), i1 = indexAt(plotR);
        const x0 = xOf(i0), x1 = xOf(i1);
        const poly = (ka, kb, fill) => {
          ctx.fillStyle = fill; ctx.beginPath();
          ctx.moveTo(x0, yOf(channel.edge(i0, ka))); ctx.lineTo(x1, yOf(channel.edge(i1, ka)));
          ctx.lineTo(x1, yOf(channel.edge(i1, kb))); ctx.lineTo(x0, yOf(channel.edge(i0, kb)));
          ctx.closePath(); ctx.fill();
        };
        if (cfg.channel.fill > 0) {
          ctx.globalAlpha = cfg.channel.fill;
          poly(dev, 0, colors.accent);
          poly(0, -dev, colors.cold);
          ctx.globalAlpha = 1;
        }
        const ln = (k, color) => {
          ctx.strokeStyle = color; ctx.beginPath();
          ctx.moveTo(x0, yOf(channel.edge(i0, k))); ctx.lineTo(x1, yOf(channel.edge(i1, k))); ctx.stroke();
        };
        ln(dev, colors.accent);
        ln(-dev, colors.accent);
        ln(0, colors.cold);
      }

      // Bars: high-low stem, open tick left, close tick right.
      const tick = Math.max(1, Math.floor(view.barW * 0.36));
      const thin = view.barW < 2.5;
      ctx.globalAlpha = thin ? 0.85 : 1;
      for (let i = Math.max(0, from); i <= to; i++) {
        const up = c[i] >= o[i];
        ctx.strokeStyle = up ? colors.hot : colors.cold;
        const x = Math.round(xOf(i)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, yOf(h[i])); ctx.lineTo(x, yOf(l[i]));
        if (!thin) {
          const yo = Math.round(yOf(o[i])) + 0.5, yc = Math.round(yOf(c[i])) + 0.5;
          ctx.moveTo(x - tick, yo); ctx.lineTo(x, yo);
          ctx.moveTo(x, yc); ctx.lineTo(x + tick, yc);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Moving averages: one line each over the bars, broken where it has no value.
      for (const id of MAS) {
        if (!cfg[id].on) continue;
        const ma = mas[id];
        ctx.strokeStyle = css(INDICATORS[id].color); ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
        ctx.beginPath();
        let pen = false;
        for (let i = Math.max(0, from); i <= to; i++) {
          const v = ma[i];
          if (isNaN(v)) { pen = false; continue; }
          if (pen) ctx.lineTo(xOf(i), yOf(v)); else { ctx.moveTo(xOf(i), yOf(v)); pen = true; }
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Last price: dotted line across the plot.
      const last = c[n - 1], lastUp = last >= (n > 1 ? c[n - 2] : o[n - 1]);
      const tagColor = lastUp ? colors.hot : colors.cold;
      const ly = Math.round(yOf(last)) + 0.5;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = tagColor;
      ctx.beginPath(); ctx.moveTo(plotL, ly); ctx.lineTo(plotR, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      if (lowerOn()) drawLower(from, to);

      // Axis divider, the line between the panes, the time axis, and the
      // last-price tag on the axis.
      ctx.strokeStyle = colors.line;
      ctx.beginPath(); ctx.moveTo(plotR + 0.5, 0); ctx.lineTo(plotR + 0.5, timeY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, plotB + 0.5); ctx.lineTo(W, plotB + 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, timeY + 0.5); ctx.lineTo(W, timeY + 0.5); ctx.stroke();
      if (ly > plotT && ly < plotB) {
        ctx.fillStyle = tagColor;
        ctx.fillRect(plotR + 1, ly - 10, axisW - 1, 20);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(last), plotR + 8, ly);
      }
      drawCrosshair();
    }

    /* The rank pane: guide lines at 0, 50 and 100, the daily score as a line
       with a light fill beneath it or as bars from 0, broken where a day has
       no score, the latest value tagged on the axis, a grip on the divider
       that drags the pane taller or shorter, and a label that opens the
       settings when tapped. */
    function drawLower(from, to) {
      const color = css(INDICATORS.rank.color);
      ctx.save();
      ctx.beginPath(); ctx.rect(plotL, lowT, plotW(), lowB - lowT); ctx.clip();
      ctx.strokeStyle = colors.grid;
      for (const v of [0, 50, 100]) {
        const y = Math.round(yR(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
      }
      if (cfg.rank.style === 'bars') {
        const w = Math.max(1, view.barW * 0.7), y0 = yR(0);
        ctx.fillStyle = color; ctx.globalAlpha = 0.85;
        for (let i = Math.max(0, from); i <= to; i++) {
          if (rank[i] == null) continue;
          const y = yR(rank[i]);
          ctx.fillRect(xOf(i) - w / 2, y, w, Math.max(1, y0 - y));
        }
        ctx.globalAlpha = 1;
      } else {
        const runs = [];                       // stretches of consecutive scored bars
        for (let i = Math.max(0, from); i <= to; i++) {
          if (rank[i] == null) continue;
          if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i;
          else runs.push([i, i]);
        }
        ctx.fillStyle = color; ctx.globalAlpha = 0.08;
        for (const [a, b] of runs) {
          ctx.beginPath(); ctx.moveTo(xOf(a), yR(0));
          for (let i = a; i <= b; i++) ctx.lineTo(xOf(i), yR(rank[i]));
          ctx.lineTo(xOf(b), yR(0)); ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const [a, b] of runs) {
          ctx.moveTo(xOf(a), yR(rank[a]));
          for (let i = a + 1; i <= b; i++) ctx.lineTo(xOf(i), yR(rank[i]));
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = colors.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${INDICATORS.rank.name} ›`, plotL + 8, lowT + 6);
      ctx.restore();

      // The grip on the divider.
      ctx.fillStyle = colors.line;
      const gx = plotL + plotW() / 2;
      ctx.beginPath(); ctx.roundRect(gx - 16, plotB - 1.5, 32, 4, 2); ctx.fill();

      let lastI = n - 1;
      while (lastI >= 0 && rank[lastI] == null) lastI--;
      const tagY = lastI >= 0 ? Math.round(yR(rank[lastI])) + 0.5 : -1e9;
      ctx.fillStyle = colors.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (const v of [100, 50, 0]) {
        const y = yR(v);
        if (Math.abs(y - tagY) > 13) ctx.fillText(String(v), plotR + 8, y);
      }
      if (lastI >= 0) {
        ctx.fillStyle = color;
        ctx.fillRect(plotR + 1, tagY - 10, axisW - 1, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText(String(Math.round(rank[lastI])), plotR + 8, tagY);
      }
    }

    /* ---------- crosshair ----------
       Press and hold on either pane and a crosshair appears at that bar: a
       vertical through both panes that slides to each bar the finger passes
       rather than jumping, a horizontal at the finger, the date on the time
       axis, the price (or rank) at the finger on the axis, and a readout of
       the bar. It stays after the finger lifts; the next touch clears it. */
    let xh = null;                           // { i, x, y }: bar, eased line x, finger y
    const fmtDate = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;
    const fmtPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`;

    function drawCrosshair() {
      if (!xh) return;
      const tx = xOf(xh.i);
      if (Math.abs(tx - xh.x) > 0.3) { xh.x += (tx - xh.x) * TUNE.xhairEase; schedule(); } else xh.x = tx;
      const i = xh.i, x = Math.round(xh.x) + 0.5;
      const inLower = lowerOn() && xh.y >= plotB;
      const y = Math.round(clamp(xh.y, inLower ? lowT : plotT, inLower ? lowB : plotB)) + 0.5;
      ctx.save();
      ctx.beginPath(); ctx.rect(plotL, 0, plotW(), timeY); ctx.clip();
      ctx.strokeStyle = colors.ink; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, plotT); ctx.lineTo(x, timeY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const dot = (cx, cy, color) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = colors.bg; ctx.stroke();
      };
      const cy = yOf(c[i]);
      if (cy > plotT && cy < plotB) dot(x, cy, colors.ink);
      if (lowerOn() && rank[i] != null) dot(x, yR(rank[i]), css(INDICATORS.rank.color));
      ctx.restore();

      // Tags: the date on the time axis, the value under the finger on the price axis.
      ctx.textBaseline = 'middle';
      const label = fmtDate(dates[i]), lw = ctx.measureText(label).width + 12;
      const lx = clamp(x - lw / 2, plotL, plotR - lw);
      ctx.fillStyle = colors.ink;
      ctx.fillRect(lx, timeY + 3, lw, timeH - 6);
      ctx.fillStyle = colors.bg; ctx.textAlign = 'center';
      ctx.fillText(label, lx + lw / 2, timeY + timeH / 2);
      const value = inLower ? String(Math.round(clamp(rankAt(y), 0, 100))) : fmtPrice(priceAt(y));
      ctx.fillStyle = colors.ink;
      ctx.fillRect(plotR + 1, y - 10, axisW - 1, 20);
      ctx.fillStyle = colors.bg; ctx.textAlign = 'left';
      ctx.fillText(value, plotR + 8, y);

      // Readout, top left: the bar's date and close with its day change, then
      // open, high, low and the rank.
      const chg = i > 0 ? c[i] / c[i - 1] - 1 : 0;
      const line1 = [fmtDate(dates[i]), fmtPrice(c[i])], chgText = fmtPct(chg);
      const line2 = `O ${fmtPrice(o[i])}   H ${fmtPrice(h[i])}   L ${fmtPrice(l[i])}`
        + (rank ? `   Rank ${rank[i] == null ? '–' : rank[i].toFixed(1)}` : '');
      const w1 = ctx.measureText(line1.join('   ')).width + ctx.measureText('   ' + chgText).width;
      const bw = Math.max(w1, ctx.measureText(line2).width) + 16;
      ctx.globalAlpha = 0.88; ctx.fillStyle = colors.bg;
      ctx.fillRect(plotL + 6, plotT + 2, bw, 36);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.fillStyle = colors.ink;
      ctx.fillText(line1.join('   '), plotL + 14, plotT + 12);
      ctx.fillStyle = chg >= 0 ? colors.hot : colors.cold;
      ctx.fillText(chgText, plotL + 14 + ctx.measureText(line1.join('   ') + '   ').width, plotT + 12);
      ctx.fillStyle = colors.ink3;
      ctx.fillText(line2, plotL + 14, plotT + 28);
    }

    /* ---------- gestures ---------- */
    const pointers = new Map();
    let gesture = null;
    let lastAxisTap = 0;
    const zone = (x, y) => (
      y >= timeY ? 'time'
        : lowerOn() && Math.abs(y - plotB) <= TUNE.dividerGrab ? 'divider'
          : y >= plotB ? 'lower' : x >= plotR ? 'axis' : 'plot');
    const local = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

    function freeze() {
      if (view.auto) { [view.lo, view.hi] = autoRange(); view.auto = false; }
      tween = null;
    }

    function startSingle(p) {
      const z = zone(p.x, p.y);
      if (z === 'axis') {
        const now = performance.now();
        if (now - lastAxisTap < TUNE.doubleTapMs) { resetPrice(); lastAxisTap = 0; gesture = null; return; }
        lastAxisTap = now;
        freeze();
        gesture = { type: 'axis', y0: p.y, span0: spanT(), p0: priceAt(p.y), f: (p.y - plotT) / plotH() };
      } else if (z === 'time') {
        gesture = { type: 'time', x0: p.x, barW0: view.barW };
      } else if (z === 'divider') {
        gesture = { type: 'divider', y0: p.y, h0: cfg.rank.height };
      } else {
        // The lower pane pans time only: its scale is fixed.
        gesture = { type: 'pan', x: p.x, y: p.y, flat: z === 'lower' };
      }
    }

    /* A held finger on either pane becomes the crosshair; drifting more than
       a few pixels first makes it a pan instead, and a second finger cancels it. */
    let hold = null;
    const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
    function armHold(p) {
      const z = zone(p.x, p.y);
      if (z !== 'plot' && z !== 'lower') return;
      hold = { x: p.x, y: p.y, timer: setTimeout(() => {
        hold = null;
        if (pointers.size !== 1) return;
        gesture = { type: 'xhair' };
        xh = { i: barAt(p.x), x: p.x, y: p.y };
        schedule();
      }, TUNE.holdMs) };
    }

    function startPinch() {
      const [a, b] = [...pointers.values()];
      const dx = b.x - a.x, dy = b.y - a.y;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const vertical = Math.abs(dy) > Math.abs(dx) && mid.y < plotB;
      if (vertical) freeze();
      gesture = {
        type: 'pinch', vertical, d0: Math.hypot(dx, dy) || 1,
        barW0: view.barW, idx0: indexAt(mid.x),
        span0: spanT(), p0: priceAt(mid.y), f: (mid.y - plotT) / plotH(),
      };
    }

    function resetPrice() {
      const [lo, hi] = autoRange();
      tween = { t0: performance.now(), lo0: view.lo, hi0: view.hi, lo1: lo, hi1: hi };
      view.auto = true;
      schedule();
    }

    /* On release the range snaps outward to the tick step, so the axis always
       starts and ends on a round number. On a log axis the low end keeps its
       own, finer step, and never snaps to zero. */
    function snapPrice() {
      const loStep = tickStepAt(view.lo), hiStep = tickStepAt(view.hi);
      let lo = Math.floor(view.lo / loStep) * loStep;
      const hi = Math.ceil(view.hi / hiStep) * hiStep;
      if (isLog() && lo <= 0) lo = view.lo;
      tween = { t0: performance.now(), lo0: view.lo, hi0: view.hi, lo1: lo, hi1: hi };
      schedule();
    }

    /* Set the visible span (in transformed units) keeping the price p0 at
       fraction f of the plot height. Bounded to 40x either side of the auto
       range; a log axis is also capped at a 10,000-fold range. */
    function setSpan(span, p0, f) {
      const [alo, ahi] = autoRange();
      const base = T(ahi) - T(alo);
      const most = isLog() ? Math.min(base * 40, Math.log(1e4)) : base * 40;
      span = clamp(span, base / 40, most);
      const hiT = T(p0) + f * span;
      view.hi = Tinv(hiT);
      view.lo = Tinv(hiT - span);
    }

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());   // a hold is the crosshair, not a menu
    let down = null;                         // where and when the single finger landed
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      cancelHold();
      if (xh) { xh = null; schedule(); }
      if (pointers.size === 1) {
        const p = pointers.get(e.pointerId);
        down = { x: p.x, y: p.y, t: performance.now() };
        startSingle(p); armHold(p);
      } else if (pointers.size === 2) { down = null; startPinch(); }
      else gesture = null;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (hold && Math.hypot(p.x - hold.x, p.y - hold.y) > TUNE.holdSlop) cancelHold();
      if (!gesture) return;
      switch (gesture.type) {
        case 'xhair': {
          xh.i = barAt(clamp(p.x, plotL, plotR - 0.01)); xh.y = p.y;
          break;
        }
        case 'divider': {
          const [lo, hi] = INDICATORS.rank.limits.height;
          cfg.rank.height = clamp(gesture.h0 + (gesture.y0 - p.y) / H, lo, hi);
          layout(); clampView();
          break;
        }
        case 'pan': {
          view.right -= (p.x - gesture.x) / view.barW;
          if (!view.auto && !gesture.flat) {
            const dT = (p.y - gesture.y) * spanT() / plotH();
            const lo = Tinv(T(view.lo) + dT), hi = Tinv(T(view.hi) + dT);
            view.lo = lo; view.hi = hi;
          }
          gesture.x = p.x; gesture.y = p.y;
          clampView();
          break;
        }
        case 'axis': {
          const span = gesture.span0 * Math.pow(2, (p.y - gesture.y0) / TUNE.axisDragHalf);
          setSpan(span, gesture.p0, gesture.f);
          break;
        }
        case 'time': {
          view.barW = gesture.barW0 * Math.pow(2, (p.x - gesture.x0) / TUNE.timeDragDouble);
          clampView();
          break;
        }
        case 'pinch': {
          if (pointers.size < 2) return;
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (gesture.vertical) {
            setSpan(gesture.span0 * gesture.d0 / d, gesture.p0, gesture.f);
          } else {
            view.barW = gesture.barW0 * d / gesture.d0;
            clampView();
            view.right = gesture.idx0 + (plotR - mid.x) / view.barW;
            clampView();
          }
          break;
        }
      }
      schedule();
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.delete(e.pointerId);
      cancelHold();
      const g = gesture;                     // a crosshair stays put after the finger lifts
      gesture = null;
      if (g && (g.type === 'axis' || (g.type === 'pinch' && g.vertical))) snapPrice();
      if (g && g.type === 'divider' && opts.onChange) opts.onChange(cfg);
      // A short, still touch on the lower pane's label opens its settings.
      if (down && pointers.size === 0 && performance.now() - down.t < TUNE.tapMs
          && Math.hypot(p.x - down.x, p.y - down.y) <= TUNE.holdSlop && lowerOn() && opts.onOpen
          && down.x >= plotL && down.x <= plotL + LABEL.w && down.y >= lowT && down.y <= lowT + LABEL.h) {
        opts.onOpen('rank');
      }
      down = null;
      if (pointers.size === 1) startSingle([...pointers.values()][0]);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // Desktop convenience: wheel zooms time around the cursor.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const idx = indexAt(p.x);
      view.barW *= Math.pow(2, -e.deltaY / 300);
      clampView();
      view.right = idx + (plotR - p.x) / view.barW;
      clampView();
      schedule();
    }, { passive: false });

    readColors();
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', () => { readColors(); schedule(); });
    new ResizeObserver(resize).observe(canvas);
    resize();

    /* Live settings: merge what is given per key, recompute only what
       changed, and redraw on the next frame. A change of axis scale returns
       the price range to auto, since a hand-set linear range may include
       prices a log axis cannot show. */
    function set(next = {}) {
      const merged = {};
      for (const id of Object.keys(SPECS)) merged[id] = { ...cfg[id], ...(next[id] || {}) };
      const was = cfg;
      cfg = normalize(merged);
      const scaleChanged = cfg.axis.scale !== was.axis.scale;
      if (cfg.channel.len !== was.channel.len || scaleChanged) channel = regression(c, cfg.channel.len, cfg.axis.scale === 'log');
      for (const id of MAS) if (cfg[id].period !== was[id].period) mas[id] = sma(c, cfg[id].period);
      if (scaleChanged) { view.auto = true; tween = null; }
      if (cfg.rank.on !== was.rank.on || cfg.rank.height !== was.rank.height) { layout(); clampView(); }
      schedule();
    }

    return { zoom, set, indicators: () => cfg };
  }

  window.priceChart = priceChart;
  window.priceChart.INDICATORS = INDICATORS;   // app.js builds the panel and its defaults from these
  window.priceChart.AXIS = AXIS;
  window.priceChart.normalize = normalize;
})();
