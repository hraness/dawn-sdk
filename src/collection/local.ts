/** Bounded local file access shared by the collection tools. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { syncDirectory } from "../fs/durable.ts";

export type Output = { write(text: string): unknown };
export const jsonText = (value: unknown) =>
  `${JSON.stringify(value, null, 2)}\n`;
export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !(
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  );
}
export function contained(root: string, path: string): void {
  if (!isInside(root, path))
    throw new Error("referenced file is outside the collection root");
}

/** Check canonical paths and the opened descriptor before reading any content. */
export async function openInside(root: string, path: string) {
  const canonical = await realpath(path);
  contained(root, canonical);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error("referenced path must be a regular file");
    const current = await realpath(canonical);
    contained(root, current);
    const named = await stat(current);
    if (named.dev !== before.dev || named.ino !== before.ino)
      throw new Error("referenced file changed while opening it");
    return { handle, before, path: canonical };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

type Handle = Awaited<ReturnType<typeof open>>;
type Info = Awaited<ReturnType<Handle["stat"]>>;

/**
 * Stream an opened file once, hashing it and passing each chunk on. The file
 * must keep the size and times it had when opened.
 */
export async function streamHandle(
  handle: Handle,
  before: Info,
  label: string,
  onChunk?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ sha256: string; bytes: number; head: Buffer }> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let length = 0;
  let head = Buffer.alloc(0);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    length += bytesRead;
    if (length > before.size)
      throw new Error(`${label}: file changed while reading it`);
    const chunk = buffer.subarray(0, bytesRead);
    if (head.length < 1024)
      head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
    hash.update(chunk);
    if (onChunk) await onChunk(Buffer.from(chunk));
  }
  const after = await handle.stat();
  if (
    length !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error(`${label}: file changed while reading it`);
  return { sha256: hash.digest("hex"), bytes: length, head };
}

/** Read a whole small file inside `root`, refusing one over `max` bytes. */
export async function readInside(
  root: string,
  path: string,
  max: number,
  label: string,
): Promise<Buffer> {
  const { handle, before } = await openInside(root, path);
  try {
    if (before.size > max) throw new Error(`${label} exceeds ${max} bytes`);
    const chunks: Uint8Array[] = [];
    await streamHandle(handle, before, label, (c) => {
      chunks.push(c);
    });
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

/** Hash a file that is not inside any particular root (a cache object). */
export async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number } | undefined> {
  let handle: Handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
      return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return undefined;
    const { sha256, bytes } = await streamHandle(handle, before, path);
    return { sha256, bytes };
  } finally {
    await handle.close();
  }
}

/** Write a new file: fails rather than replace anything already there. */
export async function publishNew(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await link(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
}

/** Replace a file atomically with new contents (or create it). */
export async function replaceFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** The sanitized message of an error for a one-line diagnostic. */
export function reasonOf(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reason =
    code === "EEXIST"
      ? "output already exists; choose a new directory"
      : error instanceof Error
        ? error.message
        : fallback;
  return reason.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, " ");
}
