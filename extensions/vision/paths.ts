import * as os from "node:os";
import * as path from "node:path";

// Image path extraction + resolution. Adapted from the original Cynos vision guard.

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export function isImagePathLike(token: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)\b/i.test(token);
}

export function extractImagePaths(prompt: string): string[] {
  const paths: string[] = [];
  const extPattern = /\.(png|jpe?g|gif|webp|bmp)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = extPattern.exec(prompt)) !== null) {
    const extEnd = match.index + match[0].length;
    let slashPos = -1;
    for (let i = match.index - 1; i >= 0; i--) {
      const ch = prompt[i];
      if (ch === "\n") break;
      if (ch === "/" || ch === "~") { slashPos = i; break; }
    }
    if (slashPos >= 0) {
      let pathStart = slashPos;
      for (let i = slashPos - 1; i >= 0; i--) {
        if (prompt[i] === "\n") { pathStart = i + 1; break; }
        if (prompt[i] === " ") { pathStart = i + 1; break; }
        pathStart = i;
      }
      const fullPath = prompt.slice(pathStart, extEnd).replace(/^["'`]|["'`]$/g, "");
      if (fullPath.length > 4) paths.push(fullPath);
    }
  }

  for (const fileUrl of prompt.matchAll(/\bfile:\/\/[^\s"'`]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi)) {
    paths.push(fileUrl[0]);
  }
  for (const quoted of prompt.matchAll(/["'`]([^"'`\n]+\.(?:png|jpe?g|gif|webp|bmp))["'`]/gi)) {
    paths.push(quoted[1]);
  }
  for (const token of prompt.matchAll(/(?:^|\s)([^\s"'`]+\.(?:png|jpe?g|gif|webp|bmp))(?=\s|$)/gi)) {
    paths.push(token[1]);
  }

  return [...new Set(paths)];
}

export function resolveImagePath(cwd: string, candidate: string): string {
  if (candidate.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return candidate;
    }
  }
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  if (path.isAbsolute(candidate)) return candidate;
  return path.resolve(cwd, candidate);
}

export function getImageExtension(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (!ext) return undefined;
  if (ext === "jpeg") return "jpg";
  return IMAGE_EXTENSIONS.includes(ext as ImageExtension) ? ext : undefined;
}

export function mimeTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
