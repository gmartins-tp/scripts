// ==UserScript==
// @name         HF Gradio Generic Client
// @version      2.0
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    class HFGradioAPI {
        constructor(baseUrl) {
            // normalise: no trailing slash
            this.base = baseUrl.replace(/\/+$/, '');
        }

        /* ---------- low-level request ---------- */
        _request(method, url, data, extraHeaders = {}) {
            return new Promise((resolve, reject) => {
                const headers = { ...extraHeaders };
                if (method !== 'GET' && data) {
                    headers['Content-Type'] = 'application/json';
                }
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    data: data ? JSON.stringify(data) : null,
                    onload: (resp) => {
                        // SSE streams come back as raw text
                        const isSSE = (extraHeaders['Accept'] || '').includes('event-stream');
                        if (isSSE) {
                            resolve(resp.responseText);
                            return;
                        }
                        try { resolve(JSON.parse(resp.responseText)); }
                        catch (e) { resolve(resp.responseText); }
                    },
                    onerror: (err) => reject(new Error(`${method} ${url} failed: ${err.statusText||err}`))
                });
            });
        }

        /* ---------- SSE parser (Gradio 6.x) ---------- */
        _parseSSE(text) {
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === 'event: complete') {
                    for (let j = i + 1; j < lines.length; j++) {
                        const line = lines[j];
                        if (line.startsWith('data:')) {
                            return JSON.parse(line.slice(5).trim()); // output array
                        }
                    }
                }
            }
            throw new Error("No 'event: complete' in SSE:\n" + text.slice(0, 500));
        }

        /* ---------- direct call (POST -> GET SSE) ---------- */
        async call(apiName, params = {}) {
            const submit = await this._request(
                'POST', `${this.base}/v2/${apiName}`, params
            );
            if (!submit.event_id) {
                throw new Error("No event_id: " + JSON.stringify(submit));
            }
            const sseText = await this._request(
                'GET', `${this.base}/${apiName}/${submit.event_id}`, null,
                { 'Accept': 'text/event-stream' }
            );
            const arr = this._parseSSE(sseText);
            return arr && arr[0];               // first (and usually only) output component
        }

        /* ---------- async job helpers ---------- */
        async submitJob(apiName, params) {
            const res = await this.call(apiName, params);
            if (!res || !res.job_id) throw new Error("No job_id returned");
            return res.job_id;
        }

        async checkJob(apiName, jobId) {
            return await this.call(apiName, { job_id: jobId });
        }

        async pollJob(submitApi, checkApi, params, opts = {}) {
            const {
                maxWaitMs = 120000,
                pollInterval = 3000,
                onStatus = () => {}
            } = opts;

            const jobId = await this.submitJob(submitApi, params);
            const start = Date.now();

            while (Date.now() - start < maxWaitMs) {
                const status = await this.checkJob(checkApi, jobId);
                onStatus(status);

                if (status.status === "done")  return status.result;
                if (status.status === "error") throw new Error(status.error || "Job failed");
                if (status.status === "not_found") throw new Error("Job lost (Space restarted?)");

                await new Promise(r => setTimeout(r, pollInterval));
            }
            throw new Error(`Polling exceeded ${maxWaitMs}ms`);
        }
    }

    /* ---------- expose ---------- */
    unsafeWindow.HFGradioAPI = HFGradioAPI;

    /* --- backward-compat: keep the old ARIMA helper working --- */
    const arimaClient = new HFGradioAPI("https://mithus-arima.hf.space/gradio_api/call");
    unsafeWindow.hfArima = {
        submitJob: (seriesArray, h) => arimaClient.submitJob("submit_arima", { input_list: seriesArray, h }),
        checkJob:  (jobId)          => arimaClient.checkJob("check_arima", { job_id: jobId }),
        getForecast: (seriesArray, h, opts) => arimaClient.pollJob(
            "submit_arima", "check_arima", { input_list: seriesArray, h }, opts
        )
    };

    console.log("[HFGradio] Generic client ready");
})();
