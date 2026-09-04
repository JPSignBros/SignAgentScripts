// ==UserScript==
// @name         SignAgent Step Sequence (TEST)
// @namespace    signbrothers-tools
// @version      0.3.1
// @description  Adds fast {start:step} sequencing plus an editable {seq} mapping tool to SignAgent writable text fields.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.3.1';
    const LOG_PREFIX = '[SB Sequence Tool]';
    const HELPER_CLASS = 'sb-sequence-helper';
    const ACTION_BUTTON_CLASS = 'sb-sequence-action';
    const FORM_BOUND_ATTR = 'data-sb-sequence-bound';
    const FETCH_HEADER = 'XMLHttpRequest';
    const REQUEST_DELAY_MS = 125;
    const WRITABLE_TEXT_SELECTOR =
        'input[type="text"]:not([disabled]):not([readonly]), ' +
        'textarea:not([disabled]):not([readonly])';
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
                    `for all ${formIds.length} selected signs (found ${entries.length}). ` +
                    `No sequence will be applied.`
            };
        }

        return { ok: true, entries, missing: [], message: '' };
    }

    function parseStepSyntax(value) {
        const text = String(value || '').trim();
        const match = text.match(/^\{\s*(-?\d+)\s*:\s*(-?\d+)\s*\}$/);

        if (!match) return null;

        const startToken = match[1];
        const start = Number(startToken);
        const step = Number(match[2]);

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

    function isSeqSyntax(value) {
        return /^\{\s*seq\s*\}$/i.test(String(value || '').trim());
    }

    function hasSequenceSyntax(input) {
        return Boolean(parseStepSyntax(input.value) || isSeqSyntax(input.value));
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

    function parseGenerator(startText, stepText) {
        const cleanStart = String(startText || '').trim();
        const cleanStep = String(stepText || '').trim();
        const start = Number(cleanStart);
        const step = Number(cleanStep);

        if (!/^-?\d+$/.test(cleanStart) || !Number.isSafeInteger(start)) {
            throw new Error('Starting number must be a whole number.');
        }

        if (!/^-?\d+$/.test(cleanStep) || !Number.isSafeInteger(step) || step === 0) {
            throw new Error('Step must be a whole number and cannot be 0.');
        }

        const unsignedStart = cleanStart.replace(/^-/, '');
        const preserveWidth = unsignedStart.length > 1 && unsignedStart.startsWith('0');

        return {
            start,
            step,
            width: preserveWidth ? unsignedStart.length : 0
        };
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

    function sameIdSet(leftIds, rightIds) {
        if (leftIds.length !== rightIds.length) return false;
        const right = new Set(rightIds);
        return leftIds.every(id => right.has(id));
    }

    function getHelper(input) {
        const group = input && input.closest('.form-group');
        if (!group) return null;
        return group.querySelector(`:scope > .${HELPER_CLASS}`);
    }

    function removeHelper(input) {
        const helper = getHelper(input);
        if (helper) helper.remove();
    }

    function createOrGetHelper(input) {
        const group = input.closest('.form-group');
        if (!group) return null;

        let helper = getHelper(input);
        if (helper) return helper;

        helper = document.createElement('div');
        helper.className = HELPER_CLASS;

        Object.assign(helper.style, {
            marginTop: '7px',
            padding: '9px 10px',
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

    function setHelperFeedback(helper, text, tone = 'normal') {
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

        const feedback = helper.querySelector('.sb-sequence-feedback');
        if (feedback) feedback.textContent = text || '';
    }

    function renderError(helper, signature, message) {
        if (helper.dataset.sbSignature === signature) return;

        helper.dataset.sbSignature = signature;
        helper.replaceChildren();

        const feedback = document.createElement('div');
        feedback.className = 'sb-sequence-feedback';
        feedback.textContent = message;
        helper.appendChild(feedback);
        setHelperFeedback(helper, message, 'error');
    }

    function makeActionButton(label, action, primary = true) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
            `${primary ? 'btn btn-xs btn-primary' : 'btn btn-xs btn-default'} ${ACTION_BUTTON_CLASS}`;
        button.dataset.sbAction = action;
        button.textContent = label;
        button.disabled = activeJob;
        return button;
    }

    function renderStepHelper(input, formIds, parsed) {
        const helper = createOrGetHelper(input);
        if (!helper) return;

        if (parsed.error) {
            renderError(helper, `step-error|${input.value}|${formIds.join(',')}`, parsed.error);
            return;
        }

        const order = resolveVisibleSignListOrder(formIds);
        if (!order.ok) {
            renderError(
                helper,
                `step-order-error|${input.value}|${formIds.join(',')}|${order.entries.map(entry => entry.id).join(',')}`,
                order.message
            );
            return;
        }

        let values;
        try {
            values = buildSequence(parsed, order.entries.length);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            renderError(helper, `step-sequence-error|${input.value}|${formIds.join(',')}`, message);
            return;
        }

        const signature = [
            'step-ready',
            input.value,
            formIds.join(','),
            order.entries.map(entry => entry.id).join(','),
            values.join(',')
        ].join('|');

        if (helper.dataset.sbSignature === signature) return;
        helper.dataset.sbSignature = signature;
        helper.replaceChildren();

        const fieldLabel = getFieldLabel(input);

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent =
            `SB step sequence TEST v${VERSION} for ${order.entries.length} signs using visible Sign List order:`;
        helper.appendChild(title);

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
        note.textContent =
            `Updates only "${fieldLabel}". It will refuse to run if the selected-list order changes.`;
        note.style.marginTop = '5px';
        note.style.opacity = '0.8';
        helper.appendChild(note);

        const button = makeActionButton('Apply Sequence', 'apply-step', true);
        button.style.marginTop = '7px';
        helper.appendChild(button);

        const feedback = document.createElement('div');
        feedback.className = 'sb-sequence-feedback';
        feedback.style.marginTop = '5px';
        helper.appendChild(feedback);
    }

    function renderSeqHelper(input, formIds) {
        const helper = createOrGetHelper(input);
        if (!helper) return;

        const order = resolveVisibleSignListOrder(formIds);
        if (!order.ok) {
            renderError(
                helper,
                `seq-order-error|${formIds.join(',')}|${order.entries.map(entry => entry.id).join(',')}`,
                order.message
            );
            return;
        }

        const signature = [
            'seq-ready',
            formIds.join(','),
            order.entries.map(entry => entry.id).join(',')
        ].join('|');

        if (helper.dataset.sbSignature === signature) return;
        helper.dataset.sbSignature = signature;
        helper.replaceChildren();

        const fieldLabel = getFieldLabel(input);

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent =
            `SB sequence editor TEST v${VERSION} - ${order.entries.length} signs in visible Sign List order`;
        helper.appendChild(title);

        const intro = document.createElement('div');
        intro.style.marginTop = '4px';
        intro.textContent =
            'Generate a starting suggestion, then edit any row that needs a jump, skip, reversal, letter, or other exception.';
        helper.appendChild(intro);

        const generator = document.createElement('div');
        Object.assign(generator.style, {
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            alignItems: 'flex-end',
            marginTop: '8px'
        });

        const startWrap = document.createElement('label');
        startWrap.style.margin = '0';
        startWrap.textContent = 'Start';

        const startInput = document.createElement('input');
        startInput.type = 'text';
        startInput.className = 'form-control input-sm sb-seq-start';
        startInput.placeholder = '507';
        Object.assign(startInput.style, {
            width: '90px',
            marginTop: '2px'
        });
        startWrap.appendChild(startInput);
        generator.appendChild(startWrap);

        const stepWrap = document.createElement('label');
        stepWrap.style.margin = '0';
        stepWrap.textContent = 'Step';

        const stepInput = document.createElement('input');
        stepInput.type = 'text';
        stepInput.className = 'form-control input-sm sb-seq-step';
        stepInput.value = '1';
        Object.assign(stepInput.style, {
            width: '70px',
            marginTop: '2px'
        });
        stepWrap.appendChild(stepInput);
        generator.appendChild(stepWrap);

        const fillButton = makeActionButton('Fill Suggestions', 'seq-fill', false);
        fillButton.style.marginBottom = '1px';
        generator.appendChild(fillButton);

        helper.appendChild(generator);

        const list = document.createElement('div');
        Object.assign(list.style, {
            marginTop: '8px',
            maxHeight: '330px',
            overflowY: 'auto',
            border: '1px solid rgba(0,0,0,0.10)',
            borderRadius: '3px',
            background: 'rgba(255,255,255,0.65)'
        });

        order.entries.forEach((entry, index) => {
            const row = document.createElement('div');
            Object.assign(row.style, {
                display: 'grid',
                gridTemplateColumns: 'minmax(90px, 1fr) minmax(110px, 1fr)',
                gap: '8px',
                alignItems: 'center',
                padding: '5px 7px',
                borderTop: index === 0 ? '0' : '1px solid rgba(0,0,0,0.06)'
            });

            const label = document.createElement('div');
            label.textContent = entry.label;
            label.title = `SignAgent ID ${entry.id}`;
            row.appendChild(label);

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.className = 'form-control input-sm sb-seq-value';
            valueInput.dataset.signId = entry.id;
            valueInput.dataset.signLabel = entry.label;
            valueInput.setAttribute('aria-label', `${entry.label} value`);
            row.appendChild(valueInput);

            list.appendChild(row);
        });

        helper.appendChild(list);

        const note = document.createElement('div');
        note.style.marginTop = '6px';
        note.style.opacity = '0.8';
        note.textContent =
            `Every row is editable. All rows need a value before applying. Only "${fieldLabel}" will be changed.`;
        helper.appendChild(note);

        const applyButton = makeActionButton('Apply Mapped Values', 'apply-seq', true);
        applyButton.style.marginTop = '7px';
        helper.appendChild(applyButton);

        const feedback = document.createElement('div');
        feedback.className = 'sb-sequence-feedback';
        feedback.style.marginTop = '5px';
        feedback.textContent = 'Enter a Start value and click Fill Suggestions, then edit any exceptions.';
        helper.appendChild(feedback);
    }

    function renderHelper(input, formIds) {
        if (activeJob) return;

        const parsedStep = parseStepSyntax(input.value);
        if (parsedStep) {
            renderStepHelper(input, formIds, parsedStep);
            return;
        }

        if (isSeqSyntax(input.value)) {
            renderSeqHelper(input, formIds);
            return;
        }

        removeHelper(input);
    }

    function getSourceContext(button) {
        const helper = button.closest(`.${HELPER_CLASS}`);
        const group = helper && helper.closest('.form-group');

        const input = group && Array.from(
            group.querySelectorAll(WRITABLE_TEXT_SELECTOR)
        ).find(candidate => !helper.contains(candidate));

        const form = input && input.closest('#sign_form');

        if (!helper || !input || !form) {
            throw new Error('Could not reconnect this tool to its SignAgent field/form.');
        }

        const formIds = parseMultiEditIds(form);
        if (formIds.length <= 1) {
            throw new Error('This is no longer a multi-sign edit.');
        }

        const order = resolveVisibleSignListOrder(formIds);
        if (!order.ok) {
            throw new Error(order.message);
        }

        return {
            helper,
            input,
            form,
            formIds,
            entries: order.entries.map(entry => ({ ...entry })),
            button
        };
    }

    function getStepApplyContext(button) {
        const base = getSourceContext(button);
        const parsed = parseStepSyntax(base.input.value);

        if (!parsed || parsed.error) {
            throw new Error(parsed && parsed.error ? parsed.error : 'The step syntax is no longer valid.');
        }

        return {
            ...base,
            mode: 'step',
            parsed,
            values: buildSequence(parsed, base.entries.length)
        };
    }

    function getSeqApplyContext(button) {
        const base = getSourceContext(button);

        if (!isSeqSyntax(base.input.value)) {
            throw new Error('The field is no longer in {seq} mode.');
        }

        const mappingInputs = Array.from(base.helper.querySelectorAll('.sb-seq-value'));

        if (mappingInputs.length !== base.entries.length) {
            throw new Error('The mapping editor no longer matches the selected sign count.');
        }

        const values = [];

        for (let index = 0; index < base.entries.length; index += 1) {
            const entry = base.entries[index];
            const mappingInput = mappingInputs[index];

            if (mappingInput.dataset.signId !== entry.id) {
                throw new Error('The mapping editor order no longer matches the Sign List order.');
            }

            const value = mappingInput.value.trim();
            if (!value) {
                throw new Error(`${entry.label} does not have a value yet.`);
            }

            values.push(value);
        }

        return {
            ...base,
            mode: 'seq',
            values
        };
    }

    function fillSeqSuggestions(button) {
        const base = getSourceContext(button);

        if (!isSeqSyntax(base.input.value)) {
            throw new Error('The field is no longer in {seq} mode.');
        }

        const startInput = base.helper.querySelector('.sb-seq-start');
        const stepInput = base.helper.querySelector('.sb-seq-step');
        const mappingInputs = Array.from(base.helper.querySelectorAll('.sb-seq-value'));

        if (!startInput || !stepInput || mappingInputs.length !== base.entries.length) {
            throw new Error('The sequence editor controls are incomplete.');
        }

        const generator = parseGenerator(startInput.value, stepInput.value);
        const values = buildSequence(generator, base.entries.length);

        for (let index = 0; index < mappingInputs.length; index += 1) {
            if (mappingInputs[index].dataset.signId !== base.entries[index].id) {
                throw new Error('The mapping editor order no longer matches the Sign List order.');
            }
            mappingInputs[index].value = values[index];
        }

        setHelperFeedback(
            base.helper,
            `Filled ${values.length} suggestions. Edit any exceptions, then review all rows before applying.`,
            'normal'
        );

        log('Filled editable sequence suggestions.', {
            entries: base.entries,
            values
        });
    }

    function handleActionPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        if (!(event.target instanceof Element)) return;

        const button = event.target.closest(`.${ACTION_BUTTON_CLASS}`);
        if (!button || button.disabled || activeJob) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        activateAction(button);
    }

    function handleActionKeyDown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (!(event.target instanceof Element)) return;

        const button = event.target.closest(`.${ACTION_BUTTON_CLASS}`);
        if (!button || button.disabled || activeJob) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        activateAction(button);
    }

    function activateAction(button) {
        const action = button.dataset.sbAction;

        try {
            if (action === 'seq-fill') {
                fillSeqSuggestions(button);
                return;
            }

            if (action === 'apply-step') {
                void applyMappings(getStepApplyContext(button)).catch(handleUnexpectedError);
                return;
            }

            if (action === 'apply-seq') {
                void applyMappings(getSeqApplyContext(button)).catch(handleUnexpectedError);
                return;
            }
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            alert(`Sequence Tool could not continue. No changes were made.\n\n${message}`);
        }
    }

    function handleUnexpectedError(error) {
        console.error(LOG_PREFIX, error);
        alert(
            `Sequence Tool encountered an unexpected error.\n\n` +
            `${error && error.message ? error.message : String(error)}`
        );
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
            throw new Error(`Field "${fieldName}" was not found on sign ${signId}.`);
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
                '#sign_form .has-error, #sign_form .errorlist, ' +
                '#sign_form .alert-danger, #sign_form .invalid-feedback'
            );

            if (validationError) {
                const message = validationError.textContent.trim().replace(/\s+/g, ' ');
                throw new Error(
                    `Sign ${prepared.signId} was rejected by SignAgent${message ? `: ${message}` : '.'}`
                );
            }
        }
    }

    function verifyFreshSelection(context) {
        const freshForm = document.querySelector('#sign_form');
        const freshFormIds = parseMultiEditIds(freshForm);
        const freshOrder = resolveVisibleSignListOrder(freshFormIds);

        if (
            !freshOrder.ok ||
            !sameIdSet(context.formIds, freshFormIds) ||
            !sameOrder(context.entries, freshOrder.entries)
        ) {
            throw new Error(
                'The selected signs or their Sign List order changed after the preview/editor was created.'
            );
        }
    }

    function confirmMappings(context) {
        const fieldLabel = getFieldLabel(context.input);
        const first = context.values[0];
        const last = context.values[context.values.length - 1];
        const firstLabel = context.entries[0].label;
        const lastLabel = context.entries[context.entries.length - 1].label;

        if (context.mode === 'step') {
            const direction = context.parsed.step > 0 ? `+${context.parsed.step}` : String(context.parsed.step);

            return window.confirm(
                `Apply stepped sequence to ${context.entries.length} selected signs?\n\n` +
                `Field: ${fieldLabel}\n` +
                `Sequence: ${first} -> ${last} (${direction} each sign)\n` +
                `First: ${firstLabel} -> ${first}\n` +
                `Last: ${lastLabel} -> ${last}\n\n` +
                `Order source: SignAgent's visible Sign List.\n` +
                `Only this field will be changed.`
            );
        }

        return window.confirm(
            `Apply ${context.entries.length} mapped values?\n\n` +
            `Field: ${fieldLabel}\n` +
            `First: ${firstLabel} -> ${first}\n` +
            `Last: ${lastLabel} -> ${last}\n\n` +
            `You are applying the editable mapping shown in the {seq} editor.\n` +
            `Order source: SignAgent's visible Sign List.\n` +
            `Only this field will be changed.`
        );
    }

    async function applyMappings(context) {
        if (activeJob) return;

        const fieldName = context.input.name;
        if (!fieldName) {
            alert('Sequence Tool could not identify this field.');
            return;
        }

        try {
            verifyFreshSelection(context);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            alert(`${message}\n\nNo changes were made. Review the current selection and try again.`);
            return;
        }

        if (!confirmMappings(context)) return;

        activeJob = true;
        context.button.disabled = true;
        const originalButtonText = context.button.textContent;
        context.button.textContent = 'Working...';

        try {
            setHelperFeedback(
                context.helper,
                `Preflighting ${context.entries.length} signs...`,
                'working'
            );

            const prepared = [];

            for (let index = 0; index < context.entries.length; index += 1) {
                const entry = context.entries[index];

                setHelperFeedback(
                    context.helper,
                    `Preflighting ${index + 1} of ${context.entries.length}: ` +
                    `${entry.label} -> ${context.values[index]}`,
                    'working'
                );

                prepared.push(
                    await preflightSign(entry.id, fieldName, context.values[index])
                );
            }

            setHelperFeedback(
                context.helper,
                `Preflight passed. Updating ${context.entries.length} signs...`,
                'working'
            );

            let completed = 0;

            for (let index = 0; index < prepared.length; index += 1) {
                const item = prepared[index];
                const entry = context.entries[index];

                setHelperFeedback(
                    context.helper,
                    `Saving ${index + 1} of ${prepared.length}: ${entry.label} -> ${item.nextValue}`,
                    'working'
                );

                try {
                    await postPreparedSign(item);
                    completed += 1;
                } catch (error) {
                    const message = error && error.message ? error.message : String(error);

                    setHelperFeedback(
                        context.helper,
                        `Stopped after ${completed} of ${prepared.length}. ${message}`,
                        'error'
                    );

                    alert(
                        `Sequence Tool stopped after updating ${completed} of ${prepared.length} signs.\n\n` +
                        `${message}\n\nReload SignAgent and inspect the completed signs before trying again.`
                    );
                    return;
                }

                if (index < prepared.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            setHelperFeedback(
                context.helper,
                `Done - updated ${completed} signs. Reloading...`,
                'success'
            );

            log(
                `Updated ${completed} signs in field ${fieldName} using visible Sign List order:`,
                context.entries.map((entry, index) => ({
                    id: entry.id,
                    label: entry.label,
                    value: context.values[index]
                }))
            );

            setTimeout(() => location.reload(), 500);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setHelperFeedback(context.helper, `No changes made. ${message}`, 'error');
            alert(`Sequence Tool did not start. No changes were made.\n\n${message}`);
        } finally {
            activeJob = false;
            context.button.disabled = false;
            context.button.textContent = originalButtonText;
        }
    }

    function hasExtendedSyntax(form) {
        return Array.from(
            form.querySelectorAll(WRITABLE_TEXT_SELECTOR)
        ).some(input => !input.closest(`.${HELPER_CLASS}`) && hasSequenceSyntax(input));
    }

    function renderExtendedInputs(form) {
        if (activeJob) return;

        const formIds = parseMultiEditIds(form);
        if (formIds.length <= 1) return;

        form.querySelectorAll(WRITABLE_TEXT_SELECTOR)
            .forEach(input => {
                if (input.closest(`.${HELPER_CLASS}`)) return;
                if (hasSequenceSyntax(input)) {
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
            const isTextInput = input instanceof HTMLInputElement && input.type === 'text';
            const isTextarea = input instanceof HTMLTextAreaElement;

            if (!isTextInput && !isTextarea) return;
            if (input.disabled || input.readOnly) return;
            if (input.closest(`.${HELPER_CLASS}`)) return;

            renderHelper(input, parseMultiEditIds(form));
        }

        form.addEventListener('input', event => updateInput(event.target), true);
        form.addEventListener('change', event => updateInput(event.target), true);

        form.addEventListener('submit', function (event) {
            if (!hasExtendedSyntax(form)) return;

            event.preventDefault();
            event.stopImmediatePropagation();

            alert(
                'Sign Brothers sequence syntax detected.\n\n' +
                'Use the Sign Brothers Apply button shown under the field instead of the normal SignAgent Save button. ' +
                'This prevents SignAgent from receiving {start:step} or {seq} directly.'
            );
        }, true);

        form.querySelectorAll(WRITABLE_TEXT_SELECTOR)
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
        document.addEventListener('pointerdown', handleActionPointerDown, true);
        document.addEventListener('keydown', handleActionKeyDown, true);

        scheduleScan();

        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        setInterval(scheduleScan, 1500);
        log(
            `SignAgent Sequence Tool v${VERSION} TEST loaded. ` +
            'Syntax: {start:step} for fast sequences or {seq} for editable mappings.'
        );
    }

    init();
})();