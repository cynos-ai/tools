// cynos_vision tool registration — independent image analysis using the configured vision model.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathExists } from "../infra/fs-utils";
import { VISION_MAX_IMAGE_BYTES, VISION_MAX_IMAGES, VISION_MAX_TOTAL_IMAGE_BYTES } from "../infra/limits";
import { getImageExtension, resolveImagePath } from "./paths";
import { runVision } from "./runner";
import { isVisionChild } from "../runtime";
import { getVisionModel } from "../config/store";

const MODES = ["describe", "ocr", "compare", "ui"] as const;
type VisionMode = (typeof MODES)[number];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function resolveAndValidateImages(cwd: string, raw: string[]): Promise<{ ok: string[]; errors: string[] }> {
  const ok: string[] = [];
  const errors: string[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const resolved = resolveImagePath(cwd, trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!(await pathExists(resolved))) {
      errors.push(`Image not found: ${trimmed}`);
      continue;
    }
    const ext = getImageExtension(resolved);
    if (!ext) {
      errors.push(`Unsupported image type (use png/jpg/jpeg/gif/webp/bmp): ${trimmed}`);
      continue;
    }
    const stat = await fsp.stat(resolved);
    if (stat.size > VISION_MAX_IMAGE_BYTES) {
      errors.push(`Image too large (${stat.size} bytes > ${VISION_MAX_IMAGE_BYTES}): ${trimmed}`);
      continue;
    }
    totalBytes += stat.size;
    if (totalBytes > VISION_MAX_TOTAL_IMAGE_BYTES) {
      errors.push(`Total image data exceeds ${VISION_MAX_TOTAL_IMAGE_BYTES} bytes. Reduce the number of images.`);
      break;
    }
    ok.push(resolved);
  }
  return { ok, errors };
}

export function registerVisionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cynos_vision",
    label: "Cynos Vision",
    description:
      "Analyze one or more local image files using the configured vision model. Supports describe, ocr (transcribe text), compare (multi-image), and ui (UI/layout analysis) modes. " +
      "Images are sent to the configured vision model provider. Returns a structured description you can use directly.",
    promptSnippet: "Analyze local image files (screenshots, UI, charts, diagrams) with the vision model",
    promptGuidelines: [
      "Use cynos_vision when you need to understand an image file (screenshot, diagram, photo) — do not use the read tool on images.",
      "cynos_vision sends images to the configured vision model and returns a description. Check screenshot/chart/UI details this way.",
    ],
    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          description: "Local image file paths (png/jpg/jpeg/gif/webp/bmp). Absolute, relative to cwd, ~/, or file:// are all accepted. 1-8 images.",
        },
        mode: {
          type: "string",
          enum: MODES as unknown as string[],
          description: "Analysis mode. Default 'describe'.",
        },
        prompt: {
          type: "string",
          description: "Optional question or focus direction for the analysis.",
        },
      },
      required: ["images"],
      additionalProperties: false,
    } as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      // Defensive: never register/run inside a vision child.
      if (isVisionChild()) {
        return { content: [{ type: "text" as const, text: "cynos_vision cannot run inside a vision child process." }], details: {} as any };
      }

      const rawImages = asStringArray(params.images);
      if (rawImages.length === 0) {
        return { content: [{ type: "text" as const, text: "At least one image path is required." }], details: { images: [], mode: "describe" }, isError: true };
      }
      if (rawImages.length > VISION_MAX_IMAGES) {
        return { content: [{ type: "text" as const, text: `Too many images. Maximum ${VISION_MAX_IMAGES} per call.` }], details: { images: rawImages, mode: "describe" }, isError: true };
      }

      const mode: VisionMode = (MODES as readonly string[]).includes(params.mode) ? (params.mode as VisionMode) : "describe";
      const userPrompt = nonEmptyString(params.prompt);

      const { ok, errors } = await resolveAndValidateImages(ctx.cwd, rawImages);
      if (ok.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No usable images.\n${errors.join("\n")}` }],
          details: { images: [], mode, errors },
          isError: true,
        };
      }

      const visionModel = await getVisionModel();
      if (!visionModel) {
        const text = [
          "visionModel is not configured. cynos_vision needs a vision-capable model.",
          "Run /cynos-tools-config to choose one, or set it in ~/.pi/agent/cynos-tools.json:",
          '  { "visionModel": "provider/model-id" }',
          ...(errors.length > 0 ? ["", "Also, some images had problems:", ...errors] : []),
        ].join("\n");
        return { content: [{ type: "text" as const, text }], details: { images: ok, mode, errors }, isError: true };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: `Analyzing ${ok.length === 1 ? "image" : `${ok.length} images`} (${mode})...` }],
        details: { images: ok, mode },
      });

      const result = await runVision({
        cwd: ctx.cwd,
        imagePaths: ok,
        mode,
        prompt: userPrompt,
        signal,
      });

      const baseDetails = {
        images: ok,
        mode,
        model: result.model,
        usage: result.usage,
      };

      if (result.failureCategory || result.exitCode !== 0) {
        const reason = result.failureReason || `Vision run failed (exit ${result.exitCode}).`;
        const stderrHint = result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(0, 1000)}` : "";
        const outHint = result.output.trim() ? `\n\nPartial output:\n${result.output.trim().slice(0, 2000)}` : "";
        return {
          content: [{ type: "text" as const, text: `${reason}${stderrHint}${outHint}` }],
          details: { ...baseDetails, failureCategory: result.failureCategory, errors },
          isError: true,
        };
      }

      const text = result.output.trim() || "(vision model produced no text output)";
      const errorHint = errors.length > 0 ? `\n\nSkipped images:\n${errors.map((e) => `- ${e}`).join("\n")}` : "";
      return {
        content: [{ type: "text" as const, text: text + errorHint }],
        details: baseDetails,
      };
    },

    renderCall(args: any, theme: Theme): Text {
      const images = asStringArray(args.images);
      const mode = typeof args.mode === "string" ? args.mode : "describe";
      const preview = images[0] ? path.basename(images[0]) : "?";
      const more = images.length > 1 ? ` +${images.length - 1}` : "";
      const text = theme.fg("toolTitle", theme.bold("Vision ")) + theme.fg("accent", `${preview}${more}`) + theme.fg("muted", ` (${mode})`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
      if (isPartial) return new Text(theme.fg("warning", "Analyzing..."), 0, 0);
      const isError = result.isError;
      const details = result.details as any;
      const count = details?.images?.length ?? 0;
      const model = details?.model;
      let text = `${theme.fg(isError ? "error" : "success", isError ? "✗" : "✓")} ${theme.fg("muted", "Vision")} `;
      text += theme.fg(isError ? "error" : "success", isError ? "failed" : `${count} image${count !== 1 ? "s" : ""}`);
      if (model) text += theme.fg("muted", ` (${model})`);
      text += theme.fg("muted", expanded ? " (Ctrl+O to collapse)" : " (Ctrl+O to expand)");
      if (expanded) {
        const content = result.content?.[0];
        if (content?.type === "text") {
          const lines = content.text.split("\n");
          for (const line of lines.slice(0, 12)) text += `\n  ${theme.fg("dim", line)}`;
          if (lines.length > 12) text += `\n  ${theme.fg("muted", `... (${lines.length - 12} more lines)`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}

export { registerVisionGuard } from "./guard";
export type { VisionRunResult, VisionUsageStats, VisionModelInfo } from "./runner";
