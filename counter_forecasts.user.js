// ==UserScript==
// @name         Counter Forecasts - AI
// @namespace    http://tampermonkey.net/
// @version      3.2.2
// @description  Counter Forecasts — v3.2 (MSTL + Box-Cox + bias correction + unrealistic-forecast filter)
// @author       Gil Martins
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      mithus-arima.hf.space
// @require      https://cdnjs.cloudflare.com/ajax/libs/alasql/4.6.6/alasql.min.js
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (typeof Chart === 'undefined') { console.error('[FC] Chart.js not loaded.'); return; }

  var BASE = 'https://mithus-arima.hf.space/gradio_api/call';
  var INJECTED = 'data-rm-fc-injected';

  var DCP_DATA = [
    {DCP:1,"DyPr Start":364,"DyPr End":236},
    {DCP:2,"DyPr Start":235,"DyPr End":174},
    {DCP:3,"DyPr Start":173,"DyPr End":127},
    {DCP:4,"DyPr Start":126,"DyPr End":103},
    {DCP:5,"DyPr Start":102,"DyPr End":75},
    {DCP:6,"DyPr Start":74,"DyPr End":62},
    {DCP:7,"DyPr Start":61,"DyPr End":47},
    {DCP:8,"DyPr Start":46,"DyPr End":34},
    {DCP:9,"DyPr Start":33,"DyPr End":26},
    {DCP:10,"DyPr Start":25,"DyPr End":18},
    {DCP:11,"DyPr Start":17,"DyPr End":10},
    {DCP:12,"DyPr Start":9,"DyPr End":8},
    {DCP:13,"DyPr Start":7,"DyPr End":5},
    {DCP:14,"DyPr Start":4,"DyPr End":2},
    {DCP:15,"DyPr Start":1,"DyPr End":1},
    {DCP:16,"DyPr Start":0,"DyPr End":0}
  ];


  var MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN',
                    'JUL','AUG','SEP','OCT','NOV','DEC'];

  var monthLinesPlugin = {
    id: 'monthLines',
    afterDatasetsDraw: function (chart) {
      var xScale = chart.scales.x;
      var yScale = chart.scales.y;
      if (!xScale || !yScale) return;

      var ctx = chart.ctx;
      var min = xScale.min;
      var max = xScale.max;

      // First day of the first visible month
      var d = new Date(min);
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      if (d.getTime() < min) d.setMonth(d.getMonth() + 1);

      ctx.save();
      ctx.strokeStyle = 'rgba(100,116,139,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      //ctx.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      ctx.fillStyle = 'rgba(71,85,105,0.8)';

      while (d.getTime() <= max) {
        var x = xScale.getPixelForValue(d.getTime());
        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.stroke();

        //var label = MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear();
        //ctx.fillText(label, x + 3, yScale.top + 10);

        d.setMonth(d.getMonth() + 1);
      }

      ctx.restore();
    }
  };

  var stickyTooltipPlugin = {
    id: 'stickyTooltip',
    afterEvent: function (chart, args) {
      var event = args.event;
      if (!event) return;

      var type = event.type;
      if (type !== 'mousemove' && type !== 'mouseenter' &&
          type !== 'touchstart' && type !== 'touchmove') return;

      var area = chart.chartArea;
      var x = event.x, y = event.y;

      // Cursor left the chart area → let default hide happen
      if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
        return;
      }

      // 1. Find the nearest x-anchor across all "real" datasets
      var anchorX = null, minDist = Infinity;
      chart.data.datasets.forEach(function (ds) {
        if (ds.label === '95% lo' || ds.label === '80% lo') return;
        (ds.data || []).forEach(function (pt) {
          if (!pt || pt.x == null) return;
          var px = chart.scales.x.getPixelForValue(pt.x);
          var d = Math.abs(px - x);
          if (d < minDist) { minDist = d; anchorX = pt.x; }
        });
      });
      if (anchorX == null) return;

      // 2. For each dataset, pick the point at (or very near) that anchor
      var active = [];
      chart.data.datasets.forEach(function (ds, dsIdx) {
        if (ds.label === '95% lo' || ds.label === '80% lo') return;
        var bestIdx = -1, bestDist = Infinity;
        (ds.data || []).forEach(function (pt, ptIdx) {
          if (!pt || pt.x == null) return;
          var d = Math.abs(pt.x - anchorX);
          if (d < bestDist) { bestDist = d; bestIdx = ptIdx; }
        });
        // Only include if this dataset actually has a point at the anchor
        // (± 2 days of slack for weekly data)
        if (bestIdx >= 0 && bestDist <= 2 * 24 * 3600 * 1000) {
          active.push({datasetIndex: dsIdx, index: bestIdx});
        }
      });

      if (active.length === 0) return;

      // 3. Force the tooltip active — this is what kills the flicker
      chart.tooltip.setActiveElements(active, {x: x, y: y});
      args.changed = true;
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════
  function fmt(n, d) {
    if (d === undefined) d = 1;
    if (n === null || n === undefined || isNaN(n)) return '\u2014';
    return n.toLocaleString('en-GB', {minimumFractionDigits: d, maximumFractionDigits: d});
  }

  function parseDate(s) {
    if (!s) return null;
    if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
    var str = String(s).trim();

    // DD/MM/YYYY or MM/DD/YYYY (accept / - .)
    var m = str.match(/^(\d{1,2})(?:\/|-|\.)(\d{1,2})(?:\/|-|\.)(\d{4})$/);
    if (m) {
      var day = parseInt(m[1], 10), mon = parseInt(m[2], 10), year = parseInt(m[3], 10);
      if (mon > 12 && day <= 12) {
        var d = new Date(year, day - 1, mon);
        if (!isNaN(d.getTime())) return d;
      } else {
        var d2 = new Date(year, mon - 1, day);
        if (!isNaN(d2.getTime())) return d2;
      }
    }

    // YYYY-MM-DD (ISO)
    m = str.match(/^(\d{4})(?:\/|-|\.)(\d{1,2})(?:\/|-|\.)(\d{1,2})$/);
    if (m) {
      var d3 = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
      if (!isNaN(d3.getTime())) return d3;
    }

    var d4 = new Date(str);
    return isNaN(d4.getTime()) ? null : d4;
  }

  function parseDates(arr) {
    return (arr || []).map(function (d) {
      var p = parseDate(d);
      return p ? p.getTime() : null;
    }).filter(function (t) { return t !== null; });
  }

  // ═══════════════════════════════════════════════════════════════
  // GM WRAPPERS
  // ═══════════════════════════════════════════════════════════════
  function gmPost(url, body) {
    return new Promise(function (ok, fail) {
      GM_xmlhttpRequest({
        method: 'POST', url: url,
        headers: {'Content-Type': 'application/json'},
        data: JSON.stringify(body),
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) {
            try { ok(JSON.parse(r.responseText)); }
            catch (e) { fail(new Error('JSON parse: ' + r.responseText.slice(0, 200))); }
          } else { fail(new Error('POST ' + r.status)); }
        },
        onerror: function () { fail(new Error('POST network error')); }
      });
    });
  }

  function gmGet(url) {
    return new Promise(function (ok, fail) {
      GM_xmlhttpRequest({
        method: 'GET', url: url,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) ok(r.responseText);
          else fail(new Error('GET ' + r.status));
        },
        onerror: function () { fail(new Error('GET network error')); }
      });
    });
  }

  async function gradioCall(apiName, args) {
    var json = await gmPost(BASE + '/' + apiName, {data: args});
    if (!json.event_id) throw new Error(apiName + ': no event_id: ' + JSON.stringify(json));
    var text = await gmGet(BASE + '/' + apiName + '/' + json.event_id);
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data: ')) {
        try {
          var p = JSON.parse(lines[i].slice(6));
          if (p && p.msg === 'process_completed' && p.output && p.output.data) return p.output.data[0];
          if (Array.isArray(p) && p.length > 0) return p[0];
        } catch (e) {}
      }
    }
    throw new Error(apiName + ': no data in SSE');
  }

  // ═══════════════════════════════════════════════════════════════
  // CACHE
  // ═══════════════════════════════════════════════════════════════
  var CACHE_EXP = (function () {
    var d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime();
  })();
  function getCached(k) {
    var e = window._fcCache && window._fcCache[k];
    if (!e) return null;
    if (Date.now() > CACHE_EXP) { delete window._fcCache[k]; return null; }
    return e;
  }
  function setCached(k, v) {
    if (!window._fcCache) window._fcCache = {};
    window._fcCache[k] = v;
  }

  // ═══════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════
  (function () {
    if (document.getElementById('fc-styles')) return;
    var el = document.createElement('style');
    el.id = 'fc-styles';
    el.textContent = [
      '.fc-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
      '.fc-modal{background:#fff;border-radius:10px;width:95vw;height:96vh;max-width:1600px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}',
      '.fc-hdr{padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;background:#f8fafc}',
      '.fc-hdr h3{margin:0;font-size:16px;font-weight:600;color:#1e293b;display:inline}',
      '.fc-sub{font-size:12px;color:#64748b;margin-left:12px}',
      '.fc-close{background:#e2e8f0;border:none;border-radius:6px;width:32px;height:32px;font-size:18px;cursor:pointer;color:#475569;line-height:1}',
      '.fc-close:hover{background:#cbd5e1;color:#0f172a}',
      '.fc-ctrl{padding:10px 20px;border-bottom:1px solid #e2e8f0;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;background:#fff}',
      '.fc-ctrl label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.3px}',
      '.fc-ctrl label.fc-chk{flex-direction:row;align-items:center;gap:6px;text-transform:none;font-size:12px;color:#334155;letter-spacing:0;padding-bottom:6px}',
      '.fc-ctrl label.fc-chk input{margin:0}',
      '.fc-ctrl select,.fc-ctrl input[type="number"]{padding:5px 8px;border:1px solid #cbd5e1;border-radius:5px;font-size:13px;min-width:90px;background:#fff;color:#334155}',
      '.fc-run{padding:7px 18px;border:none;border-radius:5px;background:#1a73e8;color:#fff;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s}',
      '.fc-run:hover{background:#1558b0}',
      '.fc-run:disabled{background:#93c5fd;cursor:wait}',
      '.fc-tabs{display:none;gap:0;border-bottom:1px solid #e2e8f0;background:#fff}',
      '.fc-tabs.visible{display:flex}',
      '.fc-tab{padding:10px 20px;font-size:13px;font-weight:500;color:#64748b;cursor:pointer;border:none;border-bottom:2px solid transparent;background:none;transition:all .15s}',
      '.fc-tab:hover{color:#334155;background:#f8fafc}',
      '.fc-tab.active{color:#1a73e8;border-bottom-color:#1a73e8;background:#fff}',
      '.fc-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:20px}',
      '.fc-panel{display:none;flex-direction:column;gap:20px}',
      '.fc-panel.active{display:flex}',
      '.fc-chart-box{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px}',
      '.fc-chart-title{font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between}',
      '.fc-chart-title span{color:#94a3b8;font-weight:400;font-size:11px}',
      '.fc-chart-wrap{position:relative;height:380px;width:100%}',
      '.fc-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}',
      '.fc-metric{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center}',
      '.fc-metric__val{font-size:20px;font-weight:700;color:#1a73e8}',
      '.fc-metric__lbl{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}',
      '.fc-quality{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase}',
      '.fc-quality--good{background:#dcfce7;color:#166534}',
      '.fc-quality--medium{background:#fef3c7;color:#92400e}',
      '.fc-quality--poor{background:#fee2e2;color:#991b1b}',
      '.fc-quality--unknown{background:#e2e8f0;color:#475569}',
      '.fc-tbl{width:100%;border-collapse:collapse;font-size:12px}',
      '.fc-tbl th,.fc-tbl td{padding:6px 10px;border:1px solid #e2e8f0;text-align:right}',
      '.fc-tbl th{background:#f8fafc;font-weight:600;color:#475569;text-align:center}',
      '.fc-tbl td:first-child{text-align:left;font-weight:500}',
      '.fc-tbl tr.fc-best td{background:#dcfce7 !important}',
      '.fc-status{padding:40px 12px;color:#64748b;font-size:13px;text-align:center}',
      '.fc-err{padding:12px;color:#dc2626;font-size:13px}',
      '.fc-empty{display:flex;align-items:center;justify-content:center;height:200px;color:#94a3b8;font-size:13px}',
      '.fc-warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:6px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px}',
      '.fc-warn__icon{font-size:16px}',
      '.fc-info{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:8px 14px;border-radius:6px;font-size:12px}',
      '.fc-info b{color:#78350f}',
      '.fc-feature-tag{display:inline-block;padding:2px 8px;margin-left:6px;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:10px;font-weight:600;letter-spacing:.3px}',
      '.fc-inject{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid #9334e6;border-radius:2px;font-size:13px;font-weight:500;color:#9334e6;background:#fff;cursor:pointer;margin:8px 12px;user-select:none;width:100%;transition:background .15s,box-shadow .15s,transform .1s}',
      '.fc-inject:hover{background:#f3e8ff;transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,.15)}',
      '.fc-inject.loading{opacity:.5;pointer-events:none}'
    ].join('\n');
    document.head.appendChild(el);
  })();

  // ═══════════════════════════════════════════════════════════════
  // GATHER DATA
  // ═══════════════════════════════════════════════════════════════
  async function gatherRows() {
    var activeOD = unsafeWindow.proshack.getActiveTabOD();
    var parts = (activeOD || '-').split('-');
    var filters = unsafeWindow.proshack.read_menu_filters();
    var csvString = await unsafeWindow.proshack.historical_downloadAllCSVs(
      parts[0], parts[1], {skipDownload: true}
    );

    var sql = 'SELECT a.[Departure Date], a.[Final Alpha Seasonal], a.[Final Lambda Seasonal], ' +
      'a.[Final Alpha Influenced], a.[Final Lambda Influenced], ' +
      'a.[Departure Time], a.dcp as DCP ' +
      'FROM CSV(?, {headers:true}) AS a ' +
      'JOIN ? AS b ON a.dcp = b.DCP ' +
      "WHERE [Passenger Type] = 'I' AND [Compartment] = 'Y'";

    if (!("POS" in filters)) { alert('No POS selected'); return null; }
    var posList = filters.POS.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    sql += ' AND (' + posList.map(function (m) {
      return "a.POS = '" + m.replace(/'/g, "''") + "'";
    }).join(' OR ') + ')';

    if ("PATH" in filters) {
      var pl = filters.PATH.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (pl.length) sql += ' AND (' + pl.map(function (m) {
        return "[Path] = '" + m.replace(/'/g, "''") + "'";
      }).join(' OR ') + ')';
    } else {
      try {
        var pr = await alasql.promise(
          "SELECT [Path], COUNT(*) as n FROM CSV(?, {headers:true}) GROUP BY [Path] ORDER BY n DESC LIMIT 1",
          [csvString]
        );
        if (pr && pr.length && pr[0].Path)
          sql += " AND [Path] = '" + pr[0].Path.replace(/'/g, "''") + "'";
      } catch (e) {}
    }

    if ("DOW" in filters) {
      var dm = {Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6};
      var days = filters.DOW.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
        .map(function (d) { return dm[d]; }).filter(function (d) { return d != null; });
      if (days.length) sql += ' AND (' + days.map(function (d) {
        return '[Day of Week] = ' + d;
      }).join(' OR ') + ')';
    }

    // Do NOT pre-filter Departure Time here.
    // The modal Dep Time selector will handle individual time vs ALL aggregation.
    //
    // if ("DEPARTURE_TIME" in filters) {
    //   var dtl = filters.DEPARTURE_TIME.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    //   if (dtl.length) sql += ' AND (' + dtl.map(function (m) {
    //     return "[Departure Time] = '" + m.replace(/'/g, "''") + "'";
    //   }).join(' OR ') + ')';
    // }

    if ("DEPARTURE_TIME" in filters) {
      var dtl = filters.DEPARTURE_TIME
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);

      if (dtl.length) {
        sql += ' AND (' + dtl.map(function (m) {
          return "[Departure Time] = '" + m.replace(/'/g, "''") + "'";
        }).join(' OR ') + ')';
      }
    }

    var rows = await alasql.promise(sql, [csvString, DCP_DATA]);
    console.log('[FC] ' + rows.length + ' raw rows');
    return {rows: rows, od: activeOD};
  }

  // ═══════════════════════════════════════════════════════════════
  // SHOW MODAL
  // ═══════════════════════════════════════════════════════════════
  function showModal(allRows, od) {
    var dcps = [], deps = [], seen = {};
    allRows.forEach(function (r) {
      if (!seen['d' + r.DCP]) { seen['d' + r.DCP] = 1; dcps.push(r.DCP); }
      var dt = r['Departure Time'];
      if (dt && !seen['t' + dt]) { seen['t' + dt] = 1; deps.push(dt); }
    });
    dcps.sort(function (a, b) { return a - b; });
    deps.sort();

    var allowedDepTimes = deps.slice();

    var overlay = document.createElement('div');
    overlay.className = 'fc-overlay';
    var modal = document.createElement('div');
    modal.className = 'fc-modal';

    var hdr = document.createElement('div');
    hdr.className = 'fc-hdr';
    hdr.innerHTML = '<div><h3>Counter Forecast</h3><span class="fc-sub">' + (od || '') + '</span></div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'fc-close';
    closeBtn.textContent = '\u00D7';
    hdr.appendChild(closeBtn);
    modal.appendChild(hdr);

    var ctrl = document.createElement('div');
    ctrl.className = 'fc-ctrl';

    function addSel(lbl, opts) {
      var label = document.createElement('label');
      label.textContent = lbl;
      var sel = document.createElement('select');
      opts.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = typeof o === 'object' ? o.v : o;
        opt.textContent = typeof o === 'object' ? o.t : o;
        sel.appendChild(opt);
      });
      label.appendChild(sel);
      ctrl.appendChild(label);
      return sel;
    }

    function addNum(lbl, val, min, step) {
      var label = document.createElement('label');
      label.textContent = lbl;
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.value = val;
      if (min != null) inp.min = min;
      if (step != null) inp.step = step;
      inp.style.minWidth = '70px';
      label.appendChild(inp);
      ctrl.appendChild(label);
      return inp;
    }

    function addChk(id, txt, defaultVal, storageKey) {
      var lbl = document.createElement('label');
      lbl.className = 'fc-chk';
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = id;
      var stored = null;
      if (storageKey) {
        try { stored = localStorage.getItem(storageKey); } catch (e) {}
      }
      chk.checked = stored != null ? (stored === '1') : !!defaultVal;
      if (storageKey) {
        chk.addEventListener('change', function () {
          try { localStorage.setItem(storageKey, chk.checked ? '1' : '0'); } catch (e) {}
        });
      }
      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(' ' + txt));
      ctrl.appendChild(lbl);
      return chk;
    }

    var selMetric = addSel('Metric', [
      {v: 'Final Alpha Seasonal', t: 'Alpha'},
      {v: 'Final Lambda Seasonal', t: 'Lambda'}
    ]);
    var selDcp = addSel('DCP', dcps.map(function (d) { return {v: d, t: 'DCP ' + d}; }));
    var selDep = addSel(
      'Dep Time',
      [{v: '__ALL__', t: 'ALL'}].concat(
        deps.map(function (d) {
          return {v: d, t: d};
        })
      )
    );
    var selFreq = addSel('Freq', [{v:'W',t:'Weekly'},{v:'D',t:'Daily'},{v:'M',t:'Monthly'}]);
    var selAgg = addSel('Agg', ['mean', 'sum', 'median']);
    var selTT = addSel('Target Type', [
      {v: 'level', t: 'Level (alpha/lambda)'},
      {v: 'additive', t: 'Additive (counts/sums)'}
    ]);
    var inpH = addNum('Horizon (0 = auto)', 0, 0, 1);

    var biasChk = addChk('fc-bias', 'Bias correction', false, 'fc-bias-default');
    var filterChk = addChk('fc-filter', 'Filter unrealistic', true, 'fc-filter-default');
    var outlierChk = addChk(
      'fc-outliers',
      'Outlier cleaning',
      false,
      'fc-outlier-default'
    );

    var runBtn = document.createElement('button');
    runBtn.className = 'fc-run';
    runBtn.textContent = 'Run Forecast';
    ctrl.appendChild(runBtn);
    modal.appendChild(ctrl);

    function syncFromMetric() {
      var v = selMetric.value;
      var isAlpha  = v.indexOf('Alpha')  >= 0;
      var isLambda = v.indexOf('Lambda') >= 0;

      if (isAlpha) {
        selAgg.value = 'sum';
        selTT.value  = 'additive';
      } else if (isLambda) {
        selAgg.value = 'sum';
        selTT.value  = 'additive';
      } else {
        selAgg.value = 'sum';
        selTT.value  = 'additive';
      }
    }
    selMetric.onchange = syncFromMetric;
    syncFromMetric();

    var tabsBar = document.createElement('div');
    tabsBar.className = 'fc-tabs';
    var tabNames = ['Forecast & Intervals', 'Model Breakdown', 'Seasonality & Outliers', 'Diagnostics'];
    var tabKeys  = ['forecast', 'models', 'seasonality', 'diagnostics'];
    tabNames.forEach(function (name, i) {
      var b = document.createElement('button');
      b.className = 'fc-tab' + (i === 0 ? ' active' : '');
      b.dataset.tab = tabKeys[i];
      b.textContent = name;
      tabsBar.appendChild(b);
    });
    modal.appendChild(tabsBar);

    var body = document.createElement('div');
    body.className = 'fc-body';
    body.innerHTML = '<div class="fc-status">Select parameters and click <b>Run Forecast</b></div>';
    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var _charts = {};
    function cleanup() {
      Object.keys(_charts).forEach(function (k) { if (_charts[k]) _charts[k].destroy(); });
      _charts = {};
      overlay.remove();
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onEsc);
    closeBtn.onclick = cleanup;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cleanup(); });

    runBtn.onclick = async function () {
      var metric = selMetric.value;
      var metricShort = metric.indexOf('Alpha') >= 0 ? 'Alpha'
                      : metric.indexOf('Lambda') >= 0 ? 'Lambda' : metric;
      var dcp = parseInt(selDcp.value, 10);
      var dep = selDep.value;
      var depAll = dep === '__ALL__';
      var depLabel = depAll ? 'ALL (' + deps.length + ' dep times)' : dep;
      var freq = selFreq.value;
      var agg = selAgg.value;
      var targetType = selTT.value;
      var h = parseInt(inpH.value, 10) || 0;
      var biasCorrection = !!biasChk.checked;
      var filterUnrealistic = !!filterChk.checked;
      var outlierCleaning = !!outlierChk.checked;

      var influencedCol = null;
      if (metric === 'Final Alpha Seasonal')  influencedCol = 'Final Alpha Influenced';
      if (metric === 'Final Lambda Seasonal') influencedCol = 'Final Lambda Influenced';

      var dcpInfo = null;
      for (var di = 0; di < DCP_DATA.length; di++) {
        if (DCP_DATA[di].DCP === dcp) { dcpInfo = DCP_DATA[di]; break; }
      }
      if (!dcpInfo) {
        body.innerHTML = '<div class="fc-err">DCP ' + dcp + ' not found.</div>';
        return;
      }

      var cacheKey = [
          od, dcp, depLabel, metric, freq, agg, targetType, h,
          biasCorrection ? 1 : 0,
          filterUnrealistic ? 1 : 0,
          typeof outlierCleaning !== 'undefined' && outlierCleaning ? 1 : 0
        ].join('|');
      var cached = getCached(cacheKey);
      if (cached) {
        renderResults(body, tabsBar, cached.result, cached.meta, _charts);
        return;
      }

      var filtered = allRows.filter(function (r) {
        return String(r.DCP) === String(dcp) &&
              (depAll || r['Departure Time'] === dep);
      });

      //debuging
      var depTimesUsed = Array.from(new Set(
        filtered.map(function (r) { return r['Departure Time']; })
      )).sort();

      console.log('[FC] depAll=', depAll);
      console.log('[FC] depTimesUsed=', depTimesUsed);
      console.log('[FC] depTimesUsed count=', depTimesUsed.length);
      console.log('[FC] filtered rows=', filtered.length);

      if (filtered.length < 10) {
        body.innerHTML = '<div class="fc-err">Only ' + filtered.length + ' rows. Need \u2265 10.</div>';
        return;
      }

      console.log('[FC] DCP ' + dcp + ' DyPr ' + dcpInfo['DyPr Start'] + '-' + dcpInfo['DyPr End'] +
            ', dep_time=' + depLabel +
            ', ' + filtered.length + ' rows, target=' + targetType + ', h=' + h +
            ', bias_correction=' + biasCorrection +
            ', filter_unrealistic=' + filterUnrealistic);

      var meta = {
        od: od,
        metric: metricShort,
        departureTime: depLabel,
        departureTimeAll: depAll,
        dcp: dcp,
        freq: freq,
        agg: agg,
        targetType: targetType,
        biasCorrection: biasCorrection,
        filterUnrealistic: filterUnrealistic,

        influencedCol: influencedCol,
        rawRows: filtered
      };

      var payloadRows = filtered.map(function (r) {
        var o = {};
        o['Departure Date'] = r['Departure Date'];
        o[metric] = r[metric];

        // Pass the corresponding influenced forecast column to the server
        if (influencedCol) {
          o[influencedCol] = r[influencedCol];
        }

        return o;
      });

      runBtn.disabled = true;
      runBtn.textContent = 'Submitting\u2026';
      tabsBar.classList.remove('visible');
      body.innerHTML = '<div class="fc-status">Submitting job\u2026</div>';

      try {
        // 11 positional args matching v3.2 server signature:
        // rows, value_col, date_col, agg, freq,
        // dypr_start, dypr_end, target_type, h,
        // bias_correction, filter_unrealistic
        var sub = await gradioCall('submit_arima', [
          payloadRows, metric, 'Departure Date', agg, freq,
          dcpInfo['DyPr Start'], dcpInfo['DyPr End'],
          targetType, h,
          biasCorrection,
          filterUnrealistic,
          influencedCol,
          outlierCleaning
        ]);
        if (!sub || !sub.job_id) throw new Error('No job_id: ' + JSON.stringify(sub));

        var start = Date.now();
        while (Date.now() - start < 300000) {
          await new Promise(function (r) { setTimeout(r, 4000); });
          runBtn.textContent = 'Processing\u2026';
          body.innerHTML = '<div class="fc-status">Processing\u2026 (' +
            Math.round((Date.now() - start) / 1000) + 's)</div>';
          var s = await gradioCall('check_arima', [sub.job_id]);
          if (s.status === 'done') {
            setCached(cacheKey, {result: s.result, meta: meta});
            renderResults(body, tabsBar, s.result, meta, _charts);
            return;
          }
          if (s.status === 'error') throw new Error(s.error || 'Job failed');
          if (s.status === 'not_found') throw new Error('Job lost');
        }
        throw new Error('Timeout (5 min)');
      } catch (err) {
        console.error('[FC] failed:', err);
        body.innerHTML = '<div class="fc-err">Error: ' + (err.message || err) + '</div>';
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'Run Forecast';
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER RESULTS
  // ═══════════════════════════════════════════════════════════════
  function renderResults(bodyEl, tabsEl, result, meta, charts) {
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    });
    bodyEl._diagDone = false;

    tabsEl.classList.add('visible');
    tabsEl.querySelectorAll('.fc-tab').forEach(function (t, i) {
      t.classList.toggle('active', i === 0);
    });

    var fcDates = parseDates(result.forecast_dates);
    var sysFcDates = parseDates(result.system_forecast_dates);
    var sysFcVals = result.system_forecast || [];
    var sysInfDates = parseDates(result.system_influenced_dates);
    var sysInfVals  = result.system_influenced || [];
    var histDates = parseDates(result.historical_dates);
    var histRaw   = (result.historical_values   || []).slice(0, histDates.length);
    var histClean = (result.historical_cleaned  || []).slice(0, histDates.length);
    var outFlags  = (result.outlier_flags       || []).slice(0, histDates.length);

    var fc = result.forecast || [];
    var models = result.models || {};
    var weights = result.ensemble_weights || {};
    var intervals = result.intervals || {};
    var diagnostics = result.diagnostics || {};
    var serverMeta = result.meta || {};
    var modelNames = Object.keys(models);

    var n = Math.min(fcDates.length, fc.length);
    if (intervals['80'] && intervals['80'].lo) n = Math.min(n, intervals['80'].lo.length);
    if (intervals['95'] && intervals['95'].lo) n = Math.min(n, intervals['95'].lo.length);
    fcDates = fcDates.slice(0, n);
    fc = fc.slice(0, n);

    var nSys = Math.min(sysFcDates.length, sysFcVals.length);
    sysFcDates = sysFcDates.slice(0, nSys);
    sysFcVals = sysFcVals.slice(0, nSys);
    var nInf = Math.min(sysInfDates.length, sysInfVals.length);
    sysInfDates = sysInfDates.slice(0, nInf);
    sysInfVals = sysInfVals.slice(0, nInf);

    var TAIL = meta.freq === 'M' ? 12 : meta.freq === 'D' ? 180 : 26;
    var zoomHD = histDates.slice(-TAIL);
    var zoomHV = histClean.length ? histClean.slice(-TAIL) : histRaw.slice(-TAIL);

    var last = fc.length > 0 ? fc[fc.length - 1] : null;
    var first = fc.length > 0 ? fc[0] : null;
    var trend = last && first && first !== 0 ? ((last - first) / Math.abs(first) * 100) : 0;
    var freqUnit = meta.freq === 'M' ? 'month' : meta.freq === 'D' ? 'day' : 'week';
    var freqLabel = meta.freq === 'M' ? 'Monthly' : meta.freq === 'D' ? 'Daily' : 'Weekly';

    var quality = diagnostics.forecastability || 'unknown';
    var bestWape = diagnostics.best_wape;
    var snWape = diagnostics.seasonal_naive_wape;
    var nOutliers = diagnostics.n_outliers || 0;
    var bestModel = diagnostics.best_model || '\u2014';

    // ── Feature tags for chart title ────────────────────────────
    var versionTag = serverMeta.version || 'v?';
    var featureTags = [];
    if (serverMeta.mstl_enabled)   featureTags.push('MSTL');
    if (serverMeta.boxcox_enabled) {
      featureTags.push('Box-Cox \u03BB=' +
        (serverMeta.boxcox_lambda != null ? Number(serverMeta.boxcox_lambda).toFixed(2) : '?'));
    }
    if (serverMeta.bias_correction_enabled || diagnostics.bias_correction_enabled) {
      featureTags.push('bias-corr');
    }
    if (serverMeta.filter_unrealistic_enabled || diagnostics.filter_unrealistic_enabled) {
      featureTags.push('filter');
    }
    var featureSuffix = featureTags.length
      ? ' \u00B7 ' + featureTags.join(' \u00B7 ')
      : '';

    // ── Optional Box-Cox lambda tile ────────────────────────────
    var boxcoxTile = serverMeta.boxcox_enabled
      ? '<div class="fc-metric"><div class="fc-metric__val">' +
        (serverMeta.boxcox_lambda != null ? Number(serverMeta.boxcox_lambda).toFixed(2) : '\u2014') +
        '</div><div class="fc-metric__lbl">Box-Cox \u03BB</div></div>'
      : '';

    // ── Warning banners (ensemble warning + drop count) ─────────
    var ensWarning = diagnostics.ensemble_warning;
    var droppedList = diagnostics.dropped_models || [];
    var filterFallbackUsed = !!diagnostics.filter_fallback_used;

    var warnHtml = '';
    if (ensWarning) {
      warnHtml +=
        '<div class="fc-warn">' +
          '<span class="fc-warn__icon">\u26A0</span>' +
          '<span><b>Ensemble warning:</b> ' + ensWarning +
          '. Interpret with caution.</span>' +
        '</div>';
    }
    if (filterFallbackUsed) {
      warnHtml +=
        '<div class="fc-warn">' +
          '<span class="fc-warn__icon">\u26A0</span>' +
          '<span><b>Filter fallback:</b> all models were flagged as unrealistic. ' +
          'Forecast was regenerated with the filter disabled.</span>' +
        '</div>';
    }
    if (droppedList.length > 0) {
      warnHtml +=
        '<div class="fc-info">' +
          '<b>' + droppedList.length + '</b> candidate model(s) dropped by filter. ' +
          'See <b>Diagnostics</b> tab for details.' +
        '</div>';
    }

    bodyEl.innerHTML =
      '<div class="fc-panel active" data-panel="forecast">' +
        warnHtml +
        '<div class="fc-metrics">' +
          '<div class="fc-metric"><div class="fc-metric__val">' + fmt(last, 2) + '</div><div class="fc-metric__lbl">Final Forecast</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val" style="color:' + (trend >= 0 ? '#34a853' : '#ea4335') + '">' + (trend >= 0 ? '+' : '') + fmt(trend, 1) + '%</div><div class="fc-metric__lbl">Horizon Trend</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val"><span class="fc-quality fc-quality--' + quality + '">' + quality + '</span></div><div class="fc-metric__lbl">Forecastability</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val">' + (bestWape != null ? (bestWape * 100).toFixed(1) + '%' : '\u2014') + '</div><div class="fc-metric__lbl">Best WAPE</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val">' + (snWape != null ? (snWape * 100).toFixed(1) + '%' : '\u2014') + '</div><div class="fc-metric__lbl">SeasNaive WAPE</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val">' + modelNames.length + '</div><div class="fc-metric__lbl">Models</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val">' + n + '</div><div class="fc-metric__lbl">Horizon</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val">' + histRaw.length + '</div><div class="fc-metric__lbl">' + freqLabel + ' Obs</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val" style="color:' + (nOutliers > 0 ? '#ea4335' : '#1a73e8') + '">' + nOutliers + '</div><div class="fc-metric__lbl">Outliers</div></div>' +
          '<div class="fc-metric"><div class="fc-metric__val" style="color:' + (droppedList.length > 0 ? '#ea4335' : '#1a73e8') + '">' + droppedList.length + '</div><div class="fc-metric__lbl">Dropped</div></div>' +
          boxcoxTile +
        '</div>' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">' +
            '<div>Ensemble vs System Forecast <span>' + meta.metric + ' \u00B7 DCP ' + meta.dcp + ' \u00B7 ' + meta.departureTime + ' \u00B7 ' + meta.agg + ' \u00B7 ' + (meta.targetType || '') + ' \u00B7 best: ' + bestModel + ' \u00B7 API ' + versionTag + featureSuffix + '</span></div>' +
            '<div><button id="fc-zoom-toggle" style="font-size:11px;padding:3px 10px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;color:#64748b">Zoom to Recent</button></div>' +
          '</div>' +
          '<div class="fc-chart-wrap"><canvas id="fc-c-forecast"></canvas></div>' +
        '</div>' +
      '</div>' +
      '<div class="fc-panel" data-panel="models">' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Individual Model Predictions vs System</div>' +
          '<div class="fc-chart-wrap"><canvas id="fc-c-models"></canvas></div>' +
        '</div>' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Ensemble Weights</div>' +
          '<div id="fc-weights-table" style="overflow-x:auto"></div>' +
        '</div>' +
      '</div>' +
      '<div class="fc-panel" data-panel="seasonality">' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Projected Seasonal Component</div>' +
          '<div class="fc-chart-wrap"><canvas id="fc-c-seasonal"></canvas></div>' +
        '</div>' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Historical Series with Outlier Detection <span>red dots = winsorized</span></div>' +
          '<div class="fc-chart-wrap"><canvas id="fc-c-outliers"></canvas></div>' +
        '</div>' +
      '</div>' +
      '<div class="fc-panel" data-panel="diagnostics">' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Backtest Leaderboard <span>per (model, transform), sorted by WAPE</span></div>' +
          '<div id="fc-leaderboard" style="overflow-x:auto"></div>' +
        '</div>' +
        '<div class="fc-chart-box" id="fc-dropped-box">' +
          '<div class="fc-chart-title">Dropped Models <span>filtered as unrealistic or degenerate</span></div>' +
          '<div id="fc-dropped-table" style="overflow-x:auto"></div>' +
        '</div>' +
        '<div class="fc-chart-box" id="fc-bias-box">' +
          '<div class="fc-chart-title">Bias Corrections Applied <span>shift subtracted from each model\'s forecast</span></div>' +
          '<div id="fc-bias-table" style="overflow-x:auto"></div>' +
        '</div>' +
        '<div class="fc-chart-box">' +
          '<div class="fc-chart-title">Forecast Summary Table</div>' +
          '<div id="fc-diag-table" style="overflow-x:auto"></div>' +
        '</div>' +
      '</div>';

    var panels = bodyEl.querySelectorAll('.fc-panel');
    tabsEl.querySelectorAll('.fc-tab').forEach(function (tab) {
      tab.onclick = function () {
        tabsEl.querySelectorAll('.fc-tab').forEach(function (t) { t.classList.remove('active'); });
        panels.forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        bodyEl.querySelector('[data-panel="' + tab.dataset.tab + '"]').classList.add('active');
        if (tab.dataset.tab === 'models' && !charts.models) { renderModels(); renderWeights(); }
        if (tab.dataset.tab === 'seasonality' && !charts.seasonal) renderSeasonality();
        if (tab.dataset.tab === 'diagnostics' && !bodyEl._diagDone) renderDiagnostics();
      };
    });

    function pts(xa, ya) {
      var o = [];
      for (var i = 0; i < xa.length && i < ya.length; i++) {
        o.push({x: xa[i], y: ya[i]});
      }
      return o;
    }

    // ─── FORECAST CHART ────────────────────────────────────────────
    var showAll = true;

    function buildForecastChart() {
      var canvas = bodyEl.querySelector('#fc-c-forecast');
      if (!canvas) return;
      if (charts.forecast) { charts.forecast.destroy(); delete charts.forecast; }

      var hd = showAll ? histDates : zoomHD;
      var hv = showAll ? (histClean.length ? histClean : histRaw) : zoomHV;

      var datasets = [];
      var idx = 0;

      if (intervals['95'] && intervals['95'].lo && intervals['95'].hi) {
        var loIdx95 = idx;
        datasets.push({
          label: '95% lo', data: pts(fcDates, intervals['95'].lo),
          borderColor: 'rgba(251,188,4,0.25)', borderWidth: 1,
          pointRadius: 0, fill: false
        }); idx++;
        datasets.push({
          label: '95% Confidence', data: pts(fcDates, intervals['95'].hi),
          borderColor: 'rgba(251,188,4,0.25)', borderWidth: 1,
          pointRadius: 0, fill: {target: loIdx95},
          backgroundColor: 'rgba(251,188,4,0.08)'
        }); idx++;
      }

      if (intervals['80'] && intervals['80'].lo && intervals['80'].hi) {
        var loIdx80 = idx;
        datasets.push({
          label: '80% lo', data: pts(fcDates, intervals['80'].lo),
          borderColor: 'rgba(26,115,232,0.25)', borderWidth: 1,
          pointRadius: 0, fill: false
        }); idx++;
        datasets.push({
          label: '80% Confidence', data: pts(fcDates, intervals['80'].hi),
          borderColor: 'rgba(26,115,232,0.25)', borderWidth: 1,
          pointRadius: 0, fill: {target: loIdx80},
          backgroundColor: 'rgba(26,115,232,0.10)'
        }); idx++;
      }

      datasets.push({
        label: 'Historical', data: pts(hd, hv),
        borderColor: 'rgb(26,115,232)', backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 0, spanGaps: false
      }); idx++;

      var sysPts = pts(sysFcDates, sysFcVals);
      if (hd.length > 0 && hv.length > 0 && sysPts.length > 0) {
        sysPts.unshift({x: hd[hd.length - 1], y: hv[hv.length - 1]});
      }
      datasets.push({
        label: 'System Forecast', data: sysPts,
        borderColor: 'rgb(52,168,83, 0.8)', backgroundColor: 'transparent',
        borderWidth: 2.5, pointRadius: 0,
        pointBackgroundColor: 'rgb(52,168,83)'
      }); idx++;

      var fcPts = pts(fcDates, fc);
      if (hd.length > 0 && hv.length > 0 && fcPts.length > 0) {
        fcPts.unshift({x: hd[hd.length - 1], y: hv[hv.length - 1]});
      }
      datasets.push({
        label: 'Ensemble Forecast', data: fcPts,
        borderColor: 'rgb(234,67,53)', backgroundColor: 'transparent',
        borderWidth: 2.5, borderDash: [6, 4],
        pointRadius: 0, pointBackgroundColor: 'rgb(234,67,53)'
      }); idx++;

      var infPts = pts(sysInfDates, sysInfVals);
      if (hd.length > 0 && hv.length > 0 && infPts.length > 0) {
        infPts.unshift({x: hd[hd.length - 1], y: hv[hv.length - 1]});
      }

      if (infPts.length > 0) {
        datasets.push({
          label: (meta.influencedCol || 'Influenced Forecast').replace(/^Final\s+/i, ''),
          data: infPts,
          borderColor: 'rgb(147,52,230, 0.8)',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          //borderDash: [2, 3],
          pointRadius: 0,
          pointBackgroundColor: 'rgb(147,52,230)'
        });
        idx++;
      }

      var tUnit = showAll ? 'month' : freqUnit;

      charts.forecast = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {datasets: datasets},
        plugins: [monthLinesPlugin, stickyTooltipPlugin],
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: {mode: 'x', intersect: false},//index
          plugins: {
            legend: {
              position: 'top',
              labels: {
                usePointStyle: true, boxWidth: 8,
                filter: function (item) {
                  return item.text !== '95% lo' && item.text !== '80% lo';
                }
              }
            },
          
           tooltip: {
              animation: {duration: 300, easing: 'easeOutQuart'},//false,
              animations: {opacity: false}, //x: false, y: false, 
              position: 'nearest',
              caretPadding: 12, // extra pixels between anchor and tooltip (default is 2)

              bodyFont: {family: 'monospace', size: 12},
              titleFont: {size: 12, weight: '600'},
              bodyAlign: 'left',

              callbacks: {
                title: function (items) {
                  if (!items || !items.length) return '';
                  var d = new Date(items[0].parsed.x);
                  return MONTHS_SHORT[d.getMonth()] + ' ' +
                        String(d.getDate()).padStart(2, '0') + ', ' +
                        d.getFullYear();
                },
                label: function (ctx) {
                  var v = ctx.parsed && ctx.parsed.y;
                  if (v == null) return null;
                  var lbl = (ctx.dataset.label || '').padEnd(20, '\u00A0');
                  var num = String(fmt(v, 2)).padStart(10, '\u00A0');
                  return lbl + '\u00A0\u00A0' + num;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'time',
              time: {
                unit: tUnit,
                displayFormats: {week: 'dd MMM yy', month: 'MMM yy', day: 'dd MMM'},
                tooltipFormat: 'MMM dd, yyyy'
              },
              ticks: {maxRotation: 90, minRotation: 45, autoSkip: true, maxTicksLimit: 30},
              grid: {display: false}
            },
            y: {title: {display: true, text: meta.metric}, grid: {color: '#f1f5f9'}, min: 0}
          }
        }
      });
    }
    buildForecastChart();

    var zoomBtn = bodyEl.querySelector('#fc-zoom-toggle');
    if (zoomBtn) {
      zoomBtn.onclick = function () {
        showAll = !showAll;
        zoomBtn.textContent = showAll ? 'Zoom to Recent' : 'Show All History';
        var wrap = bodyEl.querySelector('#fc-c-forecast').parentElement;
        wrap.innerHTML = '<canvas id="fc-c-forecast"></canvas>';
        buildForecastChart();
      };
    }

    // ─── MODEL BREAKDOWN ───────────────────────────────────────────
    function renderModels() {
      var canvas = bodyEl.querySelector('#fc-c-models');
      if (!canvas) return;
      if (modelNames.length === 0) {
        canvas.parentElement.innerHTML = '<div class="fc-empty">No individual model data</div>';
        return;
      }
      var colors = [
        '#1a73e8', '#34a853', '#fbbc04', '#ea4335', '#9334e6', '#ff6d01',
        '#00897b', '#5e35b1', '#d81b60', '#3949ab',
        '#0891b2', '#65a30d', '#c026d3', '#b45309'
      ];
      var ds = modelNames.map(function (name, i) {
        return {
          label: name,
          data: pts(fcDates, models[name] || []),
          borderColor: colors[i % colors.length],
          backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 1, borderDash: [4, 4]
        };
      });
      ds.push({
        label: 'Ensemble', data: pts(fcDates, fc),
        borderColor: '#0f172a', backgroundColor: 'transparent',
        borderWidth: 3, pointRadius: 3, order: -1
      });
      if (nSys > 0) {
        ds.push({
          label: 'System Forecast', data: pts(sysFcDates, sysFcVals),
          borderColor: 'rgb(52,168,83, 0.8)', backgroundColor: 'transparent',
          borderWidth: 2.5, pointRadius: 2,
          pointBackgroundColor: 'rgb(52,168,83)', order: -2
        });
      }
      if (nInf > 0) {
        ds.push({
          label: (meta.influencedCol || 'Influenced Forecast').replace(/^Final\s+/i, ''),
          data: pts(sysInfDates, sysInfVals),
          borderColor: 'rgb(147,52,230, 0.8)',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          //borderDash: [2, 3],
          pointRadius: 2,
          pointBackgroundColor: 'rgb(147,52,230)',
          order: -3
        });
      }
      charts.models = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {datasets: ds},
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: {mode: 'index', intersect: false},
          plugins: {
            legend: {position: 'top', labels: {usePointStyle: true, boxWidth: 8}},
            tooltip: {
              callbacks: {
                title: function (items) {
                  var ts = items[0] && items[0].parsed && items[0].parsed.x;
                  return ts ? new Date(ts).toLocaleDateString() : '';
                }
              }
            }
          },
          scales: {
            x: {type: 'time',
                time: {unit: 'week', displayFormats: {week: 'dd MMM'}, tooltipFormat: 'dd MMM yyyy'},
                grid: {display: false}},
            y: {title: {display: true, text: meta.metric}, grid: {color: '#f1f5f9'}}
          }
        }
      });
    }

    function renderWeights() {
      var el = bodyEl.querySelector('#fc-weights-table');
      if (!el) return;
      var keys = Object.keys(weights);
      if (keys.length === 0) {
        el.innerHTML = '<div class="fc-empty">No ensemble weights (fallback equal-weight)</div>';
        return;
      }
      keys.sort(function (a, b) { return (weights[b] || 0) - (weights[a] || 0); });
      var html = '<table class="fc-tbl"><thead><tr><th>Model / Transform</th><th>Weight</th></tr></thead><tbody>';
      keys.forEach(function (k) {
        var w = weights[k] || 0;
        html += '<tr><td>' + k + '</td><td>' + (w * 100).toFixed(1) + '%</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    // ─── SEASONALITY & OUTLIERS ────────────────────────────────────
    function renderSeasonality() {
      var canvas = bodyEl.querySelector('#fc-c-seasonal');
      if (canvas) {
        var sc = result.seasonal_component;
        if (!sc || sc.length === 0) {
          canvas.parentElement.innerHTML = '<div class="fc-empty">No seasonal component</div>';
        } else {
          var scPts = pts(fcDates, sc);
          charts.seasonal = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
              datasets: [{
                label: 'Seasonal Effect',
                data: scPts,
                backgroundColor: scPts.map(function (d) {
                  return d.y >= 0 ? 'rgba(52,168,83,0.6)' : 'rgba(234,67,53,0.6)';
                }),
                borderColor: scPts.map(function (d) {
                  return d.y >= 0 ? 'rgb(52,168,83)' : 'rgb(234,67,53)';
                }),
                borderWidth: 1, borderRadius: 3
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: {
                legend: {display: false},
                tooltip: {
                  callbacks: {
                    title: function (items) {
                      var ts = items[0] && items[0].parsed && items[0].parsed.x;
                      return ts ? new Date(ts).toLocaleDateString() : '';
                    },
                    label: function (ctx) { return 'Seasonal: ' + fmt(ctx.parsed.y, 3); }
                  }
                }
              },
              scales: {
                x: {type: 'time', time: {unit: 'week', displayFormats: {week: 'dd MMM'}},
                    grid: {display: false}},
                y: {title: {display: true, text: 'Seasonal Component'}, grid: {color: '#f1f5f9'}}
              }
            }
          });
        }
      }

      var canvas2 = bodyEl.querySelector('#fc-c-outliers');
      if (canvas2) {
        var rawPts   = pts(histDates, histRaw);
        var cleanPts = pts(histDates, histClean);
        var outPts = [];
        for (var i = 0; i < histDates.length; i++) {
          if (outFlags[i]) outPts.push({x: histDates[i], y: histRaw[i]});
        }
        charts.outliers = new Chart(canvas2.getContext('2d'), {
          type: 'line',
          data: {
            datasets: [
              {label: 'Raw',
               data: rawPts,
               borderColor: 'rgba(148,163,184,0.7)',
               backgroundColor: 'transparent',
               borderWidth: 1, pointRadius: 0},
              {label: 'Cleaned (winsorized)',
               data: cleanPts,
               borderColor: 'rgb(26,115,232)',
               backgroundColor: 'transparent',
               borderWidth: 2, pointRadius: 0},
              {label: 'Outliers',
               data: outPts,
               borderColor: 'rgb(234,67,53)',
               backgroundColor: 'rgb(234,67,53)',
               showLine: false, pointRadius: 4}
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: {mode: 'index', intersect: false},
            plugins: {
              legend: {position: 'top', labels: {usePointStyle: true, boxWidth: 8}},
              tooltip: {
                callbacks: {
                  title: function (items) {
                    var ts = items[0] && items[0].parsed && items[0].parsed.x;
                    return ts ? new Date(ts).toLocaleDateString() : '';
                  }
                }
              }
            },
            scales: {
              x: {type: 'time',
                  time: {unit: 'month', displayFormats: {month: 'MMM yy'}},
                  grid: {display: false}},
              y: {title: {display: true, text: meta.metric}, grid: {color: '#f1f5f9'}, min: 0}
            }
          }
        });
      }
    }

    // ─── DIAGNOSTICS ───────────────────────────────────────────────
    function renderDiagnostics() {
      bodyEl._diagDone = true;

      // ── Leaderboard ──────────────────────────────────────────
      var lb = bodyEl.querySelector('#fc-leaderboard');
      var scores = diagnostics.model_scores || [];
      if (lb) {
        if (scores.length === 0) {
          lb.innerHTML = '<div class="fc-empty">No backtest scores (insufficient data)</div>';
        } else {
          var html = '<table class="fc-tbl"><thead><tr>' +
            '<th>Model</th><th>Transform</th><th>WAPE</th><th>Bias</th><th>Folds</th><th>Weight</th>' +
            '</tr></thead><tbody>';
          scores.forEach(function (s, i) {
            var key = s.model + '/' + s.transform + '/s' + s.season;
            var w = weights[key];
            var rowCls = (i === 0) ? ' class="fc-best"' : '';
            var transformStyle = '';
            if (s.transform === 'log')    transformStyle = 'color:#9334e6';
            if (s.transform === 'boxcox') transformStyle = 'color:#0891b2;font-weight:600';
            html += '<tr' + rowCls + '>';
            html += '<td>' + s.model + '</td>';
            html += '<td style="' + transformStyle + '">' + s.transform + '</td>';
            html += '<td>' + (s.wape * 100).toFixed(2) + '%</td>';
            html += '<td>' + (s.bias >= 0 ? '+' : '') + (s.bias * 100).toFixed(2) + '%</td>';
            html += '<td>' + (s.folds || '\u2014') + '</td>';
            html += '<td>' + (w != null ? (w * 100).toFixed(1) + '%' : '\u2014') + '</td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
          lb.innerHTML = html;
        }
      }

      // ── Dropped models table ──────────────────────────────────
      var dropBox = bodyEl.querySelector('#fc-dropped-box');
      var dropEl = bodyEl.querySelector('#fc-dropped-table');
      if (dropBox && dropEl) {
        if (droppedList.length === 0) {
          dropBox.style.display = 'none';
        } else {
          dropBox.style.display = '';
          var dhtml = '<table class="fc-tbl"><thead><tr>' +
            '<th>Model / Transform</th>' +
            '<th>Reason</th>' +
            '</tr></thead><tbody>';
          droppedList.forEach(function (d) {
            var reason = d.reason || '';
            var reasonColor = '#991b1b';
            if (reason.indexOf('degenerate') >= 0) reasonColor = '#78350f';
            else if (reason.indexOf('linear') >= 0) reasonColor = '#991b1b';
            else if (reason.indexOf('oscillation') >= 0) reasonColor = '#9334e6';
            dhtml += '<tr>';
            dhtml += '<td>' + (d.key || '\u2014') + '</td>';
            dhtml += '<td style="color:' + reasonColor + ';font-weight:500;text-align:left">' + reason + '</td>';
            dhtml += '</tr>';
          });
          dhtml += '</tbody></table>';
          var thresholds = [];
          if (serverMeta.linear_r2_threshold != null)
            thresholds.push('R² \u2265 ' + serverMeta.linear_r2_threshold);
          if (serverMeta.oscillation_ratio_threshold != null)
            thresholds.push('osc-ratio < ' + serverMeta.oscillation_ratio_threshold);
          if (serverMeta.unrealistic_min_horizon != null)
            thresholds.push('min horizon ' + serverMeta.unrealistic_min_horizon);
          if (thresholds.length > 0) {
            dhtml += '<div style="font-size:11px;color:#94a3b8;margin-top:8px">' +
              'Filter thresholds: ' + thresholds.join(' \u00B7 ') +
              '</div>';
          }
          dropEl.innerHTML = dhtml;
        }
      }

      // ── Bias corrections table ────────────────────────────────
      var biasBox = bodyEl.querySelector('#fc-bias-box');
      var biasEl = bodyEl.querySelector('#fc-bias-table');
      var biasEnabled = !!(diagnostics.bias_correction_enabled ||
                           serverMeta.bias_correction_enabled);
      var biasCorrs = diagnostics.bias_corrections || {};
      var biasKeys = Object.keys(biasCorrs);

      if (biasBox && biasEl) {
        if (!biasEnabled) {
          biasBox.style.display = 'none';
        } else if (biasKeys.length === 0) {
          biasBox.style.display = '';
          biasEl.innerHTML =
            '<div class="fc-empty">Bias correction enabled but no shifts applied ' +
            '(no model met n_folds \u2265 ' +
            (serverMeta.bias_correction_min_folds != null
              ? serverMeta.bias_correction_min_folds : 3) +
            ' and |bias| > ' +
            (serverMeta.bias_correction_min_abs != null
              ? (serverMeta.bias_correction_min_abs * 100).toFixed(1) + '%'
              : '2%') +
            ').</div>';
        } else {
          biasBox.style.display = '';
          var shrink = serverMeta.bias_correction_shrink != null
            ? serverMeta.bias_correction_shrink : 0.5;
          biasKeys.sort(function (a, b) {
            return Math.abs(biasCorrs[b]) - Math.abs(biasCorrs[a]);
          });
          var bhtml = '<table class="fc-tbl"><thead><tr>' +
            '<th>Model / Transform</th>' +
            '<th>Shift applied</th>' +
            '<th>Direction</th>' +
            '</tr></thead><tbody>';
          biasKeys.forEach(function (k) {
            var v = biasCorrs[k];
            var color = v >= 0 ? '#34a853' : '#ea4335';
            var arrow = v >= 0 ? '\u25BC over-pred \u2192 lowered'
                              : '\u25B2 under-pred \u2192 raised';
            bhtml += '<tr>';
            bhtml += '<td>' + k + '</td>';
            bhtml += '<td style="color:' + color + ';font-weight:500">' +
              (v >= 0 ? '+' : '') + fmt(v, 3) + '</td>';
            bhtml += '<td style="color:' + color + ';font-size:11px">' + arrow + '</td>';
            bhtml += '</tr>';
          });
          bhtml += '</tbody></table>';
          bhtml += '<div style="font-size:11px;color:#94a3b8;margin-top:8px">' +
            'Shrinkage factor: ' + shrink + ' \u00B7 ' +
            'Total models corrected: ' + biasKeys.length +
            '</div>';
          biasEl.innerHTML = bhtml;
        }
      }

      // ── Forecast summary table ───────────────────────────────
      var el = bodyEl.querySelector('#fc-diag-table');
      if (!el) return;

      var sysLookup = {};
      for (var si = 0; si < nSys; si++) sysLookup[sysFcDates[si]] = sysFcVals[si];

      var infLookup = {};
      for (var ii = 0; ii < nInf; ii++) infLookup[sysInfDates[ii]] = sysInfVals[ii];

      var html2 = '<table class="fc-tbl"><thead><tr>';
      html2 += '<th>Date</th><th>System FC</th><th>Influenced FC</th><th>Ensemble FC</th><th>Diff vs System</th><th>Diff vs Influenced</th>';
      if (intervals['80']) html2 += '<th>80% CI</th>';
      if (intervals['95']) html2 += '<th>95% CI</th>';
      modelNames.forEach(function (m) { html2 += '<th>' + m + '</th>'; });
      html2 += '</tr></thead><tbody>';

      var fd = result.forecast_dates || [];
      for (var i = 0; i < n; i++) {
        var bg = i % 2 === 0 ? '#fff' : '#f8fafc';
        var sysVal = sysLookup[fcDates[i]];
        var diff = (sysVal != null && fc[i] != null) ? fc[i] - sysVal : null;
        var diffColor = diff != null ? (diff >= 0 ? '#34a853' : '#ea4335') : '#64748b';

        var infVal = infLookup[fcDates[i]];
        var diffInf = (infVal != null && fc[i] != null) ? fc[i] - infVal : null;
        var diffInfColor = diffInf != null ? (diffInf >= 0 ? '#34a853' : '#ea4335') : '#64748b';

        html2 += '<tr style="background:' + bg + '">';
        html2 += '<td>' + (fd[i] || '') + '</td>';
        html2 += '<td style="color:#34a853;font-weight:500">' + fmt(sysVal, 2) + '</td>';
        html2 += '<td style="color:#9334e6;font-weight:500">' + fmt(infVal, 2) + '</td>';

        html2 += '<td style="font-weight:600">' + fmt(fc[i], 2) + '</td>';

        html2 += '<td style="color:' + diffColor + ';font-weight:500">';
        html2 += diff != null ? (diff >= 0 ? '+' : '') + fmt(diff, 2) : '—';
        html2 += '</td>';

        html2 += '<td style="color:' + diffInfColor + ';font-weight:500">';
        html2 += diffInf != null ? (diffInf >= 0 ? '+' : '') + fmt(diffInf, 2) : '—';
        html2 += '</td>';
        if (intervals['80']) {
          html2 += '<td style="color:#64748b">' +
            fmt(intervals['80'].lo[i], 1) + ' \u2013 ' + fmt(intervals['80'].hi[i], 1) + '</td>';
        }
        if (intervals['95']) {
          html2 += '<td style="color:#94a3b8">' +
            fmt(intervals['95'].lo[i], 1) + ' \u2013 ' + fmt(intervals['95'].hi[i], 1) + '</td>';
        }
        modelNames.forEach(function (m) {
          html2 += '<td style="color:#475569">' + fmt(models[m] ? models[m][i] : null, 2) + '</td>';
        });
        html2 += '</tr>';
      }
      html2 += '</tbody></table>';
      el.innerHTML = html2;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BUTTON INJECTION
  // ═══════════════════════════════════════════════════════════════
  async function onClick(btn) {
    btn.classList.add('loading');
    try {
      var data = await gatherRows();
      if (data && data.rows) showModal(data.rows, data.od);
    } catch (e) {
      console.error('[FC] gather failed:', e);
      alert('Counter Forecast failed: ' + e.message);
    } finally {
      btn.classList.remove('loading');
    }
  }

  function injectButtons(target) {
    if (target.hasAttribute(INJECTED)) return;
    target.setAttribute(INJECTED, 'true');
    var btn = document.createElement('div');
    btn.className = 'fc-inject';
    btn.textContent = '\uD83D\uDCCA AI Counter Forecasts';
    btn.setAttribute('role', 'button');
    btn.onclick = function () { onClick(btn); };
    target.parentNode.insertBefore(btn, target.nextSibling);
  }

  function init() {
    document.querySelectorAll('.rm-container-historical-forecast-body .rm-measure-view-component')
      .forEach(injectButtons);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches && node.matches('.rm-container-historical-forecast-body .rm-measure-view-component'))
            injectButtons(node);
          if (node.querySelectorAll)
            node.querySelectorAll('.rm-measure-view-component').forEach(injectButtons);
        });
      });
    }).observe(document.body, {childList: true, subtree: true});
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
