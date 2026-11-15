/** Local collection authoring; checking never downloads or evaluates content. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseCollection, type Collection } from "../../core/collection.ts";
import { syncDirectory } from "../fs/durable.ts";

type Output = { write(text: string): unknown };
export const COLLECTION_MAX_BYTES = 8 * 1024 * 1024;
export const COLLECTION_HASH_BUDGET = 64 * 1024 * 1024;
export const COLLECTION_USAGE = `usage: dawn-collection check <catalog.json> [--root <dir>] [--json]
       dawn-collection init <new-dir> --id <slug> --title <text>
         --curator <name> [--template pack|artist|community] [--json]`;
const templates = ["pack", "artist", "community"] as const;
type Template = (typeof templates)[number];
const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  )
    throw new Error("referenced file is outside the collection root");
}

/** Check canonical paths and the opened descriptor before reading any content. */
async function openInside(root: string, path: string) {
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
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readCatalog(root: string, path: string): Promise<Collection> {
  const { handle, before } = await openInside(root, path);
  try {
    if (before.size > COLLECTION_MAX_BYTES)
      throw new Error("catalog exceeds 8 MiB");
    const bytes = Buffer.alloc(COLLECTION_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > COLLECTION_MAX_BYTES) throw new Error("catalog exceeds 8 MiB");
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("catalog changed while reading it");
    return parseCollection(JSON.parse(bytes.toString("utf8", 0, length)));
  } finally {
    await handle.close();
  }
}

async function checkCatalog(path: string, requestedRoot?: string) {
  const root = await realpath(requestedRoot ?? dirname(path));
  if (!(await stat(root)).isDirectory())
    throw new Error("collection root must be a directory");
  const catalogPath = await realpath(path);
  contained(root, catalogPath);
  const catalog = await readCatalog(root, catalogPath);
  let localFiles = 0,
    verifiedHashes = 0,
    remoteUnchecked = 0,
    budget = COLLECTION_HASH_BUDGET;
  for (const entry of catalog.entries) {
    if (entry.source.type !== "local") {
      remoteUnchecked++;
      continue;
    }
    const { handle, before } = await openInside(
      root,
      resolve(dirname(catalogPath), entry.source.path),
    );
    try {
      localFiles++;
      if (entry.source.sha256 === undefined) continue;
      if (before.size !== entry.source.bytes)
        throw new Error(
          `${entry.id}: declared byte size does not match local file`,
        );
      if (before.size > budget)
        throw new Error("local hash checks exceed 64 MiB total");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let length = 0;
      while (true) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, budget + 1),
          null,
        );
        if (!bytesRead) break;
        if (bytesRead > budget)
          throw new Error("local hash checks exceed 64 MiB total");
        budget -= bytesRead;
        length += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
        if (length > before.size)
          throw new Error(`${entry.id}: file changed while hashing it`);
      }
      const after = await handle.stat();
      if (
        length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error(`${entry.id}: file changed while hashing it`);
      if (hash.digest("hex") !== entry.source.sha256)
        throw new Error(`${entry.id}: SHA-256 does not match local file`);
      verifiedHashes++;
    } finally {
      await handle.close();
    }
  }
  return {
    ok: true,
    collection: catalog.id,
    version: catalog.version,
    entries: catalog.entries.length,
    localFiles,
    verifiedHashes,
    remoteUnchecked,
  };
}

function contributionGuide(template: Template): string {
  const examples = {
    pack: {
      id: "my-palette",
      kind: "palette",
      title: "My palette",
      credits: ["Replace with the creator"],
      licenses: { content: "Replace with the applicable license" },
      source: { type: "local", path: "packs/my-palette.json" },
    },
    artist: {
      id: "my-song",
      kind: "song",
      title: "My song",
      credits: ["Replace with the composer"],
      licenses: {
        content: "Replace with the composition license",
        software: "Replace with the source license",
      },
      source: { type: "local", path: "projects/my-song/song.ts" },
    },
    community: {
      id: "shared-library",
      kind: "collection",
      title: "Shared library",
      credits: ["Replace with the upstream curator"],
      licenses: { content: "Replace with the catalog license" },
      source: {
        type: "github",
        owner: "OWNER",
        repo: "REPOSITORY",
        ref: "main",
        path: "dawn.collection.json",
      },
    },
  };
  return `# Contribute to this collection

Edit dawn.collection.json to add entries with stable IDs, creator credits, applicable licenses and source descriptors. The catalog starts empty. The ${template} template suggests a starting layout; files may live in other folders.

This example is a shape to adapt, not an existing work or a license grant. Replace its placeholders and create or locate the referenced content before adding it to the entries array:

\`\`\`json
${JSON.stringify(examples[template], null, 2)}
\`\`\`

Local paths are relative to the catalog. For nested catalogs that reference sibling folders, pass the repository root explicitly with --root. Keep those files inside that root. A community reference links to an upstream collection without copying its content or claiming its authorship.

From this directory, run:

\`\`\`sh
dawn-collection check dawn.collection.json --json
\`\`\`

The check validates catalog metadata and local file references. When sha256 and bytes are both supplied on a local source, it also verifies those bytes, within a 64 MiB total hashing budget. It does not validate content formats, inspect all project assets, fetch remote references, expand linked collections or execute source. Remote entries are reported as unchecked. A successful check is not permission to run contributed TypeScript.

Review the diff and include the check result with your contribution. Preserve upstream credits and choose licenses you have authority to grant. Software, music, samples and traces may have different permissions. Keep credentials, private recordings and unreviewed agent transcripts out of public contributions. Opening a pull request or publishing remains your explicit action.
`;
}

async function publishNew(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
}

function argumentsFor(argv: readonly string[]) {
  const command = argv[1];
  if (command !== "check" && command !== "init")
    throw new Error(COLLECTION_USAGE);
  const allowed =
    command === "check" ? ["root"] : ["id", "title", "curator", "template"];
  const options = new Map<string, string>();
  let json = false;
  let path: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      if (json) throw new Error("duplicate --json");
      json = true;
    } else if (arg.startsWith("-")) {
      const key = arg.slice(2);
      if (!arg.startsWith("--") || !allowed.includes(key))
        throw new Error(`unknown option ${arg}`);
      if (options.has(key)) throw new Error(`duplicate ${arg}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith("-") || !value.trim())
        throw new Error(`${arg} needs a value`);
      options.set(key, value);
    } else {
      if (path !== undefined) throw new Error("expected one path");
      path = arg;
    }
  }
  if (!path) throw new Error(COLLECTION_USAGE);
  return { command, path, options, json };
}

export async function runCollectionCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
    stdout.write(`${COLLECTION_USAGE}\n`);
    return 0;
  }
  try {
    const args = argumentsFor(argv);
    if (args.command === "check") {
      const root = args.options.get("root");
      const result = await checkCatalog(
        resolve(cwd, args.path),
        root === undefined ? undefined : resolve(cwd, root),
      );
      stdout.write(
        args.json
          ? `${JSON.stringify(result)}\n`
          : `collection ${result.collection} · ${result.entries} ${result.entries === 1 ? "entry" : "entries"} · ${result.localFiles} local ${result.localFiles === 1 ? "file" : "files"} · ${result.verifiedHashes} ${result.verifiedHashes === 1 ? "hash" : "hashes"} verified · ${result.remoteUnchecked} remote ${result.remoteUnchecked === 1 ? "entry" : "entries"} unchecked\n`,
      );
    } else {
      const template = args.options.get("template") ?? "community";
      if (!templates.includes(template as Template))
        throw new Error("--template takes pack, artist or community");
      for (const name of ["id", "title", "curator"])
        if (!args.options.has(name)) throw new Error(`--${name} is required`);
      const catalog = parseCollection({
        schema: "dawn.collection/v1",
        id: args.options.get("id"),
        version: "1.0.0",
        title: args.options.get("title"),
        curator: args.options.get("curator"),
        entries: [],
      });
      const directory = resolve(cwd, args.path);
      await mkdir(directory, { mode: 0o700 });
      // The final catalog is the completion marker. Retain a failed reservation.
      await publishNew(
        join(directory, "CONTRIBUTING.md"),
        contributionGuide(template as Template),
      );
      const catalogPath = join(directory, "dawn.collection.json");
      await publishNew(catalogPath, jsonText(catalog));
      await syncDirectory(dirname(directory));
      stdout.write(
        args.json
          ? `${JSON.stringify({ ok: true, collection: catalog.id, template, directory, catalog: catalogPath })}\n`
          : `created collection ${catalog.id} · ${catalogPath}\n`,
      );
    }
    return 0;
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "output already exists; choose a new directory"
        : error instanceof Error
          ? error.message
          : "could not check or create collection";
    stderr.write(
      `collection: ${reason.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, " ")}\n`,
    );
    return 2;
  }
}
