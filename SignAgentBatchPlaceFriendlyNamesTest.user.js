// ==UserScript==
// @name         SignAgent Batch Friendly Names (TEST)
// @namespace    signbrothers-tools
// @version      0.1.0
// @description  Diagnostic companion for Tyler's Batch Place script. Finds human-readable labels for the IDs Batch Place already knows without changing placement behavior.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.1.0';
    const LOG_PREFIX = '[SB Batch Names]';
    const BUTTON_ID = 'sb-batch-name-scan';
    const OUTPUT_ID = 'sb-batch-name-output';

    function cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isUsefulText(text, id) {
        const cleaned = cleanText(text);
        if (!cleaned) return false;
        if (cleaned === String(id)) return false;
        if (/^\d+$/.test(cleaned)) return false;
        if (cleaned.length > 220) return false;
        return true;
    }

    function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function idAppearsAsToken(value, id) {
        const text = String(value || '');
        const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|\\D)${escaped}(?!\\d)`).test(text);
    }

    function describeElement(el, id, reason) {
        const ownText = cleanText(el.innerText || el.textContent);
        const parentText = cleanText(el.parentElement?.innerText || '');
        const grandparentText = cleanText(el.parentElement?.parentElement?.innerText || '');

        let label = '';
        if (isUsefulText(ownText, id)) label = ownText;
        else if (isUsefulText(parentText, id)) label = parentText;
        else if (isUsefulText(grandparentText, id)) label = grandparentText;

        if (!label) return null;

        const attrs = {};
        for (const attr of Array.from(el.attributes || [])) {
            if (attr.name === 'style') continue;
            if (idAppearsAsToken(attr.value, id)) attrs[attr.name] = attr.value;
        }

        return {
            label,
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: cleanText(el.className || '').slice(0, 160),
            reason,
            visible: isVisible(el),
            matchingAttributes: attrs
        };
    }

    function findCandidates(id) {
        if (!id) return [];

        const found = [];
        const seen = new Set();

        for (const el of document.querySelectorAll('*')) {
            let reason = '';

            for (const attr of Array.from(el.attributes || [])) {
                if (attr.name === 'style') continue;
                if (idAppearsAsToken(attr.value, id)) {
                    reason = `${attr.name} contains ${id}`;
                    break;
                }
            }

            if (!reason) continue;

            const item = describeElement(el, id, reason);
            if (!item) continue;

            const key = `${item.label}|${item.tag}|${item.reason}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push(item);
        }

        found.sort((a, b) => {
            if (a.visible !== b.visible) return a.visible ? -1 : 1;
            return a.label.length - b.label.length;
        });

        return found.slice(0, 15);
    }

    function activeUiText() {
        const selectors = [
            '.active',
            '.selected',
            '.jstree-clicked',
            '.jstree-wholerow-clicked',
            '[aria-selected="true"]'
        ];

        const rows = [];
        const seen = new Set();

        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                const text = cleanText(el.innerText || el.textContent);
                if (!text || text.length > 220) continue;
                const key = `${selector}|${text}`;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push({ selector, text, tag: el.tagName.toLowerCase(), id: el.id || '' });
            }
        }

        return rows.slice(0, 50);
    }

    function readBatchIds() {
        const read = id => cleanText(document.querySelector(id)?.textContent || '');

        return {
            project: read('#sa-batch-project'),
            location: read('#sa-batch-location'),
            signType: read('#sa-batch-type'),
            state: read('#sa-batch-state')
        };
    }

    function runScan() {
        const ids = readBatchIds();

        const result = {
            version: VERSION,
            page: location.pathname + location.search,
            batchIds: ids,
            candidates: {
                project: findCandidates(ids.project),
                location: findCandidates(ids.location),
                signType: findCandidates(ids.signType),
                state: findCandidates(ids.state)
            },
            activeUi: activeUiText()
        };

        console.group(`${LOG_PREFIX} diagnostic v${VERSION}`);
        console.log('Batch IDs:', ids);
        console.log('Project candidates:', result.candidates.project);
        console.log('Location candidates:', result.candidates.location);
        console.log('Sign Type candidates:', result.candidates.signType);
        console.log('State candidates:', result.candidates.state);
        console.log('Active/selected UI text:', result.activeUi);
        console.log('COPYABLE JSON:');
        console.log(JSON.stringify(result, null, 2));
        console.groupEnd();

        const output = document.getElementById(OUTPUT_ID);
        if (output) {
            output.textContent =
                `Scan complete. IDs: P ${ids.project || '?'} | L ${ids.location || '?'} | ` +
                `Type ${ids.signType || '?'} | State ${ids.state || '?'}. ` +
                'Open DevTools Console and copy the JSON under [SB Batch Names].';
        }

        return result;
    }

    function installUi() {
        const details = document.querySelector('#sa-batch-details');
        if (!details || document.getElementById(BUTTON_ID)) return false;

        const wrapper = document.createElement('div');
        wrapper.style.marginTop = '10px';
        wrapper.style.paddingTop = '8px';
        wrapper.style.borderTop = '1px solid #ddd';

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.textContent = 'Scan Friendly Names (TEST)';
        button.style.width = '100%';
        button.style.padding = '6px';
        button.style.cursor = 'pointer';

        const output = document.createElement('div');
        output.id = OUTPUT_ID;
        output.style.marginTop = '5px';
        output.style.fontSize = '10px';
        output.style.lineHeight = '1.35';
        output.style.color = '#666';
        output.textContent = `Diagnostic companion v${VERSION}. No sign data is changed.`;

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            runScan();
        });

        wrapper.appendChild(button);
        wrapper.appendChild(output);
        details.appendChild(wrapper);

        console.log(`${LOG_PREFIX} v${VERSION} attached. Tyler's Batch Place file was not modified.`);
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
