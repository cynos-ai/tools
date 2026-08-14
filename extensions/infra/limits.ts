// Internal hard limits — not user-tunable. Extracted for visibility; kept out of config
// so users cannot mis-tune anti-abuse caps or provider protocol values.

// ---- search ----
export const MAX_NUM_RESULTS = 10;
export const MIN_FETCH_MAX_CHARS = 500;
export const MAX_FETCH_MAX_CHARS = 20_000;
export const MAX_FETCH_URLS = 5;
export const EXA_SNIPPET_MAX_CHARS = 300;
export const MCP_SNIPPET_MAX_CHARS = 1000;
export const MCP_SEARCH_MAX_TOTAL_CHARS = 8000;

// ---- vision ----
export const VISION_MAX_IMAGES = 8;
export const VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB single-file cap
export const VISION_MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024; // 40 MB total per call
export const VISION_TIMEOUT_MINUTES = 15;
export const VISION_TASK_MAX_CHARS = 8_000;

// ---- browser ----
export const BROWSER_DEFAULT_TIMEOUT_MS = 30_000;
export const BROWSER_MAX_REF_ELEMENTS = 500;
export const BROWSER_CONSOLE_BUFFER = 200;
export const BROWSER_NETWORK_BUFFER = 200;
export const BROWSER_EVAL_OUTPUT_BYTES = 50_000;
