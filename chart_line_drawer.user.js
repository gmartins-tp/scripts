// ==UserScript==
// @name         Chart Line Drawer (L, P, X, Esc)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @author       Gil Martins
// @description  Draw lines & parallel lines on any webpage — L (line), P (parallel), S (New parallel line), Z (revert one back), X (clear), Esc (cancel)
// @match        https://prod-rm.tp.proscloud.com/market/forecast/*
// @grant        GM_addStyle
// @downloadURL  https://github.com/gmartins-tp/scripts/raw/refs/heads/main/chart_line_drawer.user.js
// @updateURL    https://github.com/gmartins-tp/scripts/raw/refs/heads/main/chart_line_drawer.user.js
// ==/UserScript==

(function() {

    GM_addStyle(`
        .highcharts-tooltip-container{
            position: fixed !important;
            top: 0px !important;
            left:0px !important;
        }

        .rm-container-historical-forecast-body{
            position:relative !important;
        }
    `)   

  function adjustTooltip() {
    const el = document.querySelector('.highcharts-tooltip-container');
    if (!el) return;
    const visibility = el.querySelector('.highcharts-label').getAttribute('visibility');           // inline style
    if (visibility == 'hidden') {
      // if empty content ➞ force negative top (above viewport)
      el.style.display = 'none';
    } else {
        el.style.display = 'block';
   }
  }
  setInterval(adjustTooltip, 50);

    
    // Hide tooltip while drawing
    function hideTooltip() {
        const t = document.querySelector('.highcharts-tooltip-container');
        if(t) t.style.display = 'none';
    }

    // Restore tooltip with 100ms delay
    function restoreTooltip() {
        const t = document.querySelector('.highcharts-tooltip-container');
        if(t) setTimeout(() => { t.style.display = ''; }, 100);
    }

    function redrawAllLines() {
        ctx.clearRect(0,0,overlay.width, overlay.height);
        drawnLines.forEach(line => drawLineOnCanvas(line.a, line.b));
    }

    let mode = null;
    let points = [];
    let lastLine = null; // store last drawn line coordinates {a,b}
    let drawnLines = []; // each entry = {a,b}

    const overlay = document.createElement("canvas");
    Object.assign(overlay.style, {
        position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
        pointerEvents: "none", zIndex: 999999
    });
    document.body.appendChild(overlay);
    const ctx = overlay.getContext("2d");

    function resize() {
        overlay.width = innerWidth;
        overlay.height = innerHeight;
    }
    resize();
    addEventListener("resize", resize);

    addEventListener("keydown", e => {
        if (e.key === "L") { mode = "line"; points = []; hideTooltip();}
        if (e.key === "P") { mode = "parallel"; points = []; hideTooltip();}
        if (e.key === "X") {
            ctx.clearRect(0, 0, overlay.width, overlay.height); 
            drawnLines = []; 
        }
        if (e.key === "Escape") { 
            mode = null; 
            points = []; 
            restoreTooltip();
        }

        if(e.key === "S") {
            mode = "newParallel"; // special mode
            points = [];
            hideTooltip();
        }

        if(e.key === "Z") {
            if(drawnLines.length > 0) {
                drawnLines.pop();   // remove last line
                redrawAllLines();   // redraw remaining
                lastLine = drawnLines[drawnLines.length-1] || null;
            }
        }
    });

    // helper
    function drawLineOnCanvas(a,b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const slope = dy / dx;

        const y0 = a.y - slope*a.x;

        var elem = document.querySelector(".rm-measure-view-component");
        const elemWidth = elem.getBoundingClientRect().width + 25;
        const canvasWidth = window.innerWidth;
        const endX = canvasWidth - elemWidth;   // subtract the element width

        const yMax = y0 + slope*endX;

        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(55, y0);
        ctx.lineTo(endX, yMax);
        ctx.stroke();
    }
    

    addEventListener("click", e => {
        if (!mode) return;

        points.push({ x: e.clientX, y: e.clientY });

        if (mode === "line" && points.length === 2) {
            drawLine(points[0], points[1]);
            mode = null; points = [];
            restoreTooltip();
        }

        if (mode === "parallel" && points.length === 3) {
            drawLine(points[0], points[1]); // base
            makeParallel(points[0], points[1], points[2]); // offset
            mode = null; points = [];
            restoreTooltip();
        }

        if(mode === "newParallel") {
            const point = {x: e.clientX, y: e.clientY};
            drawParallelToLast(point);
            mode = null;
            restoreTooltip();
        }
    });

    function drawLine(a,b) {
        drawLineOnCanvas(a,b); // actually draw

        lastLine = {a,b};
        drawnLines.push({a,b});
    }

    // Function to create parallel line from lastLine with new point c
    function drawParallelToLast(c) {
        if(!lastLine) return;

        const {a, b} = lastLine;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const ux = -dy/len, uy = dx/len;

        // Compute offset so that new line passes through point c
        const offset = (c.x - a.x) * ux + (c.y - a.y) * uy;

        const newA = { x: a.x + ux*offset, y: a.y + uy*offset };
        const newB = { x: b.x + ux*offset, y: b.y + uy*offset };

        drawLine(newA, newB); // will also store lastLine
    }

    function makeParallel(a,b,c) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx,dy);
        const ux = -dy/len, uy = dx/len;
        const offset = (c.x - a.x)*ux + (c.y - a.y)*uy;

        const a2 = { x: a.x + ux*offset, y: a.y + uy*offset };
        const b2 = { x: b.x + ux*offset, y: b.y + uy*offset };

        // Draw extended line
        drawLine(a2,b2);
    }

})();


