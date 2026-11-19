// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { createScore } from "../../core/score.ts";
import { checkProject } from "./check.ts";
import {
  checkLinter,
  registerCheckLinter,
  registerTrackWarnings,
  trackWarningHooks,
  trackWarnings,
  unregisterTrackWarnings,
} from "./check-hooks.ts";

const score = createScore({
  tracks: [{ id: "bass", name: "bass", instrument: "bass" }],
  notes: [],
});

test("a registered hook's warnings reach the check, and leave with it", async () => {
  const name = "check-hooks.test";
  const line = "track bass: said by a hook";
  registerTrackWarnings(name, (tracks) =>
    tracks.map((track) => `track ${track.id}: said by a hook`),
  );
  try {
    // Registering the same name again replaces the hook: one line, not two.
    registerTrackWarnings(name, (tracks) =>
      tracks.map((track) => `track ${track.id}: said by a hook`),
    );
    expect(trackWarningHooks().filter((hook) => hook === name)).toEqual([name]);
    expect(trackWarnings(score.tracks).filter((w) => w === line)).toEqual([
      line,
    ]);
    const report = await checkProject("/nowhere", {
      typecheck: async () => ({ ok: true, diagnostics: [], ms: 0 }),
      evaluate: async () => ({ ok: true, score, ms: 0 }),
      lint: false,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toContain(line);
  } finally {
    expect(unregisterTrackWarnings(name)).toBe(true);
  }
  expect(trackWarnings(score.tracks)).not.toContain(line);
});

test("check has no lint rules of its own: it asks the registered linter", async () => {
  const before = checkLinter();
  const check = (lint?: boolean) =>
    checkProject("/nowhere", {
      typecheck: async () => ({ ok: true, diagnostics: [], ms: 0 }),
      evaluate: async () => ({ ok: true, score, ms: 0 }),
      ...(lint === undefined ? {} : { lint }),
    });
  try {
    registerCheckLinter(undefined);
    // Asked for by name, the absence is said; otherwise it is silent.
    expect((await check(true)).warnings).toContain(
      "lint skipped · this dawn has no lint rules",
    );
    expect((await check()).warnings.join("\n")).not.toContain("lint");
    const asked: string[] = [];
    let configured = false;
    registerCheckLinter({
      configured: async (project) => {
        asked.push(`configured ${project}`);
        return configured;
      },
      warnings: async (project, seen) => {
        asked.push(`warnings ${project} ${seen === score}`);
        return ["lint warning from the linter"];
      },
    });
    // Unasked, the linter runs only for a project with a lint config.
    expect((await check()).warnings).not.toContain(
      "lint warning from the linter",
    );
    configured = true;
    expect((await check()).warnings).toContain("lint warning from the linter");
    expect((await check(false)).warnings).not.toContain(
      "lint warning from the linter",
    );
    expect(asked).toEqual([
      "configured /nowhere",
      "configured /nowhere",
      "warnings /nowhere true",
    ]);
    // A linter that throws is one warning, and the check still passes.
    registerCheckLinter({
      configured: async () => true,
      warnings: async () => {
        throw new Error("bad config\nsecond line");
      },
    });
    const report = await check();
    expect(report.ok).toBe(true);
    expect(report.warnings).toContain("lint skipped · bad config");
  } finally {
    registerCheckLinter(before);
  }
});
