// SPDX-License-Identifier: MIT
/**
 * `dawn check`: typecheck the project, evaluate `song.ts`, print every
 * diagnostic as `file:line:col message`, exit 1 on any failure.
 */

import {
  evaluateProject,
  formatDiagnostic,
  type Diagnostic,
} from "../../core/sdk/eval.ts";
import {
  legacyResonatorWarnings,
  modalPairWarnings,
} from "../../core/resonators.ts";
import { checkLinter, trackWarnings } from "./check-hooks.ts";
import { clipPinDiagnostics } from "./clip-pins.ts";
import { isProject, legacyProjectHint } from "./init.ts";
import { parseFlagArgv } from "../argv.ts";
import {
  applyFixIts,
  type CheckDiagnostic,
  enrichDiagnostics,
  runSuggesters,
} from "./fixits.ts";
import { syncProject, type SyncResult } from "./sync.ts";
import { typecheckProject } from "./typecheck.ts";

export type CheckDeps = Readonly<{
  typecheck?: typeof typecheckProject;
  evaluate?: typeof evaluateProject;
  /** Project sync before the check; `false` skips it (tests). */
  sync?: typeof syncProject | false;
  /**
   * Run `dawn lint` on the evaluated score: true always, false never, and
   * by default only when the project has a `lint.json`. Lint findings are
   * warnings in `dawn check`; they never fail it. The rules are not part of
   * the check: they come from the linter registered in check-hooks.ts, and
   * a caller that registered none is told so when lint is asked for.
   */
  lint?: boolean;
}>;

export type CheckReport = Readonly<{
  ok: boolean;
  diagnostics: readonly CheckDiagnostic[];
  typesMs: number;
  evalMs: number;
  tracks: number;
  notes: number;
  /** The evaluated score, for `--suggest` detectors. */
  score?: unknown;
  /** Advice that does not fail the check (0.6: legacy instrument words). */
  warnings: readonly string[];
}>;

/** Runs both checks on `project`; never throws for project problems. */
export async function checkProject(
  project: string,
  deps: CheckDeps = {},
): Promise<CheckReport> {
  const [types, evaluated] = await Promise.all([
    (deps.typecheck ?? typecheckProject)(project),
    (deps.evaluate ?? evaluateProject)(project),
  ]);
  // 0.7: a clip or take whose file no longer matches its pinned sha256
  // fails like a type error.
  const pins = evaluated.ok
    ? await clipPinDiagnostics(project, evaluated.score)
    : [];
  const lint = evaluated.ok
    ? await lintWarnings(project, evaluated.score, deps.lint)
    : [];
  const diagnostics = [
    ...enrichDiagnostics(types.diagnostics),
    ...(evaluated.ok ? [] : evaluated.diagnostics),
    ...pins,
  ];
  return Object.freeze({
    ok: types.ok && evaluated.ok && pins.length === 0,
    diagnostics: Object.freeze(diagnostics),
    typesMs: types.ms,
    evalMs: evaluated.ms,
    score: evaluated.ok ? evaluated.score : undefined,
    tracks: evaluated.ok ? evaluated.score.tracks.length : 0,
    notes: evaluated.ok ? evaluated.score.notes.length : 0,
    warnings: Object.freeze(
      evaluated.ok
        ? [
            ...(types.skipped ? [types.skipped] : []),
            ...legacyResonatorWarnings(evaluated.score.tracks),
            ...modalPairWarnings(evaluated.score.tracks),
            ...trackWarnings(evaluated.score.tracks),
            ...lint,
          ]
        : [],
    ),
  });
}

/**
 * `dawn lint` findings (errors and warnings) as check warnings, from the
 * registered linter; a lint config problem is one warning too.
 */
async function lintWarnings(
  project: string,
  score: unknown,
  wanted: boolean | undefined,
): Promise<readonly string[]> {
  if (wanted === false) return [];
  const linter = checkLinter();
  if (!linter)
    return wanted ? ["lint skipped · this dawn has no lint rules"] : [];
  try {
    if (!(wanted ?? (await linter.configured(project)))) return [];
    return await linter.warnings(project, score);
  } catch (error) {
    return [
      `lint skipped · ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    ];
  }
}

/** A `trace` value in dawn.json that is read as something other than written. */
async function traceProblems(project: string): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { traceSettingProblems } = await import("../trace/settings.ts");
    return traceSettingProblems(
      JSON.parse(await readFile(join(project, "dawn.json"), "utf8")),
    );
  } catch {
    return [];
  }
}

export const CHECK_USAGE =
  "usage: dawn check [--fix] [--suggest] [--lint|--no-lint] [--json] · sync the project, typecheck and evaluate it; exit 1 on problems, 3 when it needs dawn migrate or a newer dawn (--lint adds dawn lint findings as warnings; on by default with a lint.json)";

export async function runCheckCommand(
  argv: readonly string[],
  cwd: string,
  stdout: { write(text: string): unknown },
  stderr: { write(text: string): unknown },
  deps: CheckDeps = {},
): Promise<number> {
  const parsed = parseFlagArgv(
    argv.slice(1),
    ["--fix", "--suggest", "--json", "--lint", "--no-lint"],
    0,
  );
  if (parsed.kind === "help") {
    stdout.write(`${CHECK_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    stderr.write(`${parsed.problem} · ${CHECK_USAGE}\n`);
    return 2;
  }
  const json = parsed.flags.has("--json");
  const lintFlag = parsed.flags.has("--lint")
    ? true
    : parsed.flags.has("--no-lint")
      ? false
      : undefined;
  if (lintFlag !== undefined) deps = { ...deps, lint: lintFlag };
  const project = cwd;
  const emit = (value: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify({ schema: "dawn.check/v1", ...value })}\n`);
  let sync: SyncResult | undefined;
  if (deps.sync !== false) {
    sync = await (deps.sync ?? syncProject)(project);
    if (sync.status !== "ok") {
      const problem =
        sync.status === "not-a-project" &&
        sync.problem?.startsWith("not a dawn project")
          ? "not a dawn project (no dawn.json here); run `dawn init` first"
          : `${sync.problem} · ${sync.fix}`;
      if (json)
        emit({
          ok: false,
          status: sync.status,
          problem: sync.problem,
          fix: sync.fix,
        });
      else stderr.write(`${problem}\n`);
      return sync.status === "needs-migrate" || sync.status === "needs-dawn"
        ? 3
        : 1;
    }
    if (!json) {
      for (const notice of sync.notices) stderr.write(`sync: ${notice}\n`);
      for (const hint of sync.hints) stderr.write(`hint: ${hint}\n`);
      for (const problem of await traceProblems(project))
        stderr.write(`warning: ${problem}\n`);
    }
  } else if (!(await isProject(project))) {
    const problem =
      (await legacyProjectHint(project)) ??
      "not a dawn project (no dawn.json here); run `dawn init` first";
    stderr.write(`${problem}\n`);
    return 1;
  }
  let report = await checkProject(project, deps);
  let fixed: string[] = [];
  if (parsed.flags.has("--fix")) {
    const fixes = report.diagnostics.flatMap((d) => (d.fix ? [d.fix] : []));
    fixed = await applyFixIts(project, fixes);
    if (fixed.length > 0) {
      if (!json) for (const file of fixed) stderr.write(`fixed ${file}\n`);
      report = await checkProject(project, deps);
    } else if (!json) stderr.write("fix: nothing safe to apply\n");
  }
  const suggestions =
    parsed.flags.has("--suggest") && report.score !== undefined
      ? runSuggesters(report.score)
      : [];
  if (json) {
    const { score: _score, ...rest } = report;
    emit({
      ...rest,
      sync: sync
        ? {
            notices: sync.notices,
            hints: sync.hints,
            wrote: sync.wrote,
            score: sync.score,
          }
        : undefined,
      fixed,
      suggestions,
    });
    return report.ok ? 0 : 1;
  }
  for (const diagnostic of report.diagnostics)
    stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  for (const warning of report.warnings) stderr.write(`warning: ${warning}\n`);
  if (parsed.flags.has("--suggest"))
    if (suggestions.length === 0)
      stderr.write("suggest: no hints for this song\n");
    else for (const line of suggestions) stderr.write(`${line}\n`);
  if (report.ok) {
    stdout.write(
      `ok · ${report.tracks} track${report.tracks === 1 ? "" : "s"}, ${report.notes} note${
        report.notes === 1 ? "" : "s"
      } · types ${report.typesMs} ms · eval ${report.evalMs} ms${
        sync?.score
          ? ` · score version ${sync.score.version}${sync.score.steps.length > 0 ? ` of ${sync.score.current}` : ""}`
          : ""
      }\n`,
    );
    return 0;
  }
  const count = report.diagnostics.length;
  stderr.write(`${count} problem${count === 1 ? "" : "s"}\n`);
  return 1;
}
