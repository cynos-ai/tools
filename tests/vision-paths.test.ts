import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractImagePaths, getImageExtension, mimeTypeFor, resolveImagePath } from "../extensions/vision/paths";

describe("extractImagePaths", () => {
  it("extracts inline, quoted, file://, and bare image paths", () => {
    const text = 'see ./screenshots/page.png and "/absolute/photo.jpg" and file:///home/u/shot.webp and icon.gif';
    const paths = extractImagePaths(text);
    expect(paths.some((p) => p.includes("page.png"))).toBe(true);
    expect(paths.some((p) => p === "/absolute/photo.jpg")).toBe(true);
    expect(paths.some((p) => p === "file:///home/u/shot.webp")).toBe(true);
    expect(paths.some((p) => p === "icon.gif")).toBe(true);
  });

  it("ignores non-image paths", () => {
    expect(extractImagePaths("read README.md and src/index.ts")).toHaveLength(0);
  });

  it("deduplicates", () => {
    const paths = extractImagePaths("see a.png then a.png still a.png");
    expect(paths.filter((p) => p.endsWith("a.png"))).toHaveLength(1);
  });
});

describe("resolveImagePath", () => {
  it("resolves absolute, relative, file://, and ~/", () => {
    expect(resolveImagePath("/tmp", "/abs/x.png")).toBe("/abs/x.png");
    expect(resolveImagePath("/home/proj", "shots/a.png")).toBe(path.resolve("/home/proj", "shots/a.png"));
    expect(resolveImagePath("/tmp", "file:///home/u/img.png")).toBe("/home/u/img.png");
    expect(resolveImagePath("/tmp", "~/Pictures/s.png")).toBe(path.join(os.homedir(), "Pictures/s.png"));
  });
});

describe("getImageExtension / mimeTypeFor", () => {
  it("accepts png/jpg/jpeg/gif/webp/bmp; rejects others", () => {
    expect(getImageExtension("/a/b/c.PNG")).toBe("png");
    expect(getImageExtension("/x/photo.JPEG")).toBe("jpg");
    expect(getImageExtension("/x/icon.webp")).toBe("webp");
    expect(getImageExtension("/x/file.pdf")).toBeUndefined();
    expect(getImageExtension("/x/noext")).toBeUndefined();
  });
  it("mimeTypeFor maps extensions", () => {
    expect(mimeTypeFor("png")).toBe("image/png");
    expect(mimeTypeFor("jpg")).toBe("image/jpeg");
    expect(mimeTypeFor("webp")).toBe("image/webp");
  });
});
