import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathExists } from "../infra/fs-utils";
import { extractImagePaths, resolveImagePath } from "./paths";
import { discoverVisionModels, formatVisionModelList } from "./runner";
import { getVisionModel } from "../config/store";
import { isVisionChild } from "../runtime";

// Vision guard: when the main agent's model does not support image input, detect
// image paths in prompts/attachments or read failures, and remind the agent to
// use cynos_vision. Does not register in vision-child processes (avoids recursion).

interface ImageContent {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: { type: string; data?: string; mediaType?: string };
}

function modelSupportsImages(model: { input?: ("text" | "image")[] } | undefined): boolean {
  return !!model?.input?.includes("image");
}

async function saveImagesToTempFiles(images: ImageContent[]): Promise<string[]> {
  const paths: string[] = [];
  for (const img of images) {
    const data = img.source?.type === "base64" ? img.source.data : img.data;
    if (!data) continue;
    const mimeType = img.source?.mediaType || img.mimeType || "image/png";
    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const tmpPath = path.join(os.tmpdir(), `cynos-vision-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    await fsp.writeFile(tmpPath, Buffer.from(data, "base64"));
    paths.push(tmpPath);
  }
  return paths;
}

function buildVisionReminder(imagePaths: string[], visionModel: string | undefined, availableVisionModels?: ReturnType<typeof discoverVisionModels>): string {
  const pathList = imagePaths.map((p) => `- ${p}`).join("\n");
  if (!visionModel) {
    const modelListSection = availableVisionModels && availableVisionModels.length > 0
      ? [
          "Currently authenticated vision models (copy one to fill in visionModel above):",
          formatVisionModelList(availableVisionModels),
        ].join("\n")
      : "No authenticated vision models. First configure a provider that supports image input via `pi login`.";
    return [
      "Important: the current model does not support image/vision input.",
      "Do not use the read tool on image files; it will fail.",
      "",
      "Detected image paths:",
      pathList,
      "",
      "To enable image analysis, run /cynos-tools-config to choose a vision model.",
      "",
      modelListSection,
      "",
      "Until configured, you can describe the image content yourself, or ask the user.",
    ].join("\n");
  }
  const quotedPaths = imagePaths.map((p) => JSON.stringify(p)).join(", ");
  return [
    "Important: the current model does not support image/vision input.",
    "Do not use the read tool on image files; it will fail.",
    "",
    "Detected image paths:",
    pathList,
    "",
    `Configured vision model: ${visionModel}`,
    "",
    "Use cynos_vision to analyze the images:",
    `  cynos_vision(images=[${quotedPaths}], mode="describe", prompt="<your question>")`,
    "",
    "cynos_vision runs the configured vision model and returns a description you can use directly.",
  ].join("\n");
}

const IMAGE_UNSUPPORTED_RE = /does not support images/i;

function getReadPathFromEvent(event: any): string | undefined {
  const candidates = [
    event.input?.path,
    event.input?.filePath,
    event.toolInput?.path,
    event.toolInput?.filePath,
    event.args?.path,
    event.args?.filePath,
    event.params?.path,
    event.params?.filePath,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

export function registerVisionGuard(pi: ExtensionAPI): void {
  // before_agent_start: detect image paths in the prompt and inject a reminder.
  pi.on("before_agent_start", async (event, ctx) => {
    if (isVisionChild()) return undefined;
    if (modelSupportsImages(ctx.model)) return undefined;

    const imagePaths: string[] = [];
    const textPaths = extractImagePaths(event.prompt || "");
    for (const p of textPaths) {
      const resolved = resolveImagePath(ctx.cwd, p);
      if (await pathExists(resolved)) imagePaths.push(resolved);
    }

    if (event.images && event.images.length > 0) {
      const savedPaths = await saveImagesToTempFiles(event.images);
      imagePaths.push(...savedPaths);
    }

    const uniqueImagePaths = [...new Set(imagePaths)];
    if (uniqueImagePaths.length === 0) return undefined;

    const visionModel = await getVisionModel();
    const availableVisionModels = visionModel ? undefined : discoverVisionModels(ctx.modelRegistry?.getAvailable?.() ?? []);
    return {
      message: {
        customType: "cynos-tools-vision-reminder",
        display: false,
        content: buildVisionReminder(uniqueImagePaths, visionModel, availableVisionModels),
      },
    };
  });

  // tool_result: when the read tool fails on an image, append cynos_vision guidance.
  pi.on("tool_result", async (event, ctx) => {
    if (isVisionChild()) return undefined;
    if (event.toolName !== "read") return undefined;
    if (modelSupportsImages(ctx.model)) return undefined;

    const textBlocks = (event.content || [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text as string);
    const fullText = textBlocks.join("");
    if (!IMAGE_UNSUPPORTED_RE.test(fullText)) return undefined;

    const readPath = getReadPathFromEvent(event);
    const resolvedReadPath = readPath ? resolveImagePath(ctx.cwd, readPath) : undefined;
    const existingReadPath = resolvedReadPath && (await pathExists(resolvedReadPath)) ? resolvedReadPath : undefined;

    const visionModel = await getVisionModel();

    let guidance: string;
    if (visionModel && existingReadPath) {
      const quoted = JSON.stringify(existingReadPath);
      guidance =
        `\n\n[Cynos Tools] The read tool failed because the current model cannot process images.\n` +
        `Use cynos_vision to analyze the image: cynos_vision(images=[${quoted}], mode="describe", prompt="<your question>")`;
    } else if (visionModel) {
      guidance =
        `\n\n[Cynos Tools] The read tool failed because the current model cannot process images.\n` +
        `Use cynos_vision(images=[<image-path>], mode="describe", prompt="<your question>") to analyze image files.`;
    } else {
      guidance =
        `\n\n[Cynos Tools] The read tool failed because the current model cannot process images.\n` +
        `visionModel is not configured. Run /cynos-tools-config to choose a vision model.`;
    }

    return { content: [...event.content, { type: "text", text: guidance }] };
  });
}
