// SPDX-License-Identifier: MIT
/**
 * Loads what `dawn lint` lints: a project (evaluated `song.ts`) or a score
 * JSON file, with its lint config (`lint.json` in the project, or a
 * `<name>.lint.json` sidecar next to a score) and the vocal books the config
 * names. Track ids map back to the `file:line` that declares them.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { evaluateProject, formatDiagnostic } from "../../core/sdk/eval.ts";
import {
  isLintArchetype,
  readBooks,
  type LintConfig,
  type LintFinding,
  type VocalBooks,
} from "../../core/lint/index.ts";
import { isProject } from "../project/init.ts";

export class LintInputError extends Error {}

/** The project's lint config file. */
export const LINT_CONFIG_FILE = "lint.json";

export type LintTarget = Readonly<{
  id: string;
  /** The project directory, or the score file's directory. */
  dir: string;
  kind: "project" | "score";
  score: unknown;
  config: LintConfig;
  books: VocalBooks;
  /** Track id → where it is declared (projects). */
  declared: ReadonlyMap<string, Readonly<{ file: string; line: number }>>;
  /** Config and book files read (for messages). */
  files: readonly string[];
}>;

const MAX_JSON_BYTES = 64 * 1024 * 1024;

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new LintInputError(`no such file · ${path}`);
  if (info.size > MAX_JSON_BYTES)
    throw new LintInputError(`too large · ${path}`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new LintInputError(
      `not JSON · ${path} · ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a lint config's shape (the fields lint reads). */
export function parseLintConfig(value: unknown, where: string): LintConfig {
  if (!isRecord(value))
    throw new LintInputError(`${where}: a lint config is a JSON object`);
  const bad = (field: string, want: string) =>
    new LintInputError(`${where}: ${field} must be ${want}`);
  if (
    value.archetype !== undefined &&
    !(typeof value.archetype === "string" && isLintArchetype(value.archetype))
  )
    throw bad("archetype", "banger, ballad, anthem, lullaby or interlude");
  for (const field of [
    "allow",
    "books",
    "lead",
    "tricks",
    "keys",
    "harmony",
  ] as const)
    if (value[field] !== undefined && !Array.isArray(value[field]))
      throw bad(field, "an array");
  for (const field of ["style", "classes"] as const)
    if (value[field] !== undefined && !isRecord(value[field]))
      throw bad(field, "an object");
  if (value.runs !== undefined && typeof value.runs !== "string")
    throw bad("runs", "a regex source string");
  for (const [i, a] of ((value.allow as unknown[]) ?? []).entries())
    if (!isRecord(a) || typeof a.reason !== "string" || !a.reason.trim())
      throw bad(`allow[${i}]`, "an object with a reason");
  for (const [i, t] of ((value.tricks as unknown[]) ?? []).entries())
    if (!isRecord(t) || typeof t.id !== "string")
      throw bad(`tricks[${i}]`, "an object with an id");
  for (const field of ["books", "lead"] as const)
    for (const x of (value[field] as unknown[]) ?? [])
      if (typeof x !== "string") throw bad(field, "a list of strings");
  return value as LintConfig;
}

/**
 * Reads the books a config names, relative to `dir`. A `dawn.book/v1` file
 * holds several books; any other file is one book, named after the file
 * (its id is what a sampler voice's `src` basename refers to).
 */
export async function readConfigBooks(
  dir: string,
  config: LintConfig,
): Promise<{ books: VocalBooks; files: string[] }> {
  const books: Record<string, VocalBooks[string]> = {};
  const files: string[] = [];
  for (const rel of config.books ?? []) {
    const path = resolve(dir, rel);
    const value = await readJson(path);
    files.push(path);
    const id = basename(path).replace(/\.book\.json$|\.json$/, "");
    const wrapped =
      isRecord(value) &&
      (value.schema === "dawn.book/v1" || !("parts" in value))
        ? value
        : { [id]: value };
    try {
      Object.assign(books, readBooks(wrapped));
    } catch (error) {
      throw new LintInputError(
        `${rel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { books, files };
}

/** `id: "<track>"` declarations in song.ts and tracks/**.ts. */
async function declaredTracks(
  project: string,
): Promise<Map<string, { file: string; line: number }>> {
  const out = new Map<string, { file: string; line: number }>();
  const files = [join(project, "song.ts")];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  await walk(join(project, "tracks"), 0);
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined || text.length > 4 * 1024 * 1024) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++)
      for (const m of lines[i]!.matchAll(/\bid:\s*["'`]([^"'`$]+)["'`]/g))
        if (!out.has(m[1]!))
          out.set(m[1]!, { file: relative(project, file), line: i + 1 });
  }
  return out;
}

/**
 * Resolves `target` (a project directory, its `song.ts`, or a score
 * `.json`) relative to `cwd`.
 */
export async function loadLintTarget(
  target: string,
  cwd: string,
): Promise<LintTarget> {
  const path = resolve(cwd, target);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new LintInputError(`no such file or directory · ${target}`);
  if (info.isFile() && extname(path) === ".json") {
    const score = await readJson(path);
    const base = path.slice(0, -".json".length);
    const sidecar = `${base}.lint.json`;
    const hasSidecar =
      (await stat(sidecar).catch(() => undefined))?.isFile() ?? false;
    const config = hasSidecar
      ? parseLintConfig(await readJson(sidecar), basename(sidecar))
      : {};
    const dir = dirname(path);
    const { books, files } = await readConfigBooks(dir, config);
    return {
      id: basename(base),
      dir,
      kind: "score",
      score,
      config,
      books,
      declared: new Map(),
      files: hasSidecar ? [sidecar, ...files] : files,
    };
  }
  const project = info.isDirectory() ? path : dirname(path);
  if (info.isFile() && extname(path) !== ".ts")
    throw new LintInputError(
      `lint takes a project, its song.ts or a score .json · ${target}`,
    );
  if (!(await isProject(project)))
    throw new LintInputError(
      `not a dawn project (no dawn.json) · ${relative(cwd, project) || "."}`,
    );
  const evaluated = await evaluateProject(project);
  if (!evaluated.ok)
    throw new LintInputError(
      `song.ts does not evaluate; run dawn check\n${evaluated.diagnostics.map(formatDiagnostic).join("\n")}`,
    );
  return lintTargetFromScore(project, evaluated.score);
}

/** A project target from an already evaluated score (`dawn check --lint`). */
export async function lintTargetFromScore(
  project: string,
  score: unknown,
): Promise<LintTarget> {
  const configPath = join(project, LINT_CONFIG_FILE);
  const hasConfig =
    (await stat(configPath).catch(() => undefined))?.isFile() ?? false;
  const config = hasConfig
    ? parseLintConfig(await readJson(configPath), LINT_CONFIG_FILE)
    : {};
  const { books, files } = await readConfigBooks(project, config);
  return {
    id: basename(project),
    dir: project,
    kind: "project",
    score: JSON.parse(JSON.stringify(score)),
    config,
    books,
    declared: await declaredTracks(project),
    files: hasConfig ? [configPath, ...files] : files,
  };
}

/** True when the project has a lint config. */
export async function hasLintConfig(project: string): Promise<boolean> {
  return (
    (
      await stat(join(project, LINT_CONFIG_FILE)).catch(() => undefined)
    )?.isFile() ?? false
  );
}

/** Adds `file:line` to findings whose track the project declares. */
export function locate(
  findings: readonly LintFinding[],
  target: LintTarget,
): LintFinding[] {
  return findings.map((f) => {
    const d =
      f.where.track !== undefined
        ? target.declared.get(f.where.track)
        : undefined;
    return d ? { ...f, where: { ...f.where, file: d.file, line: d.line } } : f;
  });
}

/**
 * The album: every project directory and score `.json` in `dir` (sidecars
 * and book files skipped).
 */
export async function loadAlbum(
  dir: string,
  cwd: string,
): Promise<LintTarget[]> {
  const root = resolve(cwd, dir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => {
    throw new LintInputError(`no such directory · ${dir}`);
  });
  const out: LintTarget[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await isProject(path)) out.push(await loadLintTarget(path, cwd));
    } else if (
      entry.name.endsWith(".json") &&
      !entry.name.endsWith(".lint.json")
    ) {
      const value = await readJson(path);
      if (
        isRecord(value) &&
        Array.isArray(value.notes) &&
        Array.isArray(value.tracks)
      )
        out.push(await loadLintTarget(path, cwd));
    }
  }
  return out;
}
