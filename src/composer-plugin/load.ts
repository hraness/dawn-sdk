/**
 * Where a `--composer` argument points, read into memory
 * (`core/composer-plugin.ts`): a plug-in folder or its `dawn.composer.json`,
 * or an installed collection entry (`<collection>/<entry>`) that
 * `collections.lock.json` records as a composer.
 *
 * Only module files (`.ts`, `.mts`, `.js`, `.mjs`, `.json`) are read, never
 * through a link, a hidden folder or `node_modules`. An installed entry is
 * read from its locked files only, each of which must still hold its locked
 * bytes; a file the lock does not list is never read, so it cannot be
 * imported. Reading runs nothing: the sealed engine gets these sources and
 * no file system.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  COMPOSER_MANIFEST,
  COMPOSER_MODULE,
  COMPOSER_PLUGIN_LIMITS,
  ComposerPluginError,
  isPluginPath,
  parseComposerManifest,
  type ComposerPlugin,
} from "../../core/composer-plugin.ts";
import { readInside } from "../collection/local.ts";
import { LOCK_FILE, readLock } from "../collection/lock.ts";

export type ComposerOrigin =
  | Readonly<{ type: "path"; path: string }>
  | Readonly<{ type: "collection"; name: string; entry: string }>;

export type LoadedComposer = ComposerPlugin &
  Readonly<{ origin: ComposerOrigin; dir: string }>;

const ENTRY =
  /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const SKIP_DIRS = new Set(["node_modules"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Which bytes ran: the sorted paths with each file's digest. */
export function pluginDigest(files: ReadonlyMap<string, Uint8Array>): string {
  return sha256(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => `${path}\0${sha256(bytes)}\n`)
      .join(""),
  );
}

function decode(path: string, bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ComposerPluginError(`${path} is not UTF-8 text`);
  }
}

function assemble(
  files: Map<string, Uint8Array>,
  origin: ComposerOrigin,
  dir: string,
): LoadedComposer {
  const manifestBytes = files.get(COMPOSER_MANIFEST);
  if (!manifestBytes)
    throw new ComposerPluginError(`the composer has no ${COMPOSER_MANIFEST}`);
  let raw: unknown;
  try {
    raw = JSON.parse(decode(COMPOSER_MANIFEST, manifestBytes));
  } catch (error) {
    if (error instanceof ComposerPluginError) throw error;
    throw new ComposerPluginError(`${COMPOSER_MANIFEST} is not JSON`);
  }
  const manifest = parseComposerManifest(raw);
  const sources = new Map<string, string>();
  for (const [path, bytes] of files)
    if (path !== COMPOSER_MANIFEST) sources.set(path, decode(path, bytes));
  if (!sources.has(manifest.entry))
    throw new ComposerPluginError(
      `${COMPOSER_MANIFEST} names entry ${manifest.entry}, which the composer does not have`,
    );
  return Object.freeze({
    manifest,
    sources,
    sha256: pluginDigest(files),
    origin,
    dir,
  });
}

/** Counts files and bytes against the plug-in limits as they are read. */
function budget() {
  const L = COMPOSER_PLUGIN_LIMITS;
  let count = 0;
  let total = 0;
  return (path: string, size: number) => {
    if (++count > L.files)
      throw new ComposerPluginError(
        `the composer has more than ${L.files} files`,
      );
    if (size > L.fileBytes)
      throw new ComposerPluginError(
        `${path} is larger than ${L.fileBytes / (1024 * 1024)} MiB`,
      );
    total += size;
    if (total > L.totalBytes)
      throw new ComposerPluginError(
        `the composer's files are larger than ${L.totalBytes / (1024 * 1024)} MiB`,
      );
  };
}

/** A plug-in folder on disk: its manifest and module files. */
export async function readComposerFolder(
  folder: string,
  origin: ComposerOrigin = { type: "path", path: folder },
): Promise<LoadedComposer> {
  let root: string;
  try {
    root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new ComposerPluginError(`cannot read composer folder ${folder}`);
  }
  const files = new Map<string, Uint8Array>();
  const count = budget();
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 16)
      throw new ComposerPluginError("the composer's folders nest too deep");
    const names: string[] = [];
    for await (const d of await opendir(join(root, rel))) names.push(d.name);
    names.sort();
    for (const name of names) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!info.isFile() || !isPluginPath(path)) continue;
      if (path !== COMPOSER_MANIFEST && !COMPOSER_MODULE.test(name)) continue;
      count(path, info.size);
      files.set(
        path,
        await readInside(
          root,
          join(root, path),
          path === COMPOSER_MANIFEST
            ? COMPOSER_PLUGIN_LIMITS.manifestBytes
            : COMPOSER_PLUGIN_LIMITS.fileBytes,
          path,
        ),
      );
    }
  };
  try {
    await walk("", 0);
  } catch (error) {
    if (error instanceof ComposerPluginError) throw error;
    throw new ComposerPluginError(
      `cannot read composer ${folder}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assemble(files, origin, root);
}

/** An installed composer entry, from its locked files only. */
async function fromLock(
  projects: readonly string[],
  name: string,
  id: string,
): Promise<LoadedComposer | undefined> {
  for (const folder of projects) {
    if (!existsSync(join(folder, LOCK_FILE))) continue;
    // Containment is checked on canonical paths (a temporary folder may
    // sit behind a link).
    const project = await realpath(folder);
    const lock = await readLock(project);
    const entry = lock.sources
      .find((s) => s.name === name)
      ?.entries.find((e) => e.id === id);
    if (!entry) continue;
    if (entry.kind !== "composer")
      throw new ComposerPluginError(
        `${name}/${id} is a ${entry.kind}, not a composer`,
      );
    const dir = join(project, entry.dir);
    const files = new Map<string, Uint8Array>();
    const count = budget();
    for (const file of entry.files) {
      if (
        file.path !== COMPOSER_MANIFEST &&
        !COMPOSER_MODULE.test(basename(file.path))
      )
        continue;
      if (!isPluginPath(file.path))
        throw new ComposerPluginError(`${name}/${id}: bad path ${file.path}`);
      count(file.path, file.bytes);
      let bytes: Buffer;
      try {
        bytes = await readInside(
          dir,
          join(dir, file.path),
          COMPOSER_PLUGIN_LIMITS.fileBytes,
          file.path,
        );
      } catch (error) {
        throw new ComposerPluginError(
          `${name}/${id}: cannot read ${file.path} (${error instanceof Error ? error.message : "unreadable"}); restore it with dawn collection install`,
        );
      }
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new ComposerPluginError(
          `${name}/${id}: ${file.path} was edited since it was installed; restore it with dawn collection install`,
        );
      files.set(file.path, bytes);
    }
    return assemble(files, { type: "collection", name, entry: id }, dir);
  }
  return undefined;
}

/**
 * The composer `arg` names, from `cwd`: `<collection>/<entry>` is looked up
 * in the lock of each of `projects` in order (the song's folder, then the
 * working folder); otherwise it is a folder or its manifest.
 */
export async function loadComposer(
  arg: string,
  cwd: string,
  projects: readonly string[] = [cwd],
): Promise<LoadedComposer> {
  const direct = resolve(cwd, arg);
  // An installed entry's name wins over a folder of the same spelling, so
  // its files are always checked against the lock; `./a/b` names a folder.
  const match = ENTRY.exec(arg);
  if (match) {
    const found = await fromLock(projects, match[1]!, match[2]!);
    if (found) return found;
    if (!existsSync(direct))
      throw new ComposerPluginError(
        `no composer folder ${arg} and no installed composer ${arg} in ${LOCK_FILE} (dawn collection install <catalog> <entry>)`,
      );
  }
  const folder =
    basename(direct) === COMPOSER_MANIFEST ? dirname(direct) : direct;
  return readComposerFolder(folder, { type: "path", path: arg });
}
