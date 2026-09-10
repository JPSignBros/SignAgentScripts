// ==UserScript==
// @name         SignAgent Batch Friendly Names (TEST)
// @namespace    signbrothers-tools
// @version      0.2.0
// @description  Read-only companion for Tyler's Batch Place script that resolves friendly Project, Location, Sign Type, and State labels.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.2.0';
    const LOG_PREFIX = '[SB Batch Names]';
    const WRAPPER_ID = 'sb-batch-friendly-preview';
    const BUTTON_ID = 'sb-batch-friendly-refresh';
    const OUTPUT_ID = 'sb-batch-friendly-output';

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function stripLeadingCount(value) {
        return cleanText(value).replace(/^\d+\s*/, '').trim();
    }

    function readBatchIds() {
        const read = selector => cleanText(document.querySelector(selector)?.textContent || '');
        return {
            project: read('#sa-batch-project'),
            location: read('#sa-batch-location'),
            signType: read('#sa-batch-type'),
            state: read('#sa-batch-state')
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
        return rows.slice(0, 20);
    }

    function resolveFriendlyData() {
        const ids = readBatchIds();
        const state = resolveState(ids.state);
        const projects = projectCandidates(ids.project);

        return {
            version: VERSION,
            ids,
            friendly: {
                project: projects[0]?.text || '',
                location: resolveLocationName(ids.location),
                signType: resolveSignTypeName(ids.signType),
                state: state.display
            },
            stateParts: state,
            projectCandidates: projects
        };
    }

    function renderPreview() {
        const result = resolveFriendlyData();
        const output = document.getElementById(OUTPUT_ID);
        if (!output) return result;

        const row = (label, friendly, id) => {
            const value = friendly || `Not resolved yet (${id || '?'})`;
            const suffix = friendly && id ? ` <span style="color:#888;font-weight:400">[${id}]</span>` : '';
            return `<div style="margin:4px 0"><strong>${label}:</strong> ${escapeHtml(value)}${suffix}</div>`;
        };

        output.innerHTML =
            row('Project', result.friendly.project, result.ids.project) +
            row('Location', result.friendly.location, result.ids.location) +
            row('Sign Type', result.friendly.signType, result.ids.signType) +
            row('State', result.friendly.state, result.ids.state);

        console.group(`${LOG_PREFIX} preview v${VERSION}`);
        console.log('Resolved:', result.friendly);
        console.log('IDs:', result.ids);
        console.log('Project candidates:', result.projectCandidates);
        console.log('COPYABLE JSON:');
        console.log(JSON.stringify(result, null, 2));
        console.groupEnd();

        return result;
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function installUi() {
        const details = document.querySelector('#sa-batch-details');
        if (!details || document.getElementById(WRAPPER_ID)) return false;

        const wrapper = document.createElement('div');
        wrapper.id = WRAPPER_ID;
        Object.assign(wrapper.style, {
            marginTop: '10px',
            paddingTop: '8px',
            borderTop: '1px solid #ddd',
            fontSize: '11px',
            lineHeight: '1.35'
        });

        const title = document.createElement('div');
        title.textContent = `Friendly Names TEST v${VERSION}`;
        title.style.fontWeight = '700';
        title.style.marginBottom = '5px';

        const output = document.createElement('div');
        output.id = OUTPUT_ID;
        output.textContent = 'Reading labels...';

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.textContent = 'Refresh Friendly Preview';
        Object.assign(button.style, {
            width: '100%',
            marginTop: '7px',
            padding: '6px',
            cursor: 'pointer'
        });

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            renderPreview();
        });

        wrapper.appendChild(title);
        wrapper.appendChild(output);
        wrapper.appendChild(button);
        details.appendChild(wrapper);

        renderPreview();
        console.log(`${LOG_PREFIX} v${VERSION} attached. Tyler's Batch Place file remains untouched.`);
        return true;
    }

    if (!installUi()) {
        const observer = new MutationObserver(() => {
            if (installUi()) observer.disconnect();
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(installUi, 1500);
    }
})();
