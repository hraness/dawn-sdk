// SPDX-License-Identifier: MIT
/**
 * `dawn migrate [dir] [--apply] [--undo] [--force] [--list] [--json]`.
 * Dry run by default: prints the diff and exits 3 when steps are pending.
 *
 * Two kinds of step share the command. Source steps (this folder's numbered
 * codemods) rewrite text and run first. Score steps (core/score-versions.ts)
 * upgrade the score's data and print it back; they run once no source step
 * is pending, because the project has to evaluate.
 */

import { resolve } from "node:path";
import {
  scoreSteps as stepsInForce,
  SCORE_VERSION,
  ScoreVersionError,
} from "../../core/score-versions.ts";
import { parseFlagArgv } from "../argv.ts";
import { type CommandRunner, systemRunner } from "../process/runner.ts";
import { defaultMigrationContext } from "./context.ts";
import { diskFiles } from "./files.ts";
import { HELD_MIGRATIONS, MIGRATIONS } from "./index.ts";
import { oldCommentsStanding } from "./0002-comments-jsonl.ts";
import {
  applyPlan,
  type MigrationPlan,
  planMigrations,
  planProject,
  renderPlan,
  touchedPaths,
  undoMigration,
} from "./run.ts";
import {
  formatScoreStep,
  planScoreUpgrade,
  projectScoreStanding,
  scoreStepLine,
  type ScoreStanding,
  type ScoreUpgradeDeps,
} from "./score.ts";
import type { MigrationContext } from "./types.ts";

export const MIGRATE_USAGE = `usage: dawn migrate [dir] [--apply | --undo | --list] [--only <id>] [--force] [--json]
  dawn migrate           show what would change (a diff); exit 3 when steps are pending
  dawn migrate --apply   apply with a backup in .dawn/migrate-backup/
  dawn migrate --undo    restore the newest backup
  dawn migrate --list    every migration this dawn knows, source steps then score steps
  --only <id>            plan or apply that one step alone, by its id; the way to run
                         a step that is held back (--list marks them)
  --force                apply even when git shows uncommitted changes to those files`;

type Out = { write(text: string): unknown };

async function dirtyFiles(
  root: string,
  paths: readonly string[],
  runner: CommandRunner,
): Promise<string[]> {
  if (paths.length === 0 || runner.which("git") === undefined) return [];
  const result = await runner.run(
    "git",
    ["-C", root, "status", "--porcelain", "--", ...paths],
    { timeoutMs: 10_000 },
  );
  if (result.code !== 0) return []; // not a git checkout
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
}

function planJson(root: string, plan: MigrationPlan) {
  return {
    pending: plan.pending,
    applied: plan.applied,
    ops: plan.ops.map((op) =>
      op.op === "rename"
        ? { op: op.op, from: op.from, to: op.to }
        : { op: op.op, path: op.path },
    ),
    project: root,
  };
}

export async function runMigrateCommand(
  argv: readonly string[],
  cwd: string,
  out: Out,
  err: Out,
  deps: Readonly<{
    runner?: CommandRunner;
    context?: MigrationContext;
    now?: Date;
    score?: ScoreUpgradeDeps;
  }> = {},
): Promise<number> {
  // --only takes a value; the rest are plain flags.
  const words = argv.slice(1);
  let only: string | undefined;
  const at = words.indexOf("--only");
  if (at >= 0) {
    only = words[at + 1];
    if (only === undefined || only.startsWith("-")) {
      err.write(`--only needs a migration id · ${MIGRATE_USAGE}\n`);
      return 2;
    }
    words.splice(at, 2);
  }
  const parsed = parseFlagArgv(
    words,
    ["--apply", "--undo", "--force", "--list", "--json"],
    1,
  );
  if (parsed.kind === "help") {
    out.write(`${MIGRATE_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    err.write(`${parsed.problem} · ${MIGRATE_USAGE}\n`);
    return 2;
  }
  const flags = parsed.flags;
  const json = flags.has("--json");
  const modes = ["--apply", "--undo", "--list"].filter((flag) =>
    flags.has(flag),
  );
  if (modes.length > 1) {
    err.write(`choose one of ${modes.join(", ")} · ${MIGRATE_USAGE}\n`);
    return 2;
  }
  const emit = (value: Record<string, unknown>) =>
    out.write(`${JSON.stringify({ schema: "dawn.migrate/v1", ...value })}\n`);
  const root = resolve(cwd, parsed.positionals[0] ?? ".");

  if (flags.has("--list")) {
    const list = MIGRATIONS.map(({ id, title, introducedIn }) => ({
      id,
      title,
      introducedIn,
    }));
    const held = HELD_MIGRATIONS.map(({ id, title, introducedIn }) => ({
      id,
      title,
      introducedIn,
    }));
    const scoreSteps = stepsInForce().map(scoreStepLine);
    if (json)
      emit({ migrations: list, held, scoreVersion: SCORE_VERSION, scoreSteps });
    else {
      for (const m of list)
        out.write(`${m.id}  (dawn ${m.introducedIn})  ${m.title}\n`);
      for (const m of held)
        out.write(
          `${m.id}  (held)  ${m.title} · runs only when named: dawn migrate --only ${m.id}\n`,
        );
      for (const step of scoreSteps) out.write(`${formatScoreStep(step)}\n`);
      out.write(
        `score version ${SCORE_VERSION}${scoreSteps.length === 0 ? " · the first, so no score steps yet" : ""}\n`,
      );
    }
    return 0;
  }
  try {
    if (flags.has("--undo")) {
      const undone = undoMigration(root);
      if (undone === undefined) {
        if (json) emit({ result: "nothing-to-undo", project: root });
        else
          err.write(
            `nothing to undo · no backup in ${root}/.dawn/migrate-backup\n`,
          );
        return 1;
      }
      if (json) emit({ result: "undone", project: root, ...undone });
      else
        out.write(
          `restored ${undone.backup} (${undone.migrations.join(", ") || "no steps"})\n`,
        );
      return 0;
    }
    const context = deps.context ?? (await defaultMigrationContext());
    const named =
      only === undefined
        ? undefined
        : [...MIGRATIONS, ...HELD_MIGRATIONS].find((m) => m.id === only);
    if (only !== undefined && named === undefined) {
      const problem = `no migration with the id ${only.slice(0, 60)} · dawn migrate --list names them`;
      if (json) emit({ result: "refused", code: "no_such_migration", problem });
      else err.write(`migrate refused: ${problem}\n`);
      return 2;
    }
    const source = named
      ? planMigrations(diskFiles(root), context, [named])
      : planProject(root, context);
    if (named && source.pending.length === 0) {
      // Say why a step that was asked for by name has nothing to do.
      const standing =
        named.id === "0002-comments-jsonl"
          ? oldCommentsStanding(diskFiles(root))
          : undefined;
      const why = source.applied.includes(named.id)
        ? "already applied here"
        : standing === "unreadable"
          ? "comments.json is not readable JSON with a comments list; it was left where it is"
          : standing === "other-schema"
            ? "comments.json is not dawn.comments/v1 (a newer schema, perhaps); it was left where it is"
            : standing === "none"
              ? "there is no comments.json here"
              : "nothing to change";
      if (json)
        emit({
          result: "current",
          only: named.id,
          reason: why,
          ...(standing ? { standing } : {}),
          ...planJson(root, source),
        });
      else out.write(`${named.id}: ${why}\n`);
      return standing === "unreadable" || standing === "other-schema" ? 1 : 0;
    }
    // Where the score stands. A project newer than this dawn stops here.
    let standing: ScoreStanding | undefined;
    try {
      if (!named) standing = projectScoreStanding(root);
    } catch (error) {
      if (!(error instanceof ScoreVersionError)) throw error;
      if (source.pending.length === 0)
        await planScoreUpgrade(root, context, deps.score); // throws the line
    }
    const scoreJson = standing
      ? {
          score: {
            version: standing.version,
            current: standing.current,
            steps: standing.steps,
          },
        }
      : {};
    const scoreLines = (standing?.steps ?? []).map(formatScoreStep);
    const scoreWaits = source.pending.length > 0 && scoreLines.length > 0;
    const plan =
      source.pending.length > 0 || named
        ? source
        : ((await planScoreUpgrade(root, context, deps.score)) ?? source);
    const ofScore = plan !== source;
    if (plan.pending.length === 0) {
      if (json)
        emit({ result: "current", ...planJson(root, plan), ...scoreJson });
      else
        out.write(
          `project is up to date (migrations: ${plan.applied.join(", ") || "none needed"}${standing ? ` · score version ${standing.version}` : ""})\n`,
        );
      return 0;
    }
    const then = scoreWaits
      ? ` · then the score: version ${standing!.version} → ${standing!.current}, run dawn migrate again`
      : "";
    if (!flags.has("--apply")) {
      if (json)
        emit({ result: "pending", ...planJson(root, plan), ...scoreJson });
      else {
        if (ofScore) {
          out.write(
            `score version ${standing!.version} → ${standing!.current} · song.ts and each track are printed again from the upgraded score; code of your own in them becomes plain notes\n`,
          );
          for (const line of scoreLines) out.write(`${line}\n`);
          out.write("\n");
        }
        out.write(renderPlan(plan));
        out.write(
          `\n${plan.pending.length} pending: ${plan.pending.map((m) => m.id).join(", ")} · dry run, nothing written · apply with dawn migrate --apply${then}\n`,
        );
      }
      return 3;
    }
    if (!flags.has("--force")) {
      const dirty = await dirtyFiles(
        root,
        touchedPaths(plan),
        deps.runner ?? systemRunner,
      );
      if (dirty.length > 0) {
        const problem = `uncommitted changes in ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? " …" : ""} · commit first, or pass --force (a backup is still written)`;
        if (json)
          emit({
            result: "refused",
            code: "dirty",
            problem,
            ...planJson(root, plan),
            ...scoreJson,
          });
        else err.write(`migrate refused: ${problem}\n`);
        return 1;
      }
    }
    const applied = await applyPlan(root, plan, deps.now);
    if (json)
      emit({
        result: "applied",
        backup: applied.backup,
        ...planJson(root, plan),
        ...scoreJson,
      });
    else
      out.write(
        `applied ${applied.applied.join(", ")} · ${plan.ops.length} changes · backup ${applied.backup} (dawn migrate --undo) · next: ${scoreWaits ? "dawn migrate, for the score" : "dawn check"}\n`,
      );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) emit({ result: "failed", problem: message, project: root });
    else err.write(`migrate failed: ${message}\n`);
    return 1;
  }
}
