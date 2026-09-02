# SignAgent Scripts

Company-maintained Tampermonkey userscripts used by Sign Brothers to improve SignAgent workflows and UI/UX.

## Canonical ownership

This repository is the Sign Brothers source of truth for maintained SignAgent userscripts going forward.

## Current scripts

### SignAgentBatchPlace.user.js

Batch Place + Direction Drag for SignAgent. It queues multiple sign placements on the map, preserves facing direction, and submits the queued signs together after user confirmation.

Initial Sign Brothers baseline:
- Source repository: `TylerSedacca/SignAgentMultiSignPlacement`
- Source commit: `04a915711b48933c14a9f941a6a7673c535ba3cc`
- Source blob SHA: `a6a00f8a0ebc32ef0ab250776b686ed64dda0848`
- Source userscript version: `1.0.0`
- Imported file size: `73,019 bytes`

The initial import is byte-for-byte identical to Tyler's known-good source. Future Sign Brothers maintenance and development should occur in this repository rather than the former maintainer's repository.

## Environment

- Browser environment: company Windows machines using Chrome
- Userscript manager: Tampermonkey
- SignAgent target: `https://app.signagent.com/*`

## Repository convention

Keep SignAgent userscripts as separate `.user.js` files in this repository unless a future tool clearly warrants its own standalone project. Scripts intended for company-wide installation should remain straightforward for nontechnical users to install through Tampermonkey.
