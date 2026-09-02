// ==UserScript==
// @name         SignAgent Resizable Sidebar (TEST)
// @namespace    signbrothers-tools
// @version      0.1.0
// @description  Makes the SignAgent Projects / Locations / Sign Types sidebar resizable and remembers the preferred width.
// @match        https://app.signagent.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================

    const DEFAULT_WIDTH = 340;
    const MIN_WIDTH = 240;
    const ABSOLUTE_MAX_WIDTH = 650;
    const MAX_VIEWPORT_RATIO = 0.45;

    const STORAGE_KEY =
        'sb_signagent_sidebar_width_px_v1';

    const HANDLE_ID =
        'sb-signagent-sidebar-resize-handle';

    const LOG_PREFIX =
        '[SB Sidebar]';


    // ============================================================
    // STATE
    // ============================================================

    let dragState = null;
    let ensureQueued = false;
    let resizeQueued = false;


    // ============================================================
    // BASIC HELPERS
    // ============================================================

    function log(...args) {
        console.log(
            LOG_PREFIX,
            ...args
        );
    }


    function getSidebar() {
        return document.getElementById(
            'dashboard_links'
        );
    }


    function getMaxWidth() {
        return Math.max(
            MIN_WIDTH,
            Math.min(
                ABSOLUTE_MAX_WIDTH,
                Math.floor(
                    window.innerWidth *
                    MAX_VIEWPORT_RATIO
                )
            )
        );
    }


    function clampWidth(width) {
        width =
            Number(width);

        if (!Number.isFinite(width)) {
            width =
                DEFAULT_WIDTH;
        }

        return Math.max(
            MIN_WIDTH,
            Math.min(
                width,
                getMaxWidth()
            )
        );
    }


    function readSavedWidth() {
        try {
            const stored =
                Number(
                    localStorage.getItem(
                        STORAGE_KEY
                    )
                );

            if (
                Number.isFinite(stored) &&
                stored > 0
            ) {
                return stored;
            }

        } catch (error) {
            console.warn(
                LOG_PREFIX,
                'Could not read saved width.',
                error
            );
        }

        return DEFAULT_WIDTH;
    }


    function saveWidth(width) {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                String(
                    Math.round(width)
                )
            );

        } catch (error) {
            console.warn(
                LOG_PREFIX,
                'Could not save width.',
                error
            );
        }
    }


    function notifyLayoutResize() {
        if (resizeQueued) {
            return;
        }

        resizeQueued = true;

        requestAnimationFrame(
            function () {
                resizeQueued = false;

                window.dispatchEvent(
                    new Event(
                        'resize'
                    )
                );
            }
        );
    }


    // ============================================================
    // WIDTH CONTROL
    // ============================================================

    function applyWidth(width) {
        const sidebar =
            getSidebar();

        if (!sidebar) {
            return null;
        }

        const appliedWidth =
            clampWidth(width);

        sidebar.style.setProperty(
            'width',
            `${appliedWidth}px`,
            'important'
        );

        sidebar.style.setProperty(
            'flex-basis',
            `${appliedWidth}px`,
            'important'
        );

        sidebar.style.setProperty(
            'flex-shrink',
            '0',
            'important'
        );

        // Gives the resize handle a stable positioning context.
        sidebar.style.setProperty(
            'position',
            'relative',
            'important'
        );

        return appliedWidth;
    }


    // ============================================================
    // RESIZE HANDLE
    // ============================================================

    function createHandle() {
        const sidebar =
            getSidebar();

        if (!sidebar) {
            return null;
        }

        const existing =
            document.getElementById(
                HANDLE_ID
            );

        if (existing) {
            return existing;
        }

        const handle =
            document.createElement(
                'div'
            );

        handle.id =
            HANDLE_ID;

        handle.title =
            'Drag to resize sidebar. Double-click to reset.';

        Object.assign(
            handle.style,
            {
                position:
                    'absolute',

                top:
                    '0',

                right:
                    '-5px',

                bottom:
                    '0',

                width:
                    '10px',

                cursor:
                    'col-resize',

                zIndex:
                    '2147483000',

                background:
                    'transparent',

                userSelect:
                    'none',

                touchAction:
                    'none'
            }
        );


        const line =
            document.createElement(
                'div'
            );

        line.className =
            'sb-signagent-sidebar-resize-line';

        Object.assign(
            line.style,
            {
                position:
                    'absolute',

                top:
                    '0',

                bottom:
                    '0',

                left:
                    '4px',

                width:
                    '2px',

                background:
                    'rgba(255,255,255,0.18)',

                transition:
                    'background 120ms ease',

                pointerEvents:
                    'none'
            }
        );

        handle.appendChild(
            line
        );


        handle.addEventListener(
            'mouseenter',
            function () {
                line.style.background =
                    'rgba(255,255,255,0.70)';
            }
        );


        handle.addEventListener(
            'mouseleave',
            function () {
                if (!dragState) {
                    line.style.background =
                        'rgba(255,255,255,0.18)';
                }
            }
        );


        handle.addEventListener(
            'pointerdown',
            function (event) {
                if (event.button !== 0) {
                    return;
                }

                const currentSidebar =
                    getSidebar();

                if (!currentSidebar) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();

                dragState = {
                    pointerId:
                        event.pointerId,

                    startX:
                        event.clientX,

                    startWidth:
                        currentSidebar
                            .getBoundingClientRect()
                            .width,

                    lastWidth:
                        currentSidebar
                            .getBoundingClientRect()
                            .width
                };

                line.style.background =
                    'rgba(255,255,255,0.90)';

                document.body.style.cursor =
                    'col-resize';

                document.body.style.userSelect =
                    'none';

                try {
                    handle.setPointerCapture(
                        event.pointerId
                    );
                } catch (error) {}
            }
        );


        handle.addEventListener(
            'pointermove',
            function (event) {
                if (
                    !dragState ||
                    event.pointerId !==
                        dragState.pointerId
                ) {
                    return;
                }

                event.preventDefault();

                const newWidth =
                    dragState.startWidth +
                    (
                        event.clientX -
                        dragState.startX
                    );

                const appliedWidth =
                    applyWidth(
                        newWidth
                    );

                if (appliedWidth !== null) {
                    dragState.lastWidth =
                        appliedWidth;

                    notifyLayoutResize();
                }
            }
        );


        function finishDrag(event) {
            if (
                !dragState ||
                (
                    event.pointerId !== undefined &&
                    event.pointerId !==
                        dragState.pointerId
                )
            ) {
                return;
            }

            const finalWidth =
                dragState.lastWidth;

            const pointerId =
                dragState.pointerId;

            dragState = null;

            saveWidth(
                finalWidth
            );

            document.body.style.cursor =
                '';

            document.body.style.userSelect =
                '';

            line.style.background =
                'rgba(255,255,255,0.18)';

            try {
                handle.releasePointerCapture(
                    pointerId
                );
            } catch (error) {}

            notifyLayoutResize();

            log(
                `Saved sidebar width: ${Math.round(finalWidth)}px`
            );
        }


        handle.addEventListener(
            'pointerup',
            finishDrag
        );

        handle.addEventListener(
            'pointercancel',
            finishDrag
        );


        handle.addEventListener(
            'dblclick',
            function (event) {
                event.preventDefault();
                event.stopPropagation();

                const appliedWidth =
                    applyWidth(
                        DEFAULT_WIDTH
                    );

                if (appliedWidth !== null) {
                    saveWidth(
                        DEFAULT_WIDTH
                    );

                    notifyLayoutResize();

                    log(
                        `Sidebar width reset to ${DEFAULT_WIDTH}px`
                    );
                }
            }
        );


        sidebar.appendChild(
            handle
        );

        return handle;
    }


    // ============================================================
    // REPAIR / DYNAMIC PAGE HANDLING
    // ============================================================

    function ensureEnhancement() {
        ensureQueued = false;

        const sidebar =
            getSidebar();

        if (!sidebar) {
            return;
        }

        // Do not fight the user's pointer while they are dragging.
        if (!dragState) {
            const desiredWidth =
                clampWidth(
                    readSavedWidth()
                );

            const currentWidth =
                sidebar
                    .getBoundingClientRect()
                    .width;

            if (
                Math.abs(
                    currentWidth -
                    desiredWidth
                ) > 1
            ) {
                applyWidth(
                    desiredWidth
                );

                notifyLayoutResize();
            }
        }

        createHandle();
    }


    function scheduleEnsure() {
        if (ensureQueued) {
            return;
        }

        ensureQueued = true;

        requestAnimationFrame(
            ensureEnhancement
        );
    }


    // ============================================================
    // INIT
    // ============================================================

    function init() {
        scheduleEnsure();

        const observer =
            new MutationObserver(
                scheduleEnsure
            );

        observer.observe(
            document.documentElement,
            {
                childList:
                    true,

                subtree:
                    true
            }
        );

        // Fallback for SignAgent changing inline layout styles without
        // replacing DOM nodes.
        setInterval(
            scheduleEnsure,
            1500
        );

        window.addEventListener(
            'resize',
            scheduleEnsure
        );

        log(
            'SignAgent Resizable Sidebar v0.1.0 TEST loaded.'
        );
    }


    init();

})();
