# SignAgent Scripts

Company-maintained Tampermonkey userscripts used by Sign Brothers to improve SignAgent workflows and UI/UX.

## Canonical ownership

This repository is the Sign Brothers source of truth for maintained SignAgent userscripts going forward.

## Current scripts

### SignAgentBatchPlaceFriendlyNames.user.js

Production Batch Place install for Sign Brothers.

This script loads the frozen, known-good Batch Place v1.0.0 baseline from its immutable import commit and adds human-readable labels to the Batch Place Details panel and Save All confirmation.

Behavior:
- Preserves the original Batch Place queue, drag-direction, validation, and sign-creation logic.
- Shows friendly Project, Location, Sign Type, and State labels in Batch Place Details.
- Shows the same friendly labels in the explicit Save All confirmation.
- Falls back to internal IDs when a friendly label cannot be resolved.
- Resolves Sign Type and State labels from SignAgent's jsTree model when those nodes are not currently rendered in the DOM.
- Keeps the original `SignAgentBatchPlace.user.js` file unchanged as the historical baseline.

Production version `1.0.0` was promoted after live end-to-end testing in SignAgent on September 10, 2026, including successful saves with both a previously used and an unrelated sign type.

Install only this production wrapper for Batch Place. Do not enable it at the same time as the standalone historical `SignAgentBatchPlace.user.js` script, because the wrapper already loads that baseline internally.

### SignAgentBatchPlace.user.js

Frozen historical Batch Place + Direction Drag baseline for SignAgent. It queues multiple sign placements on the map, preserves facing direction, and submits the queued signs together after user confirmation.

Initial Sign Brothers baseline:
- Source repository: `TylerSedacca/SignAgentMultiSignPlacement`
- Source commit: `04a915711b48933c14a9f941a6a7673c535ba3cc`
- Source blob SHA: `a6a00f8a0ebc32ef0ab250776b686ed64dda0848`
- Source userscript version: `1.0.0`
- Imported file size: `73,019 bytes`
- Canonical import commit: `ed659e54c845c408a9efd7479b3b84552d20cb82`

The initial import is byte-for-byte identical to Tyler's known-good source and remains preserved as an immutable historical baseline. Current Sign Brothers Batch Place users should install `SignAgentBatchPlaceFriendlyNames.user.js` instead of enabling this standalone baseline.

### SignAgentSidebarWidth.user.js

Makes the SignAgent Projects / Locations / Sign Types sidebar resizable so long names remain readable.

Behavior:
- Starts at a 340 px default width when no preference has been saved.
- Drag the thin handle on the sidebar's right edge to resize it.
- Remembers the chosen width in browser `localStorage` on that computer.
- Double-click the resize handle to reset to 340 px.
- Limits the width to a safe range so the sidebar cannot consume the entire viewport.
- Reapplies itself when SignAgent dynamically refreshes layout elements.
- Makes no SignAgent API calls and does not change business data.

Version `1.0.0` was promoted after live testing in SignAgent on September 2, 2026.

## Environment

- Browser environment: company Windows machines using Chrome
- Userscript manager: Tampermonkey
- SignAgent target: `https://app.signagent.com/*`

## Repository convention

Keep SignAgent userscripts as separate `.user.js` files in this repository unless a future tool clearly warrants its own standalone project. Scripts intended for company-wide installation should remain straightforward for nontechnical users to install through Tampermonkey.
