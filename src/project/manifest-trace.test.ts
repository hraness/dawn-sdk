// SPDX-License-Identifier: MIT
/**
 * Every rewrite of `dawn.json` keeps the project's trace settings: init,
 * sync, the migration ledger and `dawn trace enable|disable`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTree } from "../migrate/migrate-fixtures.ts";
import { HELD_MIGRATIONS } from "../migrate/index.ts";
import { applyPlan, planMigrations, planProject } from "../migrate/run.ts";
import { diskFiles } from "../migrate/files.ts";
import type { MigrationContext } from "../migrate/types.ts";
import { traceSettingsOf, updateTraceSettings } from "../trace/settings.ts";
import {
  initProject,
  isProject,
  MAX_MANIFEST_BYTES,
  readManifest,
  runInitCommand,
} from "./init.ts";
import { syncProject } from "./sync.ts";

const CONTEXT: MigrationContext = Object.freeze({
  dawnVersion: "0.39.0",
  sdkSource: 'export const SDK_VERSION = "1.42.0";\n',
  sdkTsconfig: "{}\n",
  agentsBlock: "<!-- dawn:begin -->\nblock\n<!-- dawn:end -->\n",
});
const TRACE = {
  write: true,
  text: false,
  index: true,
  later: { kept: [1, 2] },
};
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-manifest-trace-"));
  dirs.push(dir);
  writeTree(dir, files);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "dawn.json"), "utf8")) as Record<
    string,
    unknown
  >;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("trace settings survive manifest rewrites", () => {
  test("a new project records a trace with text; init never rewrites an existing manifest", async () => {
    const dir = project({});
    const first = await initProject(dir);
    expect(first.wrote).toContain("dawn.json");
    expect(manifestOf(dir).trace).toEqual({ write: true, text: true });
    expect((await readManifest(dir))?.trace).toEqual({
      write: true,
      text: true,
      index: false,
    });
    const existing = project({
      "dawn.json": json({
        format: "dawn.project/v1",
        sdk: 1,
        migrations: [],
        trace: TRACE,
      }),
    });
    const before = readFileSync(join(existing, "dawn.json"), "utf8");
    await initProject(existing);
    expect(readFileSync(join(existing, "dawn.json"), "utf8")).toBe(before);
    const off = project({});
    await initProject(off, { trace: false });
    expect(manifestOf(off).trace).toBeUndefined();
  });

  test("init refuses a manifest it cannot read instead of replacing it", async () => {
    for (const text of [
      '{"format":"other","sdk":1,"trace":{"write":true}}',
      "{nope",
      json({
        format: "dawn.project/v1",
        sdk: 1,
        trace: TRACE,
        lint: { note: "x".repeat(MAX_MANIFEST_BYTES) },
      }),
    ]) {
      const dir = project({ "dawn.json": text });
      await expect(initProject(dir)).rejects.toThrow("nothing was written");
      expect(readFileSync(join(dir, "dawn.json"), "utf8")).toBe(text);
      expect(readdirSync(dir)).toEqual(["dawn.json"]);
      let err = "";
      const sink = { write: (s: string) => (err += s) };
      expect(await runInitCommand(["init"], dir, sink, sink)).toBe(1);
      expect(readFileSync(join(dir, "dawn.json"), "utf8")).toBe(text);
    }
  });

  test("a manifest past the old 4 KiB read bound is still a project", async () => {
    const dir = project({
      "dawn.json": json({
        format: "dawn.project/v1",
        sdk: 1,
        trace: TRACE,
        lint: { note: "x".repeat(8_000) },
      }),
    });
    expect(await isProject(dir)).toBe(true);
    expect((await readManifest(dir))?.trace).toEqual({
      write: true,
      text: false,
      index: true,
    });
  });

  test("sync adds the dawn floor and keeps trace", async () => {
    const dir = project({
      "dawn.json": json({ format: "dawn.project/v1", sdk: 1, trace: TRACE }),
      ".dawn/sdk/v1.ts": CONTEXT.sdkSource,
      ".dawn/sdk/tsconfig.json": "{}\n",
    });
    const result = await syncProject(dir, {
      context: CONTEXT,
      version: "0.39.0",
    });
    expect(result.status).toBe("ok");
    expect(result.wrote).toContain("dawn.json");
    expect(manifestOf(dir)).toMatchObject({ dawn: ">=0.39.0", trace: TRACE });
  });

  test("a migration and its ledger keep trace, from dawn.json or dawg.json", async () => {
    const legacy = project({
      "dawg.json": json({ format: "dawg.project/v1", sdk: 1, trace: TRACE }),
      "song.ts": 'import { song } from "dawg";\nexport default song({});\n',
    });
    const plan = planProject(legacy, CONTEXT);
    expect(plan.pending.map((m) => m.id)).toEqual(["0001-dawg-to-dawn"]);
    await applyPlan(legacy, plan, new Date("2026-11-15T00:00:00Z"));
    expect(manifestOf(legacy)).toMatchObject({
      format: "dawn.project/v1",
      migrations: ["0001-dawg-to-dawn"],
      trace: TRACE,
    });

    const current = project({
      "dawn.json": json({ format: "dawn.project/v1", sdk: 1, trace: TRACE }),
      "song.ts": 'import { song } from "dawg";\nexport default song({});\n',
    });
    const step = planProject(current, CONTEXT);
    await applyPlan(current, step, new Date("2026-11-15T00:00:00Z"));
    expect(manifestOf(current)).toMatchObject({
      migrations: ["0001-dawg-to-dawn"],
      trace: TRACE,
    });
  });

  test("the held comments step, when named, keeps trace and stays held", async () => {
    const dir = project({
      "dawn.json": json({ format: "dawn.project/v1", sdk: 1, trace: TRACE }),
      "comments.json": json({
        schema: "dawn.comments/v1",
        comments: [
          { id: "c1", text: "Louder", created: "2026-11-01T00:00:00Z" },
        ],
      }),
    });
    expect(planProject(dir, CONTEXT).pending).toEqual([]);
    const held = planMigrations(diskFiles(dir), CONTEXT, HELD_MIGRATIONS);
    const write = held.ops.find(
      (op) => op.op === "write" && op.path === "dawn.json",
    );
    expect(
      write && write.op === "write" && JSON.parse(write.after).trace,
    ).toEqual(TRACE);
  });

  test("enable and disable change only the trace switches", async () => {
    const dir = project({
      "dawn.json": json({
        format: "dawn.project/v1",
        sdk: 1,
        lint: { rules: { x: "off" } },
        trace: { index: true, later: 1 },
      }),
    });
    expect(traceSettingsOf(manifestOf(dir))).toEqual({
      write: false,
      text: true,
      index: true,
    });
    const on = await updateTraceSettings(dir, { write: true });
    expect(on.changed).toBe(true);
    expect(manifestOf(dir)).toEqual({
      format: "dawn.project/v1",
      sdk: 1,
      lint: { rules: { x: "off" } },
      trace: { index: true, later: 1, write: true, text: true },
    });
    await updateTraceSettings(dir, { text: false });
    await updateTraceSettings(dir, { write: false });
    expect(manifestOf(dir).trace).toEqual({
      index: true,
      later: 1,
      write: false,
      text: false,
    });
    expect((await updateTraceSettings(dir, { write: false })).changed).toBe(
      false,
    );
    const broken = project({ "dawn.json": "[1]" });
    await expect(updateTraceSettings(broken, { write: true })).rejects.toThrow(
      "nothing was changed",
    );
    expect(readFileSync(join(broken, "dawn.json"), "utf8")).toBe("[1]");
  });
});
