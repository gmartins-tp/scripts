// ==UserScript==
// @name         React Highcharts Vertical Tick Lines
// @namespace    http://tampermonkey.net/
// @version      1.0
// @author       Gil Martins
// @description  Draw vertical lines at x-axis ticks for Highcharts inside React apps
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*/*/historical-forecast*
// @grant        none
// @downloadURL  https://github.com/gmartins-tp/scripts/raw/refs/heads/main/react_vertical_lines.user.js
// @updateURL    https://github.com/gmartins-tp/scripts/raw/refs/heads/main/react_vertical_lines.user.js
// ==/UserScript==

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

})();
