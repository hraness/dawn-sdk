// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HELD_MIGRATIONS, MIGRATIONS } from "./index.ts";
import { MIGRATION_ID } from "./types.ts";
import { isPlainVersion } from "../update/semver.ts";

describe("MIGRATIONS", () => {
  test("a held step has the next ids and is in force nowhere", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    HELD_MIGRATIONS.forEach((m, index) => {
      expect(m.id).toMatch(MIGRATION_ID);
      expect(ids).not.toContain(m.id);
      expect(Number(m.id.slice(0, 4))).toBe(ids.length + index + 1);
    });
  });
  test("ids are well formed, unique and in order", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    for (const id of ids) expect(id).toMatch(MIGRATION_ID);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    ids.forEach((id, index) => expect(Number(id.slice(0, 4))).toBe(index + 1));
  });
  test("every migration has a test and before/after fixtures", () => {
    for (const m of [...MIGRATIONS, ...HELD_MIGRATIONS]) {
      expect(isPlainVersion(m.introducedIn)).toBe(true);
      expect(existsSync(join(import.meta.dir, `${m.id}.test.ts`))).toBe(true);
      expect(
        existsSync(join(import.meta.dir, "fixtures", m.id, "before")),
      ).toBe(true);
      expect(existsSync(join(import.meta.dir, "fixtures", m.id, "after"))).toBe(
        true,
      );
    }
  });
});
