// SPDX-License-Identifier: MIT
/** Bounded collection catalogs. Parsing metadata never reads or executes its sources. */
export const COLLECTION_SCHEMA = "dawn.collection/v1";
export const COLLECTION_LIMITS = Object.freeze({
  maxEntries: 512,
  maxId: 64,
  maxText: 200,
  maxString: 4096,
  maxPath: 512,
  maxCredits: 32,
  maxDepth: 16,
  maxValues: 100_000,
  maxArtifactBytes: 1024 ** 4,
  maxFiles: 2048,
});
export const COLLECTION_KINDS = [
  "palette",
  "patch-pack",
  "sample-pack",
  "loop",
  "song",
  "album",
  "composer",
  "collection",
] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];
type Integrity = Readonly<{ sha256?: string; bytes?: number }>;
export type CollectionSource = Integrity &
  (
    | Readonly<{ type: "local"; path: string; entry?: string }>
    | Readonly<{
        type: "github";
        owner: string;
        repo: string;
        ref: string;
        path: string;
        entry?: string;
      }>
    | Readonly<{ type: "https"; url: string; entry?: string }>
  );
export type CollectionLicenses = Readonly<{
  content?: string;
  software?: string;
  samples?: string;
  trace?: string;
}>;
/** One declared file of a multi-file entry, relative to its source's folder. */
export type CollectionFile = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;
export type CollectionEntry = Readonly<{
  id: string;
  kind: CollectionKind;
  title: string;
  description?: string;
  credits: readonly string[];
  licenses: CollectionLicenses;
  source: CollectionSource;
  /**
   * Every file the entry consists of, relative to the folder holding
   * `source`, including the source file itself. Without it the entry is the
   * single source file.
   */
  files?: readonly CollectionFile[];
}>;
export type Collection = Readonly<{
  schema: typeof COLLECTION_SCHEMA;
  id: string;
  version: string;
  title: string;
  curator: string;
  description?: string;
  entries: readonly CollectionEntry[];
}>;
export class CollectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionValidationError";
  }
}
function fail(message: string): never {
  throw new CollectionValidationError(message);
}

/** Inspect descriptors, not property values: getters and toJSON are never invoked. */
function copyJson(value: unknown): unknown {
  let count = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (
      ++count > COLLECTION_LIMITS.maxValues ||
      depth > COLLECTION_LIMITS.maxDepth
    )
      fail("collection exceeds its data size or nesting limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > COLLECTION_LIMITS.maxString)
        fail("collection string is too long");
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("collection numbers must be finite");
      return v;
    }
    if (typeof v !== "object") fail("collection must contain only JSON data");
    const obj = v as object;
    const array = Array.isArray(obj);
    const prototype = Object.getPrototypeOf(obj);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      fail("collection objects must be plain JSON objects");
    if (ancestors.has(obj)) fail("collection must not contain cycles");
    ancestors.add(obj);
    const keys = Reflect.ownKeys(obj);
    if (keys.length > COLLECTION_LIMITS.maxValues - count)
      fail("collection has too many fields");
    const length = array ? (obj as unknown[]).length : 0;
    if (length > COLLECTION_LIMITS.maxValues)
      fail("collection array is too long");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        fail("collection contains a forbidden key");
      if (array && !/^(0|[1-9][0-9]*)$/.test(key))
        fail("collection arrays must contain only indexed values");
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!descriptor.enumerable || !("value" in descriptor))
        fail("collection fields must be enumerable data");
      out[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(obj);
    if (!array) return out;
    if (Object.keys(out).length !== length)
      fail("collection arrays must not be sparse");
    return Array.from({ length }, (_, i) => out[String(i)]);
  }
  return visit(value, 0);
}
function record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r))
    if (!fields.includes(key)) fail(`${label} has no field "${key}"`);
  return r;
}
function text(
  value: unknown,
  label: string,
  max: number = COLLECTION_LIMITS.maxText,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(`${label} must be 1..${max} characters without control characters`);
  return value as string;
}
function id(value: unknown, label: string): string {
  const s = text(value, label, COLLECTION_LIMITS.maxId);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(s))
    fail(`${label} must be a lowercase slug`);
  return s;
}
function sourcePath(value: unknown, label: string, local: boolean): string {
  const path = text(value, label, COLLECTION_LIMITS.maxPath);
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    /[\\:]/.test(path) ||
    parts.some((p) => !p) ||
    [".", ".."].includes(parts.at(-1)!) ||
    (!local && parts.some((p) => p === "." || p === ".."))
  )
    fail(`${label} must be a relative file path with forward slashes`);
  return path;
}
function githubName(value: unknown, label: string, repo: boolean): string {
  const s = text(value, label, 100);
  if (
    !(
      repo ? /^[A-Za-z0-9_.-]+$/ : /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
    ).test(s) ||
    [".", ".."].includes(s)
  )
    fail(`${label} is not a GitHub ${repo ? "repository" : "owner"} name`);
  return s;
}
function gitRef(value: unknown, label: string): string {
  const s = text(value, label, 200);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) ||
    s.includes("..") ||
    s
      .split("/")
      .some(
        (p) =>
          !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"),
      )
  )
    fail(
      `${label} must be a branch, tag or commit without ambiguous path segments`,
    );
  return s;
}
function digest(
  r: Record<string, unknown>,
  label: string,
): { sha256: string; bytes: number } {
  if (typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256))
    fail(`${label} sha256 must be 64 lowercase hexadecimal characters`);
  if (
    typeof r.bytes !== "number" ||
    !Number.isSafeInteger(r.bytes) ||
    r.bytes < 0 ||
    r.bytes > COLLECTION_LIMITS.maxArtifactBytes
  )
    fail(
      `${label} bytes must be a whole number from 0 to ${COLLECTION_LIMITS.maxArtifactBytes}`,
    );
  return { sha256: r.sha256 as string, bytes: r.bytes as number };
}
/** The last path segment of a source: the file named inside its folder. */
export function sourceFileName(source: CollectionSource): string {
  const path =
    source.type === "https" ? new URL(source.url).pathname : source.path;
  return decodeURIComponent(path.split("/").at(-1)!);
}
function parseFiles(
  value: unknown,
  source: CollectionSource,
  label: string,
): readonly CollectionFile[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > COLLECTION_LIMITS.maxFiles
  )
    fail(`${label} must list 1..${COLLECTION_LIMITS.maxFiles} files`);
  const seen = new Set<string>();
  const files = (value as unknown[]).map((raw, i) => {
    const r = record(raw, ["path", "sha256", "bytes"], `${label} ${i + 1}`);
    const path = sourcePath(r.path, `${label} ${i + 1} path`, false);
    // Case-insensitive file systems would merge two such names into one.
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) fail(`${label} repeat the path "${path}"`);
    seen.add(key);
    return Object.freeze({ path, ...digest(r, `${label} ${i + 1}`) });
  });
  const own = files.find((f) => f.path === sourceFileName(source));
  if (!own) fail(`${label} must include the source file itself`);
  if (
    source.sha256 !== undefined &&
    (source.sha256 !== own.sha256 || source.bytes !== own.bytes)
  )
    fail(`${label} and the source disagree about the source file's digest`);
  return Object.freeze(
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
function parseSource(value: unknown, label: string): CollectionSource {
  const first = record(
    value,
    ["type", "path", "owner", "repo", "ref", "url", "entry", "sha256", "bytes"],
    label,
  );
  const common = ["type", "sha256", "bytes"];
  const fields =
    first.type === "local"
      ? [...common, "path", "entry"]
      : first.type === "github"
        ? [...common, "owner", "repo", "ref", "path", "entry"]
        : first.type === "https"
          ? [...common, "url", "entry"]
          : fail(`${label} has an unknown type`);
  const r = record(first, fields, label);
  const integrity: { sha256?: string; bytes?: number } = {};
  if ((r.sha256 === undefined) !== (r.bytes === undefined))
    fail(`${label} sha256 and bytes must be supplied together`);
  if (r.sha256 !== undefined) Object.assign(integrity, digest(r, label));
  const selector =
    r.entry === undefined ? {} : { entry: id(r.entry, `${label} entry`) };
  if (r.type === "local")
    return Object.freeze({
      type: "local",
      path: sourcePath(r.path, `${label} path`, true),
      ...selector,
      ...integrity,
    });
  if (r.type === "github")
    return Object.freeze({
      type: "github",
      owner: githubName(r.owner, `${label} owner`, false),
      repo: githubName(r.repo, `${label} repo`, true),
      ref: gitRef(r.ref, `${label} ref`),
      path: sourcePath(r.path, `${label} path`, false),
      ...selector,
      ...integrity,
    });
  const raw = text(r.url, `${label} url`, COLLECTION_LIMITS.maxString);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${label} url must be HTTPS`);
  }
  if (
    !/^https:\/\/[^/]/i.test(raw) ||
    raw
      .slice(raw.indexOf("//") + 2)
      .split("/")[0]!
      .includes("@") ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("\\") ||
    raw.trim() !== raw
  )
    fail(`${label} url must be HTTPS without credentials, query or fragment`);
  return Object.freeze({
    type: "https",
    url: url.href,
    ...selector,
    ...integrity,
  });
}

/** Validate one source descriptor on its own, as a catalog entry would. */
export function parseCollectionSource(
  value: unknown,
  label = "source",
): CollectionSource {
  return parseSource(copyJson(value), label);
}

/** Validate metadata only. Source existence, containment and identity need separate checks. */
export function parseCollection(value: unknown): Collection {
  const r = record(
    copyJson(value),
    ["schema", "id", "version", "title", "curator", "description", "entries"],
    "collection",
  );
  if (r.schema !== COLLECTION_SCHEMA)
    fail(`collection schema must be ${COLLECTION_SCHEMA}`);
  const version = text(r.version, "collection version", 100);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))
    fail("collection version must be major.minor.patch");
  if (
    !Array.isArray(r.entries) ||
    r.entries.length > COLLECTION_LIMITS.maxEntries
  )
    fail(
      `collection entries must contain 0..${COLLECTION_LIMITS.maxEntries} entries`,
    );
  const seen = new Set<string>();
  const entries = (r.entries as unknown[]).map((raw, i): CollectionEntry => {
    const label = `entry ${i + 1}`;
    const e = record(
      raw,
      [
        "id",
        "kind",
        "title",
        "description",
        "credits",
        "licenses",
        "source",
        "files",
      ],
      label,
    );
    const entryId = id(e.id, `${label} id`);
    if (seen.has(entryId)) fail(`duplicate entry id "${entryId}"`);
    seen.add(entryId);
    if (!(COLLECTION_KINDS as readonly unknown[]).includes(e.kind))
      fail(`${label} has an unknown kind`);
    if (
      !Array.isArray(e.credits) ||
      e.credits.length < 1 ||
      e.credits.length > COLLECTION_LIMITS.maxCredits
    )
      fail(
        `${label} credits must contain 1..${COLLECTION_LIMITS.maxCredits} names`,
      );
    const credits = (e.credits as unknown[]).map((c) =>
      text(c, `${label} credit`),
    );
    if (new Set(credits).size !== credits.length)
      fail(`${label} credits must not repeat`);
    const keys = ["content", "software", "samples", "trace"] as const;
    const licenses = record(e.licenses, keys, `${label} licenses`);
    if (!Object.keys(licenses).length)
      fail(`${label} licenses must declare at least one applicable license`);
    const licenseData: Record<string, string> = {};
    for (const key of keys)
      if (licenses[key] !== undefined)
        licenseData[key] = text(licenses[key], `${label} ${key} license`);
    const source = parseSource(e.source, `${label} source`);
    return Object.freeze({
      id: entryId,
      kind: e.kind as CollectionKind,
      title: text(e.title, `${label} title`),
      ...(e.description === undefined
        ? {}
        : {
            description: text(
              e.description,
              `${label} description`,
              COLLECTION_LIMITS.maxString,
            ),
          }),
      credits: Object.freeze(credits),
      licenses: Object.freeze(licenseData),
      source,
      ...(e.files === undefined
        ? {}
        : { files: parseFiles(e.files, source, `${label} files`) }),
    });
  });
  return Object.freeze({
    schema: COLLECTION_SCHEMA,
    id: id(r.id, "collection id"),
    version,
    title: text(r.title, "collection title"),
    curator: text(r.curator, "collection curator"),
    ...(r.description === undefined
      ? {}
      : {
          description: text(
            r.description,
            "collection description",
            COLLECTION_LIMITS.maxString,
          ),
        }),
    entries: Object.freeze(entries),
  });
}
