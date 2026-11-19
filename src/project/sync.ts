// SPDX-License-Identifier: MIT
/**
 * Project sync, run by `dawn check` and `dawn render` before they work:
 *
 * 1. a project from before the rename, or one with pending `dawn migrate`
 *    steps, stops with `needs-migrate` (exit 3: an action is waiting);
 * 2. a project that needs a newer dawn (`dawn.json.dawn`, a newer SDK
 *    major, or a vendored SDK newer than the shipped one) stops with
 *    `needs-dawn`;
 * 3. otherwise the vendored SDK is refreshed when this dawn ships a newer
 *    one of the same major, `dawn.json` gains `dawn` when it has none, and
 *    the AGENTS.md block between the dawn markers is regenerated.
 *
 * A project on an older score version (`dawn.json` `score`) is not stopped:
 * its vendored SDK writes the old score and the loader upgrades it. Sync
 * says so, names what `dawn migrate` would do, and leaves the vendored SDK
 * alone until then, since a newer SDK would write the newer score from
 * source written for the old one.
 *
 * Every write is atomic; sync never touches text outside the markers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SDK_CHANGES, changeLines } from "../../core/sdk/changes.ts";
import { defaultMigrationContext } from "../migrate/context.ts";
import { diskFiles } from "../migrate/files.ts";
import { planMigrations } from "../migrate/run.ts";
import {
  formatScoreStep,
  scoreStanding,
  type ScoreStanding,
} from "../migrate/score.ts";
import { SCORE_VERSION, ScoreVersionError } from "../../core/score-versions.ts";
import type { MigrationContext } from "../migrate/types.ts";
import {
  compareVersions,
  minorFloor,
  parseRequirement,
  satisfies,
} from "../update/semver.ts";
import { VERSION } from "../version.ts";
import { AGENTS_BEGIN, replaceAgentsBlock } from "./agents-md.ts";
import {
  LEGACY_PROJECT_PROBLEM,
  PROJECT_FILE,
  SDK_RELATIVE_PATH,
  SDK_TSCONFIG,
  SDK_TSCONFIG_RELATIVE_PATH,
  sdkVersionOf,
  writeAtomic,
} from "./init.ts";

export type SyncStatus =
  "ok" | "needs-migrate" | "needs-dawn" | "not-a-project";

export type SyncResult = Readonly<{
  status: SyncStatus;
  /** One line each: what sync refreshed. */
  notices: readonly string[];
  /** Advice that does not stop the command. */
  hints: readonly string[];
  /** Project-relative paths written. */
  wrote: readonly string[];
  /** Where the project's score version stands, once known. */
  score?: ScoreStanding;
  /** For a stop: the problem and the command that fixes it. */
  problem?: string;
  fix?: string;
}>;

export type SyncOptions = Readonly<{
  context?: MigrationContext;
  /** The running dawn version (tests). */
  version?: string;
  /** Report only; write nothing. */
  dryRun?: boolean;
}>;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function sdkMajor(version: string): number {
  return Number(version.split(".")[0]);
}

/** Change-table lines for SDK versions after `from` up to `to`. */
export function sdkChangesBetween(from: string, to: string): string[] {
  return SDK_CHANGES.filter(
    (change) =>
      compareVersions(change.sdk, from) > 0 &&
      compareVersions(change.sdk, to) <= 0,
  ).flatMap(changeLines);
}

function stop(status: SyncStatus, problem: string, fix: string): SyncResult {
  return Object.freeze({
    status,
    notices: [],
    hints: [],
    wrote: [],
    problem,
    fix,
  });
}

export async function syncProject(
  dir: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const version = options.version ?? VERSION;
  const manifestText = await readOptional(join(dir, PROJECT_FILE));
  if (manifestText === undefined) {
    if ((await readOptional(join(dir, "dawg.json"))) !== undefined)
      return stop("needs-migrate", LEGACY_PROJECT_PROBLEM, "dawn migrate");
    return stop(
      "not-a-project",
      "not a dawn project (no dawn.json here)",
      "dawn init",
    );
  }
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(manifestText);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not an object");
    record = value as Record<string, unknown>;
  } catch {
    return stop(
      "not-a-project",
      "dawn.json is not valid JSON",
      "fix dawn.json, or move it away and run dawn init",
    );
  }

  // 1. What this project needs from dawn.
  if (typeof record.dawn === "string") {
    const requirement = parseRequirement(record.dawn);
    if (requirement === undefined)
      return stop(
        "not-a-project",
        `dawn.json "dawn" is ${JSON.stringify(record.dawn)}, not ">=x.y.z" or "x.y.z"`,
        'set "dawn": ">=0.39.0"',
      );
    if (!satisfies(version, requirement))
      return stop(
        "needs-dawn",
        `this project needs dawn ${record.dawn} (you have ${version})`,
        requirement.kind === "pin"
          ? `dawn update --to ${requirement.version}`
          : "dawn update",
      );
  }
  const context = options.context ?? (await defaultMigrationContext());
  const shipped = sdkVersionOf(context.sdkSource);
  if (shipped === undefined) throw new Error("shipped SDK has no SDK_VERSION");
  if (typeof record.sdk === "number" && record.sdk > sdkMajor(shipped))
    return stop(
      "needs-dawn",
      `this project uses SDK ${record.sdk}, and this dawn ships SDK ${sdkMajor(shipped)}`,
      "dawn update",
    );

  // 2. Pending migrations.
  const plan = planMigrations(diskFiles(dir), context);
  if (plan.pending.length > 0)
    return stop(
      "needs-migrate",
      `this project needs ${plan.pending.map((m) => m.id).join(", ")}`,
      "dawn migrate (shows the diff), then dawn migrate --apply",
    );
  if (typeof record.sdk === "number" && record.sdk < sdkMajor(shipped))
    return stop(
      "needs-migrate",
      `this project uses SDK ${record.sdk}, and this dawn ships SDK ${sdkMajor(shipped)}`,
      "dawn migrate",
    );

  const notices: string[] = [];
  const hints: string[] = [];
  const wrote: string[] = [];

  // The score version: newer than this dawn stops; older is read and said.
  let score: ScoreStanding;
  try {
    score = scoreStanding(record);
  } catch (error) {
    if (!(error instanceof ScoreVersionError)) throw error;
    return error.fault === "newer"
      ? stop(
          "needs-dawn",
          `this project is on score version ${String(record.score)}, and this dawn reads up to ${SCORE_VERSION}`,
          "dawn update",
        )
      : stop(
          "not-a-project",
          `dawn.json "score" is ${JSON.stringify(record.score)}, not a score version`,
          `set "score": ${SCORE_VERSION}, or remove it`,
        );
  }
  const behind = score.steps.length > 0;
  if (behind) {
    hints.push(
      `this project is on score version ${score.version} of ${score.current} and still works · dawn migrate shows the upgrade`,
    );
    for (const step of score.steps) hints.push(formatScoreStep(step));
  }
  const write = async (path: string, text: string) => {
    if (!options.dryRun) await writeAtomic(join(dir, path), text);
    wrote.push(path);
  };

  // 3. The vendored SDK.
  const vendored = await readOptional(join(dir, SDK_RELATIVE_PATH));
  const vendoredVersion =
    vendored === undefined ? undefined : sdkVersionOf(vendored);
  let refreshed = false;
  if (
    vendoredVersion !== undefined &&
    sdkMajor(vendoredVersion) === sdkMajor(shipped) &&
    compareVersions(vendoredVersion, shipped) > 0
  )
    return stop(
      "needs-dawn",
      `the vendored SDK is ${vendoredVersion}, newer than this dawn's ${shipped}`,
      "dawn update",
    );
  if (
    vendored === undefined ||
    vendoredVersion === undefined ||
    (!behind && compareVersions(vendoredVersion, shipped) < 0)
  ) {
    await write(SDK_RELATIVE_PATH, context.sdkSource);
    refreshed = vendoredVersion !== undefined;
    if (vendoredVersion !== undefined) {
      const count = sdkChangesBetween(vendoredVersion, shipped).length;
      notices.push(
        `updated the vendored SDK ${vendoredVersion} → ${shipped}${count > 0 ? ` (${count} change${count === 1 ? "" : "s"} · dawn changes --since ${vendoredVersion})` : ""}`,
      );
    }
  }
  if (
    (await readOptional(join(dir, SDK_TSCONFIG_RELATIVE_PATH))) !== SDK_TSCONFIG
  )
    await write(SDK_TSCONFIG_RELATIVE_PATH, SDK_TSCONFIG);

  // 4. dawn.json `dawn`: added when absent, raised to this minor after an SDK refresh.
  const floor = minorFloor(version);
  const current =
    typeof record.dawn === "string" ? parseRequirement(record.dawn) : undefined;
  const raise =
    current?.kind === "min" &&
    refreshed &&
    compareVersions(current.version, floor.slice(2)) < 0;
  if (record.dawn === undefined || raise) {
    const next = { ...record, dawn: floor };
    await write(PROJECT_FILE, `${JSON.stringify(next, null, 2)}\n`);
    notices.push(`dawn.json now records "dawn": "${floor}"`);
  }

  // 5. The AGENTS.md block.
  const agents = await readOptional(join(dir, "AGENTS.md"));
  if (agents !== undefined) {
    const next = replaceAgentsBlock(agents, context.agentsBlock);
    if (next === undefined) {
      if (!agents.includes(AGENTS_BEGIN))
        hints.push(
          `AGENTS.md has no ${AGENTS_BEGIN} block · add the marker pair and dawn keeps the block current`,
        );
    } else if (next !== agents) {
      await write("AGENTS.md", next);
      notices.push("refreshed the dawn block in AGENTS.md");
    }
  }
  return Object.freeze({ status: "ok", notices, hints, wrote, score });
}
