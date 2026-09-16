// ==UserScript==
// @name         SignAgent Step Sequence (TEST)
// @namespace    signbrothers-tools
// @version      0.3.5
// @description  Adds fast {start:step}, editable {seq}, and vertical {seqv} sequencing to SignAgent writable text fields.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.3.5';
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

    function getWindowSignIds() {
        if (typeof window.sign_ids !== 'string') return [];

        return window.sign_ids
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
    }

    function getMapSelectedEntries() {
        const selected = window.map_js_obj && window.map_js_obj.selected_signs;
        if (!Array.isArray(selected)) return [];

        return selected
            .map(item => {
                if (!Array.isArray(item) || item.length < 2) return null;

                const id = String(item[0] == null ? '' : item[0]).trim();
                const positionId = String(item[1] == null ? '' : item[1]).trim();
                if (!id || !positionId) return null;

                return { id, positionId };
            })
            .filter(Boolean);
    }

    function hasUniqueIds(ids) {
        return new Set(ids).size === ids.length;
    }

    function sameIdOrder(leftIds, rightIds) {
        if (leftIds.length !== rightIds.length) return false;
        return leftIds.every((id, index) => id === rightIds[index]);
    }

    function getMapMarkerLabel(positionId, signId) {
        const marker = document.getElementById(`position_${positionId}`);
        if (!marker) return `Sign ${signId}`;

        const textNode = Array.from(marker.querySelectorAll('text'))
            .map(node => node.textContent.trim().replace(/\s+/g, ' '))
            .find(Boolean);

        if (textNode) return textNode;

        const fallback = marker.textContent.trim().replace(/\s+/g, ' ');
        return fallback || `Sign ${signId}`;
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
        const visibleComplete = entries.length === formIds.length && missing.length === 0;
        const pageIds = getWindowSignIds();

        if (visibleComplete) {
            const visibleIds = entries.map(entry => entry.id);

            if (
                pageIds.length &&
                !(
                    pageIds.length === formIds.length &&
                    hasUniqueIds(pageIds) &&
                    sameIdSet(formIds, pageIds) &&
                    sameIdOrder(visibleIds, pageIds)
                )
            ) {
                log(
                    'Visible Sign List fully accounts for the selection; ignoring disagreeing page selection state.',
                    { formIds, visibleIds, pageIds }
                );
            }

            return {
                ok: true,
                entries,
                missing: [],
                source: 'visible-sign-list',
                sourceLabel: `SignAgent's visible Sign List`,
                message: ''
            };
        }

        const mapSelected = getMapSelectedEntries();
        const mapEntriesForSelection = mapSelected.filter(entry => allowed.has(entry.id));
        const mapIdsForSelection = mapEntriesForSelection.map(entry => entry.id);
        const mapOrderComplete =
            mapIdsForSelection.length === formIds.length &&
            hasUniqueIds(mapIdsForSelection) &&
            sameIdSet(formIds, mapIdsForSelection);

        if (mapOrderComplete) {
            if (mapSelected.length !== mapEntriesForSelection.length) {
                log(
                    'Using current form IDs to filter stale/extra floorplan map entries.',
                    {
                        formIds,
                        mapCatalogCount: mapSelected.length,
                        matchedCount: mapEntriesForSelection.length
                    }
                );
            }

            const pageStateComplete =
                pageIds.length === formIds.length &&
                hasUniqueIds(pageIds) &&
                sameIdSet(formIds, pageIds);

            if (pageStateComplete && !sameIdOrder(mapIdsForSelection, pageIds)) {
                log(
                    'Using floorplan map order; ignoring disagreeing SignAgent selection-order state.',
                    { formIds, mapIdsForSelection, pageIds }
                );
            }

            const floorplanEntries = mapEntriesForSelection.map(entry => ({
                id: entry.id,
                label: getMapMarkerLabel(entry.positionId, entry.id)
            }));

            return {
                ok: true,
                entries: floorplanEntries,
                missing: [],
                source: 'floorplan-map-order',
                sourceLabel: `SignAgent's floorplan map order`,
                message: ''
            };
        }

        return {
            ok: false,
            entries,
            missing,
            source: 'none',
            sourceLabel: '',
            message:
                `Could not safely determine a trusted SignAgent order for all ` +
                `${formIds.length} selected signs (visible Sign List found ${entries.length}, ` +
                `and floorplan map order accounted for ${mapIdsForSelection.length}). ` +
                `No sequence will be applied.`
        };
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

    function isSeqvSyntax(value) {
        return /^\{\s*seqv\s*\}$/i.test(String(value || '').trim());
    }

    function hasSequenceSyntax(input) {
        return Boolean(
            parseStepSyntax(input.value) ||
            isSeqSyntax(input.value) ||
            isSeqvSyntax(input.value)
        );
    }

    function verticalizeValue(value) {
        return Array.from(String(value || '').trim()).join('\n');
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
            order.source,
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
            `SB step sequence TEST v${VERSION} for ${order.entries.length} signs using ${order.sourceLabel}:`;
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
            `Updates only "${fieldLabel}". It will refuse to run if the trusted selected-sign order changes.`;
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

    function renderSeqHelper(input, formIds, vertical = false) {
        const helper = createOrGetHelper(input);
        if (!helper) return;

        const order = resolveVisibleSignListOrder(formIds);
        if (!order.ok) {
            renderError(
                helper,
                `${vertical ? 'seqv' : 'seq'}-order-error|${formIds.join(',')}|${order.entries.map(entry => entry.id).join(',')}`,
                order.message
            );
            return;
        }

        const signature = [
            vertical ? 'seqv-ready' : 'seq-ready',
            formIds.join(','),
            order.source,
            order.entries.map(entry => entry.id).join(',')
        ].join('|');

        if (helper.dataset.sbSignature === signature) return;
        helper.dataset.sbSignature = signature;
        helper.replaceChildren();

        const fieldLabel = getFieldLabel(input);

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent = vertical
            ? `SB vertical sequence editor TEST v${VERSION} - ${order.entries.length} signs in ${order.sourceLabel}`
            : `SB sequence editor TEST v${VERSION} - ${order.entries.length} signs in ${order.sourceLabel}`;
        helper.appendChild(title);

        const intro = document.createElement('div');
        intro.style.marginTop = '4px';
        intro.textContent = vertical
            ? 'Generate and edit normal logical values. The exact multiline value SignAgent will receive is previewed under each row.'
            : 'Generate a starting suggestion, then edit any row that needs a jump, skip, reversal, letter, or other exception.';
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
        startInput.placeholder = vertical ? '2201' : '507';
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
                alignItems: 'start',
                padding: '5px 7px',
                borderTop: index === 0 ? '0' : '1px solid rgba(0,0,0,0.06)'
            });

            const label = document.createElement('div');
            label.textContent = entry.label;
            label.title = `SignAgent ID ${entry.id}`;
            row.appendChild(label);

            const valueWrap = document.createElement('div');

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.className = 'form-control input-sm sb-seq-value';
            valueInput.dataset.signId = entry.id;
            valueInput.dataset.signLabel = entry.label;
            valueInput.setAttribute('aria-label', `${entry.label} value`);
            valueWrap.appendChild(valueInput);

            if (vertical) {
                const exactPreview = document.createElement('pre');
                exactPreview.className = 'sb-seqv-exact';
                exactPreview.dataset.signId = entry.id;
                Object.assign(exactPreview.style, {
                    margin: '4px 0 0',
                    padding: '5px 7px',
                    minHeight: '28px',
                    maxHeight: '100px',
                    overflow: 'auto',
                    background: 'rgba(255,255,255,0.75)',
                    border: '1px solid rgba(0,0,0,0.08)',
                    borderRadius: '3px',
                    fontSize: '11px',
                    lineHeight: '1.25',
                    whiteSpace: 'pre-wrap'
                });

                const updateExactPreview = () => {
                    const logicalValue = valueInput.value.trim();
                    exactPreview.textContent = logicalValue
                        ? verticalizeValue(logicalValue)
                        : '';
                };

                valueInput.addEventListener('input', updateExactPreview);
                valueWrap.appendChild(exactPreview);
            }

            row.appendChild(valueWrap);
            list.appendChild(row);
        });

        helper.appendChild(list);

        const note = document.createElement('div');
        note.style.marginTop = '6px';
        note.style.opacity = '0.8';
        note.textContent = vertical
            ? `Every row is editable. All rows need a value before applying. Only "${fieldLabel}" will be changed, using the exact multiline previews shown above.`
            : `Every row is editable. All rows need a value before applying. Only "${fieldLabel}" will be changed.`;
        helper.appendChild(note);

        const applyButton = makeActionButton(
            vertical ? 'Apply Vertical Mapped Values' : 'Apply Mapped Values',
            vertical ? 'apply-seqv' : 'apply-seq',
            true
        );
        applyButton.style.marginTop = '7px';
        helper.appendChild(applyButton);

        const feedback = document.createElement('div');
        feedback.className = 'sb-sequence-feedback';
        feedback.style.marginTop = '5px';
        feedback.textContent = vertical
            ? 'Enter a Start value and click Fill Suggestions, then review both the logical values and exact multiline previews.'
            : 'Enter a Start value and click Fill Suggestions, then edit any exceptions.';
        helper.appendChild(feedback);
    }

    function renderHelper(input, formIds) {
        if (activeJob) return;

        const parsedStep = parseStepSyntax(input.value);
        if (parsedStep) {
            renderStepHelper(input, formIds, parsedStep);
            return;
        }

        if (isSeqvSyntax(input.value)) {
            renderSeqHelper(input, formIds, true);
            return;
        }

        if (isSeqSyntax(input.value)) {
            renderSeqHelper(input, formIds, false);
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
            orderSource: order.source,
            orderSourceLabel: order.sourceLabel,
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

    function getSeqApplyContext(button, vertical = false) {
        const base = getSourceContext(button);
        const syntaxMatches = vertical
            ? isSeqvSyntax(base.input.value)
            : isSeqSyntax(base.input.value);

        if (!syntaxMatches) {
            throw new Error(
                `The field is no longer in {${vertical ? 'seqv' : 'seq'}} mode.`
            );
        }

        const mappingInputs = Array.from(base.helper.querySelectorAll('.sb-seq-value'));

        if (mappingInputs.length !== base.entries.length) {
            throw new Error('The mapping editor no longer matches the selected sign count.');
        }

        const logicalValues = [];
        const values = [];

        for (let index = 0; index < base.entries.length; index += 1) {
            const entry = base.entries[index];
            const mappingInput = mappingInputs[index];

            if (mappingInput.dataset.signId !== entry.id) {
                throw new Error('The mapping editor order no longer matches the trusted selected-sign order.');
            }

            const logicalValue = mappingInput.value.trim();
            if (!logicalValue) {
                throw new Error(`${entry.label} does not have a value yet.`);
            }

            logicalValues.push(logicalValue);
            values.push(vertical ? verticalizeValue(logicalValue) : logicalValue);
        }

        return {
            ...base,
            mode: vertical ? 'seqv' : 'seq',
            logicalValues,
            values
        };
    }

    function fillSeqSuggestions(button) {
        const base = getSourceContext(button);
        const vertical = isSeqvSyntax(base.input.value);

        if (!vertical && !isSeqSyntax(base.input.value)) {
            throw new Error('The field is no longer in {seq} or {seqv} mode.');
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
                throw new Error('The mapping editor order no longer matches the trusted selected-sign order.');
            }

            mappingInputs[index].value = values[index];

            if (vertical) {
                const exactPreview = base.helper.querySelector(
                    `.sb-seqv-exact[data-sign-id="${CSS.escape(base.entries[index].id)}"]`
                );
                if (exactPreview) {
                    exactPreview.textContent = verticalizeValue(values[index]);
                }
            }
        }

        setHelperFeedback(
            base.helper,
            vertical
                ? `Filled ${values.length} suggestions. Edit any exceptions, then review the exact multiline previews before applying.`
                : `Filled ${values.length} suggestions. Edit any exceptions, then review all rows before applying.`,
            'normal'
        );

        log(vertical ? 'Filled editable vertical sequence suggestions.' : 'Filled editable sequence suggestions.', {
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
                void applyMappings(getSeqApplyContext(button, false)).catch(handleUnexpectedError);
                return;
            }

            if (action === 'apply-seqv') {
                void applyMappings(getSeqApplyContext(button, true)).catch(handleUnexpectedError);
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
            !sameOrder(context.entries, freshOrder.entries) ||
            context.orderSource !== freshOrder.source
        ) {
            throw new Error(
                'The selected signs, trusted order, or order source changed after the preview/editor was created.'
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
                `Order source: ${context.orderSourceLabel}.\n` +
                `Only this field will be changed.`
            );
        }

        if (context.mode === 'seqv') {
            const firstLogical = context.logicalValues[0];
            const lastLogical = context.logicalValues[context.logicalValues.length - 1];

            return window.confirm(
                `Apply ${context.entries.length} VERTICAL mapped values?\n\n` +
                `Field: ${fieldLabel}\n` +
                `First logical value: ${firstLabel} -> ${firstLogical}\n` +
                `First exact payload:\n${first}\n\n` +
                `Last logical value: ${lastLabel} -> ${lastLogical}\n` +
                `Last exact payload:\n${last}\n\n` +
                `You are applying the editable mapping shown in the {seqv} editor.\n` +
                `Order source: ${context.orderSourceLabel}.\n` +
                `Only this field will be changed.`
            );
        }

        return window.confirm(
            `Apply ${context.entries.length} mapped values?\n\n` +
            `Field: ${fieldLabel}\n` +
            `First: ${firstLabel} -> ${first}\n` +
            `Last: ${lastLabel} -> ${last}\n\n` +
            `You are applying the editable mapping shown in the {seq} editor.\n` +
            `Order source: ${context.orderSourceLabel}.\n` +
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
                const logicalValue = context.logicalValues
                    ? context.logicalValues[index]
                    : context.values[index];

                setHelperFeedback(
                    context.helper,
                    `Preflighting ${index + 1} of ${context.entries.length}: ` +
                    `${entry.label} -> ${logicalValue}`,
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
                const logicalValue = context.logicalValues
                    ? context.logicalValues[index]
                    : item.nextValue;

                setHelperFeedback(
                    context.helper,
                    `Saving ${index + 1} of ${prepared.length}: ${entry.label} -> ${logicalValue}`,
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
                `Updated ${completed} signs in field ${fieldName} using ${context.orderSourceLabel}:`,
                context.entries.map((entry, index) => ({
                    id: entry.id,
                    label: entry.label,
                    logicalValue: context.logicalValues
                        ? context.logicalValues[index]
                        : context.values[index],
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
                'This prevents SignAgent from receiving {start:step}, {seq}, or {seqv} directly.'
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
            'Syntax: {start:step} for fast sequences, {seq} for editable mappings, or {seqv} for vertical mappings.'
        );
    }

    init();
})();