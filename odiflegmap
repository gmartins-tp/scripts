// ==UserScript==
// @name         ODIFLEGmap (Refactored)
// @namespace    http://tampermonkey.net/
// @version      2025-10-17
// @description  Download Full ODIF Leg map
// @author       Gil Martins
// @match        https://prod-rm.tp.proscloud.com/market/optimizer/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @run-at       document-end
// @require      https://cdn.jsdelivr.net/npm/papaparse@5.5.3/papaparse.min.js
// ==/UserScript==

(function () {
    'use strict';

    /*************************
     * Configuration & State
     *************************/
    const API_BASE_ODIFLEGMAP = 'https://prod-rm.tp.proscloud.com/prosrm/oandd/services/rest/optimizer/dsc/odiflegmap';
    const API_SCHEDULE = 'https://prod-rm.tp.proscloud.com/prosrm/oandd/services/rest/optimizer/schedule';
    const API_DSC = 'https://prod-rm.tp.proscloud.com/prosrm/oandd/services/rest/optimizer/dsc';

    const DEFAULT_CONCURRENCY = 6;

    let totalTasks = 0;
    let completedTasks = 0;

    /*******************
     * Utility Helpers
     *******************/
    /**
     * Sleep for a random time between min and max milliseconds.
     * @param {number} min
     * @param {number} max
     */
    function randomDelay(min = 500, max = 2000) {
        const ms = Math.floor(Math.random() * (max - min + 1)) + min;
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Create DOM element from an HTML string.
     * @param {string} html
     * @returns {HTMLElement}
     */
    function createElementFromHTML(html) {
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        return div.firstElementChild;
    }

    /**
     * Safe JSON fetch (POST) with error handling.
     * @param {string} url
     * @param {object} payload
     */
    async function postJson(url, payload) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${txt}`);
        }

        return resp.json();
    }

    /*******************
     * Progress UI
     *******************/
    const progressContainer = document.createElement('div');
    progressContainer.style.position = 'fixed';
    progressContainer.style.right = '16px';
    progressContainer.style.top = '16px';
    progressContainer.style.width = '260px';
    progressContainer.style.padding = '8px';
    progressContainer.style.background = 'rgba(255,255,255,0.95)';
    progressContainer.style.border = '1px solid #ddd';
    progressContainer.style.borderRadius = '6px';
    progressContainer.style.boxShadow = '0 2px 6px rgba(0,0,0,0.08)';
    progressContainer.style.zIndex = '99999';
    progressContainer.style.display = 'none';

    const progressLabel = document.createElement('div');
    progressLabel.style.fontSize = '12px';
    progressLabel.style.marginBottom = '6px';
    progressLabel.textContent = 'ODIF Leg Export';

    const progressBarWrap = document.createElement('div');
    progressBarWrap.style.width = '100%';
    progressBarWrap.style.height = '10px';
    progressBarWrap.style.background = '#f1f1f1';
    progressBarWrap.style.borderRadius = '6px';
    progressBarWrap.style.overflow = 'hidden';

    const progressBar = document.createElement('div');
    progressBar.style.height = '100%';
    progressBar.style.width = '0%';
    progressBar.style.transition = 'width 0.2s ease';
    progressBar.style.background = 'linear-gradient(90deg,#5bbd72,#4caf50)';

    const progressText = document.createElement('div');
    progressText.style.fontSize = '11px';
    progressText.style.marginTop = '6px';

    progressBarWrap.appendChild(progressBar);
    progressContainer.appendChild(progressLabel);
    progressContainer.appendChild(progressBarWrap);
    progressContainer.appendChild(progressText);
    document.body.appendChild(progressContainer);

    function showProgress() {
        progressContainer.style.display = 'block';
    }

    function hideProgress() {
        progressContainer.style.display = 'none';
    }

    function updateProgress(completed, total) {
        if (total <= 0) return;
        const pct = Math.round((completed / total) * 100);
        progressBar.style.width = `${pct}%`;
        if (completed >= total) {
            progressText.textContent = 'Finalizing CSV...';
        } else {
            progressText.textContent = `${completed} / ${total} legs downloaded`;
        }
    }

    /*******************
     * Concurrency Runner
     *******************/
    /**
     * Runs an array of async task functions with a concurrency limit.
     * Each item in tasks must be a function that returns a Promise.
     * Resolves to an array with the same order as tasks.
     */
    async function runConcurrently(tasks, concurrency = DEFAULT_CONCURRENCY) {
        const results = new Array(tasks.length);
        let idx = 0;

        return new Promise((resolve) => {
            let active = 0;
            function next() {
                if (idx >= tasks.length && active === 0) {
                    resolve(results);
                    return;
                }

                while (active < concurrency && idx < tasks.length) {
                    const current = idx++;
                    active++;
                    tasks[current]()
                        .then((res) => (results[current] = res))
                        .catch((err) => {
                            console.error('Task error (index):', current, err);
                            results[current] = null;
                        })
                        .finally(() => {
                            active--;
                            // update progress here if tasks represent single leg downloads
                            completedTasks += 1;
                            updateProgress(completedTasks, totalTasks);
                            next();
                        });
                }
            }
            next();
        });
    }

    /*******************
     * Main download logic
     *******************/
    /**
     * Download ODIF leg map for a single origin-destination pair.
     * Returns array/object parsed from JSON response.
     */
    async function downloadOdifLegMap(origin, destination, flightNumber, flightDate) {
        const url = `${API_BASE_ODIFLEGMAP}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&showFullList=true`;
        const payload = { carrierCode: 'TP', flightNumber: String(flightNumber), flightDate: String(flightDate) };

        const json = await postJson(url, payload);
        return json;
    }

    /**
     * Build and trigger CSV download from array of rows.
     */
    function downloadCSV(rows, baseName = 'odiflegs') {
        if (!Array.isArray(rows) || rows.length === 0) {
            alert('No data to download.');
            return;
        }

        // Collect headers
        const keys = new Set();
        rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
        const headers = Array.from(keys);

        // Normalize rows to consistent keys
        const normalized = rows.map((r) => {
            const out = {};
            headers.forEach((h) => (out[h] = r[h] !== undefined ? r[h] : ''));
            return out;
        });

        const csv = Papa.unparse(normalized, { header: true });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const filename = `${baseName}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();

        // allow GC of large strings
        URL.revokeObjectURL(a.href);
    }

    /*******************
     * Button insertion
     *******************/

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== 'childList' || m.addedNodes.length === 0) continue;

            for (const node of Array.from(m.addedNodes)) {
                if (!(node instanceof HTMLElement)) continue;

                // Search for the existing action container
                const exportContainer = node.querySelector && node.querySelector('.secondary-actions');
                if (exportContainer) {
                    attachButton(exportContainer);
                    // we inserted the button; disconnect to avoid duplicates
                    observer.disconnect();
                    return;
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    function attachButton(exportContainer) {
        if (!exportContainer || exportContainer.querySelector('.odifleg-export-btn')) return;

        const btnHtml = `
        <div class="pillar-button rm-dsc-filter-button odifleg-export-btn size-large type-default" role="button" tabindex="0" style="margin-left:8px;">
            <div class="pillar-button-label">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right:6px;">
                    <path d="M3.464 3.464C2 4.929 2 7.286 2 12c0 4.714 0 7.071 1.464 8.536C4.929 22 7.286 22 12 22s7.071 0 8.536-1.464C22 19.071 22 16.714 22 12c0-4.714 0-7.071-1.464-8.536C19.071 2 16.714 2 12 2S4.929 2 3.464 3.464Z" fill="#1C274C"/>
                </svg>
                <div class="pillar-truncatedtext pillar-button-label-truncated-text">Full ODIF Leg Export</div>
            </div>
        </div>`;

        const newBtn = createElementFromHTML(btnHtml);
        exportContainer.insertBefore(newBtn, exportContainer.firstChild);

        newBtn.addEventListener('click', onExportClick);
    }

    function askDateRange() {
        return new Promise((resolve) => {
            const wrapper = document.createElement('div');
            wrapper.style.position = 'fixed';
            wrapper.style.top = '20px';
            wrapper.style.right = '50%';
            wrapper.style.zIndex = '999999';
            wrapper.style.background = 'white';
            wrapper.style.padding = '10px';
            wrapper.style.border = '1px solid #ccc';
            wrapper.style.borderRadius = '8px';
            wrapper.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';

            wrapper.innerHTML = `
                <label style="font-weight: bold;font-size: 15px;">Start Date: <input type="date" id="tm_start"  style="height:30px;padding: 3px;"></label><br>
                <br>
                <label style="font-weight: bold;font-size: 15px;">End Date: <input type="date" id="tm_end"  style="height:30px;padding: 3px;"></label><br><br>
                <button id="tm_ok" style="height:30px">OK</button>
                <button id="tm_cancel" style="height:30px">Cancel</button>
            `;

            document.body.appendChild(wrapper);

            document.getElementById('tm_ok').onclick = () => {
                const start = parseInt(document.getElementById('tm_start').value.replace(/-/g, ''));
                const end = parseInt(document.getElementById('tm_end').value.replace(/-/g, ''));
                wrapper.remove();
                resolve({ startDate: start, endDate: end });
            };

            document.getElementById('tm_cancel').onclick = () => {
                wrapper.remove();
                resolve(null);
            };
        });
    }

    /*******************
     * Export flow
     *******************/

    async function onExportClick() {
        try {
            const input = prompt('Enter flight numbers separated by commas (e.g. 00001,00005):');
            if (!input) return;

            const range = await askDateRange();
            if (!range) return; // user cancelled
            const { startDate, endDate } = range;
            //console.log( startDate, endDate)


            const flightNumbers = input
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);

            if (flightNumbers.length === 0) {
                alert('No valid flight numbers provided.');
                return;
            }

            showProgress();
            completedTasks = 0;

            // Build tasks
            const tasks = [];
            for (const flight of flightNumbers) {
                // Retrieve schedule for flight
                let scheduleJson;
                try {
                    scheduleJson = await postJson(API_SCHEDULE, { myMarkets: true });
                } catch (err) {
                    console.error('Failed fetching schedule for flight', flight, err);
                    continue;
                }

                console.log(scheduleJson)

                const schedule = scheduleJson?.TP?.[flight];
                if (!Array.isArray(schedule) || schedule.length === 0) {
                    console.warn('No schedule entries for flight', flight);
                    continue;
                }

                // For the first date, fetch legMapping (once per flight)
                let legsList = [];
                for (const flightDate of schedule) {

                    // if flight date not in between startDate and endDate ignores
                    if (flightDate < startDate || flightDate > endDate){
                        continue
                    }
                    
                    if (legsList.length === 0) {
                        try {
                            const dscJson = await postJson(API_DSC, { carrierCode: 'TP', flightNumber: String(flight), flightDate: String(flightDate) });
                            legsList = Object.keys(dscJson.legMapping || {});
                        } catch (err) {
                            console.error('Failed fetching legs for', flight, flightDate, err);
                            continue;
                        }
                    }

                    // Create a task per leg
                    for (const l of legsList) {
                        const [origin, destination] = l.split('-');
                        tasks.push(async () => {
                            await randomDelay();
                            try {
                                const resp = await downloadOdifLegMap(origin, destination, flight, flightDate);
                                // If response is an array, return it, otherwise wrap
                                if (Array.isArray(resp)) return resp.map((r) => ({ ...r, FLIGHT_NUMBER: String(flight), FLIGHT_DATE: String(flightDate) }));
                                if (resp && typeof resp === 'object') return [{ ...resp, FLIGHT_NUMBER: String(flight), FLIGHT_DATE: String(flightDate) }];
                                return [];
                            } catch (err) {
                                console.error('Download failed for leg', l, 'flight', flight, 'date', flightDate, err);
                                return [];
                            }
                        });
                    }
                }
            }

            if (tasks.length === 0) {
                alert('No legs/tasks found to download.');
                hideProgress();
                return;
            }

            totalTasks = tasks.length;
            completedTasks = 0;
            updateProgress(0, totalTasks);

            const results = await runConcurrently(tasks, DEFAULT_CONCURRENCY);

            // Flatten results (filter nulls)
            const flattened = results.filter(Boolean).flat();

            if (flattened.length === 0) {
                alert('No data was downloaded. See console for errors.');
                hideProgress();
                return;
            }

            downloadCSV(flattened, 'odiflegmap');
            hideProgress();
        } catch (err) {
            console.error('Unexpected error in export flow:', err);
            hideProgress();
            alert('An unexpected error occurred. See console for details.');
        }
    }

})();
