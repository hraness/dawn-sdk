// SPDX-License-Identifier: MIT
/**
 * Where a `--palette` argument points: a `dawn.palette/v1` file, or an
 * installed collection entry (`<collection>/<entry>`) that
 * `collections.lock.json` records as a palette. An installed entry is
 * read only when its manifest still holds its locked bytes. The palette's
 * devices are read and checked beside the manifest (`readDevices`).
 * Nothing in a palette runs.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parsePalettePack, type PalettePack } from "../../core/palette.ts";
import { readInside } from "../collection/local.ts";
import { LOCK_FILE, readLock, type LockedEntry } from "../collection/lock.ts";
import { PALETTE_MAX_BYTES, readDevices } from "./cli.ts";

export type PaletteOrigin =
  | Readonly<{ type: "file"; path: string }>
  | Readonly<{ type: "collection"; name: string; entry: string }>;

export type LoadedPalette = Readonly<{
  palette: PalettePack;
  /** SHA-256 of the manifest's bytes. */
  sha256: string;
  manifest: string;
  origin: PaletteOrigin;
  /** Device files by their manifest-relative path (`devices/x.wasm`). */
  devices: ReadonlyMap<string, Uint8Array>;
}>;

export class PaletteSourceError extends Error {
  override name = "PaletteSourceError";
}

const ENTRY =
  /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

function manifestOf(entry: LockedEntry): string {
  const o = entry.origin;
  const path = o.type === "https" ? new URL(o.url).pathname : o.path;
  return decodeURIComponent(path.split("/").at(-1)!);
}

async function fromLock(
  projects: readonly string[],
  name: string,
  id: string,
): Promise<{ manifest: string; root: string; sha256: string } | undefined> {
  for (const project of projects) {
    if (!existsSync(join(project, LOCK_FILE))) continue;
    const lock = await readLock(project);
    const source = lock.sources.find((s) => s.name === name);
    const entry = source?.entries.find((e) => e.id === id);
    if (!entry) continue;
    if (entry.kind !== "palette")
      throw new PaletteSourceError(
        `${name}/${id} is a ${entry.kind}, not a palette`,
      );
    const file = manifestOf(entry);
    const locked = entry.files.find((f) => f.path === file);
    if (!locked)
      throw new PaletteSourceError(`${name}/${id}: the lock lists no ${file}`);
    return {
      manifest: join(project, entry.dir, file),
      root: join(project, entry.dir),
      sha256: locked.sha256,
    };
  }
  return undefined;
}

/**
 * The palette `arg` names, from `cwd`. A path to a file wins; otherwise
 * `<collection>/<entry>` is looked up in the lock of each of `projects`
 * in order (the song's folder, then the working folder).
 */
export async function loadPalette(
  arg: string,
  cwd: string,
  projects: readonly string[] = [cwd],
): Promise<LoadedPalette> {
  const direct = resolve(cwd, arg);
  let manifest: string;
  let root: string;
  let origin: PaletteOrigin;
  let locked: string | undefined;
  const match = ENTRY.exec(arg);
  if (existsSync(direct) || !match) {
    manifest = direct;
    root = dirname(direct);
    origin = { type: "file", path: arg };
  } else {
    const found = await fromLock(projects, match[1]!, match[2]!);
    if (!found)
      throw new PaletteSourceError(
        `no palette file ${arg} and no installed palette ${arg} in ${LOCK_FILE} (dawn collection install <catalog> <entry>)`,
      );
    ({ manifest, root } = found);
    locked = found.sha256;
    origin = { type: "collection", name: match[1]!, entry: match[2]! };
  }
  let bytes: Buffer;
  try {
    bytes = await readInside(root, manifest, PALETTE_MAX_BYTES, basename(arg));
  } catch (error) {
    throw new PaletteSourceError(
      `cannot read palette ${arg}: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (locked !== undefined && sha256 !== locked)
    throw new PaletteSourceError(
      `${arg} was edited since it was installed (sha256 ${sha256.slice(0, 12)}, locked ${locked.slice(0, 12)}); restore it with dawn collection install`,
    );
  let palette: PalettePack;
  let devices: ReadonlyMap<string, Uint8Array>;
  try {
    palette = parsePalettePack(JSON.parse(bytes.toString("utf8")));
    devices = await readDevices(manifest, palette);
  } catch (error) {
    throw new PaletteSourceError(
      `palette ${arg}: ${error instanceof Error ? error.message.slice(0, 300) : "invalid"}`,
    );
  }
  return { palette, sha256, manifest, origin, devices };
}
