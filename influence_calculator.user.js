// ==UserScript==
// @name         Influence Calculator
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  For lazy people - Calculates the influence needed between two points!
// @author       Gil Martins
// @run-at       document-start
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*
// @grant        unsafeWindow
// @downloadURL  https://github.com/gmartins-tp/scripts/raw/refs/heads/main/influence_calculator.user.js
// @updateURL    https://github.com/gmartins-tp/scripts/raw/refs/heads/main/influence_calculator.user.js
// ==/UserScript==

(function() {
  'use strict';

  var LOCK_DRAW = true;
  let lastUrl = null;
  // Check URL changes
  setInterval(() => {

    if (location.href !== lastUrl) {
        lastUrl = location.href;

        if (location.href.includes("/historical-forecast")) {
            LOCK_DRAW = false
        } else {
            LOCK_DRAW = true
        }
    }

  }, 500);

  let CLICK_LIST = [];
  var is_k = false;

  // A helper to find the chart container div from an SVG node
  function findChartContainer(svgNode) {
    let el = svgNode;
    while (el) {
      // Highcharts usually wraps chart in a div containing "highcharts-container"
      if (el.tagName === 'DIV' && el.classList.contains('highcharts-container')) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Keep track of observed chart areas to avoid duplicating listeners
  const observed = new WeakSet();

  // Observe additions to DOM to catch when Highcharts renders SVG
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof SVGElement) {
          // Check a few heuristics to see if it's part of highcharts
          if (node.classList.contains('highcharts-series') ||
              node.classList.contains('highcharts-axis')) {
            const container = findChartContainer(node);
            if (container && !observed.has(container)) {
              observed.add(container);
              attachClickHandler(container);
            }
          }
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Also check existing SVGs on load
  document.querySelectorAll('svg.highcharts-root').forEach(svg => {
    const container = findChartContainer(svg);
    if (container && !observed.has(container)) {
      observed.add(container);
      attachClickHandler(container);
    }
  });

  function convert_to_scale(val, vls){
    let min = Math.min(...vls);
    let max = Math.max(...vls);
    const value = min + (1-val) * (max - min);
    return value;
  }

  // Attach a click handler to a chart container <div>
  function attachClickHandler(container) {

    //if page isnt historical forecast doesnt do this!
    if (LOCK_DRAW) return;

    container.style.cursor = 'pointer';  // hint for user
    container.addEventListener('click', function(e) {

      if (unsafeWindow.block_other_scripts_because_of_line_plot == true){
        return;
      }

      // Compute click relative to container top
      const rect = container.getBoundingClientRect();
      const relY = e.clientY - rect.top;

      // Compute chart plot area height: find the SVG inside container
      const svg = container.querySelector('svg');
      if (!svg) return;

      // The plot area (where the data is)
      const plotArea = svg.querySelector('rect.highcharts-plot-background'); //, g.highcharts-series-group
      let plotTop = 0, plotHeight = svg.clientHeight;

      if (plotArea) {
        // Get its bounding box
        const box = plotArea.getBoundingClientRect();
        plotTop = box.top - rect.top;
        plotHeight = box.height;
      }

      // Compute fraction down the plot area
      const frac = (relY - plotTop) / plotHeight;
      const clamped = Math.min(Math.max(frac, 0), 1);

      // Now *without a real chart object*, we estimate the value based on the SVG axis scale:
      // We'll try to read min/max from the axis labels in DOM.

      // Try Y-axis labels: usually <text> elements inside a <g class="highcharts-yaxis">
      const yAxisGroup = svg.querySelector('g.highcharts-yaxis');
      if (!yAxisGroup) {
        console.log('[Tamper] Clicked Y (approx): fraction =', clamped);
        return;
      }

      //highcharts-axis-labels highcharts-yaxis-labels
      const ticks = Array.from(svg.querySelectorAll('.highcharts-yaxis-labels text'));

      var vls = []
      var is_k_counter = 0
      for (var t=0; t< ticks.length;t++){

        if (ticks[t].innerHTML.indexOf("k")>0){
          is_k_counter += 1
        }

        vls.push(parseInt(ticks[t].innerHTML))
      }

      is_k = false;
      if (is_k_counter > 0){
        is_k = true
      }

      console.log(vls)

      const values = ticks.map(t => parseFloat(t.textContent)).filter(n => !isNaN(n));
      if (values.length > 2) {
        console.log('[Tamper] Clicked Y (approx): fraction =', clamped);

        CLICK_LIST.push(clamped)

        console.log("............")
        console.log(CLICK_LIST)

        showMarker(container, e.clientX - rect.left, relY, convert_to_scale(clamped, vls));

        if (CLICK_LIST.length < 2){
          return;
        }
        else{

            // Find the target element
            const target = document.querySelector('.rm-measure-view-component');
            if (target) {

              const EXISTING_ID = 'influence-injected-div';

              // Try to find if the div already exists
              let myDiv = document.getElementById(EXISTING_ID);

              if (!myDiv) {
                // If not, create it
                myDiv = document.createElement('div');
                myDiv.id = EXISTING_ID;
                myDiv.style.background = '#fff';
                myDiv.style.marginTop = '10px';
                myDiv.style.textAlign = 'center'; 
                myDiv.style.padding = '10px';
                myDiv.style.lineHeight = '20px';
                myDiv.style.border = '1px solid #ccc'
                target.after(myDiv);
              }

              var val0 = convert_to_scale(CLICK_LIST[0], vls).toFixed(2)
              var val1 = convert_to_scale(CLICK_LIST[1], vls).toFixed(2)
              
              var estimatedY2 = val1/val0
              var estimatedY3 = Math.round(val1 - val0)

              if (is_k){
                estimatedY3 = Math.round(estimatedY3*1000);
                val0 = val0+'k' 
                val1 = val1+'k'
              }

              var ss = "<b>Calculated Multiplicative Influence</b><br>"+val0+" -> "+val1+":  "+estimatedY2.toFixed(2)
              //ss += "<br>-------<br><b>Calculated Additive Influence</b><br>"+val0+" -> "+val1+":  "+estimatedY3

              myDiv.innerHTML = ss

            }

            CLICK_LIST = [];
        }

        return;
      }

    });

    console.log('[Tamper] Attached click to Highcharts container:', container);
  }

  let clickCOUNTER = 0;
  let colorIndex = 0;  
  const colors = [ 'red', 'blue', 'lime', 'teal', 'purple' ];  

  function showMarker(container, x, y, value) {

    clickCOUNTER += 1;

    // Every 2 clicks, advance the color index (wrap around with modulo)
    if (clickCOUNTER > 2) {
      clickCOUNTER = 1;  // reset to 1
      colorIndex = (colorIndex + 1) % colors.length;  // cycle through colors
    }

    const currentColor = colors[colorIndex];

    // Create a small dot / label
    const dot = document.createElement('div');
    dot.style.position = 'absolute';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.background = currentColor;
    dot.style.borderRadius = '50%';
    dot.style.pointerEvents = 'none';
    container.appendChild(dot);

    const label = document.createElement('div');
    label.style.position = 'absolute';
    label.style.left = (x + 10) + 'px';
    label.style.top = (y - 10) + 'px';
    label.style.color = 'white';
    label.style.background = 'rgba(0,0,0,0.7)';
    label.style.padding = '2px 4px';
    label.style.fontSize = '12px';
    label.style.borderRadius = '3px';
    label.style.pointerEvents = 'none';
    label.textContent = value.toFixed(2);
    container.appendChild(label);

    setTimeout(() => {
      dot.remove();
      label.remove();
    }, 7000);
  }

})();

