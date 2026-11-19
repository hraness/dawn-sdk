// SPDX-License-Identifier: MIT
/**
 * The score-version half of `dawn migrate` (docs/design/score-versions.md).
 *
 * `dawn.json` records the score version a project's source is written for
 * (`score`; a project from before the field is version 1). When this dawn's
 * version is later, the project still checks and renders: its vendored SDK
 * writes the old score and the loader upgrades it in memory. `dawn migrate`
 * makes that permanent: it evaluates the project, lets the loader run the
 * steps, prints the upgraded score back as source, refreshes the vendored
 * SDK and records the new version.
 *
 * The source codemods in this folder change text; this changes data. They
 * share the command, the diff, the backup and `--undo`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCORE_VERSION,
  ScoreVersionError,
  scoreStepsFrom,
  type ScoreStep,
} from "../../core/score-versions.ts";
import { evaluateProject, formatDiagnostic } from "../../core/sdk/eval.ts";
import { printProject } from "../../core/sdk/print.ts";
import { diskFiles } from "./files.ts";
import type { MigrationPlan } from "./run.ts";
import type { FileOp, MigrationContext } from "./types.ts";

/** The score version of every project made before `dawn.json` recorded one. */
export const FIRST_PROJECT_SCORE_VERSION = 1;

const SDK_PATH = ".dawn/sdk/v1.ts";

export type ScoreStepLine = Readonly<{
  from: number;
  to: number;
  introducedIn: string;
  reason: string;
  hint: string;
}>;

export type ScoreStanding = Readonly<{
  /** The version the project's source is written for. */
  version: number;
  /** The version this dawn writes. */
  current: number;
  /** What `dawn migrate` would run, oldest first; empty when current. */
  steps: readonly ScoreStepLine[];
}>;

export const scoreStepLine = (step: ScoreStep): ScoreStepLine => ({
  from: step.from,
  to: step.from + 1,
  introducedIn: step.introducedIn,
  reason: step.reason,
  hint: step.hint,
});

/** `1 → 2 (dawn 0.50.0) reason · hint`. */
export function formatScoreStep(step: ScoreStepLine): string {
  return `score ${step.from} → ${step.to} (dawn ${step.introducedIn}) ${step.reason} · ${step.hint}`;
}

/**
 * Where a project stands, from its parsed `dawn.json`. Throws a
 * ScoreVersionError when the project is newer than this dawn (`newer`) or
 * its `score` is not a version (`invalid`, `older`).
 */
export function scoreStanding(
  manifest: Record<string, unknown>,
): ScoreStanding {
  const version =
    manifest.score === undefined ? FIRST_PROJECT_SCORE_VERSION : manifest.score;
  const steps = scoreStepsFrom(version);
  return Object.freeze({
    version: version as number,
    current: SCORE_VERSION,
    steps: Object.freeze(steps.map(scoreStepLine)),
  });
}

/** `scoreStanding` of the project at `root`; undefined with no usable dawn.json. */
export function projectScoreStanding(root: string): ScoreStanding | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, "dawn.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) return undefined;
  if (Array.isArray(manifest)) return undefined;
  return scoreStanding(manifest as Record<string, unknown>);
}

/** The id a score step has in a plan and a backup: `score-1-to-2`. */
const stepId = (step: ScoreStepLine) => `score-${step.from}-to-${step.to}`;

export type ScoreUpgradeDeps = Readonly<{
  evaluate?: typeof evaluateProject;
}>;

/**
 * The plan that brings the project at `root` to this dawn's score version,
 * or undefined when it is there already. Throws with one line when the
 * project is newer than this dawn or does not evaluate.
 */
export async function planScoreUpgrade(
  root: string,
  context: MigrationContext,
  deps: ScoreUpgradeDeps = {},
): Promise<MigrationPlan | undefined> {
  let standing: ScoreStanding | undefined;
  try {
    standing = projectScoreStanding(root);
  } catch (error) {
    if (error instanceof ScoreVersionError)
      throw new Error(
        error.fault === "newer"
          ? `this project is on a score version newer than this dawn reads (${SCORE_VERSION}) · dawn update`
          : `dawn.json "score" is not a score version · set it to ${FIRST_PROJECT_SCORE_VERSION}..${SCORE_VERSION}`,
      );
    throw error;
  }
  if (standing === undefined || standing.steps.length === 0) return undefined;

  // The vendored SDK writes the project's own version; the loader inside
  // the evaluation runs the steps.
  const evaluated = await (deps.evaluate ?? evaluateProject)(root);
  if (!evaluated.ok)
    throw new Error(
      `the project does not evaluate, so its score cannot be upgraded · ${evaluated.diagnostics
        .slice(0, 3)
        .map(formatDiagnostic)
        .join(" · ")}`,
    );
  const files = diskFiles(root);
  const printed = printProject(evaluated.score).files;
  const ops: FileOp[] = [];
  const kept = new Set(printed.map((file) => file.path));
  for (const file of printed) {
    const before = files.read(file.path);
    if (before !== file.text)
      ops.push({ op: "write", path: file.path, before, after: file.text });
  }
  // A track file the upgraded score no longer prints (its folder is named
  // after the track) would be a second copy of a track.
  for (const path of files.list())
    if (/^tracks\/[^/]+\/track\.ts$/u.test(path) && !kept.has(path))
      ops.push({ op: "delete", path, before: files.read(path) });
  const sdk = files.exists(SDK_PATH)
    ? readFileSync(join(root, SDK_PATH), "utf8")
    : null;
  if (sdk !== context.sdkSource)
    ops.push({
      op: "write",
      path: SDK_PATH,
      before: sdk,
      after: context.sdkSource,
    });
  const manifestText = files.read("dawn.json")!;
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  ops.push({
    op: "write",
    path: "dawn.json",
    before: manifestText,
    after: `${JSON.stringify({ ...manifest, score: SCORE_VERSION }, null, 2)}\n`,
  });
  return Object.freeze({
    pending: standing.steps.map((step) => ({
      id: stepId(step),
      title: `${step.reason} · ${step.hint}`,
      introducedIn: step.introducedIn,
    })),
    ops,
    applied: [],
  });
}
