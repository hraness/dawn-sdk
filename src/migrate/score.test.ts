// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScore, scoreFromJSON } from "../../core/score.ts";
import {
  SCORE_VERSION,
  withScoreSteps,
  type ScoreStep,
} from "../../core/score-versions.ts";
import { printProject } from "../../core/sdk/print.ts";
import type { EvalResult } from "../../core/sdk/eval.ts";
import { runCheckCommand } from "../project/check.ts";
import { syncProject } from "../project/sync.ts";
import type { CommandRunner } from "../process/runner.ts";
import { runMigrateCommand } from "./cli.ts";
import { writeTree } from "./migrate-fixtures.ts";
import { planScoreUpgrade, scoreStanding } from "./score.ts";
import type { MigrationContext } from "./types.ts";

/** A version before the first, for tests: tempo was called `tempoWas`. */
const STEP: ScoreStep = {
  from: 0,
  introducedIn: "0.0.0",
  reason: "tempoWas is now tempoBpm, the name every other tool uses",
  hint: "dawn migrate rewrites it; nothing to do by hand",
  up: ({ tempoWas, ...rest }) => ({ ...rest, tempoBpm: tempoWas }),
};
const OLD_SDK = 'export const SDK_VERSION = "1.41.0";\n';
const CONTEXT: MigrationContext = Object.freeze({
  dawnVersion: "0.54.0",
  sdkSource: 'export const SDK_VERSION = "1.42.0";\n',
  sdkTsconfig: "{}\n",
  agentsBlock: "<!-- dawn:begin -->\nblock\n<!-- dawn:end -->\n",
});
const NOW = new Date("2026-11-14T00:00:00Z");
const noGit: CommandRunner = {
  which: () => undefined,
  run: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
};

const current = createScore({
  tempoBpm: 96,
  bars: 2,
  tracks: [{ id: "lead", name: "Lead", instrument: "synth" }],
  notes: [
    {
      id: "a",
      trackId: "lead",
      startTick: 0,
      durationTicks: 480,
      pitch: 62,
      velocity: 0.8,
    },
  ],
});
/** The score as version 0 stored it. */
function stored(): Record<string, unknown> {
  const { tempoBpm, ...rest } = JSON.parse(
    JSON.stringify(current.toJSON()),
  ) as Record<string, unknown>;
  return { ...rest, version: 0, tempoWas: tempoBpm };
}
/**
 * What evaluating the project gives: its (old) vendored SDK wrote the
 * version 0 score and the loader, under the test step, brought it up.
 */
const evaluate = async (): Promise<EvalResult> =>
  ({
    ok: true,
    score: scoreFromJSON(stored()),
    diagnostics: [],
    ms: 0,
  }) as unknown as EvalResult;

const manifest = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ format: "dawn.project/v1", sdk: 1, migrations: ["0001-dawg-to-dawn"], ...extra }, null, 2)}\n`;

const dirs: string[] = [];
/** A project whose source is the version 0 spelling of `current`. */
function project(score: unknown = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-score-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "dawn.json": manifest(score === undefined ? {} : { score }),
    ".dawn/sdk/v1.ts": OLD_SDK,
    "tracks/old-lead/track.ts": "// the lead, before it was renamed\n",
  };
  for (const file of printProject(current).files)
    files[file.path] = file.text.replace("96", "96 /* was tempoWas */");
  writeTree(dir, files);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const out = () => {
  const chunks: string[] = [];
  return {
    write: (text: string) => chunks.push(text),
    text: () => chunks.join(""),
  };
};
const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8");
const migrate = async (dir: string, ...flags: string[]) => {
  const stdout = out();
  const stderr = out();
  const code = await runMigrateCommand(
    ["migrate", ...flags],
    dir,
    stdout,
    stderr,
    {
      context: CONTEXT,
      runner: noGit,
      now: NOW,
      score: { evaluate },
    },
  );
  return { code, out: stdout.text(), err: stderr.text() };
};

describe("where a project's score version stands", () => {
  test("no field is the first version; the current one has nothing to run", () => {
    expect(scoreStanding({})).toEqual({ version: 1, current: 1, steps: [] });
    expect(scoreStanding({ score: SCORE_VERSION }).steps).toEqual([]);
  });

  test("an older one lists its steps with reason and hint", () => {
    withScoreSteps([STEP], () => {
      expect(scoreStanding({ score: 0 })).toEqual({
        version: 0,
        current: SCORE_VERSION,
        steps: [
          {
            from: 0,
            to: 1,
            introducedIn: "0.0.0",
            reason: STEP.reason,
            hint: STEP.hint,
          },
        ],
      });
    });
  });

  test("newer, or not a version, throws", () => {
    expect(() => scoreStanding({ score: SCORE_VERSION + 1 })).toThrow(
      "update dawn",
    );
    expect(() => scoreStanding({ score: "1" })).toThrow(
      "unsupported score version",
    );
    expect(() => scoreStanding({ score: 0 })).toThrow("the first is 1");
  });
});

describe("dawn migrate, for the score", () => {
  test("a current project has no score plan and says its version", async () => {
    const dir = project(SCORE_VERSION);
    expect(await planScoreUpgrade(dir, CONTEXT, { evaluate })).toBeUndefined();
    const run = await migrate(dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`score version ${SCORE_VERSION}`);
  });

  test("the dry run names each step and changes nothing", async () => {
    await withScoreSteps([STEP], async () => {
      const dir = project();
      const before = read(dir, "song.ts");
      const run = await migrate(dir);
      expect(run.code).toBe(3);
      expect(run.out).toContain(`score version 0 → ${SCORE_VERSION}`);
      expect(run.out).toContain(
        `score 0 → 1 (dawn 0.0.0) ${STEP.reason} · ${STEP.hint}`,
      );
      expect(run.out).toContain("dawn migrate --apply");
      expect(read(dir, "song.ts")).toBe(before);
      expect(read(dir, "dawn.json")).toBe(manifest({ score: 0 }));

      const json = await migrate(dir, "--json");
      expect(json.code).toBe(3);
      const report = JSON.parse(json.out) as Record<string, unknown>;
      expect(report).toMatchObject({
        schema: "dawn.migrate/v1",
        result: "pending",
        score: { version: 0, current: SCORE_VERSION },
      });
    });
  });

  test("--apply prints the upgraded score, refreshes the SDK and records the version; --undo puts it back", async () => {
    await withScoreSteps([STEP], async () => {
      const dir = project();
      const before = read(dir, "song.ts");
      const run = await migrate(dir, "--apply");
      expect(run.err).toBe("");
      expect(run.code).toBe(0);
      expect(run.out).toContain("applied score-0-to-1");
      for (const file of printProject(current).files)
        expect(read(dir, file.path)).toBe(file.text);
      expect(existsSync(join(dir, "tracks/old-lead/track.ts"))).toBe(false);
      expect(read(dir, ".dawn/sdk/v1.ts")).toBe(CONTEXT.sdkSource);
      expect(JSON.parse(read(dir, "dawn.json"))).toMatchObject({
        score: SCORE_VERSION,
        migrations: ["0001-dawg-to-dawn"],
      });

      // Nothing left to do.
      const again = await migrate(dir);
      expect(again.code).toBe(0);
      expect(again.out).toContain(`score version ${SCORE_VERSION}`);

      const undo = await migrate(dir, "--undo");
      expect(undo.code).toBe(0);
      expect(read(dir, "song.ts")).toBe(before);
      expect(read(dir, ".dawn/sdk/v1.ts")).toBe(OLD_SDK);
      expect(read(dir, "dawn.json")).toBe(manifest({ score: 0 }));
      expect(existsSync(join(dir, "tracks/old-lead/track.ts"))).toBe(true);
    });
  });

  test("--list shows the score steps after the source steps", async () => {
    const dir = project(SCORE_VERSION);
    const none = await migrate(dir, "--list");
    expect(none.out).toContain(
      `score version ${SCORE_VERSION} · the first, so no score steps yet`,
    );
    await withScoreSteps([STEP], async () => {
      const run = await migrate(dir, "--list");
      expect(run.code).toBe(0);
      const lines = run.out.trim().split("\n");
      expect(lines.at(-2)).toBe(
        `score 0 → 1 (dawn 0.0.0) ${STEP.reason} · ${STEP.hint}`,
      );
      expect(lines.at(-1)).toBe(`score version ${SCORE_VERSION}`);
      expect(lines[0]).toContain("0001-dawg-to-dawn");
    });
  });

  test("a project newer than this dawn stops with what to do", async () => {
    const dir = project(SCORE_VERSION + 1);
    const run = await migrate(dir);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("newer than this dawn reads");
    expect(run.err).toContain("dawn update");
    const bad = project("two");
    expect((await migrate(bad)).err).toContain("is not a score version");
  });

  test("a project that does not evaluate is not rewritten", async () => {
    await withScoreSteps([STEP], async () => {
      const dir = project();
      const before = read(dir, "song.ts");
      const stdout = out();
      const stderr = out();
      const code = await runMigrateCommand(
        ["migrate", "--apply"],
        dir,
        stdout,
        stderr,
        {
          context: CONTEXT,
          runner: noGit,
          now: NOW,
          score: {
            evaluate: async () =>
              ({
                ok: false,
                diagnostics: [
                  { file: "song.ts", line: 3, message: "no such name" },
                ],
                ms: 0,
              }) as unknown as EvalResult,
          },
        },
      );
      expect(code).not.toBe(0);
      expect(stderr.text()).toContain("does not evaluate");
      expect(stderr.text()).toContain("no such name");
      expect(read(dir, "song.ts")).toBe(before);
    });
  });
});

describe("a project behind on its score version still works", () => {
  test("sync hints at the upgrade and leaves the vendored SDK alone", async () => {
    await withScoreSteps([STEP], async () => {
      const dir = project();
      const result = await syncProject(dir, {
        context: CONTEXT,
        version: "0.54.0",
      });
      expect(result.status).toBe("ok");
      expect(result.score).toMatchObject({
        version: 0,
        current: SCORE_VERSION,
      });
      expect(result.hints.join("\n")).toContain(
        `score version 0 of ${SCORE_VERSION} and still works · dawn migrate shows the upgrade`,
      );
      expect(result.hints.join("\n")).toContain(STEP.reason);
      expect(read(dir, ".dawn/sdk/v1.ts")).toBe(OLD_SDK);
      expect(result.wrote).not.toContain(".dawn/sdk/v1.ts");
    });
  });

  test("once current, sync refreshes the SDK as before", async () => {
    const dir = project(SCORE_VERSION);
    const result = await syncProject(dir, {
      context: CONTEXT,
      version: "0.54.0",
    });
    expect(result.status).toBe("ok");
    expect(result.score?.steps).toEqual([]);
    expect(read(dir, ".dawn/sdk/v1.ts")).toBe(CONTEXT.sdkSource);
  });

  test("newer than this dawn: needs-dawn; not a version: said plainly", async () => {
    const newer = await syncProject(project(SCORE_VERSION + 1), {
      context: CONTEXT,
      version: "0.54.0",
    });
    expect(newer).toMatchObject({ status: "needs-dawn", fix: "dawn update" });
    expect(newer.problem).toContain(
      `score version ${SCORE_VERSION + 1}, and this dawn reads up to ${SCORE_VERSION}`,
    );
    const bad = await syncProject(project("1"), {
      context: CONTEXT,
      version: "0.54.0",
    });
    expect(bad.status).toBe("not-a-project");
    expect(bad.problem).toContain('"score" is "1"');
  });

  test("dawn check stops on a newer project with the same words", async () => {
    const dir = project(SCORE_VERSION + 1);
    writeFileSync(join(dir, "AGENTS.md"), CONTEXT.agentsBlock);
    const stdout = out();
    const stderr = out();
    const code = await runCheckCommand(["check"], dir, stdout, stderr, {
      context: CONTEXT,
      version: "0.54.0",
    } as never);
    expect(code).not.toBe(0);
    expect(stderr.text() + stdout.text()).toContain("this dawn reads up to");
  });
});
