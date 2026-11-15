/**
 * A content-addressed cache of verified collection files, shared by every
 * project of a user: `<cache>/objects/sha256/<2>/<64 hex>`. An object is
 * published with a hard link only after its bytes are hashed, so a reader
 * never sees a partial or unverified object.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "../fs/durable.ts";
import { hashFile } from "./local.ts";

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DAWN_COLLECTION_CACHE) return env.DAWN_COLLECTION_CACHE;
  const base =
    env.XDG_CACHE_HOME ||
    (env.HOME ? join(env.HOME, ".cache") : env.LOCALAPPDATA);
  if (!base)
    throw new Error("no cache folder: set DAWN_COLLECTION_CACHE or HOME");
  return join(base, "dawn", "collections");
}

export class ObjectCache {
  constructor(readonly dir: string) {}

  path(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a SHA-256 digest");
    return join(this.dir, "objects", "sha256", sha256.slice(0, 2), sha256);
  }

  /** True when the object exists and still hashes to its name. */
  async has(sha256: string, bytes?: number): Promise<boolean> {
    const path = this.path(sha256);
    const found = await hashFile(path);
    if (!found) return false;
    if (found.sha256 !== sha256) {
      // A damaged object is removed so the next transfer replaces it.
      await unlink(path).catch(() => undefined);
      return false;
    }
    // A wrong declared size makes the object unusable here, not damaged.
    return bytes === undefined || found.bytes === bytes;
  }

  async read(sha256: string, max: number): Promise<Buffer | undefined> {
    if (!(await this.has(sha256))) return undefined;
    const handle = await open(this.path(sha256), "r");
    try {
      const info = await handle.stat();
      if (info.size > max) return undefined;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /** A writer for one object; `commit` publishes it under its digest. */
  async writer() {
    const tmp = join(this.dir, "tmp");
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const path = join(tmp, randomUUID());
    const handle = await open(path, "wx", 0o644);
    let open_ = true;
    const close = async () => {
      if (!open_) return;
      open_ = false;
      await handle.close();
    };
    return {
      write: async (chunk: Uint8Array) => {
        await handle.write(chunk);
      },
      commit: async (sha256: string) => {
        await handle.sync();
        await close();
        const final = this.path(sha256);
        await mkdir(join(final, ".."), { recursive: true });
        try {
          await link(path, final);
          await syncDirectory(join(final, ".."));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Another process published the same bytes; keep a verified copy.
          if (!(await this.has(sha256))) await link(path, final);
        } finally {
          await unlink(path).catch(() => undefined);
        }
      },
      abort: async () => {
        await close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
      },
    };
  }
}
