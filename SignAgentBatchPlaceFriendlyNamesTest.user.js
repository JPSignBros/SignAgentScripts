// ==UserScript==
// @name         SignAgent Batch Friendly Names (TEST)
// @namespace    signbrothers-tools
// @version      0.4.0
// @description  TEST wrapper that runs the immutable Batch Place v1.0.0 baseline and adds human-readable Batch Details and Save All confirmation labels.
// @match        https://app.signagent.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @require      https://raw.githubusercontent.com/JPSignBros/SignAgentScripts/ed659e54c845c408a9efd7479b3b84552d20cb82/SignAgentBatchPlace.user.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.4.0';
    const LOG_PREFIX = '[SB Batch Names]';
    const ID_ATTR = 'data-sb-batch-friendly-id';
    const BATCH_CONFIRM_RE =
        /^Create (\d+) sign(s?)\?\n\nProject: (\d+)\nLocation: (\d+)\nSign Type: (\d+)\nState: (\d+)$/;

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function stripLeadingCount(value) {
        return cleanText(value).replace(/^\d+\s*/, '').trim();
    }

    function rememberAndReadId(selector) {
        const el = document.querySelector(selector);
        if (!el) return '';

        const text = cleanText(el.textContent);
        if (/^\d+$/.test(text)) {
            el.setAttribute(ID_ATTR, text);
            return text;
        }

        return cleanText(el.getAttribute(ID_ATTR));
    }

    function readBatchIds() {
        return {
            project: rememberAndReadId('#sa-batch-project'),
            location: rememberAndReadId('#sa-batch-location'),
            signType: rememberAndReadId('#sa-batch-type'),
            state: rememberAndReadId('#sa-batch-state')
        };
    }

    function labelFromAnchor(prefix, id) {
        if (!id) return '';
        const anchor = document.getElementById(`${prefix}${id}_anchor`);
        return stripLeadingCount(anchor?.innerText || anchor?.textContent || '');
    }

    function resolveLocationName(id) {
        return labelFromAnchor('zone', id);
    }

    function resolveSignTypeName(id) {
        return labelFromAnchor('sign_template', id);
    }

    function resolveState(id) {
        if (!id) return '';

        const node = document.getElementById(`state${id}`);
        let data = null;

        try {
            data = JSON.parse(node?.getAttribute('data-jstree') || 'null');
        } catch (error) {
            data = null;
        }

        const nested =
            data?.create_order_with_signs_and_install ||
            data?.create_order_with_signs ||
            data?.create_order_with_install ||
            null;

        const name = cleanText(nested?.name || labelFromAnchor('state', id));
        const parent = cleanText(data?.projectName || '');

        return parent && name ? `${parent} → ${name}` : (name || parent);
    }

    function resolveProjectName(projectId) {
        const candidates = [];
        const seen = new Set();

        function add(rawText, score) {
            let text = cleanText(rawText);
            if (!text) return;

            text = text
                .replace(/\s*[|–—-]\s*SignAgent\s*$/i, '')
                .replace(/^SignAgent\s*[|–—-]\s*/i, '')
                .trim();

            if (!text || text === String(projectId)) return;
            if (/^(map|export|settings|new folder|new project|manage fonts|new location|batch import)$/i.test(text)) return;
            if (text.length > 140 || !/[A-Za-z]/.test(text)) return;

            const key = text.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push({ text, score });
        }

        add(document.title, 100);

        for (const selector of [
            '[data-project-name]',
            '#project_name',
            '#project-name',
            '.project-name',
            '.project_name',
            '.breadcrumb li',
            '.breadcrumb a',
            'h1',
            'h2'
        ]) {
            document.querySelectorAll(selector).forEach(el => {
                const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                add(el.innerText || el.textContent, visible ? 80 : 25);
            });
        }

        if (projectId) {
            document.querySelectorAll('a[href]').forEach(anchor => {
                const href = anchor.getAttribute('href') || '';
                if (href.includes(`/organization/${projectId}/`)) {
                    add(anchor.innerText || anchor.textContent, 40);
                }
            });
        }

        candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
        return candidates[0]?.text || '';
    }

    function resolveFriendly(ids) {
        return {
            project: resolveProjectName(ids.project),
            location: resolveLocationName(ids.location),
            signType: resolveSignTypeName(ids.signType),
            state: resolveState(ids.state)
        };
    }

    function setFriendlyPanelValue(selector, id, friendly) {
        const el = document.querySelector(selector);
        if (!el || !id) return;

        el.setAttribute(ID_ATTR, id);
        el.title = `SignAgent ID: ${id}`;
        el.textContent = friendly || id;
    }

    function refreshBatchDetails() {
        const ids = readBatchIds();
        if (!ids.project && !ids.location && !ids.signType && !ids.state) return;

        const friendly = resolveFriendly(ids);
        setFriendlyPanelValue('#sa-batch-project', ids.project, friendly.project);
        setFriendlyPanelValue('#sa-batch-location', ids.location, friendly.location);
        setFriendlyPanelValue('#sa-batch-type', ids.signType, friendly.signType);
        setFriendlyPanelValue('#sa-batch-state', ids.state, friendly.state);
    }

    function buildFriendlyConfirmation(match) {
        const count = match[1];
        const ids = {
            project: match[3],
            location: match[4],
            signType: match[5],
            state: match[6]
        };
        const friendly = resolveFriendly(ids);
        const show = (name, id) => name || id;

        return (
            `Create ${count} sign${count === '1' ? '' : 's'}?\n\n` +
            `Project: ${show(friendly.project, ids.project)}\n` +
            `Location: ${show(friendly.location, ids.location)}\n` +
            `Sign Type: ${show(friendly.signType, ids.signType)}\n` +
            `State: ${show(friendly.state, ids.state)}`
        );
    }

    const nativeConfirm = window.confirm.bind(window);

    function friendlyConfirm(message) {
        const text = String(message ?? '');
        const match = text.match(BATCH_CONFIRM_RE);

        if (!match) {
            return nativeConfirm(message);
        }

        const friendlyMessage = buildFriendlyConfirmation(match);
        console.log(`${LOG_PREFIX} rewrote Batch Place confirmation`, {
            original: text,
            friendly: friendlyMessage
        });

        return nativeConfirm(friendlyMessage);
    }

    window.confirm = friendlyConfirm;
    globalThis.confirm = friendlyConfirm;
    self.confirm = friendlyConfirm;

    function startUiRefresh() {
        refreshBatchDetails();
        setInterval(refreshBatchDetails, 250);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startUiRefresh, { once: true });
    } else {
        startUiRefresh();
    }

    console.log(
        `${LOG_PREFIX} v${VERSION} active in the same sandbox as immutable Batch Place v1.0.0.`
    );
})();
