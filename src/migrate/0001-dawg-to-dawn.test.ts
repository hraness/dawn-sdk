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
import type { CommandRunner } from "../process/runner.ts";
import { runMigrateCommand } from "./cli.ts";
import { overlay } from "./files.ts";
import { copyFixture, snapshotTree, writeTree } from "./migrate-fixtures.ts";
import { migration0001 } from "./0001-dawg-to-dawn.ts";
import { applyPlan, planProject, undoMigration } from "./run.ts";
import { diskFiles } from "./files.ts";
import type { MigrationContext } from "./types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "0001-dawg-to-dawn");
const CONTEXT: MigrationContext = Object.freeze({
  dawnVersion: "0.39.0",
  sdkSource: 'export const SDK_VERSION = "1.42.0";\n',
  sdkTsconfig: "{}\n",
  agentsBlock:
    "<!-- dawn:begin -->\n# dawn project (fixture)\n<!-- dawn:end -->\n",
});
const STATE = {
  ".dawg/sdk/v1.ts": 'export const SDK_VERSION = "1.30.0";\n',
  ".dawg/sdk/tsconfig.json": "{}\n",
  ".dawg/tsbuild/x.tsbuildinfo": "x",
  ".dawg/takes/bass-1.wav": "RIFF",
};
const NOW = new Date("2026-11-07T00:00:00Z");
const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-migrate-"));
  dirs.push(dir);
  copyFixture(join(FIXTURES, "before"), dir);
  writeTree(dir, STATE);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const out = () => {
  const chunks: string[] = [];
  return {
    chunks,
    write: (text: string) => chunks.push(text),
    text: () => chunks.join(""),
  };
};
const noGit: CommandRunner = {
  which: () => undefined,
  run: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
};

describe("0001-dawg-to-dawn", () => {
  test("before → after, state moved, strings and comments kept", async () => {
    const dir = project();
    const plan = planProject(dir, CONTEXT);
    expect(plan.pending.map((m) => m.id)).toEqual(["0001-dawg-to-dawn"]);
    await applyPlan(dir, plan, NOW);
    const isState = (path: string) =>
      path.startsWith(".dawn") || path.startsWith(".dawg");
    expect(snapshotTree(dir, isState)).toEqual(
      snapshotTree(join(FIXTURES, "after")),
    );
    expect(readFileSync(join(dir, ".dawn/sdk/v1.ts"), "utf8")).toBe(
      CONTEXT.sdkSource,
    );
    expect(readFileSync(join(dir, ".dawn/takes/bass-1.wav"), "utf8")).toBe(
      "RIFF",
    );
    expect(existsSync(join(dir, ".dawg"))).toBe(false);
    expect(existsSync(join(dir, ".dawn/tsbuild"))).toBe(false);
    const song = readFileSync(join(dir, "song.ts"), "utf8");
    expect(song).toContain(
      '// This song started in dawg; the comment keeps saying "dawg".',
    );
    expect(song).toContain('const label = "made with dawg";');
  });

  test("idempotent: planning the output yields nothing", async () => {
    const dir = project();
    await applyPlan(dir, planProject(dir, CONTEXT), NOW);
    expect(planProject(dir, CONTEXT).ops).toEqual([]);
    const files = diskFiles(dir);
    expect(migration0001.plan(files, CONTEXT)).toEqual([]);
    // And over the overlay of its own plan, without touching disk.
    const fresh = diskFiles(project());
    const ops = migration0001.plan(fresh, CONTEXT);
    expect(ops.length).toBeGreaterThan(0);
    expect(migration0001.plan(overlay(fresh, ops), CONTEXT)).toEqual([]);
  });

  test("a half-applied project converges", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "dawn.json"),
      '{"format":"dawn.project/v1","sdk":1,"dawn":">=0.39.0"}\n',
    );
    const plan = planProject(dir, CONTEXT);
    await applyPlan(dir, plan, NOW);
    expect(existsSync(join(dir, "dawg.json"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dir, "dawn.json"), "utf8")).migrations,
    ).toEqual(["0001-dawg-to-dawn"]);
    expect(planProject(dir, CONTEXT).ops).toEqual([]);
  });

  test("undo restores the project exactly", async () => {
    const dir = project();
    const before = snapshotTree(dir);
    await applyPlan(dir, planProject(dir, CONTEXT), NOW);
    expect(undoMigration(dir)?.migrations).toEqual(["0001-dawg-to-dawn"]);
    const after = snapshotTree(dir);
    expect(after).toEqual(before);
    expect(existsSync(join(dir, ".dawn/migrate-backup"))).toBe(false);
    expect(undoMigration(dir)).toBeUndefined();
  });

  test("the CLI: dry run exits 3 and writes nothing; --apply; --undo; --json", async () => {
    const dir = project();
    const before = snapshotTree(dir);
    const o = out();
    const e = out();
    expect(
      await runMigrateCommand(["migrate"], dir, o, e, {
        context: CONTEXT,
        runner: noGit,
      }),
    ).toBe(3);
    expect(o.text()).toContain('+import { track, note } from "dawn";');
    expect(o.text()).toContain("dry run, nothing written");
    expect(snapshotTree(dir)).toEqual(before);

    const j = out();
    expect(
      await runMigrateCommand(["migrate", "--json"], dir, j, e, {
        context: CONTEXT,
        runner: noGit,
      }),
    ).toBe(3);
    const report = JSON.parse(j.text());
    expect(report.schema).toBe("dawn.migrate/v1");
    expect(report.result).toBe("pending");
    expect(report.ops).toContainEqual({ op: "delete", path: "dawg.json" });

    const a = out();
    expect(
      await runMigrateCommand(["migrate", "--apply"], dir, a, e, {
        context: CONTEXT,
        runner: noGit,
        now: NOW,
      }),
    ).toBe(0);
    expect(a.text()).toContain("applied 0001-dawg-to-dawn");
    const c = out();
    expect(
      await runMigrateCommand(["migrate"], dir, c, e, {
        context: CONTEXT,
        runner: noGit,
      }),
    ).toBe(0);
    expect(c.text()).toContain("up to date");
    expect(
      await runMigrateCommand(["migrate", "--undo"], dir, out(), e, {
        context: CONTEXT,
      }),
    ).toBe(0);
    expect(snapshotTree(dir)).toEqual(before);
    expect(
      await runMigrateCommand(
        ["migrate", "--apply", "--undo"],
        dir,
        out(),
        out(),
      ),
    ).toBe(2);
  });

  test("--apply refuses uncommitted changes unless --force", async () => {
    const dir = project();
    const dirty: CommandRunner = {
      which: () => "/usr/bin/git",
      run: async () => ({
        code: 0,
        stdout: " M song.ts\n",
        stderr: "",
        killed: false,
      }),
    };
    const e = out();
    expect(
      await runMigrateCommand(["migrate", "--apply"], dir, out(), e, {
        context: CONTEXT,
        runner: dirty,
      }),
    ).toBe(1);
    expect(e.text()).toContain("uncommitted changes in song.ts");
    expect(existsSync(join(dir, "dawg.json"))).toBe(true);
    expect(
      await runMigrateCommand(
        ["migrate", "--apply", "--force"],
        dir,
        out(),
        out(),
        { context: CONTEXT, runner: dirty, now: NOW },
      ),
    ).toBe(0);
    expect(existsSync(join(dir, "dawg.json"))).toBe(false);
  });

  test("a dawn project needs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dawn-migrate-"));
    dirs.push(dir);
    writeTree(dir, {
      "dawn.json": '{"format":"dawn.project/v1","sdk":1}\n',
      "song.ts":
        'import { song } from "dawn";\n// dawg was here\nconst s = "dawg";\n',
      "tsconfig.json":
        '{"compilerOptions":{"paths":{"dawn":["./.dawn/sdk/v1.ts"]}}}\n',
    });
    expect(planProject(dir, CONTEXT).pending).toEqual([]);
  });
});
