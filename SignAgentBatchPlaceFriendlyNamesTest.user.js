// ==UserScript==
// @name         SignAgent Batch Friendly Names (TEST)
// @namespace    signbrothers-tools
// @version      0.3.0
// @description  Read-only UX companion for Tyler's Batch Place script. Shows friendly labels in Batch Details and rewrites only the Batch Place confirmation dialog.
// @match        https://app.signagent.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.3.0';
    const LOG_PREFIX = '[SB Batch Names]';
    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
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
        if (!id) return { name: '', parent: '', display: '' };

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
        const display = parent && name ? `${parent} → ${name}` : (name || parent);

        return { name, parent, display };
    }

    function projectCandidates(projectId) {
        const rows = [];
        const seen = new Set();

        function add(source, rawText, score) {
            let text = cleanText(rawText);
            if (!text) return;

            text = text
                .replace(/\s*[|–—-]\s*SignAgent\s*$/i, '')
                .replace(/^SignAgent\s*[|–—-]\s*/i, '')
                .trim();

            if (!text || text === String(projectId)) return;
            if (/^(map|export|settings|new folder|new project|manage fonts|new location|batch import)$/i.test(text)) return;
            if (text.length > 140) return;
            if (!/[A-Za-z]/.test(text)) return;

            const key = text.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            rows.push({ source, text, score });
        }

        add('document.title', document.title, 100);

        const directSelectors = [
            '[data-project-name]',
            '#project_name',
            '#project-name',
            '.project-name',
            '.project_name',
            '.breadcrumb li',
            '.breadcrumb a',
            'h1',
            'h2'
        ];

        for (const selector of directSelectors) {
            document.querySelectorAll(selector).forEach(el => {
                const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                add(`${selector}${visible ? ':visible' : ''}`, el.innerText || el.textContent, visible ? 80 : 25);
            });
        }

        if (projectId) {
            document.querySelectorAll('a[href]').forEach(anchor => {
                const href = anchor.getAttribute('href') || '';
                if (!href.includes(`/organization/${projectId}/`)) return;
                add('organization-link', anchor.innerText || anchor.textContent, 40);
            });
        }

        rows.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
        return rows;
    }

    function resolveFriendlyData(ids = readBatchIds()) {
        const state = resolveState(ids.state);
        const projects = projectCandidates(ids.project);

        return {
            ids,
            friendly: {
                project: projects[0]?.text || '',
                location: resolveLocationName(ids.location),
                signType: resolveSignTypeName(ids.signType),
                state: state.display
            }
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

        const result = resolveFriendlyData(ids);

        setFriendlyPanelValue('#sa-batch-project', ids.project, result.friendly.project);
        setFriendlyPanelValue('#sa-batch-location', ids.location, result.friendly.location);
        setFriendlyPanelValue('#sa-batch-type', ids.signType, result.friendly.signType);
        setFriendlyPanelValue('#sa-batch-state', ids.state, result.friendly.state);
    }

    function buildFriendlyConfirmation(match) {
        const count = match[1];
        const ids = {
            project: match[3],
            location: match[4],
            signType: match[5],
            state: match[6]
        };
        const result = resolveFriendlyData(ids);
        const show = (friendly, id) => friendly || id;

        return (
            `Create ${count} sign${count === '1' ? '' : 's'}?\n\n` +
            `Project: ${show(result.friendly.project, ids.project)}\n` +
            `Location: ${show(result.friendly.location, ids.location)}\n` +
            `Sign Type: ${show(result.friendly.signType, ids.signType)}\n` +
            `State: ${show(result.friendly.state, ids.state)}`
        );
    }

    function installConfirmInterceptor(target) {
        if (!target || typeof target.confirm !== 'function') return;
        if (target.confirm.__sbBatchFriendlyNames) return;

        const nativeConfirm = target.confirm.bind(target);
        const wrappedConfirm = function (message) {
            const text = String(message ?? '');
            const match = text.match(BATCH_CONFIRM_RE);
            if (!match) return nativeConfirm(message);

            const friendlyMessage = buildFriendlyConfirmation(match);
            console.log(`${LOG_PREFIX} rewrote Batch Place confirmation`, {
                original: text,
                friendly: friendlyMessage
            });
            return nativeConfirm(friendlyMessage);
        };

        Object.defineProperty(wrappedConfirm, '__sbBatchFriendlyNames', {
            value: true
        });

        try {
            target.confirm = wrappedConfirm;
        } catch (error) {
            console.warn(`${LOG_PREFIX} could not patch confirm on one window context`, error);
        }
    }

    function start() {
        installConfirmInterceptor(PAGE);
        if (window !== PAGE) installConfirmInterceptor(window);

        const refresh = () => {
            installConfirmInterceptor(PAGE);
            if (window !== PAGE) installConfirmInterceptor(window);
            refreshBatchDetails();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', refresh, { once: true });
        } else {
            refresh();
        }

        setInterval(refresh, 750);
        console.log(`${LOG_PREFIX} v${VERSION} active. Original Batch Place script is unchanged.`);
    }

    start();
})();
