#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install
// SPDX-License-Identifier: MIT
/** Standalone extension authoring entry: no composition or product commands. */
import { runPaletteCommand } from "./cli.ts";

process.exitCode = await runPaletteCommand(
  ["palette", ...process.argv.slice(2)],
  process.cwd(),
  process.stdout,
  process.stderr,
);
