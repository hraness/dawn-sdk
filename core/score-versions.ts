// SPDX-License-Identifier: MIT
/**
 * The score's schema version and the way an older score becomes the current
 * one (docs/design/score-versions.md).
 *
 * A stored score says which version wrote it. Each version after the first
 * has one step: a pure function from the score JSON of the version before to
 * the score JSON of its own. Steps are never changed or removed once they
 * ship, so every score ever written keeps loading: `scoreFromJSON` runs the
 * steps an older score needs and then validates the result as it would any
 * current score. A version newer than this build knows is refused by name.
 *
 * Nothing here imports the score: the score imports this.
 */

/** The version this build writes. Raise it in the change that adds a step. */
export const SCORE_VERSION = 1 as const;

/** Score JSON as a step sees it: plain data, no classes. */
export type ScoreJson = { [key: string]: unknown };

export type ScoreStep = Readonly<{
  /** The version this step reads. It writes `from + 1`. */
  from: number;
  /** The dawn version that ships it. */
  introducedIn: string;
  /** One line a person can read: why the score changed. */
  reason: string;
  /** One line: what `dawn migrate` does about it, or what to do by hand. */
  hint: string;
  /**
   * The score one version on. Pure: the same output for the same input, and
   * the input is not changed. The runner sets `version` itself.
   */
  up(score: ScoreJson): ScoreJson;
}>;

/**
 * Every step, oldest first. Append-only: the step from version n is
 * `SCORE_STEPS[n - 1]`, with its fixture pair in `core/score-versions/`
 * (`<from>.before.json`, `<from>.after.json`).
 */
export const SCORE_STEPS: readonly ScoreStep[] = Object.freeze([]);

let steps: readonly ScoreStep[] = SCORE_STEPS;

function checked(list: readonly ScoreStep[]): readonly ScoreStep[] {
  list.forEach((step, index) => {
    const from = SCORE_VERSION - list.length + index;
    if (step.from !== from)
      throw new Error(
        `score step ${index} reads version ${step.from}, not ${from}`,
      );
    if (!step.reason.trim() || !step.hint.trim())
      throw new Error(`score step from ${step.from} needs a reason and a hint`);
    if (/\n/u.test(step.reason) || /\n/u.test(step.hint))
      throw new Error(`score step from ${step.from}: one line each`);
  });
  return list;
}
checked(SCORE_STEPS);

/**
 * Runs `work` as a build with `list` for its steps would. For tests: a step
 * from a version before the first (0) exercises every caller with no real
 * step to borrow. The last step must write SCORE_VERSION.
 */
export function withScoreSteps<T>(
  list: readonly ScoreStep[],
  work: () => T,
): T {
  const before = steps;
  steps = checked(list);
  const restore = () => {
    steps = before;
  };
  let result: T;
  try {
    result = work();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as unknown as T;
  restore();
  return result;
}

/** The steps in force: SCORE_STEPS, or a test's. */
export function scoreSteps(): readonly ScoreStep[] {
  return steps;
}

/** The oldest version this build still reads. */
export function oldestScoreVersion(): number {
  return SCORE_VERSION - steps.length;
}

export type ScoreVersionFault = "newer" | "older" | "invalid";

export class ScoreVersionError extends Error {
  readonly fault: ScoreVersionFault;
  constructor(fault: ScoreVersionFault, message: string) {
    super(message);
    this.name = "ScoreVersionError";
    this.fault = fault;
  }
}

function shown(version: unknown): string {
  return typeof version === "string" ||
    typeof version === "number" ||
    typeof version === "boolean" ||
    typeof version === "bigint"
    ? String(version).slice(0, 40)
    : "[object]";
}

/**
 * The steps a score at `version` still needs, oldest first; empty at the
 * current version. Throws a ScoreVersionError for a version this build
 * cannot read.
 */
export function scoreStepsFrom(version: unknown): readonly ScoreStep[] {
  if (typeof version !== "number" || !Number.isSafeInteger(version))
    throw new ScoreVersionError(
      "invalid",
      `unsupported score version: ${shown(version)}`,
    );
  if (version > SCORE_VERSION)
    throw new ScoreVersionError(
      "newer",
      `unsupported score version: ${version} · this dawn reads up to ${SCORE_VERSION} · update dawn`,
    );
  const oldest = oldestScoreVersion();
  if (version < oldest)
    throw new ScoreVersionError(
      "older",
      `unsupported score version: ${version} · the first is ${oldest}`,
    );
  return steps.slice(version - oldest);
}

export type UpgradedScore = Readonly<{
  score: ScoreJson;
  /** The version the score was written at. */
  from: number;
  /** The steps that ran, oldest first. */
  steps: readonly ScoreStep[];
}>;

/**
 * `score` at the current version. A score with no `version` is one this
 * build made in memory and is returned as it is; a stored score always has
 * one. The input is not changed. Throws a ScoreVersionError.
 */
export function upgradeScore(score: ScoreJson): UpgradedScore {
  if (score.version === undefined)
    return { score, from: SCORE_VERSION, steps: [] };
  const from = score.version;
  const needed = scoreStepsFrom(from);
  if (needed.length === 0) return { score, from: SCORE_VERSION, steps: needed };
  let next = score;
  for (const step of needed) {
    const out: unknown = step.up(next);
    if (typeof out !== "object" || out === null || Array.isArray(out))
      throw new ScoreVersionError(
        "invalid",
        `the step from score version ${step.from} did not return a score`,
      );
    next = { ...(out as ScoreJson), version: step.from + 1 };
  }
  return { score: next, from: from as number, steps: needed };
}
