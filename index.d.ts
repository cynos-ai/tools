// Public type declarations for @cynos-ai/tools.
// Mirrors the runtime exports of index.ts (which is built from extensions/index.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export declare const CYNOS_TOOLS_PROTOCOL_VERSION = 1;
export declare const CYNOS_TOOLS_PACKAGE_VERSION: string;

export declare function activateCynosTools(pi: ExtensionAPI): Promise<void> | void;

declare const toolsExtension: (pi: ExtensionAPI) => Promise<void> | void;
export default toolsExtension;
