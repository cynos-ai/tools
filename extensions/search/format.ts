import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SEARCH_MAX_TOTAL_CHARS } from "./shared";
import type { FetchResponse, SearchResponse } from "./shared";

export function formatSearchResults(response: SearchResponse, needsTruncation: boolean): string {
  const lines: string[] = [`**Results for "${response.query}":**\n`];
  let totalChars = 0;

  for (const [index, result] of response.results.entries()) {
    const title = result.title || result.url || "(untitled)";
    const urlLine = result.url ? `\n   ${result.url}` : "";
    const snippetLine = result.snippet ? `\n   ${result.snippet}` : "";
    const entry = `${index + 1}. **${title}**${urlLine}${snippetLine}`;

    if (needsTruncation && totalChars + entry.length > MCP_SEARCH_MAX_TOTAL_CHARS) {
      lines.push(`\n... ${response.results.length - index} more results omitted.`);
      break;
    }
    lines.push(entry);
    lines.push("");
    totalChars += entry.length;
  }
  return lines.join("\n").trimEnd();
}

export function formatFetchResults(responses: FetchResponse[], urls: string[]): string {
  const parts: string[] = [];
  responses.forEach((response, index) => {
    const url = urls[index] ?? "";
    const header = response.title ? `**${response.title}**\n` : "";
    parts.push(`---\n**Fetched:** ${url}\n${header}\n${response.text}`);
  });
  return parts.join("\n\n");
}

export async function spillToTempFile(content: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "cynos-tools-fetch-"));
  const tempFile = join(tempDir, "content.txt");
  await writeFile(tempFile, content, "utf8");
  return tempFile;
}
