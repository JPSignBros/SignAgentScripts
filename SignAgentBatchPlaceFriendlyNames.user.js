// ==UserScript==
// @name         SignAgent Batch Place + Friendly Names
// @namespace    signbrothers-tools
// @version      1.0.0
// @description  Production wrapper around the immutable Batch Place v1.0.0 baseline with human-readable Batch Details and Save All confirmation labels.
// @match        https://app.signagent.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @require      https://raw.githubusercontent.com/JPSignBros/SignAgentScripts/ed659e54c845c408a9efd7479b3b84552d20cb82/SignAgentBatchPlace.user.js
// ==/UserScript==

'use strict';

var SB_BATCH_NAMES_VERSION = '1.0.0';
var SB_BATCH_NAMES_LOG_PREFIX = '[SB Batch Names]';
var SB_BATCH_NAMES_ID_ATTR = 'data-sb-batch-friendly-id';
var SB_BATCH_NAMES_NATIVE_CONFIRM = unsafeWindow.confirm.bind(unsafeWindow);
var SB_BATCH_NAMES_CONFIRM_RE = /^Create (\d+) sign(s?)\?\n\nProject: (\d+)\nLocation: (\d+)\nSign Type: (\d+)\nState: (\d+)$/;

function sbBatchCleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function sbBatchStripLeadingCount(value) {
    return sbBatchCleanText(value).replace(/^\d+\s*/, '').trim();
}

function sbBatchTextFromHtml(value) {
    var holder = document.createElement('div');
    holder.innerHTML = String(value || '');
    return sbBatchCleanText(holder.textContent || holder.innerText || '');
}

function sbBatchRememberAndReadId(selector) {
    var el = document.querySelector(selector);
    if (!el) return '';

    var text = sbBatchCleanText(el.textContent);
    if (/^\d+$/.test(text)) {
        el.setAttribute(SB_BATCH_NAMES_ID_ATTR, text);
        return text;
    }

    return sbBatchCleanText(el.getAttribute(SB_BATCH_NAMES_ID_ATTR));
}

function sbBatchReadIds() {
    return {
        project: sbBatchRememberAndReadId('#sa-batch-project'),
        location: sbBatchRememberAndReadId('#sa-batch-location'),
        signType: sbBatchRememberAndReadId('#sa-batch-type'),
        state: sbBatchRememberAndReadId('#sa-batch-state')
    };
}

function sbBatchLabelFromAnchor(prefix, id) {
    if (!id) return '';
    var anchor = document.getElementById(prefix + id + '_anchor');
    return sbBatchStripLeadingCount(anchor ? (anchor.innerText || anchor.textContent || '') : '');
}

function sbBatchJsTreeInstances() {
    var jq = unsafeWindow.jQuery || window.jQuery;
    var instances = [];
    var seen = new Set();

    if (!jq) return instances;

    document.querySelectorAll('.jstree').forEach(function (tree) {
        var instance = null;

        try {
            if (jq.jstree && typeof jq.jstree.reference === 'function') {
                instance = jq.jstree.reference(tree);
            }

            if (!instance && typeof jq === 'function') {
                instance = jq(tree).jstree(true);
            }
        } catch (error) {
            instance = null;
        }

        if (!instance || seen.has(instance)) return;
        seen.add(instance);
        instances.push(instance);
    });

    return instances;
}

function sbBatchFindJsTreeNode(nodeId) {
    if (!nodeId) return null;

    var instances = sbBatchJsTreeInstances();

    for (var i = 0; i < instances.length; i++) {
        var instance = instances[i];
        var model = instance && instance._model && instance._model.data;
        var node = model && model[nodeId];

        if (node) {
            return {
                instance: instance,
                model: model,
                node: node
            };
        }
    }

    return null;
}

function sbBatchModelNodeLabel(node) {
    if (!node) return '';
    return sbBatchStripLeadingCount(sbBatchTextFromHtml(node.text || ''));
}

function sbBatchResolveTreeLabel(prefix, id) {
    var fromDom = sbBatchLabelFromAnchor(prefix, id);
    if (fromDom) return fromDom;

    var found = sbBatchFindJsTreeNode(prefix + id);
    return found ? sbBatchModelNodeLabel(found.node) : '';
}

function sbBatchResolveState(id) {
    if (!id) return '';

    var node = document.getElementById('state' + id);
    var data = null;

    try {
        data = JSON.parse(node ? (node.getAttribute('data-jstree') || 'null') : 'null');
    } catch (error) {
        data = null;
    }

    var nested = data && (
        data.create_order_with_signs_and_install ||
        data.create_order_with_signs ||
        data.create_order_with_install
    );

    var name = sbBatchCleanText((nested && nested.name) || sbBatchLabelFromAnchor('state', id));
    var phase = sbBatchCleanText((data && data.projectName) || '');

    if (!name || !phase) {
        var found = sbBatchFindJsTreeNode('state' + id);

        if (found) {
            if (!name) {
                name = sbBatchModelNodeLabel(found.node);
            }

            if (!phase) {
                var parentId = found.node.parent;
                var guard = 0;

                while (parentId && parentId !== '#' && guard < 20) {
                    var parentNode = found.model[parentId];
                    if (!parentNode) break;

                    var candidateId = String(parentNode.id || parentId || '');
                    if (/^phase\d+$/i.test(candidateId)) {
                        phase = sbBatchModelNodeLabel(parentNode);
                        break;
                    }

                    parentId = parentNode.parent;
                    guard++;
                }
            }
        }
    }

    return phase && name ? phase + ' → ' + name : (name || phase);
}

function sbBatchResolveProject(projectId) {
    var candidates = [];
    var seen = new Set();

    function add(rawText, score) {
        var text = sbBatchCleanText(rawText);
        if (!text) return;

        text = text
            .replace(/\s*[|\u2013\u2014-]\s*SignAgent\s*$/i, '')
            .replace(/^SignAgent\s*[|\u2013\u2014-]\s*/i, '')
            .trim();

        if (!text || text === String(projectId)) return;
        if (/^(map|export|settings|new folder|new project|manage fonts|new location|batch import)$/i.test(text)) return;
        if (text.length > 140 || !/[A-Za-z]/.test(text)) return;

        var key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ text: text, score: score });
    }

    add(document.title, 100);

    [
        '[data-project-name]',
        '#project_name',
        '#project-name',
        '.project-name',
        '.project_name',
        '.breadcrumb li',
        '.breadcrumb a',
        'h1',
        'h2'
    ].forEach(function (selector) {
        document.querySelectorAll(selector).forEach(function (el) {
            var visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            add(el.innerText || el.textContent, visible ? 80 : 25);
        });
    });

    if (projectId) {
        document.querySelectorAll('a[href]').forEach(function (anchor) {
            var href = anchor.getAttribute('href') || '';
            if (href.includes('/organization/' + projectId + '/')) {
                add(anchor.innerText || anchor.textContent, 40);
            }
        });
    }

    candidates.sort(function (a, b) {
        return b.score - a.score || a.text.length - b.text.length;
    });

    return candidates.length ? candidates[0].text : '';
}

function sbBatchResolveFriendly(ids) {
    return {
        project: sbBatchResolveProject(ids.project),
        location: sbBatchResolveTreeLabel('zone', ids.location),
        signType: sbBatchResolveTreeLabel('sign_template', ids.signType),
        state: sbBatchResolveState(ids.state)
    };
}

function sbBatchBuildFriendlyConfirmation(match) {
    var count = match[1];
    var ids = {
        project: match[3],
        location: match[4],
        signType: match[5],
        state: match[6]
    };
    var friendly = sbBatchResolveFriendly(ids);

    function show(name, id) {
        return name || id;
    }

    return (
        'Create ' + count + ' sign' + (count === '1' ? '' : 's') + '?\n\n' +
        'Project: ' + show(friendly.project, ids.project) + '\n' +
        'Location: ' + show(friendly.location, ids.location) + '\n' +
        'Sign Type: ' + show(friendly.signType, ids.signType) + '\n' +
        'State: ' + show(friendly.state, ids.state)
    );
}

/*
 * Deliberately top-level. Tampermonkey evaluates @require code and this main
 * userscript in one lexical wrapper, so the immutable Batch Place saveAll()
 * resolves this binding when it calls bare confirm(...).
 */
function confirm(message) {
    var text = String(message == null ? '' : message);
    var match = text.match(SB_BATCH_NAMES_CONFIRM_RE);

    if (!match) {
        return SB_BATCH_NAMES_NATIVE_CONFIRM(message);
    }

    var friendlyMessage = sbBatchBuildFriendlyConfirmation(match);
    console.log(SB_BATCH_NAMES_LOG_PREFIX + ' lexical confirm intercepted Batch Place', {
        original: text,
        friendly: friendlyMessage
    });

    return SB_BATCH_NAMES_NATIVE_CONFIRM(friendlyMessage);
}

function sbBatchSetPanelValue(selector, id, friendly) {
    var el = document.querySelector(selector);
    if (!el || !id) return;

    el.setAttribute(SB_BATCH_NAMES_ID_ATTR, id);
    el.title = 'SignAgent ID: ' + id;
    el.textContent = friendly || id;
}

function sbBatchRefreshDetails() {
    var ids = sbBatchReadIds();
    if (!ids.project && !ids.location && !ids.signType && !ids.state) return;

    var friendly = sbBatchResolveFriendly(ids);
    sbBatchSetPanelValue('#sa-batch-project', ids.project, friendly.project);
    sbBatchSetPanelValue('#sa-batch-location', ids.location, friendly.location);
    sbBatchSetPanelValue('#sa-batch-type', ids.signType, friendly.signType);
    sbBatchSetPanelValue('#sa-batch-state', ids.state, friendly.state);
}

/* Also patch properties for any calls that explicitly use window/globalThis. */
try { window.confirm = confirm; } catch (error) {}
try { globalThis.confirm = confirm; } catch (error) {}
try { self.confirm = confirm; } catch (error) {}

function sbBatchStartFriendlyUi() {
    sbBatchRefreshDetails();
    setInterval(sbBatchRefreshDetails, 250);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sbBatchStartFriendlyUi, { once: true });
} else {
    sbBatchStartFriendlyUi();
}

console.log(SB_BATCH_NAMES_LOG_PREFIX + ' v' + SB_BATCH_NAMES_VERSION + ' production active; jsTree model fallback enabled.');
