// ==UserScript==
// @name         GERAL UTIL FUNCTIONS
// @namespace    http://tampermonkey.net/
// @version      0.4
// @description  usefull functions
// @match        https://prod-rm.tp.proscloud.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdn.jsdelivr.net/npm/xxhashjs@0.2.2/build/xxhash.min.js
// @connect      prod-rm.tp.proscloud.com
// ==/UserScript==

(function() {
    'use strict';

    unsafeWindow.proshack = unsafeWindow.proshack || {};


    //inject loading div css
    GM_addStyle(`
    #gil_container_div{
        padding-top: 30px;
        overflow:auto;
        padding-left: 30px;
     }
    .gil_loader_container{
     margin:0 auto;
    margin-top:15%;
        width: 98px;
        position:relative;
    }
    .gil_loader_text{
     margin-left:-35px;
     text-align:center;
     padding-top:5px;
    }
    .gil_loader {
    width: 48px;
    height: 48px;
    border: 5px solid #111;
    border-bottom-color: transparent;
    border-radius: 50%;
    display: inline-block;
    box-sizing: border-box;
    animation: gil_rotation 1s linear infinite;
    }

    @keyframes gil_rotation {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
    }

    .gil_super_hide{
    display:none !important;
    }

    
`);

    unsafeWindow.proshack.dcpData = [
            {DCP:1,"DyPr Start":364,"DyPr End":236,"Length (days)":129},
            {DCP:2,"DyPr Start":235,"DyPr End":174,"Length (days)":62},
            {DCP:3,"DyPr Start":173,"DyPr End":127,"Length (days)":47},
            {DCP:4,"DyPr Start":126,"DyPr End":103,"Length (days)":24},
            {DCP:5,"DyPr Start":102,"DyPr End":75,"Length (days)":28},
            {DCP:6,"DyPr Start":74,"DyPr End":62,"Length (days)":13},
            {DCP:7,"DyPr Start":61,"DyPr End":47,"Length (days)":15},
            {DCP:8,"DyPr Start":46,"DyPr End":34,"Length (days)":13},
            {DCP:9,"DyPr Start":33,"DyPr End":26,"Length (days)":8},
            {DCP:10,"DyPr Start":25,"DyPr End":18,"Length (days)":8},
            {DCP:11,"DyPr Start":17,"DyPr End":10,"Length (days)":8},
            {DCP:12,"DyPr Start":9,"DyPr End":8,"Length (days)":2},
            {DCP:13,"DyPr Start":7,"DyPr End":5,"Length (days)":3},
            {DCP:14,"DyPr Start":4,"DyPr End":2,"Length (days)":3},
            {DCP:15,"DyPr Start":1,"DyPr End":1,"Length (days)":1},
            {DCP:16,"DyPr Start":0,"DyPr End":0,"Length (days)":1}
        ];

    unsafeWindow.proshack.getActiveTabOD = function(){
        const activeLi = document.querySelector('.market-tabs-container ul.tabs-container.top li.active');
        if (!activeLi) return null;
        const a = activeLi.querySelector('a.tab-label, a.tab-focus-text.tab-label');
        if (!a) return null;
        return a.textContent.trim();
    }


    unsafeWindow.proshack.read_menu_filters = function(){

        const data = {};

        document.querySelectorAll('.rm-pill-bar [class*="pill-for-"]').forEach(div => {
            const match = Array.from(div.classList).find(c => c.startsWith('pill-for-'));
            if (match) {
                const key = match.replace('pill-for-', '');
                const valueSpan = div.querySelector('span.value');
                if (valueSpan) {
                    data[key] = valueSpan.textContent.trim();
                }
            }
        });
        console.log("filter options:")
        console.log(data)
        return data

    }


        /**
     * Get the 5th child <div> (0-based index 4) of `.rm.standard-page-layout[data-testid="page-layout"]`
     */
    unsafeWindow.proshack.getFifthChildDiv = function() {
        const container = document.querySelector('div.rm.standard-page-layout[data-testid="page-layout"]');
        if (!container) {
            console.warn('Container (page-layout) not found yet');
            return null;
        }

        const divChildren = Array.from(container.children).filter(ch => ch.tagName.toLowerCase() === 'div');
        if (divChildren.length > 4) {
            const fifthDiv = divChildren[4];

            // Check if the 'gil_container_div' already exists
            let newDiv = document.getElementById('gil_container_div');
            if (!newDiv) {
                // Create a new div element if it doesn't exist
                newDiv = document.createElement('div');
                newDiv.classList.add('gil_super_show');
                newDiv.id = 'gil_container_div';

                // Insert the new div before the fifth div
                fifthDiv.parentNode.insertBefore(newDiv, fifthDiv);

                // Add the 'gil_super_hide' class to the fifth div
                fifthDiv.classList.add('gil_super_hide');
            }

            // Return the existing or newly created div
            return newDiv;
        }

        console.warn('Less than 5 div children found');
        return null;
    };


    unsafeWindow.proshack.show_loading = function(){
        const targetDiv = unsafeWindow.proshack.getFifthChildDiv();
        if (targetDiv) {
            targetDiv.innerHTML = '<div class="gil_loader_container"><div class="gil_loader"></div><div class="gil_loader_text"></div></div>'

            let text_loader = document.querySelector('div.gil_loader_text');
            text_loader.innerHTML = 'Retrieving Data...<br/>Please Wait...'
        }
    }

    unsafeWindow.proshack.change_loading_text_to = function(text){
        console.log("trying to change to:"+text )

        const loading_container = document.querySelector('.gil_loader_text');
        console.log('Found element:', loading_container);

        if (loading_container) loading_container.innerHTML = text
        Object.freeze(loading_container);
    }


    // Helper to open / upgrade the IndexedDB
    function openCacheDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('ProshackCsvCache', 1);
            req.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('csvStore')) {
                    // keyPath = 'key'
                    const store = db.createObjectStore('csvStore', { keyPath: 'key' });
                    // If you want to efficiently query by timestamp, create an index on ts
                    store.createIndex('byTs', 'ts');
                }
            };
            req.onsuccess = event => {
                resolve(event.target.result);
            };
            req.onerror = event => {
                reject(event.target.error);
            };
        });
    }

    // Get cached entry (string) or null
    async function getFromCache(key) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('csvStore', 'readonly');
            const store = tx.objectStore('csvStore');
            const req = store.get(key);
            req.onsuccess = () => {
                const rec = req.result;
                if (rec && rec.value != null) {
                    resolve(rec.value);
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => reject(req.error);
        });
    }

    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

    // Put into cache (or overwrite) with timestamp
    async function putToCache(key, value) {

        await evictOldEntries(TWO_DAYS)

        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('csvStore', 'readwrite');
            const store = tx.objectStore('csvStore');
            // You can store extra metadata: e.g. ts = Date.now()
            store.put({ key: key, value: value, ts: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // Evict old entries older than `ageMs` (milliseconds)
    async function evictOldEntries(ageMs) {
        const cutoff = Date.now() - ageMs;
        const db = await openCacheDb();
        // First, get all keys (or query index) to find those with ts < cutoff
        return new Promise((resolve, reject) => {
            const tx = db.transaction('csvStore', 'readwrite');
            const store = tx.objectStore('csvStore');
            const idx = store.index ? store.index('byTs') : null;
            let range = null;
            if (idx) {
                // use index to only iterate old items
                range = IDBKeyRange.upperBound(cutoff);
                const cursorReq = idx.openCursor(range);
                cursorReq.onsuccess = ev => {
                    const cursor = ev.target.result;
                    if (cursor) {
                        // cursor.value has {key, value, ts}
                        const rec = cursor.value;
                        // rec.ts should already be <= cutoff by range
                        store.delete(rec.key);
                        cursor.continue();
                    }
                };
                cursorReq.onerror = e => reject(e.target.error);
            } else {
                // no index: fallback to scanning all
                const getAllReq = store.getAll();
                getAllReq.onsuccess = ev2 => {
                    const all = ev2.target.result || [];
                    for (const rec of all) {
                        if (rec.ts < cutoff) {
                            store.delete(rec.key);
                        }
                    }
                };
                getAllReq.onerror = e => reject(e.target.error);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // Now, your modified fetchCSVText function
    /*unsafeWindow.proshack.fetchCSVText = function(base_url, origin, destination, filterParam) {
        const url = `${base_url}?filter=${filterParam}`;
        const today = new Date();
        const formattedDate = today.toISOString().slice(0, 10).replace(/-/g, '');
        let cacheKey = XXH.h64(url, 0xABCD).toString(16);
        cacheKey = cacheKey + '_' + formattedDate;

        console.log('Cache key:', cacheKey);

        return (async () => {
            // Try to read from IndexedDB cache
            try {
                console.log("Reached try clause...")
                const cached = await getFromCache(cacheKey);
                console.log("after cached try!")
                console.log(cached)
                if (cached != null) {
                    console.log("Using IndexedDB cache for", url);
                    return cached;
                }
            } catch (err) {
                console.warn("Error reading from IndexedDB cache", err);
                // fall through to fetch
            }

            console.log("get URL!")
            console.log(url)

            // If not in cache, fetch via GM_xmlhttpRequest
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    responseType: "text",
                    onload: async resp => {
                        console.log("SCRR")
                        if (resp.status >= 200 && resp.status < 300) {
                            const text = resp.responseText;
                            // Try writing to cache
                            try {
                                await putToCache(cacheKey, text);
                                console.log("IndexedDB: cached", cacheKey);
                            } catch (err2) {
                                console.warn("Error writing to IndexedDB cache", err2);
                            }
                            resolve(text);
                        } else {
                            reject(new Error(`HTTP status ${resp.status}`));
                        }
                    },
                    onerror: err => {
                        console.log("XXSCRR")
                        reject(err);
                    }
                });
            });
        })();
    };*/

    unsafeWindow.proshack.fetchCSVText = function(base_url, origin, destination, filterParam) {
        const url = `${base_url}?filter=${filterParam}`;
        const today = new Date();
        const formattedDate = today.toISOString().slice(0, 10).replace(/-/g, '');
        let cacheKey = XXH.h64(url, 0xABCD).toString(16);
        cacheKey = cacheKey + '_' + formattedDate;

        console.log('Cache key:', cacheKey);

        return (async () => {
            // Try to read from IndexedDB cache
            try {
                console.log("Reached try clause...");
                const cached = await getFromCache(cacheKey);
                console.log("after cached try!");
                console.log(cached);
                if (cached != null) {
                    console.log("Using IndexedDB cache for", url);
                    return cached;
                }
            } catch (err) {
                console.warn("Error reading from IndexedDB cache", err);
                // fall through to fetch
            }

            console.log("Fetching URL:", url);

            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                        "sec-fetch-dest": "document",
                        "sec-fetch-mode": "navigate",
                        // you can add other headers here if needed
                    },
                    credentials: 'include'  // or 'include' if cross‐site cookies needed
                });

                if (!response.ok) {
                    throw new Error(`HTTP status ${response.status}`);
                }

                const text = await response.text();

                try {
                    await putToCache(cacheKey, text);
                    console.log("IndexedDB: cached", cacheKey);
                } catch (err2) {
                    console.warn("Error writing to IndexedDB cache", err2);
                }

                return text;

            } catch (err) {
                console.error("Fetch failed:", err);
                throw err;
            }
        })();
    };



    const API_BASE_HISTORICAL = "https://prod-rm.tp.proscloud.com/prosrm/oandd/services/rest/forecastedData/summary/export";


        // === UI: create overlay ===
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "10px";
    overlay.style.right = "10px";
    overlay.style.width = "300px";
    overlay.style.maxHeight = "400px";
    overlay.style.overflowY = "auto";
    overlay.style.background = "rgba(0,0,0,0.8)";
    overlay.style.color = "white";
    overlay.style.fontSize = "12px";
    overlay.style.padding = "10px";
    overlay.style.zIndex = 999999;
    overlay.style.borderRadius = "6px";
    document.body.appendChild(overlay);

    function addProgressBar(filename) {
        const container = document.createElement("div");
        container.style.marginBottom = "8px";

        const label = document.createElement("div");
        label.textContent = filename;
        label.style.marginBottom = "2px";

        const bar = document.createElement("div");
        bar.style.height = "8px";
        bar.style.background = "gray";
        bar.style.borderRadius = "4px";
        bar.style.overflow = "hidden";

        const progress = document.createElement("div");
        progress.style.height = "100%";
        progress.style.width = "0%";
        progress.style.background = "limegreen";
        progress.id = "gil_progress";
        bar.appendChild(progress);

        container.appendChild(label);
        container.appendChild(bar);
        overlay.appendChild(container);

        return [progress, container];
    }

         // Encode filter JSON for a given origin and destination
    function encodeFilter_historical(dcp, origin, destination) {
        const filterObj =
              {
                  "requestFields":{
                  "filters":{
                      "DCP":[''+dcp],
                      //"POS": ["PT"],
                      "ONL_ORGN":[origin],
                      "ONL_DSTN":[destination]
                 },
                  "forecastType":"wtp",
                  "lowestAvailableClass":"lowestAvailableClassByBlock",
                  "exportBy":[
                      {"key":"TRP_ORGN","level":"Airport"},
                      {"key":"TRP_DSTN","level":"Airport"},
                      {"key":"POS","level":"POS"},
                      {"key":"PATH","level":"Path"},
                      {"key":"DOW","level":"DOW"},
                      {"key":"TRAVEL_TIME","level":"TravelTime"},
                      {"key":"PAX_TYPE","level":"PaxType"},
                      {"key":"TOD","level":"TOD"},
                      {"key":"CLASS","level":"ClassBlock"},
                      {"key":"Dept_Date","level":"Day"}]
                  }
              };
        console.log(filterObj)
        return encodeURIComponent(JSON.stringify(filterObj));
    }

    //--------------------------    
    unsafeWindow.proshack.historical_downloadAllCSVs = async function (origin, destination, { skipDownload = false } = {}) {
        const maxConcurrent = 4;
        const totalDCP = 16;
        const results = [];

        const filename = `${origin}-${destination}-historical-merged.csv`;
        const [progressBar, progress_container] = addProgressBar(filename);
        if (progressBar) progressBar.style.width = '0%';

        // ---------- cached fetch for a single DCP ----------
        const fetchCSVFetch = async (dcp) => {
            const filterParam = encodeFilter_historical(dcp, origin, destination);
            const url = `${API_BASE_HISTORICAL}?filter=${filterParam}`;

            // ── build the same style cache key used by fetchCSVText ──
            const today = new Date();
            const formattedDate = today.toISOString().slice(0, 10).replace(/-/g, '');
            let cacheKey = XXH.h64(url, 0xABCD).toString(16) + '_' + formattedDate;

            // ── try cache first ──
            try {
                const cached = await getFromCache(cacheKey);
                if (cached != null) {
                    console.log(`[DCP ${dcp}] IndexedDB cache hit`);
                    return { dcp, text: cached };
                }
            } catch (err) {
                console.warn(`[DCP ${dcp}] cache read error`, err);
            }

            // ── cache miss → network fetch ──
            console.log(`[DCP ${dcp}] fetching from network…`);
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${response.status} for DCP ${dcp}`);
            const text = await response.text();

            // ── write to cache ──
            try {
                await putToCache(cacheKey, text);
                console.log(`[DCP ${dcp}] cached in IndexedDB`);
            } catch (err2) {
                console.warn(`[DCP ${dcp}] cache write error`, err2);
            }

            return { dcp, text };
        };

        // ---------- concurrency pool ----------
        const downloadDCP = async (dcp) => {
            const data = await fetchCSVFetch(dcp);
            results.push(data);
            if (progressBar) progressBar.style.width = `${(results.length / totalDCP) * 100}%`;
            return data;
        };

        const pool = [];
        for (let dcp = 1; dcp <= totalDCP; dcp++) {
            const promise = downloadDCP(dcp);
            pool.push(promise);

            if (pool.length >= maxConcurrent) {
                await Promise.race(pool);
                for (let i = pool.length - 1; i >= 0; i--) {
                    if (pool[i].isFulfilled) pool.splice(i, 1);
                }
            }
        }
        await Promise.all(pool);

        // ---------- merge & download ----------
        let merged = "";
        results.sort((a, b) => a.dcp - b.dcp).forEach(({ dcp, text }, idx) => {
            const lines = text.trim().split("\n");
            if (idx === 0) merged += lines[0] + ",dcp\n";
            for (let i = 1; i < lines.length; i++) merged += lines[i] + `,${dcp}\n`;
        });

        if (!skipDownload) {
            const blob = new Blob([merged], { type: "text/csv" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            link.click();
        }

        if (progress_container) progress_container.remove();
        return merged;
    };


/*
    function fetchCSV(dcp, origin, destination) {
        return new Promise((resolve, reject) => {
            const filterParam = encodeFilter_historical(dcp, origin, destination);
            console.log(filterParam )
            const url = `${API_BASE_HISTORICAL}?filter=${filterParam}`;

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: "blob", // text, not blob
                onload: function (response) {
                    // convert blob to text
                    const reader = new FileReader();
                    reader.onload = () => {
                        resolve({ dcp, text: reader.result });
                    };
                    reader.onerror = () => reject(`Failed to read blob for DCP ${dcp}`);
                    console.log(response.response)
                    reader.readAsText(response.response);
                },
                onerror: function () {
                    reject(`Failed to fetch DCP ${dcp}`);
                }
            });
        });
    }
    */

    // Your code here...
})();
