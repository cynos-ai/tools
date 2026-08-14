import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { normalizeUrls, type RestProvider } from "./shared";

function renderProviderLine(details: { provider?: RestProvider; mode?: "rest" | "mcp" }, theme: Theme): string {
  if (!details.provider || !details.mode) return "";
  return `\n  ${theme.fg("muted", `provider: ${details.provider}/${details.mode}`)}`;
}

export function renderSearchCall(args: any, theme: Theme): Text {
  const query = typeof args.query === "string" ? args.query : "";
  let text = theme.fg("toolTitle", theme.bold("Search "));
  text += theme.fg("accent", `"${query.slice(0, 80)}${query.length > 80 ? "..." : ""}"`);
  return new Text(text, 0, 0);
}

export function renderSearchResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
  if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
  const details = result.details as any;
  const count = details?.resultCount ?? 0;
  let text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
  text += theme.fg("muted", expanded ? " (Ctrl+O to collapse)" : " (Ctrl+O to expand)");
  if (expanded) {
    text += renderProviderLine(details as any, theme);
    for (const resultItem of details?.results?.slice(0, 5) || []) {
      text += `\n  ${theme.fg("dim", `• ${resultItem.title || resultItem.url || "Untitled"}`)}`;
    }
    if ((details?.results?.length || 0) > 5) {
      text += `\n  ${theme.fg("dim", `... and ${(details?.results?.length || 0) - 5} more`)}`;
    }
  }
  return new Text(text, 0, 0);
}

export function renderFetchCall(args: any, theme: Theme): Text {
  const urls = normalizeUrls(args.urls);
  const urlList = urls.join(", ");
  const display = urlList.length > 60 ? urlList.slice(0, 57) + "..." : urlList;
  const text = theme.fg("toolTitle", theme.bold("Fetch ")) + theme.fg("accent", display);
  return new Text(text, 0, 0);
}

export function renderFetchResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
  if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
  const details = result.details as any;
  let text = theme.fg("success", "✓ Fetched");
  if (details?.titles?.length) text += theme.fg("muted", `: ${details.titles[0]}`);
  if (details?.truncated) text += theme.fg("warning", " (truncated)");
  text += theme.fg("muted", expanded ? " (Ctrl+O to collapse)" : " (Ctrl+O to expand)");
  if (expanded) {
    text += renderProviderLine(details as any, theme);
    if (details?.fullOutputPath) {
      text += `\n  ${theme.fg("muted", `full output: ${details.fullOutputPath}`)}`;
    }
    const content = result.content?.[0];
    if (content?.type === "text") {
      const lines = content.text.split("\n");
      const visible = lines.slice(0, 10);
      for (const line of visible) text += `\n  ${theme.fg("dim", line)}`;
      if (lines.length > 10) text += `\n  ${theme.fg("muted", `... (${lines.length - 10} more lines)`)}`;
    }
  }
  return new Text(text, 0, 0);
}
