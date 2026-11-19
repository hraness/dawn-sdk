// SPDX-License-Identifier: MIT
/**
 * Typechecks a project with the TypeScript compiler DAWN depends on.
 *
 * TypeScript 7 is a native binary with no JavaScript watch API, so each check
 * is one `tsc --noEmit --incremental` run whose build info lives in
 * `.dawn/tsbuild/`; a warm check on a small project takes tens of
 * milliseconds. Diagnostics come back as `file:line:col message`.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../../core/sdk/eval.ts";
import type { CommandRunner } from "../process/runner.ts";
import { systemRunner } from "../process/runner.ts";
import { fetchedTsc, fetchesTsc, fetchTsc } from "./typescript-tool.ts";

export const TYPECHECK_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTICS = 200;

export type TypecheckResult = Readonly<{
  ok: boolean;
  diagnostics: readonly Diagnostic[];
  ms: number;
  /** Why types were not checked, when the app's dawn could not fetch its compiler. */
  skipped?: string;
}>;

export type TypecheckOptions = Readonly<{
  runner?: CommandRunner;
  /** Path of the `tsc` executable; resolved from the dependency by default. */
  tsc?: string;
  /** Whether this dawn fetches its compiler on first use (the app's does). */
  fetches?: boolean;
  /** Fetches the compiler; `fetchTsc` by default. */
  fetchTsc?: () => Promise<string>;
  /** Finds an installed compiler; `resolveTsc` by default. */
  resolve?: typeof resolveTsc;
}>;

/**
 * Native `tsc` from `@typescript/typescript-<platform>-<arch>`; else, for the
 * app's dawn, the pinned compiler it fetched (never another `tsc` on PATH);
 * else `tsc` on PATH.
 */
export function resolveTsc(
  runner: CommandRunner = systemRunner,
  fetches: boolean = fetchesTsc(),
): string | undefined {
  const name = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
  try {
    const url = import.meta.resolve(name);
    const tsc = join(dirname(fileURLToPath(url)), "lib", "tsc");
    if (existsSync(tsc)) return tsc;
  } catch {
    // Not installed: the app leaves it out.
  }
  if (fetches) return fetchedTsc();
  return runner.which("tsc");
}

/** Runs `tsc` on `<project>/tsconfig.json` and parses its diagnostics. */
export async function typecheckProject(
  project: string,
  options: TypecheckOptions = {},
): Promise<TypecheckResult> {
  const started = performance.now();
  const runner = options.runner ?? systemRunner;
  const fetches = options.fetches ?? fetchesTsc();
  let tsc = options.tsc ?? (options.resolve ?? resolveTsc)(runner, fetches);
  if (!tsc && fetches) {
    try {
      tsc = await (options.fetchTsc ?? fetchTsc)();
    } catch (error) {
      // Offline, the project still evaluates and renders; only types wait.
      const why = error instanceof Error ? error.message : String(error);
      return {
        ok: true,
        diagnostics: [],
        ms: elapsed(started),
        skipped: `types were not checked: the TypeScript compiler is fetched on first use and could not be (${why}); connect to the internet and check again`,
      };
    }
  }
  if (!tsc)
    return {
      ok: false,
      diagnostics: [{ message: "typescript is not installed (no tsc found)" }],
      ms: elapsed(started),
    };
  const stateDir = join(project, ".dawn", "tsbuild");
  await mkdir(stateDir, { recursive: true });
  const result = await runner.run(
    tsc,
    [
      "--noEmit",
      "--pretty",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      join(stateDir, "project.tsbuildinfo"),
      "-p",
      join(project, "tsconfig.json"),
    ],
    {
      timeoutMs: TYPECHECK_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
      env: { NO_COLOR: "1" },
    },
  );
  if (result.killed)
    return {
      ok: false,
      diagnostics: [{ message: "typecheck timed out" }],
      ms: elapsed(started),
    };
  const diagnostics = parseTscOutput(
    `${result.stdout}\n${result.stderr}`,
    project,
  );
  if (result.code !== 0 && diagnostics.length === 0)
    diagnostics.push({
      message: `tsc exited with code ${result.code}${
        result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""
      }`,
    });
  return {
    ok: result.code === 0 && diagnostics.length === 0,
    diagnostics,
    ms: elapsed(started),
  };
}

/**
 * Parses `file(line,col): error TSnnnn: message` lines. tsc prints paths
 * relative to its working directory; they come back project-relative.
 */
export function parseTscOutput(
  output: string,
  project: string,
  cwd: string = process.cwd(),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const roots = [project];
  try {
    roots.push(realpathSync(project));
  } catch {
    // An unreadable project keeps the literal path.
  }
  const relativize = (file: string): string => {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    for (const root of roots) {
      const rel = relative(root, absolute);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return file;
  };
  let elaborated = -1;
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    // tsc indents the elaboration of the previous error ("Type 'Removed<…>'
    // has no call signatures."); the first one is kept, it often says why.
    const last = out[out.length - 1];
    if (/^\s+\S/.test(line) && last?.file !== undefined) {
      if (elaborated === out.length - 1) continue;
      elaborated = out.length - 1;
      const code = / \((TS\d+)\)$/.exec(last.message);
      const detail = line.trim().slice(0, 300);
      if (code)
        out[out.length - 1] = {
          ...last,
          message: `${last.message.slice(0, -code[0].length)} · ${detail}${code[0]}`,
        };
      continue;
    }
    const match = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (match) {
      const file = relativize(match[1]!);
      out.push({
        file,
        line: Number(match[2]),
        col: Number(match[3]),
        message: `${match[5]} (${match[4]})`,
      });
    } else {
      const bare = line.match(/^error (TS\d+): (.*)$/);
      if (bare) out.push({ message: `${bare[2]} (${bare[1]})` });
    }
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
