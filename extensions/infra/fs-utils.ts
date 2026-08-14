import * as fs from "node:fs/promises";
import * as path from "node:path";

// File write queue: serializes concurrent writes to the same file to avoid racing atomic renames.
const queues = new Map<string, Promise<unknown>>();

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function readJsonFile<T>(filePath: string): Promise<T>;
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T>;
export async function readJsonFile<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error: unknown) {
    if (fallback !== undefined && isErrnoException(error) && error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

export async function readJsonFileOptional<T>(filePath: string): Promise<T | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return readJsonFile<T>(filePath);
}

async function writeJsonTempFile(dir: string, basename: string, value: unknown, options?: { mode?: number }): Promise<string> {
  const temp = path.join(dir, `.${basename}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const handle = options?.mode !== undefined ? await fs.open(temp, "wx", options.mode) : await fs.open(temp, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

export async function writeJsonAtomic(filePath: string, value: unknown, options?: { mode?: number }): Promise<void> {
  await withFileMutationQueue(filePath, async () => {
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    await ensureDir(dir);
    const temp = await writeJsonTempFile(dir, basename, value, options);
    try {
      await fs.rename(temp, filePath);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function writeJsonAtomicIfAbsent(filePath: string, value: unknown, options?: { mode?: number }): Promise<boolean> {
  return withFileMutationQueue(filePath, async () => {
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    await ensureDir(dir);
    const temp = await writeJsonTempFile(dir, basename, value, options);
    try {
      await fs.link(temp, filePath);
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") return false;
      throw error;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const queueKey = path.resolve(filePath);
  const prev = queues.get(queueKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prev.then(() => current, () => current);
  queues.set(queueKey, queued);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(queueKey) === queued) queues.delete(queueKey);
  }
}
