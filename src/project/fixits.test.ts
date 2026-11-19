// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkChange } from "../../core/sdk/changes.ts";
import { writeTree } from "../migrate/migrate-fixtures.ts";
import { applyFixIts, enrichDiagnostics, runSuggesters } from "./fixits.ts";

const CHANGES: SdkChange[] = [
  {
    sdk: "1.44.0",
    dawn: "0.41.0",
    removed: [
      {
        symbol: "TrackInput.volume",
        replacement: "gain",
        migration: "0007-volume-to-gain",
      },
      { symbol: "harpChord", migration: "0007-volume-to-gain" },
    ],
  },
];

describe("fix-its", () => {
  test("DAWN1001 on renamed fields and removed exports; others untouched", () => {
    const [field, gone, other] = enrichDiagnostics(
      [
        {
          file: "tracks/bass/track.ts",
          line: 3,
          col: 3,
          message:
            "Object literal may only specify known properties, and 'volume' does not exist in type 'TrackInput'. (TS2353)",
        },
        {
          file: "song.ts",
          line: 1,
          col: 10,
          message: `Module '"dawn"' has no exported member 'harpChord'. (TS2305)`,
        },
        {
          file: "song.ts",
          line: 2,
          col: 1,
          message: "Cannot find name 'x'. (TS2304)",
        },
      ],
      CHANGES,
    );
    expect(field).toMatchObject({
      code: "DAWN1001",
      hint: "volume was renamed to gain (SDK 1.44.0)",
      fix: { from: "volume", to: "gain", safe: true },
    });
    expect(field!.message).toContain("fix: dawn check --fix");
    expect(gone).toMatchObject({
      code: "DAWN1001",
      hint: "harpChord was removed in SDK 1.44.0",
    });
    expect(gone!.message).toContain("fix: dawn migrate --apply");
    expect(other).toEqual({
      file: "song.ts",
      line: 2,
      col: 1,
      message: "Cannot find name 'x'. (TS2304)",
    });
  });

  test("--fix renames the token at the location only when it is the old name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dawn-fix-"));
    try {
      writeTree(dir, {
        "t.ts":
          'const a = { volume: 1 };\nconst b = { "volume": 2 };\n// volume\n',
      });
      const wrote = await applyFixIts(dir, [
        {
          file: "t.ts",
          line: 1,
          col: 13,
          from: "volume",
          to: "gain",
          safe: true,
        },
        {
          file: "t.ts",
          line: 2,
          col: 13,
          from: "volume",
          to: "gain",
          safe: true,
        },
        {
          file: "t.ts",
          line: 3,
          col: 4,
          from: "volume",
          to: "gain",
          safe: true,
        },
        {
          file: "../escape.ts",
          line: 1,
          col: 1,
          from: "a",
          to: "b",
          safe: true,
        },
      ]);
      expect(wrote).toEqual(["t.ts"]);
      expect(readFileSync(join(dir, "t.ts"), "utf8")).toBe(
        'const a = { gain: 1 };\nconst b = { "gain": 2 };\n// volume\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("suggesters run and a failing one never fails the check", () => {
    expect(
      runSuggesters({}, [
        {
          id: "DAWN3002",
          sdk: "1.41.0",
          run: () => ["tracks/pad: 32 stabs · fx.gate"],
        },
        {
          id: "DAWN3999",
          sdk: "1.41.0",
          run: () => {
            throw new Error("x");
          },
        },
      ]),
    ).toEqual(["hint DAWN3002 tracks/pad: 32 stabs · fx.gate (SDK 1.41.0)"]);
  });
});
