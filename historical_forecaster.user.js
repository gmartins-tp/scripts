// ==UserScript==
// @name         Historical Forecast - AI Starter
// @namespace    http://tampermonkey.net/
// @version      0.5.1
// @description  Validate System Forecasts (Alpha + Lambda) + Diagnostics Tab (Heatmap + Quadrant)
// @author       Gil Martins
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/alasql/4.6.6/alasql.min.js
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js
// @noframes
// ==/UserScript==

// ─── STL / YoY Visualiser ───────────────────────────────────────────────────

(function() {
  'use strict';

  if (typeof Chart === 'undefined') {
    console.error('[RM AI] Chart.js not loaded. Ensure @require is in the metadata block.');
    return;
  }

  const WEEK_TO_MONTH = {
    0: 'Jan', 4: 'Feb', 8: 'Mar', 13: 'Apr', 17: 'May', 21: 'Jun',
    26: 'Jul', 30: 'Aug', 34: 'Sep', 39: 'Oct', 43: 'Nov', 47: 'Dec'
  };

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
  // MODULE-SCOPE HELPERS (accessible to all render functions)
  // ═══════════════════════════════════════════════════════════════════════

  function getISOWeek(dateStr) {
    const date = new Date(dateStr);
    const tmp = new Date(date.valueOf());
    const dayNum = (date.getDay() + 6) % 7;
    tmp.setDate(tmp.getDate() - dayNum + 3);
    const firstThursday = tmp.valueOf();
    tmp.setMonth(0, 1);
    if (tmp.getDay() !== 4) {
      tmp.setMonth(0, 1 + ((4 - tmp.getDay()) + 7) % 7);
    }
    return 1 + Math.ceil((firstThursday - tmp) / 604800000);
  }

  function weekLabel(w) {
    const hint = WEEK_TO_MONTH[(w - 1)] || WEEK_TO_MONTH[Object.keys(WEEK_TO_MONTH).reduce((p, c) =>
      Math.abs(c - (w - 1)) < Math.abs(p - (w - 1)) ? c : p, 0)] || '';
    return hint ? `Week ${w} (${hint})` : `Week ${w}`;
  }

  function rollingMean(arr, windowSize = 7) {
    const out = [];
    const half = Math.floor(windowSize / 2);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, count = 0;
      const start = Math.max(0, i - half);
      const end = Math.min(arr.length, i + half + 1);
      for (let j = start; j < end; j++) {
        const v = arr[j];
        if (v !== null && v !== undefined && !isNaN(v)) {
          sum += v;
          count++;
        }
      }
      out.push(count > 0 ? sum / count : null);
    }
    return out;
  }

  function ema(arr, alpha = 0.15) {
    const out = [];
    let s = null;
    for (const v of arr) {
      if (v === null || v === undefined || isNaN(v)) {
        out.push(null);
      } else {
        s = (s === null) ? v : alpha * v + (1 - alpha) * s;
        out.push(s);
      }
    }
    return out;
  }

  function smoothPoints(pointArray, windowSize) {
    const alpha = 2 / (windowSize + 1);
    const smoothed = ema(pointArray.map(p => p.y), alpha);
    return pointArray.map((p, i) => ({ x: p.x, y: smoothed[i] }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MODAL RENDERER
  // ═══════════════════════════════════════════════════════════════════════

  window.showStlModal = function(analysisJson) {
    // ── Support combined format {alpha, lambda} and legacy single format ──
    let byDcpAlpha, byDcpLambda, hasBothTypes;
    if (analysisJson && (analysisJson.alpha !== undefined || analysisJson.lambda !== undefined)) {
      byDcpAlpha   = analysisJson?.alpha?.by_dcp || {};
      byDcpLambda  = analysisJson?.lambda?.by_dcp || {};
      hasBothTypes = true;
    } else {
      byDcpLambda  = analysisJson?.by_dcp || {};
      byDcpAlpha   = {};
      hasBothTypes = false;
    }

    const keys = [...new Set([...Object.keys(byDcpAlpha), ...Object.keys(byDcpLambda)])];
    if (!keys.length) {
      alert('No DCP data found in analysis result.');
      return;
    }

    const meta = keys.map(k => {
      const m = k.match(/^dcp(\d+)_(.+)$/);
      return m ? { key: k, dcp: parseInt(m[1]), dep: m[2] } : null;
    }).filter(Boolean);

    const allDcps = [...new Set(meta.map(m => m.dcp))].sort((a, b) => a - b);
    const allDeps = [...new Set(meta.map(m => m.dep))].sort();

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
          flex: 1; overflow-y: auto; padding: 16px 20px;
          display: flex; flex-direction: column; gap: 20px;
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
        .stl-empty-state {
          display: flex; align-items: center; justify-content: center;
          height: 200px; color: #94a3b8; font-size: 13px;
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
      `;
      document.head.appendChild(css);
    }

    // ─── Build DOM ───────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'stl-modal-overlay';
    overlay.innerHTML = `
      <div class="stl-modal">
        <div class="stl-modal__header">
          <h3 class="stl-modal__title">Seasonality YoY Analysis Viewer</h3>
          <button class="stl-modal__close" title="Close">×</button>
        </div>
        <div class="stl-modal__tabs">
          <button class="stl-tab active" data-tab="time-series">Time Series & Seasonality</button>
          <button class="stl-tab" data-tab="diagnostics">Diagnostics</button>
        </div>
        <div class="stl-modal__controls">
          ${hasBothTypes ? `
          <div class="stl-control">
            <label>Analysis Type</label>
            <select id="stl-select-type">
              <option value="lambda" selected>Lambda</option>
              <option value="alpha">Alpha</option>
            </select>
          </div>
          ` : ''}
          <div class="stl-control">
            <label>DCP</label>
            <select id="stl-select-dcp">${allDcps.map(d => `<option value="${d}">DCP ${d}</option>`).join('')}</select>
          </div>
          <div class="stl-control">
            <label>Departure Time</label>
            <select id="stl-select-dep">${allDeps.map(d => `<option value="${d}">${d}</option>`).join('')}</select>
          </div>
          <div class="stl-control" style="margin-left:auto;">
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
              <div class="stl-chart-wrap"><canvas id="stl-chart-ts"></canvas></div>
            </div>
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">Weekly Seasonality <span id="seas-subtitle"></span></div>
              <div class="stl-chart-wrap"><canvas id="stl-chart-seas"></canvas></div>
            </div>
          </div>
          <!-- TAB 3: Diagnostics -->
          <div class="stl-tab-panel" data-panel="diagnostics">
            <div class="stl-chart-box">
              <div class="stl-chart-box__title">DCP Convergence Heatmap <span id="heat-subtitle"></span></div>
              <div class="stl-chart-wrap" id="heatmap-wrap" style="height: auto; min-height: 400px; overflow: auto;"></div>
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
    overlay.querySelector('.stl-modal__close').onclick = () => overlay.remove();

    // ── Tab switching ──────────────────────────────────────────────────────────
    const tabs = overlay.querySelectorAll('.stl-tab');
    const panels = overlay.querySelectorAll('.stl-tab-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        overlay.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
        if (tab.dataset.tab === 'diagnostics') {
          renderHeatmap();
          renderQuadrant();
        }
      });
    });

    let chartTs = null;
    let chartSeas = null;
    let scaleMode = 'absolute';
    let analysisType = 'lambda';

    const elDcp = overlay.querySelector('#stl-select-dcp');
    const elDep = overlay.querySelector('#stl-select-dep');
    const elType = hasBothTypes ? overlay.querySelector('#stl-select-type') : null;
    const elToggle = overlay.querySelector('#stl-scale-toggle');

    function getKey() {
      return `dcp${elDcp.value}_${elDep.value}`;
    }

    function getData() {
      const store = (hasBothTypes && analysisType === 'alpha') ? byDcpAlpha : byDcpLambda;
      return store[getKey()] || null;
    }

    function getStore() {
      return (hasBothTypes && analysisType === 'alpha') ? byDcpAlpha : byDcpLambda;
    }

    // ─── Time-Series Chart ───────────────────────────────────────────────────
    function renderTs() {
      const d = getData();
      const canvas = overlay.querySelector('#stl-chart-ts');
      const wrap = canvas.parentElement;
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      overlay.querySelector('#ts-subtitle').textContent = d ? `— ${typeLabel}DCP ${elDcp.value} · ${elDep.value}` : '';

      if (chartTs) { chartTs.destroy(); chartTs = null; }
      if (!d || d.error) {
        wrap.innerHTML = `<div class="stl-empty-state">${d?.error || 'No data available'}</div>`;
        return;
      }

      const histDates = d.historical?.dates?.map(s => new Date(s).getTime()) || [];
      const histActual = d.historical?.actual || [];
      const histTrend = d.historical?.trend || [];
      const fcDates = d.trend_forecast?.dates?.map(s => new Date(s).getTime()) || [];
      const fcValues = d.trend_forecast?.values || [];
      const sysFcDates = d.system_forecast?.dates?.map(s => new Date(s).getTime()) || [];
      const sysFcValues = d.system_forecast?.values || [];
      const infFcDates = d.influenced_forecast?.dates?.map(s => new Date(s).getTime()) || [];
      const infFcValues = d.influenced_forecast?.values || [];

      const histMap = new Map(histDates.map((t, i) => [t, i]));
      const fcMap = new Map(fcDates.map((t, i) => [t, i]));
      const sysFcMap = new Map(sysFcDates.map((t, i) => [t, i]));
      const infFcMap = new Map(infFcDates.map((t, i) => [t, i]));

      const allDates = [...new Set([...histDates, ...fcDates, ...sysFcDates, ...infFcDates])].sort((a, b) => a - b);

      const dsActual = allDates.map(t => {
        const idx = histMap.get(t);
        return { x: t, y: idx !== undefined ? histActual[idx] : null };
      });
      const dsTrend = allDates.map(t => {
        const idx = histMap.get(t);
        return { x: t, y: idx !== undefined ? histTrend[idx] : null };
      });
      const dsForecast = allDates.map(t => {
        const idx = fcMap.get(t);
        return { x: t, y: idx !== undefined ? fcValues[idx] : null };
      });
      const dsSysForecast = allDates.map(t => {
        const idx = sysFcMap.get(t);
        return { x: t, y: idx !== undefined ? sysFcValues[idx] : null };
      });
      const dsInfForecast = allDates.map(t => {
        const idx = infFcMap.get(t);
        return { x: t, y: idx !== undefined ? infFcValues[idx] : null };
      });

      // ── EMA of Actual + System Forecast ──
      const combinedRaw = allDates.map(t => {
        const actualIdx = histDates.indexOf(t);
        const sysFcIdx  = sysFcDates.indexOf(t);
        if (actualIdx >= 0) return histActual[actualIdx];
        if (sysFcIdx  >= 0) return sysFcValues[sysFcIdx];
        return null;
      });
      const emaAlpha = 0.10;
      const combinedSmooth = ema(combinedRaw, emaAlpha);
      const dsCombinedSmooth = allDates.map((t, i) => ({ x: t, y: combinedSmooth[i] }));

       // ── EMA of Actual + Influenced Forecast ──
      const combinedInfRaw = allDates.map(t => {
        const actualIdx = histDates.indexOf(t);
        const infFcIdx  = infFcDates.indexOf(t);
        if (actualIdx >= 0) return histActual[actualIdx];
        if (infFcIdx  >= 0) return infFcValues[infFcIdx];
        return null;
      });
      const combinedInfSmooth = ema(combinedInfRaw, emaAlpha);
      const dsCombinedInfSmooth = allDates.map((t, i) => ({ x: t, y: combinedInfSmooth[i] }));

      chartTs = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Actual',
              data: dsActual,
              borderColor: 'rgb(173, 216, 230)',
              backgroundColor: 'rgba(173, 216, 230, 0.2)',
              borderWidth: 2, pointRadius: 0, spanGaps: false, order: 5
            },
            {
              label: 'System Forecast',
              data: dsSysForecast,
              borderColor: 'rgb(234, 67, 53, 0.3)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 0, spanGaps: false, order: 4
            },
            {
              label: 'Influenced Forecast',
              data: dsInfForecast,
              borderColor: 'rgb(137, 80, 196, 0.3)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 0, spanGaps: false, order: 3
            },
            {
              label: 'Actual + System Forecast (EMA)',
              data: dsCombinedSmooth,
              borderColor: 'rgb(3, 3, 3, 0.55)',
              backgroundColor: 'transparent',
              borderWidth: 3, pointRadius: 0, spanGaps: false, order: 1
            },
            {
              label: 'Actual + Influenced Forecast (EMA)',
              data: dsCombinedInfSmooth,
              borderColor: 'rgba(90, 40, 140, 0.85)',
              backgroundColor: 'transparent',
              borderWidth: 3, pointRadius: 0, spanGaps: false, order: 0
            },
            {
              label: 'Historical Trend',
              data: dsTrend,
              borderColor: 'rgb(0, 128, 0)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 0, spanGaps: false, order: 2
            },
            {
              label: 'Trend Forecast',
              data: dsForecast,
              borderColor: 'rgb(0, 0, 0)',
              backgroundColor: 'transparent',
              borderWidth: 2, borderDash: [6, 4],
              pointRadius: 0, spanGaps: false, order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
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
              time: {
                unit: 'month',
                stepSize: 2,
                displayFormats: { month: 'MMM yy' },
                tooltipFormat: 'dd MMM yyyy'
              },
              ticks: {
                maxRotation: 90,
                minRotation: 90,
                autoSkip: false
              },
              grid: { display: false }
            },
            y: {
              title: { display: true, text: 'Value' },
              grid: { color: '#f1f5f9' }
            }
          }
        }
      });
    }

    // ─── Weekly Seasonality Chart ────────────────────────────────────────────
    function renderSeas() {
      const d = getData();
      const canvas = overlay.querySelector('#stl-chart-seas');
      const wrap = canvas.parentElement;
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      overlay.querySelector('#seas-subtitle').textContent = d
        ? `— ${typeLabel}DCP ${elDcp.value} · ${elDep.value} · ${scaleMode}`
        : '';

      if (chartSeas) { chartSeas.destroy(); chartSeas = null; }
      if (!d || d.error) {
        wrap.innerHTML = `<div class="stl-empty-state">${d?.error || 'No data available'}</div>`;
        return;
      }

      const root = scaleMode === 'relative' ? d.relative_weekly_seasonality : d.weekly_seasonality;
      if (!root) {
        wrap.innerHTML = `<div class="stl-empty-state">No ${scaleMode} seasonality data</div>`;
        return;
      }

      const weeks = Array.from({length: 53}, (_, i) => i + 1);
      const toMap = (obj) => {
        const m = {};
        if (obj?.weeks) obj.weeks.forEach((w, i) => { m[w] = obj.mean[i]; });
        return m;
      };
      const toMapStd = (obj) => {
        const m = {};
        if (obj?.weeks) obj.weeks.forEach((w, i) => { m[w] = obj.std[i]; });
        return m;
      };

      const hist = root.historical || {};
      const fc = root.forecast_derived || {};
      const inf = root.influenced_derived || {};

      const histMean = toMap(hist);
      const histStd = toMapStd(hist);
      const fcMean = toMap(fc);
      const infMean = toMap(inf);

      const histMeanArr = weeks.map(w => histMean[w] ?? null);
      const histUpperArr = weeks.map(w => {
        const m = histMean[w];
        const s = histStd[w];
        return (m != null && s != null) ? m + s : null;
      });
      const histLowerArr = weeks.map(w => {
        const m = histMean[w];
        const s = histStd[w];
        return (m != null && s != null) ? m - s : null;
      });
      const fcMeanArr = weeks.map(w => fcMean[w] ?? null);
      const infMeanArr = weeks.map(w => infMean[w] ?? null);

      chartSeas = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: weeks,
          datasets: [
            {
              label: 'Hist lower',
              data: histLowerArr,
              borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false
            },
            {
              label: 'Hist upper',
              data: histUpperArr,
              borderWidth: 0, pointRadius: 0, fill: '-1',
              backgroundColor: 'rgba(26, 115, 232, 0.20)',
              spanGaps: false
            },
            {
              label: 'Historical Mean',
              data: histMeanArr,
              borderColor: 'rgb(26, 115, 232)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 2, spanGaps: false, order: 3
            },
            {
              label: 'Forecast Derived',
              data: fcMeanArr,
              borderColor: 'rgb(234, 67, 53)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 2, spanGaps: false, order: 2
            },
            {
              label: 'Influenced Derived',
              data: infMeanArr,
              borderColor: 'rgb(137, 80, 196)',
              backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 2, spanGaps: false, order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
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
              ticks: {
                callback: function(value, index) {
                  return WEEK_TO_MONTH[index] || '';
                },
                autoSkip: false, maxRotation: 0
              },
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
    // TAB 3: DIAGNOSTICS — Heatmap + Quadrant
    // ═══════════════════════════════════════════════════════════════════════

    // ─── Heatmap: System Forecast % Error vs Trend Forecast ──────────────────
    function renderHeatmap() {
      const wrap = overlay.querySelector('#heatmap-wrap');
      const dep = elDep.value;
      const typeLabel = hasBothTypes ? `${analysisType.toUpperCase()} · ` : '';
      overlay.querySelector('#heat-subtitle').textContent = `— ${typeLabel}${dep}`;

      // Collect all unique departure dates across all DCPs
      const allDates = new Set();
      const store = getStore();

      for (let dcp = 1; dcp <= 16; dcp++) {
        const key = `dcp${dcp}_${dep}`;
        const d = store[key];
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

      // Build matrix: rows = DCPs (1→16), cols = dates
      const matrix = [];
      const rowLabels = [];

      for (let dcp = 1; dcp <= 16; dcp++) {
        const key = `dcp${dcp}_${dep}`;
        const d = store[key];
        const dcpInfo = DCP_DATA.find(x => x.DCP === dcp);
        const label = dcpInfo ? `DCP ${dcp} (${dcpInfo['DyPr Start']}-${dcpInfo['DyPr End']}d)` : `DCP ${dcp}`;
        rowLabels.push(label);

        if (!d || d.error) {
          matrix.push(sortedDates.map(() => null));
          continue;
        }

        const row = sortedDates.map(date => {
          const sysIdx = d.system_forecast?.dates?.indexOf(date) ?? -1;
          const trendIdx = d.trend_forecast?.dates?.indexOf(date) ?? -1;
          const histIdx = d.historical?.dates?.indexOf(date) ?? -1;

          let sysVal = sysIdx >= 0 ? d.system_forecast.values[sysIdx] : null;
          let trendVal = trendIdx >= 0 ? d.trend_forecast.values[trendIdx] : null;

          if (trendVal === null && histIdx >= 0) {
            trendVal = d.historical.trend[histIdx];
          }

          if (sysVal === null || trendVal === null || trendVal === 0) return null;

          const pct = ((sysVal - trendVal) / Math.abs(trendVal)) * 100;
          return pct;
        });

        matrix.push(row);
      }

      const allValues = matrix.flat().filter(v => v !== null);
      const maxAbs = allValues.length ? Math.max(...allValues.map(Math.abs)) : 0;
      const clampMax = Math.max(maxAbs, 1);

      function heatColor(pct) {
        if (pct === null) return '#f1f5f9';
        const t = Math.max(-1, Math.min(1, pct / clampMax));
        if (t < 0) {
          const intensity = Math.abs(t);
          const r = Math.round(255 - (255 - 26) * intensity);
          const g = Math.round(255 - (255 - 115) * intensity);
          const b = Math.round(255 - (255 - 232) * intensity);
          return `rgb(${r},${g},${b})`;
        } else {
          const r = Math.round(255 - (255 - 234) * t);
          const g = Math.round(255 - (255 - 67) * t);
          const b = Math.round(255 - (255 - 53) * t);
          return `rgb(${r},${g},${b})`;
        }
      }

      function textColor(pct) {
        if (pct === null) return '#94a3b8';
        const t = Math.abs(pct / clampMax);
        return t > 0.5 ? '#fff' : '#334155';
      }

      const colCount = sortedDates.length;
      const grid = document.createElement('div');
      grid.className = 'heatmap-grid';
      grid.style.gridTemplateColumns = `120px repeat(${colCount}, minmax(50px, 1fr))`;

      const corner = document.createElement('div');
      corner.style.cssText = 'padding: 4px;';
      grid.appendChild(corner);

      sortedDates.forEach(date => {
        const col = document.createElement('div');
        col.className = 'heatmap-col-label';
        col.textContent = date.slice(5);
        col.title = date;
        grid.appendChild(col);
      });

      matrix.forEach((row, rIdx) => {
        const rowLabel = document.createElement('div');
        rowLabel.className = 'heatmap-row-label';
        rowLabel.textContent = rowLabels[rIdx];
        grid.appendChild(rowLabel);

        row.forEach((val, cIdx) => {
          const cell = document.createElement('div');
          cell.className = 'heatmap-cell';
          cell.style.backgroundColor = heatColor(val);
          cell.style.color = textColor(val);
          cell.textContent = val !== null ? `${val.toFixed(1)}%` : '—';
          cell.title = `${rowLabels[rIdx]}\n${sortedDates[cIdx]}\nSystem vs Trend: ${val !== null ? val.toFixed(2) + '%' : 'N/A'}`;
          grid.appendChild(cell);
        });
      });

      wrap.innerHTML = '';
      wrap.appendChild(grid);

      const legend = document.createElement('div');
      legend.className = 'heatmap-legend';
      legend.innerHTML = `
        <span>System < Trend</span>
        <div class="heatmap-legend-bar"></div>
        <span>System > Trend</span>
        <span style="margin-left: 12px;">Max deviation: ±${clampMax.toFixed(1)}%</span>
      `;
      wrap.appendChild(legend);
    }

    // ─── Quadrant: Alpha vs Lambda scatter by DCP ──────────────────────────
    function renderQuadrant() {
      const wrap = overlay.querySelector('#quadrant-wrap');
      const tooltip = overlay.querySelector('#quad-tooltip');
      const dep = elDep.value;
      overlay.querySelector('#quad-subtitle').textContent = `— ${dep}`;

      if (!hasBothTypes) {
        wrap.innerHTML = `<div class="stl-empty-state">Quadrant view requires both Alpha and Lambda analysis. Enable dual-mode in the backend.</div>`;
        return;
      }

      const alphaStore = byDcpAlpha;
      const lambdaStore = byDcpLambda;

      const points = [];
      const dcpColors = [
        '#1a73e8','#1765cc','#1558b0','#34a853','#2d9247','#26803b',
        '#fbbc04','#e6ac04','#d49a03','#ea4335','#d63b2a','#c23320',
        '#9334e6','#7f2bc7','#6b22a8','#571a89'
      ];

      for (let dcp = 1; dcp <= 16; dcp++) {
        const key = `dcp${dcp}_${dep}`;
        const a = alphaStore[key];
        const l = lambdaStore[key];
        if (!a || a.error || !l || l.error) continue;

        const allDates = new Set([
          ...(a.system_forecast?.dates || []),
          ...(a.historical?.dates || []),
          ...(l.system_forecast?.dates || []),
          ...(l.historical?.dates || [])
        ]);

        allDates.forEach(date => {
          const aSysIdx = a.system_forecast?.dates?.indexOf(date) ?? -1;
          const aHistIdx = a.historical?.dates?.indexOf(date) ?? -1;
          const lSysIdx = l.system_forecast?.dates?.indexOf(date) ?? -1;
          const lHistIdx = l.historical?.dates?.indexOf(date) ?? -1;

          let alphaVal = aSysIdx >= 0 ? a.system_forecast.values[aSysIdx] : null;
          if (alphaVal === null && aHistIdx >= 0) alphaVal = a.historical.actual[aHistIdx];

          let lambdaVal = lSysIdx >= 0 ? l.system_forecast.values[lSysIdx] : null;
          if (lambdaVal === null && lHistIdx >= 0) lambdaVal = l.historical.actual[lHistIdx];

          if (alphaVal !== null && lambdaVal !== null && alphaVal > 0) {
            points.push({
              x: alphaVal,
              y: lambdaVal,
              dcp: dcp,
              date: date,
              isHistorical: aHistIdx >= 0 || lHistIdx >= 0,
              alphaSource: aSysIdx >= 0 ? 'system' : 'actual',
              lambdaSource: lSysIdx >= 0 ? 'system' : 'actual'
            });
          }
        });
      }

      if (points.length === 0) {
        wrap.innerHTML = `<div class="stl-empty-state">No paired Alpha-Lambda data available for ${dep}</div>`;
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

      const minAlpha = Math.min(...alphas) * 0.9;
      const maxAlpha = Math.max(...alphas) * 1.1;
      const minLambda = Math.min(...lambdas) * 0.9;
      const maxLambda = Math.max(...lambdas) * 1.1;

      const xScale = (v) => margin.left + ((v - minAlpha) / (maxAlpha - minAlpha)) * innerW;
      const yScale = (v) => margin.top + innerH - ((v - minLambda) / (maxLambda - minLambda)) * innerH;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'quadrant-svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const quadColors = ['rgba(26,115,232,0.06)', 'rgba(52,168,83,0.06)', 'rgba(251,188,4,0.06)', 'rgba(234,67,53,0.06)'];
      const quadLabels = [
        'High λ · Low α\n(Big market, price-insensitive)',
        'High λ · High α\n(Big market, price-sensitive)',
        'Low λ · Low α\n(Small market, price-insensitive)',
        'Low λ · High α\n(Small market, price-sensitive)'
      ];

      // Background quadrants
      svg.innerHTML += `<rect x="${margin.left}" y="${margin.top}" width="${xScale(medianAlpha) - margin.left}" height="${yScale(medianLambda) - margin.top}" fill="${quadColors[0]}"/>`;
      svg.innerHTML += `<rect x="${xScale(medianAlpha)}" y="${margin.top}" width="${margin.left + innerW - xScale(medianAlpha)}" height="${yScale(medianLambda) - margin.top}" fill="${quadColors[1]}"/>`;
      svg.innerHTML += `<rect x="${margin.left}" y="${yScale(medianLambda)}" width="${xScale(medianAlpha) - margin.left}" height="${margin.top + innerH - yScale(medianLambda)}" fill="${quadColors[2]}"/>`;
      svg.innerHTML += `<rect x="${xScale(medianAlpha)}" y="${yScale(medianLambda)}" width="${margin.left + innerW - xScale(medianAlpha)}" height="${margin.top + innerH - yScale(medianLambda)}" fill="${quadColors[3]}"/>`;

      // Quadrant labels
      svg.innerHTML += `<text class="quadrant-quad-label" x="${(margin.left + xScale(medianAlpha)) / 2}" y="${(margin.top + yScale(medianLambda)) / 2}">${quadLabels[0]}</text>`;
      svg.innerHTML += `<text class="quadrant-quad-label" x="${(xScale(medianAlpha) + margin.left + innerW) / 2}" y="${(margin.top + yScale(medianLambda)) / 2}">${quadLabels[1]}</text>`;
      svg.innerHTML += `<text class="quadrant-quad-label" x="${(margin.left + xScale(medianAlpha)) / 2}" y="${(yScale(medianLambda) + margin.top + innerH) / 2}">${quadLabels[2]}</text>`;
      svg.innerHTML += `<text class="quadrant-quad-label" x="${(xScale(medianAlpha) + margin.left + innerW) / 2}" y="${(yScale(medianLambda) + margin.top + innerH) / 2}">${quadLabels[3]}</text>`;

      // Axes
      svg.innerHTML += `<line class="quadrant-axis" x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}"/>`;
      svg.innerHTML += `<line class="quadrant-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}"/>`;

      // Median lines
      svg.innerHTML += `<line class="quadrant-median" x1="${xScale(medianAlpha)}" y1="${margin.top}" x2="${xScale(medianAlpha)}" y2="${margin.top + innerH}"/>`;
      svg.innerHTML += `<line class="quadrant-median" x1="${margin.left}" y1="${yScale(medianLambda)}" x2="${margin.left + innerW}" y2="${yScale(medianLambda)}"/>`;

      // Axis labels
      svg.innerHTML += `<text class="quadrant-label" x="${margin.left + innerW / 2}" y="${height - 10}" text-anchor="middle">Alpha (inverse elasticity) → lower α = less price sensitive</text>`;
      svg.innerHTML += `<text class="quadrant-label" x="15" y="${margin.top + innerH / 2}" text-anchor="middle" transform="rotate(-90, 15, ${margin.top + innerH / 2})">Lambda (unconstrained demand) → higher λ = bigger market</text>`;

      // Median labels
      svg.innerHTML += `<text class="quadrant-label" x="${xScale(medianAlpha)}" y="${margin.top + innerH + 15}" text-anchor="middle" fill="#ea4335" font-weight="600">median α</text>`;
      svg.innerHTML += `<text class="quadrant-label" x="${margin.left - 10}" y="${yScale(medianLambda)}" text-anchor="end" fill="#ea4335" font-weight="600">median λ</text>`;

      // Points
      points.forEach(p => {
        const cx = xScale(p.x);
        const cy = yScale(p.y);
        const r = 3 + (p.dcp / 16) * 5;
        const fill = dcpColors[p.dcp - 1] || '#999';
        const opacity = p.isHistorical ? 0.9 : 0.5;

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', 'quadrant-point');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', r);
        circle.setAttribute('fill', fill);
        circle.setAttribute('fill-opacity', opacity);
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '1');

        circle.addEventListener('mouseenter', (e) => {
          tooltip.style.display = 'block';
          tooltip.style.left = (e.clientX - wrap.getBoundingClientRect().left + 10) + 'px';
          tooltip.style.top = (e.clientY - wrap.getBoundingClientRect().top - 10) + 'px';
          tooltip.textContent = `DCP ${p.dcp} · ${p.date}\nα = ${p.x.toFixed(4)} (${p.alphaSource})\nλ = ${p.y.toFixed(1)} (${p.lambdaSource})\nElasticity = ${(1/p.x).toFixed(2)}`;
        });
        circle.addEventListener('mouseleave', () => {
          tooltip.style.display = 'none';
        });

        svg.appendChild(circle);
      });

      // DCP legend
      const legendY = 10;
      DCP_DATA.forEach((d, i) => {
        const lx = margin.left + (i % 8) * 90;
        const ly = legendY + Math.floor(i / 8) * 18;
        svg.innerHTML += `<rect x="${lx}" y="${ly}" width="10" height="10" fill="${dcpColors[i]}" rx="2"/>`;
        svg.innerHTML += `<text class="quadrant-label" x="${lx + 14}" y="${ly + 9}" fill="#475569">DCP ${d.DCP}</text>`;
      });

      wrap.innerHTML = '';
      wrap.appendChild(svg);
      wrap.appendChild(tooltip);
    }

    // ─── Update all charts ───────────────────────────────────────────────────
    function updateAll() {
      const tsWrap = overlay.querySelector('#stl-chart-ts')?.parentElement;
      const seasWrap = overlay.querySelector('#stl-chart-seas')?.parentElement;
      if (tsWrap && !overlay.querySelector('#stl-chart-ts')) tsWrap.innerHTML = '<canvas id="stl-chart-ts"></canvas>';
      if (seasWrap && !overlay.querySelector('#stl-chart-seas')) seasWrap.innerHTML = '<canvas id="stl-chart-seas"></canvas>';

      renderTs();
      renderSeas();

      const diagPanel = overlay.querySelector('[data-panel="diagnostics"]');
      if (diagPanel.classList.contains('active')) {
        renderHeatmap();
        renderQuadrant();
      }
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
      const wrapSeas = overlay.querySelector('#stl-chart-seas').parentElement;
      wrapSeas.innerHTML = '<canvas id="stl-chart-seas"></canvas>';
      renderSeas();
    });

    updateAll();
  };

  // ─── Styling ────────────────────────────────────────────────────────────────
  const STYLES = `
    .rm-ai-btn-container {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 12px;
      flex-wrap: wrap;
    }

    .rm-ai-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 2px;
      font-size: 13px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
      border: 1px solid transparent;
      white-space: nowrap;
      width: 100%;
    }

    .rm-ai-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
    }

    .rm-ai-btn:active {
      transform: translateY(0);
      box-shadow: none;
    }

    /* Button 1 — Seasonality */
    .rm-ai-btn--seasonality {
      background: #1a73e8;
      color: #fff;
      border-color: #1558b0;
    }
    .rm-ai-btn--seasonality:hover {
      background: #1765cc;
    }
    .rm-ai-btn--seasonality.rm-ai-btn--loading {
      background: #5a9cf5;
      cursor: wait;
      pointer-events: none;
    }

    /* Button 2 — Counter Forecasts */
    .rm-ai-btn--counter {
      background: #fff;
      color: #1a73e8;
      border-color: #1a73e8;
    }
    .rm-ai-btn--counter:hover {
      background: #e8f0fe;
    }
    .rm-ai-btn--counter.rm-ai-btn--loading {
      background: #f0f4ff;
      cursor: wait;
      pointer-events: none;
    }

    .rm-ai-btn__icon {
      font-size: 14px;
      line-height: 1;
    }

    .rm-ai-btn__spinner {
      display: none;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: rm-spin 0.6s linear infinite;
    }
    .rm-ai-btn--counter .rm-ai-btn__spinner {
      border-color: rgba(26,115,232,0.25);
      border-top-color: #1a73e8;
    }
    .rm-ai-btn--loading .rm-ai-btn__spinner {
      display: block;
    }
    .rm-ai-btn--loading .rm-ai-btn__icon {
      display: none;
    }

    @keyframes rm-spin {
      to { transform: rotate(360deg); }
    }
  `;

  // ─── Inject styles once ──────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('rm-ai-btn-styles')) return;
    const style = document.createElement('style');
    style.id = 'rm-ai-btn-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // ─── Button logic ────────────────────────────────────────────────────────────

  async function onSeasonalityClick(btn, target) {
    setLoading(btn, true);

    try {
      let activeOD = unsafeWindow.proshack.getActiveTabOD();
      const [origin, destination] = (activeOD || '-').split('-');

      // ── CACHE with TTL ─────────────────────────────────────────────
      const filters = unsafeWindow.proshack.read_menu_filters();
      const cacheKey = `${activeOD}_${JSON.stringify(filters)}`;
      const cached = getCached(cacheKey);
      if (cached) {
        console.log('[RM AI] Serving from cache:', cacheKey);
        showStlModal(cached);
        setLoading(btn, false);
        return;
      }
      // ── END CACHE

      console.log("----- Active OD -----");
      console.log(activeOD);

      const csvString = await unsafeWindow.proshack.historical_downloadAllCSVs(
        origin,
        destination,
        { skipDownload: true }
      );

      const DCP_DATA_SQL = [
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

      let sql = `
        SELECT  a.[Departure Date],
                a.[Final Alpha Influenced],
                a.[Final Lambda Influenced],
                a.[Final Alpha Seasonal],
                a.[Final Lambda Seasonal],
                a.[Departure Time],
                a.dcp as DCP,
                b.[DyPr Start],
                b.[DyPr End],
                b.[Length (days)]
        FROM CSV(?, {headers:true}) AS a
        JOIN ? AS b ON a.dcp = b.DCP
        WHERE [Passenger Type] = 'I' AND [Compartment] = 'Y'
      `;

      if ("POS" in filters) {
        const markets = filters["POS"].split(",").map(s => s.trim()).filter(Boolean);
        if (markets.length > 0) {
          const posClause = markets.map(m => `a.POS = '${m.replace(/'/g, "''")}'`).join(" OR ");
          sql += ` AND ( ${posClause} )`;
        }
      }else{  
        alert("No POS selected...")
        return
      }

      if ("PATH" in filters) {
        const markets = filters["PATH"].split(",").map(s => s.trim()).filter(Boolean);
        if (markets.length > 0) {
          const pathClause = markets.map(m => `[Path] = '${m.replace(/'/g, "''")}'`).join(" OR ");
          sql += ` AND ( ${pathClause} )`;
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
          const dowClause = days.map(d => `[Day of Week] = ${d}`).join(" OR ");
          sql += ` AND ( ${dowClause} )`;
        }
      }

      if ("DEPARTURE_TIME" in filters) {
        const markets = filters["DEPARTURE_TIME"].split(",").map(s => s.trim()).filter(Boolean);
        if (markets.length > 0) {
          const pathClause = markets.map(m => `[Departure Time] = '${m.replace(/'/g, "''")}'`).join(" OR ");
          sql += ` AND ( ${pathClause} )`;
        }
      }

      console.log(csvString);

      const rawRows = await alasql.promise(sql, [csvString, DCP_DATA_SQL]);
      console.log(rawRows);

      console.log(`[RM AI] ${rawRows.length} rows loaded into alasql table`);

      const stlClient = new unsafeWindow.HFGradioAPI(
        "https://mithus-stl.hf.space/gradio_api/call"
      );

      const updateBtnStatus = (status) => {
        const labelSpan = btn.querySelector('span:last-child');
        if (labelSpan) labelSpan.textContent = `Processing… (${status})`;
      };

      const commonPayload = {
        rows: rawRows,
        date_col: "Departure Date",
        dcp_col: "DCP",
        forecast_flag_col: "is_forecast",
        max_dcp: 13,
        damp_factor: "auto",
        bypass_dampener: false
      };

      const alphaJob = stlClient.pollJob(
        "submit_stl_yoy",
        "check_stl_yoy",
        { ...commonPayload, value_col: "Final Alpha Seasonal", influenced_col: "Final Alpha Influenced" },
        {
          maxWaitMs: 320000,
          pollInterval: 5000,
          onStatus: (s) => {
            console.log("[STL/YoY Alpha] poll:", s.status);
            updateBtnStatus(`Alpha: ${s.status}`);
          }
        }
      );

      const lambdaJob = stlClient.pollJob(
        "submit_stl_yoy",
        "check_stl_yoy",
        { ...commonPayload, value_col: "Final Lambda Seasonal", influenced_col: "Final Lambda Influenced" },
        {
          maxWaitMs: 320000,
          pollInterval: 5000,
          onStatus: (s) => {
            console.log("[STL/YoY Lambda] poll:", s.status);
            updateBtnStatus(`Lambda: ${s.status}`);
          }
        }
      );

      const [alphaAnalysis, lambdaAnalysis] = await Promise.all([alphaJob, lambdaJob]);
      const analysis = { alpha: alphaAnalysis, lambda: lambdaAnalysis };

      console.log("[RM AI] STL/YoY result:", analysis);
      unsafeWindow.proshack.lastStlYoy = analysis;

      showStlModal(analysis);

      setCached(cacheKey, analysis);

    } catch (err) {
      console.error('[RM AI] Seasonality Validation failed', err);
    } finally {
      setLoading(btn, false);
    }
  }

  // ── Cache helper with TTL ───────────────────────────────────────────────────
  function getEndOfDay() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  // Replace the constant with a function call
  const CACHE_TTL_MS = getEndOfDay() - Date.now();

  function getCached(key) {
    const entry = window._stlCache?.[key];
    if (!entry) return null;
    if (Date.now() - entry._cachedAt > CACHE_TTL_MS) {
      delete window._stlCache[key];
      return null;
    }
    return entry.data;
  }

  function setCached(key, data) {
    if (!window._stlCache) window._stlCache = {};
    window._stlCache[key] = { data, _cachedAt: Date.now() };
  }

  function onCounterForecastsClick(btn, target) {
    console.log('[RM AI] Counter Forecasts clicked', target);
    setLoading(btn, true);
    setTimeout(() => {
      setLoading(btn, false);
      console.log('[RM AI] Counter Forecasts complete');
    }, 2000);
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
    text.textContent = label;

    div.appendChild(spinner);
    div.appendChild(iconEl);
    div.appendChild(text);

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

  function injectButtons(target) {
    if (target.hasAttribute(INJECTED_ATTR)) return;
    target.setAttribute(INJECTED_ATTR, 'true');

    const container = document.createElement('div');
    container.className = 'rm-ai-btn-container';

    container.appendChild(makeBtn({
      label: 'AI Seasonality Validation',
      icon: '📈',
      modifierClass: 'rm-ai-btn--seasonality',
      onClick: onSeasonalityClick,
      target,
    }));

    /*container.appendChild(makeBtn({
      label: 'AI Counter Forecasts',
      icon: '🔄',
      modifierClass: 'rm-ai-btn--counter',
      onClick: onCounterForecastsClick,
      target,
    }));*/

    target.parentNode.insertBefore(container, target.nextSibling);
  }

  // ─── MutationObserver ────────────────────────────────────────────────────────

  function init() {
    injectStyles();
    document.querySelectorAll('.rm-container-historical-forecast-body .rm-measure-view-component').forEach(injectButtons);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('.rm-container-historical-forecast-body .rm-measure-view-component')) {
            injectButtons(node);
          }
          node.querySelectorAll('.rm-measure-view-component').forEach(injectButtons);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
