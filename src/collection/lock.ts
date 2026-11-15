/**
 * The project-local lock of installed collection entries,
 * `collections.lock.json`. It records what was installed from where, by
 * commit and digest, so the same bytes can be restored offline from the
 * cache. It holds no credential and no time.
 */
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseCollection } from "../../core/collection.ts";
import { jsonText, readInside, replaceFile } from "./local.ts";
import { artifactPathProblem } from "./policy.ts";

export const LOCK_FILE = "collections.lock.json";
export const LOCK_SCHEMA = "dawn.collection-lock/v1";
const LOCK_MAX_BYTES = 16 * 1024 * 1024;

/** Where a collection's catalog came from, as the user named it. */
export type SourceDescriptor =
  | Readonly<{
      type: "github";
      owner: string;
      repo: string;
      ref: string;
      path: string;
    }>
  | Readonly<{ type: "https"; url: string }>
  /** A catalog on disk and its collection root, relative to the project. */
  | Readonly<{ type: "local"; path: string; root?: string }>;

/** Where an entry's files came from; paths are relative to its folder. */
export type Origin =
  | Readonly<{
      type: "github";
      owner: string;
      repo: string;
      commit: string;
      /** The repository path of the entry's source file. */
      path: string;
    }>
  | Readonly<{ type: "https"; url: string }>
  /** `root` is the collection root every file must resolve inside. */
  | Readonly<{ type: "local"; path: string; root?: string }>;

export type LockedFile = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;
export type Qualification = Readonly<{
  /** Digest of the installed files the evaluation saw. */
  files: string;
  scoreSha256: string;
  seconds: number;
  tracks: number;
  notes: number;
  assets: readonly string[];
}>;
export type LockedEntry = Readonly<{
  id: string;
  kind: string;
  title: string;
  /** SHA-256 of the catalog the entry was installed from. */
  catalog: string;
  origin: Origin;
  /** Project-relative folder holding the files. */
  dir: string;
  files: readonly LockedFile[];
  qualified?: Qualification;
}>;
export type LockedSource = Readonly<{
  name: string;
  source: SourceDescriptor;
  commit?: string;
  catalog: Readonly<{
    id: string;
    version: string;
    sha256: string;
    bytes: number;
  }>;
  entries: readonly LockedEntry[];
}>;
export type Lock = Readonly<{
  schema: typeof LOCK_SCHEMA;
  sources: readonly LockedSource[];
}>;

const fail = (message: string): never => {
  throw new Error(`${LOCK_FILE}: ${message}`);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, label: string, re?: RegExp): string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  (!re || re.test(v))
    ? v
    : fail(`${label} is invalid`);
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// A committed lock comes from whoever wrote the project: hold its names to
// the catalog's own rules so it cannot point requests or writes elsewhere.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const REPO = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\:]+$/;
/** Relative to the project; may climb out of it to a catalog beside it. */
const LOCAL_PATH = /^(?!\/)(?![A-Za-z]:)[^\\]+$/;

function descriptor(v: unknown, label: string): SourceDescriptor {
  if (!isObject(v)) return fail(`${label} is invalid`);
  if (v.type === "github")
    return {
      type: "github",
      owner: str(v.owner, `${label} owner`, OWNER),
      repo: str(v.repo, `${label} repo`, REPO),
      ref: str(v.ref, `${label} ref`, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
      path: str(v.path, `${label} path`, REPO_PATH),
    };
  if (v.type === "https")
    return { type: "https", url: str(v.url, `${label} url`, /^https:\/\//) };
  if (v.type === "local")
    return {
      type: "local",
      path: str(v.path, `${label} path`, LOCAL_PATH),
      ...(v.root === undefined
        ? {}
        : { root: str(v.root, `${label} root`, LOCAL_PATH) }),
    };
  return fail(`${label} has an unknown type`);
}
function origin(v: unknown, label: string): Origin {
  if (!isObject(v)) return fail(`${label} is invalid`);
  if (v.type === "github")
    return {
      type: "github",
      owner: str(v.owner, `${label} owner`, OWNER),
      repo: str(v.repo, `${label} repo`, REPO),
      commit: str(v.commit, `${label} commit`, COMMIT),
      path: str(v.path, `${label} path`, REPO_PATH),
    };
  return descriptor(v, label) as Origin;
}

export function parseLock(value: unknown): Lock {
  if (
    !isObject(value) ||
    value.schema !== LOCK_SCHEMA ||
    !Array.isArray(value.sources)
  )
    return fail(`schema must be ${LOCK_SCHEMA}`);
  const names = new Set<string>();
  const dirs = new Set<string>();
  const sources = value.sources.map((s, i): LockedSource => {
    const label = `source ${i + 1}`;
    if (!isObject(s) || !isObject(s.catalog) || !Array.isArray(s.entries))
      return fail(`${label} is invalid`);
    const name = str(s.name, `${label} name`, SLUG);
    if (names.has(name)) fail(`source ${name} appears twice`);
    names.add(name);
    const entries = s.entries.map((e, j): LockedEntry => {
      const el = `${name} entry ${j + 1}`;
      if (!isObject(e) || !Array.isArray(e.files))
        return fail(`${el} is invalid`);
      const dir = str(e.dir, `${el} dir`);
      if (dir !== `collections/${name}/${String(e.id)}` || dirs.has(dir))
        fail(`${el} dir must be collections/${name}/<entry id>`);
      dirs.add(dir);
      const files = e.files.map((f): LockedFile => {
        if (!isObject(f)) return fail(`${el} file is invalid`);
        const path = str(f.path, `${el} file path`);
        if (artifactPathProblem(path))
          fail(`${el} file ${path} is not allowed`);
        const bytes = f.bytes;
        if (
          typeof bytes !== "number" ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0
        )
          fail(`${el} file bytes is invalid`);
        return {
          path,
          sha256: str(f.sha256, `${el} file sha256`, SHA),
          bytes: bytes as number,
        };
      });
      const q = e.qualified;
      return {
        id: str(e.id, `${el} id`, SLUG),
        kind: str(e.kind, `${el} kind`),
        title: str(e.title, `${el} title`),
        catalog: str(e.catalog, `${el} catalog`, SHA),
        origin: origin(e.origin, `${el} origin`),
        dir,
        files,
        ...(isObject(q)
          ? {
              qualified: {
                files: str(q.files, `${el} qualified files`, SHA),
                scoreSha256: str(q.scoreSha256, `${el} qualified score`, SHA),
                seconds: Number(q.seconds),
                tracks: Number(q.tracks),
                notes: Number(q.notes),
                assets: Array.isArray(q.assets)
                  ? q.assets.map((a) => str(a, `${el} asset`))
                  : [],
              },
            }
          : {}),
      };
    });
    const c = s.catalog;
    return {
      name,
      source: descriptor(s.source, `${label} source`),
      ...(s.commit === undefined
        ? {}
        : { commit: str(s.commit, `${label} commit`, COMMIT) }),
      catalog: {
        id: str(c.id, `${label} catalog id`),
        version: str(c.version, `${label} catalog version`),
        sha256: str(c.sha256, `${label} catalog sha256`, SHA),
        bytes: Number(c.bytes),
      },
      entries,
    };
  });
  return { schema: LOCK_SCHEMA, sources };
}

export async function readLock(project: string): Promise<Lock> {
  let bytes: Buffer;
  try {
    bytes = await readInside(
      project,
      join(project, LOCK_FILE),
      LOCK_MAX_BYTES,
      LOCK_FILE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schema: LOCK_SCHEMA, sources: [] };
    throw error;
  }
  try {
    return parseLock(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail("is not JSON");
    throw error;
  }
}

/** Stable order and field order, so equal locks are equal bytes. */
export function lockText(lock: Lock): string {
  const order = <T extends { name?: string; id?: string; path?: string }>(
    xs: readonly T[],
  ) =>
    [...xs].sort((a, b) => {
      const ka = a.name ?? a.id ?? a.path ?? "";
      const kb = b.name ?? b.id ?? b.path ?? "";
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return jsonText({
    schema: LOCK_SCHEMA,
    sources: order(lock.sources).map((s) => ({
      name: s.name,
      source: s.source,
      ...(s.commit ? { commit: s.commit } : {}),
      catalog: s.catalog,
      entries: order(s.entries).map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        catalog: e.catalog,
        origin: e.origin,
        dir: e.dir,
        files: order(e.files).map((f) => ({
          path: f.path,
          sha256: f.sha256,
          bytes: f.bytes,
        })),
        ...(e.qualified ? { qualified: e.qualified } : {}),
      })),
    })),
  });
}

export async function writeLock(project: string, lock: Lock): Promise<void> {
  const text = lockText(lock);
  parseLock(JSON.parse(text));
  await replaceFile(join(project, LOCK_FILE), text);
}

/** One collection command at a time per project. */
export async function withProjectLock<T>(
  project: string,
  action: () => Promise<T>,
): Promise<T> {
  const path = join(project, ".collections.lock.busy");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `another collection command is changing this project; if none is running, delete ${path}`,
      );
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}

/** Parse catalog bytes, rejecting anything that is not one. */
export function catalogOf(bytes: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("catalog is not JSON");
  }
  return parseCollection(value);
}
