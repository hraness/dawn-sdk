/**
 * Collection authoring: check a catalog, propose an entry from a local
 * manifest, and build a deterministic portable catalog with an integrity
 * inventory. Nothing here downloads, evaluates or publishes anything.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import {
  COLLECTION_KINDS,
  COLLECTION_LIMITS,
  parseCollection,
  type Collection,
  type CollectionEntry,
  type CollectionKind,
} from "../../core/collection.ts";
import type { CollectionHooks } from "./install.ts";
import {
  contained,
  hashFile,
  isInside,
  jsonText,
  openInside,
  publishNew,
  readInside,
  replaceFile,
  sha256Hex,
  streamHandle,
} from "./local.ts";
import {
  artifactPathProblem,
  checkArtifactPaths,
  contentProblem,
  TRANSFER_LIMITS,
} from "./policy.ts";
import { catalogPage } from "./site.ts";

export const COLLECTION_MAX_BYTES = 8 * 1024 * 1024;
export const COLLECTION_HASH_BUDGET = 64 * 1024 * 1024;
export const INVENTORY_SCHEMA = "dawn.collection-inventory/v1";
const toPosix = (path: string) => path.split("\\").join("/");

export async function readCatalog(
  root: string,
  path: string,
): Promise<{ catalog: Collection; raw: unknown; bytes: Buffer }> {
  const bytes = await readInside(
    root,
    path,
    COLLECTION_MAX_BYTES,
    "catalog",
  ).catch((error) => {
    if (/exceeds/.test((error as Error).message))
      throw new Error("catalog exceeds 8 MiB");
    throw error;
  });
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  return { catalog: parseCollection(raw), raw, bytes };
}

async function openRoot(path: string, requestedRoot?: string) {
  const root = await realpath(requestedRoot ?? dirname(path));
  if (!(await stat(root)).isDirectory())
    throw new Error("collection root must be a directory");
  const catalogPath = await realpath(path);
  contained(root, catalogPath);
  return { root, catalogPath };
}

/** The local files of an entry: each with its path in the entry and on disk. */
function localFiles(catalogPath: string, entry: CollectionEntry) {
  if (entry.source.type !== "local") return [];
  const source = resolve(dirname(catalogPath), entry.source.path);
  if (!entry.files)
    return [
      {
        path: basename(source),
        abs: source,
        ...(entry.source.sha256 !== undefined
          ? { sha256: entry.source.sha256, bytes: entry.source.bytes! }
          : {}),
      },
    ];
  return entry.files.map((f) => ({
    ...f,
    abs: resolve(dirname(source), f.path),
  }));
}

export async function checkCatalog(path: string, requestedRoot?: string) {
  const { root, catalogPath } = await openRoot(path, requestedRoot);
  const { catalog } = await readCatalog(root, catalogPath);
  let localFileCount = 0,
    verifiedHashes = 0,
    remoteUnchecked = 0,
    budget = COLLECTION_HASH_BUDGET;
  for (const entry of catalog.entries) {
    if (entry.source.type !== "local") {
      remoteUnchecked++;
      continue;
    }
    for (const file of localFiles(catalogPath, entry)) {
      const { handle, before } = await openInside(root, file.abs);
      try {
        localFileCount++;
        if (file.sha256 === undefined) continue;
        if (before.size !== file.bytes)
          throw new Error(
            `${entry.id}: declared byte size does not match local file`,
          );
        if (before.size > budget)
          throw new Error("local hash checks exceed 64 MiB total");
        budget -= before.size;
        const got = await streamHandle(handle, before, entry.id);
        if (got.sha256 !== file.sha256)
          throw new Error(`${entry.id}: SHA-256 does not match local file`);
        verifiedHashes++;
      } finally {
        await handle.close();
      }
    }
  }
  return {
    ok: true,
    collection: catalog.id,
    version: catalog.version,
    entries: catalog.entries.length,
    localFiles: localFileCount,
    verifiedHashes,
    remoteUnchecked,
  };
}

// -- add ------------------------------------------------------------------

/** Folders of a project that hold private or regenerable material. */
const PROJECT_SKIPS = [
  /^trace(\/|$)/,
  /^tracks\/[^/]+\/(downloads|references|stems)(\/|$)/,
];

type Found = { path: string; sha256: string; bytes: number };

/** Every regular file under `dir` that may be installed, bounded. */
async function enumerate(
  root: string,
  dir: string,
  project: boolean,
): Promise<{ files: Found[]; skipped: string[] }> {
  const files: Found[] = [];
  const skipped: string[] = [];
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    const handle = await opendir(join(dir, rel));
    const names: string[] = [];
    for await (const d of handle) names.push(d.name);
    names.sort();
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name;
      const abs = join(dir, path);
      const info = await lstat(abs);
      if (project && PROJECT_SKIPS.some((re) => re.test(path))) {
        skipped.push(
          `${path}: project history and downloads are not distributed`,
        );
        continue;
      }
      const problem = artifactPathProblem(path);
      if (
        problem &&
        !(
          info.isDirectory() &&
          /\.(zip|tar|tgz|gz|bz2|xz|zst|7z|rar|jar)$/i.test(path)
        )
      ) {
        skipped.push(problem);
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push(`${path}: links are not followed`);
        continue;
      }
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) {
        skipped.push(`${path}: not a regular file`);
        continue;
      }
      if (files.length >= COLLECTION_LIMITS.maxFiles)
        throw new Error(
          `more than ${COLLECTION_LIMITS.maxFiles} files; split the entry`,
        );
      const { handle, before } = await openInside(root, abs);
      try {
        total += before.size;
        if (total > TRANSFER_LIMITS.totalBytes)
          throw new Error(
            `files exceed ${TRANSFER_LIMITS.totalBytes} bytes; split the entry`,
          );
        const got = await streamHandle(handle, before, path);
        const bad = contentProblem(path, got.head);
        if (bad) {
          skipped.push(bad);
          continue;
        }
        files.push({ path, sha256: got.sha256, bytes: got.bytes });
      } finally {
        await handle.close();
      }
    }
  };
  await walk("");
  return { files, skipped };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^([0-9])/, "x-$1")
    .slice(0, 64)
    .replace(/-+$/, "") || "entry";
const AUDIO = /\.(wav|flac|ogg|mp3|aif|aiff|m4a|opus)$/i;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function jsonOf(
  root: string,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(
      (
        await readInside(root, path, COLLECTION_MAX_BYTES, basename(path))
      ).toString("utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
const textField = (v: unknown) =>
  typeof v === "string" &&
  v.trim() &&
  v.length <= COLLECTION_LIMITS.maxText &&
  !/[\u0000-\u001f]/.test(v)
    ? v
    : undefined;

/** What a local path looks like as a catalog entry. */
async function inspect(root: string, path: string) {
  const info = await stat(path);
  let kind: CollectionKind | undefined;
  let source = path;
  let folder: string | undefined;
  let meta: Record<string, unknown> | undefined;
  if (info.isDirectory()) {
    if (await exists(join(path, "dawn.json"))) {
      kind = "song";
      source = join(path, "song.ts");
      folder = path;
      meta = await jsonOf(root, join(path, "dawn.json"));
    } else if (await exists(join(path, "album.json"))) {
      kind = "album";
      source = join(path, "album.json");
      folder = path;
      meta = await jsonOf(root, source);
    } else if (await exists(join(path, "dawn.composer.json"))) {
      kind = "composer";
      source = join(path, "dawn.composer.json");
      folder = path;
      meta = await jsonOf(root, source);
    } else if (await exists(join(path, "dawn.collection.json"))) {
      kind = "collection";
      source = join(path, "dawn.collection.json");
      meta = await jsonOf(root, source);
    } else if (await exists(join(path, "patches.json"))) {
      kind = "patch-pack";
      source = join(path, "patches.json");
      meta = await jsonOf(root, source);
    } else
      throw new Error(
        "the folder has no dawn.json, album.json, dawn.composer.json, dawn.collection.json or patches.json; name the manifest file",
      );
  } else if (basename(path) === "song.ts") {
    kind = "song";
    if (await exists(join(dirname(path), "dawn.json"))) {
      folder = dirname(path);
      meta = await jsonOf(root, join(folder, "dawn.json"));
    }
  } else if (extname(path) === ".json") {
    meta = await jsonOf(root, path);
    const schema = meta?.schema;
    if (schema === "dawn.palette/v1") kind = "palette";
    else if (schema === "dawn.collection/v1") kind = "collection";
    else if (schema === "dawn.composer-plugin/v1") {
      kind = "composer";
      folder = dirname(path);
    } else if (schema === "dawn.album/v1") {
      kind = "album";
      folder = dirname(path);
    } else if (
      basename(path) === "patches.json" ||
      Array.isArray(meta?.patches)
    )
      kind = "patch-pack";
  } else if (AUDIO.test(path)) kind = "loop";
  if (!(await exists(source)))
    throw new Error(`${relative(root, source)} does not exist`);
  const credits = textField(meta?.author) ?? textField(meta?.curator);
  const license = textField(meta?.license);
  return {
    kind,
    source,
    folder,
    title: textField(meta?.title) ?? textField(meta?.name),
    credits: credits ? [credits] : [],
    licenses: license ? { content: license } : {},
    idHint: slug(basename(folder ?? (info.isDirectory() ? path : source))),
  };
}

export type AddOptions = Readonly<{
  root?: string;
  id?: string;
  kind?: string;
  title?: string;
  credits: readonly string[];
  licenses: Readonly<Record<string, string>>;
  apply: boolean;
}>;

/** Propose one entry for a local manifest; with `apply`, add it to the catalog. */
export async function addEntry(
  catalogFile: string,
  target: string,
  options: AddOptions,
) {
  const { root, catalogPath } = await openRoot(catalogFile, options.root);
  const { raw } = await readCatalog(root, catalogPath);
  const real = await realpath(target);
  contained(root, real);
  const found = await inspect(root, real);
  const kind = options.kind ?? found.kind;
  if (kind === undefined)
    throw new Error(
      `cannot tell what ${basename(real)} is; pass --kind ${COLLECTION_KINDS.join("|")}`,
    );
  if (!(COLLECTION_KINDS as readonly string[]).includes(kind))
    throw new Error(`--kind takes ${COLLECTION_KINDS.join(", ")}`);
  const catalogDir = dirname(catalogPath);
  const sourcePath = toPosix(relative(catalogDir, found.source));
  let files: Found[] | undefined;
  let skipped: string[] = [];
  if (found.folder) {
    ({ files, skipped } = await enumerate(root, found.folder, kind === "song"));
    const own = toPosix(relative(found.folder, found.source));
    if (!files.some((f) => f.path === own))
      throw new Error(`${own} cannot be distributed`);
  }
  const single = files
    ? undefined
    : await (async () => {
        const { handle, before } = await openInside(root, found.source);
        try {
          const got = await streamHandle(
            handle,
            before,
            basename(found.source),
          );
          const bad = contentProblem(basename(found.source), got.head);
          if (bad) throw new Error(bad);
          return got;
        } finally {
          await handle.close();
        }
      })();
  if (!files) checkArtifactPaths([basename(found.source)]);
  const own = files?.find(
    (f) => f.path === toPosix(relative(found.folder!, found.source)),
  );
  const credits = options.credits.length ? [...options.credits] : found.credits;
  const licenses = Object.keys(options.licenses).length
    ? { ...options.licenses }
    : found.licenses;
  const entry = {
    id: options.id ?? found.idHint,
    kind,
    title:
      options.title ??
      found.title ??
      (options.id ?? found.idHint).replace(/-/g, " "),
    credits,
    licenses,
    source: {
      type: "local",
      path: sourcePath,
      sha256: (own ?? single)!.sha256,
      bytes: (own ?? single)!.bytes,
    },
    ...(files ? { files } : {}),
  };
  const missing = [
    ...(credits.length ? [] : ["credits (--credit <name>)"]),
    ...(Object.keys(licenses).length
      ? []
      : ["licenses (--license content=<label>)"]),
  ];
  const catalog = raw as { entries: unknown[] };
  if (catalog.entries.some((e) => (e as { id?: unknown }).id === entry.id))
    throw new Error(
      `the catalog already has an entry ${entry.id}; choose another with --id`,
    );
  const next = { ...catalog, entries: [...catalog.entries, entry] };
  if (!missing.length) parseCollection(next);
  if (options.apply) {
    if (missing.length)
      throw new Error(
        `the entry needs ${missing.join(" and ")} before --apply`,
      );
    await replaceFile(catalogPath, jsonText(next));
  }
  return {
    ok: true as const,
    applied: options.apply,
    catalog: catalogPath,
    entry,
    missing,
    skipped,
  };
}

// -- build ----------------------------------------------------------------

export type BuildOptions = Readonly<{
  root?: string;
  site: boolean;
  url?: string;
  traces: boolean;
}>;
type InventoryFile = {
  path: string;
  sha256: string;
  bytes: number;
  entries: string[];
};

/**
 * A portable copy of a catalog: its local files gathered under one folder at
 * their root-relative paths, every digest and size filled in, an integrity
 * inventory, optional metadata-only trace exports and an optional page.
 * The same inputs give the same bytes.
 */
export async function buildCatalog(
  catalogFile: string,
  outInput: string,
  options: BuildOptions,
  hooks: CollectionHooks = {},
) {
  const { root, catalogPath } = await openRoot(catalogFile, options.root);
  const { catalog } = await readCatalog(root, catalogPath);
  const out = join(
    await realpath(dirname(resolve(outInput))),
    basename(resolve(outInput)),
  );
  if (isInside(root, out))
    throw new Error("--out must be a new folder outside the collection root");
  if (
    await lstat(out).then(
      () => true,
      () => false,
    )
  )
    throw new Error("output already exists; choose a new directory");
  if (options.url !== undefined && !/^https:\/\/[^\s]+$/.test(options.url))
    throw new Error("--url takes the HTTPS address of the published catalog");
  // Read and verify everything before the output folder exists.
  const copies = new Map<
    string,
    { abs: string; sha256: string; bytes: number; entries: string[] }
  >();
  const entries: unknown[] = [];
  const remote: string[] = [];
  const projects: { id: string; dir: string }[] = [];
  let total = 0;
  for (const entry of catalog.entries) {
    if (entry.source.type !== "local") {
      remote.push(entry.id);
      entries.push(entry);
      continue;
    }
    const files = localFiles(catalogPath, entry);
    checkArtifactPaths(files.map((f) => f.path));
    const hashed: { path: string; sha256: string; bytes: number }[] = [];
    for (const file of files) {
      const { handle, before, path } = await openInside(root, file.abs);
      try {
        total += before.size;
        if (total > TRANSFER_LIMITS.totalBytes)
          throw new Error(
            `local files exceed ${TRANSFER_LIMITS.totalBytes} bytes`,
          );
        const got = await streamHandle(
          handle,
          before,
          `${entry.id}/${file.path}`,
        );
        const bad = contentProblem(`${entry.id}/${file.path}`, got.head);
        if (bad) throw new Error(bad);
        if (
          file.sha256 !== undefined &&
          (got.sha256 !== file.sha256 || got.bytes !== file.bytes)
        )
          throw new Error(
            `${entry.id}/${file.path}: SHA-256 or size does not match the catalog`,
          );
        const rel = toPosix(relative(root, file.abs));
        if (rel.startsWith("../"))
          throw new Error(
            `${entry.id}/${file.path} is outside the collection root`,
          );
        const prior = copies.get(rel);
        if (prior) prior.entries.push(entry.id);
        else
          copies.set(rel, {
            abs: path,
            sha256: got.sha256,
            bytes: got.bytes,
            entries: [entry.id],
          });
        hashed.push({ path: file.path, sha256: got.sha256, bytes: got.bytes });
      } finally {
        await handle.close();
      }
    }
    const sourceRel = toPosix(
      relative(root, resolve(dirname(catalogPath), entry.source.path)),
    );
    const own = entry.files
      ? hashed.find((f) => f.path === basename(sourceRel))!
      : hashed[0]!;
    const { files: _f, source: _s, ...rest } = entry;
    entries.push({
      ...rest,
      source: {
        type: "local",
        path: sourceRel,
        ...(entry.source.entry !== undefined
          ? { entry: entry.source.entry }
          : {}),
        sha256: own.sha256,
        bytes: own.bytes,
      },
      ...(entry.files
        ? { files: hashed.sort((a, b) => (a.path < b.path ? -1 : 1)) }
        : {}),
    });
    const dir = dirname(resolve(dirname(catalogPath), entry.source.path));
    if (
      entry.kind === "song" &&
      (await exists(join(dir, "dawn.json"))) &&
      (await exists(join(dir, "trace")))
    )
      projects.push({ id: entry.id, dir });
  }
  const portable = parseCollection({ ...catalog, entries });
  const catalogText = jsonText(portable);
  for (const rel of copies.keys()) {
    const key = rel.toLowerCase();
    if (
      ["dawn.collection.json", "dawn.inventory.json", "index.html"].includes(
        key,
      ) ||
      key === "traces" ||
      key.startsWith("traces/")
    )
      throw new Error(`${rel} is reserved in the built collection`);
  }
  await mkdir(out, { mode: 0o755 });
  for (const [rel, copy] of [...copies].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const target = join(out, rel);
    await mkdir(dirname(target), { recursive: true });
    // Copy without holding the file in memory, verify, then publish.
    const temporary = `${target}.${randomUUID()}.tmp`;
    await copyFile(copy.abs, temporary, constants.COPYFILE_EXCL);
    try {
      if ((await hashFile(temporary))?.sha256 !== copy.sha256)
        throw new Error(`${rel} changed during the build`);
      await link(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  const traces: {
    entry: string;
    events: number;
    files: Omit<InventoryFile, "entries">[];
  }[] = [];
  const traceSkipped: { entry: string; reason: string }[] = [];
  if (options.traces && projects.length) {
    if (!hooks.exportTrace)
      for (const p of projects)
        traceSkipped.push({
          entry: p.id,
          reason: "trace export needs the full dawn command",
        });
    else {
      await mkdir(join(out, "traces"));
      for (const p of projects) {
        try {
          const exported = await hooks.exportTrace(
            p.dir,
            join(out, "traces", p.id),
          );
          const files: Omit<InventoryFile, "entries">[] = [];
          for (const f of [...exported.files].sort()) {
            const data = await readFile(join(out, "traces", p.id, f));
            files.push({
              path: `traces/${p.id}/${f}`,
              sha256: sha256Hex(data),
              bytes: data.length,
            });
          }
          traces.push({ entry: p.id, events: exported.events, files });
        } catch (error) {
          traceSkipped.push({
            entry: p.id,
            reason: (error as Error).message.slice(0, 200),
          });
        }
      }
    }
  }
  await publishNew(join(out, "dawn.collection.json"), catalogText);
  const page = options.site ? catalogPage(portable, options.url) : undefined;
  if (page) await publishNew(join(out, "index.html"), page);
  const inventory = {
    schema: INVENTORY_SCHEMA,
    collection: portable.id,
    version: portable.version,
    catalog: {
      path: "dawn.collection.json",
      sha256: sha256Hex(catalogText),
      bytes: Buffer.byteLength(catalogText),
    },
    files: [...copies]
      .map(([path, c]) => ({
        path,
        sha256: c.sha256,
        bytes: c.bytes,
        entries: c.entries,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    remote: remote.sort(),
    traces,
    ...(page
      ? {
          site: {
            path: "index.html",
            sha256: sha256Hex(page),
            bytes: Buffer.byteLength(page),
          },
        }
      : {}),
  };
  await publishNew(join(out, "dawn.inventory.json"), jsonText(inventory));
  return {
    ok: true as const,
    collection: portable.id,
    out,
    entries: portable.entries.length,
    files: copies.size,
    bytes: [...copies.values()].reduce((n, c) => n + c.bytes, 0),
    remote: remote.length,
    traces: traces.length,
    traceSkipped,
    site: page !== undefined,
  };
}
