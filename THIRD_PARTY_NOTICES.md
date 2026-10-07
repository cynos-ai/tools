# Third-party notices

Cynos Tools integrates the following upstream software:

## pi

The extension API and host packages come from the MIT-licensed
[pi repository](https://github.com/earendil-works/pi). The host packages remain
external and are resolved by pi at runtime.

## `playwright-core`

The browser integration depends on `playwright-core`, distributed under the
Apache-2.0 license. Its own license and notices are provided by the installed
npm dependency.

## pi-annotate

The `/annotate` page-annotation workflow (element picking with numbered note
cards, submit-to-chat reporting) is inspired by the MIT-licensed
[pi-annotate](https://github.com/nicobailon/pi-annotate) project by Nico Bailon.
The overlay implementation in this package is original code: instead of a
browser extension plus native messaging host, it runs inside the
Tools-managed Playwright browser session.

Runtime dependencies remain governed by their respective upstream licenses.
This file describes the integration boundary and does not replace those license
files.
