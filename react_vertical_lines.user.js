// ==UserScript==
// @name         React Highcharts Vertical Tick Lines
// @namespace    http://tampermonkey.net/
// @version      1.1
// @author       Gil Martins
// @description  Draw vertical lines at x-axis ticks for Highcharts inside React apps, shade years, and plot lines width increase
// @match       https://prod-rm.tp.proscloud.com/market/forecast/*
// @grant        none
// @downloadURL  https://github.com/gmartins-tp/scripts/raw/refs/heads/main/react_vertical_lines.user.js
// @updateURL    https://github.com/gmartins-tp/scripts/raw/refs/heads/main/react_vertical_lines.user.js
// ==/UserScript==


(function() {
    'use strict';

    function drawLines() {
        // Find all Highcharts containers
        const charts = document.querySelectorAll('.highcharts-container');
        charts.forEach(container => {
            // Avoid drawing twice
            if (container.dataset.vlinesDrawn) return;

            const svg = container.querySelector('svg');
            const plot = container.querySelector('.highcharts-plot-background');

            if (!svg || !plot) return;

            // Get x-axis tick labels
            const ticks = container.querySelectorAll('.highcharts-axis-labels text');

            // Get bounding box of the real chart area
            const plotBox = plot.getBBox();
            const plotStartX = plotBox.x;
            const plotEndX   = plotBox.x + plotBox.width;

            ticks.forEach(tick => {
                const x = tick.getBBox().x + tick.getBBox().width / 2;
                const ymin = tick.getBBox().y;

                if (x < plotStartX || x > plotEndX) return;

                // Create a vertical line
                const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                line.setAttribute('x1', x);
                line.setAttribute('y1', 0);
                line.setAttribute('x2', x);
                line.setAttribute('y2', ymin);
                line.setAttribute('stroke', 'lightgrey');
                line.setAttribute('stroke-width', '1');
                line.setAttribute('stroke-dasharray', '4,2');

                svg.appendChild(line);
            });

            container.dataset.vlinesDrawn = 'true';
        });
    }

    // Run once on load
    setTimeout(drawLines, 1000);

    // Observe for dynamically added charts
    const observer = new MutationObserver(() => drawLines());
    observer.observe(document.body, { childList: true, subtree: true });

    

        function shadeYears() {
            const svg = document.querySelector('svg.highcharts-root');
            if (!svg) {
            // no chart yet
            return;
            }

            // Attempt to find the Highcharts chart instance
            let chart = null;
            if (window.Highcharts && Highcharts.charts) {
                chart = Highcharts.charts.find(c => {
                    if (!c) return false;
                    // try to match by container
                    return c.renderTo === svg.parentNode;
                });
            }

            const plotLeft = chart ? chart.plotLeft : 0;

            // e.g. by class name
            const old = svg.querySelectorAll('.tm-year-band');
            old.forEach(n => n.remove());

            // Compute years to shade
            let bands = [];

            const labels = Array.from(svg.querySelectorAll('g.highcharts-axis-labels.highcharts-xaxis-labels text'));
            console.log(labels)
            labels.forEach((txt, i) => {
                const yearMatch = parseInt(txt.innerHTML.match(/(\d+)$/)[0])
                if (yearMatch) {
                    const yr = +yearMatch;
                    const x = +txt.getAttribute('x');
                    bands.push({ x1: x, yr });
                }
            });            

            //console.log(bands)
            var agg_ranges = []
            var new_range = []
            var year_start = null
            var band_aux;
            bands.forEach(band => {
                if (band.yr != year_start){

                    if (year_start != null && year_start!=band.yr){
                       new_range.push(band.x1) 
                       agg_ranges.push(new_range)
                       new_range = []
                    }

                    year_start = band.yr
                    new_range.push(band.x1)                    
                }

                band_aux = band

            });

            new_range.push(band_aux.x1)
            agg_ranges.push(new_range)

            var i = 0;
            agg_ranges.forEach(rang =>{

                i += 1

                if (i%2==0) return;

                var start = rang[0]
                var end = rang[1]

                const width = end - start;
                if (width <= 0) return;

                const bg = svg.querySelector('.highcharts-plot-background');

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', start + plotLeft);
                rect.setAttribute('y', bg.getAttribute("y"));
                rect.setAttribute('width', width);
                rect.setAttribute('height', bg.getAttribute("height"));
                rect.setAttribute('fill', 'rgba(200,200,200,0.1)');
                rect.setAttribute('class', 'tm-year-band');
                rect.innerHTML = "2024"
                // Insert before other chart elements
                //svg.insertBefore(rect, svg.firstChild);
                // find the element with class highcharts-plot-background
                

                if (bg && bg.parentNode) {
                const next = bg.nextSibling;
                if (next) {
                    bg.parentNode.insertBefore(rect, next);
                } else {
                    // if plot-background is the last child, just append
                    bg.parentNode.appendChild(rect);
                }
                } else {
                // fallback: if not found, insert at the beginning
                svg.insertBefore(rect, svg.firstChild);
                }                
            });          
        }

        // Run once initially
        //shadeYears();
        // Watch for mutations (chart redraw) to repaint bands
        const svgRoot = document.querySelector('svg.highcharts-root');
        if (svgRoot) {
            const mo = new MutationObserver(shadeYears);
            mo.observe(svgRoot, { childList: true, subtree: true });
        }

        // As fallback, poll periodically
        setInterval(shadeYears, 500);

        // Run once on load
        function bumpStrokeWidth() {
            // Query all path elements under highcharts-series groups
            const paths = document.querySelectorAll('.highcharts-series path');
            paths.forEach(path => {
                // Read current stroke-width
                const sw = path.getAttribute('stroke-width');
                if (sw === '1' || sw === '1px') {
                    // Set to 2
                    path.setAttribute('stroke-width', '2');
                }
            });
        }

        // Re-run on chart redraw / after mutations
        const svg = document.querySelector('svg.highcharts-root');
        if (svg) {
            const mo = new MutationObserver(bumpStrokeWidth);
            mo.observe(svg, { childList: true, subtree: true });
        }

        // As fallback / periodic
        setInterval(bumpStrokeWidth, 250);

})();
