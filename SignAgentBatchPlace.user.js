// ==UserScript==
// @name         SignAgent Batch Place + Direction Drag
// @namespace    signagent-tools
// @version      1.0.0
// @description  Batch place SignAgent signs with drag orientation and integrated top-bar controls.
// @match        https://app.signagent.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const PAGE =
        typeof unsafeWindow !== 'undefined'
            ? unsafeWindow
            : window;


    // ============================================================
    // STATE
    // ============================================================

    const batchState = {
        enabled: false,
        saving: false,

        queue: [],

        contextKey: null,
        projectId: null,
        locationId: null,

        lastSignType: null,
        lastState: null,
        lastDirection: 0,

        originalHotlink: null,
        hotlinkHooked: false,

        pendingPlacement: null,
        lastCompletedDrag: null,

        drag: {
            active: false,

            startX: 0,
            startY: 0,

            currentX: 0,
            currentY: 0,

            direction: 0,
            distance: 0,

            initialLat: null,
            initialLng: null,

            queuedIndex: null
        }
    };


    // ============================================================
    // LOGGING
    // ============================================================

    function log(...args) {
        console.log(
            '[SA Batch]',
            ...args
        );
    }


    // ============================================================
    // BASIC HELPERS
    // ============================================================

    function normalizeDirection(angle) {
        angle =
            Number(angle) || 0;

        return (
            ((angle % 360) + 360) %
            360
        );
    }


    function getCookie(name) {
        const row =
            document.cookie
                .split('; ')
                .find(
                    item =>
                        item.startsWith(
                            name + '='
                        )
                );

        if (!row) {
            return null;
        }

        return decodeURIComponent(
            row
                .split('=')
                .slice(1)
                .join('=')
        );
    }


    function getCsrfToken() {
        try {
            const cookieName =
                PAGE
                    .base_html_js_obj
                    ?.csrf_cookie_name;

            if (cookieName) {
                const token =
                    getCookie(
                        cookieName
                    );

                if (token) {
                    return token;
                }
            }

        } catch (e) {}


        const standard =
            getCookie(
                'csrftoken'
            );

        if (standard) {
            return standard;
        }


        return (
            document.querySelector(
                '[name="csrfmiddlewaretoken"]'
            )?.value ||
            null
        );
    }


    // ============================================================
    // CONTEXT DETECTION
    // ============================================================

    function detectProjectId() {
        try {
            const currentSignUrl =
                PAGE
                    .map_js_obj
                    ?.url_current_sign_json;

            if (currentSignUrl) {
                const match =
                    currentSignUrl.match(
                        /\/organization\/(\d+)\//
                    );

                if (match) {
                    return match[1];
                }
            }

        } catch (e) {}


        const formProjectId =
            document.querySelector(
                '#sign_form'
            )?.dataset?.projectId;

        if (formProjectId) {
            return String(
                formProjectId
            );
        }


        const pathMatch =
            location.pathname.match(
                /\/organization\/(\d+)\//
            );

        if (pathMatch) {
            return pathMatch[1];
        }


        return null;
    }


    function detectLocationId() {
        const formZone =
            document.querySelector(
                '#sign_form [name="zone"]'
            )?.value;

        if (formZone) {
            return String(
                formZone
            );
        }


        const pathMatch =
            location.pathname.match(
                /\/location\/(\d+)\//
            );

        if (pathMatch) {
            return pathMatch[1];
        }


        try {
            const mapUrl =
                PAGE
                    .map_js_obj
                    ?.url_mymap_absolute;

            if (mapUrl) {
                const match =
                    mapUrl.match(
                        /\/location\/(\d+)\//
                    );

                if (match) {
                    return match[1];
                }
            }

        } catch (e) {}


        const params =
            new URLSearchParams(
                location.search
            );

        const zones =
            params.getAll('z');

        if (zones.length === 1) {
            return zones[0];
        }


        return null;
    }


    function makeContextKey(
        projectId
    ) {
        if (!projectId) {
            return null;
        }

        return String(
            projectId
        );
    }


    function storageKey(name) {
        if (
            !batchState.contextKey
        ) {
            return null;
        }

        return (
            `sa_batch_project_${batchState.contextKey}_${name}`
        );
    }


    function loadStoredContext() {
        if (
            !batchState.contextKey
        ) {
            batchState.lastSignType =
                null;

            batchState.lastState =
                null;

            batchState.lastDirection =
                0;

            return;
        }


        batchState.lastSignType =
            localStorage.getItem(
                storageKey(
                    'sign_type'
                )
            ) || null;


        batchState.lastState =
            localStorage.getItem(
                storageKey(
                    'state'
                )
            ) || null;


        batchState.lastDirection =
            Number(
                localStorage.getItem(
                    storageKey(
                        'direction'
                    )
                ) || 0
            );
    }


    function refreshContext() {
        const projectId =
            detectProjectId();

        const locationId =
            detectLocationId();

        const newContextKey =
            makeContextKey(
                projectId
            );


        const contextChanged =
            newContextKey &&
            newContextKey !==
                batchState.contextKey;


        const locationChanged =
            locationId &&
            locationId !==
                batchState.locationId;


        if (
            !contextChanged &&
            !locationChanged
        ) {
            return;
        }


        if (
            batchState.queue.length &&
            (
                contextChanged ||
                locationChanged
            )
        ) {
            batchState.queue = [];

            redrawVisualMarkers();
        }


        if (contextChanged) {
            batchState.contextKey =
                newContextKey;

            batchState.projectId =
                projectId;

            batchState.lastSignType =
                null;

            batchState.lastState =
                null;

            batchState.lastDirection =
                0;

            loadStoredContext();

            batchState.enabled =
                false;
        }


        if (locationId) {
            batchState.locationId =
                locationId;
        }


        batchState.pendingPlacement =
            null;

        batchState.lastCompletedDrag =
            null;

        hideDragPreview();

        updatePanel();
    }


    function startContextWatcher() {
        setInterval(
            refreshContext,
            750
        );
    }


    // ============================================================
    // STORED VALUES
    // ============================================================

    function setLastSignType(id) {
        refreshContext();

        if (
            !batchState.contextKey ||
            !id ||
            id === 'null' ||
            id === 'undefined'
        ) {
            return;
        }


        id =
            String(id);


        batchState.lastSignType =
            id;


        localStorage.setItem(
            storageKey(
                'sign_type'
            ),
            id
        );


        updatePanel();
    }


    function setLastState(id) {
        refreshContext();

        if (
            !batchState.contextKey ||
            !id ||
            id === 'null' ||
            id === 'undefined'
        ) {
            return;
        }


        id =
            String(id);


        batchState.lastState =
            id;


        localStorage.setItem(
            storageKey(
                'state'
            ),
            id
        );


        updatePanel();
    }


    function setLastDirection(direction) {
        refreshContext();

        if (
            !batchState.contextKey
        ) {
            return;
        }


        direction =
            normalizeDirection(
                direction
            );


        batchState.lastDirection =
            direction;


        localStorage.setItem(
            storageKey(
                'direction'
            ),
            String(
                direction
            )
        );


        updatePanel();
    }


    // ============================================================
    // LEARN FROM NORMAL SIGNAGENT FORM
    // ============================================================

    document.addEventListener(
        'change',
        function (event) {
            const target =
                event.target;

            if (!target) {
                return;
            }


            if (
                target.matches(
                    '#sign_form [name="sign_template"]'
                )
            ) {
                setLastSignType(
                    target.value
                );
            }


            if (
                target.matches(
                    '#sign_form [name="state"]'
                )
            ) {
                setLastState(
                    target.value
                );
            }


            if (
                target.matches(
                    '#sign_form [name="facing_direction"]'
                )
            ) {
                const value =
                    Number(
                        target.value
                    );

                if (
                    Number.isFinite(
                        value
                    )
                ) {
                    setLastDirection(
                        value
                    );
                }
            }
        },
        true
    );


    document.addEventListener(
        'submit',
        function (event) {
            const form =
                event.target;

            if (
                !form ||
                form.id !==
                    'sign_form'
            ) {
                return;
            }


            refreshContext();


            const signType =
                form.querySelector(
                    '[name="sign_template"]'
                )?.value;


            const state =
                form.querySelector(
                    '[name="state"]'
                )?.value;


            const direction =
                Number(
                    form.querySelector(
                        '[name="facing_direction"]'
                    )?.value
                );


            if (signType) {
                setLastSignType(
                    signType
                );
            }


            if (state) {
                setLastState(
                    state
                );
            }


            if (
                Number.isFinite(
                    direction
                )
            ) {
                setLastDirection(
                    direction
                );
            }
        },
        true
    );


    // ============================================================
    // RESOURCE WATCHER
    // ============================================================

    function inspectResourceUrl(rawUrl) {
        try {
            const url =
                new URL(
                    rawUrl,
                    location.origin
                );


            const match =
                url.pathname.match(
                    /\/organization\/(\d+)\/current_sign_json\//
                );


            if (!match) {
                return;
            }


            refreshContext();


            const signType =
                url.searchParams.get(
                    'st_id'
                );


            const state =
                url.searchParams.get(
                    'state_id'
                );


            if (signType) {
                setLastSignType(
                    signType
                );
            }


            if (state) {
                setLastState(
                    state
                );
            }

        } catch (e) {}
    }


    function startResourceObserver() {
        try {
            performance
                .getEntriesByType(
                    'resource'
                )
                .forEach(
                    entry =>
                        inspectResourceUrl(
                            entry.name
                        )
                );
        } catch (e) {}


        try {
            const observer =
                new PerformanceObserver(
                    list => {
                        for (
                            const entry
                            of list.getEntries()
                        ) {
                            inspectResourceUrl(
                                entry.name
                            );
                        }
                    }
                );


            observer.observe({
                entryTypes: [
                    'resource'
                ]
            });

        } catch (e) {}
    }


    // ============================================================
    // PROJECTION
    // ============================================================

    function getProjection() {
        try {
            if (
                typeof PAGE.projection ===
                'function'
            ) {
                return PAGE.projection;
            }
        } catch (e) {}


        return null;
    }


    // ============================================================
    // FIND SIGNAGENT MAP NODE
    // ============================================================

    function nodeHasContextMenuListener(
        node
    ) {
        if (!node) {
            return false;
        }


        try {
            const listeners =
                node.__on;


            if (
                !Array.isArray(
                    listeners
                )
            ) {
                return false;
            }


            return listeners.some(
                listener =>
                    listener &&
                    listener.type ===
                        'contextmenu'
            );

        } catch (e) {
            return false;
        }
    }


    function findSignAgentMapNode(target) {
        let node =
            target;


        while (node) {
            if (
                nodeHasContextMenuListener(
                    node
                )
            ) {
                return node;
            }


            node =
                node.parentNode;
        }


        const candidates =
            document.querySelectorAll(
                'svg, svg *'
            );


        for (
            const candidate
            of candidates
        ) {
            if (
                nodeHasContextMenuListener(
                    candidate
                )
            ) {
                return candidate;
            }
        }


        return null;
    }


    function findAnySignAgentMapNode() {
        const candidates =
            document.querySelectorAll(
                'svg, svg *'
            );


        for (
            const candidate
            of candidates
        ) {
            if (
                nodeHasContextMenuListener(
                    candidate
                )
            ) {
                return candidate;
            }
        }


        return null;
    }


    // ============================================================
    // INITIAL POSITION CAPTURE
    // ============================================================

    function captureMapPosition(
        clientX,
        clientY,
        eventTarget
    ) {
        const projection =
            getProjection();


        if (!projection) {
            return null;
        }


        const mapNode =
            findSignAgentMapNode(
                eventTarget
            );


        if (!mapNode) {
            return null;
        }


        try {
            const svg =
                mapNode.ownerSVGElement ||
                (
                    mapNode
                        .tagName
                        ?.toLowerCase() ===
                    'svg'
                        ? mapNode
                        : null
                );


            if (
                !svg ||
                typeof svg.createSVGPoint !==
                    'function'
            ) {
                return null;
            }


            const ctm =
                mapNode.getScreenCTM();


            if (!ctm) {
                return null;
            }


            const point =
                svg.createSVGPoint();


            point.x =
                clientX;

            point.y =
                clientY;


            const local =
                point.matrixTransform(
                    ctm.inverse()
                );


            const coords =
                projection.invert([
                    local.x,
                    local.y
                ]);


            if (
                !coords ||
                coords.length < 2
            ) {
                return null;
            }


            return {
                lng:
                    coords[0],

                lat:
                    coords[1]
            };

        } catch (error) {
            console.error(
                '[SA Batch] Position capture failed:',
                error
            );


            return null;
        }
    }


    // ============================================================
    // DIRECTION
    // ============================================================

    function calculateDirection(
        startX,
        startY,
        endX,
        endY
    ) {
        const dx =
            endX - startX;

        const dy =
            endY - startY;


        const distance =
            Math.hypot(
                dx,
                dy
            );


        if (distance < 10) {
            return {
                direction:
                    batchState.lastDirection,

                distance
            };
        }


        let degrees =
            Math.atan2(
                dx,
                -dy
            ) *
            180 /
            Math.PI;


        degrees =
            normalizeDirection(
                degrees
            );


        degrees =
            Math.round(
                degrees / 15
            ) * 15;


        degrees =
            normalizeDirection(
                degrees
            );


        return {
            direction:
                degrees,

            distance
        };
    }


    // ============================================================
    // DRAG PREVIEW
    // ============================================================

    function getDragPreview() {
        return (
            document.getElementById(
                'sa-direction-preview'
            )
        );
    }


    function createDragPreview() {
        let preview =
            getDragPreview();


        if (preview) {
            return preview;
        }


        preview =
            document.createElement(
                'div'
            );


        preview.id =
            'sa-direction-preview';


        Object.assign(
            preview.style,
            {
                position:
                    'fixed',

                zIndex:
                    '2147483644',

                pointerEvents:
                    'none',

                display:
                    'none',

                transformOrigin:
                    '0 50%',

                height:
                    '3px',

                background:
                    '#111'
            }
        );


        const arrow =
            document.createElement(
                'div'
            );


        Object.assign(
            arrow.style,
            {
                position:
                    'absolute',

                right:
                    '-1px',

                top:
                    '-5px',

                borderTop:
                    '6px solid transparent',

                borderBottom:
                    '6px solid transparent',

                borderLeft:
                    '10px solid #111'
            }
        );


        const label =
            document.createElement(
                'div'
            );


        label.className =
            'sa-direction-label';


        Object.assign(
            label.style,
            {
                position:
                    'absolute',

                right:
                    '-22px',

                top:
                    '-29px',

                background:
                    '#111',

                color:
                    '#fff',

                borderRadius:
                    '4px',

                padding:
                    '3px 6px',

                fontSize:
                    '11px',

                fontWeight:
                    '700',

                whiteSpace:
                    'nowrap'
            }
        );


        preview.appendChild(
            arrow
        );

        preview.appendChild(
            label
        );


        document.body.appendChild(
            preview
        );


        return preview;
    }


    function updateDragPreview() {
        if (
            !batchState.drag.active
        ) {
            return;
        }


        const preview =
            createDragPreview();


        const {
            startX,
            startY,
            currentX,
            currentY,
            direction,
            distance
        } =
            batchState.drag;


        const dx =
            currentX - startX;

        const dy =
            currentY - startY;


        const screenAngle =
            Math.atan2(
                dy,
                dx
            ) *
            180 /
            Math.PI;


        preview.style.display =
            'block';


        preview.style.left =
            startX + 'px';


        preview.style.top =
            startY + 'px';


        preview.style.width =
            Math.max(
                distance,
                10
            ) + 'px';


        preview.style.transform =
            `rotate(${screenAngle}deg)`;


        const label =
            preview.querySelector(
                '.sa-direction-label'
            );


        if (label) {
            label.textContent =
                `${direction}°`;


            label.style.transform =
                `rotate(${-screenAngle}deg)`;
        }
    }


    function hideDragPreview() {
        const preview =
            getDragPreview();


        if (preview) {
            preview.style.display =
                'none';
        }
    }


    // ============================================================
    // QUEUED MARKERS
    // ============================================================

    function directionArrow(direction) {
        direction =
            normalizeDirection(
                direction
            );


        if (
            direction >= 337.5 ||
            direction < 22.5
        ) return '↑';

        if (
            direction < 67.5
        ) return '↗';

        if (
            direction < 112.5
        ) return '→';

        if (
            direction < 157.5
        ) return '↘';

        if (
            direction < 202.5
        ) return '↓';

        if (
            direction < 247.5
        ) return '↙';

        if (
            direction < 292.5
        ) return '←';


        return '↖';
    }


    function mapPointToScreen(item) {
        const projection =
            getProjection();


        if (!projection) {
            return null;
        }


        const mapNode =
            findAnySignAgentMapNode();


        if (!mapNode) {
            return null;
        }


        try {
            const projected =
                projection([
                    Number(item.lng),
                    Number(item.lat)
                ]);


            if (
                !projected ||
                projected.length < 2
            ) {
                return null;
            }


            const svg =
                mapNode.ownerSVGElement ||
                (
                    mapNode
                        .tagName
                        ?.toLowerCase() ===
                    'svg'
                        ? mapNode
                        : null
                );


            if (
                !svg ||
                typeof svg.createSVGPoint !==
                    'function'
            ) {
                return null;
            }


            const ctm =
                mapNode.getScreenCTM();


            if (!ctm) {
                return null;
            }


            const point =
                svg.createSVGPoint();


            point.x =
                projected[0];

            point.y =
                projected[1];


            const screen =
                point.matrixTransform(
                    ctm
                );


            return {
                x:
                    screen.x,

                y:
                    screen.y
            };

        } catch (e) {
            return null;
        }
    }


    function redrawVisualMarkers() {
        document
            .querySelectorAll(
                '.sa-batch-temp-marker'
            )
            .forEach(
                el => el.remove()
            );


        batchState.queue.forEach(
            (item, index) => {
                const wrapper =
                    document.createElement(
                        'div'
                    );


                wrapper.className =
                    'sa-batch-temp-marker';


                Object.assign(
                    wrapper.style,
                    {
                        position:
                            'fixed',

                        transform:
                            'translate(-50%, -50%)',

                        zIndex:
                            '2147483645',

                        pointerEvents:
                            'none',

                        fontFamily:
                            'Arial, sans-serif'
                    }
                );


                const circle =
                    document.createElement(
                        'div'
                    );


                circle.textContent =
                    String(
                        index + 1
                    );


                Object.assign(
                    circle.style,
                    {
                        width:
                            '24px',

                        height:
                            '24px',

                        borderRadius:
                            '50%',

                        background:
                            '#111',

                        color:
                            '#fff',

                        border:
                            '2px solid #fff',

                        display:
                            'flex',

                        alignItems:
                            'center',

                        justifyContent:
                            'center',

                        fontSize:
                            '11px',

                        fontWeight:
                            '700',

                        boxShadow:
                            '0 1px 6px rgba(0,0,0,.45)'
                    }
                );


                const label =
                    document.createElement(
                        'div'
                    );


                label.className =
                    'sa-batch-temp-marker-direction';


                Object.assign(
                    label.style,
                    {
                        position:
                            'absolute',

                        left:
                            '28px',

                        top:
                            '2px',

                        whiteSpace:
                            'nowrap',

                        background:
                            '#fff',

                        color:
                            '#111',

                        border:
                            '1px solid #aaa',

                        borderRadius:
                            '3px',

                        padding:
                            '2px 5px',

                        fontSize:
                            '10px',

                        fontWeight:
                            '700'
                    }
                );


                label.textContent =
                    `${directionArrow(
                        item.facingDirection
                    )} ${item.facingDirection}°`;


                wrapper.appendChild(
                    circle
                );

                wrapper.appendChild(
                    label
                );


                document.body.appendChild(
                    wrapper
                );
            }
        );


        refreshQueuedMarkerPositions();
    }


    function refreshQueuedMarkerPositions() {
        const markers =
            document.querySelectorAll(
                '.sa-batch-temp-marker'
            );


        batchState.queue.forEach(
            (item, index) => {
                const marker =
                    markers[index];


                if (!marker) {
                    return;
                }


                const screen =
                    mapPointToScreen(
                        item
                    );


                if (!screen) {
                    marker.style.display =
                        'none';

                    return;
                }


                marker.style.display =
                    'block';


                marker.style.left =
                    screen.x + 'px';


                marker.style.top =
                    screen.y + 'px';
            }
        );
    }


    function startMarkerTrackingLoop() {
        function frame() {
            if (
                batchState.enabled &&
                batchState.queue.length
            ) {
                refreshQueuedMarkerPositions();
            }


            requestAnimationFrame(
                frame
            );
        }


        requestAnimationFrame(
            frame
        );
    }


    // ============================================================
    // RIGHT MOUSE DOWN
    // ============================================================

    document.addEventListener(
        'pointerdown',
        function (event) {
            if (
                !batchState.enabled ||
                event.button !== 2
            ) {
                return;
            }


            refreshContext();


            const mapPosition =
                captureMapPosition(
                    event.clientX,
                    event.clientY,
                    event.target
                );


            batchState.drag.active =
                true;


            batchState.drag.startX =
                event.clientX;

            batchState.drag.startY =
                event.clientY;


            batchState.drag.currentX =
                event.clientX;

            batchState.drag.currentY =
                event.clientY;


            batchState.drag.direction =
                batchState.lastDirection;


            batchState.drag.distance =
                0;


            batchState.drag.initialLat =
                mapPosition?.lat ??
                null;


            batchState.drag.initialLng =
                mapPosition?.lng ??
                null;


            batchState.drag.queuedIndex =
                null;


            batchState.pendingPlacement = {
                facingDirection:
                    batchState.lastDirection,

                initialLat:
                    batchState.drag
                        .initialLat,

                initialLng:
                    batchState.drag
                        .initialLng
            };


            updateDragPreview();
        },
        true
    );


    // ============================================================
    // DRAG
    // ============================================================

    document.addEventListener(
        'pointermove',
        function (event) {
            if (
                !batchState.enabled ||
                !batchState.drag.active
            ) {
                return;
            }


            batchState.drag.currentX =
                event.clientX;

            batchState.drag.currentY =
                event.clientY;


            const result =
                calculateDirection(
                    batchState.drag.startX,
                    batchState.drag.startY,
                    event.clientX,
                    event.clientY
                );


            batchState.drag.direction =
                result.direction;


            batchState.drag.distance =
                result.distance;


            if (
                batchState.pendingPlacement
            ) {
                batchState
                    .pendingPlacement
                    .facingDirection =
                    result.direction;
            }


            if (
                batchState.drag.queuedIndex !==
                null
            ) {
                const item =
                    batchState.queue[
                        batchState.drag
                            .queuedIndex
                    ];


                if (item) {
                    item.facingDirection =
                        result.direction;
                }
            }


            updateDragPreview();
        },
        true
    );


    // ============================================================
    // RIGHT MOUSE UP
    // ============================================================

    document.addEventListener(
        'pointerup',
        function (event) {
            if (
                !batchState.enabled ||
                event.button !== 2 ||
                !batchState.drag.active
            ) {
                return;
            }


            const result =
                calculateDirection(
                    batchState.drag.startX,
                    batchState.drag.startY,
                    event.clientX,
                    event.clientY
                );


            setLastDirection(
                result.direction
            );


            const completed = {
                facingDirection:
                    result.direction,

                initialLat:
                    batchState.drag
                        .initialLat,

                initialLng:
                    batchState.drag
                        .initialLng,

                completedAt:
                    Date.now()
            };


            batchState.lastCompletedDrag =
                completed;


            if (
                batchState.drag.queuedIndex !==
                null
            ) {
                const item =
                    batchState.queue[
                        batchState.drag
                            .queuedIndex
                    ];


                if (item) {
                    item.facingDirection =
                        result.direction;


                    if (
                        completed.initialLat !==
                            null &&
                        completed.initialLng !==
                            null
                    ) {
                        item.lat =
                            String(
                                completed.initialLat
                            );

                        item.lng =
                            String(
                                completed.initialLng
                            );
                    }


                    redrawVisualMarkers();
                    updatePanel();
                }
            }


            batchState.pendingPlacement =
                completed;


            batchState.drag.active =
                false;


            hideDragPreview();
        },
        true
    );


    // ============================================================
    // CONTEXT MENU
    // ============================================================

    document.addEventListener(
        'contextmenu',
        function () {
            if (
                !batchState.enabled
            ) {
                return;
            }


            if (
                batchState.drag.active
            ) {
                batchState.pendingPlacement = {
                    facingDirection:
                        batchState.drag.direction,

                    initialLat:
                        batchState.drag.initialLat,

                    initialLng:
                        batchState.drag.initialLng
                };


                return;
            }


            if (
                batchState.lastCompletedDrag &&
                Date.now() -
                    batchState
                        .lastCompletedDrag
                        .completedAt <
                    1200
            ) {
                batchState.pendingPlacement = {
                    ...batchState
                        .lastCompletedDrag
                };
            }
        },
        true
    );


    // ============================================================
    // QUEUE CREATE URL
    // ============================================================

    function queueCreateUrl(rawUrl) {
        refreshContext();


        let url;


        try {
            url =
                new URL(
                    rawUrl,
                    location.origin
                );

        } catch (e) {
            return false;
        }


        const signAgentLat =
            url.searchParams.get(
                'lat'
            );


        const signAgentLng =
            url.searchParams.get(
                'lng'
            );


        const altitude =
            url.searchParams.get(
                'altitude'
            );


        const placement =
            batchState.pendingPlacement;


        let lat;
        let lng;


        if (
            placement &&
            placement.initialLat !==
                null &&
            placement.initialLng !==
                null
        ) {
            lat =
                placement.initialLat;

            lng =
                placement.initialLng;

        } else {
            lat =
                signAgentLat;

            lng =
                signAgentLng;
        }


        if (
            lat === null ||
            lng === null ||
            typeof lat ===
                'undefined' ||
            typeof lng ===
                'undefined'
        ) {
            return false;
        }


        const item = {
            projectId:
                batchState.projectId,

            locationId:
                batchState.locationId,

            lat:
                String(lat),

            lng:
                String(lng),

            altitude,

            facingDirection:
                normalizeDirection(
                    placement
                        ?.facingDirection ??
                    batchState.lastDirection
                )
        };


        batchState.queue.push(
            item
        );


        if (
            batchState.drag.active
        ) {
            batchState.drag.queuedIndex =
                batchState.queue.length -
                1;
        }


        batchState.pendingPlacement =
            null;


        redrawVisualMarkers();
        updatePanel();


        return true;
    }


    // ============================================================
    // HOTLINK HOOK
    // ============================================================

    function tryHookHotlink() {
        if (
            batchState.hotlinkHooked
        ) {
            return;
        }


        if (
            typeof PAGE.hotlink !==
            'function'
        ) {
            return;
        }


        batchState.originalHotlink =
            PAGE.hotlink;


        PAGE.hotlink =
            function (...args) {
                const url =
                    args[0];


                if (
                    batchState.enabled &&
                    typeof url ===
                        'string' &&
                    url.includes(
                        '/sign/create/'
                    ) &&
                    url.includes(
                        'lat='
                    ) &&
                    url.includes(
                        'lng='
                    )
                ) {
                    if (
                        queueCreateUrl(
                            url
                        )
                    ) {
                        return;
                    }
                }


                return (
                    batchState
                        .originalHotlink
                        .apply(
                            this,
                            args
                        )
                );
            };


        batchState.hotlinkHooked =
            true;


        updatePanel();
    }


    function startHotlinkWatcher() {
        const timer =
            setInterval(
                function () {
                    tryHookHotlink();


                    if (
                        batchState.hotlinkHooked
                    ) {
                        clearInterval(
                            timer
                        );
                    }
                },
                250
            );


        setTimeout(
            () =>
                clearInterval(
                    timer
                ),
            30000
        );
    }


    // ============================================================
    // CREATE SIGN
    // ============================================================

    async function createSign(
        item,
        signType,
        signState,
        locationId
    ) {
        if (
            item.projectId !==
            batchState.projectId
        ) {
            throw new Error(
                'Queued sign belongs to a different project.'
            );
        }


        if (
            item.locationId !==
            batchState.locationId
        ) {
            throw new Error(
                'Queued sign belongs to a different location.'
            );
        }


        const csrf =
            getCsrfToken();


        if (!csrf) {
            throw new Error(
                'Could not find SignAgent CSRF token.'
            );
        }


        const data =
            new FormData();


        data.append(
            'csrfmiddlewaretoken',
            csrf
        );


        data.append(
            'sign_template',
            signType
        );


        data.append(
            'zone',
            locationId
        );


        data.append(
            'number',
            ''
        );


        data.append(
            'quantity',
            '1'
        );


        data.append(
            'facing_direction',
            String(
                item.facingDirection
            )
        );


        data.append(
            'position',
            ''
        );


        data.append(
            'is_zone_boundary',
            'False'
        );


        data.append(
            'smart_state_change',
            ''
        );


        data.append(
            'new_st_short_code',
            ''
        );


        data.append(
            'new_st_name',
            ''
        );


        data.append(
            'state',
            signState
        );


        data.append(
            'lat',
            item.lat
        );


        data.append(
            'lng',
            item.lng
        );


        const response =
            await fetch(
                '/sign/create/',
                {
                    method:
                        'POST',

                    credentials:
                        'same-origin',

                    headers: {
                        'X-CSRFToken':
                            csrf,

                        'X-Requested-With':
                            'XMLHttpRequest'
                    },

                    body:
                        data
                }
            );


        const text =
            await response.text();


        if (!response.ok) {
            throw new Error(
                `SignAgent returned HTTP ${response.status}.`
            );
        }


        let result;


        try {
            result =
                JSON.parse(
                    text
                );

        } catch (error) {
            const parser =
                new DOMParser();


            const html =
                parser.parseFromString(
                    text,
                    'text/html'
                );


            const errors = [
                ...html.querySelectorAll(
                    '.help-block.has-error, .alert-danger'
                )
            ]
                .map(
                    el =>
                        el.textContent
                            .trim()
                            .replace(
                                /\s+/g,
                                ' '
                            )
                )
                .filter(Boolean);


            throw new Error(
                errors.length
                    ? errors.join(' | ')
                    : 'SignAgent returned the Create Sign form instead of confirming creation.'
            );
        }


        if (
            !result.success_url
        ) {
            throw new Error(
                'SignAgent did not return a success URL.'
            );
        }


        return result;
    }


    // ============================================================
    // SAVE ALL
    // ============================================================

    async function saveAll() {
        if (
            batchState.saving
        ) {
            return;
        }


        refreshContext();


        if (
            !batchState.projectId
        ) {
            alert(
                'Could not determine the current SignAgent project.'
            );

            return;
        }


        if (
            !batchState.locationId
        ) {
            alert(
                'Could not determine the current SignAgent location.'
            );

            return;
        }


        if (
            !batchState.queue.length
        ) {
            alert(
                'No signs are queued.'
            );

            return;
        }


        if (
            !batchState.lastSignType
        ) {
            alert(
                'No Sign Type has been learned for this project yet.'
            );

            return;
        }


        if (
            !batchState.lastState
        ) {
            alert(
                'No State has been learned for this project yet.'
            );

            return;
        }


        const badItem =
            batchState.queue.find(
                item =>
                    item.projectId !==
                        batchState.projectId ||
                    item.locationId !==
                        batchState.locationId
            );


        if (badItem) {
            alert(
                'The queue contains a sign from another project or location. The queue has been cleared.'
            );


            batchState.queue =
                [];


            redrawVisualMarkers();
            updatePanel();


            return;
        }


        const count =
            batchState.queue.length;


        const confirmed =
            confirm(
                `Create ${count} sign${count === 1 ? '' : 's'}?\n\n` +
                `Project: ${batchState.projectId}\n` +
                `Location: ${batchState.locationId}\n` +
                `Sign Type: ${batchState.lastSignType}\n` +
                `State: ${batchState.lastState}`
            );


        if (!confirmed) {
            return;
        }


        batchState.saving =
            true;


        updatePanel();


        let completed =
            0;


        try {
            for (
                const item
                of batchState.queue
            ) {
                setStatus(
                    `Saving ${completed + 1} / ${count}...`
                );


                await createSign(
                    item,
                    batchState.lastSignType,
                    batchState.lastState,
                    batchState.locationId
                );


                completed++;


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            125
                        )
                );
            }


            batchState.queue =
                [];


            redrawVisualMarkers();


            setStatus(
                `Saved ${completed} sign${completed === 1 ? '' : 's'}.`
            );


            updatePanel();


            setTimeout(
                () =>
                    location.reload(),
                700
            );

        } catch (error) {

            if (
                completed > 0
            ) {
                batchState.queue.splice(
                    0,
                    completed
                );
            }


            redrawVisualMarkers();
            updatePanel();


            console.error(
                '[SA Batch] Save failed:',
                error
            );


            alert(
                `Batch save stopped after ${completed} of ${count} signs.\n\n${error.message}`
            );

        } finally {
            batchState.saving =
                false;


            updatePanel();
        }
    }


    // ============================================================
    // TOP BAR UI
    // ============================================================

    let topBarControl = null;
    let detailsPanel = null;

    let statusEl = null;

    let projectEl = null;
    let locationEl = null;
    let countEl = null;
    let typeEl = null;
    let stateEl = null;
    let directionEl = null;
    let hookEl = null;

    let toggleInput = null;
    let expandButton = null;
    let saveButton = null;
    let topSaveButton = null;

    let detailsOpen = false;


    function setStatus(text) {
        if (statusEl) {
            statusEl.textContent =
                text;
        }
    }


    function setBatchEnabled(desiredState) {
        refreshContext();


        if (desiredState) {

            if (!batchState.projectId) {
                alert(
                    'Project has not been detected.'
                );

                updatePanel();
                return false;
            }


            if (!batchState.locationId) {
                alert(
                    'Location has not been detected.'
                );

                updatePanel();
                return false;
            }


            if (!batchState.hotlinkHooked) {
                alert(
                    'Batch Place has not hooked into SignAgent yet.'
                );

                updatePanel();
                return false;
            }


            if (
                !batchState.lastSignType ||
                !batchState.lastState
            ) {
                alert(
                    'This project does not have a learned Sign Type and State yet.\n\n' +
                    'Create or edit one sign normally first.'
                );

                updatePanel();
                return false;
            }
        }


        batchState.enabled =
            desiredState;


        hideDragPreview();


        setStatus(
            batchState.enabled
                ? 'Batch Place is active.'
                : 'Normal SignAgent mode.'
        );


        updatePanel();

        return true;
    }


    function findSignAgentTopBar() {
        const selectors = [
            '.navbar .navbar-right',
            '.navbar .navbar-nav',
            '.navbar',
            'nav.navbar',
            'header .navbar',
            'header'
        ];


        for (const selector of selectors) {
            const elements =
                document.querySelectorAll(
                    selector
                );


            for (const element of elements) {
                const rect =
                    element.getBoundingClientRect();


                if (
                    rect.width > 300 &&
                    rect.top < 100 &&
                    rect.height > 20
                ) {
                    return element;
                }
            }
        }


        return null;
    }


    function updatePanel() {
        if (!topBarControl) {
            return;
        }


        if (projectEl) {
            projectEl.textContent =
                batchState.projectId ||
                'Not detected';
        }


        if (locationEl) {
            locationEl.textContent =
                batchState.locationId ||
                'Not detected';
        }


        if (countEl) {
            countEl.textContent =
                batchState.queue.length;
        }


        if (typeEl) {
            typeEl.textContent =
                batchState.lastSignType ||
                'Not detected';
        }


        if (stateEl) {
            stateEl.textContent =
                batchState.lastState ||
                'Not detected';
        }


        if (directionEl) {
            directionEl.textContent =
                `${batchState.lastDirection}°`;
        }


        if (hookEl) {
            hookEl.textContent =
                batchState.hotlinkHooked
                    ? 'Ready'
                    : 'Waiting';
        }


        if (toggleInput) {
            toggleInput.checked =
                batchState.enabled;
        }


        const switchTrack =
            topBarControl.querySelector(
                '.sa-batch-switch-track'
            );


        const switchKnob =
            topBarControl.querySelector(
                '.sa-batch-switch-knob'
            );


        if (switchTrack) {
            switchTrack.style.background =
                batchState.enabled
                    ? '#198754'
                    : '#aaa';
        }


        if (switchKnob) {
            switchKnob.style.transform =
                batchState.enabled
                    ? 'translateX(18px)'
                    : 'translateX(0)';
        }


        const badge =
            topBarControl.querySelector(
                '#sa-batch-top-count'
            );


        if (badge) {
            badge.textContent =
                batchState.queue.length;


            badge.style.display =
                batchState.queue.length
                    ? 'inline-flex'
                    : 'none';
        }


        if (saveButton) {
            saveButton.disabled =
                batchState.saving ||
                !batchState.queue.length;


            saveButton.textContent =
                batchState.saving
                    ? 'Saving...'
                    : `Save All (${batchState.queue.length})`;
        }


        if (topSaveButton) {
            topSaveButton.disabled =
                batchState.saving ||
                !batchState.queue.length;


            topSaveButton.textContent =
                batchState.saving
                    ? 'Saving...'
                    : `Save All (${batchState.queue.length})`;


            topSaveButton.style.opacity =
                topSaveButton.disabled
                    ? '0.5'
                    : '1';


            topSaveButton.style.cursor =
                topSaveButton.disabled
                    ? 'default'
                    : 'pointer';
        }
    }


    function setDetailsOpen(open) {
        detailsOpen =
            open;


        if (detailsPanel) {
            detailsPanel.style.display =
                detailsOpen
                    ? 'block'
                    : 'none';
        }


        if (expandButton) {
            expandButton.textContent =
                detailsOpen
                    ? '▲'
                    : '▼';
        }
    }


    function createPanel() {
        if (
            document.getElementById(
                'sa-batch-top-control'
            )
        ) {
            return;
        }


        const topBar =
            findSignAgentTopBar();


        if (!topBar) {
            setTimeout(
                createPanel,
                500
            );

            return;
        }


        topBarControl =
            document.createElement(
                'div'
            );


        topBarControl.id =
            'sa-batch-top-control';


        Object.assign(
            topBarControl.style,
            {
                position:
                    'relative',

                display:
                    'inline-flex',

                alignItems:
                    'center',

                padding:
                    '2px 6px',

                margin:
                    '0 5px',

                color:
                    '#444',

                fontFamily:
                    'Arial, sans-serif',

                fontSize:
                    '12px',

                whiteSpace:
                    'nowrap',

                verticalAlign:
                    'middle',

                zIndex:
                    '2147483645'
            }
        );


        topBarControl.innerHTML = `
            <div
                style="
                    display:flex;
                    flex-direction:column;
                    align-items:stretch;
                    gap:3px;
                "
            >

                <div
                    style="
                        display:flex;
                        align-items:center;
                        gap:7px;
                        justify-content:center;
                    "
                >

                    <span
                        style="
                            font-weight:600;
                            white-space:nowrap;
                        "
                    >
                        Batch Place
                    </span>


                    <span
                        id="sa-batch-top-count"
                        style="
                            display:none;
                            min-width:18px;
                            height:18px;
                            padding:0 4px;
                            border-radius:9px;
                            background:#555;
                            color:#fff;
                            align-items:center;
                            justify-content:center;
                            font-size:10px;
                            font-weight:700;
                        "
                    >
                        0
                    </span>


                    <label
                        style="
                            position:relative;
                            display:inline-block;
                            width:38px;
                            height:20px;
                            margin:0;
                            cursor:pointer;
                        "
                    >

                        <input
                            id="sa-batch-toggle-input"
                            type="checkbox"
                            style="
                                position:absolute;
                                opacity:0;
                                width:0;
                                height:0;
                            "
                        >

                        <span
                            class="sa-batch-switch-track"
                            style="
                                position:absolute;
                                inset:0;
                                border-radius:10px;
                                background:#aaa;
                                transition:background .15s ease;
                            "
                        ></span>

                        <span
                            class="sa-batch-switch-knob"
                            style="
                                position:absolute;
                                width:16px;
                                height:16px;
                                left:2px;
                                top:2px;
                                border-radius:50%;
                                background:#fff;
                                box-shadow:0 1px 3px rgba(0,0,0,.35);
                                transition:transform .15s ease;
                            "
                        ></span>

                    </label>


                    <button
                        id="sa-batch-expand"
                        type="button"
                        title="Batch Place details"
                        style="
                            border:0;
                            background:transparent;
                            padding:4px 5px;
                            margin:0;
                            cursor:pointer;
                            color:#555;
                            font-size:11px;
                            line-height:1;
                        "
                    >
                        ▼
                    </button>

                </div>


                <button
                    id="sa-batch-top-save"
                    type="button"
                    style="
                        width:100%;
                        height:22px;
                        padding:2px 8px;
                        border:1px solid #aaa;
                        border-radius:3px;
                        background:#f5f5f5;
                        color:#333;
                        font-size:10px;
                        font-weight:600;
                        cursor:pointer;
                        line-height:1;
                    "
                >
                    Save All (0)
                </button>

            </div>
        `;


        detailsPanel =
            document.createElement(
                'div'
            );


        detailsPanel.id =
            'sa-batch-details';


        Object.assign(
            detailsPanel.style,
            {
                position:
                    'absolute',

                top:
                    '52px',

                right:
                    '0',

                width:
                    '275px',

                display:
                    'none',

                background:
                    '#fff',

                color:
                    '#222',

                border:
                    '1px solid #bbb',

                borderRadius:
                    '5px',

                boxShadow:
                    '0 5px 18px rgba(0,0,0,.25)',

                padding:
                    '12px',

                zIndex:
                    '2147483647',

                fontFamily:
                    'Arial, sans-serif',

                fontSize:
                    '12px'
            }
        );


        detailsPanel.innerHTML = `
            <div
                style="
                    font-size:13px;
                    font-weight:700;
                    margin-bottom:9px;
                "
            >
                Batch Place Details
            </div>


            <div
                style="
                    line-height:1.8;
                "
            >
                Project:
                <strong id="sa-batch-project"></strong>
                <br>

                Location:
                <strong id="sa-batch-location"></strong>
                <br>

                Sign Type:
                <strong id="sa-batch-type"></strong>
                <br>

                State:
                <strong id="sa-batch-state"></strong>
                <br>

                Direction:
                <strong id="sa-batch-direction"></strong>
                <br>

                Hook:
                <strong id="sa-batch-hook"></strong>
                <br>

                Queued:
                <strong id="sa-batch-count"></strong>
            </div>


            <div
                id="sa-batch-status"
                style="
                    margin-top:8px;
                    min-height:16px;
                    color:#666;
                    font-size:11px;
                "
            ></div>


            <div
                style="
                    display:flex;
                    gap:6px;
                    margin-top:10px;
                "
            >
                <button
                    id="sa-batch-undo"
                    type="button"
                    style="
                        flex:1;
                        padding:6px;
                        cursor:pointer;
                    "
                >
                    Undo
                </button>


                <button
                    id="sa-batch-clear"
                    type="button"
                    style="
                        flex:1;
                        padding:6px;
                        cursor:pointer;
                    "
                >
                    Cancel
                </button>
            </div>


            <button
                id="sa-batch-save"
                type="button"
                style="
                    width:100%;
                    margin-top:6px;
                    padding:8px;
                    font-weight:700;
                    cursor:pointer;
                "
            >
                Save All
            </button>
        `;


        topBarControl.appendChild(
            detailsPanel
        );


        topBar.appendChild(
            topBarControl
        );


        toggleInput =
            topBarControl.querySelector(
                '#sa-batch-toggle-input'
            );


        expandButton =
            topBarControl.querySelector(
                '#sa-batch-expand'
            );


        topSaveButton =
            topBarControl.querySelector(
                '#sa-batch-top-save'
            );


        projectEl =
            detailsPanel.querySelector(
                '#sa-batch-project'
            );


        locationEl =
            detailsPanel.querySelector(
                '#sa-batch-location'
            );


        countEl =
            detailsPanel.querySelector(
                '#sa-batch-count'
            );


        typeEl =
            detailsPanel.querySelector(
                '#sa-batch-type'
            );


        stateEl =
            detailsPanel.querySelector(
                '#sa-batch-state'
            );


        directionEl =
            detailsPanel.querySelector(
                '#sa-batch-direction'
            );


        hookEl =
            detailsPanel.querySelector(
                '#sa-batch-hook'
            );


        statusEl =
            detailsPanel.querySelector(
                '#sa-batch-status'
            );


        saveButton =
            detailsPanel.querySelector(
                '#sa-batch-save'
            );


        toggleInput.addEventListener(
            'change',
            function () {
                const desiredState =
                    toggleInput.checked;


                const success =
                    setBatchEnabled(
                        desiredState
                    );


                if (!success) {
                    toggleInput.checked =
                        batchState.enabled;
                }


                updatePanel();
            }
        );


        expandButton.addEventListener(
            'click',
            function (event) {
                event.preventDefault();
                event.stopPropagation();


                setDetailsOpen(
                    !detailsOpen
                );
            }
        );


        detailsPanel.addEventListener(
            'click',
            function (event) {
                event.stopPropagation();
            }
        );


        document.addEventListener(
            'click',
            function (event) {
                if (
                    detailsOpen &&
                    topBarControl &&
                    !topBarControl.contains(
                        event.target
                    )
                ) {
                    setDetailsOpen(
                        false
                    );
                }
            }
        );


        detailsPanel
            .querySelector(
                '#sa-batch-undo'
            )
            .addEventListener(
                'click',
                function () {
                    batchState.queue.pop();


                    redrawVisualMarkers();
                    updatePanel();
                }
            );


        detailsPanel
            .querySelector(
                '#sa-batch-clear'
            )
            .addEventListener(
                'click',
                function () {
                    if (
                        batchState.queue.length &&
                        !confirm(
                            'Discard all queued signs?'
                        )
                    ) {
                        return;
                    }


                    batchState.queue =
                        [];


                    redrawVisualMarkers();
                    updatePanel();
                }
            );


        saveButton.addEventListener(
            'click',
            saveAll
        );


        topSaveButton.addEventListener(
            'click',
            saveAll
        );


        updatePanel();
    }


    // ============================================================
    // INIT
    // ============================================================

    startResourceObserver();
    startHotlinkWatcher();
    startContextWatcher();


    function init() {
        if (
            !document.body
        ) {
            setTimeout(
                init,
                100
            );

            return;
        }


        createPanel();
        createDragPreview();
        startMarkerTrackingLoop();


        refreshContext();


        log(
            'SignAgent Batch Place v1.0.0 loaded.'
        );
    }


    init();

})();
