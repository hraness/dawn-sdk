// SPDX-License-Identifier: MIT
/**
 * What `dawn lint` adds to `dawn check`: its findings as warnings, by
 * default only for a project with a `lint.json`. Importing this module
 * registers it (src/project/check-hooks.ts); the `dawn` command imports it
 * before it checks a project. The rules load only when a check asks.
 */

import { registerCheckLinter } from "../project/check-hooks.ts";
import { hasLintConfig } from "./load.ts";

registerCheckLinter({
  configured: hasLintConfig,
  async warnings(project, score) {
    const { lintTargetFromScore } = await import("./load.ts");
    const { lintTarget } = await import("./cli.ts");
    const { formatFindings } = await import("../../core/lint/index.ts");
    const report = lintTarget(await lintTargetFromScore(project, score));
    const shown = report.findings.filter((f) => f.severity !== "info");
    return formatFindings(shown, 20).map((line) => `lint ${line}`);
  },
});
