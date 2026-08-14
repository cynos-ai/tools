import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VISION_TASK_MAX_CHARS, VISION_TIMEOUT_MINUTES } from "../infra/limits";
import { getVisionModel } from "../config/store";

export interface VisionModelInfo {
  id: string;
  name: string;
  provider: string;
}

export function discoverVisionModels(models: Array<{ id: string; name?: string; provider?: string; input?: string[] }>): VisionModelInfo[] {
  const vision = models
    .filter((m) => Array.isArray(m.input) && m.input.includes("image"))
    .map((m) => ({
      id: m.provider ? `${m.provider}/${m.id}` : m.id,
      name: m.name ?? m.id,
      provider: m.provider ?? "unknown",
    }));
  return vision.sort((a, b) => (a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider)));
}

export function formatVisionModelList(models: VisionModelInfo[]): string {
  if (models.length === 0) return "(no authenticated vision models currently available)";
  return models.map((m) => `  - "${m.id}"  (${m.name})`).join("\n");
}

export interface VisionUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface VisionRunResult {
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: VisionUsageStats;
  failureCategory?: "ENV_ERROR" | "MODEL_ERROR" | "ABORTED" | "TIMEOUT" | "UNKNOWN";
  failureReason?: string;
}

function emptyUsage(): VisionUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

interface PiJsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: Partial<VisionUsageStats> & { totalTokens?: number; cost?: { total?: number } };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Prefer the same script that launched us when available, so the child uses the same pi install.
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    try {
      if (fsSync.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
      }
    } catch {
      // fall through to "pi"
    }
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cynos-vision-"));
  const filePath = path.join(tmpDir, "system-prompt.md");
  await fsp.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function buildVisionSystemPrompt(imagePaths: string[], mode: string, userPrompt: string | undefined): string {
  const imageList = imagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const modeInstruction = (() => {
    switch (mode) {
      case "ocr":
        return "Transcribe all visible text in the image(s) verbatim. Do not describe or interpret.";
      case "compare":
        return "Compare the images: describe what is shared, what differs, and the evolution or consistency across them.";
      case "ui":
        return "Analyze the UI: layout, components, text content, states, errors, and any visual/UX issues.";
      case "describe":
      default:
        return "Describe the image(s) concretely and evidence-based. Do not guess.";
    }
  })();

  return [
    "You are the Cynos vision analyzer. You analyze images using a vision-capable model.",
    "",
    "Use the `read` tool to open each image file listed below, then produce the requested analysis.",
    "Be concrete and evidence-based. When something is unclear, state what you can see and what you are unsure about.",
    "Do not invent details. Do not interact with the user.",
    "",
    "## Images to analyze",
    imageList,
    "",
    "## Task mode",
    modeInstruction,
    userPrompt ? `\n## User question\n${userPrompt}` : "",
  ].join("\n");
}

interface ProcessedEvents {
  assistantText: string;
  usage: VisionUsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

function processPiJsonLine(acc: ProcessedEvents, line: string): void {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const event = parsed as PiJsonEvent;

  if (event.type === "message_end" && event.message) {
    const msg = event.message;
    if (msg.role === "assistant") {
      acc.usage.turns++;
      const usage = msg.usage;
      if (usage) {
        acc.usage.input += usage.input || 0;
        acc.usage.output += usage.output || 0;
        acc.usage.cacheRead += usage.cacheRead || 0;
        acc.usage.cacheWrite += usage.cacheWrite || 0;
        acc.usage.cost += usage.cost?.total || 0;
        acc.usage.contextTokens = usage.totalTokens || acc.usage.contextTokens;
      }
      if (!acc.model && msg.model) acc.model = msg.model;
      if (msg.stopReason) acc.stopReason = msg.stopReason;
      if (msg.errorMessage) acc.errorMessage = msg.errorMessage;
      // Append text content blocks from the assistant message.
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
            const text = (block as { text?: string }).text;
            if (typeof text === "string" && text.trim()) {
              acc.assistantText += (acc.assistantText ? "\n\n" : "") + text;
            }
          }
        }
      }
    }
  }
}

export interface RunVisionOptions {
  cwd: string;
  imagePaths: string[];
  mode: string;
  prompt?: string;
  timeoutMinutes?: number;
  signal?: AbortSignal;
}

export async function runVision(options: RunVisionOptions): Promise<VisionRunResult> {
  const { cwd, imagePaths, mode, prompt, signal } = options;
  const empty = emptyUsage();

  const visionModel = await getVisionModel();
  if (!visionModel) {
    return {
      exitCode: 1,
      output: "",
      stderr:
        "visionModel is not configured. Run /cynos-tools-config to choose a vision model, or set it in the user-level config file (~/.pi/agent/cynos-tools.json):\n" +
        '{ "visionModel": "provider/model-id" }\n' +
        "Note: visionModel must be a multimodal model that supports image input.",
      usage: empty,
      failureCategory: "ENV_ERROR",
      failureReason: "visionModel is not configured.",
    };
  }

  const taskPrompt = buildVisionSystemPrompt(imagePaths, mode, prompt);
  if (taskPrompt.length > VISION_TASK_MAX_CHARS) {
    return {
      exitCode: 1,
      output: "",
      stderr: `Vision task too long (${taskPrompt.length} chars, limit ${VISION_TASK_MAX_CHARS}). Reduce the number of images or prompt length.`,
      usage: empty,
      failureCategory: "ENV_ERROR",
      failureReason: "Task exceeds maximum length; may cause E2BIG when spawning pi.",
    };
  }

  const args = ["--mode", "json", "-p", "--no-session", "--model", visionModel, "--tools", "read"];
  const tmp = await writePromptToTempFile(taskPrompt);
  args.push("--append-system-prompt", tmp.filePath);
  args.push(`Analyze the ${imagePaths.length === 1 ? "image" : "images"} described in the system prompt.`);

  const timeoutMs = (options.timeoutMinutes && options.timeoutMinutes > 0 ? options.timeoutMinutes : VISION_TIMEOUT_MINUTES) * 60_000;

  const result: VisionRunResult = {
    exitCode: 0,
    output: "",
    stderr: "",
    usage: empty,
    model: visionModel,
  };

  let internalController: AbortController | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let onExternalAbort: (() => void) | undefined;

  try {
    internalController = new AbortController();
    timeoutTimer = setTimeout(() => internalController!.abort(), timeoutMs);
    onExternalAbort = () => internalController!.abort();
    if (signal) {
      if (signal.aborted) internalController.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const acc: ProcessedEvents = { assistantText: "", usage: empty };

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      let closed = false;
      let buffer = "";
      let killTimer: NodeJS.Timeout | undefined;

      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Prevent Tools from re-registering in the vision child (avoids recursive
          // cynos_vision tool and vision-guard hooks).
          CYNOS_AGENT_ROLE: "vision-child",
        },
      });

      const cleanup = () => { if (killTimer) clearTimeout(killTimer); };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processPiJsonLine(acc, line);
      });

      proc.stderr.on("data", (data) => { result.stderr += data.toString(); });

      proc.on("close", (code) => {
        cleanup();
        closed = true;
        if (buffer.trim()) processPiJsonLine(acc, buffer);
        resolve(code ?? 0);
      });

      proc.on("error", (error) => {
        cleanup();
        closed = true;
        result.errorMessage = error instanceof Error ? error.message : String(error);
        resolve(1);
      });

      internalController!.signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
          killTimer = setTimeout(() => { if (!closed) proc.kill("SIGKILL"); }, 5000);
        },
        { once: true },
      );
    });

    result.exitCode = exitCode;
    result.output = acc.assistantText;
    result.usage = acc.usage;
    if (acc.model) result.model = acc.model;
    if (acc.stopReason) result.stopReason = acc.stopReason;
    if (acc.errorMessage) result.errorMessage = acc.errorMessage;

    const aborted = internalController.signal.aborted;
    if (aborted) {
      const timedOut = !signal?.aborted;
      result.failureCategory = timedOut ? "TIMEOUT" : "ABORTED";
      result.failureReason = timedOut
        ? `Vision child exceeded ${timeoutMs / 1000}s and was aborted.`
        : "Vision child was aborted by the caller.";
    } else if (exitCode !== 0) {
      result.failureCategory = "MODEL_ERROR";
      result.failureReason = `Vision child exited with code ${exitCode}.`;
    }
    return result;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (signal && onExternalAbort) signal.removeEventListener("abort", onExternalAbort);
    // Clean up the temp system prompt.
    await fsp.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
