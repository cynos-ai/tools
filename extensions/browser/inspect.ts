// Snapshot and ref injection. Injects data-cynos-ref attributes into the live DOM
// for interactive elements, then builds a concise snapshot the agent can target.

import type { Page } from "playwright-core";
import { BROWSER_MAX_REF_ELEMENTS } from "../infra/limits";
import { cssEscape } from "./targets";
import type { ElementInfo, ManagedBrowserSession } from "./manager";

// Playwright evaluate argument shape.
interface RawElement {
  ref: string;
  tag: string;
  role: string | null;
  name: string | null;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
  placeholder: string | null;
  textPreview: string | null;
  href: string | null;
}

const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, summary, [role], [tabindex], label, [contenteditable="true"]';

interface SnapshotEvalElement extends Element {
  name?: string;
  value?: unknown;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  innerText?: string;
}

// Keep the page-side logic as a typed Playwright evaluation function. Passing the
// selector and limit as serializable arguments avoids relying on build-time code
// transformation and keeps the browser operation easy to inspect and test.
export async function snapshotPage(page: Page): Promise<RawElement[]> {
  const result = await page.evaluate(
    ({ selector, max }) => {
      const out: RawElement[] = [];
      const nodes = Array.from(document.querySelectorAll(selector));
      let n = 0;
      for (const node of nodes) {
        if (n >= max) break;
        const el = node as SnapshotEvalElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const ref = `e${n + 1}`;
        el.setAttribute("data-cynos-ref", ref);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const ariaLabel = el.getAttribute("aria-label");
        const name = ariaLabel || el.name || null;
        const value = "value" in el ? String(el.value ?? "") : null;
        const checked = "checked" in el ? Boolean(el.checked) : null;
        const disabled = Boolean(el.disabled);
        const placeholder = "placeholder" in el ? el.placeholder || null : null;
        const textPreview = ((el.innerText || el.textContent || "").trim().slice(0, 60)) || null;
        const href = "href" in el ? el.getAttribute("href") : null;
        out.push({ ref, tag, role, name, value, checked, disabled, placeholder, textPreview, href });
        n++;
      }
      return out;
    },
    { selector: INTERACTIVE_SELECTOR, max: BROWSER_MAX_REF_ELEMENTS },
  );
  return (result as RawElement[]).slice(0, BROWSER_MAX_REF_ELEMENTS);
}

export function formatSnapshot(url: string, title: string, elements: RawElement[]): string {
  const lines: string[] = [];
  lines.push(`URL: ${url}`);
  if (title) lines.push(`Title: ${title}`);
  lines.push("");
  lines.push(`Interactive elements (${elements.length}):`);
  for (const el of elements) {
    const parts: string[] = [`[${el.ref}]`];
    parts.push(`<${el.tag}>`);
    if (el.role) parts.push(`role=${el.role}`);
    if (el.name) parts.push(`name=${JSON.stringify(el.name)}`);
    if (el.placeholder) parts.push(`placeholder=${JSON.stringify(el.placeholder)}`);
    if (el.value) parts.push(`value=${JSON.stringify(el.value.slice(0, 40))}`);
    if (el.checked !== null) parts.push(`checked=${el.checked}`);
    if (el.disabled) parts.push("disabled");
    if (el.href) parts.push(`href=${JSON.stringify(el.href.slice(0, 60))}`);
    if (el.textPreview) parts.push(`text=${JSON.stringify(el.textPreview)}`);
    lines.push("  " + parts.join(" "));
  }
  return lines.join("\n");
}

export function rawElementToInfo(raw: RawElement): ElementInfo {
  return {
    ref: raw.ref,
    tag: raw.tag,
    role: raw.role ?? undefined,
    name: raw.name ?? undefined,
    value: raw.value ?? undefined,
    checked: raw.checked ?? undefined,
    disabled: raw.disabled || undefined,
    placeholder: raw.placeholder ?? undefined,
    textPreview: raw.textPreview ?? undefined,
  };
}

export function storeRefs(session: ManagedBrowserSession, elements: RawElement[]): void {
  session.refs.clear();
  for (const el of elements) {
    session.refs.set(el.ref, rawElementToInfo(el));
  }
}

// Selector for a previously-injected ref. Used by interact.
export function selectorForRef(ref: string): string {
  return `[data-cynos-ref="${cssEscape(ref)}"]`;
}

// Type guard so tooling can format a raw element uniformly.
export function isRawElement(value: unknown): value is RawElement {
  return !!value && typeof value === "object" && typeof (value as RawElement).ref === "string" && typeof (value as RawElement).tag === "string";
}
