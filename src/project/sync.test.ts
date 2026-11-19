// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTree } from "../migrate/migrate-fixtures.ts";
import type { MigrationContext } from "../migrate/types.ts";
import { runCheckCommand } from "./check.ts";
import { syncProject } from "./sync.ts";

const BLOCK = "<!-- dawn:begin -->\nnew block\n<!-- dawn:end -->\n";
const context = (sdk = "1.42.0"): MigrationContext => ({
  dawnVersion: "0.39.0",
  sdkSource: `export const SDK_VERSION = "${sdk}";\n`,
  sdkTsconfig: "{}\n",
  agentsBlock: BLOCK,
});
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-sync-"));
  dirs.push(dir);
  writeTree(dir, files);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8");
const manifest = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ format: "dawn.project/v1", sdk: 1, ...extra })}\n`;

describe("syncProject", () => {
  test("a dawg project stops with needs-migrate", async () => {
    const dir = project({
      "dawg.json": '{"format":"dawg.project/v1","sdk":1}',
    });
    const result = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
    });
    expect(result.status).toBe("needs-migrate");
    expect(result.problem).toContain("dawn migrate --apply");
  });

  test("pending migrations stop the command with the step ids", async () => {
    const dir = project({
      "dawn.json": manifest(),
      "song.ts": 'import { song } from "dawg";\n',
    });
    const result = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
    });
    expect(result).toMatchObject({
      status: "needs-migrate",
      problem: "this project needs 0001-dawg-to-dawn",
    });
  });

  test("a dawn requirement this version does not meet: needs-dawn with the right fix", async () => {
    const min = project({ "dawn.json": manifest({ dawn: ">=0.40.0" }) });
    expect(
      await syncProject(min, { context: context(), version: "0.39.0" }),
    ).toMatchObject({
      status: "needs-dawn",
      fix: "dawn update",
    });
    const pin = project({ "dawn.json": manifest({ dawn: "0.38.1" }) });
    expect(
      await syncProject(pin, { context: context(), version: "0.39.0" }),
    ).toMatchObject({
      status: "needs-dawn",
      fix: "dawn update --to 0.38.1",
    });
    const major = project({ "dawn.json": manifest({ sdk: 2 }) });
    expect(
      (await syncProject(major, { context: context(), version: "0.39.0" }))
        .status,
    ).toBe("needs-dawn");
  });

  test("refreshes an older vendored SDK, records dawn, and raises an older minimum", async () => {
    const dir = project({
      "dawn.json": manifest({ dawn: ">=0.38.0" }),
      ".dawn/sdk/v1.ts": 'export const SDK_VERSION = "1.41.0";\n',
    });
    const result = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
    });
    expect(result.status).toBe("ok");
    expect(read(dir, ".dawn/sdk/v1.ts")).toContain('"1.42.0"');
    expect(result.notices[0]).toContain(
      "updated the vendored SDK 1.41.0 → 1.42.0 (2 changes · dawn changes --since 1.41.0)",
    );
    expect(JSON.parse(read(dir, "dawn.json")).dawn).toBe(">=0.39.0");
    const again = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
    });
    expect(again.wrote).toEqual([]);
  });

  test("a vendored SDK newer than this dawn's is needs-dawn", async () => {
    const dir = project({
      "dawn.json": manifest(),
      ".dawn/sdk/v1.ts": 'export const SDK_VERSION = "1.50.0";\n',
    });
    expect(
      (await syncProject(dir, { context: context(), version: "0.39.0" }))
        .status,
    ).toBe("needs-dawn");
  });

  test("adds dawn when absent, and keeps a pin", async () => {
    const dir = project({ "dawn.json": manifest({ title: "x" }) });
    await syncProject(dir, { context: context(), version: "0.39.2" });
    expect(JSON.parse(read(dir, "dawn.json"))).toEqual({
      format: "dawn.project/v1",
      sdk: 1,
      title: "x",
      dawn: ">=0.39.0",
    });
    const pinned = project({
      "dawn.json": manifest({ dawn: "0.39.2" }),
      ".dawn/sdk/v1.ts": 'export const SDK_VERSION = "1.41.0";\n',
    });
    await syncProject(pinned, { context: context(), version: "0.39.2" });
    expect(JSON.parse(read(pinned, "dawn.json")).dawn).toBe("0.39.2");
  });

  test("AGENTS.md: only the text between the markers changes; no markers is a hint", async () => {
    const dir = project({
      "dawn.json": manifest(),
      "AGENTS.md":
        "mine\n<!-- dawn:begin -->\nold\n<!-- dawn:end -->\nalso mine\n",
    });
    const result = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
    });
    expect(read(dir, "AGENTS.md")).toBe(
      "mine\n<!-- dawn:begin -->\nnew block\n<!-- dawn:end -->\nalso mine\n",
    );
    expect(result.notices).toContain("refreshed the dawn block in AGENTS.md");
    const own = project({
      "dawn.json": manifest(),
      "AGENTS.md": "my own notes\n",
    });
    const hinted = await syncProject(own, {
      context: context(),
      version: "0.39.0",
    });
    expect(read(own, "AGENTS.md")).toBe("my own notes\n");
    expect(hinted.hints[0]).toContain("no <!-- dawn:begin --> block");
  });

  test("dryRun reports without writing", async () => {
    const dir = project({ "dawn.json": manifest() });
    const result = await syncProject(dir, {
      context: context(),
      version: "0.39.0",
      dryRun: true,
    });
    expect(result.wrote).toContain(".dawn/sdk/v1.ts");
    expect(read(dir, "dawn.json")).toBe(manifest());
  });

  test("dawn check exits 3 when the project needs dawn migrate", async () => {
    const dir = project({
      "dawg.json": '{"format":"dawg.project/v1","sdk":1}',
    });
    const err: string[] = [];
    const code = await runCheckCommand(
      ["check"],
      dir,
      { write: () => 0 },
      { write: (t: string) => err.push(t) },
    );
    expect(code).toBe(3);
    expect(err.join("")).toContain("run dawn migrate");
  });
});
