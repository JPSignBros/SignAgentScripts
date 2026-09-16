// ==UserScript==
// @name         SignAgent Step Sequence v0.4 TEST
// @namespace    signbrothers-tools
// @version      0.4.0
// @description  Test build: {start:step}, {seq}, {seqv}, and combined multi-field sequencing.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.4.0';
  const FORM_BOUND = 'data-sb-sequence-bound';
  const HELPER = 'sb-sequence-helper';
  const COMBINED = 'sb-sequence-combined';
  const ACTION = 'sb-sequence-action';
  const WRITABLE = 'input[type="text"]:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])';
  const SELECTED = '#sign_list_container_small a.sign_link.active, #sign_list_container_small a.sign_link.selected';
  const DELAY_MS = 125;
  let activeJob = false;
  let scanQueued = false;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = value => String(value ?? '').trim();
  const isSeq = value => /^\{\s*seq\s*\}$/i.test(text(value));
  const isSeqv = value => /^\{\s*seqv\s*\}$/i.test(text(value));
  const verticalize = value => Array.from(text(value)).join('\n');

  function parseStep(value) {
    const match = text(value).match(/^\{\s*(-?\d+)\s*:\s*(-?\d+)\s*\}$/);
    if (!match) return null;
    const start = Number(match[1]);
    const step = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step) || !step) {
      return { error: 'Start and step must be whole numbers, and step cannot be 0.' };
    }
    const raw = match[1].replace(/^-/, '');
    return { start, step, width: raw.length > 1 && raw.startsWith('0') ? raw.length : 0 };
  }

  function hasSyntax(input) {
    return !!(parseStep(input.value) || isSeq(input.value) || isSeqv(input.value));
  }

  function parseIds(form) {
    if (!form) return [];
    let url;
    try { url = new URL(form.getAttribute('action') || '', location.href); } catch { return []; }
    const match = url.pathname.match(/^\/sign\/([0-9,]+)\/edit\/?$/);
    return match ? match[1].split(',').filter(Boolean) : [];
  }

  function linkId(link) {
    if (link.dataset?.sign_id) return String(link.dataset.sign_id);
    return (link.getAttribute('href') || '').match(/\/sign\/(\d+)(?:\/|$)/)?.[1] || '';
  }

  function visibleOrder(formIds) {
    const allowed = new Set(formIds);
    const seen = new Set();
    const entries = [];
    document.querySelectorAll(SELECTED).forEach(link => {
      const id = linkId(link);
      if (!id || !allowed.has(id) || seen.has(id)) return;
      seen.add(id);
      entries.push({ id, label: link.textContent.trim().replace(/\s+/g, ' ') || `Sign ${id}` });
    });
    if (entries.length !== formIds.length) {
      return { ok: false, entries, message: `Could not safely determine visible Sign List order for all ${formIds.length} selected signs (found ${entries.length}).` };
    }
    return { ok: true, entries };
  }

  function fieldLabel(input) {
    if (input?.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim().replace(/\s+/g, ' ');
    }
    return input?.name || input?.id || 'Field';
  }

  function buildSequence(generator, count) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const n = generator.start + generator.step * i;
      if (!Number.isSafeInteger(n)) throw new Error('Sequence exceeds JavaScript safe integer limits.');
      const negative = n < 0;
      const digits = String(Math.abs(n)).padStart(generator.width || 0, '0');
      out.push(negative ? `-${digits}` : digits);
    }
    return out;
  }

  function parseGenerator(startValue, stepValue) {
    const startText = text(startValue);
    const stepText = text(stepValue);
    if (!/^-?\d+$/.test(startText)) throw new Error('Starting number must be a whole number.');
    if (!/^-?\d+$/.test(stepText) || Number(stepText) === 0) throw new Error('Step must be a non-zero whole number.');
    const start = Number(startText);
    const step = Number(stepText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) throw new Error('Start/step are outside safe integer limits.');
    const raw = startText.replace(/^-/, '');
    return { start, step, width: raw.length > 1 && raw.startsWith('0') ? raw.length : 0 };
  }

  function helperFor(input) {
    return input?.closest('.form-group')?.querySelector(`:scope > .${HELPER}`) || null;
  }

  function removeHelper(input) {
    helperFor(input)?.remove();
  }

  function ensureHelper(input) {
    const group = input.closest('.form-group');
    if (!group) return null;
    let helper = helperFor(input);
    if (helper) return helper;
    helper = document.createElement('div');
    helper.className = HELPER;
    Object.assign(helper.style, { marginTop: '7px', padding: '9px 10px', border: '1px solid #b8c7d9', borderRadius: '4px', background: '#f4f8fc', color: '#334155', fontSize: '12px', lineHeight: '1.4' });
    group.appendChild(helper);
    return helper;
  }

  function feedback(holder, message, tone = 'normal') {
    const node = holder?.querySelector('.sb-feedback');
    if (node) node.textContent = message;
    const colors = {
      normal: ['#f4f8fc', '#334155', '#b8c7d9'],
      working: ['#fff8e1', '#6b5200', '#e5c85c'],
      error: ['#fff1f2', '#8a1c2c', '#e2a3ad'],
      success: ['#eefbf3', '#17603a', '#94d3ac']
    };
    const [background, color, borderColor] = colors[tone] || colors.normal;
    Object.assign(holder.style, { background, color, borderColor });
  }

  function actionButton(label, action, primary = true) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${primary ? 'btn btn-xs btn-primary' : 'btn btn-xs btn-default'} ${ACTION}`;
    button.dataset.sbAction = action;
    button.textContent = label;
    button.disabled = activeJob;
    return button;
  }

  function baseRender(input, ids) {
    const order = visibleOrder(ids);
    if (!order.ok) throw new Error(order.message);
    return { helper: ensureHelper(input), order };
  }

  function renderStep(input, ids, parsed) {
    const { helper, order } = baseRender(input, ids);
    const signature = `step|${input.value}|${ids.join(',')}|${order.entries.map(x => x.id).join(',')}`;
    if (helper.dataset.signature === signature) return;
    helper.dataset.signature = signature;
    helper.replaceChildren();
    if (parsed.error) {
      const node = document.createElement('div'); node.className = 'sb-feedback'; helper.appendChild(node); feedback(helper, parsed.error, 'error'); return;
    }
    const values = buildSequence(parsed, order.entries.length);
    helper.dataset.mode = 'step';
    const title = document.createElement('div'); title.style.fontWeight = '600'; title.textContent = `SB step sequence TEST v${VERSION} — ${order.entries.length} signs`; helper.appendChild(title);
    const pre = document.createElement('pre'); pre.textContent = order.entries.map((e, i) => `${e.label} -> ${values[i]}`).join('\n'); Object.assign(pre.style, { margin: '6px 0', padding: '6px 8px', maxHeight: '220px', overflow: 'auto', background: '#fff' }); helper.appendChild(pre);
    const button = actionButton('Apply Sequence', 'apply-step'); helper.appendChild(button);
    const node = document.createElement('div'); node.className = 'sb-feedback'; node.style.marginTop = '5px'; helper.appendChild(node);
  }

  function renderMapped(input, ids, mode) {
    const { helper, order } = baseRender(input, ids);
    const signature = `${mode}|${ids.join(',')}|${order.entries.map(x => x.id).join(',')}`;
    if (helper.dataset.signature === signature) return;
    helper.dataset.signature = signature;
    helper.dataset.mode = mode;
    helper.replaceChildren();
    const vertical = mode === 'seqv';

    const title = document.createElement('div'); title.style.fontWeight = '600'; title.textContent = `${vertical ? 'SB vertical sequence' : 'SB sequence'} editor TEST v${VERSION} — ${order.entries.length} signs`; helper.appendChild(title);
    const intro = document.createElement('div'); intro.style.marginTop = '4px'; intro.textContent = vertical ? 'Enter normal numbers; the exact newline payload is previewed at right.' : 'Generate values, then edit any exceptions.'; helper.appendChild(intro);

    const generator = document.createElement('div'); Object.assign(generator.style, { display: 'flex', gap: '6px', alignItems: 'flex-end', marginTop: '8px', flexWrap: 'wrap' });
    const start = document.createElement('input'); start.type = 'text'; start.className = 'form-control input-sm sb-start'; start.placeholder = '2201'; start.style.width = '90px';
    const step = document.createElement('input'); step.type = 'text'; step.className = 'form-control input-sm sb-step'; step.value = '1'; step.style.width = '70px';
    const startLabel = document.createElement('label'); startLabel.style.margin = '0'; startLabel.textContent = 'Start'; startLabel.appendChild(start);
    const stepLabel = document.createElement('label'); stepLabel.style.margin = '0'; stepLabel.textContent = 'Step'; stepLabel.appendChild(step);
    generator.append(startLabel, stepLabel, actionButton('Fill Suggestions', 'fill', false)); helper.appendChild(generator);

    const list = document.createElement('div'); Object.assign(list.style, { marginTop: '8px', maxHeight: '420px', overflowY: 'auto', border: '1px solid rgba(0,0,0,.10)', background: '#fff' });
    order.entries.forEach((entry, index) => {
      const row = document.createElement('div'); Object.assign(row.style, { display: 'grid', gridTemplateColumns: vertical ? 'minmax(90px,1fr) minmax(110px,1fr) minmax(90px,.8fr)' : 'minmax(90px,1fr) minmax(110px,1fr)', gap: '8px', alignItems: 'center', padding: '5px 7px', borderTop: index ? '1px solid rgba(0,0,0,.06)' : '0' });
      const label = document.createElement('div'); label.textContent = entry.label;
      const value = document.createElement('input'); value.type = 'text'; value.className = 'form-control input-sm sb-map-value'; value.dataset.signId = entry.id;
      row.append(label, value);
      if (vertical) {
        const exact = document.createElement('pre'); exact.className = 'sb-exact'; Object.assign(exact.style, { margin: '0', padding: '5px 7px', minHeight: '32px', maxHeight: '88px', overflow: 'auto', border: '1px solid rgba(0,0,0,.10)', whiteSpace: 'pre-wrap' });
        value.addEventListener('input', () => { exact.textContent = verticalize(value.value); });
        row.appendChild(exact);
      }
      list.appendChild(row);
    });
    helper.appendChild(list);
    helper.appendChild(actionButton(vertical ? 'Apply Vertical Mapped Values' : 'Apply Mapped Values', vertical ? 'apply-seqv' : 'apply-seq'));
    const node = document.createElement('div'); node.className = 'sb-feedback'; node.style.marginTop = '5px'; node.textContent = 'Fill suggestions, review every row, then apply.'; helper.appendChild(node);
  }

  function render(input, ids) {
    if (activeJob) return;
    const parsed = parseStep(input.value);
    try {
      if (parsed) return renderStep(input, ids, parsed);
      if (isSeqv(input.value)) return renderMapped(input, ids, 'seqv');
      if (isSeq(input.value)) return renderMapped(input, ids, 'seq');
      removeHelper(input);
    } catch (error) {
      const helper = ensureHelper(input);
      helper.replaceChildren();
      const node = document.createElement('div'); node.className = 'sb-feedback'; helper.appendChild(node); feedback(helper, error.message || String(error), 'error');
    }
  }

  function sourceContext(button) {
    const helper = button.closest(`.${HELPER}`);
    const group = helper?.closest('.form-group');
    const input = group && [...group.querySelectorAll(WRITABLE)].find(el => !helper.contains(el));
    const form = input?.closest('#sign_form');
    if (!helper || !input || !form) throw new Error('Could not reconnect the tool to its SignAgent field/form.');
    const ids = parseIds(form);
    if (ids.length <= 1) throw new Error('This is no longer a multi-sign edit.');
    const order = visibleOrder(ids);
    if (!order.ok) throw new Error(order.message);
    return { helper, input, form, ids, entries: order.entries, button };
  }

  function contextFor(button) {
    const base = sourceContext(button);
    const action = button.dataset.sbAction;
    if (action === 'apply-step') {
      const parsed = parseStep(base.input.value);
      if (!parsed || parsed.error) throw new Error(parsed?.error || 'Step syntax is no longer valid.');
      return { ...base, mode: 'step', parsed, values: buildSequence(parsed, base.entries.length) };
    }
    const mode = isSeqv(base.input.value) ? 'seqv' : 'seq';
    if (mode === 'seqv' ? !isSeqv(base.input.value) : !isSeq(base.input.value)) throw new Error(`Field is no longer in {${mode}} mode.`);
    const mapping = [...base.helper.querySelectorAll('.sb-map-value')];
    if (mapping.length !== base.entries.length) throw new Error('Mapping editor no longer matches selected sign count.');
    const values = mapping.map((el, i) => {
      if (el.dataset.signId !== base.entries[i].id) throw new Error('Mapping editor order no longer matches visible Sign List order.');
      const logical = text(el.value);
      if (!logical) throw new Error(`${base.entries[i].label} does not have a value yet.`);
      return mode === 'seqv' ? verticalize(logical) : logical;
    });
    return { ...base, mode, values };
  }

  function fill(button) {
    const base = sourceContext(button);
    const mode = isSeqv(base.input.value) ? 'seqv' : 'seq';
    if (mode === 'seqv' ? !isSeqv(base.input.value) : !isSeq(base.input.value)) throw new Error(`Field is no longer in {${mode}} mode.`);
    const start = base.helper.querySelector('.sb-start');
    const step = base.helper.querySelector('.sb-step');
    const mapping = [...base.helper.querySelectorAll('.sb-map-value')];
    const values = buildSequence(parseGenerator(start.value, step.value), base.entries.length);
    mapping.forEach((el, i) => { el.value = values[i]; el.dispatchEvent(new Event('input', { bubbles: true })); });
    feedback(base.helper, `Filled ${values.length} suggestions. Review every row before applying.`, 'normal');
  }

  function helperInput(helper) {
    const group = helper.closest('.form-group');
    return group ? [...group.querySelectorAll(WRITABLE)].find(el => !helper.contains(el)) : null;
  }

  function renderCombined(form) {
    if (activeJob) return;
    const helpers = [...form.querySelectorAll(`.${HELPER}`)].filter(h => hasSyntax(helperInput(h)));
    let panel = form.querySelector(`.${COMBINED}`);
    if (helpers.length < 2) { panel?.remove(); return; }
    if (!panel) {
      panel = document.createElement('div'); panel.className = COMBINED;
      Object.assign(panel.style, { marginTop: '10px', padding: '10px', border: '1px solid #a7c4e3', borderRadius: '4px', background: '#eef6ff', color: '#23415f', fontSize: '12px' });
      helpers.at(-1).insertAdjacentElement('afterend', panel);
    }
    panel.replaceChildren();
    const title = document.createElement('div'); title.style.fontWeight = '600'; title.textContent = `SB combined sequence TEST v${VERSION}`; panel.appendChild(title);
    const desc = document.createElement('div'); desc.textContent = `${helpers.length} sequence fields are active. Combined apply saves each sign once with all listed field changes.`; panel.appendChild(desc);
    const ul = document.createElement('ul');
    helpers.forEach(h => { const input = helperInput(h); const li = document.createElement('li'); li.textContent = `${fieldLabel(input)} ${isSeqv(input.value) ? '{seqv}' : isSeq(input.value) ? '{seq}' : '{start:step}'}`; ul.appendChild(li); });
    panel.appendChild(ul);
    panel.appendChild(actionButton(`Apply All ${helpers.length} Fields Together`, 'apply-combined'));
    const node = document.createElement('div'); node.className = 'sb-feedback'; node.style.marginTop = '5px'; node.textContent = 'Fill and review every active editor first.'; panel.appendChild(node);
  }

  function combinedContext(button) {
    const panel = button.closest(`.${COMBINED}`);
    const form = panel?.closest('#sign_form');
    if (!panel || !form) throw new Error('Could not reconnect combined tool to form.');
    const helpers = [...form.querySelectorAll(`.${HELPER}`)];
    const contexts = helpers.map(h => {
      const apply = h.querySelector('[data-sb-action="apply-step"], [data-sb-action="apply-seq"], [data-sb-action="apply-seqv"]');
      if (!apply) throw new Error('An active sequence editor is incomplete.');
      return contextFor(apply);
    });
    if (contexts.length < 2) throw new Error('At least two active sequence fields are required.');
    const first = contexts[0];
    const seen = new Set();
    contexts.forEach(c => {
      if (!c.input.name || seen.has(c.input.name)) throw new Error('Sequence fields must be uniquely identifiable.');
      seen.add(c.input.name);
      if (c.ids.join(',') !== first.ids.join(',') || c.entries.map(x => x.id).join(',') !== first.entries.map(x => x.id).join(',')) throw new Error('Active editors no longer share the same selected signs/order.');
    });
    return { panel, form, contexts, button };
  }

  async function fetchSignForm(signId) {
    const url = `/sign/${encodeURIComponent(signId)}/edit/`;
    for (const ajax of [true, false]) {
      const headers = { Accept: 'text/html,application/xhtml+xml' };
      if (ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
      const response = await fetch(url, { credentials: 'same-origin', headers });
      if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
      const form = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('#sign_form');
      if (form) return form;
    }
    throw new Error(`Could not find edit form for sign ${signId}.`);
  }

  async function prepare(signId, updates) {
    const form = await fetchSignForm(signId);
    const data = new FormData(form);
    for (const update of updates) {
      const field = form.elements.namedItem(update.name);
      if (!field || field instanceof RadioNodeList) throw new Error(`Field "${update.name}" not found on sign ${signId}.`);
      if (field.disabled || field.readOnly) throw new Error(`Field "${update.name}" is not writable on sign ${signId}.`);
      data.set(update.name, update.value);
    }
    const action = form.getAttribute('action');
    if (!action) throw new Error(`Sign ${signId} edit form has no action URL.`);
    return { signId, action: new URL(action, location.origin).href, data };
  }

  async function post(prepared) {
    const response = await fetch(prepared.action, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html,application/xhtml+xml,application/json' }, body: prepared.data, redirect: 'follow' });
    const body = await response.text();
    if (!response.ok) throw new Error(`Sign ${prepared.signId} returned HTTP ${response.status}.`);
    if (body) {
      const doc = new DOMParser().parseFromString(body, 'text/html');
      const error = doc.querySelector('#sign_form .has-error, #sign_form .errorlist, #sign_form .alert-danger, #sign_form .invalid-feedback');
      if (error) throw new Error(`Sign ${prepared.signId} was rejected: ${error.textContent.trim().replace(/\s+/g, ' ')}`);
    }
  }

  function verify(context) {
    const form = document.querySelector('#sign_form');
    const ids = parseIds(form);
    const order = visibleOrder(ids);
    if (!order.ok || ids.join(',') !== context.ids.join(',') || order.entries.map(x => x.id).join(',') !== context.entries.map(x => x.id).join(',')) throw new Error('Selected signs or visible order changed after preview was created.');
  }

  const compactValue = value => String(value).replace(/\r?\n/g, ' / ');

  function confirmOne(context) {
    const first = context.values[0], last = context.values.at(-1);
    if (context.mode === 'seqv') {
      return confirm(`Apply ${context.entries.length} VERTICAL mapped values?\n\nField: ${fieldLabel(context.input)}\nFirst: ${context.entries[0].label}\n${first}\n\nLast: ${context.entries.at(-1).label}\n${last}\n\nThese multiline values are the exact payloads that will be written.`);
    }
    return confirm(`Apply ${context.entries.length} values?\n\nField: ${fieldLabel(context.input)}\nFirst: ${context.entries[0].label} -> ${compactValue(first)}\nLast: ${context.entries.at(-1).label} -> ${compactValue(last)}\n\nOrder source: visible Sign List.`);
  }

  function disableActions(form, disabled) { form.querySelectorAll(`.${ACTION}`).forEach(b => { b.disabled = disabled; }); }

  async function applyOne(context) {
    if (activeJob) return;
    verify(context);
    if (!confirmOne(context)) return;
    activeJob = true; disableActions(context.form, true);
    try {
      const prepared = [];
      for (let i = 0; i < context.entries.length; i += 1) {
        feedback(context.helper, `Preflighting ${i + 1} of ${context.entries.length}: ${context.entries[i].label}`, 'working');
        prepared.push(await prepare(context.entries[i].id, [{ name: context.input.name, value: context.values[i] }]));
      }
      for (let i = 0; i < prepared.length; i += 1) {
        feedback(context.helper, `Saving ${i + 1} of ${prepared.length}: ${context.entries[i].label}`, 'working');
        await post(prepared[i]);
        if (i < prepared.length - 1) await sleep(DELAY_MS);
      }
      feedback(context.helper, `Done — updated ${prepared.length} signs. Reloading...`, 'success');
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      feedback(context.helper, `Stopped. ${error.message || error}`, 'error');
      alert(`Sequence Tool stopped.\n\n${error.message || error}\n\nInspect completed signs before retrying.`);
    } finally { activeJob = false; disableActions(context.form, false); }
  }

  async function applyCombined(combined) {
    if (activeJob) return;
    combined.contexts.forEach(verify);
    const first = combined.contexts[0];
    const summary = combined.contexts.map(c => `- ${fieldLabel(c.input)} [${c.mode}]: ${compactValue(c.values[0])} -> ${compactValue(c.values.at(-1))}`).join('\n');
    if (!confirm(`Apply ${combined.contexts.length} fields to ${first.entries.length} signs in ONE controlled pass?\n\n${summary}\n\nEach sign will be loaded once, all listed fields set, then saved once.`)) return;
    activeJob = true; disableActions(combined.form, true);
    try {
      const prepared = [];
      for (let i = 0; i < first.entries.length; i += 1) {
        feedback(combined.panel, `Preflighting ${i + 1} of ${first.entries.length}: ${first.entries[i].label}`, 'working');
        const updates = combined.contexts.map(c => ({ name: c.input.name, value: c.values[i] }));
        prepared.push(await prepare(first.entries[i].id, updates));
      }
      for (let i = 0; i < prepared.length; i += 1) {
        feedback(combined.panel, `Saving ${i + 1} of ${prepared.length}: ${first.entries[i].label}`, 'working');
        await post(prepared[i]);
        if (i < prepared.length - 1) await sleep(DELAY_MS);
      }
      feedback(combined.panel, `Done — updated ${prepared.length} signs across ${combined.contexts.length} fields. Reloading...`, 'success');
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      feedback(combined.panel, `Stopped. ${error.message || error}`, 'error');
      alert(`Combined Sequence Tool stopped.\n\n${error.message || error}\n\nInspect completed signs before retrying.`);
    } finally { activeJob = false; disableActions(combined.form, false); }
  }

  function activate(button) {
    try {
      const action = button.dataset.sbAction;
      if (action === 'fill') return fill(button);
      if (action === 'apply-combined') return void applyCombined(combinedContext(button));
      if (action.startsWith('apply-')) return void applyOne(contextFor(button));
    } catch (error) {
      alert(`Sequence Tool could not continue. No changes were made.\n\n${error.message || error}`);
    }
  }

  function handlePointer(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const button = event.target instanceof Element ? event.target.closest(`.${ACTION}`) : null;
    if (!button || button.disabled || activeJob) return;
    event.preventDefault(); event.stopImmediatePropagation(); activate(button);
  }

  function bind(form) {
    if (form.getAttribute(FORM_BOUND) === '1') return renderAll(form);
    form.setAttribute(FORM_BOUND, '1');
    const update = input => {
      if (!input || input.closest?.(`.${HELPER}`)) return;
      if (input.matches?.(WRITABLE)) render(input, parseIds(form));
      renderCombined(form);
    };
    form.addEventListener('input', event => update(event.target), true);
    form.addEventListener('change', event => update(event.target), true);
    form.addEventListener('submit', event => {
      if (![...form.querySelectorAll(WRITABLE)].some(hasSyntax)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      alert('Sign Brothers sequence syntax detected. Use the Sign Brothers Apply button, or Apply All when multiple sequence fields are active.');
    }, true);
    renderAll(form);
    console.log(`[SB Sequence Tool] v${VERSION} bound to ${parseIds(form).length} selected signs.`);
  }

  function renderAll(form) {
    if (activeJob) return;
    const ids = parseIds(form);
    if (ids.length <= 1) return;
    form.querySelectorAll(WRITABLE).forEach(input => render(input, ids));
    renderCombined(form);
  }

  function scan() {
    scanQueued = false;
    const form = document.querySelector('#sign_form');
    if (form && parseIds(form).length > 1) bind(form);
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  document.addEventListener('pointerdown', handlePointer, true);
  scheduleScan();
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scheduleScan, 1500);
  console.log(`[SB Sequence Tool] v${VERSION} TEST loaded. Use {start:step}, {seq}, or {seqv}.`);
})();