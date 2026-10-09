// ==UserScript==
// @name         Historical Forecast - AI Starter
// @namespace    http://tampermonkey.net/
// @version      0.12.0
// @description  Validate System Forecasts (Alpha + Lambda): reliability badges, data-quality overview, Booking Curve, Diagnostics
// @author       Gil Martins
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/alasql/4.6.6/alasql.min.js
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js
// @downloadURL  https://github.com/gmartins-tp/scripts/raw/refs/heads/main/historical_forecaster.user.js
// @updateURL    https://github.com/gmartins-tp/scripts/raw/refs/heads/main/historical_forecaster.user.js
// @noframes
// @grant unsafeWindow
// @grant GM_deleteValue
// @grant GM_listValues
// ==/UserScript==

// ─── STL / YoY Visualiser ───────────────────────────────────────────────────
// 0.12.0
//  - Methods are ranked 1–5 (most → least trustworthy). The rank is shown as a ladder on
//    every status strip, in the Data Quality tab (sortable worst-first) and explained in a
//    new "Reliability Guide" tab, which also shows how this result splits across methods.
//  - ALL (sum) alpha is no longer flagged.
// 0.11.0
//  - Result cache moved from GM_setValue to IndexedDB (a big GM cache exceeded the
//    64 MiB message limit and stopped ALL Tampermonkey scripts on the page).
//  - Every series gets a reliability level (Reliable / Caution / Unreliable /
//    Unknown) computed from the backend quality fields, shown in every view.
//  - New "Data Quality" tab, header bar with what the result is based on,
//    trend-shift overlay, residual diagnostics, per-type error handling.

(function() {
  'use strict';

  if (typeof Chart === 'undefined') {
    console.error('[RM AI] Chart.js not loaded. Ensure @require is in the metadata block.');
    return;
  }

  // Chart.js doesn't read CSS fonts – set them explicitly so modal & pop-out match
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#475569';

  const UI_VERSION = '0.12.0';

  const WEEK_TO_MONTH = {
    0: 'Jan', 4: 'Feb', 8: 'Mar', 13: 'Apr', 17: 'May', 21: 'Jun',
    26: 'Jul', 30: 'Aug', 34: 'Sep', 39: 'Oct', 43: 'Nov', 47: 'Dec'
  };
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Heuristic thresholds for the reliability level. Tune on real ODs.
  const EXCLUDED_CAUTION_SHARE = 0.02;   // share of rows excluded (zero / invalid)
  const CLIPPED_CAUTION_SHARE  = 0.05;   // the backend always clips ~2% by design
  const SMOOTH_WINDOW_DAYS     = 28;     // centred mean on the time-series chart

  // ── DCP windows ───────────────────────────────────────────────────────────
  const DCP_DATA = [
    {DCP:1,  "DyPr Start":364, "DyPr End":236, "Length (days)":129},
    {DCP:2,  "DyPr Start":235, "DyPr End":174, "Length (days)":62},
    {DCP:3,  "DyPr Start":173, "DyPr End":127, "Length (days)":47},
    {DCP:4,  "DyPr Start":126, "DyPr End":103, "Length (days)":24},
    {DCP:5,  "DyPr Start":102, "DyPr End":75,  "Length (days)":28},
    {DCP:6,  "DyPr Start":74,  "DyPr End":62,  "Length (days)":13},
    {DCP:7,  "DyPr Start":61,  "DyPr End":47,  "Length (days)":15},
    {DCP:8,  "DyPr Start":46,  "DyPr End":34,  "Length (days)":13},
    {DCP:9,  "DyPr Start":33,  "DyPr End":26,  "Length (days)":8},
    {DCP:10, "DyPr Start":25,  "DyPr End":18,  "Length (days)":8},
    {DCP:11, "DyPr Start":17,  "DyPr End":10,  "Length (days)":8},
    {DCP:12, "DyPr Start":9,   "DyPr End":8,   "Length (days)":2},
    {DCP:13, "DyPr Start":7,   "DyPr End":5,   "Length (days)":3},
    {DCP:14, "DyPr Start":4,   "DyPr End":2,   "Length (days)":3},
    {DCP:15, "DyPr Start":1,   "DyPr End":1,   "Length (days)":1},
    {DCP:16, "DyPr Start":0,   "DyPr End":0,   "Length (days)":1}
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE-SCOPE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function arrMean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

  function arrMedian(a) {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function fmtNum(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    return a < 1 ? v.toFixed(4) : a < 100 ? v.toFixed(2) : v.toFixed(1);
  }

  function fmtPct(r) {
    if (r == null || !Number.isFinite(r)) return '—';
    return `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
  }

  function depLabel(dep) { return dep === 'ALL' ? 'ALL (sum)' : dep; }

  // Backend series keys look like "dcp3_0800-1100"
  function friendlySource(key) {
    const m = String(key || '').match(/^dcp(\d+)_(.+)$/);
    return m ? `DCP ${m[1]} · ${depLabel(m[2])}` : String(key || 'another series');
  }

  // t in [-1, 1]; null → neutral grey. Blue = below, red = above.
  function divergingColor(t) {
    if (t == null || !Number.isFinite(t)) return '#f1f5f9';
    t = Math.max(-1, Math.min(1, t));
    if (t < 0) {
      const k = -t;
      return `rgb(${Math.round(255 - 229 * k)},${Math.round(255 - 140 * k)},${Math.round(255 - 23 * k)})`;
    }
    return `rgb(${Math.round(255 - 21 * t)},${Math.round(255 - 188 * t)},${Math.round(255 - 202 * t)})`;
  }

  // Centred mean over a CALENDAR window (points are {x: ms, y: number|null}).
  // Output only where the input has a value, like the EMA it replaces.
  function calendarMean(points, halfDays) {
    const half = halfDays * 86400000;
    const n = points.length;
    const prefSum = new Array(n + 1).fill(0);
    const prefCnt = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const v = points[i].y;
      const ok = v != null && Number.isFinite(v);
      prefSum[i + 1] = prefSum[i] + (ok ? v : 0);
      prefCnt[i + 1] = prefCnt[i] + (ok ? 1 : 0);
    }
    let lo = 0, hi = 0;
    return points.map((p, i) => {
      if (p.y == null || !Number.isFinite(p.y)) return { x: p.x, y: null };
      while (lo < n && points[lo].x < p.x - half) lo++;
      if (hi < i) hi = i;
      while (hi < n && points[hi].x <= p.x + half) hi++;
      const cnt = prefCnt[hi] - prefCnt[lo];
      return { x: p.x, y: cnt ? (prefSum[hi] - prefSum[lo]) / cnt : null };
    });
  }

  // ── Series reliability ───────────────────────────────────────────────────
  // Ranked from most to least trustworthy. `level` is the STARTING level of the method;
  // flags (regime shift, excluded rows, …) can only lower it. Texts feed the Guide tab and
  // describe the backend's default thresholds (they are configurable on the backend).
  const METHODS = {
    daily_stl: {
      rank: 1, short: 'D', label: 'daily STL', level: 'ok',
      what: 'Separates trend, weekly pattern and yearly seasonality directly on the actual daily values. Weekday factors come from real dates.',
      when: 'Nearly daily data: at least 85% of days present, no gap longer than 3 days, every weekday present in each 91-day block, stable flight days, and at least 2 years of history.',
      effect: 'Band and Booking Curve verdicts are shown normally.'
    },
    stl52: {
      rank: 2, short: 'W52', label: 'weekly STL (52 weeks)', level: 'ok',
      what: 'Estimates a weekday factor for each flight day, removes it, then separates trend and yearly seasonality on weekly levels.',
      when: 'Sparse or changing flight days with at least 105 weeks of history: 90+ observed weeks and 8+ observed weeks in every 13-week quarter of the last two years.',
      effect: 'Band and Booking Curve verdicts are shown normally.'
    },
    yoy_one_cycle: {
      rank: 3, short: '1Y', label: 'one-year seasonality', level: 'caution',
      what: 'Copies the seasonal shape of the last 52 weeks, with recent year-on-year growth removed. A one-off event in that year becomes "seasonality".',
      when: '65 to 104 weeks of history with at least 90% of the weeks observed.',
      effect: 'The band is rough (one year of history). Booking Curve verdicts are marked "Indicative".'
    },
    borrowed: {
      rank: 4, short: 'B', label: 'borrowed seasonality', level: 'caution',
      what: 'Applies the seasonal shape of a longer series from the same DCP. Level and weekday effects stay the series\' own.',
      when: 'Too little history for the methods above, and a donor series explains at least 25% of the variation with a scale between 0.5 and 1.5.',
      effect: 'Booking Curve verdicts are marked "Indicative". The donor is named in the status strip.'
    },
    none: {
      rank: 5, short: '—', label: 'no seasonality separated', level: 'bad',
      what: 'Separates nothing. The trend is a 13-week average and still follows the seasons, so the expected value is wrong in peaks and valleys.',
      when: 'A gap longer than 2 weeks, or too little history and no usable donor.',
      effect: 'The band is hidden and Booking Curve verdicts are not shown.'
    },
    error: { rank: null, short: 'ERR', label: 'error', level: 'bad' }
  };
  const METHOD_ORDER = ['daily_stl', 'stl52', 'yoy_one_cycle', 'borrowed', 'none'];
  // Worst first, for sorting
  const LEVEL_ORDER = { bad: 0, unknown: 1, caution: 2, ok: 3 };
  const LEVEL_LABEL = { ok: 'Reliable', caution: 'Caution', bad: 'Unreliable', unknown: 'Quality unknown' };

  // Turns backend error strings into something a user can act on.
  function friendlyError(msg) {
    const m = String(msg || '');
    let r;
    if ((r = m.match(/Need at least (\d+) historical points for DCP (\d+); got (\d+)/))) {
      return `Not enough history: ${r[3]} observations (needs ${r[1]}).`;
    }
    if (/valid positive observations/i.test(m)) return 'Not enough valid observations after excluding zero/invalid values.';
    if (/ZERO_POLICY/.test(m)) return 'The series contains zero values and the backend is set to reject them.';
    if (/No positive observations|No finite positive/i.test(m)) return 'No valid positive observations.';
    if (/gaps longer than/i.test(m)) return 'The data has gaps longer than the backend can bridge.';
    return m.replace(/^\w*Error:\s*/, '');
  }

  // Returns { level: ok|caution|bad|unknown, label, method, reasons[] }.
  // Old results (no quality fields) are never "ok".
  function assessSeries(d, ctx) {
    ctx = ctx || {};
    const reasons = [];
    const add = (sev, text, pinned) => reasons.push({ sev, text, pinned: !!pinned });
    let unknown = false;
    let method = null;

    if (!d) {
      add('bad', 'No result for this series.');
    } else if (d.error) {
      method = 'error';
      add('bad', friendlyError(d.error));
    } else if (d.decomp_method === undefined) {
      unknown = true;
      add('info', 'Quality unknown: the backend did not report decomposition details (older backend version).');
    } else {
      method = d.decomp_method;
      const dc = d.decomposition_checks || {};

      if (method === 'none' || dc.long_gap || d.has_yearly_seasonality === false) {
        add('bad', 'Not enough continuous history to separate seasonality from trend. The trend follows the seasons.' +
          (dc.long_gap ? ' A gap in the data is longer than the backend can bridge.' : ''));
      } else if (method === 'yoy_one_cycle') {
        add('caution', 'Seasonality is copied from a single year. There is no year-to-year spread.');
      } else if (method === 'borrowed') {
        const dn = d.seasonality_donor;
        const share = dn && dn.variance_explained != null ? ` (explains ${(dn.variance_explained * 100).toFixed(0)}% of the variation)` : '';
        add('caution', `Seasonality borrowed from ${friendlySource(dn && dn.source)}${share}.`);
      }

      const rs = d.regime_shift;
      if (rs && rs.detected) {
        const sign = (rs.raw_shift || 0) >= 0 ? '+' : '−';
        add('caution', `Recent level shift (${sign}${((rs.relative_shift || 0) * 100).toFixed(1)}% of trend, confidence ${(rs.confidence || 0).toFixed(2)}) was added to the trend.`);
      }
      if (d.dow_identifiable === false) {
        add('caution', 'Weekday schedules never overlap, so weekday effects are not comparable across schedules.');
      }
      if (dc.median_polish_converged === false) {
        add('caution', 'The weekday adjustment did not converge.');
      }

      const dq = d.data_quality;
      if (dq && dq.excluded_count > 0) {
        const share = dq.excluded_count / Math.max(dq.input_rows || 1, 1);
        add(share >= EXCLUDED_CAUTION_SHARE ? 'caution' : 'info',
          `${dq.excluded_count} of ${dq.input_rows} observations excluded (zero or invalid values).`);
      }
      if (dq && dq.clipped_count > 0 && (dq.used_rows || 0) > 0) {
        const share = dq.clipped_count / dq.used_rows;
        if (share >= CLIPPED_CAUTION_SHARE) {
          add('caution', `${dq.clipped_count} of ${dq.used_rows} observations were clipped for fitting (charts show unclipped values).`);
        }
      }
      if (d.schedule_stable === false) {
        add('info', 'Flight days changed over time (weekday schedule is not stable).');
      }
    }

    const order = { bad: 0, caution: 1, info: 2 };
    reasons.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (order[a.sev] - order[b.sev]));

    let level = 'ok';
    if (reasons.some(r => r.sev === 'bad')) level = 'bad';
    else if (unknown) level = 'unknown';
    else if (reasons.some(r => r.sev === 'caution')) level = 'caution';
    return { level, label: LEVEL_LABEL[level], method, rank: METHODS[method]?.rank ?? null, reasons };
  }

  function levelCounts(assessments) {
    const c = { ok: 0, caution: 0, bad: 0, unknown: 0 };
    assessments.forEach(a => { if (a) c[a.level]++; });
    return c;
  }

  // How many series of a store use each method (plus error / unknown)
  function methodCounts(store) {
    const c = { daily_stl: 0, stl52: 0, yoy_one_cycle: 0, borrowed: 0, none: 0, error: 0, unknown: 0, total: 0 };
    Object.keys(store || {}).forEach(k => {
      const d = store[k];
      const m = !d || d.error ? 'error' : (d.decomp_method === undefined ? 'unknown' : d.decomp_method);
      c[m in c ? m : 'unknown']++;
      c.total++;
    });
    return c;
  }

  function countsText(c) {
    const parts = [`${c.ok} reliable`, `${c.caution} caution`, `${c.bad} unreliable`];
    if (c.unknown) parts.push(`${c.unknown} unknown`);
    return parts.join(' · ');
  }

  // ── Booking-curve helpers ────────────────────────────────────────────────
  function isoWeekYear(dateStr) {
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;            // Mon = 0
    d.setUTCDate(d.getUTCDate() - day + 3);          // Thursday of this ISO week
    const year = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round(
      ((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7
    );
    return { year, week };
  }

  // Groups every series of one (type, departure time) by DCP and ISO year-week.
  function buildCurveIndex(store, dep, dcps) {
    const byDcp = {};
    const forecastWeeks = new Map();

    for (const dcp of dcps) {
      const d = store[`dcp${dcp}_${dep}`];
      const groups = new Map();
      byDcp[dcp] = { groups };
      if (!d || d.error) continue;

      const add = (dates, values, field) => {
        if (!dates || !values) return;
        for (let i = 0; i < dates.length; i++) {
          const v = values[i];
          if (v == null || !Number.isFinite(v)) continue;
          const ds = String(dates[i]).slice(0, 10);
          const { year, week } = isoWeekYear(ds);
          const k = `${year}-${week}`;
          let g = groups.get(k);
          if (!g) { g = { year, week, act: [], sys: [], inf: [] }; groups.set(k, g); }
          g[field].push(v);

          if (field !== 'act') {
            let fw = forecastWeeks.get(k);
            if (!fw) {
              fw = { key: k, year, week, minDate: ds, maxDate: ds, influenced: false };
              forecastWeeks.set(k, fw);
            }
            if (ds < fw.minDate) fw.minDate = ds;
            if (ds > fw.maxDate) fw.maxDate = ds;
          }
        }
      };

      add(d.historical?.dates, d.historical?.actual, 'act');
      add(d.system_forecast?.dates, d.system_forecast?.values, 'sys');
      add(d.influenced_forecast?.dates, d.influenced_forecast?.values, 'inf');
    }

    for (const fw of forecastWeeks.values()) {
      fw.influenced = dcps.some(dcp => {
        const g = byDcp[dcp].groups.get(fw.key);
        if (!g || !g.sys.length || !g.inf.length) return false;
        const s = arrMean(g.sys), i = arrMean(g.inf);
        return s !== 0 && Math.abs(i - s) / Math.abs(s) > 0.01;
      });
    }

    const weeks = [...forecastWeeks.values()]
      .sort((a, b) => (a.minDate < b.minDate ? -1 : a.minDate > b.minDate ? 1 : 0));
    return { byDcp, weeks };
  }

  // One DCP row for the selected week: this year vs the same ISO week in previous years.
  function curveRow(index, dcp, fw) {
    const groups = index.byDcp[dcp]?.groups || new Map();
    const cur = groups.get(fw.key);

    const hist = [];
    for (const g of groups.values()) {
      if (g.week === fw.week && g.year < fw.year && g.act.length) {
        hist.push({ year: g.year, value: arrMean(g.act) });
      }
    }
    const vals = hist.map(h => h.value);

    return {
      dcp,
      act: cur?.act.length ? arrMean(cur.act) : null,
      sys: cur?.sys.length ? arrMean(cur.sys) : null,
      inf: cur?.inf.length ? arrMean(cur.inf) : null,
      nYears: vals.length,
      histMedian: vals.length ? arrMedian(vals) : null,
      histMin: vals.length >= 2 ? Math.min(...vals) : null,
      histMax: vals.length >= 2 ? Math.max(...vals) : null,
      lastYear: hist.find(h => h.year === fw.year - 1)?.value ?? null,
    };
  }

  // Base assessment of a DCP row, then downgraded by the quality of its series:
  //   Unreliable → not assessed, Caution/Unknown → "Indicative · …".
  function curveFlag(r) {
    const q = r.assess;
    let base;
    if (r.inf == null) {
      base = r.act != null ? { text: 'Realized', cls: 'muted' } : { text: '—', cls: 'muted' };
      return base;
    }
    if (q && q.level === 'bad') {
      return { text: 'Not assessed (unreliable series)', cls: 'muted' };
    }
    if (r.nYears < 2) {
      return { text: r.nYears ? '1 year of history' : 'No history', cls: 'muted' };
    }
    const out = v => v != null && (v > r.histMax || v < r.histMin);
    const infOut = out(r.inf), sysOut = out(r.sys);
    if (infOut && !sysOut)      base = { text: 'Influence moves outside range', cls: 'high' };
    else if (infOut && sysOut)  base = { text: 'Both outside range', cls: 'warn' };
    else if (!infOut && sysOut) base = { text: 'Influence brings back into range', cls: 'ok' };
    else                        base = { text: 'Within range', cls: 'ok' };

    if (q && (q.level === 'caution' || q.level === 'unknown')) {
      return { text: `Indicative · ${base.text}`, cls: base.cls, indicative: true };
    }
    return base;
  }

  // Shades the window where a regime-shift correction was applied to the trend.
  const regimeShadePlugin = {
    id: 'regimeShade',
    beforeDatasetsDraw(chart) {
      const w = chart.options?.plugins?.regimeShade?.window;
      if (!w || !chart.scales?.x || !chart.chartArea) return;
      const area = chart.chartArea;
      const x0 = Math.max(chart.scales.x.getPixelForValue(w.from), area.left);
      const x1 = Math.min(chart.scales.x.getPixelForValue(w.to), area.right);
      if (!(x1 > x0)) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
      ctx.fillRect(x0, area.top, x1 - x0, area.bottom - area.top);
      ctx.restore();
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // MODAL RENDERER
  // ═══════════════════════════════════════════════════════════════════════

  window.showStlModal = function(analysisJson, opts) {
    opts = opts || {};

    // ── Support combined format {alpha, lambda, meta, errors} and legacy single format ──
    let byDcpAlpha, byDcpLambda, hasBothTypes;
    let errors = {};
    let results = [];
    if (analysisJson && (analysisJson.alpha !== undefined || analysisJson.lambda !== undefined)) {
      byDcpAlpha   = analysisJson.alpha?.by_dcp || {};
      byDcpLambda  = analysisJson.lambda?.by_dcp || {};
      hasBothTypes = true;
      errors       = analysisJson.errors || {};
      results      = [analysisJson.alpha, analysisJson.lambda].filter(Boolean);
    } else {
      byDcpLambda  = analysisJson?.by_dcp || {};
      byDcpAlpha   = {};
      hasBothTypes = false;
      results      = analysisJson ? [analysisJson] : [];
    }
    const meta = analysisJson?.meta || null;

    const keys = [...new Set([...Object.keys(byDcpAlpha), ...Object.keys(byDcpLambda)])];
    if (!keys.length) {
      alert('No DCP data found in analysis result.');
      return;
    }

    const parsed = keys.map(k => {
      const m = k.match(/^dcp(\d+)_(.+)$/);
      return m ? { key: k, dcp: parseInt(m[1]), dep: m[2] } : null;
    }).filter(Boolean);

    const allDcps = [...new Set(parsed.map(m => m.dcp))].sort((a, b) => a - b);
    const allDeps = [...new Set(parsed.map(m => m.dep))].sort();

    // ─── Styles ──────────────────────────────────────────────────────────────
    const styleId = 'rm-stl-modal-styles';
    if (!document.getElementById(styleId)) {
      const css = document.createElement('style');
      css.id = styleId;
      css.textContent = `
        .stl-modal-overlay {
          position: fixed; inset: 0; z-index: 99999;
          background: rgba(0,0,0,0.65);
          display: flex; align-items: center; justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .stl-modal {
          background: #fff; border-radius: 10px;
          width: 95vw; height: 96vh; max-width: 1600px;
          display: flex; flex-direction: column;
          box-shadow: 0 20px 60px rgba(0,0,0,0.35);
          overflow: hidden;
        }
        .stl-modal__header {
          padding: 14px 20px; border-bottom: 1px solid #e2e8f0;
          display: flex; align-items: center; justify-content: space-between;
          background: #f8fafc;
        }
        .stl-modal__title { font-size: 16px; font-weight: 600; color: #1e293b; margin: 0; }
        .stl-modal__close {
          background: #e2e8f0; border: none; border-radius: 6px;
          width: 32px; height: 32px; font-size: 18px; cursor: pointer;
          color: #475569; line-height: 1; transition: background .15s;
        }
        .stl-modal__close:hover { background: #cbd5e1; color: #0f172a; }
        .stl-modal__tabs {
          display: flex; gap: 0; border-bottom: 1px solid #e2e8f0;
          background: #fff;
        }
        .stl-tab {
          padding: 10px 20px; font-size: 13px; font-weight: 500;
          color: #64748b; cursor: pointer; border-bottom: 2px solid transparent;
          transition: all .15s; background: none; border: none;
        }
        .stl-tab:hover { color: #334155; background: #f8fafc; }
        .stl-tab.active {
          color: #1a73e8; border-bottom-color: #1a73e8; background: #fff;
        }
        .stl-modal__controls {
          padding: 12px 20px; border-bottom: 1px solid #e2e8f0;
          display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
          background: #fff;
        }
        .stl-control { display: flex; flex-direction: column; gap: 4px; }
        .stl-control label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.4px; }
        .stl-control select, .stl-control button {
          padding: 6px 10px; border-radius: 6px; border: 1px solid #cbd5e1;
          font-size: 13px; background: #fff; color: #334155; min-width: 120px;
        }
        .stl-toggle-group { display: flex; gap: 0; }
        .stl-toggle-group button {
          border-radius: 0; min-width: 80px; cursor: pointer; border-color: #cbd5e1;
          background: #f1f5f9; font-weight: 500;
        }
        .stl-toggle-group button:first-child { border-radius: 6px 0 0 6px; border-right: none; }
        .stl-toggle-group button:last-child { border-radius: 0 6px 6px 0; }
        .stl-toggle-group button.active { background: #1a73e8; color: #fff; border-color: #1a73e8; }
        .stl-modal__body {
          flex: 1; min-height: 0; overflow-y: auto; padding: 12px 20px;
          display: flex; flex-direction: column; gap: 12px;
        }
        .stl-tab-panel { display: none; }
        .stl-tab-panel.active { display: flex; flex-direction: column; gap: 20px; }
        .stl-chart-box {
          background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
          padding: 12px; position: relative;
        }
        .stl-chart-box__title {
          font-size: 13px; font-weight: 600; color: #334155;
          margin-bottom: 8px; display: flex; align-items: center; gap: 8px;
        }
        .stl-chart-box__title span { color: #94a3b8; font-weight: 400; }
        .stl-chart-wrap { position: relative; height: 340px; width: 100%; }

        /* Time-series tab: the two charts share the available modal height */
        .stl-tab-panel[data-panel="time-series"].active {
          flex: 1 1 auto;
          min-height: 0;
        }
        .stl-tab-panel[data-panel="time-series"] .stl-chart-box {
          flex: 1 1 0;
          min-height: 260px;
          display: flex;
          flex-direction: column;
        }
        .stl-tab-panel[data-panel="time-series"] .stl-chart-wrap {
          flex: 1 1 auto;
          height: auto;
          min-height: 0;
        }

        .stl-empty-state {
          display: flex; align-items: center; justify-content: center;
          height: 200px; color: #94a3b8; font-size: 13px; text-align: center; padding: 0 16px;
        }
        .heatmap-grid {
          display: grid;
          gap: 2px;
          font-size: 11px;
          font-family: monospace;
        }
        .heatmap-cell {
          padding: 4px 6px;
          text-align: center;
          border-radius: 3px;
          min-width: 50px;
          cursor: default;
          transition: transform .1s;
        }
        .heatmap-cell:hover {
          transform: scale(1.15);
          z-index: 10;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        .heatmap-row-label {
          padding: 4px 8px;
          font-weight: 600;
          color: #475569;
          text-align: right;
        }
        .heatmap-col-label {
          padding: 2px 4px;
          font-size: 10px;
          color: #64748b;
          text-align: center;
        }
        .heatmap-legend {
          display: flex; align-items: center; gap: 8px; margin-top: 12px;
          font-size: 12px; color: #64748b;
        }
        .heatmap-legend-bar {
          width: 200px; height: 12px; border-radius: 6px;
          background: linear-gradient(to right, #1a73e8, #e2e8f0, #ea4335);
        }
        .quadrant-svg { width: 100%; height: 100%; }
        .quadrant-point { cursor: pointer; transition: r .15s; }
        .quadrant-point:hover { r: 8; }
        .quadrant-label { font-size: 11px; fill: #64748b; }
        .quadrant-axis { stroke: #cbd5e1; stroke-width: 1; }
        .quadrant-median { stroke: #94a3b8; stroke-width: 1; stroke-dasharray: 4,4; }
        .quadrant-quad-label {
          font-size: 13px; font-weight: 600; fill: #e2e8f0;
          text-anchor: middle; dominant-baseline: middle;
        }
        .quadrant-tooltip {
          position: absolute; background: rgba(15,23,42,0.9); color: #fff;
          padding: 8px 12px; border-radius: 6px; font-size: 12px;
          pointer-events: none; z-index: 100; display: none;
          white-space: pre-line; line-height: 1.5;
        }
        .stl-modal-overlay { background: transparent; pointer-events: none; }
        .stl-modal { pointer-events: auto; }

        /* booking curve */
        .curve-controls { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
        .curve-controls select { min-width: 260px; }
        .curve-log { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; }
        .curve-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
        .curve-table th, .curve-table td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; text-align: right; white-space: nowrap; }
        .curve-table th { color: #64748b; font-weight: 600; background: #f8fafc; position: sticky; top: 0; }
        .curve-table td:first-child, .curve-table th:first-child,
        .curve-table td:last-child,  .curve-table th:last-child { text-align: left; }
        .curve-flag { padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px; }
        .curve-flag.high  { background: #fde8e6; color: #b3261e; }
        .curve-flag.warn  { background: #fef3c7; color: #92400e; }
        .curve-flag.ok    { background: #dcfce7; color: #166534; }
        .curve-flag.muted { background: #f1f5f9; color: #64748b; }
        .curve-flag.indicative { border: 1px dashed currentColor; background: #fff; font-weight: 500; }
        .curve-note { font-size: 11px; color: #94a3b8; margin-top: 6px; }

        /* header bar, status strips, badges */
        .stl-meta {
          padding: 8px 20px; border-bottom: 1px solid #e2e8f0; background: #fff;
          display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center;
          font-size: 12px; color: #334155;
        }
        .stl-chip b {
          color: #64748b; font-weight: 600; margin-right: 5px;
          text-transform: uppercase; font-size: 10px; letter-spacing: 0.4px;
        }
        .stl-chip--warn { color: #92400e; }
        .stl-banner { width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
        .stl-banner--bad  { background: #fde8e6; color: #b3261e; }
        .stl-banner--warn { background: #fef3c7; color: #92400e; }
        .stl-status {
          display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
          padding: 6px 10px; border-radius: 6px; font-size: 12px;
          margin-bottom: 8px; border: 1px solid transparent;
        }
        .stl-status--ok      { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
        .stl-status--caution { background: #fffbeb; border-color: #fde68a; color: #92400e; }
        .stl-status--bad     { background: #fef2f2; border-color: #fecaca; color: #b3261e; }
        .stl-status--unknown { background: #f1f5f9; border-color: #cbd5e1; color: #475569; }
        .stl-status__method { color: #64748b; }
        .stl-status__reason--info { color: #64748b; }
        .stl-status__more { text-decoration: underline dotted; cursor: help; }
        .stl-badge {
          padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; white-space: nowrap;
        }
        .stl-badge--ok      { background: #dcfce7; color: #166534; }
        .stl-badge--caution { background: #fef3c7; color: #92400e; }
        .stl-badge--bad     { background: #fde8e6; color: #b3261e; }
        .stl-badge--unknown { background: #e2e8f0; color: #475569; }
        .stl-note { font-size: 11px; color: #94a3b8; margin-top: 6px; }

        /* data-quality matrix */
        .stl-q-section { margin-bottom: 18px; }
        .stl-q-title { font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 4px; }
        .stl-q-counts { font-size: 12px; color: #64748b; margin-bottom: 8px; }
        .stl-q-wrap { overflow-x: auto; }
        .stl-q { border-collapse: separate; border-spacing: 3px; font-size: 12px; }
        .stl-q th { color: #64748b; font-weight: 600; padding: 2px 6px; text-align: center; }
        .stl-q td.stl-q-row { text-align: right; font-weight: 600; color: #475569; padding-right: 8px; white-space: nowrap; }
        .stl-qcell {
          min-width: 46px; border: 1px solid transparent; border-radius: 4px; padding: 4px 6px;
          font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit;
        }
        .stl-qcell:hover { box-shadow: 0 0 0 2px rgba(26,115,232,0.35); }
        .stl-qcell--ok      { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
        .stl-qcell--caution { background: #fef3c7; color: #92400e; border-color: #fde68a; }
        .stl-qcell--bad     { background: #fde8e6; color: #b3261e; border-color: #fecaca; }
        .stl-qcell--unknown { background: #e2e8f0; color: #475569; border-color: #cbd5e1; }
        .stl-qcell--none    { background: #f8fafc; color: #cbd5e1; cursor: default; }
        .stl-q-legend { font-size: 11px; color: #94a3b8; margin-top: 8px; }
        .stl-q-legend .stl-code { margin: 0 2px; }
        .stl-q-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
        .stl-q-tools label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.4px; }
        .stl-q-bymethod { font-size: 12px; color: #64748b; margin-bottom: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }

        /* method ladder + codes + links */
        .stl-ladder { display: inline-flex; gap: 2px; align-items: center; }
        .stl-ladder__step {
          min-width: 26px; padding: 1px 5px; border-radius: 4px; font-size: 10px; font-weight: 700;
          text-align: center; background: #f1f5f9; color: #94a3b8; border: 1px solid #e2e8f0;
        }
        .stl-ladder__step--active.stl-ladder__step--ok      { background: #16a34a; color: #fff; border-color: #16a34a; }
        .stl-ladder__step--active.stl-ladder__step--caution { background: #d97706; color: #fff; border-color: #d97706; }
        .stl-ladder__step--active.stl-ladder__step--bad     { background: #dc2626; color: #fff; border-color: #dc2626; }
        .stl-code {
          display: inline-block; min-width: 26px; padding: 1px 5px; border-radius: 4px; font-size: 10px;
          font-weight: 700; text-align: center; border: 1px solid transparent;
        }
        .stl-code--ok      { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
        .stl-code--caution { background: #fef3c7; color: #92400e; border-color: #fde68a; }
        .stl-code--bad     { background: #fde8e6; color: #b3261e; border-color: #fecaca; }
        .stl-code--unknown { background: #e2e8f0; color: #475569; border-color: #cbd5e1; }
        .stl-link {
          background: none; border: none; padding: 0; margin-left: auto; font: inherit; font-size: 12px;
          color: #1a73e8; text-decoration: underline; cursor: pointer; min-width: 0;
        }
        .stl-badge--info { background: #f1f5f9; color: #64748b; }

        /* reliability guide */
        .stl-g-wrap { overflow-x: auto; }
        .stl-g { border-collapse: collapse; width: 100%; font-size: 12px; }
        .stl-g th { text-align: left; color: #64748b; font-weight: 600; background: #f8fafc; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
        .stl-g td { padding: 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; color: #334155; line-height: 1.45; }
        .stl-g td:first-child { width: 44px; }
        .stl-g-order {
          display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
          border-radius: 50%; background: #1e293b; color: #fff; font-weight: 700; font-size: 12px;
        }
        .stl-g-p { font-size: 12px; color: #334155; line-height: 1.55; margin-bottom: 8px; }
        .stl-bar-cell { display: flex; align-items: center; gap: 8px; min-width: 160px; }
        .stl-bar { flex: 1; height: 10px; background: #f1f5f9; border-radius: 5px; overflow: hidden; }
        .stl-bar__fill { display: block; height: 100%; }
        .stl-bar__fill--ok { background: #16a34a; }
        .stl-bar__fill--caution { background: #d97706; }
        .stl-bar__fill--bad { background: #dc2626; }
        .stl-bar__fill--unknown { background: #94a3b8; }
      `;
      document.head.appendChild(css);
    }

    // ─── Build DOM ───────────────────────────────────────────────────────────
    document.querySelectorAll('.stl-modal-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'stl-modal-overlay';
    overlay.innerHTML = `
      <div class="stl-modal">
        <div class="stl-modal__header">
          <h3 class="stl-modal__title">Seasonality YoY Analysis Viewer</h3>
          <div style="display:flex; gap:6px;">
            <button class="stl-modal__close stl-modal__popout" title="Open in separate window">⧉</button>
            <button class="stl-modal__close stl-modal__x" title="Close">×</button>
          </div>
        </div>
        <div class="stl-meta" id="stl-meta"></div>
        <div class="stl-modal__tabs">
          <button class="stl-tab active" data-tab="time-series">Time Series &amp; Seasonality</button>
          <button class="stl-tab" data-tab="booking-curve">Booking Curve</button>
          <button class="stl-tab" data-tab="quality">Data Quality</button>
          <button class="stl-tab" data-tab="guide">Reliability Guide</button>
          <button class="stl-tab" data-tab="diagnostics">Diagnostics</button>
        </div>
        <div class="stl-modal__controls">
          ${hasBothTypes ? `
          <div class="stl-control" id="stl-ctl-type">
            <label>Analysis Type</label>
            <select id="stl-select-type">
              <option value="lambda" selected>Lambda</option>
              <option value="alpha">Alpha</option>
            </select>
          </div>
          ` : ''}
          <div class="stl-control" id="stl-ctl-dcp">
            <label>DCP</label>
            <select id="stl-select-dcp">${allDcps.map(d => `<option value="${d}">DCP ${d}</option>`).join('')}</select>
          </div>
          <div class="stl-control" id="stl-ctl-dep">
            <label>Departure Time</label>
            <select id="stl-select-dep">${allDeps.map(d => `<option value="${esc(d)}">${esc(depLabel(d))}</option>`).join('')}</select>
          </div>
          <div class="stl-control" id="stl-ctl-scale" style="margin-left:auto;">
            <label>Seasonality Scale</label>
            <div class="stl-toggle-group" id="stl-scale-toggle">
              <button class="active" data-mode="absolute">Absolute</button>
              <button data-mode="relative">Relative</button>
            </div>
          </div>
        </div>
        <div class="stl-modal__body">
          <!-- TAB 1: Time Series & Seasonality -->
          <div class="stl-tab-panel active" data-panel="time-series">
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Time Series <span id="ts-subtitle"></span></div>
              <div id="ts-status"></div>
              <div class="stl-chart-wrap"><canvas id="stl-chart-ts"></canvas></div>
            </div>
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Weekly Seasonality <span id="seas-subtitle"></span></div>
              <div id="seas-status"></div>
              <div class="stl-chart-wrap"><canvas id="stl-chart-seas"></canvas></div>
              <div class="stl-note" id="seas-note"></div>
            </div>
          </div>
          <!-- TAB 2: Booking Curve -->
          <div class="stl-tab-panel" data-panel="booking-curve">
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Booking Curve Profile <span id="curve-subtitle"></span></div>
              <div id="curve-status"></div>
              <div class="curve-controls">
                <div class="stl-control">
                  <label>Departure Week (★ = influenced)</label>
                  <select id="stl-curve-week"></select>
                </div>
                <div class="stl-control">
                  <label>Scale</label>
                  <div class="stl-toggle-group" id="stl-curve-scale">
                    <button class="active" data-mode="raw">Raw</button>
                    <button data-mode="index">Index vs history</button>
                  </div>
                </div>
                <label class="curve-log"><input type="checkbox" id="stl-curve-log"> Log axis</label>
              </div>
              <div class="stl-chart-wrap" style="height: 380px;"><canvas id="stl-chart-curve"></canvas></div>
              <div class="curve-note">
                History = weekly mean of past actuals for the same ISO week and DCP. Range shown with ≥ 2 previous years.
                Levels are not trend-adjusted: if the system forecast is also outside the range, it is market level, not the influence.
                Zero/invalid observations are excluded from history, so weeks that contained them can look higher than they were.
                Moving holidays (Easter, Carnival) are not aligned by ISO week.
                Assessments are marked "Indicative" for Caution series and not shown for Unreliable series.
              </div>
              <div style="overflow-x:auto;"><table class="curve-table" id="stl-curve-table"></table></div>
            </div>
          </div>
          <!-- TAB 3: Data Quality -->
          <div class="stl-tab-panel" data-panel="quality">
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Series quality overview <span>— click a cell to open that series</span></div>
              <div id="quality-wrap"></div>
            </div>
          </div>
          <!-- TAB 4: Reliability Guide -->
          <div class="stl-tab-panel" data-panel="guide">
            <div id="guide-wrap" style="display:flex; flex-direction:column; gap:16px;"></div>
          </div>
          <!-- TAB 5: Diagnostics -->
          <div class="stl-tab-panel" data-panel="diagnostics">
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">System vs Trend Heatmap <span id="heat-subtitle"></span></div>
              <div class="stl-chart-wrap" id="heatmap-wrap" style="height: auto; min-height: 400px; overflow: auto;"></div>
            </div>
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Residual diagnostics <span id="resid-subtitle"></span></div>
              <div class="stl-chart-wrap" style="height: 260px;"><canvas id="stl-chart-resid"></canvas></div>
              <div class="stl-chart-box__title" style="margin-top: 14px;">Raw discrepancy by year and month <span>— original value minus (trend + seasonality), median</span></div>
              <div id="resid-grid" style="overflow-x:auto;"></div>
              <div class="stl-note" id="resid-note"></div>
            </div>
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Alpha-Lambda Market Quadrant <span id="quad-subtitle"></span></div>
              <div class="stl-chart-wrap" id="quadrant-wrap" style="height: 420px; position: relative;">
                <div class="quadrant-tooltip" id="quad-tooltip"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const modalEl = overlay.querySelector('.stl-modal');

    // Window that currently hosts the modal (main page or PiP/popup)
    const hostWin = () => modalEl.ownerDocument.defaultView || window;
    const doc = () => modalEl.ownerDocument;
    const mk = (tag, cls, text) => {
      const e = doc().createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    let chartTs = null;
    let chartSeas = null;
    let chartResid = null;
    let scaleMode = 'absolute';
    let analysisType = 'lambda';
    if (hasBothTypes && !Object.keys(byDcpLambda).length && Object.keys(byDcpAlpha).length) {
      analysisType = 'alpha';
    }

    let chartCurve = null;
    let curveScale = 'raw';
    let curveLog = false;
    const curveCache = new Map();   // `${type}|${dep}` → index (results don't change while modal is open)
    const assessMemo = new Map();   // `${type}|dcpN_dep` → assessment

    const elDcp = modalEl.querySelector('#stl-select-dcp');
    const elDep = modalEl.querySelector('#stl-select-dep');
    const elType = hasBothTypes ? modalEl.querySelector('#stl-select-type') : null;
    if (elType) elType.value = analysisType;
    const elToggle = modalEl.querySelector('#stl-scale-toggle');

    // Canvases are looked up once and never removed. They move with modalEl into the pop-out.
    const tsCanvas     = modalEl.querySelector('#stl-chart-ts');
    const seasCanvas   = modalEl.querySelector('#stl-chart-seas');
    const curveCanvas  = modalEl.querySelector('#stl-chart-curve');
    const residCanvas  = modalEl.querySelector('#stl-chart-resid');
    const elCurveWeek  = modalEl.querySelector('#stl-curve-week');
    const elCurveScale = modalEl.querySelector('#stl-curve-scale');
    const elCurveLog   = modalEl.querySelector('#stl-curve-log');
    const elCurveTable = modalEl.querySelector('#stl-curve-table');

    function showChartMessage(canvas, text) {
      const wrap = canvas.parentElement;
      let msg = wrap.querySelector(':scope > .stl-empty-state');
      if (!msg) {
        msg = canvas.ownerDocument.createElement('div');
        msg.className = 'stl-empty-state';
        msg.style.height = '100%';
        wrap.appendChild(msg);
      }
      msg.textContent = text;
      msg.style.display = 'flex';
      canvas.style.display = 'none';
    }

    function hideChartMessage(canvas) {
      const msg = canvas.parentElement.querySelector(':scope > .stl-empty-state');
      if (msg) msg.style.display = 'none';
      canvas.style.display = '';
    }

    // ─── Selection helpers ───────────────────────────────────────────────────
    const curType  = () => (hasBothTypes ? analysisType : null);
    const storeFor = (type) => (type === 'alpha' ? byDcpAlpha : byDcpLambda);
    const getStore = () => storeFor(curType());
    const getKey   = () => `dcp${elDcp.value}_${elDep.value}`;
    const getData  = () => getStore()[getKey()] || null;

    function assessFor(type, dcp, dep) {
      const k = `${type}|dcp${dcp}_${dep}`;
      if (!assessMemo.has(k)) {
        assessMemo.set(k, assessSeries(storeFor(type)[`dcp${dcp}_${dep}`], { type, dep }));
      }
      return assessMemo.get(k);
    }

    // ─── Header bar: what this result is based on ────────────────────────────
    function renderMeta() {
      const bar = modalEl.querySelector('#stl-meta');
      bar.innerHTML = '';
      const chip = (label, value, warn) => {
        const c = mk('span', 'stl-chip' + (warn ? ' stl-chip--warn' : ''));
        c.appendChild(mk('b', null, label));
        c.appendChild(mk('span', null, value));
        bar.appendChild(c);
      };

      if (meta) {
        chip('OD', meta.od || '—');
        chip('POS', meta.filters?.POS || '—');
        chip('Path', meta.path ? `${meta.path}${meta.pathAuto ? ' (auto-selected: most common)' : ''}` : 'all paths', !!meta.pathAuto);
        chip('DOW', meta.filters?.DOW || 'all days');
        chip('Filter', `Passenger type ${meta.passengerType || '?'} · Compartment ${meta.compartment || '?'}`);
        if (meta.rows != null) chip('Rows', String(meta.rows));
      }

      const versions = [...new Set(results.map(r => r.backend_version).filter(Boolean))];
      const generated = results.map(r => r.generated_at).find(Boolean) || meta?.generatedAt;
      if (generated) {
        const t = new Date(generated);
        chip('Generated', (isNaN(t) ? String(generated) : t.toLocaleString()) + (opts.fromCache ? ' · from cache' : ' · fresh run'));
      }
      chip('Backend', versions.length ? versions.join(', ') : 'version not reported', !versions.length);
      chip('UI', UI_VERSION);

      Object.keys(errors).forEach(type => {
        const b = mk('div', 'stl-banner stl-banner--bad',
          `${type === 'alpha' ? 'Alpha' : 'Lambda'} analysis failed: ${errors[type]}. Only the other type is shown, and the result was not cached.`);
        bar.appendChild(b);
      });
      if (!versions.length) {
        bar.appendChild(mk('div', 'stl-banner stl-banner--warn',
          'This backend does not report quality fields. Series are shown as "Quality unknown" and should not be treated as reliable.'));
      }
    }

    // Ladder: where this series' method sits in the 1–5 order (1 = most trustworthy)
    function ladderEl(method) {
      const m = METHODS[method];
      if (!m || !m.rank) return null;
      const n = METHOD_ORDER.length;
      const wrap = mk('span', 'stl-ladder');
      wrap.title = `Method ${m.rank} of ${n}: ${m.label}. 1 = most trustworthy, ${n} = least.`;
      METHOD_ORDER.forEach(k => {
        const step = mk('span', 'stl-ladder__step' + (k === method ? ` stl-ladder__step--active stl-ladder__step--${METHODS[k].level}` : ''), METHODS[k].short);
        step.title = `${METHODS[k].rank}. ${METHODS[k].label}`;
        wrap.appendChild(step);
      });
      return wrap;
    }

    function guideLink() {
      const b = mk('button', 'stl-link', 'How to read this');
      b.title = 'Open the Reliability Guide';
      b.addEventListener('click', () => selectTab('guide'));
      return b;
    }

    // Status strip: reliability badge, method ladder and the top reasons
    function renderStatus(slot, ass) {
      slot.innerHTML = '';
      const strip = mk('div', `stl-status stl-status--${ass.level}`);
      const badge = mk('span', `stl-badge stl-badge--${ass.level}`, ass.label);
      badge.title = ass.reasons.map(r => r.text).join('\n') || 'No issues detected';
      strip.appendChild(badge);
      const ladder = ladderEl(ass.method);
      if (ladder) {
        strip.appendChild(ladder);
        strip.appendChild(mk('span', 'stl-status__method', `Method ${ass.rank} of ${METHOD_ORDER.length}: ${METHODS[ass.method].label}`));
      } else if (ass.method && METHODS[ass.method]) {
        strip.appendChild(mk('span', 'stl-status__method', `Method: ${METHODS[ass.method].label}`));
      }
      ass.reasons.slice(0, 3).forEach(r => {
        strip.appendChild(mk('span', `stl-status__reason stl-status__reason--${r.sev}`, r.text));
      });
      if (ass.reasons.length > 3) {
        const more = mk('span', 'stl-status__more', `+${ass.reasons.length - 3} more`);
        more.title = ass.reasons.slice(3).map(r => r.text).join('\n');
        strip.appendChild(more);
      }
      if (!ass.reasons.length) strip.appendChild(mk('span', 'stl-status__reason', 'No issues detected.'));
      strip.appendChild(guideLink());
      slot.appendChild(strip);
    }

    // ─── Time-Series Chart ───────────────────────────────────────────────────
    function renderTs() {
      const d = getData();
      const ass = assessFor(curType(), elDcp.value, elDep.value);
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      const excluded = d?.data_quality?.excluded_count;
      modalEl.querySelector('#ts-subtitle').textContent = d && !d.error
        ? `— ${typeLabel}DCP ${elDcp.value} · ${depLabel(elDep.value)}${excluded ? ` · ${excluded} zero/invalid excluded` : ''}`
        : '';
      renderStatus(modalEl.querySelector('#ts-status'), ass);

      if (chartTs) { chartTs.destroy(); chartTs = null; }
      if (!d || d.error) {
        showChartMessage(tsCanvas, d ? friendlyError(d.error) : 'No data available');
        return;
      }
      hideChartMessage(tsCanvas);

      const toMs = (arr) => (arr || []).map(s => new Date(s).getTime());
      const histDates = toMs(d.historical?.dates);
      const histActual = d.historical?.actual || [];
      const histTrend = d.historical?.trend || [];
      const fcDates = toMs(d.trend_forecast?.dates);
      const fcValues = d.trend_forecast?.values || [];
      const sysFcDates = toMs(d.system_forecast?.dates);
      const sysFcValues = d.system_forecast?.values || [];
      const infFcDates = toMs(d.influenced_forecast?.dates);
      const infFcValues = d.influenced_forecast?.values || [];

      const histMap = new Map(histDates.map((t, i) => [t, i]));
      const fcMap = new Map(fcDates.map((t, i) => [t, i]));
      const sysFcMap = new Map(sysFcDates.map((t, i) => [t, i]));
      const infFcMap = new Map(infFcDates.map((t, i) => [t, i]));

      const allDates = [...new Set([...histDates, ...fcDates, ...sysFcDates, ...infFcDates])].sort((a, b) => a - b);

      const pick = (map, values) => allDates.map(t => {
        const idx = map.get(t);
        return { x: t, y: idx !== undefined ? values[idx] : null };
      });
      const dsActual      = pick(histMap, histActual);
      const dsTrend       = pick(histMap, histTrend);
      const dsForecast    = pick(fcMap, fcValues);
      const dsSysForecast = pick(sysFcMap, sysFcValues);
      const dsInfForecast = pick(infFcMap, infFcValues);

      // Centred mean over a calendar window (the old EMA lagged ~9 days behind turning
      // points). Values are divided by the weekday factor first so a change of flight
      // days does not create a step.
      const dowF = d.dow_factors || null;
      const factorAt = (t) => {
        if (!dowF) return 1;
        const dow = (new Date(t).getUTCDay() + 6) % 7;
        const f = dowF[dow] ?? dowF[String(dow)];
        return f > 0 ? f : 1;
      };
      const combined = (fMap, fVals) => allDates.map(t => {
        let v = null;
        const h = histMap.get(t);
        if (h !== undefined) v = histActual[h];
        else { const f = fMap.get(t); if (f !== undefined) v = fVals[f]; }
        return { x: t, y: v == null ? null : v / factorAt(t) };
      });
      const half = SMOOTH_WINDOW_DAYS / 2;
      const dsCombinedSmooth = calendarMean(combined(sysFcMap, sysFcValues), half);
      const dsCombinedInfSmooth = calendarMean(combined(infFcMap, infFcValues), half);
      const smoothTag = `${SMOOTH_WINDOW_DAYS}d centred mean${dowF ? ', weekday-adjusted' : ''}`;

      // Trend before the regime-shift adjustment + the window that was adjusted
      const regimeOn = !!(d.regime_shift && d.regime_shift.detected && Array.isArray(d.historical?.stl_trend_original));
      let regimeWindow = null;
      let dsTrendOrig = null;
      if (regimeOn) {
        dsTrendOrig = pick(histMap, d.historical.stl_trend_original);
        const rc = d.historical.regime_correction || [];
        const first = rc.findIndex(v => Math.abs(v) > 1e-9);
        if (first >= 0 && histDates.length) regimeWindow = { from: histDates[first], to: histDates[histDates.length - 1] };
      }

      const datasets = [
        { label: 'Actual', data: dsActual,
          borderColor: 'rgb(173, 216, 230)', backgroundColor: 'rgba(173, 216, 230, 0.2)',
          borderWidth: 2, pointRadius: 0, spanGaps: false, order: 5 },
        { label: 'System Forecast', data: dsSysForecast,
          borderColor: 'rgba(234, 67, 53, 0.3)', backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, spanGaps: false, order: 4 },
        { label: 'Influenced Forecast', data: dsInfForecast,
          borderColor: 'rgba(137, 80, 196, 0.3)', backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, spanGaps: false, order: 3 },
        { label: `Actual + System Forecast (${smoothTag})`, data: dsCombinedSmooth,
          borderColor: 'rgba(3, 3, 3, 0.55)', backgroundColor: 'transparent',
          borderWidth: 3, pointRadius: 0, spanGaps: false, order: 1 },
        { label: `Actual + Influenced Forecast (${smoothTag})`, data: dsCombinedInfSmooth,
          borderColor: 'rgba(90, 40, 140, 0.85)', backgroundColor: 'transparent',
          borderWidth: 3, pointRadius: 0, spanGaps: false, order: 0 },
        { label: 'Historical Trend', data: dsTrend,
          borderColor: 'rgb(0, 128, 0)', backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, spanGaps: false, order: 2 },
        { label: 'Trend Forecast', data: dsForecast,
          borderColor: 'rgb(0, 0, 0)', backgroundColor: 'transparent',
          borderWidth: 2, borderDash: [6, 4], pointRadius: 0, spanGaps: false, order: 1 }
      ];
      if (dsTrendOrig) {
        datasets.push({ label: 'Trend before shift adjustment', data: dsTrendOrig,
          borderColor: 'rgba(0, 128, 0, 0.4)', backgroundColor: 'transparent',
          borderWidth: 1.5, borderDash: [3, 3], pointRadius: 0, spanGaps: false, order: 6 });
      }

      // Sparse series (one or few flight days) are separated by null dates that come from other
      // series. Connect across them instead of leaving isolated, invisible points.
      datasets.forEach(d => { d.spanGaps = true; });

      chartTs = new Chart(tsCanvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        plugins: [regimeShadePlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          devicePixelRatio: hostWin().devicePixelRatio || 1,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            regimeShade: { window: regimeWindow },
            legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
            tooltip: {
              callbacks: {
                title: (items) => {
                  const ts = items[0]?.parsed?.x;
                  return ts ? new Date(ts).toLocaleDateString() : '';
                }
              }
            }
          },
          scales: {
            x: {
              type: 'time',
              time: { unit: 'month', stepSize: 2, displayFormats: { month: 'MMM yy' }, tooltipFormat: 'dd MMM yyyy' },
              ticks: { maxRotation: 90, minRotation: 90, autoSkip: false },
              grid: { display: false }
            },
            y: { title: { display: true, text: 'Value' }, grid: { color: '#f1f5f9' } }
          }
        }
      });
    }

    // ─── Weekly Seasonality Chart ────────────────────────────────────────────
    function renderSeas() {
      const d = getData();
      const ass = assessFor(curType(), elDcp.value, elDep.value);
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      modalEl.querySelector('#seas-subtitle').textContent = d && !d.error
        ? `— ${typeLabel}DCP ${elDcp.value} · ${depLabel(elDep.value)} · ${scaleMode}` : '';
      renderStatus(modalEl.querySelector('#seas-status'), ass);
      const note = modalEl.querySelector('#seas-note');
      note.textContent = '';

      if (chartSeas) { chartSeas.destroy(); chartSeas = null; }
      if (!d || d.error) {
        showChartMessage(seasCanvas, d ? friendlyError(d.error) : 'No data available');
        return;
      }
      const root = scaleMode === 'relative' ? d.relative_weekly_seasonality : d.weekly_seasonality;
      if (!root) {
        showChartMessage(seasCanvas, `No ${scaleMode} seasonality data (this series has no forecast horizon).`);
        return;
      }
      hideChartMessage(seasCanvas);

      const weeks = Array.from({length: 53}, (_, i) => i + 1);
      const toMap = (obj, field) => {
        const m = {};
        if (obj?.weeks) obj.weeks.forEach((w, i) => { m[w] = obj[field][i]; });
        return m;
      };

      const hist = root.historical || {};
      const fc = root.forecast_derived || {};
      const inf = root.influenced_derived || {};

      const histMean = toMap(hist, 'mean');
      const histStd = toMap(hist, 'std');
      const fcMean = toMap(fc, 'mean');
      const infMean = toMap(inf, 'mean');

      const hideBand = ass.level === 'bad';
      const histMeanArr = weeks.map(w => histMean[w] ?? null);
      const histUpperArr = weeks.map(w => (!hideBand && histMean[w] != null && histStd[w] != null) ? histMean[w] + histStd[w] : null);
      const histLowerArr = weeks.map(w => (!hideBand && histMean[w] != null && histStd[w] != null) ? histMean[w] - histStd[w] : null);
      const fcMeanArr = weeks.map(w => fcMean[w] ?? null);
      const infMeanArr = weeks.map(w => infMean[w] ?? null);

      // What the shaded band is, and when not to trust it
      const bits = ['Shaded band = historical variation band: ±1σ of the pooled daily values of that ISO week, weekday effect removed. It is not a statistical confidence interval.'];
      if (hideBand) {
        bits.push(`Band hidden: ${ass.reasons.find(r => r.sev === 'bad')?.text || 'unreliable series'}`);
      } else if (!histUpperArr.some(v => v != null)) {
        bits.push('No band: fewer than 3 observations per ISO week.');
      } else if (ass.method === 'yoy_one_cycle') {
        bits.push('History is under two years, so each ISO week has data from at most two years and the band is rough.');
      }
      note.textContent = bits.join(' ');

      chartSeas = new Chart(seasCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: weeks,
          datasets: [
            { label: 'Hist lower', data: histLowerArr, borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
            { label: 'Hist upper', data: histUpperArr, borderWidth: 0, pointRadius: 0, fill: '-1',
              backgroundColor: 'rgba(26, 115, 232, 0.20)', spanGaps: false },
            { label: 'Historical Mean', data: histMeanArr, borderColor: 'rgb(26, 115, 232)',
              backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, spanGaps: false, order: 3 },
            { label: 'Forecast Derived', data: fcMeanArr, borderColor: 'rgb(234, 67, 53)',
              backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, spanGaps: false, order: 2 },
            { label: 'Influenced Derived', data: infMeanArr, borderColor: 'rgb(137, 80, 196)',
              backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, spanGaps: false, order: 1 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          devicePixelRatio: hostWin().devicePixelRatio || 1,
          plugins: {
            legend: {
              position: 'top',
              labels: {
                usePointStyle: true, boxWidth: 8,
                filter: (item) => !item.text.includes('Hist lower') && !item.text.includes('Hist upper')
              }
            },
            tooltip: {
              filter: (ctx) => {
                const lbl = ctx.dataset.label;
                return !lbl.includes('Hist lower') && !lbl.includes('Hist upper');
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'ISO Week' },
              ticks: { callback: (value, index) => WEEK_TO_MONTH[index] || '', autoSkip: false, maxRotation: 0 },
              grid: { display: false }
            },
            y: {
              title: { display: true, text: scaleMode === 'relative' ? 'Relative Seasonal Effect' : 'Seasonal Effect' },
              grid: { color: '#f1f5f9' }
            }
          }
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAB 3: DATA QUALITY — one cell per series
    // ═══════════════════════════════════════════════════════════════════════

    function goToSeries(type, dcp, dep) {
      if (type && elType) { analysisType = type; elType.value = type; }
      elDcp.value = String(dcp);
      elDep.value = dep;
      selectTab('time-series');
      updateAll();
    }

    let qSort = 'dep';   // 'dep' = by departure time, 'worst' = least reliable first

    function renderQuality() {
      const wrap = modalEl.querySelector('#quality-wrap');
      wrap.innerHTML = '';
      const types = hasBothTypes ? ['lambda', 'alpha'] : [null];

      // Tools: sort order + link to the guide
      const tools = mk('div', 'stl-q-tools');
      tools.appendChild(mk('label', null, 'Sort rows'));
      const group = mk('div', 'stl-toggle-group');
      [['dep', 'By departure time'], ['worst', 'Least reliable first']].forEach(([mode, text]) => {
        const b = mk('button', mode === qSort ? 'active' : '', text);
        b.addEventListener('click', () => { qSort = mode; renderQuality(); });
        group.appendChild(b);
      });
      tools.appendChild(group);
      tools.appendChild(guideLink());
      wrap.appendChild(tools);

      types.forEach(type => {
        const name = type === 'alpha' ? 'Alpha' : type === 'lambda' ? 'Lambda' : 'Series';
        const section = mk('div', 'stl-q-section');
        section.appendChild(mk('div', 'stl-q-title', name));

        if (type && errors[type]) {
          section.appendChild(mk('div', 'stl-banner stl-banner--bad', `${name} analysis failed: ${errors[type]}`));
          wrap.appendChild(section);
          return;
        }

        const store = storeFor(type);
        const present = [];
        allDeps.forEach(dep => allDcps.forEach(dcp => {
          if (store[`dcp${dcp}_${dep}`] !== undefined) present.push(assessFor(type, dcp, dep));
        }));
        section.appendChild(mk('div', 'stl-q-counts', `${present.length} series: ${countsText(levelCounts(present))}`));

        // Split by method, in rank order
        const mc = methodCounts(store);
        const by = mk('div', 'stl-q-bymethod');
        by.appendChild(mk('span', null, 'By method, most → least trustworthy:'));
        METHOD_ORDER.forEach(k => {
          const chip = mk('span', `stl-code stl-code--${METHODS[k].level}`, `${METHODS[k].short} ${mc[k]}`);
          chip.title = `${METHODS[k].rank}. ${METHODS[k].label}: ${mc[k]} series`;
          by.appendChild(chip);
        });
        if (mc.error) by.appendChild(mk('span', 'stl-code stl-code--bad', `ERR ${mc.error}`));
        if (mc.unknown) by.appendChild(mk('span', 'stl-code stl-code--unknown', `? ${mc.unknown}`));
        section.appendChild(by);

        // Row order
        const rowInfo = (dep) => {
          let worst = 9, bad = 0, soft = 0;
          allDcps.forEach(dcp => {
            if (store[`dcp${dcp}_${dep}`] === undefined) return;
            const a = assessFor(type, dcp, dep);
            worst = Math.min(worst, LEVEL_ORDER[a.level]);
            if (a.level === 'bad') bad++; else if (a.level === 'caution' || a.level === 'unknown') soft++;
          });
          return { worst, bad, soft };
        };
        const depOrder = qSort === 'worst'
          ? [...allDeps].sort((x, y) => {
              const a = rowInfo(x), b = rowInfo(y);
              return (a.worst - b.worst) || (b.bad - a.bad) || (b.soft - a.soft) || x.localeCompare(y);
            })
          : allDeps;

        const table = mk('table', 'stl-q');
        const head = mk('tr');
        head.appendChild(mk('th', null, ''));
        allDcps.forEach(dcp => head.appendChild(mk('th', null, `DCP ${dcp}`)));
        table.appendChild(head);

        depOrder.forEach(dep => {
          const tr = mk('tr');
          tr.appendChild(mk('td', 'stl-q-row', depLabel(dep)));
          allDcps.forEach(dcp => {
            const td = mk('td');
            const exists = store[`dcp${dcp}_${dep}`] !== undefined;
            if (!exists) {
              td.appendChild(mk('button', 'stl-qcell stl-qcell--none', '·'));
            } else {
              const a = assessFor(type, dcp, dep);
              const code = a.level === 'unknown' ? '?' : (METHODS[a.method]?.short || '—');
              const btn = mk('button', `stl-qcell stl-qcell--${a.level}`, code);
              const rankTxt = a.rank ? `Method ${a.rank} of ${METHOD_ORDER.length}: ${METHODS[a.method].label}\n` : '';
              btn.title = `${name} · DCP ${dcp} · ${depLabel(dep)}\n${a.label}\n${rankTxt}`.replace(/\n$/, '') +
                (a.reasons.length ? '\n' + a.reasons.map(r => '• ' + r.text).join('\n') : '');
              btn.addEventListener('click', () => goToSeries(type, dcp, dep));
              td.appendChild(btn);
            }
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });

        const holder = mk('div', 'stl-q-wrap');
        holder.appendChild(table);
        section.appendChild(holder);
        wrap.appendChild(section);
      });

      // Ordered legend
      const legend = mk('div', 'stl-q-legend');
      legend.appendChild(mk('span', null, 'Order, best → weakest: '));
      METHOD_ORDER.forEach((k, i) => {
        if (i) legend.appendChild(mk('span', null, ' → '));
        const c = mk('span', `stl-code stl-code--${METHODS[k].level}`, METHODS[k].short);
        c.title = `${METHODS[k].rank}. ${METHODS[k].label}`;
        legend.appendChild(c);
        legend.appendChild(mk('span', null, ` ${METHODS[k].label}`));
      });
      legend.appendChild(mk('span', null,
        ' · ERR = error · ? = quality unknown. Cell colour = final level (green reliable, amber caution, red unreliable); ' +
        'flags can lower it. ALL is the sum over departure times.'));
      wrap.appendChild(legend);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAB 4: RELIABILITY GUIDE — what the levels and the 1–5 order mean
    // ═══════════════════════════════════════════════════════════════════════

    function renderGuide() {
      const wrap = modalEl.querySelector('#guide-wrap');
      wrap.innerHTML = '';

      const box = (title, sub) => {
        const b = mk('div', 'stl-chart-box');
        const t = mk('div', 'stl-chart-box__title', title);
        if (sub) t.appendChild(mk('span', null, '— ' + sub));
        b.appendChild(t);
        wrap.appendChild(b);
        return b;
      };
      const para = (parent, text) => parent.appendChild(mk('div', 'stl-g-p', text));
      const table = (headers, rows) => {
        const t = mk('table', 'stl-g');
        const h = mk('tr');
        headers.forEach(x => h.appendChild(mk('th', null, x)));
        t.appendChild(h);
        rows.forEach(r => {
          const tr = mk('tr');
          r.forEach(c => {
            const td = mk('td');
            if (c && typeof c === 'object') td.appendChild(c); else td.textContent = c == null ? '' : String(c);
            tr.appendChild(td);
          });
          t.appendChild(tr);
        });
        const holder = mk('div', 'stl-g-wrap');
        holder.appendChild(t);
        return holder;
      };
      const badge = (lvl, text) => mk('span', `stl-badge stl-badge--${lvl}`, text ?? LEVEL_LABEL[lvl]);
      const code = (k) => mk('span', `stl-code stl-code--${METHODS[k].level}`, METHODS[k].short);

      // 1) the ladder
      const b1 = box('Method order: from most to least trustworthy', 'how seasonality was estimated');
      para(b1, 'Each series is estimated with the best method its history allows. The number is the order of trust: 1 measures seasonality most directly on the series itself, 5 does not separate it at all.');
      b1.appendChild(table(
        ['Order', 'Code', 'Method', 'What it does', 'Used when (backend defaults)', 'Starting level', 'In this viewer'],
        METHOD_ORDER.map(k => {
          const m = METHODS[k];
          const o = mk('span', 'stl-g-order', String(m.rank));
          return [o, code(k), m.label, m.what, m.when, badge(m.level), m.effect];
        })
      ));
      b1.appendChild(mk('div', 'stl-note',
        'Orders 1 and 2 are both full estimates from at least two years of the series\' own data and get the same level. 1 ranks first because it works on the actual daily values, while 2 relies on estimated weekday factors, so the order between them is a tiebreak, not a difference in trust. From 3 down, seasonality is no longer fully measured on the series itself. ' +
        'The order is my judgment of how much each method relies on assumptions, not a measured accuracy.'));

      // 2) flags
      const b2 = box('Flags that lower the level, whatever the method');
      para(b2, 'The method sets the starting level. These flags can only lower it, never raise it.');
      b2.appendChild(table(
        ['', 'Flag', 'Level', 'What it means'],
        [
          ['', 'Backend error for the series', badge('bad'), 'No chart is drawn. The message says why (for example too few valid observations).'],
          ['', 'Recent level shift added to the trend', badge('caution'), 'A persistent recent change in level was added to the trend, so the baseline is less certain. Shown as a dashed line and a shaded window on the Time Series chart.'],
          ['', 'Weekday schedules never overlap', badge('caution'), 'No flight day is shared between the old and the new schedule, so weekday effects cannot be compared. Level-shift detection is skipped.'],
          ['', 'Weekday adjustment did not converge', badge('caution'), 'The estimate of the weekday factors had not settled.'],
          ['', `${(EXCLUDED_CAUTION_SHARE * 100).toFixed(0)}% or more of the rows excluded`, badge('caution'), 'Zero or invalid values are kept out of the model. Below this share the exclusion is only listed as information.'],
          ['', `${(CLIPPED_CAUTION_SHARE * 100).toFixed(0)}% or more of the rows clipped`, badge('caution'), 'Extreme values are limited for fitting only (the backend always clips about 2%). Charts show the original values.'],
          ['', 'Flight days changed over time', badge('info', 'Info'), 'Listed for context. It does not change the level.'],
          ['', 'Quality details missing (older backend)', badge('unknown'), 'Never shown as Reliable, because nothing was checked.']
        ]
      ));

      // 3) how the final level is decided
      const b3 = box('How the final level is decided');
      para(b3, 'The worst applicable level wins: Unreliable, then Caution, then Reliable. "Quality unknown" replaces Reliable when the backend does not report details.');
      b3.appendChild(table(
        ['', 'Level', 'Seasonality band (weekly chart)', 'Booking Curve verdict'],
        [
          ['', badge('ok'), 'Drawn', 'Shown as computed'],
          ['', badge('caution'), 'Drawn (rough for one-year seasonality)', 'Prefixed "Indicative"'],
          ['', badge('unknown'), 'Drawn', 'Prefixed "Indicative"'],
          ['', badge('bad'), 'Hidden, with the reason', '"Not assessed"']
        ]
      ));
      b3.appendChild(mk('div', 'stl-note', 'These are rules of thumb on the backend\'s default thresholds. Check them on a few real ODs before relying on a verdict.'));

      // 4) this result
      const b4 = box('In this result', 'series per method');
      const types = hasBothTypes ? ['lambda', 'alpha'] : [null];
      const counts = {};
      types.forEach(t => { counts[t] = errors[t] ? null : methodCounts(storeFor(t)); });
      const keysShown = [...METHOD_ORDER];
      if (types.some(t => counts[t] && counts[t].error)) keysShown.push('error');
      if (types.some(t => counts[t] && counts[t].unknown)) keysShown.push('unknown');
      const barCell = (c, k) => {
        const holder = mk('span', 'stl-bar-cell');
        const bar = mk('span', 'stl-bar');
        const lvl = k === 'unknown' ? 'unknown' : METHODS[k].level;
        const fill = mk('span', `stl-bar__fill stl-bar__fill--${lvl}`);
        fill.style.width = `${c.total ? (c[k] / c.total) * 100 : 0}%`;
        bar.appendChild(fill);
        holder.appendChild(bar);
        holder.appendChild(mk('span', null, String(c[k])));
        return holder;
      };
      b4.appendChild(table(
        ['Order', 'Method', ...types.map(t => (t === 'alpha' ? 'Alpha' : t === 'lambda' ? 'Lambda' : 'Series'))],
        keysShown.map(k => {
          const label = k === 'unknown' ? '? quality unknown (older backend)' : `${METHODS[k].short}  ${METHODS[k].label}`;
          const order = METHODS[k] && METHODS[k].rank ? mk('span', 'stl-g-order', String(METHODS[k].rank)) : '';
          return [order, label, ...types.map(t => (counts[t] ? barCell(counts[t], k) : 'analysis failed'))];
        })
      ));
      const open = mk('button', 'stl-link', 'See every series in the Data Quality tab');
      open.style.marginLeft = '0';
      open.addEventListener('click', () => selectTab('quality'));
      b4.appendChild(open);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAB 5: DIAGNOSTICS — Heatmap + Residuals + Quadrant
    // ═══════════════════════════════════════════════════════════════════════

    function renderHeatmap() {
      const wrap = modalEl.querySelector('#heatmap-wrap');
      const dc = doc();
      const dep = elDep.value;
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      modalEl.querySelector('#heat-subtitle').textContent = `— ${typeLabel}${depLabel(dep)} · % gap of the system forecast vs the trend forecast`;

      const allDates = new Set();
      const store = getStore();

      for (let dcp = 1; dcp <= 16; dcp++) {
        const d = store[`dcp${dcp}_${dep}`];
        if (!d || d.error) continue;
        d.historical?.dates?.forEach(dt => allDates.add(dt));
        d.system_forecast?.dates?.forEach(dt => allDates.add(dt));
        d.trend_forecast?.dates?.forEach(dt => allDates.add(dt));
      }

      const sortedDates = [...allDates].sort();
      if (sortedDates.length === 0) {
        wrap.innerHTML = `<div class="stl-empty-state">No data available for heatmap</div>`;
        return;
      }

      const toIdx = (arr) => new Map((arr || []).map((v, i) => [v, i]));
      const matrix = [];
      const rowLabels = [];

      for (let dcp = 1; dcp <= 16; dcp++) {
        const d = store[`dcp${dcp}_${dep}`];
        const dcpInfo = DCP_DATA.find(x => x.DCP === dcp);
        rowLabels.push(dcpInfo ? `DCP ${dcp} (${dcpInfo['DyPr Start']}-${dcpInfo['DyPr End']}d)` : `DCP ${dcp}`);

        if (!d || d.error) {
          matrix.push(sortedDates.map(() => null));
          continue;
        }

        const sysM = toIdx(d.system_forecast?.dates);
        const trM = toIdx(d.trend_forecast?.dates);
        const hiM = toIdx(d.historical?.dates);

        matrix.push(sortedDates.map(date => {
          const si = sysM.get(date), ti = trM.get(date), hi = hiM.get(date);
          const sysVal = si !== undefined ? d.system_forecast.values[si] : null;
          let trendVal = ti !== undefined ? d.trend_forecast.values[ti] : null;
          if (trendVal == null && hi !== undefined) trendVal = d.historical.trend[hi];
          if (sysVal == null || trendVal == null || trendVal === 0) return null;
          return ((sysVal - trendVal) / Math.abs(trendVal)) * 100;
        }));
      }

      const allValues = matrix.flat().filter(v => v !== null);
      const maxAbs = allValues.length ? allValues.reduce((m, v) => Math.max(m, Math.abs(v)), 0) : 0;
      const clampMax = Math.max(maxAbs, 1);
      const textColor = (pct) => pct === null ? '#94a3b8' : (Math.abs(pct / clampMax) > 0.5 ? '#fff' : '#334155');

      const grid = dc.createElement('div');
      grid.className = 'heatmap-grid';
      grid.style.gridTemplateColumns = `120px repeat(${sortedDates.length}, minmax(50px, 1fr))`;

      const corner = dc.createElement('div');
      corner.style.cssText = 'padding: 4px;';
      grid.appendChild(corner);

      sortedDates.forEach(date => {
        const col = dc.createElement('div');
        col.className = 'heatmap-col-label';
        col.textContent = date.slice(5);
        col.title = date;
        grid.appendChild(col);
      });

      matrix.forEach((row, rIdx) => {
        const rowLabel = dc.createElement('div');
        rowLabel.className = 'heatmap-row-label';
        rowLabel.textContent = rowLabels[rIdx];
        grid.appendChild(rowLabel);

        row.forEach((val, cIdx) => {
          const cell = dc.createElement('div');
          cell.className = 'heatmap-cell';
          cell.style.backgroundColor = divergingColor(val === null ? null : val / clampMax);
          cell.style.color = textColor(val);
          cell.textContent = val !== null ? `${val.toFixed(1)}%` : '—';
          cell.title = `${rowLabels[rIdx]}\n${sortedDates[cIdx]}\nSystem vs Trend: ${val !== null ? val.toFixed(2) + '%' : 'N/A'}`;
          grid.appendChild(cell);
        });
      });

      wrap.innerHTML = '';
      wrap.appendChild(grid);

      const legend = dc.createElement('div');
      legend.className = 'heatmap-legend';
      legend.innerHTML = `
        <span>System &lt; Trend</span>
        <div class="heatmap-legend-bar"></div>
        <span>System &gt; Trend</span>
        <span style="margin-left: 12px;">Max deviation: ±${clampMax.toFixed(1)}%</span>
      `;
      wrap.appendChild(legend);
    }

    // Residual diagnostics of the selected series (descriptive, in-sample)
    function renderResid() {
      const d = getData();
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      const grid = modalEl.querySelector('#resid-grid');
      const note = modalEl.querySelector('#resid-note');
      grid.innerHTML = '';
      note.textContent = '';
      if (chartResid) { chartResid.destroy(); chartResid = null; }
      modalEl.querySelector('#resid-subtitle').textContent = d && !d.error
        ? `— ${typeLabel}DCP ${elDcp.value} · ${depLabel(elDep.value)} · median by weekday` : '';

      if (!d || d.error) {
        showChartMessage(residCanvas, d ? friendlyError(d.error) : 'No data available');
        return;
      }
      const rd = d.residual_diagnostics;
      if (!rd) {
        showChartMessage(residCanvas, 'This backend version does not report residual diagnostics.');
        return;
      }
      hideChartMessage(residCanvas);

      const byDow = new Map((rd.by_weekday || []).map(r => [r.dow, r]));
      const fitData = WEEKDAYS.map((_, i) => byDow.get(i)?.fit_residual_median ?? null);
      const rawData = WEEKDAYS.map((_, i) => byDow.get(i)?.raw_discrepancy_median ?? null);

      chartResid = new Chart(residCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: WEEKDAYS,
          datasets: [
            { label: 'Fit residual (median)', data: fitData, backgroundColor: 'rgba(26, 115, 232, 0.6)' },
            { label: 'Raw discrepancy (median)', data: rawData, backgroundColor: 'rgba(234, 67, 53, 0.6)' }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          devicePixelRatio: hostWin().devicePixelRatio || 1,
          plugins: {
            legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const rec = byDow.get(ctx.dataIndex);
                  const n = ctx.datasetIndex === 0 ? rec?.fit_residual_count : rec?.raw_discrepancy_count;
                  return `${ctx.dataset.label}: ${fmtNum(ctx.parsed.y)} (n=${n ?? 0})`;
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false }, title: { display: true, text: 'Weekday' } },
            y: { title: { display: true, text: 'Median, original units' }, grid: { color: '#f1f5f9' } }
          }
        }
      });

      const ym = rd.by_year_month || [];
      const years = [...new Set(ym.map(r => r.year))].sort((a, b) => a - b);
      const maxAbs = ym.reduce((m, r) => Math.max(m, Math.abs(r.raw_discrepancy_median || 0)), 0) || 1;
      const lookup = new Map(ym.map(r => [`${r.year}-${r.month}`, r]));
      const g = mk('div', 'heatmap-grid');
      g.style.gridTemplateColumns = '60px repeat(12, minmax(46px, 1fr))';
      g.appendChild(mk('div'));
      MONTHS.forEach(m => g.appendChild(mk('div', 'heatmap-col-label', m)));
      years.forEach(y => {
        g.appendChild(mk('div', 'heatmap-row-label', String(y)));
        for (let m = 1; m <= 12; m++) {
          const rec = lookup.get(`${y}-${m}`);
          const cell = mk('div', 'heatmap-cell');
          if (rec) {
            const v = rec.raw_discrepancy_median;
            cell.style.backgroundColor = divergingColor(v / maxAbs);
            cell.style.color = Math.abs(v / maxAbs) > 0.5 ? '#fff' : '#334155';
            cell.textContent = fmtNum(v);
            cell.title = `${MONTHS[m - 1]} ${y}\nraw discrepancy: ${fmtNum(v)} (n=${rec.raw_discrepancy_count})\nfit residual: ${fmtNum(rec.fit_residual_median)} (n=${rec.fit_residual_count})`;
          } else {
            cell.style.backgroundColor = '#f1f5f9';
            cell.style.color = '#94a3b8';
            cell.textContent = '—';
          }
          g.appendChild(cell);
        }
      });
      grid.appendChild(g);

      note.textContent = 'Descriptive in-sample diagnostics, not forecast validation. A weekday bar far from 0 suggests the weekday adjustment is not capturing that day. ' +
        '"Raw discrepancy" uses the original values, so it also shows what clipping for fitting hid.';
    }

    function renderQuadrant() {
      const wrap = modalEl.querySelector('#quadrant-wrap');
      const dc = doc();
      const tooltip = dc.createElement('div');
      tooltip.className = 'quadrant-tooltip';
      const dep = elDep.value;
      modalEl.querySelector('#quad-subtitle').textContent = `— ${depLabel(dep)}`;

      if (!hasBothTypes) {
        wrap.innerHTML = `<div class="stl-empty-state">Quadrant view requires both Alpha and Lambda analysis. Enable dual-mode in the backend.</div>`;
        return;
      }
      if (errors.alpha || errors.lambda) {
        wrap.innerHTML = `<div class="stl-empty-state">Quadrant view needs both Alpha and Lambda, and one analysis failed.</div>`;
        return;
      }

      const points = [];
      const dcpColors = [
        '#1a73e8','#1765cc','#1558b0','#34a853','#2d9247','#26803b',
        '#fbbc04','#e6ac04','#d49a03','#ea4335','#d63b2a','#c23320',
        '#9334e6','#7f2bc7','#6b22a8','#571a89'
      ];
      const toIdx = (arr) => new Map((arr || []).map((v, i) => [v, i]));

      for (let dcp = 1; dcp <= 16; dcp++) {
        const key = `dcp${dcp}_${dep}`;
        const a = byDcpAlpha[key];
        const l = byDcpLambda[key];
        if (!a || a.error || !l || l.error) continue;

        const aSys = toIdx(a.system_forecast?.dates), aHist = toIdx(a.historical?.dates);
        const lSys = toIdx(l.system_forecast?.dates), lHist = toIdx(l.historical?.dates);
        const dates = new Set([...aSys.keys(), ...aHist.keys(), ...lSys.keys(), ...lHist.keys()]);

        dates.forEach(date => {
          const as = aSys.get(date), ah = aHist.get(date), ls = lSys.get(date), lh = lHist.get(date);
          let alphaVal = as !== undefined ? a.system_forecast.values[as] : null;
          if (alphaVal == null && ah !== undefined) alphaVal = a.historical.actual[ah];
          let lambdaVal = ls !== undefined ? l.system_forecast.values[ls] : null;
          if (lambdaVal == null && lh !== undefined) lambdaVal = l.historical.actual[lh];

          if (alphaVal != null && lambdaVal != null && alphaVal > 0) {
            points.push({
              x: alphaVal, y: lambdaVal, dcp, date,
              isHistorical: ah !== undefined || lh !== undefined,
              alphaSource: as !== undefined ? 'system' : 'actual',
              lambdaSource: ls !== undefined ? 'system' : 'actual'
            });
          }
        });
      }

      if (points.length === 0) {
        wrap.innerHTML = `<div class="stl-empty-state">No paired Alpha-Lambda data available for ${esc(depLabel(dep))}</div>`;
        return;
      }

      const alphas = points.map(p => p.x).sort((a, b) => a - b);
      const lambdas = points.map(p => p.y).sort((a, b) => a - b);
      const medianAlpha = alphas[Math.floor(alphas.length / 2)];
      const medianLambda = lambdas[Math.floor(lambdas.length / 2)];

      const width = wrap.clientWidth || 800;
      const height = 400;
      const margin = { top: 20, right: 30, bottom: 50, left: 60 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const minAlpha = alphas[0] * 0.9;
      const maxAlpha = alphas[alphas.length - 1] * 1.1;
      const minLambda = lambdas[0] * 0.9;
      const maxLambda = lambdas[lambdas.length - 1] * 1.1;

      const xScale = (v) => margin.left + ((v - minAlpha) / ((maxAlpha - minAlpha) || 1)) * innerW;
      const yScale = (v) => margin.top + innerH - ((v - minLambda) / ((maxLambda - minLambda) || 1)) * innerH;

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const svg = dc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'quadrant-svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const mx = xScale(medianAlpha), my = yScale(medianLambda);
      const quadColors = ['rgba(26,115,232,0.06)', 'rgba(52,168,83,0.06)', 'rgba(251,188,4,0.06)', 'rgba(234,67,53,0.06)'];
      const quadLabels = [
        'High λ · Low α (Big market, price-insensitive)',
        'High λ · High α (Big market, price-sensitive)',
        'Low λ · Low α (Small market, price-insensitive)',
        'Low λ · High α (Small market, price-sensitive)'
      ];

      let html = '';
      html += `<rect x="${margin.left}" y="${margin.top}" width="${mx - margin.left}" height="${my - margin.top}" fill="${quadColors[0]}"/>`;
      html += `<rect x="${mx}" y="${margin.top}" width="${margin.left + innerW - mx}" height="${my - margin.top}" fill="${quadColors[1]}"/>`;
      html += `<rect x="${margin.left}" y="${my}" width="${mx - margin.left}" height="${margin.top + innerH - my}" fill="${quadColors[2]}"/>`;
      html += `<rect x="${mx}" y="${my}" width="${margin.left + innerW - mx}" height="${margin.top + innerH - my}" fill="${quadColors[3]}"/>`;
      html += `<text class="quadrant-quad-label" x="${(margin.left + mx) / 2}" y="${(margin.top + my) / 2}">${quadLabels[0]}</text>`;
      html += `<text class="quadrant-quad-label" x="${(mx + margin.left + innerW) / 2}" y="${(margin.top + my) / 2}">${quadLabels[1]}</text>`;
      html += `<text class="quadrant-quad-label" x="${(margin.left + mx) / 2}" y="${(my + margin.top + innerH) / 2}">${quadLabels[2]}</text>`;
      html += `<text class="quadrant-quad-label" x="${(mx + margin.left + innerW) / 2}" y="${(my + margin.top + innerH) / 2}">${quadLabels[3]}</text>`;
      html += `<line class="quadrant-axis" x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}"/>`;
      html += `<line class="quadrant-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}"/>`;
      html += `<line class="quadrant-median" x1="${mx}" y1="${margin.top}" x2="${mx}" y2="${margin.top + innerH}"/>`;
      html += `<line class="quadrant-median" x1="${margin.left}" y1="${my}" x2="${margin.left + innerW}" y2="${my}"/>`;
      html += `<text class="quadrant-label" x="${margin.left + innerW / 2}" y="${height - 10}" text-anchor="middle">Alpha (inverse elasticity) → lower α = less price sensitive</text>`;
      html += `<text class="quadrant-label" x="15" y="${margin.top + innerH / 2}" text-anchor="middle" transform="rotate(-90, 15, ${margin.top + innerH / 2})">Lambda (unconstrained demand) → higher λ = bigger market</text>`;
      html += `<text class="quadrant-label" x="${mx}" y="${margin.top + innerH + 15}" text-anchor="middle" fill="#ea4335" font-weight="600">median α</text>`;
      html += `<text class="quadrant-label" x="${margin.left - 10}" y="${my}" text-anchor="end" fill="#ea4335" font-weight="600">median λ</text>`;
      DCP_DATA.forEach((d, i) => {
        const lx = margin.left + (i % 8) * 90;
        const ly = 10 + Math.floor(i / 8) * 18;
        html += `<rect x="${lx}" y="${ly}" width="10" height="10" fill="${dcpColors[i]}" rx="2"/>`;
        html += `<text class="quadrant-label" x="${lx + 14}" y="${ly + 9}" fill="#475569">DCP ${d.DCP}</text>`;
      });
      svg.innerHTML = html;

      points.forEach(p => {
        const circle = dc.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', 'quadrant-point');
        circle.setAttribute('cx', xScale(p.x));
        circle.setAttribute('cy', yScale(p.y));
        circle.setAttribute('r', 3 + (p.dcp / 16) * 5);
        circle.setAttribute('fill', dcpColors[p.dcp - 1] || '#999');
        circle.setAttribute('fill-opacity', p.isHistorical ? 0.9 : 0.5);
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '1');

        circle.addEventListener('mouseenter', (e) => {
          const r = wrap.getBoundingClientRect();
          tooltip.style.display = 'block';
          tooltip.style.left = (e.clientX - r.left + 10) + 'px';
          tooltip.style.top = (e.clientY - r.top - 10) + 'px';
          tooltip.textContent = `DCP ${p.dcp} · ${p.date}\nα = ${p.x.toFixed(4)} (${p.alphaSource})\nλ = ${p.y.toFixed(1)} (${p.lambdaSource})\nElasticity = ${(1 / p.x).toFixed(2)}`;
        });
        circle.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
        svg.appendChild(circle);
      });

      wrap.innerHTML = '';
      wrap.appendChild(svg);
      wrap.appendChild(tooltip);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAB 2: BOOKING CURVE
    // ═══════════════════════════════════════════════════════════════════════

    function getCurveIndex() {
      const k = `${hasBothTypes ? analysisType : 'single'}|${elDep.value}`;
      if (!curveCache.has(k)) curveCache.set(k, buildCurveIndex(getStore(), elDep.value, allDcps));
      return curveCache.get(k);
    }

    function populateCurveWeeks() {
      const idx = getCurveIndex();
      const prev = elCurveWeek.value;
      elCurveWeek.innerHTML = '';
      idx.weeks.forEach(fw => {
        const o = mk('option');
        o.value = fw.key;
        o.textContent = `${fw.influenced ? '★ ' : ''}${fw.year}-W${String(fw.week).padStart(2, '0')} · ${fw.minDate} → ${fw.maxDate}`;
        elCurveWeek.appendChild(o);
      });
      if (idx.weeks.some(w => w.key === prev)) {
        elCurveWeek.value = prev;
      } else {
        const first = idx.weeks.find(w => w.influenced) || idx.weeks[0];
        if (first) elCurveWeek.value = first.key;
      }
    }

    function renderCurveTable(rows) {
      elCurveTable.innerHTML = '';
      if (!rows.length) return;

      const head = mk('tr');
      ['DCP', 'Hist. median', 'Hist. range', 'Last year', 'This year (realized / system)',
       'Influenced', 'Influence vs system', 'Influenced vs hist. median', 'Series', 'Assessment']
        .forEach(h => head.appendChild(mk('th', null, h)));
      elCurveTable.appendChild(head);

      rows.forEach(r => {
        const tr = mk('tr');
        const cells = [
          `DCP ${r.dcp}`,
          r.histMedian != null ? `${fmtNum(r.histMedian)} (${r.nYears}y)` : '—',
          r.histMin != null ? `${fmtNum(r.histMin)} – ${fmtNum(r.histMax)}` : '—',
          fmtNum(r.lastYear),
          r.sys != null ? fmtNum(r.sys) : r.act != null ? `${fmtNum(r.act)} (realized)` : '—',
          fmtNum(r.inf),
          (r.inf != null && r.sys) ? fmtPct(r.inf / r.sys - 1) : '—',
          (r.inf != null && r.histMedian) ? fmtPct(r.inf / r.histMedian - 1) : '—',
        ];
        cells.forEach(c => tr.appendChild(mk('td', null, c)));

        const tq = mk('td');
        const badge = mk('span', `stl-badge stl-badge--${r.assess.level}`, r.assess.label);
        badge.title = r.assess.reasons.map(x => x.text).join('\n') || 'No issues detected';
        tq.appendChild(badge);
        if (r.assess.rank) {
          const c = mk('span', `stl-code stl-code--${METHODS[r.assess.method].level}`, METHODS[r.assess.method].short);
          c.title = `Method ${r.assess.rank} of ${METHOD_ORDER.length}: ${METHODS[r.assess.method].label}`;
          c.style.marginLeft = '6px';
          tq.appendChild(c);
        }
        tr.appendChild(tq);

        const flag = curveFlag(r);
        const td = mk('td');
        td.appendChild(mk('span', `curve-flag ${flag.cls}${flag.indicative ? ' indicative' : ''}`, flag.text));
        tr.appendChild(td);
        elCurveTable.appendChild(tr);
      });
    }

    function renderCurve() {
      if (chartCurve) { chartCurve.destroy(); chartCurve = null; }

      const idx = getCurveIndex();
      const fw = idx.weeks.find(w => w.key === elCurveWeek.value);
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      const statusSlot = modalEl.querySelector('#curve-status');
      statusSlot.innerHTML = '';
      modalEl.querySelector('#curve-subtitle').textContent = fw
        ? `— ${typeLabel}${depLabel(elDep.value)} · ${fw.year}-W${String(fw.week).padStart(2, '0')} · ${curveScale === 'index' ? 'index vs historical median' : 'raw'}`
        : '';
      elCurveLog.disabled = curveScale === 'index';

      if (!fw) {
        showChartMessage(curveCanvas, 'No forecast departure weeks available');
        renderCurveTable([]);
        return;
      }

      const rows = allDcps.map(dcp => {
        const row = curveRow(idx, dcp, fw);
        row.assess = assessFor(curType(), dcp, elDep.value);
        return row;
      });

      // Quality summary across the DCPs of this departure time
      const counts = levelCounts(rows.map(r => r.assess));
      const worst = counts.bad ? 'bad' : counts.unknown ? 'unknown' : counts.caution ? 'caution' : 'ok';
      const strip = mk('div', `stl-status stl-status--${worst}`);
      strip.appendChild(mk('span', `stl-badge stl-badge--${worst}`, 'Series quality'));
      strip.appendChild(mk('span', null, `${countsText(counts)} (across DCPs of ${depLabel(elDep.value)})`));
      strip.appendChild(guideLink());
      statusSlot.appendChild(strip);

      renderCurveTable(rows);

      if (!rows.some(r => r.sys != null || r.inf != null || r.act != null)) {
        showChartMessage(curveCanvas, 'No data for this week');
        return;
      }
      hideChartMessage(curveCanvas);

      const useLog = curveScale === 'raw' && curveLog;
      const tf = (v, r) => {
        if (v == null) return null;
        if (curveScale === 'index') return r.histMedian ? v / r.histMedian : null;
        if (useLog && v <= 0) return null;
        return v;
      };
      const series = key => rows.map(r => tf(r[key], r));

      const datasets = [
        { _key: 'histMin', _band: true, label: 'Hist min', data: series('histMin'),
          borderWidth: 0, pointRadius: 0, fill: false },
        { _key: 'histMax', _band: true, label: 'Hist max', data: series('histMax'),
          borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(26,115,232,0.15)' },
        { _key: 'histMedian', label: 'Previous years (median)', data: series('histMedian'),
          borderColor: 'rgb(26,115,232)', borderWidth: 2, pointRadius: 3 },
        { _key: 'lastYear', label: 'Last year', data: series('lastYear'),
          borderColor: 'rgba(26,115,232,0.55)', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 2 },
        { _key: 'act', label: 'This year (realized)', data: series('act'),
          borderColor: 'rgb(15,23,42)', borderWidth: 2, pointRadius: 3 },
        { _key: 'sys', label: 'System Forecast', data: series('sys'),
          borderColor: 'rgb(234,67,53)', borderWidth: 2, pointRadius: 3 },
        { _key: 'inf', label: 'Influenced Forecast', data: series('inf'),
          borderColor: 'rgb(137,80,196)', borderWidth: 2.5, pointRadius: 4 },
      ];
      if (curveScale === 'index') {
        datasets.push({ _key: null, _band: true, label: 'Historical = 1.0', data: rows.map(() => 1),
          borderColor: '#94a3b8', borderDash: [2, 3], borderWidth: 1, pointRadius: 0 });
      }
      datasets.forEach(d => { d.backgroundColor ??= 'transparent'; d.spanGaps = false; });

      chartCurve = new Chart(curveCanvas.getContext('2d'), {
        type: 'line',
        data: { labels: rows.map(r => `DCP ${r.dcp}`), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          devicePixelRatio: hostWin().devicePixelRatio || 1,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              position: 'top',
              labels: {
                usePointStyle: true, boxWidth: 8,
                filter: (item, data) => !data.datasets[item.datasetIndex]._band
              }
            },
            tooltip: {
              filter: ctx => !ctx.dataset._band && ctx.parsed.y != null,
              callbacks: {
                label: ctx => {
                  const r = rows[ctx.dataIndex];
                  const raw = r[ctx.dataset._key];
                  if (ctx.dataset._key === 'histMedian') {
                    const range = r.histMin != null ? ` · range ${fmtNum(r.histMin)}–${fmtNum(r.histMax)}` : '';
                    return `${ctx.dataset.label}: ${fmtNum(raw)} (${r.nYears}y)${range}`;
                  }
                  const vs = r.histMedian ? ` · ${fmtPct(raw / r.histMedian - 1)} vs hist.` : '';
                  return `${ctx.dataset.label}: ${fmtNum(raw)}${vs}`;
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false } },
            y: {
              type: useLog ? 'logarithmic' : 'linear',
              title: {
                display: true,
                text: curveScale === 'index'
                  ? 'Index (1.0 = historical median for this DCP)'
                  : (hasBothTypes ? analysisType : 'value')
              },
              grid: { color: '#f1f5f9' }
            }
          }
        }
      });
    }

    elCurveWeek.addEventListener('change', renderCurve);
    elCurveLog.addEventListener('change', () => { curveLog = elCurveLog.checked; renderCurve(); });
    elCurveScale.addEventListener('click', e => {
      if (!e.target.matches('button')) return;
      elCurveScale.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      curveScale = e.target.dataset.mode;
      renderCurve();
    });

    // ─── Tabs ────────────────────────────────────────────────────────────────
    const tabs = modalEl.querySelectorAll('.stl-tab');
    const panels = modalEl.querySelectorAll('.stl-tab-panel');
    const isPanelActive = (name) => modalEl.querySelector(`[data-panel="${name}"]`).classList.contains('active');

    // Which controls matter for which tab
    function applyTabControls(name) {
      const show = (sel, on) => {
        const el = modalEl.querySelector(sel);
        if (el) el.style.display = on ? '' : 'none';
      };
      const noSelectors = name === 'quality' || name === 'guide';
      show('#stl-ctl-type', !noSelectors);
      show('#stl-ctl-dcp', name === 'time-series' || name === 'diagnostics');
      show('#stl-ctl-dep', !noSelectors);
      show('#stl-ctl-scale', name === 'time-series');
    }

    function selectTab(name) {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
      applyTabControls(name);
      if (name === 'diagnostics') { renderHeatmap(); renderResid(); renderQuadrant(); }
      if (name === 'booking-curve') { populateCurveWeeks(); renderCurve(); }
      if (name === 'quality') renderQuality();
      if (name === 'guide') renderGuide();
      hostWin().requestAnimationFrame(refreshCharts);
    }
    tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

    // ─── Update all charts ───────────────────────────────────────────────────
    function updateAll() {
      renderTs();
      renderSeas();
      if (isPanelActive('diagnostics')) {
        renderHeatmap();
        renderResid();
        renderQuadrant();
      }
      if (isPanelActive('booking-curve')) {
        populateCurveWeeks();
        renderCurve();
      }
      if (isPanelActive('quality')) renderQuality();
      if (isPanelActive('guide')) renderGuide();
    }

    elDcp.addEventListener('change', updateAll);
    elDep.addEventListener('change', updateAll);
    if (elType) {
      elType.addEventListener('change', () => {
        analysisType = elType.value;
        updateAll();
      });
    }

    elToggle.addEventListener('click', (e) => {
      if (!e.target.matches('button')) return;
      elToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      scaleMode = e.target.dataset.mode;
      renderSeas();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DRAG (in page) + POP-OUT (separate window) + AUTO-REFRESH
    // ═══════════════════════════════════════════════════════════════════════
    let popWin = null;
    let closing = false;

    const header = modalEl.querySelector('.stl-modal__header');
    header.style.cursor = 'move';
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || popWin) return;
      const r = modalEl.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      Object.assign(modalEl.style, { position: 'fixed', margin: '0', left: r.left + 'px', top: r.top + 'px' });
      header.setPointerCapture(e.pointerId);
      const move = (ev) => {
        modalEl.style.left = Math.min(Math.max(ev.clientX - dx, 100 - r.width), innerWidth - 100) + 'px';
        modalEl.style.top  = Math.min(Math.max(ev.clientY - dy, 0), innerHeight - 40) + 'px';
      };
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
    });

    function rerenderIn(win) {
      win.requestAnimationFrame(() => win.requestAnimationFrame(updateAll));
    }

    let sizeObserver = null;
    let sizeTimer = null;
    let lastQuadW = 0;

    function refreshCharts() {
      if (!modalEl.isConnected) { sizeObserver?.disconnect(); return; }
      const dpr = hostWin().devicePixelRatio || 1;
      [chartTs, chartSeas, chartCurve, chartResid].forEach(c => {
        if (!c) return;
        c.options.devicePixelRatio = dpr;
        c.resize();
        c.update('none');
      });
      const w = modalEl.querySelector('#quadrant-wrap')?.clientWidth || 0;
      if (isPanelActive('diagnostics') && Math.abs(w - lastQuadW) > 20) {
        lastQuadW = w;
        renderQuadrant();
      }
    }

    function watchSize() {
      sizeObserver?.disconnect();
      const RO = hostWin().ResizeObserver || ResizeObserver;
      sizeObserver = new RO(() => {
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(refreshCharts, 100);
      });
      sizeObserver.observe(modalEl.querySelector('.stl-modal__body'));
    }

    function destroyCharts() {
      if (chartTs)    { chartTs.destroy();    chartTs = null; }
      if (chartSeas)  { chartSeas.destroy();  chartSeas = null; }
      if (chartCurve) { chartCurve.destroy(); chartCurve = null; }
      if (chartResid) { chartResid.destroy(); chartResid = null; }
    }

    async function popOut() {
      if (popWin) { popWin.focus(); return; }
      const pip = window.documentPictureInPicture || unsafeWindow.documentPictureInPicture;
      try {
        if (pip) popWin = await pip.requestWindow({ width: 1400, height: 900 });
      } catch (e) {
        console.warn('[RM AI] PiP failed, falling back to popup', e);
      }
      if (!popWin) popWin = window.open('', 'rm-stl-viewer', 'popup,width=1000,height=750');
      if (!popWin) { alert('Popup blocked – allow popups for this site.'); return; }

      const pdoc = popWin.document;
      pdoc.title = 'Seasonality YoY Analysis';
      const css = document.getElementById('rm-stl-modal-styles');
      if (css) pdoc.head.appendChild(css.cloneNode(true));
      pdoc.body.style.cssText = 'margin:0; overflow:hidden; font-family:-apple-system,"Segoe UI",Roboto,helvetica,sans-serif;';
      pdoc.documentElement.style.fontSize = getComputedStyle(document.documentElement).fontSize;

      destroyCharts();

      modalEl.style.cssText = 'width:100vw; height:100vh; max-width:none; border-radius:0; box-shadow:none;';
      pdoc.body.appendChild(modalEl);
      overlay.style.display = 'none';
      modalEl.querySelector('.stl-modal__popout').style.display = 'none';
      header.style.cursor = 'default';

      watchSize();
      rerenderIn(popWin);

      popWin.addEventListener('pagehide', () => {
        popWin = null;
        if (closing) return;
        destroyCharts();
        modalEl.style.cssText = '';
        overlay.appendChild(modalEl);
        overlay.style.display = '';
        modalEl.querySelector('.stl-modal__popout').style.display = '';
        header.style.cursor = 'move';
        watchSize();
        rerenderIn(window);
      });
    }

    modalEl.querySelector('.stl-modal__popout').onclick = popOut;
    modalEl.querySelector('.stl-modal__x').onclick = () => {
      closing = true;
      sizeObserver?.disconnect();
      destroyCharts();
      if (popWin) popWin.close();
      overlay.remove();
    };

    renderMeta();
    applyTabControls('time-series');
    watchSize();
    updateAll();
  };

  // Small pure helpers exposed for debugging / tests (no DOM, no state)
  window.__rmAiHelpers = { METHODS, METHOD_ORDER, LEVEL_ORDER, methodCounts, assessSeries, calendarMean, friendlyError, curveFlag, curveRow, buildCurveIndex, levelCounts };

  // ─── Button styling ─────────────────────────────────────────────────────────
  const STYLES = `
    .rm-ai-btn-container {
      display: flex; gap: 8px; align-items: center; padding: 8px 12px; flex-wrap: wrap;
    }
    .rm-ai-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px;
      font-size: 13px; font-family: inherit; cursor: pointer; user-select: none;
      transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
      border: 1px solid transparent; white-space: nowrap;
      width: 100%; height: 40px; border-radius: 4px;
      background: #eee !important; color: #111 !important; font-weight: bold;
    }
    .rm-ai-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18); }
    .rm-ai-btn:active { transform: translateY(0); box-shadow: none; }
    .rm-ai-btn--seasonality { background: #1a73e8; color: #fff; border-color: #1558b0; }
    .rm-ai-btn--seasonality:hover { background: #1765cc; }
    .rm-ai-btn--seasonality.rm-ai-btn--loading { background: #5a9cf5; cursor: wait; pointer-events: none; }
    .rm-ai-btn__icon { font-size: 14px; line-height: 1; }
    .rm-ai-btn__spinner {
      display: none; width: 12px; height: 12px;
      border: 2px solid rgba(0,0,0,0.4); border-top-color: #000; border-radius: 50%;
      animation: rm-spin 0.6s linear infinite;
    }
    .rm-ai-btn--loading .rm-ai-btn__spinner { display: block; }
    .rm-ai-btn--loading .rm-ai-btn__icon { display: none; }
    .rm-ai-btn__badge {
      margin-left: auto; align-items: center; padding: 2px 8px; border-radius: 1px;
      font-size: 12px; font-weight: 600; background: #dcfce7; color: #166534; border: 1px solid #86efac;
    }
    @keyframes rm-spin { to { transform: rotate(360deg); } }
  `;

  function injectStyles() {
    if (document.getElementById('rm-ai-btn-styles')) return;
    const style = document.createElement('style');
    style.id = 'rm-ai-btn-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // ─── Progress on the button: phase / per-type status / elapsed time ─────────
  function createProgress(btn) {
    let timer = null;
    let t0 = Date.now();
    const state = { phase: 'loading data', alpha: null, lambda: null };

    const render = () => {
      const label = btn.querySelector('.rm-ai-btn__label');
      if (!label) return;
      const s = Math.floor((Date.now() - t0) / 1000);
      const elapsed = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      const parts = (state.alpha || state.lambda)
        ? [`Alpha: ${state.alpha || '…'}`, `Lambda: ${state.lambda || '…'}`]
        : [state.phase];
      label.textContent = `Processing… (${parts.join(' · ')}) ${elapsed}`;
    };

    return {
      start() { t0 = Date.now(); render(); timer = setInterval(render, 1000); },
      phase(p) { state.phase = p; render(); },
      status(name, s) { state[name] = s; render(); },
      stop() { if (timer) clearInterval(timer); timer = null; }
    };
  }

  // Backend / polling errors → one readable line
  function describeJobError(e) {
    const raw = (e && e.message) ? e.message : String(e || 'Unknown error');
    const first = raw.split('\n')[0];
    if (/busy/i.test(first)) return 'Server busy — try again in a few minutes.';
    if (/not_found|unknown job/i.test(first)) return 'The backend lost the job (it restarted or the job expired). Try again.';
    if (/timed? ?out|maxWait|too long/i.test(first)) return 'The analysis took longer than 12 minutes and was stopped.';
    return first.length > 300 ? first.slice(0, 300) + '…' : first;
  }

  // ─── Button logic ────────────────────────────────────────────────────────────

  async function onSeasonalityClick(btn, target) {
    setLoading(btn, true);
    const progress = createProgress(btn);

    try {
      const { activeOD, filters, cacheKey } = buildCacheKey();
      const [origin, destination] = (activeOD || '-').split('-');
      console.log('[RM AI] key:', cacheKey);

      const cached = await getCached(cacheKey);
      if (cached) {
        console.log('[RM AI] Serving from cache:', cacheKey);
        showStlModal(cached, { fromCache: true });
        return;
      }

      if (!("POS" in filters)) {
        alert("No POS selected...");
        return;
      }

      progress.start();
      console.log('[RM AI] Active OD:', activeOD);

      const csvString = await unsafeWindow.proshack.historical_downloadAllCSVs(
        origin,
        destination,
        { skipDownload: true }
      );
      progress.phase('preparing data');

      let sql = `
        SELECT  a.[Departure Date],
                a.[Final Alpha Influenced],
                a.[Final Lambda Influenced],
                CASE WHEN a.[Final Alpha Seasonal] = 0 THEN a.[Alpha] ELSE a.[Final Alpha Seasonal] END AS [Final Alpha Seasonal],
                CASE WHEN a.[Final Lambda Seasonal] = 0 THEN a.[Lambda] ELSE a.[Final Lambda Seasonal] END AS [Final Lambda Seasonal],
                a.[Departure Time],
                a.dcp as DCP,
                b.[DyPr Start],
                b.[DyPr End],
                b.[Length (days)]
        FROM CSV(?, {headers:true}) AS a
        JOIN ? AS b ON a.dcp = b.DCP
        WHERE [Passenger Type] = 'I' AND [Compartment] = 'Y'
      `;

      const markets = filters["POS"].split(",").map(s => s.trim()).filter(Boolean);
      if (markets.length > 0) {
        sql += ` AND ( ${markets.map(m => `a.POS = '${m.replace(/'/g, "''")}'`).join(" OR ")} )`;
      }

      // Path actually used (recorded in the result so the user can see it)
      let pathUsed = null;
      let pathAuto = false;

      if ("PATH" in filters) {
        const paths = filters["PATH"].split(",").map(s => s.trim()).filter(Boolean);
        if (paths.length > 0) {
          sql += ` AND ( ${paths.map(m => `[Path] = '${m.replace(/'/g, "''")}'`).join(" OR ")} )`;
          pathUsed = paths.join(', ');
        }
      } else {
        try {
          const pathRanking = await alasql.promise(
            `SELECT [Path], COUNT(*) as n FROM CSV(?, {headers:true}) GROUP BY [Path] ORDER BY n DESC LIMIT 1`,
            [csvString]
          );
          if (pathRanking && pathRanking.length > 0 && pathRanking[0]['Path']) {
            const topPath = pathRanking[0]['Path'];
            sql += ` AND [Path] = '${topPath.replace(/'/g, "''")}'`;
            pathUsed = String(topPath);
            pathAuto = true;
            console.log('[RM AI] PATH not provided; auto-filtered to most common Path:', topPath, `(${pathRanking[0].n} obs)`);
          }
        } catch (e) {
          console.warn('[RM AI] Failed to auto-select most common Path, proceeding without PATH filter', e);
        }
      }

      if ("DOW" in filters) {
        const dayOfWeekMap = {Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6};
        const days = filters["DOW"].split(",").map(s => s.trim()).filter(Boolean)
          .map(day => dayOfWeekMap[day] !== undefined ? dayOfWeekMap[day] : null).filter(day => day !== null);
        if (days.length > 0) {
          sql += ` AND ( ${days.map(d => `[Day of Week] = ${d}`).join(" OR ")} )`;
        }
      }

      const rawRows = await alasql.promise(sql, [csvString, DCP_DATA]);
      console.log(`[RM AI] ${rawRows.length} rows loaded into alasql table`);

      if (!rawRows.length) {
        alert('No rows match the current filters (OD, POS, path, day of week, passenger type I, compartment Y).');
        return;
      }

      const meta = {
        od: activeOD,
        filters: { POS: filters.POS ?? null, PATH: filters.PATH ?? null, DOW: filters.DOW ?? null },
        path: pathUsed,
        pathAuto,
        passengerType: 'I',
        compartment: 'Y',
        rows: rawRows.length,
        generatedAt: new Date().toISOString(),
        uiVersion: UI_VERSION
      };

      const stlClient = new unsafeWindow.HFGradioAPI("https://mithus-stl.hf.space/gradio_api/call");

      const commonPayload = {
        rows: rawRows,
        date_col: "Departure Date",
        dcp_col: "DCP",
        forecast_flag_col: "is_forecast",
        max_dcp: 13,
        damp_factor: "auto",
        bypass_dampener: false
      };

      const pollOpts = (name) => ({
        maxWaitMs: 720000,
        pollInterval: 5000,
        onStatus: (s) => {
          console.log(`[STL/YoY ${name}] poll:`, s.status);
          progress.status(name.toLowerCase(), s.status);
        }
      });

      progress.status('alpha', 'submitting');
      progress.status('lambda', 'submitting');

      const alphaJob = stlClient.pollJob(
        "submit_stl_yoy", "check_stl_yoy",
        { ...commonPayload, value_col: "Final Alpha Seasonal", influenced_col: "Final Alpha Influenced" },
        pollOpts('Alpha')
      );
      const lambdaJob = stlClient.pollJob(
        "submit_stl_yoy", "check_stl_yoy",
        { ...commonPayload, value_col: "Final Lambda Seasonal", influenced_col: "Final Lambda Influenced" },
        pollOpts('Lambda')
      );

      // One type failing must not throw away the other
      const [alphaR, lambdaR] = await Promise.allSettled([alphaJob, lambdaJob]);
      const errors = {};
      const take = (r, name) => {
        if (r.status === 'fulfilled' && r.value && r.value.by_dcp) return r.value;
        errors[name] = describeJobError(r.status === 'rejected' ? r.reason : (r.value && r.value.error) || 'Empty result');
        return null;
      };
      const alpha = take(alphaR, 'alpha');
      const lambda = take(lambdaR, 'lambda');

      if (!alpha && !lambda) {
        throw new Error(`Alpha: ${errors.alpha} · Lambda: ${errors.lambda}`);
      }

      const analysis = { alpha, lambda, meta, errors };
      console.log("[RM AI] STL/YoY result:", analysis);
      unsafeWindow.proshack.lastStlYoy = analysis;

      // Only complete results are cached, so a failed type is retried on the next click
      if (!Object.keys(errors).length) await setCached(cacheKey, analysis);
      showStlModal(analysis, { fromCache: false });

    } catch (err) {
      console.error('[RM AI] Seasonality Validation failed', err);
      alert(`Seasonality Validation failed: ${describeJobError(err)}`);
    } finally {
      progress.stop();
      setLoading(btn, false);
      updateCacheBadge(btn);
    }
  }

  // ── Persistent cache (IndexedDB), valid for the current day only ──────────
  // Large results must NOT go in GM_setValue: Tampermonkey sends all stored values
  // to the page on load, and above 64 MiB injection fails for EVERY script.
  const CACHE_DB      = 'rm-ai-stl-cache';
  const CACHE_STORE   = 'results';
  const CACHE_VERSION = 'v4';          // bump after backend / result-format changes
  const cachedKeys    = new Set();     // in-memory index → synchronous badge checks
  let indexDay = null;

  const todayStr = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open(CACHE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, mode);
      const result = fn(tx.objectStore(CACHE_STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const isValid = (rec) => !!rec && rec.day === todayStr() && rec.version === CACHE_VERSION;

  // Deletes anything not from today / not this version, and rebuilds the index.
  async function pruneExpired() {
    indexDay = todayStr();
    try {
      await withStore('readwrite', (store) => {
        cachedKeys.clear();
        store.openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          if (isValid(cur.value)) cachedKeys.add(cur.key);
          else cur.delete();
          cur.continue();
        };
      });
    } catch (e) {
      console.warn('[RM AI] Cache prune failed', e);
    }
  }

  async function getCached(key) {
    try {
      const rec = await withStore('readonly', (store) => store.get(key));
      if (isValid(rec)) return rec.data;
      cachedKeys.delete(key);
    } catch (e) {
      console.warn('[RM AI] Cache read failed', e);
    }
    return null;
  }

  async function setCached(key, data) {
    try {
      const plain = JSON.parse(JSON.stringify(data));   // strip page-context proxies
      await withStore('readwrite', (store) =>
        store.put({ day: todayStr(), version: CACHE_VERSION, data: plain }, key));
      cachedKeys.add(key);
    } catch (e) {
      // A failed cache write must never break the analysis
      console.warn('[RM AI] Cache write failed', e);
    }
  }

  function isCached(key) {
    // A tab left open past midnight: drop yesterday's keys, then clean the DB
    if (indexDay !== null && todayStr() !== indexDay) {
      indexDay = todayStr();
      cachedKeys.clear();
      pruneExpired().then(() =>
        document.querySelectorAll('.rm-ai-btn--seasonality').forEach(updateCacheBadge));
    }
    return cachedKeys.has(key);
  }

  async function clearStlCache() {
    try {
      await withStore('readwrite', (store) => store.clear());
    } catch (e) {
      console.warn('[RM AI] Cache clear failed', e);
    }
    cachedKeys.clear();
    document.querySelectorAll('.rm-ai-btn--seasonality').forEach(updateCacheBadge);
    console.log('[RM AI] STL cache cleared');
  }

  // One-time cleanup of the old GM_setValue cache (keeps Tampermonkey storage small)
  try {
    GM_listValues().filter(k => k.startsWith('stl_')).forEach(GM_deleteValue);
  } catch (e) { /* nothing to clean */ }

  pruneExpired().then(() =>
    document.querySelectorAll('.rm-ai-btn--seasonality').forEach(updateCacheBadge));

  if (unsafeWindow.proshack) {
    unsafeWindow.proshack.clearStlCache = clearStlCache;
  }

  function buildCacheKey() {
    const activeOD = unsafeWindow.proshack.getActiveTabOD();
    const filters  = unsafeWindow.proshack.read_menu_filters();
    let subkey = '';
    if ('POS'  in filters) subkey += filters['POS']  + '_';
    if ('PATH' in filters) subkey += filters['PATH'] + '_';
    if ('DOW'  in filters) subkey += filters['DOW']  + '_';
    return { activeOD, filters, cacheKey: `${activeOD}_${subkey}` };
  }

  const BTN_LABEL = 'AI Seasonality Validation';

  function updateCacheBadge(btn) {
    if (!btn || btn.classList.contains('rm-ai-btn--loading')) return;
    const badge = btn.querySelector('.rm-ai-btn__badge');
    const label = btn.querySelector('.rm-ai-btn__label');
    let hit = false;
    try { hit = isCached(buildCacheKey().cacheKey); } catch (e) { /* proshack not ready */ }
    if (label) label.textContent = BTN_LABEL;
    if (badge) badge.style.display = hit ? 'inline-flex' : 'none';
    btn.title = hit ? 'Result cached for today – opens instantly' : 'Runs the analysis (≈ a few minutes)';
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function setLoading(btn, isLoading) {
    btn.classList.toggle('rm-ai-btn--loading', isLoading);
    btn.style.pointerEvents = isLoading ? 'none' : '';
  }

  function makeBtn({ label, icon, modifierClass, onClick, target }) {
    const div = document.createElement('div');
    div.className = `rm-ai-btn ${modifierClass}`;
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', label);

    const spinner = document.createElement('span');
    spinner.className = 'rm-ai-btn__spinner';

    const iconEl = document.createElement('span');
    iconEl.className = 'rm-ai-btn__icon';
    iconEl.textContent = icon;

    const text = document.createElement('span');
    text.className = 'rm-ai-btn__label';
    text.textContent = label;

    const badge = document.createElement('span');
    badge.className = 'rm-ai-btn__badge';
    badge.textContent = '⚡ cached';
    badge.style.display = 'none';

    div.appendChild(spinner);
    div.appendChild(iconEl);
    div.appendChild(text);
    div.appendChild(badge);

    div.addEventListener('mouseenter', () => updateCacheBadge(div));
    div.addEventListener('focus',      () => updateCacheBadge(div));

    div.addEventListener('click', () => onClick(div, target));
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(div, target);
      }
    });

    return div;
  }

  // ─── Inject buttons into target ──────────────────────────────────────────────

  const INJECTED_ATTR = 'data-rm-ai-injected';
  const TARGET_SELECTOR =
    '.rm-container-historical-forecast-body .rm-container-legend-section .rm-measure-view-component';

  function injectButtons(target) {
    if (target.hasAttribute(INJECTED_ATTR)) return;
    target.setAttribute(INJECTED_ATTR, 'true');

    const container = document.createElement('div');
    container.className = 'rm-ai-btn-container';

    container.appendChild(makeBtn({
      label: BTN_LABEL,
      icon: '📈',
      modifierClass: 'rm-ai-btn--seasonality',
      onClick: onSeasonalityClick,
      target,
    }));

    target.parentNode.insertBefore(container, target.nextSibling);
    updateCacheBadge(container.querySelector('.rm-ai-btn--seasonality'));
  }

  // ─── SPA route lifecycle ─────────────────────────────────────────────────────

  let historicalObserver = null;
  let pendingScanTimer = null;
  let lastUrl = '';

  function isHistoricalForecastRoute() {
    return /\/historical-forecast\/?$/.test(location.pathname);
  }

  function removeStyles() {
    document.getElementById('rm-ai-btn-styles')?.remove();
    document.getElementById('rm-stl-modal-styles')?.remove();
  }

  function removeInjectedUi() {
    document.querySelectorAll('.rm-ai-btn-container').forEach(el => el.remove());
    document.querySelectorAll('.stl-modal-overlay').forEach(el => el.remove());
    document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => el.removeAttribute(INJECTED_ATTR));
    if (pendingScanTimer !== null) {
      clearTimeout(pendingScanTimer);
      pendingScanTimer = null;
    }
  }

  function scanAndInject() {
    if (!isHistoricalForecastRoute()) return;
    injectStyles();
    document.querySelectorAll(TARGET_SELECTOR).forEach(injectButtons);
  }

  function scheduleScan() {
    if (!isHistoricalForecastRoute()) return;
    if (pendingScanTimer !== null) clearTimeout(pendingScanTimer);
    pendingScanTimer = setTimeout(() => {
      pendingScanTimer = null;
      scanAndInject();
    }, 50);
  }

  function startHistoricalObserver() {
    if (historicalObserver || !document.body) return;

    historicalObserver = new MutationObserver((mutations) => {
      if (!isHistoricalForecastRoute()) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(TARGET_SELECTOR) || node.querySelector(TARGET_SELECTOR)) {
            scheduleScan();
            return;
          }
        }
      }
    });

    historicalObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopHistoricalObserver() {
    if (!historicalObserver) return;
    historicalObserver.disconnect();
    historicalObserver = null;
  }

  function activateHistoricalForecast() {
    injectStyles();
    startHistoricalObserver();
    scanAndInject();
    setTimeout(scanAndInject, 250);
    setTimeout(scanAndInject, 750);
    setTimeout(scanAndInject, 1500);
  }

  function deactivateHistoricalForecast() {
    stopHistoricalObserver();
    removeInjectedUi();
    removeStyles();
  }

  function handleRouteChange(force = false) {
    const currentUrl = location.href;
    if (!force && currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    if (isHistoricalForecastRoute()) {
      activateHistoricalForecast();
    } else {
      deactivateHistoricalForecast();
    }
  }

  function installHistoryListeners() {
    const pageWindow = unsafeWindow;
    const pageHistory = pageWindow.history;

    if (pageWindow.__rmAiHistoryListenerInstalled) return;
    pageWindow.__rmAiHistoryListenerInstalled = true;

    const fire = (type) => window.dispatchEvent(
      new CustomEvent('rm-ai-locationchange', { detail: { type, url: pageWindow.location.href } })
    );

    const originalPushState = pageHistory.pushState;
    const originalReplaceState = pageHistory.replaceState;

    pageHistory.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      fire('pushState');
      return result;
    };

    pageHistory.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      fire('replaceState');
      return result;
    };

    pageWindow.addEventListener('popstate', () => fire('popstate'));
    pageWindow.addEventListener('hashchange', () => fire('hashchange'));

    window.addEventListener('rm-ai-locationchange', () => {
      setTimeout(() => handleRouteChange(), 0);
    });
  }

  function init() {
    installHistoryListeners();
    lastUrl = '';
    handleRouteChange(true);
    // Fallback for route changes not captured by History API interception.
    setInterval(() => handleRouteChange(), 500);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }

})();
