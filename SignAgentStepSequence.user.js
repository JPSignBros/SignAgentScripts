// ==UserScript==
// @name         SignAgent Step Sequence (TEST)
// @namespace    signbrothers-tools
// @version      0.2.0
// @description  Adds explicit stepped sequences such as {209:2} to SignAgent multi-edit text fields using visible Sign List order.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[SB Step Sequence]';
    const HELPER_CLASS = 'sb-step-sequence-helper';
    const FORM_BOUND_ATTR = 'data-sb-step-sequence-bound';
    const FETCH_HEADER = 'XMLHttpRequest';
    const REQUEST_DELAY_MS = 125;
    const SELECTED_SIGN_SELECTOR =
        '#sign_list_container_small a.sign_link.active, ' +
        '#sign_list_container_small a.sign_link.selected';

    let activeJob = false;
    let scanQueued = false;

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function parseMultiEditIds(form) {
        if (!form) return [];

        let action;
        try {
            action = new URL(form.getAttribute('action') || '', location.href);
        } catch (error) {
            return [];
        }

        const match = action.pathname.match(/^\/sign\/([0-9,]+)\/edit\/?$/);
        if (!match) return [];

        return match[1]
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
    }

    function getSignIdFromLink(link) {
        if (!link) return '';

        const datasetId = link.dataset && link.dataset.sign_id;
        if (datasetId) return String(datasetId);

        const href = link.getAttribute('href') || '';
        const match = href.match(/\/sign\/(\d+)(?:\/|$)/);
        return match ? match[1] : '';
    }

    function resolveVisibleSignListOrder(formIds) {
        const allowed = new Set(formIds);
        const seen = new Set();
        const entries = [];

        document.querySelectorAll(SELECTED_SIGN_SELECTOR).forEach(link => {
            const id = getSignIdFromLink(link);
            if (!id || !allowed.has(id) || seen.has(id)) return;

            seen.add(id);
            entries.push({
                id,
                label: link.textContent.trim().replace(/\s+/g, ' ') || `Sign ${id}`
            });
        });

        const missing = formIds.filter(id => !seen.has(id));

        if (entries.length !== formIds.length || missing.length) {
            return {
                ok: false,
                entries,
                missing,
                message:
                    `Could not safely determine SignAgent's visible Sign List order ` +
                    `for all ${formIds.length} selected signs ` +
                    `(found ${entries.length}). No sequence will be applied.`
            };
        }

        return {
            ok: true,
            entries,
            missing: [],
            message: ''
        };
    }

    function parseStepSyntax(value) {
        const text = String(value || '').trim();
        const match = text.match(/^\{\s*(-?\d+)\s*:\s*(-?\d+)\s*\}$/);

        if (!match) return null;

        const startToken = match[1];
        const step = Number(match[2]);
        const start = Number(startToken);

        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step) || step === 0) {
            return { error: 'Start and step must be whole numbers, and step cannot be 0.' };
        }

        const unsignedStart = startToken.replace(/^-/, '');
        const preserveWidth = unsignedStart.length > 1 && unsignedStart.startsWith('0');

        return {
            start,
            step,
            width: preserveWidth ? unsignedStart.length : 0,
            raw: text
        };
    }

    function formatSequenceValue(value, width) {
        if (!width) return String(value);

        const negative = value < 0;
        const digits = String(Math.abs(value)).padStart(width, '0');
        return negative ? `-${digits}` : digits;
    }

    function buildSequence(sequence, count) {
        const values = [];

        for (let index = 0; index < count; index += 1) {
            const value = sequence.start + (sequence.step * index);

            if (!Number.isSafeInteger(value)) {
                throw new Error('Sequence exceeds JavaScript safe integer limits.');
            }

            values.push(formatSequenceValue(value, sequence.width));
        }

        return values;
    }

    function getFieldLabel(input) {
        if (!input) return 'Field';

        if (input.id) {
            const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
            if (label && label.textContent.trim()) return label.textContent.trim();
        }

        return input.name || input.id || 'Field';
    }

    function makeMappingPreview(entries, values) {
        const lines = entries.map((entry, index) => `${entry.label}  ->  ${values[index]}`);
        if (lines.length <= 12) return lines.join('\n');

        return [
            ...lines.slice(0, 8),
            '...',
            ...lines.slice(-3)
        ].join('\n');
    }

    function sameOrder(leftEntries, rightEntries) {
        if (leftEntries.length !== rightEntries.length) return false;

        return leftEntries.every((entry, index) => entry.id === rightEntries[index].id);
    }

    function removeHelper(input) {
        const group = input && input.closest('.form-group');
        if (!group) return;

        const helper = group.querySelector(`:scope > .${HELPER_CLASS}`);
        if (helper) helper.remove();
    }

    function createOrGetHelper(input) {
        const group = input.closest('.form-group');
        if (!group) return null;

        let helper = group.querySelector(`:scope > .${HELPER_CLASS}`);
        if (helper) return helper;

        helper = document.createElement('div');
        helper.className = HELPER_CLASS;

        Object.assign(helper.style, {
            marginTop: '7px',
            padding: '8px 10px',
            border: '1px solid #b8c7d9',
            borderRadius: '4px',
            background: '#f4f8fc',
            color: '#334155',
            fontSize: '12px',
            lineHeight: '1.4'
        });

        group.appendChild(helper);
        return helper;
    }

    function setHelperStatus(helper, text, tone = 'normal') {
        if (!helper) return;

        const colors = {
            normal: ['#f4f8fc', '#334155', '#b8c7d9'],
            working: ['#fff8e1', '#6b5200', '#e5c85c'],
            error: ['#fff1f2', '#8a1c2c', '#e2a3ad'],
            success: ['#eefbf3', '#17603a', '#94d3ac']
        };

        const [background, color, borderColor] = colors[tone] || colors.normal;
        helper.style.background = background;
        helper.style.color = color;
        helper.style.borderColor = borderColor;

        const status = helper.querySelector('.sb-step-status');
        if (status) status.textContent = text;
    }

    function renderHelper(input, formIds) {
        const parsed = parseStepSyntax(input.value);

        if (!parsed) {
            removeHelper(input);
            return;
        }

        const helper = createOrGetHelper(input);
        if (!helper) return;

        helper.replaceChildren();

        if (parsed.error) {
            const error = document.createElement('div');
            error.className = 'sb-step-status';
            error.textContent = parsed.error;
            helper.appendChild(error);
            setHelperStatus(helper, parsed.error, 'error');
            return;
        }

        const order = resolveVisibleSignListOrder(formIds);
        if (!order.ok) {
            const error = document.createElement('div');
            error.className = 'sb-step-status';
            error.textContent = order.message;
            helper.appendChild(error);
            setHelperStatus(helper, order.message, 'error');

            const detail = document.createElement('div');
            detail.style.marginTop = '4px';
            detail.style.opacity = '0.8';
            detail.textContent = 'Safety stop: this test version will not fall back to the scrambled multi-edit form order.';
            helper.appendChild(detail);
            return;
        }

        let values;
        try {
            values = buildSequence(parsed, order.entries.length);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            const errorNode = document.createElement('div');
            errorNode.className = 'sb-step-status';
            errorNode.textContent = message;
            helper.appendChild(errorNode);
            setHelperStatus(helper, message, 'error');
            return;
        }

        const fieldLabel = getFieldLabel(input);

        const status = document.createElement('div');
        status.className = 'sb-step-status';
        status.textContent = `SB sequence for ${order.entries.length} signs using visible Sign List order:`;
        helper.appendChild(status);

        const preview = document.createElement('pre');
        preview.textContent = makeMappingPreview(order.entries, values);
        Object.assign(preview.style, {
            margin: '6px 0 0',
            padding: '6px 8px',
            maxHeight: '220px',
            overflow: 'auto',
            background: 'rgba(255,255,255,0.65)',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: '3px',
            fontSize: '11px',
            lineHeight: '1.35'
        });
        helper.appendChild(preview);

        const note = document.createElement('div');
        note.textContent = `Updates only “${fieldLabel}”. It will refuse to run if the selected-list order changes.`;
        note.style.marginTop = '5px';
        note.style.opacity = '0.8';
        helper.appendChild(note);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-xs btn-primary';
        button.textContent = 'Apply Sequence';
        button.style.marginTop = '7px';
        button.disabled = activeJob;
        helper.appendChild(button);

        button.addEventListener('click', function () {
            applySequence(
                input,
                formIds,
                order.entries,
                parsed,
                values,
                helper,
                button
            ).catch(error => console.error(LOG_PREFIX, error));
        });
    }

    async function fetchText(url, useAjaxHeader) {
        const headers = {
            'Accept': 'text/html,application/xhtml+xml'
        };

        if (useAjaxHeader) headers['X-Requested-With'] = FETCH_HEADER;

        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            headers
        });

        if (!response.ok) {
            throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
        }

        return response.text();
    }

    async function getSingleSignForm(signId) {
        const url = `/sign/${encodeURIComponent(signId)}/edit/`;
        let html = await fetchText(url, true);
        let doc = new DOMParser().parseFromString(html, 'text/html');
        let form = doc.querySelector('#sign_form');

        if (!form) {
            html = await fetchText(url, false);
            doc = new DOMParser().parseFromString(html, 'text/html');
            form = doc.querySelector('#sign_form');
        }

        if (!form) {
            throw new Error(`Could not find the edit form for sign ${signId}.`);
        }

        return form;
    }

    async function preflightSign(signId, fieldName, nextValue) {
        const form = await getSingleSignForm(signId);
        const field = form.elements.namedItem(fieldName);

        if (!field || field instanceof RadioNodeList) {
            throw new Error(`Field “${fieldName}” was not found on sign ${signId}.`);
        }

        const formData = new FormData(form);
        formData.set(fieldName, nextValue);

        const action = form.getAttribute('action');
        if (!action) {
            throw new Error(`Sign ${signId} edit form has no action URL.`);
        }

        const actionUrl = new URL(action, location.origin).href;
        const csrf = formData.get('csrfmiddlewaretoken');

        return {
            signId,
            nextValue,
            actionUrl,
            formData,
            csrf: typeof csrf === 'string' ? csrf : ''
        };
    }

    async function postPreparedSign(prepared) {
        const headers = {
            'X-Requested-With': FETCH_HEADER,
            'Accept': 'text/html,application/xhtml+xml,application/json'
        };

        if (prepared.csrf) headers['X-CSRFToken'] = prepared.csrf;

        const response = await fetch(prepared.actionUrl, {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: prepared.formData,
            redirect: 'follow'
        });

        const responseText = await response.text();

        if (!response.ok) {
            throw new Error(`Sign ${prepared.signId} returned HTTP ${response.status}.`);
        }

        if (responseText) {
            const doc = new DOMParser().parseFromString(responseText, 'text/html');
            const validationError = doc.querySelector(
                '#sign_form .has-error, #sign_form .errorlist, #sign_form .alert-danger, #sign_form .invalid-feedback'
            );

            if (validationError) {
                const message = validationError.textContent.trim().replace(/\s+/g, ' ');
                throw new Error(`Sign ${prepared.signId} was rejected by SignAgent${message ? `: ${message}` : '.'}`);
            }
        }
    }

    async function applySequence(input, formIds, expectedEntries, parsed, values, helper, button) {
        if (activeJob) return;

        const fieldName = input.name;
        const fieldLabel = getFieldLabel(input);

        if (!fieldName) {
            alert('Sign Brothers Step Sequence could not identify this field.');
            return;
        }

        const freshForm = document.querySelector('#sign_form');
        const freshFormIds = parseMultiEditIds(freshForm);
        const freshOrder = resolveVisibleSignListOrder(freshFormIds);

        if (
            !freshOrder.ok ||
            freshFormIds.length !== formIds.length ||
            !sameOrder(expectedEntries, freshOrder.entries)
        ) {
            renderHelper(input, freshFormIds);
            alert(
                'The selected signs or their Sign List order changed after the preview was created.\n\n' +
                'No changes were made. Review the refreshed preview and click Apply Sequence again.'
            );
            return;
        }

        const first = values[0];
        const last = values[values.length - 1];
        const direction = parsed.step > 0 ? `+${parsed.step}` : String(parsed.step);
        const firstLabel = expectedEntries[0].label;
        const lastLabel = expectedEntries[expectedEntries.length - 1].label;

        const confirmed = window.confirm(
            `Apply stepped sequence to ${expectedEntries.length} selected signs?\n\n` +
            `Field: ${fieldLabel}\n` +
            `Sequence: ${first} -> ${last} (${direction} each sign)\n` +
            `First: ${firstLabel} -> ${first}\n` +
            `Last: ${lastLabel} -> ${last}\n\n` +
            `Order source: SignAgent's visible Sign List.\n` +
            `Only this field will be changed.`
        );

        if (!confirmed) return;

        activeJob = true;
        button.disabled = true;

        try {
            setHelperStatus(helper, `Preflighting ${expectedEntries.length} signs...`, 'working');

            const prepared = [];
            for (let index = 0; index < expectedEntries.length; index += 1) {
                const entry = expectedEntries[index];

                setHelperStatus(
                    helper,
                    `Preflighting ${index + 1} of ${expectedEntries.length}: ${entry.label} -> ${values[index]}`,
                    'working'
                );

                prepared.push(
                    await preflightSign(entry.id, fieldName, values[index])
                );
            }

            setHelperStatus(helper, `Preflight passed. Updating ${expectedEntries.length} signs...`, 'working');

            let completed = 0;

            for (let index = 0; index < prepared.length; index += 1) {
                const item = prepared[index];
                const entry = expectedEntries[index];

                setHelperStatus(
                    helper,
                    `Saving ${index + 1} of ${prepared.length}: ${entry.label} -> ${item.nextValue}`,
                    'working'
                );

                try {
                    await postPreparedSign(item);
                    completed += 1;
                } catch (error) {
                    const message = error && error.message ? error.message : String(error);
                    setHelperStatus(
                        helper,
                        `Stopped after ${completed} of ${prepared.length}. ${message}`,
                        'error'
                    );

                    alert(
                        `Step Sequence stopped after updating ${completed} of ${prepared.length} signs.\n\n` +
                        `${message}\n\nReload SignAgent and inspect the completed signs before trying again.`
                    );
                    return;
                }

                if (index < prepared.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            setHelperStatus(
                helper,
                `Done - updated ${completed} signs. Reloading...`,
                'success'
            );

            log(
                `Updated ${completed} signs in field ${fieldName} using visible Sign List order:`,
                expectedEntries.map((entry, index) => ({
                    id: entry.id,
                    label: entry.label,
                    value: values[index]
                }))
            );

            setTimeout(() => location.reload(), 500);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setHelperStatus(helper, `No changes made. ${message}`, 'error');
            alert(`Step Sequence did not start. No changes were made.\n\n${message}`);
        } finally {
            activeJob = false;
            button.disabled = false;
        }
    }

    function hasExtendedSyntax(form) {
        return Array.from(form.querySelectorAll('input[type="text"]:not([disabled]):not([readonly])'))
            .some(input => {
                const parsed = parseStepSyntax(input.value);
                return parsed && !parsed.error;
            });
    }

    function renderExtendedInputs(form) {
        const formIds = parseMultiEditIds(form);
        if (formIds.length <= 1) return;

        form.querySelectorAll('input[type="text"]:not([disabled]):not([readonly])')
            .forEach(input => {
                if (parseStepSyntax(input.value)) {
                    renderHelper(input, formIds);
                }
            });
    }

    function bindForm(form) {
        if (form.getAttribute(FORM_BOUND_ATTR) === '1') {
            renderExtendedInputs(form);
            return;
        }

        form.setAttribute(FORM_BOUND_ATTR, '1');

        function updateInput(input) {
            if (!(input instanceof HTMLInputElement)) return;
            if (input.type !== 'text' || input.disabled || input.readOnly) return;

            renderHelper(input, parseMultiEditIds(form));
        }

        form.addEventListener('input', event => updateInput(event.target), true);
        form.addEventListener('change', event => updateInput(event.target), true);

        form.addEventListener('submit', function (event) {
            if (!hasExtendedSyntax(form)) return;

            event.preventDefault();
            event.stopImmediatePropagation();

            alert(
                'Sign Brothers step syntax detected.\n\n' +
                'Use the “Apply Sequence” button shown under the field instead of the normal SignAgent Save button. ' +
                'This prevents SignAgent from receiving the custom {start:step} syntax directly.'
            );
        }, true);

        form.querySelectorAll('input[type="text"]:not([disabled]):not([readonly])')
            .forEach(updateInput);

        log(`Multi-edit detected for ${parseMultiEditIds(form).length} signs.`);
    }

    function scan() {
        scanQueued = false;

        const form = document.querySelector('#sign_form');
        const ids = parseMultiEditIds(form);

        if (form && ids.length > 1) {
            bindForm(form);
        }
    }

    function scheduleScan() {
        if (scanQueued) return;
        scanQueued = true;
        requestAnimationFrame(scan);
    }

    function init() {
        scheduleScan();

        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        setInterval(scheduleScan, 1500);
        log('SignAgent Step Sequence v0.2.0 TEST loaded. Syntax: {start:step}');
    }

    init();
})();
