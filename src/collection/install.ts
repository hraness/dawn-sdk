/**
 * Pinned installation of selected collection entries. A moving Git ref is
 * resolved once to a commit; only the selected entries' declared files are
 * transferred, verified and published into the content-addressed cache, then
 * copied into the project; the project lock records the source, commit,
 * catalog digest and every file's digest and size. Nothing here evaluates
 * the content it installs: song evaluation is the separate `qualify` step.
 */
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { link, rename, realpath } from "node:fs/promises";
import {
  parseCollectionSource,
  sourceFileName,
  type Collection,
  type CollectionEntry,
} from "../../core/collection.ts";
import { syncDirectory } from "../fs/durable.ts";
import { defaultCacheDir, ObjectCache } from "./cache.ts";
import {
  catalogOf,
  readLock,
  withProjectLock,
  writeLock,
  type Lock,
  type LockedEntry,
  type LockedFile,
  type LockedSource,
  type Origin,
  type SourceDescriptor,
} from "./lock.ts";
import {
  hashFile,
  isInside,
  openInside,
  readInside,
  sha256Hex,
  streamHandle,
} from "./local.ts";
import {
  fetchBounded,
  githubFileUrl,
  newSession,
  resolveGithubRef,
  type NetConfig,
  type Session,
} from "./net.ts";
import {
  checkArtifactPaths,
  contentProblem,
  TRANSFER_LIMITS,
} from "./policy.ts";

/** What a song evaluation reports to `qualify`; supplied by the full CLI. */
export type SongEvaluation =
  | Readonly<{
      ok: true;
      scoreSha256: string;
      seconds: number;
      tracks: number;
      notes: number;
      /** Files the score names, relative to the evaluated folder. */
      names: readonly string[];
    }>
  | Readonly<{ ok: false; problem: string }>;
export type CollectionHooks = Readonly<{
  /** Write a metadata-only trace export of `project` into the new folder `out`. */
  exportTrace?: (
    project: string,
    out: string,
  ) => Promise<Readonly<{ events: number; files: readonly string[] }>>;
  /** Evaluate the song in `dir` in the sealed song engine. */
  evaluateSong?: (dir: string, timeoutMs: number) => Promise<SongEvaluation>;
}>;
export type CollectionDeps = Readonly<{
  net?: NetConfig;
  cacheDir?: string;
  hooks?: CollectionHooks;
  /** Overrides `gh auth token` for --auth gh (tests). */
  token?: () => Promise<string>;
}>;

export type Context = {
  project: string;
  cache: ObjectCache;
  session: Session;
  deps: CollectionDeps;
};

export async function context(
  project: string,
  deps: CollectionDeps,
  options: Readonly<{
    offline?: boolean;
    token?: string;
    timeoutMs?: number;
    maxBytes?: number;
  }>,
): Promise<Context> {
  const real = await realpath(project);
  return {
    project: real,
    cache: new ObjectCache(deps.cacheDir ?? defaultCacheDir()),
    session: newSession({
      ...options,
      ...(deps.net ? { config: deps.net } : {}),
    }),
    deps,
  };
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const toPosix = (path: string) => path.split("\\").join("/");

// -- Naming a source ------------------------------------------------------

/** A catalog named by a GitHub URL, an HTTPS URL or a local path. */
export function describeTarget(
  target: string,
  options: Readonly<{ ref?: string; path?: string; root?: string }>,
  cwd: string,
  project: string,
): SourceDescriptor {
  let url: URL | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      url = new URL(target);
    } catch {
      throw new Error("not a valid URL");
    }
  }
  if (url && options.root !== undefined)
    throw new Error("--root applies to a local catalog");
  const catalogPath = (path: string | undefined) =>
    path === undefined || path === ""
      ? "dawn.collection.json"
      : path.endsWith(".json")
        ? path
        : `${path.replace(/\/$/, "")}/dawn.collection.json`;
  if (
    url &&
    (url.hostname === "github.com" ||
      url.hostname === "raw.githubusercontent.com")
  ) {
    if (url.search || url.hash)
      throw new Error("GitHub URLs must not have a query or fragment");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const raw = url.hostname === "raw.githubusercontent.com";
    const [owner, repoName, ...rest] = parts;
    if (!owner || !repoName)
      throw new Error("a GitHub URL needs an owner and a repository");
    const repo = repoName.replace(/\.git$/, "");
    let ref = "HEAD",
      path: string | undefined;
    if (raw) {
      ref = rest[0] ?? fail("a raw GitHub URL needs a ref and a path");
      path = rest.slice(1).join("/");
    } else if (rest[0] === "tree" || rest[0] === "blob") {
      // Only the first segment is taken as the ref; a ref with a slash
      // needs --ref and --path, since the URL alone is ambiguous.
      ref = rest[1] ?? fail("the GitHub URL names no ref");
      path = rest.slice(2).join("/") || undefined;
    } else if (rest.length)
      throw new Error("use a github.com/<owner>/<repo>/tree/<ref>/<path> URL");
    const source = parseCollectionSource(
      {
        type: "github",
        owner,
        repo,
        ref: options.ref ?? ref,
        path: options.path ?? catalogPath(path),
      },
      "catalog source",
    );
    const {
      type: _t,
      owner: o,
      repo: r,
      ref: f,
      path: p,
    } = source as Extract<typeof source, { type: "github" }>;
    return { type: "github", owner: o, repo: r, ref: f, path: p };
  }
  if (options.ref !== undefined || options.path !== undefined)
    throw new Error("--ref and --path apply to GitHub URLs");
  if (url) {
    const source = parseCollectionSource(
      { type: "https", url: target },
      "catalog URL",
    );
    return { type: "https", url: (source as { url: string }).url };
  }
  const abs = resolve(cwd, catalogPath(target));
  return {
    type: "local",
    path: toPosix(relative(project, abs)),
    ...(options.root === undefined
      ? {}
      : {
          root: toPosix(relative(project, resolve(cwd, options.root))) || ".",
        }),
  };
}
function fail(message: string): never {
  throw new Error(message);
}
const sameDescriptor = (a: SourceDescriptor, b: SourceDescriptor) =>
  JSON.stringify(a) === JSON.stringify(b);
export const describe = (s: SourceDescriptor) =>
  s.type === "github"
    ? `github.com/${s.owner}/${s.repo}@${s.ref}:${s.path}`
    : s.type === "https"
      ? s.url
      : s.path;

// -- Reading a catalog ----------------------------------------------------

type Base =
  | Readonly<{
      type: "github";
      owner: string;
      repo: string;
      commit: string;
      dir: string;
    }>
  | Readonly<{ type: "https"; url: string }>
  | Readonly<{ type: "local"; root: string; dir: string }>;
type Opened = Readonly<{
  descriptor: SourceDescriptor;
  commit?: string;
  sha256: string;
  bytes: number;
  catalog: Collection;
  base: Base;
}>;

async function cacheBytes(ctx: Context, bytes: Uint8Array): Promise<string> {
  const sha = sha256Hex(bytes);
  if (await ctx.cache.has(sha)) return sha;
  const w = await ctx.cache.writer();
  try {
    await w.write(bytes);
    await w.commit(sha);
  } catch (error) {
    await w.abort();
    throw error;
  }
  return sha;
}

async function openCatalog(
  ctx: Context,
  descriptor: SourceDescriptor,
  pinned: Readonly<{ commit?: string; sha256?: string; root?: string }> = {},
): Promise<Opened> {
  let bytes: Buffer | undefined;
  if (pinned.sha256)
    bytes = await ctx.cache.read(pinned.sha256, TRANSFER_LIMITS.catalogBytes);
  let commit: string | undefined;
  let base: Base;
  if (descriptor.type === "local") {
    const abs = resolve(ctx.project, descriptor.path);
    const root = await realpath(
      descriptor.root === undefined
        ? dirname(abs)
        : resolve(ctx.project, descriptor.root),
    );
    const real = await realpath(abs);
    base = { type: "local", root, dir: dirname(real) };
    bytes = await readInside(
      root,
      real,
      TRANSFER_LIMITS.catalogBytes,
      "catalog",
    );
  } else {
    if (descriptor.type === "github") {
      commit =
        pinned.commit ??
        (await resolveGithubRef(
          ctx.session,
          descriptor.owner,
          descriptor.repo,
          descriptor.ref,
        ));
      base = {
        type: "github",
        owner: descriptor.owner,
        repo: descriptor.repo,
        commit,
        dir:
          posix.dirname(descriptor.path) === "."
            ? ""
            : posix.dirname(descriptor.path),
      };
    } else base = { type: "https", url: descriptor.url };
    if (!bytes) {
      const chunks: Uint8Array[] = [];
      const at =
        descriptor.type === "github"
          ? githubFileUrl(
              ctx.session,
              descriptor.owner,
              descriptor.repo,
              commit!,
              descriptor.path,
            )
          : { url: descriptor.url };
      await fetchBounded(ctx.session, at.url, {
        label: "catalog",
        ...(at.accept ? { accept: at.accept } : {}),
        ...("auth" in at && at.auth ? { auth: true } : {}),
        maxBytes: TRANSFER_LIMITS.catalogBytes,
        raw: true,
        ...(pinned.sha256 ? { expect: { sha256: pinned.sha256 } } : {}),
        onChunk: (c) => {
          chunks.push(c);
        },
      });
      bytes = Buffer.concat(chunks);
    }
  }
  const problem = contentProblem("catalog", bytes.subarray(0, 1024));
  if (problem) throw new Error(problem);
  const catalog = catalogOf(bytes);
  const sha256 = await cacheBytes(ctx, bytes);
  return {
    descriptor,
    ...(commit ? { commit } : {}),
    sha256,
    bytes: bytes.length,
    catalog,
    base,
  };
}

// -- Planning an entry ----------------------------------------------------

type PlannedFile = { path: string; sha256?: string; bytes?: number };
type Planned = Readonly<{
  entry: CollectionEntry;
  origin: Origin;
  files: readonly PlannedFile[];
  dir: string;
}>;

function linkHint(entry: CollectionEntry): string {
  const s = entry.source;
  return s.type === "github"
    ? `https://github.com/${s.owner}/${s.repo}/blob/${s.ref}/${s.path}`
    : s.type === "https"
      ? s.url
      : s.path;
}

async function planEntry(
  ctx: Context,
  opened: Opened,
  entry: CollectionEntry,
  name: string,
): Promise<Planned> {
  if (entry.kind === "collection")
    throw new Error(
      `${entry.id} is a link to another collection; add it on its own: dawn-collection install ${linkHint(entry)}`,
    );
  const s = entry.source;
  if (s.entry !== undefined)
    throw new Error(
      `${entry.id} refers to entry ${s.entry} of another catalog; install it from that catalog: dawn-collection install ${linkHint(entry)} ${s.entry}`,
    );
  let origin: Origin;
  if (s.type === "github") {
    const commit = await resolveGithubRef(ctx.session, s.owner, s.repo, s.ref);
    origin = {
      type: "github",
      owner: s.owner,
      repo: s.repo,
      commit,
      path: s.path,
    };
  } else if (s.type === "https") origin = { type: "https", url: s.url };
  else {
    const b = opened.base;
    if (b.type === "github") {
      const path = posix.normalize(posix.join(b.dir, s.path));
      if (path === ".." || path.startsWith("../"))
        throw new Error(`${entry.id}: path leaves the repository`);
      origin = {
        type: "github",
        owner: b.owner,
        repo: b.repo,
        commit: b.commit,
        path,
      };
    } else if (b.type === "https") {
      const catalogUrl = new URL(b.url);
      const url = new URL(
        s.path.split("/").map(encodeURIComponent).join("/"),
        catalogUrl,
      );
      const folder = catalogUrl.pathname.slice(
        0,
        catalogUrl.pathname.lastIndexOf("/") + 1,
      );
      if (url.origin !== catalogUrl.origin || !url.pathname.startsWith(folder))
        throw new Error(`${entry.id}: path leaves the catalog's folder`);
      origin = { type: "https", url: url.href };
    } else {
      const abs = resolve(b.dir, s.path);
      const folder = await realpath(dirname(abs)).catch(() => dirname(abs));
      if (!isInside(b.root, abs) || !isInside(b.root, folder))
        throw new Error(`${entry.id}: path leaves the collection root`);
      origin = {
        type: "local",
        path: toPosix(relative(ctx.project, abs)),
        root: toPosix(relative(ctx.project, b.root)) || ".",
      };
    }
  }
  const files: PlannedFile[] = entry.files
    ? entry.files.map((f) => ({ ...f }))
    : [
        {
          path: sourceFileName(s),
          ...(s.sha256 !== undefined
            ? { sha256: s.sha256, bytes: s.bytes }
            : {}),
        },
      ];
  checkArtifactPaths(files.map((f) => f.path));
  if (origin.type === "https" && files.some((f) => f.sha256 === undefined))
    throw new Error(
      `${entry.id}: files on an HTTPS host need sha256 and bytes in the catalog; only commit-addressed Git files may omit them`,
    );
  return { entry, origin, files, dir: `collections/${name}/${entry.id}` };
}

// -- Transfers ------------------------------------------------------------

/** Bring one file into the cache, verified; returns its digest and size. */
async function acquire(
  ctx: Context,
  origin: Origin,
  file: PlannedFile,
): Promise<LockedFile> {
  if (
    file.sha256 !== undefined &&
    (await ctx.cache.has(file.sha256, file.bytes))
  )
    return { path: file.path, sha256: file.sha256, bytes: file.bytes! };
  const label = file.path;
  const w = await ctx.cache.writer();
  try {
    let got: { sha256: string; bytes: number };
    if (origin.type === "local") {
      // Every file must resolve inside the collection root it was planned in.
      const root = await realpath(
        resolve(ctx.project, origin.root ?? dirname(origin.path)),
      );
      const { handle, before } = await openInside(
        root,
        resolve(ctx.project, dirname(origin.path), file.path),
      );
      try {
        if (file.bytes !== undefined && before.size !== file.bytes)
          throw new Error(
            `${label}: ${before.size} bytes where ${file.bytes} were declared`,
          );
        if (before.size > ctx.session.maxBytes - ctx.session.bytes)
          throw new Error(`${label}: over the command's byte budget`);
        const r = await streamHandle(handle, before, label, (c) => w.write(c));
        const problem = contentProblem(label, r.head);
        if (problem) throw new Error(problem);
        ctx.session.bytes += r.bytes;
        got = r;
      } finally {
        await handle.close();
      }
      if (file.sha256 !== undefined && got.sha256 !== file.sha256)
        throw new Error(`${label}: SHA-256 does not match the declared digest`);
    } else {
      const at =
        origin.type === "github"
          ? githubFileUrl(
              ctx.session,
              origin.owner,
              origin.repo,
              origin.commit,
              posix.join(posix.dirname(origin.path), file.path),
            )
          : {
              url: new URL(
                file.path.split("/").map(encodeURIComponent).join("/"),
                origin.url,
              ).href,
            };
      got = await fetchBounded(ctx.session, at.url, {
        label,
        ...("accept" in at && at.accept ? { accept: at.accept } : {}),
        ...("auth" in at && at.auth ? { auth: true } : {}),
        maxBytes: file.bytes ?? TRANSFER_LIMITS.undeclaredBytes,
        ...(file.sha256 !== undefined
          ? { expect: { sha256: file.sha256, bytes: file.bytes } }
          : {}),
        onChunk: (c) => w.write(c),
      });
    }
    await w.commit(got.sha256);
    return { path: file.path, sha256: got.sha256, bytes: got.bytes };
  } catch (error) {
    await w.abort();
    throw error;
  }
}

// -- Writing into the project ---------------------------------------------

/** Create `dir` under the project, refusing any link or non-folder on the way. */
async function safeDir(project: string, dir: string): Promise<string> {
  let at = project;
  for (const part of dir.split("/")) {
    at = join(at, part);
    try {
      const info = await lstat(at);
      if (!info.isDirectory())
        throw new Error(`${relative(project, at)} is not a folder`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(at);
    }
  }
  return at;
}

type DiskState = "missing" | "other" | string;
async function diskState(path: string): Promise<DiskState> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
  return (await hashFile(path))?.sha256 ?? "missing";
}

/**
 * Write `files` of an entry into the project. A file already holding the
 * wanted bytes is kept; one holding `replaceable` bytes (the previous locked
 * version) is replaced; anything else is an edit and is never overwritten.
 */
async function materialize(
  ctx: Context,
  dir: string,
  files: readonly LockedFile[],
  replaceable: ReadonlyMap<string, string> = new Map(),
  check = false,
): Promise<{ written: number; edited: string[] }> {
  const edited: string[] = [];
  const todo: { file: LockedFile; target: string; replace: boolean }[] = [];
  for (const file of files) {
    const target = join(ctx.project, dir, file.path);
    const state = await diskState(target);
    if (state === file.sha256) continue;
    if (state === "missing") todo.push({ file, target, replace: false });
    else if (state === replaceable.get(file.path))
      todo.push({ file, target, replace: true });
    else edited.push(`${dir}/${file.path}`);
  }
  if (check) return { written: todo.length, edited };
  for (const { file, target, replace } of todo) {
    const parent = await safeDir(
      ctx.project,
      posix.dirname(`${dir}/${file.path}`),
    );
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    await copyFile(ctx.cache.path(file.sha256), temporary);
    try {
      const got = await hashFile(temporary);
      if (got?.sha256 !== file.sha256)
        throw new Error(
          `${file.path}: cached copy is damaged; run the command again`,
        );
      if (replace) await rename(temporary, target);
      else await link(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await syncDirectory(parent);
  }
  return { written: todo.length, edited };
}

// -- Commands -------------------------------------------------------------

export type InstallOptions = Readonly<{
  as?: string;
  ref?: string;
  path?: string;
  root?: string;
}>;
export type InstalledReport = Readonly<{
  id: string;
  kind: string;
  dir: string;
  files: number;
  bytes: number;
  written: number;
  evaluation?: "not qualified";
}>;

function entryOf(
  locked: Planned,
  files: readonly LockedFile[],
  catalog: string,
): LockedEntry {
  return {
    id: locked.entry.id,
    kind: locked.entry.kind,
    title: locked.entry.title,
    catalog,
    origin: locked.origin,
    dir: locked.dir,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}
const sameFiles = (a: readonly LockedFile[], b: readonly LockedFile[]) =>
  a.length === b.length &&
  a.every((f) =>
    b.some(
      (g) => g.path === f.path && g.sha256 === f.sha256 && g.bytes === f.bytes,
    ),
  );

export async function install(
  ctx: Context,
  cwd: string,
  target: string | undefined,
  ids: readonly string[],
  options: InstallOptions,
) {
  return withProjectLock(ctx.project, async () => {
    const lock = await readLock(ctx.project);
    if (target === undefined) return restore(ctx, lock);
    const byName =
      SLUG.test(target) && lock.sources.find((s) => s.name === target);
    const descriptor = byName
      ? byName.source
      : describeTarget(target, options, cwd, ctx.project);
    const existing =
      byName || lock.sources.find((s) => sameDescriptor(s.source, descriptor));
    if (descriptor.type === "github")
      ctx.session.tokenRepos.add(
        `${descriptor.owner}/${descriptor.repo}`.toLowerCase(),
      );
    if (
      existing &&
      (options.ref !== undefined || options.path !== undefined) &&
      byName
    )
      throw new Error(
        "--ref and --path apply to a new source; use update to move a source",
      );
    // A source in the lock stays at its commit; update moves it.
    const opened = await openCatalog(ctx, descriptor, {
      ...(existing?.commit ? { commit: existing.commit } : {}),
      ...(existing ? { sha256: existing.catalog.sha256 } : {}),
    });
    if (
      existing &&
      opened.sha256 !== existing.catalog.sha256 &&
      descriptor.type !== "local"
    )
      throw new Error(
        "the locked catalog changed at its pinned location; run update --dry-run",
      );
    const name = options.as ?? existing?.name ?? opened.catalog.id;
    if (!SLUG.test(name) || name.length > 64)
      throw new Error("--as takes a lowercase slug");
    if (existing && options.as !== undefined && options.as !== existing.name)
      throw new Error(`this source is installed as ${existing.name}`);
    const clash = lock.sources.find((s) => s.name === name && s !== existing);
    if (clash)
      throw new Error(
        `${name} is already the name of ${describe(clash.source)}; choose another with --as`,
      );
    const unknown = ids.filter(
      (id) => !opened.catalog.entries.some((e) => e.id === id),
    );
    if (unknown.length)
      throw new Error(
        `no entry ${unknown.join(", ")} in ${opened.catalog.id}; it has ${opened.catalog.entries.map((e) => e.id).join(", ") || "no entries"}`,
      );
    const plans: Planned[] = [];
    for (const id of new Set(ids))
      plans.push(
        await planEntry(
          ctx,
          opened,
          opened.catalog.entries.find((e) => e.id === id)!,
          name,
        ),
      );
    const declared = plans
      .flatMap((p) => p.files)
      .reduce((n, f) => n + (f.bytes ?? 0), 0);
    if (declared > ctx.session.maxBytes)
      throw new Error(
        `the selected entries declare ${declared} bytes, over the ${ctx.session.maxBytes}-byte budget`,
      );
    const fetched: { plan: Planned; files: LockedFile[] }[] = [];
    for (const plan of plans) {
      const files: LockedFile[] = [];
      for (const file of plan.files)
        files.push(await acquire(ctx, plan.origin, file));
      const before = existing?.entries.find((e) => e.id === plan.entry.id);
      if (before && !sameFiles(before.files, files))
        throw new Error(
          `${plan.entry.id} is installed with other files; run update --dry-run`,
        );
      fetched.push({ plan, files });
    }
    // Check every target before writing any, so a conflict changes nothing.
    for (const { plan, files } of fetched) {
      const { edited } = await materialize(
        ctx,
        plan.dir,
        files,
        new Map(),
        true,
      );
      if (edited.length)
        throw new Error(
          `${edited[0]} exists with other content; it was not replaced`,
        );
    }
    const reports: InstalledReport[] = [];
    for (const { plan, files } of fetched) {
      const { written } = await materialize(ctx, plan.dir, files);
      reports.push({
        id: plan.entry.id,
        kind: plan.entry.kind,
        dir: plan.dir,
        files: files.length,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        written,
        ...(plan.entry.kind === "song" || plan.entry.kind === "album"
          ? { evaluation: "not qualified" as const }
          : {}),
      });
    }
    const kept = (existing?.entries ?? []).filter(
      (e) => !fetched.some((f) => f.plan.entry.id === e.id),
    );
    const source: LockedSource = {
      name,
      source: descriptor,
      ...(opened.commit ? { commit: opened.commit } : {}),
      catalog: {
        id: opened.catalog.id,
        version: opened.catalog.version,
        sha256: opened.sha256,
        bytes: opened.bytes,
      },
      entries: [
        ...kept,
        ...fetched.map(({ plan, files }) => {
          const before = existing?.entries.find((e) => e.id === plan.entry.id);
          return before ?? entryOf(plan, files, opened.sha256);
        }),
      ],
    };
    await writeLock(ctx.project, {
      ...lock,
      sources: [...lock.sources.filter((s) => s !== existing), source],
    });
    return {
      ok: true as const,
      action: "install" as const,
      name,
      source: describe(descriptor),
      ...(opened.commit ? { commit: opened.commit } : {}),
      catalog: opened.sha256,
      installed: reports,
      available: opened.catalog.entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
      })),
      hosts: [...ctx.session.hosts].sort(),
    };
  });
}

async function restore(ctx: Context, lock: Lock) {
  const reports: {
    name: string;
    id: string;
    written: number;
    edited: string[];
  }[] = [];
  for (const source of lock.sources) {
    if (source.source.type === "github")
      ctx.session.tokenRepos.add(
        `${source.source.owner}/${source.source.repo}`.toLowerCase(),
      );
    for (const entry of source.entries) {
      const files: LockedFile[] = [];
      for (const f of entry.files)
        files.push(await acquire(ctx, entry.origin, f));
      const { written, edited } = await materialize(ctx, entry.dir, files);
      reports.push({ name: source.name, id: entry.id, written, edited });
    }
  }
  return {
    ok: true as const,
    action: "restore" as const,
    entries: reports,
    hosts: [...ctx.session.hosts].sort(),
  };
}

export type UpdateAction =
  "unchanged" | "update" | "held" | "conflict" | "removed-upstream" | "error";
export type UpdateItem = {
  name: string;
  id: string;
  kind: string;
  action: UpdateAction;
  reason?: string;
  added: string[];
  changed: string[];
  removed: string[];
  edited: string[];
};

export async function update(
  ctx: Context,
  name: string | undefined,
  ids: readonly string[],
  dryRun: boolean,
) {
  return withProjectLock(ctx.project, async () => {
    const lock = await readLock(ctx.project);
    const sources = lock.sources.filter(
      (s) => name === undefined || s.name === name,
    );
    if (name !== undefined && !sources.length)
      throw new Error(`no collection ${name} in this project`);
    if (name === undefined && ids.length)
      throw new Error("name the collection before its entries");
    for (const id of ids)
      if (!sources[0]!.entries.some((e) => e.id === id))
        throw new Error(`${id} is not installed from ${name}; use install`);
    const items: UpdateItem[] = [];
    const next: LockedSource[] = [];
    const work: {
      entry: LockedEntry;
      files: LockedFile[];
      old: LockedEntry;
      item: UpdateItem;
    }[] = [];
    const moves: {
      name: string;
      from?: string;
      to?: string;
      catalog: { from: string; to: string };
      newEntries: string[];
    }[] = [];
    for (const source of sources) {
      if (source.source.type === "github")
        ctx.session.tokenRepos.add(
          `${source.source.owner}/${source.source.repo}`.toLowerCase(),
        );
      const opened = await openCatalog(ctx, source.source);
      moves.push({
        name: source.name,
        ...(source.commit ? { from: source.commit } : {}),
        ...(opened.commit ? { to: opened.commit } : {}),
        catalog: { from: source.catalog.sha256, to: opened.sha256 },
        newEntries: opened.catalog.entries
          .filter((e) => !source.entries.some((l) => l.id === e.id))
          .map((e) => e.id),
      });
      const entries: LockedEntry[] = [];
      for (const old of source.entries) {
        const item: UpdateItem = {
          name: source.name,
          id: old.id,
          kind: old.kind,
          action: "unchanged",
          added: [],
          changed: [],
          removed: [],
          edited: [],
        };
        const fresh = opened.catalog.entries.find((e) => e.id === old.id);
        if (ids.length && !ids.includes(old.id)) {
          entries.push(old);
          continue;
        }
        items.push(item);
        if (!fresh) {
          entries.push(old);
          item.action = "removed-upstream";
          item.reason = "the catalog no longer lists it; its files are kept";
          continue;
        }
        let plan: Planned;
        const files: LockedFile[] = [];
        try {
          plan = await planEntry(ctx, opened, fresh, source.name);
          for (const f of plan.files)
            files.push(await acquire(ctx, plan.origin, f));
        } catch (error) {
          entries.push(old);
          item.action = "error";
          item.reason = (error as Error).message;
          continue;
        }
        const was = new Map(old.files.map((f) => [f.path, f.sha256]));
        const now = new Map(files.map((f) => [f.path, f.sha256]));
        item.added = files.filter((f) => !was.has(f.path)).map((f) => f.path);
        item.changed = files
          .filter((f) => was.has(f.path) && was.get(f.path) !== f.sha256)
          .map((f) => f.path);
        item.removed = old.files
          .filter((f) => !now.has(f.path))
          .map((f) => f.path);
        const entry = entryOf(plan, files, opened.sha256);
        if (
          !item.added.length &&
          !item.changed.length &&
          !item.removed.length
        ) {
          entries.push({
            ...entry,
            ...(old.qualified ? { qualified: old.qualified } : {}),
          });
          continue;
        }
        // Songs, albums and composers are code or run it: a new version
        // arrives only when named.
        if (
          (old.kind === "song" ||
            old.kind === "album" ||
            old.kind === "composer") &&
          !ids.includes(old.id)
        ) {
          entries.push(old);
          item.action = "held";
          item.reason = `a locked ${old.kind} changes only when named: dawn-collection update ${source.name} ${old.id}`;
          continue;
        }
        for (const f of old.files) {
          const state = await diskState(join(ctx.project, old.dir, f.path));
          if (
            state !== "missing" &&
            state !== f.sha256 &&
            state !== now.get(f.path)
          )
            item.edited.push(`${old.dir}/${f.path}`);
        }
        // A file the new version adds may already be the user's own.
        for (const path of item.added) {
          const state = await diskState(join(ctx.project, old.dir, path));
          if (state !== "missing" && state !== now.get(path))
            item.edited.push(`${old.dir}/${path}`);
        }
        if (item.edited.length) {
          entries.push(old);
          item.action = "conflict";
          item.reason =
            "edited project files are never replaced; move your edits aside or remove the entry";
          continue;
        }
        item.action = "update";
        entries.push(entry);
        work.push({ entry, files, old, item });
      }
      next.push({
        ...source,
        ...(opened.commit ? { commit: opened.commit } : {}),
        catalog: {
          id: opened.catalog.id,
          version: opened.catalog.version,
          sha256: opened.sha256,
          bytes: opened.bytes,
        },
        entries,
      });
    }
    if (!dryRun) {
      // The lock rolls forward one entry at a time, so a failure part way
      // leaves it describing exactly the files on disk.
      let current = lock;
      for (const { entry, files, old } of work) {
        await assertRealDir(ctx.project, old.dir);
        const { edited } = await materialize(
          ctx,
          entry.dir,
          files,
          new Map(old.files.map((f) => [f.path, f.sha256])),
        );
        if (edited.length)
          throw new Error(
            `${edited[0]} changed during the update; it was not replaced`,
          );
        for (const f of old.files)
          if (!files.some((g) => g.path === f.path)) {
            const path = join(ctx.project, old.dir, f.path);
            if ((await diskState(path)) === f.sha256) await unlink(path);
          }
        await pruneEmpty(ctx.project, old.dir);
        current = {
          ...current,
          sources: current.sources.map((s) =>
            s.entries.includes(old)
              ? { ...s, entries: s.entries.map((e) => (e === old ? entry : e)) }
              : s,
          ),
        };
        await writeLock(ctx.project, current);
      }
      await writeLock(ctx.project, {
        ...lock,
        sources: lock.sources.map(
          (s) => next.find((n) => n.name === s.name) ?? s,
        ),
      });
    }
    return {
      ok: true as const,
      action: "update" as const,
      dryRun,
      sources: moves,
      entries: items,
      hosts: [...ctx.session.hosts].sort(),
    };
  });
}

/** Refuse a folder reached through a link: deletes stay inside the project. */
async function assertRealDir(project: string, dir: string): Promise<void> {
  let at = project;
  for (const part of dir.split("/")) {
    at = join(at, part);
    try {
      if (!(await lstat(at)).isDirectory())
        throw new Error(`${relative(project, at)} is not a folder`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function pruneEmpty(project: string, dir: string): Promise<void> {
  const root = join(project, dir);
  const visit = async (path: string): Promise<boolean> => {
    let names: string[];
    try {
      const info = await lstat(path);
      if (!info.isDirectory()) return false;
      names = await readdir(path);
    } catch {
      return false;
    }
    let empty = true;
    for (const n of names) if (!(await visit(join(path, n)))) empty = false;
    if (empty) await rmdir(path).catch(() => undefined);
    return empty;
  };
  await visit(root);
  // Remove an emptied collections/<name> folder too, never the project's.
  const parent = dirname(root);
  if (
    isInside(join(project, "collections"), parent) &&
    parent !== join(project, "collections")
  )
    await rmdir(parent).catch(() => undefined);
}

export async function remove(
  ctx: Context,
  name: string,
  ids: readonly string[],
  deleteFiles: boolean,
) {
  return withProjectLock(ctx.project, async () => {
    const lock = await readLock(ctx.project);
    const source = lock.sources.find((s) => s.name === name);
    if (!source) throw new Error(`no collection ${name} in this project`);
    for (const id of ids)
      if (!source.entries.some((e) => e.id === id))
        throw new Error(`${id} is not installed from ${name}`);
    const gone = source.entries.filter(
      (e) => !ids.length || ids.includes(e.id),
    );
    const kept: string[] = [];
    let deleted = 0;
    if (deleteFiles)
      for (const entry of gone) {
        await assertRealDir(ctx.project, entry.dir);
        for (const f of entry.files) {
          const path = join(ctx.project, entry.dir, f.path);
          const state = await diskState(path);
          if (state === f.sha256) {
            await unlink(path);
            deleted++;
          } else if (state !== "missing") kept.push(`${entry.dir}/${f.path}`);
        }
        await pruneEmpty(ctx.project, entry.dir);
      }
    const rest = source.entries.filter((e) => !gone.includes(e));
    await writeLock(ctx.project, {
      ...lock,
      sources: ids.length
        ? lock.sources.map((s) => (s === source ? { ...s, entries: rest } : s))
        : lock.sources.filter((s) => s !== source),
    });
    return {
      ok: true as const,
      action: "remove" as const,
      name,
      removed: gone.map((e) => e.id),
      subscription: ids.length ? "kept" : "removed",
      deleted,
      kept: deleteFiles ? kept : gone.map((e) => e.dir),
    };
  });
}

export type SearchHit = Readonly<{
  name: string;
  id: string;
  kind: string;
  title: string;
  credits: readonly string[];
  installed: boolean;
}>;

/** Search the catalogs this project added, from the cache, offline. */
export async function search(
  ctx: Context,
  words: readonly string[],
  kind?: string,
) {
  const lock = await readLock(ctx.project);
  const hits: SearchHit[] = [];
  const missing: string[] = [];
  const terms = words.map((w) => w.toLowerCase());
  for (const source of lock.sources) {
    const bytes = await ctx.cache.read(
      source.catalog.sha256,
      TRANSFER_LIMITS.catalogBytes,
    );
    if (!bytes) {
      missing.push(source.name);
      continue;
    }
    for (const e of catalogOf(bytes).entries) {
      if (kind !== undefined && e.kind !== kind) continue;
      const hay = [e.id, e.kind, e.title, e.description ?? "", ...e.credits]
        .join(" ")
        .toLowerCase();
      if (terms.every((t) => hay.includes(t)))
        hits.push({
          name: source.name,
          id: e.id,
          kind: e.kind,
          title: e.title,
          credits: e.credits,
          installed: source.entries.some((l) => l.id === e.id),
        });
    }
  }
  return {
    ok: true as const,
    collections: lock.sources.length,
    hits,
    uncached: missing,
  };
}

/** Budgets for qualifying an installed song before it is rendered. */
export const QUALIFY_LIMITS = Object.freeze({
  evalMs: 10_000,
  /** Arranged length of the song. */
  seconds: 20 * 60,
  /** Arranged seconds times tracks: what a full render costs. */
  trackSeconds: 64 * 5 * 60,
});

/**
 * Evaluate installed songs in the sealed song engine and check what the
 * remaining limits of that boundary leave open: the installed files are the
 * locked bytes, every file the score names is one of the entry's own locked
 * files, and the song's render cost is within budget.
 */
export async function qualify(
  ctx: Context,
  name: string | undefined,
  ids: readonly string[],
  limits: Readonly<{ evalMs: number; seconds: number; trackSeconds: number }>,
) {
  const evaluate = ctx.deps.hooks?.evaluateSong;
  if (!evaluate)
    throw new Error("qualify evaluates songs and needs the full dawn command");
  return withProjectLock(ctx.project, async () => {
    const lock = await readLock(ctx.project);
    const sources = lock.sources.filter(
      (s) => name === undefined || s.name === name,
    );
    if (name !== undefined && !sources.length)
      throw new Error(`no collection ${name} in this project`);
    const results: {
      name: string;
      id: string;
      ok: boolean;
      problems: string[];
      seconds?: number;
      tracks?: number;
    }[] = [];
    const next = new Map<string, LockedSource>();
    for (const source of sources) {
      const entries: LockedEntry[] = [];
      for (const entry of source.entries) {
        if (
          (ids.length && !ids.includes(entry.id)) ||
          (!ids.length && entry.kind !== "song")
        ) {
          entries.push(entry);
          continue;
        }
        const problems: string[] = [];
        const { qualified: _old, ...base } = entry;
        for (const f of entry.files) {
          const state = await diskState(join(ctx.project, entry.dir, f.path));
          if (state !== f.sha256)
            problems.push(
              `${entry.dir}/${f.path} ${state === "missing" ? "is missing; run dawn-collection install" : "differs from the locked file"}`,
            );
        }
        if (!entry.files.some((f) => f.path === "song.ts"))
          problems.push(`${entry.id} has no song.ts`);
        let result: SongEvaluation | undefined;
        if (!problems.length) {
          result = await evaluate(join(ctx.project, entry.dir), limits.evalMs);
          if (!result.ok) problems.push(result.problem);
          else {
            const own = new Set(entry.files.map((f) => f.path));
            for (const n of result.names)
              if (!own.has(n))
                problems.push(
                  `the score names ${n}, which is not one of the entry's locked files`,
                );
            if (result.seconds > limits.seconds)
              problems.push(
                `plays ${Math.round(result.seconds)} s, over the ${limits.seconds} s budget`,
              );
            if (result.seconds * result.tracks > limits.trackSeconds)
              problems.push(
                `${result.tracks} tracks for ${Math.round(result.seconds)} s cost ${Math.round(result.seconds * result.tracks)} track-seconds, over the ${limits.trackSeconds} budget`,
              );
          }
        }
        const ok = !problems.length && result?.ok === true;
        entries.push(
          ok && result?.ok
            ? {
                ...base,
                qualified: {
                  files: sha256Hex(
                    entry.files.map((f) => `${f.path}\0${f.sha256}\n`).join(""),
                  ),
                  scoreSha256: result.scoreSha256,
                  seconds: Math.round(result.seconds * 1000) / 1000,
                  tracks: result.tracks,
                  notes: result.notes,
                  assets: [...result.names].sort(),
                },
              }
            : base,
        );
        results.push({
          name: source.name,
          id: entry.id,
          ok,
          problems,
          ...(result?.ok
            ? { seconds: result.seconds, tracks: result.tracks }
            : {}),
        });
      }
      next.set(source.name, { ...source, entries });
    }
    await writeLock(ctx.project, {
      ...lock,
      sources: lock.sources.map((s) => next.get(s.name) ?? s),
    });
    return {
      ok: results.every((r) => r.ok),
      action: "qualify" as const,
      entries: results,
    };
  });
}
