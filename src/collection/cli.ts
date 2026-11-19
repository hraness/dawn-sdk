// SPDX-License-Identifier: MIT
/**
 * `dawn collection`: author, check and build catalogs, and install selected
 * entries pinned by commit and digest. Checking, building and installing
 * never evaluate content; `qualify` evaluates installed songs only in the
 * sealed song engine, and only in the full dawn command.
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { COLLECTION_KINDS, parseCollection } from "../../core/collection.ts";
import { syncDirectory } from "../fs/durable.ts";
import { addEntry, buildCatalog, checkCatalog } from "./author.ts";
import {
  context,
  install,
  qualify,
  QUALIFY_LIMITS,
  remove,
  search,
  update,
  type CollectionDeps,
} from "./install.ts";
import { jsonText, publishNew, reasonOf, type Output } from "./local.ts";
import { ghToken } from "./net.ts";
import {
  contributionGuide,
  TEMPLATES,
  workflowTemplate,
  type Template,
} from "./templates.ts";

export { COLLECTION_HASH_BUDGET, COLLECTION_MAX_BYTES } from "./author.ts";
export const COLLECTION_USAGE = `usage: dawn-collection check <catalog.json> [--root <dir>] [--json]
       dawn-collection init <new-dir> --id <slug> --title <text>
         --curator <name> [--template pack|artist|community] [--ci] [--json]
       dawn-collection add <catalog.json> <manifest-or-folder> [--id <slug>]
         [--kind <kind>] [--title <text>] [--credit <name>]...
         [--license <content|software|samples|trace>=<label>]... [--root <dir>]
         [--apply] [--json]
       dawn-collection build <catalog.json> --out <new-dir> [--root <dir>]
         [--site] [--url <catalog-url>] [--no-traces] [--json]
       dawn-collection install [<catalog-url-path-or-name> [entry...]]
         [--as <name>] [--ref <ref>] [--path <catalog-path>] [--root <dir>]
         [--project <dir>] [--offline] [--auth gh] [--max-bytes <n>]
         [--timeout <seconds>] [--json]
       dawn-collection update [name [entry...]] [--dry-run] [--project <dir>]
         [--auth gh] [--max-bytes <n>] [--timeout <seconds>] [--json]
       dawn-collection remove <name> [entry...] [--delete-files]
         [--project <dir>] [--json]
       dawn-collection search [words...] [--kind <kind>] [--project <dir>] [--json]
       dawn-collection qualify [name [entry...]] [--timeout-ms <n>]
         [--max-seconds <n>] [--project <dir>] [--json]`;

type Spec = Readonly<{
  min: number;
  max: number;
  values: readonly string[];
  repeat?: readonly string[];
  flags?: readonly string[];
}>;
const NET = ["project", "auth", "max-bytes", "timeout"];
const SPECS: Readonly<Record<string, Spec>> = {
  check: { min: 1, max: 1, values: ["root"] },
  init: {
    min: 1,
    max: 1,
    values: ["id", "title", "curator", "template"],
    flags: ["ci"],
  },
  add: {
    min: 2,
    max: 2,
    values: ["root", "id", "kind", "title"],
    repeat: ["credit", "license"],
    flags: ["apply"],
  },
  build: {
    min: 1,
    max: 1,
    values: ["root", "out", "url"],
    flags: ["site", "no-traces"],
  },
  install: {
    min: 0,
    max: 513,
    values: [...NET, "as", "ref", "path", "root"],
    flags: ["offline"],
  },
  update: { min: 0, max: 513, values: NET, flags: ["dry-run"] },
  remove: { min: 1, max: 513, values: ["project"], flags: ["delete-files"] },
  search: { min: 0, max: 32, values: ["project", "kind"] },
  qualify: {
    min: 0,
    max: 513,
    values: ["project", "timeout-ms", "max-seconds"],
  },
};

function argumentsFor(argv: readonly string[]) {
  const command = argv[1] ?? "";
  const spec = SPECS[command];
  if (!spec) throw new Error(COLLECTION_USAGE);
  const options = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  let json = false;
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      if (json) throw new Error("duplicate --json");
      json = true;
    } else if (arg.startsWith("-")) {
      const key = arg.slice(2);
      if (!arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
      if (spec.flags?.includes(key)) {
        if (flags.has(key)) throw new Error(`duplicate ${arg}`);
        flags.add(key);
        continue;
      }
      const many = spec.repeat?.includes(key);
      if (!many && !spec.values.includes(key))
        throw new Error(`unknown option ${arg}`);
      if (!many && options.has(key)) throw new Error(`duplicate ${arg}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith("-") || !value.trim())
        throw new Error(`${arg} needs a value`);
      if (many) repeated.set(key, [...(repeated.get(key) ?? []), value]);
      else options.set(key, value);
    } else positional.push(arg);
  }
  if (positional.length < spec.min || positional.length > spec.max)
    throw new Error(COLLECTION_USAGE);
  return { command, positional, options, repeated, flags, json };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
function wholeNumber(
  value: string | undefined,
  label: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max)
    throw new Error(`${label} takes a whole number from 1 to ${max}`);
  return Number(value);
}
/** The SDK release a generated workflow pins: this package's own version. */
function sdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && /^\d+\.\d+\.\d+$/.test(pkg.version))
      return pkg.version;
  } catch {
    // Fall through to the placeholder.
  }
  return "VERSION";
}

async function runInit(args: ReturnType<typeof argumentsFor>, cwd: string) {
  const template = args.options.get("template") ?? "community";
  if (!TEMPLATES.includes(template as Template))
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
  const directory = resolve(cwd, args.positional[0]!);
  await mkdir(directory, { mode: 0o700 });
  // The final catalog is the completion marker. Retain a failed reservation.
  await publishNew(
    join(directory, "CONTRIBUTING.md"),
    contributionGuide(template as Template),
  );
  if (args.flags.has("ci")) {
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    await publishNew(
      join(directory, ".github/workflows/collection.yml"),
      workflowTemplate(sdkVersion()),
    );
  }
  const catalogPath = join(directory, "dawn.collection.json");
  await publishNew(catalogPath, jsonText(catalog));
  await syncDirectory(dirname(directory));
  return { catalog, template, directory, catalogPath };
}

export async function runCollectionCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
  _signal?: AbortSignal,
  deps: CollectionDeps = {},
): Promise<number> {
  if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
    stdout.write(`${COLLECTION_USAGE}\n`);
    return 0;
  }
  try {
    const args = argumentsFor(argv);
    const out = (value: unknown, text: string) =>
      stdout.write(args.json ? `${JSON.stringify(value)}\n` : `${text}\n`);
    const p = args.positional;
    const root = args.options.get("root");
    const rootPath = root === undefined ? undefined : resolve(cwd, root);
    switch (args.command) {
      case "check": {
        const r = await checkCatalog(resolve(cwd, p[0]!), rootPath);
        out(
          r,
          `collection ${r.collection} · ${plural(r.entries, "entry", "entries")} · ${r.localFiles} local ${r.localFiles === 1 ? "file" : "files"} · ${plural(r.verifiedHashes, "hash", "hashes")} verified · ${r.remoteUnchecked} remote ${r.remoteUnchecked === 1 ? "entry" : "entries"} unchecked`,
        );
        return 0;
      }
      case "init": {
        const r = await runInit(args, cwd);
        out(
          {
            ok: true,
            collection: r.catalog.id,
            template: r.template,
            directory: r.directory,
            catalog: r.catalogPath,
          },
          `created collection ${r.catalog.id} · ${r.catalogPath}`,
        );
        return 0;
      }
      case "add": {
        const licenses: Record<string, string> = {};
        for (const pair of args.repeated.get("license") ?? []) {
          const m = /^(content|software|samples|trace)=(.+)$/.exec(pair);
          if (!m)
            throw new Error(
              "--license takes content=, software=, samples= or trace=<label>",
            );
          if (licenses[m[1]!] !== undefined)
            throw new Error(`--license ${m[1]} given twice`);
          licenses[m[1]!] = m[2]!;
        }
        const r = await addEntry(resolve(cwd, p[0]!), resolve(cwd, p[1]!), {
          ...(rootPath ? { root: rootPath } : {}),
          ...(args.options.has("id") ? { id: args.options.get("id")! } : {}),
          ...(args.options.has("kind")
            ? { kind: args.options.get("kind")! }
            : {}),
          ...(args.options.has("title")
            ? { title: args.options.get("title")! }
            : {}),
          credits: args.repeated.get("credit") ?? [],
          licenses,
          apply: args.flags.has("apply"),
        });
        const files =
          "files" in r.entry && r.entry.files ? r.entry.files.length : 1;
        out(
          r,
          `${JSON.stringify(r.entry, null, 2)}\n${r.applied ? "added" : "proposed"} ${r.entry.kind} ${r.entry.id} · ${plural(files, "file")}${r.skipped.length ? ` · ${r.skipped.length} left out: ${r.skipped.slice(0, 3).join("; ")}` : ""}${r.missing.length ? ` · needs ${r.missing.join(" and ")}` : r.applied ? "" : " · run again with --apply to add it"}`,
        );
        return 0;
      }
      case "build": {
        const target = args.options.get("out");
        if (!target) throw new Error("--out <new-dir> is required");
        const r = await buildCatalog(
          resolve(cwd, p[0]!),
          resolve(cwd, target),
          {
            ...(rootPath ? { root: rootPath } : {}),
            site: args.flags.has("site"),
            ...(args.options.has("url")
              ? { url: args.options.get("url")! }
              : {}),
            traces: !args.flags.has("no-traces"),
          },
          deps.hooks,
        );
        out(
          r,
          `built ${r.collection} · ${plural(r.entries, "entry", "entries")} · ${plural(r.files, "file")}, ${r.bytes} bytes · ${r.remote} remote · ${plural(r.traces, "trace export")}${r.traceSkipped.length ? ` (${r.traceSkipped.length} left out: ${r.traceSkipped[0]!.reason})` : ""}${r.site ? " · index.html" : ""} · ${r.out}`,
        );
        return 0;
      }
      case "search": {
        const kind = args.options.get("kind");
        if (
          kind !== undefined &&
          !(COLLECTION_KINDS as readonly string[]).includes(kind)
        )
          throw new Error(`--kind takes ${COLLECTION_KINDS.join(", ")}`);
        const ctx = await context(
          resolve(cwd, args.options.get("project") ?? "."),
          deps,
          {
            offline: true,
          },
        );
        const r = await search(ctx, p, kind);
        out(
          r,
          r.collections === 0
            ? "no collections in this project; add one with dawn-collection install <url>"
            : [
                ...r.hits.map(
                  (h) =>
                    `${h.name}/${h.id} · ${h.kind} · ${h.title} · ${h.credits.join(", ")}${h.installed ? " · installed" : ""}`,
                ),
                `${plural(r.hits.length, "match", "matches")} in ${plural(r.collections, "collection")}${r.uncached.length ? ` · not cached: ${r.uncached.join(", ")} (run dawn-collection update)` : ""}`,
              ].join("\n"),
        );
        return 0;
      }
    }
    const project = resolve(cwd, args.options.get("project") ?? ".");
    const auth = args.options.get("auth");
    if (auth !== undefined && auth !== "gh") throw new Error("--auth takes gh");
    const timeout = wholeNumber(
      args.options.get("timeout"),
      "--timeout",
      24 * 3600,
    );
    const maxBytes = wholeNumber(
      args.options.get("max-bytes"),
      "--max-bytes",
      1024 ** 4,
    );
    const token = auth ? await (deps.token ?? ghToken)() : undefined;
    const ctx = await context(project, deps, {
      offline: args.flags.has("offline"),
      ...(token ? { token } : {}),
      ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
      ...(maxBytes ? { maxBytes } : {}),
    });
    if (args.command === "install") {
      const r = await install(ctx, cwd, p[0], p.slice(1), {
        ...(args.options.has("as") ? { as: args.options.get("as")! } : {}),
        ...(args.options.has("ref") ? { ref: args.options.get("ref")! } : {}),
        ...(args.options.has("path")
          ? { path: args.options.get("path")! }
          : {}),
        ...(rootPath ? { root: rootPath } : {}),
      });
      if (r.action === "restore") {
        const edited = r.entries.flatMap((e) => e.edited);
        out(
          r,
          `restored ${plural(r.entries.length, "entry", "entries")} · ${plural(
            r.entries.reduce((n, e) => n + e.written, 0),
            "file",
          )} written${edited.length ? ` · ${plural(edited.length, "edited file")} kept as they are: ${edited.slice(0, 3).join(", ")}` : ""}`,
        );
        return 0;
      }
      out(
        r,
        [
          `${r.name} · ${r.source}${r.commit ? ` · commit ${r.commit.slice(0, 12)}` : ""} · catalog ${r.catalog.slice(0, 12)}`,
          ...r.installed.map(
            (e) =>
              `installed ${e.id} (${e.kind}) · ${plural(e.files, "file")}, ${e.bytes} bytes · ${e.dir}${e.evaluation ? " · not evaluated; run dawn-collection qualify before rendering it" : ""}`,
          ),
          ...(r.installed.length
            ? []
            : [
                `added ${r.name}; install an entry with dawn-collection install ${r.name} <entry>:`,
                ...r.available.map((e) => `  ${e.id} · ${e.kind} · ${e.title}`),
              ]),
          ...(r.hosts.length ? [`contacted ${r.hosts.join(", ")}`] : []),
        ].join("\n"),
      );
      return 0;
    }
    if (args.command === "update") {
      const r = await update(ctx, p[0], p.slice(1), args.flags.has("dry-run"));
      const lines = [
        ...r.sources.map(
          (s) =>
            `${s.name}${s.from || s.to ? ` · ${s.from?.slice(0, 12) ?? "?"} → ${s.to?.slice(0, 12) ?? "?"}` : ""}${s.catalog.from === s.catalog.to ? " · catalog unchanged" : " · catalog changed"}${s.newEntries.length ? ` · new entries: ${s.newEntries.join(", ")}` : ""}`,
        ),
        ...r.entries.map(
          (e) =>
            `  ${e.action.padEnd(16)} ${e.name}/${e.id}${e.added.length + e.changed.length + e.removed.length ? ` · +${e.added.length} ~${e.changed.length} -${e.removed.length}` : ""}${e.edited.length ? ` · edited: ${e.edited.slice(0, 3).join(", ")}` : ""}${e.reason ? ` · ${e.reason}` : ""}`,
        ),
        r.dryRun
          ? "dry run: nothing in the project changed"
          : `applied ${plural(r.entries.filter((e) => e.action === "update").length, "update")}`,
      ];
      out(r, lines.join("\n"));
      return !r.dryRun &&
        r.entries.some((e) => e.action === "conflict" || e.action === "error")
        ? 1
        : 0;
    }
    if (args.command === "remove") {
      const r = await remove(
        ctx,
        p[0]!,
        p.slice(1),
        args.flags.has("delete-files"),
      );
      out(
        r,
        `removed ${r.removed.join(", ") || "nothing"} from the lock${r.subscription === "removed" ? ` and ${r.name} from this project's collections` : ""}${args.flags.has("delete-files") ? ` · ${plural(r.deleted, "file")} deleted${r.kept.length ? ` · kept ${plural(r.kept.length, "edited file")}` : ""}` : ` · files kept in ${r.kept.join(", ") || "nothing"}`}`,
      );
      return 0;
    }
    const r = await qualify(ctx, p[0], p.slice(1), {
      evalMs:
        wholeNumber(args.options.get("timeout-ms"), "--timeout-ms", 60_000) ??
        QUALIFY_LIMITS.evalMs,
      seconds:
        wholeNumber(
          args.options.get("max-seconds"),
          "--max-seconds",
          4 * 3600,
        ) ?? QUALIFY_LIMITS.seconds,
      trackSeconds: QUALIFY_LIMITS.trackSeconds,
    });
    out(
      r,
      r.entries.length
        ? r.entries
            .map((e) =>
              e.ok
                ? `qualified ${e.name}/${e.id} · ${Math.round(e.seconds!)} s · ${plural(e.tracks!, "track")}`
                : `not qualified ${e.name}/${e.id} · ${e.problems.slice(0, 3).join("; ")}`,
            )
            .join("\n")
        : "no installed songs to qualify",
    );
    return r.ok ? 0 : 1;
  } catch (error) {
    stderr.write(
      `collection: ${reasonOf(error, "could not complete the collection command")}\n`,
    );
    return 2;
  }
}
