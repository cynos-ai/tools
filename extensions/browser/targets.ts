// Interaction target resolution: ref > role+name > selector > text.
// Deterministic precedence; first present, highest-priority wins.

import type { Page } from "playwright-core";

export interface InteractionTarget {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface ResolvedTarget {
  kind: "ref" | "role" | "selector" | "text";
  locator: string;
  apply: (page: Page) => ReturnType<Page["locator"]>;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface TargetResolution {
  target?: InteractionTarget;
}

export function resolveTarget(options: TargetResolution): ResolvedTarget | undefined {
  const t = options.target ?? {};
  if (isNonEmpty(t.ref)) {
    const refAttr = `[data-cynos-ref="${cssEscape(t.ref)}"]`;
    return {
      kind: "ref",
      locator: refAttr,
      apply: (page) => page.locator(refAttr).first(),
    };
  }
  if (isNonEmpty(t.role)) {
    const roleOpts: Record<string, unknown> = {};
    if (isNonEmpty(t.name)) roleOpts.name = t.name;
    const roleOptsJson = JSON.stringify(roleOpts);
    return {
      kind: "role",
      locator: `getByRole(${JSON.stringify(t.role)}${isNonEmpty(t.name) ? `, ${roleOptsJson}` : ""})`,
      apply: (page) => page.getByRole(t.role as any, roleOpts as any),
    };
  }
  if (isNonEmpty(t.selector)) {
    return {
      kind: "selector",
      locator: t.selector,
      apply: (page) => page.locator(t.selector!).first(),
    };
  }
  if (isNonEmpty(t.text)) {
    return {
      kind: "text",
      locator: `getByText(${JSON.stringify(t.text)})`,
      apply: (page) => page.getByText(t.text!).first(),
    };
  }
  return undefined;
}

// Minimal CSS-string escape for the attribute selector. Avoids injecting unescaped
// quotes that would break the selector or allow selector injection.
export function cssEscape(value: string): string {
  // Escape backslash and double-quote — the only chars that can break out of a double-quoted attr selector.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// For each supported action, require certain target fields. Returns a list of
// human-readable missing-field hints, empty when valid.
export function validateActionTarget(action: string, target: InteractionTarget | undefined): string[] {
  const missing: string[] = [];
  const needsTarget = ["click", "fill", "select", "hover", "press"].includes(action);
  if (needsTarget && !target) {
    missing.push(`action '${action}' requires a target (ref/role/selector/text)`);
    return missing;
  }
  if (action === "fill" && !(target?.ref || target?.role || target?.selector || target?.text)) {
    missing.push("action 'fill' requires a target");
  }
  return missing;
}
