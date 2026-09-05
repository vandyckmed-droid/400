/* Price chart prototype: daily bars on a canvas with the three gestures a phone
   needs — drag to pan time, pinch to zoom time, drag the price axis to stretch
   it — plus a linear regression channel over the last 200 bars.

   Written as one function, priceChart(canvas, bars, opts), with no dependency
   on the rest of the app so it can be lifted into app.js once the feel is
   right. Everything tunable sits in TUNE at the top. */
(function () {
  'use strict';

  const TUNE = {
    channelLen: 200,     // bars in the regression
    channelDev: 2,       // channel half-width in standard deviations
    channelFill: 0.07,   // default opacity of the two channel bands (0 = lines only)
    maxFill: 0.4,        // strongest fill the settings panel offers
    barW: 3,             // starting pixels per bar
    minBarW: 0.6,
    maxBarW: 40,
    pad: 0.06,           // auto-scale head/foot room as a share of the range
    rightRoom: 0.4,      // how far past the last bar you can pan, share of the plot width
    axisDragHalf: 110,   // px of axis drag that halves or doubles the price span
    timeDragDouble: 150, // px of time-axis drag that doubles bar width
    tickPx: 64,          // target pixels between price ticks
    dateLabelPx: 46,     // minimum pixels between date labels
    snapMs: 160,         // snap-to-nice animation
    doubleTapMs: 320,
  };

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* 1-2-5 steps: the nice step closest (in log terms) to `span / target`. */
  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.42 ? 1 : m < 3.17 ? 2 : m < 7.08 ? 5 : 10) * p;
  }

  const fmtPrice = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Ordinary least squares over the last `len` closes. Residual deviation is
     the population standard deviation, which is what the TradingView channel
     uses. Values are linear in bar index so the lines extend past the last bar. */
  function regression(c, len) {
    const n = c.length;
    len = Math.min(len, n);
    const start = n - len;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < len; i++) { const y = c[start + i]; sx += i; sy += y; sxx += i * i; sxy += i * y; }
    const slope = len > 1 ? (len * sxy - sx * sy) / (len * sxx - sx * sx) : 0;
    const intercept = (sy - slope * sx) / len;
    let ss = 0;
    for (let i = 0; i < len; i++) { const r = c[start + i] - (intercept + slope * i); ss += r * r; }
    return { start, len, slope, intercept, sd: Math.sqrt(ss / len), at: (i) => intercept + slope * (i - start) };
  }

  /* opts: { fill, onDraw }. `fill` is the channel band opacity; the app owns
     where it is stored and hands it in, and can change it later through the
     returned set(). */
  const fillValue = (v) => (typeof v === 'number' && isFinite(v)) ? Math.min(TUNE.maxFill, Math.max(0, v)) : TUNE.channelFill;

  function priceChart(canvas, bars, opts = {}) {
    const { dates, o, h, l, c } = bars;
    const n = c.length;
    const ctx = canvas.getContext('2d');
    const channel = regression(c, TUNE.channelLen);
    const cfg = { fill: fillValue(opts.fill) };

    // View state. `right` is the fractional bar index sitting at the right edge
    // of the plot; `auto` means the price range follows the visible bars.
    const view = { right: n + 2, barW: TUNE.barW, auto: true, lo: 0, hi: 1 };
    let W = 0, H = 0, dpr = 1, axisW = 64, timeH = 26, plotL = 0, plotR = 0, plotT = 8, plotB = 0;
    let colors = {};
    let raf = 0;
    let tween = null;

    const plotW = () => plotR - plotL;
    const plotH = () => plotB - plotT;
    const visible = () => plotW() / view.barW;
    const xOf = (i) => plotR - (view.right - i - 0.5) * view.barW;
    const indexAt = (x) => view.right - (plotR - x) / view.barW;
    const yOf = (v) => plotT + (view.hi - v) / (view.hi - view.lo) * plotH();
    const priceAt = (y) => view.hi - (y - plotT) / plotH() * (view.hi - view.lo);
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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
      plotL = 0; plotR = W - axisW; plotB = H - timeH;
      clampView();
      draw();
    }

    function clampView() {
      const minBar = Math.max(TUNE.minBarW, plotW() / (n * 1.15));
      view.barW = clamp(view.barW, minBar, TUNE.maxBarW);
      view.right = clamp(view.right, 8, n + TUNE.rightRoom * visible());
    }

    /* Auto range: the visible bars plus the channel where it is on screen. */
    function autoRange() {
      const from = Math.max(0, Math.floor(view.right - visible()));
      const to = Math.min(n - 1, Math.ceil(view.right));
      let lo = Infinity, hi = -Infinity;
      for (let i = from; i <= to; i++) { if (l[i] < lo) lo = l[i]; if (h[i] > hi) hi = h[i]; }
      const band = TUNE.channelDev * channel.sd;
      for (const i of [Math.max(from, channel.start), Math.min(view.right, n - 1 + TUNE.rightRoom * visible())]) {
        if (i < channel.start) continue;
        const m = channel.at(i);
        lo = Math.min(lo, m - band); hi = Math.max(hi, m + band);
      }
      if (!isFinite(lo)) { lo = c[n - 1] * 0.9; hi = c[n - 1] * 1.1; }
      const pad = (hi - lo || 1) * TUNE.pad;
      return [lo - pad, hi + pad];
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

      // Price ticks and horizontal grid.
      const step = niceStep(view.hi - view.lo, ph / TUNE.tickPx);
      const tagY = yOf(c[n - 1]);
      ctx.strokeStyle = colors.grid;
      ctx.fillStyle = colors.ink3;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(view.lo / step) * step; v <= view.hi; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
        if (Math.abs(y - tagY) > 14) ctx.fillText(fmtPrice(v), plotR + 8, y);
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
        ctx.beginPath(); ctx.moveTo(x, plotT); ctx.lineTo(x, plotB); ctx.stroke();
        ctx.fillStyle = mo === 0 ? colors.ink : colors.ink3;
        ctx.fillText(mo === 0 ? String(yr) : MONTHS[mo], x, plotB + timeH / 2);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(plotL, plotT, pw, ph); ctx.clip();

      // Regression channel: light fill, thin lines, extended to the right edge.
      {
        const band = TUNE.channelDev * channel.sd;
        const i0 = channel.start, i1 = indexAt(plotR);
        const x0 = xOf(i0), x1 = plotR;
        const m0 = channel.at(i0), m1 = channel.at(i1);
        const poly = (a0, a1, b0, b1, fill) => {
          ctx.fillStyle = fill; ctx.beginPath();
          ctx.moveTo(x0, yOf(a0)); ctx.lineTo(x1, yOf(a1)); ctx.lineTo(x1, yOf(b1)); ctx.lineTo(x0, yOf(b0));
          ctx.closePath(); ctx.fill();
        };
        if (cfg.fill > 0) {
          ctx.globalAlpha = cfg.fill;
          poly(m0 + band, m1 + band, m0, m1, colors.accent);
          poly(m0, m1, m0 - band, m1 - band, colors.cold);
          ctx.globalAlpha = 1;
        }
        const ln = (a0, a1, color) => {
          ctx.strokeStyle = color; ctx.beginPath();
          ctx.moveTo(x0, yOf(a0)); ctx.lineTo(x1, yOf(a1)); ctx.stroke();
        };
        ln(m0 + band, m1 + band, colors.accent);
        ln(m0 - band, m1 - band, colors.accent);
        ln(m0, m1, colors.cold);
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

      // Last price: dotted line across the plot.
      const last = c[n - 1], lastUp = last >= (n > 1 ? c[n - 2] : o[n - 1]);
      const tagColor = lastUp ? colors.hot : colors.cold;
      const ly = Math.round(yOf(last)) + 0.5;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = tagColor;
      ctx.beginPath(); ctx.moveTo(plotL, ly); ctx.lineTo(plotR, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Axis divider and the last-price tag on the axis.
      ctx.strokeStyle = colors.line;
      ctx.beginPath(); ctx.moveTo(plotR + 0.5, 0); ctx.lineTo(plotR + 0.5, plotB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, plotB + 0.5); ctx.lineTo(W, plotB + 0.5); ctx.stroke();
      if (ly > plotT && ly < plotB) {
        ctx.fillStyle = tagColor;
        ctx.fillRect(plotR + 1, ly - 10, axisW - 1, 20);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(last), plotR + 8, ly);
      }
      if (opts.onDraw) opts.onDraw(view);
    }

    /* ---------- gestures ---------- */
    const pointers = new Map();
    let gesture = null;
    let lastAxisTap = 0;
    const zone = (x, y) => (x >= plotR ? 'axis' : y >= plotB ? 'time' : 'plot');
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
        gesture = { type: 'axis', y0: p.y, span0: view.hi - view.lo, p0: priceAt(p.y), f: (p.y - plotT) / plotH() };
      } else if (z === 'time') {
        gesture = { type: 'time', x0: p.x, barW0: view.barW };
      } else {
        gesture = { type: 'pan', x: p.x, y: p.y };
      }
    }

    function startPinch() {
      const [a, b] = [...pointers.values()];
      const dx = b.x - a.x, dy = b.y - a.y;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const vertical = Math.abs(dy) > Math.abs(dx);
      if (vertical) freeze();
      gesture = {
        type: 'pinch', vertical, d0: Math.hypot(dx, dy) || 1,
        barW0: view.barW, idx0: indexAt(mid.x),
        span0: view.hi - view.lo, p0: priceAt(mid.y), f: (mid.y - plotT) / plotH(),
      };
    }

    function resetPrice() {
      const [lo, hi] = autoRange();
      tween = { t0: performance.now(), lo0: view.lo, hi0: view.hi, lo1: lo, hi1: hi };
      view.auto = true;
      schedule();
    }

    /* On release the range snaps outward to the tick step, so the axis always
       starts and ends on a round number. */
    function snapPrice() {
      const step = niceStep(view.hi - view.lo, plotH() / TUNE.tickPx);
      const lo = Math.floor(view.lo / step) * step, hi = Math.ceil(view.hi / step) * step;
      tween = { t0: performance.now(), lo0: view.lo, hi0: view.hi, lo1: lo, hi1: hi };
      schedule();
    }

    function setSpan(span, p0, f) {
      const auto = autoRange();
      span = clamp(span, (auto[1] - auto[0]) / 40, (auto[1] - auto[0]) * 40);
      view.hi = p0 + f * span;
      view.lo = view.hi - span;
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) startSingle(pointers.get(e.pointerId));
      else if (pointers.size === 2) startPinch();
      else gesture = null;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (!gesture) return;
      switch (gesture.type) {
        case 'pan': {
          view.right -= (p.x - gesture.x) / view.barW;
          if (!view.auto) {
            const dp = (p.y - gesture.y) * (view.hi - view.lo) / plotH();
            view.lo += dp; view.hi += dp;
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
      pointers.delete(e.pointerId);
      const g = gesture;
      gesture = null;
      if (g && (g.type === 'axis' || (g.type === 'pinch' && g.vertical))) snapPrice();
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

    /* Live settings: merge what is given and redraw on the next frame. */
    function set(next = {}) {
      if ('fill' in next) cfg.fill = fillValue(next.fill);
      schedule();
    }

    return { view, cfg, set, reset: resetPrice, redraw: schedule, channel, TUNE };
  }

  window.priceChart = priceChart;
  window.priceChart.TUNE = TUNE;
})();
