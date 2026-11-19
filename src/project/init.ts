// SPDX-License-Identifier: MIT
/**
 * Project layout on disk:
 *
 *   dawn.json              project marker: format, SDK major, the dawn
 *                          range it needs (`dawn`), applied `migrations`
 *                          and `trace` settings (src/trace/settings.ts)
 *   tsconfig.json          strict, `"dawn"` → `.dawn/sdk/v1.ts`
 *   song.ts                `export default song({ ..., tracks: [...] })`
 *   tracks/<slug>/track.ts one `track({...})` per track (+ `samples/`)
 *   .dawn/sdk/v1.ts        vendored SDK, refreshed when the shipped copy is newer
 *   .dawn/sdk/tsconfig.json compiler options the root config extends
 *   .dawn/tsbuild/         incremental typecheck state
 *   AGENTS.md, CLAUDE.md   notes for coding agents (only when absent)
 *
 * `initProject` is idempotent, writes only under `dir`, and reports each
 * file it created or refreshed exactly once.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCORE_VERSION } from "../../core/score-versions.ts";
import { parseSimpleArgv } from "../argv.ts";
import { durableWrite } from "../fs/durable.ts";
import { minorFloor } from "../update/semver.ts";
import { VERSION } from "../version.ts";
import { CLAUDE_MD, renderAgentsMd } from "./agents-md.ts";
import {
  NEW_PROJECT_TRACE,
  traceSettingsOf,
  type TraceSettings,
} from "../trace/settings.ts";

export const PROJECT_FILE = "dawn.json";
export const PROJECT_FORMAT = "dawn.project/v1";
/** The project marker before the rename to DAWN, recognized only to say so. */
const LEGACY_PROJECT_FILE = "dawg.json";
export const SDK_RELATIVE_PATH = ".dawn/sdk/v1.ts";
export const SDK_TSCONFIG_RELATIVE_PATH = ".dawn/sdk/tsconfig.json";

/** The SDK source DAWN ships (`core/sdk/v1.ts`). */
export const SHIPPED_SDK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "core",
  "sdk",
  "v1.ts",
);

export type ProjectManifest = Readonly<{
  format: string;
  sdk: number;
  /** `">=0.39.0"` (a minimum) or `"0.39.2"` (a pin); absent before 0.39. */
  dawn?: string;
  /** `dawn migrate` steps already applied. */
  migrations?: readonly string[];
  /** The score version the source is written for; absent in projects made before the field (version 1). */
  score?: number;
  /** Trace capture, text and indexing consent; absent when `dawn.json` has no `trace` object. */
  trace?: TraceSettings;
}>;

/**
 * The largest `dawn.json` read. A manifest can carry a lint config and trace
 * settings, so this is generous; past it the folder is not read as a project,
 * and `dawn init` refuses rather than replace the file.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024;

export type InitResult = Readonly<{
  /** Project-relative paths created or refreshed, in write order. */
  wrote: readonly string[];
  /** SDK version now vendored in the project. */
  sdkVersion: string;
}>;

export const SDK_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: [],
    },
  },
  null,
  2,
)}\n`;

const ROOT_TSCONFIG = `${JSON.stringify(
  {
    extends: "./.dawn/sdk/tsconfig.json",
    compilerOptions: { paths: { dawn: ["./.dawn/sdk/v1.ts"] } },
    include: ["song.ts", "tracks/**/*.ts", ".dawn/sdk/*.ts"],
  },
  null,
  2,
)}\n`;

const EMPTY_SONG = `import { song } from "dawn";

export default song({
  tempo: 120,
  meter: [4, 4],
  bars: 4,
  tracks: [],
  calibration: 1,
});
`;

const GITIGNORE_LINES = [".dawn/*", "!.dawn/sdk/"];

/** True when `dir` holds a `dawn.json`. */
export async function isProject(dir: string): Promise<boolean> {
  return (await readManifest(dir)) !== undefined;
}

/** What a folder from before the rename to DAWN needs. */
export const LEGACY_PROJECT_PROBLEM =
  "this is a dawg project from before the rename to DAWN · run dawn migrate to see the changes, then dawn migrate --apply";

/** One line for a folder that still has a `dawg.json`, or undefined. */
export async function legacyProjectHint(
  dir: string,
): Promise<string | undefined> {
  if (await isProject(dir)) return undefined;
  if ((await readOptional(join(dir, LEGACY_PROJECT_FILE))) === undefined)
    return undefined;
  return LEGACY_PROJECT_PROBLEM;
}

/** Parses `dawn.json` from unknown; undefined when absent or unreadable. */
export async function readManifest(
  dir: string,
): Promise<ProjectManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, PROJECT_FILE), "utf8");
  } catch {
    return undefined;
  }
  if (text.length > MAX_MANIFEST_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.format !== PROJECT_FORMAT) return undefined;
    if (typeof record.sdk !== "number" || !Number.isInteger(record.sdk))
      return undefined;
    const migrations = Array.isArray(record.migrations)
      ? Object.freeze(
          record.migrations.filter(
            (id): id is string => typeof id === "string",
          ),
        )
      : undefined;
    const trace = traceSettingsOf(record);
    return Object.freeze({
      format: PROJECT_FORMAT,
      sdk: record.sdk,
      ...(typeof record.dawn === "string" ? { dawn: record.dawn } : {}),
      ...(migrations ? { migrations } : {}),
      ...(typeof record.score === "number" ? { score: record.score } : {}),
      ...(trace ? { trace } : {}),
    });
  } catch {
    return undefined;
  }
}

/** Version string declared by an SDK source file, or undefined. */
export function sdkVersionOf(source: string): string | undefined {
  const match = source.match(/SDK_VERSION = "(\d+)\.(\d+)\.(\d+)"/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function newer(candidate: string, current: string | undefined): boolean {
  if (current === undefined) return true;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  if (a[0] !== b[0]) return false; // a different major is never auto-applied
  for (let index = 1; index < 3; index += 1)
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  return false;
}

export type InitOptions = Readonly<{
  /** SDK source to vendor; defaults to the shipped `core/sdk/v1.ts`. */
  sdkSource?: string;
  /** Write AGENTS.md (and CLAUDE.md) when absent; default true. */
  agentDocs?: boolean;
  /**
   * A new `dawn.json` turns automatic trace capture on, text included;
   * default true. An existing manifest is never changed by init.
   */
  trace?: boolean;
}>;

/**
 * Creates or refreshes the project in `dir`. Existing `song.ts`,
 * `tsconfig.json`, `.gitignore` entries and `dawn.json` are left alone;
 * the vendored SDK is replaced only by a newer copy of the same major.
 */
export async function initProject(
  dir: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const wrote: string[] = [];
  const sdkSource =
    options.sdkSource ?? (await readFile(SHIPPED_SDK_PATH, "utf8"));
  const shippedVersion = sdkVersionOf(sdkSource);
  if (!shippedVersion) throw new Error("shipped SDK has no SDK_VERSION");
  const major = Number(shippedVersion.split(".")[0]);
  const existingManifest = await readOptional(join(dir, PROJECT_FILE));
  if (existingManifest !== undefined && (await readManifest(dir)) === undefined)
    // Replacing it would lose its settings (trace, lint, migrations).
    throw new Error(
      `${PROJECT_FILE} exists but is not a dawn project manifest (format ${PROJECT_FORMAT}, an integer sdk, at most ${MAX_MANIFEST_BYTES} bytes); fix it or move it away; nothing was written`,
    );

  await mkdir(join(dir, ".dawn", "sdk"), { recursive: true });
  await mkdir(join(dir, "tracks"), { recursive: true });

  const vendored = await readOptional(join(dir, SDK_RELATIVE_PATH));
  const vendoredVersion =
    vendored === undefined ? undefined : sdkVersionOf(vendored);
  let sdkVersion = vendoredVersion ?? shippedVersion;
  if (vendored === undefined || newer(shippedVersion, vendoredVersion)) {
    await writeAtomic(join(dir, SDK_RELATIVE_PATH), sdkSource);
    wrote.push(SDK_RELATIVE_PATH);
    sdkVersion = shippedVersion;
  }
  if (
    (await readOptional(join(dir, SDK_TSCONFIG_RELATIVE_PATH))) !== SDK_TSCONFIG
  ) {
    await writeAtomic(join(dir, SDK_TSCONFIG_RELATIVE_PATH), SDK_TSCONFIG);
    wrote.push(SDK_TSCONFIG_RELATIVE_PATH);
  }
  if (existingManifest === undefined) {
    await writeAtomic(
      join(dir, PROJECT_FILE),
      `${JSON.stringify(
        {
          format: PROJECT_FORMAT,
          sdk: major,
          dawn: minorFloor(VERSION),
          migrations: [],
          score: SCORE_VERSION,
          ...(options.trace === false ? {} : { trace: NEW_PROJECT_TRACE }),
        },
        null,
        2,
      )}\n`,
    );
    wrote.push(PROJECT_FILE);
  }
  if ((await readOptional(join(dir, "tsconfig.json"))) === undefined) {
    await writeAtomic(join(dir, "tsconfig.json"), ROOT_TSCONFIG);
    wrote.push("tsconfig.json");
  }
  if ((await readOptional(join(dir, "song.ts"))) === undefined) {
    await writeAtomic(join(dir, "song.ts"), EMPTY_SONG);
    wrote.push("song.ts");
  }
  if (options.agentDocs !== false) {
    const agents = await readOptional(join(dir, "AGENTS.md"));
    const claude = await readOptional(join(dir, "CLAUDE.md"));
    if (agents === undefined) {
      await writeAtomic(
        join(dir, "AGENTS.md"),
        renderAgentsMd({ sdk: shippedVersion, dawn: VERSION }),
      );
      wrote.push("AGENTS.md");
      if (claude === undefined) {
        await writeAtomic(join(dir, "CLAUDE.md"), CLAUDE_MD);
        wrote.push("CLAUDE.md");
      }
    }
  }
  const gitignore = (await readOptional(join(dir, ".gitignore"))) ?? "";
  const present = new Set(gitignore.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length > 0) {
    const prefix =
      gitignore.length === 0 || gitignore.endsWith("\n") ? "" : "\n";
    await writeAtomic(
      join(dir, ".gitignore"),
      `${gitignore}${prefix}${missing.join("\n")}\n`,
    );
    wrote.push(".gitignore");
  }
  return Object.freeze({ wrote: Object.freeze(wrote), sdkVersion });
}

/** Said once, where tracing is first turned on (docs/traces.md). */
export const TRACE_ON_NOTICE =
  "trace: on · dawn commands record prompts, notes, feedback and changes in trace/ · trace/ is committed, so a git push publishes that text · dawn trace disable . turns it off; dawn trace enable . --no-text keeps metadata only";

export const INIT_USAGE =
  "usage: dawn init [dir] · writes song.ts, dawn.json, tsconfig.json, .dawn/sdk and AGENTS.md (existing files are kept)";

/** `dawn init [dir]`: creates the project and prints what it wrote. */
export async function runInitCommand(
  argv: readonly string[],
  cwd: string,
  stdout: { write(text: string): unknown },
  stderr: { write(text: string): unknown },
): Promise<number> {
  const parsed = parseSimpleArgv(argv.slice(1), 1);
  if (parsed.kind === "help") {
    stdout.write(`${INIT_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    stderr.write(`${parsed.problem} · ${INIT_USAGE}\n`);
    return 2;
  }
  const dir = parsed.positionals[0];
  const target = dir ? resolve(cwd, dir) : cwd;
  const legacy = await legacyProjectHint(target);
  if (legacy !== undefined) {
    stderr.write(`init failed: ${legacy}\n`);
    return 1;
  }
  try {
    const result = await initProject(target);
    if (result.wrote.length === 0)
      stdout.write(`project up to date (sdk ${result.sdkVersion})\n`);
    else for (const path of result.wrote) stdout.write(`wrote ${path}\n`);
    if (result.wrote.includes(PROJECT_FILE))
      stderr.write(`${TRACE_ON_NOTICE}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `init failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Temp file + fsync + rename + directory fsync, so a reader never sees a
 * partial file and a crash never loses a finished write.
 */
export async function writeAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await durableWrite(path, contents);
}
